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
// What the server told this page: whom its gate admits (/api/admin/me), "the admin", whether AI drafts are on, the halls
// a node may be linked for, and whether it is connected now. A change redraws every bar and the open menu in place.
const adminState = { ok: false, admin: false, ai: false, halls: [], connected: false };
let ADMIN_F = AGM.catalog.adminFacts(adminState);
const ADMIN_RUN = {};
const say = (words, bad) => AGM.toast(words, bad);
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
  for (const li of document.querySelectorAll('#roomList > li[data-key]')) { const o = roomObject(li.dataset.key); if (o) ADMIN.draw(li.querySelector('.obj-bar'), 'adminRoom', o, { more: 'Hall actions', keysOn: li }); }
  const head = document.getElementById('roomHeader');
  const watched = currentRoom && roomObject(head.dataset.key || '');
  if (watched) ADMIN.draw(document.getElementById('roomActs'), 'adminRoom', watched, { more: 'Hall actions', keysOn: head });
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
  if (me.ok) { adminState.ok = true; adminState.admin = !!me.admin; showDashboard(); return; }
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
  socket = io({ ...AGM.reconnect.OPTIONS });
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
  // Another admin tab closed the hall this one is watching: show what is left.
  socket.on('roomClosed', ({ code } = {}) => { if (currentRoom && currentRoom.code === code) location.reload(); else refreshRooms(); });
  socket.on('pinUpdate', () => { /* same */ });
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

// ---------------- The halls: the list, and the watched hall's header (kind adminRoom) ----------------
/** A hall as the catalogue reads it: its code, its name, whether this page watches it. */
function roomObject(code) {
  const r = (allRooms || []).find((x) => x && x.code === code);
  if (!r) return null;
  return { code: r.code, name: r.name || '', hall: r.name || r.code, watched: !!currentRoom && currentRoom.code === r.code };
}
/** The hall list, drawn in place: each hall's row kept by its code, so a redraw keeps the focus and an open menu's opener. */
function renderRoomList(rooms) {
  const list = document.getElementById('roomList');
  document.getElementById('noRooms').hidden = rooms.length > 0;
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Map([...list.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
  rooms.forEach((r, i) => {
    let li = keep.get(r.code);
    keep.delete(r.code);
    if (!li) {
      li = document.createElement('li');
      li.className = 'room-list-item';
      li.dataset.key = r.code;
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'room-pick';
      const bar = document.createElement('span');
      bar.className = 'obj-bar';
      li.append(pick, bar);
    }
    const watched = !!currentRoom && currentRoom.code === r.code;
    li.classList.toggle('active', watched);
    const pick = li.querySelector('.room-pick');
    // The row's own door is Watch (the catalogue's adminRoom.watch): the hall this page watches offers none.
    if (watched) { delete pick.dataset.action; pick.setAttribute('aria-current', 'true'); } else { pick.dataset.action = 'adminRoom.watch'; pick.removeAttribute('aria-current'); }
    const pickHtml = (r.name ? `<span class="room-name">${escapeHtml(r.name)}</span>` : '') +
      `<strong>${escapeHtml(r.code)}</strong>` +
      `<small>${r.users.length} ${r.users.length === 1 ? 'person' : 'people'}` +
      ` · ${escapeHtml(String(r.messageCount))} message${r.messageCount === 1 ? '' : 's'}</small>`;
    if (pick.innerHTML !== pickHtml) pick.innerHTML = pickHtml;
    // Moved only when out of place: a row taken out and put back would lose the focus.
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });
  for (const li of keep.values()) li.remove();
  for (const li of list.children) ADMIN.draw(li.querySelector('.obj-bar'), 'adminRoom', roomObject(li.dataset.key), { more: 'Hall actions', keysOn: li });
  ADMIN.refresh();
}

/** New hall: its name asked in place (none, and it has its code alone). */
function createNewRoom() {
  const btn = document.getElementById('newSessionBtn');
  AGM.ask(btn, { title: 'New hall', words: 'It gets a 6-character guest code: crew without an account join with it.', fields: [{ name: 'name', label: 'Hall name (for example Hall 2)', max: 80 }], yes: 'Create hall', no: 'Cancel' }, { opener: btn }).then((a) => {
    if (!a.yes) return;
    AGM.outbox.now('admin:createRoom', { name: a.values.name }, (res) => {
      if (!res?.ok) { say(res?.error || 'Not created.', true); return; }
      say('Created ' + (res.name || res.code) + ' — code ' + res.code + '.');
      watchRoom(res.code);
    });
  });
}

/** Watch a hall: its header, its people and its live feed; `then()` once they are drawn. */
function watchRoom(code, then) {
  socket.emit('admin:watchRoom', { roomCode: code }, (res) => {
    if (!res?.ok) { say(res?.error || 'Not watched.', true); return; }
    currentRoom = { code, name: res.name || '', messages: res.messages || [], users: res.users || [] };
    const head = document.getElementById('roomHeader');
    head.hidden = false;
    head.dataset.key = code;
    document.getElementById('roomTools').hidden = true;
    document.getElementById('usersSection').hidden = false;
    document.getElementById('messagesSection').hidden = false;
    document.getElementById('adminEmpty').hidden = true;
    document.getElementById('watchedRoomCode').textContent = code;
    const nameEl = document.getElementById('watchedRoomName');
    nameEl.textContent = currentRoom.name;
    nameEl.hidden = !currentRoom.name;
    renderUsers(currentRoom.users);
    renderFeed(currentRoom.messages);
    updateCounts();
    refreshRooms();
    if (typeof then === 'function') then();
  });
}

// ---------------- The people in the watched hall (kind person) ----------------
/** A person as the catalogue reads them, with the watched hall's name and the names of the halls they may forward into. */
function personObject(sid) {
  const u = currentRoom && currentRoom.users.find((x) => x.socketId === sid);
  if (!u) return null;
  const linkedNames = {};
  for (const rm of u.linkedRooms || []) { const nm = roomNameForCode(rm); linkedNames[rm] = nm ? nm + ' · ' + rm : rm; }
  return { ...u, hall: hallName(), linkedNames };
}
const hallName = () => (currentRoom ? currentRoom.name || roomNameForCode(currentRoom.code) || currentRoom.code : '');
/** The people, drawn in place by their page's id: Name, Seat (a code guest's select; an account's follows its rights), May forward to, and the ⋯. */
function renderUsers(users) {
  const tb = document.getElementById('usersTbody');
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="4" class="muted">No-one has joined yet.</td></tr>';
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
      for (let i = 0; i < 4; i++) tr.appendChild(document.createElement('td'));
      const bar = document.createElement('span');
      bar.className = 'obj-bar';
      tr.lastElementChild.appendChild(bar);
    }
    const [nameTd, seatTd, linksTd] = tr.children;
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
/** Let them forward into ▸: every other hall, ticked where this person may forward into it now (asked as it opens). */
function forwardTargets(o) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) { resolve([{ id: '', label: AGM.catalog.WORDS.offline, disabled: AGM.catalog.WORDS.offline }]); return; }
    socket.emit('admin:listRooms', (res) => {
      if (!res || !res.ok) { resolve([{ id: '', label: (res && res.error) || 'Could not list the halls.', disabled: (res && res.error) || 'Could not list the halls.' }]); return; }
      allRooms = res.rooms;
      const home = currentRoom ? currentRoom.code : '';
      // The people as this answer has them, so a hall ticked here is one the person's own acts read as linked too.
      const cur = res.rooms.find((r) => r.code === home);
      if (cur && currentRoom) { currentRoom.users = cur.users; renderUsers(cur.users); }
      const now = new Set(((cur || { users: [] }).users.find((u) => u.socketId === o.socketId) || { linkedRooms: [] }).linkedRooms || []);
      const others = res.rooms.filter((r) => r && r.code && r.code !== home).sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code));
      if (!others.length) { const w = 'No other hall yet: make one with New hall.'; resolve([{ id: '', label: w, disabled: w }]); return; }
      resolve(others.map((r) => ({ value: r.code, label: r.name ? r.name + ' · ' + r.code : r.code, role: 'menuitemcheckbox', checked: now.has(r.code) })));
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
  else if (m.type === 'file') bodyHtml = `<p>📄 ${escapeHtml(m.filename)}${m.caption ? ` — <em>${escapeHtml(m.caption)}</em>` : ''}</p>`;
  else if (m.type === 'action') {
    bodyHtml = `<p>🟧 <strong>${escapeHtml(m.text)}</strong></p>` +
           `<p class="muted">Options: ${escapeHtml((m.options || []).join(' · '))}</p>`;
  } else if (m.type === 'help') bodyHtml = `<p>■ <strong>${escapeHtml(m.category || 'Help')}</strong> ${escapeHtml(m.text || '')}</p>`;
  // A message its page held before sending it (written offline) says when it was written and when it was sent.
  const heldHtml = Number.isInteger(m.held) && m.held > 0 ? '<div class="held-line">written ' + escapeHtml(formatTime(m.at - m.held * 1000)) + ' · sent ' + escapeHtml(formatTime(m.at)) + ' (offline)</div>' : '';
  div.innerHTML =
    `<div class="admin-msg-head">${whoHtml} <time>${escapeHtml(formatTime(m.at))}</time>${m.priority ? ' <span class="priority-badge" style="display:inline-block">🔥 HIGH</span>' : ''}</div>` +
    `<div class="admin-msg-body">${bodyHtml}${heldHtml}</div>` +
    '<div class="admin-msg-foot obj-bar"></div>';
  ADMIN.draw(div.querySelector('.obj-bar'), 'adminMsg', { ...m, hall: hallName() }, { more: 'Message actions', keysOn: div });
  return div;
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
/** The seat picker's options, the person's own selected. */
function roleOptionsHtml(current) {
  return ['board', 'research', 'observer'].map((r) => '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' + escapeHtml(seatWord(r)) + '</option>').join('');
}
/** A seat in the words every page uses for it; the role word stays the value the server reads. */
function seatWord(role) {
  return role === 'board' || role === 'director' ? 'On stage' : role === 'research' ? 'Backstage' : role === 'observer' ? 'Observer' : role;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function openUserView(code, name, role) {
  const modal = document.getElementById('userViewModal');
  const frame = document.getElementById('userViewFrame');
  const title = document.getElementById('userViewTitle');
  // Cache-bust so each open is a fresh load (avoids stale iframe state)
  const params = new URLSearchParams({ code, name, role, adminView: '1', t: String(Date.now()) });
  frame.src = '/app.html?' + params.toString();
  title.textContent = 'Viewing ' + name + ' (' + seatWord(role) + ') in ' + (roomNameForCode(code) || code);
  modal.hidden = false;
  // Stash for the Resync button
  modal.dataset.code = code;
  modal.dataset.name = name;
  modal.dataset.role = role;
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
    if (code && name && role) {
      const params = new URLSearchParams({ code, name, role, adminView: '1', t: String(Date.now()) });
      frame.src = '/app.html?' + params.toString();
    }
  }, 1200);
});
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('userViewModal');
  if (e.key === 'Escape' && !e.defaultPrevented && modal && !modal.hidden) closeUserView();
});
document.getElementById('userViewModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'userViewModal') closeUserView();
});

function roomNameForCode(code) {
  const r = (allRooms || []).find((rr) => rr && rr.code === code);
  return (r && r.name) || '';
}

// ---------------- What each act does (the catalogue's rows are in catalog.js) ----------------
Object.assign(ADMIN_RUN, {
  'adminRoom.watch': (o) => watchRoom(o.code),
  'adminRoom.transcript': (o) => { window.open('/api/admin/transcript/' + encodeURIComponent(o.code), '_blank', 'noopener'); },
  'adminRoom.clear': (o) => AGM.outbox.now('admin:resetRoom', { roomCode: o.code }, (res) => {
    if (!res?.ok) { say(res?.error || 'Not cleared.', true); return; }
    say('Cleared every message in ' + o.hall + '.');
    if (currentRoom && currentRoom.code === o.code) { currentRoom.messages = []; renderFeed(currentRoom.messages); updateCounts(); }
  }),
  'adminRoom.remove': (o, c) => AGM.outbox.now('admin:deleteRoom', { roomCode: o.code, purgeFiles: !!(c.values && c.values.purge) }, (res) => {
    if (!res || !res.ok) { say((res && res.error) || 'Not closed.', true); return; }
    location.reload();
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
  // A hall ticked already is unticked: that is No longer forward into ▸, its own act.
  'person.forward': (o, c) => {
    if (!c.value) return;
    if (c.item && c.item.checked) ADMIN.act('person', 'person.unforward', o, c);
    else forwardInto(o, c.value, true);
  },
  'person.unforward': (o, c) => { if (c.value) forwardInto(o, c.value, false); },
  'person.view': (o) => openUserView(currentRoom.code, o.name, o.role),
  'person.kick': (o) => AGM.outbox.now('admin:kick', { socketId: o.socketId }, (res) => { if (!res || !res.ok) say((res && res.error) || 'Not logged out.', true); else say(o.name + ' is logged out of ' + o.hall + '.'); }),
  'adminMsg.copy': (o, c) => AGM.copy(o.text, { said: 'Copied.', anchor: c.anchor, say }),
  'adminMsg.delete': (o) => AGM.outbox.now('admin:deleteMessage', { roomCode: currentRoom.code, messageId: o.id }, saidIfNot('Not deleted.')),
});
const objectSpec = (kind, sel, get, more, gone) => ({ kind, find: (el) => el.closest(sel), get, label: more, gone });
ADMIN.bind(document.getElementById('roomList'), objectSpec('adminRoom', '#roomList > li[data-key]', roomObject, 'Hall actions', 'That hall is gone.'));
ADMIN.bind(document.getElementById('roomHeader'), { ...objectSpec('adminRoom', '#roomHeader', roomObject, 'Hall actions', 'That hall is gone.'), header: (o) => o.hall });
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
// this laptop ("Checked 14:02 · round trip 85 ms (max 140 ms)"). Its acts are the catalogue's: Check again (at most
// once a minute, saying why it cannot when it cannot), Copy address, Turn on, and Turn off…, asked first: the toggle is
// a door to the same two acts.

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

  /** The internet link as the catalogue reads it: on or not, its address, a check running, and how long ago the last was. */
  function object() {
    const s = last || {};
    const check = s.check && typeof s.check === 'object' ? s.check : null;
    return { running: !!s.running, url: s.running && typeof s.url === 'string' ? s.url : '', checking: !!s.checking, checkedAgo: check ? (Date.now() - check.at) / 1000 : null };
  }
  const hhmm = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    put(line, !up ? '' : check ? (check.ok ? 'Checked ' + hhmm(check.at) + ' · ' + check.words : '△ ' + check.words) : s.checking ? '' : 'Not checked yet.');
    line.classList.toggle('bad', !!(up && check && !check.ok));
    const r = AGM.catalog.ready('tunnel', 'tunnel.check', ADMIN_F, o);
    put(why, refusedWhy || (r === true ? '' : r));
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
    'tunnel.on': () => {
      showState('starting');
      if (toggle) toggle.checked = true;
      AGM.outbox.now('admin:tunnelStart', undefined, (res) => {
        if (!res || !res.ok) { showState('error', { error: (res && res.error) || 'Could not start tunnel' }); if (toggle) toggle.checked = false; }
        // success path: status:push will switch us to on/starting
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
