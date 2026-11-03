'use strict';
// Resilience and Show Bus 1.1: the watchdog's policy and the watchdog itself, safe saves, sealed keys, the latency
// ring, the clock offset, hellos, receipts, the context (and what it must never contain), the Stagewatch link, and
// the guard rails on the source.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const r = require('../lib/resilience');
const nodes = require('../lib/nodes');
const { buildContext, showBrief } = require('../lib/context');

const ROOT = path.join(__dirname, '..');
const { filesUnder, handlerFiles, pageScripts, readSource } = require('./helpers');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; }

// ---------------------------------------------------------------- the watchdog's rules
test('watchdog policy: the first restart after 0.5 s, then backoff, reset after a good run, give up, intent in exit codes', () => {
  const p = new r.SupervisorPolicy();
  p.started(0);
  assert.deepEqual(p.exited(0, 1000), { action: 'stop', delayMs: 0, reason: 'stopped' });
  assert.equal(p.exited(3, 1000).action, 'stop', 'cannot start as configured: restarting would fail the same way');
  assert.deepEqual(p.exited(82, 1000), { action: 'restart', delayMs: 0, reason: 'restart requested' });
  const delays = [];
  let t = 1000;
  for (let i = 0; i < 6; i++) { p.started(t); t += 1000; delays.push(p.exited(70, t).delayMs); }
  assert.deepEqual(delays, [500, 4000, 8000, 15000, 30000, 30000], 'the first step 0.5 s, the rest as before');
  p.started(t); t += 1000;
  const g = p.exited(70, t);
  assert.equal(g.action, 'giveup', 'more than 6 crashes in 10 minutes');
  assert.match(g.reason, /7 times in 10 minutes/);

  const q = new r.SupervisorPolicy();
  q.started(0); q.exited(70, 1000); q.started(1000); q.exited(70, 2000);
  q.started(2000);
  assert.equal(q.exited(70, 2000 + 6 * 60_000).delayMs, 500, 'a run of 5 minutes or more starts the ladder again, at its first step');
  assert.match(q.exited(0, 0, true).reason, /not responding/, 'a hang is a crash whatever the code');
});

test('watchdog policy: a port or data folder held (code 75) is tried again on the ladder for as long as it is held, never counted as a crash', () => {
  const p = new r.SupervisorPolicy();
  let t = 0;
  const held = [];
  for (let i = 0; i < 20; i++) { p.started(t); t += 1000; held.push(p.exited(75, t)); }
  assert.ok(held.every((d) => d.action === 'restart'), 'never a give-up, however often: ' + JSON.stringify(held.map((d) => d.action)));
  assert.deepEqual(held.slice(0, 7).map((d) => d.delayMs), [500, 4000, 8000, 15000, 30000, 30000, 30000], 'the ladder\'s waits, the last repeating');
  assert.equal(held[0].reason, 'could not take its port or data folder, which another program holds (code 75)');
  assert.equal(p.crashes.length, 0, 'no crash counted');
  // Crashes after it are counted from none: the seventh in ten minutes gives up, as ever.
  for (let i = 0; i < 6; i++) { p.started(t); t += 1000; assert.equal(p.exited(70, t).action, 'restart'); }
  p.started(t); t += 1000;
  assert.equal(p.exited(70, t).action, 'giveup');
  assert.equal(r.EXIT.HELD, 75);
  assert.equal(new r.SupervisorPolicy().exited(75, 0, true).reason, 'not responding (no heartbeat)', 'a hang is a crash whatever the code');
});

// ---------------------------------------------------------------- the watchdog, for real (fake servers)
function fakeChild(dir, body) {
  const f = path.join(dir, 'child.js');
  fs.writeFileSync(f, `'use strict';
const fs = require('fs'); const path = require('path');
const runs = path.join(${JSON.stringify(dir)}, 'runs');
const n = (fs.existsSync(runs) ? Number(fs.readFileSync(runs, 'utf8')) : 0) + 1;
fs.writeFileSync(runs, String(n));
// As the server does: a stop asked over IPC, or the watchdog's channel closing, saves (here: a marker) and exits.
const saveAndGo = (why) => { fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'saved'), why); process.exit(0); };
process.on('message', (m) => { if (m && m.t === 'stop') saveAndGo('asked to stop'); });
process.on('disconnect', () => saveAndGo('the watchdog went away'));
const beat = () => setInterval(() => { if (process.connected) process.send({ t: 'beat' }, () => { /* the watchdog gone */ }); }, 100);   // as the server beats
${body}
`);
  return f;
}
function supervise(dir, child, extra = {}, { ipc = false } = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], {
    env: { ...process.env, AGM_CHILD: child, AGM_DATA_DIR: dir, AGM_BACKOFF: '0.05', AGM_HANG_MS: '1200', AGM_STARTUP_MS: '3000', ...extra },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.done = new Promise((res) => p.once('exit', (code) => res(code)));
  return p;
}
const runs = (dir) => (fs.existsSync(path.join(dir, 'runs')) ? Number(fs.readFileSync(path.join(dir, 'runs'), 'utf8')) : 0);

test('watchdog: a crash restarts the server', async () => {
  const dir = tmp('agm-wd-');
  const p = supervise(dir, fakeChild(dir, `if (n === 1) process.exit(70); beat();`));
  try {
    assert.ok(await until(() => runs(dir) >= 2), 'restarted after the crash:\n' + p.out);
    assert.match(fs.readFileSync(path.join(dir, 'watchdog.log'), 'utf8'), /stopped unexpectedly \(code 70\)/);
  } finally { p.kill(); await p.done; }
});

test('watchdog: a hung server (no heartbeat) is killed and restarted', async () => {
  const dir = tmp('agm-wd-');
  const p = supervise(dir, fakeChild(dir, `beat(); if (n === 1) setTimeout(() => { for (;;) {} }, 300);`));
  try {
    assert.ok(await until(() => runs(dir) >= 2, 10000), 'restarted after the hang:\n' + p.out);
    assert.match(fs.readFileSync(path.join(dir, 'watchdog.log'), 'utf8'), /no heartbeat/);
  } finally { p.kill(); await p.done; }
});

test('watchdog: stays stopped on a clean exit; gives up on a crash loop and leaves a marker', async () => {
  const d1 = tmp('agm-wd-');
  const clean = supervise(d1, fakeChild(d1, `process.exit(0);`));
  assert.equal(await clean.done, 0);
  assert.equal(runs(d1), 1);

  const d2 = tmp('agm-wd-');
  const loop = supervise(d2, fakeChild(d2, `process.exit(70);`));
  assert.equal(await loop.done, 3, 'gives up with "can\'t run as configured" so the launcher stops too');
  assert.equal(runs(d2), 7);
  const marker = JSON.parse(fs.readFileSync(path.join(d2, 'watchdog.json'), 'utf8'));
  assert.match(marker.reason, /7 times/);
});

test('watchdog: a server whose port or folder is held (75) is started again on the ladder, past where a crash loop gives up, and runs once it is free', async () => {
  const dir = tmp('agm-wd-');
  // Held nine times (seven crashes would give up), then it runs; asked to stop, it saves and goes.
  const p = supervise(dir, fakeChild(dir, `if (n <= 9) process.exit(75); beat();`), { AGM_HELD_LOG_EVERY: '4' }, { ipc: true });
  try {
    assert.ok(await until(() => runs(dir) >= 10, 15000), 'tried again each time:\n' + p.out);
    // Each held try's line, as the try it was: the first says no number, the rest say theirs.
    const held = (text) => text.split('\n').filter((l) => l.includes('could not take its port or data folder, which another program holds (code 75)') && l.includes(' — restarting'))
      .map((l) => { const m = / \(try (\d+)\)/.exec(l); return m ? Number(m[1]) : 1; });
    assert.deepEqual(held(p.out), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'each try said on the console:\n' + p.out);
    // The log takes the first try of a run and every fourth after it (a hundredth unless told): bounded while it is held.
    const log = fs.readFileSync(path.join(dir, 'watchdog.log'), 'utf8');
    assert.deepEqual(held(log), [1, 4, 8], log);
    assert.ok(!/giving up/.test(log) && !fs.existsSync(path.join(dir, 'watchdog.json')), 'never given up:\n' + log);
    await wait(300);
    assert.equal(p.exitCode, null, 'the watchdog runs its server');
    p.send({ t: 'stop' });
    assert.equal(await p.done, 0);
  } finally { if (p.exitCode === null) { p.kill(); await p.done; } }
});

test('watchdog: a stop asked of it lets its server save before it goes, on every platform', async () => {
  const dir = tmp('agm-wd-');
  const p = supervise(dir, fakeChild(dir, `beat(); fs.writeFileSync(path.join(path.dirname(runs), 'pid'), String(process.pid));`), {}, { ipc: true });
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'pid'))), 'started:\n' + p.out);
  p.send({ t: 'stop' });   // as Ctrl+C or the window closing reach it: the watchdog asks its server over IPC
  assert.equal(await p.done, 0);
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'saved')), 6000), 'the server saved before it went:\n' + p.out);
  assert.equal(fs.readFileSync(path.join(dir, 'saved'), 'utf8'), 'asked to stop');
});

test('watchdog: a signal to it leaves no server behind — asked to stop where signals reach it, ended with it on Windows', async () => {
  const dir = tmp('agm-wd-');
  const p = supervise(dir, fakeChild(dir, `beat(); fs.writeFileSync(path.join(path.dirname(runs), 'pid'), String(process.pid));`));
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'pid'))), 'started:\n' + p.out);
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  p.kill('SIGTERM');
  await p.done;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(await until(() => !alive(), 6000), 'no server outlives its watchdog');
  if (process.platform === 'win32') {
    // A signal ends the watchdog at once, and the job libuv puts every child in ends its server with it: no orphan, and
    // the watchdog never asks it to stop. Ending the watchdog also closes the server's channel, and which comes first is
    // Windows' to order: a server that hears its channel close before the job ends it saves, as a server whose watchdog
    // went away does; one ended first saves nothing. Ctrl+C and the window closing reach the server itself (SIGINT,
    // SIGHUP), so they save.
    const saved = fs.existsSync(path.join(dir, 'saved')) ? fs.readFileSync(path.join(dir, 'saved'), 'utf8') : '';
    assert.ok(['', 'the watchdog went away'].includes(saved), 'never asked to stop by a watchdog that was ended: ' + saved);
  } else {
    assert.equal(fs.readFileSync(path.join(dir, 'saved'), 'utf8'), 'asked to stop', 'a signalled watchdog asks its server; it does not kill it');
  }
});

test('a server whose watchdog has gone saves what is waiting and leaves, so no orphan holds the folder', async () => {
  const { startServer, api, TOKEN } = require('./helpers');
  const srv = await startServer();
  const setup = await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  assert.equal(setup.status, 200);
  const gone = new Promise((resolve) => { srv.child.once('exit', (code) => resolve(code)); });
  srv.child.disconnect();   // the watchdog ended without a word (Task Manager, a crash of its own)
  const code = await Promise.race([gone, new Promise((resolve) => { setTimeout(() => resolve('still running'), 5000); })]);
  assert.equal(code, 0, 'it stopped as asked to stop');
  const saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions.length, 1, 'the sign-in made a moment before (its lane writes after 500 ms) is on disk');
});

// The watchdog's first step is gated here. On Windows a killed server's port and its folder lock (a named pipe) are
// released by the system, and a start that found either still held would end with code 3, which stops the watchdog for
// good: so a server killed with a page connected, as a hang is killed, and started again after the first step must find
// both free and say it is running, 20 times in a row. It binds as the show laptop's does (every address, 0.0.0.0) and
// its page connects from the machine's network address, as a venue phone does, so the connection the kill leaves on the
// port is one the real bind meets. Elsewhere the lock is a socket file a killed server leaves behind, which the next
// start probes and takes over at once.
const KILLS = 20;
test('the watchdog\'s first step: killed 20 times with a page connected, the server started again after it finds the port and the folder free and runs each time', { skip: process.platform === 'win32' ? false : 'Windows releases what a killed process held: the test-windows job runs this, the first step\'s gate' }, async (t) => {
  const h = require('./helpers');
  const lan = require('../lib/tls').lanAddresses()[0];
  assert.ok(lan, 'this test needs a network address that is not loopback (every CI runner and show laptop has one)');
  const step = new r.SupervisorPolicy().exited(70, 1).delayMs;   // what the watchdog waits after a first crash
  assert.equal(step, 500);
  let srv = await h.startServer({ HOST: '0.0.0.0' });
  const { port, dataDir } = srv;
  t.after(async () => { if (srv.child.exitCode === null && srv.child.signalCode === null) await h.stopServer(srv.child); });
  const back = [];
  for (let i = 0; i < KILLS; i++) {
    const page = await h.connect('http://' + lan + ':' + port);   // a venue page holds a connection on the port at the kill
    const gone = new Promise((resolve) => { srv.child.once('exit', resolve); });
    srv.child.kill('SIGKILL');
    await gone;
    page.close();
    await wait(step);
    const from = Date.now();
    srv = await h.startServer({ HOST: '0.0.0.0', PORT: String(port), AGM_DATA_DIR: dataDir });   // throws with its window's words if it stops
    back.push(Date.now() - from);
    assert.match(srv.out(), /AGMessage \S+ is running/, 'start ' + (i + 1) + ' of ' + KILLS);
    assert.equal(srv.port, port, 'on the same port');
  }
  assert.equal(back.length, KILLS, 'every start after a kill ran: ' + back.join(', ') + ' ms');
});

// ---------------------------------------------------------------- safe saves
test('atomic writes keep a backup only of a whole file; the lane coalesces and flushes', async () => {
  const dir = tmp('agm-save-');
  const f = path.join(dir, 'settings.json');
  r.writeFileAtomic(f, '{"a":1}', { keepBak: true });
  r.writeFileAtomic(f, '{"a":2}', { keepBak: true });
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"a":1}');
  fs.writeFileSync(f, '{"a":3');   // torn by a power cut
  r.writeFileAtomic(f, '{"a":4}', { keepBak: true });
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"a":1}', 'a torn file never replaces a good backup');
  fs.writeFileSync(f, '{"torn');
  assert.deepEqual(r.readJsonWithBak(f), { a: 1 }, 'a torn file falls back to its backup');
  assert.ok(!fs.readdirSync(dir).some((x) => x.endsWith('.tmp')), 'no temporary files left behind');
  // A folder another program makes (its access list its own) is never made here: the write throws, and nothing is left.
  assert.throws(() => r.writeFileAtomic(path.join(dir, 'theirs', 'admin-token'), 'x', { makeDir: false }), { code: 'ENOENT' });
  assert.ok(!fs.existsSync(path.join(dir, 'theirs')), 'its folder is not made');
  fs.mkdirSync(path.join(dir, 'theirs'));
  r.writeFileAtomic(path.join(dir, 'theirs', 'admin-token'), 'one', { makeDir: false });
  r.writeFileAtomic(path.join(dir, 'theirs', 'admin-token'), 'two', { makeDir: false });
  assert.deepEqual([fs.readdirSync(path.join(dir, 'theirs')), fs.readFileSync(path.join(dir, 'theirs', 'admin-token'), 'utf8')], [['admin-token'], 'two'], 'replaced whole where it is');

  const lane = new r.WriteLane(path.join(dir, 'lane.json'), { delayMs: 50 });
  for (let i = 1; i <= 20; i++) lane.save(() => JSON.stringify({ i }));
  await wait(150);
  assert.equal(lane.writes, 1, 'twenty saves in a burst are one write');
  assert.equal(lane.coalesced, 19);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'lane.json'), 'utf8')), { i: 20 });
  lane.save(() => '{"i":21}');
  assert.ok(lane.flushSync(), 'shutdown writes what is pending at once');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'lane.json'), 'utf8')), { i: 21 });
});

test('every write lane made is counted, a lane of several files too, and one that never writes', () => {
  const dir = tmp('agm-built-');
  const before = r.WriteLane.built;
  const lanes = [new r.WriteLane(path.join(dir, 'a.json')), new r.WriteLane(path.join(dir, 'set'), { files: true })];
  assert.equal(r.WriteLane.built, before + 2, 'two lanes made, two counted');
  assert.deepEqual(lanes.map((l) => l.writes), [0, 0], 'counted when made, not when they write');
});

test('a lane whose write fails keeps the content, says so, retries on its own and lands it', async () => {
  const dir = tmp('agm-lane-');
  const f = path.join(dir, 'lane.json');
  fs.mkdirSync(f);   // a rename over a directory fails, as one over a file another program holds does on Windows
  const lane = new r.WriteLane(f, { delayMs: 20 });
  lane.save(() => '{"a":1}');
  await wait(100);
  assert.match(String(lane.lastError), /EISDIR|EPERM|ENOTEMPTY|EEXIST/, 'the failure is kept for health: ' + lane.lastError);
  assert.equal(lane.failures, 1);
  assert.equal(lane.writes, 0);
  fs.rmdirSync(f);
  assert.ok(await until(() => lane.writes === 1, 3000), 'retried without another save');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  assert.equal(lane.lastError, null);
  assert.equal(lane.failures, 0);

  // At shutdown: a flush that cannot write says so, and one that can writes the newest content.
  fs.renameSync(f, f + '.held'); fs.mkdirSync(f);
  lane.save(() => '{"a":2}');
  assert.equal(lane.flushSync(), false, 'a flush that cannot write says so');
  assert.equal(lane.failures, 3, 'tried three times');
  fs.rmdirSync(f);
  lane.save(() => '{"a":3}');
  assert.equal(lane.flushSync(), true, 'nothing left to write');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":3}');
});

/** Run `fn` while the disk fills part-way: the first write takes half of what it is given, every later one fails. */
function diskFillsPartway(fn) {
  const write = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, data, ...rest) => {
    if (calls++) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const off = Buffer.isBuffer(data) && typeof rest[0] === 'number' ? rest[0] : 0;
    const len = Buffer.isBuffer(data) && typeof rest[1] === 'number' ? rest[1] : b.length - off;
    return write.call(fs, fd, b, off, Math.max(1, Math.floor(len / 2)));
  };
  try { return fn(); } finally { fs.writeSync = write; }
}

test('a save the disk takes only part of never replaces the whole file, and gives its space back', () => {
  const dir = tmp('agm-full-');
  const f = path.join(dir, 'accounts.json');
  r.writeFileAtomic(f, '{"v":1}', { keepBak: true });
  r.writeFileAtomic(f, '{"v":2}', { keepBak: true });
  assert.throws(() => diskFillsPartway(() => r.writeFileAtomic(f, JSON.stringify({ v: 3, pad: 'x'.repeat(4000) }), { keepBak: true })), /ENOSPC/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}', 'the whole file stays');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"v":1}');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), [], 'the half-written temporary file is gone, and its space with it');

  // A lane: the cut write is a failure, kept and tried again, never a write that "landed".
  const lane = new r.WriteLane(f, { delayMs: 10_000 });
  lane.save(() => '{"v":4}');
  assert.equal(diskFillsPartway(() => lane.flushSync()), false, 'a flush the disk cuts short says so');
  assert.match(String(lane.lastError), /ENOSPC/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}');
  assert.equal(lane.flushSync(), true, 'and lands once the disk has room');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":4}');

  // A hall: a snapshot cut short is not taken for one, so its log is not emptied and nothing is lost.
  const { RoomStore } = require('../lib/store');
  const rooms = path.join(dir, 'rooms');
  const a = new RoomStore(rooms);
  const room = a.create('ABC234', 'Test');
  const say = (i) => a.commit(room, { o: 'add', m: { id: 'm' + i, type: 'text', text: 'line ' + i + ' ' + 'x'.repeat(200), at: i } });
  for (let i = 0; i < 20; i++) say(i);
  a.compact('ABC234');
  for (let i = 20; i < 40; i++) say(i);
  diskFillsPartway(() => a.compact('ABC234'));
  assert.match(String(a.lastError), /ENOSPC/, 'the failed snapshot is said');
  const b = new RoomStore(rooms);
  b.loadAll(null, { compact: false });
  assert.equal(b.get('ABC234').messages.length, 40, 'every message survives a restart');
});

test('room snapshots: a torn snapshot falls back to its backup, the log replays on top', () => {
  const { RoomStore } = require('../lib/store');
  const dir = tmp('agm-room-');
  const a = new RoomStore(dir);
  const room = a.create('ABC234', 'T');
  a.commit(room, { o: 'add', m: { id: 'm1', type: 'text', text: 'one', at: 1 } });
  a.compact('ABC234');
  a.commit(room, { o: 'add', m: { id: 'm2', type: 'text', text: 'two', at: 2 } });
  a.compact('ABC234');
  a.commit(room, { o: 'add', m: { id: 'm3', type: 'text', text: 'three', at: 3 } });
  fs.writeFileSync(path.join(dir, 'ABC234.json'), '{"code":"ABC2');   // torn snapshot
  const b = new RoomStore(dir);
  assert.equal(b.loadAll(), 1);
  const ids = b.get('ABC234').messages.map((m) => m.id);
  assert.ok(ids.includes('m1') && ids.includes('m3'), 'backup + log: ' + ids.join(','));
});

// ---------------------------------------------------------------- sealed keys
test('keys are sealed at rest with a machine key kept outside the app', () => {
  process.env.AGM_KEY_DIR = tmp('agm-key-');
  const box = require('../lib/secretbox');
  box._reset();
  const sealed = box.seal('swk_abc');
  assert.ok(box.isSealed(sealed) && !sealed.includes('swk_abc'));
  assert.equal(box.open(sealed), 'swk_abc');
  assert.equal(box.open('swk_abc'), '', 'a clear value is not a sealed one');
  assert.equal(box.open(sealed.slice(0, -4) + 'AAAA'), '', 'tampered → nothing');
  process.env.AGM_KEY_DIR = tmp('agm-key-');
  box._reset();
  assert.equal(box.open(sealed), '', 'another machine (another key) can\'t open it');
});

test('the machine key: while making waits it is read and never made, a missing one read as absent; once allowed it is made', () => {
  const box = require('../lib/secretbox');
  const dir = tmp('agm-key-');
  process.env.AGM_KEY_DIR = dir;
  box._reset();
  box.deferMaking();
  assert.deepEqual(box.keyState(), { state: 'absent' });
  assert.equal(box.hasKey(), false);
  assert.throws(() => box.seal('swk_abc'), (e) => e.code === 'ENOENT' && e.noKey === true);
  assert.deepEqual(box.keyProblem(), { code: 'ENOENT', words: 'the machine key at ' + path.join(dir, 'machine.key') + ' is not made yet' });
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written while making waits');
  box.allowMaking();
  assert.deepEqual(box.keyState(), { state: 'key' }, 'the first ask once allowed makes it');
  assert.deepEqual(fs.readdirSync(dir), ['machine.key']);
  assert.equal(box.open(box.seal('swk_abc')), 'swk_abc');
  // A key there is read while making waits; one that cannot be read is unusable, and left as it is.
  box._reset();
  box.deferMaking();
  assert.deepEqual(box.keyState(), { state: 'key' });
  const bad = tmp('agm-key-');
  fs.mkdirSync(path.join(bad, 'machine.key'));
  process.env.AGM_KEY_DIR = bad;
  box._reset();
  box.deferMaking();
  assert.deepEqual(box.keyState(), { state: 'unusable', code: 'EISDIR', words: 'the machine key at ' + path.join(bad, 'machine.key') + ' could not be read (EISDIR)' });
  box.allowMaking();
  assert.equal(box.keyState().state, 'unusable', 'never made over one that could not be read');
  assert.ok(fs.statSync(path.join(bad, 'machine.key')).isDirectory());
  box._reset();
});

// ---------------------------------------------------------------- latency and clocks
test('ring: percentiles over a fixed window; clock offset from the best round trip', () => {
  const ring = new r.Ring(4);
  for (const v of [10, 20, 30, 40, 1000]) ring.push(v);
  assert.equal(ring.count, 4);
  assert.deepEqual(ring.stats(), { count: 4, p50: 40, p95: 1000, max: 1000 });
  const c = new r.ClockSampler(8);
  // Peer 3 s ahead; one slow exchange (rtt 400) and one fast (rtt 20).
  c.add(1000, 4200, 4200, 1400);
  const best = c.add(2000, 5010, 5010, 2020);
  assert.deepEqual(best, { offsetMs: 3000, rttMs: 20, apart: true });
  assert.equal(new r.ClockSampler().add(0, 1, 1, -5), null, 'nonsense is ignored');
});

// ---------------------------------------------------------------- Show Bus: hellos, frames, receipts
test('hellos: every kind heard, ports read, nonsense dropped; live → stale → gone', () => {
  const h = nodes.parseHello({ t: 'patterns', v: 1, proto: 1, id: '9f8e7d6c', name: 'Patterns FOH', ports: { http: 9696, wire: 9697, evil: 1 }, caps: ['video', 'eye'], clock: 5 }, '10.0.0.9');
  assert.deepEqual(h.ports, { http: 9696, wire: 9697 });
  assert.equal(h.t, 'patterns');
  assert.equal(nodes.parseHello({ t: 'main', v: 1, id: 'a', web: 9924 }, 'x').ports.http, 9924, 'older hellos still read');
  for (const bad of [null, {}, { t: 'toaster', v: 1, id: 'x' }, { t: 'main', v: 2, id: 'x' }, { t: 'main', v: 1 }]) assert.equal(nodes.parseHello(bad, 'x'), null);
  assert.deepEqual([0, 5999, 6000, 11999, 12000].map(nodes.peerStatus), ['live', 'live', 'stale', 'stale', 'gone']);
});

test('stage view keeps the message id, the acknowledgement, the VT and the cue counts', () => {
  const v = nodes.stageView({
    type: 'state', mode: 'countdown', text: '05:00', speakerText: '5 MIN', title: 'Keynote', seq: 41, messageId: 12, messageAck: 'seen', messageAckBy: 'Sam',
    playout: { title: 'VT1', remaining: 42, duration: 90, running: true },
    signals: [{ state: 'sent', escalated: true }, { state: 'seen' }, { state: 'done' }],
  });
  assert.equal(v.messageId, 12);
  assert.equal(v.messageAckBy, 'Sam');
  assert.deepEqual(v.playout, { title: 'VT1', remaining: 42, running: true });
  assert.deepEqual(v.cues, { open: 2, waiting: 1, unanswered: 1 });
  assert.equal(v.seq, 41);
});

test('receipts: applied with a message id; an older Stagewatch only "accepted"; refusals say why', () => {
  assert.deepEqual(nodes.readReceipt(200, { type: 'receipt', id: 'a1', ok: true, stage: 'applied', effect: 'On screen', refs: { messageId: 12 } }, 'a1'),
    { ok: true, id: 'a1', stage: 'applied', effect: 'On screen', messageId: 12 });
  assert.equal(nodes.readReceipt(200, { ok: true }, 'a2').stage, 'accepted');
  const no = nodes.readReceipt(403, { ok: false, error: 'scope' }, 'a3');
  assert.equal(no.ok, false);
  assert.match(no.error, /scope/);
});

// ---------------------------------------------------------------- context: facts, and what it must never carry
test('context: lights and headline from facts; no message text, names, room names or codes', () => {
  const users = new Map([['s1', { name: 'Margaret Thatcher', role: 'board' }], ['s2', { name: 'Ana Lopez', role: 'research' }]]);
  const rooms = [{ code: 'QX7Z9A', name: 'Project Falcon AGM', users, messages: [
    { type: 'text', text: 'Capex was £4.2m', from: { name: 'Ana Lopez' } },
    { type: 'action', text: 'Refer to slide 14?', responses: [], at: 2 },
    { type: 'action', text: 'Adjourn?', responses: [{ name: 'Margaret Thatcher', optionIndex: 0 }], at: 1 },
    { type: 'file', filename: 'merger-terms.pdf' },
  ] }];
  const ctx = buildContext({
    node: { id: 'abcd1234', name: 'AGMessage' }, rooms,
    stage: { status: 'connected', view: { text: '5 MIN', title: 'Keynote' }, clock: { offsetMs: 2600, rttMs: 4, apart: true }, context: { node: { id: 'sw1' }, headline: 'Keynote · 5:00 left', light: 'green' } },
    peers: [{ t: 'main', id: 'sw1', name: 'Hall A', status: 'live', age: 1 }, { t: 'patterns', id: 'pt1', name: 'FOH', status: 'stale', age: 8 }],
    aiOn: false, tunnel: false, recent: [{ at: 1, text: 'research sent a message to the speaker\'s screen (applied)' }],
  });
  assert.equal(ctx.v, 1);
  assert.equal(ctx.light, 'amber', 'a prompt waiting and clocks apart');
  assert.match(ctx.headline, /1 action prompt waiting/);
  assert.match(ctx.headline, /CLOCKS APART/);
  assert.ok(ctx.items.some((i) => i.id === 'prompt:1' && /Refer to slide 14/.test(i.state)));
  assert.deepEqual(ctx.peers.map((p) => [p.t, p.light, p.headline]), [['main', 'green', 'Keynote · 5:00 left'], ['patterns', 'amber', 'not heard for 8 s']]);
  const text = JSON.stringify(ctx);
  for (const secret of ['Capex', 'Margaret', 'Ana', 'Falcon', 'QX7Z9A', 'merger-terms', 'Adjourn']) assert.ok(!text.includes(secret), 'context leaks ' + secret);
  assert.ok(ctx.items.find((i) => i.id === 'ai').state.includes('offline'), 'says what works without AI');

  const brief = showBrief({ status: 'connected', view: { title: 'Keynote', text: '5 MIN', message: 'Wrap up', messageAck: 'seen', playout: { title: 'VT1', remaining: 30 } }, context: { node: { id: 'sw1' }, headline: 'Keynote · 5:00 left', light: 'green', peers: [{ t: 'patterns', name: 'FOH', headline: 'Programme: VT1', light: 'green' }] } }, []);
  assert.match(brief, /Stage timer \(Stagewatch, live\): Keynote — 5 MIN/);
  assert.match(brief, /peer patterns "FOH": Programme: VT1/);
});

// ---------------------------------------------------------------- the Stagewatch link, Show Bus 1.1
test('Stagewatch link: header key, receipts with the message id, clock offset, context both ways, no queueing when down', async () => {
  const http = require('http');
  const { WebSocketServer } = require('ws');
  const seen = { posts: [], contexts: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/context') return res.end(JSON.stringify({ v: 1, node: { t: 'main', id: 'sw1', name: 'Hall A' }, light: 'green', headline: 'Keynote · 5:00 left', peers: [] }));
      if (req.url === '/api/peers/context') { seen.contexts.push(JSON.parse(body)); return res.end('{"ok":true}'); }
      seen.posts.push({ url: req.url, id: req.headers['x-request-id'], auth: req.headers.authorization });
      res.end(JSON.stringify({ type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', effect: 'Message on the speaker screen', refs: { messageId: 12 } }));
    });
  });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  const sockets = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', seq: 1, messageId: 12, messageAck: 'sent' }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.cmd === 'ping') { const now = Date.now() + 3000; ws.send(JSON.stringify({ type: 'pong', t: m.t, t2: now, t3: now })); }   // Stagewatch's clock 3 s ahead
    });
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const contexts = [];
  const link = new nodes.StagewatchLink({ nodeId: 'ab12cd34', onContext: (c) => contexts.push(c) });
  try {
    link.configure('127.0.0.1:' + port, 'swk_node');
    assert.ok(await until(() => link.linked));
    const rc = await link.sendToStage('Two minutes', { urgency: 'warn' });
    assert.deepEqual([rc.ok, rc.stage, rc.messageId], [true, 'applied', 12]);
    assert.match(seen.posts[0].id, /^ag[0-9a-f]{12}$/, 'a request id travels with the command');
    assert.equal(seen.posts[0].auth, 'Bearer swk_node');
    assert.ok(await until(() => contexts.length > 0), 'fetches Stagewatch\'s context on connect');
    assert.equal(link.context.headline, 'Keynote · 5:00 left');
    assert.ok(await until(() => link.clockInfo() !== null, 4000), 'pongs give a clock offset');
    const clock = link.clockInfo();
    assert.ok(Math.abs(clock.offsetMs - 3000) < 200 && clock.apart, 'offset ' + JSON.stringify(clock));
    assert.ok(await link.pushContext({ v: 1, node: { t: 'messenger', id: 'x' } }));
    assert.equal(seen.contexts[0].node.t, 'messenger');

    // The link goes quiet: stale after 6 s is a long test, so drop it outright — a send fails at once, nothing queued.
    for (const s of sockets) s.terminate();
    wss.close();
    assert.ok(await until(() => !link.linked));
    const t0 = Date.now();
    const down = await link.sendToStage('Hello');
    assert.equal(down.ok, false);
    assert.match(down.error, /not sent \(nothing is queued/);
    assert.ok(Date.now() - t0 < 100, 'fails at once');
    assert.equal(seen.posts.length, 1);
  } finally { link.stop(); wss.close(); srv.close(); }
});

// ---------------------------------------------------------------- guard rails on the source
test('guard rails: no eval, no key in a URL, and synchronous file calls only where they were judged safe', () => {
  // Read by folder, so a file added anywhere in them is held too: lib/ and verify/ in every folder below them, and every
  // page script (the vendored libraries are their packages' bytes, held by test/vendor.test.js).
  const files = ['server.js', 'supervise.js', ...filesUnder('lib', /\.[cm]?js$/), ...filesUnder('verify', /./), ...pageScripts()];
  assert.ok(files.includes('verify/auditrules.js'), 'the audit log\'s key-free rules are read too');
  for (const f of ['public/common.js', 'public/display.js', 'public/halls.js', 'public/theme-init.js', 'public/users.js', 'public/audit-export.js']) assert.ok(files.includes(f), 'every page script is read: ' + f);
  assert.ok(!files.some((f) => f.startsWith('public/vendor/')), 'and no vendored library');
  const planted = tmp('agm-rail-');
  try {
    fs.mkdirSync(path.join(planted, 'lib', 'handlers'), { recursive: true });
    fs.mkdirSync(path.join(planted, 'public', 'vendor'), { recursive: true });
    for (const f of ['lib/handlers/rooms.js', 'public/menus.js', 'public/pagelayer.mjs', 'public/vendor/lib.min.js', 'public/styles.css']) fs.writeFileSync(path.join(planted, f), '');
    assert.deepEqual([...filesUnder('lib', /\.[cm]?js$/, { root: planted }), ...pageScripts(planted)], ['lib/handlers/rooms.js', 'public/menus.js', 'public/pagelayer.mjs'], 'a file in a folder below lib/ and a page module are read; a vendored one and a stylesheet are not');
  } finally { fs.rmSync(planted, { recursive: true, force: true }); }
  // The export, the split and the verifier run beside the show or on another computer, all asynchronous: none may hold
  // the loop. (The split's four small files go through writeFileAtomic, once per split.)
  for (const f of ['lib/auditexport.js', 'lib/auditarchive.js', 'lib/zip.js', 'verify/verify-audit.js', 'verify/page.js']) assert.ok(files.includes(f), f + ' is read, at 0 synchronous calls');
  // Synchronous fs calls block every meeting on the server while they run. These are allowed — each with its reason —
  // and the count may not grow without someone deciding it here.
  const allowed = {
    'server.js': { max: 15, why: 'the first writes once the folder is held (its folders, the watchdog\'s marker seen), the crash handler, upload sniffing (4 KB), tunnel log tail, this copy\'s own cloudflared looked for as the link is asked to start, so a copy without it is refused with why before anything runs or an end is kept (and, through its lane, the show desk results a tick collects, flushed once before they are reported)' },
    'supervise.js': { max: 2, why: 'the watchdog process: its data folder made and its own log line (watchdog.log), never on a request (its record of how it ended, watchdog.json, and the installed node\'s token file, once its server serves, go through lib/resilience.js\'s atomic writer)' },
    'lib/store.js': { max: 10, why: 'durability: a change is appended to its log (the system\'s file cache) before the ack, or kept for the next snapshot when the disk refuses it; snapshots every 500 ops' },
    'lib/resilience.js': { max: 13, why: 'the atomic writer itself, and the temporary file of a write that failed removed so a full disk is not kept full; a file read with why it was not (readText), every store\'s read; a file made only where none is (publishOnce: its link, which refuses one there, and its temporary file removed); a folder\'s real path, read once per place at start (placeId)' },
    'lib/secretbox.js': { max: 3, why: 'the machine key, read once, or made once and published whole' },
    'lib/laststop.js': { max: 4, why: 'once a start, after the hold: the last stop\'s record moved aside (or removed where it cannot be), and the data and rooms folders listed for the temporary files a stop cut short left, each removed; the record itself goes through lib/resilience.js\'s atomic writer, at the stop' },
    'lib/serverlog.js': { max: 4, why: 'the watchdog\'s process alone, never the server\'s: a console line appended to server.log as it is said, so a line said just before the watchdog ends is on disk; its folder made and its size read once, and a rename when it reaches its bound' },
    'lib/version.js': { max: 8, why: 'the version and its stamp (or the checkout\'s commit), read once at startup' },
    'lib/dataformat.js': { max: 8, why: 'the data folder\'s format, once a start: read through to tell a new folder from a 0.5 one, and a folder of a lower format copied whole into backups/ (a copy a stop left part way removed, its size and the disk\'s free space read, its folder made, a partial copy made, renamed whole, or removed when it failed, the watchdog\'s beat sent while it runs) before anything else is written in it, never on a request' },
    'lib/audit.js': { max: 11, why: 'the audit trail: an entry is on disk (fsync) before the action is acknowledged, a short write cut back, the file rotated at 20 MB; read once at startup, and the records outside the data folder, read once at open; verify reads asynchronously in slices' },
  };
  for (const f of files) {
    const src = readSource(path.join(ROOT, f));
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), f + ': no eval / new Function');
    // `fs.realpathSync.native(` is a synchronous call too.
    const sync = (src.match(/\bfs\.\w+Sync(?:\.native)?\s*\(/g) || []).length;
    const rule = allowed[f] || { max: 0 };
    assert.ok(sync <= rule.max, `${f}: ${sync} synchronous fs calls (allowed ${rule.max}${rule.why ? ': ' + rule.why : ''})`);
  }
  const nodesSrc = readSource(path.join(ROOT, 'lib/nodes.js'));
  assert.ok(!/[?&]pin=/.test(nodesSrc), 'no key in a WebSocket URL (Show Bus §7)');
});

/** A timer started: `setTimeout(` or `setInterval(`, bare or as a member, a space before its bracket or not. */
const TIMER_CALLS = /\bset(?:Timeout|Interval)\s*\(/g;
test('guard rails: the timers the handler files start are counted, each with its reason; a state frame is a Latest, never a tick of its own', () => {
  // Every timer a handler file starts, in the file's order, each with why it is a timer. A new hand-written tick moves
  // this list, with its words; a new state frame (latest wins) is a Latest (lib/latest.js), whose timers are its own.
  const TIMERS = {
    'server.js': [
      'health: the loop\'s delay, how busy it is, the sockets and the day\'s peaks, every 5 s',
      'the boot\'s saved seats let go once its first seconds are over, once',
      'uploads nobody posted removed once past their wait',
      '0.5.1\'s pages told to reload once none of 0.5.1\'s files can still be fresh in a browser\'s cache, once a start',
      'a tunnel socket that has not joined a room within its wait let go, one per such socket',
      'a page that dropped is announced as gone only once the Wi-Fi grace is over, one per page',
      'a screen link not in use: told, then let go a moment later',
      'a screen whose link went: told, then let go a moment later',
      'an account changed: its pages told, then let go a moment later',
      'expired sign-ins swept',
      'the show desk: what it approved run and reported, one request at a time, every 3 s',
      'each linked Stagewatch\'s context, posted on change and at least every 5 s, looked at each second',
      'cloudflared\'s log read for the tunnel\'s address, and its registered connection, until it has both (the wait below at most, once it has the address)',
      'the tunnel given 30 s to name its address, and its link checked then when cloudflared never said its connection is registered',
      'the watchdog\'s heartbeat, from the event loop, each second',
      'the banner\'s Token line: the watchdog given 2 s to say it, once a start',
    ],
  };
  const files = handlerFiles();
  assert.deepEqual(Object.keys(TIMERS).filter((f) => !files.includes(f)), [], 'every file with a list is a handler file');
  for (const f of files) {
    const timers = (readSource(path.join(ROOT, f)).match(TIMER_CALLS) || []).length;
    const why = TIMERS[f] || [];
    assert.equal(timers, why.length, `${f}: ${timers} timers started, ${why.length} with a reason (${why.join('; ') || 'none'}): a state frame is a Latest; a tick of its own moves this list, with its words`);
  }
  // The read sees a timer in each form it can be written, and nothing else.
  const count = (src) => (src.match(TIMER_CALLS) || []).length;
  assert.equal(count('setTimeout(f, 1); setInterval (g, 2); global.setTimeout(h); timers.setInterval(i, 3);'), 4);
  assert.equal(count('clearTimeout(t); clearInterval(t); resetTimeout(t); const { setTimeout } = timers; new Latest({ name: "x", delayMs: 100, flush });'), 0);
  // The state frames that exist go through the one primitive, each by its name in health's `latest`.
  const server = readSource(path.join(ROOT, 'server.js'));
  assert.deepEqual([...server.matchAll(/new Latest\(\{\s*name: '([^']+)'/g)].map((m) => m[1]), ['board', 'screens', 'people', 'seen', 'rooms']);
});

// ---------------------------------------------------------------- the stylesheet's tokens
/** A stylesheet's declaration blocks, comments taken out: each innermost `{…}` with the selector before it. */
const cssBlocks = (src) => [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
/** A colour written as hex: #rgb, #rgba, #rrggbb or #rrggbbaa, and not the start of a longer word. */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const TOKEN_BLOCKS = [':root', 'html[data-theme="dark"]'];
/** The hex colours of a stylesheet outside its two token blocks, and how many of each token block it has. */
function hexOutsideTokens(src) {
  const blocks = cssBlocks(src);
  const tokens = Object.fromEntries(TOKEN_BLOCKS.map((t) => [t, blocks.filter((b) => b.selector === t).length]));
  const outside = blocks.filter((b) => !TOKEN_BLOCKS.includes(b.selector)).reduce((n, b) => n + (b.body.match(HEX) || []).length, 0);
  return { outside, tokens };
}
/**
 * An opacity between 0 and 1 (hidden and shown are 0 and 1), as `opacity:` or a filter's `opacity()`, written as a number
 * or a percentage: muted ink made by fading, refused. A value the guard cannot read as a number (a `var()`, a `calc()`)
 * is refused with it, so another spelling of a fade never passes.
 */
const OPACITY = /(?:^|[;\s{])opacity\s*:\s*([^;}]*)|(?:^|[^\w-])opacity\(\s*([^)]*)\)/g;
function faded(value) {
  const n = /^(\d*\.?\d+)(%?)$/.exec(value.replace(/\s*!important\s*$/i, '').trim());
  if (!n) return true;
  const x = Number(n[1]) / (n[2] ? 100 : 1);
  return x > 0 && x < 1;
}
const fadedIn = (src) => cssBlocks(src).flatMap((b) => [...b.body.matchAll(OPACITY)].filter((m) => faded(m[1] === undefined ? m[2] : m[1])).map(() => b.selector));
test('guard rails: the stylesheet draws with its tokens: hex colours only in the two token blocks, counted down, and no ink made muted by opacity', () => {
  // Every colour is named once in :root and once more under html[data-theme="dark"]; a component reads a token. The hex
  // colours still written outside those two blocks are counted, and the count only goes down: a unit that takes some
  // out lowers HEX_CAP with them, and none raises it (as the coverage gate only goes up). Muted words and icons read in
  // --c-ink-muted, at 4.5:1 for words and 3:1 for icons in both themes; an opacity between 0 and 1 fades whatever
  // is under it below that, so none is written (a toast or a switch hidden at 0 and shown at 1 is not muted ink).
  const HEX_CAP = 265;
  const css = readSource(path.join(ROOT, 'public', 'styles.css'));
  const { outside, tokens } = hexOutsideTokens(css);
  assert.deepEqual(tokens, { ':root': 1, 'html[data-theme="dark"]': 1 }, 'the tokens are defined in one :root block and redefined in one dark block');
  assert.ok(outside <= HEX_CAP, `styles.css writes ${outside} hex colours outside its token blocks, more than ${HEX_CAP}: a new colour is a token`);
  assert.deepEqual(fadedIn(css), [], 'no opacity between 0 and 1 in styles.css: muted words and icons take --c-ink-muted');
  // The reads see what they are for, and nothing else.
  const planted = ':root { --a: #fff; --b: #12345678; }\nhtml[data-theme="dark"] { --a: #000; }\n/* #abcdef */ .x { color: #FFF; background: url(#frag); }\n#feed { border: 1px solid #c0ffee; }\n@media (x) { .y { color: #1234; } }\n@keyframes k { 50% { opacity: .5 } }\n.t { opacity: 0 } .u { opacity: 1; } .v{opacity:.35} .w { transition: opacity .25s; will-change: opacity }\n' +
    '.a{opacity:60%} .b{opacity: var(--fade)} .c{filter: blur(1px) opacity(.4)} .d{opacity: calc(.5)} .e{opacity:100%} .f{filter:opacity(1)} .g{opacity:0 !important} .h{--x-opacity: .5}';
  assert.deepEqual(hexOutsideTokens(planted), { outside: 3, tokens: { ':root': 1, 'html[data-theme="dark"]': 1 } }, 'one in .x, one in #feed (not the selector), one in @media; none in a token block or a comment');
  assert.equal(hexOutsideTokens(planted + '\n:root { --c: #111; }').tokens[':root'], 2, 'a second :root block is seen');
  assert.deepEqual(fadedIn(planted), ['50%', '.v', '.a', '.b', '.c', '.d'],
    'an opacity between 0 and 1 is found wherever and however it is written (a number, a percentage, a filter\'s opacity(), or a value it cannot read); 0, 1, 100%, a transition of opacity and a property named for it are not');
});

// ---------------------------------------------------------------- the page floor (Safari 14.1, Chrome 84; docs/DEVICES.md)
/** `.showModal(` calls in a source: a dialog opened past AGM.openDialog, which a browser below Safari 15.4 cannot open. */
const showModalCalls = (src) => (src.match(/\.showModal\s*\(/g) || []).length;
test('guard rails: a dialog opens through AGM.openDialog, which still opens it where showModal() is missing; no page script calls showModal() itself', () => {
  // common.js's one call is the helper's own; every other page script, the hall page's included, holds none.
  const counted = {};
  for (const f of pageScripts()) {
    const n = showModalCalls(readSource(path.join(ROOT, f)));
    if (n) counted[f] = n;
  }
  assert.deepEqual(counted, { 'public/common.js': 1 }, 'showModal() only in common.js\'s AGM.openDialog');
  // The hall page and the admin page load common.js before their own scripts (deferred alike on the hall page), so
  // AGM.openDialog and the one toast are there when they run.
  for (const [page, own] of [['app.html', '/app.js'], ['admin.html', '/admin.js']]) {
    const scripts = [...readSource(path.join(ROOT, 'public', page)).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.indexOf('/common.js') > 0 && scripts.indexOf('/common.js') < scripts.indexOf(own), page + ' loads common.js before ' + own);
  }
  const common = readSource(path.join(ROOT, 'public', 'common.js'));
  assert.match(common, /function openDialog\(dlg\) \{\s*if \(!dlg\) return;\s*if \(typeof dlg\.showModal === 'function'\) \{ dlg\.showModal\(\); return; \}/, 'common.js calls showModal() only behind its probe, in AGM.openDialog');
  // The read sees a call however it is spaced, and nothing that only names it.
  assert.equal(showModalCalls('d.showModal(); $("x").showModal (); typeof d.showModal === "function"; d.showModalLater(); // showModal'), 2);
});

/** What makes a toast of a page's own in a source (comments out): the toast's class or its id named. A page's other status
 * regions (a chip's words to a screen reader, a dialog's progress) are no toast: each says one thing in its own place. */
const ownToast = (src) => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [/['"`]agm-toast\b/, /['"`]agmToast['"`]/].filter((re) => re.test(code)).map(String);
};
test('guard rails: a page has one toast, AGM.toast (common.js), and no page script makes a toast of its own', () => {
  const own = {};
  for (const f of pageScripts()) {
    const found = ownToast(readSource(path.join(ROOT, f)));
    if (found.length) own[f] = found;
  }
  assert.deepEqual(Object.keys(own), ['public/common.js'], 'only common.js makes the toast (' + JSON.stringify(own) + ')');
  // The stylesheet draws the one toast: `.agm-toast` is its only toast class.
  const css = readSource(path.join(ROOT, 'public', 'styles.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...new Set(css.match(/\.[a-z-]*toast[a-z-]*/g))].sort(), ['.agm-toast', '.toast-undo']);
  // The read sees a toast made by hand, and nothing that only calls the one toast or says the word in a comment.
  assert.equal(ownToast("const t = document.createElement('div'); t.className = 'agm-toast';").length, 1);
  assert.equal(ownToast("box.setAttribute('role', 'status'); box.id = \"agmToast\"; box.className = `agm-toast show`;").length, 2);
  assert.deepEqual(ownToast("AGM.toast('Copied.'); // a toast ('agm-toast') of the page's own is refused"), []);
});

/** A stylesheet's style rules, comments taken out: each with its selector, its declarations in order, the at-rules it sits in, and whether it holds a rule of its own (nesting). */
function cssRules(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const open = [];   // the blocks open around the reader: {prelude, nested}
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      const inner = open[open.length - 1];
      if (inner && !inner.prelude.startsWith('@') && !/^(?:from|to|[\d.]+%)/.test(inner.prelude)) inner.nested = true;
      open.push({ prelude: buf.trim(), nested: false });
      buf = '';
    } else if (ch === '}') {
      const block = open.pop();
      if (block && (!block.prelude.startsWith('@') || buf.includes(':'))) {
        const decls = buf.split(';').map((d) => d.trim()).filter((d) => d.includes(':'))
          .map((d) => ({ prop: d.slice(0, d.indexOf(':')).trim().toLowerCase(), value: d.slice(d.indexOf(':') + 1).trim() }));
        rules.push({ selector: block.prelude, decls, within: open.map((b) => b.prelude).filter((p) => p.startsWith('@')), nested: block.nested });
      }
      buf = '';
    } else buf += ch;
  }
  return rules;
}
/** The parts of a selector list, split at its own commas (not those inside a :has() or :not()). */
function selectorParts(list) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}
// Each feature of the stylesheet above the page floor, with its fallback. A new one joins this list with its fallback, by
// an edit here that says which browsers drop it.
const NEW_VIEWPORT = /\d[dsl]v(?:h|w|i|b|min|max)\b/;   // dvh, svh, lvh and their kin: Safari 15.4, Chrome 108
const NEW_VALUES = /\b(?:color-mix|light-dark)\(/;      // color-mix(): Safari 16.2, Chrome 111; light-dark(): Safari 17.5, Chrome 123
const NEW_SELECTORS = [':focus-visible', ':has('];      // Safari 15.4; Chrome 86 and 105
const NEW_PROPS = ['text-wrap'];                        // Safari 17.4, Chrome 114: a plain declaration of it first, or @supports
// inset and the logical properties: Safari 14.1 but Chrome 87, so Chrome 84 to 86 drop them; each follows its physical sides.
const PHYSICAL = {
  inset: [['top'], ['right'], ['bottom'], ['left']],
  'inset-inline': [['left'], ['right']], 'inset-block': [['top'], ['bottom']],
  'margin-inline': [['margin-left', 'margin'], ['margin-right', 'margin']], 'margin-block': [['margin-top', 'margin'], ['margin-bottom', 'margin']],
  'padding-inline': [['padding-left', 'padding'], ['padding-right', 'padding']], 'padding-block': [['padding-top', 'padding'], ['padding-bottom', 'padding']],
  'border-inline': [['border-left', 'border'], ['border-right', 'border']], 'border-block': [['border-top', 'border'], ['border-bottom', 'border']],
};
/** What a stylesheet asks of a browser above the page floor without a fallback a browser at the floor reads: one line each. */
function floorFaults(src) {
  const faults = [];
  for (const { selector, decls, within, nested } of cssRules(src)) {
    const supported = within.some((w) => w.startsWith('@supports'));
    if (nested) faults.push(`${selector}: a nested rule (Safari 16.5, Chrome 112)`);
    if (within.some((w) => w.startsWith('@container')) && !supported) faults.push(`${selector}: inside @container (Safari 16, Chrome 105) and not inside @supports`);
    const parts = selectorParts(selector);
    for (const feature of NEW_SELECTORS) {
      const has = parts.filter((p) => p.includes(feature)).length;
      if (has && has < parts.length) faults.push(`${selector}: ${feature} shares its selector list with a selector the floor reads`);
    }
    decls.forEach(({ prop, value }, i) => {
      const before = decls.slice(0, i);
      const plainBefore = (test) => before.some((d) => d.prop === prop && !test(d.value));
      if (NEW_VIEWPORT.test(value) && !plainBefore((v) => NEW_VIEWPORT.test(v))) faults.push(`${selector}: ${prop}: ${value} has no ${prop} in vh before it`);
      if (NEW_VALUES.test(value) && !supported && !plainBefore((v) => NEW_VALUES.test(v))) faults.push(`${selector}: ${prop}: ${value} has no plain ${prop} before it`);
      if (NEW_PROPS.includes(prop) && !supported && !plainBefore(() => false)) faults.push(`${selector}: ${prop} has no plain ${prop} before it and is not inside @supports`);
      if (PHYSICAL[prop]) {
        const missing = PHYSICAL[prop].filter((names) => !before.some((d) => names.includes(d.prop))).map((names) => names[0]);
        if (missing.length) faults.push(`${selector}: ${prop} without ${missing.join(', ')} before it`);
      }
    });
  }
  return faults;
}
test('guard rails: the stylesheet holds on every browser from the page floor: each newer feature follows its fallback, and a newer selector stands in a rule of its own', () => {
  // A browser drops a declaration it cannot read (the one before it then holds) and a whole rule whose selector list holds
  // a selector it cannot read (https://developer.mozilla.org/en-US/docs/Web/CSS/Selector_list).
  const css = readSource(path.join(ROOT, 'public', 'styles.css'));
  assert.deepEqual(floorFaults(css), [], 'styles.css: every feature above the page floor follows its fallback (docs/DEVICES.md)');
  const read = cssRules(css);
  assert.ok(read.length > 500 && read.some((r) => r.within.some((w) => w.startsWith('@media'))), `the reader reads the whole sheet, its @media rules too (${read.length} rules)`);
  // The read finds each fault the floor would meet, and passes each fallback.
  const planted = [
    '.a { height: 100dvh; }',
    '.b { height: 100vh; height: 100dvh; }',
    '.c { max-height: min(calc(100dvh - 2rem), 52rem); }',
    '.d, .e:focus-visible { outline: 0; }',
    '.f:focus-visible, .g:focus-visible { outline: 0; }',
    'input:focus { outline: 0; } button:focus-visible { outline: 0; }',
    '.h:has(input:checked), .i { color: red; }',
    '.j:has(a, b) { color: red; }',
    '.k { background: color-mix(in srgb, red 5%, blue); }',
    '.l { background: var(--card); background: color-mix(in srgb, red 5%, blue); }',
    '.m { color: light-dark(#000, #fff); }',
    '@supports (color: color-mix(in srgb, red, blue)) { .n { color: color-mix(in srgb, red, blue); } }',
    '.o { text-wrap: balance; }',
    '@container (min-width: 20rem) { .p { color: red; } }',
    '.q { position: fixed; inset: 0; }',
    '.r { top: 0; right: 0; bottom: 0; left: 0; inset: 0; }',
    '.s { margin-inline: auto; }',
    '.t { margin: 0 auto; margin-inline: auto; padding-left: 1px; padding-inline: 1px; }',
    '.u { box-shadow: inset 0 0 0 1px red; padding: env(safe-area-inset-left); }',
    '.v { color: red; .w { color: blue; } }',
    '@media (max-width: 30rem) { .x { height: 100svh; } }',
    '@keyframes k { from { top: 0; } 50% { top: 1px; } to { top: 2px; } }',
  ].join('\n');
  assert.deepEqual(floorFaults(planted), [
    '.a: height: 100dvh has no height in vh before it',
    '.c: max-height: min(calc(100dvh - 2rem), 52rem) has no max-height in vh before it',
    '.d, .e:focus-visible: :focus-visible shares its selector list with a selector the floor reads',
    '.h:has(input:checked), .i: :has( shares its selector list with a selector the floor reads',
    '.k: background: color-mix(in srgb, red 5%, blue) has no plain background before it',
    '.m: color: light-dark(#000, #fff) has no plain color before it',
    '.o: text-wrap has no plain text-wrap before it and is not inside @supports',
    '.p: inside @container (Safari 16, Chrome 105) and not inside @supports',
    '.q: inset without top, right, bottom, left before it',
    '.s: margin-inline without margin-left, margin-right before it',
    '.t: padding-inline without padding-right before it',
    '.v: a nested rule (Safari 16.5, Chrome 112)',
    '.x: height: 100svh has no height in vh before it',
  ], 'each newer feature without its fallback is found, and each with it (or inside @supports) passes');
});

// ---------------------------------------------------------------- the catalogue's doors (docs/ANALYSIS.md)
/** Where a source hears the context menu, however the call is spelt. */
const contextmenuListeners = (src) => (src.match(/addEventListener\(\s*['"`]contextmenu['"`]/g) || []).length;
/** The nodes a source copies: each `.cloneNode(`, with the expression it copies. */
const clonesIn = (src) => [...src.matchAll(/([\w.$]+(?:\(\))?)\s*\.cloneNode\s*\(/g)].map((m) => m[1]);
test('guard rails: one page script hears the context menu, menus.js, so every object\'s right-click is its catalogue menu; the hall page copies only its message template', () => {
  const pages = pageScripts();
  for (const f of ['public/catalog.js', 'public/menus.js', 'public/outbox.js']) assert.ok(pages.includes(f), f + ' is a page script every fence reads');
  const heard = Object.fromEntries(pages.map((f) => [f, contextmenuListeners(readSource(path.join(ROOT, f)))]).filter(([, n]) => n));
  // Two there: the door (AGM.menu.door), and a menu's own panel, which keeps the browser's menu from opening over it.
  assert.deepEqual(heard, { 'public/menus.js': 2 }, 'contextmenu only in menus.js: a right-click heard anywhere else would be a menu out of step with the catalogue');
  // A copy of a drawn message drops its listeners and goes stale: the pinned strip draws each message afresh instead, so
  // the template is the one node the hall page copies.
  assert.deepEqual(clonesIn(readSource(path.join(ROOT, 'public', 'app.js'))), ['tpl.content.firstElementChild'], 'cloneNode in app.js only at the template\'s site');
  // The reads find what they are for.
  assert.equal(contextmenuListeners("a.addEventListener('contextmenu', f); b.addEventListener( \"contextmenu\", g); c.addEventListener('click', h); // contextmenu"), 2);
  assert.deepEqual(clonesIn('const c = node.cloneNode(true); tpl.content.firstElementChild.cloneNode(true); x.cloneNodes(); el().cloneNode(false);'), ['node', 'tpl.content.firstElementChild', 'el()']);
});

test('guard rails: a page posts a message only to its own origin, and hears one only after checking who sent it', () => {
  let posts = 0, listeners = 0;
  for (const f of pageScripts()) {
    const src = readSource(path.join(ROOT, f));
    const read = [...src.matchAll(/\.postMessage\s*\(([^;]*)\)\s*;/g)];
    assert.equal(read.length, (src.match(/\.postMessage\s*\(/g) || []).length, `${f}: every postMessage is one statement the guard reads`);
    for (const m of read) {
      posts++;
      assert.match(m[1], /,\s*location\.origin\s*$/, `${f}: postMessage names this origin as its target, never '*' (${m[0]})`);
    }
    const heard = (src.match(/addEventListener\(\s*['"]message['"]/g) || []).length;
    const checked = (src.match(/addEventListener\(\s*['"]message['"]\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{\s*if \(\1\.source !== [\w.]+ \|\| \1\.origin !== location\.origin\) return;/g) || []).length;
    assert.equal(checked, heard, `${f}: every message listener is an arrow function whose first line returns unless the sending window and its origin are the ones expected`);
    assert.ok(!/\bonmessage\s*=/.test(src), `${f}: no onmessage handler (a listener the guard reads instead)`);
    listeners += heard;
  }
  assert.ok(posts >= 1 && listeners >= 1, 'the guard reads the pages\' posts and listeners (the admin page\'s Resync, the support view\'s listener)');
});

// ---------------------------------------------------------------- a restart announces nobody
test('a restart announces nobody: a 3-page hall back after a restart writes no "joined" line, and a newcomer, a page from elsewhere or a late one still is', async (t) => {
  const h = require('./helpers');
  let srv = await h.startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await h.stopServer(srv.child); });
  const admin = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const join = async (base, args) => { const s = await h.connect(base); sockets.push(s); return { s, res: await h.emit(s, 'join', { roomCode: code, ...args }) }; };
  /** A page as the hall page keeps itself: who it is, and the newest change it holds (its join's seq, then each it hears). */
  async function page(name, role) {
    const p = { name, role, seq: 0 };
    const { s, res } = await join(srv.base, { name, role });
    assert.ok(res.ok, name + ' joined');
    p.uid = res.identity;
    p.seq = res.seq;
    for (const ev of ['message', 'system']) s.on(ev, (m) => { if (Number.isInteger(m.seq) && m.seq > p.seq) p.seq = m.seq; });
    return p;
  }
  const pages = [await page('Ana', 'research'), await page('Ben', 'board'), await page('Cy', 'observer')];
  await h.until(() => pages[0].seq >= 3, 3000, 'Ana has heard the others join');   // each join is a numbered line
  const joinedLines = (history) => history.filter((m) => m.type === 'system' && / joined /.test(m.text)).map((m) => m.text);
  /** The lines the hall gained after the stop, which left it at change `seq`. */
  const after = (history, seq) => history.filter((m) => m.seq > seq);
  const restartLine = (m) => m.type === 'system' && /^— AGMessage restarted · \d+ messages? kept —$/.test(m.text);

  sockets.splice(0).forEach((s) => s.close());   // the restart drops every page at once
  const stoppedAt = pages[0].seq;   // Ana has heard every line the hall holds
  srv = await h.restartServer(srv);
  const heard = [];
  const watcher = await join(srv.base, { name: 'Wes', role: 'observer' });   // a newcomer in the boot window, with no since
  let newest = watcher.res.seq;
  watcher.s.on('system', (m) => { heard.push(m.text); if (m.seq > newest) newest = m.seq; });
  for (const p of pages) {
    const { res } = await join(srv.base, { name: p.name, role: p.role, uid: p.uid, since: p.seq });
    assert.deepEqual([res.ok, res.role, res.uid], [true, p.role, p.uid.split('.')[0]], p.name + ' comes back as itself');
  }
  // A page that names a change this hall never made, or no number at all, is no page coming back.
  const beyond = await join(srv.base, { name: 'Eve', role: 'observer', since: watcher.res.seq + 100 });
  const minus = await join(srv.base, { name: 'Fay', role: 'observer', since: -1 });
  assert.ok(beyond.res.ok && minus.res.ok);
  const reader = await join(srv.base, { name: 'Gus', role: 'observer' });
  const history = after(reader.res.history, stoppedAt);
  assert.ok(!reader.res.history.some(restartLine), 'a stop that saved: no hall says AGMessage restarted');
  assert.deepEqual(joinedLines(history), ['Wes joined as an observer', 'Eve joined as an observer', 'Fay joined as an observer'],
    'after the restart only those who were not back from it are announced: ' + JSON.stringify(history.map((m) => m.text)));
  await h.until(() => heard.includes('Gus joined as an observer'), 3000, 'the newcomer\'s line reached the hall');
  assert.ok(!heard.some((x) => /^(Ana|Ben|Cy) joined/.test(x)), 'no page in the hall was told the three came back: ' + JSON.stringify(heard));
  const people = reader.res.users.map((u) => u.name).sort();
  assert.deepEqual(people.filter((n) => ['Ana', 'Ben', 'Cy'].includes(n)), ['Ana', 'Ben', 'Cy'], 'the people list has them all the same');

  // Past the boot's first seconds a page that comes back is announced as any join is.
  sockets.splice(0).forEach((s) => s.close());
  const stoppedAgainAt = newest;   // Wes heard every line after his own
  srv = await h.restartServer(srv, { AGM_BOOT_SEAT_MS: '1000' });
  await h.wait(1100);
  const late = await join(srv.base, { name: 'Ana', role: 'research', uid: pages[0].uid, since: pages[0].seq });
  assert.ok(late.res.ok);
  const lateReader = await join(srv.base, { name: 'Hal', role: 'observer' });
  assert.deepEqual(joinedLines(after(lateReader.res.history, stoppedAgainAt)), ['Ana joined Backstage'], 'announced after the window');
});

// ---------------------------------------------------------------- a 0.5.1 folder: halls with one room each
test('a 0.5.1 data folder boots as halls with one room each, keeping codes, messages, seats, a forward, a stage send still followed, Stagewatch, a screen, a desk result, an account\'s halls and an invite, and writing nothing new', async (t) => {
  const h = require('./helpers');
  const sockets = [];
  let srv = await h.startServer();
  // Hall A's own Stagewatch, with no show desk: a result waiting for it waits, and its frames reach the hall.
  const swA = await h.fakeStagewatch({ name: 'Hall A timer', desk: false });
  t.after(async () => { sockets.forEach((s) => s.close()); if (srv.child.exitCode === null && srv.child.signalCode === null) await h.stopServer(srv.child); await swA.close(); });
  const page = async (cookie) => { const s = await h.connect(srv.base, cookie); sockets.push(s); return s; };
  // The folder as 0.5.1 kept it, made through the acts a show takes: two halls, the first with its own Stagewatch and a
  // screen, an account given the second, a backstage guest in both who forwards a message, and the first hall locked.
  const PASSWORD = 'the green room kettle';
  let admin = (await h.api(srv.base, 'POST', '/api/setup', { token: h.TOKEN, username: 'ada', name: 'Ada Admin', password: PASSWORD })).cookie;
  assert.match(admin, /^agm_s=/, 'the first admin account');
  const A = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const B = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  let adm = await page(admin);
  assert.ok((await h.emit(adm, 'hall:configure', { code: A, name: 'Hall A', stagewatchUrl: swA.url })).ok);
  const stagewatchBefore = (await h.emit(adm, 'hall:settings', { code: A })).stagewatch.url;
  assert.ok((await h.emit(adm, 'display:create', { code: A, name: 'Lobby' })).ok);
  const sam = (await h.api(srv.base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [B] }, { cookie: admin })).body;
  assert.ok(sam.ok, JSON.stringify(sam));
  const anaA = await page();
  const inA = await h.emit(anaA, 'join', { roomCode: A, name: 'Ana', role: 'research' });
  const anaB = await page();
  assert.ok((await h.emit(anaB, 'join', { roomCode: B, name: 'Ana', role: 'research', uid: inA.identity })).ok);
  const said = await h.emit(anaA, 'message', { type: 'text', text: 'hello A' });
  assert.ok((await h.emit(anaB, 'message', { type: 'text', text: 'hello B' })).ok);
  assert.ok((await h.emit(anaA, 'forward', { messageId: said.id, targetRoom: B })).ok);
  assert.ok((await h.emit(adm, 'admin:lockRoles', { roomCode: A, on: true })).ok);
  const invite = new URL((await h.emit(adm, 'admin:invites', { roomCode: A })).invites.board, srv.base).searchParams.get('invite');
  assert.ok(invite);
  sockets.splice(0).forEach((s) => s.close());
  await h.stopServer(srv.child);

  // Laid on by hand as 0.5.1 wrote them: each hall's snapshot (and its backup) in 0.5.1's shape, the fields its compaction
  // wrote and no other (lib/store.js at 0.5.1: no tombstones, `gone`); a line sent to the speaker's screen through hall
  // A's own Stagewatch (`link` 'hall:<code>', and that Stagewatch's address tag), in its log after its snapshot, not yet
  // acknowledged; and a show-desk result for that Stagewatch not taken yet. What 0.5.1 never wrote goes: the data
  // folder's format marker and the record of how the stop went. (The audit log stays this build's: 0.5.1's plain chain
  // opened under a key is the audit log's own tests', test/audit.test.js.)
  const data = srv.dataDir;
  const rooms = path.join(data, 'rooms');
  const SHAPE_051 = ['code', 'name', 'createdAt', 'seq', 'settings', 'messages', 'savedAt'];
  for (const f of fs.readdirSync(rooms).filter((x) => /\.json(\.bak)?$/.test(x))) {
    const snap = JSON.parse(fs.readFileSync(path.join(rooms, f), 'utf8'));
    fs.writeFileSync(path.join(rooms, f), JSON.stringify(Object.fromEntries(SHAPE_051.map((k) => [k, snap[k]]))));
  }
  const seqOf = (code) => JSON.parse(fs.readFileSync(path.join(rooms, code + '.json'), 'utf8')).seq;
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(rooms, A + '.json'), 'utf8'))), SHAPE_051);
  const before = { A: seqOf(A), B: seqOf(B) };
  const tag = nodes.addressTag(nodes.normaliseBase(swA.url));
  const stage = { ref: 7, receipt: 'applied', ack: 'sent', by: '', at: 1_700_000_000_000, link: 'hall:' + A, sw: tag, seq: 0 };
  fs.appendFileSync(path.join(rooms, A + '.log'), JSON.stringify({ o: 'add', m: { id: 'stage1', type: 'system', text: 'Ana sent to the speaker\'s screen: “Five minutes”', at: 1_700_000_000_000, stage }, s: before.A + 1 }) + '\n');
  const nodeId = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).nodeId;
  fs.writeFileSync(path.join(data, 'desk-results.json'), JSON.stringify({ results: [{ sw: tag, link: 'hall:' + A, id: 'p3', created: 1_700_000_000_000, line: 'Hall A: Five minutes', target: nodeId, ok: true, words: 'Shown', ran: 1_700_000_000_500 }] }));
  for (const f of ['format.json', 'last-stop.json']) fs.rmSync(path.join(data, f), { force: true });

  srv = await h.startServer({ AGM_DATA_DIR: data });
  admin = (await h.api(srv.base, 'POST', '/api/auth/login', { username: 'ada', password: PASSWORD })).cookie;
  assert.match(admin, /^agm_s=/, 'the admin account signs in');
  const health = (await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  assert.deepEqual([health.rooms, health.sideRooms], [2, 0], 'two halls, each its Main room alone');
  assert.deepEqual([health.desk.waiting, health.lastStop.state, health.lastStop.said], [1, 'none', 2], 'the desk result kept; no stop record, so both halls say AGMessage restarted');
  // Each hall by its code, as its guests type it: its name, its messages, and its numbers carried on by the restart line.
  const look = async (code, name) => { const s = await page(); return { s, j: await h.emit(s, 'join', { roomCode: code, name, role: 'observer' }) }; };
  const { s: inHallA, j: a } = await look(A, 'Obs');
  const { j: b } = await look(B, 'Obs');
  const restart = /^— AGMessage restarted · \d+ messages? kept —$/;
  assert.deepEqual([a.ok, a.roomName, a.seq, restart.test(a.history.at(-1).text)], [true, 'Hall A', before.A + 2, true], 'the stage line and the restart line after what it kept');
  assert.deepEqual([b.ok, b.roomName, b.seq, restart.test(b.history.at(-1).text)], [true, 'Hall B', before.B + 1, true]);
  assert.ok(a.history.some((m) => m.text === 'hello A') && b.history.some((m) => m.text === 'hello B'));
  assert.deepEqual(b.history.filter((m) => m.forwardedFrom).map((m) => [m.text, m.forwardedFrom.roomName]), [['hello A', 'Hall A']], 'the forward, by its hall\'s name');
  // The record still names the hall's own Stagewatch; a page is sent it without the link (lib/ops.js forPage), whose id
  // names the hall's key.
  const { link, ...unlinked } = stage;
  assert.equal(link, 'hall:' + A);
  const kept = (await h.emit(await page(admin), 'admin:watchRoom', { roomCode: A })).messages.filter((m) => m.stage);
  assert.deepEqual(kept.map((m) => [m.stage.link, m.stage.ack]), [['hall:' + A, 'sent']], 'the stage send still names the hall\'s own Stagewatch');
  assert.deepEqual(a.history.filter((m) => m.stage).map((m) => m.stage), [unlinked], 'a page is sent the send without its link');
  // …and is still followed: the speaker's acknowledgement, in a frame of that Stagewatch, reaches the line it sent.
  await h.until(() => swA.connected, 8000, 'hall A\'s Stagewatch linked again');
  const acked = h.once(inHallA, 'stageAck');
  swA.frame({ messageId: 7, messageAck: 'done', messageAckBy: 'Speaker A' });
  const ack = await acked;
  assert.deepEqual([ack.messageId, ack.stage, ack.seq > a.seq], ['stage1', { ...unlinked, ack: 'done', by: 'Speaker A' }, true], 'the acknowledgement on the line it sent, a change numbered after the join');
  // The lock and its seats: Ana comes back to her seat, the invite seats On stage, and a newcomer without one is an observer.
  const ana = await page();
  assert.deepEqual((({ ok, role, note }) => ({ ok, role, note }))(await h.emit(ana, 'join', { roomCode: A, name: 'Ana', role: 'research', uid: inA.identity })), { ok: true, role: 'research', note: '' });
  const bea = await page();
  assert.deepEqual((({ ok, role, note }) => ({ ok, role, note }))(await h.emit(bea, 'join', { roomCode: A, name: 'Bea', role: 'board', invite })), { ok: true, role: 'board', note: '' });
  const cy = await page();
  assert.equal((await h.emit(cy, 'join', { roomCode: A, name: 'Cy', role: 'research' })).role, 'observer');
  // The hall's Stagewatch, its screen, and the account's hall.
  adm = await page(admin);
  assert.equal((await h.emit(adm, 'hall:settings', { code: A })).stagewatch.url, stagewatchBefore);
  assert.deepEqual((await h.emit(adm, 'display:list', { code: A })).displays.map((d) => d.name), ['Lobby']);
  assert.deepEqual((await h.api(srv.base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.filter((u) => u.username === 'sam').map((u) => u.halls), [[B]]);
  // Nothing of rooms beside a hall is written: no people's pages, no list of rooms that may send in.
  assert.ok(!fs.existsSync(path.join(data, 'pages.json')));
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')), 'roomSends'));
  assert.deepEqual(fs.readdirSync(rooms).filter((f) => f.includes('.') && !/^[A-Z0-9]+\.(json|log|json\.bak)$/.test(f)), [], 'every room file is a hall\'s');

  // A second copy on the folder writes nothing, and goes.
  const roomBytes = () => fs.readdirSync(rooms).sort().map((f) => f + ':' + fs.readFileSync(path.join(rooms, f), 'utf8'));
  const held = roomBytes();
  const otherPort = String(await h.freePort());
  const second = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: otherPort, HOST: '127.0.0.1', AGM_DATA_DIR: data, AGM_KEY_DIR: data + '-keys', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const stop = setTimeout(() => c.kill('SIGKILL'), 8000);
    c.on('exit', (code) => { clearTimeout(stop); resolve({ code, out }); });
  });
  assert.equal(second.code, 3, second.out);
  assert.match(second.out, /already running on this data folder/);
  assert.deepEqual(roomBytes(), held, 'the running copy\'s room files are as they were');
});

// ---------------------------------------------------------------- one server per data folder
test('a second start on the same data folder changes nothing and goes away; every acknowledged message survives', async (t) => {
  const h = require('./helpers');
  const second = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, HOST: '127.0.0.1', AGM_KEY_DIR: env.AGM_DATA_DIR + '-keys', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const stop = setTimeout(() => c.kill('SIGKILL'), 8000);   // a second copy that ran is a failure, not a hang
    c.on('exit', (code) => { clearTimeout(stop); resolve({ code, out }); });
  });
  const a = await h.startServer();
  let guest = null;
  t.after(async () => { if (guest) guest.close(); if (a.child.exitCode === null && a.child.signalCode === null) await h.stopServer(a.child); });
  const login = await h.api(a.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(a.base, 'POST', '/api/rooms', { name: 'AGM' }, { cookie: login.cookie })).body.code;
  guest = await h.connect(a.base);
  assert.ok((await h.emit(guest, 'join', { roomCode: code, name: 'Ana', role: 'research' })).ok);
  assert.ok((await h.emit(guest, 'message', { type: 'text', text: 'before the second start' })).ok);
  const roomFiles = () => ['.json', '.log'].map((ext) => fs.readFileSync(path.join(a.dataDir, 'rooms', code + ext), 'utf8'));
  const auditFile = () => fs.readFileSync(path.join(a.dataDir, 'audit.jsonl'), 'utf8');
  // The audit log's records, outside the data folder: a second start reads none of them and writes none.
  const recordsDir = path.join(a.dataDir + '-keys', 'audit');
  const records = () => Object.fromEntries(fs.readdirSync(recordsDir).sort().map((f) => [f, fs.readFileSync(path.join(recordsDir, f), 'utf8')]));
  await new Promise((resolve) => { setTimeout(resolve, 400); });   // the head's lane has saved what the running server wrote
  const before = { rooms: roomFiles(), audit: auditFile(), records: records() };

  const samePort = await second({ PORT: String(a.port), AGM_DATA_DIR: a.dataDir });
  assert.equal(samePort.code, 3, 'the port is taken: "cannot run as configured", which the watchdog does not restart:\n' + samePort.out);
  const otherPort = await second({ PORT: String(await h.freePort()), AGM_DATA_DIR: a.dataDir });
  assert.equal(otherPort.code, 3, 'another port, the same folder: refused as well:\n' + otherPort.out);
  assert.match(otherPort.out, /already running on this data folder/);
  assert.deepEqual(roomFiles(), before.rooms, 'the running server\'s room files are untouched');
  assert.equal(auditFile(), before.audit, 'and so is its audit log');
  assert.deepEqual(records(), before.records, 'and the records beside its key');

  assert.ok((await h.emit(guest, 'message', { type: 'text', text: 'after the second start' })).ok, 'acknowledged by the running server');
  guest.close(); guest = null;
  a.child.kill('SIGKILL');   // a stop that does not compact: the watchdog's hang kill, a power cut, the console window closed
  await new Promise((resolve) => { a.child.once('exit', resolve); });

  const b = await h.startServer({ AGM_DATA_DIR: a.dataDir });
  try {
    const v = await h.connect(b.base);
    const j = await h.emit(v, 'join', { roomCode: code, name: 'Obs', role: 'observer' });
    v.close();
    const texts = j.history.map((m) => m.text);
    assert.ok(texts.includes('before the second start') && texts.includes('after the second start'), JSON.stringify(texts));
    assert.equal(texts.filter((x) => /^— AGMessage restarted · \d+ messages? kept —$/.test(x)).length, 1, 'one restart line, from the real restart: ' + JSON.stringify(texts));
  } finally { await h.stopServer(b.child); }
});

test('a show day\'s peaks are on disk by the end of the 5 s window they rose in: a hang the watchdog ends loses no earlier window', async (t) => {
  const h = require('./helpers');
  const a = await h.startServer();
  let b = null;
  t.after(async () => {
    if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL');
    if (b) await h.stopServer(b.child);
  });
  // Three sign-ins: three audit appends, each timed as it reaches the disk.
  for (let i = 0; i < 3; i++) assert.equal((await h.api(a.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200);
  const health = (await h.api(a.base, 'GET', '/api/health')).body;
  const today = health.peaks.find((d) => d.day === health.showDay);
  assert.ok(today && today.auditPutMs.count >= 3, 'the sign-ins are counted: ' + JSON.stringify(today));
  const appendsOnDisk = () => {
    const saved = r.readJsonWithBak(path.join(a.dataDir, 'peaks.json'));   // null until it is written
    const d = saved ? saved.days.find((x) => x.day === today.day) : null;
    return d ? d.auditPutMs.buckets.reduce((n, k) => n + k, 0) : 0;
  };
  // The window's end (5 s at most) and the lane's tenth of a second, with no stop asked: nothing flushes it but the tick.
  const from = Date.now();
  assert.ok(await until(() => appendsOnDisk() >= today.auditPutMs.count, 8000), 'on disk within a window: ' + appendsOnDisk() + ' of ' + today.auditPutMs.count + ' after ' + (Date.now() - from) + ' ms');
  a.child.kill('SIGKILL');   // the watchdog's hang kill: no stop, no flush
  await new Promise((resolve) => { a.child.once('exit', resolve); });
  assert.ok(appendsOnDisk() >= today.auditPutMs.count, 'still there after the kill');
  b = await h.startServer({ AGM_DATA_DIR: a.dataDir });
  const after = (await h.api(b.base, 'GET', '/api/health')).body.peaks.find((d) => d.day === today.day);
  assert.ok(after && after.auditPutMs.count >= today.auditPutMs.count, 'the restarted server counts on from them: ' + JSON.stringify(after));
});
