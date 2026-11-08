'use strict';
// Shared by the end-to-end tests: a real server in a child process on a free port with a throwaway data folder, key
// folder and upload folder (never the tree's), and a Socket.io client that carries a cookie.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { io } = require('socket.io-client');
const { BUILD } = require('../lib/version');
const guard = require('../lib/guard');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'testadmintoken01';

// The runtime half of the fence on a hall's snapshot (test/snapshot-preload.js): loaded into every server started here
// whose test names no preloads of its own (NODE_OPTIONS), and read by stopServer.
const SNAPSHOT_PRELOAD = '--require "' + path.join(__dirname, 'snapshot-preload.js').split(path.sep).join('/') + '"';

/** The repository's root, the folder above app. */
const REPO = path.join(ROOT, '..');
/**
 * A file of the checkout as text with LF line ends, whatever the checkout's (a Windows one has CR LF): `file` absolute,
 * or relative to the repository's root. Every test reads the checkout's text through it (agm/test-helpers).
 */
const readSource = (file) => fs.readFileSync(path.resolve(REPO, file), 'utf8').replace(/\r\n/g, '\n');

/** A TCP port free on loopback now. A UDP port comes from freeUdpPort: Windows keeps excluded port ranges for each protocol. */
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
/** A UDP port free on loopback now, one a UDP socket was given (a free TCP port may lie in a range Windows keeps from UDP). */
const freeUdpPort = () => new Promise((resolve, reject) => {
  const u = require('dgram').createSocket('udp4');
  u.once('error', reject);
  u.bind(0, '127.0.0.1', () => { const { port } = u.address(); u.close(() => resolve(port)); });
});
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Start a server; resolves {child, base, port, dataDir, out()} once it says it is running and has printed its banner,
 * whose last line is its uploads folder: a test that reads the black window reads the whole banner, never a part of it.
 */
async function startServer(env = {}) {
  // A port freePort() found can be taken by another test file before the server listens on it: a server that stops
  // because its port is in use is started again on another, at most four times. A port the test named is never changed.
  for (let attempt = 1; ; attempt++) {
    try { return await startOnce(env); } catch (e) {
      if (env.PORT || attempt >= 5 || !(e && e.portTaken)) throw e;
    }
  }
}
async function startOnce(env) {
  const dataDir = env.AGM_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const fence = dataDir + '-snapshots.txt';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', AGM_UPLOAD_DIR: dataDir + '-uploads', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, SNAPSHOT_PRELOAD].filter(Boolean).join(' '), AGM_TEST_SNAPSHOTS: fence, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.snapshotFence = env.AGM_TEST_SNAPSHOTS || fence;
  if (child.channel) child.channel.unref();   // the channel carries the stop; it keeps no test run alive
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    if (out.includes('is running') && out.includes('\n  Uploads:')) return { child, port, base: `http://127.0.0.1:${port}`, dataDir, out: () => out };
    if (child.exitCode !== null && PORT_TAKEN.test(out)) break;   // stopped at once: its port was taken meanwhile
    await wait(100);
  }
  child.kill();
  const e = new Error('server did not start:\n' + out);
  e.portTaken = child.exitCode !== null && PORT_TAKEN.test(out);
  throw e;
}
/** The words a server says when its port is held by something else (lib/startup.js and 0.5's own). */
const PORT_TAKEN = /already in use|is using port|already running on port/i;
/**
 * Stop a server as the watchdog does: asked over IPC, so it saves first on every platform (on Windows a signal sent to a
 * child ends it at once, unsaved). One that has not gone in 3 s is ended. Rejects when the runtime half of the snapshot
 * fence (test/snapshot-preload.js) found a hall changed beside the store, which a stop leaves unwritten.
 */
const stopServer = (child) => new Promise((resolve, reject) => {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    let found = '';
    if (child.snapshotFence) {
      try { found = fs.readFileSync(child.snapshotFence, 'utf8'); fs.rmSync(child.snapshotFence, { force: true }); } catch (e) {
        if (e.code !== 'ENOENT') { reject(e); return; }   // ENOENT: the fence found nothing
      }
    }
    if (found.trim()) reject(new Error('a hall changed beside the store (an op, or markDirty: lib/store.js SNAPSHOT_FIELDS), so a stop left it unwritten: ' + found.trim().split('\n').join(', ')));
    else resolve();
  };
  if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
  child.once('exit', done);
  // Asked over IPC only while the channel is open, and a send the channel refuses (the server gone before its exit is
  // read, as after a kill) is answered here: a send with no callback says it as an 'error' event nobody hears.
  const end = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
  if (child.connected) {
    try { child.send({ t: 'stop' }, (e) => { if (e) end(); }); } catch { end(); }
  } else end();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(); }, 3000);
});

/** The first admin account, made at the laptop with its token typed (the only way one is made): api's answer. */
const setupAdmin = (base, body = {}) => api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle', ...body });

/** fetch with JSON in and out; returns {status, body, cookie, headers}. */
async function api(base, method, url, body, { cookie, headers = {} } = {}) {
  const r = await fetch(base + url, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  let json;
  try { json = await r.json(); } catch { json = null; }   // a non-JSON answer (a page): the status says enough
  return { status: r.status, body: json, cookie: set ? set.split(';')[0] : '', headers: r.headers };
}

/**
 * A page's socket: it names the build that served it as this checkout's pages do (public/reconnect.js auth), unless
 * `build` says otherwise; `build: null` is a 0.5.1 page, which names none. `on` ({event: fn}) is heard from the first
 * packet, as a page's listeners are: one added once this resolves misses what the server sends with the connection.
 */
const connect = (base, cookie, { build = BUILD.full, on = {}, headers = {} } = {}) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { ...headers, ...(cookie ? { cookie } : {}) }, auth: build === null ? {} : { build } });
  for (const [event, fn] of Object.entries(on)) s.on(event, fn);
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const emit = (s, ev, arg) => new Promise((resolve) => { s.emit(ev, arg, resolve); });

/**
 * A whole PNG of `width` × `height` black pixels (8-bit RGB): its signature, IHDR, one IDAT and IEND, each chunk with its
 * CRC-32. An upload reads a picture's size from its header before it keeps it (lib/imagesize.js), so a test's picture
 * is a whole one.
 */
function pngOf(width = 1, height = 1) {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
/** An emit whose answer must come within `ms`: a handler that never answers fails the test instead of hanging it. */
const answer = (s, ev, arg, ms = 3000) => Promise.race([emit(s, ev, arg), new Promise((resolve, reject) => { setTimeout(() => reject(new Error('no answer to ' + ev + ' within ' + ms + ' ms')), ms).unref(); })]);
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('no ' + ev + ' within ' + ms + ' ms')), ms); s.once(ev, (v) => { clearTimeout(t); resolve(v); }); });

/**
 * A /ws request's query as Stagewatch reads it (WebServer.cs HttpRequest.ReadAsync): keys case-insensitive, the last
 * value of a repeated key wins, '+' is a space.
 */
function stagewatchQuery(target) {
  const q = new Map();
  const i = target.indexOf('?');
  for (const pair of i < 0 ? [] : target.slice(i + 1).split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const un = (v) => { try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; } };
    q.set(un(eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase(), eq >= 0 ? un(pair.slice(eq + 1)) : '');
  }
  return q;
}
/** The id Stagewatch keys a /ws socket by in its Screens (HandleWebSocketAsync, Screens.ValidId): cid, or an anonymous one. */
function screenIdOf(target) {
  const cid = stagewatchQuery(target).get('cid');
  return typeof cid === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(cid) ? cid : 'anon-' + require('crypto').randomBytes(4).toString('hex');
}

/**
 * A fake Stagewatch on a free port: /ws sends a state frame on connect (frame(obj) sends another); /api/message/… answers
 * a receipt; the show desk (/api/proposals: create, read one, list by target and state, result) keeps its queue in
 * `proposals`; /api/context answers a context named `name` whose `items` a test may change (each department as
 * Stagewatch lists a target by its newest cue: kind "department" while that is a standby). Every request is kept in
 * `requests` (method, url, headers, body) so a test can say what reached which Stagewatch.
 *
 * How it judges a key, as Stagewatch does (WebServer.cs Authorize, HandleWebSocketAsync):
 *  key            null accepts every request; else only `Bearer <key>`, and any other gets 401 {"ok":false,"error":"unknown
 *                 or revoked API key"}. The /ws upgrade is taken whatever the key (2.16 says nothing of it on the socket).
 *  auth18         2.18: the first /ws message is {"type":"auth","ok":<accepted>,"node":<?node=>,"words":…}; a refused socket
 *                 gets no frames (closed too with closeOnRefuse). authDelayMs: how long it takes to say it.
 *  viewCode       2.16 with a viewing code: a socket without an accepted key gets {"type":"auth","ok":false,"view":true,
 *                 "error":…} and is closed (1008).
 *  contextDelayMs / contextFail  /api/context answers late, or 404 "no context" (its first second) the first n times.
 *  cert           serve HTTPS and WSS with this certificate (tls.makeCertificate).
 *  counts         {upgrades, failures}: failures as its lockout counts them (a wrong key's upgrade, its viewing-code check, each 401).
 *
 * Its desk answers a result as ProposalDesk.Result does: 409 for an unknown id or one not waiting for a result (approved,
 * or undelivered once claimed — a late result is still taken). `answerResults` is a queue of {status, error, retryAfter}
 * answered to result posts first (status 0: the socket cut with no answer); holdAll(ms) answers every route 429 with
 * Retry-After for that long, as its per-key budget does; expire(id) is its five minutes without a result.
 * `answerDeskChecks` and `answerContext` are such queues for GET /api/proposals?from= (whether it keeps a desk) and GET
 * /api/context; onRequest(request) and onResultPost(id) are called as one arrives, before it is answered; `firstFrameDelayMs`
 * holds a new socket's first message (and so the link's key read) that long; `messageDelayMs` holds a send
 * that long before its key is judged (a request made under one key, answered after the key changed); `proposalDelayMs`
 * holds a new proposal's answer that long (a page that moves on while the desk has not answered).
 */
async function fakeStagewatch({ name = 'Fake Stagewatch', desk = true, messageId = 77, departments = [], failResults = 0, key = null, auth18 = false, authDelayMs = 0, closeOnRefuse = false, viewCode = false, contextDelayMs = 0, contextFail = 0, cert = null, answerDeskChecks = [], answerContext = [], messageDelayMs = 0, firstFrameDelayMs = 0, collectDelayMs = 0, collectRefusal = null, scope = 'node', proposalDelayMs = 0 } = {}) {
  const http = require('http');
  const https = require('https');
  const { WebSocketServer } = require('ws');
  const tlsmod = require('../lib/tls');
  const counts = { upgrades: 0, failures: 0 };
  const failureTimes = [];   // when each failure its lockout would count came
  const fail = () => { counts.failures++; failureTimes.push(Date.now()); };
  let answerResults = [];
  let heldUntil = 0;
  let onResultPost = null;
  let onRequest = null;
  const accepts = (h) => key === null || h === 'Bearer ' + key;
  const requests = [];
  const proposals = new Map();
  let next = 0;
  const sockets = new Set();
  const upgrades = [];   // every /ws request: its URL and headers, in the order they came
  // As SharedProposal.ToJson (Stagewatch src/Timer.Core/Approvals.cs:20-32): result and words the same string, ok true when
  // done, false when failed or undelivered, null until it ran. `served` stands for a desk that is not Stagewatch.
  const OUTCOME = { done: true, failed: false, undelivered: false };
  const node = (r) => ({ t: (r && r.t) || '', id: (r && r.id) || '', name: (r && r.name) || '' });
  const toJson = (p) => ({
    id: p.id, from: node(p.from), target: node(p.target), line: p.line || '', reason: p.reason || '', risk: p.risk || 'high', state: p.state,
    created: p.created, decided: p.decided ?? null, decidedBy: p.decidedBy || '', result: p.words || '',
    ok: Object.hasOwn(OUTCOME, p.state) ? OUTCOME[p.state] : null, words: p.words || '', ...(p.served || {}),
  });
  let items = departments.map((d) => ({ id: 'cue:' + d.toLowerCase(), kind: 'department', label: d, light: 'amber', state: 'standing by' }));
  const handler = (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    const serve = () => {
      const json = (code, o, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
      const queued = (q) => { const a = q.shift(); return json(a.status, { ok: false, error: a.error || 'busy' }, a.retryAfter ? { 'Retry-After': String(a.retryAfter) } : {}); };
      if (!accepts(req.headers.authorization)) { fail(); return json(401, { ok: false, error: 'unknown or revoked API key' }); }
      // A key of another scope reads (every scope may) but is refused, in Stagewatch's words, where the node scope is needed.
      const nodeRoute = req.method !== 'GET' || /[?&]target=/.test(req.url);
      if (scope !== 'node' && nodeRoute) return json(403, { ok: false, error: 'this API key is ' + (scope === 'read' ? 'read only' : scope) });
      if (Date.now() < heldUntil) return json(429, { ok: false, error: 'rate limit: too many requests with this key' }, { 'Retry-After': String(Math.ceil((heldUntil - Date.now()) / 1000)) });
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/api/message/')) return json(200, { type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', refs: { messageId } });
      if (u.pathname === '/api/context' && answerContext.length) return queued(answerContext);
      if (u.pathname === '/api/context') {
        const answer = () => (contextFail > 0 ? (contextFail--, json(404, { ok: false, error: 'no context' }))
          : json(200, { v: 1, node: { t: 'main', id: 'sw' + name.length, name }, light: 'green', headline: name + ' running', items, peers: [] }));
        return contextDelayMs ? void setTimeout(answer, contextDelayMs) : answer();
      }
      if (u.pathname === '/api/peers/context') return json(200, { ok: true });
      if (desk && u.pathname === '/api/proposals' && req.method === 'POST') {
        const j = JSON.parse(body || '{}');
        // As ProposalDesk.Submit stores them (Str): control characters dropped, trimmed, at most 400 characters.
        const kept = (v) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, 400) : '');
        const p = { ...j, line: kept(j.line), reason: kept(j.reason), id: 'p' + (++next), state: 'pending', created: Date.now() };
        proposals.set(p.id, p);
        return json(201, { ok: true, id: p.id, state: p.state, risk: p.risk });
      }
      if (desk && u.pathname === '/api/proposals' && u.searchParams.has('from') && answerDeskChecks.length) return queued(answerDeskChecks);
      if (desk && u.pathname === '/api/proposals') {
        // As Stagewatch's Collect: a target's approved proposals are handed over once (claimed), never listed again; a
        // refused collect is 403 in its words (the key speaks for another node). ProposalsFrom: all a node proposed.
        const target = u.searchParams.get('target');
        const from = u.searchParams.get('from');
        if (target && collectRefusal) return json(collectRefusal.status, { ok: false, error: collectRefusal.error });
        const collect = () => {
          const list = Array.from(proposals.values()).filter((p) => (!target || (p.target && p.target.id === target && !p.claimed)) && (!from || (p.from && p.from.id === from)) && (!u.searchParams.get('state') || p.state === u.searchParams.get('state')));
          if (target) for (const p of list) p.claimed = true;
          return json(200, { proposals: list.map(toJson) });
        };
        return target && collectDelayMs ? void setTimeout(collect, collectDelayMs) : collect();
      }
      const one = /^\/api\/proposals\/(p\d+)(\/result)?$/.exec(u.pathname);
      if (desk && one && one[2] && onResultPost) onResultPost(one[1]);
      if (desk && one && one[2] && answerResults.length) {
        const a = answerResults.shift();
        if (!a.status) { req.socket.destroy(); return undefined; }
        return json(a.status, { ok: false, error: a.error || 'refused' }, a.retryAfter ? { 'Retry-After': String(a.retryAfter) } : {});
      }
      if (desk && one && one[2] && failResults > 0) { failResults--; return json(500, { ok: false, error: 'busy' }); }
      if (desk && one && one[2] && !proposals.has(one[1])) return json(409, { ok: false, error: 'no such proposal' });
      if (desk && one && proposals.has(one[1])) {
        const p = proposals.get(one[1]);
        if (one[2]) {
          if (p.state !== 'approved' && !(p.state === 'undelivered' && p.claimed)) return json(409, { ok: false, error: 'proposal ' + p.id + ' is ' + p.state });
          const r = JSON.parse(body || '{}'); p.state = r.ok ? 'done' : 'failed'; p.words = r.words; return json(200, { ok: true });
        }
        return json(200, toJson(p));
      }
      json(404, { ok: false, error: desk && one ? 'no such proposal' : 'not here' });
    };
    req.on('end', () => {
      requests.push({ at: Date.now(), method: req.method, url: req.url, headers: req.headers, body });
      if (onRequest) onRequest(requests[requests.length - 1]);
      if (messageDelayMs && req.url.startsWith('/api/message/')) setTimeout(serve, messageDelayMs);
      else if (proposalDelayMs && req.method === 'POST' && req.url === '/api/proposals') setTimeout(serve, proposalDelayMs);
      else serve();
    });
  };
  const srv = cert ? https.createServer({ cert: tlsmod.toPem(cert.certDer), key: cert.keyPem }, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  let last = { type: 'state', mode: 'countdown', text: '05:00', title: name, seconds: 300, state: 'running', messageId: 0 };
  wss.on('connection', (c, req) => {
    c.screenId = screenIdOf(req.url);
    upgrades.push({ url: req.url, headers: req.headers });
    counts.upgrades++;
    const good = accepts(req.headers.authorization);
    if (!good && req.headers.authorization) fail();
    c.on('message', (d) => { let m; try { m = JSON.parse(String(d)); } catch { return; } if (m.cmd === 'ping') c.send(JSON.stringify({ type: 'pong', t: m.t, t2: Date.now(), t3: Date.now() })); });
    if (!good && viewCode) {
      fail();   // its viewing-code check asks Authorize again
      c.send(JSON.stringify({ type: 'auth', ok: false, view: true, error: 'This screen needs the viewing code' }));
      c.close(1008, 'viewing code');
      return;
    }
    const start = () => {
      if (c.readyState !== 1) return;
      if (auth18) {
        c.send(JSON.stringify({ type: 'auth', ok: good, node: stagewatchQuery(req.url).get('node') || '', words: good ? '' : 'unknown or revoked API key' }));
        if (!good) { if (closeOnRefuse) c.close(1008, 'key'); return; }
      }
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
      c.send(JSON.stringify(last));
    };
    const delay = authDelayMs + firstFrameDelayMs;
    if (delay) setTimeout(start, delay); else start();
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  const port = srv.address().port;
  return {
    port, url: (cert ? 'https://' : '') + '127.0.0.1:' + port, requests, proposals, upgrades, counts, failureTimes, fp: cert ? tlsmod.fingerprint(cert.certDer) : '',
    /** Sockets open on its /ws, refused ones too until they close. */
    get open() { return wss.clients.size; },
    /** The one key it takes now (null: any): the operator adds, rotates or revokes it. */
    set key(k) { key = k; },
    /** Whether it asks a socket without an accepted key for the viewing code. */
    set viewCode(v) { viewCode = v; },
    /** Its Screens as Stagewatch lists them (WebServer.cs ListScreens): open sockets grouped by id, each with its count of tabs. */
    screens() { const by = new Map(); for (const c of sockets) by.set(c.screenId, (by.get(c.screenId) || 0) + 1); return Array.from(by, ([id, tabs]) => ({ id, tabs })); },
    get connected() { return sockets.size > 0; },
    get items() { return items; },
    set items(v) { items = v; },
    /** What it answers the next result posts, before its desk reads them: [{status, error, retryAfter}] (0: no answer). */
    get answerResults() { return answerResults; },
    set answerResults(v) { answerResults = v; },
    /** The scope of the key it lists: 'node', or 'read' (reads, and is refused 403 on every node route). */
    set scope(v) { scope = v; },
    /** It now presents another certificate (as after a renewal or a reinstall): new connections see it. */
    setCertificate(c) { srv.setSecureContext({ cert: tlsmod.toPem(c.certDer), key: c.keyPem }); this.fp = tlsmod.fingerprint(c.certDer); },
    /** A collect answered `ms` late (it claims what it lists when it answers), and one refused ({status, error}) or not (null). */
    set collectDelayMs(ms) { collectDelayMs = ms; },
    set collectRefusal(v) { collectRefusal = v; },
    /** How long the desk takes to answer each new proposal from now on (it takes the proposal when it answers). */
    set proposalDelayMs(ms) { proposalDelayMs = ms; },
    /** How long each send to the speaker's screen waits from now on before it is judged and answered. */
    set messageDelayMs(ms) { messageDelayMs = ms; },
    /** How long a socket that connects from now on waits for its first message (a slow network: its key read comes late). */
    set firstFrameDelayMs(ms) { firstFrameDelayMs = ms; },
    /** What it answers the next reads of its context, and the next desk checks, first: [{status, error, retryAfter}]. */
    get answerContext() { return answerContext; },
    set answerContext(v) { answerContext = v; },
    get answerDeskChecks() { return answerDeskChecks; },
    set answerDeskChecks(v) { answerDeskChecks = v; },
    /** Called with each request as it arrives, before it is answered (null: nothing). */
    set onRequest(fn) { onRequest = fn; },
    /** Called with the id as each result post arrives, before it is answered (null: nothing). */
    set onResultPost(fn) { onResultPost = fn; },
    /** Every route answers 429 with Retry-After for `ms`, as Stagewatch does once a key spent its minute. */
    holdAll(ms) { heldUntil = Date.now() + ms; },
    /** Its five minutes pass without a result: an approved proposal is undelivered (claimed: no report; else not collected). */
    expire(id) { const p = proposals.get(id); if (p && p.state === 'approved') { p.state = 'undelivered'; p.words = 'AGMessage ' + (p.claimed ? 'didn\'t report back' : 'didn\'t collect it'); } },
    /** How many result posts it answers 500 before it takes one (a busy or restarting desk). */
    get failResults() { return failResults; },
    set failResults(n) { failResults = n; },
    frame(o) { last = { ...last, ...o }; for (const c of sockets) c.send(JSON.stringify(last)); },
    approve(id, by = 'Show caller') { const p = proposals.get(id); if (p) { p.state = 'approved'; p.decidedBy = by; p.decided = Date.now(); } },
    /** The desk ran an approved proposal aimed at itself (ProposalDesk.Finished): done or failed, with its receipt's words. */
    finish(id, ok, words) { const p = proposals.get(id); if (p && p.state === 'approved') { p.state = ok ? 'done' : 'failed'; p.words = words; } },
    /** Another node's proposal on this desk (its own id, or the next one), as Stagewatch would hold it. */
    add(p) { const id = p.id || 'p' + (++next); proposals.set(id, { state: 'pending', reason: '', risk: 'review', ...p, id, created: p.created || Date.now() }); return id; },
    /** Stagewatch restarts: its queue is gone and it numbers from p1 again (it keeps both in memory only). */
    restart() { proposals.clear(); next = 0; },
    /** Every socket it holds is cut without a close frame (its network dropped). */
    drop() { for (const c of wss.clients) c.terminate(); },
    close() { for (const c of wss.clients) c.terminate(); wss.close(); return new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); }); },
  };
}

/**
 * A fake Patterns or PlayMap node: GET /api/context answers its context only with the right token in its own header
 * (X-Patterns-Token / X-PlayMap-Token). `verbs`, when given, is PlayMap's GET /api/verbs (answered 503 the first
 * `failVerbs` times). Anything else is 404. Every request is kept in `requests`. It listens on `host` (127.0.0.1 unless
 * a test needs it reachable from another address).
 */
async function fakeNode({ t = 'patterns', name = 'Patterns FOH', token = 'node-token', commands = [], verbs = null, failVerbs = 0, light = 'green', headline = 'Programme: VT1 · 3 screens green', host = '127.0.0.1' } = {}) {
  const http = require('http');
  const requests = [];
  const header = t === 'playmap' ? 'x-playmap-token' : 'x-patterns-token';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const given = Buffer.from(String(req.headers[header] || ''));
      const want = Buffer.from(token);
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (given.length !== want.length || !require('crypto').timingSafeEqual(given, want)) return json(401, t === 'patterns' ? { ok: false, msg: 'ERR not paired' } : { ok: false, error: 'not paired' });
      if (req.url === '/api/context') return json(200, { v: 1, node: { t, id: t + '01', name }, light, headline, items: [{ id: 'screen:2', kind: 'screen', label: 'Screen 2', light: 'amber', state: 'no signal' }], recent: [], commands });
      if (req.url === '/api/verbs' && verbs && failVerbs > 0) { failVerbs--; return json(503, { ok: false, error: 'busy' }); }
      if (req.url === '/api/verbs' && verbs) return json(200, verbs);
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => { srv.listen(0, host, resolve); });
  return { port: srv.address().port, url: '127.0.0.1:' + srv.address().port, requests, close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); }) };
}

/** The same server stopped (saved first) and started again on its data folder and port, as the watchdog would. */
async function restartServer(srv, env = {}) {
  await stopServer(srv.child);
  return startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port), ...env });
}

/** Wait until fn() is truthy (polling every 50 ms), or fail after `ms`. */
async function until(fn, ms = 6000, what = 'the condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(50); }
  throw new Error('timed out waiting for ' + what);
}

// ---------------------------------------------------------------- the files the source fences read
/**
 * Every file under `dir` (relative to `root`), in every folder below it but those named in `skip`, whose name matches
 * `re`: relative to `root` with '/' between folders, sorted. A folder that is not there holds nothing.
 */
function filesUnder(dir, re, { root = ROOT, skip = [] } = {}) {
  const top = path.join(root, dir);
  if (!fs.existsSync(top)) return [];
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(top, rel), { withFileTypes: true })) {
      const name = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!skip.includes(name)) walk(name); } else if (e.isFile() && re.test(e.name)) out.push(dir + '/' + name);
    }
  };
  walk('');
  return out.sort();
}
/**
 * The files that register socket verbs: server.js, the composition root, then each handler module in lib/handlers/.
 * The input fuzz, the module fence and the counts over handlers read this one list, so a verb registered in any of
 * them is held to each.
 */
function handlerFiles(root = ROOT) {
  const dir = path.join(root, 'lib', 'handlers');
  const modules = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => 'lib/handlers/' + e.name).sort() : [];
  return ['server.js', ...modules];
}
/** Every script a page loads that AGMessage writes: each `.js` and `.mjs` under public/, the vendored libraries left out. */
const pageScripts = (root = ROOT) => filesUnder('public', /\.m?js$/, { root, skip: ['vendor'] });

// ---------------------------------------------------------------- the audit log, in-process
// No test reaches a real key folder: a log is given a fixed machine key and a records folder beside its own data folder.
const audit = require('../lib/audit');
const secretbox = require('../lib/secretbox');
const { placeId } = require('../lib/resilience');
const FIXTURE_KEY = Buffer.from('a5c3'.repeat(16), 'hex');   // secret-scan: fixture — a machine key no laptop holds
const OTHER_KEY = Buffer.from('3c5a'.repeat(16), 'hex');     // secret-scan: fixture — another machine's
const HOST = Object.freeze({ t: 'admin', id: 'host', name: 'AGMessage laptop' });
/** The log's keys from a machine key (the fixture's by default), as secretbox derives them. */
const auditKeys = (key = FIXTURE_KEY) => audit.keysFrom((label) => secretbox.deriveFrom(key, label));
/** The records folder a test log keeps, beside its data folder: <data>-keys/audit, as the server's AGM_KEY_DIR has it. */
const recordsOf = (file) => path.join(path.dirname(file) + '-keys', 'audit');
/** An audit log for a test: the fixture key (or `key`), its records beside its folder (or `records`). */
const auditLog = (file, { key = FIXTURE_KEY, records = recordsOf(file), ...o } = {}) => new audit.AuditLog(file, { keys: auditKeys(key), records, ...o });
/** The machine key a test server made (its AGM_KEY_DIR is the data folder + '-keys'). */
const serverKey = (dataDir) => Buffer.from(fs.readFileSync(path.join(dataDir + '-keys', 'machine.key'), 'utf8').trim(), 'base64');
/** A server's log opened in this process, under the server's own key and records. */
const serverAudit = (dataDir) => auditLog(path.join(dataDir, 'audit.jsonl'), { key: serverKey(dataDir), records: path.join(dataDir + '-keys', 'audit') });

// ---------------------------------------------------------------- the keyed stores, in-process
// No test reaches a real key folder: the stores are given the fixture key (or `key`) and a records folder beside their
// data folder (<data>-keys/stores, as a test server's AGM_KEY_DIR has it).
const keyedstore = require('../lib/keyedstore');
const acc = require('../lib/accounts');
/** The keyed stores' five keys and their key id under a machine key, as lib/secretbox.js derives them. */
const storesKeys = (key = FIXTURE_KEY) => keyedstore.keysFrom((label) => secretbox.deriveFrom(key, label));
const storesKid = (key = FIXTURE_KEY) => audit.kidOf(secretbox.deriveFrom(key, audit.LABELS.entry));
/** The records folder of a folder's keyed stores: <data>-keys/stores. */
const storesOf = (dir) => path.join(dir + '-keys', 'stores');
/**
 * A data folder's keyed stores opened as a start opens them: {ks, accounts, sessions, tokens, flush()}. `open: false`
 * leaves open() to the test; `made` says this run made the key; `rows` and `lines` collect what it writes and says.
 */
function openStores(dir, { key = FIXTURE_KEY, records = storesOf(dir), token = TOKEN, open = true, made = false, archive, accountsOf } = {}) {
  const rows = [];
  const lines = [];
  const ks = new keyedstore.KeyedStores({
    keys: storesKeys(key), kid: storesKid(key), made: () => made, records, dataDir: dir, archive,
    say: (l) => lines.push(l), row: (action, target, words) => rows.push({ action, target, words }),
  });
  const accounts = accountsOf ? null : new acc.Accounts(path.join(dir, 'accounts.json'), { keyed: ks.part('accounts') });
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accountsOf || accounts, { keyed: ks.part('sessions') });
  const tokens = new acc.TokenSessions(path.join(dir, 'admin-sessions.json'), { keyed: ks.part('adminSessions'), token });
  if (open) ks.open();
  const flush = () => { if (accounts) accounts.flush(); sessions.flush(); tokens.flush(); ks.head.flushSync(); };
  return { ks, accounts, sessions, tokens, rows, lines, flush };
}

/**
 * A stopped server's keyed store written as a key holder could write it: its fields changed by `edit(fields)` (which
 * changes them in place, or answers new ones), sealed under the server's own machine key as the save after the one on
 * disk. What a test once wrote by hand into a store a page cannot change yet; a writer without the key is refused.
 */
function resealStore(dataDir, name, edit) {
  const file = path.join(dataDir, keyedstore.FILES[name]);
  const { v, store, set, gen, kid, at, m, ...fields } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = edit(fields) || fields;
  const K = storesKeys(serverKey(dataDir))();
  fs.writeFileSync(file, keyedstore.sealText(K[name], keyedstore.LABELS[name], { v: 2, store: name, set, gen: gen + 1, kid, at: Date.now() }, out, name === 'accounts' ? 1 : undefined).text);
}

/**
 * A keyed store written into a stopped server's folder that holds none yet, as a key holder could: sealed under its
 * machine key in a set of its own (the start reads it as unrecorded △, and loads it).
 */
function sealStore(dataDir, name, fields) {
  const K = storesKeys(serverKey(dataDir))();
  const head = { v: 2, store: name, set: require('crypto').randomBytes(16).toString('hex'), gen: 1, kid: storesKid(serverKey(dataDir)), at: Date.now() };
  fs.writeFileSync(path.join(dataDir, keyedstore.FILES[name]), keyedstore.sealText(K[name], keyedstore.LABELS[name], head, fields, name === 'accounts' ? 1 : undefined).text);
}
/** A sign-in's keyed hash as a server keeps it (`kind` 'session' or 'token sign-in'), under its machine key. */
const signInHash = (dataDir, secret, kind = 'session') => require('crypto').createHmac('sha256', storesKeys(serverKey(dataDir))().id).update(kind + '\n' + secret).digest('hex');

const SAM = Object.freeze({ t: 'account', id: 'a1', name: 'sam' });
const SEED_WORDS = (i) => 'Lectern screen ' + (i % 4) + ' \u2192 message \u201cFive minutes left\u201d';
/** A whole chain of `n` entries from the genesis hash with plain hashes, as AGMessage 0.5.1 and earlier wrote them. */
function chainOf(n, words = SEED_WORDS, at = 1_700_000_000_000) {
  let prev = audit.GENESIS;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = { seq: i, at: at + i, actor: { ...SAM }, action: 'display.take', target: 'dlectern1', words: words(i), ip: '10.0.0.9', prev };
    e.h = audit.hashOf(e);
    prev = e.h;
    out.push(JSON.stringify(e));
  }
  return out.join('\n') + '\n';
}
/**
 * A keyed chain of `n` entries under `key`, written at `file`, with the records a laptop under that key keeps for it (its
 * head, the log written last, the folder record, keyed.json), as if this machine had written it all: it opens intact.
 */
function keyedChainOf(n, { file, key = FIXTURE_KEY, records = recordsOf(file), words = SEED_WORDS, at = 1_700_000_000_000, l = 'c0ffee'.padEnd(32, '0') }) {
  const k = auditKeys(key)();
  const kid = audit.kidOf(k.entry);
  let prev = audit.GENESIS;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = { seq: i, at: at + i, actor: { ...SAM }, action: 'display.take', target: 'dlectern1', words: words(i), ip: '10.0.0.9', prev, l, k: kid };
    e.h = audit.macOf(e, k.entry);
    prev = e.h;
    out.push(JSON.stringify(e));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
  fs.mkdirSync(records, { recursive: true });
  const p = path.resolve(file);
  const id = placeId(path.dirname(file), path.basename(file));
  const now = at + n;
  fs.writeFileSync(path.join(records, 'head-' + l + '.json'), audit.sealRecord({ v: 1, log: l, path: p, kid, seq: n, h: prev, run: 1, held: [], at: now }, k.head));
  fs.writeFileSync(path.join(records, 'latest.json'), audit.sealRecord({ v: 1, log: l, path: p, seq: n, at: now }, k.head));
  fs.writeFileSync(path.join(records, 'folder-' + id + '.json'), audit.sealRecord({ v: 1, folder: id, path: p, log: l, at: now }, k.head));
  fs.writeFileSync(path.join(records, 'keyed.json'), audit.sealRecord({ v: 1, since: at, log: l }, k.head));
  return { l, kid, last: prev };
}
/**
 * A keyed chain of `n` entries under `key`, as keyedChainOf writes one, in which each seq in `points` is an archive point
 * (`audit.archive`, H.10.1) that opens a file of its own: the files before it are rotated files named by time, and the
 * last is `file`. Its records are a laptop's under that key, its head's run beginning at entry 1. Returns {l, kid, last, files}.
 */
function keyedLogWithPoints(n, { file, points = [], key = FIXTURE_KEY, records = recordsOf(file), words = SEED_WORDS, at = 1_700_000_000_000, l = 'c0ffee'.padEnd(32, '0') }) {
  const k = auditKeys(key)();
  const kid = audit.kidOf(k.entry);
  let prev = audit.GENESIS;
  const parts = [[]];
  for (let i = 1; i <= n; i++) {
    const point = points.includes(i);
    if (point && parts[parts.length - 1].length) parts.push([]);
    const e = point
      ? { seq: i, at: at + i, actor: { ...HOST }, action: 'audit.archive', target: '2026-10-27T14-02-00-' + String(i % 1000).padStart(3, '0') + 'Z;' + kid + ':1', words: 'the event “Rehearsal ' + i + '” was archived; links kept. The audit log carries on, and can be split here (Admin → Health).', ip: '127.0.0.1', prev, l, k: kid }
      : { seq: i, at: at + i, actor: { ...SAM }, action: 'display.take', target: 'dlectern1', words: words(i), ip: '10.0.0.9', prev, l, k: kid };
    e.h = audit.macOf(e, k.entry);
    prev = e.h;
    parts[parts.length - 1].push(JSON.stringify(e));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const files = parts.map((_, i) => (i === parts.length - 1 ? file : path.join(path.dirname(file), 'audit-' + new Date(at + i * 1000).toISOString().replace(/[:.]/g, '-') + '.jsonl')));
  parts.forEach((part, i) => fs.writeFileSync(files[i], part.join('\n') + '\n'));
  fs.mkdirSync(records, { recursive: true });
  const p = path.resolve(file);
  const id = placeId(path.dirname(file), path.basename(file));
  const now = at + n;
  fs.writeFileSync(path.join(records, 'head-' + l + '.json'), audit.sealRecord({ v: 1, log: l, path: p, kid, seq: n, h: prev, run: 1, held: [], at: now }, k.head));
  fs.writeFileSync(path.join(records, 'latest.json'), audit.sealRecord({ v: 1, log: l, path: p, seq: n, at: now }, k.head));
  fs.writeFileSync(path.join(records, 'folder-' + id + '.json'), audit.sealRecord({ v: 1, folder: id, path: p, log: l, at: now }, k.head));
  fs.writeFileSync(path.join(records, 'keyed.json'), audit.sealRecord({ v: 1, since: at, log: l }, k.head));
  return { l, kid, last: prev, files };
}
/**
 * A server's audit work counted (test/audit-preload.js), never timed: `env` preloads the meter into a server started with
 * it and names the file it writes beside `dataDir`; `seen()` reads that file once the request it counts is answered (it is
 * written whole before then); `waiting()` is how many of the work's reads a hold has waiting now, 0 until the file says.
 */
function auditMeter(dataDir) {
  const file = dataDir + '-meter.json';
  const preload = '--require "' + path.join(__dirname, 'audit-preload.js').split(path.sep).join('/') + '"';   // forward slashes: no escapes inside the quotes
  return {
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_AUDIT: file },
    seen: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    waiting() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).waiting; } catch { return 0; }   // not written yet, or being written: asked again
    },
    remove: () => { fs.rmSync(file, { force: true }); },
  };
}
/** Accept every open finding as the typed token would (✕ ones confirmed): the accepted state, ◇. */
async function acceptAll(log) {
  const c = await log.verify();
  const ids = c.findings.filter((f) => !f.held).map((f) => f.id);
  return log.accept({ digest: c.digest, ids, confirm: ids }, HOST, '127.0.0.1');
}
/** A check's answer, in brief: what a test of its meaning compares. */
const brief = (v) => ({ ok: v.ok, mark: v.mark, entries: v.entries, ...(v.unwritten ? { unwritten: v.unwritten } : {}) });

/**
 * A zip's members, read the way a test can trust: from its end record and central directory, each member's own local
 * header, inflated and held to its CRC-32 and size. Returns [{name, data}] in the directory's order; throws on anything off.
 */
function readZip(buf) {
  const zlib = require('zlib');
  const end = buf.length - 22;
  if (end < 0 || buf.readUInt32LE(end) !== 0x06054b50) throw new Error('no end-of-central-directory record at the end');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (at + buf.readUInt32LE(end + 12) !== end) throw new Error('the central directory does not end where the end record says');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('central directory entry ' + i + ' has no signature');
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50 || buf.toString('utf8', local + 30, local + 30 + buf.readUInt16LE(local + 26)) !== name) throw new Error(name + ': its local header does not match');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.readUInt16LE(local + 8) === 8 ? zlib.inflateRawSync(buf.subarray(start, start + csize)) : buf.subarray(start, start + csize);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(name + ': its size or CRC-32 does not match');
    out.push({ name, data });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
/** A zip's members written under `dir`; returns the one folder they unpack to. */
function unzipTo(buf, dir) {
  let top = '';
  for (const m of readZip(buf)) {
    const file = path.join(dir, ...m.name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, m.data);
    top = path.join(dir, m.name.split('/')[0]);
  }
  return top;
}

// ---------------------------------------------------------------- Office files and the page's document worker
/**
 * A zip of an Office file's parts ({name: text or bytes}), in their order, each deflated as Office writes them (stored
 * where `stored` names it; with a data descriptor after it, bit 3, where `descriptors` names it). For the readers'
 * disagreements: `localNames` {name: the name its local header gives instead}, `extras` {name: the bytes of its
 * directory record's extra field}, `external` {name: its external attributes}.
 */
function officeZip(parts, { stored = [], descriptors = [], localNames = {}, extras = {}, external = {} } = {}) {
  const zlib = require('zlib');
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const method = stored.includes(name) ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name, 'utf8');
    const ln = Object.hasOwn(localNames, name) ? Buffer.from(localNames[name], 'utf8') : n;
    const extra = Object.hasOwn(extras, name) ? Buffer.from(extras[name]) : Buffer.alloc(0);
    const crc = zlib.crc32(data);
    const late = descriptors.includes(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(late ? 8 : 0, 6); head.writeUInt16LE(method, 8);
    if (!late) { head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); }
    head.writeUInt16LE(ln.length, 26);
    const after = Buffer.alloc(late ? 16 : 0);
    if (late) { after.writeUInt32LE(0x08074b50, 0); after.writeUInt32LE(crc, 4); after.writeUInt32LE(body.length, 8); after.writeUInt32LE(data.length, 12); }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(late ? 8 : 0, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28);
    dir.writeUInt16LE(extra.length, 30); dir.writeUInt32LE(Object.hasOwn(external, name) ? external[name] : 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, ln, body, after);
    central.push(dir, n, extra);
    offset += head.length + ln.length + body.length + after.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 3, 8); end.writeUInt16LE(central.length / 3, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const OOXML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const relsOf = (list) => OOXML + '<Relationships ' + RELS_NS + '>' + list.map(([id, type, target]) => '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>').join('') + '</Relationships>';
const typesOf = (overrides) => OOXML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
  + overrides.map(([part, type]) => '<Override PartName="' + part + '" ContentType="' + type + '"/>').join('') + '</Types>';
/**
 * A Word file's parts: `body` the body's XML, `styles` the styles' (the part left out where it is absent), `pages` the
 * `<Pages>` docProps/app.xml declares, `media` {name: bytes} under word/media with an image relationship each (rId10…).
 */
function wordParts({ body, styles, pages, media = {} } = {}) {
  const parts = {
    '[Content_Types].xml': typesOf([['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']]),
    '_rels/.rels': relsOf([['rId1', 'officeDocument', 'word/document.xml'], ['rId2', 'extended-properties', 'docProps/app.xml']]),
    'word/document.xml': OOXML + '<w:document ' + W_NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + (body || '') + '</w:body></w:document>',
    'word/_rels/document.xml.rels': relsOf([...(styles !== undefined ? [['rId1', 'styles', 'styles.xml']] : []), ...Object.keys(media).map((m, i) => ['rId' + (10 + i), 'image', 'media/' + m])]),
  };
  if (styles !== undefined) parts['word/styles.xml'] = OOXML + '<w:styles ' + W_NS + '>' + styles + '</w:styles>';
  if (pages !== undefined) parts['docProps/app.xml'] = OOXML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><Pages>' + pages + '</Pages></Properties>';
  for (const [m, bytes] of Object.entries(media)) parts['word/media/' + m] = bytes;
  return parts;
}
/** A picture's run in a Word body, its bytes the relationship `rId` names. */
const wordPicture = (rId, alt) => '<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="' + alt + '"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p.png" descr="' + alt + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rId + '"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** A slide's shape: its paragraphs' text, a placeholder's type (`ph`: 'title', 'body', 'ftr' …), `hidden`, a level. */
const deckShape = (text, { ph, hidden, lvl, id = 2 } = {}) => '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="s"' + (hidden ? ' hidden="1"' : '') + '/><p:cNvSpPr/><p:nvPr>' + (ph ? '<p:ph' + (ph === 'body' ? '' : ' type="' + ph + '"') + '/>' : '') + '</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>'
  + [].concat(text).map((t) => '<a:p>' + (lvl ? '<a:pPr lvl="' + lvl + '"/>' : '') + '<a:r><a:t>' + t + '</a:t></a:r></a:p>').join('') + '</p:txBody></p:sp>';
/** A slide's picture, its bytes the slide's relationship `rId` names. */
const deckPicture = (rId, { hidden } = {}) => '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="A chart"' + (hidden ? ' hidden="1"' : '') + '/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="' + rId + '"/></p:blipFill><p:spPr/></p:pic>';
/** A slide holding `inner` (shapes, pictures, frames), `show` its show attribute where given ("0": hidden). */
const deckSlide = (inner, show) => OOXML + '<p:sld ' + P_NS + (show === undefined ? '' : ' show="' + show + '"') + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + inner + '</p:spTree></p:cSld></p:sld>';
/** A deck's parts: `slides` [{xml, rels}] in the presentation's order (named in the reverse order), its notes, and media. */
function deckParts(slides, media = {}) {
  const parts = {
    '[Content_Types].xml': typesOf([['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml']]),
    '_rels/.rels': relsOf([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': OOXML + '<p:presentation ' + P_NS + '><p:sldIdLst>' + slides.map((_, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (10 + slides.length - i) + '"/>').join('') + '</p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relsOf(slides.map((_, i) => ['rId' + (10 + slides.length - i), 'slide', 'slides/slide' + (i + 1) + '.xml'])),
  };
  slides.forEach((x, i) => {
    parts['ppt/slides/slide' + (i + 1) + '.xml'] = x.xml;
    parts['ppt/slides/_rels/slide' + (i + 1) + '.xml.rels'] = relsOf(x.rels || []);
  });
  parts['ppt/notesSlides/notesSlide1.xml'] = OOXML + '<p:notes ' + P_NS + '><p:cSld><p:spTree>' + deckShape('PRESENTERNOTE', { ph: 'body' }) + '</p:spTree></p:cSld></p:notes>';
  for (const [name, bytes] of Object.entries(media)) parts['ppt/media/' + name] = bytes;
  return parts;
}

const X_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const sheetCell = (ref, v) => '<c r="' + ref + '" t="inlineStr"><is><t>' + v + '</t></is></c>';
/**
 * A workbook: Budget (column B and row 2 hidden, a formula saved without its value, one with it) and two hidden sheets,
 * Salaries ("very hidden") and Old, each hidden word in capitals.
 */
const workbookParts = () => ({
  '[Content_Types].xml': typesOf([['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml']]),
  '_rels/.rels': relsOf([['rId1', 'officeDocument', 'xl/workbook.xml']]),
  'xl/workbook.xml': OOXML + '<workbook ' + X_NS + '><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Salaries" sheetId="2" state="veryHidden" r:id="rId2"/><sheet name="Old" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': relsOf([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'worksheet', 'worksheets/sheet3.xml']]),
  'xl/worksheets/sheet1.xml': OOXML + '<worksheet ' + X_NS + '><cols><col min="2" max="2" width="9" hidden="1" customWidth="1"/></cols><sheetData>'
    + '<row r="1">' + sheetCell('A1', 'Item') + sheetCell('B1', 'SECRETCOL') + sheetCell('C1', 'Cost') + '</row>'
    + '<row r="2" hidden="1">' + sheetCell('A2', 'SECRETROW') + '</row>'
    + '<row r="3">' + sheetCell('A3', 'Total') + '<c r="C3"><f>SUM(C1:C2)</f></c><c r="D3"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': OOXML + '<worksheet ' + X_NS + '><sheetData><row r="1">' + sheetCell('A1', 'VERYHIDDEN') + '</row></sheetData></worksheet>',
  'xl/worksheets/sheet3.xml': OOXML + '<worksheet ' + X_NS + '><sheetData><row r="1">' + sheetCell('A1', 'JUSTHIDDEN') + '</row></sheetData></worksheet>',
});

/**
 * A workbook of one sheet (`name`) holding `rows` (each a list of words) from A1, every cell an inline string. `o.hiddenRows`
 * and `o.hiddenCols` (counted from 0) are hidden, `o.frozen` ({rows, cols}) are its frozen panes, and `o.hiddenSheet` (rows
 * of words) is a hidden sheet after it, named "Hidden".
 */
const sheetParts = (rows, name = 'Sheet1', o = {}) => {
  const hr = new Set(o.hiddenRows || []);
  const hc = [...new Set(o.hiddenCols || [])];
  const data = (list) => '<sheetData>' + list.map((row, r) => '<row r="' + (r + 1) + '"' + (list === rows && hr.has(r) ? ' hidden="1"' : '') + '>'
    + row.map((v, c) => (v === '' ? '' : sheetCell(String.fromCharCode(65 + c) + (r + 1), v))).join('') + '</row>').join('') + '</sheetData>';
  const pane = o.frozen ? '<sheetViews><sheetView workbookViewId="0"><pane' + (o.frozen.cols ? ' xSplit="' + o.frozen.cols + '"' : '') + (o.frozen.rows ? ' ySplit="' + o.frozen.rows + '"' : '')
    + ' topLeftCell="' + String.fromCharCode(65 + (o.frozen.cols || 0)) + ((o.frozen.rows || 0) + 1) + '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' : '';
  const cols = hc.length ? '<cols>' + hc.map((c) => '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="9" hidden="1" customWidth="1"/>').join('') + '</cols>' : '';
  const parts = {
    '[Content_Types].xml': typesOf([['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml']]),
    '_rels/.rels': relsOf([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': OOXML + '<workbook ' + X_NS + '><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/>' + (o.hiddenSheet ? '<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>' : '') + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relsOf([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ...(o.hiddenSheet ? [['rId2', 'worksheet', 'worksheets/sheet2.xml']] : [])]),
    'xl/worksheets/sheet1.xml': OOXML + '<worksheet ' + X_NS + '>' + pane + cols + data(rows) + '</worksheet>',
  };
  if (o.hiddenSheet) parts['xl/worksheets/sheet2.xml'] = OOXML + '<worksheet ' + X_NS + '>' + data(o.hiddenSheet) + '</worksheet>';
  return parts;
};

/**
 * The page's document worker (public/docworker.js) run as a browser runs a worker: in a context of its own, its
 * importScripts reading AGMessage's own files by their address, handed one task ({task, bytes, opts}, the bytes copied
 * into the worker's own ArrayBuffer) and answering it once. Resolves the answer as plain data (picture bytes as Buffers).
 * `without` names globals a device lacks (a browser with no `DecompressionStream`, say).
 */
async function docWorker(task, bytes, opts = {}, { without = [] } = {}) {
  const vm = require('vm');
  const globals = {
    console, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask,
    TextDecoder, TextEncoder, Blob, DecompressionStream, ReadableStream, WritableStream, TransformStream,
  };
  for (const name of without) delete globals[name];
  const ctx = vm.createContext(globals);
  vm.runInContext('globalThis.self = globalThis;', ctx);
  ctx.importScripts = (...urls) => {
    for (const u of urls) vm.runInContext(readSource(path.join(ROOT, 'public', ...String(u).replace(/^\//, '').split('/'))), ctx, { filename: u });
  };
  let answer;
  const heard = new Promise((resolve) => { ctx.postMessage = (m) => { answer = m; resolve(); }; });
  vm.runInContext(readSource(path.join(ROOT, 'public', 'docworker.js')), ctx, { filename: 'docworker.js' });
  const ab = vm.runInContext('(n) => new ArrayBuffer(n)', ctx)(bytes.length);
  new Uint8Array(ab).set(bytes);
  ctx.onmessage({ data: { task, bytes: ab, opts } });
  await heard;
  const plain = (v) => {
    if (v && typeof v === 'object' && typeof v.byteLength === 'number' && !Array.isArray(v)) return Buffer.from(new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength));
    if (Array.isArray(v)) return Array.from(v, plain);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
  };
  return plain(answer);
}

/**
 * The invite a room's admin hands out for a seat (lib/guard.js makeInvite: the room's guest code, the seat, the room's
 * number for it), made with the server's own secret as its data folder keeps it: what the Invites panel's link carries,
 * for a test to join as a guest who was sent that link. On stage needs one in every hall's Main room.
 */
function inviteOf(dataDir, code, role = 'board', n = 0) {
  const hex = fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim();
  return guard.makeInvite(Buffer.from(hex, 'hex'), code, role, n);
}

module.exports = {
  inviteOf,
  stagewatchQuery, ROOT, REPO, TOKEN, readSource, freePort, freeUdpPort, wait, until, startServer, stopServer, restartServer, api, connect, emit, answer, once, pngOf, fakeStagewatch, fakeNode,
  filesUnder, handlerFiles, pageScripts,
  FIXTURE_KEY, OTHER_KEY, HOST, auditKeys, recordsOf, auditLog, serverKey, serverAudit, storesKeys, storesKid, storesOf, openStores, setupAdmin, resealStore, sealStore, signInHash, chainOf, keyedChainOf, keyedLogWithPoints, auditMeter, acceptAll, brief,
  readZip, unzipTo, SEED_WORDS, sheetParts,
  officeZip, wordParts, wordPicture, relsOf, typesOf, OOXML, W_NS, deckParts, deckShape, deckPicture, deckSlide, workbookParts, docWorker,
};
