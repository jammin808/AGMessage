'use strict';
/**
 * The watchdog: runs the server as a child process and keeps it running through a meeting.
 *
 *  - The server sends a heartbeat over IPC from its event loop every second. A crash, or a hang (no beat for
 *    AGM_HANG_MS, default 10 s; the first beat may take AGM_STARTUP_MS, default 30 s), restarts it. A hang is this
 *    watchdog ticking on time with no beat: a tick of its own that comes more than AGM_LATE_MS (default 2 s) late, on its
 *    steady clock or the wall clock, means it did not run (the laptop slept, or both processes were frozen), so it
 *    judges nothing of that gap (a step of the laptop's clock forward is taken for one too). The beat clock
 *    starts again, a sleep is never counted as a crash, and "asleep from … to …" goes to its console, data/watchdog.log
 *    and server.log, and to its server, which keeps it in health and "This laptop" (lib/resilience.js BeatClock).
 *  - Waits between crash restarts: 0.5, 4, 8, 15, 30 s; a run of 5 minutes resets them. More than 6 crashes in
 *    10 minutes: it gives up, writes data/watchdog.json and a line to data/watchdog.log, and the next start shows
 *    that on the admin page.
 *  - Exit codes carry intent (lib/resilience.js EXIT): 0 stopped, 3 can't start as configured, 75 the installed node's
 *    port or data folder held by another program (tried again on the ladder, never counted as a crash), 82 restart now.
 *  - The channel (AGM_RUNS) and, for the installed node, its folders are checked before anything is written; an unknown
 *    channel, a data folder that cannot be made, or one a build of a higher format wrote (or whose format marker cannot
 *    be read, lib/dataformat.js), stops it with code 3 and the words of why, on its console alone.
 *  - The admin token is made once here and handed to every restart, so a restart doesn't change it. It is said only where
 *    a person sits: once its server serves and asks, the banner's Token line holds it on a console and never in output
 *    that is kept (a file, a log). The installed node writes it into its token folder (AGM_TOKEN_DIR), a folder of its
 *    own that this PC's AGMessage admin reads, and takes no secret (ADMIN_TOKEN, ANTHROPIC_API_KEY) from its environment.
 *  - What the console says is kept: the server's output, read through a pipe, goes on to this console line by line and
 *    into data/logs/server.log (lib/serverlog.js: bounded, rotated, never the token, no blank line), with the watchdog's
 *    own lines; the Token line goes to the console alone. A console nobody reads holds no more than CONSOLE_MAX waiting:
 *    the lines past it are in server.log alone. A server that cannot start as configured (3), or whose port or folder is
 *    held (75), has its own words, its last line on its error output, carried in the watchdog's line for it; a restart is
 *    handed the watchdog's line for the run before it (AGM_BEFORE), and the installed node, which has no window, records a
 *    start refused as configured in data/watchdog.json as it records a give-up, so the next start, from this watchdog or
 *    another, shows it. The admin page's "This laptop" shows either.
 *  - Ctrl+C, closing the window or a stop: the server is asked over IPC and saves before it goes (a signal to a child
 *    on Windows would end it unsaved). If the watchdog itself is ended: elsewhere the server sees its channel close and
 *    saves; on Windows the job libuv puts every child in ends the server with it, so no orphan is left either way.
 *
 * Rooms, history and everyone's place come back from the saved log on every restart (lib/store.js).
 */
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { SupervisorPolicy, BeatClock, asleepWords, EXIT, writeFileAtomic } = require('./lib/resilience');
const { channelOf, isFullPath, taskTokenProblem, tokenLine, TOKEN_FILE, TOKEN_HERE } = require('./lib/startup');
const { ServerLog, Lines, redact } = require('./lib/serverlog');
const dataformat = require('./lib/dataformat');
const { BUILD } = require('./lib/version');

// The server it runs: server.js beside this file, or AGM_CHILD (a test's stand-in server), by its full path only.
const CHILD = process.env.AGM_CHILD || path.join(__dirname, 'server.js');
const DATA_DIR = process.env.AGM_DATA_DIR || path.join(__dirname, 'data');
const HANG_MS = Number(process.env.AGM_HANG_MS) || 10_000;
const STARTUP_MS = Number(process.env.AGM_STARTUP_MS) || 30_000;
const LATE_MS = Number(process.env.AGM_LATE_MS) || 2000;
const TICK_MS = 500;
const policy = new SupervisorPolicy(process.env.AGM_BACKOFF ? { backoffSec: process.env.AGM_BACKOFF.split(',').map(Number) } : {});

/** This watchdog cannot run as configured: the words on its console, and code 3, which nothing restarts. */
function cannotStart(words) {
  console.error('\n  AGMessage cannot start: ' + words + '\n');
  process.exit(EXIT.CONFIG);
}
// A path the current folder or drive completes would run whatever server.js stood there in AGMessage's place.
if (!isFullPath(CHILD)) cannotStart('AGM_CHILD (' + CHILD + ') is not a full path, and AGMessage runs its server only by its full path. Remove AGM_CHILD, or name the file by its full path.');
const channel = channelOf(process.env, { programDir: path.dirname(__dirname) });
if (channel.problem) cannotStart(channel.problem);
const tokenProblem = taskTokenProblem(process.env, { programDir: path.dirname(__dirname) });
if (tokenProblem) cannotStart(tokenProblem);
// The installed node's token file, which its admin reads ('' for a portable copy, whose token is said in its window only).
const TOKEN_PATH = channel.runs === 'task' ? path.join(process.env.AGM_TOKEN_DIR, TOKEN_FILE) : '';
// A data folder a build of a higher format wrote, or whose format marker cannot be read (lib/dataformat.js), is refused
// here with its words, on the console alone, before this watchdog writes its console, its log or its record in it: that
// folder is left byte for byte as the build that wrote it left it. The server asks the same before it writes anything,
// and again once it holds the folder.
const formatRefused = dataformat.refusal(dataformat.read(DATA_DIR), { dataDir: DATA_DIR, build: BUILD.full });
if (formatRefused) cannotStart(formatRefused);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
  cannotStart('the data folder ' + DATA_DIR + ' cannot be made (' + (e.code || e.message) + '). Choose a folder this Windows account can write to (AGM_DATA_DIR), or fix that one\'s permissions.');
}
// ws's optional native helpers are never asked for in the server (server.js sets the same before its first require): a
// require app\node_modules cannot answer walks up to the drive's root, where any account may plant a module.
const env = { ...process.env, AGM_SUPERVISED: '1', AGM_TEED: '1', AGM_DATA_DIR: DATA_DIR, WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' };
if (!env.ADMIN_TOKEN) env.ADMIN_TOKEN = crypto.randomBytes(8).toString('hex');
// The console kept: every line this watchdog and its server say, but the Token line, searched for the token by value.
const serverLog = new ServerLog(path.join(DATA_DIR, 'logs', 'server.log'), {
  maxBytes: Number(process.env.AGM_LOG_MAX) || undefined,
  secrets: [env.ADMIN_TOKEN],
  onFail: (words) => console.error('  [watchdog] ' + words),
});

// A console that went away (its window closed, the pipe read by whatever started this) ends no watchdog: its lines go on
// into server.log, and the stop that follows saves as any stop does.
const consoleGone = () => { /* the console is gone: server.log keeps the lines */ };
process.stdout.on('error', consoleGone);
process.stderr.on('error', consoleGone);
// The most of this console's lines that wait for a reader (a pipe whatever started the watchdog does not drain): past it
// a line goes to server.log alone, so a console nobody reads never grows the watchdog's memory.
const CONSOLE_MAX = 1024 * 1024;
/** A line on this console (stdout or stderr, `to`), unless as much as CONSOLE_MAX already waits there for its reader. */
function say(to, text) { if (!(to.writableLength > CONSOLE_MAX)) to.write(text + '\n'); }

/**
 * A line on the console and, unless `consoleOnly` (a held try between the ones watchdog.log takes), in server.log and
 * data/watchdog.log.
 */
function log(line, consoleOnly = false) {
  const said = redact(line, [env.ADMIN_TOKEN]);
  say(process.stdout, '  [watchdog] ' + said);
  if (consoleOnly) return;
  serverLog.line('  [watchdog] ' + said);
  try { fs.appendFileSync(path.join(DATA_DIR, 'watchdog.log'), new Date().toISOString() + ' ' + said + '\n'); } catch { /* the console has it */ }
}
/**
 * How the watchdog ended, for the next start to show (`at`, `reason`; `refused` for a start refused as configured, else a
 * give-up), written whole into data/watchdog.json. The server renames it once it holds its folder, so it is shown once.
 */
function record(o) {
  const kept = { ...o, reason: redact(o.reason, [env.ADMIN_TOKEN]) };
  try { writeFileAtomic(path.join(DATA_DIR, 'watchdog.json'), JSON.stringify(kept), { makeDir: false }); } catch { /* its line above is in watchdog.log */ }
}
// While the installed node's port or folder stays held (code 75) it is tried again every step of the ladder for as long as
// it takes, 2,880 times a day at the last step: watchdog.log takes the first try of such a run and every HELD_LOG_EVERY-th
// after it, with the count, and the console takes each, so a port held for days never grows the log without bound.
const HELD_LOG_EVERY = Number(process.env.AGM_HELD_LOG_EVERY) || 100;
let heldRun = 0;   // tries in a row that found the port or folder held

let child = null;
let stopping = false;
let restarts = 0;
let before = '';   // the watchdog's line for the server's run before this start, handed to it (AGM_BEFORE)
// The judge of the server's silence, on the steady clock (performance.now(), which a change to the laptop's clock does not
// move); a tick of its own is late on that clock or the wall clock (a steady clock may stop while the laptop sleeps), and
// the wall clock says when a sleep was. Silence is judged only from a tick that came on time.
// Its ticks are taken as beginning now: the heartbeat check below is armed in this same turn of the loop.
const judge = new BeatClock({ tickMs: TICK_MS, lateMs: LATE_MS, hangMs: HANG_MS, startupMs: STARTUP_MS, at: performance.now(), wall: Date.now() });
// Sleeps said and not yet given to a server: given to the one that runs at its next beat. The newest UNTOLD_MAX are kept
// (each is in watchdog.log whatever happens to it).
const UNTOLD_MAX = 20;
const untold = [];

/**
 * One of the server's outputs read line by line, the token taken out of each before it is cut (lib/serverlog.js Lines):
 * each line goes on to this process's own (`to`) and, unless blank, into server.log, unless `take(line)` says it is not
 * one to show (false). What is left when the stream ends goes too.
 */
function tee(from, to, take) {
  from.setEncoding('utf8');
  const lines = new Lines((line) => {
    if (take(line) === false) return;
    say(to, line);
    if (line.trim()) serverLog.line(line);
  }, { secrets: [env.ADMIN_TOKEN] });
  from.on('data', (chunk) => lines.push(chunk));
  from.on('end', () => lines.end());
}

function start() {
  judge.started(performance.now());
  policy.started(Date.now());
  child = fork(CHILD, [], { env: { ...env, AGM_RESTARTS: String(restarts), AGM_BEFORE: before }, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
  const me = child;
  // The Token line is said once the server has asked for it (its channel) and its output has reached the place it goes
  // (TOKEN_HERE, after the URL line): whichever of the two this watchdog reads first, the line keeps its place.
  const token = { asked: false, here: false };
  const sayWhenBoth = () => { if (token.asked && token.here) { token.asked = false; token.here = false; sayToken(me); } };
  let reason = '';   // the server's newest line on its error output: a refusal says its reason there as it ends
  tee(me.stdout, process.stdout, (line) => {
    if (line !== TOKEN_HERE) return true;
    token.here = true;
    sayWhenBoth();
    return false;
  });
  tee(me.stderr, process.stderr, (line) => { if (line.trim()) reason = line.trim(); return true; });
  me.on('message', (m) => {
    if (m && m.t === 'beat') { if (me === child) { judge.beat(performance.now()); tell(me); } } else if (m && m.t === 'token') { token.asked = true; sayWhenBoth(); }
  });
  me.on('exit', (code, signal) => {
    if (child !== me) return;
    child = null;
    // What the server said last is read before its end is judged: its output closes just after it exits.
    afterOutput(me, () => {
      if (stopping) { process.exit(EXIT.STOP); return; }
      decide(code === null ? -1 : code, me.hung === true, signal, reason);
    });
  });
}
/** `then`, once the server's output has all been read (its pipes closed), or after 1 s if a program it started holds them. */
function afterOutput(me, then) {
  let done = false;
  const go = () => { if (!done) { done = true; then(); } };
  me.once('close', go);
  setTimeout(go, 1000);
}

/**
 * The server serves and asks for its banner's Token line: the installed node's token is written into its token folder
 * first (only now, so a copy whose port or folder is held never writes over the token of the copy that serves), whole,
 * through the atomic writer, so Show the admin token reads the old token or the new one, never a file cut short; the
 * folder is never made here (its access list is the installer's). Then the line is said on this console
 * (lib/startup.js tokenLine), and the server is told once it is written, so the line keeps its place in the banner. A
 * token file that cannot be written leaves the node serving without it, said here and in watchdog.log: guests, screens
 * and accounts need no token. The file is left when the node stops: a token nothing answers to until the next start
 * replaces it, which launch.js's words say.
 */
function sayToken(me) {
  let line = tokenLine({ tty: process.stdout.isTTY === true, runs: channel.runs, token: env.ADMIN_TOKEN, file: TOKEN_PATH });
  if (TOKEN_PATH) {
    try { writeFileAtomic(TOKEN_PATH, env.ADMIN_TOKEN, { mode: 0o600, makeDir: false }); } catch (e) {
      log('the admin token could not be written to ' + TOKEN_PATH + ' (' + (e.code || e.message) + '), so nobody can read it this run: AGMessage serves on without it. Its folder is the installer\'s, which lets the server write there.');
      if (process.stdout.isTTY !== true) line = '    Token: not shown here, and not written (the line above says why).';
    }
  }
  process.stdout.write(line + '\n', () => { if (me.connected) me.send({ t: 'token-said' }, () => { /* gone: its banner goes on after its wait */ }); });
}

/**
 * The server ended with `code`: stop, give up or start it again. A server that cannot start as configured (3), or whose
 * port or folder is held (75), said why as it ended (`said`, its last line on its error output), and the watchdog's line
 * carries those words, cut at 600 characters.
 */
function decide(code, hung, signal, said = '') {
  const d = policy.exited(code, Date.now(), hung);
  const own = !hung && (code === EXIT.CONFIG || code === EXIT.HELD) && said ? ': ' + said.replace(/^AGMessage cannot start:\s*/, '').slice(0, 600) : '';
  if (d.action === 'stop') {
    if (code !== EXIT.STOP) log('server stopped: ' + d.reason + own);
    // The installed node has no window to read the refusal in. A portable copy's is read in its window, and one refused
    // because another copy holds its folder must leave no record in that copy's folder.
    if (code === EXIT.CONFIG && channel.runs === 'task') record({ at: Date.now(), reason: d.reason + own, refused: true });
    process.exit(code === EXIT.CONFIG ? EXIT.CONFIG : EXIT.STOP);
  }
  if (d.action === 'giveup') {
    log('giving up: ' + d.reason);
    record({ at: Date.now(), reason: d.reason });
    process.exit(EXIT.CONFIG);   // the .bat stops too: something is wrong that restarting won't fix
  }
  restarts++;
  heldRun = code === EXIT.HELD && !hung ? heldRun + 1 : 0;
  const tries = heldRun > 1 ? ' (try ' + heldRun + ')' : '';
  before = 'server ' + d.reason + own + (signal ? ' [' + signal + ']' : '') + tries;
  log(before + ' — restarting' + (d.delayMs ? ' in ' + d.delayMs / 1000 + ' s' : ''), heldRun > 1 && heldRun % HELD_LOG_EVERY !== 0);
  setTimeout(() => { if (!stopping) start(); }, d.delayMs);
}

/**
 * A sleep is said once the watchdog has run on time after it: on its console, in watchdog.log and server.log, and to its
 * server (now when one has beaten since, else at the next one's beat), which keeps it in health and "This laptop".
 */
function slept(s) {
  log(asleepLine(s));
  untold.push(s);
  if (untold.length > UNTOLD_MAX) untold.shift();
  if (child && child.connected && judge.beaten) tell(child);
}
/** A sleep's line, as the console and both logs say it. */
function asleepLine(s) { return asleepWords(s) + ': the watchdog did not run, so it judged nothing of the server for that time'; }
/** The sleeps not yet given to the server `me`, given to it, which reads each by type. */
function tell(me) {
  while (untold.length && me.connected) {
    const s = untold.shift();
    me.send({ t: 'slept', from: s.from, to: s.to, parts: s.parts }, () => { /* gone: watchdog.log has it */ });
  }
}

// The heartbeat check, every TICK_MS: a tick of its own that came late is a sleep, and starts the beat clock again; on a
// tick that came on time, a server silent past its limit is hung, and is killed so it can be restarted.
setInterval(() => {
  const t = judge.tick(performance.now(), Date.now());
  if (t.slept) slept(t.slept);
  if (!child || stopping || child.hung || !t.hungMs) return;
  log('no heartbeat for ' + Math.round(t.hungMs / 1000) + ' s — the server is not responding');
  child.hung = true;
  try { child.kill('SIGKILL'); } catch { /* exit handler restarts */ }
}, TICK_MS);

// The server is asked to stop over IPC, so it saves its rooms, lanes and audit entries first: on Windows a signal sent
// to a child is not delivered, it ends the process at once. One that has not gone within 4 s is ended.
function stop() {
  if (stopping) return;
  stopping = true;
  // A sleep the watchdog woke from moments ago is said before it goes, and told to a server that runs, ahead of the stop,
  // so its stop saves it with the show day's peaks.
  const s = judge.close();
  if (s) slept(s);
  if (!child) process.exit(EXIT.STOP);
  const me = child;
  try { me.send({ t: 'stop' }); } catch { try { me.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => { try { me.kill('SIGKILL'); } catch { /* already gone */ } }, 4000).unref();
  setTimeout(() => process.exit(EXIT.STOP), 5000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);   // the console window closed
// Whatever runs the watchdog over IPC (a test, a service wrapper) asks it to stop the same way; on Windows a signal sent
// to it would end it at once, and Windows ends its server with it (the job libuv puts every child in).
if (typeof process.send === 'function') process.on('message', (m) => { if (m && m.t === 'stop') stop(); });

start();
