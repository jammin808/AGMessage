'use strict';
// A restart rewrites only the halls that changed, a stop saves the audit log and the lanes first and says it saved, and
// "AGMessage restarted" is written only after a stop that did not save (the plan's Part 6, unit U4; the owner's answer
// 41): the stop's record and what a stop cut short leaves (lib/laststop.js), and end to end on a real server, the order
// of its saves recorded by test/stop-preload.js. The store's own part (its dirty halls, its bounded log and the fence on
// its snapshot's fields) is in test/units.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers');
const laststop = require('../lib/laststop');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** NODE_OPTIONS that preload these test files, beside what the run already has. */
const preload = (...names) => [process.env.NODE_OPTIONS, ...names.map((n) => '--require "' + path.join(__dirname, n).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; /* not there */ } };
/** The pid of a process that has ended (which a system may give to a new process soon after: Windows does). */
const deadPid = () => new Promise((resolve) => { const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); c.once('exit', () => resolve(c.pid)); });
// A pid no process can have: above Linux's PID_MAX_LIMIT (2^22) and not a multiple of 4, as every Windows pid is (Node
// reads Windows' refusal of it as ESRCH, as it does a pid that has ended).
const NO_PID = 4194305;
const NONE = { state: 'none', saved: false, at: null, build: '', unsaved: [], code: '' };

// ---------------------------------------------------------------- the record, read by type
test('the stop\'s record: written whole, saving only when nothing was left; read by type, and only a record that says it saved is a stop that saved', () => {
  const dir = tmp('agm-stop-');
  assert.deepEqual(laststop.record(dir, { at: 5, build: '0.6.0+7' }), { at: 5, build: '0.6.0+7', saved: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, laststop.FILE), 'utf8')), { at: 5, build: '0.6.0+7', saved: true });
  assert.deepEqual(laststop.record(dir, { at: 6, build: 'b', unsaved: ['peaks', '2 halls'] }), { at: 6, build: 'b', saved: false, unsaved: ['peaks', '2 halls'] });
  assert.deepEqual(fs.readdirSync(dir), [laststop.FILE], 'replaced whole, nothing left beside it');

  const R = laststop.readRecord;
  assert.deepEqual(R('{"at":5,"build":"x","saved":true}'), { state: 'saved', saved: true, at: 5, build: 'x', unsaved: [], code: '' });
  assert.deepEqual(R('{"at":5,"build":"x","saved":false,"unsaved":["peaks",7]}'), { state: 'unsaved', saved: false, at: 5, build: 'x', unsaved: ['peaks'], code: '' });
  // Only `saved: true` is a stop that saved: anything else that names no stop that saved is one that did not.
  for (const text of ['{"saved":"true"}', '{"saved":1}', '{}', '{"at":"5","build":7,"unsaved":"peaks"}']) {
    assert.deepEqual(R(text), { state: 'unsaved', saved: false, at: null, build: '', unsaved: [], code: '' }, text);
  }
  // A stop that saved is read against the folder by its time: a record that says so and names none is not ours.
  for (const text of ['{"saved":true}', '{"saved":true,"at":"5"}', '{"saved":true,"at":null}']) assert.deepEqual(R(text), { ...NONE, state: 'unread', code: 'not a record' }, text);
  assert.deepEqual(R(null, 'ENOENT'), NONE, 'no record');
  assert.deepEqual(R(null, 'EACCES'), { ...NONE, state: 'unread', code: 'EACCES' }, 'a record that could not be read says nothing of the stop');
  assert.deepEqual(R('{"saved":tr'), { ...NONE, state: 'unread', code: 'not JSON' }, 'one torn by a power cut');
  for (const text of ['null', '[true]', '"saved"']) assert.deepEqual(R(text), { ...NONE, state: 'unread', code: 'not a record' }, text);
  assert.equal(R(JSON.stringify({ saved: true, build: 'x'.repeat(500), at: 5 })).build.length, 80, 'bounded');
  assert.equal(R(JSON.stringify({ saved: false, unsaved: Array(50).fill('y'.repeat(200)) })).unsaved.length, 20);
});

test('take: the record read and moved aside, so a crash after this start is never read as the stop that saved; one that cannot be moved is removed, and one that cannot be either is said', () => {
  const dir = tmp('agm-stop-');
  const file = path.join(dir, laststop.FILE);
  const seen = path.join(dir, laststop.SEEN);
  assert.deepEqual(laststop.take(dir), { ...NONE, left: '' });
  assert.deepEqual(fs.readdirSync(dir), [], 'none: nothing made');
  laststop.record(dir, { at: 9, build: 'b' });
  assert.deepEqual(laststop.take(dir), { state: 'saved', saved: true, at: 9, build: 'b', unsaved: [], code: '', left: '' });
  assert.deepEqual([fs.existsSync(file), JSON.parse(read(seen))], [false, { at: 9, build: 'b', saved: true }], 'moved aside whole');
  assert.deepEqual(laststop.take(dir), { ...NONE, left: '' }, 'taken once: a start after a crash of this one reads none');
  assert.deepEqual(JSON.parse(read(seen)), { at: 9, build: 'b', saved: true }, 'and the one seen is kept as it was');

  // A record that cannot be read (a folder in its place, as EBUSY or EACCES would be): unread, and moved aside all the same.
  fs.rmSync(seen);
  fs.mkdirSync(file);
  assert.deepEqual(laststop.take(dir), { ...NONE, state: 'unread', code: 'EISDIR', left: '' });
  assert.ok(!fs.existsSync(file) && fs.statSync(seen).isDirectory());
  fs.rmSync(seen, { recursive: true });

  // One that cannot be moved (held by another program) is removed. One that can be neither is left and said, and kept as
  // the one seen too (a new file, which the hold on the record does not stop), so the next start reads it as taken; the
  // one after the hold lifts moves it aside, still taken.
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  const held = (calls) => function heldRecord(from, ...rest) {
    if (from === file) throw Object.assign(new Error('EBUSY: resource busy or locked, ' + calls.name), { code: 'EBUSY' });
    return calls.call(fs, from, ...rest);
  };
  const TOOK = { state: 'saved', saved: true, at: 10, build: 'b', unsaved: [], code: '' };
  try {
    laststop.record(dir, { at: 10, build: 'b' });
    fs.renameSync = held(rename);
    assert.deepEqual(laststop.take(dir), { ...TOOK, left: '' });
    assert.deepEqual([fs.existsSync(file), fs.existsSync(seen)], [false, false], 'removed');
    fs.renameSync = rename;
    laststop.record(dir, { at: 11, build: 'b' });
    fs.renameSync = held(rename);
    fs.unlinkSync = held(unlink);
    assert.deepEqual(laststop.take(dir), { ...TOOK, at: 11, left: 'EBUSY' }, 'the stop before this start, which saved');
    assert.deepEqual([fs.existsSync(file), JSON.parse(read(seen))], [true, { at: 11, build: 'b', saved: true }], 'left where it was, and kept as the one seen');
    const taken = { ...TOOK, at: 11, state: 'stale', saved: false, code: 'taken by an earlier start' };
    assert.deepEqual(laststop.take(dir), { ...taken, left: 'EBUSY' }, 'a start after it (and perhaps a crash of it) is never read as that stop');
    fs.renameSync = rename;
    fs.unlinkSync = unlink;
    assert.deepEqual(laststop.take(dir), { ...taken, left: '' });
    assert.deepEqual([fs.existsSync(file), JSON.parse(read(seen))], [false, { at: 11, build: 'b', saved: true }], 'moved aside once it could be');
    // A new stop's record, though its build is the same, is a stop of its own.
    laststop.record(dir, { at: 12, build: 'b' });
    assert.deepEqual(laststop.take(dir), { ...TOOK, at: 12, left: '' });
    // Where the one seen cannot be written either, both are said: the folder's own check is then the next start's.
    laststop.record(dir, { at: 13, build: 'b' });
    fs.renameSync = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
    fs.unlinkSync = held(unlink);
    assert.equal(laststop.take(dir).left, 'EBUSY; ' + laststop.SEEN + ' EBUSY');
  } finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
  assert.ok(fs.existsSync(file), 'left where it was');
});

test('judge: a record that says it saved, read against the folder, is stale when a hall\'s log holds lines or a snapshot is newer than it: something ran on the folder after that stop', () => {
  const saved = { state: 'saved', saved: true, at: 100, build: 'b', unsaved: [], code: '', left: '' };
  assert.deepEqual(laststop.judge(saved, { lines: 0, newest: 100 }), saved, 'a stop that saved leaves no log lines and no newer snapshot');
  assert.deepEqual(laststop.judge(saved, { lines: 0, newest: 0 }), saved, 'a folder with no hall');
  assert.deepEqual(laststop.judge(saved, { lines: 1, newest: 50 }), { ...saved, state: 'stale', saved: false, code: 'a hall\'s log written after it' });
  assert.deepEqual(laststop.judge(saved, { lines: 3, newest: 50 }).code, '3 halls\' logs written after it');
  assert.deepEqual(laststop.judge(saved, { lines: 0, newest: 101 }), { ...saved, state: 'stale', saved: false, code: 'a hall\'s snapshot written after it' });
  for (const said of [{ ...NONE, left: '' }, { ...NONE, state: 'unsaved', at: 100, unsaved: ['peaks'], left: '' }, { ...NONE, state: 'unread', code: 'EACCES', left: '' }]) {
    assert.deepEqual(laststop.judge(said, { lines: 2, newest: 200 }), said, said.state + ': as it was');
  }
});

test('sweep: an atomic write\'s temporary file whose process has ended is removed; a running one\'s, and every other file, kept', async () => {
  const a = tmp('agm-sweep-');
  const b = tmp('agm-sweep-');
  for (const f of ['ABC234.json.4120.tmp', 'settings.json.77.tmp', 'ABC234.json', 'x.tmp', 'y.0.tmp', 'ABC234.json.4120.tmp.bak']) fs.writeFileSync(path.join(a, f), '{');
  fs.mkdirSync(path.join(a, 'z.4120.tmp'));
  fs.writeFileSync(path.join(b, 'peaks.json.4121.tmp'), '{');
  const asked = [];
  const isRunning = (pid) => { asked.push(pid); return pid === 77; };
  assert.deepEqual(laststop.sweep([a, b, path.join(a, 'none')], { isRunning }), { removed: ['ABC234.json.4120.tmp', 'peaks.json.4121.tmp'], failed: [] });
  assert.deepEqual(fs.readdirSync(a).sort(), ['ABC234.json', 'ABC234.json.4120.tmp.bak', 'settings.json.77.tmp', 'x.tmp', 'y.0.tmp', 'z.4120.tmp']);
  assert.deepEqual(asked.sort(), [4120, 4121, 77].sort(), 'only a file a write of ours names, by its pid');
  // A folder that cannot be listed is said, and the others swept all the same.
  const file = path.join(b, 'peaks.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(path.join(a, 'settings.json.4122.tmp'), '{');
  const r = laststop.sweep([file, a], { isRunning });
  assert.deepEqual([r.removed, r.failed.map(([where]) => where), r.failed[0][1].length > 0], [['settings.json.4122.tmp'], [file], true]);

  assert.deepEqual(['a.json.12.tmp', 'a.tmp', 'a.json.12.tmp.bak', 'a.0.tmp', 'a.-3.tmp', 'a.12345678901.tmp', 'a.json.12-ab.new.12.tmp'].map(laststop.tmpPid), [12, 0, 0, 0, 0, 0, 12]);
  assert.equal(laststop.running(process.pid), true, 'this process');
  assert.equal(laststop.running(await deadPid()), false, 'one that has ended');
  assert.equal(laststop.running(NO_PID), false, 'one no process can have');
});

// ---------------------------------------------------------------- end to end
/** A hall's snapshot and log on disk, as text (null where there is none). */
const filesOf = (srv, code) => ({ json: read(path.join(srv.dataDir, 'rooms', code + '.json')), log: read(path.join(srv.dataDir, 'rooms', code + '.log')) });
/** The steps test/stop-preload.js recorded for one run. */
const stepsOf = (file) => (read(file) || '').split('\n').filter(Boolean);
const health = async (srv) => (await h.api(srv.base, 'GET', '/api/health')).body;
/** A hall's history as a page joining it now reads it, and its "AGMessage restarted" lines. */
async function historyOf(srv, code, name) {
  const s = await h.connect(srv.base);
  try {
    const j = await h.emit(s, 'join', { roomCode: code, name, role: 'observer' });
    assert.ok(j.ok, JSON.stringify(j));
    return { history: j.history, restarts: j.history.filter((m) => m.type === 'system' && /^— AGMessage restarted · \d+ messages? kept —$/.test(m.text)) };
  } finally { s.close(); }
}
async function kill(srv) {
  if (srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  const gone = new Promise((resolve) => { srv.child.once('exit', resolve); });
  srv.child.kill('SIGKILL');   // the watchdog's hang kill, Windows ending the task, a power cut: no stop, no record
  await gone;
}

test('a stop saves the audit log, then the lanes, then only the halls that changed, then says so; the start after it writes no hall and no hall says AGMessage restarted; after a kill each does, once, and a second kill is not read as a stop that saved', async (t) => {
  const dir = tmp('agm-steps-');
  const run = (n) => ({ NODE_OPTIONS: preload('stop-preload.js', 'snapshot-preload.js'), AGM_TEST_SAVES: path.join(dir, 'run' + n + '.txt') });
  let srv = await h.startServer(run(1));
  t.after(() => kill(srv));
  const admin = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const make = async (name) => (await h.api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [A, B, C] = [await make('Hall A'), await make('Hall B'), await make('Hall C')];
  const s = await h.connect(srv.base);
  assert.ok((await h.emit(s, 'join', { roomCode: A, name: 'Ana', role: 'research' })).ok);
  assert.ok((await h.emit(s, 'message', { type: 'text', text: 'one' })).ok);
  s.close();
  const before = { A: filesOf(srv, A), B: filesOf(srv, B), C: filesOf(srv, C) };
  assert.deepEqual([before.B.log, before.C.log], ['', ''], 'B and C have not changed since they were made');
  const build = (await health(srv)).build;

  // The stop: the audit log first, then every lane, then the one hall that changed, then the record, last.
  await h.stopServer(srv.child);
  const steps = stepsOf(run(1).AGM_TEST_SAVES);
  const stop = steps.slice(steps.indexOf('stop') + 1);
  assert.equal(stop[0], 'audit', 'the audit log first: ' + stop.join(', '));
  const at = (re) => stop.map((x, i) => (re.test(x) ? i : -1)).filter((i) => i >= 0);
  const lanes = at(/^lane /);
  const compacts = at(/^compact /);
  assert.ok(lanes.length >= 7, 'every lane flushed: ' + stop.join(', '));
  assert.ok(Math.max(...lanes) < Math.min(...compacts), 'the lanes before any hall: ' + stop.join(', '));
  assert.deepEqual(compacts.map((i) => stop[i]), ['compact ' + A], 'only the hall that changed');
  assert.equal(stop[stop.length - 1], 'rename ' + laststop.FILE, 'the record last: ' + stop.join(', '));
  assert.ok(stop.indexOf('rename ' + A + '.json') > Math.max(...lanes), 'its snapshot written after the lanes');
  const rec = JSON.parse(read(path.join(srv.dataDir, laststop.FILE)));
  assert.deepEqual([Object.keys(rec), rec.build, rec.saved, typeof rec.at], [['at', 'build', 'saved'], build, true, 'number']);
  const stopped = { A: filesOf(srv, A), B: filesOf(srv, B), C: filesOf(srv, C) };
  assert.deepEqual([stopped.A.log, stopped.A.json === before.A.json, JSON.parse(stopped.A.json).messages.map((m) => m.text).slice(-1)], ['', false, ['one']], 'A written, its log folded in');
  assert.deepEqual([stopped.B, stopped.C], [before.B, before.C], 'B and C not written');

  // The start after a stop that saved: no hall written, none says AGMessage restarted, and the record moved aside.
  srv = await h.restartServer(srv, run(2));
  const clean = await health(srv);
  assert.deepEqual(clean.lastStop, { state: 'saved', saved: true, at: rec.at, build, unsaved: [], code: '', said: 0, left: '' });
  assert.deepEqual([clean.saves.stores.rooms.atStart, clean.saves.stores.rooms.snapshots], [0, 0], 'no hall written at the start');
  assert.deepEqual({ A: filesOf(srv, A), B: filesOf(srv, B), C: filesOf(srv, C) }, stopped, 'every hall as the stop left it: no restart line in any log');
  assert.deepEqual([read(path.join(srv.dataDir, laststop.FILE)), JSON.parse(read(path.join(srv.dataDir, laststop.SEEN)))], [null, rec]);
  for (const code of [A, B]) assert.deepEqual((await historyOf(srv, code, 'Obs ' + code)).restarts, [], code + ': no restart line');

  // A kill: no record. Each hall says AGMessage restarted, once; only A and B, whose logs the joins above wrote, are written.
  await kill(srv);
  srv = await h.startServer({ ...run(3), AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  const killed = await health(srv);
  assert.deepEqual(killed.lastStop, { ...NONE, said: 3, left: '' });
  assert.equal(killed.saves.stores.rooms.atStart, 2, 'the two halls whose logs held lines');
  assert.equal(filesOf(srv, C).json, stopped.C.json, 'C, unchanged, not written');
  const once = {};
  for (const code of [A, B, C]) once[code] = await historyOf(srv, code, 'Kim ' + code);
  for (const code of [A, B, C]) assert.equal(once[code].restarts.length, 1, code + ': once: ' + JSON.stringify(once[code].history.map((m) => m.text)));
  assert.equal(once[A].restarts[0].text, '— AGMessage restarted · ' + once[A].history.indexOf(once[A].restarts[0]) + ' messages kept —');
  assert.equal(once[C].restarts[0].text, '— AGMessage restarted · 0 messages kept —');

  // A second kill: still no stop that saved (the record the clean stop wrote was moved aside, and is never read again).
  await kill(srv);
  srv = await h.startServer({ ...run(4), AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  assert.deepEqual((await health(srv)).lastStop, { ...NONE, said: 3, left: '' });
  for (const code of [A, B, C]) assert.equal((await historyOf(srv, code, 'Lee ' + code)).restarts.length, 2, code + ': once more');
  assert.deepEqual([read(path.join(srv.dataDir, laststop.FILE)), JSON.parse(read(path.join(srv.dataDir, laststop.SEEN)))], [null, rec]);
  await h.stopServer(srv.child);
});

test('a stop that could not save a store says what, and the start after it says AGMessage restarted in each hall', async (t) => {
  // The peaks' file held by another program (test/busy-preload.js): its lane cannot write it, at the stop either.
  let srv = await h.startServer({ NODE_OPTIONS: preload('busy-preload.js'), AGM_TEST_UNWRITABLE: 'peaks.json' });
  t.after(() => kill(srv));
  const admin = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;   // an audit entry: the peaks rise
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  await h.stopServer(srv.child);
  const rec = JSON.parse(read(path.join(srv.dataDir, laststop.FILE)));
  assert.deepEqual([Object.keys(rec), rec.saved, rec.unsaved], [['at', 'build', 'saved', 'unsaved'], false, ['peaks']]);
  assert.match(srv.out(), /\n {2}Not saved: peaks\. The next start says AGMessage restarted in each hall\.\n/);
  assert.doesNotMatch(srv.out(), /Saved: the audit log/);

  srv = await h.startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  assert.deepEqual((await health(srv)).lastStop, { state: 'unsaved', saved: false, at: rec.at, build: rec.build, unsaved: ['peaks'], code: '', said: 1, left: '' });
  assert.equal((await historyOf(srv, code, 'Obs')).restarts.length, 1);
  await h.stopServer(srv.child);
});

test('a record the folder is newer than is no stop that saved: a hall written after it, or its log, means a copy ran after that stop (0.5.1 rolled back to, then killed), and each hall says AGMessage restarted; the peaks a stop\'s snapshots raise are saved after them, before the record', async (t) => {
  const dir = tmp('agm-steps-');
  const run = (n) => ({ NODE_OPTIONS: preload('stop-preload.js', 'snapshot-preload.js'), AGM_TEST_SAVES: path.join(dir, 'run' + n + '.txt') });
  let srv = await h.startServer();
  t.after(() => kill(srv));
  await h.stopServer(srv.child);
  const first = JSON.parse(read(path.join(srv.dataDir, laststop.FILE)));
  assert.equal(first.saved, true);
  const rooms = path.join(srv.dataDir, 'rooms');
  const { RoomStore } = require('../lib/store');

  // A hall written after that stop, its log empty: as a build that keeps no record writes each hall at its start.
  new RoomStore(rooms).create('ABC234', 'Then');
  srv = await h.startServer({ ...run(1), AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  const late = await health(srv);
  assert.deepEqual(late.lastStop, { state: 'stale', saved: false, at: first.at, build: first.build, unsaved: [], code: 'a hall\'s snapshot written after it', said: 1, left: '' });
  assert.equal(late.saves.stores.rooms.atStart, 0, 'the hall, whole and its log empty, is not written at the start');
  assert.match(srv.out(), /\n {2}\[save\] last-stop\.json says the stop before saved, but a hall's snapshot written after it: each hall says AGMessage restarted\n/);
  const s = await h.connect(srv.base);
  assert.ok((await h.emit(s, 'join', { roomCode: 'ABC234', name: 'Ana', role: 'research' })).ok);
  assert.ok((await h.emit(s, 'message', { type: 'text', text: 'one' })).ok);
  s.close();
  assert.equal((await historyOf(srv, 'ABC234', 'Obs')).restarts.length, 1);

  // The stop: the hall's snapshot is the day's first, which raises its longest after the peaks' lane was written; the
  // peaks are written again after the hall, and the record last says the stop saved.
  await h.stopServer(srv.child);
  const steps = stepsOf(run(1).AGM_TEST_SAVES);
  const stop = steps.slice(steps.indexOf('stop') + 1);
  const hall = stop.indexOf('compact ABC234');
  assert.ok(hall > stop.indexOf('lane peaks.json') && stop.indexOf('lane peaks.json', hall) > hall, 'the peaks written again after the hall: ' + stop.join(', '));
  assert.equal(stop[stop.length - 1], 'rename ' + laststop.FILE, 'the record last: ' + stop.join(', '));
  const second = JSON.parse(read(path.join(srv.dataDir, laststop.FILE)));
  assert.deepEqual([second.saved, second.at > first.at], [true, true]);
  const kept = JSON.parse(read(path.join(rooms, 'ABC234.json'))).messages.length;
  const days = JSON.parse(read(path.join(srv.dataDir, 'peaks.json'))).days;
  assert.deepEqual(days.map((d) => d.compactMs.messages), [kept], 'the stop\'s snapshot is the day\'s longest on disk');

  // What a killed 0.5.1 leaves: each hall written at its start, then changes in its log, and no record of a stop.
  const old = new RoomStore(rooms);
  old.loadAll();
  assert.equal(old.snapshots, 0, 'clean after the stop: nothing written at the load');
  assert.ok(old.compact('ABC234'));
  const seq = old.get('ABC234').seq;
  fs.appendFileSync(path.join(rooms, 'ABC234.log'), ['sent under 0.5.1', 'and again'].map((text, i) => JSON.stringify({ o: 'add', m: { id: 'old' + i, type: 'text', text, at: Date.now() }, s: seq + 1 + i }) + '\n').join(''));
  srv = await h.startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  assert.deepEqual((await health(srv)).lastStop, { state: 'stale', saved: false, at: second.at, build: second.build, unsaved: [], code: 'a hall\'s log written after it', said: 1, left: '' });
  const { history, restarts } = await historyOf(srv, 'ABC234', 'Kim');
  assert.equal(restarts.length, 2, 'once more: ' + JSON.stringify(history.map((m) => m.text)));
  const at = history.indexOf(restarts[1]);
  assert.deepEqual(history.slice(at - 2, at).map((m) => m.text), ['sent under 0.5.1', 'and again'], 'replayed, then the line');
  await h.stopServer(srv.child);
});

test('what a stop cut short left: a dead copy\'s temporary files removed by the copy that holds the folder, after the hold, never by one refused at it; a hall moved to today\'s words is written once', async (t) => {
  const a = await h.startServer();
  let b = null;
  t.after(async () => { await h.stopServer(a.child); if (b) await h.stopServer(b.child); });
  const rooms = path.join(a.dataDir, 'rooms');
  const dead = NO_PID;
  assert.equal(laststop.running(dead), false);
  const planted = {
    [path.join(rooms, 'ABC234.json.' + dead + '.tmp')]: 'removed',
    [path.join(a.dataDir, 'settings.json.' + dead + '.tmp')]: 'removed',
    [path.join(rooms, 'ABC234.json.' + process.pid + '.tmp')]: 'kept',   // a process that runs: this test's
    [path.join(rooms, 'notes.tmp')]: 'kept',
  };
  for (const f of Object.keys(planted)) fs.writeFileSync(f, '{"torn');
  // A 0.5 hall whose message names its seat by the old word: moved as it loads, a change no op made.
  fs.writeFileSync(path.join(rooms, 'OLD234.json'), JSON.stringify({ code: 'OLD234', name: 'Then', createdAt: 1, seq: 1, settings: {}, messages: [{ id: 'm1', type: 'text', text: 'hi', at: 1, seq: 1, from: { uid: 'u1', name: 'Chair', role: 'director' } }], savedAt: 1, gone: [] }));
  const there = () => Object.keys(planted).filter((f) => fs.existsSync(f));

  // A second copy on the same folder is refused at the lock: it removes nothing.
  const second = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGM_DATA_DIR: a.dataDir, AGM_KEY_DIR: a.dataDir + '-keys', AGM_UPLOAD_DIR: a.dataDir + '-uploads', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.once('exit', (code) => resolve({ code, out }));
  });
  assert.equal(second.code, 3, second.out);
  assert.match(second.out, /already running on this data folder/);
  assert.deepEqual(there(), Object.keys(planted), 'a copy refused at the lock removes nothing');

  await h.stopServer(a.child);
  assert.deepEqual(there(), Object.keys(planted), 'nor does the stop');
  b = await h.startServer({ AGM_DATA_DIR: a.dataDir, PORT: String(a.port) });
  assert.deepEqual(there(), Object.keys(planted).filter((f) => planted[f] === 'kept'), 'the copy that holds the folder removed the dead copy\'s, after the hold');
  assert.match(b.out(), /\n {2}Removed 2 temporary files a stop cut short left in /);
  const hb = await health(b);
  assert.equal(hb.saves.stores.rooms.atStart, 1, 'the moved hall, and no other, written at the start');
  assert.equal(JSON.parse(read(path.join(rooms, 'OLD234.json'))).messages[0].from.role, 'board', 'its new word on disk');
});
