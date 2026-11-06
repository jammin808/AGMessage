// AGMessage admin client.
//
// Flow:
//   1. POST the admin token to /api/admin/login (only allowed from localhost).
//   2. Server sets an HttpOnly cookie (`agm_admin`).
//   3. Open a Socket.io connection — the cookie is sent automatically.
//   4. Server marks the socket as admin and accepts admin:* events.
//
// Every act on a hall, a person, a message of the live feed, a link and the internet link is a row of the catalogue
// (catalog.js: kinds adminRoom, person, adminMsg, link, tunnel), drawn by AGM.acts (menus.js): the bar, the ⋯,
// right-click, Shift+F10 and its keys alike; this page binds only what each act does (ADMIN_RUN). Nothing here opens a
// native alert, confirm or prompt: a paused page drops its socket. What asks first asks in place (AGM.ask).

AGM.theme();

const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginNotice = document.getElementById('loginNotice');
const loginError = document.getElementById('loginError');
const tokenInput = document.getElementById('tokenInput');
const loginForm = document.getElementById('loginForm');

let socket = null;
let allRooms = [];
let currentRoom = null;

// ---------------- The page's facts, and its acts ----------------
// What the server told this page: whom its gate admits (/api/admin/me), "the admin", whether its account may manage
// accounts (a room's Members…), whether AI drafts are on, the halls a node may be linked for, and whether it is connected
// now. A change redraws every bar and the open menu in place.
const adminState = { ok: false, admin: false, manageUsers: false, ai: false, halls: [], connected: false };
let ADMIN_F = AGM.catalog.adminFacts(adminState);
const ADMIN_RUN = {};
const say = (words, bad) => AGM.toast(words, bad);
// Long enough to read a sentence about files left on disk before the page starts afresh.
const KEPT_READ_MS = 8000;
/** The server's refusal said, or its words when it gave none. */
const saidIfNot = (words) => (res) => { if (!res || !res.ok) say((res && res.error) || words, true); };
const ADMIN = AGM.acts({ facts: () => ADMIN_F, run: ADMIN_RUN, say });
/** The page's facts changed: each bar is drawn again (in place) and the open menu says what it says now. */
function adminFactsChanged(patch) {
  Object.assign(adminState, patch);
  ADMIN_F = AGM.catalog.adminFacts(adminState);
  drawAdminBars();
  ADMIN.refresh();
}
/** Every bar of the page from the catalogue, as the facts and objects are now. */
function drawAdminBars() {
  for (const li of document.querySelectorAll('#roomList > li[data-key]')) { const o = roomObject(li.dataset.key); if (o) ADMIN.draw(li.querySelector('.obj-bar'), 'adminRoom', o, { more: actionsOf(o), keysOn: li }); }
  const head = document.getElementById('roomHeader');
  const watched = currentRoom && roomObject(head.dataset.key || '');
  if (watched) ADMIN.draw(document.getElementById('roomActs'), 'adminRoom', watched, { more: actionsOf(watched), keysOn: head });
  for (const tr of document.querySelectorAll('#usersTbody > tr[data-key]')) { const o = personObject(tr.dataset.key); if (o) ADMIN.draw(tr.querySelector('.obj-bar'), 'person', o, { more: 'Actions for ' + o.name, keysOn: tr }); }
  for (const div of document.querySelectorAll('#adminFeed > .admin-msg[data-key]')) { const o = feedObject(div.dataset.key); if (o) ADMIN.draw(div.querySelector('.obj-bar'), 'adminMsg', o, { more: 'Message actions', keysOn: div }); }
  for (const draw of ADMIN_DRAWERS) draw();
}
/** The page's other parts that draw bars of their own (the links, the internet link), drawn again with the rest. */
const ADMIN_DRAWERS = [];

(async function init() {
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): its words, and nothing asked
  // First, check if we're already logged in (cookie set) and on the host
  const me = await fetch('/api/admin/me').then((r) => r.json()).catch(() => ({}));
  // An admin account works from any device on the venue network; the host's token only on the host laptop.
  if (me.ok) { adminState.ok = true; adminState.admin = !!me.admin; adminState.manageUsers = me.manageUsers === true; showDashboard(); return; }
  loginPanel.hidden = false;
  if (!me.local) {
    loginNotice.innerHTML =
      '<strong>Sign in with an admin account to use this page here.</strong> ' +
      '<a href="/?next=/admin.html">Sign in</a> — or open it on the AGMessage laptop and use the admin token.';
    tokenInput.disabled = true;
    document.querySelector('#loginForm button').disabled = true;
    return;
  }
  tokenInput.focus();
})();

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const tok = tokenInput.value.trim();
  if (!tok) return;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tok }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.ok) {
    location.reload();
  } else {
    loginError.textContent = data.error || 'Login failed';
    loginError.hidden = false;
    tokenInput.select();
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  location.reload();
});

// ---------------- Dashboard ----------------
function showDashboard() {
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): no socket
  loginPanel.hidden = true;
  dashboard.hidden = false;
  for (const id of ['newSessionBtn', 'logoutBtn', 'adminStatus']) document.getElementById(id).hidden = false;
  // Back by itself (reconnect.js): a refusal is tried again at the server's pace, its wait said in the strip.
  socket = io({ auth: AGM.reconnect.auth(), ...AGM.reconnect.OPTIONS });
  AGM.reconnect.attach(socket, { strip: document.getElementById('connStrip') });
  // The admin's acts go through the outbox (outbox.js) as acts on something: refused at once while the page is not
  // connected, "No answer" when the server says nothing in 5 s, never sent late.
  AGM.outbox.attach(socket);
  // A sign-out in another tab, a change to this account or admin through the tunnel turned off closes this socket: the
  // page starts again and asks for what it needs. After a restart it reconnects by itself; it starts again only when
  // its sign-in no longer holds (a new admin token), never on a failed check.
  socket.on('account:changed', () => { setTimeout(() => location.reload(), 300); });
  let connectedOnce = false;
  socket.on('connect', async () => {
    if (connectedOnce) {
      const now = await fetch('/api/admin/me').then((r) => r.json()).catch(() => ({ ok: true }));
      if (!now.ok) { location.reload(); return; }
    }
    connectedOnce = true;
    refreshRooms();
  });
  socket.on('disconnect', () => {
    document.getElementById('adminStatus').textContent = 'disconnected — reconnecting…';
    adminFactsChanged({ connected: false });
    // A download in flight can no longer be told of: said so, never left waiting.
    for (const [ticket, d] of downloading) {
      clearTimeout(d.timer);
      downloading.delete(ticket);
      say('This page lost its connection while ' + d.name + ' downloaded, so it cannot say whether all of it arrived.', true);
    }
  });
  socket.on('connect', () => {
    document.getElementById('adminStatus').textContent = 'connected';
    AGM.outbox.ready({ scope: 'admin', who: 'admin' });
    adminFactsChanged({ connected: true });
  });
  // Live updates while watching a room
  socket.on('message', onLiveMessage);
  socket.on('system', onLiveSystem);
  socket.on('users', onLiveUsers);
  socket.on('messageDeleted', ({ messageId }) => {
    const el = document.querySelector(`.admin-msg[data-key="${CSS.escape(String(messageId))}"]`);
    if (el) el.remove();
    if (currentRoom) currentRoom.messages = currentRoom.messages.filter((m) => m.id !== messageId);
    updateCounts();
    ADMIN.refresh();
  });
  socket.on('actionUpdate', () => { /* admin doesn't need to render */ });
  // The watched room's copy of a send, withdrawn from where it went: its line says so, drawn again from its record.
  socket.on('sentUpdate', ({ messageId, sentTo } = {}) => {
    const m = currentRoom && currentRoom.messages.find((x) => x.id === messageId);
    if (!m || !sentTo || typeof sentTo !== 'object') return;
    m.sentTo = sentTo;
    const el = document.querySelector(`.admin-msg[data-key="${CSS.escape(String(messageId))}"]`);
    if (el) el.replaceWith(buildAdminMessage(m));
    ADMIN.refresh();
  });
  // The watched room's guest code was switched or renewed (here or in another tab): its header, and the list.
  socket.on('guestCode', ({ guestCode, codeOn } = {}) => { codeNow(typeof guestCode === 'string' ? guestCode : '', !!codeOn); refreshRooms(); });
  // Another admin tab closed the hall this one is watching: show what is left.
  socket.on('roomClosed', ({ code } = {}) => { if (currentRoom && currentRoom.code === code) location.reload(); else refreshRooms(); });
  socket.on('pinUpdate', () => { /* same */ });
  // A download this page asked for: begun (`file:sending`), then "reached this browser" once the server has sent the whole
  // file, or "stopped" when its stream ended before that (`whole: false`).
  socket.on('file:sending', ({ ticket } = {}) => { const d = downloading.get(ticket); if (d) d.began = true; });
  socket.on('file:sent', ({ ticket, whole } = {}) => {
    const d = downloading.get(ticket);
    if (!d) return;
    clearTimeout(d.timer);
    downloading.delete(ticket);
    if (whole === false) say('The download of ' + d.name + ' stopped before all of it was sent — try again.', true);
    else say(AGM.mark('ok') + ' ' + d.name + ' reached this browser');
  });
  // The tunnel's card hears this socket: its status pushed, and asked at each connection (which also checks the link
  // when its newest check is over a minute old).
  wireTunnel();

  document.getElementById('newSessionBtn').addEventListener('click', createNewRoom);
}

function refreshRooms() {
  socket.emit('admin:listRooms', (res) => {
    if (!res?.ok) return;
    allRooms = res.rooms;
    renderRoomList(res.rooms);
    adminFactsChanged({ halls: res.rooms.map((r) => ({ code: r.code, name: r.name })) });
  });
}

// ---------------- The halls and their rooms: the list, and the watched room's header (kind adminRoom) ----------------
/** A room of the list by its key: a hall (its Main room) or one of its side rooms, with its hall; null when none is listed. */
function roomAt(code) {
  for (const h of allRooms || []) {
    if (!h) continue;
    if (h.code === code) return { room: h, hall: h };
    const side = (h.side || []).find((x) => x && x.key === code);
    if (side) return { room: side, hall: h };
  }
  return null;
}
/**
 * A room as the catalogue reads it: its key, its name, whether it is a hall (its Main room) or a side room beside one,
 * how an ask names it (a side room by its hall's name and its own, "Hall 2 › Legal"), whether this page watches it, and
 * its guest code (`on`: whether it admits guests, `guests`: the guest pages in it now, `codeIsKey`: a hall whose code is
 * still its address).
 */
function roomObject(code) {
  const at = roomAt(code);
  if (!at) return null;
  const main = at.room === at.hall;
  const named = main ? at.room.name || code : (at.hall.name || at.hall.code) + ' › ' + (at.room.name || code);
  return {
    code, name: at.room.name || '', hall: named, main, watched: !!currentRoom && currentRoom.code === code,
    guestCode: at.room.guestCode || '', on: !!at.room.codeOn, guests: Number.isInteger(at.room.guests) ? at.room.guests : null, codeIsKey: main && !!at.hall.codeIsKey,
  };
}
/** What a hall whose code is still its address says (the residual: its key is its code until New code). */
const RESIDUAL = 'This hall\'s code is also its address: anyone with an account in it can read it. Choose New code to separate them.';
/** A room's guest code as its row says it: the code, and "off" while it admits nobody new. */
const codeWords = (r) => (r.guestCode ? 'code ' + r.guestCode + (r.codeOn ? '' : ' off') : 'no code');
/** A room's ⋯ as a screen reader names it. */
const actionsOf = (o) => (o.main ? 'Hall actions' : 'Room actions');
/**
 * The list, drawn in place: each hall's row, newest first, and under it its side rooms in the order they were made, each
 * row kept by its key, so a redraw keeps the focus and an open menu's opener.
 */
function renderRoomList(rooms) {
  const list = document.getElementById('roomList');
  document.getElementById('noRooms').hidden = rooms.length > 0;
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  const rows = rooms.flatMap((h) => [{ key: h.code, r: h, side: false }, ...(h.side || []).map((x) => ({ key: x.key, r: x, side: true, hall: h }))]);
  const keep = new Map([...list.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
  rows.forEach(({ key, r, side, hall }, i) => {
    let li = keep.get(key);
    keep.delete(key);
    if (!li) {
      li = document.createElement('li');
      li.className = 'room-list-item';
      li.dataset.key = key;
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'room-pick';
      const bar = document.createElement('span');
      bar.className = 'obj-bar';
      li.append(pick, bar);
    }
    li.classList.toggle('side', side);
    const watched = !!currentRoom && currentRoom.code === key;
    li.classList.toggle('active', watched);
    const pick = li.querySelector('.room-pick');
    // The row's own door is Watch (the catalogue's adminRoom.watch): the room this page watches offers none.
    if (watched) { delete pick.dataset.action; pick.setAttribute('aria-current', 'true'); } else { pick.dataset.action = 'adminRoom.watch'; pick.removeAttribute('aria-current'); }
    // A hall by its name and its code; a side room by its name, under its hall (its key is an address, said when watched),
    // its hall said in its name to a screen reader too, which hears the rows as a list and not as set in.
    // A hall by its guest code (its key until New code), a side room's after its counts; each "off" while it admits nobody new,
    // and a hall whose code is still its address marked so (the residual, plan 1-§2.3), its whole words in the row's title.
    const counts = `<small>${r.users.length} ${r.users.length === 1 ? 'person' : 'people'}` +
      ` · ${escapeHtml(String(r.messageCount))} message${r.messageCount === 1 ? '' : 's'}` + (side ? ' · ' + escapeHtml(codeWords(r)) : r.codeOn ? '' : ' · code off') +
      (!side && r.codeIsKey ? ' · <span class="code-is-key">code is its address</span>' : '') + '</small>';
    const residual = !side && r.codeIsKey ? RESIDUAL : '';
    if (pick.title !== residual) pick.title = residual;
    const pickHtml = side
      ? `<span class="room-name">${escapeHtml(r.name || key)}</span><span class="sr-only">, a room of ${escapeHtml(hall.name || hall.code)}</span>` + counts
      : (r.name ? `<span class="room-name">${escapeHtml(r.name)}</span>` : '') + `<strong>${escapeHtml(r.guestCode || key)}</strong>` + counts;
    if (pick.innerHTML !== pickHtml) pick.innerHTML = pickHtml;
    // Moved only when out of place: a row taken out and put back would lose the focus.
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });
  for (const li of keep.values()) li.remove();
  for (const li of list.children) { const o = roomObject(li.dataset.key); if (o) ADMIN.draw(li.querySelector('.obj-bar'), 'adminRoom', o, { more: actionsOf(o), keysOn: li }); }
  ADMIN.refresh();
}

/** New hall: its name asked in place (none, and it has its code alone). */
function createNewRoom() {
  const btn = document.getElementById('newSessionBtn');
  AGM.ask(btn, { title: 'New hall', words: 'It gets a 6-character guest code: crew without an account join with it.', fields: [{ name: 'name', label: 'Hall name (for example Hall 2)', max: 80 }], yes: 'Create hall', no: 'Cancel' }, { opener: btn }).then((a) => {
    if (!a.yes) return;
    AGM.outbox.now('admin:createRoom', { name: a.values.name }, (res) => {
      if (!res?.ok) { say(res?.error || 'Not created.', true); return; }
      say('Created ' + (res.name || res.code) + ' — guest code ' + res.code + '.');
      watchRoom(res.code);
    });
  });
}

/** Watch a room (a hall, or a side room beside one): its header, its people and its live feed; `then()` once they are drawn. */
function watchRoom(code, then) {
  socket.emit('admin:watchRoom', { roomCode: code }, (res) => {
    if (!res?.ok) { say(res?.error || 'Not watched.', true); return; }
    const listed = roomObject(code);
    currentRoom = {
      code, name: res.name || '', title: listed ? (listed.main ? listed.name : listed.hall) : res.name || '', main: res.main !== false, messages: res.messages || [], users: res.users || [],
      guestCode: res.guestCode || '', codeOn: !!res.codeOn,
    };
    const head = document.getElementById('roomHeader');
    head.hidden = false;
    head.dataset.key = code;
    document.getElementById('roomTools').hidden = true;
    document.getElementById('usersSection').hidden = false;
    document.getElementById('messagesSection').hidden = false;
    document.getElementById('adminEmpty').hidden = true;
    drawWatched();
    nameWatched(code);
    renderUsers(currentRoom.users);
    renderFeed(currentRoom.messages);
    updateCounts();
    refreshRooms();
    if (typeof then === 'function') then();
  });
}

/**
 * The watched room's header: its name (a side room by its hall's name and its own); a hall by its guest code, a side room
 * by its key (an address) with its guest code under it; whether the code admits guests; and a hall whose code is still
 * its address said so (the residual: anyone with an account in it reads its code from its address until New code).
 */
function drawWatched() {
  const r = currentRoom;
  document.getElementById('watchedRoomCode').textContent = r.main ? r.guestCode || r.code : r.code;
  document.getElementById('watchedKeyWord').textContent = r.main ? 'Code' : 'Room key';
  const nameEl = document.getElementById('watchedRoomName');
  nameEl.textContent = r.title;
  nameEl.hidden = !r.title;
  const said = [];
  if (!r.main) said.push('Guest code ' + (r.guestCode || '—') + (r.codeOn ? ': guests join with it.' : ': off. The admin and the accounts given this room go in.'));
  else if (!r.codeOn) said.push('The code is off: guests already in stay, and nobody new joins with it.');
  if (r.main && r.guestCode === r.code) said.push(RESIDUAL);
  const note = document.getElementById('watchedCodeNote');
  note.textContent = said.join(' ');
  note.hidden = !said.length;
}
/** The watched room's guest code as the server says it now (a switch or New code, from this page or another). */
function codeNow(guestCode, codeOn) {
  if (!currentRoom) return;
  Object.assign(currentRoom, { guestCode, codeOn });
  drawWatched();
}
/** The watched room named as its settings say now (room:settings: its name, its hall's, whether it is the Main room). */
function nameWatched(code) {
  socket.emit('room:settings', { code }, (s) => {
    if (!s || !s.ok || !currentRoom || currentRoom.code !== code) return;
    Object.assign(currentRoom, { name: s.name, main: s.main, title: s.main ? s.name : (s.hallName || s.hall) + ' › ' + s.name });
    drawWatched();
  });
}

// ---------------- The people in the watched hall (kind person) ----------------
/** A person as the catalogue reads them, with the watched hall's name and the names of the halls they may forward into. */
function personObject(sid) {
  const u = currentRoom && currentRoom.users.find((x) => x.socketId === sid);
  if (!u) return null;
  const linkedNames = {};
  for (const rm of u.linkedRooms || []) { const nm = roomNameForCode(rm); linkedNames[rm] = nm ? nm + ' · ' + rm : rm; }
  return { ...u, hall: hallName(), linkedNames, main: watchedIsMain() };
}
const hallName = () => (currentRoom ? currentRoom.title || roomNameForCode(currentRoom.code) || currentRoom.code : '');
/** The people, drawn in place by their page's id: Name, Seat (a code guest's select; an account's follows its rights), Chat view, May forward to, and the ⋯. */
function renderUsers(users) {
  const tb = document.getElementById('usersTbody');
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">No-one has joined yet.</td></tr>';
    ADMIN.refresh();
    return;
  }
  const keep = new Map([...tb.querySelectorAll(':scope > tr[data-key]')].map((tr) => [tr.dataset.key, tr]));
  for (const tr of tb.querySelectorAll(':scope > tr:not([data-key])')) tr.remove();
  users.forEach((u, i) => {
    let tr = keep.get(u.socketId);
    keep.delete(u.socketId);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.key = u.socketId;
      tr.className = 'person-row';
      for (let i = 0; i < 5; i++) tr.appendChild(document.createElement('td'));
      const bar = document.createElement('span');
      bar.className = 'obj-bar';
      tr.lastElementChild.appendChild(bar);
    }
    const [nameTd, seatTd, viewTd, linksTd] = tr.children;
    const nameHtml = `<strong>${escapeHtml(u.name)}</strong>`;
    if (nameTd.innerHTML !== nameHtml) nameTd.innerHTML = nameHtml;
    // A code guest's seat is set here; an account's follows its rights, which are set on the Accounts page.
    const sel = seatTd.querySelector('.role-select');
    if (u.account) {
      const fixedHtml = `<span class="role-fixed">${escapeHtml(seatWord(u.role))}</span> <small class="muted">account · <a href="/users.html" target="_blank" rel="noopener">rights on the Accounts page</a></small>`;
      if (seatTd.innerHTML !== fixedHtml) seatTd.innerHTML = fixedHtml;
    } else if (!sel) {
      seatTd.innerHTML = `<select class="role-select" aria-label="Seat of ${escapeHtml(u.name)}">${roleOptionsHtml(u.role)}</select>`;
    } else if (document.activeElement !== sel) sel.value = u.role;
    // The chat view the admin chose for the person (Chat view ▸ in the row's ⋯ is the same act): a guest's or an account's.
    const viewSel = viewTd.querySelector('.view-select');
    const viewNow = typeof u.view === 'string' ? u.view : '';
    if (!viewSel) viewTd.innerHTML = `<select class="view-select" aria-label="Chat view of ${escapeHtml(u.name)}">${chatViewOptionsHtml(viewNow)}</select>`;
    else if (document.activeElement !== viewSel) viewSel.value = viewNow;
    const linksHtml = (u.linkedRooms || []).map((rm) => {
      const nm = roomNameForCode(rm);
      const labelHtml = nm
        ? `<span class="lc-name">${escapeHtml(nm)}</span><span class="lc-code">${escapeHtml(rm)}</span>`
        : `<span class="lc-code">${escapeHtml(rm)}</span>`;
      return `<span class="linked-chip" title="May forward into ${escapeHtml(nm || rm)}">${labelHtml}` +
        `<button type="button" class="unlink-room" data-room="${escapeHtml(rm)}" aria-label="Stop ${escapeHtml(u.name)} forwarding into ${escapeHtml(nm || rm)}">×</button>` +
      `</span>`;
    }).join('') || '<small class="muted">— none —</small>';
    if (linksTd.innerHTML !== linksHtml) linksTd.innerHTML = linksHtml;
    if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] || null);
  });
  for (const tr of keep.values()) tr.remove();
  for (const tr of tb.children) { const o = personObject(tr.dataset.key); if (o) ADMIN.draw(tr.querySelector('.obj-bar'), 'person', o, { more: 'Actions for ' + o.name, keysOn: tr }); }
  ADMIN.refresh();
}
const usersTbody = document.getElementById('usersTbody');
/** A seat as its select's value: the server's word, On stage's older name read as On stage. */
const seatValue = (role) => (role === 'director' ? 'board' : role);
const seatSelect = (sid) => document.querySelector('#usersTbody > tr[data-key="' + CSS.escape(sid) + '"] .role-select');
// A code guest's seat chosen in its select is the catalogue's Seat ▸ with that value. The select shows the seat the
// server keeps until it answers: an act not sent (offline) or refused leaves it where it was.
usersTbody.addEventListener('change', (e) => {
  const sel = e.target.closest('.role-select');
  const tr = sel && sel.closest('tr[data-key]');
  const o = tr && personObject(tr.dataset.key);
  if (!o) return;
  const want = sel.value;
  sel.value = seatValue(o.role);
  const get = () => personObject(tr.dataset.key);
  ADMIN.act('person', 'person.seat', o, { value: want, anchor: sel, node: tr, opener: sel, get, gone: 'That person has left the hall.' });
});
// A person's chat view chosen in its select is the catalogue's Chat view ▸ with that value; the select shows the view the
// server keeps until it answers.
usersTbody.addEventListener('change', (e) => {
  const sel = e.target.closest('.view-select');
  const tr = sel && sel.closest('tr[data-key]');
  const o = tr && personObject(tr.dataset.key);
  if (!o) return;
  const want = sel.value;
  sel.value = typeof o.view === 'string' ? o.view : '';
  const get = () => personObject(tr.dataset.key);
  ADMIN.act('person', 'person.chatView', o, { value: want, anchor: sel, node: tr, opener: sel, get, gone: 'That person has left the hall.' });
});
// A link's × takes back that one hall: the catalogue's No longer forward into ▸, as unticking it in the menu is.
usersTbody.addEventListener('click', (e) => {
  const b = e.target.closest('.unlink-room');
  const tr = b && b.closest('tr[data-key]');
  const o = tr && personObject(tr.dataset.key);
  if (!o) return;
  const get = () => personObject(tr.dataset.key);
  ADMIN.act('person', 'person.unforward', o, { value: b.dataset.room, anchor: b, node: tr, opener: b, get, gone: 'That person has left the hall.' });
});
/** Let a person forward into a hall, or no longer: the server's answer said, the row drawn again from the room list. */
function forwardInto(o, code, on) {
  if (!o) { say('That person has left the hall.', true); return; }
  const said = (res) => {
    if (!res || !res.ok) { say((res && res.error) || (on ? 'Not linked.' : 'Not unlinked.'), true); return; }
    say(on ? o.name + ' may forward into ' + (roomNameForCode(code) || code) + '.' : o.name + ' may no longer forward into ' + (roomNameForCode(code) || code) + '.');
    socket.emit('admin:listRooms', (after) => {
      if (!after?.ok) return;
      allRooms = after.rooms;
      const cur = after.rooms.find((rr) => rr.code === currentRoom?.code);
      if (cur) { currentRoom.users = cur.users; renderUsers(cur.users); }
    });
  };
  const args = { socketId: o.socketId, targetRoom: code };
  if (on) AGM.outbox.now('admin:linkRoom', args, said); else AGM.outbox.now('admin:unlinkRoom', args, said);
}
/**
 * Let them forward into ▸ (pure): every other room, grouped by hall, halls by name, each hall's Main room first and its side
 * rooms after it in the order they were made ("Hall 2", "Hall 2 › Legal"), a line between halls; each ticked where the
 * person may forward into it now (`linked`). The room watched is not offered: it is where they are.
 */
function forwardChoices(halls, home, linked) {
  const now = new Set(linked || []);
  const byName = (a, b) => (a.name || a.code).localeCompare(b.name || b.code);
  const out = [];
  for (const h of (halls || []).filter((x) => x && x.code).sort(byName)) {
    const hallName = h.name || h.code;
    const rooms = [{ key: h.code, label: h.name ? h.name + ' · ' + h.code : h.code }]
      .concat((h.side || []).map((x) => ({ key: x.key, label: hallName + ' › ' + (x.name || x.key) })))
      .filter((r) => r.key !== home);
    if (!rooms.length) continue;
    if (out.length) out.push({ sep: true });
    for (const r of rooms) out.push({ value: r.key, label: r.label, role: 'menuitemcheckbox', checked: now.has(r.key) });
  }
  return out;
}
/** Let them forward into ▸: every other room, grouped by hall, ticked where this person may forward into it now (asked as it opens). */
function forwardTargets(o) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) { resolve([{ id: '', label: AGM.catalog.WORDS.offline, disabled: AGM.catalog.WORDS.offline }]); return; }
    socket.emit('admin:listRooms', (res) => {
      if (!res || !res.ok) { resolve([{ id: '', label: (res && res.error) || 'Could not list the halls.', disabled: (res && res.error) || 'Could not list the halls.' }]); return; }
      allRooms = res.rooms;
      const home = currentRoom ? currentRoom.code : '';
      // The people as this answer has them, so a room ticked here is one the person's own acts read as linked too. The
      // watched room is a hall or a side room: its hall's row holds its people either way.
      const at = roomAt(home);
      const cur = at ? (at.room === at.hall ? res.rooms.find((r) => r.code === home) : (res.rooms.find((r) => r.code === at.hall.code) || { side: [] }).side.find((x) => x.key === home)) : null;
      if (cur && currentRoom) { currentRoom.users = cur.users; renderUsers(cur.users); }
      const linked = ((cur || { users: [] }).users.find((u) => u.socketId === o.socketId) || { linkedRooms: [] }).linkedRooms;
      const choices = forwardChoices(res.rooms, home, linked);
      if (!choices.length) { const w = 'No other room yet: make a hall with New hall, or a room in it.'; resolve([{ id: '', label: w, disabled: w }]); return; }
      resolve(choices);
    });
  });
}

// ---------------- The live feed (kind adminMsg) ----------------
function feedObject(id) {
  const m = currentRoom && currentRoom.messages.find((x) => x.id === id && x.type !== 'system');
  return m ? { ...m, hall: hallName() } : null;
}
function renderFeed(messages) {
  const feed = document.getElementById('adminFeed');
  feed.innerHTML = '';
  for (const m of messages) feed.appendChild(buildAdminMessage(m));
  feed.scrollTop = feed.scrollHeight;
  ADMIN.refresh();
}

function buildAdminMessage(m) {
  const div = document.createElement('div');
  div.className = 'admin-msg';
  if (m.type === 'system') {
    div.className += ' sys';
    div.textContent = m.text;
    return div;
  }
  div.dataset.key = m.id;
  if (m.priority) div.classList.add('priority');
  const whoHtml = m.from
    ? `<strong>${escapeHtml(m.from.name)}</strong> <span class="role-tag" data-role="${escapeHtml(m.from.role)}">${escapeHtml(seatWord(m.from.role))}</span>`
    : '—';
  let bodyHtml = '';
  if (m.type === 'text') bodyHtml = `<p>${escapeHtml(m.text)}</p>`;
  // A file message is a file shared for download (📎; 📦 one AGMessage never opens), downloaded from its ⬇.
  else if (m.type === 'file') bodyHtml = `<p>${m.transferOnly ? '📦' : '📎'} ${escapeHtml(m.filename)}${m.transferOnly ? ' · download only' : ''}${m.caption ? ` — <em>${escapeHtml(m.caption)}</em>` : ''}</p>`;
  else if (m.type === 'action') {
    bodyHtml = `<p>🟧 <strong>${escapeHtml(m.text)}</strong></p>` +
           `<p class="muted">Options: ${escapeHtml((m.options || []).join(' · '))}</p>`;
  } else if (m.type === 'help') bodyHtml = `<p>${escapeHtml(AGM.mark('urgent'))} <strong>${escapeHtml(m.category || 'Help')}</strong> ${escapeHtml(m.text || '')}</p>`;
  // A message its page held before sending it (written offline) says when it was written and when it was sent.
  const heldHtml = Number.isInteger(m.held) && m.held > 0 ? '<div class="held-line">written ' + escapeHtml(formatTime(m.at - m.held * 1000)) + ' · sent ' + escapeHtml(formatTime(m.at)) + ' (offline)</div>' : '';
  // A message another room sent here, and this room's copy of one it sent there (or took back since), say which room, as
  // the hall page does.
  const sentHtml = m.sentFrom ? '<div class="sent-meta">↘ From ' + escapeHtml(AGM.catalog.placeOf(m.sentFrom)) + '</div>'
    : m.sentTo && m.sentTo.withdrawn ? '<div class="sent-meta">' + escapeHtml(AGM.mark('withdrawn')) + ' Withdrawn from ' + escapeHtml(AGM.catalog.placeOf(m.sentTo)) + ' after ' + escapeHtml(AGM.catalog.lasted(m.sentTo.withdrawn - m.at)) + '</div>'
      : m.sentTo ? '<div class="sent-meta">↗ Sent to ' + escapeHtml(AGM.catalog.placeOf(m.sentTo)) + ' — delivered</div>' : '';
  div.innerHTML =
    `<div class="admin-msg-head">${whoHtml} <time>${escapeHtml(formatTime(m.at))}</time>${m.priority ? ' <span class="priority-badge" style="display:inline-block">🔥 HIGH</span>' : ''}</div>` +
    `<div class="admin-msg-body">${sentHtml}${bodyHtml}${heldHtml}</div>` +
    '<div class="admin-msg-foot obj-bar"></div>';
  ADMIN.draw(div.querySelector('.obj-bar'), 'adminMsg', { ...m, hall: hallName() }, { more: 'Message actions', keysOn: div });
  return div;
}

/**
 * A file of the watched room downloaded (plan 4-§4.6.6): a ticket the server gives this page for it, posted in a form built
 * with the DOM; the server answers the post with the file, or with nothing (204) where the ticket does not hold. Attempts
 * are not facts, as on the hall page: "did not start" when it never began within DOWNLOAD_START_MS, and, for one in
 * flight as this page loses its connection, that it cannot say.
 */
const DOWNLOAD_START_MS = 5000;
const downloading = new Map();   // ticket -> {name, timer, began}
function downloadFile(o) {
  if (typeof o.url !== 'string' || !/^\/uploads\/[\w.-]+$/.test(o.url)) return;
  AGM.outbox.now('file:download', { messageId: o.id }, (r) => {
    if (!r || !r.ok || typeof r.ticket !== 'string') { say((r && r.error) || 'Not downloaded.', true); return; }
    const name = (typeof r.name === 'string' && r.name) || o.filename || 'the file';
    const timer = setTimeout(() => {
      const d = downloading.get(r.ticket);
      if (d && !d.began) { downloading.delete(r.ticket); say('The download did not start — try again.', true); }
    }, DOWNLOAD_START_MS);
    downloading.set(r.ticket, { name, timer, began: false });
    say('⬇ Downloading ' + name + '…');
    const form = document.createElement('form');
    form.method = 'post';
    form.action = o.url + '/download';
    form.hidden = true;
    const t = document.createElement('input');
    t.type = 'hidden';
    t.name = 't';
    t.value = r.ticket;
    form.appendChild(t);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  });
}

function onLiveMessage(m) {
  if (!currentRoom) return;
  currentRoom.messages.push(m);
  document.getElementById('adminFeed').appendChild(buildAdminMessage(m));
  document.getElementById('adminFeed').scrollTop = 1e9;
  updateCounts();
}
function onLiveSystem(m) {
  if (!currentRoom) return;
  document.getElementById('adminFeed').appendChild(buildAdminMessage(m));
}
function onLiveUsers(users) {
  if (!currentRoom) return;
  currentRoom.users = users;
  renderUsers(users);
  updateCounts();
  refreshRooms();
}

function updateCounts() {
  if (!currentRoom) return;
  document.getElementById('userCount').textContent = currentRoom.users.length;
  document.getElementById('msgCount').textContent =
    currentRoom.messages.filter((m) => m.type !== 'system').length;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
/** Whether the watched room is a hall's Main room (a side room has no stage: no seat there is On stage). */
function watchedIsMain() { return !currentRoom || currentRoom.main !== false; }
/** The chat views a person's pages may draw, in the catalogue's words (By seat, Simple, Full), the one chosen selected. */
function chatViewOptionsHtml(current) {
  return AGM.catalog.CHAT_VIEWS.map(([v, label]) => '<option value="' + escapeHtml(v) + '"' + (v === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>').join('');
}
/** The seat picker's options, the person's own selected: On stage only in a hall's Main room. */
function roleOptionsHtml(current) {
  return (watchedIsMain() ? ['board', 'research', 'observer'] : ['research', 'observer']).map((r) => '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' + escapeHtml(seatWord(r)) + '</option>').join('');
}
/** A seat in the words every page uses for it, in the watched room's kind (a side room's backstage seat a Member's); the
 *  role word stays the value the server reads. */
function seatWord(role) {
  return role === 'board' || role === 'director' ? 'On stage' : role === 'research' ? (watchedIsMain() ? 'Backstage' : 'Member') : role === 'observer' ? 'Observer' : role;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The support view's page for a person: their room, name and seat, and their uid, so it is told what their pages are shown. */
const userViewParams = (code, name, role, uid) => new URLSearchParams({ code, name, role, adminView: '1', ...(uid ? { viewOf: uid } : {}), t: String(Date.now()) });
function openUserView(code, name, role, uid) {
  const modal = document.getElementById('userViewModal');
  const frame = document.getElementById('userViewFrame');
  const title = document.getElementById('userViewTitle');
  // Cache-bust so each open is a fresh load (avoids stale iframe state)
  frame.src = '/app.html?' + userViewParams(code, name, role, uid).toString();
  title.textContent = 'Viewing ' + name + ' (' + seatWord(role) + ') in ' + (roomNameForCode(code) || code);
  modal.hidden = false;
  // Stash for the Resync button
  modal.dataset.code = code;
  modal.dataset.name = name;
  modal.dataset.role = role;
  modal.dataset.uid = uid || '';
}
function closeUserView() {
  const modal = document.getElementById('userViewModal');
  const frame = document.getElementById('userViewFrame');
  modal.hidden = true;
  frame.src = '';
}
document.getElementById('userViewClose')?.addEventListener('click', closeUserView);
document.getElementById('userViewResync')?.addEventListener('click', () => {
  const frame = document.getElementById('userViewFrame');
  const modal = document.getElementById('userViewModal');
  if (!frame || !modal) return;
  // Quick path: ask the iframe to re-request peer state. Only a page of this origin is told: a frame that has gone
  // elsewhere hears nothing.
  try {
    frame.contentWindow.postMessage({ type: 'agm:resync' }, location.origin);
  } catch (e) { /* the frame has no window (closed): the reload below still runs */ }
  // Hard path: reload the iframe with a fresh cache-bust after a moment
  setTimeout(() => {
    const code = modal.dataset.code, name = modal.dataset.name, role = modal.dataset.role;
    if (code && name && role) frame.src = '/app.html?' + userViewParams(code, name, role, modal.dataset.uid).toString();
  }, 1200);
});
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('userViewModal');
  if (e.key === 'Escape' && !e.defaultPrevented && modal && !modal.hidden) closeUserView();
});
document.getElementById('userViewModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'userViewModal') closeUserView();
});

/** A room's settings as the server tells them (room:settings), or why not: a read, so a plain emit. */
function readRoomSettings(code) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) { resolve({ ok: false, error: 'Not connected.' }); return; }
    socket.emit('room:settings', { code }, (r) => resolve(r && typeof r === 'object' ? r : { ok: false, error: 'No answer.' }));
  });
}

/** A room's name as the list has it: a hall's, or a side room's with its hall's ("Hall 2 › Legal"); '' when unnamed or unlisted. */
function roomNameForCode(code) {
  const at = roomAt(code);
  if (!at) return '';
  return at.room === at.hall ? at.room.name || '' : (at.hall.name || at.hall.code) + ' › ' + (at.room.name || code);
}

// ---------------- What each act does (the catalogue's rows are in catalog.js) ----------------
Object.assign(ADMIN_RUN, {
  'adminRoom.watch': (o) => watchRoom(o.code),
  'adminRoom.transcript': (o) => { window.open('/api/admin/transcript/' + encodeURIComponent(o.code), '_blank', 'noopener'); },
  'adminRoom.clear': (o) => AGM.outbox.now('admin:resetRoom', { roomCode: o.code }, (res) => {
    if (!res?.ok) { say(res?.error || 'Not cleared.', true); return; }
    // A stage record whose file could not be read at the start keeps what that file holds: said, never as cleared.
    if (res.recordUnread) say('Cleared every message in ' + o.hall + '. Its stage record\'s file could not be read, so what was shown before this start is still in it.', true);
    else say('Cleared every message in ' + o.hall + '.');
    if (currentRoom && currentRoom.code === o.code) { currentRoom.messages = []; renderFeed(currentRoom.messages); updateCounts(); }
  }),
  // Closed: the page starts afresh on the list without it, once the admin has read what stayed on disk, if anything did.
  // A side room this page does not watch goes from the list in place, the page and the watched room as they were.
  'adminRoom.remove': (o, c) => AGM.outbox.now('admin:deleteRoom', { roomCode: o.code, purgeFiles: !!(c.values && c.values.purge) }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || (o.main ? 'Not closed.' : 'Not removed.'), true); return; }
    const inPlace = !o.main && !(currentRoom && currentRoom.code === o.code);
    const after = inPlace ? refreshRooms : () => location.reload();
    if (res.keptWords) { say((o.main ? 'Closed. ' : 'Removed. ') + res.keptWords, true); setTimeout(after, KEPT_READ_MS); return; }
    if (inPlace) say('Removed ' + o.hall + '.');
    after();
  }),
  // A room made in a hall: listed under it, its guest code off; this page goes on watching what it watched.
  'adminRoom.create': (o, c) => AGM.outbox.now('room:create', { hall: o.code, name: (c.values && c.values.name) || '' }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || 'Not made.', true); return; }
    say('Made ' + res.name + ' in ' + o.hall + ': its guest code is off.');
    refreshRooms();
  }),
  // The guest code switched on, or off with the guest pages in it kept or sent out (the ask's choice): said with what it did.
  'adminRoom.codeToggle': (o, c) => AGM.outbox.now('room:update', o.on ? { code: o.code, codeOn: false, keepGuests: c.choice !== 'out' } : { code: o.code, codeOn: true }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || 'Not changed.', true); return; }
    const n = (k) => k + (k === 1 ? ' guest page' : ' guest pages');
    say(res.codeOn ? 'The guest code of ' + o.hall + ' is on.'
      : Number.isInteger(res.sentOut) ? 'The guest code of ' + o.hall + ' is off: ' + n(res.sentOut) + ' sent out.'
        : 'The guest code of ' + o.hall + ' is off' + (Number.isInteger(res.kept) ? ': ' + n(res.kept) + ' stay.' : '.'));
    if (currentRoom && currentRoom.code === o.code) codeNow(currentRoom.guestCode, res.codeOn);
    refreshRooms();
  }),
  'adminRoom.newCode': (o) => AGM.outbox.now('room:update', { code: o.code, newCode: true }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || 'No new code.', true); return; }
    say('The new guest code of ' + o.hall + ' is ' + res.guestCode + '.');
    if (currentRoom && currentRoom.code === o.code) codeNow(res.guestCode, res.codeOn);
    refreshRooms();
  }),
  // Who is in the room by account (Board members… on a hall: its On stage seats): one save per account, each said.
  'adminRoom.members': (o) => {
    const at = roomAt(o.code);
    AGM.members.open({ code: o.code, name: o.name, hall: o.hall, main: o.main, hallName: at ? at.hall.name || at.hall.code : o.hall }, { say, done: refreshRooms });
  },
  // Which rooms may send into it (every hall's rooms, each ticked with ↔ and send back), read afresh and saved at once.
  'adminRoom.sendFrom': (o) => AGM.sendFrom.open({ code: o.code, hall: o.hall }, { read: readRoomSettings, say }),
  'adminRoom.rename': (o, c) => AGM.outbox.now('room:update', { code: o.code, name: (c.values && c.values.name) || '' }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || 'Not renamed.', true); return; }
    say(res.already ? 'It is called ' + res.name + ' already.' : 'Renamed ' + res.name + '.');
    if (currentRoom && currentRoom.code === o.code) nameWatched(o.code);
    refreshRooms();
  }),
  // The select shows the seat once the server has it; a refusal leaves it on the seat the server keeps.
  'person.seat': (o, c) => {
    if (!c.value) return;
    AGM.outbox.now('admin:setRole', { roomCode: currentRoom.code, socketId: o.socketId, role: c.value }, (res) => {
      const sel = seatSelect(o.socketId);
      if (res && res.ok) { if (sel) sel.value = seatValue(c.value); return; }
      say((res && res.error) || 'Not moved to that seat.', true);
      if (sel) sel.value = seatValue(o.role);
    });
  },
  // The view the person's pages draw: said once the server has it; the row's select follows the people list it sends.
  'person.chatView': (o, c) => {
    if (typeof c.value !== 'string') return;
    AGM.outbox.now('admin:setView', { roomCode: currentRoom.code, socketId: o.socketId, view: c.value }, (res) => {
      const sel = document.querySelector('#usersTbody > tr[data-key="' + CSS.escape(o.socketId) + '"] .view-select');
      if (res && res.ok) { if (sel) sel.value = c.value; say(o.name + (res.already ? '\'s chat view is ' : '\'s chat view: ') + AGM.catalog.CHAT_VIEWS.find(([v]) => v === c.value)[1] + '.'); return; }
      say((res && res.error) || 'Not changed.', true);
      if (sel) sel.value = typeof o.view === 'string' ? o.view : '';
    });
  },
  // A hall ticked already is unticked: that is No longer forward into ▸, its own act.
  'person.forward': (o, c) => {
    if (!c.value) return;
    if (c.item && c.item.checked) ADMIN.act('person', 'person.unforward', o, c);
    else forwardInto(o, c.value, true);
  },
  'person.unforward': (o, c) => { if (c.value) forwardInto(o, c.value, false); },
  'person.view': (o) => openUserView(currentRoom.code, o.name, o.role, o.uid),
  'person.kick': (o) => AGM.outbox.now('admin:kick', { socketId: o.socketId }, (res) => { if (!res || !res.ok) say((res && res.error) || 'Not logged out.', true); else say(o.name + ' is logged out of ' + o.hall + '.'); }),
  'adminMsg.copy': (o, c) => AGM.copy(o.text, { said: 'Copied.', anchor: c.anchor, say }),
  'adminMsg.download': (o) => downloadFile(o),
  // A file on people's pages now is asked about first (the server's answer is the question): take it down too, or leave
  // it up there, then deleted with that answer.
  'adminMsg.delete': (o, c) => {
    const del = (extra) => AGM.outbox.now('admin:deleteMessage', { roomCode: currentRoom.code, messageId: o.id, ...extra }, (res) => {
      if (res && res.onStage && !extra) {
        AGM.ask(c && c.anchor ? c.anchor : null, { title: 'Delete for everyone', words: res.error, choices: [{ answer: 'down', label: 'Delete and take it down', danger: true }, { answer: 'up', label: 'Delete, leave it up' }], no: 'Keep it' }, { opener: c && c.opener ? c.opener : null })
          .then((a) => { if (a && a.yes && (a.choice === 'down' || a.choice === 'up')) del({ takeDown: a.choice === 'down' }); });
        return;
      }
      saidIfNot('Not deleted.')(res);
    });
    del(null);
  },
});
const objectSpec = (kind, sel, get, more, gone) => ({ kind, find: (el) => el.closest(sel), get, label: more, gone });
ADMIN.bind(document.getElementById('roomList'), objectSpec('adminRoom', '#roomList > li[data-key]', roomObject, actionsOf, 'That hall or room is gone.'));
ADMIN.bind(document.getElementById('roomHeader'), { ...objectSpec('adminRoom', '#roomHeader', roomObject, actionsOf, 'That hall or room is gone.'), header: (o) => o.hall });
ADMIN.bind(usersTbody, { ...objectSpec('person', '#usersTbody > tr[data-key]', personObject, 'Person actions', 'That person has left the hall.'), header: (o) => o.name + ' · ' + seatWord(o.role), submenu: (item, o) => (item.id === 'person.forward' ? forwardTargets(o) : []) });
ADMIN.bind(document.getElementById('adminFeed'), { ...objectSpec('adminMsg', '#adminFeed > .admin-msg[data-key]', feedObject, 'Message actions', 'That message is gone.'), header: (o) => 'Message from ' + ((o.from && o.from.name) || 'someone') + ' · ' + formatTime(o.at) });
AGM.roving(document.getElementById('roomList'), { item: 'li[data-key]' });
AGM.roving(usersTbody, { item: 'tr[data-key]' });
AGM.roving(document.getElementById('adminFeed'), { item: '.admin-msg[data-key]' });
// What this page's acts read, by name: its facts and its objects (the browser smoke reads them to hold the doors to the
// catalogue). A link and the internet link are admin-plus.js's and the card's.
const ADMIN_OBJECTS = { adminRoom: roomObject, person: personObject, adminMsg: feedObject };
AGM.page = Object.freeze({ facts: () => ADMIN_F, object: (kind, key) => (ADMIN_OBJECTS[kind] ? ADMIN_OBJECTS[kind](key) : null) });

// ---------------- Cloudflare tunnel control (kind tunnel) ----------------
//
// The toggle starts/stops `cloudflared tunnel --url http://localhost:<PORT>`
// server-side. The server captures the trycloudflare.com URL from the
// child's stdout/stderr and pushes it to admin sockets via tunnel:status.
// Status states: off | starting (running but no URL yet) | on | error.
// The internet link's block says its places and today's refusals (admin-plus.js, from health) and its newest check from
// this laptop ("Checked 14:02 · round trip 85 ms (max 140 ms)"); its end ("On until 06:00 tomorrow"), in the server's
// words by the laptop's clock, never this page's (which may be set to another zone); and when a start turned it on again,
// that its address is new. Its acts are the catalogue's: Check again (at most once a minute, saying why it cannot when it
// cannot), Copy address, Turn on, Tunnel until… and Turn off…, asked first: the toggle is a door to Turn on and Turn off….

/** The tunnel's card on the dashboard's socket: what the server pushes, and the status asked at each connection. */
function wireTunnel() {
  socket.on('tunnel:status', (s) => tunnelCard.apply(s));
  const ask = () => { socket.emit('admin:tunnelStatus', (res) => { if (res && res.ok) tunnelCard.apply(res); }); };
  socket.on('connect', ask);
  if (socket.connected) ask();
}

const tunnelCard = (function initTunnelControl() {
  const toggle = document.getElementById('tunnelToggle');
  let last = null;                 // the newest status the server gave
  let refusedWhy = '';             // a Check again the server could not answer, in its words, until the next status

  function showState(name, payload) {
    const states = ['off', 'starting', 'on', 'error'];
    for (const s of states) {
      const el = document.getElementById('tunnel' + s.charAt(0).toUpperCase() + s.slice(1) + 'State');
      if (el) el.hidden = (s !== name);
    }
    const lbl = document.getElementById('tunnelToggleLabel');
    if (lbl) {
      lbl.textContent = name === 'on' ? 'On' :
                        name === 'starting' ? 'Starting…' :
                        name === 'error' ? 'Error' : 'Off';
    }
    if (name === 'on' && payload && payload.url) {
      const u = document.getElementById('tunnelUrl');
      if (u) u.textContent = payload.url;
    }
    if (name === 'error' && payload && payload.error) {
      const e = document.getElementById('tunnelErrorMsg');
      if (e) e.textContent = payload.error;
    }
  }

  const hhmm = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text = (v) => (typeof v === 'string' ? v : '');
  /**
   * The internet link as the catalogue reads it: on or not, its address, a check running, how long ago the last was, and
   * the end it is kept on until, in the server's words and time of day by the laptop's clock ('' when none is kept).
   */
  function object() {
    const s = last || {};
    const check = s.check && typeof s.check === 'object' ? s.check : null;
    const kept = Number.isFinite(s.until);
    return { running: !!s.running, url: s.running && typeof s.url === 'string' ? s.url : '', checking: !!s.checking, checkedAgo: check ? (Date.now() - check.at) / 1000 : null,
      untilWords: kept ? text(s.untilWords) : '', untilClock: kept ? text(s.untilClock) : '' };
  }
  // Written only when its words change, so the status line is not announced again at every redraw.
  const put = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  /**
   * The check's line, the card's acts, and why Check again cannot be asked now (or why the last ask was not answered,
   * until the next status): the reason is the catalogue's, shown here and on the act itself.
   */
  function draw() {
    const line = document.getElementById('tunnelCheckLine');
    const why = document.getElementById('tunnelCheckWhy');
    const o = object();
    ADMIN.draw(document.getElementById('tunnelActs'), 'tunnel', o, { more: 'Internet link actions', words: true, cls: 'btn ghost small' });
    if (!line || !why) return;
    const s = last || {};
    const check = s.check && typeof s.check === 'object' ? s.check : null;
    const up = !!(s.running && s.url);
    put(line, !up ? '' : check ? (check.ok ? 'Checked ' + hhmm(check.at) + ' · ' + check.words : AGM.mark('couldNot') + ' ' + check.words) : s.checking ? '' : 'Not checked yet.');
    line.classList.toggle('bad', !!(up && check && !check.ok));
    const r = AGM.catalog.ready('tunnel', 'tunnel.check', ADMIN_F, o);
    put(why, refusedWhy || (r === true ? '' : r));
    drawEnd(s, o);
  }
  /**
   * Its end, and what a restart before it does (or why a restart would not, when the settings could not be read); off with
   * an end still kept (cloudflared ended, or a start could not turn it on again), what turns it on again; and once a start
   * turned it on again, that its address is new, said until it is turned off.
   */
  function drawEnd(s, o) {
    const end = document.getElementById('tunnelUntilLine');
    const again = document.getElementById('tunnelAgain');
    const notKept = text(s.notKept);
    if (end) {
      const words = !o.untilWords ? ''
        : o.running ? 'On until ' + o.untilWords + ', then off and it stays off. '
          + (notKept ? notKept + ' A restart of AGMessage does not turn it on again.' : 'If AGMessage starts again before then, the link is turned on again, with a new address.')
          : 'It was to stay on until ' + o.untilWords + '. Turn on starts it again until then, as does a start of AGMessage before then; Turn off… keeps it off.'
            + (notKept ? ' ' + notKept : '');
      put(end, words);
      end.hidden = !words;
    }
    if (again) {
      const words = s.running && text(s.againWords) ? AGM.mark('couldNot') + ' New address: AGMessage started again at ' + s.againWords + ' and turned the internet link on again. Send this address to remote people; the one before no longer works.' : '';
      put(again, words);
      again.hidden = !words;
    }
  }

  function applyStatus(s) {
    last = s || null;
    refusedWhy = '';
    draw();
    ADMIN.refresh();
    if (!toggle) return;
    if (!s) { showState('off'); toggle.checked = false; return; }
    if (s.error) { showState('error', s); toggle.checked = false; return; }
    if (s.running && s.url) { showState('on', s); toggle.checked = true; return; }
    if (s.running && !s.url) { showState('starting'); toggle.checked = true; return; }
    showState('off');
    toggle.checked = false;
  }

  // "Checked 20 s ago." counts on, and Check again comes back once the minute is over.
  setInterval(() => { if (last && last.check) { draw(); ADMIN.refresh(); } }, 1000);

  Object.assign(ADMIN_RUN, {
    'tunnel.check': () => AGM.outbox.now('admin:tunnelStatus', undefined, (res) => {
      if (res && res.ok) { applyStatus(res); return; }
      refusedWhy = (res && res.error) || 'The internet link could not be checked.';
      draw();
    }),
    'tunnel.copy': (o, c) => AGM.copy(o.url, { said: 'Copied the internet link\'s address.', anchor: c.anchor, say }),
    'tunnel.until': (o, c) => AGM.outbox.now('admin:tunnelUntil', { until: (c.values && c.values.until) || '' }, (res) => {
      if (!res || !res.ok) { say((res && res.error) || 'The end was not moved.', true); return; }
      say('The internet link stays on until ' + text(res.untilWords) + '.');
    }),
    'tunnel.on': () => {
      showState('starting');
      if (toggle) toggle.checked = true;
      AGM.outbox.now('admin:tunnelStart', undefined, (res) => {
        if (!res || !res.ok) { showState('error', { error: (res && res.error) || 'Could not start tunnel' }); if (toggle) toggle.checked = false; return; }
        // Its state comes on tunnel:status; its end is said now, so a short one is never a surprise.
        if (text(res.untilWords)) say('The internet link is turning on, until ' + res.untilWords + ' (Tunnel until… moves its end).' + (text(res.notKept) ? ' ' + res.notKept : ''), !!text(res.notKept));
      });
    },
    'tunnel.off': () => {
      // Shown off at once; the server's status confirms it.
      showState('off');
      if (toggle) toggle.checked = false;
      AGM.outbox.now('admin:tunnelStop', undefined, (res) => { if (!res || !res.ok) showState('error', { error: (res && res.error) || 'Could not stop the tunnel' }); });
    },
  });
  const section = document.getElementById('tunnelSection');
  ADMIN.bind(section, { kind: 'tunnel', find: (el) => el.closest('#tunnelSection'), get: () => object(), label: 'Internet link actions', header: () => 'The internet link' });
  // The toggle is a door to Turn on and Turn off…: it shows what is, until the act it asks for has run.
  if (toggle) {
    toggle.addEventListener('change', () => {
      const want = toggle.checked;
      toggle.checked = !!(last && last.running);
      ADMIN.act('tunnel', want ? 'tunnel.on' : 'tunnel.off', object(), { anchor: toggle, opener: toggle });
    });
  }
  ADMIN_DRAWERS.push(draw);
  ADMIN_OBJECTS.tunnel = () => object();
  return { apply: applyStatus, draw };
})();
