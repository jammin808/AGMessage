'use strict';
// The installed node's machine-level commands. machine.js runs elevated or as SYSTEM, by its absolute path, Node's
// built-ins only; launch.js serve is the server task's action and launch.js status the person's reader. Held here on every
// platform: the argument parsing and its exit codes, the folder order with its refusals, the task's definition, the
// firewall rules, the record, the machine's wire half matched to lib/machinewire.js and lib/busy.js, the stop for an
// upgrade and its backup against a real server, the way back's restore, uninstall and preinstall-check, and launch.js
// serve with the real watchdog. What only Windows shows (icacls, schtasks, reg and powershell.exe applying, the task as
// LocalService) is the Windows jobs' and the readings lane's: the Windows hands are stood in for here, by their calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const launch = require('../launch');
const wire = require('../lib/machinewire');
const busy = require('../lib/busy');
const version = require('../lib/version');
const upgradebackup = require('../lib/upgradebackup');
/** The words the installer's life cycle reads on Windows (installer/test/expect.js), held here to a real server's. */
const lifecycleWords = require('../../installer/test/expect.js').WORDS;

const W = 'C:\\ProgramData\\AGMessage';
const SYS = 'C:\\Windows\\System32';
const TASK_SID = 'S-1-5-87-11-22-33-44-55';
const ANA = 'S-1-5-21-1-2-3-1001';
const BEN = 'S-1-5-21-1-2-3-1002';
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const base = (exe) => path.win32.basename(exe);
const fail = (status, out = '', err = 'refused') => Object.assign(new Error(err), { status, stdout: out, stderr: err });

/**
 * A stand-in for Windows' hands: the registry under HKLM\SOFTWARE\AGMessage, Task Scheduler's tasks and what each program
 * was asked, in order. `failIcacls` names an argument whose icacls call fails; `noSid` gives /ShowSid no SID.
 */
function fakeWindows({ record = null, owner = 'O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', failIcacls = '', noSid = false, tasks = [], grants = null, noList = false } = {}) {
  let reg = record ? { ...record } : null;
  const has = new Set(tasks);
  const calls = [];
  const xml = {};
  const run = (exe, args, opts) => {
    const name = base(exe);
    calls.push({ name, args, env: opts && opts.env });
    if (name === 'reg.exe') {
      if (args[0] === 'query' && args[1] === machine.HKLM) {
        if (!reg) throw fail(1);
        return Object.entries(reg).map(([k, v]) => '    ' + k + '    ' + (k === 'Port' ? 'REG_DWORD    0x' + Number(v).toString(16) : 'REG_SZ    ' + v)).join('\r\n');
      }
      if (args[0] === 'query' && args[1] === machine.HKLM + '\\Grants' && grants) return Object.entries(grants).map(([sid, rights]) => '    ' + sid + '    REG_SZ    ' + rights).join('\r\n');
      if (args[0] === 'query') throw fail(1);
      if (args[0] === 'add') { if (!reg) reg = {}; reg[args[args.indexOf('/v') + 1]] = args[args.indexOf('/d') + 1]; return ''; }
      if (args[0] === 'delete') { if (args.includes('/v')) { if (reg) delete reg[args[args.indexOf('/v') + 1]]; } else if (args[1] === machine.HKLM) reg = null; return ''; }
    }
    if (name === 'schtasks.exe') {
      const tn = args[args.indexOf('/TN') + 1];
      if (args[0] === '/Create') { has.add(tn); xml[tn] = Buffer.from(fs.readFileSync(args[args.indexOf('/XML') + 1])).toString('utf16le'); return 'SUCCESS'; }
      if (args[0] === '/ShowSid') return noSid ? 'SUCCESS' : 'SUCCESS: The SID "' + TASK_SID + '" for the user name "NT TASK\\AGMessage-Server" has been computed successfully.';
      if (args[0] === '/Query' && tn === machine.TASK_FOLDER) { if (noList) throw fail(1, '', 'ERROR: The parameter is incorrect.'); return [...has].map((t) => '"' + t + '","N/A","Bereit"').join('\r\n'); }
      if (args[0] === '/Query') { if (!has.has(tn)) throw fail(1); return '"HOST","' + tn + '","N/A","Bereit","Interaktiv/Hintergrund","06.11.2026 10:00:00","0"'; }
      if (args[0] === '/End') return '';
      if (args[0] === '/Delete') { has.delete(tn); return 'SUCCESS'; }
    }
    if (name === 'icacls.exe') { if (failIcacls && args.join(' ').includes(failIcacls)) throw fail(5, '', 'Access is denied.'); return 'processed 1 files'; }
    if (name === 'powershell.exe') {
      const script = args[args.length - 1];
      if (script === machine.PS_OWNER) return JSON.stringify({ sddl: owner }) + '\r\n';
      if (script === machine.PS_FIREWALL_ADD) return '{"ok":true}\r\n';
      if (script === machine.PS_FIREWALL_REMOVE) return '{"removed":["AGMessage-Server-TCP"],"missing":["AGMessage-Discovery-UDP"]}\r\n';
      if (script === machine.PS_STATUS) return '{"pid":4120,"codeIntegrity":{"found":false}}\r\n';
    }
    throw new Error('the stand-in was asked what it does not know: ' + name + ' ' + args.join(' '));
  };
  return { run, calls, reg: () => reg, tasks: has, xml };
}
/** The installed layout {app} holds: node\node.exe, app\launch.js and app\machine.js. */
function appFolder() {
  const app = tmp('agm-app-');
  fs.mkdirSync(path.join(app, 'node'));
  fs.mkdirSync(path.join(app, 'app'));
  fs.writeFileSync(path.join(app, 'node', 'node.exe'), '');
  fs.writeFileSync(path.join(app, 'app', 'launch.js'), '');
  fs.writeFileSync(path.join(app, 'app', 'machine.js'), '');
  return app;
}
/** A machine folder made by prepare on this disk (the Windows hands stood in for), its record none yet. */
function prepared() {
  const root = path.join(tmp('agm-mach-'), 'AGMessage');
  const win = fakeWindows();
  const r = machine.prepare({ '--machine': root, '--sys': SYS }, { run: win.run });
  return { root, setup: r.setup };
}

// ---------------------------------------------------------------- the command line and its exit codes

test('machine.js knows its commands, each with its own options; an unknown word, an option of another verb and one given twice are refused', () => {
  assert.deepEqual(machine.VERBS, ['prepare', 'install', 'uninstall', 'preinstall-check', 'upgrade-stop', 'status', 'restore', 'whose', 'start', 'first-account', 'control', 'import', 'upgrade']);
  assert.deepEqual(machine.LATER, {}, 'every unit\'s verb is built: upgrade is U18\'s, the last');
  assert.deepEqual(machine.parse(['prepare', '--machine', W, '--sys', SYS]), { verb: 'prepare', opts: { '--machine': W, '--sys': SYS } });
  assert.deepEqual(machine.parse(['upgrade', '--step', 'run', '--plan', W, '--sys', SYS]).opts, { '--step': 'run', '--plan': W, '--sys': SYS });
  assert.equal(machine.parse(['upgrade', '--for', 'x']).problem, '"--for" is not an argument machine.js upgrade knows.', 'the runner takes its plan, never an account');
  assert.match(machine.parse(['zzz']).problem, /is not one of machine\.js's commands/);
  assert.match(machine.parse(['toString']).problem, /is not one of machine\.js's commands/, 'an Object property is no verb');
  assert.match(machine.parse([]).problem, /machine\.js takes a command/);
  assert.equal(machine.parse(['install', '--nope', 'x']).problem, '"--nope" is not an argument machine.js install knows.');
  assert.equal(machine.parse(['prepare', '--port', '3023']).problem, '"--port" is not an argument machine.js prepare knows.', 'another verb\'s option is refused, never ignored');
  assert.equal(machine.parse(['upgrade-stop', '--by']).problem, '--by needs a value.');
  assert.equal(machine.parse(['install', '--port', '1', '--port', '2']).problem, '--port is given twice.');
  assert.equal(machine.parse(['uninstall', '--remove-data', '--remove-data']).problem, '--remove-data is given twice.');
  assert.deepEqual(machine.parse(['uninstall', '--machine', W, '--remove-data']).opts, { '--machine': W, '--remove-data': true });
  assert.deepEqual(machine.parse(['upgrade-stop', '--machine', W, '--port', '3023', '--by', 'LAPTOP\\ana']).opts['--by'], 'LAPTOP\\ana');
  // Every machine path is an argument Inno passes ({sys}, {app}, {commonappdata}): machine.js reads nothing of its
  // environment, and what powershell.exe is handed is Windows' own folders made from --sys and the script's own values.
  assert.ok(!/process\.env/.test(h.readSource(path.join(h.ROOT, 'machine.js'))), 'machine.js reads no machine path from its environment');
});

test('a missing or malformed argument is 64, not a refusal: --machine, --sys, --port, --out; a drive-relative path is no full path on Windows', async () => {
  const code = async (argv) => (await machine.run(argv, { run: () => { throw new Error('never run'); } })).code;
  assert.equal(await code(['prepare', '--sys', SYS]), 64, 'no --machine');
  assert.equal(await code(['prepare', '--machine', W]), 64, 'no --sys');
  assert.equal(await code(['prepare', '--machine', W, '--sys', 'System32']), 64, 'a --sys not from its drive');
  assert.equal(await code(['preinstall-check', '--machine', W]), 64, 'no --port');
  assert.equal(await code(['preinstall-check', '--machine', W, '--port', '70000']), 64, 'a port past 65535');
  assert.equal(await code(['preinstall-check', '--machine', W, '--port', '3023x']), 64, 'a port that is not a number');
  assert.equal(await code(['status', '--machine', 'relative\\folder', '--sys', SYS]), 64);
  assert.equal(await code(['prepare', '--machine', W, '--sys', SYS, '--out', 'out.json']), 64, 'an --out that is no full path');
  assert.equal(machine.fullPath('\\ProgramData\\AGMessage', 'win32'), false, 'from the current drive\'s root');
  assert.equal(machine.fullPath('C:ProgramData', 'win32'), false, 'a drive\'s current folder');
  assert.equal(machine.fullPath('\\\\?\\C:\\ProgramData', 'win32'), false, 'a long-path prefix');
  assert.equal(machine.fullPath('/tmp/x', 'win32'), false, 'a POSIX path on Windows');
  assert.equal(machine.fullPath('C:\\ProgramData\\AGMessage', 'win32'), true);
  assert.equal(machine.fullPath('\\\\host\\share', 'win32'), true);
  assert.equal(machine.fullPath('/tmp/x', 'linux'), true);
});

// ---------------------------------------------------------------- the pure planners

test('the machine folder\'s children: SYSTEM and Administrators first; the task may modify what it writes, token\\ too (a rename needs delete); the laptop\'s admin reads token\\ and logs\\', () => {
  assert.deepEqual(machine.CHILDREN.map((c) => c.name), ['data', 'uploads', 'keys', 'logs', 'token', 'machine']);
  assert.deepEqual(machine.BASE_GRANTS, ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  const by = Object.fromEntries(machine.CHILDREN.map((c) => [c.name, c]));
  for (const name of ['data', 'uploads', 'keys', 'logs', 'token']) assert.equal(by[name].task, 'M', name);
  assert.deepEqual([by.logs.admin, by.token.admin, by.data.admin, by.keys.admin], ['R', 'R', undefined, undefined]);
  assert.equal(by.machine.task, undefined, 'machine\\ is SYSTEM and Administrators only');
  assert.deepEqual(machine.MACHINE_SUBS, ['inbox', 'outbox', 'work', 'staged']);
  assert.deepEqual(machine.inboxGrants(ANA), ['*' + ANA + ':(WD)', '*' + ANA + ':(OI)(IO)W'], 'its inbox\\: add a file to the folder (never a folder or a junction), write the files in it');
  assert.deepEqual(machine.outboxGrants(ANA), ['*' + ANA + ':(OI)(CI)RX']);
  assert.equal(machine.SETUP_GRANT, '*S-1-5-11:(WD,AD,WA)', 'any signed-in account may create a file there, none may list or read');
});

test('the server task\'s definition: node.exe on launch.js serve by their absolute paths from launch.js\'s folder, LocalService under its own SID, SeChangeNotifyPrivilege alone, a boot trigger, its descriptor SYSTEM and Administrators only', () => {
  const app = 'C:\\Program Files\\AGMessage';
  const xml = machine.serverTaskXml({ node: app + '\\node\\node.exe', launch: app + '\\app\\launch.js', data: W + '\\data', uploads: W + '\\uploads', keys: W + '\\keys', logs: W + '\\logs', token: W + '\\token', events: W + '\\machine\\events.jsonl', port: 3023 });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-16"\?>\r\n/);
  assert.match(xml, /<URI>\\AGMessage\\Server<\/URI>/);
  assert.match(xml, /<SecurityDescriptor>D:P\(A;;FA;;;SY\)\(A;;FA;;;BA\)<\/SecurityDescriptor>/, 'read and execute (full control) to SYSTEM and Administrators only, nothing inherited');
  assert.equal(machine.SERVER_TASK_SDDL, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)');
  assert.match(xml, /<UserId>S-1-5-19<\/UserId>/, 'LocalService');
  assert.match(xml, /<ProcessTokenSidType>Unrestricted<\/ProcessTokenSidType>/);
  assert.match(xml, /<RequiredPrivileges><Privilege>SeChangeNotifyPrivilege<\/Privilege><\/RequiredPrivileges>/);
  assert.match(xml, /<BootTrigger><Enabled>true<\/Enabled><\/BootTrigger>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
  assert.match(xml, /<Command>C:\\Program Files\\AGMessage\\node\\node\.exe<\/Command>/);
  assert.match(xml, /<Arguments>&quot;C:\\Program Files\\AGMessage\\app\\launch\.js&quot; serve --data C:\\ProgramData\\AGMessage\\data --uploads [^<]* --token C:\\ProgramData\\AGMessage\\token --events C:\\ProgramData\\AGMessage\\machine\\events\.jsonl --port 3023<\/Arguments>/, 'launch.js by its absolute path, quoted for its space; the machine\'s events file, which the server reads');
  assert.match(xml, /<WorkingDirectory>C:\\Program Files\\AGMessage\\app<\/WorkingDirectory>/);
  // No secret in a task's definition: nothing shaped as a token, no password, no account of a person.
  assert.ok(!/[0-9a-f]{16}/.test(xml) && !/password|ADMIN_TOKEN|ANTHROPIC/i.test(xml) && !/S-1-5-21/.test(xml), 'no secret in the definition');
  assert.equal(machine.winArg('a b'), '"a b"');
  assert.equal(machine.winArg('C:\\x y\\'), '"C:\\x y\\\\"');
});

test('the firewall rules: by program, protocol and local port, from the local subnet, Private and Domain, Public only when ticked; made by the cmdlets with their values handed in by name', () => {
  const node = 'C:\\Program Files\\AGMessage\\node\\node.exe';
  const priv = machine.firewallRules({ node, port: 3023 });
  assert.deepEqual(priv.map((r) => [r.name, r.protocol, r.port, r.program, r.remote]), [['AGMessage-Server-TCP', 'TCP', 3023, node, 'LocalSubnet'], ['AGMessage-Discovery-UDP', 'UDP', 9928, node, 'LocalSubnet']]);
  assert.ok(priv.every((r) => r.profiles.join(',') === 'Domain,Private'));
  assert.ok(machine.firewallRules({ node, port: 3023, public: true }).every((r) => r.profiles.join(',') === 'Domain,Private,Public'));
  // The scripts take every value from their environment and hold no double quote (a command line would have to escape it).
  for (const s of [machine.PS_OWNER, machine.PS_FIREWALL_ADD, machine.PS_FIREWALL_REMOVE, machine.PS_STATUS]) {
    assert.ok(!s.includes('"') && !s.includes('\n'), 'one line, single quotes only');
    assert.match(s, /\$PSHOME \+ '\\Modules\\'/, 'its modules imported by their manifests\' paths under $PSHOME');
  }
  assert.match(machine.PS_FIREWALL_ADD, /-Program \$env:AGM_NODE -Protocol TCP -LocalPort \$env:AGM_PORT -RemoteAddress LocalSubnet -Profile \$p/);
  assert.match(machine.PS_FIREWALL_ADD, /-Program \$env:AGM_NODE -Protocol UDP -LocalPort \$env:AGM_UDP -RemoteAddress LocalSubnet -Profile \$p/);
  assert.match(machine.PS_OWNER, /Get-Acl -LiteralPath \$env:AGM_PATH/);
  assert.match(machine.PS_STATUS, /Get-NetTCPConnection -LocalPort \(\[int\]\$env:AGM_PORT\) -State Listen/);
});

test('the install record: Version is MAJOR.MINOR.BUILD from the build, SemVer the product\'s version, read as lib/version.js reads a build; a local build has none', () => {
  for (const full of ['0.6.0+41.abc1234', '0.6.0+41', '0.6.0-dev.78+442583d', '0.6.0-dev.78', '1.2.3+65535', '0.6.0-dev+abc1234', '0.6.0-dev', '0.6.0', '256.0.0+1', '0.6.0+65536', '0.6.0+0', 'x', '0.6.0+41.abc1234.x']) {
    const p = version.parseBuild(full);
    const want = p && p.installVersion ? { semver: p.version, version: p.installVersion } : null;
    assert.deepEqual(machine.installOf(full), want, full);
  }
  const built = machine.installOf('0.6.0+41.abc1234');
  assert.deepEqual(built, { semver: '0.6.0', version: '0.6.41' });
  const v = machine.recordValues({ dir: 'C:\\Program Files\\AGMessage', ...built, admin: ANA, adminName: 'LAPTOP\\ana', port: 3023 });
  const by = Object.fromEntries(v.map((x) => [x.name, x.value]));
  assert.deepEqual(Object.keys(by), ['InstallDir', 'Version', 'SemVer', 'Previous', 'Runs', 'Port', 'Admin', 'AdminName', 'PublicFirewall', 'Signed']);
  assert.deepEqual([by.Version, by.SemVer, by.Runs, by.Previous, by.Port, by.PublicFirewall, by.Signed], ['0.6.41', '0.6.0', 'task', '', '3023', '0', '0']);
  assert.notEqual(by.Version, by.SemVer, 'the order an upgrade compares is the build\'s, never the product version alone');
  assert.ok(!v.some((x) => /token|password/i.test(x.name)), 'no token or password in the record');
});

test('the owner read from Get-Acl\'s SDDL: SYSTEM and Administrators by their aliases or SIDs, another account by its SID; none otherwise', () => {
  assert.equal(machine.ownerSidOf('O:SYG:SYD:PAI(A;OICI;FA;;;SY)'), 'S-1-5-18');
  assert.equal(machine.ownerSidOf('O:BAD:PAI'), 'S-1-5-32-544');
  assert.equal(machine.ownerSidOf('O:S-1-5-32-544G:SY'), 'S-1-5-32-544');
  assert.equal(machine.ownerSidOf('O:S-1-5-21-9-9-9-1001G:S-1-5-21-9-9-9-513D:(A;;FA;;;WD)'), 'S-1-5-21-9-9-9-1001');
  assert.equal(machine.ownerSidOf('D:PAI(A;;FA;;;WD)'), '', 'no owner field: none');
  assert.equal(machine.ownerSidOf('O:S-1--5G:SY'), '', 'not a SID');
});

// The real scripts, on Windows, through the machine's own hands (powershell.exe by its absolute path, in an environment of
// SystemRoot and Windows' module path alone): the two that only read. prepare's owner check reads a real folder's owner
// as a SID, never '' for a folder that is there; the port's holder is this process; the code-integrity log is read, or
// Windows says why. The two that change the machine (the firewall's rules) are the installer job's to prove.
test('on Windows, the owner and status scripts answer in their own shape: a real folder\'s owner as a SID, the port\'s holder by its pid', { skip: process.platform !== 'win32' && 'the scripts run on Windows only' }, async (t) => {
  const sys = path.win32.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32');
  const H = machine.hands(sys);
  const dir = tmp('agm-owner-');
  const a = H.powershell(machine.PS_OWNER, { AGM_PATH: dir });
  assert.equal(a.error, undefined, JSON.stringify(a));
  assert.match(machine.ownerSidOf(a.sddl), /^S-1-\d/, 'the owner read from ' + a.sddl);
  const gone = H.powershell(machine.PS_OWNER, { AGM_PATH: path.join(dir, 'not-there') });
  assert.equal(typeof gone.error, 'string', 'a folder not there says why, never an owner');
  const port = await h.freePort();
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const s = H.powershell(machine.PS_STATUS, { AGM_PORT: String(port), AGM_NODE_TAIL: '\\node\\node.exe' });
  assert.equal(s.pid, process.pid, JSON.stringify(s));
  assert.ok(typeof (s.codeIntegrity && s.codeIntegrity.found) === 'boolean' || typeof s.codeIntegrityError === 'string', JSON.stringify(s));
});

test('schtasks\' and the record\'s answers read by position, never by Windows\' words: an English and a German answer read alike, launch.js\'s copy the same', () => {
  const en = '"LAPTOP","\\AGMessage\\Server","N/A","Ready","Interactive/Background","11/6/2026 10:00:00 AM","267014","N/A","node.exe"\r\n';
  const de = '"LAPTOP","\\AGMessage\\Server","Nicht zutreffend","Wird ausgef\u00fchrt","Interaktiv/Hintergrund","06.11.2026 10:00:00","0","N/A","node.exe"\r\n';
  assert.deepEqual(machine.taskStateOf(en), { state: 'Ready', lastResult: 267014 });
  assert.deepEqual(machine.taskStateOf(de), { state: 'Wird ausgef\u00fchrt', lastResult: 0 });
  assert.equal(machine.taskStateOf('ERROR'), null);
  for (const t of [en, de, '"a ""quoted"" name","b"', '', 'x']) assert.deepEqual(launch.csvRows(t), machine.csvRows(t), t);
});

// ---------------------------------------------------------------- prepare: the race-free folder order

/** An in-memory folder tree, so prepare's order is held: `exists` folders there before it runs (each with its entries). */
function fakeFolders({ exists = {}, links = [], fill = {} } = {}) {
  const made = new Set(Object.keys(exists));
  const calls = [];
  const fsImpl = {
    mkdirSync: (p) => { if (made.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); made.add(p); calls.push({ name: 'mkdir', args: [p] }); },
    readdirSync: (p) => fill[p] || exists[p] || [],
    lstatSync: (p) => ({ isDirectory: () => !links.includes(p), isSymbolicLink: () => links.includes(p) }),
  };
  return { fsImpl, calls, made };
}

test('prepare: the plan\'s order on a new root — made, its inheritance cut and SYSTEM and Administrators in full control (never /T), listed, marked Prepared, then each child made with its grants, then machine\\\'s, then setup\\<128 random bits>\\', () => {
  const win = fakeWindows();
  const f = fakeFolders();
  const r = machine.prepare({ '--machine': W, '--sys': SYS }, { run: (e, a, o) => { f.calls.push({ name: base(e), args: a }); return win.run(e, a, o); }, fsImpl: f.fsImpl });
  assert.match(r.setup, /\\setup\\[0-9a-f]{32}$/, 'setup\\<128 random bits>');
  assert.ok(!r.words.includes(r.setup), 'setup\'s name is said in --out alone');
  const steps = f.calls.map((c) => c.name + ' ' + c.args.join(' ').replace(W, '<root>'));
  assert.deepEqual(steps.slice(0, 5), [
    'mkdir <root>',
    'icacls.exe <root> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F',
    'reg.exe add HKLM\\SOFTWARE\\AGMessage /v Prepared /t REG_SZ /d <root> /f /reg:64',
    'mkdir <root>\\data',
    'icacls.exe <root>\\data /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F',
  ]);
  assert.ok(!steps.some((s) => s.split(' ').includes('/T')), 'never /T');
  const children = steps.filter((s) => s.startsWith('icacls.exe')).map((s) => s.split(' ')[1].replace('<root>\\', ''));
  assert.deepEqual(children.slice(1, 7), ['data', 'uploads', 'keys', 'logs', 'token', 'machine']);
  assert.deepEqual(steps.filter((s) => /^mkdir <root>\\machine\\/.test(s)).map((s) => s.split('\\').pop()), ['inbox', 'outbox', 'work', 'staged']);
  assert.ok(steps[steps.length - 1].endsWith('*S-1-5-11:(WD,AD,WA)') && /\\setup\\[0-9a-f]{32} /.test(steps[steps.length - 1]), 'setup last: a file may be dropped, nothing listed or read');
  assert.ok(!f.calls.some((c) => c.name === 'powershell.exe'), 'a root it made is its own: no owner to read');
});

test('prepare refuses an existing root with no earlier install, one that is a link, one another account owns or whose owner cannot be read; it takes one an install recorded, or a prepare that no install finished', () => {
  const tryIt = (o) => { const f = fakeFolders({ exists: { [W]: [] }, links: o.links || [] }); return machine.prepare({ '--machine': W, '--sys': SYS }, { run: fakeWindows(o).run, fsImpl: f.fsImpl }); };
  const refused = (o, words) => assert.throws(() => tryIt(o), (e) => e.refused === true && words.test(e.words));
  refused({}, /the install record shows no earlier AGMessage install/);
  refused({ record: { InstallDir: 'C:\\Program Files\\AGMessage' }, links: [W] }, /is not a real directory/);
  refused({ record: { InstallDir: 'C:\\Program Files\\AGMessage' }, owner: 'O:S-1-5-21-9-9-9-1001G:SYD:PAI' }, /is owned by S-1-5-21-9-9-9-1001, not SYSTEM or Administrators/);
  refused({ record: { InstallDir: 'x' }, owner: '' }, /is owned by an account not named/);
  refused({ record: { Prepared: 'D:\\Elsewhere' } }, /shows no earlier AGMessage install/, 'a prepare of another root');
  assert.match(tryIt({ record: { InstallDir: 'C:\\Program Files\\AGMessage' }, owner: 'O:BAG:SYD:PAI' }).root, /AGMessage$/);
  assert.match(tryIt({ record: { Prepared: W.toLowerCase() } }).root, /AGMessage$/, 'a prepare that no install finished is taken again');
});

test('prepare refuses a new root another account filled before the grant ran, a child made after the listing, and a child of an existing root that is a link — before any grant on it', () => {
  // The root made, then found holding something: refused, and it is not marked Prepared (a retry refuses it too).
  let win = fakeWindows();
  let f = fakeFolders({ fill: { [W]: ['planted.dll'] } });
  assert.throws(() => machine.prepare({ '--machine': W, '--sys': SYS }, { run: win.run, fsImpl: f.fsImpl }), (e) => e.refused && /another account added to it/.test(e.words));
  assert.ok(!win.calls.some((c) => c.name === 'reg.exe' && c.args[0] === 'add'), 'not marked Prepared');
  // A new root listed empty, then a child there already: made by another account after the listing.
  win = fakeWindows();
  f = fakeFolders();
  f.made.add(W + '\\keys');
  assert.throws(() => machine.prepare({ '--machine': W, '--sys': SYS }, { run: win.run, fsImpl: f.fsImpl }), (e) => e.refused && /the keys folder .* was made by another account after/.test(e.words));
  assert.ok(!win.calls.some((c) => c.name === 'icacls.exe' && c.args[0] === W + '\\keys'), 'no grant on it');
  // An existing root whose data folder is a junction: refused before icacls follows it.
  win = fakeWindows({ record: { InstallDir: 'x' } });
  f = fakeFolders({ exists: { [W]: ['data'], [W + '\\data']: [] }, links: [W + '\\data'] });
  assert.throws(() => machine.prepare({ '--machine': W, '--sys': SYS }, { run: win.run, fsImpl: f.fsImpl }), (e) => e.refused && /the data folder .* is not a real directory/.test(e.words));
  assert.ok(!win.calls.some((c) => c.name === 'icacls.exe' && c.args[0] === W + '\\data'), 'no grant through the link');
  // A grant that fails is not done (2), naming the folder.
  win = fakeWindows({ failIcacls: W + '\\token' });
  assert.throws(() => machine.prepare({ '--machine': W, '--sys': SYS }, { run: win.run, fsImpl: fakeFolders().fsImpl }), (e) => !e.refused && /the token folder's access list could not be set \(Access is denied\.\)/.test(e.words));
});

// ---------------------------------------------------------------- install

test('install: the task registered from its definition (then removed), its SID given what it uses, the admin its reads and its inbox\\ and outbox\\, events.jsonl alone readable by the task, the rules, the record last; machine.admin appended once; setup\\ removed', async () => {
  const { root } = prepared();
  const app = appFolder();
  const win = fakeWindows();
  const out = path.join(root, '..', 'install.json');
  const r = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0+41.abc1234', '--port', '3023', '--admin', ANA, '--admin-name', 'LAPTOP\\ana', '--public', '--out', out], { run: win.run });
  assert.equal(r.code, 0, r.text);
  const xml = win.xml[machine.SERVER_TASK];
  assert.ok(xml.includes('<Command>' + path.join(app, 'node', 'node.exe') + '</Command>'), 'node.exe from {app}\\node');
  assert.ok(xml.includes(path.join(app, 'app', 'launch.js') + ' serve --data ' + path.join(root, 'data')), 'launch.js by its absolute path, from {app}\\app');
  assert.ok(xml.includes('<WorkingDirectory>' + path.join(app, 'app') + '</WorkingDirectory>'));
  assert.ok(!fs.existsSync(path.join(root, 'machine', 'work', 'server-task.xml')), 'the definition is not left on disk');
  const icacls = win.calls.filter((c) => c.name === 'icacls.exe').map((c) => c.args.join(' '));
  for (const name of ['data', 'uploads', 'keys', 'logs', 'token']) assert.ok(icacls.includes(path.join(root, name) + ' /grant:r *' + TASK_SID + ':(OI)(CI)M'), name + ': the task may modify');
  for (const name of ['logs', 'token']) assert.ok(icacls.includes(path.join(root, name) + ' /grant:r *' + ANA + ':(OI)(CI)R'), name + ': the admin reads');
  assert.ok(icacls.includes(path.join(root, 'machine', 'events.jsonl') + ' /grant:r *' + TASK_SID + ':(R)'), 'events.jsonl alone, no list of machine\\');
  assert.ok(!icacls.some((a) => a.startsWith(path.join(root, 'machine') + ' ')), 'nothing granted on machine\\ itself');
  assert.ok(icacls.includes(path.join(root, 'machine', 'inbox', ANA) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *' + ANA + ':(WD)'));
  assert.ok(icacls.indexOf(path.join(root, 'machine', 'inbox', ANA) + ' /grant *' + ANA + ':(OI)(IO)W') > icacls.indexOf(path.join(root, 'machine', 'inbox', ANA) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *' + ANA + ':(WD)'), 'the files\' grant added by a call of its own, after the access list');
  assert.ok(icacls.includes(path.join(root, 'machine', 'outbox', ANA) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *' + ANA + ':(OI)(CI)RX'));
  const fw = win.calls.find((c) => c.name === 'powershell.exe');
  assert.deepEqual([fw.env.AGM_NODE, fw.env.AGM_PORT, fw.env.AGM_UDP, fw.env.AGM_PROFILES, fw.env.SystemRoot], [path.join(app, 'node', 'node.exe'), '3023', '9928', 'Domain,Private,Public', 'C:\\Windows']);
  assert.deepEqual([fw.env.windir, fw.env.SystemDrive, fw.env.TEMP, fw.env.TMP, fw.env.PSModulePath], ['C:\\Windows', 'C:', 'C:\\Windows\\Temp', 'C:\\Windows\\Temp', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'], 'Windows\' own folders, made from --sys');
  assert.ok(!('PATH' in fw.env) && !('NODE_OPTIONS' in fw.env), 'powershell.exe is handed nothing of this process\'s environment');
  const reg = win.calls.filter((c) => c.name === 'reg.exe' && c.args[0] === 'add');
  const values = Object.fromEntries(reg.map((c) => [c.args[3], c.args[7]]));
  assert.deepEqual([values.InstallDir, values.Version, values.SemVer, values.Previous, values.Admin, values.AdminName, values.PublicFirewall], [app, '0.6.41', '0.6.0', '', ANA, 'LAPTOP\\ana', '1']);
  assert.ok(win.calls.indexOf(reg[0]) > win.calls.indexOf(fw), 'the record is written last');
  const events = read(path.join(root, 'machine', 'events.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.seq, e.kind, e.by, e.for, e.rights]), [[1, 'machine.admin', { sid: ANA, name: 'LAPTOP\\ana' }, { sid: ANA, name: 'LAPTOP\\ana' }, ['token', 'start', 'stop', 'upgrade']]]);
  assert.deepEqual(Object.keys(events[0]), ['seq', 'at', 'kind', 'by', 'for', 'rights', 'words'], 'the event\'s shape, no secret in it');
  // The laptop's admin's own control task, from its definition: SYSTEM runs it, the admin alone may read and run it.
  const control = win.xml[machine.controlTask(ANA)];
  assert.ok(control && control.includes('<SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + ANA + ')</SecurityDescriptor>'), 'the admin\'s control task');
  assert.ok(control.includes(path.join(app, 'app', 'machine.js') + ' control --for ' + ANA + ' --machine ' + root + ' --sys ' + SYS), 'its action fixed at registration');
  assert.ok(!fs.readdirSync(path.join(root, 'machine', 'work')).length, 'no definition left in machine\\work\\');
  assert.ok(!fs.existsSync(path.join(root, 'setup')), 'setup\\ removed at the install\'s end');
  const rec = JSON.parse(read(out));
  assert.deepEqual([rec.v, rec.verb, rec.code, rec.taskSid, rec.version], [1, 'install', 0, TASK_SID, '0.6.41']);
});

test('install on an upgrade keeps the laptop\'s admin (a handover changes it) and appends no machine.admin; the version it replaced is Previous', async () => {
  const { root } = prepared();
  const app = appFolder();
  const win = fakeWindows({ record: { InstallDir: app, Version: '0.6.41', SemVer: '0.6.0', Admin: ANA, AdminName: 'LAPTOP\\ana', Port: '3023' } });
  const r = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.1+44.def5678', '--port', '3023', '--admin', 'S-1-5-21-1-2-3-500', '--admin-name', 'LAPTOP\\it'], { run: win.run });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /The laptop's admin stays LAPTOP\\ana \(an upgrade keeps it; a handover changes it\)\./);
  const values = Object.fromEntries(win.calls.filter((c) => c.name === 'reg.exe' && c.args[0] === 'add').map((c) => [c.args[3], c.args[7]]));
  assert.deepEqual([values.Admin, values.AdminName, values.Version, values.SemVer, values.Previous], [ANA, 'LAPTOP\\ana', '0.6.44', '0.6.1', '0.6.41']);
  assert.ok(!fs.existsSync(path.join(root, 'machine', 'events.jsonl')) || !read(path.join(root, 'machine', 'events.jsonl')).includes('machine.admin'), 'no new admin event');
  assert.ok(win.calls.some((c) => c.name === 'icacls.exe' && c.args.join(' ').includes('*' + ANA + ':(OI)(CI)R')), 'the kept admin\'s reads');
});

test('install refuses what it cannot do whole: no SID read (2, no record written), a grant that fails (2), no --admin at the first install, a local build or an --app that is not {app} (64)', async () => {
  const app = appFolder();
  let { root } = prepared();
  let win = fakeWindows({ noSid: true });
  const args = (extra = []) => ['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0+41.abc1234', '--port', '3023', '--admin', ANA, ...extra];
  let r = await machine.run(args(), { run: win.run });
  assert.equal(r.code, 2);
  assert.match(r.text, /the server task's SID could not be read/);
  assert.ok(!win.calls.some((c) => c.name === 'reg.exe' && c.args[0] === 'add'), 'no record');
  ({ root } = prepared());
  win = fakeWindows({ failIcacls: path.join(root, 'uploads') + ' /grant:r' });
  r = await machine.run(args(), { run: win.run });
  assert.deepEqual([r.code, /the uploads folder's access list could not be set/.test(r.text)], [2, true]);
  r = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0+41.abc1234', '--port', '3023'], { run: fakeWindows().run });
  assert.deepEqual([r.code, /needs --admin <SID>/.test(r.text)], [64, true]);
  r = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0-dev+abc1234', '--port', '3023', '--admin', ANA], { run: fakeWindows().run });
  assert.deepEqual([r.code, /a local build has no install version/.test(r.text)], [64, true]);
  r = await machine.run(['install', '--machine', root, '--app', path.join(app, 'app'), '--sys', SYS, '--build', '0.6.0+41', '--port', '3023', '--admin', ANA], { run: fakeWindows().run });
  assert.deepEqual([r.code, /it is the install's folder \(\{app\}\)/.test(r.text)], [64, true]);
});

// ---------------------------------------------------------------- the machine's wire half, held to lib/machinewire.js and lib/busy.js

test('the machine\'s wire half matches lib/machinewire.js vector for vector, and reads a busy line as lib/busy.js does: anything that is not a line is busy', () => {
  const token = 'aaaabbbbccccdddd';
  const nonce = 'ab'.repeat(16);
  const challenge = 'cd'.repeat(16);
  assert.equal(machine.serverProof(token, nonce, challenge), wire.serverProof(token, nonce, challenge));
  assert.equal(machine.HELLO_SAYS, wire.HELLO_SAYS);
  assert.equal(machine.ASK_SAYS, wire.ASK_SAYS);
  const body = Buffer.from('{"reason":"upgrade","by":"LAPTOP\\\\ana","force":""}');
  for (const method of ['GET', 'POST']) assert.equal(machine.askProof(token, { nonce, method, path: '/api/machine/stop', body }), wire.askProof(token, { nonce, method, path: '/api/machine/stop', body }));
  assert.equal(machine.askProof(token, { nonce, method: 'GET', path: '/api/machine/busy' }), wire.askProof(token, { nonce, method: 'GET', path: '/api/machine/busy' }), 'no body is the empty body, both halves');
  assert.equal(machine.tokenOf('ABCDabcd12345678\r\n'), wire.tokenOf('ABCDabcd12345678\r\n'));
  assert.equal(machine.sameProof(machine.serverProof(token, nonce, challenge), wire.serverProof(token, nonce, challenge)), true);
  assert.deepEqual(machine.BUSY_KEYS, busy.KEYS);
  const idle = { active: 0, takes: 0, help: 0, countdowns: 0, seats: 3, screens: 2, sockets: 9 };
  for (const line of [idle, { ...idle, active: 1 }, { ...idle, countdowns: 2 }, { ...idle, help: 1 }, {}, null, [], { ...idle, extra: 0 }, { ...idle, active: -1 }, { ...idle, takes: 1.5 }, { ...idle, seats: '3' }, (({ sockets: _s, ...rest }) => rest)(idle)]) {
    const got = busy.read(JSON.stringify(line));
    assert.equal(machine.busyIsBusy(line), got === null ? true : busy.isBusy(got), JSON.stringify(line));
  }
});

test('the backup the machine estimates and the restore lays back: its kindOf is lib/upgradebackup.js\'s, file for file, and its estimate the server\'s', () => {
  for (const rel of ['rooms/ABC.json', 'settings.json', 'rooms/ABC.log', 'audit.jsonl', 'rooms/ABC.json.bak', 'watchdog.log', 'crash.LOG', 'backups/old/x', 'logs/server.log', 'settings.json.1234.tmp', 'x/.partial-upgrade-1/y', 'secret.key', 'rooms/A.B.json']) {
    assert.equal(machine.kindOf(rel), upgradebackup.kindOf(rel), rel);
  }
  const dir = tmp('agm-est-');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.log'), 'x'.repeat(300));
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), 'y'.repeat(700));
  const est = machine.backupEstimate(dataDir, path.join(dir, 'uploads'));
  assert.equal(est.copyBytes, upgradebackup.plan(dataDir, path.join(dir, 'uploads')).copyBytes);
  assert.equal(est.copyBytes, 1000);
  assert.ok(est.free === null || est.free > 0);
  // The reserve the machine keeps beside the copies is the server's own (AGM_UPLOAD_MIN_FREE's default; the task sets none).
  assert.match(h.readSource(path.join(h.ROOT, 'server.js')), /const UPLOAD_MIN_FREE = envNumber\('AGM_UPLOAD_MIN_FREE', 1024 \*\* 3\);/);
  assert.equal(machine.BACKUP_RESERVE, 1024 ** 3);
});

// ---------------------------------------------------------------- upgrade-stop against a real server

/** A machine folder as the installed node lays it out, its token the test server's, and a server serving from it. */
async function servedMachine(env = {}) {
  const root = tmp('agm-node-');
  for (const d of ['data', 'uploads', 'keys', 'token']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN + '\r\n');
  const srv = await h.startServer({ AGM_DATA_DIR: path.join(root, 'data'), AGM_UPLOAD_DIR: path.join(root, 'uploads'), AGM_KEY_DIR: path.join(root, 'keys'), ...env });
  return { root, srv };
}
/** A hall, made by the admin (no page is active from that). */
async function hallOn(srv) {
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  return (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
}
/** A seated page sends a message: the server is busy for the window after. */
async function messageIn(srv, code, text) {
  const ana = await h.connect(srv.base);
  assert.equal((await h.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'board', invite: h.inviteOf(srv.dataDir, code) })).role, 'board');
  await h.emit(ana, 'message', { type: 'text', text });
  ana.close();
}

test('upgrade-stop on an idle server: it waits for the server to end, reads the record the stop wrote after it asked, and says when it saved and the backup it made', async (t) => {
  const { root, srv } = await servedMachine();
  t.after(() => h.stopServer(srv.child));
  const code = await hallOn(srv);
  const ended = new Promise((resolve) => { srv.child.once('exit', (c) => resolve(c)); });
  const asked = Date.now();
  const out = path.join(root, 'upgrade-stop.json');
  const r = await machine.run(['upgrade-stop', '--machine', root, '--port', String(srv.port), '--by', 'LAPTOP\\ana', '--out', out]);
  assert.equal(r.code, 0, r.text);
  assert.equal(await ended, 0, 'the server ended with 0');
  const rec = JSON.parse(read(path.join(root, 'data', 'last-stop.json')));
  assert.equal(rec.saved, true);
  assert.ok(rec.at >= asked, 'the record of this stop');
  assert.match(rec.backup, /^backups\/upgrade-/);
  assert.match(r.text, /^AGMessage stopped for the upgrade and saved at \d\d:\d\d; backup backups\/upgrade-/);
  assert.equal((r.text.match(lifecycleWords.upgradeStopped) || { groups: {} }).groups.backup, rec.backup, 'the installer\'s life cycle reads these words and their backup as the server writes them');
  const res = JSON.parse(read(out));
  assert.deepEqual([res.code, res.saved, res.backup, res.at], [0, true, rec.backup, rec.at]);
  assert.ok(fs.existsSync(path.join(root, 'data', ...rec.backup.split('/'), 'data', 'rooms', code + '.json')), 'the hall is in the backup');
  assert.match(srv.out(), /Stopping for an upgrade, asked at loopback by LAPTOP\\ana\./, 'who asked reached the server');
});

test('upgrade-stop on a busy server: refused without a typed reason, the server still serving; with one, stopped and saved, two backups kept', async (t) => {
  const { root, srv } = await servedMachine();
  t.after(() => h.stopServer(srv.child));
  const code = await hallOn(srv);
  await messageIn(srv, code, 'Thank you all');
  fs.writeFileSync(path.join(root, 'uploads', 'u-sample.bin'), Buffer.alloc(2048, 7));
  const older = path.join(root, 'data', 'backups', 'upgrade-0.6.0-dev.1-20200101T000000Z-aaaaaa');
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, 'backup.json'), '{"v":1}');
  let r = await machine.run(['upgrade-stop', '--machine', root, '--port', String(srv.port)]);
  assert.equal(r.code, 3);
  assert.equal(r.text, 'Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.');
  assert.equal(srv.child.exitCode, null, 'still serving');
  r = await machine.run(['upgrade-stop', '--machine', root, '--port', String(srv.port), '--force', 'the rehearsal upgrade']);
  assert.equal(r.code, 0, r.text);
  const rec = JSON.parse(read(path.join(root, 'data', 'last-stop.json')));
  assert.equal(rec.saved, true);
  const backups = upgradebackup.list(path.join(root, 'data'));
  assert.equal(backups.length, upgradebackup.KEEP, 'two kept: the new one and the one before it');
  assert.equal(backups[0].name, rec.backup.split('/').pop());
  const newest = path.join(root, 'data', ...rec.backup.split('/'));
  assert.ok(fs.existsSync(path.join(newest, 'data', 'rooms', code + '.json')) && fs.existsSync(path.join(newest, 'uploads', 'u-sample.bin')));
  assert.match(read(path.join(root, 'data', 'audit.jsonl')), /server\.stop\.forced/, 'the forced stop is audited by the server');
});

test('upgrade-stop refuses an upgrade with no way back: the disk short of room (before anything is asked), the server\'s own backup refused, nothing serving, and a record older than the stop', async (t) => {
  // The machine's own estimate: refused, and the server goes on serving.
  const a = await servedMachine();
  t.after(() => h.stopServer(a.srv.child));
  let r = await machine.run(['upgrade-stop', '--machine', a.root, '--port', String(a.srv.port)], { net: { estimate: () => ({ copyBytes: 10 * 1024 * 1024, free: 5 * 1024 * 1024 }) } });
  assert.equal(r.code, 3);
  assert.match(r.text, /^the disk has 5 MB free, under the 10 MB the way back's backup copies and the 1024 MB kept beside them: .*AGMessage was not stopped\.$/);
  assert.equal(a.srv.child.exitCode, null, 'not stopped');
  // The server's own check (its reserve past any disk): it saves, makes no backup and says why; refused unless forced.
  const b = await servedMachine({ AGM_UPLOAD_MIN_FREE: String(2 ** 52) });
  t.after(() => h.stopServer(b.srv.child));
  r = await machine.run(['upgrade-stop', '--machine', b.root, '--port', String(b.srv.port)]);
  assert.equal(r.code, 3);
  assert.match(r.text, /^AGMessage stopped for the upgrade at \d\d:\d\d, and no backup was made for the way back: its copies take .* free, under that and the .* it keeps beside them\. Free some space, then upgrade again: the upgrade is refused so no data is risked\./);
  assert.equal(JSON.parse(read(path.join(b.root, 'data', 'last-stop.json'))).saved, true, 'it saved all the same');
  // Nothing serving: no stop saved it and no backup was made; refused unless forced.
  const none = String(await h.freePort());
  r = await machine.run(['upgrade-stop', '--machine', b.root, '--port', none]);
  assert.equal(r.code, 3);
  assert.match(r.text, /is not serving on port \d+, so no stop saved it for the upgrade and no backup was made/);
  r = await machine.run(['upgrade-stop', '--machine', b.root, '--port', none, '--force', 'it was stopped by hand']);
  assert.deepEqual([r.code, /upgrading without a way back, as asked \(it was stopped by hand\)/.test(r.text)], [0, true]);
  // A record there from before the stop is no record of it.
  const root = tmp('agm-stale-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'token'));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN);
  fs.writeFileSync(path.join(root, 'data', 'last-stop.json'), JSON.stringify({ at: Date.now() - 60_000, saved: true, backup: 'backups/upgrade-x' }));
  const net0 = { stop: async () => ({ ok: true, status: 200, json: { ok: true, stopping: true } }), portAnswers: async () => false, estimate: () => ({ copyBytes: 0, free: null }) };
  r = await machine.run(['upgrade-stop', '--machine', root, '--port', '3023'], { net: net0 });
  assert.equal(r.code, 3);
  assert.match(r.text, /and no save record of this stop \(the record there is older\)/);
  // A server that took the stop and still holds the port when the wait ends: refused, never read as stopped.
  const said = path.join(root, 'said.json');
  r = await machine.run(['upgrade-stop', '--machine', root, '--port', '3023', '--out', said], { net: { ...net0, portAnswers: async () => true, waitMs: 300 } });
  assert.deepEqual([r.code, /still holds port 3023 after 0 s/.test(r.text), JSON.parse(read(said)).forceable], [3, true, undefined], 'no reason lifts that one');
  // Each refusal a reason lifts says so to whoever runs it (the installer says how), and the words never ask to type.
  r = await machine.run(['upgrade-stop', '--machine', root, '--port', '3023', '--out', said], { net: net0 });
  assert.deepEqual([r.code, JSON.parse(read(said)).forceable], [3, true]);
  assert.match(r.text, /Give a reason to upgrade anyway\.$/);
  r = await machine.run(['upgrade-stop', '--machine', root, '--port', '3023', '--out', said], { net: { ...net0, stop: async () => ({ ok: true, status: 409, json: { ok: false, error: 'Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.' } }) } });
  assert.deepEqual([r.code, JSON.parse(read(said)).forceable, JSON.parse(read(said)).busy], [3, true, true], 'busy at the stop itself');
});

test('install for the way back (--rollback) records no Previous: the build it replaced is the newer one that did not start, never one to go back to', async () => {
  const { root } = prepared();
  const app = appFolder();
  const win = fakeWindows({ record: { InstallDir: app, Version: '0.6.41', SemVer: '0.6.0', Previous: '0.6.40', Admin: ANA, AdminName: 'LAPTOP\\ana', Port: '3023' } });
  const r = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0+40.abc1234', '--port', '3023', '--rollback'], { run: win.run });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([win.reg().Version, win.reg().Previous, win.reg().Admin], ['0.6.40', '', ANA]);
});

// ---------------------------------------------------------------- restore (the way back)

test('restore lays one backup back file by file: an unchanged hard link kept, a store a newer build renamed over laid back, a file it made removed, the audit log and watchdog.log never rolled back', async () => {
  const root = tmp('agm-back-');
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  fs.mkdirSync(uploadDir);
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.json'), '{"v":"old"}');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.log'), 'op1\n');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"s":1}');
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), 'a1\n');
  fs.writeFileSync(path.join(dataDir, 'watchdog.log'), 'w1\n');
  fs.writeFileSync(path.join(uploadDir, 'u-1.bin'), 'one');
  const b = upgradebackup.make({ dataDir, uploadDir, build: '0.6.0+41.abc1234', stopAt: 1, saved: true, reserve: 0 });
  // The newer build: a store replaced by a rename, its op log appended to, a store and an upload of its own, the logs.
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.json.tmp'), '{"v":"new"}');
  fs.renameSync(path.join(dataDir, 'rooms', 'A.json.tmp'), path.join(dataDir, 'rooms', 'A.json'));
  fs.appendFileSync(path.join(dataDir, 'rooms', 'A.log'), 'op2\n');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'NEW.json'), '{}');
  fs.writeFileSync(path.join(uploadDir, 'u-2.bin'), 'two');
  fs.appendFileSync(path.join(dataDir, 'audit.jsonl'), 'a2\n');
  fs.appendFileSync(path.join(dataDir, 'watchdog.log'), 'w2\n');
  const port = await h.freePort();
  const r = await machine.run(['restore', '--machine', root, '--backup', b.name, '--port', String(port)]);
  assert.equal(r.code, 0, r.text);
  assert.equal(read(path.join(dataDir, 'rooms', 'A.json')), '{"v":"old"}', 'the store as the backup holds it');
  assert.equal(read(path.join(dataDir, 'rooms', 'A.log')), 'op1\n', 'the op log as its copy holds it');
  assert.ok(!fs.existsSync(path.join(dataDir, 'rooms', 'NEW.json')) && !fs.existsSync(path.join(uploadDir, 'u-2.bin')), 'what the newer build made is removed');
  assert.equal(read(path.join(uploadDir, 'u-1.bin')), 'one');
  assert.equal(read(path.join(dataDir, 'audit.jsonl')), 'a1\na2\n', 'the audit log carries what the newer build did');
  assert.equal(read(path.join(dataDir, 'watchdog.log')), 'w1\nw2\n');
  assert.equal(read(path.join(dataDir, 'settings.json')), '{"s":1}');
  assert.match(r.text, /laid back: 2 files laid back, 2 unchanged, 2 the newer build made removed\./);
  // Again: nothing to do, everything the same file now.
  const again = await machine.run(['restore', '--machine', root, '--backup', b.name.split('/').pop(), '--port', String(port)]);
  assert.match(again.text, /laid back: 1 file laid back, 3 unchanged, 0 the newer build made removed\./, 'only the op log, a copy, is laid back again');
});

test('restore refuses while anything answers on the port, a name that is no backup, a backup that is not whole, and a folder of the data folder that is a link', async (t) => {
  const root = tmp('agm-back2-');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'rooms', 'A.json'), '{}');
  const b = upgradebackup.make({ dataDir, uploadDir: path.join(root, 'uploads'), build: 'b', stopAt: 1, saved: true, reserve: 0 });
  const held = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => { held.once('listening', resolve); });
  t.after(() => held.close());
  let r = await machine.run(['restore', '--machine', root, '--backup', b.name, '--port', String(held.address().port)]);
  assert.deepEqual([r.code, /something answers on port \d+: stop AGMessage before its backup is laid back\. Nothing was laid back\./.test(r.text)], [3, true]);
  const port = String(await h.freePort());
  r = await machine.run(['restore', '--machine', root, '--backup', '..\\..\\Windows', '--port', port]);
  assert.deepEqual([r.code, /names no backup in/.test(r.text)], [64, true]);
  r = await machine.run(['restore', '--machine', root, '--backup', path.join(tmp('agm-elsewhere-'), b.name.split('/').pop()), '--port', port]);
  assert.equal(r.code, 64, 'a backup outside the data folder\'s backups\\');
  fs.rmSync(path.join(dataDir, ...b.name.split('/'), 'backup.json'));
  r = await machine.run(['restore', '--machine', root, '--backup', b.name, '--port', port]);
  assert.deepEqual([r.code, /is not whole \(no backup\.json\)/.test(r.text)], [3, true]);
  // A folder of the live data folder a link to elsewhere: nothing is written through it.
  const b2 = upgradebackup.make({ dataDir, uploadDir: path.join(root, 'uploads'), build: 'b', stopAt: 2, saved: true, reserve: 0, now: Date.now() + 1000 });
  const elsewhere = tmp('agm-target-');
  fs.rmSync(path.join(dataDir, 'rooms'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(dataDir, 'rooms'), 'junction');
  r = await machine.run(['restore', '--machine', root, '--backup', b2.name, '--port', port]);
  assert.equal(r.code, 2);
  assert.match(r.text, /was laid back only in part \(ENOTDIR/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing laid back through the link');
});

test('restore after an upgrade that ran: the earlier hall comes back, the newer build\'s message and upload go, and the next start finds the audit log and its head agree', async (t) => {
  const { root, srv } = await servedMachine();
  t.after(() => h.stopServer(srv.child));
  const code = await hallOn(srv);
  await messageIn(srv, code, 'Before the upgrade');
  const r = await machine.run(['upgrade-stop', '--machine', root, '--port', String(srv.port), '--force', 'the test']);
  assert.equal(r.code, 0, r.text);
  const backup = JSON.parse(read(path.join(root, 'data', 'last-stop.json'))).backup;
  const env = { AGM_DATA_DIR: path.join(root, 'data'), AGM_UPLOAD_DIR: path.join(root, 'uploads'), AGM_KEY_DIR: path.join(root, 'keys') };
  // The newer build serves a while: a message and an upload, then it stops.
  const newer = await h.startServer(env);
  await messageIn(newer, code, 'After the upgrade');
  fs.writeFileSync(path.join(root, 'uploads', 'u-newer.bin'), 'n');
  await h.stopServer(newer.child);
  const snapshot = path.join(root, 'data', 'rooms', code + '.json');
  assert.match(read(snapshot), /After the upgrade/);
  const auditBefore = read(path.join(root, 'data', 'audit.jsonl'));
  const back = await machine.run(['restore', '--machine', root, '--backup', backup, '--port', String(newer.port)]);
  assert.equal(back.code, 0, back.text);
  assert.ok(!read(snapshot).includes('After the upgrade') && read(snapshot).includes('Before the upgrade'), 'the hall as the backup holds it');
  assert.ok(!fs.existsSync(path.join(root, 'uploads', 'u-newer.bin')));
  assert.equal(read(path.join(root, 'data', 'audit.jsonl')), auditBefore, 'the audit log is never rolled back');
  // The earlier build starts again: its audit log and its head outside the data folder agree (no cut, no head finding).
  const earlier = await h.startServer(env);
  t.after(() => h.stopServer(earlier.child));
  const fresh = read(path.join(root, 'data', 'audit.jsonl')).slice(auditBefore.length).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).action);
  assert.ok(!fresh.some((a) => a === 'audit.cut' || a === 'audit.head'), 'no disagreement: ' + fresh.join(', '));
});

// ---------------------------------------------------------------- preinstall-check

test('preinstall-check: a free port is ready on a first install with no token; a portable copy on it is refused with its words; another program is refused naming its pid', async (t) => {
  const first = tmp('agm-first-');   // a first install: no token\\ folder at all
  const port = await h.freePort();
  let r = await machine.run(['preinstall-check', '--machine', first, '--port', String(port)]);
  assert.deepEqual([r.code, r.text], [0, 'Port ' + port + ' is free: nothing is serving on it.']);
  // A portable copy (no AGM_RUNS) on the port: its health names it.
  const portable = await h.startServer();
  t.after(() => h.stopServer(portable.child));
  r = await machine.run(['preinstall-check', '--machine', first, '--port', String(portable.port)]);
  assert.equal(r.code, 3);
  assert.equal(r.text, 'AGMessage ' + require('../package.json').version + ' is running on port ' + portable.port + ' from a folder: press Ctrl+C in its window, then continue.');
  // Another program: it answers, and no health of AGMessage's.
  const other = http.createServer((req, res) => { res.statusCode = 404; res.end('no'); }).listen(0, '127.0.0.1');
  await new Promise((resolve) => { other.once('listening', resolve); });
  t.after(() => other.close());
  r = await machine.run(['preinstall-check', '--machine', first, '--port', String(other.address().port)]);
  assert.deepEqual([r.code, r.text], [3, 'Another program holds port ' + other.address().port + ': close it, then continue.']);
  r = await machine.run(['preinstall-check', '--machine', first, '--port', String(other.address().port), '--sys', SYS], { run: fakeWindows().run });
  assert.equal(r.text, 'Another program (pid 4120) holds port ' + other.address().port + ': close it, then continue.', 'its pid read by Get-NetTCPConnection');
});

test('preinstall-check: the installed server proving its token is asked how busy it is — idle ready, busy refused without a typed reason; one silent for 5 s refused, naming its pid', async (t) => {
  const { root, srv } = await servedMachine();
  t.after(() => h.stopServer(srv.child));
  let r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port)]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^The installed AGMessage answered: nothing in the last 10 minutes/);
  const code = await hallOn(srv);
  await messageIn(srv, code, 'Hello');
  r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port)]);
  assert.deepEqual([r.code, /AGMessage is busy \(1 page active\): type a reason to go on anyway, or wait\./.test(r.text)], [3, true]);
  r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port), '--force', 'the show ended']);
  assert.equal(r.code, 0, r.text);
  // A server that took the connection and does not answer within 5 s (stood in for: the wait is the wire's own).
  r = await machine.run(['preinstall-check', '--machine', root, '--port', '3023', '--force', 'x'], { net: { portAnswers: async () => true, hello: async () => ({ ok: false, why: 'silent' }), pid: () => 4120 } });
  assert.deepEqual([r.code, r.text], [3, 'AGMessage on port 3023 (pid 4120) does not answer within 5 s: it reads as busy, and it cannot be stopped at loopback, so the install cannot go on.']);
});

// ---------------------------------------------------------------- uninstall, status

test('uninstall: the server stopped at loopback first, then every task of \\AGMessage\\, the rules and the record, each removal checked; the data kept unless asked, then the keys last; what is left is named, exit 2', async () => {
  const root = tmp('agm-uninst-');
  for (const d of ['data', 'uploads', 'keys', 'logs', 'token', 'machine']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN);
  // A link left in an account's inbox\: each box is cleared entry by entry before the machine folder goes, so what it
  // names is never reached.
  const outside = tmp('agm-uninst-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'not AGMessage\'s');
  fs.mkdirSync(path.join(root, 'machine', 'inbox', ANA), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'machine', 'inbox', ANA, 'away'), process.platform === 'win32' ? 'junction' : 'dir');
  const order = [];
  const win = fakeWindows({ record: { InstallDir: 'C:\\Program Files\\AGMessage', Port: '3023' }, tasks: [machine.SERVER_TASK, '\\AGMessage\\Control-' + ANA] });
  const run = (e, a, o) => { order.push(base(e) + ' ' + a[0]); return win.run(e, a, o); };
  const n = { stop: async ({ reason, by, port }) => { order.push('stop ' + reason + ' ' + by + ' ' + port); return { ok: true, status: 200, json: { ok: true, stopping: true } }; }, portAnswers: async () => false };
  const removed = [];
  const fsImpl = { ...fs, rmSync: (p, o) => { removed.push(path.basename(p)); return fs.rmSync(p, o); } };
  const r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--remove-data'], { run, fsImpl, net: n });
  assert.equal(r.code, 0, r.text);
  assert.equal(order[0], 'reg.exe query');
  assert.equal(order[1], 'stop stop the uninstall 3023', 'the save-stop at the recorded port before any task is ended');
  assert.ok(order.indexOf('schtasks.exe /End') > 1);
  assert.deepEqual(win.tasks.size, 0, 'both tasks removed');
  assert.ok(win.calls.some((c) => c.name === 'powershell.exe' && c.args.at(-1) === machine.PS_FIREWALL_REMOVE));
  assert.ok(win.calls.some((c) => c.name === 'reg.exe' && c.args.join(' ') === 'delete HKLM\\SOFTWARE\\AGMessage /f /reg:64'));
  assert.equal(removed.at(-1), 'keys', 'the keys removed last');
  assert.ok(!removed.includes('setup'), 'a folder that was not there is not said removed');
  assert.ok(!fs.existsSync(root));
  assert.equal(read(path.join(outside, 'keep.txt')), 'not AGMessage\'s', 'what a link in an inbox named untouched');
  assert.match(r.text, /^AGMessage stopped and saved \(stopped at \d\d:\d\d\)\. AGMessage is uninstalled, and its data removed from this PC\.$/);
  // Busy with no reason: refused, nothing removed.
  const root2 = tmp('agm-uninst2-');
  fs.mkdirSync(path.join(root2, 'token'));
  fs.writeFileSync(path.join(root2, 'token', 'admin-token'), h.TOKEN);
  const win2 = fakeWindows({ record: { Port: '3023' }, tasks: [machine.SERVER_TASK] });
  let r2 = await machine.run(['uninstall', '--machine', root2, '--sys', SYS], { run: win2.run, net: { stop: async () => ({ ok: true, status: 409, json: { error: 'Not stopped: AGMessage is busy (1 page active).' } }) } });
  assert.deepEqual([r2.code, win2.tasks.size], [3, 1]);
  // A folder that cannot be removed is named, exit 2; the data kept when not asked.
  const win3 = fakeWindows({ record: { Port: '3023' } });
  const stuck = { ...fs, rmSync: (p, o) => { if (path.basename(p) === 'uploads') throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  const root3 = tmp('agm-uninst3-');
  for (const d of ['data', 'uploads', 'keys']) fs.mkdirSync(path.join(root3, d));
  r2 = await machine.run(['uninstall', '--machine', root3, '--sys', SYS, '--remove-data'], { run: win3.run, fsImpl: stuck });
  assert.equal(r2.code, 2);
  assert.match(r2.text, /AGMessage is not wholly uninstalled; left: .*uploads \(EBUSY\)/);
  // An account's box that cannot be cleared (a folder holding a file): named, and the machine folder kept whole.
  const root6 = tmp('agm-uninst6-');
  fs.mkdirSync(path.join(root6, 'machine', 'inbox', ANA, 'full'), { recursive: true });
  fs.writeFileSync(path.join(root6, 'machine', 'inbox', ANA, 'full', 'f'), 'x');
  r2 = await machine.run(['uninstall', '--machine', root6, '--sys', SYS, '--remove-data'], { run: fakeWindows({ record: { Port: '3023' } }).run });
  assert.equal(r2.code, 2);
  assert.match(r2.text, /left: .*full \(/);
  assert.ok(fs.existsSync(path.join(root6, 'machine', 'inbox', ANA, 'full', 'f')), 'the machine folder kept while a box is');
  // A folder listing Windows will not give: the control tasks the record implies (the laptop's admin's, each grantee's)
  // are removed all the same, by their names.
  const win5 = fakeWindows({ record: { Admin: ANA }, grants: { [BEN]: 'start,stop' }, noList: true, tasks: [machine.SERVER_TASK, '\\AGMessage\\Control-' + ANA, '\\AGMessage\\Control-' + BEN] });
  r2 = await machine.run(['uninstall', '--machine', tmp('agm-uninst5-'), '--sys', SYS], { run: win5.run });
  assert.equal(r2.code, 0, r2.text);
  assert.equal(win5.tasks.size, 0, 'every control task the record names removed, the listing refused');
  const root4 = tmp('agm-uninst4-');
  fs.mkdirSync(path.join(root4, 'data'));
  r2 = await machine.run(['uninstall', '--machine', root4, '--sys', SYS], { run: fakeWindows().run });
  assert.equal(r2.code, 0, r2.text);
  assert.ok(fs.existsSync(path.join(root4, 'data')), 'the data kept by default');
});

test('uninstall keeping the data takes back every right a Windows account was given on it and leaves Kept and Port in place of the record; prepare then takes the root again, and install records whose it is anew and drops the mark', async () => {
  const root = path.join(tmp('agm-kept-'), 'AGMessage');
  for (const d of ['data', 'uploads', 'keys', 'logs', 'token', path.join('machine', 'inbox', ANA), path.join('machine', 'outbox', ANA), path.join('machine', 'inbox', BEN), path.join('machine', 'work')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), '{"hall":"kept"}');
  fs.writeFileSync(path.join(root, 'machine', 'inbox', ANA, 'ask.json'), '{}');
  const win = fakeWindows({ record: { InstallDir: 'C:\\Program Files\\AGMessage', Version: '0.6.41', Admin: ANA, AdminName: 'LAPTOP\\ana', Port: '3123' }, grants: { [BEN]: 'start,stop' }, tasks: [machine.SERVER_TASK] });
  const out = path.join(root, '..', 'uninstall.json');
  const r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--out', out], { run: win.run, net: { stop: async () => ({ ok: false, why: 'ECONNREFUSED' }) } });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /AGMessage is uninstalled; its data is kept in .*AGMessage, which AGMessage installed again takes, and no Windows account keeps a right to it but SYSTEM and Administrators\.$/);
  const revoked = win.calls.filter((c) => c.name === 'icacls.exe').map((c) => [path.basename(c.args[0]), ...c.args.slice(1)]);
  assert.deepEqual(revoked, ['data', 'uploads', 'keys', 'logs', 'token', 'machine'].map((d) => [d, '/remove:g', '*' + ANA, '*' + BEN]), 'the laptop\'s admin\'s and each grantee\'s rights taken back on every child');
  assert.deepEqual([fs.readdirSync(path.join(root, 'machine', 'inbox')), fs.readdirSync(path.join(root, 'machine', 'outbox'))], [[], []], 'their inbox\\ and outbox\\ folders gone');
  assert.equal(read(path.join(root, 'data', 'settings.json')), '{"hall":"kept"}', 'the data itself kept as it was');
  assert.deepEqual(win.reg(), { Kept: root, Port: '3123' }, 'the record replaced by the mark and the port the screens\' links name');
  const at = (pred) => win.calls.findIndex(pred);
  assert.ok(at((c) => c.name === 'icacls.exe') < at((c) => c.name === 'reg.exe' && c.args[0] === 'delete'), 'rights taken back while the record still names them');
  assert.ok(!read(out).includes(h.TOKEN));
  // A later install: prepare takes the kept root (a real directory SYSTEM or Administrators own), whose it is found again.
  const again = fakeWindows({ record: win.reg() });
  const p = machine.prepare({ '--machine': root, '--sys': SYS }, { run: again.run });
  assert.equal(p.root, root);
  assert.ok(again.calls.some((c) => c.name === 'powershell.exe' && c.args.at(-1) === machine.PS_OWNER), 'its owner read before it is taken');
  const app = appFolder();
  const i = await machine.run(['install', '--machine', root, '--app', app, '--sys', SYS, '--build', '0.6.0+42.abc1234', '--port', '3123', '--admin', BEN, '--admin-name', 'LAPTOP\\ben'], { run: again.run });
  assert.equal(i.code, 0, i.text);
  assert.deepEqual([again.reg().Admin, again.reg().Kept, again.reg().Previous, again.reg().Version], [BEN, undefined, '', '0.6.42'], 'whose it is recorded anew, the mark dropped, nothing to go back to');
  assert.equal(read(path.join(root, 'data', 'settings.json')), '{"hall":"kept"}');
  // Removing the data leaves no mark: a later install finds no root to take.
  const gone = fakeWindows({ record: { InstallDir: 'x', Port: '3023' } });
  const root2 = tmp('agm-kept2-');
  fs.mkdirSync(path.join(root2, 'data'));
  assert.equal((await machine.run(['uninstall', '--machine', root2, '--sys', SYS, '--remove-data'], { run: gone.run })).code, 0);
  assert.equal(gone.reg(), null);
  // A right that cannot be taken back is named, exit 2: the uninstall stops with every file in place.
  const stuck = fakeWindows({ record: { Admin: ANA }, failIcacls: '/remove:g' });
  const root3 = tmp('agm-kept3-');
  fs.mkdirSync(path.join(root3, 'token'));
  const s3 = await machine.run(['uninstall', '--machine', root3, '--sys', SYS], { run: stuck.run });
  assert.equal(s3.code, 2);
  assert.match(s3.text, /left: the rights on .*token \(Access is denied\.\)/);
});

test('uninstall with --app: a person\'s console open from {app} is refused before anything is stopped or removed; the server\'s own programs are waited for, and one still running is named, exit 2', async () => {
  const APP = 'C:\\Program Files\\AGMessage';
  const shell = { pid: 5000, name: 'node.exe', cmd: '"' + APP + '\\node\\node.exe" "' + APP + '\\app\\launch.js" status --machine x' };
  const watchdog = { pid: 4121, name: 'node.exe', cmd: '"' + APP + '\\node\\node.exe" "' + APP + '\\app\\supervise.js"' };
  const withPrograms = (answer) => {
    const win = fakeWindows({ record: { Port: '3023' }, tasks: [machine.SERVER_TASK] });
    const run = (e, a, o) => (base(e) === 'powershell.exe' && a.at(-1) === machine.PS_PROGRAMS ? JSON.stringify(answer()) + '\r\n' : win.run(e, a, o));
    return { win, run };
  };
  let stopped = 0;
  const n = { stop: async () => { stopped++; return { ok: false, why: 'ECONNREFUSED' }; }, programsWaitMs: 300 };
  const root = tmp('agm-uninst-app-');
  fs.mkdirSync(path.join(root, 'token'));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN);
  let w = withPrograms(() => ({ programs: [shell, watchdog] }));
  let r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--app', APP], { run: w.run, net: n });
  assert.deepEqual([r.code, stopped, w.win.tasks.size], [3, 0, 1], 'refused before the stop, every task in place');
  assert.equal(r.text, 'AGMessage\'s own console is open (node.exe (pid 5000) runs from ' + APP + '): close its window, then uninstall again. Nothing was removed.');
  // The uninstaller's own first phase, waiting in {app} while its copy in %TEMP% runs this (run 115 refused itself on it):
  // left out, at the first look and at the wait for {app}'s programs to end alike.
  const firstPhase = { pid: 3792, name: 'unins000.exe', cmd: '"' + APP + '\\unins000.exe" /VERYSILENT', exe: APP + '\\unins000.exe', ancestor: true };
  w = withPrograms(() => ({ programs: [firstPhase] }));
  r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--app', APP], { run: w.run, net: n });
  assert.equal(r.code, 0, 'the uninstall that runs it is not refused on it: ' + r.text);
  // One that is not this uninstall's ancestor is another uninstaller's, and refuses as any program of {app} does.
  w = withPrograms(() => ({ programs: [{ ...firstPhase, ancestor: false }] }));
  r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--app', APP], { run: w.run, net: n });
  assert.deepEqual([r.code, r.text], [3, 'AGMessage\'s own console is open (unins000.exe (pid 3792) runs from ' + APP + '): close its window, then uninstall again. Nothing was removed.']);
  // The watchdog ends once the server has: waited for, then the uninstall goes on.
  let asked = 0;
  w = withPrograms(() => ({ programs: asked++ < 3 ? [watchdog] : [] }));
  r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--app', APP], { run: w.run, net: n });
  assert.equal(r.code, 0, r.text);
  assert.ok(asked >= 4, 'asked again until the watchdog had ended');
  // One that does not end is named, and the uninstall stops before Inno removes a file.
  w = withPrograms(() => ({ programs: [watchdog] }));
  r = await machine.run(['uninstall', '--machine', root, '--sys', SYS, '--app', APP], { run: w.run, net: n });
  assert.equal(r.code, 2);
  assert.match(r.text, /left: node\.exe \(pid 4121\), which still runs from C:\\Program Files\\AGMessage \(close it, then uninstall again\)/);
});

test('status (elevated): the task read by column, the record\'s admin and port, the port\'s holder and code integrity from one powershell.exe, the last stop and the logs each read, refused or absent; --out JSON with no token', async () => {
  const root = tmp('agm-status-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', 'server.log'), 'a\nb\nc');
  const win = fakeWindows({ record: { InstallDir: 'C:\\Program Files\\AGMessage', AdminName: 'LAPTOP\\ana', Port: '3023', Version: '0.6.41' }, tasks: [machine.SERVER_TASK], grants: { [BEN]: 'start,stop' } });
  const out = path.join(root, 'status.json');
  const r = await machine.run(['status', '--machine', root, '--sys', SYS, '--out', out], { run: win.run });
  assert.equal(r.code, 0, r.text);
  const j = JSON.parse(read(out));
  assert.deepEqual([j.facts.task.state, j.facts.task.lastResult, j.facts.admin, j.facts.port, j.facts.portHolderPid, j.facts.version], ['Bereit', 0, 'LAPTOP\\ana', 3023, 4120, '0.6.41']);
  assert.deepEqual(j.facts.codeIntegrity, { found: false });
  assert.deepEqual([j.facts.lastStop.read, j.facts.watchdogLog.read, j.facts.serverLog.read], ['absent', 'absent', 'read']);
  assert.deepEqual(j.facts.serverLog.lines, ['a', 'b', 'c']);
  const ps = win.calls.find((c) => c.name === 'powershell.exe');
  assert.deepEqual([ps.env.AGM_PORT, ps.env.AGM_NODE_TAIL], ['3023', '\\Program Files\\AGMessage\\node\\node.exe']);
  assert.ok(!JSON.stringify(j).includes(h.TOKEN), 'no token in the record');
  assert.match(r.text, /the server task: Bereit \(last result 0\)\n {2}port 3023: held by pid 4120\n {2}the laptop's admin: LAPTOP\\ana\n {2}rights given: S-1-5-21-1-2-3-1002: start, stop\n {2}the last stop: no record/);
  assert.deepEqual(j.facts.grants, { [BEN]: 'start,stop' });
});

test('--out is written for every verb, a refusal\'s too, whole and never a token: prepare\'s names its setup folder', async () => {
  const root = path.join(tmp('agm-out-'), 'AGMessage');
  const out = path.join(root + '-prepare.json');
  let r = await machine.run(['prepare', '--machine', root, '--sys', SYS, '--out', out], { run: fakeWindows().run });
  assert.equal(r.code, 0, r.text);
  const p = JSON.parse(read(out));
  assert.deepEqual([p.v, p.verb, p.code, p.root], [1, 'prepare', 0, root]);
  assert.ok(fs.existsSync(p.setup) && p.setup.startsWith(path.join(root, 'setup') + path.sep));
  const refusedOut = path.join(root + '-refused.json');
  r = await machine.run(['prepare', '--machine', root, '--sys', SYS, '--out', refusedOut], { run: fakeWindows().run });
  assert.equal(r.code, 3, 'an existing root and no record');
  assert.deepEqual(Object.keys(JSON.parse(read(refusedOut))), ['v', 'verb', 'code', 'words']);
  assert.equal(JSON.parse(read(refusedOut)).code, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left beside it');
});

// ---------------------------------------------------------------- launch.js serve and status

const serveArgs = (folders, port) => ['serve', '--data', folders.data, '--uploads', folders.uploads, '--keys', folders.keys, '--logs', folders.logs, '--token', folders.token, '--events', folders.events, '--port', String(port)];
function serveFolders() {
  const dir = tmp('agm-serve-');
  const folders = {};
  for (const k of ['data', 'uploads', 'keys', 'logs', 'token']) { folders[k] = path.join(dir, k); fs.mkdirSync(folders[k]); }
  folders.events = path.join(dir, 'events.jsonl');
  return folders;
}

test('launch.js serve: the watchdog\'s environment is Windows\' own names and the arguments\' folders and port, nothing else; its stop and give-up end serve 0, an unexpected end non-zero', async () => {
  const folders = { data: '/d', uploads: '/u', keys: '/k', logs: '/l', token: '/t', events: '/m/events.jsonl' };
  const a = launch.parse(['serve', '--data', '/d', '--uploads', '/u', '--keys', '/k', '--logs', '/l', '--token', '/t', '--events', '/m/events.jsonl', '--port', '3023']);
  assert.deepEqual(a, { verb: 'serve', folders, port: 3023 });
  assert.match(launch.parse(['serve', '--data', '/d', '--uploads', '/u', '--keys', '/k', '--logs', '/l', '--token', '/t', '--port', '3023']).problem, /launch\.js serve needs --events <file>, a full path/);
  const inherited = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', NODE_OPTIONS: '--require C:\\planted.js', AGM_CHILD: '/x/server.js', AGM_TLS: '0', AGM_OPEN: '1', AGM_NODES: '0', ADMIN_TOKEN: 'aaaabbbbccccdddd', ANTHROPIC_API_KEY: 'k', PATH: 'C:\\planted', AGM_DATA_DIR: '/wrong' };   // secret-scan: fixture
  assert.deepEqual(launch.taskEnv(a, inherited), { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', AGM_RUNS: 'task', AGM_DATA_DIR: '/d', AGM_UPLOAD_DIR: '/u', AGM_KEY_DIR: '/k', AGM_LOG_DIR: '/l', AGM_TOKEN_DIR: '/t', AGM_MACHINE_EVENTS: '/m/events.jsonl', PORT: '3023' });
  const fake = (code, signal = null) => ({ on: (e, f) => { if (e === 'exit') setImmediate(() => f(code, signal)); return fake(code, signal); } });
  let seen = null;
  const stop = await launch.serve(a, { spawn: (exe, args, opts) => { seen = { exe, args, opts }; return fake(0); }, supervise: '/app/supervise.js', execPath: '/node', inherited });
  assert.equal(stop, 0, 'the watchdog\'s stop (0) ends serve 0');
  assert.deepEqual([seen.exe, seen.args, seen.opts.env], ['/node', ['/app/supervise.js'], launch.taskEnv(a, inherited)]);
  assert.equal(await launch.serve(a, { spawn: () => fake(3) }), 0, 'a give-up or configuration refusal (3) ends it 0 too: the task stays stopped');
  assert.equal(await launch.serve(a, { spawn: () => fake(70) }), 70, 'an unexpected end is non-zero, so RestartOnFailure restarts');
  assert.equal(await launch.serve(a, { spawn: () => fake(null, 'SIGKILL') }), 1, 'signalled from outside: an unexpected end');
});

test('launch.js serve with the real watchdog: the installed node serves under the task, and a stop at loopback with the proof ends serve 0 with the stop saved', async () => {
  const folders = serveFolders();
  const port = await h.freePort();
  const exit = launch.serve(launch.parse(serveArgs(folders, port)));
  await h.until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/api/health')).ok; } catch { return false; } }, 60000, 'the installed node to serve');
  await h.until(() => fs.existsSync(path.join(folders.token, 'admin-token')), 10000, 'the token in its folder');
  const token = read(path.join(folders.token, 'admin-token')).trim();
  const stopped = await machine.ask({ port, token, method: 'POST', path: '/api/machine/stop', body: { reason: 'stop', by: 'the test' } });
  assert.deepEqual([stopped.ok, stopped.status], [true, 200]);
  assert.equal(await exit, 0, 'the watchdog\'s stop ends launch.js serve with 0');
  assert.equal(JSON.parse(read(path.join(folders.data, 'last-stop.json'))).saved, true);
  assert.ok(fs.existsSync(path.join(folders.logs, 'server.log')) && !fs.existsSync(path.join(folders.data, 'logs', 'server.log')), 'the console is kept in the logs folder the task names');
  assert.ok(!read(path.join(folders.logs, 'server.log')).includes(token), 'never the token');
});

test('launch.js serve with the real watchdog: a configuration refusal and the watchdog\'s give-up end serve 0 after writing why (watchdog.json, server.log)', async () => {
  // A keys folder that is a file: the server cannot run as configured (3).
  let folders = serveFolders();
  fs.rmSync(folders.keys, { recursive: true });
  fs.writeFileSync(folders.keys, 'not a folder');
  let started = Date.now();
  assert.equal(await launch.serve(launch.parse(serveArgs(folders, await h.freePort()))), 0);
  assert.ok(Date.now() - started < 60000);
  let why = JSON.parse(read(path.join(folders.data, 'watchdog.json')));
  assert.equal(why.refused, true);
  assert.match(why.reason, /cannot start as configured \(code 3\): /);
  assert.match(read(path.join(folders.logs, 'server.log')), /server stopped: cannot start as configured \(code 3\)/);
  // A server that crashes at every start: the watchdog gives up (its own policy, a short ladder for the test).
  folders = serveFolders();
  const dir = tmp('agm-giveup-');
  const crash = path.join(dir, 'crash.js');
  fs.writeFileSync(crash, "'use strict';\nprocess.exit(1);\n");
  const wrapper = path.join(dir, 'watchdog.js');
  fs.writeFileSync(wrapper, "'use strict';\nprocess.env.AGM_CHILD = " + JSON.stringify(crash) + ";\nprocess.env.AGM_BACKOFF = '0.05';\nrequire(" + JSON.stringify(path.join(h.ROOT, 'supervise.js')) + ');\n');
  started = Date.now();
  assert.equal(await launch.serve(launch.parse(serveArgs(folders, await h.freePort())), { supervise: wrapper }), 0, 'the give-up ends serve 0: the task stays stopped');
  assert.ok(Date.now() - started < 60000);
  why = JSON.parse(read(path.join(folders.data, 'watchdog.json')));
  assert.match(why.reason, /times in 10 minutes/);
  assert.match(read(path.join(folders.logs, 'server.log')), /giving up: /);
});

test('launch.js status: the person\'s reader, each fact read, refused or absent — the data folder\'s records refused to this account are said so, never read as no stop; the task by column', () => {
  const root = tmp('agm-lstatus-');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', 'server.log'), 'first\nlast line');
  const denied = (f, enc) => { if (f.startsWith(path.join(root, 'data'))) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readFileSync(f, enc); };
  const run = (exe) => { const n = base(exe); if (n === 'schtasks.exe') return '"LAPTOP","\\AGMessage\\Server","N/A","Wird ausgef\u00fchrt","x","y","0"'; if (n === 'reg.exe') return '    AdminName    REG_SZ    LAPTOP\\ana\r\n    Port    REG_DWORD    0xbcf'; return ''; };
  const r = launch.statusOf({ machine: root, sys: SYS, run, read: denied });
  assert.deepEqual([r.facts.task.read, r.facts.task.state, r.facts.task.lastResult, r.facts.admin, r.facts.port], ['read', 'Wird ausgef\u00fchrt', 0, 'LAPTOP\\ana', 3023]);
  assert.deepEqual([r.facts.lastStop.read, r.facts.lastStop.code, r.facts.watchdogLog.read, r.facts.serverLog.read], ['refused', 'EACCES', 'refused', 'read']);
  assert.match(r.text, /the last stop: refused to this account \(AGMessage status, run as an administrator, reads it\)/);
  assert.equal(r.facts.serverLog.lines.at(-1), 'last line');
  // The task the descriptor keeps from this account: said not read, never "not registered" as a fact.
  const refused = launch.statusOf({ machine: root, sys: SYS, run: (exe) => { if (base(exe) === 'schtasks.exe') throw fail(1); return ''; }, read: denied });
  assert.equal(refused.facts.task.read, 'refused');
  assert.match(refused.facts.task.state, /not read: it is not registered, or this account may not read it/);
  // No --sys: the task and record reads run nothing, and say so; a record not there is absent.
  const none = launch.statusOf({ machine: root, sys: '', run: () => { throw new Error('never run'); } });
  assert.match(none.facts.task.state, /unknown \(no --sys\)/);
  assert.equal(none.facts.admin, 'unknown');
  assert.equal(none.facts.lastStop.read, 'absent');
});

test('launch.js knows serve, token, status, open, start, stop, upgrade, back, rights, export and forget-keys; each takes its folders', () => {
  const said = [];
  const out = (t) => said.push(t);
  assert.equal(launch.main([], { out }), 64);
  assert.equal(launch.main(['upgrade'], { out }), 64);
  assert.equal(launch.main(['serve', '--data', '/tmp/x'], { out }), 64);
  assert.equal(launch.main(['start'], { out }), 64);
  assert.equal(launch.main(['stop', '--machine', '/m', '--sys', 'System32'], { out }), 64);
  assert.match(said[0], /launch\.js knows serve, token, status, open, start, stop, upgrade, back, rights, export or forget-keys\./);
  assert.match(said[1], /launch\.js upgrade needs --machine <folder>/);
  assert.match(said[2], /launch\.js serve needs --uploads/);
  assert.match(said[3], /launch\.js start needs --machine <folder>/);
  assert.match(said[4], /launch\.js stop needs --sys <folder>, the System32 folder named from its drive \(C:\\Windows\\System32\): whoami\.exe and schtasks\.exe are run from it\./);
  said.length = 0;
  assert.equal(launch.main(['serve', '--data', '/d', '--uploads', '/u', '--keys', '/k', '--logs', '/l', '--token', '/t', '--events', '/e', '--port', '3023'], { out }), 64);
  assert.match(said[0], /serve is the server task's action/);
});

// ---------------------------------------------------------------- the upgrade backup (lib/upgradebackup.js)

test('the upgrade backup: a store is linked, an append-only log and a .bak copied, the backups and logs skipped; the two newest kept', () => {
  const dir = tmp('agm-ub-');
  const dataDir = path.join(dir, 'data');
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups', 'old'), { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'rooms', 'ABC.json'), '{"code":"ABC"}');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'ABC.log'), 'op1\nop2\n');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'ABC.json.bak'), '{"code":"ABC"}');
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), 'a\n');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'logs', 'server.log'), 'never backed up');
  fs.writeFileSync(path.join(uploadDir, 'file.bin'), Buffer.alloc(10));
  const r = upgradebackup.make({ dataDir, uploadDir, build: '0.6.0+41.abc1234', stopAt: 123, saved: true, reserve: 0 });
  const b = path.join(dataDir, ...r.name.split('/'));
  assert.ok(fs.existsSync(path.join(b, 'data', 'rooms', 'ABC.json')) && fs.existsSync(path.join(b, 'data', 'rooms', 'ABC.log')) && fs.existsSync(path.join(b, 'uploads', 'file.bin')));
  assert.ok(!fs.existsSync(path.join(b, 'data', 'logs')) && !fs.existsSync(path.join(b, 'data', 'backups')), 'logs/ and backups/ are never backed up');
  assert.equal(fs.statSync(path.join(b, 'data', 'rooms', 'ABC.json')).ino, fs.statSync(path.join(dataDir, 'rooms', 'ABC.json')).ino, 'the store is a hard link, costing no room');
  assert.ok(r.linked >= 2 && r.copied >= 2, 'the logs and the .bak are copied');
  const meta = JSON.parse(read(path.join(b, 'backup.json')));
  assert.deepEqual([meta.v, meta.build, meta.stopAt, meta.saved], [1, '0.6.0+41.abc1234', 123, true]);
  upgradebackup.make({ dataDir, uploadDir, build: '0.6.0+42.def5678', stopAt: 456, saved: true, reserve: 0, now: Date.now() + 1000 });
  const r3 = upgradebackup.make({ dataDir, uploadDir, build: '0.6.0+43.aaa0000', stopAt: 789, saved: true, reserve: 0, now: Date.now() + 2000 });
  const list = upgradebackup.list(dataDir);
  assert.equal(list.length, upgradebackup.KEEP, 'two upgrade backups kept');
  assert.equal(list[0].name, r3.name.split('/').pop(), 'the newest first');
  assert.ok(!fs.existsSync(b), 'the oldest upgrade backup is removed');
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', 'old')), 'a folder that is not an upgrade backup is left');
});

test('the upgrade backup refuses when the disk is short of room for its copies and the reserve, leaving nothing', () => {
  const dir = tmp('agm-ub2-');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), Buffer.alloc(100));
  assert.throws(() => upgradebackup.make({ dataDir, uploadDir: path.join(dir, 'uploads'), build: 'b', stopAt: 1, saved: true, reserve: Number.MAX_SAFE_INTEGER }), (e) => /no backup was made for the way back/.test(e.words));
  assert.deepEqual(upgradebackup.list(dataDir), [], 'nothing left behind');
});
