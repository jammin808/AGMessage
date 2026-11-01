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

test('health: the most sockets from one address and those through the tunnel are counts, never addresses', () => {
  const datas = [
    { ip: '192.168.1.20' }, { ip: '192.168.1.20' }, { ip: '192.168.1.21' },
    { ip: 'cf:203.0.113.7', viaTunnel: true }, { ip: 'cf:203.0.113.7', viaTunnel: true }, { ip: 'cf:203.0.113.7', viaTunnel: true },
    { ip: 'cf:198.51.100.4', viaTunnel: true }, null, {}, { ip: '' },
  ];
  assert.deepEqual(readings.countSockets(datas), { maxPerAddress: 3, tunnel: 4 });
  assert.deepEqual(readings.countSockets([]), { maxPerAddress: 0, tunnel: 0 });
  const ring = new (require('../lib/resilience').Ring)(4, 3);
  for (const v of [0.0019, 0.012, 0.5004]) ring.push(v);
  assert.deepEqual(ring.stats(), { count: 3, p50: 0.012, p95: 0.5, max: 0.5 }, 'a fraction (ELU) keeps 3 decimals');
});

test('peaks: per show day (06:00 to 06:00 by the laptop\'s clock), raised and never lowered, the newest 14 days kept', () => {
  const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime();   // 2026-10-<d>, the laptop's own time
  const p = new readings.Peaks();
  assert.equal(p.dirty, false, 'nothing to save yet');
  assert.equal(p.note({ loopMs: 3.14, elu: 0.1234, socketsPerAddress: 4, tunnelSockets: 1, hallMessages: 1200, hallKb: 340.26, joinBurst: 12 }, at(31, 9)), true);
  assert.equal(p.dirty, true, 'a rise asks for a save at the window\'s end');
  p.dirty = false;
  assert.equal(p.note({ loopMs: 1, elu: 0.05, socketsPerAddress: 2, tunnelSockets: 0, hallMessages: 1100, hallKb: 300, joinBurst: 3 }, at(31, 10)), false, 'nothing rose: the record stands');
  assert.equal(p.dirty, false, 'and asks for no save');
  assert.equal(p.note({ loopMs: 7.04, hallMessages: 1250 }, at(31, 11)), true);
  const today = p.view()[0];
  assert.deepEqual({ ...today, auditPutMs: undefined }, {
    day: '2026-10-31', loopMs: 7, elu: 0.123, socketsPerAddress: 4, tunnelSockets: 1, hallMessages: 1250, hallKb: 340.3, joinBurst: 12,
    compactMs: { max: 0, messages: 0 }, auditPutMs: undefined, at: at(31, 11),
  });
  assert.deepEqual(today.auditPutMs, { count: 0, p99: null, max: null });
  // An evening that runs past midnight is its show day's; 06:00 starts the next, and a reading never touches another day's.
  p.note({ joinBurst: 50 }, new Date(2026, 10, 1, 0, 0, 1).getTime());
  p.note({ joinBurst: 60 }, new Date(2026, 10, 1, 5, 59, 59).getTime());
  p.note({ joinBurst: 7 }, new Date(2026, 10, 1, 6, 0, 0).getTime());
  assert.deepEqual(p.view().map((d) => [d.day, d.joinBurst]), [['2026-10-31', 60], ['2026-11-01', 7]]);
  assert.deepEqual([new Date(2026, 11, 1, 3), new Date(2027, 0, 1, 1), new Date(2027, 0, 1, 6)].map((d) => readings.dayOf(d.getTime())),
    ['2026-11-30', '2026-12-31', '2027-01-01'], 'named by the date the show day starts on, across a month and a year');
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
    day: '2026-10-30', loopMs: 0, elu: 0, socketsPerAddress: 0, tunnelSockets: 0, hallMessages: 3, hallKb: 0, joinBurst: 0,
    compactMs: { max: 0, messages: 0 }, auditPutMs: { count: 0, p99: null, max: null }, at: 0,
  }], 'a day named twice is its last record; a count the buckets cannot account for is none');
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
