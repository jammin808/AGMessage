'use strict';
/**
 * "This laptop" on the admin page: what AGMessage knows of the laptop it serves from, and what Windows says of it, each
 * fact with where it was read (tested in test/laptop.test.js).
 *
 *   powershellPlan how powershell.exe is run with a fixed script: by its absolute path under SystemRoot, in an
 *                  environment of named system folders only (PASSED); on any other system, or without a SystemRoot named
 *                  from its drive, nothing is run (the power request's child, lib/power.js, is run so too)
 *   windowsPlan    how Windows is asked: one powershell.exe, as powershellPlan runs it, running SCRIPT, a fixed script
 *                  that takes nothing from a page; where nothing is run every Windows fact reads unknown with why
 *   readWindows    runs the plan once, within its time (5 s): its output, what it said before its time ran out included,
 *                  and why it said no more; never rejects
 *   windowsFacts   that output read by type, part by part, as each line came: each part read, or unknown with why;
 *                  never a value it did not check
 *   facts          the panel's rows, each a label, its words, a mark (ok, warn, fault, off, or none) and where it was read:
 *                  among them the sleeps the watchdog recorded and the power request a live show holds (lib/power.js),
 *                  with what makes the halls live (liveWords, hallsWords: the power request's words too)
 *   formatRow      the data folder's row: its format, and what this start found of it (lib/dataformat.js)
 *   stopRow        the last stop's row: saved, or not and why, as the record it wrote last says and the folder bears
 *                  out (lib/laststop.js)
 *   pagesRow       the pages and screens open on another build than this one, by the build each named as it connected:
 *                  0.5's (none named) and each other build's, with when each kind reloads
 *
 * The laptop's admin and the rights given are read from the install record (HKLM\SOFTWARE\AGMessage: `Admin`,
 * `AdminName`, and under `Grants` one value per account's SID, its rights as a comma-separated list), the names each
 * account has now looked up by Windows where it can. They reach the admin page's answer only: never the context, the hello
 * or the AI's brief, since a Windows account's name is not the show network's business.
 */
const childProcess = require('child_process');
const path = require('path');
const { cleanText } = require('./guard');
const { asleepWords } = require('./resilience');

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
 * Its functions are named Agm…: PowerShell runs an alias before a function of the same name, so a function named as one
 * of Windows PowerShell's aliases (`ac` is Add-Content) runs that command instead.
 * Each module a part uses is imported by its manifest's path under $PSHOME (Windows' own, in System32), never found by
 * name: a command found by name has PowerShell look through the modules on its module path before it loads one, and
 * the module it finds could be another's. The first line needs no module, so when it comes says how long powershell.exe
 * took to start.
 * The firewall's rules naming this node.exe are read from the firewall's own object (HNetCfg.FwPolicy2), each rule's
 * program, its variables expanded, compared with this node.exe's path in any case; under Constrained Language Mode,
 * which allows no COM object, through the NetSecurity cmdlets, which fetch every application filter before they compare
 * one. Either read that fails says its own reason. A function's list is taken with @() where it is called: PowerShell
 * hands back a list of none or one as nothing or the one.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
function AgmWhy($e) { $r = [string]$e.CategoryInfo.Reason; if ($r -eq 'RuntimeException' -or -not $r) { $r = [string]$e.Exception.Message }; return $r };
function AgmGone($e) { return ([string]$e.CategoryInfo.Category -eq 'ObjectNotFound') };
function AgmAscii($j) { return (-join @(foreach ($c in $j.ToCharArray()) { if ([int]$c -gt 126) { '\u{0:x4}' -f [int]$c } else { [string]$c } })) };
function AgmUse($m) { Import-Module ($PSHOME + '\Modules\' + $m + '\' + $m + '.psd1') };
function AgmSay($k, $v) { $h = @{}; $h[$k] = $v; return (AgmAscii (ConvertTo-Json -InputObject $h -Depth 5 -Compress)) };
function AgmPower($sub, $set) {
  $out = & ($env:SystemRoot + '\System32\powercfg.exe') /query SCHEME_CURRENT $sub $set;
  if ($LASTEXITCODE -ne 0) { throw ('powercfg ended with ' + $LASTEXITCODE) };
  $m = @($out | Select-String -Pattern '0x[0-9a-fA-F]{8}' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value });
  if ($m.Count -lt 2) { throw 'powercfg named no value' };
  return [int64]$m[$m.Count - 2]
};
function AgmProfile($p) {
  $p = [int64]$p;
  if ($p -eq 0 -or ($p -band 7) -eq 7) { return 'Any' };
  $n = @();
  if ($p -band 1) { $n += 'Domain' };
  if ($p -band 2) { $n += 'Private' };
  if ($p -band 4) { $n += 'Public' };
  return ($n -join ', ')
};
function AgmRulesFast($node) {
  $fw = New-Object -ComObject 'HNetCfg.FwPolicy2';
  return @(foreach ($r in $fw.Rules) {
    $a = [string]$r.ApplicationName;
    if ($a -and [string]::Equals([Environment]::ExpandEnvironmentVariables($a), $node, [StringComparison]::OrdinalIgnoreCase)) {
      @{ name = [string]$r.Name; enabled = [bool]$r.Enabled; direction = $(if ([int]$r.Direction -eq 1) { 'Inbound' } else { 'Outbound' }); action = $(if ([int]$r.Action -eq 1) { 'Allow' } else { 'Block' }); profile = (AgmProfile $r.Profiles) }
    }
  })
};
function AgmRulesSlow($node) {
  AgmUse 'NetSecurity';
  $f = @();
  try { $f = @(Get-NetFirewallApplicationFilter -Program $node) } catch { if (-not (AgmGone $_)) { throw } };
  if ($f.Count -eq 0) { return @() };
  return @($f | Get-NetFirewallRule | ForEach-Object { @{ name = [string]$_.DisplayName; enabled = ([string]$_.Enabled -eq 'True'); direction = [string]$_.Direction; action = [string]$_.Action; profile = [string]$_.Profile } })
};
'{' + [char]34 + 'v' + [char]34 + ':1}';
AgmUse 'Microsoft.PowerShell.Utility';
try { $v = AgmPower 'SUB_SLEEP' 'STANDBYIDLE' } catch { $v = @{ error = (AgmWhy $_) } };
AgmSay 'standbyAc' $v;
try { $v = AgmPower 'SUB_BUTTONS' 'LIDACTION' } catch { $v = @{ error = (AgmWhy $_) } };
AgmSay 'lidAc' $v;
try {
  AgmUse 'ScheduledTasks';
  $t = Get-ScheduledTask -TaskPath '\AGMessage\' -TaskName 'Server';
  $i = Get-ScheduledTaskInfo -TaskPath '\AGMessage\' -TaskName 'Server';
  $v = @{ state = [string]$t.State; lastResult = [int64]$i.LastTaskResult; lastRun = $(if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { '' }) }
} catch { if (AgmGone $_) { $v = @{ missing = $true } } else { $v = @{ error = (AgmWhy $_) } } };
AgmSay 'task' $v;
try {
  AgmUse 'Microsoft.PowerShell.Management';
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
  } catch { if (-not (AgmGone $_)) { $rec.grantsError = (AgmWhy $_) } };
  $v = $rec
} catch { if (AgmGone $_) { $v = @{ missing = $true } } else { $v = @{ error = (AgmWhy $_) } } };
AgmSay 'record' $v;
try { AgmUse 'NetConnection'; $v = @(Get-NetConnectionProfile | ForEach-Object { @{ name = [string]$_.Name; alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } }) } catch { $v = @{ error = (AgmWhy $_) } };
AgmSay 'network' $v;
try {
  if ([string]$ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $v = @(AgmRulesFast $env:AGM_NODE) } else { $v = @(AgmRulesSlow $env:AGM_NODE) }
} catch { $v = @{ error = (AgmWhy $_) } };
AgmSay 'rules' $v
`.trim().replace(/\s*\n\s*/g, ' ');

/**
 * How powershell.exe runs `script` here: {run: true, file, args, options} by its absolute path in System32, from that
 * folder, hidden, its environment SystemRoot, the names PASSED that this server's has, Windows' own module path and
 * `extra` (names AGMessage sets), and nothing else; or {run: false, why}: not Windows, or no SystemRoot named from its
 * drive (pure).
 */
function powershellPlan(env, script, { platform = process.platform, extra = {} } = {}) {
  if (platform !== 'win32') return { run: false, why: 'AGMessage is not running on Windows' };
  const root = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (!DRIVE_PATH.test(root)) return { run: false, why: 'SystemRoot does not name the Windows folder, so powershell.exe has no path to run from' };
  const sys = path.win32.join(root, 'System32');
  const childEnv = { SystemRoot: root };
  for (const name of PASSED) if (typeof env[name] === 'string' && env[name]) childEnv[name] = env[name];
  childEnv.PSModulePath = path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules');
  Object.assign(childEnv, extra);
  return {
    run: true,
    file: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
    options: { cwd: sys, windowsHide: true, env: childEnv },
  };
}
/**
 * How Windows is asked here: powershell.exe as powershellPlan runs it, running SCRIPT, with this node.exe's path (`node`,
 * AGM_NODE) for the firewall's rules (pure).
 */
function windowsPlan(env, { platform = process.platform, node = process.execPath } = {}) {
  return powershellPlan(env, SCRIPT, { platform, extra: { AGM_NODE: node } });
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
 * The data folder's row (pure): its format and what this start found of it (lib/dataformat.js `settle`, as health's
 * `format` says it), with `build` this build and `dir` the folder. △ when a newer build wrote it before this start.
 */
function formatRow(f) {
  let said;
  if (!f.was) said = 'begun by this build';
  else if (f.was !== f.format) said = 'moved from format ' + f.was + ' at this start; the folder as it was is kept in ' + path.join(f.dir, ...String(f.backup).split('/'));
  else if (f.before === f.build) said = 'last written by this build';
  else if (!f.before) said = 'last written by a build its marker did not name; this build writes it now';
  else said = 'last written by ' + f.before + (f.newer === true ? ', a newer build than this one,' : f.newer === false ? ', an older build,' : '') + ' before this start; this build ' + (f.newer === true ? 'reads its format, and ' : '') + 'writes it now';
  return row('format', 'Data folder', 'format ' + f.format + ' · ' + said, f.newer === true ? 'warn' : '', 'the data folder\'s format.json (' + path.join(f.dir, 'format.json') + '), read at this start');
}

/**
 * The sleeps row: the sleeps the watchdog recorded (`sl`: {watched, list: the newest kept, oldest first, today: {sleeps,
 * sleptMs}}), today's counted, the newest said whole; △ when one woke today (pure).
 */
function sleepsRow(sl) {
  const FROM = 'the watchdog: a tick of its own that came late, so it did not run';
  const last = sl.list.length ? sl.list[sl.list.length - 1] : null;
  const n = sl.today.sleeps;
  if (!last && !n) return row('asleep', 'Sleeps', sl.watched ? 'none recorded' : 'none recorded: no watchdog runs this server, so a sleep goes unseen', sl.watched ? 'ok' : 'off', FROM);
  const today = !n ? 'none today' : n === 1 ? 'once today' : n + ' times today';
  return row('asleep', 'Sleeps', today + (last ? ' · the last ' + asleepWords(last) : ''), n ? 'warn' : '', FROM);
}
/** "1 hall is live", "2 halls are live" (pure). */
const hallsWords = (live) => (live === 1 ? '1 hall is live' : live + ' halls are live');
/**
 * What makes the live halls live (`w`: {pages, screens, countdowns}, summed over them), in words: "2 pages open, 1 screen
 * showing"; '' when nothing does (pure).
 */
function liveWords(w) {
  const n = (k, one, many) => (w && w[k] > 0 ? w[k] + ' ' + (w[k] === 1 ? one : many) : '');
  return [n('pages', 'page open', 'pages open'), n('screens', 'screen showing', 'screens showing'), n('countdowns', 'countdown running', 'countdowns running')].filter(Boolean).join(', ');
}
/**
 * The power request's row (`pw`: lib/power.js PowerRequest's view, {state, live, why, what}): held while a hall is live,
 * what makes it live (so a page left open is seen), and what Windows took it to keep off (idle sleep, never the lid or
 * the power button, and on battery with Modern Standby for 5 minutes at most); not held, with why and when it is asked
 * again (pure).
 */
function powerRow(pw) {
  const FROM = 'powershell.exe, asked by this server while a hall is live (SetThreadExecutionState)';
  const what = liveWords(pw.what);
  const halls = hallsWords(pw.live) + (what ? ' (' + what + ')' : '');
  if (pw.state === 'off') return row('awake', 'Kept awake', 'not asked: no hall is live', 'off', FROM);
  if (pw.state === 'held') return row('awake', 'Kept awake', 'held while ' + halls + ': Windows took the request to keep off idle sleep, which on battery a laptop with Modern Standby keeps 5 minutes at most · the lid and the power button still do what the power plan says', 'ok', FROM);
  if (pw.state === 'asking') return row('awake', 'Kept awake', 'asked of Windows while ' + halls + ': no answer yet', '', FROM);
  const again = pw.state === 'failed' ? ' · asked again a minute after' : pw.state === 'refused' ? ' · asked again once no hall is live and one is again' : '';
  return row('awake', 'Kept awake', 'not held while ' + halls + ': ' + pw.why + again, pw.state === 'unavailable' ? 'off' : 'warn', FROM);
}

/**
 * The last stop's row (`s`: health's `lastStop`, {state, saved, at, build, unsaved, code, said, left}, with `fresh`, a
 * data folder this start began, and `file`, the record's path): saved, with when and by which build; or not, with why,
 * and the halls this start therefore said AGMessage restarted in; none for a folder this start began; and, whichever it
 * was, a record this start could not move aside, with why (pure).
 */
function stopRow(s) {
  const FROM = 'the record the stop before this start writes last (' + s.file + '), read at this start';
  const when = (s.at ? ' at ' + new Date(s.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '') + (s.build ? ' by ' + s.build : '');
  const said = s.said ? ' · so ' + (s.said === 1 ? '1 hall says' : s.said + ' halls say') + ' AGMessage restarted' : '';
  // Kept as the one seen, the next start reads it as taken; where that could not be written either, as stale once a hall
  // has changed (lib/laststop.js `take`, `judge`).
  const left = !s.left ? '' : ' · its record could not be moved aside (' + s.left + '): the next start reads it ' + (s.left.includes('seen') ? 'again, as stale once a hall has changed' : 'as taken');
  const words = (() => {
    if (s.saved) return ['saved' + when + ': the audit log, every store and each hall that changed, so no hall says AGMessage restarted', 'ok'];
    if (s.state === 'none' && s.fresh) return ['none: this start began the data folder', ''];
    if (s.state === 'unsaved') return ['not saved' + when + ': ' + (s.unsaved.length ? s.unsaved.join(', ') : 'something') + ' could not be written' + said, 'warn'];
    if (s.state === 'unread') return ['not known to have saved: its record could not be read (' + s.code + ')' + said, 'warn'];
    if (s.state === 'stale') return ['not known to have saved: the record of a stop' + when + ' is not the stop before this start (' + s.code + '), so a copy ran on the folder after it' + said, 'warn'];
    return ['not saved: AGMessage ended without its stop (a crash, the watchdog\'s kill of a hang, Windows shutting down or restarting, a power cut), or the build before it kept no record' + said, 'warn'];
  })();
  return row('stop', 'Last stop', words[0] + left, left ? 'warn' : words[1], FROM);
}

/** A page by kind, one and many. */
const PAGE_NOUNS = { screen: ['screen', 'screens'], hall: ['hall page', 'hall pages'], halls: ['halls board', 'halls boards'], admin: ['admin page', 'admin pages'], page: ['page not yet in a hall', 'pages not yet in a hall'] };
/** When a page on another build reloads itself (public/reconnect.js): a page not yet in a hall says when it is in one. */
const PAGE_WHEN = { screen: 'at its next take', hall: 'at a quiet moment', halls: 'at a quiet moment', admin: 'once its admin agrees', page: '' };
/** Names, each once with how many times it came (×2), LISTED_MAX at most and the rest counted. */
function namesOf(list) {
  const counts = new Map();
  for (const n of list) if (n) counts.set(n, (counts.get(n) || 0) + 1);
  const said = [...counts].map(([n, c]) => (c > 1 ? n + ' ×' + c : n));
  return said.slice(0, LISTED_MAX).join(', ') + (said.length > LISTED_MAX ? ' and ' + (said.length - LISTED_MAX) + ' more' : '');
}
/** A page's name in the row: a screen by its name and hall, a hall page by its hall and person, a board or admin page by its account. */
const pageName = (p) => (p.kind === 'screen' ? (p.where || 'a screen') + (p.hall ? ' in ' + p.hall : '') : p.kind === 'hall' ? (p.hall || 'a hall') + ': ' + (p.who || 'someone') : p.who);
/** "2 hall pages (Hall 1: Ana, Hall 1: Ben)", and when they reload (`when`), from the pages of one kind. */
function kindWords(kind, items, when) {
  const names = namesOf(items.map(pageName));
  return items.length + ' ' + PAGE_NOUNS[kind][items.length === 1 ? 0 : 1] + (names ? ' (' + names + ')' : '') + (when ? (items.length === 1 ? ' ' : ' each ') + when : '');
}
/**
 * The pages row (pure): every open page on this build, or those that are not, by the build each named as it connected
 * (`pages`: [{kind, build, newer, where, hall, who}]: `build` null for a page that named none, 0.5.1's, and '' for one
 * that named something that is not a build; `newer` the build's order against this one, 1, -1, 0 or null). 0.5 screens
 * are named to be reloaded by hand, since they never reload themselves; 0.5 pages are told to reload once none of 0.5's
 * files can still be fresh in a browser (`oldAt`, the time of day that comes, by the laptop's clock; '' once it has come
 * and each was told); a page of another build reloads itself, each kind at its own moment, LISTED_MAX builds said and
 * the rest counted. △ while any page is on another build.
 */
function pagesRow(pages, oldAt = '') {
  const FROM = 'the build each open page and screen named as it connected (a 0.5 page or screen names none)';
  if (!pages.length) return row('pages', 'Pages', 'every open page and screen is on this build', 'ok', FROM);
  const groups = new Map();
  for (const p of pages) {
    const k = p.build === null ? 'old' : p.build;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const said = [];
  const others = [];
  for (const [k, list] of groups) {
    const by = (kind) => list.filter((p) => p.kind === kind);
    const kinds = Object.keys(PAGE_NOUNS).filter((kind) => by(kind).length);
    if (k === 'old') {
      if (by('screen').length) said.push('0.5 screens: ' + namesOf(by('screen').map(pageName)) + ': reload each once by hand, since a 0.5 screen does not reload by itself');
      const rest = kinds.filter((kind) => kind !== 'screen');
      if (rest.length) said.push('0.5 pages: ' + rest.map((kind) => kindWords(kind, by(kind), '')).join(', ') + ': '
        + (oldAt ? 'each is told to reload at ' + oldAt + ', once no 0.5 script can still be in its browser\'s cache' : 'each was told to reload; reload by hand one that stays listed'));
      continue;
    }
    others.push(list);
    if (others.length > LISTED_MAX) continue;
    const newer = list[0].newer;
    const label = !k ? 'a build it did not name' : k + (newer === 1 ? ' (a newer build)' : newer === -1 ? ' (an older build)' : '');
    said.push('on ' + label + ': ' + kinds.map((kind) => kindWords(kind, by(kind), PAGE_WHEN[kind] ? 'reloads ' + PAGE_WHEN[kind] : '')).join(', '));
  }
  // One segment a build, LISTED_MAX at most: a page names its own build, so the row is bounded whatever they name.
  const unsaid = others.slice(LISTED_MAX);
  if (unsaid.length) {
    const n = unsaid.reduce((sum, list) => sum + list.length, 0);
    said.push('on ' + unsaid.length + ' more build' + (unsaid.length === 1 ? '' : 's') + ': ' + n + ' page' + (n === 1 ? '' : 's') + ' or screen' + (n === 1 ? '' : 's'));
  }
  return row('pages', 'Pages', pages.length + ' on another build · ' + said.join(' · '), 'warn', FROM);
}

/**
 * The internet link's row (`t`: {running, url, error, until, again, notKept}, its end and the start that turned it on
 * again in words by the laptop's clock, '' when none): on until its end, and when a start turned it on again, that its
 * address is new; off with an end still kept (cloudflared ended, or a start could not turn it on again), that a start
 * before then turns it on again; △ when a restart would not turn it on again, or it is off with an error (pure).
 */
function tunnelRow(t) {
  const FROM = 'cloudflared, turned on from this page, and again by a start before its end (kept in the settings)';
  const kept = t.notKept ? ' · ' + t.notKept : '';
  if (!t.running) {
    const still = t.until ? ' · it was to stay on until ' + t.until + ': Turn on, or a start of AGMessage before then, turns it on again' : '';
    return row('tunnel', 'Internet link', (t.error ? 'off: ' + t.error : 'off') + still + kept, t.error || t.until ? 'warn' : 'off', FROM);
  }
  const until = t.until ? ' · until ' + t.until + ', then off' : '';
  if (!t.url) return row('tunnel', 'Internet link', 'starting' + until + (t.again ? ' · turned on again as AGMessage started at ' + t.again + ': its address will be new' : '') + kept, t.notKept ? 'warn' : '', FROM);
  const again = t.again ? ' · turned on again as AGMessage started at ' + t.again + ': a new address, so remote people need this one' : '';
  return row('tunnel', 'Internet link', 'on: ' + t.url + until + again + kept, t.notKept ? 'warn' : 'ok', FROM);
}

/**
 * The panel's rows, from what this server knows (`k`) and what Windows said (`w`, windowsFacts's), in the panel's order
 * (pure). `k`: {build, runs, addresses, port, https: {on, fingerprint, validTo, off, renewal, file}, sealed: {total, open,
 * keyWords}, screens: {total, shown, offline}, stagewatch: {total, connected}, tunnel: tunnelRow's, sleeps:
 * sleepsRow's, power: powerRow's, stop: stopRow's, pages: {list, oldAt} (pagesRow's), before, without: [words], node,
 * format: formatRow's, or none}.
 */
function facts(k, w) {
  const rows = [];
  // Under the task, Windows does not start AGMessage again once its watchdog itself has crashed (R12): the row says so.
  rows.push(row('build', 'AGMessage', k.build + ' · ' + (k.runs === 'task' ? 'installed: a Windows task starts it with Windows, and does not start it again if its watchdog crashes (Start AGMessage, or restart the PC)' : 'the portable folder'), '', 'this server'));
  if (k.format) rows.push(formatRow(k.format));
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
  if (k.pages) rows.push(pagesRow(k.pages.list, k.pages.oldAt));
  const sw = k.stagewatch;
  rows.push(!sw.total ? row('stagewatch', 'Stagewatch', 'not linked', 'off', 'the Stagewatch links this AGMessage keeps')
    : row('stagewatch', 'Stagewatch', sw.connected === sw.total ? (sw.total === 1 ? 'connected' : 'all ' + sw.total + ' links connected') : sw.connected + ' of ' + sw.total + ' links connected', sw.connected === sw.total ? 'ok' : 'warn', 'the Stagewatch links this AGMessage keeps'));
  rows.push(tunnelRow(k.tunnel));
  if (k.sleeps) rows.push(sleepsRow(k.sleeps));
  if (k.power) rows.push(powerRow(k.power));
  if (k.stop) rows.push(stopRow(k.stop));
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

module.exports = { powershellPlan, windowsPlan, hallsWords, liveWords, readWindows, windowsFacts, facts, formatRow, stopRow, pagesRow, reach, SCRIPT, WINDOWS_MS, PASSED, RULES_MAX, LISTED_MAX };
