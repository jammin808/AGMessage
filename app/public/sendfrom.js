// Which rooms may send into a room (the catalogue's adminRoom.sendFrom: May send in…, plan 1-§4.1), on the admin page and
// in a hall's Set up: the admin's alone. Every hall's rooms, grouped by hall (room:settings' `everyHall`, which only the
// admin is told), each ticked where it may send into this room now (`sendFrom`), and beside each its "↔ and send back",
// ticked where this room sends into that one now (`sendBack`: every room whose list names this one, whether or not that
// room may send here), so the picker draws both directions as they are kept. A ↔ is offered beside a ticked room, and
// stays offered wherever this room sends now, to keep or take away; a ↔ ticked beside a room then unticked, which this
// room did not send into, goes with its tick. This room is listed, never offered. Save sends one room:update {code,
// sendFrom, sendBack} with every room ticked and every ↔ ticked, so the server sets the lists in one save and one row and
// says what changed (`into`, `notInto`), which the words name; nothing changed sends nothing. The server is the authority
// on every key and the bound of 50: a refusal is said in place, the list as drawn.
(function (root) {
  'use strict';

  const NO_ANSWER_MS = 5000;
  const NO_ANSWER = 'No answer yet — check the connection. What AGMessage answers is said here.';
  const MAX = 50;

  const keys = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
  const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /**
   * The picker's rows (pure): every hall of `settings.everyHall` (room:settings' answer, the admin's), each with its rooms
   * as {key, name ('Main room' for a hall's Main room), self (this room: drawn, never offered), on (it may send here now),
   * back (this room sends into it now, whether or not it may send here)}. None without every hall's rooms: the picker is
   * the admin's.
   */
  function groupsFor(settings) {
    if (!isRecord(settings) || !Array.isArray(settings.everyHall)) return [];
    const from = new Set((Array.isArray(settings.sendFrom) ? settings.sendFrom : []).map((r) => (isRecord(r) ? r.key : r)).filter((k) => typeof k === 'string'));
    const back = new Set(keys(settings.sendBack));
    return settings.everyHall.filter(isRecord).map((h) => ({
      hall: h.name || 'A hall with no name',
      rooms: (Array.isArray(h.rooms) ? h.rooms : []).filter((r) => isRecord(r) && typeof r.key === 'string').map((r) => {
        const self = r.key === settings.key;
        return { key: r.key, name: r.main ? 'Main room' : r.name || 'A room with no name', self, on: !self && from.has(r.key), back: !self && back.has(r.key) };
      }),
    }));
  }
  /**
   * What Save sends (pure): `ticks` [{key, on, back}] as drawn, in their order; this room is never sent. Null when every
   * tick and every ↔ is as `settings` says it is now, else {code, sendFrom: the rooms ticked, sendBack: the rooms with ↔
   * ticked, each beside a room ticked or one this room sends into now (a ↔ is offered nowhere else)}.
   */
  function changeOf(settings, ticks) {
    const list = (Array.isArray(ticks) ? ticks : []).filter((t) => isRecord(t) && typeof t.key === 'string' && t.key !== settings.key);
    const before = groupsFor(settings).flatMap((g) => g.rooms).filter((r) => !r.self);
    const was = new Set(before.filter((r) => r.back).map((r) => r.key));
    const sendFrom = list.filter((t) => t.on).map((t) => t.key);
    const sendBack = list.filter((t) => t.back && (t.on || was.has(t.key))).map((t) => t.key);
    const same = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
    if (same(sendFrom, before.filter((r) => r.on).map((r) => r.key)) && same(sendBack, [...was])) return null;
    return { code: settings.key, sendFrom, sendBack };
  }
  const rooms = (n) => (n === 1 ? '1 room' : n + ' rooms');
  /** A room of `settings.everyHall` as the pages name it: a hall's Main room by its hall's name, a side room "Hall 2 › Legal". */
  function nameIn(settings, key) {
    for (const h of (isRecord(settings) && Array.isArray(settings.everyHall) ? settings.everyHall : []).filter(isRecord)) {
      const r = (Array.isArray(h.rooms) ? h.rooms : []).find((x) => isRecord(x) && x.key === key);
      if (r) return (h.name || 'A hall with no name') + (r.main ? '' : ' › ' + (r.name || 'a room with no name'));
    }
    return 'a room';
  }
  /** Names as a sentence says them: "A", "A and B", "A, B and C", the fourth on counted ("A, B, C and 2 more"). */
  function listed(names) {
    if (names.length > 3) return names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join('');
  }
  /**
   * What a save did, in words (pure), from the server's answer, the room as the page names it ("Hall 2 › Legal") and the
   * settings the picker drew, which name the rooms this room was let send into and those it no longer sends into.
   */
  function words(res, where, settings) {
    if (res.already) return 'Nothing changed.';
    const from = keys(res.sendFrom).length;
    const into = keys(res.into).map((k) => nameIn(settings, k));
    const notInto = keys(res.notInto).map((k) => nameIn(settings, k));
    return (from ? 'Saved: ' + rooms(from) + ' may send into ' + where + '.' : 'Saved: no room may send into ' + where + '.')
      + (into.length ? ' It now sends into ' + listed(into) + '.' : '') + (notInto.length ? ' It no longer sends into ' + listed(notInto) + '.' : '');
  }

  // ---------------------------------------------------------------- the dialog, made once per page that opens it
  let box = null;     // {dlg, title, intro, list, said, save}
  let current = null; // {room, settings, opts}
  let saving = false;
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function dialog() {
    if (box) return box;
    const dlg = make('dialog', 'agm-dialog wide sends-dialog');
    dlg.id = 'sendsDialog';
    dlg.setAttribute('aria-labelledby', 'sendsTitle');
    const form = make('form');
    form.method = 'dialog';
    const title = make('h2', '', 'May send in');
    title.id = 'sendsTitle';
    const intro = make('p', 'hint');
    intro.id = 'sendsWords';
    const list = make('div', 'sends-list');
    list.id = 'sendsList';
    const said = make('p', 'members-said');
    said.id = 'sendsSaid';
    said.setAttribute('role', 'status');
    const foot = make('div', 'row end dialog-foot');
    const cancel = make('button', 'btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.value = 'cancel';
    cancel.addEventListener('click', () => dlg.close('cancel'));
    const save = make('button', 'btn primary', 'Save');
    save.value = 'save';
    save.id = 'sendsSave';
    foot.append(cancel, save);
    form.append(title, intro, list, said, foot);
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    // A room ticked offers its ↔. Unticked, its ↔ stays offered, as it is, where this room sends into it now (to keep or
    // take away); elsewhere it goes with the tick, so no ↔ that would add a room is left beside a room not ticked.
    list.addEventListener('change', (e) => {
      const on = e.target.closest('input.sends-on');
      if (!on) return;
      const back = on.closest('li').querySelector('input.sends-back');
      if (!back) return;
      back.disabled = !on.checked && back.dataset.was !== '1';
      if (back.disabled) back.checked = false;
    });
    box = { dlg, title, intro, list, said, save };
    return box;
  }
  function draw() {
    const b = dialog();
    const { room, settings } = current;
    b.title.textContent = 'Who may send into ' + room.hall;
    b.intro.textContent = 'Tick each room whose people may send messages and files into ' + room.hall + ': a copy stays where it was sent from, and the replies stay here. '
      + '“↔ and send back” lets ' + room.hall + ' send into that room too; it stays ticked beside every room ' + room.hall + ' sends into now, to keep or take away. '
      + 'At most ' + MAX + '. Saved when you press Save, and used at once.';
    b.list.textContent = '';
    const groups = groupsFor(settings);
    for (const g of groups) {
      const set = make('fieldset', 'field sends-hall');
      set.appendChild(make('legend', '', g.hall));
      const ul = make('ul', 'sends-rooms');
      for (const r of g.rooms) {
        const li = make('li', 'sends-row');
        li.dataset.key = r.key;
        const lab = make('label', 'check');
        const c = make('input', 'sends-on');
        c.type = 'checkbox';
        c.checked = r.on;
        c.disabled = r.self;
        lab.append(c, make('span', '', r.name));
        li.appendChild(lab);
        if (r.self) li.appendChild(make('small', 'hint', 'This room'));
        else {
          const backLab = make('label', 'check sends-back-label');
          const back = make('input', 'sends-back');
          back.type = 'checkbox';
          back.checked = r.back;
          back.dataset.was = r.back ? '1' : '';
          back.disabled = !r.on && !r.back;
          // Its name says which room, as a screen reader hears it apart from the row: "↔ and send back into Main room, Hall 2".
          backLab.append(back, make('span', '', '↔ and send back'), make('span', 'sr-only', ' into ' + r.name + ', ' + g.hall));
          li.appendChild(backLab);
        }
        ul.appendChild(li);
      }
      set.appendChild(ul);
      b.list.appendChild(set);
    }
    if (!groups.length) b.list.appendChild(make('p', 'muted', 'No rooms to list.'));
  }
  /** The ticks as drawn: [{key, on, back}], in their order. */
  const ticksDrawn = (b) => [...b.list.querySelectorAll('li.sends-row[data-key]')].map((li) => {
    const back = li.querySelector('input.sends-back');
    return { key: li.dataset.key, on: li.querySelector('input.sends-on').checked, back: !!back && back.checked };
  });
  /**
   * Open the picker for `room` ({code, hall: as the page names it, "Hall 2 › Legal"}). `opts.read(code)` resolves with
   * room:settings' answer for it; `opts.say(words, bad)` says what happened; `opts.done()` hears a save that changed
   * something.
   */
  async function open(room, opts) {
    const o = opts || {};
    const say = typeof o.say === 'function' ? o.say : () => {};
    const settings = await o.read(room.code);
    if (!settings || !settings.ok) { say((settings && settings.error) || 'The rooms could not be read.', true); return; }
    if (!Array.isArray(settings.everyHall)) { say('Which rooms may send in is set by the admin.', true); return; }
    current = { room, settings, opts: o };
    const b = dialog();
    b.said.textContent = '';
    b.save.disabled = false;
    draw();
    root.AGM.openDialog(b.dlg);
  }
  /** One room:update with every tick; said, and on a refusal the list stays as drawn with the server's words. */
  function submit() {
    if (saving || !current) return;
    const b = dialog();
    const { room, settings, opts } = current;
    const say = typeof opts.say === 'function' ? opts.say : () => {};
    const change = changeOf(settings, ticksDrawn(b));
    if (!change) { b.dlg.close('save'); say('Nothing changed.'); return; }
    saving = true;
    b.save.disabled = true;
    b.said.textContent = 'Saving…';
    const late = setTimeout(() => { b.said.textContent = NO_ANSWER; }, NO_ANSWER_MS);
    root.AGM.outbox.now('room:update', change, (res) => {
      clearTimeout(late);
      saving = false;
      b.save.disabled = false;
      if (!res || !res.ok) {
        const why = (res && res.error) || 'Not saved.';
        b.said.textContent = why;
        say(why, true);
        return;
      }
      if (b.dlg.open) b.dlg.close('save');
      say(words(res, room.hall, settings));
      if (!res.already && typeof opts.done === 'function') opts.done();
    });
  }

  Object.assign(root.AGM = root.AGM || {}, { sendFrom: Object.freeze({ open, groupsFor, changeOf, words }) });
})(typeof window !== 'undefined' ? window : globalThis);
