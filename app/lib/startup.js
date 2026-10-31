'use strict';
/**
 * What a start of the server opens and says for the person at this laptop (tested in test/startup.test.js):
 *
 *   openerPlan, openBrowser        the portable copy opens http://localhost:<PORT> on the person's own screen once it
 *                                  serves, so the page that opens is this copy's and never whatever else answers there
 *   readPortHolder, portHolderWords  a port already in use says who holds it, read once from the holder's own health at
 *                                  loopback with no token; the answer only chooses the words, nothing is decided on it
 */
const http = require('http');
const path = require('path');
const { cleanText } = require('./guard');

/** A Windows folder named from its drive: SystemRoot is never taken relative to wherever this copy runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;

/**
 * Whether this start opens the browser: {open: true, file, args, options, url}, or {open: false, say} where `say` is the
 * one console line to print ('' for none).
 *  - Only start-agmessage.bat asks (AGM_OPEN=1), and only the watchdog's first start of the server opens, never a restart.
 *  - It is the portable channel's alone (AGM_RUNS absent or 'portable'). Any other channel, the installed node's 'task'
 *    included, runs where nothing it opens is ever seen (Windows' session 0), so it never opens, whatever AGM_OPEN holds.
 *  - Windows only, through explorer.exe by its absolute path under %SystemRoot%: a bare name is looked for in the current
 *    folder and on PATH first. Without a SystemRoot that names a folder from its drive, nothing is run and the line says so.
 */
function openerPlan(env, { restarts, port, platform }) {
  const url = 'http://localhost:' + port;
  if (env.AGM_OPEN !== '1' || restarts > 0) return { open: false, say: '' };
  if (env.AGM_RUNS && env.AGM_RUNS !== 'portable') return { open: false, say: '' };
  if (platform !== 'win32') return { open: false, say: '  Browser: it opens by itself on Windows only. Open ' + url };
  const root = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (!DRIVE_PATH.test(root)) return { open: false, say: '  Browser: not opened, since SystemRoot does not name the Windows folder, so explorer.exe has no path to run from. Open ' + url };
  return { open: true, file: path.win32.join(root, 'explorer.exe'), args: [url], options: { windowsHide: true, detached: true, stdio: 'ignore' }, url };
}

/**
 * Carries out an opener plan with `spawn` (an argument array, no shell): says its line, or starts the browser and lets it
 * go. Nothing is said when the browser starts: it is asked, and only the person sees whether it opened. A failure to
 * start is one line, and the copy keeps serving. Returns whether a browser was asked to open.
 */
function openBrowser(plan, spawn, say) {
  if (!plan.open) {
    if (plan.say) say(plan.say);
    return false;
  }
  const failed = (e) => say('  Browser: not opened (' + ((e && (e.code || e.message)) || 'unknown error') + '). Open ' + plan.url);
  try {
    const child = spawn(plan.file, plan.args, plan.options);
    child.on('error', failed);
    child.unref();
    return true;
  } catch (e) {
    failed(e);
    return false;
  }
}

const HOLDER_TIMEOUT_MS = 1000;
const HOLDER_MAX_BYTES = 256 * 1024;   // far above any health answer; more is not one

/** What a health answer says of who holds the port: {version, build, runs} when it reads as AGMessage's, else null. */
function holderOf(text) {
  let a;
  try { a = JSON.parse(text); } catch { return null; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const version = cleanText(typeof a.version === 'string' ? a.version : '', 40);
  const build = cleanText(typeof a.build === 'string' ? a.build : '', 80);
  if (!version || !build) return null;
  const runs = a.install && typeof a.install === 'object' && typeof a.install.runs === 'string' ? a.install.runs : '';
  return { version, build, runs };
}

/**
 * Who holds `port`: GET http://127.0.0.1:<port>/api/health, once, answered within `timeoutMs`, sending no token and no
 * cookie. Resolves {version, build, runs} when the answer reads as AGMessage's health, else null (another program, no
 * answer in time, an answer too large). Never rejects. Only `version`, `build` and `install.runs` are taken, cleaned of
 * control characters and cut short: a program that answers as AGMessage chooses which words are said, and nothing more.
 */
function readPortHolder(port, { timeoutMs = HOLDER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let req = null;
    const finish = (holder) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(holder);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, (res) => {
        if (res.statusCode !== 200) { finish(null); return; }
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > HOLDER_MAX_BYTES) finish(null);
          else chunks.push(d);
        });
        res.on('end', () => finish(holderOf(Buffer.concat(chunks).toString('utf8'))));
        res.on('error', () => finish(null));
      });
    } catch {
      finish(null);   // a request that cannot even be made (a port no socket can take): nobody to name
      return;
    }
    req.on('error', () => finish(null));
  });
}

/**
 * The words for a port already in use, in this copy's channel (`runs`, its AGM_RUNS), naming who holds it (`holder`,
 * readPortHolder's answer). A portable copy ends with them in its window, where a person reads them; the installed node
 * ('task') has nobody at a window, and says them on its console.
 */
function portHolderWords(holder, { port, runs }) {
  const installed = runs === 'task';
  if (!holder) {
    return installed
      ? `Another program is using port ${port}. AGMessage tries again; AGMessage status names the program's process.`
      : `Another program is using port ${port}. Close it, or set PORT to another number.`;
  }
  if (installed) return `Another copy of AGMessage, ${holder.version} (build ${holder.build}), holds port ${port}. Close its window: AGMessage takes the port back on its next try.`;
  if (holder.runs === 'task') return `The AGMessage installed on this PC (${holder.version}, build ${holder.build}) is serving on port ${port}. Open it from Start → AGMessage → Open AGMessage, or set PORT to another number to run this copy beside it.`;
  return `AGMessage ${holder.version} (build ${holder.build}) is already running on port ${port}. Use its window, or close it and start this copy again.`;
}

module.exports = { openerPlan, openBrowser, readPortHolder, portHolderWords, holderOf };
