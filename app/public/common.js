// Shared by every page with people (sign-in, halls, accounts, admin, a hall): escaping, JSON calls, the one toast, the
// theme, and the page floor's helpers. One global, AGM, which each shared script extends (never replaces), so no order
// they load in erases another's part. Nothing here acts on load: a page calls what it uses.
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

  // The toast: one per page, a role=status live region, so what an act did, or why not, is said to a screen reader as it
  // is shown, and it never blocks. `badOrOpts` is whether it is a problem (true, false), or {bad, undo, undoLabel}: with
  // `undo`, a function, it carries Undo (or `undoLabel`'s words: Show it again), a button inside it, and holds for 10 s
  // while it is neither hovered nor focused, so it is there to press; a newer toast takes its place (and its Undo with it).
  const TOAST_MS = 4000;
  const TOAST_BAD_MS = 6000;
  const TOAST_UNDO_MS = 10000;
  let toastTimer = null;
  function toastBox() {
    let box = document.getElementById('agmToast');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'agmToast';
    box.className = 'agm-toast';
    box.setAttribute('role', 'status');
    const hide = () => box.classList.remove('show');
    const hold = () => clearTimeout(toastTimer);
    const go = () => { if (box.dataset.undo && !box.matches(':hover') && !box.contains(document.activeElement)) { clearTimeout(toastTimer); toastTimer = setTimeout(hide, TOAST_UNDO_MS); } };
    box.addEventListener('pointerenter', hold);
    box.addEventListener('focusin', hold);
    box.addEventListener('pointerleave', go);
    box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget)) go(); });
    document.body.appendChild(box);
    return box;
  }
  function toast(text, badOrOpts) {
    const o = badOrOpts && typeof badOrOpts === 'object' ? badOrOpts : { bad: !!badOrOpts };
    const box = toastBox();
    box.textContent = String(text == null ? '' : text);
    const undo = typeof o.undo === 'function' ? o.undo : null;
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-undo';
      b.textContent = typeof o.undoLabel === 'string' && o.undoLabel ? o.undoLabel : 'Undo';
      b.addEventListener('click', () => { clearTimeout(toastTimer); box.classList.remove('show'); delete box.dataset.undo; undo(); });
      box.append(' · ', b);
      box.dataset.undo = '1';
    } else delete box.dataset.undo;
    box.classList.toggle('bad', !!o.bad);
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), undo ? TOAST_UNDO_MS : o.bad ? TOAST_BAD_MS : TOAST_MS);
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

  // The one table of marks: every status a page draws (a take, a help request, a screen, a link, a send held or refused, the
  // connection, the countdown) is one of these, and each mark has one meaning, a colour role (styles.css's --c-<role>) and
  // its word beside it, never the colour alone. lib/pages.js and lib/displays.js draw the same marks on the server, and
  // test/modules.test.js holds them to this table by name; no act's icon is a mark (test/catalog.test.js), and no page
  // script writes a mark of its own (eslint.config.mjs). `unseen` is reached but not seen into: a web page opened, which
  // AGMessage cannot see inside, and the audit log's entries accepted on this laptop, which it cannot check under its key.
  const MARKS = Object.freeze({
    ok: Object.freeze({ mark: '✓', role: 'ok', means: 'showing, resolved, on screen' }),
    partly: Object.freeze({ mark: '◐', role: 'warn', means: 'not fully seen: out of view, under a quote, held under blank' }),
    unseen: Object.freeze({ mark: '◇', role: 'info', means: 'reached, but not seen into: a web page opened' }),
    minimised: Object.freeze({ mark: '▭', role: 'info', means: 'minimised' }),
    off: Object.freeze({ mark: '○', role: 'off', means: 'back to chat, taken down, off' }),
    withdrawn: Object.freeze({ mark: '⊘', role: 'info', means: 'withdrawn' }),
    waiting: Object.freeze({ mark: '◷', role: 'info', means: 'sending, waiting' }),
    couldNot: Object.freeze({ mark: '△', role: 'warn', means: 'could not' }),
    fault: Object.freeze({ mark: '✕', role: 'fault', means: 'none, or a fault' }),
    urgent: Object.freeze({ mark: '■', role: 'fault', means: 'waiting for someone, urgent' }),
    coming: Object.freeze({ mark: '▶', role: 'info', means: 'on the way' }),
    note: Object.freeze({ mark: '●', role: 'info', means: 'a note' }),
    soon: Object.freeze({ mark: '▲', role: 'warn', means: 'soon' }),
  });
  /** The table's entry by its own name (never one it inherits, `toString`); a name that is none throws. */
  function entryOf(name) {
    if (!Object.prototype.hasOwnProperty.call(MARKS, name)) throw new Error('No mark is named ' + name);
    return MARKS[name];
  }
  /** A mark of the table by its name; a name that is none is a fault in the page, never a mark made up. */
  function mark(name) {
    return entryOf(name).mark;
  }
  /** The name of the table's mark a server's status carries (a screen's), or '' for one that is none of them. */
  function markOf(glyph) {
    for (const name of Object.keys(MARKS)) if (MARKS[name].mark === glyph) return name;
    return '';
  }
  /**
   * One status chip: `el` drawn with the mark named `name` (aria-hidden: its word says it) and its colour role, and, when
   * `words` is given, its words after it. `name` '' is a chip at rest: no mark and no colour of its own. The chip keeps the
   * rest of what it holds (a countdown's digits); it is drawn again only where it changed.
   */
  function chip(el, name, words) {
    if (!el) return el;
    const m = name ? entryOf(name) : null;
    let markEl = el.querySelector(':scope > .chip-mark');
    if (!markEl) {
      markEl = document.createElement('span');
      markEl.className = 'chip-mark';
      markEl.setAttribute('aria-hidden', 'true');
      el.insertBefore(markEl, el.firstChild);
    }
    // The space after the mark keeps the chip's words apart where its text is read whole (a copy, its textContent).
    const glyph = m ? m.mark + ' ' : '';
    if (markEl.textContent !== glyph) markEl.textContent = glyph;
    markEl.hidden = !glyph;
    if (m) { el.dataset.mark = name; el.dataset.tone = m.role; } else { delete el.dataset.mark; delete el.dataset.tone; }
    if (words !== undefined) {
      let w = el.querySelector(':scope > .chip-words');
      if (!w) { w = document.createElement('span'); w.className = 'chip-words'; el.appendChild(w); }
      const text = String(words);
      if (w.textContent !== text) w.textContent = text;
    }
    return el;
  }
  /**
   * A line that says a status (a show-desk request's, a send to the speaker's screen, a help request's): its words, which
   * start with a mark of the table and a space, and its colour that mark's role (`data-tone`, styles.css `.toned`), never a
   * colour of the line's own state, so a mark draws in one colour on every line and page. Words with no mark of the table
   * first are a line at rest, in its ordinary ink.
   */
  function toned(el, text) {
    if (!el) return el;
    const t = String(text);
    if (el.textContent !== t) el.textContent = t;
    const name = markOf(t.split(' ', 1)[0]);
    el.classList.add('toned');
    if (name) el.dataset.tone = MARKS[name].role; else delete el.dataset.tone;
    return el;
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
  const shown = [];            // the openings not ended yet, the newest last: {dlg, opener, backdrop}
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
  /** The opening of `dlg` here that has not ended yet, if any. */
  const openingOf = (dlg) => shown.find((s) => s.dlg === dlg);
  /**
   * An opening has ended (by close(), its form, Escape): its backdrop goes and the focus goes back. Each opening ends once,
   * and only its own end ends it: a later opening of the same dialog is another, which an earlier one's end never touches.
   * Answers whether it ended now.
   */
  function ended(was) {
    const at = shown.indexOf(was);
    if (at < 0) return false;
    shown.splice(at, 1);
    was.backdrop.remove();
    was.dlg.classList.remove('agm-dialog-open');
    hideAllBut(shown.length ? shown[shown.length - 1].dlg : null);
    if (at === shown.length && was.opener && was.opener.isConnected && typeof was.opener.focus === 'function') was.opener.focus();
    return true;
  }
  /** Once per dialog opened here: its close() ends what this file began, and a browser without <dialog> gets its parts. */
  function adopt(dlg) {
    if (adopted.has(dlg)) return;
    adopted.add(dlg);
    const own = typeof dlg.close === 'function' ? dlg.close.bind(dlg) : null;   // the browser's, where it has <dialog>
    dlg.close = (value) => {
      if (!dlg.hasAttribute('open')) return;
      const was = openingOf(dlg);
      if (own) own(value);   // the browser's close event comes in a later task
      else {
        if (value !== undefined) dlg.returnValue = String(value);
        dlg.removeAttribute('open');
      }
      ended(was);
      if (!own) dlg.dispatchEvent(new Event('close'));
    };
    // Closed by the browser itself (a form's method="dialog"), the opening ends at its close event. The browser's close
    // event comes in a later task, so one that finds the dialog open again is an earlier opening's, already ended (by
    // close(), or by the openDialog that opened it again), and ends nothing.
    dlg.addEventListener('close', () => { if (!dlg.hasAttribute('open')) ended(openingOf(dlg)); });
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
    let opener = document.activeElement;
    // Closed by the browser itself with its close event still to come: that opening ends here, as its event would end it,
    // before this one begins. A focus left inside the closed dialog, or on none, is no opener: where that opening gave the
    // focus back is, as it would be had its event come first.
    if (ended(openingOf(dlg)) && (!opener || opener === document.body || dlg.contains(opener))) opener = document.activeElement;
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

  Object.assign(window.AGM = window.AGM || {}, { esc, api, toast, theme, ago, clock, openDialog, awake, idle, MARKS, mark, markOf, chip, toned });
})();
