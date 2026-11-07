'use strict';
/**
 * The installed node's commands for the person at the PC: each item of the Start menu's AGMessage folder runs
 * `node.exe app\launch.js <verb>` in a console of its own, as the person who chose it, and never asks for an elevation.
 * It requires Node's own modules only, runs nothing but by its absolute path, and reads no machine path from its
 * environment: the installer passes each folder it needs as an argument.
 *
 *   serve --data <folder> --uploads <folder> --keys <folder> --logs <folder> --token <folder> --events <file> --port <n>
 *                              The server task's action (`\AGMessage\Server`): it runs the watchdog (supervise.js) in a
 *                              process of its own, by its absolute path beside this file, in an environment made of
 *                              Windows' own names (TASK_PASSED) and AGM_RUNS=task, the folders, the machine's events file
 *                              (AGM_MACHINE_EVENTS, which the server reads into its audit log) and the port from its
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
 *   open --machine <folder> --sys <folder>
 *                              Open AGMessage, the launcher: the port from the install record (reg.exe, 64-bit view; 3023
 *                              when it names none), and /api/health asked there once. When the AGMessage installed on this
 *                              PC answers (its health's install.runs is `task`), http://localhost:<port> is opened in the
 *                              person's browser by explorer.exe, by its absolute path in the Windows folder --sys sits in,
 *                              and the console closes. Otherwise it says what it found and stays open until Enter: a
 *                              portable copy or another program on the port, something that does not answer, or nothing
 *                              serving, with the server task's state and last result, the log's last line and what to do.
 *
 *   start --machine <folder> --sys <folder>
 *   stop --machine <folder> --sys <folder>
 *   rights --machine <folder> --sys <folder>
 *                              Start AGMessage, Stop AGMessage… and Who may run AGMessage…: the person's request, written
 *                              as request.json into <folder>\machine\inbox\<SID>\ (their own SID, read by whoami.exe;
 *                              only they may write there), then their own control task (`\AGMessage\Control-<SID>`) run
 *                              with schtasks.exe /Run; it runs as SYSTEM, does what the install record lets that account
 *                              do now, and answers into machine\outbox\<SID>\answer.json, which this waits for (by the
 *                              request's id) and says. Stop asks for a reason when AGMessage is busy and asks again with
 *                              it; Who may run lists the admin and the rights given and takes one line: "Give LAPTOP\ben:
 *                              start, stop", "Take back from LAPTOP\ben: stop" (or all), or "Hand over to LAPTOP\ben",
 *                              confirmed by typing the name again. An account with no control task, or none it may run, is
 *                              told whom to ask. Run in an administrator's elevated console, each runs machine.js control
 *                              --elevated by its absolute path beside this file instead, so an administrator can hand over
 *                              a laptop whose admin account is gone.
 *
 *   export --source <portable folder> --machine <folder> --sys <folder> [--port <n>]
 *   forget-keys --source <portable folder> --machine <folder> --sys <folder> --id <the import's id>
 *                              The portable import's two steps as the person (U14), run by the installer as the Windows
 *                              account that started it (Inno's ExecAsOriginalUser), hidden, before the installed node's
 *                              first start. export writes a bundle of the portable folder's contents (its data and uploads,
 *                              and this account's machine key, certificate and audit records: files only, never a link)
 *                              into that account's own import folder, machine\inbox\<SID>\import\, which the elevated
 *                              machine.js import reads; it refuses a copy running on the folder, a folder last run by
 *                              another build, keys that are not this account's, a key, certificate or secret the installed
 *                              node would not start on, and an audit log that does not check. Once
 *                              machine.js import has verified the copy (its verdict in machine\outbox\<SID>\import.json),
 *                              forget-keys marks the folder as moved and removes the old copies: this account's
 *                              %LOCALAPPDATA%\AGMessage and the folder's app\data\secret.key, each checked and said. Each
 *                              leaves its answer in the import folder (export.json, forget.json) for the installer.
 *
 * upgrade and back (U18) are a later unit's: until it lands their verbs are refused as unknown. A verb it does not know is
 * refused, never defaulted. Exit codes: 0 done; 2 not done, with the words of why; 64 a verb or an argument it does not
 * know, or one missing. In a console window it waits for Enter before it ends, so the window that the Start menu opened
 * stays until the person has read it; open waits only when it did not open the browser, and the import's steps never.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
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

// The verbs a later unit adds are refused as unknown until it lands (U18's upgrade and back).
const LATER = Object.freeze({ upgrade: 'U18', back: 'U18' });
/** The person's requests, each answered by their own control task. */
const REQUESTS = Object.freeze(['start', 'stop', 'rights']);
/** The portable import's two steps run as the account that started the installer, hidden: neither waits for Enter. */
const IMPORT_STEPS = Object.freeze(['export', 'forget-keys']);
/** The commands this build knows, for the words of an unknown one. */
const KNOWN = 'serve, token, status, open, start, stop, rights, export or forget-keys';

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
  if (verb === 'open') return parseOpen(rest);
  if (REQUESTS.includes(verb)) return parseOpen(rest, verb);
  if (IMPORT_STEPS.includes(verb)) return parseImport(rest, verb);
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

/** serve's command line: the five folders, the machine's events file and the port, each required, each a full path (the port a number). */
function parseServe(rest) {
  const o = options(rest, ['--data', '--uploads', '--keys', '--logs', '--token', '--events', '--port'], 'serve');
  if (o.problem) return { problem: o.problem };
  const folders = {};
  for (const [opt, key] of [['--data', 'data'], ['--uploads', 'uploads'], ['--keys', 'keys'], ['--logs', 'logs'], ['--token', 'token'], ['--events', 'events']]) {
    const v = o.got[opt];
    if (!v || !path.isAbsolute(v)) return { problem: 'launch.js serve needs ' + opt + (key === 'events' ? ' <file>' : ' <folder>') + ', a full path: the server task passes each.' };
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

/**
 * open's command line, and start's, stop's and rights': the machine folder and the System32 folder, each required, each a
 * full path (--sys from its drive).
 */
function parseOpen(rest, verb = 'open') {
  const o = options(rest, ['--machine', '--sys'], verb);
  if (o.problem) return { problem: o.problem };
  const machine = o.got['--machine'] || '';
  if (!machine || !path.isAbsolute(machine)) return { problem: 'launch.js ' + verb + ' needs --machine <folder>, the installed node\'s folder as a full path (%ProgramData%\\AGMessage).' };
  const sys = o.got['--sys'] || '';
  if (!DRIVE_PATH.test(sys)) return { problem: 'launch.js ' + verb + ' needs --sys <folder>, the System32 folder named from its drive (C:\\Windows\\System32)' + (verb === 'open' ? ': the browser is opened from the Windows folder it sits in.' : ': whoami.exe and schtasks.exe are run from it.') };
  return { verb, machine, sys };
}

/**
 * export's and forget-keys' command line: the portable folder (--source), the machine folder and the System32 folder, each
 * required, each a full path; export's --port (the installed node's, asked whether an AGMessage answers there) and
 * forget-keys' --id (the import its verdict must name), each the one its step takes.
 */
function parseImport(rest, verb) {
  const o = options(rest, ['--source', '--machine', '--sys', verb === 'export' ? '--port' : '--id'], verb);
  if (o.problem) return { problem: o.problem };
  for (const name of ['--source', '--machine']) {
    const v = o.got[name] || '';
    if (!v || !path.isAbsolute(v)) return { problem: 'launch.js ' + verb + ' needs ' + name + ' <folder>, a full path' + (name === '--source' ? ' (the portable AGMessage folder, the one that holds start-agmessage.bat).' : ' (%ProgramData%\\AGMessage).') };
  }
  const sys = o.got['--sys'] || '';
  if (!DRIVE_PATH.test(sys)) return { problem: 'launch.js ' + verb + ' needs --sys <folder>, the System32 folder named from its drive (C:\\Windows\\System32): whoami.exe is run from it.' };
  const a = { verb, source: o.got['--source'], machine: o.got['--machine'], sys };
  if (verb === 'export') {
    const port = o.got['--port'] === undefined ? 0 : Number(o.got['--port']);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { problem: 'launch.js export\'s --port is a port from 1 to 65535.' };
    return { ...a, port };
  }
  const id = o.got['--id'] || '';
  if (!/^[0-9a-f]{24}$/.test(id)) return { problem: 'launch.js forget-keys needs --id <the import\'s id>, as its export named it.' };
  return { ...a, id };
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
 * A program of the System32 folder `sys` names (the installer's {sys}), run by its absolute path from that folder with an
 * argument array, its output read: {code, out, err}, code -1 (nothing run) for a `sys` that is no drive path. `run` is
 * childProcess.execFileSync unless a test stands in for it. `env`, when given, is the whole environment it runs in.
 */
function windowsHands(sys, run = childProcess.execFileSync) {
  const exe = (name) => path.win32.join(sys, name);
  return (name, args, { timeout = 15000, env } = {}) => {
    if (!DRIVE_PATH.test(String(sys || ''))) return { code: -1, out: '', err: '' };
    try {
      return { code: 0, out: String(run(exe(name), args, { cwd: sys, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) }) || ''), err: '' };
    } catch (e) {
      return { code: Number.isInteger(e && e.status) ? e.status : 1, out: String((e && e.stdout) || ''), err: said((e && (e.stderr || e.message)) || '', 300) };
    }
  };
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
  const call = windowsHands(sys, run);
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

/** The port the installed node serves on when its record names none: AGMessage's own default. */
const DEFAULT_PORT = 3023;
/** How long Open AGMessage waits for the port's answer before it says what it found. */
const OPEN_ASK_MS = 3000;

/**
 * How the browser is opened on `url` (pure): explorer.exe by its absolute path in the Windows folder the System32 folder
 * `sys` sits in (`C:\Windows\System32` → `C:\Windows\explorer.exe`), never its bare name, with the address its one
 * argument; null where that cannot be named (not Windows, or no System32 folder from its drive), and then nothing is
 * opened. This is launch.js's own copy of the opener's call (lib/startup.js openerPlan), since it requires Node's
 * built-ins only.
 */
function openPlan({ sys, url, platform = process.platform }) {
  if (platform !== 'win32' || !DRIVE_PATH.test(String(sys || ''))) return null;
  const windows = path.win32.dirname(sys);
  return { file: path.win32.join(windows, 'explorer.exe'), args: [url], cwd: windows };
}

/**
 * Who answers /api/health on 127.0.0.1:`port`, asked once with no token: {state: 'agm', version, build, runs} when it
 * reads as AGMessage's, 'other' for another answer, 'silent' when nothing came in OPEN_ASK_MS, 'none' when nothing takes
 * the connection. The answer only chooses the words and whether the browser opens; it is never trusted with anything.
 */
function healthAt(port, { timeoutMs = OPEN_ASK_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 64 * 1024) { req.destroy(); finish({ state: 'other' }); return; } chunks.push(c); });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { j = null; /* not JSON: another program's answer */ }
        const version = j && typeof j.version === 'string' ? said(j.version, 40) : '';
        const build = j && typeof j.build === 'string' ? said(j.build, 80) : '';
        if (res.statusCode !== 200 || !version || !build) { finish({ state: 'other' }); return; }
        finish({ state: 'agm', version, build, runs: j.install && typeof j.install === 'object' && typeof j.install.runs === 'string' ? said(j.install.runs, 20) : '' });
      });
      res.on('error', () => finish({ state: 'other' }));
    });
    timer = setTimeout(() => { finish({ state: 'silent' }); req.destroy(); }, timeoutMs);
    req.on('error', (e) => finish({ state: e && e.code === 'ECONNREFUSED' ? 'none' : 'silent' }));
  });
}

/**
 * Open AGMessage: {code, text, opened}. The port from the install record (3023 when it names none), its health asked
 * once (`ask`, healthAt unless a test stands in for it); the installed node answering is opened in the person's browser
 * (openPlan's explorer.exe, `spawn` childProcess.spawn unless a test stands in for it, detached so the console may close);
 * anything else is said, with what to do, and nothing is opened. Never the token.
 */
async function openAgm({ machine, sys, run = childProcess.execFileSync, read = fs.readFileSync, ask = healthAt, spawn = childProcess.spawn, platform = process.platform } = {}) {
  const { facts } = statusOf({ machine, sys, run, read });
  const port = facts.port || DEFAULT_PORT;
  const url = 'http://localhost:' + port;
  const h = await ask(port);
  if (h.state === 'agm' && h.runs === 'task') {
    const plan = openPlan({ sys, url, platform });
    if (!plan) return { code: NOT_DONE, opened: false, text: 'AGMessage ' + h.version + ' answers at ' + url + ', but no browser could be started from here: open that address in a browser on this PC.' };
    try {
      const child = spawn(plan.file, plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.on === 'function') child.on('error', () => { /* said below as opened; the address is in the words */ });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (e) {
      return { code: NOT_DONE, opened: false, text: 'AGMessage ' + h.version + ' answers at ' + url + ', but the browser could not be started (' + said((e && (e.code || e.message)) || 'no reason given', 60) + '): open that address in a browser on this PC.' };
    }
    return { code: DONE, opened: true, text: 'Opening AGMessage ' + h.version + ' (build ' + h.build + ') at ' + url + ' in your browser.' };
  }
  const startIt = 'AGMessage starts with Windows. To start it now, restart this PC, or ask an administrator to run the task ' + SERVER_TASK + ' in Task Scheduler.';
  if (h.state === 'agm') return { code: NOT_DONE, opened: false, text: 'A portable copy of AGMessage (' + h.version + ', build ' + h.build + ') holds port ' + port + ', not the AGMessage installed on this PC: use that copy\'s own window, or press Ctrl+C there to close it; the installed AGMessage takes the port back on its next try.' };
  if (h.state === 'other') return { code: NOT_DONE, opened: false, text: 'Another program holds port ' + port + ', so the AGMessage installed on this PC cannot serve on it: close that program, and AGMessage takes the port back on its next try (AGMessage status, run as an administrator, names its process).' };
  if (h.state === 'silent') return { code: NOT_DONE, opened: false, text: 'Something on port ' + port + ' did not answer within ' + OPEN_ASK_MS / 1000 + ' s: AGMessage may be starting, or saving. Try Open AGMessage again in a moment.' };
  const lines = ['AGMessage is not serving on this PC.', '  the server task: ' + facts.task.state + (facts.task.lastResult === null ? '' : ' (last result ' + facts.task.lastResult + ')')];
  if (facts.serverLog.read === 'read' && facts.serverLog.lines.length) lines.push('  the log\'s last line: ' + facts.serverLog.lines[facts.serverLog.lines.length - 1].slice(0, 160));
  else if (facts.serverLog.read === 'refused') lines.push('  the log: refused to this account (AGMessage status, run as an administrator, reads it)');
  lines.push('', startIt);
  return { code: NOT_DONE, opened: false, text: lines.join('\n') };
}

// ---------------------------------------------------------------- the person's requests: Start, Stop, Who may run

/** An account from `whoami /user /fo csv /nh` (pure): its first row's name and SID, by position; null when there is none. */
function accountOf(text) {
  const row = csvRows(text)[0];
  if (!row || row.length < 2) return null;
  const sid = row[1].trim();
  return /^S-1-[0-9-]{1,140}$/.test(sid) ? { name: said(row[0], 120), sid } : null;
}
/**
 * Whether `whoami /groups /fo csv /nh` names an elevated administrator's token (pure): Administrators (S-1-5-32-544) and a
 * High or System integrity label, by their SID column, never Windows' localised words.
 */
function elevatedOf(text) {
  const sids = new Set(csvRows(text).map((r) => String(r[2] || '').trim()));
  return sids.has('S-1-5-32-544') && (sids.has('S-1-16-12288') || sids.has('S-1-16-16384'));
}
/** An account's control task, by its SID (machine.js controlTask's name). */
const controlTask = (sid) => '\\AGMessage\\Control-' + sid;
/** The rights AGMessage's admin gives, in the words a person types them. */
const RIGHT_WORDS = Object.freeze(['token', 'start', 'stop', 'upgrade']);
/**
 * One line typed at Who may run AGMessage… (pure): {request} for "Give LAPTOP\ben: start, stop", "Take back from
 * LAPTOP\ben: stop" (or all), "Hand over to LAPTOP\ben", any letter case; else {problem}, an unknown right too.
 */
function rightsLineOf(line) {
  const t = said(line, 300).replace(/\s+/g, ' ').trim();
  const rightsOf = (words) => {
    const list = words.toLowerCase().split(/\s*(?:,|\band\b|\s)\s*/).filter(Boolean);
    const unknown = list.find((w) => !RIGHT_WORDS.includes(w));
    if (unknown !== undefined) return { problem: '"' + unknown + '" is not a right AGMessage gives: its rights are ' + RIGHT_WORDS.join(', ') + '.' };
    if (!list.length) return { problem: 'Name the rights after the colon: ' + RIGHT_WORDS.join(', ') + '.' };
    return { rights: RIGHT_WORDS.filter((r) => list.includes(r)) };
  };
  let m = /^give (.+?)\s*:\s*(.*)$/i.exec(t);
  if (m) { const r = rightsOf(m[2]); return r.problem ? r : { request: { verb: 'grant', account: m[1].trim(), rights: r.rights } }; }
  m = /^take back from (.+?)\s*:\s*(.*)$/i.exec(t);
  if (m) {
    if (/^all$/i.test(m[2].trim())) return { request: { verb: 'revoke', account: m[1].trim(), rights: 'all' } };
    const r = rightsOf(m[2]);
    return r.problem ? r : { request: { verb: 'revoke', account: m[1].trim(), rights: r.rights } };
  }
  m = /^hand over to (.+)$/i.exec(t);
  if (m) return { request: { verb: 'handover', account: m[1].trim() } };
  return { problem: '"' + t.slice(0, 80) + '" is not one of the three: Give LAPTOP\\ben: start, stop · Take back from LAPTOP\\ben: stop (or all) · Hand over to LAPTOP\\ben.' };
}

/** How long each request waits for its answer: a stop may take two minutes to save, a start 35 s to answer. */
const ANSWER_WAIT_MS = Object.freeze({ start: 90_000, stop: 180_000, grant: 90_000, revoke: 90_000, handover: 90_000 });
const ANSWER_POLL_MS = 250;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One request of the person's, answered: {code, text, answer}. Who asks is read by whoami.exe (their SID). Not elevated,
 * the request is written into their inbox\ and their own control task run (schtasks.exe /Run), and its answer waited for
 * in their outbox\ by the request's id; a request that cannot be left there, or a control task this account cannot run,
 * is told whom to ask. Elevated (an administrator's console), machine.js control --elevated is run by its absolute path
 * beside this file, with the request a file of machine\work\. `run`, `read`, `write` and `remove` stand in for Node's own
 * unless a test gives its own; `script` is machine.js.
 */
async function sendRequest({ machine, sys, request, run = childProcess.execFileSync, read = fs.readFileSync, write = fs.writeFileSync, remove = fs.rmSync, script = path.join(__dirname, 'machine.js'), execPath = process.execPath, waitMs = 0, pollMs = ANSWER_POLL_MS }) {
  const call = windowsHands(sys, run);
  const me = accountOf(call('whoami.exe', ['/user', '/fo', 'csv', '/nh']).out);
  if (!me) return { code: NOT_DONE, text: 'Your Windows account could not be read (whoami.exe), so nothing was asked.' };
  const id = crypto.randomBytes(12).toString('hex');
  const body = JSON.stringify({ id, ...request });
  const work = path.join(machine, 'machine', 'work');
  if (elevatedOf(call('whoami.exe', ['/groups', '/fo', 'csv', '/nh']).out)) {
    const file = path.join(work, 'request-' + id + '.json');
    const out = path.join(work, 'answer-' + id + '.json');
    try { write(file, body, { flag: 'wx' }); } catch (e) { return { code: NOT_DONE, text: 'The request could not be written into ' + work + ' (' + ((e && e.code) || 'EIO') + '), so nothing was asked.' }; }
    try { run(execPath, [script, 'control', '--elevated', '--request', file, '--machine', machine, '--sys', sys, '--out', out], { cwd: path.dirname(script), encoding: 'utf8', windowsHide: true, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* its exit code is in its answer, read below */ }
    let answer;
    try { answer = JSON.parse(String(read(out, 'utf8'))); } catch { answer = null; /* no answer: said below */ }
    try { remove(out, { force: true }); } catch { /* machine\work\'s, which only administrators read */ }
    if (!answer || typeof answer.words !== 'string') return { code: NOT_DONE, text: 'machine.js control gave no answer, so what was done is not known: AGMessage status says what runs.' };
    return { code: answer.code === 0 ? DONE : NOT_DONE, text: 'As an administrator: ' + said(answer.words, 600), answer };
  }
  const ask = (who) => 'You have no AGMessage rights on this PC. Ask ' + (who || 'this PC\'s AGMessage admin') + ', or an administrator.';
  const inbox = path.join(machine, 'machine', 'inbox', me.sid, 'request.json');
  const outbox = path.join(machine, 'machine', 'outbox', me.sid, 'answer.json');
  try { write(inbox, body); } catch (e) {
    const code = (e && e.code) || 'EIO';
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return { code: NOT_DONE, text: ask(adminName({ sys, run, platform: 'win32' })) };
    return { code: NOT_DONE, text: 'Your request could not be written (' + code + '): try again in a moment.' };
  }
  const ran = call('schtasks.exe', ['/Run', '/TN', controlTask(me.sid)]);
  if (ran.code !== 0) return { code: NOT_DONE, text: ask(adminName({ sys, run, platform: 'win32' })) + (ran.code > 0 && ran.err ? ' (Windows: ' + ran.err.slice(0, 160) + ')' : '') };
  const until = Date.now() + (waitMs || ANSWER_WAIT_MS[request.verb] || 90_000);
  for (;;) {
    let answer;
    try { answer = JSON.parse(String(read(outbox, 'utf8'))); } catch { answer = null; /* not there yet, or being replaced */ }
    if (answer && answer.id === id && typeof answer.words === 'string') return { code: answer.code === 0 ? DONE : NOT_DONE, text: said(answer.words, 600), answer };
    if (Date.now() >= until) return { code: NOT_DONE, text: 'No answer from AGMessage\'s control task within ' + Math.round((waitMs || ANSWER_WAIT_MS[request.verb] || 90_000) / 1000) + ' s: it may still be working. AGMessage status says what runs.' };
    await wait(pollMs);
  }
}

/** A line the person types (readline on this console), or '' at the input's end. */
function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let done = false;
    const finish = (v) => { if (!done) { done = true; rl.close(); resolve(v); } };
    rl.once('line', (l) => finish(String(l)));
    rl.once('close', () => finish(''));
    process.stdout.write(question);
  });
}

/** Start AGMessage: {code, text}. */
function startAgm({ out = () => {}, ...stand }) {
  out('Asking AGMessage\'s control task to start AGMessage…');
  return sendRequest({ ...stand, request: { verb: 'start' } });
}
/**
 * Stop AGMessage…: {code, text}. A busy AGMessage is stopped only with a reason the person types ("Not stopped:
 * AGMessage is busy (…). Type a reason to stop it anyway."), asked with it again; Enter alone leaves it running.
 */
async function stopAgm({ out = () => {}, prompt = promptLine, ...stand }) {
  out('Asking AGMessage\'s control task to stop AGMessage (it saves first)…');
  const r = await sendRequest({ ...stand, request: { verb: 'stop' } });
  if (!(r.answer && r.answer.busy === true && r.answer.forceable === true)) return r;
  out(r.text);
  const force = said(await prompt('Reason (Enter leaves it running): '), 200);
  if (!force) return { code: NOT_DONE, text: 'Left running: no reason was typed.' };
  return sendRequest({ ...stand, request: { verb: 'stop', force } });
}

/** The fixed script that names SIDs (AGM_SIDS, comma-separated) as Windows does now: one line of ASCII JSON. */
const PS_NAMES = String.raw`$ErrorActionPreference = 'Stop'; Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'); $o = @{}; foreach ($x in @(([string]$env:AGM_SIDS) -split ',')) { if ($x -match '^S-1-[0-9-]+$') { try { $o[$x] = [string](New-Object System.Security.Principal.SecurityIdentifier($x)).Translate([System.Security.Principal.NTAccount]).Value } catch { $o[$x] = '' } } }; $j = ConvertTo-Json -InputObject $o -Compress; (-join @(foreach ($c in $j.ToCharArray()) { if ([int]$c -gt 126) { '\u{0:x4}' -f [int]$c } else { [string]$c } }))`;
/**
 * Who may run AGMessage on this PC, as the install record says now (pure but for its reads): {admin, adminName, grants:
 * [{sid, name, rights}]}. The record by reg.exe; the names by powershell.exe (by its absolute path, Windows' own module
 * folder and folders made from `sys`), each '' where Windows names none.
 */
function whoMayRun({ sys, run = childProcess.execFileSync }) {
  const call = windowsHands(sys, run);
  const values = (text, pattern) => { const o = {}; for (const line of String(text).split(/\r?\n/)) { const m = pattern.exec(line); if (m) o[m[1]] = said(m[2], 120); } return o; };
  const record = values(call('reg.exe', ['query', HKLM, '/reg:64']).out, /^ {4}([A-Za-z]{1,40}) {4}REG_[A-Z_]{2,20} {4}(.*)$/);
  const given = values(call('reg.exe', ['query', HKLM + '\\Grants', '/reg:64']).out, /^ {4}(S-1-[0-9-]{1,120}) {4}REG_SZ {4}(.*)$/);
  const sids = Object.keys(given);
  let names = {};
  if (sids.length) {
    const root = path.win32.dirname(sys);
    const r = call('WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', PS_NAMES],
      { env: { SystemRoot: root, windir: root, SystemDrive: root.slice(0, 2), PSModulePath: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules'), AGM_SIDS: sids.join(',') } });
    try { names = JSON.parse(r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop() || '{}'); } catch { names = {}; /* the SIDs are said instead */ }
  }
  return {
    admin: record.Admin || '', adminName: record.AdminName || '',
    grants: sids.map((sid) => ({ sid, name: typeof names[sid] === 'string' ? said(names[sid], 120) : '', rights: RIGHT_WORDS.filter((r) => given[sid].toLowerCase().split(',').map((w) => w.trim()).includes(r)) })),
  };
}
/** The list Who may run AGMessage… shows (pure). */
function whoMayRunWords(w) {
  const lines = ['Who may run AGMessage on this PC:', '  ' + (w.adminName || w.admin || 'no admin recorded') + ': this PC\'s AGMessage admin, with every right (' + RIGHT_WORDS.join(', ') + ') and the giving of them'];
  for (const g of w.grants) lines.push('  ' + (g.name || g.sid + ' (an account Windows does not name now)') + ': ' + (g.rights.join(', ') || 'none'));
  if (!w.grants.length) lines.push('  nobody else has a right here');
  lines.push('', 'Type one line, or press Enter to close:', '  Give LAPTOP\\ben: start, stop', '  Take back from LAPTOP\\ben: stop      (or: all)', '  Hand over to LAPTOP\\ben', 'Rights: token (reads the admin token), start, stop, upgrade. Each is for one person\'s account.');
  return lines.join('\n');
}
/**
 * Who may run AGMessage…: {code, text}. The list, then one line typed (rightsLineOf); a handover confirmed by typing the
 * new admin's name again. What the line asks is the control task's to decide: only the laptop's admin's (or an
 * administrator's elevated console) is done.
 */
async function rightsAgm({ out = () => {}, prompt = promptLine, who = whoMayRun, ...stand }) {
  out(whoMayRunWords(who({ sys: stand.sys, run: stand.run })));
  const line = await prompt('> ');
  if (!line.trim()) return { code: DONE, text: 'Nothing was changed.' };
  const p = rightsLineOf(line);
  if (p.problem) return { code: NOT_DONE, text: p.problem + ' Nothing was changed.' };
  const request = p.request;
  if (request.verb === 'handover') {
    request.confirm = said(await prompt('Type ' + request.account + ' again to hand AGMessage\'s admin on this PC over to it (you keep no right unless it gives one back): '), 120);
  }
  out('Asking AGMessage\'s control task…');
  return sendRequest({ ...stand, request });
}

// ---------------------------------------------------------------- the portable import: the export, and the keys' removal

/** The import's folder in an account's own inbox (machine.js import --step stage makes it): it may add files there, never a folder. */
const importDirOf = (machine, sid) => path.join(machine, 'machine', 'inbox', sid, 'import');
/** The import's verdict, written by the elevated import into the account's own outbox, which it may read. */
const verdictOf = (machine, sid) => path.join(machine, 'machine', 'outbox', sid, 'import.json');
const MANIFEST = 'manifest.json';
const EXPORT_SAID = 'export.json';
const FORGET_SAID = 'forget.json';
/** A part of the bundle by its place in the manifest: its name is the bundle's own, never a source file's. */
const partOf = (i) => String(i).padStart(7, '0') + '.part';
/** The most files a bundle carries, and the room AGMessage keeps beside it on the machine folder's disk. */
const BUNDLE_FILES_MAX = 500000;
const BUNDLE_RESERVE = 1024 ** 3;
const COPY_CHUNK = 1024 * 1024;
/** A path inside a carried folder: names a folder may hold, '/' between them, none '.' or '..', REL_MAX at most (pure). */
const REL_MAX = 240;
const REL_NAME = /^[^\\/:*?"<>|\p{Cc}]{1,200}$/u;
function relOk(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > REL_MAX) return false;
  return rel.split('/').every((n) => REL_NAME.test(n) && n !== '.' && n !== '..');
}
/** What a portable data folder holds that the import leaves: its copies, its console, its watchdog's own, an import's mark. */
const DATA_LEFT = new Set(['backups', 'logs', 'watchdog.json', 'watchdog.seen.json', 'watchdog.log', 'moved.json']);
/** What a portable key folder holds that the import carries (answer 42): the machine key, the certificate, the audit records. */
const KEYS_CARRIED = Object.freeze(['machine.key', 'tls.json', 'audit']);
/**
 * Whether the import carries a file, by its place (`data`, `uploads` or `keys`) and its path inside it (pure): never a
 * temporary file or one a save left part way; of the data folder, all but DATA_LEFT; of the key folder, KEYS_CARRIED.
 */
function carried(area, rel) {
  const parts = String(rel).split('/');
  if (/\.tmp$/i.test(parts[parts.length - 1]) || parts.some((p) => p.startsWith('.partial-'))) return false;
  if (area === 'data') return !DATA_LEFT.has(parts[0]);
  if (area === 'keys') return parts.length === 1 ? parts[0] === 'machine.key' || parts[0] === 'tls.json' : parts[0] === 'audit';
  return area === 'uploads';
}
/** A portable folder's own places (pure): its data and uploads folders and its start file, as start-agmessage.bat runs it. */
function portableOf(source) {
  return { data: path.join(source, 'app', 'data'), uploads: path.join(source, 'app', 'uploads'), bat: path.join(source, 'start-agmessage.bat') };
}
/**
 * The key folder a portable copy run by this Windows account keeps (pure but for its defaults): %LOCALAPPDATA%\AGMessage,
 * as lib/secretbox.js keyDir names it, on Windows; ~/.agmessage elsewhere. The account's own profile, read where its
 * portable copy reads it: no machine path is.
 */
function profileKeys({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string' && DRIVE_PATH.test(env.LOCALAPPDATA)) return path.win32.join(env.LOCALAPPDATA, 'AGMessage');
  return path.join(home, '.agmessage');
}
/** Whether `a` is `b` or inside it, as the platform compares folders (pure). */
function within(a, b, platform = process.platform) {
  const norm = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y + path.sep);
}

/**
 * Why the import refuses a portable folder, from its facts (lib/importfacts.js, read as this account), in words, or '' (pure):
 * a copy running on it (with what its busy line says), an import's mark on it, a folder last run by another build (U6's
 * format.json), keys that are not in this account's profile (another Windows account's, or none, while the folder holds
 * what a key sealed), a machine key, certificate or server secret the installed node would not start on (what its own start
 * refuses: server.js taskKeysProblem), and an audit log that does not check. `profile` is the key folder its facts were read
 * with.
 */
function exportRefusal(f, { source, profile }) {
  if (!f || typeof f !== 'object' || !f.format || !f.key || !f.sealed || !f.cert || !f.chain) return 'The portable folder\'s facts could not be read.';
  if (f.held) return 'The portable AGMessage in ' + source + ' is running' + (f.busy ? ' (it says it is ' + said(f.busy, 200) + ')' : '') + ': press Ctrl+C in its window, then import again.';
  if (f.moved === 'moved') return 'This folder\'s AGMessage was imported already (app\\data\\moved.json): its halls are in the AGMessage installed on this PC.';
  if (f.moved !== 'none') return 'This folder\'s import mark (app\\data\\moved.json) could not be read, so whether it was imported already cannot be told.';
  if (f.format.state !== 'read' || !f.format.build || f.format.build !== f.build || f.format.format !== f.format.current) {
    const last = f.format.state === 'read' ? (f.format.build ? 'AGMessage ' + f.format.build + (f.format.build === f.build ? ' in format ' + f.format.format + ', which this build does not write' : '') : 'a build its format marker does not name')
      : f.format.state === 'none' ? 'AGMessage 0.5 or earlier, or by none (app\\data holds no format.json)' : 'a build its format marker does not say (it could not be read)';
    return 'This folder was last run by ' + last + ', and this AGMessage is ' + f.build + ': the import takes only a folder last run by this same build. Upgrade the portable folder to this build (README.txt, Upgrading), start it once and stop it, then import again.';
  }
  const keyed = f.sealed.total > 0 || !!f.chain.newestKid || f.cert.state !== 'absent';
  const another = 'This folder\'s keys are another Windows account\'s: install from that account.';
  if (keyed && f.key.state === 'absent') return another + ' (No machine key is in this account\'s profile, ' + profile + ', and the folder holds what one sealed.)';
  // A key, certificate or secret the installed node's own start refuses is never carried: it would not start on it.
  const never = (can) => ', and the installed AGMessage never starts on one it cannot ' + can + '.';
  if (f.key.state !== 'absent' && f.key.state !== 'key') {
    return 'The machine key in this account\'s profile (' + path.join(profile, 'machine.key') + ') ' + (f.key.code === 'EBADKEY' ? 'is not a key AGMessage made' : 'could not be read (' + (f.key.code || 'not a key') + ')') + never('read')
      + (keyed ? ' The folder\'s sealed values cannot be carried without it: put back the copy it had, then import again.' : ' Nothing in the folder was sealed with it: move it aside, then import again.');
  }
  if (f.sealed.open < f.sealed.total) return another + ' (' + (f.sealed.total - f.sealed.open) + ' of ' + f.sealed.total + ' sealed values do not open with the machine key in ' + profile + ': ' + f.sealed.shut.join(', ') + '.)';
  if (f.chain.newestKid && f.chain.newestKid !== f.key.kid) return another + ' (Its audit log is keyed with another machine key than the one in ' + profile + '.)';
  if (f.cert.state !== 'absent' && f.cert.state !== 'ok' && f.cert.state !== 'renew') {
    return 'The certificate in this account\'s profile (' + path.join(profile, 'tls.json') + ') cannot be used (' + (f.cert.code || f.cert.state) + ')' + never('use') + ' Put back the copy it had; or move it aside, and the installed AGMessage makes a new one, which every device is asked to trust again. Then import again.';
  }
  if (f.secret !== 'read' && f.secret !== 'absent') {
    return 'The folder\'s server secret (app\\data\\secret.key) could not be read or holds no server secret' + never('read') + ' Put back the copy it had; or move it aside, and the guests\' and invite links made with it no longer hold. Then import again.';
  }
  if (!f.chain.done || f.chain.mark === 'broken') return 'The portable folder\'s audit log does not check (' + said(f.chain.words, 300) + '). Start the portable copy, see Admin → Health, accept what it found there if it is yours to accept, stop it, then import again.';
  return '';
}

/**
 * The facts of a data folder and its key folder (pure but for its child): lib/importfacts.js beside this file, run by this
 * node.exe as a process of its own (`runFile`, childProcess.execFileSync unless a test stands in for it), its one line of JSON
 * read: {facts} or {error}.
 */
function factsAt({ data, keys, runFile = childProcess.execFileSync, script = path.join(__dirname, 'lib', 'importfacts.js') }) {
  let out;
  try {
    out = String(runFile(process.execPath, [script, '--data', data, '--keys', keys], { cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '');
  } catch (e) { out = String((e && e.stdout) || ''); if (!out.trim()) return { error: said((e && (e.code || e.message)) || 'no answer', 160) }; }
  let j;
  try { j = JSON.parse(out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || ''); } catch { return { error: 'its answer is not whole' }; }
  if (j && j.facts && typeof j.facts === 'object') return { facts: j.facts };
  return { error: said((j && j.error) || 'no facts in its answer', 200) };
}

/** Whether a folder of a place may hold a file the import carries (pure): a folder that may not is never walked. */
const holds = (area, rel) => carried(area, rel + '/f');
/** Whether two stats name one file, by its device and its file id read whole (`{bigint: true}`: an NTFS id past 2^53 is not a Number). */
const sameFile = (a, b) => BigInt(a.ino) === BigInt(b.ino) && BigInt(a.dev) === BigInt(b.dev);

/**
 * The files of one place of a source the import carries, by lstat, none followed: {files: [{area, rel, abs, size, ino,
 * dev}]}; {link} naming the first link, junction, or anything that is neither a file nor a folder, met anywhere in what it
 * carries (an import carries files, never what a link names); or {over} once more than `max` files are seen, the walk
 * stopped there. `only` names the top-level entries walked (the key folder's); a folder that holds nothing the import
 * carries (a data folder's backups and logs) is never walked; a place not there carries nothing.
 */
function filesOf(area, root, { only = null, fsImpl = fs, max = BUNDLE_FILES_MAX } = {}) {
  const files = [];
  let link = '';
  let over = false;
  const look = (p) => { try { return fsImpl.lstatSync(p, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const walk = (abs, rel) => {
    for (const name of fsImpl.readdirSync(abs).sort()) {
      if (link || over) return;
      if (only && !rel && !only.includes(name)) continue;
      const r = rel ? rel + '/' + name : name;
      const p = path.join(abs, name);
      const st = look(p);
      if (!st) continue;
      if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) { link = p; return; }
      if (st.isDirectory()) { if (holds(area, r)) walk(p, r); continue; }
      if (!carried(area, r)) continue;
      if (files.length >= max) { over = true; return; }
      files.push({ area, rel: r, abs: p, size: Number(st.size), ino: st.ino, dev: st.dev });
    }
  };
  const st = look(root);
  if (!st) return { files };
  if (st.isSymbolicLink() || !st.isDirectory()) return { link: root };
  walk(root, '');
  return link ? { link } : over ? { over: true } : { files };
}

/** A file's bytes copied into a new file (never over one), each through its own handle: {size, sha256}. Contents only. */
function copyBytes(fsImpl, from, to, seen) {
  const hash = crypto.createHash('sha256');
  // Opened without following a link, and the file read is the file the walk saw: one swapped for a link or another file
  // between the two is refused, never copied.
  const src = fsImpl.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let dst = null;
  let size = 0;
  try {
    const ft = fsImpl.fstatSync(src, { bigint: true });
    if (!ft.isFile() || (seen && !sameFile(ft, seen))) throw Object.assign(new Error(from + ' changed between its look and its read'), { code: 'ECHANGED' });
    dst = fsImpl.openSync(to, 'wx');
    const buf = Buffer.alloc(COPY_CHUNK);
    for (;;) {
      const n = fsImpl.readSync(src, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      for (let off = 0; off < n;) off += fsImpl.writeSync(dst, buf, off, n - off);
      size += n;
    }
  } finally {
    fsImpl.closeSync(src);
    if (dst !== null) fsImpl.closeSync(dst);
  }
  return { size, sha256: hash.digest('hex') };
}
/**
 * The portable folder chosen and its app\ folder, each a real folder and never a link or junction (pure but for lstat):
 * the path of the first that is a link, or ''. One not there is said by what reads it next.
 */
function linkedSource(fsImpl, at) {
  const linkAt = (p) => { try { return fsImpl.lstatSync(p).isSymbolicLink(); } catch { return false; /* not there: said by the data folder's own look */ } };
  for (const p of [at, path.join(at, 'app')]) if (linkAt(p)) return p;
  return '';
}
const MBs = (n) => (n < 1024 * 1024 ? Math.ceil(n / 1024) + ' KB' : Math.ceil(n / (1024 * 1024)) + ' MB');

/**
 * Export, the portable import's first step (U14): run as the Windows account that started the installer (Inno's
 * ExecAsOriginalUser), never elevated, it writes a bundle of the portable folder's contents into that account's own
 * import folder (machine\inbox\<SID>\import\, made by machine.js import --step stage): the data folder, the uploads, and
 * the machine key, certificate and audit records from this account's profile, each file's bytes as a part, then the
 * manifest naming each part's place, size and SHA-256 with the source's facts. Refused, with nothing exported: a folder
 * that is not a portable AGMessage's, or this PC's installed one; an AGMessage answering on the installed node's port; a
 * copy running on the folder (with what its busy line says); an import's mark on it; a folder last run by another build;
 * keys that are not this account's; a machine key, certificate or server secret the installed node would not start on; an
 * audit log that does not check; the folder or its app\ a link or junction, or one anywhere in what it carries; more files
 * than a bundle carries (the walk stopped there); a disk short of the room. Its answer is export.json beside the bundle,
 * which the installer reads: {code, text, id}. A bundle left part way is cleared by machine.js import (take, or clear).
 */
async function exportPortable({ source, machine, sys, port = 0, run = childProcess.execFileSync, fsImpl = fs, facts = factsAt, profile = profileKeys(), ask = healthAt }) {
  const me = accountOf(windowsHands(sys, run)('whoami.exe', ['/user', '/fo', 'csv', '/nh']).out);
  if (!me) return { code: NOT_DONE, text: 'Your Windows account could not be read (whoami.exe), so nothing was exported.' };
  const dir = importDirOf(machine, me.sid);
  const id = crypto.randomBytes(12).toString('hex');
  // The account may add files to its import folder and write them, and nothing more (it may not even read the folder's
  // attributes): its first answer, that the export did not finish, is what tells whether the folder was made ready for it,
  // and stays as its answer should the export stop part way.
  try { fsImpl.writeFileSync(path.join(dir, EXPORT_SAID), JSON.stringify({ v: 1, id, code: NOT_DONE, words: 'The export did not finish: nothing was exported.' })); } catch (e) {
    return { code: NOT_DONE, text: 'The import was not made ready for ' + me.name + ' on this PC (' + dir + ': ' + ((e && e.code) || 'EIO') + '): it is run from AGMessage\'s installer, as the Windows account that started it.' };
  }
  const answer = (code, text, more = {}) => {
    try { fsImpl.writeFileSync(path.join(dir, EXPORT_SAID), JSON.stringify({ v: 1, id, code, words: text, ...more })); } catch (e) {
      return { code: NOT_DONE, text: text + ' (Its answer could not be left for the installer: ' + ((e && e.code) || 'EIO') + '.)' };
    }
    return { code, text, id, ...more };
  };
  const refuse = (text) => answer(NOT_DONE, text + ' Nothing was exported.');
  const at = path.resolve(source);
  const own = portableOf(at);
  const linked = linkedSource(fsImpl, at);
  if (linked) return refuse(linked + ' is a link or a junction: an import reads the portable folder itself, never what a link names. Choose the folder it names.');
  let data;
  try { data = fsImpl.lstatSync(own.data); } catch { data = null; /* none: said below */ }
  if (!data || !data.isDirectory() || data.isSymbolicLink()) return refuse(at + ' holds no portable AGMessage\'s data (app\\data): choose the folder that holds start-agmessage.bat.');
  if (within(at, machine) || within(machine, at) || within(at, path.dirname(__dirname)) || within(path.dirname(__dirname), at)) return refuse(at + ' is the AGMessage installed on this PC, not a portable folder.');
  if (port) {
    const h = await ask(port);
    if (h.state === 'agm') return refuse('AGMessage ' + h.version + ' answers on port ' + port + ': a portable copy is still running. Press Ctrl+C in its window, then import again.');
    if (h.state === 'silent') return refuse('Something on port ' + port + ' did not answer within ' + OPEN_ASK_MS / 1000 + ' s: a portable copy may still be saving. Wait until its window says it stopped, then import again.');
  }
  const read = facts({ data: own.data, keys: profile });
  if (read.error) return refuse('The portable folder could not be read (' + read.error + ').');
  const why = exportRefusal(read.facts, { source: at, profile });
  if (why) return refuse(why);
  const files = [];
  for (const [area, root, only] of [['data', own.data, null], ['uploads', own.uploads, null], ['keys', profile, KEYS_CARRIED]]) {
    let r;
    try { r = filesOf(area, root, { only, fsImpl, max: BUNDLE_FILES_MAX - files.length }); } catch (e) { return refuse(root + ' could not be read (' + ((e && e.code) || 'EIO') + ').'); }
    if (r.link) return refuse(r.link + ' is a link or a junction: an import carries files, never what a link names.');
    if (r.over) return refuse('The portable folder holds more than the ' + BUNDLE_FILES_MAX + ' files an import carries.');
    files.push(...r.files);
  }
  const odd = files.find((x) => !relOk(x.rel));
  if (odd) return refuse(odd.abs + ' has a name an import does not carry.');
  const bytes = files.reduce((n, x) => n + x.size, 0);
  let free;
  try { const s = fsImpl.statfsSync(dir); free = s.bavail * s.bsize; } catch { free = null; /* not read: the copy says when the disk is full */ }
  if (free !== null && free < bytes + BUNDLE_RESERVE) return refuse('The disk of ' + machine + ' has ' + MBs(free) + ' free; the import takes ' + MBs(bytes) + ' there and AGMessage keeps ' + MBs(BUNDLE_RESERVE) + ' beside it: free some space, then import again.');
  const rows = [];
  for (const [i, x] of files.entries()) {
    try { rows.push({ area: x.area, rel: x.rel, ...copyBytes(fsImpl, x.abs, path.join(dir, partOf(i)), x) }); } catch (e) { return refuse(x.abs + ' could not be copied into the bundle (' + ((e && e.code) || 'EIO') + ').'); }
  }
  const manifest = { v: 1, id, sid: me.sid, at: Date.now(), source: at, build: read.facts.build, facts: read.facts, files: rows };
  try { fsImpl.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest), { flag: 'wx' }); } catch (e) { return refuse('The bundle\'s manifest could not be written (' + ((e && e.code) || 'EIO') + ').'); }
  const f = read.facts;
  const n = (count, one) => count + ' ' + one + (count === 1 ? '' : 's');
  return answer(DONE, 'The portable folder is exported for the import: ' + n(rows.length, 'file') + ' (' + MBs(bytes) + '), with ' + n(f.halls, 'hall') + ', ' + n(f.messages, 'message') + ', ' + n(f.accounts, 'account') + ' and ' + n(f.screens, 'screen') + '.');
}

/**
 * The start file a portable folder's import leaves in its place (pure): it names the AGMessage installed on this PC and
 * the day, and starts nothing. Every word is its own or a build's characters, so cmd reads nothing it would run.
 */
function movedBat({ build, at }) {
  const b = String(build || '').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 80) || 'its build';
  const day = new Date(at).toISOString().slice(0, 10);
  return ['@echo off', 'title AGMessage', 'echo.', 'echo   This AGMessage folder was moved into the AGMessage installed on this PC', 'echo   (build ' + b + ') on ' + day + '. Its halls, accounts and keys are there now,',
    'echo   and this copy no longer starts.', 'echo.', 'echo   Open it from Start ^> AGMessage ^> Open AGMessage.', 'echo   The start file this folder had is kept beside this one: start-agmessage.bat.moved',
    'echo.', 'pause', 'exit /b 3', ''].join('\r\n');
}
/** A file or folder removed and looked for again: {ok, path, why?, was}: `was` false when there was none to remove. */
function removeChecked(fsImpl, p, folder) {
  let was = true;
  try { fsImpl.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') was = false; }
  if (!was) return { ok: true, path: p, was };
  try { fsImpl.rmSync(p, { recursive: folder, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { return { ok: false, path: p, was, why: (e && e.code) || 'EIO' }; }
  try { fsImpl.lstatSync(p); return { ok: false, path: p, was, why: 'still there' }; } catch (e) { return e.code === 'ENOENT' ? { ok: true, path: p, was } : { ok: false, path: p, was, why: e.code || 'EIO' }; }
}

/**
 * Forget the keys, the portable import's last step (answer 42): run as the account that started the installer, once the
 * elevated import has verified what it copied. Only a verdict of the import's own (machine\outbox\<SID>\import.json, which
 * only SYSTEM and Administrators write) that names this import (`id`) and this folder, and says verified, lets it do
 * anything; nor does it reach through a link (the folder or its app\ a link or junction); otherwise nothing is removed.
 * Then the source is marked (app\data\moved.json, and its start file replaced by one naming the installed AGMessage, the
 * original kept as start-agmessage.bat.moved), and the old copies removed, each checked and said: this account's
 * %LOCALAPPDATA%\AGMessage (the machine key, the certificate, the audit records) and the folder's app\data\secret.key.
 * One that fails names its path; a mark that was not made says the folder may still start, and is not done either. Its
 * answer is forget.json in the import folder.
 */
function forgetKeys({ source, machine, sys, id, run = childProcess.execFileSync, fsImpl = fs, profile = profileKeys(), now = Date.now }) {
  const me = accountOf(windowsHands(sys, run)('whoami.exe', ['/user', '/fo', 'csv', '/nh']).out);
  if (!me) return { code: NOT_DONE, text: 'Your Windows account could not be read (whoami.exe), so nothing was removed.' };
  const at = path.resolve(source);
  const answerFile = path.join(importDirOf(machine, me.sid), FORGET_SAID);
  const answer = (code, text, more) => {
    try { fsImpl.writeFileSync(answerFile, JSON.stringify({ v: 1, id, code, words: text, ...more })); } catch { /* the import's last step says no answer came */ }
    return { code, text, ...more };
  };
  let verdict = null;
  try { const st = fsImpl.lstatSync(verdictOf(machine, me.sid)); if (st.isFile() && st.size <= 1024 * 1024) verdict = JSON.parse(String(fsImpl.readFileSync(verdictOf(machine, me.sid), 'utf8'))); } catch { verdict = null; /* none: nothing was verified */ }
  if (!verdict || verdict.verified !== true || verdict.id !== id || typeof verdict.source !== 'string' || !within(verdict.source, at) || !within(at, verdict.source)) {
    return answer(NOT_DONE, 'No import of ' + at + ' into this PC\'s AGMessage was verified, so nothing was removed: the keys stay where they are.', { verified: false });
  }
  const linked = linkedSource(fsImpl, at);
  if (linked) return answer(NOT_DONE, linked + ' is a link or a junction now, so nothing was removed: the keys stay where they are. Remove %LOCALAPPDATA%\\AGMessage and the folder\'s app\\data\\secret.key yourself, and never start that folder again.', { verified: true, moved: false });
  const own = portableOf(at);
  const t = now();
  // The mark first: the installed node serves these halls now, so this folder never starts them again.
  let moved;
  try {
    const tmp = path.join(own.data, 'moved.json.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    fsImpl.writeFileSync(tmp, JSON.stringify({ v: 1, at: t, build: said(verdict.build || '', 80), to: 'the AGMessage installed on this PC' }), { flag: 'wx' });
    fsImpl.renameSync(tmp, path.join(own.data, 'moved.json'));
    moved = { ok: true };
  } catch (e) { moved = { ok: false, path: path.join(own.data, 'moved.json'), why: (e && e.code) || 'EIO' }; }
  let bat;
  try {
    fsImpl.lstatSync(own.bat);
    try { fsImpl.lstatSync(own.bat + '.moved'); } catch { fsImpl.renameSync(own.bat, own.bat + '.moved'); }
    fsImpl.writeFileSync(own.bat, movedBat({ build: verdict.build, at: t }));
    bat = { ok: true, state: 'replaced' };
  } catch (e) { bat = e && e.code === 'ENOENT' ? { ok: true, state: 'none' } : { ok: false, state: 'failed', path: own.bat, why: (e && e.code) || 'EIO' }; }
  const keys = removeChecked(fsImpl, profile, true);
  const secret = removeChecked(fsImpl, path.join(own.data, 'secret.key'), false);
  const left = [keys, secret].filter((x) => !x.ok);
  const them = left.length === 1 ? 'it' : 'them';
  const copies = left.length
    ? 'The import is verified, but not every old copy is gone: ' + left.map((x) => x.path + ' (' + x.why + ')').join('; ') + '. Remove ' + them + ' yourself: the keys of the halls this PC\'s AGMessage now serves are in ' + them + '.'
    : 'The import is verified, so the old copies are gone: ' + (keys.was ? profile + ' (the machine key, the certificate and the audit records)' : 'this account\'s profile held no AGMessage keys') + ' and ' + (secret.was ? path.join(own.data, 'secret.key') + ' were removed' : 'the folder held no secret.key') + '.';
  // The mark and the start file, said apart: a folder not marked could start again beside the installed node, under the
  // same Show Bus id; a start file not replaced is only words, since the mark refuses its start.
  const mark = !moved.ok
    ? ' The folder is not marked as moved (' + moved.path + ': ' + moved.why + '), so it could still start, beside the installed AGMessage and with its halls: never start it again, and delete it once you no longer need it.'
    : ' ' + at + ' is marked as moved: it no longer starts' + (bat.state === 'replaced' ? ' (its start file says where AGMessage is now; the original is start-agmessage.bat.moved).'
      : bat.ok ? '.' : '. Its start file could not be replaced (' + bat.path + ': ' + bat.why + '), so starting it only says why it does not start.');
  return answer(left.length || !moved.ok ? NOT_DONE : DONE, copies + mark, { verified: true, moved: moved.ok, bat: bat.state, keys: { ok: keys.ok, was: keys.was }, secret: { ok: secret.ok, was: secret.was } });
}

/**
 * The names of the task's own environment the watchdog is handed: Windows' folders and the machine's names, which Node
 * and the programs the server runs by their absolute paths read (TMPDIR and HOME for the same off Windows). Nothing else:
 * no NODE_OPTIONS (code loaded before the server), no AGM_… the task was not given as an argument, no secret.
 */
const TASK_PASSED = Object.freeze(['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);
/**
 * The watchdog's environment under the task (pure but for its default): TASK_PASSED as `inherited` holds them, then
 * AGM_RUNS=task and the folders, the machine's events file and the port from serve's arguments. The one place launch.js
 * reads its environment.
 */
function taskEnv(a, inherited = process.env) {
  const env = {};
  for (const name of TASK_PASSED) if (typeof inherited[name] === 'string' && inherited[name]) env[name] = inherited[name];
  return Object.assign(env, {
    AGM_RUNS: 'task',
    AGM_DATA_DIR: a.folders.data, AGM_UPLOAD_DIR: a.folders.uploads, AGM_KEY_DIR: a.folders.keys,
    AGM_LOG_DIR: a.folders.logs, AGM_TOKEN_DIR: a.folders.token, AGM_MACHINE_EVENTS: a.folders.events, PORT: String(a.port),
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

/**
 * Runs one of the person's commands (token, status, open, start, stop, rights) or one of the import's steps (export,
 * forget-keys) and says its words: the exit code, or for open, export and the requests a promise of it (they ask the port,
 * or the control task). serve runs through `serve`.
 */
function main(argv, { out = (t) => process.stdout.write(t + '\n'), ...stand } = {}) {
  const a = parse(argv);
  if (a.problem) { out(a.problem); return USAGE; }
  if (a.verb === 'serve') { out('launch.js serve is the server task\'s action (Task Scheduler runs it); it is not run from this console.'); return USAGE; }
  if (a.verb === 'open') return openAgm({ machine: a.machine, sys: a.sys, ...stand }).then((r) => { out(r.text); return r.code; });
  if (a.verb === 'export') return exportPortable({ source: a.source, machine: a.machine, sys: a.sys, port: a.port, ...stand }).then((r) => { out(r.text); return r.code; });
  if (a.verb === 'forget-keys') { const r = forgetKeys({ source: a.source, machine: a.machine, sys: a.sys, id: a.id, ...stand }); out(r.text); return r.code; }
  if (REQUESTS.includes(a.verb)) {
    const act = { start: startAgm, stop: stopAgm, rights: rightsAgm }[a.verb];
    return act({ machine: a.machine, sys: a.sys, out, ...stand }).then((r) => { out(r.text); return r.code; });
  }
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
    const hold = (code) => {
      process.exitCode = code;
      // The console the Start menu opened stays until the person has read it; a browser opened needs no reading, and the
      // import's steps are the installer's hidden runs, which nobody reads there.
      if (process.stdin.isTTY && !(argv[0] === 'open' && code === DONE) && !IMPORT_STEPS.includes(argv[0])) {
        process.stdout.write('\nPress Enter to close this window.\n');
        // A request's own question (readline) may have paused the console's input: it is taken up again for the Enter.
        process.stdin.once('data', () => process.stdin.pause());
        process.stdin.resume();
      }
    };
    const code = main(argv);
    if (typeof code === 'number') hold(code); else code.then(hold);
  }
}

module.exports = {
  main, parse, serve, taskEnv, TASK_PASSED, statusOf, showToken, adminName, csvRows, openPlan, healthAt, openAgm, DEFAULT_PORT, DONE, NOT_DONE, USAGE,
  accountOf, elevatedOf, controlTask, rightsLineOf, sendRequest, startAgm, stopAgm, rightsAgm, whoMayRun, whoMayRunWords, windowsHands, PS_NAMES, RIGHT_WORDS, REQUESTS, ANSWER_WAIT_MS,
  exportPortable, forgetKeys, exportRefusal, factsAt, filesOf, carried, relOk, linkedSource, sameFile, portableOf, profileKeys, within, movedBat, copyBytes, importDirOf, verdictOf, partOf,
  MANIFEST, EXPORT_SAID, FORGET_SAID, KEYS_CARRIED, DATA_LEFT, BUNDLE_FILES_MAX, REL_MAX, IMPORT_STEPS,
};
