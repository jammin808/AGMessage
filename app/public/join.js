// The way in: sign in with an account, or join a room with its code. The first admin is made here too, with the
// laptop's token, and a one-time password is changed here before anything else.
(function () {
  'use strict';
  if (document.documentElement.dataset.floor === 'old') return;   // below the page floor (theme-init.js): its words, and nothing else
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
    panes[which].querySelector('input, a').focus();
  }
  $('tabSignIn').addEventListener('click', () => show('signIn'));
  $('tabCode').addEventListener('click', () => show('code'));
  const fail = (id, text) => { const e = $(id); e.textContent = text; e.hidden = !text; };

  // ---------------------------------------------------------------- where this person stands
  (async () => {
    const h = await AGM.api('GET', '/api/health');
    if (h.build) $('buildTag').textContent = 'AGMessage ' + h.build;
    const me = await AGM.api('GET', '/api/auth/me');
    if (me.account && me.account.mustChange) { onlyPane('changePane'); $('changeUser').value = me.account.username; return; }
    if (params.get('code')) { if (me.account) signedIn(me.account); show('code'); return; }
    if (me.account) { location.replace('/halls.html'); return; }
    if (me.setup) onlyPane('setupPane');
  })();

  /**
   * A signed-in browser that followed a code link: the code tab says it enters by its account, as the server's refusal
   * of its code join does, and offers its halls or signing out (after which the code is there to use).
   */
  function signedIn(account) {
    panes.code = $('signedInPane');
    $('tabCode').setAttribute('aria-controls', 'signedInPane');
    $('signedInText').textContent = 'You are signed in as ' + (account.name || account.username) + ': open your halls, or sign out to join with a code.';
  }
  $('signOutBtn').addEventListener('click', async () => {
    fail('signOutError', '');
    const r = await AGM.api('POST', '/api/auth/logout');
    if (!r.ok) { fail('signOutError', r.error); return; }
    location.reload();
  });

  /** One pane alone, without the tabs: the first admin's setup, or a one-time password to change. */
  function onlyPane(id) {
    for (const el of document.querySelectorAll('.entry-pane')) el.hidden = el.id !== id;
    document.querySelector('.entry-tabs').hidden = true;
  }

  // Where a sign-in goes next: one of AGMessage's own pages, named here, with the query the link asked for. Nothing the
  // link carries chooses another site, a scheme (javascript:) or a path of its own.
  const NEXT_PAGES = ['/halls.html', '/users.html', '/admin.html', '/app.html'];
  function nextPage() {
    let u;
    try { u = new URL(params.get('next') || '/halls.html', location.origin); } catch { return '/halls.html'; }
    const page = u.origin === location.origin ? NEXT_PAGES.find((x) => x === u.pathname) : undefined;
    if (!page) return '/halls.html';
    const q = new URLSearchParams(u.search).toString();
    return page + (q ? '?' + q : '');
  }

  // ---------------------------------------------------------------- sign in
  $('signInPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('signInError', '');
    const r = await AGM.api('POST', '/api/auth/login', { username: $('username').value.trim(), password: $('password').value });
    if (!r.ok) { fail('signInError', r.error); $('password').select(); return; }
    if (r.mustChange) { onlyPane('changePane'); $('changeUser').value = r.account.username; $('changeCurrent').value = $('password').value; $('changeNext').focus(); return; }
    location.replace(nextPage());
  });

  // One first admin: while the request is out, a second click or Enter sends nothing (the server holds it to one anyway).
  let settingUp = false;
  $('setupPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (settingUp) return;
    const btn = $('setupPane').querySelector('button[type="submit"]');
    settingUp = true; btn.disabled = true;
    fail('setupError', '');
    try {
      const r = await AGM.api('POST', '/api/setup', { token: $('setupToken').value.trim(), name: $('setupName').value.trim(), username: $('setupUser').value.trim(), password: $('setupPass').value });
      if (!r.ok) { fail('setupError', r.error); if (r.status === 401 || r.status === 429) $('setupToken').select(); return; }
      location.replace('/halls.html');
    } finally { settingUp = false; btn.disabled = false; }
  });

  $('changePane').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('changeError', '');
    const r = await AGM.api('POST', '/api/auth/password', { current: $('changeCurrent').value, next: $('changeNext').value });
    if (!r.ok) { fail('changeError', r.error); return; }
    location.replace('/halls.html');
  });

  // ---------------------------------------------------------------- join with a code
  // The code first. Once six characters have been still for half a second, or on Enter, or on leaving the field, the
  // code is looked up, once for each value (each miss counts against the lookup's lock for everyone behind this address,
  // so a lookup on every key would let a corrected typo count), and the page names the room it opens ("Legal · Hall 2")
  // and offers that room's seats only: a hall's Main room On stage (only from an On stage invite link), Backstage and
  // Observer; a side room Member and Observer. No seat is chosen on a first visit; the seat remembered here, or an
  // invite's, is.
  const nameInput = $('name');
  const codeInput = $('code');
  const STILL_MS = 500;
  const MISS = 'No hall or room has that code. Check it with whoever gave it to you.';
  let remembered = '';
  try {
    nameInput.value = localStorage.getItem('agm.name') || '';
    remembered = (localStorage.getItem('agm.role') || '').replace(/[^a-z]/g, '');
  } catch { /* storage blocked: nothing remembered */ }
  // Invite links (?code=…&role=…&invite=…) from the admin: that seat, and the invite carried through. On stage is offered
  // only from an On stage invite link.
  const invite = params.get('invite') || '';
  const invited = invite ? (params.get('role') || '').replace(/[^a-z]/g, '') : '';
  const boardOffered = invited === 'board';
  const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (params.get('code')) codeInput.value = cleanCode(params.get('code')).slice(0, 6);

  const lookups = new Map();   // a code -> its lookup's answer (a promise), so no value is looked up twice
  let room = null;             // the answer for the code in the field, once it opens a room
  let stillTimer = null;
  /** The code's answer: asked once per value; {exists, name, hallName, main, locked} or {status: 429}. */
  function lookup(code) {
    if (!lookups.has(code)) lookups.set(code, AGM.api('GET', '/api/rooms/' + encodeURIComponent(code)));
    return lookups.get(code);
  }
  /** The code in the field looked up now (a code that is not six characters yet is none), and the page drawn from it. */
  async function settle() {
    clearTimeout(stillTimer);
    const code = codeInput.value;
    if (code.length !== 6) { drawRoom(null, ''); return null; }
    const data = await lookup(code);
    if (codeInput.value !== code) return null;   // typed on meanwhile: the newer value is drawn when it is still
    if (data.status === 429) { lookups.delete(code); drawRoom(null, 'Too many attempts — wait a minute.'); return null; }
    drawRoom(data.exists ? data : null, data.exists ? '' : MISS);
    return data.exists ? data : null;
  }
  /** The room line and its seats, or the words of a miss at the field (and no seat to choose). */
  function drawRoom(data, miss) {
    room = data;
    fail('codeError', miss);
    const line = $('roomLine');
    line.hidden = !data;
    line.textContent = !data ? '' : data.main ? data.name || 'A hall with no name' : (data.name || 'A room with no name') + ' · ' + (data.hallName || 'a hall with no name');
    $('seatSet').hidden = !data;
    if (!data) return;
    const main = data.main !== false;
    const offered = { board: main && boardOffered, research: true, observer: true };
    for (const opt of document.querySelectorAll('#seatSet .role-option')) {
      const seat = opt.dataset.seat;
      opt.hidden = !offered[seat];
      if (!offered[seat]) opt.querySelector('input').checked = false;
    }
    $('researchWord').textContent = main ? 'Backstage' : 'Member';
    $('researchWhat').textContent = main ? 'Crew or the backstage team — messages, files, action prompts' : 'Messages and files in this room';
    // On stage is given, never chosen: said where it is not offered in a hall's Main room. A remembered On stage seat
    // falls back to Observer, never to Backstage, which downloads, shows and sends to the speaker's screen.
    const hint = $('seatHint');
    hint.textContent = main && !boardOffered ? 'On stage seats come with an invite link from the backstage team.' : '';
    hint.hidden = !hint.textContent;
    if (!document.querySelector('input[name="role"]:checked')) {
      const want = invited || remembered;
      const pick = want === 'board' && !offered.board ? 'observer' : offered[want] ? want : '';
      if (pick) document.querySelector('input[name="role"][value="' + pick + '"]').checked = true;
    }
  }
  codeInput.addEventListener('input', () => {
    const clean = cleanCode(codeInput.value).slice(0, 6);
    if (codeInput.value !== clean) codeInput.value = clean;
    clearTimeout(stillTimer);
    if (room || !$('codeError').hidden) drawRoom(null, '');
    if (clean.length === 6) stillTimer = setTimeout(settle, STILL_MS);
  });
  codeInput.addEventListener('change', settle);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    settle().then((data) => { if (data) nameInput.focus(); });
  });
  // A code that came with the link is still already.
  if (codeInput.value.length === 6) settle();

  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail('error', '');
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 6) return fail('error', 'The code has 6 characters.');
    const data = await settle();
    if (!data) { codeInput.focus(); return undefined; }
    if (!name) return fail('error', 'Type your name.');
    const picked = document.querySelector('input[name="role"]:checked');
    const role = picked ? picked.value : '';
    if (!role) return fail('error', 'Choose your seat.');
    if (role === 'board' && !invite) return fail('error', 'On stage seats need the invite link you were sent. Join Backstage or as an Observer, or ask the backstage team.');
    if (data.locked && role !== 'observer' && !invite) return fail('error', 'This room gives its ' + (data.main ? 'On stage and Backstage' : 'Member') + ' seats by invite link. Use the link you were sent, or join as an observer.');
    try { localStorage.setItem('agm.name', name); localStorage.setItem('agm.role', role); } catch { /* storage blocked: not remembered */ }
    const qs = new URLSearchParams({ code, name, role });
    if (invite) qs.set('invite', invite);
    location.href = '/app.html?' + qs.toString();
    return undefined;
  });
})();
