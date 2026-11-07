'use strict';
// The checked upgrade, and Go back to build N (the 0.6.0 plan's Part 6, unit U18): an upgrade the laptop's admin or an
// account given `upgrade` starts needs no administrator, the installer checked against its release on GitHub. Held here
// on every platform, Windows' hands and GitHub's answers stood in for (the release's answer is a fixture in GitHub's own
// shape, test/fixtures/github-release.json): the request's shape, the release judged, the staged copy and its digest,
// newer only, the busy check, the run handed to a runner that waits for the console that asked, the installer run from
// machine\staged\ with /UPGRADEBY, the way back, each outcome one machine event, and launch.js's side. What only a Windows
// run proves (SYSTEM running the control task and its runner, Inno taking /UPGRADEBY, GitHub's answer from the show
// laptop, a runner outliving its control task) is the Windows readings lane's (R11, R13) and the installer's life cycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const launch = require('../launch');
const version = require('../lib/version');
const upgradebackup = require('../lib/upgradebackup');
const tlsmod = require('../lib/tls');

const SYS = 'C:\\Windows\\System32';
const ANA = 'S-1-5-21-1-2-3-1001';
const BEN = 'S-1-5-21-1-2-3-1002';
const CAL = 'S-1-5-21-1-2-3-1003';
const NAMES = { [ANA]: 'LAPTOP\\ana', [BEN]: 'LAPTOP\\ben', [CAL]: 'LAPTOP\\cal' };
const SYSTEM_ROW = '"nt authority\\system","S-1-5-18"';
const ELEVATED = ['"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group"', '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""'].join('\r\n');
const REPO = 'jammin808/AGMessage';
const NAME = 'AGMessage-Setup-0.6.1-unsigned.exe';
/** GitHub's answer for the release v0.6.1 of jammin808/AGMessage, as its REST API gives one (the fixture's README says how). */
const RELEASE = JSON.parse(h.readSource('app/test/fixtures/github-release.json'));
/** The stand-in installer whose SHA-256 the fixture's asset gives as its digest. */
const INSTALLER = Buffer.from('AGMessage 0.6.1 stand-in installer\n'.repeat(4096));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SUM = sha256(INSTALLER);
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const base = (exe) => path.win32.basename(exe);
const fail = (status, err = 'ERROR: refused') => Object.assign(new Error(err), { status, stdout: '', stderr: err });
/** The fixture changed: a copy of it, given to `change` (pure). */
const release = (change = () => {}) => { const r = JSON.parse(JSON.stringify(RELEASE)); change(r); return r; };
const asset = (r) => r.assets.find((a) => a.name === NAME);

/** A task's action as its definition names it: {cmd, args, cwd}, each argument as Windows reads it back (pure). */
const TAGS = Object.freeze({ Command: /<Command>([^<]*)<\/Command>/, Arguments: /<Arguments>([^<]*)<\/Arguments>/, WorkingDirectory: /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/ });
function actionOf(xml) {
  const tag = (t) => ((TAGS[t].exec(xml) || [])[1] || '').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const args = [...tag('Arguments').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] === undefined ? m[2] : m[1].replace(/\\(["\\])/g, '$1')));
  return { cmd: tag('Command'), args, cwd: tag('WorkingDirectory') };
}
/**
 * Windows stood in for: the install record and its Grants (reg.exe), whoami's answers, schtasks (a runner's task made
 * from its definition, run, queried and deleted: `tasks` those registered, `handed` those run, each {tn, xml, cmd, args,
 * cwd}; any other /Run kept in `runs`; `failTask` 'create' or 'run' refuses that step), the names Windows gives SIDs
 * (PS_WHOSE) and the programs running from a folder (PS_PROGRAMS: `programs(folder)` each time asked).
 */
function fakeWindows({ record, grants = {}, me = SYSTEM_ROW, groups = '', programs = () => [], failTask = '' } = {}) {
  const st = { record: { ...record }, grants: { ...grants }, runs: [], asked: [], tasks: new Map(), handed: [], deleted: [] };
  st.run = (exe, args, opts) => {
    const name = base(exe);
    st.asked.push(name);
    if (name === 'whoami.exe') return args[0] === '/user' ? me : groups;
    if (name === 'reg.exe') {
      if (args[0] === 'query' && args[1] === machine.HKLM) return Object.entries(st.record).map(([k, v]) => '    ' + k + '    ' + (k === 'Port' ? 'REG_DWORD    0x' + Number(v).toString(16) : 'REG_SZ    ' + v)).join('\r\n');
      if (args[0] === 'query' && args[1] === machine.HKLM + '\\Grants') {
        if (!Object.keys(st.grants).length) throw fail(1);
        return Object.entries(st.grants).map(([sid, r]) => '    ' + sid + '    REG_SZ    ' + r).join('\r\n');
      }
    }
    if (name === 'schtasks.exe') {
      const tn = args[args.indexOf('/TN') + 1];
      if (args[0] === '/Create') {
        if (failTask === 'create') throw fail(1, 'ERROR: Access is denied.');
        const xml = fs.readFileSync(args[args.indexOf('/XML') + 1]).subarray(2).toString('utf16le');
        st.tasks.set(tn, { tn, xml, ...actionOf(xml) });
        return 'SUCCESS';
      }
      if (args[0] === '/Run') {
        if (!st.tasks.has(tn)) { st.runs.push(tn); return 'SUCCESS'; }
        if (failTask === 'run') throw fail(1, 'ERROR: The task could not be run.');
        st.handed.push(st.tasks.get(tn));
        return 'SUCCESS';
      }
      if (args[0] === '/Query') { if (st.tasks.has(tn)) return '"' + tn + '","N/A","Ready"'; throw fail(1); }
      if (args[0] === '/Delete') { st.tasks.delete(tn); st.deleted.push(tn); return 'SUCCESS'; }
    }
    if (name === 'powershell.exe' && args[args.length - 1] === machine.PS_WHOSE) {
      const names = {};
      for (const sid of String(opts.env.AGM_SIDS || '').split(',').filter(Boolean)) names[sid] = NAMES[sid] || '';
      return JSON.stringify({ names }) + '\r\n';
    }
    if (name === 'powershell.exe' && args[args.length - 1] === machine.PS_PROGRAMS) return JSON.stringify({ programs: programs(opts.env.AGM_APP) }) + '\r\n';
    throw new Error('the stand-in was asked what it does not know: ' + name + ' ' + args.join(' '));
  };
  return st;
}

/**
 * An installed node on this disk: the machine folder (its token, an account's inbox\ and outbox\, work\ and staged\) and
 * the install folder {app} (its app\build.json naming its repository, its installers\), with the record that names them.
 */
function installed({ sids = [ANA, BEN], repo = REPO, semver = '0.6.0', ver = '0.6.41', previous = '' } = {}) {
  const top = tmp('agm-upg-');
  const root = path.join(top, 'ProgramData', 'AGMessage');
  const app = path.join(top, 'Program Files', 'AGMessage');
  for (const sub of ['work', 'inbox', 'outbox', 'staged']) fs.mkdirSync(path.join(root, 'machine', sub), { recursive: true });
  for (const name of ['data', 'uploads', 'token', 'logs']) fs.mkdirSync(path.join(root, name));
  for (const sid of sids) for (const box of ['inbox', 'outbox']) fs.mkdirSync(path.join(root, 'machine', box, sid));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  fs.mkdirSync(path.join(app, 'app'), { recursive: true });
  fs.mkdirSync(path.join(app, 'installers'));
  fs.writeFileSync(path.join(app, 'app', 'build.json'), JSON.stringify({ version: semver, build: 41, installVersion: ver, commit: 'abc1234', channel: 'release', ...(repo ? { repo } : {}) }));
  const record = { InstallDir: app, Version: ver, SemVer: semver, Previous: previous, Port: '3023', Admin: ANA, AdminName: 'LAPTOP\\ana' };
  return { top, root, app, record };
}
const inbox = (root, sid, name = 'request.json') => path.join(root, 'machine', 'inbox', sid, name);
const answerOf = (root, sid) => JSON.parse(read(path.join(root, 'machine', 'outbox', sid, 'answer.json')));
const eventsOf = (root) => { try { return read(path.join(root, 'machine', 'events.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let ids = 0;
const nextId = () => (++ids).toString(16).padStart(24, '0');
function ask(root, sid, request) {
  const id = nextId();
  fs.writeFileSync(inbox(root, sid), JSON.stringify({ id, ...request }));
  return id;
}
/** GitHub stood in for: its answer by the API path asked (a 404 for any other), each path kept. */
function github(answers) {
  const fn = async (p) => { fn.asked.push(p); const a = answers[p]; return typeof a === 'function' ? a() : a || { status: 404, json: null, headers: {} }; };
  fn.asked = [];
  return fn;
}
const ok = (json) => ({ status: 200, json, headers: {} });
const TAG = '/repos/' + REPO + '/releases/tags/v0.6.1';
const LATEST = '/repos/' + REPO + '/releases/latest';
/**
 * The control task's stand-ins: GitHub, the busy line, the nudge, and the runner's programs (its node.exe a small file of
 * the test's; an elevated console's spawn kept: `spawned`; a control task's runner is a task, in its Windows stand-in's
 * `handed`).
 */
function hands({ gh = github({ [TAG]: ok(release()), [LATEST]: ok(release()) }), busy = { answered: true, running: true, busy: false, words: 'quiet' }, download } = {}) {
  const spawned = [];
  const fakeNode = path.join(tmp('agm-node-'), 'node');
  fs.writeFileSync(fakeNode, 'a stand-in for node.exe');
  const net = {
    github: gh,
    busy: async () => busy,
    nudge: async () => ({ ok: true, status: 200, json: { written: 1 } }),
    runner: { execPath: fakeNode, script: path.join(h.ROOT, 'machine.js'), spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: 4242, unref() {}, on() {} }; } },
    ...(download ? { download } : {}),
  };
  return { net, spawned };
}
const control = (root, sid, win, net) => machine.run(['control', '--for', sid, '--machine', root, '--sys', SYS], { run: win.run, net });
/** The plan file a runner was handed (a task run, or an elevated console's spawn), and the plan read from it. */
const planFileOf = (handed) => handed.args[handed.args.indexOf('--plan') + 1];
const planOf = (handed) => JSON.parse(read(planFileOf(handed)));
/** The runner run as its task runs it: `win` its Windows, `net` its stand-ins. */
const runner = (handed, win, net) => machine.run(['upgrade', '--step', 'run', '--plan', planFileOf(handed), '--sys', SYS], { run: win.run, net: { pollMs: 5, nudge: async () => null, ...net } });

// ---------------------------------------------------------------- the request, and the release judged (pure)

test('an upgrade request names one way (a look, a release, or an installer\'s name in the inbox) and a back names its build: anything else is refused, never defaulted', () => {
  const id = 'a'.repeat(24);
  const of = (j) => machine.requestOf(Buffer.from(JSON.stringify({ id, ...j })));
  assert.deepEqual(of({ verb: 'upgrade', look: true }), { request: { id, verb: 'upgrade', look: true } });
  assert.deepEqual(of({ verb: 'upgrade', release: '0.6.1' }), { request: { id, verb: 'upgrade', release: '0.6.1', force: '' } });
  assert.deepEqual(of({ verb: 'upgrade', file: NAME, force: ' doors open ' }), { request: { id, verb: 'upgrade', file: NAME, force: 'doors open' } });
  assert.deepEqual(of({ verb: 'back', to: '0.6.41' }), { request: { id, verb: 'back', to: '0.6.41', force: '' } });
  for (const [j, re] of [
    [{ verb: 'upgrade' }, /names one of look, release and file/],
    [{ verb: 'upgrade', look: true, release: '0.6.1' }, /names one of look, release and file/],
    [{ verb: 'upgrade', look: 'yes' }, /look is true/],
    [{ verb: 'upgrade', look: true, force: 'x' }, /look is true, and asks nothing more/],
    [{ verb: 'upgrade', release: 'v0.6.1' }, /release is its version, MAJOR\.MINOR\.PATCH/],
    [{ verb: 'upgrade', release: '0.6.1-dev.4' }, /release is its version/],
    [{ verb: 'upgrade', file: '..\\' + NAME }, /an installer's name in your inbox/, 'a name, never a path'],
    [{ verb: 'upgrade', file: 'AGMessage-Setup-0.6.41-unsigned.EXE' }, /an installer's name/],
    [{ verb: 'upgrade', file: 'setup.exe' }, /an installer's name/],
    [{ verb: 'upgrade', release: '0.6.1', force: 3 }, /force is the reason you typed/],
    [{ verb: 'upgrade', release: '0.6.1', to: '0.6.41' }, /"to" is not one of them/],
    [{ verb: 'back' }, /names the build it goes back to/],
    [{ verb: 'back', to: '0.6.0' }, /names the build it goes back to/, 'an install version\'s BUILD is from 1'],
    [{ verb: 'back', to: '0.6.41', file: NAME }, /"file" is not one of them/],
  ]) { const r = of(j); assert.match(r.problem || '', re, JSON.stringify(j)); assert.equal(r.request, undefined); }
});

test('GitHub\'s answer judged: an immutable release of this repository holding one asset of the installer\'s exact name, uploaded whole, with its digest; each other answer refused with its reason', () => {
  const judge = (r, semver = '0.6.1') => machine.releaseJudged(r, { repo: REPO, semver, name: machine.installerName(semver) });
  assert.deepEqual(judge(release()), { asset: { name: NAME, size: INSTALLER.length, digest: SUM, id: 310007702, url: 'https://api.github.com/repos/jammin808/AGMessage/releases/assets/310007702' } });
  assert.ok(judge(release(), '0.6.1').asset, 'the fixture is the release its own judge takes');
  assert.ok(machine.releaseJudged(release(), { repo: 'JAMMIN808/agmessage', semver: '0.6.1', name: NAME }).asset, 'GitHub\'s owners and names are not case-sensitive');
  const cases = [
    ['repository', (r) => { r.html_url = 'https://github.com/someone/AGMessage/releases/tag/v0.6.1'; }, /is not a release of jammin808\/AGMessage, the repository this AGMessage was built from/],
    ['repository', (r) => { r.url = 'https://api.github.com/repos/someone/AGMessage/releases/1'; }, /is not a release of jammin808\/AGMessage/],
    ['repository', (r) => { r.tag_name = 'v0.6.2'; }, /is not a release of jammin808\/AGMessage/],
    ['repository', (r) => { r.draft = true; }, /is a draft, not a published release/],
    ['immutable', (r) => { r.immutable = false; }, /^The release v0\.6\.1 of jammin808\/AGMessage is not immutable, so its files could still be replaced: .*Run it yourself: Windows will ask for an administrator's approval\.$/],
    ['immutable', (r) => { delete r.immutable; }, /is not immutable/, 'an answer without the field is no immutable release'],
    ['asset', (r) => { asset(r).name = 'AGMessage-Setup-0.6.1-signed.exe'; }, /holds no file named AGMessage-Setup-0\.6\.1-unsigned\.exe, so this installer is not its/],
    ['asset', (r) => { r.assets.push({ ...asset(r) }); }, /holds more than one file named/],
    ['digest', (r) => { delete asset(r).digest; }, /gives no SHA-256 digest for AGMessage-Setup-0\.6\.1-unsigned\.exe/],
    ['digest', (r) => { asset(r).digest = 'sha512:' + SUM; }, /gives no SHA-256 digest/],
    ['repository', (r) => { asset(r).browser_download_url = 'https://github.com/someone/AGMessage/releases/download/v0.6.1/' + NAME; }, /is not one of jammin808\/AGMessage's release files/],
    ['repository', (r) => { asset(r).url = 'https://uploads.example/assets/1'; }, /is not one of jammin808\/AGMessage's release files/],
    ['asset', (r) => { asset(r).state = 'starter'; }, /is not a whole file of an installer's size \(starter/],
    ['asset', (r) => { asset(r).size = machine.INSTALLER_MAX + 1; }, /is not a whole file of an installer's size/],
  ];
  for (const [why, change, re] of cases) {
    const j = judge(release(change));
    assert.equal(j.asset, undefined, String(change));
    assert.equal(j.why, why, String(change));
    assert.match(j.words, re, String(change));
  }
  assert.equal(judge(null).why, 'repository');
  // GitHub's answer when there is no release to judge: no network, none of that name, a repository moved, a rate limit.
  const words = (r) => machine.githubWords(r, { repo: REPO, asked: 'release v0.6.1' });
  assert.deepEqual(words({ error: 'ENOTFOUND' }), { why: 'offline', words: 'AGMessage could not check this installer against its release (no internet). Run it yourself: Windows will ask for an administrator\'s approval.' });
  assert.equal(words(null).why, 'offline');
  assert.match(words({ status: 404 }).words, /^jammin808\/AGMessage has no release v0\.6\.1 on GitHub, so this installer is not one of its releases: it was not run\.$/);
  assert.deepEqual([words({ status: 301 }).why, words({ status: 200 }).why], ['repository', 'repository']);
  assert.match(words({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }).words, /^GitHub did not answer this check \(HTTP 403: its rate limit for this PC's address\)\. Try again later/);
  assert.equal(words({ status: 502, headers: {} }).why, 'github');
  // Newer only, by SemVer, the order lib/version.js keeps; and the rules machine.js carries of its own, held to theirs.
  const now = machine.installedOf({ SemVer: '0.6.1', Version: '0.6.52' });
  assert.deepEqual(now, { semver: '0.6.1', version: '0.6.52', build: '52' });
  assert.equal(machine.newerRefusal('0.6.2', now), '');
  assert.match(machine.newerRefusal('0.6.1', now), /^AGMessage 0\.6\.1 is the version this PC has already \(AGMessage 0\.6\.1 \(build 52\)\): an upgrade installs only a newer release\.$/);
  assert.match(machine.newerRefusal('0.5.9', now), /is older than this PC's AGMessage 0\.6\.1 \(build 52\).*Go back to build N/);
  assert.match(machine.newerRefusal('0.6.2', machine.installedOf({})), /The install record names no version/);
  for (const [a, b] of [['0.10.0', '0.9.9'], ['1.0.0', '1.0.0'], ['0.6.0', '0.6.1'], ['2.0.0', '10.0.0']]) assert.equal(machine.compareSemver(a, b), version.compareVersions(a, b), a + ' ' + b);
  assert.equal(String(machine.REPO), String(version.REPO), 'the repository\'s shape, lib/version.js\'s');
  assert.equal(String(launch.INSTALLER_NAME), String(machine.INSTALLER_NAME), 'the installer\'s name, one rule');
  assert.equal(String(launch.INSTALL_VERSION), String(machine.INSTALL_VERSION));
  assert.deepEqual([machine.installerSemver(NAME), machine.installerSemver('AGMessage-Setup-0.6.0-dev.41_abc1234-unsigned.exe'), machine.installerName('1.2.3')], ['0.6.1', '', 'AGMessage-Setup-1.2.3-unsigned.exe']);
  assert.deepEqual([machine.repoOf('{"repo":"jammin808/AGMessage"}'), machine.repoOf('{"repo":"x"}'), machine.repoOf('{}'), machine.repoOf('not json')], [REPO, '', '', '']);
  assert.deepEqual(machine.installerArgs({ sid: BEN, force: 'the "show" ended', log: 'C:\\ProgramData\\AGMessage\\machine\\work\\upgrade-0123456789abcdef\\upgrade.log' }), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPGRADEBY=' + BEN, '/FORCE=the \'show\' ended', '/LOG=C:\\ProgramData\\AGMessage\\machine\\work\\upgrade-0123456789abcdef\\upgrade.log']);
  assert.deepEqual(machine.installerArgs({ rollback: true }), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/ROLLBACK'], 'an administrator\'s run names no account');
  assert.deepEqual([0, 1, 3, 7, -1, 9].map(machine.exitWords), ['it installed and its build answers', 'it refused before it replaced a file', 'the build it laid down did not start', 'it refused before it replaced a file', 'it could not be run', 'it did not finish'], 'what the installer itself did, and never what the runner did before it nor which build its way back left');
  const backups = [{ name: 'a', build: '0.6.0+41.abc1234', stopAt: 10 }, { name: 'b', build: '0.6.0+41.abc1234', stopAt: 30 }, { name: 'c', build: '0.6.1+52.def5678', stopAt: 50 }, { name: 'd', build: 'nonsense', stopAt: 60 }];
  assert.equal(machine.backupFor(backups, '0.6.41').name, 'b', 'the newest backup the upgrade from that build made');
  assert.equal(machine.backupFor(backups, '0.6.40'), null);
});

test('a runner\'s plan names only what its control task put where it puts it: an upgrade\'s installer by its release\'s name in one folder of its own machine\\staged\\, a go back\'s the kept installer of its build, nothing staged', () => {
  const root = 'C:\\ProgramData\\AGMessage';
  const app = 'C:\\Program Files\\AGMessage';
  const staged = root + '\\machine\\staged\\0123456789abcdef';
  const base = { v: 1, id: 'fedcba9876543210', request: 'a'.repeat(24), at: 1, for: BEN, by: { sid: BEN, name: 'LAPTOP\\ben' }, elevated: false, root, app, port: 3023, from: { semver: '0.6.0', version: '0.6.41', build: '41' }, force: '' };
  const up = { ...base, kind: 'upgrade', repo: REPO, to: '0.6.1', digest: SUM, staged, installer: staged + '\\' + NAME };
  const back = { ...base, kind: 'back', to: '0.6.41', backup: 'upgrade-0.6.0+41.abc1234-20261107T203100Z-abc123', backupAt: 1, staged: '', installer: app + '\\installers\\AGMessage-Setup-0.6.41-unsigned.exe' };
  const reads = (p) => !!machine.planOf(JSON.stringify(p));
  assert.ok(reads(up) && reads(back));
  assert.ok(reads({ ...up, installer: up.installer.toUpperCase().replace('AGMESSAGE-SETUP-0.6.1-UNSIGNED.EXE', NAME) }), 'Windows\' paths, letter case aside');
  for (const [what, p] of [
    ['an installer outside its staged folder', { ...up, installer: root + '\\machine\\work\\' + NAME }],
    ['another name', { ...up, installer: staged + '\\setup.exe' }],
    ['another release\'s name', { ...up, installer: staged + '\\AGMessage-Setup-0.6.2-unsigned.exe' }],
    ['a staged folder outside machine\\staged', { ...up, staged: root + '\\data\\0123456789abcdef', installer: root + '\\data\\0123456789abcdef\\' + NAME }],
    ['machine\\staged itself', { ...up, staged: root + '\\machine\\staged', installer: root + '\\machine\\staged\\' + NAME }],
    ['another machine folder\'s', { ...up, staged: 'D:\\x\\machine\\staged\\0123456789abcdef', installer: 'D:\\x\\machine\\staged\\0123456789abcdef\\' + NAME }],
    ['no repository', { ...up, repo: 7 }],
    ['a go back\'s installer elsewhere', { ...back, installer: root + '\\machine\\staged\\0123456789abcdef\\AGMessage-Setup-0.6.41-unsigned.exe' }],
    ['another build\'s kept installer', { ...back, installer: app + '\\installers\\AGMessage-Setup-0.6.40-unsigned.exe' }],
    ['a go back with something staged', { ...back, staged }],
    ['a go back with no backup time', { ...back, backupAt: 'soon' }],
    ['no build it comes from', { ...up, from: null }],
  ]) assert.equal(machine.planOf(JSON.stringify(p)), null, what);
});

// ---------------------------------------------------------------- a named installer, checked and handed to the runner

test('a named installer: staged by its bytes in machine\\staged\\, its release immutable and its asset\'s digest the staged copy\'s, newer: the run handed to a runner task of its own from a copy beside its plan; a file changed in the inbox after it was staged changes nothing that runs; the one event is the outcome\'s', async () => {
  const n = installed();
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  const { net, spawned } = hands();
  fs.writeFileSync(inbox(n.root, BEN, NAME), INSTALLER);
  const id = ask(n.root, BEN, { verb: 'upgrade', file: NAME });
  // The person writes another file under that name once AGMessage has staged theirs: the inbox's file is removed after
  // the copy, and what is written there after it is not what runs.
  const swapped = Buffer.from('a file written into the inbox after the copy\n');
  const fsImpl = { ...fs, unlinkSync: (f, ...a) => { const r = fs.unlinkSync(f, ...a); if (f === inbox(n.root, BEN, NAME)) fs.writeFileSync(f, swapped); return r; } };
  const r = await machine.run(['control', '--for', BEN, '--machine', n.root, '--sys', SYS], { run: win.run, net, fsImpl });
  assert.equal(r.code, 0, r.text);
  const a = answerOf(n.root, BEN);
  assert.deepEqual([a.id, a.verb, a.code, a.pending, a.release], [id, 'upgrade', 0, true, { semver: '0.6.1', name: NAME, size: INSTALLER.length, digest: 'sha256:' + SUM }]);
  assert.match(a.words, /^Checked: AGMessage-Setup-0\.6\.1-unsigned\.exe is jammin808\/AGMessage's release v0\.6\.1 \(immutable; SHA-256 [0-9a-f]{64}\), newer than this PC's AGMessage 0\.6\.0 \(build 41\)\. .* It begins once this window has closed \(press Enter\)/);
  assert.deepEqual(net.github.asked, [TAG], 'the release asked by the version the file\'s name carries');
  // The runner: a copy of node.exe and machine.js in a folder of machine\work\, run once as a task of its own as SYSTEM
  // (its own job: the control task that made it ends while it runs), never a child of the control task.
  assert.deepEqual([spawned.length, win.handed.length], [0, 1]);
  const s = win.handed[0];
  const dir = path.dirname(s.cmd);
  assert.match(path.basename(dir), machine.RUNNER_DIR);
  assert.equal(s.tn, machine.runnerTask(machine.RUNNER_DIR.exec(path.basename(dir))[1]));
  assert.equal(a.runner, s.tn);
  assert.equal(path.dirname(dir), path.join(n.root, 'machine', 'work'));
  assert.deepEqual([path.basename(s.cmd), s.args.slice(1, 4), s.args.slice(-2), s.cwd], ['node.exe', ['upgrade', '--step', 'run'], ['--sys', SYS], dir]);
  assert.equal(s.args[0], path.join(dir, 'machine.js'));
  assert.ok(fs.readFileSync(s.args[0]).equals(fs.readFileSync(path.join(h.ROOT, 'machine.js'))), 'machine.js\'s own copy, byte for byte');
  assert.equal(s.xml, machine.runnerTaskXml({ node: s.cmd, args: s.args, cwd: dir, uri: s.tn }), 'registered from its definition');
  for (const part of ['<UserId>S-1-5-18</UserId>', '<Triggers />', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<SecurityDescriptor>' + machine.SERVER_TASK_SDDL + '</SecurityDescriptor>']) assert.ok(s.xml.includes(part), part);
  assert.ok(!/token|password/i.test(s.xml), 'no token or password in its definition');
  assert.ok(!fs.existsSync(path.join(dir, 'task.xml')), 'the definition\'s file removed once registered');
  assert.ok(!fs.existsSync(path.join(n.root, 'machine', 'work', 'upgrade.lock')), 'the check\'s lock given back at the hand-off');
  const plan = planOf(s);
  assert.deepEqual([plan.kind, plan.request, plan.for, plan.by, plan.to, plan.digest, plan.repo, plan.from.semver, plan.app, plan.port], ['upgrade', id, BEN, { sid: BEN, name: 'LAPTOP\\ben' }, '0.6.1', SUM, REPO, '0.6.0', n.app, 3023]);
  assert.equal(path.dirname(path.dirname(plan.installer)), path.join(n.root, 'machine', 'staged'), 'only the staged copy is run');
  assert.equal(path.basename(plan.installer), NAME);
  assert.equal(sha256(fs.readFileSync(plan.installer)), SUM, 'the staged copy is the file the person named, as it was staged');
  assert.deepEqual(fs.readFileSync(inbox(n.root, BEN, NAME)), swapped, 'what was written into the inbox since is still there, and not what runs');
  assert.ok(machine.planOf(read(planFileOf(s))), 'the plan is one the runner reads');
  assert.deepEqual(eventsOf(n.root), [], 'no event until the outcome is seen');
  // The runner, as SYSTEM: it waits for the console that asked to close, reads the staged copy's digest again and runs
  // the staged installer with /UPGRADEBY, its log in its own folder; then, the record naming the new build, its one event.
  const consoles = [[{ pid: 5000, name: 'node.exe', cmd: '"' + n.app + '\\node\\node.exe" "' + n.app + '\\app\\launch.js" upgrade', exe: n.app + '\\node\\node.exe' }], [{ pid: 5000, name: 'node.exe', cmd: 'launch.js upgrade', exe: n.app + '\\node\\node.exe' }], []];
  const rw = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' }, programs: () => consoles.shift() || [] });
  const ran = [];
  const runInstaller = async (file, args, opts) => {
    ran.push({ file, args, opts, bytes: sha256(fs.readFileSync(file)), events: eventsOf(n.root).length });
    Object.assign(rw.record, { Version: '0.6.52', SemVer: '0.6.1', Previous: '0.6.41' });
    return { code: 0 };
  };
  const done = await runner(s, rw, { runInstaller });
  assert.equal(done.code, 0, done.text);
  assert.equal(consoles.length, 0, 'it waited until the console had closed');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].file, plan.installer, 'the staged copy, in machine\\staged\\');
  assert.deepEqual(ran[0].args, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPGRADEBY=' + BEN, '/LOG=' + path.join(dir, 'upgrade.log')], 'its log in the runner\'s own folder, never one another account may place');
  assert.deepEqual([ran[0].bytes, ran[0].events], [SUM, 0], 'no event while it runs: an attempt is no outcome');
  const ev = eventsOf(n.root);
  assert.deepEqual(ev.map((e) => [e.kind, e.by.sid, e.for.sid, e.rights]), [['machine.upgrade', BEN, BEN, ['upgrade']]], 'one event, for the outcome');
  assert.match(ev[0].words, /^LAPTOP\\ben upgraded AGMessage from 0\.6\.0 \(build 41\) to 0\.6\.1 \(build 52\) as SYSTEM, its installer sha256:[0-9a-f]{64} \(jammin808\/AGMessage's release v0\.6\.1\)\.$/, 'who, the builds from and to as the records name them, and the digest');
  assert.ok(ev[0].words.includes(SUM));
  const fin = answerOf(n.root, BEN);
  assert.deepEqual([fin.id, fin.final, fin.code, fin.installerExit, fin.installed, fin.event], [id, true, 0, 0, { semver: '0.6.1', version: '0.6.52', build: '52' }, ev[0].seq]);
  assert.equal(fin.words, 'Upgraded: AGMessage 0.6.1 (build 52) is installed on this PC, and it answers.');
  assert.ok(fs.existsSync(path.join(dir, 'ended.json')), 'its end is written beside its plan');
  assert.ok(!fs.existsSync(path.dirname(plan.installer)), 'the staged copy removed once it has run');
});

test('a named installer refused, each with its words and one machine.upgrade.refused event, nothing run and nothing left staged: no network, another repository, not immutable, no asset of that name, a digest that differs, not newer, busy without a reason, a link, no repository named', async () => {
  const cases = [
    ['no network', { gh: github({ [TAG]: { error: 'ENOTFOUND' } }) }, (w) => w === machine.OFFLINE_WORDS],
    ['another repository', { gh: github({ [TAG]: ok(release((r) => { r.html_url = 'https://github.com/elsewhere/AGMessage/releases/tag/v0.6.1'; })) }) }, (w) => /is not a release of jammin808\/AGMessage/.test(w)],
    ['a release moved', { gh: github({ [TAG]: { status: 301, json: null, headers: { location: 'https://api.github.com/repositories/9' } } }) }, (w) => /from another place \(HTTP 301\)/.test(w)],
    ['not immutable', { gh: github({ [TAG]: ok(release((r) => { r.immutable = false; })) }) }, (w) => /is not immutable/.test(w)],
    ['no asset of that name', { gh: github({ [TAG]: ok(release((r) => { asset(r).name = 'AGMessage-Setup-0.6.1-other.exe'; })) }) }, (w) => /holds no file named AGMessage-Setup-0\.6\.1-unsigned\.exe/.test(w)],
    ['a digest that differs', { bytes: Buffer.concat([INSTALLER, Buffer.from('x')]) }, (w) => w === machine.NOT_THE_RELEASES],
    ['not newer', { semver: '0.6.1' }, (w) => /is the version this PC has already/.test(w)],
    ['busy without a reason', { busy: { answered: true, running: true, busy: true, words: '3 pages active, a countdown running', line: { active: 3 } } }, (w) => w === 'Not upgraded: AGMessage is busy (3 pages active, a countdown running). Type a reason to upgrade it anyway.'],
    ['a link', { link: true }, (w) => /reached AGMessage's control task as a link, which it never follows/.test(w)],
    ['no repository named', { repo: '' }, (w) => /names no repository it was released from/.test(w)],
  ];
  for (const [what, o, says] of cases) {
    const n = installed({ repo: o.repo === undefined ? REPO : o.repo, semver: o.semver || '0.6.0' });
    const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
    const { net } = hands({ ...(o.gh ? { gh: o.gh } : {}), ...(o.busy ? { busy: o.busy } : {}) });
    if (o.link) {
      const target = path.join(n.top, 'elsewhere.exe');
      fs.writeFileSync(target, INSTALLER);
      if (process.platform === 'win32') fs.symlinkSync(n.top, inbox(n.root, BEN, NAME), 'junction'); else fs.symlinkSync(target, inbox(n.root, BEN, NAME));
    } else fs.writeFileSync(inbox(n.root, BEN, NAME), o.bytes || INSTALLER);
    ask(n.root, BEN, { verb: 'upgrade', file: NAME });
    const r = await control(n.root, BEN, win, net);
    assert.equal(r.code, 3, what + ': ' + r.text);
    const a = answerOf(n.root, BEN);
    assert.ok(says(a.words), what + ': ' + a.words);
    assert.equal(a.code, 3, what);
    const ev = eventsOf(n.root);
    assert.deepEqual(ev.map((e) => [e.kind, e.by.sid, e.rights]), [['machine.upgrade.refused', BEN, ['upgrade']]], what + ': one event');
    assert.ok(ev[0].words.startsWith('LAPTOP\\ben asked to upgrade AGMessage to 0.6.1 (' + NAME + '), and was refused: '), what + ': ' + ev[0].words);
    assert.deepEqual([win.tasks.size, win.handed.length], [0, 0], what + ': nothing handed to a runner');
    assert.deepEqual(fs.readdirSync(path.join(n.root, 'machine', 'staged')), [], what + ': nothing left staged');
    assert.ok(!fs.existsSync(inbox(n.root, BEN, NAME)), what + ': the inbox\'s file removed, a link by its own removal');
    if (o.busy) {
      assert.deepEqual([a.busy, a.forceable], [true, true], 'the person is asked for a reason');
      // With the reason typed, the same installer is checked again and handed on.
      fs.writeFileSync(inbox(n.root, BEN, NAME), INSTALLER);
      ask(n.root, BEN, { verb: 'upgrade', file: NAME, force: 'the room is empty, the countdown is a rehearsal' });
      assert.equal((await control(n.root, BEN, win, net)).code, 0);
      assert.equal(planOf(win.handed[0]).force, 'the room is empty, the countdown is a rehearsal');
    }
  }
});

test('an upgrade or a go back the install record cannot carry (no port, no install folder) is not done, with its one machine.upgrade.refused event; a look writes none', async () => {
  for (const [what, change, re] of [['no port', (r) => { delete r.Port; }, /names no port/], ['no install folder', (r) => { r.InstallDir = 'Program Files\\AGMessage'; }, /names no install folder/]]) {
    const n = installed();
    change(n.record);
    const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
    const { net } = hands();
    for (const request of [{ verb: 'upgrade', release: '0.6.1' }, { verb: 'back', to: '0.6.40' }]) {
      ask(n.root, BEN, request);
      assert.equal((await control(n.root, BEN, win, net)).code, 2, what);
      const a = answerOf(n.root, BEN);
      assert.match(a.words, re, what);
      assert.equal(a.why, 'record', what + ': the console reads why');
    }
    assert.deepEqual(eventsOf(n.root).map((e) => [e.kind, e.by.sid]), [['machine.upgrade.refused', BEN], ['machine.upgrade.refused', BEN]], what + ': one event each');
    assert.match(eventsOf(n.root)[1].words, /^LAPTOP\\ben asked to take AGMessage back to build 40, and was refused: The install record names no/);
  }
  const n = installed();
  n.record.InstallDir = 'Program Files\\AGMessage';
  ask(n.root, ANA, { verb: 'upgrade', look: true });
  assert.equal((await control(n.root, ANA, fakeWindows({ record: n.record }), hands().net)).code, 2);
  assert.deepEqual([answerOf(n.root, ANA).words, eventsOf(n.root)], ['The install record names no install folder, so AGMessage\'s build and its kept installers cannot be read: reinstall AGMessage.', []]);
});

// ---------------------------------------------------------------- the newest release

test('the newest release: a look names it and whether it is newer, changes nothing and writes no event; then downloaded straight into machine\\staged\\ and checked by its digest, refused before any download when it is not newer', async () => {
  const n = installed();
  const win = fakeWindows({ record: n.record });
  const downloads = [];
  const download = async (a, file) => { downloads.push({ a, file }); fs.writeFileSync(file, INSTALLER); return { status: 200, bytes: INSTALLER.length }; };
  const { net } = hands({ download });
  ask(n.root, ANA, { verb: 'upgrade', look: true });
  let r = await control(n.root, ANA, win, net);
  assert.equal(r.code, 0, r.text);
  let a = answerOf(n.root, ANA);
  assert.deepEqual([a.look, a.newer, a.release, a.installed], [true, true, { semver: '0.6.1', name: NAME, size: INSTALLER.length, digest: 'sha256:' + SUM }, { semver: '0.6.0', version: '0.6.41', build: '41' }]);
  assert.equal(a.words, 'The newest release is AGMessage 0.6.1 (' + NAME + ', 140 KB); this PC has AGMessage 0.6.0 (build 41).');
  assert.deepEqual([net.github.asked, eventsOf(n.root), downloads.length, win.tasks.size], [[LATEST], [], 0, 0], 'a look asks GitHub and does nothing more');
  // Enter installs it: the release asked by its version, the asset downloaded straight into a folder of machine\staged\.
  ask(n.root, ANA, { verb: 'upgrade', release: '0.6.1' });
  r = await control(n.root, ANA, win, net);
  assert.equal(r.code, 0, r.text);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].a.url, 'https://api.github.com/repos/jammin808/AGMessage/releases/assets/310007702');
  assert.equal(path.dirname(path.dirname(downloads[0].file)), path.join(n.root, 'machine', 'staged'));
  assert.equal(planOf(win.handed[0]).installer, downloads[0].file);
  assert.equal(planOf(win.handed[0]).for, ANA);
  // A download that is not the release's (another file came, a short one, none at all) runs nothing.
  for (const [what, d, re] of [
    ['other bytes', async (x, file) => { fs.writeFileSync(file, Buffer.from('not the installer')); return { status: 200, bytes: x.size }; }, /is not the release's \(its SHA-256 differs from the digest GitHub gives\): nothing was run/],
    ['a short one', async (x, file) => { fs.writeFileSync(file, INSTALLER.subarray(0, 10)); return { status: 200, bytes: 10 }; }, /could not be downloaded whole \(10 of 143360 bytes\)/],
    ['none at all', async () => ({ error: 'ECONNRESET' }), /could not be downloaded whole \(ECONNRESET\)/],
    ['too slow', async () => ({ error: 'too slow' }), /could not be downloaded whole \(not within 7 minutes\): nothing was run/],
  ]) {
    const m = installed();
    const h2 = hands({ download: d });
    const w2 = fakeWindows({ record: m.record });
    ask(m.root, ANA, { verb: 'upgrade', release: '0.6.1' });
    assert.equal((await control(m.root, ANA, w2, h2.net)).code, 3, what);
    assert.match(answerOf(m.root, ANA).words, re, what);
    assert.deepEqual([w2.tasks.size, fs.readdirSync(path.join(m.root, 'machine', 'staged')), eventsOf(m.root).map((e) => e.kind)], [0, [], ['machine.upgrade.refused']], what);
  }
  // Not newer: said at the look, refused at the ask before anything is downloaded.
  const m = installed({ semver: '0.6.1', ver: '0.6.52' });
  downloads.length = 0;
  ask(m.root, ANA, { verb: 'upgrade', look: true });
  await control(m.root, ANA, fakeWindows({ record: m.record }), net);
  a = answerOf(m.root, ANA);
  assert.deepEqual([a.newer, a.words], [false, 'The newest release, AGMessage 0.6.1, is not newer than this PC\'s AGMessage 0.6.1 (build 52).']);
  ask(m.root, ANA, { verb: 'upgrade', release: '0.6.1' });
  assert.equal((await control(m.root, ANA, fakeWindows({ record: m.record }), net)).code, 3);
  assert.deepEqual([downloads.length, eventsOf(m.root).map((e) => e.kind)], [0, ['machine.upgrade.refused']]);
  // A look with no network says so in the words a person reads, and is no event.
  const o = installed();
  ask(o.root, ANA, { verb: 'upgrade', look: true });
  assert.equal((await control(o.root, ANA, fakeWindows({ record: o.record }), hands({ gh: github({ [LATEST]: { error: 'EAI_AGAIN' } }) }).net)).code, 3);
  assert.deepEqual([answerOf(o.root, ANA).words, eventsOf(o.root)], [machine.OFFLINE_WORDS, []]);
});

test('who may: the laptop\'s admin and an account given upgrade; one without it is refused for want of the right (machine.refused); an administrator\'s console names no file of its own', async () => {
  const n = installed({ sids: [ANA, BEN, CAL] });
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade', [CAL]: 'start,stop' } });
  const { net } = hands();
  ask(n.root, CAL, { verb: 'upgrade', look: true });
  let r = await control(n.root, CAL, win, net);
  assert.equal(r.code, 3);
  assert.equal(answerOf(n.root, CAL).words, 'You may not upgrade AGMessage on this PC (your rights here: start, stop). Ask LAPTOP\\ana, or an administrator.');
  ask(n.root, CAL, { verb: 'back', to: '0.6.40' });
  await control(n.root, CAL, win, net);
  assert.equal(answerOf(n.root, CAL).words, 'You may not take AGMessage back to its build before on this PC (your rights here: start, stop). Ask LAPTOP\\ana, or an administrator.');
  assert.deepEqual(eventsOf(n.root).map((e) => [e.kind, e.rights, e.words]), [
    ['machine.refused', ['upgrade'], 'LAPTOP\\cal asked to look up AGMessage\'s newest release, and was refused: You may not upgrade AGMessage on this PC (your rights here: start, stop). Ask LAPTOP\\ana, or an administrator.'],
    ['machine.refused', ['upgrade'], 'LAPTOP\\cal asked to take AGMessage back to its build before (0.6.40), and was refused: You may not take AGMessage back to its build before on this PC (your rights here: start, stop). Ask LAPTOP\\ana, or an administrator.'],
  ]);
  for (const sid of [ANA, BEN]) {
    ask(n.root, sid, { verb: 'upgrade', look: true });
    r = await control(n.root, sid, win, net);
    assert.equal(r.code, 0, sid + ': ' + r.text);
  }
  // An administrator's elevated console: its own installer is its own to run, so a named file is refused here.
  const work = path.join(n.root, 'machine', 'work', 'request-elevated.json');
  fs.writeFileSync(work, JSON.stringify({ id: nextId(), verb: 'upgrade', file: NAME }));
  const it = fakeWindows({ record: n.record, me: '"LAPTOP\\it","S-1-5-21-1-2-3-500"', groups: ELEVATED });
  r = await machine.run(['control', '--elevated', '--request', work, '--machine', n.root, '--sys', SYS], { run: it.run, net });
  assert.equal(r.code, 3);
  assert.match(r.text, /^You are an administrator here: run AGMessage-Setup-0\.6\.1-unsigned\.exe yourself/);
  // Its upgrade to the newest release, checked the same way, runs as that administrator: started from its own folder on
  // its own (an elevated console's request is in no task's job), never as a task.
  const e = hands({ download: async (x, file) => { fs.writeFileSync(file, INSTALLER); return { status: 200, bytes: INSTALLER.length }; } });
  fs.writeFileSync(work, JSON.stringify({ id: nextId(), verb: 'upgrade', release: '0.6.1' }));
  r = await machine.run(['control', '--elevated', '--request', work, '--machine', n.root, '--sys', SYS], { run: it.run, net: e.net });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([e.spawned.length, it.tasks.size, r.out.runner], [1, 0, 4242]);
  const sp = e.spawned[0];
  assert.deepEqual([sp.opts.detached, sp.opts.stdio, sp.opts.cwd, path.dirname(sp.cmd)], [true, 'ignore', path.dirname(sp.cmd), path.dirname(planFileOf(sp))]);
  assert.deepEqual([planOf(sp).elevated, planOf(sp).by.sid], [true, 'S-1-5-21-1-2-3-500']);
  // Its start failing (its node.exe could not be copied) is said, its folder marked ended, nothing left staged.
  const bad = hands({ download: e.net.download });
  bad.net.runner.execPath = path.join(n.top, 'no-node.exe');
  fs.writeFileSync(path.join(path.dirname(planFileOf(sp)), 'ended.json'), '{}');
  fs.writeFileSync(work, JSON.stringify({ id: nextId(), verb: 'upgrade', release: '0.6.1' }));
  r = await machine.run(['control', '--elevated', '--request', work, '--machine', n.root, '--sys', SYS], { run: it.run, net: bad.net });
  assert.equal(r.code, 2);
  assert.match(r.text, /^The upgrade could not be started \(ENOENT\): nothing was run\.$/);
  const left = fs.readdirSync(path.join(n.root, 'machine', 'work')).filter((x) => machine.RUNNER_DIR.test(x));
  assert.equal(left.length, 1, 'the ended runner swept, the one that did not start left marked');
  assert.ok(fs.existsSync(path.join(n.root, 'machine', 'work', left[0], 'ended.json')) && fs.existsSync(path.join(n.root, 'machine', 'work', left[0], 'plan.json')), 'its plan written first, its end beside it');
  assert.deepEqual(fs.readdirSync(path.join(n.root, 'machine', 'staged')), []);
});

// ---------------------------------------------------------------- Go back to build N

test('Go back to build N: the record\'s Previous, its kept installer and the backup the upgrade from it made; the runner stops AGMessage (it saves), lays that backup back and runs the kept installer with /ROLLBACK and /UPGRADEBY; each outcome one event, said from what was seen', async () => {
  const n = installed({ semver: '0.6.1', ver: '0.6.52', previous: '0.6.41' });
  const data = path.join(n.root, 'data');
  // The data as build 41 left it at its upgrade's stop, backed up then; build 52 wrote after.
  fs.writeFileSync(path.join(data, 'settings.json'), '{"by":"build 41"}');
  const made = upgradebackup.make({ dataDir: data, uploadDir: path.join(n.root, 'uploads'), build: '0.6.0+41.abc1234', stopAt: Date.now() - 60_000, saved: true, reserve: 0 });
  fs.writeFileSync(path.join(data, 'settings.json.tmp'), 'x');
  fs.renameSync(path.join(data, 'settings.json.tmp'), path.join(data, 'settings.json'));
  fs.writeFileSync(path.join(data, 'settings.json'), '{"by":"build 52"}');
  fs.writeFileSync(path.join(data, 'made-by-52.json'), '{}');
  const kept = path.join(n.app, 'installers', 'AGMessage-Setup-0.6.41-unsigned.exe');
  fs.writeFileSync(kept, 'build 41\'s installer');
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  const { net } = hands();
  const id = ask(n.root, BEN, { verb: 'back', to: '0.6.41' });
  const r = await control(n.root, BEN, win, net);
  assert.equal(r.code, 0, r.text);
  const a = answerOf(n.root, BEN);
  assert.deepEqual([a.pending, a.backup, a.runner], [true, path.basename(made.name), win.handed[0].tn]);
  assert.match(a.words, /^Going back from AGMessage 0\.6\.1 \(build 52\) to build 41: AGMessage stops \(it saves\), its data is laid back from the backup made when the newer build was installed \(\d\d:\d\d on \d{4}-\d\d-\d\d;/);
  const plan = planOf(win.handed[0]);
  assert.deepEqual([plan.kind, plan.to, plan.installer, plan.backup, plan.staged], ['back', '0.6.41', kept, path.basename(made.name), '']);
  const dir = path.dirname(planFileOf(win.handed[0]));
  // The runner: the stop asked at loopback (reason back), the backup laid back, then the kept installer.
  const order = [];
  const rw = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  const rnet = {
    stop: async (o) => { order.push(['stop', o.reason, o.by, o.force, eventsOf(n.root).length]); return { ok: true, status: 200, json: { stopping: true } }; },
    portAnswers: async () => false,
    runInstaller: async (file, args) => {
      order.push(['installer', file, args, read(path.join(data, 'settings.json')), fs.existsSync(path.join(data, 'made-by-52.json')), eventsOf(n.root).length]);
      Object.assign(rw.record, { Version: '0.6.41', SemVer: '0.6.0', Previous: '' });
      return { code: 0 };
    },
  };
  const done = await runner(win.handed[0], rw, rnet);
  assert.equal(done.code, 0, done.text);
  assert.deepEqual(order, [
    ['stop', 'back', 'LAPTOP\\ben', '', 0],
    ['installer', kept, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/ROLLBACK', '/UPGRADEBY=' + BEN, '/LOG=' + path.join(dir, 'back.log')], '{"by":"build 41"}', false, 0],
  ], 'stopped, the backup laid back, then the kept installer, and no event until its outcome is seen');
  const ev = eventsOf(n.root);
  assert.deepEqual(ev.map((e) => [e.kind, e.by.sid, e.rights]), [['machine.upgrade', BEN, ['upgrade']]]);
  assert.match(ev[0].words, /^LAPTOP\\ben took AGMessage back from 0\.6\.1 \(build 52\) to 0\.6\.0 \(build 41\) as SYSTEM, build 41's kept installer sha256:[0-9a-f]{64}, its data laid back as of \d{4}-\d\d-\d\d \d\d:\d\d\.$/);
  assert.ok(ev[0].words.includes(sha256(Buffer.from('build 41\'s installer'))), 'the kept installer\'s digest, read before anything changed');
  const fin = answerOf(n.root, BEN);
  assert.deepEqual([fin.id, fin.final, fin.code, fin.words, fin.event], [id, true, 0, 'Gone back: AGMessage 0.6.0 (build 41) is installed on this PC, and it answers.', ev[0].seq]);
  // The runner's own ends of a go back, each its last answer and its one event: busy by the time it stops (refused,
  // nothing changed), the server's programs still running once it has stopped (nothing laid back), a backup that cannot
  // be laid back (AGMessage left stopped), and the kept installer refusing once the data is laid back.
  const backRun = async (rnetExtra, programs = () => [], spoil = () => {}) => {
    const m = installed({ semver: '0.6.1', ver: '0.6.52', previous: '0.6.41' });
    fs.writeFileSync(path.join(m.app, 'installers', 'AGMessage-Setup-0.6.41-unsigned.exe'), 'x');
    upgradebackup.make({ dataDir: path.join(m.root, 'data'), uploadDir: path.join(m.root, 'uploads'), build: '0.6.0+41.abc1234', stopAt: Date.now(), saved: true, reserve: 0 });
    const cw = fakeWindows({ record: m.record, grants: { [BEN]: 'upgrade' } });
    ask(m.root, BEN, { verb: 'back', to: '0.6.41' });
    assert.equal((await control(m.root, BEN, cw, hands().net)).code, 0);
    spoil(m);
    const w = fakeWindows({ record: m.record, grants: { [BEN]: 'upgrade' }, programs });
    const got = await runner(cw.handed[0], w, { programsWaitMs: 20, runInstaller: async () => { throw new Error('never run'); }, ...rnetExtra });
    return { got, fin: answerOf(m.root, BEN), ev: eventsOf(m.root), m, dir: path.dirname(planFileOf(cw.handed[0])) };
  };
  const stopped = { stop: async () => ({ ok: true, status: 200, json: { stopping: true } }), portAnswers: async () => false };
  let b = await backRun({ stop: async () => ({ ok: true, status: 409, json: { error: 'Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.' } }), portAnswers: async () => false });
  assert.deepEqual([b.got.code, b.fin.final, b.fin.code, b.fin.busy, b.ev.map((e) => e.kind)], [3, true, 3, true, ['machine.upgrade.refused']]);
  assert.match(b.ev[0].words, /^LAPTOP\\ben asked to take AGMessage back to build 41, and was refused: Not stopped: AGMessage is busy/);
  b = await backRun(stopped, () => [{ pid: 6000, name: 'node.exe', cmd: '"C:\\x\\node.exe" "C:\\x\\app\\supervise.js"', exe: 'C:\\x\\node\\node.exe' }]);
  assert.deepEqual([b.got.code, b.fin.code, b.ev.map((e) => e.kind)], [2, 2, ['machine.upgrade.refused']], 'stopped and nothing laid back is no go back');
  assert.match(b.fin.words, /^AGMessage stopped for the go back, but node\.exe \(pid 6000\) still runs from .*, so nothing was laid back/);
  assert.equal(b.ev[0].words, 'LAPTOP\\ben asked to take AGMessage back to build 41; it did not happen: ' + b.fin.words.slice(0, 300 - 'LAPTOP\\ben asked to take AGMessage back to build 41; it did not happen: '.length));
  b = await backRun(stopped, () => [], (m) => { for (const d of fs.readdirSync(path.join(m.root, 'data', 'backups'))) fs.rmSync(path.join(m.root, 'data', 'backups', d, 'backup.json')); });
  assert.deepEqual([b.got.code, b.fin.code, b.ev.map((e) => e.kind)], [2, 2, ['machine.upgrade.refused']]);
  assert.match(b.fin.words, /^AGMessage stopped for the go back, but its data could not be laid back: the backup .* is not whole \(no backup\.json\): nothing was laid back\. AGMessage stays stopped/);
  // The kept installer refuses (another installer runs, a console opened, Smart App Control) after the stop and the lay
  // back: said as what the runner did and what is seen, never as "nothing changed"; its log's last lines in the answer.
  const refusing = { ...stopped, hello: async () => ({ ok: false, why: 'ECONNREFUSED', words: 'nothing serving' }), runInstaller: async (file, args) => { fs.writeFileSync(args.find((x) => x.startsWith('/LOG=')).slice(5), 'Setup started.\r\nAnother AGMessage installer is running on this PC.\r\nSetup exited with code 1.\r\n'); return { code: 1 }; } };
  b = await backRun(refusing);
  assert.deepEqual([b.got.code, b.fin.code, b.fin.installerExit, b.fin.answers, b.ev.map((e) => e.kind)], [2, 2, 1, false, ['machine.upgrade.refused']]);
  assert.match(b.fin.words, /^Build 41's installer ended with 1: it refused before it replaced a file, after AGMessage was stopped for the go back and its data laid back as build 41 left it on \d{4}-\d\d-\d\d at \d\d:\d\d \(what was written since is not kept\)\. The install record still names AGMessage 0\.6\.1 \(build 52\); nothing answers on port 3023, so AGMessage is stopped\. Start AGMessage starts AGMessage 0\.6\.1 \(build 52\) on the data laid back, or Go back to build 41 again\.$/);
  assert.deepEqual([b.fin.log, b.fin.logTail], [path.join(b.dir, 'back.log'), ['Setup started.', 'Another AGMessage installer is running on this PC.', 'Setup exited with code 1.']]);
  // Its own way back laid the build down but it did not start: the record names it, nothing answers.
  b = await backRun({ ...refusing, runInstaller: async () => ({ code: 3 }) }, () => [], () => {});
  assert.match(b.fin.words, /^Build 41's installer ended with 3: the build it laid down did not start, after .* The install record still names AGMessage 0\.6\.1 \(build 52\)/);
  // Refused, each with its words and its one event: nothing named before, another build named, no kept installer, no
  // backup of that build, busy without a reason.
  const refusedFor = async ({ previous = '0.6.41', to = '0.6.41', keep = true, backup = true, busy = false }) => {
    const m = installed({ semver: '0.6.1', ver: '0.6.52', previous });
    if (keep) fs.writeFileSync(path.join(m.app, 'installers', 'AGMessage-Setup-0.6.41-unsigned.exe'), 'x');
    if (backup) upgradebackup.make({ dataDir: path.join(m.root, 'data'), uploadDir: path.join(m.root, 'uploads'), build: '0.6.0+41.abc1234', stopAt: Date.now(), saved: true, reserve: 0 });
    const hs = hands(busy ? { busy: { answered: true, running: true, busy: true, words: '1 page active' } } : {});
    const cw = fakeWindows({ record: m.record, grants: { [BEN]: 'upgrade' } });
    ask(m.root, BEN, { verb: 'back', to });
    const got = await control(m.root, BEN, cw, hs.net);
    assert.equal(got.code, 3);
    assert.equal(cw.tasks.size, 0);
    assert.deepEqual(eventsOf(m.root).map((e) => e.kind), ['machine.upgrade.refused']);
    return answerOf(m.root, BEN).words;
  };
  assert.match(await refusedFor({ previous: '' }), /^This PC has no build before AGMessage 0\.6\.1 \(build 52\) to go back to/);
  assert.match(await refusedFor({ to: '0.6.39' }), /^The build before this one is build 41 now, not build 39: run Go back to build 41/);
  assert.match(await refusedFor({ keep: false }), /^Build 41's installer is not kept in .*an administrator runs that build's installer with \/ROLLBACK\.$/);
  assert.match(await refusedFor({ backup: false }), /^No backup of this PC's data from build 41 is kept/);
  assert.equal(await refusedFor({ busy: true }), 'Not taken back: AGMessage is busy (1 page active). Type a reason to take it back anyway.');
});

test('a backup laid back keeps the place the machine\'s events have reached in the audit log, which is never rolled back: the earlier build\'s first start writes none of them twice', async () => {
  const machineevents = require('../lib/machineevents');
  const n = installed();
  const data = path.join(n.root, 'data');
  const settings = path.join(data, 'settings.json');
  // Build 41's settings at its upgrade's stop: machine events read to 3.
  fs.writeFileSync(settings, JSON.stringify({ by: 'build 41', machineSeq: 3 }, null, 2));
  const made = upgradebackup.make({ dataDir: data, uploadDir: path.join(n.root, 'uploads'), build: '0.6.0+41.abc1234', stopAt: Date.now(), saved: true, reserve: 0 });
  // Build 52 read on to 9 (its own upgrade's event among them), saved by rename as the server's lane saves.
  fs.writeFileSync(settings + '.tmp', JSON.stringify({ by: 'build 52', machineSeq: 9 }, null, 2));
  fs.renameSync(settings + '.tmp', settings);
  const restoreIt = () => machine.run(['restore', '--machine', n.root, '--backup', path.basename(made.name), '--port', '1'], { net: { portAnswers: async () => false } });
  let r = await restoreIt();
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.machineSeq, 9);
  assert.match(r.text, /and so is the place its machine events have reached \(machine event 9\)/);
  const laid = JSON.parse(read(settings));
  assert.deepEqual(laid, { by: 'build 41', machineSeq: 9 }, 'build 41\'s settings, with the place kept');
  const backed = path.join(data, 'backups', path.basename(made.name), 'data', 'settings.json');
  assert.deepEqual(JSON.parse(read(backed)), { by: 'build 41', machineSeq: 3 }, 'the backup\'s own file, which the lay back links, unchanged');
  // The earlier build's first start, none of the newest 500 rows a machine event's: it writes only what came after 9.
  const file = path.join(n.root, 'machine', 'events.jsonl');
  for (let i = 0; i < 10; i++) machine.appendEvent(path.join(n.root, 'machine'), { kind: 'machine.start', by: { sid: ANA, name: 'LAPTOP\\ana' }, forAccount: { sid: ANA, name: 'LAPTOP\\ana' }, rights: ['start'], words: 'started ' + (i + 1) });
  const rows = [];
  const newest = Array.from({ length: 500 }, (_, i) => ({ action: 'message.post', words: 'a message, row ' + i }));
  const reader = new machineevents.MachineEvents({ file, write: (row) => rows.push(row), lastSeq: () => Math.max(laid.machineSeq, ...newest.map(machineevents.seqOfRow)), saveSeq: () => {} });
  const got = await reader.read();
  assert.equal(got.written, 1);
  assert.deepEqual(rows.map((x) => machineevents.seqOfRow(x)), [10]);
  // Settings already at or past the place, settings the backup has none of, and settings that do not read are each
  // handled: nothing lowered, the place alone made, nothing written over.
  assert.equal(machine.keepMachineSeq(fs, settings, 5), 0);
  fs.rmSync(settings);
  assert.equal(machine.keepMachineSeq(fs, settings, 5), 5);
  assert.deepEqual(JSON.parse(read(settings)), { machineSeq: 5 });
  fs.writeFileSync(settings, '{ not json');
  assert.equal(machine.keepMachineSeq(fs, settings, 7), 0);
  assert.equal(read(settings), '{ not json');
  assert.deepEqual([machine.machineSeqIn(fs, settings), machine.keepMachineSeq(fs, settings, 0)], [0, 0]);
  r = await restoreIt();
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.machineSeq, 0, 'a live place that cannot be read keeps the backup\'s');
});

// ---------------------------------------------------------------- the runner's own refusals, and one at a time

test('the runner runs only a plan its control task wrote, as SYSTEM, from its own copy, never from {app}; a console left open past its wait is refused with one event and nothing run; one upgrade or go back at a time, by the check\'s lock and the runner\'s own program', async () => {
  const n = installed();
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  const { net } = hands();
  fs.writeFileSync(inbox(n.root, BEN, NAME), INSTALLER);
  ask(n.root, BEN, { verb: 'upgrade', file: NAME });
  assert.equal((await control(n.root, BEN, win, net)).code, 0);
  const first = win.handed[0];
  const planFile = planFileOf(first);
  const plan = planOf(first);
  const runIt = (w, extra = {}, file = planFile) => machine.run(['upgrade', '--step', 'run', '--plan', file, '--sys', SYS], { run: w.run, net: { pollMs: 5, nudge: async () => null, pendingWaitMs: 0, runInstaller: async () => { throw new Error('never run'); }, ...extra } });
  const again = async (w = win, hs = net) => {
    fs.writeFileSync(inbox(n.root, BEN, NAME), INSTALLER);
    ask(n.root, BEN, { verb: 'upgrade', file: NAME });
    return control(n.root, BEN, w, hs);
  };
  // A second upgrade while this one has just been handed on (its program not yet seen) is refused, with its event.
  assert.equal((await again()).code, 3);
  assert.match(answerOf(n.root, BEN).words, /^An upgrade asked at \d\d:\d\d is still under way: wait for it to end/);
  assert.equal(win.handed.length, 1);
  assert.ok(fs.existsSync(plan.installer), 'the staged copy the runner holds is kept');
  // Another control task holding the check's lock refuses it too; a lock older than any check runs is one a control task
  // that ended left, taken over.
  const lock = path.join(n.root, 'machine', 'work', 'upgrade.lock');
  fs.writeFileSync(lock, '{}');
  assert.equal((await again()).code, 3);
  assert.match(answerOf(n.root, BEN).words, /^Another upgrade or go back is being checked now \(asked at \d\d:\d\d\): wait for it to end, then ask again\.$/);
  assert.ok(fs.existsSync(lock), 'another\'s lock is never taken');
  const old = (Date.now() - machine.UPGRADE_LOCK_STALE_MS - 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal((await again()).code, 3, 'taken over, then refused for the runner under way');
  assert.match(answerOf(n.root, BEN).words, /is still under way/);
  assert.ok(!fs.existsSync(lock), 'given back');
  // Not SYSTEM; a plan file outside machine\work\upgrade-<id>\; a plan that is not whole; run from {app}.
  let r = await runIt(fakeWindows({ record: n.record, me: '"LAPTOP\\ben","' + BEN + '"' }));
  assert.equal(r.code, 3);
  assert.match(r.text, /runs as SYSTEM, from the copy its control task left/);
  assert.equal((await runIt(win, {}, path.join(n.root, 'machine', 'work', 'plan.json'))).code, 64);
  const bad = path.join(n.root, 'machine', 'work', 'upgrade-0123456789abcdef');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'plan.json'), JSON.stringify({ ...plan, installer: 'relative.exe' }));
  assert.match((await runIt(win, {}, path.join(bad, 'plan.json'))).text, /is not one its control task wrote: nothing was run/);
  fs.writeFileSync(path.join(bad, 'plan.json'), JSON.stringify({ ...plan, id: '0123456789abcdef' }));
  r = await runIt(win, { self: { node: path.join(n.app, 'node', 'node.exe'), script: path.join(n.app, 'app', 'machine.js') } }, path.join(bad, 'plan.json'));
  assert.match(r.text, /never from .*AGMessage, whose files the installer replaces: nothing was run/);
  fs.rmSync(bad, { recursive: true });
  assert.deepEqual(eventsOf(n.root).map((e) => e.kind), ['machine.upgrade.refused', 'machine.upgrade.refused', 'machine.upgrade.refused'], 'only the three refused asks: a runner that refuses its plan acts for nobody');
  // The console that asked stays open past the wait: refused, nothing run, one event, the staged copy removed.
  const open = fakeWindows({ record: n.record, programs: () => [{ pid: 5000, name: 'node.exe', cmd: 'launch.js upgrade', exe: n.app + '\\node\\node.exe' }] });
  r = await runIt(open, { consoleWaitMs: 30 });
  assert.equal(r.code, 3);
  assert.match(r.text, /^node\.exe \(pid 5000\) still runs from .* \(a console of the Start menu left open\), so AGMessage's files could not be replaced: nothing was changed\. Close it, then ask again\.$/);
  const evs = eventsOf(n.root);
  assert.equal(evs.length, 4);
  assert.match(evs[3].words, /^LAPTOP\\ben asked to upgrade AGMessage to 0\.6\.1, and was refused: node\.exe \(pid 5000\) still runs/);
  assert.equal(answerOf(n.root, BEN).final, true);
  assert.ok(!fs.existsSync(plan.installer) && fs.existsSync(path.join(path.dirname(planFile), 'ended.json')));
  // Ended: the next upgrade sweeps its folder and its task, and goes on.
  assert.equal((await again()).code, 0);
  assert.ok(!fs.existsSync(path.dirname(planFile)), 'the ended runner\'s folder swept');
  assert.ok(win.deleted.includes(first.tn) && !win.tasks.has(first.tn), 'its task removed');
  // A runner whose own program still runs from its folder is under way however long it runs (an installer is never
  // killed, and waited for); once its program is gone with no end written it died: its outcome said by its one event,
  // from what the record names, its folder, staged copy and task swept.
  const second = win.handed[1];
  const secondFile = planFileOf(second);
  const secondPlan = planOf(second);
  const runnerDir = path.dirname(secondFile);
  fs.writeFileSync(secondFile, JSON.stringify({ ...secondPlan, at: Date.now() - machine.RUNNER_START_MS - 60 * 60_000 }));
  const alive = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' }, programs: (dir) => (dir === runnerDir ? [{ pid: 7000, name: 'node.exe', cmd: 'machine.js upgrade --step run', exe: path.join(runnerDir, 'node.exe') }] : []) });
  assert.equal((await again(alive)).code, 3);
  assert.match(answerOf(n.root, BEN).words, /is still under way/);
  const before = eventsOf(n.root).length;
  assert.equal((await again()).code, 0);
  const died = eventsOf(n.root).slice(before);
  assert.deepEqual(died.map((e) => [e.kind, e.by.sid]), [['machine.upgrade.refused', BEN]], 'its one event; this ask, handed on, has none yet');
  assert.match(died[0].words, /^LAPTOP\\ben asked to upgrade AGMessage to 0\.6\.1 at \d\d:\d\d; it did not happen: its runner ended at no step it said \(its program is gone\), and the install record names 0\.6\.0 \(build 41\) now\.$/);
  assert.ok(!fs.existsSync(runnerDir) && !fs.existsSync(secondPlan.installer) && !win.tasks.has(second.tn), 'its folder, its staged copy and its task swept');
  // One whose record names its target died after its installer did its work: machine.upgrade, from the record.
  const third = win.handed[2];
  fs.writeFileSync(planFileOf(third), JSON.stringify({ ...planOf(third), at: Date.now() - machine.RUNNER_START_MS - 1000 }));
  const upgraded = fakeWindows({ record: { ...n.record, Version: '0.6.52', SemVer: '0.6.1' }, grants: { [BEN]: 'upgrade' } });
  assert.equal((await again(upgraded)).code, 3, 'and then 0.6.1 is no upgrade of 0.6.1');
  const ev = eventsOf(n.root);
  assert.deepEqual(ev.slice(-2).map((e) => e.kind), ['machine.upgrade', 'machine.upgrade.refused']);
  assert.match(ev.at(-2).words, /^LAPTOP\\ben upgraded AGMessage from 0\.6\.0 \(build 41\) to 0\.6\.1 \(build 52\), asked at \d\d:\d\d: its runner ended at no step it said/);
  // A folder with no plan its control task wrote is left while it may still be being made, and swept after.
  const part = path.join(n.root, 'machine', 'work', 'upgrade-00000000000000ff');
  fs.mkdirSync(part);
  assert.equal((await again()).code, 0);
  assert.ok(fs.existsSync(part), 'a fresh one is left');
  const aged = (Date.now() - machine.RUNNER_START_MS - 1000) / 1000;
  fs.utimesSync(part, aged, aged);
  fs.writeFileSync(path.join(path.dirname(planFileOf(win.handed[3])), 'ended.json'), '{}');
  assert.equal((await again()).code, 0);
  assert.ok(!fs.existsSync(part), 'an old one swept');
  // A staged folder no runner holds is swept once older than any check runs, never a fresh one.
  const orphan = path.join(n.root, 'machine', 'staged', 'abcdefabcdefabcd');
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, NAME), 'x');
  fs.writeFileSync(path.join(path.dirname(planFileOf(win.handed[4])), 'ended.json'), '{}');
  assert.equal((await again()).code, 0);
  assert.ok(fs.existsSync(orphan));
  fs.utimesSync(orphan, old, old);
  fs.writeFileSync(path.join(path.dirname(planFileOf(win.handed[5])), 'ended.json'), '{}');
  assert.equal((await again()).code, 0);
  assert.ok(!fs.existsSync(orphan));
  // A runner's task that cannot be registered or run is said, its folder marked ended and nothing left staged.
  for (const [failTask, re] of [['create', /^The upgrade could not be started \(its task \\AGMessage\\Upgrade-[0-9a-f]{16} could not be registered: ERROR: Access is denied\.\): nothing was run\.$/], ['run', /^The upgrade could not be started \(its task \\AGMessage\\Upgrade-[0-9a-f]{16} could not be run: ERROR: The task could not be run\.\): nothing was run\.$/]]) {
    for (const sub of ['work', 'staged']) {
      fs.rmSync(path.join(n.root, 'machine', sub), { recursive: true });
      fs.mkdirSync(path.join(n.root, 'machine', sub));
    }
    const w = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' }, failTask });
    assert.equal((await again(w)).code, 2, failTask);
    assert.match(answerOf(n.root, BEN).words, re, failTask);
    assert.deepEqual([fs.readdirSync(path.join(n.root, 'machine', 'staged')), w.tasks.size], [[], 0], failTask);
    const dirs = fs.readdirSync(path.join(n.root, 'machine', 'work')).filter((x) => machine.RUNNER_DIR.test(x));
    assert.ok(dirs.length === 1 && fs.existsSync(path.join(n.root, 'machine', 'work', dirs[0], 'ended.json')), failTask);
  }
});

test('an installer that ends without its build: its exit code, what the record names and what answers on the port are the runner\'s last answer and its one machine.upgrade.refused event; the runner\'s last answer is never written under its control task\'s', async () => {
  const n = installed();
  const win = fakeWindows({ record: n.record });
  const { net } = hands();
  fs.writeFileSync(inbox(n.root, ANA, NAME), INSTALLER);
  ask(n.root, ANA, { verb: 'upgrade', file: NAME });
  assert.equal((await control(n.root, ANA, win, net)).code, 0);
  const handed = win.handed[0];
  // Its own way back laid build 41 down again, and it answers.
  let r = await runner(handed, win, { hello: async () => ({ ok: true, build: '0.6.0+41.abc1234' }), runInstaller: async () => ({ code: 3 }) });
  assert.equal(r.code, 2);
  let fin = answerOf(n.root, ANA);
  assert.deepEqual([fin.final, fin.code, fin.installerExit, fin.answers, fin.installed.build], [true, 2, 3, true, '41']);
  assert.equal(fin.words, 'The installer of 0.6.1 ended with 3: the build it laid down did not start. The install record names AGMessage 0.6.0 (build 41), the build before; AGMessage 0.6.0+41.abc1234 answers on port 3023.');
  assert.deepEqual(fin.logTail, [], 'no log written');
  const ev = eventsOf(n.root);
  assert.deepEqual(ev.map((e) => e.kind), ['machine.upgrade.refused'], 'one event, and no machine.upgrade for an upgrade that did not happen');
  assert.equal(ev[0].words, ('LAPTOP\\ana asked to upgrade AGMessage to 0.6.1; it did not happen: ' + fin.words).slice(0, 300));
  // Nothing answers after it: said, with what starts it.
  const m = installed();
  const w2 = fakeWindows({ record: m.record });
  fs.writeFileSync(inbox(m.root, ANA, NAME), INSTALLER);
  ask(m.root, ANA, { verb: 'upgrade', file: NAME });
  assert.equal((await control(m.root, ANA, w2, hands().net)).code, 0);
  r = await runner(w2.handed[0], w2, { hello: async () => ({ ok: false, why: 'ECONNREFUSED' }), runInstaller: async () => ({ code: -1, error: 'EACCES' }) });
  assert.equal(r.code, 2);
  fin = answerOf(m.root, ANA);
  assert.equal(fin.words, 'The installer of 0.6.1 ended with -1 (EACCES): it could not be run. The install record names AGMessage 0.6.0 (build 41), the build before; nothing answers on port 3023, so AGMessage is stopped. Start AGMessage starts it again.');
  // The runner's own end waits for its control task's answer, so that one never lands over it: here it comes late.
  const o = installed();
  const w3 = fakeWindows({ record: o.record });
  fs.writeFileSync(inbox(o.root, ANA, NAME), INSTALLER);
  ask(o.root, ANA, { verb: 'upgrade', file: NAME });
  assert.equal((await control(o.root, ANA, w3, hands().net)).code, 0);
  const pending = answerOf(o.root, ANA);
  fs.rmSync(path.join(o.root, 'machine', 'outbox', ANA, 'answer.json'));
  const outbox = path.join(o.root, 'machine', 'outbox', ANA);
  const late = setTimeout(() => fs.writeFileSync(path.join(outbox, 'answer.json'), JSON.stringify(pending)), 60);
  try {
    r = await runner(w3.handed[0], fakeWindows({ record: o.record, programs: () => { throw new Error('the programs could not be read'); } }), { pendingWaitMs: 60_000 });
  } finally { clearTimeout(late); }
  assert.equal(r.code, 3, 'refused: what runs from {app} could not be read, so nothing was replaced');
  fin = answerOf(o.root, ANA);
  assert.deepEqual([fin.id, fin.final], [pending.id, true], 'the last answer is the runner\'s, written after its control task\'s');
  assert.ok(await machine.answeredFirst(fs, outbox, planOf(w3.handed[0]), 0, 5));
  assert.equal(await machine.answeredFirst(fs, outbox, { ...planOf(w3.handed[0]), request: 'other', at: Date.now() }, 20, 5), false, 'bounded');
  // runInstaller itself: the program's own exit code, never killed, and one that cannot run said.
  assert.deepEqual(await machine.runInstaller(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 50)'], { cwd: os.tmpdir() }), { code: 7 });
  assert.equal((await machine.runInstaller(path.join(n.top, 'no-such-installer.exe'), [], { cwd: os.tmpdir() })).code, -1);
});

// ---------------------------------------------------------------- /UPGRADEBY, taken from SYSTEM alone

test('preinstall-check --upgrade-by (the installer\'s /UPGRADEBY): taken only from SYSTEM, for an account the record gives upgrade; its name in --out for the stop it asks', async () => {
  const n = installed();
  const out = path.join(n.top, 'check.json');
  const check = (w, sid) => machine.run(['preinstall-check', '--machine', n.root, '--port', '1', '--sys', SYS, '--upgrade-by', sid, '--out', out], { run: w.run, net: { portAnswers: async () => false } });
  let r = await check(fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } }), BEN);
  assert.equal(r.code, 0, r.text);
  assert.equal(JSON.parse(read(out)).byName, 'LAPTOP\\ben');
  r = await check(fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' }, me: '"LAPTOP\\it","S-1-5-21-1-2-3-500"' }), BEN);
  assert.equal(r.code, 3);
  assert.match(r.text, /^\/UPGRADEBY is the switch of AGMessage's own checked upgrade, which runs this installer as SYSTEM/);
  r = await check(fakeWindows({ record: n.record, grants: { [BEN]: 'start,stop' } }), BEN);
  assert.match(r.text, /^\/UPGRADEBY names S-1-5-21-1-2-3-1002, which AGMessage on this PC gives no right to upgrade it/);
  assert.equal((await check(fakeWindows({ record: n.record }), ANA)).code, 0, 'the laptop\'s admin holds every right');
  assert.equal((await check(fakeWindows({ record: n.record }), 'S-1-5-32-544')).code, 64, 'a group is no account');
});

// ---------------------------------------------------------------- GitHub over https

test('an https GET: an answer read whole within its bound, a redirect followed only to https and only as far as asked, a server that goes silent, and a download into a file', async () => {
  const cert = tlsmod.makeCertificate({ name: 'localhost', ips: ['127.0.0.1'] });
  const tls = { ca: tlsmod.toPem(cert.certDer) };
  let port = 0;
  const srv = https.createServer({ cert: tlsmod.toPem(cert.certDer), key: cert.keyPem }, (req, res) => {
    if (req.url === '/release') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: 'v0.6.1', ua: req.headers['user-agent'], accept: req.headers.accept })); return; }
    if (req.url === '/hop') { res.statusCode = 302; res.setHeader('location', 'https://127.0.0.1:' + port + '/asset'); res.end(); return; }
    if (req.url === '/plain') { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:' + port + '/asset'); res.end(); return; }
    if (req.url === '/asset') { res.end(INSTALLER); return; }
    if (req.url === '/silent') return;   // never answers
    if (req.url === '/drip') {   // never goes silent, never ends within a bound
      res.write('x');
      const t = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  port = srv.address().port;
  const at = (p) => 'https://127.0.0.1:' + port + p;
  try {
    let r = await machine.fetchHttps(at('/release'), { headers: machine.GITHUB_HEADERS, tls });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), { tag_name: 'v0.6.1', ua: 'AGMessage-machine', accept: 'application/vnd.github+json' });
    assert.deepEqual([(await machine.fetchHttps(at('/hop'), { tls })).status, (await machine.fetchHttps(at('/hop'), { tls })).location], [302, at('/asset')], 'no redirect followed unless asked');
    assert.equal((await machine.fetchHttps(at('/plain'), { tls, follow: 5 })).error, 'not https', 'a redirect to http is refused');
    assert.equal((await machine.fetchHttps(at('/asset'), { tls, max: 100 })).error, 'too large');
    assert.equal((await machine.fetchHttps(at('/silent'), { tls, timeoutMs: 200 })).error, 'silent');
    // A bound on the whole answer, a slow one that never goes silent included, and one already past.
    assert.equal((await machine.fetchHttps(at('/drip'), { tls, timeoutMs: 1000, until: Date.now() + 150 })).error, 'too slow');
    assert.equal((await machine.fetchHttps(at('/release'), { tls, until: Date.now() - 1 })).error, 'too slow');
    assert.equal((await machine.fetchHttps(at('/release'), { tls, until: Date.now() + 5000 })).status, 200, 'within it, the answer');
    const slow = path.join(tmp('agm-dl-'), NAME);
    assert.equal((await machine.downloadAsset({ url: at('/drip'), size: INSTALLER.length }, slow, { tls, maxMs: 150 })).error, 'too slow');
    assert.equal(machine.DOWNLOAD_MAX_MS, 7 * 60_000, 'a download ends within its control task\'s 10 minutes');
    assert.equal((await machine.fetchHttps('http://127.0.0.1:' + port + '/release', { tls })).error, 'not https');
    assert.equal((await machine.fetchHttps(at('/release'))).error !== undefined, true, 'a certificate no authority signed is no answer');
    r = await machine.fetchHttps(at('/nothing'), { tls });
    assert.deepEqual([r.status, r.body.toString()], [404, '{}']);
    // A download into a new file, through the redirect GitHub's asset address makes to its storage.
    const file = path.join(tmp('agm-dl-'), NAME);
    r = await machine.downloadAsset({ url: at('/hop'), size: INSTALLER.length }, file, { tls });
    assert.deepEqual([r.status, r.bytes], [200, INSTALLER.length]);
    assert.equal(machine.sha256File(fs, file), SUM);
    await assert.rejects(machine.downloadAsset({ url: at('/hop'), size: INSTALLER.length }, file, { tls }), (e) => e.code === 'EEXIST', 'never over a file there');
    const short = path.join(path.dirname(file), 'short.exe');
    assert.equal((await machine.downloadAsset({ url: at('/hop'), size: 10 }, short, { tls })).error, 'too large', 'never past the size the release gives');
    // GitHub's own answer read by type: JSON for a 200, nothing to judge for anything else.
    assert.deepEqual(Object.keys(await machine.githubGet('/repos/' + REPO + '/releases/latest', { tls: { ...tls, hostname: '127.0.0.1', port: 1, servername: 'localhost' } })), ['error'], 'no answer is an error to say, never a release');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

// ---------------------------------------------------------------- launch.js, the person's side

/**
 * The person's console's hands: whoami as `me`, schtasks /Run of their own control task (machine.js control run in
 * process with `win`'s hands and `net`), reg.exe as the record. The control tasks it ran are in `pending`.
 */
function personsHands({ me, root, win, net, groups = '' }) {
  const pending = [];
  const run = (exe, args, opts) => {
    const name = base(exe);
    if (name === 'whoami.exe') return args[0] === '/user' ? '"' + NAMES[me] + '","' + me + '"' : groups;
    if (name === 'schtasks.exe' && args[0] === '/Run') {
      const sid = args[args.indexOf('/TN') + 1].replace(/^\\AGMessage\\Control-/, '');
      pending.push(machine.run(['control', '--for', sid, '--machine', root, '--sys', SYS], { run: win.run, net }));
      return 'SUCCESS';
    }
    if (name === 'reg.exe') return win.run(exe, args, opts);
    throw new Error('the person\'s console ran what it does not: ' + name);
  };
  return { run, pending };
}

test('launch.js upgrade, as the person: the newest release offered, Enter installs it or a path typed is copied into their inbox and checked, a reason asked for when busy, the last outcome said first', async () => {
  const n = installed();
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  let busy = true;
  const { net } = hands({ download: async (a, file) => { fs.writeFileSync(file, INSTALLER); return { status: 200, bytes: INSTALLER.length }; } });
  net.busy = async () => (busy ? { answered: true, running: true, busy: true, words: '2 pages active' } : { answered: true, running: true, busy: false, words: 'quiet' });
  const p = personsHands({ me: BEN, root: n.root, win, net });
  const said = [];
  const asked = [];
  const typed = [];
  const prompt = async (q) => { asked.push(q); return typed.shift() || ''; };
  // Enter: the newest release; busy, so a reason is asked for, and it is asked again with it.
  typed.push('', 'the hall is empty');
  let code = await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 });
  assert.equal(code, 0, said.join('\n'));
  assert.deepEqual(said.slice(0, 2), ['Looking up AGMessage\'s newest release on GitHub…', 'The newest release is AGMessage 0.6.1 (' + NAME + ', 140 KB); this PC has AGMessage 0.6.0 (build 41).']);
  assert.equal(asked[0], 'Press Enter to install it, or type the full path of an installer you downloaded (AGMessage-Setup-<version>-unsigned.exe): ');
  assert.equal(said[3], 'Not upgraded: AGMessage is busy (2 pages active). Type a reason to upgrade it anyway.');
  assert.equal(asked[1], 'Reason (Enter leaves AGMessage as it is): ');
  assert.match(said.at(-1), /^Checked: AGMessage-Setup-0\.6\.1-unsigned\.exe is jammin808\/AGMessage's release v0\.6\.1/);
  assert.equal(planOf(win.handed[0]).force, 'the hall is empty');
  // The runner's last answer is said first the next time.
  fs.writeFileSync(path.join(n.root, 'machine', 'outbox', BEN, 'answer.json'), JSON.stringify({ v: 1, id: 'f'.repeat(24), verb: 'upgrade', final: true, at: Date.UTC(2026, 10, 7, 20, 31), code: 0, words: 'Upgraded: AGMessage 0.6.1 (build 52) is installed on this PC, and it answers.' }));
  fs.rmSync(path.join(n.root, 'machine', 'work'), { recursive: true });
  fs.mkdirSync(path.join(n.root, 'machine', 'work'));
  said.length = 0;
  busy = false;
  // A path typed (quoted, as a file dropped into the console is): copied into the inbox under its own name, then checked.
  const mine = path.join(n.top, 'Downloads', NAME);
  fs.mkdirSync(path.dirname(mine));
  fs.writeFileSync(mine, INSTALLER);
  typed.push('"' + mine + '"');
  code = await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 });
  assert.equal(code, 0, said.join('\n'));
  assert.match(said[0], /^Your last upgrade, on \d{4}-\d\d-\d\d at \d\d:\d\d: Upgraded: AGMessage 0\.6\.1 \(build 52\) is installed on this PC, and it answers\.$/);
  assert.ok(said.includes('Your installer is in your AGMessage inbox (SHA-256 ' + SUM + '): AGMessage\'s control task checks it against its release…'), said.join('\n'));
  assert.equal(sha256(fs.readFileSync(planOf(win.handed[1]).installer)), SUM);
  assert.ok(fs.existsSync(mine), 'the person\'s own file is theirs, left where it was');
  // A name that is not an installer's, or no full path: refused before anything is asked.
  for (const [line, re] of [['setup.exe', /is not a full path/], [path.join(n.top, 'setup.exe'), /^setup\.exe is not an AGMessage installer's name/]]) {
    typed.push(line);
    said.length = 0;
    assert.equal(await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 }), 2);
    assert.match(said.at(-1), re);
  }
  // No network: the look's words, and nothing more asked.
  const off = hands({ gh: github({ [LATEST]: { error: 'ENOTFOUND' } }) });
  const q = personsHands({ me: BEN, root: n.root, win, net: off.net });
  said.length = 0;
  asked.length = 0;
  assert.equal(await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: q.run, prompt, pollMs: 10 }), 2);
  assert.deepEqual([said.at(-1), asked], [machine.OFFLINE_WORDS, []]);
  // The newest release refused for itself alone (here not immutable): its words said, and an installer the person names
  // still checked against its own release, which is.
  const notYet = hands({ gh: github({ [LATEST]: ok(release((x) => { x.immutable = false; })), [TAG]: ok(release()) }) });
  const nw = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  fs.rmSync(path.join(n.root, 'machine', 'work'), { recursive: true });
  fs.mkdirSync(path.join(n.root, 'machine', 'work'));
  said.length = 0;
  asked.length = 0;
  typed.push(mine);
  assert.equal(await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: personsHands({ me: BEN, root: n.root, win: nw, net: notYet.net }).run, prompt, pollMs: 10 }), 0, said.join('\n'));
  assert.ok(said.some((t) => /^The release v0\.6\.1 of jammin808\/AGMessage is not immutable/.test(t)), said.join('\n'));
  assert.deepEqual(asked, ['Type the full path of an installer you downloaded (AGMessage-Setup-<version>-unsigned.exe), or press Enter to leave AGMessage as it is: ']);
  assert.match(said.at(-1), /^Checked: AGMessage-Setup-0\.6\.1-unsigned\.exe is jammin808\/AGMessage's release v0\.6\.1/);
  assert.equal(nw.handed.length, 1);
  assert.deepEqual(notYet.net.github.asked, [LATEST, TAG]);
  assert.deepEqual([...launch.FILE_REFUSED_TOO], ['offline', 'norepo', 'record'], 'the looks whose refusal a named file shares');
  // A last outcome not done is said with its installer's log's last lines, which the person cannot read where they are.
  fs.writeFileSync(path.join(n.root, 'machine', 'outbox', BEN, 'answer.json'), JSON.stringify({ v: 1, id: 'e'.repeat(24), verb: 'upgrade', final: true, at: Date.UTC(2026, 10, 7, 20, 31), code: 2, words: 'The installer of 0.6.1 ended with 1: it refused before it replaced a file.', logTail: ['Setup started.', 'Another AGMessage installer is running on this PC.', 7] }));
  const told = launch.lastOutcome({ machine: n.root, sys: SYS, run: p.run });
  assert.deepEqual(told.split('\n').slice(1), ['  The last lines of its installer\'s log:', '    Setup started.', '    Another AGMessage installer is running on this PC.']);
  // An inbox the account may not write into: whom to ask.
  const cal = personsHands({ me: CAL, root: n.root, win, net });
  typed.push(mine);
  said.length = 0;
  assert.equal(await launch.main(['upgrade', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: cal.run, prompt, pollMs: 10, fsImpl: { ...fs, openSync: (f, flags, ...rest) => { if (flags === 'w') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.openSync(f, flags, ...rest); } } }), 2);
  assert.match(said.at(-1), /^You have no AGMessage rights on this PC\. Ask LAPTOP\\ana, or an administrator\.$/);
  assert.equal(launch.intoInbox(fs, path.join(n.top, 'missing.exe'), path.join(n.top, 'x')).problem.endsWith('could not be read (ENOENT). Nothing was installed.'), true);
  assert.deepEqual(launch.typedPath('  "C:\\Users\\ana\\Downloads\\x.exe"  '), 'C:\\Users\\ana\\Downloads\\x.exe');
});

test('launch.js back, as the person: the build before named from the record, gone back to only once its number is typed, a reason asked for when busy', async () => {
  const n = installed({ semver: '0.6.1', ver: '0.6.52', previous: '0.6.41' });
  upgradebackup.make({ dataDir: path.join(n.root, 'data'), uploadDir: path.join(n.root, 'uploads'), build: '0.6.0+41.abc1234', stopAt: Date.now(), saved: true, reserve: 0 });
  fs.writeFileSync(path.join(n.app, 'installers', 'AGMessage-Setup-0.6.41-unsigned.exe'), 'x');
  const win = fakeWindows({ record: n.record, grants: { [BEN]: 'upgrade' } });
  const { net } = hands();
  const p = personsHands({ me: BEN, root: n.root, win, net });
  const said = [];
  const asked = [];
  const typed = [];
  const prompt = async (q) => { asked.push(q); return typed.shift() || ''; };
  assert.equal(await launch.main(['back', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 }), 0);
  assert.match(said[0], /^Go back from AGMessage 0\.6\.1 \(build 52\) to build 41\? AGMessage stops \(it saves\)/);
  assert.deepEqual([asked[0], said.at(-1), win.handed.length], ['Type 41 to go back, or press Enter to leave AGMessage as it is: ', 'Left as it is.', 0]);
  typed.push('40');
  assert.equal(await launch.main(['back', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 }), 2);
  assert.equal(said.at(-1), '"40" is not 41: left as it is.');
  typed.push('41');
  assert.equal(await launch.main(['back', '--machine', n.root, '--sys', SYS], { out: (t) => said.push(t), run: p.run, prompt, pollMs: 10 }), 0);
  assert.match(said.at(-1), /^Going back from AGMessage 0\.6\.1 \(build 52\) to build 41/);
  assert.equal(planOf(win.handed[0]).to, '0.6.41');
  // No build before: said, and nothing asked.
  const first = installed();
  said.length = 0;
  asked.length = 0;
  assert.equal(await launch.main(['back', '--machine', first.root, '--sys', SYS], { out: (t) => said.push(t), run: personsHands({ me: ANA, root: first.root, win: fakeWindows({ record: first.record }), net }).run, prompt }), 2);
  assert.deepEqual([said.at(-1), asked], ['This PC has no build of AGMessage before AGMessage 0.6.0 (build 41) to go back to: its install record names none (a first install, or a go back made already).', []]);
});
