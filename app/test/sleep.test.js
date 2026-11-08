'use strict';
// The watchdog tells a sleep from a hang, and a live show keeps the laptop awake (the plan's Part 6, unit U9). On a fake
// clock: on-time ticks with no beat kill at the hang's limit, and a tick of the watchdog's own that comes late starts the
// beat clock again and is a sleep, never a hang. On the real watchdog (Linux, where a process can be frozen and thawed:
// SIGSTOP, SIGCONT), the plan's proxies: both processes frozen and thawed (a sleep), frozen most of the time (a laptop's
// standby that lets a process run a moment at a time), and the server frozen alone with the watchdog on time (a real
// hang). The sleeps reach the server, which keeps them with the show day's peaks, in health and "This laptop". The power
// request's child, powershell.exe, stood in for by test/power-preload.js: started only while a hall is live, ended when
// none is and with the server; and on Windows the script itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { io } = require('socket.io-client');
const h = require('./helpers');
const r = require('../lib/resilience');
const readings = require('../lib/peaks');
const power = require('../lib/power');
const laptop = require('../lib/laptop');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
/** NODE_OPTIONS that preload these test files, beside what the run already has. */
const preload = (...names) => [process.env.NODE_OPTIONS, ...names.map((n) => '--require "' + path.join(__dirname, n).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const WALL = Date.UTC(2026, 10, 2, 14, 0, 0);   // the wall clock beside the fake steady one: 2026-11-02 14:00:00 UTC

// ---------------------------------------------------------------- the judge, on a fake clock
test('on a fake clock: ticks on time with no beat kill at the hang\'s limit; a late tick is a sleep, which starts the beat clock again', () => {
  const judge = () => new r.BeatClock({ tickMs: 500, lateMs: 2000, hangMs: 10_000, startupMs: 30_000, at: 0, wall: WALL });
  // A hang: the watchdog on time, the server silent from its beat at 0. Killed at the first tick past 10 s.
  let c = judge();
  c.started(0); c.beat(0);
  for (let at = 500; at <= 10_000; at += 500) assert.deepEqual(c.tick(at, WALL + at), { late: false, hungMs: 0, slept: null }, 'silent ' + at + ' ms');
  assert.deepEqual(c.tick(10_500, WALL + 10_500), { late: false, hungMs: 10_500, slept: null }, 'on-time ticks with no beats kill at HANG_MS');
  // Before a run's first beat its silence counts against the start-up wait.
  c = judge();
  c.started(0);
  for (let at = 500; at <= 30_000; at += 500) assert.equal(c.tick(at, WALL + at).hungMs, 0);
  assert.equal(c.tick(30_500, WALL + 30_500).hungMs, 30_500, 'not started within its wait');
  // A sleep: both frozen from just after the tick at 2 s until 20 s. The tick at 20 s comes 17.5 s late: a sleep, no hang,
  // though the server's last beat was 19 s before it; the beat clock starts again there, so 10 s of on-time ticks with no
  // beat after it are still a hang.
  c = judge();
  c.started(0);
  for (let at = 500; at <= 2000; at += 500) { if (at % 1000 === 0) c.beat(at); assert.equal(c.tick(at, WALL + at).hungMs, 0); }
  assert.deepEqual(c.tick(20_000, WALL + 20_000), { late: true, hungMs: 0, slept: null }, 'a late tick judges nothing of its gap');
  for (let at = 20_500; at < 30_000; at += 500) assert.deepEqual(c.tick(at, WALL + at), { late: false, hungMs: 0, slept: null });
  assert.deepEqual(c.tick(30_000, WALL + 30_000), { late: false, hungMs: 0, slept: { from: WALL + 2000, to: WALL + 20_000, parts: 1 } },
    'said once the watchdog has run on time for the hang\'s limit after it: from its last tick before, to its first after');
  assert.deepEqual(c.tick(30_500, WALL + 30_500), { late: false, hungMs: 10_500, slept: null }, 'a hang after a sleep is a hang');
  // A tick exactly at the late limit (2.5 s after the one before) is not late: the silence counts on through it.
  c = judge();
  c.started(0); c.beat(0);
  for (let at = 500; at <= 7500; at += 500) c.tick(at, WALL + at);
  assert.deepEqual(c.tick(10_000, WALL + 10_000), { late: false, hungMs: 0, slept: null }, '2 s late, not more');
  assert.equal(c.tick(10_500, WALL + 10_500).hungMs, 10_500);
  assert.equal(c.close(), null, 'no sleep to say');
  // The first tick is judged as every other: one that comes late after the ticks began is a sleep too, never a hang.
  c = new r.BeatClock({ tickMs: 500, lateMs: 2000, hangMs: 10_000, startupMs: 30_000, at: 1000, wall: WALL + 1000 });
  c.started(1000); c.beat(1200);
  assert.deepEqual(c.tick(16_000, WALL + 16_000), { late: true, hungMs: 0, slept: null }, 'frozen before its first tick');
  assert.deepEqual(c.close(), { from: WALL + 1000, to: WALL + 16_000, parts: 1 });
  // A steady clock that stopped while the machine slept (Linux's monotonic clock does) sees the tick on time; the wall
  // clock saw the 20 minutes go: a sleep all the same, and the server's silence is measured from that tick on the steady
  // clock alone, so the hang's limit still holds after it.
  c = judge();
  c.started(0); c.beat(0);
  for (let at = 500; at <= 3000; at += 500) { if (at % 1000 === 0) c.beat(at); c.tick(at, WALL + at); }
  assert.deepEqual(c.tick(3500, WALL + 3500 + 1_200_000), { late: true, hungMs: 0, slept: null }, 'late on the wall clock alone');
  for (let at = 4000; at < 13_500; at += 500) assert.equal(c.tick(at, WALL + at + 1_200_000).hungMs, 0, 'silent ' + (at - 3500) + ' ms after the wake');
  assert.deepEqual(c.tick(13_500, WALL + 13_500 + 1_200_000), { late: false, hungMs: 0, slept: { from: WALL + 3000, to: WALL + 3500 + 1_200_000, parts: 1 } },
    'said once awake for the hang\'s limit, the gap the wall clock saw');
  assert.equal(c.tick(14_000, WALL + 14_000 + 1_200_000).hungMs, 10_500, 'and a hang after it is a hang');
  // A wall clock set back (a sync, a person) is no sleep and hides no hang: silence is the steady clock's.
  c = judge();
  c.started(0); c.beat(0);
  for (let at = 500; at <= 10_000; at += 500) assert.equal(c.tick(at, WALL + at - 3_600_000).late, false);
  assert.equal(c.tick(10_500, WALL - 3_600_000 + 10_500).hungMs, 10_500);
});

test('on a fake clock, the throttle proxy: a second awake in every fifteen for six minutes is one sleep, never a kill', () => {
  // As a standby throttles a process: both run 1 s in every 15 s. The server beats once in its second, or not at all.
  const c = new r.BeatClock({ tickMs: 500, lateMs: 2000, hangMs: 10_000, startupMs: 30_000, at: 0, wall: WALL });
  c.started(0); c.beat(0);
  for (let at = 500; at <= 1000; at += 500) c.tick(at, WALL + at);
  let at = 1000;
  const hung = [];
  let lates = 0;
  for (let cycle = 0; cycle < 24; cycle++) {
    at += 14_000;                                    // asleep
    const t = c.tick(at, WALL + at);                 // its first tick awake comes 13.5 s late
    if (t.late) lates++;
    if (t.hungMs) hung.push(at);
    if (cycle % 2) c.beat(at + 300);                 // a beat in half of its seconds
    at += 500;
    const t2 = c.tick(at, WALL + at);
    if (t2.hungMs) hung.push(at);
    assert.equal(t2.slept, null, 'awake a moment: the sleep goes on');
    at += 500;                                       // its second is over
  }
  assert.deepEqual([hung, lates], [[], 24], 'never hung, and every wake was a late tick');
  let said = null;
  for (let n = 0; n < 20 && !said; n++) { at += 500; said = c.tick(at, WALL + at).slept; }
  assert.deepEqual(said, { from: WALL + 1000, to: WALL + 1000 + 23 * 15_000 + 14_000, parts: 24 }, 'one sleep, from the first gap to the last wake, its 24 parts counted');
  // A sleep the watchdog stops in is said as it stops.
  c.tick(at + 20_000, WALL + at + 20_000);
  assert.deepEqual(c.close(), { from: WALL + at, to: WALL + at + 20_000, parts: 1 });
  assert.equal(c.close(), null);
});

test('a sleep in words: when, in UTC, how long, and how many times in a row', () => {
  assert.equal(r.asleepWords({ from: WALL + 123_000, to: WALL + 1_211_000, parts: 1 }), 'asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min 8 s)');
  assert.equal(r.asleepWords({ from: WALL + 8 * 3_600_000, to: WALL + 17 * 3_600_000 + 60_000, parts: 3 }),
    'asleep from 2026-11-02 22:00:00 to 2026-11-03 07:01:00 UTC (9 h 1 min, 3 times in a row, awake a moment between)', 'another day\'s end says its date');
  assert.deepEqual([r.spanWords(0), r.spanWords(44_600), r.spanWords(60_000), r.spanWords(3_600_000), r.spanWords(-5)], ['0 s', '45 s', '1 min', '1 h', '0 s']);
});

test('the show day\'s peaks keep the sleeps: counted on the day each woke in, its longest kept, the newest 20 whole, read by type and read back', () => {
  const at = (d, hh, mm = 0) => new Date(2026, 10, d, hh, mm, 0).getTime();   // the laptop's own time
  const p = new readings.Peaks();
  assert.equal(p.slept({ from: at(2, 14), to: at(2, 14, 18), parts: 1 }, at(2, 15)), true);
  assert.equal(p.dirty, true, 'saved at the window\'s end');
  // One that woke after 06:00 is the new show day's, whenever it began.
  assert.equal(p.slept({ from: at(2, 23), to: at(3, 7), parts: 4 }, at(3, 8)), true);
  assert.equal(p.slept({ from: at(3, 9), to: at(3, 9, 5), parts: 1 }, at(3, 10)), true);
  assert.deepEqual(p.view().map((d) => [d.day, d.sleeps, d.sleptMs]), [['2026-11-02', 1, 18 * 60_000], ['2026-11-03', 2, 8 * 3_600_000]]);
  assert.deepEqual(p.sleptOn(at(3, 12)), { sleeps: 2, sleptMs: 8 * 3_600_000 });
  assert.deepEqual(p.sleptOn(at(5, 12)), { sleeps: 0, sleptMs: 0 }, 'a day with no record: none');
  assert.deepEqual(p.sleeps().map((s) => s.parts), [1, 4, 1], 'kept whole, oldest first');
  // Read by type: whole numbers, its start before its end, ended by now (a minute's leeway), at most a year.
  p.dirty = false;
  for (const bad of [null, 'x', {}, { from: at(3, 1), to: at(3, 1), parts: 1 }, { from: at(3, 2), to: at(3, 1), parts: 1 }, { from: at(3, 1), to: at(3, 2), parts: 0 },
    { from: at(3, 1), to: at(3, 2), parts: 1.5 }, { from: String(at(3, 1)), to: at(3, 2), parts: 1 }, { from: at(3, 1), to: at(3, 13), parts: 1 }, { from: -1, to: at(3, 2), parts: 1 },
    { from: at(3, 1) - 400 * 86_400_000, to: at(3, 1), parts: 1 }]) {
    assert.equal(p.slept(bad, at(3, 12)), false, JSON.stringify(bad));
  }
  assert.equal(p.dirty, false, 'nothing taken, nothing to save');
  // The newest 20 stay whole; every one is still counted on its day.
  for (let i = 0; i < 25; i++) p.slept({ from: at(4, 9, i), to: at(4, 9, i) + 30_000, parts: 1 }, at(4, 12));
  assert.equal(p.sleeps().length, readings.SLEEPS_KEPT);
  assert.equal(p.sleeps()[readings.SLEEPS_KEPT - 1].from, at(4, 9, 24));
  assert.equal(p.sleptOn(at(4, 12)).sleeps, 25);
  // Saved and read back as it was; what is not a sleep is left out.
  const saved = JSON.parse(JSON.stringify(p.toJSON()));
  assert.equal(saved.asleep.length, 20);
  const back = new readings.Peaks().load(saved);
  assert.deepEqual([back.view(), back.sleeps()], [p.view(), p.sleeps()]);
  const odd = new readings.Peaks().load({ days: [{ day: '2026-11-04', sleeps: 2.5, sleptMs: 'long' }], asleep: [{ from: 1, to: 0, parts: 1 }, null, { from: 5, to: 9, parts: 2 }] });
  assert.deepEqual([odd.view()[0].sleeps, odd.view()[0].sleptMs, odd.sleeps()], [2, 0, [{ from: 5, to: 9, parts: 2 }]]);
});

// ---------------------------------------------------------------- the power request (pure, and its child stood in for)
test('the power request, as it is asked: a hall live, the script, how powershell.exe is run, its answer read by type', () => {
  assert.deepEqual([{ pages: 1 }, { takes: 1 }, { running: true }, { pages: 0, takes: 0, running: false }, { running: 'yes' }, null].map(power.isLive), [true, true, true, false, false, false]);
  assert.deepEqual(power.plan({ SystemRoot: 'C:\\Windows' }, { platform: 'linux' }), { run: false, why: 'AGMessage is not running on Windows' });
  assert.equal(power.plan({ SystemRoot: '%SystemRoot%' }, { platform: 'win32' }).run, false);
  const env = { SystemRoot: 'C:\\Windows', ADMIN_TOKEN: 'x', anthropic_api_key: 'y', PATH: 'C:\\bin', TEMP: 'C:\\Temp', NODE_OPTIONS: '--require x' };
  const p = power.plan(env, { platform: 'win32' });
  assert.deepEqual([p.file, p.args, p.options], ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', power.SCRIPT], {
    cwd: 'C:\\Windows\\System32', windowsHide: true, env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
  }], 'by its absolute path, from System32, in a named environment: no secret, no PATH, no module path of the account\'s');
  assert.deepEqual(laptop.windowsPlan(env, { platform: 'win32', node: 'C:\\n\\node.exe' }).options.env.AGM_NODE, 'C:\\n\\node.exe', '"This laptop"\'s read runs the same way');
  const s = power.SCRIPT;
  assert.ok(!s.includes('"') && !s.includes('\n'), 'one line, single quotes only');
  assert.ok(s.includes('SetThreadExecutionState([uint32]2147483649)'), 'ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1)');
  assert.ok(s.indexOf("$m -ne 'FullLanguage'") < s.indexOf('Add-Type'), 'Constrained Language Mode is said before Add-Type is asked');
  assert.ok(s.indexOf("AgmTell 'held' $true") > s.indexOf('-eq 0') && s.trim().endsWith('[void][Console]::In.ReadToEnd()'), 'held only when the call returned non-zero, then it waits on its input');
  // Windows' own Microsoft.PowerShell.Utility, by its manifest's path, before ConvertTo-Json or Add-Type is asked by name.
  const used = s.indexOf("Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')");
  assert.ok(used > 0 && used < s.indexOf('ConvertTo-Json') && used < s.indexOf('Add-Type'), 'the module by its path, first');
  assert.deepEqual(['{"v":1}', '{"held":true}', '{"held":1}', '{"refused":"no\\u0007"}', '{"failed":""}', '{"failed":7}', 'not json', '[]', 'null'].map(power.readLine),
    [{ v: true }, { held: true }, null, { refused: 'no' }, { failed: 'no reason given' }, null, null, null, null]);
});

/** A child process stood in for: its input, output and end are the test's. */
function standIn() {
  const made = [];
  const spawnOf = (file, args, options) => {
    if (spawnOf.throws) throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const c = new EventEmitter();
    c.stdin = new PassThrough(); c.stdout = new PassThrough();
    c.file = file; c.options = options; c.signal = null;
    c.kill = (sig) => { c.signal = sig; setImmediate(() => c.emit('exit', null, sig)); };
    made.push(c);
    return c;
  };
  spawnOf.made = made;
  return spawnOf;
}
const turn = () => new Promise((resolve) => { setImmediate(resolve); });

test('the power request\'s child: started only while a hall is live, held only on its word, ended when no hall is and at a stop; one that failed asked again a minute after, one refused not while the halls stay live', async () => {
  const PLAN = { run: true, file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-Command', 'x'], options: { cwd: 'C:\\Windows\\System32', windowsHide: true, env: {} } };
  const spawnOf = standIn();
  const said = [];
  let clock = 1000;
  const pr = new power.PowerRequest({ planOf: () => PLAN, spawn: spawnOf, say: (w) => said.push(w), now: () => clock });
  const quiet = [{ pages: 0, takes: 0, running: false }];
  const live = [{ pages: 2, takes: 0, running: false }, { pages: 0, takes: 1, running: false }, { pages: 0, takes: 0, running: false }];
  const last = () => spawnOf.made[spawnOf.made.length - 1];
  const again = () => { pr.want(quiet); pr.want(live); return last(); };
  pr.want(quiet);
  assert.deepEqual([pr.view(), spawnOf.made.length], [{ state: 'off', live: 0, why: '', since: 0, what: { pages: 0, screens: 0, countdowns: 0 } }, 0], 'no hall live: nothing asked');
  clock = 2000;
  pr.want(live);
  assert.deepEqual([pr.view().state, pr.view().live, pr.view().since, pr.view().what, spawnOf.made.length], ['asking', 2, 2000, { pages: 2, screens: 1, countdowns: 0 }, 1], 'what makes the halls live, summed over those that are');
  const c1 = spawnOf.made[0];
  assert.deepEqual([c1.file, c1.options.stdio, c1.options.cwd, c1.options.windowsHide], [PLAN.file, ['pipe', 'pipe', 'ignore'], 'C:\\Windows\\System32', true]);
  c1.stdout.write('{"v":1}\r\n');
  await turn();
  assert.equal(pr.view().state, 'asking', 'its first line is no answer');
  c1.stdout.write('{"held":tr');
  await turn();
  assert.equal(pr.view().state, 'asking', 'a line not yet whole is not read');
  clock = 3000;
  c1.stdout.write('ue}\n');
  await turn();
  assert.deepEqual([pr.view().state, pr.view().since], ['held', 3000]);
  pr.want(live);
  assert.equal(spawnOf.made.length, 1, 'one child while live');
  clock = 4000;
  pr.want(quiet);
  assert.deepEqual([pr.view().state, pr.view().since, c1.signal, c1.stdin.writableEnded], ['off', 4000, 'SIGKILL', true], 'no hall live: its input closed and it is ended');
  await turn();
  assert.equal(pr.view().state, 'off', 'its end, asked, changes nothing');
  // Live again: a new child. An end it was not asked for says so, and it is asked again a minute after, never sooner.
  clock = 5000;
  pr.want(live);
  const c2 = spawnOf.made[1];
  c2.stdout.write('{"v":1}\n{"held":true}\n');
  await turn();
  clock = 6000;
  c2.emit('exit', 1, null);
  assert.deepEqual([pr.view().state, pr.view().why, pr.view().since], ['failed', 'powershell.exe ended (code 1), and the request with it', 6000]);
  clock = 6000 + power.RETRY_MS - 1;
  pr.want(live);
  assert.deepEqual([pr.view().state, spawnOf.made.length], ['failed', 2], 'not asked again sooner: never in a loop');
  clock = 6000 + power.RETRY_MS;
  pr.want(live);
  assert.deepEqual([pr.view().state, spawnOf.made.length], ['asking', 3], 'asked again a minute after, the halls still live');
  // A child that does not answer within its time has failed: it is ended, and asked again a minute after; the same failure
  // again is said once.
  const c3 = last();
  const asked = clock;
  clock = asked + power.ASK_MS - 1;
  pr.want(live);
  assert.equal(pr.view().state, 'asking');
  clock = asked + power.ASK_MS;
  pr.want(live);
  assert.deepEqual([pr.view().state, pr.view().why, c3.signal], ['failed', 'powershell.exe did not answer within 30 s', 'SIGKILL']);
  clock += power.RETRY_MS;
  pr.want(live);
  clock += power.ASK_MS;
  pr.want(live);
  assert.deepEqual([pr.view().state, spawnOf.made.length], ['failed', 4]);
  clock += power.RETRY_MS;
  pr.want(live);
  last().stdout.write('{"v":1}\n{"held":true}\n');
  await turn();
  assert.equal(pr.view().state, 'held', 'held at the next ask');
  // Refused (Constrained Language Mode): said, and not asked again while the halls stay live, however long; asked again
  // once they have gone quiet and are live again.
  const c6 = again();
  c6.stdout.write('{"v":1}\n{"refused":"PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type"}\n');
  await turn();
  assert.deepEqual([pr.view().state, pr.view().why, c6.signal], ['refused', 'Windows refused it: PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type', 'SIGKILL']);
  clock += 10 * power.RETRY_MS;
  pr.want(live);
  assert.equal(spawnOf.made.length, 6, 'refused: not asked again while live');
  again().stdout.write('{"v":1}\n{"failed":"SetThreadExecutionState returned 0"}\n');
  await turn();
  assert.deepEqual([pr.view().state, pr.view().why, spawnOf.made.length], ['failed', 'Windows did not hold it: SetThreadExecutionState returned 0', 7], 'a call that returned 0 is never held');
  again().stdout.write('Add-Type: oops\n');
  await turn();
  assert.deepEqual([pr.view().state, pr.view().why], ['failed', 'its answer could not be read']);
  again().emit('exit', null, 'SIGKILL');
  assert.deepEqual([pr.view().state, pr.view().why], ['failed', 'powershell.exe ended before it answered (signal SIGKILL)']);
  again().emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual([pr.view().state, pr.view().why], ['failed', 'powershell.exe could not be run (ENOENT)']);
  pr.want(quiet);
  spawnOf.throws = true;
  pr.want(live);
  assert.deepEqual([pr.view().state, pr.view().why], ['failed', 'powershell.exe could not be run (EACCES)']);
  spawnOf.throws = false;
  // An answer larger than it reads is not read past its bound.
  const big = again();
  big.stdout.write('{"v":1}\n' + 'x'.repeat(power.ANSWER_MAX) + '\n{"held":true}\n');
  await turn();
  assert.equal(pr.view().state, 'asking', 'past its bound nothing more is read');
  // At a stop the child ends with the server.
  pr.end();
  assert.equal(big.signal, 'SIGKILL');
  const held = 'held while 2 halls are live: Windows took the request to keep off idle sleep';
  assert.deepEqual(said, [held, 'released: no hall is live', held,
    'not held: powershell.exe ended (code 1), and the request with it', 'not held: powershell.exe did not answer within 30 s', held,
    'released: no hall is live', 'not held: Windows refused it: PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type',
    'not held: Windows did not hold it: SetThreadExecutionState returned 0', 'not held: its answer could not be read', 'not held: powershell.exe ended before it answered (signal SIGKILL)',
    'not held: powershell.exe could not be run (ENOENT)', 'not held: powershell.exe could not be run (EACCES)'], 'held, released, and every refusal and failure, each said once');
  // Not on Windows: nothing is run, and why is said.
  const off = new power.PowerRequest({ planOf: () => ({ run: false, why: 'AGMessage is not running on Windows' }), spawn: spawnOf, now: () => 1 });
  off.want(live);
  assert.deepEqual(off.view(), { state: 'unavailable', live: 2, why: 'AGMessage is not running on Windows', since: 1, what: { pages: 2, screens: 1, countdowns: 0 } });
  off.want(live);
  assert.equal(off.view().state, 'unavailable', 'never asked again: nothing changes it');
  // By default it is planned from this server's environment: off Windows, nothing is run.
  const plain = new power.PowerRequest({ spawn: spawnOf });
  plain.want(live);
  if (process.platform !== 'win32') assert.deepEqual([plain.view().state, plain.view().why], ['unavailable', 'AGMessage is not running on Windows']);
  plain.end();
  const none = new power.PowerRequest({ planOf: () => null });
  none.want(live);
  assert.deepEqual([none.view().state, none.view().why], ['unavailable', 'powershell.exe has no path to run from']);
});

test('"This laptop" says the sleeps recorded and the power request: each row its words, its mark and where it was read', () => {
  const k = { build: '0.6.0+31', runs: 'portable', addresses: [], port: 3023, node: 'node.exe', https: { on: false, off: 'x', file: 'f' }, sealed: { total: 0 }, screens: { total: 0 }, stagewatch: { total: 0 }, tunnel: { running: false }, before: '', without: [] };
  const rowsWith = (sleeps, pw) => Object.fromEntries(laptop.facts({ ...k, sleeps, power: pw }, laptop.windowsFacts(null)).filter((x) => x.id === 'asleep' || x.id === 'awake').map((x) => [x.id, [x.words, x.mark]]));
  const none = { watched: true, list: [], today: { sleeps: 0, sleptMs: 0 } };
  assert.deepEqual(rowsWith(none, { state: 'off', live: 0, why: '' }), { asleep: ['none recorded', 'ok'], awake: ['not asked: no hall is live', 'off'] });
  const last = { from: WALL + 123_000, to: WALL + 1_211_000, parts: 1 };
  // Held is what Windows answered, never more: what it was taken to keep off, and on battery for how long at most; and what
  // makes the halls live, so a page left open in a hall is seen.
  assert.deepEqual(rowsWith({ watched: true, list: [last], today: { sleeps: 1, sleptMs: 1_088_000 } }, { state: 'held', live: 1, why: '', what: { pages: 1, screens: 0, countdowns: 0 } }), {
    asleep: ['once today · the last asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min 8 s)', 'warn'],
    awake: ['held while 1 hall is live (1 page open): Windows took the request to keep off idle sleep, which on battery a laptop with Modern Standby keeps 5 minutes at most · the lid and the power button still do what the power plan says', 'ok'],
  });
  assert.deepEqual(rowsWith({ watched: true, list: [last, last], today: { sleeps: 3, sleptMs: 0 } }, { state: 'asking', live: 2, why: '', what: { pages: 3, screens: 2, countdowns: 1 } }), {
    asleep: ['3 times today · the last asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min 8 s)', 'warn'], awake: ['asked of Windows while 2 halls are live (3 pages open, 2 screens showing, 1 countdown running): no answer yet', ''],
  });
  assert.deepEqual(rowsWith({ watched: false, list: [last], today: { sleeps: 0, sleptMs: 0 } }, { state: 'refused', live: 1, why: 'Windows refused it: no', what: { pages: 0, screens: 1, countdowns: 0 } }), {
    asleep: ['none today · the last asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min 8 s)', ''], awake: ['not held while 1 hall is live (1 screen showing): Windows refused it: no · asked again once no hall is live and one is again', 'warn'],
  });
  assert.deepEqual(rowsWith({ watched: true, list: [], today: { sleeps: 0, sleptMs: 0 } }, { state: 'failed', live: 2, why: 'powershell.exe did not answer within 30 s', what: { pages: 0, screens: 0, countdowns: 2 } }).awake,
    ['not held while 2 halls are live (2 countdowns running): powershell.exe did not answer within 30 s · asked again a minute after', 'warn']);
  assert.deepEqual(rowsWith({ watched: false, list: [], today: { sleeps: 0, sleptMs: 0 } }, { state: 'unavailable', live: 3, why: 'AGMessage is not running on Windows' }), {
    asleep: ['none recorded: no watchdog runs this server, so a sleep goes unseen', 'off'], awake: ['not held while 3 halls are live: AGMessage is not running on Windows', 'off'],
  });
  assert.deepEqual([laptop.liveWords({ pages: 1, screens: 1, countdowns: 1 }), laptop.liveWords({ pages: 0, screens: 0, countdowns: 0 }), laptop.liveWords(undefined)], ['1 page open, 1 screen showing, 1 countdown running', '', '']);
  const rows = laptop.facts({ ...k, sleeps: none, power: { state: 'off', live: 0, why: '' } }, laptop.windowsFacts(null));
  assert.deepEqual(rows.map((x) => x.id).slice(0, 9), ['build', 'addresses', 'https', 'sealed', 'screens', 'stagewatch', 'tunnel', 'asleep', 'awake'], 'after what AGMessage knows of its links, before what Windows says');
  assert.match(rows.find((x) => x.id === 'asleep').from, /^the watchdog: /);
  assert.match(rows.find((x) => x.id === 'awake').from, /SetThreadExecutionState/);
});

// ---------------------------------------------------------------- the proxies, on the real watchdog
const FREEZE = process.platform === 'win32' ? 'a process is frozen and thawed with SIGSTOP and SIGCONT, which Windows has not; the fake clock above holds the rule there' : false;
/** A server stood in for: it beats every 100 ms, writes its pid on each start, and writes each sleep it is told. */
function fakeServer(dir) {
  const f = path.join(dir, 'child.js');
  fs.writeFileSync(f, `'use strict';
const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(dir, 'runs'), process.pid + '\\n');
process.on('message', (m) => {
  if (m && m.t === 'stop') process.exit(0);
  if (m && m.t === 'slept') fs.appendFileSync(path.join(dir, 'told'), JSON.stringify(m) + '\\n');
});
process.on('disconnect', () => process.exit(0));
setInterval(() => { if (process.connected) process.send({ t: 'beat' }, () => { /* the watchdog gone */ }); }, 100);
`);
  return f;
}
/**
 * The watchdog on its own folder with a stood-in server: its hang 1.2 s, a tick late past 0.5 s (500 + 500 + the server's
 * 100 ms between beats is under the hang's limit, so no freeze it does not see as late is long enough to kill), its first
 * restart at once.
 */
function watchdogOf(dir, env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], {
    env: { ...process.env, AGM_CHILD: fakeServer(dir), AGM_DATA_DIR: dir, AGM_BACKOFF: '0.05', AGM_HANG_MS: '1200', AGM_LATE_MS: '500', AGM_STARTUP_MS: '3000', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.done = new Promise((resolve) => { p.once('exit', (code) => resolve(code)); });
  return p;
}
const pids = (dir) => read(path.join(dir, 'runs')).split('\n').filter(Boolean).map(Number);
const told = (dir) => read(path.join(dir, 'told')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const logOf = (dir) => read(path.join(dir, 'watchdog.log'));
/** Each still there frozen for `ms`: {t0, t1}, the wall clock just after all stopped and just before all go on. */
async function frozen(list, ms) {
  const signal = (sig) => { for (const pid of list) { try { process.kill(pid, sig); } catch { /* gone: a server killed, which the test then says */ } } };
  signal('SIGSTOP');
  const t0 = Date.now();
  await h.wait(ms);
  const t1 = Date.now();
  signal('SIGCONT');
  return { t0, t1 };
}
/** Whether a sleep said covers a freeze: it began by its start and ended after it (the freeze's edges read to 50 ms). */
const covers = (s, f) => s.from <= f.t0 + 50 && s.to >= f.t1 - 50;
const thawAll = (list) => { for (const pid of list) { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } } };

test('the sleep proxy on the real watchdog: both frozen past the hang\'s limit three times, never killed, never given up, each sleep said and told', { skip: FREEZE }, async () => {
  const dir = tmp('agm-sleep-');
  const p = watchdogOf(dir);
  let both = [];
  try {
    await h.until(() => pids(dir).length === 1, 5000, 'its server');
    await h.wait(400);
    both = [p.pid, pids(dir)[0]];
    const freezes = [];
    for (let i = 0; i < 3; i++) {
      freezes.push(await frozen(both, 2000));            // past the hang's 1.2 s: a watchdog that judged the gap kills the server here
      await h.wait(1800);                                // awake past the hang's limit: the sleep is said
      assert.deepEqual(pids(dir), [both[1]], 'freeze ' + (i + 1) + ': no kill, no restart:\n' + logOf(dir));
      await h.until(() => told(dir).filter((s) => covers(s, freezes[i])).length === 1, 3000, 'sleep ' + (i + 1) + ' said and told');
    }
    const log = logOf(dir);
    assert.ok(!/no heartbeat|restarting|giving up/.test(log), 'no hang, no restart, no give-up:\n' + log);
    for (const f of freezes) {
      const s = told(dir).find((x) => covers(x, f));
      assert.equal(s.parts, 1);
      assert.ok(log.includes(r.asleepWords(s) + ': the watchdog did not run, so it judged nothing of the server for that time'), 'in watchdog.log as told:\n' + log);
      assert.ok(p.out.includes('[watchdog] ' + r.asleepWords(s)), 'on its console');
    }
    assert.ok(read(path.join(dir, 'logs', 'server.log')).includes('asleep from'), 'and in server.log');
    assert.equal(p.exitCode, null, 'the watchdog runs on');
    // Stopped moments after a wake, before the watchdog has run on time long enough to say the sleep: it is said as it
    // stops, and told to its server ahead of the stop, so the server's stop keeps it.
    const last = await frozen(both, 2000);
    await h.wait(700);
    p.send({ t: 'stop' });
    assert.equal(await p.done, 0);
    const s = told(dir).find((x) => covers(x, last));
    assert.ok(s, 'told at the stop: ' + JSON.stringify(told(dir)));
    assert.ok(logOf(dir).includes(r.asleepWords(s)), 'and in watchdog.log');
  } finally { thawAll(both); if (p.exitCode === null) { p.kill('SIGKILL'); await p.done; } }
});

test('the throttle proxy on the real watchdog: awake a moment at a time past the hang\'s limit and past the crash count, never killed, one sleep said', { skip: FREEZE }, async () => {
  const dir = tmp('agm-throttle-');
  const p = watchdogOf(dir);
  let both = [];
  try {
    await h.until(() => pids(dir).length === 1, 5000, 'its server');
    await h.wait(400);
    both = [p.pid, pids(dir)[0]];
    // Eight times: today's watchdog kills each time and gives up after the seventh, exit 3, nothing serving.
    const freezes = [];
    for (let i = 0; i < 8; i++) { freezes.push(await frozen(both, 1500)); await h.wait(250); }
    assert.deepEqual(pids(dir), [both[1]], 'no kill, no restart:\n' + logOf(dir));
    await h.until(() => told(dir).length >= 1, 4000, 'the sleep said once awake');
    // One sleep from the first freeze to the last thaw, its parts each late tick (a wake too short to tick in is one part
    // with the next).
    const s = told(dir).find((x) => covers(x, { t0: freezes[0].t0, t1: freezes[7].t1 }));
    assert.ok(s && s.parts >= 2, 'one sleep across all eight: ' + JSON.stringify(told(dir)));
    const log = logOf(dir);
    assert.ok(!/no heartbeat|restarting|giving up/.test(log), log);
    assert.match(log, / times in a row, awake a moment between\): the watchdog did not run/);
    assert.ok(!fs.existsSync(path.join(dir, 'watchdog.json')), 'never given up');
    assert.equal(p.exitCode, null);
    p.send({ t: 'stop' });
    assert.equal(await p.done, 0);
  } finally { thawAll(both); if (p.exitCode === null) { p.kill('SIGKILL'); await p.done; } }
});

test('a real hang on the real watchdog: the server frozen alone, the watchdog on time, is still killed at the hang\'s limit and started again', { skip: FREEZE }, async () => {
  const dir = tmp('agm-hang-');
  const p = watchdogOf(dir, { AGM_LATE_MS: '2000' });   // the default: a loaded machine's tick is never taken for a sleep here
  let first = 0;
  try {
    await h.until(() => pids(dir).length === 1, 5000, 'its server');
    first = pids(dir)[0];
    process.kill(first, 'SIGSTOP');
    const t0 = Date.now();
    await h.until(() => pids(dir).length === 2, 6000, 'killed and started again');
    assert.ok(Date.now() - t0 >= 1000, 'not before the hang\'s limit');
    assert.ok(!alive(first), 'the frozen server was killed');
    const log = logOf(dir);
    assert.match(log, /no heartbeat for \d s — the server is not responding/);
    assert.match(log, /server not responding \(no heartbeat\) \[SIGKILL\] — restarting/);
    assert.ok(!log.includes('asleep from'), 'a hang is never a sleep:\n' + log);
    p.send({ t: 'stop' });
    assert.equal(await p.done, 0);
  } finally { thawAll([first]); if (p.exitCode === null) { p.kill('SIGKILL'); await p.done; } }
});

// ---------------------------------------------------------------- the server keeps them
/** The real watchdog and server on folders of their own; the admin token the test's. */
async function watchdogServer(base, env = {}) {
  const port = await h.freePort();
  const all = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05',
    AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys'), ...env };
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], { env: all, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { p.once('exit', (code) => resolve(code)); });
  const url = 'http://127.0.0.1:' + port;
  const health = async () => { try { return (await h.api(url, 'GET', '/api/health')).body; } catch { return null; } };
  await h.until(async () => { const b = await health(); return !!(b && b.sleeps); }, 20000, 'its server serving:\n' + out);
  return { p, out: () => out, done, url, port, health, dataDir: all.AGM_DATA_DIR };
}
/** The server the watchdog process `wd` runs now: its pid (Linux: /proc, each of the watchdog's threads' children). */
const serverPid = (wd) => {
  let tasks;
  try { tasks = fs.readdirSync('/proc/' + wd.pid + '/task'); } catch { return 0; }
  const kids = tasks.flatMap((tid) => read('/proc/' + wd.pid + '/task/' + tid + '/children').trim().split(/\s+/).filter(Boolean).map(Number));
  return kids.length === 1 ? kids[0] : 0;
};

test('the server keeps each sleep the watchdog tells it: in health beside the show day\'s peaks, on "This laptop", and across a restart', { skip: FREEZE }, async (t) => {
  const base = tmp('agm-sleepsrv-');
  // A tick late past 1.5 s (2 s after the one before): a stall of the watchdog under the run's load is not taken for a
  // sleep, the 5 s freeze is; the hang's limit of 4 s is past the longest silence a freeze it did not see as late leaves.
  const w = await watchdogServer(base, { AGM_HANG_MS: '4000', AGM_LATE_MS: '1500' });
  let both = [];
  t.after(async () => { thawAll(both); if (w.p.exitCode === null) { w.p.kill('SIGKILL'); await w.done; } });
  let hb = await w.health();
  assert.deepEqual(hb.sleeps, { watched: true, list: [] }, 'a server its watchdog runs: none yet');
  both = [w.p.pid, serverPid(w.p)];
  assert.ok(both[1] > 0, 'its server\'s pid');
  const f = await frozen(both, 5000);   // past the hang's 4 s with the server's beat a second apart
  await h.until(async () => { hb = await w.health(); return hb.sleeps.list.length === 1; }, 12000, 'the sleep in health');
  const s = hb.sleeps.list[0];
  assert.ok(covers(s, f) && s.parts === 1, JSON.stringify(s));
  assert.equal(hb.restarts, 0, 'never restarted');
  const today = hb.peaks.find((d) => d.day === hb.showDay);
  assert.deepEqual([today.sleeps, today.sleptMs], [1, s.to - s.from], 'counted on the show day it woke in, its length the day\'s longest');
  assert.equal(serverPid(w.p), both[1], 'the same server');
  // "This laptop", on the admin page's answer.
  const cookie = (await h.api(w.url, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const admin = await h.connect(w.url, cookie);
  t.after(() => admin.close());
  const row = (await h.answer(admin, 'admin:settings', null)).laptop.facts.find((x) => x.id === 'asleep');
  assert.deepEqual([row.label, row.words, row.mark], ['Sleeps', 'once today · the last ' + r.asleepWords(s), 'warn']);
  assert.ok(w.out().includes('[watchdog] ' + r.asleepWords(s)), 'and on the console');
  admin.close();
  // A stop saves them with the peaks, and the next start, run alone, still shows them.
  w.p.send({ t: 'stop' });
  assert.equal(await w.done, 0);
  both = [];
  const next = await h.startServer({ AGM_DATA_DIR: w.dataDir, AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys') });
  t.after(() => h.stopServer(next.child));
  const again = (await h.api(next.base, 'GET', '/api/health')).body;
  assert.deepEqual(again.sleeps, { watched: false, list: [s] }, 'kept across the restart; a server run alone is watched by none');
});

test('a sleep the server is told is read by type: anything else is kept nowhere', async (t) => {
  const srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const now = Date.now();
  for (const bad of [{ t: 'slept' }, { t: 'slept', from: now - 5000, to: now - 6000, parts: 1 }, { t: 'slept', from: now - 5000, to: now + 3_600_000, parts: 1 }, { t: 'slept', from: 'x', to: now, parts: 1 }, { t: 'slept', from: now - 5000, to: now, parts: -1 }]) srv.child.send(bad);
  srv.child.send({ t: 'slept', from: now - 5000, to: now - 1000, parts: 2 });
  let hb;
  await h.until(async () => { hb = (await h.api(srv.base, 'GET', '/api/health')).body; return hb.sleeps.list.length > 0; }, 3000, 'the one sleep that reads');
  assert.deepEqual(hb.sleeps, { watched: false, list: [{ from: now - 5000, to: now - 1000, parts: 2 }] });
  assert.equal(hb.peaks.find((d) => d.day === hb.showDay).sleeps, 1);
});

// ---------------------------------------------------------------- the power request, on a server
/** The stand-in's lines: each start and each input closed, with its pid; and the plan each start was made from. */
const powerLog = (file) => read(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const startsOf = (file) => powerLog(file).filter((x) => x.ev === 'started').map((x) => x.pid);
/** A server whose power request's powershell.exe is stood in for, answering `answer`. */
async function powerServer(answer = 'held', env = {}) {
  const log = path.join(tmp('agm-power-'), 'power.jsonl');
  const srv = await h.startServer({ NODE_OPTIONS: preload('power-preload.js'), AGM_TEST_POWER_LOG: log, AGM_TEST_POWER_ANSWER: answer, ...env });
  const health = async () => (await h.api(srv.base, 'GET', '/api/health')).body;
  const admin = (await h.setupAdmin(srv.base)).cookie;
  const hall = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  return { srv, log, health, admin, hall };
}
const powerIs = async (x, state, live) => {
  let p;
  await h.until(async () => { p = (await x.health()).power; return p.state === state && p.live === live; }, 5000, 'the power request ' + state + ' with ' + live + ' live: ' + JSON.stringify(p));
  return p;
};
const guest = async (x, name = 'Gwen') => {
  const s = await h.connect(x.srv.base);
  const j = await h.emit(s, 'join', { roomCode: x.hall, name, role: 'observer' });
  assert.equal(j.ok, true, JSON.stringify(j));
  return s;
};

test('a live show keeps the laptop awake: the child is started only while a hall is live (a page, a screen\'s take, a countdown), and ends when none is and with the server', async (t) => {
  const sw = await h.fakeStagewatch({ name: 'Hall 3 timer' });
  const x = await powerServer('held');
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await h.stopServer(x.srv.child); await sw.close(); });
  // Nothing live: nothing asked, whatever the board did meanwhile (a hall made).
  await h.wait(800);
  assert.deepEqual([startsOf(x.log), (await x.health()).power.state], [[], 'off']);
  // An open page seated in the hall.
  const g = await guest(x); sockets.push(g);
  await powerIs(x, 'held', 1);
  assert.equal(startsOf(x.log).length, 1);
  const plan = powerLog(x.log).find((l) => l.ev === 'plan').plan;
  assert.deepEqual([plan.file, plan.args[4], plan.options.cwd], ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', power.SCRIPT, 'C:\\Windows\\System32'], 'made for Windows by its absolute path');
  assert.ok(!JSON.stringify(plan.options.env).includes(h.TOKEN), 'no secret in its environment');
  const ctl = await h.connect(x.srv.base, x.admin); sockets.push(ctl);
  const awake = async () => (await h.answer(ctl, 'admin:settings', null)).laptop.facts.find((f) => f.id === 'awake');
  assert.deepEqual([(await awake()).words, (await awake()).mark], ['held while 1 hall is live (1 page open): Windows took the request to keep off idle sleep, which on battery a laptop with Modern Standby keeps 5 minutes at most · the lid and the power button still do what the power plan says', 'ok']);
  assert.match(x.srv.out(), / {2}\[power\] held while 1 hall is live: Windows took the request to keep off idle sleep\n/);
  // The admin's own page is in no hall: the page gone, nothing is live, and the child ends.
  const first = startsOf(x.log)[0];
  g.close();
  await powerIs(x, 'off', 0);
  await h.until(() => !alive(first), 3000, 'the child ended');
  assert.deepEqual([(await awake()).words, (await awake()).mark], ['not asked: no hall is live', 'off']);
  assert.match(x.srv.out(), / {2}\[power\] released: no hall is live\n/);
  // A screen that confirmed a take other than holding, with no page open: live. Back to holding: not.
  const made = await h.emit(ctl, 'display:create', { code: x.hall, name: 'Lectern monitor' });
  const screen = io(x.srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(screen);
  screen.on('display:state', (st) => screen.emit('display:shown', { seq: st.seq, ok: true, words: '' }));
  await h.until(() => screen.connected, 3000, 'the screen');
  await h.wait(500);
  assert.equal(startsOf(x.log).length, 1, 'a screen holding is not live');
  // A second browser on the same link that cannot show it takes nothing from the one that did.
  const failing = io(x.srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(failing);
  failing.on('display:state', (st) => failing.emit('display:shown', { seq: st.seq, ok: false, words: 'no room for it' }));
  await h.until(() => failing.connected, 3000, 'the second browser');
  assert.ok((await h.emit(ctl, 'display:take', { id: made.display.id, content: { kind: 'message', text: 'Five minutes', tone: 'warn' } })).ok);
  let p = await powerIs(x, 'held', 1);
  assert.deepEqual([p.what, startsOf(x.log).length], [{ pages: 0, screens: 1, countdowns: 0 }, 2]);
  assert.ok((await h.emit(ctl, 'display:take', { id: made.display.id, content: { kind: 'holding' } })).ok);
  await powerIs(x, 'off', 0);
  // The hall's Stagewatch countdown running (the fake's first frame), then held; past zero and counting on into overtime
  // it is still the show's, held at zero it is not.
  assert.ok((await h.emit(ctl, 'hall:configure', { code: x.hall, stagewatchUrl: sw.url })).ok);
  p = await powerIs(x, 'held', 1);
  assert.deepEqual([p.what, startsOf(x.log).length], [{ pages: 0, screens: 0, countdowns: 1 }, 3]);
  sw.frame({ state: 'paused' });
  await powerIs(x, 'off', 0);
  sw.frame({ state: 'running' });
  await powerIs(x, 'held', 1);
  sw.frame({ state: 'expired', seconds: -12 });
  await h.wait(600);
  await powerIs(x, 'held', 1);
  assert.equal(startsOf(x.log).length, 4, 'overtime: held on, never asked again');
  sw.frame({ state: 'expired', seconds: 0 });
  await powerIs(x, 'off', 0);
  // The default Stagewatch, which every hall without its own follows, is one countdown: two halls follow it, one is live.
  sw.frame({ state: 'running', seconds: 300 });
  assert.ok((await h.emit(ctl, 'hall:configure', { code: x.hall, stagewatchUrl: '' })).ok);
  assert.ok((await h.api(x.srv.base, 'POST', '/api/rooms', { name: 'Hall 4' }, { cookie: x.admin })).body.code);
  assert.ok((await h.emit(ctl, 'admin:settings', { stagewatchUrl: sw.url })).ok);
  p = await powerIs(x, 'held', 1);
  assert.deepEqual(p.what, { pages: 0, screens: 0, countdowns: 1 });
  // The server stops: the child ends with it.
  const last = startsOf(x.log)[4];
  assert.ok(alive(last));
  await h.stopServer(x.srv.child);
  await h.until(() => !alive(last), 3000, 'the child ended with the server');
});

test('the power request refused (Constrained Language Mode) is said, never asked again while live, and asked again at the next live show; a server killed ends it too', async (t) => {
  const x = await powerServer('refused');
  t.after(() => h.stopServer(x.srv.child));
  const a = await guest(x, 'Ann');
  const p = await powerIs(x, 'refused', 1);
  assert.equal(p.why, 'Windows refused it: PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type');
  const b = await guest(x, 'Bob');
  await powerIs(x, 'refused', 1);
  await h.wait(600);
  assert.equal(startsOf(x.log).length, 1, 'never in a loop');
  const ctl = await h.connect(x.srv.base, x.admin);
  const row = (await h.answer(ctl, 'admin:settings', null)).laptop.facts.find((f) => f.id === 'awake');
  assert.deepEqual([row.words, row.mark], ['not held while 1 hall is live (2 pages open): Windows refused it: PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type · asked again once no hall is live and one is again', 'warn']);
  ctl.close();
  a.close(); b.close();
  await powerIs(x, 'off', 0);
  const c = await guest(x, 'Cat');
  await h.until(() => startsOf(x.log).length === 2, 3000, 'asked again once live again');
  c.close();
  await h.stopServer(x.srv.child);
  // Held, then the server killed: its input closes, and the child ends of itself.
  const y = await powerServer('held');
  t.after(() => h.stopServer(y.srv.child));
  const d = await guest(y, 'Dee');
  t.after(() => d.close());
  await powerIs(y, 'held', 1);
  const pid = startsOf(y.log)[0];
  y.srv.child.kill('SIGKILL');
  await h.until(() => !alive(pid), 5000, 'the child ended with the server killed');
  if (process.platform !== 'win32') assert.ok(powerLog(y.log).some((l) => l.ev === 'input closed' && l.pid === pid), 'its input closed: the request ends with it');
});

test('off Windows a live hall\'s power request is not held, and says why', async (t) => {
  const srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const admin = (await h.setupAdmin(srv.base)).cookie;
  const hall = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const s = await h.connect(srv.base);
  t.after(() => s.close());
  assert.equal((await h.emit(s, 'join', { roomCode: hall, name: 'Gwen', role: 'observer' })).ok, true);
  let p;
  await h.until(async () => { p = (await h.api(srv.base, 'GET', '/api/health')).body.power; return p.live === 1; }, 3000, 'the hall live');
  if (process.platform !== 'win32') assert.deepEqual([p.state, p.why], ['unavailable', 'AGMessage is not running on Windows']);
});

// The real script, on Windows: it holds the request (the CI runner runs PowerShell in Full Language mode) and ends when its
// input closes.
test('on Windows, the script itself holds the request, and ends when its input closes', { skip: process.platform !== 'win32' && 'the script runs on Windows only' }, async () => {
  const p = power.plan(process.env);
  assert.equal(p.run, true, p.why);
  const child = spawn(p.file, p.args, { ...p.options, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const gone = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); });
  try {
    await h.until(() => /"(held|refused|failed)"/.test(out) || child.exitCode !== null, 60000, 'its answer');
    const lines = out.split(/\r?\n/).filter((l) => l.trim()).map((l) => power.readLine(l.trim()));
    assert.deepEqual(lines, [{ v: true }, { held: true }], out + err);
    await h.wait(500);
    assert.equal(child.exitCode, null, 'held while its input is open');
    child.stdin.end();
    assert.equal(await Promise.race([gone, h.wait(20000).then(() => 'still running')]), 0, 'its input closed, it ended: ' + err);
  } finally { if (child.exitCode === null) child.kill(); }
});
