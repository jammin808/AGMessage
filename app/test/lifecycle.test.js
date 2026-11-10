'use strict';
// The installer's life cycle in CI (the 0.6.0 plan's Part 6, unit U16), its pure parts on Linux: the builds its job makes
// from one payload (tools/lifecycle.js stage), the release order it asks first, the executed count it checks against the
// declared one (count, on a real TAP report), the life cycle's expectations (installer/test/expect.js) held to the words
// the installer's script, app/machine.js, app/lib/startup.js, app/lib/dataformat.js and the .bat say, the readers of
// what Windows answers, the plan's list held to the life cycle's tests, and the job itself. The life cycle runs on
// CI's elevated windows-2025 job alone (installer/test/lifecycle.test.js), and refuses anywhere else.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const startup = require('../lib/startup');
const dataformat = require('../lib/dataformat');
const wire = require('../lib/machinewire');
const { passwordProblem } = require('../lib/accounts');
const { compareBuilds, readStamp, compose, parseBuild } = require('../lib/version');
const L = require('../../tools/lifecycle.js');
const defines = require('../../tools/installer-defines.js');
const expect = require('../../installer/test/expect.js');
const hands = require('../../installer/test/hands.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ISS = h.readSource('installer/AGMessage.iss');
const BAT = h.readSource('start-agmessage.bat');
const MACHINE = h.readSource('app/machine.js');
const LIFECYCLE = h.readSource('installer/test/lifecycle.test.js');
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
const SYS = 'C:\\Windows\\System32';

/** A portable stage as the zip lays it, as far as the installer's defines read it: its package.json, a build.json stamped at `build`, and its files. */
function stageAt(dir, { version = '0.6.0', build = 41, channel = 'dev' } = {}) {
  for (const f of defines.NEEDED) { fs.mkdirSync(path.join(dir, ...f.split('/').slice(0, -1)), { recursive: true }); fs.writeFileSync(path.join(dir, ...f.split('/')), 'the stage\'s ' + f + '\n'); }
  fs.mkdirSync(path.join(dir, 'app', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'lib', 'version.js'), 'the stage\'s own\n');
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), JSON.stringify({ name: 'agmessage', version, agmessage: { runBase: 0 } }, null, 2) + '\n');
  const stamp = { version, build, installVersion: version.split('.').slice(0, 2).join('.') + '.' + build, commit: COMMIT, channel, builtAt: '2026-11-07T20:31:00.000Z', repo: 'jammin808/AGMessage' };
  fs.writeFileSync(path.join(dir, 'app', 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
  return dir;
}
const stampIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'app', 'build.json'), 'utf8'));
const fullOf = (dir) => { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'app', 'package.json'), 'utf8')); return compose(pkg.version, readStamp(stampIn(dir), pkg.version)); };
const runTool = (tool, args) => childProcess.spawnSync(process.execPath, [path.join(h.REPO, 'tools', tool), ...args], { encoding: 'utf8', timeout: 60000 });

/**
 * A Refuse(…) of the installer's script, by a fragment of its words, as it reads at run time (pure): its parts joined,
 * each literal with its doubled quotes read back and its {#Define}s filled from `values`, and each call or constant (an
 * InstallFolder(), an InstalledWords(), QuietAdminWords) taken from `values`.
 */
function issWords(fragment, values) {
  const line = ISS.split('\n').find((l) => l.includes('Refuse(') && l.includes(fragment));
  assert.ok(line, 'the installer refuses with words holding "' + fragment + '"');
  const arg = line.slice(line.indexOf('Refuse(') + 'Refuse('.length, line.lastIndexOf(');'));
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === '\'') { if (quoted && arg[i + 1] === '\'') { cur += '\'\''; i++; continue; } quoted = !quoted; }
    if (!quoted && arg.startsWith(' + ', i)) { parts.push(cur); cur = ''; i += 2; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    if (t.startsWith('\'')) return t.slice(1, -1).replace(/''/g, '\'').replace(/\{#(\w+)\}/g, (_, k) => { assert.ok(k in values, k + ' is given'); return values[k]; });
    assert.ok(t in values, t + ' is given');
    return values[t];
  }).join('');
}
const QUIET_ADMIN = /^ {2}QuietAdminWords = '(.*)';$/m.exec(ISS)[1].replace(/''/g, '\'');

// ---------------------------------------------------------------- the builds made from one payload

test('the build before and the build after: one build lower or higher, and at build 1 the highest build of the line below; none past what an installer carries', () => {
  assert.deepEqual(L.previousOf('0.6.0', 41), { version: '0.6.0', build: 40 });
  assert.deepEqual(L.previousOf('0.7.0', 1), { version: '0.6.0', build: 65535 });
  assert.deepEqual(L.previousOf('1.0.3', 1), { version: '0.255.0', build: 65535 });
  assert.equal(L.previousOf('0.0.4', 1), null);
  assert.equal(L.previousOf('0.6', 41), null);
  assert.deepEqual(L.nextOf('0.6.0', 41), { version: '0.6.0', build: 42 });
  assert.equal(L.nextOf('0.6.0', 65535), null);
  // Each is ordered against the build by the rule every installer reads: MAJOR.MINOR.BUILD.
  for (const [v, b] of [['0.6.0', 41], ['0.7.0', 1], ['1.0.3', 1]]) {
    const p = L.previousOf(v, b);
    assert.equal(compareBuilds(v + '-dev.' + b, p.version + '-dev.' + p.build), 1, v + ' build ' + b + ' is above the build before it');
  }
});

test('stage: a copy of the zip\'s stage stamped as the build before this one, or as the next build whose server ends at once; the installer\'s defines read each, and nothing else of the stage differs', () => {
  const root = tmp('agm-lc-stage-');
  const src = stageAt(path.join(root, 'stage'));
  const prev = L.stage({ from: src, to: path.join(root, 'previous'), as: 'previous' });
  assert.deepEqual(prev, { full: '0.6.0-dev.40+abcdef1', installVersion: '0.6.40' });
  const p = stampIn(path.join(root, 'previous'));
  assert.deepEqual([p.version, p.build, p.installVersion, p.commit, p.channel, p.repo], ['0.6.0', 40, '0.6.40', COMMIT, 'dev', 'jammin808/AGMessage'], 'its commit, channel and repository kept');
  assert.equal(defines.stageDefines(path.join(root, 'previous')).InstallVersion, '0.6.40', 'the installer\'s defines read it');
  assert.equal(fullOf(path.join(root, 'previous')), prev.full);
  assert.equal(fs.readFileSync(path.join(root, 'previous', 'app', 'server.js'), 'utf8'), fs.readFileSync(path.join(src, 'app', 'server.js'), 'utf8'), 'the same server');
  const broken = L.stage({ from: src, to: path.join(root, 'broken'), as: 'broken' });
  assert.deepEqual(broken, { full: '0.6.0-dev.42+abcdef1', installVersion: '0.6.42' });
  assert.equal(fs.readFileSync(path.join(root, 'broken', 'app', 'server.js'), 'utf8'), L.BROKEN_SERVER);
  assert.equal(defines.stageDefines(path.join(root, 'broken')).InstallVersion, '0.6.42');
  assert.deepEqual([compareBuilds(prev.full, fullOf(src)), compareBuilds(fullOf(src), broken.full)], [-1, -1], 'in their order');
  for (const f of ['README.txt', 'node/node.exe', 'app/lib/version.js']) {
    assert.equal(fs.readFileSync(path.join(root, 'broken', ...f.split('/')), 'utf8'), fs.readFileSync(path.join(src, ...f.split('/')), 'utf8'), f + ' is the payload\'s');
  }
  assert.deepEqual(stampIn(src).build, 41, 'the stage it copied is as it was');
  // At build 1 the build before is of the line below: its package.json names that line's version, its stamp too.
  const one = stageAt(path.join(root, 'one'), { version: '0.7.0', build: 1, channel: 'release' });
  const below = L.stage({ from: one, to: path.join(root, 'below'), as: 'previous' });
  assert.deepEqual(below, { full: '0.6.0+65535.abcdef1', installVersion: '0.6.65535' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'below', 'app', 'package.json'), 'utf8')).version, '0.6.0');
  assert.equal(defines.stageDefines(path.join(root, 'below')).Label, '0.6.0', 'a release\'s label');
  // Refused: a folder there already, a local build, another kind.
  assert.throws(() => L.stage({ from: src, to: path.join(root, 'previous'), as: 'previous' }), /is there already: a stage is laid only into a folder it makes$/);
  const local = stageAt(path.join(root, 'local'));
  fs.writeFileSync(path.join(local, 'app', 'build.json'), '{}');
  assert.throws(() => L.stage({ from: local, to: path.join(root, 'nope'), as: 'previous' }), /is a local build of 0\.6\.0 \(no stamp of its own in app\\build\.json\): it has no install version/);
  assert.throws(() => L.stage({ from: src, to: path.join(root, 'nope2'), as: 'later' }), /--as is "later": previous or broken/);
  assert.ok(!fs.existsSync(path.join(root, 'nope')) && !fs.existsSync(path.join(root, 'nope2')), 'nothing laid when refused');
  // Its command: the build it stamped on one line, and its codes.
  const cli = runTool('lifecycle.js', ['stage', '--from', src, '--to', path.join(root, 'cli'), '--as', 'previous']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), prev);
  assert.equal(runTool('lifecycle.js', ['stage', '--from', src, '--to', path.join(root, 'cli'), '--as', 'previous']).status, 2);
  assert.equal(runTool('lifecycle.js', ['stage', '--from', src, '--as', 'previous']).status, 64);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the build that does not start: its server ends at once with code 1, before it holds a folder or a port', () => {
  const dir = tmp('agm-lc-broken-');
  const file = path.join(dir, 'server.js');
  fs.writeFileSync(file, L.BROKEN_SERVER);
  const t0 = Date.now();
  const r = childProcess.spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 15000, 'at once');
  assert.deepEqual(fs.readdirSync(dir), ['server.js'], 'nothing written');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the release order

test('the release order: this build above the newest release by MAJOR.MINOR.BUILD, read from the build its notes name; a release whose notes name none of its own is refused, never passed over', () => {
  assert.equal(L.notesBuild('Build 0.5.1+51.89104d8. The zip\'s SHA-256 is in SHA256SUMS'), '0.5.1+51.89104d8', 'as the release job writes them');
  assert.equal(L.notesBuild('\uFEFFBuild 0.6.0+500.abcdef1.\n\nmore'), '0.6.0+500.abcdef1');
  assert.equal(L.notesBuild('What changed: Build 0.6.0+500.abcdef1.'), '', 'only on the first line, at its start');
  assert.equal(L.orderRefusal('0.6.0-dev.120+abcdef1', { tag: 'v0.5.1', build: '0.5.1+51.89104d8' }), '');
  assert.equal(L.orderRefusal('0.6.0-dev.120+abcdef1', {}), '', 'no release yet');
  assert.equal(L.orderRefusal('0.6.1+601.abcdef1', { tag: 'v0.6.0', build: '0.6.0+600.1234567' }), '');
  assert.match(L.orderRefusal('0.6.1-dev.3+abcdef1', { tag: 'v0.6.0', build: '0.6.0+600.1234567' }), /^this build, 0\.6\.1-dev\.3\+abcdef1 \(install version 0\.6\.3\), is not above the newest release, v0\.6\.0 \(0\.6\.0\+600\.1234567, install version 0\.6\.600\), by MAJOR\.MINOR\.BUILD: an AGMessage installed from that release would refuse this build's installer as older or the same/);
  assert.match(L.orderRefusal('0.6.0+600.abcdef1', { tag: 'v0.6.0', build: '0.6.0+600.1234567' }), /is not above the newest release/, 'the same install version is not above');
  for (const build of ['', '0.6.0-dev.600+1234567', '0.5.9+600.1234567', 'Build']) {
    assert.match(L.orderRefusal('0.6.1+601.abcdef1', { tag: 'v0.6.0', build }), /names no release build of its own version on its notes' first line/, JSON.stringify(build));
  }
  assert.match(L.orderRefusal('0.6.0-dev+abcdef1', {}), /has no install version \(a local build, or not a build\)/);
  const dir = tmp('agm-lc-order-');
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'Build 0.5.1+51.89104d8. The zip\'s SHA-256 is in SHA256SUMS.\n');
  assert.equal(runTool('lifecycle.js', ['order', '--build', '0.6.0-dev.120+abcdef1', '--last', 'v0.5.1', '--notes', notes]).status, 0);
  const refused = runTool('lifecycle.js', ['order', '--build', '0.5.1-dev.3+abcdef1', '--last', 'v0.5.1', '--notes', notes]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not above the newest release, v0\.5\.1/);
  assert.equal(runTool('lifecycle.js', ['order', '--build', '0.6.0-dev.120+abcdef1']).status, 0, 'none published yet');
  assert.equal(runTool('lifecycle.js', ['order', '--build', '0.6.0-dev.120+abcdef1', '--last', 'v0.5.1', '--notes', path.join(dir, 'none.txt')]).status, 1, 'notes that cannot be read stop it');
  assert.equal(runTool('lifecycle.js', ['order', '--build', '0.6.0-dev.120+abcdef1', '--last', 'v0.5.1']).status, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the executed count against the declared count

/** This process's environment for a test run of its own: without the test runner's word that it is a child, so it reports as CI's run does. */
const runnerEnv = (more = {}) => { const env = { ...process.env, ...more }; delete env.NODE_TEST_CONTEXT; return env; };
/** A real run of node:test over `files` ({name: text}) in a folder of its own: its TAP report. */
function tapOf(files) {
  const dir = tmp('agm-lc-tap-');
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), text);
  const tap = path.join(dir, 'run.tap');
  childProcess.spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination=' + tap, ...Object.keys(files)], { cwd: dir, encoding: 'utf8', timeout: 60000, env: runnerEnv() });
  const text = fs.readFileSync(tap, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return text;
}
const ok = (name) => "test('" + name + "', () => {});\n";

test('count: every test the files declare ran and passed by its name, read from a real TAP report; one that failed, did not load, was not declared or is uncounted refuses', () => {
  const A = "'use strict';\nconst test = require('node:test');\ntest.before(() => {});\n" + ok('the first, its \\\'quote\\\' and a # in it') + "test('the second', { timeout: 1000 }, () => {});\n";
  const B = "'use strict';\nconst test = require('node:test');\n" + ok('the third');
  const declared = (files) => Object.entries(files).map(([file, text]) => ({ file, ...L.declaredIn(text) }));
  const good = L.countJudged(declared({ 'a.test.js': A, 'b.test.js': B }), L.tapOf(tapOf({ 'a.test.js': A, 'b.test.js': B })));
  assert.deepEqual(good, { ok: true, words: 'The life cycle: 3 of 3 declared tests ran and passed (a.test.js 2, b.test.js 1); none failed, skipped, left to do or cancelled.' });
  assert.deepEqual(L.declaredIn(A).names, ['the first, its \'quote\' and a # in it', 'the second']);
  // A test that fails.
  const failing = B.replace("() => {}", "() => { throw new Error('no'); }");
  let j = L.countJudged(declared({ 'b.test.js': failing }), L.tapOf(tapOf({ 'b.test.js': failing })));
  assert.equal(j.ok, false);
  assert.match(j.words, /the summary is not every declared test run and passed: 0 of 1 declared tests passed \(tests 1, fail 1/);
  assert.match(j.words, /not run and passed once: the third/);
  assert.match(j.words, /failed: the third/);
  // A file that throws as it loads: none of its tests ran.
  const throws = "'use strict';\nthrow new Error('refused before anything is made');\n" + ok('never');
  j = L.countJudged(declared({ 'c.test.js': throws }), L.tapOf(tapOf({ 'c.test.js': throws })));
  assert.equal(j.ok, false);
  assert.match(j.words, /not run and passed once: never/);
  // A file the run was not given: its tests declared, none ran.
  j = L.countJudged(declared({ 'a.test.js': A, 'b.test.js': B }), L.tapOf(tapOf({ 'a.test.js': A })));
  assert.match(j.words, /2 of 3 declared tests passed/);
  // A run of a file the count was not given: ran and not declared.
  j = L.countJudged(declared({ 'b.test.js': B }), L.tapOf(tapOf({ 'a.test.js': A, 'b.test.js': B })));
  assert.match(j.words, /ran and not declared: the first, its 'quote' and a # in it \| the second/);
  // What would leave a declared test uncounted is refused as the file is read, whatever ran.
  for (const [text, why] of [
    ["test.skip('x', () => {});\n", /test\.skip, test\.todo, test\.only/],
    ["test('x', { skip: true }, () => {});\n", /given skip, todo or only/],
    ["test('x', (t) => { t.skip(); });\n", /skips itself or marks itself to do/],
    ["test('x', async (t) => { await t.test('y', () => {}); });\n", /nested in another/],
    ["describe('x', () => {});\n", /a suite/],
    ['test(NAME, () => {});\n', /whose name is not a string literal/],
  ]) assert.match(L.declaredIn(text).refused.join(' | '), why, text);
  j = L.countJudged([{ file: 'x.test.js', ...L.declaredIn(ok('x') + "test.todo('y');\n") }], L.tapOf(tapOf({ 'x.test.js': ok('x') })));
  assert.match(j.words, /^The life cycle did not all run: x\.test\.js: a test skipped, left to do or run alone/);
  assert.match(L.countJudged([], { counts: {}, passed: [], failed: [] }).words, /no test is declared/);
  // Its command, with the summary written.
  const dir = tmp('agm-lc-count-');
  for (const [n, text] of [['a.test.js', A], ['b.test.js', B]]) fs.writeFileSync(path.join(dir, n), text);
  fs.writeFileSync(path.join(dir, 'run.tap'), tapOf({ 'a.test.js': A, 'b.test.js': B }));
  const summary = path.join(dir, 'summary.md');
  const r = runTool('lifecycle.js', ['count', '--tap', path.join(dir, 'run.tap'), '--summary', summary, path.join(dir, 'a.test.js'), path.join(dir, 'b.test.js')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(summary, 'utf8'), /^### The installer's life cycle\n\nThe life cycle: 3 of 3 declared tests ran and passed/);
  assert.equal(runTool('lifecycle.js', ['count', '--tap', path.join(dir, 'run.tap'), path.join(dir, 'a.test.js')]).status, 1);
  assert.equal(runTool('lifecycle.js', ['count', '--tap', path.join(dir, 'none.tap'), path.join(dir, 'a.test.js')]).status, 2);
  assert.equal(runTool('lifecycle.js', ['count', path.join(dir, 'a.test.js')]).status, 64);
  assert.equal(runTool('lifecycle.js', ['tally']).status, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the life cycle\'s own files: every test a string literal, none skipped, to do or nested; every item of the plan\'s list proved by one of them, and none that proves no item', () => {
  const files = fs.readdirSync(path.join(h.REPO, 'installer', 'test')).filter((n) => n.endsWith('.test.js'));
  assert.deepEqual(files, ['lifecycle.test.js']);
  const d = L.declaredIn(LIFECYCLE);
  assert.deepEqual(d.refused, []);
  assert.equal(new Set(d.names).size, d.names.length, 'each name once');
  assert.ok(d.names.length >= 30, d.names.length + ' tests');
  const tests = new Set(expect.ITEMS.map((i) => i.test));
  for (const it of expect.ITEMS) if (it.test !== 'release') assert.ok(d.names.includes(it.test), 'the item "' + it.item + '" has its test');
  for (const n of d.names) assert.ok(tests.has(n), 'the test "' + n + '" proves an item of the plan\'s list');
  // The plan's own list (6-U.8, U16), item by item.
  const plan = h.readSource('docs/plan/0.6.0/PLAN.md');
  const row = plan.split('\n').find((l) => l.startsWith('| U16 | **the life cycle**'));
  for (const words of ['install', 'a downgrade and the same build refused with words', 'a portable copy on the port refused with words', 'a busy server refused without a reason', 'a silent server refused, naming its pid', 'a file that cannot be replaced rolls back', 'a new build that will not start is replaced by build−1, which answers', '`last-stop.json` written by the stop', 'removes it with `/REMOVEDATA`', 'another `/DIR=` refused', 'a junction or a folder another account owns', 'no `SeImpersonatePrivilege`', 'no secret in either task\'s XML', 'the installer\'s log holds no token or password', 'the watchdog\'s give-up leaves the task stopped', 'every installed file matches `SHA256SUMS.payload`', 'the import\'s refusals and verification', '`/ADMIN=` recorded in HKLM', 'the attestation covers the installer', 'stop-to-health across the upgrade timed and reported']) {
    assert.ok(row.includes(words), 'the plan\'s row names "' + words + '"');
  }
  assert.ok(expect.ITEMS.some((i) => i.item === 'the attestation covers the installer' && i.test === 'release'), 'the attestation is the release job\'s');
  // The tests go one after another, each leaving what the next begins from; the machine is refused before anything.
  assert.ok(LIFECYCLE.indexOf('placeRefusal()') < LIFECYCLE.indexOf('\ntest('), 'the place is asked before any test');
  assert.match(LIFECYCLE, /if \(refused\) throw new Error\('installer\/test\/lifecycle\.test\.js: ' \+ refused \+ '\. Nothing was made\.'\);/);
});

test('the life cycle refuses every machine but an elevated GitHub-hosted Windows runner with no AGMessage on it, before anything is made', () => {
  const env = { RUNNER_ENVIRONMENT: 'github-hosted', SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files' };
  const elevated = '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""\r\n';
  const asked = [];
  const ask = (record) => (exe, args) => {
    asked.push(path.win32.basename(exe) + ' ' + args.join(' '));
    if (/whoami\.exe$/i.test(exe)) return { code: 0, out: elevated };
    return { code: record ? 0 : 1, out: record ? '    Version    REG_SZ    0.6.41\r\n' : '' };
  };
  assert.equal(hands.placeRefusal({ env, platform: 'win32', exists: () => false, ask: ask(false) }), '');
  assert.deepEqual(asked, ['whoami.exe /groups /fo csv /nh', 'reg.exe query HKLM\\SOFTWARE\\AGMessage /reg:64'], 'each by its name in System32');
  assert.match(hands.placeRefusal({ platform: 'linux' }), /^the life cycle installs AGMessage on Windows: CI's elevated windows-2025 job runs it/);
  assert.match(hands.placeRefusal({ env: { ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, platform: 'win32', exists: () => false, ask: ask(false) }), /it is CI's, on a GitHub-hosted runner thrown away after the job, and this machine is not one \(RUNNER_ENVIRONMENT "self-hosted"\)/);
  assert.match(hands.placeRefusal({ env, platform: 'win32', exists: () => false, ask: () => ({ code: 0, out: '"BUILTIN\\Users","Alias","S-1-5-32-545",""' }) }), /runs elevated, as an installer does, and this process is not/);
  assert.match(hands.placeRefusal({ env, platform: 'win32', exists: () => false, ask: ask(true) }), /^AGMessage is installed on this machine \(HKLM\\SOFTWARE\\AGMessage\): the life cycle would upgrade and remove it/);
  assert.match(hands.placeRefusal({ env, platform: 'win32', exists: (d) => d === 'C:\\ProgramData\\AGMessage', ask: ask(false) }), /^C:\\ProgramData\\AGMessage is there: the life cycle begins with neither/);
  assert.match(hands.placeRefusal({ env: { ...env, SystemRoot: 'Windows' }, platform: 'win32', exists: () => false, ask: ask(false) }), /SystemRoot does not name a folder from its drive/);
  assert.deepEqual(hands.places({ ...env, ProgramW6432: 'C:\\Program Files' }), { sys: 'C:\\Windows\\System32', app: 'C:\\Program Files\\AGMessage', root: 'C:\\ProgramData\\AGMessage', menu: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\AGMessage' });
  // The file itself refuses as it loads, anywhere but its job: its run counts no test (count refuses it).
  const r = childProcess.spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(h.REPO, 'installer', 'test', 'lifecycle.test.js')], { encoding: 'utf8', timeout: 60000, env: runnerEnv({ AGM_LIFECYCLE: '' }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /# pass 0\n# fail 1\n/);
  // Off Windows it refuses for the platform; on CI's Windows test job (elevated, hosted, no AGMessage), for the plan it has none of.
  assert.match(r.stdout + r.stderr, process.platform === 'win32' ? /AGM_LIFECYCLE names no plan: the life cycle runs from CI's lifecycle job|the life cycle runs elevated, as an installer does/ : /the life cycle installs AGMessage on Windows/);
});

test('the life cycle\'s plan: every path a full Windows path from a drive, each build its installer and its payload\'s sums; anything else refused with words', () => {
  const b = (d) => ({ exe: 'D:\\a\\_temp\\lifecycle\\' + d + '\\AGMessage-Setup-0.6.0-dev.4_abcdef1-unsigned.exe', payload: 'D:\\a\\_temp\\lifecycle\\' + d + '\\SHA256SUMS.payload' });
  const good = { work: 'C:\\agm-lifecycle', logs: 'D:\\a\\_temp\\lifecycle\\logs', portable: 'D:\\a\\_temp\\lifecycle\\stage\\AGMessage', previous: b('previous'), current: b('current'), broken: b('broken') };
  assert.deepEqual(expect.planOf('\uFEFF' + JSON.stringify(good)), good, 'as PowerShell\'s ConvertTo-Json writes it');
  for (const [bad, why] of [
    ['not json', /is not JSON/],
    ['[]', /is not an object/],
    [JSON.stringify({ ...good, work: 'agm-lifecycle' }), /work is not a full Windows path/],
    [JSON.stringify({ ...good, logs: '/tmp/logs' }), /logs is not a full Windows path/],
    [JSON.stringify({ ...good, broken: undefined }), /names no broken build/],
    [JSON.stringify({ ...good, current: { ...b('current'), exe: 'C:\\x\\setup.exe' } }), /current\.exe is not an AGMessage installer/],
    [JSON.stringify({ ...good, previous: { ...b('previous'), payload: 'C:\\x\\"sums"' } }), /previous\.payload is not a full Windows path/],
  ]) assert.throws(() => expect.planOf(bad), why);
});

// ---------------------------------------------------------------- the words the life cycle expects, held to the code

test('the words the life cycle expects are the installer\'s: no /ADMIN=, another folder, a downgrade, the same build, and the lines its upgrade, its way back and its rolled-back install write', () => {
  assert.equal(expect.WORDS.quietAdmin(), issWords('QuietAdminWords + \' Nothing was changed.\'', { QuietAdminWords: QUIET_ADMIN }));
  assert.equal(expect.WORDS.otherDir('C:\\Program Files\\AGMessage'), issWords('/DIR= names another folder', { 'InstallFolder()': 'C:\\Program Files\\AGMessage' }));
  const installed = expect.buildOf('0.6.0-dev.42+abcdef1');
  const older = expect.buildOf('0.6.0-dev.41+abcdef1');
  assert.equal(expect.WORDS.newer({ installed, installer: older }), issWords('is newer than this installer', { 'InstalledWords()': expect.named(installed), SemVer: older.semver, Build: String(older.build) }));
  assert.equal(expect.WORDS.newer({ installed, installer: older }), 'AGMessage 0.6.0 (build 42) is newer than this installer\'s 0.6.0 (build 41): uninstall it first to go back. Nothing was changed.');
  assert.equal(expect.WORDS.same({ installed }), issWords('is installed already', { 'InstalledWords()': expect.named(installed) }));
  // The installer's InstalledWords() is the record's SemVer and its install version's build: what named() says.
  assert.match(ISS, /Result := 'AGMessage ' \+ InstalledSemVer \+ ' \(build ' \+ BuildOf\(InstalledVersion\) \+ '\)';/);
  // Its log's lines: a refusal, a machine.js answer, a rolled-back install, the way back.
  assert.match(ISS, /Log\('refused: ' \+ Words\);/);
  assert.match(ISS, /Log\('machine\.js ' \+ Verb \+ ' answered ' \+ IntToStr\(Result\) \+ ': ' \+ Words\);/);
  assert.ok(ISS.includes("Log('" + expect.WORDS.startedAgain() + "');"));
  assert.ok(ISS.includes("Log('" + expect.WORDS.wayBack() + "' + Why);"));
  assert.ok(ISS.includes("Log('the kept installer of build ' + BuildOf(InstalledVersion) + ' ended with ' + IntToStr(Code));"));
  assert.equal(expect.WORDS.keptEnded(installed), 'the kept installer of build 42 ended with 0');
  // The way back's own exit code, 3, is the one the life cycle reads for a build that did not start.
  assert.match(ISS, /function GetCustomSetupExitCode\(\): Integer;\nbegin\n {2}if SetupFailed then Result := 3 else Result := 0;\nend;/);
});

test('the words the life cycle expects are machine.js\'s own, as its commands say them: a folder there before the install, a portable copy, a busy AGMessage, a silent port, the upgrade\'s stop, an import on a node that served', async () => {
  const root = path.join(tmp('agm-lc-words-'), 'AGMessage');
  fs.mkdirSync(root);
  const noRecord = () => { throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: 'none' }); };
  assert.throws(() => machine.prepare({ '--machine': root, '--sys': SYS }, { run: noRecord }), (e) => e.refused === true && e.words === expect.WORDS.notOurs(root));
  // The root an uninstall kept (the record's Kept mark) is taken past that first check, and then refused as a link, or
  // as another account's: the words the life cycle's two kept-root tests expect.
  const kept = (owner) => (exe, args) => {
    if (/reg\.exe$/i.test(exe) && args[0] === 'query' && args[1] === machine.HKLM) return '    Kept    REG_SZ    ' + root + '\r\n    Port    REG_DWORD    0xbcf\r\n';
    if (/powershell\.exe$/i.test(exe) && args[args.length - 1] === machine.PS_OWNER) return JSON.stringify({ sddl: owner }) + '\r\n';
    throw new Error('the stand-in was asked what it does not know: ' + path.win32.basename(exe) + ' ' + args.join(' '));
  };
  const asLink = { mkdirSync: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }, lstatSync: () => ({ isDirectory: () => false, isSymbolicLink: () => true }) };
  assert.throws(() => machine.prepare({ '--machine': root, '--sys': SYS }, { run: kept('O:BAG:SYD:PAI'), fsImpl: asLink }), (e) => e.refused === true && e.words === expect.WORDS.notReal(root));
  const other = 'S-1-5-21-1111111111-2222222222-3333333333-1004';
  assert.throws(() => machine.prepare({ '--machine': root, '--sys': SYS }, { run: kept('O:' + other + 'G:SYD:PAI(A;OICI;FA;;;SY)') }), (e) => e.refused === true && e.words === expect.WORDS.ownedBy(root, other));
  const opts = { '--machine': root, '--port': '3023' };
  // A portable copy: no token here to prove anything with, and its health says it runs from a folder.
  const portable = { version: '0.6.0', build: '0.6.0-dev.41+abcdef1', runs: 'portable' };
  await assert.rejects(machine.preinstallCheck(opts, { net: { portAnswers: async () => true, health: async () => portable } }), (e) => e.words === expect.WORDS.portable({ version: '0.6.0', port: 3023 }));
  fs.mkdirSync(path.join(root, 'token'));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), 'a1b2c3d4e5f60718');   // secret-scan: fixture
  await assert.rejects(machine.preinstallCheck(opts, { net: { portAnswers: async () => true, hello: async () => ({ ok: false, why: 'silent' }), pid: () => 4120 } }), (e) => e.words === expect.WORDS.silent({ port: 3023, pid: 4120 }));
  assert.equal(expect.ANSWER_S * 1000, wire.ANSWER_MS);
  const line = { active: 1, takes: 0, help: 0, countdowns: 0, seats: 0, screens: 0, sockets: 1 };
  await assert.rejects(machine.preinstallCheck(opts, { net: { portAnswers: async () => true, hello: async () => ({ ok: true, build: portable.build }), busy: async () => ({ answered: true, running: true, busy: true, words: '1 page active', line }) } }), (e) => e.busy === true && expect.WORDS.busy.test(e.words) && e.words.match(expect.WORDS.busy).groups.counts === '1 page active');
  // The upgrade's stop, saved and backed up, as its record says it (the server's record names the backup inside the data
  // folder, as test/machine.test.js holds against a real server's stop).
  const backup = 'backups/upgrade-0.6.0-dev.41+abcdef1-20261107T203100Z-a1b2c3';
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'last-stop.json'), JSON.stringify({ at: Date.now() + 60000, build: portable.build, saved: true, backup, backupMs: 120 }));
  const stopped = await machine.upgradeStop({ ...opts, '--by': 'the installer' }, { net: { estimate: () => ({ copyBytes: 0, free: null }), stop: async () => ({ ok: true, status: 200, json: { stopping: true } }), portAnswers: async () => false } });
  assert.match(stopped.words, expect.WORDS.upgradeStopped);
  assert.equal(stopped.words.match(expect.WORDS.upgradeStopped).groups.backup, backup);
  assert.match(machine.servedWords(['1 hall', '3 messages', '1 account']), expect.WORDS.served);
  // The take's words, as its source writes them.
  assert.ok(MACHINE.includes("words: 'Imported and verified: ' + countsWords(f) + ', counted alike; every sealed value opens (' + f.sealed.total + '); the certificate\\'s fingerprint is unchanged; the audit chain checks (' + (f.chain.entries === 1 ? '1 entry' : f.chain.entries + ' entries')"));
  assert.match('Imported and verified: 1 hall, 3 messages, 1 account and 0 screens, counted alike; every sealed value opens (2); the certificate\'s fingerprint is unchanged; the audit chain checks (12 entries).', expect.WORDS.imported);
  // A control task's answers: a grant, a stop that saved, a start.
  for (const piece of ["'Given: ' + target.name + ' may now ' + rightsWords(now) + ' AGMessage on this PC.'", "'Stopped, saved at ' + clock(rec.at) + '.'", "words: 'Started.' + ev.why"]) assert.ok(MACHINE.includes(piece), piece);
  assert.match('Given: RUNNER\\agmlifecycle may now start, stop AGMessage on this PC.', expect.WORDS.granted);
  assert.match('Stopped, saved at 20:31.', expect.WORDS.stopped);
  assert.ok(h.readSource('app/supervise.js').includes("log('giving up: ' + d.reason);"));
  assert.match('2026-11-07T20:31:00.000Z giving up: 7 crashes in 10 minutes', expect.WORDS.gaveUp);
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

test('the words the life cycle expects on an installed PC are the server\'s and the .bat\'s: the installed node holding the port, another copy holding it, a folder moved by an import', () => {
  const installed = { version: '0.6.0', build: '0.6.0-dev.41+abcdef1', runs: 'task' };
  const copy = { version: '0.6.0', build: '0.6.0-dev.41+abcdef1', runs: 'portable' };
  assert.equal(expect.WORDS.batInstalled({ ...installed, port: 3023 }), startup.portHolderWords(installed, { port: 3023, runs: 'portable' }));
  assert.equal(expect.WORDS.anotherCopy({ ...copy, port: 3023 }), startup.portHolderWords(copy, { port: 3023, runs: 'task' }));
  assert.match(dataformat.movedRefusal({ state: 'moved', at: Date.now(), build: '0.6.0-dev.41+abcdef1' }, { dataDir: 'C:\\agm\\AGMessage\\app\\data' }), expect.WORDS.moved);
  // The banner the .bat says from the install record's SemVer, and its words for a start the server refused (code 3).
  assert.ok(BAT.includes('  echo   AGMessage %%c is installed on this PC and starts with Windows.\n'), 'the banner');
  assert.equal(expect.WORDS.batBanner('0.6.0'), 'AGMessage 0.6.0 is installed on this PC and starts with Windows.');
  assert.ok(BAT.includes('echo   ' + expect.WORDS.batEnd() + ' Press any key to close this window.\n'));
});

// ---------------------------------------------------------------- how what Windows answers is read

test('an Inno Setup log read: each message without its time, a line with none carried on the one before, the refusals and machine.js\'s answers; UTF-8 or UTF-16 as its mark says', () => {
  const text = [
    '2026-11-07 20:31:00.101   Log opened. (Time zone: UTC+00:00)',
    '2026-11-07 20:31:00.250   machine.js preinstall-check answered 3: AGMessage is busy (1 page active): type a reason to go on anyway, or wait.',
    '2026-11-07 20:31:01.000   refused: AGMessage on port 3023 (pid 4120) does not answer within 5 s: it reads as busy, and it cannot be stopped at loopback, so the install cannot go on. Nothing was changed.',
    '2026-11-07 20:31:02.000   the way back: AGMessage did not start',
    'the last lines of its log: | x',
    '2026-11-07 20:31:03.000   the kept installer of build 41 ended with 0',
    '',
  ].join('\r\n');
  const log = expect.innoLog(expect.logText(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')])));
  const fields = (x) => ({ messages: x.messages, refused: x.refused, machine: x.machine });
  assert.deepEqual(fields(log), fields(expect.innoLog(expect.logText(Buffer.from('\uFEFF' + text, 'utf8')))), 'the same read from either encoding');
  assert.equal(log.messages.length, 5);
  assert.equal(log.messages[3], 'the way back: AGMessage did not start\nthe last lines of its log: | x');
  assert.deepEqual(log.refused, [expect.WORDS.silent({ port: 3023, pid: 4120 }) + ' Nothing was changed.']);
  assert.deepEqual(log.machine, [{ verb: 'preinstall-check', code: 3, words: 'AGMessage is busy (1 page active): type a reason to go on anyway, or wait.' }]);
  assert.ok(log.says(expect.WORDS.keptEnded({ build: 41 })) && log.says(expect.WORDS.wayBack()));
  assert.ok(!log.says('the install did not finish'));
});

test('the install record, an access list, the payload\'s sums, a snapshot, the machine\'s events and a secret read as the life cycle reads them', () => {
  const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\AGMessage\r\n    InstallDir    REG_SZ    C:\\Program Files\\AGMessage\r\n    Version    REG_SZ    0.6.41\r\n    Previous    REG_SZ    \r\n    Port    REG_DWORD    0xbcf\r\n';
  assert.deepEqual(expect.recordOf(reg), { InstallDir: 'C:\\Program Files\\AGMessage', Version: '0.6.41', Previous: '', Port: '3023' });
  // The machine folder's own grants (SYSTEM, Administrators, the task's SID, the admin's read) give the four no entry.
  assert.deepEqual(expect.forbiddenOn('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;S-1-5-87-1-2-3-4-5)(A;OICI;FR;;;S-1-5-21-1-2-3-1001)'), []);
  const named = expect.forbiddenOn('O:BAG:SYD:AI(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;OICIIOID;SDGXGWGR;;;AU)(D;;FA;;;WD)(A;OICIIO;GA;;;CO)(A;;FR;;;S-1-5-32-545)');
  assert.deepEqual(named.map((x) => x.name), ['Users', 'Authenticated Users', 'Everyone', 'CREATOR OWNER'], 'allow or deny, inherited or not, each once');
  assert.deepEqual(expect.FORBIDDEN, ['S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', 'S-1-3-0']);
  assert.equal(expect.forbiddenOn('D:(A;;FA;;)').length, 1, 'an entry it cannot read counts as one');
  const payload = expect.payloadOf(['a'.repeat(64) + '  app/server.js', 'b'.repeat(64) + '  node/node.exe', 'not a line', ''].join('\r\n'));
  assert.deepEqual([...payload.keys()], ['app/server.js', 'node/node.exe']);
  const laid = new Map([['app/server.js', 'a'.repeat(64)], ['node/node.exe', 'c'.repeat(64)], ['unins000.exe', 'd'], ['unins000.dat', 'e'], ['installers/AGMessage-Setup-0.6.41-unsigned.exe', 'f'], ['app/data/settings.json', 'g'], ['installers/other.exe', 'h']]);
  assert.deepEqual(expect.againstPayload(laid, payload), { wrong: ['node/node.exe (another SHA-256)'], strays: ['app/data/settings.json', 'installers/other.exe'] });
  assert.deepEqual(expect.againstPayload(new Map([['app/server.js', 'a'.repeat(64)]]), payload).wrong, ['node/node.exe (missing)']);
  const before = new Map([['a', { size: 1, sha: 'x' }], ['b', { size: 2, sha: 'y' }], ['c', { size: 3, sha: 'z' }]]);
  const after = new Map([['a', { size: 1, sha: 'x' }], ['b', { size: 2, sha: 'w' }], ['d', { size: 4, sha: 'v' }]]);
  assert.deepEqual(expect.snapshotDiff(before, after), { added: ['d'], changed: ['b'], removed: ['c'] });
  const secrets = [{ label: 'a token', value: 'A1B2C3D4E5F60718' }, { label: 'a password', value: 'the life cycle x1' }, { label: 'too short', value: 'abc' }];   // secret-scan: fixture
  assert.deepEqual(expect.secretsIn('…token a1b2c3d4e5f60718 and abc…', secrets), ['a token'], 'by value, case aside; the labels, never the values');
  assert.deepEqual(expect.secretsIn('', secrets), []);
  // The server task's and a control task's definitions keep no password of their own; one that logs on by one does.
  const node = 'C:\\Program Files\\AGMessage\\node\\node.exe';
  assert.ok(!expect.STORED_PASSWORD.test(machine.serverTaskXml({ node, launch: 'C:\\Program Files\\AGMessage\\app\\launch.js', data: 'C:\\d', uploads: 'C:\\u', keys: 'C:\\k', logs: 'C:\\l', token: 'C:\\t', events: 'C:\\e', port: 3023 })));
  assert.ok(!expect.STORED_PASSWORD.test(machine.controlTaskXml({ sid: 'S-1-5-21-1-2-3-1001', node, script: 'C:\\Program Files\\AGMessage\\app\\machine.js', machine: 'C:\\ProgramData\\AGMessage', sys: SYS })));
  assert.ok(expect.STORED_PASSWORD.test('<Principal><UserId>ben</UserId><LogonType>Password</LogonType></Principal>'));
  const lines = '{"seq":1,"kind":"machine.admin","by":{"sid":"S-1-5-21-1"},"for":{"sid":"S-1-5-21-1"}}\n{"seq":2,"kind":"machine.st';
  assert.deepEqual(expect.eventsOf(lines).map((e) => e.kind), ['machine.admin'], 'a line being written is not an event');
  assert.equal(expect.buildOf('0.6.0-dev.41+abcdef1 \0\0').installVersion, '0.6.41', 'a version resource\'s padding cut');
  assert.equal(expect.buildOf('0.6.0-dev+abcdef1'), null, 'a local build makes no installer');
  assert.deepEqual(parseBuild(expect.buildOf('0.6.0+41.abcdef1').full).channel, 'release');
});

test('the standard account\'s probe: Windows\' refusal of its logon read from schtasks\' words or its task\'s result, and nothing else taken for one; its first line written before it reads its plan, its bounds the plan\'s, its end said however it ends', () => {
  // Task Scheduler's results, signed as schtasks prints them or not: a logon refused is lab 7's, anything else the life cycle's to fail on.
  for (const [code, words] of [[0x8007052E, /user name or password is incorrect \(0x8007052E\)$/], [0x80070569, /\(Log on as a batch job\) \(0x80070569\)$/], [0x80070564, /logon type a task runs with \(0x80070564\)$/], [0x8004130F, /SCHED_E_ACCOUNT_INFORMATION_NOT_SET.*\(0x8004130F\)$/]]) {
    assert.match(expect.logonRefused({ lastResult: code | 0 }), words, 'signed');
    assert.equal(expect.logonRefused({ lastResult: code }), expect.logonRefused({ lastResult: code | 0 }), 'unsigned');
  }
  for (const lastResult of [0, 1, 0x80070005 | 0, 0x41303, 0x800710E0 | 0, null, 'x']) assert.equal(expect.logonRefused({ lastResult }), '', 'not a logon refused: ' + lastResult);
  assert.deepEqual(Object.keys(expect.LOGON_REFUSED).map(Number).map((n) => n.toString(16)), ['8004130f', '8007052e', '80070564', '80070569']);
  for (const w of ['ERROR: The user name or password is incorrect.', 'ERROR: Logon failure: the user has not been granted the requested logon type at this computer.', 'ERROR: Logon failure: unknown user name or bad password.']) assert.match(expect.logonRefused({ words: w }), /^Windows refused to register the task for the account's logon \("/, w);
  for (const w of ['ERROR: The task XML contains a value which is incorrectly formatted or out of range.', 'ERROR: Access is denied.', 'ERROR: No mapping between account names and security IDs was done.', '']) assert.equal(expect.logonRefused({ words: w }), '', w);
  assert.deepEqual([expect.resultWords(0x8007052E | 0), expect.resultWords(0x41303), expect.resultWords(null)], ['0x8007052E', '0x00041303', 'none']);
  // Once the life cycle gave the account "Log on as a batch job" and read it back, a batch logon refused is its own
  // failure, never lab 7's: only a refusal by policy, or of another kind, is the runner's.
  // The account was made with the very password schtasks is given, so a password refused is the life cycle's own fault
  // too: only a policy that keeps no password stays the runner's.
  for (const code of [0x80070569, 0x80070564, 0x8007052E]) assert.equal(expect.logonRefused({ lastResult: code | 0, granted: true }), '', 'granted: 0x' + code.toString(16));
  assert.match(expect.logonRefused({ lastResult: 0x8004130F | 0, granted: true }), /a policy forbids storing it/, 'a policy that keeps no password is still the runner\'s');
  for (const w of ['ERROR: Logon failure: the user has not been granted the requested logon type at this computer.', 'ERROR: The user name or password is incorrect.']) assert.equal(expect.logonRefused({ words: w, granted: true }), '', w);
  assert.deepEqual([expect.BATCH_REFUSED.map((n) => n.toString(16)), expect.POLICY_REFUSED.map((n) => n.toString(16))], [['80070564', '80070569'], ['8004130f']]);
  assert.match(expect.BATCH_REFUSED_WORDS.exec('ERROR: Logon failure: the user has not been granted the requested logon type at this computer.')[0], /requested logon type/);
  // The life cycle's test: the account's readback first (a deny by policy is lab 7's; a grant that did not hold fails,
  // named), the registration's warning kept, and a task that wrote no line said with Task Scheduler's own why.
  assert.match(LIFECYCLE, /let lab7 = logon\.deny\.length \? 'Windows denies the account a batch logon by policy/);
  assert.match(LIFECYCLE, /if \(!lab7\) assert\.ok\(logon\.batch && logon\.enabled && !logon\.mustChange, 'the standard account can be logged on by a task/);
  assert.match(LIFECYCLE, /lab7 = expect\.logonRefused\(\{ words: e\.message, granted: true \}\);/);
  assert.match(LIFECYCLE, /lab7 = expect\.logonRefused\(\{ lastResult: s\.lastResult, granted: true \}\) \|\| expect\.logonRefused\(\{ lastResult: why\.code, granted: true \}\);/);
  assert.match(LIFECYCLE, /if \(!lab7\) assert\.fail\(scrub\('the probe\\'s task as ' \+ STD_NAME \+ ' wrote no line within ' \+ expect\.PROBE\.startMs \/ 1000 \+ ' s, and ' \+ \(refusedAnyway \? 'Windows refused its logon although "Log on as a batch job" was granted and read back' : 'Windows did not refuse its logon'\) \+ ' \(state ' \+ s\.state \+ ', last result ' \+ expect\.resultWords\(s\.lastResult\) \+ '\): ' \+ why\.words/, 'a refusal of what was granted is said as that');
  assert.match(LIFECYCLE, /'; its logon as read: ' \+ JSON\.stringify\(logon\)\)\);/, 'the account\'s logon as read back goes with the failure');
  const reads = LIFECYCLE.match(/logonRefused\(\{[^}]*\}\)/g) || [];
  assert.ok(reads.length >= 3 && reads.every((r) => r.includes('granted: true')), 'every reading of a refusal knows the right was granted: ' + reads.join(' | '));
  const hands = h.readSource('installer/test/hands.js');
  assert.match(hands, /return \{ name, sid: u\.sid, password, logon: readings\.logonOf\(u\), history: L\.history\(\) \};/, 'the account comes with its logon as read back, never its password in it');
  assert.match(hands, /return L\.register\(name, readings\.taskXml\(/, 'the probe\'s registration answers schtasks\' warning');
  // Its bounds: its longest run for the life cycle's two requests ends inside its task's time limit.
  assert.equal(expect.probeWorstMs(2), 2 * (expect.PROBE.runMs + expect.PROBE.answerMs));
  assert.ok(expect.probeWorstMs(2) + 60_000 <= expect.PROBE.limitMinutes * 60_000, 'the probe ends inside its task\'s limit');
  // The probe itself, run here: no schtasks.exe answers, so each run ends at its first request, and says so.
  const dir = tmp('agm-probe-');
  const probe = (plan) => {
    fs.rmSync(path.join(dir, 'ran.json'), { force: true });
    if (plan) fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan)); else fs.rmSync(path.join(dir, 'plan.json'), { force: true });
    const r = childProcess.spawnSync(process.execPath, [path.join(h.REPO, 'installer', 'test', 'as-account.js'), dir], { encoding: 'utf8', timeout: 30000 });
    return { code: r.status, ran: JSON.parse(fs.readFileSync(path.join(dir, 'ran.json'), 'utf8')) };
  };
  const user = os.userInfo().username;
  const plan = { task: '\\AGMessage-Lifecycle-Test\\none-' + process.pid, inbox: path.join(dir, 'request.json'), answer: path.join(dir, 'answer.json'), runMs: 5000, answerMs: 1000, requests: [{ id: 'a1', verb: 'stop', force: 'a reason' }, { id: 'a2', verb: 'start' }] };
  const one = probe(plan);
  assert.equal(one.code, 0, JSON.stringify(one.ran));
  assert.deepEqual([one.ran.user, one.ran.done, one.ran.error, one.ran.steps.map((s) => s.verb)], [user, true, undefined, ['stop']], 'its first request run, its end said');
  assert.ok(one.ran.steps[0].ran !== 0 && one.ran.steps[0].err, 'a /Run that did not run is said: ' + JSON.stringify(one.ran.steps[0]));
  assert.deepEqual(JSON.parse(fs.readFileSync(plan.inbox, 'utf8')), plan.requests[0], 'the request written into the inbox as it is');
  for (const [bad, why] of [[{ ...plan, runMs: 5 }, /the plan's runMs is not a bound of 1 s to 10 minutes/], [{ ...plan, answerMs: '180000' }, /the plan's answerMs is not a bound/], [null, /ENOENT|no such file/]]) {
    const r = probe(bad);
    assert.equal(r.code, 1);
    assert.deepEqual([r.ran.user, r.ran.done, r.ran.steps], [user, true, []], 'the account it ran as said, though it read no plan');
    assert.match(r.ran.error, why);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // What the job's log, its TAP report and its summary may carry: each secret the life cycle knows put as its label.
  const secrets = [{ label: 'a token', value: 'A1B2C3D4E5F60718' }, { label: 'a password', value: 'the life cycle (x1)+?' }, { label: 'too short', value: 'abc' }];   // secret-scan: fixture
  assert.equal(expect.scrubbed('token a1b2c3d4e5f60718, then "the life cycle (x1)+?" twice: the life cycle (x1)+? and abc', secrets), 'token <a token>, then "<a password>" twice: <a password> and abc');
  assert.equal(expect.scrubbed('nothing here', []), 'nothing here');
});

test('what the life cycle must keep across an upgrade, an uninstall that keeps the data and an install again, compared from the facts reader\'s answers', () => {
  const f = { halls: 1, rooms: 0, messages: 3, accounts: 1, screens: 0, sealed: { total: 2, open: 2 }, cert: { fp: 'aa:bb' }, key: { kid: 'k1' }, chain: { done: true, entries: 12, words: '' } };
  assert.deepEqual(expect.factsKept(f, { ...f, chain: { done: true, entries: 15, words: '' } }), [], 'the audit log only grows');
  assert.deepEqual(expect.factsKept(f, { ...f, messages: 2, sealed: { total: 2, open: 1 }, cert: { fp: 'cc' }, key: { kid: 'k2' }, chain: { done: false, entries: 9, words: 'broken at 9' } }), [
    'messages 3 became 2', 'sealed values 2 (2 open) became 2 (1 open)', 'the certificate\'s fingerprint changed', 'the machine key changed', 'the audit chain does not check to its end, or holds fewer entries (12 became 9: broken at 9)',
  ]);
});

test('the seed\'s first admin account: every passphrase the life cycle makes for it is one the server takes, the username and the name aside', () => {
  const { username, name } = expect.SEED_ACCOUNT;
  // Each is the fixed words and 12 random characters (9 bytes, base64url), as the life cycle makes them.
  for (const random of ['AAAAAAAAAAAA', 'zzzzzzzzzzzz', '-_-_-_-_-_-_', 'Q1w2E3r4T5y6']) {
    const p = expect.seedPassphrase(random);
    assert.equal(passwordProblem(p, { username, name }), null, 'the server takes ' + JSON.stringify(p));
  }
  // The rule the first run's seed broke: the name, spaces aside, is refused, so the words must hold neither.
  assert.equal(passwordProblem('the life cycle AAAAAAAAAAAA', { username, name }), 'The password may not contain your name.');
  assert.match(LIFECYCLE, /const passphrase = \(\) => \{ const p = expect\.seedPassphrase\(crypto\.randomBytes\(9\)\.toString\('base64url'\)\);/, 'the life cycle makes each passphrase from these words');
  assert.match(LIFECYCLE, /\{ token, username: expect\.SEED_ACCOUNT\.username, name: expect\.SEED_ACCOUNT\.name, password \}/, 'and its seed names this account');
});

// ---------------------------------------------------------------- the waits

test('every wait of the life cycle ends by itself, named: an installer at its bound and none beside it, the watch beside the upgrade, the asks of a seed, the stand-ins it starts and ends, and the long programs run without holding the loop', () => {
  const HANDS = h.readSource('installer/test/hands.js');
  // An installer is waited for at most 11 minutes, under the longest test's own bound, and its wait refused at once while
  // an earlier one still runs, so a hung installer fails its own test and the next ones by name, never beside another.
  const longest = Math.max(...[...LIFECYCLE.matchAll(/^test\('(?:[^'\\\n]|\\.)*', \{ timeout: ([\d_ *]+) \}, /gm)].map((m) => m[1].split('*').map((x) => Number(x.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1)));
  const installMs = /const install = \(exeFile, args, what, \{ ms = ([\d_ *]+) \} = \{\}\) => new Promise\(\(resolve, reject\) => \{\n\s+if \(installing\.size\) \{\n\s+reject\(new Error\('the installer run for '/.exec(HANDS);
  assert.ok(installMs, 'install refuses at once while an installer still runs');
  assert.ok(installMs[1].split('*').map((x) => Number(x.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1) < longest, 'an installer\'s wait ends under the longest test\'s bound');
  assert.match(HANDS, /const late = setTimeout\(\(\) => \{\n\s+const tail = [^\n]+\n\s+reject\(new Error\('the installer run for ' \+ what \+ ' \(pid ' \+ child\.pid \+ '\) had not ended '/, 'the installer\'s bound names what it ran for and its pid');
  assert.match(HANDS, /if \(child\.pid\) installing\.set\(child\.pid, what\);/);
  assert.match(HANDS, /const done = \(code\) => \{ clearTimeout\(late\); installing\.delete\(child\.pid\);/, 'an installer leaves the list only once it has ended');
  const installFn = HANDS.slice(HANDS.indexOf('const install = '), HANDS.indexOf('const uninstall = '));
  assert.doesNotMatch(installFn, /endTree|\.kill\(|taskkill/, 'an installer is never ended from here: Inno Setup\'s rollback does not run on a kill');
  assert.doesNotMatch(HANDS, /endTree\([^)]*installing/, 'nor is one still running');
  // The stand-ins the life cycle starts are refused, and ended, when they do not come up, and ended within 20 s when asked.
  assert.match(HANDS, /const silent = \(port = PORT, \{ ms = 60_000 \} = \{\}\) =>/);
  assert.match(HANDS, /close: \(\) => ended\(child, 20_000, \(\) => child\.kill\(\)\)/);
  assert.match(HANDS, /const hold = \(file, \{ ms = 60_000 \} = \{\}\) =>/);
  assert.match(HANDS, /release: \(\) => ended\(child, 20_000, \(\) => child\.stdin\.end\('\\n'\)\)/);
  // A portable copy that will not stop at loopback has its whole tree ended (its watchdog's server outlives the watchdog),
  // by taskkill's absolute path in System32.
  assert.match(HANDS, /const endTree = \(pid\) => run\(exe\('taskkill\.exe'\), \['\/PID', String\(pid\), '\/T', '\/F'\]/);
  assert.match(HANDS, /if \(code !== undefined\) return code;\n\s+endTree\(w\.child\.pid\);/);
  assert.doesNotMatch(HANDS, /w\.child\.kill\(\)/, 'never the watchdog alone');
  // The long programs (machine.js, the facts reader, launch.js, the uninstaller) run without holding the loop, so a test's
  // own bound ends its wait, and every call of them is awaited.
  assert.match(HANDS, /const machineJs = async \([^\n]*\n[^\n]*\n\s+const r = await runAsync\(/, 'machine.js runs without holding the loop');
  assert.match(HANDS, /const facts = async \([^\n]*\n\s+const r = await runAsync\(/, 'the facts reader runs without holding the loop');
  assert.match(HANDS, /const r = await runAsync\(path\.win32\.join\(p\.app, 'unins000\.exe'\)/);
  // An uninstaller that refused or failed is not waited for (run 115 waited out 6 minutes on each refusal).
  assert.match(HANDS, /const gone = r\.code === 0 \? await until\(isGone, ms\) : isGone\(\);/, 'only an uninstall that ended with 0 is waited for until the install is gone');
  assert.match(LIFECYCLE, /const launch = \(args\) => runAsync\(/);
  const calls = [...LIFECYCLE.matchAll(/(await )?(H\.facts\(|H\.machineJs\(|H\.control\(|launch\(\[)/g)];
  assert.ok(calls.length >= 20, 'the calls are found: ' + calls.length);
  assert.deepEqual(calls.filter((m) => !m[1]).map((m) => LIFECYCLE.slice(0, m.index).split('\n').length), [], 'every call of a long program is awaited (the lines that are not)');
  // The watch beside the upgrade ends with the installer however it ended, and at its own deadline at the latest; each ask
  // of a seed is answered within ASK_MS.
  assert.match(LIFECYCLE, /while \(seen\.installing && !seen\.healthAt && Date\.now\(\) < watchEnds\) \{/);
  assert.match(LIFECYCLE, /let r;\n\s+try \{ r = await H\.install\(B\.current\.exe, \[[^\n]*\], 'upgrade'\); \} finally \{\n\s+seen\.installing = false;\n\s+await watch;\n\s+\}/);
  const seedFn = LIFECYCLE.slice(LIFECYCLE.indexOf('async function seed('), LIFECYCLE.indexOf('\ntest.before('));
  assert.doesNotMatch(seedFn, /\bemit\(/, 'no ask of a seed waits on an answer without a bound');
  assert.equal((seedFn.match(/await answer\(s, '(join|message)', [^\n]*, ASK_MS\)/g) || []).length, 2);
  assert.equal((seedFn.match(/await api\([^\n]*ms: ASK_MS \}\)/g) || []).length, 2);
  assert.match(seedFn, /await fetch\(BASE \+ '\/api\/context', \{ [^\n]*signal: AbortSignal\.timeout\(ASK_MS\) \}\)/);
});

// ---------------------------------------------------------------- the job

/** A job of ci.yml, its lines from its name to the next job's. */
function job(ci, name) {
  const start = ci.indexOf('\n  ' + name + ':\n');
  assert.ok(start > 0, name + ' is a job');
  const rest = ci.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}
/** A job's steps, each from its "- " to the next. */
const stepsOf = (j) => j.slice(j.indexOf('\n    steps:\n') + 12).split(/\n {6}- /).map((x) => x.replace(/^ {6}- /, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').trim()).filter(Boolean);

test('the life cycle in CI: an elevated windows-2025 job after the installer\'s, on the image as it is (nothing turns Defender on), every action pinned by its commit, Inno Setup pinned as the installer job pins it, the release order asked, the two other builds made from the zip\'s stage, every test counted, its logs kept; the release waits for it', () => {
  const ci = h.readSource('.github/workflows/ci.yml');
  const lc = job(ci, 'lifecycle');
  assert.ok(ci.indexOf('\n  lifecycle:\n') > ci.indexOf('\n  installer:\n'), 'after the installer job');
  assert.match(lc, /\n {4}needs: \[package, installer\]\n {4}runs-on: windows-2025\n/);
  assert.ok(!/continue-on-error/.test(lc), 'a gate: nothing in it may fail and let it pass');
  for (const [, ref, comment] of lc.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)) assert.match(ref + comment, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, ref + ' is pinned by its commit');
  const steps = stepsOf(lc);
  assert.match(steps[0], /^uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+timeout-minutes: \d+\n\s+with:\n\s+persist-credentials: false$/);
  // On the image as it is, as the job that lived its hour was (runs 105, 109 and 110 lost every runner that ran on past
  // tools/defender-on.ps1: seen in run 110 about ten minutes after it, derived for the other two): no step runs it or
  // changes Defender in any other way, and the job says why.
  const defenderSteps = steps.filter((x) => /defender-o(n|ff)\.ps1|-MpPreference\b|DisableRealtimeMonitoring/i.test(x));
  assert.deepEqual(defenderSteps, [], 'no step of the life cycle turns Defender on or changes it');
  assert.match(steps[1], /^uses: actions\/setup-node@/, 'the checkout, then Node: nothing between them');
  assert.ok(!/tools[\\/]defender-on\.ps1/.test(lc.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'tools/defender-on.ps1 is run nowhere in the job');
  const why = lc.slice(lc.indexOf('\n    steps:\n'), lc.indexOf('actions/setup-node@'));
  assert.ok(/runs 105, 109 and 110/.test(why) && /as GitHub's image leaves them/.test(why), 'the job says why it runs on the image as it is: ' + why);
  // What CI no longer proves is said where the job runs: the installer under Defender is the show laptop's.
  const said = (text) => text.split('\n').filter((l) => /^\s*#/.test(l)).map((l) => l.replace(/^\s*# ?/, '')).join(' ');
  assert.match(said(why), /whether an install, an upgrade, a rollback, a go back and an uninstall pass under Defender is no longer tested in CI/);
  assert.match(said(why), /The installer under the laptop's own Defender is the show laptop's: lab 6's upgrade during a rehearsal and lab 7's Upgrade and Go back/);
  // The comment above the job says how it runs, as its steps do: never that Defender is turned (back) on first.
  const above = [];
  for (const l of ci.slice(0, ci.indexOf('\n  lifecycle:\n')).split('\n').reverse()) { if (/^ {2}#/.test(l)) above.unshift(l); else break; }
  const head = said(above.join('\n'));
  assert.ok(above.length > 3 && /^The installer's life cycle \(the 0\.6\.0 plan's Part 6, unit U16\)/.test(head), 'the comment above the job, read whole: ' + head);
  for (const turnedOn of [/\bback on first\b/i, /\bturned back on\b/i, /\bturns? (?:it |Defender )?on first\b/i, /\bDefender back on\b/i, /\bwith Defender's real-time monitoring turned\b/i, /\bwith Defender on\b/i]) {
    assert.doesNotMatch(head, turnedOn, 'the comment above the job never says Defender is turned on: ' + head);
  }
  assert.match(head, /on GitHub's image as it is, Defender's real-time monitoring off as the image leaves it/, 'it says the job runs on the image as it is');
  // Inno Setup as the installer job installs it: the same pin, the release API's digest and the publisher's signature.
  const pinOf = (text) => /\$pin = '([0-9A-F]{64})'/.exec(text)[1];
  const inno = steps.find((x) => x.startsWith('name: Inno Setup 7.1.0 (pinned)'));
  assert.equal(pinOf(inno), pinOf(job(ci, 'installer')));
  assert.match(inno, /if \("\$digest"\.Trim\(\) -ne "sha256:\$\(\$pin\.ToLowerInvariant\(\)\)"\) \{ throw/);
  assert.match(inno, /if \(\$signature\.Status -ne 'Valid'\) \{ throw/);
  // The release order, fail closed: a list or notes that cannot be read stop it.
  const order = steps.find((x) => x.startsWith('name: The release order'));
  assert.match(order, /gh release list --repo \$env:GITHUB_REPOSITORY --limit 1 --exclude-drafts --exclude-pre-releases --json tagName --jq '\.\[0\]\.tagName \/\/ ""'\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(order, /gh release view \$tag --repo \$env:GITHUB_REPOSITORY --json body --jq '\.body'[^\n]*\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(order, /node tools\/lifecycle\.js order --build '\$\{\{ needs\.package\.outputs\.full \}\}' @last\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  // The two other builds from this build's payload, each stamped by tools/lifecycle.js and built by build-installer.ps1.
  const builds = steps.find((x) => x.startsWith('name: The build before this one, and one that does not start'));
  assert.match(builds, /foreach \(\$as in 'previous', 'broken'\) \{/);
  assert.match(builds, /node tools\/lifecycle\.js stage --from \$portable --to \$at --as \$as\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(builds, /\.\/installer\/build-installer\.ps1 -Stage \$at -Iscc \$env:ISCC -Out \$out\n/);
  assert.match(builds, /current = @\{ exe = \$setup\[0\]\.FullName; payload = \(Resolve-Path 'installer-dist\\SHA256SUMS\.payload'\)\.Path \}/, 'this build is the installer job\'s, the one a release ships');
  for (const k of ['work', 'logs', 'portable', 'previous', 'broken', 'current']) assert.ok(builds.includes(' ' + k + ' = '), 'the plan names ' + k);
  assert.match(builds, /\$plan \| ConvertTo-Json -Depth 4 \| Out-File -FilePath \$file -Encoding utf8NoBOM\n\s+"plan=\$file" >> \$env:GITHUB_OUTPUT$/);
  // The life cycle, one test after another, its TAP report counted against what its files declare; either failing fails the job.
  const run = steps.find((x) => x.startsWith('name: The life cycle (installer/test/*.test.js'));
  assert.match(run, /AGM_LIFECYCLE: \$\{\{ steps\.builds\.outputs\.plan \}\}/);
  const runLine = /node --test --test-concurrency=1 --test-force-exit --test-timeout=(\d+) --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap "--test-reporter-destination=\$tap" 'installer\/test\/\*\.test\.js'\n\s+\$ran = \$LASTEXITCODE\n/.exec(run);
  assert.ok(runLine, 'the life cycle runs one file at a time, ends once its last test and hook have whatever a hung one left (--test-force-exit), and bounds a test that names no bound of its own: ' + run);
  assert.match(run, /node tools\/lifecycle\.js count --tap \$tap --summary \$env:GITHUB_STEP_SUMMARY @files\n\s+\$counted = \$LASTEXITCODE\n\s+if \(\$ran -ne 0\) \{ throw[^\n]*\n\s+if \(\$counted -ne 0\) \{ throw/);
  // The life cycle's step holds every bound its tests and hooks declare, with ten minutes over for loading the file and
  // the count, so a run slow inside its tests' own bounds is never cut by the step with nothing said.
  const msOf = (e) => e.split('*').map((x) => Number(x.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
  const declared = [...LIFECYCLE.matchAll(/^test\('((?:[^'\\\n]|\\.)*)', \{ timeout: ([\d_ *]+) \}, /gm)].map((m) => ({ name: m[1], ms: msOf(m[2]) }));
  assert.equal(declared.length, L.declaredIn(LIFECYCLE).names.length, 'every test of the life cycle has its own bound');
  const hooks = (LIFECYCLE.match(/^test\.(?:before|after)\(/gm) || []).length;
  assert.equal((LIFECYCLE.match(/^\}, \{ timeout: HOOK_MS \}\);$/gm) || []).length, hooks, 'every hook has its bound');
  const declaredMs = declared.reduce((a, d) => a + d.ms, 0) + hooks * msOf(/^const HOOK_MS = ([\d_ *]+);$/m.exec(LIFECYCLE)[1]);
  // A test or hook added without a bound of its own is given the longest any test declares, never more.
  assert.equal(Number(runLine[1]), Math.max(...declared.map((d) => d.ms)), '--test-timeout is the longest bound a test declares');
  const stepMs = Number(/\n {8}timeout-minutes: (\d+)\n/.exec('\n' + run.split('\n').slice(1).join('\n') + '\n')[1]) * 60_000;
  assert.ok(declaredMs + 10 * 60_000 <= stepMs, 'the life cycle\'s tests and hooks declare ' + declaredMs / 60_000 + ' minutes, and its step allows ' + stepMs / 60_000);
  // The standard account's test waits out its probe: the first line, then the probe's longest run for its two requests.
  const std = declared.find((d) => d.name.startsWith('a local standard account given start and stop'));
  assert.ok(std && std.ms >= expect.PROBE.startMs + expect.probeWorstMs(2) + 3 * 60_000, 'the standard account\'s test outlasts its probe: ' + (std && std.ms));
  const keep = steps[steps.length - 1];
  assert.match(keep, /^uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n\s+if: always\(\)\n[\s\S]*name: agmessage-lifecycle-\$\{\{ github\.sha \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/lifecycle\/logs\n/);
  // Every step bounded, and all of them inside the job's bound.
  const bounds = steps.map((x) => { const m = /\n {8}timeout-minutes: (\d+)\n/.exec('\n' + x.split('\n').slice(1).join('\n') + '\n'); return m ? Number(m[1]) : null; });
  assert.ok(bounds.every((b) => Number.isInteger(b) && b > 0), 'every step has its own bound: ' + bounds);
  assert.ok(bounds.reduce((a, b) => a + b, 0) <= Number(/\n {4}timeout-minutes: (\d+)\n/.exec(lc)[1]), 'the steps end inside the job: ' + bounds);
  // A gate: the release publishes only once the life cycle passed.
  const release = job(ci, 'release');
  assert.match(release, /\n {4}needs: \[package, installer, lifecycle, readings\]\n/);
  assert.match(release, /&& needs\.lifecycle\.result == 'success' \}\}\n/);
});
