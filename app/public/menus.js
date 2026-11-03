// Menus and asks in place (AGM.menu, AGM.ask): what a page draws for the catalogue's items (catalog.js) and the questions
// an act asks before it runs, without a native dialog, which pauses the page's scripts and drops its socket.
//
// AGM.menu(items, at, opts) is a WAI-ARIA menu: role=menu with menuitem, menuitemcheckbox and menuitemradio. The focus goes
// to its first enabled item; ↑ and ↓ wrap, Home and End and a typed letter move; Enter and Space choose; → opens a
// submenu and ← closes it; Escape closes and gives the focus back to the opener; Tab leaves. A disabled item stays
// focusable and says why on its second line, and choosing it says why again and does nothing. While a menu is open its
// items and their order stay as they were (update() changes only their words and states, and an item no longer offered
// turns disabled), so nothing moves under the pointer. A submenu flies out with a fine pointer (on a click, Enter, →, or
// a hover of 200 ms) and drills in, in the same panel with a "‹ Back" row, with a coarse one; at 480 px or less with a
// coarse pointer the menu is a sheet at the bottom of the screen.
//
// A menu and an ask are placed in the top layer where the popover API is, so they draw over every panel and dialog; a
// dialog open with showModal() makes everything outside it inert, so one opened from inside such a dialog is mounted in
// it. Elsewhere they are fixed at the menu's layer (--z-menu). Escape inside either never reaches a dialog around it.
// A menu opened from a button (its ⋯, or the object for a key) sits under it or above it, never over it: where it fits
// on neither side it takes the side with more room and scrolls (spot()). While it is open nothing moves under it: its
// opener is held where it was as the page changes around it, and where it cannot be held the menu follows it (keep()),
// so pressing the ⋯ again always reaches the ⋯ and closes the menu.
//
// AGM.menu.door(container, find) is the one place a page hears `contextmenu` (and Shift+F10 or the menu key): a
// right-click, the keys and the object's ⋯ open the same menu. The browser keeps its own menu in a field, on a text
// selection inside the object, on a link (but an object's own link, which takes the object's menu), and always with
// Shift+right-click.
//
// AGM.roving(list, {item, start, skip}) makes a list's objects one tab stop, moved through with the arrows, Home and End. AGM.acts
// is a page's runner of the catalogue's acts: what each act does is the page's (its runners), and the rest — the bar, the
// ⋯, a key, right-click and Shift+F10, the ask before an act, an open menu kept in step — is the same on every page.
//
// AGM.ask(anchor, spec) is a non-modal role=dialog anchored to the object, labelled by its title, naming the object and
// what follows; its buttons are verbs, the focus starts on the safe one (or the first field), and Escape, a tap outside it
// and the focus moved away are its "no". One is open at a time: opening another answers the first "no". It answers a
// promise: {yes, values}, and with more than one way to say yes (`choices`), which (`choice`).
(function () {
  'use strict';

  const SUB_HOVER_MS = 200;
  const MARGIN = 8;
  let open = null;      // the open menu: {root, panels: [panel…], opener, anchor, at (its place: {x, y} or {anchor}), opts, handle, stop}
  let asking = null;    // the open ask: {box, anchor, finish}
  let seq = 0;

  const coarse = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const asSheet = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px) and (pointer: coarse)').matches;
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  /** Where a menu or an ask opened from `anchor` lives: inside the open modal dialog that holds it, else the body. */
  const mountFor = (anchor) => (anchor && anchor.closest && anchor.closest('dialog[open]')) || document.body;
  function mount(el, anchor) {
    mountFor(anchor).appendChild(el);
    if (typeof el.showPopover === 'function') { el.setAttribute('popover', 'manual'); el.showPopover(); }
  }
  function unmount(el) {
    if (typeof el.hidePopover === 'function' && el.matches && el.matches(':popover-open')) { try { el.hidePopover(); } catch { /* already hidden */ } }
    el.remove();
  }
  /**
   * Where a panel of `size` {w, h} goes in a viewport `view` {w, h}: the rule, apart from the page (pure). `at` is {x, y},
   * a pointer: at it + 2 px, flipped where it does not fit; {under: rect}, the button it opened from: under its
   * bottom-left, else above it, and where it fits on neither side, on the side with more room, cut to that room (a menu
   * scrolls), so a menu never covers the button that opened it and pressing that button again closes it, as a browser's
   * own drop-down is placed; or {beside: rect}, a submenu: beside its row, flipped to the other side. Kept 8 px inside.
   * `whole`: never cut (an ask, which does not scroll), kept inside instead. Answers {x, y, h}: `h` the height it is cut
   * to, or null where it is drawn whole.
   */
  function spot(at, size, view, { whole = false } = {}) {
    const { w, h } = size;
    let x, y, cut = null;
    if (at.beside) {
      const r = at.beside;
      x = r.right - 2; y = r.top;
      if (x + w > view.w - MARGIN) x = r.left - w + 2;
    } else if (at.under) {
      const r = at.under;
      const below = view.h - MARGIN - (r.bottom + 2), above = r.top - 2 - MARGIN;
      x = r.left;
      if (h <= below) y = r.bottom + 2;
      else if (h <= above) y = r.top - 2 - h;
      else if (!whole && Math.max(below, above) > 0) {
        cut = Math.max(below, above);
        y = below >= above ? r.bottom + 2 : r.top - 2 - cut;
      } else y = r.top - 2 - h;
    } else {
      x = at.x + 2; y = at.y + 2;
      if (x + w > view.w - MARGIN) x = at.x - w - 2;
      if (y + h > view.h - MARGIN) y = at.y - h - 2;
    }
    x = Math.max(MARGIN, Math.min(x, view.w - w - MARGIN));
    if (cut === null) y = Math.max(MARGIN, Math.min(y, view.h - h - MARGIN));
    return { x: Math.round(x), y: Math.round(y), h: cut === null ? null : Math.floor(cut) };
  }
  /** Fixed in the viewport where spot() says for its whole height: `at` {x, y}, {anchor: element} or {beside: element}. */
  function place(el, at, opts) {
    el.style.maxHeight = '';
    const where = at && at.beside ? { beside: at.beside.getBoundingClientRect() }
      : at && at.anchor ? { under: at.anchor.getBoundingClientRect() } : { x: at ? at.x : 0, y: at ? at.y : 0 };
    const view = { w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight };
    const w = el.offsetWidth;
    const s = spot(where, { w, h: el.offsetHeight }, view, opts);
    el.style.left = s.x + 'px';
    el.style.top = s.y + 'px';
    if (s.h === null) return;
    el.style.maxHeight = s.h + 'px';
    // Cut, it scrolls, and a scrollbar that takes room widens it: kept inside at that width.
    if (el.offsetWidth > w) el.style.left = Math.max(MARGIN, Math.min(s.x, view.w - el.offsetWidth - MARGIN)) + 'px';
  }

  // ---------------------------------------------------------------- a row
  /** A row of a panel: a button with the item's role, label, mark of state, reason and key. */
  function row(item, panel) {
    const b = make('button', 'agm-mi');
    b.type = 'button';
    b.tabIndex = -1;
    const icon = make('span', 'mi-icon');
    icon.setAttribute('aria-hidden', 'true');
    const text = make('span', 'mi-text');
    const label = make('span', 'mi-label');
    const why = make('span', 'mi-why');
    why.id = 'agm-mi-' + (++seq);
    text.append(label, why);
    const key = make('span', 'mi-key');
    key.setAttribute('aria-hidden', 'true');
    b.append(icon, text, key);
    if (item.submenu) {
      const more = make('span', 'mi-more', '▸');
      more.setAttribute('aria-hidden', 'true');
      b.appendChild(more);
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
    }
    const r = { el: b, item, panel, parts: { icon, label, why, key } };
    draw(r, item);
    b.addEventListener('click', (e) => { e.preventDefault(); choose(r, { keyboard: e.detail === 0 }); });
    b.addEventListener('pointerenter', () => hover(r));
    return r;
  }
  /** A named key as a menu shows it beside its item (as keyboards print it). */
  const KEY_WORDS = { Escape: 'Esc' };
  /** A row says what its item says now: its words, its state and why it cannot run. Its place never changes. */
  function draw(r, item) {
    r.item = item;
    const b = r.el;
    if (item.id) b.dataset.action = item.id; else delete b.dataset.action;
    if (item.fold) { b.dataset.fold = item.fold; b.dataset.children = (item.children || []).map((c) => c.id).join(' '); }
    if (item.value !== undefined) b.dataset.value = String(item.value);
    const role = item.role || 'menuitem';
    b.setAttribute('role', role);
    if (role !== 'menuitem') b.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    r.parts.icon.textContent = item.icon || '';
    r.parts.label.textContent = item.label;
    b.setAttribute('aria-label', item.label);
    r.parts.key.textContent = KEY_WORDS[item.key] || item.key || '';
    // A disabled item says why on its second line; a row that is its own reason ("Looking…") says it once.
    const why = item.disabled && item.disabled !== item.label ? item.disabled : item.held || '';
    r.parts.why.textContent = why;
    r.parts.why.hidden = !why;
    if (why) b.setAttribute('aria-describedby', r.parts.why.id); else b.removeAttribute('aria-describedby');
    if (item.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    b.classList.toggle('held', !!item.held);
    b.classList.toggle('danger', item.group === '9_danger');
  }

  // ---------------------------------------------------------------- a panel
  /** A menu's name says what it acts on: "Message actions: Message from Kim · 14:02". */
  const nameOf = (label, header) => (label || 'Actions') + (header ? ': ' + header : '');
  function panelOf(list, { label, header, sub, back } = {}) {
    const el = make('div', 'agm-menu' + (sub ? ' agm-sub' : '') + (asSheet() ? ' sheet' : ''));
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', nameOf(label, header));
    el.tabIndex = -1;
    const p = { el, rows: [], parentRow: null, timer: null, child: null };
    if (header) {
      const h = make('div', 'agm-menu-head', header);
      h.setAttribute('aria-hidden', 'true');
      el.appendChild(h);
      p.head = h;
    }
    if (back) {
      const r = row({ id: '', label: '‹ Back', icon: '', key: '' }, p);
      r.back = true;
      r.el.classList.add('mi-back');
      el.appendChild(r.el);
      p.rows.push(r);
    }
    fill(p, list);
    el.addEventListener('keydown', (e) => keys(p, e));
    // The browser's own menu never opens over this one (on Windows the menu key's own event follows its keyup here).
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // The pointer on its way from a row into its submenu keeps the submenu open.
    el.addEventListener('pointerenter', () => { if (p.parentRow) clearTimeout(p.parentRow.panel.timer); });
    return p;
  }
  function fill(p, list) {
    for (const item of list) {
      if (item.sep) { const s = make('div', 'agm-sep'); s.setAttribute('role', 'separator'); p.el.appendChild(s); continue; }
      const r = row(item, p);
      p.el.appendChild(r.el);
      p.rows.push(r);
    }
  }
  const usable = (r) => !r.item.disabled;
  function focusRow(p, r) { if (r) r.el.focus(); }
  function firstUsable(p) { return p.rows.find((r) => !r.back && usable(r)) || p.rows.find((r) => !r.back) || p.rows[0]; }

  function keys(p, e) {
    const at = p.rows.findIndex((r) => r.el === document.activeElement);
    const n = p.rows.length;
    const move = (i) => { e.preventDefault(); focusRow(p, p.rows[(i + n) % n]); };
    switch (e.key) {
      case 'ArrowDown': move(at < 0 ? 0 : at + 1); return;
      case 'ArrowUp': move(at < 0 ? n - 1 : at - 1); return;
      case 'Home': move(0); return;
      case 'End': move(n - 1); return;
      case 'ArrowRight': {
        const r = p.rows[at];
        if (r && r.item.submenu && !r.item.disabled) { e.preventDefault(); openSub(r, { focus: true }); }
        return;
      }
      case 'ArrowLeft':
        if (p.parentRow) { e.preventDefault(); closeSub(p.parentRow.panel, true); }
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (p.parentRow) closeSub(p.parentRow.panel, true);
        else close(true);
        return;
      case 'Tab':
        close(true);   // the focus goes back to the opener, and Tab moves on from there
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          for (let i = 1; i <= n; i++) {
            const r = p.rows[(Math.max(at, 0) + i) % n];
            if (r.item.label.trim().toLowerCase().startsWith(k)) { e.preventDefault(); focusRow(p, r); return; }
          }
        }
    }
  }

  // ---------------------------------------------------------------- choosing
  function choose(r, { keyboard } = {}) {
    if (!open) return;
    if (r.back) { closeSub(r.panel.parentRow.panel, true); return; }
    const item = r.item;
    if (item.disabled) { open.opts.onDisabled(item.disabled, item); r.el.focus(); return; }
    if (item.submenu) { openSub(r, { focus: true, keyboard, toggle: true }); return; }
    const parent = r.panel.parentRow ? r.panel.parentRow.item : null;
    const opts = open.opts;
    // A value of a submenu (a reaction, an answer, a room) is its parent's act with that value; a fold's entry is its own.
    const id = item.id || (parent ? parent.id : '');
    const value = item.value;
    close(!item.asks);
    opts.onPick(id, value, item);
  }
  function hover(r) {
    const p = r.panel;
    clearTimeout(p.timer);
    if (coarse() || r.back) return;
    if (r.item.submenu && !r.item.disabled) {
      if (!(p.child && p.child.parentRow === r)) p.timer = setTimeout(() => openSub(r, { focus: false }), SUB_HOVER_MS);
    } else if (p.child) p.timer = setTimeout(() => closeSub(p, false), SUB_HOVER_MS);
  }

  /** The submenu of a row: a fold's entries, or the values the page gives (`opts.submenu`, which may answer later). */
  function openSub(r, { focus, toggle } = {}) {
    const p = r.panel;
    clearTimeout(p.timer);
    if (p.child && p.child.parentRow === r) {
      if (toggle) { closeSub(p, true); return; }
      if (focus) focusRow(p.child, firstUsable(p.child));
      return;
    }
    closeSub(p, false);
    const drill = coarse() || r.panel.el.classList.contains('sheet');
    const list = r.item.children || open.opts.submenu(r.item);
    const loading = !!list && typeof list.then === 'function';
    const first = loading ? [{ id: '', label: 'Looking…', disabled: 'Looking…', icon: '' }] : (list || []);
    if (!loading && !first.length) return;
    const sub = panelOf(first, { label: r.item.label, sub: true, back: drill });
    sub.parentRow = r;
    p.child = sub;
    r.el.setAttribute('aria-expanded', 'true');
    if (drill) {
      // In the same panel: its rows give way to the submenu's until ‹ Back.
      sub.el.classList.add('drill');
      p.el.hidden = true;
      mount(sub.el, open.anchor);
      placeDrill(sub, p);
    } else {
      mount(sub.el, open.anchor);
      placePanel(sub);
    }
    open.panels.push(sub);
    if (focus) focusRow(sub, firstUsable(sub));
    if (loading) {
      list.then((later) => {
        if (!open || p.child !== sub) return;
        for (const old of sub.rows.filter((x) => !x.back)) old.el.remove();
        sub.rows = sub.rows.filter((x) => x.back);
        fill(sub, Array.isArray(later) && later.length ? later : []);
        if (drill) placeDrill(sub, p); else placePanel(sub);
        if (sub.el.contains(document.activeElement) || document.activeElement === document.body) focusRow(sub, firstUsable(sub));
      });
    }
  }
  function placeDrill(sub, p) {
    if (p.el.classList.contains('sheet')) { sub.el.classList.add('sheet'); return; }
    placePanel(sub);
  }
  function closeSub(p, focusBack) {
    clearTimeout(p.timer);
    const sub = p.child;
    if (!sub) return;
    closeSub(sub, false);
    p.child = null;
    unmount(sub.el);
    if (open) open.panels = open.panels.filter((x) => x !== sub);
    sub.parentRow.el.setAttribute('aria-expanded', 'false');
    p.el.hidden = false;
    if (open && sub.el.classList.contains('drill')) placePanel(p);   // shown again where the menu's place is now
    if (focusBack) sub.parentRow.el.focus();
  }

  // ---------------------------------------------------------------- where the panels are
  /** What a panel is placed against: the menu's place (`open.at`) for its first panel and one drilled into, its row for a submenu that flies out. */
  const targetOf = (q) => (q.parentRow && !q.el.classList.contains('drill') ? { beside: q.parentRow.el } : open.at);
  /** What a panel's place is found from: where its target is now, and its own size (its rows, uncut). */
  function keyOf(q) {
    const t = targetOf(q);
    const n = t.beside || t.anchor;
    const r = n ? n.getBoundingClientRect() : { left: t.x, top: t.y, right: t.x, bottom: t.y };
    return [r.left, r.top, r.right, r.bottom].map(Math.round).concat(q.el.offsetWidth, q.el.scrollHeight).join(' ');
  }
  /** A panel placed by the rule (a sheet keeps its own place, at the bottom of the screen). */
  function placePanel(q) {
    if (q.el.classList.contains('sheet')) return;
    place(q.el, targetOf(q));
    q.key = keyOf(q);
  }
  /** Scroll `boxes` (what holds `node`, nearest first, the page last) until its top is back at `top`; a box that does not scroll it is left as it was. */
  function holdStill(node, top, boxes) {
    const off = () => node.getBoundingClientRect().top - top;
    for (const box of boxes) {
      const dy = off();
      if (Math.abs(dy) < 1) return;
      if (box !== document.scrollingElement && !/^(auto|scroll|overlay)$/.test(getComputedStyle(box).overflowY)) continue;
      const before = box.scrollTop;
      box.scrollTop = before + dy;
      if (Math.abs(off() - dy) < 0.5) box.scrollTop = before;
    }
  }
  /**
   * While a menu is open nothing moves under it. Its opener (the ⋯, or the object) stays where it was on the screen: a
   * change of the page around it (a line drawn into a message above it, a strip shown above its list, an image drawn late)
   * is taken up by scrolling what holds it, as the reader's place is kept. Where it cannot be held so (nothing left to
   * scroll), and when something is scrolled (the reader turning the wheel over the page), the menu follows it; a panel
   * whose rows change size is placed again by the rule. So the button that opened a menu is never under it, and pressing
   * it again closes it. Answers the stop.
   */
  function keep(m) {
    const held = m.at.anchor || m.opener;
    if (!held || typeof MutationObserver !== 'function') return () => {};
    const boxes = [];
    for (let n = held.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) boxes.push(n);
    if (document.scrollingElement) boxes.push(document.scrollingElement);
    const moved = (a, b) => Math.abs(a.top - b.top) >= 1 || Math.abs(a.left - b.left) >= 1;
    let was = held.getBoundingClientRect();
    const check = (scrolled) => {
      if (open !== m || !held.isConnected) return;
      if (!scrolled && moved(held.getBoundingClientRect(), was)) holdStill(held, was.top, boxes);
      const now = held.getBoundingClientRect();
      if (moved(now, was)) {
        if (!m.at.anchor) m.at = { x: m.at.x + now.left - was.left, y: m.at.y + now.top - was.top };
        was = now;
      }
      for (const q of m.panels) if (!q.el.hidden && !q.el.classList.contains('sheet') && q.key !== keyOf(q)) placePanel(q);
    };
    const changed = () => check(false);
    const scrolled = () => check(true);
    const watch = new MutationObserver(changed);
    watch.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('scroll', scrolled, true);   // a scroll of any box
    document.addEventListener('load', changed, true);      // an image drawn late
    window.addEventListener('resize', changed);
    return () => {
      watch.disconnect();
      document.removeEventListener('scroll', scrolled, true);
      document.removeEventListener('load', changed, true);
      window.removeEventListener('resize', changed);
    };
  }

  // ---------------------------------------------------------------- the menu
  /**
   * Open a menu of `items` at `at` ({x, y} for a pointer, {anchor} for a key or the ⋯). `opts`: `label` (its name),
   * `header` (a line naming the object, not focusable), `opener` (the focus goes back there), `onPick(id, value, item)`,
   * `onDisabled(words, item)`, `submenu(item)` (the values one level down: a list, or a promise of one), `onClose()`,
   * `values(item)` (an open submenu's values as they are now, or null where they were asked once), `refocus()` (where
   * the focus goes when the opener is gone). Returns {update(items, header), close()}.
   */
  function menu(items, at, opts) {
    close(false);
    const o = Object.assign({ onPick() {}, onDisabled() {}, submenu: () => [], values: () => null, onClose() {}, refocus() {} }, opts || {});
    const top = panelOf(items, { label: o.label, header: o.header });
    const anchor = (at && at.anchor) || o.opener || null;
    open = { root: top, panels: [top], opener: o.opener || null, anchor, at: at || { x: 0, y: 0 }, opts: o, stop() {} };
    if (o.opener && o.opener.hasAttribute && o.opener.hasAttribute('aria-haspopup')) o.opener.setAttribute('aria-expanded', 'true');
    mount(top.el, anchor);
    placePanel(top);
    open.stop = keep(open);
    focusRow(top, firstUsable(top));
    const handle = {
      /**
       * The same items with what they say now: words, checks, reasons; an item no longer offered turns disabled. A fold
       * stays one row while any of its entries is offered (drawn flat now, or in it), and an open submenu's rows say
       * what they say now too: a fold's entries, or its values (a reaction's check) where the page reads them again.
       */
      update(next, header) {
        if (!open || open.handle !== handle) return;
        if (header !== undefined && top.head) { top.head.textContent = header; top.el.setAttribute('aria-label', nameOf(o.label, header)); }
        const flat = next.filter((i) => !i.sep);
        const byKey = new Map(flat.map((i) => [i.id || 'fold:' + i.fold, i]));
        const byId = new Map(flat.flatMap((i) => i.children || [i]).filter((i) => i.id).map((i) => [i.id, i]));
        const goneWords = o.goneWords || 'Not available any more.';
        const gone = (item) => Object.assign({}, item, { disabled: goneWords, held: '' });
        for (const r of top.rows) {
          const now = byKey.get(r.item.id || 'fold:' + r.item.fold) || (r.item.id ? byId.get(r.item.id) : null);
          if (now) { draw(r, now); continue; }
          const kids = (r.item.children || []).map((c) => byId.get(c.id) || gone(c));
          draw(r, kids.some((k) => k.disabled !== goneWords) ? Object.assign({}, r.item, { children: kids }) : gone(r.item));
        }
        const sub = top.child;
        if (!sub) return;
        const parent = sub.parentRow.item;
        if (parent.fold) {
          const kids = new Map((parent.children || []).map((c) => [c.id, c]));
          for (const r of sub.rows) if (!r.back) draw(r, kids.get(r.item.id) || gone(r.item));
          return;
        }
        // A submenu of values: as they are now, each disabled with its parent's reason while the parent cannot run.
        const values = parent.disabled ? null : o.values(parent);
        if (!parent.disabled && !Array.isArray(values)) return;
        const byValue = new Map((values || []).map((v) => [String(v.value), v]));
        for (const r of sub.rows) {
          if (r.back || r.item.value === undefined) continue;
          const v = parent.disabled ? Object.assign({}, r.item, { disabled: parent.disabled }) : byValue.get(String(r.item.value));
          draw(r, v || gone(r.item));
        }
      },
      /** Open the submenu of the item `id` (a key's door: E reacts, F sends to), the focus on its first item. */
      expand(id) {
        if (!open || open.handle !== handle) return;
        const r = top.rows.find((x) => x.item.id === id);
        if (r && r.item.submenu && !r.item.disabled) openSub(r, { focus: true });
      },
      close: () => { if (open && open.handle === handle) close(true); },
      get el() { return top.el; },
    };
    open.handle = handle;
    return handle;
  }
  /** Close the open menu; `focusBack`: the focus returns to its opener (or where the page says, when that is gone). */
  function close(focusBack) {
    if (!open) return;
    const was = open;
    open = null;
    was.stop();
    for (const p of was.panels.slice().reverse()) { clearTimeout(p.timer); unmount(p.el); }
    if (was.opener && was.opener.hasAttribute && was.opener.hasAttribute('aria-haspopup')) was.opener.setAttribute('aria-expanded', 'false');
    if (focusBack) {
      if (was.opener && was.opener.isConnected && typeof was.opener.focus === 'function') was.opener.focus();
      else was.opts.refocus();
    }
    was.opts.onClose();
  }
  menu.close = () => close(true);
  /** The placement rule, apart from the page (pure). */
  menu.spot = spot;
  menu.isOpen = () => !!open;
  /** The open menu's handle, or null. */
  menu.current = () => (open ? open.handle : null);

  // A press outside the menu closes it; a press on the button that opened it (its ⋯) leaves it to that button's click,
  // which closes it, so the ⋯ toggles.
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (open.panels.some((p) => p.el.contains(e.target))) return;
    const by = open.opener;
    if (by && by.hasAttribute && by.hasAttribute('aria-haspopup') && by.contains(e.target)) return;
    close(false);
  }, true);
  // A menu is placed for the width it opened at: a new width (a window resized, a tablet turned) closes it. A height that
  // changes alone (a phone's address bar, its keyboard) does not.
  let openWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (open && window.innerWidth !== openWidth) close(false);
    openWidth = window.innerWidth;
  });

  // ---------------------------------------------------------------- the doors
  const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  /**
   * The doors of the objects in `container`: right-click (and a long press where the browser fires contextmenu for
   * one), Shift+F10 and the menu key. `find(target)` answers {el, more, open(at)} for the object under it, or null, and
   * the browser's own menu stays. A key's menu is anchored at the object's ⋯ (`more`), a pointer's at the pointer.
   */
  menu.door = function door(container, find) {
    container.addEventListener('contextmenu', (e) => {
      if (e.shiftKey) return;   // Shift+right-click: the browser's own menu, always
      const t = e.target;
      // A link keeps the browser's menu, but an object's own link (a hall's name: `data-object-link`) takes the object's.
      if (!t || !t.closest || t.closest(FIELD) || t.closest('a[href]:not([data-object-link])')) return;
      const obj = find(t);
      if (!obj) return;
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.anchorNode && obj.el.contains(sel.anchorNode)) return;   // Copy: the browser's
      const byKey = e.pointerType === '' || (e.button === 0 && e.clientX === 0 && e.clientY === 0);
      if (!obj.open(byKey ? { anchor: obj.more || obj.el } : { x: e.clientX, y: e.clientY })) return;
      e.preventDefault();
    });
    container.addEventListener('keydown', (e) => {
      const isKey = (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) || e.key === 'ContextMenu';
      if (!isKey || !e.target || !e.target.closest || e.target.closest(FIELD)) return;
      const obj = find(e.target);
      if (!obj) return;
      if (obj.open({ anchor: obj.more || obj.el, keyboard: true })) e.preventDefault();
    });
  };

  // ---------------------------------------------------------------- an ask in place
  /** An ask's words: one paragraph, or one for each of a list, each describing it. */
  const wordsOf = (w) => (Array.isArray(w) ? w : w ? [w] : []).map(String).filter(Boolean);
  function drawWords(box, list) {
    for (const old of box.querySelectorAll(':scope > .agm-ask-words')) old.remove();
    const title = box.querySelector(':scope > .agm-ask-title');
    const ids = [];
    let after = title;
    list.forEach((text, i) => {
      const w = make('p', 'agm-ask-words', text);
      w.id = box.id + '-w' + i;
      ids.push(w.id);
      after.after(w);
      after = w;
    });
    if (ids.length) box.setAttribute('aria-describedby', ids.join(' ')); else box.removeAttribute('aria-describedby');
  }
  /**
   * Ask in place before an act: `spec` {title, words, fields: [{name, label, value, max, type, options, hint}], yes, no,
   * choices, danger}. `words` is one paragraph or a list of them; a field's `type` 'text' (the default), 'password',
   * 'checkbox' (its value true or false), 'select' (its `options` [{value, label}]) or 'time' (a time of day, its value
   * "HH:MM" whatever the browser shows; one that has no time field takes it typed). `choices` [{answer, label,
   * danger}] are more than one way to say yes, drawn in their order before `no` in place of `yes`. The answer: {yes:
   * true, values} (with `choice`, the answer chosen, where there are choices) or {yes: false}. When it closes the focus
   * goes back to `opts.opener` (the object a key was pressed on, or the button that opened it), else to the anchor it is
   * placed by, else to `opts.refocus()`. `opts.after`: the element it follows in the page's order (a header's chip), so
   * Tab runs from that element into it and on; otherwise it is mounted at the end (inside an open dialog that holds the
   * anchor). `opts.toggles`: a press on `opts.opener` is left to that opener's click, which closes it (a chip that opens and
   * closes its own ask); without it a press there is outside like any other, the ask's "no", so a ⋯ pressed again under
   * an ask opened from its menu never leaves the ask open beneath the menu it opens.
   */
  function ask(anchor, spec, opts) {
    if (asking) asking.finish(false, false);
    const o = opts || {};
    const s = spec || {};
    const box = make('div', 'agm-ask');
    const id = 'agm-ask-' + (++seq);
    box.id = id;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    const title = make('p', 'agm-ask-title', s.title || '');
    title.id = id + '-t';
    box.setAttribute('aria-labelledby', title.id);
    box.appendChild(title);
    drawWords(box, wordsOf(s.words));
    const inputs = [];
    for (const f of s.fields || []) {
      const type = f.type === 'checkbox' || f.type === 'select' || f.type === 'password' || f.type === 'time' ? f.type : 'text';
      const lab = make('label', type === 'checkbox' ? 'agm-ask-field agm-ask-check' : 'agm-ask-field');
      const span = make('span', '', f.label || f.name);
      let input;
      if (type === 'select') {
        input = make('select');
        for (const opt of f.options || []) { const o = make('option', '', opt.label); o.value = String(opt.value); input.appendChild(o); }
        if (f.value !== undefined) input.value = String(f.value);
      } else {
        input = make('input');
        input.type = type;
        if (type === 'checkbox') input.checked = !!f.value;
        else {
          // Nothing typed here is kept by the browser or checked against a dictionary: a token, a fingerprint, a name.
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.setAttribute('autocapitalize', 'none');
          if (f.max) input.maxLength = f.max;
          if (f.value !== undefined) input.value = String(f.value);
        }
      }
      input.name = f.name;
      if (type === 'checkbox') lab.append(input, span); else lab.append(span, input);
      if (f.hint) { const h = make('small', 'hint', f.hint); h.id = id + '-h' + inputs.length; input.setAttribute('aria-describedby', h.id); lab.appendChild(h); }
      box.appendChild(lab);
      inputs.push(input);
    }
    // The focus starts in the first field that is typed into or chosen, else on the safe answer.
    const firstField = inputs.find((i) => i.type !== 'checkbox') || null;
    const acts = make('div', 'agm-ask-acts');
    const no = make('button', 'btn', s.no || 'Cancel');
    no.type = 'button';
    no.dataset.answer = 'no';
    const choices = Array.isArray(s.choices) && s.choices.length ? s.choices : null;
    const yeses = (choices || [{ answer: 'yes', label: s.yes || 'OK', danger: s.danger, primary: true }]).map((c) => {
      const b = make('button', 'btn' + (c.danger ? ' danger' : c.primary ? ' primary' : ''), c.label);
      b.type = 'button';
      b.dataset.answer = String(c.answer);
      return b;
    });
    // The safe answer last where there are choices (as their words read: do this, do that, or keep it), else first.
    if (choices) acts.append(...yeses, no); else acts.append(no, ...yeses);
    box.appendChild(acts);
    return new Promise((resolve) => {
      let done = false;
      const finish = (said, focusBack, choice) => {
        if (done) return;
        done = true;
        if (asking && asking.box === box) asking = null;
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('resize', replace);
        unmount(box);
        if (focusBack) {
          const back = [o.opener, anchor].find((n) => n && n.isConnected && typeof n.focus === 'function');
          if (back) back.focus();
          else if (typeof o.refocus === 'function') o.refocus();
        }
        const values = {};
        for (const i of inputs) values[i.name] = i.type === 'checkbox' ? i.checked : i.value.trim();
        resolve(!said ? { yes: false } : choices ? { yes: true, choice, values } : { yes: true, values });
      };
      const opensIt = (t) => !!(o.toggles && o.opener && o.opener.contains && o.opener.contains(t));
      const outside = (e) => { if (!box.contains(e.target) && !opensIt(e.target)) finish(false, false); };
      const replace = () => place(box, anchor ? { anchor } : { x: 16, y: 16 }, { whole: true });
      asking = { box, anchor, finish };
      no.addEventListener('click', () => finish(false, true));
      for (const b of yeses) b.addEventListener('click', () => finish(true, true, b.dataset.answer));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); return; }
        // Enter in a typed field answers yes; on a tick or a choice it does what it does there, never yes.
        if (e.key === 'Enter' && !choices && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !e.isComposing) { e.preventDefault(); finish(true, true); }
      });
      box.addEventListener('focusout', (e) => { const to = e.relatedTarget; if (to && !box.contains(to) && !opensIt(to)) finish(false, false); });
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('resize', replace);
      if (o.after && o.after.isConnected) {
        o.after.after(box);
        if (typeof box.showPopover === 'function') { box.setAttribute('popover', 'manual'); box.showPopover(); }
      } else mount(box, anchor);
      replace();
      (firstField || no).focus();
      if (firstField && firstField.tagName === 'INPUT' && typeof firstField.select === 'function') firstField.select();
    });
  }
  ask.isOpen = () => !!asking;
  /** Answer the open ask "no" (its object is gone, or the page left the hall). */
  ask.close = () => { if (asking) asking.finish(false, false); };
  /** The open ask says what its object says now: its title and words drawn again in place, its buttons and focus kept. */
  ask.update = (spec) => {
    if (!asking || !spec) return;
    const box = asking.box;
    if (typeof spec.title === 'string') box.querySelector(':scope > .agm-ask-title').textContent = spec.title;
    if (spec.words !== undefined) drawWords(box, wordsOf(spec.words));
  };
  /** The element of the open ask, or null. */
  ask.box = () => (asking ? asking.box : null);

  // ---------------------------------------------------------------- a list, one tab stop
  const CONTROL = 'a[href], button, input, select, textarea, [tabindex]';
  /**
   * AGM.roving(list, {item, start, skip}): the objects of `list` that match `item` are one tab stop. The current one
   * takes Tab: the one the focus was last in, else the first (`start: 'last'`: the newest, for a feed, so a Tab into it
   * lands where the reader is and nothing scrolls away); ↑ and ↓ move between them, Home and End to the first and the
   * last; on a focused object Tab goes on into its own controls, and the controls of the others are left out of the tab
   * order (each given back its own tabindex when its object is current again), so a list of a hundred rows is passed in
   * one Tab. An object that matches `skip` (one drawn elsewhere, hidden here) is passed over. Rows drawn again keep the
   * current one by its `data-key`. What is drawn later is set as it lands, each object once: a change reads the list once
   * to place its stop and never sets it whole again. Returns {refresh(), focus(which)}: `which` is 'last', 'first' or 'current'.
   */
  function roving(list, { item, start = 'first', skip = '' }) {
    let current = '';   // the current object's data-key
    let stop = null;    // the object that holds the list's tab stop now
    const counts = (el) => !skip || !el.matches(skip);
    const every = () => [...list.querySelectorAll(item)];
    const all = () => every().filter(counts);
    const keyOf = (el) => el.dataset.key || '';
    /** A control out of the tab order keeps what its tabindex was, to have it back. */
    const out = (c) => {
      if (c.dataset.roving || c.getAttribute('tabindex') === '-1') return;
      c.dataset.roving = c.hasAttribute('tabindex') ? 't' + c.getAttribute('tabindex') : 'none';
      c.setAttribute('tabindex', '-1');
    };
    const back = (c) => {
      const was = c.dataset.roving;
      if (!was) return;
      if (was === 'none') c.removeAttribute('tabindex'); else c.setAttribute('tabindex', was.slice(1));
      delete c.dataset.roving;
    };
    function set(el, on) {
      const want = on && counts(el) ? '0' : '-1';
      if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want);
      for (const c of el.querySelectorAll(CONTROL)) { if (want === '0') back(c); else out(c); }
    }
    /** The object that holds the stop: the current one while it is listed, else the first, or the newest. */
    const pick = (objs) => objs.find((el) => current && keyOf(el) === current) || (start === 'last' ? objs[objs.length - 1] : objs[0]) || null;
    function moveStop(to) {
      if (stop && stop !== to && stop.isConnected) set(stop, false);
      stop = to;
      if (to) set(to, true);
    }
    function apply() {
      const cur = pick(all());
      for (const el of every()) if (el !== cur) set(el, false);
      stop = null;
      moveStop(cur);
    }
    /** What changed: each object drawn (or drawn into, or shown or hidden) set as it is now, then the stop placed. */
    function changed(records) {
      const touched = new Set();
      for (const r of records) {
        const nodes = r.type === 'childList' ? r.addedNodes : [r.target];
        for (const n of nodes) {
          if (n.nodeType !== 1) continue;
          const owner = n.closest(item);
          if (owner && list.contains(owner)) touched.add(owner);
          if (r.type === 'childList') for (const o of n.querySelectorAll(item)) touched.add(o);
        }
      }
      const cur = pick(all());
      for (const el of touched) if (el !== cur) set(el, false);
      if (cur !== stop || touched.has(cur)) moveStop(cur);
    }
    list.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest(item);
      if (!el || !list.contains(el) || !counts(el) || keyOf(el) === current) return;
      current = keyOf(el);
      moveStop(el);
    });
    list.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !e.target.matches || !e.target.matches(item)) return;
      const objs = all();
      const at = objs.indexOf(e.target);
      const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? objs.length - 1 : null;
      if (to === null || at < 0) return;
      e.preventDefault();
      const next = objs[Math.max(0, Math.min(objs.length - 1, to))];
      current = keyOf(next);
      moveStop(next);
      next.focus();
    });
    // Rows drawn, drawn again, shown or hidden: set once the list has settled, in the same task.
    new MutationObserver(changed).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-pinned'] });
    apply();
    return {
      refresh: apply,
      /** Focus an object of the list (the newest, the first, or the current one) and make it current; false when there is none. */
      focus(which) {
        const objs = all();
        const el = which === 'last' ? objs[objs.length - 1] : which === 'first' ? objs[0] : pick(objs);
        if (!el) return false;
        current = keyOf(el);
        moveStop(el);
        el.focus();
        return true;
      },
    };
  }

  // ---------------------------------------------------------------- a page's acts
  const moreName = (name) => name + ' (or right-click, or Shift+F10)';
  /** One act of an object's bar drawn into its button: its icon (and, with `words`, its label beside it), named by its label. */
  function drawAct(b, item, words) {
    b.dataset.action = item.id;
    b.setAttribute('aria-label', item.label);
    b.title = item.disabled || item.label;
    if (item.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    b.textContent = '';
    if (item.icon) { const i = make('span', '', item.icon); i.setAttribute('aria-hidden', 'true'); b.appendChild(i); }
    if (words || !item.icon) b.appendChild(make('span', 'act-words', item.label));
  }
  /** The ⋯ of an object: the door to its whole list on every device, a touch screen's included. */
  function moreButton(name) {
    const b = make('button', 'obj-more', '⋯');
    b.type = 'button';
    b.dataset.more = '1';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', name);
    b.title = moreName(name);
    return b;
  }
  /**
   * AGM.acts({facts, run, say}): a page's acts on the catalogue's objects, in one place. `facts()` the page's facts now
   * (catalog.js), `run` its runners by id (each `(o, ctx)`), `say(words, bad)` its toast. An act runs only where the
   * catalogue shows it to this page and it is ready, else its words are said and nothing is sent; one that asks first
   * asks in place. Returns {act, open, draw, bind, refresh, isOpenOn}.
   */
  function acts({ facts, run, say }) {
    const C = window.AGM.catalog;
    let openOn = null;   // the open menu: {kind, key, get, header, handle, gone}
    let askOn = null;    // the object an open ask is about: {get, gone}
    const drawn = new WeakMap();

    function act(kind, id, o, ctx) {
      const c = ctx || {};
      const F = facts();
      const e = C.entry(kind, id);
      if (!e || !run[id] || !C.shown(kind, F, o).some((x) => x.id === id)) { say(C.WORDS.gone, true); return; }
      const r = C.ready(kind, id, F, o);
      if (r !== true) { say(r, true); return; }
      const spec = e.confirm ? e.confirm(F, o) : null;
      if (!spec) { run[id](o, c); return; }
      const asked = { get: c.get || (() => o), gone: c.gone || C.WORDS.gone };
      askOn = asked;
      ask(c.anchor || c.node || null, spec, { opener: c.opener || null, refocus: c.refocus }).then((a) => {
        if (askOn === asked) askOn = null;
        const now = asked.get();
        if (a.yes && now) run[id](now, Object.assign({}, c, { values: a.values, choice: a.choice }));
      });
    }

    /**
     * Open an object's menu at `at` ({x, y}, or {anchor}). `get()` reads the object as it is now (null: it is gone);
     * `node` is its element and `more` its ⋯. False when it offers nothing here (the browser's own menu then stays).
     */
    function open(kind, get, { node, more, at, opener, label, header, gone, submenu, refocus }) {
      const o = get();
      if (!o) return false;
      const list = C.items(kind, facts(), o);
      if (!list.length) return false;
      const anchor = more || node;
      const from = opener || anchor;
      const words = gone || C.WORDS.gone;
      const head = header || (() => undefined);
      const handle = menu(list, at || { anchor }, {
        label: typeof label === 'function' ? label(o) : label, header: head(o), opener: from, goneWords: C.WORDS.gone,
        onPick: (id, value, item) => { const now = get(); if (now) act(kind, id, now, { anchor, node, value, item, opener: from, get, gone: words, refocus }); else say(words, true); },
        onDisabled: (w) => say(w, true),
        submenu: (item) => C.submenu(kind, item.id, facts(), get() || o) || (submenu ? submenu(item, get() || o) : []),
        values: (item) => (item.id ? C.submenu(kind, item.id, facts(), get() || o) : null),
        refocus: refocus || (() => {}),
        onClose: () => { if (openOn && openOn.handle === handle) openOn = null; },
      });
      openOn = { kind, key: node ? node.dataset.key || '' : '', get, header: head, handle, gone: words };
      return true;
    }

    /** The open menu and an open ask say what their object says now; their object gone, they close and say so. */
    function refresh() {
      if (askOn && !askOn.get()) { const w = askOn.gone; askOn = null; ask.close(); say(w, true); }
      if (!openOn) return;
      const o = openOn.get();
      if (!o) { const w = openOn.gone; openOn.handle.close(); openOn = null; ask.close(); say(w, true); return; }
      openOn.handle.update(C.items(openOn.kind, facts(), o), openOn.header(o));
    }

    /**
     * Draw an object's bar into `bar`: its inline acts (`cls` their class, `words` their labels beside their icons) and its
     * ⋯ named `more` (none when it has no menu). A button that offers the same act again is drawn again in place, and the
     * ⋯ is kept while there is a menu, so a redraw never takes the focus, or an open menu's opener, away.
     */
    function draw(bar, kind, o, { more = 'More actions', words = false, cls = 'msg-act', keysOn = null } = {}) {
      const F = facts();
      const inl = C.inline(kind, F, o);
      const hasMenu = C.items(kind, F, o).length > 0;
      const sig = JSON.stringify([inl.map((i) => [i.id, i.label, i.icon, i.disabled]), hasMenu, more, words]);
      if (keysOn) {
        const keys = C.shown(kind, F, o).filter((e) => e.key).map((e) => e.key);
        if (keys.length) keysOn.setAttribute('aria-keyshortcuts', keys.join(' ')); else keysOn.removeAttribute('aria-keyshortcuts');
      }
      if (drawn.get(bar) === sig) return;
      drawn.set(bar, sig);
      const had = [...bar.querySelectorAll(':scope > [data-action]')];
      let dots = bar.querySelector(':scope > .obj-more');
      if (had.length === inl.length && had.every((b, n) => b.dataset.action === inl[n].id)) inl.forEach((i, n) => drawAct(had[n], i, words));
      else {
        had.forEach((b) => b.remove());
        for (const i of inl) { const b = make('button', cls); b.type = 'button'; drawAct(b, i, words); bar.insertBefore(b, dots); }
      }
      if (hasMenu && !dots) { dots = moreButton(more); bar.appendChild(dots); }
      else if (!hasMenu && dots) dots.remove();
      else if (dots) { dots.setAttribute('aria-label', more); dots.title = moreName(more); }
    }

    /**
     * The doors of a kind's objects in `container`: a click on an act or the ⋯, a single key on the focused object, and
     * right-click, Shift+F10 and the menu key (menu.door). `spec.find(el)` answers the object's element under `el`
     * (`[data-key]`), or null; `spec.get(key)` the object as it is now, or null; `label` (words, or the object's words:
     * `label(o)`), `header(o)`, `gone` (the words
     * when it went), `submenu(item, o)` (values the catalogue does not hold, asked when a submenu opens), `refocus(o)`.
     */
    function bind(container, spec) {
      const getter = (node) => { const key = node.dataset.key; return () => spec.get(key); };
      const doorOf = (node) => {
        const more = node.querySelector('.obj-more');
        const refocus = () => { const back = spec.refocus && spec.refocus(spec.get(node.dataset.key)); if (back && back.focus) back.focus(); };
        return {
          el: node, more,
          // The focus goes back where it was in the object (the object itself, or a control of its), or to the ⋯ pressed.
          open: (at, by) => open(spec.kind, getter(node), { node, more, at, opener: by || (node.contains(document.activeElement) ? document.activeElement : node), label: spec.label, header: spec.header, gone: spec.gone, submenu: spec.submenu, refocus }),
        };
      };
      const withSub = (node, id) => { const d = doorOf(node); if (d.open({ anchor: d.more || node }) && menu.current()) menu.current().expand(id); };
      container.addEventListener('click', (e) => {
        const el = e.target.closest && e.target.closest('[data-action], [data-more]');
        if (!el || !container.contains(el)) return;
        const node = spec.find(el);
        const o = node && spec.get(node.dataset.key);
        if (!o) return;
        e.preventDefault();
        const more = node.querySelector('.obj-more');
        if (el.dataset.more) {
          if (openOn && openOn.kind === spec.kind && openOn.key === node.dataset.key) { menu.close(); return; }
          doorOf(node).open({ anchor: el }, el);
          return;
        }
        const entry = C.entry(spec.kind, el.dataset.action);
        if (entry && entry.submenu && el.dataset.value === undefined) { withSub(node, entry.id); return; }
        act(spec.kind, el.dataset.action, o, { anchor: more || el, node, value: el.dataset.value, opener: el, get: getter(node), gone: spec.gone });
      });
      container.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
        const node = e.target;
        if (!node || !node.matches || !node.dataset.key || spec.find(node) !== node) return;
        const o = spec.get(node.dataset.key);
        const entry = o && C.byKey(spec.kind, facts(), o, e.key);
        if (!entry) return;
        e.preventDefault();
        if (entry.submenu) { withSub(node, entry.id); return; }
        act(spec.kind, entry.id, o, { anchor: node.querySelector('.obj-more') || node, node, opener: node, get: getter(node), gone: spec.gone });
      });
      menu.door(container, (t) => { const node = spec.find(t); return node && spec.get(node.dataset.key) ? doorOf(node) : null; });
    }

    return { act, open, draw, bind, refresh, isOpenOn: (kind, key) => !!openOn && openOn.kind === kind && openOn.key === key };
  }

  /**
   * Words to the clipboard: the clipboard API where the page is a secure context, else the browser's copy of a selection
   * (a page served over plain http on the venue network has no clipboard API), else a field in place to copy from by
   * hand. `say(words)` is told when it is copied; the focus goes back where it was.
   */
  async function copy(text, { said = 'Copied.', anchor = null, say = () => {} } = {}) {
    try {
      if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); say(said); return; }
    } catch { /* refused (no permission, not focused): the selection's copy below */ }
    const host = (anchor && anchor.closest && anchor.closest('dialog[open]')) || document.body;
    const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : anchor;
    const t = make('textarea', 'copy-source');
    t.value = text;
    t.setAttribute('readonly', '');
    host.appendChild(t);
    t.select();
    let copied;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    t.remove();
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    if (copied) { say(said); return; }
    ask(anchor || null, { title: 'Copy it from here', words: 'This browser would not copy it by itself: select it and copy.', fields: [{ name: 'text', label: 'To copy', value: text }], yes: 'Done', no: 'Close' });
  }

  Object.assign(window.AGM = window.AGM || {}, { menu, ask, roving, acts, copy });
})();
