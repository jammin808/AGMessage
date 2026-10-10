/**
 * AGMessage — inter-team messaging for AGMs and board meetings: directors on stage, research backstage.
 *
 * One Node.js process:
 *   - Serves the web client (join page, chat app, admin) from /public with a strict CSP
 *   - Real-time chat over Socket.io. Every change is an operation with a per-room sequence number:
 *     appended to an on-disk log, broadcast with its seq, and replayable — a client that drops off
 *     for a moment resumes with just what it missed (see lib/store.js)
 *   - Uploads: allow-listed types, checked by content, only from people in a meeting, served so a
 *     file can never run script in the app
 *   - Identities are issued and signed by the server; roles can be locked to invite links
 *   - Claude drafts (research replies, minutes, action-prompt options) — always a draft for a person
 *   - A node of the show network: live Stagewatch timer for the board, "send to stage" to the
 *     confidence monitor, discovery of Stagewatch and Patterns (see lib/nodes.js)
 *
 * Roles: "board" (on stage), "research" (backstage), "observer" (read-only).
 * Listens on 0.0.0.0 for the venue network; remote access via the built-in Cloudflare tunnel.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { customAlphabet } = require('nanoid');

const { RoomStore } = require('./lib/store');
const guard = require('./lib/guard');
const ai = require('./lib/ai');
const nodes = require('./lib/nodes');

const VERSION = '0.2.0';
const PORT = parseInt(process.env.PORT || '3023', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.AGM_DATA_DIR || path.join(__dirname, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(ROOMS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SECRET = guard.loadSecret(DATA_DIR);

// One-time admin token printed at boot; login only from the host laptop (never through the tunnel).
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || crypto.randomBytes(8).toString('hex')).toLowerCase();
const adminSessions = new Set();

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const makeMessageId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
const ROLES = ['board', 'research', 'observer'];

// ---------------------------------------------------------------- settings (AI key, Stagewatch link)
function loadSettings() {
  try { const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
let settings = loadSettings();
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(SETTINGS_PATH + '.tmp', SETTINGS_PATH);
  } catch (e) { console.error('  settings save failed:', e.message); }
}
const aiKey = () => process.env.ANTHROPIC_API_KEY || settings.aiKey || '';

// ---------------------------------------------------------------- rooms
const store = new RoomStore(ROOMS_DIR);
const restored = store.loadAll((room) => {
  for (const m of room.messages) if (m.from && m.from.role === 'director') m.from.role = 'board';   // legacy role name
});
for (const room of store.rooms.values()) {
  store.commit(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text: '— Session restored (' + room.messages.length + ' messages preserved) —', at: Date.now() } });
}
if (restored) console.log('  Restored', restored, 'room(s) from', ROOMS_DIR);

/** Commit an op and broadcast it under its legacy event name, carrying its seq. */
function apply(room, op) {
  store.commit(room, op);
  const s = op.s;
  switch (op.o) {
    case 'add':
      op.m.seq = s;
      io.to(room.code).emit(op.m.type === 'system' ? 'system' : 'message', op.m);
      break;
    case 'upd':
      if ('responses' in op.f) io.to(room.code).emit('actionUpdate', { messageId: op.id, responses: op.f.responses, seq: s });
      if ('pinned' in op.f) io.to(room.code).emit('pinUpdate', { messageId: op.id, pinned: op.f.pinned, seq: s });
      if ('reactions' in op.f) io.to(room.code).emit('messageReact', { messageId: op.id, reactions: op.f.reactions, seq: s });
      break;
    case 'del': io.to(room.code).emit('messageDeleted', { messageId: op.id, seq: s }); break;
    case 'reset': io.to(room.code).emit('roomReset', { roomCode: room.code, seq: s }); break;
  }
  return op;
}
function systemMessage(room, text) {
  return apply(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text, at: Date.now() } }).m;
}

function roomUserSummary(room) {
  return Array.from(room.users.entries()).map(([sid, u]) => ({
    socketId: sid, uid: u.uid, name: u.name, role: u.role,
    linkedRooms: u.linkedRooms instanceof Set ? Array.from(u.linkedRooms) : [],
  }));
}

// Rooms each person (by server identity) is in — forwarding only between rooms they're actually in.
const userRooms = new Map();
const trackJoin = (uid, code) => { if (!userRooms.has(uid)) userRooms.set(uid, new Set()); userRooms.get(uid).add(code); };
const trackLeave = (uid, code) => { const s = userRooms.get(uid); if (s) { s.delete(code); if (!s.size) userRooms.delete(uid); } };

// Venue Wi-Fi drops people for a second: announce "left" only if they don't come straight back.
const pendingLeaves = new Map();   // room|uid -> timer
const LEAVE_GRACE_MS = 8000;

// Upload tokens, issued at join: an upload must come from someone in a meeting.
const uploadTokens = new Map();    // token -> {room, uid, bucket}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.set('trust proxy', false);
app.use(guard.pageHeaders);
app.use(express.json({ limit: '256kb' }));
app.get('/admin', (_req, res) => res.redirect('/admin.html'));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m' }));

// Uploads: only allow-listed names, served so they can't run script (sandbox CSP, nosniff, attachment for office files).
app.get('/uploads/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!guard.validUploadUrl('/uploads/' + name)) return res.status(404).end();
  const t = guard.UPLOAD_TYPES[guard.extOf(name)];
  if (!t) return res.status(404).end();
  res.setHeader('Content-Type', t.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', (t.inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/^[0-9]+-[a-z0-9]+-/, '') + '"');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(UPLOAD_DIR, name), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ----- admin auth
function readCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
const isValidAdminCookie = (req) => { const sid = readCookie(req, 'agm_admin'); return !!(sid && adminSessions.has(sid)); };
const adminLockout = new guard.Lockout(5, 60_000);

app.post('/api/admin/login', (req, res) => {
  if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'Admin login is only allowed on the host laptop.' });
  if (adminLockout.locked('host')) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const t = String((req.body && req.body.token) || '').toLowerCase().trim();
  if (!t || !guard.safeEqual(t, ADMIN_TOKEN)) { adminLockout.fail('host'); return res.status(401).json({ ok: false, error: 'Invalid admin token.' }); }
  adminLockout.ok('host');
  const sid = crypto.randomBytes(24).toString('hex');
  adminSessions.add(sid);
  res.setHeader('Set-Cookie', 'agm_admin=' + sid + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const sid = readCookie(req, 'agm_admin');
  if (sid) adminSessions.delete(sid);
  res.setHeader('Set-Cookie', 'agm_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ ok: isValidAdminCookie(req), local: guard.isHostMachine(req) }));

app.get('/api/admin/transcript/:code', (req, res) => {
  if (!isValidAdminCookie(req)) return res.status(403).send('Forbidden');
  const room = store.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).send('Room not found');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', 'inline; filename="transcript-' + room.code + '.html"');
  res.send(renderTranscriptHtml(room));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, rooms: store.rooms.size, uptime: Math.round(process.uptime()), clients: io.engine.clientsCount, stage: stageLink.status });
});

// Room lookups: rate limited and locked out after guessing.
const lookupLock = new guard.Lockout(12, 60_000);
const lookupBuckets = new Map();
function lookupAllowed(ip) {
  if (lookupLock.locked(ip)) return false;
  let b = lookupBuckets.get(ip);
  if (!b) { b = new guard.Bucket(2, 10); lookupBuckets.set(ip, b); if (lookupBuckets.size > 5000) lookupBuckets.clear(); }
  return b.take();
}

app.post('/api/rooms', (req, res) => {
  if (!isValidAdminCookie(req)) return res.status(403).json({ ok: false, error: 'Only admin can create rooms.' });
  const room = newRoom(req.body && typeof req.body.name === 'string' ? req.body.name : '');
  res.json({ code: room.code, name: room.name });
});
app.get('/api/rooms/:code', (req, res) => {
  const ip = guard.clientIp(req);
  if (!lookupAllowed(ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  const code = String(req.params.code || '').toUpperCase();
  const room = RoomStore.validCode(code) ? store.get(code) : null;
  if (!room) lookupLock.fail(ip);
  res.json({ code, exists: !!room, name: room ? room.name || '' : '', locked: !!(room && room.settings.lockRoles) });
});

function newRoom(name) {
  let code;
  do { code = makeRoomCode(); } while (store.has(code));
  return store.create(code, String(name || '').trim().slice(0, 80));
}

// ----- uploads (only from people in a meeting; content must match the name)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60) || 'file';
      cb(null, `${Date.now()}-${makeMessageId()}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (req, file, cb) => cb(null, !!guard.UPLOAD_TYPES[guard.extOf(file.originalname)]),
});

app.post('/api/upload', (req, res, next) => {
  const t = uploadTokens.get(String(req.headers['x-agm-upload'] || ''));
  if (!t) return res.status(403).json({ error: 'Join a meeting to share files.' });
  if (!t.bucket.take()) return res.status(429).json({ error: 'Slow down — one file at a time.' });
  req.agmUploader = t;
  next();
}, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 25 MB.' : 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'That file type isn\'t supported. PDF, images, Word, Excel, PowerPoint, CSV and text work.' });
    let head = Buffer.alloc(0);
    try {
      const fd = fs.openSync(req.file.path, 'r');
      head = Buffer.alloc(4096);
      const n = fs.readSync(fd, head, 0, 4096, 0);
      fs.closeSync(fd);
      head = head.subarray(0, n);
    } catch { /* checked below */ }
    const type = guard.uploadType(req.file.originalname, head);
    if (!type) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(400).json({ error: 'That file\'s contents don\'t match its type, so it wasn\'t shared.' });
    }
    res.json({ url: `/uploads/${req.file.filename}`, filename: String(req.file.originalname).slice(0, 120), mime: type.mime.split(';')[0], size: req.file.size });
  });
});

// ---------------------------------------------------------------- Socket.io
const server = http.createServer(app);
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024,
  pingInterval: 10_000,   // notice a dead phone in seconds, not a minute
  pingTimeout: 8_000,
  perMessageDeflate: { threshold: 2048 },
});

// Connection rate per address (tunnels included).
const connBuckets = new Map();
io.use((socket, next) => {
  const ip = guard.clientIp({ socket: socket.conn, headers: socket.handshake.headers, conn: socket.conn });
  let b = connBuckets.get(ip);
  if (!b) { b = new guard.Bucket(3, 30); connBuckets.set(ip, b); if (connBuckets.size > 5000) connBuckets.clear(); }
  socket.data.ip = ip;
  return b.take() ? next() : next(new Error('Too many connections — wait a moment.'));
});

const joinLock = new guard.Lockout(10, 60_000);
let aiRunning = 0;
const AI_MAX_CONCURRENT = 3;

io.on('connection', (socket) => {
  let room = null;
  let me = null;   // {uid, name, role}
  const cookieHeader = socket.handshake.headers.cookie || '';
  const cMatch = cookieHeader.match(/(?:^|;\s*)agm_admin=([^;]+)/);
  socket.data.isAdmin = !!(cMatch && adminSessions.has(decodeURIComponent(cMatch[1])));
  const writes = new guard.Bucket(5, 15);      // messages, reactions, pins…
  const chatter = new guard.Bucket(10, 20);    // typing, seen, ui sync
  const aiBucket = new guard.Bucket(0.2, 4);   // one AI request per 5 s, bursts of 4
  let uploadToken = null;
  const ok = (ack) => (typeof ack === 'function' ? ack : () => {});
  const limited = (ack) => { ok(ack)({ ok: false, error: 'Slow down a little.' }); };

  socket.on('join', (args, ack) => {
    ack = ok(ack);
    const { roomCode, name, role, adminView, uid, since, invite } = args || {};
    const ip = socket.data.ip;
    if (joinLock.locked(ip)) return ack({ ok: false, error: 'Too many attempts — wait a minute.' });
    const code = String(roomCode || '').toUpperCase().trim();
    const cleanName = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    let cleanRole = role === 'director' ? 'board' : role;
    cleanRole = ROLES.includes(cleanRole) ? cleanRole : 'observer';
    const isAdminView = !!adminView && socket.data.isAdmin;
    if (!code || !cleanName) return ack({ ok: false, error: 'Missing room code or name' });
    const r = RoomStore.validCode(code) ? store.get(code) : null;
    if (!r) { joinLock.fail(ip); return ack({ ok: false, error: 'Room not found' }); }

    // Identity: only the server issues them; anything else gets a fresh one.
    let id = guard.checkIdentity(SECRET, uid);
    let identity = null;
    if (!id) { identity = guard.newIdentity(SECRET); id = guard.checkIdentity(SECRET, identity); }

    // Locked rooms: board and research seats need the admin's invite link.
    let note = '';
    if (r.settings.lockRoles && cleanRole !== 'observer' && !socket.data.isAdmin && !guard.checkInvite(SECRET, code, cleanRole, invite)) {
      cleanRole = 'observer';
      note = 'This meeting needs an invite link for that role — you joined as an observer.';
    }

    if (!isAdminView) {
      for (const u of r.users.values()) {
        if (u.name.toLowerCase() === cleanName.toLowerCase() && u.uid !== id) {
          return ack({ ok: false, error: 'That name is already in use in this meeting. Please pick a different display name.' });
        }
      }
    }
    joinLock.ok(ip);

    if (room && room !== r) leaveRoom(true);
    me = { uid: id, name: cleanName, role: cleanRole, joinedAt: Date.now() };
    room = r;
    socket.data.adminView = isAdminView;
    socket.data.userName = cleanName;
    socket.data.uid = id;
    socket.data.userRoom = code;
    socket.join(code);

    let returning = false;
    if (!isAdminView) {
      const k = code + '|' + id;
      if (pendingLeaves.has(k)) { clearTimeout(pendingLeaves.get(k)); pendingLeaves.delete(k); returning = true; }
      for (const [sid, u] of r.users) if (u.uid === id && sid !== socket.id) r.users.delete(sid);   // a stale socket of the same person
      r.users.set(socket.id, me);
      trackJoin(id, code);
    }

    if (uploadToken) uploadTokens.delete(uploadToken);
    uploadToken = crypto.randomBytes(18).toString('base64url');
    uploadTokens.set(uploadToken, { room: code, uid: id, bucket: new guard.Bucket(0.5, 4) });

    // Resume: just what they missed, when we still have it; otherwise the whole history.
    const ops = Number.isInteger(since) ? store.opsSince(r, since) : null;
    ack({
      ok: true, roomCode: code, roomName: r.name || '', role: cleanRole, name: cleanName, adminView: isAdminView,
      identity, uid: id, note, uploadToken, seq: r.seq,
      ...(ops ? { ops } : { history: r.messages }),
      users: roomUserSummary(r),
      ai: !!aiKey(), stage: stageLink.view ? { ...stageLink.view, status: stageLink.status } : null,
      canSendToStage: !!(stageLink.base && stageLink.key),
      seen: seenFor(r),
    });

    if (!isAdminView) {
      if (!returning) systemMessage(r, `${cleanName} joined as ${cleanRole}`);
      io.to(code).emit('users', roomUserSummary(r));
    } else {
      io.in(code).fetchSockets().then((peers) => {
        for (const p of peers) if (p.id !== socket.id && p.data.userName === cleanName && !p.data.adminView) p.emit('userState:request');
      }).catch(() => {});
    }
  });

  const need = (ack) => {
    if (!room || !me) { ok(ack)({ ok: false, error: 'Not joined' }); return false; }
    if (!store.has(room.code)) { ok(ack)({ ok: false, error: 'Room gone' }); return false; }
    return true;
  };

  socket.on('message', (payload, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    if (me.role === 'observer' && !socket.data.isAdmin) return ok(ack)({ ok: false, error: 'Observers can read but not post.' });
    const msg = buildMessage(me, payload);
    if (!msg) return ok(ack)({ ok: false, error: 'Invalid message' });
    if (payload.replyTo && typeof payload.replyTo === 'string') {
      const parent = room.byId.get(payload.replyTo);
      if (parent) {
        msg.replyTo = {
          id: parent.id, name: (parent.from && parent.from.name) || 'system',
          snippet: parent.text ? parent.text.slice(0, 120) : parent.filename ? '📄 ' + parent.filename : '',
        };
      }
    }
    apply(room, { o: 'add', m: msg });
    ok(ack)({ ok: true, id: msg.id, seq: msg.seq });
  });

  socket.on('actionResponse', ({ messageId, optionIndex, note } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    const msg = room.byId.get(messageId);
    if (!msg || msg.type !== 'action') return ok(ack)({ ok: false, error: 'Action prompt not found' });
    const responses = (msg.responses || []).filter((r) => (r.uid ? r.uid !== me.uid : r.name !== me.name));
    const idx = Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < (msg.options || []).length ? optionIndex : -1;
    responses.push({ uid: me.uid, name: me.name, role: me.role, optionIndex: idx, note: typeof note === 'string' ? note.slice(0, 200) : '', at: Date.now() });
    apply(room, { o: 'upd', id: msg.id, f: { responses } });
    ok(ack)({ ok: true });
  });

  socket.on('pin', ({ messageId, pinned } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    if (!room.byId.has(messageId)) return ok(ack)({ ok: false, error: 'Message not found' });
    apply(room, { o: 'upd', id: messageId, f: { pinned: !!pinned } });
    ok(ack)({ ok: true });
  });

  socket.on('delete', ({ messageId } = {}, ack) => {
    if (!need(ack)) return;
    const msg = room.byId.get(messageId);
    if (!msg) return ok(ack)({ ok: false, error: 'Message not found' });
    if (msg.type === 'system') return ok(ack)({ ok: false, error: 'Cannot delete system message' });
    if (!msg.from || !msg.from.uid || msg.from.uid !== me.uid) return ok(ack)({ ok: false, error: 'Only the author can delete this message' });
    apply(room, { o: 'del', id: messageId });
    ok(ack)({ ok: true });
  });

  socket.on('react', ({ messageId, emoji } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    const msg = room.byId.get(messageId);
    if (!msg) return ok(ack)({ ok: false, error: 'Message not found' });
    if (typeof emoji !== 'string' || !emoji.length || emoji.length > 8 || /[<>&"'\s]/.test(emoji)) return ok(ack)({ ok: false, error: 'Bad emoji' });
    const reactions = (msg.reactions || []).slice();
    const i = reactions.findIndex((r) => r.uid === me.uid && r.emoji === emoji);
    if (i >= 0) reactions.splice(i, 1);
    else { if (reactions.length >= 200) return ok(ack)({ ok: false, error: 'Too many reactions' }); reactions.push({ uid: me.uid, name: me.name, emoji, at: Date.now() }); }
    apply(room, { o: 'upd', id: messageId, f: { reactions } });
    ok(ack)({ ok: true });
  });

  socket.on('typing', ({ isTyping } = {}) => {
    if (!room || !me || !chatter.take()) return;
    socket.to(room.code).emit('typing', { name: me.name, role: me.role, isTyping: !!isTyping });
  });

  // Seen receipts: the board knows research saw it, research knows the board read the answer.
  socket.on('seen', ({ seq } = {}) => {
    if (!room || !me || socket.data.adminView || !chatter.take()) return;
    if (!Number.isInteger(seq) || seq < 0 || seq > room.seq) return;
    room.seen = room.seen || new Map();
    const prev = room.seen.get(me.uid);
    if (prev && prev.seq >= seq) return;
    room.seen.set(me.uid, { uid: me.uid, name: me.name, role: me.role, seq });
    io.to(room.code).emit('seen', { uid: me.uid, name: me.name, role: me.role, seq });
  });

  socket.on('myRooms', (ack) => {
    if (!me) return ok(ack)({ ok: false, error: 'Not joined' });
    const linked = me.linkedRooms instanceof Set ? Array.from(me.linkedRooms) : [];
    const others = Array.from(new Set([...(userRooms.get(me.uid) || []), ...linked])).filter((c) => c !== room.code && store.has(c));
    ok(ack)({ ok: true, rooms: others.map((c) => ({ code: c, name: store.get(c).name || '' })) });
  });

  socket.on('forward', ({ messageId, targetRoom } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    const dst = store.get(String(targetRoom || '').toUpperCase());
    if (!dst) return ok(ack)({ ok: false, error: 'Target room not found' });
    const mine = userRooms.get(me.uid) || new Set();
    const linked = me.linkedRooms instanceof Set ? me.linkedRooms : new Set();
    if (!mine.has(dst.code) && !linked.has(dst.code)) return ok(ack)({ ok: false, error: 'You must be in the target room too (or ask admin to link you)' });
    const src = room.byId.get(messageId);
    if (!src || src.type === 'system') return ok(ack)({ ok: false, error: 'Cannot forward this message' });
    const fwd = {
      id: makeMessageId(), type: src.type, at: Date.now(), from: { uid: me.uid, name: me.name, role: me.role },
      pinned: false, priority: !!src.priority,
      forwardedFrom: { roomCode: room.code, roomName: room.name || '', originalAuthor: (src.from && src.from.name) || 'unknown', originalAt: src.at },
    };
    if (src.type === 'text') fwd.text = src.text;
    else if (src.type === 'file') Object.assign(fwd, { url: src.url, filename: src.filename, mime: src.mime, caption: src.caption || '' });
    else if (src.type === 'action') Object.assign(fwd, { text: src.text, options: src.options, responses: [] });
    apply(dst, { o: 'add', m: fwd });
    ok(ack)({ ok: true, id: fwd.id });
  });

  // UI sync between a person and the admin's support view of them (same name, one side admin) or their own devices.
  const syncPeer = (p) => p.id !== socket.id && (p.data.uid === me.uid || ((p.data.adminView || socket.data.adminView) && p.data.userName === me.name));
  socket.on('userState:requestPeers', async () => {
    if (!room || !me || !chatter.take()) return;
    try { for (const p of await io.in(room.code).fetchSockets()) if (syncPeer(p)) p.emit('userState:request'); } catch { /* ignore */ }
  });
  socket.on('userState:push', async (payload) => {
    if (!room || !me || !chatter.take() || !payload || typeof payload !== 'object') return;
    if (JSON.stringify(payload).length > 4096) return;
    try { for (const p of await io.in(room.code).fetchSockets()) if (syncPeer(p)) p.emit('userState:push', payload); } catch { /* ignore */ }
  });

  // ----- AI (research team and admin): drafts only
  async function runAi(ack, fn) {
    ack = ok(ack);
    if (!aiKey()) return ack({ ok: false, error: 'AI is off — the admin can add an Anthropic API key in the dashboard.' });
    if (!aiBucket.take()) return ack({ ok: false, error: 'One AI request at a time — try again in a few seconds.' });
    if (aiRunning >= AI_MAX_CONCURRENT) return ack({ ok: false, error: 'The AI is busy with other requests — try again shortly.' });
    aiRunning++;
    const ctl = new AbortController();
    const onGone = () => ctl.abort();
    socket.once('disconnect', onGone);
    try { const r = await fn(ctl.signal); ack(r.error ? { ok: false, error: r.error } : { ok: true, ...r }); }
    catch (e) { ack({ ok: false, error: 'AI request failed.' }); }
    finally { aiRunning--; socket.off('disconnect', onGone); }
  }
  const canDraft = () => me && (me.role === 'research' || socket.data.isAdmin);

  socket.on('ai:draft', (args = {}, ack) => {
    if (!need(ack)) return;
    if (!canDraft()) return ok(ack)({ ok: false, error: 'Drafting is for the research team.' });
    const docText = typeof args.docText === 'string' ? args.docText.slice(0, 60_000) : '';
    runAi(ack, (signal) => ai.draftReply(aiKey(), {
      messages: room.messages,
      question: typeof args.question === 'string' ? args.question.slice(0, 2000) : '',
      instruction: typeof args.instruction === 'string' ? args.instruction.slice(0, 500) : '',
      docName: typeof args.docName === 'string' ? args.docName.slice(0, 120) : '', docText,
    }, signal));
  });

  socket.on('ai:options', (args = {}, ack) => {
    if (!need(ack)) return;
    if (!canDraft()) return ok(ack)({ ok: false, error: 'For the research team.' });
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 1000) : '';
    if (!prompt) return ok(ack)({ ok: false, error: 'Type the question first.' });
    runAi(ack, (signal) => ai.suggestOptions(aiKey(), { prompt, messages: room.messages }, signal));
  });

  // ----- Stagewatch: put an answer on the speaker's confidence monitor (research or admin)
  socket.on('stage:send', async (args = {}, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    if (!(me.role === 'research' || socket.data.isAdmin)) return ack({ ok: false, error: 'Sending to the stage is for the research team.' });
    if (!writes.take()) return limited(ack);
    let text = typeof args.text === 'string' ? args.text : '';
    if (!text && typeof args.messageId === 'string') { const m = room.byId.get(args.messageId); text = (m && m.text) || ''; }
    const r = await stageLink.sendToStage(text, { urgency: args.urgency, ack: args.ack !== false });
    if (r.ok) systemMessage(room, `${me.name} sent to the stage screen: “${text.replace(/\s+/g, ' ').slice(0, 120)}”`);
    ack(r);
  });

  // ----- ADMIN — only with a valid admin cookie
  const admin = (ack) => { if (!socket.data.isAdmin) { ok(ack)({ ok: false, error: 'Not admin' }); return false; } return true; };

  socket.on('admin:listRooms', (ack) => {
    if (!admin(ack)) return;
    ok(ack)({ ok: true, rooms: Array.from(store.rooms.values()).map((r) => ({ code: r.code, name: r.name || '', createdAt: r.createdAt, users: roomUserSummary(r), messageCount: r.messages.length, locked: !!r.settings.lockRoles })) });
  });
  socket.on('admin:watchRoom', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    if (socket.data.watching && socket.data.watching !== roomCode) socket.leave(socket.data.watching);
    socket.join(roomCode);
    socket.data.watching = roomCode;
    ok(ack)({ ok: true, code: roomCode, name: r.name || '', messages: r.messages, users: roomUserSummary(r), locked: !!r.settings.lockRoles });
  });
  socket.on('admin:createRoom', (arg, ack) => {
    if (typeof arg === 'function') { ack = arg; arg = {}; }
    if (!admin(ack)) return;
    const r = newRoom(arg && typeof arg.name === 'string' ? arg.name : '');
    ok(ack)({ ok: true, code: r.code, name: r.name });
  });
  socket.on('admin:resetRoom', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    apply(r, { o: 'reset' });
    systemMessage(r, '— Session reset by admin: messages and documents cleared —');
    ok(ack)({ ok: true });
  });
  socket.on('admin:deleteRoom', ({ roomCode, purgeFiles } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    const files = new Set(r.messages.filter((m) => m.type === 'file' && guard.validUploadUrl(m.url)).map((m) => m.url.slice(9)));
    io.to(r.code).emit('kicked', { reason: 'This meeting was closed by the admin.' });
    io.in(r.code).disconnectSockets(true);
    store.remove(r.code);
    let purged = 0;
    if (purgeFiles) {
      const stillUsed = new Set();
      for (const other of store.rooms.values()) for (const m of other.messages) if (m.type === 'file' && guard.validUploadUrl(m.url)) stillUsed.add(m.url.slice(9));
      for (const f of files) if (!stillUsed.has(f)) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); purged++; } catch { /* ignore */ } }
    }
    ok(ack)({ ok: true, purged });
  });
  socket.on('admin:deleteMessage', ({ roomCode, messageId } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r || !r.byId.has(messageId)) return ok(ack)({ ok: false, error: 'Message not found' });
    apply(r, { o: 'del', id: messageId });
    ok(ack)({ ok: true });
  });
  socket.on('admin:setRole', ({ roomCode, socketId, role } = {}, ack) => {
    if (!admin(ack)) return;
    if (!ROLES.includes(role)) return ok(ack)({ ok: false, error: 'Invalid role' });
    const r = store.get(roomCode);
    const target = r && r.users.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not in room' });
    const prev = target.role;
    target.role = role;
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('roleChanged', { role });
    io.to(r.code).emit('users', roomUserSummary(r));
    systemMessage(r, `${target.name} role changed from ${prev} to ${role} by admin`);
    ok(ack)({ ok: true });
  });
  socket.on('admin:lockRoles', ({ roomCode, on } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    store.commit(r, { o: 'meta', settings: { lockRoles: !!on } });
    ok(ack)({ ok: true, locked: !!on, invites: on ? invitesFor(r.code) : null });
  });
  socket.on('admin:invites', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    if (!store.has(roomCode)) return ok(ack)({ ok: false, error: 'Room not found' });
    ok(ack)({ ok: true, invites: invitesFor(roomCode) });
  });
  socket.on('admin:linkRoom', ({ socketId, targetRoom } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    const code = String(targetRoom || '').toUpperCase();
    if (!target || !store.has(code)) return ok(ack)({ ok: false, error: 'User or room not found' });
    const u = store.get(target.data.userRoom) && store.get(target.data.userRoom).users.get(socketId);
    if (!u) return ok(ack)({ ok: false, error: 'User not in room' });
    u.linkedRooms = u.linkedRooms || new Set();
    u.linkedRooms.add(code);
    target.emit('linkedRoomsChanged', { added: code });
    ok(ack)({ ok: true, linked: Array.from(u.linkedRooms) });
  });
  socket.on('admin:unlinkRoom', ({ socketId, targetRoom } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not connected' });
    const code = String(targetRoom || '').toUpperCase();
    const u = store.get(target.data.userRoom) && store.get(target.data.userRoom).users.get(socketId);
    if (!u || !u.linkedRooms) return ok(ack)({ ok: true });
    u.linkedRooms.delete(code);
    target.emit('linkedRoomsChanged', { removed: code });
    ok(ack)({ ok: true, linked: Array.from(u.linkedRooms) });
  });
  socket.on('admin:kick', ({ socketId } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not connected' });
    target.emit('kicked', { reason: 'Removed by admin' });
    target.disconnect(true);
    ok(ack)({ ok: true });
  });
  socket.on('admin:summary', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    runAi(ack, (signal) => ai.summarise(aiKey(), { messages: r.messages, roomName: r.name }, signal));
  });
  socket.on('admin:postSummary', ({ roomCode, text } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    const t = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!r || !t) return ok(ack)({ ok: false, error: 'Nothing to post' });
    const m = { id: makeMessageId(), at: Date.now(), type: 'text', text: t, pinned: true, priority: false, from: { uid: 'minutes', name: 'Minutes', role: 'observer', ai: true } };
    apply(r, { o: 'add', m });
    ok(ack)({ ok: true });
  });
  socket.on('admin:settings', (patch, ack) => {
    if (typeof patch === 'function') { ack = patch; patch = null; }
    if (!admin(ack)) return;
    if (patch && typeof patch === 'object') {
      if (typeof patch.aiKey === 'string') settings.aiKey = patch.aiKey.trim().slice(0, 200);
      if (typeof patch.stagewatchUrl === 'string') settings.stagewatchUrl = nodes.normaliseBase(patch.stagewatchUrl);
      if (typeof patch.stagewatchKey === 'string') settings.stagewatchKey = patch.stagewatchKey.trim().slice(0, 80);
      saveSettings();
      stageLink.configure(settings.stagewatchUrl, settings.stagewatchKey);
    }
    ok(ack)({
      ok: true,
      aiKeySet: !!aiKey(), aiFromEnv: !!process.env.ANTHROPIC_API_KEY, model: ai.MODEL,
      stagewatchUrl: settings.stagewatchUrl || '', stagewatchKeySet: !!settings.stagewatchKey,
      stage: stageLink.status, peers: discovery ? discovery.list() : [],
    });
  });

  // ----- Cloudflare tunnel control
  socket.on('admin:tunnelStart', (ack) => { if (admin(ack)) ok(ack)(startTunnel()); });
  socket.on('admin:tunnelStop', (ack) => { if (admin(ack)) { stopTunnel(); ok(ack)({ ok: true }); } });
  socket.on('admin:tunnelStatus', (ack) => { if (admin(ack)) ok(ack)({ ok: true, running: !!tunnelProc, url: tunnelUrl, error: tunnelError }); });

  function leaveRoom(now) {
    if (!room || !me || socket.data.adminView) return;
    const r = room, u = me;
    r.users.delete(socket.id);
    io.to(r.code).emit('users', roomUserSummary(r));
    const still = Array.from(r.users.values()).some((x) => x.uid === u.uid);
    if (still) return;
    trackLeave(u.uid, r.code);
    const k = r.code + '|' + u.uid;
    const announce = () => { pendingLeaves.delete(k); if (store.has(r.code) && !Array.from(r.users.values()).some((x) => x.uid === u.uid)) systemMessage(r, `${u.name} left`); };
    if (now) announce();
    else { if (pendingLeaves.has(k)) clearTimeout(pendingLeaves.get(k)); pendingLeaves.set(k, setTimeout(announce, LEAVE_GRACE_MS)); }
  }

  socket.on('disconnect', () => {
    if (uploadToken) uploadTokens.delete(uploadToken);
    leaveRoom(false);
  });
});

function seenFor(room) { return room.seen ? Array.from(room.seen.values()) : []; }

function invitesFor(code) {
  const out = {};
  for (const role of ['board', 'research']) out[role] = `/?code=${code}&role=${role}&invite=${guard.makeInvite(SECRET, code, role)}`;
  return out;
}

function buildMessage(user, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const base = { id: makeMessageId(), at: Date.now(), from: { uid: user.uid, name: user.name, role: user.role }, pinned: false, priority: !!payload.priority };
  if (payload.type === 'text') {
    const text = String(payload.text || '').trim();
    return text ? { ...base, type: 'text', text: text.slice(0, 4000), ...(payload.aiDraft ? { aiDraft: true } : {}) } : null;
  }
  if (payload.type === 'file') {
    if (!guard.validUploadUrl(payload.url)) return null;
    const t = guard.UPLOAD_TYPES[guard.extOf(payload.url)];
    if (!t || !fs.existsSync(path.join(UPLOAD_DIR, payload.url.slice(9)))) return null;
    return {
      ...base, type: 'file', url: payload.url,
      filename: String(payload.filename || 'file').replace(/[\u0000-\u001f]/g, '').slice(0, 120),
      mime: t.mime.split(';')[0],
      caption: payload.caption ? String(payload.caption).slice(0, 500) : '',
    };
  }
  if (payload.type === 'action') {
    const text = String(payload.text || '').trim();
    let options = Array.isArray(payload.options) ? payload.options.map((o) => String(o || '').trim().slice(0, 40)).filter(Boolean).slice(0, 6) : [];
    if (!options.length) options = ['Yes', 'No'];
    return text ? { ...base, type: 'action', text: text.slice(0, 1000), options, responses: [] } : null;
  }
  return null;
}

function renderTranscriptHtml(room) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ts) => new Date(ts).toLocaleString();
  const rows = [];
  for (const m of room.messages) {
    if (m.type === 'system') { rows.push('<div class="sys">— ' + esc(m.text) + ' (' + esc(fmt(m.at)) + ')</div>'); continue; }
    const who = m.from ? esc(m.from.name) + ' <span class="role">' + esc(m.from.role) + '</span>' : '—';
    let content = '';
    if (m.type === 'text') content = '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>';
    else if (m.type === 'file') content = '<p>📄 <em>' + esc(m.filename) + '</em>' + (m.caption ? ' — ' + esc(m.caption) : '') + '</p>';
    else if (m.type === 'action') {
      content = '<p><strong>Action prompt:</strong> ' + esc(m.text) + '</p>';
      if (Array.isArray(m.options) && m.options.length) content += '<ul>' + m.options.map((o) => '<li>' + esc(o) + '</li>').join('') + '</ul>';
      if (Array.isArray(m.responses) && m.responses.length) {
        content += '<p class="responses"><strong>Responses:</strong> ' + m.responses.map((r) => esc(r.name) + ' → ' +
          (r.optionIndex >= 0 && m.options && m.options[r.optionIndex] !== undefined ? esc(m.options[r.optionIndex]) : '"' + esc(r.note || '') + '"')).join('; ') + '</p>';
      }
    }
    let extras = '';
    if (m.replyTo) extras += '<div class="rt">↩ replying to ' + esc(m.replyTo.name) + ': <em>' + esc(m.replyTo.snippet) + '</em></div>';
    if (Array.isArray(m.reactions) && m.reactions.length) {
      const counts = {};
      for (const r of m.reactions) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      extras += '<div class="rx">' + Object.entries(counts).map(([e, n]) => esc(e) + ' ' + n).join(' &nbsp; ') + '</div>';
    }
    if (m.priority) extras += '<span class="prio">🔥 HIGH</span>';
    if (m.pinned) extras += '<span class="pin">📌 pinned</span>';
    if (m.aiDraft) extras += '<span class="pin">✨ drafted with AI, sent by a person</span>';
    if (m.forwardedFrom) extras += '<div class="fwd">↗ Forwarded from ' + (m.forwardedFrom.roomName ? esc(m.forwardedFrom.roomName) + ' (' + esc(m.forwardedFrom.roomCode) + ')' : esc(m.forwardedFrom.roomCode)) + '</div>';
    const cls = ['msg', 'type-' + m.type, m.priority ? 'priority' : ''].filter(Boolean).join(' ');
    rows.push('<article class="' + cls + '"><header><strong>' + who + '</strong><time>' + esc(fmt(m.at)) + '</time></header>' + extras + '<div class="body">' + content + '</div></article>');
  }
  const title = room.name ? room.name + ' — Transcript' : 'AGMessage Transcript';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
    'body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#15202b}' +
    'h1{margin:.2rem 0}.meta{color:#6b7280;margin:.25rem 0 1.6rem}' +
    '.msg{border:1px solid #e2e6ec;border-radius:8px;padding:.55rem .8rem;margin:.4rem 0;background:#fff;break-inside:avoid}' +
    '.msg.priority{border-color:#dc2626;background:#fff5f5}.msg.type-action{border-color:#fbcf8a;background:#fffaf0}' +
    '.msg header{display:flex;gap:.6rem;align-items:baseline;font-size:.85rem;color:#6b7280;margin-bottom:.15rem}' +
    '.msg header time{margin-left:auto;font-variant-numeric:tabular-nums}' +
    '.msg .role{font-size:.7rem;padding:.05rem .35rem;background:#eef2fb;color:#1c3f9e;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}' +
    '.msg .body p{margin:.2rem 0}.msg .body em{font-style:italic;color:#374151}.msg ul{margin:.2rem 0 .2rem 1.2rem}' +
    '.responses{font-size:.85rem;color:#065f46}.rt{font-size:.85rem;font-style:italic;color:#6b7280;border-left:3px solid #2b57d1;padding-left:.5rem;margin-bottom:.25rem}' +
    '.rx{font-size:.9rem;color:#374151;margin-top:.15rem}.prio{display:inline-block;background:#dc2626;color:#fff;padding:0 .35rem;border-radius:999px;font-size:.7rem;font-weight:700;margin-right:.3rem}' +
    '.pin{font-size:.8rem;color:#7a4d00;margin-right:.3rem}.fwd{font-size:.85rem;color:#6b7280;font-style:italic}' +
    '.sys{color:#6b7280;font-style:italic;text-align:center;margin:.25rem 0;font-size:.85rem}@media print{body{max-width:100%}.msg{break-inside:avoid;border-color:#aaa}}' +
    '</style></head><body><h1>' + esc(room.name || 'AGMessage Session') + '</h1>' +
    '<p class="meta">Code <strong>' + esc(room.code) + '</strong> · Started ' + esc(fmt(room.createdAt)) + ' · ' + room.messages.length + ' entries · Generated ' + esc(fmt(Date.now())) + '</p>' +
    rows.join('\n') + '<p class="meta" style="margin-top:2rem">— end of transcript —</p></body></html>';
}

// ---------------------------------------------------------------- show network
const stageLink = new nodes.StagewatchLink({
  onState: (view, status) => io.emit('stage', view ? { ...view, status } : { status }),
});
let discovery = null;
if (process.env.AGM_NODES !== '0') {
  discovery = new nodes.Discovery({ port: PORT, name: 'AGMessage', onChange: () => {
    for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.emit('nodes', discovery.list());
  } });
  try { discovery.start(); } catch (e) { console.warn('  [nodes] discovery off:', e.message); }
}
stageLink.configure(settings.stagewatchUrl || '', settings.stagewatchKey || '');

// ---------------------------------------------------------------- Cloudflare tunnel (admin-only)
let tunnelProc = null, tunnelUrl = null, tunnelError = null, cfLogfile = null, cfLogPoll = null;
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function broadcastTunnelStatus() {
  const payload = { running: !!tunnelProc, url: tunnelUrl, error: tunnelError };
  for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.emit('tunnel:status', payload);
}
function resolveCloudflaredBin() {
  const fname = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundled = path.join(__dirname, '..', 'bin', fname);
  try { if (fs.existsSync(bundled)) return bundled; } catch { /* ignore */ }
  return 'cloudflared';
}
function startTunnel() {
  if (tunnelProc) return { ok: true, running: true, url: tunnelUrl };
  tunnelError = null; tunnelUrl = null;
  let proc;
  try {
    cfLogfile = path.join(os.tmpdir(), 'agm-cloudflared-' + process.pid + '-' + Date.now() + '.log');
    proc = spawn(resolveCloudflaredBin(), ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--logfile', cfLogfile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    tunnelError = 'Could not start cloudflared: ' + e.message;
    broadcastTunnelStatus();
    return { ok: false, error: tunnelError };
  }
  tunnelProc = proc;
  let buf = '';
  const sniff = (chunk) => {
    buf = (buf + chunk.toString()).slice(-32768);
    if (!tunnelUrl) { const m = buf.match(TRYCF_RE); if (m) { tunnelUrl = m[0]; console.log('  [tunnel] ' + tunnelUrl); broadcastTunnelStatus(); } }
  };
  if (proc.stdout) proc.stdout.on('data', sniff);
  if (proc.stderr) proc.stderr.on('data', sniff);
  let logFileSize = 0;
  cfLogPoll = setInterval(() => {
    if (!cfLogfile || tunnelUrl) return;
    try {
      if (!fs.existsSync(cfLogfile)) return;
      const st = fs.statSync(cfLogfile);
      if (st.size === logFileSize) return;
      const fd = fs.openSync(cfLogfile, 'r');
      const b = Buffer.alloc(Math.min(st.size - logFileSize, 1 << 20));
      fs.readSync(fd, b, 0, b.length, logFileSize);
      fs.closeSync(fd);
      logFileSize = st.size;
      sniff(b);
    } catch { /* ignore */ }
  }, 500);
  setTimeout(() => {
    if (tunnelProc === proc && !tunnelUrl) {
      tunnelError = 'Cloudflare did not return a URL within 30 seconds. Check the laptop has internet access.';
      broadcastTunnelStatus();
    }
  }, 30000);
  proc.on('error', (err) => {
    tunnelError = err && err.code === 'ENOENT' ? 'cloudflared not found — re-extract the bundle (bin/cloudflared.exe).' : 'cloudflared error: ' + (err && err.message);
    if (tunnelProc === proc) { tunnelProc = null; tunnelUrl = null; }
    broadcastTunnelStatus();
  });
  proc.on('exit', (code, signal) => {
    if (cfLogPoll) { clearInterval(cfLogPoll); cfLogPoll = null; }
    if (cfLogfile) { try { fs.unlinkSync(cfLogfile); } catch { /* ignore */ } cfLogfile = null; }
    if (tunnelProc === proc) {
      tunnelProc = null; tunnelUrl = null;
      if (code !== 0 && code !== null && !tunnelError) tunnelError = 'cloudflared exited (code ' + code + (signal ? ', signal ' + signal : '') + ').';
      broadcastTunnelStatus();
    }
  });
  broadcastTunnelStatus();
  return { ok: true, running: true, url: null };
}
function stopTunnel() {
  if (!tunnelProc) { tunnelUrl = null; tunnelError = null; broadcastTunnelStatus(); return; }
  try { tunnelProc.kill('SIGTERM'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- lifecycle
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnelProc) { try { tunnelProc.kill('SIGTERM'); } catch { /* ignore */ } }
  console.log('\n  Saving rooms…');
  store.compactAll();
  stageLink.stop();
  if (discovery) discovery.stop();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// A live meeting must not stop for one bad event: log it, keep serving, keep the log safe on disk.
process.on('uncaughtException', (e) => { console.error('  [error]', e && e.stack ? e.stack : e); try { store.compactAll(); } catch { /* ignore */ } });
process.on('unhandledRejection', (e) => { console.error('  [error] unhandled rejection:', e && e.message ? e.message : e); });

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n  Port ${PORT} is already in use. Close the other AGMessage window, or set PORT to another number.\n` : '  Server error: ' + e.message);
  process.exit(3);   // the launcher won't restart this one
});

server.listen(PORT, HOST, () => {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) addresses.push(n.address);
  console.log('\n  AGMessage ' + VERSION + ' is running');
  console.log('  ---------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const a of addresses) console.log(`  LAN:     http://${a}:${PORT}`);
  console.log('');
  console.log('  ============================================');
  console.log('  Admin login (only from this host laptop):');
  console.log('    URL:   http://localhost:' + PORT + '/admin');
  console.log('    Token: ' + ADMIN_TOKEN);
  console.log('  ============================================');
  console.log('  AI drafts:   ' + (aiKey() ? 'on (' + ai.MODEL + ')' : 'off — add a key in Admin → AI'));
  console.log('  Stagewatch:  ' + (settings.stagewatchUrl || 'not linked (Admin → Show network)'));
  console.log('  Saved rooms: ' + ROOMS_DIR);
  console.log('  Uploads:     ' + UPLOAD_DIR + '\n');
});

module.exports = { app, server, io, store, buildMessage };
