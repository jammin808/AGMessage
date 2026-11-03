// The account area: every hall this account may see, as a board — each hall's countdown from its Stagewatch, who is in,
// its last message, open help requests and its screens — with the way into each: the hall's name opens its Main room,
// and its side rooms this account may enter are room buttons on its row. Side rooms it is given in halls it does not see
// are listed under Your rooms, by their hall's name. Project managers and senior techs see every hall; techs and staff
// see theirs. The board is live over the socket ('board:watch'); /api/halls is its first paint and its fallback. A
// hall's Set up holds its name, its own Stagewatch and its rooms (the catalogue's adminRoom, as the admin page's list).
(function () {
  'use strict';
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): its words, and nothing else
  const $ = (id) => document.getElementById(id);
  const esc = AGM.esc;
  AGM.theme();
  // A dialog's Cancel is a plain button, never its form's default, so Enter in a field saves: Cancel closes its dialog,
  // its returnValue 'cancel', and nothing is sent.
  for (const b of document.querySelectorAll('dialog button[value="cancel"]')) b.addEventListener('click', () => b.closest('dialog').close('cancel'));

  let me = null;
  let halls = [];          // from /api/halls: code, name, can{…}
  let live = {};           // code -> the board's live row (stage, last, help, displays, people)
  let helps = [];          // open help requests across the rooms this account reads, and its halls' side rooms' for their crew
  let canManageHalls = false;
  let isAdmin = false;     // /api/halls's: the admin, who switches and renews a room's code and removes a room in Set up
  let canManageUsers = false;   // /api/halls's: a room's Members… in Set up
  let canDrive = false;    // the board's: Show network lists a node this account may drive
  let yourRooms = [];      // side rooms this account may enter in halls it does not see: the board's, else /api/halls's

  // The acts on a hall's row and on a help request are the catalogue's (catalog.js: kinds hall, help), drawn by AGM.acts:
  // the bar, the ⋯, right-click, Shift+F10 and the keys alike. This page binds only what each act does (RUN).
  let F = AGM.catalog.boardFacts({});
  const RUN = {};
  const A = AGM.acts({ facts: () => F, run: RUN, say: (words, bad) => AGM.toast(words, bad) });
  function factsChanged() {
    F = AGM.catalog.boardFacts({ canManageHalls, isAdmin, canManageUsers, canDrive, connected: !!(socket && socket.connected) });
    render();
  }

  // ---------------------------------------------------------------- first paint
  async function load() {
    const r = await AGM.api('GET', '/api/halls');
    if (r.status === 401) { location.replace('/?next=/halls.html'); return; }
    if (r.mustChange) { location.replace('/'); return; }
    if (!r.ok) { AGM.toast(r.error, true); return; }
    me = r.account;
    halls = r.halls;
    canManageHalls = r.canManageHalls;
    isAdmin = r.isAdmin === true;
    canManageUsers = r.canManageUsers === true;
    yourRooms = Array.isArray(r.rooms) ? r.rooms : [];
    $('who').textContent = me.name + ' · ' + me.rights.roleLabel;
    $('pwUser').value = me.username;
    $('usersLink').hidden = !(r.canManageUsers || r.canAudit);
    $('adminLink').hidden = !r.isAdmin;
    $('newHallBtn').hidden = !canManageHalls;
    $('boardTitle').textContent = me.rights.allHalls ? 'Every hall' : (halls.length === 1 ? 'Your hall' : 'Your halls');
    factsChanged();
  }

  // ---------------------------------------------------------------- the board
  const STATE = {
    running: { mark: '▶', words: 'running' },
    paused: { mark: '⏸', words: 'held' },
    over: { mark: '■', words: 'over time' },
    idle: { mark: '○', words: 'not running' },
    stale: { mark: '?', words: 'link lost — last known' },
    checking: { mark: '…', words: 'checking Stagewatch\'s key' },
    refused: { mark: '✕', words: 'Stagewatch refused the key' },
    refusedView: { mark: '✕', words: 'Stagewatch refused the view (its viewing code)' },
    certificate: { mark: '✕', words: 'Stagewatch\'s certificate changed — an admin must accept it' },
    none: { mark: '○', words: 'no Stagewatch linked' },
  };
  function stageState(st) {
    if (!st || !st.status || st.status === 'off') return 'none';
    if (st.cert) return 'certificate';   // until an admin accepts it, whatever the key's verdict
    if (st.key === 'refused' && /^(key )?refused: /.test(st.status)) return /^refused: /.test(st.status) ? 'refusedView' : 'refused';
    if (st.status === 'checking key') return 'checking';
    if ((st.status !== 'connected' && st.status !== 'viewing') || st.stale) return 'stale';
    if (Number.isFinite(st.seconds) && st.seconds < 0) return 'over';
    if (st.state === 'running') return 'running';
    if (st.state === 'paused') return 'paused';
    return 'idle';
  }

  /** The rows, each kept by its code and drawn again in place, so a frame every second keeps the focus and an open menu. */
  function render() {
    const list = $('hallList');
    $('emptyNote').hidden = halls.length > 0;
    // Its words follow Your rooms as each frame brings them (a room given while the page is open).
    const empty = yourRooms.length ? 'No hall of your own: your rooms are below.' : 'No halls yet. An admin or project manager makes them, then gives you access.';
    if ($('emptyNote').textContent !== empty) $('emptyNote').textContent = empty;
    renderYourRooms();
    const keep = new Map([...list.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
    halls.forEach((h, i) => {
      const li = row(h, live[h.code] || {}, keep.get(h.code));
      keep.delete(h.code);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    for (const li of keep.values()) li.remove();
    renderHelp();
    A.refresh();
  }
  /**
   * A hall as the catalogue reads it: its key, its name, its guest code as the server tells this account ('' else), and
   * the side rooms of it this account may enter (Rooms ▸).
   */
  function hallObject(code) {
    const h = halls.find((x) => x.code === code);
    return h ? { code: h.code, name: h.name || h.code, guestCode: codeOf(h).guestCode, rooms: roomsOf(h).map((r) => ({ key: r.key, name: r.name, people: r.people })) } : null;
  }
  /**
   * A hall's side rooms this account may enter, with how many are in each and the seat it would join with there: the
   * board's live row (each room made, renamed, given or taken away reaches it), else the first paint's (/api/halls).
   */
  function roomsOf(h) {
    const l = live[h.code];
    const from = l && Array.isArray(l.rooms) ? l.rooms : Array.isArray(h.rooms) ? h.rooms : [];
    return from.filter((r) => r && typeof r.key === 'string').map((r) => ({ key: r.key, name: typeof r.name === 'string' ? r.name : '', people: Number.isInteger(r.people) ? r.people : 0, seat: r.seat === 'observer' ? 'observer' : 'research' }));
  }
  /** The way into a side room, as the server would seat this account there (a Member's seat, or an observer's). */
  const roomHref = (r) => '/app.html?' + new URLSearchParams({ code: r.key, as: 'account', role: r.seat }).toString();
  /** A side room's button words: its name, and how many are in when anyone is ("Legal 2 in"). */
  const roomWords = (r) => (r.name || 'A room') + (r.people ? ' ' + r.people + ' in' : '');
  /**
   * A hall's guest code and whether it admits guests: the board's live row (each switch and New code reach it), else the
   * first paint's (/api/halls); '' when this account may not know it.
   */
  function codeOf(h) {
    const l = live[h.code];
    const from = l && typeof l.guestCode === 'string' ? l : h;
    return { guestCode: typeof from.guestCode === 'string' ? from.guestCode : '', on: !!from.codeOn };
  }

  // The way into a hall, as this account may use it: backstage where it may post, read only where it may not (the
  // server seats it by its rights either way; the page is built for the role in its link). A side room, by its key: the
  // server seats it there, and the page opens again with that seat once if it differs.
  function hallHref(code) {
    const h = halls.find((x) => x.code === code);
    return '/app.html?' + new URLSearchParams({ code, as: 'account', role: !h || h.can.post ? 'research' : 'observer' }).toString();
  }

  /** Set a part's markup only when it changed, so nothing in it is drawn again for nothing. */
  const put = (el, partHtml) => { if (el.innerHTML !== partHtml) el.innerHTML = partHtml; };
  function row(h, l, had) {
    let li = had;
    if (!li) {
      li = document.createElement('li');
      li.className = 'hall-row';
      li.dataset.code = h.code;
      li.dataset.key = h.code;
      // The hall's name is the row's one link: its ::after covers the row, so a click, a middle click or a Ctrl+click
      // anywhere on it is the link's, and a screen reader reads it as the link it is.
      const open = document.createElement('a');
      open.className = 'hall-open';
      open.dataset.objectLink = '1';
      const clock = document.createElement('div'); clock.className = 'hall-clock';
      const last = document.createElement('div'); last.className = 'hall-last';
      const meta = document.createElement('div'); meta.className = 'hall-meta';
      // The hall's side rooms this account may enter, each a real link above the row's own (a middle click opens a tab).
      const rooms = document.createElement('div'); rooms.className = 'hall-rooms';
      const bar = document.createElement('span'); bar.className = 'obj-bar';
      li.append(open, clock, last, meta, rooms, bar);
    }
    const [open, clock, last, meta, rooms, bar] = li.children;
    const st = l.stage || null;
    const state = stageState(st);
    li.dataset.state = state;
    // Every open request of the hall's rooms this account is shown, its side rooms' too.
    const helpOpen = helps.filter((x) => (x.hall || x.code) === h.code).length;
    const timeHtml = st && st.text ? esc(st.text) : '--:--';
    const titleHtml = st && st.title ? esc(st.title) : '';
    // A chip's state is its words as well as its mark: in its title for a pointer, beside its name for a screen reader.
    const displaysHtml = (l.displays || []).map((d) => '<span class="disp-chip" data-ok="' + esc(d.state) + '" title="' + esc(d.words) + '">' + esc(d.mark) + ' ' + esc(d.name) + '<span class="sr-only">: ' + esc(d.words) + '</span></span>').join('');
    const href = hallHref(h.code);
    if (open.getAttribute('href') !== href) open.setAttribute('href', href);
    // The guest code, only where this account may know it, and "(off)" while it admits nobody new.
    const code = codeOf(h);
    put(open, '<span class="hall-name">' + esc(h.name || h.code) + '</span>' +
      (code.guestCode ? '<span class="hall-code" title="' + (code.on ? 'Guests without an account join with this code' : 'This code is off: nobody new joins with it') + '">' + esc(code.guestCode) + (code.on ? '' : ' (off)') + '</span>' : ''));
    // An unlinked hall says so quietly, with no clock to read.
    put(clock, state === 'none'
      ? '<span class="hall-state"><span aria-hidden="true">○</span> No Stagewatch linked</span>'
      : '<span class="hall-time" style="' + (st && st.color && !['stale', 'checking', 'refused', 'refusedView', 'certificate'].includes(state) ? 'color:' + esc(st.color) : '') + '">' + timeHtml + '</span>' +
        '<span class="hall-state"><span aria-hidden="true">' + esc(STATE[state].mark) + '</span> ' + esc(STATE[state].words) + (titleHtml ? ' — ' + titleHtml : '') + '</span>');
    clock.title = STATE[state].words;
    clock.dataset.none = state === 'none' ? '1' : '';
    put(last, l.last ? '<strong>' + esc(l.last.name) + '</strong> ' + esc(l.last.text) + ' <time>' + esc(AGM.ago(l.last.at)) + '</time>' : '<span class="muted">No messages yet</span>');
    put(meta, '<span title="People in the hall now">' + esc(String(l.people ?? h.people)) + ' in</span>' +
      (helpOpen ? '<span class="help-count" title="Open help requests">■ ' + esc(String(helpOpen)) + (helpOpen === 1 ? ' needs help' : ' need help') + '</span>' : '') +
      displaysHtml + nodesHtml(l.nodes));
    drawRoomButtons(rooms, roomsOf(h), h.name || h.code);
    A.draw(bar, 'hall', hallObject(h.code), { more: 'Actions for ' + (h.name || h.code), keysOn: li });
    return li;
  }
  /** A row's room buttons, each kept by its key and changed in place, so a frame every second moves no focus. */
  function drawRoomButtons(box, list, hallName) {
    box.hidden = !list.length;
    const keep = new Map([...box.querySelectorAll(':scope > a[data-key]')].map((a) => [a.dataset.key, a]));
    list.forEach((r, i) => {
      let a = keep.get(r.key);
      keep.delete(r.key);
      if (!a) { a = document.createElement('a'); a.className = 'room-btn'; a.dataset.key = r.key; }
      const href = roomHref(r);
      if (a.getAttribute('href') !== href) a.setAttribute('href', href);
      if (a.textContent !== roomWords(r)) a.textContent = roomWords(r);
      // Its name to a screen reader starts with the words it shows (WCAG 2.5.3), then says whose room it is.
      const named = roomWords(r) + ', a room of ' + hallName + (r.seat === 'observer' ? ', to read' : '');
      if (a.getAttribute('aria-label') !== named) a.setAttribute('aria-label', named);
      if (box.children[i] !== a) box.insertBefore(a, box.children[i] || null);
    });
    for (const a of keep.values()) a.remove();
  }
  /**
   * Your rooms: the side rooms this account may enter in halls it does not see, each by its name and its hall's (never
   * the hall's key), how many are in, and its way in.
   */
  function renderYourRooms() {
    const ul = $('yourRoomList');
    $('yourRooms').hidden = yourRooms.length === 0;
    const keep = new Map([...ul.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
    yourRooms.forEach((x, i) => {
      const r = { key: x.key, name: typeof x.name === 'string' ? x.name : '', people: Number.isInteger(x.people) ? x.people : 0, seat: x.seat === 'observer' ? 'observer' : 'research' };
      let li = keep.get(r.key);
      keep.delete(r.key);
      if (!li) {
        li = document.createElement('li');
        li.className = 'your-room';
        li.dataset.key = r.key;
        const a = document.createElement('a'); a.className = 'your-room-open';
        const where = document.createElement('span'); where.className = 'muted your-room-hall';
        li.append(a, where);
      }
      const [a, where] = li.children;
      const href = roomHref(r);
      if (a.getAttribute('href') !== href) a.setAttribute('href', href);
      if (a.textContent !== roomWords(r)) a.textContent = roomWords(r);
      const hallWords = (typeof x.hallName === 'string' && x.hallName) || 'A hall with no name';
      if (where.textContent !== hallWords) where.textContent = hallWords;
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    });
    for (const li of keep.values()) li.remove();
  }

  // ---------------------------------------------------------------- a hall's set-up: its name and its own Stagewatch
  let setupCode = '';
  function openSetup(code) {
    if (!socket) return;
    socket.emit('hall:settings', { code }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not available.', true); return; }
      setupCode = code;
      $('setupTitle').textContent = 'Set up ' + (r.name || r.code);
      $('setupName').value = r.name;
      $('setupUrl').value = r.stagewatch.url;
      $('setupKey').value = '';
      $('setupKey').placeholder = r.stagewatch.keySet ? 'A key is saved — type a new one to replace it' : 'swk_… (Stagewatch → Settings → Remote → API keys, scope node)';
      $('setupFp').value = r.stagewatch.fp;
      $('setupDefault').textContent = r.defaultStagewatch ? 'Leave it empty to follow the default Stagewatch (' + r.defaultStagewatch + ').' : 'Leave it empty for no Stagewatch.';
      const status = r.stagewatch.status;
      $('setupStatus').textContent = status ? 'Its own link: ' + status + (r.stagewatch.tls && r.stagewatch.tls.changed ? ' — CERTIFICATE CHANGED' : '')
        + (r.stagewatch.key && r.stagewatch.key.state === 'refused' ? ' — make a node key in Stagewatch (Settings → Remote → API keys) and enter it here' : '')
        + (r.stagewatch.deskRefusal ? ' — its show desk refuses this AGMessage (' + r.stagewatch.deskRefusal + '): give AGMessage a node key of its own' : '') : '';
      $('setupAccept').hidden = !(r.stagewatch.tls && r.stagewatch.tls.changed);
      const list = $('setupHeard');
      list.textContent = '';
      for (const p of r.stagewatches) {
        const port = (p.ports && (p.ports.http || p.ports.https)) || 9924;
        const b2 = document.createElement('button');
        b2.type = 'button'; b2.className = 'btn small';
        b2.textContent = (p.name || p.host || p.address) + ' (' + p.address + ':' + port + ')' + (p.status === 'live' ? '' : ' — not heard for ' + p.age + ' s');
        b2.onclick = () => { $('setupUrl').value = p.address + ':' + port; if (p.tls) $('setupFp').value = p.tls; };
        list.appendChild(b2);
      }
      $('setupHeardWrap').hidden = !r.stagewatches.length;
      $('setupError').hidden = true;
      readSetupRooms(code).then((rooms) => {
        setupRooms = rooms.ok ? rooms : { hall: code, hallName: r.name || '', rooms: [], error: rooms.error };
        setupSeen = roomsSeen(live[code]);
        drawSetupRooms();
        AGM.openDialog($('setupDialog'));
      });
    });
  }

  // ---------------------------------------------------------------- a hall's set-up: its rooms
  // Each of the hall's rooms (room:settings: its Main room first, then the rooms beside it in the order they were made),
  // with its guest code as this account may be told it, whether it admits guests and the guest pages in it; each act on
  // one is the catalogue's adminRoom, drawn by its ⋯, right-click and Shift+F10, and done at once (Save is for the name
  // and the Stagewatch above): a room made and renamed by those who set halls up, its code switched and renewed and the
  // room removed by the admin, its accounts chosen with Members… by whoever manages accounts (or on the Accounts page).
  // The list is read when Set up opens, again after an act made here, and again when a board frame shows this hall's code
  // or the rooms of it this account may enter changed (`roomsSeen`): a room made, renamed or removed by another page in a
  // hall whose side rooms this account is not given shows at the next of those, and an act on a row gone by then is
  // refused by the server ("No such room."). A read refused, or not answered, is said in place of the list.
  let setupRooms = null;   // room:settings' answer for the hall in Set up: {hall, hallName, rooms}, or with `error`
  let setupSeen = '';      // what the board's row of that hall said of its code and rooms when the list was last read
  function readSetupRooms(code) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) { resolve({ ok: false, error: 'Not connected.' }); return; }
      socket.emit('room:settings', { code }, (r) => resolve(r && r.ok ? r : { ok: false, error: (r && r.error) || 'No answer.' }));
    });
  }
  /** What a board row says of its hall's code and of the rooms of it this account may enter: their keys and names. */
  const roomsSeen = (row) => (row ? JSON.stringify([row.guestCode, row.codeOn, (Array.isArray(row.rooms) ? row.rooms : []).map((r) => [r.key, r.name])]) : '');
  /** A room of Set up as the catalogue reads it (as the admin page's list does), by its key. */
  function setupRoomObject(key) {
    const r = setupRooms && Array.isArray(setupRooms.rooms) ? setupRooms.rooms.find((x) => x.key === key) : null;
    if (!r) return null;
    const hallName = setupRooms.hallName || 'This hall';
    return {
      code: r.key, name: r.name || '', hall: r.main ? hallName : hallName + ' › ' + (r.name || r.key), main: !!r.main, watched: false,
      guestCode: typeof r.guestCode === 'string' ? r.guestCode : '', on: !!r.codeOn, guests: Number.isInteger(r.guests) ? r.guests : null, codeIsKey: !!r.main && r.guestCode === r.key,
    };
  }
  /**
   * The hall of Set up as the catalogue reads its Main room: its row when the list holds it, else made from the hall's key
   * and name (a read refused), so + Add room follows the facts and the hall, never a row that is missing.
   */
  function setupHallObject() {
    if (!setupRooms) return null;
    const main = Array.isArray(setupRooms.rooms) ? setupRooms.rooms.find((x) => x.main) : null;
    if (main) return setupRoomObject(main.key);
    const hallName = setupRooms.hallName || 'This hall';
    return { code: setupRooms.hall, name: hallName, hall: hallName, main: true, watched: false, guestCode: '', on: false, guests: null, codeIsKey: false };
  }
  /** A room's code as its row says it: the code where this account is told it, and whether it admits guests now. */
  const setupCodeWords = (o) => (o.guestCode ? 'code ' + o.guestCode + (o.on ? '' : ' (off)') : o.on ? 'code on' : 'code off')
    + (o.guests ? ' · ' + o.guests + (o.guests === 1 ? ' guest page' : ' guest pages') + ' in' : '');
  function drawSetupRooms() {
    const ul = $('setupRooms');
    const list = setupRooms && Array.isArray(setupRooms.rooms) ? setupRooms.rooms : [];
    $('setupRoomsWords').textContent = (setupRooms && setupRooms.error ? 'The rooms could not be read: ' + setupRooms.error + ' ' : '')
      + 'Done at once. Each room beside the Main room has its own messages, people and guest code, off until the admin turns it on. '
      + (F.manageUsers ? 'Its members are chosen on the Accounts page, or with Members… on its ⋯ (Board members… on the Main room: who sits On stage).' : 'Its members are chosen on the Accounts page.');
    const keep = new Map([...ul.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
    list.forEach((r, i) => {
      let li = keep.get(r.key);
      keep.delete(r.key);
      if (!li) {
        li = document.createElement('li');
        li.className = 'setup-room';
        li.dataset.key = r.key;
        const name = document.createElement('span'); name.className = 'setup-room-name';
        const code = document.createElement('span'); code.className = 'muted setup-room-code';
        const bar = document.createElement('span'); bar.className = 'obj-bar';
        li.append(name, code, bar);
      }
      const o = setupRoomObject(r.key);
      const [name, code, bar] = li.children;
      const nameWords = o.main ? 'Main room' : o.name || 'A room';
      if (name.textContent !== nameWords) name.textContent = nameWords;
      if (code.textContent !== setupCodeWords(o)) code.textContent = setupCodeWords(o);
      A.draw(bar, 'adminRoom', o, { more: (o.main ? 'Main room actions' : 'Actions for ' + (o.name || 'this room')), keysOn: li });
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    });
    for (const li of keep.values()) li.remove();
    // + Add room is a door to the Main room's New room in this hall…: shown where that act is, by the facts and the hall.
    const hall = setupHallObject();
    $('setupAddRoom').hidden = !(hall && AGM.catalog.shown('adminRoom', F, hall).some((e) => e.id === 'adminRoom.create'));
    A.refresh();
  }
  /**
   * Set up's rooms read again and drawn in place (after an act made here, or a board frame that shows a change): the answer
   * is the server's; a refusal keeps the rows drawn and says why above them.
   */
  function refreshSetupRooms() {
    if (!setupRooms) return;
    const code = setupRooms.hall;
    readSetupRooms(code).then((r) => {
      if (!setupRooms || setupRooms.hall !== code) return;
      setupRooms = r.ok ? r : { ...setupRooms, error: r.error };
      drawSetupRooms();
    });
  }
  $('setupAddRoom').addEventListener('click', () => {
    const o = setupHallObject();
    if (o) A.act('adminRoom', 'adminRoom.create', o, { anchor: $('setupAddRoom'), opener: $('setupAddRoom'), get: () => (setupRooms && setupRooms.hall === o.code ? setupHallObject() : null), gone: 'That hall is gone.' });
  });
  /** A refusal said, or what was done, and Set up's rooms read again. */
  const roomDone = (fail, done) => (res) => {
    if (!res || !res.ok) { AGM.toast((res && res.error) || fail, true); return; }
    done(res);
    refreshSetupRooms();
  };
  Object.assign(RUN, {
    'adminRoom.create': (o, c) => AGM.outbox.now('room:create', { hall: o.code, name: (c.values && c.values.name) || '' }, roomDone('Not made.', (res) => AGM.toast('Made ' + res.name + ' in ' + o.hall + ': its guest code is off.'))),
    'adminRoom.rename': (o, c) => AGM.outbox.now('room:update', { code: o.code, name: (c.values && c.values.name) || '' }, roomDone('Not renamed.', (res) => AGM.toast(res.already ? 'It is called ' + res.name + ' already.' : 'Renamed ' + res.name + '.'))),
    'adminRoom.codeToggle': (o, c) => AGM.outbox.now('room:update', o.on ? { code: o.code, codeOn: false, keepGuests: c.choice !== 'out' } : { code: o.code, codeOn: true }, roomDone('Not changed.', (res) => {
      const n = (k) => k + (k === 1 ? ' guest page' : ' guest pages');
      AGM.toast(res.codeOn ? 'The guest code of ' + o.hall + ' is on.'
        : Number.isInteger(res.sentOut) ? 'The guest code of ' + o.hall + ' is off: ' + n(res.sentOut) + ' sent out.'
          : 'The guest code of ' + o.hall + ' is off' + (Number.isInteger(res.kept) ? ': ' + n(res.kept) + ' stay.' : '.'));
    })),
    'adminRoom.newCode': (o) => AGM.outbox.now('room:update', { code: o.code, newCode: true }, roomDone('No new code.', (res) => AGM.toast('The new guest code of ' + o.hall + ' is ' + res.guestCode + '.'))),
    'adminRoom.remove': (o, c) => AGM.outbox.now('admin:deleteRoom', { roomCode: o.code, purgeFiles: !!(c.values && c.values.purge) }, roomDone('Not removed.', (res) => AGM.toast(res.keptWords ? 'Removed. ' + res.keptWords : 'Removed ' + o.hall + '.', !!res.keptWords))),
    'adminRoom.members': (o) => AGM.members.open({ code: o.code, name: o.name, hall: o.hall, main: o.main, hallName: (setupRooms && setupRooms.hallName) || o.hall }, { say: (w, bad) => AGM.toast(w, bad) }),
  });
  A.bind($('setupRooms'), { kind: 'adminRoom', find: (el) => el.closest('#setupRooms > li[data-key]'), get: setupRoomObject, label: (o) => (o.main ? 'Main room actions' : 'Room actions'), gone: 'That room is gone.', header: (o) => o.hall });
  AGM.roving($('setupRooms'), { item: 'li[data-key]' });
  $('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = { code: setupCode, name: $('setupName').value.trim(), stagewatchUrl: $('setupUrl').value.trim(), stagewatchFingerprint: $('setupFp').value.trim() };
    if ($('setupKey').value.trim()) patch.stagewatchKey = $('setupKey').value.trim();
    AGM.outbox.now('hall:configure', patch, (r) => {
      if (!r || !r.ok) { $('setupError').textContent = (r && r.error) || 'Not saved.'; $('setupError').hidden = false; return; }
      $('setupDialog').close();
      AGM.toast(r.changed.length ? 'Saved: ' + r.changed.join('; ') : 'Nothing changed.');
      load();
    });
  });
  $('setupAccept').addEventListener('click', () => AGM.outbox.now('hall:acceptCertificate', { code: setupCode }, (r) => AGM.toast(r && r.ok ? 'New certificate accepted.' : (r && r.error) || 'Not accepted.', !(r && r.ok))));

  const LIGHT_MARK = { green: '✓', amber: '△', red: '✕', grey: '○' };
  /** A linked Patterns or PlayMap as a chip: its light in a shape and its name; its headline on hover. */
  function nodesHtml(list) {
    return (list || []).map((n) => { const words = (n.t === 'playmap' ? 'PlayMap' : 'Patterns') + ' — ' + (n.headline || n.status); return '<span class="node-chip" data-light="' + esc(n.light) + '" title="' + esc(words) + '">' + esc(LIGHT_MARK[n.light] || '○') + ' ' + esc(n.name) + '<span class="sr-only">: ' + esc(words) + '</span></span>'; }).join('');
  }

  // ---------------------------------------------------------------- the show network: Patterns and PlayMap, and their verbs
  const RISK = { low: '● low', review: '▲ review', high: '■ high' };
  function openNetwork() {
    socket.emit('nodes:list', {}, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not available.', true); return; }
      const box = $('networkList');
      box.textContent = '';
      if (!r.linked.length) { const p = document.createElement('p'); p.className = 'empty-note'; p.textContent = 'No Patterns or PlayMap is linked yet — the admin links them on the admin page.'; box.appendChild(p); }
      for (const n of r.linked) box.appendChild(nodeCard(n, n.desk));   // Propose only where its own hall keeps a show desk
      AGM.openDialog($('networkDialog'));
    });
  }
  /** A node's items that need attention, as list rows built from escaped parts. */
  function itemsHtml(items) {
    return items.map((i) => '<li data-light="' + esc(i.light) + '">' + esc(LIGHT_MARK[i.light]) + ' <strong>' + esc(i.label) + '</strong> ' + esc(i.state) + '</li>').join('');
  }
  function nodeCard(n, desk) {
    const sec = document.createElement('section');
    sec.className = 'node-card';
    sec.dataset.light = n.light;
    const items = (n.items || []).filter((i) => i.light === 'red' || i.light === 'amber').slice(0, 6);
    sec.innerHTML =
      '<h3><span aria-hidden="true">' + esc(LIGHT_MARK[n.light] || '○') + '</span> ' + esc(n.name) + ' <small class="muted">' + esc(n.t === 'playmap' ? 'PlayMap' : 'Patterns') + ' · ' + esc(n.status) + (n.hall ? ' · ' + esc(n.hall) : '') + '</small></h3>' +
      '<p class="node-headline">' + esc(n.headline || n.problem || 'No word from it yet.') + '</p>' +
      (items.length ? '<ul class="node-items">' + itemsHtml(items) + '</ul>' : '');
    const form = document.createElement('form');
    form.className = 'node-cmd';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Verb');
    for (const c of n.commands) { const o = document.createElement('option'); o.value = c.verb; o.dataset.risk = c.risk; o.textContent = RISK[c.risk] + ' — ' + c.verb + (c.words ? ' (' + c.words + ')' : ''); sel.appendChild(o); }
    const line = document.createElement('input');
    line.maxLength = 400; line.placeholder = 'The line to propose, e.g. ' + (n.commands[0] ? n.commands[0].verb : 'a verb it lists');
    line.setAttribute('aria-label', 'Line');
    // Only proposed: AGMessage holds just the node's pairing token (full control of it), so a person at the show desk
    // approves each line and the node collects it with its own key — nothing here drives it directly.
    const propose = document.createElement('button'); propose.type = 'submit'; propose.className = 'btn small primary'; propose.textContent = 'Propose';
    propose.title = 'To the show desk: a person approves it in Stagewatch, then ' + n.name + ' runs it';
    const out = document.createElement('p'); out.className = 'hint node-out';
    const fill = () => {
      const c = n.commands.find((x) => x.verb === sel.value);
      if (!c) return;
      line.value = c.verb.split(/\s+/).filter((w) => !/^[<[{(]/.test(w)).join(' ').replace(/\s*[<[{(].*$/, '').trim() + ' ';
    };
    sel.onchange = () => { fill(); line.focus(); };
    if (n.commands.length) fill(); else { line.disabled = true; propose.disabled = true; line.placeholder = 'It lists no verbs yet.'; }
    if (!desk) { propose.disabled = true; out.textContent = 'Lines to ' + n.name + ' go to the show desk, and ' + (n.hall ? 'its hall\'s' : 'the default') + ' Stagewatch keeps none — nothing can be proposed now.'; }
    form.onsubmit = (e) => {
      e.preventDefault();
      AGM.outbox.now('nodes:command', { id: n.id, line: line.value.trim(), mode: 'propose' }, (r) => {
        out.dataset.ok = r && r.ok ? '1' : '0';
        out.textContent = !r ? 'No answer.' : !r.ok ? '✕ ' + r.error : '▲ Proposed to the show desk (' + r.proposal.id + ', ' + r.risk + ' risk) — a person approves it in Stagewatch.';
      });
    };
    form.append(sel, line, propose);
    sec.append(form, out);
    return sec;
  }
  $('networkBtn').addEventListener('click', openNetwork);
  $('networkClose').addEventListener('click', () => $('networkDialog').close());

  /** Where a help request is: its hall's name, and a side room's after it ("Hall 2 › Legal"). */
  const whereOf = (x) => (x.hallName || x.hall || x.code) + (x.roomName ? ' › ' + x.roomName : '');
  /**
   * A help request as the catalogue reads it, by its key ('<room>|<id>'): its room's key, id, state, whether this account
   * answers it and may open its room, where it is, and whether that is a side room (`room`, its name; '' for Main).
   */
  function helpObject(key) {
    const x = helps.find((h) => h.code + '|' + h.id === key);
    return x ? { code: x.code, id: x.id, state: x.state, canRespond: !!x.canRespond, canOpen: !!x.canOpen, hall: whereOf(x), room: x.roomName || '', category: x.category } : null;
  }
  /** The open help requests, each kept by its key and drawn again in place: its words, its answers and its ⋯. */
  function renderHelp() {
    const strip = $('helpStrip');
    strip.hidden = helps.length === 0;
    const ul = $('helpList');
    const keep = new Map([...ul.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
    helps.forEach((x, i) => {
      const key = x.code + '|' + x.id;
      let li = keep.get(key);
      keep.delete(key);
      if (!li) {
        li = document.createElement('li');
        li.className = 'help-item';
        li.dataset.key = key;
        const where = document.createElement('span'); where.className = 'help-where';
        const what = document.createElement('span'); what.className = 'help-what';
        const who = document.createElement('span'); who.className = 'help-who';
        const open = document.createElement('a'); open.className = 'btn small help-open'; open.dataset.objectLink = '1';
        const held = document.createElement('span'); held.className = 'help-held'; held.hidden = true;
        const bar = document.createElement('span'); bar.className = 'obj-bar';
        li.append(where, what, who, open, held, bar);
      }
      const [where, what, who, open, held, bar] = li.children;
      li.dataset.state = x.state;
      if (where.textContent !== whereOf(x)) where.textContent = whereOf(x);
      // A side room's request reaches the hall's crew who may not read the room without its words: its category says what.
      put(what, '<strong>' + esc(x.category) + '</strong> ' + esc(x.text));
      const whoWords = x.from + ' · ' + AGM.ago(x.at) + (heldWords(x) ? ' · ' + heldWords(x) : '') + (x.by ? ' · ' + x.by + (x.state === 'coming' ? ' is on the way' : '') : '');
      if (who.textContent !== whoWords) who.textContent = whoWords;
      // The way into its room, only where this account may open it (a side room's crew answer from here).
      open.hidden = !x.canOpen;
      const openWords = x.roomName ? 'Open its room' : 'Open its hall';
      if (open.textContent !== openWords) open.textContent = openWords;
      const href = hallHref(x.code);
      if (open.getAttribute('href') !== href) open.setAttribute('href', href);
      // An answer held by the outbox until the server has it says so beside the answers.
      const mine = heldAnswers.get(key);
      held.hidden = !mine;
      held.textContent = mine ? '◷ ' + (mine === 'coming' ? 'On my way' : 'Resolved') + ': sent when the connection is back' : '';
      A.draw(bar, 'help', helpObject(key), { more: 'Actions for this help request', words: true, cls: 'btn small primary', keysOn: li });
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    });
    for (const li of keep.values()) li.remove();
  }
  /** "written 14:02 · sent 14:06 (offline)" for a help request its page held before sending it, else ''. */
  function heldWords(x) {
    if (!Number.isInteger(x.held) || x.held <= 0) return '';
    const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return 'written ' + t(x.at - x.held * 1000) + ' · sent ' + t(x.at) + ' (offline)';
  }
  // An answer to a help request is held by the outbox until the server has it (its button marked ◷ meanwhile).
  const heldAnswers = new Map();   // '<room>|<id>' -> the state this person's held answer says
  Object.assign(RUN, {
    'help.respond': (o) => AGM.outbox.hold('help:respond', { code: o.code, messageId: o.id, state: 'coming' }),
    'help.resolve': (o) => AGM.outbox.hold('help:respond', { code: o.code, messageId: o.id, state: 'resolved' }),
    'help.open': (o) => { location.href = hallHref(o.code); },
    'hall.open': (o) => { location.href = hallHref(o.code); },
    'hall.tab': (o) => { window.open(hallHref(o.code), '_blank', 'noopener'); },
    'hall.copy': (o, c) => AGM.copy(new URL(hallHref(o.code), location.href).href, { said: 'Copied the link to ' + o.name + '.', anchor: c.anchor, say: (w) => AGM.toast(w) }),
    'hall.code': (o, c) => AGM.copy(o.guestCode, { said: 'Copied ' + o.name + '\'s guest code, ' + o.guestCode + '.', anchor: c.anchor, say: (w) => AGM.toast(w) }),
    'hall.rooms': (o, c) => { const h = halls.find((x) => x.code === o.code); const r = h && roomsOf(h).find((x) => x.key === c.value); if (r) location.href = roomHref(r); },
    'hall.setup': (o) => openSetup(o.code),
    'hall.network': () => openNetwork(),
  });
  A.bind($('hallList'), { kind: 'hall', find: (el) => el.closest('#hallList > li[data-key]'), get: hallObject, label: 'Hall actions', gone: 'That hall is gone.', header: (o) => o.name + (o.guestCode ? ' · ' + o.guestCode : '') });
  A.bind($('helpList'), { kind: 'help', find: (el) => el.closest('#helpList > li[data-key]'), get: helpObject, label: 'Help request actions', gone: 'That help request is gone: it was resolved or removed.', header: (o) => o.category + ' · ' + o.hall });
  AGM.roving($('hallList'), { item: 'li[data-key]' });
  AGM.roving($('helpList'), { item: 'li[data-key]' });
  // What this page's acts read, by name: its facts and its objects (the browser smoke reads them to hold the doors to the catalogue).
  AGM.page = Object.freeze({ facts: () => F, object: (kind, key) => (kind === 'hall' ? hallObject(key) : kind === 'help' ? helpObject(key) : kind === 'adminRoom' ? setupRoomObject(key) : null) });
  function drawHeld(item) {
    if (item.verb !== 'help:respond') return;
    const k = item.args.code + '|' + item.args.messageId;
    if (item.state === 'waiting' || item.state === 'sending') heldAnswers.set(k, item.args.state);
    else heldAnswers.delete(k);
    if (item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
    renderHelp();
  }

  // ---------------------------------------------------------------- live (the board over the socket)
  let socket = null;
  function connect() {
    if (typeof io !== 'function') return;
    // Back by itself (reconnect.js): a refusal is tried again at the server's pace, its wait said in the strip.
    socket = io({ transports: ['websocket', 'polling'], auth: AGM.reconnect.auth(), ...AGM.reconnect.OPTIONS });
    AGM.reconnect.attach(socket, { strip: $('connStrip') });
    AGM.outbox.attach(socket, { onChange: drawHeld });
    const ls = $('linkState');
    socket.on('connect', () => {
      ls.dataset.ok = '1'; ls.textContent = '● Live';
      factsChanged();
      socket.emit('board:watch', {}, (r) => {
        if (r && r.ok) { applyBoard(r.board); AGM.outbox.ready({ scope: 'board', who: me ? me.username : '' }); AGM.reconnect.build.heard(r.build); } else if (r && r.error) AGM.toast(r.error, true);
      });
    });
    // On another build than its server's, the board reloads itself (reconnect.js) at a quiet moment: connected and
    // watching, no answer held and no act waiting on its answer, no dialog, menu or ask open, and untouched for a few
    // seconds (or not shown).
    AGM.reconnect.build.when((t) => AGM.reconnect.QUIET.halls({
      ...t, online: AGM.outbox.online, held: AGM.outbox.items().length > 0 || AGM.outbox.acting() > 0,
      dialog: !!document.querySelector('dialog[open]') || AGM.menu.isOpen() || AGM.ask.isOpen(),
    }), { stays: (words) => AGM.toast(words) });
    socket.on('disconnect', () => { ls.dataset.ok = '0'; ls.textContent = '○ Reconnecting'; factsChanged(); });
    socket.on('board', applyBoard);
    socket.on('nodes:changed', () => { if ($('networkDialog').open) openNetwork(); });
    socket.on('account:changed', ({ words } = {}) => { AGM.toast(words || 'Your account was changed — reloading.'); setTimeout(() => location.reload(), 1200); });
  }
  function applyBoard(b) {
    if (!b) return;
    live = {};
    for (const r of b.halls || []) live[r.code] = r;
    helps = b.help || [];
    yourRooms = Array.isArray(b.yourRooms) ? b.yourRooms : [];
    // Show network opens nodes:list, which lists the nodes this account may drive: offered only when there is one (a
    // hall's crew still sees its nodes' lights on the hall's row).
    $('networkBtn').hidden = !b.canDrive;
    canDrive = !!b.canDrive;
    const known = new Set(halls.map((h) => h.code));
    if ((b.halls || []).some((r) => !known.has(r.code)) || (b.halls || []).length !== halls.length) { load(); return; }
    if (setupRooms && $('setupDialog').open) {
      const seen = roomsSeen(live[setupRooms.hall]);
      if (seen !== setupSeen) { setupSeen = seen; refreshSetupRooms(); }
    }
    factsChanged();
  }
  // Each Stagewatch sends a frame about every second while it runs, and the board is pushed on every change, so the clock
  // shown is Stagewatch's own words (a calm "12 MIN" stays "12 MIN"), never a guess made here.

  // ---------------------------------------------------------------- account actions
  $('signOutBtn').addEventListener('click', async () => { await AGM.api('POST', '/api/auth/logout'); location.replace('/'); });
  $('passwordBtn').addEventListener('click', () => { $('pwError').hidden = true; $('passwordForm').reset(); AGM.openDialog($('passwordDialog')); });
  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await AGM.api('POST', '/api/auth/password', { current: $('pwCurrent').value, next: $('pwNext').value });
    if (!r.ok) { $('pwError').textContent = r.error; $('pwError').hidden = false; return; }
    $('passwordDialog').close();
    AGM.toast('Password saved. Your other devices are signed out.');
  });
  $('newHallBtn').addEventListener('click', () => { $('hallForm').reset(); AGM.openDialog($('hallDialog')); });
  $('hallForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await AGM.api('POST', '/api/rooms', { name: $('hallName').value.trim() });
    if (!r.code) { AGM.toast(r.error || 'Not created.', true); return; }
    $('hallDialog').close();
    AGM.toast('Created ' + (r.name || r.code) + ' — guest code ' + r.code + '.');
    load();
  });

  load().then(connect);
})();
