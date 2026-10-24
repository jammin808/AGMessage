// AGMessage admin client.
//
// Flow:
//   1. POST the admin token to /api/admin/login (only allowed from localhost).
//   2. Server sets an HttpOnly cookie (`agm_admin`).
//   3. Open a Socket.io connection — the cookie is sent automatically.
//   4. Server marks the socket as admin and accepts admin:* events.

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
});

const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginNotice = document.getElementById('loginNotice');
const loginError = document.getElementById('loginError');
const tokenInput = document.getElementById('tokenInput');
const loginForm = document.getElementById('loginForm');

let socket = null;
let allRooms = [];

(async function init() {
  // First, check if we're already logged in (cookie set) and on the host
  const me = await fetch('/api/admin/me').then((r) => r.json()).catch(() => ({}));
  if (!me.local) {
    loginPanel.hidden = false;
    loginNotice.innerHTML =
      '<strong style="color:var(--danger)">Admin can only be accessed from the host laptop.</strong>' +
      ' Open this URL in a browser running on the machine that started the server.';
    tokenInput.disabled = true;
    document.querySelector('#loginForm button').disabled = true;
    return;
  }
  if (me.ok) {
    showDashboard();
  } else {
    loginPanel.hidden = false;
    tokenInput.focus();
  }
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
    showDashboard();
  } else {
    loginError.textContent = data.error || 'Login failed';
    loginError.hidden = false;
    tokenInput.select();
  }
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  location.reload();
});

// ---------------- Dashboard ----------------
function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
  socket = io();
  socket.on('connect', () => {
    refreshRooms();
  });
  socket.on('disconnect', () => {
    document.getElementById('adminStatus').textContent = 'disconnected — reconnecting…';
  });
  socket.on('connect', () => {
    document.getElementById('adminStatus').textContent = 'connected';
  });
  // Live updates while watching a room
  socket.on('message', onLiveMessage);
  socket.on('system', onLiveSystem);
  socket.on('users', onLiveUsers);
  socket.on('messageDeleted', ({ messageId }) => {
    const el = document.querySelector(`.admin-msg[data-id="${messageId}"]`);
    if (el) el.remove();
    if (currentRoom) currentRoom.messages = currentRoom.messages.filter((m) => m.id !== messageId);
    updateCounts();
  });
  socket.on('actionUpdate', () => { /* admin doesn't need to render */ });
  socket.on('pinUpdate', () => { /* same */ });

  document.getElementById('newSessionBtn').addEventListener('click', createNewRoom);
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    if (!currentRoom) return;
    window.open('/api/admin/transcript/' + currentRoom.code, '_blank');
  });

  document.getElementById('resetRoomBtn').addEventListener('click', () => {
    if (!currentRoom) return;
    const ok = confirm(
      'Reset session ' + currentRoom.code + '?\n\n' +
      'This will clear all messages and documents from the chat. ' +
      'Connected users stay logged in. This cannot be undone.'
    );
    if (!ok) return;
    socket.emit('admin:resetRoom', { roomCode: currentRoom.code }, (res) => {
      if (!res?.ok) { alert(res?.error || 'Reset failed'); return; }
      // Refresh our admin view
      currentRoom.messages = [];
      renderFeed(currentRoom.messages);
      updateCounts();
    });
  });
}

function refreshRooms() {
  socket.emit('admin:listRooms', (res) => {
    if (!res?.ok) return;
    allRooms = res.rooms;
    renderRoomList(res.rooms);
  });
}

let currentRoom = null;

function renderRoomList(rooms) {
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  document.getElementById('noRooms').hidden = rooms.length > 0;
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  for (const r of rooms) {
    const li = document.createElement('li');
    li.className = 'room-list-item';
    if (currentRoom && currentRoom.code === r.code) li.classList.add('active');
    li.innerHTML =
      `<button type="button" class="room-pick">` +
        (r.name ? `<span class="room-name">${escapeHtml(r.name)}</span>` : '') +
        `<strong>${escapeHtml(r.code)}</strong>` +
        `<small>${r.users.length} user${r.users.length === 1 ? '' : 's'}` +
        ` · ${escapeHtml(String(r.messageCount))} msg${r.messageCount === 1 ? '' : 's'}</small>` +
      `</button>`;
    li.querySelector('.room-pick').onclick = () => watchRoom(r.code);
    list.appendChild(li);
  }
}

function createNewRoom() {
  const name = (prompt('Optional session name (e.g. "Acme AGM 2026"). Leave blank for none:') || '').trim();
  socket.emit('admin:createRoom', { name }, (res) => {
    if (!res?.ok) return alert(res?.error || 'Could not create room');
    refreshRooms();
    watchRoom(res.code);
  });
}

function watchRoom(code) {
  socket.emit('admin:watchRoom', { roomCode: code }, (res) => {
    if (!res?.ok) return alert(res?.error || 'Could not watch room');
    currentRoom = { code, messages: res.messages || [], users: res.users || [] };
    document.getElementById('roomHeader').hidden = false;
    document.getElementById('usersSection').hidden = false;
    document.getElementById('messagesSection').hidden = false;
    document.getElementById('adminEmpty').hidden = true;
    document.getElementById('watchedRoomCode').textContent = code;
    const nameEl = document.getElementById('watchedRoomName');
    if (nameEl) {
      const nm = res.name || '';
      nameEl.textContent = nm;
      nameEl.hidden = !nm;
    }
    renderUsers(currentRoom.users);
    renderFeed(currentRoom.messages);
    updateCounts();
    refreshRooms();
  });
}

function renderUsers(users) {
  const tb = document.getElementById('usersTbody');
  tb.innerHTML = '';
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="4" class="muted">No-one has joined yet.</td></tr>';
    return;
  }
  for (const u of users) {
    const tr = document.createElement('tr');
    const sidHtml = escapeHtml(u.socketId);
    const linkedChipsHtml = (u.linkedRooms || []).map((rm) => {
      const nm = roomNameForCode(rm);
      const labelHtml = nm
        ? `<span class="lc-name">${escapeHtml(nm)}</span><span class="lc-code">${escapeHtml(rm)}</span>`
        : `<span class="lc-code">${escapeHtml(rm)}</span>`;
      return `<span class="linked-chip" title="Linked for forwarding: ${escapeHtml(nm || rm)}">${labelHtml}` +
        `<button class="unlink-room" data-sid="${sidHtml}" data-room="${escapeHtml(rm)}" title="Unlink">×</button>` +
      `</span>`;
    }).join("");
    tr.innerHTML =
      `<td><strong>${escapeHtml(u.name)}</strong></td>` +
      `<td><select data-sid="${sidHtml}" class="role-select">` +
        roleOptionsHtml(u.role) +
      `</select></td>` +
      `<td>` +
        (linkedChipsHtml || '<small class="muted">— none —</small>') +
      `</td>` +
      `<td>` +
        `<button class="btn ghost small view-as" data-sid="${sidHtml}" data-name="${escapeHtml(u.name)}" data-role="${escapeHtml(u.role)}">View</button> ` +
        `<button class="btn ghost small link-room" data-sid="${sidHtml}" data-name="${escapeHtml(u.name)}">🔗 Link…</button> ` +
        `<button class="btn ghost small kick" data-sid="${sidHtml}">Logout</button>` +
      `</td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('.role-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const sid = sel.dataset.sid;
      const role = sel.value;
      socket.emit('admin:setRole', { roomCode: currentRoom.code, socketId: sid, role }, (res) => {
        if (!res?.ok) alert(res?.error || 'Could not change role');
      });
    });
  });
  tb.querySelectorAll('.unlink-room').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.sid;
      const room = btn.dataset.room;
      socket.emit('admin:unlinkRoom', { socketId: sid, targetRoom: room }, (res) => {
        if (!res?.ok) { alert(res?.error || 'Unlink failed'); return; }
        // Refresh the user list to reflect the change
        if (!currentRoom) return;
        socket.emit('admin:listRooms', (after) => {
          const r = after.rooms.find((rr) => rr.code === currentRoom.code);
          if (r) { currentRoom.users = r.users; renderUsers(r.users); }
        });
      });
    });
  });
  tb.querySelectorAll(".link-room").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sid = btn.dataset.sid;
      const name = btn.dataset.name;
      const already = (currentRoom && currentRoom.users.find((u) => u.socketId === sid)?.linkedRooms) || [];
      openLinkPicker(btn, sid, name, already);
    });
  });
  tb.querySelectorAll('.view-as').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const role = btn.dataset.role;
      openUserView(currentRoom.code, name, role);
    });
  });
  tb.querySelectorAll('.kick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.sid;
      if (!confirm('Log this user out of the meeting?')) return;
      socket.emit('admin:kick', { socketId: sid }, (res) => {
        if (!res?.ok) alert(res?.error || 'Could not kick');
      });
    });
  });
}

function renderFeed(messages) {
  const feed = document.getElementById('adminFeed');
  feed.innerHTML = '';
  for (const m of messages) feed.appendChild(buildAdminMessage(m));
  feed.scrollTop = feed.scrollHeight;
}

function buildAdminMessage(m) {
  const div = document.createElement('div');
  div.className = 'admin-msg';
  div.dataset.id = m.id;
  if (m.type === 'system') {
    div.className += ' sys';
    div.textContent = m.text;
    return div;
  }
  if (m.priority) div.classList.add('priority');
  const whoHtml = m.from
    ? `<strong>${escapeHtml(m.from.name)}</strong> <span class="role-tag" data-role="${escapeHtml(m.from.role)}">${escapeHtml(m.from.role)}</span>`
    : '—';
  let bodyHtml = '';
  if (m.type === 'text') bodyHtml = `<p>${escapeHtml(m.text)}</p>`;
  else if (m.type === 'file') bodyHtml = `<p>📄 ${escapeHtml(m.filename)}${m.caption ? ` — <em>${escapeHtml(m.caption)}</em>` : ''}</p>`;
  else if (m.type === 'action') {
    bodyHtml = `<p>🟧 <strong>${escapeHtml(m.text)}</strong></p>` +
           `<p class="muted">Options: ${escapeHtml((m.options || []).join(' · '))}</p>`;
  }
  div.innerHTML =
    `<div class="admin-msg-head">${whoHtml} <time>${escapeHtml(formatTime(m.at))}</time>${m.priority ? ' <span class="priority-badge" style="display:inline-block">🔥 HIGH</span>' : ''}</div>` +
    `<div class="admin-msg-body">${bodyHtml}</div>` +
    `<div class="admin-msg-foot"><button class="btn ghost small del-any">🗑 Delete</button></div>`;
  div.querySelector('.del-any').onclick = () => {
    if (!confirm('Delete this message? This affects everyone in the meeting.')) return;
    socket.emit('admin:deleteMessage', { roomCode: currentRoom.code, messageId: m.id }, (res) => {
      if (!res?.ok) alert(res?.error || 'Could not delete');
    });
  };
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
/** The role picker's options, the person's own selected. */
function roleOptionsHtml(current) {
  return ['board', 'research', 'observer'].map((r) => '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' + r + '</option>').join('');
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
  title.textContent = 'Viewing ' + name + ' (' + role + ') in ' + code;
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
  // Quick path: ask the iframe to re-request peer state
  try {
    frame.contentWindow.postMessage({ type: 'agm:resync' }, '*');
  } catch (e) { /* cross-origin? unlikely since same-origin */ }
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
  if (e.key === 'Escape' && modal && !modal.hidden) closeUserView();
});
document.getElementById('userViewModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'userViewModal') closeUserView();
});

// ---------------- Room-name helpers and link picker ----------------

function roomNameForCode(code) {
  const r = (allRooms || []).find((rr) => rr && rr.code === code);
  return (r && r.name) || '';
}

// Opens a small floating picker anchored to the "🔗 Link…" button so the
// admin can pick a room by NAME (with code as secondary text) instead of
// being prompted to type a 6-character code. Refreshes the rooms list
// before opening so the picker reflects newly-created rooms.
function openLinkPicker(anchor, sid, name, alreadyLinked) {
  socket.emit('admin:listRooms', (res) => {
    if (!res?.ok) { alert(res?.error || 'Could not list rooms'); return; }
    allRooms = res.rooms;
    showLinkPicker(anchor, sid, name, alreadyLinked);
  });
}

function showLinkPicker(anchor, sid, name, alreadyLinked) {
  const old = document.getElementById('linkPicker');
  if (old) old.remove();
  const menu = document.createElement('div');
  menu.id = 'linkPicker';
  menu.className = 'link-picker';

  const homeCode = currentRoom ? currentRoom.code : null;
  const linkedSet = new Set((alreadyLinked || []).map((c) => String(c).toUpperCase()));
  const candidates = (allRooms || [])
    .filter((r) => r && r.code && r.code !== homeCode && !linkedSet.has(r.code))
    .sort((a, b) => {
      const an = a.name || '', bn = b.name || '';
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return (an || a.code).localeCompare(bn || b.code);
    });

  const title = document.createElement('div');
  title.className = 'link-picker-title';
  title.textContent = 'Link ' + name + ' to…';
  menu.appendChild(title);

  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'link-picker-empty';
    empty.textContent = 'No other rooms available. Create another room or unlink existing first.';
    menu.appendChild(empty);
  } else {
    for (const r of candidates) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'link-picker-item';
      if (r.name) {
        item.innerHTML =
          '<span class="lp-room-name">' + escapeHtml(r.name) + '</span>' +
          '<span class="lp-room-code">' + escapeHtml(r.code) + '</span>';
      } else {
        item.innerHTML = '<span class="lp-room-name">' + escapeHtml(r.code) + '</span>';
      }
      item.onclick = () => {
        socket.emit('admin:linkRoom', { socketId: sid, targetRoom: r.code }, (lres) => {
          if (!lres?.ok) { alert(lres?.error || 'Link failed'); return; }
          socket.emit('admin:listRooms', (after) => {
            if (!after?.ok) return;
            allRooms = after.rooms;
            const cur = after.rooms.find((rr) => rr.code === currentRoom?.code);
            if (cur) { currentRoom.users = cur.users; renderUsers(cur.users); }
          });
        });
        menu.remove();
      };
      menu.appendChild(item);
    }
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function outside(e) {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', outside);
      }
    });
  }, 0);
}

// ---------------- Cloudflare tunnel control ----------------
//
// The toggle starts/stops `cloudflared tunnel --url http://localhost:<PORT>`
// server-side. The server captures the trycloudflare.com URL from the
// child's stdout/stderr and pushes it to admin sockets via tunnel:status.
// Status states: off | starting (running but no URL yet) | on | error.

(function initTunnelControl() {
  const toggle = document.getElementById('tunnelToggle');
  if (!toggle) return; // legacy admin.html without the section

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

  function applyStatus(s) {
    if (!s) { showState('off'); toggle.checked = false; return; }
    if (s.error) { showState('error', s); toggle.checked = false; return; }
    if (s.running && s.url) { showState('on', s); toggle.checked = true; return; }
    if (s.running && !s.url) { showState('starting'); toggle.checked = true; return; }
    showState('off');
    toggle.checked = false;
  }

  // Listen for live status pushes from the server.
  if (typeof socket !== 'undefined' && socket) {
    socket.on('tunnel:status', (s) => applyStatus(s));
    // Initial fetch on dashboard show.
    socket.emit('admin:tunnelStatus', (res) => {
      if (res && res.ok) applyStatus(res);
    });
  }

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      showState('starting');
      socket.emit('admin:tunnelStart', (res) => {
        if (!res || !res.ok) {
          showState('error', { error: (res && res.error) || 'Could not start tunnel' });
          toggle.checked = false;
        }
        // success path: status:push will switch us to on/starting
      });
    } else {
      // Optimistic UI: show off immediately, server confirms via status push.
      showState('off');
      socket.emit('admin:tunnelStop', () => {});
    }
  });

  const copyBtn = document.getElementById('tunnelCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const u = document.getElementById('tunnelUrl');
      const text = u ? u.textContent.trim() : '';
      if (!text || text === '—') return;
      try {
        await navigator.clipboard.writeText(text);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      } catch (e) {
        // Fallback: select + execCommand
        const r = document.createRange(); r.selectNode(u);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(r);
        try { document.execCommand('copy'); copyBtn.textContent = '✓ Copied'; } catch { /* no clipboard: the link stays selected to copy by hand */ }
        window.getSelection().removeAllRanges();
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
      }
    });
  }
})();
