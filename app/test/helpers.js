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

module.exports = { ROOT, TOKEN, freePort, wait, startServer, stopServer, api, connect, emit, once };
