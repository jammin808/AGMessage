'use strict';
// The page floor (Safari 14.1, iOS and iPadOS 14.5, Chrome 84; docs/DEVICES.md). The page's half, run as a page runs it
// (a vm with the browser's names the test gives and nothing else): theme-init.js's probe, its words and its held forms
// below the floor, and common.js's helpers for what a browser above the floor may still lack — the wake lock's outcome by
// cause and idle work's timer and slice. The fences: every page with people loads theme-init.js first and a screen's page
// none, and every page script of theirs stops below the floor before it asks the server anything or opens a socket. AGM.openDialog, which needs a document, is held by
// the browser smoke's floor legs; the stylesheet's fallbacks by test/resilience.test.js; the lint's half by
// test/lint-rules.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

// A source read as LF: a Windows checkout writes CR LF, and the fences below read lines.
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (f) => lf(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'));
const FLOOR_WORDS = 'This browser is too old for AGMessage. Update this device (iPadOS or iOS 14.5, or Chrome 84, or later), or use another.';
const plain = (v) => JSON.parse(JSON.stringify(v));   // a value from the page's realm, compared as data
const settle = () => new Promise((r) => { setImmediate(r); });

/** theme-init.js run as the head of a page runs it. `weakRef: false` is a browser below the floor. */
function themeInit({ weakRef = true, theme = 'dark', blocked = false, readyState = 'loading' } = {}) {
  const attrs = {};
  const listeners = {};
  const body = {
    children: [],
    get firstChild() { return this.children[0] || null; },
    insertBefore(node, ref) { const at = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(at, 0, node); return node; },
  };
  const document = {
    readyState,
    body,
    documentElement: { setAttribute: (k, v) => { attrs[k] = String(v); } },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    createElement: (tag) => ({ tag, className: '', text: '', appendChild(n) { this.text += n.text; return n; } }),
    createTextNode: (text) => ({ text }),
  };
  const localStorage = { getItem: (k) => { if (blocked) throw new Error('The operation is insecure.'); return k === 'agm.theme' ? theme : null; } };
  const atWindow = [];
  const ctx = vm.createContext({ document, localStorage, addEventListener: (ev, fn, capture) => { atWindow.push({ ev, fn, capture }); } });
  vm.runInContext('globalThis.window = globalThis;' + (weakRef ? '' : ' delete globalThis.WeakRef;'), ctx);
  vm.runInContext(read('theme-init.js'), ctx, { filename: 'theme-init.js' });
  return { attrs, listeners, body, atWindow, fire: (ev) => (listeners[ev] || []).forEach((f) => f()) };
}
/** A form's submit as the window hears it first: what the listener did to it. */
function submitted(listener) {
  const did = [];
  listener.fn({ preventDefault: () => did.push('preventDefault'), stopPropagation: () => did.push('stopPropagation') });
  return did.sort();
}

test('theme-init.js: above the floor the theme is set and nothing else; below it the page is marked, says so in one line and sends no form, storage or none', () => {
  const above = themeInit();
  assert.deepEqual(above.attrs, { 'data-theme': 'dark', 'data-theme-pending': '1' }, 'the saved theme, and no floor mark');
  assert.deepEqual(Object.keys(above.listeners), [], 'nothing waits for the page');
  assert.deepEqual(above.atWindow, [], 'and no form is held');
  assert.equal(above.body.children.length, 0);

  const below = themeInit({ weakRef: false });
  assert.deepEqual(below.attrs, { 'data-theme': 'dark', 'data-theme-pending': '1', 'data-floor': 'old' }, 'marked before the page paints, so the stylesheet hides the rest and each page script stops');
  assert.equal(below.body.children.length, 0, 'the words wait for the body');
  below.fire('DOMContentLoaded');
  assert.deepEqual(below.body.children.map((n) => ({ tag: n.tag, className: n.className, text: n.text })), [{ tag: 'p', className: 'agm-floor', text: FLOOR_WORDS }], 'one line, first in the body');
  // No form is sent below the floor, whether or not the stylesheet that hides it arrived: a sign-in form whose script
  // stopped would otherwise go to the page's address with its password in the URL.
  assert.deepEqual(below.atWindow.map((l) => ({ ev: l.ev, capture: l.capture })), [{ ev: 'submit', capture: true }], 'every submit heard at the window first');
  assert.deepEqual(submitted(below.atWindow[0]), ['preventDefault', 'stopPropagation'], 'and neither sent nor passed on to a page\'s handler');

  const late = themeInit({ weakRef: false, readyState: 'interactive' });
  assert.deepEqual(late.body.children.map((n) => n.text), [FLOOR_WORDS], 'run after the body is read, the words go in at once');

  const blocked = themeInit({ weakRef: false, blocked: true });
  assert.deepEqual(blocked.attrs, { 'data-floor': 'old' }, 'storage blocked: no theme, and the floor still read');
  assert.deepEqual(blocked.atWindow.map((l) => l.ev), ['submit'], 'and no form sent');
  blocked.fire('DOMContentLoaded');
  assert.deepEqual(blocked.body.children.map((n) => n.text), [FLOOR_WORDS]);
  assert.deepEqual(themeInit({ blocked: true }).attrs, {}, 'storage blocked above the floor: the page keeps its light theme');
});

/** common.js run as a page runs it, with a document, navigator, clock and timers of the test's own. */
function common({ secure = true, wakeLock, idle } = {}) {
  const heard = {};
  const document = {
    visibilityState: 'visible',
    addEventListener: (ev, fn) => { (heard[ev] = heard[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => { heard[ev] = (heard[ev] || []).filter((f) => f !== fn); },
  };
  const clock = { now: 1000, timers: [], cleared: [] };
  const globals = {
    document,
    navigator: wakeLock ? { wakeLock } : {},
    isSecureContext: secure,
    performance: { now: () => clock.now },
    setTimeout: (fn, ms) => { clock.timers.push({ fn, ms }); return clock.timers.length; },
    clearTimeout: (id) => { clock.cleared.push(id); },
    ...(idle || {}),
  };
  const ctx = vm.createContext(globals);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  return {
    AGM: ctx.AGM, document, clock,
    show(state) { document.visibilityState = state; for (const f of heard.visibilitychange || []) f(); },
    listening: () => (heard.visibilitychange || []).length,
  };
}
/** The Screen Wake Lock as a browser has it: each request takes the next outcome, a lock ('ok') or a refusal by its name. */
function wakeLock(outcomes) {
  const asked = [];
  const locks = [];
  return {
    asked, locks,
    request(type) {
      asked.push(type);
      const o = outcomes.shift() || 'ok';
      if (o !== 'ok') { const e = new Error(o); e.name = o; return Promise.reject(e); }
      const gone = [];
      const lock = {
        released: false,
        addEventListener: (ev, fn) => { if (ev === 'release') gone.push(fn); },
        release() { this.released = true; gone.forEach((f) => f()); return Promise.resolve(); },
        letGo() { this.released = true; gone.forEach((f) => f()); },   // the browser or the device takes it back
      };
      locks.push(lock);
      return Promise.resolve(lock);
    },
  };
}
const WORDS = {
  https: 'This device may sleep: open AGMessage over HTTPS.',
  settings: 'This device may sleep: set its screen to stay on in its own settings (Auto-Lock or Screen timeout).',
  battery: 'This device would not stay awake (its battery may be low): plug it in.',
};

test('AGM.awake: where the screen cannot be kept on, the cause and its words — not over HTTPS, no Wake Lock in this browser, refused by the device', async () => {
  const cases = [
    { name: 'not a secure context', opts: { secure: false, wakeLock: wakeLock(['ok']) }, why: 'https', asks: 0 },
    { name: 'no Wake Lock in this browser', opts: { secure: true }, why: 'settings', asks: 0 },
    { name: 'refused as the platform could not take it (NotAllowedError)', opts: { wakeLock: wakeLock(['NotAllowedError']) }, why: 'battery', asks: 1 },
    { name: 'refused otherwise', opts: { wakeLock: wakeLock(['AbortError']) }, why: 'settings', asks: 1 },
  ];
  for (const c of cases) {
    const page = common(c.opts);
    const said = [];
    page.AGM.awake((s) => said.push(s));
    await settle();
    assert.deepEqual(plain(said), [{ held: false, why: c.why, words: WORDS[c.why] }], c.name);
    assert.equal(c.opts.wakeLock ? c.opts.wakeLock.asked.length : 0, c.asks, c.name + ': asked the browser ' + c.asks + ' time(s)');
  }
});

test('AGM.awake: held while the page is shown, asked again each time it is shown again, a lock the device takes back said, and stop() lets it go', async () => {
  const wl = wakeLock([]);
  const page = common({ wakeLock: wl });
  const said = [];
  const stop = page.AGM.awake((s) => said.push(s));
  await settle();
  assert.deepEqual(plain(said), [{ held: true }]);
  assert.deepEqual(wl.asked, ['screen']);
  // Hidden: the browser lets the lock go, which is not a fault, and nothing is asked while hidden.
  page.show('hidden');
  wl.locks[0].letGo();
  await settle();
  assert.equal(wl.asked.length, 1, 'nothing asked while hidden');
  assert.equal(said.length, 1, 'a lock let go while hidden says nothing');
  page.show('visible');
  await settle();
  assert.equal(wl.asked.length, 2, 'shown again: asked again');
  assert.deepEqual(plain(said.slice(1)), [{ held: true }]);
  // Taken back while shown: the device's own saving.
  wl.locks[1].letGo();
  await settle();
  assert.deepEqual(plain(said.slice(2)), [{ held: false, why: 'battery', words: WORDS.battery }]);
  page.show('visible');
  await settle();
  assert.equal(wl.asked.length, 3, 'and asked again the next time the page is shown');
  stop();
  assert.equal(wl.locks[2].released, true, 'stop() lets the lock go');
  assert.equal(page.listening(), 0, 'and stops listening');
  page.show('visible');
  await settle();
  assert.equal(wl.asked.length, 3, 'nothing asked after stop()');
  assert.equal(said.length, 4, 'and nothing said: a lock let go by stop() is not a fault');

  const hidden = common({ wakeLock: wakeLock([]) });
  hidden.document.visibilityState = 'hidden';
  const quiet = [];
  hidden.AGM.awake((s) => quiet.push(s));
  await settle();
  assert.deepEqual(quiet, [], 'a page hidden when it asks waits until it is shown');
  hidden.show('visible');
  await settle();
  assert.deepEqual(plain(quiet), [{ held: true }]);
});

test('AGM.idle: a timer at once where the browser has no requestIdleCallback, the browser\'s own where it has, and either way at most an 8 ms slice', () => {
  // No requestIdleCallback (Safari): a timer at once; the slice runs from when the work starts.
  const safari = common();
  const ran = [];
  const cancel = safari.AGM.idle((d) => { ran.push(d.timeRemaining()); safari.clock.now += 5; ran.push(d.timeRemaining()); safari.clock.now += 10; ran.push(d.timeRemaining(), d.didTimeout); });
  assert.deepEqual(safari.clock.timers.map((t) => t.ms), [0], 'a timer at once');
  assert.deepEqual(ran, [], 'not run before the timer');
  safari.clock.now = 2000;
  safari.clock.timers[0].fn();
  assert.deepEqual(ran, [8, 3, 0, false], '8 ms from its start, then 3, then none left');
  cancel();
  assert.deepEqual(safari.clock.cleared, [1], 'cancel() clears its timer');

  // requestIdleCallback where it is: the browser's deadline, held to the same slice.
  const asked = [];
  const cancelled = [];
  let left = 50;
  const chrome = common({ idle: { requestIdleCallback: (fn) => { asked.push(fn); return 7; }, cancelIdleCallback: (id) => { cancelled.push(id); } } });
  const got = [];
  const stop = chrome.AGM.idle((d) => { got.push(d.timeRemaining()); left = 3; got.push(d.timeRemaining(), d.didTimeout); });
  assert.equal(asked.length, 1, 'the browser\'s own');
  assert.equal(chrome.clock.timers.length, 0, 'and no timer');
  asked[0]({ didTimeout: true, timeRemaining: () => left });
  assert.deepEqual(got, [8, 3, true], 'at most the slice, less when the browser has less');
  stop();
  assert.deepEqual(cancelled, [7], 'cancel() cancels it');
});

// The scripts of the pages with people that only define at load: each asks the server or opens a socket only when a page
// script calls it, so it needs no stop of its own. A new script on such a page is one of these, with its reason, or a page
// script held to stop below the floor before it asks anything.
const DEFINE_ONLY = {
  'common.js': 'AGM\'s helpers: AGM.api asks only when a page calls it',
  'outbox.js': 'AGM.outbox: sends only on a socket a page attaches',
  'reconnect.js': 'AGM.reconnect: acts only on a socket a page attaches',
  'audit-export.js': 'AGMAuditExport.open: asks only when a person opens Export…',
  'catalog.js': 'AGM.catalog: data and pure functions of a page\'s facts, with no socket',
  'menus.js': 'AGM.menu and AGM.ask: draw what a page gives them, and send nothing',
};
/** The first place a page script asks the server anything or opens a socket. */
const firstAsk = (src) => src.search(/\bfetch\(|\bAGM\.api\(|\bio\(|\bnew WebSocket\(|\bXMLHttpRequest\b|\bsendBeacon\(/);
test('the floor\'s fences: every page with people loads theme-init.js first and a screen\'s page loads none; every page script stops below the floor before it asks the server anything or opens a socket', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(pages, ['admin.html', 'app.html', 'display.html', 'halls.html', 'index.html', 'users.html'], 'the pages, each read below (a new page joins this list)');
  const own = new Set();
  for (const f of pages) {
    const scripts = [...read(f).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    if (f === 'display.html') { assert.ok(!scripts.includes('/theme-init.js'), 'a screen\'s page never shows the floor\'s words to an audience'); continue; }
    assert.equal(scripts[0], '/theme-init.js', f + ': theme-init.js is its first script, so the floor is read before anything else runs');
    // Socket.IO's client and the build that serves the page (/build.js) are the server's answers, not files of public/.
    for (const s of scripts.slice(1)) if (!s.startsWith('/vendor/') && s !== '/socket.io/socket.io.js' && s !== '/build.js') own.add(s.slice(1));
  }
  const stops = [];
  for (const f of [...own].sort()) {
    if (DEFINE_ONLY[f]) continue;
    const src = read(f);
    const ask = firstAsk(src);
    const stop = src.search(/document\.documentElement\.dataset\.floor === 'old'\) (?:return|throw)\b/);
    assert.ok(ask >= 0 && stop >= 0 && stop < ask, f + ': stops below the floor before it first asks the server or opens a socket');
    stops.push(f);
  }
  assert.deepEqual(stops, ['admin-plus.js', 'admin.js', 'app.js', 'halls.js', 'join.js', 'users.js'], 'the page scripts of the pages with people, each held to stop (and the rest only define: ' + JSON.stringify(DEFINE_ONLY) + ')');
  for (const f of Object.keys(DEFINE_ONLY)) assert.ok(own.has(f), f + ' is loaded by a page with people (a script no page loads leaves this list)');
  assert.equal(firstAsk('AGM.idle(() => {}); const t = fetchAll; prefetch(1);'), -1, 'the read finds a call, not a name that holds one');
  for (const f of ['public/join.js', 'public/users.js', 'public/halls.js', 'public/admin-plus.js']) {
    assert.match(lf(fs.readFileSync(path.join(ROOT, f), 'utf8')), /^\(function \(\) \{\n {2}'use strict';\n {2}if \(document\.documentElement\.dataset\.floor === 'old'\) return;/m, f + ': does nothing below the floor');
  }
  assert.match(read('admin.js'), /\(async function init\(\) \{\n {2}if \(document\.documentElement\.dataset\.floor === 'old'\) return;/, 'admin.js: its start asks nothing below the floor');
});
