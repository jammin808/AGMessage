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
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; }

// ---------------------------------------------------------------- the watchdog's rules
test('watchdog policy: backoff, reset after a good run, give up, intent in exit codes', () => {
  const p = new r.SupervisorPolicy();
  p.started(0);
  assert.deepEqual(p.exited(0, 1000), { action: 'stop', delayMs: 0, reason: 'stopped' });
  assert.equal(p.exited(3, 1000).action, 'stop', 'cannot start as configured: restarting would fail the same way');
  assert.deepEqual(p.exited(82, 1000), { action: 'restart', delayMs: 0, reason: 'restart requested' });
  const delays = [];
  let t = 1000;
  for (let i = 0; i < 6; i++) { p.started(t); t += 1000; delays.push(p.exited(70, t).delayMs); }
  assert.deepEqual(delays, [2000, 4000, 8000, 15000, 30000, 30000]);
  p.started(t); t += 1000;
  const g = p.exited(70, t);
  assert.equal(g.action, 'giveup', 'more than 6 crashes in 10 minutes');
  assert.match(g.reason, /7 times in 10 minutes/);

  const q = new r.SupervisorPolicy();
  q.started(0); q.exited(70, 1000); q.started(1000); q.exited(70, 2000);
  q.started(2000);
  assert.equal(q.exited(70, 2000 + 6 * 60_000).delayMs, 2000, 'a run of 5 minutes or more starts the ladder again');
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
    aiOn: false, tunnel: false, recent: [{ at: 1, text: 'research sent a message to the stage screen (applied)' }],
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
  const files = ['server.js', 'supervise.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => 'lib/' + f), ...['app.js', 'admin.js', 'admin-plus.js', 'join.js'].map((f) => 'public/' + f)];
  // Synchronous fs calls block every meeting on the server while they run. These are allowed — each with its reason —
  // and the count may not grow without someone deciding it here.
  const allowed = {
    'server.js': { max: 16, why: 'startup (dirs, settings, crash record), the crash handler, upload sniffing (4 KB), tunnel log tail (and, through its lane, the show desk results a tick collects, flushed once before they are reported)' },
    'supervise.js': { max: 3, why: 'the watchdog process: its own log and marker, never on a request' },
    'lib/store.js': { max: 10, why: 'durability: an acknowledged message is appended to disk before the ack; snapshots every 500 ops' },
    'lib/resilience.js': { max: 10, why: 'the atomic writer itself, and the temporary file of a write that failed removed so a full disk is not kept full' },
    'lib/secretbox.js': { max: 3, why: 'the machine key, read once' },
    'lib/guard.js': { max: 3, why: 'the server secret, read once at startup' },
    'lib/tls.js': { max: 4, why: 'the certificate, read (or made) once at startup and when the admin renews it' },
    'lib/version.js': { max: 8, why: 'the version and its stamp (or the checkout\'s commit), read once at startup' },
    'lib/audit.js': { max: 11, why: 'the audit trail: an entry is on disk (fsync) before the action is acknowledged, a short write cut back, the file rotated at 20 MB; read once at startup; verify reads asynchronously in slices' },
  };
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), f + ': no eval / new Function');
    const sync = (src.match(/\bfs\.\w+Sync\s*\(/g) || []).length;
    const rule = allowed[f] || { max: 0 };
    assert.ok(sync <= rule.max, `${f}: ${sync} synchronous fs calls (allowed ${rule.max}${rule.why ? ': ' + rule.why : ''})`);
  }
  const nodesSrc = fs.readFileSync(path.join(ROOT, 'lib/nodes.js'), 'utf8');
  assert.ok(!/[?&]pin=/.test(nodesSrc), 'no key in a WebSocket URL (Show Bus §7)');
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
  const before = { rooms: roomFiles(), audit: auditFile() };

  const samePort = await second({ PORT: String(a.port), AGM_DATA_DIR: a.dataDir });
  assert.equal(samePort.code, 3, 'the port is taken: "cannot run as configured", which the watchdog does not restart:\n' + samePort.out);
  const otherPort = await second({ PORT: String(await h.freePort()), AGM_DATA_DIR: a.dataDir });
  assert.equal(otherPort.code, 3, 'another port, the same folder: refused as well:\n' + otherPort.out);
  assert.match(otherPort.out, /already running on this data folder/);
  assert.deepEqual(roomFiles(), before.rooms, 'the running server\'s room files are untouched');
  assert.equal(auditFile(), before.audit, 'and so is its audit log');

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
