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
 *   node tools/readings.js laptop [--design <docs/DESIGN.md>]
 *       prints the release notes' words on the show laptop's readings (the plan's Part 5 §13.4, readings 0-9) as
 *       docs/DESIGN.md's table "Measured on the show laptop" records them: each that triggered its change, named with that
 *       change (a 0.6.x unit), each recorded within its threshold, and those not measured. Exit 0 whatever the paper
 *       holds: one that cannot be read says so, and claims nothing (64 only for a word it does not know).
 *   node tools/readings.js record <readings.json> [--install <docs/INSTALL.md>]
 *       writes a run's verdicts into docs/INSTALL.md's Measured column (the day, the build, the verdict and its words), for
 *       each reading the run took; one it did not take keeps what the column said. Exit 0 once written, 2 for a file that
 *       is not the lane's verdicts or names no build, 64 for a word it does not know.
 *
 * Invariants:
 *   - A reading is judged only on what was measured: one not taken, or taken without what its mark needs (Defender's
 *     real-time monitoring on, scanning on access, in its normal mode, for R2, R9 and R10: in a take given Defender's
 *     record, never one written as given none, which the lane begins after the step that puts Defender back as the
 *     image left it, whatever that step ended with), is "not run" with why, never met. A measurement over its mark is a miss even without Defender, which only adds
 *     to it. The judge observes Defender only through the record a take was given and read again at its end.
 *   - The lab lines are the show laptop's and never a runner's: the lane reports each "not run"; only docs/INSTALL.md,
 *     where a person writes what the laptop showed, records one taken.
 *   - The show laptop's readings are a person's: only docs/DESIGN.md, where a person writes what the laptop's health
 *     showed with its verdict, records one; the notes read it as it stands when the tag is built, and never judge one.
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
  },
  {
    id: 'R4',
    what: 'under the task: `LOCALAPPDATA`, `os.homedir()`, UDP 9928 broadcast heard, a quick tunnel\'s URL returned with nothing written in the account\'s profile, a rule by program, protocol and port matching `node.exe` under the task, `whoami /priv` from the server\'s process, `schtasks /showsid`',
    mark: '`SeImpersonatePrivilege` absent, and the server serves with `SeChangeNotifyPrivilege` alone',
    miss: 'the privilege list U12 sets is widened by the one privilege the reading names, with its reason',
  },
  {
    id: 'R5',
    what: '`Get-AuthenticodeSignature` on `node.exe`, `cloudflared.exe` and the installer',
    mark: 'the first two Valid; the installer recorded',
    miss: '`README.txt` names the file Windows does not trust',
  },
  {
    id: 'R6',
    what: 'over-the-shoulder elevation: U.5.1\'s two readings of the account that started Setup; the user\'s own export (U14) run through `ExecAsOriginalUser` into the laptop\'s admin\'s inbox; an elevated read of another account\'s `%LOCALAPPDATA%\\AGMessage`',
    mark: 'both readings name the standard account',
    miss: 'the admin page asks the person to choose, as U.5.1 says',
  },
  {
    id: 'R7',
    what: 'the folder pipe\'s access list as libuv makes it (`CreateNamedPipeW(…, NULL)`, `crit-dl/pipe.c:596-599`) under the task\'s token, and whether a remote client reaches it',
    mark: 'recorded',
    miss: 'nothing machine-level writes the pipe any more (U8); the busy line\'s readers are named',
  },
  {
    id: 'R8',
    what: '`icacls C:\\` and `icacls %ProgramData%` (may a standard account create `C:\\node_modules` or `%ProgramData%\\AGMessage`?); `schtasks /query /xml` of each task as a standard account: readable or not, and no secret in it',
    mark: 'recorded',
    miss: 'U11 and U12\'s order already assume the worst',
  },
  {
    id: 'R9',
    what: 'the upgrade backup\'s time at an empty hall and at 20 × 10,000',
    mark: 'recorded, beside R2',
    miss: 'as R2',
    defender: true,
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
  },
  {
    id: 'R12',
    what: 'RestartOnFailure on the server task: does a non-zero exit of the action start it again, and does exit 0 leave it stopped',
    mark: 'recorded',
    miss: 'U.5\'s second cost reads as measured',
  },
  {
    id: 'R13',
    what: 'from a control task as SYSTEM, `api.github.com`\'s release answer for a published tag: `immutable` and each asset\'s `digest` read; with no network, the words',
    mark: 'recorded',
    miss: 'U18\'s offline words are the ones shown',
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
/**
 * SDDL's names for the built-in Administrator and Guest of the machine whose descriptor it is, by their RID in its own
 * domain: Windows writes LA or LG, never the whole SID, for that account of that machine. The lane runs on a GitHub-hosted
 * runner only, which is joined to no domain, so a machine domain's SID it records there with that RID
 * (S-1-5-21-a-b-c-500) is that account.
 */
const MACHINE_ALIASES = { LA: { rid: 500, name: 'LA, this machine\'s Administrator' }, LG: { rid: 501, name: 'LG, this machine\'s Guest' } };
const MACHINE_SID = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/;
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
const EXECUTE = 0x20;          // FILE_EXECUTE: on a task's descriptor, with read, what lets an account run it

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
    const machine = Object.hasOwn(MACHINE_ALIASES, who.toUpperCase()) ? MACHINE_ALIASES[who.toUpperCase()] : null;
    const sid = machine ? who.toUpperCase() : SID_ALIASES[who.toUpperCase()] || who;
    aces.push({
      type: type === 'A' ? 'allow' : type === 'D' ? 'deny' : type,
      flags,
      inheritOnly: flags.includes('IO'),
      mask: rightsMask(rights),
      sid,
      name: machine ? machine.name : SID_NAMES[sid] || sid,
      ...(machine ? { machineRid: machine.rid } : {}),
    });
  }
  return aces;
}

/**
 * Whether an ACE is for one of `sids`: by its SID, or, for LA or LG (MACHINE_ALIASES), a machine domain's SID with that
 * account's RID, which on the machine that wrote the descriptor is that account.
 */
function aceFor(a, sids) {
  if (a.machineRid === undefined) return sids.includes(a.sid);
  return sids.some((s) => { const m = MACHINE_SID.exec(String(s)); return !!m && Number(m[1]) === a.machineRid; });
}

/**
 * Whether one of `sids` holds `right` on the object itself by `aces`: 'yes' with the first allowing ACE's name, 'no', or
 * 'refused' when a deny for one of them comes first. An ACE that cannot be read makes it 'yes' (the worst is assumed).
 */
function holds(aces, sids, right) {
  for (const a of aces) {
    if (a.raw !== undefined || Number.isNaN(a.mask)) return { answer: 'yes', by: 'an entry this does not read' };
    if (a.inheritOnly || !aceFor(a, sids) || !(a.mask & right)) continue;
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

/** A path or a program's path as Windows compares it: any case, either slash, no trailing backslash. */
const winPath = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
/**
 * What keeps a Defender reading from being "on": its real-time monitoring off, its scanning on access off, a mode other
 * than Normal (in passive or EDR block mode Defender does no real-time scanning), C:\ or D:\ still excluded, or any
 * exclusion but the runner's own that tools/defender-on.ps1 made and recorded (`own`: its folders and its programs, each
 * matched whole): another path (a wildcard or a short name among them, never read as what it covers), another process,
 * any extension, or a list not read at all. Empty: on.
 */
function defenderGaps(x, own = {}) {
  if (!x || typeof x !== 'object') return ['not read'];
  const gaps = [];
  if (x.realtime !== true) gaps.push('real-time monitoring off');
  if (x.onAccess !== true) gaps.push('scanning on access off');
  if (x.mode !== 'Normal') gaps.push(typeof x.mode === 'string' && x.mode ? 'in ' + x.mode.slice(0, 40) + ', not Normal' : 'its mode not read');
  const cut = (v) => String(v).slice(0, 120);
  const ownPaths = new Set(listOf(own.paths).map(winPath));
  const ownProcesses = new Set(listOf(own.processes).map(winPath));
  const paths = listOf(x.exclusions).map(String);
  const drives = paths.filter((p) => /^[CD]:\\?$/i.test(p));
  if (drives.length) gaps.push(drives.join(' and ') + ' still excluded');
  const others = paths.filter((p) => !/^[CD]:\\?$/i.test(p) && !ownPaths.has(winPath(p)));
  if (others.length) gaps.push(others.map(cut).join(' and ') + ' excluded, not the runner\'s own');
  if (!('processes' in x)) gaps.push('its process exclusions not read');
  else {
    const processes = listOf(x.processes).map(String).filter((p) => !ownProcesses.has(winPath(p)));
    if (processes.length) gaps.push(processes.map(cut).join(' and ') + ' excluded as a process, not the runner\'s own');
  }
  if (!('extensions' in x)) gaps.push('its extension exclusions not read');
  else if (listOf(x.extensions).length) gaps.push('the extension' + (listOf(x.extensions).length > 1 ? 's ' : ' ') + listOf(x.extensions).map(cut).join(', ') + ' excluded');
  return gaps;
}

/**
 * Defender's record as the lane read it: whether it came on (real-time monitoring, scanning on access, its Normal mode,
 * no exclusion but the runner's own), and was still so when the readings taken with it ended (the take given its record
 * reads it again; a take given none asks nothing of it). A lane cut short has no reading at its end. The takes written as
 * given no Defender record are named.
 */
function defenderOf(raw) {
  const d = raw && raw.defender && typeof raw.defender === 'object' ? raw.defender : null;
  const after = d && d.after && typeof d.after === 'object' ? d.after : null;
  const end = raw && raw.defenderEnd && typeof raw.defenderEnd === 'object' && !raw.defenderEnd.error ? raw.defenderEnd : null;
  const runner = d && d.runner && typeof d.runner === 'object' ? d.runner : {};
  const tookGaps = defenderGaps(after, runner);
  const endGaps = defenderGaps(end, runner);
  const took = tookGaps.length === 0;
  const stayed = endGaps.length === 0;
  const errors = d && Array.isArray(d.errors) ? d.errors.map(String) : [];
  let words;
  if (!d) words = 'Defender was not asked (no record of its step)';
  else if (!took) words = 'Defender did not come on as the readings need it (' + tookGaps.join(', ') + ')' + (errors.length ? ' (' + errors.join('; ') + ')' : '');
  else if (!end) words = 'Defender came on, with the image\'s exclusions removed, but was not read again when the readings taken with it ended';
  else if (!stayed) words = 'Defender came on, with the image\'s exclusions removed, but was not so when the readings taken with it ended (' + endGaps.join(', ') + ')';
  else {
    const own = listOf(runner.paths).length || listOf(runner.processes).length ? ', the runner\'s own processes and folder alone excluded' : '';
    words = 'Defender\'s real-time monitoring on, scanning on access, in its Normal mode, the image\'s exclusions of C:\\ and D:\\ removed' + own + ', and still so when the readings taken with it ended';
  }
  const without = (Array.isArray(raw && raw.takes) ? raw.takes : []).map((t, i) => (t && typeof t === 'object' && t.defender === false ? i + 1 : 0)).filter(Boolean);
  if (without.length) words += '; take' + (without.length > 1 ? 's ' + without.slice(0, -1).join(', ') + ' and ' + without[without.length - 1] : ' ' + without[0]) + ' of ' + raw.takes.length + ' given no Defender record (the lane puts Defender back as the image left it before ' + (without.length > 1 ? 'them' : 'it') + ')';
  return { asked: !!d, took, stayed, on: took && stayed, words };
}

/**
 * The take that took reading `id`, as the record names it (`times[id].take`, its index in `takes`): {take (counted from
 * 1), defender: false} for one written as given no Defender record (the lane's takes after tools/defender-off.ps1); null
 * for a record that names no take for it (one take's record), an index that names no take, or a take not written so.
 */
function takenWithout(raw, id) {
  const times = raw && raw.times && typeof raw.times === 'object' ? raw.times[id] : null;
  const index = times && typeof times === 'object' ? times.take : undefined;
  const takes = raw && Array.isArray(raw.takes) ? raw.takes : [];
  if (!Number.isInteger(index) || index < 0 || index >= takes.length) return null;
  const t = takes[index];
  return t && typeof t === 'object' && t.defender === false ? { take: index + 1, defender: false } : null;
}

/**
 * Defender as reading `x` was taken: the record's (`def`), unless `x` needs Defender and the take that took it was given
 * no Defender record, which nothing the record says of Defender covers: then not on, with its words.
 */
function defenderFor(raw, x, def) {
  const t = x.defender ? takenWithout(raw, x.id) : null;
  if (!t) return def;
  return { ...def, on: false, after: true, words: 'it was taken in take ' + t.take + ', which was given no Defender record (the lane puts Defender back as the image left it before it)' };
}

const NOT_TAKEN = 'not taken by this lane';
/**
 * A reading's measurement, or why there is none: {taken, value, why}. One the lane began and never ended (`running`: it
 * stopped in it) and one cut at its own bound (`cut`) are not taken, whatever rounds they kept, which stay in the record
 * for a person to read and are never judged.
 */
function measured(raw, id) {
  const r = raw && raw.readings && typeof raw.readings === 'object' ? raw.readings[id] : undefined;
  if (r === undefined || r === null) return { taken: false, why: NOT_TAKEN };
  if (typeof r !== 'object') return { taken: false, why: 'its record is not the lane\'s' };
  if (r.running) return { taken: false, why: 'not taken: ' + String(r.running).slice(0, 120) + ', it never ended: the lane stopped in it' + (raw.stopped ? ' (' + String(raw.stopped).slice(0, 80) + ')' : '') };
  if (r.cut) return { taken: false, why: 'not taken: cut at ' + String(r.cut).slice(0, 300) };
  if (r.error) return { taken: false, why: 'it failed on the runner: ' + String(r.error).slice(0, 300) };
  if (r.skipped) return { taken: false, why: String(r.skipped).slice(0, 300) };
  return { taken: true, value: r };
}

const verdict = (state, words, facts = {}) => ({ state, words, facts });

const median = (list) => { const x = [...list].sort((a, b) => a - b); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };

/**
 * R1: the gap an upgrade makes (the stop at loopback with the proof, then the next start at once), at an empty hall and
 * at the largest real hall (20 × 10,000): the default page back, from the stop's request to its rejoin answered, at the
 * hall page's own pace. The mark is the slowest of the largest hall's rounds, ≤ 1.5 s, as R2 and R10 judge theirs, its
 * median said beside it; a round whose stop did not save, or that did not finish, is said too.
 */
function judgeR1(r) {
  const sizes = (Array.isArray(r.sizes) ? r.sizes : []).filter((x) => x && typeof x.name === 'string');
  const backs = (x) => (Array.isArray(x.rounds) ? x.rounds : []).filter((y) => y && isMs(y.pageBackMs)).map((y) => y.pageBackMs);
  const sizeWords = (x) => {
    const b = backs(x);
    const where = x.name === 'large' ? 'at ' + (x.halls || '?') + ' halls × ' + (Number.isFinite(x.messages) ? x.messages.toLocaleString('en-GB') : '?') : 'at an empty hall';
    if (!b.length) return where + ': no page back (' + String(x.error || ((x.rounds || []).find((y) => y && y.error) || {}).error || 'no round').slice(0, 200) + ')';
    return where + ': page back median ' + ms(median(b)) + ', slowest ' + ms(slowest(b)) + ' over ' + rounds(b.length);
  };
  const all = sizes.flatMap((x) => (Array.isArray(x.rounds) ? x.rounds : []));
  const unsaved = all.filter((y) => y && y.saved !== true && !y.error).length;
  const failed = all.filter((y) => y && y.error).length;
  const notes = (unsaved ? '; ' + unsaved + ' stop' + (unsaved === 1 ? '' : 's') + ' did not say it saved' : '; every stop saved') + (failed ? '; ' + failed + ' round' + (failed === 1 ? '' : 's') + ' did not finish' : '');
  const large = sizes.find((x) => x.name === 'large');
  const lb = large ? backs(large) : [];
  const facts = { sizes: sizes.map((x) => ({ name: x.name, halls: x.halls, messages: x.messages, firstMs: x.firstMs, rounds: x.rounds || [], pageBackMedianMs: backs(x).length ? median(backs(x)) : null, pageBackSlowestMs: backs(x).length ? slowest(backs(x)) : null })) };
  const what = sizes.map(sizeWords).join('; ') + notes;
  if (!lb.length) return verdict('not run', (what || 'no size was taken') + ': no page came back at the largest real hall', facts);
  const worst = slowest(lb);
  return verdict(worst <= 1500 ? 'met' : 'missed', what + (worst <= 1500 ? ' (the slowest ≤ 1.5 s at the largest)' : ' (the slowest over 1.5 s at the largest)'), facts);
}

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
  // R9 taken in a take given no Defender record is no part of R2's mark, which needs it.
  const r9Without = r9.taken && takenWithout(raw, 'R9');
  const backup = r9.taken && !r9Without ? slowest([r9.value.emptyMs, r9.value.largeMs].filter(isMs)) : Number.NaN;
  if (!Number.isFinite(backup)) return verdict('open', what + '; the mark is R2 and R9 together, and R9 ' + (r9Without ? 'was taken in take ' + r9Without.take + ', which was given no Defender record' : 'is not run'), facts);
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
  // The installer is recorded, never judged: it is unsigned by the owner's answer 36, so NotSigned is what it should say.
  const installer = r.installer && r.installer.status ? 'the installer ' + String(r.installer.status) + (r.installer.name ? ' (' + String(r.installer.name) + ')' : '') : 'the installer not read (' + String((r.installer && r.installer.why) || 'its job built none for this run') + ')';
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

/**
 * R8: may a standard account make a folder at C:\ or in %ProgramData%, and read the server task's and a control task's
 * definitions (each as app/machine.js writes it, its own descriptor read back): the server task's no standard account,
 * a control task's the one account it is for and no other.
 */
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
  // U12's server task's definition, as app/machine.js writes it: whether a standard account may read it, by its descriptor.
  const def = r.serverTask && typeof r.serverTask === 'object' ? r.serverTask : {};
  if (def.sddl) {
    const read = holds(daclOf(def.sddl), STANDARD_ACCOUNT, READ_DATA);
    facts.serverTask = { sddl: String(def.sddl).slice(0, 400), read: read.answer, by: read.by, secret: def.secret === true };
    found.push('the server task\'s definition: a standard account ' + (read.answer === 'yes' ? 'may read it (' + read.by + ')' : read.answer === 'refused' ? 'is refused it (' + read.by + ')' : 'may not read it') + (def.secret === true ? ', and a secret is in it' : ', and no secret is in it'));
  } else {
    facts.serverTask = { error: def.error ? String(def.error).slice(0, 300) : 'not read' };
    found.push('the server task\'s definition was not read (' + facts.serverTask.error + ')');
  }
  // U17's control task's definition, for one account: that account may read and run it, a standard account's groups not.
  const ctl = r.controlTask && typeof r.controlTask === 'object' ? r.controlTask : {};
  if (ctl.sddl && /^S-1-[0-9-]+$/.test(String(ctl.sid || ''))) {
    const aces = daclOf(ctl.sddl);
    const other = holds(aces, STANDARD_ACCOUNT, READ_DATA);
    const own = holds(aces, [ctl.sid], READ_DATA);
    const runs = holds(aces, [ctl.sid], EXECUTE);
    facts.controlTask = { sddl: String(ctl.sddl).slice(0, 400), sid: ctl.sid, read: other.answer, by: other.by, itsAccount: own.answer, itsAccountRuns: runs.answer, itsAccountBy: own.by, secret: ctl.secret === true };
    // The account by the name its descriptor gives it, where that is not its SID (LA: the runner's own account).
    const named = own.answer === 'yes' && own.by && own.by !== ctl.sid ? ' (' + own.by + ', in its descriptor)' : '';
    found.push('a control task\'s definition: the account it is for' + named + ' ' + (own.answer === 'yes' && runs.answer === 'yes' ? 'may read and run it' : 'may not read and run it') + ', another standard account ' + (other.answer === 'yes' ? 'may read it (' + other.by + ')' : 'may not') + (ctl.secret === true ? ', and a secret is in it' : ', and no secret is in it'));
  } else {
    facts.controlTask = { error: ctl.error ? String(ctl.error).slice(0, 300) : 'not read' };
    found.push('a control task\'s definition was not read (' + facts.controlTask.error + ')');
  }
  return verdict('recorded', found.join('; '), facts);
}

/**
 * R11: a control task whose descriptor gives one standard account read and execute, as app/machine.js registers it: that
 * account runs it with schtasks /run (its run's exit code 0 and the control task's answer to its request, written as
 * SYSTEM for that account's SID: `ranAs` and `for`), a second standard account is refused (its run's exit code not 0, and
 * no answer to the request left for it). Met at 10 of 10 each; a round the lane could not take is said.
 */
function judgeR11(r) {
  const own = (Array.isArray(r.own) ? r.own : []).filter((x) => x && typeof x === 'object');
  const other = (Array.isArray(r.other) ? r.other : []).filter((x) => x && typeof x === 'object');
  const sid = String(r.sid || '');
  const facts = { sid, own, other, controlTask: String(r.controlTask || '') };
  if (!own.length || !other.length) return verdict('not run', 'the lane took no round ' + (!own.length ? 'for the account the control task is for' : 'for the second account') + (r.why ? ' (' + String(r.why).slice(0, 200) + ')' : ''), facts);
  // A round whose task as the account never reported its run measured nothing of the control task: the lane's, not run.
  const untaken = [...own, ...other].find((x) => x.code === null || x.code === undefined);
  if (untaken) return verdict('not run', 'a run as a standard account was not taken: ' + String(untaken.err || 'no exit code').slice(0, 200), facts);
  const ran = own.filter((x) => x.code === 0 && x.answered === true && x.ranAs === 'S-1-5-18' && x.for === sid).length;
  const refused = other.filter((x) => x.code !== 0 && x.answered !== true).length;
  const words = 'the account it is for ran it ' + ran + ' of ' + own.length + ' times, each answered as SYSTEM for its SID; a second standard account was refused ' + refused + ' of ' + other.length + ' times';
  const firstBad = own.find((x) => !(x.code === 0 && x.answered === true && x.ranAs === 'S-1-5-18' && x.for === sid));
  const why = firstBad ? ' (a round that did not: exit ' + firstBad.code + (firstBad.err ? ', ' + String(firstBad.err).slice(0, 120) : '') + (firstBad.answered ? ', answered as ' + firstBad.ranAs + ' for ' + firstBad.for : ', no answer') + ')' : '';
  return verdict(ran === 10 && own.length === 10 && refused === 10 && other.length === 10 ? 'met' : 'missed', words + why, facts);
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

/**
 * R6 (U14 landed): what a runner takes of it. The export as a standard account into its own import folder (its exit code
 * and the words it left there), and the elevated import's take of that bundle (verified or not); an elevated read of that
 * account's %LOCALAPPDATA%\AGMessage; and whether Windows let that account write again a file it made in its inbox (whose
 * grants are the import folder's), which is said beside them and never judged. The two readings of the account that
 * started Setup need a desktop where an administrator approves another account's elevation, which no runner has, so the
 * mark is never judged here: open when the export and the take both did their part, missed when either did not.
 */
function judgeR6(r) {
  const ex = r.export && typeof r.export === 'object' ? r.export : null;
  const facts = { sid: String(r.sid || ''), stage: r.stage || null, export: ex, take: r.take || null, profileRead: r.profileRead || null };
  if (r.stage && r.stage.code !== 0) return verdict('missed', 'the import was not made ready for a standard account (machine.js import --step stage ended with ' + r.stage.code + ': ' + String(r.stage.words || '').slice(0, 200) + ')', facts);
  if (!ex || !Number.isInteger(ex.code)) return verdict('not run', 'the export as a standard account was not taken' + (ex && ex.err ? ' (' + String(ex.err).slice(0, 200) + ')' : r.why ? ' (' + String(r.why).slice(0, 200) + ')' : ''), facts);
  const exported = ex.code === 0;
  const taken = !!(r.take && r.take.verified === true);
  const read = r.profileRead && r.profileRead.ok === true ? 'read the file it made' : 'was refused (' + String((r.profileRead && r.profileRead.code) || 'not asked') + ')';
  const words = 'the export, run as a standard account, ' + (exported ? 'wrote its bundle into its own import folder' : 'did not: ' + String(ex.words || 'no words').slice(0, 200))
    + '; the elevated import ' + (taken ? 'read and verified it' : 'did not take it' + (r.take ? ': ' + String(r.take.words || '').slice(0, 200) : ''))
    + '; an elevated read of that account\'s %LOCALAPPDATA%\\AGMessage ' + read
    + reopenWords(ex.reopen)
    + '. The two readings of the account that started Setup need an administrator approving another account\'s elevation at a desktop, which no runner has: the show laptop\'s';
  return verdict(exported && taken ? 'open' : 'missed', words, facts);
}

/** What a standard account met writing a file it made a second time (R6's `reopen`), as words after R6's own; '' with none. */
function reopenWords(re) {
  if (!re || typeof re !== 'object') return '';
  const said = (v) => (v === 'written' ? 'let through' : 'refused (' + String(v || 'no answer').slice(0, 60) + ')');
  if (re.first !== 'written') return '; a file of its own in its inbox was not made (' + String(re.first || 'no answer').slice(0, 60) + ')';
  return '; a file it made in its inbox, written again: ' + said(re.again);
}

/**
 * R13's offline half (pure): the words the bundle's own check showed with its node.exe kept off the network, or why
 * they were not taken; the outbound rule not holding (GitHub answered) is said, never taken for the words.
 */
function offlineWords(off) {
  if (!off || typeof off !== 'object') return 'with no network, not taken';
  if (off.why === 'offline') return 'with no network, the words: "' + String(off.words || '').slice(0, 300) + '" (' + String(off.error || 'no answer').slice(0, 60) + ')';
  if (off.why) return 'with no network, not taken: the outbound rule did not keep GitHub away (' + (off.status ? 'HTTP ' + off.status : String(off.error || 'no answer').slice(0, 60)) + ')';
  return 'with no network, not taken (' + String(off.error || 'no record').slice(0, 200) + ')';
}
/** R13: GitHub's release answer read from a SYSTEM task, and with no network the words a checked upgrade shows (U18). */
function judgeR13(r) {
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const off = r.offline && typeof r.offline === 'object' ? { why: String(r.offline.why || ''), words: String(r.offline.words || '').slice(0, 400), error: String(r.offline.error || '').slice(0, 200), status: Number(r.offline.status) || 0 } : null;
  const facts = { tag: r.tag || '', status: r.status, immutable: r.immutable, assets, ms: r.ms, failure: r.failure || '', offline: off };
  if ((r.status === 403 || r.status === 429) && r.rateRemaining === 0) return verdict('not run', 'GitHub refused this runner\'s address for its rate limit (HTTP ' + r.status + '), which says nothing of the show laptop\'s', facts);
  if (r.status !== 200) return verdict('missed', 'GitHub\'s answer was not read from the SYSTEM task (' + (r.status ? 'HTTP ' + r.status : String(r.failure || 'no answer')) + ')', facts);
  const digests = assets.filter((a) => a && /^sha256:[0-9a-f]{64}$/.test(String(a.digest || ''))).length;
  const imm = r.immutable === true ? 'immutable' : r.immutable === false ? 'not immutable (published while the repository\'s immutable releases were off: its owner turns them on, Settings, the Releases section)' : 'no `immutable` in the answer';
  return verdict('recorded', 'read in ' + ms(r.ms) + ': ' + (r.tag || 'the release') + ' ' + imm + ', ' + digests + ' of ' + assets.length + ' assets with a SHA-256 digest; ' + offlineWords(off), facts);
}

/**
 * R9 (U12 landed): the upgrade backup's time, beside R2. The server's own stop for an upgrade backs the data folder up
 * for the way back; last-stop.json names the time it took (`backupMs`). Recorded, naming each size's time.
 */
function judgeR9(r) {
  const sizes = Array.isArray(r.sizes) ? r.sizes : [];
  const took = sizes.filter((s) => isMs(s.backupMs));
  const facts = { sizes, emptyMs: r.emptyMs, largeMs: r.largeMs };
  if (!took.length) {
    const why = sizes.map((s) => s.name + ': ' + (s.error ? String(s.error).slice(0, 120) : s.saved === false ? 'the stop did not save, so no backup' : 'no backup time')).join('; ');
    return verdict('not run', 'the upgrade\'s stop backed up no folder for the way back' + (why ? ' (' + why + ')' : ''), facts);
  }
  const words = took.map((s) => s.name + ' ' + ms(s.backupMs) + (s.saved ? ', saved' : ', not saved')).join('; ');
  return verdict('recorded', 'the upgrade backup\'s time: ' + words + ' (beside R2)', facts);
}

/**
 * R3′ (U12 landed): the server task's stop and its end. A stand-in server task runs launch.js serve (U12's action); each
 * round it serves, is stopped at loopback with the proof, and ends with 0 saved, the task staying stopped. 10 of 10 the
 * mark. The give-up and configuration refusal ending the task with 0 are launch.js serve's exit mapping, held on Linux.
 */
function judgeR3prime(r) {
  const list = Array.isArray(r.rounds) ? r.rounds : [];
  if (!list.length) return verdict('not run', 'the stand-in server task did not run');
  const saved = list.filter((x) => x && x.saved === true && x.lastResult === 0).length;
  const facts = { rounds: list, savedCount: r.savedCount, of: list.length };
  const failing = list.map((x, i) => ({ x, i })).filter(({ x }) => !(x && x.saved === true && x.lastResult === 0));
  if (saved >= 10) return verdict('recorded', saved + ' of ' + list.length + ' stopped at loopback, saved and ended the task with 0, staying stopped', facts);
  const first = failing[0];
  // A round names what its stop met: one never asked (no proof within its time) or not answered 200 says that, with
  // machinewire's or the server's words; else what the task and last-stop.json said; and an instance the lane ended.
  const roundWhy = (x) => {
    if (!x) return 'no record';
    if (x.error) return x.error;
    const st = x.stop && typeof x.stop === 'object' ? x.stop : null;
    const said = st && st.status !== 200 ? 'the stop was not taken (' + (st.why || st.status || 'no answer') + (st.words ? ': ' + st.words : '') + ')' : 'saved ' + !!x.saved + ', last result ' + x.lastResult + ', state ' + (x.state || '?');
    return said + (x.endedByLane ? ', ended by the lane' : '');
  };
  const why = first ? 'round ' + (first.i + 1) + ': ' + roundWhy(first.x) : '';
  return verdict('missed', saved + ' of ' + list.length + ' saved: the release notes name the failing case (' + why + ')', facts);
}

const JUDGES = { R1: judgeR1, R2: judgeR2, 'R3′': judgeR3prime, R4: judgeR4, R5: judgeR5, R6: judgeR6, R7: judgeR7, R8: judgeR8, R9: judgeR9, R10: judgeR10, R11: judgeR11, R12: judgeR12, R13: judgeR13 };

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
      const why = reading.needs && !judgeOne ? 'needs ' + reading.needs.join('; ') : cutShort && m.why === NOT_TAKEN ? 'not taken: the lane ended before it (' + (r.stopped ? 'stopped by ' + String(r.stopped).slice(0, 80) : 'cut short') + ')' : m.why;
      return { ...base, ...verdict('not run', why) };
    }
    // A reading that needs Defender is judged against it only when the take that took it was given its record; one taken
    // in a take given none is never met, recorded or open: not run, unless it missed its mark anyway.
    const its = defenderFor(r, reading, def);
    let v;
    try { v = judgeOne(m.value, r, its); } catch (e) { v = verdict('not run', 'its record could not be read (' + e.message + ')'); }
    if (its.after && v.state !== 'missed' && v.state !== 'not run') v = verdict('not run', v.words + ', but ' + its.words + ': not the reading its mark needs', v.facts);
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

// ---------------------------------------------------------------- the show laptop's readings (the plan's Part 5 §13.4)

/** The ids of the show laptop's readings, as docs/DESIGN.md's table "Measured on the show laptop" numbers them. */
const LAPTOP_IDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/**
 * What a Measured cell of that table says, as the paper's own words define them: "not measured", or a person's record of
 * a day and a build ending in its verdict: "— triggers" (its Then is a 0.6.x unit), "— within its threshold", or
 * "— recorded" (reading 0, which has no threshold). Anything else is a record whose verdict is not written.
 */
const LAPTOP_RECORD = /^\d{4}-\d{2}-\d{2}, build \S+: .+ — (triggers|within its threshold|recorded)\.?$/;
function laptopState(measured) {
  if (/^not measured$/i.test(measured)) return 'not measured';
  const m = LAPTOP_RECORD.exec(measured);
  if (!m) return 'unjudged';
  return m[1] === 'triggers' ? 'triggered' : m[1] === 'recorded' ? 'recorded' : 'within';
}

/**
 * The rows of docs/DESIGN.md's "Measured on the show laptop" table, each {id, reading, threshold, then, measured, state},
 * in the paper's order; null when the section or its table cannot be found (pure). A row's cells split at each pipe a
 * cell does not escape.
 */
function laptopReadings(designText) {
  const lines = String(designText || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Measured on the show laptop\s*$/.test(l));
  if (start < 0) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const cells = lines[i].split(/(?<!\\)\|/);
    if (cells.length !== 8 || cells[0] !== '' || cells[7].trim() !== '') continue;
    const [id, reading, , threshold, then, measured] = cells.slice(1, 7).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (!LAPTOP_IDS.includes(id)) continue;
    rows.push({ id, reading, threshold, then, measured, state: laptopState(measured) });
  }
  return rows.length ? rows : null;
}

/**
 * The release notes' words on the show laptop's readings, as docs/DESIGN.md records them when the tag is built: each that
 * triggered its change, named with that change (a 0.6.x unit, never this release's); each recorded within its threshold;
 * each recorded with no verdict written; and those not measured, of which nothing is claimed. A paper that cannot be read
 * is said, and nothing is claimed for any of them (pure).
 */
function laptopNotes(designText) {
  const out = ['### The show laptop\'s readings', ''];
  const rows = laptopReadings(designText);
  if (!rows) {
    out.push('The show laptop\'s readings could not be read from `docs/DESIGN.md` (Measured on the show laptop): nothing is claimed for them. They inform the release and never hold it.');
    return out.join('\n') + '\n';
  }
  out.push('Readings 0-9 of the 0.6.0 plan (Part 5 §13.4), as `docs/DESIGN.md` (Measured on the show laptop) records them: each is read on the show laptop after a show or a rehearsal, and only a recorded number is written there. They inform the release and never hold it.');
  out.push('');
  const by = (state) => rows.filter((x) => x.state === state);
  const named = (x) => x.id + ' (' + x.reading + ')';
  const triggered = by('triggered');
  const none = rows.every((x) => x.state === 'not measured');
  out.push(triggered.length ? '**Triggered their change** (each change a 0.6.x unit, not in this release):' : none ? '**No reading is measured yet, so none has triggered its change.**' : '**No reading recorded has triggered its change.**');
  for (const x of triggered) out.push('- ' + named(x) + ': ' + x.measured + '. Threshold: ' + x.threshold + '. So: ' + x.then + '.');
  const kept = [...by('within'), ...by('recorded')];
  if (kept.length) out.push('', '**Recorded, within its threshold or with none:** ' + kept.map((x) => named(x) + ': ' + x.measured).join('; ') + '.');
  const unjudged = by('unjudged');
  if (unjudged.length) out.push('', '**Recorded, its verdict not written:** ' + unjudged.map((x) => named(x) + ': ' + x.measured).join('; ') + '.');
  const notMeasured = by('not measured');
  if (notMeasured.length) out.push('', '**Not measured:** ' + notMeasured.map(named).join('; ') + ': nothing is claimed for ' + (notMeasured.length === 1 ? 'it' : 'them') + ', and nothing ' + (notMeasured.length === 1 ? 'it' : 'they') + ' would trigger is in this release.');
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
  if (verb === 'laptop') {
    if (positional.length) { console.error('readings: laptop [--design <docs/DESIGN.md>]'); return 64; }
    // Whatever the paper holds, the notes are written and this exits 0: the readings inform the release, never hold it.
    let design = '';
    try { design = fs.readFileSync(flag('--design') || path.join(ROOT, 'docs', 'DESIGN.md'), 'utf8'); } catch { /* no paper: the notes say the readings could not be read */ }
    process.stdout.write(laptopNotes(design));
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
  console.error('readings: judge <raw.json> --out <readings.json> [--summary <file.md>] | notes [<readings.json>] [--install <file>] | laptop [--design <file>] | record <readings.json> [--install <file>]');
  return 64;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  READINGS, LABS, STATES, MARKS, SID_NAMES, STANDARD_ACCOUNT,
  rightsMask, daclOf, holds, csvRows, privilegesOf, sidsOf, taskSidOf, ruleFields,
  defenderOf, defenderGaps, defenderFor, takenWithout, stampFull, judge, summary, notes, labRecord, isJudged, recordInstall, main,
  LAPTOP_IDS, LAPTOP_RECORD, laptopReadings, laptopNotes,
};
