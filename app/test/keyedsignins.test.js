'use strict';
// The keyed stores end to end (the 0.6.0 plan's 3-K.13): a real server on a throwaway data folder and key folder, killed
// and started again, with sign-ins and accounts written into its data folder by the test as a writer without the key
// would, or as a key holder could. The in-process half is test/keyedstore.test.js.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const acc = require('../lib/accounts');
const keyedstore = require('../lib/keyedstore');

const ANA = { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' };
const STAFF_PW = 'a quiet desk lamp here';
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');
const rowsOf = (dataDir) => read(path.join(dataDir, 'audit.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** A server killed as a crash or the watchdog's hang kill ends it: nothing saved by a stop. */
async function kill(srv) {
  if (srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  const gone = new Promise((resolve) => { srv.child.once('exit', resolve); });
  srv.child.kill('SIGKILL');
  await gone;
}
/**
 * Wait until each file of `dir` named holds what its check asks: before a kill, which saves nothing, so that the kill
 * finds the act's saves on disk. A sign-in's or an account's save lands a moment after its answer (its lane's wait: the
 * sessions' 500 ms, the token sign-ins' 100 ms, the accounts' 50 ms), and a file not there yet (a fresh folder's first
 * save) is waited for too. Every store is renamed into place whole, so each read is the old file or the new one. A stop
 * (h.stopServer, h.restartServer) saves every lane itself, so nothing waits before one.
 */
const onDisk = (dir, checks, what) => h.until(() => Object.entries(checks).every(([f, ok]) => {
  try { return ok(JSON.parse(read(path.join(dir, f)))); } catch (e) { if (e.code === 'ENOENT') return false; throw e; /* not written yet: a fresh folder's first save */ }
}), 6000, what);
/** Sign-ins of a store's file made at or after `t` (the file's own `created` stamps). */
const madeSince = (d, t) => d.sessions.filter((s) => s.created >= t).length;
const start = (srv, env = {}) => h.startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port), ...env });
/** Whether a socket with this cookie is the admin (the dashboard's own verb answers it). */
async function socketAdmin(base, cookie, headers = {}) {
  const s = await h.connect(base, cookie, { headers });
  try {
    const r = await Promise.race([new Promise((resolve) => { s.emit('admin:listRooms', resolve); }), h.wait(1500).then(() => null)]);
    return !!(r && r.ok);
  } finally { s.close(); }
}
/** A request under a Host of its own (fetch keeps the URL's): {status, body}. */
function underHost(base, method, url, host, { cookie = '', body } = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const rq = http.request(base + url, { method, headers: { host, ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: 'http://' + host } : {}) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch { json = null; /* a page: the status says enough */ } resolve({ status: res.statusCode, body: json }); });
    });
    rq.on('error', reject);
    rq.end(data);
  });
}
const adminMe = async (base, cookie, headers = {}) => (await h.api(base, 'GET', '/api/admin/me', undefined, { cookie, headers })).body;
const login = (base, username, password) => h.api(base, 'POST', '/api/auth/login', { username, password });
const tokenLogin = async (base) => (await h.api(base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;

test('a token sign-in written into admin-sessions.json is nobody: with the file\'s own tag, a hash under another key, or the file sealed under a key not the machine\'s; the file ends whole, is kept aside, and a new sign-in works', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const file = path.join(srv.dataDir, 'admin-sessions.json');
  const OTHER = keyedstore.keysFrom((label) => require('../lib/secretbox').deriveFrom(h.OTHER_KEY, label))();
  const plants = [
    ['0.5.1\'s attack: a sha256 with the file\'s own tag', (data, S) => JSON.stringify({ ...data, sessions: [...data.sessions, { h: sha256(S), created: Date.now() }] })],
    ['a hash under another key, the file as AGMessage wrote it but for that', (data, S) => read(file).replace('"sessions":[', '"sessions":[' + JSON.stringify({ h: crypto.createHmac('sha256', OTHER.id).update('token sign-in\n' + S).digest('hex'), created: Date.now() }) + ',')],
    ['the whole file sealed under a key that is not the machine\'s', (data, S) => {
      const { v, store, set, gen, kid, at, m, ...fields } = data;
      fields.sessions = [...fields.sessions, { h: crypto.createHmac('sha256', OTHER.id).update('token sign-in\n' + S).digest('hex'), created: Date.now() }];
      return keyedstore.sealText(OTHER.adminSessions, keyedstore.LABELS.adminSessions, { v, store, set, gen: gen + 1, kid, at }, fields).text;
    }],
  ];
  for (const [what, plant] of plants) {
    const t0 = Date.now();
    const genuine = await tokenLogin(srv.base);
    assert.equal((await adminMe(srv.base, genuine)).ok, true);
    await onDisk(srv.dataDir, { 'admin-sessions.json': (d) => madeSince(d, t0) >= 1 }, what + ': the token sign-in on disk');
    await kill(srv);
    const S = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, plant(JSON.parse(read(file)), S));
    srv = await start(srv);
    const planted = 'agm_admin=' + S;
    assert.equal((await adminMe(srv.base, planted)).ok, false, what + ': nobody');
    assert.equal((await h.api(srv.base, 'GET', '/api/admin/transcript/K7P2QX', undefined, { cookie: planted })).status, 403, what);
    assert.equal(await socketAdmin(srv.base, planted), false, what + ': its socket is not the admin');
    const si = (await h.api(srv.base, 'GET', '/api/health')).body.signins.adminSessions;
    assert.equal(si.state, 'ended', what);
    assert.match(si.words, /^\d+ sign-ins? ended: changed after AGMessage saved them \(kept aside as admin-sessions\.changed-.*\.json\)$/, what);
    assert.ok(rowsOf(srv.dataDir).some((e) => e.action === 'signins.ended' && e.target === 'adminSessions'), what + ': signins.ended');
    assert.ok(fs.readdirSync(srv.dataDir).some((f) => /^admin-sessions\.changed-.*\.json$/.test(f)), what + ': the changed file kept aside');
    assert.equal((await adminMe(srv.base, genuine)).ok, false, what + ': the file failed whole, the genuine sign-in with it');
  }
  assert.equal((await adminMe(srv.base, await tokenLogin(srv.base))).ok, true, 'a new token sign-in works');
});

test('an account\'s sign-in written into sessions.json is nobody, a genuine one retargeted to the admin ends with its file, and a restart keeps the genuine ones', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const t0 = Date.now();
  const ana = (await h.setupAdmin(srv.base)).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam', role: 'staff', password: STAFF_PW }, { cookie: ana })).status, 200);
  const sam = (await login(srv.base, 'sam', STAFF_PW)).cookie;
  const tok = await tokenLogin(srv.base);
  // On disk before the kill: Sam's account, both account sign-ins and the token's, and the set's record, without which
  // a fresh folder's first saves would open unrecorded rather than ok.
  await onDisk(srv.dataDir, {
    'accounts.json': (d) => d.users.some((u) => u.username === 'sam'),
    'sessions.json': (d) => madeSince(d, t0) >= 2,
    'admin-sessions.json': (d) => madeSince(d, t0) >= 1,
  }, 'the account and the three sign-ins on disk');
  const storeRecords = path.join(srv.dataDir + '-keys', 'stores');
  await h.until(() => fs.existsSync(storeRecords) && fs.readdirSync(storeRecords).some((x) => /^set-[0-9a-f]{32}\.json$/.test(x)), 6000, 'the set\'s record beside the key');
  // A restart under the same token: every genuine sign-in kept, each socket the admin it was.
  await kill(srv);
  srv = await start(srv);
  const me = async (cookie) => (await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie })).body.account;
  assert.deepEqual([(await me(ana)).username, (await me(sam)).username, (await adminMe(srv.base, tok)).ok], ['ana', 'sam', true]);
  assert.deepEqual([await socketAdmin(srv.base, ana), await socketAdmin(srv.base, tok)], [true, true]);
  const states = (await h.api(srv.base, 'GET', '/api/health')).body.signins;
  assert.deepEqual([states.accounts.state, states.sessions.state, states.adminSessions.state], ['ok', 'ok', 'ok']);
  // The admin's sign-in planted as 0.5.1 kept it: {h: sha256(T), uid: the admin's, epoch, created, seen}, into the file
  // that holds the genuine ones it ends with.
  await onDisk(srv.dataDir, { 'sessions.json': (d) => madeSince(d, t0) >= 2 }, 'the genuine sign-ins on disk');
  await kill(srv);
  const file = path.join(srv.dataDir, 'sessions.json');
  const data = JSON.parse(read(file));
  const admin = JSON.parse(read(path.join(srv.dataDir, 'accounts.json'))).users.find((u) => u.username === 'ana');
  const T = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, JSON.stringify({ ...data, sessions: [...data.sessions, { h: sha256(T), uid: admin.id, epoch: admin.epoch, created: Date.now(), seen: Date.now(), ip: '', ua: '' }] }));
  srv = await start(srv);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: 'agm_s=' + T })).body.account, null, 'the planted one is nobody');
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: ana })).body.account, null, 'and the file\'s genuine ones ended with it');
  assert.match((await h.api(srv.base, 'GET', '/api/health')).body.signins.sessions.words, /^\d+ sign-ins? ended: changed after AGMessage saved them/);
  // A Staff account's own genuine sign-in with its uid and epoch changed to the admin's: the file ends whole.
  const t1 = Date.now();
  const sam2 = (await login(srv.base, 'sam', STAFF_PW)).cookie;
  await onDisk(srv.dataDir, { 'sessions.json': (d) => madeSince(d, t1) >= 1 }, 'Sam\'s new sign-in on disk');
  await kill(srv);
  fs.writeFileSync(file, read(file).replace(/"uid":"[^"]+"/, '"uid":"' + admin.id + '"'));
  srv = await start(srv);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: sam2 })).body.account, null, 'retargeted: nobody, never the admin');
  // A new token: the token's sign-in ends silently (its tag is another token's), the account's kept.
  const t2 = Date.now();
  const ana2 = (await login(srv.base, 'ana', ANA.password)).cookie;
  const tok2 = await tokenLogin(srv.base);
  await onDisk(srv.dataDir, { 'sessions.json': (d) => madeSince(d, t2) >= 1, 'admin-sessions.json': (d) => madeSince(d, t2) >= 1 }, 'Ana\'s and the token\'s new sign-ins on disk');
  await kill(srv);
  srv = await start(srv, { ADMIN_TOKEN: 'anothertoken0002' });
  assert.deepEqual([(await adminMe(srv.base, tok2)).ok, (await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: ana2 })).body.account.username], [false, 'ana']);
  const after = (await h.api(srv.base, 'GET', '/api/health')).body.signins.adminSessions;
  assert.deepEqual([after.state, after.ended], ['ok', 0], 'ended silently: no signins.ended for a new token');
});

test('the token\'s sign-in counts only at the laptop: through the tunnel, or with a Host that is not a loopback name, it is nobody', async (t) => {
  const srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const tok = await tokenLogin(srv.base);
  assert.equal((await adminMe(srv.base, tok)).ok, true, 'at localhost it is');
  const headers = { 'cf-ray': '8a1b2c3d4e5f-LHR' };
  assert.equal((await adminMe(srv.base, tok, headers)).ok, false, 'through the tunnel');
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/transcript/K7P2QX', undefined, { cookie: tok, headers })).status, 403);
  assert.equal(await socketAdmin(srv.base, tok, headers), false);
  const host = 'agm.example:' + srv.port;
  assert.equal((await underHost(srv.base, 'GET', '/api/admin/me', host, { cookie: tok })).body.ok, false, 'under a Host that is not a loopback name');
  assert.equal((await underHost(srv.base, 'GET', '/api/admin/transcript/K7P2QX', host, { cookie: tok })).status, 403);
  assert.equal(await socketAdmin(srv.base, tok, { host }), false);
  const health = (await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: tok, headers: { 'cf-ray': '8a1b' } })).body;
  assert.ok(!('signins' in health) && !('restarts' in health), 'no detail in health through the tunnel');
});

test('accounts.json written into: held aside as changed until the token at the laptop adopts them; every way in waits, the genuine sign-ins are kept, the panel and its ticks, and an adoption with one-time passwords', async (t) => {
  let srv = await h.startServer({ AGM_SESSION_SWEEP_MS: '200' });
  t.after(() => h.stopServer(srv.child));
  const ana = (await h.setupAdmin(srv.base)).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam', role: 'staff', password: STAFF_PW }, { cookie: ana })).status, 200);
  await h.stopServer(srv.child);
  const file = path.join(srv.dataDir, 'accounts.json');
  const eve = { id: 'aeve00000001', username: 'eve', name: 'Eve', role: 'admin', halls: [], grant: [], revoke: [], disabled: false, mustChange: false, pw: await acc.hashPassword('the writer chose this'), pwSetAt: 1, epoch: 1, createdAt: 1, createdBy: '', lastLoginAt: 0 };
  const planted = read(file).replace('"users": [', '"users": [\n  ' + JSON.stringify(eve) + ',');
  fs.writeFileSync(file, planted);
  const sessionsBefore = read(path.join(srv.dataDir, 'sessions.json'));
  srv = await start(srv, { AGM_SESSION_SWEEP_MS: '200' });
  const base = srv.base;
  // Every way in waits: login (the genuine admin's too) with the held words, setup with or without the token.
  for (const [u, pw] of [['ana', ANA.password], ['eve', 'the writer chose this']]) {
    const r = await login(base, u, pw);
    assert.deepEqual([r.status, r.body.error], [503, keyedstore.HELD_WORDS], u);
  }
  const me = (await h.api(base, 'GET', '/api/auth/me')).body;
  assert.deepEqual([me.setup, me.held], [false, { state: 'changed', waiting: 3, words: keyedstore.HELD_WORDS }]);
  assert.deepEqual((await adminMe(base)).held, me.held, '/api/admin/me says it too');
  for (const body of [{ ...ANA, username: 'zed' }, { token: h.TOKEN, ...ANA, username: 'zed' }]) assert.equal((await h.api(base, 'POST', '/api/setup', body)).status, 409);
  const refused = rowsOf(srv.dataDir).filter((e) => e.action === 'login.refused');
  assert.ok(refused.length >= 2 && refused.every((e) => e.target === '(unknown username)' && !e.words.includes('ana') && !e.words.includes('eve')), 'no typed name written');
  const held = rowsOf(srv.dataDir).find((e) => e.action === 'accounts.held');
  assert.match(held.words, /^accounts\.json was changed after AGMessage saved it \(kept aside as accounts\.held-.*\.json\)$/);
  const copyName = /accounts\.held-[^)]+\.json/.exec(held.words)[0];
  assert.equal(read(path.join(srv.dataDir, copyName)), planted, 'the held copy is byte for byte what was read');
  // The genuine sign-in of the untouched sessions.json: nobody, but a request carrying it and a sweep leave it on disk.
  assert.equal((await h.api(base, 'GET', '/api/auth/me', undefined, { cookie: ana })).body.account, null);
  await h.wait(600);
  assert.equal(read(path.join(srv.dataDir, 'sessions.json')), sessionsBefore, 'still in the file as it was');
  // The panel: the token at the laptop, signed in by this run.
  assert.equal((await h.api(base, 'GET', '/api/accounts/held', undefined, { cookie: ana })).status, 403, 'an account\'s cookie reads no copy');
  const tok = await tokenLogin(base);
  const view = (await h.api(base, 'GET', '/api/accounts/held', undefined, { cookie: tok })).body;
  assert.equal(view.ok, true, JSON.stringify(view));
  const row = (u) => view.accounts.find((a) => a.username === u);
  assert.deepEqual([row('eve').mark, row('eve').adopt, row('eve').confirm, row('eve').reset], ['new', false, true, true], 'the account added: unticked, its confirmation, its one-time password ticked');
  assert.deepEqual([row('ana').mark, row('ana').adopt, row('ana').reset], ['saved', true, false], 'as this laptop last saved it');
  assert.ok(view.accounts.every((a) => !('pw' in a) && !('epoch' in a)), 'no hash');
  // The adoption's refusals: without the token, a wrong one (counted, written), off the host, through the tunnel, a stale
  // digest, an admin-level account without its confirmation.
  const adopt = (body, o) => h.api(base, 'POST', '/api/accounts/adopt', { digest: view.digest, adopt: [{ id: row('ana').ref }], ...body }, o);
  assert.equal((await adopt({})).status, 401);
  assert.equal((await adopt({ token: 'not-the-token' })).status, 401);
  assert.ok(rowsOf(srv.dataDir).some((e) => e.action === 'login.token.fail' && e.words === 'a wrong admin token (at adoption)'));
  assert.equal((await underHost(base, 'POST', '/api/accounts/adopt', 'agm.example:' + srv.port, { body: { token: h.TOKEN, digest: view.digest, adopt: [{ id: row('ana').ref }] } })).status, 403, 'off the host');
  assert.equal((await adopt({ token: h.TOKEN }, { headers: { 'cf-ray': '8a1b' } })).status, 403);
  assert.match((await adopt({ token: h.TOKEN, digest: 'f'.repeat(64) })).body.error, /changed since you read it/);
  assert.match((await adopt({ token: h.TOKEN, adopt: [{ id: row('eve').ref, reset: true }] })).body.error, /eve can manage AGMessage: confirm it/);
  // With the token: ana as it was, sam with a one-time password; eve left out.
  const r = await adopt({ token: h.TOKEN, adopt: [{ id: row('ana').ref }, { id: row('sam').ref, reset: true }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.adopted.sort(), r.body.passwords.map((p) => p.username), r.body.left, r.body.notTaken], [['ana', 'sam'], ['sam'], 1, []]);
  // On disk before the answer: the adopted accounts saved, and the record naming that save and the one left out.
  const records = path.join(srv.dataDir + '-keys', 'stores');
  const setRec = JSON.parse(read(path.join(records, fs.readdirSync(records).find((x) => /^set-[0-9a-f]{32}\.json$/.test(x)))));
  const onDisk = JSON.parse(read(file));
  assert.deepEqual([onDisk.users.map((u) => u.username).sort(), setRec.held && setRec.held.left, setRec.accounts.gen >= onDisk.gen - 1], [['ana', 'sam'], 1, true]);
  const once = r.body.passwords[0].password;
  assert.equal((await h.api(base, 'GET', '/api/auth/me', undefined, { cookie: ana })).body.account.username, 'ana', 'adopted as it was: its kept sign-in lives again');
  assert.equal((await login(base, 'sam', STAFF_PW)).status, 401, 'its old password fails');
  const samIn = await login(base, 'sam', once);
  assert.deepEqual([samIn.status, samIn.body.mustChange], [200, true], 'its one-time password signs in, and must be changed');
  assert.equal((await login(base, 'eve', 'the writer chose this')).status, 401, 'the one left out stays out');
  const adopted = rowsOf(srv.dataDir).find((e) => e.action === 'accounts.adopted');
  assert.equal(adopted.words, 'adopted 2 (one-time passwords: sam); 1 left out');
  assert.ok(!read(path.join(srv.dataDir, 'audit.jsonl')).includes(once), 'no one-time password in a row');
  assert.equal(read(path.join(srv.dataDir, copyName)), planted, 'the held copy is unchanged');
  assert.equal((await adminMe(base, tok)).held.state, 'left');
  assert.equal((await adminMe(base)).held, null, 'those left out are the admin page\'s, never told to a page its gate does not admit');
  assert.equal((await adminMe(base, ana)).held.state, 'left', 'an admin account is told');
  const users = (await h.api(base, 'GET', '/api/users', undefined, { cookie: ana })).body;
  assert.match(users.leftOut, /^1 account was left out on \d+ \w+ and is kept aside: the token at the laptop may adopt them$/, 'the Accounts page tells an admin');
  // A restart keeps them, ok; the one left out is offered again.
  srv = await h.restartServer(srv);
  const states = (await h.api(srv.base, 'GET', '/api/health')).body.signins;
  assert.deepEqual([states.accounts.state, states.accounts.held], ['ok', 1]);
  assert.equal((await login(srv.base, 'ana', ANA.password)).status, 200);
  // Leave the rest out: the hold ends.
  const tok2 = await tokenLogin(srv.base);
  const left = (await h.api(srv.base, 'GET', '/api/accounts/held', undefined, { cookie: tok2 })).body;
  assert.deepEqual([left.mode, left.accounts.map((a) => a.username)], ['left', ['eve']], 'Adopt more… offers the one left out, from the same copy');
  assert.equal((await h.api(srv.base, 'POST', '/api/accounts/adopt', { token: h.TOKEN, digest: left.digest, adopt: [] }, { cookie: tok2 })).status, 200);
  assert.equal((await adminMe(srv.base, tok2)).held, null);
  assert.ok(rowsOf(srv.dataDir).some((e) => e.action === 'accounts.fresh' && /^left the rest out; 1 kept aside in accounts\.held-/.test(e.words)));
});

test('another machine: a folder run under one key folder and started under another holds its accounts aside as elsewhere; Start with no accounts, then the first admin with the token; and the lock never keeps the token out', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const ana = (await h.setupAdmin(srv.base)).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam', role: 'staff', password: STAFF_PW }, { cookie: ana })).status, 200);
  await tokenLogin(srv.base);
  await h.stopServer(srv.child);
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  for (const f of fs.readdirSync(srv.dataDir)) if (fs.statSync(path.join(srv.dataDir, f)).isFile()) fs.copyFileSync(path.join(srv.dataDir, f), path.join(moved, f));
  fs.cpSync(path.join(srv.dataDir, 'rooms'), path.join(moved, 'rooms'), { recursive: true });
  srv = await h.startServer({ AGM_DATA_DIR: moved });
  const base = srv.base;
  const si = (await h.api(base, 'GET', '/api/health')).body.signins;
  assert.deepEqual([si.accounts.state, si.sessions.state, si.adminSessions.state], ['elsewhere', 'ended', 'ended']);
  assert.match(si.accounts.words, /saved under another machine key \([0-9a-f]{4}…, its own claim\): another computer or Windows account/);
  assert.match(srv.out(), /Accounts: {4}✕ held aside: 2 accounts in this folder/);
  assert.equal((await login(base, 'ana', ANA.password)).status, 503);
  assert.equal((await h.api(base, 'POST', '/api/setup', { token: h.TOKEN, ...ANA })).status, 409);
  // The lock: five wrong tokens at the token sign-in, then the right one, signed in, and the panel drawn.
  for (let i = 0; i < 5; i++) assert.equal((await h.api(base, 'POST', '/api/admin/login', { token: 'wrong' + i })).status, 401);
  const before = rowsOf(srv.dataDir).filter((e) => e.action === 'login.token.fail').length;
  for (const w of ['wrong5', 'wrong6']) assert.equal((await h.api(base, 'POST', '/api/admin/login', { token: w })).status, 429, 'locked: refused');
  assert.equal(rowsOf(srv.dataDir).filter((e) => e.action === 'login.token.fail').length, before, 'and no row written while the lock holds');
  const tok = await tokenLogin(base);
  assert.ok(tok, 'the right token is taken while the lock holds');
  const view = (await h.api(base, 'GET', '/api/accounts/held', undefined, { cookie: tok })).body;
  assert.deepEqual([view.state, view.cannotCheck, view.accounts.map((a) => [a.username, a.reset])], ['elsewhere', true, [['ana', true], ['sam', false]]]);
  // Five wrong at the adoption, then the right: taken too.
  for (let i = 0; i < 5; i++) await h.api(base, 'POST', '/api/accounts/adopt', { token: 'wrong' + i, digest: view.digest, adopt: [] });
  assert.equal((await h.api(base, 'POST', '/api/accounts/adopt', { token: 'wrong9', digest: view.digest, adopt: [] })).status, 429);
  // Start with no accounts, with the right token while locked.
  const fresh = await h.api(base, 'POST', '/api/accounts/adopt', { token: h.TOKEN, digest: view.digest, adopt: [] });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.ok(rowsOf(srv.dataDir).some((e) => e.action === 'accounts.fresh' && /^started with no accounts; 2 kept aside in accounts\.held-/.test(e.words)));
  assert.equal((await h.api(base, 'GET', '/api/auth/me')).body.setup, true, 'the first admin account may be made now');
  assert.equal((await h.api(base, 'POST', '/api/setup', ANA)).status, 401, 'never from loopback alone');
  assert.equal((await h.api(base, 'POST', '/api/setup', { token: h.TOKEN, ...ANA })).status, 200, 'with the token typed');
  srv = await h.restartServer(srv);
  assert.deepEqual([(await h.api(srv.base, 'GET', '/api/health')).body.signins.accounts.state, (await login(srv.base, 'ana', ANA.password)).status], ['ok', 200], 'a restart keeps it ok');
});

test('the first start on 0.5.1 files: the Staff accounts sign in at once, the admin waits for the token, 0.5.1\'s sign-ins end; the sign-in page is told, and the opener opens /admin', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const at = Date.now();
  const user = async (id, username, role) => ({ id, username, name: username, role, halls: [], grant: [], revoke: [], disabled: false, mustChange: false, pw: await acc.hashPassword(STAFF_PW), pwSetAt: at, epoch: 1, createdAt: at, createdBy: '', lastLoginAt: 0 });
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ v: 1, users: [await user('aana00000001', 'ana', 'admin'), await user('asam00000001', 'sam', 'staff'), await user('alou00000001', 'lou', 'staff')] }, null, 1));
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ v: 1, sessions: [{ h: sha256('old-token-0123456789abcdef0123456789'), uid: 'asam00000001', epoch: 1, created: at, seen: at, ip: '', ua: '' }] }));
  const opened = path.join(dataDir + '-opened.jsonl');
  const preload = '--require "' + path.join(__dirname, 'opener-preload.js').split(path.sep).join('/') + '"';
  const srv = await h.startServer({ AGM_DATA_DIR: dataDir, AGM_OPEN: '1', SystemRoot: 'C:\\Windows', AGM_TEST_OPENED: opened, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ') });
  t.after(() => h.stopServer(srv.child));
  assert.equal((await login(srv.base, 'sam', STAFF_PW)).status, 200, 'a Staff account signs in at once');
  const waits = await login(srv.base, 'ana', STAFF_PW);
  assert.equal(waits.status, 401, 'the admin waits, refused as an unknown name is');
  assert.ok(rowsOf(dataDir).some((e) => e.action === 'login.refused' && e.target === '(unknown username)' && e.words === 'waiting for the token at the laptop'));
  assert.deepEqual((await h.api(srv.base, 'GET', '/api/auth/me')).body.held, { state: 'first', waiting: 1, words: keyedstore.FIRST_WORDS });
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: 'agm_s=old-token-0123456789abcdef0123456789' })).body.account, null, '0.5.1\'s cookie is nobody');
  assert.ok(rowsOf(dataDir).some((e) => e.action === 'signins.ended' && e.words === '1 sign-in ended: from AGMessage 0.5.1'));
  assert.ok(rowsOf(dataDir).some((e) => e.action === 'accounts.keyed' && /^3 accounts from AGMessage 0\.5\.1 keyed as accounts\.json held them; waiting for the token: ana$/.test(e.words)));
  assert.match(srv.out(), /Accounts: {4}3 accounts from AGMessage 0\.5\.1 are keyed to this laptop from here on/);
  assert.ok(fs.existsSync(path.join(dataDir + '-keys', 'stores', 'keyed.json')));
  // The opener's line whole: its preload appends it, which makes the file first and fills it after, so the name alone
  // is no line yet.
  await h.until(() => { try { return read(opened).includes('\n'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; /* not made yet */ } }, 4000, 'the opener\'s line');
  assert.match(JSON.parse(read(opened).split('\n')[0]).args[0], /\/admin$/, 'the opener opens /admin while accounts wait');
});

test('no secret: the keys, the token, a session token and a token sign-in\'s id with their SHA-256, and the one-time passwords are in no store, record, answer or row', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const ana = (await h.setupAdmin(srv.base)).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam', role: 'staff', password: STAFF_PW }, { cookie: ana })).status, 200);
  const tok = await tokenLogin(srv.base);
  await h.stopServer(srv.child);
  h.resealStore(srv.dataDir, 'accounts', (f) => { f.users[0].name = 'Ana (changed by a key holder)'; });
  fs.writeFileSync(path.join(srv.dataDir, 'accounts.json'), read(path.join(srv.dataDir, 'accounts.json')).replace('changed by a key holder', 'changed by a writer'));
  srv = await start(srv);
  const tok2 = await tokenLogin(srv.base);
  const view = (await h.api(srv.base, 'GET', '/api/accounts/held', undefined, { cookie: tok2 })).body;
  const r = await h.api(srv.base, 'POST', '/api/accounts/adopt', { token: h.TOKEN, digest: view.digest, adopt: view.accounts.map((a) => ({ id: a.ref, reset: true })), confirm: view.accounts.filter((a) => a.confirm).map((a) => a.ref) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const K = h.storesKeys(h.serverKey(srv.dataDir))();
  const values = [h.TOKEN, ...Object.values(K).flatMap((k) => [k.toString('hex'), k.toString('base64')]), ...r.body.passwords.map((p) => p.password)];
  for (const c of [ana, tok, tok2]) { const v = decodeURIComponent(c.split('=')[1]); values.push(v, sha256(v)); }
  // Every store, record and row, read once the adoption's last saves have landed (the sessions' kept sign-ins, its set
  // record): at a moment no save is under way in either folder (no `<file>.<pid>.tmp` listed, none renamed away as it
  // is read) and two readings 250 ms apart alike, so no name is read that a write is still renaming.
  const texts = [];
  const STORE_TEXT = /\.(json|jsonl|bak)$/;
  for (const dir of [srv.dataDir, path.join(srv.dataDir + '-keys', 'stores')]) {
    const kept = await h.settledFiles(dir, { recursive: true, read: STORE_TEXT, agreeMs: 250, what: 'the adoption\'s saves in ' + dir });
    for (const [f, text] of Object.entries(kept)) texts.push([path.join(dir, f), text]);
  }
  for (const route of ['/api/health', '/api/auth/me', '/api/admin/me', '/api/accounts/held']) texts.push([route, JSON.stringify((await h.api(srv.base, 'GET', route, undefined, { cookie: tok2 })).body)]);
  assert.ok(texts.some(([p]) => /accounts\.held-/.test(p)) && texts.some(([p]) => /set-[0-9a-f]{32}\.json$/.test(p)), 'the held copy and the records are searched');
  for (const [where, text] of texts) for (const v of values) assert.ok(!text.includes(v), where + ' holds a secret (' + v.slice(0, 6) + '…)');
});

test('events: an archive claims and pins its accounts, a continue brings them back ok; while accounts are held aside it waits; a .partial no claim names is set aside, nothing continued', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const base = srv.base;
  const root = (await h.setupAdmin(srv.base, { username: 'root' })).cookie;
  assert.equal((await h.api(base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: root })).status, 200);
  const archive = (body) => h.api(srv.base, 'POST', '/api/event/archive', body, { cookie: srv.cookie || root });
  let r = await archive({ next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const name = r.body.archive;
  const records = path.join(srv.dataDir + '-keys', 'stores');
  const setOf = () => { const f = fs.readdirSync(records).find((x) => /^set-[0-9a-f]{32}\.json$/.test(x)); return JSON.parse(read(path.join(records, f))); };
  // The record as the act left it: the claim is cleared once the next event's saves are flushed, and the record written at
  // once (KeyedStores.clearClaim), before the answer, so it is read with no wait.
  let rec = setOf();
  assert.deepEqual([rec.archiving, Object.keys(rec.archived)], [null, [name]], 'pinned, and the claim cleared once the next event\'s saves landed');
  const archived = JSON.parse(read(path.join(srv.dataDir, 'archive', name, 'accounts.json')));
  assert.deepEqual([rec.archived[name].gen, rec.archived[name].d], [archived.gen, archived.m.slice(0, 32)], 'the pin is the accounts file the archive took');
  // Fresh: its accounts file is keyed and empty, the first account made with the token.
  assert.equal((await h.api(base, 'GET', '/api/auth/me')).body.setup, true);
  srv.cookie = (await h.setupAdmin(base, { username: 'root' })).cookie;
  // Continue the archived event: its accounts back, ok, at the next save.
  r = await archive({ next: { kind: 'continue', from: name }, name: 'Spring Summit', current: 'Autumn Forum', reason: 'testing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await login(base, 'root', ANA.password)).status, 200, 'the continued event\'s account signs in');
  assert.equal((await h.api(base, 'GET', '/api/health')).body.signins.accounts.state, 'ok');
  // A .partial written into data\archive\ naming a continue of an older archive, then a restart: set aside, nothing moved.
  await h.stopServer(srv.child);
  const partial = path.join(srv.dataDir, 'archive', '.2026-10-31T14-02-00-000Z.partial');
  fs.mkdirSync(partial, { recursive: true });
  const ev = JSON.parse(read(path.join(srv.dataDir, 'archive', name, 'event.json')));
  fs.writeFileSync(path.join(partial, 'event.json'), JSON.stringify({ ...ev, next: { kind: 'continue', from: name, name: 'Spring Summit', keepScreens: false }, point: undefined, continued: undefined }));
  srv = await start(srv);
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'archive', '.2026-10-31T14-02-00-000Z.unclaimed')), 'set aside');
  assert.ok(rowsOf(srv.dataDir).some((e) => e.action === 'event.unclaimed' && /set aside as \.2026-10-31T14-02-00-000Z\.unclaimed; nothing was archived or continued$/.test(e.words)));
  assert.equal((await h.api(srv.base, 'GET', '/api/health')).body.event.unclaimed, 1);
  assert.equal((await login(srv.base, 'root', ANA.password)).status, 200, 'the live accounts open ok');
  // Accounts held aside: Archive this event… waits.
  await h.stopServer(srv.child);
  fs.writeFileSync(path.join(srv.dataDir, 'accounts.json'), read(path.join(srv.dataDir, 'accounts.json')).replace('"root"', '"rooo"'));
  srv = await start(srv);
  const tok = await tokenLogin(srv.base);
  r = await h.api(srv.base, 'POST', '/api/event/archive', { next: { kind: 'fresh' }, name: 'Winter Gala', reason: 'testing' }, { cookie: tok });
  assert.deepEqual([r.status, r.body.error], [409, 'Archive this event… waits until the accounts are open (Admin → Accounts held aside).']);
  rec = setOf();
  assert.equal(rec.archiving, null);
});

test('events after a move: an event archived before the folder moved (a portable upgrade, the import) is continued after it, its accounts opened against their pin and ok', async (t) => {
  let srv = await h.startServer();
  const keys = srv.dataDir + '-keys';
  t.after(() => h.stopServer(srv.child));
  const root = (await h.setupAdmin(srv.base, { username: 'root' })).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam', role: 'staff', password: STAFF_PW }, { cookie: root })).status, 200);
  const r = await h.api(srv.base, 'POST', '/api/event/archive', { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' }, { cookie: root });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const name = r.body.archive;
  await h.stopServer(srv.child);
  // The folder copied to a new path and started there under the same key folder: a move, its set forked.
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-moved-'));
  fs.cpSync(srv.dataDir, moved, { recursive: true });
  if (fs.existsSync(srv.dataDir + '-uploads')) fs.cpSync(srv.dataDir + '-uploads', moved + '-uploads', { recursive: true });
  srv = await h.startServer({ AGM_DATA_DIR: moved, AGM_KEY_DIR: keys });
  assert.match(srv.out(), /this folder was last saved at .*; its accounts and sign-ins go on here/);
  const tok = await tokenLogin(srv.base);
  const c = await h.api(srv.base, 'POST', '/api/event/archive', { next: { kind: 'continue', from: name }, name: 'Spring Summit', current: 'Autumn Forum', reason: 'testing' }, { cookie: tok });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const health = (await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: tok })).body.signins;
  assert.deepEqual([health.accounts.state, health.accounts.held, health.accounts.count], ['ok', 0, 2], JSON.stringify(health.accounts));
  assert.equal((await login(srv.base, 'root', ANA.password)).status, 200, 'the continued event\'s admin signs in');
  assert.equal((await login(srv.base, 'sam', STAFF_PW)).status, 200, 'and its Staff account');
  assert.ok(!rowsOf(moved).some((e) => e.action === 'accounts.held'), 'nothing held aside');
});
