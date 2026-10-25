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
const net = require('net');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { customAlphabet } = require('./lib/ids');

const { RoomStore } = require('./lib/store');
const guard = require('./lib/guard');
const ai = require('./lib/ai');
const nodes = require('./lib/nodes');
const resilience = require('./lib/resilience');
const secretbox = require('./lib/secretbox');
const { buildContext, showBrief } = require('./lib/context');
const tlsmod = require('./lib/tls');
const { Accounts, Sessions } = require('./lib/accounts');
const { AuditLog } = require('./lib/audit');
const rbac = require('./lib/rbac');
const { mountAccounts } = require('./lib/http-accounts');
const board = require('./lib/board');
const stagelines = require('./lib/stagelines');
const peerlinks = require('./lib/peerlinks');
const { Displays, cleanContent, describe: describeContent } = require('./lib/displays');
const { monitorEventLoopDelay } = require('perf_hooks');

const { BUILD } = require('./lib/version');
const VERSION = BUILD.version;
const PORT = parseInt(process.env.PORT || '3023', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPLOAD_DIR = process.env.AGM_UPLOAD_DIR || path.join(__dirname, 'uploads');
const envNumber = (name, dflt) => { const v = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : dflt; };
// Files pause while the disk has less than this free, so the room logs, the audit log and the saves always have room.
const UPLOAD_MIN_FREE = envNumber('AGM_UPLOAD_MIN_FREE', 1024 ** 3);
// A file uploaded but not posted within this long is removed (the page posts it when its sender presses Send).
const UPLOAD_ORPHAN_MS = envNumber('AGM_UPLOAD_ORPHAN_MS', 60 * 60_000);
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
// Saved through one write lane (tmp -> fsync -> rename, a .bak of the last whole file); keys sealed at rest
// (lib/secretbox.js) so a copied folder carries none.
const settingsLane = new resilience.WriteLane(SETTINGS_PATH, { delayMs: 100, keepBak: true, mode: 0o600 });
function loadSettings() {
  const s = resilience.readJsonWithBak(SETTINGS_PATH);
  return s && typeof s === 'object' ? s : {};
}
const settings = loadSettings();
function saveSettings() { settingsLane.save(() => JSON.stringify(settings, null, 2)); }
// One-time migration from 0.2: keys stored in clear become sealed ones.
for (const [plain, sealed] of [['aiKey', 'aiKeySealed'], ['stagewatchKey', 'stagewatchKeySealed']]) {
  if (typeof settings[plain] === 'string') {
    if (settings[plain]) settings[sealed] = secretbox.seal(settings[plain]);
    delete settings[plain];
    saveSettings();
  }
}
// This install's id on the show network (Show Bus §2): stable, so a renamed AGMessage is still the same node.
if (!/^[0-9a-f]{8}$/.test(settings.nodeId || '')) { settings.nodeId = crypto.randomBytes(4).toString('hex'); saveSettings(); }
const aiKey = () => process.env.ANTHROPIC_API_KEY || secretbox.open(settings.aiKeySealed) || '';
const stagewatchKey = () => secretbox.open(settings.stagewatchKeySealed) || '';
// A read-only token other nodes use for GET /api/context (shown on the admin page).
function contextToken() {
  let t = secretbox.open(settings.contextTokenSealed);
  if (!t) { t = 'agn_' + crypto.randomBytes(18).toString('base64url'); settings.contextTokenSealed = secretbox.seal(t); saveSettings(); }
  return t;
}

// ---------------------------------------------------------------- accounts, sessions, the audit log
// Individual logins beside the meeting codes (lib/accounts.js, lib/rbac.js); every action that matters is in the
// hash-chained audit log (lib/audit.js). The host laptop's admin token stays as the way in before any account exists.
const accounts = new Accounts(path.join(DATA_DIR, 'accounts.json'));
const sessions = new Sessions(path.join(DATA_DIR, 'sessions.json'), accounts);
const audit = new AuditLog(path.join(DATA_DIR, 'audit.jsonl'));
const HOST_ACTOR = Object.freeze({ t: 'admin', id: 'host', name: 'AGMessage laptop' });
const displays = new Displays(path.join(DATA_DIR, 'displays.json'), { seal: secretbox.seal, open: secretbox.open });
/** Every store saved through a write lane, by the name health and the console give it. */
const saveLanes = () => [['settings', settingsLane], ['accounts', accounts.lane], ['sessions', sessions.lane], ['screens', displays.lane]];
/** Write every lane and the audit entries still waiting now (shutdown, a crash); what still cannot be written is named on the console. */
function flushLanes() {
  for (const [name, lane] of saveLanes()) if (!lane.flushSync()) console.error('  [save] ' + name + ' could not be written: ' + lane.lastError);
  if (!audit.flush()) console.error('  [audit] ' + audit.unwritten + ' entries could not be written: ' + audit.lastError);
}

// ---------------------------------------------------------------- encrypted connections (Show Bus 1.2 §10)
// One certificate per install, kept beside the machine key (outside the app folder), private key sealed. The same port
// serves HTTP and HTTPS (lib/tls.js). AGM_TLS=0 turns HTTPS off (tests of the plain path, or a machine that can't).
let cert = null;
if (process.env.AGM_TLS !== '0') {
  try { cert = tlsmod.loadOrCreate({ dir: secretbox.keyDir(), name: 'AGMessage ' + os.hostname(), seal: secretbox.seal, open: secretbox.open }); }
  catch (e) { console.warn('  [tls] HTTPS off: ' + e.message); }
}
const pins = new tlsmod.PinStore(settings.tlsPins && typeof settings.tlsPins === 'object' ? settings.tlsPins : {});
const isLoopback = (req) => { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; };
const isEncrypted = (req) => !!(req.socket && req.socket.encrypted);
const tlsFacts = () => ({
  on: !!cert, fingerprint: cert ? cert.fp : '', validTo: cert ? cert.validTo : '', requireHttps: !!settings.requireHttps,
  link: stageLink.tlsState, desk: stageLink.desk,
});

// ---------------------------------------------------------------- health: crashes, the loop, latency
const RESTARTS = parseInt(process.env.AGM_RESTARTS || '0', 10) || 0;
const CRASH_PATH = path.join(DATA_DIR, 'last-crash.json');
const lastCrash = resilience.readJsonWithBak(CRASH_PATH);
const watchdogGaveUp = resilience.readJsonWithBak(path.join(DATA_DIR, 'watchdog.json'));
if (watchdogGaveUp) { try { fs.renameSync(path.join(DATA_DIR, 'watchdog.json'), path.join(DATA_DIR, 'watchdog.seen.json')); } catch { /* shown once anyway */ } }
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const loopRing = new resilience.Ring(120);    // p99 event-loop delay per 5 s, the last 10 minutes
setInterval(() => { loopRing.push(loopDelay.percentile(99) / 1e6); loopDelay.reset(); }, 5000).unref();
let rejections = 0;
let handlerFaults = 0;   // socket events refused because their handler threw (guardHandlers)
function healthFacts() {
  return {
    restarts: RESTARTS,
    lastCrash: lastCrash ? { at: lastCrash.at, message: String(lastCrash.message || '').slice(0, 200) } : null,
    watchdog: watchdogGaveUp ? { at: watchdogGaveUp.at, reason: String(watchdogGaveUp.reason || '').slice(0, 200) } : null,
    rejections,
    handlerFaults,
    loopMs: loopRing.stats(),
    stageRttMs: stageLink.rtt.stats(),
    stage: stageLink.status,
    clock: stageLink.clockInfo(),
    tls: tlsFacts(),
    saves: {
      writes: settingsLane.writes, coalesced: settingsLane.coalesced, error: settingsLane.lastError,
      stores: {
        ...Object.fromEntries(saveLanes().map(([name, l]) => [name, { writes: l.writes, error: l.lastError, failures: l.failures }])),
        rooms: { error: store.lastError, unsaved: store.unsaved().length },
        audit: { error: audit.lastError, unwritten: audit.unwritten },
      },
    },
  };
}

// Role-level events for the show network's context: never names, never content.
const recentEvents = [];
function noteEvent(text) { recentEvents.push({ at: Date.now(), text }); if (recentEvents.length > 40) recentEvents.shift(); }

// ---------------------------------------------------------------- rooms
// Loaded without writing: until this copy holds the data folder and its port (`holdDataFolder`, at the end of this file),
// another copy may be appending to these same files.
const store = new RoomStore(ROOMS_DIR);
const restored = store.loadAll((room) => {
  for (const m of room.messages) if (m.from && m.from.role === 'director') m.from.role = 'board';   // legacy role name
}, { compact: false });
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
      if ('stage' in op.f) io.to(room.code).emit('stageAck', { messageId: op.id, stage: op.f.stage, seq: s });
      if ('proposal' in op.f) io.to(room.code).emit('proposalUpdate', { messageId: op.id, proposal: op.f.proposal, seq: s });
      if ('help' in op.f) io.to(room.code).emit('helpUpdate', { messageId: op.id, help: op.f.help, seq: s });
      break;
    case 'del': io.to(room.code).emit('messageDeleted', { messageId: op.id, seq: s }); break;
    case 'reset': io.to(room.code).emit('roomReset', { roomCode: room.code, seq: s }); break;
  }
  boardDirty();
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

// Upload tokens, issued at join: an upload must come from someone in a meeting. The rate is the connection's and the
// address's, not the token's, so joining again or opening more sockets refills nothing.
const uploadTokens = new Map();    // token -> {room, uid, bucket (the connection's), ip}
const uploadBuckets = new Map();   // address -> its upload bucket
function addressUploads(ip) {
  let b = uploadBuckets.get(ip);
  if (!b) { b = new guard.Bucket(0.5, 8); uploadBuckets.set(ip, b); if (uploadBuckets.size > 5000) uploadBuckets.clear(); }
  return b;
}
// Files uploaded in this run and not yet past their wait: one nobody posted by then is removed.
const freshUploads = new Map();    // file name -> uploaded at

/** Every upload something still points at: a message in any hall, what a screen shows, a hall's holding image. */
function uploadsInUse() {
  const used = new Set();
  const add = (u) => { if (guard.validUploadUrl(u)) used.add(u.slice(9)); };
  for (const r of store.rooms.values()) for (const m of r.messages) if (m.type === 'file') add(m.url);
  for (const d of displays.list.values()) if (d.content) { add(d.content.url); add(d.content.image); }
  for (const code of Object.keys(displays.halls)) add(displays.hallHolding(code));
  return used;
}
/** Remove those of `names` nothing points at any more (a reset, a deletion, a hall removed). Resolves to how many went. */
async function removeUnused(names) {
  const used = uploadsInUse();
  let n = 0;
  for (const f of new Set(names)) {
    if (used.has(f) || !guard.validUploadUrl('/uploads/' + f)) continue;
    freshUploads.delete(f);
    try { await fs.promises.unlink(path.join(UPLOAD_DIR, f)); n++; } catch { /* already gone */ }
  }
  return n;
}
const fileNamesOf = (messages) => messages.filter((m) => m && m.type === 'file' && guard.validUploadUrl(m.url)).map((m) => m.url.slice(9));
setInterval(() => {
  const due = Array.from(freshUploads).filter(([, at]) => Date.now() - at >= UPLOAD_ORPHAN_MS).map(([f]) => f);
  for (const f of due) freshUploads.delete(f);
  if (due.length) removeUnused(due).catch(() => { /* the next sweep tries the rest */ });
}, Math.max(100, Math.min(60_000, UPLOAD_ORPHAN_MS))).unref();

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.set('trust proxy', false);
app.use(guard.pageHeaders);
// Require HTTPS (admin setting): plain HTTP only from this machine (which is also how the Cloudflare tunnel connects).
// A browser asking for a page is sent to the same address over HTTPS; anything else is refused and told why.
app.use((req, res, next) => {
  const g = tlsmod.httpsGate({ required: !!settings.requireHttps, on: !!cert, encrypted: isEncrypted(req), loopback: isLoopback(req), method: req.method, path: req.originalUrl, host: req.headers.host });
  if (g.allow) return next();
  if (g.redirect) return res.redirect(308, g.redirect);
  res.status(403).json({ ok: false, error: g.refuse });
});
// The certificate, for people to trust it once on each screen (Show Bus §10): public — a fingerprint is not a secret.
app.get('/tls.cer', (_req, res) => {
  if (!cert) return res.status(404).json({ ok: false, error: 'HTTPS is off on this AGMessage.' });
  res.setHeader('Content-Type', 'application/pkix-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="agmessage.cer"');
  res.end(cert.der);
});
app.get('/tls', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const fp = cert ? cert.fp.slice(7).match(/../g).join(':').toUpperCase() : '';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGMessage — secure connection</title><link rel="stylesheet" href="/styles.css"></head><body class="tls-page"><main class="tls">
<h1>Secure connection</h1>
${cert ? `<p>This AGMessage encrypts its pages with its own certificate. Browsers warn about it until you trust it once on each device. Before you do, check that the fingerprint below matches the one on the AGMessage laptop (Admin → Show network).</p>
<p class="fp"><strong>SHA-256 fingerprint</strong><br><code>${esc(fp)}</code></p>
<p><a class="btn" href="/tls.cer" download>Download the certificate</a> · valid until ${esc(cert.validTo)}</p>
<h2>Trust it</h2><ul>
<li><strong>Windows:</strong> open the downloaded file → Install Certificate → Local Machine → "Place all certificates in the following store" → Trusted Root Certification Authorities.</li>
<li><strong>macOS:</strong> open it in Keychain Access (System keychain) → double-click it → Trust → "When using this certificate: Always Trust".</li>
<li><strong>iPhone / iPad:</strong> open the download → Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn it on.</li>
<li><strong>Android:</strong> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate → choose the file.</li>
</ul>
<p>Then open this AGMessage with <code>https://</code> instead of <code>http://</code> — the same address and port.</p>
<p class="meta">Connected now over ${isEncrypted(req) ? 'HTTPS ✓' : 'plain HTTP'}.${settings.requireHttps ? ' This AGMessage requires HTTPS from other devices.' : ''}</p>`
    : '<p>HTTPS is turned off on this AGMessage.</p>'}
</main></body></html>`);
});
app.use(express.json({ limit: '256kb' }));
const web = mountAccounts(app, {
  accounts, sessions, audit, settings, isEncrypted,
  isTokenAdmin: (req) => isValidAdminCookie(req),
  hallNames: () => Array.from(store.rooms.values()).map((r) => ({ code: r.code, name: r.name || '' })),
  onAccountChanged: (id, what) => accountChanged(id, what),
});
/** The admin dashboard: the host laptop's token, or an account with admin rights (not through the tunnel unless allowed). */
function isAdminReq(req) {
  if (isValidAdminCookie(req)) return true;
  const w = web.who(req);
  return !!(w && !w.account.mustChange && rbac.can(w.account, 'settings.manage') && (!web.throughTunnel(req) || settings.remoteAdmin));
}
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
const readCookie = (req, name) => guard.readCookie(req.headers.cookie, name);
const isValidAdminCookie = (req) => { const sid = readCookie(req, 'agm_admin'); return !!(sid && adminSessions.has(sid)); };
const adminLockout = new guard.Lockout(5, 60_000);

app.post('/api/admin/login', (req, res) => {
  if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'Admin login is only allowed on the host laptop.' });
  if (adminLockout.locked('host')) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const t = String((req.body && req.body.token) || '').toLowerCase().trim();
  if (!t || !guard.safeEqual(t, ADMIN_TOKEN)) { adminLockout.fail('host'); audit.write(HOST_ACTOR, 'login.token.fail', 'host', 'a wrong admin token', guard.clientIp(req)); return res.status(401).json({ ok: false, error: 'Invalid admin token.' }); }
  adminLockout.ok('host');
  const sid = crypto.randomBytes(24).toString('hex');
  adminSessions.add(sid);
  audit.write(HOST_ACTOR, 'login.token', 'host', 'signed in with the host laptop\'s admin token', guard.clientIp(req));
  res.setHeader('Set-Cookie', 'agm_admin=' + sid + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400' + (isEncrypted(req) ? '; Secure' : ''));
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const sid = readCookie(req, 'agm_admin');
  if (sid) adminSessions.delete(sid);
  res.setHeader('Set-Cookie', 'agm_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ ok: isAdminReq(req), local: guard.isHostMachine(req), accounts: accounts.size }));

// A display's page: the same page for every token, valid or not (the socket decides), so the URL itself says nothing.
// No caching, no referrer (pageHeaders), no indexing: the token is a capability.
app.get('/d/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PUBLIC_DIR, 'display.html'));
});

app.get('/api/admin/transcript/:code', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).send('Forbidden');
  const room = store.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).send('Room not found');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', 'inline; filename="transcript-' + room.code + '.html"');
  res.send(renderTranscriptHtml(room));
});

// Health: anyone may ask whether it is up; the detail is for the admin (or the host laptop).
app.get('/api/health', (req, res) => {
  const base = { ok: true, version: VERSION, build: BUILD.full, uptime: Math.round(process.uptime()) };
  if (!(isAdminReq(req) || guard.isHostMachine(req))) return res.json(base);
  res.json({ ...base, rooms: store.rooms.size, clients: io.engine.clientsCount, ...healthFacts() });
});

// Context (Show Bus §6): what another node's AI, or Patterns' Eye, needs to understand this one. Read-only token or admin.
function bearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
const contextLock = new guard.Lockout(10, 60_000);
app.get('/api/context', (req, res) => {
  const ip = guard.clientIp(req);
  if (contextLock.locked(ip)) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const t = bearer(req);
  const allowed = isAdminReq(req) || (t && guard.safeEqual(t, contextToken()));
  if (!allowed) { if (t) contextLock.fail(ip); return res.status(401).json({ ok: false, error: 'A context token is needed (AGMessage admin → Show network).' }); }
  res.setHeader('Cache-Control', 'no-store');
  res.json(currentContext());
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
  const w = web.who(req);
  if (!(isAdminReq(req) || (w && !w.account.mustChange && rbac.can(w.account, 'halls.manage')))) return res.status(403).json({ ok: false, error: 'Only admin can create rooms.' });
  const room = newRoom(req.body && typeof req.body.name === 'string' ? req.body.name : '');
  audit.write(w ? web.actorOf(w) : HOST_ACTOR, 'hall.create', room.code, room.name || '(no name)', guard.clientIp(req));
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

// The halls a signed-in account may see, for its account area (live detail follows on the socket).
app.get('/api/halls', web.signedIn(), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = req.agm.account;
  const halls = Array.from(store.rooms.values()).filter((r) => rbac.seesHall(a, r.code)).map((r) => ({
    code: r.code, name: r.name || '', people: r.users.size, messages: r.messages.length, locked: !!r.settings.lockRoles,
    can: { post: rbac.can(a, 'hall.post', r.code), files: rbac.can(a, 'hall.files', r.code), displays: rbac.can(a, 'display.control', r.code), stage: rbac.can(a, 'stage.send', r.code) },
  })).sort((x, y) => (x.name || x.code).localeCompare(y.name || y.code));
  res.json({ ok: true, halls, account: Accounts.view(a), canManageHalls: rbac.can(a, 'halls.manage'), canManageUsers: rbac.can(a, 'users.manage'), canAudit: rbac.can(a, 'audit.read'), isAdmin: isAdminReq(req) });
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

let statfsWarned = false;
app.post('/api/upload', async (req, res, next) => {
  const t = uploadTokens.get(String(req.headers['x-agm-upload'] || ''));
  if (!t) return res.status(403).json({ error: 'Join a meeting to share files.' });
  if (!t.bucket.take() || !addressUploads(t.ip).take()) return res.status(429).json({ error: 'Slow down — one file at a time.' });
  // Before anything is written: a disk short of space keeps it for the messages, the logs and the saves.
  try {
    const st = await fs.promises.statfs(UPLOAD_DIR);
    if (st.bavail * st.bsize < UPLOAD_MIN_FREE) return res.status(507).json({ error: 'The AGMessage laptop is short of disk space, so files are paused. Messages still work.' });
  } catch (e) {
    if (!statfsWarned) { statfsWarned = true; console.warn('  [uploads] free space cannot be read (' + e.code + '): files are not paused when the disk fills'); }
  }
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
    freshUploads.set(req.file.filename, Date.now());
    res.json({ url: `/uploads/${req.file.filename}`, filename: String(req.file.originalname).slice(0, 120), mime: type.mime.split(';')[0], size: req.file.size });
  });
});

// Errors end in one short JSON line, never a stack trace: a malformed body is the caller's (400), anything else is ours
// (500, logged). Express 5 forwards a rejected async handler here too.
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('  [http] ' + (err && err.stack ? err.stack : err));
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: status === 500 ? 'Server error.' : status === 413 ? 'That request is too large.' : 'Bad request.' });
});

// ---------------------------------------------------------------- Socket.io
const server = http.createServer(app);
// The listening socket: one port, HTTP and HTTPS (the first byte decides) — or plain HTTP only when HTTPS is off.
const front = cert ? tlsmod.dualPortServer(server, { certPem: cert.certPem, keyPem: cert.keyPem }) : server;
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
  if (settings.requireHttps && cert && !(socket.request && (isEncrypted(socket.request) || isLoopback(socket.request))))
    return next(new Error('This AGMessage requires HTTPS — open it with https:// (see /tls).'));
  return b.take() ? next() : next(new Error('Too many connections — wait a moment.'));
});

const joinLock = new guard.Lockout(10, 60_000);
let aiRunning = 0;
const AI_MAX_CONCURRENT = 3;

/**
 * Every event a socket sends reaches its handler through here, so what a client sends can refuse that one request
 * but never end the process for everyone. A null argument arrives as undefined (a handler's `= {}` default then
 * applies), and a handler that throws or rejects is answered with a refusal, logged and counted (admin health),
 * instead of reaching the uncaught-exception path and the watchdog. `socket.off` still finds a guarded listener.
 */
function guardHandlers(socket) {
  const on = socket.on.bind(socket);
  socket.on = (event, fn) => {
    const guarded = (...args) => {
      const clean = args.map((a) => (a === null ? undefined : a));
      const ack = typeof clean[clean.length - 1] === 'function' ? clean[clean.length - 1] : null;
      const refuse = (e) => {
        handlerFaults++;
        if (handlerFaults <= 20 || handlerFaults % 100 === 0) console.error('  [socket] ' + String(event).slice(0, 40) + ' refused (' + handlerFaults + '): ' + (e && e.message ? e.message : e));
        if (ack) { try { ack({ ok: false, error: 'That request could not be handled.' }); } catch { /* the client has gone */ } }
      };
      try {
        const r = fn(...clean);
        if (r && typeof r.then === 'function') r.then(undefined, refuse);
        return r;
      } catch (e) { refuse(e); return undefined; }
    };
    guarded.listener = fn.listener || fn;
    return on(event, guarded);
  };
  return socket;
}

io.on('connection', (socket) => {
  guardHandlers(socket);
  // A display's browser: it may only receive what its own display shows and say what it showed — nothing else is
  // listened to on this socket (fail closed).
  const displayToken = socket.handshake.auth && typeof socket.handshake.auth.display === 'string' ? socket.handshake.auth.display : '';
  if (displayToken) { serveDisplay(socket, displayToken); return; }
  let room = null;
  let me = null;   // {uid, name, role}
  // Who this is: the host's admin token, a signed-in account (both from the handshake's cookies), or nobody yet — a
  // meeting code at 'join'. Rights are read once here; a change to the account ends this socket (accountChanged).
  const hs = { headers: socket.handshake.headers, socket: socket.request && socket.request.socket };
  const tokenAdmin = !!(adminSessions.has(guard.readCookie(hs.headers.cookie, 'agm_admin') || ''));
  const acct = web.who(hs);
  socket.data.account = acct && !acct.account.mustChange ? acct.account : null;
  socket.data.accountId = socket.data.account ? socket.data.account.id : '';
  socket.data.isAdmin = tokenAdmin || !!(socket.data.account && rbac.can(socket.data.account, 'settings.manage') && (!web.throughTunnel(hs) || settings.remoteAdmin));
  socket.data.actor = tokenAdmin ? HOST_ACTOR : socket.data.account ? { t: 'account', id: socket.data.account.id, name: socket.data.account.username } : null;
  const writes = new guard.Bucket(5, 15);      // messages, reactions, pins…
  const chatter = new guard.Bucket(10, 20);    // typing, seen, ui sync
  const aiBucket = new guard.Bucket(0.2, 4);   // one AI request per 5 s, bursts of 4
  const uploadBucket = new guard.Bucket(0.5, 4);   // files from this connection, whichever hall or token
  let uploadToken = null;
  const ok = (ack) => (typeof ack === 'function' ? ack : () => {});
  const limited = (ack) => { ok(ack)({ ok: false, error: 'Slow down a little.' }); };
  // What this person may do in the room they are in: an account by its rights in that hall, a code guest by the role
  // they joined with (backstage: post, files, the stage; on stage: post and files; observer: read), the admin everything.
  const GUEST_CAPS = { research: ['hall.view', 'hall.post', 'hall.files', 'stage.send'], board: ['hall.view', 'hall.post', 'hall.files'], observer: ['hall.view'] };
  const allowed = (cap) => {
    if (socket.data.isAdmin) return true;
    if (!me || !room) return false;
    if (me.acct) return rbac.can(socket.data.account, cap, room.code);
    return (GUEST_CAPS[me.role] || []).includes(cap);
  };

  socket.on('join', (args, ack) => {
    ack = ok(ack);
    const { roomCode, name, role, adminView, uid, since, invite } = args || {};
    const ip = socket.data.ip;
    if (joinLock.locked(ip)) return ack({ ok: false, error: 'Too many attempts — wait a minute.' });
    const code = guard.str(roomCode).toUpperCase().trim();
    const acct = (args && args.as === 'account') ? socket.data.account : null;
    if (args && args.as === 'account' && !acct) return ack({ ok: false, error: 'Sign in first.', signIn: true });
    const cleanName = acct ? acct.name : guard.cleanText(name, 40);
    let cleanRole = role === 'director' ? 'board' : role;
    cleanRole = ROLES.includes(cleanRole) ? cleanRole : 'observer';
    const isAdminView = !!adminView && socket.data.isAdmin;
    if (!code || !cleanName) return ack({ ok: false, error: 'Missing room code or name' });
    const r = RoomStore.validCode(code) ? store.get(code) : null;
    if (!r) { joinLock.fail(ip); return ack({ ok: false, error: 'Room not found' }); }

    // Identity: an account is itself on every device; anyone else gets one issued (and signed) by the server.
    let id, identity = null;
    let note = '';
    if (acct) {
      if (!rbac.seesHall(acct, code)) return ack({ ok: false, error: 'Your account has no access to this hall — ask an admin.' });
      id = acct.id;
      cleanRole = rbac.roomRoleFor(acct, code);
    } else {
      id = guard.checkIdentity(SECRET, uid);
      if (!id) { identity = guard.newIdentity(SECRET); id = guard.checkIdentity(SECRET, identity); }
      // Locked rooms: board and research seats need the admin's invite link.
      if (r.settings.lockRoles && cleanRole !== 'observer' && !socket.data.isAdmin && !guard.checkInvite(SECRET, code, cleanRole, invite)) {
        cleanRole = 'observer';
        note = 'This meeting needs an invite link for that role — you joined as an observer.';
      }
      // A code guest cannot take the name of someone with an account: staff are who they say they are.
      if (!isAdminView && accounts.list().some((a) => a.name.toLowerCase() === cleanName.toLowerCase())) {
        joinLock.fail(ip);
        return ack({ ok: false, error: 'That name belongs to an AGMessage account: sign in, or pick another name.' });
      }
    }

    if (!isAdminView) {
      for (const u of r.users.values()) {
        if (u.name.toLowerCase() === cleanName.toLowerCase() && u.uid !== id && !acct) {
          return ack({ ok: false, error: 'That name is already in use in this meeting. Please pick a different display name.' });
        }
      }
    }
    joinLock.ok(ip);

    if (room && room !== r) leaveRoom(true);
    me = { uid: id, name: cleanName, role: cleanRole, joinedAt: Date.now(), ...(acct ? { acct: acct.username } : {}) };
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
    uploadToken = null;
    if (allowed('hall.files')) {
      uploadToken = crypto.randomBytes(18).toString('base64url');
      uploadTokens.set(uploadToken, { room: code, uid: id, bucket: uploadBucket, ip: socket.data.ip });
    }

    // Resume: just what they missed, when we still have it; otherwise the whole history.
    const ops = Number.isInteger(since) ? store.opsSince(r, since) : null;
    ack({
      ok: true, roomCode: code, roomName: r.name || '', role: cleanRole, name: cleanName, adminView: isAdminView,
      identity, uid: id, note, uploadToken, seq: r.seq,
      ...(ops ? { ops } : { history: r.messages }),
      users: roomUserSummary(r),
      ai: !!aiKey(), stage: stagePayload(linkFor(code)),
      canSendToStage: !!(linkFor(code).base && linkFor(code).key) && allowed('stage.send'),
      canPropose: !!(linkFor(code).desk && linkFor(code).key) && allowed('stage.send'),
      account: acct ? { username: acct.username, name: acct.name, role: acct.role, roleLabel: rbac.ROLES[acct.role].label } : null,
      seen: seenFor(r),
    });

    if (!isAdminView) {
      if (!returning) systemMessage(r, `${cleanName} joined as ${cleanRole}`);
      io.to(code).emit('users', roomUserSummary(r));
      boardDirty();
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
    if (!allowed('hall.post')) return ok(ack)({ ok: false, error: 'Observers can read but not post.' });
    if (payload && payload.type === 'file' && !allowed('hall.files')) return ok(ack)({ ok: false, error: 'Your account may not share files here.' });
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
    removeUnused(fileNamesOf([msg])).catch(() => { /* a file left behind is only space */ });
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
    const dst = store.get(guard.str(targetRoom).toUpperCase());
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
      show: showBrief(briefOf(linkFor(room.code)), discovery ? discovery.list() : []),
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
    runAi(ack, (signal) => ai.suggestOptions(aiKey(), { prompt, messages: room.messages, show: showBrief(briefOf(linkFor(room.code)), discovery ? discovery.list() : []) }, signal));
  });

  // ----- Stagewatch: put an answer on the speaker's confidence monitor (research or admin)
  socket.on('stage:send', async (args = {}, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    if (!allowed('stage.send')) return ack({ ok: false, error: 'Sending to the stage is for the backstage team.' });
    if (!writes.take()) return limited(ack);
    let text = typeof args.text === 'string' ? args.text : '';
    const source = typeof args.messageId === 'string' ? room.byId.get(args.messageId) : null;
    if (!text && source) text = source.text || '';
    const link = linkFor(room.code);
    const r = await link.sendToStage(text, { urgency: args.urgency, ack: args.ack !== false });
    if (r.ok) {
      // The receipt, and later the speaker's acknowledgement, live on the record of the send (and on the source message).
      const stage = { ref: r.messageId || 0, receipt: r.stage, ack: r.messageId ? 'sent' : '', by: '', at: Date.now() };
      const sys = apply(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text: `${me.name} sent to the stage screen: “${text.replace(/\s+/g, ' ').slice(0, 120)}”`, at: Date.now(), stage } }).m;
      if (source) apply(room, { o: 'upd', id: source.id, f: { stage } });
      if (r.messageId) trackStageSend(link, r.messageId, room.code, [sys.id].concat(source ? [source.id] : []));
      noteEvent('research sent a message to the stage screen (' + r.stage + ')');
    }
    ack(r);
  });

  // ----- Where a message can go in this hall's Stagewatch: the speaker's screen (sent now, or proposed), role screens,
  // its departments (from its context), the operator alone (proposed).
  socket.on('stage:targets', (_args, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    const link = linkFor(room.code);
    ack({
      ok: true, linked: link.linked, title: (link.context && link.context.node && link.context.node.name) || '',
      canSend: !!(link.base && link.key) && allowed('stage.send'), canPropose: !!(link.desk && link.key) && allowed('stage.send'),
      targets: stagelines.destinations(stagelines.departmentsOf(link.context)),
    });
  });

  // ----- Show desk (Show Bus 1.2 §11): propose a stage message instead of sending it; the show caller approves
  socket.on('stage:propose', async (args = {}, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    if (!allowed('stage.send')) return ack({ ok: false, error: 'Proposing to the stage is for the backstage team.' });
    if (!writes.take()) return limited(ack);
    let text = typeof args.text === 'string' ? args.text : '';
    const source = typeof args.messageId === 'string' ? room.byId.get(args.messageId) : null;
    if (!text && source) text = source.text || '';
    // Where in Stagewatch it goes (lib/stagelines.js): the speaker's screen, a role screen, a department, or the
    // operator alone — always in Stagewatch's own grammar, for the show caller to approve.
    const built = stagelines.lineFor(args.destination || 'speaker', text, args.urgency);
    if (built.error) return ack({ ok: false, error: built.error });
    const link = linkFor(room.code);
    const r = await link.propose({
      from: { t: 'messenger', id: settings.nodeId, name: 'AGMessage' },
      target: { t: 'main' },
      line: built.line,
      reason: 'AGMessage (' + (me.acct ? 'crew' : 'backstage') + ') asks for this on ' + built.words + (source && source.aiDraft ? ' — an AI draft a person chose' : '') + '.',
      risk: 'review',
    });
    if (!r.ok) return ack(r);
    const proposal = { id: r.proposal.id, link: link.id, state: r.proposal.state, words: '', to: built.words, at: Date.now() };
    const sys = apply(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text: `${me.name} asked Stagewatch's operator to put this on ${built.words}: “${stagelines.parse(built.line).text.slice(0, 120)}” — waiting for the show desk`, at: Date.now(), proposal } }).m;
    if (source) apply(room, { o: 'upd', id: source.id, f: { proposal } });
    trackProposal(link.id, proposal.id, room.code, [sys.id].concat(source ? [source.id] : []), proposal.state);
    noteEvent('research proposed a stage message to the show desk');
    ack({ ok: true, proposal });
  });

  // ----- Displays: a hall's screens. Seeing and changing what they show is display.control; making, renaming, moving,
  // replacing the link and removing is display.manage. Both are an account's (or the admin's) rights in that hall.
  const canDisplays = (cap, code) => socket.data.isAdmin || !!(socket.data.account && rbac.can(socket.data.account, cap, code));
  const actor = () => socket.data.actor || (me ? { t: 'code', id: me.uid, name: me.name } : HOST_ACTOR);
  socket.on('display:list', ({ code } = {}, ack) => {
    ack = ok(ack);
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !canDisplays('display.control', c)) return ack({ ok: false, error: 'Your account may not drive this hall\'s screens.' });
    const manage = canDisplays('display.manage', c);
    ack({ ok: true, code: c, manage, holding: displays.hallHolding(c), displays: displays.ofHall(c).map((d) => ({ ...Displays.status(d), ...(manage ? { path: displays.path(d) } : {}) })) });
  });
  socket.on('display:take', ({ id, content } = {}, ack) => {
    ack = ok(ack);
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.control', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    if (!writes.take()) return limited(ack);
    const c = cleanContent(content);
    if (c.error) return ack({ ok: false, error: c.error });
    const who = actor();
    displays.take(d.id, c, who.name);
    io.to('display:' + d.id).emit('display:state', displayState(d));
    audit.write(who, 'display.take', d.id, d.name + ' → ' + describeContent(c), socket.data.ip);
    displaysChanged(d.hall);
    ack({ ok: true, seq: d.seq, status: Displays.status(d) });
  });
  socket.on('display:identify', ({ id } = {}, ack) => {
    ack = ok(ack);
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.control', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    if (!chatter.take()) return limited(ack);
    io.to('display:' + d.id).emit('display:identify', { name: d.name, hall: (store.get(d.hall) || {}).name || d.hall, seconds: 6 });
    ack({ ok: true, screens: d.live.sockets });
  });
  socket.on('display:create', ({ code, name } = {}, ack) => {
    ack = ok(ack);
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !canDisplays('display.manage', c)) return ack({ ok: false, error: 'Your account may not add screens to this hall.' });
    if (displays.ofHall(c).length >= 50) return ack({ ok: false, error: 'A hall has at most 50 screens.' });
    const r = displays.create(c, name, actor().name);
    audit.write(actor(), 'display.create', r.display.id, r.display.name + ' in ' + c, socket.data.ip);
    displaysChanged(c);
    ack({ ok: true, display: { ...Displays.status(r.display), path: r.path } });
  });
  socket.on('display:update', ({ id, name, hall } = {}, ack) => {
    ack = ok(ack);
    const d = displays.get(guard.str(id));
    const to = typeof hall === 'string' && hall ? hall.toUpperCase() : '';
    if (!d || !canDisplays('display.manage', d.hall) || (to && (!store.has(to) || !canDisplays('display.manage', to)))) return ack({ ok: false, error: 'No such screen or hall, or not yours to change.' });
    const from = d.hall;
    displays.update(d.id, { name, hall: to || undefined });
    audit.write(actor(), 'display.update', d.id, 'name ' + d.name + (to && to !== from ? ', moved ' + from + ' → ' + to : ''), socket.data.ip);
    io.to('display:' + d.id).emit('display:state', displayState(d));
    displaysChanged(from); if (to && to !== from) displaysChanged(to);
    ack({ ok: true });
  });
  socket.on('display:rotate', ({ id } = {}, ack) => {
    ack = ok(ack);
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.manage', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    const p = displays.rotate(d.id);
    revokeDisplaySockets(d.id, 'This screen\'s link was replaced. Open the new link to show it again.');
    audit.write(actor(), 'display.rotate', d.id, d.name + ': new link, the old one stopped', socket.data.ip);
    displaysChanged(d.hall);
    ack({ ok: true, path: p });
  });
  socket.on('display:remove', ({ id } = {}, ack) => {
    ack = ok(ack);
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.manage', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    revokeDisplaySockets(d.id, 'This screen was removed from AGMessage.');
    displays.remove(d.id);
    audit.write(actor(), 'display.remove', d.id, d.name + ' removed', socket.data.ip);
    displaysChanged(d.hall);
    ack({ ok: true });
  });
  socket.on('display:hallHolding', ({ code, image } = {}, ack) => {
    ack = ok(ack);
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !(canDisplays('display.manage', c) || canManageHall())) return ack({ ok: false, error: 'Your account may not set this hall\'s holding image.' });
    const h = cleanContent({ kind: 'holding', image });
    if (h.error) return ack({ ok: false, error: h.error });
    displays.setHallHolding(c, h.image || '');
    for (const d of displays.ofHall(c)) io.to('display:' + d.id).emit('display:state', displayState(d));
    audit.write(actor(), 'hall.holding', c, h.image ? 'holding image set' : 'holding image cleared', socket.data.ip);
    displaysChanged(c);
    ack({ ok: true });
  });

  // ----- Patterns and PlayMap: what they are doing, and the verbs they list — sent now (low / review risk) or proposed to
  // the show desk (any risk; high only ever proposed). Linking a node (its token) is the admin's.
  socket.on('nodes:list', (_args, ack) => {
    ack = ok(ack);
    const any = socket.data.isAdmin || (socket.data.account && rbac.can(socket.data.account, 'nodes.control'));
    if (!any) return ack({ ok: false, error: 'Your account may not drive other show systems.' });
    const linked = Array.from(peerLinks.values()).filter((l) => mayDriveNode(socket, l)).map((l) => l.view());
    const heard = socket.data.isAdmin && discovery ? discovery.list().filter((p) => peerlinks.KINDS.has(p.t) && !peerLinks.has(p.id)) : [];
    ack({ ok: true, linked, heard, admin: !!socket.data.isAdmin, halls: Array.from(store.rooms.values()).map((r) => ({ code: r.code, name: r.name || '' })), desk: allLinks().some((l) => l.desk) });
  });
  socket.on('nodes:link', ({ id, token, hall, url, name, t: typedKind } = {}, ack) => {
    ack = ok(ack);
    if (!socket.data.isAdmin) return ack({ ok: false, error: 'Linking another show system is the admin\'s.' });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(guard.str(id))) return ack({ ok: false, error: 'A node id is the one its hello announces.' });
    const peer = discovery ? discovery.peers.get(guard.str(id)) : null;
    const cfg = settings.peerLinks && settings.peerLinks[guard.str(id)];
    // Heard on the bus, linked before, or typed (a venue network that blocks broadcast): its kind and its address.
    const t = (peer && peer.t) || (cfg && cfg.t) || (typeof url === 'string' && url.trim() ? typedKind : '');
    if (!t || !peerlinks.KINDS.has(t)) return ack({ ok: false, error: 'Choose a Patterns or PlayMap that AGMessage hears on the network, or type its kind and address.' });
    const port = peer ? (peer.ports.http || peer.ports.https) : 0;
    const base = typeof url === 'string' && url.trim() ? nodes.normaliseBase(url) : peer ? (peer.tls ? 'https://' : 'http://') + peer.address + ':' + (peer.ports.https || port) : cfg.url;
    if (!base) return ack({ ok: false, error: 'That is not an address.' });
    const h = typeof hall === 'string' && hall ? hall.toUpperCase() : '';
    if (h && !store.has(h)) return ack({ ok: false, error: 'No such hall.' });
    const sealed = typeof token === 'string' && token.trim() ? secretbox.seal(token.trim().slice(0, 200)) : (cfg && cfg.tokenSealed) || '';
    const next = { t, name: guard.cleanText(name || (peer && peer.name) || (cfg && cfg.name) || t, 60), url: base, tokenSealed: sealed, hall: h };
    settings.peerLinks = { ...(settings.peerLinks || {}), [guard.str(id)]: next };
    saveSettings();
    startPeerLink(guard.str(id), next);
    audit.write(socket.data.actor || HOST_ACTOR, 'node.link', guard.str(id), t + ' “' + next.name + '” at ' + base + (h ? ' for ' + h : '') + (typeof token === 'string' && token.trim() ? ' (token sealed)' : ''), socket.data.ip);
    boardDirty(); nodesChanged();
    ack({ ok: true });
  });
  socket.on('nodes:unlink', ({ id } = {}, ack) => {
    ack = ok(ack);
    if (!socket.data.isAdmin) return ack({ ok: false, error: 'Unlinking another show system is the admin\'s.' });
    if (!settings.peerLinks || !settings.peerLinks[guard.str(id)]) return ack({ ok: false, error: 'Not linked.' });
    const was = settings.peerLinks[guard.str(id)];
    const rest = { ...settings.peerLinks };
    delete rest[guard.str(id)];
    settings.peerLinks = rest;
    saveSettings();
    startPeerLink(guard.str(id), null);
    audit.write(socket.data.actor || HOST_ACTOR, 'node.unlink', guard.str(id), was.t + ' “' + was.name + '” unlinked; its token forgotten', socket.data.ip);
    boardDirty(); nodesChanged();
    ack({ ok: true });
  });
  socket.on('nodes:command', async ({ id, line, mode } = {}, ack) => {
    ack = ok(ack);
    const link = peerLinks.get(guard.str(id));
    if (!link || !mayDriveNode(socket, link)) return ack({ ok: false, error: 'No such link, or not yours to drive.' });
    if (!writes.take()) return limited(ack);
    const text = guard.cleanText(line, 400);
    const match = link.context ? peerlinks.matchCommand(link.context.commands, text) : null;
    if (!text || !match) return ack({ ok: false, error: link.node.name + ' does not list that command — only the verbs it lists can be sent.' });
    const who = socket.data.actor || (me ? { t: 'code', id: me.uid, name: me.name } : HOST_ACTOR);
    if (mode === 'send') {
      if (match.risk === 'high') return ack({ ok: false, error: '“' + match.verb + '” is high risk for ' + link.node.name + ': propose it to the show desk, where a person approves it.' });
      const r = await link.send(text);
      audit.write(who, 'node.command', link.node.id, link.node.name + ': ' + text + ' → ' + (r.ok ? r.stage + (r.effect ? ' (' + r.effect + ')' : '') : 'refused: ' + (r.error || '')), socket.data.ip);
      noteEvent('a person sent a ' + match.risk + '-risk command to ' + link.node.t);
      return ack({ ...r, risk: match.risk });
    }
    const desk = [linkFor(link.hall || (room && room.code) || ''), ...allLinks()].find((l) => l.linked && l.desk);
    if (!desk) return ack({ ok: false, error: 'No show desk is linked: a Stagewatch with an approval queue takes proposals.' });
    const r = await desk.propose({
      from: { t: 'messenger', id: settings.nodeId, name: 'AGMessage' },
      target: { t: link.node.t, id: link.node.id, name: link.node.name },
      line: text, reason: 'Asked from AGMessage by ' + who.name + (link.hall ? ' (' + ((store.get(link.hall) || {}).name || link.hall) + ')' : '') + '.', risk: match.risk,
    });
    audit.write(who, 'node.propose', link.node.id, link.node.name + ': ' + text + ' → ' + (r.ok ? 'proposed (' + r.proposal.id + ')' : 'refused: ' + r.error), socket.data.ip);
    ack(r.ok ? { ok: true, proposal: r.proposal, risk: match.risk } : r);
  });

  // ----- The halls board: an account's every hall at a glance (or the admin's), pushed latest-wins on change.
  socket.on('board:watch', (_args, ack) => {
    ack = ok(ack);
    if (!(socket.data.account || socket.data.isAdmin)) return ack({ ok: false, error: 'Sign in first.' });
    boardSockets.add(socket);
    ack({ ok: true, board: boardFor(socket) });
  });

  // ----- Help requests: someone says they are on the way, then that it is resolved. From the hall, or from the board.
  socket.on('help:respond', ({ code, messageId, state } = {}, ack) => {
    ack = ok(ack);
    if (!chatter.take()) return limited(ack);
    const r = store.get(guard.str(code || (room && room.code)).toUpperCase());
    const m = r && r.byId.get(messageId);
    if (!m || m.type !== 'help') return ack({ ok: false, error: 'That help request is gone.' });
    const inRoom = room && room.code === r.code && allowed('hall.post');
    const byAccount = socket.data.account && rbac.can(socket.data.account, 'hall.post', r.code);
    if (!(inRoom || byAccount || socket.data.isAdmin)) return ack({ ok: false, error: 'Only people in that hall can answer its help requests.' });
    if (state !== 'coming' && state !== 'resolved') return ack({ ok: false, error: 'Say "on my way" or "resolved".' });
    if (m.help && m.help.state === 'resolved') return ack({ ok: false, error: 'Already resolved' + (m.help.by ? ' by ' + m.help.by : '') + '.' });
    const by = (me && room && room.code === r.code) ? me.name : socket.data.account ? socket.data.account.name : 'Admin';
    apply(r, { o: 'upd', id: m.id, f: { help: { state, by, at: Date.now() } } });
    noteEvent('a help request was ' + (state === 'coming' ? 'answered' : 'resolved'));
    ack({ ok: true });
  });

  // ----- A hall's own settings: its name and its own Stagewatch (halls.manage).
  const canManageHall = () => socket.data.isAdmin || (socket.data.account && rbac.can(socket.data.account, 'halls.manage'));
  socket.on('hall:settings', ({ code } = {}, ack) => {
    ack = ok(ack);
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    const r = store.get(guard.str(code).toUpperCase());
    if (!r) return ack({ ok: false, error: 'No such hall.' });
    const sw = hallStagewatch(r.code) || {};
    const own = hallLinks.get(r.code);
    ack({
      ok: true, code: r.code, name: r.name || '',
      stagewatch: { url: sw.url || '', keySet: !!secretbox.open(sw.keySealed), fp: sw.fp || '', status: own ? own.status : null, tls: own ? own.tlsState : null },
      defaultStagewatch: settings.stagewatchUrl || '',
      stagewatches: discovery ? discovery.list().filter((p) => p.t === 'main') : [],
    });
  });
  socket.on('hall:configure', ({ code, name, stagewatchUrl, stagewatchKey, stagewatchFingerprint } = {}, ack) => {
    ack = ok(ack);
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    if (!writes.take()) return limited(ack);
    const r = store.get(guard.str(code).toUpperCase());
    if (!r) return ack({ ok: false, error: 'No such hall.' });
    const changed = [];
    if (typeof name === 'string') {
      const n = guard.cleanText(name, 80);
      if (n && n !== r.name) {
        store.commit(r, { o: 'meta', name: n });
        changed.push('name → ' + n);
        for (const d of displays.ofHall(r.code)) io.to('display:' + d.id).emit('display:state', displayState(d));
      }
    }
    if (typeof stagewatchUrl === 'string') {
      const prev = hallStagewatch(r.code) || {};
      const url = stagewatchUrl.trim() ? nodes.normaliseBase(stagewatchUrl) : '';
      if (stagewatchUrl.trim() && !url) return ack({ ok: false, error: 'That is not a Stagewatch address: type its IP or name, with the port if it is not 9924.' });
      const next = url ? {
        url,
        keySealed: typeof stagewatchKey === 'string' && stagewatchKey.trim() ? secretbox.seal(stagewatchKey.trim().slice(0, 80)) : (url === prev.url ? prev.keySealed || '' : ''),
        fp: typeof stagewatchFingerprint === 'string' ? tlsmod.cleanFingerprint(stagewatchFingerprint) : (url === prev.url ? prev.fp || '' : ''),
      } : null;
      settings.hallStagewatch = { ...(settings.hallStagewatch || {}) };
      if (next) settings.hallStagewatch[r.code] = next; else delete settings.hallStagewatch[r.code];
      saveSettings();
      configureHallLink(r);
      for (const s2 of io.sockets.sockets.values()) if (s2.rooms.has(r.code)) s2.emit('stage', stagePayload(linkFor(r.code)) || { status: 'off', desk: false });
      changed.push(url ? 'Stagewatch → ' + url + (typeof stagewatchKey === 'string' && stagewatchKey.trim() ? ' (new key, sealed)' : '') : 'Stagewatch → the default');
    }
    if (changed.length) audit.write(socket.data.actor || HOST_ACTOR, 'hall.update', r.code, changed.join('; '), socket.data.ip);
    boardDirty();
    ack({ ok: true, changed });
  });
  socket.on('hall:acceptCertificate', ({ code } = {}, ack) => {
    ack = ok(ack);
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    const link = hallLinks.get(guard.str(code).toUpperCase());
    if (!link || !link.acceptCertificate()) return ack({ ok: false, error: 'No changed certificate to accept.' });
    audit.write(socket.data.actor || HOST_ACTOR, 'hall.certificate', guard.str(code), 'accepted a changed Stagewatch certificate', socket.data.ip);
    ack({ ok: true });
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
    const files = fileNamesOf(r.messages);
    apply(r, { o: 'reset' });
    systemMessage(r, '— Session reset by admin: messages and documents cleared —');
    // Its documents leave the disk too, unless another hall or a screen still shows them.
    removeUnused(files).then((n) => ok(ack)({ ok: true, removed: n }), () => ok(ack)({ ok: true, removed: 0 }));
  });
  socket.on('admin:deleteRoom', async ({ roomCode, purgeFiles } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    const files = fileNamesOf(r.messages);
    io.to(r.code).emit('kicked', { reason: 'This meeting was closed by the admin.' });
    io.in(r.code).disconnectSockets(true);
    store.remove(r.code);
    if (hallStagewatch(r.code)) { delete settings.hallStagewatch[r.code]; saveSettings(); }
    for (const d of displays.ofHall(r.code)) revokeDisplaySockets(d.id, 'This screen\'s hall was closed.');
    displays.removeHall(r.code);
    configureHallLink({ code: r.code });   // its own Stagewatch link, if it had one, stops
    boardDirty();
    audit.write(socket.data.actor || HOST_ACTOR, 'hall.remove', r.code, (r.name || '(no name)') + (purgeFiles ? ', files removed' : ''), socket.data.ip);
    const purged = purgeFiles ? await removeUnused(files) : 0;
    ok(ack)({ ok: true, purged });
  });
  socket.on('admin:deleteMessage', ({ roomCode, messageId } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.get(roomCode);
    if (!r || !r.byId.has(messageId)) return ok(ack)({ ok: false, error: 'Message not found' });
    const files = fileNamesOf([r.byId.get(messageId)]);
    apply(r, { o: 'del', id: messageId });
    removeUnused(files).then(() => ok(ack)({ ok: true }), () => ok(ack)({ ok: true }));
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
    const code = guard.str(targetRoom).toUpperCase();
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
    const code = guard.str(targetRoom).toUpperCase();
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
      // Each setting is taken only in its own type; the audit row names exactly what was taken (a secret as sealed).
      const taken = [];
      if (typeof patch.aiKey === 'string') { settings.aiKeySealed = secretbox.seal(patch.aiKey.trim().slice(0, 200)); taken.push('aiKey (sealed)'); }
      if (typeof patch.stagewatchUrl === 'string') { settings.stagewatchUrl = nodes.normaliseBase(patch.stagewatchUrl); taken.push('stagewatchUrl → ' + settings.stagewatchUrl.slice(0, 60)); }
      if (typeof patch.stagewatchKey === 'string') { settings.stagewatchKeySealed = secretbox.seal(patch.stagewatchKey.trim().slice(0, 80)); taken.push('stagewatchKey (sealed)'); }
      if (typeof patch.stagewatchFingerprint === 'string') { settings.stagewatchFingerprint = tlsmod.cleanFingerprint(patch.stagewatchFingerprint); taken.push('stagewatchFingerprint → ' + settings.stagewatchFingerprint.slice(0, 60)); }
      if (typeof patch.requireHttps === 'boolean') { settings.requireHttps = patch.requireHttps && !!cert; taken.push('requireHttps → ' + settings.requireHttps); }
      if (typeof patch.remoteAdmin === 'boolean') { settings.remoteAdmin = patch.remoteAdmin; taken.push('remoteAdmin → ' + settings.remoteAdmin); }
      if (patch.newContextToken === true) { delete settings.contextTokenSealed; taken.push('newContextToken (sealed)'); }
      if (taken.length) audit.write(socket.data.actor, 'settings', taken.map((t) => t.split(' ')[0]).join(','), 'changed ' + taken.join(', '), socket.data.ip);
      saveSettings();
      stageLink.configure(settings.stagewatchUrl, stagewatchKey(), settings.stagewatchFingerprint || '');
    }
    ok(ack)({
      ok: true,
      aiKeySet: !!aiKey(), aiFromEnv: !!process.env.ANTHROPIC_API_KEY, model: ai.MODEL,
      stagewatchUrl: settings.stagewatchUrl || '', stagewatchKeySet: !!stagewatchKey(),
      stage: stageLink.status, peers: discovery ? discovery.list() : [],
      nodeId: settings.nodeId, contextToken: contextToken(), health: healthFacts(),
      stageContext: stageLink.context ? { headline: stageLink.context.headline, light: stageLink.context.light, peers: stageLink.context.peers || [] } : null,
      tls: tlsFacts(), stagewatchFingerprint: settings.stagewatchFingerprint || '',
      remoteAdmin: !!settings.remoteAdmin, accounts: accounts.size, build: BUILD.full,
    });
  });

  // ----- Cloudflare tunnel control
  socket.on('admin:acceptCertificate', (ack) => {
    if (!admin(ack)) return;
    const was = stageLink.tlsState;
    if (!stageLink.acceptCertificate()) return ok(ack)({ ok: false, error: 'No certificate to accept.' });
    noteEvent('the admin accepted a changed Stagewatch certificate');
    ok(ack)({ ok: true, fingerprint: was.fp });
  });
  socket.on('admin:renewCertificate', (ack) => {
    if (!admin(ack)) return;
    if (!cert) return ok(ack)({ ok: false, error: 'HTTPS is off on this AGMessage.' });
    try {
      cert = tlsmod.loadOrCreate({ dir: secretbox.keyDir(), name: 'AGMessage ' + os.hostname(), seal: secretbox.seal, open: secretbox.open, renew: true });
      front.setCert({ certPem: cert.certPem, keyPem: cert.keyPem });
      if (discovery) discovery.tls = cert.fp;
      noteEvent('the admin renewed this AGMessage\'s certificate');
      ok(ack)({ ok: true, tls: tlsFacts() });
    } catch (e) { ok(ack)({ ok: false, error: e.message }); }
  });
  socket.on('admin:tunnelStart', (ack) => { if (admin(ack)) ok(ack)(startTunnel()); });
  socket.on('admin:tunnelStop', (ack) => { if (admin(ack)) { stopTunnel(); ok(ack)({ ok: true }); } });
  socket.on('admin:tunnelStatus', (ack) => { if (admin(ack)) ok(ack)({ ok: true, running: !!tunnelProc, url: tunnelUrl, error: tunnelError }); });

  function leaveRoom(now) {
    if (!room || !me || socket.data.adminView) return;
    const r = room, u = me;
    r.users.delete(socket.id);
    io.to(r.code).emit('users', roomUserSummary(r));
    boardDirty();
    const still = Array.from(r.users.values()).some((x) => x.uid === u.uid);
    if (still) return;
    trackLeave(u.uid, r.code);
    const k = r.code + '|' + u.uid;
    const announce = () => { pendingLeaves.delete(k); if (store.has(r.code) && !Array.from(r.users.values()).some((x) => x.uid === u.uid)) systemMessage(r, `${u.name} left`); };
    if (now) announce();
    else { if (pendingLeaves.has(k)) clearTimeout(pendingLeaves.get(k)); pendingLeaves.set(k, setTimeout(announce, LEAVE_GRACE_MS)); }
  }

  socket.on('disconnect', () => {
    boardSockets.delete(socket);
    if (uploadToken) uploadTokens.delete(uploadToken);
    leaveRoom(false);
  });
});

function seenFor(room) { return room.seen ? Array.from(room.seen.values()) : []; }

/** A link as the AI's brief reads it, with the linked Patterns and PlayMap nodes' own words. */
const briefOf = (link) => ({ status: link.status, view: link.view, context: link.context, linked: Array.from(peerLinks.values()).map((l) => l.view()) });

// ---------------------------------------------------------------- displays
/** Everything a display's page needs: what to show (numbered), the hall's holding image and countdown, the server's time. */
function displayState(d) {
  return {
    id: d.id, name: d.name, hall: d.hall, hallName: (store.get(d.hall) || {}).name || '', seq: d.seq, content: d.content,
    holding: displays.hallHolding(d.hall), stage: stagePayload(linkFor(d.hall)), now: Date.now(),
  };
}
/** A display's browser connects with its token: it is told what to show, and it says what it showed. */
function serveDisplay(socket, token) {
  const d = displays.byToken(token);
  if (!d) { socket.emit('display:unknown', { words: 'This screen link is not (or no longer) in use. Ask for the current link.' }); setTimeout(() => socket.disconnect(true), 100); return; }
  socket.data.display = d.id;
  socket.join('display:' + d.id);
  d.live.sockets++;
  const reports = new guard.Bucket(4, 10);
  socket.emit('display:state', displayState(d));
  displaysChanged(d.hall);
  socket.on('display:shown', ({ seq, ok, words } = {}) => {
    const cur = displays.get(d.id);
    if (!cur || !reports.take()) return;
    if (displays.shown(cur, seq, ok, words)) displaysChanged(cur.hall);
  });
  socket.on('disconnect', () => {
    const cur = displays.get(d.id);
    if (!cur) return;
    cur.live.sockets = Math.max(0, cur.live.sockets - 1);
    displaysChanged(cur.hall);
  });
}
function revokeDisplaySockets(id, words) {
  for (const s of io.sockets.sockets.values()) if (s.data && s.data.display === id) { s.emit('display:unknown', { words }); setTimeout(() => s.disconnect(true), 100); }
}
/** A hall's screens changed: its operators re-read them, the board redraws. */
function displaysChanged(code) { io.to(code).emit('displays:changed', { code }); boardDirty(); }
/** A Stagewatch's frame moved: the displays of every hall that follows it get the frame. */
function stageChanged(link) {
  const payload = stagePayload(link);
  for (const r of roomsUsing(link)) for (const d of displays.ofHall(r.code)) if (d.live.sockets) io.to('display:' + d.id).emit('display:stage', payload);
}
const displaysOf = (code) => displays.ofHall(code).map((d) => { const st = Displays.status(d); return { id: st.id, name: st.name, state: st.state, mark: st.mark, words: st.words + ' — ' + st.showing }; });

// ---------------------------------------------------------------- the halls board
// Each watcher gets the halls it may see, recomputed when anything on them changes and sent at most every 300 ms
// (latest wins: a slow phone gets the newest board, never a backlog). A hall's row is built once per tick for every
// watcher (`shared`); what differs per watcher — which halls, which links, whether it may answer — is added on top.
const boardSockets = new Set();
let boardIsDirty = false;
function boardDirty() { boardIsDirty = true; }
function hallParts(r, shared) {
  let p = shared.get(r.code);
  if (!p) { p = { row: board.hallRow(r, { stage: stagePayload(linkFor(r.code)), displays: displaysOf(r.code) }), help: board.openHelp(r) }; shared.set(r.code, p); }
  return p;
}
function boardFor(socket, shared = new Map()) {
  const a = socket.data.account;
  const sees = (code) => socket.data.isAdmin || (a && rbac.seesHall(a, code));
  const rooms = Array.from(store.rooms.values()).filter((r) => sees(r.code));
  const nodeChip = (l) => { const v = l.view(); return { id: v.id, t: v.t, name: v.name, hall: v.hall, status: v.status, light: v.light, headline: v.headline }; };
  const links = Array.from(peerLinks.values()).filter((l) => (l.hall ? sees(l.hall) : (socket.data.isAdmin || (a && rbac.can(a, 'nodes.control')))));
  return {
    nodes: links.map(nodeChip),
    halls: rooms.map((r) => ({ ...hallParts(r, shared).row, nodes: links.filter((l) => l.hall === r.code).map(nodeChip) })),
    help: rooms.flatMap((r) => hallParts(r, shared).help.map((h) => ({ ...h, canRespond: !!(socket.data.isAdmin || (a && rbac.can(a, 'hall.post', r.code))) }))),
  };
}
setInterval(() => {
  if (!boardIsDirty) return;
  boardIsDirty = false;
  const shared = new Map();
  for (const s of boardSockets) s.emit('board', boardFor(s, shared));
}, 300).unref();
/** Open help requests across every hall, for the context (a count: never who or what). */
const openHelpCount = () => Array.from(store.rooms.values()).reduce((n, r) => n + board.openHelp(r).length, 0);

/**
 * An account changed (role, rights, halls, password, turned off, removed): every socket it has open is told and closed,
 * so its next connection is judged by the rights it has now — never by the ones it had.
 */
function accountChanged(id, what) {
  for (const [, s] of io.sockets.sockets) {
    if (s.data && s.data.accountId === id) {
      s.emit('account:changed', { what, words: 'Your account was changed by an admin — reconnecting with your current rights.' });
      setTimeout(() => s.disconnect(true), 50);
    }
  }
}

function invitesFor(code) {
  const out = {};
  for (const role of ['board', 'research']) out[role] = `/?code=${code}&role=${role}&invite=${guard.makeInvite(SECRET, code, role)}`;
  return out;
}

function buildMessage(user, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const base = { id: makeMessageId(), at: Date.now(), from: { uid: user.uid, name: user.name, role: user.role, ...(user.acct ? { acct: true } : {}) }, pinned: false, priority: !!payload.priority };
  if (payload.type === 'text') {
    const text = guard.str(payload.text).trim();
    return text ? { ...base, type: 'text', text: text.slice(0, 4000), ...(payload.aiDraft ? { aiDraft: true } : {}) } : null;
  }
  if (payload.type === 'file') {
    if (!guard.validUploadUrl(payload.url)) return null;
    const t = guard.UPLOAD_TYPES[guard.extOf(payload.url)];
    if (!t || !fs.existsSync(path.join(UPLOAD_DIR, payload.url.slice(9)))) return null;
    return {
      ...base, type: 'file', url: payload.url,
      filename: guard.cleanText(payload.filename, 120) || 'file',
      mime: t.mime.split(';')[0],
      caption: guard.str(payload.caption).slice(0, 500),
    };
  }
  if (payload.type === 'help') return board.helpMessage(base, payload, guard.cleanText);
  if (payload.type === 'action') {
    const text = guard.str(payload.text).trim();
    let options = Array.isArray(payload.options) ? payload.options.map((o) => guard.str(o).trim().slice(0, 40)).filter(Boolean).slice(0, 6) : [];
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
    else if (m.type === 'help') content = '<p><strong>Help — ' + esc(m.category) + ':</strong> ' + esc(m.text || '') + '</p>' +
      (m.help ? '<p class="responses">' + esc(m.help.state === 'open' ? 'open' : (m.help.state === 'coming' ? 'on the way' : 'resolved') + (m.help.by ? ' — ' + m.help.by : '') + (m.help.at ? ', ' + fmt(m.help.at) : '')) + '</p>' : '');
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

// ---------------------------------------------------------------- show network (Show Bus 1.1)
// One Stagewatch per hall at a venue with several: each hall may link its own (hall settings), and the default one
// (Admin → Show network) serves every hall without one. Each is a StagewatchLink of its own, with its own liveness,
// clock, pin and desk; a hall's countdown, sends and proposals go to its link and nowhere else.
const hallLinks = new Map();   // hall code -> StagewatchLink
function makeLink(id) {
  const link = new nodes.StagewatchLink({
    onState: (view) => onStageState(link, view),
    onStatus: (status) => noteEvent('Stagewatch link' + (id === 'default' ? '' : ' of a hall') + ' ' + (/^CERTIFICATE CHANGED/.test(status) ? 'refused: CERTIFICATE CHANGED' : status)),
    findPeer: (t, host, port) => (discovery ? discovery.find(t, host, port) : null),
    pins,
    onPins: () => { settings.tlsPins = pins.toJSON(); saveSettings(); },
  });
  link.id = id;
  return link;
}
const stageLink = makeLink('default');
/** The Stagewatch a hall follows: its own, else the default. */
const linkFor = (code) => hallLinks.get(code) || stageLink;
const allLinks = () => [stageLink, ...hallLinks.values()];
const roomsUsing = (link) => Array.from(store.rooms.values()).filter((r) => linkFor(r.code) === link);
/** What a page shows of a link: the frame (or nothing yet), its state and whether it keeps a show desk. */
function stagePayload(link) {
  if (!link.base) return null;
  return link.view ? { ...link.view, status: link.status, desk: link.desk } : { status: link.status, desk: link.desk };
}
function onStageState(link, view) {
  const payload = stagePayload(link) || { status: 'off', desk: false };
  for (const r of roomsUsing(link)) io.to(r.code).emit('stage', payload);
  followStageAck(link, view);
  stageChanged(link);
  boardDirty();
}
/**
 * A hall's own Stagewatch, from the server's settings (settings.json → hallStagewatch[code], key sealed at rest) — never
 * from the room's own settings, whose changes travel to every client in the room's log. None: the default.
 */
const hallStagewatch = (code) => (settings.hallStagewatch && typeof settings.hallStagewatch === 'object' ? settings.hallStagewatch[code] : null) || null;
function configureHallLink(room) {
  const sw = hallStagewatch(room.code);
  const url = sw && typeof sw.url === 'string' ? nodes.normaliseBase(sw.url) : '';
  let link = hallLinks.get(room.code);
  if (!url) {
    if (link) { link.stop(); hallLinks.delete(room.code); }
    return null;
  }
  if (!link) { link = makeLink('hall:' + room.code); hallLinks.set(room.code, link); }
  link.configure(url, secretbox.open(sw.keySealed) || '', sw.fp || '');
  return link;
}
let discovery = null;
if (process.env.AGM_NODES !== '0') {
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  discovery = new nodes.Discovery({ id: settings.nodeId, port: PORT, name: 'AGMessage', build: BUILD.full, announce: !loopbackOnly, tls: cert ? cert.fp : '', onChange: () => {
    for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.emit('nodes', discovery.list());
  } });
  try { discovery.start(); } catch (e) { console.warn('  [nodes] discovery off:', e.message); }
}
stageLink.configure(settings.stagewatchUrl || '', stagewatchKey(), settings.stagewatchFingerprint || '');
for (const room of store.rooms.values()) configureHallLink(room);

// ---------------------------------------------------------------- Patterns and PlayMap (lib/peerlinks.js)
// Linked by the admin (the node's own token, sealed in settings.json → peerLinks), each read every 5 s and driven only
// by the verbs it lists. A link may belong to a hall, so the hall's board row and its crew see it.
const peerLinks = new Map();   // node id -> PeerLink
function startPeerLink(id, cfg) {
  const old = peerLinks.get(id);
  if (old) old.stop();
  if (!cfg) { peerLinks.delete(id); return null; }
  const link = new peerlinks.PeerLink({
    node: { t: cfg.t, id, name: cfg.name || cfg.t }, base: cfg.url, token: secretbox.open(cfg.tokenSealed) || '', hall: cfg.hall || '',
    pins, onPins: () => { settings.tlsPins = pins.toJSON(); saveSettings(); },
    findPeer: (nid) => (discovery ? discovery.peers.get(nid) || null : null),
    onChange: () => { boardDirty(); nodesChanged(); },
  });
  peerLinks.set(id, link);
  return link;
}
for (const [id, cfg] of Object.entries(settings.peerLinks && typeof settings.peerLinks === 'object' ? settings.peerLinks : {})) {
  if (cfg && peerlinks.KINDS.has(cfg.t) && typeof cfg.url === 'string') startPeerLink(id, cfg);
}
/** Someone watching the show network (the board, the admin page) should read it again. */
function nodesChanged() { for (const s of io.sockets.sockets.values()) if (s.data && (s.data.isAdmin || boardSockets.has(s))) s.emit('nodes:changed', {}); }
/** May this socket drive a linked node? nodes.control in the node's hall, or in any hall for one with none. */
const mayDriveNode = (socket, link) => socket.data.isAdmin || !!(socket.data.account && rbac.can(socket.data.account, 'nodes.control', link.hall || undefined));

// Stage sends waiting for the speaker: "<link>:<Stagewatch message id>" -> the AGMessage messages that show its state.
// (A Stagewatch numbers its own messages, so two halls' Stagewatches can both send message 12.)
const stageSends = new Map();
function trackStageSend(link, ref, code, ids) {
  stageSends.set(link.id + ':' + ref, { code, ids, ack: 'sent', by: '' });
  if (stageSends.size > 200) stageSends.delete(stageSends.keys().next().value);
}
/** The live frame says who acknowledged which message: show it on the message that was sent. */
function followStageAck(link, view) {
  const key = view && view.messageId ? link.id + ':' + view.messageId : '';
  if (!key || !stageSends.has(key)) return;
  const t = stageSends.get(key);
  const ack = view.messageAck || 'sent';
  if (ack === t.ack && (view.messageAckBy || '') === t.by) return;
  t.ack = ack; t.by = view.messageAckBy || '';
  const room = store.get(t.code);
  if (!room) return;
  for (const id of t.ids) {
    const m = room.byId.get(id);
    if (m && m.stage) apply(room, { o: 'upd', id, f: { stage: { ...m.stage, ack, by: t.by } } });
  }
  if (ack === 'seen' || ack === 'done') noteEvent('the speaker ' + (ack === 'done' ? 'acknowledged' : 'saw') + ' a stage message');
}

// ---------------------------------------------------------------- the show desk (Show Bus 1.2 §11)
// Proposals this AGMessage made, followed until they end: desk id -> the messages that show their state.
const FINAL = new Set(['rejected', 'done', 'failed', 'undelivered']);
// Keyed "<link>:<desk id>": each Stagewatch numbers its own proposals.
const proposals = new Map();
function trackProposal(linkId, id, code, ids, state) {
  if (FINAL.has(state)) return;
  proposals.set(linkId + ':' + id, { link: linkId, id, code, ids, state });
  if (proposals.size > 200) proposals.delete(proposals.keys().next().value);
}
// After a restart, keep following the ones still open (their state, and the link they went to, live on the messages).
for (const room of store.rooms.values()) {
  for (const m of room.messages) if (m.proposal && m.proposal.id && !FINAL.has(m.proposal.state)) {
    const linkId = m.proposal.link || 'default';
    const t = proposals.get(linkId + ':' + m.proposal.id);
    if (t) t.ids.push(m.id); else trackProposal(linkId, m.proposal.id, room.code, [m.id], m.proposal.state);
  }
}
function showProposalState(t, p) {
  const room = store.get(t.code);
  if (!room) return;
  for (const id of t.ids) {
    const m = room.byId.get(id);
    if (m && m.proposal) apply(room, { o: 'upd', id, f: { proposal: { ...m.proposal, state: p.state, words: p.words || '', by: p.decidedBy || '' } } });
  }
}
// Approved proposals aimed at this AGMessage, already run (so a slow result post never runs one twice).
const ranProposals = new Map();   // id -> {ok, words, reported}

/**
 * What AGMessage does when the show desk approves a proposal aimed at it. One verb: "notice <text>" — a notice shown
 * to everyone in every open meeting (e.g. "Break in 5 minutes"). Its own checks apply: length, and nothing to post
 * into when no meeting is open. Returns {ok, words}.
 */
function runApproved(p) {
  const m = /^notice\s+(.+)$/i.exec(guard.str(p.line).trim());
  if (!m) return { ok: false, words: 'AGMessage only takes "notice <text>" — not "' + guard.str(p.line).slice(0, 60) + '"' };
  const text = m[1].replace(/^"(.*)"$/, '$1').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return { ok: false, words: 'an empty notice' };
  const rooms = Array.from(store.rooms.values());
  if (!rooms.length) return { ok: false, words: 'no meeting is open to show it in' };
  for (const room of rooms) systemMessage(room, '📣 From the show desk' + (p.decidedBy ? ' (approved by ' + p.decidedBy + ')' : '') + ': ' + text);
  noteEvent('the show desk posted a notice to the meetings');
  return { ok: true, words: 'shown in ' + rooms.length + ' meeting' + (rooms.length === 1 ? '' : 's') };
}

// Every linked Stagewatch that keeps a desk, one after another (one request at a time to each): our proposals' states,
// and what each desk approved for this AGMessage — run once, whichever desk it came from, and reported.
let deskBusy = false;
setInterval(async () => {
  if (deskBusy) return;
  deskBusy = true;
  try {
    for (const link of allLinks()) {
      if (!link.linked) continue;
      if (Date.now() - link.deskCheckedAt > 60_000) {
        const was = link.desk;
        await link.checkDesk(settings.nodeId);
        if (was !== link.desk) onStageState(link, link.view);
      }
      if (!link.desk) continue;
      for (const [key, t] of Array.from(proposals)) {
        if (t.link !== link.id) continue;
        const p = await link.proposal(t.id);
        if (!p) continue;
        if (p.state !== t.state) { t.state = p.state; showProposalState(t, p); }
        if (FINAL.has(p.state)) proposals.delete(key);
      }
      for (const p of await link.approvedFor(settings.nodeId)) {
        const key = link.id + ':' + p.id;
        let r = ranProposals.get(key);
        if (!r) { r = runApproved(p); ranProposals.set(key, r); if (ranProposals.size > 200) ranProposals.delete(ranProposals.keys().next().value); }
        if (!r.reported) r.reported = await link.reportResult(p.id, r.ok, r.words);
      }
    }
  } catch { /* the next tick tries again */ } finally { deskBusy = false; }
}, 3000).unref();

/** This node's context (Show Bus §6): facts, counts and prompt titles — no message text, no names. */
function currentContext() {
  return buildContext({
    node: { id: settings.nodeId, name: 'AGMessage' },
    rooms: Array.from(store.rooms.values()),
    stage: { status: stageLink.status, view: stageLink.view, clock: stageLink.clockInfo(), context: stageLink.context },
    halls: Array.from(hallLinks.values()).map((l) => ({ status: l.status, view: l.view, clock: l.clockInfo(), context: l.context })),
    help: openHelpCount(),
    peerContexts: Object.fromEntries(Array.from(peerLinks.values()).filter((l) => l.status === 'live' && l.context).map((l) => [l.node.id, { light: l.context.light, headline: l.context.headline }])),
    peers: discovery ? discovery.list() : [],
    aiOn: !!aiKey(), tunnel: !!tunnelProc, recent: recentEvents,
  });
}
// Post it to Stagewatch when linked: on change, and at least every 5 s. Refresh Stagewatch's own every 5 s.
let lastPushed = '';
let lastPushAt = 0;
setInterval(() => {
  const linked = allLinks().filter((l) => l.linked);
  if (!linked.length) return;
  const ctx = currentContext();
  const sig = JSON.stringify({ ...ctx, at: 0 });
  const due = sig !== lastPushed || Date.now() - lastPushAt >= 5000;
  if (due) { lastPushed = sig; lastPushAt = Date.now(); }
  for (const link of linked) {
    if (due) link.pushContext(ctx).catch(() => {});
    if (Date.now() - link.contextAt >= 5000) link.fetchContext().catch(() => {});
  }
}, 1000).unref();

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
  flushLanes();
  for (const link of allLinks()) link.stop();
  for (const link of peerLinks.values()) link.stop();
  if (discovery) discovery.stop();
  releaseDataFolder();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// An uncaught error leaves Node in an unknown state, so it doesn't carry on: save the rooms, record the crash
// (shown on the admin page after the restart) and exit for the watchdog (supervise.js) to restart within ~2 s.
// A rejected promise nobody handled is logged and counted (admin health): the request it belonged to failed,
// the meeting carries on.
process.on('uncaughtException', (e) => {
  console.error('  [error]', e && e.stack ? e.stack : e);
  try { store.compactAll(); } catch { /* best effort */ }
  try { flushLanes(); } catch { /* best effort: a lane that cannot write has said so on the console */ }
  try {
    resilience.writeFileAtomic(CRASH_PATH, JSON.stringify({ at: Date.now(), message: String(e && e.message ? e.message : e).slice(0, 500), stack: String(e && e.stack ? e.stack : '').slice(0, 4000) }));
    fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), new Date().toISOString() + ' ' + String(e && e.stack ? e.stack : e) + '\n');
  } catch { /* the console has it */ }
  releaseDataFolder();
  process.exit(resilience.EXIT.CRASH);
});
process.on('unhandledRejection', (e) => { rejections++; console.error('  [error] unhandled rejection:', e && e.message ? e.message : e); });

// The watchdog's heartbeat: sent from the event loop, so a hung loop stops it (that silence is what restarts us).
if (typeof process.send === 'function') setInterval(() => { try { process.send({ t: 'beat' }); } catch { /* supervisor gone */ } }, 1000).unref();

front.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n  Port ${PORT} is already in use. Close the other AGMessage window, or set PORT to another number.\n` : '  Server error: ' + e.message);
  releaseDataFolder();
  process.exit(resilience.EXIT.CONFIG);   // the watchdog won't restart this one
});

// ---------------------------------------------------------------- one server per data folder
// Two copies on one folder would each number the same rooms' ops, chain the same audit log and save the same accounts.
// The folder is held by a local socket named after it — a named pipe on Windows, gone with the process; a Unix socket
// elsewhere, a leftover of a killed process known by nobody answering it — and a second copy that finds it held stops
// (code 3, which the watchdog does not restart) before it has written anything.
let folderHold = null;
function holdDataFolder(then) {
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(DATA_DIR).toLowerCase() : path.resolve(DATA_DIR)).digest('hex').slice(0, 16);
  const where = process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + id : path.join(os.tmpdir(), 'agmessage-' + id + '.sock');
  let started = false;
  const go = () => { if (!started) { started = true; then(); } };
  const refuse = () => {
    console.error('\n  AGMessage is already running on this data folder (' + DATA_DIR + '). Use that window, or give this copy a folder of its own.\n');
    process.exit(resilience.EXIT.CONFIG);
  };
  const unchecked = (e) => { console.warn('  [folder] could not hold the data folder (' + (e.code || e.message) + '): a second copy on it is not refused'); folderHold = null; go(); };
  const hold = net.createServer((c) => { c.on('error', () => { /* a second copy that asked and went: nothing to answer */ }); c.end(); });
  hold.unref();
  folderHold = hold;
  hold.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') return unchecked(e);
    if (process.platform === 'win32') return refuse();
    const probe = net.connect(where);
    probe.once('connect', () => { probe.destroy(); refuse(); });
    probe.once('error', () => {
      hold.once('error', unchecked);
      fs.unlink(where, () => { hold.listen(where, go); });
    });
  });
  hold.listen(where, go);
}
/** Let go of the data folder (a clean stop): the next start finds it free at once. */
function releaseDataFolder() { if (folderHold) { try { folderHold.close(); } catch { /* the process is ending: the OS frees it */ } folderHold = null; } }

holdDataFolder(() => front.listen(PORT, HOST, () => {
  // This copy holds the folder and the port: now it writes. Each replayed log is folded into a fresh snapshot (a torn last
  // line cut before anything is appended after it), each hall says it was restored, and the audit log is opened.
  store.compactAll();
  for (const room of store.rooms.values()) {
    store.commit(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text: '— Session restored (' + room.messages.length + ' messages preserved) —', at: Date.now() } });
  }
  audit.open();
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) addresses.push(n.address);
  console.log('\n  AGMessage ' + BUILD.full + ' is running');
  console.log('  ---------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const a of addresses) console.log(`  LAN:     http://${a}:${PORT}` + (cert ? `   (or https://${a}:${PORT})` : ''));
  if (cert) console.log('  HTTPS:   on, same port — certificate ' + cert.fp.slice(0, 23) + '…  (trust it once per device: /tls)' + (settings.requireHttps ? ' · required from other devices' : ''));
  console.log('');
  console.log('  ============================================');
  console.log('  Admin login (only from this host laptop):');
  console.log('    URL:   http://localhost:' + PORT + '/admin');
  console.log('    Token: ' + ADMIN_TOKEN);
  console.log('  ============================================');
  console.log('  AI drafts:   ' + (aiKey() ? 'on (' + ai.MODEL + ')' : 'off — add a key in Admin → AI (messaging and the show network work without it)'));
  if (RESTARTS) console.log('  Restarted by the watchdog (' + RESTARTS + 'x)' + (lastCrash ? ' — last crash: ' + String(lastCrash.message || '').slice(0, 120) : ''));
  console.log('  Stagewatch:  ' + (settings.stagewatchUrl || 'not linked (Admin → Show network)'));
  console.log('  Saved rooms: ' + ROOMS_DIR);
  console.log('  Uploads:     ' + UPLOAD_DIR + '\n');
}));

module.exports = { app, server, io, store, buildMessage };
