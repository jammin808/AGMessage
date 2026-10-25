// Admin 0.2: AI minutes, role invites, closing a meeting, the AI key and the show network.
// Shares admin.js's globals (socket, currentRoom, escapeHtml) — loaded after it.
/* global socket, currentRoom */
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
      $('swKey').placeholder = s.stagewatchKeySet ? '•••••• (saved — type to replace)' : 'Stagewatch node key (swk_…)';
      const clock = s.health && s.health.clock;
      $('swStatus').textContent = s.stagewatchUrl ? 'Stagewatch: ' + s.stage + (clock && clock.apart ? ' · CLOCKS APART (' + (clock.offsetMs / 1000).toFixed(1) + ' s)' : '') : '';
      const keyState = s.health && s.health.stageKey ? s.health.stageKey.state : '';
      $('swStatus').classList.toggle('bad', !!(clock && clock.apart) || keyState === 'refused');
      const ctx = s.stageContext;
      $('swContext').hidden = !ctx;
      if (ctx) $('swContext').textContent = 'Stagewatch says: ' + (ctx.headline || '') + ((ctx.peers || []).length ? ' · it hears ' + ctx.peers.map((p) => p.t + ' “' + (p.name || '') + '”').join(', ') : '');
      $('ctxToken').textContent = s.contextToken || '—';
      renderTls(s.tls, s.stagewatchFingerprint);
      $('remoteAdmin').checked = !!s.remoteAdmin;
      $('acctCount').textContent = s.accounts ? s.accounts + ' account' + (s.accounts === 1 ? '' : 's') : 'No accounts yet — sign in on the start page to make the first admin';
      $('buildLine').textContent = s.build ? 'This is AGMessage ' + s.build + '.' : '';
      renderHealth(s.health);
      renderPeers(s.peers || []);
    });
  }

  function pretty(fp) { return fp ? fp.replace(/^sha256:/, '').match(/../g).join(':').toUpperCase() : '—'; }
  function renderTls(t, typed) {
    if (!t) return;
    $('tlsFp').textContent = t.on ? pretty(t.fingerprint) : 'HTTPS is off';
    $('tlsValid').textContent = t.on && t.validTo ? '(valid until ' + t.validTo + ')' : '';
    $('tlsRenew').hidden = !t.on;
    $('requireHttps').checked = !!t.requireHttps;
    $('requireHttps').disabled = !t.on;
    if (document.activeElement !== $('swFp')) $('swFp').value = typed || '';
    const l = t.link || {};
    $('swAccept').hidden = !l.changed;
    $('swTls').textContent = !l.on ? 'Link to Stagewatch: plain HTTP (it announces no certificate)'
      : l.problem ? '⚠ ' + l.problem
      : 'Link to Stagewatch: encrypted ✓ — certificate ' + pretty(l.fp).slice(0, 23) + '… ' + (l.pinned ? '(pinned)' : '(pinned once Stagewatch accepts the key)');
    $('swTls').classList.toggle('bad', !!l.problem);
    $('deskLine').textContent = t.desk ? 'Show desk: Stagewatch keeps the shared approval queue — the research team can propose stage messages (📝), and approved "notice" proposals for this AGMessage are shown in every meeting.' : '';
  }

  function renderHealth(h) {
    if (!h) return;
    const parts = [];
    parts.push(h.restarts ? 'restarted by the watchdog ' + h.restarts + '×' : 'running since start');
    if (h.watchdog) parts.push('⚠ the watchdog gave up at ' + new Date(h.watchdog.at).toLocaleTimeString() + ': ' + h.watchdog.reason);
    if (h.lastCrash) parts.push('last crash ' + new Date(h.lastCrash.at).toLocaleString() + ': ' + h.lastCrash.message);
    if (h.rejections) parts.push(h.rejections + ' failed background task(s)');
    if (h.loopMs && h.loopMs.count) parts.push('server delay p95 ' + h.loopMs.p95 + ' ms (max ' + h.loopMs.max + ')');
    if (h.stageRttMs && h.stageRttMs.count) parts.push('send-to-stage ' + h.stageRttMs.p50 + ' ms typical, ' + h.stageRttMs.max + ' worst');
    if (h.clock) parts.push('clock vs Stagewatch ' + (h.clock.offsetMs >= 0 ? '+' : '') + h.clock.offsetMs + ' ms' + (h.clock.apart ? ' — CLOCKS APART' : ''));
    // Each store that could not be saved, by name: what it holds is kept and tried again until it is on disk.
    const stores = (h.saves && h.saves.stores) || {};
    for (const [name, st] of Object.entries(stores)) {
      if (st && st.error) parts.push('⚠ ' + name + ' save failed (kept, tried again): ' + st.error);
      else if (st && st.unwritten) parts.push('⚠ ' + st.unwritten + ' ' + name + ' entries not yet on disk');
    }
    if (h.desk && h.desk.waiting) {
      const n = h.desk.waiting;
      const last = h.desk.lastStatus === null ? '' : h.desk.lastStatus ? 'last answer ' + h.desk.lastStatus : 'no answer to the last try';
      const next = h.desk.nextInMs === null ? 'tried once its Stagewatch is linked and keeps a desk' : 'next try in ' + Math.round(h.desk.nextInMs / 1000) + ' s';
      parts.push('⚠ ' + n + ' show-desk result' + (n === 1 ? '' : 's') + ' waiting for Stagewatch to take ' + (n === 1 ? 'it' : 'them') + ' (' + [last, next].filter(Boolean).join(', ') + ')');
    }
    if (h.tls && h.tls.link && h.tls.link.changed) parts.push('⚠ CERTIFICATE CHANGED — Stagewatch\'s certificate is not the one pinned; the link is refused until you accept it');
    $('healthLine').textContent = parts.join(' · ');
  }

  function renderPeers(peers) {
    const ul = $('peerList');
    ul.textContent = '';
    if (!peers.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Listening for Stagewatch, Patterns and presenter PCs on this network (UDP 9928)…'; ul.appendChild(li); return; }
    const LABEL = { main: '⏱ Stagewatch', agent: '🖥 Presenter PC (Stagewatch Slides)', patterns: '🎛 Patterns', playmap: '🎞 PlayMap', messenger: '💬 AGMessage' };
    for (const p of peers) {
      const li = document.createElement('li');
      const dot = p.status === 'live' ? '🟢' : '🟠';
      li.textContent = dot + ' ' + (LABEL[p.t] || p.t) + ' — ' + (p.name || p.host || '') + ' (' + p.address + (p.status === 'live' ? '' : ', not heard for ' + p.age + ' s') + ')';
      const http = p.ports && p.ports.http;
      if (p.t === 'main' && http) {
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.type = 'button'; b.textContent = 'Use';
        b.onclick = () => { $('swUrl').value = p.address + ':' + http; $('swKey').focus(); };
        li.appendChild(b);
      }
      // Patterns and PlayMap: link with the node's own token (sealed here), optionally for one hall.
      if (p.t === 'patterns' || p.t === 'playmap') {
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.type = 'button'; b.textContent = linkedIds.has(p.id) ? 'Linked — change' : 'Link…';
        b.onclick = () => linkNode(p);
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- Patterns and PlayMap links
  let linkedIds = new Set();
  function loadNodes() {
    socket.emit('nodes:list', {}, (r) => {
      if (!r || !r.ok) return;
      linkedIds = new Set(r.linked.map((l) => l.id));
      const ul = $('nodeLinks');
      ul.textContent = '';
      if (!r.linked.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No Patterns or PlayMap linked. Link one from the list above when AGMessage hears it.'; ul.appendChild(li); }
      for (const l of r.linked) {
        const li = document.createElement('li');
        const mark = { green: '✓', amber: '△', red: '✕', grey: '○' }[l.light] || '○';
        li.textContent = mark + ' ' + (l.t === 'playmap' ? 'PlayMap' : 'Patterns') + ' “' + l.name + '” — ' + l.status + (l.problem ? ' (' + l.problem + ')' : '') + (l.headline ? ': ' + l.headline : '') + (l.hall ? ' · hall ' + l.hall : '') + ' · ' + l.commands.length + ' verbs';
        // A certificate that waits (changed, or never confirmed) is confirmed by typing the start of the fingerprint the
        // node shows on its own screen; this page is never told the fingerprint, so it cannot be copied from here.
        if (l.certificateWaits) {
          const acc = document.createElement('button');
          acc.className = 'btn ghost small'; acc.type = 'button'; acc.textContent = l.certificateChanged ? 'Accept new certificate…' : 'Confirm certificate…';
          acc.onclick = () => {
            const typed = prompt((l.certificateChanged ? l.name + '\'s certificate changed. Only accept it if you know why (a renewal, a reinstall, a new laptop). ' : '')
              + 'Type the first 16 or more characters of the certificate fingerprint ' + l.name + ' shows on its own screen.', '');
            if (typeof typed !== 'string' || !typed.trim()) return;
            socket.emit('nodes:acceptCertificate', { id: l.id, fingerprint: typed.trim() }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not accepted.'); loadNodes(); });
          };
          li.appendChild(acc);
        }
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.type = 'button'; b.textContent = 'Unlink';
        b.onclick = () => { if (confirm('Unlink ' + l.name + '? Its token and its certificate pin are forgotten.')) socket.emit('nodes:unlink', { id: l.id }, () => loadNodes()); };
        li.appendChild(b);
        ul.appendChild(li);
      }
    });
  }
  function linkNode(p) {
    const token = prompt('The pairing token of ' + (p.name || p.t) + ' (' + (p.t === 'playmap' ? 'PlayMap: node settings → Network' : 'Patterns: Remote page → TRUST') + '). Leave empty to keep the saved one.', '');
    if (typeof token !== 'string') return;   // cancelled
    const hall = prompt('For one hall? Type its code (e.g. K7P2QX), or leave empty for every hall.', '') || '';
    // The token goes to another machine only over HTTPS to a certificate a person confirmed (or one pinned before).
    const fingerprint = prompt('Its certificate: type the first 16 or more characters of the fingerprint ' + (p.name || p.t) + ' shows on its own screen. Leave empty when it runs on this laptop, or its certificate is confirmed already.', '') || '';
    socket.emit('nodes:link', { id: p.id, token, hall: hall.trim(), fingerprint: fingerprint.trim() }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not linked.'); loadNodes(); });
  }

  function wire() {
    if (wired || typeof socket === 'undefined' || !socket) return;
    wired = true;
    socket.on('connect', () => loadSettings());
    socket.on('nodes', (list) => { renderPeers(list); });
    socket.on('nodes:changed', loadNodes);
    loadNodes();
    if (socket.connected) loadSettings();

    setInterval(() => { if (socket.connected) loadSettings(); }, 5000);   // health, clock and peers stay current
    $('ctxCopy').onclick = () => { const t = $('ctxToken').textContent; if (navigator.clipboard && t && t !== '—') navigator.clipboard.writeText(t); };
    $('ctxNew').onclick = () => loadSettings({ newContextToken: true });
    $('requireHttps').onchange = () => loadSettings({ requireHttps: $('requireHttps').checked });
    $('remoteAdmin').onchange = () => loadSettings({ remoteAdmin: $('remoteAdmin').checked });
    $('swAccept').onclick = () => {
      if (!confirm('Accept Stagewatch\'s new certificate? Only do this if you know why it changed (a reinstall, a new certificate made on purpose).')) return;
      socket.emit('admin:acceptCertificate', () => setTimeout(() => loadSettings(), 800));
    };
    $('tlsRenew').onclick = () => {
      if (!confirm('Make a new certificate? Every device and app that trusted the old one will need to trust the new one.')) return;
      socket.emit('admin:renewCertificate', () => loadSettings());
    };
    $('aiKeySave').onclick = () => { loadSettings({ aiKey: $('aiKeyInput').value.trim() }); $('aiKeyInput').value = ''; };
    $('swSave').onclick = () => {
      const patch = { stagewatchUrl: $('swUrl').value.trim(), stagewatchFingerprint: $('swFp').value.trim() };
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
