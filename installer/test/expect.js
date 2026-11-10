'use strict';
/**
 * The installer's life cycle's expectations (the 0.6.0 plan's Part 6, unit U16), pure: the words each step must say, how
 * what Windows answers is read (Inno Setup's log, the install record, an access list, the payload's sums, a snapshot of
 * a folder, the machine's events), and the plan's list of what the life cycle proves, each item with the test that
 * proves it. installer/test/lifecycle.test.js reads it on CI's elevated windows-2025 job; test/lifecycle.test.js holds it
 * on Linux to the installer's script, app/machine.js, app/launch.js and app/lib/startup.js, so the life cycle and the
 * code it runs say the same words, and to lifecycle.test.js, so every item has its test.
 *
 * Invariants: it requires Node's own modules, app/lib/version.js and tools/readings.js's reader of an access list; it
 * runs nothing and reads no file.
 */
const path = require('path');
const { parseBuild } = require(path.join(__dirname, '..', '..', 'app', 'lib', 'version.js'));
const { daclOf, SID_NAMES } = require(path.join(__dirname, '..', '..', 'tools', 'readings.js'));

/** How long the machine's requests at loopback wait for an answer (app/lib/machinewire.js ANSWER_MS), in the words. */
const ANSWER_S = 5;

/**
 * The standard account's probe's bounds (installer/test/as-account.js reads `runMs` and `answerMs` from its plan): each
 * request's schtasks.exe /Run within `runMs` and its answer within `answerMs`; its first line, written as the account's
 * node.exe starts, within `startMs` of its task's run; its task's own time limit, `limitMinutes`.
 */
const PROBE = Object.freeze({ runMs: 30_000, answerMs: 180_000, startMs: 120_000, limitMinutes: 10 });
/**
 * The first admin account the life cycle makes at loopback (its seed): its username and its display name, and the words
 * each passphrase of it starts with. The server refuses a password that holds the username or the name, spaces aside
 * (lib/accounts.js passwordProblem), so the words name neither: test/lifecycle.test.js holds them to that rule on Linux.
 */
const SEED_ACCOUNT = Object.freeze({ username: 'lifecycle', name: 'Life Cycle', passphrase: 'installer walk across the hall ' });
/** A passphrase for the seed account, its random part given (pure): the fixed words, then `random`. */
const seedPassphrase = (random) => SEED_ACCOUNT.passphrase + String(random);
/** The probe's longest run for `n` requests, from its first line to its last (pure). */
const probeWorstMs = (n) => n * (PROBE.runMs + PROBE.answerMs);
/**
 * Task Scheduler's results that are Windows refusing the account's logon itself, the one case the plan leaves to the
 * show laptop's lab 7 ("where the runner allows a second account's process"): HRESULT_FROM_WIN32 of a bad user name or
 * password (1326) and of a logon type not granted, "Log on as a batch job" (1380, 1385), and SCHED_E_ACCOUNT_INFORMATION_NOT_SET,
 * which a policy that forbids storing a password leaves. Any other result is the life cycle's to fail on.
 */
const LOGON_REFUSED = Object.freeze({
  [0x8007052E]: 'Windows refused the account\'s logon: the user name or password is incorrect',
  [0x80070564]: 'Windows refused the account\'s logon: it was not granted the logon type a task runs with',
  [0x80070569]: 'Windows refused the account\'s logon: it was not granted the logon type a task runs with at this computer (Log on as a batch job)',
  [0x8004130F]: 'Windows keeps no password for the task (SCHED_E_ACCOUNT_INFORMATION_NOT_SET): a policy forbids storing it',
});
/** schtasks.exe's words when it refuses to register a task for an account's logon (1326, 1380, 1385), as an English image says them. */
const LOGON_REFUSED_WORDS = /user name or password is incorrect|unknown user name or bad password|not been granted the requested logon type|requested a type of logon .{0,40}that has not been granted/i;
/** The refusals that are the batch logon not granted (1380, 1385), and schtasks' words for them. */
const BATCH_REFUSED = Object.freeze([0x80070564, 0x80070569]);
const BATCH_REFUSED_WORDS = /not been granted the requested logon type|requested a type of logon .{0,40}that has not been granted/i;
/** The one refusal that stays the runner's once the life cycle made the account and granted it a batch logon: a policy that keeps no password. */
const POLICY_REFUSED = Object.freeze([0x8004130F]);
/**
 * Whether what Windows said of the probe's task is its refusal of the account's logon (pure): the words of a registration
 * schtasks refused, or a result code (a task's last result, or the code Task Scheduler's own log gave; signed or not, as
 * schtasks prints it) of a task that wrote no line. '' when it is not. With `granted` (the life cycle made the account with
 * the password it gives schtasks, gave it "Log on as a batch job" and read it back), only a policy's refusal is the
 * runner's: a batch logon or a password refused then is the life cycle's own failure, and not lab 7's.
 */
function logonRefused({ words = '', lastResult = null, granted = false } = {}) {
  if (Number.isSafeInteger(lastResult)) {
    const code = lastResult >>> 0;
    if (Object.hasOwn(LOGON_REFUSED, code) && (!granted || POLICY_REFUSED.includes(code))) return LOGON_REFUSED[code] + ' (0x' + code.toString(16).toUpperCase() + ')';
  }
  if (granted) return '';
  const m = LOGON_REFUSED_WORDS.exec(String(words || ''));
  return m ? 'Windows refused to register the task for the account\'s logon ("' + m[0] + '")' : '';
}
/** A task's last result as Task Scheduler writes it, 0x and eight hex digits (pure): 'none' when there is none. */
const resultWords = (n) => (Number.isSafeInteger(n) ? '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0') : 'none');

/**
 * The life cycle's plan, as its CI step writes it (the file AGM_LIFECYCLE names), read (pure): {work, logs, portable,
 * previous, current, broken}, `portable` the zip's stage (the portable folder, extracted), each build {exe, payload} (its
 * installer and its SHA256SUMS.payload), every path a full Windows path from a drive; or a thrown Error with words.
 */
function planOf(text) {
  let j;
  try { j = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch { throw new Error('the life cycle\'s plan is not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('the life cycle\'s plan is not an object');
  const full = (v, what) => {
    if (typeof v !== 'string' || !/^[A-Za-z]:\\[^"*?<>|\0]*$/.test(v)) throw new Error('the plan\'s ' + what + ' is not a full Windows path from a drive');
    return v;
  };
  const build = (name) => {
    const b = j[name];
    if (!b || typeof b !== 'object') throw new Error('the plan names no ' + name + ' build');
    const exe = full(b.exe, name + '.exe');
    if (!/^AGMessage-Setup-[^\\]+-unsigned\.exe$/i.test(exe.split('\\').pop())) throw new Error('the plan\'s ' + name + '.exe is not an AGMessage installer (AGMessage-Setup-…-unsigned.exe)');
    return Object.freeze({ exe, payload: full(b.payload, name + '.payload') });
  };
  return Object.freeze({ work: full(j.work, 'work'), logs: full(j.logs, 'logs'), portable: full(j.portable, 'portable'), previous: build('previous'), current: build('current'), broken: build('broken') });
}

/** A build as the life cycle reads it (pure): {full, semver, build, installVersion, channel}, or null for a build no installer is made of. */
function buildOf(full) {
  const b = parseBuild(String(full || '').replace(/[\0\s]+$/, ''));
  if (!b || !b.installVersion) return null;
  return { full: String(full).replace(/[\0\s]+$/, ''), semver: b.version, build: b.build, installVersion: b.installVersion, channel: b.channel };
}
/** A build as the installer and machine.js name it in their words (pure): "AGMessage 0.6.0 (build 41)". */
const named = (b) => 'AGMessage ' + b.semver + ' (build ' + b.build + ')';

/** The words each refusal and outcome says, as the installer, machine.js, launch.js and the server word them. */
const WORDS = Object.freeze({
  /** A quiet first install with no /ADMIN= (the installer's InitializeSetup). */
  quietAdmin: () => 'AGMessage needs to know whose it is: add /ADMIN=<account>. Nothing was changed.',
  /** /DIR= naming any folder (InitializeSetup). */
  otherDir: (app) => 'AGMessage installs only in ' + app + ', which only administrators may change, since its tasks run node.exe from there; /DIR= names another folder. Nothing was changed.',
  /** A machine folder that is there before the first install (machine.js prepare). */
  notOurs: (root) => root + ' is there, and the install record shows no earlier AGMessage install and no data an uninstall kept: it is not AGMessage\'s to take. Remove it, then install again.',
  /** The machine folder an uninstall kept, a link now, or owned by another account (machine.js prepare, past the record's check). */
  notReal: (root) => root + ' is there and is not a real directory (a file, a link or a reparse point): it is not AGMessage\'s to take.',
  ownedBy: (root, sid) => root + ' is there and is owned by ' + sid + ', not SYSTEM or Administrators: it is not AGMessage\'s to take.',
  /** A portable copy on the port (machine.js preinstall-check). */
  portable: ({ version, port }) => 'AGMessage ' + version + ' is running on port ' + port + ' from a folder: press Ctrl+C in its window, then continue.',
  /** A busy AGMessage with no reason (machine.js preinstall-check): its counts in its own words. */
  busy: /^AGMessage is busy \((?<counts>[^)]+)\): type a reason to go on anyway, or wait\.$/,
  /** A program on the port that takes the connection and answers nothing (machine.js preinstall-check). */
  silent: ({ port, pid }) => 'AGMessage on port ' + port + ' (pid ' + pid + ') does not answer within ' + ANSWER_S + ' s: it reads as busy, and it cannot be stopped at loopback, so the install cannot go on.',
  /** An installer older than the installed build (InitializeSetup). */
  newer: ({ installed, installer }) => named(installed) + ' is newer than this installer\'s ' + installer.semver + ' (build ' + installer.build + '): uninstall it first to go back. Nothing was changed.',
  /** The installed build's own installer again (InitializeSetup). */
  same: ({ installed }) => named(installed) + ' is installed already: an installer upgrades only an older build. Nothing was changed.',
  /** An upgrade that did not reach its end, Inno's files rolled back (DeinitializeSetup's line in the log). */
  startedAgain: () => 'the install did not finish: the earlier build was started again',
  /** The way back's lines in the log of the build that did not start (GoBack). */
  wayBack: () => 'the way back: ',
  keptEnded: (b) => 'the kept installer of build ' + b.build + ' ended with 0',
  /** The way back's restore (machine.js restore): the earlier build's first start says it restarted in each room. */
  restartsEachHall: 'The earlier build\'s first start says AGMessage restarted in each hall.',
  /**
   * The upgrade's stop (machine.js upgrade-stop), saved and backed up: `backup` as the stop's record names it, inside the
   * data folder (lib/upgradebackup.js make: backups/<folder>).
   */
  upgradeStopped: /^AGMessage stopped for the upgrade and saved at \d\d:\d\d; backup (?<backup>backups\/upgrade-[0-9A-Za-z.+-]+-\d{8}T\d{6}Z-[0-9A-Za-z]{6})\.$/,
  /** The import on a node that has served (machine.js servedWords). */
  served: /^This PC's AGMessage has served already: it holds .+\. An import goes only into an AGMessage that has never started, since two machine keys, server secrets, certificates and audit chains cannot be merged: nothing is ever merged\./,
  /** The import's take, verified (machine.js import --step take). */
  imported: /^Imported and verified: \d+ halls?, \d+ messages?, \d+ accounts? and \d+ screens?, counted alike; every sealed value opens \(\d+\); the certificate's fingerprint is unchanged; the audit chain checks \(\d+ entr(?:y|ies)/,
  /** A portable folder an import marked as moved, at its next start (app/lib/dataformat.js movedRefusal). */
  moved: /was moved into the AGMessage installed on this PC.*: its halls, accounts and keys are there now, and its keys were removed from this Windows account, so this copy does not start\./,
  /** The portable folder's .bat on a PC where AGMessage is installed: its banner, and the server's words for the port. */
  batBanner: (semver) => 'AGMessage ' + semver + ' is installed on this PC and starts with Windows.',
  batInstalled: ({ version, build, port }) => 'The AGMessage installed on this PC (' + version + ', build ' + build + ') is serving on port ' + port + '. Open it from Start \u2192 AGMessage \u2192 Open AGMessage, or set PORT to another number to run this copy beside it.',
  batEnd: () => 'AGMessage did not start - the reason is above.',
  /** The installed node on a port a portable copy holds (app/lib/startup.js, the installed channel). */
  anotherCopy: ({ version, build, port }) => 'Another copy of AGMessage, ' + version + ' (build ' + build + '), holds port ' + port + '. Close its window: AGMessage takes the port back on its next try.',
  /** A control task's answers (machine.js control): a grant, a stop that saved, a start. */
  granted: /^Given: .+ may now start, stop AGMessage on this PC\./,
  stopped: /^Stopped, saved at \d\d:\d\d\./,
  started: /^Started\./,
  /** The watchdog's give-up, in its log (app/supervise.js). */
  gaveUp: /giving up: /,
});

/** An Inno Setup log's text from its bytes (pure): UTF-16 when it says so, else UTF-8, its byte order mark taken off. */
function logText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes || ''), 'utf8');
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return b.subarray(2).toString('utf16le');
  return b.toString('utf8').replace(/^\uFEFF/, '');
}
/**
 * An Inno Setup log read (pure): each message without its time ("2026-11-07 20:31:00.123   …"), a line with no time of
 * its own carried on the message before it; and what the installer's own lines say: `refused` (Refuse's "refused: …")
 * and `machine` (each "machine.js <verb> answered <code>: <words>").
 */
function innoLog(text) {
  const messages = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} {2,}(.*)$/.exec(line);
    if (m) messages.push(m[1]);
    else if (messages.length && line.trim()) messages[messages.length - 1] += '\n' + line;
  }
  const refused = messages.filter((x) => x.startsWith('refused: ')).map((x) => x.slice('refused: '.length));
  const machine = [];
  for (const x of messages) {
    const m = /^machine\.js ([a-z-]+) answered (-?\d+): ([\s\S]*)$/.exec(x);
    if (m) machine.push({ verb: m[1], code: Number(m[2]), words: m[3] });
  }
  return { messages, refused, machine, says: (words) => messages.some((x) => x.includes(words)) };
}

/** The install record from `reg query HKLM\SOFTWARE\AGMessage /reg:64` (pure; app/machine.js readRecord's layout): its values by name. */
function recordOf(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^ {4}([A-Za-z]{1,40}) {4}(REG_[A-Z_]{2,20}) {4}(.*)$/.exec(line);
    if (m) values[m[1]] = m[2] === 'REG_DWORD' && /^0x[0-9a-f]{1,8}$/i.test(m[3].trim()) ? String(Number(m[3].trim())) : m[3].trim();
  }
  return values;
}

/** The accounts no folder of the machine folder gives an entry to, by SID: Users, Authenticated Users, Everyone, CREATOR OWNER. */
const FORBIDDEN = Object.freeze(['S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', 'S-1-3-0']);
/** The forbidden accounts an access list (SDDL) gives an entry, allow or deny, inherited or not (pure): [{sid, name}]; an entry it cannot read counts as one. */
function forbiddenOn(sddl) {
  const out = [];
  for (const a of daclOf(sddl)) {
    if (a.raw !== undefined) { out.push({ sid: '?', name: 'an entry this does not read (' + a.raw + ')' }); continue; }
    if (FORBIDDEN.includes(a.sid) && !out.some((o) => o.sid === a.sid)) out.push({ sid: a.sid, name: SID_NAMES[a.sid] || a.sid });
  }
  return out;
}
/** SHA256SUMS.payload read (pure): each file it names, by its path under the install folder ('/' between folders), and its SHA-256. */
function payloadOf(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/i.exec(line.trim());
    if (m) out.set(m[2].replace(/\\/g, '/'), m[1].toLowerCase());
  }
  return out;
}
/** What Inno Setup itself writes into the install folder: its uninstaller and the record of what it laid down. */
const INNO_OWN = /^unins\d{3}\.(?:exe|dat|msg)$/i;
/** An installer the install keeps for the way back, by its install version. */
const KEPT_INSTALLER = /^installers\/AGMessage-Setup-\d{1,3}\.\d{1,3}\.\d{1,5}-unsigned\.exe$/i;
/**
 * The install folder against the payload (pure): `sums` each file's path and SHA-256 as laid. {wrong: files of the
 * payload missing or not its bytes, strays: files that are neither the payload's, Inno Setup's own, nor a kept installer}.
 */
function againstPayload(sums, payload) {
  const wrong = [];
  for (const [rel, sha] of payload) {
    const got = sums.get(rel);
    if (got !== sha) wrong.push(rel + (got ? ' (another SHA-256)' : ' (missing)'));
  }
  const strays = [...sums.keys()].filter((rel) => !payload.has(rel) && !INNO_OWN.test(rel) && !KEPT_INSTALLER.test(rel));
  return { wrong, strays };
}

/** Two snapshots of a folder compared (pure): each a Map of a file's path to {size, sha}; {added, changed, removed}. */
function snapshotDiff(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && (before.get(k).size !== after.get(k).size || before.get(k).sha !== after.get(k).sha));
  return { added, changed, removed };
}

/** Which of `secrets` (each {label, value}) a text holds, by value, case aside (pure): their labels, never the values. */
function secretsIn(text, secrets) {
  const t = String(text || '').toLowerCase();
  return secrets.filter((s) => s && typeof s.value === 'string' && s.value.length >= 8 && t.includes(s.value.toLowerCase())).map((s) => s.label);
}
/**
 * A text with each of `secrets` (each {label, value}) in it put as its label, case aside (pure): what an assertion's
 * message, a diagnostic or the life cycle's report may carry into the job's log, its TAP report and its summary.
 */
function scrubbed(text, secrets) {
  let t = String(text);
  for (const s of secrets) {
    if (!s || typeof s.value !== 'string' || s.value.length < 8) continue;
    t = t.replace(new RegExp(s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<' + s.label + '>');   // eslint-disable-line security/detect-non-literal-regexp -- the secret escaped, so it matches as its own characters alone
  }
  return t;
}
/** A task definition's own place for a password, which no AGMessage task uses (it runs as SYSTEM or LocalService by SID). */
const STORED_PASSWORD = /<LogonType>\s*Password\s*<\/LogonType>|<Password>/i;

/** The machine's events from machine\events.jsonl (pure): each whole line's event, in order. */
function eventsOf(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && Number.isSafeInteger(e.seq)) out.push(e); } catch { /* a line being written, or none */ }
  }
  return out;
}

/**
 * The facts an upgrade, an uninstall that keeps the data and an install again must keep (lib/importfacts.js), compared
 * (pure): the differences in words. `restarted` is how many rooms were told "AGMessage restarted" at the start after:
 * a way back's restore lays the data back as the upgrade's stop left it but for that stop's record, written after the
 * backup was made, so the earlier build's first start says it restarted in every room, one message each (restartsEachHall).
 */
function factsKept(before, after, { restarted = 0 } = {}) {
  const out = [];
  for (const k of ['halls', 'rooms', 'messages', 'accounts', 'screens']) {
    const want = k === 'messages' ? before[k] + restarted : before[k];
    if (want !== after[k]) out.push(k + ' ' + before[k] + (k === 'messages' && restarted ? ' and ' + restarted + ' restart line' + (restarted === 1 ? '' : 's') : '') + ' became ' + after[k]);
  }
  if (before.sealed.total !== after.sealed.total || after.sealed.open !== after.sealed.total) out.push('sealed values ' + before.sealed.total + ' (' + before.sealed.open + ' open) became ' + after.sealed.total + ' (' + after.sealed.open + ' open)');
  if (before.cert.fp !== after.cert.fp) out.push('the certificate\'s fingerprint changed');
  if (before.key.kid !== after.key.kid) out.push('the machine key changed');
  if (!after.chain.done || after.chain.entries < before.chain.entries) out.push('the audit chain does not check to its end, or holds fewer entries (' + before.chain.entries + ' became ' + after.chain.entries + ': ' + after.chain.words + ')');
  return out;
}

/**
 * The plan's list for the life cycle (6-U.8, unit U16), each item with the test of installer/test/lifecycle.test.js that
 * proves it, by its name; the attestation's is the release job's, which attests the installer and verifies it.
 */
const ITEMS = Object.freeze([
  ['install', 'the install of the build before this one, quiet: the record names its build and the account /ADMIN= named, its tasks and rules are made, and its server task serves it, proving the token'],
  ['upgrade from build-1 keeping halls, messages, accounts, every sealed value (made there first, at loopback, and busy)', 'the build before this one serves at loopback: a first admin account made with the token, a hall and its messages, and it reads busy'],
  ['upgrade from build-1 keeping halls, messages, accounts, every sealed value, the TLS fingerprint and the audit head', 'the upgrade to this build, its reason typed: halls, messages, accounts, every sealed value, the certificate\'s fingerprint and the audit head kept, and the stop timed to the new build\'s health'],
  ['a downgrade refused with words', 'a downgrade is refused with words, and this build serves on'],
  ['the same build refused with words', 'the same build again is refused with words, and this build serves on'],
  ['a portable copy on the port refused with words', 'a portable copy serving on the port is refused with words naming it, and nothing is made'],
  ['a busy server refused without a reason', 'an upgrade of a busy AGMessage with no reason typed is refused, and the earlier build serves on'],
  ['a silent server refused, naming its pid', 'an upgrade while a silent program holds the port is refused, naming its pid, and the earlier build serves again'],
  ['a file that cannot be replaced rolls back and the earlier server runs', 'a file that cannot be replaced rolls the upgrade back, and the earlier server runs again'],
  ['a new build that will not start is replaced by build-1, which answers', 'a new build that will not start is replaced by the build before it, which answers'],
  ['last-stop.json written by the stop', 'the upgrade\'s stop wrote last-stop.json: it saved, it names the build it stopped, and the backup it made for the way back is there'],
  ['uninstall keeps the data', 'the uninstall keeps the data, and removes the tasks, the rules and the record, taking back every account\'s right'],
  ['uninstall keeps the data (for AGMessage installed again, which takes it)', 'installed again, AGMessage takes the kept data: its halls, messages and accounts as they were'],
  ['uninstall removes the data with /REMOVEDATA, and removes the tasks and the rules', 'the uninstall with /REMOVEDATA removes the data, the keys last, with the tasks, the rules and the record'],
  ['another /DIR= refused', 'an install into another folder (/DIR=) is refused before anything is made'],
  ['a junction at %ProgramData%\\AGMessage refused', 'a junction made at the machine folder before the first install is refused, and nothing is laid where it points'],
  ['a folder another account owns at %ProgramData%\\AGMessage refused', 'a folder another account made at the machine folder before the first install is refused, and is left as it was'],
  ['a junction at %ProgramData%\\AGMessage refused (where an uninstall kept the data, past the record\'s check: a link)', 'the kept machine folder set aside and a junction made in its place is refused at the next install, and nothing is laid where it points'],
  ['a folder another account owns at %ProgramData%\\AGMessage refused (where an uninstall kept the data, past the record\'s check: its owner)', 'the kept machine folder given to another account is refused at the next install, and is left as it was'],
  ['no Users, Authenticated Users, Everyone or CREATOR OWNER entry on the root, keys, data or logs', 'the machine folder\'s root, keys, data and logs give Users, Authenticated Users, Everyone and CREATOR OWNER no entry'],
  ['nothing written under {app} at run time', 'nothing is written in the install folder while AGMessage runs'],
  ['no SeImpersonatePrivilege in the server\'s token', 'the server\'s token holds no SeImpersonatePrivilege'],
  ['no secret in either task\'s XML', 'neither the server task nor a control task holds a secret in its definition'],
  ['the installer\'s log holds no token or password', 'the installer\'s logs hold no token and no password'],
  ['the watchdog\'s give-up leaves the task stopped', 'the watchdog\'s give-up leaves the server task stopped'],
  ['every installed file matches SHA256SUMS.payload', 'every installed file is the payload\'s: each file SHA256SUMS.payload names laid with its SHA-256, and nothing else but Inno Setup\'s own and the kept installers'],
  ['the import\'s refusals', 'the import is refused on a node that has served, with its words, and nothing is made ready'],
  ['the import\'s verification', 'the import before a first start: the portable folder exported as its account, taken and verified elevated, its old keys removed, the folder marked as moved and refused at its next start'],
  ['/ADMIN= recorded in HKLM', 'the install of the build before this one, quiet: the record names its build and the account /ADMIN= named, its tasks and rules are made, and its server task serves it, proving the token'],
  ['a silent install without /ADMIN= refused', 'a quiet first install that names no account with /ADMIN= is refused with its words, and nothing is made'],
  ['a local standard account given start and stop runs its control task (else lab 7)', 'a local standard account given start and stop runs its own control task: AGMessage stopped with its reason and saved, then started, each one machine event naming it'],
  ['stop-to-health across the upgrade timed and reported', 'the upgrade to this build, its reason typed: halls, messages, accounts, every sealed value, the certificate\'s fingerprint and the audit head kept, and the stop timed to the new build\'s health'],
  ['On an installed PC: the zip\'s .bat names the installed build and exits 3 (unit S)', 'On an installed PC: the zip\'s start-agmessage.bat run from a throwaway folder names the installed build in its banner and ends with 3, saying the installed AGMessage serves on its port'],
  ['On an installed PC: a portable copy first on the port, then the installed node serves (unit S)', 'On an installed PC: a portable copy started first on the installed node\'s port, the installed node\'s log says another copy holds it, and the node serves once the copy is stopped'],
  ['the attestation covers the installer', 'release'],
].map(([item, test]) => Object.freeze({ item, test })));

module.exports = {
  ANSWER_S, PROBE, LOGON_REFUSED, BATCH_REFUSED, BATCH_REFUSED_WORDS, POLICY_REFUSED, WORDS, ITEMS, FORBIDDEN, INNO_OWN, KEPT_INSTALLER, STORED_PASSWORD, SEED_ACCOUNT,
  seedPassphrase, planOf, buildOf, named, probeWorstMs, logonRefused, resultWords, logText, innoLog, recordOf, forbiddenOn, payloadOf, againstPayload, snapshotDiff,
  secretsIn, scrubbed, eventsOf, factsKept,
};
