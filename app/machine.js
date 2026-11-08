'use strict';
/**
 * The installed node's machine-level commands. Run elevated or as SYSTEM only, by the installer (`AGMessage.iss`), the
 * control tasks and the checked upgrade's runner. It requires Node's own modules only, runs nothing but by its
 * absolute path in the System32 folder it is given, with that folder as its working folder, and reads no machine path from
 * its environment: Inno passes `{sys}`, `{app}` and `{commonappdata}` as arguments.
 *
 *   prepare           --machine <%ProgramData%\AGMessage> --sys <{sys}>
 *                     The machine folder, made race-free before anything is installed: the root with SYSTEM and
 *                     Administrators in full control (by SID, inheritance cut, never /T), an existing one taken only when
 *                     the install record shows an earlier install (or a prepare of this root that no install finished, or
 *                     the data an uninstall kept), lstat shows a real directory and its owner is SYSTEM or Administrators;
 *                     the root listed; then its
 *                     children (data, uploads, keys, logs, token, machine\ with inbox\, outbox\, work\ and staged\), each a
 *                     real directory made or found, with its own grants; and setup\<128 random bits>\, named in --out.
 *   install           --machine … --app <{app}> --sys … --build <full build> --port <n> [--admin <SID> --admin-name <name>]
 *                     [--public] [--signed] [--rollback]
 *                     The server task `\AGMessage\Server`, its SID's grants on the folders it uses, the laptop's admin's
 *                     reads and its inbox\ and outbox\, the firewall rules, and the one install record
 *                     (`HKLM\SOFTWARE\AGMessage`); setup\ removed. The laptop's admin is recorded once, at the first install
 *                     (`--admin` then required); an upgrade keeps the record's, and only then is `machine.admin` appended to
 *                     the machine's events, which the server turns into its audit row. Previous names the build an
 *                     upgrade replaced; with --rollback (the way back) none.
 *   uninstall         --machine … --sys … [--port <n>] [--force <reason>] [--remove-data] [--app <{app}>]
 *                     With --app, a person's console open from {app} refused first. The server stopped at loopback (it
 *                     saves), then every task in \AGMessage\ removed and (--app) every program of {app} waited for, the
 *                     firewall rules and the record removed, before any file goes. The data goes with --remove-data, the
 *                     keys last; else it is kept, every Windows account's right on it taken back, and the record left as
 *                     `Kept` (the root) and `Port`, which a later install takes. Each step checked: what was left is
 *                     named, and the exit is 2.
 *   preinstall-check  --machine … --port <n> [--sys …] [--force <reason>] [--app <{app}>] [--rollback] [--upgrade-by <SID>]
 *                     Fails closed: with --app, a program from {app} that is not the server's own (a person's console of
 *                     the Start menu) is refused first, the installer's own chain left out (the kept installer that ran
 *                     this check); then, with --rollback (the way back, which stops nothing), anything that answers on
 *                     the port is refused; a port that answers and is not this PC's AGMessage proving its token is
 *                     refused with who holds it (a portable copy's words, or another program's pid); a busy server with
 *                     no typed reason (`busy` and its line of counts in --out), or one that does not answer within 5 s,
 *                     is refused (exit 3). With --upgrade-by (the installer's /UPGRADEBY), refused first unless this
 *                     runs as SYSTEM and the record gives that account `upgrade`; its name is `byName` in --out.
 *   upgrade-stop      --machine … --port <n> [--by <who>] [--force <reason>] [--sys … --app <{app}>]
 *                     Refused before it asks anything when the disk is short of the room the way back's backup takes. Then
 *                     the stop at loopback with the proof of the token, reason "upgrade": the server, the one writer,
 *                     saves, backs its data up and writes its record. upgrade-stop waits for the server to end, reads
 *                     that record (made after it asked), and refuses (exit 3) a stop that did not save or made no backup,
 *                     unless forced; with --app, a program still running from {app} once the server has ended is refused.
 *   whose             --machine … --sys … [--started <setup\<random>\file>] [--admin <account>]
 *                     Whose AGMessage it is (the laptop's admin), from the plan's two readings once the elevation is in:
 *                     the account that started Setup (the whoami answer the installer had it write into the setup folder,
 *                     read and removed), and the owner of explorer.exe in this session; beside them the account the
 *                     elevation runs as (whoami.exe), and the account /ADMIN names, resolved to its SID and taken only
 *                     when Windows confirms it is one person's account here (a local user, or one with a profile on this
 *                     PC; a group, a service or an account it cannot confirm refused). Both readings naming one person
 *                     decide it; else the person chooses between the readings that name one, never a third; none is a
 *                     refusal (exit 3) that asks for /ADMIN.
 *   start             --machine … --sys … --port <n> [--build <full build>]
 *                     The server task run, and the server waited for (the watchdog's 30 s start window and the task's
 *                     own start) until it proves it holds the machine folder's token, as --build when it is given: the
 *                     verify. One that does not prove itself is ended and refused as not done (2), with its log's last
 *                     lines; `needsAccount`, asked of the proven server, says the node has no account yet.
 *   first-account     --machine … --port <n> --account <machine\work\file> [--build <full build>]
 *                     The first admin account, made through /api/setup at loopback with the token the machine folder
 *                     holds, sent only to the server that proved it holds that token (as --build when it is given), on
 *                     the connection it proved itself on; its user name, name and password read from the file the
 *                     installer wrote into machine\work\ (SYSTEM and Administrators only), which is removed before
 *                     anything is asked. The password goes in no argument, URL, --out or log; the server's refusal (an
 *                     account there already, a password it takes not) is said in its own words (exit 3).
 *   status            --machine … --sys … [--port <n>]
 *                     The server task's state and last result, the tails of watchdog.log and server.log, the last
 *                     last-stop.json, the port's holder pid, whether a code-integrity event stopped node.exe, the laptop's
 *                     admin and the grants; each fact read, refused or absent.
 *   restore           --machine … --backup <backups\upgrade-…> --port <n>
 *                     The way back's restore of one backup over the data and uploads folders, file by file, while nothing
 *                     answers on the port: what the backup holds laid back, what it does not hold removed; the audit log and
 *                     watchdog.log, append-only evidence, are never rolled back, nor is the place in the machine's events
 *                     the server's settings had reached (settings.json's machineSeq), so none is written to the log twice.
 *
 *   control           --for <SID> --machine … --sys …
 *                     An account's request, run as SYSTEM by its own control task (`\AGMessage\Control-<SID>`, whose
 *                     descriptor lets that account alone, beside SYSTEM and Administrators, read and run it), so which task
 *                     ran says whose request it is and nothing the request says can change that. The request is
 *                     machine\inbox\<SID>\request.json, refused when lstat shows a link, a hard link or a reparse point,
 *                     copied by its bytes into machine\work\ and read there: whole JSON of at most 4 KB, a known verb
 *                     (start, stop, upgrade, back, grant, revoke, handover) and fields of their types. The
 *                     right is read from the install record at that moment (the laptop's admin holds all four; Grants
 *                     names the rest), the act done, its answer written into machine\outbox\<SID>\answer.json (that
 *                     account reads it), and one machine event appended for an act done. grant, revoke and handover only
 *                     from the laptop's admin's own task.
 *                     --elevated --request <machine\work\file> --machine … --sys … [--out <file>]
 *                     The same acts from an administrator's elevated console (a laptop whose admin account is gone): an
 *                     administrator may do every one, each event naming that administrator; the answer goes to --out.
 *
 *   import            --step stage --for <SID> --machine … --sys …
 *                     --step take --for <SID> --machine … --app <{app}> --source <portable folder> [--sys …]
 *                     --step finish --for <SID> --machine … --sys … --id <the import's id>
 *                     --step clear --for <SID> --machine …
 *                     The portable import, before the installed node's first start (U14), its elevated half; the account
 *                     that started the installer runs the other (launch.js export and forget-keys) as itself. stage: a node
 *                     that has served refused (any hall, account or audit row, or keys of its own: never merge), and a
 *                     fresh import\ folder made in that account's inbox, which it may add files to and never a folder.
 *                     take: the bundle its export left read part by part (no link, no hard link, each the file lstat saw),
 *                     each copied by its bytes into a new file of the data, uploads or keys folder (never over one, never
 *                     an access list), its SHA-256 checked; then the verify, which says each check that did not pass (the
 *                     counts, the machine key, every sealed value opening, the certificate's fingerprint, the audit
 *                     chain, and what the installed node's own start refuses: the build and format, keys it would not
 *                     start on, a copy running, an import's mark), and takes out what it copied when one did not; passed,
 *                     its verdict in the account's outbox (import.json), which forget-keys reads before it removes
 *                     anything. A take that does not pass clears the bundle (it holds the portable folder's keys).
 *                     finish: `machine.import` appended to the machine's events, the account named by the machine, the
 *                     import folder cleared; not done (2) when an old copy was not removed or the folder not marked, its
 *                     path in the words. clear: an import left before its end, its folder and verdict removed.
 *
 *   upgrade           --step run --plan <machine\work\upgrade-<id>\plan.json> --sys …
 *                     The checked upgrade's runner (Upgrade AGMessage…, Go back to build N): the control task checks an
 *                     installer against its release on GitHub (immutable, the asset's digest equal to the staged copy's
 *                     SHA-256, newer than the record's version, AGMessage not busy without a typed reason), then leaves
 *                     a copy of node.exe and this file beside a plan in machine\work\ and runs it there as a task of its
 *                     own (\AGMessage\Upgrade-<id>, SYSTEM, once), since nothing may run from {app} while an installer
 *                     replaces it and the control task's job ends at its time limit. The runner waits for the console
 *                     that asked to close, then runs the staged installer with /UPGRADEBY (or, to go back, stops
 *                     AGMessage, lays the upgrade's backup back and runs the kept installer with /ROLLBACK), its log in
 *                     its own folder, and answers into the account's outbox. Each outcome, once it is seen (the exit
 *                     code, the record, what answers on the port), is one machine event: machine.upgrade or
 *                     machine.upgrade.refused. One at a time: machine\work\upgrade.lock from the check to the hand-off,
 *                     then the runner's own program.
 *
 * Every verb takes `--out <file>`: its result as JSON ({v, verb, code, words, …}), refusals too, never a token or a
 * password, written whole. Exit codes: 0 done; 2 not done, with the words of why; 3 refused, fail closed (a precondition
 * a person must clear); 64 a verb or an argument it does not know, or one missing or malformed. Run in a console with no
 * --out (a person reading it), it waits for Enter before it ends; with --out (the installer's hidden runs) it never waits.
 * Its one authority is the install record and the folder it holds; the audit log is the server's alone.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const DONE = 0;
const NOT_DONE = 2;
const REFUSED = 3;
const USAGE = 64;

/** The well-known SIDs the grants are written by, since account names are localised and can be renamed. */
const SID = Object.freeze({ system: 'S-1-5-18', localService: 'S-1-5-19', admins: 'S-1-5-32-544', users: 'S-1-5-32-545', everyone: 'S-1-1-0', authed: 'S-1-5-11' });
/** The install record: one key, HKLM\SOFTWARE\AGMessage, in the 64-bit view. */
const HKLM = 'HKLM\\SOFTWARE\\AGMessage';
/** The server task, in AGMessage's own folder of Task Scheduler, which holds AGMessage's tasks and nothing else. */
const TASK_FOLDER = '\\AGMessage\\';
const SERVER_TASK = TASK_FOLDER + 'Server';
/**
 * The server task's security descriptor: SYSTEM and Administrators in full control (read and execute among it), nobody
 * else; protected, so nothing is inherited from the folder. People start it through their own control tasks.
 */
const SERVER_TASK_SDDL = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)';
/** An account's control task, by its SID: one per account with a right, the laptop's admin's among them. */
const controlTask = (sid) => TASK_FOLDER + 'Control-' + sid;
/**
 * A control task's security descriptor: SYSTEM and Administrators in full control, and the one account it is for read
 * and execute (FRFX), so it may run that task and no other account may (which rights let it run on demand is reading R11).
 */
const controlSddl = (sid) => 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + sid + ')';
/** The rights the laptop's admin holds and gives (U.5.1): each to one person's account at a time. */
const RIGHTS = Object.freeze(['token', 'start', 'stop', 'upgrade']);
/** The verbs a request may name. */
const CONTROL_VERBS = Object.freeze(['start', 'stop', 'upgrade', 'back', 'grant', 'revoke', 'handover']);
/** The most of a request the control task reads: a request over this is refused whole. */
const REQUEST_MAX = 4096;
/** The integrity labels of an elevated token (High) and of SYSTEM's (System), by SID: never Windows' localised words. */
const ELEVATED_LABELS = Object.freeze(['S-1-16-12288', 'S-1-16-16384']);
/** The firewall rules' names: one for TCP (the port), one for UDP (discovery, 9928). */
const RULE_TCP = 'AGMessage-Server-TCP';
const RULE_UDP = 'AGMessage-Discovery-UDP';
const DISCOVERY_PORT = 9928;
/** A Windows folder named from its drive: a System32 folder is never taken relative to wherever this runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;
/** A SID as the record and the grants write one: S-1-, then numbers, each after one dash (pure). */
const isSid = (v) => typeof v === 'string' && /^S-1-[0-9-]{1,140}$/.test(v) && !v.includes('--') && !v.endsWith('-');
/** The free room the server keeps beside a backup's copies (its AGM_UPLOAD_MIN_FREE, which the task never sets). */
const BACKUP_RESERVE = 1024 ** 3;
/** How long a stop for an upgrade or an uninstall may take, saving and backing up, before the machine stops waiting. */
const STOP_WAIT_MS = 120_000;
/**
 * How long the verify waits for the server task's server to answer /api/health: the watchdog's 30 s start window
 * (AGM_STARTUP_MS, which the task never sets) and 5 s for Task Scheduler to start the task's action.
 */
const START_WAIT_MS = 35_000;
/** How long the programs of {app} are given to end once the server has (the watchdog and launch.js serve after it). */
const PROGRAMS_WAIT_MS = 15_000;
const POLL_MS = 250;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A name as words for the console: control characters and bidi marks taken out, cut short. */
const said = (v, max = 200) => String(v).replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, max);
const pad2 = (n) => String(n).padStart(2, '0');
/** A time of day as the laptop's clock reads it ("20:31"). */
const clock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
const MB = (n) => (n < 1024 * 1024 ? Math.ceil(n / 1024) + ' KB' : Math.ceil(n / (1024 * 1024)) + ' MB');

/** A refusal (exit 3): a precondition a person must clear, its words said and never a stack. */
function refusal(words, extra = {}) { return Object.assign(new Error(words), { refused: true, words, ...extra }); }
/** Not done (exit 2): a step that failed, its words said. */
function notDone(words, extra = {}) { return Object.assign(new Error(words), { words, ...extra }); }
/** An argument missing or malformed (exit 64). */
function usage(words) { return Object.assign(new Error(words), { usage: true, words }); }

/**
 * Whether `v` is a full path (lib/startup.js isFullPath's rule): on Windows from a drive (C:\…) or a share (\\host\…),
 * never a device or long-path prefix (\\?\, \\.\) nor one the current drive or folder completes (`\ProgramData\…`,
 * `C:folder`); off Windows, from / too, so the tests read real folders (pure).
 */
function fullPath(v, platform = process.platform) {
  if (typeof v !== 'string' || !v) return false;
  if (/^[\\/]{2}[?.][\\/]/.test(v)) return false;
  if (/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]{2}[^\\/]/.test(v)) return true;
  return platform !== 'win32' && v.startsWith('/');
}
/** The path module a folder's paths are joined with: Windows' for a Windows path, POSIX's for a test's folder. */
const pathOf = (p) => (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) ? path.win32 : path.posix);

// ---------------------------------------------------------------- the machine's wire half (its own copy, node: only)
// The machine asks its server at loopback, carrying a proof of the token, never the token. The server's half is
// lib/machinewire.js; this is machine.js's own, held to it and to lib/busy.js by test/machine.test.js (the two proofs'
// words, the shapes, the stop's body, the busy line read by type).
const HELLO_SAYS = 'agmessage machine server\n';
const ASK_SAYS = 'agmessage machine\n';
const ANSWER_MS = 5000;
const ANSWER_MAX = 64 * 1024;
const NONCE = /^[0-9a-f]{32}$/;
const PROOF = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const mac = (token, text) => crypto.createHmac('sha256', String(token)).update(text).digest('hex');
const tokenOf = (token) => String(token).toLowerCase().trim();
const serverProof = (token, nonce, challenge) => mac(token, HELLO_SAYS + nonce + '\n' + challenge);
const askProof = (token, { nonce, method, path: p, body }) => mac(token, ASK_SAYS + nonce + '\n' + method + '\n' + p + '\n' + sha256(body || Buffer.alloc(0)));
function sameProof(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !PROOF.test(a) || !PROOF.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * One request to 127.0.0.1:`port`: {status, json, socket} or {error} ('silent' when the whole answer had not come in
 * time). Through `agent` when one is given (a connection kept for the next request), else a connection of its own. With
 * `only`, the request is written only on that connection: given any other (the one that proved the server was closed), it
 * is destroyed before a byte is written, {error: 'reconnected'}.
 */
function request({ port, method = 'GET', path: p, headers = {}, body = Buffer.alloc(0), timeoutMs = ANSWER_MS, agent = false, only = null }) {
  return new Promise((resolve) => {
    let done = false;
    let deadline = null;
    let socket = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(deadline); resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent, headers: { ...headers, 'content-length': body.length } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > ANSWER_MAX) { req.destroy(new Error('answer too large')); return; } chunks.push(c); });
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; /* not JSON: its status still says what it answered */ } finish({ status: res.statusCode, json, socket }); });
      res.on('error', (e) => finish({ error: e.code || e.message }));
    });
    deadline = setTimeout(() => { finish({ error: 'silent' }); req.destroy(); }, timeoutMs);
    req.on('error', (e) => finish({ error: e.code || e.message }));
    // Nothing is written before the connection is known: headers and body go only once it is the one asked for.
    req.on('socket', (s) => {
      socket = s;
      if (only && s !== only) { finish({ error: 'reconnected' }); req.destroy(); return; }
      req.end(body);
    });
  });
}
function failWords(why, port, timeoutMs) {
  if (why === 'silent') return 'the program on port ' + port + ' did not answer within ' + timeoutMs / 1000 + ' s';
  if (why === 'ECONNREFUSED') return 'nothing answers on port ' + port;
  if (why === 'unproven') return 'the program on port ' + port + ' did not prove it holds this PC\'s AGMessage token';
  if (why === 'reconnected') return 'AGMessage on port ' + port + ' closed the connection it proved itself on before anything else was sent';
  return 'port ' + port + ' could not be reached (' + said(why, 40) + ')';
}
/**
 * The hello, checked: {ok, nonce, build, socket} only when the server proves it holds `token`; else {ok: false, why,
 * words}. `socket` is the connection it proved itself on (kept for the next request when `agent` keeps connections).
 */
async function hello({ port, token, timeoutMs = ANSWER_MS, agent = false }) {
  const challenge = crypto.randomBytes(16).toString('hex');
  const r = await request({ port, path: '/api/machine/hello?c=' + challenge, timeoutMs, agent });
  if (r.error) return { ok: false, why: r.error, words: failWords(r.error, port, timeoutMs) };
  const j = r.json;
  if (r.status !== 200 || !j || typeof j.nonce !== 'string' || !NONCE.test(j.nonce) || !sameProof(j.proof, serverProof(tokenOf(token), j.nonce, challenge))) {
    return { ok: false, why: 'unproven', words: failWords('unproven', port, timeoutMs) };
  }
  return { ok: true, nonce: j.nonce, build: typeof j.build === 'string' ? said(j.build, 80) : '', socket: r.socket };
}
/**
 * Requests to the server that proved itself, on the connection it proved itself on and no other: the hello first (its
 * build, when `build` names one, the one asked for), then each of `then` in order on that same connection, so a program
 * that took the port after the hello, or anything a closed connection would reach, is sent nothing more. For a request
 * that carries what only the server may see (the token, a password). {ok: true, build, answers} (each {status, json}), or
 * {ok: false, why, words, build}: 'build' when a proven server is another build.
 */
async function proven({ port, token, build = '', then = [], timeoutMs = ANSWER_MS }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  try {
    const h = await hello({ port, token, timeoutMs, agent });
    if (!h.ok) return h;
    if (build && h.build !== build) return { ok: false, why: 'build', build: h.build, words: 'AGMessage on port ' + port + ' is build ' + h.build + ', not ' + build };
    const answers = [];
    for (const t of then) {
      const r = await request({ port, timeoutMs, ...t, agent, only: h.socket });
      if (r.error) return { ok: false, why: r.error, build: h.build, words: failWords(r.error, port, timeoutMs) };
      answers.push({ status: r.status, json: r.json });
    }
    return { ok: true, build: h.build, answers };
  } finally {
    agent.destroy();
  }
}
/** One request with the machine's proof, after the hello proved the server holds `token`; a nonce let go is asked once more. */
async function ask({ port, token, method, path: p, body, timeoutMs = ANSWER_MS }) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  let answer = null;
  for (let tries = 0; tries < 2; tries++) {
    const h = await hello({ port, token, timeoutMs });
    if (!h.ok) return h;
    const headers = { 'x-agm-nonce': h.nonce, 'x-agm-proof': askProof(tokenOf(token), { nonce: h.nonce, method, path: p, body: bytes }) };
    if (bytes.length) headers['content-type'] = 'application/json';
    const r = await request({ port, method, path: p, headers, body: bytes, timeoutMs });
    if (r.error) return { ok: false, why: r.error, words: failWords(r.error, port, timeoutMs) };
    answer = { ok: true, status: r.status, json: r.json, build: h.build };
    if (!(r.status === 401 && r.json && r.json.again === true)) break;
  }
  return answer;
}

/** The busy line's counts (lib/busy.js KEYS), in their order: a line holds these and nothing else. */
const BUSY_KEYS = Object.freeze(['active', 'takes', 'help', 'countdowns', 'seats', 'screens', 'sockets']);
/** A busy line read by type (lib/busy.js read): exactly BUSY_KEYS, each a whole number from 0; else null. */
function busyLineOf(line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const keys = Object.keys(line);
  if (keys.length !== BUSY_KEYS.length || !BUSY_KEYS.every((k) => keys.includes(k))) return null;
  return BUSY_KEYS.every((k) => Number.isSafeInteger(line[k]) && line[k] >= 0) ? line : null;
}
/** Whether a line the server answered is busy: one that is not a line reads as busy, since the machine trusts no word. */
function busyIsBusy(line) {
  const l = busyLineOf(line);
  return !l || l.active > 0 || l.takes > 0 || l.help > 0 || l.countdowns > 0;
}
/** busy, through the machine's own wire half: {answered, running, busy, words, line}, `line` its counts when it answered one. */
async function busyAsk({ port, token }) {
  const r = await ask({ port, token, method: 'GET', path: '/api/machine/busy' });
  if (!r.ok && r.why === 'ECONNREFUSED') return { answered: false, running: false, busy: false, words: 'nothing is serving' };
  if (!r.ok) return { answered: false, running: true, busy: true, words: r.words + ': read as busy' };
  const line = r.status === 200 && r.json ? busyLineOf(r.json.line) : null;
  if (!line) return { answered: false, running: true, busy: true, words: 'AGMessage answered no busy line (' + r.status + '): read as busy' };
  const counts = Object.fromEntries(BUSY_KEYS.map((k) => [k, line[k]]));
  return { answered: true, running: true, busy: busyIsBusy(counts), words: typeof r.json.words === 'string' ? said(r.json.words, 200) : '', line: counts };
}
/** stop, through the machine's own wire half: {reason, by, force}. */
function stopAsk({ port, token, reason, by, force = '' }) {
  return ask({ port, token, method: 'POST', path: '/api/machine/stop', body: { reason, by, force } });
}

/** Whether anything takes a connection on 127.0.0.1:`port` within `timeoutMs`: only a refusal is "nothing", fail closed. */
function portAnswers(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const sock = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => finish(true), timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', (e) => finish(e.code !== 'ECONNREFUSED'));
  });
}
/** Wait until nothing answers on `port`, at most `ms`: whether it closed. */
async function portCloses(port, { ms = STOP_WAIT_MS, answers = portAnswers } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    if (!(await answers(port))) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
  }
}

/**
 * Who answers /api/health on `port` with no token (lib/startup.js holderOf's reading): {version, build, runs} when it
 * reads as AGMessage's, else null. The answer only chooses the words; nothing is decided on it.
 */
async function healthOf(port) {
  const r = await request({ port, path: '/api/health', timeoutMs: ANSWER_MS });
  const a = r.json;
  if (r.error || r.status !== 200 || !a || typeof a !== 'object' || Array.isArray(a)) return null;
  const version = typeof a.version === 'string' ? said(a.version, 40) : '';
  const build = typeof a.build === 'string' ? said(a.build, 80) : '';
  if (!version || !build) return null;
  return { version, build, runs: a.install && typeof a.install === 'object' && typeof a.install.runs === 'string' ? said(a.install.runs, 20) : '' };
}

// ---------------------------------------------------------------- the build an install records

const SEMVER = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
/** An install version as the record writes one (installOf's `version`): MAJOR.MINOR.BUILD, BUILD from 1. */
const INSTALL_VERSION = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.[1-9]\d{0,4}$/;
const BUILD_NUMBER = /^[1-9]\d{0,4}$/;
const SHORT_COMMIT = /^[0-9a-f]{7}$/;
/**
 * A composed build read for the record (lib/version.js parseBuild and installVersionOf's rules): {semver, version}, the
 * product's MAJOR.MINOR.PATCH and the install version MAJOR.MINOR.BUILD; null for a local build (no build number), one past
 * what an installer's version carries (255.255.65535), or anything that is not a build (pure).
 */
function installOf(full) {
  if (typeof full !== 'string' || full.length > 80) return null;
  const plus = full.indexOf('+');
  const head = plus < 0 ? full : full.slice(0, plus);
  const tail = plus < 0 ? null : full.slice(plus + 1);
  const dash = head.indexOf('-');
  const semver = dash < 0 ? head : head.slice(0, dash);
  const pre = dash < 0 ? null : head.slice(dash + 1);
  const m = SEMVER.exec(semver);
  if (!m) return null;
  let build;
  if (pre === null) {
    const [b, c, ...more] = tail === null ? [] : tail.split('.');
    if (more.length || !BUILD_NUMBER.test(b || '') || (c !== undefined && !SHORT_COMMIT.test(c))) return null;
    build = Number(b);
  } else {
    if (!(pre.startsWith('dev.') && BUILD_NUMBER.test(pre.slice(4)))) return null;
    if (tail !== null && !SHORT_COMMIT.test(tail)) return null;
    build = Number(pre.slice(4));
  }
  if (Number(m[1]) > 255 || Number(m[2]) > 255 || build > 65535) return null;
  return { semver, version: m[1] + '.' + m[2] + '.' + build };
}

// ---------------------------------------------------------------- pure planners (held to by test/machine.test.js)

/** An icacls grant for a SID, inherited by files and folders: `*<sid>:(OI)(CI)<rights>`. */
const grant = (sid, rights) => '*' + sid + ':(OI)(CI)' + rights;
/** SYSTEM and Administrators in full control: what every folder of the machine folder begins with. */
const BASE_GRANTS = Object.freeze([grant(SID.system, 'F'), grant(SID.admins, 'F')]);
/**
 * The machine folder's children, each made with SYSTEM and Administrators in full control and its inheritance cut, and
 * what install adds to each (pure): the server task's SID (`task`: M, modify, on what it writes; on token\ too, since the
 * watchdog replaces the token by a rename, which needs delete) and the laptop's admin (`admin`: R, on the token it reads
 * and the logs AGMessage status shows). machine\ is SYSTEM and Administrators only; the task reads machine\events.jsonl
 * alone, by a grant on that file.
 */
const CHILDREN = Object.freeze([
  { name: 'data', task: 'M' },
  { name: 'uploads', task: 'M' },
  { name: 'keys', task: 'M' },
  { name: 'logs', task: 'M', admin: 'R' },
  { name: 'token', task: 'M', admin: 'R' },
  { name: 'machine' },
]);
/** machine\'s subfolders, SYSTEM and Administrators only (each account's inbox\<sid>\ and outbox\<sid>\ are made inside two). */
const MACHINE_SUBS = Object.freeze(['inbox', 'outbox', 'work', 'staged']);
/** What any signed-in account may do in setup\<random>\: create a file, never list or read one. */
const SETUP_GRANT = '*' + SID.authed + ':(WD,AD,WA)';
/**
 * An account's own inbox\<sid>\: it may add a file to the folder (WD on the folder alone) and write the files in it (W,
 * inherited by files alone), never make a folder or a junction there; and its outbox\<sid>\, which it may read (RX,
 * inherited inside). Each list's first grant is set with the folder's access list, each other one added after it.
 */
const inboxGrants = (sid) => ['*' + sid + ':(WD)', '*' + sid + ':(OI)(IO)W'];
const outboxGrants = (sid) => [grant(sid, 'RX')];

/** One command-line argument as Windows reads it (CommandLineToArgvW), for a task's <Arguments>. */
function winArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The server task's definition (Task Scheduler's schema 1.3; pure): LocalService under its own SID (ProcessTokenSidType
 * Unrestricted, so the task's SID is derived from its path), SeChangeNotifyPrivilege alone, a boot trigger, no time limit,
 * both battery settings false, a new instance ignored while one runs, RestartOnFailure 3 × 1 min; its action node.exe on
 * launch.js serve, both by their absolute paths, from launch.js's folder, with the folders, the machine's events file
 * (machine\events.jsonl, which the server reads and never writes) and the port; its descriptor SERVER_TASK_SDDL. No token
 * or password is in it. `uri` names it (the lane registers it under its own name).
 */
function serverTaskXml({ node, launch, data, uploads, keys, logs, token, events, port, uri = SERVER_TASK }) {
  const args = [launch, 'serve', '--data', data, '--uploads', uploads, '--keys', keys, '--logs', logs, '--token', token, '--events', events, '--port', String(port)];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>AGMessage serves on this PC, from boot, with nobody signed in.</Description>',
    '    <URI>' + xmlText(uri) + '</URI>',
    '    <SecurityDescriptor>' + SERVER_TASK_SDDL + '</SecurityDescriptor>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <BootTrigger><Enabled>true</Enabled></BootTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>' + SID.localService + '</UserId>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '      <ProcessTokenSidType>Unrestricted</ProcessTokenSidType>',
    '      <RequiredPrivileges><Privilege>SeChangeNotifyPrivilege</Privilege></RequiredPrivileges>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + xmlText(node) + '</Command>',
    '      <Arguments>' + xmlText(args.map(winArg).join(' ')) + '</Arguments>',
    '      <WorkingDirectory>' + xmlText(pathOf(launch).dirname(launch)) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * An account's control task's definition (Task Scheduler's schema 1.3; pure): SYSTEM, run on demand only (no trigger),
 * a request queued behind one that runs, both battery settings false, at most 10 minutes; its action node.exe on
 * machine.js control --for `sid`, both by their absolute paths, with the machine folder and the System32 folder, fixed at
 * registration; its descriptor controlSddl(`sid`). No token or password is in it.
 */
function controlTaskXml({ sid, node, script, machine, sys, uri = controlTask(sid) }) {
  const args = [script, 'control', '--for', sid, '--machine', machine, '--sys', sys];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>AGMessage: one Windows account\'s requests (Start, Stop, Who may run AGMessage), run as SYSTEM.</Description>',
    '    <URI>' + xmlText(uri) + '</URI>',
    '    <SecurityDescriptor>' + controlSddl(sid) + '</SecurityDescriptor>',
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>' + SID.system + '</UserId>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>Queue</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + xmlText(node) + '</Command>',
    '      <Arguments>' + xmlText(args.map(winArg).join(' ')) + '</Arguments>',
    '      <WorkingDirectory>' + xmlText(pathOf(script).dirname(script)) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * The firewall rules (answer 37; pure): the TCP rule on `node` for `port` and the UDP rule on `node` for discovery
 * (9928), each from the local subnet only, on Private and Domain, and Public only when `public`. A rule names the
 * program, the protocol and the local port, never node.exe alone, which would let any account's script take inbound
 * traffic. Made by NetSecurity's cmdlets (FIREWALL_ADD), each value handed in by name, never written into the script.
 */
function firewallRules({ node, port, public: pub = false }) {
  const profiles = pub ? ['Domain', 'Private', 'Public'] : ['Domain', 'Private'];
  return [
    { name: RULE_TCP, protocol: 'TCP', port, program: node, remote: 'LocalSubnet', profiles },
    { name: RULE_UDP, protocol: 'UDP', port: DISCOVERY_PORT, program: node, remote: 'LocalSubnet', profiles },
  ];
}

/**
 * The install record's values, as `reg add` writes them under HKLM\SOFTWARE\AGMessage in the 64-bit view (pure): each
 * {name, type, value}. `version` the install version (MAJOR.MINOR.BUILD), the order an installer and an upgrade compare;
 * `semver` the product's version; `previous` the install version an upgrade replaced (''); `admin` the laptop's admin's
 * SID and `adminName` its name (words only); `public` and `signed` flags. No token or password is among them.
 */
function recordValues({ dir, version, semver, previous = '', admin, adminName, port, public: pub = false, signed = false }) {
  return [
    { name: 'InstallDir', type: 'REG_SZ', value: dir },
    { name: 'Version', type: 'REG_SZ', value: version },
    { name: 'SemVer', type: 'REG_SZ', value: semver },
    { name: 'Previous', type: 'REG_SZ', value: previous },
    { name: 'Runs', type: 'REG_SZ', value: 'task' },
    { name: 'Port', type: 'REG_DWORD', value: String(port) },
    { name: 'Admin', type: 'REG_SZ', value: admin },
    { name: 'AdminName', type: 'REG_SZ', value: adminName },
    { name: 'PublicFirewall', type: 'REG_DWORD', value: pub ? '1' : '0' },
    { name: 'Signed', type: 'REG_DWORD', value: signed ? '1' : '0' },
  ];
}

/** An account as an event names it: its SID and the name Windows gave it (words only), each said. */
const accountSaid = (a) => ({ sid: isSid(a && a.sid) ? a.sid : '', name: said((a && a.name) || '', 120) });
/** The highest `seq` among a file's whole lines (pure): a line that is not an event's is passed over. */
function lastSeqOf(text) {
  let last = 0;
  for (const line of String(text || '').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; /* not a whole line: a torn end, or not an event's */ }
    if (e && Number.isSafeInteger(e.seq) && e.seq > last) last = e.seq;
  }
  return last;
}
/**
 * How long an append waits for another's lock, and how old a lock is before it is taken as one a crash left: a lock is held
 * for one read and one append, well under a second, and the stale age is below the wait, so a lock a crash left never
 * outlasts an append's wait.
 */
const EVENT_LOCK_WAIT_MS = 10_000;
const EVENT_LOCK_STALE_MS = 5000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * One machine event appended to machine\events.jsonl, which the server turns into its audit row: {seq, at, kind, by,
 * for, rights, words}, `by` and `for` accounts ({sid, name}), `rights` the rights it names, never a token, a password or a
 * path in a profile. The file is appended in place (its grant to the server's task is the file's own, so it is never
 * replaced), under machine\events.lock, made only where none is, so two control tasks never take one seq; `seq` is one
 * above the file's highest. Returns the seq.
 */
function appendEvent(machineDir, { kind, by = {}, forAccount = {}, rights = [], words = '' }, fsImpl = fs, { waitMs = EVENT_LOCK_WAIT_MS } = {}) {
  const P = pathOf(machineDir);
  const file = P.join(machineDir, 'events.jsonl');
  const lock = P.join(machineDir, 'events.lock');
  const until = Date.now() + waitMs;
  let fd;
  for (;;) {
    try { fd = fsImpl.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw notDone('machine\\events.lock could not be made (' + (e.code || e.message) + ')');
      let old;
      try { old = Date.now() - fsImpl.statSync(lock).mtimeMs > EVENT_LOCK_STALE_MS; } catch { old = false; /* gone since: tried again at once */ }
      if (old) { try { fsImpl.unlinkSync(lock); } catch { /* another took it first */ } continue; }
      if (Date.now() >= until) throw notDone('machine\\events.jsonl stayed locked for ' + waitMs / 1000 + ' s');
      pause(50);
    }
  }
  try {
    let text = '';
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw notDone('machine\\events.jsonl could not be read (' + (e.code || e.message) + ')'); }
    const seq = lastSeqOf(text) + 1;
    const line = JSON.stringify({ seq, at: Date.now(), kind, by: accountSaid(by), for: accountSaid(forAccount), rights: rights.filter((r) => RIGHTS.includes(r)), words: said(words, 300) }) + '\n';
    fsImpl.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line);
    return seq;
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* closed */ }
    try { fsImpl.unlinkSync(lock); } catch { /* removed already */ }
  }
}

/**
 * The owner SID in a security descriptor's SDDL (`O:<sid>` or an alias; pure): '' when it names none. SYSTEM's and
 * Administrators' aliases (SY, BA) are read as their SIDs, the two the acceptance check allows.
 */
function ownerSidOf(sddl) {
  const m = /O:([A-Za-z0-9-]+?)(?=[GDS]:|\s|$)/.exec(String(sddl));
  if (!m) return '';
  if (m[1] === 'SY') return SID.system;
  if (m[1] === 'BA') return SID.admins;
  return isSid(m[1]) ? m[1] : '';
}

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
/**
 * The server task's state and last result from `schtasks /query /fo csv /nh /v`, by column: the fourth its status (in
 * Windows' words, said as they are) and the seventh its last result, a number (pure).
 */
function taskStateOf(text) {
  const row = csvRows(text)[0];
  if (!row || row.length < 7) return null;
  const last = /^-?\d{1,12}$/.test(row[6].trim()) ? Number(row[6].trim()) : null;
  return { state: said(row[3], 40) || 'unknown', lastResult: last };
}

// ---------------------------------------------------------------- whose it is (the laptop's admin), pure

/**
 * Whether a SID names one person's account (pure): a local, domain or Microsoft account (S-1-5-21-<three>-<RID>, its RID
 * the built-in Administrator's 500 or 1000 and up) or an Entra ID account (S-1-12-1-<four>). Never Windows' own groups and
 * aliases (Everyone, Authenticated Users, S-1-5-32-…), a service (SYSTEM, LocalService, a task's or a service's SID) or a
 * domain's own groups (its RIDs under 1000 but 500): AGMessage's admin is one person's Windows account.
 */
function personSid(sid) {
  if (!isSid(sid)) return false;
  const m = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})$/.exec(sid);
  if (m) return Number(m[1]) === 500 || Number(m[1]) >= 1000;
  return /^S-1-12-1-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/.test(sid);
}
/** An account from `whoami /user /fo csv /nh` (pure): its first row's name and SID, by position; null when there is none. */
function accountOf(text) {
  const row = csvRows(text)[0];
  if (!row || row.length < 2) return null;
  const sid = row[1].trim();
  return isSid(sid) ? { name: said(row[0], 120), sid } : null;
}
/** The words for a reading that does not name a person (pure). */
function readingWhy(r, what) {
  if (!r || !r.sid) return what + ' could not be read' + (r && r.why ? ' (' + r.why + ')' : '');
  if (r.sid === SID.system) return what + ' is SYSTEM (a deployment), not a person\'s account';
  return what + ' is ' + (r.name || r.sid) + ', which is not one person\'s account';
}
/**
 * Whose AGMessage it is on this PC, from the plan's two readings (pure): `started`, the account that started Setup;
 * `screen`, the owner of explorer.exe in the installer's session; `approver`, the account the elevation runs as; `admin`,
 * the account /ADMIN named, already resolved (each {name, sid} or {why}). /ADMIN decides when it is given. Both readings
 * naming one person decide it, said with who approved. Otherwise the person chooses between the readings that name a
 * person, never a third; none is a refusal, which asks for /ADMIN. {admin, agree, choices, words, refused}.
 */
function whoseOf({ started = null, screen = null, approver = null, admin = null }) {
  const named = (r) => r.name || r.sid;
  const approved = (who) => (approver && isSid(approver.sid) && approver.sid !== who.sid ? ' ' + named(approver) + ' approved it and gets no AGMessage rights.' : '');
  if (admin) return { admin, agree: true, choices: [admin], words: 'AGMessage\'s admin on this PC will be ' + named(admin) + ', as /ADMIN names it.' + approved(admin) };
  const person = (r) => !!(r && personSid(r.sid));
  if (person(started) && person(screen) && started.sid === screen.sid) {
    return { admin: started, agree: true, choices: [started], words: 'AGMessage\'s admin on this PC will be ' + named(started) + ', the account that started this installer.' + approved(started) };
  }
  const choices = [];
  if (person(started)) choices.push(started);
  if (person(screen) && !choices.some((c) => c.sid === screen.sid)) choices.push(screen);
  const one = person(started) ? 'The account that started this installer is ' + named(started) : readingWhy(started, 'the account that started this installer');
  const two = person(screen) ? 'the account signed in at this screen is ' + named(screen) : readingWhy(screen, 'the account signed in at this screen');
  const both = one.charAt(0).toUpperCase() + one.slice(1) + ', and ' + two + '.';
  if (!choices.length) return { admin: null, agree: false, choices, refused: true, words: 'AGMessage needs to know whose it is: add /ADMIN=<account>. ' + both };
  return { admin: null, agree: false, choices, words: both + ' Choose ' + (choices.length === 1 ? 'it' : 'which of them is AGMessage\'s admin on this PC') + ': AGMessage\'s admin holds its token and gives the rights to start, stop and upgrade it. Nobody else is offered.' };
}
/**
 * The account /ADMIN named, as Windows resolved it (pure): {name, sid}, only when Windows confirms it is one person's
 * account on this PC: a SID Windows names (`translated`), of a person's shape (personSid), not a local group, and either a
 * local user (a Microsoft account signed in here is one) or an account with a profile on this PC (a domain or work
 * account that has signed in here; no group ever has one). Anything else is refused, fail closed, with its words: an
 * account Windows does not know, a group or a service, or one it cannot confirm (a domain or work account that has never
 * signed in here, or a group of a domain or of Entra ID, which share a person's shape).
 */
function adminOf(asked, answer) {
  const a = answer && typeof answer === 'object' ? answer : {};
  const who = said(a.name || asked, 80);
  if (!isSid(a.sid) || a.translated !== true) throw refusal('/ADMIN names "' + said(asked, 80) + '", which Windows does not know as an account on this PC' + (a.error ? ' (' + said(a.error, 120) + ')' : '') + '. Name one person\'s account: /ADMIN=LAPTOP\\ana.');
  if (a.group === true || !personSid(a.sid)) throw refusal('/ADMIN names ' + who + ', which is not one person\'s account (a group or a service). Give it to one person\'s account: /ADMIN=LAPTOP\\ana.');
  if (a.user !== true && a.profile !== true && a.lookupError) throw refusal('/ADMIN names ' + who + ', which Windows cannot confirm is one person\'s account on this PC: its local accounts could not be read (' + said(a.lookupError, 120) + ') and the account has never signed in here. Name an account that has signed in to this PC once.');
  if (a.user !== true && a.profile !== true) throw refusal('/ADMIN names ' + who + ', which Windows cannot confirm is one person\'s account on this PC: it is no local account and has never signed in here (a group of a domain or of Entra ID is neither). Name a local account, or one that has signed in to this PC once.');
  return { name: said(a.name || asked, 120), sid: a.sid };
}

// ---------------------------------------------------------------- the programs of {app}, pure

/**
 * Whether a program running from {app} is the server task's own (pure): node.exe on launch.js serve, the watchdog
 * (supervise.js) or the server (server.js) beside it, or the server's cloudflared. Read from its executable's name and its
 * command line, never kept: anything else from {app} is a person's console of the Start menu (launch.js token, status or
 * open) or a program nobody named.
 */
function serverProgram(p) {
  const name = String((p && p.name) || '').toLowerCase();
  const cmd = String((p && p.cmd) || '');
  if (name === 'cloudflared.exe') return true;
  if (name !== 'node.exe') return false;
  return /[\\/]app[\\/](?:supervise|server)\.js"?(?:\s|$)/i.test(cmd) || /[\\/]app[\\/]launch\.js"?\s+serve(?:\s|$)/i.test(cmd);
}
/** A kept installer's name in {app}\installers\ (the installer keeps itself there by its install version). */
const KEPT_INSTALLER = /^AGMessage-Setup-\d{1,3}\.\d{1,3}\.\d{1,5}-unsigned\.exe$/i;
/**
 * The programs of {app} without the installer's own chain (pure): a kept installer (an AGMessage-Setup-…-unsigned.exe
 * directly in {app}\installers\, which only an elevated install lays there) that is an ancestor of this process is the
 * installer running this check, waiting for it to end, so it and every program of that same file (the instance that asked
 * for the elevation) are left out. Its file is never replaced by the install it runs. Any other program of {app}, an
 * ancestor or not, stays: a kept installer this check was not run by, or a node.exe of {app}, holds what an install replaces.
 */
function outsideOwnChain(list, app) {
  const dir = path.win32.join(String(app), 'installers').toLowerCase();
  const kept = (p) => path.win32.dirname(p.exe).toLowerCase() === dir && KEPT_INSTALLER.test(path.win32.basename(p.exe));
  const mine = new Set(list.filter((p) => p.ancestor === true && p.exe && kept(p)).map((p) => p.exe.toLowerCase()));
  return list.filter((p) => !(p.exe && mine.has(p.exe.toLowerCase())));
}
/** Programs as words (pure): "node.exe (pid 4120), …", at most three named. */
function programWords(list) {
  const named = list.slice(0, 3).map((p) => said(p.name || 'a program', 40) + ' (pid ' + p.pid + ')');
  return named.join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '');
}

// ---------------------------------------------------------------- argument parsing

/** The verbs. */
const VERBS = Object.freeze(['prepare', 'install', 'uninstall', 'preinstall-check', 'upgrade-stop', 'status', 'restore', 'whose', 'start', 'first-account', 'control', 'import', 'upgrade']);
/** A later unit's verb, refused by its unit's name until it lands: none now. */
const LATER = Object.freeze({});
/** The flags (no value). */
const FLAGS = new Set(['--public', '--signed', '--remove-data', '--rollback', '--elevated']);
/** Each verb's options, each at most once: any other is refused, never ignored. */
const VERB_OPTS = Object.freeze({
  prepare: ['--machine', '--sys', '--out'],
  install: ['--machine', '--app', '--sys', '--build', '--port', '--admin', '--admin-name', '--public', '--signed', '--rollback', '--out'],
  uninstall: ['--machine', '--sys', '--port', '--force', '--remove-data', '--app', '--out'],
  'preinstall-check': ['--machine', '--sys', '--port', '--force', '--app', '--rollback', '--upgrade-by', '--out'],
  'upgrade-stop': ['--machine', '--sys', '--port', '--by', '--force', '--app', '--out'],
  status: ['--machine', '--sys', '--port', '--out'],
  restore: ['--machine', '--backup', '--port', '--out'],
  whose: ['--machine', '--sys', '--started', '--admin', '--out'],
  start: ['--machine', '--sys', '--port', '--build', '--out'],
  'first-account': ['--machine', '--port', '--account', '--build', '--out'],
  control: ['--for', '--elevated', '--request', '--machine', '--sys', '--out'],
  import: ['--step', '--for', '--machine', '--sys', '--app', '--source', '--id', '--out'],
  upgrade: ['--step', '--plan', '--sys', '--out'],
});

/** The command line, read: {verb, opts} or {problem}. No value is a path read from the environment: each is an argument. */
function parse(argv) {
  const [verb, ...rest] = argv;
  if (!verb) return { problem: 'machine.js takes a command: ' + VERBS.join(', ') + '.' };
  if (Object.hasOwn(LATER, verb)) return { problem: 'machine.js ' + verb + ' is built by ' + LATER[verb] + '; it is not one of this build\'s commands (' + VERBS.join(', ') + ').' };
  if (!VERBS.includes(verb)) return { problem: '"' + said(verb, 40) + '" is not one of machine.js\'s commands (' + VERBS.join(', ') + ').' };
  const allowed = VERB_OPTS[verb];
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!allowed.includes(a)) return { problem: '"' + said(a, 40) + '" is not an argument machine.js ' + verb + ' knows.' };
    if (Object.hasOwn(opts, a)) return { problem: a + ' is given twice.' };
    if (FLAGS.has(a)) { opts[a] = true; continue; }
    if (i + 1 >= rest.length) return { problem: a + ' needs a value.' };
    opts[a] = rest[++i];
  }
  return { verb, opts };
}

/** A required option that is a full path (fullPath), or a usage error naming it. */
function needPath(opts, name, { platform = process.platform } = {}) {
  const v = opts[name];
  if (!v) throw usage('machine.js needs ' + name + ' <folder>, a full path.');
  if (!fullPath(v, platform)) throw usage(name + ' is "' + said(v, 120) + '", which is not a full path from a drive or a share.');
  return v;
}
/** A port option (1-65535), required unless `optional`; a usage error otherwise. */
function needPort(opts, { optional = false } = {}) {
  const v = opts['--port'];
  if (v === undefined && optional) return 0;
  const port = /^\d{1,5}$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage('machine.js needs --port <1-65535>, the port AGMessage serves on.');
  return port;
}

// ---------------------------------------------------------------- the Windows hands, each by its absolute path

/** powershell.exe's place under System32, and the one module folder it is given (Windows' own). */
const POWERSHELL = 'WindowsPowerShell\\v1.0\\powershell.exe';
/**
 * The programs this unit runs, each by its absolute path in the System32 folder `sys` names (never a bare name, which
 * Windows looks for in the current folder and on PATH first), each from that folder: schtasks, icacls, reg, whoami and
 * powershell. powershell.exe runs one fixed script, its values handed in by name in an environment of its own (the
 * Windows folder, its drive and Temp, and Windows' own module path, each made from `sys`; nothing of this process's), and
 * answers one line of JSON. `run` is
 * childProcess.execFileSync unless a test stands in for it.
 */
function hands(sys, run = childProcess.execFileSync) {
  if (!DRIVE_PATH.test(String(sys || ''))) throw usage('--sys is "' + said(sys || '', 80) + '", which does not name the System32 folder from its drive (C:\\Windows\\System32).');
  const exe = (name) => path.win32.join(sys, name);
  const call = (name, args, env) => {
    try {
      const out = run(exe(name), args, { cwd: sys, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
      return { code: 0, out: String(out || '') };
    } catch (e) {
      return { code: Number.isInteger(e && e.status) ? e.status : 1, out: String((e && e.stdout) || ''), err: said((e && (e.stderr || e.message)) || '', 300) };
    }
  };
  const powershell = (script, values = {}) => {
    // Windows' own folders, made from `sys` alone: the Windows folder, its drive, its Temp (SYSTEM's own) and Windows'
    // module folder, so no module path or temporary folder of the account that started the installer is used.
    const root = path.win32.dirname(sys);
    const temp = path.win32.join(root, 'Temp');
    const env = { SystemRoot: root, windir: root, SystemDrive: root.slice(0, 2), TEMP: temp, TMP: temp, PSModulePath: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules'), ...values };
    const r = call(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], env);
    const line = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    let json;
    try { json = line ? JSON.parse(line) : null; } catch { json = null; /* not its answer: said below */ }
    if (!json || typeof json !== 'object') return { error: 'powershell.exe gave no answer (exit ' + r.code + (r.err ? ': ' + r.err : '') + ')' };
    return json;
  };
  return {
    schtasks: (args) => call('schtasks.exe', args),
    icacls: (args) => call('icacls.exe', args),
    reg: (args) => call('reg.exe', args),
    whoami: (args) => call('whoami.exe', args),
    powershell,
  };
}

// The scripts, one line each, single quotes only. Each imports the modules it uses by their manifests' paths under $PSHOME
// (Windows' own), answers one line of JSON with every character past ASCII written \uXXXX, and says why where Windows
// refuses. A value is read from the environment it is handed (AGM_…), never written into the script.
const PS_HEAD = String.raw`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
function AgmUse($m) { $d = $PSHOME + '\Modules\' + $m; $p = $d + '\' + $m + '.psd1'; if (-not [System.IO.File]::Exists($p)) { $v = @(foreach ($x in [System.IO.Directory]::GetDirectories($d)) { if ([System.IO.File]::Exists($x + '\' + $m + '.psd1')) { $x } }); if ($v.Count -ne 1) { throw ('the module ' + $m + ' is not in ' + $d) }; $p = $v[0] + '\' + $m + '.psd1' }; Import-Module $p };
function AgmWhy($e) { $r = [string]$e.CategoryInfo.Reason; if ($r -eq 'RuntimeException' -or -not $r) { $r = [string]$e.Exception.Message }; return $r };
function AgmAscii($j) { return (-join @(foreach ($c in $j.ToCharArray()) { if ([int]$c -gt 126) { '\u{0:x4}' -f [int]$c } else { [string]$c } })) };
function AgmSay($h) { return (AgmAscii (ConvertTo-Json -InputObject $h -Depth 4 -Compress)) };
AgmUse 'Microsoft.PowerShell.Utility';`;
const oneLine = (s) => s.trim().replace(/\s*\n\s*/g, ' ');
/** The owner of AGM_PATH, as its security descriptor's SDDL: {sddl} or {error}. */
const PS_OWNER = oneLine(PS_HEAD + String.raw`
try { AgmUse 'Microsoft.PowerShell.Security'; $a = Get-Acl -LiteralPath $env:AGM_PATH; AgmSay @{ sddl = [string]$a.Sddl } } catch { AgmSay @{ error = (AgmWhy $_) } }`);
/** The two rules made again: each removed when there, then added by program, protocol, local port, remote and profiles. */
const PS_FIREWALL_ADD = oneLine(PS_HEAD + String.raw`
try {
  AgmUse 'NetSecurity';
  foreach ($n in @($env:AGM_RULE_TCP, $env:AGM_RULE_UDP)) { Remove-NetFirewallRule -Name $n -ErrorAction SilentlyContinue };
  $p = @($env:AGM_PROFILES -split ',');
  New-NetFirewallRule -Name $env:AGM_RULE_TCP -DisplayName ('AGMessage (TCP ' + $env:AGM_PORT + ')') -Direction Inbound -Action Allow -Program $env:AGM_NODE -Protocol TCP -LocalPort $env:AGM_PORT -RemoteAddress LocalSubnet -Profile $p -Enabled True | Out-Null;
  New-NetFirewallRule -Name $env:AGM_RULE_UDP -DisplayName ('AGMessage discovery (UDP ' + $env:AGM_UDP + ')') -Direction Inbound -Action Allow -Program $env:AGM_NODE -Protocol UDP -LocalPort $env:AGM_UDP -RemoteAddress LocalSubnet -Profile $p -Enabled True | Out-Null;
  AgmSay @{ ok = $true }
} catch { AgmSay @{ error = (AgmWhy $_) } }`);
/** The two rules removed: {removed, missing} or {error}. */
const PS_FIREWALL_REMOVE = oneLine(PS_HEAD + String.raw`
try {
  AgmUse 'NetSecurity'; $removed = @(); $missing = @();
  foreach ($n in @($env:AGM_RULE_TCP, $env:AGM_RULE_UDP)) { if (@(Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue).Count) { Remove-NetFirewallRule -Name $n; $removed += $n } else { $missing += $n } };
  AgmSay @{ removed = $removed; missing = $missing }
} catch { AgmSay @{ error = (AgmWhy $_) } }`);
/** The port's listening pid (Get-NetTCPConnection) and the newest code-integrity event naming AGM_NODE_TAIL's node.exe. */
const PS_STATUS = oneLine(PS_HEAD + String.raw`
$o = @{};
try { AgmUse 'NetTCPIP'; $c = @(Get-NetTCPConnection -LocalPort ([int]$env:AGM_PORT) -State Listen -ErrorAction SilentlyContinue); if ($c.Count) { $o.pid = [int64]$c[0].OwningProcess } else { $o.pid = 0 } } catch { $o.pidError = (AgmWhy $_) };
try {
  AgmUse 'Microsoft.PowerShell.Diagnostics'; $tail = ([string]$env:AGM_NODE_TAIL).ToLowerInvariant();
  $e = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; Id = 3033, 3077 } -MaxEvents 500 -ErrorAction SilentlyContinue | Where-Object { $hit = $false; foreach ($p in $_.Properties) { if (([string]$p.Value).ToLowerInvariant().EndsWith($tail)) { $hit = $true } }; $hit });
  if ($e.Count) { $o.codeIntegrity = @{ found = $true; id = [int]$e[0].Id; at = $e[0].TimeCreated.ToUniversalTime().ToString('o') } } else { $o.codeIntegrity = @{ found = $false } }
} catch { $o.codeIntegrityError = (AgmWhy $_) };
AgmSay $o`);
/**
 * Whose it is, read by Windows: the owners of explorer.exe in this process's session (the plan's second reading, by
 * Win32_Process's GetOwnerSid), the names of AGM_SIDS and of those owners, and the account AGM_ACCOUNT names (/ADMIN),
 * resolved to its SID, with whether Windows names it (`translated`), whether it is a local group or a local user, and
 * whether it has a profile on this PC (ProfileList: an account that has signed in here, which a group never has).
 */
const PS_WHOSE = oneLine(PS_HEAD + String.raw`
$o = @{};
try {
  AgmUse 'Microsoft.PowerShell.Management'; AgmUse 'CimCmdlets'; $s = [int](Get-Process -Id $PID).SessionId; $o.session = $s; $w = @();
  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter ('Name = ''explorer.exe'' AND SessionId = ' + $s))) { $r = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($r.ReturnValue -eq 0) { $w += [string]$r.Sid } };
  $o.screen = @($w | Select-Object -Unique)
} catch { $o.screenError = (AgmWhy $_) };
$names = @{};
foreach ($x in @(@(([string]$env:AGM_SIDS) -split ',') + @($o.screen))) { if ($x -match '^S-1-[0-9-]+$' -and -not $names.ContainsKey($x)) { try { $names[$x] = [string](New-Object System.Security.Principal.SecurityIdentifier($x)).Translate([System.Security.Principal.NTAccount]).Value } catch { $names[$x] = '' } } };
$o.names = $names;
if ($env:AGM_ACCOUNT) {
  try {
    $n = [string]$env:AGM_ACCOUNT; if ($n -match '^S-1-') { $sid = New-Object System.Security.Principal.SecurityIdentifier($n) } else { $sid = (New-Object System.Security.Principal.NTAccount($n)).Translate([System.Security.Principal.SecurityIdentifier]) };
    $a = @{ sid = [string]$sid.Value; name = ''; translated = $false; group = $false; user = $false; profile = $false };
    try { $a.name = [string]$sid.Translate([System.Security.Principal.NTAccount]).Value; $a.translated = $true } catch { $a.name = '' };
    try { AgmUse 'Microsoft.PowerShell.LocalAccounts'; $a.group = (@(Get-LocalGroup -SID $sid -ErrorAction SilentlyContinue).Count -gt 0); $a.user = (@(Get-LocalUser -SID $sid -ErrorAction SilentlyContinue).Count -gt 0) } catch { $a.group = $false; $a.user = $false; $a.lookupError = (AgmWhy $_) };
    try { AgmUse 'Microsoft.PowerShell.Management'; $a.profile = [bool](Test-Path -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + [string]$sid.Value)) } catch { $a.profile = $false };
    $o.account = $a
  } catch { $o.accountError = (AgmWhy $_) }
};
AgmSay $o`);
/**
 * Every program whose executable is under AGM_APP: its pid, its name, its command line (classified, never kept), its
 * executable and whether it is an ancestor of this script (its parent's chain from $PID, each parent made before its
 * child, so a pid Windows gave again to a later program is never taken for a parent).
 */
const PS_PROGRAMS = oneLine(PS_HEAD + String.raw`
try {
  AgmUse 'CimCmdlets'; $app = ([string]$env:AGM_APP).TrimEnd('\') + '\'; $o = @(); $all = @{};
  foreach ($p in @(Get-CimInstance -ClassName Win32_Process)) { $all[[int64]$p.ProcessId] = $p };
  $up = @(); $c = $all[[int64]$PID];
  for ($i = 0; $c -and $i -lt 32; $i++) { $q = $all[[int64]$c.ParentProcessId]; if (-not $q -or [int64]$q.ProcessId -eq [int64]$c.ProcessId -or ($q.CreationDate -and $c.CreationDate -and $q.CreationDate -gt $c.CreationDate)) { break }; $up += [int64]$q.ProcessId; $c = $q };
  foreach ($p in @($all.Values)) { $x = [string]$p.ExecutablePath; if ($x -and $x.StartsWith($app, [System.StringComparison]::OrdinalIgnoreCase)) { $o += @{ pid = [int64]$p.ProcessId; name = [string]$p.Name; cmd = [string]$p.CommandLine; exe = $x; ancestor = ($up -contains [int64]$p.ProcessId) } } };
  AgmSay @{ programs = $o }
} catch { AgmSay @{ error = (AgmWhy $_) } }`);

// ---------------------------------------------------------------- the record, the folder and its reads

/**
 * The HKLM record read: {exists, installed, values}, `installed` when an install wrote it (its InstallDir), `values` the
 * pairs read by reg.exe's fixed layout (four spaces, the name, its REG_ type, the value), never a secret: it holds none.
 */
function readRecord(H) {
  const r = H.reg(['query', HKLM, '/reg:64']);
  if (r.code !== 0) return { exists: false, installed: false, values: {} };
  const values = {};
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^ {4}([A-Za-z]{1,40}) {4}(REG_[A-Z_]{2,20}) {4}(.*)$/.exec(line);
    if (m) values[m[1]] = m[2] === 'REG_DWORD' && /^0x[0-9a-f]{1,8}$/i.test(m[3].trim()) ? String(Number(m[3].trim())) : m[3].trim();
  }
  return { exists: true, installed: !!values.InstallDir, values };
}
/** The grants from the record's Grants key (one value per SID: its rights). */
function readGrants(H) {
  const r = H.reg(['query', HKLM + '\\Grants', '/reg:64']);
  if (r.code !== 0) return {};
  const out = {};
  for (const line of r.out.split(/\r?\n/)) { const m = /^ {4}(S-1-[0-9-]{1,120}) {4}REG_SZ {4}(.*)$/.exec(line); if (m) out[m[1]] = said(m[2], 120); }
  return out;
}
/** A record value written (`reg add`), or not done with its words. */
function writeValue(H, v) {
  const r = H.reg(['add', HKLM, '/v', v.name, '/t', v.type, '/d', v.value, '/f', '/reg:64']);
  if (r.code !== 0) throw notDone('the install record\'s ' + v.name + ' could not be written (' + (r.err || 'reg.exe ended with ' + r.code) + ').');
}
/** An icacls call that must work: not done, naming what it was for, when it did not. */
function mustGrant(H, args, what) {
  const r = H.icacls(args);
  if (r.code !== 0) throw notDone(what + '\'s access list could not be set (' + (r.err || 'icacls.exe ended with ' + r.code) + ').');
  return r;
}
/** A real directory (not a link, junction or reparse point) by lstat, or why not. */
function realDir(fsImpl, dir) {
  let st;
  try { st = fsImpl.lstatSync(dir); } catch (e) { return { ok: false, why: 'could not be read (' + (e.code || e.message) + ')' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, why: 'is not a real directory (a file, a link or a reparse point)' };
  return { ok: true };
}
/**
 * A folder made non-recursively for the machine folder: made now ({made: true}); or, where `fresh` is false, one already
 * there that lstat shows a real directory ({made: false}). Where `fresh` (its root made empty by this run, listed empty
 * since), one already there was made by another account after the listing: refused.
 */
function makeFolder(fsImpl, dir, label, { fresh }) {
  try { fsImpl.mkdirSync(dir); return { made: true }; } catch (e) {
    if (e.code !== 'EEXIST') throw notDone(label + ' could not be made (' + (e.code || e.message) + ').');
  }
  if (fresh) throw refusal(label + ' (' + dir + ') was made by another account after the machine folder was made empty and listed: it is not AGMessage\'s. Nothing was installed.');
  const real = realDir(fsImpl, dir);
  if (!real.ok) throw refusal(label + ' (' + dir + ') ' + real.why + ': it is not AGMessage\'s to take. Nothing was installed.');
  return { made: false };
}

/** The token, read from the token folder the machine folder holds (<machine>\token\admin-token), or ''. */
function tokenFrom(root, fsImpl = fs) {
  try { return String(fsImpl.readFileSync(pathOf(root).join(root, 'token', 'admin-token'), 'utf8')).trim(); } catch { return ''; /* none, or not readable: said by the caller */ }
}

// ---------------------------------------------------------------- prepare: the machine folder, race-free

/**
 * prepare: the machine folder made before anything is installed, in the plan's order. 1. The root, non-recursively; an
 * existing one taken only when the record shows an earlier install, a prepare of this root no install finished
 * (`Prepared`) or the data an uninstall kept (`Kept`), lstat shows a real directory and its owner (read by Get-Acl) is SYSTEM or Administrators. 2. At once, its
 * inheritance cut and SYSTEM and Administrators in full control, by SID, never /T. 3. The root listed: a root made empty
 * that holds anything now is refused; a root made now is then marked `Prepared` in the record. 4. Each child made (or, in
 * a root that was there, found a real directory) with its own grants, then machine\'s subfolders. 5. setup\<128 random
 * bits>\, where any signed-in account may create a file and none may list or read. {root, setup, calls}.
 */
function prepare(opts, { run = childProcess.execFileSync, fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  const calls = [];
  const track = (args, what) => { const r = mustGrant(H, args, what); calls.push({ name: 'icacls', args }); return r; };
  // 1. The root, non-recursive. An existing one taken only when every one of the three holds.
  let fresh = false;
  try { fsImpl.mkdirSync(root); fresh = true; } catch (e) {
    if (e.code !== 'EEXIST') throw notDone('the machine folder ' + root + ' could not be made (' + (e.code || e.message) + ').');
    const record = readRecord(H);
    const names = (v) => typeof v === 'string' && v.toLowerCase() === root.toLowerCase();
    // An earlier install's root; one a prepare made that no install finished (`Prepared`); or the data an uninstall kept
    // (`Kept`): each written to HKLM by an elevated step of AGMessage's alone.
    if (!record.installed && !names(record.values.Prepared) && !names(record.values.Kept)) throw refusal(root + ' is there, and the install record shows no earlier AGMessage install and no data an uninstall kept: it is not AGMessage\'s to take. Remove it, then install again.');
    const real = realDir(fsImpl, root);
    if (!real.ok) throw refusal(root + ' is there and ' + real.why + ': it is not AGMessage\'s to take.');
    const acl = H.powershell(PS_OWNER, { AGM_PATH: root });
    calls.push({ name: 'powershell', args: ['owner', root] });
    const owner = acl.error ? '' : ownerSidOf(acl.sddl);
    if (owner !== SID.system && owner !== SID.admins) {
      throw refusal(root + ' is there and ' + (acl.error ? 'its owner could not be read (' + said(acl.error, 160) + ')' : 'is owned by ' + (owner || 'an account not named') + ', not SYSTEM or Administrators') + ': it is not AGMessage\'s to take.');
    }
  }
  // 2. At once: inheritance cut, SYSTEM and Administrators in full control, by SID, never /T.
  track([root, '/inheritance:r', '/grant:r', ...BASE_GRANTS], 'the machine folder');
  // 3. The root listed: anything another account added between the mkdir and the grant means refuse.
  let there;
  try { there = fsImpl.readdirSync(root); } catch (e) { throw notDone(root + ' could not be listed after it was made (' + (e.code || e.message) + ').'); }
  if (fresh && there.length) throw refusal(root + ' was made empty, and now holds ' + there.slice(0, 5).map((n) => said(n, 40)).join(', ') + ': another account added to it. Nothing was installed.');
  // A root this run made is the install's to take again until an install records it, should this one not finish.
  if (fresh) writeValue(H, { name: 'Prepared', type: 'REG_SZ', value: root });
  // 4. Each child, non-recursive, a real directory, with its own grants.
  for (const child of CHILDREN) {
    const dir = P.join(root, child.name);
    makeFolder(fsImpl, dir, 'the ' + child.name + ' folder', { fresh });
    track([dir, '/inheritance:r', '/grant:r', ...BASE_GRANTS], 'the ' + child.name + ' folder');
  }
  for (const sub of MACHINE_SUBS) makeFolder(fsImpl, P.join(root, 'machine', sub), 'machine\\' + sub, { fresh });
  // 5. setup\<128 random bits>\: any signed-in account may create a file, none may list or read; removed by install.
  const setupDir = P.join(root, 'setup');
  makeFolder(fsImpl, setupDir, 'the setup folder', { fresh });
  const setup = P.join(setupDir, crypto.randomBytes(16).toString('hex'));
  makeFolder(fsImpl, setup, 'the setup folder', { fresh: true });
  track([setup, '/inheritance:r', '/grant:r', ...BASE_GRANTS, SETUP_GRANT], 'the setup folder');
  // setup's name is said in --out alone, which the installer reads: an account that knew it could drop a file there first.
  return { root, setup, calls, words: 'The machine folder is ready: ' + root + '.' };
}

// ---------------------------------------------------------------- install: the server task, the rules, the record

/**
 * The folder an account's own inbox\<sid>\ or outbox\<sid>\ is, made with SYSTEM, Administrators and its grants
 * (inboxGrants, outboxGrants): the first set with the access list, each other one added by an icacls of its own, so no two
 * grants to one SID ever meet in one call.
 */
function accountFolder(H, fsImpl, root, box, sid, accountGrants) {
  const P = pathOf(root);
  const dir = P.join(root, 'machine', box, sid);
  const label = 'machine\\' + box + '\\' + sid;
  makeFolder(fsImpl, dir, label, { fresh: false });
  const [first, ...more] = accountGrants;
  mustGrant(H, [dir, '/inheritance:r', '/grant:r', ...BASE_GRANTS, first], label);
  for (const g of more) mustGrant(H, [dir, '/grant', g], label);
}

/**
 * An account's control task registered from its definition (controlTaskXml), written as UTF-16 into machine\work\
 * (SYSTEM and Administrators only) and removed once registered; not done, with Windows' words, when it is not.
 */
function registerControl(H, fsImpl, { root, sys, node, script, sid }) {
  const P = pathOf(root);
  const file = P.join(root, 'machine', 'work', 'control-' + crypto.randomBytes(6).toString('hex') + '.xml');
  const xml = controlTaskXml({ sid, node, script, machine: root, sys });
  fsImpl.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]), { flag: 'wx' });
  const made = H.schtasks(['/Create', '/TN', controlTask(sid), '/XML', file, '/F']);
  try { fsImpl.unlinkSync(file); } catch { /* left in machine\work\, which no one else reads; it holds no secret */ }
  if (made.code !== 0) throw notDone('the control task ' + controlTask(sid) + ' could not be registered (' + (made.err || 'schtasks.exe ended with ' + made.code) + ').');
}

/**
 * install: the machine-level parts, after prepare and the files. `--app` is {app}, the install's folder, holding
 * node\node.exe and app\launch.js. The server task registered from its definition; its SID (schtasks /showsid) given what
 * it may use, and the laptop's admin its reads and its inbox\ and outbox\, every grant checked; the firewall rules made;
 * the one record written last (an upgrade keeps the laptop's admin and records the install version it replaced as
 * Previous); `machine.admin` appended only when the admin is first recorded; setup\ removed.
 */
function install(opts, { run = childProcess.execFileSync, fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const app = needPath(opts, '--app');
  const H = hands(opts['--sys'], run);
  const built = installOf(String(opts['--build'] || ''));
  if (!built) throw usage('install needs --build <full build>, a release or a CI build as lib/version.js composes one (0.6.0+41.abc1234, 0.6.0-dev.41+abc1234): a local build has no install version and is not installed.');
  const port = needPort(opts);
  const P = pathOf(root);
  const A = pathOf(app);
  const node = A.join(app, 'node', 'node.exe');
  const launch = A.join(app, 'app', 'launch.js');
  const script = A.join(app, 'app', 'machine.js');
  for (const f of [node, launch, script]) if (!fsImpl.existsSync(f)) throw usage('--app is ' + app + ', which holds no ' + f + ': it is the install\'s folder ({app}), the one that holds node\\node.exe, app\\launch.js and app\\machine.js.');
  const record = readRecord(H);
  // The laptop's admin: found once, at the first install; an upgrade keeps the record's (only a handover changes it).
  const kept = isSid(record.values.Admin);
  const asked = String(opts['--admin'] || '');
  if (!kept && !isSid(asked)) throw usage('install needs --admin <SID>, the laptop\'s admin (its Windows account\'s SID, never its name), at the first install.');
  if (asked && !isSid(asked)) throw usage('--admin is "' + said(asked, 80) + '", which is not a SID.');
  const admin = kept ? record.values.Admin : asked;
  const adminName = kept ? said(record.values.AdminName || '', 120) : said(opts['--admin-name'] || '', 120);
  const folder = (name) => P.join(root, name);
  // The server task, from its definition (UTF-16), in machine\work\ (SYSTEM and Administrators only), then removed.
  const xml = serverTaskXml({ node, launch, data: folder('data'), uploads: folder('uploads'), keys: folder('keys'), logs: folder('logs'), token: folder('token'), events: P.join(root, 'machine', 'events.jsonl'), port });
  const xmlFile = P.join(root, 'machine', 'work', 'server-task.xml');
  fsImpl.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]));
  const made = H.schtasks(['/Create', '/TN', SERVER_TASK, '/XML', xmlFile, '/F']);
  try { fsImpl.unlinkSync(xmlFile); } catch { /* left in machine\work\, which no one else reads; it holds no secret */ }
  if (made.code !== 0) throw notDone('the server task could not be registered (' + (made.err || 'schtasks.exe ended with ' + made.code) + ').');
  // Its SID, derived from its path, given what it may use.
  const shown = H.schtasks(['/ShowSid', '/TN', SERVER_TASK]);
  const taskSid = shown.code === 0 ? ((/\bS-1-5-[0-9-]{3,140}/.exec(shown.out) || [''])[0]).replace(/-+$/, '') : '';
  if (!isSid(taskSid)) throw notDone('the server task\'s SID could not be read (schtasks /ShowSid: ' + (shown.err || 'no SID in its answer') + '), so no folder was given to it.');
  for (const child of CHILDREN) {
    if (child.task) mustGrant(H, [folder(child.name), '/grant:r', grant(taskSid, child.task)], 'the ' + child.name + ' folder');
    if (child.admin) mustGrant(H, [folder(child.name), '/grant:r', grant(admin, child.admin)], 'the ' + child.name + ' folder');
  }
  // The task reads machine\events.jsonl, that file alone: it lists nothing else of machine\ (SeChangeNotifyPrivilege
  // lets it open the file by its path).
  const events = P.join(root, 'machine', 'events.jsonl');
  try { fsImpl.appendFileSync(events, ''); } catch (e) { throw notDone('machine\\events.jsonl could not be made (' + (e.code || e.message) + ').'); }
  mustGrant(H, [events, '/grant:r', '*' + taskSid + ':(R)'], 'machine\\events.jsonl');
  // The laptop's admin's own inbox\ and outbox\ and control task; on an upgrade, each account given a right has its
  // control task registered again from this build's definition (its folders and grants are kept).
  accountFolder(H, fsImpl, root, 'inbox', admin, inboxGrants(admin));
  accountFolder(H, fsImpl, root, 'outbox', admin, outboxGrants(admin));
  const grantees = Object.keys(readGrants(H)).filter((sid) => personSid(sid) && sid !== admin);
  for (const sid of [admin, ...grantees]) registerControl(H, fsImpl, { root, sys: opts['--sys'], node, script, sid });
  // The firewall rules, by program, protocol and port.
  const rules = firewallRules({ node, port, public: !!opts['--public'] });
  const fw = H.powershell(PS_FIREWALL_ADD, { AGM_RULE_TCP: RULE_TCP, AGM_RULE_UDP: RULE_UDP, AGM_NODE: node, AGM_PORT: String(port), AGM_UDP: String(DISCOVERY_PORT), AGM_PROFILES: rules[0].profiles.join(',') });
  if (fw.error || fw.ok !== true) throw notDone('the firewall rules could not be made (' + said(fw.error || 'no answer', 200) + ').');
  // The one install record, written last: by SID, no secret.
  // Previous is the build an upgrade replaced, the one the way back lays down; the way back itself leaves none (the build
  // it replaced is the newer one that did not start, never one to go back to).
  const previous = opts['--rollback'] ? '' : record.values.Version && record.values.Version !== built.version ? record.values.Version : (record.values.Previous || '');
  for (const v of recordValues({ dir: app, version: built.version, semver: built.semver, previous, admin, adminName, port, public: !!opts['--public'], signed: !!opts['--signed'] })) writeValue(H, v);
  for (const mark of ['Prepared', 'Kept']) if (record.values[mark] !== undefined) H.reg(['delete', HKLM, '/v', mark, '/f', '/reg:64']);
  let unrecorded = '';
  if (!kept) {
    const who = { sid: admin, name: adminName };
    try { appendEvent(folder('machine'), { kind: 'machine.admin', by: who, forAccount: who, rights: RIGHTS, words: 'AGMessage was installed on this PC; its admin here is ' + (adminName || admin) + ', with every right and the giving of them.' }, fsImpl); } catch (e) {
      unrecorded = ' No machine event names its admin, so the audit log will not show it: ' + e.words + '.';
    }
  }
  // setup\ held the one-time readings of who started the installer; removed at the install's end.
  let setupLeft = '';
  try { fsImpl.rmSync(folder('setup'), { recursive: true, force: true }); } catch (e) { setupLeft = e.code || e.message; }
  const keptWords = kept && asked && asked !== admin ? ' The laptop\'s admin stays ' + (adminName || admin) + ' (an upgrade keeps it; a handover changes it).' : '';
  return {
    taskSid, admin, version: built.version, previous,
    words: 'AGMessage ' + built.semver + ' (install version ' + built.version + ') is installed: the server task, the firewall rules and the record are set.' + keptWords + unrecorded + (setupLeft ? ' The setup folder could not be removed (' + said(setupLeft, 40) + '); it holds nothing anyone may read.' : ''),
  };
}

// ---------------------------------------------------------------- the stop at loopback, waited for

/**
 * The server on `port` asked to stop at loopback (reason `reason`), and waited for until it has ended: {state, at, words}
 * — 'none' (nothing answered), 'stopped' (it took the stop and its port closed), or a throw: refused when busy with no
 * typed reason, when it does not prove the token, or when it has not ended within STOP_WAIT_MS. `at` is when it was asked.
 */
async function stopAndWait({ port, token, reason, by, force, n = {} }) {
  const at = Date.now();
  const r = await (n.stop || stopAsk)({ port, token, reason, by, force });
  if (!r.ok && r.why === 'ECONNREFUSED') return { state: 'none', at, words: 'nothing is serving on port ' + port };
  if (!r.ok) throw refusal('AGMessage could not be stopped at loopback: ' + r.words + '.', { why: r.why });
  if (r.status === 409) throw refusal(said((r.json && r.json.error) || 'Not stopped: AGMessage is busy. Type a reason to stop it anyway.', 300), { busy: true, forceable: true });
  if (r.status !== 200 || !r.json || r.json.stopping !== true) throw refusal('AGMessage did not take the stop (' + r.status + (r.json && r.json.error ? ': ' + said(r.json.error, 160) : '') + ').');
  const closed = await portCloses(port, { ms: n.waitMs || STOP_WAIT_MS, answers: n.portAnswers || portAnswers });
  if (!closed) throw refusal('AGMessage took the stop at ' + clock(at) + ' and still holds port ' + port + ' after ' + Math.round((n.waitMs || STOP_WAIT_MS) / 1000) + ' s: it is still saving, or it is stuck. Wait, then try again.');
  return { state: 'stopped', at, already: r.json.already === true, words: 'stopped at ' + clock(at) };
}

/** The last stop's record, read by type from the data folder (never a secret): null when there is none to read. */
function readLastStop(dataDir, fsImpl = fs) {
  let j;
  try { j = JSON.parse(fsImpl.readFileSync(pathOf(dataDir).join(dataDir, 'last-stop.json'), 'utf8')); } catch (e) { return e && e.code === 'ENOENT' ? null : { unreadable: (e && e.code) || 'not JSON' }; }
  if (!j || typeof j !== 'object') return { unreadable: 'not a record' };
  return {
    at: Number.isFinite(j.at) ? j.at : null,
    saved: j.saved === true,
    backup: typeof j.backup === 'string' ? said(j.backup, 200) : '',
    unbacked: typeof j.unbacked === 'string' ? said(j.unbacked, 300) : '',
    unsaved: Array.isArray(j.unsaved) ? j.unsaved.map((x) => said(x, 60)).join(', ') : '',
  };
}

// ---------------------------------------------------------------- the way back's backup, as the machine reads it

const BACKUPS = 'backups';
/** A backup's folder name (lib/upgradebackup.js NAME). */
const BACKUP_NAME = /^upgrade-([0-9A-Za-z.+-]{1,80})-(\d{8}T\d{6}Z)-([0-9A-Za-z]{6})$/;
/** A file written where it lies (lib/upgradebackup.js IN_PLACE): an append-only log, a .bak a save copies over. */
const IN_PLACE = /\.(?:log|jsonl|bak)$/i;
/**
 * What the backup does with a file of the data folder, by its path inside it (lib/upgradebackup.js kindOf, held to it by
 * test/machine.test.js; pure): 'skip' for backups/, logs/ and a temporary file, 'copy' for one written in place, 'link'
 * for every other, only ever replaced whole.
 */
function kindOf(rel) {
  const parts = String(rel).split('/');
  if (parts[0] === BACKUPS || parts[0] === 'logs') return 'skip';
  const name = parts[parts.length - 1];
  if (/\.tmp$/i.test(name) || parts.some((p) => p.startsWith('.partial-'))) return 'skip';
  return IN_PLACE.test(name) ? 'copy' : 'link';
}
/** The files a restore never rolls back: the audit log (its files, its archives) and watchdog.log, append-only evidence. */
const NEVER_ROLLED_BACK = (rel) => /^audit[^/]*$/.test(rel) || rel.startsWith('audit-archive/') || rel === 'watchdog.log';
/**
 * The folders `parts` below `base`, each made where it is not there and each a real directory (never a link, junction or
 * reparse point), so a file laid back as SYSTEM lands inside the folder it names and nowhere a link would send it.
 */
function realFolders(fsImpl, P, base, parts) {
  let at = base;
  for (const part of parts) {
    at = P.join(at, part);
    try { fsImpl.mkdirSync(at); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const real = realDir(fsImpl, at);
    if (!real.ok) throw Object.assign(new Error(at + ' ' + real.why), { code: 'ENOTDIR' });
  }
}
/** Every file under `dir` (no link followed), '/' between folders; a folder not there holds none. */
function filesIn(fsImpl, dir) {
  const P = pathOf(dir);
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fsImpl.readdirSync(abs, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(P.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}
/**
 * What the next backup's copies take on the disk, and what the disk has (lib/upgradebackup.js plan's estimate):
 * {copyBytes, free}, `free` null when it cannot be read. An upload counts when the uploads folder is on another volume.
 */
function backupEstimate(dataDir, uploadDir, fsImpl = fs) {
  const P = pathOf(dataDir);
  let copyBytes = 0;
  const size = (f) => { try { return fsImpl.statSync(f).size; } catch { return 0; /* gone since it was listed */ } };
  for (const rel of filesIn(fsImpl, dataDir)) if (kindOf(rel) === 'copy') copyBytes += size(P.join(dataDir, ...rel.split('/')));
  let sameVolume;
  try { sameVolume = fsImpl.statSync(dataDir).dev === fsImpl.statSync(uploadDir).dev; } catch { sameVolume = true; /* no uploads folder: nothing of it to copy */ }
  if (!sameVolume) for (const rel of filesIn(fsImpl, uploadDir)) copyBytes += size(P.join(uploadDir, ...rel.split('/')));
  let free;
  try { const s = fsImpl.statfsSync(dataDir); free = s.bavail * s.bsize; } catch { free = null; /* not read: the server's own check stands */ }
  return { copyBytes, free };
}

// ---------------------------------------------------------------- uninstall

/**
 * Every task in AGMessage's folder of Task Scheduler: the server task, the control task the record implies for the
 * laptop's admin and for each account given a right (`\AGMessage\Control-<sid>`, U17's), and any other the folder's
 * listing names (`schtasks /query /fo csv /nh`, by its first column), so a listing that cannot be read leaves none of
 * them registered.
 */
function agmTasks(H, record, grants) {
  const names = new Set([SERVER_TASK]);
  for (const sid of [record.values.Admin, ...Object.keys(grants)]) if (isSid(sid)) names.add(TASK_FOLDER + 'Control-' + sid);
  const r = H.schtasks(['/Query', '/TN', TASK_FOLDER, '/FO', 'CSV', '/NH']);
  if (r.code === 0) for (const row of csvRows(r.out)) if (row[0] && row[0].toLowerCase().startsWith(TASK_FOLDER.toLowerCase())) names.add(row[0]);
  return [...names];
}

/**
 * uninstall: with --app, a person's console still open from {app} refused before anything (its node.exe holds files the
 * uninstall removes); the server stopped at loopback (it saves), then every task in \AGMessage\ ended and removed and,
 * with --app, every program of {app} waited for until it has ended, then the rules and the record removed, before any file
 * goes. With --remove-data the folders go, the keys last (answer 43). Otherwise the data is kept for AGMessage installed
 * again: every right a Windows account was given on it taken back (the laptop's admin's and each grantee's grants on the
 * machine folder's children, their inbox\ and outbox\ folders), and the record replaced by `Kept`, naming the root, and its
 * `Port`, which prepare takes as it takes an earlier install. Each step is checked; what was left is named in the words
 * and makes the exit 2.
 */
async function uninstall(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  const record = readRecord(H);
  const port = needPort(opts, { optional: true }) || Number(record.values.Port) || 0;
  const told = [];
  const left = [];
  if (opts['--app']) {
    const others = programsIn(opts, run).filter((p) => !serverProgram(p));
    if (others.length) throw refusal('AGMessage\'s own console is open (' + programWords(others) + ' runs from ' + opts['--app'] + '): close its window, then uninstall again. Nothing was removed.', { programs: others.map((p) => ({ pid: p.pid, name: p.name })) });
  }
  // 1. The server's own stop, which saves; Task Scheduler's End (TerminateProcess) is never the stop.
  const token = tokenFrom(root, fsImpl);
  if (port && token) {
    try {
      const s = await stopAndWait({ port, token, reason: 'stop', by: 'the uninstall', force: said(opts['--force'] || '', 200), n });
      told.push(s.state === 'none' ? 'AGMessage was not serving' : 'AGMessage stopped and saved (' + s.words + ')');
    } catch (e) {
      if (!e.refused || (e.why !== 'unproven' && e.why !== 'silent')) throw e;   // busy with no reason, or still saving: refused
      told.push('AGMessage could not be stopped at loopback (' + e.words + ') and was ended without its save');
    }
  } else if (port) told.push('the token could not be read, so AGMessage was not stopped at loopback: it was ended without its save if it was serving');
  // 2. Every task of AGMessage's folder: ended (nothing to save now) and removed, each checked.
  const grants = readGrants(H);
  for (const tn of agmTasks(H, record, grants)) {
    if (H.schtasks(['/Query', '/TN', tn]).code !== 0) continue;   // not there
    H.schtasks(['/End', '/TN', tn]);
    const del = H.schtasks(['/Delete', '/TN', tn, '/F']);
    if (del.code !== 0 || H.schtasks(['/Query', '/TN', tn]).code === 0) left.push('the task ' + tn + ' (' + (del.err || 'schtasks.exe ended with ' + del.code) + ')');
  }
  // Nothing may still run from {app} when its files go: the server's own programs end after it (the watchdog, launch.js
  // serve), so they are given PROGRAMS_WAIT_MS; what still runs then is named.
  if (opts['--app']) {
    const until = Date.now() + (n.programsWaitMs || PROGRAMS_WAIT_MS);
    let still = programsIn(opts, run);
    while (still.length && Date.now() < until) { await sleep(POLL_MS); still = programsIn(opts, run); }
    if (still.length) left.push(programWords(still) + ', which still runs from ' + opts['--app'] + ' (close it, then uninstall again)');
  }
  // 3. The firewall rules.
  const fw = H.powershell(PS_FIREWALL_REMOVE, { AGM_RULE_TCP: RULE_TCP, AGM_RULE_UDP: RULE_UDP });
  if (fw.error) left.push('the firewall rules (' + said(fw.error, 160) + ')');
  // 4. Data kept: every right a Windows account was given on it taken back, while the record still names them.
  const keep = !opts['--remove-data'] && fsImpl.existsSync(root);
  if (keep) {
    const sids = [...new Set([record.values.Admin, ...Object.keys(grants)].filter(isSid))];
    for (const child of CHILDREN) {
      const dir = P.join(root, child.name);
      if (!sids.length || !fsImpl.existsSync(dir)) continue;
      const r = H.icacls([dir, '/remove:g', ...sids.map((sid) => '*' + sid)]);
      if (r.code !== 0) left.push('the rights on ' + dir + ' (' + (r.err || 'icacls.exe ended with ' + r.code) + ')');
    }
  }
  // Each account's inbox\ and outbox\ removed entry by entry, never recursively (clearBox), before anything removes the
  // machine folder whole, which is left while one of them is: a link left in one is taken, never what it names.
  let boxLeft = false;
  if (fsImpl.existsSync(root)) {
    for (const box of ['inbox', 'outbox']) {
      const dir = P.join(root, 'machine', box);
      let names = [];
      try { names = fsImpl.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') { left.push(dir + ' (' + (e.code || e.message) + ')'); boxLeft = true; } }
      for (const name of names) { const why = clearBox(fsImpl, P.join(dir, name)); if (why) { left.push(why); boxLeft = true; } }
    }
  }
  // 5. The record; where the data is kept, the mark prepare takes it again by (HKLM, which only administrators write).
  if (record.exists) {
    const del = H.reg(['delete', HKLM, '/f', '/reg:64']);
    if (del.code !== 0) left.push('the install record (' + (del.err || 'reg.exe ended with ' + del.code) + ')');
  }
  if (keep) {
    for (const v of [{ name: 'Kept', type: 'REG_SZ', value: root }, ...(port ? [{ name: 'Port', type: 'REG_DWORD', value: String(port) }] : [])]) {
      const r = H.reg(['add', HKLM, '/v', v.name, '/t', v.type, '/d', v.value, '/f', '/reg:64']);
      if (r.code !== 0) left.push('the mark (' + v.name + ') by which AGMessage installed again takes the kept data (' + (r.err || 'reg.exe ended with ' + r.code) + ')');
    }
  }
  // 6. The data only when asked: everything but the keys, then the keys last.
  const removed = [];
  if (opts['--remove-data']) {
    for (const name of ['data', 'uploads', 'logs', 'token', 'machine', 'setup', 'keys']) {
      const dir = P.join(root, name);
      if (!fsImpl.existsSync(dir) || (name === 'machine' && boxLeft)) continue;
      try { fsImpl.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { left.push(dir + ' (' + (e.code || e.message) + ')'); continue; }
      if (fsImpl.existsSync(dir)) left.push(dir); else removed.push(name);
    }
    if (!left.length) { try { fsImpl.rmdirSync(root); } catch (e) { if (e.code !== 'ENOENT') left.push(root + ' (' + (e.code || e.message) + ')'); } }
  }
  const head = told.length ? told.join('; ') + '. ' : '';
  if (left.length) throw notDone(head + 'AGMessage is not wholly uninstalled; left: ' + left.join('; ') + '.', { removed, left });
  return { removed, words: head + (opts['--remove-data'] ? 'AGMessage is uninstalled, and its data removed from this PC.' : keep ? 'AGMessage is uninstalled; its data is kept in ' + root + ', which AGMessage installed again takes, and no Windows account keeps a right to it but SYSTEM and Administrators.' : 'AGMessage is uninstalled; it had no data folder to keep.') };
}

// ---------------------------------------------------------------- preinstall-check, upgrade-stop

/**
 * The programs running from `--app` ({app}), read through powershell.exe from `--sys`, this process left out: each {pid,
 * name, cmd}, the command line only to tell the server's own from the rest (serverProgram), never said or kept. A list
 * that cannot be read refuses, fail closed: nothing is replaced under a program nobody could see.
 */
function programsIn(opts, run) {
  const app = needPath(opts, '--app');
  if (!DRIVE_PATH.test(String(opts['--sys'] || ''))) throw usage('--app needs --sys <{sys}>, the System32 folder the programs are read from.');
  const r = hands(opts['--sys'], run).powershell(PS_PROGRAMS, { AGM_APP: app });
  if (r.error || !(Array.isArray(r.programs) || (r.programs && typeof r.programs === 'object'))) throw refusal('What runs from ' + app + ' could not be read (' + said(r.error || 'no answer', 160) + '): nothing is replaced under a program nobody could see.');
  const list = Array.isArray(r.programs) ? r.programs : [r.programs];
  const programs = list.filter((p) => p && Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid !== process.pid)
    .map((p) => ({ pid: p.pid, name: said(p.name || '', 60), cmd: String(p.cmd || '').slice(0, 2000), exe: String(p.exe || '').slice(0, 400), ancestor: p.ancestor === true }));
  return outsideOwnChain(programs, app);
}

/** The pid listening on `port` (Get-NetTCPConnection), or 0 when it cannot be read: `--sys` names where to run it from. */
function holderPid(opts, run, port) {
  if (!DRIVE_PATH.test(String(opts['--sys'] || ''))) return 0;
  const r = hands(opts['--sys'], run).powershell(PS_STATUS, { AGM_PORT: String(port), AGM_NODE_TAIL: '\\node\\node.exe' });
  return Number.isSafeInteger(r.pid) && r.pid > 0 ? r.pid : 0;
}

/**
 * preinstall-check: fails closed before an install or an upgrade lays a file. Nothing on the port: ready, with or without
 * a token. Something answers: this PC's AGMessage proving its token is asked how busy it is (busy refused without a typed
 * reason; silent within 5 s refused, naming its pid); anything else refused with who holds the port, read from its health
 * (a portable copy's words) or by its pid.
 */
async function preinstallCheck(opts, stand = {}) {
  const { run = childProcess.execFileSync } = stand;
  const by = opts['--upgrade-by'] === undefined ? null : checkedUpgrader(opts, run);
  try {
    const r = await preinstallChecked(opts, stand);
    return by ? { ...r, byName: by.name } : r;
  } catch (e) {
    if (by && e && typeof e === 'object') e.byName = by.name;
    throw e;
  }
}
/**
 * /UPGRADEBY=<sid>, checked (preinstall-check --upgrade-by): the switch AGMessage's checked upgrade runs the installer with,
 * accepted only when this runs as SYSTEM (whoami's SID) and the install record gives that one person's account `upgrade`
 * (the laptop's admin, or a Grants value naming it): {sid, name}, the name Windows gives it now, for who asked the stop.
 */
function checkedUpgrader(opts, run) {
  const sid = String(opts['--upgrade-by']);
  if (!personSid(sid)) throw usage('--upgrade-by is "' + said(sid, 80) + '", which is not one person\'s SID.');
  const H = hands(opts['--sys'], run);
  const me = accountOf(H.whoami(['/user', '/fo', 'csv', '/nh']).out);
  if (!me || me.sid !== SID.system) throw refusal('/UPGRADEBY is the switch of AGMessage\'s own checked upgrade, which runs this installer as SYSTEM: run it without /UPGRADEBY, and Windows asks for an administrator\'s approval. Nothing was changed.');
  const record = readRecord(H);
  const rights = record.values.Admin === sid ? RIGHTS : grantRightsOf(readGrants(H)[sid]);
  if (!record.installed || !rights.includes('upgrade')) throw refusal('/UPGRADEBY names ' + sid + ', which AGMessage on this PC gives no right to upgrade it: nothing was changed.');
  const ps = H.powershell(PS_WHOSE, { AGM_SIDS: sid });
  const name = ps.names && typeof ps.names[sid] === 'string' && ps.names[sid] ? said(ps.names[sid], 80) : sid === record.values.Admin && record.values.AdminName ? said(record.values.AdminName, 80) : sid;
  return { sid, name };
}
/** preinstall-check's checks themselves, once /UPGRADEBY (when given) is taken. */
async function preinstallChecked(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const port = needPort(opts);
  // A person's console from {app} (Show the admin token, AGMessage status, Open AGMessage) holds node.exe open: the files
  // could not be replaced under it, so it is closed first, before anything is stopped.
  if (opts['--app']) {
    const others = programsIn(opts, run).filter((p) => !serverProgram(p));
    if (others.length) throw refusal('AGMessage\'s own console is open (' + programWords(others) + ' runs from ' + opts['--app'] + '): close its window, then continue.', { programs: others.map((p) => ({ pid: p.pid, name: p.name })) });
  }
  if (!(await (n.portAnswers || portAnswers)(port))) return { ready: true, words: 'Port ' + port + ' is free: nothing is serving on it.' };
  const pidWords = () => { const pid = (n.pid || holderPid)(opts, run, port); return pid ? ' (pid ' + pid + ')' : ''; };
  // The way back lays an earlier build's files down with no stop of its own: only once the newer build has ended.
  if (opts['--rollback']) throw refusal('Something answers on port ' + port + pidWords() + ': the way back lays an earlier build down only where nothing serves, once the newer build has ended. Stop it, then go back again.', { running: true });
  const token = tokenFrom(root, fsImpl);
  const h = token ? await (n.hello || hello)({ port, token }) : { ok: false, why: 'notoken' };
  if (h.ok) {
    const b = await (n.busy || busyAsk)({ port, token });
    if (!b.answered && b.running) throw refusal('AGMessage on port ' + port + pidWords() + ' did not answer how busy it is within ' + ANSWER_MS / 1000 + ' s (' + b.words + '): it cannot be stopped at loopback, so the install cannot go on.');
    if (b.busy && !opts['--force']) throw refusal('AGMessage is busy (' + (b.words || 'activity in the last 10 minutes') + '): type a reason to go on anyway, or wait.', { busy: true, forceable: true, line: b.line || null });
    return { ready: true, running: true, busy: b.busy, line: b.line || null, words: 'The installed AGMessage answered: ' + (b.words || 'ready') + '.' };
  }
  if (h.why === 'silent') throw refusal('AGMessage on port ' + port + pidWords() + ' does not answer within ' + ANSWER_MS / 1000 + ' s: it reads as busy, and it cannot be stopped at loopback, so the install cannot go on.');
  const holder = await (n.health || healthOf)(port);
  if (holder && holder.runs !== 'task') throw refusal('AGMessage ' + holder.version + ' is running on port ' + port + ' from a folder: press Ctrl+C in its window, then continue.');
  if (holder) throw refusal('The AGMessage installed on this PC (' + holder.version + ', build ' + holder.build + ') answers on port ' + port + ' but did not prove it holds this PC\'s token' + (token ? '' : ' (token\\admin-token could not be read)') + ': stop it from the Task Scheduler, then continue.');
  throw refusal('Another program' + pidWords() + ' holds port ' + port + ': close it, then continue.');
}

/**
 * upgrade-stop: refused before it asks anything when the disk is short of the room the way back's backup takes (its
 * copies and the reserve beside them), unless forced. Then the stop at loopback with the proof of the token, reason
 * "upgrade", who asked and the reason typed: upgrade-stop waits for the server to end and reads last-stop.json, made after
 * it asked. With no record, a stop that did not save, or no backup made, it refuses (exit 3) unless forced; its words say
 * when the stop saved and the backup it made.
 */
async function upgradeStop(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const port = needPort(opts);
  const P = pathOf(root);
  const force = said(opts['--force'] || '', 200);
  const by = said(opts['--by'] || 'the upgrade', 80);
  const dataDir = P.join(root, 'data');
  const token = tokenFrom(root, fsImpl);
  if (!token) throw refusal('the installed node\'s token (token\\admin-token) could not be read, so AGMessage cannot be stopped at loopback for the upgrade.');
  const est = (n.estimate || backupEstimate)(dataDir, P.join(root, 'uploads'), fsImpl);
  if (est.free !== null && est.free < est.copyBytes + BACKUP_RESERVE && !force) {
    throw refusal('the disk has ' + MB(est.free) + ' free, under the ' + MB(est.copyBytes) + ' the way back\'s backup copies and the ' + MB(BACKUP_RESERVE) + ' kept beside them: free some space, or give a reason to upgrade without a way back. AGMessage was not stopped.', { forceable: true });
  }
  const s = await stopAndWait({ port, token, reason: 'upgrade', by, force, n });
  // Nothing may still run from {app} when its files are replaced: the server's own programs end after it (the watchdog,
  // launch.js serve), so they are given PROGRAMS_WAIT_MS; anything left then is named and the upgrade refused.
  if (opts['--app']) {
    const until = Date.now() + (n.programsWaitMs || PROGRAMS_WAIT_MS);
    let left = programsIn(opts, run);
    while (left.length && Date.now() < until) { await sleep(POLL_MS); left = programsIn(opts, run); }
    if (left.length) throw refusal('AGMessage stopped for the upgrade at ' + clock(s.at) + ', but ' + programWords(left) + ' still runs from ' + opts['--app'] + ': close it, then run the installer again.', { programs: left.map((p) => ({ pid: p.pid, name: p.name })) });
  }
  if (s.state === 'none') {
    if (!force) throw refusal('AGMessage is not serving on port ' + port + ', so no stop saved it for the upgrade and no backup was made for the way back: start it, or give a reason to upgrade without one.', { forceable: true });
    return { saved: false, backup: '', forced: true, words: 'AGMessage was not serving: upgrading without a way back, as asked (' + force + ').' };
  }
  const rec = readLastStop(dataDir, fsImpl);
  const fresh = rec && !rec.unreadable && Number.isFinite(rec.at) && rec.at >= s.at;
  const problem = !rec ? 'no save record' : rec.unreadable ? 'its save record could not be read (' + rec.unreadable + ')' : !fresh ? 'no save record of this stop (the record there is older)' : !rec.saved ? 'it did not save (' + (rec.unsaved || 'not all of it') + ')' : !rec.backup ? rec.unbacked || 'no backup was made for the way back' : '';
  if (problem && !force) throw refusal('AGMessage stopped for the upgrade at ' + clock(s.at) + ', and ' + problem + ': the upgrade is refused so no data is risked. Give a reason to upgrade anyway.', { forceable: true });
  if (problem) return { saved: !!(fresh && rec.saved), backup: fresh ? rec.backup : '', at: fresh ? rec.at : null, forced: true, words: 'AGMessage stopped at ' + clock(s.at) + ', and ' + problem + ': upgrading anyway, as asked (' + force + ').' };
  return { saved: true, backup: rec.backup, at: rec.at, words: 'AGMessage stopped for the upgrade and saved at ' + clock(rec.at) + '; backup ' + rec.backup + '.' };
}

// ---------------------------------------------------------------- status

/** A file's last `n` lines, as read, refused or absent (never a secret: lib/serverlog.js keeps the token out of the logs). */
function tailOf(fsImpl, file, n) {
  try { return { read: 'read', lines: fsImpl.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).map((l) => said(l, 400)) }; } catch (e) {
    return { read: e.code === 'ENOENT' ? 'absent' : 'refused', code: e.code || 'EIO', lines: [] };
  }
}

/**
 * status: facts for the person who runs it elevated, each saying whether it was read, refused or absent: the server
 * task's state and last result (by column), the tails of watchdog.log and server.log, the last last-stop.json, the port's
 * holder pid and whether a code-integrity event (Smart App Control) stopped node.exe (one powershell.exe), the laptop's
 * admin and the grants. No token or password.
 */
function status(opts, { run = childProcess.execFileSync, fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  const q = H.schtasks(['/Query', '/TN', SERVER_TASK, '/FO', 'CSV', '/NH', '/V']);
  const task = q.code === 0 ? (taskStateOf(q.out) || { state: 'unknown', lastResult: null }) : { state: 'not registered', lastResult: null, code: q.code };
  const record = readRecord(H);
  const port = needPort(opts, { optional: true }) || Number(record.values.Port) || 0;
  const rec = readLastStop(P.join(root, 'data'), fsImpl);
  const facts = {
    task,
    record: record.exists ? 'read' : 'absent',
    admin: said(record.values.AdminName || record.values.Admin || '', 120),
    version: said(record.values.Version || '', 20),
    grants: readGrants(H),
    port: port || null,
    lastStop: rec === null ? { read: 'absent' } : rec.unreadable ? { read: 'refused', code: rec.unreadable } : { read: 'read', ...rec },
    watchdogLog: tailOf(fsImpl, P.join(root, 'data', 'watchdog.log'), 20),
    serverLog: tailOf(fsImpl, P.join(root, 'logs', 'server.log'), 20),
  };
  const dir = record.values.InstallDir || '';
  const ps = port ? H.powershell(PS_STATUS, { AGM_PORT: String(port), AGM_NODE_TAIL: (dir ? path.win32.join(dir, 'node', 'node.exe') : '\\AGMessage\\node\\node.exe').replace(/^[A-Za-z]:/, '') }) : { pidError: 'no port named or recorded' };
  facts.portHolderPid = Number.isSafeInteger(ps.pid) && ps.pid > 0 ? ps.pid : null;
  if (ps.error || ps.pidError) facts.portHolderError = said(ps.error || ps.pidError, 160);
  facts.codeIntegrity = ps.codeIntegrity && typeof ps.codeIntegrity.found === 'boolean'
    ? { found: ps.codeIntegrity.found, ...(ps.codeIntegrity.found ? { id: Number(ps.codeIntegrity.id) || 0, at: said(ps.codeIntegrity.at || '', 40) } : {}) }
    : { found: null, error: said(ps.error || ps.codeIntegrityError || 'not read', 160) };
  return { facts, words: statusWords(facts) };
}
/** The status in words for the console. */
function statusWords(f) {
  const lines = ['AGMessage on this PC:', '  the server task: ' + f.task.state + (f.task.lastResult === null ? '' : ' (last result ' + f.task.lastResult + ')')];
  if (f.port) lines.push('  port ' + f.port + (f.portHolderPid ? ': held by pid ' + f.portHolderPid : f.portHolderError ? ': its holder not read (' + f.portHolderError + ')' : ': nothing holds it'));
  lines.push('  the laptop\'s admin: ' + (f.admin || (f.record === 'absent' ? 'no install record' : 'not recorded')));
  const given = Object.entries(f.grants || {});
  lines.push('  rights given: ' + (given.length ? given.map(([sid, rights]) => sid + ': ' + (grantRightsOf(rights).join(', ') || 'none')).join(' · ') : 'none'));
  if (f.lastStop.read === 'read') lines.push('  the last stop: ' + (f.lastStop.saved ? 'saved' + (f.lastStop.at ? ' at ' + clock(f.lastStop.at) : '') : 'not saved' + (f.lastStop.unsaved ? ' (' + f.lastStop.unsaved + ')' : '')));
  else lines.push('  the last stop: ' + (f.lastStop.read === 'absent' ? 'no record (AGMessage is serving, or it did not stop cleanly)' : 'its record could not be read (' + f.lastStop.code + ')'));
  if (f.codeIntegrity.found) lines.push('  Windows\' code integrity stopped node.exe (event ' + f.codeIntegrity.id + ', ' + f.codeIntegrity.at + '): Smart App Control may be on');
  else if (f.codeIntegrity.found === null) lines.push('  code integrity: not read (' + f.codeIntegrity.error + ')');
  if (f.serverLog.lines.length) lines.push('  the log\'s last line: ' + f.serverLog.lines[f.serverLog.lines.length - 1].slice(0, 160));
  return lines.join('\n');
}

// ---------------------------------------------------------------- whose, start and first-account (the installer's)

/** The setup folder's one-time folders (prepare's setup\<128 random bits>\), each named by 32 hex characters. */
const SETUP_ONCE = /^[0-9a-f]{32}$/;
/**
 * The plan's first reading, the file the account that started Setup wrote (`whoami /user /fo csv /nh`, run as it through
 * Inno's ExecAsOriginalUser) into a one-time folder of setup\: read only when it is a real file there, then removed, so
 * nothing written there is ever read twice. {name, sid}, or {why}. Its name is the console's code page's and its SID is
 * what is used; the words take the name Windows gives that SID.
 */
function startedFrom(fsImpl, root, file) {
  const P = pathOf(root);
  const rel = P.relative(P.join(root, 'setup'), String(file)).split(/[\\/]/);
  if (!fullPath(String(file)) || rel.length !== 2 || !SETUP_ONCE.test(rel[0]) || !/^[A-Za-z0-9.-]{1,40}$/.test(rel[1])) {
    throw usage('--started is "' + said(file, 120) + '", which is not a file of one of ' + P.join(root, 'setup') + '\'s one-time folders.');
  }
  let st;
  try { st = fsImpl.lstatSync(file); } catch (e) { return { why: e.code === 'ENOENT' ? 'it wrote no answer' : 'its answer could not be read (' + (e.code || e.message) + ')' }; }
  if (!st.isFile() || st.isSymbolicLink()) return { why: 'what is there is not a file it wrote' };
  let text;
  try { text = fsImpl.readFileSync(file, 'latin1'); } catch (e) { return { why: 'its answer could not be read (' + (e.code || e.message) + ')' }; } finally {
    try { fsImpl.unlinkSync(file); } catch { /* the setup folder goes at the install's end; it holds no secret */ }
  }
  return accountOf(text) || { why: 'its answer named no account' };
}

/**
 * whose: the laptop's admin, as the plan's readings find it once the elevation is in. The account this process runs as
 * (whoami.exe: the administrator who approved the elevation, or SYSTEM); the account that started Setup, from --started;
 * the owner of explorer.exe in this session and the names Windows gives each SID (one powershell.exe); and the account
 * --admin names (/ADMIN), resolved there. whoseOf decides; flat fields for the installer to read: `admin` and
 * `adminName` when it is decided, `choiceCount` and `choice1Sid`… when the person chooses, `approverName`.
 */
function whose(opts, { run = childProcess.execFileSync, fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const me = H.whoami(['/user', '/fo', 'csv', '/nh']);
  const approver = me.code === 0 ? accountOf(me.out) : null;
  const started = opts['--started'] ? startedFrom(fsImpl, root, opts['--started']) : { why: 'the installer did not ask it' };
  const sids = [approver, started].filter((r) => r && isSid(r.sid)).map((r) => r.sid);
  const ps = H.powershell(PS_WHOSE, { AGM_SIDS: sids.join(','), ...(opts['--admin'] ? { AGM_ACCOUNT: String(opts['--admin']) } : {}) });
  const names = ps.names && typeof ps.names === 'object' && !Array.isArray(ps.names) ? ps.names : {};
  const nameOf = (r) => (r && isSid(r.sid) ? { ...r, name: said(typeof names[r.sid] === 'string' && names[r.sid] ? names[r.sid] : r.name || '', 120) } : r);
  const owners = (Array.isArray(ps.screen) ? ps.screen : typeof ps.screen === 'string' ? [ps.screen] : []).filter(isSid);
  let screen;
  if (ps.error || ps.screenError) screen = { why: said(ps.error || ps.screenError, 160) };
  else if (owners.length === 1) screen = nameOf({ sid: owners[0], name: '' });
  else screen = { why: owners.length ? 'more than one account owns explorer.exe in this session' : 'no explorer.exe runs in this session' };
  let admin = null;
  if (opts['--admin']) admin = adminOf(opts['--admin'], ps.account || { error: ps.accountError || ps.error });
  const w = whoseOf({ started: nameOf(started), screen, approver: nameOf(approver), admin });
  const out = {
    agree: w.agree, admin: w.admin ? w.admin.sid : '', adminName: w.admin ? (w.admin.name || w.admin.sid) : '',
    approverName: approver ? (nameOf(approver).name || approver.sid) : '', choiceCount: w.choices.length,
    startedSid: started && isSid(started.sid) ? started.sid : '', screenSid: screen && isSid(screen.sid) ? screen.sid : '',
    words: w.words,
  };
  w.choices.forEach((c, i) => { out['choice' + (i + 1) + 'Sid'] = c.sid; out['choice' + (i + 1) + 'Name'] = c.name || c.sid; });
  if (w.refused) throw refusal(w.words, out);
  return out;
}

/** A build named by --build: one an installer lays down (installOf), or '' when none is named; else a usage error. */
function wantedBuild(opts) {
  if (opts['--build'] === undefined) return '';
  const want = String(opts['--build']);
  if (!installOf(want)) throw usage('--build is "' + said(want, 80) + '", which is not a build an installer lays down (0.6.0+41.abc1234, 0.6.0-dev.41+abc1234).');
  return want;
}

/**
 * start: the server task run (schtasks /Run), and the server asked every POLL_MS, within START_WAIT_MS, until it proves
 * it holds this machine folder's token (the hello, its token read again each time, since a first start writes it) as
 * `--build` when that is given: the installer's verify. A program that answers /api/health with the build's words but
 * proves nothing is no answer. Whether the node has an account yet is asked of the proven server, on the connection it
 * proved itself on (/api/auth/me's `setup`). {answered, build, needsAccount}. One that has not proved itself as asked in
 * time is ended (schtasks /End: it never served, so it has nothing to save), and refused as not done (2), its words said
 * with the last lines of server.log, the console the watchdog keeps (`tail`).
 */
async function start(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const port = needPort(opts);
  return startAndProve({ H, root, port, fsImpl, n }, wantedBuild(opts));
}
/**
 * The server task run and its server waited for until it proves it holds the token (as `want` when given): start's core.
 * `end` (the installer's verify) ends one that has not proved itself in time; a person's Start (`end` false) never does,
 * since the task may be the watchdog still starting or retrying a held port: it is left as it is, and its state said.
 */
async function startAndProve({ H, root, port, fsImpl = fs, n = {}, end = true }, want = '') {
  const waitMs = n.waitMs || START_WAIT_MS;
  const ran = H.schtasks(['/Run', '/TN', SERVER_TASK]);
  if (ran.code !== 0) throw notDone('The server task ' + SERVER_TASK + ' could not be started (' + (ran.err || 'schtasks.exe ended with ' + ran.code) + ').', { answered: false });
  const until = Date.now() + waitMs;
  let seen = '';
  let last;
  for (;;) {
    const token = tokenFrom(root, fsImpl);
    const p = token ? await (n.proven || proven)({ port, token, build: want, then: [{ path: '/api/auth/me' }] }) : { ok: false, why: 'notoken' };
    if (p.ok) {
      const me = p.answers[0];
      return { answered: true, build: p.build, needsAccount: me.status === 200 && !!me.json && me.json.setup === true, words: 'AGMessage build ' + p.build + ' answers on port ' + port + ' and proves it holds this PC\'s token.' };
    }
    if (p.why === 'build') seen = p.build;
    last = p;
    if (Date.now() >= until) break;
    await sleep(POLL_MS);
  }
  const why = seen ? 'it answered as build ' + seen + ', not ' + want
    : last.why === 'notoken' ? 'its token (token\\admin-token) was never there to read, so nothing could prove it is this PC\'s AGMessage'
      : last.why === 'unproven' ? failWords('unproven', port, ANSWER_MS)
        : 'nothing answered on port ' + port;
  if (!end) {
    const q = H.schtasks(['/Query', '/TN', SERVER_TASK, '/FO', 'CSV', '/NH', '/V']);
    const st = q.code === 0 ? taskStateOf(q.out) : null;
    const task = st ? st.state + (st.lastResult === null ? '' : ', last result ' + st.lastResult) : 'its state not read';
    const line = tailOf(fsImpl, pathOf(root).join(root, 'logs', 'server.log'), 1).lines;
    throw notDone('AGMessage is not answering yet: ' + why + ' within ' + Math.round(waitMs / 1000) + ' s. It was left as it is, since it may still be starting: the server task is ' + task + '. ' + (line.length ? 'The log\'s last line: "' + line[0].trim() + '".' : 'Its log holds nothing.') + ' Try Start AGMessage again in a minute; AGMessage status says more.', { answered: false, ran: true, task, build: seen });
  }
  H.schtasks(['/End', '/TN', SERVER_TASK]);
  await portCloses(port, { ms: 10_000, answers: n.portAnswers || portAnswers });
  const tail = tailOf(fsImpl, pathOf(root).join(root, 'logs', 'server.log'), 8).lines;
  throw notDone('AGMessage' + (want ? ' ' + want : '') + ' did not start: ' + why + ' within ' + Math.round(waitMs / 1000) + ' s, so it was stopped. ' + (tail.length ? 'The last lines of its log: ' + tail.join(' | ') : 'Its log holds nothing.'), { answered: false, build: seen, tail: tail.join('\n') });
}

/** What first-account reads from the installer's file: three lines, the user name, the name and the password (pure). */
function accountFile(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  return { username: lines[0] || '', name: lines[1] || '', password: lines[2] || '' };
}
/**
 * first-account: the first admin account, made through /api/setup at loopback with the token of this machine folder, by
 * the server's own rules (only while it has no account, only at the laptop, its password checked there). The user name,
 * the name and the password come from `--account`, a file in machine\work\ (SYSTEM and Administrators only) the installer
 * wrote, which is read only when it is a real file there and is removed before anything is asked; the password goes in
 * no argument, URL, --out or log. The token and the password go only to a server that proved it holds the token, as
 * `--build` when that is given, on the connection it proved itself on (`proven`): a program that took the port is asked
 * the hello alone and sent neither. The server's refusal is said in its words (3). {made, username}.
 */
async function firstAccount(opts, { fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const port = needPort(opts);
  const want = wantedBuild(opts);
  const file = String(opts['--account'] || '');
  const P = pathOf(root);
  const rel = fullPath(file) ? P.relative(P.join(root, 'machine', 'work'), file).split(/[\\/]/) : [];
  if (rel.length !== 1 || !/^[A-Za-z0-9.-]{1,40}$/.test(rel[0])) throw usage('first-account needs --account <file>, a file of ' + P.join(root, 'machine', 'work') + '.');
  let text;
  try {
    const st = fsImpl.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw refusal('--account names something that is not a file the installer wrote: no account was made.');
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.refused) throw e;
    throw notDone('The account\'s file could not be read (' + (e.code || e.message) + '): no account was made.');
  } finally {
    try { fsImpl.unlinkSync(file); } catch { /* gone already, or machine\work\'s, which only SYSTEM and Administrators read */ }
  }
  const a = accountFile(text);
  const token = tokenFrom(root, fsImpl);
  if (!token) throw refusal('The installed node\'s token (token\\admin-token) could not be read, so the first admin account cannot be made from here: make it at Admin login with the token.');
  const body = Buffer.from(JSON.stringify({ token, username: a.username, name: a.name, password: a.password }), 'utf8');
  const p = await (n.proven || proven)({ port, token, build: want, then: [{ method: 'POST', path: '/api/setup', headers: { 'content-type': 'application/json' }, body }] });
  if (!p.ok && p.why === 'unproven') throw refusal('The program on port ' + port + ' did not prove it holds this PC\'s AGMessage token, so neither the token nor the password was sent to it: no account was made. Make it at Admin login once AGMessage serves.', { made: false });
  if (!p.ok && p.why === 'build') throw refusal(p.words + ', the build this installer laid down: no account was made.', { made: false });
  if (!p.ok) throw notDone('AGMessage did not answer on port ' + port + ' (' + p.words + '): no account was made.', { made: false });
  const r = p.answers[0];
  const error = r.json && typeof r.json.error === 'string' ? said(r.json.error, 200) : '';
  if (r.status === 200 && r.json && r.json.ok === true) {
    const username = r.json.account && typeof r.json.account.username === 'string' ? said(r.json.account.username, 80) : said(a.username, 80);
    return { made: true, username, words: 'The first admin account, ' + username + ', is made: sign in with it on AGMessage\'s page (Start → AGMessage → Open AGMessage).' };
  }
  if (r.status >= 400 && r.status < 500) throw refusal(error || 'AGMessage did not make the account (' + r.status + ').', { made: false });
  throw notDone('AGMessage did not make the account (' + r.status + (error ? ': ' + error : '') + ').', { made: false });
}

// ---------------------------------------------------------------- control: an account's request, as SYSTEM

/** The rights a Grants value names (pure): its known words, in RIGHTS' order; an unknown word gives nothing. */
function grantRightsOf(value) {
  const words = String(value || '').split(',').map((w) => w.trim().toLowerCase());
  return RIGHTS.filter((r) => words.includes(r));
}
/** Rights as words: "start, stop" (pure). */
const rightsWords = (list) => list.join(', ');
/** Whether `whoami /groups /fo csv /nh` names an elevated token (pure): a High or System integrity label, by its SID column. */
function elevatedOf(text) {
  const rows = csvRows(text);
  const sids = new Set(rows.map((r) => String(r[2] || '').trim()));
  return ELEVATED_LABELS.some((l) => sids.has(l)) && sids.has(SID.admins);
}
/** The keys each verb's request may hold, beside id and verb. */
const REQUEST_KEYS = Object.freeze({ start: [], stop: ['force'], upgrade: ['look', 'release', 'file', 'force'], back: ['to', 'force'], grant: ['account', 'rights'], revoke: ['account', 'rights'], handover: ['account', 'confirm'] });
const REQUEST_ID = /^[0-9a-f]{16,64}$/;
/**
 * A request read from its bytes (pure): {request} or {problem, id}. Whole JSON of at most REQUEST_MAX bytes, an object,
 * `id` 16-64 hex characters and `verb` one of CONTROL_VERBS, with the keys of that verb alone, each of its type: `force`
 * words (the reason typed for a busy stop, upgrade or go back); an upgrade's one way, `look` (true: its newest release
 * looked up, nothing installed), `release` (a version, MAJOR.MINOR.PATCH, downloaded from its release) or `file` (an
 * installer's name, AGMessage-Setup-<version>-unsigned.exe, in the account's inbox); a back's `to` (the install version it
 * goes back to); `account` an account's name or SID; `rights` a list of RIGHTS, each once (a revoke's may be "all");
 * `confirm` the new admin's name typed again. Anything else is refused, never defaulted.
 */
function requestOf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes || ''), 'utf8');
  if (buf.length > REQUEST_MAX) return { problem: 'Your request is over ' + REQUEST_MAX / 1024 + ' KB, so it was not read.' };
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return { problem: 'Your request is not whole JSON, so it was not read.' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { problem: 'Your request is not a request (a JSON object).' };
  const id = typeof j.id === 'string' && REQUEST_ID.test(j.id) ? j.id : '';
  if (!id) return { problem: 'Your request carries no id of its shape (16 to 64 hex characters).' };
  if (typeof j.verb !== 'string') return { problem: 'Your request names no verb.', id };
  if (!CONTROL_VERBS.includes(j.verb)) return { problem: '"' + said(j.verb, 40) + '" is not a request AGMessage\'s control task knows (' + CONTROL_VERBS.join(', ') + ').', id };
  const allowed = ['id', 'verb', ...REQUEST_KEYS[j.verb]];
  const extra = Object.keys(j).find((k) => !allowed.includes(k));
  if (extra !== undefined) return { problem: 'A ' + j.verb + ' request takes ' + (REQUEST_KEYS[j.verb].join(', ') || 'nothing more') + '; "' + said(extra, 40) + '" is not one of them.', id };
  const request = { id, verb: j.verb };
  if (j.verb === 'upgrade') {
    const ways = ['look', 'release', 'file'].filter((k) => j[k] !== undefined);
    if (ways.length !== 1) return { problem: 'An upgrade request names one of look, release and file.', id };
    if (ways[0] === 'look') {
      if (j.look !== true || j.force !== undefined) return { problem: 'An upgrade\'s look is true, and asks nothing more.', id };
      request.look = true;
      return { request };
    }
    if (ways[0] === 'release') {
      if (typeof j.release !== 'string' || !SEMVER.test(j.release)) return { problem: 'An upgrade\'s release is its version, MAJOR.MINOR.PATCH (0.6.1).', id };
      request.release = j.release;
    } else {
      if (typeof j.file !== 'string' || !INSTALLER_NAME.test(j.file)) return { problem: 'An upgrade\'s file is an installer\'s name in your inbox, AGMessage-Setup-<version>-unsigned.exe.', id };
      request.file = j.file;
    }
  }
  if (j.verb === 'back') {
    if (typeof j.to !== 'string' || !INSTALL_VERSION.test(j.to)) return { problem: 'A back request names the build it goes back to, by its install version (0.6.41).', id };
    request.to = j.to;
  }
  if (j.verb === 'stop' || j.verb === 'upgrade' || j.verb === 'back') {
    if (j.force !== undefined && typeof j.force !== 'string') return { problem: 'A ' + j.verb + '\'s force is the reason you typed, in words.', id };
    request.force = said(j.force || '', 200);
  }
  if (REQUEST_KEYS[j.verb].includes('account')) {
    const account = typeof j.account === 'string' ? said(j.account, 120) : '';
    if (!account) return { problem: 'A ' + j.verb + ' request names one Windows account (LAPTOP\\ben).', id };
    request.account = account;
  }
  if (REQUEST_KEYS[j.verb].includes('rights')) {
    if (j.verb === 'revoke' && j.rights === 'all') request.rights = 'all';
    else {
      const list = Array.isArray(j.rights) ? j.rights : null;
      if (!list || !list.length || list.length > RIGHTS.length || !list.every((r) => typeof r === 'string' && RIGHTS.includes(r)) || new Set(list).size !== list.length) {
        return { problem: 'A ' + j.verb + ' request names its rights, each once, among ' + rightsWords(RIGHTS) + (j.verb === 'revoke' ? ' (or all)' : '') + '.', id };
      }
      request.rights = RIGHTS.filter((r) => list.includes(r));
    }
  }
  if (j.verb === 'handover') {
    if (typeof j.confirm !== 'string') return { problem: 'A handover is confirmed by typing the new admin\'s account name again (confirm).', id };
    request.confirm = said(j.confirm, 120);
  }
  return { request };
}

/**
 * Whether two stats name one file: its device and its file id, each read whole (`{bigint: true}`), since an NTFS or ReFS
 * file id past 2^53 read as a Number loses its low bits and two files could read as one.
 */
const sameFile = (a, b) => BigInt(a.ino) === BigInt(b.ino) && BigInt(a.dev) === BigInt(b.dev);
/**
 * A request taken from where it was left (an inbox's request.json, or an elevated console's file in machine\work\):
 * lstat refuses a link, a hard link, a reparse point Windows reads as one, anything but a file and anything over
 * REQUEST_MAX; the file opened is the one lstat saw (fstat's device and index alike); its bytes are copied into
 * machine\work\ and read there. The file left is removed whatever it held, so no request is read twice. {bytes} or a
 * refusal.
 */
function takeRequest(fsImpl, file, workDir) {
  const P = pathOf(workDir);
  let bytes;
  try {
    let st;
    try { st = fsImpl.lstatSync(file, { bigint: true }); } catch (e) {
      if (e.code === 'ENOENT') throw refusal('No request was waiting: run it from the Start menu again.', { none: true });
      throw refusal('Your request could not be read (' + (e.code || e.message) + ').');
    }
    if (st.isSymbolicLink()) throw refusal('Your request is a link, which the control task never follows: it was not read.');
    if (!st.isFile()) throw refusal('Your request is not a file: it was not read.');
    if (st.nlink > 1n) throw refusal('Your request is a link to another file (a hard link), which the control task never reads: it was not read.');
    if (st.size > BigInt(REQUEST_MAX)) throw refusal('Your request is over ' + REQUEST_MAX / 1024 + ' KB, so it was not read.');
    const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const ft = fsImpl.fstatSync(fd, { bigint: true });
      if (!ft.isFile() || !sameFile(ft, st)) throw refusal('Your request changed between its look and its read: it was not read.');
      const buf = Buffer.alloc(REQUEST_MAX + 1);
      let n = 0;
      for (;;) { const got = fsImpl.readSync(fd, buf, n, buf.length - n, n); if (!got || n + got >= buf.length) { n += got; break; } n += got; }
      if (n > REQUEST_MAX) throw refusal('Your request is over ' + REQUEST_MAX / 1024 + ' KB, so it was not read.');
      bytes = Buffer.from(buf.subarray(0, n));
    } finally { fsImpl.closeSync(fd); }
  } finally {
    // Whatever was left there goes, so nothing is read twice: a file or link by unlink, a folder or a junction (whose
    // removal takes the junction, never what it names) by rmdir.
    try { fsImpl.unlinkSync(file); } catch { try { fsImpl.rmdirSync(file); } catch { /* gone already, or a folder holding files: never read */ } }
  }
  // Read where only SYSTEM and Administrators write: the copy is what is read, never the file its account can change.
  const copy = P.join(workDir, 'request-' + crypto.randomBytes(8).toString('hex') + '.json');
  fsImpl.writeFileSync(copy, bytes, { flag: 'wx' });
  try { return { bytes: fsImpl.readFileSync(copy) }; } finally { try { fsImpl.unlinkSync(copy); } catch { /* machine\work\'s, which no one else reads */ } }
}

/** The answer written for an account into its outbox\<sid>\ (answer.json, or the import's import.json), whole (a file beside it renamed over it). */
function writeAnswer(fsImpl, outbox, answer, name = 'answer.json') {
  const P = pathOf(outbox);
  const file = P.join(outbox, name);
  const tmp = P.join(outbox, 'answer-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  fsImpl.writeFileSync(tmp, JSON.stringify(answer), { flag: 'wx' });
  try { fsImpl.renameSync(tmp, file); } catch (e) { try { fsImpl.unlinkSync(tmp); } catch { /* left beside it: no secret */ } throw e; }
}

/** The account a name or SID is, as Windows resolves it (PS_WHOSE's account), or a refusal in the giving's words. */
function personFor(c, asked, act) {
  const ps = c.H.powershell(PS_WHOSE, { AGM_SIDS: '', AGM_ACCOUNT: String(asked) });
  const a = ps.account && typeof ps.account === 'object' ? ps.account : { error: ps.accountError || ps.error };
  const who = said(a.name || asked, 120);
  if (!isSid(a.sid) || a.translated !== true) throw refusal('"' + said(asked, 120) + '" is not an account Windows knows on this PC' + (a.error ? ' (' + said(a.error, 120) + ')' : '') + '. Name one person\'s account: LAPTOP\\ben.');
  if (a.group === true || !personSid(a.sid)) throw refusal(who + ' is not one person\'s account (a group or a service). ' + (act === 'handover' ? 'Hand AGMessage\'s admin over to one person\'s account.' : 'Give rights to one person\'s account.'));
  if (a.user !== true && a.profile !== true && a.lookupError) throw refusal('Windows cannot confirm that ' + who + ' is one person\'s account on this PC: its local accounts could not be read (' + said(a.lookupError, 120) + ') and the account has never signed in here. Name an account that has signed in to this PC once.');
  if (a.user !== true && a.profile !== true) throw refusal('Windows cannot confirm that ' + who + ' is one person\'s account on this PC: it is no local account and has never signed in here. Name a local account, or one that has signed in to this PC once.');
  return { sid: a.sid, name: said(a.name || asked, 120) };
}
/** The names Windows gives these SIDs now (PS_WHOSE's names), each '' where it gives none. */
function namesFor(c, sids) {
  const list = sids.filter(isSid);
  if (!list.length) return {};
  const ps = c.H.powershell(PS_WHOSE, { AGM_SIDS: list.join(',') });
  const names = ps.names && typeof ps.names === 'object' && !Array.isArray(ps.names) ? ps.names : {};
  return Object.fromEntries(list.map((s) => [s, typeof names[s] === 'string' ? said(names[s], 120) : '']));
}

/** A Grants value written (one value per SID: its rights), or not done. */
function writeGrant(H, sid, rights) {
  const r = H.reg(['add', HKLM + '\\Grants', '/v', sid, '/t', 'REG_SZ', '/d', rights.join(','), '/f', '/reg:64']);
  if (r.code !== 0) throw notDone('the install record\'s Grants for ' + sid + ' could not be written (' + (r.err || 'reg.exe ended with ' + r.code) + ')');
}
/** A Grants value removed: what was left, '' when it went (or was not there). */
function removeGrant(H, sid) {
  const r = H.reg(['delete', HKLM + '\\Grants', '/v', sid, '/f', '/reg:64']);
  if (r.code === 0) return '';
  return H.reg(['query', HKLM + '\\Grants', '/v', sid, '/reg:64']).code === 0 ? 'the install record\'s Grants for ' + sid + ' (' + (r.err || 'reg.exe ended with ' + r.code) + ')' : '';
}
/** The account's Grants value made `rights`, removed when there are none: '' when it is, else what stopped it. */
function setGrant(H, sid, rights) {
  if (!rights.length) return removeGrant(H, sid);
  try { writeGrant(H, sid, rights); return ''; } catch (e) { return e.words; }
}
/** A task ended and removed: what was left ('' when it is gone). */
function removeTask(H, tn) {
  if (H.schtasks(['/Query', '/TN', tn]).code !== 0) return '';
  const del = H.schtasks(['/Delete', '/TN', tn, '/F']);
  return del.code !== 0 && H.schtasks(['/Query', '/TN', tn]).code === 0 ? 'the task ' + tn + ' (' + (del.err || 'schtasks.exe ended with ' + del.code) + ')' : '';
}
/**
 * An account's inbox\<sid>\ or outbox\<sid>\ removed, never recursively: each entry by lstat, a folder (or a junction,
 * which lstat shows as a link) by rmdir, which takes the junction and never what it names, anything else by unlink (a link
 * by its own removal, never what it names); then the folder. What was left ('' when it is gone): a folder that holds
 * files stays, and is said.
 */
function clearBox(fsImpl, dir) {
  const P = pathOf(dir);
  let names;
  try { names = fsImpl.readdirSync(dir); } catch (e) { return e.code === 'ENOENT' ? '' : dir + ' (' + (e.code || e.message) + ')'; }
  const left = [];
  for (const name of names) {
    const f = P.join(dir, name);
    let st;
    try { st = fsImpl.lstatSync(f); } catch (e) { if (e.code !== 'ENOENT') left.push(f + ' (' + (e.code || e.message) + ')'); continue; }
    try {
      if (st.isDirectory()) fsImpl.rmdirSync(f);
      else { try { fsImpl.unlinkSync(f); } catch (e) { if (!st.isSymbolicLink()) throw e; fsImpl.rmdirSync(f); } }
    } catch (e) { left.push(f + ' (' + (e.code || e.message) + ')'); }
  }
  if (left.length) return left.join('; ');
  try { fsImpl.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') return dir + ' (' + (e.code || e.message) + ')'; }
  return '';
}

/**
 * What an account needs to send its requests: its inbox\ and outbox\ and its control task. None of them lets it do
 * anything: the record's rights, read at each request, do.
 *
 * The `token` right is the read on token\, which Windows holds, so the record never names less than Windows grants: a read
 * is given only once the record names the right, and taken back before the record stops naming it. A step that fails then
 * leaves the record naming a read Windows does not grant (said, and put right by giving or taking back again), never a read
 * the record does not name.
 */
function giveMeans(c, sid) {
  accountFolder(c.H, c.fsImpl, c.root, 'inbox', sid, inboxGrants(sid));
  accountFolder(c.H, c.fsImpl, c.root, 'outbox', sid, outboxGrants(sid));
  registerControl(c.H, c.fsImpl, { root: c.root, sys: c.sys, node: c.node, script: c.script, sid });
}
/** An account's means taken away (it holds no right): its control task, inbox\ and outbox\. What was left, as words. */
function dropMeans(c, sid) {
  const P = pathOf(c.root);
  return [removeTask(c.H, controlTask(sid)), ...['inbox', 'outbox'].map((box) => clearBox(c.fsImpl, P.join(c.root, 'machine', box, sid)))].filter(Boolean);
}
/** A read on token\ or logs\ given to `sid` (icacls /grant:r, by SID): '' when it is, else what stopped it. */
function giveRead(c, name, sid) {
  const dir = pathOf(c.root).join(c.root, name);
  const r = c.H.icacls([dir, '/grant:r', grant(sid, 'R')]);
  return r.code === 0 ? '' : 'the read on ' + dir + ' (' + (r.err || 'icacls.exe ended with ' + r.code) + ')';
}
/** A read on token\ or logs\ taken back from `sid` (icacls /remove:g, by SID): '' when it is, else what is left. */
function takeGrant(c, name, sid) {
  const dir = pathOf(c.root).join(c.root, name);
  const r = c.H.icacls([dir, '/remove:g', '*' + sid]);
  return r.code === 0 ? '' : 'the read on ' + dir + ' (' + (r.err || 'icacls.exe ended with ' + r.code) + ')';
}
/**
 * The outbox\ folders of accounts that hold no right any more (the old admin's, kept after a handover for the answer it
 * read), removed: never the laptop's admin's, a grantee's or `keep`'s.
 */
function sweepOutboxes(c, { admin, grants, keep }) {
  const dir = pathOf(c.root).join(c.root, 'machine', 'outbox');
  let names;
  try { names = c.fsImpl.readdirSync(dir); } catch { return; /* none to sweep */ }
  for (const sid of names) if (isSid(sid) && sid !== admin && sid !== keep && !Object.hasOwn(grants, sid)) clearBox(c.fsImpl, pathOf(dir).join(dir, sid));
}

/** The machine's events to be read now: the nudge at loopback, with the proof of the token; a server not answering is told nothing. */
async function nudgeServer(c) {
  const token = tokenFrom(c.root, c.fsImpl);
  if (!token || !c.port) return null;
  try {
    const r = await (c.n.nudge || ((o) => ask({ ...o, method: 'POST', path: '/api/machine/events' })))({ port: c.port, token });
    return r && r.ok && r.status === 200 && r.json && Number.isSafeInteger(r.json.written) ? r.json.written : null;
  } catch { return null; /* the file is the authority: the server reads it at its next start */ }
}
/**
 * An act's machine event appended: {seq, why}, `why` '' when it is, else the words saying it is not. The act stands
 * either way and is answered as done: its answer says the audit log will not show it.
 */
function eventFor(c, ev) {
  try { return { seq: appendEvent(c.machineDir, ev, c.fsImpl), why: '' }; } catch (e) {
    return { seq: 0, why: ' No machine event says so, so the audit log will not show it: ' + ((e && e.words) || said(e && e.message, 200)) + '.' };
  }
}

/** Why an account may not do `verb`, in its words: '' when it may. The rights are the install record's, read now. */
function mayNot(c, verb) {
  const asks = { start: 'start', stop: 'stop', upgrade: 'upgrade', back: 'upgrade' }[verb];
  const ask = c.adminName ? 'Ask ' + c.adminName + ', or an administrator.' : 'Ask this PC\'s AGMessage admin, or an administrator.';
  if (c.elevated) return c.installed ? '' : 'AGMessage is not installed on this PC (no install record).';
  if (!c.installed) return 'You have no AGMessage rights on this PC. Ask an administrator.';
  if (!asks) return c.isAdmin ? '' : 'Only ' + (c.adminName || 'this PC\'s AGMessage admin') + ', this PC\'s AGMessage admin, can ' + ({ grant: 'give rights', revoke: 'take rights back', handover: 'hand AGMessage\'s admin over' })[verb] + '.';
  if (c.rights.includes(asks)) return '';
  if (!c.rights.length) return 'You have no AGMessage rights on this PC. ' + ask;
  const act = verb === 'back' ? 'take AGMessage back to its build before' : asks + ' AGMessage';
  return 'You may not ' + act + ' on this PC (your rights here: ' + rightsWords(c.rights) + '). ' + ask;
}
/**
 * A request read whole and refused for want of the right, as its machine event (`machine.refused`): who asked, what, and
 * the rights it named. What the request names is never looked up: the account named is said as it was typed.
 */
function refusedEvent(c, req, why) {
  const rights = req.verb === 'start' || req.verb === 'stop' ? [req.verb] : req.verb === 'upgrade' || req.verb === 'back' ? ['upgrade'] : Array.isArray(req.rights) ? req.rights : [];
  const asked = {
    start: 'start AGMessage',
    stop: 'stop AGMessage',
    upgrade: req.look ? 'look up AGMessage\'s newest release' : 'upgrade AGMessage' + (req.release ? ' to ' + req.release : req.file ? ' with ' + req.file : ''),
    back: 'take AGMessage back to its build before (' + req.to + ')',
    grant: 'give ' + req.account + ' ' + rightsWords(rights),
    revoke: 'take back ' + (req.rights === 'all' ? 'every right' : rightsWords(rights)) + ' from ' + req.account,
    handover: 'hand AGMessage\'s admin over to ' + req.account,
  }[req.verb];
  return eventFor(c, { kind: 'machine.refused', by: c.me, forAccount: c.me, rights, words: c.me.name + ' asked to ' + asked + ', and was refused: ' + why });
}

/**
 * start: the server task run and its server waited for until it proves it holds the token; no event when it already
 * serves. A server that has not proved itself in time is left as it is, never ended (it may be starting, or the watchdog
 * retrying a held port): the answer says the task's state and the log's last line, and the event says it was asked.
 */
async function controlStart(c) {
  const token = tokenFrom(c.root, c.fsImpl);
  if (token) {
    const h = await (c.n.hello || hello)({ port: c.port, token });
    if (h.ok) return { already: true, words: 'AGMessage is already running (build ' + h.build + ').' };
  }
  let r;
  try { r = await startAndProve({ H: c.H, root: c.root, port: c.port, fsImpl: c.fsImpl, n: c.n, end: false }); } catch (e) {
    if (!e || e.ran !== true) throw e;
    const ev = eventFor(c, { kind: 'machine.start', by: c.me, forAccount: c.me, words: c.me.name + ' ran AGMessage\'s server task; it was not answering within ' + Math.round((c.n.waitMs || START_WAIT_MS) / 1000) + ' s (the task: ' + e.task + ').' });
    throw Object.assign(e, { words: e.words + ev.why, event: ev.seq });
  }
  const ev = eventFor(c, { kind: 'machine.start', by: c.me, forAccount: c.me, words: c.me.name + ' started AGMessage (build ' + r.build + ').' });
  const audited = await nudgeServer(c);
  return { started: true, build: r.build, audited, event: ev.seq, words: 'Started.' + ev.why };
}
/** stop: the stop at loopback with the proof, refused when busy until the person types a reason; it saves. */
async function controlStop(c, req) {
  const token = tokenFrom(c.root, c.fsImpl);
  if (!token) throw refusal('AGMessage\'s token (token\\admin-token) could not be read, so it cannot be stopped at loopback. Ask an administrator.');
  const s = await stopAndWait({ port: c.port, token, reason: 'stop', by: c.me.name || c.me.sid, force: req.force || '', n: c.n });
  if (s.state === 'none') return { already: true, words: 'AGMessage is not running.' };
  const rec = readLastStop(pathOf(c.root).join(c.root, 'data'), c.fsImpl);
  const fresh = rec && !rec.unreadable && Number.isFinite(rec.at) && rec.at >= s.at;
  const words = fresh && rec.saved ? 'Stopped, saved at ' + clock(rec.at) + '.' : 'Stopped, but its save record ' + (fresh ? 'says it did not save (' + (rec.unsaved || 'not all of it') + ')' : 'was not written') + '.';
  const ev = eventFor(c, { kind: 'machine.stop', by: c.me, forAccount: c.me, words: c.me.name + ' stopped AGMessage' + (req.force ? ' while it was busy, with the reason "' + req.force + '"' : '') + ': ' + words });
  return { saved: !!(fresh && rec.saved), at: fresh ? rec.at : null, event: ev.seq, words: words + ev.why };
}
/**
 * grant: the rights asked added to the account's (U.5.1): its means first, then its Grants value, then, for `token`, its
 * read on token\. A read Windows would not give is taken off the record again and said, the grant not done.
 */
async function controlGrant(c, req) {
  const target = personFor(c, req.account, 'grant');
  if (target.sid === c.admin) throw refusal(target.name + ' is this PC\'s AGMessage admin and holds every right already.');
  const had = grantRightsOf(c.grants[target.sid]);
  const add = req.rights.filter((r) => !had.includes(r));
  if (!add.length) return { already: true, words: target.name + ' already holds ' + rightsWords(req.rights) + '.' };
  let now = RIGHTS.filter((r) => had.includes(r) || add.includes(r));
  giveMeans(c, target.sid);
  const unwritten = setGrant(c.H, target.sid, now);
  if (unwritten) {
    if (!had.length) dropMeans(c, target.sid);
    throw notDone('Nothing was given: ' + unwritten + '.', { rights: had });
  }
  let notGiven = '';
  let back = '';
  if (add.includes('token')) {
    const why = giveRead(c, 'token', target.sid);
    if (why) {
      now = now.filter((r) => r !== 'token');
      back = setGrant(c.H, target.sid, now);
      notGiven = ' token was not given: ' + target.name + ' could not be given ' + why + '.' + (back ? ' The record still names token for ' + target.name + ', which Windows does not grant (' + back + '): take it back with "Take back from ' + target.name + ': token".' : '');
    }
  }
  const given = add.filter((r) => now.includes(r));
  if (!given.length) {
    // Nothing given: an account the record names no right of loses the means made for it.
    const left = had.length || back ? [] : dropMeans(c, target.sid);
    throw notDone('Nothing was given.' + notGiven + (left.length ? ' Not yet removed: ' + left.join('; ') + '.' : ''), { rights: had });
  }
  // What the record names now: `token` too where it could not be taken off again.
  const recorded = back ? RIGHTS.filter((r) => now.includes(r) || r === 'token') : now;
  sweepOutboxes(c, { admin: c.admin, grants: { ...c.grants, [target.sid]: recorded.join(',') }, keep: c.me.sid });
  const ev = eventFor(c, { kind: 'machine.grant', by: c.me, forAccount: target, rights: given, words: c.me.name + ' gave ' + target.name + ' ' + rightsWords(given) + ' (now ' + rightsWords(now) + ').' + notGiven });
  const audited = await nudgeServer(c);
  return { code: notGiven ? NOT_DONE : DONE, rights: recorded, audited, event: ev.seq, words: 'Given: ' + target.name + ' may now ' + rightsWords(now) + ' AGMessage on this PC.' + notGiven + ev.why };
}
/**
 * revoke: the rights named taken from the account. `token` first, its read on token\ taken back, and only then the record
 * (read at every request, so what it no longer names is refused at once, even if what follows fails); a read Windows would
 * not take back stays on the record and is said, the revoke not done. With no right left, its control task, inbox\ and
 * outbox\ go. A SID the record names is taken as it is, so an account Windows no longer knows can lose its rights.
 */
async function controlRevoke(c, req) {
  let target;
  if (isSid(req.account) && Object.hasOwn(c.grants, req.account)) target = { sid: req.account, name: namesFor(c, [req.account])[req.account] || req.account };
  else {
    const ps = c.H.powershell(PS_WHOSE, { AGM_SIDS: '', AGM_ACCOUNT: String(req.account) });
    const a = ps.account && typeof ps.account === 'object' ? ps.account : {};
    target = isSid(a.sid) ? { sid: a.sid, name: said(a.name || req.account, 120) } : null;
  }
  if (target && target.sid === c.admin) throw refusal(target.name + ' is this PC\'s AGMessage admin: hand AGMessage\'s admin over to someone else to take its rights.');
  if (!target || !Object.hasOwn(c.grants, target.sid)) throw refusal(said(target ? target.name : req.account, 120) + ' has no AGMessage rights on this PC.');
  const had = grantRightsOf(c.grants[target.sid]);
  const take = req.rights === 'all' ? had : req.rights.filter((r) => had.includes(r));
  if (!take.length) return { already: true, words: target.name + ' does not hold ' + rightsWords(req.rights) + '.' };
  const tokenStays = take.includes('token') ? takeGrant(c, 'token', target.sid) : '';
  const off = take.filter((r) => r !== 'token' || !tokenStays);
  const stays = tokenStays ? ' ' + target.name + ' can still read the token: ' + tokenStays + ' could not be taken back, so the record still names token. Take it back again, or ask an administrator.' : '';
  if (!off.length) throw notDone('Nothing was taken back.' + stays, { rights: had });
  const left = had.filter((r) => !off.includes(r));
  const recordWhy = setGrant(c.H, target.sid, left);
  if (recordWhy) {
    // The record is as it was, so every right it names still holds: only a read Windows already took back is taken.
    const unrecorded = ' The record could not be written (' + recordWhy + '), so it still names ' + rightsWords(had) + ' for ' + target.name + ': take ' + (had.length === 1 ? 'it' : 'them') + ' back again.';
    if (!off.includes('token')) throw notDone('Nothing was taken back.' + unrecorded + stays, { rights: had });
    const ev = eventFor(c, { kind: 'machine.revoke', by: c.me, forAccount: target, rights: ['token'], words: c.me.name + ' took back the read on the token from ' + target.name + '.' + unrecorded });
    const audited = await nudgeServer(c);
    return { code: NOT_DONE, rights: had, audited, event: ev.seq, words: 'Taken back: only the read on the token, which ' + target.name + ' can no longer read.' + unrecorded + ev.why };
  }
  const gone = !left.length ? dropMeans(c, target.sid) : [];
  const after = { ...c.grants };
  if (left.length) after[target.sid] = left.join(','); else delete after[target.sid];
  sweepOutboxes(c, { admin: c.admin, grants: after, keep: c.me.sid });
  const ev = eventFor(c, { kind: 'machine.revoke', by: c.me, forAccount: target, rights: off, words: c.me.name + ' took back ' + rightsWords(off) + ' from ' + target.name + (left.length ? ' (still ' + rightsWords(left) + ')' : ', who now holds no right') + '.' + stays });
  const audited = await nudgeServer(c);
  return {
    code: stays ? NOT_DONE : DONE, rights: left, audited, left: gone, event: ev.seq,
    words: 'Taken back: ' + target.name + (left.length ? ' may now only ' + rightsWords(left) : ' has no AGMessage rights on this PC now') + '.' + stays
      + (gone.length ? ' Not yet removed: ' + gone.join('; ') + '; its requests are refused all the same, since the record names no right of it.' : '') + ev.why,
  };
}
/** The laptop's admin's reads, on token\ and logs\, given (again): what stopped one, as words. */
const adminReads = (c, sid) => ['token', 'logs'].map((name) => giveRead(c, name, sid)).filter(Boolean);
/**
 * handover: AGMessage's admin given to another account, confirmed by its name typed again. The new admin's means first
 * (inbox\, outbox\, control task); then the old admin's reads on token\ and logs\ taken back, and nothing handed over while
 * one stays; then the record (Admin, AdminName; the new admin's own Grants value goes, since the admin holds every right);
 * then the new admin's reads; the old admin's inbox\ now and its control task last, after this answer (it may be the task
 * running this). The old admin keeps no right unless the new one gives it back. A handover to the admin itself gives its
 * reads again, which puts right a handover whose reads Windows did not give.
 */
async function controlHandover(c, req) {
  if (req.confirm.trim().toLowerCase() !== req.account.trim().toLowerCase()) throw refusal('To hand AGMessage\'s admin over, type the new admin\'s account name again exactly: "' + req.confirm + '" is not "' + req.account + '". Nothing was changed.');
  const target = personFor(c, req.account, 'handover');
  if (target.sid === c.admin) {
    const missing = adminReads(c, target.sid);
    if (missing.length) throw notDone(target.name + ' is this PC\'s AGMessage admin already, but could not be given ' + missing.join('; ') + '.');
    return { already: true, words: target.name + ' is this PC\'s AGMessage admin already (its reads on the token and the logs given again).' };
  }
  const old = { sid: c.admin, name: c.adminName || c.admin };
  giveMeans(c, target.sid);
  // Nothing handed over: the old admin's reads given back, and the means made for an account the record names no right of
  // taken away again.
  const unhanded = (why) => {
    const back = isSid(old.sid) ? adminReads(c, old.sid) : [];
    if (!Object.hasOwn(c.grants, target.sid)) dropMeans(c, target.sid);
    return notDone('Nothing was handed over: ' + why + (back.length ? ' ' + old.name + ', still the admin, could not be given back ' + back.join('; ') + ': hand AGMessage\'s admin over to ' + old.name + ' to give it again.' : ''));
  };
  if (isSid(old.sid)) {
    const kept = ['token', 'logs'].map((name) => takeGrant(c, name, old.sid)).filter(Boolean);
    if (kept.length) throw unhanded(old.name + ' would keep ' + kept.join('; ') + ', which could not be taken back.');
  }
  try { writeValue(c.H, { name: 'Admin', type: 'REG_SZ', value: target.sid }); } catch (e) { throw unhanded(e.words); }
  const stuck = [];
  let unnamed = '';
  try { writeValue(c.H, { name: 'AdminName', type: 'REG_SZ', value: target.name }); } catch (e) { unnamed = ' The record\'s name for the admin could not be written (' + e.words.replace(/\.$/, '') + '), so its words may still name ' + old.name + '.'; }
  if (Object.hasOwn(c.grants, target.sid)) stuck.push(removeGrant(c.H, target.sid));
  const missing = adminReads(c, target.sid);
  const notGiven = missing.length ? ' ' + target.name + ' could not be given ' + missing.join('; ') + ': hand AGMessage\'s admin over to ' + target.name + ' again to give it.' : '';
  if (isSid(old.sid)) stuck.push(clearBox(c.fsImpl, pathOf(c.root).join(c.root, 'machine', 'inbox', old.sid)));
  const grants = { ...c.grants };
  delete grants[target.sid];
  sweepOutboxes(c, { admin: target.sid, grants, keep: c.me.sid });
  const ev = eventFor(c, { kind: 'machine.handover', by: c.me, forAccount: target, rights: RIGHTS, words: c.me.name + (c.elevated ? ' (an administrator)' : '') + ' handed AGMessage\'s admin on this PC over' + (isSid(old.sid) && old.sid !== c.me.sid ? ' from ' + old.name : '') + ' to ' + target.name + '; ' + (isSid(old.sid) ? old.name : 'the admin before') + ' keeps no right.' + notGiven });
  const audited = await nudgeServer(c);
  const leftWords = stuck.filter(Boolean);
  return {
    code: notGiven ? NOT_DONE : DONE, admin: target.sid, adminName: target.name, audited, left: leftWords, event: ev.seq,
    words: target.name + ' is now this PC\'s AGMessage admin, with every right and the giving of them. ' + (isSid(old.sid) ? old.name : 'The admin before') + ' keeps none, unless ' + target.name + ' gives them back.' + notGiven + unnamed + (leftWords.length ? ' Not yet removed: ' + leftWords.join('; ') + '.' : '') + ev.why,
    after: isSid(old.sid) ? () => removeTask(c.H, controlTask(old.sid)) : null,
  };
}

const CONTROL_ACTS = Object.freeze({ start: controlStart, stop: controlStop, upgrade: controlUpgrade, back: controlBack, grant: controlGrant, revoke: controlRevoke, handover: controlHandover });

/** The words when the install record names no port, or no install folder, for an act that needs it. */
const NO_PORT = 'The install record names no port, so AGMessage cannot be asked: reinstall it.';
const NO_APP = 'The install record names no install folder, so AGMessage\'s build and its kept installers cannot be read: reinstall AGMessage.';
/**
 * control: one account's request, as SYSTEM from its control task (--for), or from an administrator's elevated console
 * (--elevated, the request a file of machine\work\). Who asks is the task that ran (or the elevated account), never what
 * the request says. The request taken (takeRequest) and read (requestOf); the right read from the install record now, a
 * request refused for want of it a machine event of its own; the act done; under --for the answer written into that
 * account's outbox\, refusals too ({v, id, verb, code, words, …}), but never when no request was waiting (the answer there
 * may be another run's). An act done in part answers not done (2), with what it did.
 */
async function control(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  const elevated = opts['--elevated'] === true;
  if (elevated === (opts['--for'] !== undefined)) throw usage('machine.js control takes --for <SID> (its control task\'s) or --elevated --request <file> (an administrator\'s console), one of them.');
  const me = accountOf(H.whoami(['/user', '/fo', 'csv', '/nh']).out);
  let sid;
  let file;
  if (elevated) {
    if (!me) throw refusal('Your Windows account could not be read (whoami.exe), so nothing was done.');
    if (!elevatedOf(H.whoami(['/groups', '/fo', 'csv', '/nh']).out)) throw refusal('machine.js control --elevated runs in an administrator\'s elevated console: run Who may run AGMessage… as an administrator.');
    const asked = String(opts['--request'] || '');
    const rel = fullPath(asked) ? P.relative(P.join(root, 'machine', 'work'), asked).split(/[\\/]/) : [];
    if (rel.length !== 1 || !/^[A-Za-z0-9.-]{1,60}$/.test(rel[0])) throw usage('--request is "' + said(asked, 120) + '", which is not a file of ' + P.join(root, 'machine', 'work') + '.');
    sid = me.sid;
    file = asked;
  } else {
    sid = String(opts['--for']);
    if (!personSid(sid)) throw usage('--for is "' + said(sid, 80) + '", which is not one person\'s SID.');
    if (!me || me.sid !== SID.system) throw refusal('machine.js control --for runs as SYSTEM, from that account\'s control task: run Who may run AGMessage… as an administrator instead.');
    file = P.join(root, 'machine', 'inbox', sid, 'request.json');
  }
  const outbox = P.join(root, 'machine', 'outbox', sid);
  const answer = (a) => { if (!elevated) { try { writeAnswer(fsImpl, outbox, { v: 1, ranAs: me ? me.sid : '', for: sid, ...a }); } catch { /* its outbox is gone: the account no longer holds a right */ } } };
  let req;
  try {
    const got = requestOf(takeRequest(fsImpl, file, P.join(root, 'machine', 'work')).bytes);
    if (got.problem) throw refusal(got.problem, { id: got.id || '' });
    req = got.request;
  } catch (e) {
    if (!(e && e.none)) answer({ id: (e && e.id) || '', verb: '', code: e && e.refused ? REFUSED : NOT_DONE, words: (e && e.words) || said(e && e.message, 200) });
    throw e;
  }
  const record = readRecord(H);
  const grants = readGrants(H);
  const admin = isSid(record.values.Admin) ? record.values.Admin : '';
  const app = record.values.InstallDir || '';
  const c = {
    root, sys: opts['--sys'], H, run, fsImpl, n, elevated, machineDir: P.join(root, 'machine'), record: record.values, app, sid,
    installed: record.installed, admin, adminName: said(record.values.AdminName || '', 120), grants,
    isAdmin: !elevated && !!admin && sid === admin,
    rights: sid === admin ? [...RIGHTS] : grantRightsOf(grants[sid]),
    port: Number(record.values.Port) || 0,
    node: fullPath(app) ? pathOf(app).join(app, 'node', 'node.exe') : '', script: fullPath(app) ? pathOf(app).join(app, 'app', 'machine.js') : '',
  };
  const whoAsks = () => (elevated ? { sid: me.sid, name: me.name } : { sid, name: sid === admin ? (c.adminName || namesFor(c, [sid])[sid] || sid) : (namesFor(c, [sid])[sid] || sid) });
  let result;
  try {
    const no = mayNot(c, req.verb);
    if (no) {
      // On an install, a request beyond the asker's rights is in the audit log: who asked, and what.
      let ev = { why: '' };
      if (c.installed) {
        c.me = whoAsks();
        ev = refusedEvent(c, req, no);
        await nudgeServer(c);
      }
      throw refusal(no, { event: ev.seq || 0 });
    }
    // An upgrade's and a go back's own (recordNamesAll) are inside their acts, so each is their refusal's event.
    if ((req.verb === 'start' || req.verb === 'stop') && !c.port) throw notDone(NO_PORT);
    if (req.verb === 'upgrade' && req.look && !fullPath(app)) throw notDone(NO_APP);
    if (['grant', 'revoke', 'handover'].includes(req.verb) && !c.node) throw notDone('The install record names no install folder, so no control task can be made: reinstall AGMessage.');
    c.me = whoAsks();
    result = await CONTROL_ACTS[req.verb](c, req);
  } catch (e) {
    answer({ id: req.id, verb: req.verb, code: e && e.usage ? USAGE : e && e.refused ? REFUSED : NOT_DONE, words: (e && e.words) || said(e && e.message, 200), ...(e && e.busy ? { busy: true, forceable: true } : {}), ...(e && typeof e.why === 'string' && (req.verb === 'upgrade' || req.verb === 'back') ? { why: said(e.why, 20) } : {}) });
    throw Object.assign(e, { id: req.id });
  }
  const { after, code = DONE, ...told } = result;
  answer({ id: req.id, verb: req.verb, code, ...told });
  if (after) {
    const stuck = after();
    if (stuck) {
      told.words += ' Not yet removed: ' + stuck + ', which refuses every request since the record no longer names that account.';
      answer({ id: req.id, verb: req.verb, code, ...told });
    }
  }
  const out = { id: req.id, ...told, ranAs: me ? me.sid : '', for: sid };
  if (code !== DONE) throw notDone(told.words, out);
  return out;
}

// ---------------------------------------------------------------- the checked upgrade, and Go back to build N

/** GitHub's REST API: the one place a checked upgrade asks, with no token (a repository's releases are public). */
const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = Object.freeze({ 'user-agent': 'AGMessage-machine', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
/** A repository as build.json names it (tools/stamp-build.js, from GITHUB_REPOSITORY): owner/name, as GitHub allows them. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A release's installer, by the name the release job gives it: AGMessage-Setup-<MAJOR.MINOR.PATCH>-unsigned.exe. */
const INSTALLER_NAME = /^AGMessage-Setup-((?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4}))-unsigned\.exe$/;
/** The most an installer may be (one is tens of MB), and the most of GitHub's answer for one release a check reads. */
const INSTALLER_MAX = 512 * 1024 * 1024;
const RELEASE_MAX = 1024 * 1024;
/**
 * How long GitHub is given to answer, a download to send its next bytes, how many redirects a download follows, and how
 * long a download may take in all, so a check ends within its control task's 10 minutes (past which Task Scheduler ends
 * it) and says why.
 */
const GITHUB_MS = 20_000;
const DOWNLOAD_IDLE_MS = 60_000;
const REDIRECTS_MAX = 5;
const DOWNLOAD_MAX_MS = 7 * 60_000;
/**
 * The runner's bounds: how long it waits for the console that asked (and any other of {app}'s) to close and how often it
 * looks; how long a runner handed its plan may take to show as a program running from its folder, past which one that
 * does not was never started or has died; and how long it waits for its control task's answer before it writes its own
 * last one. An installer is never killed (Inno's rollback does not run on a kill, and the installer's own steps are
 * bounded: the stop's two minutes, the verify's 35 s, the way back's), so the runner waits for it however long it runs.
 */
const RUNNER_WAIT_MS = 10 * 60_000;
const RUNNER_POLL_MS = 2000;
const RUNNER_START_MS = 2 * 60_000;
const PENDING_WAIT_MS = 30_000;
/**
 * machine\work\upgrade.lock, held by one control task from its read of what is under way to its hand-off, so two control
 * tasks never both start a runner; past this age it is one a control task that ended left (Task Scheduler ends a control
 * task at its 10 minutes, and an elevated console's request is bounded the same).
 */
const UPGRADE_LOCK_STALE_MS = 15 * 60_000;
/** A runner's folder in machine\work\, by its own random id; a staged folder in machine\staged\, by its own. */
const RUNNER_DIR = /^upgrade-([0-9a-f]{16})$/;
const STAGED_DIR = /^[0-9a-f]{16}$/;
/** The task a control task's runner runs as, once, as SYSTEM: \AGMessage\Upgrade-<its folder's id>. */
const runnerTask = (id) => TASK_FOLDER + 'Upgrade-' + id;
/** The words when GitHub cannot be asked: with no signature (answer 36) nothing checks an installer offline. */
const OFFLINE_WORDS = 'AGMessage could not check this installer against its release (no internet). Run it yourself: Windows will ask for an administrator\'s approval.';
const NOT_THE_RELEASES = 'This file is not the release\'s. Do not run it.';

/** The version an installer's name carries (INSTALLER_NAME), or '' (pure). */
const installerSemver = (name) => { const m = INSTALLER_NAME.exec(String(name || '')); return m ? m[1] : ''; };
/** A release's installer's name for its version (pure). */
const installerName = (semver) => 'AGMessage-Setup-' + semver + '-unsigned.exe';
/** An install version's build number: what follows its last dot (pure). */
const buildOfVersion = (v) => String(v || '').split('.').pop();
const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
/** SemVer precedence of two MAJOR.MINOR.PATCH versions (lib/version.js compareVersions, held to it): 1, -1 or 0 (pure). */
function compareSemver(a, b) {
  const p = String(a).split('.').map(Number), q = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] > q[i] ? 1 : -1;
  return 0;
}
/** The repository a build names: its build.json's `repo`, or '' when it names none of the shape (pure). */
function repoOf(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return ''; /* no stamp: a local build names no repository */ }
  return j && typeof j.repo === 'string' && REPO.test(j.repo) ? j.repo : '';
}
/** What the install record says is installed (pure): {semver, version, build}, each '' when it names none of its shape. */
function installedOf(values) {
  const semver = SEMVER.test(String(values.SemVer || '')) ? values.SemVer : '';
  const version = INSTALL_VERSION.test(String(values.Version || '')) ? values.Version : '';
  return { semver, version, build: version ? buildOfVersion(version) : '' };
}
const installedWords = (i) => (i.semver ? 'AGMessage ' + i.semver + (i.build ? ' (build ' + i.build + ')' : '') : 'the AGMessage installed');
/** Whether `url` begins with `prefix`, letter case aside: GitHub's owners and names are not case-sensitive (pure). */
const under = (url, prefix) => typeof url === 'string' && url.toLowerCase().startsWith(prefix.toLowerCase());

/**
 * GitHub's release answer judged for an installer (pure): {asset: {name, size, digest, id, url}}, `digest` the SHA-256
 * GitHub gives (hex), or {why, words}. The release must be `v<semver>` of `repo` (its API address and its page both under
 * that repository), published (no draft) and immutable (the repository's own setting, its owner's to turn on: a release
 * published while it is off is never immutable, and every check of it is refused here, fail closed); one asset must have the exact name `name`, be uploaded whole, of a size an installer has,
 * under that repository's assets, and give a digest of the form `sha256:<64 hex>`.
 */
function releaseJudged(rel, { repo, semver, name }) {
  const tag = 'v' + semver;
  const of = 'the release ' + tag + ' of ' + repo;
  const no = (why, words) => ({ why, words });
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return no('repository', 'GitHub\'s answer for ' + tag + ' of ' + repo + ' is not a release, so this installer was not run.');
  if (rel.tag_name !== tag || !under(rel.url, GITHUB_API + '/repos/' + repo + '/releases/') || !under(rel.html_url, 'https://github.com/' + repo + '/releases/')) {
    return no('repository', 'GitHub\'s answer for ' + tag + ' is not a release of ' + repo + ', the repository this AGMessage was built from, so this installer was not run.');
  }
  if (rel.draft === true) return no('repository', capital(of) + ' is a draft, not a published release, so this installer was not run.');
  if (rel.immutable !== true) return no('immutable', capital(of) + ' is not immutable, so its files could still be replaced: AGMessage runs an installer with no administrator only from an immutable release. Run it yourself: Windows will ask for an administrator\'s approval.');
  const same = Array.isArray(rel.assets) ? rel.assets.filter((a) => a && typeof a === 'object' && a.name === name) : [];
  if (same.length !== 1) return no('asset', capital(of) + ' holds ' + (same.length ? 'more than one file' : 'no file') + ' named ' + name + ', so this installer is not its: it was not run.');
  const a = same[0];
  const digest = typeof a.digest === 'string' ? (/^sha256:([0-9a-f]{64})$/.exec(a.digest) || [])[1] : undefined;
  if (!digest) return no('digest', capital(of) + ' gives no SHA-256 digest for ' + name + ', so this installer could not be checked: it was not run.');
  if (!under(a.url, GITHUB_API + '/repos/' + repo + '/releases/assets/') || String(a.browser_download_url || '').toLowerCase() !== ('https://github.com/' + repo + '/releases/download/' + tag + '/' + name).toLowerCase()) {
    return no('repository', 'The file ' + name + ' that GitHub names for ' + tag + ' is not one of ' + repo + '\'s release files, so this installer was not run.');
  }
  if (a.state !== 'uploaded' || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > INSTALLER_MAX) return no('asset', capital(of) + '\'s ' + name + ' is not a whole file of an installer\'s size (' + said(a.state || 'no state', 20) + ', ' + (Number.isSafeInteger(a.size) ? a.size : 'no') + ' bytes), so it was not run.');
  return { asset: { name, size: a.size, digest, id: Number.isSafeInteger(a.id) ? a.id : 0, url: a.url } };
}
/** The words for GitHub's answer when it is no release to judge (pure): {why, words}; `asked` names what was asked. */
function githubWords(r, { repo, asked }) {
  if (!r || r.error) return { why: 'offline', words: OFFLINE_WORDS };
  if (r.status === 200) return { why: 'repository', words: 'GitHub\'s answer for the ' + asked + ' of ' + repo + ' is not a release AGMessage reads, so this installer was not run.' };
  if (r.status === 404) return { why: 'repository', words: repo + ' has no ' + asked + ' on GitHub, so this installer is not one of its releases: it was not run.' };
  if (r.status >= 300 && r.status < 400) return { why: 'repository', words: 'GitHub answered for the ' + asked + ' of ' + repo + ' from another place (HTTP ' + r.status + '), so this installer was not run.' };
  const limit = (r.status === 403 || r.status === 429) && r.headers && String(r.headers['x-ratelimit-remaining']) === '0';
  return { why: 'github', words: 'GitHub did not answer this check (HTTP ' + r.status + (limit ? ': its rate limit for this PC\'s address' : '') + '). Try again later, or run the installer yourself: Windows will ask for an administrator\'s approval.' };
}
/** Why `semver` is no upgrade of what is installed (pure): '' when it is newer, by SemVer, than the record's. */
function newerRefusal(semver, installed) {
  if (!installed.semver) return 'The install record names no version, so AGMessage cannot tell whether ' + semver + ' is newer: run the installer yourself (Windows will ask for an administrator\'s approval).';
  const d = compareSemver(semver, installed.semver);
  if (d === 0) return 'AGMessage ' + semver + ' is the version this PC has already (' + installedWords(installed) + '): an upgrade installs only a newer release.';
  if (d < 0) return 'AGMessage ' + semver + ' is older than this PC\'s ' + installedWords(installed) + ': an upgrade installs only a newer release (Go back to build N takes it back to the build before).';
  return '';
}
/**
 * The installer's switches for a run with no one at it (pure): Inno's /VERYSILENT, /SUPPRESSMSGBOXES and /NORESTART;
 * /ROLLBACK for the way back; /UPGRADEBY=<sid> when SYSTEM runs it for an account (the installer takes it from SYSTEM
 * alone); /FORCE=<reason> when a reason was typed (a double quote, which Inno's command line cannot carry, made a single
 * one); /LOG=<file>.
 */
function installerArgs({ sid = '', force = '', log = '', rollback = false } = {}) {
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  if (rollback) args.push('/ROLLBACK');
  if (sid) args.push('/UPGRADEBY=' + sid);
  if (force) args.push('/FORCE=' + String(force).replace(/"/g, '\''));
  if (log) args.push('/LOG=' + log);
  return args;
}
/**
 * An installer's exit code in words, of what the installer itself did (pure): Inno Setup's codes, and the installer's own
 * 3 for a build it laid down and set up that did not answer (its way back, which may or may not have laid the build before
 * down: the record and the port say which). What the runner did before it ran is the runner's words, not these.
 */
function exitWords(code) {
  return {
    0: 'it installed and its build answers',
    1: 'it refused before it replaced a file',
    2: 'it was cancelled before it replaced a file',
    3: 'the build it laid down did not start',
    5: 'it was cancelled',
    7: 'it refused before it replaced a file',
  }[code] || (code < 0 ? 'it could not be run' : 'it did not finish');
}
/** The newest backup an upgrade from `previous` made, from the backups' records (pure): its {name, build, stopAt, saved}, or null. */
function backupFor(list, previous) {
  const of = list.filter((b) => b && typeof b.build === 'string' && installOf(b.build) && installOf(b.build).version === previous && Number.isFinite(b.stopAt));
  of.sort((a, b) => b.stopAt - a.stopAt);
  return of[0] || null;
}

/**
 * One GET of an https address: {status, headers, body} (`body` the bytes, at most `max`), or {status, headers, bytes}
 * when the bytes went to `toFd`; {status, location} for a redirect not followed; {error} when nothing whole came ('silent'
 * when nothing came for `timeoutMs`, 'too large' past `max`, 'not https' for any other address). Up to `follow` redirects
 * are followed, each to an https address. `tls` adds to the connection's options (a test's own certificate authority).
 */
function fetchHttps(url, { headers = {}, timeoutMs = GITHUB_MS, max = RELEASE_MAX, toFd = null, fsImpl = fs, follow = 0, tls = {}, until = 0 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ error: 'not an address' }); return; }
    if (u.protocol !== 'https:') { resolve({ error: 'not https' }); return; }
    if (until && Date.now() >= until) { resolve({ error: 'too slow' }); return; }
    let done = false;
    let late = null;
    const finish = (v) => { if (!done) { done = true; if (late) clearTimeout(late); resolve(v); } };
    const req = https.get(u, { headers, agent: false, ...tls }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        res.resume();
        const location = typeof res.headers.location === 'string' ? res.headers.location : '';
        if (!location || follow <= 0) { finish({ status, headers: res.headers, location }); return; }
        let next;
        try { next = new URL(location, u).href; } catch { finish({ error: 'a redirect to no address' }); return; }
        fetchHttps(next, { headers, timeoutMs, max, toFd, fsImpl, follow: follow - 1, tls, until }).then(finish);
        return;
      }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > max) { req.destroy(Object.assign(new Error('too large'), { code: 'too large' })); return; }
        if (toFd === null || status !== 200) { if (toFd === null) chunks.push(c); return; }
        try { for (let off = 0; off < c.length;) off += fsImpl.writeSync(toFd, c, off, c.length - off); } catch (e) { req.destroy(e); }
      });
      res.on('end', () => finish(toFd === null ? { status, headers: res.headers, body: Buffer.concat(chunks) } : { status, headers: res.headers, bytes: status === 200 ? n : 0 }));
      res.on('error', (e) => finish({ error: e.code || e.message }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('silent'), { code: 'silent' })));
    // `until` bounds the whole answer, a slow one that never goes silent included.
    if (until) late = setTimeout(() => req.destroy(Object.assign(new Error('too slow'), { code: 'too slow' })), Math.max(0, until - Date.now()));
    req.on('error', (e) => finish({ error: e.code || e.message }));
  });
}
/** GitHub's REST answer for `p` (a path under the API): {status, json, headers}, `json` null unless a 200 read whole; or {error}. */
async function githubGet(p, { tls } = {}) {
  const r = await fetchHttps(GITHUB_API + p, { headers: GITHUB_HEADERS, max: RELEASE_MAX, tls });
  if (r.error) return { error: r.error };
  let json = null;
  if (r.status === 200) { try { json = JSON.parse(r.body.toString('utf8')); } catch { json = null; /* not JSON: no release to judge */ } }
  return { status: r.status, json, headers: r.headers || {} };
}
/**
 * A release's installer downloaded straight into `file`, a new file (its API address, which redirects to GitHub's
 * storage), within `maxMs` in all.
 */
async function downloadAsset(asset, file, { fsImpl = fs, tls, maxMs = DOWNLOAD_MAX_MS } = {}) {
  const fd = fsImpl.openSync(file, 'wx');
  try {
    return await fetchHttps(asset.url, { headers: { ...GITHUB_HEADERS, accept: 'application/octet-stream' }, max: asset.size, toFd: fd, fsImpl, follow: REDIRECTS_MAX, timeoutMs: DOWNLOAD_IDLE_MS, tls, until: Date.now() + maxMs });
  } finally { fsImpl.closeSync(fd); }
}
/** A file's SHA-256 (hex), read through its own handle. */
function sha256File(fsImpl, file) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) { const n = fsImpl.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
    return h.digest('hex');
  } finally { fsImpl.closeSync(fd); }
}

/** A new folder of machine\staged\ (SYSTEM and Administrators only) for one staged installer: {dir, file}. */
function stagedPlace(fsImpl, root, name) {
  const P = pathOf(root);
  const staged = P.join(root, 'machine', 'staged');
  const real = realDir(fsImpl, staged);
  if (!real.ok) throw notDone('machine\\staged ' + real.why + ': nothing was staged.');
  const dir = P.join(staged, crypto.randomBytes(8).toString('hex'));
  fsImpl.mkdirSync(dir);
  return { dir, file: P.join(dir, name) };
}
/** A staged folder removed (machine\staged\'s, which only SYSTEM and Administrators write). */
function removeStaged(fsImpl, dir) {
  try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch { /* in use: the next upgrade's sweep takes it */ }
}
/**
 * A named installer staged (step 1): `from`, a file of the account's inbox, refused when lstat shows a link, a hard link,
 * anything but a file, an empty one or one over INSTALLER_MAX; opened without following a link, the file read the one
 * lstat saw (fstat's device and index alike, and its size); its bytes copied into a new file of a new folder of
 * machine\staged\, refused when they were not that size. The inbox's file is removed whatever it held, so nothing there
 * is read twice. {dir, file, size}. Only that copy is ever hashed or run.
 */
function stageInstaller(fsImpl, from, root, name) {
  const changed = () => refusal('The installer you named changed while it was read: it was not run.', { why: 'link' });
  let place = null;
  try {
    let st;
    try { st = fsImpl.lstatSync(from, { bigint: true }); } catch (e) {
      throw refusal(e.code === 'ENOENT' ? 'No installer was waiting in your inbox: name it again in Upgrade AGMessage….' : 'The installer you named could not be read (' + (e.code || e.message) + ').', { why: 'file' });
    }
    if (st.isSymbolicLink()) throw refusal('The installer you named reached AGMessage\'s control task as a link, which it never follows: it was not run.', { why: 'link' });
    if (!st.isFile()) throw refusal('What you named is not a file: it was not run.', { why: 'link' });
    if (st.nlink > 1n) throw refusal('The installer you named is a link to another file (a hard link), which the control task never reads: it was not run.', { why: 'link' });
    if (st.size < 1n || st.size > BigInt(INSTALLER_MAX)) throw refusal('The file you named is ' + (st.size < 1n ? 'empty' : 'over ' + MB(INSTALLER_MAX)) + ', which no AGMessage installer is: it was not run.', { why: 'file' });
    place = stagedPlace(fsImpl, root, name);
    const src = fsImpl.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let dst = null;
    try {
      const ft = fsImpl.fstatSync(src, { bigint: true });
      if (!ft.isFile() || !sameFile(ft, st) || ft.size !== st.size) throw changed();
      dst = fsImpl.openSync(place.file, 'wx');
      const buf = Buffer.alloc(1024 * 1024);
      let n = 0;
      for (;;) {
        const got = fsImpl.readSync(src, buf, 0, buf.length, null);
        if (!got) break;
        n += got;
        if (BigInt(n) > ft.size) throw changed();
        for (let off = 0; off < got;) off += fsImpl.writeSync(dst, buf, off, got - off);
      }
      if (BigInt(n) !== ft.size) throw changed();
    } finally {
      fsImpl.closeSync(src);
      if (dst !== null) fsImpl.closeSync(dst);
    }
    return { ...place, size: Number(st.size) };
  } catch (e) {
    if (place) removeStaged(fsImpl, place.dir);
    throw e;
  } finally {
    try { fsImpl.unlinkSync(from); } catch { try { fsImpl.rmdirSync(from); } catch { /* gone already, or a folder holding files: never read */ } }
  }
}

/** The repository and what is installed, as the control task reads them: build.json's `repo` beside the installed app. */
function upgradeFacts(c) {
  let text = '';
  try { text = c.fsImpl.readFileSync(pathOf(c.app).join(c.app, 'app', 'build.json'), 'utf8'); } catch { /* no stamp: it names no repository, refused below */ }
  return { repo: repoOf(text), installed: installedOf(c.record) };
}
const NO_REPO = 'This build of AGMessage names no repository it was released from (its app\\build.json), so no installer can be checked against a release: run the installer yourself (Windows will ask for an administrator\'s approval).';
/**
 * The release asked of GitHub for `repo`: the one tagged v<semver>, or the newest published one when `semver` is ''; then
 * judged (releaseJudged). {semver, asset}, or a refusal in the words a person reads ({why}: 'offline', 'repository',
 * 'github', 'immutable', 'asset', 'digest').
 */
async function releaseFor(c, repo, semver) {
  const p = '/repos/' + repo + '/releases/' + (semver ? 'tags/v' + semver : 'latest');
  let r;
  try { r = await (c.n.github || githubGet)(p); } catch (e) { r = { error: (e && (e.code || e.message)) || 'no answer' }; }
  if (!r || r.error || r.status !== 200 || !r.json) {
    const g = githubWords(r, { repo, asked: semver ? 'release v' + semver : 'release published' });
    throw refusal(g.words, { why: g.why, detail: r && r.error ? said(r.error, 60) : '' });
  }
  const sv = semver || ((/^v(\d{1,5}\.\d{1,5}\.\d{1,5})$/.exec(String(r.json.tag_name || '')) || [])[1] || '');
  if (!SEMVER.test(sv)) throw refusal('The newest release of ' + repo + ' names no version AGMessage reads (' + said(r.json.tag_name || 'no tag', 40) + '), so nothing was looked up.', { why: 'repository' });
  const j = releaseJudged(r.json, { repo, semver: sv, name: installerName(sv) });
  if (j.why) throw refusal(j.words, { why: j.why });
  return { semver: sv, asset: j.asset };
}
/** How busy AGMessage is, asked at loopback with the proof (step 4): a busy one refused until the person types a reason. */
async function busyCheck(c, force, act) {
  const token = tokenFrom(c.root, c.fsImpl);
  if (!token) throw refusal('AGMessage\'s token (token\\admin-token) could not be read, so it cannot be asked how busy it is: nothing was ' + act.done + '. Ask an administrator.', { why: 'token' });
  const b = await (c.n.busy || busyAsk)({ port: c.port, token });
  if (b.busy && !force) throw refusal('Not ' + act.done + ': AGMessage is busy (' + (b.words || 'activity in the last 10 minutes') + '). Type a reason to ' + act.verb + ' anyway.', { why: 'busy', busy: true, forceable: true, line: b.line || null });
  return b;
}
/**
 * machine\work\upgrade.lock taken (made only where none is), from the read of what is under way to the hand-off, so two
 * control tasks (two accounts' own, or a console's elevated request beside one) never both start a runner: a function
 * that gives it back, or a refusal while another holds it. One older than UPGRADE_LOCK_STALE_MS was left by a control task
 * that ended, and is taken over.
 */
function upgradeLock(c) {
  const lock = pathOf(c.root).join(c.root, 'machine', 'work', 'upgrade.lock');
  const held = (at) => refusal('Another upgrade or go back is being checked now' + (at ? ' (asked at ' + clock(at) + ')' : '') + ': wait for it to end, then ask again.', { why: 'running' });
  for (let tries = 0; tries < 3; tries++) {
    let fd;
    try { fd = c.fsImpl.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw notDone('machine\\work\\upgrade.lock could not be made (' + (e.code || e.message) + '): nothing was changed.', { why: 'lock' });
      let st;
      try { st = c.fsImpl.statSync(lock); } catch { continue; /* given back since: tried again */ }
      if (Date.now() - st.mtimeMs <= UPGRADE_LOCK_STALE_MS) throw held(st.mtimeMs);
      try { c.fsImpl.unlinkSync(lock); } catch { /* another took it over first */ }
      continue;
    }
    try { c.fsImpl.writeSync(fd, JSON.stringify({ at: Date.now(), for: c.sid })); } finally { c.fsImpl.closeSync(fd); }
    return () => { try { c.fsImpl.unlinkSync(lock); } catch { /* given back already */ } };
  }
  throw held(0);
}
/** A folder's age, by its last change: Infinity when it cannot be read (pure but for the read). */
function ageOf(fsImpl, dir) {
  try { return Date.now() - fsImpl.statSync(dir).mtimeMs; } catch { return Infinity; }
}
/** A runner's folder swept, with the task it ran as: what it held is the runner's own copy, its plan and its log. */
function sweepRunner(c, dir, id) {
  try { c.fsImpl.rmSync(dir, { recursive: true, force: true }); } catch { /* its node.exe still held: the next sweep takes it */ }
  removeTask(c.H, runnerTask(id));
}
/**
 * The runners' folders in machine\work\, read under the upgrade's lock. A runner is under way while a program runs from
 * its folder (its own copy of node.exe: programsIn, fail closed), or while it has had less than RUNNER_START_MS to show
 * as one; said, since an upgrade asked now would race it. One whose end is written is swept, with its task. One with no
 * end and no program running from it died (a kill, a power cut) before it said its outcome: its outcome is its event now,
 * from what the install record names (`machine.upgrade` when the record names its target, `machine.upgrade.refused`
 * otherwise), then it is swept. A folder with no plan its control task wrote is swept once older than RUNNER_START_MS.
 * With none under way, each staged folder older than the lock's stale age (none a check may still hold) is removed. ''
 * when none is under way.
 */
function runnerUnderWay(c) {
  const P = pathOf(c.root);
  const work = P.join(c.root, 'machine', 'work');
  let names = [];
  try { names = c.fsImpl.readdirSync(work); } catch { /* no work folder: no runner */ }
  for (const name of names.filter((x) => RUNNER_DIR.test(x))) {
    const dir = P.join(work, name);
    const id = RUNNER_DIR.exec(name)[1];
    let plan = null;
    try { plan = planOf(c.fsImpl.readFileSync(P.join(dir, 'plan.json'), 'utf8')); } catch { plan = null; /* none written */ }
    if (plan && (plan.id !== id || plan.root !== c.root)) plan = null;
    if (c.fsImpl.existsSync(P.join(dir, 'ended.json'))) {
      if (plan && plan.staged) removeStaged(c.fsImpl, plan.staged);   // its end removes it; one still in use then goes now
      sweepRunner(c, dir, id);
      continue;
    }
    if (!plan) { if (ageOf(c.fsImpl, dir) > RUNNER_START_MS) sweepRunner(c, dir, id); continue; }
    const what = plan.kind === 'back' ? 'A go back' : 'An upgrade';
    const under = () => what + ' asked at ' + clock(plan.at) + ' is still under way: wait for it to end (AGMessage status says how AGMessage runs), then ask again.';
    if (Date.now() - plan.at < RUNNER_START_MS) return under();
    if (programsIn({ '--app': dir, '--sys': c.sys }, c.run).length) return under();
    // Died with no end written: its end, then its one event, then the sweep, so a sweep that fails says it only once.
    try { c.fsImpl.writeFileSync(P.join(dir, 'ended.json'), JSON.stringify({ at: Date.now(), code: NOT_DONE, died: true })); } catch { /* the event below still says it */ }
    const now = installedOf(readRecord(c.H).values);
    const reached = plan.kind === 'back' ? now.version === plan.to : now.semver === plan.to;
    const who = plan.by.name || plan.by.sid;
    const asked = plan.kind === 'back' ? 'take AGMessage back to build ' + buildOfVersion(plan.to) : 'upgrade AGMessage to ' + plan.to;
    const tail = 'its runner ended at no step it said (its program is gone), and the install record names ' + installedWords(now).replace(/^AGMessage /, '') + ' now.';
    eventFor(c, reached
      ? { kind: 'machine.upgrade', by: plan.by, forAccount: plan.by, rights: ['upgrade'], words: who + (plan.kind === 'back' ? ' took AGMessage back from ' : ' upgraded AGMessage from ') + installedWords(plan.from).replace(/^AGMessage /, '') + ' to ' + installedWords(now).replace(/^AGMessage /, '') + ', asked at ' + clock(plan.at) + ': ' + tail }
      : { kind: 'machine.upgrade.refused', by: plan.by, forAccount: plan.by, rights: ['upgrade'], words: who + ' asked to ' + asked + ' at ' + clock(plan.at) + '; it did not happen: ' + tail });
    if (plan.staged) removeStaged(c.fsImpl, plan.staged);
    sweepRunner(c, dir, id);
  }
  const staged = P.join(c.root, 'machine', 'staged');
  let left = [];
  try { left = c.fsImpl.readdirSync(staged); } catch { /* no staged folder: nothing to sweep */ }
  for (const name of left) if (STAGED_DIR.test(name) && ageOf(c.fsImpl, P.join(staged, name)) > UPGRADE_LOCK_STALE_MS) removeStaged(c.fsImpl, P.join(staged, name));
  return '';
}
/**
 * A runner's task (Task Scheduler's schema 1.3; pure): SYSTEM, run on demand only (no trigger) and once, its action the
 * runner's own copy of node.exe on its copy of machine.js, both in its folder of machine\work\, its descriptor SYSTEM's and
 * Administrators' alone. A task of its own puts the runner in a job of its own: the control task that made it ends while
 * it runs (Task Scheduler ends a task's job at its time limit, and a detached child does not break away from it). No time
 * limit: the runner never kills an installer, and waits for it however long it runs. No token or password is in it.
 */
function runnerTaskXml({ node, args, cwd, uri }) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>AGMessage: one checked upgrade or go back, run once as SYSTEM from its own copy in machine\\work\\.</Description>',
    '    <URI>' + xmlText(uri) + '</URI>',
    '    <SecurityDescriptor>' + SERVER_TASK_SDDL + '</SecurityDescriptor>',
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>' + SID.system + '</UserId>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + xmlText(node) + '</Command>',
    '      <Arguments>' + xmlText(args.map(winArg).join(' ')) + '</Arguments>',
    '      <WorkingDirectory>' + xmlText(cwd) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}
/**
 * The run handed to a runner (step 5): a new folder of machine\work\ (SYSTEM and Administrators only), the plan written
 * first (from then on the folder reads as a runner's, under way until its end is written), then a copy of this node.exe
 * and machine.js beside it, so nothing runs from {app} while the installer replaces it. A control task's runner is a task
 * of its own, run once as SYSTEM (runnerTaskXml), registered and run with schtasks.exe; an elevated console's is started
 * there on its own (detached), as that administrator, outside any task's job. The control task then ends. `c.n.runner`
 * stands in for the programs and the spawn in a test.
 */
function startRunner(c, plan) {
  const { execPath = process.execPath, script = __filename, spawn = childProcess.spawn } = c.n.runner || {};
  const P = pathOf(c.root);
  const dir = P.join(c.root, 'machine', 'work', 'upgrade-' + plan.id);
  const runnerNode = P.join(dir, 'node.exe');
  const copy = P.join(dir, 'machine.js');
  const planFile = P.join(dir, 'plan.json');
  const args = [copy, 'upgrade', '--step', 'run', '--plan', planFile, '--sys', c.sys];
  const tn = runnerTask(plan.id);
  c.fsImpl.mkdirSync(dir);
  let started = null;
  let why = '';
  try {
    c.fsImpl.writeFileSync(planFile, JSON.stringify(plan), { flag: 'wx' });
    c.fsImpl.copyFileSync(execPath, runnerNode);
    c.fsImpl.copyFileSync(script, copy);
    if (c.elevated) {
      const child = spawn(runnerNode, args, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
      if (child && Number.isSafeInteger(child.pid)) {
        if (typeof child.on === 'function') child.on('error', () => {});   // a start that fails late leaves no program: its folder is swept as a runner that died
        if (typeof child.unref === 'function') child.unref();
        started = { pid: child.pid };
      } else why = 'its runner did not start';
    } else {
      const xml = P.join(dir, 'task.xml');
      c.fsImpl.writeFileSync(xml, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(runnerTaskXml({ node: runnerNode, args, cwd: dir, uri: tn }), 'utf16le')]), { flag: 'wx' });
      const made = c.H.schtasks(['/Create', '/TN', tn, '/XML', xml, '/F']);
      try { c.fsImpl.unlinkSync(xml); } catch { /* left in the runner's folder, swept with it; it holds no secret */ }
      if (made.code !== 0) why = 'its task ' + tn + ' could not be registered: ' + (made.err || 'schtasks.exe ended with ' + made.code);
      else {
        const ran = c.H.schtasks(['/Run', '/TN', tn]);
        if (ran.code === 0) started = { task: tn };
        else why = 'its task ' + tn + ' could not be run: ' + (ran.err || 'schtasks.exe ended with ' + ran.code);
      }
    }
  } catch (e) { why = (e && (e.code || e.message)) || 'no answer'; }
  if (!started) {
    try { c.fsImpl.writeFileSync(P.join(dir, 'ended.json'), JSON.stringify({ at: Date.now(), code: NOT_DONE })); } catch { /* swept by the next upgrade, as a folder with no program */ }
    if (!c.elevated) removeTask(c.H, tn);
    throw notDone('The ' + (plan.kind === 'back' ? 'go back' : 'upgrade') + ' could not be started (' + said(why, 200) + '): nothing was run.', { why: 'runner' });
  }
  return { dir, planFile, ...started };
}
/** A checked upgrade's or a go back's refusal, as its machine event (`machine.upgrade.refused`: who, and why). */
async function upgradeRefusedEvent(c, asked, why) {
  const ev = eventFor(c, { kind: 'machine.upgrade.refused', by: c.me, forAccount: c.me, rights: ['upgrade'], words: (c.me.name || c.me.sid) + ' asked to ' + asked + ', and was refused: ' + why });
  await nudgeServer(c);
  return ev;
}
/** The newest release, looked up and judged, and whether it is newer than what is installed: no event, nothing staged. */
async function lookUpgrade(c, facts) {
  if (!facts.repo) throw refusal(NO_REPO, { why: 'norepo' });
  const rel = await releaseFor(c, facts.repo, '');
  const older = newerRefusal(rel.semver, facts.installed);
  const release = { semver: rel.semver, name: rel.asset.name, size: rel.asset.size, digest: 'sha256:' + rel.asset.digest };
  return {
    look: true, release, newer: !older, installed: facts.installed,
    words: older ? 'The newest release, AGMessage ' + rel.semver + ', is not newer than this PC\'s ' + installedWords(facts.installed) + '.' : 'The newest release is AGMessage ' + rel.semver + ' (' + rel.asset.name + ', ' + MB(rel.asset.size) + '); this PC has ' + installedWords(facts.installed) + '.',
  };
}
/** The answer the person reads while their console closes and the runner waits for it: what was checked, and what follows. */
const handedWords = (what) => what + ' It begins once this window has closed (press Enter): nothing of AGMessage may still run from its folder while its files are replaced.';

/**
 * upgrade: Upgrade AGMessage…, for the laptop's admin and an account given `upgrade`, with no administrator. A look names
 * the newest release and whether it is newer, and changes nothing (no event). Otherwise, as SYSTEM, in the plan's order:
 * 1. the file staged in machine\staged\ (a named one copied by its bytes from the account's inbox, stageInstaller; the
 *    newest release's asset downloaded straight there, once its release is judged and found newer);
 * 2. its release asked of GitHub (releaseFor), for the repository this build names, by the version the file's name or the
 *    release's tag carries: immutable, one asset of the file's exact name, and its digest equal to the staged copy's
 *    SHA-256;
 * 3. newer than the installed one, by SemVer (the record's), which the installer's own check refuses a second time;
 * 4. how busy AGMessage is, a busy one refused until the person types a reason;
 * 5. the run, handed to a runner (startRunner, upgradeRun) with the staged copy, whose SHA-256 it reads again before it
 *    runs it.
 * Each refusal is a `machine.upgrade.refused` event, the staged copy removed; the run's outcome is its runner's one event,
 * once it is seen. The read of what is under way and the hand-off hold machine\work\upgrade.lock (upgradeLock). An
 * administrator's elevated console has its own installer run as it, with no check: a file it names is refused here.
 */
async function controlUpgrade(c, req) {
  const facts = upgradeFacts(c);
  if (req.look) return lookUpgrade(c, facts);
  const asked = 'upgrade AGMessage to ' + (req.file ? installerSemver(req.file) + ' (' + req.file + ')' : req.release + ' (its release)');
  let staged = null;
  let handed = false;
  let unlock = null;
  try {
    recordNamesAll(c);
    if (c.elevated && req.file) throw refusal('You are an administrator here: run ' + req.file + ' yourself, and Windows takes your approval as it runs. Upgrade AGMessage… checks an installer for the accounts that are not administrators.', { why: 'elevated' });
    unlock = upgradeLock(c);
    const busyRun = runnerUnderWay(c);
    if (busyRun) throw refusal(busyRun, { why: 'running' });
    if (!facts.repo) throw refusal(NO_REPO, { why: 'norepo' });
    const P = pathOf(c.root);
    let semver;
    let asset;
    let sum;
    if (req.file) {
      semver = installerSemver(req.file);
      staged = stageInstaller(c.fsImpl, P.join(c.root, 'machine', 'inbox', c.sid, req.file), c.root, req.file);
      sum = sha256File(c.fsImpl, staged.file);
      ({ asset } = await releaseFor(c, facts.repo, semver));
      if (sum !== asset.digest) throw refusal(NOT_THE_RELEASES, { why: 'digest' });
      const older = newerRefusal(semver, facts.installed);
      if (older) throw refusal(older, { why: 'newer' });
    } else {
      semver = req.release;
      ({ asset } = await releaseFor(c, facts.repo, semver));
      const older = newerRefusal(semver, facts.installed);
      if (older) throw refusal(older, { why: 'newer' });
      staged = stagedPlace(c.fsImpl, c.root, asset.name);
      let got;
      try { got = await (c.n.download || downloadAsset)(asset, staged.file, { fsImpl: c.fsImpl }); } catch (e) { got = { error: (e && (e.code || e.message)) || 'no answer' }; }
      if (!got || got.error || got.status !== 200 || got.bytes !== asset.size) {
        const how = got && got.error === 'too slow' ? 'not within ' + DOWNLOAD_MAX_MS / 60_000 + ' minutes' : got && got.error ? got.error : got ? (got.status === 200 ? got.bytes + ' of ' + asset.size + ' bytes' : 'HTTP ' + got.status) : 'no answer';
        throw refusal('The release\'s installer could not be downloaded whole (' + said(how, 60) + '): nothing was run. Try again, or run it yourself: Windows will ask for an administrator\'s approval.', { why: 'download' });
      }
      sum = sha256File(c.fsImpl, staged.file);
      if (sum !== asset.digest) throw refusal('The installer downloaded from ' + facts.repo + '\'s release v' + semver + ' is not the release\'s (its SHA-256 differs from the digest GitHub gives): nothing was run.', { why: 'digest' });
    }
    await busyCheck(c, req.force, { done: 'upgraded', verb: 'upgrade it' });
    const plan = {
      v: 1, id: crypto.randomBytes(8).toString('hex'), request: req.id, kind: 'upgrade', at: Date.now(), for: c.sid, by: c.me, elevated: c.elevated,
      root: c.root, app: c.app, port: c.port, repo: facts.repo, from: facts.installed, to: semver,
      installer: staged.file, staged: staged.dir, digest: sum, force: req.force || '',
    };
    const r = startRunner(c, plan);
    handed = true;
    return {
      pending: true, release: { semver, name: asset.name, size: asset.size, digest: 'sha256:' + sum }, runner: r.task || r.pid,
      words: handedWords('Checked: ' + asset.name + ' is ' + facts.repo + '\'s release v' + semver + ' (immutable; SHA-256 ' + sum + '), newer than this PC\'s ' + installedWords(facts.installed) + '. AGMessage then stops (it saves and backs its data up), is upgraded, and starts again; if the new build does not start, the build before is laid back by itself.'),
    };
  } catch (e) {
    if (staged && !handed) removeStaged(c.fsImpl, staged.dir);
    // A named installer refused before it was staged leaves nothing in the inbox either.
    if (req.file) { try { c.fsImpl.unlinkSync(pathOf(c.root).join(c.root, 'machine', 'inbox', c.sid, req.file)); } catch { /* staged and removed already, or none there */ } }
    const ev = await upgradeRefusedEvent(c, asked, (e && e.words) || said(e && e.message, 200));
    throw Object.assign(e, { event: ev.seq });
  } finally {
    if (unlock) unlock();
  }
}
/** What an upgrade and a go back need the install record to name: its port (the busy check, the stop) and its install folder. */
function recordNamesAll(c) {
  if (!c.port) throw notDone(NO_PORT, { why: 'record' });
  if (!fullPath(c.app)) throw notDone(NO_APP, { why: 'record' });
}
/** The backups an upgrade made (data\backups\upgrade-…\backup.json), each {name, build, stopAt, saved}; a folder not whole is passed over. */
function listBackups(c) {
  const P = pathOf(c.root);
  const dir = P.join(c.root, 'data', BACKUPS);
  let names;
  try { names = c.fsImpl.readdirSync(dir); } catch { return []; /* none made */ }
  const out = [];
  for (const name of names.filter((x) => BACKUP_NAME.test(x))) {
    if (!realDir(c.fsImpl, P.join(dir, name)).ok) continue;
    let meta;
    try { meta = JSON.parse(c.fsImpl.readFileSync(P.join(dir, name, 'backup.json'), 'utf8')); } catch { continue; /* not whole */ }
    if (meta && meta.v === 1 && typeof meta.build === 'string') out.push({ name, build: said(meta.build, 80), stopAt: Number(meta.stopAt), saved: meta.saved === true });
  }
  return out;
}
/**
 * back: Go back to build N, for the laptop's admin and an account given `upgrade` (or an administrator): the build the
 * record names as Previous, the one `to` names (so a request made before another upgrade or go back is refused), its
 * installer kept in {app}\installers\ (laid there by an elevated or a checked install, under Program Files, so it needs no
 * network and no check), and the backup the upgrade from it made; refused while AGMessage is busy until the person types
 * a reason. The run is a runner's: AGMessage stopped at loopback (it saves), that backup laid back, the kept installer run
 * with /ROLLBACK, which lays the earlier build down and verifies that it answers (U.6.1). Each refusal is a
 * `machine.upgrade.refused` event; the run's outcome is its runner's one event, once it is seen.
 */
async function controlBack(c, req) {
  const facts = upgradeFacts(c);
  const asked = 'take AGMessage back to build ' + buildOfVersion(req.to);
  let unlock = null;
  try {
    recordNamesAll(c);
    unlock = upgradeLock(c);
    const busyRun = runnerUnderWay(c);
    if (busyRun) throw refusal(busyRun, { why: 'running' });
    const previous = INSTALL_VERSION.test(String(c.record.Previous || '')) ? c.record.Previous : '';
    if (!previous) throw refusal('This PC has no build before ' + installedWords(facts.installed) + ' to go back to: the install record names none (a first install, or a go back made already).', { why: 'previous' });
    if (req.to !== previous) throw refusal('The build before this one is build ' + buildOfVersion(previous) + ' now, not build ' + buildOfVersion(req.to) + ': run Go back to build ' + buildOfVersion(previous) + ' from the Start menu.', { why: 'previous' });
    const A = pathOf(c.app);
    const kept = A.join(c.app, 'installers', 'AGMessage-Setup-' + previous + '-unsigned.exe');
    let st = null;
    try { st = c.fsImpl.lstatSync(kept); } catch { st = null; /* not kept: refused below */ }
    if (!st || st.isSymbolicLink() || !st.isFile()) throw refusal('Build ' + buildOfVersion(previous) + '\'s installer is not kept in ' + A.join(c.app, 'installers') + ', so this PC cannot go back by itself: an administrator runs that build\'s installer with /ROLLBACK.', { why: 'kept' });
    const backup = backupFor(listBackups(c), previous);
    if (!backup) throw refusal('No backup of this PC\'s data from build ' + buildOfVersion(previous) + ' is kept (an upgrade keeps two, and one gone on without a backup made none): going back would leave build ' + buildOfVersion(previous) + ' the data a newer build wrote, so nothing was changed. An administrator can run its installer with /ROLLBACK.', { why: 'backup' });
    await busyCheck(c, req.force, { done: 'taken back', verb: 'take it back' });
    const plan = {
      v: 1, id: crypto.randomBytes(8).toString('hex'), request: req.id, kind: 'back', at: Date.now(), for: c.sid, by: c.me, elevated: c.elevated,
      root: c.root, app: c.app, port: c.port, from: facts.installed, to: previous,
      installer: kept, staged: '', backup: backup.name, backupAt: backup.stopAt, force: req.force || '',
    };
    const r = startRunner(c, plan);
    return {
      pending: true, backup: backup.name, runner: r.task || r.pid,
      words: handedWords('Going back from ' + installedWords(facts.installed) + ' to build ' + buildOfVersion(previous) + ': AGMessage stops (it saves), its data is laid back from the backup made when the newer build was installed (' + clock(backup.stopAt) + ' on ' + dayOf(backup.stopAt) + '; what was written since is not kept, though its audit log is), and build ' + buildOfVersion(previous) + '\'s kept installer lays it down and starts it.'),
    };
  } catch (e) {
    const ev = await upgradeRefusedEvent(c, asked, (e && e.words) || said(e && e.message, 200));
    throw Object.assign(e, { event: ev.seq });
  } finally {
    if (unlock) unlock();
  }
}

/** Whether two paths name one place (pure): letter case aside on Windows paths. */
const samePath = (a, b) => (pathOf(String(a)) === path.win32 ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
/** A day by the machine's own clock, as clock() gives its time (pure but for the time zone): 2026-11-07. */
const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
/**
 * A runner's plan read by type (pure): the fields the control task wrote, each of its shape, and what it runs where its
 * control task put it, so a plan names no other program: an upgrade's installer the file of its release's name in one
 * folder of the plan's own machine\staged\, which is all it removes; a go back's the kept installer of its build in
 * {app}\installers\, with nothing staged. Else null.
 */
function planOf(text) {
  let p;
  try { p = JSON.parse(String(text)); } catch { return null; }
  if (!p || typeof p !== 'object' || p.v !== 1 || !/^[0-9a-f]{16}$/.test(String(p.id)) || !['upgrade', 'back'].includes(p.kind)) return null;
  if (!personSid(p.for) || !p.by || !isSid(p.by.sid) || typeof p.by.name !== 'string' || typeof p.elevated !== 'boolean') return null;
  if (!fullPath(p.root) || !fullPath(p.app) || !fullPath(p.installer) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return null;
  if (typeof p.force !== 'string' || !Number.isFinite(p.at) || typeof p.request !== 'string' || !p.from || typeof p.from !== 'object') return null;
  const R = pathOf(p.root);
  if (p.kind === 'upgrade') {
    if (!(SEMVER.test(String(p.to)) && /^[0-9a-f]{64}$/.test(String(p.digest)) && fullPath(p.staged) && typeof p.repo === 'string')) return null;
    if (!samePath(R.dirname(p.staged), R.join(p.root, 'machine', 'staged')) || !STAGED_DIR.test(R.basename(p.staged))) return null;
    if (!samePath(R.dirname(p.installer), p.staged) || R.basename(p.installer) !== installerName(p.to)) return null;
  } else {
    if (!(INSTALL_VERSION.test(String(p.to)) && BACKUP_NAME.test(String(p.backup)) && p.staged === '' && Number.isFinite(p.backupAt))) return null;
    if (!samePath(p.installer, pathOf(p.app).join(p.app, 'installers', 'AGMessage-Setup-' + p.to + '-unsigned.exe'))) return null;
  }
  return p;
}
/** Whether `file` lies inside `dir` (pure), letter case aside on Windows paths. */
function inside(file, dir) {
  const P = pathOf(dir);
  const rel = P.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel);
}
/** The programs of {app} but the server's own, waited for until there are none, at most `waitMs`: those still running. */
async function consolesGone({ app, sys, run, waitMs, pollMs }) {
  const until = Date.now() + waitMs;
  for (;;) {
    const others = programsIn({ '--app': app, '--sys': sys }, run).filter((p) => !serverProgram(p));
    if (!others.length || Date.now() >= until) return others;
    await sleep(pollMs);
  }
}
/**
 * An installer run and waited for however long it runs: its own process, hidden, from `cwd`, on its own (so a runner
 * that ends does not end it with its job), and never killed, since Inno's rollback does not run on a kill. {code}, or -1
 * with `error` when it could not run.
 */
function runInstaller(installer, args, { cwd } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = childProcess.spawn(installer, args, { cwd, windowsHide: true, detached: true, stdio: 'ignore' }); } catch (e) { finish({ code: -1, error: said(e.code || e.message, 60) }); return; }
    child.once('error', (e) => finish({ code: -1, error: said(e.code || e.message, 60) }));
    child.once('exit', (code, signal) => finish(Number.isInteger(code) ? { code } : { code: -1, error: said(signal || 'no exit code', 60) }));
  });
}
/**
 * Until the control task's own answer to the plan's request is in the account's outbox (it writes it once its runner is
 * handed the plan), at most `waitMs` from the plan's making, so the runner's last answer is never written under it.
 */
async function answeredFirst(fsImpl, outbox, plan, waitMs, pollMs = POLL_MS) {
  const file = pathOf(outbox).join(outbox, 'answer.json');
  const until = plan.at + waitMs;
  for (;;) {
    let a;
    try { a = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { a = null; /* not there yet, or being replaced */ }
    if (a && a.id === plan.request) return true;
    if (Date.now() >= until) return false;
    await sleep(pollMs);
  }
}
/** What answers on `port` now, by the machine's hello (the proof of the token): in words, for a run's last answer. */
async function answerWords(c, port) {
  const token = tokenFrom(c.root, c.fsImpl);
  if (!token) return { up: false, words: 'whether AGMessage answers is not known (its token could not be read)' };
  const h = await (c.n.hello || hello)({ port, token });
  if (h.ok) return { up: true, words: 'AGMessage ' + said(h.build, 80) + ' answers on port ' + port };
  if (h.why === 'ECONNREFUSED') return { up: false, stopped: true, words: 'nothing answers on port ' + port + ', so AGMessage is stopped' };
  return { up: false, words: 'AGMessage did not answer on port ' + port + ' as this PC\'s (' + said(h.words || h.why, 80) + ')' };
}

/**
 * upgrade --step run --plan <machine\work\upgrade-<id>\plan.json> --sys <{sys}>: the checked upgrade's run, or Go back's,
 * from the copy of node.exe and machine.js its control task left beside the plan, never from {app}, as SYSTEM (its own
 * task) or the elevated administrator whose console asked. It waits until nothing but AGMessage's own server runs from
 * {app} (the console that asked closes once its person has read the answer), at most RUNNER_WAIT_MS. Then, for an upgrade:
 * the staged copy's SHA-256 read again and the staged installer run with /UPGRADEBY (and /FORCE with the reason typed),
 * which follows U.6.1's order from its version check, the way back included. For Go back: the kept installer's SHA-256
 * read, AGMessage stopped at loopback (reason back; it saves), the upgrade's backup laid back (restore), and the kept
 * installer of the build before run with /ROLLBACK. The installer's log is written in the runner's own folder. Its end,
 * once the outcome is seen (the exit code, what the install record names and what answers on the port): one event, the
 * account's last answer (final), ended.json beside the plan, the staged copy removed.
 */
async function upgradeRun(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  if (opts['--step'] !== 'run') throw usage('machine.js upgrade takes --step run --plan <file>: the runner that Upgrade AGMessage… and Go back to build N start through their control task.');
  const planFile = String(opts['--plan'] || '');
  if (!fullPath(planFile)) throw usage('upgrade needs --plan <file>, a runner\'s plan as a full path.');
  const P = pathOf(planFile);
  const dir = P.dirname(planFile);
  const work = P.dirname(dir);
  const root = P.dirname(P.dirname(work));
  if (P.basename(planFile) !== 'plan.json' || !RUNNER_DIR.test(P.basename(dir)) || P.basename(work) !== 'work' || P.basename(P.dirname(work)) !== 'machine') throw usage('--plan is "' + said(planFile, 120) + '", which is not a runner\'s plan (machine\\work\\upgrade-<id>\\plan.json).');
  const H = hands(opts['--sys'], run);
  let plan = null;
  try { plan = planOf(fsImpl.readFileSync(planFile, 'utf8')); } catch { plan = null; /* refused below */ }
  if (!plan || plan.root !== root || P.basename(dir) !== 'upgrade-' + plan.id) throw refusal('The runner\'s plan (' + planFile + ') is not one its control task wrote: nothing was run.');
  const me = accountOf(H.whoami(['/user', '/fo', 'csv', '/nh']).out);
  const ranBy = me && (me.sid === SID.system || (plan.elevated && me.sid === plan.by.sid && elevatedOf(H.whoami(['/groups', '/fo', 'csv', '/nh']).out)));
  if (!ranBy) throw refusal('machine.js upgrade runs as SYSTEM, from the copy its control task left beside its plan: nothing was run.');
  const self = n.self || { node: process.execPath, script: __filename };
  if (inside(self.node, plan.app) || inside(self.script, plan.app)) throw refusal('machine.js upgrade runs from the copy its control task left in machine\\work\\, never from ' + plan.app + ', whose files the installer replaces: nothing was run.');
  const c = { root, sys: opts['--sys'], H, run, fsImpl, n, machineDir: P.join(root, 'machine'), me: plan.by, port: plan.port, sid: plan.for, elevated: plan.elevated };
  const toBuild = plan.kind === 'back' ? 'build ' + buildOfVersion(plan.to) : plan.to;
  const asked = plan.kind === 'back' ? 'take AGMessage back to ' + toBuild : 'upgrade AGMessage to ' + toBuild;
  const who = plan.by.name || plan.by.sid;
  const outbox = P.join(root, 'machine', 'outbox', plan.for);
  // The run's end, once its outcome is seen: its one event (machine.upgrade for an outcome done, `done` its words;
  // machine.upgrade.refused otherwise, with what stopped it), the account's last answer, written after its control task's
  // own so that one never lands over it, ended.json beside the plan, and the staged copy removed.
  const end = async (a, done = '') => {
    const ok = a.code === DONE;
    const ev = eventFor(c, ok
      ? { kind: 'machine.upgrade', by: plan.by, forAccount: plan.by, rights: ['upgrade'], words: done }
      : { kind: 'machine.upgrade.refused', by: plan.by, forAccount: plan.by, rights: ['upgrade'], words: who + ' asked to ' + asked + (a.code === REFUSED ? ', and was refused: ' : '; it did not happen: ') + a.words });
    await nudgeServer(c);
    const rec = { v: 1, id: plan.request, verb: plan.kind, final: true, at: Date.now(), ranAs: me.sid, for: plan.for, ...a, words: a.words + ev.why, event: ev.seq };
    if (!plan.elevated) {
      await answeredFirst(fsImpl, outbox, plan, n.pendingWaitMs === undefined ? PENDING_WAIT_MS : n.pendingWaitMs);
      try { writeAnswer(fsImpl, outbox, rec); } catch { /* its outbox is gone: the account no longer holds a right */ }
    }
    try { fsImpl.writeFileSync(P.join(dir, 'ended.json'), JSON.stringify({ at: Date.now(), code: a.code })); } catch { /* the next upgrade reads it as a runner that died, and says so once */ }
    if (plan.staged) removeStaged(fsImpl, plan.staged);
    return rec;
  };
  const refused = async (words, extra = {}) => refusal(words, await end({ code: REFUSED, words, ...extra }));
  try {
    return await runPlan({ plan, c, run, opts, dir, end, refused });
  } catch (e) {
    // Whatever stopped it, the run's end is written: its event, its answer, ended.json, the staged copy removed.
    if (e && e.final === true) throw e;
    const words = (e && e.words) || said(e && e.message, 200);
    throw (e && e.refused ? refusal : notDone)(words, await end({ code: e && e.refused ? REFUSED : NOT_DONE, words }));
  }
}
/** The runner's steps, once its plan, its account and its own copy are taken (upgradeRun). */
async function runPlan({ plan, c, run, opts, dir, end, refused }) {
  const P = pathOf(dir);
  const { fsImpl, n } = c;
  // The console that asked, and any other of {app}'s, closed: their node.exe holds a file the installer replaces.
  let left;
  try { left = await consolesGone({ app: plan.app, sys: opts['--sys'], run, waitMs: n.consoleWaitMs || RUNNER_WAIT_MS, pollMs: n.pollMs || RUNNER_POLL_MS }); } catch (e) { throw await refused(e.words || said(e.message, 200)); }
  if (left.length) throw await refused(programWords(left) + ' still runs from ' + plan.app + ' after ' + Math.round((n.consoleWaitMs || RUNNER_WAIT_MS) / 60_000) + ' minutes (a console of the Start menu left open), so AGMessage\'s files could not be replaced: nothing was changed. Close it, then ask again.');
  // The installer's log in the runner's own folder (SYSTEM and Administrators only), never one another account can place.
  const log = P.join(dir, plan.kind + '.log');
  if (plan.kind === 'upgrade') {
    if (sha256File(fsImpl, plan.installer) !== plan.digest) throw await refused(NOT_THE_RELEASES);
    return finishRun({ plan, c, end, log, digest: plan.digest, args: installerArgs({ sid: plan.elevated ? '' : plan.for, force: plan.force, log }) });
  }
  // Go back: the kept installer read before anything changes, then the stop that saves, the backup laid back, the installer.
  let digest;
  try { digest = sha256File(fsImpl, plan.installer); } catch (e) { throw await refused('Build ' + buildOfVersion(plan.to) + '\'s kept installer could not be read (' + (e.code || e.message) + '): nothing was changed.'); }
  const token = tokenFrom(plan.root, fsImpl);
  if (!token) throw await refused('AGMessage\'s token (token\\admin-token) could not be read, so it cannot be stopped at loopback: nothing was changed.');
  try { await stopAndWait({ port: plan.port, token, reason: 'back', by: said(plan.by.name || plan.by.sid, 80), force: plan.force, n }); } catch (e) { throw await refused(e.words || said(e.message, 200), e.busy ? { busy: true, forceable: true } : {}); }
  const until = Date.now() + (n.programsWaitMs || PROGRAMS_WAIT_MS);
  let still = programsIn({ '--app': plan.app, '--sys': opts['--sys'] }, run);
  while (still.length && Date.now() < until) { await sleep(POLL_MS); still = programsIn({ '--app': plan.app, '--sys': opts['--sys'] }, run); }
  const toNo = buildOfVersion(plan.to);
  if (still.length) {
    const words = 'AGMessage stopped for the go back, but ' + programWords(still) + ' still runs from ' + plan.app + ', so nothing was laid back: close it, then Go back to build ' + toNo + ' again (Start AGMessage starts it meanwhile).';
    throw notDone(words, await end({ code: NOT_DONE, words }));
  }
  try { await restore({ '--machine': plan.root, '--backup': plan.backup, '--port': String(plan.port) }, { fsImpl, net: n }); } catch (e) {
    const words = 'AGMessage stopped for the go back, but its data could not be laid back: ' + ((e && e.words) || said(e && e.message, 200)) + ' AGMessage stays stopped: an administrator lays the backup back (machine.js restore) before it starts again.';
    throw notDone(words, await end({ code: NOT_DONE, words }));
  }
  const before = 'after AGMessage was stopped for the go back and its data laid back as build ' + toNo + ' left it on ' + dayOf(plan.backupAt) + ' at ' + clock(plan.backupAt) + ' (what was written since is not kept)';
  return finishRun({ plan, c, end, log, digest, before, args: installerArgs({ sid: plan.elevated ? '' : plan.for, force: plan.force, log, rollback: true }) });
}
/**
 * The installer run and waited for, and its outcome as it is seen: its exit code, what the install record names after it,
 * and, when it did not reach its build, what answers on the port. Done is an exit of 0 with the record naming the build
 * asked for: `machine.upgrade` then names who, the builds from and to as the records name them, and the installer's
 * SHA-256. Anything else is said from what was seen (`before`, what the runner had done first), never from the exit code
 * alone, with the log's last lines.
 */
async function finishRun({ plan, c, end, log, digest, args, before = '' }) {
  const r = await (c.n.runInstaller || runInstaller)(plan.installer, args, { cwd: pathOf(plan.installer).dirname(plan.installer) });
  const now = installedOf(readRecord(c.H).values);
  const reached = plan.kind === 'back' ? now.version === plan.to : now.semver === plan.to;
  const bare = (i) => installedWords(i).replace(/^AGMessage /, '');
  const who = plan.by.name || plan.by.sid;
  const as = plan.elevated ? 'as an administrator' : 'as SYSTEM';
  const toNo = buildOfVersion(plan.to);
  if (r.code === 0 && reached) {
    const done = plan.kind === 'back'
      ? who + ' took AGMessage back from ' + bare(plan.from) + ' to ' + bare(now) + ' ' + as + ', build ' + toNo + '\'s kept installer sha256:' + digest + ', its data laid back as of ' + dayOf(plan.backupAt) + ' ' + clock(plan.backupAt) + '.'
      : who + ' upgraded AGMessage from ' + bare(plan.from) + ' to ' + bare(now) + ' ' + as + ', its installer sha256:' + digest + ' (' + plan.repo + '\'s release v' + plan.to + ').';
    return end({ code: DONE, words: (plan.kind === 'back' ? 'Gone back: ' : 'Upgraded: ') + installedWords(now) + ' is installed on this PC, and it answers.', installerExit: 0, installed: now }, done);
  }
  const port = await answerWords(c, plan.port);
  const what = plan.kind === 'back' ? 'Build ' + toNo + '\'s installer' : 'The installer of ' + plan.to;
  const same = now.version && now.version === plan.from.version;
  const record = 'The install record ' + (same && plan.kind === 'back' ? 'still names ' : 'names ') + installedWords(now) + (same && plan.kind === 'upgrade' ? ', the build before' : '');
  const next = !port.stopped ? '' : plan.kind === 'back'
    ? ' Start AGMessage starts ' + installedWords(now) + ' on the data laid back' + (now.version === plan.to ? '' : ', or Go back to build ' + toNo + ' again') + '.'
    : ' Start AGMessage starts it again.';
  const words = what + ' ended with ' + r.code + (r.error ? ' (' + r.error + ')' : '') + ': ' + exitWords(r.code) + (before ? ', ' + before : '') + '. ' + record + '; ' + port.words + '.' + next;
  const rec = await end({ code: NOT_DONE, words, installerExit: r.code, installed: now, answers: port.up, log, logTail: tailOf(c.fsImpl, log, 8).lines.map((l) => said(l, 200)) });
  throw notDone(words, rec);
}

// ---------------------------------------------------------------- import: a portable folder, before the first start

/**
 * The import's three steps, in their order (the folder made ready, the bundle taken and verified, the end said), and the
 * clear that ends an import left before its end.
 */
const IMPORT_STEPS = Object.freeze(['stage', 'take', 'finish', 'clear']);
/** The bounds on what an account's export leaves: its manifest, its answers, the files a bundle carries. */
const IMPORT_MANIFEST_MAX = 128 * 1024 * 1024;
const IMPORT_ANSWER_MAX = 64 * 1024;
const IMPORT_FILES_MAX = 500000;
/** The room the copy leaves beside it on the machine folder's disk (the server's own floor, AGM_UPLOAD_MIN_FREE). */
const IMPORT_RESERVE = 1024 ** 3;
const IMPORT_CHUNK = 1024 * 1024;
/** How long the facts of the installed node's folders may take to read (its rooms loaded, its audit chain walked). */
const IMPORT_FACTS_MS = 600_000;
/** The import's folder in an account's inbox, where its export leaves the bundle (launch.js importDirOf). */
const importDir = (root, sid) => pathOf(root).join(root, 'machine', 'inbox', sid, 'import');
/** The import's verdict in an account's outbox, which it reads (launch.js verdictOf): only this command writes it. */
const importVerdict = (root, sid) => pathOf(root).join(root, 'machine', 'outbox', sid, 'import.json');
/** A part of the bundle by its place in the manifest (launch.js partOf). */
const importPart = (i) => String(i).padStart(7, '0') + '.part';
/** A path inside a carried folder (launch.js relOk, held to it by test/import.test.js; pure). */
const IMPORT_REL_MAX = 240;
const IMPORT_REL_NAME = /^[^\\/:*?"<>|\p{Cc}]{1,200}$/u;
function importRelOk(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > IMPORT_REL_MAX) return false;
  return rel.split('/').every((n) => IMPORT_REL_NAME.test(n) && n !== '.' && n !== '..');
}
/** What an export carries, by its place and path (launch.js carried, held to it by test/import.test.js; pure). */
const IMPORT_DATA_LEFT = new Set(['backups', 'logs', 'watchdog.json', 'watchdog.seen.json', 'watchdog.log', 'moved.json']);
function importCarries(area, rel) {
  const parts = String(rel).split('/');
  if (/\.tmp$/i.test(parts[parts.length - 1]) || parts.some((p) => p.startsWith('.partial-'))) return false;
  if (area === 'data') return !IMPORT_DATA_LEFT.has(parts[0]);
  if (area === 'keys') return parts.length === 1 ? parts[0] === 'machine.key' || parts[0] === 'tls.json' : parts[0] === 'audit' || parts[0] === 'stores';
  return area === 'uploads';
}
const HEX64 = /^[0-9a-f]{64}$/;
const IMPORT_ID = /^[0-9a-f]{24}$/;
/** The states of the keyed stores at the installed node's first start in which its accounts open, and its sign-ins are kept. */
const IMPORT_OPEN = Object.freeze(['ok', 'move', 'behind', 'unrecorded', 'none']);
const IMPORT_KEPT = Object.freeze(['ok', 'move', 'behind', 'unrecorded', 'none']);
/** A folder's halls, messages, accounts and screens in words (pure): "1 hall, 2 messages, 1 account and 1 screen". */
const countsWords = (f) => [plural(f.halls, 'hall'), plural(f.messages, 'message'), plural(f.accounts, 'account')].join(', ') + ' and ' + plural(f.screens, 'screen');

/**
 * A manifest an account's export wrote, read by type (pure): {manifest} or {problem}. Whole JSON; v 1; its id; the SID
 * it names; the folder it is of; the build; the source's facts (an object, compared field by field); and its files, each
 * {area, rel, size, sha256}, in the three places, of a path an export carries, at most IMPORT_FILES_MAX, none twice. What
 * it names is never trusted past that: each part is read by its place, never by a name it gives, and no account is named
 * by it (the machine names the account: its SID's).
 */
function manifestOf(bytes) {
  let j;
  try { j = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { return { problem: 'the bundle\'s manifest is not whole JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.v !== 1) return { problem: 'the bundle\'s manifest is not one an export of this build writes' };
  if (typeof j.id !== 'string' || !IMPORT_ID.test(j.id) || !isSid(j.sid) || typeof j.source !== 'string' || !fullPath(j.source) || typeof j.build !== 'string') return { problem: 'the bundle\'s manifest does not name its import, its account, its folder and its build' };
  if (!j.facts || typeof j.facts !== 'object' || Array.isArray(j.facts)) return { problem: 'the bundle\'s manifest holds no facts of its folder' };
  if (!Array.isArray(j.files) || j.files.length > IMPORT_FILES_MAX) return { problem: 'the bundle\'s manifest holds no list of files of an import\'s size' };
  const seen = new Set();
  for (const f of j.files) {
    const ok = f && typeof f === 'object' && ['data', 'uploads', 'keys'].includes(f.area) && importRelOk(f.rel) && importCarries(f.area, f.rel)
      && Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.sha256 === 'string' && HEX64.test(f.sha256);
    if (!ok) return { problem: 'the bundle\'s manifest names a file an import does not carry' };
    const key = f.area + '/' + f.rel.toLowerCase();
    if (seen.has(key)) return { problem: 'the bundle\'s manifest names one file twice (' + said(f.area + '/' + f.rel, 120) + ')' };
    seen.add(key);
  }
  return { manifest: { id: j.id, sid: j.sid, source: j.source, build: said(j.build, 80), facts: j.facts, files: j.files.map((f) => ({ area: f.area, rel: f.rel, size: f.size, sha256: f.sha256 })) } };
}

/**
 * A file the account left in its import folder, read only when lstat shows a file of its own (no link, no hard link, at
 * most `max`) and the handle opened is that file: its bytes, or null when there is none to read; a refusal otherwise.
 */
function readLeft(fsImpl, file, max) {
  let st;
  try { st = fsImpl.lstatSync(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw refusal(file + ' could not be read (' + (e.code || e.message) + ').'); }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1n) throw refusal(file + ' is not a file the export wrote (a link, or not a file): the import never reads through one.');
  if (st.size > BigInt(max)) throw refusal(file + ' is over ' + MB(max) + ', more than an export writes.');
  const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const ft = fsImpl.fstatSync(fd, { bigint: true });
    if (!ft.isFile() || !sameFile(ft, st)) throw refusal(file + ' changed between its look and its read: it was not read.');
    const buf = Buffer.alloc(Number(st.size));
    let n = 0;
    while (n < buf.length) { const got = fsImpl.readSync(fd, buf, n, buf.length - n, n); if (!got) break; n += got; }
    return buf.subarray(0, n);
  } finally { fsImpl.closeSync(fd); }
}
/** An answer the account's step left ({v: 1, id, code, words, …}), read by type: the object, or null for none or one that is not. */
function answerLeft(fsImpl, file) {
  const buf = readLeft(fsImpl, file, IMPORT_ANSWER_MAX);
  if (!buf) return null;
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return null; }
  return j && typeof j === 'object' && !Array.isArray(j) && j.v === 1 && typeof j.words === 'string' && Number.isSafeInteger(j.code) ? j : null;
}

/**
 * What the installed node's folders hold of a node that has served (U.6.1): its halls (a room's files), its accounts, its
 * audit rows, and the keys an import would lay over its own (the machine key, the certificate, the server secret): each
 * named, none when it never started. A file that could not be read is named too, fail closed.
 */
function servedOf(root, fsImpl = fs) {
  const P = pathOf(root);
  const out = [];
  const names = (d) => { try { return fsImpl.readdirSync(d); } catch (e) { if (e.code === 'ENOENT') return []; out.push(d + ' (' + (e.code || e.message) + ')'); return []; } };
  const halls = names(P.join(root, 'data', 'rooms')).filter((n) => /\.json(?:\.bak)?$/.test(n));
  if (halls.length) out.push(plural(halls.length, 'hall or room file'));
  for (const name of ['accounts.json', 'accounts.json.bak']) {
    let users = 0;
    try { const j = JSON.parse(fsImpl.readFileSync(P.join(root, 'data', name), 'utf8')); users = j && Array.isArray(j.users) ? j.users.length : 0; } catch (e) {
      if (e.code && e.code !== 'ENOENT') out.push(P.join(root, 'data', name) + ' (' + e.code + ')');
    }
    if (users) { out.push(plural(users, 'account')); break; }
  }
  const audit = names(P.join(root, 'data')).filter((n) => (n === 'audit.jsonl' || (n.startsWith('audit-') && n.endsWith('.jsonl'))) || n === 'audit-archive');
  const rows = audit.some((n) => { try { return n === 'audit-archive' || fsImpl.statSync(P.join(root, 'data', n)).size > 0; } catch { return true; /* there, unread: it may hold rows */ } });
  if (rows) out.push('an audit log');
  for (const [area, name] of [['keys', 'machine.key'], ['keys', 'tls.json'], ['data', 'secret.key']]) {
    try { fsImpl.lstatSync(P.join(root, area, name)); out.push('its own ' + name); } catch (e) { if (e.code !== 'ENOENT') out.push(P.join(root, area, name) + ' (' + (e.code || e.message) + ')'); }
  }
  return out;
}
const servedWords = (served) => 'This PC\'s AGMessage has served already: it holds ' + served.join(', ') + '. An import goes only into an AGMessage that has never started, since two machine keys, server secrets, certificates and audit chains cannot be merged: nothing is ever merged. The portable folder\'s events stay in that folder; or uninstall AGMessage with its data removed, install it again, and import before its first start.';

/**
 * The checks the verify makes, the portable folder's facts (`s`, read by its export) against the installed node's (`t`,
 * read after the copy), each by lib/importfacts.js (pure): the halls, side rooms, messages, accounts and screens counted
 * alike; the machine key the same; every sealed value opening here, as many as there; the certificate's fingerprint
 * unchanged; the audit chain checking to its end, as it read there, archives included. Then what the installed node's own
 * start refuses, read from the copy itself and never from what the export said of its source: a folder not last run by
 * this build in the format it writes (`format`), a machine key, certificate or server secret it would not start on
 * (`usable`), a copy running on its data folder (`held`), an import's mark there (`moved`), and its keyed stores as its
 * first start would open them (`stores`: no account held aside, no account's sign-in ended). [{check, words}] for each
 * that did not pass; none when every one did.
 */
function verifyChecks(s, t) {
  const out = [];
  const num = (o, k) => (o && Number.isSafeInteger(o[k]) ? o[k] : -1);
  const counts = ['halls', 'rooms', 'messages', 'accounts', 'screens'].filter((k) => num(s, k) < 0 || num(s, k) !== num(t, k));
  if (counts.length) out.push({ check: 'counts', words: 'the counts differ: ' + counts.map((k) => num(t, k) + ' ' + k + ' here, ' + num(s, k) + ' in the portable folder').join('; ') });
  const key = (o) => (o && o.key && typeof o.key === 'object' ? o.key : {});
  if (key(s).state !== key(t).state || key(s).kid !== key(t).kid) out.push({ check: 'key', words: 'the machine key here is not the one the portable folder\'s values were sealed with' });
  const sealed = (o) => (o && o.sealed && typeof o.sealed === 'object' ? o.sealed : { total: -1, open: -1, shut: [] });
  const st = sealed(t);
  if (st.total !== sealed(s).total || st.open !== st.total) {
    const shut = Array.isArray(st.shut) ? st.shut.map((x) => said(x, 60)).join(', ') : '';
    out.push({ check: 'sealed', words: st.total === sealed(s).total ? (st.total - st.open) + ' of ' + st.total + ' sealed values do not open here' + (shut ? ' (' + shut + ')' : '') : st.total + ' sealed values here, ' + sealed(s).total + ' in the portable folder' });
  }
  const fp = (o) => (o && o.cert && typeof o.cert.fp === 'string' ? o.cert.fp : null);
  if (fp(s) === null || fp(s) !== fp(t)) out.push({ check: 'fingerprint', words: 'the certificate\'s fingerprint is not the portable folder\'s (' + (fp(t) || 'none here') + ', not ' + (fp(s) || 'none') + ')' });
  const chain = (o) => (o && o.chain && typeof o.chain === 'object' ? o.chain : {});
  const cs = chain(s);
  const ct = chain(t);
  if (ct.done !== true || ct.mark === 'broken' || ct.mark !== cs.mark || ct.entries !== cs.entries || ct.archives !== cs.archives) {
    out.push({ check: 'chain', words: 'the audit chain does not check here as it did in the portable folder (' + said(ct.words || 'not read', 200) + ')' });
  }
  const fm = (o) => (o && o.format && typeof o.format === 'object' ? o.format : {});
  const ft = fm(t);
  const build = t && typeof t.build === 'string' && t.build ? t.build : '';
  if (!build || ft.state !== 'read' || ft.build !== build || !Number.isSafeInteger(ft.current) || ft.format !== ft.current || !s || s.build !== build || fm(s).build !== build) {
    const sb = s && typeof s.build === 'string' && s.build ? 'AGMessage ' + said(s.build, 80) : 'a build its facts do not name';
    const why = ft.state === 'none' ? 'it holds no format marker' : ft.state !== 'read' ? 'its format marker could not be read'
      : ft.build !== build ? 'its format marker names ' + (ft.build ? 'AGMessage ' + said(ft.build, 80) : 'no build')
        : ft.format !== ft.current ? 'its format marker names this build in format ' + said(String(ft.format), 20) + ', which it does not write'
          : s && s.build === build ? 'the export read a format marker naming ' + (fm(s).build ? 'AGMessage ' + said(fm(s).build, 80) : 'no build') : 'the export was made by ' + sb;
    out.push({ check: 'format', words: 'the copy was not last run by this build (' + why + '; this is ' + (build || 'a build its facts do not name') + ')' });
  }
  const unusable = [];
  const kt = key(t);
  if (kt.state !== 'key' && kt.state !== 'absent') unusable.push('the machine key (' + said(kt.code || kt.state || 'not read', 40) + ')');
  const cst = t && t.cert && typeof t.cert === 'object' ? t.cert : {};
  if (!['ok', 'renew', 'absent'].includes(cst.state)) unusable.push('the certificate (' + said(cst.code || cst.state || 'not read', 40) + ')');
  if (!t || (t.secret !== 'read' && t.secret !== 'absent')) unusable.push('the server secret');
  if (unusable.length) out.push({ check: 'usable', words: 'the installed AGMessage would not start on ' + unusable.join(', ') + ' laid here' });
  if (!t || t.held !== false) out.push({ check: 'held', words: 'a copy of AGMessage runs on this PC\'s AGMessage data folder' + (t && typeof t.busy === 'string' && t.busy ? ' (it says it is ' + said(t.busy, 200) + ')' : '') + ': stop it, then import again' });
  if (!t || t.moved !== 'none') out.push({ check: 'moved', words: 'this PC\'s AGMessage data folder holds an import\'s mark (data\\moved.json), on which it does not start' });
  // The keyed stores as the installed node's first start would find them (lib/keyedstore.js): a move of the set this
  // laptop saved last, so no account is held aside and no account's sign-in ends.
  const stOf = (o) => (o && o.stores && typeof o.stores === 'object' ? o.stores : {});
  const ks = stOf(t);
  const held = !IMPORT_OPEN.includes(ks.accounts);
  const ended = !IMPORT_KEPT.includes(ks.sessions);
  if (held || ended) {
    const there = !IMPORT_OPEN.includes(stOf(s).accounts) ? ': its accounts are held aside in the portable folder too; open them there first (Admin → Accounts held aside), then import again' : ': the keyed stores\' records did not come with the keys';
    out.push({ check: 'stores', words: (held ? 'the accounts would be held aside at its first start (' + said(String(ks.accounts || 'not read'), 20) + ')' : '') + (held && ended ? ', and ' : '') + (ended ? 'the accounts\' sign-ins would end (' + said(String(ks.sessions || 'not read'), 20) + ')' : '') + there });
  }
  return out;
}

/**
 * The installed node's facts, read after the copy by lib/importfacts.js of the install (`--app`), run by this node.exe as a
 * process of its own, in an environment made from the System32 folder alone (`runFile`, childProcess.execFileSync unless
 * a test stands in for it): {facts} or {error}.
 */
function targetFacts({ root, app, sys, runFile = childProcess.execFileSync }) {
  const P = pathOf(root);
  const A = pathOf(app);
  const winRoot = DRIVE_PATH.test(String(sys || '')) ? path.win32.dirname(sys) : '';
  const env = winRoot ? { SystemRoot: winRoot, windir: winRoot, SystemDrive: winRoot.slice(0, 2), TEMP: path.win32.join(winRoot, 'Temp'), TMP: path.win32.join(winRoot, 'Temp') } : {};
  let out;
  try {
    out = String(runFile(process.execPath, [A.join(app, 'app', 'lib', 'importfacts.js'), '--data', P.join(root, 'data'), '--keys', P.join(root, 'keys')],
      { cwd: A.join(app, 'app'), env, encoding: 'utf8', windowsHide: true, timeout: IMPORT_FACTS_MS, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '');
  } catch (e) { out = String((e && e.stdout) || ''); if (!out.trim()) return { error: said((e && (e.code || e.message)) || 'no answer', 160) }; }
  let j;
  try { j = JSON.parse(out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || ''); } catch { return { error: 'its answer is not whole' }; }
  return j && j.facts && typeof j.facts === 'object' ? { facts: j.facts } : { error: said((j && j.error) || 'no facts in its answer', 200) };
}

/** The folders `parts` below `base` made where they are not there, each a real directory, those made kept in `made`. */
function importFolders(fsImpl, P, base, parts, made) {
  let at = base;
  for (const part of parts) {
    at = P.join(at, part);
    try { fsImpl.mkdirSync(at); made.push(at); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const real = realDir(fsImpl, at);
    if (!real.ok) throw Object.assign(new Error(at + ' ' + real.why), { code: 'ENOTDIR' });
  }
}
/**
 * One part of the bundle copied into its place: read only when lstat shows a file of its own (no link, no hard link) of
 * the size the manifest names, through the handle of that file; written into a new file, never over one, so it takes the
 * access list of the folder it lands in and never its own. Its bytes' SHA-256.
 */
function copyPart(fsImpl, part, to, size) {
  // The part is named by its own name in the words, never by its path under the account's inbox, so a long profile path
  // cannot push the reason past the words' bound.
  const name = String(part).split(/[\\/]/).pop();
  const st = fsImpl.lstatSync(part, { bigint: true });
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1n) throw Object.assign(new Error(name + ' is not a part the export wrote (a link, or not a file)'), { code: 'ELINK' });
  if (st.size !== BigInt(size)) throw Object.assign(new Error(name + ' is ' + st.size + ' bytes, not the ' + size + ' its manifest names'), { code: 'ESIZE' });
  const hash = crypto.createHash('sha256');
  const src = fsImpl.openSync(part, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let dst = null;
  try {
    const ft = fsImpl.fstatSync(src, { bigint: true });
    if (!ft.isFile() || !sameFile(ft, st)) throw Object.assign(new Error(name + ' changed between its look and its read'), { code: 'ECHANGED' });
    dst = fsImpl.openSync(to, 'wx');
    const buf = Buffer.alloc(IMPORT_CHUNK);
    for (;;) {
      const n = fsImpl.readSync(src, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      for (let off = 0; off < n;) off += fsImpl.writeSync(dst, buf, off, n - off);
    }
    fsImpl.fsyncSync(dst);
  } finally {
    fsImpl.closeSync(src);
    if (dst !== null) fsImpl.closeSync(dst);
  }
  return hash.digest('hex');
}
/** What the copy made taken out again, newest first: the files, then the folders. What was left, as words. */
function importUndo(fsImpl, made) {
  const left = [];
  for (const f of [...made.files].reverse()) { try { fsImpl.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') left.push(f); } }
  for (const d of [...made.dirs].reverse()) { try { fsImpl.rmdirSync(d); } catch (e) { if (e.code !== 'ENOENT') left.push(d); } }
  return left;
}

/** Whether two full paths name one place, as their platform compares them (pure): a Windows path without its case. */
function samePlace(a, b) {
  if (!fullPath(a) || !fullPath(b) || pathOf(a) !== pathOf(b)) return false;
  const P = pathOf(a);
  const norm = (p) => { const r = P.resolve(p).replace(/[\\/]+$/, ''); return P === path.win32 ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

/**
 * What an import left for an account removed (the bundle holds that account's machine key, certificate, audit records and
 * server secret, so none of it stays once an import ends, passed or not): its import\ folder, never recursively and never
 * through a link (one that lstat shows a link or junction is removed itself, never what it names: clearBox), and with
 * `verdict` its verdict in the outbox. What was left, in words; '' when nothing is.
 */
function clearImport(fsImpl, root, sid, { verdict = false } = {}) {
  const dir = importDir(root, sid);
  const left = [];
  let st = null;
  try { st = fsImpl.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') left.push(dir + ' (' + (e.code || e.message) + ')'); }
  if (st && st.isDirectory()) {
    const l = clearBox(fsImpl, dir);
    if (l) left.push(l);
  } else if (st) {
    try { fsImpl.unlinkSync(dir); } catch (e) {
      if (!st.isSymbolicLink()) left.push(dir + ' (' + (e.code || e.message) + ')');
      else { try { fsImpl.rmdirSync(dir); } catch (e2) { left.push(dir + ' (' + (e2.code || e2.message) + ')'); } }
    }
  }
  if (verdict) { try { fsImpl.unlinkSync(importVerdict(root, sid)); } catch (e) { if (e.code !== 'ENOENT') left.push(importVerdict(root, sid) + ' (' + (e.code || e.message) + ')'); } }
  return left.join('; ');
}

/** The SID an import is for (--for): one person's, as the installer's whose reading found the laptop's admin. */
function importFor(opts) {
  const sid = String(opts['--for'] || '');
  if (!personSid(sid)) throw usage('import needs --for <SID>, one person\'s account: the one that started the installer and runs its export.');
  return sid;
}

/**
 * import --step stage: the import made ready for the account that started the installer, before the installed node's first
 * start. Refused for a node that has served (U.6.1: never merge). The account's inbox\ and outbox\ (made again with their
 * grants), and in its inbox a fresh import\ folder (anything an earlier try left cleared, never recursively), where it may
 * add and write files and never make a folder or a junction; an earlier verdict removed, so none stands for this import.
 */
function importStage(opts, { run = childProcess.execFileSync, fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const sid = importFor(opts);
  const H = hands(opts['--sys'], run);
  const served = servedOf(root, fsImpl);
  if (served.length) throw refusal(servedWords(served), { served });
  accountFolder(H, fsImpl, root, 'inbox', sid, inboxGrants(sid));
  accountFolder(H, fsImpl, root, 'outbox', sid, outboxGrants(sid));
  const dir = importDir(root, sid);
  const label = 'machine\\inbox\\' + sid + '\\import';
  const left = clearImport(fsImpl, root, sid);
  if (left) throw notDone('What an earlier import left could not be cleared (' + left + '): nothing was imported.');
  makeFolder(fsImpl, dir, label, { fresh: false });
  const [first, ...more] = inboxGrants(sid);
  mustGrant(H, [dir, '/inheritance:r', '/grant:r', ...BASE_GRANTS, first], label);
  for (const g of more) mustGrant(H, [dir, '/grant', g], label);
  try { fsImpl.unlinkSync(importVerdict(root, sid)); } catch (e) { if (e.code !== 'ENOENT') throw notDone('An earlier import\'s verdict could not be removed (' + (e.code || e.message) + '): nothing was imported.'); }
  return { words: 'The import is ready: the portable folder\'s bundle goes into ' + dir + '.' };
}

/**
 * import --step take: the bundle the account's export left (launch.js export) copied into the installed node's data,
 * uploads and key folders, then verified. Refused, with nothing copied: a node that has served; an export that left no
 * answer or refused; a manifest that is not one, is of another account or import, or of another folder than --source; a
 * disk short of the room. Each part is copied by its bytes into a new file, never over one, never with an access list of
 * its own, never through a link, and its SHA-256 checked against the manifest; then the installed node's facts are read
 * (lib/importfacts.js of the install) and checked against the portable folder's (verifyChecks). Anything that does not pass
 * is said by its check, and everything the copy made is taken out again. Passed, the verdict goes into the account's
 * outbox (import.json), which its forget-keys reads before it removes anything. {verified, id, checks}.
 */
function importTake(opts, stand = {}) {
  const root = needPath(opts, '--machine');
  const sid = importFor(opts);
  try { return takeBundle(opts, root, sid, stand); } catch (e) {
    // A take that did not pass leaves nothing of the bundle where the account's export put it: the parts not laid (the
    // keys among them), its manifest and its answer. The verdict of an earlier take that passed is finish's or clear's.
    const left = clearImport(stand.fsImpl || fs, root, sid);
    if (left && e && typeof e.words === 'string') e.words += ' What the export left could not all be removed (' + left + '): remove it yourself, since it holds the portable folder\'s keys.';
    throw e;
  }
}
/** The take itself (importTake's): refusals and failures thrown, the bundle cleared by importTake. */
function takeBundle(opts, root, sid, { fsImpl = fs, runFile } = {}) {
  const app = needPath(opts, '--app');
  const source = needPath(opts, '--source');
  const P = pathOf(root);
  if (!fsImpl.existsSync(pathOf(app).join(app, 'app', 'lib', 'importfacts.js'))) throw usage('--app is ' + app + ', which holds no app\\lib\\importfacts.js: it is the install\'s folder ({app}).');
  const served = servedOf(root, fsImpl);
  if (served.length) throw refusal(servedWords(served), { served });
  const dir = importDir(root, sid);
  const real = realDir(fsImpl, dir);
  if (!real.ok) throw refusal('The import\'s folder ' + dir + ' ' + real.why + ': the import was not made ready (import --step stage). Nothing was imported.');
  const said0 = answerLeft(fsImpl, P.join(dir, 'export.json'));
  if (!said0) throw refusal('The portable folder\'s export left no answer, so there is no bundle to take. Nothing was imported.');
  if (said0.code !== DONE) throw refusal(said(said0.words, 1200), { exported: false });
  const bundle = readLeft(fsImpl, P.join(dir, 'manifest.json'), IMPORT_MANIFEST_MAX);
  if (!bundle) throw refusal('The export left no bundle\'s manifest in ' + dir + ': nothing was imported.');
  const got = manifestOf(bundle);
  if (got.problem) throw refusal(got.problem + ': nothing was imported.');
  const m = got.manifest;
  if (m.sid !== sid || m.id !== said0.id) throw refusal('The bundle is not this import\'s (another account\'s, or another export\'s): nothing was imported.');
  if (!samePlace(m.source, source)) throw refusal('The bundle is of ' + said(m.source, 200) + ', not of ' + source + ': nothing was imported.');
  const bytes = m.files.reduce((n, f) => n + f.size, 0);
  let free;
  try { const s = fsImpl.statfsSync(P.join(root, 'data')); free = s.bavail * s.bsize; } catch { free = null; /* not read: a full disk is said by the copy */ }
  if (free !== null && free < bytes + IMPORT_RESERVE) throw refusal('The disk has ' + MB(free) + ' free; the import lays ' + MB(bytes) + ' and AGMessage keeps ' + MB(IMPORT_RESERVE) + ' beside it: free some space, then import again. Nothing was imported.');
  const made = { files: [], dirs: [] };
  const undone = (words, extra = {}) => {
    const left = importUndo(fsImpl, made);
    return notDone(words + (left.length ? ' What it copied could not all be taken out again: ' + left.slice(0, 3).join(', ') + (left.length > 3 ? ' and ' + (left.length - 3) + ' more' : '') + '.' : ' What it copied was taken out again.') + ' Nothing was removed from the portable folder or your profile.', extra);
  };
  for (const [i, f] of m.files.entries()) {
    const parts = f.rel.split('/');
    const to = P.join(root, f.area, ...parts);
    let sha;
    try {
      importFolders(fsImpl, P, P.join(root, f.area), parts.slice(0, -1), made.dirs);
      sha = copyPart(fsImpl, P.join(dir, importPart(i)), to, f.size);
      made.files.push(to);
    } catch (e) {
      if (e && e.code === 'EEXIST') throw undone('The import did not lay ' + f.area + '\\' + f.rel.split('/').join('\\') + ': there is a file of that name here already, and an import never lays a file over one.');
      throw undone('The import did not lay ' + f.area + '\\' + f.rel.split('/').join('\\') + ' (' + said((e && e.message) || (e && e.code) || 'EIO', 200) + ').');
    }
    if (sha !== f.sha256) throw undone('The import did not pass its verify: ' + f.area + '\\' + f.rel.split('/').join('\\') + ' did not arrive whole (its bytes are not the ones the export read).', { checks: [{ check: 'file', words: f.area + '/' + f.rel }] });
    try { fsImpl.unlinkSync(P.join(dir, importPart(i))); } catch { /* the bundle's own part, removed with the import folder at the end */ }
  }
  const t = targetFacts({ root, app, sys: opts['--sys'], runFile });
  const checks = t.error ? [{ check: 'facts', words: 'the copy\'s facts could not be read (' + t.error + ')' }] : verifyChecks(m.facts, t.facts);
  if (checks.length) throw undone('The import did not pass its verify: ' + checks.map((c) => c.words).join('; ') + '.', { checks });
  const f = t.facts;
  const verdict = { v: 1, id: m.id, verified: true, at: Date.now(), source, build: m.build, files: m.files.length, bytes, halls: f.halls, rooms: f.rooms, messages: f.messages, accounts: f.accounts, screens: f.screens, sealed: f.sealed.total, entries: f.chain.entries, fp: f.cert.fp };
  writeAnswer(fsImpl, P.join(root, 'machine', 'outbox', sid), verdict, 'import.json');
  return {
    verified: true, id: m.id, checks: [],
    words: 'Imported and verified: ' + countsWords(f) + ', counted alike; every sealed value opens (' + f.sealed.total + '); the certificate\'s fingerprint is unchanged; the audit chain checks (' + (f.chain.entries === 1 ? '1 entry' : f.chain.entries + ' entries') + (f.chain.archives ? ', ' + plural(f.chain.archives, 'archive') : '') + ').',
  };
}

/**
 * import --step finish: the import's end, once the account's forget-keys has run. Its verdict read (this command's, in the
 * account's outbox), and what forget-keys answered (its words the person's, its flags read by type; none is said too);
 * `machine.import` appended to the machine's events, naming the account by its SID and the name the machine gives it (the
 * install record's for the laptop's admin, else Windows' own: never a name the account's bundle or answers carry), what
 * was imported and verified, and whether the old copies went and the folder is marked (never a path in a profile), which
 * the server writes as its audit row; the import folder cleared and the verdict removed. Its words are the import page's
 * last: a copy that was not removed, or a mark that was not made, is not done (2), named there with its path.
 */
function importFinish(opts, { fsImpl = fs, run = childProcess.execFileSync } = {}) {
  const root = needPath(opts, '--machine');
  const sid = importFor(opts);
  const id = String(opts['--id'] || '');
  if (!IMPORT_ID.test(id)) throw usage('import --step finish needs --id <the import\'s id>, as its take answered it.');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  let verdict;
  try { verdict = JSON.parse(fsImpl.readFileSync(importVerdict(root, sid), 'utf8')); } catch { verdict = null; /* none: refused below */ }
  if (!verdict || verdict.verified !== true || verdict.id !== id) throw refusal('No verified import of this id is here to finish: nothing was recorded.');
  const dir = importDir(root, sid);
  let gone;
  try { gone = answerLeft(fsImpl, P.join(dir, 'forget.json')); } catch { gone = null; /* not one forget-keys wrote: said as no answer */ }
  if (gone && (gone.id !== id || gone.verified !== true)) gone = null;
  const flag = (x) => !!(x && typeof x === 'object' && x.ok === true);
  const removed = gone ? { keys: flag(gone.keys), secret: flag(gone.secret), moved: gone.moved === true } : null;
  const record = readRecord(H);
  const name = record.values.Admin === sid && record.values.AdminName ? said(record.values.AdminName, 120) : (namesFor({ H }, [sid])[sid] || '');
  const who = { sid, name };
  const what = (who.name || sid) + ' imported a portable AGMessage folder (build ' + said(verdict.build, 80) + '): ' + countsWords(verdict) + ', verified';
  const after = !removed ? '; its old copies of the keys were not confirmed removed, nor the folder marked as moved'
    : (removed.keys && removed.secret ? '; its old copies of the keys were removed' : '; not every old copy of its keys was removed') + (removed.moved ? ' and the folder is marked as moved' : ', and the folder is not marked as moved');
  let ev;
  try { ev = { seq: appendEvent(P.join(root, 'machine'), { kind: 'machine.import', by: who, forAccount: who, words: what + after + '.' }, fsImpl), why: '' }; } catch (e) {
    ev = { seq: 0, why: ' No machine event says so, so the audit log will not show the import: ' + ((e && e.words) || said(e && e.message, 200)) + '.' };
  }
  const left = clearImport(fsImpl, root, sid, { verdict: true });
  const said1 = gone ? said(gone.words, 1200) : 'Its old copies of the keys were not confirmed removed, nor the folder marked as moved (forget-keys gave no answer): remove %LOCALAPPDATA%\\AGMessage and the folder\'s app\\data\\secret.key yourself, and never start that folder again, since it would serve these halls beside this PC\'s AGMessage.';
  const words = 'Imported: ' + countsWords(verdict) + ', verified. ' + said1 + (left ? ' What the import left could not all be cleared (' + left + '): remove it yourself, since it may hold the portable folder\'s keys.' : '') + ev.why;
  // Imported either way; a copy of the keys not removed, or a folder not marked, is not done, so its path stays on the
  // import page's last words.
  if (!(removed && removed.keys && removed.secret && removed.moved)) throw notDone(words, { imported: true, event: ev.seq });
  return { imported: true, event: ev.seq, words };
}

/**
 * import --step clear: an import left before its end (Start with no halls after one did not pass, or Setup closed)
 * cleared: the import folder and the verdict, so no copy of the portable folder's keys stays in the account's inbox. Any
 * node, served or not: it removes what only an import put there.
 */
function importClear(opts, { fsImpl = fs } = {}) {
  const root = needPath(opts, '--machine');
  const sid = importFor(opts);
  const left = clearImport(fsImpl, root, sid, { verdict: true });
  if (left) throw notDone('What the import left could not all be removed (' + left + '): remove it yourself, since it may hold the portable folder\'s keys.');
  return { words: 'Nothing of an import is left in ' + importDir(root, sid) + '.' };
}

/** import: one of its steps (--step), each the plan's (U14) and each its own refusals. */
function importStep(opts, stand) {
  const step = String(opts['--step'] || '');
  if (step === 'stage') return importStage(opts, stand);
  if (step === 'take') return importTake(opts, stand);
  if (step === 'finish') return importFinish(opts, stand);
  if (step === 'clear') return importClear(opts, stand);
  throw usage('import needs --step stage, take or finish (its three steps, in that order), or clear (an import left before its end).');
}

// ---------------------------------------------------------------- restore (the way back)

/**
 * restore: one backup laid back over the data and uploads folders for the way back, before the earlier build starts
 * again, while nothing answers on the port. File by file: one the backup holds whose live file is the same file (a hard
 * link nothing replaced) is kept; any other is laid back (a link where the backup linked it, a copy where it copied it),
 * and a file the backup does not hold is removed; backups\, logs\ and temporary files are left, and the audit log and
 * watchdog.log are never rolled back (they carry what the newer build did). {restored, unchanged, removed}.
 */
async function restore(opts, { fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const port = needPort(opts);
  const asked = String(opts['--backup'] || '');
  if (!asked) throw usage('restore needs --backup <backups\\upgrade-…>, the backup to lay back.');
  const P = pathOf(root);
  const dataDir = P.join(root, 'data');
  const uploadDir = P.join(root, 'uploads');
  const parts = asked.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  const dir = P.join(dataDir, BACKUPS, name);
  // backups\upgrade-…, as the stop's record names it; its name alone; or its full path.
  const whole = fullPath(asked) ? asked : parts.length === 1 ? dir : P.join(dataDir, ...parts);
  if (!BACKUP_NAME.test(name) || whole.toLowerCase() !== dir.toLowerCase()) throw usage('--backup is "' + said(asked, 120) + '", which names no backup in ' + P.join(dataDir, BACKUPS) + ' (backups\\upgrade-<build>-<time>-<suffix>).');
  for (const d of [dataDir, P.join(dataDir, BACKUPS), dir]) {
    const real = realDir(fsImpl, d);
    if (!real.ok) throw refusal(d + ' ' + real.why + ': nothing was laid back.');
  }
  let meta;
  try { meta = JSON.parse(fsImpl.readFileSync(P.join(dir, 'backup.json'), 'utf8')); } catch { meta = null; /* not whole: refused below */ }
  if (!meta || meta.v !== 1) throw refusal('the backup ' + name + ' is not whole (no backup.json): nothing was laid back.');
  if (await (n.portAnswers || portAnswers)(port)) throw refusal('something answers on port ' + port + ': stop AGMessage before its backup is laid back. Nothing was laid back.');
  // The machine events the server has written are in the audit log, which is never rolled back: their place is kept.
  const liveSeq = machineSeqIn(fsImpl, P.join(dataDir, 'settings.json'));
  const areas = [['data', dataDir], ['uploads', uploadDir]];
  const held = new Set();
  let restored = 0, unchanged = 0, removed = 0;
  const same = (a, b) => { try { const x = fsImpl.lstatSync(a, { bigint: true }), y = fsImpl.lstatSync(b, { bigint: true }); return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino; } catch { return false; /* not there: laid back */ } };
  try {
    for (const [area, live] of areas) {
      const from = P.join(dir, area);
      for (const rel of filesIn(fsImpl, from)) {
        held.add(area + '/' + rel);
        if (area === 'data' && (kindOf(rel) === 'skip' || NEVER_ROLLED_BACK(rel))) continue;
        const src = P.join(from, ...rel.split('/'));
        const dst = P.join(live, ...rel.split('/'));
        if (same(src, dst)) { unchanged++; continue; }
        realFolders(fsImpl, P, live, rel.split('/').slice(0, -1));
        try { fsImpl.unlinkSync(dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const link = area === 'uploads' || kindOf(rel) === 'link';
        let linked = false;
        if (link) { try { fsImpl.linkSync(src, dst); linked = true; } catch { linked = false; /* another volume, or no links: copied */ } }
        if (!linked) fsImpl.copyFileSync(src, dst);
        restored++;
      }
    }
    for (const [area, live] of areas) {
      for (const rel of filesIn(fsImpl, live)) {
        if (held.has(area + '/' + rel)) continue;
        if (area === 'data' && (kindOf(rel) === 'skip' || NEVER_ROLLED_BACK(rel))) continue;
        fsImpl.unlinkSync(P.join(live, ...rel.split('/')));
        removed++;
      }
    }
  } catch (e) {
    throw notDone('the backup ' + name + ' was laid back only in part (' + (e.code || e.message) + ' after ' + plural(restored, 'file') + ' laid back and ' + removed + ' removed): lay it back again before AGMessage starts.');
  }
  let kept;
  try { kept = keepMachineSeq(fsImpl, P.join(dataDir, 'settings.json'), liveSeq); } catch (e) {
    throw notDone('the backup ' + name + ' is laid back, but its settings.json could not be given the machine events\' place the audit log has reached (' + (e.code || e.message) + '): lay it back again before AGMessage starts, or its first start writes those events to the audit log a second time.');
  }
  return {
    restored, unchanged, removed, machineSeq: kept,
    words: 'The backup ' + name + ' (build ' + said(meta.build || '?', 80) + ') is laid back: ' + plural(restored, 'file') + ' laid back, ' + unchanged + ' unchanged, ' + removed + ' the newer build made removed. The audit log and watchdog.log are kept as they are' + (kept ? ', and so is the place its machine events have reached (machine event ' + kept + ')' : '') + '. The earlier build\'s first start says AGMessage restarted in each hall.',
  };
}
/** The machine events' place the server keeps in settings.json (`machineSeq`, lib/machineevents.js), or 0 (pure but for the read). */
function machineSeqIn(fsImpl, file) {
  let j;
  try { j = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return 0; /* none, or none read */ }
  return j && typeof j === 'object' && Number.isSafeInteger(j.machineSeq) && j.machineSeq > 0 ? j.machineSeq : 0;
}
/**
 * The settings laid back given the machine events' place the live settings had reached (`seq`), when theirs is below it:
 * the audit log is never rolled back, so a place laid back from before would write every machine event since to it a
 * second time (the server reads past its place only the newest 500 rows of the log). Written beside it and renamed over
 * it, so a settings.json the backup links is never changed in place; settings that are not there are made holding the
 * place alone; settings that do not read as JSON are never written over (the server refuses them itself). The place kept,
 * or 0 when nothing was written.
 */
function keepMachineSeq(fsImpl, file, seq) {
  if (!seq) return 0;
  let j;
  try { j = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') return 0;
    j = {};
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 0;
  if (Number.isSafeInteger(j.machineSeq) && j.machineSeq >= seq) return 0;
  j.machineSeq = seq;
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fsImpl.writeFileSync(tmp, JSON.stringify(j, null, 2), { flag: 'wx', mode: 0o600 });
  try { fsImpl.renameSync(tmp, file); } catch (e) { try { fsImpl.unlinkSync(tmp); } catch { /* left beside it: no secret but the sealed values it already held */ } throw e; }
  return seq;
}

// ---------------------------------------------------------------- the runner

/** The record `--out` asks for: whole JSON, written to a file beside it and renamed over it. Never a token: none is in a result. */
function writeOut(file, rec) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec));
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* left beside it: it holds no secret */ } throw e; }
}

/** The fields of a verb's result `--out` carries, by name (never `calls`, never anything a stand-in added). */
const OUT_FIELDS = Object.freeze([
  'root', 'setup', 'taskSid', 'admin', 'version', 'previous', 'removed', 'left', 'ready', 'running', 'busy', 'line', 'saved', 'backup', 'at', 'forced', 'facts', 'restored', 'unchanged',
  'programs', 'agree', 'adminName', 'approverName', 'startedSid', 'screenSid', 'choiceCount', 'choice1Sid', 'choice1Name', 'choice2Sid', 'choice2Name',
  'answered', 'build', 'needsAccount', 'tail', 'made', 'username', 'forceable',
  'id', 'ranAs', 'for', 'started', 'already', 'audited', 'rights', 'event', 'ran', 'task',
  'served', 'exported', 'verified', 'checks', 'imported',
  'byName', 'look', 'release', 'newer', 'installed', 'pending', 'final', 'installerExit', 'answers', 'log', 'logTail', 'runner', 'why', 'machineSeq',
]);

/** Run one verb: {code, text, out}. */
async function run(argv, stand = {}) {
  const a = parse(argv);
  if (a.problem) return { code: USAGE, text: a.problem };
  let code = DONE;
  let r;
  let text;
  try {
    if (a.opts['--out'] !== undefined && !fullPath(a.opts['--out'])) throw usage('--out is "' + said(a.opts['--out'], 120) + '", which is not a full path.');
    if (a.verb === 'prepare') r = prepare(a.opts, stand);
    else if (a.verb === 'install') r = install(a.opts, stand);
    else if (a.verb === 'uninstall') r = await uninstall(a.opts, stand);
    else if (a.verb === 'preinstall-check') r = await preinstallCheck(a.opts, stand);
    else if (a.verb === 'upgrade-stop') r = await upgradeStop(a.opts, stand);
    else if (a.verb === 'status') r = status(a.opts, stand);
    else if (a.verb === 'whose') r = whose(a.opts, stand);
    else if (a.verb === 'start') r = await start(a.opts, stand);
    else if (a.verb === 'first-account') r = await firstAccount(a.opts, stand);
    else if (a.verb === 'control') r = await control(a.opts, stand);
    else if (a.verb === 'import') r = importStep(a.opts, stand);
    else if (a.verb === 'upgrade') r = await upgradeRun(a.opts, stand);
    else r = await restore(a.opts, stand);
    text = r.words || 'Done.';
  } catch (e) {
    code = e && e.usage ? USAGE : e && e.refused ? REFUSED : NOT_DONE;
    text = (e && e.words) || 'machine.js ' + a.verb + ' did not finish: ' + said(e && e.message, 200);
    // What a refusal or a step not done carried beside its words (OUT_FIELDS picks them by name).
    r = e && typeof e === 'object' ? e : null;
  }
  if (a.opts['--out'] && fullPath(a.opts['--out'])) {
    const rec = { v: 1, verb: a.verb, code, words: text };
    for (const k of OUT_FIELDS) if (r && r[k] !== undefined) rec[k] = r[k];
    try { writeOut(a.opts['--out'], rec); } catch (e) { return { code: code || NOT_DONE, text: text + '\nThe record could not be written to ' + a.opts['--out'] + ' (' + (e.code || e.message) + ').', out: r }; }
  }
  return { code, text, out: r };
}

async function main(argv, { out = (t) => process.stdout.write(t + '\n'), ...stand } = {}) {
  const r = await run(argv, stand);
  out(r.text);
  return r.code;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  main(argv).then((code) => {
    process.exitCode = code;
    // A person reading it in a console waits for Enter; the installer's runs (--out, in a hidden console) never wait.
    if (process.stdin.isTTY && !argv.includes('--out')) { process.stdout.write('\nPress Enter to close this window.\n'); process.stdin.once('data', () => process.stdin.pause()); }
  });
}

module.exports = {
  main, run, parse, prepare, install, uninstall, preinstallCheck, upgradeStop, status, restore, whose, start, firstAccount, control,
  controlTaskXml, controlTask, controlSddl, requestOf, takeRequest, clearBox, grantRightsOf, elevatedOf, appendEvent, lastSeqOf, RIGHTS, CONTROL_VERBS, REQUEST_MAX,
  personSid, accountOf, whoseOf, adminOf, serverProgram, programWords, outsideOwnChain, accountFile, startedFrom, proven, PS_WHOSE, PS_PROGRAMS, START_WAIT_MS, PROGRAMS_WAIT_MS,
  CHILDREN, MACHINE_SUBS, BASE_GRANTS, SETUP_GRANT, inboxGrants, outboxGrants, serverTaskXml, winArg, firewallRules, recordValues, ownerSidOf, grant,
  csvRows, taskStateOf, installOf, kindOf, NEVER_ROLLED_BACK, backupEstimate, readLastStop, fullPath,
  hello, ask, serverProof, askProof, sameProof, tokenOf, busyLineOf, busyIsBusy, BUSY_KEYS, hands, portAnswers, portCloses, healthOf, HELLO_SAYS, ASK_SAYS,
  PS_OWNER, PS_FIREWALL_ADD, PS_FIREWALL_REMOVE, PS_STATUS,
  SID, HKLM, TASK_FOLDER, SERVER_TASK, SERVER_TASK_SDDL, RULE_TCP, RULE_UDP, DISCOVERY_PORT, BACKUP_RESERVE, STOP_WAIT_MS,
  VERBS, LATER, VERB_OPTS, DONE, NOT_DONE, REFUSED, USAGE,
  importStep, importStage, importTake, importFinish, importClear, clearImport, sameFile, manifestOf, verifyChecks, servedOf, servedWords, importRelOk, importCarries, readLeft, answerLeft, targetFacts, samePlace,
  importDir, importVerdict, importPart, IMPORT_STEPS, IMPORT_FILES_MAX, IMPORT_REL_MAX,
  upgradeRun, keepMachineSeq, machineSeqIn, releaseJudged, githubWords, newerRefusal, installerArgs, exitWords, backupFor, fetchHttps, githubGet, downloadAsset, sha256File, stageInstaller,
  repoOf, installedOf, compareSemver, installerSemver, installerName, planOf, runInstaller, checkedUpgrader, inside,
  OFFLINE_WORDS, NOT_THE_RELEASES, INSTALLER_NAME, INSTALL_VERSION, REPO, GITHUB_API, GITHUB_HEADERS, RUNNER_DIR, RUNNER_START_MS, INSTALLER_MAX,
  runnerTaskXml, runnerTask, upgradeLock, answeredFirst, DOWNLOAD_MAX_MS, UPGRADE_LOCK_STALE_MS, PENDING_WAIT_MS,
};
