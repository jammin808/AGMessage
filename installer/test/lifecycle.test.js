'use strict';
// The installer's life cycle (the 0.6.0 plan's Part 6, unit U16), run for real on CI's elevated windows-2025 job
// (.github/workflows/ci.yml, lifecycle): this build's installer, the build before it and a build that does not start, all
// made from one payload, installed, upgraded, refused, rolled back, gone back from and uninstalled on one runner, in this
// order, each test leaving what the next begins from. Each is one node:test, and the job checks that every test declared
// here ran and passed (tools/lifecycle.js count). What each step must say is installer/test/expect.js's, which
// test/lifecycle.test.js holds to the code on Linux. It refuses any machine but an elevated GitHub-hosted Windows runner
// with no AGMessage on it, before anything is made (hands.js placeRefusal).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hands, placeRefusal, until, sleep, runAsync, PORT } = require('./hands.js');
const expect = require('./expect.js');

const REPO = path.join(__dirname, '..', '..');
const refused = placeRefusal();
if (refused) throw new Error('installer/test/lifecycle.test.js: ' + refused + '. Nothing was made.');

if (!process.env.AGM_LIFECYCLE) throw new Error('installer/test/lifecycle.test.js: AGM_LIFECYCLE names no plan: the life cycle runs from CI\'s lifecycle job, which writes one. Nothing was made.');

const machine = require(path.join(REPO, 'app', 'machine.js'));
const wire = require(path.join(REPO, 'app', 'lib', 'machinewire.js'));
const { compareBuilds } = require(path.join(REPO, 'app', 'lib', 'version.js'));
const { BROKEN_SERVER } = require(path.join(REPO, 'tools', 'lifecycle.js'));
const { daclOf } = require(path.join(REPO, 'tools', 'readings.js'));
const { api, connect, answer, freePort } = require(path.join(REPO, 'app', 'test', 'helpers.js'));
const { WORDS } = expect;

const PLAN = expect.planOf(fs.readFileSync(process.env.AGM_LIFECYCLE, 'utf8'));
fs.mkdirSync(PLAN.logs, { recursive: true });
fs.mkdirSync(PLAN.work, { recursive: true });
const H = hands({ work: PLAN.work, logs: PLAN.logs });
/** The three builds, each read from its installer's own version resource: the build before this one, this one, and the next, which does not start. */
const B = Object.fromEntries(['previous', 'current', 'broken'].map((k) => {
  const b = expect.buildOf(H.productVersion(PLAN[k].exe));
  if (!b) throw new Error('the ' + k + ' installer names no numbered build in its version resource');
  return [k, { ...b, exe: PLAN[k].exe, payload: expect.payloadOf(fs.readFileSync(PLAN[k].payload, 'utf8')) }];
}));
if (compareBuilds(B.previous.full, B.current.full) !== -1 || compareBuilds(B.current.full, B.broken.full) !== -1) {
  throw new Error('the three installers are not in their order by MAJOR.MINOR.BUILD: ' + B.previous.full + ', ' + B.current.full + ', ' + B.broken.full);
}
/** This runner's account, the one /ADMIN= names: AGMessage's admin on this PC. */
const ME = machine.accountOf(H.run(H.exe('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).out);
if (!ME) throw new Error('this runner\'s account could not be read (whoami.exe)');
const ADMIN = String(process.env.COMPUTERNAME || '') + '\\' + String(process.env.USERNAME || '');
const SERVER_TASK = '\\AGMessage\\Server';
const BASE = 'http://127.0.0.1:' + PORT;
/** The life cycle's standard account and its own folder of Task Scheduler (never \AGMessage\, which an uninstall empties). */
const STD_NAME = 'agmlifecycle';
const PROBE_TASK = '\\AGMessage-Lifecycle\\AsAccount';
/** Each hook's bound: the standard account made and the portable copy laid before, both removed after. */
const HOOK_MS = 5 * 60_000;
/** What one test leaves the next. */
const S = {};
const report = [];
/** Every token and password the life cycle saw or made, by label, for the searches of the logs and the tasks. */
const secrets = () => [...[...H.tokens].map((value) => ({ label: 'a token', value })), ...[...H.passwords].map((value) => ({ label: 'a password', value }))];
/**
 * A text the job's log, its TAP report or its summary may carry: every token and password the life cycle knows put as its
 * label. Each assertion's message that quotes what a program said goes through it, and so does the report.
 */
const scrub = (text) => expect.scrubbed(text, secrets());
const note = (line) => { report.push('- ' + scrub(line)); };

const passphrase = () => { const p = expect.seedPassphrase(crypto.randomBytes(9).toString('base64url')); H.passwords.add(p); return p; };
const ci = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const exists = (f) => fs.existsSync(f);
/** What a run said, for an assertion's message: its exit code and its log's last messages. */
const said = (r) => scrub('exit ' + r.code + '; its log ends: ' + r.said.messages.slice(-14).join(' | ').slice(-3500));
const machineSaid = (r, verb) => r.said.machine.filter((m) => m.verb === verb);
/** Nothing of an install anywhere: no record, no install folder, no machine folder, no task in \AGMessage\. */
function nothingMade() {
  assert.equal(H.record(), null, 'no install record');
  assert.ok(!exists(H.app), H.app + ' was not made');
  assert.ok(!exists(H.root), H.root + ' was not made');
  assert.deepEqual(H.agmTasks(), [], 'no task in \\AGMessage\\');
}
/** The installed node proving it holds the token as `b`'s build: its hello. */
async function serving(b, what) {
  const h = await H.proven(b.full, { ms: 90000 });
  assert.ok(h.ok, what + ': AGMessage ' + b.full + ' does not prove it holds the token on port ' + PORT + ' (' + (h.words || h.build) + ')');
  return h;
}
/** The pid of the installed node's server (node.exe on {app}\app\server.js), or 0. */
function serverPid() {
  const p = H.programs(H.app).find((x) => /[\\/]app[\\/]server\.js"?(\s|$)/i.test(x.cmd));
  return p ? p.pid : 0;
}
/** The installed node stopped, as an administrator's elevated console stops it (it saves), and its port closed. */
async function stopInstalled(reason) {
  const r = await H.control({ verb: 'stop', force: reason });
  assert.equal(r.code, 0, scrub('stopped: ' + JSON.stringify(r.said)));
  assert.ok(await until(async () => !(await H.answers()), 60000), 'the port closed once AGMessage stopped');
}
/** The installed node started, as an administrator's elevated console starts it, and proving itself as `b`. */
async function startInstalled(b) {
  const r = await H.control({ verb: 'start' });
  assert.equal(r.code, 0, scrub('started: ' + JSON.stringify(r.said)));
  return serving(b, 'started again');
}
/** The audit log's newest line as it lies (the head a later chain must still hold). */
const auditHead = () => fs.readFileSync(path.win32.join(H.root, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').pop();
/** The install folder against a build's payload. */
function payloadIs(b) {
  const sums = new Map([...H.tree(H.app)].map(([rel, f]) => [rel, f.sha]));
  const { wrong, strays } = expect.againstPayload(sums, b.payload);
  assert.deepEqual(wrong, [], 'every file of ' + b.full + '\'s payload laid with its SHA-256');
  assert.deepEqual(strays, [], 'nothing in ' + H.app + ' but the payload, Inno Setup\'s own and the kept installers');
}
/** How long each ask of the installed node at loopback may take before its test fails, naming the ask. */
const ASK_MS = 15_000;
/**
 * A first admin account made at loopback with the token (as the installer's page, or Admin login, makes one), a hall,
 * and a code guest's messages; and the context read once with a wrong token, so its own token is made and sealed. Each
 * ask is answered within ASK_MS or fails, naming it.
 */
async function seed(token, hallName) {
  const password = passphrase();
  const setup = await api(BASE, 'POST', '/api/setup', { token, username: expect.SEED_ACCOUNT.username, name: expect.SEED_ACCOUNT.name, password }, { ms: ASK_MS });
  assert.equal(setup.status, 200, scrub('the first admin account: ' + JSON.stringify(setup.body)));
  const hall = await api(BASE, 'POST', '/api/rooms', { name: hallName }, { cookie: setup.cookie, ms: ASK_MS });
  assert.match(String(hall.body && hall.body.code), /^[A-Z0-9]{6}$/, scrub('a hall: ' + JSON.stringify(hall.body)));
  const s = await connect(BASE, '');
  try {
    const j = await answer(s, 'join', { roomCode: hall.body.code, name: 'Ana', role: 'research' }, ASK_MS);
    assert.equal(j.ok, true, scrub('Ana joins: ' + JSON.stringify(j)));
    for (let i = 1; i <= 3; i++) {
      const m = await answer(s, 'message', { type: 'text', text: 'The installer\'s life cycle, message ' + i }, ASK_MS);
      assert.equal(m.ok, true, scrub('message ' + i + ': ' + JSON.stringify(m)));
    }
  } finally { s.close(); }
  const ctx = await fetch(BASE + '/api/context', { headers: { authorization: 'Bearer not-this-nodes-context-token' }, signal: AbortSignal.timeout(ASK_MS) });
  assert.equal(ctx.status, 401, 'the context, asked with a wrong token, is refused (and its own token made, sealed)');
  return { code: hall.body.code };
}
test.before(() => {
  S.std = H.account(STD_NAME);
  S.portable = H.copy(PLAN.portable, path.win32.join(PLAN.work, 'portable', 'AGMessage'));
}, { timeout: HOOK_MS });

test.after(() => {
  try { H.L.remove(PROBE_TASK); } catch (e) { console.error('the probe\'s task was not removed: ' + scrub(e.message)); }
  try { H.accountGone(STD_NAME); } catch (e) { console.error('the standard account was not removed: ' + scrub(e.message)); }
  const text = scrub('### The installer\'s life cycle on ' + [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join(' ') + '\n\n' +
    '- Builds: ' + B.previous.full + ' (before), ' + B.current.full + ' (this one), ' + B.broken.full + ' (does not start)\n' + report.join('\n') + '\n\n');
  fs.writeFileSync(path.join(PLAN.logs, 'report.md'), text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}, { timeout: HOOK_MS });

// ---------------------------------------------------------------- before anything is installed

test('a quiet first install that names no account with /ADMIN= is refused with its words, and nothing is made', { timeout: 5 * 60_000 }, async () => {
  const r = await H.install(B.previous.exe, [], 'quiet-without-admin');
  assert.notEqual(r.code, 0, said(r));
  assert.ok(r.said.refused.includes(WORDS.quietAdmin()), said(r));
  nothingMade();
});

test('an install into another folder (/DIR=) is refused before anything is made', { timeout: 5 * 60_000 }, async () => {
  const elsewhere = path.win32.join(PLAN.work, 'elsewhere');
  const r = await H.install(B.previous.exe, ['/DIR=' + elsewhere, '/ADMIN=' + ADMIN], 'another-folder');
  assert.notEqual(r.code, 0, said(r));
  assert.ok(r.said.refused.includes(WORDS.otherDir(H.app)), said(r));
  assert.ok(!exists(elsewhere), elsewhere + ' was not made');
  nothingMade();
});

test('a junction made at the machine folder before the first install is refused, and nothing is laid where it points', { timeout: 5 * 60_000 }, async () => {
  const aside = path.win32.join(PLAN.work, 'aside');
  fs.mkdirSync(aside, { recursive: true });
  H.junction(H.root, aside);
  try {
    const r = await H.install(B.previous.exe, ['/ADMIN=' + ADMIN], 'junction');
    assert.notEqual(r.code, 0, said(r));
    assert.ok(machineSaid(r, 'prepare').some((m) => m.code === 3 && m.words === WORDS.notOurs(H.root)), said(r));
    assert.ok(r.said.refused.includes(WORDS.notOurs(H.root)), said(r));
    assert.deepEqual(fs.readdirSync(aside), [], 'nothing laid where the junction points');
    assert.equal(H.record(), null, 'no install record');
    assert.ok(!exists(H.app), H.app + ' was not made');
  } finally { fs.unlinkSync(H.root); }
  assert.ok(!exists(H.root) && exists(aside), 'the junction is gone, and the folder it named is as it was');
});

test('a folder another account made at the machine folder before the first install is refused, and is left as it was', { timeout: 5 * 60_000 }, async () => {
  fs.mkdirSync(H.root);
  H.setOwner(H.root, S.std.sid);
  try {
    const r = await H.install(B.previous.exe, ['/ADMIN=' + ADMIN], 'another-owner');
    assert.notEqual(r.code, 0, said(r));
    assert.ok(r.said.refused.includes(WORDS.notOurs(H.root)), said(r));
    assert.equal(machine.ownerSidOf(H.sddl(H.root)), S.std.sid, 'its owner is still the account that made it');
    assert.deepEqual(fs.readdirSync(H.root), [], 'nothing was laid in it');
    assert.equal(H.record(), null, 'no install record');
  } finally { fs.rmdirSync(H.root); }
});

test('a portable copy serving on the port is refused with words naming it, and nothing is made', { timeout: 5 * 60_000 }, async () => {
  const w = H.portable(S.portable);
  try {
    const h = await until(() => H.health(), 60000);
    assert.ok(h && h.runs !== 'task', scrub('the portable copy serves: ' + w.tail().slice(-1500)));
    // Its halls are what the import, later, carries into an installed AGMessage that has never started.
    S.portableSeed = await seed(w.token, 'Portable hall');
    const r = await H.install(B.previous.exe, ['/ADMIN=' + ADMIN], 'portable-on-port');
    assert.notEqual(r.code, 0, said(r));
    assert.ok(machineSaid(r, 'preinstall-check').some((m) => m.code === 3 && m.words === WORDS.portable({ version: h.version, port: PORT })), said(r));
    nothingMade();
  } finally {
    assert.equal(await H.portableStop(w), 0, scrub('the portable copy stopped: ' + w.tail().slice(-800)));
  }
});

// ---------------------------------------------------------------- the install, and the upgrade from the build before this one

test('the install of the build before this one, quiet: the record names its build and the account /ADMIN= named, its tasks and rules are made, and its server task serves it, proving the token', { timeout: 8 * 60_000 }, async () => {
  const r = await H.install(B.previous.exe, ['/ADMIN=' + ADMIN], 'install-previous');
  assert.equal(r.code, 0, said(r));
  const rec = H.record();
  assert.ok(rec, 'the install record');
  assert.deepEqual([rec.Version, rec.SemVer, rec.Previous, rec.Port, rec.Runs, rec.Admin], [B.previous.installVersion, B.previous.semver, '', String(PORT), 'task', ME.sid]);
  assert.ok(ci(rec.InstallDir, H.app), 'InstallDir names ' + H.app + ': ' + rec.InstallDir);
  assert.ok(rec.AdminName, 'the admin\'s name kept for the words');
  for (const name of [SERVER_TASK, machine.controlTask(ME.sid)]) assert.ok(H.task(name).exists, name + ' is registered');
  assert.deepEqual(H.rules(), { [machine.RULE_TCP]: true, [machine.RULE_UDP]: true }, 'both firewall rules');
  await serving(B.previous, 'the install');
  const health = await H.health();
  assert.equal(health && health.runs, 'task', 'it runs as the server task');
  assert.ok(H.events().some((e) => e.kind === 'machine.admin' && e.for.sid === ME.sid), 'machine.admin names its admin');
  assert.ok(!exists(path.win32.join(H.root, 'setup')), 'the setup folder is gone');
  note('Installed ' + B.previous.full + ' in ' + Math.round(r.ms / 1000) + ' s.');
});

test('the build before this one serves at loopback: a first admin account made with the token, a hall and its messages, and it reads busy', { timeout: 3 * 60_000 }, async () => {
  S.seed = await seed(H.token(), 'Hall 1');
  const b = await wire.busy({ port: PORT, token: H.token() });
  assert.equal(b.busy, true, 'its messages make it busy: ' + b.words);
  const f = await until(async () => { const x = await H.facts(); return x.messages >= 3 && x.accounts >= 1 && x.sealed.total >= 1 ? x : null; }, 60000, 1000);
  assert.ok(f, 'the hall, its messages, the account and a sealed value are on disk: ' + JSON.stringify(await H.facts()));
});

test('an upgrade of a busy AGMessage with no reason typed is refused, and the earlier build serves on', { timeout: 6 * 60_000 }, async () => {
  const before = H.record();
  const pid = serverPid();
  const r = await H.install(B.current.exe, [], 'upgrade-busy-without-reason');
  assert.notEqual(r.code, 0, said(r));
  assert.ok(machineSaid(r, 'preinstall-check').some((m) => m.code === 3 && WORDS.busy.test(m.words)), said(r));
  assert.deepEqual(machineSaid(r, 'upgrade-stop'), [], 'nothing was stopped');
  assert.deepEqual(H.record(), before, 'the record is as it was');
  await serving(B.previous, 'the earlier build');
  assert.equal(serverPid(), pid, 'the same server serves on');
});

test('an upgrade while a silent program holds the port is refused, naming its pid, and the earlier build serves again', { timeout: 6 * 60_000 }, async () => {
  const before = H.record();
  await stopInstalled('the installer\'s life cycle holds the port with a silent program');
  const s = await H.silent();
  try {
    const r = await H.install(B.current.exe, ['/FORCE=the installer\'s life cycle upgrades past the busy line'], 'upgrade-silent-port');
    assert.notEqual(r.code, 0, said(r));
    assert.ok(r.said.refused.includes(WORDS.silent({ port: PORT, pid: s.pid }) + ' Nothing was changed.'), said(r));
    assert.deepEqual(H.record(), before, 'the record is as it was');
  } finally { await s.close(); }
  await startInstalled(B.previous);
});

test('the upgrade to this build, its reason typed: halls, messages, accounts, every sealed value, the certificate\'s fingerprint and the audit head kept, and the stop timed to the new build\'s health', { timeout: 10 * 60_000 }, async () => {
  const before = { record: H.record(), facts: await H.facts(), head: auditHead() };
  S.upgradeAt = Date.now();
  // The new build's first proof, watched beside the installer from its start: the stop's record says when it stopped. The
  // watch ends with the installer, however it ended, and at the test's own bound at the latest.
  const seen = { healthAt: 0, installing: true };
  const watchEnds = Date.now() + 10 * 60_000;
  const watch = (async () => {
    while (seen.installing && !seen.healthAt && Date.now() < watchEnds) {
      const t = H.token();
      const h = t ? await wire.hello({ port: PORT, token: t, timeoutMs: 1000 }) : { ok: false };
      if (h.ok && h.build === B.current.full) seen.healthAt = Date.now();
      else await sleep(200);
    }
  })();
  let r;
  try { r = await H.install(B.current.exe, ['/FORCE=the installer\'s life cycle upgrades a busy AGMessage'], 'upgrade'); } finally {
    seen.installing = false;
    await watch;
  }
  let healthAt = seen.healthAt;
  assert.equal(r.code, 0, said(r));
  const rec = H.record();
  assert.deepEqual([rec.Version, rec.SemVer, rec.Previous, rec.Admin, rec.AdminName], [B.current.installVersion, B.current.semver, B.previous.installVersion, before.record.Admin, before.record.AdminName]);
  await serving(B.current, 'the upgrade');
  if (!healthAt) healthAt = Date.now();
  const after = await H.facts();
  assert.deepEqual(expect.factsKept(before.facts, after), [], 'kept across the upgrade');
  assert.ok(after.sealed.total >= 1 && after.cert.fp, 'a sealed value and a certificate to keep: ' + JSON.stringify({ sealed: after.sealed, cert: after.cert.state }));
  assert.ok(fs.readFileSync(path.win32.join(H.root, 'data', 'audit.jsonl'), 'utf8').split('\n').map((l) => l.trim()).includes(before.head), 'the audit log\'s head before the upgrade is in its chain after');
  for (const b of [B.previous, B.current]) assert.ok(exists(path.win32.join(H.app, 'installers', 'AGMessage-Setup-' + b.installVersion + '-unsigned.exe')), 'the installer of ' + b.full + ' is kept for the way back');
  assert.ok(exists(path.win32.join(H.menu, 'Go back to build ' + B.previous.build + '.lnk')), 'the Start menu offers Go back to build ' + B.previous.build);
  const stop = machineSaid(r, 'upgrade-stop').find((m) => m.code === 0);
  assert.ok(stop && WORDS.upgradeStopped.test(stop.words), 'the upgrade\'s stop saved and backed up: ' + said(r));
  S.upgradeStop = stop.words.match(WORDS.upgradeStopped).groups.backup;
  S.stopToHealth = { healthAt, installMs: r.ms };
});

test('the upgrade\'s stop wrote last-stop.json: it saved, it names the build it stopped, and the backup it made for the way back is there', { timeout: 60_000 }, () => {
  // The new build's start took the record (last-stop.seen.json), so a crash after it is never read as this stop.
  const dir = path.win32.join(H.root, 'data');
  const file = ['last-stop.seen.json', 'last-stop.json'].map((n) => path.win32.join(dir, n)).find(exists);
  assert.ok(file, 'the stop\'s record is in ' + dir);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([rec.saved, rec.build, rec.backup], [true, B.previous.full, S.upgradeStop]);
  assert.ok(rec.at >= S.upgradeAt && rec.at <= S.stopToHealth.healthAt, 'written by this upgrade\'s stop');
  assert.ok(fs.statSync(path.win32.join(dir, ...rec.backup.split('/'))).isDirectory(), 'its backup is there: ' + rec.backup);
  const ms = S.stopToHealth.healthAt - rec.at;
  note('The upgrade from ' + B.previous.full + ': stopped and saved at ' + new Date(rec.at).toISOString() + ' (backup made in ' + (rec.backupMs ?? '?') + ' ms), this build answering ' + (ms / 1000).toFixed(1) + ' s later; the installer ran ' + Math.round(S.stopToHealth.installMs / 1000) + ' s.');
});

test('a downgrade is refused with words, and this build serves on', { timeout: 5 * 60_000 }, async () => {
  const before = H.record();
  const pid = serverPid();
  const r = await H.install(B.previous.exe, ['/FORCE=the installer\'s life cycle'], 'downgrade');
  assert.notEqual(r.code, 0, said(r));
  assert.ok(r.said.refused.includes(WORDS.newer({ installed: B.current, installer: B.previous })), said(r));
  assert.deepEqual(H.record(), before);
  await serving(B.current, 'after the downgrade refused');
  assert.equal(serverPid(), pid, 'the same server serves on');
});

test('the same build again is refused with words, and this build serves on', { timeout: 5 * 60_000 }, async () => {
  const before = H.record();
  const pid = serverPid();
  const r = await H.install(B.current.exe, ['/FORCE=the installer\'s life cycle'], 'same-build');
  assert.notEqual(r.code, 0, said(r));
  assert.ok(r.said.refused.includes(WORDS.same({ installed: B.current })), said(r));
  assert.deepEqual(H.record(), before);
  await serving(B.current, 'after the same build refused');
  assert.equal(serverPid(), pid, 'the same server serves on');
});

test('every installed file is the payload\'s: each file SHA256SUMS.payload names laid with its SHA-256, and nothing else but Inno Setup\'s own and the kept installers', { timeout: 5 * 60_000 }, () => {
  payloadIs(B.current);
  S.laid = H.tree(H.app);
  note('Laid ' + B.current.payload.size + ' files of ' + B.current.full + ', each its SHA-256.');
});

test('the machine folder\'s root, keys, data and logs give Users, Authenticated Users, Everyone and CREATOR OWNER no entry', { timeout: 60_000 }, () => {
  for (const dir of [H.root, ...['keys', 'data', 'logs'].map((n) => path.win32.join(H.root, n))]) {
    const sddl = H.sddl(dir);
    assert.deepEqual(expect.forbiddenOn(sddl), [], dir + ': ' + sddl);
  }
  assert.ok([machine.SID.system, machine.SID.admins].includes(machine.ownerSidOf(H.sddl(H.root))), 'the root is SYSTEM\'s or Administrators\'');
});

test('the server\'s token holds no SeImpersonatePrivilege', { timeout: 2 * 60_000 }, () => {
  const ours = H.programs(H.app).filter((p) => machine.serverProgram(p) && /node\.exe$/i.test(p.name));
  assert.ok(ours.some((p) => /[\\/]app[\\/]server\.js"?(\s|$)/i.test(p.cmd)), 'the server runs: ' + JSON.stringify(ours.map((p) => p.name)));
  const seen = new Set();
  for (const p of ours) {
    const got = H.privileges(p.pid);
    assert.ok(Array.isArray(got.privileges) && got.privileges.length, 'the token of pid ' + p.pid + ' read: ' + JSON.stringify(got));
    assert.ok(!got.privileges.includes('SeImpersonatePrivilege'), 'pid ' + p.pid + ' holds ' + got.privileges.join(', '));
    for (const x of got.privileges) seen.add(x);
  }
  note('The server task\'s processes (' + ours.length + ') hold ' + [...seen].join(', ') + '.');
});

// ---------------------------------------------------------------- on an installed PC (the plan's unit S, 2-S.3)

test('On an installed PC: the zip\'s start-agmessage.bat run from a throwaway folder names the installed build in its banner and ends with 3, saying the installed AGMessage serves on its port', { timeout: 3 * 60_000 }, async () => {
  const dir = H.copy(PLAN.portable, path.win32.join(PLAN.work, 'bat', 'AGMessage'));
  const h = await H.health();
  assert.ok(h && h.runs === 'task', 'the installed node serves');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'PORT' || k.startsWith('AGM_') || k === 'ADMIN_TOKEN') delete env[k];
  const r = H.run(H.exe('cmd.exe'), ['/d', '/c', path.win32.join(dir, 'start-agmessage.bat')], { cwd: dir, env, input: '', ms: 120000 });
  const out = r.out + r.err;
  assert.equal(r.code, 3, scrub(out.slice(-2000)));
  assert.ok(out.includes(WORDS.batBanner(B.current.semver)), scrub(out.slice(0, 1500)));
  assert.ok(out.includes(WORDS.batInstalled({ version: h.version, build: h.build, port: PORT })), scrub(out.slice(-2000)));
  assert.ok(out.includes(WORDS.batEnd()), scrub(out.slice(-800)));
  await serving(B.current, 'the installed node, beside the refused copy');
});

test('On an installed PC: a portable copy started first on the installed node\'s port, the installed node\'s log says another copy holds it, and the node serves once the copy is stopped', { timeout: 6 * 60_000 }, async () => {
  await stopInstalled('the installer\'s life cycle lets a portable copy take the port');
  const dir = H.copy(PLAN.portable, path.win32.join(PLAN.work, 'first', 'AGMessage'));
  const w = H.portable(dir, { env: { AGM_KEY_DIR: path.win32.join(PLAN.work, 'first', 'keys') } });
  let stopped = false;
  try {
    const ph = await until(() => H.health(), 60000);
    assert.ok(ph && ph.runs !== 'task', scrub('the portable copy serves: ' + w.tail().slice(-1500)));
    const log = path.win32.join(H.root, 'logs', 'server.log');
    const at = exists(log) ? fs.statSync(log).size : 0;
    assert.equal(H.run(H.exe('schtasks.exe'), ['/Run', '/TN', SERVER_TASK]).code, 0, 'the server task runs');
    const words = WORDS.anotherCopy({ version: ph.version, build: ph.build, port: PORT });
    const heard = await until(() => { try { return fs.readFileSync(log).subarray(at).toString('utf8').includes(words); } catch { return false; } }, 90000, 1000);
    assert.ok(heard, 'server.log says: ' + words);
    assert.equal(await H.portableStop(w), 0, 'the portable copy stopped');
    stopped = true;
    await serving(B.current, 'the installed node, once the copy stopped');
  } finally { if (!stopped) await H.portableStop(w); }
});

// ---------------------------------------------------------------- the laptop's admin's rights, the tasks, the import

test('a local standard account given start and stop runs its own control task: AGMessage stopped with its reason and saved, then started, each one machine event naming it', { timeout: 15 * 60_000 }, async (t) => {
  const g = await H.control({ verb: 'grant', account: String(process.env.COMPUTERNAME) + '\\' + STD_NAME, rights: ['start', 'stop'] });
  assert.equal(g.code, 0, scrub(JSON.stringify(g.said)));
  assert.match(g.said.words, WORDS.granted);
  assert.equal(H.grants()[S.std.sid], 'start,stop', 'the record names its rights');
  const control = machine.controlTask(S.std.sid);
  assert.ok(H.task(control).exists, control + ' is registered');
  const seq = Math.max(0, ...H.events().map((e) => e.seq));
  const probe = path.win32.join(PLAN.work, 'std');
  fs.mkdirSync(probe, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'as-account.js'), path.win32.join(probe, 'as-account.js'));
  const granted = H.run(H.exe('icacls.exe'), [probe, '/grant', '*' + S.std.sid + ':(OI)(CI)M'], { cwd: H.sys });
  assert.equal(granted.code, 0, scrub(granted.err || granted.out));
  const id = () => crypto.randomBytes(12).toString('hex');
  const requests = [{ id: id(), verb: 'stop', force: 'the installer\'s life cycle, as a standard account' }, { id: id(), verb: 'start' }];
  fs.writeFileSync(path.win32.join(probe, 'plan.json'), JSON.stringify({
    task: control,
    inbox: path.win32.join(H.root, 'machine', 'inbox', S.std.sid, 'request.json'),
    answer: path.win32.join(H.root, 'machine', 'outbox', S.std.sid, 'answer.json'),
    runMs: expect.PROBE.runMs,
    answerMs: expect.PROBE.answerMs,
    requests,
  }));
  const ranNow = () => { try { return JSON.parse(fs.readFileSync(path.win32.join(probe, 'ran.json'), 'utf8')); } catch { return null; /* not written yet, or being written */ } };
  // The account was given "Log on as a batch job", which a task that runs as it by its password needs, and it was read
  // back (hands.js account). Lab 7 takes this only where Windows' own policy refuses the account a batch logon ("Deny log
  // on as a batch job" on it or its groups), or refuses its logon otherwise, at the task's registration or as its result
  // with no line written (expect.js logonRefused, the batch logon no longer counted once granted): a grant that did not
  // hold, and any other failure, a probe that ran and did not finish included, fail here, with Task Scheduler's own why.
  const logon = S.std.logon;
  let lab7 = logon.deny.length ? 'Windows denies the account a batch logon by policy ("Deny log on as a batch job" held by ' + logon.deny.join(', ') + ')' : '';
  if (!lab7) assert.ok(logon.batch && logon.enabled && !logon.mustChange, 'the standard account can be logged on by a task (Log on as a batch job granted and read back, enabled, no new password needed): ' + scrub(JSON.stringify({ ...logon, history: S.std.history })));
  let warned = '';
  if (!lab7) {
    try {
      warned = H.taskAs(PROBE_TASK, S.std, { node: path.win32.join(H.app, 'node', 'node.exe'), script: path.win32.join(probe, 'as-account.js'), dir: probe, limitMinutes: expect.PROBE.limitMinutes });
    } catch (e) {
      lab7 = expect.logonRefused({ words: e.message, granted: true });
      const batch = expect.BATCH_REFUSED_WORDS.test(e.message);
      if (!lab7) throw new Error(scrub('the probe\'s task as ' + STD_NAME + ' was not registered' + (batch ? ': Windows refused its batch logon although it was granted and read back' : ', and Windows did not refuse its logon') + ': ' + e.message + '; its logon as read: ' + JSON.stringify(logon)), { cause: e });
    }
  }
  if (!lab7) {
    const since = new Date(Date.now() - 2000).toISOString();
    const r = H.run(H.exe('schtasks.exe'), ['/Run', '/TN', PROBE_TASK]);
    assert.equal(r.code, 0, 'the probe\'s task runs: ' + scrub((r.err || r.out).trim().slice(0, 300)));
    // Its first line is written as the account's node.exe starts: a task that wrote none ran no probe as the account.
    if (!(await until(ranNow, expect.PROBE.startMs, 1000))) {
      const s = H.task(PROBE_TASK);
      const why = H.L.whyNot(PROBE_TASK, since);
      lab7 = expect.logonRefused({ lastResult: s.lastResult, granted: true }) || expect.logonRefused({ lastResult: why.code, granted: true });
      // Windows refusing a logon the life cycle granted (a batch logon, or the password it made the account with) is said as
      // that, with the account's logon as read back; a task that started, or said nothing, did not run the probe.
      const refusedAnyway = !why.started && (/logged its account on/.test(why.words) || (why.code !== null && Object.hasOwn(expect.LOGON_REFUSED, why.code)) || Object.hasOwn(expect.LOGON_REFUSED, Number.isSafeInteger(s.lastResult) ? s.lastResult >>> 0 : -1));
      if (!lab7) assert.fail(scrub('the probe\'s task as ' + STD_NAME + ' wrote no line within ' + expect.PROBE.startMs / 1000 + ' s, and ' + (refusedAnyway ? 'Windows refused its logon although "Log on as a batch job" was granted and read back' : 'Windows did not refuse its logon') + ' (state ' + s.state + ', last result ' + expect.resultWords(s.lastResult) + '): ' + why.words + (warned ? '; ' + warned : '') + (refusedAnyway ? '' : '; node.exe in ' + H.app + ' did not start as that account, or could not run the probe') + '; its logon as read: ' + JSON.stringify(logon)));
    }
  }
  if (lab7) {
    // The plan's own fallback: a runner that runs no second account's process leaves this to the show laptop's lab 7.
    t.diagnostic('lab 7: ' + lab7);
    note('A standard account given start and stop: ' + lab7 + ', so this runner runs no process as a second account; lab 7 takes it on the show laptop. Its grant, record and control task were made and read.');
    await serving(B.current, 'after the grant');
    return;
  }
  // It ran as the account: from here its steps are asserted, and a probe that does not finish within its own longest run fails.
  const ran = await until(() => { const j = ranNow(); return j && j.done ? j : null; }, expect.probeWorstMs(requests.length) + 60_000, 1000) || ranNow();
  assert.ok(ran && ran.done && !ran.error, 'the probe as ' + STD_NAME + ' ran to its end: ' + scrub(JSON.stringify(ran)) + ' (its task: ' + JSON.stringify(H.task(PROBE_TASK)) + ')');
  assert.equal(String(ran.user).toLowerCase(), STD_NAME, 'the probe ran as the standard account');
  const [stop, start] = ran.steps;
  assert.ok(stop && stop.answer && start && start.answer, scrub('both requests answered: ' + JSON.stringify(ran)));
  assert.deepEqual([stop.answer.code, stop.answer.ranAs, stop.answer.for], [0, machine.SID.system, S.std.sid], scrub(JSON.stringify(stop)));
  assert.match(stop.answer.words, WORDS.stopped);
  assert.deepEqual([start.answer.code, start.answer.ranAs, start.answer.for], [0, machine.SID.system, S.std.sid], scrub(JSON.stringify(start)));
  assert.match(start.answer.words, WORDS.started);
  const theirs = H.events().filter((e) => e.seq > seq && e.by.sid === S.std.sid).map((e) => e.kind);
  assert.deepEqual(theirs, ['machine.stop', 'machine.start'], 'one event each, naming the account');
  await serving(B.current, 'started by the standard account');
  note('A standard account given start and stop ran its own control task (SYSTEM, for its SID): stopped, saved, started.');
});

test('neither the server task nor a control task holds a secret in its definition', { timeout: 2 * 60_000 }, () => {
  H.token();
  const names = [SERVER_TASK, machine.controlTask(ME.sid), ...(H.task(machine.controlTask(S.std.sid)).exists ? [machine.controlTask(S.std.sid)] : [])];
  for (const name of names) {
    const d = H.definition(name);
    assert.ok(typeof d.xml === 'string' && d.xml.includes('<Task'), name + '\'s definition read');
    assert.deepEqual(expect.secretsIn(d.xml, secrets()), [], name + ' holds no token or password');
    assert.ok(!expect.STORED_PASSWORD.test(d.xml), name + ' keeps no password of its own');
  }
});

test('the import is refused on a node that has served, with its words, and nothing is made ready', { timeout: 2 * 60_000 }, async () => {
  const r = await H.machineJs(['import', '--step', 'stage', '--for', ME.sid, '--machine', H.root, '--sys', H.sys]);
  assert.equal(r.code, machine.REFUSED, scrub(JSON.stringify(r.said)));
  assert.match(r.said.words, WORDS.served);
  assert.ok(!exists(path.win32.join(H.root, 'machine', 'inbox', ME.sid, 'import')), 'no import folder was made');
});

test('the import before a first start: the portable folder exported as its account, taken and verified elevated, its old keys removed, the folder marked as moved and refused at its next start', { timeout: 10 * 60_000 }, async () => {
  // An installed node that has served refuses any import, and a quiet install starts its node: the import's verify runs
  // into a machine folder of the life cycle's own that has never started, with this install's machine.js, launch.js and
  // facts reader, as the installer's import page runs them before the first start.
  const target = path.win32.join(PLAN.work, 'import', 'ProgramData', 'AGMessage');
  for (const sub of ['data', 'uploads', 'keys', 'logs', 'token', 'machine\\inbox', 'machine\\outbox', 'machine\\work']) fs.mkdirSync(path.win32.join(target, sub), { recursive: true });
  const src = S.portable;
  const profile = path.win32.join(String(process.env.LOCALAPPDATA), 'AGMessage');
  const before = await H.facts({ data: path.win32.join(src, 'app', 'data'), keys: profile });
  assert.ok(before.halls >= 1 && before.messages >= 3 && before.accounts >= 1, 'the portable folder holds what its copy was given: ' + JSON.stringify(before));
  const launch = (args) => runAsync(path.win32.join(H.app, 'node', 'node.exe'), [path.win32.join(H.app, 'app', 'launch.js'), ...args], { cwd: path.win32.join(H.app, 'app'), ms: 300000 });
  const stage = await H.machineJs(['import', '--step', 'stage', '--for', ME.sid, '--machine', target, '--sys', H.sys]);
  assert.equal(stage.code, 0, scrub(JSON.stringify(stage.said)));
  const exported = await launch(['export', '--source', src, '--machine', target, '--sys', H.sys]);
  const answer = JSON.parse(fs.readFileSync(path.win32.join(target, 'machine', 'inbox', ME.sid, 'import', 'export.json'), 'utf8'));
  assert.deepEqual([exported.code, answer.code], [0, 0], scrub(answer.words + ' ' + exported.out + exported.err));
  const take = await H.machineJs(['import', '--step', 'take', '--for', ME.sid, '--machine', target, '--app', H.app, '--source', src, '--sys', H.sys]);
  assert.equal(take.code, 0, scrub(JSON.stringify(take.said)));
  assert.equal(take.said.verified, true);
  assert.match(take.said.words, WORDS.imported);
  assert.deepEqual(expect.factsKept(before, await H.facts({ data: path.win32.join(target, 'data'), keys: path.win32.join(target, 'keys') })), [], 'the copy is the portable folder\'s, counted alike');
  const forget = await launch(['forget-keys', '--source', src, '--machine', target, '--sys', H.sys, '--id', answer.id]);
  assert.equal(forget.code, 0, scrub(forget.out + forget.err));
  const finish = await H.machineJs(['import', '--step', 'finish', '--for', ME.sid, '--machine', target, '--sys', H.sys, '--id', answer.id]);
  assert.equal(finish.code, 0, scrub(JSON.stringify(finish.said)));
  assert.equal(finish.said.imported, true);
  assert.ok(expect.eventsOf(fs.readFileSync(path.win32.join(target, 'machine', 'events.jsonl'), 'utf8')).some((e) => e.kind === 'machine.import' && e.for.sid === ME.sid), 'machine.import names the account');
  assert.ok(!exists(profile), 'the profile\'s copies of the keys are gone');
  assert.ok(!exists(path.win32.join(src, 'app', 'data', 'secret.key')), 'the folder\'s secret is gone');
  assert.ok(exists(path.win32.join(src, 'app', 'data', 'moved.json')) && exists(path.win32.join(src, 'start-agmessage.bat.moved')), 'the folder is marked as moved');
  assert.ok(!exists(path.win32.join(target, 'machine', 'inbox', ME.sid, 'import')), 'nothing of the bundle is left in the inbox');
  // Off the installed node's port, on one of its own: what ends it is the mark, never a port another program holds.
  const w = H.portable(src, { port: await freePort() });
  const code = await Promise.race([w.exited, sleep(60000).then(() => 'still running')]);
  if (code === 'still running') await H.portableStop(w);
  assert.equal(code, 3, scrub(w.tail().slice(-1500)));
  assert.match(w.tail(), WORDS.moved, scrub(w.tail().slice(-1500)));
});

test('nothing is written in the install folder while AGMessage runs', { timeout: 5 * 60_000 }, () => {
  const d = expect.snapshotDiff(S.laid, H.tree(H.app));
  assert.deepEqual(d, { added: [], changed: [], removed: [] }, 'since the upgrade laid its files, through its starts, stops, consoles, control tasks and the import');
});

// ---------------------------------------------------------------- the way back

test('a file that cannot be replaced rolls the upgrade back, and the earlier server runs again', { timeout: 10 * 60_000 }, async () => {
  const before = H.record();
  const held = await H.hold(path.win32.join(H.app, 'README.txt'));
  let r;
  try { r = await H.install(B.broken.exe, ['/FORCE=the installer\'s life cycle holds a file'], 'upgrade-file-held'); } finally { await held.release(); }
  assert.notEqual(r.code, 0, said(r));
  assert.ok(machineSaid(r, 'upgrade-stop').some((m) => m.code === 0), 'the earlier server was stopped for the upgrade: ' + said(r));
  assert.ok(r.said.says(WORDS.startedAgain()), said(r));
  assert.ok(!r.said.says(WORDS.wayBack()), 'Inno Setup rolled its files back before anything of the new build was set up: ' + said(r));
  assert.deepEqual(H.record(), before, 'the record is as it was');
  await serving(B.current, 'the earlier server, started again');
  payloadIs(B.current);
});

test('a new build that will not start is replaced by the build before it, which answers', { timeout: 12 * 60_000 }, async () => {
  const before = { record: H.record(), facts: await H.facts() };
  const r = await H.install(B.broken.exe, ['/FORCE=the installer\'s life cycle installs a build that does not start'], 'upgrade-broken');
  assert.equal(r.code, 3, 'the installer says it did not install its build: ' + said(r));
  assert.ok(r.said.says(WORDS.wayBack()) && r.said.says(WORDS.keptEnded(B.current)), said(r));
  assert.ok(r.said.says(WORDS.restartsEachHall), 'the restore says each room is told AGMessage restarted: ' + said(r));
  const rec = H.record();
  assert.deepEqual([rec.Version, rec.SemVer, rec.Previous, rec.Admin], [B.current.installVersion, B.current.semver, '', before.record.Admin], 'the record names the build gone back to, and no build before it');
  await serving(B.current, 'the build gone back to');
  // As the restore says: its data as the upgrade's stop left it, and one "AGMessage restarted" line in each room.
  assert.deepEqual(expect.factsKept(before.facts, await H.facts(), { restarted: before.facts.halls + before.facts.rooms }), [], 'its data laid back as it was');
  payloadIs(B.current);
  note('A build that does not start (' + B.broken.full + '): gone back to ' + B.current.full + ' by itself in ' + Math.round(r.ms / 1000) + ' s.');
});

test('the watchdog\'s give-up leaves the server task stopped', { timeout: 10 * 60_000 }, async () => {
  await stopInstalled('the installer\'s life cycle makes the watchdog give up');
  const server = path.win32.join(H.app, 'app', 'server.js');
  const original = fs.readFileSync(server);
  const record = path.win32.join(H.root, 'data', 'watchdog.json');
  const t0 = Date.now();
  try {
    fs.writeFileSync(server, BROKEN_SERVER);
    assert.equal(H.run(H.exe('schtasks.exe'), ['/Run', '/TN', SERVER_TASK]).code, 0, 'the server task runs');
    const gave = await until(() => { try { const j = JSON.parse(fs.readFileSync(record, 'utf8')); return j.at >= t0 && !j.refused ? j : null; } catch { return null; } }, 5 * 60_000, 1000);
    assert.ok(gave, 'the watchdog gave up and said so in data\\watchdog.json');
    assert.match(fs.readFileSync(path.win32.join(H.root, 'data', 'watchdog.log'), 'utf8'), WORDS.gaveUp);
    const ended = await until(() => { const s = H.task(SERVER_TASK); return s.state !== 'Running' ? s : null; }, 60000, 1000);
    assert.ok(ended && ended.lastResult === 0, 'the task ended with 0: ' + JSON.stringify(H.task(SERVER_TASK)));
    // Past RestartOnFailure's minute: a task that ended with 0 is never started again.
    await sleep(75000);
    const still = H.task(SERVER_TASK);
    assert.ok(still.state !== 'Running' && still.lastResult === 0, 'it stays stopped: ' + JSON.stringify(still));
    assert.equal(await H.answers(), false, 'nothing answers on the port');
  } finally { fs.writeFileSync(server, original); }
  assert.ok(fs.readFileSync(server).equals(original), 'server.js is the payload\'s again');
  await startInstalled(B.current);
});

// ---------------------------------------------------------------- the uninstall

test('the uninstall keeps the data, and removes the tasks, the rules and the record, taking back every account\'s right', { timeout: 10 * 60_000 }, async () => {
  S.kept = await H.facts();
  const r = await H.uninstall(['/FORCE=the installer\'s life cycle uninstalls AGMessage'], 'uninstall-keep');
  assert.ok(r.gone, 'uninstalled: ' + said(r));
  const rec = H.record() || {};
  assert.deepEqual(Object.keys(rec).sort(), ['Kept', 'Port'], 'the record keeps only the mark an install again takes the data by: ' + JSON.stringify(rec));
  assert.ok(ci(rec.Kept, H.root) && rec.Port === String(PORT), JSON.stringify(rec));
  assert.deepEqual(H.agmTasks(), [], 'no task in \\AGMessage\\');
  assert.deepEqual(H.rules(), { [machine.RULE_TCP]: false, [machine.RULE_UDP]: false }, 'no firewall rule');
  assert.ok(!exists(H.app) && !exists(H.menu), 'the install folder and the Start menu folder are gone');
  // The install folder is gone, so the data is read by the payload's own reader, this build's.
  assert.deepEqual(expect.factsKept(S.kept, await H.facts({ app: PLAN.portable })), [], 'the data kept as it was');
  for (const name of machine.CHILDREN.map((c) => c.name)) {
    const aces = daclOf(H.sddl(path.win32.join(H.root, name)));
    assert.ok(!aces.some((a) => a.sid === ME.sid || a.sid === S.std.sid), name + ': no account keeps a right');
  }
  const stop = JSON.parse(fs.readFileSync(path.win32.join(H.root, 'data', 'last-stop.json'), 'utf8'));
  assert.deepEqual([stop.saved, stop.build], [true, B.current.full], 'the uninstall\'s stop saved');
});

// The record's mark (Kept) lets prepare take a root that is there, so its next two checks are reached only here: the
// root must be a real directory, and SYSTEM's or Administrators'. Each is tried, then the kept root put back as it was.

test('the kept machine folder set aside and a junction made in its place is refused at the next install, and nothing is laid where it points', { timeout: 5 * 60_000 }, async () => {
  const before = H.record();
  const kept = path.win32.join(PLAN.work, 'kept-aside');
  const target = path.win32.join(PLAN.work, 'kept-junction');
  fs.mkdirSync(target, { recursive: true });
  await H.move(H.root, kept);
  try {
    H.junction(H.root, target);
    try {
      const r = await H.install(B.current.exe, ['/ADMIN=' + ADMIN], 'kept-junction');
      assert.notEqual(r.code, 0, said(r));
      assert.ok(machineSaid(r, 'prepare').some((m) => m.code === 3 && m.words === WORDS.notReal(H.root)), said(r));
      assert.ok(r.said.refused.includes(WORDS.notReal(H.root)), said(r));
      assert.deepEqual(fs.readdirSync(target), [], 'nothing laid where the junction points');
      assert.deepEqual(H.record(), before, 'the record still keeps the data');
      assert.ok(!exists(H.app), H.app + ' was not made');
    } finally { fs.unlinkSync(H.root); }
  } finally { await H.move(kept, H.root); }
  assert.deepEqual(expect.factsKept(S.kept, await H.facts({ app: PLAN.portable })), [], 'the kept data, put back, as it was');
});

test('the kept machine folder given to another account is refused at the next install, and is left as it was', { timeout: 5 * 60_000 }, async () => {
  const before = H.record();
  const owner = machine.ownerSidOf(H.sddl(H.root));
  assert.ok([machine.SID.system, machine.SID.admins].includes(owner), 'the kept root is SYSTEM\'s or Administrators\': ' + owner);
  H.setOwner(H.root, S.std.sid);
  try {
    const r = await H.install(B.current.exe, ['/ADMIN=' + ADMIN], 'kept-another-owner');
    assert.notEqual(r.code, 0, said(r));
    const words = WORDS.ownedBy(H.root, S.std.sid);
    assert.ok(machineSaid(r, 'prepare').some((m) => m.code === 3 && m.words === words), said(r));
    assert.ok(r.said.refused.includes(words), said(r));
    assert.equal(machine.ownerSidOf(H.sddl(H.root)), S.std.sid, 'its owner is still the account it was given to');
    assert.deepEqual(H.record(), before, 'the record still keeps the data');
    assert.ok(!exists(H.app), H.app + ' was not made');
  } finally { H.setOwner(H.root, owner); }
  assert.equal(machine.ownerSidOf(H.sddl(H.root)), owner, 'its owner given back');
});

test('installed again, AGMessage takes the kept data: its halls, messages and accounts as they were', { timeout: 8 * 60_000 }, async () => {
  const r = await H.install(B.current.exe, ['/ADMIN=' + ADMIN], 'install-again');
  assert.equal(r.code, 0, said(r));
  const rec = H.record();
  assert.deepEqual([rec.Version, rec.Admin, rec.Kept], [B.current.installVersion, ME.sid, undefined]);
  await serving(B.current, 'installed again');
  assert.deepEqual(expect.factsKept(S.kept, await H.facts()), [], 'the kept data, taken');
  payloadIs(B.current);
});

test('the uninstall with /REMOVEDATA removes the data, the keys last, with the tasks, the rules and the record', { timeout: 10 * 60_000 }, async () => {
  const r = await H.uninstall(['/REMOVEDATA', '/FORCE=the installer\'s life cycle removes AGMessage'], 'uninstall-remove-data');
  assert.ok(r.gone, 'uninstalled: ' + said(r));
  assert.equal(H.record(), null, 'no record at all');
  assert.ok(!exists(H.root), H.root + ' is removed');
  assert.ok(!exists(H.app) && !exists(H.menu), 'the install folder and the Start menu folder are gone');
  assert.deepEqual(H.agmTasks(), [], 'no task in \\AGMessage\\');
  assert.deepEqual(H.rules(), { [machine.RULE_TCP]: false, [machine.RULE_UDP]: false }, 'no firewall rule');
  assert.equal(await H.answers(), false, 'nothing answers on the port');
});

test('the installer\'s logs hold no token and no password', { timeout: 2 * 60_000 }, () => {
  const logs = fs.readdirSync(PLAN.logs).filter((n) => n.endsWith('.log'));
  assert.ok(logs.length >= 15, 'every run kept its log: ' + logs.join(', '));
  assert.ok(H.tokens.size >= 2 && H.passwords.size >= 2, 'tokens and passwords to look for');
  for (const n of logs) assert.deepEqual(expect.secretsIn(H.logOf(path.join(PLAN.logs, n)), secrets()), [], n);
});
