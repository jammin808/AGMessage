// The admin page's other parts: AI minutes, role invites, the AI key, the show network's links, HTTPS, Health and the
// audit log there, and "This laptop". Shares admin.js's globals (socket, currentRoom, the page's acts ADMIN and their runners ADMIN_RUN) —
// loaded after it. A link's acts are the catalogue's (kind link); nothing here opens a native dialog.
/* global socket, currentRoom, ADMIN, ADMIN_RUN, ADMIN_DRAWERS, ADMIN_OBJECTS, ADMIN_EVENT, KEPT_READ_MS, adminFactsChanged, say, watchRoom */
(function () {
  'use strict';
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): nothing asked, nothing polled
  const $ = (id) => document.getElementById(id);
  let wired = false;
  let lastMinutes = '';

  function panel(which) {
    $('roomTools').hidden = !which;
    for (const p of ['invitesPanel', 'minutesPanel']) $(p).hidden = p !== which;
  }

  // A field of the Stagewatch form that a person typed in, or that Use this address filled, keeps its words until they
  // are saved: the settings read every 5 s fill only a field nobody has changed (and none while it has the focus).
  const edited = new Set();
  for (const id of ['swUrl', 'swFp']) $(id).addEventListener('input', () => edited.add(id));
  const fill = (id, value) => { if (!edited.has(id) && document.activeElement !== $(id)) $(id).value = value; };

  /**
   * The settings and health, read; with a patch, changed first (an act: through the outbox, never sent late), and
   * `saved(s)` told when the server took it.
   */
  function loadSettings(patch, saved) {
    const answered = (s) => {
      if (!s || !s.ok) return;
      $('aiModel').textContent = s.model;
      $('aiStatus').textContent = s.aiKeySet ? (s.aiFromEnv ? 'on (key from ANTHROPIC_API_KEY)' : 'on') : 'off — no key';
      adminFactsChanged({ ai: !!s.aiKeySet });
      fill('swUrl', s.stagewatchUrl || '');
      stagewatch = { url: s.stagewatchUrl || '', changed: !!(s.tls && s.tls.link && s.tls.link.changed), keySet: !!s.stagewatchKeySet, fingerprint: s.stagewatchFingerprint || '' };
      $('swKey').placeholder = s.stagewatchKeySet ? '•••••• (saved — type to replace)' : 'Stagewatch node key (swk_…)';
      const clock = s.health && s.health.clock;
      $('swStatus').textContent = s.stagewatchUrl ? 'Stagewatch: ' + s.stage + (clock && clock.apart ? ' · CLOCKS APART (' + (clock.offsetMs / 1000).toFixed(1) + ' s)' : '') : '';
      const keyState = s.health && s.health.stageKey ? s.health.stageKey.state : '';
      $('swStatus').classList.toggle('bad', !!(clock && clock.apart) || keyState === 'refused');
      const ctx = s.stageContext;
      $('swContext').hidden = !ctx;
      if (ctx) $('swContext').textContent = 'Stagewatch says: ' + (ctx.headline || '') + ((ctx.peers || []).length ? ' · it hears ' + ctx.peers.map((p) => p.t + ' “' + (p.name || '') + '”').join(', ') : '');
      $('ctxToken').textContent = s.contextToken || '—';
      // A saved token this run cannot open is kept, not replaced: why none answers, until New token makes one.
      $('ctxWhy').textContent = s.contextTokenWhy || '';
      $('ctxWhy').hidden = !s.contextTokenWhy;
      renderTls(s.tls, s.stagewatchFingerprint);
      $('remoteAdmin').checked = !!s.remoteAdmin;
      // Accounts held aside or waiting for the token: their words and where to go, never "No accounts yet".
      const held = s.held && s.held.state !== 'left' ? s.held : null;
      $('acctCount').textContent = held ? heldMark(held.state) + ' ' + held.words + (HELD_ASIDE.has(held.state) || held.state === 'first' ? ' Admin → Accounts held aside, with the token at the AGMessage laptop.' : '')
        : s.accounts ? s.accounts + ' account' + (s.accounts === 1 ? '' : 's') : 'No accounts yet — make the first admin on the start page, with the token';
      $('buildLine').textContent = s.build ? 'This is AGMessage ' + s.build + '.' : '';
      AGM.reconnect.build.heard(s.build);
      drawBuild();
      renderHealth(s.health);
      renderSignins(s.health);
      renderAudit(s.health);
      renderLaptop(s.laptop);
      renderPeers(s.peers || []);
      drawLinks();
    };
    if (patch) AGM.outbox.now('admin:settings', patch, (s) => { if (s && !s.ok && s.error) say(s.error, true); if (s && s.ok && saved) saved(s); answered(s); });
    else socket.emit('admin:settings', null, answered);
  }

  /**
   * On another build than its server's, the admin page reloads only when its admin agrees (Reload this page): it may hold
   * a form half filled, which a reload would lose. The words name both builds whichever is newer (a Go back runs an older
   * one), and say so when this tab reloaded for that build already and did not come back on it. A reload goes only while
   * the page is connected: one asked of a server it cannot reach would leave a browser's error page in its place.
   */
  function drawBuild() {
    const st = AGM.reconnect.build.state();
    $('buildStrip').hidden = !st.stale || st.reloading;
    if (!st.stale) return;
    const words = 'AGMessage now runs ' + st.server + ', and this page is still on ' + st.mine + '. ' +
      (st.tried ? 'Reloading did not bring it over: reload it again, or from the browser without its cache (Ctrl+F5).' : 'Reload it when nothing you are typing here would be lost.');
    // Said once: the settings come every 5 s, and a status region says again whatever is written into it.
    if ($('buildWords').textContent !== words) $('buildWords').textContent = words;
  }
  $('buildReload').addEventListener('click', () => {
    if (!socket || !socket.connected) { AGM.toast(AGM.catalog.WORDS.offline, true); return; }
    if (!AGM.reconnect.build.reload(true)) drawBuild();
  });

  function pretty(fp) { return fp ? fp.replace(/^sha256:/, '').match(/../g).join(':').toUpperCase() : '—'; }
  function renderTls(t, typed) {
    if (!t) return;
    $('tlsFp').textContent = t.on ? pretty(t.fingerprint) : 'HTTPS is off' + (t.off ? ': ' + t.off : '');
    $('tlsValid').textContent = t.on && t.validTo ? '(valid until ' + t.validTo + ')' : '';
    $('tlsRenew').hidden = !t.on;
    $('requireHttps').checked = !!t.requireHttps;
    $('requireHttps').disabled = !t.on;
    fill('swFp', typed || '');
    const l = t.link || {};
    $('swTls').textContent = !l.on ? 'Link to Stagewatch: plain HTTP (it announces no certificate)'
      : l.problem ? AGM.mark('couldNot') + ' ' + l.problem
      : 'Link to Stagewatch: encrypted ' + AGM.mark('ok') + ' — certificate ' + pretty(l.fp).slice(0, 23) + '… ' + (l.pinned ? '(pinned)' : '(pinned once Stagewatch accepts the key)');
    $('swTls').classList.toggle('bad', !!l.problem);
    $('deskLine').textContent = t.deskRefusal ? AGM.mark('couldNot') + ' Show desk: Stagewatch refuses to hand this AGMessage what it approves (' + t.deskRefusal + ') — proposals are off until it takes this AGMessage\'s collect; give AGMessage a node key of its own.'
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
    if (d.sleeps) w.push('asleep ' + n(d.sleeps) + (d.sleeps === 1 ? ' time' : ' times') + ' (the longest ' + Math.max(1, Math.round(Number(d.sleptMs || 0) / 60000)) + ' min)');
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
    eventMoved(h.event);
    $('tunnelPlaces').textContent = tunnelWords(h.tunnel);
    const parts = [];
    parts.push(h.restarts ? 'restarted by the watchdog ' + h.restarts + '×' : 'running since start');
    if (h.watchdog) parts.push(AGM.mark('couldNot') + (h.watchdog.refused ? ' the start before this one was refused at ' : ' the watchdog gave up at ') + new Date(h.watchdog.at).toLocaleTimeString() + ': ' + h.watchdog.reason);
    if (h.lastCrash) parts.push('last crash ' + new Date(h.lastCrash.at).toLocaleString() + ': ' + h.lastCrash.message);
    if (h.rejections) parts.push(h.rejections + ' failed background task(s)');
    if (h.loopMs && h.loopMs.count) parts.push('loop delay p95 ' + h.loopMs.p95 + ' ms (max ' + h.loopMs.max + ')' + (h.elu && h.elu.count ? ' · busy ' + Math.round(h.elu.p95 * 100) + ' %' : ''));
    const peaks = peaksWords(h.peaks, h.showDay);
    if (peaks) parts.push(peaks);
    // The power request a live show holds: said while a hall is live ("This laptop" says the rest).
    const pw = h.power;
    if (pw && pw.state === 'held') parts.push('kept awake while ' + pw.live + (pw.live === 1 ? ' hall is' : ' halls are') + ' live');
    else if (pw && (pw.state === 'refused' || pw.state === 'failed')) parts.push(AGM.mark('couldNot') + ' not kept awake: ' + pw.why);
    if (h.stageRttMs && h.stageRttMs.count) parts.push('send-to-stage ' + h.stageRttMs.p50 + ' ms typical, ' + h.stageRttMs.max + ' worst');
    if (h.clock) parts.push('clock vs Stagewatch ' + (h.clock.offsetMs >= 0 ? '+' : '') + h.clock.offsetMs + ' ms' + (h.clock.apart ? ' — CLOCKS APART' : ''));
    // Each store that could not be saved, by name: what it holds is kept and tried again until it is on disk.
    const stores = (h.saves && h.saves.stores) || {};
    for (const [name, st] of Object.entries(stores)) {
      if (st && st.error) parts.push(AGM.mark('couldNot') + ' ' + name + ' save failed (kept, tried again): ' + st.error);
      else if (st && st.unwritten) parts.push(AGM.mark('couldNot') + ' ' + st.unwritten + ' ' + name + ' entries not yet on disk');
    }
    if (h.desk && h.desk.waiting) {
      const n = h.desk.waiting;
      const last = h.desk.lastStatus === null ? '' : h.desk.lastStatus ? 'last answer ' + h.desk.lastStatus : 'no answer to the last try';
      const next = h.desk.nextInMs === null ? 'tried once its Stagewatch is linked and keeps a desk' : 'next try in ' + Math.round(h.desk.nextInMs / 1000) + ' s';
      parts.push(AGM.mark('waiting') + ' ' + n + ' show-desk result' + (n === 1 ? '' : 's') + ' waiting for Stagewatch to take ' + (n === 1 ? 'it' : 'them') + ' (' + [last, next].filter(Boolean).join(', ') + ')');
    }
    if (h.tls && h.tls.link && h.tls.link.changed) parts.push(AGM.mark('fault') + ' CERTIFICATE CHANGED — Stagewatch\'s certificate is not the one pinned; the link is refused until you accept it');
    // The data folder was last written by a newer build of its format: this one serves it (This laptop says the rest).
    if (h.format && h.format.newer === true) parts.push(AGM.mark('couldNot') + ' the data folder was last written by a newer build, ' + h.format.before + ': this one reads its format and writes it now');
    $('healthLine').textContent = parts.join(' · ');
  }

  // ---------------------------------------------------------------- the audit log on Health
  // Whether this page is the laptop's own token, signed in by this run: only it is offered Accept, which takes the token
  // typed again. Anyone else the admin page admits is told where to accept.
  let tokenHere = false;
  let canExport = false;   // an account holding audit.export (with audit.read): Export, never Accept
  let theAdmin = false;    // the laptop's token, or an account whose role is admin: Split the audit log…
  let lastHealth = null;
  fetch('/api/admin/me').then((r) => r.json()).then((me) => {
    tokenHere = !!(me && me.token); theAdmin = !!(me && me.admin);
    if (lastHealth) renderAudit(lastHealth);
    heldSeen(me && me.held ? me.held : null);
  }).catch(() => { /* no Accept or Split offered, and the panel not drawn */ });
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
  // The audit log's marks, each one of the one table: intact ✓; linked ◇ (accepted on this laptop, and not checkable under
  // its key: reached, not seen into); unvouched △; broken ✕.
  const SHAPE = { intact: AGM.mark('ok'), linked: AGM.mark('unseen'), unvouched: AGM.mark('couldNot'), broken: AGM.mark('fault') };
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
      li.textContent = (SHAPE[f.mark] || SHAPE.broken) + ' ' + (f.first ? question(f) : f.words);
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

  // ---------------------------------------------------------------- accounts held aside (the token at the laptop)
  // The states a store can be in, by the mark each draws (AGM.MARKS by name): △ waits or loads, ✕ held aside, ended or
  // missing. Health's lines name each store that is not ok; the panel is the token's at the laptop.
  const STATE_MARK = Object.freeze({ keyless: 'couldNot', unread: 'couldNot', behind: 'couldNot', unrecorded: 'couldNot', first: 'couldNot', failing: 'couldNot',
    changed: 'fault', older: 'fault', other: 'fault', elsewhere: 'fault', plain: 'fault', missing: 'fault', ended: 'fault', left: 'couldNot' });
  const HELD_ASIDE = new Set(['changed', 'older', 'other', 'elsewhere', 'plain']);
  const heldMark = (state) => AGM.mark(STATE_MARK[state] || 'couldNot');
  // The server's words are clauses (the console's lines); a sentence follows them on the page.
  const sentence = (w) => (/[.!?]$/.test(w) ? w : w + '.');
  const AUDIT_TONE = { couldNot: 'unvouched', fault: 'broken' };
  const STORE_NAMES = Object.freeze({ accounts: 'Accounts', sessions: 'Account sign-ins', adminSessions: 'Token sign-ins', record: 'The record of the saves' });
  /** Health's lines of the accounts and sign-ins: each whose words say something, with its mark. */
  function renderSignins(h) {
    const si = h && h.signins;
    if (!si) return;
    const ul = $('signinLines');
    ul.textContent = '';
    for (const k of ['accounts', 'sessions', 'adminSessions', 'record']) {
      const x = si[k];
      if (!x || !x.words) continue;
      const li = document.createElement('li');
      const name = STATE_MARK[k === 'accounts' && x.held && x.state === 'ok' ? 'left' : x.state] || 'couldNot';
      li.dataset.mark = AUDIT_TONE[name] || '';
      li.textContent = AGM.mark(name) + ' ' + STORE_NAMES[k] + ': ' + x.words;
      ul.appendChild(li);
    }
  }
  let heldFacts = null;     // /api/admin/me's `held`
  let heldNow = null;       // the copy held aside as GET /api/accounts/held answered it
  let heldListed = false;   // the list is drawn (at once for a hold, after Adopt more… for those left out)
  const heldTicks = new Map();   // ref -> {adopt, reset, confirm, keep}
  const MARK_WORDS = Object.freeze({ saved: 'as this laptop last saved it', changed: 'changed since', new: 'new to this laptop' });
  /** /api/admin/me's `held`: anyone else the page admits is told where to go; the token at this laptop gets the panel. */
  function heldSeen(h) {
    heldFacts = h;
    const where = $('heldWhere');
    const opens = !!h && (HELD_ASIDE.has(h.state) || h.state === 'first' || h.state === 'left');
    where.hidden = !opens || tokenHere;
    if (opens && !tokenHere) {
      where.dataset.mark = AUDIT_TONE[STATE_MARK[h.state]] || '';
      putText(where, heldMark(h.state) + ' ' + sentence(h.words) + ' Open them at the AGMessage laptop: sign in there with its token (Admin login in the AGMessage window; installed: Start → AGMessage → Show the admin token), then Admin → Accounts held aside.');
    }
    $('heldSection').hidden = !(opens && tokenHere);
    if (!(opens && tokenHere)) return;
    heldListed = h.state !== 'left';
    if (heldListed) loadHeld(); else drawHeld();
  }
  async function loadHeld() {
    const r = await AGM.api('GET', '/api/accounts/held');
    heldNow = r && r.ok ? r : null;
    heldTicks.clear();
    if (heldNow) for (const a of heldNow.accounts) heldTicks.set(a.ref, { adopt: !!a.adopt, reset: !!a.reset, confirm: false, keep: false });
    if (!heldNow) putText($('heldWhy'), AGM.mark('fault') + ' ' + ((r && r.error) || 'The copy held aside could not be read.'));
    drawHeld();
  }
  const rowOf = (ref) => (heldNow ? heldNow.accounts.find((a) => a.ref === ref) || null : null);
  const tickOf = (ref) => heldTicks.get(ref) || { adopt: false, reset: false, confirm: false, keep: false };
  /** The panel as the catalogue reads it (kind accounts). */
  function heldObject() {
    const rows = heldNow ? heldNow.accounts : [];
    const ticked = rows.filter((a) => tickOf(a.ref).adopt);
    const resets = ticked.filter((a) => tickOf(a.ref).reset);
    const mode = heldNow ? heldNow.mode : heldFacts && heldFacts.state === 'left' ? 'left' : heldFacts && heldFacts.state === 'first' ? 'first' : 'aside';
    return {
      mode, listed: heldListed && !!heldNow, ticked: ticked.length, file: heldNow ? heldNow.file : 'the copy held aside',
      unusable: heldNow ? !!heldNow.unusable : !!(heldFacts && heldFacts.unusable),
      tickedWords: ticked.length ? 'Adopt ' + ticked.map((a) => a.username).join(', ') + (resets.length ? ', with a one-time password for ' + resets.map((a) => a.username).join(', ') : '') + '.' : '',
    };
  }
  /** One account of the copy as the catalogue reads it (kind heldAccount). */
  function heldRowObject(ref) {
    const a = rowOf(ref);
    if (!a) return null;
    const t = tickOf(ref);
    return { ref, username: a.username, adopt: t.adopt, reset: t.reset };
  }
  /** A tick changed, by its box or by the account's menu: the row's lines drawn again in step. */
  function setTick(ref, change) {
    heldTicks.set(ref, { ...tickOf(ref), ...change });
    drawHeld();
  }
  function heldLine(text, box, onChange) {
    const label = document.createElement('label'); label.className = 'check confirm-line';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = box;
    input.addEventListener('change', () => onChange(input.checked));
    const words = document.createElement('span'); words.textContent = text;
    label.append(input, words);
    return label;
  }
  /** An account's row by its key, made once: its box, its name, its two lines of words and its bar. */
  function heldRowOf(ul, ref) {
    const had = [...ul.children].find((li) => li.dataset.key === ref);
    if (had) return had;
    const li = document.createElement('li'); li.dataset.key = ref; li.tabIndex = 0;
    const who = document.createElement('div'); who.className = 'adopt-who';
    const label = document.createElement('label'); label.className = 'check';
    const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.adopt = ref;
    box.addEventListener('change', () => setTick(ref, { adopt: box.checked, confirm: box.checked ? tickOf(ref).confirm : false }));
    label.append(box, document.createElement('strong'));
    const what = document.createElement('span'); what.className = 'adopt-what';
    const facts = document.createElement('span'); facts.className = 'adopt-what';
    const bar = document.createElement('span'); bar.className = 'obj-bar';
    who.append(label, what, facts, bar);
    li.appendChild(who);
    return li;
  }
  /** A row's part by its name (`repeated`, `confirm`, `reset`, `keep`), made once by `make`: its words drawn again in place. */
  function heldPart(li, name, make, text) {
    const el = [...li.children].find((x) => x.dataset.line === name) || make();
    el.dataset.line = name;
    putText(el.matches('label') ? el.querySelector('span') : el, text);
    return el;
  }
  /** A row's tick line by its name: made once, its words and its tick drawn again in place. */
  function heldTick(li, name, text, ticked, onChange) {
    const label = heldPart(li, name, () => { const l = heldLine(text, ticked, onChange); if (name === 'reset') l.classList.remove('confirm-line'); return l; }, text);
    const input = label.querySelector('input');
    if (input.checked !== ticked) input.checked = ticked;
    return label;
  }
  /** An account's row drawn again in place: its words, its box, and the lines it has now, in their order; then its bar. */
  function drawHeldRow(li, a, t) {
    const who = li.querySelector(':scope > .adopt-who');
    const box = who.querySelector('input[data-adopt]');
    if (box.checked !== t.adopt) box.checked = t.adopt;
    putText(who.querySelector('strong'), 'Adopt ' + a.username);
    const [what, facts] = who.querySelectorAll(':scope > .adopt-what');
    const rights = a.rights || {};
    const halls = a.allHalls || rights.allHalls ? 'every hall' : (rights.halls || a.halls || []).join(' ') || 'no hall';
    putText(what, [a.name, rights.roleLabel || a.role, halls, a.disabled ? 'turned off' : '', a.mustChange ? 'must change its password' : '', MARK_WORDS[a.mark] || '', a.repeated ? 'repeated' : ''].filter(Boolean).join(' · '));
    // What it may do, read from the copy (rbac.rightsView), and when it was made, last signed in and set its password.
    const when = (at) => (at ? new Date(at).toLocaleDateString() : 'never');
    putText(facts, 'Rights: ' + ((rights.caps || []).join(', ') || 'none') + ' · made ' + when(a.createdAt) + ' · last sign-in ' + when(a.lastLoginAt) + ' · password set ' + when(a.pwSetAt));
    const ref = a.ref;
    const parts = [who,
      a.repeated ? heldPart(li, 'repeated', () => { const p = document.createElement('p'); p.className = 'hint'; return p; }, a.username + ' is in this copy twice, or open already: leave out all but one.') : null,
      a.confirm && t.adopt ? heldTick(li, 'confirm', a.username + ' can manage AGMessage. Adopt ' + a.username + ' only if this folder has been in your hands since ' + a.username + ' was given that.', t.confirm, (v) => setTick(ref, { confirm: v })) : null,
      heldTick(li, 'reset', 'With a one-time password', t.reset, (v) => setTick(ref, { reset: v, keep: false })),
      a.reset && !t.reset ? heldTick(li, 'keep', 'The password in this copy is the copy\'s own claim; whoever wrote the folder may know it.', t.keep, (v) => setTick(ref, { keep: v })) : null,
    ].filter(Boolean);
    for (const el of [...li.children]) if (!parts.includes(el)) el.remove();
    parts.forEach((el, i) => { if (li.children[i] !== el) li.insertBefore(el, li.children[i] || null); });
    ADMIN.draw(who.querySelector(':scope > .obj-bar'), 'heldAccount', heldRowObject(ref), { more: 'Actions for ' + a.username, keysOn: li });
  }
  function drawHeld() {
    if ($('heldSection').hidden) return;
    const h = heldNow;
    const mode = heldObject().mode;
    const why = $('heldWhy');
    if (h && h.unusable) {
      // A copy no account can be adopted from: why, and only the way to leave its accounts out.
      why.dataset.mark = AUDIT_TONE.fault;
      putText(why, AGM.mark('fault') + ' ' + sentence(h.words) + ' Leave its accounts out, or put the copy back and start AGMessage again.');
      putText($('heldCopy'), 'The copy held aside: ' + h.file + ' (digest as held ' + h.digest.slice(0, 16) + '…).');
    } else if (h) {
      why.dataset.mark = AUDIT_TONE[STATE_MARK[h.state]] || '';
      putText(why, heldMark(h.state) + ' ' + sentence(h.words) + (HELD_ASIDE.has(h.state) ? ' Someone may have changed this file: an account you adopt with its own password keeps the password the copy claims.' : ''));
      putText($('heldCopy'), 'The copy held aside: ' + h.file + ' (digest ' + h.digest.slice(0, 16) + '…).');
    } else if (heldFacts && mode === 'left') { why.dataset.mark = AUDIT_TONE.couldNot; putText(why, heldMark('left') + ' ' + sentence(heldFacts.words)); }
    const open = $('heldOpen');
    open.hidden = !(h && h.open && h.open.length);
    if (h && h.open && h.open.length) putText(open, 'Open, keyed as found: ' + h.open.join(', ') + '.');
    const ul = $('heldList');
    const rows = h && heldListed ? h.accounts : [];
    // Each account's row is kept by its key and drawn again in place, so a redraw (every bar's, at each answer of the
    // settings) never takes the focus, a box or an open menu's opener away.
    const refs = new Set(rows.map((a) => a.ref));
    for (const li of [...ul.children]) if (!refs.has(li.dataset.key)) li.remove();
    rows.forEach((a, i) => {
      const li = heldRowOf(ul, a.ref);
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
      drawHeldRow(li, a, tickOf(a.ref));
    });
    ADMIN.draw($('heldActs'), 'accounts', heldObject(), { more: 'Accounts held aside', words: true, cls: 'btn ghost small' });
  }
  /** An adoption (or none: Start with no accounts, Leave these out, Leave the rest out), with the token typed. */
  async function adoptNow(rows, c) {
    const body = {
      token: (c && c.values && c.values.token) || '', digest: heldNow ? heldNow.digest : '',
      adopt: rows.map((a) => ({ id: a.ref, reset: tickOf(a.ref).reset })),
      confirm: rows.filter((a) => tickOf(a.ref).confirm).map((a) => a.ref),
      keep: rows.filter((a) => tickOf(a.ref).keep).map((a) => a.ref),
    };
    if (!heldNow) { const r0 = await AGM.api('GET', '/api/accounts/held'); if (r0 && r0.ok) body.digest = r0.digest; }
    const r = await AGM.api('POST', '/api/accounts/adopt', body);
    if (!r.ok) { say(r.error || 'Not adopted.', true); return; }
    const box = $('heldPasswords');
    box.textContent = '';
    if (r.passwords.length) {
      const head = document.createElement('p'); head.textContent = 'One-time passwords, shown once: give each to its person, who chooses their own at the first sign-in.';
      box.appendChild(head);
      for (const p of r.passwords) { const line = document.createElement('p'); const code = document.createElement('code'); code.textContent = p.password; line.append(p.username + ': ', code); box.appendChild(line); }
    }
    box.hidden = !r.passwords.length;
    const notTaken = Array.isArray(r.notTaken) && r.notTaken.length ? ' Not adopted, as an account of its name was made meanwhile: ' + r.notTaken.join(', ') + '.' : '';
    say((r.adopted.length ? 'Adopted: ' + r.adopted.join(', ') + (r.left ? '; ' + r.left + ' left out.' : '.') : r.left ? 'No account adopted: ' + r.left + ' kept aside.' : 'No account adopted.') + notTaken, !!notTaken);
    const me = await AGM.api('GET', '/api/admin/me');
    const held = me && me.held ? me.held : null;
    heldNow = null;
    heldSeen(held);
    if (!held) $('heldSection').hidden = !r.passwords.length;
    loadSettings();
  }
  const tickedRows = () => (heldNow ? heldNow.accounts.filter((a) => tickOf(a.ref).adopt) : []);
  Object.assign(ADMIN_RUN, {
    'accounts.adopt': (o, c) => adoptNow(tickedRows(), c),
    'accounts.fresh': (o, c) => adoptNow([], c),
    'accounts.leave': (o, c) => adoptNow([], c),
    'accounts.more': () => { heldListed = true; loadHeld(); },
    'heldAccount.adopt': (o) => setTick(o.ref, { adopt: true }),
    'heldAccount.leave': (o) => setTick(o.ref, { adopt: false, confirm: false }),
    'heldAccount.reset': (o) => setTick(o.ref, { reset: !o.reset, keep: false }),
  });
  ADMIN.bind($('heldHead'), { kind: 'accounts', find: (el) => el.closest('#heldHead'), get: heldObject, label: 'Accounts held aside', header: () => 'Accounts held aside' });
  ADMIN.bind($('heldList'), { kind: 'heldAccount', find: (el) => el.closest('li[data-key]'), get: (key) => heldRowObject(key), label: (o) => 'Actions for ' + o.username, header: (o) => o.username });
  ADMIN_DRAWERS.push(drawHeld);
  ADMIN_OBJECTS.accounts = heldObject;
  ADMIN_OBJECTS.heldAccount = heldRowObject;

  // ---------------------------------------------------------------- the split (the admin)
  // The archive points in the live log, newest first, each with what a split there would move or why it would not; a
  // split a stop left part way is offered as Finish the split. The word typed is the confirmation.
  let splitAt = 0;
  const splitSay = (mark, text) => { $('splitState').dataset.mark = mark; $('splitState').textContent = text; };
  async function openSplit() {
    splitSay('', '');
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
    splitSay('', 'Splitting… the files before the point are moved into the archive and signed.');
    const r = await fetch('/api/audit/split', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq }) }).then((x) => x.json()).catch(() => ({ ok: false, error: 'No answer from the server.' }));
    // A split that waits (a file held, or its entry not on disk yet) is △ with its words, never ✓ and never "Not split".
    if (!r.ok && !r.waits) { splitSay('broken', SHAPE.broken + ' ' + (r.error || 'Not split.')); return; }
    splitSay(r.waits ? 'unvouched' : 'intact', r.waits ? SHAPE.unvouched + ' ' + (r.words || r.error) : r.words);
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
    if (r.why) { ul.textContent = SHAPE.broken + ' ' + r.words + ' — a broken entry cannot be accepted.'; return; }
    shown = r;
    let used = 0;   // characters of the accept's target the ticked ids take (it holds 80)
    for (const f of r.findings) {
      const li = document.createElement('li');
      li.dataset.mark = SHAPE[f.mark] ? f.mark : 'broken';
      if (f.held) { li.textContent = (SHAPE[f.mark] || SHAPE.broken) + ' ' + f.words + ' — not on disk yet; it can be accepted once it is'; ul.appendChild(li); continue; }
      const label = document.createElement('label'); label.className = 'check';
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.id = f.id;
      const shape = document.createElement('span'); shape.textContent = SHAPE[f.mark] || SHAPE.broken;
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
          ? 'Accept that ' + f.words + '? From now on it reads ' + SHAPE.linked + ' here, and its entries cannot be checked on this laptop again. Keep it, or an export that holds it, where it went.' + older
          : 'Accept that ' + f.words + '? From now on it reads ' + SHAPE.linked + ', and what it names cannot be brought back.';
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

  // ---------------------------------------------------------------- the show network's links (kind link)
  // The default Stagewatch (once it has an address), each show system heard on the network, and each Patterns or PlayMap
  // linked: one row each, its acts the catalogue's, drawn in place by its key so a redraw every 5 s keeps the focus and an
  // open menu's opener.
  let stagewatch = { url: '', changed: false, keySet: false, fingerprint: '' };
  let heard = [];        // what discovery hears now
  let linked = [];       // nodes:list's linked Patterns and PlayMap
  const LABEL = { main: '⏱ Stagewatch', agent: '🖥 Presenter PC (Stagewatch Slides)', patterns: '🎛 Patterns', playmap: '🎞 PlayMap', messenger: '💬 AGMessage' };
  const isNode = (t) => t === 'patterns' || t === 'playmap';
  /** A link as the catalogue reads it, by its row's key: 'stagewatch', 'heard:<id>' or 'node:<id>'. */
  function linkObject(key) {
    if (key === 'stagewatch') return stagewatch.url ? { t: 'main', name: 'Stagewatch', url: stagewatch.url, changed: stagewatch.changed, keySet: stagewatch.keySet, fingerprint: stagewatch.fingerprint } : null;
    const [where, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const l = linked.find((x) => x.id === id) || null;
    const asLinked = l ? { id: l.id, t: l.t, name: l.name, hall: l.hall || '', linked: true, certificateWaits: !!l.certificateWaits, certificateChanged: !!l.certificateChanged, desk: !!l.desk, commands: l.commands || [] } : null;
    if (where === 'node') return asLinked;
    const p = heard.find((x) => x.id === id);
    if (!p) return null;
    const port = p.ports && (p.ports.http || p.ports.https);
    const url = port ? p.address + ':' + port : '';
    return Object.assign({ id: p.id, t: p.t, name: p.name || p.host || p.t, hall: '' }, asLinked || {}, { heard: true, url: p.t === 'main' ? url : '' });
  }
  /** One row of a list, kept by its key: its words and its bar drawn again in place. */
  function linkRow(ul, key, words) {
    let li = ul.querySelector(':scope > li[data-key="' + CSS.escape(key) + '"]');
    if (!li) {
      li = document.createElement('li');
      li.className = 'link-row';
      li.dataset.key = key;
      const w = document.createElement('span'); w.className = 'link-words';
      const bar = document.createElement('span'); bar.className = 'obj-bar';
      li.append(w, bar);
      ul.appendChild(li);
    }
    const w = li.querySelector('.link-words');
    if (w.textContent !== words) w.textContent = words;
    return li;
  }
  /** Drop the rows of a list whose keys are not in `keep`, and the words that stood for an empty list once it has rows. */
  function prune(ul, keep) {
    for (const li of ul.querySelectorAll(':scope > li')) if (li.dataset.key ? !keep.has(li.dataset.key) : keep.size > 0) li.remove();
  }
  function emptyLine(ul, words) {
    const li = document.createElement('li'); li.className = 'muted'; li.textContent = words; ul.appendChild(li);
  }
  /** Every link's bar, as the facts and the links are now. */
  function drawLinks() {
    const sw = $('swLink');
    sw.hidden = !stagewatch.url;
    for (const li of document.querySelectorAll('.link-list > li.link-row[data-key]')) {
      const o = linkObject(li.dataset.key);
      if (o && !li.hidden) ADMIN.draw(li.querySelector('.obj-bar'), 'link', o, { more: 'Actions for ' + o.name, words: true, cls: 'btn ghost small', keysOn: li });
    }
  }
  ADMIN_DRAWERS.push(drawLinks);

  function renderPeers(peers) {
    heard = peers;
    const ul = $('peerList');
    const keep = new Set(peers.map((p) => 'heard:' + p.id));
    prune(ul, keep);
    if (!peers.length) { if (!ul.querySelector('li')) emptyLine(ul, 'Listening for Stagewatch, Patterns and presenter PCs on this network (UDP 9928)…'); return; }
    for (const p of peers) {
      const dot = p.status === 'live' ? '🟢' : '🟠';
      linkRow(ul, 'heard:' + p.id, dot + ' ' + (LABEL[p.t] || p.t) + ' — ' + (p.name || p.host || '') + ' (' + p.address + (p.status === 'live' ? '' : ', not heard for ' + p.age + ' s') + ')' + (isNode(p.t) && linked.some((l) => l.id === p.id) ? ' · linked' : ''));
    }
    drawLinks();
    ADMIN.refresh();
  }

  // ---------------------------------------------------------------- Patterns and PlayMap links
  function loadNodes() {
    socket.emit('nodes:list', {}, (r) => {
      if (!r || !r.ok) return;
      linked = r.linked;
      const ul = $('nodeLinks');
      prune(ul, new Set(r.linked.map((l) => 'node:' + l.id)));
      if (!r.linked.length && !ul.querySelector('li')) emptyLine(ul, 'No Patterns or PlayMap linked. Link one from the list above when AGMessage hears it.');
      for (const l of r.linked) {
        const mark = AGM.mark({ green: 'ok', amber: 'couldNot', red: 'fault' }[l.light] || 'off');
        linkRow(ul, 'node:' + l.id, mark + ' ' + (l.t === 'playmap' ? 'PlayMap' : 'Patterns') + ' “' + l.name + '” — ' + l.status + (l.problem ? ' (' + l.problem + ')' : '') + (l.headline ? ': ' + l.headline : '') + (l.hall ? ' · hall ' + l.hall : '') + ' · ' + l.commands.length + ' verbs'
          + (l.certificateWaits ? ' · ' + (l.certificateChanged ? 'its certificate changed: confirm it' : 'its certificate waits to be confirmed') : ''));
      }
      renderPeers(heard);
    });
  }
  const linkSaid = (words) => (r) => { if (!r || !r.ok) say((r && r.error) || words, true); loadNodes(); };
  Object.assign(ADMIN_RUN, {
    'link.use': (o) => { $('swUrl').value = o.url; edited.add('swUrl'); $('swKey').focus(); },
    // The default Stagewatch's form, asked in place: what it saves is what the page's own form then shows.
    'link.configure': (o, c) => {
      const v = c.values || {};
      const patch = { stagewatchUrl: v.url || '', stagewatchFingerprint: v.fingerprint || '' };
      if (v.key) patch.stagewatchKey = v.key;
      loadSettings(patch, () => { edited.clear(); say('Stagewatch is set up: the link is refused until it accepts the key.'); });
      setTimeout(() => loadSettings(), 1500);
    },
    'link.copy': (o, c) => AGM.copy(o.url, { said: 'Copied ' + o.name + '\'s address.', anchor: c.anchor, say }),
    // The token goes to another machine only over HTTPS to a certificate a person confirmed (or one pinned before).
    'link.setup': (o, c) => {
      const v = c.values || {};
      AGM.outbox.now('nodes:link', { id: o.id, token: v.token || '', hall: v.hall || '', fingerprint: v.fingerprint || '' }, (r) => {
        if (r && r.ok) say(o.name + (o.linked ? ' is set up.' : ' is linked.'));
        linkSaid('Not linked.')(r);
      });
    },
    'link.confirm': (o, c) => {
      const fp = (c.values && c.values.fingerprint) || '';
      if (!fp) { say('Type the start of its fingerprint to confirm it.', true); return; }
      AGM.outbox.now('nodes:acceptCertificate', { id: o.id, fingerprint: fp }, (r) => { if (r && r.ok) say(o.name + '\'s certificate is confirmed.'); linkSaid('Not accepted.')(r); });
    },
    'link.unlink': (o) => AGM.outbox.now('nodes:unlink', { id: o.id }, (r) => { if (r && r.ok) say(o.name + ' is unlinked.'); linkSaid('Not unlinked.')(r); }),
    'link.propose': (o, c) => {
      const line = (c.values && c.values.line) || '';
      AGM.outbox.now('nodes:command', { id: o.id, line, mode: 'propose' }, (r) => {
        if (!r) { say('No answer.', true); return; }
        if (!r.ok) { say(r.error, true); return; }
        say(AGM.mark('waiting') + ' Proposed to the show desk (' + r.proposal.id + ', ' + r.risk + ' risk) — a person approves it in Stagewatch.');
      });
    },
    'link.accept': () => AGM.outbox.now('admin:acceptCertificate', undefined, (r) => { if (!r || !r.ok) say((r && r.error) || 'Not accepted.', true); else say('Stagewatch\'s new certificate is accepted.'); setTimeout(() => loadSettings(), 800); }),
  });
  const linkSpec = (ul) => ({ kind: 'link', find: (el) => { const li = el.closest('li.link-row[data-key]'); return li && ul.contains(li) ? li : null; }, get: linkObject, label: 'Link actions', gone: 'That link is gone.', header: (o) => o.name });
  for (const ul of [$('swLinkList'), $('peerList'), $('nodeLinks')]) { ADMIN.bind(ul, linkSpec(ul)); AGM.roving(ul, { item: 'li.link-row[data-key]' }); }
  ADMIN_OBJECTS.link = linkObject;

  // ---------------------------------------------------------------- "This laptop" (kind laptop)
  // Its rows are the server's (lib/laptop.js): a label, the words, a mark (its shape beside its colour) and where each was
  // read. Drawn from the settings' answer, from Refresh's, and from laptop:facts once a read of Windows ends.
  const LAPTOP_MARK = { ok: AGM.mark('ok'), warn: AGM.mark('couldNot'), fault: AGM.mark('fault'), off: AGM.mark('off') };
  let laptopNow = null;
  /** "This laptop" as the catalogue reads it: each LAN address as devices open it, and whether Windows is read now. */
  function laptopObject() {
    const l = laptopNow || {};
    return { addresses: Array.isArray(l.addresses) ? l.addresses.map((a) => 'http://' + a + ':' + l.port) : [], reading: !!l.reading };
  }
  /** Written only when its words change, so the status line is not announced again at every reading of the settings. */
  const putText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  function renderLaptop(l) {
    if (!l || !Array.isArray(l.facts)) return;
    laptopNow = l;
    const ul = $('laptopFacts');
    ul.textContent = '';
    for (const f of l.facts) {
      const li = document.createElement('li');
      li.dataset.fact = f.id;
      li.dataset.state = f.mark || '';
      const mark = document.createElement('span'); mark.className = 'lf-mark'; mark.textContent = LAPTOP_MARK[f.mark] || '';
      const label = document.createElement('strong'); label.textContent = f.label + ': ';
      const words = document.createElement('span'); words.className = 'lf-words'; words.textContent = f.words;
      const from = document.createElement('span'); from.className = 'lf-from'; from.textContent = ' · read from ' + f.from;
      li.append(mark, label, words, from);
      ul.appendChild(li);
    }
    putText($('laptopRead'), l.reading ? 'Reading Windows\' facts now…' : l.at ? 'Read at ' + at(l.at) + '. Refresh reads it again.' : '');
    drawLaptop();
    ADMIN.refresh();
  }
  function drawLaptop() { ADMIN.draw($('laptopActs'), 'laptop', laptopObject(), { more: 'This laptop actions', words: true, cls: 'btn ghost small' }); }
  Object.assign(ADMIN_RUN, {
    'laptop.refresh': () => AGM.outbox.now('admin:laptop', undefined, (r) => { if (!r || !r.ok) { say((r && r.error) || 'Not read again.', true); return; } renderLaptop(r.laptop); }),
    'laptop.copy': (o, c) => { if (c.value) AGM.copy(c.value, { said: 'Copied ' + c.value + '.', anchor: c.anchor, say }); },
  });
  ADMIN.bind($('laptopSection'), { kind: 'laptop', find: (el) => el.closest('#laptopSection'), get: laptopObject, label: 'This laptop actions', header: () => 'This laptop' });
  ADMIN_DRAWERS.push(drawLaptop);
  ADMIN_OBJECTS.laptop = laptopObject;

  // ---------------------------------------------------------------- the event (kinds event and archive; plan 6-U15)
  // The current event and the archived ones, as /api/event answers: read when the page opens, when health says the event
  // or its archives changed, and after each act. An archive this page made ends its own sign-in too: the answer is said,
  // and the page starts again once it can be read.
  let eventNow = null;
  let eventSeen = '';
  const day = (t) => { const d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };
  const KIND_WORDS = { first: 'the first event in this data folder', fresh: 'begun fresh', copy: 'a copy of an earlier event\'s settings and structure', continue: 'an archived event continued' };
  /** The current event as the catalogue reads it (kind event). */
  function eventObject() {
    const r = eventNow || { event: {}, archives: [] };
    const e = r.event || {};
    const listed = (r.archives || []).filter((a) => a.event);
    const stuck = e.changing && e.changing.stuck ? e.changing.stuck : '';
    return {
      name: e.name || '', kind: e.kind || 'first', began: e.began || null, busy: !!r.busy, busyWords: r.busyWords || '', stuck, stuckStep: stuck ? e.changing.step : '', stuckWords: stuck ? e.changing.words : '',
      unread: e.unread ? 'This event\'s record could not be read at this start (' + e.unread + '): nothing is archived over it. Start AGMessage again once nothing else holds it.' : '',
      audit: r.audit && Number.isSafeInteger(r.audit.from) && Number.isSafeInteger(r.audit.to) ? { from: r.audit.from, to: r.audit.to } : null,
      copies: listed.filter((a) => a.contents && !a.continued && !a.purged).map((a) => ({ name: a.name, title: a.event.name })),
      continues: listed.filter((a) => !a.continued).map((a) => ({ name: a.name, title: a.event.name })),
    };
  }
  /** An archived event as the catalogue reads it (kind archive), with the current event its ask names. */
  function archiveObject(name) {
    const a = eventNow && (eventNow.archives || []).find((x) => x.name === name);
    if (!a || !a.event) return null;
    return { name: a.name, title: a.event.name, contents: !!a.contents, continued: !!a.continued, purged: !!a.purged, current: eventObject() };
  }
  const countWords = (c) => [[c.halls, 'hall'], [c.messages, 'message'], [c.files, 'file'], [c.accounts, 'account'], [c.screens, 'screen']].map(([n, w]) => n + ' ' + w + (n === 1 ? '' : 's')).join(', ');
  function renderEvent(r) {
    if (!r || !r.ok) return;
    eventNow = r;
    const e = r.event;
    putText($('eventLine'), (e.name ? '“' + e.name + '”' : 'This event (not named yet)') + ' — ' + (KIND_WORDS[e.kind] || e.kind) + (e.began ? ', since ' + day(e.began) : '') + '.' + (r.busy ? ' AGMessage is busy now: ' + r.busyWords + '.' : '') + (e.unread ? ' Its record could not be read at this start (' + e.unread + '): nothing is archived over it this run.' : ''));
    const stuck = e.changing && e.changing.stuck;
    $('eventStuck').hidden = !stuck;
    if (stuck) putText($('eventStuck'), AGM.mark('couldNot') + ' ' + e.changing.words);
    const ul = $('eventArchives');
    const listed = r.archives || [];
    prune(ul, new Set(listed.map((a) => a.name)));
    $('noArchives').hidden = listed.length > 0;
    for (const a of listed) {
      const words = !a.event ? 'An archive whose record cannot be read (' + a.name + ')'
        : '“' + a.event.name + '” · ' + (a.event.began ? day(a.event.began) + ' – ' : '') + day(a.event.ended) + ' · ' + countWords(a.counts)
          + (a.continued ? ' · continued on ' + day(a.continued.at) : '') + (a.purged ? ' · its contents deleted on ' + day(a.purged.at) : '');
      linkRow(ul, a.name, words).tabIndex = 0;
    }
    ADMIN_EVENT.links = Array.isArray(r.earlierLinks) ? r.earlierLinks : [];
    const el = $('earlierLinks');
    el.textContent = '';
    for (const l of ADMIN_EVENT.links) { const li = document.createElement('li'); li.textContent = (l.hall ? '“' + l.hall + '”' + (l.event ? ' (' + l.event + ')' : '') + ': ' : '') + l.url; el.appendChild(li); }
    el.hidden = $('earlierTitle').hidden = !ADMIN_EVENT.links.length;
    drawEvent();
    ADMIN.refresh();
  }
  function drawEvent() {
    ADMIN.draw($('eventActs'), 'event', eventObject(), { more: 'Event actions', words: true, cls: 'btn ghost small' });
    for (const li of $('eventArchives').querySelectorAll(':scope > li[data-key]')) {
      const o = archiveObject(li.dataset.key);
      if (o) ADMIN.draw(li.querySelector('.obj-bar'), 'archive', o, { more: 'Actions for “' + o.title + '”', words: true, cls: 'btn ghost small', keysOn: li });
    }
  }
  async function loadEvent() {
    const r = await AGM.api('GET', '/api/event');
    if (r && r.ok) renderEvent(r);
  }
  /** Health's event moved (a name, an archive made, one under way): the Event section is read again. */
  function eventMoved(e) {
    const sig = e ? JSON.stringify([e.id, e.name, e.archives, e.changing || null]) : '';
    if (sig && sig !== eventSeen) { eventSeen = sig; loadEvent(); }
  }
  /** What comes next, as the ask's pick list names it: `kind:from`. */
  const nextOf = (v) => { const i = String(v).indexOf(':'); return i < 0 ? { kind: String(v) } : { kind: v.slice(0, i), from: v.slice(i + 1) }; };
  async function archiveNow(body) {
    ADMIN_EVENT.archiving = true;
    const r = await AGM.api('POST', '/api/event/archive', body);
    if (!r.ok) {
      ADMIN_EVENT.archiving = false;
      say(r.error || 'Not archived.', true);
      loadEvent();
      return;
    }
    const split = r.split ? ' ' + (r.split.ok ? r.split.words : AGM.mark('couldNot') + ' The audit log was not split: ' + (r.split.error || r.split.words || 'no answer')) : '';
    putText($('eventLine'), r.words + split);
    say(r.words + split);
    // Every sign-in ended with the event: this page starts again once its words can be read.
    setTimeout(() => location.reload(), KEPT_READ_MS);
  }
  const asked = (c) => (c && c.values) || {};
  const ticks = (v) => ({ keepScreens: v.keepScreens === true, split: v.split === true });
  Object.assign(ADMIN_RUN, {
    'event.archive': (o, c) => {
      if (o.stuck) { archiveNow({}); return; }
      const v = asked(c);
      const next = nextOf(v.next || 'fresh');
      archiveNow({ next, name: v.name || '', current: v.current || '', reason: v.reason || '', ...ticks(v), keepScreens: next.kind === 'copy' && v.keepScreens === true });
    },
    'archive.continue': (o, c) => { const v = asked(c); archiveNow({ next: { kind: 'continue', from: o.name }, name: v.name || '', current: v.current || '', reason: v.reason || '', split: v.split === true }); },
    'archive.copy': (o, c) => { const v = asked(c); archiveNow({ next: { kind: 'copy', from: o.name }, name: v.name || '', current: v.current || '', reason: v.reason || '', ...ticks(v) }); },
    'archive.delete': async (o, c) => {
      const r = await AGM.api('POST', '/api/event/purge', { archive: o.name, token: asked(c).token || '' });
      say(r.ok ? r.words : (r.error || 'Not deleted.'), !r.ok);
      loadEvent();
    },
  });
  ADMIN.bind($('eventHead'), { kind: 'event', find: (el) => el.closest('#eventHead'), get: eventObject, label: 'Event actions', header: () => 'This event' });
  ADMIN.bind($('eventArchives'), { kind: 'archive', find: (el) => el.closest('li[data-key]'), get: (key) => archiveObject(key), label: (o) => 'Actions for “' + o.title + '”', header: (o) => '“' + o.title + '”' });
  ADMIN_DRAWERS.push(drawEvent);
  ADMIN_OBJECTS.event = eventObject;
  ADMIN_OBJECTS.archive = archiveObject;

  /**
   * The watched room's invite links, made with its guest code: On stage and Backstage in a hall's Main room, a Member's
   * in a side room (no seat there is On stage); said where its code is off, since a link then admits nobody new. An open
   * hall's Main room still shows its On stage link: On stage seats come from it, in open halls too (owner answer 10).
   * Each link has New … link, which voids it without changing the code; the seats already held stay.
   */
  function showInvites(on) {
    const box = $('inviteLinks');
    box.textContent = '';
    const main = !currentRoom || currentRoom.main !== false;
    if (!on && !main) { box.textContent = 'Open: anyone with the code can join as a Member or an Observer.'; return; }
    const room = currentRoom.code;
    socket.emit('admin:invites', { roomCode: room }, (res) => {
      if (!res || !res.ok || !currentRoom || currentRoom.code !== room) return;
      box.textContent = '';
      if (!on) {
        const open = document.createElement('p'); open.className = 'hint';
        open.textContent = 'Open: anyone with the code joins Backstage or as an Observer; On stage needs this link.';
        box.appendChild(open);
      }
      if (!res.codeOn) {
        const off = document.createElement('p'); off.className = 'hint';
        off.textContent = 'This room\'s guest code is off: these links admit nobody new until it is on.';
        box.appendChild(off);
      }
      for (const role of (on ? ['board', 'research'] : ['board']).filter((x) => res.invites[x])) {
        const url = location.origin + res.invites[role];
        const row = document.createElement('div');
        row.className = 'invite-row';
        row.dataset.role = role;
        const what = role === 'board' ? 'On stage' : main ? 'Backstage' : 'Member';
        const lab = document.createElement('strong'); lab.textContent = what + ' link';
        const code = document.createElement('code'); code.textContent = url;
        const copy = document.createElement('button'); copy.className = 'btn ghost small'; copy.type = 'button'; copy.textContent = '📋 Copy';
        copy.onclick = () => AGM.copy(url, { said: 'Copied the ' + lab.textContent + '.', anchor: copy, say });
        const renew = document.createElement('button'); renew.className = 'btn ghost small invite-new'; renew.type = 'button'; renew.textContent = '🔄 New ' + what + ' link';
        renew.onclick = () => newInvite(renew, role, what, on);
        row.append(lab, code, copy, renew);
        box.appendChild(row);
      }
      const tip = document.createElement('p'); tip.className = 'hint';
      tip.textContent = 'Send each link only to that group, and make a new one after a shared device used it. If you open the tunnel, these links work from anywhere — replace localhost with the public address.';
      box.appendChild(tip);
    });
  }
  /** New … link: asked first, since the link out there stops admitting anyone new; the seats already held stay. */
  function newInvite(btn, role, what, on) {
    AGM.ask(btn, { title: 'Make a new ' + what + ' link?', words: 'The link you sent before stops admitting anyone new. People seated with it keep their seats. The code stays.', yes: 'New ' + what + ' link', no: 'Keep this one', danger: true }, { opener: btn }).then((a) => {
      if (!a.yes) return;
      AGM.outbox.now('admin:newInvite', { roomCode: currentRoom.code, role }, (r) => {
        if (!r || !r.ok) { say((r && r.error) || 'No new link.', true); return; }
        say('A new ' + what + ' link: the old one no longer admits anyone new.');
        showInvites(on);
      });
    });
  }

  /**
   * The hall's switch for its backstage guests' web pages (S4), on its Main room's panel: off by default; offered while
   * the roles are locked, to the admin alone (the laptop's token, or an account whose role is admin), and otherwise drawn
   * disabled with why. `up`, after it is turned off or the hall unlocked over a web page a guest put up: how many stay,
   * with Take it down.
   */
  const GUEST_WEB_WORDS = 'Off by default. Guests who joined Backstage with the invite link may then show web pages, as accounts with the Web pages right do.';
  let guestWebDown = [];
  function drawGuestWeb({ locked, on, up } = {}) {
    const row = $('guestWebRow');
    row.hidden = !currentRoom || currentRoom.main === false;
    if (row.hidden) return;
    const box = $('guestWeb');
    box.checked = !!on;
    const why = !theAdmin ? 'Only an admin may let backstage guests show web pages.' : !locked ? 'Lock the roles first: in an open hall, code guests show nothing.' : '';
    box.disabled = !!why;
    $('guestWebWords').textContent = why || GUEST_WEB_WORDS;
    if (up !== undefined) {
      guestWebDown = up && Array.isArray(up.takeDown) ? up.takeDown : [];
      $('guestWebUp').textContent = guestWebDown.length ? up.upWords : '';
    }
    $('guestWebUp').hidden = !guestWebDown.length;
    $('guestWebDown').hidden = !guestWebDown.length;
  }
  // Roles & invites and ✨ Minutes open their panel under the watched hall's header (the hall is watched first).
  Object.assign(ADMIN_RUN, {
    'adminRoom.invites': (o) => watching(o, () => {
      panel('invitesPanel');
      socket.emit('admin:listRooms', (res) => {
        const rooms = (res && res.rooms) || [];
        const r = rooms.flatMap((x) => [x, ...(x.side || [])]).find((x) => (x.code || x.key) === currentRoom.code);
        $('lockRoles').checked = !!(r && r.locked);
        $('lockWords').textContent = currentRoom.main === false ? 'Member seats need an invite link (anyone else joins as an observer)' : 'On stage and Backstage seats need an invite link (anyone else joins as an observer)';
        drawGuestWeb({ locked: !!(r && r.locked), on: !!(r && r.guestWeb), up: null });
        showInvites(r && r.locked);
      });
    }),
    // A draft is a read whose answer can take longer than an act's 5 s: asked with a plain emit, never sent late
    // (the catalogue refuses it while the page is not connected).
    'adminRoom.minutes': (o) => watching(o, () => {
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
    }),
  });
  /** Run `then` once the hall `o` is the one this page watches. */
  function watching(o, then) {
    if (currentRoom && currentRoom.code === o.code) then(); else watchRoom(o.code, then);
  }

  function wire() {
    if (wired || typeof socket === 'undefined' || !socket) return;
    wired = true;
    socket.on('connect', () => loadSettings());
    socket.on('nodes', (list) => { renderPeers(list); });
    socket.on('nodes:changed', loadNodes);
    socket.on('laptop:facts', renderLaptop);
    loadNodes();
    loadEvent();
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
    $('ctxCopy').onclick = () => { const t = $('ctxToken').textContent; if (t && t !== '—') AGM.copy(t, { said: 'Copied the context token.', anchor: $('ctxCopy'), say }); };
    $('signKeyCopy').onclick = () => { const t = $('signKeyText').textContent; if (t && t !== '—') AGM.copy(t, { said: 'Copied the signing key.', anchor: $('signKeyCopy'), say }); };
    $('auditSplitBtn').onclick = () => { openSplit(); };
    $('splitCancel').onclick = () => { $('splitDialog').close(); };
    $('splitFinish').onclick = () => { const t = /entry (\d+)$/.exec($('splitFinish').textContent); if (t) postSplit(Number(t[1])); };
    $('splitForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!splitAt) { splitSay('broken', 'Choose the archive point to split at.'); return; }
      if ($('splitWord').value.trim().toLowerCase() !== 'split') { splitSay('broken', 'Type the word split to split there.'); return; }
      postSplit(splitAt);
    });
    $('auditExportBtn').onclick = () => {
      const fp = lastHealth && lastHealth.saves.stores.audit.signKey;
      window.AGMAuditExport.open({ fingerprint: fp, done: () => { setTimeout(() => loadSettings(), 300); } });
    };
    $('ctxNew').onclick = () => loadSettings({ newContextToken: true });
    $('requireHttps').onchange = () => loadSettings({ requireHttps: $('requireHttps').checked });
    $('remoteAdmin').onchange = () => loadSettings({ remoteAdmin: $('remoteAdmin').checked });
    $('tlsRenew').onclick = () => {
      const btn = $('tlsRenew');
      AGM.ask(btn, { title: 'Make a new certificate?', words: 'Every device and app that trusted the old one will need to trust the new one.', yes: 'New certificate', no: 'Keep this one', danger: true }, { opener: btn }).then((a) => {
        if (!a.yes) return;
        AGM.outbox.now('admin:renewCertificate', undefined, (r) => { if (!r || !r.ok) say((r && r.error) || 'No new certificate.', true); else say('A new certificate is in use.'); loadSettings(); });
      });
    };
    $('aiKeySave').onclick = () => { loadSettings({ aiKey: $('aiKeyInput').value.trim() }); $('aiKeyInput').value = ''; };
    $('swSave').onclick = () => {
      const patch = { stagewatchUrl: $('swUrl').value.trim(), stagewatchFingerprint: $('swFp').value.trim() };
      if ($('swKey').value.trim()) patch.stagewatchKey = $('swKey').value.trim();
      loadSettings(patch, () => { edited.clear(); }); $('swKey').value = '';
      setTimeout(() => loadSettings(), 1500);
    };

    $('closeInvitesBtn').onclick = () => panel(null);
    $('lockRoles').onchange = () => {
      AGM.outbox.now('admin:lockRoles', { roomCode: currentRoom.code, on: $('lockRoles').checked }, (res) => {
        if (!res || !res.ok) say((res && res.error) || 'Not changed.', true);
        showInvites(res && res.locked);
        // An unlock turns the guests' web pages off: the switch follows, disabled until the roles are locked again, and the
        // web pages guests put up that stay are counted with Take it down, as when the switch is turned off.
        drawGuestWeb({ locked: !!(res && res.locked), on: !!(res && res.guestWeb), ...(res && res.ok && typeof res.up === 'number' ? { up: res } : {}) });
      });
    };
    $('guestWeb').onchange = () => {
      const on = $('guestWeb').checked;
      AGM.outbox.now('admin:guestWeb', { roomCode: currentRoom.code, on }, (res) => {
        if (!res || !res.ok) { say((res && res.error) || 'Not changed.', true); drawGuestWeb({ locked: $('lockRoles').checked, on: !on }); return; }
        drawGuestWeb({ locked: true, on: res.on, up: res });
        say(res.on ? 'Backstage guests may show web pages in this hall.' : 'Backstage guests may no longer show web pages in this hall.' + (res.up ? ' ' + res.upWords + '.' : ''));
      });
    };
    // Take it down: each web page a guest put up that stays after the switch went off, the information taken down from the
    // pages it is on (what the show put up under it stays), over that take alone (`ifSeq`), so nothing put up since is
    // taken down with it.
    $('guestWebDown').onclick = () => {
      const list = guestWebDown.slice();
      const hall = currentRoom.code;
      let left = list.length;
      const refused = [];
      for (const t of list) {
        AGM.outbox.now('page:push', { code: hall, to: t.to === 'board' ? 'board' : { uid: t.to }, content: { kind: 'chat', layer: 'info' }, ifSeq: t.seq }, (r) => {
          if (!r || !r.ok) refused.push((r && r.error) || 'Not taken down.');
          if (--left) return;
          guestWebDown = [];
          drawGuestWeb({ locked: $('lockRoles').checked, on: $('guestWeb').checked });
          if (refused.length) say(refused[0], true); else say(list.length === 1 ? 'The web page is taken down: their pages show what is under it.' : 'The web pages are taken down: their pages show what is under them.');
        });
      }
    };
    $('postMinutesBtn').onclick = () => {
      if (!lastMinutes || !currentRoom) return;
      AGM.outbox.now('admin:postSummary', { roomCode: currentRoom.code, text: '📝 Minutes so far (AI draft, posted by the admin)\n\n' + lastMinutes }, (r) => { if (!r || !r.ok) say((r && r.error) || 'Not posted.', true); else { say('The minutes are posted, pinned.'); panel(null); } });
    };
    $('closeMinutesBtn').onclick = () => panel(null);


  }
  const t = setInterval(() => { wire(); if (wired) clearInterval(t); }, 300);
})();
