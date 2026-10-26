'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../lib/guard');
const { RoomStore } = require('../lib/store');
const nodes = require('../lib/nodes');
const ai = require('../lib/ai');

test('identities: signed by the server, tamper-evident', () => {
  const secret = Buffer.alloc(32, 7);
  const tok = guard.newIdentity(secret);
  const id = guard.checkIdentity(secret, tok);
  assert.ok(id && tok.startsWith(id + '.'));
  assert.equal(guard.checkIdentity(secret, tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(guard.checkIdentity(Buffer.alloc(32, 8), tok), null);
  assert.equal(guard.checkIdentity(secret, 'u-1234'), null);
  assert.equal(guard.checkIdentity(secret, 42), null);
});

test('invites are per room and per role', () => {
  const s = Buffer.alloc(32, 1);
  const inv = guard.makeInvite(s, 'ABC123', 'board');
  assert.ok(guard.checkInvite(s, 'ABC123', 'board', inv));
  assert.ok(!guard.checkInvite(s, 'ABC123', 'research', inv));
  assert.ok(!guard.checkInvite(s, 'XYZ999', 'board', inv));
});

test('uploads: name and content must agree', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  assert.equal(guard.uploadType('a.png', png).mime, 'image/png');
  assert.equal(guard.uploadType('a.pdf', png), null);
  assert.equal(guard.uploadType('a.svg', Buffer.from('<svg/>')), null);
  assert.equal(guard.uploadType('a.html', Buffer.from('<html>')), null);
  assert.ok(guard.uploadType('notes.txt', Buffer.from('Capex: £4.2m')));
  assert.equal(guard.uploadType('notes.txt', Buffer.from('<script>x</script>')), null);
  assert.ok(guard.validUploadUrl('/uploads/1777424589360-onmqm0a3ew2r-IMG_6586.jpeg'));
  // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
  for (const u of ['/uploads/../x', 'javascript:alert(1)', '/uploads/a.pdf', 'https://x/uploads/1-abcdefghijkl-a.pdf']) assert.ok(!guard.validUploadUrl(u), u);
});

test('token bucket and lockout', () => {
  const b = new guard.Bucket(1, 3);
  const t0 = Date.now();
  assert.ok(b.take(1, t0) && b.take(1, t0) && b.take(1, t0));
  assert.ok(!b.take(1, t0));
  assert.ok(b.take(1, t0 + 1100));
  const l = new guard.Lockout(2, 1000);
  l.fail('x', 0); assert.ok(!l.locked('x', 1)); l.fail('x', 2); assert.ok(l.locked('x', 3)); assert.ok(!l.locked('x', 2000));
});

test('host-only check: from loopback, to a loopback name, and nothing that came through a proxy or tunnel', () => {
  const req = (addr, headers = { host: 'localhost:3023' }) => ({ socket: { remoteAddress: addr }, headers });
  assert.ok(guard.isHostMachine(req('127.0.0.1')));
  for (const host of ['127.0.0.1:3023', '[::1]:3023', 'LOCALHOST', 'localhost']) assert.ok(guard.isHostMachine(req('127.0.0.1', { host })), host);
  for (const host of ['agm.example:3023', '127.0.0.1.nip.io:3023', 'localhost.example', 'localhost:3023 x', '']) {
    assert.ok(!guard.isHostMachine(req('127.0.0.1', { host })), 'a page served under another name is not this laptop: ' + host);
  }
  assert.ok(!guard.isHostMachine(req('127.0.0.1', { host: 'localhost:3023', 'cf-connecting-ip': '1.2.3.4' })));
  assert.ok(!guard.isHostMachine(req('127.0.0.1', { host: 'localhost:3023', 'x-forwarded-for': '1.2.3.4' })));
  assert.ok(!guard.isHostMachine(req('192.168.1.5')));
  assert.equal(guard.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), 'cf:1.2.3.4');
});

test('store: log, resume window, torn writes, compaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  for (let i = 0; i < 5; i++) a.commit(r, { o: 'add', m: { id: 'm' + i, type: 'text', text: 'hello ' + i, at: i } });
  a.commit(r, { o: 'upd', id: 'm1', f: { pinned: true } });
  a.commit(r, { o: 'del', id: 'm0' });
  assert.equal(r.seq, 7);
  assert.deepEqual(a.opsSince(r, 5).map((o) => o.s), [6, 7]);
  assert.deepEqual(a.opsSince(r, 7), []);
  assert.equal(a.opsSince(r, 99), null);
  fs.appendFileSync(path.join(dir, 'ABC234.log'), '{"o":"add","m":{"id":"torn"');   // power cut mid-line
  const b = new RoomStore(dir);
  assert.equal(b.loadAll(), 1);
  const r2 = b.get('ABC234');
  assert.equal(r2.messages.length, 4);
  assert.ok(r2.byId.get('m1').pinned);
  assert.ok(!r2.byId.has('m0'));
  assert.equal(r2.seq, 7);
  assert.equal(fs.readFileSync(path.join(dir, 'ABC234.log'), 'utf8'), '', 'compacted at load');
  assert.equal(b.opsSince(r2, 3), null, 'after a restart the gap needs a full history');
});

test('store: a load that may not write leaves the files as they were', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  a.commit(r, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } });
  const files = () => fs.readdirSync(dir).sort().map((f) => f + ':' + fs.readFileSync(path.join(dir, f), 'utf8'));
  const before = files();
  const b = new RoomStore(dir);
  assert.equal(b.loadAll(null, { compact: false }), 1);
  assert.equal(b.get('ABC234').messages.length, 1, 'the log replayed in memory');
  assert.deepEqual(files(), before, 'nothing written');
});

test('store: a failed append is said, and the room is snapshotted as soon as the disk takes writes again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  const log = path.join(dir, 'ABC234.log');
  fs.unlinkSync(log);
  fs.mkdirSync(log);   // the log cannot be opened, as when the disk is full or another program holds it
  a.commit(r, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } });
  assert.ok(a.lastError, 'the failure is kept for health');
  assert.deepEqual(a.unsaved(), ['ABC234']);
  fs.rmdirSync(log);
  a.commit(r, { o: 'add', m: { id: 'm2', type: 'text', text: 'two', at: 2 } });
  assert.deepEqual(a.unsaved(), [], 'the next append that lands snapshots the room');
  assert.equal(a.lastError, null);
  const b = new RoomStore(dir);
  b.loadAll();
  assert.deepEqual(b.get('ABC234').messages.map((m) => m.id), ['m1', 'm2'], 'the op the log missed is on disk');
});

test('store: a log line the disk cut short, or a power cut tore, never swallows the next op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  a.commit(r, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } });
  const write = fs.writeSync;
  fs.writeSync = (fd, data) => { fs.writeSync = write; return write.call(fs, fd, Buffer.from(String(data)), 0, 12); };   // the disk takes 12 bytes
  a.commit(r, { o: 'add', m: { id: 'm2', type: 'text', text: 'two, cut short', at: 2 } });
  assert.deepEqual(a.unsaved(), ['ABC234']);
  // The next op lands whole, but the snapshot that would fold both in cannot be written (the snapshot is held).
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('.json')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return rename.call(fs, from, to); };
  try { a.commit(r, { o: 'add', m: { id: 'm3', type: 'text', text: 'three, whole', at: 3 } }); } finally { fs.renameSync = rename; }
  const b = new RoomStore(dir);
  b.loadAll(null, { compact: false });   // as after a crash: the snapshot and the log as they are
  assert.deepEqual(b.get('ABC234').messages.map((m) => m.id), ['m1', 'm3'], 'the op after the cut one replays');

  // A power cut tore the last line: the first op after the restart is a line of its own, not glued to the fragment.
  fs.appendFileSync(path.join(dir, 'ABC234.log'), '{"o":"add","m":{"id":"m4","ty');
  const c = new RoomStore(dir);
  c.loadAll(null, { compact: false });
  c.commit(c.get('ABC234'), { o: 'add', m: { id: 'm5', type: 'text', text: 'five, after the restart', at: 5 } });
  const d = new RoomStore(dir);
  d.loadAll(null, { compact: false });
  assert.deepEqual(d.get('ABC234').messages.map((m) => m.id), ['m1', 'm3', 'm5']);
});

test('board: a hall\'s messages are read once per change, whoever watches, and never served stale', () => {
  const board = require('../lib/board');
  const messages = [];
  for (let i = 0; i < 3000; i++) messages.push(i % 3 ? { id: 'm' + i, type: 'text', text: 'line ' + i, at: i, from: { name: 'Sam' } } : { id: 'm' + i, type: 'system', text: 'Sam joined', at: i });
  messages.push({ id: 'h1', type: 'help', category: 'Sound', text: 'radio mic 3', at: 3001, from: { name: 'Alex' }, help: { state: 'open' } });
  messages.push({ id: 'h2', type: 'help', category: 'Vision', text: 'done', at: 3002, from: { name: 'Alex' }, help: { state: 'resolved' } });
  const room = { code: 'HALL01', name: 'Hall 1', users: new Map(), seq: 3002, messages };
  let scans = 0;
  const filter = messages.filter.bind(messages);
  messages.filter = (...args) => { scans++; return filter(...args); };
  for (let w = 0; w < 30; w++) { board.hallRow(room); board.openHelp(room); }   // thirty watchers, one tick
  assert.equal(scans, 1, 'one scan for every watcher');
  assert.equal(board.openHelp(room).length, 1);
  assert.equal(board.hallRow(room).help, 1);
  assert.ok(Object.isFrozen(board.openHelp(room)[0]), 'what is shared cannot be changed by one watcher');
  Object.assign(messages[3000], { help: { state: 'resolved', by: 'Pat', at: 4000 } });   // as the store applies an update
  room.seq++;
  assert.equal(board.openHelp(room).length, 0, 'the change is seen at once');
  assert.equal(board.hallRow(room).help, 0);
  assert.equal(scans, 2, 'and read once more');
});

test('nodes: Stagewatch address and frame view', () => {
  assert.equal(nodes.normaliseBase('10.0.0.5'), 'http://10.0.0.5:9924');
  assert.equal(nodes.normaliseBase('http://foh-pc:9930/x'), 'http://foh-pc:9930');
  // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
  assert.equal(nodes.normaliseBase('javascript:alert(1)'), '');
  assert.equal(nodes.normaliseBase('http://user:pw@x'), '');
  const v = nodes.stageView({ type: 'state', mode: 'countdown', text: '12:34', speakerText: '12 MIN', title: 'Keynote', next: 'Panel', color: '#FF0000', message: 'Wrap up', messageAck: 'done' });
  assert.equal(v.text, '12 MIN');
  assert.equal(v.color, '#FF0000');
  assert.equal(nodes.stageView({ color: 'red;background:url(x)' }).color, '#FFFFFF');
});

test('ai: thread text is compact and labelled', () => {
  const t = ai.threadText([
    { type: 'system', text: 'x joined' },
    { type: 'text', text: 'What was capex?', at: 0, from: { name: 'Chair', role: 'board' } },
    { type: 'action', text: 'Refer to slide 14?', options: ['Yes', 'No'], responses: [{ name: 'Chair', optionIndex: 0 }], at: 0, from: { name: 'Ana', role: 'research' } },
  ]);
  assert.match(t, /Chair \(board\): What was capex\?/);
  assert.match(t, /answers: Chair → Yes/);
  assert.ok(!t.includes('joined'));
});

test('Stagewatch link: live frames, stale on silence, send to stage with the key', async () => {
  const http = require('http');
  const { WebSocketServer } = require('ws');
  const posts = [];
  const srv = http.createServer((req, res) => {
    posts.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/context' ? '{"v":1,"node":{"t":"main","id":"sw1","name":"Keynote"}}' : '{"ok":true}');
  });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  const conns = [];
  wss.on('connection', (ws, req) => { conns.push({ ws, url: req.url, auth: req.headers.authorization }); ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', speakerText: '5 MIN', title: 'Keynote', next: 'Panel', color: '#22C55E' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const states = [];
  const link = new nodes.StagewatchLink({ nodeId: 'ab12cd34', onState: (v, status) => states.push({ v, status }) });
  try {
    link.configure('127.0.0.1:' + port, 'swk_testkey');
    for (let i = 0; i < 50 && !states.some((s) => s.v && s.v.text === '5 MIN'); i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 50 && !states.some((s) => s.v && s.v.text === '5 MIN' && s.status === 'connected'); i++) await new Promise((r) => setTimeout(r, 50));
    const live = states.find((s) => s.v && s.v.text === '5 MIN' && s.status === 'connected');
    assert.ok(live, 'got a live frame');
    assert.equal(live.status, 'connected');
    assert.ok(!/pin=|swk_/.test(conns[0].url), 'the key is never in the URL');
    // It dials as this node, by its Show Bus id, as Stagewatch reads the query (the last value of a key wins).
    const q = require('./helpers').stagewatchQuery(conns[0].url);
    assert.deepEqual([...q.keys()].sort(), ['cid', 'node', 'page', 't']);
    assert.deepEqual([q.get('node'), q.get('cid'), q.get('t'), q.get('page')], ['ab12cd34', 'ab12cd34', 'messenger', '/agmessage']);
    assert.equal(conns[0].auth, 'Bearer swk_testkey', 'the key rides in the Authorization header');
    const r = await link.sendToStage('Two minutes left, please wrap up', { urgency: 'warn' });
    assert.ok(r.ok);
    const post = posts.find((p) => p.method === 'POST');
    assert.ok(post, 'sent');
    assert.equal(post.auth, 'Bearer swk_testkey');
    assert.equal(decodeURIComponent(post.url), '/api/message/Two minutes left, please wrap up/warn/off/ack');
    assert.equal((await new nodes.StagewatchLink({ nodeId: 'ab12cd34' }).sendToStage('x')).ok, false, 'not linked');
  } finally { link.stop(); wss.close(); srv.close(); }
});

test('no Stagewatch link without this node\'s Show Bus id; the address it dials names it and nothing secret', () => {
  for (const bad of [undefined, '', 'abc', 'agmessage!', 'x'.repeat(33), 12345678, { id: 'ab12cd34' }]) {
    assert.throws(() => new nodes.StagewatchLink({ nodeId: bad }), TypeError, String(bad));
  }
  assert.equal(new nodes.StagewatchLink({ nodeId: '9dd46605' }).nodeId, '9dd46605');
  assert.equal(nodes.wsUrl('https://10.0.0.5:9924', '9dd46605'), 'wss://10.0.0.5:9924/ws?node=9dd46605&t=messenger&cid=9dd46605&page=%2Fagmessage');
  assert.equal(nodes.wsUrl('http://10.0.0.5:9924', '9dd46605'), 'ws://10.0.0.5:9924/ws?node=9dd46605&t=messenger&cid=9dd46605&page=%2Fagmessage');
  assert.throws(() => nodes.wsUrl('http://10.0.0.5:9924', 'agmessage&pin=1'), TypeError);
});

test('C21: a Stagewatch gone silent is dropped at 12 s quiet and redialled at once, not after a 30 s close handshake', async () => {
  // The rule, deterministically: a silent socket answers no close frame, so it is terminated, never closed politely.
  const stub = new nodes.StagewatchLink({ nodeId: 'ab12cd34' });
  const calls = [];
  stub.ws = { readyState: 1, send() {}, close() { calls.push('close'); }, terminate() { calls.push('terminate'); }, onmessage() {} };
  stub.status = 'connected';
  stub.lastHeard = Date.now() - (nodes.GONE_MS + 1000);
  stub._watch();
  assert.deepEqual(calls, ['terminate']);
  const old = stub.ws;
  stub._close();
  assert.equal(old.onmessage, null, 'a dropped socket\'s late frames never reach the link');
  stub.stop();

  // A real socket whose peer stops reading (a laptop that lost power or Wi-Fi: TCP half-open).
  const http = require('http');
  const { WebSocketServer } = require('ws');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/context' ? '{"v":1,"node":{"t":"main","id":"sw1","name":"Keynote"}}' : '{}'); });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  let dials = 0;
  wss.on('connection', (c) => {
    dials++;
    c.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote' }));
    if (dials === 1) setTimeout(() => c._socket.pause(), 100);   // the first link goes silent: no pong, no close frame read
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const seen = [];
  const link = new nodes.StagewatchLink({ nodeId: 'ab12cd34', onStatus: (s) => seen.push(s) });
  try {
    link.configure('127.0.0.1:' + srv.address().port, 'swk_testkey');   // secret-scan: fixture
    for (let i = 0; i < 60 && !link.linked; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(link.linked);
    await new Promise((r) => setTimeout(r, 200));
    link.lastHeard = Date.now() - (nodes.GONE_MS + 500);   // 12 s of silence, without waiting for them
    const t0 = Date.now();
    const back = () => dials === 2 && link.linked;
    for (let i = 0; i < 80 && !back(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.includes('reconnecting'), 'it said so: ' + seen.join(','));
    assert.equal(dials, 2, 'redialled');
    assert.ok(link.linked && Date.now() - t0 < 4000, 'connected again within seconds: ' + (Date.now() - t0) + ' ms');
  } finally { link.stop(); for (const c of wss.clients) c.terminate(); wss.close(); srv.close(); }
});
