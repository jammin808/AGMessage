'use strict';
// Pages come back by themselves. The page's half: public/reconnect.js, loaded as a page loads it (a vm with the
// browser's names and nothing else) and driven with a socket, a clock and timers of the test's own. The server's half,
// end to end: a refused connection says when to try again, and a refusal waiting cannot lift says so. The fence: every
// page that opens a socket opens it at the reconnection's pace and attaches it here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { io } = require('socket.io-client');
const { ROOT, TOKEN, startServer, stopServer, api, connect, emit, wait, until, pageScripts } = require('./helpers');

const SRC = fs.readFileSync(path.join(ROOT, 'public', 'reconnect.js'), 'utf8');

/** reconnect.js run as a page runs it, with only what `globals` gives the window. Returns the window. */
function page(globals) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(SRC, ctx, { filename: 'reconnect.js' });
  return ctx;
}

/** A clock and timers that move only when told; `lag(ms)` moves the clock without running a timer (a throttled tab). */
function clock() {
  let now = 1000;
  const timers = [];
  return {
    now: () => now,
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
    },
    lag(ms) { now += ms; },
    pending: () => timers.length,
  };
}

/** A socket as Socket.IO's client has it: connected, active (false once the server refused it), and what the page asked. */
function socket() {
  const handlers = {};
  const s = {
    connected: false,
    active: true,
    calls: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    connect() { s.calls.push('connect'); s.active = true; },
    disconnect() { s.calls.push('disconnect'); s.active = false; },
    fire(ev, ...args) { for (const f of handlers[ev] || []) f(...args); },
    up() { s.connected = true; s.active = true; s.fire('connect'); },
    drop(reason = 'transport close') { s.connected = false; s.fire('disconnect', reason); },
    /** A connection that failed: the server down (active, Socket.IO tries again), or refused by it (not active). */
    failed() { s.fire('connect_error', new Error('xhr poll error')); },
    refused(message, data) { s.active = false; s.fire('connect_error', Object.assign(new Error(message), { data })); },
  };
  return s;
}

/** One page: its reconnect on the test's clock, its socket, its strip and every state it was told of. */
function rig(opts = {}) {
  const win = page({});
  const c = clock();
  let wake = null;
  const rc = win.AGM.reconnect.create({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onWake: (fn) => { wake = fn; } });
  const s = socket();
  const strip = { textContent: '', hidden: true };
  const told = [];
  const conn = rc.attach(s, { strip, onChange: (st) => told.push(st), ...opts });
  return { win, c, s, strip, told, conn, wake: () => wake(), last: () => told[told.length - 1] };
}
const BUSY = (n) => 'Busy — trying again in ' + n + ' s.';
const DOWN = 'Reconnecting… what you write waits here until we\'re back.';

test('reconnect: the pace Socket.IO comes back at after a drop, and the wait a refusal names, as the page keeps it', () => {
  const win = page({});
  const R = win.AGM.reconnect;
  assert.deepEqual({ ...R.OPTIONS }, { reconnectionDelay: 500, reconnectionDelayMax: 2000, randomizationFactor: 0.5 });
  assert.ok(Object.isFrozen(R.OPTIONS), 'one pace for every page');
  assert.deepEqual([R.DOWN_MS, R.DOT_MS], [2000, 5000]);
  const named = (retryMs) => R.retryIn(Object.assign(new Error('x'), { data: { retryMs } }));
  assert.equal(named(2400), 2400);
  assert.equal(named(1234.6), 1235, 'whole ms');
  assert.equal(named(10), 1000, 'never under a second');
  assert.equal(named(0), 1000);
  assert.equal(named(1e9), 300000, 'never over five minutes');
  for (const odd of [undefined, null, '2000', NaN, Infinity, {}]) assert.equal(named(odd), 3000, 'a wait that is not a number: 3 s (' + String(odd) + ')');
  assert.equal(R.retryIn(new Error('no data')), 3000);
  assert.equal(R.retryIn(null), 3000);
  assert.deepEqual([R.WORDS.busy(3), R.WORDS.down, R.WORDS.dot], [BUSY(3), DOWN, 'Offline · reconnecting']);
  // Loaded after a script that made AGM, it extends it.
  const both = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis; window.AGM = { esc: 1 };', both);
  vm.runInContext(SRC, both);
  assert.equal(both.AGM.esc, 1);
  assert.equal(typeof both.AGM.reconnect.attach, 'function');
});

test('reconnect: a refused page tries again at the wait the server named, never sooner, saying so in whole seconds, and is back without a reload', () => {
  const t = rig();
  t.s.refused('Too many connections — wait a moment.', { retryMs: 2400 });
  assert.deepEqual([t.last().busy, t.last().words, t.strip.textContent, t.strip.hidden], [3, BUSY(3), BUSY(3), false], 'rounded up');
  t.c.advance(2399);
  assert.deepEqual(t.s.calls, [], 'not a millisecond before');
  t.c.advance(1);
  assert.deepEqual(t.s.calls, ['connect'], 'tried again once, at the wait');
  assert.equal(t.strip.textContent, BUSY(3), 'what it said stands while the try is out');
  t.s.refused('Too many connections — wait a moment.', { retryMs: 1000 });   // refused again: the new wait, said anew
  assert.deepEqual([t.last().busy, t.strip.textContent], [1, BUSY(1)]);
  t.c.advance(1000);
  assert.deepEqual(t.s.calls, ['connect', 'connect']);
  t.s.up();
  assert.deepEqual([t.last().back, t.last().busy, t.last().words, t.strip.hidden], [true, 0, '', true], 'back: nothing said');
  t.c.advance(10 * 60_000);
  assert.deepEqual(t.s.calls, ['connect', 'connect'], 'nothing more is tried once it is back');
  assert.equal(t.c.pending(), 0, 'and no timer is left');
});

test('reconnect: a refusal that says what it refused is said in the server\'s words, which name its wait, until the page is back', () => {
  const FULL = 'AGMessage\'s internet link is full (150 phones). Trying again in 34 s. On the venue\'s Wi-Fi there is room.';
  const t = rig({ join: true, down: true });
  t.s.refused(FULL, { retryMs: 33_400, why: 'full' });
  assert.deepEqual([t.last().busy, t.last().why, t.last().words, t.strip.textContent, t.strip.hidden], [34, 'full', FULL, FULL, false]);
  t.c.advance(2000);
  assert.equal(t.strip.textContent, FULL, 'the server\'s words stand over "Reconnecting…" while its wait runs');
  t.c.advance(31_399);
  assert.deepEqual(t.s.calls, [], 'not a millisecond before its wait');
  t.c.advance(1);
  assert.deepEqual(t.s.calls, ['connect']);
  const SHARE = 'Many phones from your network are already connected through the internet (75). Trying again in 31 s.';
  t.s.refused(SHARE, { retryMs: 30_100, why: 'share' });
  assert.deepEqual([t.last().why, t.strip.textContent], ['share', SHARE], 'refused again: the new words');
  t.c.advance(30_100);
  t.s.up(); t.conn.joined();
  assert.deepEqual([t.last().back, t.last().why, t.last().words, t.strip.hidden], [true, '', '', true], 'back: nothing said');
  // Without `why` (an older server), the page's own words; words cut at 300 characters, as text.
  const old = rig();
  old.s.refused('Too many connections — wait a moment.', { retryMs: 2000 });
  assert.deepEqual([old.last().why, old.strip.textContent], ['', BUSY(2)]);
  const long = rig();
  long.s.refused('y'.repeat(400), { retryMs: 2000, why: 'rate' });
  assert.equal(long.strip.textContent, 'y'.repeat(300));
  const odd = rig();
  odd.s.refused('Busy.', { retryMs: 2000, why: { toString: 1 } });
  assert.deepEqual([odd.last().why, odd.strip.textContent], ['', BUSY(2)], 'a `why` that is not a word is not one');
});

test('reconnect: a refusal that waiting cannot lift is said in the server\'s words and never tried again', () => {
  const t = rig({ join: true, down: true });
  t.s.refused('This AGMessage requires HTTPS — open it with https:// (see /tls).', { retry: false });
  assert.deepEqual([t.last().refused, t.last().stopped, t.last().busy, t.strip.textContent, t.strip.hidden],
    ['This AGMessage requires HTTPS — open it with https:// (see /tls).', true, 0, 'This AGMessage requires HTTPS — open it with https:// (see /tls).', false]);
  t.c.advance(10 * 60_000);
  t.wake();
  assert.deepEqual(t.s.calls, [], 'not tried again: not after a wait, not when shown again');
  assert.equal(t.last().down, false, 'and it does not say it is reconnecting');
  assert.equal(t.c.pending(), 0);
  // A refusal's words are text, cut at 300 characters; a refusal with none is said in the page's own.
  const long = rig();
  long.s.refused('x'.repeat(400), { retry: false });
  assert.equal(long.last().refused.length, 300);
  const none = rig();
  none.s.refused('', { retry: false });
  assert.equal(none.last().refused, 'AGMessage refused this connection.');
});

test('reconnect: a drop is said after 2 s in the strip and after 5 s by the dot, counted from the drop, and both go at the join\'s answer', () => {
  const t = rig({ join: true, down: true });
  t.s.up();
  assert.equal(t.last().back, false, 'connected is not back: a joining page is back at its join\'s answer');
  t.conn.joined();
  assert.equal(t.last().back, true);
  t.s.drop();
  assert.deepEqual([t.last().back, t.strip.hidden], [false, true], 'a blip is not news');
  t.c.advance(1500);
  t.s.failed();   // Socket.IO's own tries meanwhile do not start the count again
  t.c.advance(499);
  assert.equal(t.strip.hidden, true);
  t.c.advance(1);
  assert.deepEqual([t.last().down, t.last().dot, t.strip.textContent, t.strip.hidden], [true, false, DOWN, false], '2 s after the drop');
  t.c.advance(2999);
  assert.equal(t.last().dot, false);
  t.c.advance(1);
  assert.equal(t.last().dot, true, '5 s after the drop');
  t.s.up();
  assert.deepEqual([t.last().back, t.last().down, t.last().dot, t.strip.textContent], [false, true, true, DOWN], 'connected: said until the answer');
  t.conn.joined();
  assert.deepEqual([t.last().back, t.last().down, t.last().dot, t.strip.hidden], [true, false, false, true], 'the answer: all gone');
  assert.equal(t.c.pending(), 0);
});

test('reconnect: the dot is named from what is true: connecting while the join is out, connected at its answer, reconnecting while down, offline once not brought back', () => {
  const t = rig({ join: true, down: true });
  const R = t.win.AGM.reconnect;
  const named = () => [t.last().connected, t.last().back, R.dotName(t.last())];
  t.s.up();
  assert.deepEqual(named(), [true, false, 'Connecting'], 'a first load connected, its join in flight: not offline');
  t.conn.joined();
  assert.deepEqual(named(), [true, true, 'Connected']);
  t.s.drop();
  assert.deepEqual(named(), [false, false, 'Offline · reconnecting'], 'down: trying again');
  t.s.failed();
  assert.deepEqual(named(), [false, false, 'Offline · reconnecting']);
  t.s.up();
  assert.deepEqual(named(), [true, false, 'Connecting'], 'connected again, the rejoin out');
  t.conn.joined();
  t.s.drop('io server disconnect');
  assert.deepEqual(named(), [false, false, 'Offline'], 'sent away: not reconnecting, so it does not say so');
  const busy = rig({ join: true, down: true });
  busy.s.refused('Too many connections — wait a moment.', { retryMs: 2000 });
  assert.equal(R.dotName(busy.last()), 'Offline · reconnecting', 'refused for now: it tries again');
  const https = rig({ join: true, down: true });
  https.s.refused('This AGMessage requires HTTPS — open it with https:// (see /tls).', { retry: false });
  assert.equal(R.dotName(https.last()), 'Offline', 'refused for good');
});

test('reconnect: back within 2 s, nothing is said; a page without the strip\'s words says only a refusal; joined() before a connection says nothing', () => {
  const t = rig({ join: true, down: true });
  t.s.up(); t.conn.joined();
  t.s.drop();
  t.c.advance(1900);
  t.s.up();
  t.c.advance(5000);   // a slow answer: connected, so nothing more is said
  t.conn.joined();
  assert.ok(t.told.every((st) => !st.down && !st.dot && !st.words), 'never a word: ' + JSON.stringify(t.told.map((st) => st.words)));

  const quiet = rig();   // the halls board, the admin page: their own status words say a drop
  quiet.s.up();
  quiet.s.drop();
  quiet.c.advance(6000);
  assert.deepEqual([quiet.last().down, quiet.last().dot, quiet.last().words, quiet.strip.hidden], [true, true, '', true]);

  const early = rig({ join: true });
  early.conn.joined();   // the socket is not connected: a stale answer is no way back
  assert.equal(early.told.length, 0);
});

test('reconnect: shown again or back online, a page that is not connected starts afresh at once; never one that is, or that waits the server\'s pace', () => {
  const t = rig({ join: true, down: true });
  t.s.drop();
  t.wake();
  assert.deepEqual(t.s.calls, ['disconnect', 'connect'], 'its backoff cleared, a new try now');
  t.s.up(); t.conn.joined();
  t.wake();
  assert.deepEqual(t.s.calls, ['disconnect', 'connect'], 'connected: left alone');

  const b = rig();
  b.s.refused('Too many connections — wait a moment.', { retryMs: 3000 });
  b.wake();
  assert.deepEqual(b.s.calls, [], 'the server\'s wait holds');
  b.c.lag(3000);   // the tab was asleep and its timer late: the wait is over, so it tries now
  b.wake();
  assert.deepEqual(b.s.calls, ['disconnect', 'connect']);
  assert.equal(b.last().busy, 0);
  b.c.advance(10_000);
  assert.deepEqual(b.s.calls, ['disconnect', 'connect'], 'the late timer is gone: one try, not two');
});

test('reconnect: a page the server sent away, or that closed its own socket, is not brought back and says nothing of reconnecting', () => {
  for (const reason of ['io server disconnect', 'io client disconnect']) {
    const t = rig({ join: true, down: true });
    t.s.up(); t.conn.joined();
    t.s.drop(reason);
    t.c.advance(10_000);
    t.wake();
    assert.deepEqual([t.s.calls, t.last().stopped, t.last().down, t.last().dot, t.strip.hidden], [[], true, false, false, true], reason);
    // The page opens it again itself: it is live once more, and a drop after that is said as any drop.
    t.s.up(); t.conn.joined();
    assert.equal(t.last().stopped, false);
    t.s.drop();
    t.c.advance(2000);
    assert.equal(t.strip.textContent, DOWN, reason + ', then a drop');
  }
});

test('reconnect: a first load that cannot connect says so as a drop does', () => {
  const t = rig({ join: true, down: true });
  t.c.advance(2000);
  assert.deepEqual([t.last().down, t.strip.textContent], [true, DOWN]);
});

test('reconnect: the page\'s own instance hears visibilitychange to visible and online, on the window\'s timers', () => {
  const listeners = { document: {}, window: {} };
  const timers = [];
  const doc = { visibilityState: 'visible', addEventListener: (ev, fn) => { listeners.document[ev] = fn; } };
  const win = page({
    document: doc,
    addEventListener: (ev, fn) => { listeners.window[ev] = fn; },
    performance: { now: () => 5 },
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeout: () => {},
  });
  const s = socket();
  win.AGM.reconnect.attach(s, { join: true, down: true });
  assert.deepEqual(timers, [2000, 5000], 'not connected yet: the strip and the dot wait their time');
  s.drop();
  doc.visibilityState = 'hidden';
  listeners.document.visibilitychange();
  assert.deepEqual(s.calls, [], 'hidden: nothing');
  doc.visibilityState = 'visible';
  listeners.document.visibilitychange();
  assert.deepEqual(s.calls, ['disconnect', 'connect'], 'shown again');
  listeners.window.online();
  assert.deepEqual(s.calls, ['disconnect', 'connect', 'disconnect', 'connect'], 'online again');
});

// ---------------------------------------------------------------- a page on another build (the page's half)
const OURS = '0.6.0+41.abc1234';
const NEXT = '0.6.0+42.def5678';
/** A sessionStorage as a page has it, or one that throws (blocked). */
function storage(blocked = false) {
  const m = new Map();
  const no = () => { throw new Error('SecurityError: storage is blocked'); };
  return blocked ? { getItem: no, setItem: no } : { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, map: m };
}
/** One page's builds on the test's clock: its own build `mine`, its storage, and the reloads it asked for (stubbed). */
function builds({ mine = OURS, store = storage(), hidden = false } = {}) {
  const win = page({});
  const c = clock();
  const reloads = [];
  let touch = null;
  const page_ = { hidden };
  const b = win.AGM.reconnect.builds({
    mine: () => mine, storage: () => store, reload: () => reloads.push(c.now()), now: c.now, hidden: () => page_.hidden,
    onTouch: (fn) => { touch = fn; }, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  });
  return { R: win.AGM.reconnect, b, c, reloads, store, page: page_, touch: () => touch() };
}

test('builds: a page on its server\'s build does nothing; an answer without a build, or a page that does not know its own, compares nothing', () => {
  const t = builds();
  let asked = 0;
  t.b.when(() => { asked++; return true; });
  assert.equal(t.b.heard(OURS), false, 'the same build');
  for (const odd of [undefined, null, '', 41, {}, 'x'.repeat(81)]) assert.equal(t.b.heard(odd), false, 'no build in the answer: ' + String(odd));
  t.c.advance(60_000);
  assert.deepEqual([asked, t.reloads, t.c.pending()], [0, [], 0], 'never asked whether it is quiet, never reloaded, no timer');
  const unknown = builds({ mine: '' });
  unknown.b.when(() => true);
  assert.equal(unknown.b.heard(NEXT), false, 'a page whose own build is unknown (/build.js did not load) is on no other');
  unknown.c.advance(60_000);
  assert.deepEqual(unknown.reloads, []);
  assert.deepEqual(unknown.b.state(), { mine: '', server: NEXT, stale: false, reloading: false, stays: false, tried: false });
});

test('builds: a hall page told another build reloads only when quiet: connected, nothing written and unsent, no dialog, no stage document, in its hall, untouched for 5 s', () => {
  const t = builds();
  const f = { online: true, out: false, held: false, draft: false, dialog: false, document: false };
  t.b.when((x) => t.R.QUIET.hall({ ...x, ...f }));
  t.c.advance(1000);
  assert.equal(t.b.heard(NEXT), true, 'on another build');
  assert.deepEqual(t.reloads, [], 'touched 1 s ago (the page named its quiet then): not yet');
  // Each of what holds it, one at a time, at the moment it would otherwise have reloaded.
  for (const k of ['held', 'draft', 'dialog', 'document', 'out']) {
    f[k] = true;
    t.c.advance(10_000);
    assert.deepEqual(t.reloads, [], 'held by ' + k);
    f[k] = false;
    t.touch();   // the person was at it meanwhile
  }
  t.c.advance(t.R.IDLE_MS - 1);
  assert.deepEqual(t.reloads, [], 'touched under 5 s ago');
  t.c.advance(t.R.CHECK_MS);
  assert.equal(t.reloads.length, 1, 'quiet: reloaded once, at the next check');
  assert.equal(t.store.map.get(t.R.RELOADED), NEXT, 'and kept that it reloaded for that build');
  assert.deepEqual(t.b.state(), { mine: OURS, server: NEXT, stale: true, reloading: true, stays: false, tried: true });
  t.c.advance(60_000);
  assert.deepEqual([t.reloads.length, t.c.pending()], [1, 0], 'once: nothing more, no timer left');
  // A page not shown waits for nothing but what it holds.
  const away = builds({ hidden: true });
  away.b.when((x) => away.R.QUIET.hall({ ...x, ...f }));
  away.b.heard(NEXT);
  assert.equal(away.reloads.length, 1, 'not shown, nothing held: at once');
});

test('builds: a page that heard another build while connected and is quiet only once its socket is down waits until it is back: a reload never lands on a server it cannot reach', () => {
  // The hall page: held by a draft while connected; the Wi-Fi goes and the draft is cleared (sent, or taken back).
  const t = builds({ hidden: true });
  const f = { online: true, out: false, held: false, draft: true, dialog: false, document: false };
  t.b.when((x) => t.R.QUIET.hall({ ...x, ...f }));
  assert.equal(t.b.heard(NEXT), true);
  t.c.advance(10_000);
  assert.deepEqual(t.reloads, [], 'a draft');
  f.online = false;
  f.draft = false;
  t.c.advance(10 * 60_000);   // a phone locked, its page not shown: quiet in every other way, for ten minutes
  assert.deepEqual([t.reloads, t.c.pending()], [[], 1], 'not connected: no reload, and still checked');
  f.online = true;   // back, joined
  t.c.advance(t.R.CHECK_MS);
  assert.equal(t.reloads.length, 1, 'connected and quiet: reloaded at the next check');
  // The halls board alike.
  const b = builds();
  const g = { online: false, held: false, dialog: false };
  b.b.when((x) => b.R.QUIET.halls({ ...x, ...g }));
  b.b.heard(NEXT);
  b.c.advance(60_000);
  assert.deepEqual(b.reloads, [], 'the board not connected');
  g.online = true;
  b.c.advance(b.R.CHECK_MS);
  assert.equal(b.reloads.length, 1);
  // The quiet rules read the connection as they read the rest: false or missing is not connected.
  const quiet = { idleMs: 60_000, hidden: false };
  assert.deepEqual([t.R.QUIET.hall({ ...quiet }), t.R.QUIET.hall({ ...quiet, online: true }), t.R.QUIET.halls({ ...quiet }), t.R.QUIET.halls({ ...quiet, online: true })], [false, true, false, true]);
});

test('builds: a halls board reloads when connected, no answer is held and no dialog is open, untouched; the admin page only when its admin agrees, and whenever it does', () => {
  const t = builds();
  const f = { online: true, held: true, dialog: false };
  t.b.when((x) => t.R.QUIET.halls({ ...x, ...f }));
  t.b.heard(NEXT);
  t.c.advance(30_000);
  assert.deepEqual(t.reloads, [], 'an answer to a help request held');
  f.held = false; f.dialog = true;
  t.c.advance(30_000);
  assert.deepEqual(t.reloads, [], 'a dialog open');
  f.dialog = false;
  t.c.advance(t.R.CHECK_MS);
  assert.equal(t.reloads.length, 1);
  // The admin page names no quiet moment: told another build it only says so, and reloads when its admin presses Reload.
  const a = builds();
  assert.equal(a.b.heard(NEXT), true);
  a.c.advance(10 * 60_000);
  assert.deepEqual([a.reloads, a.c.pending()], [[], 0], 'never by itself');
  assert.deepEqual(a.b.state().tried, false, 'not tried yet: the strip asks for a reload when nothing typed would be lost');
  assert.equal(a.b.reload(true), true, 'the admin agreed');
  assert.equal(a.reloads.length, 1);
  assert.equal(a.b.reload(true), false, 'once: the page is going');
  // Back from that reload still on the old build (a script that did not load): it says it tried, and the admin may ask
  // again, as often as they press; by itself it would not.
  const again = builds({ store: a.store });
  again.b.heard(NEXT);
  assert.equal(again.b.state().tried, true, 'this tab reloaded for that build and is not on it');
  assert.equal(again.b.reload(false), false, 'by itself: no second reload for that build');
  assert.equal(again.b.reload(true), true, 'asked: reloaded again');
  // Storage blocked: the admin's reload still goes, though the tab cannot keep that it reloaded.
  const blocked = builds({ store: storage(true) });
  blocked.b.heard(NEXT);
  assert.deepEqual([blocked.b.state().tried, blocked.b.reload(true), blocked.reloads.length], [false, true, 1]);
  const same = builds();
  same.b.heard(OURS);
  assert.deepEqual([same.b.reload(true), same.b.reload(false)], [false, false], 'on its server\'s build there is nothing to reload for, asked or not');
  assert.deepEqual(same.reloads, []);
});

test('builds: a screen reloads between takes: at a take it has not drawn, never over the one on the air', () => {
  const t = builds();
  const { screen } = t.R.QUIET;
  assert.equal(screen({ seq: 7, drawn: 7 }), false, 'its take, again (a reconnection\'s state): drawn, stays on the air');
  assert.equal(screen({ seq: 8, drawn: 7 }), true, 'a new take: between takes');
  assert.equal(screen({ seq: 3, drawn: 0 }), true, 'nothing drawn yet');
  assert.equal(screen({ seq: undefined, drawn: 0 }), true);
  // As display.js runs it: the state that carries another build reloads only where it is a take not drawn.
  const drawnSeq = 7;
  const onState = (s) => (t.b.heard(s.build) && screen({ seq: s.seq, drawn: drawnSeq }) && t.b.reload());
  assert.equal(onState({ seq: 7, build: NEXT }), false, 'the take on the air, from the new build: drawn again, not reloaded');
  assert.deepEqual(t.reloads, []);
  t.c.advance(10 * 60_000);
  assert.deepEqual([t.reloads, t.c.pending()], [[], 0], 'no timer: a screen waits for its next take');
  assert.equal(onState({ seq: 8, build: NEXT }), true, 'the next take: reloaded in its place');
  assert.equal(t.reloads.length, 1);
});

test('builds: once per build in a tab: a reload that did not bring the build stays and says so once, as does a page whose storage is blocked; a newer build is reloaded for', () => {
  const store = storage();
  const first = builds({ store });
  first.b.when(() => true);
  first.b.heard(NEXT);
  assert.equal(first.reloads.length, 1);
  // The same tab after the reload, still on the old build (its scripts did not load): it stays, and says why once.
  const said = [];
  const again = builds({ store });
  again.b.when(() => true, { stays: (w) => said.push(w) });
  assert.equal(again.b.heard(NEXT), true, 'still on another build');
  again.c.advance(10 * 60_000);
  assert.deepEqual([again.reloads, said, again.b.state().stays, again.c.pending()], [[], [again.R.UPDATED.stays], true, 0], 'no second reload for that build');
  assert.equal(again.R.UPDATED.stays, 'AGMessage now runs another build — reload this page when you can.', 'whichever is newer: a Go back runs an older one');
  again.b.heard(NEXT);
  assert.deepEqual(said.length, 1, 'said once');
  // A build after it is a new reason: reloaded for.
  const third = '0.6.0+43.0123456';
  assert.equal(again.b.heard(third), true);
  assert.equal(again.reloads.length, 1, 'reloaded for the next build');
  assert.equal(store.map.get(again.R.RELOADED), third);
  // Storage blocked: it cannot keep that it reloaded, so it never reloads by itself.
  const blocked = builds({ store: storage(true) });
  const told = [];
  blocked.b.when(() => true, { stays: (w) => told.push(w) });
  blocked.b.heard(NEXT);
  blocked.c.advance(60_000);
  assert.deepEqual([blocked.reloads, told.length, blocked.b.reload(), blocked.b.reload(false)], [[], 1, false, false]);
});

test('builds: the page\'s own instance names the build that served it (AGM.build) as it connects, reads it when it is asked, and hears touches once a quiet moment is named', () => {
  const listened = [];
  const ctx = page({ document: { visibilityState: 'visible', addEventListener: (ev, _fn, o) => listened.push([ev, !!(o && o.capture), !!(o && o.passive)]) }, performance: { now: () => 1 }, setTimeout: () => 1, clearTimeout: () => {} });
  const R = ctx.AGM.reconnect;
  assert.deepEqual({ ...R.auth() }, { build: '' }, 'no /build.js: it names an empty build, never none (a 0.5.1 page names none)');
  vm.runInContext('window.AGM.build = ' + JSON.stringify(OURS) + ';', ctx);
  assert.deepEqual({ ...R.auth() }, { build: OURS });
  assert.deepEqual({ ...R.auth({ display: 'tok', screen: 'k', build: 'mine' }) }, { display: 'tok', screen: 'k', build: OURS }, 'a screen\'s link beside it; the page\'s build is always its own');
  assert.deepEqual(listened, [], 'nothing heard until the page names its quiet moment');
  R.build.when(() => false);
  assert.deepEqual(listened, [['keydown', true, true], ['pointerdown', true, true], ['wheel', true, true]]);
  assert.equal(R.build.heard(OURS), false);
  assert.deepEqual([R.CHECK_MS, R.IDLE_MS, R.RELOADED], [2000, 5000, 'agm.reloadedFor']);
});

// ---------------------------------------------------------------- the server's half, end to end
test('a refused connection says when to try again: within [1 s, 3 s + the bucket\'s wait], and a socket that waits it is let in', async (t) => {
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const open = () => new Promise((resolve) => {
    const s = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    s.once('connect', () => resolve({ s }));
    s.once('connect_error', (err) => resolve({ s, err }));
  });
  // 3 a second, bursts of 30, per address: 40 at once from here drain it.
  const tries = await Promise.all(Array.from({ length: 40 }, open));
  const refused = tries.filter((x) => x.err);
  assert.ok(refused.length >= 5 && tries.length - refused.length >= 30, (tries.length - refused.length) + ' let in, ' + refused.length + ' refused');
  const oneToken = Math.ceil(1000 / 3);   // the most a drained bucket waits for its next token
  for (const { s, err } of refused) {
    const ms = err.data.retryMs;
    assert.deepEqual(err.data, { retryMs: ms, why: 'rate' }, 'what it refused: the rate');
    assert.equal(err.message, 'Busy — trying again in ' + Math.ceil(ms / 1000) + ' s.', 'on the venue, the words the page says, naming the wait');
    assert.ok(Number.isInteger(ms) && ms >= 1000 && ms < 3000 + oneToken, 'retryMs ' + ms);
    assert.equal(s.active, false, 'refused: the client does not try again by itself (the page does, reconnect.js)');
  }
  assert.ok(new Set(refused.map((x) => x.err.data.retryMs)).size > 1, 'spread: not every page behind one address comes back in the same instant');
  // Counted where health reads it, in the venue's lane: never the tunnel's.
  const h = await (await fetch(srv.base + '/api/health')).json();
  assert.deepEqual([h.refused.venue.rate, h.tunnel.refused.rate, h.tunnel.places], [refused.length, 0, 0]);
  // Waited as named, the same socket is let in: the bucket holds a token by then.
  const first = refused[0];
  await wait(first.err.data.retryMs);
  const back = await new Promise((resolve) => { first.s.once('connect', () => resolve(true)); first.s.once('connect_error', (e) => resolve(e.message)); first.s.connect(); });
  assert.equal(back, true);
});

test('a refusal waiting cannot lift says so: HTTPS required, a plain connection from another machine carries retry: false', async (t) => {
  const lan = require('../lib/tls').lanAddresses()[0];
  assert.ok(lan, 'this test needs a network address that is not loopback (every CI runner and show laptop has one)');
  const srv = await startServer({ AGM_TLS: '1', HOST: '0.0.0.0' });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const login = await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN });
  const ctl = await connect(srv.base, login.cookie);
  sockets.push(ctl);
  assert.equal((await emit(ctl, 'admin:settings', { requireHttps: true })).tls.requireHttps, true);
  const err = await new Promise((resolve) => {
    const s = io('http://' + lan + ':' + srv.port, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    s.once('connect', () => resolve(null));
    s.once('connect_error', resolve);
  });
  assert.ok(err, 'refused');
  assert.deepEqual([err.message, err.data], ['This AGMessage requires HTTPS — open it with https:// (see /tls).', { retry: false }]);
  const here = await connect(srv.base);   // this laptop keeps plain HTTP
  sockets.push(here);
  assert.ok(here.connected);
});

// ---------------------------------------------------------------- another build: the server's half, end to end
test('a page and what it loads are checked with the server at every load: no-cache with their ETag, a 304 when unchanged; /build.js names the build that serves them', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const health = (await api(srv.base, 'GET', '/api/health')).body;
  const b = await fetch(srv.base + '/build.js');
  const text = await b.text();
  assert.deepEqual([b.status, b.headers.get('cache-control'), /^application\/javascript\b/.test(b.headers.get('content-type') || ''), !!b.headers.get('etag')], [200, 'no-cache', true, true]);
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(text, ctx);
  assert.equal(ctx.AGM.build, health.build, 'the build serving the page, as health says it');
  // Asked again as a browser revalidates what it keeps: its ETag, and `max-age=0` (fetch would add `no-cache` otherwise,
  // which asks the server for the whole answer).
  const revalidate = (etag) => ({ 'if-none-match': etag, 'cache-control': 'max-age=0' });
  const again = await fetch(srv.base + '/build.js', { headers: revalidate(b.headers.get('etag')) });
  assert.deepEqual([again.status, (await again.text()).length], [304, 0], 'unchanged: a 304, nothing sent');
  for (const file of ['/', '/app.html', '/app.js', '/reconnect.js', '/styles.css', '/vendor/pdf.min.mjs']) {
    const r = await fetch(srv.base + file);
    await r.arrayBuffer();
    const etag = r.headers.get('etag');
    assert.deepEqual([r.status, r.headers.get('cache-control'), !!etag], [200, 'no-cache', true], file + ': checked at every load, never cached unasked (it was cached for 5 minutes)');
    const same = await fetch(srv.base + file, { headers: revalidate(etag) });
    assert.deepEqual([same.status, (await same.arrayBuffer()).byteLength], [304, 0], file + ': unchanged, a 304');
  }
});

test('every answer a page reads its server\'s build from carries it: a hall\'s join, the halls board\'s watch, the admin page\'s settings, a screen\'s state', async (t) => {
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const build = (await api(srv.base, 'GET', '/api/health')).body.build;
  const cookie = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const { code } = (await api(srv.base, 'POST', '/api/rooms', { name: 'Builds' }, { cookie })).body;
  const ctl = await connect(srv.base, cookie);
  const guest = await connect(srv.base);
  sockets.push(ctl, guest);
  const made = await emit(ctl, 'display:create', { code, name: 'Foyer' });
  const screen = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3), build } });
  sockets.push(screen);
  const hello = await new Promise((resolve) => screen.once('display:state', resolve));
  const joined = await emit(guest, 'join', { roomCode: code, name: 'Ana', role: 'observer' });
  assert.deepEqual([joined.ok, joined.build, (await emit(ctl, 'board:watch', {})).build, (await emit(ctl, 'admin:settings', null)).build, hello.build], [true, build, build, build, build]);
});

const UPDATED = { what: 'build', words: 'AGMessage was updated — reloading.' };
const OLD_CACHE_MS = 5 * 60_000;   // 0.5.1's maxAge: how long a file it served can stay fresh in a browser
/** A socket of the test's that keeps every account:changed it is told, with when, heard from its first packet. */
function opener(srv, sockets) {
  return async (cookie, opts) => {
    const told = [];
    const at = [];
    const s = await connect(srv.base, cookie, { ...opts, on: { 'account:changed': (x) => { told.push(x); at.push(Date.now()); } } });
    sockets.push(s);
    return { s, told, at };
  };
}
const listRooms = (s) => new Promise((resolve) => s.emit('admin:listRooms', resolve));   // asked with its answer alone, as admin.js asks
const pagesRowOf = async (ctl) => (await emit(ctl, 'admin:settings', null)).laptop.facts.find((r) => r.id === 'pages');

test('until no file 0.5.1 served can still be fresh in a browser (5 minutes after the start), no 0.5.1 page is told, and This laptop says when they will be; a 0.5.1 screen is listed as a 0.5 screen; This laptop lists every page on another build', async (t) => {
  const t0 = Date.now();
  const srv = await startServer();
  const t1 = Date.now();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const cookie = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const { code } = (await api(srv.base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie })).body;
  const ctl = await connect(srv.base, cookie);
  sockets.push(ctl);
  const open = opener(srv, sockets);
  assert.deepEqual([(await pagesRowOf(ctl)).words, (await pagesRowOf(ctl)).mark], ['every open page and screen is on this build', 'ok']);

  // 0.5.1's pages back from the restart: a hall page that carries the change it last had and one that joins afresh, two
  // halls boards and two admin pages under one sign-in. Each works as ever, and none is told yet.
  const back = await open('', { build: null });
  const first = await emit(back.s, 'join', { roomCode: code, name: 'Ana', role: 'observer', since: 0 });
  const fresh = await open('', { build: null });
  const second = await emit(fresh.s, 'join', { roomCode: code, name: 'Ana', role: 'observer', uid: first.identity || first.uid });
  const boards = [await open(cookie, { build: null }), await open(cookie, { build: null })];
  for (const b of boards) assert.equal((await emit(b.s, 'board:watch', {})).ok, true);
  const admins = [await open(cookie, { build: null }), await open(cookie, { build: null })];
  for (const a of admins) assert.equal((await listRooms(a.s)).ok, true);
  // A page that names another build is never told: it reloads itself when it is quiet. One that names something that is
  // not a build is no 0.5.1 page: told nothing, and listed as such.
  const other = await open('', { build: '0.6.0-dev.40+abcdef1' });
  assert.equal((await emit(other.s, 'join', { roomCode: code, name: 'Cy', role: 'observer', since: 0 })).ok, true);
  const odd = await open('', { build: '<b>0.6</b>' });
  // A 0.5.1 screen: no reload path, so nothing is sent it; its protocol keeps working, and it is listed by name.
  const made = await emit(ctl, 'display:create', { code, name: 'Foyer' });
  const old = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(old);
  const oldTold = [];
  old.on('account:changed', (x) => oldTold.push(x));
  const state = await new Promise((resolve) => old.once('display:state', resolve));
  await wait(300);   // a tell is sent at once: anything to come has come by then
  assert.deepEqual([first.ok, second.ok, state.name], [true, true, 'Foyer']);
  assert.deepEqual([back, fresh, ...boards, ...admins, other, odd].map((x) => x.told), [[], [], [], [], [], [], [], []], 'nobody told while a 0.5.1 file may still be fresh');
  assert.deepEqual(oldTold, []);

  const row = await pagesRowOf(ctl);
  assert.equal(row.mark, 'warn');
  assert.match(row.from, /^the build each open page and screen named as it connected/);
  // The time of day they will be told: 5 minutes after the start, by the laptop's clock.
  const hm = (at) => { const d = new Date(at); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const when = (row.words.match(/each is told to reload at (\d\d:\d\d),/) || [])[1];
  assert.ok([hm(t0 + OLD_CACHE_MS), hm(t1 + OLD_CACHE_MS)].includes(when), row.words);
  assert.equal(row.words, '9 on another build · 0.5 screens: Foyer in Main hall: reload each once by hand, since a 0.5 screen does not reload by itself · '
    + '0.5 pages: 2 hall pages (Main hall: Ana ×2), 2 halls boards (the laptop\'s token ×2), 2 admin pages (the laptop\'s token ×2): each is told to reload at ' + when + ', once no 0.5 script can still be in its browser\'s cache · '
    + 'on 0.6.0-dev.40+abcdef1: 1 hall page (Main hall: Cy) reloads at a quiet moment · on a build it did not name: 1 page not yet in a hall');
  for (const s of sockets.splice(1)) s.close();
  assert.ok(await until(async () => (await pagesRowOf(ctl)).mark === 'ok', 3000), 'all gone: every open page is on this build');
});

test('once no file 0.5.1 served can still be fresh in a browser, every 0.5.1 page open then is told at once (each tab, whatever its sign-in shares), each later one as it connects, each once; never a screen or a page that names a build', async (t) => {
  const HOLD_MS = 8000;   // AGM_OLD_CACHE_MS: the 5 minutes, short for the test
  const t0 = Date.now();
  const srv = await startServer({ AGM_OLD_CACHE_MS: String(HOLD_MS) });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const cookie = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const { code } = (await api(srv.base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie })).body;
  const ctl = await connect(srv.base, cookie);
  sockets.push(ctl);
  const open = opener(srv, sockets);
  // Open before the mark: a hall page come back and one joined afresh, two boards and two admin pages under one sign-in,
  // a page not yet in a hall; beside them a page that names a build, and a 0.5.1 screen.
  const hallBack = await open('', { build: null });
  const joined = await emit(hallBack.s, 'join', { roomCode: code, name: 'Ana', role: 'observer', since: 0 });
  const hallFresh = await open('', { build: null });
  assert.equal((await emit(hallFresh.s, 'join', { roomCode: code, name: 'Ana', role: 'observer', uid: joined.identity || joined.uid })).ok, true);
  const boards = [await open(cookie, { build: null }), await open(cookie, { build: null })];
  for (const b of boards) await emit(b.s, 'board:watch', {});
  const admins = [await open(cookie, { build: null }), await open(cookie, { build: null })];
  for (const a of admins) await listRooms(a.s);
  const notYet = await open('', { build: null });
  const named = await open(cookie, { build: '0.6.0-dev.40+abcdef1' });
  await emit(named.s, 'board:watch', {});
  const made = await emit(ctl, 'display:create', { code, name: 'Foyer' });
  const screen = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(screen);
  const screenTold = [];
  screen.on('account:changed', (x) => screenTold.push(x));
  await new Promise((resolve) => screen.once('display:state', resolve));
  const early = [hallBack, hallFresh, ...boards, ...admins, notYet];
  assert.ok(Date.now() < t0 + HOLD_MS, 'all opened before the mark (the server started after t0)');
  assert.match((await pagesRowOf(ctl)).words, /: each is told to reload at \d\d:\d\d, once no 0\.5 script/, 'held until the mark');
  assert.deepEqual(early.map((x) => x.told), early.map(() => []), 'nobody told before the mark');

  // The mark: each told, once, none before it.
  assert.ok(await until(async () => early.every((x) => x.told.length > 0), HOLD_MS + 4000, 'every 0.5.1 page told'));
  const late = await open(cookie, { build: null });   // a board opened after the mark: told as it connects, before it asks anything
  assert.ok(await until(async () => late.told.length > 0, 3000, 'a page connecting after the mark told'));
  await wait(300);
  assert.deepEqual([...early, late].map((x) => x.told), [...early, late].map(() => [UPDATED]), 'each told once');
  assert.ok([...early, late].every((x) => x.at[0] >= t0 + HOLD_MS), 'none told before the mark');
  assert.deepEqual([named.told, screenTold], [[], []], 'a page that names a build, and a screen, never');
  assert.match((await pagesRowOf(ctl)).words, /0\.5 pages: .*: each was told to reload; reload by hand one that stays listed/);
});

// ---------------------------------------------------------------- the fence
test('every page that opens a socket opens it at the reconnection\'s pace, names its build and attaches it, and its HTML loads /build.js and reconnect.js before it', () => {
  const opened = [];
  for (const file of pageScripts()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const calls = [...src.matchAll(/\bio\(([^;]*)\);/g)];
    if (!calls.length) continue;
    opened.push(file);
    // Spread into an object of the page's own: Socket.IO writes into the options it is given, and OPTIONS is frozen.
    for (const [call, args] of calls) assert.match(args, /^\{.*\.\.\.AGM\.reconnect\.OPTIONS\b.*\}$/, file + ': ' + call + ' opens a socket at the reconnection\'s pace');
    // The build that served the page, named as it connects: a page that names none is read as 0.5.1's.
    for (const [call, args] of calls) assert.match(args, /\bauth: AGM\.reconnect\.auth\(/, file + ': ' + call + ' names the build that served it');
    assert.equal(calls.length, [...src.matchAll(/AGM\.reconnect\.attach\(socket\b/g)].length, file + ': each socket it opens is attached');
    const html = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).filter((h) => h.includes('src="/' + path.basename(file) + '"'));
    assert.ok(html.length > 0, file + ' is loaded by a page');
    for (const h of html) {
      const own = h.indexOf('src="/' + path.basename(file) + '"');
      for (const first of ['/build.js', '/reconnect.js']) {
        const at = h.indexOf('src="' + first + '"');
        assert.ok(at >= 0 && at < own, file + ': its page loads ' + first + ' first');
      }
    }
  }
  // Each answer a page reads its server's build from is heard: the hall's join, the board's watch, the admin page's
  // settings and a screen's state.
  const heard = (file) => (fs.readFileSync(path.join(ROOT, file), 'utf8').match(/AGM\.reconnect\.build\.heard\(/g) || []).length;
  assert.deepEqual(['public/app.js', 'public/halls.js', 'public/admin-plus.js', 'public/display.js'].map(heard), [1, 1, 1, 1]);
  assert.deepEqual(opened.sort(), ['public/admin.js', 'public/app.js', 'public/display.js', 'public/halls.js'], 'the four pages with a socket');
  const ran = fs.readFileSync(path.join(ROOT, 'public', 'reconnect.js'), 'utf8');
  assert.ok(!/\bio\(/.test(ran), 'reconnect.js opens no socket of its own');
});
