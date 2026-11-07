'use strict';
/**
 * The installed node's machine-level commands. Run elevated or as SYSTEM only, by the installer (`AGMessage.iss`) and the
 * control tasks and the checked upgrade once they are built. It requires Node's own modules only, runs nothing but by its
 * absolute path in the System32 folder it is given, with that folder as its working folder, and reads no machine path from
 * its environment: Inno passes `{sys}`, `{app}` and `{commonappdata}` as arguments.
 *
 *   prepare           --machine <%ProgramData%\AGMessage> --sys <{sys}>
 *                     The machine folder, made race-free before anything is installed: the root with SYSTEM and
 *                     Administrators in full control (by SID, inheritance cut, never /T), an existing one taken only when
 *                     the install record shows an earlier install (or a prepare of this root that no install finished),
 *                     lstat shows a real directory and its owner is SYSTEM or Administrators; the root listed; then its
 *                     children (data, uploads, keys, logs, token, machine\ with inbox\, outbox\, work\ and staged\), each a
 *                     real directory made or found, with its own grants; and setup\<128 random bits>\, named in --out.
 *   install           --machine … --app <{app}> --sys … --build <full build> --port <n> [--admin <SID> --admin-name <name>]
 *                     [--public] [--signed]
 *                     The server task `\AGMessage\Server`, its SID's grants on the folders it uses, the laptop's admin's
 *                     reads and its inbox\ and outbox\, the firewall rules, and the one install record
 *                     (`HKLM\SOFTWARE\AGMessage`); setup\ removed. The laptop's admin is recorded once, at the first install
 *                     (`--admin` then required); an upgrade keeps the record's, and only then is `machine.admin` appended to
 *                     the machine's events, which the server turns into its audit row.
 *   uninstall         --machine … --sys … [--port <n>] [--force <reason>] [--remove-data]
 *                     The server stopped at loopback (it saves), then every task in \AGMessage\, the firewall rules and the
 *                     record removed, before any file goes; the data kept unless --remove-data, then the keys last. Each
 *                     removal checked: what was left is named, and the exit is 2.
 *   preinstall-check  --machine … --port <n> [--sys …] [--force <reason>]
 *                     Fails closed: a port that answers and is not this PC's AGMessage proving its token is refused with
 *                     who holds it (a portable copy's words, or another program's pid); a busy server with no typed
 *                     reason, or one that does not answer within 5 s, is refused (exit 3).
 *   upgrade-stop      --machine … --port <n> [--by <who>] [--force <reason>]
 *                     Refused before it asks anything when the disk is short of the room the way back's backup takes. Then
 *                     the stop at loopback with the proof of the token, reason "upgrade": the server, the one writer,
 *                     saves, backs its data up and writes its record. upgrade-stop waits for the server to end, reads
 *                     that record (made after it asked), and refuses (exit 3) a stop that did not save or made no backup,
 *                     unless forced.
 *   status            --machine … --sys … [--port <n>]
 *                     The server task's state and last result, the tails of watchdog.log and server.log, the last
 *                     last-stop.json, the port's holder pid, whether a code-integrity event stopped node.exe, the laptop's
 *                     admin and the grants; each fact read, refused or absent.
 *   restore           --machine … --backup <backups\upgrade-…> --port <n>
 *                     The way back's restore of one backup over the data and uploads folders, file by file, while nothing
 *                     answers on the port: what the backup holds laid back, what it does not hold removed; the audit log and
 *                     watchdog.log, append-only evidence, are never rolled back.
 *
 *   import, control and upgrade are later units' (U14, U17, U18): until each lands its verb is refused as unknown.
 *
 * Every verb takes `--out <file>`: its result as JSON ({v, verb, code, words, …}), refusals too, never a token, written
 * whole. Exit codes: 0 done; 2 not done, with the words of why; 3 refused, fail closed (a precondition a person must
 * clear); 64 a verb or an argument it does not know, or one missing or malformed. In a console it waits for Enter before it
 * ends. Its one authority is the install record and the folder it holds; the audit log is the server's alone.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
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
const POLL_MS = 250;

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

/** One request to 127.0.0.1:`port`: {status, json} or {error} ('silent' when the whole answer had not come in time). */
function request({ port, method = 'GET', path: p, headers = {}, body = Buffer.alloc(0), timeoutMs = ANSWER_MS }) {
  return new Promise((resolve) => {
    let done = false;
    let deadline = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(deadline); resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { ...headers, 'content-length': body.length } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > ANSWER_MAX) { req.destroy(new Error('answer too large')); return; } chunks.push(c); });
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; /* not JSON: its status still says what it answered */ } finish({ status: res.statusCode, json }); });
      res.on('error', (e) => finish({ error: e.code || e.message }));
    });
    deadline = setTimeout(() => { finish({ error: 'silent' }); req.destroy(); }, timeoutMs);
    req.on('error', (e) => finish({ error: e.code || e.message }));
    req.end(body);
  });
}
function failWords(why, port, timeoutMs) {
  if (why === 'silent') return 'the program on port ' + port + ' did not answer within ' + timeoutMs / 1000 + ' s';
  if (why === 'ECONNREFUSED') return 'nothing answers on port ' + port;
  if (why === 'unproven') return 'the program on port ' + port + ' did not prove it holds this PC\'s AGMessage token';
  return 'port ' + port + ' could not be reached (' + said(why, 40) + ')';
}
/** The hello, checked: {ok, nonce, build} only when the server proves it holds `token`; else {ok: false, why, words}. */
async function hello({ port, token, timeoutMs = ANSWER_MS }) {
  const challenge = crypto.randomBytes(16).toString('hex');
  const r = await request({ port, path: '/api/machine/hello?c=' + challenge, timeoutMs });
  if (r.error) return { ok: false, why: r.error, words: failWords(r.error, port, timeoutMs) };
  const j = r.json;
  if (r.status !== 200 || !j || typeof j.nonce !== 'string' || !NONCE.test(j.nonce) || !sameProof(j.proof, serverProof(tokenOf(token), j.nonce, challenge))) {
    return { ok: false, why: 'unproven', words: failWords('unproven', port, timeoutMs) };
  }
  return { ok: true, nonce: j.nonce, build: typeof j.build === 'string' ? said(j.build, 80) : '' };
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
/** busy, through the machine's own wire half: {answered, running, busy, words}. */
async function busyAsk({ port, token }) {
  const r = await ask({ port, token, method: 'GET', path: '/api/machine/busy' });
  if (!r.ok && r.why === 'ECONNREFUSED') return { answered: false, running: false, busy: false, words: 'nothing is serving' };
  if (!r.ok) return { answered: false, running: true, busy: true, words: r.words + ': read as busy' };
  const line = r.status === 200 && r.json ? r.json.line : null;
  if (!busyLineOf(line)) return { answered: false, running: true, busy: true, words: 'AGMessage answered no busy line (' + r.status + '): read as busy' };
  return { answered: true, running: true, busy: busyIsBusy(line), words: typeof r.json.words === 'string' ? said(r.json.words, 200) : '' };
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
/** An account's own inbox\<sid>\ (it may create and write files) and outbox\<sid>\ (it may read), inherited inside each. */
const inboxGrant = (sid) => grant(sid, 'W');
const outboxGrant = (sid) => grant(sid, 'RX');

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
 * launch.js serve, both by their absolute paths, from launch.js's folder, with the folders and the port; its descriptor
 * SERVER_TASK_SDDL. No token or password is in it. `uri` names it (the lane registers it under its own name).
 */
function serverTaskXml({ node, launch, data, uploads, keys, logs, token, port, uri = SERVER_TASK }) {
  const args = [launch, 'serve', '--data', data, '--uploads', uploads, '--keys', keys, '--logs', logs, '--token', token, '--port', String(port)];
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

/** A machine event appended to machine\events.jsonl, which the server turns into its audit row: no secret in it. */
function machineEvent(machineDir, { kind, by = '', forSid = '', rights = '', words = '' }, fsImpl = fs) {
  const line = JSON.stringify({ at: Date.now(), kind, by: said(by, 80), for: said(forSid, 80), rights: said(rights, 120), words: said(words, 200) }) + '\n';
  fsImpl.appendFileSync(pathOf(machineDir).join(machineDir, 'events.jsonl'), line);
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

// ---------------------------------------------------------------- argument parsing

/** The verbs this unit builds; import (U14), control (U17) and upgrade (U18) are refused as unknown until they land. */
const VERBS = Object.freeze(['prepare', 'install', 'uninstall', 'preinstall-check', 'upgrade-stop', 'status', 'restore']);
const LATER = Object.freeze({ import: 'U14', control: 'U17', upgrade: 'U18' });
/** The flags (no value). */
const FLAGS = new Set(['--public', '--signed', '--remove-data']);
/** Each verb's options, each at most once: any other is refused, never ignored. */
const VERB_OPTS = Object.freeze({
  prepare: ['--machine', '--sys', '--out'],
  install: ['--machine', '--app', '--sys', '--build', '--port', '--admin', '--admin-name', '--public', '--signed', '--out'],
  uninstall: ['--machine', '--sys', '--port', '--force', '--remove-data', '--out'],
  'preinstall-check': ['--machine', '--sys', '--port', '--force', '--out'],
  'upgrade-stop': ['--machine', '--port', '--by', '--force', '--out'],
  status: ['--machine', '--sys', '--port', '--out'],
  restore: ['--machine', '--backup', '--port', '--out'],
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
 * Windows looks for in the current folder and on PATH first), each from that folder: schtasks, icacls, reg and
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
    powershell,
  };
}

// The scripts, one line each, single quotes only. Each imports the modules it uses by their manifests' paths under $PSHOME
// (Windows' own), answers one line of JSON with every character past ASCII written \uXXXX, and says why where Windows
// refuses. A value is read from the environment it is handed (AGM_…), never written into the script.
const PS_HEAD = String.raw`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
function AgmUse($m) { Import-Module ($PSHOME + '\Modules\' + $m + '\' + $m + '.psd1') };
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
 * existing one taken only when the record shows an earlier install or a prepare of this root no install finished
 * (`Prepared`), lstat shows a real directory and its owner (read by Get-Acl) is SYSTEM or Administrators. 2. At once, its
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
    const prepared = typeof record.values.Prepared === 'string' && record.values.Prepared.toLowerCase() === root.toLowerCase();
    if (!record.installed && !prepared) throw refusal(root + ' is there, and the install record shows no earlier AGMessage install: it is not AGMessage\'s to take. Remove it, then install again.');
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

/** The folder an account's own inbox\<sid>\ or outbox\<sid>\ is, made with SYSTEM, Administrators and its grant. */
function accountFolder(H, fsImpl, root, box, sid, accountGrant) {
  const P = pathOf(root);
  const dir = P.join(root, 'machine', box, sid);
  makeFolder(fsImpl, dir, 'machine\\' + box + '\\' + sid, { fresh: false });
  mustGrant(H, [dir, '/inheritance:r', '/grant:r', ...BASE_GRANTS, accountGrant], 'machine\\' + box + '\\' + sid);
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
  for (const f of [node, launch]) if (!fsImpl.existsSync(f)) throw usage('--app is ' + app + ', which holds no ' + f + ': it is the install\'s folder ({app}), the one that holds node\\node.exe and app\\launch.js.');
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
  const xml = serverTaskXml({ node, launch, data: folder('data'), uploads: folder('uploads'), keys: folder('keys'), logs: folder('logs'), token: folder('token'), port });
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
  // The laptop's admin's own inbox\ and outbox\.
  accountFolder(H, fsImpl, root, 'inbox', admin, inboxGrant(admin));
  accountFolder(H, fsImpl, root, 'outbox', admin, outboxGrant(admin));
  // The firewall rules, by program, protocol and port.
  const rules = firewallRules({ node, port, public: !!opts['--public'] });
  const fw = H.powershell(PS_FIREWALL_ADD, { AGM_RULE_TCP: RULE_TCP, AGM_RULE_UDP: RULE_UDP, AGM_NODE: node, AGM_PORT: String(port), AGM_UDP: String(DISCOVERY_PORT), AGM_PROFILES: rules[0].profiles.join(',') });
  if (fw.error || fw.ok !== true) throw notDone('the firewall rules could not be made (' + said(fw.error || 'no answer', 200) + ').');
  // The one install record, written last: by SID, no secret.
  const previous = record.values.Version && record.values.Version !== built.version ? record.values.Version : (record.values.Previous || '');
  for (const v of recordValues({ dir: app, version: built.version, semver: built.semver, previous, admin, adminName, port, public: !!opts['--public'], signed: !!opts['--signed'] })) writeValue(H, v);
  if (record.values.Prepared !== undefined) H.reg(['delete', HKLM, '/v', 'Prepared', '/f', '/reg:64']);
  if (!kept) machineEvent(folder('machine'), { kind: 'machine.admin', by: adminName || admin, forSid: admin, words: 'AGMessage installed; the laptop\'s admin is ' + (adminName || admin) }, fsImpl);
  // setup\ held the one-time readings of who started the installer; removed at the install's end.
  let setupLeft = '';
  try { fsImpl.rmSync(folder('setup'), { recursive: true, force: true }); } catch (e) { setupLeft = e.code || e.message; }
  const keptWords = kept && asked && asked !== admin ? ' The laptop\'s admin stays ' + (adminName || admin) + ' (an upgrade keeps it; a handover changes it).' : '';
  return {
    taskSid, admin, version: built.version, previous,
    words: 'AGMessage ' + built.semver + ' (install version ' + built.version + ') is installed: the server task, the firewall rules and the record are set.' + keptWords + (setupLeft ? ' The setup folder could not be removed (' + said(setupLeft, 40) + '); it holds nothing anyone may read.' : ''),
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
  if (r.status === 409) throw refusal(said((r.json && r.json.error) || 'Not stopped: AGMessage is busy. Type a reason to stop it anyway.', 300));
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
function agmTasks(H, record) {
  const names = new Set([SERVER_TASK]);
  for (const sid of [record.values.Admin, ...Object.keys(readGrants(H))]) if (isSid(sid)) names.add(TASK_FOLDER + 'Control-' + sid);
  const r = H.schtasks(['/Query', '/TN', TASK_FOLDER, '/FO', 'CSV', '/NH']);
  if (r.code === 0) for (const row of csvRows(r.out)) if (row[0] && row[0].toLowerCase().startsWith(TASK_FOLDER.toLowerCase())) names.add(row[0]);
  return [...names];
}

/**
 * uninstall: the server stopped at loopback first (it saves), then every task in \AGMessage\ ended and removed, the
 * rules and the record removed, before any file goes; with --remove-data the folders, the keys last (answer 43). Each
 * removal is checked; what was left is named in the words and makes the exit 2.
 */
async function uninstall(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const H = hands(opts['--sys'], run);
  const P = pathOf(root);
  const record = readRecord(H);
  const port = needPort(opts, { optional: true }) || Number(record.values.Port) || 0;
  const told = [];
  const left = [];
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
  for (const tn of agmTasks(H, record)) {
    if (H.schtasks(['/Query', '/TN', tn]).code !== 0) continue;   // not there
    H.schtasks(['/End', '/TN', tn]);
    const del = H.schtasks(['/Delete', '/TN', tn, '/F']);
    if (del.code !== 0 || H.schtasks(['/Query', '/TN', tn]).code === 0) left.push('the task ' + tn + ' (' + (del.err || 'schtasks.exe ended with ' + del.code) + ')');
  }
  // 3. The firewall rules.
  const fw = H.powershell(PS_FIREWALL_REMOVE, { AGM_RULE_TCP: RULE_TCP, AGM_RULE_UDP: RULE_UDP });
  if (fw.error) left.push('the firewall rules (' + said(fw.error, 160) + ')');
  // 4. The record.
  if (record.exists) {
    const del = H.reg(['delete', HKLM, '/f', '/reg:64']);
    if (del.code !== 0) left.push('the install record (' + (del.err || 'reg.exe ended with ' + del.code) + ')');
  }
  // 5. The data only when asked: everything but the keys, then the keys last.
  const removed = [];
  if (opts['--remove-data']) {
    for (const name of ['data', 'uploads', 'logs', 'token', 'machine', 'setup', 'keys']) {
      const dir = P.join(root, name);
      if (!fsImpl.existsSync(dir)) continue;
      try { fsImpl.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { left.push(dir + ' (' + (e.code || e.message) + ')'); continue; }
      if (fsImpl.existsSync(dir)) left.push(dir); else removed.push(name);
    }
    if (!left.length) { try { fsImpl.rmdirSync(root); } catch (e) { if (e.code !== 'ENOENT') left.push(root + ' (' + (e.code || e.message) + ')'); } }
  }
  const head = told.length ? told.join('; ') + '. ' : '';
  if (left.length) throw notDone(head + 'AGMessage is not wholly uninstalled; left: ' + left.join('; ') + '.', { removed, left });
  return { removed, words: head + (opts['--remove-data'] ? 'AGMessage is uninstalled, and its data removed from this PC.' : 'AGMessage is uninstalled; its data is kept in ' + root + '.') };
}

// ---------------------------------------------------------------- preinstall-check, upgrade-stop

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
async function preinstallCheck(opts, { run = childProcess.execFileSync, fsImpl = fs, net: n = {} } = {}) {
  const root = needPath(opts, '--machine');
  const port = needPort(opts);
  if (!(await (n.portAnswers || portAnswers)(port))) return { ready: true, words: 'Port ' + port + ' is free: nothing is serving on it.' };
  const pidWords = () => { const pid = (n.pid || holderPid)(opts, run, port); return pid ? ' (pid ' + pid + ')' : ''; };
  const token = tokenFrom(root, fsImpl);
  const h = token ? await (n.hello || hello)({ port, token }) : { ok: false, why: 'notoken' };
  if (h.ok) {
    const b = await (n.busy || busyAsk)({ port, token });
    if (!b.answered && b.running) throw refusal('AGMessage on port ' + port + pidWords() + ' did not answer how busy it is within ' + ANSWER_MS / 1000 + ' s (' + b.words + '): it cannot be stopped at loopback, so the install cannot go on.');
    if (b.busy && !opts['--force']) throw refusal('AGMessage is busy (' + (b.words || 'activity in the last 10 minutes') + '): type a reason to go on anyway, or wait.');
    return { ready: true, running: true, busy: b.busy, words: 'The installed AGMessage answered: ' + (b.words || 'ready') + '.' };
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
async function upgradeStop(opts, { fsImpl = fs, net: n = {} } = {}) {
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
    throw refusal('the disk has ' + MB(est.free) + ' free, under the ' + MB(est.copyBytes) + ' the way back\'s backup copies and the ' + MB(BACKUP_RESERVE) + ' kept beside them: free some space, or type a reason to upgrade without a way back. AGMessage was not stopped.');
  }
  const s = await stopAndWait({ port, token, reason: 'upgrade', by, force, n });
  if (s.state === 'none') {
    if (!force) throw refusal('AGMessage is not serving on port ' + port + ', so no stop saved it for the upgrade and no backup was made for the way back: start it, or type a reason to upgrade without one.');
    return { saved: false, backup: '', forced: true, words: 'AGMessage was not serving: upgrading without a way back, as asked (' + force + ').' };
  }
  const rec = readLastStop(dataDir, fsImpl);
  const fresh = rec && !rec.unreadable && Number.isFinite(rec.at) && rec.at >= s.at;
  const problem = !rec ? 'no save record' : rec.unreadable ? 'its save record could not be read (' + rec.unreadable + ')' : !fresh ? 'no save record of this stop (the record there is older)' : !rec.saved ? 'it did not save (' + (rec.unsaved || 'not all of it') + ')' : !rec.backup ? rec.unbacked || 'no backup was made for the way back' : '';
  if (problem && !force) throw refusal('AGMessage stopped for the upgrade at ' + clock(s.at) + ', and ' + problem + ': the upgrade is refused so no data is risked. Type a reason to upgrade anyway.');
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
  if (f.lastStop.read === 'read') lines.push('  the last stop: ' + (f.lastStop.saved ? 'saved' + (f.lastStop.at ? ' at ' + clock(f.lastStop.at) : '') : 'not saved' + (f.lastStop.unsaved ? ' (' + f.lastStop.unsaved + ')' : '')));
  else lines.push('  the last stop: ' + (f.lastStop.read === 'absent' ? 'no record (AGMessage is serving, or it did not stop cleanly)' : 'its record could not be read (' + f.lastStop.code + ')'));
  if (f.codeIntegrity.found) lines.push('  Windows\' code integrity stopped node.exe (event ' + f.codeIntegrity.id + ', ' + f.codeIntegrity.at + '): Smart App Control may be on');
  else if (f.codeIntegrity.found === null) lines.push('  code integrity: not read (' + f.codeIntegrity.error + ')');
  if (f.serverLog.lines.length) lines.push('  the log\'s last line: ' + f.serverLog.lines[f.serverLog.lines.length - 1].slice(0, 160));
  return lines.join('\n');
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
  return {
    restored, unchanged, removed,
    words: 'The backup ' + name + ' (build ' + said(meta.build || '?', 80) + ') is laid back: ' + plural(restored, 'file') + ' laid back, ' + unchanged + ' unchanged, ' + removed + ' the newer build made removed. The audit log and watchdog.log are kept as they are. The earlier build\'s first start says AGMessage restarted in each hall.',
  };
}

// ---------------------------------------------------------------- the runner

/** The record `--out` asks for: whole JSON, written to a file beside it and renamed over it. Never a token: none is in a result. */
function writeOut(file, rec) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec));
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* left beside it: it holds no secret */ } throw e; }
}

/** The fields of a verb's result `--out` carries, by name (never `calls`, never anything a stand-in added). */
const OUT_FIELDS = Object.freeze(['root', 'setup', 'taskSid', 'admin', 'version', 'previous', 'removed', 'left', 'ready', 'running', 'busy', 'saved', 'backup', 'at', 'forced', 'facts', 'restored', 'unchanged']);

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
    else r = await restore(a.opts, stand);
    text = r.words || 'Done.';
  } catch (e) {
    code = e && e.usage ? USAGE : e && e.refused ? REFUSED : NOT_DONE;
    text = (e && e.words) || 'machine.js ' + a.verb + ' did not finish: ' + said(e && e.message, 200);
    r = e && e.left ? { removed: e.removed, left: e.left } : null;
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    if (process.stdin.isTTY) { process.stdout.write('\nPress Enter to close this window.\n'); process.stdin.once('data', () => process.stdin.pause()); }
  });
}

module.exports = {
  main, run, parse, prepare, install, uninstall, preinstallCheck, upgradeStop, status, restore,
  CHILDREN, MACHINE_SUBS, BASE_GRANTS, SETUP_GRANT, inboxGrant, outboxGrant, serverTaskXml, winArg, firewallRules, recordValues, ownerSidOf, grant, machineEvent,
  csvRows, taskStateOf, installOf, kindOf, NEVER_ROLLED_BACK, backupEstimate, readLastStop, fullPath,
  hello, ask, serverProof, askProof, sameProof, tokenOf, busyLineOf, busyIsBusy, BUSY_KEYS, hands, portAnswers, portCloses, healthOf, HELLO_SAYS, ASK_SAYS,
  PS_OWNER, PS_FIREWALL_ADD, PS_FIREWALL_REMOVE, PS_STATUS,
  SID, HKLM, TASK_FOLDER, SERVER_TASK, SERVER_TASK_SDDL, RULE_TCP, RULE_UDP, DISCOVERY_PORT, BACKUP_RESERVE, STOP_WAIT_MS,
  VERBS, LATER, VERB_OPTS, DONE, NOT_DONE, REFUSED, USAGE,
};
