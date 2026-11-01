// Accounts and the audit log. An admin (or anyone given users.manage) adds people with a role, their halls and any
// exception to the role's rights; a new person gets a one-time password shown once. Someone who is not an admin is
// offered only the rights and halls they hold themselves (the server's `giveable`). The audit log reads newest first,
// each row with its mark, and checks its own chain on demand; a mark is always a shape beside its colour.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = AGM.esc;
  AGM.theme();

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
    const me = await AGM.api('GET', '/api/auth/me');
    if (!me.account) { location.replace('/?next=/users.html'); return; }
    meId = me.account.id;
    $('who').textContent = me.account.name + ' · ' + me.account.rights.roleLabel;
    const canUsers = me.account.rights.caps.includes('users.manage');
    const canAudit = me.account.rights.caps.includes('audit.read');
    // Export reads every entry, so it is offered with both rights, as the server asks.
    $('exportBtn').hidden = !(canAudit && me.account.rights.caps.includes('audit.export'));
    $('tabPeople').hidden = !canUsers;
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

  function renderUsers() {
    const tb = $('userRows');
    tb.textContent = '';
    for (const u of data.users) {
      const tr = document.createElement('tr');
      if (u.disabled) tr.className = 'off';
      // A viewer that does not reach every hall is told only its own halls' codes: the rest of a person's are a count.
      const listed = u.rights.halls.map(hallName).concat(u.otherHalls ? [u.otherHalls + ' other hall' + (u.otherHalls === 1 ? '' : 's')] : []);
      const hallsWords = u.rights.allHalls ? 'Every hall' : (listed.join(', ') || 'None');
      tr.innerHTML =
        '<td><strong>' + esc(u.name) + '</strong><br><span class="muted">' + esc(u.username) + (u.disabled ? ' · turned off' : '') + (u.mustChange ? ' · one-time password' : '') + '</span></td>' +
        '<td>' + esc(roleOf(u.role).label) + (u.grant.length || u.revoke.length ? ' <span class="muted" title="Rights changed for this person">(adjusted)</span>' : '') + '</td>' +
        '<td>' + esc(hallsWords) + '</td>' +
        '<td>' + (u.lastLoginAt ? esc(AGM.ago(u.lastLoginAt)) : '<span class="muted">Never</span>') + (u.sessions ? ' <span class="muted">· ' + esc(String(u.sessions)) + ' device' + (u.sessions === 1 ? '' : 's') + '</span>' : '') + '</td>';
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = 'Edit';
      if (u.locked) { b.disabled = true; b.textContent = u.locked.startsWith('Only an admin') ? 'Admin only' : 'Locked'; b.title = u.locked; } else b.onclick = () => openEditor(u);
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
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
    if (u) $('disableBtn').textContent = u.disabled ? 'Turn on' : 'Turn off';
    $('userDialog').showModal();
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

  $('userForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if (saving) return;
    saving = true; $('userSave').disabled = true;
    try {
      const change = formChange();
      const r = editing
        ? await AGM.api('PATCH', '/api/users/' + encodeURIComponent(editing.id), change)
        : await AGM.api('POST', '/api/users', { ...change, username: $('uUser').value.trim().toLowerCase() });
      if (!r.ok) { $('userError').textContent = r.error; $('userError').hidden = false; return; }
      $('userDialog').close();
      if (r.password) showSecret(r.user.name, r.password);
      else AGM.toast(editing ? 'Saved — ' + (r.changed.length ? 'their open pages reconnect with the new rights.' : 'nothing changed.') : 'Added.');
      load();
    } finally { saving = false; $('userSave').disabled = false; }
  });

  async function act(method, url, body, done) {
    const r = await AGM.api(method, url, body);
    if (!r.ok) { $('userError').textContent = r.error; $('userError').hidden = false; return null; }
    $('userDialog').close();
    if (done) done(r);
    load();
    return r;
  }
  $('resetBtn').addEventListener('click', () => act('POST', '/api/users/' + encodeURIComponent(editing.id) + '/password', {}, (r) => showSecret(editing.name, r.password)));
  $('signOutAllBtn').addEventListener('click', () => act('POST', '/api/users/' + encodeURIComponent(editing.id) + '/signout', {}, () => AGM.toast(editing.name + ' is signed out on every device.')));
  $('disableBtn').addEventListener('click', () => act('PATCH', '/api/users/' + encodeURIComponent(editing.id), { disabled: !editing.disabled }, () => AGM.toast(editing.disabled ? 'Turned on.' : 'Turned off — signed out everywhere.')));
  $('removeBtn').addEventListener('click', () => {
    if (!confirm('Remove ' + editing.name + '\'s account? Their messages stay; they can no longer sign in.')) return;
    act('DELETE', '/api/users/' + encodeURIComponent(editing.id), undefined, () => AGM.toast('Removed.'));
  });

  function showSecret(who, pw) {
    $('secretWho').textContent = who;
    $('secretValue').textContent = pw;
    $('secretDialog').showModal();
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
  async function loadAudit() {
    const r = await AGM.api('GET', '/api/audit?limit=300');
    if (!r.ok) { AGM.toast(r.error, true); return; }
    signKey = r.key && typeof r.key.fingerprint === 'string' ? r.key.fingerprint : '';
    const kid = r.key && typeof r.key.kid === 'string' ? r.key.kid : '';
    $('auditKey').textContent = !r.key ? '' : (kid ? 'Keyed with key ' + kid + '. ' : 'Not keyed this run: it has no machine key. ')
      + (signKey ? 'Exports are signed with the key ' + signKey.match(/.{4}/g).join(' ') + ': whoever checks one compares it with their own record of this key (the show\'s paperwork), never with the export.' : 'No export can be signed this run.');
    const ol = $('auditList');
    ol.textContent = '';
    for (const e of r.entries) {
      const li = document.createElement('li');
      li.className = 'audit-row';
      li.dataset.mark = MARKS[e.mark] ? e.mark : 'broken';
      // A line that is not a whole entry is said as one, never drawn as an entry.
      if (!e.actor) {
        li.dataset.action = 'bad';
        li.innerHTML = markHtml('broken') + '<span class="audit-words audit-bad">✕ ' + esc(e.words || 'a line that is not a whole entry') + '</span>';
        ol.appendChild(li);
        continue;
      }
      li.dataset.action = e.action.split('.')[0];
      li.innerHTML = markHtml(e.mark) +
        '<time datetime="' + esc(new Date(e.at).toISOString()) + '">' + esc(new Date(e.at).toLocaleString()) + '</time>' +
        '<span class="audit-actor">' + esc(e.actor.name || e.actor.t) + '</span>' +
        '<span class="audit-action">' + esc(e.action) + (e.target ? ' <em>' + esc(e.target) + '</em>' : '') + '</span>' +
        '<span class="audit-words">' + esc(e.words) + (e.ip ? ' <span class="muted">from ' + esc(e.ip) + '</span>' : '') + '</span>';
      ol.appendChild(li);
    }
  }
  // One check at a time: the button rests while the server reads the chain (every file of it). The answer's mark is drawn
  // with its shape; an answer with no mark this page knows reads "Not checked", never ✓.
  $('verifyBtn').addEventListener('click', async () => {
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
  });

  $('exportBtn').addEventListener('click', () => { window.AGMAuditExport.open({ fingerprint: signKey, done: () => { loadAudit(); } }); });

  load().then(() => { if (location.hash === '#audit') tab('audit'); });
})();
