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

test('host-only check rejects anything that came through a proxy or tunnel', () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.ok(guard.isHostMachine(req('127.0.0.1')));
  assert.ok(!guard.isHostMachine(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })));
  assert.ok(!guard.isHostMachine(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })));
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

test('nodes: Stagewatch address and frame view', () => {
  assert.equal(nodes.normaliseBase('10.0.0.5'), 'http://10.0.0.5:9924');
  assert.equal(nodes.normaliseBase('http://foh-pc:9930/x'), 'http://foh-pc:9930');
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
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  const conns = [];
  wss.on('connection', (ws, req) => { conns.push({ ws, url: req.url, auth: req.headers.authorization }); ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', speakerText: '5 MIN', title: 'Keynote', next: 'Panel', color: '#22C55E' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const states = [];
  const link = new nodes.StagewatchLink({ onState: (v, status) => states.push({ v, status }) });
  try {
    link.configure('127.0.0.1:' + port, 'swk_testkey');
    for (let i = 0; i < 50 && !states.some((s) => s.v && s.v.text === '5 MIN'); i++) await new Promise((r) => setTimeout(r, 50));
    const live = states.find((s) => s.v && s.v.text === '5 MIN');
    assert.ok(live, 'got a live frame');
    assert.equal(live.status, 'connected');
    assert.ok(!/pin=|swk_/.test(conns[0].url), 'the key is never in the URL');
    assert.equal(conns[0].auth, 'Bearer swk_testkey', 'the key rides in the Authorization header');
    const r = await link.sendToStage('Two minutes left, please wrap up', { urgency: 'warn' });
    assert.ok(r.ok);
    const post = posts.find((p) => p.method === 'POST');
    assert.ok(post, 'sent');
    assert.equal(post.auth, 'Bearer swk_testkey');
    assert.equal(decodeURIComponent(post.url), '/api/message/Two minutes left, please wrap up/warn/off/ack');
    assert.equal((await new nodes.StagewatchLink({}).sendToStage('x')).ok, false, 'not linked');
  } finally { link.stop(); wss.close(); srv.close(); }
});
