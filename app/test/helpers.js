'use strict';
// Shared by the end-to-end tests: a real server in a child process on a free port with a throwaway data folder, key
// folder and upload folder (never the tree's), and a Socket.io client that carries a cookie.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'testadmintoken01';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Start a server; resolves {child, base, port, dataDir, out()} once it says it is running. */
async function startServer(env = {}) {
  const dataDir = env.AGM_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', AGM_UPLOAD_DIR: dataDir + '-uploads', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.channel) child.channel.unref();   // the channel carries the stop; it keeps no test run alive
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    if (out.includes('is running')) return { child, port, base: `http://127.0.0.1:${port}`, dataDir, out: () => out };
    await wait(100);
  }
  child.kill();
  throw new Error('server did not start:\n' + out);
}
/**
 * Stop a server as the watchdog does: asked over IPC, so it saves first on every platform (on Windows a signal sent to a
 * child ends it at once, unsaved). One that has not gone in 3 s is ended.
 */
const stopServer = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  child.once('exit', resolve);
  try { child.send({ t: 'stop' }); } catch { child.kill('SIGTERM'); }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});

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

const connect = (base, cookie) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : {} });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const emit = (s, ev, arg) => new Promise((resolve) => { s.emit(ev, arg, resolve); });
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
 * that long before its key is judged (a request made under one key, answered after the key changed).
 */
async function fakeStagewatch({ name = 'Fake Stagewatch', desk = true, messageId = 77, departments = [], failResults = 0, key = null, auth18 = false, authDelayMs = 0, closeOnRefuse = false, viewCode = false, contextDelayMs = 0, contextFail = 0, cert = null, answerDeskChecks = [], answerContext = [], messageDelayMs = 0, firstFrameDelayMs = 0 } = {}) {
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
        // As Stagewatch's Collect: a target's approved proposals are handed over once (claimed), never listed again.
        const target = u.searchParams.get('target');
        const list = Array.from(proposals.values()).filter((p) => (!target || (p.target && p.target.id === target && !p.claimed)) && (!u.searchParams.get('state') || p.state === u.searchParams.get('state')));
        if (target) for (const p of list) p.claimed = true;
        return json(200, { proposals: list.map(toJson) });
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
      if (messageDelayMs && req.url.startsWith('/api/message/')) setTimeout(serve, messageDelayMs); else serve();
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

module.exports = { stagewatchQuery, ROOT, TOKEN, freePort, wait, until, startServer, stopServer, restartServer, api, connect, emit, answer, once, fakeStagewatch, fakeNode };
