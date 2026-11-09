'use strict';
// End-to-end tests: a real server in a child process on a free port with a throwaway data folder.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'testadmintoken01';


async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.channel) child.channel.unref();
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
const { stopServer: stop, freePort, pngOf, inviteOf } = require('./helpers');   // asked over IPC, so it saves first on Windows too
const startup = require('../lib/startup');
const machine = require('../machine');

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

  // pdf.js's worker decodes JPEG 2000 with WebAssembly, and a worker loaded by its address runs under its own script's
  // policy: that one response, by its exact path, may compile WebAssembly ('wasm-unsafe-eval', never 'unsafe-eval'); the
  // pages, the screen page, pdf.js's own module, the document worker and the readers keep the strict policy.
  await t.test('pdf.js\'s worker alone may run WebAssembly: its own response, by its exact path', async () => {
    const scriptSrc = (csp) => { const m = /(?:^|;\s*)script-src ([^;]+)/.exec(csp || ''); return m ? m[1] : null; };
    const worker = await fetch(base + '/vendor/pdf.worker.min.mjs');
    assert.equal(worker.status, 200);
    const workerCsp = worker.headers.get('content-security-policy');
    assert.equal(scriptSrc(workerCsp), "'self' 'wasm-unsafe-eval'");
    assert.ok(!/'unsafe-eval'/.test(workerCsp), 'WebAssembly only, never eval');
    const strict = (await fetch(base + '/index.html')).headers.get('content-security-policy');
    assert.equal(workerCsp, strict.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"), 'the strict policy but its script-src');
    for (const p of ['/app.html', '/display.html', '/d/' + 'a'.repeat(43), '/vendor/pdf.min.mjs', '/docworker.js', '/docview.mjs', '/docmodel.mjs', '/wordpages.js']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.equal(scriptSrc(r.headers.get('content-security-policy')), "'self'", p + ': the strict script-src');
    }
    // Near misses of the worker's path (not served) never carry it either.
    for (const p of ['/vendor/pdf.worker.min.mjs.map', '/VENDOR/pdf.worker.min.mjs', '/vendor/pdf.worker.min.mjs/', '/vendor/x/pdf.worker.min.mjs']) {
      const r = await fetch(base + p);
      assert.ok(!/wasm-unsafe-eval/.test(r.headers.get('content-security-policy') || ''), p + ': no WebAssembly');
    }
  });

  // admin login from this machine, then a room
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const roomRes = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'AGM 2026' }) });
  const { code } = await roomRes.json();
  assert.match(code, /^[A-Z0-9]{6}$/);

  await t.test('the hall page alone frames https pages (a web page on a person\'s page); every other page, the screen page and the transcript frame nothing but AGMessage\'s own', async () => {
    const frameSrc = (csp) => { const m = /(?:^|;\s*)frame-src ([^;]+)/.exec(csp || ''); return m ? m[1] : null; };
    const hallPage = await fetch(base + '/app.html');
    const hallCsp = hallPage.headers.get('content-security-policy');
    assert.equal(frameSrc(hallCsp), "'self' blob: https:");
    assert.match(hallCsp, /frame-ancestors 'self'/);
    assert.equal(hallPage.headers.get('x-frame-options'), 'SAMEORIGIN');
    // The same policy but its frames: the hall page's and the others' differ in frame-src alone.
    const others = ['/', '/index.html', '/halls.html', '/users.html', '/admin.html', '/d/' + 'a'.repeat(43), '/app.js', '/pagelayer.mjs'];
    for (const p of others) {
      const r = await fetch(base + p);
      const csp = r.headers.get('content-security-policy');
      assert.equal(frameSrc(csp), "'self' blob:", p);
      assert.equal(csp, hallCsp.replace("frame-src 'self' blob: https:", "frame-src 'self' blob:"), p + ': the strict policy, whole');
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', p);
    }
    // The transcript keeps a policy of its own, stricter still: no frame-src, so default-src 'none' frames nothing.
    const tr = await fetch(base + '/api/admin/transcript/' + code, { headers: { cookie } });
    assert.equal(tr.status, 200);
    const trCsp = tr.headers.get('content-security-policy');
    assert.equal(frameSrc(trCsp), null);
    assert.match(trCsp, /^default-src 'none'/);
  });

  await t.test('admin login refuses requests that came through the tunnel', async () => {
    const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(r.status, 403);
  });

  const board = await connect(base); sockets.push(board);
  const research = await connect(base); sockets.push(research);
  const jb = await emit(board, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: 'u-forged-client-id', invite: inviteOf(dataDir, code) });
  const jr = await emit(research, 'join', { roomCode: code, name: 'Ana', role: 'research' });

  await t.test('identities are issued by the server; a client-made id is replaced', () => {
    assert.ok(jb.ok && jr.ok);
    assert.ok(jb.identity && jb.identity.includes('.'));
    assert.notEqual(jb.uid, 'u-forged-client-id');
    // Backstage shares files; On stage sends messages, not files, so it is given no upload token.
    assert.ok(jr.uploadToken);
    assert.equal(jb.uploadToken, null);
  });

  await t.test('names are unique per room (case-insensitive)', async () => {
    const other = await connect(base); sockets.push(other);
    const r = await emit(other, 'join', { roomCode: code, name: 'chair', role: 'board' });
    assert.deepEqual(r, { ok: false, error: 'That name is already in use in this room. Please pick a different display name.' });
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
    // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
    for (const url of ['javascript:alert(1)', 'https://evil.example/x.pdf', '/uploads/../server.js', '/uploads/1-abc-x.pdf']) {
      const r = await emit(research, 'message', { type: 'file', url, filename: 'x.pdf' });
      assert.equal(r.ok, false, url);
    }
  });

  await t.test('uploads: token required, content checked, served safely', async () => {
    const form = (name, bytes, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); return f; };
    const noToken = await fetch(base + '/api/upload', { method: 'POST', body: form('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), 'image/png') });
    assert.deepEqual([noToken.status, await noToken.json()], [403, { error: 'Join a room to share files.' }]);
    const h = { 'X-AGM-Upload': jr.uploadToken };
    const html = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.html', '<script>alert(1)</script>', 'text/html') });
    assert.equal(html.status, 400, 'html refused');
    const fakePdf = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.pdf', '<script>alert(1)</script>', 'application/pdf') });
    assert.equal(fakePdf.status, 400, 'a pdf that is not a pdf');
    const svgTxt = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.txt', '<svg onload=alert(1)>', 'text/plain') });
    assert.equal(svgTxt.status, 400, 'markup in a text file');
    const png = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('chart.png', pngOf(), 'image/png') });
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
    assert.deepEqual([noInvite.ok, noInvite.role, noInvite.note], [true, 'observer', 'On stage seats need the invite link — you joined as an observer.'], 'On stage: the words of every hall');
    const g2 = await connect(base); sockets.push(g2);
    const noResearch = await emit(g2, 'join', { roomCode: code, name: 'Gate 2', role: 'research' });
    assert.deepEqual([noResearch.ok, noResearch.role, noResearch.note], [true, 'observer', 'This room needs an invite link for that seat — you joined as an observer.'], 'a locked room keeps its words for a backstage seat');
    const b = await connect(base); sockets.push(b);
    const inv = new URL(base + lock.invites.board).searchParams.get('invite');
    const withInvite = await emit(b, 'join', { roomCode: code, name: 'Director 2', role: 'board', invite: inv });
    assert.equal(withInvite.role, 'board');
    const wrongRole = await connect(base); sockets.push(wrongRole);
    const misuse = await emit(wrongRole, 'join', { roomCode: code, name: 'Sneaky', role: 'research', invite: inv });
    assert.equal(misuse.role, 'observer', 'a board invite is not a research invite');
    await emit(adminSock, 'admin:lockRoles', { roomCode: code, on: false });
  });

  await t.test('join fails closed: a role the page does not offer is refused and seats nobody; none is an observer, director is On stage', async () => {
    const adminSock = await connect(base, cookie); sockets.push(adminSock);
    const seated = async () => (await new Promise((resolve) => { adminSock.emit('admin:listRooms', resolve); })).rooms.find((r) => r.code === code).users.map((u) => u.name + ':' + u.role);
    // A guest's join first: it clears this address's count of failed joins, so the refusals below are read against it.
    const opener = await connect(base); sockets.push(opener);
    assert.ok((await emit(opener, 'join', { roomCode: code, name: 'Opener', role: 'observer' })).ok);
    // Eleven, one more than the code lock allows: an unknown role is not a guess at a code.
    const refused = [];
    const s = await connect(base); sockets.push(s);
    for (const role of ['admin', 7, 'Board', '', ['board'], { toString: 1 }, 'admin', 'owner', 'research ', true, 'observers']) {
      refused.push(await emit(s, 'join', { roomCode: code, name: 'Role ' + refused.length, role }));
      assert.equal((await emit(s, 'message', { type: 'text', text: 'seated?' })).error, 'Not joined', JSON.stringify(role) + ' seats nobody');
    }
    assert.deepEqual(refused, Array(11).fill({ ok: false, error: 'Choose On stage, Backstage or Observer.' }));
    assert.ok(!(await seated()).some((u) => u.startsWith('Role ')), 'nobody seated under any of them');
    const none = await connect(base); sockets.push(none);
    const nj = await emit(none, 'join', { roomCode: code, name: 'No Role' });
    const nul = await connect(base); sockets.push(nul);
    const ullj = await emit(nul, 'join', { roomCode: code, name: 'Null Role', role: null });
    const old = await connect(base); sockets.push(old);
    const oj = await emit(old, 'join', { roomCode: code, name: 'Old Link', role: 'director', invite: inviteOf(dataDir, code) });
    assert.deepEqual([nj.ok, nj.role, ullj.ok, ullj.role, oj.ok, oj.role], [true, 'observer', true, 'observer', true, 'board'], 'eleven refusals spent nothing of the code lock');
    assert.deepEqual((await seated()).filter((u) => / Role|Old Link/.test(u)).sort(), ['No Role:observer', 'Null Role:observer', 'Old Link:board']);
  });

  await t.test('userState:push relays to the person\'s other pages only the keys a page applies, each by its type and rebuilt', async () => {
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const one = await connect(base); sockets.push(one);
    const first = await emit(one, 'join', { roomCode: code, name: 'Kim Two Tabs', role: 'research' });
    const two = await connect(base); sockets.push(two);
    assert.ok((await emit(two, 'join', { roomCode: code, name: 'Kim Two Tabs', role: 'research', uid: first.identity })).ok);
    const other = await connect(base); sockets.push(other);
    assert.ok((await emit(other, 'join', { roomCode: code, name: 'Not Kim', role: 'research' })).ok);
    const faults = async () => (await (await fetch(base + '/api/health', { headers: { cookie } })).json()).handlerFaults;
    const faultsBefore = await faults();
    assert.equal(typeof faultsBefore, 'number');
    const heard = []; const otherHeard = [];
    two.on('userState:push', (p) => heard.push(p));
    other.on('userState:push', (p) => otherHeard.push(p));
    const U = { toString: 1 };
    const sends = [
      { key: 'theme', value: 'dark' }, { key: 'theme', value: 'red' }, { key: 'theme', value: U },
      { key: 'zoom', value: 1.3 }, { key: 'zoom', value: '2' }, { key: 'zoom', value: null },
      { key: 'stageCollapsed', value: true }, { key: 'stageCollapsed', value: 'yes' },
      { key: 'split', value: { pct: 40, vertical: false, html: '<img src=x>' } }, { key: 'split', value: { pct: '40', vertical: false } },
      { key: 'split', value: { pct: 400, vertical: false } }, { key: 'split', value: { pct: 40 } },
      { key: 'doc', value: { messageId: 'abc123def456', url: 'https://evil.example/' } }, { key: 'doc', value: null },
      { key: 'doc', value: { messageId: 7 } }, { key: 'doc', value: { messageId: '<img src=x>' } },
      { key: 'script', value: 'x' }, { key: '__proto__', value: { polluted: true } }, { key: 'toString', value: 'x' }, { key: U, value: U },
      'theme', ['theme', 'dark'], { theme: 'dark' },
    ];
    for (const [i, p] of sends.entries()) { one.emit('userState:push', p); if (i % 8 === 7) await wait(1000); }   // under the chatter allowance
    one.emit('userState:push', { key: 'theme', value: 'light' });   // the last: everything before it has been read
    const end = Date.now() + 3000;
    while (Date.now() < end && !heard.some((p) => p.value === 'light')) await wait(50);
    assert.deepEqual(heard, [
      { key: 'theme', value: 'dark' }, { key: 'zoom', value: 1.3 }, { key: 'stageCollapsed', value: true },
      { key: 'split', value: { pct: 40, vertical: false } }, { key: 'doc', value: { messageId: 'abc123def456' } }, { key: 'doc', value: null },
      { key: 'theme', value: 'light' },
    ]);
    assert.deepEqual(otherHeard, [], 'another person in the hall hears none of it');
    assert.equal((await faults()), faultsBefore, 'each value was read by its type; the guard had nothing to catch');
  });

  await t.test('the admin page closing the hall it is watching gets its answer and stays connected; the hall\'s people are sent home', async () => {
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });
    const page = await connect(base, cookie); sockets.push(page);
    const other = await connect(base, cookie); sockets.push(other);   // a second admin tab on the same hall
    const made = await emit(page, 'admin:createRoom', { name: 'Close me' });
    assert.ok((await emit(page, 'admin:watchRoom', { roomCode: made.code })).ok);
    assert.ok((await emit(other, 'admin:watchRoom', { roomCode: made.code })).ok);
    const member = await connect(base); sockets.push(member);
    assert.ok((await emit(member, 'join', { roomCode: made.code, name: 'Last one', role: 'board' })).ok);
    const kicked = [];
    page.on('kicked', (k) => kicked.push(k));
    other.on('kicked', (k) => kicked.push(k));
    const memberKicked = new Promise((resolve) => { member.once('kicked', resolve); });
    const memberGone = new Promise((resolve) => { member.once('disconnect', resolve); });
    const otherTold = new Promise((resolve) => { other.once('roomClosed', resolve); });
    const answer = await Promise.race([emit(page, 'admin:deleteRoom', { roomCode: made.code, purgeFiles: false }), wait(3000).then(() => 'no answer')]);
    assert.deepEqual({ answer, connected: page.connected }, { answer: { ok: true, purged: 0 }, connected: true });
    assert.deepEqual(await otherTold, { code: made.code }, 'the other admin tab is told, not cut off');
    assert.equal((await memberKicked).reason, 'This hall was closed by the admin.');
    assert.equal(await memberGone, 'io server disconnect');
    const rooms = await ask(page, 'admin:listRooms');
    assert.ok(rooms.ok && !rooms.rooms.some((r) => r.code === made.code));
    assert.ok((await ask(other, 'admin:listRooms')).ok && other.connected);
    assert.deepEqual(kicked, [], 'no admin page was sent home');
  });

  await t.test('the server says what happened in one word per thing: a seat as pages name it, Clear messages, Log out and the transcript naming the hall', async () => {
    const adminSock = await connect(base, cookie); sockets.push(adminSock);
    const named = await emit(adminSock, 'admin:createRoom', { name: 'Hall 2' });
    const plain = await emit(adminSock, 'admin:createRoom', { name: '' });
    const seat = async (hall, name) => {
      const s = await connect(base); sockets.push(s);
      const j = await emit(s, 'join', { roomCode: hall, name, role: 'research' });
      assert.ok(j.ok, name);
      return s;
    };
    const kim = await seat(named.code, 'Kim');
    const lou = await seat(plain.code, 'Lou');
    // Each join is said in the seat's words, the ones every page shows for it.
    for (const [name, role] of [['Bea', 'board'], ['Obi', 'observer']]) {
      const s = await connect(base); sockets.push(s);
      assert.equal((await emit(s, 'join', { roomCode: named.code, name, role, invite: inviteOf(dataDir, named.code) })).role, role, name);
    }
    const said = await connect(base); sockets.push(said);
    const joins = (await emit(said, 'join', { roomCode: named.code, name: 'Sal', role: 'observer' })).history.filter((m) => m.type === 'system').map((m) => m.text);
    assert.deepEqual(joins, ['Kim joined Backstage', 'Bea joined On stage', 'Obi joined as an observer']);
    assert.ok((await emit(kim, 'message', { type: 'text', text: 'before the clear' })).ok);
    const cleared = new Promise((resolve) => { kim.on('system', (m) => { if (/cleared/.test(m.text)) resolve(m.text); }); });
    assert.deepEqual(await emit(adminSock, 'admin:resetRoom', { roomCode: named.code }), { ok: true, removed: 0 });
    assert.equal(await cleared, '— Messages cleared by the admin —');
    const reader = await connect(base); sockets.push(reader);
    const history = (await emit(reader, 'join', { roomCode: named.code, name: 'Reader', role: 'observer' })).history;
    assert.deepEqual(history.map((m) => [m.type, m.text]).slice(0, 1), [['system', '— Messages cleared by the admin —']], 'the hall\'s history starts again at the line');
    // Logged out: each page hears who sent it out and of where (the room by the name its page shows), then is closed.
    for (const [page, hall, words] of [[kim, named.code, 'An admin sent you out of Hall 2.'], [lou, plain.code, 'An admin sent you out of this hall.']]) {
      const told = new Promise((resolve) => { page.once('kicked', resolve); });
      const gone = new Promise((resolve) => { page.once('disconnect', resolve); });
      const list = await new Promise((resolve) => { adminSock.emit('admin:listRooms', resolve); });
      const sid = list.rooms.find((r) => r.code === hall).users.find((u) => u.name === (page === kim ? 'Kim' : 'Lou')).socketId;
      assert.deepEqual(await emit(adminSock, 'admin:kick', { socketId: sid }), { ok: true });
      assert.deepEqual([await told, await gone], [{ reason: words }, 'io server disconnect']);
    }
    const transcript = async (hall) => (await fetch(base + '/api/admin/transcript/' + hall, { headers: { cookie } })).text();
    const title = (html) => [/<title>([^<]*)<\/title>/.exec(html)[1], /<h1>([^<]*)<\/h1>/.exec(html)[1]];
    assert.deepEqual(title(await transcript(plain.code)), ['AGMessage transcript', 'AGMessage transcript']);
    assert.deepEqual(title(await transcript(named.code)), ['Hall 2 — transcript', 'Hall 2']);
    // The two halls go again: the show desk's notice below counts the halls that are open.
    for (const hall of [named.code, plain.code]) assert.ok((await emit(adminSock, 'admin:deleteRoom', { roomCode: hall, purgeFiles: false })).ok, hall);
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

  const ctl = await connect(base, cookie); sockets.push(ctl);
  await t.test('Show Bus context: token or admin only, counts and prompt questions — no messages, names or room names', async () => {
    assert.equal((await fetch(base + '/api/context')).status, 401);
    assert.equal((await fetch(base + '/api/context', { headers: { authorization: 'Bearer agn_wrong' } })).status, 401);
    await new Promise((r) => setTimeout(r, 1500));   // the flood test above emptied this person's rate limit
    const posted = await emit(research, 'message', { type: 'action', text: 'Refer to slide 14?', options: ['Yes', 'No'] });
    assert.ok(posted.ok, 'prompt posted: ' + JSON.stringify(posted));
    const settings = await emit(ctl, 'admin:settings', null);
    assert.match(settings.contextToken, /^agn_/);
    assert.match(settings.nodeId, /^[0-9a-f]{8}$/);
    const r = await fetch(base + '/api/context', { headers: { authorization: 'Bearer ' + settings.contextToken } });
    assert.equal(r.status, 200);
    const ctx = await r.json();
    assert.equal(ctx.v, 1);
    assert.equal(ctx.node.t, 'messenger');
    assert.equal(ctx.node.id, settings.nodeId);
    assert.ok(['green', 'amber', 'red', 'grey'].includes(ctx.light));
    assert.ok(ctx.items.some((i) => i.kind === 'prompt' && /Refer to slide 14/.test(i.state)), 'open prompt questions are listed');
    // How the node runs, a folder run naming no folder; never the laptop's admin or the grants.
    assert.deepEqual(ctx.install, { runs: 'portable', installed: false, dir: null, light: 'grey', words: 'run from a folder (the portable copy)' });
    const text = JSON.stringify(ctx);
    for (const secret of ['Capex is on slide 14', 'Chair', 'Ana', 'AGM 2026', code]) assert.ok(!text.includes(secret), 'context leaks ' + secret);
    const viaCookie = await fetch(base + '/api/context', { headers: { cookie } });
    assert.equal(viaCookie.status, 200);
  });

  await t.test('health: up/down for anyone, the detail only for the admin or this laptop', async () => {
    const local = await (await fetch(base + '/api/health')).json();
    assert.ok(local.ok && 'restarts' in local && 'loopMs' in local, 'detail on the host');
    const remote = await (await fetch(base + '/api/health', { headers: { 'cf-connecting-ip': '203.0.113.9' } })).json();
    assert.deepEqual(Object.keys(remote).sort(), ['build', 'ok', 'uptime', 'version']);
    // How it runs, on the host's detail: the portable folder, which names no folder of its own. A copy refused at the port
    // reads `install.runs` from here with no token, and machine.js reads it within its answer's bound (64 KB).
    assert.deepEqual(local.install, { runs: 'portable', installed: false, dir: null, light: 'grey', words: 'run from a folder (the portable copy)' });
    const raw = await (await fetch(base + '/api/health')).text();
    assert.ok(Buffer.byteLength(raw) < 64 * 1024, 'the host\'s health fits machine.js\'s bound: ' + Buffer.byteLength(raw) + ' bytes');
    assert.deepEqual(await startup.readPortHolder(port), { version: local.version, build: local.build, runs: 'portable' }, 'the start\'s holder reader');
    assert.deepEqual(await machine.healthOf(port), { version: local.version, build: local.build, runs: 'portable' }, 'machine.js\'s holder reader');
    assert.ok(remote.build.startsWith(remote.version + '-dev') || remote.build.startsWith(remote.version + '+'), 'the build names its version and channel: ' + remote.build);
  });

  await t.test('every write lane the server made is one a stop or a crash flushes, by the object: the lanes made, the distinct lanes named and their names agree', async () => {
    const { saves } = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(Object.keys(saves).slice(-2), ['built', 'named'], 'appended at the end of the saves');
    // A lane's row is {writes, error, failures}; the rooms' op log and the audit log are not lanes and say other things.
    const lanes = Object.keys(saves.stores).filter((name) => ['writes', 'error', 'failures'].every((k) => k in saves.stores[name]));
    for (const name of ['accounts', 'screens', 'pages', 'auditHead', 'peaks']) assert.ok(lanes.includes(name), 'a lane made in lib/ or server.js is named: ' + name + ' in ' + lanes.join(', '));
    // Each name a lane of its own (a lane under two names, or a name given twice, makes these differ), and every lane
    // made among them: the named lanes are lanes this process made, so as many named as made is every one.
    assert.equal(saves.named, lanes.length, saves.named + ' distinct lanes named, under ' + lanes.length + ' names: ' + lanes.join(', '));
    assert.equal(saves.built, saves.named, saves.built + ' lanes made, ' + saves.named + ' named: ' + lanes.join(', '));
  });

  // No timing is asserted end to end: the first window holds the boot's work, and CI runs under coverage.
  let peaksBefore = null;
  await t.test('health reads how busy the server is, its memory, its sockets, the largest hall and a show day\'s peaks', async () => {
    const health = async () => (await fetch(base + '/api/health')).json();
    const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });
    const h = await health();
    assert.deepEqual(Object.keys(h).slice(-19), ['elu', 'rssMb', 'maxSocketsPerAddress', 'tunnelSockets', 'largestHall', 'latest', 'peaks', 'showDay', 'tunnel', 'refused', 'acceptErrors', 'format', 'sleeps', 'power', 'lastStop', 'event', 'signins', 'install', 'sideRooms'], 'appended at the end of the detail');
    // The accounts and the sign-ins as the start opened them (lib/keyedstore.js): no secret, no hash.
    assert.deepEqual(Object.keys(h.signins), ['accounts', 'sessions', 'adminSessions', 'record', 'set', 'gens', 'changed']);
    assert.deepEqual([h.signins.accounts.state, h.signins.record.state], [h.signins.accounts.state === 'none' ? 'none' : 'ok', 'ok']);
    // The current event: a folder's first, not named and never archived.
    assert.deepEqual([Object.keys(h.event), h.event.name, h.event.kind, h.event.from, h.event.archives], [['id', 'name', 'began', 'kind', 'from', 'archives'], '', 'first', '', 0]);
    assert.match(h.event.id, /^e[0-9a-z]{8,24}$/);
    // `rooms` counts the halls, each its Main room; `sideRooms` the rooms beside them, none in a new folder.
    assert.deepEqual([typeof h.rooms, h.sideRooms], ['number', 0]);
    // A new folder: no stop before this start, and no hall told AGMessage restarted.
    assert.deepEqual(h.lastStop, { state: 'none', saved: false, at: null, build: '', unsaved: [], code: '', said: 0, left: '' });
    assert.deepEqual(h.sleeps, { watched: false, list: [] }, 'no watchdog runs a server started alone: none recorded');
    assert.deepEqual(Object.keys(h.power), ['state', 'live', 'why', 'since', 'what']);
    assert.ok(h.power.live >= 1, 'pages are seated in a hall: it is live');
    if (process.platform !== 'win32') assert.deepEqual([h.power.state, h.power.why], ['unavailable', 'AGMessage is not running on Windows']);
    assert.deepEqual(h.acceptErrors, { count: 0, last: '' }, 'no connection the port could not take');
    assert.deepEqual(h.format, { format: 2, was: 0, before: '', newer: null, backup: '' }, 'a new folder, marked by this build: no build named before it');
    assert.deepEqual(Object.keys(h.elu), ['count', 'p50', 'p95', 'max']);
    assert.ok(Number.isInteger(h.rssMb) && h.rssMb > 0, 'rssMb ' + h.rssMb);
    assert.deepEqual(Object.keys(h.maxSocketsPerAddress), ['venue', 'tunnel'], 'per lane');
    assert.ok(h.maxSocketsPerAddress.venue >= 3 && h.maxSocketsPerAddress.venue <= h.clients, 'every page here is on one address: ' + h.maxSocketsPerAddress.venue + ' of ' + h.clients);
    assert.deepEqual([h.tunnelSockets, h.maxSocketsPerAddress.tunnel], [0, 0]);
    // The tunnel's places (150, half for one network) and today's refusals, by lane (counts only), and no tunnel's end.
    assert.deepEqual(h.tunnel, { places: 0, max: 150, share: 75, networks: 0, refused: { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, until: null });
    assert.deepEqual(h.refused, { venue: { rate: 0 } });

    // A page and a screen through the tunnel are counted, and their address is in no reading.
    const tunnelHeaders = { 'cf-connecting-ip': '203.0.113.50', 'cf-ray': '8f00aa' };
    const opened = (s) => new Promise((resolve, reject) => { s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
    const viaTunnel = await opened(io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: tunnelHeaders }));
    sockets.push(viaTunnel);
    const made = await emit(ctl, 'display:create', { code, name: 'Foyer TV' });
    assert.ok(made.ok, JSON.stringify(made));
    const screenViaTunnel = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) }, extraHeaders: tunnelHeaders });
    sockets.push(screenViaTunnel);
    const shown = new Promise((resolve) => { screenViaTunnel.once('display:state', resolve); });
    await opened(screenViaTunnel);
    await shown;   // served as a screen, not as a page
    const counted = await health();
    assert.equal(counted.tunnelSockets, 2, 'the page and the screen');
    assert.deepEqual([counted.tunnel.places, counted.tunnel.networks, counted.maxSocketsPerAddress.tunnel], [2, 1, 2], 'each takes a place, from one network');
    assert.ok(!JSON.stringify(counted).includes('203.0.113.50'), 'health names no address');
    viaTunnel.close(); screenViaTunnel.close();
    assert.ok((await emit(ctl, 'display:remove', { id: made.display.id })).ok);
    let gone = counted;
    for (let i = 0; i < 40 && gone.tunnelSockets; i++) { await new Promise((r) => setTimeout(r, 50)); gone = await health(); }
    assert.equal(gone.tunnelSockets, 0, 'and no longer once they have gone');

    // The largest hall follows its messages: what health reads is what the hall holds.
    for (const text of ['one', 'two', 'three']) assert.equal((await emit(board, 'message', { type: 'text', text })).ok, true);
    let read = null;
    for (let i = 0; i < 20 && !read; i++) {
      const most = async () => Math.max(...(await ask(ctl, 'admin:listRooms')).rooms.map((r) => r.messageCount));
      const a = await most(); const big = (await health()).largestHall; const b = await most();
      if (a === b && big.messages === a) read = big;   // a "left" line landing between the reads asks again
    }
    assert.ok(read && read.messages >= h.largestHall.messages + 3, 'largestHall ' + JSON.stringify(read) + ' after ' + JSON.stringify(h.largestHall));
    assert.ok(typeof read.kb === 'number' && read.kb > 0, 'and its snapshot\'s size, kept when the hall was made');

    // What coalescing saves: each state frame's changes, and the frames sent for them.
    assert.deepEqual(Object.keys(h.latest), ['board', 'screens', 'people', 'seen', 'rooms', 'sends', 'pages', 'also', 'activity']);
    for (const l of Object.values(h.latest)) assert.ok(Number.isInteger(l.marks) && Number.isInteger(l.flushes) && l.flushes <= l.marks, JSON.stringify(h.latest));
    assert.ok(h.latest.board.flushes >= 1, 'the board was sent: ' + JSON.stringify(h.latest.board));
    assert.ok(gone.latest.screens.marks > h.latest.screens.marks, 'a screen made, opened and closed is marked: ' + JSON.stringify(gone.latest.screens));

    // Today's peaks, the show day the server names: the hall made at the start and the sign-in's audit row are in them.
    assert.match(h.showDay, /^\d{4}-\d{2}-\d{2}$/);
    const today = h.peaks.find((d) => d.day === h.showDay);
    assert.ok(today, 'today has its record: ' + JSON.stringify(h.peaks.map((d) => d.day)));
    assert.deepEqual(Object.keys(today), ['day', 'loopMs', 'elu', 'socketsPerAddress', 'tunnelSockets', 'tunnelRefused', 'hallMessages', 'hallKb', 'joinBurst', 'compactMs', 'auditPutMs', 'at', 'sleeps', 'sleptMs', 'pageHiddenMs']);
    assert.deepEqual(Object.keys(today.socketsPerAddress), ['venue', 'tunnel']);
    assert.match(today.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(today.auditPutMs), ['count', 'p99', 'max']);
    assert.ok(today.auditPutMs.count >= 1, 'the sign-in\'s audit append is counted: ' + JSON.stringify(today.auditPutMs));
    assert.deepEqual(Object.keys(today.compactMs), ['max', 'messages']);
    peaksBefore = today;
  });

  await t.test('saved keys are sealed at rest, never in clear', async () => {
    await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:1', stagewatchKey: 'swk_secretvalue123', aiKey: 'sk-ant-secret' });
    await new Promise((r) => setTimeout(r, 400));   // the write lane coalesces for 100 ms
    const onDisk = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    assert.ok(!onDisk.includes('swk_secretvalue123') && !onDisk.includes('sk-ant-secret'), 'no clear keys on disk');
    assert.match(onDisk, /enc1:/);
    const s2 = await emit(ctl, 'admin:settings', null);
    assert.equal(s2.stagewatchKeySet, true);
    await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '', aiKey: '' });
  });

  await t.test('send to stage: the receipt, then the speaker\'s acknowledgement, show on the message that was sent', async () => {
    const http = require('http');
    const { WebSocketServer } = require('ws');
    let ws = null;
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/message/')) return res.end(JSON.stringify({ type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', refs: { messageId: 77 } }));
      if (req.url === '/api/context') return res.end('{"v":1,"node":{"t":"main","id":"sw1","name":"Keynote"}}');
      res.end('{"ok":true}');
    });
    const wss = new WebSocketServer({ server: fake, path: '/ws' });
    wss.on('connection', (c) => { ws = c; c.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })); });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    try {
      await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:' + fake.address().port, stagewatchKey: 'swk_node' });
      for (let i = 0; i < 60; i++) { if (ws) break; await new Promise((r) => setTimeout(r, 50)); }
      assert.ok(ws, 'AGMessage linked to the fake Stagewatch');
      await new Promise((r) => setTimeout(r, 300));
      const acks = [];
      board.on('stageAck', (a) => acks.push(a));
      const sent = await emit(research, 'stage:send', { text: 'Capex was 4.2m' });
      assert.deepEqual([sent.ok, sent.stage, sent.messageId], [true, 'applied', 77]);
      ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '04:59', title: 'Keynote', messageId: 77, messageAck: 'done', messageAckBy: 'Sam' }));
      for (let i = 0; i < 60 && !acks.some((a) => a.stage.ack === 'done'); i++) await new Promise((r) => setTimeout(r, 50));
      const done = acks.find((a) => a.stage.ack === 'done');
      assert.ok(done, 'acknowledgement reached the room: ' + JSON.stringify(acks));
      assert.deepEqual([done.stage.by, done.stage.receipt, done.stage.ref], ['Sam', 'applied', 77]);
    } finally {
      board.removeAllListeners('stageAck');
      await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '' });
      wss.close(); fake.close();
    }
  });

  await t.test('HTTPS on the same port: pages, Socket.io, /tls and the certificate; the fingerprint in health and settings', async () => {
    const tlsmod = require('../lib/tls');
    const probe = await tlsmod.probeCertificate('127.0.0.1', port);
    const pinned = tlsmod.pinnedTlsOptions(probe.pem, probe.fp);
    const page = await tlsmod.request(`https://127.0.0.1:${port}/app.html`, { tls: pinned });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/i);
    const cer = await fetch(base + '/tls.cer');
    assert.equal(cer.headers.get('content-type'), 'application/pkix-cert');
    assert.equal(tlsmod.fingerprint(Buffer.from(await cer.arrayBuffer())), probe.fp, '/tls.cer is the certificate served');
    const info = await (await fetch(base + '/tls')).text();
    assert.ok(info.includes(probe.fp.slice(7, 9).toUpperCase() + ':'), 'the /tls page shows the fingerprint');
    const s = await emit(ctl, 'admin:settings', null);
    assert.deepEqual([s.tls.on, s.tls.fingerprint], [true, probe.fp]);
    // Socket.io over TLS, trusting exactly this certificate.
    const sec = io(`https://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, ca: probe.pem });
    await new Promise((resolve, reject) => { sec.once('connect', resolve); sec.once('connect_error', reject); });
    sec.close();
    // Require HTTPS never locks this laptop out (loopback), and only takes effect with a certificate.
    const on = await emit(ctl, 'admin:settings', { requireHttps: true });
    assert.equal(on.tls.requireHttps, true);
    assert.equal((await fetch(base + '/app.html')).status, 200, 'plain HTTP still works from this machine');
    await emit(ctl, 'admin:settings', { requireHttps: false });
  });

  await t.test('show desk: a proposal\'s state follows on the message; an approved notice for AGMessage runs once and reports', async () => {
    const http = require('http');
    const { WebSocketServer } = require('ws');
    let state = 'pending';
    const seen = { proposals: [], results: [] };
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/proposals' && req.method === 'POST') { seen.proposals.push(JSON.parse(body)); return res.end(JSON.stringify({ id: 'p17', state: 'pending' })); }
        // As Stagewatch's SharedProposal.ToJson: result and words one string, ok at the top level (null until it ran).
        const words = state === 'done' ? 'Message on the speaker screen' : '';
        const p17 = { id: 'p17', state, decidedBy: 'SM', result: words, ok: state === 'done' ? true : null, words };
        if (u.pathname === '/api/proposals/p17') return res.end(JSON.stringify(p17));
        // ProposalsFrom: all this node proposed, as {proposals: […]}.
        if (u.pathname === '/api/proposals' && u.searchParams.get('from')) return res.end(JSON.stringify({ proposals: seen.proposals.length ? [p17] : [] }));
        if (u.pathname === '/api/proposals' && u.searchParams.get('target'))
          return res.end(JSON.stringify(seen.results.length ? [] : [{ id: 'p9', state: 'approved', line: 'notice "Break in 5 minutes"', decidedBy: 'SM', target: { t: 'messenger', id: u.searchParams.get('target') } }]));
        if (u.pathname === '/api/proposals') return res.end('[]');
        if (u.pathname === '/api/proposals/p9/result') { seen.results.push(JSON.parse(body)); return res.end('{"ok":true}'); }
        if (u.pathname === '/api/context') return res.end('{"v":1,"node":{"t":"main","id":"sw1","name":"Keynote"}}');
        res.end('{"ok":true}');
      });
    });
    const wss = new WebSocketServer({ server: fake, path: '/ws' });
    wss.on('connection', (c) => c.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })));
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const updates = [];
    const notices = [];
    research.on('proposalUpdate', (u) => updates.push(u));
    board.on('system', (m) => { if (/From the show desk/.test(m.text)) notices.push(m.text); });
    try {
      await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:' + fake.address().port, stagewatchKey: 'swk_node' });
      // The desk is found on the next tick (within ~3 s); proposals are refused until then.
      let r;
      for (let i = 0; i < 40; i++) { r = await emit(research, 'stage:propose', { text: 'Capex was "4.2m"', urgency: 'warn' }); if (r.ok) break; await new Promise((x) => setTimeout(x, 200)); }
      assert.ok(r.ok, 'proposed: ' + JSON.stringify(r));
      assert.deepEqual([r.proposal.id, r.proposal.state], ['p17', 'pending']);
      const sent = seen.proposals[0];
      assert.equal(sent.target.t, 'main');
      // Stagewatch's grammar: a quote inside can't end the text, and the flash ("off") comes before "ack" — an "ack" in the
      // flash's place is refused by Stagewatch ("flash must be off|slow|fast"), the defect 0.4 shipped.
      assert.equal(sent.line, 'message "Capex was \'4.2m\'" warn off ack');
      assert.deepEqual(require('../lib/stagelines').parse(sent.line), { verb: 'message', text: 'Capex was \'4.2m\'', urgency: 'warn', flash: 'off', ack: true });
      assert.equal(sent.from.t, 'messenger');
      state = 'done';
      for (let i = 0; i < 100 && !updates.some((u) => u.proposal.state === 'done'); i++) await new Promise((x) => setTimeout(x, 100));
      const done = updates.find((u) => u.proposal.state === 'done');
      assert.ok(done, 'the state reached the research view: ' + JSON.stringify(updates));
      assert.deepEqual([done.proposal.by, done.proposal.ok, done.proposal.words], ['SM', true, 'Message on the speaker screen']);
      for (let i = 0; i < 100 && !seen.results.length; i++) await new Promise((x) => setTimeout(x, 100));
      assert.deepEqual(seen.results[0], { ok: true, words: 'shown in 1 meeting' });
      assert.ok(notices.some((n) => /approved by SM\): Break in 5 minutes/.test(n)), 'the notice is in the meeting: ' + JSON.stringify(notices));
      const ctx = await (await fetch(base + '/api/context', { headers: { cookie } })).json();
      assert.ok(ctx.commands.some((c) => c.verb === 'notice <text>' && c.risk === 'review'), 'its context says what may be proposed to it');
    } finally {
      research.removeAllListeners('proposalUpdate');
      board.removeAllListeners('system');
      await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '' });
      wss.close(); fake.close();
    }
  });

  await t.test('history survives a restart: a stop that saved says so and no hall says AGMessage restarted; after a kill the log is replayed and each hall says it, once', async () => {
    sockets.forEach((s) => s.close());
    await stop(child);
    // The stop's record, written last: it saved.
    const rec = JSON.parse(fs.readFileSync(path.join(dataDir, 'last-stop.json'), 'utf8'));
    assert.deepEqual([Object.keys(rec), typeof rec.at, typeof rec.build, rec.saved], [['at', 'build', 'saved'], 'number', 'string', true]);
    child = await startServer(dataDir, port);
    const s = await connect(base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: jb.identity });
    assert.ok(j.ok);
    assert.equal(j.uid, jb.uid, 'same person after restart');
    const restartLines = (history) => history.map((m, i) => [m, i]).filter(([m]) => m.type === 'system' && /restarted/.test(m.text));
    assert.deepEqual(restartLines(j.history), [], 'a stop that saved: no restart line: ' + JSON.stringify(j.history.map((m) => m.text)));
    assert.ok(j.history.some((m) => m.text === 'Capex is on slide 14'));
    assert.ok(j.history.some((m) => m.text === 'while you were away'));
    assert.ok(!j.history.some((m) => m.text === 'delete me'));
    assert.ok(j.seq >= seqAfterHello);
    // Moved aside at the start, so a kill of this copy is never read as the stop that saved; health says which it was.
    assert.deepEqual([fs.existsSync(path.join(dataDir, 'last-stop.json')), JSON.parse(fs.readFileSync(path.join(dataDir, 'last-stop.seen.json'), 'utf8'))], [false, rec]);
    const clean = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(clean.lastStop, { state: 'saved', saved: true, at: rec.at, build: rec.build, unsaved: [], code: '', said: 0, left: '' });
    assert.equal(clean.saves.stores.rooms.atStart, 0, 'the stop wrote every hall that changed: the start writes none');

    // A kill: no stop, no record. The log is replayed, and each hall says AGMessage restarted, once, counting what it kept.
    assert.ok((await emit(s, 'message', { type: 'text', text: 'after a stop that saved' })).ok);
    s.close();
    child.kill('SIGKILL');
    await new Promise((resolve) => { child.once('exit', resolve); });
    child = await startServer(dataDir, port);
    const s2 = await connect(base); sockets.push(s2);
    const k = await emit(s2, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: jb.identity });
    assert.ok(k.ok);
    const lines = restartLines(k.history);
    assert.equal(lines.length, 1, JSON.stringify(k.history.map((m) => m.text)));
    const at = lines[0][1];
    assert.equal(lines[0][0].text, '— AGMessage restarted · ' + at + ' messages kept —');
    assert.equal(k.history[at - 1].text, 'after a stop that saved', 'replayed from the log, before the restart line');
    const killed = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(killed.lastStop, { state: 'none', saved: false, at: null, build: '', unsaved: [], code: '', said: killed.rooms, left: '' });
    assert.ok(killed.saves.stores.rooms.atStart >= 1, 'the hall whose log was replayed is written at the start');
  });

  await t.test('a show day\'s peaks outlive a restart: on disk in peaks.json, and health counts on from them', async () => {
    assert.ok(peaksBefore, 'the health test read today\'s peaks');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'peaks.json'), 'utf8'));
    const saved = onDisk.days.find((d) => d.day === peaksBefore.day);
    assert.ok(saved, 'the day is in peaks.json: ' + JSON.stringify(onDisk.days.map((d) => d.day)));
    assert.ok(saved.auditPutMs.count >= peaksBefore.auditPutMs.count, 'its audit appends kept: ' + saved.auditPutMs.count + ' ≥ ' + peaksBefore.auditPutMs.count);
    assert.ok(saved.compactMs.messages >= peaksBefore.compactMs.messages && saved.hallMessages >= peaksBefore.hallMessages);
    const after = (await (await fetch(base + '/api/health')).json()).peaks.find((d) => d.day === peaksBefore.day);
    assert.ok(after && after.auditPutMs.count >= saved.auditPutMs.count, 'the restarted server counts on from them: ' + JSON.stringify(after && after.auditPutMs));
    const words = [];
    JSON.stringify(onDisk, (k, v) => { if (typeof v === 'string') words.push(v); return v; });
    assert.ok(words.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w)), 'no hall, no name and no address on disk, only days: ' + words.join(', '));
  });
});

// ---------------------------------------------------------------- state frames, latest wins (lib/latest.js)
const helpers = require('./helpers');
const http = require('http');
const crypto = require('crypto');

test('state frames: no per-message deflate; a join storm\'s people list and a burst of seen receipts each go once per window', async (t) => {
  const srv = await helpers.startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await helpers.stopServer(srv.child); });
  const admin = (await helpers.api(srv.base, 'POST', '/api/admin/login', { token: helpers.TOKEN })).cookie;
  const code = (await helpers.api(srv.base, 'POST', '/api/rooms', { name: 'Frames' }, { cookie: admin })).body.code;
  assert.match(code, /^[A-Z0-9]{6}$/);

  await t.test('a WebSocket that offers permessage-deflate, as every browser does, is answered without it', async () => {
    // Socket.IO's own path, engine.io's handshake only: no page joins, and nothing of the connection bucket is spent.
    const req = http.request(srv.base + '/socket.io/?EIO=4&transport=websocket', {
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
      },
    });
    const res = await new Promise((resolve, reject) => {
      req.once('upgrade', (r, socket) => { socket.destroy(); resolve(r); });
      req.once('response', (r) => reject(new Error('answered ' + r.statusCode + ', not upgraded')));
      req.once('error', reject);
      req.end();
    });
    assert.equal(res.statusCode, 101);
    assert.equal(res.headers['sec-websocket-extensions'], undefined, 'the handshake answers no extension: ' + JSON.stringify(res.headers));
  });

  // Thirty pages, joined at once: what each hears of who is in the hall, timed from before the first join.
  const pages = [];
  let joinedSeq = 0;
  await t.test('during 30 joins each page gets at most one people list per 100 ms after its first, and the last holds all 30', async () => {
    for (const s of await Promise.all(Array.from({ length: 30 }, () => helpers.connect(srv.base)))) {
      sockets.push(s);
      const p = { s, lists: [], seen: [], uid: '' };
      s.on('users', (u) => p.lists.push([performance.now(), u]));
      s.on('seen', (f) => p.seen.push([performance.now(), f]));
      pages.push(p);
    }
    const t0 = performance.now();
    const acks = await Promise.all(pages.map((p, i) => helpers.emit(p.s, 'join', { roomCode: code, name: 'Page ' + (i + 1), role: 'observer' })));
    assert.ok(acks.every((a) => a.ok), JSON.stringify(acks.find((a) => !a.ok)));
    acks.forEach((a, i) => { pages[i].uid = a.uid; });
    joinedSeq = Math.max(...acks.map((a) => a.seq));
    const all = Array.from({ length: 30 }, (_, i) => 'Page ' + (i + 1)).sort();
    const names = (list) => list.map((u) => u.name).sort();
    await helpers.until(() => pages.every((p) => p.lists.length && names(p.lists.at(-1)[1]).length === 30), 6000, 'every page\'s newest list holding the 30');
    await helpers.wait(400);   // past a window more: anything still to come is counted too
    for (const [i, p] of pages.entries()) {
      const elapsed = p.lists.at(-1)[0] - t0;
      const bound = Math.ceil(elapsed / 100) + 1;
      assert.ok(p.lists.length <= bound, `page ${i + 1}: ${p.lists.length} people lists in ${Math.round(elapsed)} ms, at most ${bound}`);
      assert.deepEqual(names(p.lists.at(-1)[1]), all, `page ${i + 1}'s last list holds all 30`);
    }
  });

  await t.test('20 seen receipts at once reach every page in at most two frames, which hold the 20; a lone one goes at once', async () => {
    const reporters = pages.slice(0, 20);
    const t0 = performance.now();
    for (const p of reporters) p.s.emit('seen', { seq: joinedSeq });
    const held = (p) => p.seen.flatMap(([, f]) => (Array.isArray(f.seen) ? f.seen : []));
    const want = reporters.map((p) => p.uid).sort();
    await helpers.until(() => pages.every((p) => held(p).length >= 20), 4000, 'every page holding the 20 receipts');
    await helpers.wait(1300);   // past the window those frames opened: nothing more comes for them
    for (const [i, p] of pages.entries()) {
      assert.ok(p.seen.length >= 1 && p.seen.length <= 2, `page ${i + 1}: ${p.seen.length} seen frames for 20 receipts`);
      assert.deepEqual(held(p).map((e) => e.uid).sort(), want, `page ${i + 1}: the frames hold each of the 20 once`);
      assert.ok(p.seen.at(-1)[0] - t0 < 2000, `page ${i + 1}: within the window (${Math.round(p.seen.at(-1)[0] - t0)} ms)`);
      for (const [, f] of p.seen) assert.deepEqual(Object.keys(f), ['seen'], 'one batch, with no uid of its own: a page from before ignores it');
      for (const e of held(p)) assert.deepEqual([Object.keys(e), e.role, e.seq], [['uid', 'name', 'role', 'seq'], 'observer', joinedSeq]);
    }
    const before = pages.map((p) => p.seen.length);
    const lone = pages[20];
    const sent = performance.now();
    lone.s.emit('seen', { seq: joinedSeq });
    await helpers.until(() => pages.every((p, i) => p.seen.length > before[i]), 800, 'the lone receipt on every page well inside its window');
    const came = Math.max(...pages.map((p) => p.seen.at(-1)[0])) - sent;
    assert.ok(came < 800, 'a lone receipt is not held for the window: ' + Math.round(came) + ' ms');
    for (const p of pages) assert.deepEqual(p.seen.at(-1)[1].seen.map((e) => e.uid), [lone.uid], 'the frame holds only the receipt that moved');
  });

  await t.test('health says what each state frame saved: the changes marked and the frames sent', async () => {
    const { latest } = await (await fetch(srv.base + '/api/health', { headers: { cookie: admin } })).json();
    assert.deepEqual(Object.keys(latest), ['board', 'screens', 'people', 'seen', 'rooms', 'sends', 'pages', 'also', 'activity']);
    for (const [name, l] of Object.entries(latest)) assert.ok(Number.isInteger(l.marks) && Number.isInteger(l.flushes) && l.flushes <= l.marks, name + ' ' + JSON.stringify(l));
    assert.ok(latest.people.marks >= 30 && latest.people.flushes < latest.people.marks / 3, 'the join storm\'s people lists: ' + JSON.stringify(latest.people));
    assert.equal(latest.seen.marks, 21, 'every receipt that moved is marked');
    assert.ok(latest.seen.flushes >= 2 && latest.seen.flushes <= 3, 'and sent in two or three frames: ' + JSON.stringify(latest.seen));
  });
});

test('a first open carries the newest 200 messages, what a page keeps in view from before them and every file; earlier ones come a page at a time with history:before, and one pinned since by its id with history:message', async (t) => {
  const srv = await helpers.startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await helpers.stopServer(srv.child); });
  const open = async (cookie) => { const s = await helpers.connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await helpers.api(srv.base, 'POST', '/api/admin/login', { token: helpers.TOKEN })).cookie;
  const code = (await helpers.api(srv.base, 'POST', '/api/rooms', { name: 'Long day' }, { cookie: admin })).body.code;
  const ctl = await open(admin);
  const watch = async () => (await helpers.emit(ctl, 'admin:watchRoom', { roomCode: code })).messages;
  const ids = (list) => list.map((m) => m.id);

  // The day's start: an agenda pinned, a picture shared, a question nobody has answered, one answered, a help request
  // still open and one resolved, and a message a reply will quote much later.
  const ana = await open();
  const anaIn = await helpers.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'research' });
  const chair = await open();
  assert.equal((await helpers.emit(chair, 'join', { roomCode: code, name: 'Chair', role: 'board', invite: helpers.inviteOf(srv.dataDir, code) })).role, 'board');
  const say = async (s, payload) => { const r = await helpers.emit(s, 'message', payload); assert.ok(r.ok, JSON.stringify(r)); return r.id; };
  const agenda = await say(ana, { type: 'text', text: 'The agenda: item 4 is the capex review' });
  assert.ok((await helpers.emit(ana, 'pin', { messageId: agenda, pinned: true })).ok);
  const f = new FormData();
  f.append('file', new Blob([pngOf()], { type: 'image/png' }), 'stage.png');
  const up = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': anaIn.uploadToken }, body: f })).json();
  const picture = await say(ana, { type: 'file', url: up.url, filename: 'stage.png', mime: 'image/png' });
  const asked = await say(ana, { type: 'action', text: 'Ready for questions?', options: ['Yes', 'No'] });
  const answered = await say(ana, { type: 'action', text: 'Proxies counted?', options: ['Yes', 'No'] });
  assert.ok((await helpers.emit(chair, 'actionResponse', { messageId: answered, optionIndex: 0 })).ok);
  const help = await say(chair, { type: 'help', category: 'Sound', text: 'mic 3 is dead' });
  const sorted = await say(chair, { type: 'help', category: 'Presenter', text: 'water, please' });
  assert.ok((await helpers.emit(ana, 'help:respond', { code, messageId: sorted, state: 'resolved' })).ok);
  const quoted = await say(chair, { type: 'text', text: 'Can we take questions after item 4?' });
  const doomed = await say(chair, { type: 'text', text: 'Is the lectern mic on?' });
  // Then the day: 16 people backstage, 25 messages each, in two bursts each socket's bucket takes (15 at once, and 10 once
  // it has filled again).
  const crew = [];
  for (let w = 0; w < 16; w++) {
    const s = await open();
    assert.ok((await helpers.emit(s, 'join', { roomCode: code, name: 'Crew ' + w, role: 'research' })).ok);
    crew.push(s);
  }
  const burst = (from, n) => Promise.all(crew.map((s, w) => Promise.all(Array.from({ length: n }, (_, i) => say(s, { type: 'text', text: 'note ' + w + '.' + (from + i) })))));
  await burst(0, 15);
  await helpers.wait(2200);
  await burst(15, 10);
  // A reply to a message its author then removes: its quote says the message has gone, so no page reads back to it.
  const toDoomed = await say(ana, { type: 'text', text: 'It is now', replyTo: doomed });
  assert.ok((await helpers.emit(chair, 'delete', { messageId: doomed })).ok);
  const reply = await say(ana, { type: 'text', text: 'Yes, after item 4', replyTo: quoted });
  const all = await watch();
  assert.ok(all.length > 400, 'the room holds ' + all.length + ' messages');

  await t.test('a join without since: the newest 200, the pinned message, the open help and the unanswered question from before them, every file, and more', async () => {
    const reader = await open();
    const j = await helpers.emit(reader, 'join', { roomCode: code, name: 'Reader', role: 'observer' });
    assert.ok(j.ok, JSON.stringify(j));
    // The room as it was answered: the reader's own joined line comes after the answer.
    const now = (await watch()).slice(0, -1);
    assert.equal((await watch()).at(-1).text, 'Reader joined as an observer');
    assert.deepEqual(ids(j.history), ids(now.slice(-200)), 'the newest 200, oldest first');
    assert.deepEqual([ids(j.older), j.more], [[agenda, asked, help], true], 'pinned, help not resolved and questions not answered, in the room\'s order');
    // An observer's page is given no file's link (plan 4-§4.6.6): every file of the room, each without its address.
    assert.deepEqual(j.files, [{ id: picture, filename: 'stage.png', mime: 'image/png' }], 'every file of the room, its message held or not, and no link for an observer');
    assert.ok(!j.history.some((m) => m.id === quoted) && j.history.at(-1).id === reply && j.history.at(-1).replyTo.id === quoted && !j.history.at(-1).replyTo.gone, 'a reply whose quoted message is earlier than the window');
    assert.deepEqual(j.history.find((m) => m.id === toDoomed).replyTo, { id: doomed, name: 'Chair', snippet: 'Is the lectern mic on?', gone: true }, 'a reply whose quoted message has gone says so');
    assert.deepEqual(Object.keys(j).slice(-7), ['more', 'older', 'files', 'theAdmin', 'clock', 'pins', 'onStage'], 'appended at the end of the answer, before the clock or countdown\'s, the person\'s pins and what they may do On stage');
    assert.equal(j.seq, now.at(-1).seq);

    // Read back from the window's oldest, a page at a time, until nothing is left: every message once, in order. A change
    // made to a message the page did not hold (a reaction) is in it when it comes.
    assert.ok((await helpers.emit(ana, 'react', { messageId: quoted, emoji: '👍', on: true })).ok);
    const pagesRead = [];
    let before = j.history[0].seq;
    let more = j.more;
    while (more) {
      const r = await helpers.emit(reader, 'history:before', { beforeSeq: before });
      assert.deepEqual(Object.keys(r), ['ok', 'history', 'more'], JSON.stringify(r).slice(0, 200));
      assert.ok(r.ok && r.history.length > 0 && r.history.length <= 200);
      pagesRead.unshift(r.history);
      before = r.history[0].seq;
      more = r.more;
    }
    assert.equal(pagesRead.length, Math.ceil((now.length - 200) / 200), 'pages of 200');
    const room = await watch();
    assert.deepEqual(ids(pagesRead.flat().concat(j.history)), ids(room.slice(0, j.history.length + pagesRead.flat().length)), 'every message once, in the room\'s order');
    const read = pagesRead.flat().find((m) => m.id === quoted);
    assert.deepEqual(read.reactions.map((x) => [x.name, x.emoji]), [['Ana', '👍']], 'read as it stands now');
    assert.ok(!pagesRead.flat().some((m) => m.id === doomed), 'a message removed is never read back');
    // Before the first message: nothing, and no more.
    assert.deepEqual(await helpers.emit(reader, 'history:before', { beforeSeq: pagesRead[0][0].seq }), { ok: true, history: [], more: false });
  });

  await t.test('a message pinned since a page opened, earlier than what it holds, is read by its id with history:message, as it stands', async () => {
    const reader = await open();
    const j = await helpers.emit(reader, 'join', { roomCode: code, name: 'Later', role: 'observer' });
    assert.ok(j.ok && ![...j.history, ...j.older].some((m) => m.id === answered), 'the page holds no answered question from the day\'s start');
    const heard = new Promise((resolve) => reader.once('pinUpdate', resolve));
    assert.ok((await helpers.emit(ana, 'pin', { messageId: answered, pinned: true })).ok);
    const pin = await heard;
    assert.deepEqual([pin.messageId, pin.pinned, Number.isInteger(pin.seq)], [answered, true, true], 'the page hears the pin of a message it does not hold, and no record with it');
    const got = await helpers.emit(reader, 'history:message', { messageId: answered });
    assert.deepEqual([Object.keys(got), got.message.id, got.message.pinned, got.message.responses.map((x) => x.name)], [['ok', 'message'], answered, true, ['Chair']], 'the record as it stands: pinned, its answer in it');
    assert.equal((await helpers.emit(reader, 'history:message', { messageId: toDoomed })).message.replyTo.gone, true, 'a reply whose quoted message has gone says so here too');
    const words = 'That message is not in this room any more.';
    assert.deepEqual([await helpers.emit(reader, 'history:message', { messageId: doomed }), await helpers.emit(reader, 'history:message', { messageId: 'nope' })], [{ ok: false, error: words }, { ok: false, error: words }], 'one removed, and an id the room holds none by');
    assert.ok((await helpers.emit(ana, 'pin', { messageId: answered, pinned: false })).ok);
  });

  await t.test('a page\'s own pins older than the window are carried with its first open, every one, as the room\'s pins are (plan 7-§17.5)', async () => {
    const pinner = await open();
    const j = await helpers.emit(pinner, 'join', { roomCode: code, name: 'Pinner', role: 'observer' });
    assert.ok(j.ok, JSON.stringify(j));
    // More than a page's chatter bucket would read back one by one (20 at once): 45 of the day's first notes, pinned for
    // itself under the rate (a busy answer asked again).
    const room = await watch();
    const old = room.slice(0, room.length - 250).filter((m) => m.type === 'text' && m.id !== agenda && /^note /.test(m.text)).slice(0, 45).map((m) => m.id);
    assert.equal(old.length, 45);
    for (const id of old) {
      let r = await helpers.emit(pinner, 'pin:mine', { messageId: id, on: true });
      while (r.busy) { await helpers.wait(300); r = await helpers.emit(pinner, 'pin:mine', { messageId: id, on: true }); }
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    // A reload: its pins, and every message they name in `older`, in the room's order beside what every page keeps in view.
    const again = await open();
    const k = await helpers.emit(again, 'join', { roomCode: code, name: 'Pinner', role: 'observer', uid: j.identity });
    assert.ok(k.ok && !k.history.some((m) => old.includes(m.id)), 'none of them in the window');
    assert.deepEqual(k.pins, old, 'its pins, in the order pinned');
    assert.deepEqual(ids(k.older), ids(room.filter((m) => [agenda, asked, help].includes(m.id) || old.includes(m.id))), 'every one carried, in the room\'s order');
    // Another page carries none of them.
    const other = await open();
    const o = await helpers.emit(other, 'join', { roomCode: code, name: 'Other', role: 'observer' });
    assert.deepEqual([o.pins, ids(o.older)], [[], [agenda, asked, help]]);
    // Read back to the start, each page gets the same messages: what it carried is read back again when asked for.
    const readBack = async (s, from) => {
      const got = [];
      for (let before = from, more = true; more;) {
        let r = await helpers.emit(s, 'history:before', { beforeSeq: before });
        while (r.busy) { await helpers.wait(300); r = await helpers.emit(s, 'history:before', { beforeSeq: before }); }
        assert.ok(r.ok && r.history.length > 0, JSON.stringify(r).slice(0, 200));
        got.unshift(...r.history);
        before = r.history[0].seq;
        more = r.more;
      }
      return ids(got);
    };
    assert.deepEqual(await readBack(again, k.history[0].seq), await readBack(other, o.history[0].seq));
  });

  await t.test('history:before and history:message are read by type, behind the gate: joined, one chatter token per ask', async () => {
    const words = 'Say where to read back from: beforeSeq, the change number of the oldest message this page holds.';
    const page = await open();
    assert.deepEqual(await helpers.emit(page, 'history:before', { beforeSeq: 5 }), { ok: false, error: 'Not joined' }, 'a page in no room reads none');
    assert.deepEqual(await helpers.emit(page, 'history:message', { messageId: agenda }), { ok: false, error: 'Not joined' }, 'nor a message of any room');
    assert.ok((await helpers.emit(page, 'join', { roomCode: code, name: 'Typist', role: 'observer' })).ok);
    for (const bad of [null, {}, { beforeSeq: '40' }, { beforeSeq: 0 }, { beforeSeq: -3 }, { beforeSeq: 2.5 }, { beforeSeq: [7] }]) {
      assert.deepEqual(await helpers.emit(page, 'history:before', bad), { ok: false, error: words }, JSON.stringify(bad));
    }
    for (const bad of [null, {}, { messageId: 7 }, { messageId: [agenda] }, { messageId: '' }]) {
      assert.deepEqual(await helpers.emit(page, 'history:message', bad), { ok: false, error: 'That message is not in this room any more.' }, JSON.stringify(bad));
    }
    // The chatter bucket holds 20: a burst of 30 asks is answered, the rest refused for the rate, which the page asks again.
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? helpers.emit(page, 'history:before', { beforeSeq: 9 }) : helpers.emit(page, 'history:message', { messageId: agenda }))));
    const slow = burst.filter((r) => !r.ok);
    assert.ok(slow.length >= 5 && slow.every((r) => r.error === 'Slow down a little.' && r.busy === true), JSON.stringify(slow.slice(0, 2)) + ' of ' + slow.length);
  });

  await t.test('a resume is unchanged: what the page missed, and no window', async () => {
    const back = await open();
    const first = await helpers.emit(back, 'join', { roomCode: code, name: 'Back', role: 'observer' });
    back.close();
    await say(ana, { type: 'text', text: 'while you were away' });
    const again = await open();
    const r = await helpers.emit(again, 'join', { roomCode: code, name: 'Back', role: 'observer', uid: first.identity, since: first.seq });
    assert.ok(r.ok && Array.isArray(r.ops) && r.ops.some((op) => op.o === 'add' && op.m.text === 'while you were away'));
    assert.deepEqual(['history', 'older', 'more', 'files'].filter((k) => k in r), [], 'a resume carries none of a first open');
  });
});

test('On stage seats come from an invite, in open halls too: the code seats nobody there; an open hall keeps its On stage seats across a restart and an unlock keeps them; New On stage link voids the old one and keeps the seats held, one row with no link', async (t) => {
  let srv = await helpers.startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await helpers.stopServer(srv.child); });
  const open = async (cookie) => { const s = await helpers.connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await helpers.api(srv.base, 'POST', '/api/admin/login', { token: helpers.TOKEN })).cookie;
  const code = (await helpers.api(srv.base, 'POST', '/api/rooms', { name: 'Open hall' }, { cookie: admin })).body.code;
  let ctl = await open(admin);
  const NOTE = 'On stage seats need the invite link — you joined as an observer.';
  const join = async (args) => helpers.emit(await open(), 'join', { roomCode: code, ...args });
  const seated = (r) => [r.ok, r.role, r.note];
  const rows = (action) => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action);
  const seatsKept = () => {
    // The room's saved seats, as its op log keeps them (settings.seats in its newest meta op that names them).
    const ops = fs.readFileSync(path.join(srv.dataDir, 'rooms', code + '.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.o === 'meta' && o.settings && o.settings.seats);
    return ops.length ? Object.values(ops.at(-1).settings.seats).map((x) => [x.name, x.role]).sort() : [];
  };

  // An open hall: the code seats Backstage and Observer; On stage only with its link, which the Invites panel gives.
  assert.deepEqual(seated(await join({ name: 'Walk-in', role: 'board' })), [true, 'observer', NOTE]);
  assert.deepEqual(seated(await join({ name: 'Crew', role: 'research' })), [true, 'research', '']);
  const invites = await helpers.emit(ctl, 'admin:invites', { roomCode: code });
  assert.ok(invites.ok && invites.invites.board.includes('role=board&invite='), 'the On stage link, in an open hall too');
  const link = new URL(srv.base + invites.invites.board).searchParams.get('invite');
  assert.equal(link, helpers.inviteOf(srv.dataDir, code));
  const chairJoin = await join({ name: 'Chair', role: 'board', invite: link });
  assert.deepEqual(seated(chairJoin), [true, 'board', '']);
  assert.deepEqual(seated(await join({ name: 'Wrong seat', role: 'research', invite: link })), [true, 'research', ''], 'an open hall\'s backstage needs no link');
  // The admin seats a code guest On stage (S5): kept like an invited one.
  const oz = await open();
  const ozJoin = await helpers.emit(oz, 'join', { roomCode: code, name: 'Oz', role: 'observer' });
  assert.ok((await helpers.emit(ctl, 'admin:setRole', { roomCode: code, socketId: oz.id, role: 'board' })).ok);
  // Its On stage seats are saved with the room, its backstage and observer seats (the code's) not.
  await helpers.until(() => JSON.stringify(seatsKept()) === JSON.stringify([['Chair', 'board'], ['Oz', 'board']]), 4000, 'the open hall\'s On stage seats saved');

  // A restart: each comes back to its seat within the boot's first seconds, without a link; the backstage guest's seat
  // was never kept, and a newcomer without one is an observer.
  sockets.splice(0).forEach((s) => s.close());
  srv = await helpers.restartServer(srv);
  ctl = await open(admin);
  assert.deepEqual(seated(await join({ name: 'Chair', role: 'board', uid: chairJoin.identity })), [true, 'board', '']);
  assert.deepEqual(seated(await join({ name: 'Oz', role: 'board', uid: ozJoin.identity })), [true, 'board', '']);
  assert.deepEqual(seated(await join({ name: 'Late', role: 'board' })), [true, 'observer', NOTE]);

  // Locked, then unlocked: the unlock keeps the On stage seats and drops the rest; a restart after it seats the tablet again.
  const crew = await open();
  const crewJoin = await helpers.emit(crew, 'join', { roomCode: code, name: 'Crew 2', role: 'research' });
  assert.ok((await helpers.emit(ctl, 'admin:lockRoles', { roomCode: code, on: true })).ok);
  assert.ok(seatsKept().some(([n, r]) => n === 'Crew 2' && r === 'research'), 'a lock keeps every seat taken');
  assert.ok((await helpers.emit(ctl, 'admin:lockRoles', { roomCode: code, on: false })).ok);
  assert.deepEqual(seatsKept(), [['Chair', 'board'], ['Oz', 'board']], 'unlocked: the On stage seats kept, the rest dropped');
  sockets.splice(0).forEach((s) => s.close());
  srv = await helpers.restartServer(srv);
  ctl = await open(admin);
  assert.deepEqual(seated(await join({ name: 'Chair', role: 'board', uid: chairJoin.identity })), [true, 'board', '']);
  assert.equal((await join({ name: 'Crew 2', role: 'research', uid: crewJoin.identity })).role, 'research', 'an open hall\'s backstage needs no seat kept');

  // New On stage link: refused to anyone but the admin's page, for a seat that has no link, or a room that has none.
  const guest = await open();
  await helpers.emit(guest, 'join', { roomCode: code, name: 'Guest', role: 'research' });
  assert.deepEqual(await helpers.emit(guest, 'admin:newInvite', { roomCode: code, role: 'board' }), { ok: false, error: 'Not admin' });
  for (const role of ['observer', 'director', 5, undefined]) {
    assert.deepEqual(await helpers.emit(ctl, 'admin:newInvite', { roomCode: code, role }), { ok: false, error: 'Choose the link to replace: On stage, or Backstage (a side room\'s Member link).' }, String(role));
  }
  assert.deepEqual(await helpers.emit(ctl, 'admin:newInvite', { roomCode: 'NOSUCH', role: 'board' }), { ok: false, error: 'No such room.' });
  const legal = await helpers.emit(ctl, 'room:create', { hall: code, name: 'Legal' });
  assert.deepEqual(await helpers.emit(ctl, 'admin:newInvite', { roomCode: legal.key, role: 'board' }), { ok: false, error: 'Choose the link to replace: On stage, or Backstage (a side room\'s Member link).' }, 'a side room has no stage');
  assert.deepEqual(rows('room.invite'), [], 'refusals write no row');
  // Made: the old link admits nobody new to the stage, the code is the same, the seats held stay; one row, no link in it.
  const renewed = await helpers.emit(ctl, 'admin:newInvite', { roomCode: code, role: 'board' });
  assert.ok(renewed.ok && renewed.invites.board !== invites.invites.board && renewed.invites.board.startsWith('/?code=' + code + '&role=board&invite='), JSON.stringify(renewed));
  const fresh = new URL(srv.base + renewed.invites.board).searchParams.get('invite');
  assert.equal(fresh, helpers.inviteOf(srv.dataDir, code, 'board', 1), 'the room\'s number for the seat, one up');
  assert.deepEqual(seated(await join({ name: 'Old link', role: 'board', invite: link })), [true, 'observer', NOTE]);
  assert.deepEqual(seated(await join({ name: 'New link', role: 'board', invite: fresh })), [true, 'board', '']);
  assert.deepEqual(seated(await join({ name: 'Chair', role: 'board', uid: chairJoin.identity, invite: link })), [true, 'board', ''], 'a seat held keeps its seat');
  assert.deepEqual(rows('room.invite').map((e) => [e.target, e.words]), [[code, 'a new On stage link (the old one no longer admits)']]);
  assert.ok(!JSON.stringify(rows('room.invite')).includes(fresh) && !JSON.stringify(rows('room.invite')).includes(link), 'no link in the row');
  assert.equal((await helpers.emit(ctl, 'admin:invites', { roomCode: code })).invites.board, renewed.invites.board, 'the panel gives the new link');
  // Kept across a restart (the room's op log); the backstage link has a number of its own.
  sockets.splice(0).forEach((s) => s.close());
  srv = await helpers.restartServer(srv);
  ctl = await open(admin);
  assert.equal((await helpers.emit(ctl, 'admin:invites', { roomCode: code })).invites.board, renewed.invites.board);
  const back = await helpers.emit(ctl, 'admin:newInvite', { roomCode: code, role: 'research' });
  assert.deepEqual([back.ok, back.invites.board, new URL(srv.base + back.invites.research).searchParams.get('invite')], [true, renewed.invites.board, helpers.inviteOf(srv.dataDir, code, 'research', 1)]);
  assert.deepEqual(rows('room.invite').at(-1).words, 'a new Backstage link (the old one no longer admits)');
});

// An upload is kept by no device and saved by no GET (plan 4-§4.6.3): every type answers `private, no-store` and `inline`,
// never `attachment`; a navigation to it (the address bar, a link, a frame, an embed: Fetch Metadata) is refused as if it
// were not there, while AGMessage's readers (a fetch, an <img>) and a browser that sends no Fetch Metadata are served.
test('uploads are served no-store and inline for every type, never as attachment; a navigation to one is refused by Fetch Metadata, a fetch, a picture and a browser that sends none are served', async (t) => {
  const srv = await helpers.startServer();
  t.after(() => helpers.stopServer(srv.child));
  const dir = srv.dataDir + '-uploads';
  fs.mkdirSync(dir, { recursive: true });
  const types = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'xlsx', 'pptx', 'xls', 'csv', 'txt', 'md'];
  // A request with exactly these headers (fetch writes its own Sec-Fetch-* where a browser would): its status and disposition.
  const asked = (url, headers) => new Promise((resolve, reject) => {
    require('http').get(url, { headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, disposition: String(res.headers['content-disposition'] || '') })); }).on('error', reject);
  });
  for (const ext of types) fs.writeFileSync(path.join(dir, '1730000000000-abcdefghijkl-f.' + ext), 'x');
  for (const ext of types) {
    const url = srv.base + '/uploads/1730000000000-abcdefghijkl-f.' + ext;
    const plain = await fetch(url);
    assert.equal(plain.status, 200, ext);
    assert.equal(plain.headers.get('cache-control'), 'private, no-store', ext);
    assert.match(plain.headers.get('content-disposition'), /^inline; /, ext);
    assert.equal(plain.headers.get('x-content-type-options'), 'nosniff', ext);
    await plain.arrayBuffer();
    for (const headers of [{ 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, ...['document', 'iframe', 'frame', 'embed', 'object'].map((d) => ({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': d }))]) {
      assert.equal((await asked(url, headers)).status, 404, ext + ' ' + JSON.stringify(headers));
    }
    for (const headers of [{ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, {}]) {
      const r = await asked(url, headers);
      assert.equal(r.status, 200, ext + ' ' + JSON.stringify(headers));
      assert.ok(!/attachment/.test(r.disposition), ext);
    }
  }
});

// A push can carry one line to the speaker's screen (plan 4-§5.9.10): through the operator (stage:propose) or at once
// (stage:send), with `withTake`, a take its pusher put up in the last minute. The line is the push's own words, built by the
// server from the take it stored: the mock Stagewatch receives that line, a `text` that differs is refused, and the room's
// record, its row and the proposal's record carry no quote of it (a MAC follows the proposal instead, across a restart).
test('a push can carry one line to the speaker\'s screen, through the operator or at once: the server\'s line from the stored take, no quote in the room\'s record, one row with counts, the proposal followed by its MAC across a restart', { timeout: 120_000 }, async (t) => {
  const WINDOW = 8000;   // AGM_PUSH_LINE_MS: a line goes with a push only this long after it
  const sw = await helpers.fakeStagewatch({ name: 'Hall 7 timer' });
  let srv = await helpers.startServer({ AGM_PUSH_LINE_MS: String(WINDOW) });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await helpers.stopServer(srv.child); await sw.close(); });
  const open = async (cookie) => { const s = await helpers.connect(srv.base, cookie); sockets.push(s); return s; };
  // An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's.
  const act = async (s, ev, arg) => {
    for (let i = 0; i < 20; i++) { const r = await helpers.emit(s, ev, arg); if (!(r && r.busy)) return r; await helpers.wait(300); }
    throw new Error(ev + ' was refused for the rate twenty times');
  };
  const PASSWORD = 'lines for the lectern';
  const admin = (await helpers.setupAdmin(srv.base)).cookie;
  const hall = (await helpers.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 7' }, { cookie: admin })).body.code;
  const account = async (username, name, role, extra = {}) => {
    assert.equal((await helpers.api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, halls: [hall], ...extra }, { cookie: admin })).status, 200);
    return (await helpers.api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const tomCookie = await account('tom', 'Tom Tech', 'tech');   // display.control, stage.send: the operator
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { grant: ['stage.send'] });   // stage.show by a right of her own, and stage.send
  let ctl = await open(admin);
  assert.equal((await act(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall7_node_key_0001' })).ok, true);   // secret-scan: fixture
  let tom = await open(tomCookie);
  assert.equal((await act(tom, 'join', { roomCode: hall, as: 'account' })).ok, true);
  const sue = await open(sueCookie);
  assert.equal((await act(sue, 'join', { roomCode: hall, as: 'account' })).ok, true);
  await helpers.until(async () => { const r = await helpers.emit(tom, 'stage:targets', {}); return r.ok && r.canSend && r.canPropose; }, 15000, 'the hall\'s Stagewatch linked, its key accepted and its desk found');
  const messages = async () => (await act(ctl, 'admin:watchRoom', { roomCode: hall })).messages;
  const rows = (action) => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action);
  const sent = () => sw.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/message/'));
  const push = async (s, content, arrive) => { const r = await act(s, 'page:push', { code: hall, to: 'board', content, ...(arrive ? { arrive } : {}) }); assert.equal(r.ok, true, JSON.stringify(r)); return r.seq; };
  const CELL = { kind: 'snippet', unit: 'cell', table: { rows: [['', 'Q3'], ['Revenue', '£4.2m']], head: 1, side: 1, ref: 'D2', focus: [1, 1] } };
  const LINE = 'Revenue Q3: £4.2m';
  // A take put up now, kept until its minute is over (`WINDOW` here).
  const old = await push(tom, { kind: 'snippet', unit: 'text', text: 'Asked too late' });
  const oldAt = Date.now();

  // Through the operator: the desk is asked for the server's line of the take, the room's record names its length alone.
  const cell = await push(tom, CELL);
  const differs = await act(tom, 'stage:propose', { withTake: cell, text: 'Revenue Q3: £5.0m', destination: 'speaker' });
  assert.deepEqual(differs, { ok: false, error: 'The line must be the push\'s own words.' });
  assert.equal(sw.proposals.size, 0, 'nothing was asked of the desk');
  const asked = await act(tom, 'stage:propose', { withTake: cell, text: LINE, destination: 'speaker' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(sw.proposals.get(asked.proposal.id).line, 'message "Revenue Q3: £4.2m" info off ack', 'the desk is asked for the take\'s own words');
  assert.ok(typeof asked.proposal.lineMac === 'string' && asked.proposal.lineMac.length === 24 && !Object.hasOwn(asked.proposal, 'line'), JSON.stringify(asked.proposal));
  let room = await messages();
  const askedLine = room.find((m) => m.proposal && m.proposal.id === asked.proposal.id);
  assert.equal(askedLine.text, 'Tom Tech asked the operator for a line (17 characters) on the speaker\'s screen with a push — waiting for the show desk');
  assert.ok(!Object.hasOwn(askedLine.proposal, 'line') && askedLine.proposal.lineMac === asked.proposal.lineMac, JSON.stringify(askedLine.proposal));
  assert.ok(!room.some((m) => JSON.stringify(m).includes('4.2m')), 'no record of the room quotes the line, its proposal\'s included');
  assert.deepEqual(rows('stagewatch.propose').map((e) => e.words), ['asked the operator: a message (17 characters) for the speaker\'s screen, with a push — proposal ' + asked.proposal.id]);
  // The line goes to the speaker's screen alone.
  assert.deepEqual(await act(tom, 'stage:propose', { withTake: cell, destination: 'operator' }), { ok: false, error: 'A line with a push goes to the speaker\'s screen.' });

  // At once: Stagewatch is sent the server's line, with no `text` from the page at all.
  const before = sent().length;
  const now = await act(tom, 'stage:send', { withTake: cell });
  assert.equal(now.ok, true, JSON.stringify(now));
  assert.equal(sent().length, before + 1);
  assert.equal(decodeURIComponent(sent().at(-1).url.split('/')[3]), LINE, 'Stagewatch is sent the take\'s own words');
  room = await messages();
  assert.ok(room.some((m) => m.type === 'system' && m.text === 'Tom Tech sent a line (17 characters) to the speaker\'s screen with a push' && m.stage && m.stage.receipt === 'applied'), JSON.stringify(room.map((m) => m.text)));
  assert.ok(!room.some((m) => (m.text || '').includes('4.2m')), 'no line of the room quotes it');
  assert.deepEqual(rows('stagewatch.send').map((e) => e.words), ['a line (17 characters) on the speaker\'s screen, sent now, with a push']);
  // A send of a line of its own is quoted in the room as before.
  assert.equal((await act(tom, 'stage:send', { text: 'Two minutes' })).ok, true);
  assert.ok((await messages()).some((m) => m.type === 'system' && m.text === 'Tom Tech sent to the speaker\'s screen: “Two minutes”'));
  // The line the page showed (linecore's flatten of what it pushed) is the server's line of the take it stored, though the
  // cleaner drops invisible characters and cuts a long title: sent with the push, it is accepted, and Stagewatch is sent it.
  const core = require('../public/linecore.js');
  for (const content of [
    { kind: 'snippet', unit: 'paragraph', text: 'Revenue\u200b rose by \u200f4%\u200e \u2066in Q3\u2069' },
    { kind: 'snippet', unit: 'slide', title: 'Q'.repeat(130), items: ['Revenue up', 'Costs flat'] },
  ]) {
    const seq = await push(tom, content);
    const shown = core.flatten(content);
    const r = await act(tom, 'stage:send', { withTake: seq, text: shown });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(decodeURIComponent(sent().at(-1).url.split('/')[3]), shown, 'Stagewatch is sent the line the page showed');
  }
  assert.equal(decodeURIComponent(sent().at(-2).url.split('/')[3]), 'Revenue rose by 4% in Q3');
  assert.equal(decodeURIComponent(sent().at(-1).url.split('/')[3]), 'Q'.repeat(120) + ': Revenue up · Costs flat');

  // Only its pusher's, in this hall, of the information layer, with words to send.
  const hers = await push(sue, { kind: 'snippet', unit: 'text', text: 'Capex rose 8%' }, 'side');   // beside the operator's
  const NOT_YOURS = { ok: false, error: 'The line goes with a push of yours from the last minute — send it as a line of its own instead.' };
  assert.deepEqual(await act(tom, 'stage:send', { withTake: hers }), NOT_YOURS, 'another person\'s take');
  assert.deepEqual(await act(sue, 'stage:propose', { withTake: cell }), NOT_YOURS, 'another person\'s take, asked of the desk');
  assert.deepEqual(await act(tom, 'stage:send', { withTake: 9999 }), NOT_YOURS, 'no such take');
  const clock = await push(tom, { kind: 'clock' });
  assert.deepEqual(await act(tom, 'stage:send', { withTake: clock }), NOT_YOURS, 'a take of the show layer carries no line');
  const web = await push(tom, { kind: 'web', url: 'https://vote.example.com/results' });
  assert.deepEqual(await act(tom, 'stage:send', { withTake: web }), { ok: false, error: 'That push has no words for the speaker\'s screen — a document or a picture needs a line above it.' }, 'an address is never a line');
  for (const withTake of ['1', 1.5, 0, true, { seq: cell }]) assert.deepEqual(await act(tom, 'stage:send', { withTake }), { ok: false, error: 'That line\'s push could not be read.' }, JSON.stringify(withTake));
  assert.deepEqual(await act(tom, 'stage:send', { withTake: cell, text: 5 }), { ok: false, error: 'The line must be the push\'s own words.' }, 'a text that is no line');
  const hersAsked = await act(sue, 'stage:propose', { withTake: hers, text: 'Capex  rose 8%' });
  assert.equal(hersAsked.ok, true, 'a line read as the screen shows it is the same line: ' + JSON.stringify(hersAsked));
  assert.equal(sw.proposals.get(hersAsked.proposal.id).line, 'message "Capex rose 8%" info off ack');
  // A take older than its minute: refused, and nothing more reaches Stagewatch.
  await helpers.wait(Math.max(0, oldAt + WINDOW + 300 - Date.now()));
  const late = sent().length;
  assert.deepEqual(await act(tom, 'stage:send', { withTake: old }), NOT_YOURS, 'an old take');
  assert.equal(sent().length, late);
  assert.equal(rows('stagewatch.send').length, 4, 'one row for each line that went, none for a refusal');

  // A restart: each proposal is followed by its MAC, the desk's copy read back and matched. One whose line the desk no
  // longer holds as asked is no longer ours (lost); the other is followed to its approval.
  sockets.forEach((s) => s.close());
  srv = await helpers.restartServer(srv, { AGM_PUSH_LINE_MS: String(WINDOW) });
  ctl = await open(admin);
  tom = await open(tomCookie);
  assert.equal((await act(tom, 'join', { roomCode: hall, as: 'account' })).ok, true);
  sw.proposals.get(hersAsked.proposal.id).line = 'message "Capex fell 8%" info off ack';
  sw.approve(asked.proposal.id, 'Show caller');
  await helpers.until(async () => {
    const r = await messages();
    const a = r.find((m) => m.proposal && m.proposal.id === asked.proposal.id);
    const b = r.find((m) => m.proposal && m.proposal.id === hersAsked.proposal.id);
    return a && b && a.proposal.state === 'approved' && a.proposal.by === 'Show caller' && b.proposal.state === 'lost';
  }, 20000, 'after the restart, ours approved by its MAC, and the one the desk holds other words for lost');
});
