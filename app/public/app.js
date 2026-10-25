// AGMessage client.

const qs = new URLSearchParams(location.search);
const ROOM = (qs.get('code') || '').toUpperCase();
// A signed-in account opens a hall with ?code=…&as=account (its name and rights come from the server); anyone else
// with ?code=…&name=…&role=… from the join page.
const AS_ACCOUNT = qs.get('as') === 'account';
let NAME = AS_ACCOUNT ? '' : (qs.get('name') || '');
const ROLE = qs.get('role') || 'observer';
const HOME = AS_ACCOUNT ? '/halls.html' : '/';
const ADMIN_VIEW = qs.get('adminView') === '1';
// Identity: issued and signed by the server on first join, kept on this device, so nobody can
// pick someone else's. MY_UID is the id inside it (what messages and reactions carry).
let IDENTITY = localStorage.getItem('agm.id') || '';
let MY_UID = '';
const INVITE = qs.get('invite') || '';
let UPLOAD_TOKEN = '';
let lastSeq = -1;            // the newest change we have; resume from here after a drop
let joined = false;
let CAN_STAGE = false;
let CAN_PROPOSE = false;   // Stagewatch keeps the show's approval queue (Show Bus 1.2 §11)
let AI_ON = false;
let CAN_SCREENS = false;   // this account may drive the hall's screens (display.control)
const HAS_STAGE = ROLE === 'board' || ROLE === 'research';
// Read only (an observer, a Viewer account): the server refuses posts, pins, reactions and answers, so none is offered.
const readOnly = () => document.body.dataset.role === 'observer';

// ---------------- UI sync state (declared early to avoid TDZ traps) ----------------
// These are accessed by pushUserState / setStageCollapsed / setZoom / applyTheme,
// some of which run during boot (e.g. setStageCollapsed(true) when the user had
// the stage collapsed last session). Declaring them at the top guarantees they
// are out of TDZ before any boot-time call hits them. See CLAUDE.md gotcha #8.
const _pendingStates = [];
let _applyingRemote = false;

if (!ROOM || (!NAME && !AS_ACCOUNT)) location.href = '/';

document.body.dataset.role = ROLE;
const _roomChip = document.getElementById('roomChip');
_roomChip.textContent = ROOM;
if (ROLE === 'observer') _roomChip.hidden = true;
document.getElementById('whoami').textContent = AS_ACCOUNT ? '' : `${NAME} · ${roleLabel(ROLE)}`;
document.querySelectorAll('a[href="/"].btn').forEach((a) => { a.href = HOME; if (AS_ACCOUNT) a.textContent = 'All halls'; });
document.title = `AGMessage · ${ROOM}`;

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
const socket = io({ transports: ['websocket', 'polling'] });
const connDot = document.getElementById('connDot');

socket.on('connect', () => {
  connDot.classList.add('ok');
  rejoin();
});

/** Join (or rejoin after a drop): the server sends only what we missed when it still has it. */
function rejoin() {
  const who = AS_ACCOUNT ? { as: 'account' } : { name: NAME, role: ROLE, uid: IDENTITY, invite: INVITE };
  socket.emit('join', { roomCode: ROOM, adminView: ADMIN_VIEW, since: joined ? lastSeq : undefined, ...who }, (res) => {
    if (!res || !res.ok) {
      notify(res?.error || 'Could not join room', true);
      const to = res && res.signIn ? '/?next=' + encodeURIComponent(location.pathname + location.search) : HOME;
      setTimeout(() => { location.href = to; }, 2500);
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
    if (res.account) {
      NAME = res.account.name;
      document.getElementById('whoami').textContent = `${res.account.name} · ${res.account.roleLabel}`;
    }
    if (res.identity) { IDENTITY = res.identity; try { localStorage.setItem('agm.id', IDENTITY); } catch { /* private mode: identity lives for this tab only */ } }
    MY_UID = res.uid || MY_UID;
    UPLOAD_TOKEN = res.uploadToken || '';
    CAN_STAGE = !!res.canSendToStage;
    CAN_PROPOSE = !!res.canPropose;
    AI_ON = !!res.ai;
    document.querySelectorAll('.ai-btn').forEach((b) => { b.hidden = !AI_ON; });
    // Without AI, nothing else changes: say so where the draft button would be (research team only sees it).
    document.querySelectorAll('.ai-off-note').forEach((n) => { n.hidden = AI_ON; });
    if (res.note) notify(res.note);
    if (res.role && res.role !== ROLE) { document.body.dataset.role = res.role; }
    if (readOnly()) { document.getElementById('directorCompose').hidden = true; document.getElementById('researchCompose').hidden = true; }
    renderStage(res.stage);
    document.getElementById('helpBtn').hidden = (res.role || ROLE) === 'observer';
    if (AS_ACCOUNT || ADMIN_VIEW) Screens.load();
    (res.seen || []).forEach(noteSeen);
    if (res.roomName) setRoomTitle(res.roomName);
    if (Array.isArray(res.ops)) {
      for (const op of res.ops) applyOp(op);       // just the gap
    } else {
      renderHistory(res.history || []);
    }
    lastSeq = Math.max(lastSeq, res.seq || 0);
    joined = true;
    renderUsers(res.users || []);
    refreshSeenLines();
    reportSeen();
  });
}

/** The hall's name in the header (a rename arrives as a numbered change, like everything else). */
function setRoomTitle(name) {
  if (!name) return;
  const chip = document.getElementById('roomChip');
  if (chip) chip.title = 'Meeting: ' + name + ' (' + ROOM + ')';
  const titleStrong = document.querySelector('.app-title strong');
  if (titleStrong) titleStrong.textContent = name;
}

// Every change carries the room's sequence number. A jump means we missed one: resume from what we have.
function bump(seq) {
  if (!Number.isInteger(seq)) return true;
  if (lastSeq >= 0 && seq > lastSeq + 1 && joined) { rejoin(); return false; }
  if (seq > lastSeq) lastSeq = seq;
  return true;
}
function applyOp(op) {
  if (!op) return;
  if (op.o === 'add') { op.m.seq = op.s; addMessage(op.m, { silent: true }); }
  else if (op.o === 'upd') {
    if ('responses' in op.f) updateActionResponses(op.id, op.f.responses);
    if ('pinned' in op.f) setMessagePinned(op.id, op.f.pinned);
    if ('reactions' in op.f) onReact({ messageId: op.id, reactions: op.f.reactions });
    if ('stage' in op.f) setStage(op.id, op.f.stage);
    if ('proposal' in op.f) { const m = findMessage(op.id); if (m) m.proposal = op.f.proposal; const n = messagesById.get(op.id); if (n && m) (m.type === 'system' ? renderProposalLine(n, op.f.proposal) : rerenderMessage(n, m)); }
    if ('help' in op.f) setHelp(op.id, op.f.help);
  }
  else if (op.o === 'del') removeMessageLocal(op.id);
  else if (op.o === 'reset') onReset();
  else if (op.o === 'meta' && typeof op.name === 'string') setRoomTitle(op.name);
  if (op.s > lastSeq) lastSeq = op.s;
}

socket.on('disconnect', () => connDot.classList.remove('ok'));
socket.on('message', (msg) => { if (!bump(msg.seq)) return; addMessage(msg); scrollToBottom(); reportSeen(); });
socket.on('system', (msg) => { if (!bump(msg.seq)) return; addMessage(msg); });
socket.on('users', renderUsers);
socket.on('actionUpdate', ({ messageId, responses, seq }) => {
  if (!bump(seq)) return;
  updateActionResponses(messageId, responses);
});
socket.on('pinUpdate', ({ messageId, pinned, seq }) => {
  if (!bump(seq)) return;
  setMessagePinned(messageId, pinned);
});
socket.on('kicked', ({ reason }) => { notify(reason || 'You were removed from the meeting.', true); setTimeout(() => { location.href = HOME; }, 2500); });
// An admin changed this account: the server closes the socket; open the hall again with the rights it has now.
socket.on('account:changed', ({ words } = {}) => { notify(words || 'Your account was changed — reloading.'); setTimeout(() => location.reload(), 1500); });
socket.on('roleChanged', ({ role }) => { notify('The admin changed your role to ' + roleLabel(role) + ' — reloading…'); setTimeout(() => { const q = new URLSearchParams(location.search); q.set('role', role); location.search = q.toString(); }, 1500); });
socket.on('stage', (v) => {
  const desk = !!(v && v.desk);
  if (desk !== CAN_PROPOSE) { CAN_PROPOSE = desk; refreshProposeButtons(); }
  renderStage(v);
});
function refreshProposeButtons() {
  for (const [id, node] of messagesById) { const m = findMessage(id); if (m && m.type !== 'system') rerenderMessage(node, m); }
}
// A proposal's state (pending → approved / rejected → done / failed), on the message it came from.
socket.on('proposalUpdate', ({ messageId, proposal, seq }) => {
  if (!bump(seq)) return;
  const msg = findMessage(messageId);
  if (msg) msg.proposal = proposal;
  const node = messagesById.get(messageId);
  if (!node) return;
  if (msg && msg.type !== 'system') rerenderMessage(node, msg);
  else renderProposalLine(node, proposal);
});
function proposalLineText(p) {
  if (!p) return '';
  const by = p.by ? ' by ' + p.by : '';
  switch (p.state) {
    case 'pending': return '📝 Waiting for the show desk to approve' + (p.to ? ' — for ' + p.to : '');
    case 'approved': return '✓ Approved' + by + ' — running';
    case 'rejected': return '✗ Not approved' + by;
    case 'done': return '✓ Approved' + by + ' and done' + (p.words ? ': ' + p.words : '');
    case 'failed': return '⚠ Approved' + by + ' but it failed' + (p.words ? ': ' + p.words : '');
    case 'undelivered': return '⚠ Approved' + by + ' but it never reached Stagewatch';
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
socket.on('seen', (s) => { noteSeen(s); refreshSeenLines(); });
socket.on('roomReset', ({ seq } = {}) => { if (bump(seq)) onReset(); });
socket.on('roomMeta', ({ name, seq } = {}) => { if (bump(seq)) setRoomTitle(name); });
function onReset() {
  // Admin cleared the room. Wipe local state but stay joined.
  feed.innerHTML = '';
  messagesById.clear();
  allMessages.length = 0;
  refreshPinned();
  refreshDocPinnedList();
  if (typeof dismissDoc === 'function') dismissDoc();
}
socket.on('messageReact', ({ messageId, reactions, seq }) => { if (bump(seq)) onReact({ messageId, reactions }); });
// A message sent to the speaker's screen: Stagewatch's receipt, then the speaker's acknowledgement, on that message.
socket.on('stageAck', ({ messageId, stage, seq }) => { if (bump(seq)) setStage(messageId, stage); });
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
function onReact({ messageId, reactions }) {
  const msg = findMessage(messageId);
  if (msg) msg.reactions = reactions;
  const node = messagesById.get(messageId);
  if (node) renderReactions(node, reactions);
  // Refresh pinned strip if this message is pinned
  if (msg && msg.pinned) refreshPinned();
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

// ---------------- Stage (Stagewatch): the live timer, for everyone in the meeting ----------------
function renderStage(v) {
  const chip = document.getElementById('stageChip');
  if (!chip) return;
  if (!v || !v.text) { chip.hidden = true; return; }
  chip.hidden = false;
  document.getElementById('stageTime').textContent = v.text;
  document.getElementById('stageTime').style.color = v.color || '';
  document.getElementById('stageTitle').textContent = v.title || '';
  chip.classList.toggle('stale', !!v.stale || (v.status && v.status !== 'connected'));
  chip.title = (v.stale ? 'Stagewatch link lost — last known: ' : 'Live from Stagewatch: ') + (v.title || '') + (v.next ? ' · Next: ' + v.next : '') +
    (v.messageAck === 'done' ? ' · Speaker acknowledged the message' : '');
}

// ---------------- Toasts (never a blocking dialog) ----------------
function notify(text, bad) {
  let box = document.getElementById('agmToast');
  if (!box) { box = document.createElement('div'); box.id = 'agmToast'; box.className = 'agm-toast'; document.body.appendChild(box); }
  box.textContent = text;
  box.classList.toggle('bad', !!bad);
  box.classList.add('show');
  clearTimeout(notify._t);
  notify._t = setTimeout(() => box.classList.remove('show'), 4000);
}

// ---------------- Feed rendering ----------------
const feed = document.getElementById('feed');
const tpl = document.getElementById('msgTpl');
const messagesById = new Map();
const allMessages = [];
function findMessage(id) { return allMessages.find((m) => m.id === id); }
function isMine(msg) { return !!(msg.from && (MY_UID ? msg.from.uid === MY_UID : msg.from.name === NAME)); }

function renderHistory(history) {
  feed.innerHTML = '';
  messagesById.clear();
  allMessages.length = 0;
  for (const m of history) addMessage(m, { silent: true });
  refreshPinned();
  refreshDocPinnedList();
  scrollToBottom();
}

function addMessage(msg, { silent = false } = {}) {
  if (!msg || messagesById.has(msg.id)) {
    if (msg && messagesById.has(msg.id)) {
      const el = messagesById.get(msg.id);
      rerenderMessage(el, msg);
      const idx = allMessages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) allMessages[idx] = msg;
    }
    return;
  }
  // Comings and goings fold into one quiet line instead of burying the conversation.
  const prev = feed.lastElementChild;
  if (msg.type === 'system' && PRESENCE.test(msg.text || '') && prev && prev.classList.contains('presence')) {
    const parts = (prev.dataset.parts ? prev.dataset.parts.split('\u0001') : [prev.textContent]).concat(msg.text).slice(-6);
    prev.dataset.parts = parts.join('\u0001');
    prev.textContent = parts.join(' · ');
    messagesById.set(msg.id, prev);
    allMessages.push(msg);
    return;
  }
  const el = renderMessage(msg);
  feed.appendChild(el);
  messagesById.set(msg.id, el);
  allMessages.push(msg);
  if (!silent && msg.type !== 'system') flash(el);
  if (msg.pinned) refreshPinned();
  if (!silent && msg.type === 'file' && HAS_STAGE) openDocInPanel(msg, { fromPush: true });
  if (msg.type === 'file') refreshDocPinnedList();
}

function removeMessageLocal(id) {
  const node = messagesById.get(id);
  if (node) node.remove();
  messagesById.delete(id);
  const idx = allMessages.findIndex((m) => m.id === id);
  if (idx >= 0) allMessages.splice(idx, 1);
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === id) dismissDoc();
}

const PRESENCE = /^(.+) (joined as \w+|left)$/;
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
  const from = node.querySelector('.from');
  const rt = node.querySelector('.role-tag');
  const time = node.querySelector('time');
  const body = node.querySelector('.body');
  const pinBtn = node.querySelector('.pin-btn');
  const delBtn = node.querySelector('.del-btn');
  const screenBtn = node.querySelector('.screen-btn');
  if (screenBtn) {
    const showable = (msg.type === 'text' && !!msg.text) || (msg.type === 'file' && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(msg.mime || ''));
    screenBtn.hidden = !(CAN_SCREENS && showable);
    screenBtn.onclick = showable ? () => Screens.offer(msg) : null;
  }
  const stageBtn = node.querySelector('.stage-btn');
  if (stageBtn) {
    const canStage = CAN_STAGE && document.body.dataset.role === 'research' && (msg.type === 'text' || msg.type === 'action') && !!msg.text;
    stageBtn.hidden = !canStage;
    stageBtn.onclick = canStage ? () => {
      stageBtn.disabled = true;
      socket.emit('stage:send', { messageId: msg.id }, (res) => {
        stageBtn.disabled = false;
        notify(res && res.ok
          ? (res.stage === 'applied' ? 'On the speaker\'s screen — their acknowledgement shows on the message.' : 'Stagewatch took it — the speaker\'s acknowledgement shows on the message.')
          : (res && res.error) || 'Could not send to the stage.', !(res && res.ok));
      });
    } : null;
  }
  const proposeBtn = node.querySelector('.propose-btn');
  if (proposeBtn) {
    const canPropose = (CAN_PROPOSE || CAN_STAGE) && document.body.dataset.role === 'research' && (msg.type === 'text' || msg.type === 'action') && !!msg.text;
    proposeBtn.hidden = !canPropose;
    proposeBtn.onclick = canPropose ? () => ToStagewatch.open(msg) : null;
  }
  if (msg.from) {
    from.textContent = msg.from.name;
    // Staff sign in; guests join with a code: the mark says which, so a name alone is never taken on trust.
    from.classList.toggle('acct', !!msg.from.acct);
    from.title = msg.from.acct ? 'Signed in with an AGMessage account' : 'Joined with a code';
    rt.textContent = roleLabel(msg.from.role);
    rt.dataset.role = msg.from.role;
  }
  time.textContent = formatTime(msg.at);
  body.innerHTML = '';

  // Reply preview (small quote block at the top of the body)
  if (msg.replyTo) {
    const rt = document.createElement('div');
    rt.className = 'reply-quote';
    rt.innerHTML = '↩ <strong>' + escapeHtml(msg.replyTo.name) + '</strong>: ' +
      '<em>' + escapeHtml((msg.replyTo.snippet || '').slice(0, 120)) + '</em>';
    rt.title = 'Click to scroll to original';
    rt.style.cursor = 'pointer';
    rt.addEventListener('click', () => {
      const target = messagesById.get(msg.replyTo.id);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1500);
      }
    });
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

  // Reactions row + add-reaction button. We render after body so it sits beneath the content.
  let rx = node.querySelector('.reactions');
  if (!rx) {
    rx = document.createElement('div');
    rx.className = 'reactions';
    node.appendChild(rx);
  }
  renderReactions(node, msg.reactions || []);

  // Reply button — sets the composer's replyTo state
  const headerEl = node.querySelector('header');
  let replyBtn = headerEl.querySelector('.reply-btn');
  if (!replyBtn && msg.type !== 'system') {
    replyBtn = document.createElement('button');
    replyBtn.className = 'reply-btn';
    replyBtn.title = 'Reply';
    replyBtn.textContent = '↩';
    headerEl.insertBefore(replyBtn, headerEl.querySelector('.fwd-btn'));
  }
  if (replyBtn) {
    replyBtn.onclick = () => beginReply(msg);
  }

  // React button (➕😊) — opens a small picker
  let rxBtn = headerEl.querySelector('.react-btn');
  if (!rxBtn && msg.type !== 'system') {
    rxBtn = document.createElement('button');
    rxBtn.className = 'react-btn';
    rxBtn.title = 'Add reaction';
    rxBtn.textContent = '😊';
    headerEl.insertBefore(rxBtn, headerEl.querySelector('.fwd-btn') || headerEl.querySelector('.pin-btn'));
  }
  if (rxBtn) {
    rxBtn.onclick = (e) => {
      e.stopPropagation();
      showReactionPicker(rxBtn, msg.id);
    };
  }

  pinBtn.onclick = () => {
    const pinned = !(node.dataset.pinned === '1');
    socket.emit('pin', { messageId: msg.id, pinned });
  };

  // Forward button — opens a small picker of the other halls this person may post in (a help request stays in its hall)
  const fwdBtn = node.querySelector('.fwd-btn');
  if (fwdBtn) {
    fwdBtn.hidden = msg.type === 'help';
    fwdBtn.onclick = (e) => { e.stopPropagation(); offerForward(fwdBtn, msg.id); };
  }

  // Show "Forwarded from XYZ12 by Sarah" tag if applicable
  if (msg.forwardedFrom) {
    const meta = document.createElement('div');
    meta.className = 'fwd-meta';
    const orig = msg.forwardedFrom.originalAuthor && msg.forwardedFrom.originalAuthor !== msg.from?.name
      ? ' · originally by ' + msg.forwardedFrom.originalAuthor
      : '';
    const fromLabel = msg.forwardedFrom.roomName
      ? msg.forwardedFrom.roomName + ' (' + msg.forwardedFrom.roomCode + ')'
      : msg.forwardedFrom.roomCode;
    meta.textContent = '↗ Forwarded from ' + fromLabel + orig;
    body.prepend(meta);
  }

  // Show delete only on the current user's own messages
  if (delBtn) {
    if (isMine(msg)) {
      delBtn.hidden = false;
      delBtn.onclick = () => {
        if (confirm('Delete this message? This cannot be undone.')) {
          socket.emit('delete', { messageId: msg.id }, (res) => {
            if (res && !res.ok) alert(res.error || 'Could not delete');
          });
        }
      };
    } else {
      delBtn.hidden = true;
    }
  }
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
  if (h.state !== 'resolved' && document.body.dataset.role !== 'observer') {
    const row = document.createElement('div');
    row.className = 'help-actions';
    const act = (label, state) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small' + (state === 'coming' ? ' primary' : ''); b.textContent = label;
      b.onclick = () => socket.emit('help:respond', { code: ROOM, messageId: msg.id, state }, (r) => { if (!r || !r.ok) notify((r && r.error) || 'Not sent.', true); });
      row.appendChild(b);
    };
    if (h.state === 'open') act('On my way', 'coming');
    act('Resolved', 'resolved');
    wrap.appendChild(row);
  }
  return wrap;
}
function setHelp(messageId, help) {
  const msg = findMessage(messageId);
  if (msg) msg.help = help;
  const node = messagesById.get(messageId);
  if (node && msg) rerenderMessage(node, msg);
}
socket.on('helpUpdate', ({ messageId, help, seq }) => { if (bump(seq)) setHelp(messageId, help); });

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
  if (HAS_STAGE) {
    wrap.classList.add('clickable');
    wrap.title = 'Show on stage panel';
    wrap.addEventListener('click', (e) => {
      e.preventDefault();
      openDocInPanel(msg);
    });
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
  const btnRow = document.createElement('div');
  btnRow.className = 'action-buttons';
  msg.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn action-btn';
    b.dataset.idx = String(i);
    b.textContent = opt;
    b.disabled = readOnly();
    b.onclick = () => {
      socket.emit('actionResponse', { messageId: msg.id, optionIndex: i });
    };
    btnRow.appendChild(b);
  });
  // Both board and research can free-text reply to an action prompt.
  // Observers are read-only: they see the options and the tally, and answer nothing.
  if (HAS_STAGE && !readOnly()) {
    const other = document.createElement('button');
    other.type = 'button';
    other.className = 'btn ghost small reply-text-btn';
    other.textContent = 'Reply with text';
    other.onclick = () => {
      const note = prompt('Quick reply to research team:');
      if (note && note.trim()) {
        socket.emit('actionResponse', {
          messageId: msg.id,
          optionIndex: -1,
          note: note.trim(),
        });
      }
    };
    btnRow.appendChild(other);
  }
  wrap.appendChild(btnRow);
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
  // Re-clone any pinned copy so the .answered class etc. are mirrored too.
  if (node && node.dataset.pinned === '1') refreshPinned();
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
  const node = messagesById.get(messageId);
  if (node) {
    node.dataset.pinned = pinned ? '1' : '0';
    node.classList.toggle('pinned', !!pinned);
  }
  const data = findMessage(messageId);
  if (data) data.pinned = pinned;
  refreshPinned();
  refreshDocPinnedList();
  if (currentDocMsgId === messageId) syncPinButton();
}

function refreshPinned() {
  const strip = document.getElementById('pinnedStrip');
  const list = document.getElementById('pinnedList');
  list.innerHTML = '';
  let any = false;
  // Pinned messages strip: text + action prompts only. Files live in the
  // "On stage" panel's pinned files list, where the open-handler works.
  for (const m of allMessages) {
    if (!m.pinned) continue;
    if (m.type === 'file' || m.type === 'system') continue;
    const node = messagesById.get(m.id);
    if (!node) continue;
    any = true;
    const clone = node.cloneNode(true);
    clone.classList.add('pinned-copy');
    clone.classList.remove('flash');
    const pb = clone.querySelector('.pin-btn');
    if (pb) pb.onclick = () => socket.emit('pin', { messageId: m.id, pinned: false });
    const db = clone.querySelector('.del-btn');
    if (db) db.remove();
    clone.querySelectorAll('.action-btn').forEach((b) => {
      const idx = parseInt(b.dataset.idx, 10);
      b.onclick = () => socket.emit('actionResponse', { messageId: m.id, optionIndex: idx });
    });
    clone.querySelectorAll('.reply-text-btn').forEach((b) => {
      b.onclick = () => {
        const note = prompt('Quick reply to research team:');
        if (note && note.trim()) {
          socket.emit('actionResponse', {
            messageId: m.id,
            optionIndex: -1,
            note: note.trim(),
          });
        }
      };
    });
    // Forward (↗), React (😊), and Reply (↩) buttons — re-bind
    // since cloneNode(true) drops listeners. CLAUDE.md gotcha #9:
    // any new interactive element added to messages must also be
    // re-wired here.
    const fb = clone.querySelector(".fwd-btn");
    if (fb) {
      fb.hidden = m.type === 'help';
      fb.onclick = (e) => { e.stopPropagation(); offerForward(fb, m.id); };
    }
    const rxb = clone.querySelector(".react-btn");
    if (rxb) {
      rxb.onclick = (e) => {
        e.stopPropagation();
        showReactionPicker(rxb, m.id);
      };
    }
    const rpb = clone.querySelector(".reply-btn");
    if (rpb) {
      rpb.onclick = () => beginReply(m);
    }
    // Re-render the reactions row so existing rx-pill toggle handlers
    // are recreated (cloneNode drops those onclicks too).
    renderReactions(clone, m.reactions || []);
    list.appendChild(clone);
  }
  strip.hidden = !any;
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
const pinDocBtn = document.getElementById('pinDocBtn');
const dismissDocBtn = document.getElementById('dismissDocBtn');
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
  syncPinButton();
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
  docForAi.id = null; docForAi.name = ''; docForAi.text = '';
  docPanel.dataset.state = 'empty';
  docPanel.classList.remove('priority');
  docDisplay.innerHTML =
    `<div class="empty-state"><p>No document on stage.</p>` +
    `<p class="hint">When the research team pushes a file, it appears here automatically.</p></div>`;
  docCaptionEl.hidden = true;
  docCaptionEl.textContent = '';
  docTitleEl.textContent = '';
  docActions.hidden = true;
}

function syncPinButton() {
  if (!currentDocMsgId) return;
  const m = findMessage(currentDocMsgId);
  const pinned = !!(m && m.pinned);
  pinDocBtn.dataset.pinned = pinned ? '1' : '0';
  pinDocBtn.textContent = pinned ? '📌 Unpin' : '📌 Pin';
}

function refreshDocPinnedList() {
  docPinnedList.innerHTML = '';
  let count = 0;
  for (const m of allMessages) {
    if (m.type !== 'file' || !m.pinned) continue;
    count++;
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pinned-item';
    open.title = 'Show on stage panel';
    const ico = (m.mime || '').startsWith('image/') ? '🖼' :
                (m.mime === 'application/pdf' ? '📕' : '📄');
    open.innerHTML =
      `<span class="ico">${escapeHtml(ico)}</span>` +
      `<span class="name">${escapeHtml(m.filename)}</span>`;
    open.onclick = () => openDocInPanel(m);
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'unpin';
    unpin.title = 'Unpin';
    unpin.textContent = '×';
    unpin.onclick = (e) => {
      e.stopPropagation();
      socket.emit('pin', { messageId: m.id, pinned: false });
    };
    li.appendChild(open);
    li.appendChild(unpin);
    docPinnedList.appendChild(li);
  }
  docPinnedCount.textContent = count > 0 ? `(${count})` : '';
  docPinnedSection.hidden = count === 0;
}

pinDocBtn?.addEventListener('click', () => {
  if (!currentDocMsgId) return;
  const isPinned = pinDocBtn.dataset.pinned === '1';
  socket.emit('pin', { messageId: currentDocMsgId, pinned: !isPinned });
});
dismissDocBtn?.addEventListener('click', dismissDoc);

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

function renderUsers(users) {
  const list = document.getElementById('peopleList');
  list.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="role-tag" data-role="${escapeHtml(u.role)}">${escapeHtml(roleLabel(u.role))}</span> ${escapeHtml(u.name)}`;
    list.appendChild(li);
  });
  peopleBtn.textContent = `People · ${users.length}`;
}


// ---------------- Priority toggle (per-composer) ----------------
function wirePriority(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return null;
  btn.addEventListener('click', () => {
    const on = btn.dataset.priority === '1';
    btn.dataset.priority = on ? '0' : '1';
    btn.classList.toggle('on', !on);
    btn.title = btn.dataset.priority === '1'
      ? 'High priority is ON — click to disable'
      : 'Mark as high priority';
  });
  return btn;
}
function consumePriority(btn) {
  if (!btn) return false;
  const v = btn.dataset.priority === '1';
  btn.dataset.priority = '0';
  btn.classList.remove('on');
  btn.title = 'Mark as high priority';
  return v;
}
const dirPriBtn = wirePriority('dirPriorityBtn');
const textPriBtn = wirePriority('textPriorityBtn');
const actionPriBtn = wirePriority('actionPriorityBtn');
const filePriBtn = wirePriority('filePriorityBtn');

// ---------------- Compose: director ----------------
const dForm = document.getElementById('directorForm');
const dInput = document.getElementById('directorInput');
dForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dInput.value.trim();
  if (!text) return;
  socket.emit('message', { type: 'text', text, priority: consumePriority(dirPriBtn), replyTo: consumeReplyTo() }, () => { dInput.value = ''; });
});

// ---------------- Compose: research tabs ----------------
document.querySelectorAll('.compose-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.compose-tabs .tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.add('hidden'));
    tab.classList.add('active');
    const pane = document.querySelector(`.pane[data-pane="${tab.dataset.tab}"]`);
    if (pane) pane.classList.remove('hidden');
  });
});

const textPane = document.getElementById('textPane');
const textInput = document.getElementById('textInput');
textPane?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  socket.emit('message', { type: 'text', text, priority: consumePriority(textPriBtn), replyTo: consumeReplyTo(), aiDraft: aiDrafted }, () => {
    textInput.value = '';
    aiDrafted = false;
    setAiHint('');
    textInput.focus();
  });
});

// ---------------- AI: drafts for the research team (a person always edits and sends) ----------------
let aiDrafted = false;
function setAiHint(text, bad) {
  let h = document.getElementById('aiHint');
  if (!h && textPane) { h = document.createElement('p'); h.id = 'aiHint'; h.className = 'ai-hint'; textPane.appendChild(h); }
  if (!h) return;
  h.textContent = text; h.hidden = !text; h.classList.toggle('bad', !!bad);
}
document.getElementById('aiDraftBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('aiDraftBtn');
  const replying = replyState ? findMessage(replyState.id) : null;
  const lastBoard = [...allMessages].reverse().find((m) => m.from && m.from.role === 'board' && (m.text || m.type === 'action'));
  const q = replying || lastBoard;
  btn.disabled = true; btn.textContent = '✨ Drafting…';
  setAiHint('Claude is drafting from the thread' + (docForAi.text ? ' and “' + docForAi.name + '”' : '') + '…');
  socket.emit('ai:draft', {
    question: q ? q.text || '' : '',
    instruction: textInput.value.trim(),
    docName: docForAi.name, docText: docForAi.text,
  }, (res) => {
    btn.disabled = false; btn.textContent = '✨ Draft answer';
    if (!res || !res.ok) { setAiHint((res && res.error) || 'No draft.', true); return; }
    textInput.value = res.draft || '';
    textInput.dispatchEvent(new Event('input'));
    aiDrafted = true;
    if (q && !replyState) beginReply(q);
    setAiHint('✨ Draft (' + res.confidence + ' confidence) — check it, edit it, then Send.' + (res.gaps && res.gaps.length ? ' Missing: ' + res.gaps.join('; ') : ''));
    textInput.focus();
  });
});
textInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    textPane.requestSubmit();
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
  const btn = document.getElementById('aiOptionsBtn');
  const prompt = actionText.value.trim();
  if (!prompt) { notify('Type the question first.'); return; }
  btn.disabled = true;
  socket.emit('ai:options', { prompt }, (res) => {
    btn.disabled = false;
    if (!res || !res.ok || !res.options || !res.options.length) { notify((res && res.error) || 'No suggestions.', true); return; }
    currentOptions = res.options.slice(0, 6);
    renderOptionChips();
  });
});

actionPane?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = actionText.value.trim();
  if (!text) return;
  socket.emit('message', { type: 'action', text, options: currentOptions, priority: consumePriority(actionPriBtn), replyTo: consumeReplyTo() }, (res) => {
    if (res?.ok) {
      actionText.value = '';
      currentOptions = ['Yes', 'No'];
      renderOptionChips();
    }
  });
});

const filePane = document.getElementById('filePane');
const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const filePreview = document.getElementById('filePreview');
const fileCaption = document.getElementById('fileCaption');
const pickFileBtn = document.getElementById('pickFileBtn');
const sendFileBtn = document.getElementById('sendFileBtn');
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

async function handleFiles(files) {
  if (!files || !files.length) return;
  const file = files[0];
  const fd = new FormData();
  fd.append('file', file);
  filePreview.hidden = false;
  filePreview.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } });
    if (!res.ok) { let why = 'Upload failed.'; try { why = (await res.json()).error || why; } catch { /* not JSON: the status words stand */ } throw new Error(why); }
    const data = await res.json();
    pendingFile = data;
    renderFilePreview();
    sendFileBtn.disabled = false;
  } catch (e) {
    filePreview.textContent = e && e.message ? e.message : 'Upload failed.';
    sendFileBtn.disabled = true;
  }
}

function renderFilePreview() {
  if (!pendingFile) return;
  filePreview.innerHTML = '';
  if (pendingFile.mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = pendingFile.url;
    img.alt = pendingFile.filename;
    img.className = 'preview-img';
    filePreview.appendChild(img);
  } else {
    const p = document.createElement('p');
    p.textContent = `📄 ${pendingFile.filename}`;
    filePreview.appendChild(p);
  }
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'btn ghost small';
  rm.textContent = 'Remove';
  rm.onclick = () => {
    pendingFile = null;
    filePreview.hidden = true;
    filePreview.innerHTML = '';
    sendFileBtn.disabled = true;
    fileInput.value = '';
  };
  filePreview.appendChild(rm);
}

filePane?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingFile) return;
  const caption = fileCaption.value.trim();
  socket.emit('message', {
    type: 'file',
    url: pendingFile.url,
    filename: pendingFile.filename,
    mime: pendingFile.mime,
    caption,
    priority: consumePriority(filePriBtn),
    replyTo: consumeReplyTo(),
  }, (res) => {
    if (res?.ok) {
      pendingFile = null;
      filePreview.hidden = true;
      filePreview.innerHTML = '';
      fileCaption.value = '';
      fileInput.value = '';
      sendFileBtn.disabled = true;
    }
  });
});

// ---------------- Helpers ----------------
function roleLabel(role) {
  // 'director' is a legacy alias kept for old persisted history
  return role === 'board' || role === 'director' ? 'On stage' :
         role === 'research' ? 'Backstage' :
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
function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}
function flash(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 30000);
}

// Admin support view banner
if (ADMIN_VIEW) {
  document.body.classList.add('is-admin-view');
  const b = document.createElement('div');
  b.className = 'admin-view-banner';
  b.innerHTML = 'Admin support view — acting as <strong>' + escapeHtml(NAME) + '</strong>';
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

  // Listen for parent (admin dashboard) postMessage telling us to resync now
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'agm:resync' && socket && socket.connected) {
      socket.emit('userState:requestPeers');
      if (window.AGM_DEBUG_SYNC) console.log('[sync] manual resync requested');
    }
  });
}


/** The forward picker: the server lists only the other halls this person is in and may post in. */
function offerForward(anchor, messageId) {
  socket.emit('myRooms', (res) => {
    if (!res || !res.ok) { alert('Could not check your other halls.'); return; }
    if (!res.rooms.length) {
      alert('To forward, open another hall where you may post (in another tab, as ' + NAME + ').');
      return;
    }
    showForwardMenu(anchor, res.rooms, messageId);
  });
}

function showForwardMenu(anchor, otherRooms, messageId) {
  const old = document.getElementById('fwdMenu');
  if (old) old.remove();
  const menu = document.createElement('div');
  menu.id = 'fwdMenu';
  menu.className = 'fwd-menu';
  menu.innerHTML = '<div class="fwd-menu-title">Forward to…</div>';
  for (const r of otherRooms) {
    const code = (typeof r === "string") ? r : (r && r.code) || "";
    const name = (typeof r === "string") ? "" : (r && r.name) || "";
    if (!code) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "fwd-menu-item";
    if (name) {
      item.innerHTML = "<span class=\"fwd-room-name\">" + escapeHtml(name) +
        "</span><span class=\"fwd-room-code\">" + escapeHtml(code) + "</span>";
    } else {
      item.innerHTML = "<span class=\"fwd-room-code primary\">" + escapeHtml(code) + "</span>";
    }
    item.onclick = () => {
      socket.emit("forward", { messageId, targetRoom: code }, (res) => {
        if (!res || !res.ok) alert((res && res.error) || "Forward failed");
        else flashStatus("Forwarded to " + (name ? (name + " (" + code + ")") : code));
      });
      menu.remove();
    };
    menu.appendChild(item);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function outside(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', outside);
      }
    });
  }, 0);
}

function flashStatus(text) {
  const t = document.createElement('div');
  t.className = 'agm-toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2400);
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
  const id = node.dataset.id;
  for (const [emoji, data] of counts) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'rx-pill' + (data.mine ? ' mine' : '');
    pill.title = data.names.join(', ');
    pill.innerHTML = '<span>' + escapeHtml(emoji) + '</span> <small>' + escapeHtml(String(data.n)) + '</small>';
    pill.disabled = readOnly();
    pill.onclick = () => socket.emit('react', { messageId: id, emoji });
    rx.appendChild(pill);
  }
  rx.hidden = false;
}

const COMMON_REACTIONS = ['👍','👎','❤️','🎉','🤔','👀','😂','🔥'];
function showReactionPicker(anchor, messageId) {
  const old = document.getElementById('rxPicker');
  if (old) old.remove();
  const menu = document.createElement('div');
  menu.id = 'rxPicker';
  menu.className = 'rx-picker';
  for (const e of COMMON_REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.title = 'React with ' + e;
    b.onclick = () => {
      socket.emit('react', { messageId, emoji: e });
      menu.remove();
    };
    menu.appendChild(b);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function outside(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', outside);
      }
    });
  }, 0);
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
    '<button type="button" class="reply-cancel" title="Cancel reply">×</button>';
  chip.querySelector('.reply-cancel').onclick = cancelReply;
}
function consumeReplyTo() {
  const r = replyState ? replyState.id : null;
  if (replyState) cancelReply();
  return r;
}

// ---------------- Ask for help: a category and a few words, to the hall and to the project managers' board ----------------
(function () {
  const CATS = ['Sound', 'Vision', 'Lighting', 'Stage', 'Presenter', 'IT / network', 'Other'];
  const dlg = document.getElementById('helpDialog');
  const box = document.getElementById('helpCats');
  for (const [i, c] of CATS.entries()) {
    const l = document.createElement('label');
    l.className = 'help-cat';
    const r = document.createElement('input');
    r.type = 'radio'; r.name = 'helpCat'; r.value = c; r.checked = i === 0;
    l.appendChild(r);
    l.appendChild(document.createTextNode(c));
    box.appendChild(l);
  }
  document.getElementById('helpBtn').addEventListener('click', () => { document.getElementById('helpText').value = ''; dlg.showModal(); });
  document.getElementById('helpForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const category = (box.querySelector('input:checked') || {}).value || 'Other';
    socket.emit('message', { type: 'help', category, text: document.getElementById('helpText').value.trim() }, (r) => {
      if (!r || !r.ok) { notify((r && r.error) || 'Not sent.', true); return; }
      dlg.close();
      notify('Help request sent — it stays up until someone marks it resolved.');
    });
  });
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
      if (first) { for (const d of list) ticked.add(d.id); refreshScreenButtons(); }
      render();
    });
  }
  function refreshScreenButtons() { for (const [id, node] of messagesById) { const m = findMessage(id); if (m && m.type !== 'system') rerenderMessage(node, m); } }

  function render() {
    const ul = $('screenList');
    ul.textContent = '';
    $('screensEmpty').hidden = list.length > 0;
    $('screensManage').hidden = !manage;
    for (const d of list) {
      const li = document.createElement('li');
      li.className = 'screen-item';
      li.dataset.state = d.state;
      const pick = document.createElement('input');
      pick.type = 'checkbox'; pick.checked = ticked.has(d.id); pick.setAttribute('aria-label', 'Show on ' + d.name);
      pick.onchange = () => { if (pick.checked) ticked.add(d.id); else ticked.delete(d.id); syncAll(); };
      const name = document.createElement('strong'); name.textContent = d.name;
      const st = document.createElement('span'); st.className = 'screen-state'; st.textContent = d.mark + ' ' + d.words;
      const what = document.createElement('span'); what.className = 'screen-showing'; what.textContent = d.showing;
      const head = document.createElement('div'); head.className = 'screen-line';
      head.append(pick, name, st);
      if (refused.has(d.id)) { const no = document.createElement('span'); no.className = 'screen-refused'; no.textContent = '✕ the last take did not reach it: ' + refused.get(d.id); head.append(no); }
      const acts = document.createElement('div'); acts.className = 'screen-acts';
      acts.appendChild(btn('Identify', () => socket.emit('display:identify', { id: d.id }, (r) => notify(r && r.ok ? (r.screens ? 'Showing its name on ' + (r.screens > 1 ? 'its ' + r.screens + ' screens' : 'the screen') + ' for 6 seconds.' : 'No screen has this link open.') : (r && r.error) || 'Not sent.', !(r && r.ok)))));
      if (manage) {
        acts.appendChild(btn('Copy link', () => copy(location.origin + d.path)));
        const open = document.createElement('a'); open.className = 'btn ghost small'; open.href = d.path; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Open';
        acts.appendChild(open);
        acts.appendChild(btn('Rename', () => { const n = prompt('Name this screen', d.name); if (n) socket.emit('display:update', { id: d.id, name: n }, done('Renamed.')); }));
        acts.appendChild(btn('New link', () => { if (confirm('Give ' + d.name + ' a new link? The old one stops at once, on every screen that has it.')) socket.emit('display:rotate', { id: d.id }, (r) => { if (r && r.ok) { copy(location.origin + r.path); notify('New link copied — open it on the screen.'); } else notify((r && r.error) || 'Not changed.', true); }); }));
        acts.appendChild(btn('Remove', () => { if (confirm('Remove ' + d.name + '? Its link stops working.')) socket.emit('display:remove', { id: d.id }, done('Removed.')); }));
      }
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
  }
  function syncAll() { $('screensAll').checked = list.length > 0 && list.every((d) => ticked.has(d.id)); }
  function btn(label, onclick) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = label; b.onclick = onclick; return b; }
  function done(words) { return (r) => notify(r && r.ok ? words : (r && r.error) || 'Not changed.', !(r && r.ok)); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); notify('Link copied.'); } catch { prompt('Copy this screen link', text); }
  }

  /**
   * Put a content on every ticked screen, in one request however many are ticked; say how many took it (each confirms on
   * its own line when it has shown it) and name the ones it did not reach.
   */
  function take(content) {
    const ids = list.filter((d) => ticked.has(d.id)).map((d) => d.id);
    if (!ids.length) { notify('Tick at least one screen.', true); return; }
    const names = new Map(list.map((d) => [d.id, d.name]));   // as ticked, though the list may be re-read meanwhile
    socket.emit('display:take', { ids, content }, (r) => {
      const results = r && Array.isArray(r.results) ? r.results : [];
      if (!results.length) { notify((r && r.error) || 'Not sent.', true); return; }
      refused.clear();
      for (const x of results) if (!x.ok) refused.set(x.id, x.error || 'not sent');
      const sent = results.length - refused.size;
      if (!refused.size) notify('Sent to ' + sent + ' screen' + (sent === 1 ? '' : 's') + ' — each shows ✓ once it is on screen.');
      else notify('Sent to ' + sent + ' of ' + results.length + ' screens. Not to ' + Array.from(refused.keys(), (id) => names.get(id) || id).join(', ') + ': ' + refused.values().next().value, true);
      render();
    });
  }

  // The dialog opens with the saved holding image picked, whether Screens or ⧉ opens it: an unsaved pick lives only as
  // long as the opening it was made in (cleared here, not on "close", which a hidden tab's browser may hold back).
  function open() {
    if (dlg.open) return;
    holdingChoice = null;
    dlg.showModal();
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
    else if (!text) notify('Type the message first.', true);
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
    if (!name) { notify('Name the screen first.', true); return; }
    socket.emit('display:create', { code: ROOM, name }, (r) => {
      if (!r || !r.ok) { notify((r && r.error) || 'Not added.', true); return; }
      $('newScreenName').value = '';
      ticked.add(r.display.id);
      copy(location.origin + r.display.path);
      notify(r.display.name + ' added — its link is copied: open it on that screen.');
    });
  });
  $('holdingPick').addEventListener('change', () => { holdingChoice = $('holdingPick').value === holding ? null : $('holdingPick').value; });
  $('holdingSave').addEventListener('click', () => {
    const image = $('holdingPick').value;
    socket.emit('display:hallHolding', { code: ROOM, image }, (r) => { if (r && r.ok) { holding = image; holdingChoice = null; } done('Holding image saved.')(r); });
  });
  socket.on('displays:changed', ({ code } = {}) => { if (code === ROOM && CAN_SCREENS) load(); });
  return { load, offer };
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
    $('swText').value = msg ? (msg.text || '').slice(0, 500) : '';
    $('swError').hidden = true;
    socket.emit('stage:targets', {}, (r) => {
      if (!r || !r.ok) { notify((r && r.error) || 'Stagewatch is not linked to this hall.', true); return; }
      caps = r;
      $('swWhich').textContent = r.linked ? 'To ' + (r.title || 'this hall\'s Stagewatch') + '.' : 'Stagewatch is not connected right now — nothing is queued; try again when it is.';
      const sel = $('swDest');
      sel.textContent = '';
      for (const t of r.targets) {
        if (!r.canPropose && !(t.direct && r.canSend)) continue;
        const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o);
      }
      sync();
      dlg.showModal();
    });
  }
  const fail = (text) => { $('swError').textContent = text; $('swError').hidden = false; };
  $('swDest').addEventListener('change', sync);
  $('swNow').addEventListener('click', () => {
    socket.emit('stage:send', { text: $('swText').value.trim(), urgency: $('swUrg').value, messageId: source && source.text === $('swText').value.trim() ? source.id : undefined }, (res) => {
      if (!res || !res.ok) return fail((res && res.error) || 'Not sent.');
      dlg.close();
      notify(res.stage === 'applied' ? 'On the speaker\'s screen — their acknowledgement shows on the message.' : 'Stagewatch took it — the speaker\'s acknowledgement shows on the message.');
    });
  });
  $('swForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const text = $('swText').value.trim();
    socket.emit('stage:propose', { text, destination: $('swDest').value, urgency: $('swUrg').value, messageId: source && source.text === text ? source.id : undefined }, (res) => {
      if (!res || !res.ok) return fail((res && res.error) || 'Not sent.');
      dlg.close();
      notify('Asked — the show caller approves it in Stagewatch; its state shows on the message.');
    });
  });
  return { open };
})();
