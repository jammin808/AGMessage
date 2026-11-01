// Admin 0.2: AI minutes, role invites, closing a hall, the AI key and the show network.
// Shares admin.js's globals (socket, currentRoom, escapeHtml) — loaded after it.
/* global socket, currentRoom */
(function () {
  'use strict';
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): nothing asked, nothing polled
  const $ = (id) => document.getElementById(id);
  let wired = false;
  let lastMinutes = '';

  function panel(which) {
    $('roomTools').hidden = !which;
    for (const p of ['invitesPanel', 'minutesPanel', 'closePanel']) $(p).hidden = p !== which;
  }

  /** The settings and health, read; with a patch, changed first (an act: through the outbox, never sent late). */
  function loadSettings(patch) {
    const answered = (s) => {
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
      renderAudit(s.health);
      renderPeers(s.peers || []);
    };
    if (patch) AGM.outbox.now('admin:settings', patch, (s) => { if (s && !s.ok && s.error) alert(s.error); answered(s); });
    else socket.emit('admin:settings', null, answered);
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
    $('deskLine').textContent = t.deskRefusal ? '⚠ Show desk: Stagewatch refuses to hand this AGMessage what it approves (' + t.deskRefusal + ') — proposals are off until it takes this AGMessage\'s collect; give AGMessage a node key of its own.'
      : t.desk ? 'Show desk: Stagewatch keeps the shared approval queue — the backstage team can propose stage messages (📝), and approved "notice" proposals for this AGMessage are shown in every room.' : '';
    $('deskLine').classList.toggle('bad', !!t.deskRefusal);
  }

  /**
   * A show day's peaks in words: "today's peaks: loop delay 3.1 ms, busy 12 %, …". Today is the show day the server names
   * (`showDay`, by the show laptop's clock, not this browser's); before it has a record, the newest day's are shown,
   * named by their date.
   */
  function peaksWords(days, showDay) {
    if (!Array.isArray(days) || !days.length) return '';
    const d = days.find((x) => x && x.day === showDay) || days[days.length - 1];
    const n = (v) => Number(v || 0).toLocaleString();
    const per = d.socketsPerAddress && typeof d.socketsPerAddress === 'object' ? d.socketsPerAddress : {};
    const w = ['loop delay ' + d.loopMs + ' ms', 'busy ' + Math.round(d.elu * 100) + ' %',
      'largest hall ' + n(d.hallMessages) + ' messages (' + n(d.hallKb) + ' KB)', n(d.joinBurst) + ' joins in 5 s',
      n(per.venue) + ' connections from one address', n(d.tunnelSockets) + ' through the tunnel (' + n(per.tunnel) + ' from one network)',
      'refused through the tunnel: ' + refusedWords(d.tunnelRefused)];
    if (d.compactMs && (d.compactMs.max || d.compactMs.messages)) w.push('snapshot ' + d.compactMs.max + ' ms (' + n(d.compactMs.messages) + ' messages)');
    if (d.auditPutMs && d.auditPutMs.count) w.push('audit write p99 ' + d.auditPutMs.p99 + ' ms (max ' + d.auditPutMs.max + ')');
    return (d.day === showDay ? 'today\'s peaks: ' : 'peaks of ' + d.day + ': ') + w.join(', ');
  }

  /**
   * What the tunnel refused, by kind ({full, share, rate, wrongCode, idle}), in the order and the words its card gives
   * them: "4 full, 1 one network's share", or "none".
   */
  function refusedWords(r) {
    const by = r && typeof r === 'object' ? r : {};
    const n = (v) => Number(v || 0).toLocaleString();
    const said = [['full', 'full'], ['share', 'one network\'s share'], ['rate', 'too fast from one network'], ['wrongCode', 'wrong codes'], ['idle', 'never joined']]
      .filter(([k]) => by[k]).map(([k, w]) => n(by[k]) + ' ' + w);
    return said.length ? said.join(', ') : 'none';
  }
  /** The internet link's places and today's refusals: "Internet link: 37 of 150 places · 12 networks · refused today: 4 full". */
  function tunnelWords(t) {
    if (!t || typeof t !== 'object') return '';
    const n = (v) => Number(v || 0).toLocaleString();
    return 'Internet link: ' + n(t.places) + ' of ' + n(t.max) + ' places · ' + n(t.networks) + ' network' + (t.networks === 1 ? '' : 's') +
      ' · refused today: ' + refusedWords(t.refused);
  }

  function renderHealth(h) {
    if (!h) return;
    $('tunnelPlaces').textContent = tunnelWords(h.tunnel);
    const parts = [];
    parts.push(h.restarts ? 'restarted by the watchdog ' + h.restarts + '×' : 'running since start');
    if (h.watchdog) parts.push('⚠ the watchdog gave up at ' + new Date(h.watchdog.at).toLocaleTimeString() + ': ' + h.watchdog.reason);
    if (h.lastCrash) parts.push('last crash ' + new Date(h.lastCrash.at).toLocaleString() + ': ' + h.lastCrash.message);
    if (h.rejections) parts.push(h.rejections + ' failed background task(s)');
    if (h.loopMs && h.loopMs.count) parts.push('loop delay p95 ' + h.loopMs.p95 + ' ms (max ' + h.loopMs.max + ')' + (h.elu && h.elu.count ? ' · busy ' + Math.round(h.elu.p95 * 100) + ' %' : ''));
    const peaks = peaksWords(h.peaks, h.showDay);
    if (peaks) parts.push(peaks);
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

  // ---------------------------------------------------------------- the audit log on Health
  // Whether this page is the laptop's own token, signed in by this run: only it is offered Accept, which takes the token
  // typed again. Anyone else the admin page admits is told where to accept.
  let tokenHere = false;
  let canExport = false;   // an account holding audit.export (with audit.read): Export, never Accept
  let theAdmin = false;    // the laptop's token, or an account whose role is admin: Split the audit log…
  let lastHealth = null;
  fetch('/api/admin/me').then((r) => r.json()).then((me) => { tokenHere = !!(me && me.token); theAdmin = !!(me && me.admin); if (lastHealth) renderAudit(lastHealth); }).catch(() => { /* no Accept or Split offered */ });
  fetch('/api/auth/me').then((r) => r.json()).then((me) => {
    const caps = me && me.account && me.account.rights ? me.account.rights.caps : [];
    canExport = caps.includes('audit.export') && caps.includes('audit.read');
    if (lastHealth) renderAudit(lastHealth);
  }).catch(() => { /* no Export offered to an account */ });
  const pad2 = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "18:40 on 26 Oct", by this laptop's clock. */
  const at = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' on ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; };
  /** Health's "Last export": the newest export sent whole that the log's newest file holds (answer 3: one each show day). */
  const lastExportWords = (x) => (x && x.to
    ? 'Last export: entries ' + x.from + '–' + x.to + ', sent whole at ' + at(x.at) + ' (' + x.by + '). Export at the end of each show day.'
    : 'No export in the log\'s newest file: export at the end of each show day.');
  const SHAPE = { intact: '✓', linked: '◇', unvouched: '△', broken: '✕' };
  const RANK = { intact: 0, linked: 1, unvouched: 2, broken: 3 };
  /** The first keyed start's question about the older entries, asked of the person at the laptop. */
  const question = (f) => f.words.replace(/, and nothing vouches for them until they are accepted$/, '') + '; anyone who could write this folder could have rewritten them. If this log has been in your hands, accept them.';
  function renderAudit(h) {
    const a = h && h.saves && h.saves.stores && h.saves.stores.audit;
    if (!a) return;
    lastHealth = h;
    const list = Array.isArray(a.attention) ? a.attention : [];
    let mark = 'intact';
    for (const f of list) if (RANK[f.mark] > RANK[mark]) mark = f.mark;
    $('auditLine').dataset.mark = mark;
    // After a split the check starts at its archive point, and names each archive (H.11).
    const from = a.from > 1 ? ' · from entry ' + a.from + ', ' + a.archives + ' archive' + (a.archives === 1 ? '' : 's') : '';
    $('auditLine').textContent = 'Audit log: ' + SHAPE[mark] + ' ' + (a.keyless ? 'not keyed this run' : 'keyed (key ' + a.kid + ')') + from + (list.length ? ' · ' + list.length + ' to see to' : ' · nothing to accept') + (a.headLag > 1 ? ' · head ' + a.headLag + ' entries behind' : '');
    const ul = $('auditFindings');
    ul.textContent = '';
    for (const f of list) {
      const li = document.createElement('li');
      li.dataset.mark = SHAPE[f.mark] ? f.mark : 'broken';
      li.textContent = (SHAPE[f.mark] || '✕') + ' ' + (f.first ? question(f) : f.words);
      ul.appendChild(li);
    }
    // A check broken at a line is never accepted, and nothing else is while it stands.
    const acceptable = list.some((f) => f.id && f.id !== 'more') && !list.some((f) => f.kind === 'broken');
    $('auditAcceptRow').hidden = !(acceptable && tokenHere);
    $('auditWhere').hidden = !(acceptable && !tokenHere);
    // The signing key in full, which the crew copies into the show's paperwork; Export for the token or an account with the right.
    $('auditSignKey').hidden = !a.signKey;
    $('signKeyText').textContent = a.signKey ? a.signKey.match(/.{4}/g).join(' ') : '—';
    $('auditLastExport').textContent = a.keyless ? 'No export this run: it has no machine key to sign one with.' : lastExportWords(a.lastExport);
    $('auditExportRow').hidden = !(a.signKey && (tokenHere || canExport));
    $('auditSplitRow').hidden = !(theAdmin && !a.keyless);
  }

  // ---------------------------------------------------------------- the split (the admin)
  // The archive points in the live log, newest first, each with what a split there would move or why it would not; a
  // split a stop left part way is offered as Finish the split. The word typed is the confirmation.
  let splitAt = 0;
  const say = (mark, text) => { $('splitState').dataset.mark = mark; $('splitState').textContent = text; };
  async function openSplit() {
    say('', '');
    $('splitWord').value = '';
    splitAt = 0;
    const ul = $('splitList');
    ul.textContent = 'Reading the archive points…';
    $('splitFinishRow').hidden = true;
    AGM.openDialog($('splitDialog'));
    const r = await fetch('/api/audit/split').then((x) => x.json()).catch(() => null);
    ul.textContent = '';
    if (!r || !r.ok) { ul.textContent = (r && r.error) || 'No answer from the server.'; return; }
    if (r.unfinished) {
      $('splitFinishRow').hidden = false;
      $('splitFinish').textContent = 'Finish the split at entry ' + r.unfinished.seq;
    }
    for (const p of r.points) {
      const li = document.createElement('li');
      const label = document.createElement('label'); label.className = 'check';
      const box = document.createElement('input'); box.type = 'radio'; box.name = 'splitPoint'; box.value = String(p.seq); box.disabled = !!p.why;
      const words = document.createElement('span');
      words.textContent = 'Entry ' + p.seq + (p.event ? ' · “' + p.event + '”' : ' · ' + p.name) + ', archived ' + at(p.at) + ': entries ' + p.from + '–' + p.to + ' move into a signed archive';
      label.append(box, words);
      li.appendChild(label);
      if (p.why) { const why = document.createElement('span'); why.className = 'why'; why.textContent = p.why; li.appendChild(why); }
      box.addEventListener('change', () => { if (box.checked) splitAt = p.seq; });
      ul.appendChild(li);
    }
    if (!r.points.length) ul.textContent = 'No archive point in the live log yet: archiving an event writes one.';
  }
  async function postSplit(seq) {
    say('', 'Splitting… the files before the point are moved into the archive and signed.');
    const r = await fetch('/api/audit/split', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq }) }).then((x) => x.json()).catch(() => ({ ok: false, error: 'No answer from the server.' }));
    // A split that waits (a file held, or its entry not on disk yet) is △ with its words, never ✓ and never "Not split".
    if (!r.ok && !r.waits) { say('broken', '✕ ' + (r.error || 'Not split.')); return; }
    say(r.waits ? 'unvouched' : 'intact', r.waits ? '△ ' + (r.words || r.error) : r.words);
    setTimeout(() => loadSettings(), 300);
  }
  let shown = null;   // the check the dialog was drawn from: its digest goes with the Accept
  async function openAccept() {
    $('acceptError').hidden = true;
    $('acceptToken').value = '';
    const ul = $('acceptList');
    ul.textContent = 'Checking the whole log…';
    AGM.openDialog($('acceptDialog'));
    const r = await fetch('/api/audit/verify').then((x) => x.json()).catch(() => null);
    ul.textContent = '';
    if (!r || !Array.isArray(r.findings)) { ul.textContent = 'The log could not be checked: ' + ((r && r.error) || 'no answer'); return; }
    if (r.why) { ul.textContent = '✕ ' + r.words + ' — a broken entry cannot be accepted.'; return; }
    shown = r;
    let used = 0;   // characters of the accept's target the ticked ids take (it holds 80)
    for (const f of r.findings) {
      const li = document.createElement('li');
      li.dataset.mark = SHAPE[f.mark] ? f.mark : 'broken';
      if (f.held) { li.textContent = (SHAPE[f.mark] || '✕') + ' ' + f.words + ' — not on disk yet; it can be accepted once it is'; ul.appendChild(li); continue; }
      const label = document.createElement('label'); label.className = 'check';
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.id = f.id;
      const shape = document.createElement('span'); shape.textContent = SHAPE[f.mark] || '✕';
      const words = document.createElement('span'); words.textContent = f.first ? question(f) : f.words;
      label.append(box, shape, words);
      li.appendChild(label);
      // △ starts ticked while the target has room; ✕ starts unticked, and ticking it asks for its own confirmation.
      if (f.mark !== 'broken' && used + f.id.length + 1 <= 81) { box.checked = true; used += f.id.length + 1; }
      if (f.mark === 'broken') {
        const line = document.createElement('label'); line.className = 'check confirm-line'; line.hidden = true;
        const sure = document.createElement('input'); sure.type = 'checkbox'; sure.dataset.confirm = f.id;
        // An archive no longer here, or not what was split off (H.10.5): its entries cannot be checked on this laptop again,
        // and the older archives it named (by its range, which begins after entry 1) are out of reach with it.
        const arc = f.kind === 'archive' && Array.isArray(r.archives) ? r.archives.find((a) => a.finding === f.id) : null;
        const older = arc && arc.from > 1 ? ' Entries 1–' + (arc.from - 1) + ' are in an older archive this one named: Accounts then lists it as not reached from the live log, with its own Check.' : '';
        const say = document.createElement('span'); say.textContent = f.kind === 'archive'
          ? 'Accept that ' + f.words + '? From now on it reads ◇ here, and its entries cannot be checked on this laptop again. Keep it, or an export that holds it, where it went.' + older
          : 'Accept that ' + f.words + '? From now on it reads ◇, and what it names cannot be brought back.';
        line.append(sure, say);
        li.appendChild(line);
        box.addEventListener('change', () => { line.hidden = !box.checked; if (!box.checked) sure.checked = false; });
      }
      box.addEventListener('change', () => {
        const ids = [...ul.querySelectorAll('input[data-id]:checked')].map((x) => x.dataset.id);
        if (ids.join(',').length > 80) { box.checked = false; box.dispatchEvent(new Event('change')); $('acceptMore').hidden = false; }
      });
      ul.appendChild(li);
    }
    $('acceptMore').hidden = r.findings.filter((f) => !f.held).map((f) => f.id).join(',').length <= 80;
    if (!r.findings.length) ul.textContent = 'Nothing is open: ' + r.words;
    $('acceptToken').focus();
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
            AGM.outbox.now('nodes:acceptCertificate', { id: l.id, fingerprint: typed.trim() }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not accepted.'); loadNodes(); });
          };
          li.appendChild(acc);
        }
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.type = 'button'; b.textContent = 'Unlink';
        b.onclick = () => { if (confirm('Unlink ' + l.name + '? Its token and its certificate pin are forgotten.')) AGM.outbox.now('nodes:unlink', { id: l.id }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not unlinked.'); loadNodes(); }); };
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
    AGM.outbox.now('nodes:link', { id: p.id, token, hall: hall.trim(), fingerprint: fingerprint.trim() }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not linked.'); loadNodes(); });
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
    $('auditAcceptBtn').onclick = () => { openAccept(); };
    $('acceptCancel').onclick = () => { $('acceptDialog').close(); };
    $('acceptForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ul = $('acceptList');
      const ids = [...ul.querySelectorAll('input[data-id]:checked')].map((x) => x.dataset.id);
      const confirm = [...ul.querySelectorAll('input[data-confirm]:checked')].map((x) => x.dataset.confirm);
      const err = $('acceptError');
      if (!shown || !ids.length) { err.textContent = 'Tick what to accept.'; err.hidden = false; return; }
      const r = await fetch('/api/audit/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('acceptToken').value.trim(), digest: shown.digest, ids, confirm }) }).then((x) => x.json()).catch(() => ({ ok: false, error: 'No answer from the server.' }));
      if (!r.ok) { err.textContent = r.error || 'Not accepted.'; err.hidden = false; return; }
      $('acceptDialog').close();
      $('auditLine').textContent = r.head === 'saved' ? 'Accepted: written in the log (entry ' + r.entry + ').' : (r.words || 'Not accepted yet.');
      setTimeout(() => loadSettings(), 300);
    });
    $('ctxCopy').onclick = () => { const t = $('ctxToken').textContent; if (navigator.clipboard && t && t !== '—') navigator.clipboard.writeText(t); };
    $('signKeyCopy').onclick = () => { const t = $('signKeyText').textContent; if (navigator.clipboard && t && t !== '—') navigator.clipboard.writeText(t); };
    $('auditSplitBtn').onclick = () => { openSplit(); };
    $('splitCancel').onclick = () => { $('splitDialog').close(); };
    $('splitFinish').onclick = () => { const t = /entry (\d+)$/.exec($('splitFinish').textContent); if (t) postSplit(Number(t[1])); };
    $('splitForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!splitAt) { say('broken', 'Choose the archive point to split at.'); return; }
      if ($('splitWord').value.trim().toLowerCase() !== 'split') { say('broken', 'Type the word split to split there.'); return; }
      postSplit(splitAt);
    });
    $('auditExportBtn').onclick = () => {
      const fp = lastHealth && lastHealth.saves.stores.audit.signKey;
      window.AGMAuditExport.open({ fingerprint: fp, done: () => { setTimeout(() => loadSettings(), 300); } });
    };
    $('ctxNew').onclick = () => loadSettings({ newContextToken: true });
    $('requireHttps').onchange = () => loadSettings({ requireHttps: $('requireHttps').checked });
    $('remoteAdmin').onchange = () => loadSettings({ remoteAdmin: $('remoteAdmin').checked });
    $('swAccept').onclick = () => {
      if (!confirm('Accept Stagewatch\'s new certificate? Only do this if you know why it changed (a reinstall, a new certificate made on purpose).')) return;
      AGM.outbox.now('admin:acceptCertificate', undefined, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not accepted.'); setTimeout(() => loadSettings(), 800); });
    };
    $('tlsRenew').onclick = () => {
      if (!confirm('Make a new certificate? Every device and app that trusted the old one will need to trust the new one.')) return;
      AGM.outbox.now('admin:renewCertificate', undefined, (r) => { if (!r || !r.ok) alert((r && r.error) || 'No new certificate.'); loadSettings(); });
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
      AGM.outbox.now('admin:lockRoles', { roomCode: currentRoom.code, on: $('lockRoles').checked }, (res) => { if (!res || !res.ok) alert((res && res.error) || 'Not changed.'); showInvites(res && res.locked); });
    };
    function showInvites(on) {
      const box = $('inviteLinks');
      box.textContent = '';
      if (!on) { box.textContent = 'Open: anyone with the code can join in any seat.'; return; }
      socket.emit('admin:invites', { roomCode: currentRoom.code }, (res) => {
        if (!res || !res.ok) return;
        for (const role of ['board', 'research']) {
          const url = location.origin + res.invites[role];
          const row = document.createElement('div');
          row.className = 'invite-row';
          const lab = document.createElement('strong'); lab.textContent = role === 'board' ? 'On stage link' : 'Backstage link';
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
      AGM.outbox.now('admin:postSummary', { roomCode: currentRoom.code, text: '📝 Minutes so far (AI draft, posted by the admin)\n\n' + lastMinutes }, (r) => { if (!r || !r.ok) alert((r && r.error) || 'Not posted.'); else panel(null); });
    };
    $('closeMinutesBtn').onclick = () => panel(null);

    $('closeRoomBtn').onclick = () => { if (currentRoom) { $('closeCode').textContent = currentRoom.code; panel('closePanel'); } };
    $('cancelCloseBtn').onclick = () => panel(null);
    $('confirmCloseBtn').onclick = () => {
      AGM.outbox.now('admin:deleteRoom', { roomCode: currentRoom.code, purgeFiles: $('purgeFiles').checked }, (res) => {
        if (!res || !res.ok) { alert((res && res.error) || 'Not closed.'); return; }
        panel(null);
        location.reload();
      });
    };
  }
  const t = setInterval(() => { wire(); if (wired) clearInterval(t); }, 300);
})();
