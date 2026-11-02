'use strict';
/**
 * A live show keeps the laptop awake (tested in test/sleep.test.js).
 *
 *   isLive        whether a hall is live: an open page seated in it, a screen that confirmed a take other than holding,
 *                 or its Stagewatch countdown running (pure)
 *   SCRIPT        the power request: one line, single quotes only, that asks SetThreadExecutionState(ES_CONTINUOUS |
 *                 ES_SYSTEM_REQUIRED) on its own thread and then waits on its standard input, so the request holds until
 *                 that input closes: when the server ends it, or when the server ends (on Windows the job libuv puts
 *                 every child in ends it with the server too)
 *   plan          how it is run: powershell.exe by its absolute path, in an environment of named folders only
 *                 (lib/laptop.js powershellPlan); on any other system nothing is run, and that is said
 *   readLine      one line of its answer, read by type: its first line, held, refused (with Windows' words) or failed
 *   PowerRequest  the one child: started while a hall is live, ended when none is or the server stops, and its state;
 *                 one that failed asked again at most once a minute while a hall stays live, one refused not until the
 *                 halls have gone quiet
 *
 * It keeps off idle sleep only. "The SetThreadExecutionState function cannot be used to prevent the user from putting the
 * computer to sleep" (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate):
 * the lid and the power button stay the power plan's, and "This laptop" says so. "Held" is what Windows answered (the call
 * returned non-zero), never more: on battery a laptop with Modern Standby keeps a power request 5 minutes at most
 * (https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby).
 *
 * Add-Type compiles its one-line declaration with the .NET Framework's compiler: Windows PowerShell 5.1 runs csc.exe as
 * a child of its own on files in the TEMP folder it is given (lib/laptop.js PASSED), loads what it built and removes them.
 */
const childProcess = require('child_process');
const { cleanText } = require('./guard');
const laptop = require('./laptop');

/**
 * The script. Under Constrained Language Mode, where Add-Type is refused, it says so and ends, before it asks anything;
 * otherwise each line is written and flushed as it is said ({"v":1} first), then one of {"held":true} (only when the call
 * returned non-zero), {"refused": why} or {"failed": why}. Each line is JSON in ASCII: any other character is written
 * \uXXXX, so no code page changes Windows' words. The attribute's quotes are [char]34, so the script holds none.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop';
$ProgressPreference = 'SilentlyContinue';
function Ascii($j) { return (-join @(foreach ($c in $j.ToCharArray()) { if ([int]$c -gt 126) { '\u{0:x4}' -f [int]$c } else { [string]$c } })) };
function Say($k, $v) { $h = @{}; $h[$k] = $v; return (Ascii (ConvertTo-Json -InputObject $h -Compress)) };
$m = [string]$ExecutionContext.SessionState.LanguageMode;
if ($m -ne 'FullLanguage') { Say 'v' 1; Say 'refused' ('PowerShell runs in ' + $m + ' mode on this PC, which refuses Add-Type'); exit 0 };
function Tell($k, $v) { [Console]::Out.WriteLine((Say $k $v)); [Console]::Out.Flush() };
Tell 'v' 1;
try { Add-Type -Namespace AGMessage -Name Power -MemberDefinition ('[DllImport(' + [char]34 + 'kernel32.dll' + [char]34 + ')] public static extern uint SetThreadExecutionState(uint flags);') } catch { Tell 'refused' ('Add-Type: ' + [string]$_.Exception.Message); exit 0 };
if ([AGMessage.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { Tell 'failed' 'SetThreadExecutionState returned 0'; exit 0 };
Tell 'held' $true;
[void][Console]::In.ReadToEnd()
`.trim().replace(/\s*\n\s*/g, ' ');

/** The most of its answer that is read: a few short lines. */
const ANSWER_MAX = 4096;
/** How long a child has to answer, in ms (a start of PowerShell and its compile, on a slow laptop): past it, it failed. */
const ASK_MS = 30_000;
/** How soon a request that failed is asked again while a hall stays live, in ms: never in a loop. */
const RETRY_MS = 60_000;

/** Whether a hall is live ({pages, takes, running}: open pages seated in it, screens showing a take other than holding, its countdown running) (pure). */
const isLive = (h) => !!h && (h.pages > 0 || h.takes > 0 || h.running === true);

/** How the power request is run here (lib/laptop.js powershellPlan, with SCRIPT) (pure). */
function plan(env, { platform = process.platform } = {}) {
  return laptop.powershellPlan(env, SCRIPT, { platform });
}

/**
 * One line of the script's answer, read by type (pure): {v: true} for its first line; {held: true} only for `true`;
 * {refused: words} or {failed: words} for a string, its words cleaned and cut; else null.
 */
function readLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (j.v === 1) return { v: true };
  if (j.held === true) return { held: true };
  if (typeof j.refused === 'string') return { refused: cleanText(j.refused, 200) || 'no reason given' };
  if (typeof j.failed === 'string') return { failed: cleanText(j.failed, 200) || 'no reason given' };
  return null;
}

/**
 * The power request: one child, started while a hall is live and ended when none is, or when the server stops (`end`).
 * Its state: 'off' (no hall live, nothing asked), 'asking' (the child runs, no answer yet), 'held' (the call returned
 * non-zero), 'refused' (Windows refused it: Constrained Language Mode, Add-Type), 'failed' (the call returned 0, the child
 * could not run, did not answer within ASK_MS, or ended while it was wanted) or 'unavailable' (not Windows). One that
 * failed is asked again RETRY_MS after, while a hall stays live, never in a loop; one refused is asked again only once
 * the halls have gone quiet and are live again, since nothing about it changes while they stay live. `say(words)` is told
 * what changed: held, released, refused or failed (a failure in the same words as the one before it, once). Every time
 * is `now()`'s, and `want` is read at each halls board frame and health window, so it needs no timer of its own.
 * `planOf()` is read at each start, so a test stands in for powershell.exe there.
 */
class PowerRequest {
  constructor({ planOf = () => plan(process.env), spawn = childProcess.spawn, say = () => {}, now = Date.now } = {}) {
    this.planOf = planOf; this.spawn = spawn; this.say = say; this.now = now;
    this.state = 'off'; this.why = ''; this.live = 0; this.since = 0;
    this.what = { pages: 0, screens: 0, countdowns: 0 };   // what makes the live halls live
    this.child = null;
    this.starts = 0;   // children started
    this.saidWhy = '';   // the last failure said, so one that repeats on each retry is said once
  }

  /**
   * The halls now ([{pages, takes, running}]): a child is started when one is live and none was asked, or one that failed
   * RETRY_MS ago; one that has not answered within ASK_MS has failed; and it is ended when no hall is live.
   */
  want(halls, at = this.now()) {
    const live = Array.isArray(halls) ? halls.filter(isLive) : [];
    this.live = live.length;
    this.what = { pages: 0, screens: 0, countdowns: 0 };
    for (const h of live) { this.what.pages += h.pages > 0 ? h.pages : 0; this.what.screens += h.takes > 0 ? h.takes : 0; this.what.countdowns += h.running === true ? 1 : 0; }
    if (this.live > 0) {
      if (this.state === 'asking' && at - this.since >= ASK_MS) this._failed('powershell.exe did not answer within ' + Math.round(ASK_MS / 1000) + ' s');
      else if (this.state === 'off' || (this.state === 'failed' && at - this.since >= RETRY_MS)) this._start(at);
      return;
    }
    if (this.state === 'off') return;
    const held = this.state === 'held';
    this._end();
    this._set('off', '', at);
    this.saidWhy = '';
    if (held) this.say('released: no hall is live');
  }

  /** The server stops: the child ends with it. */
  end() { this._end(); }

  /** {state, live, why, since, what}: what "This laptop" and health say of it. */
  view() { return { state: this.state, live: this.live, why: this.why, since: this.since, what: { ...this.what } }; }

  _set(state, why, at) { this.state = state; this.why = why; this.since = at; }

  _start(at) {
    const p = this.planOf();
    if (!p || !p.run) { this._set('unavailable', (p && p.why) || 'powershell.exe has no path to run from', at); return; }
    this._set('asking', '', at);
    let child;
    try { child = this.spawn(p.file, p.args, { ...p.options, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) {
      this._failed('powershell.exe could not be run (' + (e.code || e.message) + ')');
      return;
    }
    this.child = child;
    this.starts++;
    const mine = () => this.child === child;
    let rest = '';
    let read = 0;
    let first = true;
    child.stdin.on('error', () => { /* it ended before its input closed: its exit says what that means */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      read += chunk.length;
      if (!mine() || read > ANSWER_MAX) return;
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = readLine(line.trim());
        if (first) { first = false; if (!r || !r.v) { this._failed('its answer could not be read'); return; } continue; }
        if (r && r.held && this.state === 'asking') { this._set('held', '', this.now()); this.saidWhy = ''; this.say('held while ' + laptop.hallsWords(this.live) + ': Windows took the request to keep off idle sleep'); } else if (r && r.refused) this._refused('Windows refused it: ' + r.refused);
        else if (r && r.failed) this._failed('Windows did not hold it: ' + r.failed);
      }
    });
    const ended = (code, signal) => {
      if (!mine()) return;
      this.child = null;
      const how = code !== null && code !== undefined ? 'code ' + code : 'signal ' + signal;
      if (this.state === 'asking') this._failed('powershell.exe ended before it answered (' + how + ')');
      else if (this.state === 'held') this._failed('powershell.exe ended (' + how + '), and the request with it');
    };
    child.on('error', (e) => { if (mine()) { this.child = null; this._failed('powershell.exe could not be run (' + (e.code || e.message) + ')'); } });
    child.on('exit', ended);
  }

  _refused(why) { this._set('refused', why, this.now()); this._said(why); this._end(); }
  _failed(why) { this._set('failed', why, this.now()); this._said(why); this._end(); }
  _said(why) { if (why !== this.saidWhy) this.say('not held: ' + why); this.saidWhy = why; }

  _end() {
    const c = this.child;
    this.child = null;
    if (!c) return;
    try { c.stdin.end(); } catch { /* its input is closed already */ }
    try { c.kill('SIGKILL'); } catch { /* it has ended */ }
  }
}

module.exports = { SCRIPT, isLive, plan, readLine, PowerRequest, ANSWER_MAX, ASK_MS, RETRY_MS };
