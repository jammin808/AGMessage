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
 * upgrade and back (U18), and the account export and key removal (U14) are later units: until each lands its verb is
 * refused as unknown. A verb it does not know is refused, never defaulted. Exit codes: 0 done; 2 not done, with the words
 * of why; 64 a verb or an argument it does not know, or one missing. In a console window it waits for Enter before it
 * ends, so the window that the Start menu opened stays until the person has read it; open waits only when it did not open
 * the browser.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
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

// The verbs later units add are refused as unknown until each lands (U18's upgrade/back, U14's account export and key
// removal); the two U14 verbs are not enumerated here, so no landing-detector word for a later unit sits in this build's
// tree (test/readings.test.js holds that).
const LATER = Object.freeze({ upgrade: 'U18', back: 'U18' });
/** The person's requests, each answered by their own control task. */
const REQUESTS = Object.freeze(['start', 'stop', 'rights']);
/** The commands this build knows, for the words of an unknown one. */
const KNOWN = 'serve, token, status, open, start, stop or rights';

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
 * Runs one of the person's commands (token, status, open, start, stop, rights) and says its words: the exit code, or for
 * open and the requests a promise of it (they ask the port, or the control task). serve runs through `serve`.
 */
function main(argv, { out = (t) => process.stdout.write(t + '\n'), ...stand } = {}) {
  const a = parse(argv);
  if (a.problem) { out(a.problem); return USAGE; }
  if (a.verb === 'serve') { out('launch.js serve is the server task\'s action (Task Scheduler runs it); it is not run from this console.'); return USAGE; }
  if (a.verb === 'open') return openAgm({ machine: a.machine, sys: a.sys, ...stand }).then((r) => { out(r.text); return r.code; });
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
      // The console the Start menu opened stays until the person has read it; a browser opened needs no reading.
      if (process.stdin.isTTY && !(argv[0] === 'open' && code === DONE)) {
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
};
