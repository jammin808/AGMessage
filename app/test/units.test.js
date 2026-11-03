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

test('token bucket: waitMs is the time until it holds the tokens asked, taking none, never sooner than take() would give them', () => {
  // The connection bucket: 3 a second, bursts of 30.
  const b = new guard.Bucket(3, 30, 0);
  assert.equal(b.waitMs(1, 0), 0, 'full: nothing to wait for');
  assert.equal(b.waitMs(30, 0), 0);
  for (let i = 0; i < 30; i++) assert.ok(b.take(1, 0));
  assert.equal(b.take(1, 0), false, 'drained');
  assert.equal(b.waitMs(1, 0), 334, 'one token at 3 a second: a third of a second, in whole ms rounded up');
  assert.equal(b.waitMs(2, 0), 667);
  assert.equal(b.waitMs(1, 200), 134, 'counted from now');
  const held = b.tokens;
  assert.equal(b.waitMs(1, 200), 134, 'asking twice gives the same wait');
  assert.equal(b.tokens, held, 'and asking takes nothing');
  assert.equal(b.take(1, 333), false, 'not a millisecond before');
  assert.equal(b.take(1, 334), true, 'and there at the wait it named');
  assert.equal(b.waitMs(31, 334), Infinity, 'more than the burst is never held');
  assert.equal(new guard.Bucket(0, 5, 0).waitMs(6, 0), Infinity);
  const still = new guard.Bucket(0, 5, 0);
  for (let i = 0; i < 5; i++) still.take(1, 0);
  assert.equal(still.waitMs(1, 0), Infinity, 'a bucket that never fills never holds one');
  const one = new guard.Bucket(1, 3, 1000);
  one.take(3, 1000);
  assert.equal(one.waitMs(1, 1000), 1000);
  assert.equal(one.waitMs(1, 2500), 0, 'refilled meanwhile');
});

test('limitKey: through the tunnel an IPv6 address counts as its /64, in every form it is written; an IPv4 address and every venue address are kept whole', () => {
  // One phone's addresses, as Cloudflare may hand them on: full, compressed, upper case, another host in the same /64.
  const phone = ['cf:2001:db8:1:2::a', 'cf:2001:0db8:0001:0002:0000:0000:0000:000a', 'cf:2001:DB8:1:2::B', 'cf:2001:db8:1:2:ffff:ffff:ffff:ffff', 'cf:2001:db8:1:2:a:b:1.2.3.4', 'cf:2001:db8:1:2::c%eth0'];
  assert.deepEqual([...new Set(phone.map(guard.limitKey))], ['cf6:2001:db8:1:2::/64']);
  assert.equal(guard.limitKey('cf:2001:db8:1:3::a'), 'cf6:2001:db8:1:3::/64', 'the next /64 is another network');
  assert.equal(guard.limitKey('cf:2001:db8::1'), 'cf6:2001:db8:0:0::/64');
  assert.equal(guard.limitKey('cf:::'), 'cf6:0:0:0:0::/64');
  // Kept whole: a tunnel IPv4 address (an IPv4-mapped one as the IPv4 it is), a venue IPv4 and a venue IPv6 address.
  assert.equal(guard.limitKey('cf:203.0.113.7'), 'cf:203.0.113.7');
  assert.equal(guard.limitKey('cf:::ffff:203.0.113.7'), 'cf:203.0.113.7', 'not every mapped address as one /64 of zeros');
  assert.equal(guard.limitKey('192.168.1.20'), '192.168.1.20');
  assert.equal(guard.limitKey('2001:db8:1:2::a'), '2001:db8:1:2::a', 'a venue\'s IPv6 LAN is one /64 for every device on it');
  assert.equal(guard.limitKey('::ffff:127.0.0.1'), '::ffff:127.0.0.1');
  // What is not an address is its own key, never another's; nothing is no key.
  for (const odd of ['cf:not-an-address', 'cf:2001:db8::1::2', 'cf:12345::', 'cf:']) assert.equal(guard.limitKey(odd), odd);
  for (const none of [undefined, null, 42, {}]) assert.equal(guard.limitKey(none), '');
  assert.deepEqual(['cf:2001:db8::1', 'cf:203.0.113.7', '192.168.1.20', '', null].map(guard.laneOf), ['tunnel', 'tunnel', 'venue', 'venue', 'venue']);
});

test('Buckets: past its cap a drained key stays drained (the fullest go first), and waitMs is per key', () => {
  // The connection buckets: 3 a second, bursts of 30, 5,000 networks.
  const T = 5_000_000;
  const conn = new guard.Buckets(3, 30, 5000);
  for (let i = 0; i < 30; i++) assert.ok(conn.take('cf6:2001:db8:1:2::/64', T));
  assert.equal(conn.take('cf6:2001:db8:1:2::/64', T), false, 'the 31st of a burst');
  assert.equal(conn.waitMs('cf6:2001:db8:1:2::/64', 1, T), 334, 'its own wait: one token at 3 a second');
  assert.equal(conn.waitMs('cf:198.51.100.9', 1, T), 0, 'a network it has not seen is full');
  assert.equal(conn.waitMs('cf:198.51.100.9', 31, T), Infinity);
  // 5,001 other networks, all inside the same millisecond: the cap holds, and the drained network is not handed its burst.
  for (let i = 0; i < 5001; i++) conn.take('cf:10.' + (i >> 16) + '.' + ((i >> 8) & 255) + '.' + (i & 255), T);
  assert.ok(conn.map.size <= 5000, 'bounded: ' + conn.map.size);
  assert.ok(conn.map.has('cf6:2001:db8:1:2::/64'), 'the drained network is kept: the fullest went first');
  assert.equal(conn.take('cf6:2001:db8:1:2::/64', T), false, 'still drained');
  assert.equal(conn.waitMs('cf6:2001:db8:1:2::/64', 1, T), 334, 'and still waits for its own next token');
  assert.equal(conn.take('cf6:2001:db8:1:2::/64', T + 334), true, 'which comes at that wait');
});

test('Places: the tunnel\'s places, half at most for one network, every place counted and freed', () => {
  const p = new guard.Places(4);
  assert.deepEqual([p.max, p.share, p.taken, p.networks], [4, 2, 0, 0]);
  assert.equal(p.take('a'), null);
  assert.equal(p.take('a'), null);
  assert.equal(p.take('a'), 'share', 'two from one network, then its share');
  assert.deepEqual([p.taken, p.networks], [2, 1], 'a refusal takes nothing');
  assert.equal(p.take('b'), null);
  assert.equal(p.take('c'), null);
  assert.equal(p.take('d'), 'full', 'four from three networks: full');
  assert.equal(p.take('a'), 'share', 'a network at its share hears its own bound first');
  assert.equal(p.drop('b'), true);
  assert.equal(p.take('d'), null, 'a drop frees one place, which the next takes');
  assert.equal(p.drop('nobody'), false, 'a network with no place frees none');
  assert.deepEqual([p.taken, p.networks], [4, 3]);
  const four = new guard.Places(4);
  for (const k of ['w', 'x', 'y', 'z']) assert.equal(four.take(k), null);
  assert.equal(four.take('v'), 'full', 'four from four networks, then full');
  for (const k of ['w', 'x', 'y', 'z']) four.drop(k);
  assert.deepEqual([four.taken, four.networks], [0, 0], 'every place given back');
  assert.deepEqual([new guard.Places(150).share, new guard.Places(5).share, new guard.Places(1).share], [75, 2, 1], 'half, rounded down, and never none');
  assert.equal(new guard.Places(0).take('a'), 'full', 'no places: every tunnel socket is refused, for the tunnel being full');
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

test('store: a send is said once — byCid across add, del, reset, a compaction and a reload, and the tombstones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  const from = (uid) => ({ uid, name: 'Ana', role: 'research' });
  a.commit(r, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1, from: from('u1'), cid: 'c1' } });
  a.commit(r, { o: 'add', m: { id: 'm2', type: 'text', text: 'two', at: 2, from: from('u1'), cid: 'c2' } });
  a.commit(r, { o: 'add', m: { id: 'm3', type: 'text', text: 'three', at: 3, from: from('u2') } });
  assert.deepEqual(a.sentAs(r, 'u1', 'c1'), { id: 'm1', seq: 1 });
  assert.deepEqual(a.sentAs(r, 'u1', 'c2'), { id: 'm2', seq: 2 });
  assert.equal(a.sentAs(r, 'u2', 'c1'), null, 'a client id is its sender\'s: another person\'s is not theirs');
  assert.equal(a.sentAs(r, 'u1', 'nope'), null);
  for (const bad of [[undefined, 'c1'], ['u1', undefined], ['', 'c1'], ['u1', ''], [{}, 'c1'], ['u1', ['c1']]]) assert.equal(a.sentAs(r, ...bad), null, JSON.stringify(bad));
  assert.equal(r.byId.get('m1').seq, 1, 'a message carries its seq from its op');

  a.commit(r, { o: 'del', id: 'm1' });
  assert.deepEqual(a.sentAs(r, 'u1', 'c1'), { id: 'm1', seq: 1, gone: true }, 'a removed send answers gone, with what it was');
  assert.deepEqual(a.removed(r, 'm1'), { id: 'm1', seq: 1, uid: 'u1', cid: 'c1' });
  a.commit(r, { o: 'del', id: 'm3' });
  assert.deepEqual(a.removed(r, 'm3'), { id: 'm3', seq: 3, uid: 'u2' }, 'a message with no client id leaves its id, seq and sender');
  assert.equal(a.removed(r, 'm2'), null);
  assert.equal(a.removed(r, 42), null);

  // A reload from the log (no snapshot since) and from a compaction build the same indexes.
  const b = new RoomStore(dir);
  b.loadAll(null, { compact: false });
  const rb = b.get('ABC234');
  assert.deepEqual([b.sentAs(rb, 'u1', 'c1'), b.sentAs(rb, 'u1', 'c2'), b.removed(rb, 'm3')], [{ id: 'm1', seq: 1, gone: true }, { id: 'm2', seq: 2 }, { id: 'm3', seq: 3, uid: 'u2' }], 'replayed from the log');
  a.compact('ABC234');
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'ABC234.json'), 'utf8'));
  assert.deepEqual(snap.gone, [{ id: 'm1', seq: 1, uid: 'u1', cid: 'c1' }, { id: 'm3', seq: 3, uid: 'u2' }], 'the snapshot keeps the tombstones as gone');
  const c = new RoomStore(dir);
  c.loadAll();
  const rc = c.get('ABC234');
  assert.deepEqual([c.sentAs(rc, 'u1', 'c1'), c.sentAs(rc, 'u1', 'c2'), c.removed(rc, 'm3')], [{ id: 'm1', seq: 1, gone: true }, { id: 'm2', seq: 2 }, { id: 'm3', seq: 3, uid: 'u2' }], 'loaded from the snapshot');

  // A reset leaves a tombstone for what people wrote, never for a system line.
  c.commit(rc, { o: 'add', m: { id: 's1', type: 'system', text: 'Ana joined as research', at: 4 } });
  c.commit(rc, { o: 'reset' });
  assert.deepEqual(c.sentAs(rc, 'u1', 'c2'), { id: 'm2', seq: 2, gone: true });
  assert.equal(c.removed(rc, 's1'), null, 'a system line leaves none');
  assert.equal(rc.byCid.size, 0);
  const d = new RoomStore(dir);
  d.loadAll();
  assert.deepEqual(d.sentAs(d.get('ABC234'), 'u1', 'c2'), { id: 'm2', seq: 2, gone: true }, 'a reset\'s tombstones survive a restart');
});

test('store: the newest 500 tombstones are kept, in memory and in the snapshot; a snapshot without them loads with none', () => {
  const { GONE_KEEP } = require('../lib/store');
  assert.equal(GONE_KEEP, 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'Test');
  for (let i = 0; i < 520; i++) a.commit(r, { o: 'add', m: { id: 'm' + i, type: 'text', text: 't' + i, at: i, from: { uid: 'u1', name: 'Ana', role: 'research' }, cid: 'c' + i } });
  a.commit(r, { o: 'reset' });
  assert.equal(r.gone.size, 500);
  assert.equal(r.goneKeys.size, 500);
  assert.equal(a.sentAs(r, 'u1', 'c19'), null, 'the oldest went, its client id with it');
  assert.deepEqual(a.sentAs(r, 'u1', 'c20'), { id: 'm20', seq: 21, gone: true });
  assert.deepEqual(a.sentAs(r, 'u1', 'c519'), { id: 'm519', seq: 520, gone: true });
  a.commit(r, { o: 'add', m: { id: 'n1', type: 'text', text: 'x', at: 1, from: { uid: 'u1', name: 'Ana', role: 'research' }, cid: 'k1' } });
  a.commit(r, { o: 'del', id: 'n1' });
  assert.equal(r.gone.size, 500);
  assert.equal(a.sentAs(r, 'u1', 'c20'), null, 'a new tombstone pushes out the oldest');
  a.compact('ABC234');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ABC234.json'), 'utf8')).gone.length, 500);

  // A 0.5.1 snapshot: no `gone`, messages without client ids. It loads, and a shape no snapshot of ours writes is skipped.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  fs.writeFileSync(path.join(old, 'OLD234.json'), JSON.stringify({ code: 'OLD234', name: 'Then', createdAt: 1, seq: 2, settings: {}, messages: [{ id: 'm1', type: 'text', text: 'hi', at: 1, from: { uid: 'u1' }, seq: 1 }] }));
  const b = new RoomStore(old);
  assert.equal(b.loadAll(), 1);
  const rb = b.get('OLD234');
  assert.equal(rb.gone.size, 0);
  assert.equal(rb.byCid.size, 0);
  assert.equal(rb.messages.length, 1);
  fs.writeFileSync(path.join(old, 'BAD234.json'), JSON.stringify({ code: 'BAD234', seq: 1, messages: [], gone: [null, 'x', { id: 7 }, { id: '' }, { id: 'ok', seq: 'x', uid: 5, cid: {} }] }));
  const c = new RoomStore(old);
  c.loadAll();
  assert.deepEqual(Array.from(c.get('BAD234').gone.values()), [{ id: 'ok' }]);
});

// ---------------------------------------------------------------- a start and a stop write only the dirty halls
const { COMPACT_EVERY, SNAPSHOT_FIELDS } = require('../lib/store');

test('store: a start and a stop write only the dirty halls: a line in the log, an op the log refused, a change made without an op, or no whole snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const say = (store, room, id) => store.commit(room, { o: 'add', m: { id, type: 'text', text: id, at: 1 } });
  const a = new RoomStore(dir);
  const [r1, r2, r3] = ['ABC234', 'DEF234', 'GHJ234'].map((c) => a.create(c, c));
  assert.deepEqual([a.dirtyCodes(), a.snapshots], [[], 3], 'each made with its snapshot, clean');
  say(a, r1, 'm1');
  assert.deepEqual(a.dirtyCodes(), ['ABC234']);
  assert.equal(a.compactDirty(), 1, 'one written');
  assert.deepEqual([a.dirtyCodes(), a.compactDirty(), a.snapshots], [[], 0, 4], 'and none the second time');
  // A change made without an op is marked, and written once.
  r2.name = 'moved';
  a.markDirty(r2);
  assert.deepEqual(a.dirtyCodes(), ['DEF234']);
  assert.equal(a.compactDirty(), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'DEF234.json'), 'utf8')).name, 'moved');
  assert.deepEqual(a.dirtyCodes(), []);
  // A snapshot that fails leaves its hall dirty, for the next one; compact() says whether it wrote.
  say(a, r3, 'm2');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('GHJ234.json')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return rename.call(fs, from, to); };
  try { assert.equal(a.compactDirty(), 0); assert.equal(a.compact('GHJ234'), false); } finally { fs.renameSync = rename; }
  assert.deepEqual(a.dirtyCodes(), ['GHJ234'], 'still dirty');
  assert.equal(a.compact('NOHALL'), false);
  say(a, r1, 'm3');   // in the log only, as at a crash

  // A load: a hall whose log holds lines is dirty, one whose snapshot holds everything is not, and only the dirty are written.
  const b = new RoomStore(dir);
  b.loadAll(null, { compact: false });
  assert.deepEqual([b.dirtyCodes().sort(), b.get('ABC234').logCount, b.get('DEF234').logCount], [['ABC234', 'GHJ234'], 1, 0]);
  const json = (c) => fs.readFileSync(path.join(dir, c + '.json'), 'utf8');
  const clean = json('DEF234');
  assert.equal(b.compactDirty(), 2);
  assert.equal(json('DEF234'), clean, 'a clean hall is not written');
  const c = new RoomStore(dir);
  assert.equal(c.loadAll(), 3);
  assert.deepEqual([c.dirtyCodes(), c.snapshots], [[], 0], 'a start after a stop that saved writes no hall');
  // A snapshot torn on disk (the load fell back to the .bak) is dirty: it is written again.
  fs.writeFileSync(path.join(dir, 'DEF234.json'), '{"code":"DEF2');
  const d = new RoomStore(dir);
  d.loadAll(null, { compact: false });
  assert.deepEqual(d.dirtyCodes(), ['DEF234']);
});

test('store: every line of a log counts toward its snapshot, the lines a start replays included, so a log stays bounded across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const log = path.join(dir, 'ABC234.log');
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  let n = 0;
  let s = new RoomStore(dir);
  s.create('ABC234', 'T');
  // Five runs, each killed after 300 changes (no stop, no snapshot): each start counts the lines it found, so the log is
  // folded into its snapshot at COMPACT_EVERY lines whatever the restarts between, and never holds more.
  let most = 0;
  for (let run = 0; run < 5; run++) {
    s = new RoomStore(dir);
    s.loadAll(null, { compact: false });
    const room = s.get('ABC234');
    assert.equal(room.logCount, lines(), 'a start counts every line it found');
    for (let i = 0; i < 300; i++) { s.commit(room, { o: 'add', m: { id: 'm' + n++, type: 'text', text: 'x', at: 1 } }); most = Math.max(most, lines()); }
    assert.equal(room.messages.length, n);
  }
  assert.equal(COMPACT_EVERY, 500);
  assert.ok(most < COMPACT_EVERY, 'the log never held ' + COMPACT_EVERY + ' lines: at most ' + most);
  // A line the snapshot already holds (a stop cut between the snapshot and the log's truncation) and a torn one count too.
  s = new RoomStore(dir);
  s.loadAll();   // the log folded in
  const seq = s.get('ABC234').seq;
  fs.writeFileSync(log, JSON.stringify({ o: 'add', m: { id: 'old', type: 'text', text: 'x', at: 1 }, s: seq }) + '\n{"o":"add","m":{"id":"to');
  const t = new RoomStore(dir);
  t.loadAll(null, { compact: false });
  assert.deepEqual([t.get('ABC234').logCount, t.get('ABC234').messages.length, t.dirtyCodes()], [2, n, ['ABC234']]);
});

test('store: the fence on the snapshot: every field it writes has its row, with the change that marks its hall dirty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const r = a.create('ABC234', 'T');
  const fields = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'ABC234.json'), 'utf8')));
  assert.deepEqual(fields(), Object.keys(SNAPSHOT_FIELDS), 'a field written to the snapshot is a row of SNAPSHOT_FIELDS first, and a row is a field written');
  for (const [field, change] of Object.entries(SNAPSHOT_FIELDS)) assert.ok(typeof change === 'string' && /\bop\b|markDirty|create\(\)|the snapshot itself/.test(change), field + ' says what marks it: ' + change);
  // Each op kind marks its hall dirty, and its snapshot then holds the change.
  const ops = [
    [{ o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } }, (j) => j.messages.length === 1],
    [{ o: 'upd', id: 'm1', f: { pinned: true } }, (j) => j.messages[0].pinned === true],
    [{ o: 'meta', name: 'Renamed', settings: { lock: true } }, (j) => j.name === 'Renamed' && j.settings.lock === true],
    [{ o: 'del', id: 'm1' }, (j) => !j.messages.length && j.gone.length === 1],
    [{ o: 'reset' }, (j) => !j.messages.length],
  ];
  for (const [op, held] of ops) {
    a.commit(r, op);
    assert.deepEqual(a.dirtyCodes(), ['ABC234'], op.o + ' marks the hall dirty');
    assert.equal(a.compactDirty(), 1);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'ABC234.json'), 'utf8'));
    assert.ok(held(j) && j.seq === r.seq, op.o + ' is in the snapshot');
  }
  // The source half: the fields an op writes are written by no file but the store (a change made elsewhere would go
  // unmarked). A hall's settings, messages or tombstones, reached through any name and however deep, assigned, counted,
  // deleted, merged into or changed by a call; its name or change number through the names the server gives a hall. A
  // message changed in place (one taken from `byId`) is no pattern's: the runtime half below, on every server the tests and
  // the smoke start (test/snapshot-preload.js), holds each hall a start or a stop leaves unwritten to the store's copy.
  const ROOT = path.join(__dirname, '..');
  const NAME = String.raw`[A-Za-z_$][\w$]*`;
  const FIELD = String.raw`\b${NAME}\.(?:settings|messages|gone)\b`;
  const CHAIN = String.raw`(?:\.${NAME}|\[[^\]\n]*\])*`;
  const fieldWritten = new RegExp([   // eslint-disable-line security/detect-non-literal-regexp -- built from this test's own literal parts
    String.raw`${FIELD}${CHAIN}\s*(?:[-+*/%&|^]?=(?!=)|\+\+|--)`,
    String.raw`\bdelete\s+${FIELD}`,
    String.raw`${FIELD}${CHAIN}\.(?:push|splice|pop|shift|unshift|sort|reverse|set|delete|clear|fill|copyWithin)\(`,
    String.raw`\bObject\.(?:assign|defineProperty|defineProperties)\(\s*${FIELD}`,
  ].join('|'));
  const HALL = ['room', 'hall', 'r', 'h', 'dst', 'src'];   // what server.js and lib/ call a hall
  const nameWrittenBy = (names) => new RegExp(String.raw`\b(?:${names.join('|')})\.(?:name|seq)\s*(?:[-+*/]?=(?!=)|\+\+|--)`);   // eslint-disable-line security/detect-non-literal-regexp -- this test's own names
  const nameWritten = nameWrittenBy(HALL);
  // A file whose short name is not a hall: lib/displays.js's `r` is a screen's take result, numbered by its own `seq`.
  const NOT_A_HALL = { 'lib/displays.js': ['r'] };
  assert.deepEqual(Object.keys(SNAPSHOT_FIELDS).filter((f) => !['code', 'createdAt', 'savedAt'].includes(f)), ['name', 'seq', 'settings', 'messages', 'gone'], 'the fields a change makes, as the patterns name them');
  const files = ['server.js', ...require('./helpers').filesUnder('lib', /\.js$/)].filter((f) => f !== 'lib/store.js');
  assert.ok(files.includes('lib/board.js') && files.length > 20);
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, fieldWritten, f + ' changes a hall\'s snapshot field: through an op, or markDirty');
    const names = HALL.filter((n) => !(NOT_A_HALL[f] || []).includes(n));
    assert.doesNotMatch(src, nameWrittenBy(names), f + ' changes a hall\'s name or change number: through an op');
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'lib/displays.js'), 'utf8'), /\br\.seq = seq;/, 'the one exception is still there to need its row');
  const writes = ['r.settings.lockRoles = true', 'r.name = x', 'h.messages.push(m)', 'dst.settings = {}', 'room.settings.seats[uid] = s', 'delete room.settings.codeOff',
    'Object.assign(room.settings, x)', 'hall.seq++', 'src.gone.clear()', 'x.messages.length = 0', 'room.settings.n += 1'];
  for (const w of writes) assert.ok(fieldWritten.test(w) || nameWritten.test(w), 'the fence reads a change: ' + w);
  for (const r of ['r.settings.x === 1', 'r.settings.x >= 1', 'Object.assign({}, r.settings)', 'r.messages.slice().sort()', 'const n = r.messages.length', 'user.name = x']) {
    assert.ok(!fieldWritten.test(r) && !nameWritten.test(r), 'a read is no change: ' + r);
  }
});

test('store: the fence\'s runtime half finds each field of a hall changed beside the store, which a start and a stop leave unwritten, and nothing the store was told of', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const out = path.join(dir, 'found.txt');
  const rooms = path.join(dir, 'rooms');
  const at = (f) => JSON.stringify(path.join(__dirname, ...f));
  // In a process of its own, as a server under test loads it; what it found is written as that process exits.
  const script = [
    'require(' + at(['snapshot-preload.js']) + ');',
    'const { RoomStore } = require(' + at(['..', 'lib', 'store.js']) + ');',
    'const a = new RoomStore(' + JSON.stringify(rooms) + ');',
    'const [one, two, three, four, five] = ["ABC234", "DEF234", "GHJ234", "KLM234", "NPQ234"].map((c) => a.create(c, c));',
    'const [legal, media] = [["LGQ4MZP8", "Legal"], ["MDR7VX2C", "Media"]].map(([k, n]) => a.createIn("ABC234", k, n));',
    'a.commit(one, { o: "add", m: { id: "m1", type: "text", text: "x", at: 1 } });',
    'a.commit(media, { o: "add", m: { id: "m2", type: "text", text: "y", at: 1 } });',
    'a.compactDirty();',
    // Beside the store: a message changed in place, a setting written, a name; none marked, none written by the stop. A
    // side room is held as a hall is.
    'one.byId.get("m1").pinned = true; two.settings.lockRoles = true; three.name = "moved"; legal.settings.lockRoles = true; media.byId.get("m2").pinned = true;',
    // Told: an op, and a change marked.
    'a.commit(four, { o: "meta", name: "renamed" }); five.settings.x = 1; a.markDirty(five);',
    'a.compactDirty();',
    // A start: what the load's onMigrate changes without marking it is beside the store too; marked, it is written.
    'const b = new RoomStore(' + JSON.stringify(rooms) + ');',
    'b.loadAll((room) => { if (room.code === "KLM234") room.settings.y = 2; if (room.code === "NPQ234") { room.name = "then"; b.markDirty(room); } }, { compact: false });',
    'b.compactDirty();',
  ].join('\n');
  require('child_process').execFileSync(process.execPath, ['-e', script], { env: { ...process.env, AGM_TEST_SNAPSHOTS: out } });
  assert.deepEqual(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).sort(), ['ABC234 messages', 'DEF234 settings', 'GHJ234 name', 'KLM234 settings', 'LGQ4MZP8 settings', 'MDR7VX2C messages']);
});

// ---------------------------------------------------------------- a hall's side rooms, kept beside it
const { CODE_RE, SIDE_RE, SIDE_MAX } = require('../lib/store');
/** What the store said on the console while `fn` ran, its warnings and errors, one string a line. */
function said(fn) {
  const lines = [];
  const { warn, error } = console;
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.warn = warn; console.error = error; }
  return lines;
}
const sayIn = (store, room, id) => store.commit(room, { o: 'add', m: { id, type: 'text', text: id, at: 1 } });
const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).sort();

test('store: a side room is kept beside its hall as <HALL>.<KEY>, and reloads under it with its seq, its messages and its log replayed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const hall = a.create('HALL01', 'Hall 1');
  a.create('HALL02', 'Hall 2');
  const legal = a.createIn('HALL01', 'LGQ4MZP8', 'Legal');
  const media = a.createIn('HALL01', 'MDR7VX2C', 'Media');
  assert.deepEqual([legal.code, legal.hall, legal.name, hall.hall], ['LGQ4MZP8', 'HALL01', 'Legal', 'HALL01'], 'a room knows its hall; a Main room is its own');
  assert.deepEqual(legal.settings, { codeOff: true }, 'its guest code off at birth: a new room is for accounts until it is switched on');
  assert.deepEqual(a.createIn('HALL01', 'TEST2345', 'X', { settings: { codeOff: false, lockRoles: true } }).settings, { codeOff: false, lockRoles: true });
  a.remove('TEST2345');
  assert.deepEqual(jsonFiles(dir), ['HALL01.LGQ4MZP8.json', 'HALL01.MDR7VX2C.json', 'HALL01.json', 'HALL02.json'], 'each with its first snapshot, beside its hall');
  sayIn(a, legal, 'l1');
  sayIn(a, legal, 'l2');
  assert.ok(a.compact('LGQ4MZP8'));
  sayIn(a, legal, 'l3');   // in its log only, as at a crash
  sayIn(a, hall, 'h1');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'HALL01.LGQ4MZP8.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).m.id), ['l3']);
  assert.deepEqual([legal.seq, hall.seq, media.seq], [3, 1, 0], 'each room numbers its own changes');
  // Its snapshot holds the fields a hall's does, its key as its code; its hall is named by its file, never in a field,
  // and the hall's snapshot names none of its rooms.
  const snap = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(Object.keys(snap('HALL01.LGQ4MZP8.json')), Object.keys(SNAPSHOT_FIELDS));
  assert.equal(snap('HALL01.LGQ4MZP8.json').code, 'LGQ4MZP8');
  assert.ok(a.compact('HALL01'));
  assert.deepEqual(Object.keys(snap('HALL01.json')), Object.keys(SNAPSHOT_FIELDS), 'a hall\'s snapshot is the shape a hall without rooms writes');
  assert.ok(!/LGQ4MZP8|MDR7VX2C/.test(fs.readFileSync(path.join(dir, 'HALL01.json'), 'utf8')));

  const b = new RoomStore(dir);
  assert.equal(b.loadAll(null, { compact: false }), 4, 'two halls and two side rooms');
  const back = b.room('LGQ4MZP8');
  assert.deepEqual([back.hall, back.name, back.seq, back.messages.map((m) => m.id), back.logCount, back.settings], ['HALL01', 'Legal', 3, ['l1', 'l2', 'l3'], 1, { codeOff: true }]);
  assert.deepEqual(b.roomsOf('HALL01').map((r) => [r.code, r.seq]), [['HALL01', 1], ['LGQ4MZP8', 3], ['MDR7VX2C', 0]]);
  // The next change carries on from its seq, and a page that missed one resumes within the room.
  const op = sayIn(b, back, 'l4');
  assert.equal(op.s, 4);
  assert.deepEqual(b.opsSince(back, 3).map((o) => o.m.id), ['l4']);
});

test('store: the hall readers never see a side room; the any-room readers do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const [h1, h2] = [a.create('HALL01', 'Hall 1'), a.create('HALL02', 'Hall 2')];
  const media = a.createIn('HALL01', 'MDR7VX2C', 'Media');
  media.createdAt = 1;   // made before Legal: the order a hall's rooms are listed in is the order they were made
  const legal = a.createIn('HALL01', 'LGQ4MZP8', 'Legal');
  legal.createdAt = 2;
  const press = a.createIn('HALL02', 'PRS3SS45', 'Press');
  // A hall: its Main room, by `rooms`, `get` and `has`, and nothing else.
  assert.deepEqual(Array.from(a.rooms.keys()), ['HALL01', 'HALL02']);
  assert.deepEqual([a.get('LGQ4MZP8'), a.has('LGQ4MZP8'), a.get('HALL01')], [undefined, false, h1]);
  // Any room.
  assert.deepEqual([a.room('LGQ4MZP8'), a.room('HALL02'), a.room('NOPE2345')], [legal, h2, undefined]);
  assert.deepEqual(['LGQ4MZP8', 'HALL01', 'NOPE2345', undefined].map((k) => a.hasRoom(k)), [true, true, false, false]);
  assert.deepEqual(a.allRooms().map((r) => r.code), ['HALL01', 'HALL02', 'MDR7VX2C', 'LGQ4MZP8', 'PRS3SS45'], 'the halls, then the side rooms');
  assert.deepEqual(a.roomsOf('HALL01'), [h1, media, legal], 'its Main room first, then its side rooms as they were made');
  assert.deepEqual(a.roomsOf('HALL02'), [h2, press]);
  assert.deepEqual([a.roomsOf('LGQ4MZP8'), a.roomsOf('NOPE2345')], [[], []], 'a side room is no hall, and holds no rooms');
  assert.deepEqual([h1, legal, null, undefined].map((r) => a.isMain(r)), [true, false, false, false]);
});

test('store: a side room is made only beside a hall that is here, under a key no room has, and at most SIDE_MAX to a hall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  a.create('HALL01', 'Hall 1');
  assert.ok(a.createIn('HALL01', 'LGQ4MZP8', 'Legal'));
  const refused = [['NOPE2345', 'KEY23456'], ['LGQ4MZP8', 'KEY23456'], ['HALL01', 'LGQ4MZP8'], ['HALL01', 'HALL01'], ['HALL01', 'lower234'], ['HALL01', 'A.B'], ['HALL01', 'K3'], ['HALL01', 7]];
  for (const [hall, key] of refused) assert.equal(a.createIn(hall, key, 'X'), null, hall + ' / ' + key);
  assert.deepEqual(jsonFiles(dir), ['HALL01.LGQ4MZP8.json', 'HALL01.json'], 'a refusal writes nothing');
  assert.equal(SIDE_MAX, 20);
  for (let i = 2; i <= SIDE_MAX; i++) assert.ok(a.createIn('HALL01', 'SIDE' + String(i).padStart(4, '0').replace(/0/g, 'Z'), 'Room ' + i), 'side room ' + i);
  assert.equal(a.roomsOf('HALL01').length, 1 + SIDE_MAX);
  assert.equal(a.createIn('HALL01', 'ONEMORE2', 'One more'), null, 'the 21st is refused');
});

test('store: a side room whose hall is gone, one whose key another room has, and a file of no hall or room, are said, not loaded, and kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  a.create('HALL01', 'Hall 1');
  a.create('HALL02', 'Hall 2');
  sayIn(a, a.createIn('HALL01', 'LGQ4MZP8', 'Legal'), 'kept');
  a.compactDirty();   // every room loaded is clean: the load writes none
  // Files placed by hand: a room of a hall that is not here, a second room under Legal's key, one under a hall's key,
  // and two names that are no hall's and no room's.
  const room = (code) => JSON.stringify({ code, name: code, createdAt: 1, seq: 0, settings: {}, messages: [] });
  const placed = { 'GONE99.ORPHAN23.json': room('ORPHAN23'), 'HALL02.LGQ4MZP8.json': room('LGQ4MZP8'), 'HALL02.HALL01.json': room('HALL01'), 'lower.json': room('X'), 'A.B.C.json': room('X') };
  for (const [f, text] of Object.entries(placed)) fs.writeFileSync(path.join(dir, f), text);
  const before = jsonFiles(dir).map((f) => f + ':' + fs.readFileSync(path.join(dir, f), 'utf8'));
  const b = new RoomStore(dir);
  let n = 0;
  const lines = said(() => { n = b.loadAll(); });
  assert.equal(n, 3, 'the two halls and Legal');
  assert.deepEqual(b.allRooms().map((r) => r.code), ['HALL01', 'HALL02', 'LGQ4MZP8']);
  assert.equal(b.room('LGQ4MZP8').hall, 'HALL01', 'the room under its own hall, whatever another file claims');
  assert.deepEqual(b.room('LGQ4MZP8').messages.map((m) => m.id), ['kept']);
  assert.deepEqual(lines.sort(), [
    '  Not loaded: A.B.C names no hall and no room (its files are kept)',
    '  Not loaded: lower names no hall and no room (its files are kept)',
    '  Not loaded: room HALL01 of hall HALL02 — another room has its key (its files are kept as HALL02.HALL01)',
    '  Not loaded: room LGQ4MZP8 of hall HALL02 — another room has its key (its files are kept as HALL02.LGQ4MZP8)',
    '  Not loaded: room ORPHAN23 — its hall GONE99 is gone (its files are kept as GONE99.ORPHAN23)',
  ]);
  assert.deepEqual(jsonFiles(dir).map((f) => f + ':' + fs.readFileSync(path.join(dir, f), 'utf8')), before, 'every file is kept as it was');
});

test('store: compactDirty, dirtyCodes, unsaved, remove and removeHall cover the side rooms; a hall goes with its rooms, its side rooms\' files first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  const hall = a.create('HALL01', 'Hall 1');
  const other = a.create('HALL02', 'Hall 2');
  const legal = a.createIn('HALL01', 'LGQ4MZP8', 'Legal');
  const media = a.createIn('HALL01', 'MDR7VX2C', 'Media');
  const press = a.createIn('HALL02', 'PRS3SS45', 'Press');
  assert.deepEqual(a.dirtyCodes(), [], 'each made with its snapshot, clean');
  sayIn(a, legal, 'l1');
  assert.deepEqual(a.dirtyCodes(), ['LGQ4MZP8']);
  assert.equal(a.compactDirty(), 1);
  assert.deepEqual(a.dirtyCodes(), []);
  // An append the disk refuses: the side room is unsaved until its next snapshot lands.
  const log = path.join(dir, 'HALL01.MDR7VX2C.log');
  fs.unlinkSync(log);
  fs.mkdirSync(log);
  said(() => sayIn(a, media, 'm1'));
  assert.deepEqual([a.unsaved(), a.dirtyCodes()], [['MDR7VX2C'], ['MDR7VX2C']]);
  fs.rmdirSync(log);
  assert.equal(a.compactDirty(), 1);
  assert.deepEqual(a.unsaved(), []);

  // A side room alone: its files go (its open log let go first), and nothing else's.
  sayIn(a, press, 'p1');
  assert.notEqual(press.logFd, null);
  assert.deepEqual(a.remove('PRS3SS45'), { rooms: [press], kept: [], again: 0 });
  assert.deepEqual([a.room('PRS3SS45'), a.roomsOf('HALL02')], [undefined, [other]]);
  assert.deepEqual(jsonFiles(dir), ['HALL01.LGQ4MZP8.json', 'HALL01.MDR7VX2C.json', 'HALL01.json', 'HALL02.json']);
  assert.equal(press.logFd, null, 'its log let go');
  // A hall goes with its rooms, its side rooms' files first: a stop part way leaves a whole hall with fewer rooms, never a
  // side room without its hall.
  const order = [];
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (f) => { if (/\.json$/.test(String(f))) order.push(path.basename(String(f))); return unlink.call(fs, f); };
  let gone;
  try { gone = a.removeHall('HALL01'); } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(gone, { rooms: [hall, legal, media], kept: [], again: 0 }, 'the rooms removed, Main first, every file gone');
  assert.deepEqual(order, ['HALL01.LGQ4MZP8.json', 'HALL01.MDR7VX2C.json', 'HALL01.json']);
  assert.deepEqual([a.allRooms(), jsonFiles(dir)], [[other], ['HALL02.json']]);
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('HALL01')), 'no file of the hall is left: snapshots, logs and backups');
  // remove() of a hall is removeHall().
  const again = a.createIn('HALL02', 'PRS3SS45', 'Press');
  assert.deepEqual(a.remove('HALL02'), { rooms: [other, again], kept: [], again: 0 });
  assert.deepEqual([a.allRooms(), fs.readdirSync(dir)], [[], []]);
  const c = new RoomStore(dir);
  assert.equal(c.loadAll(), 0, 'the next start loads cleanly');
});

test('store: 0.5.1 loads a hall\'s file and never a side room\'s, whose name its one test, CODE_RE, refuses', () => {
  // 0.5.1's loader (lib/store.js at 0.5.1): each name in the folder whose stem CODE_RE takes is a hall; every other is skipped.
  const CODE_RE_051 = /^[A-Z0-9]{4,12}$/;
  assert.equal(String(CODE_RE), String(CODE_RE_051), 'a hall\'s stem is read as 0.5.1 reads it');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  a.create('HALL01', 'Hall 1');
  sayIn(a, a.createIn('HALL01', 'LGQ4MZP8', 'Legal'), 'l1');
  a.compactDirty();
  const stems = new Set(fs.readdirSync(dir).map((f) => (/^(.+)\.json(\.bak)?$/.exec(f) || [])[1]).filter(Boolean));
  assert.deepEqual([...stems].sort(), ['HALL01', 'HALL01.LGQ4MZP8']);
  assert.deepEqual([...stems].filter((s) => CODE_RE_051.test(s)), ['HALL01'], '0.5.1 loads the hall alone');
  assert.ok(SIDE_RE.test('HALL01.LGQ4MZP8') && !SIDE_RE.test('HALL01') && !CODE_RE_051.test('HALL01.LGQ4MZP8'));
});

test('store: a room whose file another program holds keeps its files from that one on, says so, and loads again whole only beside its hall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  a.create('HALL01', 'Hall 1');
  a.create('HALL02', 'Hall 2');
  const legal = a.createIn('HALL01', 'LGQ4MZP8', 'Legal');
  const press = a.createIn('HALL02', 'PRS3SS45', 'Press');
  for (const r of [legal, press]) { sayIn(a, r, r.code + '-1'); a.compact(r.code); sayIn(a, r, r.code + '-2'); }   // a snapshot, its backup and a log line
  /** Remove with `held` (a file's name → its code) held by another program; gives back the answer and the console's lines. */
  const removing = (fn, held) => {
    const unlink = fs.unlinkSync;
    const tried = [];
    fs.unlinkSync = (f) => {
      const name = path.basename(String(f));
      tried.push(name);
      if (held[name]) throw Object.assign(new Error(held[name] + ': held'), { code: held[name] });
      return unlink.call(fs, f);
    };
    let answer;
    let lines;
    try { lines = said(() => { answer = fn(); }); } finally { fs.unlinkSync = unlink; }
    return { answer, lines, tried };
  };
  // Its snapshot held: the room goes from memory, its files from that one on stay, and it loads again whole.
  const one = removing(() => a.remove('LGQ4MZP8'), { 'HALL01.LGQ4MZP8.json': 'EBUSY' });
  assert.deepEqual(one.answer, { rooms: [legal], kept: ['HALL01.LGQ4MZP8.json'], again: 1 });
  assert.deepEqual(one.tried, ['HALL01.LGQ4MZP8.json.bak', 'HALL01.LGQ4MZP8.json'], 'its backup, then its snapshot, where it stops');
  assert.deepEqual(one.lines, ['  Could not remove HALL01.LGQ4MZP8.json (EBUSY): it and the files of its room after it stay on disk']);
  assert.deepEqual([a.room('LGQ4MZP8'), a.roomsOf('HALL01').length], [undefined, 1]);
  const b = new RoomStore(dir);
  b.loadAll(null, { compact: false });
  assert.deepEqual(b.room('LGQ4MZP8').messages.map((m) => m.id), ['LGQ4MZP8-1', 'LGQ4MZP8-2'], 'whole: its snapshot and its log');
  // Only its log held: its snapshot and backup gone, nothing of it loads again; the log stays, unused.
  const two = removing(() => a.remove('PRS3SS45'), { 'HALL02.PRS3SS45.log': 'EPERM' });
  assert.deepEqual(two.answer, { rooms: [press], kept: ['HALL02.PRS3SS45.log'], again: 0 });
  assert.ok(fs.existsSync(path.join(dir, 'HALL02.PRS3SS45.log')) && !fs.existsSync(path.join(dir, 'HALL02.PRS3SS45.json')));
  // A hall whose side room's snapshot is held: the hall goes, so the room left on disk never loads again (it has no hall).
  const c = new RoomStore(dir);
  said(() => c.loadAll());
  const [hall, back] = [c.get('HALL01'), c.room('LGQ4MZP8')];
  const media = c.createIn('HALL01', 'MDR7VX2C', 'Media');
  assert.deepEqual(removing(() => c.removeHall('HALL01'), { 'HALL01.LGQ4MZP8.json': 'EBUSY' }).answer, { rooms: [hall, back, media], kept: ['HALL01.LGQ4MZP8.json'], again: 0 });
  // A hall whose own snapshot is held loads again, with each of its side rooms whose snapshot stayed beside it.
  const h3 = c.create('HALL03', 'Hall 3');
  const [s1, s2] = [c.createIn('HALL03', 'SIDE2345', 'One'), c.createIn('HALL03', 'SIDE6789', 'Two')];
  assert.deepEqual(removing(() => c.remove('HALL03'), { 'HALL03.json': 'EBUSY', 'HALL03.SIDE2345.json': 'EBUSY' }).answer, { rooms: [h3, s1, s2], kept: ['HALL03.SIDE2345.json', 'HALL03.json'], again: 2 });
  const d = new RoomStore(dir);
  const lines = said(() => d.loadAll(null, { compact: false }));
  assert.deepEqual(d.allRooms().map((r) => r.code), ['HALL02', 'HALL03', 'SIDE2345']);
  assert.deepEqual(lines, ['  Not loaded: room LGQ4MZP8 — its hall HALL01 is gone (its files are kept as HALL01.LGQ4MZP8)']);
});

test('store: a hall holds SIDE_MAX side rooms at a start: one more on disk is said, left out and kept, the same ones every start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const a = new RoomStore(dir);
  a.create('HALL01', 'Hall 1');
  const keys = Array.from({ length: SIDE_MAX + 1 }, (_, i) => 'ROOM' + String.fromCharCode(65 + i) + 'ZZZ');
  for (const k of keys.slice(0, SIDE_MAX)) a.createIn('HALL01', k, k);
  // One more, laid on by hand (a folder restored or edited): its name sorts last.
  const extra = keys[SIDE_MAX];
  fs.writeFileSync(path.join(dir, 'HALL01.' + extra + '.json'), JSON.stringify({ code: extra, name: extra, createdAt: 1, seq: 0, settings: {}, messages: [] }));
  for (let i = 0; i < 2; i++) {
    const b = new RoomStore(dir);
    let n = 0;
    const lines = said(() => { n = b.loadAll(); });
    assert.equal(n, 1 + SIDE_MAX);
    assert.deepEqual(b.roomsOf('HALL01').slice(1).map((r) => r.code).sort(), keys.slice(0, SIDE_MAX).sort());
    assert.deepEqual(lines, ['  Not loaded: room ' + extra + ' of hall HALL01 — the hall holds ' + SIDE_MAX + ' rooms beside it already (its files are kept as HALL01.' + extra + ')']);
    assert.ok(fs.existsSync(path.join(dir, 'HALL01.' + extra + '.json')), 'its file kept');
  }
});

// ---------------------------------------------------------------- compaction trusts the snapshot it wrote
const resilience = require('../lib/resilience');
/** Run `fn`, counting the times `file` is read whole (fs.readFileSync); gives back that count. */
function readsOf(file, fn) {
  const read = fs.readFileSync;
  let n = 0;
  fs.readFileSync = (f, ...rest) => { if (path.resolve(String(f)) === path.resolve(file)) n++; return read.call(fs, f, ...rest); };
  try { fn(); } finally { fs.readFileSync = read; }
  return n;
}

test('atomic write: a file known whole is kept as .bak unread; one not known is read, and kept only when it parses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-whole-'));
  const f = path.join(dir, 'ABC234.json');
  const text = (x) => fs.readFileSync(x, 'utf8');
  resilience.writeFileAtomic(f, '{"v":1}', { keepBak: true });
  assert.equal(readsOf(f, () => resilience.writeFileAtomic(f, '{"v":2}', { keepBak: true, knownWhole: true })), 0, 'a known-whole file is not read');
  assert.deepEqual([text(f), text(f + '.bak')], ['{"v":2}', '{"v":1}'], 'and is copied to .bak');

  // Not known whole: read and parsed first, so a torn file never replaces the good backup.
  fs.writeFileSync(f, '{"v":3');
  assert.equal(readsOf(f, () => resilience.writeFileAtomic(f, '{"v":4}', { keepBak: true })), 1, 'read before it may replace the .bak');
  assert.deepEqual([text(f), text(f + '.bak')], ['{"v":4}', '{"v":1}'], 'the torn file was not kept');

  // `knownWhole` is the writer's word, taken unread: a torn file vouched for is copied as it is. Only the one writer of
  // a file, which wrote it or read it whole, may give it.
  fs.writeFileSync(f, '{"v":5');
  resilience.writeFileAtomic(f, '{"v":6}', { keepBak: true, knownWhole: true });
  assert.equal(text(f + '.bak'), '{"v":5', 'copied without being parsed');
  // Without `keepBak` nothing is kept, known whole or not; with no old file there is nothing to keep.
  resilience.writeFileAtomic(f, '{"v":7}', { knownWhole: true });
  assert.equal(text(f + '.bak'), '{"v":5');
  const g = path.join(dir, 'NEW234.json');
  resilience.writeFileAtomic(g, '{"v":1}', { keepBak: true, knownWhole: true });
  assert.deepEqual([text(g), fs.existsSync(g + '.bak')], ['{"v":1}', false]);
});

test('atomic write: a read with its backup says whether the file itself parsed, and why each was not read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-whole-'));
  const f = path.join(dir, 'ABC234.json');
  assert.deepEqual(resilience.readJsonWhole(f), { data: null, whole: false, codes: ['ENOENT', 'ENOENT'] }, 'neither file');
  fs.writeFileSync(f + '.bak', '{"v":1}');
  assert.deepEqual(resilience.readJsonWhole(f), { data: { v: 1 }, whole: false, codes: ['ENOENT', ''] }, 'only the .bak: not whole');
  fs.writeFileSync(f, '{"v":2');
  assert.deepEqual(resilience.readJsonWhole(f), { data: { v: 1 }, whole: false, codes: ['', ''] }, 'a torn file falls back to its .bak: not whole');
  fs.writeFileSync(f, '{"v":2}');
  assert.deepEqual(resilience.readJsonWhole(f), { data: { v: 2 }, whole: true, codes: [''] }, 'the file parsed: whole');
  assert.deepEqual(resilience.readJsonWithBak(f), { v: 2 });
  fs.rmSync(f + '.bak');
  fs.writeFileSync(f, 'torn');
  assert.deepEqual(resilience.readJsonWhole(f), { data: null, whole: false, codes: ['', 'ENOENT'] });
  assert.equal(resilience.readJsonWithBak(f), null);
  // A file that cannot be read is not a file that is not there: its code says so (a folder in its place, as EBUSY would).
  fs.rmSync(f);
  fs.mkdirSync(f);
  assert.deepEqual(resilience.readJsonWhole(f), { data: null, whole: false, codes: ['EISDIR', 'ENOENT'] });
  assert.deepEqual(resilience.readText(f), { text: null, code: 'EISDIR' });
  assert.deepEqual(resilience.readText(f + '.none'), { text: null, code: 'ENOENT' });
  fs.writeFileSync(f + '.txt', 'é');
  assert.deepEqual(resilience.readText(f + '.txt'), { text: 'é', code: '' });
});

test('publish once: a file is made whole only where none is, never over one; in a folder held, a drive without hard links renames it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-once-'));
  const f = path.join(dir, 'secret.key');
  assert.equal(resilience.publishOnce(f, 'first', { mode: 0o600 }), true, 'made');
  assert.equal(fs.readFileSync(f, 'utf8'), 'first');
  assert.equal(resilience.publishOnce(f, 'second'), false, 'one is there: not written over');
  assert.equal(fs.readFileSync(f, 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(dir), ['secret.key'], 'no temporary file left either way');
  // A drive that cannot hold a hard link (FAT, exFAT): refused with its code, unless the folder is this copy's (held).
  const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); };
  try {
    const g = path.join(dir, 'tls.json');
    assert.throws(() => resilience.publishOnce(g, 'x'), (e) => e.code === 'EPERM');
    assert.ok(!fs.existsSync(g));
    assert.equal(resilience.publishOnce(g, 'held', { held: true }), true, 'held: renamed into place, whole');
    assert.equal(fs.readFileSync(g, 'utf8'), 'held');
  } finally { fs.linkSync = link; }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['secret.key', 'tls.json'], 'no temporary file left');
  // A folder that cannot take it (a file where the folder should be): thrown, and nothing left.
  fs.writeFileSync(path.join(dir, 'file'), '');
  assert.throws(() => resilience.publishOnce(path.join(dir, 'file', 'x'), 'y'), (e) => ['EEXIST', 'ENOTDIR'].includes(e.code));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['file', 'secret.key', 'tls.json']);
});

test('the server secret: read and never written; only a file that is not there is made, once the folder is held, and never over one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-secret-'));
  const file = path.join(dir, 'secret.key');
  const absent = guard.readSecret(dir);
  assert.deepEqual([absent.state, absent.file, absent.secret.length], ['absent', file, 32]);
  assert.deepEqual(fs.readdirSync(dir), [], 'reading writes nothing');
  assert.equal(guard.makeSecret(absent), true);
  const read = guard.readSecret(dir);
  assert.deepEqual([read.state, read.secret.equals(absent.secret)], ['read', true], 'the secret made is the one read next');
  assert.equal(guard.makeSecret({ ...absent, secret: Buffer.alloc(32, 7) }), false, 'one is there: never written over');
  assert.ok(guard.readSecret(dir).secret.equals(absent.secret));
  // Anything else is unusable: this run signs with its own, and the file is left as it is.
  fs.writeFileSync(file, 'not a secret');
  const bad = guard.readSecret(dir);
  assert.deepEqual([bad.state, bad.code, bad.words], ['unusable', 'EBADKEY', file + ' does not hold a server secret']);
  assert.equal(bad.secret.length, 32);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a secret');
  fs.rmSync(file);
  fs.mkdirSync(file);   // a file that cannot be read (as EBUSY or EACCES)
  const unread = guard.readSecret(dir);
  assert.deepEqual([unread.state, unread.code, unread.words], ['unusable', 'EISDIR', file + ' could not be read (EISDIR)']);
  assert.ok(!unread.secret.equals(guard.readSecret(dir).secret), 'a secret of its own for each run');
  assert.ok(fs.statSync(file).isDirectory(), 'left as it is');
});

test('store: a store whose folder is not made yet loads no hall and makes nothing; one that cannot be read says why', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-')), 'rooms');
  const s = new RoomStore(dir, { make: false });
  assert.equal(s.loadAll(null, { compact: false }), 0);
  assert.ok(!fs.existsSync(dir), 'not made by the store');
  fs.writeFileSync(dir, '');   // a file where the folder should be
  assert.throws(() => new RoomStore(dir, { make: false }).loadAll(null, { compact: false }), (e) => e.code === 'ENOTDIR');
  fs.rmSync(dir);
  new RoomStore(dir);   // made by default, as a test or a tool asks
  assert.ok(fs.statSync(dir).isDirectory());
});

test('store: compaction copies the snapshot it wrote to .bak unread; a torn one is read first and never replaces a good .bak; a load from .bak clears snapWhole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const json = path.join(dir, 'ABC234.json');
  const seqOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).seq;
  const say = (store, room, id) => store.commit(room, { o: 'add', m: { id, type: 'text', text: id, at: 1 } });
  /** Run `fn` with the snapshot's rename refused, as a file another program holds refuses it: nothing on disk changes. */
  const failRename = (fn) => {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(to).endsWith('.json')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return rename.call(fs, from, to); };
    try { fn(); } finally { fs.renameSync = rename; }
  };
  const a = new RoomStore(dir);
  const ra = a.create('ABC234', 'Test');
  assert.equal(ra.snapWhole, true, 'a hall made writes its snapshot, and knows it whole');
  say(a, ra, 'm1');
  assert.equal(readsOf(json, () => a.compact('ABC234')), 0, 'a known-whole snapshot is not read again');
  assert.deepEqual([seqOf(json), seqOf(json + '.bak')], [1, 0], 'the one before is the backup');
  say(a, ra, 'm2');
  assert.equal(readsOf(json, () => a.compact('ABC234')), 0);
  assert.deepEqual([seqOf(json), seqOf(json + '.bak')], [2, 1]);
  // A snapshot that fails leaves the file on disk the one the store wrote, so it is still known whole and still not read.
  failRename(() => a.compact('ABC234'));
  assert.ok(a.lastError, 'the failed snapshot is said');
  assert.equal(ra.snapWhole, true, 'a failed snapshot leaves a known-whole file known whole');
  assert.equal(seqOf(json), 2, 'the snapshot on disk is the one before');
  assert.equal(readsOf(json, () => a.compact('ABC234')), 0, 'and the next snapshot copies it unread');
  assert.equal(a.lastError, null, 'the snapshot that lands clears the error');
  assert.deepEqual([seqOf(json), seqOf(json + '.bak')], [2, 2]);

  // A load whose snapshot parsed knows it whole: the boot's compaction copies it unread.
  const b = new RoomStore(dir);
  b.loadAll(null, { compact: false });
  assert.equal(b.get('ABC234').snapWhole, true, 'loaded whole');
  assert.equal(readsOf(json, () => b.compact('ABC234')), 0);
  assert.deepEqual([seqOf(json), seqOf(json + '.bak')], [2, 2]);
  say(b, b.get('ABC234'), 'm3');
  b.compact('ABC234');
  say(b, b.get('ABC234'), 'm4');   // in the log only

  // A torn snapshot: the load falls back to the .bak, and the store no longer knows the file on disk whole.
  fs.writeFileSync(json, '{"code":"ABC2');
  const c = new RoomStore(dir);
  c.loadAll(null, { compact: false });
  const rc = c.get('ABC234');
  assert.equal(rc.snapWhole, false, 'a load from .bak clears snapWhole');
  assert.deepEqual(rc.messages.map((m) => m.id), ['m1', 'm2', 'm4'], 'the .bak, and the log replayed on top');
  // A compaction that fails changes nothing on disk, so it leaves snapWhole as it was.
  failRename(() => c.compact('ABC234'));
  assert.ok(c.lastError, 'the failed snapshot is said');
  assert.equal(rc.snapWhole, false, 'a failed snapshot leaves it as it was');
  assert.equal(seqOf(json + '.bak'), 2, 'the torn snapshot did not replace the good .bak');
  // The next compaction reads the torn file, refuses it as a backup, and knows its own snapshot whole.
  assert.equal(readsOf(json, () => c.compact('ABC234')), 1, 'a torn snapshot is read before it may replace the .bak');
  assert.equal(seqOf(json + '.bak'), 2, 'and never replaces it');
  assert.equal(seqOf(json), 4);
  assert.equal(rc.snapWhole, true, 'the snapshot it wrote');
  assert.equal(readsOf(json, () => c.compact('ABC234')), 0, 'and is trusted from then on');
  assert.deepEqual([seqOf(json), seqOf(json + '.bak')], [4, 4]);

  // A boot that compacts at load reads a torn snapshot twice, once to load and once before it may replace the .bak.
  fs.writeFileSync(json, '{"code":"ABC2');
  const d = new RoomStore(dir);
  assert.equal(readsOf(json, () => d.loadAll()), 2);
  assert.equal(seqOf(json + '.bak'), 4, 'the good .bak kept');
  assert.equal(d.get('ABC234').snapWhole, true);
});

test('the papers say what a power cut can lose: a crash of AGMessage or of a browser nothing, a power cut the last few seconds', () => {
  const ROOT = path.join(__dirname, '..', '..');
  // Line breaks, a source comment's leading asterisks and capitals never split a phrase: a rewrap moves no words.
  const read = (f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return (f.endsWith('.js') ? text.replace(/\n[ \t]*\*(?!\/)/g, ' ') : text).replace(/\s+/g, ' ').toLowerCase();
  };
  for (const f of ['README.md', 'README.txt']) {
    const text = read(f);
    assert.ok(text.includes('a crash of agmessage or of a browser loses nothing; a power cut can lose the last few seconds'), f + ' says what a power cut can lose');
    assert.ok(!/power cut loses nothing/.test(text), f + ' never says a power cut loses nothing');
  }
  const store = read('app/lib/store.js');
  assert.ok(store.includes('an acknowledged message is in the system\'s file cache'), 'lib/store.js says where an acknowledged message is');
  assert.ok(!store.includes('an acknowledged message is on disk'), 'and never that it is on disk');
});

// ---------------------------------------------------------------- the op table
const ops = require('../lib/ops');
/** apply() on a real store, with what it sends, marks and says recorded, and each step in the order it was taken. */
function opsRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-ops-'));
  const store = new RoomStore(dir);
  const room = store.create('ABC234', 'Main hall');
  const sent = [], marked = [], said = [], steps = [];
  const apply = ops.applier({
    commit: (r, op) => { store.commit(r, op); steps.push('commit ' + op.s); },
    send: (r, event, payload) => { sent.push([r.code, event, payload]); steps.push('send ' + event + ' ' + payload.seq); },
    changed: (r) => { marked.push(r.code); steps.push('mark ' + r.seq); },
    refused: (why) => said.push(why),
  });
  const logged = () => fs.readFileSync(path.join(dir, 'ABC234.log'), 'utf8');
  return { dir, store, room, apply, sent, marked, said, steps, logged };
}

test('op table: apply() given a field outside the table says so, commits nothing, sends nothing and answers null, never a throw', () => {
  const t = opsRig();
  const m = t.apply(t.room, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } }).m;
  const before = { seq: t.room.seq, ring: t.room.ring.length, log: t.logged(), steps: t.steps.length, sent: t.sent.length, marked: t.marked.length };
  const refused = [
    { o: 'upd', id: m.id, f: { sentTo: { id: 'x' } } },
    { o: 'upd', id: m.id, f: { pinned: true, sentTo: { id: 'x' } } },   // one field outside refuses the op whole
    { o: 'upd', id: m.id, f: {} },
    { o: 'upd', id: m.id, f: ['pinned'] },
    { o: 'upd', id: m.id },
    { o: 'upd', f: { pinned: true } },
    { o: 'del' },
    { o: 'add' },
    { o: 'add', m: { type: 'text' } },
    { o: 'rename', name: 'x' },
    { m: { id: 'm2' } },
    null,
    'upd',
  ];
  for (const op of refused) assert.equal(t.apply(t.room, op), null, JSON.stringify(op));
  assert.deepEqual({ seq: t.room.seq, ring: t.room.ring.length, log: t.logged(), steps: t.steps.length, sent: t.sent.length, marked: t.marked.length }, before, 'no number taken, nothing committed, on disk, sent or marked');
  assert.equal(t.room.byId.get(m.id).pinned, undefined, 'the field inside the table was not applied either');
  assert.deepEqual(t.said, [
    'a change of sentTo, a field outside the op table',
    'a change of sentTo, a field outside the op table',
    'a change of no field',
    'a change of no field',
    'a change of no field',
    'a change to no message',
    'a change to no message',
    'an added message with no id',
    'an added message with no id',
    'an op of a kind the table does not hold',
    'an op of a kind the table does not hold',
    'an op of a kind the table does not hold',
    'an op of a kind the table does not hold',
  ]);
  // The words name a field, never a value; a key the server never writes is cut and cleaned before it is said.
  assert.equal(ops.refusal({ o: 'upd', id: 'm1', f: { 'a\nb<script>': 1, pinned: 1, ['x'.repeat(60)]: 1, c: 1, d: 1, e: 1, g: 1 } }),
    'a change of a?b?script?, ' + 'x'.repeat(40) + ', c, d, e and 1 more, a field outside the op table');
  // Then the next change is numbered on from the last one committed: no page sees a gap.
  const pinned = t.apply(t.room, { o: 'upd', id: m.id, f: { pinned: true } });
  assert.equal(pinned.s, before.seq + 1);
  assert.deepEqual(t.sent.at(-1), ['ABC234', 'pinUpdate', { messageId: m.id, pinned: true, seq: before.seq + 1 }]);
});

test('op table: each change is committed, then sent under the event the table names, carrying its seq, then marked', () => {
  const t = opsRig();
  const add = t.apply(t.room, { o: 'add', m: { id: 'm1', type: 'action', text: 'Ready?', at: 1 } });
  const sys = t.apply(t.room, { o: 'add', m: { id: 's1', type: 'system', text: 'Ana joined', at: 2 } });
  assert.equal(add.m.seq, 1, 'an added message carries its seq');
  const fields = { responses: [{ uid: 'u1', optionIndex: 0 }], pinned: true, reactions: [{ uid: 'u1', emoji: '👍' }], stage: { ack: 'sent' }, proposal: { id: 'p1', state: 'pending' }, help: { state: 'coming' } };
  // Every field in one op, written in the reverse of the table's order: sent in the table's order, each with the seq.
  const all = t.apply(t.room, { o: 'upd', id: 'm1', f: Object.fromEntries(Object.entries(fields).reverse()) });
  t.apply(t.room, { o: 'meta', name: 'Main hall, day 2' });
  t.apply(t.room, { o: 'meta', settings: { lockRoles: true } });
  t.apply(t.room, { o: 'del', id: 's1' });
  t.apply(t.room, { o: 'reset' });
  assert.deepEqual(t.sent.map(([code, event, payload]) => [code, event, JSON.stringify(payload)]), [
    ['ABC234', 'message', JSON.stringify(add.m)],
    ['ABC234', 'system', JSON.stringify(sys.m)],
    ...Object.entries(ops.UPD_EVENTS).map(([f, e]) => ['ABC234', e, JSON.stringify({ messageId: 'm1', [f]: fields[f], seq: 3 })]),
    ['ABC234', 'roomMeta', JSON.stringify({ name: 'Main hall, day 2', seq: 4 })],
    ['ABC234', 'roomMeta', JSON.stringify({ name: 'Main hall, day 2', seq: 5 })],
    ['ABC234', 'messageDeleted', JSON.stringify({ messageId: 's1', seq: 6 })],
    ['ABC234', 'roomReset', JSON.stringify({ roomCode: 'ABC234', seq: 7 })],
  ]);
  assert.equal(all.s, 3);
  assert.deepEqual(t.marked, Array(7).fill('ABC234'), 'each change marked once');
  // Each change committed (its number taken), then sent under each of its events, then marked, before the next begins.
  assert.deepEqual(t.steps, [
    'commit 1', 'send message 1', 'mark 1',
    'commit 2', 'send system 2', 'mark 2',
    'commit 3', ...Object.values(ops.UPD_EVENTS).map((e) => 'send ' + e + ' 3'), 'mark 3',
    'commit 4', 'send roomMeta 4', 'mark 4',
    'commit 5', 'send roomMeta 5', 'mark 5',
    'commit 6', 'send messageDeleted 6', 'mark 6',
    'commit 7', 'send roomReset 7', 'mark 7',
  ]);
  // Committed before it was sent: on disk, kept for resume, in the hall.
  assert.deepEqual(t.store.opsSince(t.room, 0).map((op) => op.o), ['add', 'add', 'upd', 'meta', 'meta', 'del', 'reset']);
  assert.equal(t.logged().trim().split('\n').length, 7);
  assert.deepEqual(t.room.settings.lockRoles, true);
  // The events the table names are the events apply() sends, every one of them: the wire fence reads them from EVENTS.
  assert.deepEqual([...new Set(t.sent.map((x) => x[1]))].sort(), [...ops.EVENTS].sort());
  assert.deepEqual(Object.keys(ops.UPD_EVENTS), ['responses', 'pinned', 'reactions', 'stage', 'proposal', 'help']);
  assert.ok(Object.isFrozen(ops.UPD_EVENTS) && Object.isFrozen(ops.EVENTS) && Object.isFrozen(ops.KINDS));
  assert.deepEqual(ops.eventsOf({ o: 'nothing', s: 1 }, t.room), [], 'a kind the table does not hold sends nothing');
});

// ---------------------------------------------------------------- the one gate, and the handler modules' contexts
const gate = require('../lib/gate');
/**
 * A socket's facts for the gate, each read recorded in order, and a real bucket with no refill (rate 0), so every token
 * taken stays taken and is counted.
 */
function gateRig({ joined = true, here = true, admin = false, rights = ['hall.post', 'hall.files'], onStage = false, burst = 3 } = {}) {
  const read = [];
  const bucket = new guard.Bucket(0, burst);
  const pass = gate.gateOf({
    joined: () => { read.push('joined'); return joined; },
    here: () => { read.push('here'); return here; },
    isAdmin: () => { read.push('admin'); return admin; },
    allowed: (right) => { read.push('may ' + right); return rights.includes(right); },
    onStage: () => { read.push('onStage'); return onStage; },
  });
  /** One request: whether it passed, the one answer it was given (none when it passed), and what it read. */
  const ask = (opts) => {
    read.length = 0;
    const answers = [];
    const passed = pass((r) => answers.push(r), opts);
    return { passed, answers, read: [...read] };
  };
  return { bucket, ask, tokens: () => bucket.level() };
}

test('the gate: joined, its room still here, its bucket, the admin, its rights, in that order, each refused in today\'s words', () => {
  const every = (t) => ({ joined: true, bucket: t.bucket, admin: true, may: ['hall.post', 'hall.files'] });
  const refused = (error, read, extra = {}) => ({ passed: false, answers: [{ ok: false, error, ...extra }], read });
  // Each step refused in turn: its words, and what of the socket it read to say them. A step after it is never read.
  let t = gateRig({ joined: false, admin: true });
  assert.deepStrictEqual(t.ask(every(t)), refused('Not joined', ['joined']));
  assert.equal(t.tokens(), 3, 'refused before its bucket: no token taken');
  t = gateRig({ here: false, admin: true });
  assert.deepStrictEqual(t.ask(every(t)), refused('Room gone', ['joined', 'here']));
  assert.equal(t.tokens(), 3);
  t = gateRig({ admin: true, burst: 0 });
  assert.deepStrictEqual(t.ask(every(t)), refused('Slow down a little.', ['joined', 'here'], { busy: true }), 'nothing past the bucket is read: neither the admin nor a right');
  t = gateRig({ admin: false });
  assert.deepStrictEqual(t.ask(every(t)), refused('Not admin', ['joined', 'here', 'admin']));
  assert.equal(t.tokens(), 2, 'refused after its bucket: its token is spent');
  t = gateRig({ admin: true, rights: [] });
  assert.deepStrictEqual(t.ask(every(t)), refused('Observers can read but not post.', ['joined', 'here', 'admin', 'may hall.post']), 'its rights read in turn, the first refused');
  t = gateRig({ admin: true, rights: ['hall.post'] });
  assert.deepStrictEqual(t.ask(every(t)), refused('Your account may not share files here.', ['joined', 'here', 'admin', 'may hall.post', 'may hall.files', 'onStage']));
  assert.equal(t.tokens(), 2);
  t = gateRig({ admin: true, rights: ['hall.post'], onStage: true });
  assert.deepStrictEqual(t.ask(every(t)).answers, [{ ok: false, error: 'On stage seats send messages, not files.' }], 'a seat On stage is refused a file in its own words');
  t = gateRig({ admin: true });
  assert.deepStrictEqual(t.ask(every(t)), { passed: true, answers: [], read: ['joined', 'here', 'admin', 'may hall.post', 'may hall.files'] }, 'passed: answered nothing, every step read once');
  assert.equal(t.tokens(), 2);
  // A step left out is not read: from no room, with no bucket, not the admin's, no right.
  t = gateRig({ joined: false, here: false });
  assert.deepStrictEqual(t.ask({ joined: false, bucket: null }), { passed: true, answers: [], read: [] });
  assert.deepStrictEqual(t.ask({ joined: false, bucket: null, may: 'hall.post' }), { passed: true, answers: [], read: ['may hall.post'] });
  assert.equal(t.tokens(), 3, 'bucket: null takes no token');
  // Today's words, the ones server.js's own need, limited and admin said, and the rights' words.
  assert.deepStrictEqual({ ...gate.WORDS }, { joined: 'Not joined', gone: 'Room gone', slow: 'Slow down a little.', admin: 'Not admin' });
  assert.deepStrictEqual(Object.keys(gate.RIGHTS), ['hall.post', 'hall.files']);
  assert.ok(Object.isFrozen(gate.WORDS) && Object.isFrozen(gate.RIGHTS) && Object.isFrozen(gate.RIGHTS['hall.files']) && Object.isFrozen(gate.OPTIONS));
});

test('the gate: a request refused after its bucket has spent its token, so nothing a client names is looked up for free', () => {
  const t = gateRig({ admin: false, rights: [], burst: 2 });
  const lookup = { joined: false, bucket: t.bucket, may: 'hall.post' };
  // Two refused at their right (a stale reference, another hall's code: the lookup a right stands for) spend both tokens…
  assert.deepStrictEqual(t.ask(lookup).answers, [{ ok: false, error: 'Observers can read but not post.' }]);
  assert.deepStrictEqual(t.ask({ joined: false, bucket: t.bucket, admin: true }).answers, [{ ok: false, error: 'Not admin' }]);
  assert.equal(t.tokens(), 0);
  // …and the third is refused at the bucket, before its right is read.
  assert.deepStrictEqual(t.ask(lookup), { passed: false, answers: [{ ok: false, error: 'Slow down a little.', busy: true }], read: [] });
  // An answer that is not a function is not called; the request is refused all the same.
  const g = gate.gateOf({ joined: () => false, here: () => true, isAdmin: () => true, allowed: () => true, onStage: () => false });
  for (const ack of [undefined, null, 'ack', {}]) assert.equal(g(ack, { bucket: null }), false);
  assert.deepStrictEqual(gate.refusal({ bucket: null }, { joined: () => true, here: () => true }), null, 'a refusal of nothing is null');
});

test('the gate: options it does not take, a bucket not named and a right it has no words for are refused whole, before anything is read', () => {
  const t = gateRig({ admin: true });
  const throws = (opts, words) => {
    assert.throws(() => t.ask(opts), (e) => e instanceof TypeError && words.test(e.message), JSON.stringify(opts));
    assert.equal(t.tokens(), 3, 'no token taken');
  };
  for (const opts of [undefined, null, [], 'joined', 7]) throws(opts, /its options as an object/);
  throws({}, /names its bucket, or says bucket: null/);
  throws({ joined: true }, /names its bucket/);
  throws({ bucket: t.bucket, addmin: true }, /takes no option addmin: it takes joined, bucket, admin, may/);
  throws({ bucket: undefined }, /bucket is one it can take a token from, or null/);
  throws({ bucket: {} }, /one it can take a token from/);
  throws({ bucket: 'writes' }, /one it can take a token from/);
  throws({ bucket: t.bucket, joined: 'yes' }, /joined and admin are true or false/);
  throws({ bucket: t.bucket, admin: 1 }, /true or false/);
  throws({ bucket: t.bucket, may: 'hall.view' }, /no words for the right hall\.view: it reads hall\.post, hall\.files/);
  throws({ bucket: t.bucket, may: ['hall.post', 7] }, /no words for the right given as a number/);
  throws({ bucket: t.bucket, may: { 'hall.post': true } }, /a right, or a list of rights/);
  // A throw reaches no answer: the socket's guard (server.js guardHandlers) answers the request as refused.
  assert.deepStrictEqual(t.ask({ bucket: t.bucket }).read, ['joined', 'here'], 'and a gate written whole still reads');
});

test('the contexts: ctx holds every part and io, takesCtx the same parts but those that make a room\'s op or send to a room, and sendTo, both frozen; sendTo given a hall\'s key reaches nobody', () => {
  // Three pages' sockets, two of them in hall ABC234, as Socket.IO keeps them: the open ones by id (io.sockets.sockets),
  // and each hall a room of its sockets' ids (every socket is in a room of its own id too).
  const got = [];
  const sockets = new Map(['sA', 'sB', 'sC'].map((id) => [id, { id, emit: (event, payload) => got.push([id, event, payload]) }]));
  const halls = new Map([['ABC234', ['sA', 'sB']]]);
  const io = {
    sockets: { sockets },
    to: (ids) => ({ emit: (event, payload) => { for (const id of ids) for (const s of halls.get(id) || [id]) if (sockets.has(s)) sockets.get(s).emit(event, payload); } }),
  };
  const store = { kind: 'store' }, settings = { roomSends: [] };
  const linkFor = () => null, apply = () => null, systemMessage = () => null;
  const { ctx, takesCtx } = gate.contexts({ store, apply, systemMessage, settings, linkFor, io });
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(takesCtx));
  assert.deepStrictEqual(Object.keys(ctx), ['store', 'apply', 'systemMessage', 'settings', 'linkFor', 'io']);
  assert.deepStrictEqual(Object.keys(takesCtx), ['store', 'settings', 'linkFor', 'sendTo'], 'no io, apply or systemMessage: a take makes no room\'s op and sends to no room');
  assert.deepStrictEqual([...gate.ROOM_SENDS], ['io', 'apply', 'systemMessage']);
  assert.ok(Object.isFrozen(gate.ROOM_SENDS));
  assert.ok(ctx.store === store && takesCtx.store === store && takesCtx.settings === settings && ctx.io === io && ctx.apply === apply, 'the parts themselves, not copies');
  assert.throws(() => { ctx.io = null; }, TypeError, 'a handler module cannot replace a part');
  assert.ok(!Object.isFrozen(settings), 'settings is not frozen by its context: the fence (j) holds the modules to reading it');
  // What the takes context leaves out: a hall's key given to a broadcast as an id reaches the whole hall.
  io.to(['ABC234']).emit('page:push', { n: 1 });
  assert.deepStrictEqual(got.map((x) => x[0]), ['sA', 'sB']);
  got.length = 0;
  // sendTo: the same key reaches nobody; a socket's id reaches that socket, once however often it is named.
  assert.equal(takesCtx.sendTo(['ABC234'], 'page:push', { n: 2 }), 0);
  assert.deepStrictEqual(got, []);
  assert.equal(takesCtx.sendTo(['sB', 'sB', 'gone', 'ABC234', 7, null], 'clock', { show: 'off' }), 1);
  assert.deepStrictEqual(got, [['sB', 'clock', { show: 'off' }]]);
  assert.equal(takesCtx.sendTo(['sA', 'sC'], 'clock', { show: 'time' }), 2);
  assert.deepStrictEqual(got.slice(1).map((x) => x[0]), ['sA', 'sC']);
  got.length = 0;
  // The sockets open now, read as each take is sent: a socket gone since is reached no more.
  sockets.delete('sC');
  assert.equal(takesCtx.sendTo(['sA', 'sC'], 'clock', {}), 1);
  got.length = 0;
  // Only a list names sockets: a string is never read a character at a time, and nothing else is read as one.
  for (const ids of ['sA', 'ABC234', new Set(['sA']), undefined, null, { 0: 'sA', length: 1 }]) assert.equal(takesCtx.sendTo(ids, 'clock', {}), 0);
  assert.deepStrictEqual(got, []);
  // A context the server does not hold whole does not start: a part not built yet, no io, an io whose open sockets
  // cannot be read by id, a part in sendTo's place.
  assert.throws(() => gate.contexts({ store, apply: undefined, io }), /name apply, which the server has not built: they are built last/);
  assert.throws(() => gate.contexts({ store }), /holds io, for the rooms module/);
  for (const bad of [null, {}, { sockets: {} }, { sockets: { sockets: [] } }]) assert.throws(() => gate.contexts({ store, io: bad }), /each socket open by its id: io\.sockets\.sockets/);
  assert.throws(() => gate.contexts({ store, io, sendTo: () => 0 }), /sendTo is the takes context's own/);
  assert.throws(() => gate.contexts(null), /the server's parts, named/);
});

test('the contexts on a real Socket.IO server, as server.js builds them: a hall\'s key given to sendTo reaches no page, a page\'s socket id reaches that page', async () => {
  const http = require('http');
  const { Server } = require('socket.io');
  const { connect, until } = require('./helpers');
  const front = http.createServer();
  const io = new Server(front);
  // Each page joins hall ABC234's room, as the server's join does.
  io.on('connection', (socket) => { socket.join('ABC234'); });
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const pages = [];
  try {
    for (let i = 0; i < 2; i++) pages.push(await connect('http://127.0.0.1:' + front.address().port));
    const [a, b] = pages;
    await until(() => io.sockets.sockets.has(a.id) && io.sockets.sockets.has(b.id), 3000, 'both pages open');
    const heard = new Map(pages.map((p) => [p, []]));
    for (const p of pages) p.on('page:take', (v) => heard.get(p).push(v));
    // server.js hands contexts() its parts and nothing else: the sockets sendTo reaches are io's open ones.
    const { takesCtx } = gate.contexts({ settings: {}, io });
    // The hall's key reaches no page. Each page is then reached by its socket's id, and nothing came before it: one
    // socket's events arrive in the order they were sent.
    assert.equal(takesCtx.sendTo(['ABC234'], 'page:take', { seq: 1 }), 0);
    assert.equal(takesCtx.sendTo([b.id], 'page:take', { seq: 2 }), 1);
    assert.equal(takesCtx.sendTo([a.id, a.id], 'page:take', { seq: 3 }), 1);
    await until(() => heard.get(a).length && heard.get(b).length, 3000, 'each page\'s take');
    assert.deepStrictEqual(heard.get(b), [{ seq: 2 }], 'the page named by its id, and nothing the hall\'s key sent');
    assert.deepStrictEqual(heard.get(a), [{ seq: 3 }], 'once, however often it is named');
    // Where a room broadcast, which the takes context leaves out, reaches the whole hall by the same key.
    io.to('ABC234').emit('page:take', { seq: 4 });
    await until(() => heard.get(a).length === 2 && heard.get(b).length === 2, 3000, 'the broadcast at both pages');
    // A page gone is reached no more.
    const gone = a.id;
    a.close();
    await until(() => !io.sockets.sockets.has(gone), 3000, 'the closed page gone from the open sockets');
    assert.equal(takesCtx.sendTo([gone, b.id], 'page:take', { seq: 5 }), 1);
  } finally {
    for (const p of pages) p.close();
    await new Promise((resolve) => io.close(resolve));
  }
});

// ---------------------------------------------------------------- latest wins: one primitive for every state frame
const { Latest } = require('../lib/latest');
/** Timers on a clock that moves only when told: `tick(ms)` fires each timer due by then, in order, each at its own time. */
function manualTimers() {
  let now = 0, next = 1;
  const due = new Map();
  const made = [];
  const schedule = {
    setTimeout: (fn, ms) => {
      const h = { id: next++, at: now + ms, ms, fn, unrefd: false, unref() { this.unrefd = true; return this; } };
      due.set(h.id, h); made.push(h);
      return h;
    },
    clearTimeout: (h) => { if (h) due.delete(h.id); },
  };
  const tick = (ms = 0) => {
    const end = now + ms;
    for (;;) {
      let first = null;
      for (const h of due.values()) if (h.at <= end && (!first || h.at < first.at || (h.at === first.at && h.id < first.id))) first = h;
      if (!first) break;
      due.delete(first.id);
      now = first.at;
      first.fn();
    }
    now = end;
  };
  return { schedule, tick, now: () => now, waiting: () => due.size, made };
}
/** A Latest of 100 ms on manual timers, each flush recorded as [when, [[key, value]…]]. */
function latestRig(opts = {}) {
  const t = manualTimers();
  const flushed = [];
  const l = new Latest({ name: 'test', delayMs: 100, flush: (batch) => flushed.push([t.now(), [...batch]]), schedule: t.schedule, ...opts });
  return { ...t, l, flushed };
}

test('latest: a lone change is flushed on the next turn, never inside the mark, and a quiet window leaves no timer', () => {
  const r = latestRig();
  r.l.mark('A', 1);
  assert.deepEqual(r.flushed, [], 'not inside the mark');
  assert.deepEqual(r.made.map((h) => h.ms), [0], 'a zero-delay timer: the next turn');
  r.tick(0);
  assert.deepEqual(r.flushed, [[0, [['A', 1]]]]);
  assert.deepEqual(r.l.stats(), { marks: 1, flushes: 1 });
  r.tick(100);
  assert.equal(r.waiting(), 0, 'the window the flush opened ended with nothing marked in it: nothing waits');
  assert.deepEqual(r.made.map((h) => h.ms), [0, 100]);
  r.tick(500);
  r.l.mark('B', 2);
  r.tick(0);
  assert.deepEqual(r.flushed, [[0, [['A', 1]]], [600, [['B', 2]]]], 'after a quiet window, at once again');
  assert.deepEqual(r.l.stats(), { marks: 2, flushes: 2 });
});

test('latest: the marks inside a window fold into one flush at its end, each key once with its newest value', () => {
  const r = latestRig();
  r.l.mark('A', 1);
  r.tick(0);   // the lone change, at once: its flush opens the window
  r.tick(10); r.l.mark('A', 2);
  r.tick(30); r.l.mark('B', 1);
  r.tick(49); r.l.mark('A', 3);
  r.tick(10);
  assert.equal(r.flushed.length, 1, 'nothing more before the window ends (99 ms)');
  r.tick(1);
  assert.deepEqual(r.flushed, [[0, [['A', 1]]], [100, [['A', 3], ['B', 1]]]]);
  assert.deepEqual(r.l.stats(), { marks: 4, flushes: 2 });
  r.tick(100);
  assert.equal(r.waiting(), 0);
});

test('latest: merge folds what waits for a key with what is marked next, and is asked only when something waits', () => {
  const asked = [];
  const r = latestRig({ merge: (a, b) => { asked.push([a.seq, b.seq]); return { seq: Math.max(a.seq, b.seq), priority: a.priority || b.priority }; } });
  r.l.mark('R1', { seq: 5, priority: true });
  r.tick(0);
  r.tick(20);
  r.l.mark('R1', { seq: 6, priority: true });
  r.l.mark('R1', { seq: 8, priority: false });
  r.l.mark('R1', { seq: 7, priority: false });
  r.l.mark('R2', { seq: 1, priority: false });
  r.tick(80);
  assert.deepEqual(r.flushed, [
    [0, [['R1', { seq: 5, priority: true }]]],
    [100, [['R1', { seq: 8, priority: true }], ['R2', { seq: 1, priority: false }]]],
  ], 'the priority marked first in the window is not folded away by the newer marks without it');
  assert.deepEqual(asked, [[6, 8], [8, 7]]);
});

test('latest: flushNow flushes what waits at once and starts the window again from it', () => {
  const r = latestRig();
  assert.equal(r.l.flushNow(), 0, 'nothing waiting: nothing flushed');
  assert.deepEqual([r.flushed, r.made.length, r.l.stats()], [[], 0, { marks: 0, flushes: 0 }]);
  r.l.mark('A', 1);
  assert.equal(r.l.flushNow(), 1);
  assert.deepEqual(r.flushed, [[0, [['A', 1]]]], 'inside the call');
  r.tick(0);
  assert.equal(r.flushed.length, 1, 'the next turn\'s flush was taken back');
  r.tick(20); r.l.mark('B', 1); r.tick(79);
  assert.equal(r.flushed.length, 1, 'the window runs from the flush');
  r.tick(1);
  assert.deepEqual(r.flushed.at(-1), [100, [['B', 1]]]);
  r.tick(30); r.l.mark('C', 1);
  assert.equal(r.l.flushNow(), 1);
  r.tick(20); r.l.mark('D', 1); r.tick(79);
  assert.deepEqual(r.flushed.slice(2), [[130, [['C', 1]]]], 'the window that flush opened, not the one before it, holds D');
  r.tick(1);
  assert.deepEqual(r.flushed.slice(2), [[130, [['C', 1]]], [230, [['D', 1]]]]);
  assert.deepEqual(r.l.stats(), { marks: 4, flushes: 4 });
});

test('latest: over a long run of bursts and lulls nothing is dropped, nothing is stale, and flushes are a window apart', () => {
  const r = latestRig();
  let x = 20261101;
  const draw = (n) => { x = (x * 48271) % 2147483647; return x % n; };   // a fixed sequence: the run is the same every time
  const log = [];   // every mark and flush, in the order they happened
  const l = new Latest({ name: 'run', delayMs: 100, flush: (batch) => log.push(['flush', r.now(), [...batch]]), schedule: r.schedule });
  for (let i = 0; i < 2000; i++) {
    r.tick(draw(12) === 0 ? 150 + draw(200) : draw(40));
    const key = 'k' + draw(8);
    l.mark(key, i);
    log.push(['mark', r.now(), key, i]);
  }
  r.tick(1000);
  const waiting = new Map();   // key → [first marked at, newest value]
  const flushes = [];
  for (const e of log) {
    if (e[0] === 'mark') { const w = waiting.get(e[2]); waiting.set(e[2], [w ? w[0] : e[1], e[3]]); continue; }
    const [, at, batch] = e;
    assert.deepEqual(batch.map(([k]) => k).sort(), [...waiting.keys()].sort(), 'a flush holds every key marked since the last, and only those');
    for (const [k, v] of batch) {
      assert.equal(v, waiting.get(k)[1], 'with its newest value');
      assert.ok(at - waiting.get(k)[0] <= 100, 'flushed within one window of its first mark (' + (at - waiting.get(k)[0]) + ' ms)');
    }
    waiting.clear();
    flushes.push(at);
  }
  assert.equal(waiting.size, 0, 'nothing left unflushed');
  for (let i = 1; i < flushes.length; i++) assert.ok(flushes[i] - flushes[i - 1] >= 100, 'flushes a window apart: ' + flushes[i - 1] + ' then ' + flushes[i]);
  assert.ok(flushes.length < 2000 / 2, flushes.length + ' flushes for 2000 marks');
  assert.deepEqual(l.stats(), { marks: 2000, flushes: flushes.length });
  assert.ok(r.made.length > 0 && r.made.every((h) => h.unrefd), 'every timer it made was unref()\'d');
  assert.equal(r.waiting(), 0);
});

test('latest: a mark made while flushing goes in the next window; a flush that throws leaves the run as it was', () => {
  const t = manualTimers();
  const flushed = [];
  let n = 0;
  const l = new Latest({
    name: 'odd', delayMs: 100, schedule: t.schedule,
    flush: (batch) => {
      n++;
      flushed.push([t.now(), [...batch]]);
      if (n === 1) l.mark('again', 'from inside');
      if (n === 2) throw new Error('a flush fault');
    },
  });
  l.mark('A', 1);
  t.tick(0);
  assert.deepEqual(flushed, [[0, [['A', 1]]]]);
  assert.throws(() => t.tick(100), /a flush fault/, 'the fault is the flush\'s own, not swallowed');
  assert.deepEqual(flushed, [[0, [['A', 1]]], [100, [['again', 'from inside']]]], 'marked inside the first flush, flushed at the end of the window it opened');
  assert.deepEqual(l.stats(), { marks: 2, flushes: 2 });
  t.tick(30); l.mark('B', 1);
  t.tick(69);
  assert.equal(flushed.length, 2, 'the window the faulted flush opened still runs');
  t.tick(1);
  assert.deepEqual(flushed.at(-1), [200, [['B', 1]]]);
});

test('latest: its timers never keep the process alive; the runtime\'s timers by default', async () => {
  const handles = [];
  const real = { setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); handles.push(h); return h; }, clearTimeout };
  const seen = [];
  // A window far longer than the wait: what arrives in it is the lone change's own flush, on the next turn.
  const l = new Latest({ name: 'real', delayMs: 60_000, flush: (b) => seen.push([...b.keys()]), schedule: real });
  l.mark('A');
  assert.ok(handles.length === 1 && handles[0].hasRef() === false, 'unref()\'d');
  await new Promise((res) => { setTimeout(res, 50); });
  assert.deepEqual(seen, [['A']]);
  assert.ok(handles.length === 2 && handles[1].hasRef() === false, 'the window it opened too');
  const byDefault = [];
  const d = new Latest({ name: 'default', delayMs: 60_000, flush: (b) => byDefault.push([...b.keys()]) });
  d.mark('B');
  assert.deepEqual(byDefault, []);
  await new Promise((res) => { setTimeout(res, 50); });
  assert.deepEqual(byDefault, [['B']]);
});

test('latest: refuses what it cannot run, by name', () => {
  const flush = () => {};
  assert.throws(() => new Latest({ delayMs: 100, flush }), /A Latest needs a name/);
  for (const delayMs of [0, -1, 1.5, NaN, '100', undefined]) assert.throws(() => new Latest({ name: 'x', delayMs, flush }), /Latest x: delayMs/, String(delayMs));
  assert.throws(() => new Latest({ name: 'x', delayMs: 100 }), /Latest x: flush is a function/);
  assert.throws(() => new Latest({ name: 'x', delayMs: 100, flush, merge: 'newest' }), /Latest x: merge is a function/);
  for (const schedule of [null, {}, { setTimeout }]) assert.throws(() => new Latest({ name: 'x', delayMs: 100, flush, schedule }), /Latest x: schedule/);
  assert.throws(() => new Latest(), /A Latest needs a name/);
  assert.equal(new Latest({ name: 'x', delayMs: 1, flush }).name, 'x');
});

test('latest: sendEach sends every subject of a flush, and one that faults is handed over and holds back no other', () => {
  const { sendEach } = require('../lib/latest');
  const sent = [];
  const faults = [];
  const batch = new Map([['H1', 1], ['H2', 2], ['H3', 3]]);
  const n = sendEach(batch, ([code, v]) => { if (code === 'H2') throw new Error('a frame fault'); sent.push([code, v]); }, (e, subject) => faults.push([e.message, subject]));
  assert.equal(n, 2, 'the number sent');
  assert.deepEqual(sent, [['H1', 1], ['H3', 3]], 'the subjects either side of the fault, in order');
  assert.deepEqual(faults, [['a frame fault', ['H2', 2]]], 'the fault, with its subject, once');
  assert.equal(sendEach(new Set(), () => assert.fail('nothing to send'), () => assert.fail('nothing to fault')), 0);
  // A frame whose subjects all fault sends none and lets each one go to the fault.
  const all = [];
  assert.equal(sendEach(['a', 'b'], () => { throw new Error('x'); }, (e, s) => all.push(s)), 0);
  assert.deepEqual(all, ['a', 'b']);
  // A Latest whose flush sends through it: one hall's fault, the other hall still flushed, and the run carries on.
  const r = latestRig({ flush: (b) => sendEach(b, ([k]) => { if (k === 'bad') throw new Error('no'); r.flushed.push([r.now(), k]); }, (e, [k]) => r.flushed.push([r.now(), 'refused ' + k])) });
  r.l.mark('bad'); r.l.mark('good');
  r.tick(0);
  assert.deepEqual(r.flushed, [[0, 'refused bad'], [0, 'good']]);
  r.tick(50); r.l.mark('good'); r.tick(50);
  assert.deepEqual(r.flushed.at(-1), [100, 'good'], 'the window after a refused frame runs as any other');
  assert.deepEqual(r.l.stats(), { marks: 3, flushes: 2 });
});

// ---------------------------------------------------------------- health's readings and a show day's peaks
const readings = require('../lib/peaks');
const { auditLog } = require('./helpers');

test('health: the loop\'s delay is its p99 less the sampler\'s own resolution, never below 0', () => {
  const asked = [];
  const hist = (ns) => ({ percentile: (q) => { asked.push(q); return ns; } });
  // An idle Node at resolution 10 reads a p99 of about 10.36 ms: its own timer, not a delay.
  assert.equal(Math.round(readings.loopDelayMs(hist(10.36e6), 10) * 100) / 100, 0.36);
  assert.equal(readings.loopDelayMs(hist(62e6), 10), 52, 'a stalled loop reads its stall');
  assert.equal(readings.loopDelayMs(hist(4e6), 10), 0, 'never below 0');
  assert.equal(readings.loopDelayMs(hist(0), 10), 0, 'an empty window (no sample yet) reads 0');
  assert.equal(readings.loopDelayMs(hist(Number.NaN), 10), 0, 'nonsense reads 0, never NaN');
  assert.deepEqual(asked, [99, 99, 99, 99, 99], 'the p99, every time');
});

test('health: the most sockets from one address (one network through the tunnel), per lane, and those through the tunnel are counts, never addresses', () => {
  const at = (ip) => ({ ip, key: guard.limitKey(ip), lane: guard.laneOf(ip) });
  const datas = [
    at('192.168.1.20'), at('192.168.1.20'), at('192.168.1.21'),
    at('cf:203.0.113.7'), at('cf:203.0.113.7'), at('cf:198.51.100.4'),
    // One phone's /64, three addresses: one network.
    at('cf:2001:db8:1:2::a'), at('cf:2001:db8:1:2::b'), at('cf:2001:db8:1:2::c'), at('cf:2001:db8:1:3::a'),
    null, {}, { ip: '', key: '' },
  ];
  assert.deepEqual(readings.countSockets(datas), { maxPerAddress: { venue: 2, tunnel: 3 }, tunnel: 7 });
  assert.deepEqual(readings.countSockets([]), { maxPerAddress: { venue: 0, tunnel: 0 }, tunnel: 0 });
  const ring = new (require('../lib/resilience').Ring)(4, 3);
  for (const v of [0.0019, 0.012, 0.5004]) ring.push(v);
  assert.deepEqual(ring.stats(), { count: 3, p50: 0.012, p95: 0.5, max: 0.5 }, 'a fraction (ELU) keeps 3 decimals');
});

test('peaks: per show day (06:00 to 06:00 by the laptop\'s clock), raised and never lowered, the newest 14 days kept', () => {
  const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime();   // 2026-10-<d>, the laptop's own time
  const p = new readings.Peaks();
  assert.equal(p.dirty, false, 'nothing to save yet');
  assert.equal(p.note({ loopMs: 3.14, elu: 0.1234, socketsPerAddress: { venue: 4, tunnel: 2 }, tunnelSockets: 1, hallMessages: 1200, hallKb: 340.26, joinBurst: 12 }, at(31, 9)), true);
  assert.equal(p.dirty, true, 'a rise asks for a save at the window\'s end');
  p.dirty = false;
  assert.equal(p.note({ loopMs: 1, elu: 0.05, socketsPerAddress: { venue: 2, tunnel: 1 }, tunnelSockets: 0, hallMessages: 1100, hallKb: 300, joinBurst: 3 }, at(31, 10)), false, 'nothing rose: the record stands');
  assert.equal(p.dirty, false, 'and asks for no save');
  assert.equal(p.note({ loopMs: 7.04, hallMessages: 1250 }, at(31, 11)), true);
  assert.equal(p.note({ socketsPerAddress: { tunnel: 3 } }, at(31, 11)), true, 'one lane rises without the other');
  assert.deepEqual(p.refusedOn(at(31, 11)), { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, 'none refused yet');
  p.dirty = false;
  for (const why of ['full', 'full', 'share', 'idle']) assert.equal(p.tunnelRefused(why, at(31, 11)), true, 'each refusal through the tunnel is added to its kind');
  assert.equal(p.dirty, true);
  assert.equal(p.tunnelRefused('toString', at(31, 11)), false, 'a kind it does not count changes nothing');
  assert.equal(p.tunnelRefused(1, at(31, 11)), false);
  const today = p.view()[0];
  assert.deepEqual({ ...today, auditPutMs: undefined }, {
    day: '2026-10-31', loopMs: 7, elu: 0.123, socketsPerAddress: { venue: 4, tunnel: 3 }, tunnelSockets: 1, tunnelRefused: { rate: 0, share: 1, full: 2, idle: 1, wrongCode: 0 }, hallMessages: 1250, hallKb: 340.3, joinBurst: 12,
    compactMs: { max: 0, messages: 0 }, auditPutMs: undefined, at: at(31, 11), sleeps: 0, sleptMs: 0,
  });
  assert.deepEqual(p.refusedOn(at(31, 23)), today.tunnelRefused, 'the show day\'s refusals, read');
  assert.deepEqual(p.refusedOn(at(30, 12)), { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, 'a day with no record: none, and none made');
  assert.equal(p.view().length, 1);
  today.socketsPerAddress.venue = 99;
  today.tunnelRefused.full = 99;
  assert.deepEqual([p.view()[0].socketsPerAddress.venue, p.view()[0].tunnelRefused.full, p.refusedOn(at(31, 11)).full], [4, 2, 2], 'the view and the reading are copies');
  assert.deepEqual(today.auditPutMs, { count: 0, p99: null, max: null });
  // An evening that runs past midnight is its show day's; 06:00 starts the next, and a reading never touches another day's.
  p.note({ joinBurst: 50 }, new Date(2026, 10, 1, 0, 0, 1).getTime());
  p.note({ joinBurst: 60 }, new Date(2026, 10, 1, 5, 59, 59).getTime());
  p.note({ joinBurst: 7 }, new Date(2026, 10, 1, 6, 0, 0).getTime());
  assert.deepEqual(p.view().map((d) => [d.day, d.joinBurst]), [['2026-10-31', 60], ['2026-11-01', 7]]);
  assert.deepEqual([new Date(2026, 11, 1, 3), new Date(2027, 0, 1, 1), new Date(2027, 0, 1, 6)].map((d) => readings.dayOf(d.getTime())),
    ['2026-11-30', '2026-12-31', '2027-01-01'], 'named by the date the show day starts on, across a month and a year');
  // A show day ends at the next 06:00: an evening past midnight ends with it, and 06:00 itself starts the next one.
  assert.deepEqual([new Date(2026, 11, 31, 23, 30), new Date(2027, 0, 1, 5, 59, 59), new Date(2027, 0, 1, 6), new Date(2026, 10, 30, 12)].map((d) => readings.dayEnds(d.getTime())),
    [new Date(2027, 0, 1, 6), new Date(2027, 0, 1, 6), new Date(2027, 0, 2, 6), new Date(2026, 11, 1, 6)].map((d) => d.getTime()));
  // Fifteen more days: only the newest 14 stay, oldest first.
  for (let d = 2; d <= 16; d++) p.note({ hallMessages: d }, new Date(2026, 10, d, 12).getTime());
  const days = p.view().map((d) => d.day);
  assert.equal(days.length, 14);
  assert.deepEqual([days[0], days[13]], ['2026-11-03', '2026-11-16']);
  // A laptop clock set back a day writes into that day's record, and still keeps 14.
  p.note({ hallMessages: 999 }, new Date(2026, 10, 10, 12).getTime());
  assert.equal(p.view().find((d) => d.day === '2026-11-10').hallMessages, 999);
  assert.equal(p.view().length, 14);
  assert.equal(new readings.Peaks({ keepDays: 2 }).note({ loopMs: 1 }, at(1)), true);
});

test('peaks: an audit append counts toward the day\'s p99 and max; a snapshot keeps the day\'s longest with its hall\'s size', () => {
  const at = new Date(2026, 9, 31, 20).getTime();
  const p = new readings.Peaks();
  for (let i = 0; i < 985; i++) p.auditPut(0.3, at);
  for (let i = 0; i < 14; i++) p.auditPut(1.7, at);
  p.auditPut(84, at);
  assert.deepEqual(p.view()[0].auditPutMs, { count: 1000, p99: 2, max: 84 }, 'the 990th of 1,000 is at most 2 ms (its bucket), the max exact');
  for (let i = 0; i < 600; i++) p.auditPut(0.3, at);
  assert.equal(p.view()[0].auditPutMs.p99, 0.5, '1,585 of 1,600 under 0.5 ms: the p99 is read from the whole day');
  p.auditPut(140, at);
  assert.equal(p.view()[0].auditPutMs.max, 140);
  const h = new readings.Hist();
  h.add(0.3); h.add(-1); h.add(Number.NaN); h.add('5');
  assert.deepEqual(h.view(), { count: 1, p99: 0.3, max: 0.3 }, 'never above the max; nonsense is not counted');
  h.add(5000);
  assert.equal(h.quantile(1), 5000, 'past the last bound, the max');
  assert.ok(readings.BOUNDS.includes(2) && readings.BOUNDS.includes(100), 'reading 3\'s two marks are bounds');

  assert.equal(p.compacted(31.24, 5000, at), true);
  assert.equal(p.compacted(12, 9000, at), false, 'a shorter one is not the day\'s');
  assert.equal(p.compacted(31.2, 4000, at), false, 'nor the same stall at a smaller hall');
  assert.equal(p.compacted(31.2, 6000, at), true, 'the same stall at a larger hall is');
  assert.deepEqual(p.view()[0].compactMs, { max: 31.2, messages: 6000 });
  p.dirty = false;
  assert.equal(p.compacted(0, 0, new Date(2026, 10, 1, 12).getTime()), false, 'nothing to say: no change');
  assert.equal(p.dirty, false);
  p.auditPut(0.2, at);
  assert.equal(p.dirty, true, 'every append timed asks for a save at the window\'s end');
});

test('peaks: saved with each day\'s buckets, so a restart counts on; what is not a day is left out', () => {
  const at = new Date(2026, 9, 31, 20).getTime();
  const p = new readings.Peaks();
  p.note({ loopMs: 4.2, hallMessages: 300 }, at);
  p.auditPut(0.4, at); p.auditPut(3.5, at);
  p.compacted(8.5, 300, at);
  const saved = JSON.parse(JSON.stringify(p.toJSON()));
  assert.equal(saved.v, 1);
  assert.equal(saved.days[0].auditPutMs.buckets.length, readings.BOUNDS.length + 1);
  const back = new readings.Peaks().load(saved);
  assert.deepEqual(back.view(), p.view(), 'read back as it was');
  assert.equal(back.dirty, false, 'and what was read back asks for no save');
  back.auditPut(0.4, at);
  assert.equal(back.view()[0].auditPutMs.count, 3, 'and goes on counting');
  const odd = new readings.Peaks().load({ days: [
    { day: '2026-10-30', loopMs: 'x', elu: -1, hallMessages: 12.7, compactMs: null, auditPutMs: { count: 5, max: 9, buckets: [1, 2] }, at: 'now' },
    { day: 'yesterday', loopMs: 99 }, null, 42, { day: '2026-10-30', hallMessages: 3 },
  ] });
  assert.deepEqual(odd.view(), [{
    day: '2026-10-30', loopMs: 0, elu: 0, socketsPerAddress: { venue: 0, tunnel: 0 }, tunnelSockets: 0, tunnelRefused: { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, hallMessages: 3, hallKb: 0, joinBurst: 0,
    compactMs: { max: 0, messages: 0 }, auditPutMs: { count: 0, p99: null, max: null }, at: 0, sleeps: 0, sleptMs: 0,
  }], 'a day named twice is its last record; a count the buckets cannot account for is none');
  // Per lane, by type: a build that counted every address in one number is read as the venue's; anything else is none.
  const lanes = (v) => new readings.Peaks().load({ days: [{ day: '2026-10-29', socketsPerAddress: v, tunnelRefused: 4.7 }] }).view()[0];
  assert.deepEqual(lanes(12).socketsPerAddress, { venue: 12, tunnel: 0 });
  assert.deepEqual(lanes({ venue: 5, tunnel: 7 }).socketsPerAddress, { venue: 5, tunnel: 7 });
  assert.deepEqual(lanes({ venue: 'x', tunnel: -2 }).socketsPerAddress, { venue: 0, tunnel: 0 });
  assert.deepEqual(lanes(null).socketsPerAddress, { venue: 0, tunnel: 0 });
  assert.deepEqual(lanes(0).tunnelRefused, { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, 'refusals not kept by kind: none');
  const kinds = (v) => new readings.Peaks().load({ days: [{ day: '2026-10-29', tunnelRefused: v }] }).view()[0].tunnelRefused;
  assert.deepEqual(kinds({ full: 4.7, share: 2, rate: -1, idle: 'x', wrongCode: 1, toString: 9 }), { rate: 0, share: 2, full: 4, idle: 0, wrongCode: 1 }, 'by kind, each a whole count; nothing else');
  assert.deepEqual(new readings.Peaks().load({ days: [{ day: '2026-10-29', auditPutMs: { max: 9, buckets: new Array(readings.BOUNDS.length + 1).fill(0).map((_, i) => (i === 2 ? 1.5 : 0)) } }] }).view()[0].auditPutMs.count, 0, 'a bucket that is not a whole count: none');
  for (const nothing of [null, undefined, {}, { days: 'x' }]) assert.deepEqual(new readings.Peaks().load(nothing).view(), []);
  const many = { days: Array.from({ length: 20 }, (_, i) => ({ day: '2026-10-' + String(i + 1).padStart(2, '0'), hallMessages: i })) };
  assert.deepEqual(new readings.Peaks().load(many).view().map((d) => d.hallMessages), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 'the newest 14');
});

test('health\'s timings are taken in place: a snapshot and an audit append that reach the disk, never one that failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-'));
  const store = new RoomStore(dir);
  const took = [];
  store.onCompact = (ms, messages) => took.push([typeof ms === 'number' && ms >= 0, messages]);
  const r = store.create('ABC234', 'Test');
  assert.equal(typeof r.snapKb, 'number', 'the snapshot\'s size is kept as it is written');
  for (let i = 0; i < 40; i++) store.commit(r, { o: 'add', m: { id: 'm' + i, type: 'text', text: 'x'.repeat(100), at: i } });
  const small = r.snapKb;
  store.compact('ABC234');
  assert.ok(r.snapKb > small && r.snapKb >= 4, 'it follows the hall\'s size: ' + small + ' → ' + r.snapKb);
  assert.equal(r.snapKb, Math.round(fs.statSync(path.join(dir, 'ABC234.json')).size / 102.4) / 10, 'in KB, to a tenth');
  assert.deepEqual(took, [[true, 0], [true, 40]]);
  const reloaded = new RoomStore(dir);
  reloaded.loadAll(null, { compact: false });
  assert.equal(reloaded.get('ABC234').snapKb, null, 'unknown until this run writes a snapshot: no file call is added');
  fs.renameSync(path.join(dir, 'ABC234.json'), path.join(dir, 'held.json'));
  fs.mkdirSync(path.join(dir, 'ABC234.json'));   // the snapshot cannot be renamed into place
  store.compact('ABC234');
  assert.ok(store.lastError);
  assert.equal(took.length, 2, 'a snapshot that failed is not timed');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-')), 'audit.jsonl');
  const log = auditLog(file);
  const puts = [];
  log.onPut = (ms) => puts.push(typeof ms === 'number' && ms >= 0);
  log.write({ t: 'system' }, 'boot', '', 'first');
  fs.renameSync(file, file + '.held'); fs.mkdirSync(file);
  log.write({ t: 'system' }, 'x', '', 'while the disk would not take it');
  fs.rmdirSync(file); fs.renameSync(file + '.held', file);
  log.write({ t: 'system' }, 'x', '', 'third, with the second ahead of it');
  assert.deepEqual(puts, [true, true], 'two appends reached the disk; the one that failed is not timed');
});

test('peaks: the most joins one hall took in any 5 s, read whole when a storm crosses the 5 s tick; bounded per hall', () => {
  const b = new readings.Burst();
  const t0 = 1_000_000;   // a monotonic clock, in ms
  for (let i = 0; i < 30; i++) b.add('HALL01', t0 + 3000 + i * 60);   // 30 seated in the 1.8 s before a tick…
  assert.equal(b.take(t0 + 5000), 30);
  let last = 0;
  for (let i = 0; i < 30; i++) last = b.add('HALL01', t0 + 5000 + i * 60);   // …and 30 in the 1.8 s after it
  assert.equal(last, 60, 'the window that ends now holds both halves');
  assert.equal(b.take(t0 + 10_000), 60, 'one storm of 60, not two of 30');
  assert.equal(b.take(t0 + 10_000), 0, 'a take starts the next window\'s reading from nothing');
  // Joins 6 s apart are never one window's, and another hall's count apart.
  b.add('HALL01', t0 + 20_000); b.add('HALL02', t0 + 20_000);
  assert.equal(b.add('HALL01', t0 + 26_000), 1, 'the one 6 s before has left the window');
  assert.equal(b.take(t0 + 26_000), 1);
  // Steady joins, one a second, read 5: the window is 5 s, give or take one slot at its far edge.
  for (let i = 0; i < 20; i++) b.add('HALL03', t0 + 40_000 + i * 1000);
  assert.equal(b.take(t0 + 60_000), 5);
  assert.equal(b.keys.size, 1, 'a hall with nothing in the last window is let go');
  b.take(t0 + 70_000);
  assert.equal(b.keys.size, 0, 'so the slots kept are bounded by the halls that joined in the last 5 s');
  const slow = new readings.Burst({ windowMs: 5000, slotMs: 1000 });
  assert.equal(slow.slots, 5);
});

test('health\'s timing hooks never reach what they time: a throw there leaves the snapshot and the audit entry on disk', () => {
  const said = [];
  const error = console.error;
  console.error = (...a) => { said.push(a.join(' ')); };
  try {
    const store = new RoomStore(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-store-')));
    store.onCompact = () => { throw new Error('bookkeeping'); };
    const r = store.create('ABC234', 'Test');
    store.commit(r, { o: 'add', m: { id: 'm1', type: 'text', text: 'kept', at: 1 } });
    store.compact('ABC234');
    assert.equal(store.lastError, null, 'the snapshot was written');
    assert.equal(r.logCount, 0, 'and the log cut after it');

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-')), 'audit.jsonl');
    const log = auditLog(file);
    log.onPut = () => { throw new Error('bookkeeping'); };
    const e = log.write({ t: 'system' }, 'boot', '', 'first');
    assert.equal(e.seq, 1);
    assert.equal(log.unwritten, 0, 'the entry is on disk');
    assert.ok(fs.readFileSync(file, 'utf8').includes('"boot"'));
  } finally { console.error = error; }
  assert.ok(said.some((l) => /a snapshot's time could not be noted for ABC234 bookkeeping/.test(l)), said.join('\n'));
  assert.ok(said.some((l) => /an append's time could not be noted: bookkeeping/.test(l)), said.join('\n'));
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
  // A message its page held while offline is dated as written and as sent; one sent at once carries its time alone.
  const at = Date.UTC(2026, 10, 1, 14, 6, 30);
  const held = ai.threadText([
    { type: 'help', category: 'Sound', text: 'radio mic 3', help: { state: 'open' }, at, held: 268, from: { name: 'Ana', role: 'research' } },
    { type: 'text', text: 'Thanks', at, held: 0, from: { name: 'Chair', role: 'board' } },
  ]).split('\n');
  assert.equal(held[0], '[14:06, written 14:02 and sent when the connection was back] Ana (research) asked for help (Sound): radio mic 3');
  assert.equal(held[1], '[14:06] Chair (board): Thanks');
});

test('ai: the SDK is required at the first draft asked with a key, never as the server loads lib/ai.js, so a start goes without its cost', () => {
  // In a process of its own, whose module cache this file's other tests have not touched. The draft is asked of a closed
  // port, and the process ends before anything is sent.
  const script = [
    'const sep = require("path").sep;',
    'const sdk = () => Object.keys(require.cache).some((k) => k.includes(sep + "@anthropic-ai" + sep));',
    'const ai = require(' + JSON.stringify(path.join(__dirname, '..', 'lib', 'ai.js')) + ');',
    'const said = [sdk()];',
    'ai.draftReply("", { messages: [] }).then((r) => {',
    '  said.push(sdk(), r.error);',
    '  ai.draftReply("a-key-for-the-load-test", { messages: [] }).catch(() => {});',
    '  said.push(sdk());',
    '  process.stdout.write(JSON.stringify(said));',
    '  process.exit(0);',
    '});',
  ].join('\n');
  const out = require('child_process').execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [false, false, 'Add an Anthropic API key in Admin → AI (or set ANTHROPIC_API_KEY).', true]);
});

test('ai: what each prompt asks the model says the Board and the backstage team, the words a draft the Board reads uses', async (t) => {
  const http = require('http');
  const bodies = [];
  const answer = { draft: 'ok', gaps: [], confidence: 'low', options: ['Yes', 'No'], headline: 'h', decisions: [], open: [], actions: [] };
  const model = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { model.listen(0, '127.0.0.1', resolve); });
  const was = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + model.address().port;   // read when the client for this key is made
  t.after(() => { if (was === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = was; model.close(); });
  const key = 'a-key-for-the-words-test';
  const messages = [{ type: 'text', text: 'What was capex?', at: 0, from: { name: 'Chair', role: 'board' } }, { type: 'text', text: 'Checking', at: 0, from: { name: 'Ana', role: 'research' } }];
  assert.equal((await ai.draftReply(key, { messages, instruction: 'keep it short' })).draft, 'ok');
  assert.deepEqual((await ai.suggestOptions(key, { prompt: 'Refer to slide 14?', messages })).options, ['Yes', 'No']);
  assert.equal((await ai.summarise(key, { messages, roomName: 'Hall 2' })).headline, 'h');
  const [draft, options, minutes] = bodies.map((b) => ({ system: b.system, user: b.messages.map((m) => m.content).join('\n') }));
  assert.equal(bodies.length, 3);
  for (const asked of [draft, options, minutes]) {
    assert.doesNotMatch(asked.system + '\n' + asked.user, /director|research team|meeting:/i, 'one word per thing: ' + asked.system);
    assert.match(asked.system, /\(board\) marks a Board member on stage, \(research\) the backstage team and \(observer\) someone who only reads\.$/, 'the role words the lines carry, read');
  }
  assert.match(draft.system, /^You support the backstage team at a company's AGM or board meeting\. A Board member on stage\n/);
  assert.match(draft.system, /Draft the reply the backstage team will send to the Board:/);
  assert.match(draft.user, /^Answer the latest question from the Board\.$/m);
  assert.match(draft.user, /^Backstage team note: keep it short$/m);
  assert.match(options.system, /^You write tap-to-answer options for a Board member on stage\./);
  assert.match(options.user, /\nThe backstage team is asking the Board: Refer to slide 14\?\nSuggest 2 to 4 short tap-to-answer options \(max 4 words each\) a Board member on stage can choose\.$/);
  assert.match(minutes.system, /between the Board on stage and the backstage team\./);
  assert.match(minutes.user, /^Hall: Hall 2\n/);
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

test('Refusals: today\'s by lane and by what was refused, starting afresh at 06:00; one log line a minute at most while refusing', () => {
  const at = (h, m = 0, s = 0, d = 31) => new Date(2026, 9, d, h, m, s).getTime();
  const r = new readings.Refusals();
  assert.deepEqual(r.view(at(20)), { tunnel: { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, venue: { rate: 0 } });
  assert.equal(r.logLine(at(20)), null, 'nothing refused: no line');
  for (let i = 0; i < 10; i++) assert.equal(r.note('tunnel', 'full', at(20)), true);
  r.note('tunnel', 'share', at(20)); r.note('tunnel', 'share', at(20));
  r.note('venue', 'rate', at(20));
  // Only the kinds each lane counts: never a new key, never another lane.
  assert.equal(r.note('venue', 'full', at(20)), false);
  assert.equal(r.note('tunnel', 'toString', at(20)), false);
  assert.equal(r.note('__proto__', 'rate', at(20)), false);
  assert.deepEqual(r.view(at(20)), { tunnel: { rate: 0, share: 2, full: 10, idle: 0, wrongCode: 0 }, venue: { rate: 1 } });
  assert.equal(r.logLine(at(20)), '[tunnel] refused 12 in the last minute: 10 full, 2 one network\'s share', 'the venue\'s refusals are not the tunnel\'s line');
  r.note('tunnel', 'rate', at(20, 0, 30)); r.note('tunnel', 'idle', at(20, 0, 30)); r.note('tunnel', 'wrongCode', at(20, 0, 30));
  assert.equal(r.logLine(at(20, 0, 59)), null, 'not a minute since the last line');
  assert.equal(r.logLine(at(20, 1, 0)), '[tunnel] refused 3 in the last minute: 1 too fast from one network, 1 wrong codes, 1 never joined');
  assert.equal(r.logLine(at(20, 5)), null, 'said: nothing more until the next refusal');
  r.note('tunnel', 'full', at(20, 5));
  assert.equal(r.logLine(at(20, 5)), '[tunnel] refused 1 in the last minute: 1 full', 'the first after a quiet spell is said at once');
  assert.deepEqual(r.view(at(23, 59)).tunnel, { rate: 1, share: 2, full: 11, idle: 1, wrongCode: 1 }, 'today\'s, past midnight too');
  assert.deepEqual(r.view(at(5, 59, 59, 32)).tunnel.full, 11, 'the show day runs to 06:00');
  assert.deepEqual(r.view(at(6, 0, 0, 32)), { tunnel: { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, venue: { rate: 0 } }, 'a new show day starts afresh');
  assert.deepEqual(readings.REFUSED, { tunnel: ['rate', 'share', 'full', 'idle', 'wrongCode'], venue: ['rate'] });
  // At a start, the tunnel's carry on from the day's peaks (by kind, whole counts only); the venue's count from the start.
  const carried = new readings.Refusals();
  carried.carry({ full: 3, share: 1.5, idle: -2, rate: 'x', wrongCode: 1, extra: 7 }, at(21));
  assert.deepEqual(carried.view(at(21)), { tunnel: { rate: 0, share: 1, full: 3, idle: 0, wrongCode: 1 }, venue: { rate: 0 } });
  carried.note('tunnel', 'full', at(21));
  assert.equal(carried.view(at(21)).tunnel.full, 4, 'counted on');
  assert.equal(carried.logLine(at(21)), '[tunnel] refused 1 in the last minute: 1 full', 'the log says only what came after the start');
  assert.deepEqual(carried.view(at(6, 0, 0, 32)).tunnel.full, 0, 'and a new show day starts afresh');
  const fresh = new readings.Refusals();
  fresh.carry(null, at(21));
  assert.deepEqual(fresh.view(at(21)).tunnel, { rate: 0, share: 0, full: 0, idle: 0, wrongCode: 0 }, 'nothing carried: none');
});

test('linkCheck: every try answered is ok, with the middle and the longest round trip; a try without an answer says so', () => {
  assert.deepEqual(readings.linkCheck([85.2, 140.4, 60, 90, 70], 1000), { at: 1000, ok: true, p50Ms: 85, maxMs: 140, words: 'round trip 85 ms (max 140 ms)' });
  assert.deepEqual(readings.linkCheck([null, 120, null, 80, 100], 2000), { at: 2000, ok: false, p50Ms: 100, maxMs: 120, words: 'The internet link answered 3 of 5 tries: remote phones may not join.' });
  assert.deepEqual(readings.linkCheck([null, null, null, null, null], 3000), { at: 3000, ok: false, p50Ms: null, maxMs: null, words: 'The internet link did not answer: remote phones cannot join.' });
  assert.equal(readings.linkCheck([], 4000).ok, false, 'no try is no check');
  assert.equal(readings.linkCheck(null, 4000).ok, false);
  assert.equal(readings.linkCheck([10, -1, Number.NaN, '5'], 5000).words, 'The internet link answered 1 of 4 tries: remote phones may not join.', 'only a time is an answer');
});
