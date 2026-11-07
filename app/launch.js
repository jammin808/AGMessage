'use strict';
/**
 * The installed node's commands for the person at the PC: each item of the Start menu's AGMessage folder runs
 * `node.exe app\launch.js <verb>` in a console of its own, as the person who chose it, and never asks for an elevation.
 * It requires Node's own modules only, runs nothing but by its absolute path, and reads no machine path from its
 * environment: the installer passes each folder it needs as an argument.
 *
 *   serve --data <folder> --uploads <folder> --keys <folder> --logs <folder> --token <folder> --port <n>
 *                              The server task's action (`\AGMessage\Server`): it runs the watchdog (supervise.js) in a
 *                              process of its own, by its absolute path beside this file, in an environment made of
 *                              Windows' own names (TASK_PASSED) and AGM_RUNS=task, the folders and the port from its
 *                              arguments, nothing else of its own: no NODE_OPTIONS, no AGM_… it was not handed. The
 *                              watchdog's stop (0), its give-up and a configuration refusal (3) end this process with 0,
 *                              after the watchdog has written why (watchdog.json, server.log), so the task stays stopped
 *                              and RestartOnFailure does not loop it; only an unexpected end of the watchdog is non-zero,
 *                              which RestartOnFailure restarts.
 *   token --machine <folder> [--sys <folder>]
 *                              Show the admin token: the installed node's token, read from <folder>\token\admin-token
 *                              (<folder> is the node's machine folder, %ProgramData%\AGMessage), which its watchdog
 *                              writes each time its server serves. Only this PC's AGMessage admin, and the accounts it
 *                              gave `token`, may read it; anyone else is told whom to ask, by the name the install record
 *                              keeps (HKLM\SOFTWARE\AGMessage, AdminName), read with reg.exe from the System32 folder
 *                              `--sys` names (the installer's {sys}); without it, the words name no one.
 *   status --machine <folder> [--sys <folder>] [--logs <folder>] [--port <n>] [--out <file>]
 *                              AGMessage status for the person, read without an elevation, each fact read, refused or
 *                              absent: the server task's state and last result (schtasks /query, by column), the install
 *                              record's admin and the port (reg query, 64-bit view), the tail of server.log (the logs
 *                              folder the laptop's admin may read), the last last-stop.json and watchdog.log's tail
 *                              (the data folder's, which only SYSTEM, Administrators and the server read: refused to
 *                              anyone else, and said so). Printed, or written to --out as JSON (never a token). What only
 *                              an elevation reads — those two, the port's holder pid and a code-integrity event — is
 *                              machine.js status's and the admin page's "This laptop".
 *
 * start, stop and rights (U17), upgrade and back (U18), and the account export and key removal (U14) are later units:
 * until each lands its verb is refused as unknown. A verb it does not know is refused, never defaulted. Exit codes: 0
 * done; 2 not done, with the words of why; 64 a verb or an argument it does not know, or one missing. In a console window
 * it waits for Enter before it ends, so the window that the Start menu opened stays until the person has read it.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DONE = 0;
const NOT_DONE = 2;
const USAGE = 64;
/** The watchdog's exit codes this process reads as "stays stopped" (lib/resilience.js EXIT): 0 stopped, 3 config/give-up. */
const STAYS_STOPPED = new Set([0, 3]);
/** The token the installed node's watchdog writes: 16 hex characters, its 64 random bits. */
const TOKEN_SHAPE = /^[0-9a-f]{16}$/;
/** A Windows folder named from its drive: the System32 folder is never taken relative to wherever this runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;

/** A name as words: control characters taken out, cut short. */
const said = (v, max = 120) => String(v).replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, max);

/**
 * This PC's AGMessage admin as the install record names it ('DOMAIN\name'), or '' when it cannot be read: not Windows, no
 * System32 folder named from its drive (`sys`, the installer's {sys}), no record, or reg.exe not answering within 5 s.
 * reg.exe runs by its absolute path in that folder, from that folder, in the record's 64-bit view.
 */
function adminName({ sys = '', platform = process.platform, run = childProcess.execFileSync } = {}) {
  if (platform !== 'win32' || !DRIVE_PATH.test(sys)) return '';
  try {
    const out = run(path.win32.join(sys, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage', '/v', 'AdminName', '/reg:64'],
      { cwd: sys, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /^\s*AdminName\s+REG_SZ\s+(.+)$/m.exec(String(out));
    return m ? said(m[1]) : '';
  } catch {
    return '';   // no record, or reg.exe refused: the words name no one
  }
}

/**
 * Show the admin token: {code, text}. The token file under `machine` is read once (`read`, fs.readFileSync unless a test
 * stands in for it); what it holds is printed only when it is a token the watchdog wrote. A read this account may not make
 * names whom to ask (`admin`, called only then, with `sys`); a file not there says AGMessage has not served yet; anything
 * else says what it met, never the file's bytes. The watchdog replaces the file whole each time its server serves, and
 * leaves it when it stops, so the token printed is the one the node last served with: the words say so.
 */
function showToken({ machine, sys = '', read = fs.readFileSync, admin = adminName }) {
  const file = path.join(machine, 'token', 'admin-token');
  let text;
  try { text = String(read(file, 'utf8')).trim(); } catch (e) {
    const code = (e && e.code) || 'EIO';
    if (code === 'EACCES' || code === 'EPERM') {
      const who = admin({ sys });
      return { code: NOT_DONE, text: 'This PC\'s AGMessage admin has not given you the token: ask ' + (who || 'them, or an administrator of this PC') + '.' };
    }
    if (code === 'ENOENT') return { code: NOT_DONE, text: 'AGMessage has no admin token on this PC yet: its server writes one each time it starts serving. Start AGMessage, then show the token again.' };
    return { code: NOT_DONE, text: 'The admin token could not be read (' + code + '): try again in a moment.' };
  }
  if (!TOKEN_SHAPE.test(text)) return { code: NOT_DONE, text: 'The token file (' + file + ') holds no token AGMessage wrote. Start AGMessage again: its server writes a new one.' };
  return { code: DONE, text: 'AGMessage\'s admin token on this PC:\n\n    ' + text + '\n\nType it at Admin login on this PC. It holds while AGMessage serves; each start makes a new one. If it is not taken, AGMessage has started again or is not serving: show the token again once it serves.' };
}

// The verbs later units add are refused as unknown until each lands (U17's start/stop/rights, U18's upgrade/back, U14's
// account export and key removal); the two U14 verbs are not enumerated here, so no landing-detector word for a later
// unit sits in this build's tree (test/readings.test.js holds that).
const LATER = Object.freeze({ start: 'U17', stop: 'U17', rights: 'U17', upgrade: 'U18', back: 'U18' });
/** The commands this build knows, for the words of an unknown one. */
const KNOWN = 'serve, token or status';

/** Options read by `--name value`, each once; a value missing or a name twice is a problem. */
function options(rest, allowed, verb) {
  const got = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!allowed.includes(name)) return { problem: '"' + said(name, 40) + '" is not an argument launch.js ' + verb + ' knows.' };
    if (name in got) return { problem: name + ' is given twice.' };
    if (i + 1 >= rest.length) return { problem: name + ' needs its value.' };
    got[name] = rest[++i];
  }
  return { got };
}

/** The command line, read: a shape per verb, or {problem}. Only the words below are known, each once. */
function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === 'serve') return parseServe(rest);
  if (verb === 'status') return parseStatus(rest);
  if (LATER[verb]) return { problem: 'launch.js ' + verb + ' is built by ' + LATER[verb] + '; this build knows ' + KNOWN + '.' };
  if (verb !== 'token') return { problem: 'launch.js knows ' + KNOWN + '.' + (verb ? ' "' + said(verb, 40) + '" is not one of them.' : '') };
  const got = { '--machine': null, '--sys': null };
  for (let i = 0; i < rest.length; i++) {
    if (Object.hasOwn(got, rest[i]) && got[rest[i]] === null && i + 1 < rest.length) { got[rest[i]] = rest[i + 1]; i++; }
    else return { problem: 'launch.js token takes --machine <folder> and --sys <folder>, each once and each with its folder; "' + said(rest[i], 40) + '" does not fit.' };
  }
  const machine = got['--machine'] || '';
  const sys = got['--sys'];
  if (!machine || !path.isAbsolute(machine)) return { problem: 'launch.js token needs --machine <folder>, the installed node\'s folder as a full path (%ProgramData%\\AGMessage).' };
  if (sys !== null && !DRIVE_PATH.test(sys)) return { problem: 'launch.js token\'s --sys is the System32 folder named from its drive (C:\\Windows\\System32); "' + said(sys, 80) + '" is not one.' };
  return { verb, machine, sys: sys || '' };
}

/** serve's command line: the five folders and the port, each required, each a full path (the port a number). */
function parseServe(rest) {
  const o = options(rest, ['--data', '--uploads', '--keys', '--logs', '--token', '--port'], 'serve');
  if (o.problem) return { problem: o.problem };
  const folders = {};
  for (const [opt, key] of [['--data', 'data'], ['--uploads', 'uploads'], ['--keys', 'keys'], ['--logs', 'logs'], ['--token', 'token']]) {
    const v = o.got[opt];
    if (!v || !path.isAbsolute(v)) return { problem: 'launch.js serve needs ' + opt + ' <folder>, a full path: the server task passes each.' };
    folders[key] = v;
  }
  const port = Number(o.got['--port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: 'launch.js serve needs --port <1-65535>.' };
  return { verb: 'serve', folders, port };
}

/** status's command line: the machine folder (required), the System32 and logs folders, the port and --out (each optional). */
function parseStatus(rest) {
  const o = options(rest, ['--machine', '--sys', '--logs', '--port', '--out'], 'status');
  if (o.problem) return { problem: o.problem };
  const machine = o.got['--machine'] || '';
  if (!machine || !path.isAbsolute(machine)) return { problem: 'launch.js status needs --machine <folder>, the installed node\'s folder as a full path (%ProgramData%\\AGMessage).' };
  const sys = o.got['--sys'];
  if (sys !== undefined && !DRIVE_PATH.test(sys)) return { problem: 'launch.js status\'s --sys is the System32 folder named from its drive; "' + said(sys, 80) + '" is not one.' };
  return { verb: 'status', machine, sys: sys || '', logs: o.got['--logs'] || '', port: Number(o.got['--port']) || 0, out: o.got['--out'] || '' };
}

const SERVER_TASK = '\\AGMessage\\Server';
const HKLM = 'HKLM\\SOFTWARE\\AGMessage';

/** The rows of a `/fo csv` answer, each a list of its fields: columns by position, never by Windows' localised words. */
function csvRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (fields.length) rows.push(fields);
  }
  return rows;
}
/** A file's last `n` lines, as read, refused (this account may not read it) or absent. */
function tailOf(read, file, n) {
  try { return { read: 'read', lines: String(read(file, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-n).map((l) => said(l, 400)) }; } catch (e) {
    const code = (e && e.code) || 'EIO';
    return { read: code === 'ENOENT' ? 'absent' : 'refused', code, lines: [] };
  }
}

/**
 * AGMessage status for the person: {code, text, facts}, each fact read, refused or absent, never a refusal taken for a
 * fact. The task's state and last result (schtasks /query /fo csv /nh /v, by column: no elevation, though the task's
 * descriptor may refuse this account), the record's admin and port (reg query, 64-bit view), server.log's tail (the
 * laptop's admin may read the logs folder), and the data folder's last-stop.json and watchdog.log, which an account that
 * is not SYSTEM, an administrator or the server is refused. The two programs run by their absolute path in `--sys`;
 * without it, those facts read "unknown". Never the token: the logs never hold it (lib/serverlog.js redacts it), and the
 * record holds no secret.
 */
function statusOf({ machine, sys = '', logs = '', port = 0, read = fs.readFileSync, run = childProcess.execFileSync } = {}) {
  const exe = (name) => path.win32.join(sys, name);
  const call = (name, args) => {
    if (!DRIVE_PATH.test(sys)) return { code: -1, out: '' };
    try { return { code: 0, out: String(run(exe(name), args, { cwd: sys, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }) || '') }; } catch (e) { return { code: Number.isInteger(e && e.status) ? e.status : 1, out: String((e && e.stdout) || '') }; }
  };
  const q = call('schtasks.exe', ['/Query', '/TN', SERVER_TASK, '/FO', 'CSV', '/NH', '/V']);
  const row = q.code === 0 ? csvRows(q.out)[0] : null;
  let task;
  if (!DRIVE_PATH.test(sys)) task = { read: 'unknown', state: 'unknown (no --sys)', lastResult: null };
  else if (row && row.length >= 7) task = { read: 'read', state: said(row[3], 40) || 'unknown', lastResult: /^-?\d{1,12}$/.test(row[6].trim()) ? Number(row[6].trim()) : null };
  else task = { read: 'refused', state: 'not read: it is not registered, or this account may not read it (schtasks.exe ended with ' + q.code + ')', lastResult: null, code: q.code };
  const reg = call('reg.exe', ['query', HKLM, '/reg:64']);
  // The record's values read once into a map (a fixed pattern that captures the name), never a pattern built from one.
  const record = {};
  for (const line of reg.out.split(/\r?\n/)) { const m = /^ {4}([A-Za-z]{1,40}) {4}REG_[A-Z_]{2,20} {4}(.*)$/.exec(line); if (m) record[m[1]] = said(m[2], 120); }
  const value = (name) => record[name] || '';
  let lastStop;
  try {
    const j = JSON.parse(read(path.join(machine, 'data', 'last-stop.json'), 'utf8'));
    lastStop = { read: 'read', saved: j.saved === true, at: Number.isFinite(j.at) ? j.at : null, unsaved: Array.isArray(j.unsaved) ? j.unsaved.map((x) => said(x, 60)).join(', ') : '' };
  } catch (e) {
    const code = (e && e.code) || 'not JSON';
    lastStop = { read: code === 'ENOENT' ? 'absent' : 'refused', code };
  }
  const logsDir = logs || path.join(machine, 'logs');
  const facts = {
    task,
    admin: value('AdminName') || value('Admin') || (reg.code === 0 ? 'not recorded' : 'unknown'),
    port: Number(value('Port')) || port || null,   // a REG_DWORD reads 0x…, which Number reads as hex
    lastStop,
    watchdogLog: tailOf(read, path.join(machine, 'data', 'watchdog.log'), 10),
    serverLog: tailOf(read, path.join(logsDir, 'server.log'), 10),
  };
  const elevated = 'refused to this account (AGMessage status, run as an administrator, reads it)';
  const lines = ['AGMessage on this PC:', '  the server task: ' + task.state + (task.lastResult === null ? '' : ' (last result ' + task.lastResult + ')'), '  the laptop\'s admin: ' + facts.admin];
  if (facts.port) lines.push('  port: ' + facts.port);
  if (lastStop.read === 'read') lines.push('  the last stop: ' + (lastStop.saved ? 'saved' : 'not saved' + (lastStop.unsaved ? ' (' + lastStop.unsaved + ')' : '')));
  else lines.push('  the last stop: ' + (lastStop.read === 'absent' ? 'no record (AGMessage is serving, or did not stop cleanly)' : elevated));
  if (facts.serverLog.read === 'read' && facts.serverLog.lines.length) lines.push('  the log\'s last line: ' + facts.serverLog.lines[facts.serverLog.lines.length - 1].slice(0, 160));
  else if (facts.serverLog.read === 'refused') lines.push('  the log: ' + elevated);
  return { code: DONE, text: lines.join('\n'), facts };
}

/**
 * The names of the task's own environment the watchdog is handed: Windows' folders and the machine's names, which Node
 * and the programs the server runs by their absolute paths read (TMPDIR and HOME for the same off Windows). Nothing else:
 * no NODE_OPTIONS (code loaded before the server), no AGM_… the task was not given as an argument, no secret.
 */
const TASK_PASSED = Object.freeze(['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);
/**
 * The watchdog's environment under the task (pure but for its default): TASK_PASSED as `inherited` holds them, then
 * AGM_RUNS=task and the folders and the port from serve's arguments. The one place launch.js reads its environment.
 */
function taskEnv(a, inherited = process.env) {
  const env = {};
  for (const name of TASK_PASSED) if (typeof inherited[name] === 'string' && inherited[name]) env[name] = inherited[name];
  return Object.assign(env, {
    AGM_RUNS: 'task',
    AGM_DATA_DIR: a.folders.data, AGM_UPLOAD_DIR: a.folders.uploads, AGM_KEY_DIR: a.folders.keys,
    AGM_LOG_DIR: a.folders.logs, AGM_TOKEN_DIR: a.folders.token, PORT: String(a.port),
  });
}

/**
 * serve: the server task's action. It runs the watchdog (supervise.js beside this file, by its absolute path) in a process
 * of its own, in taskEnv's environment (no machine path from its own environment).
 * Resolves the exit code: the watchdog's 0, and its give-up or configuration refusal (3), end this process with 0 so the
 * task stays stopped; any other end is non-zero, which RestartOnFailure restarts. `spawn` is childProcess.spawn unless a
 * test stands in for it.
 */
function serve(a, { spawn = childProcess.spawn, supervise = path.join(__dirname, 'supervise.js'), execPath = process.execPath, inherited } = {}) {
  return new Promise((resolve) => {
    const env = taskEnv(a, inherited);
    let child;
    try { child = spawn(execPath, [supervise], { env, cwd: __dirname, stdio: 'inherit', windowsHide: true }); } catch (e) {
      process.stderr.write('  the watchdog could not be started (' + (e.code || e.message) + ')\n');
      resolve(1);
      return;
    }
    child.on('error', (e) => { process.stderr.write('  the watchdog could not be started (' + (e.code || e.message) + ')\n'); resolve(1); });
    child.on('exit', (code, signal) => {
      if (signal) { resolve(1); return; }   // the watchdog was signalled from outside: an unexpected end
      resolve(STAYS_STOPPED.has(code) ? 0 : (Number.isInteger(code) ? code : 1));
    });
  });
}

/** Runs one of the sync commands (token, status) and says its words: the exit code. serve runs through `serve`. */
function main(argv, { out = (t) => process.stdout.write(t + '\n'), ...stand } = {}) {
  const a = parse(argv);
  if (a.problem) { out(a.problem); return USAGE; }
  if (a.verb === 'serve') { out('launch.js serve is the server task\'s action (Task Scheduler runs it); it is not run from this console.'); return USAGE; }
  if (a.verb === 'status') {
    const r = statusOf({ machine: a.machine, sys: a.sys, logs: a.logs, port: a.port, ...stand });
    if (a.out) { try { fs.writeFileSync(a.out, JSON.stringify({ v: 1, ...r.facts })); } catch (e) { out('the status could not be written to ' + a.out + ' (' + (e.code || e.message) + ').'); return NOT_DONE; } }
    out(r.text);
    return r.code;
  }
  const r = showToken({ machine: a.machine, sys: a.sys, ...stand });
  out(r.text);
  return r.code;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'serve') {
    const a = parse(argv);
    if (a.problem) { process.stdout.write(a.problem + '\n'); process.exitCode = USAGE; } else serve(a).then((code) => { process.exitCode = code; });
  } else {
    process.exitCode = main(argv);
    if (process.stdin.isTTY) {
      process.stdout.write('\nPress Enter to close this window.\n');
      process.stdin.once('data', () => process.stdin.pause());
    }
  }
}

module.exports = { main, parse, serve, taskEnv, TASK_PASSED, statusOf, showToken, adminName, csvRows, DONE, NOT_DONE, USAGE };
