// The way in: sign in with an account, or join a hall or meeting with its code. The first admin is made here too, and a
// one-time password is changed here before anything else.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  AGM.theme();

  // ---------------------------------------------------------------- tabs
  const panes = { signIn: $('signInPane'), code: $('joinForm') };
  function show(which) {
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== which;
    $('tabSignIn').classList.toggle('active', which === 'signIn');
    $('tabCode').classList.toggle('active', which === 'code');
    $('tabSignIn').setAttribute('aria-selected', String(which === 'signIn'));
    $('tabCode').setAttribute('aria-selected', String(which === 'code'));
    (which === 'signIn' ? $('username') : $('name')).focus();
  }
  $('tabSignIn').addEventListener('click', () => show('signIn'));
  $('tabCode').addEventListener('click', () => show('code'));
  const fail = (id, text) => { const e = $(id); e.textContent = text; e.hidden = !text; };

  // ---------------------------------------------------------------- where this person stands
  (async () => {
    const h = await AGM.api('GET', '/api/health');
    if (h.build) $('buildTag').textContent = 'AGMessage ' + h.build;
    const me = await AGM.api('GET', '/api/auth/me');
    if (params.get('code')) { show('code'); return; }
    if (me.account && me.account.mustChange) { onlyPane('changePane'); $('changeUser').value = me.account.username; return; }
    if (me.account) { location.replace('/halls.html'); return; }
    if (me.setup) onlyPane('setupPane');
  })();

  /** One pane alone, without the tabs: the first admin's setup, or a one-time password to change. */
  function onlyPane(id) {
    for (const el of document.querySelectorAll('.entry-pane')) el.hidden = el.id !== id;
    document.querySelector('.entry-tabs').hidden = true;
  }

  // ---------------------------------------------------------------- sign in
  $('signInPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('signInError', '');
    const r = await AGM.api('POST', '/api/auth/login', { username: $('username').value.trim(), password: $('password').value });
    if (!r.ok) { fail('signInError', r.error); $('password').select(); return; }
    if (r.mustChange) { onlyPane('changePane'); $('changeUser').value = r.account.username; $('changeCurrent').value = $('password').value; $('changeNext').focus(); return; }
    location.replace(params.get('next') && /^\/[a-z]/.test(params.get('next')) ? params.get('next') : '/halls.html');
  });

  $('setupPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('setupError', '');
    const r = await AGM.api('POST', '/api/setup', { name: $('setupName').value.trim(), username: $('setupUser').value.trim(), password: $('setupPass').value });
    if (!r.ok) { fail('setupError', r.error); return; }
    location.replace('/halls.html');
  });

  $('changePane').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('changeError', '');
    const r = await AGM.api('POST', '/api/auth/password', { current: $('changeCurrent').value, next: $('changeNext').value });
    if (!r.ok) { fail('changeError', r.error); return; }
    location.replace('/halls.html');
  });

  // ---------------------------------------------------------------- join with a code
  const nameInput = $('name');
  const codeInput = $('code');
  try {
    nameInput.value = localStorage.getItem('agm.name') || '';
    const savedRole = localStorage.getItem('agm.role');
    const r = savedRole && document.querySelector(`input[name="role"][value="${savedRole.replace(/[^a-z]/g, '')}"]`);
    if (r) r.checked = true;
  } catch { /* storage blocked: nothing remembered */ }

  if (params.get('code')) codeInput.value = params.get('code').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Invite links (?code=…&role=board&invite=…) from the admin: pick that role and carry the invite through.
  const invite = params.get('invite') || '';
  if (invite && params.get('role')) {
    const r = document.querySelector(`input[name="role"][value="${params.get('role').replace(/[^a-z]/g, '')}"]`);
    if (r) r.checked = true;
  }
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('error', '');
    const name = nameInput.value.trim();
    const role = document.querySelector('input[name="role"]:checked')?.value || 'observer';
    const code = codeInput.value.trim().toUpperCase();
    if (!name) return fail('error', 'Type your name.');
    if (code.length !== 6) return fail('error', 'The code has 6 characters.');
    const data = await AGM.api('GET', '/api/rooms/' + encodeURIComponent(code));
    if (data.status === 429) return fail('error', 'Too many attempts — wait a minute.');
    if (!data.exists) return fail('error', 'No hall or meeting has that code. Check it with whoever gave it to you.');
    if (data.locked && role !== 'observer' && !invite) return fail('error', 'This one uses invite links for on-stage and backstage seats. Use the link you were sent, or join as an observer.');
    try { localStorage.setItem('agm.name', name); localStorage.setItem('agm.role', role); } catch { /* storage blocked: not remembered */ }
    const qs = new URLSearchParams({ code, name, role });
    if (invite) qs.set('invite', invite);
    location.href = '/app.html?' + qs.toString();
  });
})();
