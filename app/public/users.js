// Accounts and the audit log. An admin (or anyone given users.manage) adds people with a role, their halls and any
// exception to the role's rights; a new person gets a one-time password shown once. The audit log reads newest first
// and checks its own chain on demand.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = AGM.esc;
  AGM.theme();

  let data = null;          // {users, roles, caps, halls}
  let editing = null;       // the account being edited, or null for a new one

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
    $('who').textContent = me.account.name + ' · ' + me.account.rights.roleLabel;
    const canUsers = me.account.rights.caps.includes('users.manage');
    const canAudit = me.account.rights.caps.includes('audit.read');
    $('tabPeople').hidden = !canUsers;
    if (!canUsers && canAudit) tab('audit');
    if (!canUsers) return;
    const r = await AGM.api('GET', '/api/users');
    if (!r.ok) { AGM.toast(r.error, true); return; }
    data = r;
    renderUsers();
  }

  const roleOf = (id) => data.roles.find((r) => r.id === id) || { label: id, caps: [], allHalls: false };
  const hallName = (code) => { const h = data.halls.find((x) => x.code === code); return h ? (h.name || h.code) : code; };

  function renderUsers() {
    const tb = $('userRows');
    tb.textContent = '';
    for (const u of data.users) {
      const tr = document.createElement('tr');
      if (u.disabled) tr.className = 'off';
      const hallsWords = u.rights.allHalls ? 'Every hall' : (u.rights.halls.map(hallName).join(', ') || 'None');
      tr.innerHTML =
        '<td><strong>' + esc(u.name) + '</strong><br><span class="muted">' + esc(u.username) + (u.disabled ? ' · turned off' : '') + (u.mustChange ? ' · one-time password' : '') + '</span></td>' +
        '<td>' + esc(roleOf(u.role).label) + (u.grant.length || u.revoke.length ? ' <span class="muted" title="Rights changed for this person">(adjusted)</span>' : '') + '</td>' +
        '<td>' + esc(hallsWords) + '</td>' +
        '<td>' + (u.lastLoginAt ? esc(AGM.ago(u.lastLoginAt)) : '<span class="muted">Never</span>') + (u.sessions ? ' <span class="muted">· ' + esc(String(u.sessions)) + ' device' + (u.sessions === 1 ? '' : 's') + '</span>' : '') + '</td>';
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = 'Edit';
      if (u.locked) { b.disabled = true; b.textContent = 'Admin only'; b.title = u.locked; } else b.onclick = () => openEditor(u);
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------- the editor
  function openEditor(u) {
    editing = u || null;
    $('userTitle').textContent = u ? 'Edit ' + u.name : 'Add a person';
    $('userError').hidden = true;
    $('uName').value = u ? u.name : '';
    $('uUser').value = u ? u.username : '';
    $('uUser').disabled = !!u;
    const sel = $('uRole');
    sel.textContent = '';
    for (const r of data.roles) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; sel.appendChild(o); }
    sel.value = u ? u.role : 'staff';
    const hallsBox = $('uHalls');
    hallsBox.textContent = '';
    for (const h of data.halls) {
      const l = document.createElement('label'); l.className = 'check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.value = h.code; c.checked = !!(u && u.halls.includes(h.code));
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + (h.name || h.code) + ' (' + h.code + ')'));
      hallsBox.appendChild(l);
    }
    if (!data.halls.length) hallsBox.textContent = 'No halls yet.';
    $('uAll').checked = u ? u.rights.allHalls : roleOf(sel.value).allHalls;
    $('uAll').dataset.touched = u && u.allHalls !== null ? '1' : '';
    renderCaps(u);
    $('userDanger').hidden = !u;
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
      const on = u ? (fromRole ? !u.revoke.includes(cap) : u.grant.includes(cap)) : fromRole;
      const l = document.createElement('label'); l.className = 'check';
      const c = document.createElement('input'); c.type = 'checkbox'; c.value = cap; c.checked = on;
      l.appendChild(c);
      const t = document.createElement('span');
      t.textContent = ' ' + words;
      if (on !== fromRole) { const m = document.createElement('em'); m.className = 'muted'; m.textContent = on ? ' (added)' : ' (removed)'; t.appendChild(m); }
      l.appendChild(t);
      box.appendChild(l);
    }
  }
  $('uRole').addEventListener('change', () => {
    if (!$('uAll').dataset.touched) $('uAll').checked = roleOf($('uRole').value).allHalls;
    renderCaps(editing && editing.role === $('uRole').value ? editing : null);
  });
  $('uAll').addEventListener('change', () => { $('uAll').dataset.touched = '1'; });

  /** The form as a change: role, halls, and the rights that differ from the role's (grant / revoke). */
  function formChange() {
    const role = roleOf($('uRole').value);
    const caps = Array.from($('uCaps').querySelectorAll('input:checked')).map((c) => c.value);
    const change = {
      name: $('uName').value.trim(), role: role.id,
      halls: Array.from($('uHalls').querySelectorAll('input:checked')).map((c) => c.value),
      grant: caps.filter((c) => !role.caps.includes(c)),
      revoke: role.caps.filter((c) => !caps.includes(c)),
    };
    if ($('uAll').dataset.touched || $('uAll').checked !== role.allHalls) change.allHalls = $('uAll').checked;
    return change;
  }

  $('userForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const change = formChange();
    const r = editing
      ? await AGM.api('PATCH', '/api/users/' + encodeURIComponent(editing.id), change)
      : await AGM.api('POST', '/api/users', { ...change, username: $('uUser').value.trim().toLowerCase() });
    if (!r.ok) { $('userError').textContent = r.error; $('userError').hidden = false; return; }
    $('userDialog').close();
    if (r.password) showSecret(r.user.name, r.password);
    else AGM.toast(editing ? 'Saved — ' + (r.changed.length ? 'their open pages reconnect with the new rights.' : 'nothing changed.') : 'Added.');
    load();
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
  async function loadAudit() {
    const r = await AGM.api('GET', '/api/audit?limit=300');
    if (!r.ok) { AGM.toast(r.error, true); return; }
    const ol = $('auditList');
    ol.textContent = '';
    for (const e of r.entries) {
      const li = document.createElement('li');
      li.className = 'audit-row';
      li.dataset.action = e.action.split('.')[0];
      li.innerHTML =
        '<time datetime="' + esc(new Date(e.at).toISOString()) + '">' + esc(new Date(e.at).toLocaleString()) + '</time>' +
        '<span class="audit-actor">' + esc(e.actor.name || e.actor.t) + '</span>' +
        '<span class="audit-action">' + esc(e.action) + (e.target ? ' <em>' + esc(e.target) + '</em>' : '') + '</span>' +
        '<span class="audit-words">' + esc(e.words) + (e.ip ? ' <span class="muted">from ' + esc(e.ip) + '</span>' : '') + '</span>';
      ol.appendChild(li);
    }
  }
  // One check at a time: the button rests while the server reads the chain (every file of it), and only an answer that
  // says intact reads as intact.
  $('verifyBtn').addEventListener('click', async () => {
    const btn = $('verifyBtn');
    const el = $('chainState');
    btn.disabled = true;
    el.dataset.ok = '';
    el.textContent = 'Checking the whole log…';
    try {
      const r = await AGM.api('GET', '/api/audit/verify');
      const intact = r.ok === true && !r.why && Number.isInteger(r.entries);
      el.dataset.ok = intact ? '1' : '0';
      if (r.why) el.textContent = '✕ Broken' + (r.brokenAt ? ' at line ' + r.brokenAt : '') + (r.file && r.file !== 'audit.jsonl' ? ' of ' + r.file : '') + ': ' + r.why;
      else if (!intact) el.textContent = '✕ Not checked: ' + (r.error || 'no answer from the server');
      else el.textContent = '✓ Intact — ' + r.entries + ' entries' + (r.unwritten ? ' · ⚠ ' + r.unwritten + ' newer not yet on disk (the disk would not take them; they are tried again with the next entry)' : '');
    } finally { btn.disabled = false; }
  });

  load().then(() => { if (location.hash === '#audit') tab('audit'); });
})();
