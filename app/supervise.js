'use strict';
/**
 * The watchdog: runs the server as a child process and keeps it running through a meeting.
 *
 *  - The server sends a heartbeat over IPC from its event loop every second. A crash, or a hang (no beat for
 *    AGM_HANG_MS, default 10 s; the first beat may take AGM_STARTUP_MS, default 30 s), restarts it.
 *  - Waits between crash restarts: 2, 4, 8, 15, 30 s; a run of 5 minutes resets them. More than 6 crashes in
 *    10 minutes: it gives up, writes data/watchdog.json and a line to data/watchdog.log, and the next start shows
 *    that on the admin page.
 *  - Exit codes carry intent (lib/resilience.js EXIT): 0 stopped, 3 can't start as configured, 82 restart now.
 *  - The admin token is made once here and handed to every restart, so a restart doesn't change it.
 *  - Ctrl+C, closing the window or a stop: the server is asked over IPC and saves before it goes (a signal to a child
 *    on Windows would end it unsaved); if the watchdog itself is ended, the server sees its channel close and saves.
 *
 * Rooms, history and everyone's place come back from the saved log on every restart (lib/store.js).
 */
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SupervisorPolicy, EXIT } = require('./lib/resilience');

const CHILD = process.env.AGM_CHILD || path.join(__dirname, 'server.js');
const DATA_DIR = process.env.AGM_DATA_DIR || path.join(__dirname, 'data');
const HANG_MS = Number(process.env.AGM_HANG_MS) || 10_000;
const STARTUP_MS = Number(process.env.AGM_STARTUP_MS) || 30_000;
const policy = new SupervisorPolicy(process.env.AGM_BACKOFF ? { backoffSec: process.env.AGM_BACKOFF.split(',').map(Number) } : {});

fs.mkdirSync(DATA_DIR, { recursive: true });
const env = { ...process.env, AGM_SUPERVISED: '1', AGM_DATA_DIR: DATA_DIR };
if (!env.ADMIN_TOKEN) env.ADMIN_TOKEN = crypto.randomBytes(8).toString('hex');

function log(line) {
  const text = new Date().toISOString() + ' ' + line;
  console.log('  [watchdog] ' + line);
  try { fs.appendFileSync(path.join(DATA_DIR, 'watchdog.log'), text + '\n'); } catch { /* the console has it */ }
}

let child = null;
let lastBeat = 0;
let stopping = false;
let restarts = 0;

function start() {
  lastBeat = 0;
  policy.started(Date.now());
  child = fork(CHILD, [], { env: { ...env, AGM_RESTARTS: String(restarts) }, stdio: 'inherit' });
  const me = child;
  me.on('message', (m) => { if (m && m.t === 'beat') lastBeat = Date.now(); });
  me.on('exit', (code, signal) => {
    if (child !== me) return;
    child = null;
    if (stopping) { process.exit(EXIT.STOP); return; }
    decide(code === null ? -1 : code, me.hung === true, signal);
  });
}

function decide(code, hung, signal) {
  const d = policy.exited(code, Date.now(), hung);
  if (d.action === 'stop') {
    if (code !== EXIT.STOP) log('server stopped: ' + d.reason);
    process.exit(code === EXIT.CONFIG ? EXIT.CONFIG : EXIT.STOP);
  }
  if (d.action === 'giveup') {
    log('giving up: ' + d.reason);
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'watchdog.json'), JSON.stringify({ at: Date.now(), reason: d.reason }));
    } catch { /* logged above */ }
    process.exit(EXIT.CONFIG);   // the .bat stops too: something is wrong that restarting won't fix
  }
  restarts++;
  log('server ' + d.reason + (signal ? ' [' + signal + ']' : '') + ' — restarting' + (d.delayMs ? ' in ' + d.delayMs / 1000 + ' s' : ''));
  setTimeout(() => { if (!stopping) start(); }, d.delayMs);
}

// The heartbeat check: a hung server is killed so it can be restarted.
setInterval(() => {
  if (!child || stopping) return;
  const since = Date.now() - (lastBeat || policy.startedAt);
  const limit = lastBeat ? HANG_MS : STARTUP_MS;
  if (since > limit) {
    log('no heartbeat for ' + Math.round(since / 1000) + ' s — the server is not responding');
    child.hung = true;
    try { child.kill('SIGKILL'); } catch { /* exit handler restarts */ }
  }
}, 500);

// The server is asked to stop over IPC, so it saves its rooms, lanes and audit entries first: on Windows a signal sent
// to a child is not delivered, it ends the process at once. One that has not gone within 4 s is ended.
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(EXIT.STOP);
  const me = child;
  try { me.send({ t: 'stop' }); } catch { try { me.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => { try { me.kill('SIGKILL'); } catch { /* already gone */ } }, 4000).unref();
  setTimeout(() => process.exit(EXIT.STOP), 5000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);   // the console window closed

start();
