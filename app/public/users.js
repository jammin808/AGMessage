// Accounts and the audit log. An admin (or anyone given users.manage) adds people with a role, their halls and any
// exception to the role's rights; a new person gets a one-time password shown once. Someone who is not an admin is
// offered only the rights and halls they hold themselves (the server's `giveable`). The audit log reads newest first,
// each row with its mark, and checks its own chain on demand; a mark is always a shape beside its colour.
// The acts on an account and on an entry of the log are the catalogue's (catalog.js: kinds account, audit), drawn by
// AGM.acts: the bar, the ⋯, right-click, Shift+F10 and the keys alike; this page binds only what each does (RUN), over
// HTTP: an answer not back in 5 s is said ("No answer"), and the answer that comes later is still the act's, said as late
// (a new one-time password that comes late is shown all the same). A split of the audit log runs as long as it takes.
(function () {
  'use strict';
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): its words, and nothing else
  const $ = (id) => document.getElementById(id);
  const esc = AGM.esc;
  AGM.theme();
  const say = (words, bad) => AGM.toast(words, bad);
  let meAnswer = null;      // /api/auth/me's account
  let theAdmin = false;     // /api/admin/me's `admin`: the token, or an account whose role is admin
  let filter = null;        // the audit list's: {by: 'actor' | 'target', value, words}
  let F = AGM.catalog.accountFacts({});
  const RUN = {};
  const A = AGM.acts({ facts: () => F, run: RUN, say });
  function factsChanged() {
    F = AGM.catalog.accountFacts({ account: meAnswer, admin: theAdmin, filter });
    drawBars();
    A.refresh();
  }
  const NO_ANSWER_MS = 5000;
  const NO_ANSWER = 'No answer — check the connection. What AGMessage answers later is said here.';
  /** The words an answer that came after "No answer" starts with. */
  const lateWords = (r) => (r.late ? 'AGMessage answered late: ' : '');
  /**
   * An act over HTTP, answered in `done(r)` exactly once, whenever it comes: an answer not back in 5 s is "No answer"
   * (`noAnswer(words)`, else the toast), and the answer that comes after that reaches `done` all the same, `late: true`.
   */
  function http(method, url, body, done, noAnswer) {
    let late = false;
    const timer = setTimeout(() => { late = true; (noAnswer || ((w) => say(w, true)))(NO_ANSWER); }, NO_ANSWER_MS);
    AGM.api(method, url, body).then((r) => {
      clearTimeout(timer);
      done(late ? Object.assign({}, r, { late: true }) : r);
    });
  }
  // A dialog's Cancel is a plain button, never its form's default, so Enter in a field saves: Cancel closes its dialog,
  // its returnValue 'cancel', and nothing is sent.
  for (const b of document.querySelectorAll('dialog button[value="cancel"]')) b.addEventListener('click', () => b.closest('dialog').close('cancel'));

  let data = null;          // {users, roles, caps, halls, giveable}
  let editing = null;       // the account being edited, or null for a new one
  let meId = '';            // the signed-in account: on its own row only the name is the viewer's to change
  let saving = false;       // a save in flight: a second click or Enter sends nothing

  // ---------------------------------------------------------------- tabs
  function tab(which) {
    $('peoplePane').hidden = which !== 'people';
    $('auditPane').hidden = which !== 'audit';
    $('tabPeople').classList.toggle('active', which === 'people');
    $('tabAudit').classList.toggle('active', which === 'audit');
    $('tabPeople').setAttribute('aria-selected', String(which === 'people'));
    $('tabAudit').setAttribute('aria-selected', String(which === 'audit'));
    if (which === 'audit') loadAudit();
  }
  $('tabPeople').addEventListener('click', () => tab('people'));
  $('tabAudit').addEventListener('click', () => tab('audit'));

  // ---------------------------------------------------------------- people
  async function load() {
    const [me, admin] = await Promise.all([AGM.api('GET', '/api/auth/me'), AGM.api('GET', '/api/admin/me')]);
    if (!me.account) { location.replace('/?next=/users.html'); return; }
    meId = me.account.id;
    meAnswer = me.account;
    theAdmin = !!(admin && admin.admin);
    factsChanged();
    $('who').textContent = me.account.name + ' · ' + me.account.rights.roleLabel;
    const canUsers = me.account.rights.caps.includes('users.manage');
    const canAudit = me.account.rights.caps.includes('audit.read');
    // Export reads every entry, so it is offered with both rights, as the server asks.
    $('exportBtn').hidden = !(canAudit && me.account.rights.caps.includes('audit.export'));
    $('tabPeople').hidden = !canUsers;
    // The skip link goes where this page's list is: the accounts, or the audit log for one who reads only that.
    if (!canUsers) { $('skipLink').href = '#auditHead'; $('skipLink').textContent = 'Skip to the audit log'; }
    if (!canUsers && canAudit) tab('audit');
    if (!canUsers) return;
    const r = await AGM.api('GET', '/api/users');
    if (!r.ok) { $('tabPeople').hidden = true; if (canAudit) tab('audit'); else $('peoplePane').hidden = true; AGM.toast(r.error, true); return; }
    data = r;
    renderUsers();
  }

  const roleOf = (id) => data.roles.find((r) => r.id === id) || { label: id, caps: [], allHalls: false };
  // What this viewer may hand out: a right, a hall, every hall (an admin: everything).
  const mayGive = {
    cap: (c) => data.giveable.admin || data.giveable.caps.includes(c),
    hall: (code) => data.giveable.allHalls || data.giveable.halls.includes(code),
    allHalls: () => data.giveable.allHalls,
  };
  const hallName = (code) => { const h = data.halls.find((x) => x.code === code); return h ? (h.name || h.code) : code; };

  /** An account as the catalogue reads it: its id, name, whether it is off, why this viewer may not change it, whether it is one's own. */
  function accountObject(id) {
    const u = data && data.users.find((x) => x.id === id);
    return u ? { id: u.id, name: u.name, username: u.username, disabled: !!u.disabled, locked: u.locked || '', self: u.id === meId } : null;
  }
  /** The accounts, each kept by its id and drawn again in place: its words, its Edit and its ⋯. */
  function renderUsers() {
    const tb = $('userRows');
    const keep = new Map([...tb.querySelectorAll(':scope > tr[data-key]')].map((tr) => [tr.dataset.key, tr]));
    data.users.forEach((u, i) => {
      let tr = keep.get(u.id);
      keep.delete(u.id);
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.key = u.id;
        tr.className = 'account-row';
        for (let n = 0; n < 5; n++) tr.appendChild(document.createElement('td'));
        const bar = document.createElement('span'); bar.className = 'obj-bar';
        tr.lastElementChild.appendChild(bar);
      }
      tr.classList.toggle('off', !!u.disabled);
      // A viewer that does not reach every hall is told only its own halls' codes: the rest of a person's are a count.
      const listed = u.rights.halls.map(hallName).concat(u.otherHalls ? [u.otherHalls + ' other hall' + (u.otherHalls === 1 ? '' : 's')] : []);
      const hallsWords = u.rights.allHalls ? 'Every hall' : (listed.join(', ') || 'None');
      const cellsHtml = [
        '<strong>' + esc(u.name) + '</strong><br><span class="muted">' + esc(u.username) + (u.disabled ? ' · turned off' : '') + (u.mustChange ? ' · one-time password' : '') + '</span>',
        esc(roleOf(u.role).label) + (u.grant.length || u.revoke.length ? ' <span class="muted" title="Rights changed for this person">(adjusted)</span>' : ''),
        esc(hallsWords),
        (u.lastLoginAt ? esc(AGM.ago(u.lastLoginAt)) : '<span class="muted">Never</span>') + (u.sessions ? ' <span class="muted">· ' + esc(String(u.sessions)) + ' device' + (u.sessions === 1 ? '' : 's') + '</span>' : ''),
      ];
      cellsHtml.forEach((cellHtml, n) => { if (tr.children[n].innerHTML !== cellHtml) tr.children[n].innerHTML = cellHtml; });
      if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] || null);
    });
    for (const tr of keep.values()) tr.remove();
    drawBars();
    A.refresh();
  }
  /** Every bar of the page as the facts and the rows are now: a locked row's Edit says why on its button and in its menu. */
  function drawBars() {
    for (const tr of document.querySelectorAll('#userRows > tr[data-key]')) {
      const o = accountObject(tr.dataset.key);
      if (o) A.draw(tr.querySelector('.obj-bar'), 'account', o, { more: 'Actions for ' + o.name, words: true, cls: 'btn small', keysOn: tr });
    }
    for (const li of document.querySelectorAll('#auditList > li[data-key]')) {
      const o = auditObject(li.dataset.key);
      if (o) A.draw(li.querySelector('.obj-bar'), 'audit', o, { more: 'Entry actions', keysOn: li });
    }
  }

  // ---------------------------------------------------------------- the editor
  // Nobody changes their own role, rights or halls, nor turns themselves off or removes themselves (rbac.mayChange): on
  // one's own row those are shown and not offered, and a Save sends the name alone.
  const isSelf = (u) => !!u && u.id === meId;
  function openEditor(u) {
    editing = u || null;
    const self = isSelf(u);
    $('userTitle').textContent = u ? 'Edit ' + u.name : 'Add a person';
    $('userError').hidden = true;
    $('uName').value = u ? u.name : '';
    $('uUser').value = u ? u.username : '';
    $('uUser').disabled = !!u;
    const sel = $('uRole');
    sel.textContent = '';
    for (const r of data.roles) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; o.disabled = r.id === 'admin' && !data.giveable.admin; sel.appendChild(o); }
    sel.value = u ? u.role : 'staff';
    sel.disabled = self;
    const hallsBox = $('uHalls');
    hallsBox.textContent = '';
    for (const h of data.halls) {
      const l = document.createElement('label'); l.className = 'check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.value = h.code; c.disabled = self || !mayGive.hall(h.code); c.checked = (self || !c.disabled) && !!(u && u.halls.includes(h.code));
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + (h.name || h.code) + ' (' + h.code + ')'));
      hallsBox.appendChild(l);
    }
    if (!data.halls.length) hallsBox.textContent = 'No halls yet.';
    $('uAll').disabled = self || !mayGive.allHalls();
    $('uAll').checked = (self || !$('uAll').disabled) && (u ? u.rights.allHalls : roleOf(sel.value).allHalls);
    $('uAll').dataset.touched = u && u.allHalls !== null ? '1' : '';
    renderCaps(u);
    if (self) $('uRoleWords').textContent = 'Nobody changes their own role, rights or halls — ask another admin.';
    $('userDanger').hidden = !u;
    $('disableBtn').hidden = self;
    $('removeBtn').hidden = self;
    if (u) $('disableBtn').textContent = AGM.catalog.entry('account', 'account.disable').label(F, accountObject(u.id) || u);
    AGM.openDialog($('userDialog'));
  }

  function renderCaps(u) {
    const role = roleOf($('uRole').value);
    $('uRoleWords').textContent = role.words || '';
    const box = $('uCaps');
    box.textContent = '';
    for (const [cap, words] of Object.entries(data.caps)) {
      const fromRole = role.caps.includes(cap);
      const self = isSelf(editing);
      const given = mayGive.cap(cap);
      const on = (given || self) && (u ? (fromRole ? !u.revoke.includes(cap) : u.grant.includes(cap)) : fromRole);
      const l = document.createElement('label'); l.className = 'check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.value = cap; c.checked = on; c.disabled = !given || self;
      l.appendChild(c);
      const t = document.createElement('span');
      t.textContent = ' ' + words;
      if (on !== fromRole) { const m = document.createElement('em'); m.className = 'muted'; m.textContent = on ? ' (added)' : ' (removed)'; t.appendChild(m); }
      l.appendChild(t);
      box.appendChild(l);
    }
  }
  $('uRole').addEventListener('change', () => {
    if (!$('uAll').dataset.touched) $('uAll').checked = !$('uAll').disabled && roleOf($('uRole').value).allHalls;
    renderCaps(editing && editing.role === $('uRole').value ? editing : null);
  });
  $('uAll').addEventListener('change', () => { $('uAll').dataset.touched = '1'; });

  /** The form as a change: role, halls, and the rights that differ from the role's (grant / revoke). */
  function formChange() {
    if (isSelf(editing)) return { name: $('uName').value.trim() };
    const role = roleOf($('uRole').value);
    const caps = Array.from($('uCaps').querySelectorAll('input:checked')).map((c) => c.value);
    // A hall the account holds that is not on the list (removed since) is not shown, so it is not the editor's to drop:
    // it is sent back as it is, and an untouched Save stays no change — none of that person's pages reload.
    const unlisted = editing ? editing.halls.filter((code) => !data.halls.some((h) => h.code === code)) : [];
    const change = {
      name: $('uName').value.trim(), role: role.id,
      halls: Array.from($('uHalls').querySelectorAll('input:checked')).map((c) => c.value).concat(unlisted),
      grant: caps.filter((c) => !role.caps.includes(c)),
      revoke: role.caps.filter((c) => !caps.includes(c)),
    };
    if ($('uAll').dataset.touched || $('uAll').checked !== role.allHalls) change.allHalls = $('uAll').checked;
    return change;
  }

  // A Save is one request at a time, held until it is answered (a late answer too): a second click or Enter sends nothing.
  $('userForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (saving) return;
    saving = true; $('userSave').disabled = true;
    const was = editing;
    const change = formChange();
    const inEditor = () => $('userDialog').open && editing === was;
    const sayIn = (words) => { if (inEditor()) { $('userError').textContent = words; $('userError').hidden = false; } else say(words, true); };
    const done = (r) => {
      saving = false; $('userSave').disabled = false;
      if (!r.ok) { sayIn(lateWords(r) + r.error); return; }
      if (inEditor()) $('userDialog').close();
      if (r.password) showSecret(r.user.name, r.password);
      else say(lateWords(r) + (was ? 'Saved — ' + (r.changed.length ? 'their open pages reconnect with the new rights.' : 'nothing changed.') : 'Added.'));
      load();
    };
    if (was) http('PATCH', '/api/users/' + encodeURIComponent(was.id), change, done, sayIn);
    else http('POST', '/api/users', { ...change, username: $('uUser').value.trim().toLowerCase() }, done, sayIn);
  });

  /**
   * An act on an account: its answer said (as late, when it came after "No answer"), its words in the editor when the
   * editor is open on it, and the list read again. `done(r, late)` hears what it did and the words a late answer starts with.
   */
  function accountAct(o, method, path, body, done) {
    const inEditor = () => $('userDialog').open && editing && editing.id === o.id;
    const sayIn = (words) => { if (inEditor()) { $('userError').textContent = words; $('userError').hidden = false; } else say(words, true); };
    http(method, '/api/users/' + encodeURIComponent(o.id) + path, body, (r) => {
      if (!r.ok) { sayIn(lateWords(r) + r.error); return; }
      if (inEditor()) $('userDialog').close();
      done(r, lateWords(r));
      load();
    }, sayIn);
  }
  Object.assign(RUN, {
    'account.edit': (o) => { const u = data.users.find((x) => x.id === o.id); if (u) openEditor(u); },
    // Shown once, here, whenever its answer comes: the old password has stopped working by then.
    'account.password': (o) => accountAct(o, 'POST', '/password', {}, (r) => showSecret(o.name, r.password)),
    'account.signout': (o) => accountAct(o, 'POST', '/signout', {}, (r, late) => say(late + o.name + ' is signed out on every device.')),
    'account.disable': (o) => accountAct(o, 'PATCH', '', { disabled: !o.disabled }, (r, late) => say(late + (o.disabled ? o.name + ' is turned on.' : o.name + ' is turned off — signed out everywhere.'))),
    'account.remove': (o) => accountAct(o, 'DELETE', '', undefined, (r, late) => say(late + o.name + '\'s account is removed.')),
  });
  // The editor's own buttons are doors to the same acts, asked in place inside the editor.
  for (const [btn, id] of [['resetBtn', 'account.password'], ['signOutAllBtn', 'account.signout'], ['disableBtn', 'account.disable'], ['removeBtn', 'account.remove']]) {
    $(btn).addEventListener('click', () => {
      const o = editing && accountObject(editing.id);
      if (o) A.act('account', id, o, { anchor: $(btn), opener: $(btn), get: () => accountObject(o.id), gone: 'That account is gone.' });
    });
  }
  A.bind($('userRows'), { kind: 'account', find: (el) => el.closest('#userRows > tr[data-key]'), get: accountObject, label: 'Account actions', gone: 'That account is gone.', header: (o) => o.name + ' · ' + o.username });
  AGM.roving($('userRows'), { item: 'tr[data-key]' });

  function showSecret(who, pw) {
    $('secretWho').textContent = who;
    $('secretValue').textContent = pw;
    AGM.openDialog($('secretDialog'));
  }
  $('copySecret').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('secretValue').textContent); AGM.toast('Copied.'); } catch { AGM.toast('Copy it by hand — this browser blocks the clipboard here.', true); }
  });
  $('newUserBtn').addEventListener('click', () => openEditor(null));

  // ---------------------------------------------------------------- the audit log
  // The four marks, each a shape and words, never a colour alone.
  const MARKS = {
    intact: { shape: '✓', words: 'checked under this laptop\'s key' },
    linked: { shape: '◇', words: 'linked, and accepted on the AGMessage laptop' },
    unvouched: { shape: '△', words: 'not vouched for yet: accept it on the AGMessage laptop (Admin → Health)' },
    broken: { shape: '✕', words: 'did not check' },
  };
  const markHtml = (m) => { const k = MARKS[m] ? m : 'broken'; return '<span class="audit-mark" data-mark="' + esc(k) + '" title="' + esc(MARKS[k].words) + '"><span aria-hidden="true">' + esc(MARKS[k].shape) + '</span><span class="sr-only">' + esc(MARKS[k].words) + '</span></span>'; };
  let signKey = '';   // the signing key's fingerprint, which an export is checked against
  let entries = [];   // the rows drawn, newest first, as /api/audit gave them
  /** An entry as the catalogue reads it, by its row's key (its seq, or 'line:<n>' for a line that is not a whole entry). */
  function auditObject(key) {
    return entries.find((e) => rowKey(e) === key) || null;
  }
  const rowKey = (e) => (e.actor ? String(e.seq) : 'line:' + e.line);
  const actorName = (e) => (e.actor ? e.actor.name || e.actor.t : '');
  /** Whether an entry is drawn under the filter: every one with none. */
  const kept = (e) => !filter || (filter.by === 'actor' ? AGM.catalog.actorKey(e) === filter.value : e.target === filter.value);
  /** The list as the filter keeps it, and the line that says what it keeps. */
  function applyFilter() {
    let n = 0;
    for (const li of document.querySelectorAll('#auditList > li[data-key]')) {
      const e = auditObject(li.dataset.key);
      const on = !!e && kept(e);
      li.hidden = !on;
      if (on) n++;
    }
    $('auditFilter').hidden = !filter;
    $('auditFilterWords').textContent = filter ? filter.words + ' · ' + n + ' of ' + entries.length + ' shown' : '';
    auditRoving.refresh();
    factsChanged();
  }
  async function loadAudit() {
    const r = await AGM.api('GET', '/api/audit?limit=300');
    if (!r.ok) { AGM.toast(r.error, true); return; }
    signKey = r.key && typeof r.key.fingerprint === 'string' ? r.key.fingerprint : '';
    const kid = r.key && typeof r.key.kid === 'string' ? r.key.kid : '';
    $('auditKey').textContent = !r.key ? '' : (kid ? 'Keyed with key ' + kid + '. ' : 'Not keyed this run: it has no machine key. ')
      + (signKey ? 'Exports are signed with the key ' + signKey.match(/.{4}/g).join(' ') + ': whoever checks one compares it with their own record of this key (the show\'s paperwork), never with the export.' : 'No export can be signed this run.');
    renderArchives(Array.isArray(r.archives) ? r.archives : [], Array.isArray(r.unreached) ? r.unreached : []);
    const ol = $('auditList');
    ol.textContent = '';
    entries = Array.isArray(r.entries) ? r.entries : [];
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'audit-row';
      li.dataset.key = rowKey(e);
      li.dataset.mark = MARKS[e.mark] ? e.mark : 'broken';
      // A line that is not a whole entry is said as one, never drawn as an entry.
      if (!e.actor) {
        li.dataset.action = 'bad';
        li.innerHTML = markHtml('broken') + '<span class="audit-words audit-bad">✕ ' + esc(e.words || 'a line that is not a whole entry') + '</span><span class="obj-bar"></span>';
        ol.appendChild(li);
        continue;
      }
      li.dataset.action = e.action.split('.')[0];
      li.innerHTML = markHtml(e.mark) +
        '<time datetime="' + esc(new Date(e.at).toISOString()) + '">' + esc(new Date(e.at).toLocaleString()) + '</time>' +
        '<span class="audit-actor">' + esc(actorName(e)) + '</span>' +
        '<span class="audit-action">' + esc(e.action) + (e.target ? ' <em>' + esc(e.target) + '</em>' : '') + '</span>' +
        '<span class="audit-words">' + esc(e.words) + (e.ip ? ' <span class="muted">from ' + esc(e.ip) + '</span>' : '') + '</span>' +
        '<span class="obj-bar"></span>';
      ol.appendChild(li);
    }
    applyFilter();
  }
  /** A row as words, its mark's shape first: what Copy this row puts on the clipboard (a row holds no secret, by rule). */
  function rowWords(e) {
    const shape = (MARKS[e.mark] || MARKS.broken).shape;
    if (!e.actor) return shape + ' ' + (e.words || 'a line that is not a whole entry');
    return [shape, new Date(e.at).toLocaleString(), actorName(e), e.action + (e.target ? ' ' + e.target : ''), e.words + (e.ip ? ' from ' + e.ip : '')].join(' · ');
  }
  /** Check the log: the whole chain read on the server, its mark said with its shape, and the rows' marks as it found them. */
  async function checkLog() {
    const btn = $('verifyBtn');
    const el = $('chainState');
    btn.disabled = true;
    el.dataset.mark = '';
    el.textContent = 'Checking the whole log…';
    try {
      const r = await AGM.api('GET', '/api/audit/verify');
      const mark = r && MARKS[r.mark] && typeof r.words === 'string' ? r.mark : '';
      el.dataset.mark = mark || 'broken';
      if (!mark) el.textContent = '✕ Not checked: ' + ((r && r.error) || 'no answer from the server');
      else el.textContent = MARKS[mark].shape + ' ' + r.words + (r.unwritten ? ' · △ ' + r.unwritten + ' newer not yet on disk (the disk would not take them; they are tried again with the next entry)' : '');
      if (mark) await loadAudit();   // the rows' marks, as this check found the spans now
    } finally { btn.disabled = false; }
  }
  const openExport = () => { window.AGMAuditExport.open({ fingerprint: signKey, done: () => { loadAudit(); } }); };
  Object.assign(RUN, {
    'audit.copy': (e, c) => AGM.copy(rowWords(e), { said: 'Copied the row.', anchor: c.anchor, say }),
    'audit.actor': (e) => { filter = { by: 'actor', value: AGM.catalog.actorKey(e), words: 'Only entries by ' + actorName(e) }; applyFilter(); },
    'audit.target': (e) => { filter = { by: 'target', value: e.target, words: 'Only entries about ' + e.target }; applyFilter(); },
    'audit.all': () => { filter = null; applyFilter(); },
    'audit.check': () => { checkLog(); },
    'audit.export': () => openExport(),
    // The split asks for the word typed, as Admin → Health's does, and runs as long as it takes (it moves and signs whole
    // files), saying so meanwhile; what it moved, or why not, is said with its mark, and the log is read again.
    'audit.split': (e, c) => {
      if (String((c.values && c.values.word) || '').toLowerCase() !== 'split') { say('Not split: type the word split to split there.', true); return; }
      say('Splitting… the files before entry ' + e.seq + ' are moved into the archive and signed.');
      AGM.api('POST', '/api/audit/split', { seq: e.seq }).then((r) => {
        if (!r.ok && !r.waits) say('✕ ' + (r.error || 'Not split.'), true);
        else say(r.waits ? '△ ' + (r.words || r.error) : r.words, !!r.waits);
        loadAudit();
      });
    },
  });
  $('auditShowAll').addEventListener('click', () => RUN['audit.all']());
  A.bind($('auditList'), { kind: 'audit', find: (el) => el.closest('#auditList > li[data-key]'), get: auditObject, label: 'Entry actions', gone: 'That entry is no longer listed.', header: (e) => (e.actor ? 'Entry ' + e.seq + ' · ' + e.action : 'A line that is not a whole entry') });
  const auditRoving = AGM.roving($('auditList'), { item: 'li[data-key]:not([hidden])' });
  // What this page's acts read, by name: its facts and its objects (the browser smoke reads them to hold the doors to the catalogue).
  AGM.page = Object.freeze({ facts: () => F, object: (kind, key) => (kind === 'account' ? accountObject(key) : kind === 'audit' ? auditObject(key) : null) });
  // ---------------------------------------------------------------- the archives
  // Each archive the check names, oldest first, with its mark and its own Check: the archive alone, its signature, its
  // files and its entries (H.10.3). A folder of this log's that the chain no longer reaches is listed as one, with its Check.
  const words1 = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
  function archiveRow(name, mark, text) {
    const li = document.createElement('li');
    li.className = 'audit-archive';
    li.dataset.archive = name;
    li.dataset.mark = mark;
    const shape = document.createElement('span');
    shape.className = 'audit-mark';
    shape.setAttribute('aria-hidden', 'true');
    shape.textContent = mark ? MARKS[mark].shape : '○';
    const what = document.createElement('span');
    what.className = 'archive-words';
    what.textContent = text;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn ghost small'; btn.textContent = 'Check';
    const said = document.createElement('span');
    said.className = 'archive-check';
    said.setAttribute('role', 'status');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      said.dataset.mark = '';
      said.textContent = 'Checking the archive…';
      try {
        const a = await AGM.api('GET', '/api/audit/verify?archive=' + encodeURIComponent(name));
        const m = a && MARKS[a.mark] && typeof a.words === 'string' ? a.mark : '';
        said.dataset.mark = m || 'broken';
        said.textContent = m ? MARKS[m].shape + ' ' + a.words : '✕ Not checked: ' + ((a && a.error) || 'no answer from the server');
      } finally { btn.disabled = false; }
    });
    li.append(shape, what, btn, said);
    return li;
  }
  function renderArchives(list, unreached) {
    const ul = $('auditArchives');
    ul.textContent = '';
    for (const a of list) {
      const k = MARKS[a.mark] ? a.mark : 'broken';
      ul.appendChild(archiveRow(a.name, k, words1(a.words)));
    }
    for (const name of unreached) ul.appendChild(archiveRow(name, '', 'Archive ' + name + ' · not reached from the live log: the archive that named it is gone'));
    ul.hidden = !list.length && !unreached.length;
  }

  // One check at a time: the button rests while the server reads the chain (every file of it). The answer's mark is drawn
  // with its shape; an answer with no mark this page knows reads "Not checked", never ✓.
  $('verifyBtn').addEventListener('click', () => { checkLog(); });
  $('exportBtn').addEventListener('click', () => openExport());

  load().then(() => { if (location.hash === '#audit') tab('audit'); });
})();
