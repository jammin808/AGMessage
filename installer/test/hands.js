'use strict';
/**
 * The installer's life cycle's hands on Windows (installer/test/lifecycle.test.js, the 0.6.0 plan's Part 6, unit U16):
 * the installers run as an administrator runs them quietly, each with its log; what Windows says read back (the install
 * record, the tasks, the firewall rules, an access list, a process's privileges, a file's version); the installed node
 * asked at loopback as the machine asks it (app/lib/machinewire.js); and the stand-ins the life cycle needs (a portable
 * copy, a program that holds the port and answers nothing, a file held open, a standard account and a task as it).
 *
 * It is CI's alone: the life cycle installs AGMessage for the whole machine, makes and removes a Windows account and
 * tasks, so `placeRefusal` refuses anything but an elevated GitHub-hosted Windows runner with no AGMessage on it, before
 * anything is made. Every program runs by its absolute path (System32's, the install's node.exe, this runner's own
 * node.exe), with an argument array and no shell; no token or password is written into a log, a record or a file but the
 * one a step hands it to.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const machine = require(path.join(REPO, 'app', 'machine.js'));
const wire = require(path.join(REPO, 'app', 'lib', 'machinewire.js'));
const readings = require(path.join(REPO, 'tools', 'readings-take.js'));
const expect = require(path.join(__dirname, 'expect.js'));

const DRIVE_PATH = /^[A-Za-z]:\\/;
const PORT = 3023;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The machine's own folders, from Windows' own names (never a relative path): System32, the install folder, the machine folder, the Start menu's. */
function places(env = process.env) {
  for (const k of ['SystemRoot', 'ProgramData']) if (!DRIVE_PATH.test(String(env[k] || ''))) throw new Error(k + ' does not name a folder from its drive');
  const programFiles = String(env.ProgramW6432 || env.ProgramFiles || '');
  if (!DRIVE_PATH.test(programFiles)) throw new Error('ProgramFiles does not name a folder from its drive');
  return {
    sys: path.win32.join(env.SystemRoot, 'System32'),
    app: path.win32.join(programFiles, 'AGMessage'),
    root: path.win32.join(env.ProgramData, 'AGMessage'),
    menu: path.win32.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AGMessage'),
  };
}

/** A program by its absolute path, from its own folder unless told, within `ms`: {code, out, err}. */
function run(file, args, { ms = 120000, env, cwd = path.dirname(file), input } = {}) {
  const r = childProcess.spawnSync(file, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: ms, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') + (r.error ? ' ' + String(r.error.code || r.error.message) : '') };
}

/**
 * A program by its absolute path, as `run` runs it, but without holding the loop while it runs, so the test that waits on
 * it can still end at its own bound and fail by its name: {code, out, err} (code null for one ended at `ms`, said ETIMEDOUT).
 */
function runAsync(file, args, { ms = 120000, env, cwd = path.dirname(file) } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: ms, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = !error ? 0 : Number.isInteger(error.code) ? error.code : null;
      const why = error && code === null ? ' ' + String(error.killed ? 'ETIMEDOUT' : error.code || error.message) : '';
      resolve({ code, out: String(stdout || ''), err: String(stderr || '') + why });
    });
  });
}

/**
 * Why the life cycle refuses this machine, before anything is made; '' when it may run here: Windows, a GitHub-hosted
 * runner (thrown away after the job), elevated, no install record, no install folder and no machine folder.
 */
function placeRefusal({ env = process.env, platform = process.platform, exists = fs.existsSync, ask = run } = {}) {
  if (platform !== 'win32') return 'the life cycle installs AGMessage on Windows: CI\'s elevated windows-2025 job runs it (.github/workflows/ci.yml, lifecycle)';
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') return 'the life cycle installs and removes AGMessage for the whole machine, a Windows account and tasks: it is CI\'s, on a GitHub-hosted runner thrown away after the job, and this machine is not one (RUNNER_ENVIRONMENT ' + JSON.stringify(String(env.RUNNER_ENVIRONMENT || '')) + ')';
  let p;
  try { p = places(env); } catch (e) { return e.message; }
  if (!machine.elevatedOf(ask(path.win32.join(p.sys, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh']).out)) return 'the life cycle runs elevated, as an installer does, and this process is not';
  if (ask(path.win32.join(p.sys, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage', '/reg:64']).code === 0) return 'AGMessage is installed on this machine (HKLM\\SOFTWARE\\AGMessage): the life cycle would upgrade and remove it';
  for (const dir of [p.app, p.root]) if (exists(dir)) return dir + ' is there: the life cycle begins with neither the install folder nor the machine folder';
  return '';
}

/**
 * The privileges in a process's token, by name, read through the token itself (OpenProcessToken, TokenPrivileges): the
 * server's own, whatever its task's definition asked for. C# for PowerShell's Add-Type, handed to it in its environment, so
 * the script on its command line holds single quotes alone.
 */
const TOKEN_READER = String.raw`using System; using System.Collections.Generic; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text;
public static class AgmToken {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeNameW(string system, ref long luid, StringBuilder name, ref int len);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string[] Privileges(int pid) {
    IntPtr p = OpenProcess(0x1000, false, (uint)pid);
    if (p == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr t;
    try { if (!OpenProcessToken(p, 0x0008, out t)) throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { CloseHandle(p); }
    try {
      int len; GetTokenInformation(t, 3, IntPtr.Zero, 0, out len);
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (!GetTokenInformation(t, 3, buf, len, out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int n = Marshal.ReadInt32(buf); var names = new List<string>();
        for (int i = 0; i < n; i++) {
          long luid = Marshal.ReadInt64(buf, 4 + i * 12); var sb = new StringBuilder(128); int sl = sb.Capacity;
          names.Add(LookupPrivilegeNameW(null, ref luid, sb, ref sl) ? sb.ToString() : "LUID " + luid);
        }
        return names.ToArray();
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(t); }
  }
}
`;

/** The life cycle's hands, for the folders `work` (made, with `logs` inside it) and the plan's installers. */
function hands({ work, logs }) {
  const p = places();
  const L = readings.lane(work, p.sys);
  const exe = (name) => path.win32.join(p.sys, name);
  const tokens = new Set();
  const passwords = new Set();
  let logN = 0;

  /** The install record's values, or null when there is none. */
  const record = () => {
    const r = run(exe('reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage', '/reg:64']);
    return r.code === 0 ? expect.recordOf(r.out) : null;
  };
  /** The grants under the record (Grants: a value per SID). */
  const grants = () => {
    const r = run(exe('reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage\\Grants', '/reg:64']);
    const out = {};
    if (r.code === 0) for (const line of r.out.split(/\r?\n/)) { const m = /^ {4}(S-1-[0-9-]+) {4}REG_SZ {4}(.*)$/.exec(line); if (m) out[m[1]] = m[2].trim(); }
    return out;
  };
  /** A task's state and last result ({exists: false} when there is none). */
  const task = (name) => {
    const r = run(exe('schtasks.exe'), ['/Query', '/TN', name, '/FO', 'CSV', '/NH', '/V']);
    if (r.code !== 0) return { exists: false };
    const st = machine.taskStateOf(r.out);
    return { exists: true, state: st ? st.state : 'unknown', lastResult: st ? st.lastResult : null };
  };
  /** Every task in Task Scheduler's \AGMessage\ folder, by its whole name. */
  const agmTasks = () => {
    const r = run(exe('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH']);
    return [...new Set(machine.csvRows(r.out).map((row) => row[0]).filter((n) => /^\\AGMessage\\[^\\]+$/i.test(String(n || ''))))];
  };
  /** A task's definition, as Task Scheduler holds it: {xml, sddl}. */
  const definition = (name) => {
    const at = name.lastIndexOf('\\');
    return L.ps(readings.SCRIPTS.definition, { AGM_TASK_FOLDER: name.slice(0, at) || '\\', AGM_TASK_NAME: name.slice(at + 1) });
  };
  /** Whether each of AGMessage's two firewall rules is there. */
  const rules = () => L.ps(String.raw`$ErrorActionPreference = 'Stop'; $o = @{}; foreach ($n in @($env:AGM_RULES -split ',')) { $o[$n] = [bool](@(Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue).Count) }; ConvertTo-Json -InputObject $o -Compress`, { AGM_RULES: [machine.RULE_TCP, machine.RULE_UDP].join(',') });
  /** A folder's or a file's security descriptor, as SDDL. */
  const sddl = (file) => String(L.ps(String.raw`$ErrorActionPreference = 'Stop'; ConvertTo-Json -InputObject @{ sddl = [string](Get-Acl -LiteralPath $env:AGM_PATH).Sddl } -Compress`, { AGM_PATH: file }).sddl || '');
  /** The programs running from a folder: {pid, name, cmd}. */
  const programs = (dir) => {
    const a = L.ps(String.raw`$ErrorActionPreference = 'Stop'; $d = ([string]$env:AGM_DIR).TrimEnd('\') + '\'; $o = @(); foreach ($p in @(Get-CimInstance -ClassName Win32_Process)) { $x = [string]$p.ExecutablePath; if ($x -and $x.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)) { $o += @{ pid = [int64]$p.ProcessId; name = [string]$p.Name; cmd = [string]$p.CommandLine } } }; ConvertTo-Json -InputObject @{ programs = @($o) } -Depth 3 -Compress`, { AGM_DIR: dir });
    return Array.isArray(a.programs) ? a.programs : a.programs ? [a.programs] : [];
  };
  /** The privileges in a process's token, by name (TOKEN_READER). */
  const privileges = (pid) => L.ps(String.raw`$ErrorActionPreference = 'Stop'; [void][System.Diagnostics.Process]::EnterDebugMode(); Add-Type -TypeDefinition $env:AGM_TOKEN_READER; ConvertTo-Json -InputObject @{ privileges = @([AgmToken]::Privileges([int]$env:AGM_PID)) } -Compress`, { AGM_PID: String(pid), AGM_TOKEN_READER: TOKEN_READER });
  /** A file's product version, as its version resource says it (the build an installer was compiled for), its padding cut. */
  const productVersion = (file) => String(L.ps(String.raw`$ErrorActionPreference = 'Stop'; ConvertTo-Json -InputObject @{ v = [string](Get-Item -LiteralPath $env:AGM_PATH).VersionInfo.ProductVersion } -Compress`, { AGM_PATH: file }).v || '').replace(/[\0\s]+$/, '');

  /** A process and every process it started, ended outright (taskkill /T /F, by its absolute path): only the life cycle's own stand-ins and portable copies, never an installer. */
  const endTree = (pid) => run(exe('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { ms: 15000, cwd: p.sys });
  /**
   * A child of the life cycle's own (a stand-in it started) ended: `ask` asks it to end, and one that has not within `ms`
   * has its tree ended outright, then is waited for 5 s more. Resolves how it ended ('by itself', 'outright', or 'not
   * seen to end'), never rejects, so it may sit in a finally beside the error it follows.
   */
  const ended = (child, ms, ask) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve('by itself');
    const exit = new Promise((resolve) => { child.once('exit', () => resolve(true)); });
    ask();
    return Promise.race([exit, sleep(ms).then(() => false)]).then(async (by) => {
      if (by) return 'by itself';
      endTree(child.pid);
      return (await Promise.race([exit, sleep(5000).then(() => false)])) ? 'outright' : 'not seen to end';
    });
  };

  /** The next log's path in `logs`, its name saying what ran. */
  const logFor = (what) => path.join(logs, String(++logN).padStart(2, '0') + '-' + what.replace(/[^A-Za-z0-9.-]+/g, '-') + '.log');
  /** A log's text as Inno Setup wrote it ('' when it wrote none). */
  const logOf = (file) => { try { return expect.logText(fs.readFileSync(file)); } catch { return ''; /* none written: the run's code says why */ } };
  /** Each installer still running, by its pid: what it was run for. */
  const installing = new Map();
  /**
   * An installer run quietly, as an administrator runs one ({exe} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART and `args`),
   * its log written to a file of its own: resolves {code, ms, log, said} once it has ended, or rejects once `ms` has
   * passed (11 minutes, under the longest test's own bound), naming what it was run for, its pid, the seconds waited and
   * its log's last lines. An installer is never ended from here: Inno Setup's own rollback does not run on a kill. While
   * one still runs, however its test ended, the next install is refused at once, naming it, so the tests after a hung
   * installer fail by their names and none runs an installer beside another.
   */
  const install = (exeFile, args, what, { ms = 11 * 60_000 } = {}) => new Promise((resolve, reject) => {
    if (installing.size) {
      reject(new Error('the installer run for ' + [...installing].map(([pid, was]) => was + ' (pid ' + pid + ')').join(', ') + ' still runs: ' + what + ' is not started beside it'));
      return;
    }
    const log = logFor(what);
    const t0 = Date.now();
    const child = childProcess.spawn(exeFile, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...args, '/LOG=' + log], { cwd: path.dirname(exeFile), windowsHide: true, stdio: 'ignore' });
    if (child.pid) installing.set(child.pid, what);
    const late = setTimeout(() => {
      const tail = expect.innoLog(logOf(log)).messages.slice(-8).join(' | ').slice(-1500);
      reject(new Error('the installer run for ' + what + ' (pid ' + child.pid + ') had not ended ' + Math.round((Date.now() - t0) / 1000) + ' s after it started; its log ends: ' + (tail || '(nothing written)')));
    }, ms);
    const done = (code) => { clearTimeout(late); installing.delete(child.pid); const text = logOf(log); resolve({ code, ms: Date.now() - t0, log, text, said: expect.innoLog(text) }); };
    child.once('exit', (code) => done(code));
    child.once('error', (e) => { done(null); console.error('the installer did not run: ' + e.message); });
  });
  /**
   * The uninstaller run quietly ({app}\unins000.exe), then waited for until the install is gone (it hands the work to a
   * copy of itself and its record and folder go last), at most `ms`: {code, ms, log, said, gone}.
   */
  const uninstall = async (args, what, { ms = 6 * 60_000 } = {}) => {
    const log = logFor(what);
    const t0 = Date.now();
    const r = await runAsync(path.win32.join(p.app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...args, '/LOG=' + log], { ms, cwd: p.sys });
    const gone = await until(() => !fs.existsSync(path.win32.join(p.app, 'unins000.exe')) && !(record() || {}).InstallDir, ms);
    await sleep(2000);
    const text = logOf(log);
    return { code: r.code, ms: Date.now() - t0, log, text, said: expect.innoLog(text), gone: !!gone };
  };

  /** The installed node's token as its watchdog wrote it ('' when there is none); each one read is kept for the logs' check. */
  const token = () => {
    let t;
    try { t = fs.readFileSync(path.win32.join(p.root, 'token', 'admin-token'), 'utf8').trim(); } catch { t = ''; /* none yet, or none any more */ }
    if (t) tokens.add(t);
    return t;
  };
  /** The installed node proving it holds the token, as `build` when given, within `ms`: its hello ({ok, build}) or the last that was not. */
  const proven = async (build = '', { ms = 60000 } = {}) => {
    let last = { ok: false, words: 'not asked' };
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const t = token();
      last = t ? await wire.hello({ port: PORT, token: t }) : { ok: false, words: 'no token' };
      if (last.ok && (!build || last.build === build)) return last;
      await sleep(250);
    }
    return { ...last, ok: false };
  };
  /** Whether anything takes a connection on the port now. */
  const answers = () => machine.portAnswers(PORT);

  /** A command of the installed machine.js (or another install folder's), elevated as this process is, with its --out: resolves {code, said}. */
  const machineJs = async (args, { app = p.app, ms = 300000 } = {}) => {
    const out = path.join(work, 'machine-' + crypto.randomBytes(6).toString('hex') + '.json');
    const r = await runAsync(path.win32.join(app, 'node', 'node.exe'), [path.win32.join(app, 'app', 'machine.js'), ...args, '--out', out], { ms, cwd: path.win32.join(app, 'app') });
    let said;
    try { said = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { said = { words: (r.err || r.out).trim().slice(-600) }; }
    fs.rmSync(out, { force: true });
    return { code: r.code, said };
  };
  /**
   * A request of an administrator's elevated console (machine.js control --elevated), as Who may run AGMessage… run as an
   * administrator makes one: written into machine\work\ (SYSTEM and Administrators only), its answer read from --out:
   * resolves {code, said}.
   */
  const control = (request) => {
    const file = path.win32.join(p.root, 'machine', 'work', 'lifecycle-' + crypto.randomBytes(6).toString('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify({ id: crypto.randomBytes(12).toString('hex'), ...request }));
    return machineJs(['control', '--elevated', '--request', file, '--machine', p.root, '--sys', p.sys]);
  };
  /** The facts of a data folder and its key folder, read by an install's own reader (lib/importfacts.js), elevated: resolves them. */
  const facts = async ({ data = path.win32.join(p.root, 'data'), keys = path.win32.join(p.root, 'keys'), app = p.app } = {}) => {
    const r = await runAsync(path.win32.join(app, 'node', 'node.exe'), [path.win32.join(app, 'app', 'lib', 'importfacts.js'), '--data', data, '--keys', keys], { ms: 300000, cwd: path.win32.join(app, 'app') });
    let j;
    try { j = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { j = null; /* said below */ }
    if (!j || !j.facts) throw new Error('the facts of ' + data + ' were not read: ' + ((j && j.error) || (r.err || r.out).trim().slice(-400)));
    return j.facts;
  };

  /** A copy of a folder laid at `to` (made new), as a person copies a portable folder. */
  const copy = (from, to) => { fs.rmSync(to, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); fs.cpSync(from, to, { recursive: true }); return to; };
  /** A folder renamed on its volume, as an administrator renames one, a scanner's handle on it (EBUSY, EPERM, EACCES) waited out for up to 30 s. */
  const move = async (from, to) => {
    for (let i = 0; ; i++) {
      try { fs.renameSync(from, to); return to; } catch (e) {
        if (i >= 60 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
        await sleep(500);
      }
    }
  };
  /**
   * A portable copy's watchdog, started as a person's window starts it (its own node.exe and supervise.js, no AGM_OPEN, no
   * channel or folder of the installed node's), on `port` with the token `adminToken` (made for it here, kept for the logs'
   * check), and `env`'s additions: {child, exited, tail(), port, token}.
   */
  const portable = (dir, { port = PORT, env: more = {} } = {}) => {
    const adminToken = crypto.randomBytes(16).toString('hex');
    tokens.add(adminToken);
    const env = { ...process.env, PORT: String(port), ADMIN_TOKEN: adminToken, ...more };
    for (const k of ['AGM_OPEN', 'AGM_RUNS', 'AGM_TOKEN_DIR', 'AGM_LOG_DIR', 'AGM_MACHINE_EVENTS', 'AGM_CHILD', 'NODE_OPTIONS']) delete env[k];
    const child = childProcess.spawn(path.win32.join(dir, 'node', 'node.exe'), [path.win32.join(dir, 'app', 'supervise.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const keep = (c) => { tail = (tail + c.toString('utf8')).slice(-16384); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const exited = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', () => resolve(null)); });
    return { child, exited, tail: () => tail.split(adminToken).join('<token>'), port, token: adminToken, dir };
  };
  /**
   * A portable copy stopped as a stop at loopback with the proof stops it (it saves), waited for 30 s; one that has not
   * ended by then has its tree ended outright (its watchdog's forked server outlives the watchdog's own end on Windows),
   * then its port is waited for 15 s to close, and said when it does not. Its exit code, or null when it was ended.
   */
  const portableStop = async (w) => {
    if (w.child.exitCode !== null || w.child.signalCode !== null) return w.child.exitCode;
    await wire.stop({ port: w.port, token: w.token, reason: 'stop', by: 'the installer\'s life cycle', force: 'the life cycle stops its portable copy' });
    const code = await Promise.race([w.exited, sleep(30000).then(() => undefined)]);
    if (code !== undefined) return code;
    endTree(w.child.pid);
    await Promise.race([w.exited, sleep(10000)]);
    if (!(await until(async () => !(await machine.portAnswers(w.port)), 15000, 500))) console.error('the portable copy in ' + w.dir + ' was ended outright, and port ' + w.port + ' still answers 15 s later');
    return null;
  };
  /** Health at loopback, read as the machine reads a holder's ({version, build, runs}), or null. */
  const health = (port = PORT) => machine.healthOf(port);

  /**
   * A program that takes every connection on `port` and answers nothing (this runner's own node.exe): {pid, close()}, once
   * it listens; refused, its tree ended, when it does not within `ms`. close() ends it within 20 s, outright after that.
   */
  const silent = (port = PORT, { ms = 60_000 } = {}) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', "const s = require('node:net').createServer(() => {}); s.listen(Number(process.argv[1]), '127.0.0.1', () => process.stdout.write('listening\\n'));", String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let said = '';
    const late = setTimeout(() => { endTree(child.pid); reject(new Error('the silent listener on port ' + port + ' (pid ' + child.pid + ') did not listen within ' + ms / 1000 + ' s')); }, ms);
    child.stdout.on('data', (c) => { said += c; if (said.includes('listening')) { clearTimeout(late); resolve({ pid: child.pid, close: () => ended(child, 20_000, () => child.kill()) }); } });
    child.once('exit', (code) => { clearTimeout(late); reject(new Error('the silent listener on port ' + port + ' ended with ' + code)); });
  });
  /**
   * A file held open with no sharing by a program outside the install folder (powershell.exe), until released: refused,
   * its tree ended, when it is not held within `ms`; release() ends it within 20 s, outright after that.
   */
  const hold = (file, { ms = 60_000 } = {}) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(path.win32.join(p.sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String.raw`$f = [System.IO.File]::Open($env:AGM_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`], { env: { ...process.env, AGM_PATH: file }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let said = '';
    let err = '';
    const late = setTimeout(() => { endTree(child.pid); reject(new Error(file + ' was not held within ' + ms / 1000 + ' s (powershell.exe, pid ' + child.pid + '): ' + err.trim().slice(0, 300))); }, ms);
    child.stdout.on('data', (c) => { said += c; if (said.includes('held')) { clearTimeout(late); resolve({ pid: child.pid, release: () => ended(child, 20_000, () => child.stdin.end('\n')) }); } });
    child.stderr.on('data', (c) => { err += c; });
    child.once('exit', (code) => { clearTimeout(late); reject(new Error(file + ' was not held (' + code + '): ' + err.trim().slice(0, 300))); });
  });
  /** A junction at `link` to `target`, as a standard account may make one under %ProgramData% (Node's own, no shell). */
  const junction = (link, target) => { fs.symlinkSync(target, link, 'junction'); };
  /** A folder's owner set to an account, by its SID (icacls /setowner, as an administrator may). */
  const setOwner = (dir, sid) => {
    const r = run(exe('icacls.exe'), [dir, '/setowner', '*' + sid], { cwd: p.sys });
    if (r.code !== 0) throw new Error('the owner was not set: ' + (r.err || r.out).trim().slice(0, 300));
  };

  /**
   * A standard account made for the life cycle (a member of Users and of nothing that elevates), with a password of its
   * own that goes to PowerShell's and schtasks' environment and arguments alone: {name, sid, password}.
   */
  const account = (name) => {
    const password = 'Aa1!' + crypto.randomBytes(18).toString('base64url');
    passwords.add(password);
    const users = L.ps(readings.SCRIPTS.users, { AGM_R11_USERS: name, AGM_R11_PASSWORD: password });
    const u = (Array.isArray(users) ? users : [users]).find((x) => x && x.name === name && /^S-1-[0-9-]+$/.test(String(x.sid)));
    if (!u) throw new Error('the standard account ' + name + ' was not made');
    if (u.admin === true) throw new Error('the account ' + name + ' is an administrator: it stands for no standard account');
    return { name, sid: u.sid, password };
  };
  const accountGone = (name) => L.ps(readings.SCRIPTS.usersGone, { AGM_R11_USERS: name });
  /**
   * A task that runs as `who` by its password, in the life cycle's own folder of Task Scheduler (never \AGMessage\, which an
   * uninstall empties), its action `node` (a node.exe that account may run) on `script` with `dir`, ended by Task
   * Scheduler past `limitMinutes`.
   */
  const taskAs = (name, who, { node, script, dir, limitMinutes }) => {
    if (!Number.isSafeInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > 60) throw new Error('a probe\'s task needs its time limit, 1 to 60 minutes');
    L.register(name, readings.taskXml({ description: 'AGMessage\'s installer life cycle: a probe, as ' + who.name, sid: who.sid, logon: 'Password', limit: 'PT' + limitMinutes + 'M', command: node, args: [script, dir], cwd: dir }), { user: who.name, password: who.password });
  };

  /** Every file under a folder, by its path inside it ('/' between folders): {size, sha}. */
  const tree = (dir) => {
    const out = new Map();
    const walk = (abs, rel) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        const f = path.join(abs, e.name);
        if (e.isDirectory()) walk(f, r);
        else if (e.isFile()) out.set(r, { size: fs.statSync(f).size, sha: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') });
      }
    };
    walk(dir, '');
    return out;
  };
  /** The machine's events (machine\events.jsonl), in order. */
  const events = () => { try { return expect.eventsOf(fs.readFileSync(path.win32.join(p.root, 'machine', 'events.jsonl'), 'utf8')); } catch { return []; /* none yet */ } };

  return {
    ...p, port: PORT, work, logs, L, run, exe, record, grants, task, agmTasks, definition, rules, sddl, programs, privileges, productVersion,
    install, installing, uninstall, logFor, logOf, token, proven, answers, machineJs, control, facts, copy, move, portable, portableStop, health, silent, hold, endTree,
    junction, setOwner, account, accountGone, taskAs, tree, events, tokens, passwords,
  };
}

/** `test()` again every `every` ms until it gives a value or `ms` has passed: that value, or null. */
async function until(test, ms, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() - t0 >= ms) return null;
    await sleep(every);
  }
}

module.exports = { PORT, places, run, runAsync, placeRefusal, hands, until, sleep };
