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
const { filesUnder, handlerFiles, pageScripts } = require('./helpers');
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
    // nothing saved. Ctrl+C and the window closing reach the server itself (SIGINT, SIGHUP), so they still save.
    assert.ok(!fs.existsSync(path.join(dir, 'saved')));
  } else {
    assert.equal(fs.readFileSync(path.join(dir, 'saved'), 'utf8'), 'asked to stop', 'a signalled watchdog asks its server; it does not kill it');
  }
});

test('a server whose watchdog has gone saves what is waiting and leaves, so no orphan holds the folder', async () => {
  const { startServer, api } = require('./helpers');
  const srv = await startServer();
  const setup = await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
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
    'server.js': { max: 16, why: 'startup (dirs, settings, crash record), the crash handler, upload sniffing (4 KB), tunnel log tail (and, through its lane, the show desk results a tick collects, flushed once before they are reported)' },
    'supervise.js': { max: 3, why: 'the watchdog process: its own log and marker, never on a request' },
    'lib/store.js': { max: 10, why: 'durability: an acknowledged message is appended to disk before the ack; snapshots every 500 ops' },
    'lib/resilience.js': { max: 11, why: 'the atomic writer itself, and the temporary file of a write that failed removed so a full disk is not kept full; a folder\'s real path, read once per place at start (placeId)' },
    'lib/secretbox.js': { max: 3, why: 'the machine key, read once, or made once and published whole' },
    'lib/guard.js': { max: 3, why: 'the server secret, read once at startup' },
    'lib/tls.js': { max: 4, why: 'the certificate, read (or made) once at startup and when the admin renews it' },
    'lib/version.js': { max: 8, why: 'the version and its stamp (or the checkout\'s commit), read once at startup' },
    'lib/audit.js': { max: 11, why: 'the audit trail: an entry is on disk (fsync) before the action is acknowledged, a short write cut back, the file rotated at 20 MB; read once at startup, and the records outside the data folder, read once at open; verify reads asynchronously in slices' },
  };
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), f + ': no eval / new Function');
    // `fs.realpathSync.native(` is a synchronous call too.
    const sync = (src.match(/\bfs\.\w+Sync(?:\.native)?\s*\(/g) || []).length;
    const rule = allowed[f] || { max: 0 };
    assert.ok(sync <= rule.max, `${f}: ${sync} synchronous fs calls (allowed ${rule.max}${rule.why ? ': ' + rule.why : ''})`);
  }
  const nodesSrc = fs.readFileSync(path.join(ROOT, 'lib/nodes.js'), 'utf8');
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
      'a page that dropped is announced as gone only once the Wi-Fi grace is over, one per page',
      'a screen link not in use: told, then let go a moment later',
      'a screen whose link went: told, then let go a moment later',
      'an account changed: its pages told, then let go a moment later',
      'expired sign-ins swept',
      'the show desk: what it approved run and reported, one request at a time, every 3 s',
      'each linked Stagewatch\'s context, posted on change and at least every 5 s, looked at each second',
      'cloudflared\'s log read for the tunnel\'s address until it has one',
      'the tunnel given 30 s to name its address',
      'the watchdog\'s heartbeat, from the event loop, each second',
    ],
  };
  const files = handlerFiles();
  assert.deepEqual(Object.keys(TIMERS).filter((f) => !files.includes(f)), [], 'every file with a list is a handler file');
  for (const f of files) {
    const timers = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(TIMER_CALLS) || []).length;
    const why = TIMERS[f] || [];
    assert.equal(timers, why.length, `${f}: ${timers} timers started, ${why.length} with a reason (${why.join('; ') || 'none'}): a state frame is a Latest; a tick of its own moves this list, with its words`);
  }
  // The read sees a timer in each form it can be written, and nothing else.
  const count = (src) => (src.match(TIMER_CALLS) || []).length;
  assert.equal(count('setTimeout(f, 1); setInterval (g, 2); global.setTimeout(h); timers.setInterval(i, 3);'), 4);
  assert.equal(count('clearTimeout(t); clearInterval(t); resetTimeout(t); const { setTimeout } = timers; new Latest({ name: "x", delayMs: 100, flush });'), 0);
  // The state frames that exist go through the one primitive, each by its name in health's `latest`.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.deepEqual([...server.matchAll(/new Latest\(\{\s*name: '([^']+)'/g)].map((m) => m[1]), ['board', 'screens', 'people', 'seen']);
});

test('guard rails: a page posts a message only to its own origin, and hears one only after checking who sent it', () => {
  let posts = 0, listeners = 0;
  for (const f of pageScripts()) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
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
  const joinedLines = (history) => history.filter((m) => m.type === 'system' && / joined as /.test(m.text)).map((m) => m.text);
  /** The lines after the newest restart's own line ("— Session restored (…) —"), which says what happened. */
  const afterRestore = (history) => history.slice(history.map((m) => m.type === 'system' && /Session restored/.test(m.text)).lastIndexOf(true) + 1);

  sockets.splice(0).forEach((s) => s.close());   // the restart drops every page at once
  srv = await h.restartServer(srv);
  const heard = [];
  const watcher = await join(srv.base, { name: 'Wes', role: 'observer' });   // a newcomer in the boot window, with no since
  watcher.s.on('system', (m) => heard.push(m.text));
  for (const p of pages) {
    const { res } = await join(srv.base, { name: p.name, role: p.role, uid: p.uid, since: p.seq });
    assert.deepEqual([res.ok, res.role, res.uid], [true, p.role, p.uid.split('.')[0]], p.name + ' comes back as itself');
  }
  // A page that names a change this hall never made, or no number at all, is no page coming back.
  const beyond = await join(srv.base, { name: 'Eve', role: 'observer', since: watcher.res.seq + 100 });
  const minus = await join(srv.base, { name: 'Fay', role: 'observer', since: -1 });
  assert.ok(beyond.res.ok && minus.res.ok);
  const reader = await join(srv.base, { name: 'Gus', role: 'observer' });
  const history = afterRestore(reader.res.history);
  assert.deepEqual(joinedLines(history), ['Wes joined as observer', 'Eve joined as observer', 'Fay joined as observer'],
    'after the restart line only those who were not back from it are announced: ' + JSON.stringify(history.map((m) => m.text)));
  await h.until(() => heard.includes('Gus joined as observer'), 3000, 'the newcomer\'s line reached the hall');
  assert.ok(!heard.some((x) => /^(Ana|Ben|Cy) joined/.test(x)), 'no page in the hall was told the three came back: ' + JSON.stringify(heard));
  const people = reader.res.users.map((u) => u.name).sort();
  assert.deepEqual(people.filter((n) => ['Ana', 'Ben', 'Cy'].includes(n)), ['Ana', 'Ben', 'Cy'], 'the people list has them all the same');

  // Past the boot's first seconds a page that comes back is announced as any join is: the restart line is long past.
  sockets.splice(0).forEach((s) => s.close());
  srv = await h.restartServer(srv, { AGM_BOOT_SEAT_MS: '1000' });
  await h.wait(1100);
  const late = await join(srv.base, { name: 'Ana', role: 'research', uid: pages[0].uid, since: pages[0].seq });
  assert.ok(late.res.ok);
  const lateReader = await join(srv.base, { name: 'Hal', role: 'observer' });
  assert.deepEqual(joinedLines(afterRestore(lateReader.res.history)), ['Ana joined as research'], 'announced after the window');
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
    assert.equal(texts.filter((x) => /Session restored/.test(x)).length, 1, 'one restore line, from the real restart: ' + JSON.stringify(texts));
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
