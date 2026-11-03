#!/usr/bin/env node
'use strict';
/**
 * The Windows evidence lane's register and judge (the 0.6.0 plan's Part 6, unit U7): the readings R1-R13 and the lab
 * lines 1-7, each with its mark and what a miss means, and the verdict on what the lane measured.
 *
 *   node tools/readings.js judge <raw.json> --out <readings.json> [--summary <file.md>]
 *       reads what tools/readings-take.js measured on the runner, judges each reading against its mark, writes the
 *       readings and appends their table to the summary (the job's step summary). Exit 0 whatever the readings say: a
 *       reading informs the release and never holds it. Exit 2 only when the measurements cannot be read as the lane's.
 *   node tools/readings.js notes [<readings.json>] [--install <docs/INSTALL.md>]
 *       prints the release notes' words on the readings: each that missed its mark with the fallback its unit names,
 *       what was not run and why, and the lab lines as docs/INSTALL.md records them. Exit 0 whatever the file holds: a
 *       file missing says the readings were not taken, and one that is not the lane's verdicts says they could not be
 *       read, so nothing in it can stop the release (64 only for a word it does not know).
 *   node tools/readings.js record <readings.json> [--install <docs/INSTALL.md>]
 *       writes a run's verdicts into docs/INSTALL.md's Measured column (the day, the build, the verdict and its words), for
 *       each reading the run took; one it did not take keeps what the column said. Exit 0 once written, 2 for a file that
 *       is not the lane's verdicts or names no build, 64 for a word it does not know.
 *
 * Invariants:
 *   - A reading is judged only on what was measured: one not taken, or taken without what its mark needs (Defender's
 *     real-time monitoring on, scanning on access, in its normal mode, for R2, R9 and R10), is "not run" with why, never
 *     met. A measurement over its mark is a miss even without Defender, which only adds to it.
 *   - The lab lines are the show laptop's and never a runner's: the lane reports each "not run"; only docs/INSTALL.md,
 *     where a person writes what the laptop showed, records one taken.
 *   - Nothing here fails the build because of a reading. Built-ins only, and app/lib/version.js for a stamp's build.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Each verdict a reading can have. */
const STATES = ['met', 'missed', 'recorded', 'open', 'not run', 'retired'];

/**
 * The readings, as the plan's U7 table names them. `needs` names the units whose code a reading measures, when this build
 * cannot take it at all; `later` the units whose code a reading taken now stands in for or leaves a part of (each adds its
 * step to the lane when it lands, and a fence fails once its code is there while it is still named here); `defender`
 * marks a reading taken with Defender's real-time monitoring on.
 */
const READINGS = [
  {
    id: 'R1',
    what: '`gap.js` (the stop at loopback with the proof, not SIGUSR2) at an empty hall and at 20 × 10,000',
    mark: 'the default page back ≤ 1.5 s at the largest real hall',
    miss: 'handoff is revisited (U.10)',
    needs: ['U8 (#36): the stop at loopback with the proof'],
  },
  {
    id: 'R2',
    what: 'lay about 5,120 files and 188 MB over the previous payload, Defender on',
    mark: '≤ 6 s together with R9 (a screen\'s "lost")',
    miss: 'version folders (U.10)',
    defender: true,
  },
  {
    id: 'R3',
    what: 'retired: it was B-service\'s (shawl\'s stop under `NT SERVICE\\AGMessage`), which is not the shape (U.5)',
    mark: '—',
    miss: '—',
    retired: true,
  },
  {
    id: 'R3′',
    what: 'the task: a stop at loopback with the proof saves and `last-stop.json` says so; the watchdog\'s give-up and a configuration refusal end the task with 0, and it stays stopped',
    mark: '10 of 10',
    miss: 'the release notes name the failing case; a stop that does not save is said on "This laptop"',
    needs: ['U8 (#36): the stop at loopback with the proof', 'U12 (#72): the server task'],
  },
  {
    id: 'R4',
    what: 'under the task: `LOCALAPPDATA`, `os.homedir()`, UDP 9928 broadcast heard, a quick tunnel\'s URL returned with nothing written in the account\'s profile, a rule by program, protocol and port matching `node.exe` under the task, `whoami /priv` from the server\'s process, `schtasks /showsid`',
    mark: '`SeImpersonatePrivilege` absent, and the server serves with `SeChangeNotifyPrivilege` alone',
    miss: 'the privilege list U12 sets is widened by the one privilege the reading names, with its reason',
    later: ['U12 (#72): the server task itself, in place of the stand-in'],
  },
  {
    id: 'R5',
    what: '`Get-AuthenticodeSignature` on `node.exe`, `cloudflared.exe` and the installer',
    mark: 'the first two Valid; the installer recorded',
    miss: '`README.txt` names the file Windows does not trust',
    later: ['U13 (#73): the installer'],
  },
  {
    id: 'R6',
    what: 'over-the-shoulder elevation: U.5.1\'s two readings of the account that started Setup; the user\'s own export (U14) run through `ExecAsOriginalUser` into the laptop\'s admin\'s inbox; an elevated read of another account\'s `%LOCALAPPDATA%\\AGMessage`',
    mark: 'both readings name the standard account',
    miss: 'the admin page asks the person to choose, as U.5.1 says',
    needs: ['U13 (#73): the installer', 'U14 (#75): the export'],
  },
  {
    id: 'R7',
    what: 'the folder pipe\'s access list as libuv makes it (`CreateNamedPipeW(…, NULL)`, `crit-dl/pipe.c:596-599`) under the task\'s token, and whether a remote client reaches it',
    mark: 'recorded',
    miss: 'nothing machine-level writes the pipe any more (U8); the busy line\'s readers are named',
    later: ['U12 (#72): the server task itself, in place of the stand-in'],
  },
  {
    id: 'R8',
    what: '`icacls C:\\` and `icacls %ProgramData%` (may a standard account create `C:\\node_modules` or `%ProgramData%\\AGMessage`?); `schtasks /query /xml` of each task as a standard account: readable or not, and no secret in it',
    mark: 'recorded',
    miss: 'U11 and U12\'s order already assume the worst',
    later: ['U12 (#72) and U17 (#74): the tasks\' definitions, read as a standard account'],
  },
  {
    id: 'R9',
    what: 'the upgrade backup\'s time at an empty hall and at 20 × 10,000',
    mark: 'recorded, beside R2',
    miss: 'as R2',
    defender: true,
    needs: ['U8 (#36) and U12 (#72): the upgrade\'s stop and its backup'],
  },
  {
    id: 'R10',
    what: 'extracting `node.exe` to `%TEMP%` for each machine command, Defender on',
    mark: 'recorded',
    miss: 'over 5 s: an upgrade runs its checks with the installed `node.exe`',
    defender: true,
  },
  {
    id: 'R11',
    what: 'a control task whose descriptor gives one standard account read and execute: that account runs it with `schtasks /run`; a second standard account is refused; the task runs as SYSTEM with `--for` that account\'s SID',
    mark: '10 of 10',
    miss: 'the Start menu\'s acts fall back to an administrator\'s approval, and the release notes say so',
    needs: ['U17 (#74): the control tasks'],
  },
  {
    id: 'R12',
    what: 'RestartOnFailure on the server task: does a non-zero exit of the action start it again, and does exit 0 leave it stopped',
    mark: 'recorded',
    miss: 'U.5\'s second cost reads as measured',
    later: ['U12 (#72): the server task itself, in place of the stand-in'],
  },
  {
    id: 'R13',
    what: 'from a control task as SYSTEM, `api.github.com`\'s release answer for a published tag: `immutable` and each asset\'s `digest` read; with no network, the words',
    mark: 'recorded',
    miss: 'U18\'s offline words are the ones shown',
    later: ['U17 (#74): a control task, in place of the stand-in', 'U18 (#77): the words with no network'],
  },
];

/**
 * The lab lines: the show laptop's (Windows 11), "not run" until taken there, never replaced by a reading of the runner.
 * `what` is the plan's line word for word; `pass` is the pass the plan names for it, or "recorded" where it names none.
 */
const LABS = [
  { id: 'Lab 1', what: 'lid closed and idle-out, on mains and on battery, with and without U9\'s power request. Serving after, sleeps recorded, no kill', pass: 'Serving after, sleeps recorded, no kill' },
  { id: 'Lab 2', what: 'Fast Startup\'s Shut down, then power on, under the task. Fast Startup keeps session 0 across a Shut down (https://learn.microsoft.com/en-us/windows/win32/power/system-power-states), so the server should be resumed, not restarted (inferred). Pass: no kill', pass: 'no kill' },
  { id: 'Lab 3', what: 'R2, R9 and R10 with the laptop\'s own Defender', pass: 'recorded' },
  { id: 'Lab 4', what: 'Smart App Control, evaluating and then enforcing: which of `node.exe`, `cloudflared.exe`, the installer and the .bat run', pass: 'recorded' },
  { id: 'Lab 5', what: 'a Windows restart and a shutdown with the server busy, under the task (expected: ended unsaved, U.5) and for the portable copy (console close). What `last-stop.json`, the next start\'s words and the audit head say', pass: 'recorded' },
  { id: 'Lab 6', what: 'an upgrade during a rehearsal, PlayMap\'s L11 for AGMessage: stop to health, and pages back', pass: 'recorded' },
  { id: 'Lab 7', what: 'the laptop\'s admin as a standard account: Show the admin token, Start, Stop with a reason, Upgrade (online and offline) and Go back; then the same from a second standard account given `start` and `stop` only, and from a third given nothing', pass: 'recorded' },
];

// ---------------------------------------------------------------- reading what Windows said (pure)

/** SDDL's names for well-known SIDs, both ways. */
const SID_ALIASES = {
  WD: 'S-1-1-0', AN: 'S-1-5-7', AU: 'S-1-5-11', BU: 'S-1-5-32-545', BA: 'S-1-5-32-544', BG: 'S-1-5-32-546',
  SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20', IU: 'S-1-5-4', NU: 'S-1-5-2', SU: 'S-1-5-6', CO: 'S-1-3-0',
  CG: 'S-1-3-1', OW: 'S-1-3-4', RC: 'S-1-5-12', WR: 'S-1-5-33', AC: 'S-1-15-2-1', PU: 'S-1-5-32-547',
};
const SID_NAMES = {
  'S-1-1-0': 'Everyone', 'S-1-5-7': 'Anonymous', 'S-1-5-11': 'Authenticated Users', 'S-1-5-32-545': 'Users',
  'S-1-5-32-544': 'Administrators', 'S-1-5-32-546': 'Guests', 'S-1-5-18': 'SYSTEM', 'S-1-5-19': 'LOCAL SERVICE',
  'S-1-5-20': 'NETWORK SERVICE', 'S-1-5-4': 'INTERACTIVE', 'S-1-5-2': 'NETWORK', 'S-1-5-6': 'SERVICE',
  'S-1-3-0': 'CREATOR OWNER', 'S-1-3-1': 'CREATOR GROUP', 'S-1-3-4': 'OWNER RIGHTS', 'S-1-5-12': 'RESTRICTED',
  'S-1-5-33': 'WRITE RESTRICTED', 'S-1-15-2-1': 'ALL APPLICATION PACKAGES', 'S-1-5-32-547': 'Power Users',
};
/** The groups every standard account signed in at the laptop holds. */
const STANDARD_ACCOUNT = ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4'];
/** SDDL's two-letter access rights. The generic ones are mapped to a file's (FILE_GENERIC_*) where an ACE is judged. */
const RIGHTS = {
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  RP: 0x10, WP: 0x20, CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, LO: 0x80, DT: 0x40, CR: 0x100,
  FA: 0x1F01FF, FR: 0x120089, FW: 0x120116, FX: 0x1200A0,
};
const FILE_GENERIC = { read: 0x120089, write: 0x120116, execute: 0x1200A0, all: 0x1F01FF };
const ADD_FILE = 0x2;          // FILE_ADD_FILE on a folder; FILE_WRITE_DATA on a pipe
const ADD_SUBDIRECTORY = 0x4;  // FILE_ADD_SUBDIRECTORY on a folder
const READ_DATA = 0x1;         // FILE_READ_DATA on a pipe

/** An ACE's rights as one mask, its generic rights mapped to a file's. NaN for a right SDDL does not name. */
function rightsMask(text) {
  let mask = 0;
  if (/^0x[0-9a-f]+$/i.test(text)) mask = Number.parseInt(text.slice(2), 16);
  else if (text.length % 2 === 0) {
    for (let i = 0; i < text.length; i += 2) {
      const r = RIGHTS[text.slice(i, i + 2).toUpperCase()];
      if (r === undefined) return Number.NaN;
      mask = (mask | r) >>> 0;
    }
  } else return Number.NaN;
  if (mask & RIGHTS.GA) mask |= FILE_GENERIC.all;
  if (mask & RIGHTS.GR) mask |= FILE_GENERIC.read;
  if (mask & RIGHTS.GW) mask |= FILE_GENERIC.write;
  if (mask & RIGHTS.GX) mask |= FILE_GENERIC.execute;
  return mask >>> 0;
}

/**
 * The DACL of an SDDL string as its ACEs: {type ('allow', 'deny' or SDDL's letter), flags [two-letter], inheritOnly, mask,
 * sid, name}. An ACE SDDL writes in a form this does not read keeps its text as `raw`, its mask NaN.
 */
function daclOf(sddl) {
  const text = String(sddl || '');
  const at = text.indexOf('D:');
  if (at < 0) return [];
  const end = text.indexOf('S:', at);
  const dacl = text.slice(at + 2, end < 0 ? undefined : end);
  const aces = [];
  for (const m of dacl.matchAll(/\(([^()]*)\)/g)) {
    const parts = m[1].split(';');
    if (parts.length < 6) { aces.push({ raw: m[1], mask: Number.NaN }); continue; }
    const [type, flagText, rights, , , who] = parts;
    const flags = (flagText.match(/.{2}/g) || []).map((f) => f.toUpperCase());
    const sid = SID_ALIASES[who.toUpperCase()] || who;
    aces.push({
      type: type === 'A' ? 'allow' : type === 'D' ? 'deny' : type,
      flags,
      inheritOnly: flags.includes('IO'),
      mask: rightsMask(rights),
      sid,
      name: SID_NAMES[sid] || sid,
    });
  }
  return aces;
}

/**
 * Whether one of `sids` holds `right` on the object itself by `aces`: 'yes' with the first allowing ACE's name, 'no', or
 * 'refused' when a deny for one of them comes first. An ACE that cannot be read makes it 'yes' (the worst is assumed).
 */
function holds(aces, sids, right) {
  for (const a of aces) {
    if (a.raw !== undefined || Number.isNaN(a.mask)) return { answer: 'yes', by: 'an entry this does not read' };
    if (a.inheritOnly || !sids.includes(a.sid) || !(a.mask & right)) continue;
    if (a.type === 'deny') return { answer: 'refused', by: a.name };
    if (a.type === 'allow') return { answer: 'yes', by: a.name };
  }
  return { answer: 'no', by: '' };
}

/** The rows of a `/fo csv` answer, each a list of its fields (a header row included). */
function csvRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (fields.length) rows.push(fields);
  }
  return rows;
}
/** `whoami /priv /fo csv`: the privileges the token holds, {name, state}, state in Windows' own words. */
function privilegesOf(text) {
  return csvRows(text).filter((r) => /^Se[A-Za-z]+Privilege$/.test(r[0])).map((r) => ({ name: r[0], state: r[2] || '' }));
}
/** The SIDs `whoami /user` or `/groups /fo csv` names. */
function sidsOf(text) {
  return csvRows(text).flat().filter((f) => /^S-1-[0-9-]+$/.test(f) && !f.includes('--') && !f.endsWith('-'));
}
/** `schtasks /showsid`'s SID for a task, or ''. */
function taskSidOf(text) {
  const m = /S-1-5-87-[0-9][0-9-]*[0-9]/.exec(String(text || ''));
  return m ? m[0] : '';
}
/** `netsh advfirewall firewall show rule … verbose`: the rule's fields, by Windows' English names. */
function ruleFields(text) {
  const fields = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z ]*?):\s+(.*)$/.exec(line);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  return fields;
}

// ---------------------------------------------------------------- the verdicts

const ms = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + ' s' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms');
const isMs = (n) => Number.isFinite(n) && n >= 0;
const slowest = (list) => (list.length ? Math.max(...list) : Number.NaN);
const rounds = (n) => n + (n === 1 ? ' round' : ' rounds');

/**
 * A list as PowerShell's ConvertTo-Json may write it: an array; one value on its own (Windows PowerShell can unwrap a
 * list of one); or an array wrapped as {value, Count}. Anything else is no list.
 */
function listOf(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  if (v && typeof v === 'object' && Array.isArray(v.value)) return v.value;
  return [];
}

/**
 * What keeps a Defender reading from being "on": its real-time monitoring off, its scanning on access off, a mode other
 * than Normal (in passive or EDR block mode Defender does no real-time scanning), or C:\ or D:\ still excluded. Empty: on.
 */
function defenderGaps(x) {
  if (!x || typeof x !== 'object') return ['not read'];
  const gaps = [];
  if (x.realtime !== true) gaps.push('real-time monitoring off');
  if (x.onAccess !== true) gaps.push('scanning on access off');
  if (x.mode !== 'Normal') gaps.push(typeof x.mode === 'string' && x.mode ? 'in ' + x.mode.slice(0, 40) + ', not Normal' : 'its mode not read');
  const excluded = listOf(x.exclusions).filter((p) => /^[CD]:\\?$/i.test(String(p)));
  if (excluded.length) gaps.push(excluded.join(' and ') + ' still excluded');
  return gaps;
}

/**
 * Defender's record as the lane read it: whether it came on (real-time monitoring, scanning on access, its Normal mode,
 * the image's exclusions gone), and was still so when the readings ended. A lane cut short has no reading at its end.
 */
function defenderOf(raw) {
  const d = raw && raw.defender && typeof raw.defender === 'object' ? raw.defender : null;
  const after = d && d.after && typeof d.after === 'object' ? d.after : null;
  const end = raw && raw.defenderEnd && typeof raw.defenderEnd === 'object' && !raw.defenderEnd.error ? raw.defenderEnd : null;
  const tookGaps = defenderGaps(after);
  const endGaps = defenderGaps(end);
  const took = tookGaps.length === 0;
  const stayed = endGaps.length === 0;
  const errors = d && Array.isArray(d.errors) ? d.errors.map(String) : [];
  let words;
  if (!d) words = 'Defender was not asked (no record of its step)';
  else if (!took) words = 'Defender did not come on as the readings need it (' + tookGaps.join(', ') + ')' + (errors.length ? ' (' + errors.join('; ') + ')' : '');
  else if (!end) words = 'Defender came on, with the image\'s exclusions removed, but was not read again when the readings ended';
  else if (!stayed) words = 'Defender came on, with the image\'s exclusions removed, but was not so when the readings ended (' + endGaps.join(', ') + ')';
  else words = 'Defender\'s real-time monitoring on, scanning on access, in its Normal mode, the image\'s exclusions of C:\\ and D:\\ removed, and still so when the readings ended';
  return { asked: !!d, took, stayed, on: took && stayed, words };
}

const NOT_TAKEN = 'not taken by this lane';
/** A reading's measurement, or why there is none: {taken, value, why}. */
function measured(raw, id) {
  const r = raw && raw.readings && typeof raw.readings === 'object' ? raw.readings[id] : undefined;
  if (r === undefined || r === null) return { taken: false, why: NOT_TAKEN };
  if (typeof r !== 'object') return { taken: false, why: 'its record is not the lane\'s' };
  if (r.error) return { taken: false, why: 'it failed on the runner: ' + String(r.error).slice(0, 300) };
  if (r.skipped) return { taken: false, why: String(r.skipped).slice(0, 300) };
  return { taken: true, value: r };
}

const verdict = (state, words, facts = {}) => ({ state, words, facts });

/**
 * R2: every round laid over the previous payload (the newest release published, or this build's own when none could be
 * had, said so), the slowest against 6 s, with R9's backup when there is one.
 */
function judgeR2(r, raw, def) {
  const laid = (Array.isArray(r.rounds) ? r.rounds : []).filter(isMs);
  if (!laid.length) return verdict('not run', 'no round laid the payload over the previous one');
  const worst = slowest(laid);
  const over = typeof r.over === 'string' && r.over ? 'over ' + r.over.slice(0, 80) + '\'s payload' : 'over this build\'s own (no earlier release\'s zip was had' + (typeof r.overWhy === 'string' && r.overWhy ? ': ' + r.overWhy.slice(0, 200) : '') + ')';
  const what = (r.files || '?') + ' files, ' + (Number.isFinite(r.bytes) ? Math.round(r.bytes / 1048576) + ' MB' : '? MB') + ' laid ' + over + ', the slowest of ' + rounds(laid.length) + ' ' + ms(worst);
  const facts = { files: r.files, bytes: r.bytes, over: r.over || '', rounds: laid, slowestMs: worst, emptyMs: r.emptyMs };
  if (worst > 6000) return verdict('missed', what + ': over 6 s alone, before R9\'s backup' + (def.on ? '' : ' (and without Defender, which only adds to it)'), facts);
  if (!def.on) return verdict('not run', what + ', but ' + def.words + ': not the reading its mark needs', facts);
  const r9 = measured(raw, 'R9');
  const backup = r9.taken ? slowest([r9.value.emptyMs, r9.value.largeMs].filter(isMs)) : Number.NaN;
  if (!Number.isFinite(backup)) return verdict('open', what + '; the mark is R2 and R9 together, and R9 is not run', facts);
  const sum = worst + backup;
  return verdict(sum <= 6000 ? 'met' : 'missed', what + ', with R9\'s backup ' + ms(backup) + ': ' + ms(sum) + (sum <= 6000 ? ' (≤ 6 s)' : ' (over 6 s)'), { ...facts, backupMs: backup });
}

/**
 * The build a bundle's stamp (its app/build.json) names, as its server reads the stamp and health says it (`readStamp`,
 * then `compose`); '' when it names none, or names one the server would not take as its stamp.
 */
function stampFull(stamp) {
  if (!stamp || typeof stamp !== 'object' || typeof stamp.version !== 'string' || !stamp.version) return '';
  const { compose, readStamp } = require(path.join(ROOT, 'app', 'lib', 'version.js'));
  const taken = readStamp(stamp, stamp.version);
  return taken ? compose(stamp.version, taken) : '';
}

/**
 * R4: the server's token under the task, and whether this bundle's server serves under it (health answering with the
 * build its stamp names: an answer from anything else on the port is not its server); the rest of the list beside them.
 * The token is read from the task's action, whose token the watchdog and the server inherit (each started with no token
 * of its own).
 */
function judgeR4(r, raw) {
  const privileges = privilegesOf(r.whoami && r.whoami.priv);
  const names = privileges.map((p) => p.name);
  const want = stampFull(raw && raw.build);
  const answered = !!(r.served && r.served.ok === true);
  const answeredBuild = answered && typeof r.served.build === 'string' ? r.served.build : '';
  const served = answered && !!want && answeredBuild === want;
  const facts = {
    task: r.task || '', sid: taskSidOf(r.showsid), user: sidsOf(r.whoami && r.whoami.user)[0] || '',
    taskSidInToken: !!taskSidOf(r.showsid) && sidsOf(r.whoami && r.whoami.groups).includes(taskSidOf(r.showsid)),
    privileges, localAppData: r.env ? r.env.LOCALAPPDATA || '' : '', homedir: r.homedir || '',
    served: r.served || null, udp: r.udp || null, tunnel: r.tunnel || null, profile: r.profile || null,
    rule: r.rule ? ruleFields(r.rule.readback) : null, build: want,
  };
  const yes = (v) => (v === true ? 'yes' : v === false ? 'no' : 'not read');
  const written = r.profile && Number.isInteger(r.profile.addedCount) ? r.profile.addedCount + (Number.isInteger(r.profile.changedCount) ? r.profile.changedCount : 0) : null;
  const rule = facts.rule || {};
  const beside = '. Beside it: the task\'s SID ' + (facts.sid ? (facts.taskSidInToken ? 'in the token' : 'not in the token') : 'not read') +
    '; UDP 9928 heard ' + yes(r.udp && r.udp.heard) + ' (from this machine)' +
    '; a quick tunnel\'s address ' + (r.tunnel ? (r.tunnel.returned ? 'returned' : 'not returned' + (r.tunnel.error ? ' (' + String(r.tunnel.error).slice(0, 100) + ')' : '')) : 'not tried') +
    '; files written or changed in the account\'s profile ' + (written === null ? 'not read' : written) +
    '; a rule by program, protocol and port ' + (rule.Program ? 'made and read back (' + [rule.Protocol, rule.LocalPort, rule.RemoteIP].join(', ') + '; no client on another machine to show it matching)' : 'not read back');
  if (!privileges.length) return verdict('not run', '`whoami /priv` under the task named no privilege: the token was not read', facts);
  const others = names.filter((n) => n !== 'SeChangeNotifyPrivilege');
  const misses = [];
  if (names.includes('SeImpersonatePrivilege')) misses.push('the token holds SeImpersonatePrivilege');
  else if (others.length) misses.push('the token holds ' + others.join(', ') + ' beside SeChangeNotifyPrivilege');
  if (!names.includes('SeChangeNotifyPrivilege')) misses.push('the token does not hold SeChangeNotifyPrivilege');
  if (!answered) misses.push('the server did not serve under the task' + (r.served && r.served.words ? ' (' + String(r.served.words).slice(0, 200) + ')' : ''));
  else if (want && answeredBuild !== want) misses.push('the server did not serve under the task: what answered on its port named the build ' + JSON.stringify(answeredBuild.slice(0, 80)) + ', not this bundle\'s ' + want);
  if (misses.length) return verdict('missed', misses.join('; ') + beside, facts);
  if (!served) return verdict('not run', 'the token holds SeChangeNotifyPrivilege alone, and a server answered (' + (answeredBuild || 'no build named') + '), but the bundle\'s stamp was not read, or is not one its server takes, so the answer could not be tied to this build' + beside, facts);
  return verdict('met', 'the token holds SeChangeNotifyPrivilege alone, and the server served under it in ' + ms(r.served.ms) + ' (' + want + ')' + beside, facts);
}

/** R5: Windows' own verdict on each file's signature. */
function judgeR5(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  const statusOf = (name) => {
    const f = files.find((x) => x && typeof x.path === 'string' && path.win32.basename(x.path).toLowerCase() === name);
    return f ? { status: String(f.status || ''), signer: String(f.signer || '') } : null;
  };
  const node = statusOf('node.exe');
  const cf = statusOf('cloudflared.exe');
  const facts = { node, cloudflared: cf, installer: r.installer || null };
  if (!node || !cf) return verdict('not run', 'Windows was not asked about ' + [!node && 'node.exe', !cf && 'cloudflared.exe'].filter(Boolean).join(' and '), facts);
  const installer = r.installer ? 'the installer ' + String(r.installer.status || '?') : 'the installer not built yet (U13, #73)';
  const untrusted = [['node.exe', node], ['cloudflared.exe', cf]].filter(([, s]) => s.status !== 'Valid');
  if (untrusted.length) return verdict('missed', untrusted.map(([n, s]) => n + ' ' + (s.status || 'unread')).join(', ') + '; ' + installer, facts);
  return verdict('met', 'node.exe Valid (' + node.signer + '), cloudflared.exe Valid (' + cf.signer + '); ' + installer, facts);
}

/**
 * R7: who may connect to the folder's pipe, as its access list says; and whether a client reaches it through SMB at this
 * machine's own names (`\\localhost\pipe\…`, `\\<name>\pipe\…`: a network logon, as a remote client's would be, on the
 * one machine the runner is). A client on a second machine is the show laptop's.
 */
function judgeR7(r) {
  const pipes = (Array.isArray(r.pipes) ? r.pipes : []).filter((p) => p && typeof p.name === 'string');
  const read = pipes.filter((p) => p.sddl);
  if (!read.length) return verdict('not run', pipes.length ? 'the pipe\'s access list was not read (' + String(pipes[0].error || 'no answer').slice(0, 200) + ')' : 'no pipe of the server\'s was found while it served', { pipes });
  const who = (aces, right) => [...new Set(aces.filter((a) => a.type === 'allow' && !a.inheritOnly && a.mask & right).map((a) => a.name))];
  const lists = read.map((p) => { const aces = daclOf(p.sddl); return { name: p.name, sddl: p.sddl, read: who(aces, READ_DATA), write: who(aces, ADD_FILE) }; });
  const first = lists[0];
  const remote = (Array.isArray(r.remote) ? r.remote : []).filter((x) => x && typeof x.via === 'string');
  const reach = remote.length
    ? 'through SMB at this machine\'s own names (a network logon; no second machine): ' + remote.map((x) => '\\\\' + x.via + ' ' + (x.connected === true ? 'connected' : 'not connected (' + String(x.error || 'no answer').slice(0, 80) + ')')).join(', ')
    : 'a client through SMB not tried';
  return verdict('recorded', 'read: ' + (first.read.join(', ') || 'none') + '; write: ' + (first.write.join(', ') || 'none') + ' (' + lists.length + ' pipe' + (lists.length === 1 ? '' : 's') + '); ' + reach, { pipes: lists, remote });
}

/** R8: may a standard account make a folder at C:\ or in %ProgramData%; the tasks' definitions wait for the tasks. */
function judgeR8(r) {
  const places = r.places && typeof r.places === 'object' ? r.places : {};
  const found = [];
  const facts = {};
  for (const [where, p] of Object.entries(places)) {
    if (!p || !p.sddl) { facts[where] = { error: p && p.error ? String(p.error) : 'not read' }; continue; }
    const aces = daclOf(p.sddl);
    const folder = holds(aces, STANDARD_ACCOUNT, ADD_SUBDIRECTORY);
    facts[where] = { sddl: p.sddl, createFolder: folder.answer, by: folder.by };
    found.push(where + ': a standard account ' + (folder.answer === 'yes' ? 'may create a folder (' + folder.by + ')' : folder.answer === 'refused' ? 'is refused a folder (' + folder.by + ')' : 'may not create a folder'));
  }
  if (!found.length) return verdict('not run', 'neither access list was read', facts);
  return verdict('recorded', found.join('; ') + '; the tasks\' definitions as a standard account wait for U12 (#72) and U17 (#74)', facts);
}

/**
 * R10: extracting node.exe to %TEMP% and running it once, each round; the slowest against 5 s. A round counts only when
 * the node.exe it extracted ran to exit 0: one that did not run (blocked, quarantined, timed out) measured no command, so
 * it is not run with what it said, or missed when it took over 5 s anyway.
 */
function judgeR10(r, raw, def) {
  const taken = (Array.isArray(r.rounds) ? r.rounds : []).filter((x) => x && isMs(x.totalMs));
  if (!taken.length) return verdict('not run', 'no round extracted node.exe', {});
  const ran = taken.filter((x) => x.code === 0);
  const failed = taken.filter((x) => x.code !== 0);
  const worst = slowest(taken.map((x) => x.totalMs));
  const facts = { rounds: taken, slowestMs: worst, ran: ran.length, where: r.where || '' };
  const failedWords = (x) => 'round ' + (taken.indexOf(x) + 1) + ' ended ' + (Number.isInteger(x.code) ? 'with ' + x.code : 'without an exit code') + ' after ' + ms(x.totalMs) + (x.err ? ' (' + String(x.err).slice(0, 160) + ')' : '');
  const what = 'the slowest of ' + rounds(taken.length) + ' ' + ms(worst) + ' (extracted, then run once)';
  const without = def.on ? '' : ' (and without Defender, which only adds to it)';
  if (ran.some((x) => x.totalMs > 5000)) return verdict('missed', what + ': over 5 s' + without + (failed.length ? '; ' + failed.map(failedWords).join('; ') : ''), facts);
  const slowFail = failed.filter((x) => x.totalMs > 5000);
  if (slowFail.length) return verdict('missed', 'node.exe extracted to %TEMP% did not run within 5 s: ' + slowFail.map(failedWords).join('; ') + without, facts);
  if (failed.length) return verdict('not run', 'node.exe extracted to %TEMP% did not run to exit 0, so no command was measured: ' + failed.map(failedWords).join('; '), facts);
  if (!def.on) return verdict('not run', what + ', but ' + def.words + ': not the reading its mark needs', facts);
  return verdict('recorded', what + ': within 5 s', facts);
}

/** R12: whether Task Scheduler starts the action again after a non-zero exit, and leaves it stopped after 0. */
function judgeR12(r) {
  const n = r.nonZero && Number.isInteger(r.nonZero.starts) ? r.nonZero.starts : -1;
  const z = r.zero && Number.isInteger(r.zero.starts) ? r.zero.starts : -1;
  const facts = { nonZero: r.nonZero || null, zero: r.zero || null };
  if (n < 1 || z < 1) return verdict('not run', 'the stand-in task did not start' + (n < 1 ? ' for the non-zero exit' : ' for exit 0'), facts);
  const waited = (x) => (x && isMs(x.waitedMs) ? ' within ' + ms(x.waitedMs) : '');
  const parts = [
    n >= 2 ? 'a non-zero exit was started again (' + (n - 1) + ' time' + (n === 2 ? '' : 's') + waited(r.nonZero) + ')' : 'a non-zero exit was not started again' + waited(r.nonZero),
    z >= 2 ? 'exit 0 was started again' : 'exit 0 left it stopped' + waited(r.zero),
  ];
  // The miss is the cost U.5 names: a crash of the watchdog itself is not started again; and a 0 that is would undo "stays stopped".
  return verdict(n >= 2 && z === 1 ? 'recorded' : 'missed', parts.join('; '), facts);
}

/** R13: GitHub's release answer read from a SYSTEM task; the offline half is U18's words. */
function judgeR13(r) {
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const facts = { tag: r.tag || '', status: r.status, immutable: r.immutable, assets, ms: r.ms, failure: r.failure || '' };
  if ((r.status === 403 || r.status === 429) && r.rateRemaining === 0) return verdict('not run', 'GitHub refused this runner\'s address for its rate limit (HTTP ' + r.status + '), which says nothing of the show laptop\'s', facts);
  if (r.status !== 200) return verdict('missed', 'GitHub\'s answer was not read from the SYSTEM task (' + (r.status ? 'HTTP ' + r.status : String(r.failure || 'no answer')) + ')', facts);
  const digests = assets.filter((a) => a && /^sha256:[0-9a-f]{64}$/.test(String(a.digest || ''))).length;
  const imm = r.immutable === true ? 'immutable' : r.immutable === false ? 'not immutable (U16, #78, turns immutable releases on)' : 'no `immutable` in the answer';
  return verdict('recorded', 'read in ' + ms(r.ms) + ': ' + (r.tag || 'the release') + ' ' + imm + ', ' + digests + ' of ' + assets.length + ' assets with a SHA-256 digest; with no network, the words wait for U18 (#77)', facts);
}

const JUDGES = { R2: judgeR2, R4: judgeR4, R5: judgeR5, R7: judgeR7, R8: judgeR8, R10: judgeR10, R12: judgeR12, R13: judgeR13 };

/**
 * Every reading's verdict on what the lane measured (`raw`, tools/readings-take.js's record; anything else reads as
 * nothing measured): {v, at, build, runner, defender, readings: [{id, what, mark, miss, state, words, facts, needs}], labs}.
 */
function judge(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const def = defenderOf(r);
  // The lane writes its record after each reading, and says it ended only at its end: a record without that was cut short.
  const cutShort = r.complete === false;
  const readings = READINGS.map((reading) => {
    const base = { id: reading.id, what: reading.what, mark: reading.mark, miss: reading.miss, needs: reading.needs || [], later: reading.later || [] };
    if (reading.retired) return { ...base, ...verdict('retired', reading.what) };
    const m = measured(r, reading.id);
    const judgeOne = JUDGES[reading.id];
    if (!m.taken || !judgeOne) {
      const why = reading.needs && !judgeOne ? 'needs ' + reading.needs.join('; ') : cutShort && m.why === NOT_TAKEN ? 'not taken: the lane ended before it (cut short)' : m.why;
      return { ...base, ...verdict('not run', why) };
    }
    let v;
    try { v = judgeOne(m.value, r, def); } catch (e) { v = verdict('not run', 'its record could not be read (' + e.message + ')'); }
    return { ...base, ...v };
  });
  return {
    v: 1,
    at: typeof r.at === 'string' ? r.at : '',
    build: r.build && typeof r.build === 'object' ? r.build : null,
    runner: r.runner && typeof r.runner === 'object' ? r.runner : null,
    complete: !cutShort,
    defender: def,
    readings,
    labs: LABS.map((l) => ({ ...l, state: 'not run', words: 'the show laptop\'s, never a runner\'s: docs/INSTALL.md records it once taken' })),
  };
}

// ---------------------------------------------------------------- words

/** The build the readings were taken on, as its stamp names it, or nothing. */
function buildWords(judged) {
  const b = judged.build;
  return b && typeof b === 'object' && typeof b.version === 'string' && b.version ? 'Build ' + b.version + (Number.isInteger(b.build) ? ' (build ' + b.build + (typeof b.commit === 'string' && b.commit ? ', ' + b.commit.slice(0, 12) : '') + ')' : '') + '. ' : '';
}
const runnerWords = (judged) => (judged.runner && typeof judged.runner === 'object' && typeof judged.runner.image === 'string' && judged.runner.image ? judged.runner.image : '');
const cutWords = (judged) => (judged.complete === false ? 'The lane was cut short: a reading it had not reached reads not run. ' : '');

const MARKS = { met: '✓ met', missed: '✕ missed', recorded: '✓ recorded', open: '△ open', 'not run': '○ not run', retired: '— retired' };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The job's step summary: the Defender record, every reading with its verdict, and the lab lines. */
function summary(judged) {
  const lines = [
    '## The Windows readings (the evidence lane)',
    '',
    'They inform the release and never hold it. ' + buildWords(judged) + (runnerWords(judged) ? 'Runner ' + runnerWords(judged) + '. ' : '') + cutWords(judged) + judged.defender.words + '.',
    '',
    '| Reading | Verdict | What was found | Mark | A miss means |',
    '|---|---|---|---|---|',
    ...judged.readings.map((x) => '| ' + x.id + ' | ' + MARKS[x.state] + ' | ' + cell(x.words) + ' | ' + cell(x.mark) + ' | ' + cell(x.miss) + ' |'),
    '',
    '| Lab line | Verdict | What |',
    '|---|---|---|',
    ...judged.labs.map((l) => '| ' + l.id + ' | ' + MARKS[l.state] + ' | ' + cell(l.what) + ' |'),
    '',
  ];
  return lines.join('\n');
}

/** The lab lines as docs/INSTALL.md records them: id -> the "Taken" cell's words ('not run' until a person writes one). */
function labRecord(installText) {
  const taken = {};
  for (const line of String(installText || '').split(/\r?\n/)) {
    const m = /^\|\s*(Lab \d+)\s*\|.*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (m && LABS.some((l) => l.id === m[1])) taken[m[1]] = m[2];
  }
  return taken;
}

/**
 * Whether `j` is the lane's verdicts as `judge` writes them, in the shape every word below reads: v 1, Defender's words,
 * and every reading an object with its id, a known verdict and its words, mark and miss as text (pure).
 */
function isJudged(j) {
  return !!j && typeof j === 'object' && j.v === 1 && !!j.defender && typeof j.defender === 'object' && typeof j.defender.words === 'string' &&
    Array.isArray(j.readings) && j.readings.length > 0 && Array.isArray(j.labs) &&
    j.readings.every((x) => !!x && typeof x === 'object' && typeof x.id === 'string' && STATES.includes(x.state) && ['words', 'mark', 'miss'].every((k) => typeof x[k] === 'string'));
}

/**
 * The release notes' words: the readings that missed their mark, each with the fallback its unit names; then those met
 * or recorded, those open, those not run and why; then the lab lines as docs/INSTALL.md records them. `judged` null or
 * undefined: the readings were not taken for this build; anything else that is not the lane's verdicts: they could not
 * be read. Either is said, and nothing is claimed for them.
 */
function notes(judged, installText = '') {
  const out = ['### The Windows readings', ''];
  if (judged === null || judged === undefined) {
    out.push('The Windows readings were not taken for this build (the evidence lane wrote none): nothing is claimed for them. They inform the release and never hold it.');
  } else if (!isJudged(judged)) {
    out.push('The Windows readings for this build could not be read (the evidence lane\'s file is not its verdicts): nothing is claimed for them. They inform the release and never hold it.');
  } else {
    const by = (state) => judged.readings.filter((x) => x.state === state);
    out.push(buildWords(judged) + 'Taken on ' + (runnerWords(judged) || 'the Windows runner') + (typeof judged.at === 'string' && judged.at ? ' at ' + judged.at.slice(0, 40) : '') + '. ' + cutWords(judged) + judged.defender.words + '. They inform the release and never hold it; `docs/INSTALL.md` says what each means.');
    out.push('');
    const missed = by('missed');
    out.push(missed.length ? '**Missed their mark:**' : '**No reading missed its mark.**');
    for (const x of missed) out.push('- ' + x.id + ': ' + x.words + '. Mark: ' + x.mark + '. So: ' + x.miss + '.');
    const good = [...by('met'), ...by('recorded')];
    if (good.length) out.push('', '**Met or recorded:** ' + good.map((x) => x.id + ' (' + x.words + ')').join('; ') + '.');
    const open = by('open');
    if (open.length) out.push('', '**Open:** ' + open.map((x) => x.id + ' (' + x.words + ')').join('; ') + '.');
    const notRun = by('not run');
    if (notRun.length) out.push('', '**Not run:** ' + notRun.map((x) => x.id + ' (' + x.words + ')').join('; ') + '.');
  }
  const record = labRecord(installText);
  out.push('', '**The lab lines** (the show laptop\'s, never a runner\'s): ' + LABS.map((l) => l.id + ' ' + (record[l.id] || 'not run')).join('; ') + '.');
  return out.join('\n') + '\n';
}

/** The verdicts a run's record writes into docs/INSTALL.md: the ones it took (met, missed, recorded, open). */
const RECORDED = ['met', 'missed', 'recorded', 'open'];

/**
 * docs/INSTALL.md with a run's verdicts in its readings table's Measured column (the last): "<day>, build <build>: <verdict>:
 * <words>" for each reading the run took; a reading it did not take keeps its cell, and every other line is left as it
 * is. {text, changed: [ids]}, or {error} when the run names no day or no build (pure).
 */
function recordInstall(installText, judged) {
  if (!isJudged(judged)) return { error: 'not the lane\'s verdicts' };
  const day = typeof judged.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(judged.at) ? judged.at.slice(0, 10) : '';
  const build = stampFull(judged.build);
  if (!day || !build) return { error: 'the run names no ' + (day ? 'build' : 'day') + ', so nothing it found can be tied to one' };
  const by = new Map(judged.readings.filter((x) => RECORDED.includes(x.state)).map((x) => [x.id, x]));
  const changed = [];
  const lines = String(installText).split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    // A row's cells split at each pipe a cell does not escape: '', the cells, '' (a row starts and ends with one).
    const cells = (cr ? line.slice(0, -1) : line).split(/(?<!\\)\|/);
    const id = cells.length >= 8 && cells[0] === '' && cells[cells.length - 1] === '' ? cells[1].trim() : '';
    const x = id && by.get(id);
    if (!x || !READINGS.some((y) => y.id === id)) return line;
    changed.push(id);
    cells[cells.length - 2] = ' ' + cell(day + ', build ' + build + ': ' + MARKS[x.state] + ': ' + x.words) + ' ';
    return cells.join('|') + cr;
  });
  return { text: lines.join('\n'), changed };
}

// ---------------------------------------------------------------- the command line

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

/** What a file that is there holds when it holds nothing the notes can read: never the lane's verdicts. */
const UNREAD = Object.freeze({ unreadable: true });
/** The verdicts a file holds: undefined when there is no file, UNREAD when it cannot be read, is not JSON, or is null. */
function readVerdicts(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? undefined : UNREAD; }
  try { const v = JSON.parse(text.replace(/^\uFEFF/, '')); return v === null ? UNREAD : v; } catch { return UNREAD; /* not JSON: not the lane's verdicts */ }
}

function main(argv) {
  const [verb, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  const installFile = flag('--install') || path.join(ROOT, 'docs', 'INSTALL.md');
  if (verb === 'judge') {
    const out = flag('--out');
    if (positional.length !== 1 || !out) { console.error('readings: judge <raw.json> --out <readings.json> [--summary <file.md>]'); return 64; }
    let raw;
    try { raw = readJson(positional[0]); } catch (e) {
      console.error('readings: the lane\'s measurements could not be read (' + positional[0] + ': ' + e.message + '); nothing is judged');
      return 2;
    }
    if (!raw || raw.v !== 1 || typeof raw.readings !== 'object' || raw.readings === null) {
      console.error('readings: ' + positional[0] + ' is not the lane\'s record (v 1, with its readings); nothing is judged');
      return 2;
    }
    const judged = judge(raw);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(judged, null, 2) + '\n');
    const sum = flag('--summary');
    if (sum) fs.appendFileSync(sum, summary(judged) + '\n');
    for (const x of judged.readings) console.log(x.id.padEnd(4) + ' ' + MARKS[x.state].padEnd(12) + ' ' + x.words);
    console.log('readings: ' + judged.defender.words + '; written to ' + out + ' (a reading informs the release and never holds it)');
    return 0;
  }
  if (verb === 'notes') {
    if (positional.length > 1) { console.error('readings: notes [<readings.json>] [--install <docs/INSTALL.md>]'); return 64; }
    // Whatever the file holds, the notes are written and this exits 0: the readings inform the release, never hold it.
    let words;
    try {
      const judged = positional[0] ? readVerdicts(positional[0]) : undefined;
      let install = '';
      try { install = fs.readFileSync(installFile, 'utf8'); } catch { /* no paper: every lab line reads not run */ }
      words = notes(judged, install);
    } catch (e) {
      words = notes({}, '');
      console.error('readings: the notes could not read the readings (' + String((e && e.message) || e).slice(0, 200) + ')');
    }
    process.stdout.write(words);
    return 0;
  }
  if (verb === 'record') {
    if (positional.length !== 1) { console.error('readings: record <readings.json> [--install <docs/INSTALL.md>]'); return 64; }
    const judged = readVerdicts(positional[0]);
    let install;
    try { install = fs.readFileSync(installFile, 'utf8'); } catch (e) { console.error('readings: ' + installFile + ' could not be read (' + e.message + '); nothing is recorded'); return 2; }
    const r = recordInstall(install, judged);
    if (r.error) { console.error('readings: ' + positional[0] + ': ' + r.error + '; nothing is recorded'); return 2; }
    if (r.text !== install) fs.writeFileSync(installFile, r.text);
    console.log('readings: ' + (r.changed.length ? r.changed.join(', ') + ' recorded in ' + installFile : 'no reading taken in this run, so ' + installFile + ' is as it was'));
    return 0;
  }
  console.error('readings: judge <raw.json> --out <readings.json> [--summary <file.md>] | notes [<readings.json>] [--install <file>] | record <readings.json> [--install <file>]');
  return 64;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  READINGS, LABS, STATES, MARKS, SID_NAMES, STANDARD_ACCOUNT,
  rightsMask, daclOf, holds, csvRows, privilegesOf, sidsOf, taskSidOf, ruleFields,
  defenderOf, defenderGaps, stampFull, judge, summary, notes, labRecord, isJudged, recordInstall, main,
};
