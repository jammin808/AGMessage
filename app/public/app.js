// AGMessage client.

// Below the page floor (theme-init.js) the hall page shows the floor's words and nothing else: this script ends here,
// before it draws anything or opens a socket. A classic script's top level has no return, so it ends by throwing.
if (document.documentElement.dataset.floor === 'old') throw new Error('This browser is below AGMessage\'s page floor: the hall page does not run here.');

const qs = new URLSearchParams(location.search);
const ROOM = (qs.get('code') || '').toUpperCase();
// A signed-in account opens a hall with ?code=…&as=account (its name and rights come from the server); anyone else
// with ?code=…&name=…&role=… from the join page.
const AS_ACCOUNT = qs.get('as') === 'account';
let NAME = AS_ACCOUNT ? '' : (qs.get('name') || '');
const ROLE = qs.get('role') || 'observer';
// An account's way back is its halls board, which stays (?stay=1): an account with one room alone is taken straight into
// it from there, and going back must never bounce.
const HOME = AS_ACCOUNT ? '/halls.html?stay=1' : '/';
const ADMIN_VIEW = qs.get('adminView') === '1';
// The person the admin's support view shows (their uid in the room's people): the server tells it what that person's pages
// are shown. Only the support view names one.
const VIEW_OF = ADMIN_VIEW ? (qs.get('viewOf') || '') : '';
// Identity: issued and signed by the server on first join, kept on this device, so nobody can
// pick someone else's. MY_UID is the id inside it (what messages and reactions carry).
let IDENTITY = localStorage.getItem('agm.id') || '';
let MY_UID = '';
const INVITE = qs.get('invite') || '';
let UPLOAD_TOKEN = '';
let lastSeq = -1;            // the newest change we have; resume from here after a drop
let joined = false;
// Out of the hall (sent out, the hall closed, or the join refused): from then on the page offers nothing of the hall.
let outOf = false;
// What this person may do with the hall's Stagewatch (🖥 send now, 📝 propose): the server's answer, from the join and
// again from stage:targets whenever the link's state or its desk changes — never read off the hall-wide 'stage' event.
let CAN_STAGE = false;
let CAN_PROPOSE = false;   // Stagewatch keeps the show's approval queue (Show Bus 1.2 §11) and this person may send there
let STAGE_KEY = '';        // the link's state and desk the flags were last asked for (a frame moving changes no right)
let AI_ON = false;
let CAN_SCREENS = false;   // this account may drive the hall's screens (display.control)
const HAS_STAGE = ROLE === 'board' || ROLE === 'research';
// Read only (an observer, a Viewer account): the server refuses every post, so the page draws no composer.
const readOnly = () => document.body.dataset.role === 'observer';
// What this page may do, and with what, is the action catalogue's (catalog.js): its facts are what the server told this
// page (the join's answer, the screens it may drive, the link's state, whether it is connected), kept current by its
// events, and every button, menu and key on a message, a file, a screen, a person, the composer and the header's chips is
// drawn from the catalogue's entries for them. A page binds only what each act does: RUN, by the entry's id.
const pageFacts = { role: ROLE, uid: '', account: null, uploadToken: '', canSendToStage: false, canPropose: false, ai: false, stage: null, forwardable: false, sends: false, targets: [], adminView: ADMIN_VIEW, name: NAME, screens: null, connected: false, guestCode: '', codeOn: false, setsCode: false, admin: false };
let F = AGM.catalog.facts(pageFacts);
// Whether this page's room is its hall's Main room (the join's `main`; a hall until it answers): its seat words follow it
// (roleLabel).
let MAIN = true;
// The room's hall as the server tells this page (the join's `hallName`, `rooms`, and each `rooms:changed`): its name, for
// the header's title ("Hall 2 › Legal"), and the rooms of it this person may move between, the switcher's.
let HALL_NAME = '';
let ROOMS = [];
// Where the composer's next message or file goes (To:): '' for this room, else the reference of a room this room may send
// into (the catalogue's compose.sendTo). It goes back to this room after every send.
let sendTo = '';
const RUN = {};

// ---------------- UI sync state (declared early to avoid TDZ traps) ----------------
// These are accessed by pushUserState / setStageCollapsed / setZoom / applyTheme,
// some of which run during boot (e.g. setStageCollapsed(true) when the user had
// the stage collapsed last session). Declaring them at the top guarantees they
// are out of TDZ before any boot-time call hits them. See CLAUDE.md gotcha #8.
const _pendingStates = [];
let _applyingRemote = false;

if (!ROOM || (!NAME && !AS_ACCOUNT)) location.href = '/';

document.body.dataset.role = ROLE;
// The code chip shows the room's guest code as the server tells this page it (the join's answer, and each change of it),
// and nothing until then: the address's code is how the page names its room (an account's, its key), not a code it is told.
const _roomChip = document.getElementById('roomChip');
_roomChip.hidden = true;
document.getElementById('whoami').textContent = AS_ACCOUNT ? '' : `${NAME} · ${roleLabel(ROLE)}`;
document.querySelectorAll('a[href="/"].btn').forEach((a) => { a.href = HOME; if (AS_ACCOUNT) a.textContent = 'All halls'; });

// ---------------- Theme (dark mode) ----------------
const themeBtn = document.getElementById('themeBtn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  if (themeBtn) {
    themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
    themeBtn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
}
applyTheme(localStorage.getItem('agm.theme') || 'light');
themeBtn?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('agm.theme', next);
  applyTheme(next);
  if (!_applyingRemote) pushUserState('theme', next);
});

// ---------------- Message text zoom ----------------
const ZOOM_KEY = 'agm.zoom';
let currentZoom = parseFloat(localStorage.getItem(ZOOM_KEY) || '1') || 1;
function applyZoom() {
  document.documentElement.style.setProperty('--zoom-msg', String(currentZoom));
}
function setZoom(z) {
  currentZoom = Math.max(0.7, Math.min(2.2, Math.round(z * 100) / 100));
  localStorage.setItem(ZOOM_KEY, String(currentZoom));
  applyZoom();
  if (!_applyingRemote) pushUserState('zoom', currentZoom);
}
applyZoom();
document.getElementById('zoomInBtn')?.addEventListener('click', () => setZoom(currentZoom + 0.1));
document.getElementById('zoomOutBtn')?.addEventListener('click', () => setZoom(currentZoom - 0.1));
document.getElementById('zoomResetBtn')?.addEventListener('click', () => setZoom(1));



if (ROLE === 'board') document.getElementById('directorCompose').hidden = false;
if (ROLE === 'research') document.getElementById('researchCompose').hidden = false;

// ---------------- Socket ----------------
// The socket comes back by itself (reconnect.js): after a refusal at the server's pace, after a drop, and at once when the
// page is shown again or the browser is back online. The page is back once its join is answered: the strip says
// "Reconnecting…" after 2 s without it, the dot's words after 5 s, and both go at the answer.
const socket = io({ transports: ['websocket', 'polling'], auth: AGM.reconnect.auth(), ...AGM.reconnect.OPTIONS });
const connDot = document.getElementById('connDot');
const connWords = document.getElementById('connWords');
const connection = AGM.reconnect.attach(socket, { join: true, down: true, strip: document.getElementById('connStrip'), onChange: drawConnection });
/** The dot: its colour, its name for a screen reader (what is true now), and its words once the page has been down 5 s. */
function drawConnection(st) {
  const name = AGM.reconnect.dotName(st);
  connDot.classList.toggle('ok', st.back);
  connDot.setAttribute('aria-label', name);
  connDot.title = name;
  connWords.hidden = !st.dot;
}
// Every write goes through the outbox (outbox.js): what a person wrote is held until the server answers it, and drawn
// here meanwhile (drawHeld, below).
AGM.outbox.attach(socket, { onChange: (item) => drawHeld(item) });
/** An act's answer: nothing to say when it is done, the server's words (or the outbox's) when it is not. */
const saidIfNot = (fallback) => (r) => { if (!r || !r.ok) AGM.toast((r && r.error) || fallback, true); };

socket.on('connect', rejoin);

/** Join (or rejoin after a drop): the server sends only what we missed when it still has it. */
function rejoin() {
  const who = AS_ACCOUNT ? { as: 'account' } : { name: NAME, role: ROLE, uid: IDENTITY, invite: INVITE };
  socket.emit('join', { roomCode: ROOM, adminView: ADMIN_VIEW, ...(VIEW_OF ? { viewOf: VIEW_OF } : {}), since: joined ? lastSeq : undefined, ...who }, (res) => {
    if (!res || !res.ok) {
      // Signing in is the way into this hall: the sign-in page opens, and brings the person back here after.
      if (res && res.signIn) {
        AGM.toast(res.error || 'Sign in first.', true);
        setTimeout(() => { location.href = '/?next=' + encodeURIComponent(location.pathname + location.search); }, 2500);
        return;
      }
      // A guest's link refused because this browser is signed in goes back to the code link it came from, which offers
      // the halls or Sign out and keeps the code (and an invite's role) for after.
      const back = new URLSearchParams({ code: ROOM });
      if (INVITE) { back.set('role', ROLE); back.set('invite', INVITE); }
      outOfHall((res && res.error) || 'This code doesn\'t open a room now. Check it with whoever gave it to you.', res && res.signedIn ? '/?' + back.toString() : HOME);
      return;
    }
    // An account's role in a hall is the server's, from its rights; the page is built for the URL's at load, so a URL
    // that says otherwise (a bookmark, an old link) opens again with the right one. Once: the next join agrees.
    if (AS_ACCOUNT && res.role && res.role !== ROLE) {
      const q = new URLSearchParams(location.search);
      q.set('role', res.role);
      location.replace(location.pathname + '?' + q.toString());
      return;
    }
    // A side room's backstage seat is a Member's: its seat words follow the room's kind before anything is drawn with them.
    MAIN = res.main !== false;
    hallTold(res);
    if (res.account) {
      NAME = res.account.name;
      document.getElementById('whoami').textContent = `${res.account.name} · ${res.account.roleLabel}`;
    } else if (!AS_ACCOUNT) document.getElementById('whoami').textContent = `${NAME} · ${roleLabel(res.role || ROLE)}`;
    if (res.identity) { IDENTITY = res.identity; try { localStorage.setItem('agm.id', IDENTITY); } catch { /* private mode: identity lives for this tab only */ } }
    MY_UID = res.uid || MY_UID;
    UPLOAD_TOKEN = res.uploadToken || '';
    CAN_STAGE = !!res.canSendToStage;
    CAN_PROPOSE = !!res.canPropose;
    STAGE_KEY = stageKey(res.stage);
    AI_ON = !!res.ai;
    // The catalogue's facts from this answer, before anything is drawn with them; `connected` once the outbox is ready.
    factsChanged({ role: res.role || ROLE, uid: MY_UID, account: res.account || null, uploadToken: UPLOAD_TOKEN, canSendToStage: CAN_STAGE, canPropose: CAN_PROPOSE, ai: AI_ON, stage: res.stage || null, forwardable: !!res.forwardable, name: NAME,
      guestCode: typeof res.guestCode === 'string' ? res.guestCode : '', codeOn: !!res.codeOn, setsCode: !!res.setsCode, sends: !!res.sends, ...(res.sends ? {} : { targets: [] }), admin: res.admin === true });
    drawChips();
    drawAiButtons();
    if (res.note) AGM.toast(res.note);
    if (res.role && res.role !== ROLE) { document.body.dataset.role = res.role; }
    if (readOnly()) { document.getElementById('directorCompose').hidden = true; document.getElementById('researchCompose').hidden = true; }
    drawSkip();
    // What this person wrote here and had not sent when they moved to another room of the hall, back in its composer.
    if (!joined) takeDraft();
    drawComposers();
    renderStage(res.stage);
    document.getElementById('helpBtn').hidden = (res.role || ROLE) === 'observer';
    if (AS_ACCOUNT || ADMIN_VIEW) Screens.load();
    (res.seen || []).forEach(noteSeen);
    if (res.roomName) setRoomTitle(res.roomName);
    if (Array.isArray(res.ops)) {
      // Just the gap, drawn in one pass: where the reader is is read once before it, and the feed moved at most once
      // after it, so a page back from a drop reads no layout per message it missed.
      catchUp = { follow: readerAtEnd(), toEnd: false };
      try { for (const op of res.ops) applyOp(op); } finally {
        const done = catchUp;
        catchUp = null;
        if (done.toEnd) scrollToBottom();
      }
    } else {
      renderHistory(res.history || []);
    }
    lastSeq = Math.max(lastSeq, res.seq || 0);
    joined = true;
    connection.joined();
    renderUsers(res.users || []);
    refreshSeenLines();
    reportSeen();
    // Joined, with what it missed drawn (so a held send that landed meanwhile is already matched): what this person
    // holds for this hall is sent now, a reload's included, and a reload's send already among the drawn is done.
    AGM.outbox.ready({ scope: 'hall|' + ROOM, who: MY_UID, has: (cid) => allMessages.some((m) => m.cid === cid && !!m.from && m.from.uid === MY_UID) });
    factsChanged({ connected: AGM.outbox.online });
    // The rooms this page may send into, when the join says there are some.
    if (res.sends) askTargets();
    // The build serving now: on another, this page reloads itself at a quiet moment (below).
    AGM.reconnect.build.heard(res.build);
  });
}
/**
 * On another build than its server's, this page reloads itself (reconnect.js) at a quiet moment: connected and in its
 * hall, nothing written and not sent (the outbox holding nothing and waiting on no act's answer, every composer empty, no
 * file chosen), no dialog, menu or ask open, no document on its stage, and untouched for a few seconds (or not shown).
 */
const COMPOSER_FIELDS = ['directorInput', 'textInput', 'actionText', 'actionOptionInput', 'fileCaption'];
function hallQuiet(t) {
  return AGM.reconnect.QUIET.hall({
    ...t, online: AGM.outbox.online, out: outOf, held: AGM.outbox.items().length > 0 || AGM.outbox.acting() > 0, document: currentDocMsgId !== null,
    draft: !!pendingFile || COMPOSER_FIELDS.some((id) => { const el = document.getElementById(id); return !!el && el.value.trim() !== ''; }),
    dialog: !!document.querySelector('dialog[open]') || AGM.menu.isOpen() || AGM.ask.isOpen(),
  });
}
AGM.reconnect.build.when(hallQuiet, { stays: (words) => AGM.toast(words) });
// Down: an act on something is refused at once (it would otherwise be sent late), and every door says so.
socket.on('disconnect', () => factsChanged({ connected: false }));

/**
 * The page's facts changed: each object's bar is drawn again where what it offers changed, and an open menu keeps its
 * items in place and says what each says now (R5).
 */
function factsChanged(patch) {
  Object.assign(pageFacts, patch || {});
  const next = AGM.catalog.facts(pageFacts);
  if (JSON.stringify(next) === JSON.stringify(F)) return;
  F = next;
  const records = new Map(allMessages.map((m) => [m.id, m]));
  for (const [id, node] of messagesById) { const m = records.get(id); if (m && m.type !== 'system' && node.classList.contains('msg')) drawActs(node, m); }
  for (const node of document.querySelectorAll('#pinnedList .msg[data-id]')) { const m = records.get(node.dataset.id); if (m) drawActs(node, m); }
  drawDocActs();
  refreshDocPinnedList();
  Screens.redraw();
  drawPeopleActs();
  drawComposers();
  drawChips();
  refreshOpenMenu();
}

/**
 * The rooms a message could be sent to: whether there are any is the `forwardable` fact, from the join's answer, asked
 * again when the admin links this person to another hall or takes it back (linkedRoomsChanged), and when the page is
 * shown again (another hall may have been opened in another tab meanwhile).
 */
function askForwardable() {
  if (!joined || !socket.connected || ADMIN_VIEW) return;
  socket.emit('myRooms', {}, (r) => { if (r && r.ok && Array.isArray(r.rooms)) factsChanged({ forwardable: r.rooms.length > 0 }); });
}
socket.on('linkedRoomsChanged', askForwardable);
/**
 * The rooms this page may send into by their lists (room:sendTargets): each by its reference, its name and its hall's,
 * never a key. Asked when the join says there are some, and when the server says the rooms this room sends into changed
 * (`sendsChanged`: a list, or a name); a room To: was set to that is no longer one goes back to this room. A read the
 * rate held back is asked once more after a second, so a change is not missed for a busy moment.
 */
function askTargets(again) {
  if (!joined || !socket.connected || ADMIN_VIEW) return;
  socket.emit('room:sendTargets', {}, (r) => {
    if (r && r.busy && !again) { setTimeout(() => askTargets(true), 1000); return; }
    if (!r || !r.ok || !Array.isArray(r.targets)) return;
    factsChanged({ sends: r.targets.length > 0, targets: r.targets });
    if (sendTo && !F.targets.some((t) => t.ref === sendTo)) setSendTo('');
  });
}
socket.on('sendsChanged', () => askTargets(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') askForwardable(); });

/** The room as the header names it (a hall's Main room by the hall's name; a rename arrives as a numbered change, like
 * everything else): the header's title, the code chip's title, and the name of Send (the catalogue's compose.send), which
 * says where a message goes (its word "Send" first, the word a person sees on it). */
let ROOM_NAME = '';
function setRoomTitle(name) {
  if (!name) return;
  ROOM_NAME = name;
  const chip = document.getElementById('roomChip');
  if (chip) chip.title = name;
  drawTitle();
  drawComposers();
  refreshOpenMenu();
}

// ---------------- The header's title and the room switcher (kind `room`) ----------------
// A room switch is a page navigation: each page holds one room, one stream and one seat. The switcher's segments are real
// links (a middle click opens a tab), each seated as the server will seat this person there, so the room opens built for
// its seat. On a tap the title and the current mark move at once, before the navigation, and what this person wrote here
// and has not sent is kept for this tab (sessionStorage), back in its composer when they come back to this room.
const switcherEl = document.getElementById('roomSwitcher');
/** A room as the header names it: a Main room by its hall's name, a side room by its hall's and its own. */
const titleOf = (main, name) => (main ? name || HALL_NAME : (HALL_NAME || 'A hall with no name') + ' › ' + (name || 'A room'));
/** The header's title and the tab's: this room's, or the room being moved to. */
function drawTitle(words = ROOM_NAME ? titleOf(MAIN, ROOM_NAME) : '') {
  if (!words) return;
  document.title = 'AGMessage · ' + words;
  const strong = document.querySelector('.app-title strong');
  if (strong && strong.textContent !== words) strong.textContent = words;
}
/** The rooms the server lists for this page, read by type: each by its key, name, whether it is Main, and its seat. */
function roomsFrom(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && typeof r.key === 'string' && r.key.length > 0)
    .map((r) => ({ key: r.key, name: typeof r.name === 'string' ? r.name : '', main: r.main === true, seat: ['board', 'research', 'observer'].includes(r.seat) ? r.seat : 'observer' }));
}
/** What the server told this page of its hall (the join's answer, a `rooms:changed`): the header and the switcher follow. */
function hallTold(f) {
  if (typeof f.hallName === 'string') HALL_NAME = f.hallName;
  ROOMS = roomsFrom(f.rooms);
  drawTitle();
  drawSwitcher();
}
/** A room of the switcher as the catalogue reads it (kind room), by its key: this room's guest code where it is told it. */
function switcherObject(key) {
  const r = ROOMS.find((x) => x.key === key);
  if (!r || outOf) return null;
  const current = r.key === ROOM;
  return { id: 'room:' + r.key, key: r.key, name: r.main ? 'Main' : r.name || 'A room', hall: HALL_NAME || 'A hall with no name', title: titleOf(r.main, r.name),
    href: '/app.html?' + new URLSearchParams({ code: r.key, as: 'account', role: r.seat }).toString(), current, guestCode: current ? pageFacts.guestCode : '', hallKey: '' };
}
/** The switcher, with two rooms or more: each a segment kept by its key, `current` marked (this room, or the one tapped). */
function drawSwitcher(current = ROOM) {
  switcherEl.hidden = outOf || ROOMS.length < 2;
  const keep = new Map([...switcherEl.querySelectorAll(':scope > a[data-key]')].map((a) => [a.dataset.key, a]));
  ROOMS.forEach((r, i) => {
    let a = keep.get(r.key);
    keep.delete(r.key);
    if (!a) { a = document.createElement('a'); a.className = 'room-seg'; a.dataset.key = r.key; a.dataset.objectLink = '1'; }
    const o = switcherObject(r.key);
    if (!o) return;
    if (a.getAttribute('href') !== o.href) a.setAttribute('href', o.href);
    if (a.textContent !== o.name) a.textContent = o.name;
    if (a.title !== o.title) a.title = o.title;
    if (r.key === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    if (switcherEl.children[i] !== a) switcherEl.insertBefore(a, switcherEl.children[i] || null);
  });
  for (const a of keep.values()) a.remove();
}
/** Moving to another room of the hall: this room's unsent words kept, the title and the mark the room's, before it opens. */
function movingTo(o) {
  keepDraft();
  drawTitle(o.title);
  drawSwitcher(o.key);
}
switcherEl.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.room-seg[data-key]');
  // A click that opens a tab or a window leaves this page as it is.
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const o = switcherObject(a.dataset.key);
  if (!o) { e.preventDefault(); return; }
  if (o.current) { e.preventDefault(); return; }
  movingTo(o);   // the link's own navigation follows
});
AGM.menu.door(switcherEl, (t) => {
  const a = t.closest && t.closest('a.room-seg[data-key]');
  if (!a || !switcherObject(a.dataset.key)) return null;
  const get = () => switcherObject(a.dataset.key);
  return { el: a, more: a, open: (at) => openObjectMenu('room', get, { node: a, more: a, at, opener: a, label: 'Actions for ' + get().name, header: (o) => o.title }) };
});
Object.assign(RUN, {
  'room.open': (o) => { movingTo(o); location.assign(o.href); },
  'room.tab': (o) => { window.open(o.href, '_blank', 'noopener'); },
  'room.copy': (o, { anchor }) => copyText(new URL(o.href, location.href).href, 'Copied the link to ' + o.title + '.', anchor),
  'room.code': (o, { anchor }) => copyText(o.guestCode, 'Copied the guest code of ' + o.title + ', ' + o.guestCode + '.', anchor),
});
socket.on('rooms:changed', (f) => { if (f && typeof f === 'object' && !outOf) { hallTold(f); refreshOpenMenu(); } });
// A page the browser kept and shows again (Back, from its cache) draws its own room again, not the one it was left for,
// and holds its words itself: what was kept of them for its next load is let go, so a send from here never comes back.
window.addEventListener('pageshow', (e) => { if (e.persisted) { drawTitle(); drawSwitcher(); dropDraft(); } });

/**
 * Where this room's unsent words are kept for this tab while its person is in another room of the hall: by the room and
 * the person (the join's uid), as the outbox keeps a held send, so another account signed in on this tab is never handed
 * them. Nothing is kept before the join has said who this is.
 */
const draftKey = () => (MY_UID ? 'agm.draft|' + ROOM + '|' + MY_UID : '');
/** This room's composers' unsent words, kept (a composer holding a send the outbox keeps already is not). */
function keepDraft() {
  const key = draftKey();
  if (!key) return;
  const kept = {};
  for (const id of COMPOSER_FIELDS) {
    const el = document.getElementById(id);
    if (el && !el.readOnly && el.value.trim() !== '') kept[id] = el.value;
  }
  try {
    if (Object.keys(kept).length) sessionStorage.setItem(key, JSON.stringify(kept)); else sessionStorage.removeItem(key);
  } catch { /* storage blocked: the words stay with this page alone */ }
}
/** What was kept of this room's words, let go. */
function dropDraft() {
  const key = draftKey();
  try { if (key) sessionStorage.removeItem(key); } catch { /* storage blocked: nothing was kept */ }
}
/** This room's words kept when its person moved away, back in their composers (an empty one only), and let go. */
function takeDraft() {
  const key = draftKey();
  if (!key) return;
  let raw, kept;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch { return; /* storage blocked: nothing was kept */ }
  try { kept = JSON.parse(raw || 'null'); } catch { return; /* a record that is not one: nothing comes back */ }
  if (!kept || typeof kept !== 'object') return;
  for (const id of COMPOSER_FIELDS) {
    const el = document.getElementById(id);
    if (el && typeof kept[id] === 'string' && el.value === '') el.value = el.maxLength > 0 ? kept[id].slice(0, el.maxLength) : kept[id];
  }
}

// Every change carries the room's sequence number. A jump means we missed one: resume from what we have.
function bump(seq) {
  if (!Number.isInteger(seq)) return true;
  if (lastSeq >= 0 && seq > lastSeq + 1 && joined) { rejoin(); return false; }
  if (seq > lastSeq) lastSeq = seq;
  return true;
}
// The op table's page half: each field a numbered change (`upd`) carries → the event it arrives under live, and how it
// is drawn. A resumed page (the ops it missed, applyOp) and a live one (the listeners made from it below) draw a change
// through the same row, so the two cannot draw it differently. lib/ops.js is the server's half, and
// test/modules.test.js (k) holds the two equal, field by field and event by event.
const UPD_EVENTS = {
  responses: ['actionUpdate', updateActionResponses],
  pinned: ['pinUpdate', setMessagePinned],
  reactions: ['messageReact', setReactions],
  stage: ['stageAck', setStage],
  proposal: ['proposalUpdate', setProposal],
  help: ['helpUpdate', setHelp],
  sentTo: ['sentUpdate', setSentTo],
  replyTo: ['replyUpdate', setReplyTo],
};
const ownField = (o, f) => Object.prototype.hasOwnProperty.call(o, f);
function applyOp(op) {
  if (!op) return;
  if (op.o === 'add') { op.m.seq = op.s; addMessage(op.m, { silent: true, arrived: true }); }
  else if (op.o === 'upd' && op.f) {
    for (const field of Object.keys(UPD_EVENTS)) if (ownField(op.f, field)) UPD_EVENTS[field][1](op.id, op.f[field]);
  }
  else if (op.o === 'del') removeMessageLocal(op.id);
  else if (op.o === 'reset') onReset();
  else if (op.o === 'meta' && typeof op.name === 'string') setRoomTitle(op.name);
  if (op.s > lastSeq) lastSeq = op.s;
}

socket.on('message', (msg) => { if (!bump(msg.seq)) return; addMessage(msg, { arrived: true }); reportSeen(); });
socket.on('system', (msg) => { if (!bump(msg.seq)) return; addMessage(msg, { arrived: true }); });
socket.on('users', renderUsers);
// One listener per row of the op table: a change in order is drawn as a resumed one is; one past a gap rejoins.
for (const field of Object.keys(UPD_EVENTS)) {
  const [event, draw] = UPD_EVENTS[field];
  socket.on(event, (change = {}) => { if (bump(change.seq)) draw(change.messageId, change[field]); });
}
// Sent out of the hall: nothing this page holds is sent, now or when the person comes back in this tab.
socket.on('kicked', ({ reason }) => { AGM.outbox.clear(); outOfHall(reason || 'An admin sent you out.', HOME); });
/**
 * Out of the hall (sent out, the hall closed, or the join refused): the server's words in place of the hall, and the way
 * back, until the person takes it; nothing leaves by itself, so the words are read. The socket is let go: it does not
 * come back by itself (reconnect.js), and a page out of its hall neither joins again nor offers anything to write or
 * send: its dialogs and menus close, and the hall's own buttons go with the hall.
 */
function outOfHall(words, to) {
  outOf = true;
  document.getElementById('outWords').textContent = words;
  const back = document.getElementById('outBack');
  back.href = to;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  AGM.menu.close();
  AGM.ask.close();
  HelpChip.close(false);
  for (const id of ['helpBtn', 'screensBtn', 'peopleBtn', 'stageToggleBtn', 'skipLink']) document.getElementById(id).hidden = true;
  drawChips();
  drawSwitcher();
  document.querySelector('.main-row').hidden = true;
  document.getElementById('outOfHall').hidden = false;
  if (socket.connected) socket.disconnect();
  back.focus();
}
// An admin changed this account: the server closes the socket; open the hall again with the rights it has now.
socket.on('account:changed', ({ words } = {}) => { AGM.toast(words || 'Your account was changed — reloading.'); setTimeout(() => location.reload(), 1500); });
socket.on('roleChanged', ({ role }) => { AGM.toast('The admin changed your seat to ' + roleLabel(role) + ' — reloading…'); setTimeout(() => { const q = new URLSearchParams(location.search); q.set('role', role); location.search = q.toString(); }, 1500); });
const stageKey = (v) => (v ? v.status || '' : 'off') + '|' + !!(v && v.desk);
socket.on('stage', (v) => {
  renderStage(v);
  factsChanged({ stage: v || null });
  const key = stageKey(v);
  if (!joined || key === STAGE_KEY) return;
  STAGE_KEY = key;
  socket.emit('stage:targets', {}, (r) => {
    if (!r || !r.ok) return;
    const s = !!r.canSend, p = !!r.canPropose;
    if (s !== CAN_STAGE || p !== CAN_PROPOSE) { CAN_STAGE = s; CAN_PROPOSE = p; factsChanged({ canSendToStage: s, canPropose: p }); }
  });
});
// A proposal's state (pending → approved / rejected → done / failed), on the message it came from, or on its system
// line. A drawn message whose record is not held is given the line, as a system line is.
function setProposal(messageId, proposal) {
  const msg = findMessage(messageId);
  if (msg) msg.proposal = proposal;
  const node = messagesById.get(messageId);
  if (!node) return;
  if (msg && msg.type !== 'system') rerenderMessage(node, msg);
  else renderProposalLine(node, proposal);
}
function proposalLineText(p) {
  if (!p) return '';
  const by = p.by ? ' by ' + p.by : '';
  switch (p.state) {
    case 'pending': return '📝 Waiting for the show desk to approve' + (p.to ? ' — for ' + p.to : '');
    case 'approved': return '✓ Approved' + by + ' — running';
    case 'rejected': return '✗ Not approved' + by;
    case 'done': return '✓ Approved' + by + ' and done' + (p.words ? ': ' + p.words : '');
    case 'failed': return '⚠ Approved' + by + ' but it failed' + (p.words ? ': ' + p.words : '');
    case 'undelivered': return '⚠ Approved' + by + ' but not delivered' + (p.words ? ': ' + p.words : '');
    case 'unknown': return '⚠ Stagewatch\'s answer about this request is not one AGMessage can read — see the show desk' + (p.words ? ' (' + p.words + ')' : '');
    case 'lost': return '⚠ ' + (p.words || 'Stagewatch no longer has this request — ask again if it is still wanted');
    default: return '';
  }
}
function renderProposalLine(host, p) {
  let line = host.querySelector(':scope > .proposal-line, :scope .body > .proposal-line');
  const text = proposalLineText(p);
  if (!text) { if (line) line.remove(); return; }
  if (!line) {
    line = document.createElement('div');
    line.className = 'stage-line proposal-line';
    (host.querySelector('.body') || host).appendChild(line);
  }
  line.textContent = text;
  line.dataset.state = (p && p.state) || '';
}
// The hall's receipts that moved, in one frame per second at most: each applied, then the lines drawn once.
socket.on('seen', (frame) => {
  if (!frame || !Array.isArray(frame.seen)) return;
  frame.seen.forEach(noteSeen);
  refreshSeenLines();
});
socket.on('roomReset', ({ seq } = {}) => { if (bump(seq)) onReset(); });
socket.on('roomMeta', ({ name, seq } = {}) => { if (bump(seq)) setRoomTitle(name); });
function onReset() {
  // Admin cleared the room. Wipe local state but stay joined; what this page holds for sending is still drawn.
  feed.innerHTML = '';
  forgetPlace();
  messagesById.clear();
  allMessages.length = 0;
  for (const node of echoes.values()) feed.appendChild(node);
  refreshPinned();
  refreshDocPinnedList();
  HelpChip.draw();
  if (typeof dismissDoc === 'function') dismissDoc();
  refreshOpenMenu();
}
// A message sent to the speaker's screen: Stagewatch's receipt, then the speaker's acknowledgement, on that message.
function setStage(messageId, stage) {
  const msg = findMessage(messageId);
  if (msg) msg.stage = stage;
  const node = messagesById.get(messageId);
  if (!node) return;
  if (msg && msg.type !== 'system') rerenderMessage(node, msg);
  else renderStageLine(node, stage);
}
function stageLineText(st) {
  if (!st) return '';
  const by = st.by ? ' by ' + st.by : '';
  if (st.ack === 'done') return '✓ Acknowledged on stage' + by;
  if (st.ack === 'seen') return '✓ Seen on stage' + by;
  if (st.ack === 'lost') return '✕ No longer followed: that Stagewatch restarted, or this hall now follows another — the speaker\'s acknowledgement cannot be read';
  if (st.ack === 'sent') return st.receipt === 'applied' ? '⏳ On the speaker\'s screen — waiting for them to acknowledge' : '⏳ Stagewatch took it — waiting for the speaker';
  return st.receipt === 'applied' ? 'On the speaker\'s screen' : 'Sent to Stagewatch (not confirmed on screen)';
}
function renderStageLine(host, stage) {
  let line = host.querySelector(':scope > .stage-line, :scope .body > .stage-line');
  const text = stageLineText(stage);
  if (!text) { if (line) line.remove(); return; }
  if (!line) {
    line = document.createElement('div');
    line.className = 'stage-line';
    (host.querySelector('.body') || host).appendChild(line);
  }
  line.textContent = text;
  line.dataset.ack = (stage && stage.ack) || '';
}
function setReactions(messageId, reactions) {
  const msg = findMessage(messageId);
  if (msg) msg.reactions = reactions;
  const node = messagesById.get(messageId);
  if (node) renderReactions(node, reactions);
  // Its pinned copy says the same, and so does its open menu (React ▸'s checks).
  if (msg && msg.pinned) refreshPinned(messageId);
  if (openOn && openOn.kind === 'msg' && openOn.id === messageId) refreshOpenMenu();
}
socket.on('messageDeleted', ({ messageId, seq }) => {
  if (!bump(seq)) return;
  removeMessageLocal(messageId);
});

// ---------------- Seen receipts: who has read up to where ----------------
const seenBy = new Map();   // uid -> {name, role, seq}
function noteSeen(s) { if (s && s.uid && s.uid !== MY_UID) seenBy.set(s.uid, s); }
let seenTimer = null, seenSent = -1;
function reportSeen() {
  if (ADMIN_VIEW || document.visibilityState !== 'visible' || lastSeq <= seenSent) return;
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => { seenSent = lastSeq; socket.emit('seen', { seq: lastSeq }); }, 600);
}
document.addEventListener('visibilitychange', reportSeen);
window.addEventListener('focus', reportSeen);
function refreshSeenLines() {
  // Only my recent messages show who has seen them.
  const mine = allMessages.filter((m) => m.type !== 'system' && isMine(m) && Number.isInteger(m.seq)).slice(-25);
  for (const m of mine) {
    const node = messagesById.get(m.id);
    if (!node) continue;
    const who = Array.from(seenBy.values()).filter((s) => s.seq >= m.seq).map((s) => s.name);
    let line = node.querySelector('.seen-line');
    if (!who.length) { if (line) line.remove(); continue; }
    if (!line) { line = document.createElement('div'); line.className = 'seen-line'; node.appendChild(line); }
    const text = '✓ Seen by ' + (who.length <= 3 ? who.join(', ') : who.slice(0, 3).join(', ') + ' +' + (who.length - 3));
    if (line.textContent !== text) line.textContent = text;
  }
}

// ---------------- Stage (Stagewatch): the live timer, for everyone in the hall ----------------
/** The stage chip's object (catalog.js, kind `chip`): the link's last state that had a time, or null while it shows none. */
let stageNow = null;
function renderStage(v) {
  const chip = document.getElementById('stageChip');
  if (!chip) return;
  if (!v || !v.text) { chip.hidden = true; stageNow = null; drawChips(); refreshOpenMenu(); return; }
  chip.hidden = false;
  const live = !v.stale && (v.status === 'connected' || v.status === 'viewing');
  document.getElementById('stageTime').textContent = v.text;
  // Stagewatch's colour while the time is live; the last time known reads in the chip's dim ink, never faded
  document.getElementById('stageTime').style.color = live ? v.color || '' : '';
  document.getElementById('stageTitle').textContent = v.title || '';
  chip.classList.toggle('stale', !live);
  chip.title = (v.status === 'checking key' ? 'Stagewatch has not accepted this AGMessage\'s key yet: ' : live ? 'Live from Stagewatch: ' : 'Stagewatch link lost — last known: ') + (v.title || '') + (v.next ? ' · Next: ' + v.next : '') +
    (v.messageAck === 'done' ? ' · Speaker acknowledged the message' : '');
  stageNow = { id: 'stage', live, text: v.text, words: chip.title };
  drawChips();
  refreshOpenMenu();
}

// ---------------- The header's chips: the code (kind `code`) and the stage chip (kind `chip`) ----------------
// A chip with acts for this seat is a button that opens its menu (a click, Enter or Space, a right-click, Shift+F10 or the
// menu key); one without stays words, so nothing is drawn as a button that does nothing.
const stageChipEl = document.getElementById('stageChip');
/** The code chip's object: the room's guest code as this page is told it, whether it admits guests, and the room's name. */
const codeObject = () => ({ id: 'code', code: pageFacts.guestCode, on: !!pageFacts.codeOn, hall: ROOM_NAME || 'this room' });
const CHIPS = {
  roomChip: { kind: 'code', get: codeObject, label: 'Guest code actions', header: (o) => 'Guest code ' + o.code + (ROOM_NAME ? ' · ' + ROOM_NAME : '') },
  stageChip: { kind: 'chip', get: () => stageNow, label: 'Countdown actions', header: (o) => o.words },
};
function chipIsDoor(el, on) {
  if (on) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-haspopup', 'menu');
    if (!el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', 'false');
  } else for (const a of ['role', 'tabindex', 'aria-haspopup', 'aria-expanded']) el.removeAttribute(a);
}
/** The chips as the page stands: shown and a door where this seat has acts on them; out of the hall, neither. */
function drawChips() {
  _roomChip.hidden = outOf || !F.mayKnowCode;
  // Its code, and "(off)" while it admits nobody new.
  const words = pageFacts.guestCode + (pageFacts.codeOn ? '' : ' (off)');
  if (_roomChip.textContent !== words) _roomChip.textContent = words;
  if (outOf) stageChipEl.hidden = true;
  chipIsDoor(_roomChip, !outOf && !_roomChip.hidden && AGM.catalog.items('code', F, codeObject()).length > 0);
  chipIsDoor(stageChipEl, !outOf && !!stageNow && AGM.catalog.items('chip', F, stageNow).length > 0);
}
function chipDoor(t) {
  const el = t.closest && t.closest('#roomChip, #stageChip');
  if (!el || el.getAttribute('aria-haspopup') !== 'menu') return null;
  const c = CHIPS[el.id];
  return { el, more: el, open: (at) => openObjectMenu(c.kind, c.get, { node: el, more: el, at, opener: el, label: c.label, header: c.header }) };
}
function onChip(e) {
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  const door = chipDoor(e.target);
  if (!door) return;
  e.preventDefault();
  if (openOn && openOn.node === door.el) { AGM.menu.close(); return; }
  door.open({ anchor: door.el });
}
for (const el of [_roomChip, stageChipEl]) { el.addEventListener('click', onChip); el.addEventListener('keydown', onChip); }
AGM.menu.door(document.querySelector('.app-meta'), chipDoor);
Object.assign(RUN, {
  // Speaker's screen…: the line box, empty, to write a line and send it or ask the operator for it.
  'chip.speaker': () => ToStagewatch.open(null),
  'chip.screens': () => Screens.countdown(),
  'code.code': (o, { anchor }) => copyText(o.code, 'Copied the guest code, ' + o.code + '.', anchor),
  'code.copy': (o, { anchor }) => copyText(new URL('/?code=' + encodeURIComponent(o.code), location.href).href, 'Copied the join link: it opens the join page with this code.', anchor),
  // The admin switches the room's code and renews it from here, naming the room by its key (the address it opened);
  // what the room's pages are told comes back as each page's `guestCode` (below).
  'code.toggle': (o, c) => AGM.outbox.now('room:update', o.on ? { code: ROOM, codeOn: false, keepGuests: c.choice !== 'out' } : { code: ROOM, codeOn: true }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not changed.', true); return; }
    AGM.toast(r.codeOn ? 'The guest code is on: guests join with ' + o.code + '.'
      : Number.isInteger(r.sentOut) ? 'The guest code is off: ' + r.sentOut + (r.sentOut === 1 ? ' guest page was' : ' guest pages were') + ' sent out.'
        : 'The guest code is off: the guests in stay, and nobody new joins with it.');
  }),
  'code.new': () => AGM.outbox.now('room:update', { code: ROOM, newCode: true }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'No new code.', true); return; }
    AGM.toast('The new guest code is ' + r.guestCode + '.');
  }),
});
// The room's guest code changed (switched, renewed): this page is told it as it may know it ('' when it may not).
socket.on('guestCode', ({ guestCode, codeOn } = {}) => {
  factsChanged({ guestCode: typeof guestCode === 'string' ? guestCode : '', codeOn: !!codeOn });
  drawChips();
  refreshOpenMenu();
});
drawChips();

// ---------------- The toast (never a blocking dialog) ----------------
// What an act did, or why not, is said in the page's one toast (AGM.toast, common.js): a role=status region, so a screen
// reader hears it; one that can be taken back carries Undo for 10 s while it is neither hovered nor focused.

// ---------------- Feed rendering ----------------
const feed = document.getElementById('feed');
// The feed is one Tab stop (AGM.roving): the newest message until the focus has been in another, ↑ and ↓ between them,
// Home and End to the first and the newest, Tab into the one with the focus; a question pinned (drawn in the pinned strip
// alone) is passed over. The pinned strip, the People panel, the panel's files and the Screens dialog's list are one
// stop each too.
const feedRoving = AGM.roving(feed, { item: '.msg[data-key]', start: 'last', skip: '[data-type="action"][data-pinned="1"]' });
const tpl = document.getElementById('msgTpl');
const messagesById = new Map();
const allMessages = [];
function findMessage(id) { return allMessages.find((m) => m.id === id); }
function isMine(msg) { return !!(msg.from && (MY_UID ? msg.from.uid === MY_UID : msg.from.name === NAME)); }

function renderHistory(history) {
  feed.innerHTML = '';
  forgetPlace();
  messagesById.clear();
  allMessages.length = 0;
  for (const node of echoes.values()) feed.appendChild(node);
  for (const m of history) addMessage(m, { silent: true });
  refreshPinned();
  refreshDocPinnedList();
  HelpChip.draw();
  scrollToBottom();
  refreshOpenMenu();
}

/**
 * Draw a message. `silent`: drawn without opening its file on the panel (the history, what a page missed); `arrived`: it
 * reached the hall while this page was in it (heard live, or among what a page back from a drop missed), so it is
 * marked new and the feed follows it only if the reader was at the end (keepPlace, below).
 */
function addMessage(msg, { silent = false, arrived = false } = {}) {
  // One of this person's held sends, now the server's message: its echo goes, and the outbox lets go of it.
  if (msg && typeof msg.cid === 'string' && msg.from && MY_UID && msg.from.uid === MY_UID) AGM.outbox.landed(msg.cid);
  if (!msg || messagesById.has(msg.id)) {
    if (msg && messagesById.has(msg.id)) {
      const el = messagesById.get(msg.id);
      rerenderMessage(el, msg);
      const idx = allMessages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) allMessages[idx] = msg;
      if (msg.type === 'help') HelpChip.draw();
    }
    return;
  }
  // Comings and goings fold into one quiet line instead of burying the conversation. What this page holds for sending
  // stays below everything the hall has.
  const oldest = echoes.size ? echoes.values().next().value : null;
  const firstEcho = oldest && oldest.parentNode === feed ? oldest : null;
  const prev = firstEcho ? firstEcho.previousElementSibling : feed.lastElementChild;
  const follow = arrived && (catchUp ? catchUp.follow : readerAtEnd());   // where the reader is, read before anything moves
  if (msg.type === 'system' && PRESENCE.test(msg.text || '') && prev && prev.classList.contains('presence')) {
    const parts = (prev.dataset.parts ? prev.dataset.parts.split('\u0001') : [prev.textContent]).concat(msg.text).slice(-6);
    prev.dataset.parts = parts.join('\u0001');
    prev.textContent = parts.join(' · ');
    messagesById.set(msg.id, prev);
    allMessages.push(msg);
    if (follow) toEnd();
    return;
  }
  const el = renderMessage(msg);
  feed.insertBefore(el, firstEcho);
  messagesById.set(msg.id, el);
  allMessages.push(msg);
  if (msg.type === 'help' && isMine(msg)) HelpChip.draw();
  if (arrived) keepPlace(el, msg, follow);
  if (msg.pinned) refreshPinned();
  // A file another room sent or forwarded here never opens itself on the panel: someone in the room opens or pins it.
  if (!silent && msg.type === 'file' && HAS_STAGE && !msg.sentFrom && !msg.forwardedFrom) openDocInPanel(msg, { fromPush: true });
  if (msg.type === 'file') refreshDocPinnedList();
}

function removeMessageLocal(id) {
  const node = messagesById.get(id);
  if (node) node.remove();
  tidyDivider();
  messagesById.delete(id);
  const idx = allMessages.findIndex((m) => m.id === id);
  if (idx >= 0) allMessages.splice(idx, 1);
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === id) dismissDoc();
  HelpChip.draw();
  refreshOpenMenu();
}

// A presence line: "Ana joined Backstage", "Ben joined On stage", "Wes joined as an observer", "Ana left"; an older line in a
// hall's history ("Ana joined as research") is one too.
const PRESENCE = /^(.+) (joined (?:On stage|Backstage|as an observer|as \w+)|left)$/;
function renderMessage(msg) {
  if (msg.type === 'system') {
    const div = document.createElement('div');
    div.className = 'sys' + (PRESENCE.test(msg.text || '') ? ' presence' : '');
    div.textContent = msg.text;
    div.dataset.id = msg.id;
    if (msg.stage) renderStageLine(div, msg.stage);
    if (msg.proposal) renderProposalLine(div, msg.proposal);
    return div;
  }
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = msg.id;
  node.dataset.key = msg.id;   // its place in the roving list it is drawn in (the feed, the pinned strip)
  node.dataset.type = msg.type;
  rerenderMessage(node, msg);
  return node;
}

function rerenderMessage(node, msg) {
  node.dataset.pinned = msg.pinned ? '1' : '0';
  node.classList.toggle('pinned', !!msg.pinned);
  node.classList.toggle('is-action', msg.type === 'action');
  node.classList.toggle('is-help', msg.type === 'help');
  if (msg.type === 'help') node.dataset.help = (msg.help && msg.help.state) || 'open';
  node.classList.toggle('mine', isMine(msg));
  node.classList.toggle('priority', !!msg.priority);
  const rt = node.querySelector('.role-tag');
  const time = node.querySelector('time');
  const body = node.querySelector('.body');
  if (msg.from) {
    rt.textContent = roleLabel(msg.from.role);
    rt.dataset.role = msg.from.role;
  }
  time.textContent = formatTime(msg.at);
  node.querySelector('.pinned-mark').hidden = !msg.pinned;
  body.innerHTML = '';

  // Reply preview (small quote block at the top of the body): a click goes to the message it answers.
  if (msg.replyTo) {
    const rt = document.createElement('div');
    rt.className = 'reply-quote';
    // A quote of a message withdrawn from this room since keeps no word of it (the server took them out): it says so.
    rt.innerHTML = '↩ <strong>' + escapeHtml(msg.replyTo.name) + '</strong>: ' +
      '<em>' + escapeHtml(msg.replyTo.withdrawn ? '⊘ withdrawn' : (msg.replyTo.snippet || '').slice(0, 120)) + '</em>';
    rt.title = 'Click to scroll to original';
    rt.dataset.goto = msg.replyTo.id;
    body.appendChild(rt);
  }

  if (msg.type === 'text') {
    const p = document.createElement('p');
    p.innerHTML = renderMessageText(msg.text);
    body.appendChild(p);
  } else if (msg.type === 'file') {
    body.appendChild(renderFileBody(msg));
  } else if (msg.type === 'help') {
    body.appendChild(renderHelpBody(msg));
  } else if (msg.type === 'action') {
    body.appendChild(renderActionBody(msg));
  }
  if (msg.stage) renderStageLine(node, msg.stage);
  if (msg.proposal) renderProposalLine(node, msg.proposal);
  if (heldWords(msg)) {
    const held = document.createElement('div');
    held.className = 'held-line';
    held.textContent = heldWords(msg);
    body.appendChild(held);
  }

  // Reactions row, beneath the content.
  let rx = node.querySelector('.reactions');
  if (!rx) {
    rx = document.createElement('div');
    rx.className = 'reactions';
    node.appendChild(rx);
  }
  renderReactions(node, msg.reactions || []);

  // "↘ From Hall 2 › Legal" on a message another room sent here (with whose words they were, when the sender sent on
  // someone else's), and "↗ Sent to Hall 2 › Legal — delivered" on this room's copy of one it sent, or, taken back since,
  // "⊘ Withdrawn from Hall 2 › Legal after 40 s" (how long it was there, by the server's times): each room by its names
  // (a send carries no key and no code), drawn as words.
  if (msg.sentFrom || msg.sentTo) {
    const meta = document.createElement('div');
    meta.className = 'sent-meta';
    meta.textContent = msg.sentFrom
      ? '↘ From ' + AGM.catalog.placeOf(msg.sentFrom) + (msg.sentFrom.originalAuthor ? ' · originally by ' + msg.sentFrom.originalAuthor : '')
      : msg.sentTo.withdrawn ? '⊘ Withdrawn from ' + AGM.catalog.placeOf(msg.sentTo) + ' after ' + AGM.catalog.lasted(msg.sentTo.withdrawn - msg.at)
        : '↗ Sent to ' + AGM.catalog.placeOf(msg.sentTo) + ' — delivered';
    body.prepend(meta);
  }
  // "Forwarded from Hall 2 · originally by Sarah": the hall by its name (a forward never carries its code).
  if (msg.forwardedFrom) {
    const meta = document.createElement('div');
    meta.className = 'fwd-meta';
    const orig = msg.forwardedFrom.originalAuthor && msg.forwardedFrom.originalAuthor !== msg.from?.name
      ? ' · originally by ' + msg.forwardedFrom.originalAuthor
      : '';
    meta.textContent = '↗ Forwarded from ' + (msg.forwardedFrom.roomName || 'another hall') + orig;
    body.prepend(meta);
  }
  drawActs(node, msg);
  // A message in the pinned strip is drawn there from its record (no copy of this node), so it acts as it does here.
  if (msg.pinned && messagesById.get(msg.id) === node) refreshPinned(msg.id);
  if (openOn && openOn.kind === 'msg' && openOn.id === msg.id) refreshOpenMenu();
}

// ---------------- The doors of an object: its bar, its ⋯, right-click, Shift+F10 and its keys (catalog.js, menus.js) ----------------
// An object's bar holds the two acts of lowest inline rank the catalogue shows it, then its ⋯; right-click, ⋯ and
// Shift+F10 (or the menu key) open its whole list; a single key on the focused object runs the act that carries it. Each
// door reads the same entries with the same facts, so they are in step, and every act runs through act() below.
const drawnActs = new WeakMap();   // an object's bar → what it was drawn from, so an unchanged bar is not drawn again
/** One act of a bar, drawn into its button: its icon (and, with `words`, its label beside it), named by its catalogue label. */
function drawActButton(b, item, words) {
  b.dataset.action = item.id;
  b.setAttribute('aria-label', item.label);
  b.title = item.disabled || item.label;
  if (item.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
  b.textContent = '';
  if (item.icon) { const i = document.createElement('span'); i.setAttribute('aria-hidden', 'true'); i.textContent = item.icon; b.appendChild(i); }
  if (words || !item.icon) { const w = document.createElement('span'); w.className = 'act-words'; w.textContent = item.label; b.appendChild(w); }
}
function actButton(item, words) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-act';
  drawActButton(b, item, words);
  return b;
}
/** The ⋯ of an object: the door to its whole list on every device, a touch screen's included. */
function moreButton(name) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'obj-more';
  b.dataset.more = '1';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.setAttribute('aria-label', name);
  b.title = name + ' (or right-click, or Shift+F10)';
  b.textContent = '⋯';
  return b;
}
/**
 * Draw an object's bar into `bar`: its inline acts and its ⋯ (none when it has no menu), and its keys named. A button
 * that still offers the same act is drawn again in place (a reason or a label changed), and the ⋯ is kept while there
 * is a menu, so a change of the page's facts never takes the focus, or an open menu's opener, away.
 */
function drawBar(bar, kind, o, { words = false, more = 'More actions', keysOn = null } = {}) {
  const inl = AGM.catalog.inline(kind, F, o);
  const shown = AGM.catalog.shown(kind, F, o);
  const menu = AGM.catalog.items(kind, F, o).length > 0;
  const key = JSON.stringify([inl.map((i) => [i.id, i.label, i.icon, i.disabled]), menu, words]);
  if (drawnActs.get(bar) === key) return;
  drawnActs.set(bar, key);
  const had = [...bar.querySelectorAll(':scope > .msg-act')];
  const dots = bar.querySelector(':scope > .obj-more');
  if (had.length === inl.length && had.every((b, n) => b.dataset.action === inl[n].id)) inl.forEach((i, n) => drawActButton(had[n], i, words));
  else {
    had.forEach((b) => b.remove());
    for (const i of inl) bar.insertBefore(actButton(i, words), dots);
  }
  if (menu && !dots) bar.appendChild(moreButton(more));
  else if (!menu && dots) dots.remove();
  else if (dots) { dots.setAttribute('aria-label', more); dots.title = more + ' (or right-click, or Shift+F10)'; }
  if (keysOn) {
    const keys = shown.filter((e) => e.key).map((e) => e.key);
    if (keys.length) keysOn.setAttribute('aria-keyshortcuts', keys.join(' ')); else keysOn.removeAttribute('aria-keyshortcuts');
  }
}
function drawActs(node, msg) {
  senderName(node, msg);
  const bar = node.querySelector(':scope > header .msg-acts');
  if (bar) drawBar(bar, 'msg', msg, { keysOn: node });
  // The body's own doors (a prompt's answers, a help request's answers) are the same entries, and say why when they
  // cannot run now.
  const shown = new Set(AGM.catalog.shown('msg', F, msg).map((e) => e.id));
  for (const b of node.querySelectorAll('.body button[data-action]')) {
    const id = b.dataset.action;
    const why = shown.has(id) ? AGM.catalog.ready('msg', id, F, msg) : AGM.catalog.WORDS.gone;
    if (why === true) { b.removeAttribute('aria-disabled'); b.removeAttribute('title'); } else { b.setAttribute('aria-disabled', 'true'); b.title = why; }
  }
}

/**
 * Run an act of the catalogue on an object: shown to this seat and ready now, or the words that say why not and nothing
 * sent; an act that asks first asks in place (AGM.ask), and runs on its yes. `ctx`: `anchor` (where an ask or a
 * submenu opens), `node` (the object's element), `opener` (where the focus goes back when an ask closes: the object a
 * key was pressed on, or the menu's opener), `value` (a submenu's choice), `item` (the menu item chosen).
 */
function act(kind, id, o, ctx) {
  const c = ctx || {};
  const e = AGM.catalog.entry(kind, id);
  const run = RUN[id];
  if (!e || !run || !AGM.catalog.shown(kind, F, o).some((x) => x.id === id)) { AGM.toast(AGM.catalog.WORDS.gone, true); return; }
  const r = AGM.catalog.ready(kind, id, F, o);
  if (r !== true) { AGM.toast(r, true); return; }
  // An act asks first where its row says so for this object (Turn the code off… asks, Turn the code on does not).
  const spec = e.confirm ? e.confirm(F, o) : null;
  if (spec) {
    // The ask is about this object: should it go meanwhile, the ask goes with it (refreshOpenMenu).
    const asked = { kind, get: () => objectNow(kind, o) };
    askOn = asked;
    AGM.ask(c.anchor || c.node || null, spec, { opener: c.opener || null, refocus: () => refocusNear(kind, o) }).then((a) => {
      if (askOn === asked) askOn = null;
      if (a.yes) run(o, Object.assign({}, c, { values: a.values, choice: a.choice }));
    });
    return;
  }
  run(o, c);
}
/** An object as it is now (null: it is gone): a message's record, a file's (where it was), a screen's row. */
function objectNow(kind, o) {
  if (kind === 'msg') return findMessage(o.id) || null;
  if (kind === 'file') return fileObject(o.id, o.where);
  if (kind === 'screen') return Screens.of(o.id);
  if (kind === 'person') return personNow(o.uid);
  if (kind === 'compose') return composeObject(o.form);
  if (kind === 'chip') return stageNow;
  if (kind === 'room') return switcherObject(o.key);
  return codeObject();
}
/**
 * The focus, when what held it is gone (its row drawn again, its message removed): the object's element as it is drawn
 * now, else where it was listed (the Screens dialog, the panel), else the composer; never the page itself.
 */
function refocusNear(kind, o) {
  const id = o && o.id;
  const same = (sel, key) => [...document.querySelectorAll(sel)].find((n) => n.dataset[key] === id) || null;
  const node = kind === 'msg' ? messagesById.get(id) : kind === 'screen' ? same('.screen-item', 'screenId') : same('#docPinnedList .file-entry', 'fileId');
  if (node && node.isConnected && node.hasAttribute('tabindex') && node.offsetParent) { node.focus(); return; }
  const near = kind === 'screen' ? document.getElementById('screensClose') : kind === 'file' ? document.querySelector('#docActs button') : null;
  if (near && near.offsetParent) { near.focus(); return; }
  const c = composerField();
  if (c) c.focus(); else if (!feedRoving.focus('current')) feed.focus();
}

// The open menu, if any: its kind and object, so a change to the object updates it in place (R5); and the object an
// open ask is about.
let openOn = null;
let askOn = null;
/**
 * Open the menu of an object at `at` ({x, y}, or {anchor}). `get()` reads the object as it is now (null: it is gone),
 * `node` is its element and `more` its ⋯. False when the object offers nothing here (the browser's menu then stays).
 */
function openObjectMenu(kind, get, { node, more, at, opener, label, header }) {
  const o = get();
  if (!o) return false;
  const list = AGM.catalog.items(kind, F, o);
  if (!list.length) return false;
  const anchor = more || node;
  const from = opener || anchor;
  const handle = AGM.menu(list, at || { anchor }, {
    label, header: header(o), opener: from,
    goneWords: AGM.catalog.WORDS.gone,
    onPick: (id, value, item) => { const now = get(); if (now) act(kind, id, now, { anchor, node, value, item, opener: from }); else AGM.toast(goneWords(kind), true); },
    onDisabled: (words) => AGM.toast(words, true),
    submenu: (item) => submenuFor(kind, item, get() || o),
    // An open submenu's values as they are now (a reaction's check, an answer chosen); the rooms are asked once.
    values: (item) => (item.id ? AGM.catalog.submenu(kind, item.id, F, get() || o) : null),
    refocus: () => refocusNear(kind, o),
    onClose: () => { if (openOn && openOn.handle === handle) openOn = null; },
  });
  openOn = { kind, get, header, handle, node: node || null };
  openOn.id = o.id;
  return true;
}
const GONE = { msg: 'That message is gone.', file: 'That file is gone.', screen: 'That screen is gone.', room: 'That room is gone.' };
const goneWords = (kind) => GONE[kind] || AGM.catalog.WORDS.gone;
/** The open menu says what its object's items say now; its object gone, it closes and says so, and so does an ask. */
function refreshOpenMenu() {
  if (askOn && !askOn.get()) { const k = askOn.kind; askOn = null; AGM.ask.close(); AGM.toast(goneWords(k), true); }
  if (!openOn) return;
  const o = openOn.get();
  if (!o) { const k = openOn.kind; openOn.handle.close(); openOn = null; AGM.ask.close(); AGM.toast(goneWords(k), true); return; }
  openOn.handle.update(AGM.catalog.items(openOn.kind, F, o), openOn.header(o));
}
/** One level down: a catalogue entry's values (reactions, answers), or the rooms a message could be sent to, asked now. */
function submenuFor(kind, item, o) {
  const fixed = AGM.catalog.submenu(kind, item.id, F, o);
  if (fixed) return fixed;
  if (item.id === 'msg.send') return sendTargets(o);
  return [];
}
/**
 * The rooms this message would be taken in, as the server answers, one list: first each room whose list lets this room
 * send into it (room:sendTargets: sent there by room:send, a copy kept here; not a question, which only a forward
 * carries), then each other room this person may forward into (myRooms: by forward, its second line saying so), a room
 * that is both listed once, as the first. Each a value; none, the words why.
 */
function sendTargets(o) {
  const why = (words) => [{ id: '', label: words, disabled: words }];
  if (!AGM.outbox.online) return why(AGM.catalog.WORDS.offline);
  const answer = (resolve) => (res) => resolve(res && res.ok ? res : { error: (res && res.error) || '' });
  const asked = [
    o.type === 'action' || !F.sends ? { targets: [] } : new Promise((resolve) => { socket.emit('room:sendTargets', {}, answer(resolve)); }),
    new Promise((resolve) => { socket.emit('myRooms', { messageId: o.id }, answer(resolve)); }),
  ];
  return Promise.all(asked).then(([into, fwd]) => {
    const sends = Array.isArray(into.targets) ? into.targets.filter((t) => t && typeof t.ref === 'string' && t.ref) : [];
    const refs = new Set(sends.map((t) => t.ref));
    const rooms = Array.isArray(fwd.rooms) ? fwd.rooms.filter((r) => r && typeof r.code === 'string' && !refs.has(r.ref)) : [];
    const list = sends.map((t) => ({ value: t.ref, label: AGM.catalog.placeOf(t), via: 'room:send' }))
      .concat(rooms.map((r) => ({ value: r.code, label: r.name ? r.name + ' · ' + r.code : r.code, via: 'forward', note: 'a forward — no withdraw' })));
    if (list.length) return list;
    if (into.error || fwd.error) return why(into.error || fwd.error || 'Could not check your other rooms.');
    // A rule of this room emptied the list: its words, not a room to open (the person may have it open already).
    return why(typeof fwd.why === 'string' && fwd.why ? fwd.why
      : 'To send it to another hall, open that hall where you may ' + (o.type === 'file' ? 'share files' : 'post') + ' (in another tab, as ' + NAME + ').');
  });
}

// ---------------- A person: a row of the People panel, and a message's sender (kind `person`, the hall page's half) ----------------
/** A person as the catalogue sees them: who they are in this room. */
const personOf = (p) => (p && typeof p.uid === 'string' && p.uid ? { id: 'person:' + p.uid, uid: p.uid, name: String(p.name || ''), role: p.role || '' } : null);
const personHeader = (p) => p.name + ' · ' + roleLabel(p.role);
/**
 * A message's sender's name: a button that opens the person's menu where this seat has acts on them (@ Mention), else
 * the name as words. The same element is kept while it stays what it is, so a redraw never takes the focus from it.
 * Staff sign in and guests join with a code: its mark says which, so a name alone is never taken on trust.
 */
function senderName(node, msg) {
  let el = node.querySelector(':scope > header .from');
  if (!msg.from) return;
  const p = personOf(msg.from);
  const door = !!p && AGM.catalog.items('person', F, p).length > 0;
  if (door !== (el.tagName === 'BUTTON')) {
    const was = el;
    el = document.createElement(door ? 'button' : 'span');
    el.className = was.className;
    if (door) { el.type = 'button'; el.setAttribute('aria-haspopup', 'menu'); el.setAttribute('aria-expanded', 'false'); }
    was.replaceWith(el);
  }
  if (door) el.dataset.person = p.uid; else delete el.dataset.person;
  if (el.textContent !== msg.from.name) el.textContent = msg.from.name;
  el.classList.toggle('acct', !!msg.from.acct);
  el.title = (msg.from.acct ? 'Signed in with an AGMessage account' : 'Joined with a code') + (door ? ' — choose it for what you can do with ' + msg.from.name : '');
}
/** The person whose name `el` is, as they are now (null: the message is gone). */
function senderOf(el) {
  const node = el.closest('.msg[data-id]');
  const m = node && findMessage(node.dataset.id);
  return m && m.from ? personOf(m.from) : null;
}
function senderDoor(el) {
  const node = el.closest('.msg[data-id]');
  const id = node ? node.dataset.id : '';
  const get = () => { const m = findMessage(id); return m && m.from ? personOf(m.from) : null; };
  return { el, more: el, open: (at) => openObjectMenu('person', get, { node: el, more: el, at, opener: el, label: 'Person actions', header: personHeader }) };
}

// A message's doors: one handler for the feed and the pinned strip, which draws each pinned message afresh. A sender's
// name is the door to that person's menu.
const msgHeader = (m) => (isMine(m) ? 'Your message' : 'Message from ' + ((m.from && m.from.name) || 'someone')) + ' · ' + formatTime(m.at);
function msgDoor(node) {
  const id = node.dataset.id;
  const more = node.querySelector(':scope > header .obj-more');
  return {
    el: node, more,
    open: (at) => openObjectMenu('msg', () => findMessage(id), { node, more, at, opener: node.contains(document.activeElement) ? document.activeElement : node, label: 'Message actions', header: msgHeader }),
  };
}
function findMsgDoor(t) {
  const name = t.closest('.from[data-person]');
  if (name && senderOf(name)) return senderDoor(name);
  const node = t.closest('.msg[data-id]');
  return node && !node.classList.contains('echo') ? msgDoor(node) : null;
}
function onMsgClick(e) {
  const el = e.target.closest('[data-action], [data-more], [data-goto], [data-person]');
  if (!el || !this.contains(el)) return;
  const node = el.closest('.msg[data-id]');
  const msg = node && findMessage(node.dataset.id);
  if (!msg) return;
  if (el.dataset.person) {
    e.preventDefault();
    if (openOn && openOn.kind === 'person' && openOn.node === el) { AGM.menu.close(); return; }
    senderDoor(el).open({ anchor: el });
    return;
  }
  if (el.dataset.goto) {
    const target = messagesById.get(el.dataset.goto);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('found');
      setTimeout(() => target.classList.remove('found'), 1500);
    }
    return;
  }
  e.preventDefault();
  if (el.dataset.more) {
    if (openOn && openOn.kind === 'msg' && openOn.id === msg.id) { AGM.menu.close(); return; }
    openObjectMenu('msg', () => findMessage(msg.id), { node, more: el, opener: el, label: 'Message actions', header: msgHeader });
    return;
  }
  const more = node.querySelector(':scope > header .obj-more');
  const entry = AGM.catalog.entry('msg', el.dataset.action);
  // An act with values one level down, chosen on its own door (not a value): its submenu opens in the object's menu.
  if (entry && entry.submenu && el.dataset.value === undefined) { openSubmenu(node, more, entry.id); return; }
  act('msg', el.dataset.action, msg, { anchor: more || el, node, value: el.dataset.value, opener: el });
}
/** The object's menu, opened at its ⋯ with one of its submenus open (E reacts, F sends to). */
function openSubmenu(node, more, id) {
  const door = msgDoor(node);
  if (door.open({ anchor: more || node }) && AGM.menu.current()) AGM.menu.current().expand(id);
}
/** A single key on the focused message runs the act that carries it: R E F P D, Enter, and Delete or Backspace. */
function onMsgKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
  const node = e.target;
  if (!node || !node.matches || !node.matches('.msg[data-id]')) return;
  // Escape on a message (no menu or ask open: theirs end first, as they hear it first) goes back to the composer.
  if (e.key === 'Escape') { const field = composerField(); if (field) { e.preventDefault(); field.focus(); } return; }
  const msg = findMessage(node.dataset.id);
  const entry = msg && AGM.catalog.byKey('msg', F, msg, e.key);
  if (!entry) return;
  e.preventDefault();
  const more = node.querySelector(':scope > header .obj-more');
  if (entry.submenu) { openSubmenu(node, more, entry.id); return; }
  act('msg', entry.id, msg, { anchor: more || node, node, opener: node });
}
for (const host of [document.getElementById('feed'), document.getElementById('pinnedList')]) {
  host.addEventListener('click', onMsgClick);
  host.addEventListener('keydown', onMsgKey);
  AGM.menu.door(host, findMsgDoor);
}
AGM.roving(document.getElementById('pinnedList'), { item: '.msg[data-key]' });

// What each act on a message does. The server decides; every write goes through the outbox in its entry's mode.
const isFileUrl = (u) => typeof u === 'string' && /^\/uploads\/[\w.-]+$/.test(u);
/** A file of this hall saved by the browser, under its own name. */
function download(m) {
  if (!isFileUrl(m.url)) return;
  const a = document.createElement('a');
  a.href = m.url;
  a.download = m.filename || '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
/** Words to the clipboard (AGM.copy: over plain http too), said in the toast; the focus goes back where it was. */
const copyText = (text, said, anchor) => AGM.copy(text, { said, anchor, say: (w) => AGM.toast(w) });
/** Pin or unpin, with Undo for 10 s: the opposite op of the same kind. */
function pinWithUndo(o) {
  const pinned = !o.pinned;
  AGM.outbox.now('pin', { messageId: o.id, pinned }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || (pinned ? 'Not pinned.' : 'Not unpinned.'), true); return; }
    AGM.toast(pinned ? 'Pinned.' : 'Unpinned.', { undo: () => AGM.outbox.now('pin', { messageId: o.id, pinned: !pinned }, saidIfNot(pinned ? 'Not unpinned.' : 'Not pinned.')) });
  });
}
/** The object after `node` in its list (or before it, at the end): where the focus goes when `node` is removed. */
function neighbour(node) {
  const sel = '.msg[data-id]';
  let n = node.nextElementSibling;
  while (n && !n.matches(sel)) n = n.nextElementSibling;
  if (n) return n;
  n = node.previousElementSibling;
  while (n && !n.matches(sel)) n = n.previousElementSibling;
  return n;
}
Object.assign(RUN, {
  // Got it answers the backstage team with this person's 👍, held through a blip; Got all N answers each plain message
  // that waits, one send each.
  'msg.ack': (m) => {
    for (const id of m.priority ? [m.id] : F.waiting.plain) AGM.outbox.hold('react', { messageId: id, emoji: '👍', on: true });
  },
  'msg.reply': (m) => beginReply(m),
  'msg.react': (m, { value }) => {
    const on = !(m.reactions || []).some((r) => r.uid === MY_UID && r.emoji === value);
    AGM.outbox.now('react', { messageId: m.id, emoji: String(value), on }, saidIfNot('Not changed.'));
  },
  'msg.answer': (m, { value }) => answerPrompt(m.id, Number(value)),
  'msg.answerWords': (m, { values }) => { const note = values && values.note ? values.note.trim() : ''; if (note) answerPrompt(m.id, -1, note); },
  'msg.helpRespond': (m) => AGM.outbox.hold('help:respond', { code: ROOM, messageId: m.id, state: 'coming' }),
  'msg.helpResolve': (m) => AGM.outbox.hold('help:respond', { code: ROOM, messageId: m.id, state: 'resolved' }),
  'msg.draft': (m) => { beginReply(m); draftAnswer(m); },
  'msg.speaker': (m) => ToStagewatch.open(m),
  'msg.sendNow': (m) => AGM.outbox.now('stage:send', { messageId: m.id }, (res) => {
    AGM.toast(res && res.ok
      ? (res.stage === 'applied' ? 'On the speaker\'s screen — their acknowledgement shows on the message.' : 'Stagewatch took it — the speaker\'s acknowledgement shows on the message.')
      : (res && res.error) || 'Could not send to the speaker\'s screen.', !(res && res.ok));
  }),
  'msg.screens': (m) => Screens.offer(m),
  // A room its list lets this room send into: room:send, a copy kept here; any other: a forward.
  'msg.send': (m, { value, item }) => {
    if (typeof value !== 'string' || !value) return;
    const label = item && item.label ? item.label : value;
    if (item && item.via === 'room:send') AGM.outbox.hold('room:send', { to: value, messageId: m.id }, { tag: { sendTo: label } });
    else AGM.outbox.hold('forward', { messageId: m.id, targetRoom: value }, { tag: { forward: label } });
  },
  // The composer, set to the room the message came from for one send, answers under it there and here.
  'msg.sendBack': (m) => {
    selectTab('text');
    setSendTo(m.sentFrom.ref);
    beginReply(m);
  },
  'msg.pin': (m) => pinWithUndo(m),
  'msg.look': (m) => openDocInPanel(m),
  'msg.download': (m) => download(m),
  'msg.copy': (m, { anchor }) => copyText(m.text || '', 'Copied.', anchor),
  // Taken back from the room it went to: this copy stays, and its line says so once the server has done it (sentUpdate).
  'msg.withdraw': (m) => AGM.outbox.now('room:withdraw', { messageId: m.id }, (r) => {
    AGM.toast(r && r.ok ? 'Withdrawn from ' + AGM.catalog.placeOf(m.sentTo) + '.' : (r && r.error) || 'Could not withdraw it.', !(r && r.ok));
  }),
  'msg.delete': (m, { node }) => {
    const next = node ? neighbour(messagesById.get(m.id) || node) : null;
    AGM.outbox.now('delete', { messageId: m.id }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Could not delete', true); return; }
      // The focus goes to the next message, never to the page.
      if (next && next.isConnected && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) next.focus();
    });
  },
});

// ---------------- What this page holds for sending: the outbox's echoes ----------------
// A message held by the outbox is drawn below the hall's messages, saying what is true of it: ◷ Sending, ◷ Waiting while
// the connection is down, △ Not sent with the server's words (Retry, Edit). The composer that wrote it keeps its words,
// held, until the server has it, and empties only then. An answer held is its option marked ◷.
const echoes = new Map();        // cid -> the echo of a held message, in the feed
const heldAnswers = new Map();   // 'answer|<id>' or 'help|<id>' -> {cid, option}: what this person's held answer chose
const composerCids = {};         // a composer -> the cid of the message it wrote and holds until the server takes it
const COMPOSER_FORMS = { director: () => dForm, text: () => textPane, action: () => actionPane, file: () => filePane };
const SENDING = new Set(['waiting', 'sending']);

/** "written 14:02 · sent 14:06 (offline)" for a message its page held before sending it, else ''. */
function heldWords(msg) {
  if (!Number.isInteger(msg.held) || msg.held <= 0) return '';
  return 'written ' + formatTime(msg.at - msg.held * 1000) + ' · sent ' + formatTime(msg.at) + ' (offline)';
}

function drawHeld(item) {
  if (item.verb === 'message') drawEcho(item);
  else if (item.verb === 'actionResponse' || item.verb === 'help:respond') drawHeldAnswer(item);
  else if (item.verb === 'forward') drawHeldForward(item);
  else if (item.verb === 'room:send') { if (item.tag && item.tag.composer) drawEcho(item); else drawHeldSend(item); }
  else if (item.verb === 'react' && item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
}

/** What a held message says, in one line: one sent into another room says where first. */
function echoText(a, item) {
  const into = item && item.verb === 'room:send' && item.tag && item.tag.to ? '↗ to ' + item.tag.to + ': ' : '';
  return into + echoWords(a);
}
function echoWords(a) {
  if (a.type === 'help') return 'Help — ' + (a.category || 'Other') + (a.text ? ': ' + a.text : '');
  if (a.type === 'action') return '❓ ' + (a.text || '');
  if (a.type === 'file') return '📄 ' + (a.filename || 'a file') + (a.caption ? ' — ' + a.caption : '');
  return a.text || '';
}
function echoState(item) {
  if (item.state === 'refused') return '△ Not sent: ' + item.words;
  if (item.state === 'lost') return '△ ' + item.words;
  return !AGM.outbox.online ? '◷ Waiting — it goes when the connection is back' : '◷ Sending';
}

function drawEcho(item) {
  let node = echoes.get(item.cid);
  if (!SENDING.has(item.state) && item.state !== 'refused' && item.state !== 'lost') {
    if (node) node.remove();
    echoes.delete(item.cid);
    if (item.state === 'gone') AGM.toast('That message was removed.');
    if (item.state === 'done' && item.args.type === 'help') AGM.toast('Help request sent — it stays up until someone marks it resolved.');
  } else {
    if (!node) {
      node = document.createElement('article');
      node.className = 'msg mine echo';
      node.dataset.cid = item.cid;
      node.dataset.type = item.args.type || 'text';
      const head = document.createElement('header');
      const from = document.createElement('span');
      from.className = 'from';
      from.textContent = NAME || 'You';
      const st = document.createElement('span');
      st.className = 'echo-state';
      st.setAttribute('role', 'status');
      head.append(from, st);
      const body = document.createElement('div');
      body.className = 'body';
      const p = document.createElement('p');
      p.className = 'echo-text';
      body.appendChild(p);
      const acts = document.createElement('div');
      acts.className = 'echo-acts';
      node.append(head, body, acts);
      echoes.set(item.cid, node);
      feed.appendChild(node);
      scrollToBottom();
    }
    node.dataset.state = item.state;
    node.querySelector('.echo-text').textContent = echoText(item.args, item);
    node.querySelector('.echo-state').textContent = echoState(item);
    const acts = node.querySelector('.echo-acts');
    acts.textContent = '';
    const act = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = label; b.onclick = fn; acts.appendChild(b); };
    if (item.state === 'refused') { act('Retry', () => AGM.outbox.retry(item.cid)); act('Edit', () => editHeld(item)); }
    if (item.state === 'lost') { act('Choose again', () => editHeld(item)); act('Remove', () => AGM.outbox.drop(item.cid)); }
  }
  composerFollows(item);
}

/** The composer that wrote a held message: held while it is sent, emptied once the server has it, free again otherwise. */
function composerFollows(item) {
  const c = item.tag && item.tag.composer;
  if (!c || !COMPOSER_FORMS[c] || item.restored) return;
  if (SENDING.has(item.state)) { composerCids[c] = item.cid; lockComposer(c, true); return; }
  if (composerCids[c] !== item.cid) return;
  if (item.state === 'done' || item.state === 'gone') clearComposer(c, item);
  if (item.state !== 'refused') delete composerCids[c];
  lockComposer(c, false);
}
function composerHeld(c) {
  const cid = composerCids[c];
  const it = cid ? AGM.outbox.items().find((i) => i.cid === cid) : null;
  return !!it && SENDING.has(it.state);
}
/**
 * Hold what a composer says: a refused message it still holds is replaced by what it says now. Its message or file goes
 * to the room To: is set to (room:send, a copy kept here) or to this room, and To: goes back to this room after the send.
 */
function holdMessage(c, args, opts) {
  if (composerCids[c]) AGM.outbox.drop(composerCids[c]);
  const t = (c === 'text' || c === 'file') ? targetNow() : null;
  if (t) {
    AGM.outbox.hold('room:send', { ...args, to: t.ref }, { ...(opts || {}), tag: { composer: c, to: t.name || t.hallName || 'another room', toRef: t.ref } });
    setSendTo('');
    return;
  }
  AGM.outbox.hold('message', args, { ...(opts || {}), tag: { composer: c } });
}
function lockComposer(c, on) {
  const form = COMPOSER_FORMS[c]();
  if (!form) return;
  form.dataset.held = on ? '1' : '';
  form.setAttribute('aria-busy', on ? 'true' : 'false');
  for (const f of form.querySelectorAll('input, textarea')) f.readOnly = on;
  for (const b of form.querySelectorAll('button')) b.disabled = on;
  if (!on) drawCompose(c);
}
function clearComposer(c, item) {
  const a = item.args;
  if (c === 'director' && dInput.value.trim() === a.text) dInput.value = '';
  if (c === 'text' && textInput.value.trim() === a.text) { textInput.value = ''; aiDrafted = false; setAiHint(''); }
  if (c === 'action' && actionText.value.trim() === a.text) { actionText.value = ''; currentOptions = ['Yes', 'No']; renderOptionChips(); }
  if (c === 'file' && pendingFile && pendingFile.file === item.file) {
    fileCaption.value = '';
    removePendingFile();
  }
}
/**
 * Edit (or Choose again): the held message is let go and its words are in its composer to change and send, with what
 * it carried beside them (its 🔥, the message it replied to), which the send took from the composer.
 */
function editHeld(item) {
  const a = item.args;
  const c = item.tag && item.tag.composer;
  const kept = c && composerCids[c] === item.cid;
  AGM.outbox.drop(item.cid);
  // One that was going into another room goes there again, while this room may still send there.
  if (item.verb === 'room:send' && item.tag && typeof item.tag.toRef === 'string') setSendTo(item.tag.toRef);
  if (c) setPriority({ director: dirPriBtn, text: textPriBtn, action: actionPriBtn, file: filePriBtn }[c], !!a.priority);
  if (typeof a.replyTo === 'string' && a.replyTo) {
    const parent = findMessage(a.replyTo);
    replyState = { id: a.replyTo, name: parent ? (parent.from && parent.from.name) || 'system' : 'an earlier message', snippet: parent ? parent.text || parent.filename || '' : '' };
    renderReplyChip();
  }
  const tab = selectTab;
  // A help request: its words back in the dialog, where a category's tap sends it again (none is chosen for the person).
  if (a.type === 'help') { openHelpDialog(a.text || ''); return; }
  if (a.type === 'action') { tab('action'); if (!kept) { actionText.value = a.text || ''; currentOptions = Array.isArray(a.options) ? a.options.slice(0, 6) : ['Yes', 'No']; renderOptionChips(); } actionText.focus(); return; }
  if (a.type === 'file') { tab('file'); if (!kept) fileCaption.value = a.caption || ''; AGM.toast('Choose the file again to send it.'); return; }
  const field = c === 'director' || document.getElementById('researchCompose').hidden ? dInput : textInput;
  if (c !== 'director') tab('text');
  if (field && !kept) field.value = a.text || '';
  if (field) field.focus();
}

function drawHeldAnswer(item) {
  const a = item.args;
  const key = (item.verb === 'actionResponse' ? 'answer|' : 'help|') + a.messageId;
  const mine = heldAnswers.get(key);
  if (SENDING.has(item.state)) heldAnswers.set(key, { cid: item.cid, option: item.verb === 'actionResponse' ? a.optionIndex : a.state });
  else if (mine && mine.cid === item.cid) heldAnswers.delete(key);
  if (item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
  const m = findMessage(a.messageId);
  const node = messagesById.get(a.messageId);
  if (m && node) rerenderMessage(node, m);
  if (m && m.pinned) refreshPinned(m.id);
}

/** A message of this room sent into another (Send to ▸): held while the page is down, then said, or its refusal. */
function drawHeldSend(item) {
  const to = (item.tag && item.tag.sendTo) || 'the other room';
  if (item.state === 'waiting' && item.attempt === 0 && !AGM.outbox.online) AGM.toast('◷ Held — it is sent to ' + to + ' when the connection is back.');
  else if (item.state === 'done') AGM.toast('Sent to ' + to + ' — a copy stays here.');
  else if (item.state === 'gone') AGM.toast('Sent to ' + to + '.');
  else if (item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
}
function drawHeldForward(item) {
  const to = (item.tag && item.tag.forward) || 'the other hall';
  if (item.state === 'waiting' && item.attempt === 0 && !AGM.outbox.online) AGM.toast('◷ Held — it is forwarded to ' + to + ' when the connection is back.');
  else if (item.state === 'done' || item.state === 'gone') AGM.toast('Forwarded to ' + to);
  else if (item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
}

/** An answer to a prompt, held until the server has it: the option chosen, or -1 and a note in words. */
function answerPrompt(messageId, optionIndex, note) {
  AGM.outbox.hold('actionResponse', note === undefined ? { messageId, optionIndex } : { messageId, optionIndex, note });
}

// ---------------- Help requests: the category and the words; who is on the way, then who resolved it ----------------
const HELP_WORDS = { open: 'Waiting for someone', coming: 'On the way', resolved: 'Resolved' };
function renderHelpBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'help-body';
  const head = document.createElement('p');
  head.className = 'help-head';
  const cat = document.createElement('strong');
  cat.textContent = 'Help — ' + (msg.category || 'Other');
  head.appendChild(cat);
  if (msg.text) head.appendChild(document.createTextNode(' ' + msg.text));
  wrap.appendChild(head);
  const h = msg.help || { state: 'open' };
  const line = document.createElement('div');
  line.className = 'help-line';
  line.dataset.state = h.state;
  line.textContent = (h.state === 'resolved' ? '✓ ' : h.state === 'coming' ? '▶ ' : '■ ') + HELP_WORDS[h.state] + (h.by ? ' — ' + h.by : '') + (h.at && h.state !== 'open' ? ' at ' + formatTime(h.at) : '');
  wrap.appendChild(line);
  // Its answers are the catalogue's (On my way, Resolved): the backstage team answers anyone's, and a seat On stage
  // marks only its own request resolved, as the server refuses otherwise (owner answer B1).
  const answers = AGM.catalog.shown('msg', F, msg).filter((e) => e.id === 'msg.helpRespond' || e.id === 'msg.helpResolve');
  if (answers.length) {
    const row = document.createElement('div');
    row.className = 'help-actions';
    const held = heldAnswers.get('help|' + msg.id);
    for (const e of answers) {
      const state = e.id === 'msg.helpRespond' ? 'coming' : 'resolved';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small' + (state === 'coming' ? ' primary' : ''); b.dataset.action = e.id;
      b.textContent = (held && held.option === state ? '◷ ' : '') + e.label;
      if (held && held.option === state) b.dataset.state = 'sending';
      row.appendChild(b);
    }
    wrap.appendChild(row);
  }
  return wrap;
}
/** This room's copy of a send, its mark changed (withdrawn from where it went, and when): its line and its acts drawn again. */
function setSentTo(messageId, sentTo) {
  const msg = findMessage(messageId);
  if (!msg || !sentTo || typeof sentTo !== 'object') return;
  msg.sentTo = sentTo;
  const node = messagesById.get(messageId);
  if (node && node.classList.contains('msg')) rerenderMessage(node, msg);
}
/** A reply whose quote changed (the message it answered withdrawn from this room): the reply drawn again from its record. */
function setReplyTo(messageId, replyTo) {
  const msg = findMessage(messageId);
  if (!msg || !replyTo || typeof replyTo !== 'object') return;
  msg.replyTo = replyTo;
  const node = messagesById.get(messageId);
  if (node && node.classList.contains('msg')) rerenderMessage(node, msg);
}
function setHelp(messageId, help) {
  const msg = findMessage(messageId);
  const was = msg && msg.help ? msg.help.state : 'open';
  if (msg) msg.help = help;
  const node = messagesById.get(messageId);
  if (node && msg) rerenderMessage(node, msg);
  if (msg) HelpChip.changed(msg, was);
}

function renderFileBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'file';
  const isImage = msg.mime && msg.mime.startsWith('image/');
  if (isImage) {
    const img = document.createElement('img');
    img.src = msg.url;
    img.alt = msg.filename;
    img.loading = 'lazy';
    wrap.appendChild(img);
  } else {
    const card = document.createElement('div');
    card.className = 'file-link';
    card.textContent = `📄 ${msg.filename}`;
    wrap.appendChild(card);
  }
  if (msg.caption) {
    const c = document.createElement('p');
    c.className = 'caption';
    c.textContent = msg.caption;
    wrap.appendChild(c);
  }
  // A tap on the file is its Look (the catalogue's msg.look), where this seat has one.
  if (AGM.catalog.shown('msg', F, msg).some((e) => e.id === 'msg.look')) {
    wrap.classList.add('clickable');
    wrap.title = 'Look: open it in the panel';
    wrap.dataset.action = 'msg.look';
  }
  return wrap;
}

function renderActionBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'action';
  const q = document.createElement('p');
  q.className = 'action-text';
  q.textContent = msg.text;
  wrap.appendChild(q);
  // Its answers are the catalogue's msg.answer, each with its value; Answer in words… is msg.answerWords. A seat that may
  // never answer (an observer, a Viewer) reads the options as words, with the live tally: nothing drawn as a button that
  // does nothing.
  const shown = new Set(AGM.catalog.shown('msg', F, msg).map((e) => e.id));
  if (!shown.has('msg.answer')) {
    const words = document.createElement('p');
    words.className = 'action-options';
    words.textContent = 'Options: ' + msg.options.join(' · ');
    wrap.appendChild(words);
  }
  const btnRow = document.createElement('div');
  btnRow.className = 'action-buttons';
  if (shown.has('msg.answer')) msg.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn action-btn';
    b.dataset.action = 'msg.answer';
    b.dataset.value = String(i);
    b.textContent = opt;
    const held = heldAnswers.get('answer|' + msg.id);
    if (held && held.option === i) { b.textContent = '◷ ' + opt; b.dataset.state = 'sending'; }
    btnRow.appendChild(b);
  });
  if (shown.has('msg.answerWords')) {
    const other = document.createElement('button');
    other.type = 'button';
    other.className = 'btn ghost small answer-words-btn';
    other.dataset.action = 'msg.answerWords';
    other.textContent = AGM.catalog.entry('msg', 'msg.answerWords').label;
    btnRow.appendChild(other);
  }
  if (btnRow.childElementCount) wrap.appendChild(btnRow);
  const tally = document.createElement('div');
  tally.className = 'action-responses';
  tally.dataset.for = msg.id;
  wrap.appendChild(tally);
  renderResponses(tally, msg);
  return wrap;
}

function updateActionResponses(messageId, responses) {
  // There can be multiple matching elements: the original message in the
  // feed AND a clone in the pinned strip. Update them all.
  const els = document.querySelectorAll(`.action-responses[data-for="${messageId}"]`);
  if (!els.length) return;
  const msg = findMessage(messageId);
  if (msg) msg.responses = responses;
  els.forEach((el) => renderResponses(el, { responses, options: msg?.options || [] }));
  const node = messagesById.get(messageId);
  if (node) node.classList.add('answered');
  // Its pinned copy says the same, and so does its open menu (Answer ▸'s choice).
  if (node && node.dataset.pinned === '1') refreshPinned(messageId);
  if (openOn && openOn.kind === 'msg' && openOn.id === messageId) refreshOpenMenu();
}

// Classify an option label so its pill can be colour-coded.
function classifyOption(opt) {
  if (!opt) return 'note';
  const o = String(opt).toLowerCase().trim();
  const YES  = ['yes','y','approve','approved','confirm','confirmed','agree','agreed','ok','okay','accept','accepted','go','proceed','do it'];
  const NO   = ['no','n','reject','rejected','deny','denied','decline','declined','disagree','stop','cancel','cancelled','dont','don\'t','do not','nope'];
  const HOLD = ['defer','later','maybe','wait','waiting','hold','pause','paused','postpone','tbd','undecided','revisit'];
  if (YES.includes(o))  return 'yes';
  if (NO.includes(o))   return 'no';
  if (HOLD.includes(o)) return 'defer';
  return 'other';
}

function renderResponses(container, msg) {
  container.innerHTML = '';
  const responses = msg.responses || [];
  if (responses.length === 0) {
    container.innerHTML = '<small class="muted">Awaiting response…</small>';
    return;
  }
  for (const r of responses) {
    const opt =
      r.optionIndex >= 0 && msg.options && msg.options[r.optionIndex] !== undefined
        ? msg.options[r.optionIndex]
        : null;
    const kind = opt ? classifyOption(opt) : 'note';
    const pill = document.createElement('div');
    pill.className = 'response-pill r-' + kind;
    pill.innerHTML =
      `<strong>${escapeHtml(r.name)}</strong> ` +
      (opt
        ? `<span class="opt">${escapeHtml(opt)}</span>`
        : `<em>"${escapeHtml(r.note || '')}"</em>`);
    container.appendChild(pill);
  }
}

function setMessagePinned(messageId, pinned) {
  const data = findMessage(messageId);
  if (data) data.pinned = pinned;
  const node = messagesById.get(messageId);
  if (node && node.classList.contains('msg')) {
    node.dataset.pinned = pinned ? '1' : '0';
    node.classList.toggle('pinned', !!pinned);
    node.querySelector('.pinned-mark').hidden = !pinned;
    if (data) drawActs(node, data);
  }
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === messageId) drawDocActs();
  refreshOpenMenu();
}

/**
 * The pinned strip: each pinned message (text, prompts and help; files are in the panel's pinned list) drawn afresh from
 * its record, as the feed draws it, so every act on it is the feed's, through the one delegated handler. A pinned prompt
 * is hidden from the feed while it is pinned and answered here.
 */
/**
 * The pinned strip: each pinned message drawn from its record, in the hall's order. A copy already drawn is kept and
 * drawn again in place (only `onlyId`'s, when given), and moved only when its place changed, so a reaction or an answer
 * elsewhere never takes the focus or an open menu's opener from it. An unpinned copy that held the focus gives it to
 * the message in the feed.
 */
function refreshPinned(onlyId) {
  const strip = document.getElementById('pinnedStrip');
  const list = document.getElementById('pinnedList');
  const have = new Map([...list.querySelectorAll(':scope > .msg[data-id]')].map((n) => [n.dataset.id, n]));
  const want = allMessages.filter((m) => m.pinned && m.type !== 'file' && m.type !== 'system' && messagesById.has(m.id));
  let prev = null;
  for (const m of want) {
    let copy = have.get(m.id);
    if (copy) {
      have.delete(m.id);
      if (!onlyId || onlyId === m.id) rerenderMessage(copy, m);
    } else {
      copy = renderMessage(m);
      copy.classList.add('pinned-copy');
    }
    const at = prev ? prev.nextElementSibling : list.firstElementChild;
    if (at !== copy) list.insertBefore(copy, at);
    prev = copy;
  }
  for (const [id, gone] of have) {
    const held = gone.contains(document.activeElement);
    gone.remove();
    const there = held && messagesById.get(id);
    if (there && there.isConnected) there.focus();
  }
  strip.hidden = !want.length;
}

// ---------------- Doc panel ----------------
const docPanel = document.getElementById('docPanel');
const splitResizer = document.getElementById('splitResizer');
const leftCol = document.getElementById('leftCol');
const docPanelEl = docPanel;
const docDisplay = document.getElementById('docDisplay');
const docTitleEl = document.getElementById('docTitle');
const docCaptionEl = document.getElementById('docCaption');
const docActions = document.getElementById('docActions');
const docPinnedList = document.getElementById('docPinnedList');
const docPinnedSection = document.getElementById('docPinnedSection');
const docPinnedCount = document.getElementById('docPinnedCount');

let currentDocMsgId = null;

function openDocInPanel(msg, opts) {
  if (!msg || msg.type !== 'file') return;
  opts = opts || {};
  currentDocMsgId = msg.id;
  docPanel.dataset.state = 'live';
  setStageCollapsed && setStageCollapsed(false);
  // When a brand-new file is pushed in stacked layout, expand the panel
  // to ~75% so the document is clearly visible while leaving 25% of the
  // height for chat. Matches the splitter's drag maximum.
  if (opts.fromPush && HAS_STAGE && window.innerWidth <= 800) {
    if (typeof applySplit === 'function') applySplit(25);
  }
  docPanel.classList.toggle('priority', !!msg.priority);
  docTitleEl.textContent = msg.filename || '';
  docDisplay.innerHTML = '';
  docDisplay.appendChild(buildDocPreview(msg));
  if (msg.caption) {
    docCaptionEl.textContent = msg.caption;
    docCaptionEl.hidden = false;
  } else {
    docCaptionEl.hidden = true;
    docCaptionEl.textContent = '';
  }
  docActions.hidden = false;
  if (!_applyingRemote && !opts.fromPush) pushUserState('doc', { messageId: msg.id });
  drawDocActs();
}

function fileExt(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** The document on stage as plain text, for AI drafts (capped). */
const docForAi = { id: null, name: '', text: '' };
function setDocText(msg, text) {
  if (currentDocMsgId && msg.id !== currentDocMsgId) return;
  docForAi.id = msg.id; docForAi.name = msg.filename || ''; docForAi.text = String(text || '').slice(0, 60000);
}

/** Office documents become HTML here: keep the formatting, drop anything active. */
function sanitizeHtml(html) {
  const t = document.createElement('template');
  // The sanitiser's own parse: a <template> runs nothing, and only what survives the filter below leaves it.
  // eslint-disable-next-line agm/no-unescaped-html -- this is the escaper: the markup is parsed inert, then filtered
  t.innerHTML = String(html || '');
  t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,svg,math').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && !(v.startsWith('http:') || v.startsWith('https:') || v.startsWith('#') || v.startsWith('data:image/'))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  });
  return t.innerHTML;
}

function buildDocPreview(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-preview';
  const mime = (msg.mime || '').toLowerCase();
  const ext = fileExt(msg.filename);

  if (mime.startsWith('image/') ||
      ['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)) {
    const img = document.createElement('img');
    img.src = msg.url; img.alt = msg.filename;
    wrap.appendChild(img);
    return wrap;
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    const host = document.createElement('div');
    host.className = 'doc-pdf-canvas';
    host.innerHTML = '<p class="muted">Rendering PDF…</p>';
    wrap.appendChild(host);
    renderPdfInline(msg.url, host, msg).catch((e) => {
      host.innerHTML = `<p class="error">Couldn't render PDF: ${escapeHtml(e.message)}</p>`;
    });
    return wrap;
  }

  if (mime.startsWith('text/') || ['txt','md','log','json'].includes(ext)) {
    const host = document.createElement('pre');
    host.className = 'doc-text';
    host.textContent = 'Loading…';
    wrap.appendChild(host);
    fetch(msg.url).then((r) => r.text()).then((t) => {
      host.textContent = t;
      setDocText(msg, t);
    }).catch((e) => { host.textContent = "Couldn't load: " + e.message; });
    return wrap;
  }

  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) {
    const host = document.createElement('div');
    host.className = 'doc-html';
    host.innerHTML = '<p class="muted">Rendering Word document…</p>';
    wrap.appendChild(host);
    fetch(msg.url).then((r) => r.arrayBuffer()).then((ab) => {
      if (typeof mammoth === 'undefined') throw new Error('Word renderer not loaded');
      mammoth.extractRawText({ arrayBuffer: ab.slice(0) }).then((r) => setDocText(msg, r.value)).catch(() => {});
      return mammoth.convertToHtml({ arrayBuffer: ab });
    }).then(({ value }) => {
      host.innerHTML = value ? sanitizeHtml(value) : '<p class="muted">(empty document)</p>';
    }).catch((e) => {
      host.innerHTML = `<p class="error">Couldn't render this Word doc: ${escapeHtml(e.message)}</p>`;
    });
    return wrap;
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' ||
      mime.includes('officedocument.spreadsheetml') ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'text/csv') {
    const host = document.createElement('div');
    host.className = 'doc-html doc-sheet';
    host.innerHTML = '<p class="muted">Rendering spreadsheet…</p>';
    wrap.appendChild(host);
    fetch(msg.url).then((r) => r.arrayBuffer()).then((ab) => {
      if (typeof XLSX === 'undefined') throw new Error('Spreadsheet renderer not loaded');
      const wb = XLSX.read(ab, { type: 'array' });
      try { setDocText(msg, wb.SheetNames.slice(0, 8).map((n) => '# ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n')); } catch { /* the preview still shows; only the AI's copy of the text is missing */ }
      host.innerHTML = '';
      const view = document.createElement('div');
      view.className = 'sheet-view';
      const showSheet = (name) => {
        view.innerHTML = sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false }));
      };
      if (wb.SheetNames.length > 1) {
        const tabs = document.createElement('div');
        tabs.className = 'sheet-tabs';
        wb.SheetNames.forEach((name, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sheet-tab' + (i === 0 ? ' active' : '');
          b.textContent = name;
          b.onclick = () => {
            tabs.querySelectorAll('.sheet-tab').forEach((t) => t.classList.remove('active'));
            b.classList.add('active');
            showSheet(name);
          };
          tabs.appendChild(b);
        });
        host.appendChild(tabs);
      }
      host.appendChild(view);
      showSheet(wb.SheetNames[0]);
    }).catch((e) => {
      host.innerHTML = `<p class="error">Couldn't render spreadsheet: ${escapeHtml(e.message)}</p>`;
    });
    return wrap;
  }

  const card = document.createElement('div');
  card.className = 'doc-file-card';
  card.innerHTML =
    `<div class="ico">📄</div>` +
    `<div class="meta">` +
      `<strong>${escapeHtml(msg.filename)}</strong>` +
      `<small>${escapeHtml(prettyMime(mime))}</small>` +
      `<small class="muted">Inline preview not available — save as PDF to push for best results.</small>` +
    `</div>`;
  wrap.appendChild(card);
  return wrap;
}

let _pdfjs = null;
async function loadPdfJs() {
  if (!_pdfjs) {
    _pdfjs = await import('/vendor/pdf.min.mjs');
    _pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  }
  return _pdfjs;
}

async function renderPdfInline(url, host, msg) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ url, withCredentials: false, isEvalSupported: false, enableXfa: false }).promise;
  // Text for AI drafts, in the background (first 80 pages).
  if (msg) {
    (async () => {
      const parts = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 80); i++) {
        try { const tc = await (await pdf.getPage(i)).getTextContent(); parts.push('[page ' + i + '] ' + tc.items.map((x) => x.str).join(' ')); } catch (e) { break; }
        if (parts.join('\n').length > 60000) break;
      }
      setDocText(msg, parts.join('\n'));
    })();
  }
  host.innerHTML = '';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const containerWidth = host.clientWidth || 360;

  // Pre-create placeholder canvases sized correctly so the scrollbar reflects
  // the full document height — but only render a page when it scrolls into
  // view. This keeps a 200-page board pack snappy.
  const canvases = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = document.createElement('canvas');
    c.className = 'pdf-page pdf-page-pending';
    c.dataset.pageNum = String(i);
    host.appendChild(c);
    canvases.push(c);
  }

  async function sizePlaceholder(c, pageNum) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = (containerWidth - 8) / baseViewport.width;
    const vp = page.getViewport({ scale });
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    c.style.width = vp.width + 'px';
    c.style.height = vp.height + 'px';
    c._pageRef = page;
    c._viewport = vp;
  }
  await Promise.all(canvases.map((c, i) => sizePlaceholder(c, i + 1)));

  // Page indicator: a small sticky chip in the top-right showing
  // "page N / total". Created here (only for multi-page PDFs) so it
  // is a child of host and is auto-cleared when docDisplay.innerHTML
  // is reset on dismiss / new doc / rerender. See styles for the
  // sticky positioning.
  let indicator = null;
  if (pdf.numPages > 1) {
    indicator = document.createElement("div");
    indicator.className = "doc-page-indicator";
    indicator.textContent = "1 / " + pdf.numPages;
    host.insertBefore(indicator, host.firstChild);
  }

  const observer = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const c = ent.target;
      observer.unobserve(c);
      if (!c._pageRef || !c._viewport) continue;
      const ctx = c.getContext('2d');
      ctx.save(); ctx.scale(dpr, dpr);
      c._pageRef.render({ canvasContext: ctx, viewport: c._viewport }).promise.then(() => {
        c.classList.remove('pdf-page-pending');
      });
    }
  }, { root: host, rootMargin: '300px 0px' });
  for (const c of canvases) observer.observe(c);

  // Track which page currently sits in the centre band of the
  // viewport. Negative rootMargin shrinks the observation root
  // to a thin strip near the top-centre, so usually only one
  // page intersects at a time. We still track the full set in
  // case multiple pages overlap the band (small pages, big
  // viewport) and pick the lowest-numbered one as "current".
  if (indicator) {
    const intersecting = new Set();
    const indObs = new IntersectionObserver((entries) => {
      for (const ent of entries) {
        const n = parseInt(ent.target.dataset.pageNum, 10);
        if (!n) continue;
        if (ent.isIntersecting) intersecting.add(n);
        else intersecting.delete(n);
      }
      if (intersecting.size > 0) {
        const current = Math.min.apply(null, Array.from(intersecting));
        indicator.textContent = current + " / " + pdf.numPages;
      }
    }, {
      root: docDisplay,
      rootMargin: "-40% 0px -55% 0px",
      threshold: 0,
    });
    for (const c of canvases) indObs.observe(c);
  }
}

function dismissDoc() {
  currentDocMsgId = null;
  drawDocActs();
  docForAi.id = null; docForAi.name = ''; docForAi.text = '';
  docPanel.dataset.state = 'empty';
  docPanel.classList.remove('priority');
  docDisplay.innerHTML =
    `<div class="empty-state"><p>No document on stage.</p>` +
    `<p class="hint">When the backstage team shares a file, it appears here automatically.</p></div>`;
  docCaptionEl.hidden = true;
  docCaptionEl.textContent = '';
  docTitleEl.textContent = '';
  docActions.hidden = true;
}

// ---------------- The panel's files: the file open in it (the Preview's header) and its pinned list (kind `file`) ----------------
/** A file as the catalogue sees it: its message's record, and where it is drawn ('preview' or 'list'). */
const fileObject = (id, where) => { const m = findMessage(id); return m && m.type === 'file' ? Object.assign({}, m, { where }) : null; };
const docActs = document.getElementById('docActs');
/** The open file's bar: its inline acts with their words (📌 Pin, Close) and its ⋯. */
function drawDocActs() {
  const o = currentDocMsgId ? fileObject(currentDocMsgId, 'preview') : null;
  if (!o) { docActs.textContent = ''; return; }
  docActions.dataset.fileId = o.id;
  drawBar(docActs, 'file', o, { words: true, more: 'More for this file' });
}

function refreshDocPinnedList() {
  docPinnedList.textContent = '';
  let count = 0;
  for (const m of allMessages) {
    if (m.type !== 'file' || !m.pinned) continue;
    count++;
    const li = document.createElement('li');
    li.className = 'file-entry';
    li.dataset.fileId = m.id;
    li.dataset.key = m.id;
    // The name opens it where this seat may look (the catalogue's file.look, also the bar's 👁).
    const name = document.createElement('span');
    name.className = 'pinned-item';
    const ico = (m.mime || '').startsWith('image/') ? '🖼' : (m.mime === 'application/pdf' ? '📕' : '📄');
    name.innerHTML = `<span class="ico" aria-hidden="true">${escapeHtml(ico)}</span><span class="name">${escapeHtml(m.filename)}</span>`;
    const o = fileObject(m.id, 'list');
    if (AGM.catalog.shown('file', F, o).some((e) => e.id === 'file.look')) name.dataset.action = 'file.look';
    const bar = document.createElement('span');
    bar.className = 'file-acts';
    li.append(name, bar);
    drawBar(bar, 'file', o, { more: 'More for ' + (m.filename || 'this file'), keysOn: li });
    docPinnedList.appendChild(li);
  }
  docPinnedCount.textContent = count > 0 ? `(${count})` : '';
  docPinnedSection.hidden = count === 0;
}

// A file's doors: a click on an act or its ⋯, right-click and Shift+F10 on the open file's header or an entry of the list.
function fileDoor(t) {
  const li = t.closest('#docPinnedList .file-entry');
  const where = li ? 'list' : t.closest('#docActions, .doc-panel-header') && currentDocMsgId ? 'preview' : '';
  if (!where) return null;
  const id = li ? li.dataset.fileId : currentDocMsgId;
  const holder = li || docActions;
  const more = holder.querySelector('.obj-more');
  return {
    el: holder, more, where, id,
    open: (at) => openObjectMenu('file', () => fileObject(id, where), { node: holder, more, at, opener: holder.contains(document.activeElement) ? document.activeElement : more, label: 'File actions', header: (o) => o.filename || 'A file' }),
  };
}
docPanel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="file."], [data-more]');
  const door = el && fileDoor(el);
  if (!door) return;
  e.preventDefault();
  if (el.dataset.more) {
    if (openOn && openOn.kind === 'file' && openOn.id === door.id) { AGM.menu.close(); return; }
    openObjectMenu('file', () => fileObject(door.id, door.where), { node: door.el, more: el, opener: el, label: 'File actions', header: (o) => o.filename || 'A file' });
    return;
  }
  const o = fileObject(door.id, door.where);
  if (o) act('file', el.dataset.action, o, { anchor: door.more || el, node: door.el, opener: el });
});
docPanel.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !e.target.matches || !e.target.matches('#docPinnedList .file-entry')) return;
  const door = fileDoor(e.target);
  const o = door && fileObject(door.id, door.where);
  const entry = o && AGM.catalog.byKey('file', F, o, e.key);
  if (!entry) return;
  e.preventDefault();
  act('file', entry.id, o, { anchor: door.more || door.el, node: door.el, opener: door.el });
});
AGM.menu.door(docPanel, fileDoor);
AGM.roving(docPinnedList, { item: 'li[data-key]' });
Object.assign(RUN, {
  'file.screens': (o) => Screens.offer(o),
  'file.look': (o) => openDocInPanel(findMessage(o.id) || o),
  'file.download': (o) => download(o),
  'file.pin': (o) => pinWithUndo(o),
  'file.close': () => dismissDoc(),
});

// ---------------- Stage panel collapse/expand ----------------
const stageToggleBtn = document.getElementById('stageToggleBtn');
const docCollapseBtn = document.getElementById('docCollapseBtn');
const docExpandRail = document.getElementById('docExpandRail');
if (HAS_STAGE && stageToggleBtn) stageToggleBtn.hidden = false;

function setStageCollapsed(collapsed) {
  if (collapsed) {
    // Save current split widths so we can restore them on expand
    if (leftCol.style.flex)    leftCol.dataset.savedFlex    = leftCol.style.flex;
    if (docPanel.style.flex)   docPanel.dataset.savedFlex   = docPanel.style.flex;
    // Let the chat column take ALL the freed space; doc panel becomes a 36px rail
    leftCol.style.flex = '1 1 auto';
    docPanel.style.flex = '';
  } else {
    // Restore prior split (or fall back to the CSS defaults)
    leftCol.style.flex  = leftCol.dataset.savedFlex  || '';
    docPanel.style.flex = docPanel.dataset.savedFlex || '';
    delete leftCol.dataset.savedFlex;
    delete docPanel.dataset.savedFlex;
  }
  docPanel.classList.toggle('collapsed', !!collapsed);
  if (docExpandRail) docExpandRail.hidden = !collapsed;
  localStorage.setItem('agm.stageCollapsed', collapsed ? '1' : '0');
  setTimeout(rerenderCurrentDoc, 60);
  if (!_applyingRemote) pushUserState('stageCollapsed', !!collapsed);
}
function toggleStage() { setStageCollapsed(!docPanel.classList.contains('collapsed')); }

stageToggleBtn?.addEventListener('click', toggleStage);
docCollapseBtn?.addEventListener('click', toggleStage);
docExpandRail?.addEventListener('click', () => setStageCollapsed(false));

if (HAS_STAGE && localStorage.getItem('agm.stageCollapsed') === '1') {
  setStageCollapsed(true);
}

function rerenderCurrentDoc() {
  if (!currentDocMsgId) return;
  const m = findMessage(currentDocMsgId);
  if (!m || m.type !== 'file') return;
  const ext = (m.filename || '').toLowerCase().split('.').pop();
  const mime = (m.mime || '').toLowerCase();
  // Only PDFs are size-sensitive (canvas). Images / Word / Excel / text reflow naturally.
  if (mime === 'application/pdf' || ext === 'pdf') {
    docDisplay.innerHTML = '';
    docDisplay.appendChild(buildDocPreview(m));
  }
}


function prettyMime(m) {
  if (!m) return 'file';
  if (m === 'application/pdf') return 'PDF';
  if (m.includes('wordprocessingml')) return 'Word document';
  if (m.includes('presentationml')) return 'PowerPoint';
  if (m.includes('spreadsheetml')) return 'Excel';
  if (m.startsWith('text/')) return 'Text';
  return m;
}

// ---------------- Splitter (drag to resize columns) ----------------

(function initSplit() {
  if (!HAS_STAGE) return;
  const key = window.innerWidth <= 800 ? 'agm.splitPctV' : 'agm.splitPct';
  const saved = parseFloat(localStorage.getItem(key));
  if (saved && saved >= 20 && saved <= 85) applySplit(saved);
})();
window.addEventListener('resize', () => {
  // PDF needs re-render when the user resizes the browser, debounced.
  clearTimeout(window.__pdfResizeTimer);
  window.__pdfResizeTimer = setTimeout(rerenderCurrentDoc, 250);
});

function applySplit(leftPct) {
  if (!leftCol || !docPanelEl) return;
  leftCol.style.flex = `0 0 ${leftPct}%`;
  docPanelEl.style.flex = `0 0 ${100 - leftPct}%`;
}

let isDragging = false;
let dragStartX = 0;
let dragStartLeft = 0;
let dragTotal = 0;

let dragVertical = false;
splitResizer?.addEventListener('pointerdown', (e) => {
  if (!HAS_STAGE) return;
  if (docPanel.classList.contains('collapsed')) return;
  isDragging = true;
  dragVertical = window.innerWidth <= 800;
  dragStartX = dragVertical ? e.clientY : e.clientX;
  const rect = leftCol.getBoundingClientRect();
  const parentRect = leftCol.parentElement.getBoundingClientRect();
  dragStartLeft = dragVertical ? rect.height : rect.width;
  dragTotal = dragVertical ? parentRect.height : parentRect.width;
  splitResizer.setPointerCapture(e.pointerId);
  document.body.style.cursor = dragVertical ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
});
splitResizer?.addEventListener('pointermove', (e) => {
  if (!isDragging) return;
  const cur = dragVertical ? e.clientY : e.clientX;
  const delta = cur - dragStartX;
  let newSize = dragStartLeft + delta;
  const min = dragVertical ? 160 : 240;
  const max = dragTotal - (dragVertical ? 160 : 280);
  newSize = Math.max(min, Math.min(max, newSize));
  applySplit((newSize / dragTotal) * 100);
});
splitResizer?.addEventListener('pointerup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  splitResizer.releasePointerCapture(e.pointerId);
  const lc = leftCol.getBoundingClientRect();
  const pr = leftCol.parentElement.getBoundingClientRect();
  const pct = ((dragVertical ? lc.height : lc.width) /
               (dragVertical ? pr.height : pr.width)) * 100;
  localStorage.setItem(dragVertical ? 'agm.splitPctV' : 'agm.splitPct', String(pct));
  if (!_applyingRemote) pushUserState('split', { pct, vertical: dragVertical });
  setTimeout(rerenderCurrentDoc, 60);
});
splitResizer?.addEventListener('dblclick', () => {
  if (!HAS_STAGE) return;
  applySplit(50);
  localStorage.setItem('agm.splitPct', '50');
});

// ---------------- People panel ----------------
const peopleBtn = document.getElementById('peopleBtn');
const peoplePanel = document.getElementById('peoplePanel');
peopleBtn.onclick = () => { peoplePanel.hidden = !peoplePanel.hidden; };

// Who is in the room, a row each (kind `person`): its seat, its name, and its ⋯ where this seat has acts on them. Rows are
// drawn again in place by the person's id, so a people frame never takes the focus or an open menu's opener away.
const peopleList = document.getElementById('peopleList');
let people = [];
/** A person in the room as they are now (null: they left). */
const personNow = (uid) => personOf(people.find((u) => u.uid === uid) || null);
function renderUsers(users) {
  people = Array.isArray(users) ? users.filter((u) => u && typeof u.uid === 'string' && u.uid) : [];
  const have = new Map([...peopleList.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
  let prev = null;
  for (const u of people) {
    let li = have.get(u.uid);
    if (li) have.delete(u.uid);
    else {
      li = document.createElement('li');
      li.className = 'person-row';
      li.dataset.key = u.uid;
      const tag = document.createElement('span');
      tag.className = 'role-tag';
      const name = document.createElement('span');
      name.className = 'name';
      const bar = document.createElement('span');
      bar.className = 'person-acts';
      li.append(tag, name, bar);
    }
    const tag = li.querySelector('.role-tag');
    tag.dataset.role = u.role;
    tag.textContent = roleLabel(u.role);
    li.querySelector('.name').textContent = u.name;
    drawPersonRow(li);
    const at = prev ? prev.nextElementSibling : peopleList.firstElementChild;
    if (at !== li) peopleList.insertBefore(li, at);
    prev = li;
  }
  for (const gone of have.values()) gone.remove();
  peopleBtn.textContent = `People · ${people.length}`;
  if (openOn && openOn.kind === 'person') refreshOpenMenu();
}
function drawPersonRow(li) {
  const p = personNow(li.dataset.key);
  if (p) drawBar(li.querySelector('.person-acts'), 'person', p, { more: 'More for ' + p.name, keysOn: li });
}
function drawPeopleActs() { for (const li of peopleList.querySelectorAll(':scope > li[data-key]')) drawPersonRow(li); }
function personDoor(t) {
  const li = t.closest('li[data-key]');
  if (!li || !peopleList.contains(li)) return null;
  const uid = li.dataset.key;
  const more = li.querySelector('.obj-more');
  return { el: li, more, uid, open: (at) => openObjectMenu('person', () => personNow(uid), { node: li, more, at, opener: li.contains(document.activeElement) ? document.activeElement : more || li, label: 'Person actions', header: personHeader }) };
}
peopleList.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="person."], [data-more]');
  const door = el && personDoor(el);
  if (!door) return;
  e.preventDefault();
  if (el.dataset.more) {
    if (openOn && openOn.kind === 'person' && openOn.node === door.el) { AGM.menu.close(); return; }
    openObjectMenu('person', () => personNow(door.uid), { node: door.el, more: el, opener: el, label: 'Person actions', header: personHeader });
    return;
  }
  const p = personNow(door.uid);
  if (p) act('person', el.dataset.action, p, { anchor: door.more || el, node: door.el, opener: el });
});
AGM.menu.door(peopleList, personDoor);
AGM.roving(peopleList, { item: 'li[data-key]' });
Object.assign(RUN, {
  // @ Mention: the person's name in the composer, where the cursor is, and the focus there to go on writing.
  'person.mention': (p) => {
    const field = composerField({ text: true });
    if (!field) return;
    const v = field.value;
    const at = typeof field.selectionStart === 'number' ? field.selectionStart : v.length;
    const before = v.slice(0, at);
    const put = (before && !/\s$/.test(before) ? ' ' : '') + '@' + p.name + ' ';
    field.value = before + put + v.slice(at);
    field.focus();
    const caret = (before + put).length;
    if (typeof field.setSelectionRange === 'function') field.setSelectionRange(caret, caret);
  },
});


// ---------------- Priority toggle (per-composer): the catalogue's compose.priority ----------------
function wirePriority(btnId, form) {
  const btn = document.getElementById(btnId);
  if (!btn) return null;
  btn.addEventListener('click', () => { const o = composeObject(form); if (o) act('compose', 'compose.priority', o, { opener: btn, anchor: btn }); });
  return btn;
}
function setPriority(btn, on) {
  if (!btn) return;
  btn.dataset.priority = on ? '1' : '0';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'High priority is ON — click to disable' : 'Mark as high priority';
}
function consumePriority(btn) {
  if (!btn) return false;
  const v = btn.dataset.priority === '1';
  setPriority(btn, false);
  return v;
}
const dirPriBtn = wirePriority('dirPriorityBtn', 'director');
const textPriBtn = wirePriority('textPriorityBtn', 'text');
const actionPriBtn = wirePriority('actionPriorityBtn', 'action');
const filePriBtn = wirePriority('filePriorityBtn', 'file');
const PRIORITY = { director: () => dirPriBtn, text: () => textPriBtn, action: () => actionPriBtn, file: () => filePriBtn };

// ---------------- The composer's doors (catalog.js, kind `compose`) ----------------
// Its Send button is its one act on the row and its ⋯ the door to the rest (✨ Draft a reply, 🔥 Priority, Attach a
// file…, Remove the file, Cancel the reply); a right-click or Shift+F10 on either (or on the file chosen) opens the same
// list, while the text field keeps the browser's own menu. A send, from Send, Enter or the menu, runs through act().
/** The composer shown: 'director' On stage; backstage the open tab's, 'text', 'action' or 'file'; '' for none. */
function activeComposer() {
  if (!document.getElementById('directorCompose').hidden) return 'director';
  if (document.getElementById('researchCompose').hidden) return '';
  const tab = document.querySelector('.compose-tabs .tab.active');
  return tab ? tab.dataset.tab : 'text';
}
/** The composer `form` as the catalogue sees it (the one shown when none is named), or null where there is none. */
function composeObject(form) {
  const f = form || activeComposer();
  if (!f || !COMPOSER_FORMS[f] || !COMPOSER_FORMS[f]()) return null;
  const pri = PRIORITY[f]();
  // A message or a file goes where To: is set; a question and the On stage composer's message, to this room.
  const t = f === 'text' || f === 'file' ? targetNow() : null;
  return { id: 'compose:' + f, form: f, room: t ? t.name || t.hallName : ROOM_NAME, to: t ? t.ref : '', file: f === 'file' && pendingFile ? pendingFile.filename : '', replying: replyState ? replyState.name : '', priority: !!pri && pri.dataset.priority === '1' };
}
/** The room To: is set to, as room:sendTargets told it, or null for this room (or one no longer offered). */
function targetNow() { return sendTo ? F.targets.find((t) => t.ref === sendTo) || null : null; }
/** To: set to a room this page may send into (by its reference), or back to this room (''), and drawn. */
function setSendTo(ref) {
  sendTo = typeof ref === 'string' && F.targets.some((t) => t.ref === ref) ? ref : '';
  drawComposers();
  refreshOpenMenu();
}
const toBar = document.getElementById('composeTo');
const toBtn = document.getElementById('toBtn');
const toLine = document.getElementById('toLine');
/**
 * To: as the catalogue says it now, for the composer shown: there where compose.sendTo is (a page that may send into
 * another room, in the full view, on the message and file composers), naming where the next send goes. Set to another
 * room, the line "↗ to Legal — replies stay there" stays above the field at every width, and the composer takes the edge
 * of a room crossed.
 */
function drawTo() {
  const o = composeObject();
  const shown = !!o && !outOf && AGM.catalog.shown('compose', F, o).some((e) => e.id === 'compose.sendTo');
  const t = shown ? targetNow() : null;
  toBar.hidden = !shown;
  const words = 'To: ' + (t ? AGM.catalog.placeOf(t) : 'This room');
  if (toBtn.textContent !== '↗ ' + words) toBtn.textContent = '↗ ' + words;
  toBtn.setAttribute('aria-label', words);
  toLine.hidden = !t;
  toLine.textContent = t ? '↗ to ' + (t.name || t.hallName) + ' — replies stay there' : '';
  document.getElementById('researchCompose').classList.toggle('to-other', !!t);
}
// To: opens the catalogue's To ▸ values (This room, then each room this room may send into), as its own menu.
toBtn.addEventListener('click', () => {
  const o = composeObject();
  if (!o) return;
  if (AGM.menu.isOpen() && toBtn.getAttribute('aria-expanded') === 'true') { AGM.menu.close(); return; }
  const values = AGM.catalog.submenu('compose', 'compose.sendTo', F, o) || [];
  AGM.menu(values.map((v) => ({ ...v, id: 'compose.sendTo', icon: '', group: '2_send' })), { anchor: toBtn }, {
    label: 'Send the next message to', opener: toBtn,
    onPick: (id, value) => { const now = composeObject(); if (now) act('compose', 'compose.sendTo', now, { value, opener: toBtn, anchor: toBtn }); },
    onDisabled: (words) => AGM.toast(words, true),
  });
});
/**
 * The field a person types the next message in (`text`: the words' field, the Message tab opened for it backstage),
 * or, without `text`, the shown composer's first control; null where the page draws no composer.
 */
function composerField({ text = false } = {}) {
  const form = activeComposer();
  if (!form) return null;
  if (form === 'director') return dInput;
  if (text && form !== 'text') selectTab('text');
  const now = text ? 'text' : form;
  return now === 'text' ? textInput : now === 'action' ? actionText : pickFileBtn;
}
/** Open a tab of the backstage composer. */
function selectTab(name) {
  const t = document.querySelector('.compose-tabs .tab[data-tab="' + name + '"]');
  if (t && !t.classList.contains('active')) t.click();
}
const composeHeader = (o) => (o.replying ? 'Replying to ' + o.replying : 'Your message' + (o.room ? ' to ' + o.room : ''));
/** A composer's Send drawn as the catalogue says it now (its name, or why it cannot send), and its ⋯ while it has a menu. */
function drawCompose(form) {
  const el = COMPOSER_FORMS[form] && COMPOSER_FORMS[form]();
  const o = composeObject(form);
  const send = el && el.querySelector('.send-btn');
  if (!o || !send) return;
  const inl = AGM.catalog.inline('compose', F, o).find((i) => i.id === 'compose.send');
  if (inl) {
    send.dataset.action = inl.id;
    send.setAttribute('aria-label', inl.label);
    // Its word says where it goes when that is another room: "Send to Legal".
    const word = send.querySelector('.send-word');
    const said = o.to ? inl.label : 'Send';
    if (word && word.textContent !== said) word.textContent = said;
    send.title = inl.disabled || inl.label;
    if (inl.disabled) send.setAttribute('aria-disabled', 'true'); else send.removeAttribute('aria-disabled');
  }
  const menu = AGM.catalog.items('compose', F, o).length > 0;
  let more = el.querySelector('.compose-more');
  if (menu && !more) {
    more = moreButton('More for this message');
    more.classList.add('compose-more');
    more.disabled = send.disabled;
    send.after(more);
  } else if (!menu && more) more.remove();
}
function drawComposers() { for (const form of Object.keys(COMPOSER_FORMS)) drawCompose(form); drawTo(); }
const FORM_OF = new Map();   // a composer's form element → its name
function composeDoor(t) {
  const formEl = t.closest('form');
  const form = formEl && FORM_OF.get(formEl);
  if (!form || !t.closest('.send-btn, .compose-more, #filePreview')) return null;
  const more = formEl.querySelector('.compose-more');
  const opener = t.closest('button') || more || formEl.querySelector('.send-btn');
  return { el: formEl, more, form, open: (at) => openObjectMenu('compose', () => composeObject(form), { node: formEl, more, at, opener, label: 'Message actions', header: composeHeader }) };
}
for (const host of [document.getElementById('directorCompose'), document.getElementById('researchCompose')]) {
  host.addEventListener('click', (e) => {
    const more = e.target.closest('.compose-more');
    const door = more && composeDoor(more);
    if (!door) return;
    e.preventDefault();
    if (openOn && openOn.kind === 'compose' && openOn.node === door.el) { AGM.menu.close(); return; }
    door.open({ anchor: more });
  });
  AGM.menu.door(host, composeDoor);
}
/** Send what a composer holds: through the catalogue's compose.send (shown, ready), from Send, Enter or the menu. */
function sendFrom(form, opener) {
  const o = composeObject(form);
  const el = COMPOSER_FORMS[form]();
  if (o) act('compose', 'compose.send', o, { opener: opener || null, anchor: el.querySelector('.compose-more') || el.querySelector('.send-btn'), node: el });
}
// What each composer sends: what its fields hold, held by the outbox until the server has it.
const SENDS = {
  director: () => {
    const text = dInput.value.trim();
    if (!text || composerHeld('director')) return;
    holdMessage('director', { type: 'text', text, priority: consumePriority(dirPriBtn), replyTo: consumeReplyTo() });
  },
  text: () => {
    const text = textInput.value.trim();
    if (!text || composerHeld('text')) return;
    holdMessage('text', { type: 'text', text, priority: consumePriority(textPriBtn), replyTo: consumeReplyTo(), aiDraft: aiDrafted });
  },
  action: () => {
    const text = actionText.value.trim();
    if (!text || composerHeld('action')) return;
    holdMessage('action', { type: 'action', text, options: currentOptions.slice(), priority: consumePriority(actionPriBtn), replyTo: consumeReplyTo() });
  },
  file: () => {
    if (!pendingFile || composerHeld('file')) return;
    holdMessage('file', {
      type: 'file',
      url: pendingFile.url,
      filename: pendingFile.filename,
      mime: pendingFile.mime,
      caption: fileCaption.value.trim(),
      priority: consumePriority(filePriBtn),
      replyTo: consumeReplyTo(),
    }, { file: pendingFile.file, upload: uploadFile });
  },
};
Object.assign(RUN, {
  'compose.send': (o) => SENDS[o.form](),
  'compose.draft': () => {
    const replying = replyState ? findMessage(replyState.id) : null;
    const lastBoard = [...allMessages].reverse().find((m) => m.from && m.from.role === 'board' && (m.text || m.type === 'action'));
    draftAnswer(replying || lastBoard);
  },
  'compose.priority': (o) => setPriority(PRIORITY[o.form](), !o.priority),
  'compose.sendTo': (o, { value }) => { setSendTo(typeof value === 'string' ? value : ''); const field = composerField(); if (field) field.focus(); },
  'compose.attach': () => { selectTab('file'); fileInput.click(); },
  'compose.removeFile': () => { removePendingFile(); pickFileBtn.focus(); },
  'compose.cancelReply': () => { cancelReply(); const field = composerField(); if (field) field.focus(); },
});

// ---------------- Compose: director ----------------
const dForm = document.getElementById('directorForm');
const dInput = document.getElementById('directorInput');
dForm?.addEventListener('submit', (e) => { e.preventDefault(); sendFrom('director', e.submitter); });

// ---------------- Compose: research tabs ----------------
document.querySelectorAll('.compose-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.compose-tabs .tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.add('hidden'));
    tab.classList.add('active');
    const pane = document.querySelector(`.pane[data-pane="${tab.dataset.tab}"]`);
    if (pane) pane.classList.remove('hidden');
    drawTo();
  });
});

const textPane = document.getElementById('textPane');
const textInput = document.getElementById('textInput');
textPane?.addEventListener('submit', (e) => { e.preventDefault(); sendFrom('text', e.submitter); });
// In an empty message box ↑ goes to the newest message (one Tab stop, the feed's).
for (const field of [dInput, textInput]) {
  field?.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.key === 'ArrowUp' && field.value === '') { if (feedRoving.focus('last')) e.preventDefault(); }
  });
}
// A key on the composer (its message box, Send, its ⋯, 🔥) is the composer's catalogue key: Escape takes back a reply begun.
// An open menu or ask inside it keeps its own Escape (it stops there).
for (const host of [document.getElementById('directorCompose'), document.getElementById('researchCompose')]) {
  host.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
    const formEl = e.target.closest && e.target.closest('form');
    const form = formEl && FORM_OF.get(formEl);
    const o = form && composeObject(form);
    const entry = o && AGM.catalog.byKey('compose', F, o, e.key);
    if (!entry) return;
    e.preventDefault();
    act('compose', entry.id, o, { opener: e.target, node: formEl });
  });
}

// ---------------- AI: drafts for the backstage team (a person always edits and sends) ----------------
let aiDrafted = false;
function setAiHint(text, bad) {
  let h = document.getElementById('aiHint');
  if (!h && textPane) { h = document.createElement('p'); h.id = 'aiHint'; h.className = 'ai-hint'; textPane.appendChild(h); }
  if (!h) return;
  h.textContent = text; h.hidden = !text; h.classList.toggle('bad', !!bad);
}
// The ✨ buttons are drawn from the join's answer: live while AI drafts can be made; otherwise shown but not usable, with
// the reason as their title and, when one is pressed, in the line under the composer, where a touch screen shows it.
// Pressed while off, they send nothing.
const AI_OFF_WHY = AGM.catalog.WORDS.aiOff;
const AI_TITLES = new Map([...document.querySelectorAll('.ai-btn')].map((b) => [b, b.title]));
function drawAiButtons() {
  for (const [b, title] of AI_TITLES) {
    b.hidden = false;
    b.setAttribute('aria-disabled', AI_ON ? 'false' : 'true');
    b.title = AI_ON ? title : AI_OFF_WHY;
  }
  if (AI_ON && document.getElementById('aiHint')?.textContent === AI_OFF_WHY) setAiHint('');
}
/** Whether AI drafts can be made now; if not, the reason is said where the person is looking. */
function aiReady(where) {
  if (AI_ON) return true;
  if (where === 'draft') setAiHint(AI_OFF_WHY); else AGM.toast(AI_OFF_WHY);
  return false;
}
// ✨ is the catalogue's compose.draft: with AI drafts off it says why under the composer, where a finger reads it.
document.getElementById('aiDraftBtn')?.addEventListener('click', (e) => {
  if (!aiReady('draft')) return;
  const o = composeObject('text');
  if (o) act('compose', 'compose.draft', o, { opener: e.currentTarget, anchor: e.currentTarget });
});
/**
 * An AI draft of the answer to `q` (a Board question, or none), from the thread and the document on stage, in the
 * composer. It is a read: it changes nothing on the server and nothing reaches the hall, so it is a plain emit, refused
 * at once while the page is not connected (as the catalogue's `now` is), and answered when the AI has answered, which
 * takes longer than the outbox's 5 s for an act on something.
 */
function draftAnswer(q) {
  if (!socket.connected) { setAiHint(AGM.catalog.WORDS.offline, true); return; }
  const btn = document.getElementById('aiDraftBtn');
  btn.disabled = true; btn.textContent = '✨ Drafting…';
  setAiHint('Claude is drafting from the thread' + (docForAi.text ? ' and “' + docForAi.name + '”' : '') + '…');
  socket.emit('ai:draft', {
    question: q ? q.text || '' : '',
    instruction: textInput.value.trim(),
    docName: docForAi.name, docText: docForAi.text,
  }, (res) => {
    btn.disabled = false; btn.textContent = '✨ Draft a reply';
    if (!res || !res.ok) { setAiHint((res && res.error) || 'No draft.', true); return; }
    textInput.value = res.draft || '';
    textInput.dispatchEvent(new Event('input'));
    aiDrafted = true;
    if (q && !replyState) beginReply(q);
    setAiHint('✨ Draft (' + res.confidence + ' confidence) — check it, edit it, then Send.' + (res.gaps && res.gaps.length ? ' Missing: ' + res.gaps.join('; ') : ''));
    textInput.focus();
  });
}
textInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // requestSubmit() is newer than the page floor (Safari 16): where it is missing, Send's own click submits the form
    // the same way, so Enter sends on every device.
    // eslint-disable-next-line no-restricted-syntax -- behind its probe, with Send's click where the browser has none
    if (typeof textPane.requestSubmit === 'function') textPane.requestSubmit();
    else textPane.querySelector('button[type="submit"]').click();
  }
});

const actionPane = document.getElementById('actionPane');
const actionText = document.getElementById('actionText');
const actionOptions = document.getElementById('actionOptions');
const actionOptionInput = document.getElementById('actionOptionInput');
let currentOptions = ['Yes', 'No'];

function renderOptionChips() {
  actionOptions.innerHTML = '';
  currentOptions.forEach((opt, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(opt)} <button type="button" aria-label="remove">×</button>`;
    chip.querySelector('button').onclick = () => {
      currentOptions.splice(i, 1);
      renderOptionChips();
    };
    actionOptions.appendChild(chip);
  });
}
renderOptionChips();

document.getElementById('addOptionBtn')?.addEventListener('click', () => {
  const v = actionOptionInput.value.trim();
  if (v && currentOptions.length < 6) {
    currentOptions.push(v);
    actionOptionInput.value = '';
    renderOptionChips();
  }
});
actionOptionInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('addOptionBtn').click();
  }
});
document.getElementById('resetOptionsBtn')?.addEventListener('click', () => {
  currentOptions = ['Yes', 'No'];
  renderOptionChips();
});
document.getElementById('aiOptionsBtn')?.addEventListener('click', () => {
  if (!aiReady('options')) return;
  const btn = document.getElementById('aiOptionsBtn');
  const prompt = actionText.value.trim();
  if (!prompt) { AGM.toast('Type the question first.'); return; }
  btn.disabled = true;
  socket.emit('ai:options', { prompt }, (res) => {
    btn.disabled = false;
    if (!res || !res.ok || !res.options || !res.options.length) { AGM.toast((res && res.error) || 'No suggestions.', true); return; }
    currentOptions = res.options.slice(0, 6);
    renderOptionChips();
  });
});

actionPane?.addEventListener('submit', (e) => { e.preventDefault(); sendFrom('action', e.submitter); });

const filePane = document.getElementById('filePane');
const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const filePreview = document.getElementById('filePreview');
const fileCaption = document.getElementById('fileCaption');
const pickFileBtn = document.getElementById('pickFileBtn');
let pendingFile = null;

pickFileBtn?.addEventListener('click', () => fileInput.click());
fileInput?.addEventListener('change', () => handleFiles(fileInput.files));
dropzone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('hover');
});
dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('hover'));
dropzone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('hover');
  handleFiles(e.dataTransfer.files);
});

/**
 * A file to this hall's uploads, with the upload token of the page's newest join: `{url, filename, mime}`, or why not —
 * `{status, error}` when the server refused it, `{network: true}` when it never reached AGMessage.
 */
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  let res;
  try { res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } }); } catch { return { network: true, error: 'Can\'t reach AGMessage — the file goes when the connection is back.' }; }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON: the status words stand */ }
  if (!res.ok || !body || typeof body.url !== 'string') return { status: res.status, error: (body && body.error) || 'Upload failed.' };
  return body;
}

async function handleFiles(files) {
  if (!files || !files.length) return;
  const file = files[0];
  filePreview.hidden = false;
  filePreview.textContent = `Uploading ${file.name}…`;
  const up = await uploadFile(file);
  if (up.url) {
    pendingFile = { ...up, file };
  } else if (up.network) {
    // Not uploaded yet: the outbox uploads it with the message, once the connection is back.
    pendingFile = { url: '', filename: file.name, mime: file.type || '', file, waiting: true };
  } else {
    filePreview.textContent = up.error;
    pendingFile = null;
    drawCompose('file');
    return;
  }
  renderFilePreview();
  drawCompose('file');
}
/** The file chosen to send is put down: nothing to send until another is chosen. */
function removePendingFile() {
  pendingFile = null;
  filePreview.hidden = true;
  filePreview.innerHTML = '';
  fileInput.value = '';
  drawCompose('file');
}

function renderFilePreview() {
  if (!pendingFile) return;
  filePreview.innerHTML = '';
  if (pendingFile.url && pendingFile.mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = pendingFile.url;
    img.alt = pendingFile.filename;
    img.className = 'preview-img';
    filePreview.appendChild(img);
  } else {
    const p = document.createElement('p');
    p.textContent = `📄 ${pendingFile.filename}` + (pendingFile.waiting ? ' — not uploaded yet: it goes with the message when the connection is back' : '');
    filePreview.appendChild(p);
  }
  // Its Remove is the catalogue's compose.removeFile, named as its menu item is.
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'btn ghost small';
  rm.textContent = 'Remove';
  rm.setAttribute('aria-label', AGM.catalog.entry('compose', 'compose.removeFile').label);
  rm.addEventListener('click', () => { const o = composeObject('file'); if (o) act('compose', 'compose.removeFile', o, { opener: rm, anchor: rm }); });
  filePreview.appendChild(rm);
}

filePane?.addEventListener('submit', (e) => { e.preventDefault(); sendFrom('file', e.submitter); });
for (const [name, el] of [['director', dForm], ['text', textPane], ['action', actionPane], ['file', filePane]]) if (el) FORM_OF.set(el, name);

// The skip link: the page's first Tab, "Skip to message box" for a seat with a composer (it takes the focus to the
// composer's field) and "Skip to messages" for one without (to the feed's one stop, the newest message).
const skipLink = document.getElementById('skipLink');
function drawSkip() { skipLink.textContent = composerField() ? 'Skip to message box' : 'Skip to messages'; }
skipLink.addEventListener('click', (e) => {
  e.preventDefault();
  const field = composerField();
  if (field) field.focus(); else if (!feedRoving.focus('current')) feed.focus();
});
drawSkip();

// ---------------- Helpers ----------------
/** A seat in the words every page uses: a hall's Main room's (On stage, Backstage, Observer), a side room's backstage
 *  seat a Member's (MAIN, from the join's answer). 'director' is a legacy alias kept for old persisted history. */
function roleLabel(role) {
  return role === 'board' || role === 'director' ? 'On stage' :
         role === 'research' ? (MAIN ? 'Backstage' : 'Member') :
         role === 'observer' ? 'Observer' : role;
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------- The reader keeps their place, and a new message is marked, never flashed ----------------
// The feed follows the newest message only while the reader is at its end (within a line of the bottom, as the feed
// was last left) and no menu is open on it; otherwise it stays where the reader put it, and "↓ n new" says how many
// came below. A New divider sits above the first message from someone else that arrived since the person last touched
// the page while it was shown (a pointerdown, a key, or a wheel: a scroll of their own begins with one of them); it
// moves only when one arrives after their next touch, and no timer takes it away. A scroll the page makes (following,
// or the view kept still as the divider moves) is never a touch.
const newBelow = document.getElementById('newBelow');
const place = {
  atEnd: true,      // the feed was within a line of the bottom when it was last moved, by the reader or the page
  unread: 0,        // messages from others drawn below a feed the reader had scrolled up
  touched: false,   // the person touched the page since the divider was put where it is
  divider: null,
};
function nearEnd() {
  const line = parseFloat(getComputedStyle(feed).fontSize) * 1.5;
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= line;
}
/** While a menu or an ask is open the feed never moves under it. */
function readerAtEnd() { return (place.atEnd || nearEnd()) && !AGM.menu.isOpen() && !AGM.ask.isOpen(); }
/** While a page draws what it missed (rejoin): the reader's place as read before the first, and whether to follow. */
let catchUp = null;
function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
  place.atEnd = true;
  if (place.unread) drawNewBelow(0);
}
/** Follow the newest message: now, or once a page has drawn all it missed. */
function toEnd() { if (catchUp) catchUp.toEnd = true; else scrollToBottom(); }
/**
 * Move something within the feed and keep what the reader sees where it was on the screen: the first message in view
 * is put back where it was. A browser that anchors scrolling (overflow-anchor) has already kept it, and the correction
 * is 0; one that does not (Safari before 27) would otherwise pull the feed up under the reader's eyes when the divider
 * leaves a place above the view.
 */
function holdView(move) {
  const top = feed.getBoundingClientRect().top;
  const anchor = [...feed.children].find((n) => n !== place.divider && n.getBoundingClientRect().bottom > top);
  const was = anchor ? anchor.getBoundingClientRect().top : 0;
  move();
  if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - was;
}
/** A message that reached the hall: it may move the divider, and the feed follows it or counts it below. */
function keepPlace(el, msg, follow) {
  const news = msg.type !== 'system' && !isMine(msg);
  if (news && (!place.divider || place.touched)) {
    const d = place.divider;
    if (!d) {
      place.divider = document.createElement('div');
      place.divider.className = 'new-divider';
      place.divider.setAttribute('role', 'separator');
      place.divider.setAttribute('aria-label', 'New messages below');
      place.divider.textContent = 'New';
      feed.insertBefore(place.divider, el);
    } else if (follow || d.parentNode !== feed) feed.insertBefore(d, el);
    else holdView(() => feed.insertBefore(d, el));
    place.touched = false;
  }
  if (follow) toEnd();
  else if (news) drawNewBelow(place.unread + 1);
}
function drawNewBelow(n) {
  place.unread = n;
  newBelow.hidden = n === 0;
  newBelow.textContent = '↓ ' + n + ' new';
  newBelow.setAttribute('aria-label', n + (n === 1 ? ' new message' : ' new messages') + ' below');
}
/** The divider stays only above a message: when the one under it goes, it sits above the next, or goes with none. */
function tidyDivider() {
  const d = place.divider;
  if (!d || !d.parentNode) return;
  let next = d.nextElementSibling;
  while (next && next.classList.contains('sys')) next = next.nextElementSibling;
  if (!next || next.classList.contains('echo')) { d.remove(); place.divider = null; }
  else if (next !== d.nextElementSibling) feed.insertBefore(d, next);
}
/** A feed drawn afresh (the history, a reset): no divider, nothing counted below. */
function forgetPlace() {
  if (place.divider) place.divider.remove();
  place.divider = null;
  place.touched = false;
  drawNewBelow(0);
}
const noteTouch = () => { if (document.visibilityState === 'visible') place.touched = true; };
for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, noteTouch, { capture: true, passive: true });
feed.addEventListener('scroll', () => {
  place.atEnd = nearEnd();
  if (place.atEnd && place.unread) drawNewBelow(0);
}, { passive: true });
newBelow.addEventListener('click', scrollToBottom);

// What moved, said once per browser: the acts that left a message's own buttons are in its ⋯, and on its right-click and
// Shift+F10. The support view is the admin's browser, which is not told.
(function () {
  const line = document.getElementById('movedLine');
  let seen;
  try { seen = localStorage.getItem('agm.moved') === '0.6.0'; } catch { seen = false; /* storage blocked: said on each open */ }
  if (seen || ADMIN_VIEW) return;
  line.hidden = false;
  document.getElementById('movedOk').addEventListener('click', () => {
    line.hidden = true;
    try { localStorage.setItem('agm.moved', '0.6.0'); } catch { /* storage blocked: said again on the next open */ }
  });
})();

// Admin support view banner
if (ADMIN_VIEW) {
  document.body.classList.add('is-admin-view');
  const b = document.createElement('div');
  b.className = 'admin-view-banner';
  b.innerHTML = 'Admin support view — what <strong>' + escapeHtml(NAME) + '</strong> sees. Nothing here acts: act from your own page.';
  document.body.prepend(b);

  // Robust initial sync: ask peers to publish their state several times in
  // the first ~15s (covers the case where the very first push raced with
  // our connect/handshake and was missed).
  function _resyncBurst() {
    let n = 0;
    const t = setInterval(() => {
      if (socket && socket.connected) socket.emit('userState:requestPeers');
      if (++n >= 5) clearInterval(t);
    }, 3000);
    if (socket && socket.connected) socket.emit('userState:requestPeers');
  }
  if (socket && socket.connected) _resyncBurst();
  else socket && socket.on('connect', _resyncBurst);

  // The admin page that frames this view asks it to resync now. Only that page is heard: the frame's own parent, from
  // this origin. A frame inside this page, or a window of another site, is not.
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    if (e.data && e.data.type === 'agm:resync' && socket && socket.connected) {
      socket.emit('userState:requestPeers');
      if (window.AGM_DEBUG_SYNC) console.log('[sync] manual resync requested');
    }
  });
}


// ---------------- Bidirectional UI sync (user ↔ admin support view) ----------------
// Any same-name peer in the same room receives UI state changes — keeps the
// admin's support popup and the real user's window in lockstep.
// Queue state pushes that fire before the socket connects, so the very
// first theme/zoom toggle right after page load doesn't get dropped.
// (_pendingStates is declared at the top of this file to avoid TDZ traps.)
function pushUserState(key, value) {
  if (!socket) return;
  if (!socket.connected) {
    _pendingStates.push({ key, value });
    return;
  }
  if (window.AGM_DEBUG_SYNC) console.log('[sync] push', key, value);
  socket.emit('userState:push', { key, value });
}
function _flushPendingStates() {
  while (_pendingStates.length) {
    const p = _pendingStates.shift();
    if (window.AGM_DEBUG_SYNC) console.log('[sync] flush', p.key, p.value);
    socket.emit('userState:push', p);
  }
}
if (typeof socket !== 'undefined') {
  socket.on('connect', _flushPendingStates);
}

// (_applyingRemote is declared at the top of this file to avoid TDZ traps.)

// When an admin support view joins, the server asks the real user (us) to
// publish our current UI state so the popup starts in sync.
socket.on('userState:request', () => {
  pushUserState('theme', document.documentElement.dataset.theme || 'light');
  pushUserState('zoom', currentZoom);
  if (docPanel.classList.contains('collapsed')) {
    pushUserState('stageCollapsed', true);
  }
  if (currentDocMsgId) {
    pushUserState('doc', { messageId: currentDocMsgId });
  }
  // Splitter state
  const lc = leftCol && leftCol.getBoundingClientRect();
  const par = leftCol && leftCol.parentElement && leftCol.parentElement.getBoundingClientRect();
  if (lc && par && par.width > 0 && par.height > 0) {
    const vertical = window.innerWidth <= 800;
    const pct = ((vertical ? lc.height : lc.width) / (vertical ? par.height : par.width)) * 100;
    pushUserState('split', { pct, vertical });
  }
});

socket.on('userState:push', ({ key, value }) => {
  if (window.AGM_DEBUG_SYNC) console.log('[sync] recv', key, value);
  _applyingRemote = true;
  try {
    if (key === 'theme' && (value === 'light' || value === 'dark')) {
      localStorage.setItem('agm.theme', value);
      applyTheme(value);
    } else if (key === 'zoom' && typeof value === 'number') {
      setZoom(value);
    } else if (key === 'stageCollapsed' && typeof value === 'boolean') {
      setStageCollapsed(value);
    } else if (key === 'split' && value && typeof value.pct === 'number') {
      const k = value.vertical ? 'agm.splitPctV' : 'agm.splitPct';
      localStorage.setItem(k, String(value.pct));
      applySplit(value.pct);
      // Mirror the local drag-end behaviour: PDF canvases need re-render
      // to the new panel width. Without this, the admin-driven splitter
      // resizes the panel on the user side but the on-stage PDF stays at
      // the old canvas width. Same 60ms delay as the local pointerup
      // handler so layout settles before measuring.
      setTimeout(rerenderCurrentDoc, 60);
    } else if (key === 'doc') {
      if (value === null) {
        dismissDoc();
      } else if (value && typeof value.messageId === 'string') {
        const m = findMessage(value.messageId);
        if (m) openDocInPanel(m);
      }
    }
  } catch (e) { /* ignore */ }
  _applyingRemote = false;
});

// ---------- Mentions: highlight @Name in rendered text ----------
function renderMessageText(text) {
  const safe = escapeHtml(text || '');
  return safe.replace(/(^|\s)(@[\w][\w.-]{0,40})/g,
    (_m, pre, mention) => pre + '<span class="mention">' + mention + '</span>');
}

// ---------- Reactions ----------
function renderReactions(node, reactions) {
  const rx = node.querySelector('.reactions');
  if (!rx) return;
  rx.innerHTML = '';
  if (!reactions || !reactions.length) { rx.hidden = true; return; }
  const counts = new Map();
  const myUid = MY_UID;
  for (const r of reactions) {
    const cur = counts.get(r.emoji) || { n: 0, mine: false, names: [] };
    cur.n++;
    cur.names.push(r.name);
    if (r.uid === myUid) cur.mine = true;
    counts.set(r.emoji, cur);
  }
  // Each pill is the catalogue's msg.react with its emoji: a tap adds this person's or takes it away.
  for (const [emoji, data] of counts) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'rx-pill' + (data.mine ? ' mine' : '');
    pill.title = data.names.join(', ');
    pill.innerHTML = '<span>' + escapeHtml(emoji) + '</span> <small>' + escapeHtml(String(data.n)) + '</small>';
    pill.dataset.action = 'msg.react';
    pill.dataset.value = emoji;
    pill.setAttribute('aria-pressed', data.mine ? 'true' : 'false');
    pill.disabled = !F.post;
    rx.appendChild(pill);
  }
  rx.hidden = false;
}

// ---------- Reply / threading ----------
let replyState = null;  // { id, name, snippet }
function beginReply(msg) {
  replyState = {
    id: msg.id,
    name: (msg.from && msg.from.name) || 'system',
    snippet: msg.text || msg.filename || (msg.type === 'action' ? msg.text : ''),
  };
  renderReplyChip();
  const el = document.getElementById(ROLE === 'board' ? 'directorInput' : 'textInput');
  if (el) el.focus();
  // Switch the research compose to the text tab so the chip is visible
  const textTab = document.querySelector('.compose-tabs .tab[data-tab="text"]');
  if (textTab && !textTab.classList.contains('active')) textTab.click();
}
function cancelReply() {
  replyState = null;
  renderReplyChip();
}
function renderReplyChip() {
  let chip = document.getElementById('replyChip');
  if (!replyState) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'replyChip';
    chip.className = 'reply-chip';
    const target = document.getElementById('directorCompose').hidden
      ? document.getElementById('researchCompose')
      : document.getElementById('directorCompose');
    target.prepend(chip);
  }
  chip.innerHTML = '<span>↩ Replying to <strong>' + escapeHtml(replyState.name) + '</strong>: <em>' +
    escapeHtml((replyState.snippet || '').slice(0, 80)) + '</em></span>' +
    '<button type="button" class="reply-cancel" title="Cancel the reply (Esc)" aria-label="Cancel the reply">×</button>';
  const x = chip.querySelector('.reply-cancel');
  x.addEventListener('click', () => { const o = composeObject(); if (o) act('compose', 'compose.cancelReply', o, { opener: x, anchor: x }); });
}
function consumeReplyTo() {
  const r = replyState ? replyState.id : null;
  if (replyState) cancelReply();
  return r;
}

// ---------------- Help in two taps, and the asker sees what happened ----------------
// Help, then what it is about: a category sends at once, to the room and to the hall's crew on the halls board, with the
// optional words typed before it; none is chosen for the person. The heading takes the focus when the dialog opens, so a
// phone's keyboard does not rise over the categories, and Enter in the words moves the focus to them and sends nothing.
// The dialog's one submit button is Close, so a form submitted by any other path closes it and sends nothing either.
// "Something else" is sent as 'Other', the category lib/board.js keeps.
const HELP_CATS = [['Sound', 'Sound'], ['Vision', 'Vision'], ['Lighting', 'Lighting'], ['Stage', 'Stage'], ['Presenter', 'Presenter'], ['IT / network', 'IT / network'], ['Other', 'Something else']];
const helpDialog = document.getElementById('helpDialog');
const helpText = document.getElementById('helpText');
/** The help dialog, open with these words (a request held and refused comes back with its own), the heading focused. */
function openHelpDialog(words) {
  helpText.value = words || '';
  AGM.openDialog(helpDialog);
  document.getElementById('helpTitle').focus();
}
(function () {
  const box = document.getElementById('helpCats');
  for (const [category, label] of HELP_CATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn help-cat';
    b.dataset.cat = category;
    b.textContent = label;
    b.addEventListener('click', () => {
      // The admin's support view draws the person's Help and sends nothing for them (R8): it says whose view it is.
      if (F.support) { helpDialog.close(); AGM.toast(AGM.catalog.supportWords(F.support), true); return; }
      AGM.outbox.hold('message', { type: 'help', category, text: helpText.value.trim() });
      helpDialog.close();
      if (!AGM.outbox.online) AGM.toast('Help request held — it goes as soon as the connection is back.');
    });
    box.appendChild(b);
  }
  helpText.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    box.querySelector('button').focus();
  });
})();

/**
 * The Help button says what happened to this person's own request. At rest it is neutral and asks. While their newest
 * request is open it is that request's status chip: "■ Help asked", then "▶ Ana is on the way", read from the request
 * as the hall's record of it changes here (helpUpdate), so the chip says what the hall says, never what was only sent;
 * a request seen resolved here reads "✓ Resolved" for 30 s, and an open one of theirs outranks it. A tap on the chip asks
 * in place (AGM.ask, right after the chip, so Tab runs from the chip into it and on), not as a menu, naming the request
 * and what each answer does for everyone: It's sorted (the author's own Resolved), Cancel request (the author's own
 * delete) or Keep it open, the safe choice, where the focus starts; Escape, a tap outside it and the focus moved to
 * another control are Keep it open. The ask says what its request says as it changes, and goes when its request is
 * resolved or removed, and with the hall.
 */
const HelpChip = (function () {
  const btn = document.getElementById('helpBtn');
  const status = document.getElementById('helpStatus');
  const RESOLVED_MS = 30000;
  const AT_REST = btn.title;
  const ASK_THEN = 'It\'s sorted marks it resolved for everyone. Cancel request takes it away from everyone. Neither can be undone.';
  let resolved = null;   // this person's request seen resolved on this page: {id, timer}
  let asked = null;      // the request the open ask is about: {id}
  let drawn = '';

  /** This person's newest help request that is not resolved, or null. */
  function openRequest() {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i];
      if (m.type === 'help' && isMine(m) && !(m.help && m.help.state === 'resolved')) return m;
    }
    return null;
  }
  /** [state, mark, words] for the chip: '' at rest. */
  function chipOf(m) {
    if (m && m.help && m.help.state === 'coming') return ['coming', '▶', (m.help.by || 'Someone') + ' is on the way'];
    if (m) return ['open', '■', 'Help asked'];
    if (resolved) return ['resolved', '✓', 'Resolved'];
    return ['', '', 'Help'];
  }
  /** The ask's words: its request and where it stands, then what each answer does to it for everyone. */
  function askWords(m) {
    const h = m.help || { state: 'open' };
    return [m.category + (m.text ? ': ' + m.text : '') + ' · ' + (h.state === 'coming' ? '▶ ' + (h.by || 'Someone') + ' is on the way' : '■ ' + HELP_WORDS.open), ASK_THEN];
  }
  function draw() {
    if (resolved && !findMessage(resolved.id)) forgetResolved();
    const m = openRequest();
    const [state, mark, words] = chipOf(m);
    const key = state + '|' + words;
    if (key !== drawn) {
      drawn = key;
      btn.textContent = '';
      if (mark) {
        const span = document.createElement('span');
        span.setAttribute('aria-hidden', 'true');
        span.textContent = mark + ' ';
        btn.appendChild(span);
      }
      btn.appendChild(document.createTextNode(words));
      if (state) btn.dataset.state = state; else delete btn.dataset.state;
      // Said once to a screen reader as it changes: the chip is a button, not a live region.
      status.textContent = state ? 'Your help request: ' + words : '';
    }
    btn.title = m ? 'Your help request (' + m.category + '): mark it sorted, or cancel it' : AT_REST;
    if (m) btn.setAttribute('aria-expanded', asked ? 'true' : 'false'); else btn.removeAttribute('aria-expanded');
    // Its request resolved or gone while the person was in the ask: the focus goes back to the chip, never to the page.
    if (asked && (!m || m.id !== asked.id)) { const box = AGM.ask.box(); close(!!box && box.contains(document.activeElement)); }
    else if (asked) AGM.ask.update({ words: askWords(m) });
  }
  function forgetResolved() {
    if (resolved) clearTimeout(resolved.timer);
    resolved = null;
  }
  /** A help request's state changed on this page; `was` is the state it had. */
  function changed(m, was) {
    if (isMine(m) && m.help && m.help.state === 'resolved' && was !== 'resolved') {
      forgetResolved();
      resolved = { id: m.id, timer: setTimeout(() => { resolved = null; draw(); }, RESOLVED_MS) };
    }
    draw();
  }
  function open(m) {
    const mine = { id: m.id };
    asked = mine;
    btn.setAttribute('aria-expanded', 'true');
    AGM.ask(btn, { title: 'Your help request', words: askWords(m), choices: [{ answer: 'sorted', label: 'It\'s sorted' }, { answer: 'cancel', label: 'Cancel request' }], no: 'Keep it open' },
      { opener: btn, after: btn, toggles: true }).then((a) => {
      if (asked !== mine) return;
      asked = null;
      if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
      if (!a.yes || !findMessage(mine.id)) return;
      if (F.support) { AGM.toast(AGM.catalog.supportWords(F.support), true); return; }
      if (a.choice === 'sorted') AGM.outbox.hold('help:respond', { code: ROOM, messageId: mine.id, state: 'resolved' });
      else if (a.choice === 'cancel') AGM.outbox.now('delete', { messageId: mine.id }, saidIfNot('Could not cancel the request.'));
    });
  }
  /** The ask closes, its request kept; `focusBack`: the focus returns to the chip (its request gone from under it). */
  function close(focusBack) {
    if (!asked) return;
    asked = null;
    AGM.ask.close();
    if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
    if (focusBack && !btn.hidden) btn.focus();
  }
  btn.addEventListener('click', () => {
    const m = openRequest();
    if (!m) { openHelpDialog(''); return; }
    if (asked) close(true); else open(m);
  });
  // Focus gone from the chip to another control of the page (neither into the ask nor back to the chip): it closes.
  btn.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    const box = AGM.ask.box();
    if (asked && to && !(box && box.contains(to)) && !btn.contains(to)) close(false);
  });
  return { draw, changed, close };
})();

// ---------------- Screens: what this hall's displays show (accounts with display.control) ----------------
// Tick the screens, then take: holding, countdown, clock, black, a message (alone, or under the countdown — the
// speaker's comfort monitor), or a file from the hall. Each screen says what it showed: ✓ on screen only once it has.
const Screens = (function () {
  const $ = (id) => document.getElementById(id);
  const dlg = $('screensDialog');
  let list = [];
  let manage = false;
  let holding = '';
  let holdingChoice = null;     // the manager's pick in the holding list, not saved yet ("Use it"): kept across refreshes
  let pending = null;           // a message or file offered from the feed, waiting for "Show"
  const ticked = new Set();
  const refused = new Map();    // screen id -> why the last take did not reach it (its row says so until the next take)

  function load() {
    socket.emit('display:list', { code: ROOM }, (r) => {
      if (!r || !r.ok) return;
      const first = !CAN_SCREENS;
      CAN_SCREENS = true;
      $('screensBtn').hidden = false;
      list = r.displays; manage = r.manage; holding = r.holding || '';
      if (first) for (const d of list) ticked.add(d.id);
      // The screens this page may drive are a fact of the catalogue: ⧉ on a message, and each screen's own acts.
      factsChanged({ screens: { manage: !!r.manage, displays: list } });
      render();
    });
  }

  function render() {
    const ul = $('screenList');
    ul.textContent = '';
    $('screensEmpty').hidden = list.length > 0;
    $('screensManage').hidden = !manage;
    for (const d of list) {
      const li = document.createElement('li');
      li.className = 'screen-item';
      li.dataset.state = d.state;
      li.dataset.screenId = d.id;
      li.dataset.key = d.id;
      const pick = document.createElement('input');
      pick.type = 'checkbox'; pick.checked = ticked.has(d.id); pick.setAttribute('aria-label', 'Show on ' + d.name);
      pick.onchange = () => { if (pick.checked) ticked.add(d.id); else ticked.delete(d.id); syncAll(); };
      const name = document.createElement('strong'); name.textContent = d.name;
      const st = document.createElement('span'); st.className = 'screen-state'; st.textContent = d.mark + ' ' + d.words;
      const what = document.createElement('span'); what.className = 'screen-showing'; what.textContent = d.showing;
      const head = document.createElement('div'); head.className = 'screen-line';
      head.append(pick, name, st);
      if (refused.has(d.id)) { const no = document.createElement('span'); no.className = 'screen-refused'; no.textContent = '✕ the last take did not reach it: ' + refused.get(d.id); head.append(no); }
      // Identify on the row, and the rest of the screen's acts (the catalogue's kind `screen`) in its ⋯.
      const acts = document.createElement('div'); acts.className = 'screen-acts';
      drawBar(acts, 'screen', d, { words: true, more: 'More for ' + d.name });
      li.append(head, what, acts);
      ul.appendChild(li);
    }
    const pickH = $('holdingPick');
    const want = holdingChoice !== null ? holdingChoice : holding;
    pickH.length = 1;
    const images = allMessages.filter((m) => m.type === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(m.mime || ''));
    for (const m of images) { const o = document.createElement('option'); o.value = m.url; o.textContent = m.filename; pickH.appendChild(o); }
    pickH.value = want;
    if (pickH.value !== want) { pickH.value = holding; holdingChoice = null; }   // the picked image is gone from the hall
    const cur = images.find((m) => m.url === holding);
    $('holdingName').textContent = holding ? (cur ? cur.filename : 'an image') : 'none';
    syncAll();
    renderPending();
    if ((openOn && openOn.kind === 'screen') || (askOn && askOn.kind === 'screen')) refreshOpenMenu();
  }
  function syncAll() { $('screensAll').checked = list.length > 0 && list.every((d) => ticked.has(d.id)); }
  function done(words) { return (r) => AGM.toast(r && r.ok ? words : (r && r.error) || 'Not changed.', !(r && r.ok)); }
  const copy = (text, anchor) => copyText(text, 'Link copied.', anchor);
  /** The screens' rows drawn again with the page's facts (its connection, its rights), while the dialog shows them. */
  function redraw() { if (list.length) render(); }

  // A screen's doors: its row's Identify and ⋯, right-click and Shift+F10 on the row (inside the dialog, where the menu
  // and its asks are mounted, so the dialog stays open under them).
  const screenOf = (id) => list.find((d) => d.id === id) || null;
  function screenDoor(t) {
    const li = t.closest('.screen-item[data-screen-id]');
    if (!li) return null;
    const more = li.querySelector('.obj-more');
    const id = li.dataset.screenId;
    return { el: li, more, id, open: (at) => openObjectMenu('screen', () => screenOf(id), { node: li, more, at, opener: li.contains(document.activeElement) ? document.activeElement : more, label: 'Screen actions', header: (d) => d.name + ' · ' + d.words }) };
  }
  $('screenList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="screen."], [data-more]');
    const door = el && screenDoor(el);
    if (!door) return;
    e.preventDefault();
    if (el.dataset.more) {
      if (openOn && openOn.kind === 'screen' && openOn.id === door.id) { AGM.menu.close(); return; }
      openObjectMenu('screen', () => screenOf(door.id), { node: door.el, more: el, opener: el, label: 'Screen actions', header: (d) => d.name + ' · ' + d.words });
      return;
    }
    const d = screenOf(door.id);
    if (d) act('screen', el.dataset.action, d, { anchor: door.more || el, node: door.el, opener: el });
  });
  AGM.menu.door($('screenList'), screenDoor);
  AGM.roving($('screenList'), { item: 'li[data-key]' });
  Object.assign(RUN, {
    'screen.identify': (d) => AGM.outbox.now('display:identify', { id: d.id }, (r) => AGM.toast(r && r.ok ? (r.screens ? 'Showing its name on ' + (r.screens > 1 ? 'its ' + r.screens + ' screens' : 'the screen') + ' for 6 seconds.' : 'No screen has this link open.') : (r && r.error) || 'Not sent.', !(r && r.ok))),
    'screen.only': (d) => { ticked.clear(); ticked.add(d.id); render(); },
    'screen.copy': (d, { anchor }) => copy(location.origin + d.path, anchor),
    'screen.open': (d) => { window.open(d.path, '_blank', 'noopener,noreferrer'); },
    'screen.rename': (d, { values }) => {
      const name = values && values.name ? values.name.trim() : '';
      if (name && name !== d.name) AGM.outbox.now('display:update', { id: d.id, name }, done('Renamed.'));
    },
    'screen.rotate': (d, { anchor }) => AGM.outbox.now('display:rotate', { id: d.id }, (r) => {
      if (r && r.ok) { copyText(location.origin + r.path, 'New link copied — open it on the screen.', anchor); } else AGM.toast((r && r.error) || 'Not changed.', true);
    }),
    'screen.remove': (d) => AGM.outbox.now('display:remove', { id: d.id }, done('Removed.')),
  });

  /**
   * Put a content on every ticked screen, in one request however many are ticked; say how many took it (each confirms on
   * its own line when it has shown it) and name the ones it did not reach.
   */
  function take(content, noneTicked) {
    const ids = list.filter((d) => ticked.has(d.id)).map((d) => d.id);
    if (!ids.length) { AGM.toast(noneTicked || 'Tick at least one screen.', true); return; }
    const names = new Map(list.map((d) => [d.id, d.name]));   // as ticked, though the list may be re-read meanwhile
    AGM.outbox.now('display:take', { ids, content }, (r) => {
      const results = r && Array.isArray(r.results) ? r.results : [];
      if (!results.length) { AGM.toast((r && r.error) || 'Not sent.', true); return; }
      refused.clear();
      for (const x of results) if (!x.ok) refused.set(x.id, x.error || 'not sent');
      const sent = results.length - refused.size;
      if (!refused.size) AGM.toast('Sent to ' + sent + ' screen' + (sent === 1 ? '' : 's') + ' — each shows ✓ once it is on screen.');
      else AGM.toast('Sent to ' + sent + ' of ' + results.length + ' screens. Not to ' + Array.from(refused.keys(), (id) => names.get(id) || id).join(', ') + ': ' + refused.values().next().value, true);
      render();
    });
  }

  // The dialog opens with the saved holding image picked, whether Screens or ⧉ opens it: an unsaved pick lives only as
  // long as the opening it was made in (cleared here, not on "close", which a hidden tab's browser may hold back).
  function open() {
    if (dlg.open) return;
    holdingChoice = null;
    AGM.openDialog(dlg);
  }
  function offer(msg) {
    pending = msg;
    if (msg.type === 'text') { $('screenMsgText').value = msg.text.slice(0, 300); pending = null; }
    else $('pendingPage').value = '1';   // each file offered starts on its first page
    open();
    render();
    if (!pending) $('screenMsgText').focus();
  }
  function renderPending() {
    $('screensPending').hidden = !pending;
    if (!pending) return;
    const pdf = pending.mime === 'application/pdf';
    $('pendingWords').textContent = 'Show “' + pending.filename + '”';
    $('pendingPageWrap').hidden = !pdf;
  }

  $('screensBtn').addEventListener('click', () => { open(); load(); });
  $('screensClose').addEventListener('click', () => dlg.close());
  $('screensAll').addEventListener('change', () => { ticked.clear(); if ($('screensAll').checked) for (const d of list) ticked.add(d.id); render(); });
  for (const b of document.querySelectorAll('.screens-bar [data-take]')) b.addEventListener('click', () => take({ kind: b.dataset.take }));
  $('screenMsgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('screenMsgText').value.trim();
    const tone = $('screenMsgTone').value;
    if ($('screenMsgUnder').checked) take({ kind: 'countdown', text, tone });
    else if (!text) AGM.toast('Type the message first.', true);
    else take({ kind: 'message', text, tone });
  });
  $('pendingShow').addEventListener('click', () => {
    if (!pending) return;
    take({ kind: 'file', url: pending.url, name: pending.filename, page: Math.max(1, parseInt($('pendingPage').value, 10) || 1) });
    pending = null; renderPending();
  });
  $('pendingCancel').addEventListener('click', () => { pending = null; renderPending(); });
  $('addScreenBtn').addEventListener('click', () => {
    const name = $('newScreenName').value.trim();
    if (!name) { AGM.toast('Name the screen first.', true); return; }
    AGM.outbox.now('display:create', { code: ROOM, name }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not added.', true); return; }
      $('newScreenName').value = '';
      ticked.add(r.display.id);
      copyText(location.origin + r.display.path, r.display.name + ' added — its link is copied: open it on that screen.', $('addScreenBtn'));
    });
  });
  $('holdingPick').addEventListener('change', () => { holdingChoice = $('holdingPick').value === holding ? null : $('holdingPick').value; });
  $('holdingSave').addEventListener('click', () => {
    const image = $('holdingPick').value;
    AGM.outbox.now('display:hallHolding', { code: ROOM, image }, (r) => { if (r && r.ok) { holding = image; holdingChoice = null; } done('Holding image saved.')(r); });
  });
  socket.on('displays:changed', ({ code } = {}) => { if (code === ROOM && CAN_SCREENS) load(); });
  // The countdown on the ticked screens (every screen, until a person unticks one in Screens): the stage chip's act.
  const countdown = () => take({ kind: 'countdown' }, 'No screen is ticked in Screens: tick the ones for the countdown there.');
  return { load, offer, redraw, of: screenOf, countdown };
})();

// ---------------- Send to Stagewatch: where a message goes — sent now (the speaker's screen), or asked of the operator ----------------
const ToStagewatch = (function () {
  const $ = (id) => document.getElementById(id);
  const dlg = $('swDialog');
  let source = null;
  let caps = { canSend: false, canPropose: false };
  function sync() {
    const dest = $('swDest').value;
    const speaker = dest === 'speaker';
    $('swUrgWrap').hidden = !speaker;
    $('swNow').hidden = !(speaker && caps.canSend);
    $('swPropose').hidden = !caps.canPropose;
    $('swHow').textContent = !caps.canPropose && !speaker ? 'This Stagewatch keeps no show desk, so only the speaker\'s screen can be sent to directly.'
      : caps.canPropose ? 'Ask the operator: the show caller approves it in Stagewatch\'s Copilot, and its state shows on the message.' + (speaker && caps.canSend ? ' Send now puts it on the speaker\'s screen at once.' : '')
      : 'Send now puts it on the speaker\'s screen at once; their acknowledgement shows on the message.';
  }
  function open(msg) {
    source = msg;
    // At most 500 UTF-16 units (the box's maxlength, and Stagewatch's cut), never half an emoji.
    const said = msg ? msg.text || '' : '';
    $('swText').value = said.slice(0, said.length > 500 && /[\uD800-\uDBFF]/.test(said.charAt(499)) ? 499 : 500);
    $('swError').hidden = true;
    socket.emit('stage:targets', {}, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Stagewatch is not linked to this hall.', true); return; }
      caps = r;
      $('swWhich').textContent = r.linked ? 'To ' + (r.title || 'this hall\'s Stagewatch') + '.'
        : r.cert ? 'Stagewatch\'s certificate changed — nothing can be sent until an admin accepts it (Halls → Set up, or Admin → Show network).'
        : r.key === 'refused' ? 'Stagewatch refused this AGMessage\'s key — nothing can be sent until an admin enters a node key it lists (Halls → Set up).'
        : r.key === 'checking' ? 'Stagewatch has not accepted this AGMessage\'s key yet — nothing is queued; try again in a moment.'
        : 'Stagewatch is not connected right now — nothing is queued; try again when it is.';
      const sel = $('swDest');
      sel.textContent = '';
      for (const t of r.targets) {
        if (!r.canPropose && !(t.direct && r.canSend)) continue;
        const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o);
      }
      sync();
      AGM.openDialog(dlg);
    });
  }
  const fail = (text) => { $('swError').textContent = text; $('swError').hidden = false; };
  $('swDest').addEventListener('change', sync);
  $('swNow').addEventListener('click', () => {
    AGM.outbox.now('stage:send', { text: $('swText').value.trim(), urgency: $('swUrg').value, messageId: source && source.text === $('swText').value.trim() ? source.id : undefined }, (res) => {
      if (!res || !res.ok) return fail((res && res.error) || 'Not sent.');
      dlg.close();
      AGM.toast(res.stage === 'applied' ? 'On the speaker\'s screen — their acknowledgement shows on the message.' : 'Stagewatch took it — the speaker\'s acknowledgement shows on the message.');
    });
  });
  $('swForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const text = $('swText').value.trim();
    AGM.outbox.now('stage:propose', { text, destination: $('swDest').value, urgency: $('swUrg').value, messageId: source && source.text === text ? source.id : undefined }, (res) => {
      if (!res || !res.ok) return fail((res && res.error) || 'Not sent.');
      dlg.close();
      AGM.toast('Asked — the show caller approves it in Stagewatch; its state shows on the message.');
    });
  });
  return { open };
})();
