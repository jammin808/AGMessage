// The account area: every hall this account may see, as a board — each hall's countdown from its Stagewatch, who is in,
// its last message, open help requests and its displays — with the way into each. Project managers and senior techs see
// every hall; techs and staff see theirs. The board is live over the socket ('board:watch'); /api/halls is its first
// paint and its fallback.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = AGM.esc;
  AGM.theme();

  let me = null;
  let halls = [];          // from /api/halls: code, name, can{…}
  let live = {};           // code -> the board's live row (stage, last, help, displays, people)
  let helps = [];          // open help requests across the halls this account sees
  let canManageHalls = false;

  // ---------------------------------------------------------------- first paint
  async function load() {
    const r = await AGM.api('GET', '/api/halls');
    if (r.status === 401) { location.replace('/?next=/halls.html'); return; }
    if (r.mustChange) { location.replace('/'); return; }
    if (!r.ok) { AGM.toast(r.error, true); return; }
    me = r.account;
    halls = r.halls;
    canManageHalls = r.canManageHalls;
    $('who').textContent = me.name + ' · ' + me.rights.roleLabel;
    $('pwUser').value = me.username;
    $('usersLink').hidden = !(r.canManageUsers || r.canAudit);
    $('adminLink').hidden = !r.isAdmin;
    $('newHallBtn').hidden = !canManageHalls;
    $('boardTitle').textContent = me.rights.allHalls ? 'Every hall' : (halls.length === 1 ? 'Your hall' : 'Your halls');
    render();
  }

  // ---------------------------------------------------------------- the board
  const STATE = {
    running: { mark: '▶', words: 'running' },
    paused: { mark: '⏸', words: 'held' },
    over: { mark: '■', words: 'over time' },
    idle: { mark: '○', words: 'not running' },
    stale: { mark: '?', words: 'link lost — last known' },
    none: { mark: '○', words: 'no Stagewatch linked' },
  };
  function stageState(st) {
    if (!st || !st.status || st.status === 'off') return 'none';
    if (st.status !== 'connected' || st.stale) return 'stale';
    if (Number.isFinite(st.seconds) && st.seconds < 0) return 'over';
    if (st.state === 'running') return 'running';
    if (st.state === 'paused') return 'paused';
    return 'idle';
  }

  function render() {
    const list = $('hallList');
    $('emptyNote').hidden = halls.length > 0;
    list.textContent = '';
    for (const h of halls) list.appendChild(row(h, live[h.code] || {}));
    renderHelp();
  }

  function row(h, l) {
    const li = document.createElement('li');
    li.className = 'hall-row';
    li.dataset.code = h.code;
    const st = l.stage || null;
    const state = stageState(st);
    li.dataset.state = state;
    const helpOpen = helps.filter((x) => x.code === h.code).length;
    const timeHtml = st && st.text ? esc(st.text) : '--:--';
    const titleHtml = st && st.title ? esc(st.title) : '';
    const displaysHtml = (l.displays || []).map((d) => '<span class="disp-chip" data-ok="' + esc(d.state) + '" title="' + esc(d.words) + '">' + esc(d.mark) + ' ' + esc(d.name) + '</span>').join('');
    li.innerHTML =
      '<a class="hall-open" href="/app.html?' + esc(new URLSearchParams({ code: h.code, as: 'account', role: h.can.post ? 'research' : 'observer' }).toString()) + '">' +
        '<span class="hall-name">' + esc(h.name || h.code) + '</span>' +
        '<span class="hall-code" title="Crew without an account join with this code">' + esc(h.code) + '</span>' +
      '</a>' +
      '<div class="hall-clock" title="' + esc(STATE[state].words) + '">' +
        '<span class="hall-time" style="' + (st && st.color && state !== 'stale' ? 'color:' + esc(st.color) : '') + '">' + timeHtml + '</span>' +
        '<span class="hall-state"><span aria-hidden="true">' + esc(STATE[state].mark) + '</span> ' + esc(STATE[state].words) + (titleHtml ? ' — ' + titleHtml : '') + '</span>' +
      '</div>' +
      '<div class="hall-last">' + (l.last ? '<strong>' + esc(l.last.name) + '</strong> ' + esc(l.last.text) + ' <time>' + esc(AGM.ago(l.last.at)) + '</time>' : '<span class="muted">No messages yet</span>') + '</div>' +
      '<div class="hall-meta">' +
        (canManageHalls ? '<button type="button" class="btn ghost small hall-setup" data-code="' + esc(h.code) + '">Set up</button>' : '') +
        '<span title="People in the hall now">' + esc(String(l.people ?? h.people)) + ' in</span>' +
        (helpOpen ? '<span class="help-count" title="Open help requests">■ ' + esc(String(helpOpen)) + ' need help</span>' : '') +
        displaysHtml +
      '</div>';
    return li;
  }

  // ---------------------------------------------------------------- a hall's set-up: its name and its own Stagewatch
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.hall-setup');
    if (b) openSetup(b.dataset.code);
  });
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
      $('setupStatus').textContent = status ? 'Its own link: ' + status + (r.stagewatch.tls && r.stagewatch.tls.changed ? ' — CERTIFICATE CHANGED' : '') : '';
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
      $('setupDialog').showModal();
    });
  }
  $('setupForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const patch = { code: setupCode, name: $('setupName').value.trim(), stagewatchUrl: $('setupUrl').value.trim(), stagewatchFingerprint: $('setupFp').value.trim() };
    if ($('setupKey').value.trim()) patch.stagewatchKey = $('setupKey').value.trim();
    socket.emit('hall:configure', patch, (r) => {
      if (!r || !r.ok) { $('setupError').textContent = (r && r.error) || 'Not saved.'; $('setupError').hidden = false; return; }
      $('setupDialog').close();
      AGM.toast(r.changed.length ? 'Saved: ' + r.changed.join('; ') : 'Nothing changed.');
      load();
    });
  });
  $('setupAccept').addEventListener('click', () => socket.emit('hall:acceptCertificate', { code: setupCode }, (r) => AGM.toast(r && r.ok ? 'New certificate accepted.' : (r && r.error) || 'Not accepted.', !(r && r.ok))));

  function renderHelp() {
    const strip = $('helpStrip');
    strip.hidden = helps.length === 0;
    const ul = $('helpList');
    ul.textContent = '';
    for (const x of helps) {
      const li = document.createElement('li');
      li.className = 'help-item';
      li.dataset.state = x.state;
      li.innerHTML =
        '<span class="help-where">' + esc(x.hallName || x.code) + '</span>' +
        '<span class="help-what"><strong>' + esc(x.category) + '</strong> ' + esc(x.text) + '</span>' +
        '<span class="help-who">' + esc(x.from) + ' · ' + esc(AGM.ago(x.at)) + (x.by ? ' · ' + esc(x.by) + (x.state === 'coming' ? ' is on the way' : '') : '') + '</span>';
      const open = document.createElement('a');
      open.className = 'btn small';
      open.href = '/app.html?' + new URLSearchParams({ code: x.code, as: 'account', role: 'research' }).toString();
      open.textContent = 'Open hall';
      li.appendChild(open);
      if (x.canRespond) {
        if (x.state === 'open') li.appendChild(button('On my way', () => respond(x, 'coming')));
        li.appendChild(button('Resolved', () => respond(x, 'resolved')));
      }
      ul.appendChild(li);
    }
  }
  function button(text, onclick) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small primary'; b.textContent = text; b.onclick = onclick; return b; }
  function respond(x, state) {
    if (!socket) return;
    socket.emit('help:respond', { code: x.code, messageId: x.id, state }, (r) => { if (!r || !r.ok) AGM.toast((r && r.error) || 'Not sent.', true); });
  }

  // ---------------------------------------------------------------- live (the board over the socket)
  let socket = null;
  function connect() {
    if (typeof io !== 'function') return;
    socket = io({ transports: ['websocket', 'polling'] });
    const ls = $('linkState');
    socket.on('connect', () => {
      ls.dataset.ok = '1'; ls.textContent = '● Live';
      socket.emit('board:watch', {}, (r) => { if (r && r.ok) applyBoard(r.board); else if (r && r.error) AGM.toast(r.error, true); });
    });
    socket.on('disconnect', () => { ls.dataset.ok = '0'; ls.textContent = '○ Reconnecting'; });
    socket.on('board', applyBoard);
    socket.on('account:changed', () => { AGM.toast('Your account was changed — reloading.'); setTimeout(() => location.reload(), 1200); });
  }
  function applyBoard(b) {
    if (!b) return;
    live = {};
    for (const r of b.halls || []) live[r.code] = r;
    helps = b.help || [];
    const known = new Set(halls.map((h) => h.code));
    if ((b.halls || []).some((r) => !known.has(r.code)) || (b.halls || []).length !== halls.length) { load(); return; }
    render();
  }
  // Each Stagewatch sends a frame about every second while it runs, and the board is pushed on every change, so the clock
  // shown is Stagewatch's own words (a calm "12 MIN" stays "12 MIN"), never a guess made here.

  // ---------------------------------------------------------------- account actions
  $('signOutBtn').addEventListener('click', async () => { await AGM.api('POST', '/api/auth/logout'); location.replace('/'); });
  $('passwordBtn').addEventListener('click', () => { $('pwError').hidden = true; $('passwordForm').reset(); $('passwordDialog').showModal(); });
  $('passwordForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const r = await AGM.api('POST', '/api/auth/password', { current: $('pwCurrent').value, next: $('pwNext').value });
    if (!r.ok) { $('pwError').textContent = r.error; $('pwError').hidden = false; return; }
    $('passwordDialog').close();
    AGM.toast('Password saved. Your other devices are signed out.');
  });
  $('newHallBtn').addEventListener('click', () => { $('hallForm').reset(); $('hallDialog').showModal(); });
  $('hallForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const r = await AGM.api('POST', '/api/rooms', { name: $('hallName').value.trim() });
    if (!r.code) { AGM.toast(r.error || 'Not created.', true); return; }
    $('hallDialog').close();
    AGM.toast('Created ' + (r.name || r.code) + ' — code ' + r.code + '.');
    load();
  });

  load().then(connect);
})();
