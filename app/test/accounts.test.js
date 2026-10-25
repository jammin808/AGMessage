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
const { AuditLog, hashOf, GENESIS } = require('../lib/audit');
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
test('audit: hash-chained; an edited, removed or reordered line is found; no secret fields', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 5; i++) log.write({ t: 'account', id: 'a1', name: 'sam' }, 'display.take', 'D1', 'message ' + i, '10.0.0.' + i);
  assert.deepEqual(await log.verify(), { ok: true, entries: 5 });
  const reopened = new AuditLog(file);
  reopened.write({ t: 'system' }, 'boot', '', 'restarted');
  assert.deepEqual(await reopened.verify(), { ok: true, entries: 6 }, 'the chain goes on across a restart');
  assert.equal(reopened.latest(2)[0].action, 'boot', 'newest first');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const edited = lines.slice(); edited[2] = edited[2].replace('message 2', 'message X');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  assert.match((await new AuditLog(file).verify()).why, /changed after it was written/);
  fs.writeFileSync(file, lines.filter((_, i) => i !== 3).join('\n') + '\n');
  assert.equal((await new AuditLog(file).verify()).ok, false, 'a removed line breaks the chain');
  const swapped = lines.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  fs.writeFileSync(file, swapped.join('\n') + '\n');
  assert.equal((await new AuditLog(file).verify()).ok, false, 'reordered lines break it');
  const e = new AuditLog(path.join(dir, 'b.jsonl')).write({ t: 'account', id: 'a1', name: 'sam', password: 'x' }, 'login', 'sam', 'ok', '', { token: 'y' });
  assert.deepEqual(Object.keys(e.actor).sort(), ['id', 'name', 't'], 'only the listed fields are kept');
});

const fiveEntries = () => {
  const file = path.join(tmp('agm-audit-'), 'audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 5; i++) log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'entry ' + i);
  return { file, log, lines: fs.readFileSync(file, 'utf8').trim().split('\n') };
};

test('audit: the first line, the last line and the whole file are part of the chain', async () => {
  const a = fiveEntries();
  fs.writeFileSync(a.file, a.lines.slice(1).join('\n') + '\n');
  const first = await new AuditLog(a.file).verify();
  assert.equal(first.ok, false, 'the oldest line removed: ' + JSON.stringify(first));
  assert.equal(first.brokenAt, 1);
  assert.match(first.why, /entry 1 is missing/);

  const b = fiveEntries();
  fs.writeFileSync(b.file, b.lines.slice(0, -1).join('\n') + '\n');
  const last = await b.log.verify();
  assert.equal(last.ok, false, 'the newest line removed while the server runs: ' + JSON.stringify(last));
  assert.match(last.why, /after entry 4, entry 5 is missing/);

  const c = fiveEntries();
  fs.unlinkSync(c.file);
  const gone = await c.log.verify();
  assert.equal(gone.ok, false, 'the file removed while the server runs: ' + JSON.stringify(gone));
  assert.match(gone.why, /missing/);
  c.log.write({ t: 'system' }, 'boot', '', 'one more');
  const after = await c.log.verify();
  assert.equal(after.ok, false, 'one more entry does not hide it: ' + JSON.stringify(after));
  assert.match(after.why, /entries 1 to 5 are missing/);
});

/** A whole chain of `n` entries from the genesis hash, as the log writes them (fast: no file per entry). */
function chainOf(n, words = (i) => 'Lectern screen ' + (i % 4) + ' \u2192 message \u201cFive minutes left\u201d', at = 1_700_000_000_000) {
  let prev = GENESIS;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = { seq: i, at: at + i, actor: { t: 'account', id: 'a1', name: 'sam' }, action: 'display.take', target: 'dlectern1', words: words(i), ip: '10.0.0.9', prev };
    e.h = hashOf(e);
    prev = e.h;
    out.push(JSON.stringify(e));
  }
  return out.join('\n') + '\n';
}

test('audit: a rotated log is checked with the current one as one chain', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const text = chainOf(36_000, (i) => 'take ' + i + ' ' + 'x'.repeat(300));   // just over 20 MB
  assert.ok(text.length > 20 * 1024 * 1024);
  fs.writeFileSync(file, text);
  const log = new AuditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'the first entry of the next file');
  const rotated = fs.readdirSync(dir).filter((f) => /^audit-.+\.jsonl$/.test(f));
  assert.equal(rotated.length, 1, 'rotated at 20 MB');
  assert.deepEqual(await log.verify(), { ok: true, entries: 36_001 }, 'both files, one chain');
  assert.deepEqual(await new AuditLog(file).verify(), { ok: true, entries: 36_001 }, 'and after a restart');

  const old = path.join(dir, rotated[0]);
  const lines = fs.readFileSync(old, 'utf8').split('\n');
  lines[10] = lines[10].replace('take 11 ', 'take 99 ');
  fs.writeFileSync(old, lines.join('\n'));
  const edited = await log.verify();
  assert.deepEqual([edited.ok, edited.file, edited.brokenAt], [false, rotated[0], 11], JSON.stringify(edited));
  assert.match(edited.why, /entry 11 was changed/);

  fs.unlinkSync(old);
  const removed = await log.verify();
  assert.equal(removed.ok, false, 'a rotated file removed: ' + JSON.stringify(removed));
  assert.equal(removed.file, 'audit.jsonl');
  assert.match(removed.why, /entries 1 to 36000 are missing/);
});

test('audit: one failed write is kept and written with the next, so the chain on disk stays whole', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = new AuditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'first');
  fs.renameSync(file, file + '.held');
  fs.mkdirSync(file);   // the next open fails, as a full disk or a held file does
  log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk would not take it');
  assert.ok(log.lastError, 'the failure is kept for health');
  assert.equal(log.unwritten, 1);
  fs.rmdirSync(file);
  fs.renameSync(file + '.held', file);
  const waiting = await log.verify();
  assert.deepEqual(waiting, { ok: true, entries: 1, unwritten: 1 }, 'what is on disk is whole, and one entry waits');
  log.write({ t: 'system' }, 'x', '', 'third');
  log.write({ t: 'system' }, 'x', '', 'fourth');
  assert.equal(log.unwritten, 0);
  assert.equal(log.lastError, null);
  assert.deepEqual(await log.verify(), { ok: true, entries: 4 });
  assert.ok(fs.readFileSync(file, 'utf8').includes('second, while the disk would not take it'), 'the entry that failed is on disk now');
});

test('audit: an entry still waiting when the server stops is put on disk by the stop, not lost with it', async (t) => {
  const log = new AuditLog(path.join(tmp('agm-audit-'), 'audit.jsonl'));
  log.write({ t: 'system' }, 'boot', '', 'first');
  fs.renameSync(log.file, log.file + '.held'); fs.mkdirSync(log.file);
  log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk would not take it');
  assert.equal(log.flush(), false, 'a flush that still cannot write says so');
  fs.rmdirSync(log.file); fs.renameSync(log.file + '.held', log.file);
  assert.equal(log.flush(), true);
  assert.equal(log.unwritten, 0);
  assert.deepEqual(await log.verify(), { ok: true, entries: 2 });

  // End to end: the disk refuses one audited action; it is back by the time the server stops (SIGTERM).
  const srv = await startServer();
  let up = true;
  t.after(async () => { if (up) await stopServer(srv.child); });
  const file = path.join(srv.dataDir, 'audit.jsonl');
  assert.equal((await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).status, 200);
  assert.ok(fs.existsSync(file), 'the first sign-in is on disk');
  fs.renameSync(file, file + '.held'); fs.mkdirSync(file);
  assert.equal((await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).status, 200);
  assert.equal((await api(srv.base, 'GET', '/api/health')).body.saves.stores.audit.unwritten, 1, 'health says one entry waits');
  fs.rmdirSync(file); fs.renameSync(file + '.held', file);
  await stopServer(srv.child); up = false;
  const actions = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action);
  assert.deepEqual(actions, ['login.token', 'login.token'], 'the second sign-in is on disk after the stop');
  assert.deepEqual(await new AuditLog(file).verify(), { ok: true, entries: actions.length });
});

test('audit: a write the disk takes only part of is cut back, on Windows too, and the chain on disk stays whole', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = new AuditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'first');
  const before = fs.readFileSync(file, 'utf8');
  // As on Windows: a handle opened for appending writes only at the end and cannot cut the file back.
  const { openSync, writeSync, ftruncateSync } = fs;
  const appending = new Set();
  fs.openSync = (p, flags, ...rest) => {
    const fd = openSync.call(fs, p, flags, ...rest);
    if (typeof flags === 'string' ? flags.startsWith('a') : (flags & fs.constants.O_APPEND) !== 0) appending.add(fd); else appending.delete(fd);
    return fd;
  };
  fs.ftruncateSync = (fd, ...rest) => {
    if (appending.has(fd)) throw Object.assign(new Error('EPERM: operation not permitted, ftruncate'), { code: 'EPERM' });
    return ftruncateSync.call(fs, fd, ...rest);
  };
  fs.writeSync = (fd, buf, off = 0, len = buf.length - off, pos = null) => {
    fs.writeSync = writeSync;   // the disk is full for this one write: it takes half
    return writeSync.call(fs, fd, buf, off, Math.floor(len / 2), pos);
  };
  try {
    log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk was full');
    assert.match(String(log.lastError), /took \d+ of \d+ bytes/);
    assert.equal(log.unwritten, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the part that was written is cut back');
    log.write({ t: 'system' }, 'x', '', 'third');
  } finally { Object.assign(fs, { openSync, writeSync, ftruncateSync }); }
  assert.equal(log.unwritten, 0);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).words), ['first', 'second, while the disk was full', 'third']);
  assert.deepEqual(await log.verify(), { ok: true, entries: 3 });
});

for (const [what, tail] of [['a half-written last line', '{"seq":4,"at":17'], ['a NUL-filled tail (NTFS after a power cut)', Buffer.alloc(180)]]) {
  test('audit: ' + what + ' is cut at the next start, the cut is an entry, and the chain goes on whole', async () => {
    const dir = tmp('agm-audit-');
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog(file);
    for (let i = 0; i < 3; i++) log.write({ t: 'system' }, 'x', '', 'message ' + i);
    fs.appendFileSync(file, tail);
    const again = new AuditLog(file);
    again.write({ t: 'account', id: 'a1', name: 'ana' }, 'login', 'ana', 'signed in after the restart');
    const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => e.action), ['x', 'x', 'x', 'audit.repair', 'login'], 'every line whole, the repair before the sign-in');
    assert.match(entries[3].words, /half-written last line \(\d+ bytes\)/);
    assert.deepEqual(await again.verify(), { ok: true, entries: 5 });
  });
}

test('audit: checking a full-size log keeps the event loop turning, one check at a time, and still finds an edited line', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const n = 56_000;
  fs.writeFileSync(file, chainOf(n));   // about 20 MB, just under the rotation size
  const log = new AuditLog(file);
  let turns = 0;
  let done = false;
  let worst = 0;
  let lastTick = performance.now();
  const spin = () => { if (done) return; const now = performance.now(); worst = Math.max(worst, now - lastTick); lastTick = now; turns++; setImmediate(spin); };
  setImmediate(spin);
  const check = log.verify();
  assert.strictEqual(log.verify(), check, 'a second click shares the running check');
  const r = await check;
  done = true;
  assert.deepEqual(r, { ok: true, entries: n });
  assert.ok(turns >= 40, 'the loop turned ' + turns + ' times during the check');
  assert.ok(worst < 250, 'the longest the loop waited: ' + Math.round(worst) + ' ms');

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[100] = lines[100].replace('Lectern', 'Foyer');
  fs.writeFileSync(file, lines.join('\n'));
  const edited = await log.verify();
  assert.deepEqual([edited.ok, edited.brokenAt], [false, 101]);
  assert.match(edited.why, /changed after it was written/);
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

test('a one-hall tech given users.manage manages only accounts within its own rights and halls, and the page is told what it may give and no hall it does not hold', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  const made = {};
  for (const [username, extra] of [['lee', { role: 'tech', halls: [hallA], grant: ['users.manage'], password: 'freelancer desk lead' }], ['pat', { role: 'manager', password: 'clipboard and coffee' }], ['cam', { role: 'tech', halls: [hallA], password: 'cable reel orange' }], ['bob', { role: 'tech', halls: [hallB], password: 'sound check one two' }]]) {
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
  // A hall's code is a guest's way in: the one-hall manager is told no code of a hall it does not hold — not on the list
  // it ticks halls from, not in another person's row (bob's hall B is a count on a Locked row), nowhere in the reply.
  assert.deepEqual(view.halls.map((h) => h.code), [hallA]);
  assert.ok(!JSON.stringify(view).includes(hallB), 'hall B\'s code is nowhere in a one-hall manager\'s list');
  assert.deepEqual([row('bob').halls, row('bob').rights.halls, row('bob').otherHalls], [[], [], 1]);
  assert.match(row('bob').locked, /hold yourself/);
  assert.deepEqual([row('cam').halls, row('cam').otherHalls], [[hallA], 0], 'a row it may edit keeps every hall it has');
  const forAdmin = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body;
  const now = forAdmin.users;
  assert.deepEqual(forAdmin.halls.map((h) => h.code).sort(), [hallA, hallB].sort(), 'the admin still sees every hall');
  assert.deepEqual(now.find((u) => u.username === 'bob').halls, [hallB]);
  assert.deepEqual(now.filter((u) => u.username === 'pat').map((u) => [u.mustChange, u.rights.allHalls]), [[false, true]], 'pat keeps their own password');
  assert.equal(now.find((u) => u.username === 'cam').rights.allHalls, false);

  // One's own row: the page sends a new name alone (users.js), and that is taken; the rest of one's own account is
  // another admin's to change, so a body that names it is refused whatever it says.
  for (const [who, cookie] of [['lee', lee], ['ana', admin]]) {
    const own = (await api(base, 'GET', '/api/users', undefined, { cookie })).body.users.find((u) => u.username === who);
    assert.equal(own.locked, '', who + ': the page offers Edit on one\'s own row');
    const renamed = await api(base, 'PATCH', '/api/users/' + own.id, { name: own.name + ' Ops' }, { cookie });
    assert.deepEqual([renamed.status, renamed.body.changed], [200, ['name']], who + ': ' + JSON.stringify(renamed.body));
    for (const body of [{ name: own.name, role: own.role, halls: own.halls, grant: [], revoke: [] }, { disabled: true }]) {
      const r = await api(base, 'PATCH', '/api/users/' + own.id, body, { cookie });
      assert.deepEqual([r.status, r.body.error], [403, 'Nobody changes their own role, rights or halls — ask another admin.'], who + ' ' + JSON.stringify(body));
    }
    assert.equal((await api(base, 'DELETE', '/api/users/' + own.id, undefined, { cookie })).status, 403, who + ': nor removes themselves');
  }
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

// ---------------------------------------------------------------- saves that fail
test('a change to accounts.json that cannot be written is retried until it lands, and health names it meanwhile', async (t) => {
  let srv = await startServer();
  const { dataDir } = srv;
  t.after(async () => { await stopServer(srv.child); });
  const file = path.join(dataDir, 'accounts.json');
  const setup = await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  const admin = setup.cookie;
  const bob = await api(srv.base, 'POST', '/api/users', { username: 'bob', name: 'Bob Staff', role: 'staff', password: 'clipboard and coffee' }, { cookie: admin });
  assert.equal(bob.status, 200, JSON.stringify(bob.body));
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"bob"'), 3000, 'bob on disk');

  // Another program holds accounts.json for a moment: the rename over it fails.
  fs.renameSync(file, file + '.held');
  fs.mkdirSync(file);
  const off = await api(srv.base, 'PATCH', '/api/users/' + bob.body.user.id, { disabled: true }, { cookie: admin });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await wait(300);
  const during = (await api(srv.base, 'GET', '/api/health')).body.saves;
  assert.ok(during.stores && during.stores.accounts && during.stores.accounts.error, 'health names the store that could not be saved: ' + JSON.stringify(during));
  assert.equal(during.stores.settings.error, null, 'and only that one');
  fs.rmdirSync(file);
  fs.renameSync(file + '.held', file);
  await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.username === 'bob').disabled === true, 4000, 'the retry to write bob turned off');
  assert.equal((await api(srv.base, 'GET', '/api/health')).body.saves.stores.accounts.error, null, 'health clears once it is written');

  await stopServer(srv.child);
  srv = await startServer({ AGM_DATA_DIR: dataDir });
  const login = await api(srv.base, 'POST', '/api/auth/login', { username: 'bob', password: 'clipboard and coffee' });
  assert.equal(login.status, 401, 'a turned-off account stays off after a restart');
  assert.equal(login.body.cookie, undefined);
  assert.match(login.body.error, /don't match/, 'in the words a wrong password gets: a refusal never says the password was right');
});

test('six quick clicks on Check the log share one check and do not hold up anyone else', async (t) => {
  const dataDir = tmp('agm-e2e-');
  const n = 56_000;
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), chainOf(n));
  const srv = await startServer({ AGM_DATA_DIR: dataDir });
  t.after(async () => { await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  let worst = 0;
  const state = { running: true };
  const probe = (async () => {
    while (state.running) {
      const t0 = performance.now();
      await api(srv.base, 'GET', '/api/auth/me');
      worst = Math.max(worst, performance.now() - t0);
    }
  })();
  const checks = await Promise.all(Array.from({ length: 6 }, () => api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin })));
  state.running = false;
  await probe;
  for (const c of checks) {
    assert.equal(c.status, 200);
    assert.equal(c.body.ok, true, JSON.stringify(c.body));
    assert.ok(c.body.entries > n, 'the seeded chain and the server\'s own entries: ' + c.body.entries);
  }
  assert.ok(worst < 300, 'a page asking meanwhile waited at most ' + Math.round(worst) + ' ms');
});
