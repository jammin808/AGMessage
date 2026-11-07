'use strict';
/**
 * What a start of the server opens and says for the person at this laptop (tested in test/startup.test.js):
 *
 *   openerPlan, openBrowser        the portable copy opens http://localhost:<PORT> on the person's own screen once it
 *                                  serves, so the page that opens is this copy's and never whatever else answers there;
 *                                  /admin when the audit log needs the person at this laptop
 *   readPortHolder, portHolderWords  a port already in use says who holds it, read once from the holder's own health at
 *                                  loopback with no token; the answer only chooses the words, nothing is decided on it
 *   channelOf                      the channel this copy runs in (AGM_RUNS) and, for the installed node, its three
 *                                  folders and its logs folder, read before the watchdog or the server writes anything
 *   serverLogFile                  where the watchdog keeps its console: the installed node's logs folder, or data\logs
 *   taskTokenProblem, tokenLine    where the admin token is said: the installed node's watchdog takes no secret from its
 *                                  environment and writes the token into a folder of its own; the banner's Token line
 *                                  holds the token only on a console, where a person sits
 *   isFullPath                     a path that names its folder or file whole: from the root, or on Windows from a
 *                                  drive or a network share, never one the current folder or drive completes
 *   cloudflaredFile, noCloudflaredWords  the internet link's cloudflared, by its absolute path: the one this copy ships,
 *                                  and, without it, why in words, with the way back for how this copy runs
 */
const http = require('http');
const path = require('path');
const { cleanText } = require('./guard');

/** A Windows folder named from its drive: SystemRoot is never taken relative to wherever this copy runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;

/**
 * The cloudflared this copy runs for its internet link: the one it ships, in bin beside app (`programDir`, the folder app
 * is in), by its absolute path; null when `programDir` is not a full path (isFullPath) (pure). Never a bare name, which
 * Windows looks for in the current folder and on PATH first: a copy without its own cloudflared has no internet link,
 * and says so, rather than run a cloudflared another account left there.
 */
function cloudflaredFile({ programDir, platform = process.platform }) {
  if (!isFullPath(programDir, platform)) return null;
  return platform === 'win32' ? path.win32.join(programDir, 'bin', 'cloudflared.exe') : path.posix.join(programDir, 'bin', 'cloudflared');
}

/**
 * Why the internet link has no cloudflared, in words (pure): this copy's own is not there (or its folder is no full path
 * to look in), with the way to put it back that fits how it runs (`runs`, channelOf's): the portable folder extracted
 * again, the installed node repaired by its installer.
 */
function noCloudflaredWords({ runs, platform = process.platform }) {
  const file = platform === 'win32' ? 'bin\\cloudflared.exe' : 'bin/cloudflared';
  const back = runs === 'task' ? 'repair AGMessage by running its installer again' : 're-extract the portable folder';
  return 'cloudflared not found in this copy (' + file + '): ' + back + '. AGMessage runs only its own cloudflared, never one from elsewhere on this PC.';
}

/**
 * Whether this start opens the browser: {open: true, file, args, options, url}, or {open: false, say} where `say` is the
 * one console line to print ('' for none).
 *  - Only start-agmessage.bat asks (AGM_OPEN=1), and only the watchdog's first start of the server opens, never a restart.
 *  - It is the portable channel's alone (AGM_RUNS absent or 'portable'). Any other channel, the installed node's 'task'
 *    included, runs where nothing it opens is ever seen (Windows' session 0), so it never opens, whatever AGM_OPEN holds.
 *  - Windows only, through explorer.exe by its absolute path under %SystemRoot%: a bare name is looked for in the current
 *    folder and on PATH first. Without a SystemRoot that names a folder from its drive, nothing is run and the line says so.
 *  - `path` is '' (the start page) or '/admin' (the audit log asks the person at this laptop): only those two.
 */
function openerPlan(env, { restarts, port, platform, path: page = '' }) {
  const url = 'http://localhost:' + port + (page === '/admin' ? '/admin' : '');
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

/** The channels a copy runs in (AGM_RUNS): the portable folder (unset, or empty, as cmd leaves it), or the installed node. */
const CHANNELS = Object.freeze(['portable', 'task']);
/** The installed node's folders, each named by its own variable, as the task's launcher sets them. */
const TASK_FOLDERS = Object.freeze([['AGM_DATA_DIR', 'data'], ['AGM_UPLOAD_DIR', 'uploads'], ['AGM_KEY_DIR', 'key']]);

/**
 * Whether `dir` is a full path: from a drive (C:\…) or a share (\\host\…) on Windows, from / elsewhere (pure). A Windows
 * device or long-path prefix (\\?\, \\.\) is not taken: it names the same folders by another spelling, which the check
 * against the program's folder would not see. Nor is one the current folder or drive completes (a relative path,
 * `\server.js` from the current drive's root, `C:server.js` on a drive's current folder): a program named by one is
 * whatever stands there.
 */
function isFullPath(dir, platform = process.platform) {
  if (typeof dir !== 'string') return false;
  if (platform !== 'win32') return dir.startsWith('/');
  if (/^[\\/]{2}[?.][\\/]/.test(dir)) return false;
  return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir);
}
/** Whether `dir` is `root` or a folder inside it, by the paths as written (letter case aside on Windows) (pure). */
function isInside(dir, root, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (x) => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const rel = p.relative(fold(root), fold(dir));
  // Outside is a step up ('..' itself, or '..' and a separator), or another drive; a folder named '..data' is inside.
  const up = rel === '..' || rel.startsWith('..' + p.sep);
  return !up && !p.isAbsolute(rel);
}

/**
 * The channel this copy runs in, and whether it may start in it: {runs, problem}, `problem` '' when it may, else the words
 * of why not (said on the console, and the start ends with code 3 before anything is written).
 *  - AGM_RUNS unset or empty is the portable folder; 'portable' and 'task' are taken as they are spelled, and any other
 *    value is refused: never read as the portable folder.
 *  - Under 'task', the installed node's three folders (AGM_DATA_DIR, AGM_UPLOAD_DIR, AGM_KEY_DIR) are each named, a full
 *    path, and outside the program's folder (`programDir`, the folder that holds app\ and node\): a task passes no
 *    folder of its own, and a default inside the program's folder would put the node's data where an upgrade replaces it.
 */
function channelOf(env, { programDir, platform = process.platform }) {
  const asked = env.AGM_RUNS === undefined || env.AGM_RUNS === '' ? 'portable' : String(env.AGM_RUNS);
  if (!CHANNELS.includes(asked)) {
    return { runs: '', problem: `AGM_RUNS is "${cleanText(asked, 40)}", which names no way AGMessage runs. Leave it unset for the portable folder, or set it to task for the installed node.` };
  }
  if (asked === 'portable') return { runs: asked, problem: '' };
  for (const [name, what] of TASK_FOLDERS) {
    const dir = typeof env[name] === 'string' ? env[name] : '';
    const said = cleanText(dir, 260);
    if (!dir) return { runs: asked, problem: `the installed node needs its ${what} folder in ${name}, and it is not set. Each of its folders is a full path outside ${programDir}.` };
    if (!isFullPath(dir, platform)) return { runs: asked, problem: `${name} is "${said}", which is not a full path. The installed node's ${what} folder is a full path outside ${programDir}.` };
    if (isInside(dir, programDir, platform)) return { runs: asked, problem: `${name} is ${said}, inside the program's folder ${programDir}. The installed node's ${what} folder is outside it, where an upgrade never replaces it.` };
  }
  // Its logs folder, where the watchdog keeps server.log: the launcher's, outside the data folder (logs\ beside data\),
  // so a refusal it says before the data folder may be written in still reaches the log. Unset, it is data\logs.
  const logs = typeof env.AGM_LOG_DIR === 'string' ? env.AGM_LOG_DIR : '';
  if (logs) {
    const said = cleanText(logs, 260);
    if (!isFullPath(logs, platform)) return { runs: asked, problem: `AGM_LOG_DIR is "${said}", which is not a full path. The installed node's logs folder is a full path outside ${programDir}.` };
    if (isInside(logs, programDir, platform)) return { runs: asked, problem: `AGM_LOG_DIR is ${said}, inside the program's folder ${programDir}. The installed node's logs folder is outside it, where an upgrade never replaces it.` };
  }
  // The machine's events file, which the server reads and never writes (machine\events.jsonl): the launcher's, a full
  // path outside the program's folder, where only the machine's own commands write. Unset, the node reads none.
  const events = typeof env.AGM_MACHINE_EVENTS === 'string' ? env.AGM_MACHINE_EVENTS : '';
  if (events) {
    const said = cleanText(events, 260);
    if (!isFullPath(events, platform)) return { runs: asked, problem: `AGM_MACHINE_EVENTS is "${said}", which is not a full path. The installed node's machine events are a file outside ${programDir}.` };
    if (isInside(events, programDir, platform)) return { runs: asked, problem: `AGM_MACHINE_EVENTS is ${said}, inside the program's folder ${programDir}. The machine's events are outside it, where only the machine's own commands write.` };
  }
  return { runs: asked, problem: '' };
}

/**
 * The file the watchdog keeps its console in (pure): the installed node's logs folder's server.log when the launcher names
 * one (AGM_LOG_DIR, under 'task'; channelOf checks it), else the data folder's logs\server.log.
 */
function serverLogFile(env, { dataDir, runs }) {
  return runs === 'task' && typeof env.AGM_LOG_DIR === 'string' && env.AGM_LOG_DIR ? path.join(env.AGM_LOG_DIR, 'server.log') : path.join(dataDir, 'logs', 'server.log');
}

/** The admin token's file in the installed node's token folder (AGM_TOKEN_DIR), which its watchdog writes. */
const TOKEN_FILE = 'admin-token';
/**
 * The line a server its watchdog runs writes on its output right after the banner's URL line, before it asks for the
 * Token line: the watchdog reads that output through a pipe and its asks through their own channel, so it says the Token
 * line once it has met this line, and the banner keeps its order whichever of the two it reads first. The line itself is
 * never shown or kept.
 */
const TOKEN_HERE = '\u0000AGMessage: the Token line goes here\u0000';
/**
 * Secrets the installed node never takes from its environment: whatever starts it (a scheduled task's definition) can be
 * read by every account allowed to read that task. Its token is its watchdog's own, and its AI key is sealed in its settings.
 */
const TASK_SECRETS = Object.freeze([
  ['ADMIN_TOKEN', 'Its watchdog makes the admin token at each start and writes it where this PC\'s AGMessage admin reads it'],
  ['ANTHROPIC_API_KEY', 'Add the key on the admin page instead (Admin → AI), where it is sealed with this PC\'s machine key'],
]);
/**
 * What stops the installed node's watchdog before it writes anything, in words, or '' (pure): a secret in its environment
 * (TASK_SECRETS, any value but an empty one), or a token folder (AGM_TOKEN_DIR) that is not set, not a full path, inside the
 * program's folder, or not one of its own: the data, uploads or key folder, inside one of them, or holding one. Whoever is
 * given the token reads that folder, and nothing else of the node. Only the installed node ('task') is asked.
 */
function taskTokenProblem(env, { programDir, platform = process.platform }) {
  if (env.AGM_RUNS !== 'task') return '';
  for (const [name, instead] of TASK_SECRETS) {
    if (typeof env[name] === 'string' && env[name] !== '') return `${name} is set in the installed node's environment, where every account that may read its task reads it too. ${instead}: remove ${name} from it.`;
  }
  const dir = typeof env.AGM_TOKEN_DIR === 'string' ? env.AGM_TOKEN_DIR : '';
  const said = cleanText(dir, 260);
  if (!dir) return `the installed node needs its token folder in AGM_TOKEN_DIR, and it is not set. It is a full path outside ${programDir}, a folder of its own.`;
  if (!isFullPath(dir, platform)) return `AGM_TOKEN_DIR is "${said}", which is not a full path. The installed node's token folder is a full path outside ${programDir}, a folder of its own.`;
  if (isInside(dir, programDir, platform)) return `AGM_TOKEN_DIR is ${said}, inside the program's folder ${programDir}. The installed node's token folder is outside it, where an upgrade never replaces it.`;
  for (const [name, what] of TASK_FOLDERS) {
    const other = typeof env[name] === 'string' ? env[name] : '';
    if (other && isFullPath(other, platform) && (isInside(dir, other, platform) || isInside(other, dir, platform))) {
      return `AGM_TOKEN_DIR is ${said}, and the ${what} folder (${name}) is ${cleanText(other, 260)}. The token folder is one of its own, neither inside another of the node's folders nor holding one: whoever is given the token reads that folder, and nothing else of the node.`;
    }
  }
  return '';
}

/**
 * The banner's Token line, which the watchdog says (it made the token) once its server serves (pure). On a console (`tty`),
 * where a person sits, it holds the token. Anywhere else (output kept in a file or a log, the installed node's, which has
 * no window) it never does, and says where the token is instead: the installed node's token file (`file`), or, for a
 * portable copy, how to see it.
 */
function tokenLine({ tty, runs, token, file }) {
  if (tty) return '    Token: ' + token;
  if (runs === 'task') return '    Token: not shown here. It is in ' + file + ', which this PC\'s AGMessage admin reads (Start → AGMessage → Show the admin token).';
  return '    Token: not shown here, since this output is not a window a person reads and may be kept. Start AGMessage in its own window to see it, or set ADMIN_TOKEN, 16 or more random letters and digits, before it starts.';
}

module.exports = { openerPlan, openBrowser, isFullPath, serverLogFile, cloudflaredFile, noCloudflaredWords, readPortHolder, portHolderWords, holderOf, channelOf, CHANNELS, taskTokenProblem, tokenLine, TOKEN_FILE, TOKEN_HERE, TASK_SECRETS };
