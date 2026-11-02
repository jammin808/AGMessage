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
//
// AGM.menu.door(container, find) is the one place a page hears `contextmenu` (and Shift+F10 or the menu key): a
// right-click, the keys and the object's ⋯ open the same menu. The browser keeps its own menu in a field, on a text
// selection inside the object, on a link, and always with Shift+right-click.
//
// AGM.ask(anchor, spec) is a non-modal role=dialog anchored to the object, labelled by its title, naming the object and
// what follows; its buttons are verbs, the focus starts on the safe one (or the first field), and Escape, a tap outside it
// and the focus moved away are its "no". One is open at a time: opening another answers the first "no". It answers a
// promise: {yes, values}.
(function () {
  'use strict';

  const SUB_HOVER_MS = 200;
  const MARGIN = 8;
  let open = null;      // the open menu: {root, panels: [panel…], opener, opts, rows: Map(key → row)}
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
  /** Fixed in the viewport: at the pointer + 2 px, or under the anchor's bottom-left, flipped and kept 8 px inside. */
  function place(el, at) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x, y;
    if (at && at.beside) {
      const r = at.beside.getBoundingClientRect();
      x = r.right - 2; y = r.top;
      if (x + w > vw - MARGIN) x = r.left - w + 2;
    } else if (at && at.anchor) {
      const r = at.anchor.getBoundingClientRect();
      x = r.left; y = r.bottom + 2;
      if (y + h > vh - MARGIN) y = r.top - h - 2;
    } else {
      const px = at ? at.x : 0, py = at ? at.y : 0;
      x = px + 2; y = py + 2;
      if (x + w > vw - MARGIN) x = px - w - 2;
      if (y + h > vh - MARGIN) y = py - h - 2;
    }
    el.style.left = Math.round(Math.max(MARGIN, Math.min(x, vw - w - MARGIN))) + 'px';
    el.style.top = Math.round(Math.max(MARGIN, Math.min(y, vh - h - MARGIN))) + 'px';
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
    r.parts.key.textContent = item.key || '';
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
      sub.el.style.left = p.el.style.left;
      sub.el.style.top = p.el.style.top;
      p.el.hidden = true;
      mount(sub.el, open.anchor);
      placeDrill(sub, p);
    } else {
      mount(sub.el, open.anchor);
      place(sub.el, { beside: r.el });
    }
    open.panels.push(sub);
    if (focus) focusRow(sub, firstUsable(sub));
    if (loading) {
      list.then((later) => {
        if (!open || p.child !== sub) return;
        for (const old of sub.rows.filter((x) => !x.back)) old.el.remove();
        sub.rows = sub.rows.filter((x) => x.back);
        fill(sub, Array.isArray(later) && later.length ? later : []);
        if (drill) placeDrill(sub, p); else place(sub.el, { beside: r.el });
        if (sub.el.contains(document.activeElement) || document.activeElement === document.body) focusRow(sub, firstUsable(sub));
      });
    }
  }
  function placeDrill(sub, p) {
    if (p.el.classList.contains('sheet')) { sub.el.classList.add('sheet'); return; }
    sub.el.style.left = p.el.style.left;
    sub.el.style.top = p.el.style.top;
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
    if (focusBack) sub.parentRow.el.focus();
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
    open = { root: top, panels: [top], opener: o.opener || null, anchor, opts: o };
    if (o.opener && o.opener.hasAttribute && o.opener.hasAttribute('aria-haspopup')) o.opener.setAttribute('aria-expanded', 'true');
    mount(top.el, anchor);
    if (!top.el.classList.contains('sheet')) place(top.el, at);
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
    for (const p of was.panels.slice().reverse()) { clearTimeout(p.timer); unmount(p.el); }
    if (was.opener && was.opener.hasAttribute && was.opener.hasAttribute('aria-haspopup')) was.opener.setAttribute('aria-expanded', 'false');
    if (focusBack) {
      if (was.opener && was.opener.isConnected && typeof was.opener.focus === 'function') was.opener.focus();
      else was.opts.refocus();
    }
    was.opts.onClose();
  }
  menu.close = () => close(true);
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
      if (!t || !t.closest || t.closest(FIELD) || t.closest('a[href]')) return;
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
  /**
   * Ask in place before an act: `spec` {title, words, fields: [{name, label, value, max}], yes, no, danger}. The answer:
   * {yes: true, values} or {yes: false}. When it closes the focus goes back to `opts.opener` (the object a key was pressed
   * on, or the button that opened it), else to the anchor it is placed by, else to `opts.refocus()`.
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
    if (s.words) {
      const w = make('p', 'agm-ask-words', s.words);
      w.id = id + '-w';
      box.setAttribute('aria-describedby', w.id);
      box.appendChild(w);
    }
    const inputs = [];
    for (const f of s.fields || []) {
      const lab = make('label', 'agm-ask-field');
      const span = make('span', '', f.label || f.name);
      const input = make('input');
      input.name = f.name;
      input.autocomplete = 'off';
      if (f.max) input.maxLength = f.max;
      if (f.value !== undefined) input.value = String(f.value);
      lab.append(span, input);
      box.appendChild(lab);
      inputs.push(input);
    }
    const acts = make('div', 'agm-ask-acts');
    const no = make('button', 'btn', s.no || 'Cancel');
    no.type = 'button';
    no.dataset.answer = 'no';
    const yes = make('button', 'btn ' + (s.danger ? 'danger' : 'primary'), s.yes || 'OK');
    yes.type = 'button';
    yes.dataset.answer = 'yes';
    acts.append(no, yes);
    box.appendChild(acts);
    return new Promise((resolve) => {
      let done = false;
      const finish = (said, focusBack) => {
        if (done) return;
        done = true;
        if (asking && asking.box === box) asking = null;
        document.removeEventListener('pointerdown', outside, true);
        unmount(box);
        if (focusBack) {
          const back = [o.opener, anchor].find((n) => n && n.isConnected && typeof n.focus === 'function');
          if (back) back.focus();
          else if (typeof o.refocus === 'function') o.refocus();
        }
        const values = {};
        for (const i of inputs) values[i.name] = i.value.trim();
        resolve(said ? { yes: true, values } : { yes: false });
      };
      const outside = (e) => { if (!box.contains(e.target)) finish(false, false); };
      asking = { box, anchor, finish };
      no.addEventListener('click', () => finish(false, true));
      yes.addEventListener('click', () => finish(true, true));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); return; }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.isComposing) { e.preventDefault(); finish(true, true); }
      });
      box.addEventListener('focusout', (e) => { const to = e.relatedTarget; if (to && !box.contains(to)) finish(false, false); });
      document.addEventListener('pointerdown', outside, true);
      mount(box, anchor);
      place(box, anchor ? { anchor } : { x: 16, y: 16 });
      (inputs[0] || no).focus();
      if (inputs[0] && typeof inputs[0].select === 'function') inputs[0].select();
    });
  }
  ask.isOpen = () => !!asking;
  /** Answer the open ask "no" (its object is gone, or the page left the hall). */
  ask.close = () => { if (asking) asking.finish(false, false); };

  Object.assign(window.AGM = window.AGM || {}, { menu, ask });
})();
