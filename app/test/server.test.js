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
const { stopServer: stop } = require('./helpers');   // asked over IPC, so it saves first on Windows too

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
    assert.deepEqual([noInvite.ok, noInvite.role, noInvite.note], [true, 'observer', 'This room needs an invite link for that seat — you joined as an observer.']);
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
    const oj = await emit(old, 'join', { roomCode: code, name: 'Old Link', role: 'director' });
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
      assert.ok((await emit(s, 'join', { roomCode: named.code, name, role })).ok, name);
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
    assert.ok(remote.build.startsWith(remote.version + '-dev') || remote.build.startsWith(remote.version + '+'), 'the build names its version and channel: ' + remote.build);
  });

  await t.test('every write lane the server made is one a stop or a crash flushes, by the object: the lanes made, the distinct lanes named and their names agree', async () => {
    const { saves } = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(Object.keys(saves).slice(-2), ['built', 'named'], 'appended at the end of the saves');
    // A lane's row is {writes, error, failures}; the rooms' op log and the audit log are not lanes and say other things.
    const lanes = Object.keys(saves.stores).filter((name) => ['writes', 'error', 'failures'].every((k) => k in saves.stores[name]));
    for (const name of ['accounts', 'screens', 'auditHead', 'peaks']) assert.ok(lanes.includes(name), 'a lane made in lib/ or server.js is named: ' + name + ' in ' + lanes.join(', '));
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
    assert.deepEqual(Object.keys(h).slice(-14), ['elu', 'rssMb', 'maxSocketsPerAddress', 'tunnelSockets', 'largestHall', 'latest', 'peaks', 'showDay', 'tunnel', 'refused', 'acceptErrors', 'format', 'sleeps', 'power'], 'appended at the end of the detail');
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
    assert.deepEqual(Object.keys(h.latest), ['board', 'screens', 'people', 'seen']);
    for (const l of Object.values(h.latest)) assert.ok(Number.isInteger(l.marks) && Number.isInteger(l.flushes) && l.flushes <= l.marks, JSON.stringify(h.latest));
    assert.ok(h.latest.board.flushes >= 1, 'the board was sent: ' + JSON.stringify(h.latest.board));
    assert.ok(gone.latest.screens.marks > h.latest.screens.marks, 'a screen made, opened and closed is marked: ' + JSON.stringify(gone.latest.screens));

    // Today's peaks, the show day the server names: the hall made at the start and the sign-in's audit row are in them.
    assert.match(h.showDay, /^\d{4}-\d{2}-\d{2}$/);
    const today = h.peaks.find((d) => d.day === h.showDay);
    assert.ok(today, 'today has its record: ' + JSON.stringify(h.peaks.map((d) => d.day)));
    assert.deepEqual(Object.keys(today), ['day', 'loopMs', 'elu', 'socketsPerAddress', 'tunnelSockets', 'tunnelRefused', 'hallMessages', 'hallKb', 'joinBurst', 'compactMs', 'auditPutMs', 'at', 'sleeps', 'sleptMs']);
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

  await t.test('history survives a restart (log replay)', async () => {
    sockets.forEach((s) => s.close());
    await stop(child);
    child = await startServer(dataDir, port);
    const s = await connect(base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: jb.identity });
    assert.ok(j.ok);
    assert.equal(j.uid, jb.uid, 'same person after restart');
    // The restart's own line, after every message the hall kept, counts them.
    const at = j.history.findIndex((m) => m.type === 'system' && /restarted/.test(m.text));
    assert.ok(at > 0, JSON.stringify(j.history.map((m) => m.text)));
    assert.equal(j.history[at].text, '— AGMessage restarted · ' + at + ' messages kept —');
    assert.ok(j.history.some((m) => m.text === 'Capex is on slide 14'));
    assert.ok(j.history.some((m) => m.text === 'while you were away'));
    assert.ok(!j.history.some((m) => m.text === 'delete me'));
    assert.ok(j.seq > seqAfterHello);
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
    assert.deepEqual(Object.keys(latest), ['board', 'screens', 'people', 'seen']);
    for (const [name, l] of Object.entries(latest)) assert.ok(Number.isInteger(l.marks) && Number.isInteger(l.flushes) && l.flushes <= l.marks, name + ' ' + JSON.stringify(l));
    assert.ok(latest.people.marks >= 30 && latest.people.flushes < latest.people.marks / 3, 'the join storm\'s people lists: ' + JSON.stringify(latest.people));
    assert.equal(latest.seen.marks, 21, 'every receipt that moved is marked');
    assert.ok(latest.seen.flushes >= 2 && latest.seen.flushes <= 3, 'and sent in two or three frames: ' + JSON.stringify(latest.seen));
  });
});
