'use strict';
// The data folder says which build and format last wrote it (lib/dataformat.js): format.json is written only once a copy
// holds its folder, a new folder is marked, a 0.5 folder (no marker) is copied whole into backups/ before it is moved and
// marked, a folder of a higher format is refused with code 3 and nothing written, a newer build of the same format is said
// in health and on "This laptop", and a marker whose build changed is one `server.upgraded` row.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers');
const dataformat = require('../lib/dataformat');
const laptop = require('../lib/laptop');
const { BUILD, installVersionOf } = require('../lib/version');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NOW = Date.UTC(2026, 10, 2, 20, 31, 5);
const marker = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'format.json'), 'utf8'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/** Every folder and file under `dir`, each file with its bytes and its time: what a copy may not change. */
function tree(dir, { times = false, skip = [] } = {}) {
  const out = {};
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const at = rel ? rel + '/' + e.name : e.name;
      if (!rel && skip.includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { out[at + '/'] = ''; walk(full, at); } else out[at] = fs.readFileSync(full).toString('base64') + (times ? ' @' + fs.statSync(full).mtimeMs : '');
    }
  };
  walk(dir, '');
  return out;
}
/** A folder as a 0.5 server left it: settings, a hall's snapshot and log, the audit log, the watchdog's console. */
function folder05(dir) {
  write(path.join(dir, 'settings.json'), '{"nodeId":"0a1b2c3d"}');
  write(path.join(dir, 'rooms', 'ABC234.json'), '{"code":"ABC234","messages":[]}');
  write(path.join(dir, 'rooms', 'ABC234.log'), '{"o":"add"}\n');
  write(path.join(dir, 'audit.jsonl'), '{"seq":1}\n');
  write(path.join(dir, 'audit-archive', 'a', 'SHA256SUMS'), 'x\n');
  write(path.join(dir, 'logs', 'server.log'), 'a line\n');
  write(path.join(dir, 'watchdog.log'), 'a line\n');
}
// The builds around a server stamped as development build 41 (test/stamp-preload.js): one before it, one after.
const OLD = BUILD.version + '-dev.40+1111111';
const NEW = BUILD.version + '+45.3333333';

// ---------------------------------------------------------------- the marker, read and refused (pure, on disk)
test('the marker is read by type, and only one that is not there reads as none; a higher format, a marker that cannot be read and one that holds no format are refused with words', () => {
  const dir = tmp('agm-format-');
  const file = path.join(dir, 'format.json');
  assert.deepEqual(dataformat.read(path.join(dir, 'nothere')), { state: 'none', file: path.join(dir, 'nothere', 'format.json') });
  assert.deepEqual(dataformat.read(dir), { state: 'none', file });
  fs.mkdirSync(file);
  assert.deepEqual(dataformat.read(dir), { state: 'unread', file, code: 'EISDIR' }, 'there, and not read: never taken for none');
  fs.rmdirSync(file);
  for (const text of ['not json', 'null', '[]', '{"format":"2"}', '{"format":0}', '{"format":2.5}', '{"build":"0.6.0+1.abcdef1"}']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(dataformat.read(dir), { state: 'invalid', file }, text);
  }
  const back = 'backups/format-2-20261101T120000Z-AbCdEf';
  fs.writeFileSync(file, JSON.stringify({ format: 3, build: '0.7.0+52.abcdef1', at: 5, backup: back }));
  assert.deepEqual(dataformat.read(dir), { state: 'read', file, format: 3, build: '0.7.0+52.abcdef1', at: 5, backup: back, backupThere: false });
  fs.mkdirSync(path.join(dir, ...back.split('/')), { recursive: true });
  assert.equal(dataformat.read(dir).backupThere, true);
  fs.writeFileSync(file, JSON.stringify({ format: 2, build: 'a build\u0007 named', at: 'today', backup: '../../elsewhere' }));
  assert.deepEqual(dataformat.read(dir), { state: 'read', file, format: 2, build: '', at: null, backup: '', backupThere: false }, 'a name that is not a build, a time that is not one and a copy outside backups/ are not taken');

  const refusal = (found) => dataformat.refusal(found, { dataDir: dir, build: '0.6.0+41.abcdef1' });
  for (const found of [{ state: 'none', file }, { state: 'read', file, format: 1 }, { state: 'read', file, format: 2 }]) assert.equal(refusal(found), '', JSON.stringify(found));
  assert.equal(refusal({ state: 'unread', file, code: 'EBUSY' }), 'the data folder\'s format marker ' + file + ' could not be read (EBUSY), so which format the folder is in cannot be told. Nothing was changed. Start AGMessage again once it can be read (another program, often an antivirus or a backup, may hold it).');
  assert.match(refusal({ state: 'invalid', file }), /holds no format AGMessage can read\. Nothing was changed\. Put back the copy it had; or, if no build newer than this one has written the folder, move it aside/);
  const higher = { state: 'read', file, format: 3, build: '0.7.0+52.abcdef1', at: 5, backup: back, backupThere: true };
  assert.equal(refusal(higher), 'this data folder (' + dir + ') was last written by AGMessage 0.7.0+52.abcdef1 in format 3, and this build (0.6.0+41.abcdef1) reads format 2 and older. Nothing was changed. Start 0.7.0+52.abcdef1 or a newer build on this folder. To go back to this build, start it on the copy that build kept of the folder before it changed it: ' + path.join(dir, 'backups', 'format-2-20261101T120000Z-AbCdEf') + ' (set AGM_DATA_DIR to it, or copy what it holds into a data folder of its own).');
  assert.match(refusal({ ...higher, backupThere: false }), /kept of the folder before it changed it, \S+format-2-20261101T120000Z-AbCdEf, is no longer there\.$/);
  assert.match(refusal({ ...higher, build: '', backup: '' }), /last written by a build its marker does not name in format 3, .* Start the build that wrote it on this folder\. That build names no copy of the folder from before it changed it\.$/);
});

// ---------------------------------------------------------------- settled once the folder is held (on disk)
test('settled: a new folder is marked; a 0.5 folder is copied whole first, then marked last with its copy; the same build writes nothing; another build of the format is marked, newer or older', () => {
  const build = '0.6.0+41.abcdef1';
  // New: nothing in it but the watchdog's own and empty folders.
  const fresh = tmp('agm-format-');
  write(path.join(fresh, 'logs', 'server.log'), 'x\n');
  write(path.join(fresh, 'watchdog.log'), 'x\n');
  fs.mkdirSync(path.join(fresh, 'rooms'));
  assert.equal(dataformat.holdsData(fresh), false);
  assert.deepEqual(dataformat.settle(fresh, { build, now: NOW }), { format: 2, was: 0, before: '', newer: null, backup: '', upgraded: false }, 'no build named before it: neither newer nor older');
  assert.deepEqual(marker(fresh), { format: 2, build, at: NOW });
  assert.ok(!fs.existsSync(path.join(fresh, 'backups')), 'no copy of a new folder');

  // A 0.5 folder: copied whole (but the console) before anything else, then marked with its copy.
  const old = tmp('agm-format-');
  folder05(old);
  assert.equal(dataformat.holdsData(old), true);
  const before = tree(old, { skip: ['logs'] });
  const r = dataformat.settle(old, { build, now: NOW });
  assert.match(r.backup, /^backups\/format-1-20261102T203105Z-[0-9A-Za-z]{6}$/);
  assert.deepEqual(r, { format: 2, was: 1, before: '', newer: null, backup: r.backup, upgraded: true });
  assert.deepEqual(tree(path.join(old, ...r.backup.split('/'))), before, 'every file as it was, byte for byte; the console left out');
  assert.deepEqual(marker(old), { format: 2, build, at: NOW, backup: r.backup });
  assert.deepEqual(fs.readdirSync(path.join(old, 'backups')), [r.backup.split('/')[1]], 'no partial copy left');
  assert.equal(dataformat.rowWords(r, build), 'from a folder with no marker (format 1, as 0.5 and earlier leave it) to 0.6.0+41.abcdef1: the folder moved from format 1 to 2, and the folder as it was is kept in ' + r.backup);

  // The same build again: nothing written, no row.
  const kept = tree(old, { times: true });
  const same = dataformat.settle(old, { build, now: NOW + 1000 });
  assert.deepEqual(same, { format: 2, was: 2, before: build, newer: false, backup: '', upgraded: false });
  assert.deepEqual(tree(old, { times: true }), kept, 'no file written or touched');
  assert.equal(dataformat.rowWords(same, build), '');

  // Another build of the format: marked as this one's, and said newer, older, or neither when they are not ordered (a
  // local build, or two builds of one number).
  for (const [was, newer, order] of [['0.6.0+45.1234567', true, ', an older build than the one before it'], ['0.6.0-dev.40+1234567', false, ', a newer build'], ['0.6.0-dev+1234567', null, ''], ['0.6.0-dev.41+1234567', null, '']]) {
    fs.writeFileSync(path.join(old, 'format.json'), JSON.stringify({ format: 2, build: was, at: 1 }));
    const o = dataformat.settle(old, { build, now: NOW + 2000 });
    assert.deepEqual(o, { format: 2, was: 2, before: was, newer, backup: '', upgraded: true }, was);
    assert.deepEqual(marker(old), { format: 2, build, at: NOW + 2000 }, 'the marker names this build now');
    assert.equal(dataformat.rowWords(o, build), 'from ' + was + ' to ' + build + ' (format 2' + order + ')');
  }
  fs.writeFileSync(path.join(old, 'format.json'), JSON.stringify({ format: 2, at: 1 }));
  const unnamed = dataformat.settle(old, { build, now: NOW });
  assert.equal(unnamed.newer, null);
  assert.equal(dataformat.rowWords(unnamed, build), 'from a build its marker did not name to 0.6.0+41.abcdef1 (format 2)');
  assert.equal(fs.readdirSync(path.join(old, 'backups')).length, 1, 'the same format is never copied');

  // A marker naming format 1 is moved as a folder without one is, its copy marked as format 1.
  fs.writeFileSync(path.join(old, 'format.json'), JSON.stringify({ format: 1, build: '0.5.1+9.1234567', at: 1 }));
  const one = dataformat.settle(old, { build, now: NOW + 3000 });
  assert.deepEqual([one.was, one.before, one.newer, one.upgraded, fs.readdirSync(path.join(old, 'backups')).length], [1, '0.5.1+9.1234567', false, true, 2]);
  assert.match(dataformat.rowWords(one, build), /^from 0\.5\.1\+9\.1234567 to 0\.6\.0\+41\.abcdef1: the folder moved from format 1 to 2/);

  // The marker is read again once the folder is held, never taken from a read before it: one another build wrote since is
  // the one it goes by, and a refusal is never passed.
  fs.writeFileSync(path.join(old, 'format.json'), JSON.stringify({ format: 3, build: '0.7.0+52.abcdef1', at: 1 }));
  const higher = tree(old, { times: true });
  assert.throws(() => dataformat.settle(old, { build }), (e) => e.words === dataformat.refusal(dataformat.read(old), { dataDir: old, build }) && /in format 3/.test(e.words));
  assert.deepEqual(tree(old, { times: true }), higher, 'nothing written past a refusal');
});

test('settled: a copy, a step or a marker that cannot be made leaves the folder as it was and stops the start with words; a copy a stop left part way is removed; the disk keeps its reserve; the watchdog hears a long copy', (t) => {
  const build = '0.6.0+41.abcdef1';
  // The copies' folder cannot be made: nothing changed.
  const a = tmp('agm-format-');
  folder05(a);
  write(path.join(a, 'backups'), 'a file in the way');
  const before = tree(a, { times: true });
  assert.throws(() => dataformat.settle(a, { build, now: NOW }), (e) => /^the copy of the data folder .* that is kept before it is moved from format 1 to 2 could not be made in \S+backups, so nothing in the folder was changed\. .*\(E(EXIST|NOTDIR)\)$/.test(e.words));
  assert.deepEqual(tree(a, { times: true }), before);

  // A copy that fails part way: the partial copy removed, nothing else changed.
  const b = tmp('agm-format-');
  folder05(b);
  const cp = fs.cpSync;
  let n = 0;
  fs.cpSync = (...args) => { if (++n === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return cp(...args); };
  try {
    assert.throws(() => dataformat.settle(b, { build, now: NOW }), (e) => /could not be made .*\(ENOSPC\)$/.test(e.words));
  } finally { fs.cpSync = cp; }
  assert.deepEqual(fs.readdirSync(path.join(b, 'backups')), [], 'no copy, whole or partial');
  assert.ok(!fs.existsSync(path.join(b, 'format.json')));

  // A copy a stop left part way (killed, or the power gone) never reads as one, and the next copy's start removes it.
  write(path.join(b, 'backups', '.partial-format-1-20261101T000000Z-AbCdEf', 'rooms', 'ABC234.json'), '{"code":');
  const moved = dataformat.settle(b, { build, now: NOW });
  assert.deepEqual(fs.readdirSync(path.join(b, 'backups')), [moved.backup.split('/')[1]], 'the partial copy removed, the whole one made');

  // The disk's free space is read before a copy: one that would leave less than the reserve is refused, nothing written.
  const s = tmp('agm-format-');
  folder05(s);
  const roomy = tree(s, { times: true });
  assert.throws(() => dataformat.settle(s, { build, now: NOW, reserve: 2 ** 60 }), (e) => /^the data folder \S+ is moved from format 1 to 2 only once a copy of it is kept, and its disk has \d+ MB free: the copy needs 1 MB, and \d+ MB is kept free beside it for the saves and the logs\. Nothing in the folder was changed\. Free some space on that disk and start AGMessage again$/.test(e.words));
  assert.deepEqual(tree(s, { times: true }), roomy, 'no copy, no marker, no backups folder');
  assert.ok(dataformat.settle(s, { build, now: NOW, reserve: 0 }).backup, 'with room, copied');

  // A long copy beats for the watchdog at most every BEAT_MS (a clock that moves 100 ms each time it is read).
  const l = tmp('agm-format-');
  folder05(l);
  const clock = Date.now;
  let at = 0;
  let beats = 0;
  Date.now = () => (at += 100);
  try { dataformat.settle(l, { build, now: NOW, beat: () => { beats++; } }); } finally { Date.now = clock; }
  assert.ok(beats >= 2 && beats <= Math.floor(at / dataformat.BEAT_MS) + 1, beats + ' beats over ' + at + ' ms');
  let none = 0;
  dataformat.settle(tmp('agm-format-'), { build, now: NOW, beat: () => { none++; } });
  assert.equal(none, 0, 'no copy, no beat of its own');

  // A step that fails: the copy kept and named, the marker as it was (none), so the next start begins again.
  const c = tmp('agm-format-');
  folder05(c);
  const failing = { 1: { to: 2, run: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } } };
  let words = '';
  assert.throws(() => dataformat.settle(c, { build, now: NOW, steps: failing }), (e) => { words = e.words; return true; });
  const copies = fs.readdirSync(path.join(c, 'backups'));
  assert.equal(copies.length, 1);
  assert.equal(words, 'the data folder ' + c + ' could not be moved from format 1 to 2, and its marker is as it was, so the next start copies it and tries again. The folder as it was is kept in ' + path.join(c, 'backups', copies[0]) + ' (EROFS)');
  assert.ok(!fs.existsSync(path.join(c, 'format.json')));

  // The marker cannot be written (a folder in the way of its temporary file, which Linux refuses as EISDIR and Windows may
  // as EPERM): the start is refused in every case, so a folder never goes on without saying which build last wrote it.
  const blocked = (dir) => fs.mkdirSync(path.join(dir, 'format.json.' + process.pid + '.tmp'));
  const IN_THE_WAY = '\\(E(ISDIR|PERM|ACCES)\\)$';
  const d = tmp('agm-format-');
  folder05(d);
  blocked(d);
  assert.throws(() => dataformat.settle(d, { build, now: NOW }), (e) => new RegExp('was moved to format 2, and its marker \\S+format\\.json could not be written, so the next start copies it and tries again\\. The folder as it was is kept in \\S+format-1-\\S+ ' + IN_THE_WAY).test(e.words));
  const e1 = tmp('agm-format-');
  blocked(e1);
  assert.throws(() => dataformat.settle(e1, { build, now: NOW }), (e) => new RegExp('^the new data folder\'s marker \\S+format\\.json could not be written, so the folder would not say which build and format wrote it\\. No hall, account or setting was written in it\\. Start AGMessage again once the marker can be written \\(another program, often an antivirus or a backup, may hold it\\) ' + IN_THE_WAY).test(e.words));
  assert.ok(!fs.existsSync(path.join(e1, 'format.json')), 'a new folder: no marker, and the next start marks it');
  const e2 = tmp('agm-format-');
  fs.writeFileSync(path.join(e2, 'format.json'), JSON.stringify({ format: 2, build: '0.6.0+45.1234567', at: 1 }));
  blocked(e2);
  assert.throws(() => dataformat.settle(e2, { build, now: NOW }), (e) => new RegExp('^the data folder\'s marker \\S+format\\.json could not be written, so the folder would go on naming 0\\.6\\.0\\+45\\.1234567 as the build that last wrote it\\. Nothing in it was changed\\. .* ' + IN_THE_WAY).test(e.words));
  assert.equal(marker(e2).build, '0.6.0+45.1234567', 'as it was');

  // A folder that cannot be read through: whether it is new cannot be told, and nothing is written.
  const f = tmp('agm-format-');
  const readdir = fs.readdirSync;
  t.after(() => { fs.readdirSync = readdir; });
  fs.readdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.throws(() => dataformat.settle(f, { build, now: NOW }), (e) => /could not be read through, .* Nothing in it was changed \(EACCES\)$/.test(e.words));
  fs.readdirSync = readdir;
  assert.deepEqual(fs.readdirSync(f), []);
});

test('"This laptop"\'s row for the data folder: its format and what the start found, △ for a newer build before it', () => {
  const k = { format: 2, build: '0.6.0+41.abcdef1', dir: '/d' };
  const said = (o) => { const r = laptop.formatRow({ ...k, was: 2, before: k.build, newer: false, backup: '', ...o }); return [r.id, r.label, r.words, r.mark, r.from]; };
  assert.deepEqual(said({}), ['format', 'Data folder', 'format 2 · last written by this build', '', 'the data folder\'s format.json (' + path.join('/d', 'format.json') + '), read at this start']);
  assert.equal(said({ was: 0, before: '', newer: null })[2], 'format 2 · begun by this build');
  assert.equal(said({ was: 1, before: '', newer: null, backup: 'backups/format-1-x' })[2], 'format 2 · moved from format 1 at this start; the folder as it was is kept in ' + path.join('/d', 'backups', 'format-1-x'));
  assert.deepEqual(said({ before: '0.6.0+45.1234567', newer: true }).slice(2, 4), ['format 2 · last written by 0.6.0+45.1234567, a newer build than this one, before this start; this build reads its format, and writes it now', 'warn']);
  assert.deepEqual(said({ before: '0.6.0+40.1234567', newer: false }).slice(2, 4), ['format 2 · last written by 0.6.0+40.1234567, an older build, before this start; this build writes it now', '']);
  assert.equal(said({ before: '0.6.0-dev+1234567', newer: null })[2], 'format 2 · last written by 0.6.0-dev+1234567 before this start; this build writes it now');
  assert.equal(said({ before: '', newer: null })[2], 'format 2 · last written by a build its marker did not name; this build writes it now');
  // The panel draws it after the build, and only when the server gives it.
  const w = laptop.windowsFacts(null);
  const base = { build: k.build, runs: 'portable', addresses: [], port: 3023, node: 'node', https: { on: false, off: 'x', file: 'f' }, sealed: { total: 0 }, screens: { total: 0 }, stagewatch: { total: 0 }, tunnel: { running: false }, before: '', without: [] };
  assert.deepEqual(laptop.facts({ ...base, format: { ...k, was: 0, before: '', newer: null, backup: '' } }, w).slice(0, 3).map((r) => r.id), ['build', 'format', 'addresses']);
  assert.ok(!laptop.facts(base, w).some((r) => r.id === 'format'));
});

// ---------------------------------------------------------------- a server on the folder
/**
 * `server.js`, or the watchdog (`supervise.js`) that both channels start it through, run to its end on its own folders:
 * {code, out}. The installed node's watchdog is given no ADMIN_TOKEN, which it refuses: it makes its own.
 */
function run(env, ms = 20000, file = 'server.js') {
  return new Promise((resolve) => {
    const all = { ...process.env, PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05', ...env };
    if (file === 'supervise.js' && all.AGM_RUNS === 'task') delete all.ADMIN_TOKEN;
    const c = spawn(process.execPath, [path.join(h.ROOT, file)], { cwd: os.tmpdir(), env: all, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), ms);   // a copy that served when it should have stopped is a failure, not a hang
    c.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}
const folders = (base) => ({ AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys'), AGM_TOKEN_DIR: path.join(base, 'token') });
/** NODE_OPTIONS that preload these test files, beside what the run already has. */
const preload = (...names) => [process.env.NODE_OPTIONS, ...names.map((n) => '--require "' + path.join(__dirname, n).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
/** The server runs as this CI build (test/stamp-preload.js). */
const stamped = (build, channel = 'dev') => ({ NODE_OPTIONS: preload('stamp-preload.js'), AGM_TEST_STAMP: JSON.stringify({ version: BUILD.version, build, installVersion: installVersionOf(BUILD.version, build), commit: 'abcdef1234567', channel }) });
const health = async (srv) => (await h.api(srv.base, 'GET', '/api/health')).body;
const upgradedRows = (dataDir) => (fs.existsSync(path.join(dataDir, 'audit.jsonl')) ? fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'server.upgraded').map((e) => [e.actor.t, e.target, e.words]);
async function laptopRow(srv) {
  const cookie = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const s = await h.connect(srv.base, cookie);
  try { return (await h.answer(s, 'admin:settings', null)).laptop.facts.find((r) => r.id === 'format'); } finally { s.close(); }
}

test('a folder of a higher format, or whose marker cannot be read, stops the start with code 3 and its words in either channel, through the watchdog or not, and no file\'s time or bytes change', async () => {
  const base = tmp('agm-format-');
  const f = folders(base);
  folder05(f.AGM_DATA_DIR);
  const back = 'backups/format-2-20261101T120000Z-AbCdEf';
  fs.mkdirSync(path.join(f.AGM_DATA_DIR, ...back.split('/')), { recursive: true });
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'format.json'), JSON.stringify({ format: 3, build: '0.7.0+52.abcdef1', at: 1, backup: back }));
  const before = tree(base, { times: true });
  for (const file of ['supervise.js', 'server.js']) {
    for (const env of [{}, { AGM_RUNS: 'task' }]) {
      const why = file + ' ' + JSON.stringify(env);
      const r = await run({ ...f, ...env }, 20000, file);
      assert.equal(r.code, 3, why + '\n' + r.out);
      assert.ok(r.out.includes('AGMessage cannot start: this data folder (' + f.AGM_DATA_DIR + ') was last written by AGMessage 0.7.0+52.abcdef1 in format 3, and this build (' + BUILD.full + ') reads format 2 and older. Nothing was changed. Start 0.7.0+52.abcdef1 or a newer build on this folder. To go back to this build, start it on the copy that build kept of the folder before it changed it: ' + path.join(f.AGM_DATA_DIR, 'backups', 'format-2-20261101T120000Z-AbCdEf')), why + '\n' + r.out);
      assert.ok(!/is running|\[watchdog\]/.test(r.out), 'it never served, and the watchdog started no server: ' + why + '\n' + r.out);
      assert.deepEqual(tree(base, { times: true }), before, 'no file written or touched, no folder, log or key made: ' + why);
    }
  }
  // A marker another program holds, or one that holds no format.
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'format.json'), JSON.stringify({ format: 2, build: BUILD.full, at: 1 }));
  const held = tree(base, { times: true });
  for (const file of ['supervise.js', 'server.js']) {
    const busy = await run({ ...f, NODE_OPTIONS: preload('busy-preload.js'), AGM_TEST_UNREADABLE: 'format.json' }, 20000, file);
    assert.equal(busy.code, 3, busy.out);
    assert.match(busy.out, /AGMessage cannot start: the data folder's format marker \S+format\.json could not be read \(EBUSY\), so which format the folder is in cannot be told\. Nothing was changed\./);
    assert.deepEqual(tree(base, { times: true }), held, file);
  }
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'format.json'), '{"format":');
  const settled = tree(base, { times: true });
  for (const file of ['supervise.js', 'server.js']) {
    const torn = await run({ ...f, AGM_RUNS: 'task' }, 20000, file);
    assert.equal(torn.code, 3, torn.out);
    assert.match(torn.out, /AGMessage cannot start: \S+format\.json holds no format AGMessage can read\. Nothing was changed\./);
    assert.deepEqual(tree(base, { times: true }), settled, file);
  }
});

test('a first start marks its folder once it holds it; a 0.5 folder is copied whole into backups/ and marked, said in its window, health, "This laptop" and one audit row; a restart writes neither again', async (t) => {
  const base = tmp('agm-format-');
  const f = folders(base);
  // A new folder: marked once held, nothing copied, nothing said in the window.
  const fresh = folders(tmp('agm-format-'));
  const first = await h.startServer(fresh);
  t.after(() => h.stopServer(first.child));
  assert.deepEqual([marker(fresh.AGM_DATA_DIR).format, marker(fresh.AGM_DATA_DIR).build, Object.keys(marker(fresh.AGM_DATA_DIR))], [2, BUILD.full, ['format', 'build', 'at']]);
  assert.deepEqual((await health(first)).format, { format: 2, was: 0, before: '', newer: null, backup: '' });
  assert.ok(!fs.existsSync(path.join(fresh.AGM_DATA_DIR, 'backups')) && !/Data folder:/.test(first.out()), first.out());
  assert.equal((await laptopRow(first)).words, 'format 2 · begun by this build');
  assert.deepEqual(upgradedRows(fresh.AGM_DATA_DIR), [], 'nothing upgraded');
  await h.stopServer(first.child);

  // Refused at its held folder: no marker, no copy.
  folder05(f.AGM_DATA_DIR);
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(f.AGM_DATA_DIR).toLowerCase() : path.resolve(f.AGM_DATA_DIR)).digest('hex').slice(0, 16);
  const other = await new Promise((resolve) => { const s = net.createServer((c) => c.end()); s.listen(process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + id : path.join(os.tmpdir(), 'agmessage-' + id + '.sock'), () => resolve(s)); });
  const refused = await run(f);
  await new Promise((resolve) => { other.close(resolve); });
  assert.equal(refused.code, 3, refused.out);
  assert.ok(!fs.existsSync(path.join(f.AGM_DATA_DIR, 'format.json')) && !fs.existsSync(path.join(f.AGM_DATA_DIR, 'backups')), 'refused at the hold: no marker, no copy');

  // Held: copied whole, then marked.
  const before = tree(f.AGM_DATA_DIR, { skip: ['logs'] });
  const srv = await h.startServer(f);
  t.after(() => h.stopServer(srv.child));
  const m = marker(f.AGM_DATA_DIR);
  assert.match(m.backup, /^backups\/format-1-\d{8}T\d{6}Z-[0-9A-Za-z]{6}$/);
  assert.deepEqual([m.format, m.build, Number.isFinite(m.at)], [2, BUILD.full, true]);
  assert.deepEqual(tree(path.join(f.AGM_DATA_DIR, ...m.backup.split('/'))), before, 'the folder as it was, byte for byte');
  const backupDir = path.join(f.AGM_DATA_DIR, ...m.backup.split('/'));
  assert.ok(srv.out().includes('  Data folder: format 2 · moved from format 1 at this start; the folder as it was is kept in ' + backupDir + '\n'), srv.out());
  const hl = await health(srv);
  assert.equal(hl.build, BUILD.full);
  assert.deepEqual(hl.format, { format: 2, was: 1, before: '', newer: null, backup: m.backup });
  const row = await laptopRow(srv);
  assert.deepEqual([row.words, row.mark], ['format 2 · moved from format 1 at this start; the folder as it was is kept in ' + backupDir, '']);
  assert.deepEqual(upgradedRows(f.AGM_DATA_DIR), [['system', BUILD.full, 'from a folder with no marker (format 1, as 0.5 and earlier leave it) to ' + BUILD.full + ': the folder moved from format 1 to 2, and the folder as it was is kept in ' + m.backup]]);
  await h.stopServer(srv.child);

  // Again, the same build: nothing written, no copy, no row; health says it was this build's.
  const kept = fs.readFileSync(path.join(f.AGM_DATA_DIR, 'format.json'));
  const keptAt = fs.statSync(path.join(f.AGM_DATA_DIR, 'format.json')).mtimeMs;
  const again = await h.startServer(f);
  t.after(() => h.stopServer(again.child));
  assert.deepEqual([fs.readFileSync(path.join(f.AGM_DATA_DIR, 'format.json')).equals(kept), fs.statSync(path.join(f.AGM_DATA_DIR, 'format.json')).mtimeMs], [true, keptAt]);
  assert.equal(fs.readdirSync(path.join(f.AGM_DATA_DIR, 'backups')).length, 1);
  assert.deepEqual((await health(again)).format, { format: 2, was: 2, before: BUILD.full, newer: false, backup: '' });
  assert.ok(!/Data folder:/.test(again.out()), 'nothing to say in the window');
  assert.equal(upgradedRows(f.AGM_DATA_DIR).length, 1);
  assert.equal((await laptopRow(again)).words, 'format 2 · last written by this build');
});

test('a newer build of the same format before this one is said in health, the window and "This laptop" (△), the folder marked as this build\'s with one row; an older one is said without a mark', async (t) => {
  const base = tmp('agm-format-');
  const f = folders(base);
  folder05(f.AGM_DATA_DIR);
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'format.json'), JSON.stringify({ format: 2, build: NEW, at: 1 }));
  const srv = await h.startServer({ ...f, ...stamped(41) });
  t.after(() => h.stopServer(srv.child));
  const hl = await health(srv);
  const me = BUILD.version + '-dev.41+abcdef1';
  assert.equal(hl.build, me, 'the stamped build serves');
  assert.deepEqual(hl.format, { format: 2, was: 2, before: NEW, newer: true, backup: '' });
  const words = 'format 2 · last written by ' + NEW + ', a newer build than this one, before this start; this build reads its format, and writes it now';
  assert.ok(srv.out().includes('  Data folder: ' + words + '\n'), srv.out());
  const row = await laptopRow(srv);
  assert.deepEqual([row.words, row.mark], [words, 'warn']);
  assert.deepEqual(marker(f.AGM_DATA_DIR).build, me);
  assert.deepEqual(upgradedRows(f.AGM_DATA_DIR), [['system', me, 'from ' + NEW + ' to ' + me + ' (format 2, an older build than the one before it)']]);
  assert.ok(!fs.existsSync(path.join(f.AGM_DATA_DIR, 'backups')), 'the same format is never copied');
  await h.stopServer(srv.child);

  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'format.json'), JSON.stringify({ format: 2, build: OLD, at: 1 }));
  const later = await h.startServer({ ...f, ...stamped(41) });
  t.after(() => h.stopServer(later.child));
  assert.deepEqual((await health(later)).format, { format: 2, was: 2, before: OLD, newer: false, backup: '' });
  assert.deepEqual(await laptopRow(later).then((r) => [r.words, r.mark]), ['format 2 · last written by ' + OLD + ', an older build, before this start; this build writes it now', '']);
  assert.ok(!/Data folder:/.test(later.out()), 'an older build before it is no news in the window');
  assert.deepEqual(upgradedRows(f.AGM_DATA_DIR)[1], ['system', me, 'from ' + OLD + ' to ' + me + ' (format 2, a newer build)']);
});

test('a marker that cannot be written stops the start with code 3 and its words, in either channel, nothing served; the next start, once it can be, marks the folder', async (t) => {
  const base = tmp('agm-format-');
  const f = folders(base);
  for (const [file, env] of [['server.js', {}], ['supervise.js', { AGM_RUNS: 'task' }]]) {
    const r = await run({ ...f, ...env, NODE_OPTIONS: preload('busy-preload.js'), AGM_TEST_UNWRITABLE: 'format.json' }, 20000, file);
    assert.equal(r.code, 3, file + '\n' + r.out);
    assert.ok(r.out.includes('AGMessage cannot start: the new data folder\'s marker ' + path.join(f.AGM_DATA_DIR, 'format.json') + ' could not be written, so the folder would not say which build and format wrote it. No hall, account or setting was written in it. Start AGMessage again once the marker can be written (another program, often an antivirus or a backup, may hold it) (EBUSY)'), file + '\n' + r.out);
    assert.ok(!/is running/.test(r.out), 'it never served: ' + file + '\n' + r.out);
    assert.ok(!fs.existsSync(path.join(f.AGM_DATA_DIR, 'format.json')), 'no marker: ' + file);
    assert.deepEqual(fs.readdirSync(f.AGM_DATA_DIR).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left: ' + file);
  }
  const srv = await h.startServer(f);
  t.after(() => h.stopServer(srv.child));
  assert.deepEqual([marker(f.AGM_DATA_DIR).format, marker(f.AGM_DATA_DIR).build], [2, BUILD.full]);
  assert.deepEqual((await health(srv)).format, { format: 2, was: 0, before: '', newer: null, backup: '' }, 'still a new folder: nothing was written in it before');
  assert.deepEqual(upgradedRows(f.AGM_DATA_DIR), []);
});

test('a copy that outlasts the watchdog\'s start window keeps its beat: the move is never taken for a hang, and the copy serves once it is whole', async (t) => {
  const base = tmp('agm-format-');
  const f = folders(base);
  folder05(f.AGM_DATA_DIR);
  for (let i = 0; i < 8; i++) write(path.join(f.AGM_DATA_DIR, 'notes', 'n' + i + '.txt'), 'x');
  // Each file and folder the copy takes waits 350 ms (test/slowcopy-preload.js): about 16 of them, over 5 s, past the
  // watchdog's 4 s for a first beat and its 3 s between beats.
  const port = await h.freePort();
  const all = { ...process.env, ...f, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_STARTUP_MS: '4000', AGM_HANG_MS: '3000', NODE_OPTIONS: preload('slowcopy-preload.js'), AGM_TEST_SLOW_COPY_MS: '350' };
  const started = Date.now();
  const p = spawn(process.execPath, [path.join(h.ROOT, 'supervise.js')], { env: all, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { p.once('exit', resolve); });
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) { try { p.send({ t: 'stop' }); } catch { p.kill('SIGKILL'); } } await done; });
  let hl = null;
  for (const end = Date.now() + 30000; !hl && Date.now() < end;) {
    try { hl = (await h.api('http://127.0.0.1:' + port, 'GET', '/api/health')).body; } catch { await h.wait(100); }
    if (hl && !hl.format) { hl = null; await h.wait(100); }
  }
  assert.ok(hl, 'it serves:\n' + out);
  assert.ok(Date.now() - started > 4000, 'the copy outlasted the start window (' + (Date.now() - started) + ' ms)');
  assert.match(hl.format.backup, /^backups\/format-1-/);
  assert.equal(fs.readdirSync(path.join(f.AGM_DATA_DIR, ...hl.format.backup.split('/'), 'notes')).length, 8);
  assert.ok(!/no heartbeat|restarting/.test(out), 'never killed, never started again:\n' + out);
});
