// Admin 0.2: AI minutes, role invites, closing a meeting, the AI key and the show network.
// Shares admin.js's globals (socket, currentRoom, escapeHtml) — loaded after it.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let wired = false;
  let lastMinutes = '';

  function panel(which) {
    $('roomTools').hidden = !which;
    for (const p of ['invitesPanel', 'minutesPanel', 'closePanel']) $(p).hidden = p !== which;
  }

  function loadSettings(patch) {
    socket.emit('admin:settings', patch || null, (s) => {
      if (!s || !s.ok) return;
      $('aiModel').textContent = s.model;
      $('aiStatus').textContent = s.aiKeySet ? (s.aiFromEnv ? 'on (key from ANTHROPIC_API_KEY)' : 'on') : 'off — no key';
      document.querySelectorAll('.ai-btn').forEach((b) => { b.disabled = !s.aiKeySet; });
      $('swUrl').value = s.stagewatchUrl || '';
      $('swKey').placeholder = s.stagewatchKeySet ? '•••••• (saved — type to replace)' : 'Stagewatch control key (swk_…)';
      $('swStatus').textContent = s.stagewatchUrl ? 'Stagewatch: ' + s.stage : '';
      renderPeers(s.peers || []);
    });
  }

  function renderPeers(peers) {
    const ul = $('peerList');
    ul.textContent = '';
    if (!peers.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Listening for Stagewatch and Patterns on this network…'; ul.appendChild(li); return; }
    for (const p of peers) {
      const li = document.createElement('li');
      const label = p.kind === 'stagewatch' ? '⏱ Stagewatch' : '🎛 Patterns';
      const what = p.kind === 'stagewatch' ? (p.name || p.machine) : (p.machine + (p.program ? ' · on air: ' + p.program : ''));
      li.textContent = label + ' — ' + what + ' (' + p.address + ')';
      if (p.kind === 'stagewatch' && p.web) {
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.type = 'button'; b.textContent = 'Use';
        b.onclick = () => { $('swUrl').value = p.address + ':' + p.web; $('swKey').focus(); };
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
  }

  function wire() {
    if (wired || typeof socket === 'undefined' || !socket) return;
    wired = true;
    socket.on('connect', () => loadSettings());
    socket.on('nodes', renderPeers);
    if (socket.connected) loadSettings();

    $('aiKeySave').onclick = () => { loadSettings({ aiKey: $('aiKeyInput').value.trim() }); $('aiKeyInput').value = ''; };
    $('swSave').onclick = () => {
      const patch = { stagewatchUrl: $('swUrl').value.trim() };
      if ($('swKey').value.trim()) patch.stagewatchKey = $('swKey').value.trim();
      loadSettings(patch); $('swKey').value = '';
      setTimeout(() => loadSettings(), 1500);
    };

    $('invitesBtn').onclick = () => {
      if (!currentRoom) return;
      panel('invitesPanel');
      socket.emit('admin:listRooms', (res) => {
        const r = res && res.rooms && res.rooms.find((x) => x.code === currentRoom.code);
        $('lockRoles').checked = !!(r && r.locked);
        showInvites(r && r.locked);
      });
    };
    $('lockRoles').onchange = () => {
      socket.emit('admin:lockRoles', { roomCode: currentRoom.code, on: $('lockRoles').checked }, (res) => showInvites(res && res.locked));
    };
    function showInvites(on) {
      const box = $('inviteLinks');
      box.textContent = '';
      if (!on) { box.textContent = 'Open: anyone with the code can join in any role.'; return; }
      socket.emit('admin:invites', { roomCode: currentRoom.code }, (res) => {
        if (!res || !res.ok) return;
        for (const role of ['board', 'research']) {
          const url = location.origin + res.invites[role];
          const row = document.createElement('div');
          row.className = 'invite-row';
          const lab = document.createElement('strong'); lab.textContent = role === 'board' ? 'Board link' : 'Research link';
          const code = document.createElement('code'); code.textContent = url;
          const copy = document.createElement('button'); copy.className = 'btn ghost small'; copy.type = 'button'; copy.textContent = '📋 Copy';
          copy.onclick = () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => { copy.textContent = '✓ Copied'; setTimeout(() => { copy.textContent = '📋 Copy'; }, 1500); });
          row.append(lab, code, copy);
          box.appendChild(row);
        }
        const tip = document.createElement('p'); tip.className = 'hint';
        tip.textContent = 'Send each link only to that group. If you open the tunnel, these links work from anywhere — replace localhost with the public address.';
        box.appendChild(tip);
      });
    }

    $('minutesBtn').onclick = () => {
      if (!currentRoom) return;
      panel('minutesPanel');
      $('minutesBody').textContent = 'Claude is reading the conversation…';
      socket.emit('admin:summary', { roomCode: currentRoom.code }, (res) => {
        if (!res || !res.ok) { $('minutesBody').textContent = (res && res.error) || 'No minutes.'; lastMinutes = ''; return; }
        const parts = [res.headline || ''];
        const add = (title, list) => { if (list && list.length) parts.push('\n' + title + ':\n' + list.map((x) => '• ' + x).join('\n')); };
        add('Decisions', res.decisions); add('Open questions', res.open); add('Action items', res.actions);
        lastMinutes = parts.join('\n').trim();
        $('minutesBody').textContent = lastMinutes;
      });
    };
    $('postMinutesBtn').onclick = () => {
      if (!lastMinutes || !currentRoom) return;
      socket.emit('admin:postSummary', { roomCode: currentRoom.code, text: '📝 Minutes so far (AI draft, posted by the admin)\n\n' + lastMinutes }, () => panel(null));
    };
    $('closeMinutesBtn').onclick = () => panel(null);

    $('closeRoomBtn').onclick = () => { if (currentRoom) { $('closeCode').textContent = currentRoom.code; panel('closePanel'); } };
    $('cancelCloseBtn').onclick = () => panel(null);
    $('confirmCloseBtn').onclick = () => {
      socket.emit('admin:deleteRoom', { roomCode: currentRoom.code, purgeFiles: $('purgeFiles').checked }, (res) => {
        if (!res || !res.ok) return;
        panel(null);
        location.reload();
      });
    };
  }
  const t = setInterval(() => { wire(); if (wired) clearInterval(t); }, 300);
})();
