'use strict';
// Signing in and the sessions behind it, end to end: what a refused sign-in says and writes down (never that a password
// was right, never a password typed into the username box), whom a stranger's wrong passwords hold back, the cookie
// through the tunnel, a flood of guesses through the tunnel, the open pages a session takes with it when it ends, admin
// rights through the tunnel after sign-in, a page in use all day, and what a restart keeps.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startServer, stopServer, api, connect, emit, once, wait, until, TOKEN } = require('./helpers');

let addr = 0;
/** Cloudflare's headers for a visitor at an address of its own (each address has its own sign-in allowance). */
const visitor = (extra = {}) => ({ 'cf-connecting-ip': '2001:db8::' + (++addr).toString(16), 'cf-ray': '8a1b2c3d4e5f-' + addr, ...extra });
const login = (base, username, password, headers = {}) => api(base, 'POST', '/api/auth/login', { username, password }, { headers });
const auditOf = async (base, cookie) => (await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie })).body.entries;
/** A socket with headers of its own (the tunnel's, beside the cookie). */
const connectWith = (base, headers) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: headers });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
/** An event whose only argument is its answer (admin:listRooms). */
const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });
const ANA = { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' };

// ---------------------------------------------------------------- what a refused sign-in says and writes down
test('a refused sign-in never says a password was right, nor writes down a password typed into the username box', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(base, 'POST', '/api/setup', ANA)).cookie;
  assert.equal((await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin })).status, 200);
  const dee = (await api(base, 'POST', '/api/users', { username: 'dee', name: 'Dee Former', role: 'staff', password: 'old crew password here' }, { cookie: admin })).body.user;
  assert.equal((await api(base, 'PATCH', '/api/users/' + dee.id, { disabled: true }, { cookie: admin })).status, 200);
  const lastLogin = async () => (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.find((u) => u.username === 'ana').lastLoginAt;

  await t.test('through the tunnel an admin\'s right password is answered as a wrong one, and is no sign-in', async () => {
    const before = await lastLogin();
    const wrong = await login(base, 'ana', 'not the password at all', visitor());
    const right = await login(base, 'ana', ANA.password, visitor());
    const nobody = await login(base, 'nobody', 'not the password at all', visitor());
    assert.equal(right.cookie, '', 'no session is handed out');
    for (const r of [right, nobody]) assert.deepEqual([r.status, r.body.error], [wrong.status, wrong.body.error], 'the same answer');
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /venue network/, 'the words say where admin rights sign in');
    assert.equal(await lastLogin(), before, 'a refused sign-in is not recorded as one');
    assert.ok((await auditOf(base, admin)).some((e) => e.action === 'login.refused' && e.target === 'ana'), 'the audit log tells them apart');
    // Allowed by the admin, the same password signs in through the tunnel.
    const ctl = await connect(base, admin); sockets.push(ctl);
    assert.equal((await emit(ctl, 'admin:settings', { remoteAdmin: true })).remoteAdmin, true);
    const allowed = await login(base, 'ana', ANA.password, visitor());
    assert.equal(allowed.status, 200);
    assert.match(allowed.cookie, /^agm_s=/);
    assert.ok(await lastLogin() > before, 'a sign-in is recorded');
    assert.equal((await emit(ctl, 'admin:settings', { remoteAdmin: false })).remoteAdmin, false);
  });

  await t.test('a turned-off account: the right password and a wrong one get the same answer, and the log says why', async () => {
    const wrong = await login(base, 'dee', 'not the password at all', visitor());
    const right = await login(base, 'dee', 'old crew password here', visitor());
    assert.deepEqual([right.status, right.body.error, right.cookie], [wrong.status, wrong.body.error, '']);
    const rows = (await auditOf(base, admin)).filter((e) => e.action === 'login.fail' && e.target === 'dee');
    assert.deepEqual(rows.map((e) => e.words).sort(), ['the account is turned off', 'wrong password']);
  });

  await t.test('a passphrase typed into the username box is not written down; a real account\'s failure still is', async () => {
    assert.equal((await login(base, ANA.password, 'ana')).status, 401, 'the boxes swapped');
    assert.equal((await login(base, 'ana', ANA.password)).status, 200);
    assert.equal((await login(base, 'pat', 'not the password at all')).status, 401);
    const pat = (await login(base, 'pat', 'clipboard and coffee')).cookie;
    const entries = await auditOf(base, pat);
    assert.ok(entries.some((e) => e.action === 'login.fail' && e.target === '(unknown username)' && e.words === 'no such username'));
    assert.ok(entries.some((e) => e.action === 'login.fail' && e.target === 'pat' && e.actor.name === 'pat' && /^a/.test(e.actor.id)), 'a real account\'s failure names it');
    assert.ok(!JSON.stringify(entries).includes(ANA.password), 'not on the audit page a project manager reads');
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').includes(ANA.password), 'nor in the file');
    assert.equal((await api(base, 'GET', '/api/audit/verify', undefined, { cookie: pat })).body.ok, true);
  });
});

// ---------------------------------------------------------------- whom wrong passwords hold, and the cookie
test('a stranger\'s wrong passwords hold a username only where the stranger is; the cookie is Secure when the browser used HTTPS', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const admin = (await api(base, 'POST', '/api/setup', { ...ANA, password: 'gaffer tape and coffee' })).cookie;
  const sam = (await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech' }, { cookie: admin })).body;
  assert.equal((await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin })).status, 200);
  const strangerTries = async (username) => {
    const from = visitor();
    for (let i = 0; i < 5; i++) assert.equal((await login(base, username, 'wrong guess ' + i, from)).status, 401);
  };

  await t.test('five through the tunnel do not hold the admin on the AGMessage laptop', async () => {
    await strangerTries('ana');
    const right = await login(base, 'ana', 'gaffer tape and coffee');
    assert.equal(right.status, 200, JSON.stringify(right.body));
  });

  await t.test('nor a signed-in person changing their own password; through the tunnel the name stays held', async () => {
    const first = await login(base, 'sam', sam.password);
    assert.equal(first.status, 200);
    await strangerTries('sam');
    assert.equal((await login(base, 'sam', sam.password, visitor())).status, 429, 'guessing a name through the tunnel stays at five per 15 minutes, from any address');
    const changed = await api(base, 'POST', '/api/auth/password', { current: sam.password, next: 'mixing desk on stage left' }, { cookie: first.cookie });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  });

  await t.test('an admin\'s new one-time password ends the wait', async () => {
    const reset = await api(base, 'POST', '/api/users/' + sam.user.id + '/password', {}, { cookie: admin });
    assert.equal(reset.status, 200);
    assert.equal((await login(base, 'sam', reset.body.password, visitor())).status, 200);
  });

  await t.test('the session cookie is Secure when the browser came over HTTPS through the tunnel, and only then', async () => {
    const setCookie = (r) => r.headers.get('set-cookie') || '';
    const plain = await login(base, 'pat', 'clipboard and coffee');
    assert.equal(plain.status, 200);
    assert.doesNotMatch(setCookie(plain), /Secure/i, 'plain HTTP on the venue network');
    const https = { 'cf-visitor': '{"scheme":"https"}', 'x-forwarded-proto': 'https' };
    const through = await login(base, 'pat', 'clipboard and coffee', visitor(https));
    assert.equal(through.status, 200);
    assert.match(setCookie(through), /^agm_s=[A-Za-z0-9_-]{32,};.*;\s*Secure$/i);
    const out = await api(base, 'POST', '/api/auth/logout', {}, { cookie: through.cookie, headers: visitor(https) });
    assert.match(setCookie(out), /Max-Age=0; Secure$/, 'the clearing cookie carries Secure too, or the browser keeps the old one');
    assert.doesNotMatch(setCookie(await login(base, 'pat', 'clipboard and coffee', visitor({ 'cf-visitor': '{"scheme":"http"}' }))), /Secure/i, 'a visitor on http://');
  });
});

// ---------------------------------------------------------------- a flood of guesses through the tunnel
test('a flood of guesses through the tunnel holds no sign-in on the venue network; guesses whose senders gave up are not hashed', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  assert.equal((await api(base, 'POST', '/api/setup', ANA)).status, 200);
  const failLines = () => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"login.fail"')).length;
  // One hash, timed on a name that is an account: the flood below is the first to ask about names that are none, as after
  // a restart, so the hash those are checked against is not made yet when it starts.
  const t1 = Date.now();
  await login(base, 'ana', 'not the password');
  const oneHash = Math.max(Date.now() - t1, 100);
  const N = 120;
  const guess = (i, signal) => fetch(base + '/api/auth/login', {
    method: 'POST', signal, headers: { 'content-type': 'application/json', ...visitor() }, body: JSON.stringify({ username: 'guess' + i, password: 'wrong password ' + i }),
  }).then((r) => r.status, () => 'gone');

  await t.test('while guesses wait, a venue sign-in goes straight through, and guesses past a short queue are told busy at once', async () => {
    const flood = Array.from({ length: N }, (_, i) => guess(i));
    await wait(100);
    const t0 = Date.now();
    const real = await login(base, 'ana', ANA.password);
    const ms = Date.now() - t0;
    const statuses = await Promise.all(flood);
    assert.equal(real.status, 200);
    assert.ok(ms < 4 * oneHash + 500, 'the venue sign-in waited ' + ms + ' ms (one hash: ' + oneHash + ' ms)');
    assert.ok(statuses.filter((st) => st === 429).length > N / 2, 'most guesses were told busy, not queued: ' + JSON.stringify(statuses));
  });

  await t.test('guesses whose senders gave up leave the queue unhashed and unlogged', async () => {
    const before = failLines();
    const flood = [];
    for (let i = 0; i < N; i++) {
      const ac = new AbortController();
      flood.push(guess(1000 + i, ac.signal));
      setTimeout(() => ac.abort(), 300);
    }
    await Promise.all(flood);
    const t0 = Date.now();
    const real = await login(base, 'ana', ANA.password);
    const ms = Date.now() - t0;
    await wait(300);
    assert.equal(real.status, 200);
    assert.ok(ms < 10 * oneHash, 'the crew sign-in waited ' + ms + ' ms (one hash: ' + oneHash + ' ms)');
    assert.ok(failLines() - before < N / 2, (failLines() - before) + ' guesses were hashed and logged after their senders left');
  });
});

// ---------------------------------------------------------------- the pages a session has open
test('when a session ends its open pages end with it; admin rights through the tunnel are judged on every request and socket', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(base, 'POST', '/api/setup', ANA)).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  assert.equal((await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall], password: 'mixing desk on stage left' }, { cookie: admin })).status, 200);

  await t.test('signing out on the halls board ends what the open hall tab may do', async () => {
    const sam = (await login(base, 'sam', 'mixing desk on stage left')).cookie;
    const tab = await connect(base, sam); sockets.push(tab);
    assert.ok((await emit(tab, 'join', { roomCode: hall, as: 'account' })).ok);
    assert.ok((await emit(tab, 'message', { type: 'text', text: 'before sign-out' })).ok);
    const told = once(tab, 'account:changed', 1000);
    const gone = once(tab, 'disconnect', 1000);
    assert.equal((await api(base, 'POST', '/api/auth/logout', {}, { cookie: sam })).status, 200);
    assert.equal((await api(base, 'GET', '/api/halls', undefined, { cookie: sam })).status, 401);
    assert.equal((await told).what, 'signout', 'the tab is told');
    await gone;
    const again = await connect(base, sam); sockets.push(again);
    assert.equal((await emit(again, 'join', { roomCode: hall, as: 'account' })).signIn, true, 'and its next connection must sign in');
  });

  await t.test('the host token\'s logout ends admin:* on every page it has open', async () => {
    const tok = await api(base, 'POST', '/api/admin/login', { token: TOKEN });
    const page = await connect(base, tok.cookie); sockets.push(page);
    assert.equal((await ask(page, 'admin:listRooms')).ok, true);
    const told = once(page, 'account:changed', 1000);
    const gone = once(page, 'disconnect', 1000);
    assert.equal((await api(base, 'POST', '/api/admin/logout', {}, { cookie: tok.cookie })).status, 200);
    assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: tok.cookie })).body.ok, false);
    await told; await gone;
    assert.ok((await auditOf(base, admin)).some((e) => e.action === 'logout.token'), 'and the audit log has it');
  });

  await t.test('a right granted after a tunnel sign-in does not work through the tunnel', async () => {
    const pat = (await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin })).body.user;
    const from = visitor();
    const signedIn = await login(base, 'pat', 'clipboard and coffee', from);
    assert.equal(signedIn.status, 200, 'a project manager signs in through the tunnel');
    assert.equal((await api(base, 'PATCH', '/api/users/' + pat.id, { grant: ['users.manage'] }, { cookie: admin })).status, 200);
    for (const [method, body] of [['GET', undefined], ['POST', { username: 'eve', name: 'Eve', role: 'staff' }]]) {
      const r = await api(base, method, '/api/users', body, { cookie: signedIn.cookie, headers: from });
      assert.equal(r.status, 403, method + ' /api/users through the tunnel on the older session: ' + r.status);
    }
    const fresh = await login(base, 'pat', 'clipboard and coffee', visitor());
    assert.deepEqual([fresh.status, fresh.cookie], [401, ''], 'a fresh tunnel sign-in is refused');
    const halls = await api(base, 'GET', '/api/halls', undefined, { cookie: signedIn.cookie, headers: from });
    assert.deepEqual([halls.status, halls.body.canManageUsers], [200, false], 'the halls board offers no Accounts page there');
    assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: signedIn.cookie })).status, 200, 'on the venue network it may');
  });

  await t.test('turning admin through the tunnel off ends it on tunnel sessions and tunnel sockets at once', async () => {
    const ctl = await connect(base, admin); sockets.push(ctl);
    assert.equal((await emit(ctl, 'admin:settings', { remoteAdmin: true })).remoteAdmin, true);
    assert.equal((await api(base, 'POST', '/api/users', { username: 'bob', name: 'Bob Admin', role: 'admin', password: 'second desk lamp over there' }, { cookie: admin })).status, 200);
    const from = visitor();
    const bob = await login(base, 'bob', 'second desk lamp over there', from);
    assert.equal(bob.status, 200, 'allowed: an admin signs in through the tunnel');
    const sock = await connectWith(base, { cookie: bob.cookie, ...from }); sockets.push(sock);
    assert.equal((await ask(sock, 'admin:listRooms')).ok, true, 'and is admin on its socket');
    const told = once(sock, 'account:changed', 1000);
    const gone = once(sock, 'disconnect', 1000);
    assert.equal((await emit(ctl, 'admin:settings', { remoteAdmin: false })).remoteAdmin, false);
    assert.equal((await told).what, 'remoteAdmin');
    await gone;
    await wait(100);
    assert.equal(ctl.connected, true, 'the admin on the venue network keeps their page');
    assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: bob.cookie, headers: from })).status, 403);
    assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: bob.cookie, headers: from })).body.ok, false);
    const back = await connectWith(base, { cookie: bob.cookie, ...from }); sockets.push(back);
    assert.equal((await ask(back, 'admin:listRooms')).ok, false, 'its next connection is no admin');
  });
});

// ---------------------------------------------------------------- a page in use all day
const CLOCK = path.join(__dirname, 'clock-preload.js');
async function serverWithClock() {
  const clock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-clock-')), 'offset');
  fs.writeFileSync(clock, '0');
  const preload = '--require "' + CLOCK.split(path.sep).join('/') + '"';   // forward slashes: no escapes inside the quotes
  const srv = await startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_CLOCK: clock, AGM_SESSION_SWEEP_MS: '100' });
  const setClock = async (ms) => {
    fs.writeFileSync(clock, String(ms));
    await until(() => { try { return fs.readFileSync(clock + '.ack', 'utf8') === String(ms); } catch { return false; } }, 3000, 'the server on the moved clock');
  };
  return { ...srv, setClock };
}

test('a page in use all day keeps its session past 14 hours; an idle one still ends; seven days ends even an open one', async (t) => {
  const HOUR = 3600_000;
  const srv = await serverWithClock();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const ana = (await api(base, 'POST', '/api/setup', ANA)).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie: ana })).body.code;
  assert.equal((await api(base, 'POST', '/api/users', { username: 'kim', name: 'Kim Staff', role: 'staff', halls: [hall], password: 'a quiet desk lamp here' }, { cookie: ana })).status, 200);
  const idle = (await login(base, 'kim', 'a quiet desk lamp here')).cookie;   // signed in, then nothing open
  const tok = (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const h = crypto.createHash('sha256').update(decodeURIComponent(ana.slice('agm_s='.length))).digest('hex');
  const seen = () => {
    try { const s = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'sessions.json'), 'utf8')).sessions.find((x) => x.h === h); return s ? s.seen : 0; } catch { return 0; }
  };
  const T0 = Date.now();
  const page = await connect(base, ana); sockets.push(page);
  assert.ok((await emit(page, 'join', { roomCode: hall, as: 'account' })).ok);
  const dash = await connect(base, tok); sockets.push(dash);
  for (const hour of [7, 14.5]) {
    await srv.setClock(hour * HOUR);
    await until(() => seen() >= T0 + hour * HOUR - 60_000, 5000, 'the open page\'s session in use at hour ' + hour);
  }
  page.close();   // a Wi-Fi blip, 14.5 h after sign-in with no HTTP request since
  const again = await connect(base, ana); sockets.push(again);
  const j = await emit(again, 'join', { roomCode: hall, as: 'account' });
  assert.equal(j.ok, true, 'the page rejoins as its account: ' + JSON.stringify(j));
  assert.equal((await api(base, 'GET', '/api/auth/me', undefined, { cookie: idle })).body.account, null, 'a session with nothing open is idle, and ends');
  const told = once(again, 'account:changed', 3000);
  const gone = once(again, 'disconnect', 3000);
  const dashTold = once(dash, 'account:changed', 3000);
  await srv.setClock(7 * 24 * HOUR + HOUR);
  assert.equal((await told).what, 'expired', 'seven days on, the open page is told and closed');
  await gone;
  await dashTold;   // and the admin token's day is over too
});

// ---------------------------------------------------------------- what a restart keeps
test('a restart keeps the admin token\'s sign-in; one account signing in again and again signs nobody else out', async (t) => {
  let srv = await startServer();
  const { dataDir } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const tok = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  assert.match(tok, /^agm_admin=/);
  const ana = (await api(srv.base, 'POST', '/api/setup', ANA)).cookie;
  const vic = (await api(srv.base, 'POST', '/api/users', { username: 'vic', name: 'Vic Viewer', role: 'viewer', password: 'a viewer password here' }, { cookie: ana })).body.user;
  assert.equal((await login(srv.base, 'vic', 'a viewer password here', visitor())).status, 200);
  await stopServer(srv.child);
  // What 5000 more sign-ins of the viewer leave behind, without ten minutes of hashing.
  const file = path.join(dataDir, 'sessions.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mine = data.sessions.find((x) => x.uid === vic.id);
  const now = Date.now();
  while (data.sessions.length < 5000) data.sessions.push({ ...mine, h: crypto.randomBytes(32).toString('hex'), created: now, seen: now });
  fs.writeFileSync(file, JSON.stringify(data));
  srv = await startServer({ AGM_DATA_DIR: dataDir });
  const me = async (cookie) => (await api(srv.base, 'GET', '/api/admin/me', undefined, { cookie })).body.ok;

  await t.test('the admin token\'s sign-in survives a watchdog restart (the same token): the page and its socket', async () => {
    assert.equal(await me(tok), true);
    const s = await connect(srv.base, tok); sockets.push(s);
    assert.equal((await ask(s, 'admin:listRooms')).ok, true);
  });

  await t.test('past 5000 sessions, the viewer\'s next sign-in leaves the admin signed in', async () => {
    assert.equal((await login(srv.base, 'vic', 'a viewer password here', visitor())).status, 200);
    const still = (await api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: ana })).body.account;
    assert.equal(still && still.username, 'ana', 'the admin is still signed in');
    const users = (await api(srv.base, 'GET', '/api/users', undefined, { cookie: ana })).body.users;
    assert.ok(users.find((u) => u.username === 'vic').sessions <= 20, 'the viewer keeps its 20 newest');
  });

  await t.test('a token sign-in signed out stays out after a restart; a new token ends every earlier one', async () => {
    assert.equal((await api(srv.base, 'POST', '/api/admin/logout', {}, { cookie: tok })).status, 200);
    const tok2 = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
    sockets.forEach((s) => s.close());
    await stopServer(srv.child);
    srv = await startServer({ AGM_DATA_DIR: dataDir });
    assert.deepEqual([await me(tok), await me(tok2)], [false, true]);
    await stopServer(srv.child);
    srv = await startServer({ AGM_DATA_DIR: dataDir, ADMIN_TOKEN: 'anothertoken0001' });
    assert.equal(await me(tok2), false, 'AGMessage started again with a new token');
  });
});
