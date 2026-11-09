'use strict';
// The Windows evidence lane (the plan's Part 6, unit U7): the readings R1-R13 and the lab lines, each with its mark and
// what a miss means (tools/readings.js), judged only on what was measured and never holding the release; what the lane
// measures on the runner and what its stand-in tasks run (tools/readings-take.js); the CI job that takes them turns
// Defender back on for the take of the readings that need it alone and puts it back as the image left it right after,
// is pinned by commit, and feeds the release's notes without holding it; and the papers say the same marks. The lane
// itself runs on windows-2025 in CI; here every part of it that is not Windows' own is run, and on Windows the
// PowerShell it asks is run too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { performance } = require('perf_hooks');
const { spawn, spawnSync } = require('child_process');
const h = require('./helpers');
const zipmod = require('../lib/zip');
const busyLine = require('../lib/busy');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'tools', 'readings.js'));
const T = require(path.join(ROOT, 'tools', 'readings-take.js'));
const READINGS_JS = path.join(ROOT, 'tools', 'readings.js');
const TAKE_JS = path.join(ROOT, 'tools', 'readings-take.js');
const read = (rel) => h.readSource(path.join(ROOT, rel)).replace(/\r\n/g, '\n');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NOT_WINDOWS = process.platform === 'win32' ? false : 'the PowerShell the lane asks runs on Windows: CI\'s Windows job runs it at every push, and the lane on windows-2025';

const byId = (judged, id) => judged.readings.find((x) => x.id === id);
/** FILE_READ_DATA: what lets an account read a task's definition (tools/readings.js READ_DATA). */
const READ_DATA_RIGHT = 0x1;
const ON = { realtime: true, onAccess: true, mode: 'Normal', exclusions: [], processes: [], extensions: [] };
const DEFENDER_ON = { defender: { v: 1, after: ON, took: true, errors: [] }, defenderEnd: ON };
// The bundle's stamp, as tools/stamp-build.js writes it: health names it 0.6.0-dev.40+abc1234.
const STAMP = { version: '0.6.0', build: 40, installVersion: '0.6.40', commit: 'abc1234def0123456789abcdef0123456789abcd', channel: 'dev', builtAt: '2026-11-02T09:50:00Z' };
const raw = (readings, extra = {}) => ({ v: 1, at: '2026-11-02T10:00:00.000Z', runner: { image: 'win25 20261027.1' }, build: STAMP, ...DEFENDER_ON, readings, ...extra });

// The answers Windows gives, as the lane records them.
const PRIV_ALONE = '"Privilege Name","Description","State"\r\n"SeChangeNotifyPrivilege","Bypass traverse checking","Enabled"\r\n';
const PRIV_IMPERSONATE = PRIV_ALONE + '"SeImpersonatePrivilege","Impersonate a client after authentication","Enabled"\r\n"SeCreateGlobalPrivilege","Create global objects","Enabled"\r\n';
const TASK_SID = 'S-1-5-87-2312335432-65297056-3549082870-2589977271-250352331';
const SHOWSID = 'SUCCESS: The SID "' + TASK_SID + '" for the user name "AGMessage-Server" has been computed successfully.';
const WHO_USER = '"User Name","SID"\r\n"nt authority\\local service","S-1-5-19"\r\n';
const WHO_GROUPS = '"Group Name","Type","SID","Attributes"\r\n"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"NT TASK\\AGMessage-Server","Well-known group","' + TASK_SID + '","Enabled by default, Enabled group, Group owner"\r\n';
const R4_SERVED = { task: '\\AGMessage\\Server', showsid: SHOWSID, whoami: { user: WHO_USER, priv: PRIV_ALONE, groups: WHO_GROUPS }, env: { LOCALAPPDATA: 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local' }, homedir: 'C:\\Windows\\ServiceProfiles\\LocalService', served: { ok: true, ms: 912, build: '0.6.0-dev.40+abc1234' }, udp: { bound: true, sent: true, heard: true }, tunnel: { returned: true, ms: 5200 }, profile: { added: [], addedCount: 0, changed: ['NTUSER.DAT'], changedCount: 1, removed: 0 }, rule: { made: true, readback: 'Rule Name:                            AGMessage-readings-R4\r\nEnabled:                              Yes\r\nProtocol:                             TCP\r\nLocalPort:                            3124\r\nRemoteIP:                             LocalSubnet\r\nProgram:                              C:\\agm-readings\\payload\\x\\node\\node.exe\r\n' } };
// A pipe made with no security attributes (its default descriptor), under the task's token.
const PIPE_SDDL = 'O:' + TASK_SID + 'G:' + TASK_SID + 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + TASK_SID + ')(A;;FR;;;WD)(A;;FR;;;AN)';
// C:\ and %ProgramData% as a fresh Windows has them: Authenticated Users may add a folder at the root; Users may write in ProgramData.
const ROOT_SDDL = 'O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;SDGXGWGR;;;AU)(A;;LC;;;AU)S:(ML;OINPIO;NW;;;HI)';
const DATA_SDDL = 'O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;GA;;;CO)(A;OICI;0x1200a9;;;BU)(A;CI;0x116;;;BU)';

// ---------------------------------------------------------------- the register

test('the register: R1-R13 as the plan\'s U7 table names them (R3 retired, R3′ beside it), each with its mark and what a miss means; the lab lines 1-7', () => {
  const plan = read('docs/plan/0.6.0/PLAN.md');
  const section = plan.slice(plan.indexOf('**[#30]**'), plan.indexOf('**[#36]**'));
  const rows = section.split('\n').filter((l) => /^\s*\| R\d/.test(l)).map((l) => l.trim().replace(/^\|\s*|\s*\|$/g, '').split(/\s\|\s/));
  assert.deepEqual(rows.map((r) => r[0]), ['R1', 'R2', 'R3', 'R3′', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13'], 'the plan\'s table, as read');
  assert.deepEqual(R.READINGS.map((x) => x.id), rows.map((r) => r[0]), 'every reading, in the plan\'s order');
  for (const [id, what, mark, miss] of rows) {
    const x = R.READINGS.find((y) => y.id === id);
    assert.deepEqual([x.what, x.mark, x.miss], [what, mark, miss], id + ' says what the plan says');
  }
  assert.deepEqual(R.READINGS.filter((x) => x.retired).map((x) => x.id), ['R3']);
  assert.deepEqual(R.READINGS.filter((x) => x.defender).map((x) => x.id), ['R2', 'R9', 'R10'], 'the readings taken with Defender on');
  // The lab lines: each the plan's line word for word (its wrapped lines joined), its pass the one the line names, or
  // "recorded" where it names none.
  const labs = [];
  let cur = null;
  for (const line of section.slice(section.indexOf('**The lab lines.**')).split('\n')) {
    const m = /^\s*- (Lab \d+): (.*)$/.exec(line);
    if (m) { cur = { id: m[1], text: m[2] }; labs.push(cur); } else if (cur && /^\s{6,}\S/.test(line)) cur.text += ' ' + line.trim(); else cur = null;
  }
  assert.deepEqual(labs.map((l) => l.id), ['Lab 1', 'Lab 2', 'Lab 3', 'Lab 4', 'Lab 5', 'Lab 6', 'Lab 7'], 'the plan\'s lab lines, as read');
  assert.deepEqual(R.LABS.map((l) => l.id), labs.map((l) => l.id));
  const PASSES = { 'Lab 1': 'Serving after, sleeps recorded, no kill', 'Lab 2': 'no kill' };
  for (const l of labs) {
    const x = R.LABS.find((y) => y.id === l.id);
    assert.equal(x.what, l.text.replace(/\.$/, ''), l.id + ' says what the plan says');
    assert.equal(x.pass, PASSES[l.id] || 'recorded', l.id + '\'s pass is the plan\'s, or "recorded"');
    assert.ok(x.pass === 'recorded' || l.text.includes(x.pass), l.id + '\'s pass is in the plan\'s line');
  }
  // What this build cannot take would name the unit whose code it measures; what it stands in for, the unit that ends it.
  // None needs a unit now: U14 (#75) built the export, which R6 takes.
  assert.deepEqual(R.READINGS.filter((x) => x.needs).map((x) => x.id), [], 'no reading waits for a unit\'s code before it can be taken');
  // R1 waits for no unit (U8, the stop at loopback with the proof, is built); R3′ and R9 waited for U12 (#72), which is
  // built: the lane takes them now (the upgrade backup's time, and the server task's stop-saves).
  for (const id of ['R1', 'R3′', 'R9']) assert.equal(R.READINGS.find((x) => x.id === id).needs, undefined, id + ' waits for no unit');
  // R4, R7 and R12 took under a stand-in while U12 was not built; it is now, and their stand-in's settings are U12's.
  // U17 (#74) built the control tasks: R11 takes a real one, R8 reads its definition back and R13 runs as one does; U18
  // (#77) built the checked upgrade, whose words with no network R13 takes too.
  for (const id of ['R8', 'R11', 'R13']) assert.deepEqual([R.READINGS.find((x) => x.id === id).needs, R.READINGS.find((x) => x.id === id).later], [undefined, undefined], id + ' waits for no unit');
  // U13 (#73) built the installer: R5 reads its signature beside the two programs'; U14 (#75) the export, which R6 takes.
  assert.equal(R.READINGS.find((x) => x.id === 'R5').later, undefined, 'R5 no longer waits for U13');
  assert.deepEqual([R.READINGS.find((x) => x.id === 'R6').needs, R.READINGS.find((x) => x.id === 'R6').later], [undefined, undefined], 'R6 no longer waits for U14');
  for (const id of ['R4', 'R7', 'R12']) assert.equal(R.READINGS.find((x) => x.id === id).later, undefined, id + ' no longer waits for U12');
});

test('a reading that waits for a later unit is held to it: once that unit\'s code is in the tree, no reading may still wait for it', () => {
  // The app's own code (not its tests or pages), read once.
  const app = path.join(ROOT, 'app');
  const files = [...fs.readdirSync(app).filter((f) => f.endsWith('.js')).map((f) => path.join(app, f))];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.js')) files.push(path.join(d, e.name)); } };
  walk(path.join(app, 'lib'));
  const code = files.map((f) => h.readSource(f)).join('\n');
  const machine = fs.existsSync(path.join(app, 'machine.js')) ? h.readSource(path.join(app, 'machine.js')) : '';
  // Each unit's code as the plan names it: once it is there, the unit has landed.
  const LANDED = {
    U4: () => /last-stop\.json/.test(code),
    U8: () => /\/api\/machine\/(?:hello|busy|stop)/.test(code),
    U12: () => machine !== '',
    U13: () => fs.existsSync(path.join(ROOT, 'installer', 'AGMessage.iss')),
    U14: () => /forget-keys/.test(code),
    U17: () => /--for\b/.test(machine),
    // U18 adds machine.js upgrade (its own verb); the server already reads the rows its events become (U17's reader).
    U18: () => /VERBS = Object\.freeze\(\[[^\]]*'upgrade'/.test(machine),
  };
  let named = 0;
  for (const x of R.READINGS) {
    for (const words of [...(x.needs || []), ...(x.later || [])]) {
      const units = words.match(/U\d+/g) || [];
      assert.ok(units.length, x.id + ' names the unit it waits for: ' + words);
      for (const u of units) {
        named++;
        assert.ok(LANDED[u], 'the fence knows how to tell that ' + u + ' has landed');
        assert.equal(LANDED[u](), false, u + '\'s code is in the tree, and ' + x.id + ' still waits for it (' + words + '): add its step to the lane (tools/readings-take.js), and take it out of ' + x.id + '\'s needs or later');
      }
    }
  }
  // U12 (#72) landed, so R3′, R4, R7, R9 and R12 no longer wait; U13 (#73), so R5 reads the installer; U17 (#74), so R8,
  // R11 and R13 take its control tasks; U14 (#75), so R6 takes the export; and U18 (#77), so R13 takes its words with no
  // network: no reading waits for a unit now.
  assert.equal(named, 0, 'no reading waits for a unit\'s code');
  for (const u of Object.keys(LANDED)) assert.equal(LANDED[u](), true, u + '\'s code is in the tree');
  // The fence tells U18's own verb from the rows its events become, which the server read before it landed.
  assert.ok(/'machine\.upgrade'/.test(code) && LANDED.U18(), 'machine.js upgrade, U18\'s verb, is in the tree');
  assert.equal(/VERBS = Object\.freeze\(\[[^\]]*'upgrade'/.test("const VERBS = Object.freeze(['upgrade-stop', 'status']);"), false, 'upgrade-stop is not upgrade');
});

test('nothing measured is nothing met: every reading not run with why (or retired), every lab line not run, Defender not asked', () => {
  for (const nothing of [null, {}, { v: 1, readings: {} }, { v: 1, readings: { R2: 'x', R4: [], R5: { error: 'Get-AuthenticodeSignature: no such file' } } }]) {
    const j = R.judge(nothing);
    assert.deepEqual(j.readings.map((x) => x.state), R.READINGS.map((x) => (x.retired ? 'retired' : 'not run')), JSON.stringify(nothing));
    for (const x of j.readings) assert.ok(x.words.length > 5, x.id + ' says why');
    assert.ok(j.labs.every((l) => l.state === 'not run'));
    assert.equal(j.defender.on, false);
  }
  const j = R.judge({ v: 1, readings: { R5: { error: 'Get-AuthenticodeSignature: no such file' }, R13: { skipped: 'no published release was named to read (none)' } } });
  assert.match(byId(j, 'R5').words, /failed on the runner: Get-AuthenticodeSignature: no such file/);
  assert.equal(byId(j, 'R13').words, 'no published release was named to read (none)');
  assert.equal(byId(j, 'R6').words, 'not taken by this lane', 'a reading the lane did not take says so');
  // A record that is not R6's shape is no export taken.
  assert.equal(byId(R.judge(raw({ R6: { runs: 10 } })), 'R6').state, 'not run');
  assert.match(byId(R.judge(raw({ R11: { runs: 10 } })), 'R11').words, /^the lane took no round for the account the control task is for/);
  // R3′ and R9 are the lane's now (U12 built): a record that is not their shape reads not run with why, never a unit.
  assert.match(byId(R.judge(raw({ 'R3′': { runs: 10 } })), 'R3′').words, /the stand-in server task did not run/);
  assert.match(byId(R.judge(raw({ R9: { runs: 10 } })), 'R9').words, /backed up no folder/);
});

test('Defender: on only when real-time monitoring and scanning on access came on, in its Normal mode, with C:\\ and D:\\ no longer excluded, and were still so when the readings taken with it ended', () => {
  assert.deepEqual(R.defenderOf(DEFENDER_ON), { asked: true, took: true, stayed: true, on: true, words: R.defenderOf(DEFENDER_ON).words });
  assert.match(R.defenderOf(DEFENDER_ON).words, /scanning on access, in its Normal mode/);
  const still = R.defenderOf({ defender: { after: { ...ON, exclusions: ['D:\\', 'E:\\cache'] }, errors: [] }, defenderEnd: ON });
  assert.deepEqual([still.took, still.on], [false, false]);
  assert.match(still.words, /did not come on as the readings need it \(D:\\ still excluded, E:\\cache excluded, not the runner's own\)/);
  const off = R.defenderOf({ defender: { after: { ...ON, realtime: false }, errors: ['real-time monitoring: tamper protection'] }, defenderEnd: { realtime: false } });
  assert.match(off.words, /\(real-time monitoring off\) \(real-time monitoring: tamper protection\)/);
  // Real-time monitoring on is not enough: a Defender that scans nothing on access, or runs passive, scanned nothing R2 and R10 wrote.
  for (const [after, why] of [[{ ...ON, onAccess: false }, 'scanning on access off'], [{ ...ON, mode: 'Passive Mode' }, 'in Passive Mode, not Normal'], [{ ...ON, mode: 'EDR Block Mode' }, 'in EDR Block Mode, not Normal'], [{ realtime: true, exclusions: [] }, 'scanning on access off, its mode not read']]) {
    const d = R.defenderOf({ defender: { after, errors: [] }, defenderEnd: after });
    assert.deepEqual([d.took, d.on], [false, false], why);
    assert.ok(d.words.includes(why), d.words);
    assert.equal(byId(R.judge(raw({ R10: { rounds: [{ extractMs: 800, runMs: 300, totalMs: 1100, code: 0 }] } }, { defender: { after, errors: [] }, defenderEnd: after })), 'R10').state, 'not run', why + ': R10 is not the reading its mark needs');
  }
  // A list of one as Windows PowerShell may write it, alone or wrapped, is still a list.
  for (const exclusions of ['C:\\', { value: ['D:\\'], Count: 1 }]) {
    const d = R.defenderOf({ defender: { after: { ...ON, exclusions }, errors: [] }, defenderEnd: ON });
    assert.deepEqual([d.took, d.on], [false, false], JSON.stringify(exclusions));
    assert.match(d.words, /:\\ still excluded\)$/);
  }
  assert.equal(R.defenderOf({ defender: { after: { ...ON, exclusions: null }, errors: [] }, defenderEnd: ON }).on, true, 'no exclusions at all');
  const lapsed = R.defenderOf({ ...DEFENDER_ON, defenderEnd: { ...ON, realtime: false } });
  assert.deepEqual([lapsed.took, lapsed.stayed, lapsed.on], [true, false, false]);
  assert.match(lapsed.words, /was not so when the readings taken with it ended \(real-time monitoring off\)/);
  const cut = R.defenderOf({ ...DEFENDER_ON, defenderEnd: null });
  assert.deepEqual([cut.on, cut.words.includes('not read again when the readings taken with it ended')], [false, true]);
  assert.equal(R.defenderOf({ ...DEFENDER_ON, defenderEnd: { error: 'powershell.exe ended with 1' } }).on, false, 'an end that could not be read is not on');
  // The runner's own processes and folder, which tools/defender-on.ps1 recorded as it excluded them, leave Defender on,
  // matched whole in any case and with either slash; any other exclusion does not (fail closed: a wildcard, a short name
  // or a folder beside what is measured is never read as what it covers), nor a process but the runner's, nor any
  // extension, nor a list not read, at the start or by the end.
  const runner = { scanned: false, processes: ['C:\\actions-runner\\bin\\Runner.Listener.exe'], paths: ['C:\\actions-runner'], kept: ['D:\\a\\_temp'] };
  const own = { ...ON, exclusions: ['c:/actions-runner/'], processes: ['C:\\ACTIONS-RUNNER\\bin\\Runner.Listener.exe'] };
  const withOwn = R.defenderOf({ defender: { after: own, errors: [], runner }, defenderEnd: own });
  assert.deepEqual([withOwn.took, withOwn.stayed, withOwn.on], [true, true, true]);
  assert.match(withOwn.words, /the runner's own processes and folder alone excluded, and still so when the readings taken with it ended$/);
  for (const [x, why] of [['D:\\a', 'it holds the workspace'], ['C:\\actions-runner\\*', 'a wildcard'], ['C:\\Users\\RUNNER~1', 'a short name'], ['C:\\actions-runner2', 'a folder that only shares the runner\'s prefix'], ['E:\\cache', 'beside what is measured, and still not the runner\'s']]) {
    const after = { ...own, exclusions: ['C:\\actions-runner', x] };
    const d = R.defenderOf({ defender: { after, errors: [], runner }, defenderEnd: after });
    assert.deepEqual([d.took, d.on], [false, false], why);
    assert.ok(d.words.includes('(' + x + ' excluded, not the runner\'s own)'), why + ': ' + d.words);
  }
  for (const [after, said] of [[{ ...own, processes: [...own.processes, 'node.exe'] }, '(node.exe excluded as a process, not the runner\'s own)'], [{ ...own, extensions: ['.js'] }, '(the extension .js excluded)'],
    [{ realtime: true, onAccess: true, mode: 'Normal', exclusions: ['C:\\actions-runner'], extensions: [] }, '(its process exclusions not read)'], [{ realtime: true, onAccess: true, mode: 'Normal', exclusions: [], processes: [] }, 'its extension exclusions not read']]) {
    const d = R.defenderOf({ defender: { after, errors: [], runner }, defenderEnd: after });
    assert.deepEqual([d.took, d.on], [false, false], said);
    assert.ok(d.words.includes(said), d.words);
  }
  const late = R.defenderOf({ defender: { after: own, errors: [], runner }, defenderEnd: { ...own, exclusions: ['C:\\actions-runner', 'D:\\a\\_temp\\x'] } });
  assert.deepEqual([late.took, late.stayed, late.on], [true, false, false], 'excluded by the end');
  assert.match(late.words, /was not so when the readings taken with it ended \(D:\\a\\_temp\\x excluded, not the runner's own\)/);
  const scanned = R.defenderOf({ defender: { after: ON, errors: [], runner: { scanned: true, processes: [], paths: [] } }, defenderEnd: ON });
  assert.deepEqual([scanned.on, /alone excluded/.test(scanned.words)], [true, false], 'with the runner scanned too, nothing excluded at all');
});

// ---------------------------------------------------------------- each reading against its mark

test('R2: the slowest round against 6 s with R9; over 6 s alone is missed even without Defender; without Defender or R9 it is never met', () => {
  const r2 = { files: 5122, bytes: 197_000_000, emptyMs: 7100, rounds: [3100, 2900, 3300], over: 'v0.5.1' };
  let x = byId(R.judge(raw({ R2: r2 })), 'R2');
  assert.deepEqual([x.state, x.facts.slowestMs, x.facts.files, x.facts.over], ['open', 3300, 5122, 'v0.5.1']);
  assert.match(x.words, /^5122 files, 188 MB laid over v0\.5\.1's payload, the slowest of 3 rounds 3\.30 s; .*R9 is not run/);
  // With no earlier release's zip, this build is laid over its own, and the words say so and why.
  x = byId(R.judge(raw({ R2: { ...r2, over: '', overWhy: 'none was given' } })), 'R2');
  assert.match(x.words, /laid over this build's own \(no earlier release's zip was had: none was given\)/);
  x = byId(R.judge(raw({ R2: r2, R9: { emptyMs: 400, largeMs: 2600 } })), 'R2');
  assert.deepEqual([x.state, x.facts.backupMs], ['met', 2600]);
  assert.match(x.words, /5\.90 s \(≤ 6 s\)/);
  assert.equal(byId(R.judge(raw({ R2: r2, R9: { emptyMs: 400, largeMs: 2800 } })), 'R2').state, 'missed', '6.1 s together');
  assert.equal(byId(R.judge(raw({ R2: { ...r2, rounds: [3100, 6400] } })), 'R2').state, 'missed', 'one slow round');
  const noDefender = { defender: { after: { realtime: false, exclusions: ['C:\\'] } }, defenderEnd: { realtime: false } };
  x = byId(R.judge(raw({ R2: r2, R9: { largeMs: 100 } }, noDefender)), 'R2');
  assert.equal(x.state, 'not run', 'never met without Defender');
  assert.match(x.words, /not the reading its mark needs/);
  x = byId(R.judge(raw({ R2: { ...r2, rounds: [7000] } }, noDefender)), 'R2');
  assert.equal(x.state, 'missed', 'over its mark without Defender is over it with Defender too');
  assert.equal(byId(R.judge(raw({ R2: { files: 3, rounds: [] } })), 'R2').state, 'not run');
});

test('a reading that needs Defender is held to it only when the take that took it was given Defender\'s record: one taken in a take given none is not run, saying so; a record without take indexes is judged as before', () => {
  const r2 = { files: 5122, bytes: 197_000_000, emptyMs: 7100, rounds: [3100, 2900, 3300], over: 'v0.5.1' };
  const r9 = { emptyMs: 400, largeMs: 2600, sizes: [{ name: 'empty', backupMs: 400, saved: true }, { name: 'large', backupMs: 2600, saved: true }] };
  const r10 = { rounds: [{ extractMs: 800, runMs: 300, totalMs: 1100, code: 0 }] };
  // The lane's three takes: the first given Defender's record, the two after it written as given none.
  const takes = [{ only: ['R2', 'R9', 'R10'], defender: true }, { skip: ['R2', 'R9', 'R10', 'R11', 'R6'], defender: false }, { only: ['R11', 'R6'], defender: false }];
  const lane = (times, readings = { R2: r2, R9: r9, R10: r10 }) => R.judge(raw(readings, { takes, times }));
  // Taken in the take with Defender: judged as before.
  let j = lane({ R2: { begunS: 1, s: 142, take: 0 }, R10: { begunS: 165, s: 15, take: 0 }, R9: { begunS: 180, s: 3, take: 0 } });
  assert.deepEqual(['R2', 'R9', 'R10'].map((id) => byId(j, id).state), ['met', 'recorded', 'recorded']);
  assert.match(j.defender.words, /and still so when the readings taken with it ended; takes 2 and 3 of 3 given no Defender record \(the lane puts Defender back as the image left it before them\)$/, 'the takes given none named');
  assert.match(R.defenderOf(raw({}, { takes: takes.slice(0, 2) })).words, /; take 2 of 2 given no Defender record \(the lane puts Defender back as the image left it before it\)$/, 'one named alone');
  // R2 taken in a take given none: not run, saying so, never met.
  j = lane({ R2: { begunS: 1, take: 1 }, R10: { begunS: 165, take: 0 }, R9: { begunS: 180, take: 0 } });
  assert.equal(byId(j, 'R2').state, 'not run');
  assert.match(byId(j, 'R2').words, /^5122 files, 188 MB laid over v0\.5\.1's payload, the slowest of 3 rounds 3\.30 s, but it was taken in take 2, which was given no Defender record \(the lane puts Defender back as the image left it before it\): not the reading its mark needs$/);
  assert.equal(byId(j, 'R10').state, 'recorded', 'each reading by the take that took it');
  // …and over its mark anyway is still missed, which Defender would only make worse.
  assert.equal(byId(lane({ R2: { take: 2 } }, { R2: { ...r2, rounds: [7000] }, R9: r9 }), 'R2').state, 'missed');
  // R10 and R9 alike; R9 taken in a take given none is no part of R2's mark, which stays open.
  j = lane({ R2: { take: 0 }, R10: { take: 2 }, R9: { take: 1 } });
  assert.deepEqual([byId(j, 'R10').state, byId(j, 'R9').state, byId(j, 'R2').state], ['not run', 'not run', 'open']);
  assert.match(byId(j, 'R10').words, /, but it was taken in take 3, which was given no Defender record \(the lane puts Defender back as the image left it before it\): not the reading its mark needs$/);
  assert.match(byId(j, 'R9').words, /^the upgrade backup's time: empty 400 ms, saved; large 2\.60 s, saved \(beside R2\), but it was taken in take 2, which was given no Defender record \(the lane puts Defender back as the image left it before it\): not the reading its mark needs$/);
  assert.match(byId(j, 'R2').words, /the mark is R2 and R9 together, and R9 was taken in take 2, which was given no Defender record$/);
  // The judge says what the record knows, never that it saw Defender turned back off.
  for (const id of ['R2', 'R9', 'R10']) assert.doesNotMatch(byId(j, id).words + j.defender.words, /turned back off|after Defender was/, id);
  // A reading that needs no Defender is judged alike whichever take took it.
  const r12 = { nonZero: { starts: 2, waitedMs: 61000 }, zero: { starts: 1, waitedMs: 90000 } };
  assert.equal(byId(lane({ R12: { take: 1 } }, { R12: r12 }), 'R12').state, byId(R.judge(raw({ R12: r12 })), 'R12').state);
  // A record without take indexes (one take's), an index that names no take, or a take that does not say: as before.
  for (const times of [undefined, { R2: { begunS: 1, s: 142 } }, { R2: { take: 7 } }, { R2: { take: '1' } }]) {
    assert.equal(byId(R.judge(raw({ R2: r2, R9: r9 }, times ? { takes, times } : {})), 'R2').state, 'met', JSON.stringify(times));
  }
  assert.equal(byId(R.judge(raw({ R2: r2, R9: r9 }, { takes: [{}, {}], times: { R2: { take: 1 } } })), 'R2').state, 'met', 'a take that does not say it was given no Defender record');
  assert.equal(R.defenderOf(raw({}, { takes: [{}, { defender: true }] })).words, R.defenderOf(DEFENDER_ON).words, 'no take named when none was given no record');
});

test('R4: met only with SeChangeNotifyPrivilege alone in the server\'s token and the server serving under the task; the task\'s SID read', () => {
  let x = byId(R.judge(raw({ R4: R4_SERVED })), 'R4');
  assert.equal(x.state, 'met');
  assert.equal(x.words, 'the token holds SeChangeNotifyPrivilege alone, and the server served under it in 912 ms (0.6.0-dev.40+abc1234). Beside it: the task\'s SID in the token; UDP 9928 heard yes (from this machine); a quick tunnel\'s address returned; files written or changed in the account\'s profile 1; a rule by program, protocol and port made and read back (TCP, 3124, LocalSubnet; no client on another machine to show it matching)');
  assert.equal(x.facts.build, '0.6.0-dev.40+abc1234', 'the build health must name: the bundle\'s stamp');
  // An answer on the port is this bundle's server only when it names this bundle's build.
  x = byId(R.judge(raw({ R4: { ...R4_SERVED, served: { ok: true, ms: 40, build: '0.5.1+31.0a1b2c3' } } })), 'R4');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^the server did not serve under the task: what answered on its port named the build "0\.5\.1\+31\.0a1b2c3", not this bundle's 0\.6\.0-dev\.40\+abc1234\. Beside it/);
  x = byId(R.judge(raw({ R4: { ...R4_SERVED, served: { ok: true, ms: 40 } } })), 'R4');
  assert.equal(x.state, 'missed', 'an answer that names no build is not this bundle\'s');
  x = byId(R.judge(raw({ R4: R4_SERVED }, { build: null })), 'R4');
  assert.equal(x.state, 'not run', 'with no stamp read, the answer cannot be tied to this build');
  assert.match(x.words, /the bundle's stamp was not read, or is not one its server takes, so the answer could not be tied to this build/);
  // A stamp its server would not take (its install version not its own) names no build the server says.
  assert.equal(R.stampFull({ ...STAMP, installVersion: '0.6.41' }), '');
  assert.equal(byId(R.judge(raw({ R4: R4_SERVED }, { build: { ...STAMP, installVersion: '0.6.41' } })), 'R4').state, 'not run');
  assert.equal(R.stampFull({ ...STAMP, channel: 'release' }), '0.6.0+40.abc1234', 'a release names its build as health does');
  assert.deepEqual(x.facts.privileges.map((p) => p.name), ['SeChangeNotifyPrivilege']);
  assert.deepEqual([x.facts.sid, x.facts.taskSidInToken, x.facts.user], [TASK_SID, true, 'S-1-5-19']);
  assert.deepEqual([x.facts.rule.Program, x.facts.rule.Protocol, x.facts.rule.LocalPort, x.facts.rule.RemoteIP], ['C:\\agm-readings\\payload\\x\\node\\node.exe', 'TCP', '3124', 'LocalSubnet']);
  x = byId(R.judge(raw({ R4: { ...R4_SERVED, whoami: { ...R4_SERVED.whoami, priv: PRIV_IMPERSONATE } } })), 'R4');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^the token holds SeImpersonatePrivilege/);
  x = byId(R.judge(raw({ R4: { ...R4_SERVED, whoami: { ...R4_SERVED.whoami, priv: PRIV_ALONE + '"SeCreateGlobalPrivilege","Create global objects","Enabled"\r\n' } } })), 'R4');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^the token holds SeCreateGlobalPrivilege beside SeChangeNotifyPrivilege\. Beside it: /);
  x = byId(R.judge(raw({ R4: { ...R4_SERVED, served: { ok: false, ms: 30000, words: 'server stopped: cannot start as configured (code 3): …' } } })), 'R4');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^the server did not serve under the task \(server stopped: cannot start as configured/);
  assert.equal(byId(R.judge(raw({ R4: { ...R4_SERVED, whoami: { user: '', priv: '', groups: '' } } })), 'R4').state, 'not run', 'a token not read is not judged');
});

test('R5: met when Windows says node.exe and cloudflared.exe are Valid; one it does not trust is missed and named', () => {
  const files = (cf) => ({ files: [{ path: 'C:\\agm-readings\\payload\\x\\node\\node.exe', status: 'Valid', signer: 'CN=OpenJS Foundation' }, { path: 'C:\\agm-readings\\payload\\x\\bin\\cloudflared.exe', status: cf, signer: cf === 'Valid' ? 'CN=Cloudflare, Inc.' : '' }], installer: null });
  let x = byId(R.judge(raw({ R5: files('Valid') })), 'R5');
  assert.deepEqual([x.state, x.facts.node.status, x.facts.cloudflared.signer], ['met', 'Valid', 'CN=Cloudflare, Inc.']);
  assert.match(x.words, /; the installer not read \(its job built none for this run\)$/);
  x = byId(R.judge(raw({ R5: files('NotSigned') })), 'R5');
  assert.deepEqual([x.state, x.words.split(';')[0]], ['missed', 'cloudflared.exe NotSigned']);
  assert.equal(byId(R.judge(raw({ R5: { files: [files('Valid').files[0]] } })), 'R5').state, 'not run');
  // The installer is recorded, never judged: it is unsigned by the owner's answer 36.
  x = byId(R.judge(raw({ R5: { ...files('Valid'), installer: { status: 'NotSigned', name: 'AGMessage-Setup-0.6.0-dev.90_abc1234-unsigned.exe', signer: '' } } })), 'R5');
  assert.deepEqual([x.state, x.facts.installer.status], ['met', 'NotSigned']);
  assert.match(x.words, /; the installer NotSigned \(AGMessage-Setup-0\.6\.0-dev\.90_abc1234-unsigned\.exe\)$/);
  // What the lane records of it: Windows' verdict on the file it was given, or why there is none.
  const exe = 'C:\\a\\installer-dist\\AGMessage-Setup-0.6.0-unsigned.exe';
  assert.deepEqual(T.installerSignature([...files('Valid').files, { path: exe, status: 'NotSigned', signer: '' }], exe), { status: 'NotSigned', name: 'AGMessage-Setup-0.6.0-unsigned.exe', signer: '' });
  assert.deepEqual(T.installerSignature(files('Valid').files, ''), { why: 'its job built none for this run' });
  assert.deepEqual(T.installerSignature(files('Valid').files, exe), { why: 'Windows gave no verdict on AGMessage-Setup-0.6.0-unsigned.exe' });
});

test('R7 and R8: an access list read from its SDDL by SID: who may read and write the folder pipe, and whether a standard account may make a folder', () => {
  const pipe = R.daclOf(PIPE_SDDL);
  assert.deepEqual(pipe.map((a) => [a.type, a.name, a.mask]), [['allow', 'SYSTEM', 0x1F01FF], ['allow', 'Administrators', 0x1F01FF], ['allow', TASK_SID, 0x1F01FF], ['allow', 'Everyone', 0x120089], ['allow', 'Anonymous', 0x120089]]);
  let x = byId(R.judge(raw({ R7: { pipes: [{ name: 'agmessage-0123456789abcdef', sddl: PIPE_SDDL }] } })), 'R7');
  assert.equal(x.state, 'recorded');
  assert.deepEqual([x.facts.pipes[0].read, x.facts.pipes[0].write], [['SYSTEM', 'Administrators', TASK_SID, 'Everyone', 'Anonymous'], ['SYSTEM', 'Administrators', TASK_SID]]);
  assert.match(x.words, /a client through SMB not tried$/);
  // Through SMB at this machine's own names: a network logon, as a remote client's would be, said for what it is.
  x = byId(R.judge(raw({ R7: { pipes: [{ name: 'agmessage-0123456789abcdef', sddl: PIPE_SDDL }], remote: [{ via: 'localhost', connected: true, error: '' }, { via: 'fv-az123-456', connected: false, error: 'EACCES' }] } })), 'R7');
  assert.equal(x.state, 'recorded');
  assert.match(x.words, /through SMB at this machine's own names \(a network logon; no second machine\): \\\\localhost connected, \\\\fv-az123-456 not connected \(EACCES\)$/);
  assert.deepEqual(x.facts.remote.map((r) => r.connected), [true, false]);
  assert.equal(byId(R.judge(raw({ R7: { pipes: [{ name: 'agmessage-0123456789abcdef', error: 'Access denied' }] } })), 'R7').state, 'not run');
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL }, 'C:\\ProgramData': { sddl: DATA_SDDL } } } })), 'R8');
  assert.equal(x.state, 'recorded');
  assert.deepEqual([x.facts['C:\\'].createFolder, x.facts['C:\\'].by], ['yes', 'Authenticated Users'], 'C:\\node_modules can be made');
  assert.deepEqual([x.facts['C:\\ProgramData'].createFolder, x.facts['C:\\ProgramData'].by], ['yes', 'Users'], '%ProgramData%\\AGMessage can be made');
  assert.match(x.words, /the server task's definition was not read \(not read\); a control task's definition was not read \(not read\)$/);
  // U12's server task's definition, as app/machine.js writes it: its own descriptor read back says who may read it.
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL } }, serverTask: { sddl: require('../machine').SERVER_TASK_SDDL, bytes: 2400, secret: false } } })), 'R8');
  assert.deepEqual([x.facts.serverTask.read, x.facts.serverTask.secret], ['no', false]);
  assert.match(x.words, /the server task's definition: a standard account may not read it, and no secret is in it; a control task's definition was not read/);
  // U17's control task's definition, as app/machine.js writes it: the account it is for may read and run it, no other.
  const BEN = 'S-1-5-21-1-2-3-1002';
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL } }, controlTask: { sid: BEN, sddl: require('../machine').controlSddl(BEN), bytes: 2000, secret: false } } })), 'R8');
  assert.deepEqual([x.facts.controlTask.itsAccount, x.facts.controlTask.itsAccountRuns, x.facts.controlTask.read], ['yes', 'yes', 'no']);
  assert.match(x.words, /a control task's definition: the account it is for may read and run it, another standard account may not, and no secret is in it$/);
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL } }, controlTask: { sid: BEN, sddl: 'D:(A;;FR;;;' + BEN + ')(A;;FR;;;BU)', secret: false } } })), 'R8');
  assert.match(x.words, /the account it is for may not read and run it, another standard account may read it \(Users\)/, 'read without execute does not run it');
  // Windows writes LA for the machine's own Administrator (RID 500 in its domain), as CI's run 101 read back for the
  // runner's account: that account, read by its RID, and never a group every standard account holds.
  const RUNNER = 'S-1-5-21-3289802278-1561746829-1498425070-500';
  const AS_READ = 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;LA)(A;;FR;;;SY)';
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL } }, controlTask: { sid: RUNNER, sddl: AS_READ, bytes: 1556, secret: false } } })), 'R8');
  assert.deepEqual([x.facts.controlTask.itsAccount, x.facts.controlTask.itsAccountRuns, x.facts.controlTask.itsAccountBy, x.facts.controlTask.read], ['yes', 'yes', 'LA, this machine\'s Administrator', 'no']);
  assert.match(x.words, /a control task's definition: the account it is for \(LA, this machine's Administrator, in its descriptor\) may read and run it, another standard account may not, and no secret is in it$/);
  assert.deepEqual(R.daclOf(AS_READ).map((a) => [a.sid, a.name, a.machineRid]), [['S-1-5-18', 'SYSTEM', undefined], ['S-1-5-32-544', 'Administrators', undefined], ['LA', 'LA, this machine\'s Administrator', 500], ['S-1-5-18', 'SYSTEM', undefined]]);
  assert.equal(R.holds(R.daclOf(AS_READ), [BEN], READ_DATA_RIGHT).answer, 'no', 'LA is the account of RID 500, not another of the machine\'s');
  assert.equal(R.holds(R.daclOf(AS_READ), R.STANDARD_ACCOUNT, READ_DATA_RIGHT).answer, 'no', 'nor a group a standard account holds');
  assert.equal(R.holds(R.daclOf('D:(A;;FR;;;LG)'), ['S-1-5-21-1-2-3-501'], READ_DATA_RIGHT).answer, 'yes', 'LG: the machine\'s Guest, RID 501');
  assert.equal(R.holds(R.daclOf('D:(A;;FR;;;LA)'), ['S-1-5-32-500', 'S-1-5-21-1-2-500'], READ_DATA_RIGHT).answer, 'no', 'only a machine domain\'s SID, whole, with that RID');
  assert.deepEqual(R.holds(R.daclOf('D:(D;;FR;;;LA)(A;;FR;;;' + RUNNER + ')'), [RUNNER], READ_DATA_RIGHT), { answer: 'refused', by: 'LA, this machine\'s Administrator' }, 'a deny for LA comes first');
  x = byId(R.judge(raw({ R8: { places: { 'C:\\': { sddl: ROOT_SDDL } }, serverTask: { sddl: 'D:(A;;FRFX;;;AU)', secret: true } } })), 'R8');
  assert.match(x.words, /a standard account may read it \(Authenticated Users\), and a secret is in it/);
  // Inherit-only entries are not the folder's own; a deny first refuses; an entry not read assumes the worst.
  const acl = (d) => R.daclOf('D:' + d);
  assert.equal(R.holds(acl('(A;OICIIO;GA;;;AU)(A;OICI;0x1200a9;;;BU)'), R.STANDARD_ACCOUNT, 0x4).answer, 'no');
  assert.deepEqual(R.holds(acl('(D;;LC;;;WD)(A;;FA;;;AU)'), R.STANDARD_ACCOUNT, 0x4), { answer: 'refused', by: 'Everyone' });
  assert.equal(R.holds(acl('(A;;GW;;;IU)'), R.STANDARD_ACCOUNT, 0x4).answer, 'yes', 'generic write is a file\'s write');
  assert.equal(R.holds(acl('(XA;;FA;;;WD;(Member_of {SID(BA)}))'), R.STANDARD_ACCOUNT, 0x4).answer, 'yes', 'a conditional entry this does not read');
  assert.equal(R.holds(acl('(A;;QQ;;;WD)'), R.STANDARD_ACCOUNT, 0x4).answer, 'yes', 'a right this does not know');
  assert.ok(Number.isNaN(R.rightsMask('FAX')));
  assert.equal(byId(R.judge(raw({ R8: { places: { 'C:\\': { error: 'icacls ended with 5' } } } })), 'R8').state, 'not run');
});

test('R6: open when a standard account\'s export wrote its bundle and the elevated import verified it (the two readings under over-the-shoulder elevation are the show laptop\'s); missed when either did not; not run with no export taken', () => {
  const good = { sid: 'S-1-5-21-1-2-3-1001', stage: { code: 0, words: 'The import is ready' }, export: { code: 0, words: 'The portable folder is exported for the import: 1 file (1 KB)' }, take: { code: 0, verified: true, words: 'Imported and verified' }, profileRead: { ok: true } };
  let x = byId(R.judge(raw({ R6: good })), 'R6');
  assert.equal(x.state, 'open');
  assert.equal(x.words, 'the export, run as a standard account, wrote its bundle into its own import folder; the elevated import read and verified it; an elevated read of that account\'s %LOCALAPPDATA%\\AGMessage read the file it made. The two readings of the account that started Setup need an administrator approving another account\'s elevation at a desktop, which no runner has: the show laptop\'s');
  x = byId(R.judge(raw({ R6: { ...good, profileRead: { ok: false, code: 'EACCES' } } })), 'R6');
  assert.deepEqual([x.state, x.words.includes('was refused (EACCES)')], ['open', true], 'an elevated read refused is a fact recorded, not the mark');
  x = byId(R.judge(raw({ R6: { ...good, export: { code: 2, words: 'The import was not made ready for LAPTOP\\agmr6export on this PC (EPERM)' }, take: { code: 3, verified: false, words: 'no answer' } } })), 'R6');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^the export, run as a standard account, did not: The import was not made ready .*; the elevated import did not take it: no answer;/);
  x = byId(R.judge(raw({ R6: { ...good, take: { code: 2, verified: false, words: 'The import did not pass its verify' } } })), 'R6');
  assert.equal(x.state, 'missed');
  x = byId(R.judge(raw({ R6: { sid: good.sid, stage: { code: 2, words: 'icacls.exe ended with 5' } } })), 'R6');
  assert.deepEqual([x.state, x.words], ['missed', 'the import was not made ready for a standard account (machine.js import --step stage ended with 2: icacls.exe ended with 5)']);
  x = byId(R.judge(raw({ R6: { sid: good.sid, stage: good.stage, export: { code: null, err: 'its task did not run: access denied' } } })), 'R6');
  assert.deepEqual([x.state, x.words], ['not run', 'the export as a standard account was not taken (its task did not run: access denied)']);
  assert.equal(byId(R.judge(raw({ R6: { skipped: 'the standard account was not made' } })), 'R6').words, 'the standard account was not made');
});

test('R11: met at 10 of 10, the account the control task is for running it (answered as SYSTEM for its SID) and a second account refused; anything less is missed with the first round that did not', () => {
  const SID = 'S-1-5-21-1-2-3-1002';
  const good = () => ({ code: 0, err: '', answered: true, ranAs: 'S-1-5-18', for: SID });
  const refused = () => ({ code: 1, err: 'ERROR: Access is denied.', answered: false });
  const ten = (f) => Array.from({ length: 10 }, f);
  let x = byId(R.judge(raw({ R11: { sid: SID, controlTask: '\\AGMessage-Readings\\Control-' + SID, own: ten(good), other: ten(refused) } })), 'R11');
  assert.deepEqual([x.state, x.words], ['met', 'the account it is for ran it 10 of 10 times, each answered as SYSTEM for its SID; a second standard account was refused 10 of 10 times']);
  const own = ten(good);
  own[3] = { code: 0, answered: true, ranAs: 'S-1-5-21-9-9-9-500', for: SID };
  x = byId(R.judge(raw({ R11: { sid: SID, own, other: ten(refused) } })), 'R11');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /ran it 9 of 10 times.*\(a round that did not: exit 0, answered as S-1-5-21-9-9-9-500 for S-1-5-21-1-2-3-1002\)$/, 'run as another account than SYSTEM');
  const other = ten(refused);
  other[0] = { code: 0, answered: true, ranAs: 'S-1-5-18', for: SID };
  assert.equal(byId(R.judge(raw({ R11: { sid: SID, own: ten(good), other } })), 'R11').state, 'missed', 'a second account that ran it');
  x = byId(R.judge(raw({ R11: { sid: SID, own: [{ code: null, err: 'the task as agmr11own wrote nothing within 30 s (last result 267011)', answered: false }], other: ten(refused) } })), 'R11');
  assert.deepEqual([x.state, x.words], ['not run', 'a run as a standard account was not taken: the task as agmr11own wrote nothing within 30 s (last result 267011)'], 'the lane\'s own task as the account never ran: nothing of the control task was measured');
  x = byId(R.judge(raw({ R11: { skipped: 'the two standard accounts were not made (0 of 2)' } })), 'R11');
  assert.deepEqual([x.state, x.words], ['not run', 'the two standard accounts were not made (0 of 2)']);
});

test('R10: over 5 s in any round is missed (its fallback: the installed node.exe); within it is recorded, and only with Defender on', () => {
  const rounds = (...t) => ({ rounds: t.map((totalMs) => ({ extractMs: totalMs - 200, runMs: 200, totalMs, code: 0 })), where: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp' });
  let x = byId(R.judge(raw({ R10: rounds(1800, 1200, 1100) })), 'R10');
  assert.deepEqual([x.state, x.facts.slowestMs], ['recorded', 1800]);
  x = byId(R.judge(raw({ R10: rounds(1800, 5200) })), 'R10');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /5\.20 s.*over 5 s/);
  const noDefender = { defenderEnd: { realtime: false } };
  assert.equal(byId(R.judge(raw({ R10: rounds(1800) }, noDefender)), 'R10').state, 'not run');
  assert.equal(byId(R.judge(raw({ R10: rounds(9000) }, noDefender)), 'R10').state, 'missed');
  // A round counts only when the node.exe it extracted ran to exit 0: one blocked or quarantined fails fast and measured no command.
  const failed = (totalMs, code, err) => ({ extractMs: totalMs - 3, runMs: 3, totalMs, code, err });
  x = byId(R.judge(raw({ R10: { rounds: [failed(800, null, 'EPERM'), failed(812, null, 'EPERM')] } })), 'R10');
  assert.deepEqual([x.state, x.facts.ran], ['not run', 0]);
  assert.equal(x.words, 'node.exe extracted to %TEMP% did not run to exit 0, so no command was measured: round 1 ended without an exit code after 800 ms (EPERM); round 2 ended without an exit code after 812 ms (EPERM)');
  x = byId(R.judge(raw({ R10: { rounds: [...rounds(1800).rounds, failed(900, 1, 'Access is denied.')] } })), 'R10');
  assert.equal(x.state, 'not run', 'one round that did not run is enough to say so');
  assert.match(x.words, /round 2 ended with 1 after 900 ms \(Access is denied\.\)/);
  x = byId(R.judge(raw({ R10: { rounds: [failed(120500, null, 'ETIMEDOUT')] } })), 'R10');
  assert.equal(x.state, 'missed', 'a run that did not end within 5 s is over 5 s however it ended');
  assert.match(x.words, /^node\.exe extracted to %TEMP% did not run within 5 s: round 1 ended without an exit code after 120\.5 s \(ETIMEDOUT\)$/);
  assert.equal(byId(R.judge(raw({ R10: { rounds: [{ totalMs: 900 }] } })), 'R10').state, 'not run', 'a round with no exit code recorded is not a run');
});

test('R12 and R13: Task Scheduler\'s restarts and GitHub\'s answer recorded; the cost U.5 names, or an answer not read, is a miss', () => {
  const r12 = (n, z) => ({ R12: { nonZero: { starts: n, waitedMs: 150000, lastResult: 1 }, zero: { starts: z, waitedMs: 90000, lastResult: 0 } } });
  let x = byId(R.judge(raw(r12(2, 1))), 'R12');
  assert.equal(x.state, 'recorded');
  assert.match(x.words, /^a non-zero exit was started again \(1 time within 150\.0 s\); exit 0 left it stopped within 90\.0 s$/);
  x = byId(R.judge(raw(r12(1, 1))), 'R12');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /^a non-zero exit was not started again within 150\.0 s; exit 0 left it stopped/);
  assert.equal(byId(R.judge(raw(r12(2, 2))), 'R12').state, 'missed', 'a 0 started again would undo "stays stopped"');
  assert.equal(byId(R.judge(raw(r12(0, 1))), 'R12').state, 'not run');
  const digest = 'sha256:' + 'ab'.repeat(32);
  x = byId(R.judge(raw({ R13: { tag: 'v0.5.1', status: 200, ms: 640, immutable: false, assets: [{ name: 'a.zip', digest }, { name: 'SHA256SUMS', digest: '' }], rateRemaining: 58 } })), 'R13');
  assert.equal(x.state, 'recorded');
  assert.deepEqual([x.facts.immutable, x.facts.assets.length], [false, 2]);
  assert.match(x.words, /v0\.5\.1 not immutable \(published while the repository's immutable releases were off: its owner turns them on, Settings, the Releases section\), 1 of 2 assets with a SHA-256 digest/);
  assert.equal(byId(R.judge(raw({ R13: { status: 403, rateRemaining: 0, assets: [] } })), 'R13').state, 'not run', 'the runner\'s rate limit says nothing of the laptop');
  x = byId(R.judge(raw({ R13: { status: 0, failure: 'ENOTFOUND', assets: [] } })), 'R13');
  assert.deepEqual([x.state, x.words], ['missed', 'GitHub\'s answer was not read from the SYSTEM task (ENOTFOUND)']);
  // With no network: the words a checked upgrade shows, as the bundle's machine.js gave them behind the outbound rule.
  const OFFLINE = require('../machine').OFFLINE_WORDS;
  const online = { tag: 'v0.6.1', status: 200, ms: 300, immutable: true, assets: [{ name: 'a.exe', digest }] };
  x = byId(R.judge(raw({ R13: { ...online, offline: { ms: 40, error: 'ENOTFOUND', status: 0, why: 'offline', words: OFFLINE } } })), 'R13');
  assert.equal(x.state, 'recorded');
  assert.ok(x.words.endsWith('; with no network, the words: "' + OFFLINE + '" (ENOTFOUND)'), x.words);
  assert.deepEqual(x.facts.offline, { why: 'offline', words: OFFLINE, error: 'ENOTFOUND', status: 0 });
  x = byId(R.judge(raw({ R13: { ...online, offline: { error: '', status: 200, why: 'repository', words: '' } } })), 'R13');
  assert.ok(x.words.endsWith('with no network, not taken: the outbound rule did not keep GitHub away (HTTP 200)'), 'a rule that did not hold is said, never taken for the words');
  assert.ok(byId(R.judge(raw({ R13: { ...online, offline: { error: 'schtasks could not run the offline stand-in' } } })), 'R13').words.endsWith('with no network, not taken (schtasks could not run the offline stand-in)'));
  assert.ok(byId(R.judge(raw({ R13: online })), 'R13').words.endsWith('with no network, not taken'));
});

test('R1 judged: the largest hall\'s slowest page back against 1.5 s, as R2 and R10 judge theirs, each size\'s median and slowest said, a stop that did not save or a round that did not finish said', () => {
  const round = (pageBackMs, extra = {}) => ({ stopMs: 300, saved: true, healthMs: 900, startHealthMs: 600, pageBackMs, tries: 2, ...extra });
  const sizes = (large) => ({ sizes: [{ name: 'empty', halls: 1, messages: 0, firstMs: 500, rounds: [round(700), round(800), round(750)] }, { name: 'large', halls: 20, messages: 10000, firstMs: 3000, rounds: large }] });
  let x = byId(R.judge(raw({ R1: sizes([round(1200), round(1500), round(1400)]) })), 'R1');
  assert.equal(x.state, 'met', 'the slowest, 1.5 s, is the mark\'s; the median is said');
  assert.equal(x.words, 'at an empty hall: page back median 750 ms, slowest 800 ms over 3 rounds; at 20 halls × 10,000: page back median 1.40 s, slowest 1.50 s over 3 rounds; every stop saved (the slowest ≤ 1.5 s at the largest)');
  assert.deepEqual(x.facts.sizes.map((z) => [z.pageBackMedianMs, z.pageBackSlowestMs]), [[750, 800], [1400, 1500]]);
  x = byId(R.judge(raw({ R1: sizes([round(1200), round(1600), round(1400)]) })), 'R1');
  assert.equal(x.state, 'missed', 'one round over the mark misses it, whatever the median');
  assert.match(x.words, /median 1\.40 s, slowest 1\.60 s over 3 rounds; every stop saved \(the slowest over 1\.5 s at the largest\)$/);
  x = byId(R.judge(raw({ R1: sizes([round(1600), round(1700), round(900, { saved: false })]) })), 'R1');
  assert.equal(x.state, 'missed');
  assert.match(x.words, /median 1\.60 s, slowest 1\.70 s over 3 rounds; 1 stop did not say it saved \(the slowest over 1\.5 s at the largest\)$/);
  x = byId(R.judge(raw({ R1: sizes([round(1000), { error: 'the page was not back within 60 s', stopMs: 400, saved: true, pageBackMs: null }]) })), 'R1');
  assert.equal(x.state, 'met', 'a round that did not finish is said beside those that did');
  assert.match(x.words, /over 1 round; every stop saved; 1 round did not finish/);
  x = byId(R.judge(raw({ R1: { sizes: [{ name: 'empty', halls: 1, messages: 0, rounds: [round(700)] }, { name: 'large', halls: 20, messages: 10000, error: 'the bundle did not serve: …', rounds: [] }] } })), 'R1');
  assert.equal(x.state, 'not run', 'no page back at the largest hall: the mark is not judged');
  assert.match(x.words, /at 20 halls × 10,000: no page back \(the bundle did not serve: …\).*: no page came back at the largest real hall$/);
  assert.equal(byId(R.judge(raw({ R1: { rounds: [100] } })), 'R1').state, 'not run', 'a record of another shape');
  assert.equal(byId(R.judge(raw({ R1: { skipped: 'not taken: the lane\'s deadline (3 min left of its 38 min, and its own bound is 10 min)' } })), 'R1').words, 'not taken: the lane\'s deadline (3 min left of its 38 min, and its own bound is 10 min)');
});

test('R1 as the lane takes it, on this machine with this checkout: halls seeded, a page seated, the stop at loopback with the proof, the next start, the page back at its own pace; no token kept', async () => {
  const work = tmp('agm-r1-');
  const port = await h.freePort();
  // The hall page's pace, read from the page's own OPTIONS, so a change to the pages' pace moves the reading with it:
  // from 0.5 s doubling to 2 s, each ±50 %.
  const page = /const OPTIONS = Object\.freeze\(\{ reconnectionDelay: (\d+), reconnectionDelayMax: (\d+), randomizationFactor: ([\d.]+) \}\);/.exec(h.readSource(path.join(h.ROOT, 'public', 'reconnect.js')));
  assert.ok(page, 'reconnect.js names its OPTIONS on one line');
  assert.deepEqual(T.PAGE_PACE, { delayMs: Number(page[1]), maxMs: Number(page[2]), jitter: Number(page[3]) }, 'the reading\'s pace is the hall page\'s');
  for (let tries = 0; tries < 6; tries++) {
    for (let i = 0; i < 20; i++) {
      const base = Math.min(500 * 2 ** tries, 2000);
      const w = T.paceMs(tries);
      assert.ok(w >= base / 2 && w <= Math.min(base * 1.5, 2000), tries + ': ' + w);
    }
  }
  const codes = T.seedHalls(path.join(work, 'seed'), { halls: 2, messages: 3, at: 1_800_000_000_000 });
  assert.deepEqual(codes, ['GAP001', 'GAP002']);
  const snap = JSON.parse(fs.readFileSync(path.join(work, 'seed', 'rooms', 'GAP002.json'), 'utf8'));
  assert.deepEqual([snap.code, snap.seq, snap.messages.length, snap.messages[2].seq, snap.messages[2].at], ['GAP002', 3, 3, 3, 1_800_000_000_000]);
  // By default its newest message is from before the busy line's window: a hall between shows, so the stop the reading
  // asks needs no reason typed.
  const before = Date.now();
  T.seedHalls(path.join(work, 'quiet'), { halls: 1, messages: 2 });
  const quiet = JSON.parse(fs.readFileSync(path.join(work, 'quiet', 'rooms', 'GAP001.json'), 'utf8'));
  assert.ok(T.R1_QUIET_MS > busyLine.WINDOW_MS && quiet.messages[1].at <= before - T.R1_QUIET_MS + 1000, String(quiet.messages[1].at));
  assert.deepEqual(T.R1_SIZES, [{ name: 'empty', halls: 1, messages: 0 }, { name: 'large', halls: 20, messages: 10000 }], 'the plan\'s two folders');
  try {
    const r = await T.takeR1({ node: process.execPath, app: h.ROOT, work, port }, { sizes: [{ name: 'empty', halls: 1, messages: 0 }, { name: 'large', halls: 3, messages: 400 }], rounds: 2, startMs: 30000 });
    assert.deepEqual(r.sizes.map((z) => [z.name, z.rounds.length, z.error]), [['empty', 2, undefined], ['large', 2, undefined]], JSON.stringify(r));
    for (const z of r.sizes) {
      assert.ok(Number.isFinite(z.firstMs), z.name + ' served first');
      for (const x of z.rounds) {
        assert.equal(x.error, undefined, JSON.stringify(x));
        assert.equal(x.saved, true, 'each stop saved and said so in last-stop.json');
        assert.equal(x.code, 0, 'and its watchdog ended with 0, as stopped');
        assert.ok(x.stopMs >= 0 && x.healthMs >= 0 && x.pageBackMs >= x.stopMs && x.tries >= 1, JSON.stringify(x));
      }
    }
    const judged = byId(R.judge(raw({ R1: r })), 'R1');
    assert.ok(['met', 'missed'].includes(judged.state), judged.words);
    assert.match(judged.words, /^at an empty hall: page back median .+; at 3 halls × 400: page back median .+; every stop saved/);
    // The token made for the reading is in no part of the record, and no 16 hex characters are either.
    assert.doesNotMatch(JSON.stringify(r), /[0-9a-f]{16}/);
    // Each stop was the machine's at loopback, not a signal: the server said so as it stopped. Each round's is a stop, not
    // an upgrade's, so no backup for the way back is in the gap (R9 times that on its own), and the lane's own at its end.
    const log = fs.readFileSync(path.join(work, 'r1', 'large', 'data', 'logs', 'server.log'), 'utf8');
    assert.equal((log.match(/Stopping for a stop, asked at loopback by the readings lane\./g) || []).length, 3, log.slice(-2000));
    assert.equal((log.match(/Stopping for an upgrade/g) || []).length, 0, 'no round is an upgrade\'s');
    const backups = path.join(work, 'r1', 'large', 'data', 'backups');
    assert.deepEqual((fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter((n) => n.startsWith('upgrade-')), [], 'and no backup for the way back was made in the gap');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('R12 as the lane takes it: each exit its own task and folder, so a restart the exit-1 task still has queued is never counted as a start after exit 0', async () => {
  const dir = tmp('agm-r12-');
  const timers = [];
  // Task Scheduler as its schema says RestartOnFailure acts (a start that ends non-zero is started again an interval later,
  // up to Count times), at 30 ms for a minute; and at its worst: a queued restart survives End and Delete.
  const scheduler = ({ restartOnZero = false } = {}) => {
    const tasks = new Map();
    const calls = [];
    const start = (t) => {
      fs.appendFileSync(path.join(t.own, 'starts.log'), new Date().toISOString() + '\n');
      const code = Number(fs.readFileSync(path.join(t.own, 'code'), 'utf8'));
      if ((code !== 0 || restartOnZero) && t.restarts < 3) { t.restarts++; timers.push(setTimeout(() => start(t), 30)); }
    };
    const L = {
      register: (name, xml) => { tasks.set(name, { own: /probe-exit (\S+)<\/Arguments>/.exec(xml)[1], restarts: 0 }); calls.push('register ' + name); },
      schtasks: (args) => { calls.push(args.join(' ')); if (args[0] === '/Run') start(tasks.get(args[2])); return { code: 0, out: '', err: '' }; },
      lastResult: () => 0,
      remove: (name) => { calls.push('remove ' + name); },
    };
    return { L, calls };
  };
  const where = { node: 'C:\\agm-readings\\payload\\AGMessage\\node\\node.exe', self: 'C:\\agm-readings\\lane\\readings-take.js', cwd: 'C:\\agm-readings\\lane' };
  const quick = { nonZeroMs: 3000, zeroMs: 400, every: 10 };
  try {
    const s1 = scheduler();
    const r = await T.takeR12(s1.L, { ...where, dir: path.join(dir, 'a') }, quick);
    assert.deepEqual(r.tasks, [T.RESTART_TASKS.nonZero, T.RESTART_TASKS.zero]);
    assert.ok(r.nonZero.starts >= 2, 'the exit 1 was started again');
    assert.equal(r.zero.starts, 1, 'the exit-1 task\'s queued restarts landed in its own folder, never in this one');
    assert.ok(fs.readFileSync(path.join(dir, 'a', 'non-zero', 'starts.log'), 'utf8').split('\n').filter(Boolean).length >= 3, 'its restarts did come, during the exit 0\'s watch');
    assert.deepEqual(s1.calls, ['register ' + T.RESTART_TASKS.nonZero, '/Run /TN ' + T.RESTART_TASKS.nonZero, 'remove ' + T.RESTART_TASKS.nonZero, 'register ' + T.RESTART_TASKS.zero, '/Run /TN ' + T.RESTART_TASKS.zero, 'remove ' + T.RESTART_TASKS.zero], 'the exit-1 task measured and removed before the exit-0 task is made');
    assert.equal(byId(R.judge(raw({ R12: r })), 'R12').state, 'recorded');
    // A scheduler that starts an exit 0 again is the miss, read as such.
    const s2 = scheduler({ restartOnZero: true });
    const again = await T.takeR12(s2.L, { ...where, dir: path.join(dir, 'b') }, quick);
    assert.ok(again.zero.starts >= 2);
    assert.equal(byId(R.judge(raw({ R12: again })), 'R12').state, 'missed');
    // A task that cannot be run is said, and removed all the same.
    const s3 = scheduler();
    s3.L.schtasks = (args) => { s3.calls.push(args.join(' ')); return { code: 1, out: '', err: 'ERROR: Access is denied.' }; };
    await assert.rejects(T.takeR12(s3.L, { ...where, dir: path.join(dir, 'c') }, quick), /schtasks could not run the stand-in: ERROR: Access is denied\./);
    assert.deepEqual(s3.calls.filter((c) => c.startsWith('remove')), ['remove ' + T.RESTART_TASKS.nonZero]);
  } finally {
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    for (const t of timers) clearTimeout(t);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the lane bounds itself

test('the lane bounds itself: a reading begins only while its own bound fits in the deadline, is written as it begins and as each round is taken, ends its waits at its bound, is cut with its rounds kept, and the lane goes on', async () => {
  const raw = { v: 1, readings: {}, complete: false };
  const saved = [];
  const lines = [];
  const late = [];
  const plan = [
    ['S', () => ({ never: true })],
    ['A', () => ({ value: 1 })],
    // Reports a round, then never ends inside its bound: cut once its settle has passed. When it wakes later, past its
    // bound, no program of it starts, though the next reading is running under a bound of its own.
    ['B', async (progress) => {
      progress({ rounds: [1] });
      await new Promise((resolve) => { setTimeout(resolve, 450); });
      late.push(T.run(process.execPath, ['-e', '0']));
      progress({ rounds: [1, 2] });
      return { late: true };
    }],
    ['C', () => ({ never: true })],
    // Every wait of it ends at its bound, and nothing of it is started past it: written cut, what it took kept.
    ['D', async () => {
      const t0 = Date.now();
      const waited = await T.until(() => false, 60_000, 10);
      return { waited, waitedMs: Date.now() - t0, ran: T.run(process.execPath, ['-e', '0']) };
    }],
    ['E', () => { throw new Error('it met something'); }],
  ];
  const t0 = Date.now();
  await T.takeAll(plan, {
    raw,
    save: () => { saved.push(JSON.parse(JSON.stringify(raw.readings))); },
    say: (line) => lines.push(line),
    deadlineMs: 3000,
    boundsMs: { S: 100, A: 300, B: 100, C: 5000, D: 1000, E: 300 },
    skip: new Map([['S', 'not taken here: left to a take of its own']]),
    settleMs: 50,
  });
  assert.ok(Date.now() - t0 < 2500, 'the lane went on past the reading that did not end: ' + (Date.now() - t0) + ' ms');
  assert.deepEqual(raw.readings.S, { skipped: 'not taken here: left to a take of its own' });
  assert.deepEqual(raw.readings.A, { value: 1 });
  assert.deepEqual(raw.readings.B.rounds, [1], 'its rounds so far, as it last reported them');
  assert.match(raw.readings.B.cut, /^its own bound of 0\.1 s: it had not ended 0\.1 s after it$/);
  assert.equal(raw.readings.B.running, undefined, 'no longer said to be running');
  assert.match(raw.readings.C.skipped, /^not taken: the lane's deadline \([\d.]+ s left of its 3 s, and its own bound is 5 s\)$/);
  assert.equal(raw.readings.D.waited, null);
  assert.ok(raw.readings.D.waitedMs >= 900 && raw.readings.D.waitedMs < 1500, 'its wait of a minute ended at its bound of a second: ' + raw.readings.D.waitedMs);
  assert.deepEqual([raw.readings.D.ran.code, raw.readings.D.ran.err], [null, 'not started: the reading\'s own bound was reached']);
  assert.match(raw.readings.D.cut, /^its own bound of 1 s, reached before it ended: what it took by then is kept, never judged$/);
  assert.deepEqual(raw.readings.E, { error: 'it met something' });
  // The record as it was written: each reading said as it began, its round written while it ran, then its end.
  const asB = saved.filter((r) => r.B);
  assert.match(asB[0].B.running, /^begun at \d+ s, its own bound 0\.1 s$/);
  assert.deepEqual(asB[1].B.rounds, [1], 'the round it reported, written while it ran');
  assert.ok(asB[1].B.running, 'and still said to be running then');
  assert.equal(saved.length, 11, 'written as each began, as it reported and as each ended (S, A twice, B three times, C, D twice, E twice)');
  for (const id of ['A', 'B', 'D', 'E']) assert.ok(Number.isInteger(raw.times[id].begunS) && Number.isInteger(raw.times[id].s), id + '\'s begin and length kept');
  assert.equal(raw.times.C, undefined, 'one not begun has no time');
  assert.ok(lines.some((l) => /^readings-take: B begun at \d+ s, its own bound 0\.1 s$/.test(l)) && lines.some((l) => /^readings-take: B cut at its own bound/.test(l)), lines.join('\n'));
  // The reading cut at its bound woke inside the next one's: its own bound, spent, still held it, and what it reported
  // then was not written over its record.
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  assert.deepEqual(late.map((r) => [r.code, r.err]), [[null, 'not started: the reading\'s own bound was reached']]);
  assert.deepEqual(raw.readings.B.rounds, [1]);
  // Outside a reading nothing is shortened.
  assert.equal(T.left(), Infinity);
  assert.equal(T.within(1234), 1234);
  assert.equal(T.run(process.execPath, ['-e', '0']).code, 0);
});

test('what the lane made is removed at its end, and at a signal its record is written at once and its tasks and rules removed before it exits 2', () => {
  const calls = [];
  const fake = (gone = () => true) => ({
    remove: (name, ms) => { calls.push(['remove', name, ms]); if (gone(name)) T.held.tasks.delete(name); },
    ruleDelete: (name, ms) => { calls.push(['rule', name, ms]); if (gone(name)) T.held.rules.delete(name); },
    ps: (script, env, opts) => { calls.push(['ps', script === T.SCRIPTS.usersGone ? 'usersGone' : 'other', env.AGM_R11_USERS, opts.always]); },
  });
  const empty = () => ({ tasks: [...T.held.tasks], rules: [...T.held.rules], accounts: [...T.held.accounts], pids: [...T.held.pids] });
  try {
    T.held.tasks.add('\\AGMessage-Readings\\R11-As-own');
    T.held.tasks.add('\\AGMessage\\Server');
    T.held.rules.add('AGMessage-readings-R4');
    T.held.accounts.add('agmr11own');
    T.held.accounts.add('agmr11other');
    // One task Windows will not delete stays named as left.
    const r = T.release(fake((name) => name !== '\\AGMessage\\Server'));
    assert.deepEqual(r, { removed: ['\\AGMessage-Readings\\R11-As-own', 'rule AGMessage-readings-R4', 'account agmr11own', 'account agmr11other'], left: ['\\AGMessage\\Server'] });
    assert.deepEqual(calls.find((c) => c[0] === 'ps'), ['ps', 'usersGone', 'agmr11own,agmr11other', true], 'the accounts removed whatever is left of a reading\'s bound');
    assert.deepEqual(calls.filter((c) => c[0] === 'remove').map((c) => c[2]), [15000, 15000], 'each act bounded');
    assert.deepEqual(empty(), { tasks: ['\\AGMessage\\Server'], rules: [], accounts: [], pids: [] });
    T.held.tasks.clear();
    // A signal: the record written at once, not whole, then the tasks and rules removed within the runner's grace; the
    // accounts are left to the runner, which is thrown away, and named.
    calls.length = 0;
    T.held.tasks.add('\\AGMessage-Readings\\Serve');
    T.held.rules.add('AGMessage-readings-R13-offline');
    T.held.accounts.add('agmr6export');
    const raw = { v: 1, complete: false, readings: { R2: { files: 1 } }, takes: [{ at: 'x', ended: '' }] };
    const writes = [];
    let exited = null;
    const said = [];
    T.stopOn('SIGINT', { raw, save: () => writes.push(JSON.parse(JSON.stringify(raw))), L: fake(), began: performance.now() - 2700_000, exit: (code) => { exited = code; }, say: (l) => said.push(l) });
    assert.equal(exited, 2);
    assert.equal(writes.length, 2, 'written at once, then again with what was removed');
    assert.deepEqual([writes[0].complete, writes[0].stopped, writes[0].takes[0].stopped], [false, 'SIGINT at 2700 s', 'SIGINT at 2700 s']);
    assert.deepEqual(writes[0].readings, { R2: { files: 1 } }, 'what was taken is kept');
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['remove', '\\AGMessage-Readings\\Serve', 2500], ['rule', 'AGMessage-readings-R13-offline', 2500]], 'each act within 2.5 s, and no account removed in the runner\'s grace');
    assert.deepEqual(writes[1].cleanup, { removed: ['\\AGMessage-Readings\\Serve', 'rule AGMessage-readings-R13-offline'], left: ['account agmr6export'] });
    assert.match(said[0], /^readings-take: stopped by SIGINT at 2700 s; the record is written, not whole; still there: account agmr6export$/);
    // The judge reads a lane stopped there: what it took judged, what it had not reached not run, saying what stopped it.
    const judged = R.judge({ ...writes[1], build: STAMP, ...DEFENDER_ON });
    assert.equal(judged.complete, false);
    assert.equal(byId(judged, 'R1').words, 'not taken: the lane ended before it (stopped by SIGINT at 2700 s)');
  } finally {
    for (const k of ['tasks', 'rules', 'accounts', 'pids']) T.held[k].clear();
  }
});

test('the judge reads a reading the lane began and never ended, and one cut at its own bound, as not run with why, never judging what they kept', () => {
  const begun = R.judge(raw({ R11: { running: 'begun at 612 s, its own bound 12 min', own: [{ code: 0, answered: true, ranAs: 'S-1-5-18', for: 'S-1-5-21-1' }] } }));
  assert.deepEqual([byId(begun, 'R11').state, byId(begun, 'R11').words], ['not run', 'not taken: begun at 612 s, its own bound 12 min, it never ended: the lane stopped in it']);
  const stopped = R.judge(raw({ R11: { running: 'begun at 612 s, its own bound 12 min' } }, { complete: false, stopped: 'SIGBREAK at 700 s' }));
  assert.match(byId(stopped, 'R11').words, /it never ended: the lane stopped in it \(SIGBREAK at 700 s\)$/);
  const cut = R.judge(raw({ 'R3′': { rounds: [{ saved: true, lastResult: 0 }], savedCount: 1, cut: 'its own bound of 8 min, reached before it ended: what it took by then is kept, never judged' } }));
  assert.deepEqual([byId(cut, 'R3′').state, byId(cut, 'R3′').words], ['not run', 'not taken: cut at its own bound of 8 min, reached before it ended: what it took by then is kept, never judged']);
  const deadline = R.judge(raw({ R13: { skipped: 'not taken: the lane\'s deadline (3 min left of its 38 min, and its own bound is 5 min)' } }));
  assert.deepEqual([byId(deadline, 'R13').state, byId(deadline, 'R13').words], ['not run', 'not taken: the lane\'s deadline (3 min left of its 38 min, and its own bound is 5 min)']);
});

test('the take\'s words: a deadline, the readings a take takes or leaves, the record it adds to; it exits once its record is written', async () => {
  assert.deepEqual(T.parseArgs(['take', '--zip', 'a', '--add', '--deadline-min', '38', '--skip', 'R11,R6']).flags, { zip: 'a', add: true, 'deadline-min': '38', skip: 'R11,R6' });
  assert.deepEqual(T.readingsOf('R11,R6'), ['R11', 'R6']);
  assert.deepEqual(T.readingsOf('R3′'), ['R3′']);
  assert.deepEqual(T.readingsOf(undefined), []);
  assert.deepEqual(T.readingsOf('R11,'), ['R11'], 'an empty name between commas is no reading');
  for (const bad of ['R99', ',', 'r11', 'R11,R99']) assert.equal(T.readingsOf(bad), null, bad);
  const dir = tmp('agm-words-');
  try {
    const flags = ['take', '--zip', path.join(dir, 'x.zip'), '--defender', path.join(dir, 'd.json'), '--out', path.join(dir, 'o.json')];
    for (const [more, words] of [[['--deadline-min', '0'], /--deadline-min is a whole number of minutes from 1 to 240/], [['--deadline-min', '2.5'], /--deadline-min is a whole number/], [['--only', 'R99'], /--only and --skip name readings the lane takes/], [['--skip', 'R1,R14'], /--only and --skip name readings the lane takes/]]) {
      const r = spawnSync(process.execPath, [TAKE_JS, ...flags, ...more], { encoding: 'utf8' });
      assert.equal(r.status, 64, more.join(' '));
      assert.match(r.stderr, words);
    }
    // The record an earlier take wrote: added to when it is the lane's; a new one when there is none; never written over
    // when it is not the lane's.
    const file = path.join(dir, 'raw.json');
    assert.deepEqual(T.recordAt(file), {});
    fs.writeFileSync(file, 'not json');
    assert.match(T.recordAt(file).refused, /is not the lane's record, so it is not added to or written over$/);
    fs.writeFileSync(file, JSON.stringify({ v: 2, readings: {} }));
    assert.ok(T.recordAt(file).refused);
    fs.writeFileSync(file, '﻿' + JSON.stringify({ v: 1, readings: { R2: { files: 3 } }, takes: [{ at: 'x' }] }));
    assert.deepEqual(T.recordAt(file).raw.readings, { R2: { files: 3 } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // A take ends once its console is flushed, whatever handle is still open; a probe's end is its loop's, as its task expects.
  const before = process.exitCode;
  try {
    const exits = [];
    T.finish('probe-run', 0, { exit: (c) => exits.push(c) });
    await new Promise((resolve) => { T.finish('take', 0, { exit: (c) => { exits.push(c); resolve(); } }); });
    assert.deepEqual(exits.slice(0, 2), [0], 'only the take is ended');
  } finally { process.exitCode = before; }
  // Each reading the lane takes, in its order: the two as standard accounts last, after every reading taken before any
  // account was made; each with a bound of its own.
  assert.deepEqual(T.ORDER.slice(-2), ['R11', 'R6']);
  assert.deepEqual([...T.ORDER].sort(), Object.keys(T.BOUNDS).sort());
  assert.ok(T.DEADLINE_MIN + T.STOP_MIN < 45, 'a take given no deadline still ends inside the 45 minutes the step once had');
  // The task the lane runs as a made account has a time limit of its own (its action is one schtasks /run).
  const src = h.readSource(TAKE_JS);
  assert.match(src, /L\.register\(asName, taskXml\(\{ description: 'AGMessage readings R11: schtasks \/run of a control task, as ' \+ u\.name, sid: u\.sid, logon: 'Password', limit: 'PT10M',/);
  // Every account the lane makes is held before PowerShell is asked to make it, so one made before a failure is removed.
  assert.ok(src.indexOf('for (const n of names) held.accounts.add(n);') < src.indexOf('L.ps(SCRIPTS.users, { AGM_R11_USERS: names.join(\',\')'));
  assert.ok(src.indexOf('held.accounts.add(R6_USER);') < src.indexOf('L.ps(SCRIPTS.users, { AGM_R11_USERS: R6_USER'));
});

test('a take given Defender\'s record reads it again at its end; one added after Defender was turned back off (--add, no --defender) keeps the record\'s and asks nothing of it; each take says which it was, and each reading the take that took it; take() is wired to these and reads Defender nowhere else', async () => {
  const dir = tmp('agm-takes-');
  try {
    // A take on its own needs Defender's record; one that adds to a record may be given none.
    const flags = ['take', '--zip', path.join(dir, 'x.zip'), '--out', path.join(dir, 'o.json'), '--work', path.join(dir, 'work')];
    const alone = spawnSync(process.execPath, [TAKE_JS, ...flags], { encoding: 'utf8' });
    assert.equal(alone.status, 64);
    assert.match(alone.stderr, /^readings-take: take --zip <bundle\.zip> --out <raw\.json> --defender <defender\.json> \(left out only with --add, after Defender was turned back off\)/, 'refused, with the words');
    // …which goes on to what any take asks first: Windows, then the bundle (a GitHub-hosted runner's Windows job reads it).
    const added = spawnSync(process.execPath, [TAKE_JS, ...flags, '--add'], { encoding: 'utf8', env: { ...process.env, RUNNER_ENVIRONMENT: 'github-hosted' } });
    assert.doesNotMatch(added.stderr, /take --zip <bundle\.zip>/, 'an --add without --defender is not refused for it: ' + added.stderr);
    if (process.platform === 'win32') assert.deepEqual([added.status, /nothing was taken/.test(added.stderr)], [2, true], added.stderr);
    else assert.deepEqual([added.status, /the readings are Windows'; nothing was taken/.test(added.stderr)], [64, true], added.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'o.json')) && !fs.existsSync(path.join(dir, 'work')), 'and nothing was taken here');
    // The record a take begins.
    const file = path.join(dir, 'defender.json');
    fs.writeFileSync(file, '﻿' + JSON.stringify({ v: 1, after: ON, took: true, errors: [] }));
    const said = [];
    const first = T.beginRecord({}, { defender: file, deadlineMin: 6, only: ['R2', 'R9', 'R10'] }, {}, { say: (l) => said.push(l) });
    assert.deepEqual(first.raw.defender, { v: 1, after: ON, took: true, errors: [] });
    assert.deepEqual([first.step.defender, first.step.deadlineMin, first.step.only, first.step.ended, first.raw.complete], [true, 6, ['R2', 'R9', 'R10'], '', false]);
    assert.deepEqual(first.raw.takes, [first.step]);
    first.raw.defenderEnd = ON;
    first.raw.readings = { R2: { files: 3 } };
    first.raw.complete = true;
    first.raw.stopped = 'x';
    const was = JSON.parse(JSON.stringify(first.raw));
    const next = T.beginRecord({ raw: was }, { deadlineMin: 26, skip: ['R2', 'R9', 'R10', 'R11', 'R6'] }, {});
    assert.equal(next.raw, was, 'added to the record before');
    assert.deepEqual([next.raw.defender, next.raw.defenderEnd], [first.raw.defender, ON], 'Defender kept as the take before wrote it');
    assert.deepEqual(next.raw.takes.map((t) => t.defender), [true, false], 'each take says whether it was taken with Defender');
    assert.deepEqual([next.raw.complete, 'stopped' in next.raw, next.raw.readings], [false, false, { R2: { files: 3 } }]);
    // A record that cannot be read is said, and Defender is not asked.
    const unread = T.beginRecord({}, { defender: path.join(dir, 'none.json') }, {}, { say: (l) => said.push(l) });
    assert.deepEqual([unread.raw.defender, unread.step.defender], [null, true]);
    assert.match(said.join('\n'), /^readings-take: no Defender record \(/);
    // Its end: Defender read again only by a take taken with it.
    const asked = [];
    const L = { ps: (script) => { asked.push(script === T.SCRIPTS.defender ? 'defender' : 'other'); return { ...ON, realtime: false }; } };
    await T.endRecord(next.raw, next.step, L);
    assert.deepEqual(asked, [], 'a take without Defender asks Windows nothing of it');
    assert.deepEqual([next.raw.defenderEnd, next.raw.complete, typeof next.step.ended], [ON, true, 'string']);
    assert.ok(next.step.ended);
    await T.endRecord(first.raw, first.step, L);
    assert.deepEqual([asked, first.raw.defenderEnd.realtime], [['defender'], false], 'a take with Defender reads it again');
    // Each reading begun names the take that took it, and one left to another take that the record holds is kept.
    const rec = { v: 1, readings: { R2: { files: 3 } }, times: { R2: { begunS: 1, s: 142, take: 0 } } };
    const lines = [];
    await T.takeAll([['R2', () => ({ never: true })], ['R5', () => ({ files: [] })], ['R11', () => ({ never: true })]], {
      raw: rec, save: () => {}, say: (l) => lines.push(l), deadlineMs: 60_000, boundsMs: { R2: 1000, R5: 1000, R11: 1000 },
      skip: new Map([['R2', 'left'], ['R11', 'left to a take of its own']]), take: 1,
    });
    assert.deepEqual(rec.readings, { R2: { files: 3 }, R5: { files: [] }, R11: { skipped: 'left to a take of its own' } });
    assert.deepEqual([rec.times.R2, rec.times.R5.take, rec.times.R11], [{ begunS: 1, s: 142, take: 0 }, 1, undefined]);
    assert.ok(lines.includes('readings-take: R2 left to another take, and kept as the record it adds to holds it'), lines.join('\n'));
    // A take given no index writes none, as the record of one take did.
    const one = { v: 1, readings: {} };
    await T.takeAll([['R5', () => ({ files: [] })]], { raw: one, save: () => {}, say: () => {}, deadlineMs: 60_000, boundsMs: { R5: 1000 } });
    assert.equal('take' in one.times.R5, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // take() itself runs only on Windows: its wiring to what is run above is read from its source. One record begun and one
  // ended, after the cleanup; every reading given this take's index (the last of `takes`, the one beginRecord added); and
  // Defender read again nowhere but in endRecord, which reads it only for a take given its record.
  const src = read('tools/readings-take.js');
  const fn = (head) => {
    const at = src.indexOf('\n' + head);
    assert.ok(at > 0, head + ' is in tools/readings-take.js');
    return src.slice(at, src.indexOf('\n}\n', at) + 3);
  };
  const takeSrc = fn('async function take(o) {\n');
  assert.deepEqual([(takeSrc.match(/\bbeginRecord\(/g) || []).length, (takeSrc.match(/\bendRecord\(/g) || []).length], [1, 1], 'one record begun and one ended');
  assert.ok(takeSrc.includes('\n  const { raw, step } = beginRecord(was, o, env);\n'), 'the record begun from the one it adds to and this take\'s words');
  assert.ok(takeSrc.includes('\n  await endRecord(raw, step, L);\n'), 'the record ended, awaited, with this take\'s step');
  assert.ok(takeSrc.indexOf('raw.cleanup = release(L);') > 0 && takeSrc.indexOf('raw.cleanup = release(L);') < takeSrc.indexOf('await endRecord('), 'after the cleanup');
  const optsAt = takeSrc.indexOf('\n    const opts = {\n');
  const optsSrc = takeSrc.slice(optsAt, takeSrc.indexOf('\n    };\n', optsAt));
  assert.ok(optsAt > 0 && /\n {6}take: raw\.takes\.length - 1,(\n|$)/.test(optsSrc), 'each reading given this take\'s index: ' + optsSrc);
  assert.equal((takeSrc.match(/\bawait takeAll\(plan\([^\n]*\), opts\);/g) || []).length, 2, 'R2 and the rest each taken with those opts');
  assert.equal((takeSrc.match(/\btakeAll\(/g) || []).length, 2, 'and by no other call');
  assert.equal((src.match(/SCRIPTS\s*(?:\.\s*defender\b|\[\s*['"`]defender['"`]\s*\])/g) || []).length, 1, 'Defender\'s script named once in the file');
  assert.equal((src.match(/L\.ps\(SCRIPTS\.defender\)/g) || []).length, 1);
  assert.ok(fn('async function endRecord(').includes('\n  if (step.defender) raw.defenderEnd = await guarded(() => L.ps(SCRIPTS.defender));\n'), 'read again only in endRecord, only for a take given its record');
  assert.ok(!/defenderEnd\s*=/.test(takeSrc), 'take() never writes Defender\'s end itself');
});

test('a page the lane seats waits for an answer within its bound: a server that takes the socket and answers nothing gives null, never a wait for ever', async () => {
  const { WebSocketServer } = require('ws');
  const port = await h.freePort();
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  // Engine.IO's open, then the namespace taken; every event after that is heard and never answered.
  wss.on('connection', (ws) => {
    ws.send('0' + JSON.stringify({ sid: 'readings', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 }));
    ws.on('message', (m) => { if (String(m).startsWith('40')) ws.send('40' + JSON.stringify({ sid: 'page' })); });
  });
  try {
    await new Promise((resolve) => { wss.on('listening', resolve); });
    const page = await T.pageSocket(port, { build: 'readings', ms: 5000 });
    assert.ok(page, 'the server took the page');
    const t0 = Date.now();
    assert.equal(await page.emit('join', { roomCode: 'GAP001' }, 300), null);
    assert.ok(Date.now() - t0 < 2000, 'its answer waited for at most its bound: ' + (Date.now() - t0) + ' ms');
    page.close();
    await page.closed;
  } finally { await new Promise((resolve) => { wss.close(resolve); }); }
});

// ---------------------------------------------------------------- what is written: the summary, the notes, the command line

test('the notes: each miss with its fallback, then what was met, open and not run; the lab lines as docs/INSTALL.md records them; no readings said so', () => {
  const j = R.judge(raw({ R2: { files: 5122, bytes: 197_000_000, rounds: [3000], over: 'v0.5.1' }, R4: R4_SERVED, R10: { rounds: [{ extractMs: 5100, runMs: 300, totalMs: 5400, code: 0 }] } }));
  const install = '| Lab | What | Pass | Taken |\n|---|---|---|---|\n| Lab 1 | lid | serving | not run |\n| Lab 4 | Smart App Control | recorded | 2026-11-20, build 0.6.0+41: node.exe and cloudflared.exe ran; the installer was blocked |\n';
  assert.deepEqual(R.labRecord(install), { 'Lab 1': 'not run', 'Lab 4': '2026-11-20, build 0.6.0+41: node.exe and cloudflared.exe ran; the installer was blocked' });
  const n = R.notes(j, install);
  assert.match(n, /^### The Windows readings\n\nBuild 0\.6\.0 \(build 40, abc1234def01\)\. Taken on win25 20261027\.1 at 2026-11-02T10:00:00\.000Z\. Defender's real-time monitoring on/);
  assert.match(n, /\*\*Missed their mark:\*\*\n- R10: the slowest of 1 round 5\.40 s \(extracted, then run once\): over 5 s\. Mark: recorded\. So: over 5 s: an upgrade runs its checks with the installed `node\.exe`\.\n/);
  assert.match(n, /\*\*Met or recorded:\*\* R4 \(/);
  assert.match(n, /\*\*Open:\*\* R2 \(/);
  assert.match(n, /\*\*Not run:\*\* R1 \(not taken by this lane\); R3′ \(not taken by this lane\)/);
  assert.match(n, /Lab 1 not run; Lab 2 not run; Lab 3 not run; Lab 4 2026-11-20, build 0\.6\.0\+41: node\.exe/);
  assert.ok(!n.includes('R3 ('), 'a retired reading is not listed as not run');
  const none = R.notes(null, '');
  assert.match(none, /were not taken for this build \(the evidence lane wrote none\): nothing is claimed for them/);
  assert.match(none, /Lab 1 not run;.*Lab 7 not run\.\n$/);
  assert.match(R.notes(R.judge(raw({ R5: { files: [{ path: 'x\\node.exe', status: 'Valid' }, { path: 'x\\cloudflared.exe', status: 'Valid' }] } })), ''), /\*\*No reading missed its mark\.\*\*/);
  // Whatever a file holds that is not the lane's verdicts, the notes say they could not be read, and claim nothing.
  for (const bad of [{}, [], 'text', 7, { readings: [] }, { readings: [null] }, { v: 1, defender: { words: 'on' }, readings: [], labs: [] },
    { v: 1, defender: { words: 'on' }, labs: [], readings: [{ id: 'R1', state: 'bogus', words: '', mark: '', miss: '' }] },
    { v: 1, defender: { words: 'on' }, labs: [], readings: [{ id: 'R1', state: 'met', words: 7, mark: '', miss: '' }] },
    { ...j, defender: null }, { ...j, v: 2 }, { ...j, labs: undefined }]) {
    assert.equal(R.isJudged(bad), false, JSON.stringify(bad).slice(0, 80));
    assert.match(R.notes(bad, install), /^### The Windows readings\n\nThe Windows readings for this build could not be read \(the evidence lane's file is not its verdicts\): nothing is claimed for them\./);
  }
  assert.equal(R.isJudged(j), true);
  assert.match(R.notes(undefined, ''), /were not taken for this build/);
  // A lane cut short says so beside what it took.
  const cut = R.judge(raw({ R2: { files: 1, bytes: 1, rounds: [100] } }, { complete: false, defenderEnd: null }));
  assert.equal(cut.complete, false);
  assert.equal(byId(cut, 'R5').words, 'not taken: the lane ended before it (cut short)');
  assert.match(R.notes(cut, ''), /The lane was cut short: a reading it had not reached reads not run\. Defender came on, .* not read again when the readings taken with it ended\./);
  assert.match(R.summary(cut), /The lane was cut short/);
  assert.equal(R.judge(raw({})).complete, true, 'a record that does not say it was cut short is whole');
  const s = R.summary(j);
  for (const x of R.READINGS) assert.ok(s.split('\n').some((l) => l.startsWith('| ' + x.id + ' | ')), x.id + ' has a row');
  assert.match(s, /^\| R10 \| ✕ missed \| /m);
  assert.match(s, /^\| Lab 7 \| ○ not run \| /m);
});

test('the command line: judge writes every verdict and exits 0 on a miss, 2 on a record that is not the lane\'s; notes always exit 0', () => {
  const dir = tmp('agm-readings-');
  try {
    const node = (...a) => spawnSync(process.execPath, [READINGS_JS, ...a], { encoding: 'utf8' });
    const rawFile = path.join(dir, 'raw.json');
    fs.writeFileSync(rawFile, '\uFEFF' + JSON.stringify(raw({ R10: { rounds: [{ totalMs: 9000 }] } })));
    const out = path.join(dir, 'out', 'readings.json');
    const sum = path.join(dir, 'summary.md');
    let r = node('judge', rawFile, '--out', out, '--summary', sum);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(j.readings.find((x) => x.id === 'R10').state, 'missed', 'a miss is written, and the build goes on');
    assert.equal(j.readings.length, R.READINGS.length);
    assert.match(fs.readFileSync(sum, 'utf8'), /^## The Windows readings \(the evidence lane\)/);
    assert.match(r.stdout, /^R10 {2}✕ missed /m);
    for (const bad of ['{"v":1', JSON.stringify({ v: 2, readings: {} }), JSON.stringify({ v: 1 })]) {
      fs.writeFileSync(rawFile, bad);
      fs.rmSync(out, { force: true });
      r = node('judge', rawFile, '--out', out);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /nothing is judged/);
      assert.ok(!fs.existsSync(out), 'nothing written');
    }
    assert.equal(node('judge', path.join(dir, 'none.json'), '--out', out).status, 2);
    assert.equal(node('judge', rawFile).status, 64, 'no --out');
    assert.equal(node('weigh').status, 64);
    r = node('notes', path.join(dir, 'none.json'), '--install', path.join(dir, 'none.md'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /were not taken for this build/);
    r = node('notes');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lab 7 not run\.\n$/, 'the lab lines from docs/INSTALL.md');
    // A file that parses but is not the lane's verdicts, or does not parse, never stops the notes: the release's step runs
    // them under `bash -e`, so an exit other than 0 would hold the release.
    const badFile = path.join(dir, 'bad.json');
    for (const bad of ['{"readings":[]}', '{"readings":[null]}', '[]', 'null', '"text"', '{"v":1}', '{', '\uFEFF{"v":1,"defender":{"words":"x"},"readings":[{"id":"R1"}],"labs":[]}']) {
      fs.writeFileSync(badFile, bad);
      r = node('notes', badFile, '--install', path.join(ROOT, 'docs', 'INSTALL.md'));
      assert.equal(r.status, 0, bad + ': ' + r.stderr);
      assert.match(r.stdout, /^### The Windows readings\n\nThe Windows readings for this build could not be read/, bad);
      assert.match(r.stdout, /Lab 7 not run\.\n$/, bad);
    }
    assert.equal(node('notes', 'a.json', 'b.json').status, 64, 'two files: a word it does not know');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** docs/DESIGN.md's "Measured on the show laptop" with the Measured cell of each reading named replaced (a line at a time). */
function measuredOnLaptop(doc, cells) {
  return doc.split('\n').map((line) => {
    const c = line.split(/(?<!\\)\|/);
    if (c.length !== 8 || !(c[1].trim() in cells)) return line;
    c[6] = ' ' + cells[c[1].trim()] + ' ';
    return c.join('|');
  }).join('\n');
}

test('the show laptop\'s readings in the release notes: each that triggered named with its change, each within its threshold, each not measured said so, as docs/DESIGN.md records them', () => {
  const doc = read('docs/DESIGN.md');
  const rows = R.laptopReadings(doc);
  assert.deepEqual(rows.map((x) => x.id), R.LAPTOP_IDS, 'one row for each of readings 0-9, in order');
  // The paper's cells are "not measured" or a person's record with its verdict, so the notes never guess one.
  for (const x of rows) assert.ok(x.state === 'not measured' || (x.state !== 'unjudged' && R.LAPTOP_RECORD.test(x.measured)), x.id + ': "not measured", or a record of a day and a build with its verdict: ' + x.measured);
  assert.deepEqual(rows.filter((x) => x.id === '3').map((x) => [x.reading, x.threshold]), [['An fsync on the laptop\'s disk', 'p99 ≤ 2 ms and max ≤ 100 ms']]);
  // As the paper stood when 0.6.0 closed: nothing measured, so nothing triggered, and nothing is claimed.
  const none = R.laptopNotes(measuredOnLaptop(doc, Object.fromEntries(R.LAPTOP_IDS.map((id) => [id, 'not measured']))));
  assert.match(none, /^### The show laptop's readings\n\nReadings 0-9 of the 0\.6\.0 plan \(Part 5 §13\.4\)/);
  assert.match(none, /\*\*No reading is measured yet, so none has triggered its change\.\*\*/);
  assert.match(none, /\*\*Not measured:\*\* 0 \(.+\); 1 \(.+; 9 \(The glance test \(a walk\)\): nothing is claimed for them, and nothing they would trigger is in this release\.\n$/);
  assert.ok(!/Triggered|Recorded/.test(none));
  // Filled: reading 3 triggered (group commit, a 0.6.x unit), 4 within its threshold, 0 recorded, 6 written without a verdict.
  const filled = measuredOnLaptop(doc, {
    0: '2026-11-20, build 0.6.0+3.abc1234: 400 pages, frames to the last — recorded',
    3: '2026-11-20, build 0.6.0+3.abc1234: p99 1.2 ms, max 41 ms — triggers',
    4: '2026-11-20, build 0.6.0+3.abc1234: 12 ms at 4,100 messages — within its threshold',
    6: '2026-11-20, build 0.6.0+3.abc1234: p99 8 ms',
  });
  const states = Object.fromEntries(R.laptopReadings(filled).map((x) => [x.id, x.state]));
  assert.deepEqual([states[0], states[3], states[4], states[6], states[1]], ['recorded', 'triggered', 'within', 'unjudged', 'not measured']);
  const n = R.laptopNotes(filled);
  assert.match(n, /\*\*Triggered their change\*\* \(each change a 0\.6\.x unit, not in this release\):\n- 3 \(An fsync on the laptop's disk\): 2026-11-20, build 0\.6\.0\+3\.abc1234: p99 1\.2 ms, max 41 ms — triggers\. Threshold: p99 ≤ 2 ms and max ≤ 100 ms\. So: group commit: an acknowledged message is on disk, and the papers say so\.\n/);
  assert.match(n, /\*\*Recorded, within its threshold or with none:\*\* 4 \(The snapshot stall at the largest hall's size\): 2026-11-20, .+ — within its threshold; 0 \(.+\): .+ — recorded\./);
  assert.match(n, /\*\*Recorded, its verdict not written:\*\* 6 \(The loop on a show day\): 2026-11-20, build 0\.6\.0\+3\.abc1234: p99 8 ms\./);
  assert.match(n, /\*\*Not measured:\*\* 1 \(.+\); 2 \(.+; 9 \(.+\): nothing is claimed for them/);
  assert.ok(!/^- [0-9] /m.test(n.replace(/^- 3 .*$/m, '')), 'only the triggered reading is a line of its own');
  // A paper without the table, or none: said, and nothing claimed.
  for (const bad of ['', '# How AGMessage is built\n\n## Measured on the show laptop\n\nNothing yet.\n', doc.replace('## Measured on the show laptop', '## Measured elsewhere')]) {
    assert.equal(R.laptopReadings(bad), null);
    assert.match(R.laptopNotes(bad), /^### The show laptop's readings\n\nThe show laptop's readings could not be read from `docs\/DESIGN\.md` \(Measured on the show laptop\): nothing is claimed for them\./);
  }
  // The command line: always exit 0 (the release's step runs it under bash -e), 64 for a word it does not know.
  const dir = tmp('agm-laptop-');
  try {
    const node = (...a) => spawnSync(process.execPath, [READINGS_JS, ...a], { encoding: 'utf8' });
    let r = node('laptop');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, R.laptopNotes(h.readSource(path.join(ROOT, 'docs', 'DESIGN.md'))), 'the tree\'s docs/DESIGN.md by default');
    fs.writeFileSync(path.join(dir, 'design.md'), filled);
    r = node('laptop', '--design', path.join(dir, 'design.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /- 3 \(An fsync on the laptop's disk\)/);
    r = node('laptop', '--design', path.join(dir, 'none.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /could not be read from `docs\/DESIGN\.md`/);
    assert.equal(node('laptop', 'docs/DESIGN.md').status, 64, 'a file named without --design: a word it does not know');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('record: a run\'s verdicts written into docs/INSTALL.md\'s Measured column, each with its day and build; what the run did not take is kept, and the paper still holds', () => {
  const dir = tmp('agm-record-');
  try {
    const doc = read('docs/INSTALL.md');
    const j = R.judge(raw({ R2: { files: 5122, bytes: 197_000_000, rounds: [3000], over: 'v0.5.1' }, R4: R4_SERVED, R10: { rounds: [{ extractMs: 5100, runMs: 300, totalMs: 5400, code: 0 }] }, R13: { status: 0, failure: 'a | b', assets: [] } }));
    const r = R.recordInstall(doc, j);
    assert.deepEqual(r.changed, ['R2', 'R4', 'R10', 'R13'], 'the readings this run took');
    const measured = (text) => Object.fromEntries(text.split('\n').filter((l) => /^\| (R\d|Lab \d)/.test(l)).map((l) => { const c = l.split(/(?<!\\)\|/).slice(1, -1).map((x) => x.trim()); return [c[0], c[c.length - 1]]; }));
    const rows = measured(r.text);
    const was = measured(doc);
    assert.match(rows.R10, /^2026-11-02, build 0\.6\.0-dev\.40\+abc1234: ✕ missed: the slowest of 1 round 5\.40 s/);
    assert.match(rows.R4, /^2026-11-02, build 0\.6\.0-dev\.40\+abc1234: ✓ met: the token holds SeChangeNotifyPrivilege alone/);
    assert.match(rows.R2, /^2026-11-02, build 0\.6\.0-dev\.40\+abc1234: △ open: /);
    assert.match(rows.R13, /\(a \\\| b\)$/, 'a pipe in the words is escaped, so the row keeps its cells');
    // What the run did not take keeps its cell as the paper held it (a reading an earlier run recorded keeps that record).
    assert.deepEqual([rows.R1, rows.R3, rows['Lab 1']], [was.R1, was.R3, was['Lab 1']], 'what the run did not take, R3 and the lab lines are kept');
    assert.deepEqual([was.R3, was['Lab 1']], ['—', 'not run'], 'R3 retired, the lab lines not run');
    assert.deepEqual(paperProblems(r.text), [], 'the paper still holds to the register');
    assert.equal(R.recordInstall(r.text, j).text, r.text, 'recording the same run again changes nothing');
    assert.equal(R.recordInstall(doc.replace(/\n/g, '\r\n'), j).text, r.text.replace(/\n/g, '\r\n'), 'a paper with CRLF keeps it');
    assert.match(R.recordInstall(doc, { ...j, build: null }).error, /names no build/);
    assert.match(R.recordInstall(doc, { ...j, at: '' }).error, /names no day/);
    assert.match(R.recordInstall(doc, {}).error, /not the lane's verdicts/);
    // The command line, on a copy of the paper.
    const copy = path.join(dir, 'INSTALL.md');
    fs.writeFileSync(copy, doc);
    const verdicts = path.join(dir, 'readings.json');
    fs.writeFileSync(verdicts, JSON.stringify(j));
    const node = (...a) => spawnSync(process.execPath, [READINGS_JS, ...a], { encoding: 'utf8' });
    let c = node('record', verdicts, '--install', copy);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(fs.readFileSync(copy, 'utf8'), r.text);
    assert.match(c.stdout, /R2, R4, R10, R13 recorded in /);
    fs.writeFileSync(verdicts, '{"readings":[]}');
    c = node('record', verdicts, '--install', copy);
    assert.equal(c.status, 2);
    assert.match(c.stderr, /not the lane's verdicts; nothing is recorded/);
    assert.equal(node('record', '--install', copy).status, 64);
    assert.equal(node('record', verdicts, '--install', path.join(dir, 'none.md')).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- what the lane does on the runner

/** A zip written by the audit export's writer, into a file. */
async function zipFile(file, members) {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const z = new zipmod.ZipStream(out);
  for (const [name, data] of members) await z.add(name, data === null ? [] : [Buffer.from(data)]);
  await z.end();
  out.end();
  fs.writeFileSync(file, Buffer.concat(chunks));
}

test('the payload: every member of the bundle laid over the one before, each whole and checked; node.exe extracted alone; a member outside its folder refused', async () => {
  const dir = tmp('agm-lay-');
  try {
    const big = Buffer.alloc(300_000, 7);
    const zip = path.join(dir, 'bundle.zip');
    await zipFile(zip, [['AGMessage/node/node.exe', big], ['AGMessage/app/server.js', 'one'], ['AGMessage/app/data/rooms/.keep', null]]);
    const entries = T.zipEntries(zip);
    assert.deepEqual(entries.map((e) => [e.name, e.size, e.dir]), [['AGMessage/node/node.exe', 300_000, false], ['AGMessage/app/server.js', 3, false], ['AGMessage/app/data/rooms/.keep', 0, false]]);
    const dest = path.join(dir, 'payload');
    const first = T.layOut(zip, dest);
    assert.deepEqual([first.files, first.bytes], [3, 300_003]);
    const top = path.join(dest, 'AGMessage');
    fs.writeFileSync(path.join(top, 'app', 'server.js'), 'an earlier build');
    const again = T.layOut(zip, dest, entries);
    assert.equal(again.files, 3);
    assert.equal(fs.readFileSync(path.join(top, 'app', 'server.js'), 'utf8'), 'one', 'laid over the earlier file');
    assert.ok(fs.readFileSync(path.join(top, 'node', 'node.exe')).equals(big));
    const left = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else left.push(e.name); } };
    walk(dest);
    assert.deepEqual(left.sort(), ['.keep', 'node.exe', 'server.js'], 'no temporary name left');
    const one = path.join(dir, 'temp', 'node.exe');
    const x = T.extractOne(zip, '/node/node.exe', one, entries);
    assert.equal(x.bytes, 300_000);
    assert.ok(fs.readFileSync(one).equals(big));
    assert.throws(() => T.extractOne(zip, '/bin/cloudflared.exe', one), /expected one member ending \/bin\/cloudflared\.exe, found 0/);
    for (const bad of ['../x', '/abs/x', 'C:/x', 'a/./b', 'a/../../b']) assert.throws(() => T.memberParts(bad), /outside its folder/, bad);
    assert.deepEqual(T.memberParts('a/b/'), ['a', 'b']);
    // A member whose bytes changed fails its check; a file that is not a zip is said.
    const bytes = fs.readFileSync(zip);
    const at = bytes.indexOf(Buffer.from('server.js')) + 'server.js'.length;   // its local header's name, then its bytes
    assert.ok(at > 'server.js'.length);
    const torn = path.join(dir, 'torn.zip');
    const copy = Buffer.from(bytes);
    copy[at + 1] ^= 0xff;   // inside server.js's deflated bytes
    fs.writeFileSync(torn, copy);
    assert.throws(() => T.layOut(torn, path.join(dir, 'torn')), /do not check|invalid|incorrect|unexpected end/i);
    fs.writeFileSync(path.join(dir, 'not.zip'), 'not a zip at all');
    assert.throws(() => T.zipEntries(path.join(dir, 'not.zip')), /is not a zip/);
    // Two builds laid over each other, what is inside each bundle's one folder: 0.5.1's named as its zip, this one's AGMessage.
    assert.equal(T.topFolder(entries), 'AGMessage');
    const prev = path.join(dir, 'prev.zip');
    await zipFile(prev, [['AGMessage-Portable-Windows-0.5.1/app/server.js', 'the earlier build'], ['AGMessage-Portable-Windows-0.5.1/app/gone.js', 'only in 0.5.1']]);
    const over = path.join(dir, 'over', 'AGMessage');
    assert.equal(T.layOut(prev, over, undefined, { strip: 1 }).files, 2);
    assert.equal(fs.readFileSync(path.join(over, 'app', 'server.js'), 'utf8'), 'the earlier build');
    const laid = T.layOut(zip, over, entries, { strip: 1 });
    assert.deepEqual([laid.files, fs.readFileSync(path.join(over, 'app', 'server.js'), 'utf8')], [3, 'one'], 'this build laid over the earlier one, file by file');
    assert.ok(fs.readFileSync(path.join(over, 'node', 'node.exe')).equals(big));
    assert.deepEqual(fs.readdirSync(over).sort(), ['app', 'node'], 'no bundle folder inside: the two lie in one place');
    const two = path.join(dir, 'two.zip');
    await zipFile(two, [['a/x.js', '1'], ['b/y.js', '2']]);
    assert.throws(() => T.layOut(two, path.join(dir, 'two'), undefined, { strip: 1 }), /the bundle is not one folder \(2 at its top\)/);
    const flat = path.join(dir, 'flat.zip');
    await zipFile(flat, [['x.js', '1']]);
    assert.throws(() => T.topFolder(T.zipEntries(flat)), /not one folder/, 'a file at the top is no bundle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the release a bundle is: read from its zip\'s own name, 0.6.0\'s and 0.5\'s, never from the folder inside', () => {
  assert.equal(T.releaseOf('C:\\r\\previous\\AGMessage-Portable-0.6.0.zip'), '0.6.0');
  assert.equal(T.releaseOf('/r/previous/AGMessage-Portable-Windows-0.5.1.zip'), '0.5.1');
  assert.equal(T.releaseOf('AGMessage-Portable-0.6.1 (1).zip'), '0.6.1', 'a browser\'s second copy');
  for (const other of ['AGMessage-Portable-0.6.0-dev.83_f3a8232.zip', 'AGMessage-0.6.0.zip', 'agmessage-audit-verifier-0.6.0.zip', 'AGMessage-Portable-0.6.zip', 'AGMessage-Portable-0.6.0.zip.part', '']) {
    assert.equal(T.releaseOf(other), '', other);
  }
});

test('the stand-in tasks: U12\'s server task\'s principal and settings, one action by absolute path, UTF-16 as schtasks reads it', () => {
  const xml = T.taskXml({ description: 'a <stand-in> & more', ...T.SERVER_PRINCIPAL, restart: true, command: 'C:\\agm-readings\\payload\\x\\node\\node.exe', args: ['C:\\agm readings\\lane\\readings-take.js', 'probe-server', 'C:\\agm-readings\\r4\\'], cwd: 'C:\\agm-readings\\lane' });
  const el = (name) => [...xml.matchAll(new RegExp('<' + name + '>([^<]*)</' + name + '>', 'g'))].map((m) => m[1]);   // eslint-disable-line security/detect-non-literal-regexp -- the test's own element names
  assert.deepEqual(el('UserId'), ['S-1-5-19'], 'LocalService');
  assert.deepEqual(el('RunLevel'), ['LeastPrivilege']);
  assert.deepEqual(el('ProcessTokenSidType'), ['Unrestricted'], 'its own SID, NT TASK\\AGMessage-Server');
  assert.deepEqual(el('Privilege'), ['SeChangeNotifyPrivilege'], 'that privilege alone');
  assert.deepEqual([el('ExecutionTimeLimit'), el('DisallowStartIfOnBatteries'), el('StopIfGoingOnBatteries'), el('MultipleInstancesPolicy')], [['PT0S'], ['false'], ['false'], ['IgnoreNew']]);
  assert.deepEqual([el('Interval'), el('Count')], [['PT1M'], ['3']], 'RestartOnFailure 3 × 1 min');
  assert.deepEqual(el('Command'), ['C:\\agm-readings\\payload\\x\\node\\node.exe']);
  assert.deepEqual(el('Arguments'), ['&quot;C:\\agm readings\\lane\\readings-take.js&quot; probe-server C:\\agm-readings\\r4\\']);
  assert.deepEqual(el('Description'), ['a &lt;stand-in&gt; &amp; more']);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>\r\n<Task version="1\.3" /);
  assert.match(xml, /<Triggers \/>/, 'started on demand only');
  const sys = T.taskXml({ description: 'r13', sid: 'S-1-5-18', command: 'C:\\n.exe', cwd: 'C:\\' });
  assert.deepEqual([[...sys.matchAll(/<RunLevel>([^<]*)</g)].map((m) => m[1]), /ProcessTokenSidType|RequiredPrivileges|RestartOnFailure/.test(sys)], [['HighestAvailable'], false]);
  const bytes = T.utf16(xml);
  assert.deepEqual([bytes[0], bytes[1]], [0xFF, 0xFE]);
  assert.equal(bytes.subarray(2).toString('utf16le'), xml);
  // Windows' own reading of a command line (CommandLineToArgvW).
  assert.deepEqual(['plain', 'two words', 'a"b', 'C:\\dir with space\\', ''].map(T.winArg), ['plain', '"two words"', '"a\\"b"', '"C:\\dir with space\\\\"', '""']);
});

test('the stand-ins of R4 and R12 run as U12\'s own server task: the lane\'s principal and settings are app/machine.js serverTaskXml\'s, element for element, and R3′ and R8 register that definition itself', () => {
  const machine = require('../machine');
  const block = (xml, tag) => { const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml); return m ? m[1].replace(/>\s+</g, '><').trim() : null; };   // eslint-disable-line security/detect-non-literal-regexp -- the test's own element names
  const lane = T.taskXml({ description: 'x', ...T.SERVER_PRINCIPAL, restart: true, command: 'C:\\n.exe', cwd: 'C:\\' });
  const own = machine.serverTaskXml({ node: 'C:\\n.exe', launch: 'C:\\a\\launch.js', data: 'C:\\d', uploads: 'C:\\u', keys: 'C:\\k', logs: 'C:\\l', token: 'C:\\t', port: 3023 });
  for (const tag of ['Principals', 'Settings']) assert.equal(block(lane, tag), block(own, tag), tag);
  assert.ok(block(own, 'Settings').includes('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'));
  const src = h.readSource(TAKE_JS);
  assert.equal((src.match(/require\('\.\.\/app\/machine\.js'\)\.serverTaskXml\(\{ uri: /g) || []).length, 2, 'R3′ and R8 register machine.js\'s own definition under the lane\'s names');
  assert.match(machine.serverTaskXml({ uri: T.DEFINITION_TASK, node: 'n', launch: 'C:\\l.js', data: 'd', uploads: 'u', keys: 'k', logs: 'l', token: 't', port: 1 }), /<URI>\\AGMessage-Readings\\Definition<\/URI>/);
});

test('R13 runs as U17\'s control task does: the lane\'s principal and settings are app/machine.js controlTaskXml\'s, element for element; R8 and R11 register that definition itself; R11\'s task as an account logs on by its password', () => {
  const machine = require('../machine');
  const block = (xml, tag) => { const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml); return m ? m[1].replace(/>\s+</g, '><').trim() : null; };   // eslint-disable-line security/detect-non-literal-regexp -- the test's own element names
  const lane = T.taskXml({ description: 'x', ...T.CONTROL_PRINCIPAL, command: 'C:\\n.exe', cwd: 'C:\\' });
  const own = machine.controlTaskXml({ sid: 'S-1-5-21-1-2-3-1002', node: 'C:\\n.exe', script: 'C:\\a\\machine.js', machine: 'C:\\m', sys: 'C:\\Windows\\System32' });
  for (const tag of ['Principals', 'Settings']) assert.equal(block(lane, tag), block(own, tag), tag);
  const src = h.readSource(TAKE_JS);
  assert.match(src, /RELEASE_TASK, taskXml\(\{ description: [^}]*\.\.\.CONTROL_PRINCIPAL,/, 'R13\'s task carries the control principal');
  assert.equal((src.match(/require\('\.\.\/app\/machine\.js'\)\.controlTaskXml\(\{ uri: /g) || []).length, 1, 'R8 registers machine.js\'s own control task definition');
  assert.match(src, /L\.register\(controlName, machine\.controlTaskXml\(\{ sid: own\.sid, node, script, machine: root, sys, uri: controlName \}\)\)/, 'R11 registers it with the bundle\'s machine.js as its action');
  const as = T.taskXml({ description: 'r11', sid: 'S-1-5-21-1-2-3-1002', logon: 'Password', command: 'C:\\n.exe', cwd: 'C:\\' });
  assert.match(as, /<UserId>S-1-5-21-1-2-3-1002<\/UserId>\r\n {6}<LogonType>Password<\/LogonType>\r\n {6}<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.deepEqual(T.R11_USERS, { own: 'agmr11own', other: 'agmr11other' });
  assert.ok(Object.values(T.R11_USERS).every((n) => n.length <= 20), 'a local account\'s name is 20 characters at most');
});

test('the standard accounts the lane and the installer\'s life cycle make: each within what Windows takes, a description of 48 characters at most and a name of 20', () => {
  const said = [...T.SCRIPTS.users.matchAll(/-Description '([^']*)'/g)].map((m) => m[1]);
  assert.equal(said.length, 1, 'the account made has one description, written in the script');
  for (const d of said) assert.ok(d.length > 0 && d.length <= 48, 'New-LocalUser refuses a description over 48 characters: "' + d + '" is ' + d.length);
  assert.doesNotMatch(T.SCRIPTS.users, /-(?:FullName|Description) \$/, 'nothing Windows bounds is read from the environment');
  const life = read('installer/test/lifecycle.test.js').match(/const STD_NAME = '([^']+)';/);
  assert.ok(life, 'the life cycle names its account');
  for (const n of [...Object.values(T.R11_USERS), T.R6_USER, life[1]]) assert.ok(/^[a-z0-9]{1,20}$/.test(n), n + ': a local account\'s name, 20 characters at most');
});

test('probe-run: as R11\'s task runs it, schtasks /run of the control task its plan names, by its absolute path, and its exit code written', { skip: process.platform === 'win32' ? false : 'it runs schtasks.exe: the Windows readings lane runs it' }, () => {
  const dir = tmp('agm-probe-run-');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ task: '\\AGMessage-Readings\\NoSuchTask-' + Date.now() }));
  assert.equal(T.probeRun(dir), 0);
  const ran = JSON.parse(fs.readFileSync(path.join(dir, 'ran.json'), 'utf8'));
  assert.notEqual(ran.code, 0, 'no such task: schtasks refuses it');
});

test('the probes: a start recorded and its exit code; a profile\'s change listed; UDP heard; health waited for; a quick tunnel\'s address seen and the tunnel ended; GitHub\'s answer read', async () => {
  const dir = tmp('agm-probe-');
  const servers = [];
  try {
    // probe-exit, as the restart stand-in runs it: each start a line, the code its folder names.
    const exit = (...a) => spawnSync(process.execPath, [TAKE_JS, 'probe-exit', dir, ...a], { encoding: 'utf8' });
    assert.equal(exit().status, 1, 'no code named: a failure');
    fs.writeFileSync(path.join(dir, 'code'), '0\n');
    assert.equal(exit().status, 0);
    fs.writeFileSync(path.join(dir, 'code'), 'nonsense');
    assert.equal(exit().status, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'starts.log'), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.equal(exit('extra').status, 64, 'a word it does not know');
    // The profile, before and after.
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
    fs.writeFileSync(path.join(home, 'NTUSER.DAT'), 'hive');
    const before = T.snapshot(home);
    fs.writeFileSync(path.join(home, 'AppData', 'Local', 'cloudflared.json'), '{}');
    fs.writeFileSync(path.join(home, 'NTUSER.DAT'), 'hive, longer');
    assert.deepEqual(T.snapshotDiff(before, T.snapshot(home)), { added: [path.join('AppData', 'Local', 'cloudflared.json')], addedCount: 1, changed: ['NTUSER.DAT'], changedCount: 1, removed: 0 });
    assert.equal(T.snapshot(home, { max: 1 }).size, 1, 'bounded');
    // UDP: a hello this process sends is heard on its port. The port is one Windows gives a UDP socket: a free TCP port
    // can lie in a range Windows keeps from UDP (its excluded port ranges), where a bind is refused with EACCES.
    const udpPort = await h.freeUdpPort();
    const udp = await T.udpHeard({ port: udpPort, to: '127.0.0.1', ms: 2000 });
    assert.deepEqual([udp.bound, udp.sent, udp.heard], [true, true, true], JSON.stringify(udp));
    // Health: waited for until it answers, its build read; a port nobody answers on is not served.
    const health = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, build: '0.6.0-dev.40+abc1234' })); });
    servers.push(health);
    await new Promise((resolve) => { health.listen(0, '127.0.0.1', resolve); });
    const served = await T.waitHealth(health.address().port, { ms: 5000 });
    assert.deepEqual([served.ok, served.build], [true, '0.6.0-dev.40+abc1234']);
    const closed = await h.freePort();
    assert.equal((await T.waitHealth(closed, { ms: 600, every: 100 })).ok, false);
    // A quick tunnel: the address seen in its output, then the process ended; one that ends first, or says nothing, is not.
    const fake = path.join(dir, 'cloudflared.js');
    fs.writeFileSync(fake, 'process.stderr.write("INF |  https://fair-words-here.trycloudflare.com  |\\n"); setInterval(() => {}, 1000);\n');
    const t = await T.quickTunnel(process.execPath, [fake], { ms: 10000 });
    assert.deepEqual([t.returned, t.error], [true, '']);
    const quits = path.join(dir, 'quits.js');
    fs.writeFileSync(quits, 'process.exit(1);\n');
    const q = await T.quickTunnel(process.execPath, [quits], { ms: 10000 });
    assert.deepEqual([q.returned, q.error], [false, 'ended with 1 before it named an address']);
    const mute = path.join(dir, 'mute.js');
    fs.writeFileSync(mute, 'setInterval(() => {}, 1000);\n');
    const m = await T.quickTunnel(process.execPath, [mute], { ms: 300 });
    assert.deepEqual([m.returned, m.error], [false, 'no address within 0.3 s']);
    assert.equal((await T.quickTunnel(path.join(dir, 'no-such.exe'), [], { ms: 1000 })).returned, false);
    // GitHub's release answer, as the SYSTEM stand-in reads it: immutable and each digest; a refusal with its rate.
    const digest = 'sha256:' + 'cd'.repeat(32);
    const gh = http.createServer((req, res) => {
      if (req.url === '/repos/o/r/releases/tags/v1.0.0') {
        res.setHeader('x-ratelimit-remaining', '57');
        res.end(JSON.stringify({ tag_name: 'v1.0.0', immutable: true, assets: [{ name: 'a.zip', digest, size: 9 }, { name: 'SHA256SUMS' }] }));
      } else { res.statusCode = 403; res.setHeader('x-ratelimit-remaining', '0'); res.end('{"message":"API rate limit exceeded"}'); }
    });
    servers.push(gh);
    await new Promise((resolve) => { gh.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + gh.address().port;
    const rel = await T.readRelease(base + '/repos/o/r/releases/tags/v1.0.0');
    assert.deepEqual([rel.status, rel.immutable, rel.assets, rel.rateRemaining, rel.failure], [200, true, [{ name: 'a.zip', digest }, { name: 'SHA256SUMS', digest: '' }], 57, '']);
    const refused = await T.readRelease(base + '/other');
    assert.deepEqual([refused.status, refused.rateRemaining, refused.assets], [403, 0, []]);
    assert.equal((await T.readRelease('ftp://example.invalid/')).failure, 'not an http or https address');
    // probe-release writes the answer where the lane reads it.
    const r13 = path.join(dir, 'r13');
    fs.mkdirSync(r13);
    fs.writeFileSync(path.join(r13, 'plan.json'), JSON.stringify({ url: base + '/repos/o/r/releases/tags/v1.0.0' }));
    const p = await new Promise((resolve) => { const c = require('child_process').spawn(process.execPath, [TAKE_JS, 'probe-release', r13]); c.on('exit', resolve); });
    assert.equal(p, 0);
    const answer = JSON.parse(fs.readFileSync(path.join(r13, 'answer.json'), 'utf8'));
    assert.deepEqual([answer.status, answer.immutable, answer.assets.length, typeof answer.user], [200, true, 2, 'string']);
    // probe-offline asks as the bundle's machine.js asks (here its githubGet stood in for by a network that is not there,
    // its words machine.js's own) and writes what it met where the lane reads it.
    // The lane's own copy of this file, with the bundle's machine.js beside it (stood in for here).
    const lane = path.join(dir, 'lane');
    fs.mkdirSync(lane);
    fs.copyFileSync(TAKE_JS, path.join(lane, 'readings-take.js'));
    fs.writeFileSync(path.join(lane, 'machine.js'), 'const m = require(' + JSON.stringify(path.join(ROOT, 'app', 'machine.js')) + ');\nmodule.exports = { githubWords: m.githubWords, githubGet: async (p) => (p === \'/repos/o/r/releases/tags/v1.0.0\' ? { error: \'ENOTFOUND\' } : { status: 404, json: null, headers: {} }) };\n');
    fs.writeFileSync(path.join(r13, 'plan.json'), JSON.stringify({ repo: 'o/r', tag: 'v1.0.0' }));
    const offRan = await new Promise((resolve) => { const c = require('child_process').spawn(process.execPath, [path.join(lane, 'readings-take.js'), 'probe-offline', r13]); c.on('exit', resolve); });
    assert.equal(offRan, 0);
    const off = JSON.parse(fs.readFileSync(path.join(r13, 'offline.json'), 'utf8'));
    assert.deepEqual([off.error, off.why, off.words, typeof off.user], ['ENOTFOUND', 'offline', require('../machine').OFFLINE_WORDS, 'string']);
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what the lane keeps of what Windows and the server said: an access list from icacls /save, a server\'s last whole lines with no token in them, a pipe reached or not', async () => {
  // icacls /save writes UTF-16: the path's line, then its SDDL; for a drive root the path's line may be empty.
  const save = (text) => Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  assert.equal(T.sddlOfSave(save('Temp\r\nD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)\r\n')), 'D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)');
  assert.equal(T.sddlOfSave(save('\r\nD:PAI(A;OICI;FA;;;BA)S:(ML;OINPIO;NW;;;HI)\r\n')), 'D:PAI(A;OICI;FA;;;BA)S:(ML;OINPIO;NW;;;HI)', 'a root whose name line is empty');
  assert.equal(T.sddlOfSave(save('C:\\\r\nO:SYG:SYD:(A;;FA;;;SY)\r\n')), 'O:SYG:SYD:(A;;FA;;;SY)');
  assert.equal(T.sddlOfSave(save('nothing here\r\n')), '');
  // The server's output: only whole lines are kept, so no part of a value is kept without the rest of it.
  assert.equal(T.keepTail('a\n', 'b\n', 8), 'a\nb\n');
  assert.equal(T.keepTail('abc\n', 'defgh\nij', 8), 'defgh\nij');
  assert.equal(T.keepTail('abc\n', 'defgh\nijk', 8), 'ijk', 'a line the bound cuts is dropped whole');
  assert.equal(T.keepTail('', 'x'.repeat(20), 8), '', 'one line longer than the bound: nothing of it');
  let tail = '';
  for (let i = 0; i < 2000; i++) tail = T.keepTail(tail, 'line ' + i + '\n');
  assert.ok(tail.length <= 8192 && tail.startsWith('line ') && tail.endsWith('line 1999\n'), 'bounded, whole lines, the newest kept');
  // The admin token taken out by value, and anything of its shape whether or not it could be read.
  const token = '0123456789abcdef';   // secret-scan: fixture
  const said = 'Token: ' + token + '\nhealth on 3124; build 0.6.0-dev.40+abc1234\nother fedcba9876543210ffff\n';   // secret-scan: fixture
  assert.equal(T.withoutSecrets(said, token), 'Token: [token]\nhealth on 3124; build 0.6.0-dev.40+abc1234\nother [hex]\n');
  assert.equal(T.withoutSecrets(said, ''), 'Token: [hex]\nhealth on 3124; build 0.6.0-dev.40+abc1234\nother [hex]\n', 'a token that could not be read is still taken out by its shape');
  const dir = tmp('agm-keep-');
  const sockets = [];
  try {
    assert.equal(T.tokenIn(dir), '', 'no token written');
    fs.writeFileSync(path.join(dir, 'admin-token'), token + '\n');
    assert.equal(T.tokenIn(dir), token);
    fs.rmSync(path.join(dir, 'admin-token'));
    fs.mkdirSync(path.join(dir, 'admin-token'));
    assert.equal(T.tokenIn(dir), '', 'a token that cannot be read');
    // A pipe reached by a client of its own process, or not (here a socket path stands in for \\host\pipe\name).
    const sock = process.platform === 'win32' ? '\\\\.\\pipe\\agm-reach-' + process.pid : path.join(dir, 'reach.sock');
    const server = net.createServer((c) => c.end());
    sockets.push(server);
    await new Promise((resolve) => { server.listen(sock, resolve); });
    assert.deepEqual(T.pipeReach(sock), { connected: true, error: '' });
    const none = T.pipeReach(process.platform === 'win32' ? '\\\\.\\pipe\\agm-none-' + process.pid : path.join(dir, 'none.sock'));
    assert.equal(none.connected, false);
    assert.match(none.error, /^E[A-Z]+$/);
    assert.deepEqual(T.pipeReach(sock, { ms: 1 }), { connected: false, error: 'no answer within 0.001 s' });
  } finally {
    for (const s of sockets) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lane refuses a machine that is not a GitHub-hosted runner, a work folder it did not make, and a server task it did not make, before it touches anything', async () => {
  const dir = tmp('agm-place-');
  try {
    const hosted = { RUNNER_ENVIRONMENT: 'github-hosted' };
    for (const env of [{}, { RUNNER_ENVIRONMENT: 'self-hosted' }]) {
      const why = T.placeRefusal({ env, work: path.join(dir, 'work') });
      assert.match(why, /it is CI's, on a GitHub-hosted runner thrown away after the job, and this machine is not one/);
      assert.match(why, /Lab 3 is the show laptop's, taken on it, not with this$/);
    }
    assert.equal(T.placeRefusal({ env: hosted, work: path.join(dir, 'work') }), '', 'a work folder the lane will make');
    const theirs = path.join(dir, 'theirs');
    fs.mkdirSync(theirs);
    fs.writeFileSync(path.join(theirs, 'notes.txt'), 'a person\'s');
    assert.match(T.placeRefusal({ env: hosted, work: theirs }), /was not made by the lane \(no \.agm-readings-work in it\): it is not the lane's to remove$/);
    const ours = path.join(dir, 'ours');
    fs.mkdirSync(ours);
    fs.writeFileSync(path.join(ours, T.WORK_MARK), '');
    assert.equal(T.placeRefusal({ env: hosted, work: ours }), '');
    // The installed node's \AGMessage\Server is never replaced or removed; one the lane made, as schtasks shows it (UTF-16 or not), may be.
    const installed = { code: 0, out: '<?xml version="1.0" encoding="UTF-16"?><Task><RegistrationInfo><Description>AGMessage server</Description></RegistrationInfo></Task>' };
    assert.match(T.placeRefusal({ env: hosted, work: ours, serverTask: installed }), /^\\AGMessage\\Server is a task the lane did not make \(the installed node's\)/);
    const mine = { code: 0, out: ('<Description>' + T.STAND_IN + '</Description>').split('').join('\0') };
    assert.equal(T.placeRefusal({ env: hosted, work: ours, serverTask: mine }), '');
    assert.equal(T.placeRefusal({ env: hosted, work: ours, serverTask: { code: 1, out: '', err: 'ERROR: The system cannot find the file specified.' } }), '');
    // take itself: refused before anything is made (here, off Windows, or off a hosted runner on Windows).
    const work = path.join(dir, 'never');
    assert.equal(await T.take({ zip: path.join(dir, 'x.zip'), defender: path.join(dir, 'd.json'), out: path.join(dir, 'o.json'), work, port: 3124, env: {} }), 64);
    assert.deepEqual([fs.existsSync(work), fs.existsSync(path.join(dir, 'o.json'))], [false, false]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the lane takes its readings on Windows only, and refuses a word it does not know', async () => {
  const dir = tmp('agm-take-');
  try {
    const work = path.join(dir, 'work');
    const off = spawnSync(process.execPath, [TAKE_JS, 'take', '--zip', path.join(dir, 'x.zip'), '--defender', path.join(dir, 'd.json'), '--out', path.join(dir, 'o.json'), '--work', work], { encoding: 'utf8', env: { ...process.env, RUNNER_ENVIRONMENT: 'github-hosted' } });
    if (process.platform === 'win32') {
      assert.equal(off.status, 2, 'a bundle that is not there is read first');
      assert.match(off.stderr, /nothing was taken/);
    } else {
      assert.equal(off.status, 64);
      assert.match(off.stderr, /the readings are Windows'; nothing was taken/);
    }
    assert.deepEqual([fs.existsSync(work), fs.existsSync(path.join(dir, 'o.json'))], [false, false], 'nothing made, nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(T.parseArgs(['take', '--zip', 'a', '--tag', '']), { verb: 'take', flags: { zip: 'a', tag: '' }, positional: [] });
  assert.deepEqual(T.parseArgs(['take', '--previous', 'p.zip']).flags, { previous: 'p.zip' });
  assert.deepEqual(T.parseArgs(['take', '--installer', 'AGMessage-Setup-0.6.0-unsigned.exe']).flags, { installer: 'AGMessage-Setup-0.6.0-unsigned.exe' });
  assert.match(T.parseArgs(['take', '--zap', 'a']).error, /--zap is not a word it knows/);
  assert.match(T.parseArgs(['take', '--zip']).error, /has no value/);
  for (const a of [['take'], ['take', '--zip', 'a', '--defender', 'b', '--out', 'c', '--port', '80'], ['probe-server'], ['nothing']]) assert.equal(await T.main(a), 64, a.join(' '));
});

// A pipe's server makes a new instance only while its loop runs (libuv keeps four waiting), and the lane's PowerShell runs
// synchronously (L.ps), each read of the access list opening the pipe's client end and taking an instance. So the pipe is
// served from a process of its own, as the folder's server is for the lane.
const PIPE_SERVER = String.raw`require('node:net').createServer((c) => c.end()).listen(process.argv[1], () => process.stdout.write('ready\n'));`;

test('on Windows: the PowerShell the lane asks answers in its shape (signatures, a pipe\'s access list, Defender), and icacls /save reads as SDDL', { skip: NOT_WINDOWS }, async (t) => {
  const dir = tmp('agm-lane-');
  const lane = T.lane(dir, T.system32());
  // How long each of the lane's PowerShell reads took, said beside the test (a reading, never a bound).
  const L = { ps: (script, extra) => { const at = Date.now(); try { return lane.ps(script, extra); } finally { t.diagnostic(Object.keys(T.SCRIPTS).find((k) => T.SCRIPTS[k] === script) + ' took ' + (Date.now() - at) + ' ms'); } } };
  const pipeName = 'agmessage-' + require('crypto').randomBytes(8).toString('hex');
  const pipe = spawn(process.execPath, ['-e', PIPE_SERVER, '\\\\.\\pipe\\' + pipeName], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  try {
    const sig = L.ps(T.SCRIPTS.signatures, { AGM_READ_PATHS: process.execPath });
    const one = Array.isArray(sig) ? sig[0] : sig;
    assert.equal(one.path, process.execPath);
    assert.ok(['Valid', 'NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', 'Incompatible', 'NotSupportedFileFormat'].includes(one.status), one.status);
    await new Promise((resolve, reject) => {
      let said = '';
      pipe.stdout.on('data', (d) => { said += d; if (said.includes('ready')) resolve(); });
      pipe.on('exit', (code) => reject(new Error('the pipe\'s server ended with ' + code + ' before it served')));
      pipe.on('error', reject);
      setTimeout(() => reject(new Error('the pipe\'s server did not serve within 20 s')), 20000).unref();
    });
    const pipes = L.ps(T.SCRIPTS.pipes, { AGM_READ_PIPES: pipeName });
    const p = Array.isArray(pipes) ? pipes[0] : pipes;
    assert.equal(p.name, pipeName);
    assert.ok(R.daclOf(p.sddl).some((a) => a.type === 'allow'), 'an access list read: ' + JSON.stringify(p));
    try {
      const d = L.ps(T.SCRIPTS.defender);
      assert.equal(typeof d.realtime, 'boolean');
      assert.ok(Array.isArray(d.exclusions));
      assert.ok('processes' in d && 'extensions' in d, 'the process and extension exclusions read too: ' + JSON.stringify(d));
    } catch (e) {
      assert.match(e.message, /powershell\.exe ended with/, 'a Windows without Defender\'s module refuses in words');
    }
    // A folder and a drive's root, as R8 reads C:\ itself.
    for (const [i, where] of [os.tmpdir(), 'C:\\'].entries()) {
      const saved = path.join(dir, 'acl-' + i + '.txt');
      const r = spawnSync(path.join(T.system32(), 'icacls.exe'), [where, '/save', saved], { encoding: 'utf8' });
      assert.equal(r.status, 0, where + ': ' + r.stdout + r.stderr);
      const sddl = T.sddlOfSave(fs.readFileSync(saved));
      assert.ok(R.daclOf(sddl).length > 0, where + ': ' + sddl);
    }
  } finally {
    pipe.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the CI job, and the papers

/** A job of ci.yml, its lines from its name to the next job's. */
function job(ci, name) {
  const start = ci.indexOf('\n  ' + name + ':\n');
  assert.ok(start > 0, name + ' is a job');
  const rest = ci.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

test('the lane in CI: windows-2025, every action pinned by its commit, no credential left in its checkout, Defender turned on once the zips are here, on for the take of the readings that need it alone and put back as the image left it right after, that take\'s record kept at once, every step bounded inside the job, its readings kept whatever they say', () => {
  const ci = read('.github/workflows/ci.yml');
  const lane = job(ci, 'readings');
  assert.match(lane, /\n {4}runs-on: windows-2025\n/);
  // Every push's readings, a tag's and a run's asked for by hand (a pull request's commits are pushes already), one lane
  // at a time per ref and never cancelled once it runs: a newer push's waits its turn, so no run is thrown away
  // half-taken and a regression shows on the next readings taken.
  // It waits for the installer job too, for R5's verdict on the installer, but is never held by it: only the zip is needed.
  assert.match(lane, /\n {4}if: \$\{\{ !cancelled\(\) && github\.event_name != 'pull_request' && needs\.package\.result == 'success' \}\}\n {4}needs: \[package, installer\]\n {4}concurrency:\n {6}group: readings-\$\{\{ github\.ref \}\}\n {6}cancel-in-progress: false\n/, 'the zip the package job built, and the installer when its job built one');
  // No group holds the whole run, so a newer push cancels only the older run's tests and zip, each job by its own group;
  // a run by hand's are a group of their own, which a push never touches.
  assert.doesNotMatch(ci, /\nconcurrency:/, 'no group for the whole run: it would cancel the readings with the rest');
  assert.match(ci, /\non:\n {2}push:\n[\s\S]*?\n {2}workflow_dispatch:\n/);
  for (const [name, extra] of [['analyze', ''], ['test-linux', '-$' + '{{ matrix.node }}'], ['test-crlf', ''], ['test-windows', ''], ['package', '']]) {
    assert.ok(job(ci, name).includes('\n    concurrency:\n      group: ci-$' + '{{ github.ref }}-' + name + extra + '-$' + "{{ github.event_name == 'workflow_dispatch' && 'by-hand' || 'auto' }}\n      cancel-in-progress: $" + "{{ github.event_name != 'workflow_dispatch' }}\n"), name + ': cancelled by a newer push or pull request of its ref, never by one asked for by hand');
  }
  const uses = [...lane.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
  assert.deepEqual(uses.map((u) => u[1].split('@')[0]), ['actions/checkout', 'actions/setup-node', 'actions/download-artifact', 'actions/download-artifact', 'actions/upload-artifact', 'actions/upload-artifact', 'actions/upload-artifact']);
  const installerStep = lane.slice(lane.indexOf('name: agmessage-installer-$' + '{{ github.sha }}') - 200, lane.indexOf('name: agmessage-installer-$' + '{{ github.sha }}'));
  assert.match(installerStep, /\n {8}continue-on-error: true\n {8}with:\n {10}$/, 'an installer job that built nothing stops no reading');
  for (const [, ref, comment] of uses) assert.match(ref + comment, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, ref + ' is pinned by its commit, its tag beside it');
  // Each step from its "- " to the next, the comments before the next step left out.
  const steps = lane.split(/\n {6}- /).slice(1).map((x) => x.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  assert.match(steps[0], /^uses: actions\/checkout@/);
  assert.match(steps[0], /\n {8}with:\n {10}persist-credentials: false(\n|$)/, 'the stand-in tasks run the bundle\'s code from this workspace: no token is left in its .git');
  // Node, the zip, the installer and the newest release's are had before Defender is turned on (nothing measured depends
  // on Defender while they are downloaded: R2 and R10 open the zips with it on), so its window holds no download.
  const onStep = steps.findIndex((x) => x.includes('./tools/defender-on.ps1'));
  const offStep = steps.findIndex((x) => x.includes('./tools/defender-off.ps1'));
  assert.deepEqual(steps.slice(1, onStep).map((x) => (x.startsWith('uses: ') ? x.split('@')[0] : x.split('\n')[0])), ['uses: actions/setup-node', 'uses: actions/download-artifact', 'uses: actions/download-artifact', 'name: The newest release published (for R13), and its zip (for R2)'], 'Node, the zip, the installer and the release, then Defender');
  assert.match(steps[onStep], /^name: Defender's real-time monitoring back on/);
  assert.match(steps[onStep], /shell: powershell\n\s+timeout-minutes: \d+\n\s+run: \.\/tools\/defender-on\.ps1 -Out "\$env:RUNNER_TEMP\\defender\.json"$/, 'the runner\'s own excluded, never -ScanRunner');
  // The zip, Defender, the readings that need it, Defender put back as the image left it, what was taken kept at once,
  // the rest but the two as standard accounts added to the same record, what they wrote kept as the artifact, then R11
  // and R6 added to it, the verdicts, and the record kept again: a runner lost in a later take still leaves what was
  // taken before it on the server. Read with the comments left out, so a comment that names a step is not taken for it.
  const bare = lane.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const at = (from, what) => bare.indexOf(what, from);
  const order = [];
  for (const what of ['actions/setup-node', 'actions/download-artifact', 'actions/download-artifact', 'name: The newest release published', 'tools/defender-on.ps1', 'node tools/readings-take.js take --zip', 'tools/defender-off.ps1', 'actions/upload-artifact', 'node tools/readings-take.js take --zip', 'actions/upload-artifact', 'node tools/readings-take.js take --zip', 'node tools/readings.js judge readings/readings.raw.json --out readings/readings.json --summary $env:GITHUB_STEP_SUMMARY', 'actions/upload-artifact']) order.push(at(order.length ? order[order.length - 1] + 1 : 0, what));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'Node, the zips, the release, Defender, the readings with Defender, Defender put back, kept, the rest, kept, the readings as standard accounts, the verdicts, kept: ' + order);
  assert.equal((lane.match(/node tools\/readings-take\.js take /g) || []).length, 3, 'three takes, one record');
  assert.match(lane, /node tools\/readings-take\.js take --zip \$zip\[0\]\.FullName --defender "\$env:RUNNER_TEMP\\defender\.json" --out readings\/readings\.raw\.json --deadline-min (\d+) --only R2,R9,R10 @release @over @installer\n/, 'the readings that need Defender first, with its record; the tag through the environment, never pasted into the script');
  assert.match(lane, /node tools\/readings-take\.js take --zip \$zip\[0\]\.FullName --out readings\/readings\.raw\.json --deadline-min (\d+) --skip R2,R9,R10,R11,R6 --add @release @installer\n/, 'the rest added to the same record, given no Defender record');
  assert.match(lane, /node tools\/readings-take\.js take --zip \$zip\[0\]\.FullName --out readings\/readings\.raw\.json --deadline-min (\d+) --only R11,R6 --add\n/, 'R11 and R6 added to the same record, given no Defender record');
  assert.equal((lane.match(/--defender /g) || []).length, 1, 'only the take with Defender on is given its record');
  assert.match(lane, /\$installer = if \(\$setup\.Count -eq 1\) \{ @\('--installer', \$setup\[0\]\.FullName\) \} else \{ @\(\) \}/, 'the installer, when its job built it, for R5');
  assert.match(lane, /\$release = if \(\$env:RELEASE_TAG\) \{ @\('--repo', \$env:GITHUB_REPOSITORY, '--tag', \$env:RELEASE_TAG\) \} else \{ @\(\) \}/, 'no release named: no --tag, never an empty argument');
  assert.match(lane, /\$over = if \(\$previous\.Count -eq 1\) \{ @\('--previous', \$previous\[0\]\.FullName\) \} else \{ @\(\) \}/, 'the newest release\'s zip, when it was had, for R2');
  assert.ok(!/run: [^\n]*\$\{\{ steps\./.test(lane) && !/\n\s+node [^\n]*\$\{\{/.test(lane), 'no step output pasted into a command');
  // The record kept three times whatever it says, each under a name of its own (an upload over an artifact deletes it
  // first, so a runner lost in a later upload would take it with it): what the take with Defender wrote and Defender's
  // being put back, at once; what was taken before any standard account; then the whole record under the name the
  // release reads.
  const keeps = steps.filter((x) => x.startsWith('uses: actions/upload-artifact'));
  assert.equal(keeps.length, 3);
  assert.match(keeps[0], /\n\s+if: always\(\)\n\s+timeout-minutes: \d+\n\s+with:\n\s+name: agmessage-readings-\$\{\{ github\.sha \}\}-defender-\$\{\{ github\.run_attempt \}\}\n\s+path: readings\n\s+if-no-files-found: warn\n\s+overwrite: true$/, 'what the take with Defender wrote and Defender put back, under a name of its own');
  assert.equal(steps[offStep + 1], keeps[0], 'kept right after Defender is put back, before any other reading');
  assert.match(keeps[1], /\n\s+if: always\(\)\n\s+timeout-minutes: \d+\n\s+with:\n\s+name: agmessage-readings-\$\{\{ github\.sha \}\}-taken-\$\{\{ github\.run_attempt \}\}\n\s+path: readings\n\s+if-no-files-found: warn\n\s+overwrite: true/, 'what was taken before any standard account, under a name of its own');
  assert.match(keeps[2], /\n\s+if: always\(\)\n\s+timeout-minutes: \d+\n\s+with:\n\s+name: agmessage-readings-\$\{\{ github\.sha \}\}\n\s+path: readings\n\s+if-no-files-found: warn\n\s+overwrite: true/, 'the whole record under the name the release reads');
  assert.equal(new Set(keeps.map((x) => /\n\s+name: ([^\n]+)\n/.exec(x)[1])).size, 3, 'three names');
  // The readings without Defender, and those as standard accounts, are taken whatever the takes before them ended with.
  assert.match(steps.find((x) => x.startsWith('name: Take the readings that need no Defender')), /^name: Take the readings that need no Defender, with it off again \(tools\/readings-take\.js\)\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.match(steps.find((x) => x.startsWith('name: Take the readings as standard accounts')), /^name: Take the readings as standard accounts \(R11, R6; tools\/readings-take\.js\)\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/);
  // A take step cut short still has what it wrote judged.
  assert.match(steps.find((x) => x.startsWith('name: Judge them')), /\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/);
  // The token that lists the releases is that step's alone: the lane's own processes, and its tasks, hold none. A GitHub
  // answer that fails there stops nothing: only R13 and R2 need it, and each says why.
  assert.equal((lane.match(/GH_TOKEN/g) || []).length, 1);
  const gh = steps.find((x) => x.startsWith('name: The newest release published'));
  assert.match(gh, /^name: The newest release published \(for R13\), and its zip \(for R2\)\n\s+id: release\n\s+shell: pwsh\n\s+timeout-minutes: \d+\n\s+continue-on-error: true\n\s+env:\n\s+GH_TOKEN:/);
  assert.match(gh, /if \(\$LASTEXITCODE -ne 0 -or "\$tag" -notmatch '\^v\\d\+\\\.\\d\+\\\.\\d\+\$'\) \{ \$tag = '' \}/, 'a failed list reads as no release');
  assert.match(gh, /\n\s+exit 0$/, 'and the step ends 0 whatever gh said');
  // Every step bounded, and all of them together inside the job's bound: a step that runs over fails, and the job ends
  // failed, never cancelled by its own timeout, so the release that waits for it still runs. Each take step's limit
  // holds the deadline it gives the take and the take's own stop after it (STOP_MIN), so the take always ends itself;
  // every reading has a bound of its own, and each fits inside the deadline of the step that takes it, so each may begin
  // (under it: a take spends a moment before its first reading).
  const bounds = steps.map((x) => { const m = /\n {8}timeout-minutes: (\d+)\n/.exec('\n' + x.split('\n').slice(1).join('\n') + '\n'); return m ? Number(m[1]) : null; });
  assert.ok(bounds.every((b) => Number.isInteger(b) && b > 0), 'every step has its own bound: ' + bounds);
  const jobBound = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(lane)[1]);
  assert.ok(bounds.reduce((a, b) => a + b, 0) + 5 <= jobBound, 'the steps end inside the job: ' + bounds + ' within ' + jobBound);
  assert.deepEqual(Object.keys(T.BOUNDS).sort(), [...T.ORDER].sort(), 'every reading the lane takes has a bound of its own, and only those');
  const takes = steps.map((x, k) => [x, bounds[k], k]).filter(([x]) => x.startsWith('name: Take the readings'));
  assert.equal(takes.length, 3);
  const taken = [];
  const withDefender = [];
  for (const [x, limit] of takes) {
    const deadline = Number(/--deadline-min (\d+) /.exec(x)[1]);
    assert.ok(deadline + T.STOP_MIN <= limit, x.split('\n')[0] + ': its deadline of ' + deadline + ' min and the take\'s own stop after it (' + T.STOP_MIN + ' min) inside its limit of ' + limit);
    const only = /--only (\S+)/.exec(x);
    const skip = /--skip (\S+)/.exec(x);
    const ids = only ? only[1].split(',') : T.ORDER.filter((id) => !(skip ? skip[1].split(',') : []).includes(id));
    for (const id of ids) {
      assert.ok(T.BOUNDS[id] < deadline, id + '\'s own bound fits under its step\'s deadline');
      taken.push(id);
      if (/ --defender /.test(x)) withDefender.push(id);
    }
  }
  assert.deepEqual([...taken].sort(), [...T.ORDER].sort(), 'each reading is taken by exactly one step');
  // Defender is on only for the readings that need it, every one of them: they are the first take (Take A), the only one
  // given its record, in the step right after tools/defender-on.ps1; Defender is put back as the image left it in the
  // step right after that take, whatever it ended with (always), so the steps from the one to the other are exactly
  // [tools/defender-on.ps1, Take A, tools/defender-off.ps1]; every take after it is given no Defender record.
  assert.deepEqual(withDefender.sort(), R.READINGS.filter((x) => x.defender).map((x) => x.id).sort(), 'the readings taken with Defender are those that need it');
  const [first] = takes;
  assert.ok(/ --defender /.test(first[0]) && takes.slice(1).every(([x]) => !/--defender/.test(x)), 'the take with Defender comes first, and no take after it is given its record');
  assert.ok(onStep > 0 && first[2] === onStep + 1 && offStep === onStep + 2, 'Defender\'s window: on, Take A, off: ' + [onStep, first[2], offStep]);
  assert.deepEqual(steps.slice(onStep + 1, offStep), [first[0]], 'nothing but Take A between turning Defender on and putting it back');
  // Take A's window bounded: its deadline 6 minutes at most, and its step's limit no more than that deadline and the
  // take's own stop after it (with the bound above, exactly that), so a take that runs long ends itself before its step does.
  const deadlineA = Number(/--deadline-min (\d+) /.exec(first[0])[1]);
  assert.ok(deadlineA <= 6, 'Take A\'s deadline at most 6 minutes: ' + deadlineA);
  assert.ok(first[1] <= deadlineA + T.STOP_MIN, 'Take A\'s step limit no more than its deadline and STOP_MIN: ' + first[1]);
  const off = steps[offStep];
  assert.match(off, /^name: Defender as the image left it[^\n]*\(tools\/defender-off\.ps1\)\n {8}if: always\(\)\n {8}shell: powershell\n {8}timeout-minutes: \d+\n {8}run: \.\/tools\/defender-off\.ps1 -Record "\$env:RUNNER_TEMP\\defender\.json" -Out readings\/defender-off\.json$/, 'Defender put back right after the readings that need it, whatever they ended with, from what tools/defender-on.ps1 recorded, its own record in the readings\' folder');
  assert.equal(steps.filter((x) => /defender-(on|off)\.ps1|MpPreference/.test(x)).length, 2, 'Defender turned on once and put back once, nothing else of it');
  assert.ok(steps.findIndex((x) => x.startsWith('name: Take the readings that need no Defender')) > first[2] + 1, 'the rest after Defender is put back');
  // No step's limit is 45 minutes: a hosted runner lost to the service is failed about 45 minutes after it was last heard
  // (seen in run 110: last report 15:00:27, failed 15:45:57; reported, not measured, for runs 105 and 109), and a limit of
  // that length would read as the step's own.
  assert.ok(!bounds.includes(45), 'no step bounded at 45 minutes: ' + bounds);
  const ps = read('tools/defender-on.ps1');
  assert.match(ps, /Set-MpPreference -DisableRealtimeMonitoring \$false/);
  assert.match(ps, /Get-MpComputerStatus/);
  assert.match(ps, /if \(-not \$d -or -not \$d\.realtime -or -not \$d\.onAccess -or \$d\.mode -ne 'Normal'\) \{ return \$false \}/, 'on as tools/readings.js judges it: scanning on access, in its Normal mode');
  assert.match(ps, /\$record\.took = \[bool\]\(Is-On \$record\.after\)/, 'whether it took, read back');
  assert.match(ps, /\nexit 0\n$/, 'it informs, never fails the job for Defender');
  // Every exclusion it finds removed, each on its own and recorded as it goes (the image's C:\ and D:\ when nothing was
  // read), of paths, processes and extensions alike.
  assert.ok(ps.includes("if (-not $found) { $found = [ordered]@{ exclusions = @('C:\\', 'D:\\'); processes = @(); extensions = @() } }"), 'the image\'s two at least');
  for (const [list, flag, kept] of [['exclusions', 'ExclusionPath', 'paths'], ['processes', 'ExclusionProcess', 'processes'], ['extensions', 'ExclusionExtension', 'extensions']]) {
    assert.ok(ps.includes('foreach ($x in @($found.' + list + ')) {\n  try { Remove-MpPreference -' + flag + ' $x; $record.removed.' + kept + ' += $x }'), list + ' removed one by one');
  }
  assert.match(ps, /extensions = @\(\$p\.ExclusionExtension \| Where-Object \{ \$_ \}\)/, 'the extensions read too');
  // The runner's own excluded again, unless -ScanRunner: found from its running processes, by their full paths; its
  // folder never a drive root, never one that holds or lies in what is measured; each recorded once Defender took it.
  assert.match(ps, /\nif \(-not \$ScanRunner\) \{\n/);
  assert.match(ps, /Where-Object \{ \$_\.ProcessName -like 'Runner\.\*' -and \$_\.Path \}/);
  assert.match(ps, /\$paths = @\(\$paths \| Where-Object \{ \(Test-Excludable \$_\) -and \(Test-Path -LiteralPath \$_\) \} \| Sort-Object -Unique\)/, 'every path excluded is one it may name');
  assert.ok(ps.includes('try { Add-MpPreference -ExclusionPath $p; $record.runner.paths += $p }') && ps.includes('try { Add-MpPreference -ExclusionProcess $e; $record.runner.processes += $e }'), 'each recorded once Defender took it');
  assert.ok(ps.includes("if (-not $p -or $p -match '^[A-Za-z]:\\\\?$') { return $false }\n  foreach ($k in $kept) { if ((Test-Inside $k $p) -or (Test-Inside $p $k)) { return $false } }"), 'never a drive root, never over or in a kept place');
  assert.ok(ps.includes("$i = $inner.Replace('/', '\\').TrimEnd('\\') + '\\'") && ps.includes('[System.StringComparison]::OrdinalIgnoreCase'), 'paths compared whole, either slash, any case');
  const keptAt = ps.indexOf('$kept = @(@(');
  const keptList = ps.slice(keptAt, ps.indexOf('Sort-Object -Unique', keptAt));
  for (const k of ['$env:GITHUB_WORKSPACE', '$env:RUNNER_TEMP', '$env:TEMP', '$env:TMP', "'C:\\agm-readings'", '$env:ProgramFiles, $env:ProgramData, $env:LOCALAPPDATA', "Join-Path $env:LOCALAPPDATA 'Temp'"]) assert.ok(keptList.includes(k), k + ' is kept scanned');
  // On only with no exclusion but the runner's own it made, and none of extensions: fail closed, as the judge.
  assert.ok(ps.includes('if (@($d.extensions).Count) { return $false }\n  return (Test-OnlyOwn $d.exclusions $record.runner.paths) -and (Test-OnlyOwn $d.processes $record.runner.processes)'), 'on: nothing excluded but the runner\'s own');
  // Defender put back as the image left it: real-time monitoring off first; the runner's own exclusions tools/defender-on.ps1
  // recorded removed, then every exclusion it removed added back (C:\ and D:\ when its record cannot be read), each on its
  // own and recorded as it goes; read back; off only with real-time monitoring off and both drives excluded again. It
  // informs, never failing the job for Defender.
  const offPs = read('tools/defender-off.ps1');
  assert.match(offPs, /\nparam\(\[Parameter\(Mandatory = \$true\)\]\[string\]\$Record, \[Parameter\(Mandatory = \$true\)\]\[string\]\$Out\)\n/);
  assert.ok(!/\$record\b/i.test(offPs.replace(/\$Record\b/g, '')) && !/\$out\b/i.test(offPs.replace(/\$Out\b/g, '')), 'no variable that is a parameter under another case (PowerShell\'s names know no case)');
  const offAt = offPs.indexOf('try { Set-MpPreference -DisableRealtimeMonitoring $true }');
  assert.ok(offAt > 0 && offAt < offPs.indexOf('Get-Content -LiteralPath $Record'), 'real-time monitoring off first');
  assert.ok(offPs.includes("$removed = [ordered]@{ paths = @('C:\\', 'D:\\'); processes = @(); extensions = @() }"), 'the image\'s two when the record cannot be read');
  for (const [list, flag, kept] of [['paths', 'ExclusionPath', 'paths'], ['processes', 'ExclusionProcess', 'processes'], ['extensions', 'ExclusionExtension', 'extensions']]) {
    assert.ok(offPs.includes('foreach ($x in $removed.' + list + ') {\n  try { Add-MpPreference -' + flag + ' $x; $result.restored.' + kept + ' += $x }'), list + ' added back one by one');
  }
  assert.ok(offPs.includes('foreach ($p in $own.paths) {\n  try { Remove-MpPreference -ExclusionPath $p; $result.unexcluded.paths += $p }') && offPs.includes('foreach ($e in $own.processes) {\n  try { Remove-MpPreference -ExclusionProcess $e; $result.unexcluded.processes += $e }'), 'the runner\'s own removed one by one');
  assert.ok(offPs.indexOf('Remove-MpPreference -ExclusionPath $p') < offPs.indexOf('Add-MpPreference -ExclusionPath $x'), 'the runner\'s own removed before the image\'s are put back, so a path in both stays excluded');
  assert.ok(offPs.includes('$own = [ordered]@{ paths = @(Get-List $on.runner.paths); processes = @(Get-List $on.runner.processes) }') && offPs.includes('paths = @(Get-List $on.removed.paths); processes = @(Get-List $on.removed.processes); extensions = @(Get-List $on.removed.extensions)'), 'what tools/defender-on.ps1 recorded, read back');
  assert.ok(offPs.includes("if (-not $d -or $d.realtime) { return $false }\n  return (Test-Names $d.exclusions 'C:\\') -and (Test-Names $d.exclusions 'D:\\')"), 'off: real-time monitoring off, both drives excluded again');
  assert.match(offPs, /\$result\.off = \[bool\]\(Test-Off \$result\.after\)/, 'whether it took, read back');
  // Read back for up to 30 s, the real-time monitoring asked off again, in a try of its own, at each read that still says
  // it is on; a refusal of that recorded once, not at every pass.
  const loopAt = offPs.indexOf('$deadline = (Get-Date).AddSeconds(30)');
  const loop = offPs.slice(loopAt, offPs.indexOf('} while ((Get-Date) -lt $deadline)', loopAt));
  assert.ok(loopAt > offAt && loop.includes('\ndo {\n'), 'the read-back loop, after the first ask');
  assert.ok(loop.includes("  if (Test-Off $result.after) { break }\n  if ($result.after -and $result.after.realtime) {\n    try { Set-MpPreference -DisableRealtimeMonitoring $true } catch {\n      if (-not $againSaid) { $result.errors += ('real-time monitoring, asked again: ' + $_.Exception.Message) }\n      $againSaid = $true\n    }\n  }\n  Start-Sleep -Seconds 2\n"), 'asked off again while a read says it is on, its refusal said once: ' + loop);
  assert.ok(offPs.indexOf('$againSaid = $false') > 0 && offPs.indexOf('$againSaid = $false') < loopAt + loop.indexOf('\ndo {\n'), 'said once a run, not once a pass');
  assert.ok(loop.includes("\ndo {\n  try { $result.after = Read-Defender } catch {\n    $result.after = $null\n    if (-not $readSaid) { $result.errors += ('read after: ' + $_.Exception.Message) }\n    $readSaid = $true\n  }\n"), 'a read that fails, said once: ' + loop);
  assert.ok(offPs.indexOf('$readSaid = $false') > 0 && offPs.indexOf('$readSaid = $false') < loopAt + loop.indexOf('\ndo {\n'), 'a failed read said once a run, not once a pass');
  assert.equal((offPs.match(/Set-MpPreference -DisableRealtimeMonitoring \$true/g) || []).length, 2, 'the first ask, and the ask again in the loop');
  assert.ok(!/DisableRealtimeMonitoring \$false/.test(offPs), 'never turned on here');
  assert.match(offPs, /\nexit 0\n$/, 'it informs, never fails the job for Defender');
  // The canaries' evidence is readable by whoever reads the repository: of the runner's own logs it keeps the
  // listener's warnings and errors alone and never the worker's, and every line of every file goes through Hide-Secret.
  const ev = read('tools/canary-evidence.ps1');
  assert.match(ev, /Get-Process -Name 'Runner\.Listener'/);
  assert.match(ev, /-Filter 'Runner_\*\.log'/);
  assert.ok(!/Worker_/.test(ev) && (ev.match(/-Filter '[^']*'/g) || []).join() === "-Filter 'Runner_*.log'" && (ev.match(/Get-Content /g) || []).length === 1, 'the listener\'s log alone is read, no other');
  assert.match(ev, /Where-Object \{ \$_ -match '\\b\(ERR\|WARN\)\\b' \}/);
  const writes = ev.split('\n').filter((l) => /Set-Content|Add-Content/.test(l));
  assert.ok(writes.length >= 5 && writes.every((l) => /\bHide-Secret \| (Set|Add)-Content/.test(l)), 'every write through Hide-Secret: ' + writes.filter((l) => !/\bHide-Secret \|/.test(l)).join(' / '));
  assert.ok(ev.includes("-replace 'eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+', '<token>'") && ev.includes("-replace '(?:[A-Za-z0-9+/=_\\-]|%[0-9A-Fa-f]{2}){32,}', '<long>'") && ev.includes("(sig|signature|token|access_token|key|secret|password|pwd|sessionid)"), 'tokens, signatures and keys blanked');
});
// The Defender canary is temporary: a question asked of GitHub's hosted runners, removed with this test once it is
// answered. While it runs, each leg must ask what it says it asks, or its answer means nothing.
test('the Defender canary (temporary): two legs; on-then-off turns Defender on and puts it back after its evidence at 4 minutes, whatever came before; monitoring-only turns the real-time monitoring on alone and touches no exclusion; every evidence step uploaded under a name of its own, whatever it ended with', () => {
  const ci = read('.github/workflows/ci.yml');
  const canary = job(ci, 'canary');
  assert.match(canary, /\n {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}defender: \[on-then-off, monitoring-only\]\n/, 'the two legs, and no other');
  assert.ok(!/\$\{\{ matrix\.(?!defender\b)/.test(canary), 'no other matrix key read');
  const steps = canary.split(/\n {6}- /).slice(1).map((x) => x.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\n+$/, ''));
  // The leg a step is run in ('' for both): read from its own condition.
  const leg = (x) => (/\n {8}if: \$\{\{ (?:always\(\) && )?matrix\.defender == '([\w-]+)' \}\}\n/.exec(x) || [])[1] || '';
  for (const x of steps) assert.ok(['', 'on-then-off', 'monitoring-only'].includes(leg(x)), 'a leg the matrix names: ' + x.split('\n')[0]);
  // on-then-off: tools/defender-on.ps1 before any evidence, then, after the evidence at 4 minutes and its upload,
  // tools/defender-off.ps1 whatever the steps before ended with (always()), before the evidence at 6 minutes.
  const on = steps.findIndex((x) => x.includes('./tools/defender-on.ps1'));
  const off = steps.findIndex((x) => x.includes('./tools/defender-off.ps1'));
  const four = steps.findIndex((x) => x.startsWith('name: Alive at 4 min,'));
  const six = steps.findIndex((x) => x.startsWith('name: Alive at 6 min,'));
  assert.ok(on > 0 && on < steps.findIndex((x) => x.startsWith('name: Alive at')), 'Defender on before any evidence');
  assert.ok(four > on && off === four + 2 && six === off + 1, 'put back after the evidence at 4 minutes and its upload, before the next: ' + [on, four, off, six]);
  assert.match(steps[four + 1], /\n {10}name: canary-\$\{\{ matrix\.defender \}\}-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}-m04\n/, 'the evidence at 4 minutes kept before Defender is put back');
  assert.match(steps[on], /^name: [^\n]*\n {8}if: \$\{\{ matrix\.defender == 'on-then-off' \}\}\n {8}shell: powershell\n {8}timeout-minutes: \d+\n {8}run: \.\/tools\/defender-on\.ps1 -Out "\$env:RUNNER_TEMP\\canary\\defender\.json"$/, 'on-then-off alone, the runner\'s own excluded as the lane has them');
  assert.match(steps[off], /^name: [^\n]*\n {8}if: \$\{\{ always\(\) && matrix\.defender == 'on-then-off' \}\}\n {8}shell: powershell\n {8}timeout-minutes: \d+\n {8}run: \.\/tools\/defender-off\.ps1 -Record "\$env:RUNNER_TEMP\\canary\\defender\.json" -Out "\$env:RUNNER_TEMP\\canary\\defender-off\.json"$/, 'put back whatever came before, on-then-off alone, recorded beside the evidence');
  // monitoring-only: one step, the real-time monitoring turned on and nothing else; no step it runs removes or adds an
  // exclusion, runs either script or turns the monitoring off.
  const mon = steps.filter((x) => leg(x) === 'monitoring-only');
  assert.equal(mon.length, 1, 'one step of its own');
  assert.match(mon[0], /^name: [^\n]*\n {8}if: \$\{\{ matrix\.defender == 'monitoring-only' \}\}\n {8}shell: powershell\n {8}timeout-minutes: \d+\n {8}run: Set-MpPreference -DisableRealtimeMonitoring \$false$/, 'the real-time monitoring on, and nothing else');
  assert.ok(steps.indexOf(mon[0]) > 0 && steps.indexOf(mon[0]) < steps.findIndex((x) => x.startsWith('name: Alive at')), 'before any evidence');
  for (const x of steps.filter((y) => leg(y) !== 'on-then-off')) {
    assert.ok(!/defender-o(n|ff)\.ps1|(Add|Remove)-MpPreference|-Exclusion|DisableRealtimeMonitoring \$true/i.test(x), 'monitoring-only runs it, and it touches no exclusion nor turns the monitoring off: ' + x.split('\n')[0]);
  }
  assert.deepEqual(steps.filter((x) => /defender-o(n|ff)\.ps1|MpPreference/i.test(x)).map(leg), ['on-then-off', 'monitoring-only', 'on-then-off'], 'every step that touches Defender is one leg\'s');
  // The evidence: each step goes on whatever the one before ended with, and is uploaded right after it under a name of its
  // own (an upload over another deletes it first), whatever it ended with; nothing else is uploaded.
  const alive = steps.map((x, k) => [x, k]).filter(([x]) => x.startsWith('name: Alive at'));
  assert.ok(alive.length >= 2, 'the evidence steps');
  const names = [];
  for (const [x, k] of alive) {
    const min = /^name: Alive at (\d+) min,/.exec(x)[1];
    assert.match(x, /\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}continue-on-error: true\n/, 'Alive at ' + min + ' goes on whatever came before, and stops nothing');
    const up = /^uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}timeout-minutes: \d+\n {8}continue-on-error: true\n {8}with:\n {10}name: canary-\$\{\{ matrix\.defender \}\}-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}-m(\d{2})\n {10}path: \$\{\{ runner\.temp \}\}\/canary$/.exec(steps[k + 1]);
    assert.ok(up, 'Alive at ' + min + ' uploaded right after it, whatever it ended with: ' + steps[k + 1]);
    assert.equal(up[1], min.padStart(2, '0'), 'Alive at ' + min + ' uploaded under its own name');
    names.push(min.padStart(2, '0'));
  }
  assert.equal(new Set(names).size, names.length, 'each under a name of its own');
  assert.equal(steps.filter((x) => x.startsWith('uses: actions/upload-artifact')).length, alive.length, 'an upload after each evidence step, and no other');
  assert.match(canary, /\n {4}if: \$\{\{ github\.event_name == 'push' \}\}\n/, 'pushes alone');
  assert.ok(!/\bcanary\b/.test(job(ci, 'release').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'the release waits for neither leg');
});

test('the release waits for the lane and never is held by it: its notes carry the readings, or say there are none', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = job(ci, 'release');
  assert.match(release, /\n {4}if: \$\{\{ !cancelled\(\) && startsWith\(github\.ref, 'refs\/tags\/v'\) && needs\.package\.result == 'success' && needs\.installer\.result == 'success' && needs\.lifecycle\.result == 'success' \}\}\n {4}needs: \[package, installer, lifecycle, readings\]\n/);
  assert.ok(!/needs\.readings\.result/.test(release), 'whatever the lane found and however it ended');
  const sparse = release.slice(release.indexOf('sparse-checkout: |'), release.indexOf('sparse-checkout-cone-mode'));
  for (const f of ['tools/readings.js', 'docs/INSTALL.md', 'docs/DESIGN.md']) assert.ok(sparse.split('\n').some((l) => l.trim() === f), f + ' is checked out: the notes\' tool, the lab lines\' record and the show laptop\'s readings');
  const dl = release.indexOf('name: agmessage-readings-$' + '{{ github.sha }}');
  const notes = release.indexOf('node tools/readings.js notes readings/readings.json --install docs/INSTALL.md');
  const create = release.indexOf('gh release create');
  assert.ok(dl > 0 && notes > dl && create > notes, 'the readings downloaded, the notes made, then the release');
  assert.match(release.slice(release.lastIndexOf('- uses: actions/download-artifact@', dl), dl), /@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+continue-on-error: true\n/, 'a lane that wrote nothing does not stop it');
  assert.match(release.slice(create), /--notes-file "\$RUNNER_TEMP\/notes\.md"/);
  assert.match(release.slice(notes, create), /^node tools\/readings\.js notes readings\/readings\.json --install docs\/INSTALL\.md \|\| printf '### The Windows readings\\n\\nThe Windows readings for this build could not be read: nothing is claimed for them\./, 'a notes step that fails anyway leaves words, never a held release');
  // The show laptop's readings as docs/DESIGN.md records them at the tag, after the Windows readings and before the release.
  const laptop = release.indexOf('node tools/readings.js laptop --design docs/DESIGN.md || printf ');
  assert.ok(laptop > notes && create > laptop, 'the show laptop\'s readings in the notes, before the release is made');
  assert.match(release.slice(laptop, create), /^node tools\/readings\.js laptop --design docs\/DESIGN\.md \|\| printf '%s\\n\\n%s\\n' "### The show laptop's readings" "The show laptop's readings could not be read: nothing is claimed for them\./, 'a step that fails anyway leaves words, never a held release');
  assert.ok(release.indexOf('node tools/stamp-build.js --check-tag') < dl, 'the release order is asked first');
});

/**
 * What in docs/INSTALL.md is not as the register says: each reading's what, mark and miss; its Measured cell a run's
 * record or "not measured"; each lab line's what, pass, and its Taken cell the laptop's record or "not run".
 */
function paperProblems(doc) {
  const problems = [];
  const cells = (l) => l.trim().replace(/^\|\s*|\s*\|$/g, '').split(/\s\|\s/);
  const rows = doc.split(/\r?\n/).filter((l) => /^\| (R\d|Lab \d)/.test(l)).map(cells);
  for (const x of R.READINGS) {
    const row = rows.find((r) => r[0] === x.id);
    if (!row) { problems.push(x.id + ' has no row'); continue; }
    if (row[1] !== x.what || row[2] !== x.mark || row[3] !== x.miss) problems.push(x.id + ': what, mark or miss not the register\'s');
    if (!/^(not measured|—|\d{4}-\d{2}-\d{2}, build \S+: .+)$/.test(row[5])) problems.push(x.id + ': its Measured cell is neither a run\'s record nor "not measured": ' + row[5]);
  }
  for (const l of R.LABS) {
    const row = rows.find((r) => r[0] === l.id);
    if (!row) { problems.push(l.id + ' has no row'); continue; }
    if (row[1] !== l.what || row[2] !== l.pass) problems.push(l.id + ': what or pass not the register\'s (the plan\'s)');
    if (!/^(not run|\d{4}-\d{2}-\d{2}, build \S+: .+)$/.test(row[row.length - 1])) problems.push(l.id + ': taken on the show laptop, or "not run"');
  }
  return problems;
}

test('the papers: docs/INSTALL.md gives each reading its mark and what a miss means, as the lane judges them, and each lab line the plan\'s words and its record', () => {
  const doc = read('docs/INSTALL.md');
  assert.deepEqual(paperProblems(doc), []);
  assert.deepEqual(Object.keys(R.labRecord(doc)), R.LABS.map((l) => l.id), 'the notes read every lab line from it');
  // The fence reads what it holds: a word changed in a row is found.
  assert.ok(paperProblems(doc.replace('| Lab 6 | an upgrade during a rehearsal', '| Lab 6 | an upgrade in a rehearsal')).length > 0);
  // …and a Measured cell that is neither a run's record nor "not measured" is found, whatever the cell held before (a run's
  // record, once the lane has written one).
  const measuredAs = (id, words) => doc.split('\n').map((line) => {
    const cells = line.split(/(?<!\\)\|/);
    if (cells.length < 8 || cells[1].trim() !== id) return line;
    cells[cells.length - 2] = ' ' + words + ' ';
    return cells.join('|');
  }).join('\n');
  assert.notEqual(measuredAs('R10', 'fine'), doc, 'R10 has a row to change');
  assert.ok(paperProblems(measuredAs('R10', 'fine')).length > 0);
  assert.deepEqual(paperProblems(measuredAs('R10', 'not measured')), [], 'and "not measured" is one');
});
