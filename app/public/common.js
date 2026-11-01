// Shared by the account pages (sign-in, halls, accounts): escaping, JSON calls, toasts, the theme. One global, AGM, which
// each shared script extends (never replaces), so no order they load in erases another's part.
// Every value shown as HTML goes through AGM.esc (the lint fence agm/no-unescaped-html holds the pages to it).
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** A JSON call to this server: {ok, …} or {ok:false, error}; never throws. */
  async function api(method, url, body) {
    try {
      const r = await fetch(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let j;
      try { j = await r.json(); } catch { j = null; }   // not JSON: the status words below
      if (j && typeof j === 'object') return { status: r.status, ...j };
      return { ok: false, status: r.status, error: r.status === 429 ? 'Too many attempts — wait a few minutes.' : 'The server answered ' + r.status + '.' };
    } catch {
      return { ok: false, status: 0, error: 'Can\'t reach AGMessage — check the network.' };
    }
  }

  /** A toast that never blocks: the words, and whether it is a problem. */
  function toast(text, bad) {
    let box = document.getElementById('agmToast');
    if (!box) { box = document.createElement('div'); box.id = 'agmToast'; box.className = 'agm-toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    box.textContent = text;
    box.classList.toggle('bad', !!bad);
    box.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => box.classList.remove('show'), bad ? 6000 : 3500);
  }

  function theme() {
    const btn = document.getElementById('themeBtn');
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      if (btn) { btn.textContent = t === 'dark' ? '☀️' : '🌙'; btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
    };
    let saved = 'light';
    try { saved = localStorage.getItem('agm.theme') || 'light'; } catch { /* storage blocked: light */ }
    apply(saved);
    if (btn) btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('agm.theme', next); } catch { /* storage blocked: this page only */ }
      apply(next);
    });
  }

  /** "2 min ago" for a time in ms. */
  function ago(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(at).toLocaleDateString();
  }

  /** mm:ss or h:mm:ss for seconds, with a sign for overtime. */
  function clock(sec) {
    if (!Number.isFinite(sec)) return '--:--';
    const neg = sec < 0;
    let s = Math.abs(Math.round(sec));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const body = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
    return (neg ? '+' : '') + body;
  }

  // ---------------------------------------------------------------- the page floor's helpers
  // A page reaches a feature newer than its floor (Safari 14.1, Chrome 84; theme-init.js) through one of these, chosen by a
  // probe, never by the user agent, and each does the same on every device that lacks it.

  // A dialog, modal: showModal() where the browser has it (Safari 15.4, Chrome 37). Elsewhere the dialog is opened as the
  // page's own: its `open` attribute set, fixed in the viewport (`.agm-dialog-open`) above a backdrop element in
  // ::backdrop's colour, the focus on its first control and kept inside it, Escape closing it (after a `cancel` event a
  // listener may refuse), the rest of the page hidden from assistive technology, and the focus given back to the opener
  // when it closes, however it closes. A browser with no <dialog> at all (below Safari 15.4) is given the dialog's
  // close(), `open` and `returnValue`, its `method="dialog"` forms' closing (which would otherwise submit to the page's
  // address) and their submit event's `submitter` (which came with it), so each page's dialog code runs one way on every
  // device.
  const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const shown = [];            // the dialogs open here, the newest last: {dlg, opener, backdrop}
  const adopted = new WeakSet();
  let hiddenHere = [];         // what this file marked aria-hidden for the newest open dialog

  /** Only the newest open dialog (and its ancestors) is left to assistive technology; what was hidden before is let be. */
  function hideAllBut(dlg) {
    for (const el of hiddenHere) el.removeAttribute('aria-hidden');
    hiddenHere = [];
    for (let n = dlg; n && n !== document.body && n.parentElement; n = n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib === n || sib.hasAttribute('aria-hidden')) continue;
        sib.setAttribute('aria-hidden', 'true');
        hiddenHere.push(sib);
      }
    }
  }
  function focusFirst(dlg) {
    const able = (el) => !el.disabled && !el.hidden && el.getClientRects().length > 0;
    const all = [...dlg.querySelectorAll('[autofocus], ' + FOCUSABLE)];
    const first = all.find((el) => el.hasAttribute('autofocus') && able(el)) || all.find(able);
    if (first) { first.focus(); return; }
    if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
    dlg.focus();
  }
  /** A dialog opened here has closed (by close(), its form, Escape): its backdrop goes and the focus goes back. */
  function closedHere(dlg) {
    const at = shown.findIndex((s) => s.dlg === dlg);
    if (at < 0) return;
    const [was] = shown.splice(at, 1);
    was.backdrop.remove();
    dlg.classList.remove('agm-dialog-open');
    hideAllBut(shown.length ? shown[shown.length - 1].dlg : null);
    if (at === shown.length && was.opener && was.opener.isConnected && typeof was.opener.focus === 'function') was.opener.focus();
  }
  /** Once per dialog opened here: its close() ends what this file began, and a browser without <dialog> gets its parts. */
  function adopt(dlg) {
    if (adopted.has(dlg)) return;
    adopted.add(dlg);
    const own = typeof dlg.close === 'function' ? dlg.close.bind(dlg) : null;   // the browser's, where it has <dialog>
    dlg.close = (value) => {
      if (!dlg.hasAttribute('open')) return;
      if (own) own(value);
      else {
        if (value !== undefined) dlg.returnValue = String(value);
        dlg.removeAttribute('open');
        dlg.dispatchEvent(new Event('close'));
      }
      closedHere(dlg);
    };
    dlg.addEventListener('close', () => closedHere(dlg));   // closed by the browser itself: a form's method="dialog"
    if (own) return;
    if (!('returnValue' in dlg)) dlg.returnValue = '';
    if (!('open' in dlg)) Object.defineProperty(dlg, 'open', { configurable: true, get: () => dlg.hasAttribute('open') });
    let pressed = null;   // the submit button last pressed in it (a click, or Enter's click on the default button)
    dlg.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], input[type="image"]') : null;
      if (b && b.form && (b.type === 'submit' || b.type === 'image')) pressed = b;
    }, true);
    dlg.addEventListener('submit', (e) => {
      if (!('submitter' in e)) Object.defineProperty(e, 'submitter', { value: pressed && pressed.form === e.target ? pressed : null });
      pressed = null;
    }, true);
    dlg.addEventListener('submit', (e) => {
      const form = e.target;
      if (e.defaultPrevented || !form || String(form.getAttribute('method') || '').toLowerCase() !== 'dialog') return;
      e.preventDefault();
      dlg.close(e.submitter && e.submitter.value !== undefined ? e.submitter.value : '');
    });
  }
  let keysHeard = false;
  function hearKeys() {
    if (keysHeard) return;
    keysHeard = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !shown.length) return;
      const { dlg } = shown[shown.length - 1];
      e.preventDefault();
      if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close();
    });
    document.addEventListener('focusin', (e) => {
      if (!shown.length) return;
      const { dlg } = shown[shown.length - 1];
      if (!dlg.contains(e.target)) focusFirst(dlg);
    });
  }
  function openDialog(dlg) {
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') { dlg.showModal(); return; }
    if (dlg.hasAttribute('open')) return;
    adopt(dlg);
    hearKeys();
    const opener = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'agm-backdrop';
    dlg.parentNode.insertBefore(backdrop, dlg);
    dlg.classList.add('agm-dialog-open');
    dlg.setAttribute('open', '');
    shown.push({ dlg, opener, backdrop });
    hideAllBut(dlg);
    focusFirst(dlg);
  }

  // The screen kept on (the Screen Wake Lock: Safari 16.4, Chrome 84, and only over HTTPS), asked when called and again each
  // time the page is shown (the browser lets the lock go while the page is hidden). `say(state)` hears each outcome:
  // {held: true}, or {held: false, why, words}, where `why` is the cause and `words` what a person does about it. A lock
  // the device takes back while the page is shown is the device's own saving, said as `battery`. Returns stop().
  const AWAKE_WORDS = Object.freeze({
    https: 'This device may sleep: open AGMessage over HTTPS.',
    settings: 'This device may sleep: set its screen to stay on in its own settings (Auto-Lock or Screen timeout).',
    battery: 'This device would not stay awake (its battery may be low): plug it in.',
  });
  function awake(say) {
    const tell = typeof say === 'function' ? say : () => {};
    const fail = (why) => tell({ held: false, why, words: AWAKE_WORDS[why] });
    let lock = null;
    let asking = false;
    let stopped = false;
    async function ask() {
      if (stopped || asking || lock || document.visibilityState !== 'visible') return;
      if (!window.isSecureContext) { fail('https'); return; }
      const wl = navigator.wakeLock;
      if (!wl || typeof wl.request !== 'function') { fail('settings'); return; }
      asking = true;
      let got = null;
      try {
        got = await wl.request('screen');
      } catch (e) {
        fail(e && e.name === 'NotAllowedError' ? 'battery' : 'settings');
        return;
      } finally { asking = false; }
      if (stopped) { got.release().catch(() => { /* already let go */ }); return; }
      lock = got;
      got.addEventListener('release', () => {
        if (lock !== got) return;
        lock = null;
        if (!stopped && document.visibilityState === 'visible') fail('battery');
      });
      tell({ held: true });
    }
    const onShown = () => { ask(); };
    document.addEventListener('visibilitychange', onShown);
    ask();
    return function stop() {
      stopped = true;
      document.removeEventListener('visibilitychange', onShown);
      if (lock) { const l = lock; lock = null; l.release().catch(() => { /* already let go */ }); }
    };
  }

  // Work when the page is idle: requestIdleCallback where it exists (Safari has none), else a timer at once. Either way
  // `fn(deadline)`'s timeRemaining() gives at most IDLE_SLICE_MS from the moment `fn` starts, by performance.now(), so a
  // chunk of work that stops when it reaches 0 stops after 8 ms on every device alike. Returns cancel().
  const IDLE_SLICE_MS = 8;
  function idle(fn) {
    const run = (given) => {
      const start = performance.now();
      fn({
        didTimeout: !!(given && given.didTimeout),
        timeRemaining: () => Math.max(0, Math.min(given ? given.timeRemaining() : IDLE_SLICE_MS, start + IDLE_SLICE_MS - performance.now())),
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run);
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(() => run(null), 0);
    return () => clearTimeout(t);
  }

  Object.assign(window.AGM = window.AGM || {}, { esc, api, toast, theme, ago, clock, openDialog, awake, idle });
})();
