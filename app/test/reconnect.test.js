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
const { ROOT, TOKEN, startServer, stopServer, api, connect, emit, wait, pageScripts } = require('./helpers');

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

// ---------------------------------------------------------------- the fence
test('every page that opens a socket opens it at the reconnection\'s pace and attaches it, and its HTML loads reconnect.js before it', () => {
  const opened = [];
  for (const file of pageScripts()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const calls = [...src.matchAll(/\bio\(([^;]*)\);/g)];
    if (!calls.length) continue;
    opened.push(file);
    // Spread into an object of the page's own: Socket.IO writes into the options it is given, and OPTIONS is frozen.
    for (const [call, args] of calls) assert.match(args, /^\{.*\.\.\.AGM\.reconnect\.OPTIONS\b.*\}$/, file + ': ' + call + ' opens a socket at the reconnection\'s pace');
    assert.equal(calls.length, [...src.matchAll(/AGM\.reconnect\.attach\(socket\b/g)].length, file + ': each socket it opens is attached');
    const html = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).filter((h) => h.includes('src="/' + path.basename(file) + '"'));
    assert.ok(html.length > 0, file + ' is loaded by a page');
    for (const h of html) {
      const at = h.indexOf('src="/reconnect.js"');
      assert.ok(at >= 0 && at < h.indexOf('src="/' + path.basename(file) + '"'), file + ': its page loads reconnect.js first');
    }
  }
  assert.deepEqual(opened.sort(), ['public/admin.js', 'public/app.js', 'public/display.js', 'public/halls.js'], 'the four pages with a socket');
  const ran = fs.readFileSync(path.join(ROOT, 'public', 'reconnect.js'), 'utf8');
  assert.ok(!/\bio\(/.test(ran), 'reconnect.js opens no socket of its own');
});
