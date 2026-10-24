'use strict';
// Shared by the end-to-end tests: a real server in a child process on a free port with a throwaway data folder and key
// folder, and a Socket.io client that carries a cookie.
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
const stopServer = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(resolve, 3000); });

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
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('no ' + ev + ' within ' + ms + ' ms')), ms); s.once(ev, (v) => { clearTimeout(t); resolve(v); }); });

/**
 * A fake Stagewatch on a free port: /ws sends a state frame on connect (frame(obj) sends another); /api/message/… answers
 * a receipt; the show desk (/api/proposals: create, read one, list by target and state, result) keeps its queue in
 * `proposals`; /api/context answers a context named `name`. Every request is kept in `requests` (method, url, headers,
 * body) so a test can say what reached which Stagewatch.
 */
async function fakeStagewatch({ name = 'Fake Stagewatch', desk = true, messageId = 77 } = {}) {
  const http = require('http');
  const { WebSocketServer } = require('ws');
  const requests = [];
  const proposals = new Map();
  let next = 0;
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/api/message/')) return json(200, { type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', refs: { messageId } });
      if (u.pathname === '/api/context') return json(200, { v: 1, node: { t: 'main', id: 'sw' + name.length, name }, light: 'green', headline: name + ' running', items: [], peers: [] });
      if (u.pathname === '/api/peers/context') return json(200, { ok: true });
      if (desk && u.pathname === '/api/proposals' && req.method === 'POST') {
        const p = { ...JSON.parse(body || '{}'), id: 'p' + (++next), state: 'pending' };
        proposals.set(p.id, p);
        return json(201, { ok: true, id: p.id, state: p.state });
      }
      if (desk && u.pathname === '/api/proposals') {
        const list = Array.from(proposals.values()).filter((p) => (!u.searchParams.get('target') || (p.target && p.target.id === u.searchParams.get('target'))) && (!u.searchParams.get('state') || p.state === u.searchParams.get('state')));
        return json(200, { proposals: list });
      }
      const one = /^\/api\/proposals\/(p\d+)(\/result)?$/.exec(u.pathname);
      if (desk && one && proposals.has(one[1])) {
        const p = proposals.get(one[1]);
        if (one[2]) { const r = JSON.parse(body || '{}'); p.state = r.ok ? 'done' : 'failed'; p.words = r.words; return json(200, { ok: true }); }
        return json(200, p);
      }
      json(404, { ok: false, error: 'not here' });
    });
  });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  let last = { type: 'state', mode: 'countdown', text: '05:00', title: name, seconds: 300, state: 'running', messageId: 0 };
  wss.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('message', (d) => { let m; try { m = JSON.parse(String(d)); } catch { return; } if (m.cmd === 'ping') c.send(JSON.stringify({ type: 'pong', t: m.t, t2: Date.now(), t3: Date.now() })); });
    c.send(JSON.stringify(last));
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  const port = srv.address().port;
  return {
    port, url: '127.0.0.1:' + port, requests, proposals,
    get connected() { return sockets.size > 0; },
    frame(o) { last = { ...last, ...o }; for (const c of sockets) c.send(JSON.stringify(last)); },
    approve(id, by = 'Show caller') { const p = proposals.get(id); if (p) { p.state = 'approved'; p.decidedBy = by; } },
    close() { for (const c of sockets) c.terminate(); wss.close(); return new Promise((resolve) => { srv.close(resolve); }); },
  };
}

/** Wait until fn() is truthy (polling every 50 ms), or fail after `ms`. */
async function until(fn, ms = 6000, what = 'the condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(50); }
  throw new Error('timed out waiting for ' + what);
}

module.exports = { ROOT, TOKEN, freePort, wait, until, startServer, stopServer, api, connect, emit, once, fakeStagewatch };
