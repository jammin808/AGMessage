// AGMessage client.

// Below the page floor (theme-init.js) the hall page shows the floor's words and nothing else: this script ends here,
// before it draws anything or opens a socket. A classic script's top level has no return, so it ends by throwing.
if (document.documentElement.dataset.floor === 'old') throw new Error('This browser is below AGMessage\'s page floor: the hall page does not run here.');

const qs = new URLSearchParams(location.search);
// A signed-in account opens a hall with ?code=…&as=account (its name and rights come from the server); anyone else
// with ?code=…&name=…&role=… from the join page.
const AS_ACCOUNT = qs.get('as') === 'account';
/**
 * A guest's code and invite are credentials: once a join takes them, they leave the address (and the history of a
 * venue's shared tablet) and stay in this tab alone (sessionStorage), for its own rejoins and reloads. A page opened with
 * a code in its address reads that code (and that link's invite) and none kept.
 */
const JOIN_KEPT = 'agm.join';
const keptJoin = (() => {
  if (AS_ACCOUNT || qs.get('code')) return null;
  try { const v = JSON.parse(sessionStorage.getItem(JOIN_KEPT) || 'null'); return v && typeof v.code === 'string' ? v : null; } catch { return null; }   // storage blocked or not JSON: nothing kept
})();
const ROOM = (qs.get('code') || (keptJoin ? keptJoin.code : '')).toUpperCase();
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
const INVITE = qs.get('invite') || (keptJoin && typeof keptJoin.invite === 'string' ? keptJoin.invite : '');
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
/**
 * Whether this device opens documents (plan 4-§5.15.2), sent at each join as `docs: true` and only then: it makes a
 * `DecompressionStream('deflate-raw')`, which came with pdf.js's legacy build's floor (Safari 16.4, Chrome 103) and which
 * the document worker inflates Office files with, inside try; and no import of pdf.js failed on it this session (NO_DOCS,
 * kept in this tab). No user agent is read and no syntax is probed (the page's policy has no 'unsafe-eval'). A page that
 * cannot draws a document's stand-in in its place, or says it cannot open documents.
 */
const NO_DOCS = 'agm.noDocs';
let DOCS = (() => {
  try { if (sessionStorage.getItem(NO_DOCS) === '1') return false; } catch { /* storage blocked: the probe alone decides */ }
  try { return typeof DecompressionStream === 'function' && !!new DecompressionStream('deflate-raw'); } catch { return false; }
})();
// Whether this device can show a take full screen (the Fullscreen API: an iPhone has none), read once here and sent nowhere.
const FULLSCREEN = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && (typeof document.documentElement.requestFullscreen === 'function' || typeof document.documentElement.webkitRequestFullscreen === 'function');
// The chat view this page draws (`view`: the join's, then each `view` the server tells it), and in the simple view what
// waits for this person's answer (`waiting`), the message they tapped (`tapped`, its second door) and the question whose
// answers they brought back to change (`changing`): the simple view's facts, the page's own (Simple, below).
const pageFacts = { role: ROLE, uid: '', account: null, uploadToken: '', canSendToStage: false, canPropose: false, ai: false, stage: null, forwardable: false, sends: false, targets: [], adminView: ADMIN_VIEW, name: NAME, screens: null, connected: false, guestCode: '', codeOn: false, setsCode: false, admin: false, canPush: false, canWeb: false, canShow: false, fullscreen: FULLSCREEN, docs: DOCS, view: 'full', waiting: null, tapped: '', changing: '', pins: [] };
let F = AGM.catalog.facts(pageFacts);
// Whether this page's room is its hall's Main room (the join's `main`; a hall until it answers): its seat words follow it
// (roleLabel).
let MAIN = true;
// The room's hall as the server tells this page (the join's `hallName`, `rooms`, and each `rooms:changed`): its name, for
// the header's title ("Hall 2 › Legal"), and the rooms of it this person may move between, the switcher's.
let HALL_NAME = '';
let ROOMS = [];
// The hall's key, as this page names its hall to the hall's console (its screens, its people's pages): the join's `hall`
// for one who sees the hall, else this room's own name for it where it is the Main room (a guest's code: the server reads
// the code a page joined with as its hall); '' where the page may name none.
let HALL_KEY = '';
// Where the composer's next message or file goes (To:): '' for this room, else the reference of a room this room may send
// into (the catalogue's compose.sendTo). It goes back to this room after every send.
let sendTo = '';
const RUN = {};
/** A status's words after its mark: every mark this page draws is one of AGM.MARKS (common.js), never one of its own. */
const marked = (name, words) => AGM.mark(name) + ' ' + words;

// ---------------- UI sync state (declared early to avoid TDZ traps) ----------------
// These are accessed by pushUserState / setStageCollapsed / setZoom / applyTheme,
// some of which run during boot (e.g. setStageCollapsed(true) when the user had
// the stage collapsed last session). Declaring them at the top guarantees they
// are out of TDZ before any boot-time call hits them. See CLAUDE.md gotcha #8.
const _pendingStates = [];
let _applyingRemote = false;

if (!ROOM || (!NAME && !AS_ACCOUNT)) location.href = '/';

document.body.dataset.role = ROLE;
// The room's guest code is the server's to tell this page (the join's answer, and each change of it), and none until then:
// the address's code is how the page names its room (an account's, its key), not a code it is told. The header's ⋯ copies it.
document.getElementById('whoami').textContent = AS_ACCOUNT ? '' : `${NAME} · ${roleLabel(ROLE)}`;
document.querySelectorAll('a[href="/"].btn').forEach((a) => { a.href = HOME; if (AS_ACCOUNT) a.textContent = 'All halls'; });

// ---------------- Theme (dark mode): the header's ⋯, Dark theme ----------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
}
// The theme the person chose on this browser, or '' where none was (or storage cannot be read): the full view then draws
// light and the simple view dark (Simple.setView), as theme-init.js painted it from the view this page last drew.
function chosenTheme() {
  try { const t = localStorage.getItem('agm.theme'); return t === 'light' || t === 'dark' ? t : ''; } catch { return ''; }
}
applyTheme(chosenTheme() || document.documentElement.dataset.theme || 'light');
/** Dark theme on or off, kept for this browser and handed to this person's other pages. */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('agm.theme', next); } catch { /* storage blocked: this page only */ }
  applyTheme(next);
  if (!_applyingRemote) pushUserState('theme', next);
}

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



/**
 * The composer this page draws: none for a seat that only reads; the On stage composer (🔥 Priority, the words, Send) On
 * stage, and for any seat in the simple view, whose composer it is; the backstage team's tabs otherwise. It follows the
 * chat view as it changes, live (Simple.setView).
 */
function drawComposerSeat() {
  const reads = readOnly();
  const simple = F.view === 'simple';
  document.getElementById('directorCompose').hidden = reads || !(ROLE === 'board' || simple);
  document.getElementById('researchCompose').hidden = reads || ROLE !== 'research' || simple;
}
drawComposerSeat();

// ---------------- Socket ----------------
// The socket comes back by itself (reconnect.js): after a refusal at the server's pace, after a drop, and at once when the
// page is shown again or the browser is back online. The page is back once its join is answered: the strip says
// "Reconnecting…" after 2 s without it, the dot's words after 5 s, and both go at the answer.
const socket = io({ transports: ['websocket', 'polling'], auth: AGM.reconnect.auth(), ...AGM.reconnect.OPTIONS });
const connChip = document.getElementById('connChip');
const connDot = document.getElementById('connDot');
const connWords = document.getElementById('connWords');
const connection = AGM.reconnect.attach(socket, { join: true, down: true, strip: document.getElementById('connStrip'), onChange: drawConnection });
/**
 * The connection's chip: its mark (✓ back in the hall; ◷ connecting, or down less than 5 s; ✕ down 5 s or more, or not
 * coming back), its name for a screen reader (what is true now), and its words once the page has been down 5 s.
 */
function drawConnection(st) {
  const name = AGM.reconnect.dotName(st);
  AGM.chip(connChip, st.back ? 'ok' : st.stopped || st.dot ? 'fault' : 'waiting');
  connDot.classList.toggle('ok', st.back);
  connDot.setAttribute('aria-label', name);
  connDot.title = name;
  connWords.hidden = !st.dot;
  // Down 5 s or more: the simple view on a phone says it on a second row of the header (styles.css).
  document.body.dataset.down = st.dot ? '1' : '0';
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
  socket.emit('join', { roomCode: ROOM, adminView: ADMIN_VIEW, ...(VIEW_OF ? { viewOf: VIEW_OF } : {}), since: joined ? lastSeq : undefined, ...who, ...(DOCS ? { docs: true } : {}) }, (res) => {
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
    // A guest's code and invite leave the address once the join took them, kept for this tab's own rejoins.
    if (!AS_ACCOUNT && !ADMIN_VIEW) keepJoin();
    // A side room's backstage seat is a Member's: its seat words follow the room's kind before anything is drawn with them.
    MAIN = res.main !== false;
    // Who this is, before the switcher is drawn: what this person has read of each room is kept by room and person.
    MY_UID = res.uid || MY_UID;
    hallTold(res);
    if (res.account) {
      NAME = res.account.name;
      document.getElementById('whoami').textContent = `${res.account.name} · ${res.account.roleLabel}`;
    } else if (!AS_ACCOUNT) document.getElementById('whoami').textContent = `${NAME} · ${roleLabel(res.role || ROLE)}`;
    if (res.identity) { IDENTITY = res.identity; try { localStorage.setItem('agm.id', IDENTITY); } catch { /* private mode: identity lives for this tab only */ } }
    UPLOAD_TOKEN = res.uploadToken || '';
    CAN_STAGE = !!res.canSendToStage;
    CAN_PROPOSE = !!res.canPropose;
    STAGE_KEY = stageKey(res.stage);
    AI_ON = !!res.ai;
    HALL_KEY = typeof res.hall === 'string' && res.hall ? res.hall : MAIN ? ROOM : '';
    // The catalogue's facts from this answer, before anything is drawn with them; `connected` once the outbox is ready.
    // The admin's support view draws the doors of the person it shows (their seat, what they may send and push: the
    // answer's `person`), every one disabled.
    const them = ADMIN_VIEW && res.person && typeof res.person === 'object' ? res.person : null;
    factsChanged({ role: (them && them.role) || res.role || ROLE, uid: MY_UID, account: res.account || null, uploadToken: UPLOAD_TOKEN, canSendToStage: CAN_STAGE, canPropose: CAN_PROPOSE, ai: AI_ON, stage: res.stage || null,
      forwardable: them ? them.forwardable === true : !!res.forwardable, name: NAME,
      guestCode: typeof res.guestCode === 'string' ? res.guestCode : '', codeOn: !!res.codeOn, setsCode: !!res.setsCode, sends: them ? them.sends === true : !!res.sends, ...((them ? them.sends : res.sends) ? {} : { targets: [] }), admin: res.admin === true,
      canPush: them ? them.canPush === true : res.canPush === true, canWeb: them ? them.canWeb === true : res.canWeb === true, canShow: them ? them.canShow === true : res.canShow === true,
      theAdmin: res.theAdmin === true, pins: Array.isArray(res.pins) ? res.pins : [], onStage: res.onStage || null });
    // The admin's clock or countdown for this person, and AGMessage's clock and zone, before the view draws it.
    Clock.joined(res);
    // The chat view, before a message is drawn with it: the support view draws the person's.
    Simple.setView(them ? them.view : res.view);
    drawChips();
    drawAiButtons();
    if (res.note) AGM.toast(res.note);
    if (res.role && res.role !== ROLE) { document.body.dataset.role = res.role; }
    drawComposerSeat();
    drawSkip();
    // The panel says whose it is: the Board's 📺 On stage, or the backstage team's 👁 Preview; and, in a side room (no
    // Board there), the composer whom a message reaches.
    if (!previewing) drawPanelWords();
    textInput.placeholder = MAIN === false ? 'Type a message to ' + (ROOM_NAME || 'this room') + '…' : 'Type a message to the Board…';
    // What this person wrote here and had not sent when they moved to another room of the hall, back in its composer.
    if (!joined) takeDraft();
    drawComposers();
    renderStage(res.stage);
    document.getElementById('helpBtn').hidden = (res.role || ROLE) === 'observer';
    if ((AS_ACCOUNT || ADMIN_VIEW) && HALL_KEY) Screens.load();
    // What this page is shown over its chat now (drawn without animation, and said again: this socket has said nothing
    // yet), and the console's read of the hall's people's pages for a page that may change them.
    Takes.joined(res);
    Console.read();
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
      renderHistory(res);
    }
    lastSeq = Math.max(lastSeq, res.seq || 0);
    // This person's pins as the join tells them, on what it drew and what it held already (a page back from a drop).
    drawAllPins();
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
 * This device passed the documents' probe yet could not import pdf.js (plan 4-§5.15.2): from now on, for the rest of this
 * tab's session, it opens no document, draws a document's stand-in in its place, and joins without `docs`; it joins again
 * now, on its own socket, so the server counts it and its pushers' consoles offer a picture.
 */
function noDocs() {
  if (!DOCS) return;
  DOCS = false;
  try { sessionStorage.setItem(NO_DOCS, '1'); } catch { /* storage blocked: this page's own run remembers it */ }
  factsChanged({ docs: false });
  if (joined && socket.connected) rejoin();
}
/**
 * A guest's code and invite, taken by the join, kept in this tab (sessionStorage) and taken out of the address and its
 * history entry (history.replaceState): a reload in this tab rejoins with them, and the shared tablet's history holds
 * neither. Where storage is blocked the address keeps them, so a reload still rejoins.
 */
function keepJoin() {
  if (!qs.get('code') && !qs.get('invite')) return;
  try { sessionStorage.setItem(JOIN_KEPT, JSON.stringify({ code: ROOM, invite: INVITE })); } catch { return; }   // storage blocked: the address keeps them
  const q = new URLSearchParams(location.search);
  q.delete('code');
  q.delete('invite');
  const rest = q.toString();
  history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
}
/**
 * On another build than its server's, this page reloads itself (reconnect.js) at a quiet moment: connected and in its
 * hall, nothing written and not sent (the outbox holding nothing and waiting on no act's answer, every composer empty, no
 * file chosen), no dialog, menu or ask open, no document on its stage, and untouched for a few seconds (or not shown).
 */
const COMPOSER_FIELDS = ['directorInput', 'textInput', 'actionText', 'actionOptionInput'];
function hallQuiet(t) {
  return AGM.reconnect.QUIET.hall({
    ...t, online: AGM.outbox.online, out: outOf, held: AGM.outbox.items().length > 0 || AGM.outbox.acting() > 0, document: previewing !== null,
    draft: !!pendingFile || COMPOSER_FIELDS.some((id) => { const el = document.getElementById(id); return !!el && el.value.trim() !== ''; }),
    dialog: !!document.querySelector('dialog[open]') || AGM.menu.isOpen() || AGM.ask.isOpen(),
  });
}
AGM.reconnect.build.when(hallQuiet, { stays: (words) => AGM.toast(words) });
// Down: an act on something is refused at once (it would otherwise be sent late), and every door says so.
socket.on('disconnect', () => { factsChanged({ connected: false }); Clock.draw(); });

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
  for (const node of document.querySelectorAll('#pinnedList .msg[data-id], #bvPinQ .msg[data-id]')) { const m = records.get(node.dataset.id); if (m) drawActs(node, m); }
  drawDocActs();
  refreshDocPinnedList();
  Screens.redraw();
  drawPeopleActs();
  drawComposers();
  drawChips();
  Takes.redraw();
  Console.draw();
  Earlier.redraw();
  refreshOpenMenu();
  drawCleared();
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
 * everything else): the header's title, its menu's line, and the name of Send (the catalogue's compose.send), which says
 * where a message goes (its word "Send" first, the word a person sees on it). */
let ROOM_NAME = '';
function setRoomTitle(name) {
  if (!name) return;
  ROOM_NAME = name;
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
/** A change number as the server tells one, read by type: a whole number above 0, else 0 (none). */
const seqOf = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
/**
 * The rooms the server lists for this page, read by type: each by its key, name, whether it is Main, its seat, and what is
 * new there (`seq`, its newest message's change number, and `prioritySeq`, its newest priority one's; 0 for none).
 */
function roomsFrom(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && typeof r.key === 'string' && r.key.length > 0)
    .map((r) => ({ key: r.key, name: typeof r.name === 'string' ? r.name : '', main: r.main === true, seat: ['board', 'research', 'observer'].includes(r.seat) ? r.seat : 'observer',
      seq: seqOf(r.seq), prioritySeq: seqOf(r.prioritySeq) }));
}
/**
 * What this person has not read in the hall's other rooms, for a dot on the switcher (kind `room`'s Mark as read). The
 * server tells this page what is new in each room of it, as it stands: the join's and each `rooms:changed`'s `rooms[].seq`
 * and `prioritySeq` (its newest message's change number and its newest priority one's), and `rooms:activity` as a message
 * comes, is removed or the room is cleared (the same two numbers, at most two frames a window), each taken as the room's
 * news now, so a dot never stands for a message that has gone. What this person has read of a room is kept in this
 * browser (localStorage, by room and person): the newest change a page of theirs held there while it was shown (here, as
 * its seen receipt is), or Mark as read. A room with a message past it has a dot, 🔥 where a priority one is among them: a
 * dot, not a count, since a change number counts every change, not messages. A room never read in this browser has its
 * dot from its first message. Where this browser keeps nothing (storage blocked), this page holds what is read itself,
 * from what it was first told of each room: its dots are the news that came while it is open, and Mark as read says so.
 */
const Unread = (() => {
  const WORDS = Object.freeze({ news: 'new messages', priority: 'priority' });
  const PREFIX = 'agm.read|';
  /** Whether this browser keeps what is read: a private window or blocked site data refuses (or throws for) storage. */
  const KEEPS = (() => {
    try { localStorage.setItem('agm.readProbe', '1'); localStorage.removeItem('agm.readProbe'); return true; } catch { return false; /* storage blocked: this page holds what is read */ }
  })();
  /** What this page holds as read, by room, where the browser keeps nothing (or a save of it failed). */
  const held = new Map();
  /** Where this person's read of `room` is kept: an account's own page alone (a code page has no switcher). */
  const keyOf = (room) => (AS_ACCOUNT && !ADMIN_VIEW && MY_UID ? PREFIX + room + '|' + MY_UID : '');
  /** The newest change this person has read in `room`: as this browser keeps it, or as this page holds it; 0 for none. */
  function readOf(room) {
    const k = keyOf(room);
    if (!k) return 0;
    let kept = 0;
    if (KEEPS) { try { kept = seqOf(Number(localStorage.getItem(k))); } catch { /* storage blocked since: what this page holds */ } }
    return Math.max(kept, held.get(room) || 0);
  }
  /**
   * `seq` kept as read in `room`, when it is past what is read (or, `back`, whatever it is: Undo's): 'browser' where this
   * browser keeps it, 'page' where this page alone holds it (storage blocked or full), '' where nothing changed.
   */
  function keep(room, seq, back = false) {
    const k = keyOf(room);
    if (!k || (!back && seq <= readOf(room))) return '';
    if (KEEPS) {
      try {
        if (seq > 0) localStorage.setItem(k, String(seq)); else localStorage.removeItem(k);
        held.delete(room);
        return 'browser';
      } catch { /* storage blocked or full since: this page holds it */ }
    }
    held.set(room, seq);
    return 'page';
  }
  /** The rooms as the server told them: where this browser keeps nothing, a room first told is read up to its news now. */
  function told(rooms) {
    if (!KEEPS) for (const r of rooms) if (!held.has(r.key)) held.set(r.key, Math.max(r.seq, r.prioritySeq));
  }
  /** What a room of the switcher holds that this person has not read: 'priority', 'news', or '' (and '' where nothing is kept). */
  function of(r) {
    if (!keyOf(r.key)) return '';
    const read = readOf(r.key);
    return r.prioritySeq > read ? 'priority' : r.seq > read ? 'news' : '';
  }
  const redraw = () => { drawSwitcher(); refreshOpenMenu(); };
  /** This page's room is read up to the newest change it holds (while it is shown: reportSeen). */
  function here() { if (lastSeq > 0) keep(ROOM, lastSeq); }
  /** A change number as a frame tells one, read by type: a whole number, 0 or more, else null (the frame is not read). */
  const countOf = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
  /** A room of the hall's news changed (`rooms:activity`, read by type): its numbers are the room's now, and its dot follows. */
  function heard(a) {
    if (outOf || !a || typeof a !== 'object' || typeof a.key !== 'string') return;
    const r = ROOMS.find((x) => x.key === a.key);
    const seq = countOf(a.seq);
    const prioritySeq = countOf(a.prioritySeq);
    if (!r || r.key === ROOM || seq === null || prioritySeq === null) return;
    r.seq = seq;
    r.prioritySeq = prioritySeq;
    redraw();
  }
  /**
   * Mark as read: everything `room` holds now is read. `was`, what was read before, for Undo; `kept`, where it is kept
   * (keep's: 'browser', 'page', or '' where there was nothing new to mark).
   */
  function markRead(room) {
    const r = ROOMS.find((x) => x.key === room);
    const was = readOf(room);
    const kept = r ? keep(room, Math.max(r.seq, r.prioritySeq)) : '';
    redraw();
    return { was, kept };
  }
  /** Undo of Mark as read: what was read before it, kept again. */
  function restore(room, was) { keep(room, was, true); redraw(); }
  // Another page of this browser read a room (another tab, or this person's move): the dots follow at once.
  window.addEventListener('storage', (e) => { if (e.key === null || (typeof e.key === 'string' && e.key.startsWith(PREFIX))) redraw(); });
  return Object.freeze({ WORDS, told, of, here, heard, markRead, restore });
})();
/** What the server told this page of its hall (the join's answer, a `rooms:changed`): the header and the switcher follow. */
function hallTold(f) {
  if (typeof f.hallName === 'string') HALL_NAME = f.hallName;
  ROOMS = roomsFrom(f.rooms);
  Unread.told(ROOMS);
  drawTitle();
  drawSwitcher();
}
/** A room of the switcher as the catalogue reads it (kind room), by its key: this room's guest code where it is told it. */
function switcherObject(key) {
  const r = ROOMS.find((x) => x.key === key);
  if (!r || outOf) return null;
  const current = r.key === ROOM;
  return { id: 'room:' + r.key, key: r.key, name: r.main ? 'Main' : r.name || 'A room', hall: HALL_NAME || 'A hall with no name', title: titleOf(r.main, r.name),
    href: '/app.html?' + new URLSearchParams({ code: r.key, as: 'account', role: r.seat }).toString(), current, guestCode: current ? pageFacts.guestCode : '', hallKey: '',
    news: current ? '' : Unread.of(r) };
}
// The room a tap on the switcher is moving to, while this page goes ('' otherwise): its mark stays there as the dots change.
let movingKey = '';
/** The switcher, with two rooms or more: each a segment kept by its key, `current` marked (this room, or the one tapped). */
function drawSwitcher(current = movingKey || ROOM) {
  switcherEl.hidden = outOf || ROOMS.length < 2;
  const keep = new Map([...switcherEl.querySelectorAll(':scope > a[data-key]')].map((a) => [a.dataset.key, a]));
  ROOMS.forEach((r, i) => {
    let a = keep.get(r.key);
    keep.delete(r.key);
    if (!a) { a = document.createElement('a'); a.className = 'room-seg'; a.dataset.key = r.key; a.dataset.objectLink = '1'; }
    const o = switcherObject(r.key);
    if (!o) return;
    if (a.getAttribute('href') !== o.href) a.setAttribute('href', o.href);
    // Its name, and its dot where there is news this person has not read: the mark of a note, or 🔥 where a priority
    // message came, never its colour alone; the words say it (its accessible name, its tooltip), the room's name first.
    let nameEl = a.querySelector(':scope > .room-seg-name');
    let dot = a.querySelector(':scope > .room-dot');
    if (!nameEl) { a.textContent = ''; nameEl = document.createElement('span'); nameEl.className = 'room-seg-name'; dot = document.createElement('span'); dot.className = 'room-dot'; dot.setAttribute('aria-hidden', 'true'); a.append(nameEl, dot); }
    if (nameEl.textContent !== o.name) nameEl.textContent = o.name;
    const news = r.key === current ? '' : o.news;
    const glyph = news === 'priority' ? '🔥' : news ? AGM.mark('note') : '';
    if (dot.textContent !== glyph) dot.textContent = glyph;
    dot.hidden = !glyph;
    if (news === 'news') dot.dataset.tone = AGM.MARKS.note.role; else delete dot.dataset.tone;
    a.dataset.news = news;
    const words = news ? o.name + ', ' + Unread.WORDS[news] : '';
    if (words) a.setAttribute('aria-label', words); else a.removeAttribute('aria-label');
    const tip = o.title + (news ? ' · ' + Unread.WORDS[news] : '');
    if (a.title !== tip) a.title = tip;
    if (r.key === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    if (switcherEl.children[i] !== a) switcherEl.insertBefore(a, switcherEl.children[i] || null);
  });
  for (const a of keep.values()) a.remove();
}
/** Moving to another room of the hall: this room's unsent words kept, the title and the mark the room's, before it opens. */
function movingTo(o) {
  keepDraft();
  movingKey = o.key;
  drawTitle(o.title);
  drawSwitcher();
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
  // What Mark as read did, said as it is: kept in this browser, held by this page alone (storage blocked), or nothing new
  // there to mark (another page read it first); Undo where something was marked.
  'room.markRead': (o) => {
    const { was, kept } = Unread.markRead(o.key);
    if (!kept) AGM.toast('Nothing new in ' + o.title + ' to mark as read.');
    else AGM.toast(kept === 'page' ? 'Marked ' + o.title + ' as read on this page alone: this browser keeps nothing (its storage is blocked).' : 'Marked ' + o.title + ' as read.', { undo: () => Unread.restore(o.key, was) });
  },
  'room.open': (o) => { movingTo(o); location.assign(o.href); },
  'room.tab': (o) => { window.open(o.href, '_blank', 'noopener'); },
  'room.copy': (o, { anchor }) => copyText(new URL(o.href, location.href).href, 'Copied the link to ' + o.title + '.', anchor),
  'room.code': (o, { anchor }) => copyText(o.guestCode, 'Copied the guest code of ' + o.title + ', ' + o.guestCode + '.', anchor),
});
socket.on('rooms:changed', (f) => { if (f && typeof f === 'object' && !outOf) { hallTold(f); refreshOpenMenu(); } });
socket.on('rooms:activity', (a) => Unread.heard(a));
// Whether a web page shown from this page would be taken now (a code guest's: the admin let its hall's backstage guests
// show web pages, or stopped them, or the hall was unlocked): Show a web page… comes or goes on the Board chip and a person.
socket.on('pages:rights', (r) => { if (r && typeof r.canWeb === 'boolean' && !ADMIN_VIEW) factsChanged({ canWeb: r.canWeb }); });
// A page the browser kept and shows again (Back, from its cache) draws its own room again, not the one it was left for,
// and holds its words itself: what was kept of them for its next load is let go, so a send from here never comes back.
window.addEventListener('pageshow', (e) => { if (e.persisted) { movingKey = ''; drawTitle(); drawSwitcher(); dropDraft(); } });

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
  also: ['alsoUpdate', setAlso],
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
  for (const id of ['helpBtn', 'headerMore', 'skipLink']) document.getElementById(id).hidden = true;
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
  Clock.draw();
  Takes.stage(v || null);
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
    case 'pending': return marked('waiting', 'Waiting for the show desk to approve' + (p.to ? ' — for ' + p.to : ''));
    case 'approved': return marked('ok', 'Approved' + by + ' — running');
    case 'rejected': return marked('fault', 'Not approved' + by);
    case 'done': return marked('ok', 'Approved' + by + ' and done' + (p.words ? ': ' + p.words : ''));
    case 'failed': return marked('couldNot', 'Approved' + by + ' but it failed' + (p.words ? ': ' + p.words : ''));
    case 'undelivered': return marked('couldNot', 'Approved' + by + ' but not delivered' + (p.words ? ': ' + p.words : ''));
    case 'unknown': return marked('couldNot', 'Stagewatch\'s answer about this request is not one AGMessage can read — see the show desk' + (p.words ? ' (' + p.words + ')' : ''));
    case 'lost': return marked('couldNot', p.words || 'Stagewatch no longer has this request — ask again if it is still wanted');
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
  // Its colour is its mark's role (common.js AGM.toned), as every line with a mark of the table draws it.
  AGM.toned(line, text);
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
  // Admin cleared the room. Wipe local state but stay joined; what this page holds for sending is still drawn. The room
  // has no earlier messages and no files now.
  Earlier.stop();
  feed.innerHTML = '';
  forgetPlace();
  messagesById.clear();
  allMessages.length = 0;
  roomFiles.clear();
  for (const node of echoes.values()) feed.appendChild(node);
  refreshPinned();
  refreshDocPinnedList();
  HelpChip.draw();
  if (typeof dismissDoc === 'function') dismissDoc();
  refreshOpenMenu();
  Simple.waits();
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
  if (st.ack === 'done') return marked('ok', 'Acknowledged on stage' + by);
  if (st.ack === 'seen') return marked('ok', 'Seen on stage' + by);
  if (st.ack === 'lost') return marked('fault', 'No longer followed: that Stagewatch restarted, or this hall now follows another — the speaker\'s acknowledgement cannot be read');
  if (st.ack === 'sent') return marked('waiting', st.receipt === 'applied' ? 'On the speaker\'s screen — waiting for them to acknowledge' : 'Stagewatch took it — waiting for the speaker');
  return st.receipt === 'applied' ? marked('ok', 'On the speaker\'s screen') : marked('waiting', 'Sent to Stagewatch (not confirmed on screen)');
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
  AGM.toned(line, text);
  line.dataset.ack = (stage && stage.ack) || '';
}
function setReactions(messageId, reactions) {
  const msg = findMessage(messageId);
  if (msg) msg.reactions = reactions;
  const node = messagesById.get(messageId);
  if (node) renderReactions(node, reactions);
  // Its pinned copy says the same, and so does its open menu (React ▸'s checks).
  if (isPinned(msg)) refreshPinned(messageId);
  if (openOn && openOn.kind === 'msg' && openOn.id === messageId) refreshOpenMenu();
  // A 👍 of this person's answers it (Got it): what waits is read again.
  Simple.waits();
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
  if (ADMIN_VIEW || document.visibilityState !== 'visible') return;
  // Shown, this room is read up to here: the other rooms' pages of this person drop its dot.
  Unread.here();
  if (lastSeq <= seenSent) return;
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
    const text = marked('ok', 'Seen by ') + (who.length <= 3 ? who.join(', ') : who.slice(0, 3).join(', ') + ' +' + (who.length - 3));
    if (line.textContent !== text) line.textContent = text;
  }
  // The simple view says it at the end of the message's own line: Sent, or Seen by the backstage seats that read it.
  for (const m of mine) { const node = messagesById.get(m.id); if (node) Simple.said(node, m); }
}

// ---------------- Stage (Stagewatch): the live timer, for everyone in the hall ----------------
/** The stage chip's object (catalog.js, kind `chip`): the link's last state that had a time, or null while it shows none. */
let stageNow = null;
/** Stagewatch's phases that are near the end or past it: the countdown's ▲ (soon), with its words saying which. */
const STAGE_SOON = ['warning', 'wrapup', 'overtime'];
/**
 * The countdown's chip: Stagewatch's time and title, and its state as a mark of the one table: none while the time is
 * live, ▲ near the end or past it, ◷ while Stagewatch has not accepted this AGMessage's key, ✕ with the last time known
 * (in muted ink, never faded) while the link is lost. Stagewatch's own colour is the chip's left edge, never the digits'
 * ink, so the digits keep their contrast whatever colour it sends.
 */
function renderStage(v) {
  const chip = document.getElementById('stageChip');
  if (!chip) return;
  if (!v || !v.text) { chip.hidden = true; stageNow = null; drawChips(); refreshOpenMenu(); return; }
  chip.hidden = false;
  const live = !v.stale && (v.status === 'connected' || v.status === 'viewing');
  const checking = v.status === 'checking key';
  const soon = live && STAGE_SOON.includes(v.phase);
  AGM.chip(chip, checking ? 'waiting' : !live ? 'fault' : soon ? 'soon' : '');
  // What the mark says, said to a screen reader before the time (the mark itself is aria-hidden).
  let said = chip.querySelector(':scope > .chip-said');
  if (!said) { said = document.createElement('span'); said.className = 'sr-only chip-said'; chip.querySelector(':scope > .chip-mark').after(said); }
  said.textContent = checking ? 'Waiting for Stagewatch to accept the key, ' : !live ? 'Link lost, last known ' : soon ? (v.phase === 'overtime' ? 'Over time ' : 'Near the end ') : '';
  document.getElementById('stageTime').textContent = v.text;
  document.getElementById('stageTitle').textContent = v.title || '';
  const edge = live && /^#[0-9A-Fa-f]{6}$/.test(v.color || '') && !/^#ffffff$/i.test(v.color) ? v.color : '';
  chip.style.borderLeftColor = edge;
  chip.classList.toggle('stale', !live);
  chip.title = (checking ? 'Stagewatch has not accepted this AGMessage\'s key yet: ' : live ? (v.phase === 'overtime' ? 'Over time — live from Stagewatch: ' : 'Live from Stagewatch: ') : 'Stagewatch link lost — last known: ') + (v.title || '') + (v.next ? ' · Next: ' + v.next : '') +
    (v.messageAck === 'done' ? ' · Speaker acknowledged the message' : '');
  stageNow = { id: 'stage', live, text: v.text, words: chip.title };
  drawChips();
  refreshOpenMenu();
}

// ---------------- The header: its ⋯ (kind `header`) and the countdown's chip (kind `chip`) ----------------
// The ⋯ opens the header's menu, and so do a right-click anywhere else on the header's row and Shift+F10 or the menu key
// on the ⋯: People, Screens, the text size, the theme, the room's guest code and the way out, set once and seldom looked
// at, so the row keeps the room's name, its status, Help and the ⋯ at every width. The countdown's chip, where this seat
// has acts on it, is a button that opens its own menu (a click, Enter or Space, a right-click, Shift+F10 or the menu key);
// without, it stays words, so nothing is drawn as a button that does nothing. The switcher's rooms keep their own menus,
// and Help its own ask.
const stageChipEl = document.getElementById('stageChip');
const headerMore = document.getElementById('headerMore');
const headerBar = document.querySelector('.app-bar');
/**
 * The header as the catalogue reads it: how many are in the room and whether the People panel is open, the text size, the
 * theme, the room's guest code as the server tells this page ('' for none) and whether it admits guests, the room as an
 * ask names it, and the way out (an account's halls, else the sign-in page); null out of the hall.
 */
function headerObject() {
  if (outOf) return null;
  return { id: 'header', people: people.length, peopleShown: !peoplePanel.hidden, zoom: currentZoom, dark: document.documentElement.dataset.theme === 'dark',
    code: pageFacts.guestCode, on: !!pageFacts.codeOn, hall: ROOM_NAME || 'this room', account: AS_ACCOUNT, away: HOME };
}
/** The header menu's line: the room, and who this is in it. */
const headerLine = () => [ROOM_NAME ? titleOf(MAIN, ROOM_NAME) : '', document.getElementById('whoami').textContent].filter(Boolean).join(' · ');
const openHeaderMenu = (at) => openObjectMenu('header', headerObject, { node: headerMore, more: headerMore, at, opener: headerMore, label: 'Room menu', header: headerLine });
function chipIsDoor(el, on) {
  if (on) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-haspopup', 'menu');
    if (!el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', 'false');
  } else for (const a of ['role', 'tabindex', 'aria-haspopup', 'aria-expanded']) el.removeAttribute(a);
}
/** The header as the page stands: the countdown's chip a door where this seat has acts on it; out of the hall, neither it nor the ⋯. */
function drawChips() {
  if (outOf) { stageChipEl.hidden = true; document.getElementById('boardChip').hidden = true; }
  headerMore.hidden = outOf;
  chipIsDoor(stageChipEl, !outOf && !!stageNow && AGM.catalog.items('chip', F, stageNow).length > 0);
}
const stageDoor = () => ({ el: stageChipEl, more: stageChipEl, open: (at) => openObjectMenu('chip', () => stageNow, { node: stageChipEl, more: stageChipEl, at, opener: stageChipEl, label: 'Countdown actions', header: (o) => o.words }) });
/** The door of what a right-click or Shift+F10 on the header meets: the countdown's chip that is a door, else the header's menu. */
function headerDoor(t) {
  if (outOf || F.view === 'simple' || !t.closest || t.closest('#roomSwitcher, #helpBtn, .agm-ask')) return null;
  if (t.closest('#stageChip') && stageChipEl.getAttribute('aria-haspopup') === 'menu') return stageDoor();
  if (t.closest('#boardChip')) return Console.chipDoor();
  return { el: headerBar, more: headerMore, open: (at) => openHeaderMenu(at) };
}
function onChip(e) {
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  if (stageChipEl.getAttribute('aria-haspopup') !== 'menu') return;
  e.preventDefault();
  if (openOn && openOn.node === stageChipEl) { AGM.menu.close(); return; }
  stageDoor().open({ anchor: stageChipEl });
}
stageChipEl.addEventListener('click', onChip);
stageChipEl.addEventListener('keydown', onChip);
headerMore.addEventListener('click', (e) => {
  e.preventDefault();
  // The simple view's ⋯ opens its sheet: no menu there (R7).
  if (F.view === 'simple') { Simple.sheet(); return; }
  if (openOn && openOn.kind === 'header') { AGM.menu.close(); return; }
  openHeaderMenu({ anchor: headerMore });
});
AGM.menu.door(document.querySelector('.app-header'), headerDoor);
Object.assign(RUN, {
  // Speaker's screen…: the line box, empty, to write a line and send it or ask the operator for it.
  'chip.speaker': () => ToStagewatch.open(null),
  'chip.screens': () => Screens.countdown(),
  'header.people': () => { peoplePanel.hidden = !peoplePanel.hidden; },
  'header.screens': () => Screens.show(),
  'header.size': (o, { value }) => { if (typeof value === 'number' && Number.isFinite(value)) setZoom(value); },
  'header.theme': () => toggleTheme(),
  'header.code': (o, { anchor }) => copyText(o.code, 'Copied the guest code, ' + o.code + '.', anchor),
  'header.copy': (o, { anchor }) => copyText(new URL('/?code=' + encodeURIComponent(o.code), location.href).href, 'Copied the join link: it opens the join page with this code.', anchor),
  // The admin switches the room's code and renews it from here, naming the room by its key (the address it opened);
  // what the room's pages are told comes back as each page's `guestCode` (below).
  'header.codeToggle': (o, c) => AGM.outbox.now('room:update', o.on ? { code: ROOM, codeOn: false, keepGuests: c.choice !== 'out' } : { code: ROOM, codeOn: true }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not changed.', true); return; }
    AGM.toast(r.codeOn ? 'The guest code is on: guests join with ' + o.code + '.'
      : Number.isInteger(r.sentOut) ? 'The guest code is off: ' + r.sentOut + (r.sentOut === 1 ? ' guest page was' : ' guest pages were') + ' sent out.'
        : 'The guest code is off: the guests in stay, and nobody new joins with it.');
  }),
  'header.newCode': () => AGM.outbox.now('room:update', { code: ROOM, newCode: true }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'No new code.', true); return; }
    AGM.toast('The new guest code is ' + r.guestCode + '.');
  }),
  // The way out: what this person wrote here and has not sent is kept for this tab, back in its composer when they come
  // back to this room, as a move to another room keeps it.
  'header.leave': (o) => { keepDraft(); location.href = o.away; },
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
const feedRoving = AGM.roving(feed, { item: '.msg[data-key]', start: 'last', skip: '[data-type="action"][data-pinned="1"], [data-type="action"][data-pinned-mine="1"]' });
const tpl = document.getElementById('msgTpl');
const messagesById = new Map();
// Every message this page holds, in the room's order: those drawn (messagesById) and those waiting to be drawn (`undrawn`,
// by id: a first open's and each earlier page's, drawn a chunk at a time above what is drawn, Earlier below). A record is
// held from the moment it comes, so a change heard while it waits reaches it, and it is drawn as it is then.
const allMessages = [];
const undrawn = new Map();
function findMessage(id) { return allMessages.find((m) => m.id === id); }
function isMine(msg) { return !!(msg.from && (MY_UID ? msg.from.uid === MY_UID : msg.from.name === NAME)); }
// Every file of the room by its message's id, held or not: the first open's index (`files`), then each file that comes and
// goes. What the page lists of the room's files (Holding's pictures) reads it, never only the messages it holds.
const roomFiles = new Map();
/**
 * A file of the index, read by type: its id, address, name and kind, and whether it is for download only; null for one
 * this page holds no link of (an observer's and a Viewer account's hold none).
 */
function fileEntry(f) {
  if (!f || typeof f.id !== 'string' || !f.id || typeof f.url !== 'string' || !f.url) return null;
  return { id: f.id, url: f.url, filename: typeof f.filename === 'string' ? f.filename : '', mime: typeof f.mime === 'string' ? f.mime : '', ...(f.transferOnly === true ? { transferOnly: true } : {}), ...(f.confidential === true ? { confidential: true } : {}) };
}
/** A file message heard (or held), into the room's files. */
function noteFile(msg) { const f = msg && msg.type === 'file' ? fileEntry(msg) : null; if (f) roomFiles.set(f.id, f); }

/**
 * A first open (a join that named no change it held, or one whose gap the server no longer holds): the room's newest
 * messages and what a page keeps in view from before them, the newest drawn at once and the rest above them as the page is
 * idle (Earlier.open), and the room's files. Nothing held before stays: a page drawn afresh.
 */
function renderHistory(res) {
  Earlier.stop();
  feed.innerHTML = '';
  forgetPlace();
  messagesById.clear();
  allMessages.length = 0;
  for (const node of echoes.values()) feed.appendChild(node);
  const history = (Array.isArray(res.history) ? res.history : []).filter((m) => m && typeof m.id === 'string');
  const older = (Array.isArray(res.older) ? res.older : []).filter((m) => m && typeof m.id === 'string');
  roomFiles.clear();
  // A server that sends no index (an older build's) has sent every message: its files are theirs.
  if (Array.isArray(res.files)) res.files.forEach((f) => { const e = fileEntry(f); if (e) roomFiles.set(e.id, e); });
  else older.concat(history).forEach(noteFile);
  Earlier.open(older, history, res.more === true);
  Simple.waits();
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
  if (!msg) return;
  // Held and waiting to be drawn: its newer record is the one drawn when its turn comes.
  if (undrawn.has(msg.id)) {
    const idx = allMessages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) allMessages[idx] = msg;
    undrawn.set(msg.id, msg);
    return;
  }
  if (messagesById.has(msg.id)) {
    const el = messagesById.get(msg.id);
    rerenderMessage(el, msg);
    const idx = allMessages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) allMessages[idx] = msg;
    if (msg.type === 'help') HelpChip.draw();
    Simple.waits();
    return;
  }
  allMessages.push(msg);
  noteFile(msg);
  drawAtEnd(msg, { silent, arrived });
}
/** A message held now drawn below everything the hall has drawn (what this page holds for sending stays below it). */
function drawAtEnd(msg, { arrived = false } = {}) {
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
    if (follow) toEnd();
    return;
  }
  const el = renderMessage(msg);
  feed.insertBefore(el, firstEcho);
  messagesById.set(msg.id, el);
  if (msg.type === 'help' && isMine(msg)) HelpChip.draw();
  if (arrived) keepPlace(el, msg, follow);
  if (arrived) Takes.heard(msg);
  if (isPinned(msg)) refreshPinned();
  // A file shared is a transfer (a download): it opens itself on nobody's panel. A person opens it with Look (Preview
  // backstage); what the backstage team shows the Board is a take, never a file in the chat.
  if (msg.type === 'file') refreshDocPinnedList();
  // What waits for this person's answer, read again (the simple view): a message, or a reply of theirs that answers one.
  Simple.waits();
}

function removeMessageLocal(id) {
  const node = messagesById.get(id);
  const idx = allMessages.findIndex((m) => m.id === id);
  // Where the earlier messages are read back from and drawn above moves on from a message that goes.
  if (idx >= 0) Earlier.removed(id, allMessages[idx + 1] || null, node || null);
  if (node) node.remove();
  tidyDivider();
  messagesById.delete(id);
  undrawn.delete(id);
  roomFiles.delete(id);
  if (idx >= 0) allMessages.splice(idx, 1);
  // Held or not, it has gone from the room: no reply's quote offers to read back to it.
  Earlier.goneFrom(id);
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === id) dismissDoc();
  HelpChip.draw();
  refreshOpenMenu();
  Simple.waits();
}

// ---------------- The room's earlier messages: a first open is bounded, and older ones come on request ----------------
/**
 * A page opens a room with its newest messages (the join's first open: `history`, the room's newest, and `older`, what a
 * page keeps in view from before them, every pinned message, help not resolved and every question not answered) and reads
 * further back a page at a time (history:before, the catalogue's earlier.show), from the oldest message of the newest run
 * it holds (`topId`): Show earlier at the top of that run while the server says there are earlier ones (`more`), and Show
 * it on a reply whose quoted message it does not hold, read back until that message is there and then gone to. A quote
 * whose message has gone from the room (the server's `replyTo.gone`, or a removal heard here) offers no Show it. A
 * message pinned since the page opened that it does not hold is read by its id (history:message) and held among the
 * older ones, so every pinned message is in view, as at a first open.
 *
 * The newest FIRST of a first open are drawn at once, the reader at the end; everything else is drawn above them a
 * chunk at a time as the page is idle (AGM.idle: each chunk stops when its 8 ms are spent), newest first and the
 * reader's place kept, so the feed a first open draws at once does not grow with the room and the page answers while
 * the rest is drawn (the pinned strip draws every pinned message it holds at once, drawn in the feed yet or not). A
 * record is held (allMessages, in the room's order) as it comes, before it is drawn, and an answer is held in the
 * callback that hears it, before any change heard after it, so a change to it heard meanwhile is in it when it is drawn;
 * a change to a message the page does not hold changes nothing drawn, and that message, read later, is the server's
 * record as it stands. The older messages a first open keeps in view are drawn above the run in the room's order, and
 * earlier messages read later take their places among them. Every placing is a step of the one queue, so what is drawn
 * above where is read in the order it was asked for. One read back at a time (a Show it asked during another read
 * follows it); a page drawn afresh (a first open again, the room cleared) ends whatever was being read or drawn.
 */
const Earlier = (function () {
  const FIRST = 60;
  const ASK_MS = 15000;
  const TRIES = 3;
  const UNREAD = 'Earlier messages could not be read now — try again in a moment.';
  const NOT_HERE = 'That message is not in this room any more.';
  let more = false;      // the server holds messages before the run that this page does not
  let topId = '';        // the oldest message of the run of the room's newest messages this page holds
  let steps = [];        // what is left to draw above, newest first: {id} a held record to draw, {at} where to draw next
  let anchor = null;     // the node the next record is drawn above (null: above what this page holds for sending)
  let task = null;       // the idle chunk asked for (its cancel)
  let reading = null;    // the read back under way (its promise)
  let readingFor = '';   // what it reads back to: '' a page (Show earlier), else the quoted message's id (Show it)
  let waiters = [];      // resolved once every step is drawn
  let era = 0;           // a page drawn afresh ends what an earlier era read or drew
  const gone = new Set();      // messages heard removed from the room in this era, held or not
  const fetching = new Set();  // messages kept in view being read by their id
  const gap = document.createElement('div');
  gap.className = 'feed-earlier';
  let button = null;
  /** The catalogue's object: the run's top (Show earlier), or a quoted message to read back to (Show it, `find`). */
  const object = (find) => ({ id: find ? 'earlier:' + find : 'earlier', more, find: find || '' });
  /** The first message this page holds for sending (drawn below everything the hall has), or null. */
  const firstEcho = () => { const e = echoes.size ? echoes.values().next().value : null; return e && e.parentNode === feed ? e : null; };
  /** A record held: this person's held send among them is let go by the outbox, as one heard live is. */
  const hold = (m) => {
    if (typeof m.cid === 'string' && m.from && MY_UID && m.from.uid === MY_UID) AGM.outbox.landed(m.cid);
    allMessages.push(m);
  };

  /** A first open: `older` and `history` held in the room's order, the newest FIRST drawn now and the rest as the page is idle. */
  function open(older, history, isMore) {
    more = isMore;
    topId = history.length ? history[0].id : '';
    const now = history.slice(-FIRST);
    const rest = older.concat(history.slice(0, history.length - now.length));
    for (const m of rest) { hold(m); undrawn.set(m.id, m); }
    for (const m of now) { hold(m); drawAtEnd(m, { silent: true }); }
    anchor = now.length ? messagesById.get(now[0].id) || null : null;
    steps = rest.map((m) => ({ id: m.id })).reverse();
    schedule();
  }

  /**
   * One step: a held record drawn above the anchor (a presence line folded into the one below it), or where the next is
   * drawn (`at`: above that drawn message, or '' above what this page holds for sending).
   */
  function drawStep(step) {
    if (Object.prototype.hasOwnProperty.call(step, 'at')) {
      const n = step.at ? messagesById.get(step.at) : null;
      if (!step.at) anchor = null; else if (n && n.parentNode === feed) anchor = n;
      return;
    }
    const m = undrawn.get(step.id);
    if (!m) return;   // removed while it waited
    undrawn.delete(step.id);
    const below = anchor && anchor.parentNode === feed ? anchor : firstEcho();
    if (m.type === 'system' && PRESENCE.test(m.text || '') && below && below.classList.contains('presence')) {
      const parts = [m.text].concat(below.dataset.parts ? below.dataset.parts.split('\u0001') : [below.textContent]).slice(-6);
      below.dataset.parts = parts.join('\u0001');
      below.textContent = parts.join(' · ');
      messagesById.set(m.id, below);
      return;
    }
    const el = renderMessage(m);
    feed.insertBefore(el, below);
    messagesById.set(m.id, el);
    anchor = el;
  }

  /** The next chunk asked of the idle page, or, with nothing left to draw, the run's top marked and whoever waited told. */
  function schedule() {
    if (task) return;
    if (!steps.length) {
      drawGap();
      requote();
      const w = waiters;
      waiters = [];
      w.forEach((r) => r());
      return;
    }
    const mine = era;
    task = AGM.idle((deadline) => {
      task = null;
      if (mine !== era) return;
      const run = () => { do drawStep(steps.shift()); while (steps.length && deadline.timeRemaining() > 0); };
      // The reader at the end stays there; anyone else keeps what they read where it was on the screen.
      if (place.atEnd) { run(); feed.scrollTop = feed.scrollHeight; } else holdView(run, gap);
      refreshPinned();
      refreshDocPinnedList();
      HelpChip.draw();
      refreshSeenLines();
      Simple.waits();
      schedule();
    });
  }
  /** Once every record held is drawn. */
  const drawn = () => new Promise((r) => { if (!steps.length && !task) r(); else waiters.push(r); });

  /** Where to read back from: the change number of the run's oldest message that has one, else after the newest change. */
  function cursor() {
    const at = topId ? allMessages.findIndex((m) => m.id === topId) : -1;
    if (at >= 0) for (let i = at; i < allMessages.length; i++) if (Number.isInteger(allMessages[i].seq) && allMessages[i].seq > 0) return allMessages[i].seq;
    return Math.max(1, lastSeq + 1);
  }
  /**
   * A read of the room (`send`, a plain emit handed its answer's callback): `heard` given its answer (null: none within
   * ASK_MS) in the callback that hears it, before any change heard after it, so what it holds is the record those changes
   * then reach; resolved with what it says.
   */
  function ask(send, heard) {
    return new Promise((resolve) => {
      let over = false;
      const timer = setTimeout(() => { over = true; resolve(heard(null)); }, ASK_MS);
      send((r) => { if (over) return; clearTimeout(timer); resolve(heard(r)); });
    });
  }
  /**
   * An earlier page, oldest first, held above the run in the room's order: a message held already (one kept in view) stays
   * where it is and the ones before it go above it. Its oldest is the run's top now. Whether the run reached back further
   * (`moved`), and how many messages it held that the page did not (`added`).
   */
  function merge(batch) {
    const list = batch.filter((m) => m && typeof m.id === 'string');
    const was = topId ? allMessages.findIndex((m) => m.id === topId) : -1;
    let at = was >= 0 ? was : allMessages.length;
    let added = 0;
    steps.push({ at: was >= 0 ? topId : '' });
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const held = allMessages.findIndex((x) => x.id === m.id);
      if (held >= 0) { if (held < at) { at = held; steps.push({ at: m.id }); } continue; }
      if (gone.has(m.id)) continue;   // removed after the server read it
      allMessages.splice(at, 0, m);
      undrawn.set(m.id, m);
      noteFile(m);
      steps.push({ id: m.id });
      added++;
    }
    const moved = list.length > 0 && list[0].id !== topId;
    if (list.length) topId = list[0].id;
    return { moved, added };
  }

  /**
   * Read back a page with something new in it (`find` empty: Show earlier), or until the message `find` is held (Show it),
   * then go to it. Each page is drawn before the next is asked for. A refusal for the rate is asked again after a second;
   * any other says why, and those are the words left: the message is said not to be in the room only where the room was
   * read back to its start without it, or its removal was heard. Show earlier asked during a read is that read; Show it
   * asked during a read for something else follows it.
   */
  function load(find) {
    const want = find || '';
    if (reading) {
      if (!want || readingFor === want) return reading;
      const mine = era;
      return reading.then(() => (mine === era ? load(want) : undefined));
    }
    const mine = era;
    readingFor = want;
    reading = (async () => {
      let failed = '';
      try {
        for (;;) {
          await drawn();
          if (mine !== era || (want && (findMessage(want) || gone.has(want))) || !more) break;
          const got = await ask((answer) => socket.emit('history:before', { beforeSeq: cursor() }, answer), (r) => {
            if (mine !== era) return null;
            if (r && r.busy) return { busy: true };
            if (!r || !r.ok || !Array.isArray(r.history)) return { failed: (r && r.error) || UNREAD };
            const merged = merge(r.history);
            more = merged.moved && r.more === true;
            schedule();
            return merged;
          });
          if (!got) break;
          if (got.busy) { await new Promise((wake) => { setTimeout(wake, 1000); }); continue; }
          if (got.failed) { failed = got.failed; AGM.toast(failed, true); break; }
          // A page of messages held already (those kept in view): the next is asked for before anything is said.
          if (!want && got.added > 0) break;
        }
        await drawn();
      } finally {
        if (mine === era) { reading = null; readingFor = ''; }
      }
      if (mine !== era) return;
      drawGap();
      requote();
      if (!want) return;
      const node = messagesById.get(want);
      if (node) showFound(node); else if (!failed) AGM.toast(NOT_HERE, true);
    })();
    drawGap();
    return reading;
  }

  /** Show earlier, above the run's top while the server holds earlier messages and everything held is drawn. */
  function drawGap() {
    const node = topId && !steps.length && !task ? messagesById.get(topId) : null;
    const item = node && more ? AGM.catalog.inline('earlier', F, object(''), 1)[0] : null;
    if (!item) { gap.remove(); return; }
    if (!button) {
      button = actButton(item, true);
      button.addEventListener('click', (e) => { e.preventDefault(); act('earlier', 'earlier.show', object(''), { anchor: button, node: gap, opener: button }); });
      gap.appendChild(button);
    } else drawActButton(button, item, true);
    button.setAttribute('aria-busy', reading ? 'true' : 'false');
    if (gap.parentNode !== feed || gap.nextSibling !== node) holdView(() => feed.insertBefore(gap, node), gap);
  }

  /** Whether a reply's quote offers Show it: its message is not held, not gone from the room, and the server holds earlier ones. */
  const quoting = (id) => more && !findMessage(id) && !gone.has(id);
  /** A reply's quote whose message is earlier than those held: it says so, with Show it (the catalogue's earlier.show). */
  function quote(el, id) {
    if (!quoting(id)) return;
    const item = AGM.catalog.inline('earlier', F, object(id), 1)[0];
    if (!item) return;
    el.dataset.earlier = '1';
    el.title = 'The message it answers is earlier than those shown here';
    const line = document.createElement('span');
    line.className = 'quote-earlier';
    line.append('Earlier — ', actButton(item, true));
    el.appendChild(line);
  }
  /** Each reply whose quote said Show it, drawn again where its message is held now, has gone, or nothing earlier is left. */
  function requote() {
    for (const q of document.querySelectorAll('.reply-quote[data-earlier="1"]')) {
      if (quoting(q.dataset.goto)) continue;
      const node = q.closest('.msg[data-id]');
      const m = node && findMessage(node.dataset.id);
      if (m) rerenderMessage(node, m);
    }
  }
  /** The page's facts changed (connected or not, the support view): Show earlier and each Show it say what they say now. */
  function redraw() {
    drawGap();
    for (const b of document.querySelectorAll('.reply-quote[data-earlier="1"] .msg-act')) {
      const q = b.closest('.reply-quote');
      const item = AGM.catalog.inline('earlier', F, object(q.dataset.goto), 1)[0];
      if (item) drawActButton(b, item, true);
    }
  }

  /**
   * A message gone from the room: the run's top moves to the message after it, a step still to draw above it draws above
   * that one, and the anchor moves below it.
   */
  function removed(id, next, node) {
    if (id === topId) topId = next ? next.id : '';
    for (const s of steps) if (s.at === id) s.at = next ? next.id : '';
    if (node && node === anchor) anchor = node.nextElementSibling;
    if (node && node === gap.nextSibling) gap.remove();
  }
  /**
   * A removal heard (live or resumed), whether the page held the message or not: every reply held that quotes it says it
   * has gone, so none offers to read back to it, and no read brings it back.
   */
  function goneFrom(id) {
    if (typeof id !== 'string' || !id) return;
    gone.add(id);
    for (const m of allMessages) {
      if (m.replyTo && m.replyTo.id === id && !m.replyTo.withdrawn && !m.replyTo.gone) m.replyTo = Object.assign({}, m.replyTo, { gone: true });
    }
    requote();
  }

  /**
   * A message pinned that this page does not hold (earlier than what it holds): read by its id, asked again after a
   * second for the rate or no answer, and held among the older ones while it is still pinned; one the room no longer
   * holds is left.
   */
  function fetchKept(id) {
    if (typeof id !== 'string' || !id || findMessage(id) || fetching.has(id) || gone.has(id)) return;
    fetching.add(id);
    const mine = era;
    const tries = (left) => {
      ask((answer) => socket.emit('history:message', { messageId: id }, answer), (r) => {
        if (mine !== era) return;
        if ((!r || r.busy) && left > 1) { setTimeout(() => { if (mine === era) tries(left - 1); }, 1000); return; }
        fetching.delete(id);
        if (r && r.ok && r.message && r.message.id === id && (r.message.pinned || pinnedForMe(id)) && !findMessage(id) && !gone.has(id)) keep(r.message);
      });
    };
    tries(TRIES);
  }
  /**
   * A message read by its id held in the room's order (before the first held message with a later change number), and
   * drawn above that one as the older ones are, once what was asked for before it is drawn.
   */
  function keep(m) {
    const key = Number.isInteger(m.seq) ? m.seq : 0;
    let at = allMessages.findIndex((x) => Number.isInteger(x.seq) && x.seq > key);
    if (at < 0) at = allMessages.length;
    const next = allMessages[at] || null;
    allMessages.splice(at, 0, m);
    undrawn.set(m.id, m);
    noteFile(m);
    steps.push({ at: next ? next.id : '' }, { id: m.id });
    refreshPinned();
    refreshDocPinnedList();
    schedule();
  }

  /** A page drawn afresh: whatever was being read or drawn ends, and nothing earlier is offered until it says so. */
  function stop() {
    era++;
    if (task) task();
    task = null;
    steps = [];
    anchor = null;
    topId = '';
    more = false;
    reading = null;
    readingFor = '';
    undrawn.clear();
    gone.clear();
    fetching.clear();
    gap.remove();
    const w = waiters;
    waiters = [];
    w.forEach((r) => r());
  }

  return { open, load, stop, removed, goneFrom, fetchKept, quote, quoting, redraw, object, more: () => more };
})();
/** A message gone to: brought into view and marked a moment. */
function showFound(target) {
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('found');
  setTimeout(() => target.classList.remove('found'), 1500);
}
/**
 * A reply's quote tapped: the message it answers, gone to where it is drawn; held but still being drawn, gone to once it
 * is; earlier than those held, read back until it is there (Show it, the catalogue's earlier.show).
 */
function goToQuoted(id, from) {
  const target = messagesById.get(id);
  if (target) { showFound(target); return; }
  if (findMessage(id)) { Earlier.load(id); return; }
  if (Earlier.quoting(id)) act('earlier', 'earlier.show', Earlier.object(id), { anchor: from, opener: from });
}
Object.assign(RUN, { 'earlier.show': (o) => Earlier.load(o.find) });

// A presence line: "Ana joined Backstage", "Ben joined On stage", "Wes joined as an observer", "Ana left"; an older line in a
// hall's history ("Ana joined as research") is one too.
const PRESENCE = /^(.+) (joined (?:On stage|Backstage|as an observer|as \w+)|left)$/;
function renderMessage(msg, { copy = false } = {}) {
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
  // A message drawn again in a pinned place (the pinned strip, the simple view's pinned bar): its pins said as that
  // place says them, its doors the strip's.
  if (copy) node.classList.add('pinned-copy');
  rerenderMessage(node, msg);
  return node;
}

/** Whether a message is pinned for this person (their own pins, as the server told this page). */
const pinnedForMe = (id) => F.pins.includes(id);
/** Whether a message is pinned in a way this person sees: for the room, or for them. */
const isPinned = (m) => !!m && (!!m.pinned || pinnedForMe(m.id));
/**
 * A pin's words (plan 7-§17.5): on a message's line in the feed, "Pinned for everyone", "Pinned for you", or "Pinned for
 * everyone · for you" for one pinned both ways; in a pinned place (`copy`), "For everyone", "For you", "For everyone · for
 * you".
 */
const pinWords = (room, mine, copy) => (copy ? '' : 'Pinned for ') + (room && mine ? (copy ? 'For everyone' : 'everyone') + ' · for you' : room ? (copy ? 'For everyone' : 'everyone') : copy ? 'For you' : 'you');
/**
 * A message's pins as its node says them: `data-pinned` the room's, on every page; `data-pinned-mine` this person's own
 * (and, in the support view, the person's it shows); a question pinned either way is hidden from the feed while it stays
 * pinned (styles.css), drawn in the pinned place alone; and its line's mark, muted, with its words.
 */
function drawPinMark(node, msg) {
  const room = !!msg.pinned;
  const mine = pinnedForMe(msg.id);
  node.dataset.pinned = room ? '1' : '0';
  node.dataset.pinnedMine = mine ? '1' : '0';
  node.classList.toggle('pinned', room || mine);
  const mark = node.querySelector(':scope > header .pinned-mark');
  if (!mark) return;
  mark.hidden = !room && !mine;
  const words = mark.hidden ? '' : pinWords(room, mine, node.classList.contains('pinned-copy'));
  const said = mark.querySelector('.pin-words');
  if (said && said.textContent !== words) said.textContent = words;
}

function rerenderMessage(node, msg) {
  drawPinMark(node, msg);
  drawAlsoSaid(node, msg);
  node.classList.toggle('is-action', msg.type === 'action');
  node.classList.toggle('is-help', msg.type === 'help');
  if (msg.type === 'help') node.dataset.help = (msg.help && msg.help.state) || 'open';
  node.classList.toggle('mine', isMine(msg));
  node.classList.toggle('priority', !!msg.priority);
  const rt = node.querySelector('.role-tag');
  const time = node.querySelector('time');
  const body = node.querySelector('.body');
  const simple = F.view === 'simple';
  if (msg.from) {
    // The simple view says the exception in words: "On stage" after a name that also sits there; backstage, the
    // default author here, is said to a screen reader alone (", backstage,"), never as a badge.
    const seat = msg.from.role === 'director' ? 'board' : msg.from.role;
    rt.textContent = simple ? (seat === 'board' ? 'On stage' : seat === 'research' ? ', backstage,' : '') : roleLabel(msg.from.role);
    rt.dataset.role = msg.from.role;
    rt.classList.toggle('sr-only', simple && seat !== 'board');
  }
  const badge = node.querySelector('.priority-badge');
  if (badge) badge.textContent = simple ? '🔥 Priority' : '🔥 HIGH';
  time.textContent = formatTime(msg.at);
  body.innerHTML = '';

  // Reply preview (small quote block at the top of the body): a click goes to the message it answers.
  if (msg.replyTo) {
    const rt = document.createElement('div');
    rt.className = 'reply-quote';
    // A quote of a message withdrawn from this room since keeps no word of it (the server took them out): it says so.
    rt.innerHTML = '↩ <strong>' + escapeHtml(msg.replyTo.name) + '</strong>: ' +
      '<em>' + escapeHtml(msg.replyTo.withdrawn ? marked('withdrawn', 'withdrawn') : (msg.replyTo.snippet || '').slice(0, 120)) + '</em>';
    rt.title = 'Click to scroll to original';
    rt.dataset.goto = msg.replyTo.id;
    // Its message gone from the room (the server's word, or a removal heard here): nothing to read back to. Else, earlier
    // than those this page holds: "Earlier — Show it".
    if (msg.replyTo.gone) rt.title = 'The message it answers is no longer in this room';
    else if (!msg.replyTo.withdrawn) Earlier.quote(rt, msg.replyTo.id);
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
      : msg.sentTo.withdrawn ? marked('withdrawn', 'Withdrawn from ') + AGM.catalog.placeOf(msg.sentTo) + ' after ' + AGM.catalog.lasted(msg.sentTo.withdrawn - msg.at)
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
  Simple.said(node, msg);
  // A message in the pinned strip is drawn there from its record (no copy of this node), so it acts as it does here.
  if (isPinned(msg) && messagesById.get(msg.id) === node) refreshPinned(msg.id);
  if (openOn && openOn.kind === 'msg' && openOn.id === msg.id) refreshOpenMenu();
}

// ---------------- The doors of an object: its bar, its ⋯, right-click, Shift+F10 and its keys (catalog.js, menus.js) ----------------
// An object's bar holds the two acts of lowest inline rank the catalogue shows it, then its ⋯; right-click, ⋯ and
// Shift+F10 (or the menu key) open its whole list; a single key on the focused object runs the act that carries it. Each
// door reads the same entries with the same facts, so they are in step, and every act runs through act() below.
const drawnActs = new WeakMap();   // an object's bar → what it was drawn from, so an unchanged bar is not drawn again
/**
 * One act of a bar, drawn into its button: its icon (and, with `words`, its label beside it), named by its catalogue label.
 * A fold drawn on the bar (📌 Pin ▸) is a menu button: it opens the object's menu at that fold.
 */
function drawActButton(b, item, words) {
  if (item.fold) {
    delete b.dataset.action;
    b.dataset.fold = item.fold;
    b.setAttribute('aria-haspopup', 'menu');
    if (!b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', 'false');
  } else {
    b.dataset.action = item.id;
    delete b.dataset.fold;
    b.removeAttribute('aria-haspopup');
    b.removeAttribute('aria-expanded');
  }
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
 * Draw an object's bar into `bar`: its inline acts (two, or with `all` every one: a take's layer, the Board's row) and its
 * ⋯ (none when it has no menu), and its keys named. A button
 * that still offers the same act is drawn again in place (a reason or a label changed), and the ⋯ is kept while there
 * is a menu, so a change of the page's facts never takes the focus, or an open menu's opener, away.
 */
function drawBar(bar, kind, o, { words = false, more = 'More actions', keysOn = null, all = false, max = 2 } = {}) {
  const inl = AGM.catalog.inline(kind, F, o, all ? Infinity : max);
  const shown = AGM.catalog.shown(kind, F, o);
  const menu = AGM.catalog.items(kind, F, o).length > 0;
  const key = JSON.stringify([inl.map((i) => [i.id || 'fold:' + i.fold, i.label, i.icon, i.disabled]), menu, words]);
  if (drawnActs.get(bar) === key) return;
  drawnActs.set(bar, key);
  const had = [...bar.querySelectorAll(':scope > .msg-act')];
  const dots = bar.querySelector(':scope > .obj-more');
  const same = (b, i) => (i.fold ? b.dataset.fold === i.fold : b.dataset.action === i.id);
  if (had.length === inl.length && had.every((b, n) => same(b, inl[n]))) inl.forEach((i, n) => drawActButton(had[n], i, words));
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
  // The full view's acts sit in the message's header with its ⋯; the simple view's (Got it, Reply) after its words, as
  // text actions, so a response follows what it answers in the page's order, and it has no ⋯ (no menu).
  const head = node.querySelector(':scope > header .msg-acts');
  let resp = node.querySelector(':scope > .msg-response');
  const simple = F.view === 'simple';
  if (simple && !resp && head) {
    resp = document.createElement('div');
    resp.className = 'msg-response';
    node.querySelector(':scope > .body').after(resp);
  }
  const bar = simple ? resp : head;
  const other = simple ? head : resp;
  if (other && other.childElementCount) { other.textContent = ''; drawnActs.delete(other); }
  // In the pinned strip a message's door unpins each kind it is pinned by (`where: 'strip'`), beside its own two; in the
  // simple view a tapped message's row holds Got it, Reply and 📌 Pin for me.
  const o = node.classList.contains('pinned-copy') ? Object.assign({}, msg, { where: 'strip' }) : msg;
  if (bar) drawBar(bar, 'msg', o, { keysOn: node, words: simple, max: simple || o !== msg ? 3 : 2 });
  // The body's own doors (a prompt's answers, a help request's answers) are the same entries, and say why when they
  // cannot run now.
  const shown = new Set(AGM.catalog.shown('msg', F, msg).map((e) => e.id));
  for (const b of node.querySelectorAll('.body button[data-action]')) {
    // A quote's Show it is the room's earlier messages' act (Earlier), not the message's.
    if (b.closest('.reply-quote')) continue;
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
  // An act asks first where its row says so for this object (Turn the code off… asks, Turn the code on does not). One
  // whose ask was answered already, a step before it is sent (a web page's Preview, then Show it), runs with that answer.
  const spec = e.confirm ? e.confirm(F, o) : null;
  if (spec && c.answered) { run(o, Object.assign({}, c, { values: c.answered.values, choice: c.answered.choice })); return; }
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
  if (kind === 'pick') return PickBar.object();
  if (kind === 'compose') return composeObject(o.form);
  if (kind === 'chip') return stageNow;
  if (kind === 'room') return switcherObject(o.key);
  if (kind === 'header') return headerObject();
  if (kind === 'board') return Console.board();
  if (kind === 'take') return Takes.object();
  if (kind === 'card') return Takes.cardObject(o && o.layer);
  if (kind === 'past') return Takes.pastObject(o && o.seq);
  if (kind === 'sheet') return Simple.sheetNow();
  if (kind === 'cleared') return Cleared.object(o && o.run);
  return null;
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
  const placed = AGM.menu.placer(node, anchor, from);
  const handle = AGM.menu(list, at || { anchor }, {
    label, header: header(o), opener: from,
    goneWords: AGM.catalog.WORDS.gone,
    onPick: (id, value, item) => { const now = get(); if (now) act(kind, id, now, { ...placed(), value, item }); else AGM.toast(goneWords(kind), true); },
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
const GONE = { msg: 'That message is gone.', file: 'That file is gone.', screen: 'That screen is gone.', room: 'That room is gone.', take: 'That is no longer shown to you.', card: 'That is no longer shown to you.' };
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
// Their key on people's pages (an account's `a:<id>`, a guest's `u:<uid>`) and what their pages show now, as the console
// reads it ('' where it lists no page of theirs, undefined until it has read), with the information on them (`info`,
// `beside`: Take down's): a seat that may change it shows them a take, or hands them back to their chat.
const personOf = (p) => {
  if (!p || typeof p.uid !== 'string' || !p.uid) return null;
  // An AI's line (the Minutes) is no person's page: no key, so no act on what pages show is offered on it.
  const key = p.ai ? '' : (p.account || p.acct ? 'a:' : 'u:') + p.uid;
  // A row of the room's people also carries its page (`socketId`) and, on the admin's own page, the chat view, the clock or
  // countdown the admin chose for them and what they may do On stage (`view`, `clock`, `onStage`): Chat view ▸, Clock or
  // countdown ▸ and the On stage switches read them; a message's sender carries none.
  return { id: 'person:' + p.uid, uid: p.uid, name: String(p.name || ''), role: p.role || '', key, kind: key ? Console.kindOf(key) : '',
    socketId: typeof p.socketId === 'string' ? p.socketId : '', view: typeof p.view === 'string' ? p.view : '', clock: AGM.catalog.adminClockOf(p), onStage: AGM.catalog.onStageOf(p), ...(key ? Console.takesOf(key) : {}) };
};
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
  // The simple view names one's own messages You.
  const name = F.view === 'simple' && isMine(msg) ? 'You' : msg.from.name;
  if (el.textContent !== name) el.textContent = name;
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
  // The simple view's second door: a tap on a message (not on one of its buttons or links) brings its own row back.
  if (F.view === 'simple' && !e.target.closest('button, a, input, textarea, select, [data-goto]')) {
    const tapped = e.target.closest('.msg[data-id]');
    if (tapped && !tapped.classList.contains('echo') && this.contains(tapped)) Simple.tap(tapped.dataset.id);
  }
  const el = e.target.closest('[data-action], [data-more], [data-goto], [data-person], [data-fold]');
  if (!el || !this.contains(el)) return;
  const node = el.closest('.msg[data-id]');
  const msg = node && findMessage(node.dataset.id);
  if (!msg) return;
  // A fold on the message's bar (📌 Pin ▸): its menu, opened at that fold.
  if (el.dataset.fold) {
    e.preventDefault();
    if (openOn && openOn.kind === 'msg' && openOn.id === msg.id) { AGM.menu.close(); return; }
    openSubmenu(node, el, el.dataset.fold);
    return;
  }
  if (el.dataset.person) {
    e.preventDefault();
    if (openOn && openOn.kind === 'person' && openOn.node === el) { AGM.menu.close(); return; }
    senderDoor(el).open({ anchor: el });
    return;
  }
  // A reply's quote (and its Show it): the message it answers.
  const quoted = el.closest('.reply-quote[data-goto]');
  if (quoted) { e.preventDefault(); goToQuoted(quoted.dataset.goto, el); return; }
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
/** The object's menu, opened at its ⋯ with one of its submenus open (E reacts, F sends to, P a fold: 📌 Pin ▸). */
function openSubmenu(node, more, id) {
  const door = msgDoor(node);
  if (door.open({ anchor: more || node }) && AGM.menu.current()) AGM.menu.current().expand(id);
}
/** The fold the entry `e` is drawn in on this object's menu, or '' where it is drawn flat (one of its fold alone). */
const foldIn = (kind, e, o) => (e.fold && AGM.catalog.shown(kind, F, o).filter((x) => x.fold === e.fold).length > 1 ? e.fold : '');
/** A single key on the focused message runs the act that carries it: R E F P D, Enter, and Delete or Backspace. */
function onMsgKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
  const node = e.target;
  if (!node || !node.matches || !node.matches('.msg[data-id]')) return;
  // Escape on a message (no menu or ask open: theirs end first, as they hear it first) goes back to the composer; in the
  // simple view its own order (Simple) takes a reply begun back first, so it is left to it.
  if (e.key === 'Escape') { if (F.view === 'simple') return; const field = composerField(); if (field) { e.preventDefault(); field.focus(); } return; }
  const msg = findMessage(node.dataset.id);
  // The simple view acts on Tab, Enter and Escape alone: Enter on a message brings its own row and moves to its response.
  if (F.view === 'simple') {
    if (e.key === 'Enter' && msg) { e.preventDefault(); Simple.tap(msg.id, { focus: true }); }
    return;
  }
  const entry = msg && AGM.catalog.byKey('msg', F, msg, e.key);
  if (!entry) return;
  e.preventDefault();
  const more = node.querySelector(':scope > header .obj-more');
  if (entry.submenu) { openSubmenu(node, more, entry.id); return; }
  // A key of a fold (P): its submenu opens, its first entry focused (📌 Pin ▸, For the room); one of it alone acts at once.
  if (foldIn('msg', entry, msg)) { openSubmenu(node, more, entry.fold); return; }
  act('msg', entry.id, msg, { anchor: more || node, node, opener: node });
}
// On an On stage seat the feed's pictures are On stage content: AGMessage's menu in place of the browser's on them,
// Shift+right-click too, so its "Save image as" is never offered (plan 4-§4.6.6).
for (const host of [document.getElementById('feed'), document.getElementById('pinnedList'), document.getElementById('bvPinQ')]) {
  host.addEventListener('click', onMsgClick);
  host.addEventListener('keydown', onMsgKey);
  AGM.menu.door(host, findMsgDoor, { stage: () => F.role === 'board' });
}
AGM.roving(document.getElementById('pinnedList'), { item: '.msg[data-key]' });

// What each act on a message does. The server decides; every write goes through the outbox in its entry's mode.
const isFileUrl = (u) => typeof u === 'string' && /^\/uploads\/[\w.-]+$/.test(u);
/**
 * A download (plan 4-§4.6.6): the server's own act, by a ticket it gives this page's seat for one file (`file:download`:
 * `{messageId}` a file of this room, `{seq}` a take shown with Download ticked). The page posts the ticket in a form built
 * with the DOM, never a link, and the server answers that post with the file as an attachment (or 204, which leaves the
 * page as it is). Attempts are not facts: "Downloading…" once the ticket is given, "reached this browser" once the server
 * says the whole file went (`file:sent`), "stopped" when its stream ended before that (`whole: false`), "did not start"
 * when it never began within DOWNLOAD_START_MS, and, for one in flight as this page loses its connection (the server
 * can no longer tell it), that it cannot say. Whether the browser then kept it is the browser's.
 */
const DOWNLOAD_START_MS = 5000;
const downloading = new Map();   // ticket -> {name, timer, began}
function downloadBy(args, url, name) {
  if (!isFileUrl(url)) return;
  AGM.outbox.now('file:download', args, (r) => {
    if (!r || !r.ok || typeof r.ticket !== 'string') { AGM.toast((r && r.error) || 'Not downloaded.', true); return; }
    const said = (typeof r.name === 'string' && r.name) || name || 'the file';
    AGM.toast('⬇ Downloading ' + said + '…');
    const timer = setTimeout(() => {
      const d = downloading.get(r.ticket);
      if (d && !d.began) { downloading.delete(r.ticket); AGM.toast('The download did not start — try again.', true); }
    }, DOWNLOAD_START_MS);
    downloading.set(r.ticket, { name: said, timer, began: false });
    const form = document.createElement('form');
    form.method = 'post';
    form.action = url + '/download';
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
socket.on('file:sending', (p) => { const d = p && downloading.get(p.ticket); if (d) d.began = true; });
socket.on('file:sent', (p) => {
  const d = p && downloading.get(p.ticket);
  if (!d) return;
  clearTimeout(d.timer);
  downloading.delete(p.ticket);
  if (p.whole === false) AGM.toast('The download of ' + d.name + ' stopped before all of it was sent — try again.', true);
  else AGM.toast(marked('ok', d.name + ' reached this browser'));
});
socket.on('disconnect', () => {
  for (const [ticket, d] of downloading) {
    clearTimeout(d.timer);
    downloading.delete(ticket);
    AGM.toast('This page lost its connection while ' + d.name + ' downloaded, so it cannot say whether all of it arrived.', true);
  }
});
/** A file of this room downloaded: its message's ticket. */
const download = (m) => downloadBy({ messageId: m.id }, m.url, m.filename);
/** Words to the clipboard (AGM.copy: over plain http too), said in the toast; the focus goes back where it was. */
const copyText = (text, said, anchor) => AGM.copy(text, { said, anchor, say: (w) => AGM.toast(w) });
/**
 * Pinned or unpinned for the room (plan 7-§17.5: what everyone in it sees, so an act on it now), with Undo for 10 s: the
 * opposite op of the same kind. A refusal says the server's words and changes nothing.
 */
function pinForRoom(o) {
  const pinned = !o.pinned;
  AGM.outbox.now('pin', { messageId: o.id, pinned }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || (pinned ? 'Not pinned.' : 'Not unpinned.'), true); return; }
    AGM.toast(pinned ? 'Pinned for the room.' : 'Unpinned for the room.', { undo: () => AGM.outbox.now('pin', { messageId: o.id, pinned: !pinned }, saidIfNot(pinned ? 'Not unpinned.' : 'Not pinned.')) });
  });
}
/**
 * Pinned or unpinned for this person alone (plan 7-§17.5: their own state, so held through a blip and sent once the page
 * is back; a replay sets the same state). Said once the server answers (drawHeldPin), with Undo for 10 s.
 */
function pinForMe(o, { undo = false } = {}) {
  AGM.outbox.hold('pin:mine', { messageId: o.id, on: !pinnedForMe(o.id) }, { tag: { pinMine: true, ...(undo ? { undo: true } : {}) } });
}
/**
 * A pin for oneself as the outbox holds it: held while the page is down (◷, and said so once), then the server's ids drawn
 * and said with Undo (an Undo's own answer says nothing more), or its refusal in the server's words.
 */
function drawHeldPin(item) {
  const on = item.args.on === true;
  if (item.state === 'waiting' && item.attempt === 0 && !AGM.outbox.online) AGM.toast(marked('waiting', (on ? 'Pinned for you' : 'Unpinned for you') + ' when the connection is back.'));
  else if (item.state === 'done') {
    if (item.result && Array.isArray(item.result.ids)) setMyPins(item.result.ids);
    if (!(item.tag && item.tag.undo)) AGM.toast(on ? 'Pinned for you.' : 'Unpinned for you.', { undo: () => { const m = findMessage(item.args.messageId); if (m) pinForMe(m, { undo: true }); } });
  } else if (item.state === 'refused') { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); }
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
  // Got it answers the backstage team with this person's 👍, held through a blip; Got all N (on the newest plain message
  // waiting) answers each plain message that waits, one send each; any other, itself alone. Its second door closes.
  'msg.ack': (m) => {
    const plain = F.waiting.plain;
    const all = !m.priority && plain.length > 1 && plain[plain.length - 1] === m.id;
    for (const id of all ? plain : [m.id]) AGM.outbox.hold('react', { messageId: id, emoji: '👍', on: true });
    Simple.tap('');
  },
  // Change: a question this person answered shows its answers again, to give another (their answer is replaced).
  'msg.change': (m) => Simple.change(m.id),
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
  'msg.pin': (m) => pinForRoom(m),
  'msg.pinMine': (m) => { pinForMe(m); Simple.tap(''); },
  'msg.confidential': (m) => markFile(m),
  'msg.look': (m) => openDocInPanel(m),
  'msg.download': (m) => download(m),
  'msg.stage': (m, c) => Show.fromMenu(m, c),
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
const COMPOSER_FORMS = { director: () => dForm, text: () => textPane, action: () => actionPane };
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
  else if (item.verb === 'pin:mine') drawHeldPin(item);
}

/** What a held message says, in one line: one sent into another room says where first. */
function echoText(a, item) {
  const into = item && item.verb === 'room:send' && item.tag && item.tag.to ? '↗ to ' + item.tag.to + ': ' : '';
  return into + echoWords(a);
}
function echoWords(a) {
  if (a.type === 'help') return 'Help — ' + (a.category || 'Other') + (a.text ? ': ' + a.text : '');
  if (a.type === 'action') return '❓ ' + (a.text || '');
  if (a.type === 'file') return '📎 ' + (a.filename || 'a file') + (a.caption ? ' — ' + a.caption : '');
  return a.text || '';
}
function echoState(item) {
  if (item.state === 'refused') return marked('couldNot', 'Not sent: ' + item.words);
  if (item.state === 'lost') return marked('couldNot', item.words);
  return marked('waiting', !AGM.outbox.online ? 'Waiting — it goes when the connection is back' : 'Sending');
}

function drawEcho(item) {
  // A file sent into another room marked confidential asks its sender once more before it goes (S12).
  if (item.state === 'refused' && item.verb === 'room:send' && confirmSecretSend(item)) { const n = echoes.get(item.cid); if (n) n.remove(); echoes.delete(item.cid); composerFollows({ ...item, state: 'dropped' }); return; }
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
  // A file shared in this room is said once the server has it, naming who may take it (one sent into another room is
  // said by its own toast, drawHeldSend).
  if (item.state === 'done' && item.verb === 'message' && item.args.type === 'file') AGM.toast(sharedWords(item.args));
  if (item.state !== 'refused') delete composerCids[c];
  lockComposer(c, false);
}
/**
 * What a share says once the server has it: where it is, and who may take it. The backstage team downloads it; the Board
 * opens it with Look in a Main room, never a file to transfer only (its type is application/octet-stream, whatever it
 * is); a side room has no Board.
 */
function sharedWords(a) {
  const where = MAIN === false ? ROOM_NAME || 'this room' : 'Main';
  const opens = MAIN !== false && a.mime !== 'application/octet-stream';
  return 'Shared in ' + where + ' — the backstage team can download it' + (opens ? '; the Board can open it.' : '.');
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
  const t = c === 'text' ? targetNow() : null;
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
  if (c === 'text' && a.type !== 'file' && textInput.value.trim() === a.text) { textInput.value = ''; aiDrafted = false; setAiHint(''); }
  if (c === 'action' && actionText.value.trim() === a.text) { actionText.value = ''; currentOptions = ['Yes', 'No']; renderOptionChips(); }
  // A file shared: its chip goes, and its caption, the words it went with (the Preview keeps the file open on this page).
  if (a.type === 'file' && pendingFile && pendingFile.file === item.file) {
    if (textInput.value.trim() === (a.caption || '')) textInput.value = '';
    removePendingFile({ keepPreview: true });
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
  if (c) setPriority({ director: dirPriBtn, text: textPriBtn, action: actionPriBtn, file: textPriBtn }[c], !!a.priority);
  if (typeof a.replyTo === 'string' && a.replyTo) {
    const parent = findMessage(a.replyTo);
    replyState = { id: a.replyTo, name: parent ? (parent.from && parent.from.name) || 'system' : 'an earlier message', snippet: parent ? parent.text || parent.filename || '' : '' };
    renderReplyChip();
  }
  const tab = selectTab;
  // A help request: its words back in the dialog, where a category's tap sends it again (none is chosen for the person).
  if (a.type === 'help') { openHelpDialog(a.text || ''); return; }
  if (a.type === 'action') { tab('action'); if (!kept) { actionText.value = a.text || ''; currentOptions = Array.isArray(a.options) ? a.options.slice(0, 6) : ['Yes', 'No']; renderOptionChips(); } actionText.focus(); return; }
  if (a.type === 'file') { tab('text'); if (!kept) textInput.value = a.caption || ''; AGM.toast('Attach the file again (📎) to share it.'); return; }
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
  if (isPinned(m)) refreshPinned(m.id);
}

/** A message of this room sent into another (Send to ▸): held while the page is down, then said, or its refusal. */
function drawHeldSend(item) {
  const to = (item.tag && item.tag.sendTo) || 'the other room';
  if (item.state === 'waiting' && item.attempt === 0 && !AGM.outbox.online) AGM.toast(marked('waiting', 'Held — it is sent to ' + to + ' when the connection is back.'));
  else if (item.state === 'done') AGM.toast('Sent to ' + to + ' — a copy stays here.');
  else if (item.state === 'gone') AGM.toast('Sent to ' + to + '.');
  else if (item.state === 'refused') { if (!confirmSecretSend(item)) { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); } }
}
function drawHeldForward(item) {
  const to = (item.tag && item.tag.forward) || 'the other hall';
  if (item.state === 'waiting' && item.attempt === 0 && !AGM.outbox.online) AGM.toast(marked('waiting', 'Held — it is forwarded to ' + to + ' when the connection is back.'));
  else if (item.state === 'done' || item.state === 'gone') AGM.toast('Forwarded to ' + to);
  else if (item.state === 'refused') { if (!confirmSecretSend(item)) { AGM.toast(item.words, true); AGM.outbox.drop(item.cid); } }
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
  AGM.toned(line, marked(h.state === 'resolved' ? 'ok' : h.state === 'coming' ? 'coming' : 'urgent', HELP_WORDS[h.state] + (h.by ? ' — ' + h.by : '') + (h.at && h.state !== 'open' ? ' at ' + formatTime(h.at) : '')));
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
      b.textContent = held && held.option === state ? marked('waiting', e.label) : e.label;
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
/**
 * Where a message from On stage also went, as its targets confirmed it (plan 7-§17.6): its words at the end of its author's
 * line drawn again, for every reader of the room.
 */
function setAlso(messageId, also) {
  const msg = findMessage(messageId);
  if (!msg || !also || typeof also !== 'object') return;
  msg.also = also;
  const node = messagesById.get(messageId);
  if (node && node.classList.contains('msg')) drawAlsoSaid(node, msg);
}
/**
 * A message's words of where it also went, at the end of its author's line, in both views, a part for each place, muted,
 * and one whose target could not show it in warn's colour beside its △; none for one that went nowhere else.
 */
function drawAlsoSaid(node, msg) {
  const el = node.querySelector(':scope > header .also-said');
  if (!el) return;
  const parts = AGM.catalog.alsoParts(msg.also, formatTime);
  const key = JSON.stringify(parts);
  if (el.dataset.said === key) return;
  el.dataset.said = key;
  el.textContent = '';
  parts.forEach((x, i) => {
    if (i) el.append(' · ');
    const span = document.createElement('span');
    if (x.tone) { span.className = 'toned'; span.dataset.tone = x.tone; }
    span.textContent = x.words;
    el.append(span);
  });
  el.hidden = !parts.length;
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

/** A file's kind, as its card says it: by its extension (its upload's address, else its name). */
const FILE_KINDS_SAID = { pdf: 'PDF', png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', txt: 'Text', md: 'Markdown', csv: 'CSV', xlsx: 'Excel', xls: 'Excel', docx: 'Word', pptx: 'PowerPoint',
  zip: 'ZIP', mp4: 'MP4 video', m4a: 'M4A audio', mov: 'QuickTime video', mp3: 'MP3 audio', wav: 'WAV audio', odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation' };
const extOfName = (name) => { const x = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return x ? x[1].toLowerCase() : ''; };
const fileKindOf = (m) => FILE_KINDS_SAID[extOfName(m.url) || extOfName(m.filename)] || 'File';
/** A size in bytes as a card says it: "340 KB", "2.1 MB"; '' for none (a file shared before sizes were kept). */
const sizeWords = (n) => (!Number.isInteger(n) || n < 0 ? '' : n < 1024 ? n + ' bytes' : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
/**
 * A file message's line on its card: "📎 Board pack.pdf · PDF · 2.1 MB", a transfer-only one "📦 … · download only", and
 * one marked confidential (its `confidential`, the server's from the file's one record) "📎 🔒 Confidential · Board pack.pdf
 * · …": an icon with its word, never colour alone.
 */
const fileLine = (m) => [(m.transferOnly ? '📦 ' : '📎 ') + (m.confidential ? '🔒 Confidential · ' : '') + (m.filename || 'a file'), fileKindOf(m), sizeWords(m.size), m.transferOnly ? 'download only' : ''].filter(Boolean).join(' · ');
/**
 * A file's card (a transfer, plan 4-§4.6.3): its name, kind and size, a picture's inline picture, its caption, and the
 * acts this seat has on it (the catalogue's): 👁 Look or Preview (a tap on it), ⬇ Download. An observer's and a Viewer
 * account's card has no link, so no picture and no act on the file. A picture is drawn from its bytes, fetched `no-store`,
 * through an object URL let go as the card leaves the page (FeedPictures).
 */
function renderFileBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'file';
  const isImage = !msg.transferOnly && isFileUrl(msg.url) && /^image\/(png|jpeg|gif|webp)$/.test(msg.mime || '');
  if (isImage) wrap.appendChild(FeedPictures.picture(msg));
  const card = document.createElement('div');
  card.className = 'file-link';
  card.classList.toggle('confidential', msg.confidential === true);
  card.textContent = fileLine(msg);
  wrap.appendChild(card);
  if (msg.caption) {
    const c = document.createElement('p');
    c.className = 'caption';
    c.textContent = msg.caption;
    wrap.appendChild(c);
  }
  const shown = new Set(AGM.catalog.shown('msg', F, msg).map((e) => e.id));
  // A tap on the file is its Look (the catalogue's msg.look), where this seat has one.
  if (shown.has('msg.look')) {
    wrap.classList.add('clickable');
    wrap.title = AGM.catalog.entry('msg', 'msg.look').label(F) + ': open it in your own panel';
    wrap.dataset.action = 'msg.look';
  }
  // ⬇ Download, for a seat that may download it (the admin, the backstage team but a Viewer account), in the full view.
  if (shown.has('msg.download')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost small file-download';
    b.dataset.action = 'msg.download';
    b.textContent = '⬇ ' + AGM.catalog.entry('msg', 'msg.download').label;
    wrap.appendChild(b);
  }
  return wrap;
}

/**
 * The feed's pictures: each drawn from its bytes, fetched `no-store` when its card comes into view (never into the
 * browser's cache), through an object URL that is revoked as its card leaves the page; never dragged out. A picture that
 * cannot be read says so on its card.
 */
const FeedPictures = (() => {
  const made = new Map();   // img -> object URL
  const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver((list) => {
    for (const e of list) if (e.isIntersecting) { seen.unobserve(e.target); load(e.target); }
  }, { rootMargin: '200px' }) : null;
  async function load(img) {
    if (made.has(img) || !img.isConnected) return;
    made.set(img, '');
    try {
      const res = await fetch(img.dataset.src, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!img.isConnected) { made.delete(img); return; }
      const url = URL.createObjectURL(blob);
      made.set(img, url);
      img.src = url;
    } catch {
      made.delete(img);
      img.alt = 'This picture could not be read.';
    }
  }
  /** The picture of a file message, drawn when it comes into view. */
  function picture(msg) {
    const img = document.createElement('img');
    img.alt = msg.filename || 'A picture';
    img.dataset.src = msg.url;
    img.setAttribute('draggable', 'false');
    if (seen) seen.observe(img); else setTimeout(() => load(img), 0);
    return img;
  }
  /** Each picture no longer on the page, its object URL let go. */
  function sweep() {
    for (const [img, url] of made) {
      if (img.isConnected) continue;
      made.delete(img);
      if (url) URL.revokeObjectURL(url);
      if (seen) seen.unobserve(img);
    }
  }
  const watch = new MutationObserver(() => sweep());
  for (const id of ['feed', 'pinnedList']) watch.observe(document.getElementById(id), { childList: true, subtree: true });
  return { picture, sweep, count: () => made.size };
})();

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
  // This person's own answer, which the simple view draws in place of the answers until Change brings them back, and
  // then marks the one chosen among them (pressed).
  const mine = (msg.responses || []).find((r) => r.uid === MY_UID) || null;
  const simple = F.view === 'simple';
  if (shown.has('msg.answer')) msg.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn action-btn';
    b.dataset.action = 'msg.answer';
    b.dataset.value = String(i);
    b.textContent = opt;
    if (simple) b.setAttribute('aria-pressed', String(!!mine && mine.optionIndex === i));
    const held = heldAnswers.get('answer|' + msg.id);
    if (held && held.option === i) { b.textContent = marked('waiting', opt); b.dataset.state = 'sending'; }
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
  // The simple view, once this person has answered: "You answered Yes · 14:10 · Change" (or the words they gave), and
  // Change (msg.change) brings the answers back, the line staying under them without Change while they choose again;
  // others' tallies are the backstage team's to read.
  if (simple && mine && (shown.has('msg.change') || F.changing === msg.id)) {
    const line = document.createElement('p');
    line.className = 'bv-answered';
    const opt = mine.optionIndex >= 0 ? msg.options[mine.optionIndex] : null;
    line.textContent = (opt !== null && opt !== undefined ? 'You answered ' + opt : 'You answered: “' + (mine.note || '') + '”') + (mine.at ? ' · ' + formatTime(mine.at) : '');
    if (shown.has('msg.change')) {
      line.append(' · ');
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'bv-text-act';
      change.dataset.action = 'msg.change';
      change.textContent = AGM.catalog.entry('msg', 'msg.change').label;
      line.appendChild(change);
    }
    wrap.appendChild(line);
  }
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
  const msg = findMessage(messageId);
  // This person's own answer before and after: the simple view draws it, and nobody else's.
  const ownOf = (list) => { const r = (Array.isArray(list) ? list : []).find((x) => x.uid === MY_UID); return r ? [r.optionIndex, r.note || '', r.at || 0].join('|') : ''; };
  const ownWas = msg ? ownOf(msg.responses) : '';
  // Its record first: one held and not drawn yet is drawn with the answers it has by then.
  if (msg) msg.responses = responses;
  if (!els.length) return;
  els.forEach((el) => renderResponses(el, { responses, options: msg?.options || [] }));
  const node = messagesById.get(messageId);
  if (node) node.classList.add('answered');
  // The simple view draws this person's own answer in place of the answers, and no tally: the question is drawn again
  // only when their own answer changed (which ends a Change), so another's answer never takes away their choice or focus.
  if (node && msg && F.view === 'simple' && ownOf(responses) !== ownWas) { if (F.changing === messageId) factsChanged({ changing: '' }); rerenderMessage(node, msg); }
  // Its pinned copy says the same, and so does its open menu (Answer ▸'s choice).
  if (isPinned(msg)) refreshPinned(messageId);
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
  // Pinned and not held (earlier than what this page holds): read, so it is in view as every pinned message is.
  else if (pinned) Earlier.fetchKept(messageId);
  const node = messagesById.get(messageId);
  if (node && node.classList.contains('msg') && data) {
    drawPinMark(node, data);
    drawActs(node, data);
  }
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === messageId) drawDocActs();
  refreshOpenMenu();
  // A message pinned is never cleared by Got it: drawn again in its place.
  drawCleared();
}

/**
 * This person's own pins changed (plan 7-§17.5): the server's ids, from its `pins` (an account's other device, the admin's
 * view of this person) or a pin:mine's answer. Each message whose pin for them came or went says so, a pinned question
 * leaves the feed or comes back to its place, and every pinned place is drawn again; one not held is read, so it is in view
 * as every pinned message is.
 */
function setMyPins(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.length > 0) : [];
  const was = new Set(F.pins);
  factsChanged({ pins: list });
  const now = new Set(F.pins);
  for (const id of new Set([...was, ...now])) {
    if (was.has(id) === now.has(id)) continue;
    const m = findMessage(id);
    const node = messagesById.get(id);
    if (m && node && node.classList.contains('msg')) drawPinMark(node, m);
    if (!m && now.has(id)) Earlier.fetchKept(id);
  }
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId) drawDocActs();
  refreshOpenMenu();
}
socket.on('pins', (p) => { if (p && Array.isArray(p.ids)) setMyPins(p.ids); });
/**
 * Every message's pins drawn from the facts as they stand (a join: what this person pinned is the join's), every pinned
 * place with them. A first open carries every message this person pinned (the server's `older`); one this page does not
 * hold after a resume (pinned on another device meanwhile, earlier than what it holds) is read back, so it is in view.
 */
function drawAllPins() {
  const held = new Set();
  for (const m of allMessages) { held.add(m.id); const node = messagesById.get(m.id); if (node && node.classList.contains('msg')) drawPinMark(node, m); }
  for (const id of F.pins) if (!held.has(id)) Earlier.fetchKept(id);
  refreshPinned();
  refreshDocPinnedList();
}

/**
 * Every message pinned in a way this person sees, held (drawn in the feed yet or not), in the order every pinned place
 * draws them (plan 7-§17.5): the room's first, the newest message first, since they are what the backstage team needs
 * everyone to see; then the person's own not pinned for the room, the newest pin first. An id whose message is not held
 * (gone, or not read back yet) is passed by.
 */
function pinnedInOrder() {
  // One pass over what the page holds, however many pins: the room's as they come, this person's by their id.
  const want = new Set(F.pins);
  const room = [];
  const mine = new Map();
  for (const m of allMessages) {
    if (!m || m.type === 'system' || !(messagesById.has(m.id) || undrawn.has(m.id))) continue;
    if (m.pinned) room.push(m); else if (want.has(m.id)) mine.set(m.id, m);
  }
  const own = [];
  for (let i = F.pins.length - 1; i >= 0; i--) { const m = mine.get(F.pins[i]); if (m) own.push(m); }
  return room.reverse().concat(own);
}

/**
 * The full view's pinned strip: each message pinned for the room or for this person (text, questions and help; files are in
 * the panel's pinned list, or here for a seat with no panel) drawn afresh from its record, as the feed draws it, so every act on it is the feed's, through the
 * one delegated handler; its line says how it is pinned, and its door unpins each kind this seat may unpin. A pinned
 * question is hidden from the feed while it is pinned and answered here. The room's first (pinnedInOrder). A copy already
 * drawn is kept and drawn again in place (only `onlyId`'s, when given), and moved only when its place changed, so a
 * reaction or an answer elsewhere never takes the focus or an open menu's opener from it. An unpinned copy that held the
 * focus gives it to the message in the feed. The simple view draws its pinned bar in its place (PinBar).
 */
function refreshPinned(onlyId) {
  const strip = document.getElementById('pinnedStrip');
  const list = document.getElementById('pinnedList');
  const have = new Map([...list.querySelectorAll(':scope > .msg[data-id]')].map((n) => [n.dataset.id, n]));
  // Every pinned message held, drawn in the feed yet or not (a first open draws its older ones as the page is idle).
  // A seat with no panel (an observer, a Viewer account) lists its pinned files here too, by name.
  const panel = document.body.dataset.role !== 'observer';
  const want = F.view === 'simple' ? [] : pinnedInOrder().filter((m) => m.type !== 'file' || !panel);
  let prev = null;
  for (const m of want) {
    let copy = have.get(m.id);
    if (copy) {
      have.delete(m.id);
      if (!onlyId || onlyId === m.id) rerenderMessage(copy, m);
    } else {
      copy = renderMessage(m, { copy: true });
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
  PinBar.draw(onlyId);
}

// ---------------- The simple view's pinned bar (plan 7-§17.2, §17.5) ----------------
/**
 * Under the header (and a phone's tabs), only while the room or this person has a pin: one line, "📌 For everyone" (or "📌
 * For you", "📌 For everyone · for you"), the message's words cut to one line, and "1 of 2" where there are several, the
 * room's pins first (pinnedInOrder). The line is one button: on a message it goes to the message in the feed, outlined for
 * 2 s, and the bar then shows the next pin. A pinned question is drawn here whole, and only here (the feed hides it while it
 * is pinned, styles.css): its words, its answers and Answer in words…, "You answered Yes · 14:10 · Change" once answered,
 * and on one pinned for this person 📌 Unpin for me, its one unpin door in this view (the room's has none here, as the
 * simple view keeps the room's pin off); the line on it shows the next pin, and is no button while it is the only pin. The
 * question is drawn from its record, as the feed draws it, its acts the feed's through the one delegated handler. The full
 * view draws its pinned strip in its place.
 */
const PinBar = (function () {
  const bar = document.getElementById('bvPins');
  const head = document.getElementById('bvPinHead');
  const host = document.getElementById('bvPinQ');
  const OUTLINE_MS = 2000;
  let at = '';            // the message the bar shows
  let lineEl = null;      // its line: a button, or words where it goes nowhere
  let outlined = null;
  /** A message's words on one line (the line cuts them where they do not fit): a file by its name, help by its kind. */
  const wordsOf = (m) => (m.type === 'file' ? (m.confidential ? '🔒 ' : '') + (m.filename || 'a file')
    : m.type === 'help' ? 'Help — ' + (m.category || 'Other') + (m.text ? ': ' + m.text : '') : String(m.text || '')).replace(/\s+/g, ' ').trim();
  /** The line as a button (it goes to the message, or to the next pin) or as words, kept while it stays which it is. */
  function line(button) {
    if (lineEl && (lineEl.tagName === 'BUTTON') === button) return lineEl;
    const el = document.createElement(button ? 'button' : 'p');
    if (button) el.type = 'button';
    el.className = 'bv-pin-line';
    el.id = 'bvPinLine';
    for (const c of ['bv-pin-kind', 'bv-pin-words', 'bv-pin-count']) { const part = document.createElement('span'); part.className = c; el.appendChild(part); }
    const focused = !!lineEl && lineEl.contains(document.activeElement);
    if (lineEl) lineEl.replaceWith(el); else head.appendChild(el);
    lineEl = el;
    if (focused && button) el.focus();
    return el;
  }
  /** The question shown drawn whole under the line (its copy kept and drawn again in place), or none. */
  function drawQuestion(m, onlyId) {
    const had = host.querySelector(':scope > .msg[data-id]');
    if (!m) {
      if (!had) return;
      const focused = had.contains(document.activeElement);
      had.remove();
      if (focused) { const field = composerField(); if (field) field.focus(); }
      return;
    }
    if (had && had.dataset.id === m.id) { if (!onlyId || onlyId === m.id) rerenderMessage(had, m); return; }
    const copy = renderMessage(m, { copy: true });
    if (had) had.replaceWith(copy); else host.appendChild(copy);
  }
  function draw(onlyId) {
    const pins = F.view === 'simple' && !outOf ? pinnedInOrder() : [];
    bar.hidden = pins.length === 0;
    if (!pins.length) { at = ''; drawQuestion(null); return; }
    let i = pins.findIndex((m) => m.id === at);
    if (i < 0) i = 0;
    const m = pins[i];
    at = m.id;
    const ask = m.type === 'action';
    const n = pins.length;
    const kind = pinWords(!!m.pinned, pinnedForMe(m.id), true);
    const words = ask ? 'Question' : wordsOf(m);
    const el = line(!ask || n > 1);
    el.querySelector('.bv-pin-kind').textContent = '📌 ' + kind;
    el.querySelector('.bv-pin-words').textContent = words;
    const count = el.querySelector('.bv-pin-count');
    count.textContent = n > 1 ? (i + 1) + ' of ' + n : '';
    count.hidden = n < 2;
    // Its name: "Pinned for everyone, 1 of 2: <the words>. Go to it"; on a question, "… Next pin".
    if (el.tagName === 'BUTTON') el.setAttribute('aria-label', 'Pinned ' + kind.charAt(0).toLowerCase() + kind.slice(1) + (n > 1 ? ', ' + (i + 1) + ' of ' + n : '') + ': ' + words + '. ' + (ask ? 'Next pin' : 'Go to it'));
    el.dataset.id = m.id;
    // While it draws a question, the bar is a group labelled by its line, the question's words and answers after it.
    if (ask) { bar.setAttribute('role', 'group'); bar.setAttribute('aria-labelledby', 'bvPinLine'); } else { bar.removeAttribute('role'); bar.removeAttribute('aria-labelledby'); }
    drawQuestion(ask ? m : null, onlyId);
  }
  /** A message in the feed, gone to and outlined for 2 s (no motion where the person asks for less); one not drawn yet, read back. */
  function go(m) {
    const node = messagesById.get(m.id);
    if (!node || !node.isConnected) { goToQuoted(m.id, lineEl); return; }
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    if (outlined && outlined.node !== node) { clearTimeout(outlined.timer); outlined.node.classList.remove('found'); }
    node.classList.add('found');
    if (outlined) clearTimeout(outlined.timer);
    outlined = { node, timer: setTimeout(() => { node.classList.remove('found'); outlined = null; }, OUTLINE_MS) };
  }
  head.addEventListener('click', (e) => {
    const el = e.target.closest('button.bv-pin-line');
    if (!el) return;
    e.preventDefault();
    const pins = pinnedInOrder();
    const i = pins.findIndex((m) => m.id === at);
    if (i < 0) { draw(); return; }
    if (pins[i].type !== 'action') go(pins[i]);
    at = pins[(i + 1) % pins.length].id;
    draw();
  });
  /** The message the bar shows now ('' for none). */
  const shown = () => (bar.hidden ? '' : at);
  return { draw, shown };
})();

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
/** The file open in the panel now: {msg} for a file of the room, {file} for the copy on this device; null for none. */
let previewing = null;

/**
 * A file of the room opened in this person's own panel (👁 Look On stage, 👁 Preview backstage): it reports nothing and
 * pushes nothing but to the person's own devices and the admin's support view of them (`userState 'doc'`). A file for
 * download only is never opened.
 */
function openDocInPanel(msg) {
  if (!msg || msg.type !== 'file' || msg.transferOnly || !isFileUrl(msg.url)) return;
  currentDocMsgId = msg.id;
  previewing = { msg };
  openPanel((msg.confidential ? '🔒 Confidential · ' : '') + (msg.filename || ''), msg.caption || '', !!msg.priority);
  drawDoc({ url: msg.url }, msg.filename, msg.mime, null);
  if (!_applyingRemote) pushUserState('doc', { messageId: msg.id });
  drawDocActs();
}
/**
 * A file on this device opened in the Preview from its own copy (`File`): instant, private, and nothing uploaded. It is on
 * this device only: no other page of the person's follows it until it is shared.
 */
function openLocalInPanel(file) {
  currentDocMsgId = null;
  previewing = { file };
  openPanel(file.name || '', '', false);
  drawDoc({ file }, file.name, file.type, null);
  drawDocActs();
}
function openPanel(title, caption, priority) {
  docPanel.dataset.state = 'live';
  setStageCollapsed && setStageCollapsed(false);
  docPanel.classList.toggle('priority', priority);
  docTitleEl.textContent = title;
  docCaptionEl.hidden = !caption;
  docCaptionEl.textContent = caption;
  docActions.hidden = false;
}

// The panel's document is drawn by docview.mjs (imported at the first file opened): the readers, the page box, zoom,
// find and the kept place are its, and the drawing is chosen by this page's own seat, never by the file. The AI's copy
// of the document's text is read only on a backstage seat (the admin's support view reads as one).
/** This page's seat as the readers read it: the research seat (Backstage, or the support view), the Board's, or an observer's. */
const docSeat = () => (ADMIN_VIEW || pageFacts.role === 'research' ? 'research' : pageFacts.role === 'board' ? 'board' : 'observer');
let docViewMod = null;     // docview.mjs, once imported
let docView = null;        // the view drawing the panel's document now
let docDrawing = 0;        // each drawing numbered: only the newest may draw or set the AI's text
let docShown = false;      // whether the panel's reader drew the file it opened (its ready said 'shown')
/** The document on stage as plain text, for AI drafts (capped by the reader, hidden parts left out). */
const docForAi = { id: null, name: '', text: '' };
/**
 * Whether a device that cannot open documents lacks the reader for a file (plan 4-§5.15.2): pdf.js (a PDF) and the
 * document worker's inflater (a zipped Word, Excel or PowerPoint file), by docview.mjs's kind and the file's type (an Excel
 * 97-2003 workbook is not zipped); and what such a device says in a document's place, to the Board or an observer, and
 * backstage.
 */
const readerNeeded = (kind, name) => ['pdf', 'word', 'deck'].includes(kind) || (kind === 'book' && extOfName(name) !== 'xls');
const NO_DOCS_WORDS = 'This device cannot open documents — ask the backstage team to show you a picture.';
const NO_DOCS_HERE = 'This device cannot open documents: open it on another device, or show a picture of it.';
/** The document reader (docview.mjs), imported once. */
async function docReader() {
  if (!docViewMod) docViewMod = await import('/docview.mjs');
  return docViewMod;
}
async function drawDoc(source, name, mime, at) {
  const n = ++docDrawing;
  docShown = false;
  if (docView) { docView.destroy(); docView = null; }
  PickBar.reset();
  docForAi.id = null; docForAi.name = ''; docForAi.text = '';
  docDisplay.textContent = '';
  PreviewBar.draw();
  const wait = document.createElement('p');
  wait.className = 'muted';
  wait.textContent = 'Opening ' + (name || 'the file') + '…';
  docDisplay.appendChild(wait);
  try {
    await docReader();
  } catch {
    if (n !== docDrawing) return;
    wait.className = 'error';
    wait.textContent = 'This device could not load the document reader.';
    return;
  }
  if (n !== docDrawing) return;
  docDisplay.textContent = '';
  // A device that cannot open documents (DOCS) says so for a file pdf.js or the document worker reads, in place of a
  // reader that would fail on it; a picture, a CSV, Markdown and text need neither, and are drawn.
  if (!DOCS && readerNeeded(docViewMod.kindOf(name, mime), name)) {
    const p = document.createElement('p');
    p.className = 'take-device';
    p.textContent = docSeat() === 'research' ? NO_DOCS_HERE : NO_DOCS_WORDS;
    docDisplay.appendChild(p);
    PreviewBar.draw();
    return;
  }
  const view = docViewMod.open(docDisplay, source, { at, seat: docSeat(), name, mime });
  docView = view;
  // On a backstage seat what is highlighted in it is a pick, which the Preview's bar sends (PickBar).
  if (docSeat() === 'research') PickBar.watch(view);
  const drawn = await view.ready;
  if (n !== docDrawing) return;
  docShown = drawn.state === 'shown';
  PreviewBar.draw();
  if (!docShown) return;
  const text = await view.text();
  if (n !== docDrawing || !text) return;
  // A file on this device is the researcher's own to draft from; a file of the room by its message, and never one marked
  // confidential, whose text is not sent to the AI (plan 4-§5.12).
  const msg = previewing && previewing.msg ? findMessage(previewing.msg.id) || previewing.msg : null;
  if (msg && msg.confidential) return;
  docForAi.id = msg ? msg.id : null; docForAi.name = name || ''; docForAi.text = text;
}

/** What the panel says when nothing is open in it, by the seat it is drawn for: the Board's 📺 On stage, the Preview. */
const PANEL_WORDS = {
  board: ['📺 On stage', 'Nothing on stage.', 'What the backstage team shows you appears over the chat or here; ' + AGM.mark('minimised') + ' Minimise keeps it here.'],
  research: ['👁 Preview — the Board does not see this', 'Nothing in your preview.', 'Attach a file (📎) or open one with Preview to page through it, then show the Board a picture of a page or the document.'],
};
/** The panel's heading: 📺 Shown to you in the simple view; else the seat's (the Board's 📺 On stage, the Preview backstage). */
const panelHeading = () => (document.body.dataset.view === 'simple' ? '📺 Shown to you' : (PANEL_WORDS[docSeat()] || PANEL_WORDS.board)[0]);
/** The panel's heading and its empty words, by this page's seat and view (drawn as the page joins and as its view changes). */
function drawPanelWords() {
  const w = PANEL_WORDS[docSeat()] || PANEL_WORDS.board;
  document.getElementById('docPanelTitle').textContent = panelHeading();
  docPanel.setAttribute('aria-label', panelHeading());
  const empty = docDisplay.querySelector('.empty-state');
  if (empty) { empty.textContent = ''; const p = document.createElement('p'); p.textContent = w[1]; const h = document.createElement('p'); h.className = 'hint'; h.textContent = w[2]; empty.append(p, h); }
}

function dismissDoc() {
  currentDocMsgId = null;
  previewing = null;
  docDrawing++;
  docShown = false;
  if (docView) { docView.destroy(); docView = null; }
  PickBar.reset();
  drawDocActs();
  docForAi.id = null; docForAi.name = ''; docForAi.text = '';
  docPanel.dataset.state = 'empty';
  docPanel.classList.remove('priority');
  docDisplay.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  docDisplay.appendChild(empty);
  drawPanelWords();
  docCaptionEl.hidden = true;
  docCaptionEl.textContent = '';
  docTitleEl.textContent = '';
  docActions.hidden = true;
  PreviewBar.draw();
}

// ---------------- The panel's files: the file open in it (the Preview's header) and its pinned list (kind `file`) ----------------
/** A file as the catalogue sees it: its message's record, and where it is drawn ('preview' or 'list'). */
const fileObject = (id, where) => { const m = findMessage(id); return m && m.type === 'file' ? Object.assign({}, m, { where }) : null; };
const docActs = document.getElementById('docActs');
/** The open file's bar: its inline acts with their words (📌 Pin, Close) and its ⋯. */
function drawDocActs() {
  const o = currentDocMsgId ? fileObject(currentDocMsgId, 'preview') : null;
  // Emptied, it is drawn afresh next time: the bar's record of what it last drew goes with its buttons.
  if (!o) { docActs.textContent = ''; drawnActs.delete(docActs); return; }
  docActions.dataset.fileId = o.id;
  drawBar(docActs, 'file', o, { words: true, more: 'More for this file' });
}

/**
 * The panel's pinned files: each file pinned for the room or for this person, the room's first (pinnedInOrder), each saying
 * how it is pinned; its door unpins each kind this seat may unpin, and an entry pinned only in a way this seat may not
 * unpin (the room's, for an observer or On stage) has none.
 */
function refreshDocPinnedList() {
  docPinnedList.textContent = '';
  let count = 0;
  for (const m of pinnedInOrder()) {
    if (m.type !== 'file') continue;
    count++;
    const li = document.createElement('li');
    li.className = 'file-entry';
    li.dataset.fileId = m.id;
    li.dataset.key = m.id;
    // The name opens it where this seat may look (the catalogue's file.look, also the bar's 👁).
    const name = document.createElement('span');
    name.className = 'pinned-item';
    const ico = (m.mime || '').startsWith('image/') ? '🖼' : (m.mime === 'application/pdf' ? '📕' : '📄');
    name.innerHTML = `<span class="ico" aria-hidden="true">${escapeHtml(ico)}</span><span class="name">${escapeHtml((m.confidential ? '🔒 Confidential · ' : '') + m.filename)}</span>`;
    const kind = document.createElement('span');
    kind.className = 'pin-kind';
    kind.textContent = '📌 ' + pinWords(!!m.pinned, pinnedForMe(m.id), true);
    name.appendChild(kind);
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
/** A file's menu opened at its fold (📌 Pin ▸: the Preview's 📌, a pinned entry's door, P), its first entry focused. */
function openFileFold(door, anchor, fold) {
  if (openObjectMenu('file', () => fileObject(door.id, door.where), { node: door.el, more: anchor, opener: anchor, label: 'File actions', header: (o) => o.filename || 'A file' }) && AGM.menu.current()) AGM.menu.current().expand(fold);
}
docPanel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action^="file."], [data-more], #docActions [data-fold], #docPinnedList [data-fold]');
  const door = el && fileDoor(el);
  if (!door) return;
  e.preventDefault();
  if (el.dataset.more || el.dataset.fold) {
    if (openOn && openOn.kind === 'file' && openOn.id === door.id) { AGM.menu.close(); return; }
    if (el.dataset.fold) { openFileFold(door, el, el.dataset.fold); return; }
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
  if (foldIn('file', entry, o)) { openFileFold(door, door.more || door.el, entry.fold); return; }
  act('file', entry.id, o, { anchor: door.more || door.el, node: door.el, opener: door.el });
});
AGM.menu.door(docPanel, fileDoor);
AGM.roving(docPinnedList, { item: 'li[data-key]' });
Object.assign(RUN, {
  'file.screens': (o) => Screens.offer(o),
  'file.look': (o) => openDocInPanel(findMessage(o.id) || o),
  'file.download': (o) => download(o),
  'file.stage': (o, c) => Show.fromMenu(findMessage(o.id) || o, c),
  'file.pin': (o) => pinForRoom(o),
  'file.pinMine': (o) => pinForMe(o),
  'file.confidential': (o) => markFile(o),
  'file.close': () => dismissDoc(),
});

// ---------------- The confidential mark (plan 4-§5.14): one record a file, set and removed by file:mark ----------------
/** A file marked confidential, or its mark removed: the server's act, said as it answers. */
function markFile(m) {
  const on = !m.confidential;
  AGM.outbox.now('file:mark', { messageId: m.id, on }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'The mark was not changed.', true); return; }
    AGM.toast(on ? 'Marked confidential: it goes only where it is in use, or where you send it.' : 'The confidential mark is removed.');
  });
}
/**
 * A file's mark changed (`fileMark`, latest wins: the server's one record): each message here that holds it, by its id, is
 * drawn again with its mark, and so are the pinned list and the open file's header; the AI's copy of an open file now
 * marked is let go.
 */
socket.on('fileMark', (p) => {
  if (!p || !Array.isArray(p.ids)) return;
  for (const id of p.ids) {
    // The room's index of its files too: the lists drawn from it (holding pictures, Show's choices) say the mark.
    const f = typeof id === 'string' ? roomFiles.get(id) : null;
    if (f) { if (p.confidential === true) f.confidential = true; else delete f.confidential; }
    const m = findMessage(id);
    if (!m) continue;
    if (p.confidential === true) { m.confidential = true; m.markedBy = p.markedBy && typeof p.markedBy === 'object' ? p.markedBy : null; } else { delete m.confidential; delete m.markedBy; }
    const node = messagesById.get(id);
    if (node) rerenderMessage(node, m);
    if (currentDocMsgId === id) {
      docTitleEl.textContent = (m.confidential ? '🔒 Confidential · ' : '') + (m.filename || '');
      if (m.confidential && docForAi.id === id) { docForAi.id = null; docForAi.name = ''; docForAi.text = ''; }
    }
  }
  refreshDocPinnedList();
  drawDocActs();
  PreviewBar.draw();
  refreshOpenMenu();
});
/**
 * A send held by the outbox the server refused until its sender confirms a confidential file (`confirm`, plan 4-§5.14, S12):
 * asked in place, naming the room; yes holds it again with `confirm: true`, no lets it go. False for any other refusal.
 */
function confirmSecretSend(item) {
  const r = item.result;
  if (!r || r.confirm !== true || item.args.confirm === true) return false;
  const rooms = Array.isArray(r.rooms) && r.rooms.length ? r.rooms.join(' and ') : 'that room';
  const { verb, args, tag, file, upload } = item;
  AGM.outbox.drop(item.cid);
  AGM.ask(null, { title: '🔒 A confidential file', words: 'This file is marked confidential. Send it to ' + rooms + '? It will be in use there.', yes: 'Send it to ' + rooms, no: 'Keep it here' }).then((a) => {
    if (!a || !a.yes) return;
    const opts = { tag, ...(file ? { file, upload } : {}) };
    if (verb === 'forward') AGM.outbox.hold('forward', { ...args, confirm: true }, opts);
    else AGM.outbox.hold('room:send', { ...args, confirm: true }, opts);
  });
  return true;
}

// ---------------- Stage panel collapse/expand: the panel's own ⇥ and its rail ----------------
const docCollapseBtn = document.getElementById('docCollapseBtn');
const docExpandRail = document.getElementById('docExpandRail');

/** What hears the panel open or close (the takes' cards, once they are drawn: Takes). */
let stageMoved = null;
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
  // A card that arrived in the side bar is in view now, or no longer: said again.
  if (stageMoved) stageMoved();
  localStorage.setItem('agm.stageCollapsed', collapsed ? '1' : '0');
  setTimeout(rerenderCurrentDoc, 60);
  if (!_applyingRemote) pushUserState('stageCollapsed', !!collapsed);
}
function toggleStage() { setStageCollapsed(!docPanel.classList.contains('collapsed')); }

docCollapseBtn?.addEventListener('click', toggleStage);
docExpandRail?.addEventListener('click', () => setStageCollapsed(false));

if (HAS_STAGE && localStorage.getItem('agm.stageCollapsed') === '1') {
  setStageCollapsed(true);
}

/** The panel's document laid out again for its new size (a resize, a collapse, the splitter), at the place it was. */
function rerenderCurrentDoc() {
  if (previewing && docView) docView.refit();
}


// ---------------- Splitter (drag to resize columns) ----------------

/** The split this browser kept for the full view, drawn again (the simple view lays its column out by the screen's size). */
function restoreSplit() {
  if (!HAS_STAGE) return;
  const key = window.innerWidth <= 800 ? 'agm.splitPctV' : 'agm.splitPct';
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(key)); } catch { /* storage blocked: the default split */ }
  if (saved && saved >= 20 && saved <= 85) applySplit(saved);
}
restoreSplit();
window.addEventListener('resize', () => {
  // PDF needs re-render when the user resizes the browser, debounced.
  clearTimeout(window.__pdfResizeTimer);
  window.__pdfResizeTimer = setTimeout(rerenderCurrentDoc, 250);
});

function applySplit(leftPct) {
  if (!leftCol || !docPanelEl) return;
  // The simple view's column and tabs follow the screen's size alone: no split is drawn over them.
  if (pageFacts.view === 'simple') { leftCol.style.flex = ''; docPanelEl.style.flex = ''; return; }
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

// ---------------- People panel: shown and hidden from the header's ⋯ (People · n) ----------------
const peoplePanel = document.getElementById('peoplePanel');

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
  if (openOn && (openOn.kind === 'person' || openOn.kind === 'header')) refreshOpenMenu();
  Simple.people(people);
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
/** The admin's clock or countdown for a person of the room (admin:setClock), said once the server has it. */
function setClock(p, change) {
  AGM.outbox.now('admin:setClock', { roomCode: ROOM, socketId: p.socketId, ...change }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not changed.', true); return; }
    AGM.toast(p.name + '\'s clock or countdown: ' + clockSaid(r.clock) + (r.already ? ' already.' : '.'));
  });
}
/** One of the admin's On stage switches for a person of the room (admin:setOnStage), turned the other way, said once the server has it. */
function setOnStage(p, key) {
  const on = !p.onStage[key];
  AGM.outbox.now('admin:setOnStage', { roomCode: ROOM, socketId: p.socketId, [key]: on }, (r) => {
    if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not changed.', true); return; }
    const label = (AGM.catalog.ON_STAGE_SWITCHES.find(([k]) => k === key) || ['', ''])[1];
    AGM.toast(p.name + ': ' + label + (on ? ' — on' : ' — off') + (r.already ? ' already.' : '.'));
  });
}
/** The admin's choice in its words: "Stagewatch countdown, locked", "Their choice". */
const clockSaid = (c) => { const k = AGM.catalog.adminClockOf({ clock: c }); return (AGM.catalog.ADMIN_CLOCKS.find(([v]) => v === (k.show || '')) || ['', ''])[1].replace(/ \(.*\)$/, '') + (k.locked ? ', locked' : ''); };
Object.assign(RUN, {
  // The admin's choice of the view this person's pages draw: told to their pages at once, and their row redrawn.
  'person.chatView': (p, { value }) => {
    if (typeof value !== 'string') return;
    AGM.outbox.now('admin:setView', { roomCode: ROOM, socketId: p.socketId, view: value }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not changed.', true); return; }
      AGM.toast(p.name + '\'s pages draw ' + (value === 'simple' ? 'the simple view' : value === 'full' ? 'the full view' : 'the view of their seat') + (r.already ? ' already.' : ' now.'));
    });
  },
  // The admin's clock or countdown for this person ('' their own choice, which takes a lock off with it) and its lock:
  // told to their pages at once.
  'person.clock': (p, { value }) => {
    if (typeof value !== 'string') return;
    setClock(p, AGM.catalog.clockChange(value));
  },
  'person.clockLock': (p) => setClock(p, { locked: !p.clock.locked }),
  // What a person seated On stage may do (plan 7-§17.6): each switch turned the other way, told to their pages at once.
  'person.onStageScreens': (p) => setOnStage(p, 'screens'),
  'person.onStagePeople': (p) => setOnStage(p, 'people'),
  'person.onStageClears': (p) => setOnStage(p, 'clears'),
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
/**
 * 🔒 Confidential beside 🔥 Priority on a file attached (the catalogue's compose.confidential): off by default, and off
 * again after each share; the file is marked as it is shared.
 */
const confidentialBtn = document.getElementById('textConfidentialBtn');
confidentialBtn?.addEventListener('click', () => { const o = composeObject('text'); if (o) act('compose', 'compose.confidential', o, { opener: confidentialBtn, anchor: confidentialBtn }); });
function setConfidential(on) {
  if (!confidentialBtn) return;
  confidentialBtn.dataset.confidential = on ? '1' : '0';
  confidentialBtn.classList.toggle('on', on);
  confidentialBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  confidentialBtn.title = on ? 'Confidential is ON: the file goes only where it is in use, or where you send it — click to turn it off' : 'Mark the file confidential: it goes only where it is in use, or where you send it';
}
function consumeConfidential() {
  const v = !!confidentialBtn && confidentialBtn.dataset.confidential === '1';
  setConfidential(false);
  return v;
}
const dirPriBtn = wirePriority('dirPriorityBtn', 'director');
const textPriBtn = wirePriority('textPriorityBtn', 'text');
const actionPriBtn = wirePriority('actionPriorityBtn', 'action');
const PRIORITY = { director: () => dirPriBtn, text: () => textPriBtn, action: () => actionPriBtn };

// ---------------- The composer's doors (catalog.js, kind `compose`) ----------------
// Its Send button is its one act on the row and its ⋯ the door to the rest (✨ Draft a reply, 🔥 Priority, Attach a
// file…, Remove the file, Cancel the reply); a right-click or Shift+F10 on either (or on the file chosen) opens the same
// list, while the text field keeps the browser's own menu. A send, from Send, Enter or the menu, runs through act().
/** The composer shown: 'director' On stage; backstage the open tab's, 'text' or 'action'; '' for none. */
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
  const t = f === 'text' ? targetNow() : null;
  // A question is asked of the Board in a Main room, and of the room by its name in a side room, which has no Board.
  const askWho = f === 'action' && MAIN === false ? ROOM_NAME || 'this room' : '';
  return { id: 'compose:' + f, form: f, room: t ? t.name || t.hallName : ROOM_NAME, to: t ? t.ref : '', file: f === 'text' && pendingFile ? pendingFile.filename : '', replying: replyState ? replyState.name : '', priority: !!pri && pri.dataset.priority === '1', askWho,
    confidential: f === 'text' && !!confidentialBtn && confidentialBtn.dataset.confidential === '1' };
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
  return now === 'text' ? textInput : now === 'quote' ? QuoteTab.field() : actionText;
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
    // Its word says where it goes when that is another room ("Send to Legal"), with a file attached that it is shared
    // for download ("📎 Share for download", "📎 Share in Legal"), and on a question whom it asks ("❓ Ask the Board").
    const word = send.querySelector('.send-word');
    const said = o.to || o.file || form === 'action' ? inl.label : 'Send';
    if (word && word.textContent !== said) word.textContent = said;
    const icon = send.querySelector('.send-icon');
    const glyph = inl.icon || '➤';
    if (icon && icon.textContent !== glyph) icon.textContent = glyph;
    send.title = inl.disabled || inl.label;
    if (inl.disabled) send.setAttribute('aria-disabled', 'true'); else send.removeAttribute('aria-disabled');
  }
  // 📎 in the message row, where this seat attaches files; 🔒 Confidential beside 🔥 while a file is attached.
  const clip = form === 'text' ? document.getElementById('attachBtn') : null;
  if (clip) clip.hidden = !AGM.catalog.shown('compose', F, o).some((e) => e.id === 'compose.attach');
  if (form === 'text' && confidentialBtn) {
    confidentialBtn.hidden = !AGM.catalog.shown('compose', F, o).some((e) => e.id === 'compose.confidential');
    if (confidentialBtn.hidden) setConfidential(false);
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
function drawComposers() { for (const form of Object.keys(COMPOSER_FORMS)) drawCompose(form); drawTo(); drawAlso(); }
/** Also on drawn as the facts say it now, once it is built (below): every composer's redraw redraws it. */
function drawAlso() { if (drawAlso.ready) Also.draw(); }
/** Got it clears drawn as the facts and the messages say it now, once it is built (below). */
function drawCleared() { if (drawCleared.ready) Cleared.draw(); }
const FORM_OF = new Map();   // a composer's form element → its name
function composeDoor(t) {
  const formEl = t.closest('form');
  const form = formEl && FORM_OF.get(formEl);
  if (!form || !t.closest('.send-btn, .compose-more, #fileChip')) return null;
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
    // Also on a countdown screen or everyone On stage: sent now, never held (Also.send); else held as every message is.
    // One such send at a time: a second Send while the first waits for its answer sends nothing.
    if (Also.busy()) return;
    const also = Also.take();
    if (also) { Also.send(text, also); return; }
    holdMessage('director', { type: 'text', text, priority: consumePriority(dirPriBtn), replyTo: consumeReplyTo() });
  },
  text: () => {
    const text = textInput.value.trim();
    if (composerHeld('text')) return;
    // A file attached is shared for download, its words its caption; it is uploaded as it is sent (the outbox's), never
    // before: the copy on this device is all there is until then.
    if (pendingFile) {
      const secret = consumeConfidential();
      holdMessage('text', {
        type: 'file', url: pendingFile.url || '', filename: pendingFile.filename, mime: pendingFile.mime, caption: text.slice(0, 500),
        priority: consumePriority(textPriBtn), replyTo: consumeReplyTo(), ...(secret ? { confidential: true } : {}),
      }, { file: pendingFile.file, upload: uploadFile });
      return;
    }
    if (!text) return;
    holdMessage('text', { type: 'text', text, priority: consumePriority(textPriBtn), replyTo: consumeReplyTo(), aiDraft: aiDrafted });
  },
  action: () => {
    const text = actionText.value.trim();
    if (!text || composerHeld('action')) return;
    holdMessage('action', { type: 'action', text, options: currentOptions.slice(), priority: consumePriority(actionPriBtn), replyTo: consumeReplyTo() });
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
  'compose.confidential': (o) => setConfidential(!o.confidential),
  'compose.sendTo': (o, { value }) => { setSendTo(typeof value === 'string' ? value : ''); const field = composerField(); if (field) field.focus(); },
  'compose.attach': () => { selectTab('text'); fileInput.click(); },
  'compose.removeFile': () => { removePendingFile(); textInput.focus(); },
  'compose.cancelReply': () => { cancelReply(); const field = composerField(); if (field) field.focus(); },
  'compose.also': (o, { value }) => Also.toggle(value),
});

// ---------------- Compose: director ----------------
const dForm = document.getElementById('directorForm');
const dInput = document.getElementById('directorInput');
dForm?.addEventListener('submit', (e) => { e.preventDefault(); sendFrom('director', e.submitter); });

// ---------------- Also on: where else a message from On stage goes (plan 7-§17.6) ----------------
// A row above the On stage composer's field, only while the admin has turned on one of the person's switches: a chip for
// each (the catalogue's compose.also), an aria-pressed toggle, ✓ and filled when on, off after every send. With ⏱ chosen,
// the field holds a countdown screen's line (160 characters) and says what it replaces, with the count. A message with a
// chip on is sent now, never held (the outbox's `now`): refused while not connected, its text, its 🔥, its reply and its
// chips kept for another try, and on a refusal the server's words said.
const Also = (function () {
  const row = document.getElementById('alsoRow');
  const chipsEl = document.getElementById('alsoChips');
  const line = document.getElementById('alsoLine');
  const chosen = { screens: false, people: false };
  let busy = false;
  const object = () => { const o = composeObject('director'); return o ? { ...o, also: { ...chosen } } : null; };
  const chipsNow = () => {
    const o = object();
    return o && AGM.catalog.shown('compose', F, o).some((e) => e.id === 'compose.also') ? AGM.catalog.submenu('compose', 'compose.also', F, o) || [] : [];
  };
  function draw() {
    const chips = chipsNow();
    // A chip the admin turned off, or one that waits (no countdown screen now), is chosen no more.
    for (const k of Object.keys(chosen)) if (!chips.some((c) => c.value === k && !c.disabled)) chosen[k] = false;
    row.hidden = !chips.length;
    const keys = chips.map((c) => c.value).join(',');
    if (chipsEl.dataset.keys !== keys) {
      chipsEl.dataset.keys = keys;
      chipsEl.textContent = '';
      for (const c of chips) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost small also-chip';
        b.dataset.value = c.value;
        const tick = document.createElement('span');
        tick.className = 'also-tick';
        tick.setAttribute('aria-hidden', 'true');
        tick.textContent = AGM.mark('ok') + ' ';
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = c.icon + ' ';
        const name = document.createElement('span');
        name.className = 'also-name';
        b.append(tick, icon, name);
        chipsEl.append(b);
      }
    }
    for (const c of chips) {
      const b = chipsEl.querySelector('.also-chip[data-value="' + c.value + '"]');
      if (!b) continue;
      const name = b.querySelector('.also-name');
      // On a phone, "👥 On stage": the long words where there is room (styles.css), the short ones to every reader.
      const words = c.short ? c.label.slice(0, c.label.length - c.short.length) : '';
      name.textContent = '';
      if (words) { const long = document.createElement('span'); long.className = 'also-long'; long.textContent = words; name.append(long, document.createTextNode(c.short)); } else name.textContent = c.label;
      b.setAttribute('aria-pressed', chosen[c.value] ? 'true' : 'false');
      b.classList.toggle('on', chosen[c.value]);
      if (c.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      b.title = c.disabled || c.names || c.label;
      b.disabled = busy;
    }
    // With ⏱ chosen: what it replaces, the count against the screen's line, and the field held to it.
    const names = F.onStage.countdownScreens;
    const max = chosen.screens ? AGM.catalog.COUNTDOWN_LINE : 300;
    if (dInput.maxLength !== max) dInput.maxLength = max;
    line.hidden = !chosen.screens;
    if (chosen.screens) {
      document.getElementById('alsoWhat').textContent = names.length === 1 ? 'Replaces ' + names[0] + '\'s countdown line.' : 'Replaces the countdown line on ' + names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + '.';
      document.getElementById('alsoCount').textContent = dInput.value.trim().length + ' / ' + AGM.catalog.COUNTDOWN_LINE;
    }
  }
  /** A chip turned the other way (the catalogue's compose.also, through act()); one that waits says why. */
  function toggle(value) {
    const c = chipsNow().find((x) => x.value === value);
    if (!c) return;
    if (c.disabled) { AGM.toast(c.disabled, true); return; }
    chosen[value] = !chosen[value];
    draw();
  }
  /** The places chosen for the message being sent now ({screens?, people?}), each chip off again; null for none. */
  function take() {
    const a = { ...(chosen.screens ? { screens: true } : {}), ...(chosen.people ? { people: true } : {}) };
    chosen.screens = false;
    chosen.people = false;
    draw();
    return Object.keys(a).length ? a : null;
  }
  /**
   * The message sent now, with where else it goes: the field cleared once the server took it; refused (or not connected),
   * its text, 🔥, reply and chips kept, and the server's words said.
   */
  function send(text, also) {
    const reply = replyState;
    const args = { type: 'text', text, priority: consumePriority(dirPriBtn), replyTo: consumeReplyTo(), also };
    busy = true;
    draw();
    AGM.outbox.now('message', args, (r) => {
      busy = false;
      if (r && r.ok) {
        if (dInput.value.trim() === text) dInput.value = '';
        draw();
        return;
      }
      setPriority(dirPriBtn, !!args.priority);
      if (reply && !replyState) { replyState = reply; renderReplyChip(); }
      for (const k of Object.keys(also)) chosen[k] = true;
      draw();
      AGM.toast((r && r.error) || 'Not sent.', true);
    });
  }
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.also-chip');
    const o = b && object();
    if (o) act('compose', 'compose.also', o, { value: b.dataset.value, opener: b, anchor: b });
  });
  dInput.addEventListener('input', () => { if (chosen.screens) draw(); });
  return { draw, toggle, take, send, busy: () => busy };
})();
drawAlso.ready = true;

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
  // The document's text names where it comes from (`docFrom`): its message here, or this device's own copy.
  const docFrom = !docForAi.text ? null : docForAi.id ? { messageId: docForAi.id } : { local: true };
  socket.emit('ai:draft', {
    question: q ? q.text || '' : '',
    instruction: textInput.value.trim(),
    docName: docForAi.name, docText: docForAi.text, ...(docFrom ? { docFrom } : {}),
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

// ---------------- A file attached to the next message: 📎, or dropped or pasted on the feed or the composer ----------------
// It is a chip in the composer and opens in the Preview from the copy on this device (backstage): nothing reaches
// AGMessage until it is shared (📎 Share for download, the words its caption) or shown (the Preview's bar). The outbox
// uploads it as it is sent.
const fileInput = document.getElementById('fileInput');
const fileChip = document.getElementById('fileChip');
const attachBtn = document.getElementById('attachBtn');
let pendingFile = null;   // {file, filename, size, mime, url: '' until uploaded, transfer: whether it is only ever transferred}

fileInput?.addEventListener('change', () => { attachFile(fileInput.files && fileInput.files[0]); fileInput.value = ''; });
attachBtn?.addEventListener('click', () => { const o = composeObject('text'); if (o) act('compose', 'compose.attach', o, { opener: attachBtn, anchor: attachBtn }); });
/** Whether this page may attach a file now: the backstage composer is drawn, and its seat shares files here. */
const attaches = () => { const o = composeObject('text'); return !!o && AGM.catalog.shown('compose', F, o).some((e) => e.id === 'compose.attach'); };
// A file dropped or pasted on the feed or the composer attaches it, as 📎 does.
for (const host of [document.getElementById('feed'), document.getElementById('researchCompose')]) {
  host.addEventListener('dragover', (e) => { if (attaches() && e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); host.classList.add('drop-hover'); } });
  host.addEventListener('dragleave', () => host.classList.remove('drop-hover'));
  host.addEventListener('drop', (e) => {
    host.classList.remove('drop-hover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !attaches()) return;
    e.preventDefault();
    attachFile(f);
  });
}
document.getElementById('researchCompose').addEventListener('paste', (e) => {
  const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
  if (!f || !attaches()) return;
  e.preventDefault();
  attachFile(f);
});

/**
 * A file to this hall's uploads, with the upload token of the page's newest join: `{url, filename, mime, size,
 * transferOnly}`, or why not — `{status, error}` when the server refused it, `{network: true}` when it never reached
 * AGMessage.
 */
async function uploadFile(file, from = '') {
  const fd = new FormData();
  // What a picture was drawn of (`m:<messageId>` of this room), before the file: its mark is the source's.
  if (typeof from === 'string' && from) fd.append('from', from);
  fd.append('file', file, file.name);
  let res;
  try { res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } }); } catch { return { network: true, error: 'Can\'t reach AGMessage — the file goes when the connection is back.' }; }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON: the status words stand */ }
  if (!res.ok || !body || typeof body.url !== 'string') return { status: res.status, error: (body && body.error) || 'Upload failed.' };
  return body;
}

/** The Compound File header (lib/guard.js isCompoundFile): a Word, Excel or PowerPoint file protected with a password starts so. */
const CFB_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/**
 * Whether a file on this device is only ever transferred, as the server will take it: a transfer type by its name
 * (AGM.catalog.TRANSFER_EXT), or a Word, Excel or PowerPoint name whose first eight bytes are a compound file's (a file
 * protected with a password, which no reader opens). Bytes that cannot be read are not opened here either.
 */
async function transferOnlyOnDevice(file) {
  const ext = extOfName(file.name);
  if (AGM.catalog.TRANSFER_EXT.includes(ext)) return true;
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return head.length === 8 && CFB_HEAD.every((b, i) => head[i] === b);
  } catch {
    return true;   // unread: kept for download, never opened here
  }
}
/**
 * A file attached to the next message: its chip drawn, and, backstage, opened in the Preview from the copy on this
 * device, unless it is only ever transferred (its chip then says "download only").
 */
function attachFile(file) {
  if (!file) return;
  selectTab('text');
  const held = { file, filename: file.name, size: file.size, mime: file.type || '', url: '', transfer: AGM.catalog.TRANSFER_EXT.includes(extOfName(file.name)) };
  pendingFile = held;
  renderFileChip();
  drawCompose('text');
  textInput.focus();
  if (held.transfer) return;
  transferOnlyOnDevice(file).then((only) => {
    if (pendingFile !== held) return;
    if (only) { held.transfer = true; renderFileChip(); } else if (docSeat() === 'research') openLocalInPanel(file);
  });
}
/** The file attached is put down: nothing to share until another is attached. The Preview keeps it open when asked to. */
function removePendingFile({ keepPreview = false } = {}) {
  const was = pendingFile;
  pendingFile = null;
  fileChip.hidden = true;
  fileChip.textContent = '';
  drawCompose('text');
  if (!keepPreview && was && previewing && previewing.file === was.file) dismissDoc();
}
/** The attached file's chip: its name, kind and size ("download only" for a type AGMessage never opens), and Remove. */
function renderFileChip() {
  fileChip.textContent = '';
  if (!pendingFile) { fileChip.hidden = true; return; }
  const transfer = pendingFile.transfer === true;
  const words = document.createElement('span');
  words.className = 'file-chip-words';
  words.textContent = [(transfer ? '📦 ' : '📎 ') + pendingFile.filename, sizeWords(pendingFile.size), transfer ? 'download only' : ''].filter(Boolean).join(' · ');
  // Its Remove is the catalogue's compose.removeFile, named as its menu item is.
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'btn ghost small';
  rm.textContent = 'Remove';
  rm.setAttribute('aria-label', AGM.catalog.entry('compose', 'compose.removeFile').label);
  rm.addEventListener('click', () => { const o = composeObject('text'); if (o) act('compose', 'compose.removeFile', o, { opener: rm, anchor: rm }); });
  fileChip.append(words, rm);
  fileChip.hidden = false;
}

for (const [name, el] of [['director', dForm], ['text', textPane], ['action', actionPane]]) if (el) FORM_OF.set(el, name);

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
  asks: 0,          // the questions among them (the simple view names them)
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
 * leaves a place above the view. `skip`: a row that is moved itself (Show earlier, above earlier messages drawn under
 * it), never the one kept.
 */
function holdView(move, skip = null) {
  const top = feed.getBoundingClientRect().top;
  const anchor = [...feed.children].find((n) => n !== place.divider && n !== skip && n.getBoundingClientRect().bottom > top);
  const was = anchor ? anchor.getBoundingClientRect().top : 0;
  move();
  if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - was;
}
/** A message that reached the hall: it may move the divider, and the feed follows it or counts it below. */
function keepPlace(el, msg, follow) {
  // A question pinned in a way this person sees is drawn in the pinned place alone: never news below the feed.
  const news = msg.type !== 'system' && !isMine(msg) && !(msg.type === 'action' && isPinned(msg));
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
  else if (news) drawNewBelow(place.unread + 1, place.asks + (msg.type === 'action' ? 1 : 0));
}
/**
 * "↓ n new" below a feed scrolled up; the simple view names the questions among them: "↓ 3 new · 1 question", or
 * "↓ 1 question" when they are all questions.
 */
function drawNewBelow(n, asks = 0) {
  place.unread = n;
  place.asks = n ? asks : 0;
  newBelow.hidden = n === 0;
  const q = (k) => k + (k === 1 ? ' question' : ' questions');
  newBelow.textContent = F.view !== 'simple' || !place.asks ? '↓ ' + n + ' new' : n === place.asks ? '↓ ' + q(n) : '↓ ' + n + ' new · ' + q(place.asks);
  newBelow.setAttribute('aria-label', n + (n === 1 ? ' new message' : ' new messages') + (F.view === 'simple' && place.asks ? ', ' + q(place.asks) + ',' : '') + ' below');
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
  // This device's own clock or countdown, for the admin's support view (the server tells it nobody else).
  if (Clock.own()) pushUserState('clock', Clock.own());
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

socket.on('userState:push', ({ key, value, support } = {}) => {
  if (window.AGM_DEBUG_SYNC) console.log('[sync] recv', key, value);
  // The simple view takes no theme from the admin's support view (`support`): only the person turns a Board page light.
  if (key === 'theme' && support === true && F.view === 'simple') return;
  _applyingRemote = true;
  try {
    if (key === 'theme' && (value === 'light' || value === 'dark')) {
      localStorage.setItem('agm.theme', value);
      applyTheme(value);
    } else if (key === 'zoom' && typeof value === 'number') {
      setZoom(value);
    } else if (key === 'clock') {
      Clock.relayed(value);
      Simple.sheetChanged();
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
  // The header's menu, open, says the theme and the text size as they are now.
  refreshOpenMenu();
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
  // A Board member's 👍 is their Got it (the simple view's answer to the backstage team): said with their names.
  const got = reactions.filter((r) => r.emoji === '👍' && (r.role === 'board' || r.role === 'director')).map((r) => r.name);
  if (got.length) {
    const line = document.createElement('span');
    line.className = 'got-line';
    line.textContent = '👍 ' + (got.length === 1 ? got[0] : got.length === 2 ? got[0] + ' and ' + got[1] : got.slice(0, 2).join(', ') + ' and ' + (got.length - 2) + ' more') + ' got it';
    rx.appendChild(line);
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
  // The words' field of the composer drawn (the backstage composer's Message tab opened for it), so the chip is seen.
  const el = composerField({ text: true });
  if (el) el.focus();
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
    '<button type="button" class="reply-cancel" title="Cancel the reply (Esc)" aria-label="Cancel the reply">' + (F.view === 'simple' ? '× Cancel' : '×') + '</button>';
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
  /** [state, the mark's name in AGM.MARKS, words] for the chip: '' at rest. */
  function chipOf(m) {
    if (m && m.help && m.help.state === 'coming') return ['coming', 'coming', (m.help.by || 'Someone') + ' is on the way'];
    if (m) return ['open', 'urgent', 'Help asked'];
    if (resolved) return ['resolved', 'ok', 'Resolved'];
    return ['', '', 'Help'];
  }
  /** The ask's words: its request and where it stands, then what each answer does to it for everyone. */
  function askWords(m) {
    const h = m.help || { state: 'open' };
    return [m.category + (m.text ? ': ' + m.text : '') + ' · ' + (h.state === 'coming' ? AGM.mark('coming') + ' ' + (h.by || 'Someone') + ' is on the way' : AGM.mark('urgent') + ' ' + HELP_WORDS.open), ASK_THEN];
  }
  function draw() {
    if (resolved && !findMessage(resolved.id)) forgetResolved();
    const m = openRequest();
    const [state, mark, words] = chipOf(m);
    const key = state + '|' + words;
    if (key !== drawn) {
      drawn = key;
      // One status chip: the mark, its words and its colour (the open request on the fault red, so red means something).
      AGM.chip(btn, mark, words);
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

// ---------------- Screens & pages: the hall's screens (accounts with display.control) and its people's pages ----------------
// Tick the screens, then take: holding, countdown, clock, black, a message (alone, or under the countdown — the
// speaker's comfort monitor), or a file from the hall. Each screen says what it showed: ✓ on screen only once it has. The
// console's other tab is what people's pages show (Console, below), for a page that may change it; each tab is shown
// where this page may use it, and the tabs only with both. The hall is named by its key (HALL_KEY), from any of its rooms.
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
    if (!HALL_KEY) return;
    socket.emit('display:list', { code: HALL_KEY }, (r) => {
      if (!r || !r.ok) return;
      const first = !CAN_SCREENS;
      CAN_SCREENS = true;
      if (first) tabs();
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
      // Its state as one status chip: the server's mark (one of the table's, test/modules.test.js), its words and its colour;
      // a mark that is none of the table's reads as a fault, as the halls board draws it, never as a chip at rest.
      const st = AGM.chip(Object.assign(document.createElement('span'), { className: 'screen-state status-chip' }), AGM.markOf(d.mark) || 'fault', d.words);
      const what = document.createElement('span'); what.className = 'screen-showing'; what.textContent = d.showing;
      const head = document.createElement('div'); head.className = 'screen-line';
      head.append(pick, name, st);
      if (refused.has(d.id)) { const no = document.createElement('span'); no.className = 'screen-refused'; no.textContent = AGM.mark('fault') + ' the last take did not reach it: ' + refused.get(d.id); head.append(no); }
      // Identify on the row, and the rest of the screen's acts (the catalogue's kind `screen`) in its ⋯.
      const acts = document.createElement('div'); acts.className = 'screen-acts';
      drawBar(acts, 'screen', d, { words: true, more: 'More for ' + d.name });
      li.append(head, what, acts);
      ul.appendChild(li);
    }
    const pickH = $('holdingPick');
    const want = holdingChoice !== null ? holdingChoice : holding;
    pickH.length = 1;
    // Every picture of the room, its messages held or not (the first open's index of its files).
    const images = [...roomFiles.values()].filter((m) => /^image\/(png|jpeg|gif|webp)$/.test(m.mime));
    // A picture marked confidential is listed and never chosen: a holding image is on every screen of the hall (S3).
    for (const m of images) {
      const o = document.createElement('option');
      o.value = m.url;
      o.textContent = m.confidential ? '🔒 ' + m.filename + ' — confidential: never on screens' : m.filename;
      o.disabled = m.confidential === true;
      pickH.appendChild(o);
    }
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
  /**
   * A screen as an act's answer leaves it, put in the list and drawn before the act is said (`d`: the screen as the answer
   * gives it, which a screen moved to another hall leaves; null: removed), so the next act on it reads it as it is now,
   * whenever the list is read again.
   */
  function keep(id, d) {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (d && d.hall === HALL_KEY) list[i] = d; else list.splice(i, 1);
    render();
  }
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
      if (name && name !== d.name) AGM.outbox.now('display:update', { id: d.id, name }, (r) => { if (r && r.ok && r.display) keep(d.id, r.display); done('Renamed.')(r); });
    },
    // The new link is the screen's at once: Copy link copies it, never the one it replaced.
    'screen.rotate': (d, { anchor }) => AGM.outbox.now('display:rotate', { id: d.id }, (r) => {
      if (r && r.ok) { const now = screenOf(d.id); if (now && typeof r.path === 'string') now.path = r.path; copyText(location.origin + r.path, 'New link copied — open it on the screen.', anchor); } else AGM.toast((r && r.error) || 'Not changed.', true);
    }),
    'screen.remove': (d) => AGM.outbox.now('display:remove', { id: d.id }, (r) => { if (r && r.ok) keep(d.id, null); done('Removed.')(r); }),
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
      if (!refused.size) AGM.toast('Sent to ' + sent + ' screen' + (sent === 1 ? '' : 's') + ' — each shows ' + AGM.mark('ok') + ' once it is on screen.');
      else AGM.toast('Sent to ' + sent + ' of ' + results.length + ' screens. Not to ' + Array.from(refused.keys(), (id) => names.get(id) || id).join(', ') + ': ' + refused.values().next().value, true);
      render();
    });
  }

  // The dialog opens with the saved holding image picked, whether Screens or ⧉ opens it: an unsaved pick lives only as
  // long as the opening it was made in (cleared here, not on "close", which a hidden tab's browser may hold back).
  function open(tab) {
    if (tab) pick(tab);
    tabs();
    if (dlg.open) return;
    holdingChoice = null;
    AGM.openDialog(dlg);
  }
  // The console's two tabs, Screens and People's pages: each pane where this page may use it, the tabs only with both, and
  // the one chosen shown (People's pages first for a page that drives no screen).
  let tab = 'screens';
  function tabs() {
    const pages = F.canPush || F.canShow;
    const both = CAN_SCREENS && pages;
    $('consoleTabs').hidden = !both;
    const now = !CAN_SCREENS ? 'people' : !pages ? 'screens' : tab;
    for (const [name, button, pane] of [['screens', $('tabScreens'), $('screensPane')], ['people', $('tabPeople'), $('peoplePane')]]) {
      const on = name === now;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
      pane.hidden = !on;
    }
    $('screensTitle').textContent = !CAN_SCREENS ? 'People\'s pages' : !pages ? 'Screens in this hall' : 'Screens & pages';
  }
  function pick(name) { tab = name === 'people' ? 'people' : 'screens'; tabs(); }
  for (const [name, button] of [['screens', $('tabScreens')], ['people', $('tabPeople')]]) {
    button.addEventListener('click', () => pick(name));
    button.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      pick(name === 'screens' ? 'people' : 'screens');
      (tab === 'people' ? $('tabPeople') : $('tabScreens')).focus();
    });
  }
  function offer(msg) {
    pending = msg;
    if (msg.type === 'text') { $('screenMsgText').value = msg.text.slice(0, 300); pending = null; }
    else $('pendingPage').value = '1';   // each file offered starts on its first page
    open('screens');
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
    AGM.outbox.now('display:create', { code: HALL_KEY, name }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not added.', true); return; }
      $('newScreenName').value = '';
      ticked.add(r.display.id);
      copyText(location.origin + r.display.path, r.display.name + ' added — its link is copied: open it on that screen.', $('addScreenBtn'));
    });
  });
  $('holdingPick').addEventListener('change', () => { holdingChoice = $('holdingPick').value === holding ? null : $('holdingPick').value; });
  $('holdingSave').addEventListener('click', () => {
    const image = $('holdingPick').value;
    AGM.outbox.now('display:hallHolding', { code: HALL_KEY, image }, (r) => { if (r && r.ok) { holding = image; holdingChoice = null; } done('Holding image saved.')(r); });
  });
  // Told to every room of the hall, naming nothing: the list is read again, by the hall's key, where this page drives them.
  socket.on('displays:changed', () => { if (CAN_SCREENS) load(); });
  // The countdown on the ticked screens (every screen, until a person unticks one in Screens): the stage chip's act.
  const countdown = () => take({ kind: 'countdown' }, 'No screen is ticked in Screens: tick the ones for the countdown there.');
  /**
   * The console, opened from the header's ⋯ or the Board chip (Screens & pages…), on the tab asked for (`'people'` or
   * `'screens'`): its lists read again as it opens.
   */
  const show = (which) => { open(which); load(); Console.read(); };
  return { load, offer, redraw, of: screenOf, countdown, show, tabs };
})();

// ---------------- What this page is shown over its chat: a take, as a layer over the page or a card in its side bar ----------------
// A take is the server's to number and send (page:take, and the join's `page`); this page draws it (pagelayer.mjs, loaded
// 2 s after a Board page's join, else at its first take; a document or a picture through docview.mjs, let go with the
// take and on a withdrawal, `page:take {withdrawn}`) and says what it drew (page:report), never before: `shown` only while the page is in view, `hidden`
// while it is not, and again when that changes; `failed` with why. Back to chat and Minimise are the person's answers, on
// every page of theirs (the server tells each); the page acts at once and says so after, and the server tells it again
// where it refused. A take never moves the focus from a field being written in: it waits for the field to be left, at
// most 3 s, and the field keeps its words under the layer. While the layer covers the page, a 🔥 message from someone
// else breaks through in its strip, with Open chat, and the others are counted on its bar. The support view draws what
// the person is shown, every door disabled, and says nothing.
const Takes = (function () {
  const $ = (id) => document.getElementById(id);
  const layer = $('pageLayer');
  const box = $('layerBox');
  const what = $('layerWhat');
  const acts = $('layerActs');
  const newOn = $('layerNew');
  const strip = $('layerStrip');
  const cards = $('takeCards');
  const pastList = $('takeEarlier');
  const FIELD = 'input, textarea, select, [contenteditable="true"]';
  const WAIT_MS = 3000;
  /** How long Back to chat can be taken back (lib/pages.js AGAIN_MS): the toast's Show it again, a card's Undo. */
  const AGAIN_MS = 10000;
  /**
   * Where the takes this page is told are kept: the show, the information over it, the information beside it (in the
   * side bar beside the operator's: a card, said "in the side bar", drawn over the chat only by the person's choice), and
   * a Board page's line typed On stage (plan 7-§17.6: a card in the side bar too, which only another such line replaces).
   */
  const LAYERS = ['show', 'info', 'beside', 'line'];
  /** The places whose information arrives in the side bar, or over the show: every place but the show's. */
  const SIDES = ['info', 'beside', 'line'];
  let renderer = null;     // pagelayer.mjs, once imported
  let loading = null;
  let readied = false;     // a Board page's timed import, asked once
  // The takes this page is told now, one in each place (the show, information over it, information beside it, the Board's
  // line): {seq, content, by, at, hallName, holding, answer, arrive}, or null for none.
  const told = { show: null, info: null, beside: null, line: null };
  let past = [];           // the information taken off this page lately, the newest first: {seq, content, by, at}
  let offset = 0;          // AGMessage's clock against this device's
  let tz = '';
  let stage = null;        // Stagewatch's frame, as this page is told it
  let drawnKey = '';       // the take the layer holds, drawn ('' for none)
  let drawing = '';        // a web page the layer holds while it loads, not yet said ('' for none)
  let result = null;       // what the layer's drawing said: {state, words}
  let turn = 0;            // each draw's number: a draw a newer one overtook is let go
  let waiting = null;      // a draw waiting for a field to be left
  let again = 0;           // the take this person asked to see again: its next report says so (`again`)
  const said = { show: '', info: '', beside: '', line: '' };   // the last report sent on this socket in each place, so the same is not said twice
  // The information that arrived in the side bar (over the show's place, beside it, or the Board's line), which the person
  // chose to see over the chat: its number, in each.
  const raised = { info: 0, beside: 0, line: 0 };
  let unheld = 0;          // an information take held under blank, which the person touched to see
  let unread = 0;          // others' messages heard since the layer came up
  let hot = null;          // the newest 🔥 message from someone else since it came up
  let ticker = null;
  // The cards in the side bar (📺 On stage), one for each place: a take minimised, or information that arrived there.
  // {key, li, side, result} (`result`, what an arrived card's drawing said).
  const cardOf = { show: null, info: null, beside: null, line: null };

  const load = () => {
    if (renderer) return Promise.resolve(renderer);
    if (!loading) loading = import('/pagelayer.mjs').then((m) => { renderer = m; return m; }, (e) => { loading = null; throw e; });
    return loading;
  };
  // The page's own seat draws a document as that seat does (docview.mjs): never the take's.
  // Whether this device opens documents (DOCS): a page that cannot draws a document's stand-in in its place.
  const ctxOf = (t) => ({ stage, offset, tz, hallName: (t && t.hallName) || HALL_NAME, holding: (t && t.holding) || '', connected: socket.connected, by: (t && t.by && t.by.name) || '', seat: docSeat(), docs: DOCS });
  /**
   * What a drawing said, heard: a device that passed the documents' probe but could not import pdf.js (`device`, the take
   * then drawn as such a device draws it: its stand-in, or the words) opens no document from now on (noDocs).
   */
  const drawnSaid = (r) => { if (r && r.device === true) noDocs(); return r; };
  /** What a box holds let go: a document's reader destroyed and its object URLs revoked (pagelayer.mjs clear). */
  const clearBox = (b) => { if (renderer) renderer.clear(b); else b.textContent = ''; };
  const visible = () => document.visibilityState === 'visible';
  const keyOf = (t) => [t.seq, JSON.stringify(t.content), t.holding || '', t.hallName || '', t.arrive || ''].join('|');
  /** A take's kind as a person reads it: "the clock", "Stagewatch", "a web page". */
  const kindWords = (kind) => (AGM.catalog.SHOW_KINDS.find((x) => x[0] === kind) || [0, 0, 'something'])[2];
  // A line a person On stage typed (plan 7-§17.6) says so: "Typed by Margaret Lowe (On stage) · 14:07".
  const byWords = (t) => (t.by && t.by.name ? (t.by.onStage === true ? 'Typed by ' + t.by.name + ' (On stage)' : 'from ' + t.by.name) : '') + (t.at ? (t.by && t.by.name ? ' · ' : '') + formatTime(t.at) : '');
  /** A take that draws something and was not put away with Back to chat (a hand-back draws nothing). */
  const live = (t) => !!t && t.content.kind !== 'chat' && t.answer !== 'dismissed';
  /** Information that arrived in the side bar and stays there until the person shows it over the chat. */
  const inSide = (t) => t.arrive === 'side' && raised[t.layer] !== t.seq;
  /** A take drawn over the chat by itself or by the person's choice: not minimised, not waiting in the side bar. */
  const up = (t) => !!t && t.answer !== 'minimised' && !inSide(t);

  /**
   * Where each take this page is told is drawn now: on the layer (`over`, and its place): the Board's line, then the
   * information beside the operator's, when the person chose to see it over the chat, else the information over the show,
   * else the show; held under blank (`held`: blank is the operator's "keep this tablet dark"; a touch shows it); or as a
   * card in the side bar (`cards`: minimised, or arrived there). A take that would be on the layer but for another drawn
   * over it is `under` it.
   */
  function plan() {
    const show = live(told.show) ? told.show : null;
    const info = live(told.info) ? told.info : null;
    const beside = live(told.beside) ? told.beside : null;
    const line = live(told.line) ? told.line : null;
    const blank = !!show && show.content.kind === 'blank' && show.answer !== 'minimised';
    const lineUp = up(line);
    const besideUp = up(beside);
    const infoUp = up(info);
    const held = !lineUp && !besideUp && infoUp && blank && unheld !== info.seq ? info : null;
    const over = lineUp ? line : besideUp ? beside : infoUp && !held ? info : show && show.answer !== 'minimised' ? show : null;
    const card = (t) => (t && (t.answer === 'minimised' || inSide(t)) ? t : null);
    return {
      over, layer: !over ? '' : over === line ? 'line' : over === beside ? 'beside' : over === info ? 'info' : 'show', held, show, info, beside, line,
      under: [show && show.answer !== 'minimised' ? show : null, infoUp && !held ? info : null, besideUp ? beside : null].filter((t) => t && over && t !== over),
      cards: { show: show && show.answer === 'minimised' ? show : null, info: card(info), beside: card(beside), line: card(line) },
    };
  }

  /** A take as the server tells it (a place's `page:take`, the join's `page`, `over` and `beside`), read by type; null for none. */
  function read(t, layerName) {
    const ok = t && typeof t === 'object' && Number.isInteger(t.seq) && t.seq > 0 && t.content && typeof t.content === 'object' && typeof t.content.kind === 'string';
    if (t && Number.isFinite(t.now)) offset = t.now - Date.now();
    if (t && typeof t.tz === 'string') tz = t.tz;
    return ok ? { seq: t.seq, layer: layerName, content: t.content, by: t.by && typeof t.by === 'object' ? t.by : null, at: Number.isFinite(t.at) ? t.at : 0, hallName: typeof t.hallName === 'string' ? t.hallName : '',
      holding: typeof t.holding === 'string' ? t.holding : '', answer: t.answer === 'dismissed' || t.answer === 'minimised' ? t.answer : null, arrive: layerName !== 'show' && t.arrive === 'side' ? 'side' : 'over' } : null;
  }
  /** The Earlier entries as the server tells them, read by type: the newest first, at most 10. */
  function readPast(list) {
    return (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && Number.isInteger(e.seq) && e.content && typeof e.content === 'object' && typeof e.content.kind === 'string').slice(0, 10)
      .map((e) => ({ seq: e.seq, content: e.content, by: e.by && typeof e.by === 'object' ? e.by : null, at: Number.isFinite(e.at) ? e.at : 0 }));
  }

  /** This page joined (or joined again, on a new socket, which has said nothing yet): what it is shown now. */
  function joined(res) {
    if (Number.isFinite(res.now)) offset = res.now - Date.now();
    if (typeof res.tz === 'string') tz = res.tz;
    stage = res.stage || null;
    for (const l of LAYERS) said[l] = '';
    told.show = read(res.page || null, 'show');
    told.info = read(res.over || null, 'info');
    told.beside = read(res.beside || null, 'beside');
    told.line = read(res.line || null, 'line');
    past = readPast(res.earlier);
    settle();
    apply();
    // A Board page imports what draws a take, and the document reader, 2 s after its join is drawn, so its first
    // document or picture is not held up by an import on the venue's Wi-Fi: a timer and import(), which every device of
    // the Board's has (no modulepreload, no idle callback). A device that cannot load them says so at its first take.
    if (!readied && (res.role || ROLE) === 'board') {
      readied = true;
      setTimeout(() => { load().then((m) => m.prepare()).catch(() => { /* said at the first take that needs it */ }); }, 2000);
    }
  }
  /** What this page is shown now in a place, as the server tells it: a take, or (number 0, no content) nothing there. */
  function tell(t) {
    if (t && Number.isInteger(t.withdrawn)) { withdrawn(t.withdrawn); return; }
    const layerName = t && SIDES.includes(t.layer) ? t.layer : 'show';
    told[layerName] = read(t, layerName);
    if (layerName === 'info' && t && Array.isArray(t.earlier)) past = readPast(t.earlier);
    settle();
    apply();
  }
  /**
   * A take withdrawn (`page:take {withdrawn: seq}`): this page lets go of whatever it drew of it, on the layer, in a card,
   * under Earlier or in a Look, its reader destroyed and its pictures' object URLs revoked; what it is shown now follows.
   */
  function withdrawn(seq) {
    for (const l of LAYERS) if (told[l] && told[l].seq === seq) told[l] = null;
    past = past.filter((e) => e.seq !== seq);
    Preview.letGo(seq);
    settle();
    apply();
  }
  /** What the person chose stops counting once its take is gone: Show it again, a raised side card, a touch under blank. */
  function settle() {
    const seqs = LAYERS.map((l) => (told[l] ? told[l].seq : 0));
    if (again && !seqs.includes(again)) again = 0;
    for (const l of SIDES) if (raised[l] && (!told[l] || told[l].seq !== raised[l])) raised[l] = 0;
    if (unheld && (!told.info || told.info.seq !== unheld)) unheld = 0;
    // A Look at an Earlier entry no longer under Earlier (taken off by a reset, a delete or a withdrawal) closes.
    for (const seq of Preview.looking()) if (!past.some((e) => e.seq === seq)) Preview.letGo(seq);
  }
  socket.on('page:take', (t) => tell(t));

  /**
   * The page as the takes it is told and the person's answers to them say: the layer (information over the show), the
   * cards in its side bar, and Earlier; then each take said. `asked`: the person asked for the layer (Show again), so it
   * is drawn at once, a field holding the focus or not.
   */
  function apply(asked) {
    const p = plan();
    if (p.over) showLayer(p.over, asked === true); else hideLayer();
    drawCards(p);
    drawPast();
    sayAll();
  }

  /**
   * What this page does with each take it is told now, said to the server, one for each place: on its chat (a hand-back of
   * the show), the layer drawn in view or not, failed with why, under what is drawn over it ("under a web page"), held
   * under blank, or in the side bar; with `again` where the person asked to see it again. Never for a take not drawn yet,
   * nor one the person answered (their answer is theirs to say), nor from the support view.
   */
  function sayAll() {
    if (ADMIN_VIEW) return;
    const p = plan();
    for (const l of LAYERS) {
      const t = told[l];
      if (!t) continue;
      const st = stateOf(t, l, p);
      if (!st) continue;
      const asked = again === t.seq && (st.state === 'shown' || st.state === 'opened');
      if (asked) again = 0;
      report({ seq: t.seq, state: st.state, words: st.words, ...(asked ? { again: true } : {}) }, l, asked);
    }
  }
  function stateOf(t, l, p) {
    if (t.content.kind === 'chat') return l === 'show' ? { state: visible() ? 'shown' : 'hidden', words: '' } : null;
    if (t.answer) return null;
    // A web page is never said to be seen: in view, it opened (nothing inside its frame can be read).
    const seen = (r) => (r.state === 'failed' ? { state: 'failed', words: r.words } : !visible() ? { state: 'hidden', words: '' } : { state: r.state === 'opened' ? 'opened' : 'shown', words: '' });
    if (p.over === t) return drawnKey === keyOf(t) && result ? seen(result) : null;
    if (p.held === t) return { state: 'hidden', words: 'held under blank' };
    const c = cardOf[l];
    if (l !== 'show' && p.cards[l] === t && c && c.side && c.key === keyOf(t)) {
      if (!c.result) return null;
      const r = seen(c.result);
      if (r.state === 'failed') return r;
      // Under the layer, which is drawn over the whole page, its side bar included: in the side bar, but not in view.
      if (!layer.hidden && p.over) return { state: 'hidden', words: 'under ' + kindWords(p.over.content.kind) };
      // The side bar collapsed, or behind the simple view's Shown to you tab: out of view.
      if (!c.li.getClientRects().length) return { state: 'hidden', words: '' };
      return { ...r, words: 'in the side bar' };
    }
    if (p.under.includes(t)) return { state: 'hidden', words: 'under ' + kindWords(p.over.content.kind) };
    return null;
  }
  /** A report on a take of this page's (page:report, the outbox's `self`): `act`, a person's act, whose refusal is said. */
  function report(args, l, act) {
    if (ADMIN_VIEW) return;
    const key = args.seq + '|' + args.state + '|' + (args.words || '') + '|' + !!args.again;
    if (!act && key === said[l]) return;
    said[l] = key;
    AGM.outbox.self('page:report', args, l, (r) => { if (act && !(r && r.ok)) AGM.toast((r && r.error) || 'Not changed.', true); });
  }
  document.addEventListener('visibilitychange', () => sayAll());

  /** The layer drawn with `t`, once no field being written in holds the focus (at most WAIT_MS). */
  function showLayer(t, asked) {
    const key = keyOf(t);
    if ((drawnKey === key || drawing === key) && !layer.hidden) { drawBarNow(); return; }
    if (waiting && waiting.key === key && !asked) return;
    if (waiting) waiting.cancel();
    const go = () => { waiting = null; draw(t, key); };
    const field = document.activeElement && document.activeElement.matches && document.activeElement.matches(FIELD) && !layer.contains(document.activeElement) ? document.activeElement : null;
    if (!field || !layer.hidden || asked) { go(); return; }
    let timer = null;
    const done = () => { field.removeEventListener('blur', done); clearTimeout(timer); go(); };
    field.addEventListener('blur', done);
    timer = setTimeout(done, WAIT_MS);
    waiting = { key, cancel: () => { field.removeEventListener('blur', done); clearTimeout(timer); waiting = null; } };
  }
  /** Whether `key` is still what the layer should draw. */
  const stillOver = (key) => { const p = plan(); return !!p.over && keyOf(p.over) === key; };
  function draw(t, key) {
    const n = ++turn;
    load().then((m) => {
      const drawn = m.render(box, t.content, ctxOf(t));
      // A web page is on the layer as it loads (up to 15 s): the person sees it come, and it is said once it has.
      if (t.content.kind === 'web' && n === turn && stillOver(key)) { drawing = key; open(t); }
      return drawn;
    }).then((r) => {
      drawnSaid(r);
      if (n !== turn || !stillOver(key)) return;
      drawing = '';
      result = r && typeof r === 'object' ? r : { state: 'failed', words: 'it could not be drawn' };
      drawnKey = key;
      delete layer.dataset.touched;   // a new take: a blank one's bar waits for a touch again
      open(t);
      sayAll();
    }, () => {
      if (n !== turn) return;
      clearBox(box);
      result = { state: 'failed', words: 'this page could not load what draws it' };
      drawnKey = key;
      open(t);
      sayAll();
    });
  }
  /** The layer up, over the page: its words, its bar, its clock; the focus on it unless a field holds it. */
  function open(t) {
    const first = layer.hidden;
    layer.dataset.kind = t.content.kind;
    what.textContent = 'Shown to you: ' + kindWords(t.content.kind) + (byWords(t) ? ' · ' + byWords(t) : '');
    layer.hidden = false;
    document.body.dataset.take = t.content.kind;
    if (first) { unread = 0; hot = null; drawNews(); }
    drawBarNow();
    ticking();
    const at = document.activeElement;
    if (first && !(at && at.matches && at.matches(FIELD))) layer.focus({ preventScroll: true });
  }
  function hideLayer() {
    if (waiting) waiting.cancel();
    turn++;
    if (layer.hidden && !drawnKey) return;
    const had = layer.contains(document.activeElement);
    if (fullNow() === layer) leaveFull();
    layer.hidden = true;
    delete document.body.dataset.take;
    delete layer.dataset.kind;
    drawnKey = '';
    drawing = '';
    result = null;
    clearBox(box);
    unread = 0;
    hot = null;
    drawNews();
    ticking();
    // The focus that was on the layer goes to the feed, never to a field (a tablet's keyboard would cover the chat).
    if (had && !feedRoving.focus('current')) feed.focus();
    if (openOn && openOn.kind === 'take') AGM.menu.close();
  }

  // ---- the cards: a take the person minimised, or information that arrived in the side bar (📺 On stage), one for each
  // place, with Show again (over the chat) and Remove
  function drawCards(p) {
    for (const l of LAYERS) {
      const t = p.cards[l];
      if (!t) { dropCard(l); continue; }
      const side = l !== 'show' && t.answer !== 'minimised';
      const key = keyOf(t) + (side ? '|side' : '');
      const c = cardOf[l];
      if (c && c.key === key) { drawCardBar(l); continue; }
      dropCard(l);
      const li = document.createElement('li');
      li.className = 'take-card' + (side ? ' take-card-side' : '');
      li.dataset.key = 'take:' + t.seq;
      li.dataset.layer = l;
      li.tabIndex = -1;
      cardOf[l] = { key: keyOf(t), li, side, result: null };
      // In the order of the places: the show's card first, then the information's, then what is beside it.
      const next = LAYERS.slice(LAYERS.indexOf(l) + 1).map((x) => cardOf[x] && cardOf[x].li).find((x) => !!x && x.parentNode === cards);
      cards.insertBefore(li, next || null);
      cards.hidden = false;
      document.body.dataset.pushed = '1';
      drawRail();
      // Information that arrives in the side bar opens it, once.
      if (side) setStageCollapsed(false);
      load().then((m) => {
        const now = cardOf[l];
        if (!now || now.li !== li) return;
        const by = document.createElement('span');
        by.className = 'take-card-by';
        by.textContent = byWords(t);
        const bar = document.createElement('span');
        bar.className = 'take-card-acts';
        li.append(m.card(t.content, ctxOf(t)), by);
        if (side) {
          // Drawn in the card, as on the layer, and said "in the side bar" once it has.
          const inner = document.createElement('div');
          inner.className = 'take-card-box';
          li.append(inner);
          Promise.resolve(m.render(inner, t.content, { ...ctxOf(t), card: true })).then((r) => {
            drawnSaid(r);
            if (cardOf[l] !== now) return;
            now.result = r && typeof r === 'object' ? r : { state: 'failed', words: 'it could not be drawn' };
            sayAll();
          }, () => { if (cardOf[l] === now) { now.result = { state: 'failed', words: 'this page could not load what draws it' }; sayAll(); } });
        }
        li.append(bar);
        drawCardBar(l);
        ticking();
      }, () => AGM.toast('This page could not load what draws a take: reload it.', true));
    }
  }
  function dropCard(l) {
    const c = cardOf[l];
    if (!c) return;
    const had = c.li.contains(document.activeElement);
    // A document or a picture drawn in the card is let go with it.
    const inner = c.li.querySelector('.take-card-box');
    if (inner) clearBox(inner);
    c.li.remove();
    cardOf[l] = null;
    if (!cards.children.length) { cards.hidden = true; if (!past.length) delete document.body.dataset.pushed; }
    drawRail();
    ticking();
    if (had && !layer.hidden) layer.focus({ preventScroll: true });
    if (openOn && openOn.kind === 'card') AGM.menu.close();
  }
  /** How many cards the side bar holds now: a take minimised, information arrived there (beside the operator's too). */
  const carded = () => LAYERS.filter((l) => !!cardOf[l]).length;
  /** The collapsed panel's rail says what waits in it: "📺 On stage • 2". */
  function drawRail() {
    const rail = document.getElementById('docExpandRail');
    const n = carded();
    if (rail) rail.textContent = n ? '📺 On stage • ' + n : '📺 On stage ⇤';
  }

  // ---- Earlier: the information taken off this page lately, each opened with a Look (no report, no take)
  /** The Earlier entries drawn: those this page is told, but the information it is shown now (over the show, beside it, its line). */
  const pastNow = () => past.filter((e) => !SIDES.some((l) => told[l] && told[l].seq === e.seq && live(told[l])));
  function drawPast() {
    const list = pastNow();
    const keys = list.map((e) => 'past:' + e.seq).join(',');
    if (pastList.dataset.keys === keys) { drawPastBars(); return; }
    pastList.dataset.keys = keys;
    const had = pastList.contains(document.activeElement);
    pastList.textContent = '';
    pastList.hidden = !list.length;
    if (list.length) document.body.dataset.pushed = '1';
    else if (!carded()) delete document.body.dataset.pushed;
    if (!list.length) { if (had) feed.focus(); return; }
    load().then((m) => {
      if (pastList.dataset.keys !== keys) return;
      const head = document.createElement('li');
      head.className = 'take-earlier-head';
      head.textContent = 'Earlier';
      pastList.append(head);
      for (const e of list) {
        const li = document.createElement('li');
        li.className = 'take-card take-earlier-item';
        li.dataset.key = 'past:' + e.seq;
        li.tabIndex = -1;
        const by = document.createElement('span');
        by.className = 'take-card-by';
        by.textContent = byWords(e);
        const bar = document.createElement('span');
        bar.className = 'take-card-acts';
        li.append(m.card(e.content, ctxOf(e)), by, bar);
        pastList.append(li);
      }
      drawPastBars();
    }, () => AGM.toast('This page could not load what draws a take: reload it.', true));
  }
  /** A document's file as its ⬇ Download reads it: its address, its name, and whether it was shown with Download ticked. */
  const fileOfTake = (t) => (t && t.content.kind === 'doc' ? { file: typeof t.content.url === 'string' ? t.content.url : '', name: t.content.name || '', download: t.content.download === true } : {});
  const pastObject = (seq) => { const e = pastNow().find((x) => x.seq === seq); return e ? { id: 'past:' + e.seq, seq: e.seq, kind: e.content.kind, url: e.content.kind === 'web' && typeof e.content.url === 'string' ? e.content.url : '', ...fileOfTake(e) } : null; };
  /** An Earlier entry this page is told, whole (what a Look draws), or null. */
  const pastEntry = (seq) => pastNow().find((x) => x.seq === seq) || null;
  function drawPastBars() {
    for (const li of pastList.querySelectorAll('.take-earlier-item')) {
      const o = pastObject(Number(li.dataset.key.slice(5)));
      if (o) drawBar(li.querySelector('.take-card-acts'), 'past', o, { words: true, more: 'More for this', keysOn: li });
    }
  }
  /**
   * A Look at an Earlier entry, on this page alone, with nothing to show from it and no report: a web page framed (Preview),
   * a document, a picture or a quote drawn as the take was (a reader let go as the Look closes).
   */
  function look(o) {
    const e = pastEntry(o.seq);
    if (e && (e.content.kind === 'doc' || e.content.kind === 'image' || e.content.kind === 'snippet')) {
      load().then((m) => Preview.look(m, e, ctxOf(e), drawnSaid), () => AGM.toast('This page could not load what draws a take: reload it.', true));
      return;
    }
    if (o.kind !== 'web' || !o.url) { AGM.toast('This page cannot open that one again.', true); return; }
    load().then((m) => Preview.open(m, o.url, null), () => AGM.toast('This page could not load what draws a web page: reload it.', true));
  }
  function pastDoor(t) {
    const li = t.closest && t.closest('.take-earlier-item');
    if (!li || !pastList.contains(li)) return null;
    const seq = Number(li.dataset.key.slice(5));
    const more = li.querySelector('.obj-more');
    return { el: li, more, open: (at) => openObjectMenu('past', () => pastObject(seq), { node: li, more, at, opener: li.contains(document.activeElement) ? document.activeElement : more || li, label: 'Earlier', header: () => 'Shown earlier' }) };
  }
  pastList.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="past."], [data-more]');
    const door = el && pastDoor(el);
    if (!door) return;
    e.preventDefault();
    if (el.dataset.more) {
      if (openOn && openOn.kind === 'past') { AGM.menu.close(); return; }
      door.open({ anchor: el });
      return;
    }
    const o = pastObject(Number(door.el.dataset.key.slice(5)));
    if (o) act('past', el.dataset.action, o, { anchor: door.more || el, node: door.el, opener: el });
  });
  AGM.menu.door(pastList, pastDoor, { stage: true });

  // ---- the objects the catalogue reads, and their bars
  /**
   * A web page's address as the take carries it, or where a quote from a web page opens (its address told, with a text
   * directive of its words: pagelayer.mjs sourceHref); '' for any other: Open in a new tab, or Open the source, opens it.
   */
  const urlOf = (t) => {
    if (!t) return '';
    if (t.content.kind === 'web') return typeof t.content.url === 'string' ? t.content.url : '';
    return t.content.kind === 'snippet' && renderer ? renderer.sourceHref(t.content) : '';
  };
  /**
   * The take on the layer, as the catalogue reads it: `seq`, `kind`, `layer`, `strip` (a 🔥 message out of view), `full`
   * (the layer fills the screen), `url` (a web page's), `held` (information held under this blank: a touch shows it).
   */
  const object = () => {
    if (layer.hidden) return null;
    const p = plan();
    const t = p.over;
    return t && keyOf(t) === (drawnKey || drawing) ? { id: 'take', seq: t.seq, kind: t.content.kind, layer: p.layer, strip: !!hot, full: fullNow() === layer, url: urlOf(t), held: p.held ? 1 : 0, ...fileOfTake(t) } : null;
  };
  /** A card as the catalogue reads it: `seq`, `kind`, `layer`, `side` (arrived in the side bar, not minimised). */
  const cardObject = (l) => {
    const which = LAYERS.includes(l) ? [l] : LAYERS;
    for (const x of which) {
      const c = cardOf[x];
      const t = told[x];
      if (c && t && c.key === keyOf(t)) return { id: 'card', seq: t.seq, kind: t.content.kind, layer: x, side: c.side, ...fileOfTake(t) };
    }
    return null;
  };
  function drawBarNow() {
    const o = object();
    if (!o) return;
    drawBar(acts, 'take', o, { words: true, all: true, more: 'More for what is shown to you' });
    const openChat = $('layerOpenChat');
    const why = AGM.catalog.ready('take', 'take.openChat', F, o);
    if (why === true) { openChat.removeAttribute('aria-disabled'); openChat.removeAttribute('title'); } else { openChat.setAttribute('aria-disabled', 'true'); openChat.title = why; }
  }
  function drawCardBar(l) {
    const o = cardObject(l);
    const c = cardOf[l];
    const bar = c && c.li.querySelector('.take-card-acts');
    if (o && bar) drawBar(bar, 'card', o, { words: true, more: 'More for this card', keysOn: c.li });
  }
  const takeHeader = () => what.textContent;
  const cardHeader = (o) => (o.side ? 'In your side bar: ' : 'Minimised: ') + kindWords(o.kind);
  const takeDoor = () => (layer.hidden ? null : { el: layer, more: acts.querySelector('.obj-more'), open: (at) => openObjectMenu('take', object, { node: layer, more: acts.querySelector('.obj-more'), at, opener: layer.contains(document.activeElement) ? document.activeElement : layer, label: 'Shown to you', header: takeHeader }) });
  function cardDoor(t) {
    const li = t.closest && t.closest('.take-card');
    if (!li || !cards.contains(li)) return null;
    const l = li.dataset.layer;
    const more = li.querySelector('.obj-more');
    return { el: li, more, layer: l, open: (at) => openObjectMenu('card', () => cardObject(l), { node: li, more, at, opener: li.contains(document.activeElement) ? document.activeElement : more || li, label: 'Card actions', header: cardHeader }) };
  }
  // Got it on the strip answers the backstage team (msg.ack) and clears the strip: what it answers is answered.
  $('layerGotIt').addEventListener('click', (e) => {
    e.preventDefault();
    const h = hotNow();
    if (!h) return;
    act('msg', 'msg.ack', h, { anchor: e.currentTarget, node: layer, opener: e.currentTarget });
    if (AGM.catalog.ready('msg', 'msg.ack', F, h) === true) { hot = null; drawNews(); }
  });
  layer.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="take."], [data-more]');
    if (!el || !layer.contains(el)) return;
    e.preventDefault();
    const o = object();
    if (!o) return;
    if (el.dataset.more) {
      if (openOn && openOn.kind === 'take') { AGM.menu.close(); return; }
      openObjectMenu('take', object, { node: layer, more: el, opener: el, label: 'Shown to you', header: takeHeader });
      return;
    }
    act('take', el.dataset.action, o, { anchor: acts.querySelector('.obj-more') || el, node: layer, opener: el });
  });
  // A blank take draws nothing but black: its bar shows once the person touches the screen or presses a key.
  for (const ev of ['pointerdown', 'keydown']) layer.addEventListener(ev, () => { layer.dataset.touched = '1'; });
  AGM.menu.door(layer, takeDoor, { stage: true });
  cards.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="card."], [data-more]');
    const door = el && cardDoor(el);
    if (!door) return;
    e.preventDefault();
    if (el.dataset.more) {
      if (openOn && openOn.kind === 'card') { AGM.menu.close(); return; }
      door.open({ anchor: el });
      return;
    }
    const o = cardObject(door.layer);
    if (o) act('card', el.dataset.action, o, { anchor: door.more || el, node: door.el, opener: el });
  });
  AGM.menu.door(cards, cardDoor, { stage: true });
  // Escape minimises the layer (the Escape order: an open menu, an open ask, then the layer), before a field under it
  // takes it back from a reply; never inside a dialog, whose Escape is its own.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || layer.hidden || AGM.menu.isOpen() || AGM.ask.isOpen() || document.querySelector('dialog[open]')) return;
    const o = object();
    if (!o) return;
    e.preventDefault();
    e.stopPropagation();
    act('take', 'take.minimise', o, { node: layer, opener: layer });
  }, true);

  // ---- the person's acts on their own page: the page acts at once, then says so. Each acts on the layer drawn on top
  // (the information over the show), or on the card it is on.
  /** Back to chat on a layer's take, from the layer or from its card (Remove), with the toast's way back for 10 s. */
  function backToChat(from, l) {
    const t = told[l];
    if (!t) return;
    const seq = t.seq;
    t.answer = 'dismissed';
    report({ seq, state: 'dismissed', words: '' }, l, true);
    apply();
    const at = Date.now();
    const card = from === 'card';
    // Back to chat on information returns to what is under it, where there is something.
    const under = l !== 'show' && plan().over;
    const words = card ? 'Removed from On stage' + (under ? ': ' + kindWords(under.content.kind) + ' is under it.' : ': you are on your chat.')
      : under ? 'Back to ' + kindWords(under.content.kind) + '.' : 'Back to chat.';
    AGM.toast(words, {
      undoLabel: card ? 'Undo' : 'Show it again',
      undo: () => {
        const now = told[l];
        if (!now || now.seq !== seq || now.answer !== 'dismissed') return;
        if (Date.now() - at > AGAIN_MS) { AGM.toast('Back to chat was chosen more than 10 s ago: it can no longer be brought back.', true); return; }
        if (card) { now.answer = 'minimised'; report({ seq, state: 'minimised', words: '' }, l, true); apply(); return; }
        now.answer = null;
        again = seq;
        apply(true);
      },
    });
  }
  /** Minimise: the layer's take goes into the side bar as a card, which opens once for it; Undo shows it again. */
  function minimise(l) {
    const t = told[l];
    if (!t || t.answer) return;
    t.answer = 'minimised';
    if (l !== 'show' && raised[l] === t.seq) raised[l] = 0;
    report({ seq: t.seq, state: 'minimised', words: '' }, l, true);
    apply();
    setStageCollapsed(false);
    const seq = t.seq;
    AGM.toast('Minimised to 📺 On stage.', { undo: () => { const now = told[l]; if (now && now.seq === seq && now.answer === 'minimised') showAgain(l); } });
  }
  /**
   * Show again (a card's, or Minimise's Undo): the take drawn over the chat again, and said with `again`; information that
   * arrived in the side bar, drawn over the chat by the person's choice.
   */
  function showAgain(l) {
    const t = told[l];
    if (!t) return;
    if (t.answer === 'minimised') {
      t.answer = null;
      again = t.seq;
      if (l !== 'show' && t.arrive === 'side') raised[l] = t.seq;
      apply(true);
      return;
    }
    if (l !== 'show' && !t.answer && inSide(t)) { raised[l] = t.seq; apply(true); }
  }
  /** "1 from backstage", on blank's bar: the information held under it, drawn over the blank by the person's touch. */
  function unhold() {
    const p = plan();
    if (!p.held) return;
    unheld = p.held.seq;
    apply(true);
  }
  /** Open chat, from the 🔥 strip: minimised, and the 🔥 message brought into view with the focus on it. */
  function openChat() {
    const m = hot;
    const p = plan();
    if (p.layer) minimise(p.layer);
    const node = m && messagesById.get(m.id);
    if (node) { node.scrollIntoView({ block: 'center' }); if (node.hasAttribute('tabindex')) node.focus({ preventScroll: true }); }
  }
  // Full screen is the person's own gesture, where the device has the Fullscreen API (the `fullscreen` fact).
  const fullNow = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function leaveFull() {
    const leave = document.exitFullscreen || document.webkitExitFullscreen;
    if (leave) Promise.resolve(leave.call(document)).catch(() => {});   // it may have been left already: nothing to undo
  }
  function fullscreen() {
    if (fullNow()) { leaveFull(); return; }
    const ask = layer.requestFullscreen || layer.webkitRequestFullscreen;
    if (ask) Promise.resolve(ask.call(layer)).catch(() => AGM.toast('This device did not go full screen.', true));
  }
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { drawBarNow(); refreshOpenMenu(); });
  /**
   * A web page in a tab of the person's own, outside AGMessage: its address checked as a frame's is (pagelayer.mjs), and
   * opened with no opener and no referrer, so the page there can neither reach this one nor read its address.
   */
  function openTab(o) {
    const w = renderer ? renderer.webAddress(o.url) : { error: 'This page could not load what draws a take: reload it.' };
    if (w.error) { AGM.toast(w.error, true); return; }
    window.open(w.url, '_blank', 'noopener,noreferrer');
  }
  Object.assign(RUN, {
    'take.tab': (o) => openTab(o),
    'take.chat': (o) => backToChat('layer', o.layer),
    'take.minimise': (o) => minimise(o.layer),
    'take.openChat': () => openChat(),
    'take.fullscreen': () => fullscreen(),
    'take.held': () => unhold(),
    'card.show': (o) => showAgain(o.layer),
    'card.remove': (o) => backToChat('card', o.layer),
    // ⬇ Download of a document shown with Let them download it ticked: the server's act, by the take's number.
    'card.download': (o) => downloadBy({ seq: o.seq }, o.file, o.name),
    'take.download': (o) => downloadBy({ seq: o.seq }, o.file, o.name),
    'past.download': (o) => downloadBy({ seq: o.seq }, o.file, o.name),
    'past.look': (o) => look(o),
  });

  // ---- what happens in the room while the layer covers it
  /** A message heard live: a 🔥 one from someone else breaks through in the strip; another is counted on the bar. */
  function heard(msg) {
    if (layer.hidden || !msg || msg.type === 'system' || isMine(msg)) return;
    if (msg.priority) hot = msg; else unread++;
    drawNews();
  }
  /** The 🔥 message in the strip as the catalogue reads it now (its record, its reactions included), or null. */
  const hotNow = () => (hot ? findMessage(hot.id) || hot : null);
  function drawNews() {
    newOn.textContent = unread ? unread + ' new' : '';
    strip.hidden = !hot;
    // The simple view's Got it beside Open chat, on a 🔥 message from backstage that waits for this person (msg.ack).
    const h = hotNow();
    const got = $('layerGotIt');
    got.hidden = !(h && AGM.catalog.shown('msg', F, h).some((e) => e.id === 'msg.ack'));
    // Its words only while it is drawn, so the strip's text never reads a button it does not show.
    got.textContent = got.hidden ? '' : '👍 Got it';
    if (!got.hidden) {
      const why = AGM.catalog.ready('msg', 'msg.ack', F, h);
      if (why === true) { got.removeAttribute('aria-disabled'); got.removeAttribute('title'); } else { got.setAttribute('aria-disabled', 'true'); got.title = why; }
    }
    if (hot) {
      $('layerStripFrom').textContent = '🔥 ' + ((hot.from && hot.from.name) || 'Someone') + ':';
      $('layerStripText').textContent = hot.type === 'file' ? (hot.filename || 'a file') : hot.type === 'help' ? 'needs help' + (hot.category ? ' (' + hot.category + ')' : '') : String(hot.text || '');
    }
    drawBarNow();
  }

  // ---- the clock and Stagewatch's time, live while one is drawn
  function tickNow() {
    if (!renderer) return;
    if (!layer.hidden) renderer.tick(layer, ctxOf(told.show));
    if (!cards.hidden) renderer.tick(cards, ctxOf(told.show));
  }
  function ticking() {
    const isLive = (!layer.hidden && /^(clock|stage)$/.test(layer.dataset.kind || '')) || (!cards.hidden && !!cards.querySelector('[data-live]'));
    if (isLive && !ticker) ticker = setInterval(tickNow, 500);
    if (!isLive && ticker) { clearInterval(ticker); ticker = null; }
  }
  /** Stagewatch's frame moved: a countdown drawn shows it at once. */
  function stageFrame(v) { stage = v; tickNow(); }
  /** The page's facts changed (connected, the support view): the bars drawn again. */
  function redraw() { drawBarNow(); for (const l of LAYERS) drawCardBar(l); drawPastBars(); if (!layer.hidden) drawNews(); }
  /** The side bar opened or closed, or its tab was chosen: a card that arrived there is in view now, or no longer. */
  function seen() { sayAll(); }
  stageMoved = seen;

  return {
    joined, stage: stageFrame, heard, redraw, seen, object, cardObject, pastObject, carded, earlier: () => pastNow().length, load,
    current: () => told.show, over: () => told.info,
  };
})();

// ---------------- ＋ the speaker's screen: one line with a push ----------------
/**
 * ＋ the speaker's screen (plan 4-§5.9.10): one line of plain text a push from a bar (the Preview's, the ❝ Quote tab's)
 * carries to Stagewatch's speaker screen, for a presenter who reads only that screen. The line is the push's own words,
 * built by one core with the server (linecore.js): a quote's words with its marked labels, or a document's or a picture's
 * line above it, never a file's name, address or page unless typed; the server builds it again from the take it stored
 * and refuses a line that differs. Shown where this hall's Stagewatch can be reached by this seat (stage.send, and a way
 * open: the facts' canSendToStage or canPropose), off on every push until ticked, and disabled, with why, until there is
 * something to send. Ticked, it offers 📝 Ask the operator and 🖥 Send now, each disabled with its reason where its way
 * is closed, preset to the way chosen last on this device and the first time to Ask the operator where the desk can take
 * it; under 🖥 the words say what a send now does to the operator's message, which the researcher cannot otherwise see.
 * Before it goes, the bar shows the line, its count against Stagewatch's bounds, and the push it goes with; the line goes
 * only with a push whose own line is the one shown, and a push asked with ＋ that carries none says why in its toast.
 */
const SpeakerLine = (() => {
  const LAST = 'agm.speakerWay';
  const NONE_WENT = 'No line went to the speaker\'s screen: ';
  const read = () => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } };
  const keep = (v) => { try { localStorage.setItem(LAST, v); } catch { /* this device keeps no choice: the first-time preset stands */ } };
  /** Words said as a sentence: a full stop added where they end without one. */
  const sentence = (s) => (/[.!?]$/.test(s) ? s : s + '.');
  /** Why a way is closed, by the facts: Stagewatch's link down closes both; the desk, or a send now, each its own. */
  const closed = (way) => (F.stageWhy ? F.stageWhy
    : way === 'propose' ? (F.canPropose ? '' : 'The show desk is not connected')
    : F.canSendToStage ? '' : 'Sending at once needs Stagewatch\'s key');
  const count = (line) => Array.from(line).length;
  /**
   * Why a confidential item's line may not go to this hall's Stagewatch ('' where it may: plan 4-§5.9.10), as the server's
   * frame tells this room (`secretLine`): the hall's own Stagewatch, over an encrypted link.
   */
  const secretWhy = () => { const st = pageFacts.stage; return st && st.secretLine === true ? '' : st && typeof st.secretLine === 'string' ? st.secretLine : 'This hall has no Stagewatch linked — link one in Set up.'; };
  /** What ＋ says of a confidential item's line: what Stagewatch does with it (S6). */
  const SECRET_SAID = '🔒 Confidential — every output of this hall\'s Stagewatch shows it (the speaker\'s screens, NDI, its viewer page); anyone on the venue network can read it from Stagewatch, which also keeps it and passes it to its triggers.';
  /**
   * The ＋ of one bar (`root`, its block in app.html): draw(content, none, goes) draws it for the take the bar would push
   * now (`none`: why there is nothing to send yet; `goes`: which of the bar's pushes carries that line, where it has
   * several); take() is what a push asks with it now: null where ＋ is off, {way, shown} (the way, and the line the bar
   * showed), or {why} where no way it may go is open; reset() turns it off.
   */
  function control(root) {
    const on = root.querySelector('[data-line-on]');
    const why = root.querySelector('[data-line-why]');
    const ways = root.querySelector('[data-line-ways]');
    const now = root.querySelector('[data-line-now]');
    const said = root.querySelector('[data-line-said]');
    const radios = [...root.querySelectorAll('input[type="radio"]')];
    let line = '';
    let chosen = '';
    let last = { content: null, none: '', goes: '' };
    /** Why a way is closed for this line ('' where it is open): its way's own reason, and through the desk a line longer than it keeps. */
    const shut = (w) => closed(w) || (w === 'propose' && line.length > AGMLine.DESK_MAX ? 'Through the show desk a line is at most ' + AGMLine.DESK_MAX + ' characters — use Send now, or a shorter quote' : '');
    function draw(content = last.content, none = last.none, goes = last.goes) {
      last = { content, none, goes };
      root.hidden = !(F.canSendToStage || F.canPropose);
      line = AGMLine.flatten(content);
      // A confidential item's line goes only to the hall's own Stagewatch, over an encrypted link: ＋ is off, with why, elsewhere.
      const secret = !!content && content.confidential === true;
      const barred = secret && line ? secretWhy() : '';
      on.disabled = !line || !!barred;
      if (on.disabled) on.checked = false;
      why.hidden = !!line && !barred;
      why.textContent = barred ? sentence(barred) : line ? '' : none || 'Nothing to put on the speaker\'s screen yet.';
      const ticked = on.checked && !on.disabled;
      ways.hidden = !ticked;
      said.hidden = !ticked;
      if (!ticked) { chosen = ''; return; }
      // The way: the one chosen in this bar, else the one chosen last on this device, else Ask the operator where the desk
      // can take it; a way that is closed now is never the one chosen.
      const open = (w) => !!w && !shut(w);
      const stored = read();
      chosen = open(chosen) ? chosen : open(stored) ? stored : open('propose') ? 'propose' : open('send') ? 'send' : '';
      for (const r of radios) {
        const w = r.value;
        const shutWhy = shut(w);
        r.disabled = !!shutWhy;
        r.checked = w === chosen;
        const small = root.querySelector('[data-line-closed="' + w + '"]');
        small.textContent = shutWhy ? sentence(shutWhy) : '';
        small.hidden = !shutWhy;
      }
      now.hidden = false;
      const n = count(line);
      const over = line.length > AGMLine.SENT_MAX ? ' Sent now, its first ' + AGMLine.SENT_MAX + ' characters show.' : '';
      said.textContent = (secret ? SECRET_SAID + ' ' : '') + '“' + (line.length > AGMLine.SENT_MAX ? line.slice(0, AGMLine.SENT_MAX) + '…' : line) + '” — ' + n + (n === 1 ? ' character' : ' characters')
        + ': ' + AGMLine.SENT_MAX + ' sent now, about ' + AGMLine.DESK_MAX + ' through the desk; it reads at a glance up to about ' + AGMLine.GLANCE + '.' + over + (goes ? ' ' + goes : '');
    }
    on.addEventListener('change', () => draw());
    for (const r of radios) r.addEventListener('change', () => { if (r.checked) { chosen = r.value; keep(r.value); draw(); } });
    /** What a push asks with ＋ now: nothing while it is off; the way chosen and the line shown; or why no way is open now. */
    function take() {
      if (!on.checked || on.disabled) return null;
      if (chosen && !shut(chosen)) return { way: chosen, shown: line };
      return { why: NONE_WENT + sentence((chosen && shut(chosen)) || shut('propose') || shut('send') || 'no way to Stagewatch is open') };
    }
    return { draw, take, reset: () => { on.checked = false; chosen = ''; draw(); } };
  }
  /**
   * The line asked with a take (`content`, numbered `seq`; `asked`, its bar's take()), sent with its number the way chosen:
   * the line the bar showed, and only where it is this take's own line (the server builds it again from the take it stored
   * and refuses one that differs), so a push other than the one ＋ showed its line for sends none, and says so. Its step in
   * words ("📝 waiting for the operator", "🖥 on the speaker's screen", with where the operator's answer and the speaker's
   * acknowledgement follow: its line in the chat), or why no line went, as a promise of {ok, words}.
   */
  function send(seq, content, asked) {
    if (asked.why) return Promise.resolve({ ok: false, words: asked.why });
    const own = AGMLine.flatten(content);
    if (!own) return Promise.resolve({ ok: false, words: NONE_WENT + 'this push has no words for it — a picture or the document carries only the line typed above it.' });
    if (own !== asked.shown) return Promise.resolve({ ok: false, words: NONE_WENT + 'this push\'s words are not the line ＋ showed — send that line with the push it names, or as a line of its own.' });
    const way = asked.way;
    return new Promise((resolve) => {
      const after = (r) => {
        if (!r || !r.ok) { resolve({ ok: false, words: 'The line did not go to the speaker\'s screen: ' + sentence((r && r.error) || 'not sent') }); return; }
        resolve({ ok: true, words: way === 'send' ? (r.stage === 'applied' ? '🖥 on the speaker\'s screen' : '🖥 Stagewatch took the line') + ' — the speaker\'s acknowledgement follows on its line in the chat'
          : '📝 waiting for the operator — their answer follows on its line in the chat' });
      };
      if (way === 'send') AGM.outbox.now('stage:send', { withTake: seq, text: asked.shown }, after);
      else AGM.outbox.now('stage:propose', { withTake: seq, text: asked.shown, destination: 'speaker' }, after);
    });
  }
  return { control, send };
})();

// ---------------- What people's pages show: the console's People's pages, and the Board chip ----------------
// For a page that may change what its hall's people's pages show (canPush), or show information on its Board's pages by a
// right of its own (canShow): it reads where they stand (page:status) as it joins, as the console opens and whenever it
// is told they changed (pages:changed, a signal), and draws the Board chip in the header and the console's People's pages
// from that one read, each with the show, the information over it and what is beside it. A choice is a take of its own
// (page:push), said with whom it reaches. A show take's Undo for 10 s puts back what was shown before, a take of its own
// over the one it undoes (`ifSeq`, so it never undoes someone else's later take); beyond that, the Board chip's ↶ Back to
// does the same while this page's take is still the Board's. Information offers Take down for 10 s instead, never older
// information put back; the Board's and a person's Take down hand back the information alone, over the show or beside
// it. A take made that way offers no undo of its own. A page that may only show (canShow) is told the people seated On
// stage alone, and over the operator's information on their pages sends its own to their side bar, beside it.
const Console = (function () {
  const $ = (id) => document.getElementById(id);
  const chip = $('boardChip');
  const list = $('peoplePages');
  /** How a choice is said, by its kind: "The clock on 6 Board pages." */
  const SAID = { chat: 'Back to chat', stage: 'Stagewatch', clock: 'The clock', holding: 'Holding', blank: 'Blank', web: 'The web page', doc: 'The document', image: 'The picture', snippet: 'The quote' };
  const said = (content) => (content.kind === 'chat' && content.layer === 'info' ? 'Taken down' : SAID[content.kind] || 'It');
  /** The information layer's kinds (lib/pages.js), which a take of draws over the show. */
  const INFO = ['web', 'doc', 'image', 'snippet'];
  let status = null;       // page:status's answer: {board, people}
  let readAt = 0;          // when it was read, by this device's clock: an information take's age is the answer's `ago` and the time since
  const drawn = new Set(); // who is told each time the read is drawn (the Preview's bar)
  let mine = null;         // this page's own take on the Board: {seq, previous, time}
  let asking = false;
  let again = false;
  const may = () => F.canPush || F.canShow;

  function read() {
    if (!may() || ADMIN_VIEW || !HALL_KEY || !socket.connected) return;
    if (asking) { again = true; return; }
    asking = true;
    socket.emit('page:status', { code: HALL_KEY }, (r) => {
      asking = false;
      if (r && r.ok) { status = r; readAt = Date.now(); draw(); } else if (r && r.busy) again = true;
      if (again) { again = false; setTimeout(read, r && r.busy ? 1000 : 0); }
    });
  }
  socket.on('pages:changed', () => read());
  // A read the drop took with it is never answered: the next join reads again.
  socket.on('disconnect', () => { asking = false; again = false; });

  /** What a status row's take shows now: its kind, or chat for nothing shown and for every page back on its chat. */
  const kindNow = (row) => (!row || !row.seq || !row.kind || AGM.markOf(row.mark) === 'off' ? 'chat' : row.kind);
  /**
   * The information in a status row ({seq, kind, mark, words, showing, arrive, op}), or null for none: over the show
   * (`info`), or in their side bar beside the operator's (`beside`); what Take down hands back, and whether the operator put
   * it up (`op`: a researcher's Take down is only over its own kind).
   */
  const takeIn = (i) => (i && i.seq && i.kind && i.kind !== 'chat' ? { seq: i.seq, kind: i.kind, mark: i.mark, words: i.words, showing: i.showing, arrive: i.arrive === 'side' ? 'side' : 'over', op: i.op === true, mine: i.mine === true, on: i.on, pages: i.pages,
    by: typeof i.by === 'string' ? i.by : '', at: readAt - (Number.isFinite(i.ago) ? i.ago : 0), ...counts(i), ...(i.doc && typeof i.doc === 'object' ? { doc: i.doc } : {}) } : null);
  /**
   * A status's pages that cannot open documents (plan 4-§5.15.2), as page:status counts them: `nodocs`, those that drew a
   * document's stand-in (`standin`, as a picture or as a quote: `standinAs`) and those that could not show it (`cannot`); 0
   * where it says none. With a document some could not open, the file to draw from (`doc`), where the read gives this
   * page one.
   */
  const counts = (i) => ({ nodocs: count(i, 'nodocs'), standin: count(i, 'standin'), standinAs: i && i.standinAs === 'quote' ? 'quote' : 'picture', cannot: count(i, 'cannot') });
  const count = (i, k) => (i && Number.isInteger(i[k]) && i[k] > 0 ? i[k] : 0);
  const infoOf = (row) => takeIn(row && row.info);
  const besideOf = (row) => takeIn(row && row.beside);
  /**
   * The operator's information drawn on a Board page in place of the Board's own, as the console lists the people On stage
   * (a seat that may only show is told them alone): its Take down of the Board's is then the server's to refuse.
   */
  const opOnBoard = (b) => !F.canPush && !!status && Array.isArray(status.people) && status.people.some((p) => { const i = infoOf(p); return !!i && i.op && (!b || !b.info || b.info.seq !== i.seq); });
  /**
   * What a person's pages show now: a kind (chat for their chat), '' where the console's read lists no page of theirs in
   * the hall's rooms this page may read, and undefined until that read has come.
   */
  const kindOf = (key) => {
    if (!status) return undefined;
    const p = Array.isArray(status.people) ? status.people.find((x) => x.uid === key) : null;
    return p ? kindNow(p) : '';
  };
  /** The Board as the catalogue reads it (kind `board`), for a page that may change what it is shown or show on it. */
  function board() {
    if (!may()) return null;
    const b = status && status.board;
    const info = infoOf(b);
    return { id: 'board', seq: b ? b.seq : 0, kind: b ? kindNow(b) : undefined, pages: b ? b.pages : 0, on: b ? b.on : 0, mark: b ? b.mark : '', words: b ? b.words : '', showing: b ? b.showing : '',
      mine: mine && b && mine.seq === b.seq ? mine : null, info, beside: besideOf(b), show: !status || status.show !== false, opOn: opOnBoard({ info }),
      // Its pages that cannot open documents, and, where a document could not be shown on some of them, what Show them a
      // picture sends them (Show.standinSaid: its words; none where this page has nothing of it to draw from).
      nodocs: count(b, 'nodocs'), standin: pictureFor(info) };
  }
  /** What is over the show and beside it, in words: " · over it: a web page on … (Opened …) · in their side bar: …". */
  const infoWords = (o) => (o.info ? ' · over it: ' + o.info.showing + ' (' + o.info.words + ')' : '') + (o.beside ? ' · in their side bar: ' + o.beside.showing + ' (' + o.beside.words + ')' : '');
  const boardHeader = (o) => (!status ? 'The Board' : o.pages ? 'The Board · ' + o.pages + (o.pages === 1 ? ' page · ' : ' pages · ') + o.words + infoWords(o) : 'No Board page is open: what you show arrives when one joins.');

  /**
   * A take on the Board's pages or a person's, said with whom it reaches. A show take offers Undo for 10 s (over it,
   * `ifSeq`): what was there before, or their chat. Information offers Take down for 10 s instead, the information handed
   * back over that take alone, never older content put back (which could pop up again what the Board had closed); it is
   * kept beside the operator's (`aside`) where the operator's information is up, said so. A Take down offers nothing.
   */
  function push(to, content, { ifSeq, undoable = true, name = '', arrive = '', refused = null, taken = null, line = null, confirm = false } = {}) {
    const onBoard = to === 'board';
    const info = INFO.includes(content.kind);
    const handBack = content.kind === 'chat' && content.layer === 'info';
    AGM.outbox.now('page:push', { code: HALL_KEY, to, content, ...(Number.isInteger(ifSeq) ? { ifSeq } : {}), ...(arrive ? { arrive } : {}), ...(confirm ? { confirm: true } : {}) }, (r) => {
      // A confidential file shown where it is not in use: its sender is asked, naming each room, and sends it again
      // confirmed on yes (plan 4-§5.14).
      if (r && !r.ok && r.confirm === true && !confirm) {
        const rooms = Array.isArray(r.rooms) && r.rooms.length ? r.rooms.join(' and ') : 'the Main room';
        AGM.ask(null, { title: '🔒 A confidential file', words: 'This file is confidential. Show it in ' + rooms + '? It will be in use there.', yes: 'Show it', no: 'Cancel' })
          .then((a) => { if (a && a.yes) push(to, content, { ifSeq, undoable, name, arrive, refused, taken, line, confirm: true }); });
        return;
      }
      // A refusal its sender can mend (a picture whose file went: drawn and sent again) is its sender's to say.
      if ((!r || !r.ok) && refused && refused(r)) { read(); return; }
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Nothing was shown.', true); read(); return; }
      // Its sender keeps what it was, by its number (a document: Show them a picture of its place).
      if (taken) taken(r);
      const st = Array.isArray(r.results) && r.results[0] ? r.results[0].status : null;
      // What was shown before in the show layer, as the server gives it back: their chat where nothing was, else its
      // content; none where this page could not put it up itself (a picture in a room it may not read), and then no Undo is
      // offered.
      const was = !r.previous ? { kind: 'chat' } : r.previous.content || null;
      const undo = undoable && !info && !handBack && !!was;
      if (onBoard && !info && !handBack) mine = undo ? { seq: r.seq, previous: was, time: formatTime(Date.now()) } : null;
      const n = st ? st.pages : 0;
      const whom = onBoard ? (n ? ' on ' + n + (n === 1 ? ' Board page' : ' Board pages') : ': no Board page is open — it arrives when one joins') : ' on ' + (name || 'their') + '\'s pages';
      const where = r.aside ? ' — in their side bar, beside what the operator is showing' : r.arrive === 'side' ? ' — in their side bar' : '';
      // Information offers Take down, and beside it Withdraw (a take shown by mistake: from Earlier too), for 10 s.
      const down = info && undoable ? { undoLabel: 'Take down', undo: () => push(to, { kind: 'chat', layer: 'info' }, { ifSeq: r.seq, undoable: false, name }), also: { label: 'Withdraw', act: () => withdraw(r.seq) } } : undefined;
      const words = said(content) + whom + where + '.';
      // A line asked with it (＋ the speaker's screen, `line`: its bar's take()) goes once the take is the server's, by its
      // number, and the one toast says both: the take, then the line's step or why no line went.
      if (line && info) SpeakerLine.send(r.seq, content, line).then((l) => AGM.toast(words + ' ' + l.words + (l.ok ? '.' : ''), { ...(down || {}), bad: !l.ok }));
      else AGM.toast(words, undo ? { undo: () => push(to, was, { ifSeq: r.seq, undoable: false, name }) } : down);
      read();
    });
  }
  /** A take withdrawn (page:withdraw): from every page it was for and from Earlier, said as the server words it. */
  function withdraw(seq) {
    AGM.outbox.now('page:withdraw', { code: HALL_KEY, seq }, (r) => {
      if (!r || !r.ok) { AGM.toast((r && r.error) || 'Not withdrawn.', true); read(); return; }
      AGM.toast(r.already ? 'Already withdrawn.' : r.words || 'Withdrawn.');
      read();
    });
  }
  /**
   * A web page by the address its ask was answered with: checked first as a frame checks it (pagelayer.mjs webAddress),
   * then shown (Show it), or framed on this page alone first (Preview), whose own Show it runs the act again with that
   * answer, through the one checked path (act), on the object as it is then. A page that may only show sends it to the
   * side bar where the operator's information is up on the Board (the server refuses it over that).
   */
  function web(to, kind, id, get, { values, choice, opener }, name = '') {
    const url = values && typeof values.url === 'string' ? values.url : '';
    Takes.load().then((m) => {
      const w = m.webAddress(url);
      if (w.error) { AGM.toast(w.error, true); return; }
      if (choice === 'preview') { Preview.open(m, w.url, () => { const o = get(); if (o) act(kind, id, o, { opener, answered: { values: { url: w.url }, choice: 'show' } }); else AGM.toast(AGM.catalog.WORDS.gone, true); }); return; }
      // Over the operator's information on their pages, a page that may only show sends it to their side bar.
      const o = to === 'board' ? board() : rowOf(to.uid);
      const side = !F.canPush && !!o && ((!!o.info && o.info.op) || !!o.opOn);
      push(to, { kind: 'web', url: w.url }, { name, ...(side ? { arrive: 'side' } : {}) });
    }, () => AGM.toast('This page could not load what draws a web page: reload it.', true));
  }
  Object.assign(RUN, {
    'board.back': (o) => push('board', o.mine.previous, { ifSeq: o.seq, undoable: false }),
    'board.takeDown': (o) => { const t = AGM.catalog.downOf(F, o); if (t) push('board', { kind: 'chat', layer: 'info' }, { ifSeq: t.seq, undoable: false }); },
    'person.takeDown': (p) => { const t = AGM.catalog.downOf(F, p); if (t) push({ uid: p.key }, { kind: 'chat', layer: 'info' }, { ifSeq: t.seq, undoable: false, name: p.name }); },
    'board.withdraw': (o) => { const t = AGM.catalog.withdrawOf(F, o); if (t) withdraw(t.seq); },
    'person.withdraw': (p) => { const t = AGM.catalog.withdrawOf(F, p); if (t) withdraw(t.seq); },
    'board.screens': () => Screens.show('people'),
    'person.show': (p, { value }) => { if (typeof value === 'string') push({ uid: p.key }, { kind: value }, { name: p.name }); },
    'person.chat': (p) => push({ uid: p.key }, { kind: 'chat' }, { name: p.name }),
    'person.web': (p, c) => web({ uid: p.key }, 'person', 'person.web', () => (p.where === 'console' ? rowOf(p.key) : personNow(p.uid)), c, p.name),
    'person.doc': (p, c) => Show.document(null, { to: { uid: p.key }, name: p.name, anchor: c.anchor, opener: c.opener }),
  });
  /**
   * A file shown on the Board's pages or one person's (a document, a picture): over their chat, or in their side bar
   * where it is asked to arrive there, or where the operator's information is up there and this page may only show (the
   * server refuses it over that).
   */
  function showFile(to, content, { name = '', arrive = '', refused = null, taken = null, line = null } = {}) {
    const o = to === 'board' ? board() : rowOf(to.uid);
    const side = arrive === 'side' || (!F.canPush && !!o && ((!!o.info && o.info.op) || !!o.opOn));
    push(to, content, { name, refused, taken, line, ...(side ? { arrive: 'side' } : {}) });
  }
  /** The people a page may show something to by name, as the console's read lists them: [{key, name}]. */
  const people = () => (status && Array.isArray(status.people) ? status.people.map((p) => ({ key: p.uid, name: String(p.name || '') })) : []);
  /**
   * The people seated On stage whose pages could not open the Board's document take `seq` (their own read of it counts
   * pages that failed: `cannot`), as the console's read lists them: [{key, name}]. A person since shown a take of their own
   * reads that one, and is left out.
   */
  const older = (seq) => (status && Array.isArray(status.people) ? status.people.filter((p) => { const i = infoOf(p); return p.board === true && !!i && i.seq === seq && i.cannot > 0; }).map((p) => ({ key: p.uid, name: String(p.name || '') })) : []);
  /** What Show them a picture sends for a document take some pages could not open (`info`), or null (Show.standinSaid). */
  const pictureFor = (info) => (info && info.kind === 'doc' && info.cannot > 0 ? Show.standinSaid(info) : null);
  /**
   * How many of a target's pages cannot open documents, and of how many ({n, of}), as the console's read counts them: the
   * Board's (`to` 'board') or a person's ({uid}).
   */
  function olderOf(to) {
    const row = !status ? null : to === 'board' ? status.board : Array.isArray(status.people) ? status.people.find((p) => p.uid === (to && to.uid)) : null;
    return { n: count(row, 'nodocs'), of: row && Number.isInteger(row.pages) ? row.pages : 0 };
  }
  for (const [kind] of AGM.catalog.SHOW_KINDS) if (AGM.catalog.entry('board', 'board.' + kind)) RUN['board.' + kind] = () => push('board', { kind });
  RUN['board.web'] = (o, c) => web('board', 'board', 'board.web', board, c);
  // Show them a picture: the Board's document, at its place, to each person On stage whose page could not open it, as a
  // take of their own drawn over the Board's (plan 4-§5.15.2); a person's, to that person.
  RUN['board.picture'] = (o) => { if (o.info) Show.sendStandins(o.info, older(o.info.seq)); };
  RUN['person.picture'] = (p) => { if (p.info) Show.sendStandins(p.info, [{ key: p.key, name: p.name }]); };

  // ---- the Board chip, in the header: "Board · 🕐 Clock ✓ 6/6"; a click on it, a right-click and Shift+F10 open its menu
  const chipDoor = () => (chip.hidden ? null : { el: chip, more: chip, open: (at) => openObjectMenu('board', board, { node: chip, more: chip, at, opener: chip, label: 'The Board', header: boardHeader }) });
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    if (openOn && openOn.kind === 'board' && openOn.node === chip) { AGM.menu.close(); return; }
    const door = chipDoor();
    if (door) door.open({ anchor: chip });
  });
  /** A count's words for the pages that drew a document's stand-in: " (2 as a picture)" ("✓ 6/6 (2 as a picture)"), or a quote. */
  const pictured = (row) => (count(row, 'standin') ? ' (' + count(row, 'standin') + ' as a ' + (row.standinAs === 'quote' ? 'quote' : 'picture') + ')' : '');
  function drawChip() {
    const show = may() && !outOf;
    chip.hidden = !show;
    if (!show) return;
    const b = status && status.board;
    const o = board();
    const kind = AGM.catalog.SHOW_KINDS.find((x) => x[0] === o.kind);
    const entry = kind ? AGM.catalog.entry('board', 'board.' + kind[0]) : null;
    let head = 'Board', mark = '', words = '';
    if (b && !b.pages) { head = 'Board ·'; mark = 'fault'; words = 'nobody on stage'; }
    else if (b && b.seq && kind) { head = 'Board · ' + entry.icon + ' ' + kind[1]; mark = AGM.markOf(b.mark) || 'fault'; words = b.on + '/' + b.pages + pictured(b); }
    else if (b) head = 'Board · Chat';
    $('boardWhat').textContent = head;
    const state = $('boardState');
    AGM.chip(state, mark, words);
    state.hidden = !mark && !words;
    let sr = chip.querySelector(':scope > .sr-only');
    if (!sr) { sr = document.createElement('span'); sr.className = 'sr-only'; chip.appendChild(sr); }
    // The information over the show, after it: "🌍 Web page ✓ 6/6"; with none over the show, what is in their side bar
    // beside it: "🌍 Web page in the side bar ◇ 6/6".
    const over = $('boardOver');
    const i = o.info;
    const shown = i || o.beside;
    over.hidden = !shown;
    if (shown) {
      const k = AGM.catalog.SHOW_KINDS.find((x) => x[0] === shown.kind);
      const e = k ? AGM.catalog.entry('board', 'board.' + k[0]) : null;
      over.textContent = '';
      const name = document.createElement('span');
      name.className = 'board-over-what';
      name.textContent = '· ' + (e ? e.icon + ' ' : '') + (k ? k[1] : 'Shown') + (shown === i ? ' ' : ' in the side bar ');
      const st = document.createElement('span');
      st.className = 'board-over-state';
      AGM.chip(st, AGM.markOf(shown.mark) || 'fault', shown.on + '/' + shown.pages + pictured(shown));
      over.append(name, st);
    }
    const s = o.beside;
    sr.textContent = b ? ': ' + b.words + (i ? '; over it: ' + i.showing + ', ' + i.words : '') + (s ? '; in their side bar: ' + s.showing + ', ' + s.words : '') : '';
    chip.title = (b ? 'The Board: ' + b.words : 'The Board') + (i ? '; over it: ' + i.showing : '') + (s ? '; in their side bar: ' + s.showing : '') + ' — ' + (F.canPush ? 'choose what its pages show' : 'show it something, or take yours down') + ' (or right-click, or Shift+F10)';
  }

  // ---- the console's People's pages: the Board's row, then each person, each with its status and its acts
  /** A person the console lists, as the catalogue reads a person (kind `person`, `where`: the console). */
  const personRow = (p) => ({ id: 'person:' + p.uid, uid: p.uid.slice(2), name: String(p.name || ''), role: '', key: p.uid, kind: kindNow(p), where: 'console', ...takesOf(p.uid) });
  /**
   * The information on a person's pages, as the console reads it, for their Take down: over the show (`info`) and beside it
   * (`beside`), with whether this page's information pushes hold stage.show (`show`); none until it has read.
   */
  function takesOf(key) {
    const p = status && Array.isArray(status.people) ? status.people.find((x) => x.uid === key) : null;
    if (!p) return { info: null, beside: null, show: !status || status.show !== false };
    const info = infoOf(p);
    // Where their pages could not open a document, what Show them a picture sends them.
    return { info, beside: besideOf(p), show: status.show !== false, standin: pictureFor(info) };
  }
  const rowOf = (key) => {
    if (key === 'board') return board();
    const p = status && Array.isArray(status.people) ? status.people.find((x) => x.uid === key) : null;
    return p ? personRow(p) : null;
  };
  function drawPeople() {
    const words = $('peoplePagesWords');
    if (!may() || !status) { list.textContent = ''; words.textContent = may() ? 'Reading where people\'s pages stand…' : ''; return; }
    const rows = [{ key: 'board', row: status.board, name: status.board.pages ? 'On stage (Board) — all ' + status.board.pages : 'On stage (Board) — nobody yet', o: board() }]
      .concat(status.people.map((p) => ({ key: p.uid, row: p, name: p.name + (p.room ? ' · ' + p.room : ''), o: personRow(p) })));
    const have = new Map([...list.querySelectorAll(':scope > li[data-key]')].map((li) => [li.dataset.key, li]));
    let prev = null;
    for (const r of rows) {
      let li = have.get(r.key);
      if (li) have.delete(r.key);
      else {
        li = document.createElement('li');
        li.className = 'page-row' + (r.key === 'board' ? ' board-row' : '');
        li.dataset.key = r.key;
        const head = document.createElement('div');
        head.className = 'page-line';
        const who = document.createElement('strong');
        who.className = 'page-who';
        const st = document.createElement('span');
        st.className = 'page-state status-chip';
        head.append(who, st);
        const showing = document.createElement('span');
        showing.className = 'page-showing';
        const bar = document.createElement('div');
        bar.className = 'page-acts';
        li.append(head, showing, bar);
      }
      li.querySelector('.page-who').textContent = r.name;
      AGM.chip(li.querySelector('.page-state'), AGM.markOf(r.row.mark) || 'fault', r.row.words);
      li.querySelector('.page-showing').textContent = (r.row.seq ? 'Showing: ' + r.row.showing : 'Showing: their chat') + infoWords({ info: infoOf(r.row), beside: besideOf(r.row) });
      if (r.key === 'board') drawBar(li.querySelector('.page-acts'), 'board', r.o, { words: true, all: true, more: 'More for the Board', keysOn: li });
      else drawBar(li.querySelector('.page-acts'), 'person', r.o, { more: 'More for ' + r.o.name, keysOn: li });
      const at = prev ? prev.nextElementSibling : list.firstElementChild;
      if (at !== li) list.insertBefore(li, at);
      prev = li;
    }
    for (const gone of have.values()) gone.remove();
    words.textContent = status.people.length ? '' : F.canPush ? 'Nobody else is in this hall\'s rooms you may read.' : 'Nobody is seated On stage now.';
  }
  function rowDoor(t) {
    const li = t.closest && t.closest('li[data-key]');
    if (!li || !list.contains(li)) return null;
    const key = li.dataset.key;
    const kind = key === 'board' ? 'board' : 'person';
    const more = li.querySelector('.obj-more');
    return { el: li, more, key, kind, open: (at) => openObjectMenu(kind, () => rowOf(key), { node: li, more, at, opener: li.contains(document.activeElement) ? document.activeElement : more || li, label: kind === 'board' ? 'The Board' : 'Person actions', header: kind === 'board' ? boardHeader : personHeader }) };
  }
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-more]');
    const door = el && rowDoor(el);
    if (!door) return;
    e.preventDefault();
    if (el.dataset.more) {
      if (openOn && openOn.node === door.el) { AGM.menu.close(); return; }
      door.open({ anchor: el });
      return;
    }
    const o = rowOf(door.key);
    if (o) act(door.kind, el.dataset.action, o, { anchor: door.more || el, node: door.el, opener: el });
  });
  AGM.menu.door(list, rowDoor);
  AGM.roving(list, { item: 'li[data-key]' });

  /** Everything this read draws: the chip, the console's rows, the People panel's acts and an open menu, in step. */
  function draw() {
    drawChip();
    drawPeople();
    drawPeopleActs();
    Screens.tabs();
    for (const fn of drawn) fn();
    refreshOpenMenu();
  }
  /**
   * Whether this page's information pushes hold stage.show in its hall, as its read says (the admin's and a code guest's
   * always; an account's by its right there): false until it has read, so what needs it (the Preview's bar, the ❝ Quote tab)
   * is drawn only once the server has said so, and never for a seat that may show only web pages.
   */
  const showsInfo = () => !!status && status.show !== false;
  return { read, draw, board, kindOf, takesOf, chipDoor, showFile, people, older, olderOf, rowOf, showsInfo, onDraw: (fn) => { drawn.add(fn); } };
})();

/**
 * Showing a file on the Board's pages or one person's (plan 4-§5.9.7, §5.9.8; owner answer 11, "Both as options"): a
 * picture of a page, which hands over that picture alone, or the document opened at a place, which the Board pages
 * through, with Let them download it under it alone (owner answers 12 and 20). From the Preview's bar, the feed's ⋯ on a
 * file (📺 Show the Board ▸) and the People tab (Show them a document…, its short bar). A file on this device is uploaded
 * for this room as it is shown, never before; a file of the room is shown by its address.
 */
const Show = (() => {
  const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  /** A document's place by its type (lib/pages.js placeOf): a page, a slide, a sheet, a line (a CSV's row); a Word document opens at its top. */
  const PLACE = { pdf: 'page', pptx: 'slide', xlsx: 'sheet', xls: 'sheet', csv: 'line', txt: 'line', md: 'line' };
  const PLACE_SAID = { page: 'Page', slide: 'Slide', sheet: 'Sheet', line: 'Line' };
  const STAGE = AGM.catalog.STAGE_EXT;
  /** Why ☐ Let them download it is disabled for a file whose reader found hidden parts (plan 4-§5.10.3). */
  const HIDDEN_PARTS = 'This file has hidden parts: Download would hand them over. Share a copy without them for download instead.';
  /** A file as a source to show: {url, name, mime} of the room's, or {file, name, mime} on this device; its extension. */
  const extOf = (src) => extOfName(src.url || src.name);
  const sourceOf = (m) => (m && m.file ? { file: m.file, name: m.file.name, mime: m.file.type || '' } : m && isFileUrl(m.url) ? { url: m.url, name: m.filename || m.name || '', mime: m.mime || '', ...(typeof m.id === 'string' && findMessage(m.id) ? { id: m.id } : {}) } : null);
  /**
   * What a picture drawn of `src` says it is of, as its upload names it (`from`): a file message of this room, `m:<id>`, or
   * the take of this hall that shows it, `s:<seq>` (a document put up, Show them a picture's): its confidential mark then
   * marks the picture as it is stored. '' for a file on this device, or one of neither.
   */
  const fromOf = (src) => (src && src.id ? 'm:' + src.id : src && Number.isInteger(src.seq) && src.seq > 0 ? 's:' + src.seq : '');
  /** The place `n` of a file of type `ext`, as a take's `at` names it, or none (a Word document opens at its top). */
  const atOf = (ext, n) => (PLACE[ext] && n >= 1 ? { [PLACE[ext]]: n } : null);
  /** The words of a step, said in the toast. */
  const say = (words) => AGM.toast(words);
  /** How many times an upload the uploads' rate turned away (429: one file every 2 s past a burst) is sent again, 2 s apart. */
  const RATE_TRIES = 3;
  const RATE_MS = 2000;
  /**
   * A file on this device uploaded for this room now: its address, or null with the server's words said. Turned away by
   * the uploads' rate, it says "Sending in 2 s…" and goes again, at most RATE_TRIES times, then says the server's words.
   */
  async function upload(file, what, from = '') {
    say('Uploading ' + what + (sizeWords(file.size) ? ' (' + sizeWords(file.size) + ')' : '') + '…');
    for (let tries = 0; ; tries++) {
      const up = await uploadFile(file, from);
      if (up && typeof up.url === 'string') return up.url;
      if (!(up && up.status === 429 && tries < RATE_TRIES)) { AGM.toast((up && up.error) || 'Not uploaded.', true); return null; }
      say('Sending in 2 s…');
      await new Promise((resolve) => { setTimeout(resolve, RATE_MS); });
    }
  }
  /**
   * The pictures this page drew and uploaded lately, by what they are of ({source, page, rect} → {url, at}): shown again
   * without a second upload while the stage keeps its file (the server's wait, an hour; WAIT_MS less a margin), and drawn
   * and uploaded again where a push is refused because the file is gone.
   */
  const drawnPictures = new Map();
  const PICTURE_KEEP_MS = 55 * 60 * 1000;
  /** The most pictures kept for showing again: past it, the oldest is let go first. */
  const PICTURES_KEPT = 50;
  /** A picture drawn and uploaded kept, the ones past their time let go, and at most PICTURES_KEPT, the oldest dropped. */
  function keepPicture(key, url, bytes) {
    const now = Date.now();
    for (const [k, v] of drawnPictures) if (now - v.at >= PICTURE_KEEP_MS) drawnPictures.delete(k);
    drawnPictures.delete(key);
    drawnPictures.set(key, { url, at: now, bytes });
    while (drawnPictures.size > PICTURES_KEPT) drawnPictures.delete(drawnPictures.keys().next().value);
  }
  /** The size of the picture of page `page` of `src` drawn here lately, in bytes, or 0 where none is kept. */
  function drawnSize(src, page) {
    const kept = src ? drawnPictures.get(pictureKey(src, page, null)) : null;
    return kept && Date.now() - kept.at < PICTURE_KEEP_MS ? kept.bytes || 0 : 0;
  }
  const pictureKey = (src, page, rect) => (src.url || ('local:' + (src.name || '') + ':' + ((src.file && src.file.size) || 0) + ':' + ((src.file && src.file.lastModified) || 0))) + '|' + page + '|' + (rect ? [rect.x, rect.y, rect.w, rect.h].map((n) => Math.round(n)).join(',') : 'page');
  /** The words a push is refused in where the file it names is gone from this hall: drawn and uploaded again, once. */
  const GONE_FILE = /in no room of this hall|could not be read|no longer/i;
  /**
   * A picture of page `page` of `src` (a PDF), or of the part `rect` of it (a region, what is in view: in the page's own
   * units), or the picture itself (an image) or a part of it (`rect`, in its pixels; and `bare`, the whole of it drawn
   * again, without its metadata), shown to `to`: drawn here into a new picture and uploaded, saying what it is a picture
   * of; an image of the room shown whole by its address, one on this device uploaded first. Nothing else of the file goes.
   */
  async function picture(src, page, to, { name = '', view = null, rect = null, bare = false, arrive = '', fresh = false, note = '', line = null, confidential = false } = {}) {
    const ext = extOf(src);
    const image = IMAGE.includes(ext);
    const noted = { ...(note ? { note } : {}), ...(confidential ? { confidential: true } : {}) };
    if (image && !rect && !bare) {
      const url = src.url || await upload(src.file, 'the picture');
      if (url) Console.showFile(to, { kind: 'image', url, ...noted }, { name, arrive, line });
      return;
    }
    if (!image && ext !== 'pdf') { AGM.toast('A picture is made of a PDF\'s page or of an image: show this file as the document.', true); return; }
    const key = pictureKey(src, image ? 1 : page, rect || (bare ? { x: 0, y: 0, w: 0, h: 0 } : null));
    const kept = drawnPictures.get(key);
    let url = !fresh && kept && Date.now() - kept.at < PICTURE_KEEP_MS ? kept.url : '';
    if (!url) {
      say(image ? 'Drawing the picture…' : 'Drawing p. ' + page + '…');
      let blob;
      try {
        const mod = await docReader();
        blob = rect || bare ? (view ? await view.regionPicture(page, rect || { x: 0, y: 0, w: 1e9, h: 1e9 }) : null)
          : view ? await view.pagePicture(page) : await mod.pagePictureOf(src.url ? { url: src.url } : { file: src.file }, page);
      } catch { blob = null; }
      if (!blob) { AGM.toast((image ? 'The picture' : 'p. ' + page) + ' could not be drawn.', true); return; }
      const stem = (src.name || 'page').replace(/\.[A-Za-z0-9]{1,5}$/, '');
      const type = blob.type === 'image/jpeg' ? 'jpg' : 'png';
      url = await upload(new File([blob], stem + (image ? ' part' : ' p' + page) + '.' + type, { type: blob.type || 'image/png' }), 'the picture', fromOf(src));
      if (!url) return;
      keepPicture(key, url, blob.size);
    }
    const at = image ? {} : { at: { page } };
    const from = src.url ? { url: src.url, ...at } : { local: true, name: src.name, ...at };
    // A picture kept from before whose file the stage let go is drawn and uploaded again, once.
    const refused = kept && !fresh ? (r) => { if (!(r && GONE_FILE.test(r.error || ''))) return false; drawnPictures.delete(key); picture(src, page, to, { name, view, rect, bare, arrive, fresh: true, note, line, confidential }); return true; } : null;
    Console.showFile(to, { kind: 'image', url, from, ...noted }, { name, arrive, refused, line });
  }
  /**
   * A picture inside a document (a Word document's, a deck's: the Preview's pick, `view`), shown to `to` as a picture of
   * its own: drawn again here, its metadata left behind, and uploaded, saying where in the file it is (`at`). Nothing else
   * of the file goes.
   */
  async function inside(src, to, { view, at = {}, name = '', arrive = '', fresh = false, note = '', line = null, confidential = false } = {}) {
    const key = pictureKey(src, 'in:' + (at.block || at.slide || 0), null);
    const kept = drawnPictures.get(key);
    let url = !fresh && kept && Date.now() - kept.at < PICTURE_KEEP_MS ? kept.url : '';
    if (!url) {
      say('Drawing the picture…');
      let blob;
      try { blob = view ? await view.pickPicture() : null; } catch { blob = null; }
      if (!blob) { AGM.toast('The picture could not be drawn.', true); return; }
      const stem = (src.name || 'document').replace(/\.[A-Za-z0-9]{1,5}$/, '');
      url = await upload(new File([blob], stem + ' picture.' + (blob.type === 'image/jpeg' ? 'jpg' : 'png'), { type: blob.type || 'image/png' }), 'the picture', fromOf(src));
      if (!url) return;
      keepPicture(key, url, blob.size);
    }
    const where = Object.keys(at).length ? { at } : {};
    const from = src.url ? { url: src.url, ...where } : { local: true, name: src.name, ...where };
    const refused = kept && !fresh ? (r) => { if (!(r && GONE_FILE.test(r.error || ''))) return false; drawnPictures.delete(key); inside(src, to, { view, at, name, arrive, fresh: true, note, line, confidential }); return true; } : null;
    Console.showFile(to, { kind: 'image', url, from, ...(note ? { note } : {}), ...(confidential ? { confidential: true } : {}) }, { name, arrive, refused, line });
  }
  /** A quote (a pick's body, docview's quote()) of `src` shown to `to`, its source named as AGMessage holds it: never its address. */
  function quote(src, q, to, { name = '', arrive = '', note = '', line = null, confidential = false } = {}) {
    const { at, approx, over, ...body } = q;
    const from = src.url ? { url: src.url, ...(at && Object.keys(at).length ? { at } : {}) } : { local: true, name: src.name, ...(at && Object.keys(at).length ? { at } : {}) };
    Console.showFile(to, { kind: 'snippet', ...body, from, ...(note ? { note } : {}), ...(confidential ? { confidential: true } : {}) }, { name, arrive, line });
  }
  /**
   * `src` shown whole to `to`, opened at `at`, with Download when ticked: one of this device's uploaded first. Where the
   * console's read counts pages of the target that cannot open documents, and this file needs a reader they lack, its
   * stand-in is made here first and sent with it (plan 4-§5.15.2); for no such page, none is made, so nothing is uploaded
   * for nothing. A stand-in picture kept from before whose file the stage let go is drawn and uploaded again, once. The
   * document is kept by its take's number, for Show them a picture.
   */
  async function whole(src, at, download, to, { name = '', arrive = '', note = '', line = null, confidential = false } = {}) {
    const url = src.url || await upload(src.file, 'the document');
    if (!url) return;
    // Its message, where a file of this room is shown: a picture drawn of it for the older devices names it (fromOf).
    const doc = { url, name: src.name || '', file: src.file || null, ...(src.id ? { id: src.id } : {}) };
    const send = async (fresh) => {
      const made = Console.olderOf(to).n > 0 && STANDIN_TYPES.includes(extOf(src)) ? await standinFor(doc, at, fresh) : null;
      const refused = made && made.kept && !fresh ? (r) => { if (!(r && GONE_FILE.test(r.error || ''))) return false; send(true); return true; } : null;
      Console.showFile(to, { kind: 'doc', url, ...(at ? { at } : {}), download: download === true, ...(note ? { note } : {}), ...(made ? { standin: made.standin } : {}), ...(confidential ? { confidential: true } : {}) }, { name, arrive, refused, line, taken: (r) => keepDoc(r.seq, doc, at) });
    };
    await send(false);
  }

  // ---- a document's stand-in, for the pages that cannot open documents (plan 4-§5.15.2)
  /** The files whose readers such a page lacks: pdf.js (a PDF) and the document worker (Word, Excel, PowerPoint). */
  const STANDIN_TYPES = AGM.catalog.READER_EXT;
  /** Where docview.mjs opens a place: its unit by number (a page, a slide, a sheet, a line), and a Word paragraph's number. */
  const readerAt = (at) => {
    if (!at || typeof at !== 'object') return null;
    const block = Number.isInteger(at.block) && at.block > 0 ? { block: at.block } : {};
    for (const k of ['page', 'slide', 'sheet', 'line']) if (Number.isInteger(at[k]) && at[k] > 0) return { page: at[k], ...block };
    return block.block ? block : null;
  };
  /** A place in words: "p. 12", "slide 3", "sheet 2", "line 40"; "its top" for none (a Word document opens there). */
  const placeSaid = (at) => {
    if (!at || typeof at !== 'object') return 'its top';
    const [k, n] = Object.entries(at).find(([, v]) => Number.isInteger(v) && v > 0) || [];
    return k ? (k === 'page' ? 'p.' : k) + ' ' + n : 'its top';
  };
  /** Whether the Preview draws `src` now: its page's picture is drawn from that view, not read again. */
  const previewed = (src) => !!docView && !!previewing && (previewing.file ? !!src.file && previewing.file === src.file : !!previewing.msg && previewing.msg.url === src.url);
  /**
   * Page `page` of a PDF drawn here and uploaded as a picture (as a page picture is: kept to show again without a second
   * upload while the stage keeps its file, unless `fresh`): {url, kept} (`kept`: the one kept from before, which a push
   * refused because the stage let its file go draws again), or null with the words said.
   */
  async function pagePictureUrl(src, page, fresh = false) {
    const key = pictureKey(src, page, null);
    const kept = drawnPictures.get(key);
    if (!fresh && kept && Date.now() - kept.at < PICTURE_KEEP_MS) return { url: kept.url, kept: true };
    say('Drawing p. ' + page + ' for the older devices…');
    let blob;
    try {
      const mod = await docReader();
      blob = previewed(src) ? await docView.pagePicture(page) : await mod.pagePictureOf(src.url ? { url: src.url } : { file: src.file }, page);
    } catch { blob = null; }
    if (!blob) { AGM.toast('p. ' + page + ' could not be drawn for the older devices.', true); return null; }
    const stem = (src.name || 'page').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const url = await upload(new File([blob], stem + ' p' + page + '.' + (blob.type === 'image/jpeg' ? 'jpg' : 'png'), { type: blob.type || 'image/png' }), 'the picture', fromOf(src));
    if (!url) return null;
    keepPicture(key, url, blob.size);
    return { url, kept: false };
  }
  /**
   * What is at an Office file's place, read here as What I see reads it (its hidden parts left out), in a reader laid out
   * as a tablet's take and never seen, let go once read: a quote's body, or null where nothing there could be read.
   */
  async function seenAt(src, at) {
    let mod;
    try { mod = await docReader(); } catch { return null; }
    const box = document.createElement('div');
    box.className = 'standin-reader';
    box.setAttribute('aria-hidden', 'true');
    document.body.appendChild(box);
    const v = mod.open(box, src.file ? { file: src.file } : { url: src.url }, { at: readerAt(at), seat: 'research', name: src.name || '', ext: extOf(src) });
    try {
      const r = await v.ready;
      if (!r || r.state !== 'shown') return null;
      const seen = v.seen({});
      const q = seen && seen.quote && !seen.quote.error ? seen.quote : seen && seen.fits ? seen.fits : null;
      if (!q) return null;
      // Its body alone: the take's place is the document's own.
      const { at: _at, approx, over, ...body } = q;
      return body;
    } finally { v.destroy(); box.remove(); }
  }
  /**
   * A document's stand-in (lib/pages.js standinOf): a picture of a PDF's place ({url}), or what is at an Office file's
   * ({snippet}), as {standin, kept} (`kept`: a picture kept from before); null for a file such a page draws itself, or
   * where none could be made (its pages then say they cannot open it, and Show them a picture is offered).
   */
  async function standinFor(src, at, fresh = false) {
    const ext = extOf(src);
    if (!STANDIN_TYPES.includes(ext)) return null;
    if (ext === 'pdf') {
      const pic = await pagePictureUrl(src, at && Number.isInteger(at.page) && at.page > 0 ? at.page : 1, fresh);
      return pic ? { standin: { url: pic.url }, kept: pic.kept } : null;
    }
    const snippet = await seenAt(src, at);
    return snippet ? { standin: { snippet }, kept: false } : null;
  }
  /** The documents this page put up lately, by their takes' numbers ({src: {url, name, file}, at}): the newest 20. */
  const sentDocs = new Map();
  function keepDoc(seq, src, at) {
    if (!Number.isInteger(seq)) return;
    sentDocs.set(seq, { src, at: at || null });
    while (sentDocs.size > 20) sentDocs.delete(sentDocs.keys().next().value);
  }
  /**
   * The document a take some pages could not open shows (`info`, the console's read of it): this page's own copy where it
   * put it up, else the file as the console's read gives it to its pusher, an operator and the admin (`doc`); or null.
   */
  function docFor(info) {
    if (!info || !Number.isInteger(info.seq)) return null;
    // Each with the take that shows it (`seq`): a picture drawn of it names that take as its source (fromOf).
    const d = sentDocs.get(info.seq);
    if (d) return { src: { ...d.src, seq: info.seq }, at: d.at };
    const f = info.doc;
    return f && typeof f === 'object' && isFileUrl(f.url) ? { src: { url: f.url, name: typeof f.name === 'string' ? f.name : '', seq: info.seq }, at: f.at && typeof f.at === 'object' ? f.at : null } : null;
  }
  /** What Show them a picture sends for the document a take shows (`info`): {said}, or null where this page has none of it. */
  function standinSaid(info) {
    const d = docFor(info);
    if (!d || !STANDIN_TYPES.includes(extOf(d.src))) return null;
    return { said: (extOf(d.src) === 'pdf' ? 'a picture of ' : 'what is at ') + placeSaid(d.at) };
  }
  /**
   * Show them a picture (plan 4-§5.15.2): the document a take shows (`info`, the console's read) at its place, to each of
   * `people` ({key, name}: those whose page could not open it), as a take of their own: a picture of a PDF's page (drawn
   * and uploaded once, then the same picture to each; one kept from before whose file the stage let go drawn and uploaded
   * again, once, for those it was refused to), or what is at an Office file's place as a quote.
   */
  async function sendStandins(info, people) {
    const d = docFor(info);
    if (!d || !people.length) { AGM.toast('Nobody here is left without it.', true); return; }
    const src = d.src;
    const ext = extOf(src);
    if (ext === 'pdf') {
      const page = d.at && Number.isInteger(d.at.page) && d.at.page > 0 ? d.at.page : 1;
      const pic = await pagePictureUrl(src, page);
      if (!pic) return;
      const picture = (url) => ({ kind: 'image', url, from: { url: src.url, at: { page } } });
      let again = null;
      const refused = (p) => (pic.kept ? (r) => {
        if (!(r && GONE_FILE.test(r.error || ''))) return false;
        again = again || pagePictureUrl(src, page, true);
        again.then((made) => { if (made) Console.showFile({ uid: p.key }, picture(made.url), { name: p.name }); });
        return true;
      } : null);
      for (const p of people) Console.showFile({ uid: p.key }, picture(pic.url), { name: p.name, refused: refused(p) });
      return;
    }
    const snippet = await seenAt(src, d.at);
    if (!snippet) { AGM.toast('Nothing at that place could be read to send them.', true); return; }
    for (const p of people) Console.showFile({ uid: p.key }, { kind: 'snippet', ...snippet, from: { url: src.url, ...(d.at ? { at: d.at } : {}) } }, { name: p.name });
  }
  /**
   * The words the bar says before a document goes, for `to`'s pages that cannot open documents (`older`, the console's
   * {n, of}): "2 of 6 Board pages are older devices: they get a picture of p. 12 in its place"; '' for none, or for a file
   * they draw themselves.
   */
  function olderWords(to, ext, at, name = '') {
    const { n, of } = Console.olderOf(to);
    if (!n || !STANDIN_TYPES.includes(ext)) return '';
    const what = (ext === 'pdf' ? 'a picture of ' : 'what is at ') + (at === undefined ? 'that place' : placeSaid(at));
    const whose = to === 'board' ? n + ' of ' + of + ' Board pages ' + (n === 1 ? 'is an older device: it gets ' : 'are older devices: they get ')
      : (name ? name + '\'s ' : 'Their ') + (n === 1 ? 'page is an older device: it gets ' : n + ' pages are older devices: they get ');
    return whose + what + ' in its place';
  }
  /** Whether the Preview has `src` open now and its reader found hidden parts in it (never shown with Download). */
  const hiddenIn = (src) => !!docView && !!previewing && (previewing.file ? previewing.file === src.file : !!previewing.msg && previewing.msg.url === src.url) && docView.hiddenParts();
  /** The room's files the stage may show, as the short bar lists them: the Preview's own first. */
  function choices() {
    const out = [];
    if (previewing && previewing.file && STAGE.includes(extOfName(previewing.file.name))) out.push({ value: 'local', label: previewing.file.name + ' (your copy)', src: sourceOf(previewing) });
    for (const m of roomFiles.values()) {
      if (m.transferOnly || !isFileUrl(m.url) || !STAGE.includes(extOfName(m.url))) continue;
      out.push({ value: m.id, label: (m.confidential ? '🔒 ' : '') + (m.filename || 'a file'), src: sourceOf(m) });
    }
    return out;
  }
  /**
   * The short document bar (plan 4-§5.9.7): which file (asked only where none is named), its place, ☐ Let them download it
   * (disabled, with why, for a file whose reader found hidden parts), and where it arrives; then Show the Board / Show Ana.
   */
  async function docAsk(src0, { to = 'board', name = '', page = 1, anchor = null, opener = null } = {}) {
    const files = src0 ? null : choices();
    if (files && !files.length) { AGM.toast('No file here the stage can show yet: share one (📎) or attach one to preview it.', true); return; }
    const first = src0 || files[0].src;
    const ext = extOf(first);
    const hidden = src0 ? hiddenIn(src0) : false;
    const fields = [
      ...(files ? [{ name: 'file', label: 'File', type: 'select', options: files.map((f) => ({ value: f.value, label: f.label })), value: files[0].value }] : []),
      ...(src0 && !PLACE[ext] ? [] : [{ name: 'at', label: src0 ? PLACE_SAID[PLACE[ext]] : 'Page, slide, sheet or line', value: String(page), max: 6 }]),
      { name: 'download', label: 'Let them download it', type: 'checkbox', value: false, ...(hidden ? { disabled: HIDDEN_PARTS } : {}) },
      { name: 'arrive', label: 'Where', type: 'select', options: [{ value: 'over', label: 'Over their chat' }, { value: 'side', label: 'In their side bar' }], value: 'over' },
    ];
    const older = olderWords(to, ext, undefined, name);
    const r = await AGM.ask(anchor, { title: 'Show ' + (to === 'board' ? 'the Board' : name || 'them') + ' the document', words: (src0 ? (src0.name || 'The file') : 'The file') + ', whole: they can page through it.' + (older ? ' ' + older + '.' : ''), fields, yes: to === 'board' ? 'Show the Board' : 'Show ' + (name || 'them'), no: 'Cancel' }, { opener });
    if (!r.yes) return;
    const src = files ? (files.find((f) => f.value === r.values.file) || files[0]).src : src0;
    const n = parseInt(r.values.at, 10);
    const ticked = r.values.download === true && !hiddenIn(src);
    whole(src, atOf(extOf(src), n >= 1 && n <= 999999 ? n : 1), ticked, to, { name, arrive: r.values.arrive === 'side' ? 'side' : '' });
  }
  /** 📺 Show the Board ▸ on a file of the room (the feed's ⋯, the panel's list): a picture of p. 1 or of a page asked for, or the document. */
  async function fromMenu(m, { value, anchor, opener } = {}) {
    const src = sourceOf(m);
    if (!src) return;
    if (value === 'picture1') { picture(src, 1, 'board'); return; }
    if (value === 'picture') {
      const r = await AGM.ask(anchor, { title: 'A picture of a page', words: 'The page is drawn here and sent as a picture: nothing else of the file goes.', fields: [{ name: 'page', label: 'Page', value: '1', max: 4 }], yes: 'Show the Board', no: 'Cancel' }, { opener });
      const n = r.yes ? parseInt(r.values.page, 10) : 0;
      if (n >= 1 && n <= 9999) picture(src, n, 'board');
      return;
    }
    if (value === 'doc') docAsk(src, { anchor, opener });
  }
  return { picture, inside, quote, whole, document: docAsk, fromMenu, sourceOf, atOf, hiddenIn, drawnSize, standinSaid, sendStandins, olderWords, IMAGE, PLACE, STAGE, HIDDEN_PARTS };
})();

/** A take's kind as a person reads it: "a quote", "a web page" (the catalogue's words). */
const kindSaid = (kind) => (AGM.catalog.SHOW_KINDS.find((x) => x[0] === kind) || [0, 0, 'something'])[2];

/**
 * A pick in the Preview (plan 4-§5.9.7; the catalogue's kind `pick`): what a researcher highlighted in a file there, made
 * first and honoured. Its bar offers the units that hold it as chips with their sizes, the smallest by default (the last
 * unit used where two are as small), draws exactly what will go as the Board's page will draw it (pagelayer.mjs quote),
 * says a bound's refusal before anything goes with the cut as the researcher's own choice, and Show sends it to the
 * bar's target. A right-click on the pick, the bar's ⋯ and a second tap on it open the same list as a menu, Copy first.
 * Before it goes it says whose information the target is reading where another's is under 15 s old (informing, refusing
 * nothing), and where a quote is long for a glance.
 */
const PickBar = (() => {
  const $ = (id) => document.getElementById(id);
  const bar = $('pickBar');
  const chips = $('pickChips');
  const words = $('pickWords');
  const preview = $('pickPreview');
  const sayEl = $('pickSay');
  const labelsBox = $('pickLabelsBox');
  const labelsTick = $('pickLabels');
  const markLabels = $('pickMarkLabels');
  const note = $('pickNote');
  const showBtn = $('pickShow');
  const more = $('pickMore');
  /** Information another pusher put up this long ago or less is fresh: the bar says whose it is before it is replaced. */
  const FRESH_MS = 15000;
  /**
   * Longer than a glance (provisional, until the device matrix's D2 and D6 are measured, docs/DEVICES.md §7): drawn at the
   * smallest type the stage draws (28 px), a quote taller than a tablet's take (1,180 × 820, its bar out).
   */
  const GLANCE = Object.freeze({ width: 1100, height: 700, px: 28 });
  const LAST_UNIT = 'agm.pickUnit';
  /** What a pick of a PDF without its structure cannot be, and what it can (plan 4-§5.9.6). */
  const UNTAGGED = 'Tables in this PDF cannot be read as cells — send the region as a picture';
  /** A column's letters, as a sheet names it: 0 → A, 27 → AB. */
  const columnLetters = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this device keeps no choice: the smallest unit stands */ } };
  const may = () => docSeat() === 'research' && !ADMIN_VIEW && (F.canPush || F.canShow) && F.view !== 'simple' && Console.showsInfo();
  let view = null;     // the Preview's view the pick is of
  let pick = null;     // its pick now (docview's pick()), or null
  let unit = '';       // the unit chosen
  let cut = false;     // the researcher chose to send the first 1,200 characters, or 25 rows × 10 columns
  const freshTimers = {};   // by the bar that asked (the Preview's, the ❝ Quote tab's): its redraw once no longer fresh
  let drawn = 0;       // each drawing numbered: a quote's preview drawn late for an older one is let go
  let pickNo = 0;      // each pick numbered as it comes (a new pick, its labels marked again)
  let cached = null;   // {key, q, glance}: the quote of the pick now, its preview's glance, kept while what they are of stands
  let copied = null;   // {key, words}: what Copy takes of the pick now, kept likewise
  const src = () => (previewing ? Show.sourceOf(previewing.msg || previewing) : null);
  /** A unit's measure, to find the smallest: its characters, or its cells as twenty characters each. */
  const measure = (u) => { const m = /^(\d+) (ch|cells?|items?)$/.exec(u.size || ''); return m ? Number(m[1]) * (m[2] === 'ch' ? 1 : 20) : Infinity; };
  /** The unit a pick opens with: the smallest that holds it and is within the stage's bounds; of two as small, the one used last, else not the bare selection. */
  function choose(p) {
    if (!p || !p.units.length) return '';
    const last = read(LAST_UNIT);
    const ok = p.units.filter((u) => !u.over);
    const list = (ok.length ? ok : p.units).slice().sort((a, b) => measure(a) - measure(b) || (b.unit === last) - (a.unit === last) || (a.unit === 'selection') - (b.unit === 'selection'));
    return list[0].unit;
  }
  /** The Preview's view is watched for picks as it opens a file: each pick, or none, redraws the bar. */
  function watch(v) {
    view = v;
    pick = null;
    unit = '';
    v.onPick((p) => { if (view !== v) return; pick = p; pickNo++; cut = false; unit = choose(p); draw(); });
    v.onMenu((at) => open(at));
    draw();
  }
  function reset() { view = null; pick = null; unit = ''; draw(); }
  /** The pick as the catalogue reads it (kind `pick`), or null for none. */
  function object() {
    if (!pick || !view || view !== docView || !may()) return null;
    const s = src();
    const ext = s ? extOfName(s.url || s.name) : '';
    return {
      id: 'pick', units: pick.units, copy: copyWords(),
      picture: pick.type === 'region' ? 'region' : pick.type === 'picture' ? 'inside' : ext === 'pdf' || Show.IMAGE.includes(ext) ? 'page' : '',
      seen: !!docView, doc: !!s && Show.STAGE.includes(ext) && !Show.IMAGE.includes(ext), people: Console.people(),
    };
  }
  /** The words a Copy takes: the unit chosen's, as a quote's words read in order. */
  function copyWords() {
    if (!view || !pick || pick.type === 'region' || pick.type === 'picture') return '';
    const key = [pickNo, unit, labelsTick.checked].join('|');
    if (copied && copied.key === key) return copied.words;
    const q = view.quote(unit || 'selection', { cut: true, labels: labelsTick.checked, copy: true });
    copied = { key, words: q && !q.error ? quoteWordsOf(q) : '' };
    return copied.words;
  }
  const quoteWordsOf = (q) => [q.title, q.text, ...(q.items || []), ...(q.table ? q.table.rows.map((r) => r.join('\t')) : []), ...((q.blocks || []).map((b) => (b.table ? b.table.rows.map((r) => r.join('\t')).join('\n') : b.text)))].filter(Boolean).join('\n');
  /** The quote the chosen unit sends now with the bar's note (docview's quote, every bound the server holds said), or {error}. */
  const quoteNow = (u = unit) => (view && pick ? view.quote(u, { cut, labels: labelsTick.checked, note: note.value.trim() }) : null) || { error: 'Nothing is picked.' };
  /** The pick sent as `u` to `t` (the bar's target, or a person from its menu): a quote, a region or a picture in the file as a picture. */
  function send(u = unit, t = PreviewBar.target()) {
    const s = src();
    if (!s || !pick) { AGM.toast('Nothing is picked.', true); return; }
    if (pick.type === 'region') { Show.picture(s, pick.page, t.to, { view, rect: pick.rect, name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() }); return; }
    if (pick.type === 'picture') { Show.inside(s, t.to, { view, at: pick.at || {}, name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() }); return; }
    const q = quoteNow(u);
    if (q.error) { AGM.toast(q.error, true); return; }
    keep(LAST_UNIT, u);
    Show.quote(s, q, t.to, { name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() });
  }
  /**
   * What I see: the blocks or the cells in view as a quote, a PDF's or a picture's part in view as a picture. More than
   * the stage takes is never cut by itself: the researcher is told how much is in view, and Send what fits sends the part
   * that fits (a range marked cut, its rows and columns left out counted on the Board's card), as their own choice.
   */
  function seen(t = PreviewBar.target()) {
    const s = src();
    const words = note.value.trim();
    const v = docView ? docView.seen({ note: words }) : null;
    if (!s || !v) { AGM.toast('Nothing in view to send.', true); return; }
    if (v.picture) { Show.picture(s, v.picture.page, t.to, { view: docView, rect: v.picture.rect, name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() }); return; }
    const go = (q) => Show.quote(s, q, t.to, { name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() });
    const q = v.quote;
    if (q.error && v.fits) { AGM.toast(q.error + '.', { bad: true, undo: () => go(v.fits), undoLabel: 'Send what fits' }); return; }
    if (q.error) { AGM.toast(q.error + ' — scroll so less is in view, or pick a part.', true); return; }
    go(q);
  }
  function open(at) {
    const o = object();
    if (!o) return false;
    return openObjectMenu('pick', object, { node: docDisplay, more, at: at && Number.isFinite(at.x) ? at : { anchor: more }, opener: more, label: 'What you picked', header: () => 'What you picked' });
  }
  const say = (parts) => {
    sayEl.textContent = '';
    for (const p of parts) sayEl.append(p);
    sayEl.hidden = !parts.length;
  };
  const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = label; b.addEventListener('click', fn); return b; };
  /**
   * Whose information the target (`t`: the Preview bar's, or the ❝ Quote tab's) reads now, where another pusher put it up
   * under FRESH_MS ago: words, or null; `redraw` is called once it is no longer fresh (one timer for each `bar`).
   */
  function fresh(t = PreviewBar.target(), redraw = () => PreviewBar.draw(), bar = 'preview') {
    const u = PreviewBar.upThere(t).info;
    if (!u || u.mine || !u.by || !u.at) return null;
    const age = Date.now() - u.at;
    if (age >= FRESH_MS) return null;
    clearTimeout(freshTimers[bar]);
    freshTimers[bar] = setTimeout(redraw, FRESH_MS - age + 50);
    const kind = kindSaid(u.kind).replace(/^an? /, '');
    return (t.to === 'board' ? 'The Board is' : t.name + ' is') + ' reading ' + u.by + '\'s ' + kind + ' (' + Math.max(1, Math.round(age / 1000)) + ' s)';
  }
  /** Whether a quote is longer than a glance on a tablet: drawn off the screen at the stage's smallest type, and measured. */
  function long(m, content) {
    const box = document.createElement('div');
    box.className = 'pick-glance';
    box.style.width = GLANCE.width + 'px';
    const el = m.quote(content, { by: pageFacts.name || '' });
    el.style.fontSize = GLANCE.px + 'px';
    box.appendChild(el);
    document.body.appendChild(box);
    const tall = el.scrollHeight > GLANCE.height;
    box.remove();
    return tall;
  }
  /** The bar drawn for the pick now, then the Preview bar's ＋ the speaker's screen for what it would send. */
  function draw() {
    drawBar();
    PreviewBar.drawLine();
  }
  /**
   * What a push of the pick now would show, as the speaker's line reads it: the quote of the unit chosen, or null where
   * nothing is picked or the pick goes as a picture (its line is the line above it).
   */
  function lineContent() {
    if (bar.hidden || !pick || pick.type === 'region' || pick.type === 'picture' || !cached || !cached.q || cached.q.error) return null;
    return { kind: 'snippet', ...cached.q };
  }
  /**
   * The pick's bar drawn. The quote, its preview and its glance are read again only when what they are of changes (the
   * pick, its unit, the cut, the labels, the note): a scroll of the Preview redraws only the words that follow the place
   * and the target.
   */
  function drawBar() {
    const on = !!pick && !!view && view === docView && may() && !$('previewBar').hidden;
    bar.hidden = !on;
    if (!on) { preview.textContent = ''; cached = null; return; }
    const o = object();
    // The chips: the units that hold the pick, from the catalogue (kind `pick`), each with its size, one chosen.
    const units = AGM.catalog.shown('pick', F, o).filter((e) => AGM.catalog.PICK_UNITS.some((x) => 'pick.' + x[0] === e.id));
    const key = JSON.stringify([units.map((e) => AGM.catalog.items('pick', F, o).find((i) => i.id === e.id) || e.id), unit]);
    if (chips.dataset.key !== key) {
      chips.dataset.key = key;
      chips.textContent = '';
      for (const e of units) {
        const u = e.id.slice(5);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick-chip';
        b.dataset.action = e.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(u === unit));
        const it = AGM.catalog.items('pick', F, o).find((i) => i.id === e.id);
        b.textContent = it ? it.label : u;
        if (it && it.disabled) b.title = it.disabled;
        b.addEventListener('click', () => { unit = u; cut = false; draw(); });
        chips.appendChild(b);
      }
    }
    const t = PreviewBar.target();
    showBtn.textContent = '📺 Show ' + (t.to === 'board' ? 'the Board' : t.name);
    const grid = pick.type === 'grid';
    labelsBox.hidden = !grid;
    markLabels.hidden = !grid || !view.labels();
    words.textContent = pick.words || '';
    const asPicture = pick.type === 'region' || pick.type === 'picture';
    const qKey = [pickNo, unit, cut, labelsTick.checked, note.value.trim()].join('|');
    const again = !cached || cached.key !== qKey;
    if (again) cached = { key: qKey, q: asPicture ? null : quoteNow(), glance: false };
    const q = cached.q;
    const parts = [];
    if (pick.untagged) parts.push(document.createTextNode(UNTAGGED + '. '));
    if (q && q.error) {
      parts.push(document.createTextNode(q.error + ' '));
      if (q.over) parts.push(button(q.over.chars ? 'Send the first 1,200 characters' : 'Send the first 25 rows × 10 columns', () => { cut = true; draw(); }));
    }
    const f = fresh();
    if (f) parts.push(document.createTextNode(f + ' — '), button('Replace', () => send()), document.createTextNode(' · '), button('Show a person instead', () => document.getElementById('pickTo').focus()));
    if (cached.glance) { const w = document.createElement('span'); w.className = 'pick-glance-words'; w.textContent = ' Long for the stage — the Board will scroll.'; parts.push(w); }
    showBtn.disabled = !!(q && q.error);
    say(parts);
    if (!again) return;
    preview.textContent = '';
    if (asPicture) { preview.append(document.createTextNode(pick.type === 'region' ? 'A picture of this region alone: nothing else of the file goes.' : 'This picture alone, drawn again without its metadata: nothing else of the file goes.')); return; }
    const drawing = ++drawn;
    if (!q || q.error) return;
    const mine = cached;
    Takes.load().then((m) => {
      if (drawing !== drawn || cached !== mine) return;
      const content = { kind: 'snippet', ...q, ...(note.value.trim() ? { note: note.value.trim() } : {}) };
      preview.textContent = '';
      preview.appendChild(m.quote(content, { by: pageFacts.name || '' }));
      if (!long(m, content)) return;
      mine.glance = true;
      draw();
    }, () => { preview.textContent = 'This page could not load what draws a quote: reload it.'; });
  }
  showBtn.addEventListener('click', () => send());
  more.addEventListener('click', (e) => { e.preventDefault(); if (openOn && openOn.kind === 'pick') { AGM.menu.close(); return; } open({ anchor: more }); });
  labelsTick.addEventListener('change', () => { if (view && pick) { pick = view.pick(); pickNo++; draw(); } });
  note.addEventListener('input', () => { if (!bar.hidden) draw(); });
  markLabels.addEventListener('click', async () => {
    const l = view && view.labels();
    if (!l) return;
    const r = await AGM.ask(markLabels, { title: 'This sheet\'s labels', words: 'The row of headers and the column of names a cell is sent with (0 for none).', fields: [{ name: 'row', label: 'Label row', value: String(l.row + 1), max: 7 }, { name: 'col', label: 'Label column (A, B, …)', value: l.col >= 0 ? columnLetters(l.col) : '0', max: 3 }], yes: 'Use these', no: 'Cancel' }, { opener: markLabels });
    if (!r.yes || !view) return;
    const row = parseInt(r.values.row, 10);
    const letters = String(r.values.col || '').trim().toUpperCase();
    const col = /^[A-Z]{1,3}$/.test(letters) ? [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : -1;
    view.setLabels(row >= 1 ? row - 1 : -1, col);
  });
  // A right-click on the pick, and Shift+F10 or the menu key in the document, open its menu: AGMessage's, Copy first, in
  // place of the browser's (a touch's long press stays the browser's selection gesture).
  AGM.menu.door(docDisplay, (t, e) => {
    if (!object() || !docView) return null;
    const onIt = e && Number.isFinite(e.clientX) && (e.clientX || e.clientY) ? docView.holds(t, e.clientX, e.clientY) : true;
    return onIt ? { el: docDisplay, more, open: (at) => open(at) } : null;
  }, { picks: true });
  Object.assign(RUN, {
    'pick.copy': (o, { anchor }) => copyText(o.copy, 'Copied.', anchor),
    'pick.picture': () => {
      const s = src();
      const t = PreviewBar.target();
      if (!s) return;
      if (pick && (pick.type === 'region' || pick.type === 'picture')) { send(); return; }
      Show.picture(s, docView ? Math.max(1, (docView.place() || {}).page || 1) : 1, t.to, { view: docView, name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() });
    },
    'pick.view': () => seen(),
    'pick.document': () => {
      const s = src();
      const t = PreviewBar.target();
      if (!s) return;
      const page = docView ? Math.max(1, (docView.place() || {}).page || 1) : 1;
      Show.whole(s, Show.atOf(extOfName(s.url || s.name), page), false, t.to, { name: t.name, arrive: PreviewBar.arrival(t), ...PreviewBar.withPush() });
    },
    'pick.person': (o, { value }) => { const p = Console.people().find((x) => x.key === value); if (p) send(unit || 'selection', { to: { uid: p.key }, name: p.name }); },
  });
  for (const [u] of AGM.catalog.PICK_UNITS) RUN['pick.' + u] = () => { unit = u; send(u); };
  return { watch, reset, draw, object, seen, fresh, long, lineContent, shown: () => !bar.hidden, GLANCE };
})();

/**
 * The Preview's bar (backstage, for a seat that may show the Board): whom it goes to (the Board, or one person) and where
 * it arrives (over their chat, or in their side bar), then 📺 Picture of p. 12 (a PDF; "Show this picture" for an image,
 * "without its metadata" drawn again) and 📺 Document at p. 12 side by side, neither behind the other (owner answer 11),
 * the one chosen last on this device drawn first, with ☐ Let them download it under the document's alone, disabled for a
 * file whose reader found hidden parts; 🔳 What I see; ▭ Region, a part of a PDF's page drawn by hand. The place is the
 * Preview's own, read as it scrolls. One click each. Over the operator's information on the target's pages, a seat that
 * may only show sends to their side bar alone, and says so.
 */
const PreviewBar = (() => {
  const $ = (id) => document.getElementById(id);
  const bar = $('previewBar');
  const pic = $('showPicture');
  const docBtn = $('showDocument');
  const tick = $('letDownload');
  const why = $('letDownloadWhy');
  const note = $('previewNote');
  const seenBtn = $('showSeen');
  const regionBtn = $('regionBtn');
  const noMetaBox = $('noMetaBox');
  const noMeta = $('noMeta');
  const toSel = $('pickTo');
  const arriveSel = $('pickArrive');
  const arriveWhy = $('pickArriveWhy');
  const freshEl = $('previewFresh');
  // 🔒 Confidential: lit, and not switched off here, for a file marked confidential (the server marks what is shown of it
  // whatever is sent); the pusher's own mark for a copy on this device, or a file of the room not marked (plan 4-§5.14).
  const secret = $('previewSecret');
  const secretBox = $('previewSecretBox');
  // The line above what goes, for every choice here (a pick, a picture, the document, what is in view), and ＋ the
  // speaker's screen, whose line is the pick's words, else that line.
  const lineNote = $('pickNote');
  const speaker = SpeakerLine.control($('pickLine'));
  /**
   * Body text drawn smaller than this on the Board's tablet is hard to read at a glance: the bar suggests What I see for a
   * whole page whose text would (provisional, until the device matrix's D2 is measured, docs/DEVICES.md §7; a tablet's take
   * taken as the glance box, PickBar.GLANCE).
   */
  const READABLE_PX = 16;
  /** The choice between a picture and the document made last on this device, drawn first (localStorage; a private window keeps none). */
  const LAST = 'agm.showAs';
  const ARRIVE = 'agm.showArrive';
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this device keeps no choice: the bar's default stands */ } };
  // Every push from the bar is information (a picture, a document, a quote): for a seat whose pushes hold stage.show.
  const may = () => docSeat() === 'research' && !ADMIN_VIEW && (F.canPush || F.canShow) && F.view !== 'simple' && Console.showsInfo();
  const src = () => (previewing ? Show.sourceOf(previewing.msg || previewing) : null);
  const pageNow = () => { const p = docView ? docView.place() : null; return p && p.page >= 1 ? p.page : 1; };
  /** Whom a push from the bar (or another To ▾, `sel`: the ❝ Quote tab's) goes to: the Board, or the person chosen ({to: {uid}, name}). */
  function target(sel = toSel) {
    const v = sel.value;
    if (!v || v === 'board') return { to: 'board', name: '' };
    const p = Console.people().find((x) => x.key === v);
    return p ? { to: { uid: p.key }, name: p.name } : { to: 'board', name: '' };
  }
  /** The information on the target's pages now ({seq, kind, op, mine, by, at}), over the show or beside it, or null. */
  function upThere(t = target()) {
    const o = t.to === 'board' ? Console.board() : Console.rowOf(t.to.uid);
    return o ? { info: o.info || o.beside || null, opOn: !!o.opOn } : { info: null, opOn: false };
  }
  /** Where a push arrives: as chosen (in `sel`), but in their side bar for a seat that may only show over the operator's information there. */
  function arrival(t = target(), sel = arriveSel) {
    const u = upThere(t);
    return !F.canPush && ((u.info && u.info.op) || u.opOn) ? 'side' : sel.value === 'side' ? 'side' : '';
  }
  /**
   * The targets drawn into a To ▾ (`to`): the Board, and the people the console's read lists (those seated On stage, for a
   * seat that may only show); where it arrives (`arrive`), the last chosen on this device, or their side bar, said why
   * (`why`), for a seat that may only show over the operator's information there.
   */
  function fillTargets(to, arrive, why) {
    const was = to.value || 'board';
    const list = [{ key: 'board', name: 'the Board' }].concat(Console.people());
    const keyOf = list.map((p) => p.key + '|' + p.name).join(',');
    if (to.dataset.keys !== keyOf) {
      to.dataset.keys = keyOf;
      to.textContent = '';
      for (const p of list) { const o = document.createElement('option'); o.value = p.key; o.textContent = 'Show ' + p.name; to.appendChild(o); }
    }
    to.value = list.some((p) => p.key === was) ? was : 'board';
    const u = upThere(target(to));
    const forced = !F.canPush && ((u.info && u.info.op) || u.opOn);
    arrive.disabled = forced;
    if (forced) arrive.value = 'side';
    else if (!arrive.dataset.chosen) arrive.value = read(ARRIVE) === 'side' ? 'side' : 'over';
    why.hidden = !forced;
    why.textContent = forced ? 'The operator is showing ' + kindSaid(u.info ? u.info.kind : 'web') + ' — this goes to their side bar.' : '';
  }
  const drawTargets = () => fillTargets(toSel, arriveSel, arriveWhy);
  /** A where-it-arrives choice made by hand (`sel`): kept for this bar, and on this device for every bar. */
  const chosen = (sel) => { sel.dataset.chosen = '1'; keep(ARRIVE, sel.value); };
  // Offered only over a file the reader drew: one it could not read (a password-protected Office file, a broken one) is
  // shown nowhere, and its hidden parts are known only once it is read.
  function draw() {
    const s = src();
    const ext = s ? extOfName(s.url || s.name) : '';
    const show = !!s && may() && docShown && Show.STAGE.includes(ext);
    bar.hidden = !show;
    if (!show) { PickBar.draw(); return; }
    drawTargets();
    const kept = previewing && previewing.msg ? findMessage(previewing.msg.id) || previewing.msg : null;
    const marked = !!kept && kept.confidential === true;
    if (marked) secret.checked = true;
    else if (secret.disabled) secret.checked = false;
    secret.disabled = marked;
    secretBox.title = marked ? 'Marked confidential: it goes only where it is in use, or where you send it.' : 'Mark what you show confidential: its words never go to the AI, nor to screens.';
    const n = pageNow();
    const image = Show.IMAGE.includes(ext);
    pic.hidden = !(image || ext === 'pdf');
    pic.textContent = image ? '📺 Show this picture' : '📺 Picture of p. ' + n;
    const place = Show.PLACE[ext];
    docBtn.textContent = '📺 Document' + (place ? ' at ' + (place === 'page' ? 'p.' : place) + ' ' + n : '');
    // The choice made last on this device is drawn first, as the bar's primary; the other beside it, one click away.
    const first = read(LAST) === 'document' ? docBtn : pic;
    pic.classList.toggle('primary', first === pic && !pic.hidden);
    pic.classList.toggle('ghost', !(first === pic && !pic.hidden));
    docBtn.classList.toggle('primary', first === docBtn || pic.hidden);
    docBtn.classList.toggle('ghost', !(first === docBtn || pic.hidden));
    const row = docBtn.closest('.row');
    const docBox = docBtn.closest('.preview-doc');
    if (first === docBtn && row.firstElementChild !== docBox) row.insertBefore(docBox, pic);
    if (first === pic && row.firstElementChild !== pic) row.insertBefore(pic, docBox);
    const hidden = !!docView && docView.hiddenParts();
    tick.disabled = hidden;
    if (hidden) tick.checked = false;
    why.hidden = !hidden;
    why.textContent = hidden ? Show.HIDDEN_PARTS : '';
    regionBtn.hidden = ext !== 'pdf';
    noMetaBox.hidden = !image;
    const size = s.file ? s.file.size : previewing && previewing.msg ? previewing.msg.size : 0;
    const t = target();
    const whom = t.to === 'board' ? 'the Board' : t.name;
    // A page's picture says its size once it has been drawn here (kept to show again); until then, what it is.
    const drawnBytes = ext === 'pdf' ? Show.drawnSize(s, n) : 0;
    const small = ext === 'pdf' ? smallText(n) : 0;
    // The target's pages that cannot open documents get the document's stand-in, said before it goes (plan 4-§5.15.2).
    const older = image ? '' : Show.olderWords(t.to, ext, Show.atOf(ext, n), t.name);
    note.textContent = (image ? 'Show ' + whom + ' this picture' + (noMeta.checked ? ', drawn again without its metadata' : '')
      : (ext === 'pdf' ? 'Picture of p. ' + n + ': this page only, as a picture' + (drawnBytes ? ' (' + sizeWords(drawnBytes) + ')' : '') + '. ' : '') + 'Document: the whole file' + (size ? ' (' + sizeWords(size) + ')' : '') + ', opened ' + (place ? 'at ' + (place === 'page' ? 'p.' : place) + ' ' + n : 'here') + ' — ' + (t.to === 'board' ? 'the Board' : whom) + ' can page through it'
        + (older ? '; ' + older : ''))
      + (s.file ? '. It is uploaded as you show it.' : '.')
      + (small ? ' Whole, its text stands about ' + small + ' px tall on a tablet — 🔳 What I see sends the part in view, larger.' : '');
    PickBar.draw();
    // Another pusher's information under 15 s old, said for every choice here; with a pick, its bar says it with Replace.
    const f = PickBar.shown() ? '' : PickBar.fresh();
    freshEl.textContent = '';
    if (f) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost small';
      b.textContent = 'Show a person instead';
      b.addEventListener('click', () => toSel.focus());
      freshEl.append(f + ' — what you show replaces it · ', b);
    }
    freshEl.hidden = !f;
  }
  /**
   * ＋ the speaker's screen drawn for what the bar would push now, and which of its pushes carries that line: the picked
   * words, with the pick's own Show (and its unit from the pick's menu); else the line above it, with a picture (of the page,
   * a region or what is in view) or the document. Any other push of the bar carries its own line, which ＋ never showed, so
   * it goes without one and its toast says why.
   */
  function drawLine() {
    const picked = PickBar.lineContent();
    const marked = secret.checked ? { confidential: true } : {};
    speaker.draw(picked ? { ...picked, ...marked } : { kind: 'doc', note: lineNote.value.trim(), ...marked }, 'Pick words in the file, or type a line above it, to put one on the speaker\'s screen.',
      picked ? 'It goes with the picked words, by their 📺 Show.' : 'It goes with a picture or the document.');
  }
  /** What a push from the bar carries besides itself: the line above it, and what ＋ asks with it (SpeakerLine take()); ＋ is off again after it. */
  function withPush() {
    const out = { note: lineNote.value.trim(), line: speaker.take(), confidential: secret.checked };
    speaker.reset();
    return out;
  }
  /** How tall a whole PDF page's body text would stand on a tablet's take, in px, where under READABLE_PX; else 0. */
  function smallText(n) {
    const ts = docView && typeof docView.textSize === 'function' ? docView.textSize(n) : null;
    if (!ts || !(ts.text > 0) || !(ts.width > 0) || !(ts.height > 0)) return 0;
    const px = ts.text * Math.min(PickBar.GLANCE.width / ts.width, PickBar.GLANCE.height / ts.height);
    return px < READABLE_PX ? Math.max(1, Math.round(px)) : 0;
  }
  let queued = false;
  docDisplay.addEventListener('scroll', () => {
    if (bar.hidden || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }, { passive: true, capture: true });
  pic.addEventListener('click', () => {
    const s = src();
    if (!s) return;
    keep(LAST, 'picture');
    const t = target();
    Show.picture(s, pageNow(), t.to, { view: docView, name: t.name, arrive: arrival(t), bare: Show.IMAGE.includes(extOfName(s.url || s.name)) && noMeta.checked, ...withPush() });
    draw();
  });
  docBtn.addEventListener('click', () => {
    const s = src();
    if (!s) return;
    keep(LAST, 'document');
    const t = target();
    Show.whole(s, Show.atOf(extOfName(s.url || s.name), pageNow()), tick.checked && !tick.disabled, t.to, { name: t.name, arrive: arrival(t), ...withPush() });
    tick.checked = false;
    draw();
  });
  seenBtn.addEventListener('click', () => PickBar.seen());
  regionBtn.addEventListener('click', () => {
    if (!docView) return;
    const on = docView.region(regionBtn.getAttribute('aria-pressed') !== 'true');
    regionBtn.setAttribute('aria-pressed', String(on));
    AGM.toast(on ? 'Drag over the page to draw the region to send; the arrow keys nudge it, Shift and the arrows resize it.' : 'Region off: a drag selects words again.');
  });
  noMeta.addEventListener('change', draw);
  lineNote.addEventListener('input', () => { if (!bar.hidden) drawLine(); });
  secret.addEventListener('change', () => { if (!bar.hidden) drawLine(); });
  toSel.addEventListener('change', draw);
  arriveSel.addEventListener('change', () => { chosen(arriveSel); draw(); });
  // Each read of the console draws the bar again: where the target stands, and whether this seat may show at all.
  Console.onDraw(() => { if (!bar.hidden || (src() && docShown)) draw(); });
  return { draw, drawLine, withPush, target, arrival, upThere, fillTargets, chosen };
})();

// ---------------- ❝ Quote: words pasted or typed, shown on people's pages as a quote ----------------
/**
 * The ❝ Quote tab (plan 4-§5.9.9; backstage, for a seat that may show the Board, in the full view): words pasted or typed
 * in its box, shown on the Board's pages, or one person's, as a quote, the path for a highlight inside a web page (which a
 * page cannot read) and for a document open on the researcher's own machine. A paste into the empty box is read from the
 * paste event's own clipboard (which needs no secure context): its text/html flavour for its structure alone, through
 * parseInert (docmodel.mjs: nothing in it loads or runs, and hidden parts are never read), and kept only where its words
 * are its text/plain flavour's, so no word the person did not see arrives; tab-separated words are a table (pastedQuote).
 * A paste among words already there, and words typed, are read as plain words. From: nothing (typed by them), a file of
 * this room that has words, or a web page by its address: the Board's pages are given its link only where this seat may
 * show a web page itself (the server keeps it so), and are otherwise named the site alone, as the tab says. Drawn first
 * exactly as the Board's page will draw it (pagelayer.mjs quote), its bound said in the server's words with the cut as the
 * researcher's own choice, and "Long for the stage" where it is longer than a glance on a tablet (never a refusal), then whom
 * it goes to and where it arrives as the Preview's bar has them (over another pusher's fresh information: Replace, or Show
 * a person instead), and Show. The box is emptied once the server took it. A file is never a quote: one pasted or dropped
 * here is refused with words, never attached to a message. Drawn for a seat whose information pushes hold stage.show (the
 * console's read), never for one that may show only web pages.
 */
const QuoteTab = (() => {
  const $ = (id) => document.getElementById(id);
  const tab = $('quoteTab');
  const form = $('quotePane');
  const box = $('quoteInput');
  const fromSel = $('quoteFrom');
  const webIn = $('quoteWeb');
  const sayEl = $('quoteSay');
  const preview = $('quotePreview');
  const toSel = $('quoteTo');
  const arriveSel = $('quoteArrive');
  const arriveWhy = $('quoteArriveWhy');
  const note = $('quoteNote');
  const showBtn = $('quoteShow');
  // ＋ the speaker's screen: the quote's words in one line, with the push.
  const speaker = SpeakerLine.control($('quoteLine'));
  const NONE = 'Paste or type what to show first.';
  let pasted = null;   // the last paste as read ({words, quote}), while the box still holds its words
  let cut = false;     // the researcher chose the cut
  let model = null;    // docmodel.mjs, once imported
  let drawn = 0;       // each drawing numbered: one drawn late for an older one is let go
  let glanced = null;  // {key, long}: whether the quote drawn now is longer than a glance, kept while it stands
  const may = () => docSeat() === 'research' && !ADMIN_VIEW && (F.canPush || F.canShow) && F.view !== 'simple' && Console.showsInfo();
  const open = () => !form.classList.contains('hidden');
  const reader = () => (model ? Promise.resolve(model) : import('/docmodel.mjs').then((m) => { model = m; return m; }));
  /** The quote the box holds now: the paste as read while the box holds its words, else its words read as plain words; cut as chosen. */
  function quoteNow() {
    if (!model) return null;
    const q = pasted && pasted.words === box.value ? pasted.quote : model.pastedQuote({ plain: box.value }).quote;
    return q && cut ? model.pasteCut(q) : q;
  }
  /** This room's files a quote may say it is from: those the stage shows that hold words (a picture holds none). */
  const files = () => [...roomFiles.values()].filter((m) => !m.transferOnly && isFileUrl(m.url) && Show.STAGE.includes(extOfName(m.url)) && !Show.IMAGE.includes(extOfName(m.url)));
  function drawFrom() {
    const was = fromSel.value || '';
    const list = [['', 'Nothing (typed by ' + (pageFacts.name || 'you') + ')'], ['web', 'A web page…'], ...files().map((m) => ['file:' + m.id, m.filename || 'a file'])];
    const key = list.map((o) => o.join('|')).join(',');
    if (fromSel.dataset.key !== key) {
      fromSel.dataset.key = key;
      fromSel.textContent = '';
      let group = null;
      for (const [value, label] of list) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        if (value.startsWith('file:')) {
          if (!group) { group = document.createElement('optgroup'); group.label = 'A file in this room'; fromSel.appendChild(group); }
          group.appendChild(o);
        } else fromSel.appendChild(o);
      }
    }
    fromSel.value = list.some((o) => o[0] === was) ? was : '';
    webIn.hidden = fromSel.value !== 'web';
  }
  /** Where the quote is from, as it is sent: a file of this room by its address, a web page by its address, or none (typed). */
  function fromOf() {
    const v = fromSel.value;
    if (v === 'web') return { web: webIn.value.trim() };
    if (v.startsWith('file:')) { const m = roomFiles.get(v.slice(5)); return m ? { url: m.url } : null; }
    return undefined;
  }
  /**
   * Where it is from as the Board's page will be told it ({from}, {} for typed), or {error}: a file by its name and type, a
   * web page by its host, its address with it only where this seat may show a web page.
   */
  function toldFrom(m) {
    const v = fromSel.value;
    if (v === 'web') {
      if (!webIn.value.trim()) return { error: 'Type the web page\'s address, or choose another From.' };
      const w = m.webAddress(webIn.value);
      return w.error ? { error: w.error } : { from: { host: w.host, ...(F.canWeb ? { url: w.url } : {}) } };
    }
    if (v.startsWith('file:')) { const f = roomFiles.get(v.slice(5)); return f ? { from: { name: f.filename || 'a file', type: extOfName(f.url) } } : { error: 'That file is no longer in this room.' }; }
    return {};
  }
  /** What the box's quote is, in a few words: "A table, 3 rows × 2 columns", "A list, 2 items", "Text, 42 characters". */
  function what(q) {
    if (q.table) { const r = q.table.rows.length; const c = Math.max(0, ...q.table.rows.map((x) => x.length)); return 'A table, ' + r + (r === 1 ? ' row' : ' rows') + ' × ' + c + (c === 1 ? ' column' : ' columns'); }
    if (Array.isArray(q.items)) return 'A list, ' + q.items.length + (q.items.length === 1 ? ' item' : ' items');
    const n = model.charsOf(q.text);
    return 'Text, ' + n + (n === 1 ? ' character' : ' characters');
  }
  const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = label; b.addEventListener('click', fn); return b; };
  const say = (parts) => { sayEl.textContent = ''; for (const p of parts) sayEl.append(p); sayEl.hidden = !parts.length; };
  /** The tab drawn as it stands: shown to a seat that may show the Board, and while it is open, its choices and what will go. */
  async function draw() {
    const on = may();
    tab.hidden = !on;
    if (!on) { if (open()) selectTab('text'); return; }
    if (!open()) return;
    drawFrom();
    const secretTick = document.getElementById('quoteSecret');
    const marked = secretTick && secretTick.checked ? { confidential: true } : {};
    // Until the quote is read below, the ＋ is drawn for the words in the box read as plain words (before what reads a
    // quote has come, the box's words as they are), marked as the 🔒 tick marks it, and Show is offered only once it is
    // read (app.html draws it disabled).
    speaker.draw({ kind: 'snippet', ...(model ? quoteNow() || {} : { text: box.value }), ...marked }, NONE);
    PreviewBar.fillTargets(toSel, arriveSel, arriveWhy);
    const t = PreviewBar.target(toSel);
    showBtn.textContent = '📺 Show ' + (t.to === 'board' ? 'the Board' : t.name);
    const n = ++drawn;
    let m;
    try { [m] = await Promise.all([Takes.load(), reader()]); } catch {
      if (n !== drawn) return;
      say(['This page could not load what reads a quote: reload it.']);
      showBtn.disabled = true;
      return;
    }
    if (n !== drawn) return;
    const q = quoteNow();
    const told = toldFrom(m);
    const over = q ? model.pasteOver(q) : null;
    const words = note.value.trim();
    // What will go, as the Board's page draws it: measured at a glance on a tablet (PickBar.long), once for each quote.
    const content = q && !over && !told.error ? { kind: 'snippet', ...q, ...(told.from ? { from: told.from } : {}), ...(words ? { note: words } : {}), ...marked } : null;
    const key = content ? JSON.stringify(content) : '';
    if (content && (!glanced || glanced.key !== key)) glanced = { key, long: PickBar.long(m, content) };
    const parts = [];
    if (q) parts.push(what(q) + (q.cut ? ', cut as you chose' : '') + '. ');
    if (over) {
      parts.push(over.error + '. ');
      if (over.cut) parts.push(button(over.cut === 'chars' ? 'Send the first 1,200 characters' : 'Send the first 25 rows × 10 columns', () => { cut = true; draw(); }));
    }
    if (told.error && (q || fromSel.value === 'web')) parts.push(told.error + ' ');
    if (fromSel.value === 'web' && !told.error && !F.canWeb) parts.push('The Board is told the site\'s name, without a link: web pages on the stage need their own right. ');
    const f = q ? PickBar.fresh(t, draw, 'quote') : null;
    if (f) parts.push(f + ' — ', button('Replace', () => show()), ' · ', button('Show a person instead', () => toSel.focus()), ' ');
    if (content && glanced.long) { const w = document.createElement('span'); w.className = 'pick-glance-words'; w.textContent = 'Long for the stage — the Board will scroll.'; parts.push(w); }
    say(parts);
    showBtn.disabled = !q || !!over || !!told.error;
    speaker.draw(content, over ? over.error : told.error || NONE);
    preview.textContent = '';
    if (content) preview.appendChild(m.quote(content, { by: pageFacts.name || '' }));
  }
  function clear() {
    box.value = '';
    note.value = '';
    pasted = null;
    cut = false;
    draw();
  }
  // A paste into the empty box (or over all its words) is read for its structure; among words already there the browser
  // pastes the plain words, read as typed. A paste here is a quote's words, never a file attached to a message.
  box.addEventListener('paste', (e) => {
    e.stopPropagation();
    const cd = e.clipboardData;
    if (!cd) return;
    const plain = cd.getData('text/plain');
    if (!plain) {
      if (cd.files && cd.files.length) { e.preventDefault(); AGM.toast('A picture has no words to quote: open it in the Preview to show a picture of it.', true); }
      return;
    }
    if (!(box.selectionStart === 0 && box.selectionEnd === box.value.length)) return;
    e.preventDefault();
    const html = cd.getData('text/html');
    reader().then((mod) => {
      const r = mod.pastedQuote({ plain, blocks: html ? mod.parseInert(html).blocks : null });
      box.value = r.words;
      pasted = r.quote ? { words: box.value, quote: r.quote } : null;
      cut = false;
      draw();
    }, () => AGM.toast('This page could not load what reads a paste: reload it.', true));
  });
  // A file dragged over the tab is refused where it would land (no drop, the composer's included); one dropped anyway is said.
  const carriesFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  form.addEventListener('dragover', (e) => { if (!carriesFiles(e)) return; e.stopPropagation(); e.preventDefault(); e.dataTransfer.dropEffect = 'none'; });
  form.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.stopPropagation();
    e.preventDefault();
    AGM.toast('A file is not a quote: open it in the Preview to show it from there, or paste the words to quote here.', true);
  });
  box.addEventListener('input', () => { cut = false; draw(); });
  fromSel.addEventListener('change', () => { webIn.hidden = fromSel.value !== 'web'; if (!webIn.hidden) webIn.focus(); draw(); });
  webIn.addEventListener('input', () => draw());
  note.addEventListener('input', () => draw());
  // 🔒 Confidential changes what ＋ says of the line, and whether it may go at all.
  $('quoteSecret').addEventListener('change', () => draw());
  toSel.addEventListener('change', () => draw());
  arriveSel.addEventListener('change', () => { PreviewBar.chosen(arriveSel); draw(); });
  // Show is the one way it goes: Enter in a field never sends it (the form has no submit button).
  form.addEventListener('submit', (e) => e.preventDefault());
  /** The quote in the box shown as the tab has it: Show, and Replace over another pusher's fresh information. */
  function show() {
    if (!model || !may()) return;
    const q = quoteNow();
    if (!q) { AGM.toast('Paste or type what to show first.', true); box.focus(); return; }
    const over = model.pasteOver(q);
    if (over) { AGM.toast(over.error + '.', true); return; }
    const from = fromOf();
    if (from === null) { AGM.toast('That file is no longer in this room.', true); return; }
    if (from && from.web === '') { AGM.toast('Type the web page\'s address, or choose another From.', true); webIn.focus(); return; }
    const t = PreviewBar.target(toSel);
    const words = note.value.trim();
    const sent = box.value;
    const line = speaker.take();
    speaker.reset();
    // 🔒 Confidential: the pusher's own mark on words typed or pasted (plan 4-§5.14): never to the AI, nor to screens.
    const secretBox = document.getElementById('quoteSecret');
    const secret = !!secretBox && secretBox.checked;
    Console.showFile(t.to, { kind: 'snippet', ...q, ...(from ? { from } : {}), ...(words ? { note: words } : {}), ...(secret ? { confidential: true } : {}) }, { name: t.name, arrive: PreviewBar.arrival(t, arriveSel), line, taken: () => { if (box.value === sent) { clear(); if (secretBox) secretBox.checked = false; } } });
  }
  showBtn.addEventListener('click', show);
  tab.addEventListener('click', () => { draw(); box.focus(); });
  Console.onDraw(() => draw());
  return { draw, field: () => box };
})();

// ---------------- A web page previewed, or what was shown looked at again: on this page alone ----------------
// A web page's Preview: the address its ask was answered with, framed by the one frame a page makes (pagelayer.mjs
// framePage), in a dialog of its own; Show it there runs the act with that answer, and closing it takes the frame away. A
// Look (an Earlier entry's): the same dialog, with nothing to show from it, the web page framed or a document, a picture or
// a quote drawn as its take was (pagelayer.mjs render), its reader let go and its pictures' object URLs revoked as it closes, and
// as the entry leaves Earlier. Neither reports anything: it is this person's own look.
const Preview = (function () {
  const $ = (id) => document.getElementById(id);
  const dlg = $('webPreview');
  const box = $('webPreviewBox');
  let then = null;
  let drawer = null;       // pagelayer.mjs, as the open dialog was drawn by it
  let seq = 0;             // the Earlier entry the dialog shows now, 0 for none
  function show(what, name, hint, go) {
    $('webPreviewWhat').textContent = what;
    $('webPreviewHost').textContent = name;
    $('webPreviewHint').textContent = hint;
    then = typeof go === 'function' ? go : null;
    // A Look (an Earlier entry's) shows nothing from here: no Show it.
    $('webPreviewShow').hidden = !then;
    if (!dlg.open) AGM.openDialog(dlg);
  }
  const LOOK = 'Only you see it here: looking at it again tells nobody.';
  function letBoxGo() { if (drawer) drawer.clear(box); else box.textContent = ''; drawer = null; seq = 0; }
  function open(m, url, go) {
    const made = m.framePage(url);
    if (made.error) { AGM.toast(made.error, true); return; }
    letBoxGo();
    // At a place: the words its address asks to be found, said above the frame, which never highlights them.
    const wrap = document.createElement('div');
    wrap.className = 'take-web';
    const look = m.lookFor(made.url);
    if (look) { const p = document.createElement('p'); p.className = 'take-web-look'; p.textContent = 'Look for: ❝ ' + look; wrap.append(p); }
    wrap.append(made.frame);
    box.append(wrap);
    show(go ? 'Preview' : 'Look', made.host, go ? 'Only you see it here. Show it puts it on their pages; nothing is sent until then.' : LOOK, go);
  }
  /**
   * A document, a picture or a quote an Earlier entry (`e`) showed, drawn again here alone, as the take was (on a device that
   * cannot open documents, a document's stand-in, or its words: `said`, drawn in the box, so no toast repeats them).
   */
  function look(m, e, ctx, heard = (r) => r) {
    letBoxGo();
    drawer = m;
    seq = e.seq;
    show('Look', (e.content && (e.content.name || (e.content.kind === 'snippet' ? 'A quote' : ''))) || 'Shown earlier', LOOK, null);
    Promise.resolve(m.render(box, e.content, ctx)).then((r) => {
      heard(r);
      if (seq === e.seq && r && r.state === 'failed' && r.said !== true) AGM.toast('This could not be shown again: ' + r.words + '.', true);
    }, () => AGM.toast('This page could not load what draws it: reload it.', true));
  }
  /** The Earlier entries the dialog shows now (a Look's), by number. */
  const looking = () => (dlg.open && seq ? [seq] : []);
  /** The Look of `n` closed, its reader let go: the entry is gone (withdrawn, ended). */
  function letGo(n) { if (seq && seq === n) { if (dlg.open) dlg.close(); letBoxGo(); } }
  dlg.addEventListener('close', () => { letBoxGo(); then = null; });
  // What a Look draws is On stage content: AGMessage's menu (none, here) in place of the browser's, Shift+right-click too.
  AGM.menu.door(box, () => ({ el: box, more: null, open: () => true }), { stage: true });
  $('webPreviewShow').addEventListener('click', () => {
    const go = then;
    dlg.close();
    if (go) go();
  });
  return { open, look, looking, letGo };
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

// ---------------- The clock or countdown: the simple view's secondary object (plan 7-§17.3) ----------------
// What the simple view draws after the hall's name, and on the take layer's bar: the time of day (🕐 14:12, a <time>, by
// AGMessage's clock and zone, hours and minutes, drawn again on the minute), Stagewatch's countdown (its digits a timer, its
// title and Stagewatch's line under them, in Stagewatch's own words for its phase, its colour the readout's edge alone;
// --:-- with why whenever its time is not live), or nothing. Which one is AGM.clockFor's, from the admin's choice for this
// person (the join's `clock`, then each `clock` the server tells) and this device's own (`agm.clock`, chosen in the sheet
// and kept on this device alone; the support view's, the person's as their device relays it, never its own). It is text,
// never a control; the full view keeps its countdown chip.
const Clock = (function () {
  const KEY = 'agm.clock';
  const SHOWS = ['off', 'time', 'stage'];
  /** Stagewatch's phases near the end or past it: the readout's ▲, its words saying which. */
  const SOON = ['warning', 'wrapup', 'overtime'];
  const head = document.getElementById('bvReadout');
  const bar = document.getElementById('layerReadout');
  let admin = { show: null, locked: false };
  // This device's own choice, as stored; the support view holds none of its own until the person's page relays theirs.
  let device = null;
  if (!ADMIN_VIEW) { try { const v = localStorage.getItem(KEY); device = SHOWS.includes(v) ? v : null; } catch { /* storage blocked: none chosen here */ } }
  let offset = 0;      // AGMessage's clock against this device's
  let tz = '';
  let fmt = null;
  let tick = null;
  let drawnKey = '';
  const shown = () => AGM.clockFor({ admin, device });
  /** The time of day by AGMessage's clock, in its zone (a browser that does not know the zone, its own): "14:12". */
  function timeNow() {
    if (!fmt) {
      const o = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
      try { fmt = new Intl.DateTimeFormat([], tz ? { ...o, timeZone: tz } : o); } catch { fmt = new Intl.DateTimeFormat([], o); }
    }
    const parts = fmt.formatToParts(new Date(Date.now() + offset));
    const part = (t) => (parts.find((x) => x.type === t) || { value: '00' }).value;
    return part('hour') + ':' + part('minute');
  }
  /**
   * The countdown as Stagewatch says it: live only while the link is connected (or viewing), its frame fresh and this page
   * connected (the screen page's rule); then its phase's words and mark and its own digits, the title and its line under
   * them, its colour the edge (none for its white, which is no colour). Not live, --:-- and why. Live with no time yet (a
   * link's first moment, or a frame that carries none), --:-- with the title and its line, as the screen page draws it:
   * never "offline" for a link that is up.
   */
  function stageNow() {
    const v = pageFacts.stage;
    if (!v || v.status === 'off') return { mark: '⏱', time: '--:--', line: 'No Stagewatch linked', live: false, edge: '' };
    const live = (v.status === 'connected' || v.status === 'viewing') && !v.stale && socket.connected;
    if (!live) return { mark: '⏱', time: '--:--', line: 'Stagewatch offline', live: false, edge: '' };
    if (!v.text) return { mark: '⏱', time: '--:--', line: [v.title, v.message].filter(Boolean).join(' · '), live: true, edge: '' };
    const text = String(v.text);
    const soon = SOON.includes(v.phase);
    let time = text;
    if (v.mode === 'countdown') {
      if (v.phase === 'overtime') time = text.replace(/^[-−]/, '') + ' over';
      else if (v.phase === 'wrapup') time = 'Wrap up · ' + text + ' left';
      else time = text + ' left';
    }
    const edge = /^#[0-9A-Fa-f]{6}$/.test(v.color || '') && !/^#ffffff$/i.test(v.color) ? v.color : '';
    return { mark: v.mode === 'countdown' && soon ? AGM.mark('soon') : '⏱', soon: v.mode === 'countdown' && soon, time, line: [v.title, v.message].filter(Boolean).join(' · '), live: true, edge };
  }
  /**
   * One readout drawn: its parts made once for what it shows and their words written only when they change, so a screen
   * reader hears the title and the line (the header's status region) once, and the digits (a timer) only when asked.
   * `live` is false on the take layer's copy: one status region on the page.
   */
  function fill(el, what, o, live) {
    if (el.dataset.what !== what) {
      el.textContent = '';
      el.dataset.what = what;
      const line = document.createElement('span');
      line.className = 'bv-ro-line';
      const mark = document.createElement('span');
      mark.className = 'bv-ro-icon';
      mark.setAttribute('aria-hidden', 'true');
      const time = document.createElement(what === 'time' ? 'time' : 'span');
      time.className = 'bv-ro-time';
      // A timer named by its own words ("4:30 left", "0:30 over"), read when asked, never every second.
      if (what === 'stage') time.setAttribute('role', 'timer');
      line.append(mark, time);
      el.appendChild(line);
      if (what === 'stage') {
        const strip = document.createElement('span');
        strip.className = 'bv-ro-strip';
        if (live) strip.setAttribute('role', 'status');
        el.appendChild(strip);
      }
    }
    const mark = el.querySelector('.bv-ro-icon');
    const time = el.querySelector('.bv-ro-time');
    if (mark.textContent !== o.mark) mark.textContent = o.mark;
    mark.classList.toggle('soon', !!o.soon);
    if (time.textContent !== o.time) time.textContent = o.time;
    if (what === 'time') time.setAttribute('datetime', o.time);
    const strip = el.querySelector('.bv-ro-strip');
    if (strip) { if (strip.textContent !== o.line) strip.textContent = o.line; strip.hidden = !o.line; }
    el.classList.toggle('stale', what === 'stage' && !o.live);
    el.style.setProperty('--bv-sw', o.edge || 'var(--c-border)');
  }
  /** Each readout as it should be now, the minute's redraw asked where the time of day is drawn. */
  function draw() {
    const simple = F.view === 'simple' && !outOf;
    const what = shown();
    const o = !simple || what === 'off' ? null : what === 'time' ? { mark: '🕐', time: timeNow(), line: '', live: true, edge: '' } : stageNow();
    for (const [el, live] of [[head, true], [bar, false]]) {
      el.hidden = !o;
      if (o) fill(el, what, o, live);
    }
    // A phone's header draws Stagewatch's line on a row of its own, only while there is one (styles.css).
    document.body.dataset.roLine = o && what === 'stage' && o.line ? '1' : '0';
    const key = o ? what : '';
    if (key !== drawnKey) { drawnKey = key; clearTimeout(tick); tick = null; }
    if (key === 'time' && !tick) {
      const now = Date.now() + offset;
      tick = setTimeout(() => { tick = null; draw(); }, 60000 - (now % 60000) + 50);
    }
  }
  return {
    draw,
    shown,
    locked: () => admin.locked === true,
    /** The join's answer: AGMessage's clock and zone, and the admin's choice for this person. */
    joined(res) {
      if (Number.isFinite(res.now)) offset = res.now - Date.now();
      if (typeof res.tz === 'string' && res.tz !== tz) { tz = res.tz; fmt = null; }
      this.admin(res.clock);
    },
    /** The admin's choice for this person, as the server tells it ({show, locked}): drawn at once, the sheet's row in place. */
    admin(c) {
      admin = AGM.catalog.adminClockOf({ clock: c });
      draw();
    },
    /** This device's own choice, made in its sheet: kept on this device, told to the admin's support view alone, drawn now. */
    choose(v) {
      if (!SHOWS.includes(v) || ADMIN_VIEW) return;
      device = v;
      try { localStorage.setItem(KEY, v); } catch { /* storage blocked: this page's own run keeps it */ }
      pushUserState('clock', v);
      draw();
    },
    /** The person's device's choice, relayed to the support view (and only there): drawn as theirs. */
    relayed(v) { if (ADMIN_VIEW && SHOWS.includes(v)) { device = v; draw(); } },
    /** This device's own choice, for the support view's ask (userState:request): none where none was made. */
    own: () => (ADMIN_VIEW ? null : device),
  };
})();

// ---------------- The Board's chat view: the simple view ----------------
// The view a person's page draws is the server's (the join's `view`, then each `view` it tells): the simple view for a
// seat On stage unless the admin chose Full, the full view elsewhere. The simple view is the chat first and compact:
// one reading column, one response place per screen after the words it answers (Got it and Reply on the newest message
// from backstage that waits for this person, and on each 🔥 one; a tap brings any other's own row back), questions with
// their answers, a 🔥 strip only while its message is out of view, the composer with 🔥 Priority first, and a ⋯ sheet in
// place of the header's menu. It has no menu door and acts on Tab, Enter and Escape alone. Everything it shows is drawn
// from facts the server already sends: what waits is this page's reading of the room's messages, never a field of its
// own. Its layout follows the screen's size and each feature a probe, never the device's name (styles.css).
const Simple = (function () {
  const body = document.body;
  const root = document.documentElement;
  let view = 'full';
  // Whether the screen can be kept awake: AGM.awake's last word ({held} or {held: false, why, words}), or null not asked.
  let awake = null;
  let stopAwake = null;
  // Who is backstage in the room, and since when nobody (the line over the composer says so after 10 s).
  const ALONE_MS = 10000;
  let aloneTimer = null;
  // The 🔥 message the strip would hold, and whether its node is in view (IntersectionObserver, where the browser has it):
  // unknown until the observer has said, and the strip waits for it, so it never comes and goes as a message is drawn.
  let hotId = '';
  let hotSeen = null;
  // What the strip says now, as last drawn: it is a status region, so its words are written only when they change, and a
  // screen reader says the 🔥 message once, not again with every message drawn.
  let stripSaid = '';
  const seer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { for (const en of entries) if (en.target.dataset.id === hotId) hotSeen = en.isIntersecting; drawStrip(); }, { root: feed, threshold: 0.5 })
    : null;
  // The feed's height moves with what the simple view draws around it (the strip, the line over the composer, the tabs):
  // a reader at its end stays at its end.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (isSimple() && place.atEnd) feed.scrollTop = feed.scrollHeight; }).observe(feed);
  let watched = null;
  const $ = (id) => document.getElementById(id);
  const isSimple = () => view === 'simple';

  /** The view to draw now: the body says it, the facts carry it, every message is drawn again, the theme follows. */
  function setView(v) {
    const next = v === 'simple' ? 'simple' : 'full';
    const was = view;
    const atEnd = place.atEnd;
    view = next;
    body.dataset.view = next;
    // The hall page's first paint reads the view it last drew (theme-init.js); the support view is the admin's browser.
    if (!ADMIN_VIEW) { try { localStorage.setItem('agm.lastView', next); } catch { /* storage blocked: the first paint is light */ } }
    // A theme never chosen: dark in the simple view, light in the full view (the Board's view starts in Dark).
    if (!chosenTheme()) applyTheme(next === 'simple' ? 'dark' : 'light');
    factsChanged({ view: next, waiting: next === 'simple' ? waitingNow() : null, tapped: '', changing: '' });
    drawComposerSeat();
    if (was !== next) {
      // A backstage page's words go with it to the composer the view draws, and so does a reply begun.
      if (ROLE === 'research') {
        const [from, to] = next === 'simple' ? [textInput, dInput] : [dInput, textInput];
        if (from.value && !to.value) { to.value = from.value; from.value = ''; }
      }
      const chip = $('replyChip');
      if (chip) chip.remove();
      for (const m of allMessages) { const n = messagesById.get(m.id); if (n && n.classList.contains('msg')) rerenderMessage(n, m); }
      refreshPinned();
      renderReplyChip();
      drawComposers();
      drawSkip();
      drawNewBelow(place.unread, place.asks);
      if (atEnd) { feed.scrollTop = feed.scrollHeight; place.atEnd = true; }
    }
    const head = document.getElementById('docPanelTitle');
    if (head) { head.textContent = panelHeading(); docPanel.setAttribute('aria-label', head.textContent); }
    // The full view's split, dragged and kept, is not the simple view's: its column follows the screen's size.
    if (was !== next) { if (next === 'simple') applySplit(0); else restoreSplit(); }
    if (next === 'simple' && !ADMIN_VIEW && !stopAwake) stopAwake = AGM.awake((st) => { awake = st; if (sheetOpen()) drawSheet(); });
    if (next !== 'simple' && stopAwake) { stopAwake(); stopAwake = null; awake = null; }
    if (next !== 'simple') closeSheet(false);
    drawAlone(people);
    layout();
    fitPlaceholder();
    drawStrip();
    drawEmpty();
    Takes.redraw();
    Clock.draw();
  }

  /**
   * What waits for this person's answer: a message of someone else's (text or a file) that they have not answered by
   * their 👍, a reply of theirs that quotes it, or (for a question, which is not here) their answer. A plain one only from
   * backstage, the oldest first; a 🔥 one from anyone else.
   */
  function waitingNow() {
    const plain = [];
    const priority = [];
    if (!MY_UID) return { plain, priority };
    const replied = new Set(allMessages.filter((m) => isMine(m) && m.replyTo && m.replyTo.id).map((m) => m.replyTo.id));
    for (const m of allMessages) {
      if (!m.from || isMine(m) || !(m.type === 'text' || m.type === 'file')) continue;
      if (replied.has(m.id) || (Array.isArray(m.reactions) && m.reactions.some((r) => r.uid === MY_UID && r.emoji === '👍'))) continue;
      if (m.priority) priority.push(m.id);
      else if (m.from.role === 'research') plain.push(m.id);
    }
    return { plain, priority };
  }
  /**
   * What waits read again, once after whatever this task draws (a history is many messages, read once); in the full view,
   * what Got it clears alone (the person's 👍 is the same fact there).
   */
  let waitsDue = false;
  function waits() {
    if (waitsDue) return;
    waitsDue = true;
    Promise.resolve().then(() => {
      waitsDue = false;
      if (!isSimple()) { drawCleared(); return; }
      // A response drawn or taken away moves what is below it: a reader at the end of the chat stays at its end.
      const end = place.atEnd || nearEnd();
      factsChanged({ waiting: waitingNow() });
      if (end) { feed.scrollTop = feed.scrollHeight; place.atEnd = true; }
      for (const m of allMessages) { const n = messagesById.get(m.id); if (n && n.classList.contains('msg')) said(n, m); }
      drawCleared();
      drawStrip();
      drawEmpty();
    });
  }

  /**
   * A message's status words, at the end of its author's line, in the simple view: on one of this person's own,
   * "Sent", or "Seen by Ana" once a backstage seat has read it ("Seen by Ana and 2 more" past two); on another's, "👍 You:
   * got it" once they answered it so.
   */
  function said(node, m) {
    const el = node.querySelector(':scope > header .bv-said');
    if (!el) return;
    let words = '';
    if (isSimple() && m.from && m.type !== 'system') {
      if (isMine(m)) {
        const by = Number.isInteger(m.seq) ? Array.from(seenBy.values()).filter((x) => x.role === 'research' && x.seq >= m.seq).map((x) => x.name) : [];
        words = !by.length ? 'Sent' : by.length <= 2 ? 'Seen by ' + by.join(' and ') : 'Seen by ' + by[0] + ' and ' + (by.length - 1) + ' more';
      } else if (Array.isArray(m.reactions) && m.reactions.some((r) => r.uid === MY_UID && r.emoji === '👍')) words = '👍 You: got it';
    }
    if (el.textContent !== words) el.textContent = words;
  }

  /** The second door: the message tapped (or Enter on it) shows its own row, Got it where it waits, and Reply. */
  function tap(id, { focus = false } = {}) {
    if (!isSimple()) return;
    if (F.tapped !== id) factsChanged({ tapped: id || '' });
    if (!focus || !id) return;
    const node = messagesById.get(id);
    const first = node && node.querySelector(':scope > .msg-response button, .body button[data-action]');
    if (first) first.focus();
  }
  /** Change: a question answered shows its answers again, the first focused. */
  function change(id) {
    factsChanged({ changing: id });
    const m = findMessage(id);
    const node = messagesById.get(id);
    if (!m || !node) return;
    rerenderMessage(node, m);
    const first = node.querySelector('.action-btn');
    if (first) first.focus();
  }

  /** Nobody backstage in the room's people for 10 s: one muted line over the composer, until one joins. */
  function drawAlone(list) {
    const line = $('bvAlone');
    const anyone = (Array.isArray(list) ? list : []).some((u) => u.role === 'research');
    if (!isSimple() || anyone || outOf) {
      clearTimeout(aloneTimer);
      aloneTimer = null;
      line.hidden = true;
      return;
    }
    if (line.hidden && !aloneTimer) aloneTimer = setTimeout(() => { aloneTimer = null; if (isSimple()) { AGM.toned(line, AGM.mark('off') + ' Nobody backstage is online. Use Help if you need someone.'); line.hidden = false; } }, ALONE_MS);
  }

  /** The feed's own words while it holds nothing to read yet. */
  function drawEmpty() {
    $('bvEmpty').hidden = !isSimple() || allMessages.some((m) => m.type !== 'system') || echoes.size > 0;
  }

  // ---- the 🔥 strip: the newest 🔥 message from backstage that waits, only while it is out of view
  function drawStrip() {
    const strip = $('bvStrip');
    const hot = isSimple() ? F.waiting.priority.map(findMessage).filter((m) => m && m.from && m.from.role === 'research') : [];
    const m = hot.length ? hot[hot.length - 1] : null;
    const id = m ? m.id : '';
    if (id !== hotId) {
      hotId = id;
      hotSeen = null;
      if (seer && watched) seer.unobserve(watched);
      watched = id ? messagesById.get(id) || null : null;
      if (seer && watched) seer.observe(watched);
    }
    // Without the observer the strip always shows: the safe failure. Behind the Shown to you tab it is out of view.
    const inView = !!seer && hotSeen !== false && body.dataset.tab !== 'shown';
    strip.hidden = !m || inView;
    if (strip.hidden) { stripSaid = ''; return; }
    const from = (m.from.name || 'Backstage') + ':';
    const text = m.type === 'file' ? (m.confidential ? '🔒 ' : '') + (m.filename || 'a file') : String(m.text || '');
    const others = hot.length - 1;
    // Got it as the catalogue draws it now (its label, and why it cannot act while the page is not connected).
    const ack = AGM.catalog.inline('msg', F, m).filter((i) => i.id === 'msg.ack').map((i) => [i.label, i.disabled, i.held]);
    const said = JSON.stringify([m.id, from, text, others, ack]);
    if (said === stripSaid) return;
    stripSaid = said;
    $('bvStripFrom').textContent = from;
    $('bvStripText').textContent = text;
    const acts = $('bvStripActs');
    acts.dataset.id = m.id;
    // Drawn whole each time it changes: Reply is the feed's, so the strip keeps Got it alone.
    drawnActs.delete(acts);
    drawBar(acts, 'msg', m, { words: true });
    for (const b of acts.querySelectorAll('[data-action]:not([data-action="msg.ack"])')) b.remove();
    const more = $('bvStripMore');
    more.hidden = others < 1;
    more.textContent = '+' + others + ' more';
  }
  $('bvStrip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="msg.ack"]');
    const m = b && findMessage($('bvStripActs').dataset.id);
    if (m) act('msg', 'msg.ack', m, { anchor: b, opener: b });
  });

  // ---- what is shown to this person: a column at 900 px wide or more, a tab below, drawn only while it holds something
  /** How many things are shown to this person now: the takes in the side bar's cards, its Earlier, a file open there. */
  const shownCount = () => Takes.carded() + Takes.earlier() + (previewing ? 1 : 0);
  function layout() {
    const n = isSimple() ? shownCount() : 0;
    body.dataset.shown = String(n);
    const tabs = $('bvTabs');
    tabs.hidden = !isSimple() || n === 0;
    $('shownCount').textContent = String(n);
    if (n === 0 && body.dataset.tab === 'shown') pickTab('chat');
    if (!body.dataset.tab) body.dataset.tab = 'chat';
    // What is shown is On stage content: in the simple view it is never dragged out or saved by a long press. The full
    // view's pictures drag as they always have (the take layer's own never do: pagelayer.mjs), so only what this marked
    // is let go again.
    const simple = isSimple() || F.role === 'board';
    for (const img of document.querySelectorAll('#takeCards img, #docDisplay img, #pageLayer img')) {
      if (simple && img.getAttribute('draggable') !== 'false') { img.setAttribute('draggable', 'false'); img.dataset.bvDrag = '1'; }
      else if (!simple && img.dataset.bvDrag) { img.removeAttribute('draggable'); delete img.dataset.bvDrag; }
    }
    drawStrip();
  }
  function pickTab(which) {
    body.dataset.tab = which === 'shown' ? 'shown' : 'chat';
    $('tabChat').setAttribute('aria-pressed', String(body.dataset.tab === 'chat'));
    $('tabShown').setAttribute('aria-pressed', String(body.dataset.tab === 'shown'));
    if (body.dataset.tab === 'shown') rerenderCurrentDoc();
    drawStrip();
    Takes.seen();
  }
  $('tabChat').addEventListener('click', () => pickTab('chat'));
  $('tabShown').addEventListener('click', () => pickTab('shown'));
  const shownWatch = new MutationObserver(() => layout());
  shownWatch.observe($('takeCards'), { childList: true, attributes: true, attributeFilter: ['hidden'] });
  shownWatch.observe($('takeEarlier'), { childList: true, attributes: true, attributeFilter: ['hidden'] });
  shownWatch.observe($('docDisplay'), { childList: true });
  // On stage content keeps no copy: in the simple view, and on an On stage seat in either view, a long press or a
  // right-click on it opens no menu of the browser's (its door answers as a menu that is open, and opens none: the cards'
  // own menus are theirs), and nothing is dragged out.
  const stageSeat = () => isSimple() || F.role === 'board';
  for (const id of ['takeCards', 'takeEarlier', 'docDisplay', 'pageLayer']) {
    const el = $(id);
    AGM.menu.door(el, () => (stageSeat() ? { el, more: null, open: () => true } : null), { stage: true });
    el.addEventListener('dragstart', (e) => { if (stageSeat()) e.preventDefault(); });
  }

  // ---- the composer's placeholder: its long words where they fit the field, measured in the field's own font
  const LONG = 'Message everyone here…';
  const SHORT = 'Message everyone…';
  let ruler = null;
  function fitPlaceholder() {
    const field = $('directorInput');
    if (!field) return;
    // The full view keeps its words; the simple view measures them against its field.
    if (!isSimple()) { if (field.placeholder !== LONG) field.placeholder = LONG; return; }
    if (!field.clientWidth) return;
    const cs = getComputedStyle(field);
    const room = field.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!ruler) ruler = document.createElement('canvas').getContext('2d');
    if (!ruler) return;
    ruler.font = [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ');
    const words = ruler.measureText(LONG).width <= room ? LONG : SHORT;
    if (field.placeholder !== words) field.placeholder = words;
  }
  let fitting = false;
  window.addEventListener('resize', () => {
    if (fitting) return;
    fitting = true;
    requestAnimationFrame(() => { fitting = false; fitPlaceholder(); layout(); });
  });
  // An iPad keeps the layout behind its on-screen keyboard (it reads no interactive-widget): the view follows the visual
  // viewport's height, so the replying line and Send stay above the keyboard.
  // A pinch-zoom resizes the visual viewport too, and the page is not made smaller for it: the rule holds only while the
  // view is at its own scale, and lets go of the height otherwise.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!isSimple()) return;
      const vv = window.visualViewport;
      if (Math.abs((vv.scale || 1) - 1) > 0.01) { delete body.dataset.vv; return; }
      root.style.setProperty('--vv-h', Math.round(vv.height) + 'px');
      body.dataset.vv = '1';
    });
  }

  // ---- the ⋯ sheet: what is set once a session
  const sheetEl = $('bvSheet');
  const rowsEl = $('bvSheetRows');
  const sheetOpen = () => !sheetEl.hidden;
  const fullNow = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  /**
   * The sheet as the catalogue reads it: the text size, the clock or countdown drawn and whether the admin holds it (and
   * whether the hall has a Stagewatch for a countdown), the theme, the screen full or not, the hall as Leave names it.
   */
  const sheetObject = () => ({ id: 'sheet', zoom: currentZoom, clock: { show: Clock.shown(), locked: Clock.locked() }, stage: F.stagewatch, dark: root.dataset.theme === 'dark', full: !!fullNow(), hall: HALL_NAME || ROOM_NAME || 'this hall' });
  function button(id, label, value, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bv-sheet-btn';
    b.dataset.action = id;
    if (value !== undefined) b.dataset.value = String(value);
    b.textContent = label;
    if (extra) extra(b);
    return b;
  }
  function row(label, ...parts) {
    const r = document.createElement('div');
    r.className = 'bv-sheet-row';
    const l = document.createElement('span');
    l.className = 'bv-sheet-label';
    l.textContent = label;
    r.append(l, ...parts);
    return r;
  }
  /** The clock or countdown's choices in the sheet's words. */
  const CLOCK_SAID = Object.fromEntries(AGM.catalog.CLOCKS);
  function drawSheet() {
    const o = sheetObject();
    const shown = AGM.catalog.shown('sheet', F, o);
    // Drawn again in place (R5): the rows keep their ids and order, and the focus stays on the control it was on, else in
    // the sheet, where the control it was on is no longer drawn (a choice the admin has just locked).
    const was = sheetEl.contains(document.activeElement) ? document.activeElement : null;
    const wasAt = was && was.dataset ? [was.dataset.action, was.dataset.value] : null;
    rowsEl.textContent = '';
    for (const e of shown) {
      if (e.id === 'sheet.size') {
        const vals = AGM.catalog.submenu('sheet', e.id, F, o) || [];
        const pct = document.createElement('span');
        pct.className = 'bv-sheet-pct';
        pct.textContent = Math.round(currentZoom * 100) + '%';
        const [down, up] = vals.map((v) => button(e.id, v.label, v.value, (b) => { b.setAttribute('aria-label', v.value < 0 ? 'Smaller text' : 'Larger text'); if (v.disabled) { b.setAttribute('aria-disabled', 'true'); b.title = v.disabled; } }));
        rowsEl.appendChild(row(e.label, down, pct, up));
      } else if (e.id === 'sheet.theme') {
        const vals = AGM.catalog.submenu('sheet', e.id, F, o) || [];
        rowsEl.appendChild(row(e.label, ...vals.map((v) => button(e.id, v.label, v.value, (b) => b.setAttribute('aria-pressed', String(!!v.checked))))));
      } else if (e.id === 'sheet.clock' && o.clock.locked) {
        // Locked by the admin: their choice as words, and no control, so nothing looks choosable that is not.
        const r = document.createElement('div');
        r.className = 'bv-sheet-row bv-sheet-col';
        const said = document.createElement('p');
        said.className = 'bv-sheet-locked';
        const l = document.createElement('span');
        l.className = 'bv-sheet-label';
        l.textContent = e.label + ':';
        said.append(l, ' ' + (CLOCK_SAID[o.clock.show] || ''));
        const why = document.createElement('p');
        why.className = 'bv-sheet-why';
        why.textContent = AGM.catalog.WORDS.clockLocked;
        r.append(said, why);
        r.dataset.action = e.id;
        rowsEl.appendChild(r);
      } else if (e.id === 'sheet.clock') {
        const vals = AGM.catalog.submenu('sheet', e.id, F, o) || [];
        const r = row(e.label, ...vals.map((v) => button(e.id, v.label, v.value, (b) => b.setAttribute('aria-pressed', String(!!v.checked)))));
        r.classList.add('bv-sheet-wrap');
        r.dataset.action = e.id;
        // The countdown may still be chosen with no Stagewatch: it says so, and draws --:-- with why.
        if (!o.stage) { const n = document.createElement('p'); n.className = 'bv-sheet-note'; n.textContent = AGM.catalog.WORDS.noClockStage; r.appendChild(n); }
        rowsEl.appendChild(r);
      } else {
        const label = typeof e.label === 'function' ? e.label(F, o) : e.label;
        const r = document.createElement('div');
        r.className = 'bv-sheet-row';
        r.appendChild(button(e.id, label, undefined, (b) => { b.classList.add('bv-sheet-wide'); }));
        rowsEl.appendChild(r);
      }
    }
    // Why the screen may sleep: a row of its own, before Leave, only while the screen cannot be kept awake.
    if (awake && awake.held === false && awake.words) {
      const p = document.createElement('p');
      p.className = 'bv-sheet-awake';
      p.setAttribute('role', 'status');
      p.textContent = awake.words;
      const leave = rowsEl.querySelector('[data-action="sheet.leave"]');
      rowsEl.insertBefore(p, leave ? leave.parentNode : null);
    }
    // The support view acts on nothing: every row says whose view it is (R8).
    for (const b of rowsEl.querySelectorAll('button[data-action]')) {
      const why = AGM.catalog.ready('sheet', b.dataset.action, F, o);
      if (why !== true) { b.setAttribute('aria-disabled', 'true'); b.title = why; }
    }
    $('bvSheetFoot').textContent = [NAME, roleLabel(F.role)].filter(Boolean).join(' · ');
    if (was && !sheetEl.contains(document.activeElement)) {
      const same = wasAt && [...rowsEl.querySelectorAll('button[data-action]')].find((b) => b.dataset.action === wasAt[0] && b.dataset.value === wasAt[1]);
      const first = same || rowsEl.querySelector('button');
      if (first) first.focus();
    }
  }
  function openSheet() {
    if (!isSimple() || outOf) return;
    drawSheet();
    sheetEl.hidden = false;
    headerMore.setAttribute('aria-expanded', 'true');
    const first = rowsEl.querySelector('button');
    if (first) first.focus();
  }
  function closeSheet(refocus) {
    if (sheetEl.hidden) return;
    sheetEl.hidden = true;
    AGM.ask.close();
    headerMore.setAttribute('aria-expanded', 'false');
    if (refocus) headerMore.focus();
  }
  function sheet() { if (sheetOpen()) closeSheet(true); else openSheet(); }
  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    e.preventDefault();
    const value = b.dataset.value === undefined ? undefined : b.dataset.action === 'sheet.size' ? Number(b.dataset.value) : b.dataset.value;
    if (b.getAttribute('aria-disabled') === 'true') { AGM.toast(b.title, true); return; }
    act('sheet', b.dataset.action, sheetObject(), { anchor: b, opener: b, value });
  });
  // A tap outside the sheet (not on its ⋯) closes it, as Escape does.
  document.addEventListener('pointerdown', (e) => {
    if (!sheetOpen() || sheetEl.contains(e.target) || headerMore.contains(e.target) || (e.target.closest && e.target.closest('.agm-ask'))) return;
    closeSheet(false);
  }, true);
  Object.assign(RUN, {
    'sheet.size': (o, { value }) => { if (typeof value === 'number' && Number.isFinite(value)) setZoom(currentZoom + value); drawSheet(); fitPlaceholder(); },
    // This device's own clock or countdown: drawn at once, kept here alone (Clock).
    'sheet.clock': (o, { value }) => { Clock.choose(value); drawSheet(); },
    'sheet.theme': (o, { value }) => {
      if (value !== 'light' && value !== 'dark') return;
      try { localStorage.setItem('agm.theme', value); } catch { /* storage blocked: this page only */ }
      applyTheme(value);
      pushUserState('theme', value);
      drawSheet();
    },
    'sheet.fullscreen': () => {
      if (fullNow()) { const leave = document.exitFullscreen || document.webkitExitFullscreen; if (leave) Promise.resolve(leave.call(document)).catch(() => {}); return; }
      const el = document.documentElement;
      const ask = el.requestFullscreen || el.webkitRequestFullscreen;
      if (ask) Promise.resolve(ask.call(el)).catch(() => AGM.toast('This device did not go full screen.', true));
    },
    'sheet.leave': () => { closeSheet(false); keepDraft(); location.href = HOME; },
  });
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { if (sheetOpen()) drawSheet(); });

  // ---- the Escape order: an open menu, an open ask, the take layer (minimised), Answer in words (its ask), the reply,
  // then the focus returns to the composer. Each before it hears Escape first and stops it there.
  document.addEventListener('keydown', (e) => {
    if (!isSimple() || e.key !== 'Escape' || e.defaultPrevented) return;
    if (AGM.menu.isOpen() || AGM.ask.isOpen() || document.querySelector('dialog[open]')) return;
    if (sheetOpen()) { e.preventDefault(); closeSheet(true); return; }
    if (F.tapped) factsChanged({ tapped: '' });
    if (replyState) { e.preventDefault(); cancelReply(); }
    const field = composerField();
    if (field && document.activeElement !== field) { e.preventDefault(); field.focus(); }
  });

  return { setView, waits, said, tap, change, people: drawAlone, sheet, layout, isSimple, awakeState: () => awake,
    // What the sheet draws changed from elsewhere (the admin's clock or countdown): its rows drawn again in place, if open.
    sheetChanged: () => { if (sheetOpen()) drawSheet(); },
    // The sheet as an ask from it reads it: its object while it is open, null once it is closed (its ask goes with it).
    sheetNow: () => (sheetOpen() ? sheetObject() : null) };
})();
socket.on('view', (v) => { if (v && typeof v.view === 'string') Simple.setView(v.view); });
// ---------------- Got it clears (plan 7-§17.6, owner answer B4) ----------------
// While the admin has turned on Got it clears the message for this person, their page seated On stage draws each message
// they got (a text or a file of someone else's that carries their 👍, by Got it or, in the full view, React ▸ 👍; never one
// pinned for the room or for them, a question or their own: AGM.catalog.gotCleared) as one muted line in its place, a run
// of them as one: "👍 Got and cleared: Ana Ribeiro 14:02 · Show", 🔥 before the name for a priority message, "👍 Got and
// cleared: 3 messages · Show". Show draws them again, marked got, until the page reloads; Hide folds them back. It reads
// facts the page has (the person's 👍, the switch), so an account's devices clear together; the room's record, the
// backstage team's pages, the transcript and the minutes keep every message.
const Cleared = (function () {
  const open = new Set();      // the messages the person chose to see again (Show), until the page reloads
  const lines = new Map();     // a run's first message's id → its line
  let runs = new Map();        // a run's first message's id → its messages, in the feed's order
  /** The runs of cleared messages now, in the feed's order: a message that stays breaks a run, a system line does not. */
  function runsNow() {
    const out = new Map();
    let cur = null;
    for (const node of feed.querySelectorAll('.msg[data-id]:not(.pinned-copy)')) {
      const m = findMessage(node.dataset.id);
      if (m && AGM.catalog.gotCleared(F, m)) {
        if (!cur) { cur = []; out.set(m.id, cur); }
        cur.push(m);
      } else cur = null;
    }
    return out;
  }
  /** A run's line as the catalogue reads it: its id, whether it is shown, how many it holds. */
  function object(run) {
    const list = runs.get(run);
    return list ? { id: 'cleared:' + run, run, open: list.some((m) => open.has(m.id)), count: list.length } : null;
  }
  const wordsOf = (list) => '👍 Got and cleared: ' + (list.length === 1
    ? (list[0].priority ? '🔥 ' : '') + ((list[0].from && list[0].from.name) || 'Backstage') + ' ' + formatTime(list[0].at)
    : list.length + ' messages');
  function draw() {
    // Nothing to fold, and nothing folded: a page whose switch is off reads no message.
    if (!(F.role === 'board' && F.onStage.clears) && !lines.size) return;
    runs = runsNow();
    const kept = new Set();
    for (const [run, list] of runs) {
      const shown = list.some((m) => open.has(m.id));
      // A run that grows while it is shown is shown whole.
      if (shown) for (const m of list) open.add(m.id);
      for (const m of list) { const n = messagesById.get(m.id); if (n) n.dataset.cleared = shown ? 'open' : '1'; }
      let line = lines.get(run);
      if (!line) {
        line = document.createElement('div');
        line.className = 'bv-cleared';
        line.dataset.run = run;
        const words = document.createElement('span');
        words.className = 'bv-cleared-words';
        const acts = document.createElement('span');
        acts.className = 'bv-cleared-acts';
        line.append(words, document.createTextNode(' · '), acts);
        lines.set(run, line);
      }
      const first = messagesById.get(run);
      if (first && line.nextElementSibling !== first) first.before(line);
      const said = wordsOf(list);
      const w = line.querySelector('.bv-cleared-words');
      if (w.textContent !== said) w.textContent = said;
      drawBar(line.querySelector('.bv-cleared-acts'), 'cleared', object(run), { words: true });
      kept.add(run);
    }
    for (const [run, line] of lines) if (!kept.has(run)) { line.remove(); lines.delete(run); }
    const inRuns = new Set([...runs.values()].flat().map((m) => m.id));
    for (const n of feed.querySelectorAll('.msg[data-cleared]')) if (!inRuns.has(n.dataset.id)) delete n.dataset.cleared;
  }
  /** Show or Hide a run: its messages drawn again, or folded back into its line, the focus kept on the line's button. */
  function toggle(run) {
    const list = runs.get(run);
    if (!list) return;
    const shown = list.some((m) => open.has(m.id));
    for (const m of list) { if (shown) open.delete(m.id); else open.add(m.id); }
    draw();
    const b = lines.get(run) && lines.get(run).querySelector('[data-action="cleared.show"]');
    if (b) b.focus();
  }
  feed.addEventListener('click', (e) => {
    const b = e.target.closest('.bv-cleared [data-action="cleared.show"]');
    const line = b && b.closest('.bv-cleared');
    const o = line && object(line.dataset.run);
    if (o) act('cleared', 'cleared.show', o, { opener: b, anchor: b });
  });
  return { draw, object, toggle };
})();
drawCleared.ready = true;
RUN['cleared.show'] = (o) => Cleared.toggle(o.run);

// The admin's clock or countdown for this person changed: drawn at once, the sheet's row in place; their device's own
// choice still wins unless the admin locked theirs (AGM.clockFor).
socket.on('clock', (c) => { Clock.admin(c); Simple.sheetChanged(); });
// What the admin lets this person do On stage, told live (plan 7-§17.6): Also on's chips and Got it clears follow it.
socket.on('onStage', (o) => { if (o && typeof o === 'object') factsChanged({ onStage: o }); });
