'use strict';
/**
 * "This laptop" on the admin page: what AGMessage knows of the laptop it serves from, and what Windows says of it, each
 * fact with where it was read (tested in test/laptop.test.js).
 *
 *   windowsPlan    how Windows is asked: one powershell.exe, by its absolute path under SystemRoot, running SCRIPT, a fixed
 *                  script that takes nothing from a page, in an environment of named system folders only (PASSED); on
 *                  any other system, or without a SystemRoot named from its drive, nothing is run and every Windows fact
 *                  reads unknown with why
 *   readWindows    runs the plan once, within its time (5 s): its output, what it said before its time ran out included,
 *                  and why it said no more; never rejects
 *   windowsFacts   that output read by type, part by part, as each line came: each part read, or unknown with why;
 *                  never a value it did not check
 *   facts          the panel's rows, each a label, its words, a mark (ok, warn, fault, off, or none) and where it was read
 *
 * The laptop's admin and the rights given are read from the install record (HKLM\SOFTWARE\AGMessage: `Admin`,
 * `AdminName`, and under `Grants` one value per account's SID, its rights as a comma-separated list), the names each
 * account has now looked up by Windows where it can. They reach the admin page's answer only: never the context, the hello
 * or the AI's brief, since a Windows account's name is not the show network's business.
 */
const childProcess = require('child_process');
const path = require('path');
const { cleanText } = require('./guard');

/** How long Windows has to answer, in ms: the child is ended then, and each fact reads unknown. */
const WINDOWS_MS = 5000;
/** The most of an answer that is read; one larger is no answer. */
const ANSWER_MAX = 256 * 1024;
/** A Windows folder named from its drive: SystemRoot is never taken relative to wherever this copy runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;
/**
 * The only names of this server's environment the child is handed: Windows' own folders and the machine's names, which
 * powershell.exe and the cmdlets it loads read. Nothing else is passed, so no secret, whatever the case of its name (a
 * Windows environment's names are read in any case), and no module path of the account's own: its module path is
 * Windows' own (System32\WindowsPowerShell\v1.0\Modules), so the cmdlets it loads are the ones Windows ships.
 */
const PASSED = ['SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
/** The most firewall rules naming this node.exe that are judged; more, and its reach is unknown rather than guessed. */
const RULES_MAX = 512;
/** The most networks and rights given that are listed; the rest are counted. */
const LISTED_MAX = 32;

/**
 * The script, one line, single quotes only (no double quote, which a command line would have to escape). Each part is
 * read on its own and said as soon as it is read, on a line of its own ({"v":1} first, then {"<part>": …}), the cheap
 * ones first and the firewall's rules last, so a read ended at its time keeps every part said before it; a part Windows
 * refuses says why (its error's reason, else its message) while the others are read. Each line is JSON in ASCII: any
 * other character is written \uXXXX, so no code page can change a name. Under Constrained Language Mode the account names
 * of the grants stay unread (their SIDs are said).
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
function Why($e) { $r = [string]$e.CategoryInfo.Reason; if ($r -eq 'RuntimeException' -or -not $r) { $r = [string]$e.Exception.Message }; return $r };
function Gone($e) { return ([string]$e.CategoryInfo.Category -eq 'ObjectNotFound') };
function Ascii($j) { return (-join @(foreach ($c in $j.ToCharArray()) { if ([int]$c -gt 126) { '\u{0:x4}' -f [int]$c } else { [string]$c } })) };
function Say($k, $v) { $h = @{}; $h[$k] = $v; return (Ascii (ConvertTo-Json -InputObject $h -Depth 5 -Compress)) };
function Ac($sub, $set) {
  $out = & ($env:SystemRoot + '\System32\powercfg.exe') /query SCHEME_CURRENT $sub $set;
  if ($LASTEXITCODE -ne 0) { throw ('powercfg ended with ' + $LASTEXITCODE) };
  $m = @($out | Select-String -Pattern '0x[0-9a-fA-F]{8}' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value });
  if ($m.Count -lt 2) { throw 'powercfg named no value' };
  return [int64]$m[$m.Count - 2]
};
Say 'v' 1;
try { $v = Ac 'SUB_SLEEP' 'STANDBYIDLE' } catch { $v = @{ error = (Why $_) } };
Say 'standbyAc' $v;
try { $v = Ac 'SUB_BUTTONS' 'LIDACTION' } catch { $v = @{ error = (Why $_) } };
Say 'lidAc' $v;
try {
  $t = Get-ScheduledTask -TaskPath '\AGMessage\' -TaskName 'Server';
  $i = Get-ScheduledTaskInfo -TaskPath '\AGMessage\' -TaskName 'Server';
  $v = @{ state = [string]$t.State; lastResult = [int64]$i.LastTaskResult; lastRun = $(if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }) }
} catch { if (Gone $_) { $v = @{ missing = $true } } else { $v = @{ error = (Why $_) } } };
Say 'task' $v;
try {
  $r = Get-ItemProperty -Path 'HKLM:\SOFTWARE\AGMessage';
  $rec = @{ admin = [string]$r.Admin; adminName = [string]$r.AdminName; grants = @() };
  try {
    $g = Get-ItemProperty -Path 'HKLM:\SOFTWARE\AGMessage\Grants';
    foreach ($p in $g.PSObject.Properties) {
      if ($p.Name -like 'S-1-*') {
        $n = '';
        try { $n = ([System.Security.Principal.SecurityIdentifier]$p.Name).Translate([System.Security.Principal.NTAccount]).Value } catch { $n = '' };
        $rec.grants += @{ sid = [string]$p.Name; name = [string]$n; rights = [string]$p.Value }
      }
    }
  } catch { if (-not (Gone $_)) { $rec.grantsError = (Why $_) } };
  $v = $rec
} catch { if (Gone $_) { $v = @{ missing = $true } } else { $v = @{ error = (Why $_) } } };
Say 'record' $v;
try { $v = @(Get-NetConnectionProfile | ForEach-Object { @{ name = [string]$_.Name; alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } }) } catch { $v = @{ error = (Why $_) } };
Say 'network' $v;
try {
  $f = @();
  try { $f = @(Get-NetFirewallApplicationFilter -Program $env:AGM_NODE) } catch { if (-not (Gone $_)) { throw } };
  $v = @();
  if ($f.Count -gt 0) { $v = @($f | Get-NetFirewallRule | ForEach-Object { @{ name = [string]$_.DisplayName; enabled = ([string]$_.Enabled -eq 'True'); direction = [string]$_.Direction; action = [string]$_.Action; profile = [string]$_.Profile } }) }
} catch { $v = @{ error = (Why $_) } };
Say 'rules' $v
`.trim().replace(/\s*\n\s*/g, ' ');

/**
 * How Windows is asked here: {run: true, file, args, options} for powershell.exe by its absolute path in System32, from
 * that folder, hidden, its environment SystemRoot, the names PASSED that this server's has, Windows' own module path and
 * this node.exe's path (`node`, AGM_NODE) for the firewall's rules, and nothing else; or {run: false, why}: not Windows,
 * or no SystemRoot named from its drive (pure).
 */
function windowsPlan(env, { platform = process.platform, node = process.execPath } = {}) {
  if (platform !== 'win32') return { run: false, why: 'AGMessage is not running on Windows' };
  const root = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (!DRIVE_PATH.test(root)) return { run: false, why: 'SystemRoot does not name the Windows folder, so powershell.exe has no path to run from' };
  const sys = path.win32.join(root, 'System32');
  const childEnv = { SystemRoot: root };
  for (const name of PASSED) if (typeof env[name] === 'string' && env[name]) childEnv[name] = env[name];
  childEnv.PSModulePath = path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules');
  childEnv.AGM_NODE = node;
  return {
    run: true,
    file: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', SCRIPT],
    options: { cwd: sys, windowsHide: true, env: childEnv },
  };
}

/**
 * The plan run once, within `timeoutMs`: resolves {text, why}, `text` its output and `why` '' when it answered; a child
 * ended at its time keeps what it said before (`text`), with why it said no more; else '' and the words of why not (it
 * could not be run, its answer was too large). Never rejects.
 * `run` is child_process.execFile unless a test stands in for it; `started(child)` is given the child while it runs, so
 * a server that stops ends it.
 */
function readWindows(plan, { timeoutMs = WINDOWS_MS, run = childProcess.execFile, started = () => {} } = {}) {
  return new Promise((resolve) => {
    const failed = (e) => resolve({ text: '', why: 'powershell.exe could not be run (' + ((e && (e.code || e.message)) || 'unknown error') + ')' });
    try {
      started(run(plan.file, plan.args, { ...plan.options, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: ANSWER_MAX, encoding: 'utf8' }, (err, stdout) => {
        if (err && err.killed) resolve({ text: String(stdout || ''), why: 'Windows did not answer within ' + Math.round(timeoutMs / 1000) + ' s' });
        else if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ text: '', why: 'Windows\' answer was larger than AGMessage reads' });
        else if (err && typeof err.code === 'string') failed(err);
        else resolve({ text: String(stdout || ''), why: '' });   // an end that is not 0 with an answer: its answer is read
      }));
    } catch (e) { failed(e); }
  });
}

/** A part Windows could not read: unknown, with why. */
const unknown = (why) => Object.freeze({ ok: false, why: cleanText(why, 160) || 'not read' });
/** A part that says it could not be read: its own reason. */
const refused = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string' ? unknown('Windows said: ' + v.error) : null);
const str = (v, max = 120) => (typeof v === 'string' ? cleanText(v, max) : '');
const PARTS = ['network', 'rules', 'standbyAc', 'lidAc', 'task', 'record'];
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The script's lines read into one answer: its first line {"v":1}, then each part's own; only the parts' names are taken,
 * and a line that is not JSON (one cut short as the child was ended) is passed over. Null when the first line is not the
 * script's (pure).
 */
function answerOf(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const read = (l) => { try { return JSON.parse(l); } catch { return null; } };
  const first = lines.length ? read(lines[0]) : null;
  if (!isObject(first) || first.v !== 1) return null;
  const out = Object.create(null);
  for (const o of lines.map(read)) if (isObject(o)) for (const p of PARTS) if (Object.prototype.hasOwnProperty.call(o, p)) out[p] = o[p];
  return out;
}

/**
 * The script's answer ({text, why}), read by type, part by part: {network, rules, standbyAc, lidAc, task, record}, each
 * {ok: true, …} or unknown with why. An answer that is not the script's (no first line of its own) is unknown in every
 * part, with why it said nothing (`why`) where there is one; a part it did not say is unknown alone, with why (the child
 * ended at its time, or not in its answer), and so is a part that is not of its type (pure).
 */
function windowsFacts(answer) {
  const all = (why) => Object.freeze(Object.fromEntries(PARTS.map((p) => [p, unknown(why)])));
  if (!answer || typeof answer.text !== 'string') return all('not read yet');
  const j = answerOf(answer.text);
  if (!j) return all(answer.why || 'Windows\' answer could not be read');
  const missing = unknown(answer.why || 'not in Windows\' answer');
  // A list read by type, the first `max` kept and the rest counted (`more`); null when it is not a list.
  const list = (v, each, max = LISTED_MAX) => {
    if (!Array.isArray(v)) return null;
    const items = v.filter(isObject);
    return { items: items.slice(0, max).map(each), more: Math.max(0, items.length - max) };
  };
  const num = (v) => refused(v) || (Number.isSafeInteger(v) && v >= 0 ? Object.freeze({ ok: true, value: v }) : missing);
  const net = list(j.network, (n) => Object.freeze({ name: str(n.name), alias: str(n.alias), category: str(n.category, 40) }));
  const network = refused(j.network) || (net ? Object.freeze({ ok: true, list: Object.freeze(net.items), more: net.more }) : missing);
  // Every rule is judged, never the first few: a block rule past them would otherwise read as allowed.
  const fw = list(j.rules, (r) => Object.freeze({ name: str(r.name), enabled: r.enabled === true, direction: str(r.direction, 20), action: str(r.action, 20), profile: str(r.profile, 60) }), RULES_MAX);
  const rules = refused(j.rules) || (!fw ? missing
    : fw.more ? unknown('more than ' + RULES_MAX + ' rules name this node.exe, more than AGMessage reads')
      : Object.freeze({ ok: true, list: Object.freeze(fw.items) }));
  let task = refused(j.task) || missing;
  if (j.task && typeof j.task === 'object' && j.task.missing === true) task = Object.freeze({ ok: true, missing: true });
  else if (j.task && typeof j.task === 'object' && typeof j.task.state === 'string' && Number.isSafeInteger(j.task.lastResult)) {
    task = Object.freeze({ ok: true, missing: false, state: str(j.task.state, 40), lastResult: j.task.lastResult, lastRun: str(j.task.lastRun, 40) });
  }
  let record = refused(j.record) || missing;
  if (j.record && typeof j.record === 'object' && j.record.missing === true) record = Object.freeze({ ok: true, missing: true });
  else if (j.record && typeof j.record === 'object' && !j.record.error) {
    const each = (g) => Object.freeze({ sid: str(g.sid, 80), name: str(g.name), rights: str(g.rights, 80) });
    const given = (Array.isArray(j.record.grants) ? j.record.grants.filter(isObject).map(each) : []).filter((g) => /^S-1-[0-9-]+$/.test(g.sid));
    record = Object.freeze({
      ok: true, missing: false, admin: str(j.record.admin, 80), adminName: str(j.record.adminName),
      grants: Object.freeze(given.slice(0, LISTED_MAX)), grantsMore: Math.max(0, given.length - LISTED_MAX),
      grantsWhy: typeof j.record.grantsError === 'string' ? 'Windows said: ' + cleanText(j.record.grantsError, 120) : '',
    });
  }
  return Object.freeze({ network, rules, standbyAc: num(j.standbyAc), lidAc: num(j.lidAc), task, record });
}

/** A network's category as Windows names it, in its firewall profile's word. */
const PROFILE_OF = { Public: 'Public', Private: 'Private', DomainAuthenticated: 'Domain' };
/** The lid's action on mains, by its power setting's index. */
const LID = ['do nothing', 'sleep', 'hibernate', 'shut down'];
const RANK = { '': 0, off: 1, ok: 2, warn: 3, fault: 4 };
/** The worst of marks: a row of several says the one that needs most. */
const worst = (marks) => marks.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), '');

/**
 * Whether this node.exe may be reached on networks of a firewall profile, by its rules ({name, enabled, direction, action,
 * profile}): a block rule that covers it wins over an allow rule, as the firewall's own order says; inbound and enabled
 * only. 'blocked', 'allowed' or 'none' (pure).
 */
function reach(rules, profile) {
  const covers = (r) => r.enabled && r.direction === 'Inbound' && (r.profile === 'Any' || r.profile.split(/,\s*/).includes(profile));
  if (rules.some((r) => covers(r) && r.action === 'Block')) return 'blocked';
  return rules.some((r) => covers(r) && r.action === 'Allow') ? 'allowed' : 'none';
}

/** A row: its id, label, words, mark and where it was read. */
const row = (id, label, words, mark, from) => Object.freeze({ id, label, words, mark, from });
/** A Windows part that could not be read: its row reads unknown, with why. */
const unknownRow = (id, label, part, from) => row(id, label, 'unknown (' + part.why + ')', '', from);

/**
 * The panel's rows, from what this server knows (`k`) and what Windows said (`w`, windowsFacts's), in the panel's order
 * (pure). `k`: {build, runs, addresses, port, https: {on, fingerprint, validTo, off, renewal, file}, sealed: {total, open,
 * keyWords}, screens: {total, shown, offline}, stagewatch: {total, connected}, tunnel: {running, url, error}, before,
 * without: [words], node}.
 */
function facts(k, w) {
  const rows = [];
  rows.push(row('build', 'AGMessage', k.build + ' · ' + (k.runs === 'task' ? 'installed: a Windows task starts it with Windows' : 'the portable folder'), '', 'this server'));
  rows.push(k.addresses.length
    ? row('addresses', 'Addresses', k.addresses.map((a) => 'http://' + a + ':' + k.port).join(' · '), '', 'this laptop\'s network adapters, read now')
    : row('addresses', 'Addresses', 'none now: no device can reach this laptop; on it, http://localhost:' + k.port, 'warn', 'this laptop\'s network adapters, read now'));
  const h = k.https;
  rows.push(h.on
    ? row('https', 'HTTPS', 'on · certificate ' + h.fingerprint.replace(/^sha256:/, '').slice(0, 16) + '… until ' + h.validTo + (h.renewal ? ' · ' + h.renewal : ''), h.renewal ? 'warn' : 'ok', 'the certificate in ' + h.file)
    : row('https', 'HTTPS', 'off: ' + h.off, h.off.startsWith('AGM_TLS=0') ? 'off' : 'warn', 'the certificate in ' + h.file));
  const s = k.sealed;
  rows.push(!s.total ? row('sealed', 'Sealed values', 'none kept', '', 'the data folder\'s settings and screens')
    : s.keyWords ? row('sealed', 'Sealed values', 'none of ' + s.total + ' open: ' + s.keyWords, 'fault', 'the data folder\'s settings and screens, opened with this laptop\'s machine key')
      : row('sealed', 'Sealed values', s.open + ' of ' + s.total + ' open', s.open === s.total ? 'ok' : 'warn', 'the data folder\'s settings and screens, opened with this laptop\'s machine key'));
  const sc = k.screens;
  rows.push(!sc.total ? row('screens', 'Screens', 'none in any hall', '', 'each screen\'s own confirmation of its newest take')
    : row('screens', 'Screens', sc.shown + ' of ' + sc.total + ' confirmed what they show' + (sc.offline ? ' · ' + sc.offline + ' offline' : ''), sc.shown === sc.total ? 'ok' : 'warn', 'each screen\'s own confirmation of its newest take'));
  const sw = k.stagewatch;
  rows.push(!sw.total ? row('stagewatch', 'Stagewatch', 'not linked', 'off', 'the Stagewatch links this AGMessage keeps')
    : row('stagewatch', 'Stagewatch', sw.connected === sw.total ? (sw.total === 1 ? 'connected' : 'all ' + sw.total + ' links connected') : sw.connected + ' of ' + sw.total + ' links connected', sw.connected === sw.total ? 'ok' : 'warn', 'the Stagewatch links this AGMessage keeps'));
  const t = k.tunnel;
  rows.push(t.running ? row('tunnel', 'Internet link', t.url ? 'on: ' + t.url + ' · until it is turned off, or AGMessage stops' : 'starting', t.url ? 'ok' : '', 'cloudflared, started from this page')
    : row('tunnel', 'Internet link', t.error ? 'off: ' + t.error : 'off', t.error ? 'warn' : 'off', 'cloudflared, started from this page'));
  if (k.before) rows.push(row('before', 'Before this start', k.before, 'warn', 'the watchdog'));
  if (k.without.length) rows.push(row('without', 'Goes without', k.without.join(' · '), 'warn', 'this start\'s reads of its keys and settings'));

  // What Windows says.
  const NET = 'Windows: the network\'s profile';
  const netRow = !w.network.ok ? unknownRow('network', 'Network', w.network, NET)
    : !w.network.list.length ? row('network', 'Network', 'none connected', 'warn', NET)
      : row('network', 'Network', w.network.list.map((n) => (n.name || 'a network') + (n.alias ? ' (' + n.alias + ')' : '') + ': ' + (PROFILE_OF[n.category] || n.category || 'unknown')).join(' · ') + (w.network.more ? ' · and ' + w.network.more + ' more' : ''), '', NET);
  rows.push(netRow);
  const FW = 'Windows Firewall\'s rules for ' + k.node;
  if (!w.rules.ok) rows.push(unknownRow('firewall', 'Firewall', w.rules, FW));
  else if (!w.network.ok) rows.push(unknownRow('firewall', 'Firewall', w.network, FW));
  else {
    const profiles = [...new Set(w.network.list.map((n) => PROFILE_OF[n.category]).filter(Boolean))];
    if (!profiles.length) rows.push(row('firewall', 'Firewall', 'no network to check it on', '', FW));
    else {
      const said = profiles.map((p) => [p, reach(w.rules.list, p)]);
      const words = said.map(([p, r]) => (r === 'allowed' ? 'allowed on ' + p : r === 'blocked' ? 'a block rule on ' + p + ': phones there cannot reach AGMessage' : 'no rule for this node.exe on ' + p + ': phones there may not reach AGMessage'));
      rows.push(row('firewall', 'Firewall', words.join(' · '), worst(said.map(([, r]) => (r === 'allowed' ? 'ok' : r === 'blocked' ? 'fault' : 'warn'))), FW));
    }
  }
  const POWER = 'Windows: the power plan (powercfg)';
  rows.push(!w.standbyAc.ok ? unknownRow('sleep', 'Sleep on mains', w.standbyAc, POWER)
    : w.standbyAc.value === 0 ? row('sleep', 'Sleep on mains', 'never', 'ok', POWER)
      : row('sleep', 'Sleep on mains', 'after ' + Math.max(1, Math.round(w.standbyAc.value / 60)) + ' min idle: the laptop sleeps, and AGMessage with it', 'warn', POWER));
  rows.push(!w.lidAc.ok ? unknownRow('lid', 'Lid closed on mains', w.lidAc, POWER)
    : row('lid', 'Lid closed on mains', LID[w.lidAc.value] || 'action ' + w.lidAc.value, w.lidAc.value === 0 ? 'ok' : 'warn', POWER));
  const TASK = 'Windows: Task Scheduler (\\AGMessage\\Server)';
  rows.push(!w.task.ok ? unknownRow('task', 'The server task', w.task, TASK)
    : w.task.missing ? row('task', 'The server task', 'none: AGMessage is not installed on this PC', 'off', TASK)
      : row('task', 'The server task', w.task.state + ' · last result 0x' + (w.task.lastResult >>> 0).toString(16) + (w.task.lastRun ? ' at ' + w.task.lastRun.replace('T', ' ').slice(0, 16) + ' UTC' : ''), w.task.state === 'Running' ? 'ok' : '', TASK));
  const REC = 'Windows: the install record (HKLM\\SOFTWARE\\AGMessage)';
  if (!w.record.ok) {
    rows.push(unknownRow('admin', 'The laptop\'s admin', w.record, REC));
    rows.push(unknownRow('grants', 'Rights given', w.record, REC));
  } else if (w.record.missing) {
    rows.push(row('admin', 'The laptop\'s admin', 'none: no install record on this PC', 'off', REC));
  } else {
    rows.push(row('admin', 'The laptop\'s admin', w.record.adminName || w.record.admin || 'not named in the install record', '', REC));
    rows.push(w.record.grantsWhy ? row('grants', 'Rights given', 'unknown (' + w.record.grantsWhy + ')', '', REC)
      : row('grants', 'Rights given', w.record.grants.length ? w.record.grants.map((g) => (g.name || g.sid) + ': ' + (g.rights || 'none')).join(' · ') + (w.record.grantsMore ? ' · and ' + w.record.grantsMore + ' more' : '') : 'none given', '', REC));
  }
  return Object.freeze(rows);
}

module.exports = { windowsPlan, readWindows, windowsFacts, facts, reach, SCRIPT, WINDOWS_MS, PASSED, RULES_MAX, LISTED_MAX };
