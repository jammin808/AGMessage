'use strict';
// The Windows evidence lane (the plan's Part 6, unit U7): the readings R1-R13 and the lab lines, each with its mark and
// what a miss means (tools/readings.js), judged only on what was measured and never holding the release; what the lane
// measures on the runner and what its stand-in tasks run (tools/readings-take.js); the CI job that takes them first turns
// Defender back on, is pinned by commit, and feeds the release's notes without holding it; and the papers say the same
// marks. The lane itself runs on windows-2025 in CI; here every part of it that is not Windows' own is run, and on Windows
// the PowerShell it asks is run too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn, spawnSync } = require('child_process');
const h = require('./helpers');
const zipmod = require('../lib/zip');
const busyLine = require('../lib/busy');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'tools', 'readings.js'));
const T = require(path.join(ROOT, 'tools', 'readings-take.js'));
const READINGS_JS = path.join(ROOT, 'tools', 'readings.js');
const TAKE_JS = path.join(ROOT, 'tools', 'readings-take.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NOT_WINDOWS = process.platform === 'win32' ? false : 'the PowerShell the lane asks runs on Windows: CI\'s Windows job runs it at every push, and the lane on windows-2025';

const byId = (judged, id) => judged.readings.find((x) => x.id === id);
const ON = { realtime: true, onAccess: true, mode: 'Normal', exclusions: [] };
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
  // What this build cannot take names the unit whose code it measures; what it stands in for, the unit that ends it.
  for (const id of ['R3′', 'R6', 'R9', 'R11']) assert.match(R.READINGS.find((x) => x.id === id).needs.join(' '), /U\d+ \(#\d+\)/, id);
  // R1 waited for U8 (#36), the stop at loopback with the proof, which is built: the lane takes it now.
  assert.equal(R.READINGS.find((x) => x.id === 'R1').needs, undefined, 'R1 waits for no unit');
  for (const id of ['R4', 'R5', 'R7', 'R8', 'R12', 'R13']) assert.match(R.READINGS.find((x) => x.id === id).later.join(' '), /U\d+ \(#\d+\)/, id);
});

test('a reading that waits for a later unit is held to it: once that unit\'s code is in the tree, no reading may still wait for it', () => {
  // The app's own code (not its tests or pages), read once.
  const app = path.join(ROOT, 'app');
  const files = [...fs.readdirSync(app).filter((f) => f.endsWith('.js')).map((f) => path.join(app, f))];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.js')) files.push(path.join(d, e.name)); } };
  walk(path.join(app, 'lib'));
  const code = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const machine = fs.existsSync(path.join(app, 'machine.js')) ? fs.readFileSync(path.join(app, 'machine.js'), 'utf8') : '';
  // Each unit's code as the plan names it: once it is there, the unit has landed.
  const LANDED = {
    U4: () => /last-stop\.json/.test(code),
    U8: () => /\/api\/machine\/(?:hello|busy|stop)/.test(code),
    U12: () => machine !== '',
    U13: () => fs.existsSync(path.join(ROOT, 'installer', 'AGMessage.iss')),
    U14: () => /forget-keys/.test(code),
    U17: () => /--for\b/.test(machine),
    U18: () => /machine\.upgrade/.test(code),
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
  // R1's U8, R3′'s and R9's left with U8 (#36): 13 units named across the readings that still wait.
  assert.ok(named >= 13, 'every unit a reading waits for is asked');
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
  assert.match(byId(j, 'R11').words, /^needs U17 \(#74\)/, 'a reading of a later unit names it');
  // Even with a record, a reading whose unit has not landed is not judged.
  assert.equal(byId(R.judge(raw({ 'R3′': { runs: 10 }, R11: { runs: 10 } })), 'R11').state, 'not run');
  assert.match(byId(R.judge(raw({ 'R3′': { runs: 10 } })), 'R3′').words, /^needs U12 \(#72\)/);
});

test('Defender: on only when real-time monitoring and scanning on access came on, in its Normal mode, with C:\\ and D:\\ no longer excluded, and were still so at the end', () => {
  assert.deepEqual(R.defenderOf(DEFENDER_ON), { asked: true, took: true, stayed: true, on: true, words: R.defenderOf(DEFENDER_ON).words });
  assert.match(R.defenderOf(DEFENDER_ON).words, /scanning on access, in its Normal mode/);
  const still = R.defenderOf({ defender: { after: { ...ON, exclusions: ['D:\\', 'E:\\cache'] }, errors: [] }, defenderEnd: ON });
  assert.deepEqual([still.took, still.on], [false, false]);
  assert.match(still.words, /did not come on as the readings need it \(D:\\ still excluded\)/);
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
  assert.match(lapsed.words, /was not so when the readings ended \(real-time monitoring off\)/);
  const cut = R.defenderOf({ ...DEFENDER_ON, defenderEnd: null });
  assert.deepEqual([cut.on, cut.words.includes('not read again when the readings ended')], [false, true]);
  assert.equal(R.defenderOf({ ...DEFENDER_ON, defenderEnd: { error: 'powershell.exe ended with 1' } }).on, false, 'an end that could not be read is not on');
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
  assert.match(x.words, /the installer not built yet \(U13, #73\)/);
  x = byId(R.judge(raw({ R5: files('NotSigned') })), 'R5');
  assert.deepEqual([x.state, x.words.split(';')[0]], ['missed', 'cloudflared.exe NotSigned']);
  assert.equal(byId(R.judge(raw({ R5: { files: [files('Valid').files[0]] } })), 'R5').state, 'not run');
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
  assert.match(x.words, /wait for U12 \(#72\) and U17 \(#74\)$/);
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
  assert.match(x.words, /v0\.5\.1 not immutable \(U16, #78, turns immutable releases on\), 1 of 2 assets with a SHA-256 digest/);
  assert.equal(byId(R.judge(raw({ R13: { status: 403, rateRemaining: 0, assets: [] } })), 'R13').state, 'not run', 'the runner\'s rate limit says nothing of the laptop');
  x = byId(R.judge(raw({ R13: { status: 0, failure: 'ENOTFOUND', assets: [] } })), 'R13');
  assert.deepEqual([x.state, x.words], ['missed', 'GitHub\'s answer was not read from the SYSTEM task (ENOTFOUND)']);
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
  assert.equal(byId(R.judge(raw({ R1: { skipped: 'the lane\'s own bound of 20 min was reached before it began' } })), 'R1').words, 'the lane\'s own bound of 20 min was reached before it began');
});

test('R1 as the lane takes it, on this machine with this checkout: halls seeded, a page seated, the stop at loopback with the proof, the next start, the page back at its own pace; no token kept', async () => {
  const work = tmp('agm-r1-');
  const port = await h.freePort();
  // The hall page's pace, read from the page's own OPTIONS, so a change to the pages' pace moves the reading with it:
  // from 0.5 s doubling to 2 s, each ±50 %.
  const page = /const OPTIONS = Object\.freeze\(\{ reconnectionDelay: (\d+), reconnectionDelayMax: (\d+), randomizationFactor: ([\d.]+) \}\);/.exec(fs.readFileSync(path.join(h.ROOT, 'public', 'reconnect.js'), 'utf8'));
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
  // asks is the upgrade's own and needs no reason typed.
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
    // Each stop was the machine's at loopback, not a signal: the server said so as it stopped.
    const log = fs.readFileSync(path.join(work, 'r1', 'large', 'data', 'logs', 'server.log'), 'utf8');
    assert.equal((log.match(/Stopping for an upgrade, asked at loopback by the readings lane\./g) || []).length, 2, log.slice(-2000));
    assert.equal((log.match(/Stopping for a stop, asked at loopback by the readings lane\./g) || []).length, 1, 'and the lane\'s own stop at its end');
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
  assert.match(n, /\*\*Not run:\*\* R1 \(not taken by this lane\); R3′ \(needs U12 \(#72\)/);
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
  assert.match(R.notes(cut, ''), /The lane was cut short: a reading it had not reached reads not run\. Defender came on, .* not read again when the readings ended\./);
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
    const udpPort = await new Promise((resolve, reject) => {
      const probe = require('dgram').createSocket('udp4');
      probe.once('error', reject);
      probe.bind(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
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

test('the lane in CI: windows-2025, every action pinned by its commit, no credential left in its checkout, Defender turned on before anything is laid or measured, every step bounded inside the job, its readings kept whatever they say', () => {
  const ci = read('.github/workflows/ci.yml');
  const lane = job(ci, 'readings');
  assert.match(lane, /\n {4}runs-on: windows-2025\n/);
  assert.match(lane, /\n {4}needs: package\n/, 'the zip the package job built');
  const uses = [...lane.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
  assert.deepEqual(uses.map((u) => u[1].split('@')[0]), ['actions/checkout', 'actions/setup-node', 'actions/download-artifact', 'actions/upload-artifact']);
  for (const [, ref, comment] of uses) assert.match(ref + comment, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, ref + ' is pinned by its commit, its tag beside it');
  const steps = lane.split(/\n {6}- /).slice(1);
  assert.match(steps[0], /^uses: actions\/checkout@/);
  assert.match(steps[0], /\n {8}with:\n {10}persist-credentials: false\n/, 'the stand-in tasks run the bundle\'s code from this workspace: no token is left in its .git');
  assert.match(steps[1], /^name: Defender's real-time monitoring back on/, 'Defender first, after the checkout that holds its script');
  assert.match(steps[1], /shell: powershell\n\s+timeout-minutes: \d+\n\s+run: \.\/tools\/defender-on\.ps1 -Out "\$env:RUNNER_TEMP\\defender\.json"/);
  const order = ['tools/defender-on.ps1', 'actions/download-artifact', 'node tools/readings-take.js take --zip', 'node tools/readings.js judge readings/readings.raw.json --out readings/readings.json --summary $env:GITHUB_STEP_SUMMARY', 'actions/upload-artifact'].map((s) => lane.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'Defender, the zip, the readings, the verdicts, kept: ' + order);
  assert.match(lane, /--defender "\$env:RUNNER_TEMP\\defender\.json" --out readings\/readings\.raw\.json @release @over\n/, 'the tag through the environment, never pasted into the script');
  assert.match(lane, /\$release = if \(\$env:RELEASE_TAG\) \{ @\('--repo', \$env:GITHUB_REPOSITORY, '--tag', \$env:RELEASE_TAG\) \} else \{ @\(\) \}/, 'no release named: no --tag, never an empty argument');
  assert.match(lane, /\$over = if \(\$previous\.Count -eq 1\) \{ @\('--previous', \$previous\[0\]\.FullName\) \} else \{ @\(\) \}/, 'the newest release\'s zip, when it was had, for R2');
  assert.ok(!/run: [^\n]*\$\{\{ steps\./.test(lane) && !/\n\s+node [^\n]*\$\{\{/.test(lane), 'no step output pasted into a command');
  assert.match(lane.slice(lane.indexOf('actions/upload-artifact')), /^\s+if: always\(\)\n\s+timeout-minutes: \d+\n\s+with:\n\s+name: agmessage-readings-\$\{\{ github\.sha \}\}\n\s+path: readings\n/m);
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
  // failed, never cancelled by its own timeout, so the release that waits for it still runs. The lane's own bound
  // (BUDGET_MS) begins no reading late enough for the longest reading's own waits (R12's, R4's: under 20 min) to pass the
  // take step's.
  const bounds = steps.map((x) => { const m = /\n {8}timeout-minutes: (\d+)\n/.exec('\n' + x.split('\n').slice(1).join('\n') + '\n'); return m ? Number(m[1]) : null; });
  assert.ok(bounds.every((b) => Number.isInteger(b) && b > 0), 'every step has its own bound: ' + bounds);
  const jobBound = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(lane)[1]);
  assert.ok(bounds.reduce((a, b) => a + b, 0) + 5 <= jobBound, 'the steps end inside the job: ' + bounds + ' within ' + jobBound);
  const takeBound = bounds[steps.findIndex((x) => x.startsWith('name: Take the readings'))];
  assert.ok(T.BUDGET_MS / 60000 + 20 <= takeBound, 'the lane begins no reading after ' + T.BUDGET_MS / 60000 + ' min, inside the take step\'s ' + takeBound);
  const ps = read('tools/defender-on.ps1');
  assert.match(ps, /Set-MpPreference -DisableRealtimeMonitoring \$false/);
  assert.match(ps, /foreach \(\$x in 'C:\\', 'D:\\'\) \{\n\s+try \{ Remove-MpPreference -ExclusionPath \$x \}/);
  assert.match(ps, /Get-MpComputerStatus/);
  assert.match(ps, /if \(-not \$d -or -not \$d\.realtime -or -not \$d\.onAccess -or \$d\.mode -ne 'Normal'\) \{ return \$false \}/, 'on as tools/readings.js judges it: scanning on access, in its Normal mode');
  assert.match(ps, /\$record\.took = \[bool\]\(Is-On \$record\.after\)/, 'whether it took, read back');
  assert.match(ps, /\nexit 0\n$/, 'it informs, never fails the job for Defender');
});
test('the release waits for the lane and never is held by it: its notes carry the readings, or say there are none', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = job(ci, 'release');
  assert.match(release, /\n {4}if: \$\{\{ !cancelled\(\) && startsWith\(github\.ref, 'refs\/tags\/v'\) && needs\.package\.result == 'success' \}\}\n {4}needs: \[package, readings\]\n/);
  const sparse = release.slice(release.indexOf('sparse-checkout: |'), release.indexOf('sparse-checkout-cone-mode'));
  for (const f of ['tools/readings.js', 'docs/INSTALL.md']) assert.ok(sparse.split('\n').some((l) => l.trim() === f), f + ' is checked out: the notes\' tool and the lab lines\' record');
  const dl = release.indexOf('name: agmessage-readings-$' + '{{ github.sha }}');
  const notes = release.indexOf('node tools/readings.js notes readings/readings.json --install docs/INSTALL.md');
  const create = release.indexOf('gh release create');
  assert.ok(dl > 0 && notes > dl && create > notes, 'the readings downloaded, the notes made, then the release');
  assert.match(release.slice(release.lastIndexOf('- uses: actions/download-artifact@', dl), dl), /@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+continue-on-error: true\n/, 'a lane that wrote nothing does not stop it');
  assert.match(release.slice(create), /--notes-file "\$RUNNER_TEMP\/notes\.md"/);
  assert.match(release.slice(notes, create), /^node tools\/readings\.js notes readings\/readings\.json --install docs\/INSTALL\.md \|\| printf '### The Windows readings\\n\\nThe Windows readings for this build could not be read: nothing is claimed for them\./, 'a notes step that fails anyway leaves words, never a held release');
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
