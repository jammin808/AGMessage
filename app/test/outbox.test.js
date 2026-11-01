'use strict';
// A send never vanishes and never doubles. The page's half: public/outbox.js, loaded as a page loads it (a vm with the
// browser's names and nothing else) and driven with a socket, a clock, timers and a session store of the test's own.
// The server's half, end to end: a send's client id answered with what it became, also after a restart and after the
// message was removed; the wait a held send carries; the acts whose repeat is answered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const { ROOT, TOKEN, startServer, stopServer, restartServer, api, connect, emit, wait } = require('./helpers');

const SRC = fs.readFileSync(path.join(ROOT, 'public', 'outbox.js'), 'utf8');

/** outbox.js run as a page runs it, with only what `globals` gives the window. Returns the window. */
function page(globals) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(SRC, ctx, { filename: 'outbox.js' });
  return ctx;
}

/** A session store as a browser's: length, key(i), getItem, setItem, removeItem. */
function sessionStore() {
  const m = new Map();
  return {
    map: m,
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** A clock and timers that move only when told. */
function clock() {
  let now = 1000;
  let wall = 1_700_000_000_000;
  const timers = [];
  return {
    now: () => now,
    wall: () => wall,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
      wall += ms;
    },
    jumpWall(ms) { wall += ms; },
  };
}

/** A socket: what was emitted (the verb, the arguments, the answer callback), and a drop. */
function socket() {
  const handlers = {};
  return {
    connected: false,
    sent: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(verb, ...args) { const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null; this.sent.push({ verb, args, ack }); },
    drop() { this.connected = false; for (const f of handlers.disconnect || []) f('transport close'); },
  };
}

/** A fresh outbox on a fake page: its socket, clock, store and every change it told the page of. */
function rig({ store = sessionStore(), c = clock() } = {}) {
  const win = page({ crypto: { getRandomValues: (b) => nodeCrypto.getRandomValues(b) } });
  const ob = win.AGM.outbox.create({ crypto: { getRandomValues: (b) => nodeCrypto.getRandomValues(b) }, storage: () => store, now: c.now, wall: c.wall, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const s = socket();
  const told = [];
  ob.attach(s, { onChange: (item) => told.push(item.state + ':' + item.cid) });
  return { ob, s, c, store, told, join: (who = 'u1') => { s.connected = true; ob.ready({ scope: 'hall|K7P2QX', who }); } };
}
const CID = /^[A-Za-z0-9_-]{22}$/;
const KEY = 'agm.outbox|hall|K7P2QX|u1';

test('outbox: a client id from getRandomValues alone, as a page served over plain HTTP has it (no randomUUID)', () => {
  const win = page({ crypto: { getRandomValues: (b) => nodeCrypto.getRandomValues(b) }, sessionStorage: sessionStore(), performance: { now: () => 0 } });
  assert.equal(typeof win.crypto.randomUUID, 'undefined');
  const ids = new Set(Array.from({ length: 1000 }, () => win.AGM.outbox.cid()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, CID);
  // The 16 bytes, base64url without padding: the encoder is the platform's to the bit.
  const fixed = page({ crypto: { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = i * 17 + 3; return b; } } });
  assert.equal(fixed.AGM.outbox.cid(), Buffer.from(Array.from({ length: 16 }, (_, i) => i * 17 + 3)).toString('base64url'));
  const ones = page({ crypto: { getRandomValues: (b) => b.fill(255) } });
  assert.equal(ones.AGM.outbox.cid(), Buffer.alloc(16, 255).toString('base64url'));
  // Loaded after a script that made AGM, it extends it.
  const both = vm.createContext({ crypto: { getRandomValues: (b) => b } });
  vm.runInContext('globalThis.window = globalThis; window.AGM = { esc: 1 };', both);
  vm.runInContext(SRC, both);
  assert.equal(both.AGM.esc, 1);
  assert.equal(typeof both.AGM.outbox.hold, 'function');
});

test('outbox hold: held until joined, sent one at a time in the order written, with its cid and its wait', () => {
  const t = rig();
  const a = t.ob.hold('message', { type: 'text', text: 'one' }, { tag: { composer: 'text' } });
  const b = t.ob.hold('message', { type: 'text', text: 'two' });
  assert.equal(t.s.sent.length, 0, 'nothing goes before the join\'s answer');
  assert.deepEqual([a.state, b.state], ['waiting', 'waiting']);
  t.c.advance(65_000);
  t.join();
  assert.equal(t.s.sent.length, 1, 'one at a time');
  const first = t.s.sent[0];
  assert.equal(first.verb, 'message');
  assert.equal(first.args[0].text, 'one');
  assert.equal(first.args[0].cid, a.cid);
  assert.match(a.cid, CID);
  assert.equal(first.args[0].heldMs, 65_000, 'the page\'s own count since it was written');
  assert.ok(t.store.map.has(KEY), 'held in the tab\'s store, under the hall and the person');
  first.ack({ ok: true, id: 'm1', seq: 4 });
  assert.equal(a.state, 'done');
  assert.deepEqual(a.result, { ok: true, id: 'm1', seq: 4 });
  assert.equal(t.s.sent.length, 2);
  assert.equal(t.s.sent[1].args[0].text, 'two');
  t.s.sent[1].ack({ ok: true, id: 'm2', seq: 5 });
  assert.equal(t.ob.items().length, 0);
  assert.ok(!t.store.map.has(KEY), 'nothing held: the store keeps nothing');
  assert.deepEqual(t.told.filter((x) => x.endsWith(a.cid)).map((x) => x.split(':')[0]), ['waiting', 'sending', 'done']);
});

test('outbox hold: a drop while it is out sends it again with the same cid; the first answer decides; the wait is capped at 24 h', () => {
  const t = rig();
  t.join();
  const a = t.ob.hold('message', { type: 'text', text: 'during the blip' });
  assert.equal(t.s.sent.length, 1);
  t.s.drop();
  assert.equal(a.state, 'waiting');
  t.c.advance(90_000_000);
  t.join();
  assert.equal(t.s.sent.length, 2);
  assert.equal(t.s.sent[1].args[0].cid, a.cid, 'the same cid: the server answers it with what the first became');
  assert.equal(t.s.sent[1].args[0].heldMs, 86_400_000);
  t.s.sent[1].ack({ ok: true, id: 'm1', seq: 1 });
  t.s.sent[0].ack({ ok: false, error: 'late' });   // an answer to the attempt before the drop, after the one that decided
  assert.equal(a.state, 'done');
  assert.equal(t.s.sent.length, 2);
});

test('outbox hold: the rate\'s refusal holds it and sends it again; a refusal keeps it, with the words, until Retry', () => {
  const t = rig();
  t.join();
  const a = t.ob.hold('message', { type: 'text', text: 'busy' });
  t.s.sent[0].ack({ ok: false, error: 'Slow down a little.', busy: true });
  assert.equal(a.state, 'waiting');
  t.c.advance(999);
  assert.equal(t.s.sent.length, 1);
  t.c.advance(1);
  assert.equal(t.s.sent.length, 2, 'sent again a second later');
  assert.equal(t.s.sent[1].args[0].cid, a.cid);
  assert.equal(t.s.sent[1].args[0].heldMs, 0, 'a wait for the rate, connected all along, is no wait offline');
  t.s.sent[1].ack({ ok: false, error: 'Observers can read but not post.' });
  assert.equal(a.state, 'refused');
  assert.equal(a.words, 'Observers can read but not post.');
  t.s.drop();
  t.join();
  assert.equal(t.s.sent.length, 2, 'a refused send is not sent by itself');
  assert.equal(JSON.parse(t.store.map.get(KEY))[0].state, 'refused', 'kept, with its words, across a reload');
  t.ob.retry(a.cid);
  assert.equal(t.s.sent.length, 3);
  assert.equal(t.s.sent[2].args[0].cid, a.cid);
  t.s.sent[2].ack({ ok: true, id: 'm9', seq: 9, gone: true });
  assert.equal(a.state, 'gone');
  assert.equal(a.words, 'That message was removed.');
  // Let go (Edit): not sent.
  const b = t.ob.hold('message', { type: 'text', text: 'x' });
  t.s.drop();
  t.ob.drop(b.cid);
  t.join();
  assert.equal(t.s.sent.filter((x) => x.args[0] && x.args[0].cid === b.cid).length, 1);
  assert.equal(b.state, 'dropped');
});

test('outbox hold: the page has the message (its broadcast, the changes missed, the history): done without the answer', () => {
  const t = rig();
  const a = t.ob.hold('message', { type: 'text', text: 'landed in the history' });
  t.ob.landed(a.cid);
  assert.equal(a.state, 'done');
  t.join();
  assert.equal(t.s.sent.length, 0, 'what landed is not sent again');
});

test('outbox hold: its wait is the time the page was not connected and joined since it was written, spell by spell', () => {
  const t = rig();
  t.c.advance(10_000);
  t.join();   // a page that has been up a while: none of that is a send's wait
  const a = t.ob.hold('message', { type: 'text', text: 'slow to answer' });
  const b = t.ob.hold('message', { type: 'text', text: 'queued behind it' });
  t.c.advance(4000);
  t.s.sent[0].ack({ ok: true, id: 'm1', seq: 1 });
  assert.equal(a.state, 'done');
  assert.equal(t.s.sent[1].args[0].heldMs, 0, 'queued behind a slow answer, connected all along: no wait offline');
  t.s.drop();
  t.c.advance(30_000);
  t.join();
  assert.equal(t.s.sent[2].args[0].cid, b.cid);
  assert.equal(t.s.sent[2].args[0].heldMs, 30_000, 'the 30 s the page was off, not the 34 s since it was written');
  t.s.sent[2].ack({ ok: true, id: 'm2', seq: 2 });
  const c = t.ob.hold('message', { type: 'text', text: 'two spells' });
  t.s.drop(); t.c.advance(7000); t.join();
  t.c.advance(2000);
  t.s.drop(); t.c.advance(5000); t.join();
  assert.equal(t.s.sent.filter((x) => x.args[0].cid === c.cid).pop().args[0].heldMs, 12_000, 'two spells off, without the time on between them');
});

test('outbox hold: a reload keeps this person\'s sends in this hall; another person\'s are dropped, never sent as them', () => {
  const store = sessionStore();
  const c = clock();
  const before = rig({ store, c });
  const a = before.ob.hold('message', { type: 'text', text: 'held across a reload' });
  before.c.advance(20_000);
  before.join();   // joined, then the connection drops before it went out
  before.s.sent.length = 0;
  before.s.drop();
  before.ob.hold('forward', { messageId: 'm7', targetRoom: 'LEGAL1' }, { tag: { forward: 'Legal' } });
  c.advance(5_000);
  // Another person's held sends in this hall and a send held in another hall, in the same tab.
  store.setItem('agm.outbox|hall|K7P2QX|u2', JSON.stringify([{ cid: 'zzzzzzzzzzzzzzzzzzzzzz', verb: 'message', args: { type: 'text', text: 'not theirs' }, state: 'waiting', waited: 0, savedAt: c.wall() }]));
  store.setItem('agm.outbox|hall|OTHER1|u1', '[]');
  store.setItem('agm.outbox|hall|K7P2QX|u1|x', 'not a list');
  c.jumpWall(30_000);   // the reload took 30 s
  const after = rig({ store, c });
  after.join();
  assert.ok(!store.map.has('agm.outbox|hall|K7P2QX|u2'), 'another person\'s are dropped');
  assert.ok(store.map.has('agm.outbox|hall|OTHER1|u1'), 'another hall\'s stay for that hall');
  const sent = after.s.sent[0];
  assert.equal(sent.args[0].cid, a.cid, 'sent with its cid');
  assert.equal(sent.args[0].text, 'held across a reload');
  assert.equal(sent.args[0].heldMs, 55_000, 'the wait before the reload, and the reload\'s');
  sent.ack({ ok: true, id: 'm1', seq: 1 });
  assert.equal(after.s.sent[1].verb, 'forward');
  assert.equal(after.ob.items()[0].tag.forward, 'Legal', 'its tag comes back with it');
  after.s.sent[1].ack({ ok: true, id: 'f1' });
  assert.ok(!after.s.sent.some((x) => x.args[0] && x.args[0].text === 'not theirs'));
  assert.ok(!store.map.has(KEY));
  // The same page joined as someone else (never in practice): what it held as the first is not sent as the second.
  after.s.drop();
  const b = after.ob.hold('message', { type: 'text', text: 'as u1' });
  after.join('u3');
  assert.equal(b.state, 'dropped');
  assert.ok(!after.s.sent.some((x) => x.args[0] && x.args[0].cid === b.cid));
});

test('outbox hold: a file is held in memory only, uploaded with the message, and uploaded once more when the server lost it', async () => {
  const store = sessionStore();
  const t = rig({ store });
  t.join();
  const uploads = [];
  const answers = [{ network: true }, { status: 403, error: 'Join a room to share files.' }, { url: '/uploads/1-aaaaaaaaaaaa-a.pdf', mime: 'application/pdf' }, { url: '/uploads/2-bbbbbbbbbbbb-a.pdf', mime: 'application/pdf' }];
  const file = { name: 'a.pdf' };
  const a = t.ob.hold('message', { type: 'file', url: '', filename: 'a.pdf', caption: 'the deck' }, { file, upload: (f) => { uploads.push(f); return answers.shift(); } });
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  assert.equal(uploads.length, 1);
  assert.equal(a.state, 'waiting', 'never reached AGMessage: it waits');
  t.c.advance(2000); await settle();
  assert.equal(uploads.length, 2);
  assert.equal(a.state, 'waiting', 'a token a join renewed: once more');
  t.c.advance(2000); await settle();
  assert.equal(uploads.length, 3);
  assert.equal(t.s.sent.length, 1);
  assert.equal(t.s.sent[0].args[0].url, '/uploads/1-aaaaaaaaaaaa-a.pdf');
  assert.equal(JSON.parse(store.map.get(KEY))[0].file, true, 'its bytes are not in the store');
  t.s.sent[0].ack({ ok: false, error: 'That file is no longer on the AGMessage laptop: choose it again.', reupload: true });
  await settle();
  assert.equal(uploads.length, 4, 'the server no longer has it: uploaded once more');
  assert.equal(t.s.sent[1].args[0].url, '/uploads/2-bbbbbbbbbbbb-a.pdf');
  assert.equal(t.s.sent[1].args[0].cid, a.cid);
  t.s.sent[1].ack({ ok: false, error: 'That file is no longer on the AGMessage laptop: choose it again.', reupload: true });
  assert.equal(a.state, 'refused', 'once more, not again and again');

  // After a reload a file never uploaded is not there to send: its echo says so, and it is not sent. One uploaded goes
  // by its link with its cid, and is "choose it again" only when the laptop no longer has the upload.
  t.ob.drop(a.cid);
  t.s.drop();
  const never = t.ob.hold('message', { type: 'file', url: '', filename: 'b.pdf' }, { file, upload: () => ({}) });
  const uploaded = t.ob.hold('message', { type: 'file', url: '/uploads/3-cccccccccccc-a.pdf', filename: 'c.pdf' }, { file, upload: () => ({}) });
  const after = rig({ store });
  after.join();
  const back = after.ob.items().find((i) => i.cid === never.cid);
  assert.equal(back.state, 'lost');
  assert.equal(back.words, 'Not sent — choose the file again');
  assert.ok(!after.s.sent.some((x) => x.args[0].cid === never.cid));
  const sent = after.s.sent.find((x) => x.args[0].cid === uploaded.cid);
  assert.ok(sent, 'an uploaded file goes after a reload');
  assert.equal(sent.args[0].url, '/uploads/3-cccccccccccc-a.pdf');
  sent.ack({ ok: false, error: 'That file is no longer on the AGMessage laptop: choose it again.', reupload: true });
  const gone = after.ob.items().find((i) => i.cid === uploaded.cid);
  assert.equal(gone.state, 'lost', 'its bytes are gone with the page that held them');
  assert.equal(gone.words, 'Not sent — choose the file again');
  assert.equal(JSON.parse(store.map.get(KEY)).find((r) => r.cid === uploaded.cid).state, 'lost', 'and so it stays across a reload');
});

test('outbox hold: a send that landed before a reload is matched to the message the page drew, never sent or offered again', async () => {
  const store = sessionStore();
  const before = rig({ store });
  before.join();
  const file = before.ob.hold('message', { type: 'file', url: '', filename: 'deck.pdf' }, { file: {}, upload: () => ({ url: '/uploads/1-abcdefabcdef-a.pdf', mime: 'application/pdf' }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(before.s.sent[0].args[0].url, '/uploads/1-abcdefabcdef-a.pdf');
  const text = before.ob.hold('message', { type: 'text', text: 'queued' });
  before.s.drop();   // the server committed the file; the page reloads before its answer is read
  assert.equal(JSON.parse(store.map.get(KEY)).find((r) => r.cid === file.cid).args.url, '/uploads/1-abcdefabcdef-a.pdf', 'its link is kept once it is uploaded');
  const drawn = new Set([file.cid]);
  const after = rig({ store });
  const asked = [];
  after.s.connected = true;
  after.ob.ready({ scope: 'hall|K7P2QX', who: 'u1', has: (cid) => { asked.push(cid); return drawn.has(cid); } });
  assert.deepEqual(asked.sort(), [file.cid, text.cid].sort(), 'each restored send is looked for among the drawn');
  assert.ok(!after.ob.items().some((i) => i.cid === file.cid), 'the file that landed is done: no "choose the file again"');
  assert.ok(!after.s.sent.some((x) => x.args[0].cid === file.cid), 'and not sent again');
  assert.equal(after.s.sent[0].args[0].cid, text.cid, 'what had not landed goes');
  // The same file, not drawn (the reload came before the server had it): it goes by its link, with its cid.
  const other = sessionStore();
  const up = rig({ store: other });
  up.join();
  const f2 = up.ob.hold('message', { type: 'file', url: '', filename: 'deck.pdf' }, { file: {}, upload: () => ({ url: '/uploads/2-abcdefabcdef-a.pdf', mime: 'application/pdf' }) });
  await new Promise((r) => setImmediate(r));
  up.s.drop();
  const reloaded = rig({ store: other });
  reloaded.s.connected = true;
  reloaded.ob.ready({ scope: 'hall|K7P2QX', who: 'u1', has: () => false });
  assert.deepEqual([reloaded.s.sent[0].args[0].cid, reloaded.s.sent[0].args[0].url], [f2.cid, '/uploads/2-abcdefabcdef-a.pdf']);
  // A page that faults while it answers has not drawn it: the send stays held (the server answers a repeat).
  const again = rig({ store });
  again.s.connected = true;
  again.ob.ready({ scope: 'hall|K7P2QX', who: 'u1', has: () => { throw new Error('no feed'); } });
  assert.equal(again.s.sent[0].args[0].cid, text.cid);
  assert.throws(() => again.c.advance(1), /no feed/, 'the fault is said in the page\'s console');
});

test('outbox: sent out of the hall (kicked), nothing held is sent, now or in this tab later', () => {
  const store = sessionStore();
  const t = rig({ store });
  t.ob.hold('message', { type: 'text', text: 'never' });
  t.join();
  const a = t.ob.hold('message', { type: 'text', text: 'queued behind it' });
  const late = [];
  t.ob.now('pin', { messageId: 'm1', pinned: true }, (r) => late.push(r));
  t.ob.clear();
  assert.equal(a.state, 'dropped');
  assert.deepEqual(late, [{ ok: false, error: 'Not sent: this page has left the hall.' }]);
  t.s.sent.find((x) => x.verb === 'pin').ack({ ok: true });
  assert.equal(late.length, 1, 'a page that has left the hall is told nothing more');
  assert.ok(!store.map.has(KEY), 'the tab keeps none of it');
  t.s.sent[0].ack({ ok: true, id: 'm1', seq: 1 });
  t.join();
  assert.equal(t.s.sent.filter((x) => x.verb === 'message').length, 1, 'nothing more goes');
  const after = t.ob.hold('message', { type: 'text', text: 'after' });
  assert.equal(after.state, 'refused');
  const again = rig({ store });
  again.join();
  assert.equal(again.s.sent.length, 0, 'the person back in this tab sends nothing held');
});

test('outbox now: refused at once while not joined, "No answer" after 5 s, sent again after a drop only where a repeat is answered', () => {
  const t = rig();
  const answers = [];
  const say = (r) => answers.push(r);
  t.ob.now('pin', { messageId: 'm1', pinned: true }, say);
  assert.deepEqual(answers.pop(), { ok: false, error: 'Not connected — AGMessage is reconnecting.', offline: true });
  assert.equal(t.s.sent.length, 0, 'never sent late');
  t.join();
  t.ob.now('pin', { messageId: 'm1', pinned: true }, say);
  assert.equal(t.s.sent[0].verb, 'pin');
  assert.match(t.s.sent[0].args[0].cid, CID);
  t.c.advance(5000);
  assert.deepEqual(answers.pop(), { ok: false, error: 'No answer — check the connection.' });
  // The server's own answer after that is given too, once, marked late: what it did is said, never left at "No answer".
  t.s.sent[0].ack({ ok: true });
  assert.deepEqual(answers.pop(), { ok: true, late: true });
  t.s.sent[0].ack({ ok: true });
  assert.equal(answers.length, 0, 'the server\'s answer is given once');
  // A line to the speaker's screen that Stagewatch takes 6 s to answer: "No answer" at 5 s, then its receipt.
  t.s.sent.length = 0;
  t.ob.now('stage:send', { messageId: 'm3' }, say);
  t.c.advance(5000);
  assert.deepEqual(answers.pop(), { ok: false, error: 'No answer — check the connection.' });
  t.c.advance(1000);
  t.s.sent[0].ack({ ok: true, stage: 'applied' });
  assert.deepEqual(answers.pop(), { ok: true, stage: 'applied', late: true });
  // An answer in time is given once, and the 5 s pass with nothing more.
  t.s.sent.length = 0;
  t.ob.now('pin', { messageId: 'm1', pinned: false }, say);
  t.s.sent[0].ack({ ok: true });
  t.c.advance(6000);
  assert.deepEqual(answers.splice(0), [{ ok: true }]);

  for (const [verb, args, again] of [['delete', { messageId: 'm2' }, true], ['react', { messageId: 'm2', emoji: '👍', on: true }, true], ['react', { messageId: 'm2', emoji: '👍' }, false], ['stage:send', { messageId: 'm2' }, false]]) {
    t.s.sent.length = 0;
    t.ob.now(verb, args, say);
    t.s.drop();
    if (!again) assert.deepEqual(answers.pop(), { ok: false, error: 'The connection dropped before AGMessage answered — check it was done before trying again.' }, verb);
    t.join();
    assert.equal(t.s.sent.length, again ? 2 : 1, verb + ': ' + (again ? 'sent again' : 'never sent twice'));
    if (again) {
      assert.equal(t.s.sent[1].args[0].cid, t.s.sent[0].args[0].cid, verb + ': with the same cid');
      t.s.sent[1].ack({ ok: true, already: true });
      assert.deepEqual(answers.pop(), { ok: true, already: true });
    }
  }
  // A verb that takes no arguments is sent none; a value that is not an object goes as it is.
  t.s.sent.length = 0;
  t.ob.now('admin:tunnelStop', undefined, say);
  t.ob.now('admin:settings', null, say);
  assert.deepEqual(t.s.sent.map((x) => x.args), [[], [null]]);
  assert.equal(typeof t.s.sent[0].ack, 'function');
});

test('outbox self and local: a report goes once joined, the newest per key; local is nothing on the wire', () => {
  const t = rig();
  t.ob.self('page:report', { seq: 1, state: 'minimised' }, 'take');
  t.ob.self('page:report', { seq: 1, state: 'closed' }, 'take');
  t.ob.self('page:report', { seq: 2, state: 'shown' }, 'info');
  assert.equal(t.s.sent.length, 0);
  t.join();
  assert.deepEqual(t.s.sent.map((x) => [x.verb, x.args[0].state, x.ack]), [['page:report', 'closed', null], ['page:report', 'shown', null]]);
  let ran = 0;
  t.ob.local(() => { ran++; });
  assert.equal(ran, 1);
  assert.equal(t.s.sent.length, 2);
});

// ---------------------------------------------------------------- the server's half, end to end
test('a send is said once on the server: a repeat answers what it became, after a restart and a removal too', { timeout: 60_000 }, async (t) => {
  let srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Outbox hall' }, { cookie: admin })).body.code;
  const legal = (await api(srv.base, 'POST', '/api/rooms', { name: 'Legal' }, { cookie: admin })).body.code;
  const join = async (code, name, role, uid) => { const s = await connect(srv.base); sockets.push(s); const r = await emit(s, 'join', { roomCode: code, name, role, uid }); assert.ok(r.ok, JSON.stringify(r)); return { s, r }; };
  // What a hall holds, read by a watcher seated in it: joining again on its own socket writes no line of its own, so the
  // hall's seq moves only for what the test sends.
  const watchers = new Map();
  const watch = async (code) => {
    const s = await connect(srv.base); sockets.push(s);
    const r = await emit(s, 'join', { roomCode: code, name: 'Olly ' + code, role: 'observer' });
    assert.ok(r.ok, JSON.stringify(r));
    watchers.set(code, { s, uid: r.identity });
  };
  const read = async (code) => { const w = watchers.get(code); return emit(w.s, 'join', { roomCode: code, name: 'Olly ' + code, role: 'observer', uid: w.uid }); };

  const ana = await join(hall, 'Ana', 'research');
  const cid = nodeCrypto.randomBytes(16).toString('base64url');
  await watch(hall);
  await watch(legal);

  await t.test('the same cid twice commits once and answers the same {ok, id, seq}', async () => {
    const first = await emit(ana.s, 'message', { type: 'text', text: 'Capex is on slide 14', cid, heldMs: 65_000 });
    assert.equal(first.ok, true);
    const seq = (await read(hall)).seq;
    const again = await emit(ana.s, 'message', { type: 'text', text: 'Capex is on slide 14', cid, heldMs: 70_000 });
    assert.deepEqual(again, first);
    const after = await read(hall);
    assert.equal(after.seq, seq, 'nothing committed');
    const mine = after.history.filter((m) => m.cid === cid);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].held, 65, 'the first send\'s wait, in whole seconds');
    assert.equal(mine[0].seq, first.seq);
  });

  await t.test('a repeat is answered before the rate: never "Slow down" for a send that landed', async () => {
    let busy = null;
    for (let i = 0; i < 30 && !busy; i++) { const m = await emit(ana.s, 'message', { type: 'text', text: 'flood ' + i }); if (!m.ok) busy = m; }
    assert.deepEqual(busy, { ok: false, error: 'Slow down a little.', busy: true }, 'the rate\'s refusal says it is the rate\'s');
    const again = await emit(ana.s, 'message', { type: 'text', text: 'Capex is on slide 14', cid });
    assert.equal(again.ok, true);
  });

  await t.test('a held wait under a second keeps none; a cid or a wait of the wrong shape is refused with words, and nothing is committed', async () => {
    await wait(3200);   // the bucket refills
    const quick = await emit(ana.s, 'message', { type: 'text', text: 'at once', cid: nodeCrypto.randomBytes(16).toString('base64url'), heldMs: 999 });
    assert.equal(quick.ok, true);
    assert.equal((await read(hall)).history.find((m) => m.id === quick.id).held, undefined);
    const seq = (await read(hall)).seq;
    for (const bad of [7, 'has space', 'x'.repeat(41), {}, [], '', true, 'ok/no']) {
      assert.deepEqual(await emit(ana.s, 'message', { type: 'text', text: 'x', cid: bad }), { ok: false, error: 'That message\'s id could not be read.' }, JSON.stringify(bad));
    }
    for (const bad of [-1, 1.5, 86_400_001, '5', {}, true]) {
      assert.deepEqual(await emit(ana.s, 'message', { type: 'text', text: 'x', heldMs: bad }), { ok: false, error: 'That message\'s wait could not be read.' }, JSON.stringify(bad));
    }
    assert.deepEqual(await emit(ana.s, 'forward', { messageId: 'x', targetRoom: legal, cid: 'has space' }), { ok: false, error: 'That message\'s id could not be read.' });
    assert.equal((await read(hall)).seq, seq);
    const absent = await emit(ana.s, 'message', { type: 'text', text: 'a page from before', cid: null, heldMs: null });
    assert.equal(absent.ok, true, 'absent or null, each is none: a page cached across the upgrade still sends');
  });

  let restarted = null;
  await t.test('after a restart the same cid still answers the same, and a removed one answers gone', async () => {
    const first = await emit(ana.s, 'message', { type: 'text', text: 'one to remove', cid: 'remove-me_1' });
    srv = await restartServer(srv);
    const back = await join(hall, 'Ana', 'research', ana.r.identity);
    restarted = back;
    await watch(hall);
    await watch(legal);
    const seq = (await read(hall)).seq;
    const again = await emit(back.s, 'message', { type: 'text', text: 'Capex is on slide 14', cid });
    assert.equal(again.ok, true);
    assert.equal(again.seq, (await read(hall)).history.find((m) => m.cid === cid).seq);
    assert.equal((await read(hall)).seq, seq, 'nothing committed after the restart');
    assert.deepEqual(await emit(back.s, 'delete', { messageId: first.id }), { ok: true });
    const seqDel = (await read(hall)).seq;
    assert.deepEqual(await emit(back.s, 'message', { type: 'text', text: 'one to remove', cid: 'remove-me_1' }), { ok: true, id: first.id, seq: first.seq, gone: true });
    assert.equal((await read(hall)).seq, seqDel, 'a removed send repeated commits nothing');
    assert.deepEqual(await emit(back.s, 'delete', { messageId: first.id }), { ok: true, already: true }, 'a second delete is done already');
    srv = await restartServer(srv);
    const third = await join(hall, 'Ana', 'research', ana.r.identity);
    restarted = third;
    await watch(hall);
    await watch(legal);
    assert.deepEqual(await emit(third.s, 'message', { type: 'text', text: 'one to remove', cid: 'remove-me_1' }), { ok: true, id: first.id, seq: first.seq, gone: true }, 'the tombstone outlives a restart');
    assert.deepEqual(await emit(third.s, 'delete', { messageId: first.id }), { ok: true, already: true });
    const ben = await join(hall, 'Ben', 'research');
    assert.deepEqual(await emit(ben.s, 'delete', { messageId: first.id }), { ok: false, error: 'Message not found' }, 'someone else is not told it was theirs');
    assert.equal((await emit(ben.s, 'message', { type: 'text', text: 'Ben\'s', cid })).ok, true, 'a cid is its sender\'s: the same one from another person is a send of theirs');
    assert.equal((await read(hall)).history.filter((m) => m.cid === cid).length, 2);
  });

  await t.test('react with on: true twice leaves one reaction; on: false takes it away once; without on it toggles', async () => {
    const s = restarted.s;
    const m = await emit(s, 'message', { type: 'text', text: 'react to me' });
    const reactions = async () => (await read(hall)).history.find((x) => x.id === m.id).reactions || [];
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: true }), { ok: true });
    const seq = (await read(hall)).seq;
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: true }), { ok: true, already: true });
    assert.equal((await read(hall)).seq, seq, 'a repeat commits nothing');
    assert.equal((await reactions()).length, 1);
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: false }), { ok: true });
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: false }), { ok: true, already: true });
    assert.equal((await reactions()).length, 0);
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍' }), { ok: true });
    assert.equal((await reactions()).length, 1, 'toggled on, as a page from before expects');
    assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: null }), { ok: true });
    assert.equal((await reactions()).length, 0, 'null is no on: toggled off');
    for (const bad of ['yes', 1, {}]) assert.deepEqual(await emit(s, 'react', { messageId: m.id, emoji: '👍', on: bad }), { ok: false, error: 'Say whether to add the reaction or take it away.' }, JSON.stringify(bad));
  });

  await t.test('a forward repeated with one cid writes one message into the other hall, and answers the same', async () => {
    const s = restarted.s;
    await join(legal, 'Ana', 'research', ana.r.identity);   // in both halls, as a forward asks
    const src = await emit(s, 'message', { type: 'text', text: 'to Legal' });
    const fcid = nodeCrypto.randomBytes(16).toString('base64url');
    const seq = (await read(legal)).seq;
    const first = await emit(s, 'forward', { messageId: src.id, targetRoom: legal, cid: fcid });
    assert.equal(first.ok, true, JSON.stringify(first));
    const again = await emit(s, 'forward', { messageId: src.id, targetRoom: legal, cid: fcid });
    assert.deepEqual(again, first);
    const there = await read(legal);
    assert.equal(there.seq, seq + 1, 'one message written');
    assert.equal(there.history.filter((m) => m.text === 'to Legal').length, 1);
    assert.equal(there.history.find((m) => m.id === first.id).cid, fcid);
  });

  await t.test('a forward to a code that names no hall is held to the rate: codes cannot be tried faster than a send', async () => {
    const eve = await join(hall, 'Eve', 'research');
    const said = {};
    let busy = null;
    for (let i = 0; i < 30 && !busy; i++) {
      const r = await emit(eve.s, 'forward', { messageId: 'x', targetRoom: 'ZZ' + (1000 + i), cid: nodeCrypto.randomBytes(16).toString('base64url') });
      if (r.busy) busy = r;
      else said[r.error] = (said[r.error] || 0) + 1;
    }
    assert.deepEqual(busy, { ok: false, error: 'Slow down a little.', busy: true });
    assert.ok(said['Target room not found'] <= 16 && Object.keys(said).length === 1, JSON.stringify(said));
  });

  await t.test('an answer to a help request said again is done already; the help request\'s held wait reaches the halls board', async () => {
    const s = restarted.s;
    const h = await emit(s, 'message', { type: 'help', category: 'Sound', text: 'radio mic 3', cid: nodeCrypto.randomBytes(16).toString('base64url'), heldMs: 61_000 });
    assert.equal(h.ok, true);
    const ctl = await connect(srv.base, admin); sockets.push(ctl);
    const board = await emit(ctl, 'board:watch', {});
    const item = board.board.help.find((x) => x.id === h.id);
    assert.equal(item.held, 61, 'the board reads it as written a minute before it was sent');
    assert.deepEqual(await emit(s, 'help:respond', { messageId: h.id, state: 'coming' }), { ok: true });
    const seq = (await read(hall)).seq;
    assert.deepEqual(await emit(s, 'help:respond', { messageId: h.id, state: 'coming' }), { ok: true, already: true });
    assert.equal((await read(hall)).seq, seq);
    assert.deepEqual(await emit(s, 'help:respond', { messageId: h.id, state: 'resolved' }), { ok: true });
    assert.deepEqual(await emit(s, 'help:respond', { messageId: h.id, state: 'resolved' }), { ok: true, already: true }, 'never "Already resolved" to the one who resolved it');
    const ben = await join(hall, 'Bea', 'research');
    assert.deepEqual(await emit(ben.s, 'help:respond', { messageId: h.id, state: 'resolved' }), { ok: false, error: 'Already resolved by Ana.' });
    const transcript = await (await fetch(srv.base + '/api/admin/transcript/' + hall, { headers: { cookie: admin } })).text();
    assert.match(transcript, /◷ written [^<]+, sent [^<]+ \(offline\)/, 'the transcript says it waited');
  });

  await t.test('a file whose upload the server no longer has is refused with reupload, so the page that holds it uploads it again', async () => {
    const s = restarted.s;
    const up = new FormData();
    up.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'deck.pdf');
    const token = (await emit(s, 'join', { roomCode: hall, name: 'Ana', role: 'research', uid: ana.r.identity })).uploadToken;
    const file = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: up })).json();
    assert.ok(file.url, JSON.stringify(file));
    fs.unlinkSync(path.join(srv.dataDir + '-uploads', file.url.slice(9)));
    const seq = (await read(hall)).seq;
    assert.deepEqual(await emit(s, 'message', { type: 'file', url: file.url, filename: 'deck.pdf', cid: 'file_once' }), { ok: false, error: 'That file is no longer on the AGMessage laptop: choose it again.', reupload: true });
    assert.equal((await read(hall)).seq, seq);
  });
});
