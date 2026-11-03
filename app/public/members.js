// A room's members by account (the catalogue's adminRoom.members: Members… on a side room, Board members… on a hall's
// Main room), on the admin page and in a hall's Set up. A checklist of the accounts as the Accounts route tells this
// person them (GET /api/users), each ticked where the account holds the room: a side room in its `rooms`, a hall's Main
// room in its On stage halls (`board`). An account this person may not change is shown and not offered, with why (its
// own account, a richer one: the route's `locked`), and so is one that cannot sit On stage (it reads only: the route
// refuses that seat in the same words, rbac.unseatedOnStage, as it does on the Accounts page). Save sends one PATCH
// /api/users/:id per account whose tick changed, its own list with the room put in or taken out (and, for an account
// seated On stage in a hall it does not reach, the hall too, which the seat needs, said on its row before the Save), each
// judged by the server alone, and says each: "2 saved · Kim: why". A refused row is drawn again as the server holds it. No
// verb of its own: the saves are the Accounts page's routes, and the server is the authority on every one.
(function (root) {
  'use strict';

  const OWN = 'Your own account: another admin changes it.';
  const READS_ONLY = 'Reads only: On stage needs Send messages.';
  const NOT_YOURS = 'You give only the rooms and halls you hold yourself — ask an admin.';
  const NO_ANSWER_MS = 5000;
  const NO_ANSWER = 'No answer yet — check the connection. What AGMessage answers is said here.';

  /** A key list as a row holds it (strings only). */
  const keys = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
  /** Whether the person may give this room at all: a side room it is given (the admin every one), a hall it reaches. */
  function mayGive(data, room) {
    if (room.main) return !!(data.giveable && (data.giveable.allHalls || keys(data.giveable.halls).includes(room.code)));
    return !!(data.giveableRooms && (data.giveableRooms.all || keys(data.giveableRooms.rooms).includes(room.code)));
  }
  /** An account's role as the route lists it ({id, label, caps, allHalls}), or null. */
  const roleOf = (roles, id) => (Array.isArray(roles) ? roles.find((r) => r && r.id === id) : null) || null;
  /**
   * Whether an account reaches a hall's Main room by its halls (or every hall), and whether it may send messages, each
   * read from what it holds as stored and enabled, as the server judges a seat given (rbac.unseatedOnStage): a turned-off
   * account's `rights` are none, so they are not what is read.
   */
  function reaches(u, hall, roles) {
    const role = roleOf(roles, u.role);
    return (typeof u.allHalls === 'boolean' ? u.allHalls : !!(role && role.allHalls)) || keys(u.halls).includes(hall);
  }
  function posts(u, roles) {
    const role = roleOf(roles, u.role);
    const caps = new Set(role ? keys(role.caps) : []);
    for (const c of keys(u.grant)) caps.add(c);
    for (const c of keys(u.revoke)) caps.delete(c);
    return caps.has('hall.post');
  }
  /**
   * The checklist (pure): each account as {id, name, meta, held, why, adds}: `held` whether it holds the room now, `why`
   * the words that say why it is not offered ('' when it is), `adds` the hall its tick would give it too (On stage in a hall
   * it does not reach) or ''. `room` {code, main, hallName}; `me` the person's own account id.
   */
  function rowsFor(data, room, me) {
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const label = (id) => { const r = roleOf(roles, id); return r ? r.label : id; };
    const giving = mayGive(data, room);
    return (Array.isArray(data.users) ? data.users : []).map((u) => {
      const held = keys(room.main ? u.board : u.rooms).includes(room.code);
      let why = !giving ? NOT_YOURS : u.id === me ? OWN : typeof u.locked === 'string' && u.locked ? u.locked : '';
      if (!why && room.main && !held && !posts(u, roles)) why = READS_ONLY;
      return {
        id: u.id, name: u.name, meta: u.username + ' · ' + label(u.role) + (u.disabled ? ' · turned off' : ''),
        held, why, adds: room.main && !reaches(u, room.code, roles) ? (room.hallName || 'the hall') : '',
      };
    });
  }
  /**
   * What one account's PATCH sends for a tick (pure): its own list with the room put in (`on`) or taken out; a hall's Main
   * room in its On stage halls, with the hall in its halls too when it does not reach it (by its role, `roles` the
   * route's list), so the seat can be taken.
   */
  function changeFor(u, room, on, roles) {
    const field = room.main ? 'board' : 'rooms';
    const now = keys(u[field]);
    const change = { [field]: on ? now.filter((k) => k !== room.code).concat([room.code]) : now.filter((k) => k !== room.code) };
    if (room.main && on && !reaches(u, room.code, roles)) change.halls = keys(u.halls).filter((k) => k !== room.code).concat([room.code]);
    return change;
  }
  /** What a save did, in words (pure): "3 saved", each refusal after it by the account's name; "None saved" when all were. */
  function words(results) {
    if (!results.length) return 'Nothing changed.';
    const saved = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).map((r) => r.name + ': ' + r.error);
    return [saved ? saved + ' saved' : 'None saved'].concat(refused).join(' · ');
  }

  // ---------------------------------------------------------------- the dialog, made once per page that opens it
  let box = null;     // {dlg, title, intro, list, said, save}
  let current = null; // {room, rows, data, opts}
  let saving = false;
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function dialog() {
    if (box) return box;
    const dlg = make('dialog', 'agm-dialog wide members-dialog');
    dlg.id = 'membersDialog';
    dlg.setAttribute('aria-labelledby', 'membersTitle');
    const form = make('form');
    form.method = 'dialog';
    const title = make('h2', '', 'Members');
    title.id = 'membersTitle';
    const intro = make('p', 'hint');
    intro.id = 'membersWords';
    const list = make('ul', 'members-list');
    list.id = 'membersList';
    const said = make('p', 'members-said');
    said.id = 'membersSaid';
    said.setAttribute('role', 'status');
    const foot = make('div', 'row end dialog-foot');
    const cancel = make('button', 'btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.value = 'cancel';
    cancel.addEventListener('click', () => dlg.close('cancel'));
    const save = make('button', 'btn primary', 'Save');
    save.value = 'save';
    save.id = 'membersSave';
    foot.append(cancel, save);
    form.append(title, intro, list, said, foot);
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    box = { dlg, title, intro, list, said, save };
    return box;
  }
  function draw() {
    const b = dialog();
    const { room, rows } = current;
    b.title.textContent = room.main ? 'Board members of ' + room.hall : 'Members of ' + room.hall;
    b.intro.textContent = room.main
      ? 'The accounts seated On stage in ' + room.hall + '\'s Main room: tick who sits there. Their open pages reload.'
      : 'The accounts given ' + room.hall + ': they go in with their own sign-in, whatever its guest code. Tick who goes in. Their open pages reload.';
    b.list.textContent = '';
    for (const r of rows) {
      const li = make('li', 'members-row');
      li.dataset.key = r.id;
      const lab = make('label', 'check');
      const c = make('input');
      c.type = 'checkbox';
      c.checked = r.held;
      c.disabled = !!r.why;
      c.dataset.held = r.held ? '1' : '';
      const who = make('span', 'members-who');
      who.append(make('strong', '', r.name), make('span', 'muted', ' ' + r.meta));
      lab.append(c, who);
      li.appendChild(lab);
      if (r.why) li.appendChild(make('small', 'hint members-why', r.why));
      else if (r.adds && !r.held) li.appendChild(make('small', 'hint members-adds', 'A tick gives ' + r.adds + ' too.'));
      b.list.appendChild(li);
    }
    if (!rows.length) b.list.appendChild(make('li', 'muted', 'No accounts yet: add people on the Accounts page.'));
  }
  async function read(room) {
    const [me, data] = await Promise.all([root.AGM.api('GET', '/api/auth/me'), root.AGM.api('GET', '/api/users')]);
    if (!data.ok) return { error: data.error || 'The accounts could not be read.' };
    return { data, rows: rowsFor(data, room, me && me.account ? me.account.id : '') };
  }
  /**
   * Open the checklist for `room` ({code, name, hall: as the page names it, main, hallName}); `opts.say(words, bad)` says
   * what happened, `opts.done()` hears a save that changed something.
   */
  async function open(room, opts) {
    const o = opts || {};
    const say = typeof o.say === 'function' ? o.say : () => {};
    const r = await read(room);
    if (r.error) { say(r.error, true); return; }
    current = { room, rows: r.rows, data: r.data, opts: o };
    const b = dialog();
    b.said.textContent = '';
    b.save.disabled = false;
    draw();
    root.AGM.openDialog(b.dlg);
  }
  /** One PATCH per changed tick, all at once; each said, a refused row drawn as the server holds it. */
  async function submit() {
    if (saving || !current) return;
    const b = dialog();
    const { room, data, opts } = current;
    const say = typeof opts.say === 'function' ? opts.say : () => {};
    const asked = [...b.list.querySelectorAll('li[data-key]')].map((li) => {
      const c = li.querySelector('input[type=checkbox]');
      return { li, id: li.dataset.key, on: c.checked, was: c.dataset.held === '1', off: c.disabled };
    }).filter((x) => !x.off && x.on !== x.was);
    if (!asked.length) { b.dlg.close('save'); say('Nothing changed.'); return; }
    saving = true;
    b.save.disabled = true;
    b.said.textContent = 'Saving ' + asked.length + '…';
    const late = setTimeout(() => { b.said.textContent = NO_ANSWER; }, NO_ANSWER_MS);
    const results = await Promise.all(asked.map(async (x) => {
      const u = data.users.find((v) => v.id === x.id);
      const r = await root.AGM.api('PATCH', '/api/users/' + encodeURIComponent(x.id), changeFor(u, room, x.on, data.roles));
      return { id: x.id, name: u.name, ok: !!r.ok, error: r.ok ? '' : (r.error || 'Not saved.'), changed: r.ok && Array.isArray(r.changed) && r.changed.length > 0 };
    }));
    clearTimeout(late);
    saving = false;
    b.save.disabled = false;
    const said = words(results);
    if (results.some((x) => x.changed) && typeof opts.done === 'function') opts.done();
    if (results.every((x) => x.ok)) { if (b.dlg.open) b.dlg.close('save'); say(said); return; }
    // Something was refused: the list is read again, so each row is ticked as the server holds it, and the words stay.
    const again = await read(room);
    if (!again.error && current && current.room === room) { current.rows = again.rows; current.data = again.data; draw(); }
    b.said.textContent = said;
    say(said, true);
  }

  Object.assign(root.AGM = root.AGM || {}, { members: Object.freeze({ open, rowsFor, changeFor, words }) });
})(typeof window !== 'undefined' ? window : globalThis);
