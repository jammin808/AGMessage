'use strict';
// End-to-end tests: a real server in a child process on a free port with a throwaway data folder.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'testadmintoken01';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (out.includes('is running')) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not start:\n' + out);
}
function stop(child) { return new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(r, 3000); }); }

const emit = (s, ev, arg) => new Promise((resolve) => s.emit(ev, arg, resolve));
const connect = (base, cookie) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : {} });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});

test('AGMessage server: security, resume, persistence', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child = await startServer(dataDir, port);
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stop(child); });

  await t.test('pages carry a strict CSP and no inline script', async () => {
    const r = await fetch(base + '/app.html');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const html = await r.text();
    assert.ok(!/<script>(?!<)/.test(html.replace(/<script src=[^>]+><\/script>/g, '')), 'no inline <script>');
    const mjs = await fetch(base + '/vendor/pdf.min.mjs');
    assert.match(mjs.headers.get('content-type') || '', /javascript/);
  });

  // admin login from this machine, then a room
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const roomRes = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'AGM 2026' }) });
  const { code } = await roomRes.json();
  assert.match(code, /^[A-Z0-9]{6}$/);

  await t.test('admin login refuses requests that came through the tunnel', async () => {
    const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(r.status, 403);
  });

  const board = await connect(base); sockets.push(board);
  const research = await connect(base); sockets.push(research);
  const jb = await emit(board, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: 'u-forged-client-id' });
  const jr = await emit(research, 'join', { roomCode: code, name: 'Ana', role: 'research' });

  await t.test('identities are issued by the server; a client-made id is replaced', () => {
    assert.ok(jb.ok && jr.ok);
    assert.ok(jb.identity && jb.identity.includes('.'));
    assert.notEqual(jb.uid, 'u-forged-client-id');
    assert.ok(jb.uploadToken && jr.uploadToken);
  });

  await t.test('names are unique per meeting (case-insensitive)', async () => {
    const other = await connect(base); sockets.push(other);
    const r = await emit(other, 'join', { roomCode: code, name: 'chair', role: 'board' });
    assert.equal(r.ok, false);
  });

  let seqAfterHello;
  await t.test('messages carry a sequence number and reach the room', async () => {
    const got = new Promise((r) => board.once('message', r));
    const ack = await emit(research, 'message', { type: 'text', text: 'Capex is on slide 14' });
    const m = await got;
    assert.ok(ack.ok && Number.isInteger(m.seq) && m.seq === ack.seq);
    seqAfterHello = m.seq;
  });

  await t.test('only the author can delete', async () => {
    const mine = await emit(research, 'message', { type: 'text', text: 'delete me' });
    const r = await emit(board, 'delete', { messageId: mine.id });
    assert.equal(r.ok, false);
    assert.equal((await emit(research, 'delete', { messageId: mine.id })).ok, true);
  });

  await t.test('file messages must point at a real upload', async () => {
    for (const url of ['javascript:alert(1)', 'https://evil.example/x.pdf', '/uploads/../server.js', '/uploads/1-abc-x.pdf']) {
      const r = await emit(research, 'message', { type: 'file', url, filename: 'x.pdf' });
      assert.equal(r.ok, false, url);
    }
  });

  await t.test('uploads: token required, content checked, served safely', async () => {
    const form = (name, bytes, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); return f; };
    const noToken = await fetch(base + '/api/upload', { method: 'POST', body: form('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), 'image/png') });
    assert.equal(noToken.status, 403);
    const h = { 'X-AGM-Upload': jr.uploadToken };
    const html = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.html', '<script>alert(1)</script>', 'text/html') });
    assert.equal(html.status, 400, 'html refused');
    const fakePdf = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.pdf', '<script>alert(1)</script>', 'application/pdf') });
    assert.equal(fakePdf.status, 400, 'a pdf that is not a pdf');
    const svgTxt = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.txt', '<svg onload=alert(1)>', 'text/plain') });
    assert.equal(svgTxt.status, 400, 'markup in a text file');
    const png = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png') });
    assert.equal(png.status, 200);
    const up = await png.json();
    const served = await fetch(base + up.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    const sent = await emit(research, 'message', { type: 'file', url: up.url, filename: 'chart.png', mime: 'text/html' });
    assert.ok(sent.ok);
    const traversal = await fetch(base + '/uploads/..%2Fserver.js');
    assert.equal(traversal.status, 404);
  });

  await t.test('a reconnecting client gets just what it missed', async () => {
    const late = await connect(base); sockets.push(late);
    const first = await emit(late, 'join', { roomCode: code, name: 'Obs', role: 'observer' });
    assert.ok(Array.isArray(first.history));
    late.close();
    await emit(research, 'message', { type: 'text', text: 'while you were away' });
    const again = await connect(base); sockets.push(again);
    const back = await emit(again, 'join', { roomCode: code, name: 'Obs', role: 'observer', uid: first.identity, since: first.seq });
    assert.ok(Array.isArray(back.ops), 'delta, not history');
    assert.ok(back.ops.some((op) => op.o === 'add' && op.m.text === 'while you were away'));
    assert.ok(!back.history);
  });

  await t.test('observers read but do not post', async () => {
    const o = await connect(base); sockets.push(o);
    await emit(o, 'join', { roomCode: code, name: 'Watcher', role: 'observer' });
    assert.equal((await emit(o, 'message', { type: 'text', text: 'hi' })).ok, false);
  });

  await t.test('locked rooms need an invite for board and research', async () => {
    const adminSock = await connect(base, cookie); sockets.push(adminSock);
    const lock = await emit(adminSock, 'admin:lockRoles', { roomCode: code, on: true });
    assert.ok(lock.ok && lock.invites.board.includes('invite='));
    const a = await connect(base); sockets.push(a);
    const noInvite = await emit(a, 'join', { roomCode: code, name: 'Gate', role: 'board' });
    assert.equal(noInvite.role, 'observer');
    const b = await connect(base); sockets.push(b);
    const inv = new URL(base + lock.invites.board).searchParams.get('invite');
    const withInvite = await emit(b, 'join', { roomCode: code, name: 'Director 2', role: 'board', invite: inv });
    assert.equal(withInvite.role, 'board');
    const wrongRole = await connect(base); sockets.push(wrongRole);
    const misuse = await emit(wrongRole, 'join', { roomCode: code, name: 'Sneaky', role: 'research', invite: inv });
    assert.equal(misuse.role, 'observer', 'a board invite is not a research invite');
    await emit(adminSock, 'admin:lockRoles', { roomCode: code, on: false });
  });

  await t.test('AI and stage refuse politely when not configured', async () => {
    const d = await emit(research, 'ai:draft', { question: 'What was capex?' });
    assert.equal(d.ok, false);
    assert.match(d.error, /API key/);
    assert.equal((await emit(board, 'ai:draft', {})).ok, false, 'board cannot draft');
    const s = await emit(research, 'stage:send', { text: 'Hello' });
    assert.equal(s.ok, false);
  });

  await t.test('flooding is rate limited', async () => {
    let refused = 0;
    const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => emit(research, 'message', { type: 'text', text: 'spam ' + i })));
    for (const a of acks) if (!a.ok) refused++;
    assert.ok(refused > 10, 'refused ' + refused);
  });

  await t.test('guessing room codes locks out', async () => {
    let last;
    for (let i = 0; i < 14; i++) last = await fetch(base + '/api/rooms/ZZZZZ' + (i % 10));
    assert.equal(last.status, 429);
  });

  await t.test('history survives a restart (log replay)', async () => {
    sockets.forEach((s) => s.close());
    await stop(child);
    child = await startServer(dataDir, port);
    const s = await connect(base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: jb.identity });
    assert.ok(j.ok);
    assert.equal(j.uid, jb.uid, 'same person after restart');
    assert.ok(j.history.some((m) => m.text === 'Capex is on slide 14'));
    assert.ok(j.history.some((m) => m.text === 'while you were away'));
    assert.ok(!j.history.some((m) => m.text === 'delete me'));
    assert.ok(j.seq > seqAfterHello);
  });
});
