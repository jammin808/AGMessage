'use strict';
// Accounts, rights and the audit trail: the permission model (pure), password hashing and policy, sessions, the
// hash chain, and the whole of it end to end — first admin, sign-in, managing accounts, joining a hall as an account,
// rights changed under a live socket, the origin check, and the audit log that records it all.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const rbac = require('../lib/rbac');
const acc = require('../lib/accounts');
const { AuditLog } = require('../lib/audit');
const guard = require('../lib/guard');
const { startServer, stopServer, api, connect, emit, once, wait, until, TOKEN } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- the permission model
test('rbac: roles, hall scope, grants and revokes, deny by default', () => {
  const tech = { id: 'a1', role: 'tech', halls: ['HALL01'] };
  assert.ok(rbac.can(tech, 'hall.post', 'HALL01'));
  assert.ok(!rbac.can(tech, 'hall.post', 'HALL03'), 'a tech is in their own halls only');
  assert.ok(!rbac.can(tech, 'users.manage'));
  assert.ok(rbac.can({ role: 'manager' }, 'display.control', 'ANYHALL'), 'a project manager sees every hall');
  assert.ok(rbac.can({ role: 'senior' }, 'hall.view', 'HALL09'), 'a senior tech sees every hall');
  assert.ok(!rbac.can({ role: 'senior' }, 'halls.manage'));
  assert.ok(!rbac.can({ role: 'staff', halls: ['HALL01'] }, 'display.control', 'HALL01'), 'staff message, they do not drive screens');
  assert.ok(rbac.can({ role: 'staff', halls: ['HALL01'], grant: ['display.control'] }, 'display.control', 'HALL01'), 'a grant adds one right');
  assert.ok(!rbac.can({ role: 'tech', halls: ['HALL01'], revoke: ['stage.send'] }, 'stage.send', 'HALL01'), 'a revoke takes one away');
  assert.ok(!rbac.can({ role: 'admin', disabled: true }, 'hall.view', 'HALL01'), 'a turned-off account can do nothing');
  assert.ok(!rbac.can({ role: 'admin' }, 'no.such.cap'), 'an unknown right is refused');
  assert.ok(!rbac.can({ role: 'wizard' }, 'hall.view', 'HALL01'), 'an unknown role is refused');
  assert.equal(rbac.roomRoleFor({ role: 'viewer', halls: ['H1H1'] }, 'H1H1'), 'observer');
  assert.equal(rbac.roomRoleFor({ role: 'tech', halls: ['H1H1'] }, 'H1H1'), 'research');
});

test('rbac: rights never escalate', () => {
  const admin = { id: 'a1', role: 'admin' };
  const manager = { id: 'a2', role: 'manager', grant: ['users.manage'] };
  const tech = { id: 'a3', role: 'tech' };
  assert.equal(rbac.mayChange(tech, null, { role: 'staff' }), 'You may not manage accounts.');
  assert.match(rbac.mayChange(manager, null, { role: 'admin' }), /Only an admin/);
  assert.match(rbac.mayChange(manager, tech, { grant: ['settings.manage'] }), /Only an admin may grant/);
  assert.equal(rbac.mayChange(manager, tech, { role: 'staff' }), null, 'a manager with users.manage may manage non-admins');
  assert.match(rbac.mayChange(manager, manager, { role: 'admin' }), /Nobody changes their own/);
  assert.match(rbac.mayChange(admin, admin, { disabled: true }), /Nobody changes their own/);
  assert.match(rbac.mayChange(admin, { id: 'a9', role: 'admin' }, { role: 'staff' }, { activeAdmins: 1 }), /last active admin/);
  assert.equal(rbac.mayChange(admin, { id: 'a9', role: 'admin' }, { role: 'staff' }, { activeAdmins: 2 }), null);
  assert.match(rbac.mayChange(admin, tech, { grant: ['wizardry'] }), /Unknown right/);
  // An account that may manage accounts or settings is changed by an admin only — reset, signed out, removed, re-enabled.
  const peer = { id: 'a4', role: 'staff', grant: ['users.manage'] };
  const keeper = { id: 'a5', role: 'manager', grant: ['settings.manage'] };
  assert.match(rbac.mayChange(manager, keeper, {}), /Only an admin may change an account that manages/, 'a reset or a sign-out');
  assert.match(rbac.mayChange(manager, peer, { disabled: true }), /Only an admin may change an account that manages/, 'a removal');
  assert.match(rbac.mayChange(manager, { ...keeper, disabled: true }, { disabled: false }), /Only an admin/, 'a disabled holder is not re-enabled by a non-admin');
  assert.equal(rbac.mayChange(manager, manager, { name: 'Pat P.' }), null, 'one\'s own name');
  assert.equal(rbac.mayChange(admin, keeper, {}), null, 'an admin may');
  assert.ok(rbac.holdsAdminOnly(keeper) && rbac.holdsAdminOnly({ ...peer, disabled: true }) && !rbac.holdsAdminOnly(tech));
});

test('rbac: a holder of users.manage who is not an admin makes, widens and takes over nothing past its own rights and halls', () => {
  const lead = { id: 'a4', role: 'tech', halls: ['HALLA1'], grant: ['users.manage'] };
  const crew = { id: 'a5', role: 'tech', halls: ['HALLA1'] };
  for (const [target, change, why] of [
    [null, { role: 'manager' }, 'a project manager: every hall, halls.manage, audit.read'],
    [null, { role: 'staff', allHalls: true }, 'every hall'],
    [crew, { halls: ['HALLA1', 'HALLB2'] }, 'a hall it is not in'],
    [crew, { allHalls: true }, 'every hall, to another'],
    [crew, { grant: ['nodes.control'] }, 'a right it does not hold'],
    [crew, { grant: 'audit.read' }, 'a grant that is not a list is read as what it names'],
    [{ id: 'a6', role: 'manager' }, {}, 'a reset or sign-out of a richer account (the reset would hand it the password)'],
    [{ id: 'a7', role: 'tech', halls: ['HALLB2'] }, { disabled: true }, 'a removal in a hall it is not in'],
    [{ id: 'a6', role: 'manager', disabled: true }, { disabled: false }, 'turning a richer account back on'],
  ]) assert.match(rbac.mayChange(lead, target, change) || 'allowed', /hold yourself/, why);
  assert.equal(rbac.mayChange(lead, null, { role: 'staff', halls: ['halla1'] }), null, 'staff in its own hall');
  assert.equal(rbac.mayChange(lead, crew, { role: 'viewer' }), null);
  assert.equal(rbac.mayChange(lead, crew, {}), null, 'a reset of an account within its rights');
  assert.equal(rbac.mayChange(lead, lead, { name: 'Lee L.' }), null, 'its own name');
  assert.equal(rbac.mayChange(lead, null, { role: 'senior', allHalls: false, halls: ['HALLA1'], revoke: ['nodes.control'] }), null, 'a richer role with what it lacks taken off');
  assert.equal(rbac.mayChange({ id: 'a2', role: 'manager', grant: ['users.manage'] }, crew, { allHalls: true, grant: ['nodes.control'] }), null, 'a project manager holds every hall');
  // What the Accounts page offers: exactly what mayChange allows.
  assert.deepEqual(rbac.giveable(lead), { admin: false, caps: ['display.control', 'hall.files', 'hall.post', 'hall.view', 'stage.send'], allHalls: false, halls: ['HALLA1'] });
  assert.deepEqual(rbac.giveable({ id: 'a1', role: 'admin' }), { admin: true, caps: Object.keys(rbac.CAPS), allHalls: true, halls: [] });
  assert.deepEqual(rbac.giveable({ id: 'a2', role: 'manager', grant: ['users.manage'] }).halls, [], 'every hall: no list');
});

// ---------------------------------------------------------------- passwords and sessions
test('passwords: scrypt, the same work for an unknown name, the policy', async () => {
  const h = await acc.hashPassword('purple stage lights');
  assert.match(h, /^scrypt\$15\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.ok((await acc.verifyPassword('purple stage lights', h)).ok);
  assert.ok(!(await acc.verifyPassword('purple stage light', h)).ok);
  assert.ok(!(await acc.verifyPassword('anything', '')).ok, 'no hash: refused, after the same work');
  const old = await acc.hashPassword('purple stage lights', { logN: 14, r: 8, p: 3, keylen: 32 });
  assert.deepEqual(await acc.verifyPassword('purple stage lights', old), { ok: true, rehash: true }, 'an older cost is rehashed at the next sign-in');
  assert.match(acc.passwordProblem('short'), /at least 10/);
  assert.match(acc.passwordProblem('password123'), /too common/);
  assert.match(acc.passwordProblem('aaaaaaaaaaaa'), /repeated/);
  assert.match(acc.passwordProblem('samsamsamsam1', { username: 'sam' }), /username/);
  assert.equal(acc.passwordProblem('the green room kettle'), null);
  assert.match(acc.temporaryPassword(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

test('sessions: only a hash on disk; idle, age, a moved epoch and a turned-off account end them', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accounts);
  const { account } = await accounts.create({ username: 'sam', name: 'Sam Patel', role: 'tech', password: 'blue door at the back' });
  const token = sessions.create(account, { ip: '10.0.0.9' });
  assert.equal(sessions.resolve(token).account.id, account.id);
  sessions.flush(); accounts.flush();
  const onDisk = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
  assert.ok(!onDisk.includes(token), 'the token itself is never stored');
  assert.ok(!fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8').includes('blue door'), 'nor a password');
  const again = new acc.Sessions(path.join(dir, 'sessions.json'), accounts);
  assert.ok(again.resolve(token), 'a restart keeps people signed in');
  assert.equal(sessions.resolve(token, Date.now() + acc.IDLE_MS + 1), null, 'idle too long');
  const t2 = sessions.create(account);
  accounts.signOutEverywhere(account.id);
  assert.equal(sessions.resolve(t2), null, 'sign out everywhere');
  const t3 = sessions.create(accounts.get(account.id));
  accounts.update(account.id, { disabled: true });
  assert.equal(sessions.resolve(t3), null, 'a turned-off account');
  assert.equal(sessions.resolve('x'.repeat(10)), null);
});

test('accounts: a check changes nothing; a password at an older cost is stored again by upgrade, never over a new one', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const pw = 'blue door at the back';
  const { account } = await accounts.create({ username: 'sam', role: 'tech', password: pw });
  const old = await acc.hashPassword(pw, { ...acc.SCRYPT, logN: acc.SCRYPT.logN - 1 });
  account.pw = old;
  const r = await accounts.authenticate('sam', pw);
  assert.deepEqual([r.account === account, r.rehash, account.pw, account.lastLoginAt], [true, true, old, 0], 'checked, not yet let in: nothing written');
  await accounts.upgrade(account, pw + 'x'.repeat(200));
  assert.ok(account.pw.startsWith('scrypt$' + acc.SCRYPT.logN + '$'), 'at today\'s cost');
  assert.equal((await accounts.authenticate('sam', pw + 'x'.repeat(200))).rehash, false, 'stored as it was checked: its first 128 characters');
  const other = await acc.hashPassword('a new password while it hashed');
  account.pw = old;
  const racing = accounts.upgrade(account, pw);
  account.pw = other;   // a new password set while the upgrade's hash is made
  await racing;
  assert.equal(account.pw, other, 'a password changed meanwhile is kept');
  accounts.flush();
});

test('sessions: an account\'s device count is the sessions that still let it in', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accounts);
  const { account } = await accounts.create({ username: 'sam', name: 'Sam Patel', role: 'tech', password: 'blue door at the back' });
  sessions.create(account); sessions.create(account);
  assert.equal(sessions.of(account.id).length, 2);
  accounts.signOutEverywhere(account.id);
  assert.equal(sessions.of(account.id).length, 0, 'signed out everywhere: no devices');
  sessions.create(accounts.get(account.id));
  assert.equal(sessions.of(account.id).length, 1);
  assert.equal(sessions.of(account.id, Date.now() + acc.IDLE_MS + 1).length, 0, 'idle too long');
  accounts.update(account.id, { disabled: true });
  assert.equal(sessions.of(account.id).length, 0, 'turned off');
  sessions.flush(); accounts.flush();
});

test('sessions: a session with a page open is in use, and the sweep names the open ones that have ended', async () => {
  const HOUR = 3600_000;
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accounts);
  const { account } = await accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: 'the green room kettle' });
  const T = Date.now();
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const token = sessions.create(account);
  const h = sha(token);
  const idle = sha(sessions.create(account));
  assert.ok(sessions.touch(h, T + 13 * HOUR), 'in use at hour 13');
  assert.ok(sessions.resolve(token, T + 14.5 * HOUR), 'so not idle at 14.5 h, though 14.5 h after sign-in');
  assert.deepEqual([...sessions.sweep(new Set([h, 'f'.repeat(64)]), T + 27 * HOUR)], ['f'.repeat(64)], 'an open socket keeps its session; an unknown one has ended');
  assert.ok(!sessions.map.has(idle), 'a session nobody uses is dropped by the sweep');
  assert.deepEqual([...sessions.sweep(new Set([h]), T + acc.MAX_AGE_MS + HOUR)], [h], 'seven days old: ended, however much it is used');
  assert.equal(sessions.touch(h), null);
  sessions.flush(); accounts.flush();
});

test('sessions: one account signing in again and again keeps its 20 newest and never signs anyone else out', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accounts);
  const ana = (await accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: 'the green room kettle' })).account;
  const vic = (await accounts.create({ username: 'vic', name: 'Vic', role: 'viewer', password: 'a viewer password here' })).account;
  const [MAX, PER] = [5000, 20];
  const anaToken = sessions.create(ana);
  let last = '';
  for (let i = 0; i < MAX; i++) last = sessions.create(vic);
  assert.ok(sessions.resolve(anaToken), 'the admin is still signed in after the viewer\'s 5000 sign-ins');
  assert.equal(sessions.of(vic.id).length, PER, 'the viewer keeps its 20 newest');
  assert.ok(sessions.resolve(last), 'the newest sign-in holds');
  assert.deepEqual([acc.MAX_SESSIONS, acc.MAX_PER_ACCOUNT], [MAX, PER]);
  // Past MAX_SESSIONS in all, the account with the most gives up its oldest: an account with one keeps it.
  const many = new acc.Sessions(path.join(dir, 'many.json'), { get: (id) => ({ id, epoch: 1 }) });
  const lone = many.create({ id: 'lone' });
  for (let u = 0; u <= MAX / PER; u++) for (let i = 0; i < PER; i++) many.create({ id: 'u' + u });
  assert.equal(many.map.size, MAX);
  assert.ok(many.resolve(lone), 'the account with one session keeps it');
  sessions.flush(); accounts.flush(); many.flush();
});

test('token sessions: only a hash on disk, kept across a restart under the same token, ended by a new token, a day at most', () => {
  const dir = tmp('agm-acc-');
  const file = path.join(dir, 'admin-sessions.json');
  const a = new acc.TokenSessions(file, 'tag-one');
  const sid = a.create();
  const gone = a.create();
  assert.ok(a.has(sid) && a.has(gone));
  a.destroy(gone);
  assert.ok(!a.has(gone), 'signed out');
  a.flush();
  assert.ok(!fs.readFileSync(file, 'utf8').includes(sid), 'the cookie itself is never stored');
  assert.ok(new acc.TokenSessions(file, 'tag-one').has(sid), 'a restart with the same token keeps it');
  assert.ok(!new acc.TokenSessions(file, 'tag-two').has(sid), 'a new token ends it');
  assert.ok(!a.has(sid, Date.now() + acc.TOKEN_SESSION_MS), 'a day at most');
  assert.ok(!a.has(sid) && !a.has('') && !a.has(undefined));
  a.flush();
});

test('token sessions: a new sign-in takes the ended ones with it, in memory and on disk', () => {
  const file = path.join(tmp('agm-acc-'), 'admin-sessions.json');
  const a = new acc.TokenSessions(file, 'tag-one');
  const T = Date.now();
  for (let i = 0; i < 50; i++) a.create(T - acc.TOKEN_SESSION_MS - i);   // signed in more than a day ago, never back
  const sid = a.create(T);
  assert.equal(a.map.size, 1, 'only the sign-in whose day is not over');
  a.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1);
  assert.ok(a.has(sid));
});

test('accounts: two creates of one name at once make one, and two first admins at once make one', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const pw = 'blue door at the back';
  const [x, y] = await Promise.all([accounts.create({ username: 'sam', role: 'tech', password: pw }), accounts.create({ username: 'Sam', role: 'tech', password: pw })]);
  assert.deepEqual([x, y].map((r) => (r.account ? 'made' : r.error)).sort(), ['That username is taken.', 'made'], 'the name is reserved before its hash is made');
  const fresh = new acc.Accounts(path.join(dir, 'fresh.json'));
  const [a, b] = await Promise.all(['ada', 'ben'].map((u) => fresh.create({ username: u, role: 'admin', password: pw }, 'setup', { firstAdmin: true })));
  assert.deepEqual([a, b].map((r) => (r.account ? 'made' : r.exists ? 'exists' : r.error)).sort(), ['exists', 'made'], 'one first admin');
  assert.equal(fresh.size, 1);
  assert.equal((await fresh.create({ username: 'cy', role: 'admin', password: pw }, 'setup', { firstAdmin: true })).exists, true, 'and none once there are accounts');
  accounts.flush(); fresh.flush();
});

test('accounts: what an untouched editor sends back is no change; only a field that now holds something else is one', async () => {
  const dir = tmp('agm-acc-');
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'));
  const pw = 'blue door at the back';
  const { account } = await accounts.create({ username: 'kim', name: 'Kim Tech', role: 'tech', halls: ['HALL01'], allHalls: false, grant: ['nodes.control'], revoke: ['stage.send'], password: pw });
  assert.deepEqual(accounts.update(account.id, { name: 'Kim Tech', role: 'tech', halls: ['hall01', 'HALL01'], allHalls: false, grant: ['nodes.control', 'nodes.control'], revoke: ['stage.send'] }), []);
  assert.deepEqual(accounts.update(account.id, { allHalls: null, grant: ['nodes.control'], revoke: [] }), ['allHalls', 'revoke']);
  assert.deepEqual(accounts.update(account.id, { allHalls: 'x' }), [], 'not true or false: the role\'s own, as it is now');
  assert.deepEqual(accounts.update(account.id, { halls: ['HALL02', 'HALL01'], grant: [] }), ['halls', 'grant']);
  assert.deepEqual([accounts.get(account.id).halls.sort(), accounts.get(account.id).grant, 'allHalls' in accounts.get(account.id)], [['HALL01', 'HALL02'], [], false]);
  accounts.flush();
});

test('hashing: a check through the tunnel waits in a short queue of its own, leaves it when its request goes, and never holds the venue back', async () => {
  const stored = await acc.hashPassword('the green room kettle');
  const order = [];
  const gone = new AbortController();
  const tunnel = [];
  // One slot for the tunnel: one check runs, LANES.tunnel.queue wait, the next is refused at once.
  for (let i = 0; i <= acc.LANES.tunnel.queue; i++) {
    const signal = i === 3 ? gone.signal : new AbortController().signal;
    tunnel.push(acc.verifyPassword('wrong guess ' + i, stored, { lane: 'tunnel', signal }).then(() => { order.push('tunnel'); return 'hashed'; }, (e) => e.code));
  }
  assert.equal(await acc.verifyPassword('one more guess', stored, { lane: 'tunnel', signal: new AbortController().signal }).then(() => 'hashed', (e) => e.code), 'BUSY');
  const already = new AbortController(); already.abort();
  assert.equal(await acc.verifyPassword('gone already', stored, { lane: 'tunnel', signal: already.signal }).then(() => 'hashed', (e) => e.code), 'ABANDONED');
  gone.abort();
  const venue = await acc.verifyPassword('the green room kettle', stored, { lane: 'venue', signal: new AbortController().signal });
  order.push('venue');
  const made = acc.hashPassword('a new password here', acc.SCRYPT, { lane: 'tunnel' });   // no request: waits its turn, never refused
  assert.equal(venue.ok, true);
  const outcomes = await Promise.all(tunnel);
  assert.equal(outcomes[3], 'ABANDONED', 'a check whose request went is dropped unhashed');
  assert.equal(outcomes.filter((o) => o === 'hashed').length, acc.LANES.tunnel.queue, 'the rest are hashed in turn');
  assert.ok(order.indexOf('venue') <= 2, 'the venue check ran on its own slot, not behind the tunnel\'s queue: ' + order.join(' '));
  assert.match(await made, /^scrypt\$/);
});

test('hashing: a burst of unknown names before their dummy hash exists makes that hash once, not once per guess', async () => {
  // A fresh copy of the module: its dummy hash is not made yet, as after a restart.
  const file = require.resolve('../lib/accounts');
  const kept = require.cache[file];
  delete require.cache[file];
  const fresh = require('../lib/accounts');
  require.cache[file] = kept;
  const real = crypto.scrypt;
  let hashes = 0;
  crypto.scrypt = (...args) => { hashes++; return real(...args); };
  try {
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => fresh.verifyPassword('guess ' + i, '', { lane: 'tunnel', signal: new AbortController().signal }).then(() => 'hashed', (e) => e.code)));
    const hashed = outcomes.filter((o) => o === 'hashed').length;
    assert.equal(hashes, 1 + hashed, 'one dummy hash, then one per check that was hashed — not a dummy per guess: ' + hashes + ' hashes');
    assert.equal(hashed, 1 + fresh.LANES.tunnel.queue, 'the tunnel\'s slot and queue, and the rest told busy at once');
  } finally { crypto.scrypt = real; }
});

test('hashing: a hash scrypt refuses to run (a stored cost past its memory cap) gives its slot back', async () => {
  const tooCostly = ['scrypt', 20, 32, 16, crypto.randomBytes(16).toString('base64url'), crypto.randomBytes(32).toString('base64url')].join('$');
  assert.ok(acc.parseHash(tooCostly), 'within what a stored hash may say, past what scrypt runs in its memory cap');
  for (let i = 0; i < acc.LANES.venue.slots; i++) await assert.rejects(acc.verifyPassword('anything at all', tooCostly), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
  const pw = 'the green room kettle';
  const next = (async () => (await acc.verifyPassword(pw, await acc.hashPassword(pw))).ok)();
  assert.equal(await Promise.race([next, wait(5000).then(() => 'stuck behind slots that were never given back')]), true);
});

test('limits: a flood of new addresses never hands back an allowance used up, nor lifts a lock that holds', () => {
  const T = 1_000_000;
  const buckets = new guard.Buckets(0.5, 5, 100);
  for (let i = 0; i < 5; i++) assert.ok(buckets.take('198.51.100.7', T));
  assert.equal(buckets.take('198.51.100.7', T), false);
  for (let i = 0; i < 1000; i++) buckets.take('2001:db8::' + i, T + i);
  assert.ok(buckets.map.size <= 100, 'bounded: ' + buckets.map.size);
  assert.equal(buckets.take('198.51.100.7', T + 1000), false, 'the slowed address is still slowed');
  assert.equal(buckets.take('198.51.100.7', T + 2000), true, 'until it has earned a try back');
  const lock = new guard.Lockout(5, 60_000, 100);
  for (let i = 0; i < 5; i++) lock.fail('ana|tunnel', T);
  for (let i = 0; i < 1000; i++) lock.fail('guess' + i + '|tunnel', T + i);
  assert.ok(lock.map.size <= 100, 'bounded: ' + lock.map.size);
  assert.ok(lock.locked('ana|tunnel', T + 1000), 'the lock still holds');
  lock.fail('late|tunnel', T + 120_000);
  for (let i = 0; i < 200; i++) lock.fail('later' + i, T + 120_000);
  assert.ok(!lock.map.has('ana|tunnel'), 'an ended window goes first');
  lock.fail('sam|tunnel', T + 120_000); lock.fail('sam|10.0.0.9', T + 120_000);
  lock.forget((k) => k.startsWith('sam|'));
  assert.ok(!lock.map.has('sam|tunnel') && !lock.map.has('sam|10.0.0.9'), 'an admin\'s reset forgets the name');
});

// ---------------------------------------------------------------- the audit chain
test('audit: hash-chained; an edited, removed or reordered line is found; no secret fields', () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 5; i++) log.write({ t: 'account', id: 'a1', name: 'sam' }, 'display.take', 'D1', 'message ' + i, '10.0.0.' + i);
  assert.deepEqual(log.verify(), { ok: true, entries: 5 });
  const reopened = new AuditLog(file);
  reopened.write({ t: 'system' }, 'boot', '', 'restarted');
  assert.deepEqual(reopened.verify(), { ok: true, entries: 6 }, 'the chain goes on across a restart');
  assert.equal(reopened.latest(2)[0].action, 'boot', 'newest first');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const edited = lines.slice(); edited[2] = edited[2].replace('message 2', 'message X');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  assert.match(new AuditLog(file).verify().why, /changed after it was written/);
  fs.writeFileSync(file, lines.filter((_, i) => i !== 3).join('\n') + '\n');
  assert.equal(new AuditLog(file).verify().ok, false, 'a removed line breaks the chain');
  const swapped = lines.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  fs.writeFileSync(file, swapped.join('\n') + '\n');
  assert.equal(new AuditLog(file).verify().ok, false, 'reordered lines break it');
  const e = new AuditLog(path.join(dir, 'b.jsonl')).write({ t: 'account', id: 'a1', name: 'sam', password: 'x' }, 'login', 'sam', 'ok', '', { token: 'y' });
  assert.deepEqual(Object.keys(e.actor).sort(), ['id', 'name', 't'], 'only the listed fields are kept');
});

// ---------------------------------------------------------------- end to end
test('accounts end to end: first admin, sign-in, rights, joining a hall, revocation, origin, audit', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });

  // Nobody has an account: the page says so; the first admin is made on this laptop.
  const me0 = await api(base, 'GET', '/api/auth/me');
  assert.deepEqual(me0.body, { ok: true, account: null, setup: true });
  // A page served under another name that resolves to this laptop (its Origin matching its Host) is not the laptop.
  const rebound = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'ivy', name: 'Ivy', password: 'the green room kettle' });
    const host = 'agm.example:' + new URL(base).port;
    const rq = http.request(base + '/api/setup', { method: 'POST', headers: { host, origin: 'http://' + host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    rq.on('error', reject); rq.end(body);
  });
  assert.equal(rebound, 403, 'the first admin is not made from a page under another name');
  assert.equal((await api(base, 'GET', '/api/auth/me')).body.setup, true, 'still no accounts');
  const weak = await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'short' });
  assert.equal(weak.status, 400);
  const setup = await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const admin = setup.cookie;
  assert.match(admin, /^agm_s=/);
  assert.equal((await api(base, 'POST', '/api/setup', { username: 'ben', name: 'B', password: 'the green room kettle' })).status, 409, 'only once');

  // A hall, two accounts: a tech in that hall, a project manager everywhere. One-time passwords, changed at first sign-in.
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const other = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const tech = await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall] }, { cookie: admin });
  assert.equal(tech.status, 200, JSON.stringify(tech.body));
  assert.match(tech.body.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/, 'a one-time password is shown once');
  const pm = await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin });
  assert.equal(pm.status, 200);

  await t.test('sign-in: wrong password refused in the same words as an unknown name; a one-time password must be changed first', async () => {
    const bad = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'nope nope nope' });
    const unknown = await api(base, 'POST', '/api/auth/login', { username: 'nobody', password: 'nope nope nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, unknown.body.error, 'no hint which names exist');
    const first = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: tech.body.password });
    assert.equal(first.status, 200);
    assert.equal(first.body.mustChange, true);
    const blocked = await api(base, 'GET', '/api/halls', undefined, { cookie: first.cookie });
    assert.equal(blocked.status, 403, 'nothing else until the password is changed');
    const changed = await api(base, 'POST', '/api/auth/password', { current: tech.body.password, next: 'mixing desk on stage left' }, { cookie: first.cookie });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await api(base, 'GET', '/api/halls', undefined, { cookie: first.cookie })).status, 401, 'the old session ended with the change');
    const halls = await api(base, 'GET', '/api/halls', undefined, { cookie: changed.cookie });
    assert.deepEqual(halls.body.halls.map((h) => h.code), [hall], 'a tech sees their own hall only');
  });

  const samLogin = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' });
  const sam = samLogin.cookie;
  const pat = (await api(base, 'POST', '/api/auth/login', { username: 'pat', password: 'clipboard and coffee' })).cookie;

  await t.test('a project manager sees every hall; a tech cannot manage accounts or escalate', async () => {
    const h = await api(base, 'GET', '/api/halls', undefined, { cookie: pat });
    assert.deepEqual(h.body.halls.map((x) => x.code).sort(), [hall, other].sort());
    assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: sam })).status, 403);
    assert.equal((await api(base, 'POST', '/api/users', { username: 'eve', role: 'admin' }, { cookie: sam })).status, 403);
  });

  await t.test('a state change from another site is refused (Origin), and the admin token cannot sign in through the tunnel', async () => {
    const r = await api(base, 'POST', '/api/users', { username: 'mallory', role: 'staff' }, { cookie: admin, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /another site/);
    const tunnel = await api(base, 'POST', '/api/auth/login', { username: 'ana', password: 'the green room kettle' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    const wrong = await api(base, 'POST', '/api/auth/login', { username: 'ana', password: 'not the password at all' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.deepEqual([tunnel.status, tunnel.body.error, tunnel.cookie], [401, wrong.body.error, ''], 'admin rights do not sign in through the tunnel by default — answered as a wrong password is');
    const techTunnel = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(techTunnel.status, 200, 'everyone else may');
  });

  await t.test('an account joins its hall by code with its own name and rights; not another hall; guests cannot take its name', async () => {
    const s = await connect(base, sam); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: hall, as: 'account' });
    assert.ok(j.ok, JSON.stringify(j));
    assert.equal(j.name, 'Sam Tech');
    assert.equal(j.role, 'research', 'a tech posts');
    assert.equal(j.uid, j.account && samLogin.body.account.id);
    assert.ok(j.uploadToken, 'and shares files');
    const m = await emit(s, 'message', { type: 'text', text: 'Radio mic 3 battery low' });
    assert.ok(m.ok);
    const no = await emit(s, 'join', { roomCode: other, as: 'account' });
    assert.equal(no.ok, false);
    assert.match(no.error, /no access/);
    const guest = await connect(base); sockets.push(guest);
    const g = await emit(guest, 'join', { roomCode: hall, name: 'sam tech', role: 'research' });
    assert.equal(g.ok, false);
    assert.match(g.error, /belongs to an AGMessage account/);
    const anon = await connect(base); sockets.push(anon);
    assert.equal((await emit(anon, 'join', { roomCode: hall, as: 'account' })).signIn, true, 'no session: sign in first');
  });

  await t.test('rights changed under a live socket: it is told and closed, and the next connection has the new rights', async () => {
    const s = await connect(base, sam); sockets.push(s);
    assert.ok((await emit(s, 'join', { roomCode: hall, as: 'account' })).ok);
    const told = once(s, 'account:changed');
    const gone = once(s, 'disconnect');
    const samId = samLogin.body.account.id;
    const r = await api(base, 'PATCH', '/api/users/' + samId, { role: 'viewer' }, { cookie: admin });
    assert.deepEqual(r.body.changed, ['role']);
    await told; await gone;
    const s2 = await connect(base, sam); sockets.push(s2);
    const j = await emit(s2, 'join', { roomCode: hall, as: 'account' });
    assert.equal(j.role, 'observer', 'a viewer reads');
    assert.equal(j.uploadToken, null);
    assert.equal((await emit(s2, 'message', { type: 'text', text: 'x' })).ok, false);
    await api(base, 'PATCH', '/api/users/' + samId, { disabled: true }, { cookie: admin });
    assert.equal((await api(base, 'GET', '/api/halls', undefined, { cookie: sam })).status, 401, 'turned off: signed out everywhere');
    await wait(100);
  });

  await t.test('the last admin cannot be turned off or demoted, not even by themselves', async () => {
    const anaId = setup.body.account.id;
    assert.equal((await api(base, 'PATCH', '/api/users/' + anaId, { role: 'staff' }, { cookie: admin })).status, 403);
  });

  await t.test('the audit log has it all, the chain verifies, and nothing secret is in it', async () => {
    const a = await api(base, 'GET', '/api/audit?limit=100', undefined, { cookie: admin });
    assert.equal(a.status, 200);
    const actions = a.body.entries.map((e) => e.action);
    for (const want of ['setup', 'hall.create', 'user.create', 'login', 'login.fail', 'password.change', 'login.refused', 'user.update']) assert.ok(actions.includes(want), want);
    const v = await api(base, 'GET', '/api/audit/verify', undefined, { cookie: admin });
    assert.equal(v.body.ok, true);
    const raw = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
    for (const secret of ['the green room kettle', 'mixing desk on stage left', 'clipboard and coffee', tech.body.password, TOKEN]) assert.ok(!raw.includes(secret), 'no secret in the audit log');
    assert.equal((await api(base, 'GET', '/api/audit', undefined, { cookie: pat })).status, 200, 'a project manager reads it too');
  });

  await t.test('a holder of users.manage cannot reset, sign out, change or remove an account that manages accounts or settings', async () => {
    const una = await api(base, 'POST', '/api/users', { username: 'una', name: 'Una Rota', role: 'manager', grant: ['users.manage'], password: 'the rota on the wall' }, { cookie: admin });
    const sid = await api(base, 'POST', '/api/users', { username: 'sid', name: 'Sid Patch', role: 'manager', grant: ['settings.manage'], password: 'the patch bay labels' }, { cookie: admin });
    const stu = await api(base, 'POST', '/api/users', { username: 'stu', name: 'Stu Foyer', role: 'staff', password: 'the coffee urn table' }, { cookie: admin });
    assert.ok(una.body.ok && sid.body.ok && stu.body.ok, JSON.stringify([una.body, sid.body, stu.body]));
    const u = (await api(base, 'POST', '/api/auth/login', { username: 'una', password: 'the rota on the wall' })).cookie;
    const list = (await api(base, 'GET', '/api/users', undefined, { cookie: u })).body.users;
    const row = (name) => list.find((x) => x.username === name);
    assert.match(row('sid').locked, /Only an admin/, 'the page is told, and offers no Edit');
    assert.match(row('ana').locked, /Only an admin/);
    assert.equal(row('stu').locked, '');
    for (const [method, tail, body] of [['POST', '/password', {}], ['POST', '/signout', {}], ['PATCH', '', { name: 'Sid' }], ['DELETE', '', undefined]]) {
      const r = await api(base, method, '/api/users/' + sid.body.user.id + tail, body, { cookie: u });
      assert.equal(r.status, 403, method + ' /api/users/:id' + tail + ' ' + JSON.stringify(r.body));
    }
    assert.equal((await api(base, 'POST', '/api/users/' + setup.body.account.id + '/signout', {}, { cookie: u })).status, 403, 'nor sign an admin out');
    assert.equal((await api(base, 'POST', '/api/users/' + stu.body.user.id + '/password', {}, { cookie: u })).status, 200, 'an account without those rights is still theirs to reset');
    const sidNow = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.find((x) => x.username === 'sid');
    assert.deepEqual([sidNow.mustChange, sidNow.disabled, sidNow.name], [false, false, 'Sid Patch'], 'sid keeps their own password, account and name');
  });
});

// ---------------------------------------------------------------- managing accounts, end to end
test('two first admins sent at once make one; two accounts of one name sent at once make one, and its one-time password signs in', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const pw = 'purple stage lights';
  const [a, b] = await Promise.all([api(base, 'POST', '/api/setup', { name: 'Ada Lovelace', username: 'ada', password: pw }), api(base, 'POST', '/api/setup', { name: 'Ben Admin', username: 'ben', password: pw })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const admin = (a.status === 200 ? a : b).cookie;
  assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.length, 1, 'one first admin');
  const body = { username: 'sam', name: 'Sam Crew', role: 'staff' };
  const [x, y] = await Promise.all([api(base, 'POST', '/api/users', body, { cookie: admin }), api(base, 'POST', '/api/users', body, { cookie: admin })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  const [made, refused] = x.status === 200 ? [x, y] : [y, x];
  assert.equal(refused.body.error, 'That username is taken.');
  const list = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users;
  assert.equal(list.filter((u) => u.username === 'sam').length, 1);
  assert.equal((await api(base, 'POST', '/api/auth/login', { username: 'sam', password: made.body.password })).status, 200, 'the one-time password shown signs in');
  await until(() => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8')).users.length === 2, 3000, 'accounts.json written');
  assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8')).users.filter((u) => u.username === 'sam').length, 1);
});

test('a one-hall tech given users.manage manages only accounts within its own rights and halls, and the page is told what it may give', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  const made = {};
  for (const [username, extra] of [['lee', { role: 'tech', halls: [hallA], grant: ['users.manage'], password: 'freelancer desk lead' }], ['pat', { role: 'manager', password: 'clipboard and coffee' }], ['cam', { role: 'tech', halls: [hallA], password: 'cable reel orange' }]]) {
    const r = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase(), ...extra }, { cookie: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    made[username] = r.body.user;
  }
  const lee = (await api(base, 'POST', '/api/auth/login', { username: 'lee', password: 'freelancer desk lead' })).cookie;
  for (const [method, url, body, why] of [
    ['POST', '/api/users', { username: 'lee2', name: 'Second Lee', role: 'manager' }, 'a project manager, whose one-time password it would be handed'],
    ['PATCH', '/api/users/' + made.cam.id, { allHalls: true }, 'every hall'],
    ['PATCH', '/api/users/' + made.cam.id, { halls: [hallA, hallB] }, 'a hall it is not in'],
    ['POST', '/api/users/' + made.pat.id + '/password', {}, 'a richer account\'s new password'],
    ['POST', '/api/users/' + made.pat.id + '/signout', {}, 'a richer account signed out'],
  ]) {
    const r = await api(base, method, url, body, { cookie: lee });
    assert.equal(r.status, 403, why + ': ' + r.status + ' ' + JSON.stringify(r.body));
    assert.match(r.body.error, /hold yourself/);
  }
  assert.equal((await api(base, 'POST', '/api/users', { username: 'fred', name: 'Fred', role: 'staff', halls: [hallA] }, { cookie: lee })).status, 200, 'staff in its own hall');
  const view = (await api(base, 'GET', '/api/users', undefined, { cookie: lee })).body;
  const row = (name) => view.users.find((u) => u.username === name);
  assert.match(row('pat').locked, /hold yourself/, 'the page shows the richer account locked');
  assert.equal(row('cam').locked, '');
  assert.deepEqual(view.giveable, { admin: false, caps: ['display.control', 'hall.files', 'hall.post', 'hall.view', 'stage.send'], allHalls: false, halls: [hallA] });
  const now = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users;
  assert.deepEqual(now.filter((u) => u.username === 'pat').map((u) => [u.mustChange, u.rights.allHalls]), [[false, true]], 'pat keeps their own password');
  assert.equal(now.find((u) => u.username === 'cam').rights.allHalls, false);
});

test('saving an account unchanged changes nothing; the device count is what still signs in', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const users = {};
  for (const username of ['sam', 'kim', 'lee']) {
    const r = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase() + ' Tech', role: 'tech', halls: [hall], grant: ['nodes.control'], password: 'mixing desk on stage left' }, { cookie: admin });
    users[username] = r.body.user;
  }
  // Two devices each, from addresses of their own (one sign-in allowance each).
  let n = 0;
  const signIn = async (username) => {
    const r = await api(base, 'POST', '/api/auth/login', { username, password: 'mixing desk on stage left' }, { headers: { 'cf-connecting-ip': '198.51.100.' + (++n) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.cookie;
  };
  const sam = await signIn('sam');
  for (const u of ['sam', 'kim', 'kim', 'lee', 'lee']) await signIn(u);
  const devices = async () => Object.fromEntries((await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.filter((u) => users[u.username]).map((u) => [u.username, u.sessions]));
  assert.deepEqual(await devices(), { kim: 2, lee: 2, sam: 2 });

  await t.test('an untouched editor\'s Save: nothing changed, no reconnect, no audit row; a real change still reconnects', async () => {
    const s = await connect(base, sam); sockets.push(s);
    assert.ok((await emit(s, 'join', { roomCode: hall, as: 'account' })).ok);
    let told = false;
    s.on('account:changed', () => { told = true; });
    const view = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body;
    const u = view.users.find((x) => x.username === 'sam');
    const role = view.roles.find((r) => r.id === u.role);
    // What users.js formChange() sends for an editor opened and saved untouched.
    const body = { name: u.name, role: u.role, halls: u.halls, grant: u.grant.filter((c) => !role.caps.includes(c)), revoke: u.revoke.filter((c) => role.caps.includes(c)) };
    if (u.allHalls !== null || u.rights.allHalls !== role.allHalls) body.allHalls = u.rights.allHalls;
    const audits = async () => (await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'user.update').length;
    const before = await audits();
    const r = await api(base, 'PATCH', '/api/users/' + u.id, body, { cookie: admin });
    assert.deepEqual(r.body.changed, []);
    await wait(300);
    assert.equal(told, false, 'the open page is not told to reload');
    assert.equal(s.connected, true);
    assert.equal(await audits(), before, 'no audit row for a change that did not happen');
    const gone = once(s, 'disconnect');
    const renamed = await api(base, 'PATCH', '/api/users/' + u.id, { ...body, name: 'Sam Tech-Lead' }, { cookie: admin });
    assert.deepEqual(renamed.body.changed, ['name']);
    await gone;
    assert.equal(told, true);
    assert.equal(await audits(), before + 1);
  });

  await t.test('signed out everywhere, turned off, a new password: no devices left on the list', async () => {
    assert.equal((await api(base, 'POST', '/api/users/' + users.sam.id + '/signout', {}, { cookie: admin })).status, 200);
    assert.equal((await api(base, 'PATCH', '/api/users/' + users.kim.id, { disabled: true }, { cookie: admin })).status, 200);
    assert.equal((await api(base, 'POST', '/api/users/' + users.lee.id + '/password', {}, { cookie: admin })).status, 200);
    assert.deepEqual(await devices(), { kim: 0, lee: 0, sam: 0 });
  });
});
