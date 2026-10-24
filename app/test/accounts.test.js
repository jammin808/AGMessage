'use strict';
// Accounts, rights and the audit trail: the permission model (pure), password hashing and policy, sessions, the
// hash chain, and the whole of it end to end — first admin, sign-in, managing accounts, joining a hall as an account,
// rights changed under a live socket, the origin check, and the audit log that records it all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const rbac = require('../lib/rbac');
const acc = require('../lib/accounts');
const { AuditLog } = require('../lib/audit');
const { startServer, stopServer, api, connect, emit, once, wait, TOKEN } = require('./helpers');

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
    assert.equal(tunnel.status, 403, 'admin rights do not sign in through the tunnel by default');
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
