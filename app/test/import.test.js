'use strict';
// The portable import, before the installed node's first start (the 0.6.0 plan's Part 6, unit U14): launch.js export and
// forget-keys (the account that started the installer's half), machine.js import's three steps (the elevated half) and
// lib/importfacts.js (what both compare), run here end to end on this disk: a real portable copy seeded and stopped, its
// bundle exported, taken and verified into a machine folder prepare made, its keys forgotten, the installed node started
// on what was imported, and the portable copy refused at its next start. Windows' programs (whoami, icacls, reg) are stood
// in for; what only a Windows run proves is the readings lane's R6 (tools/readings-take.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const launch = require('../launch');
const importfacts = require('../lib/importfacts');
const dataformat = require('../lib/dataformat');
const { BUILD } = require('../lib/version');

const SYS = 'C:\\Windows\\System32';
const ANA = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (f) => fs.readFileSync(f, 'utf8');
const fail = (status, stderr = '') => Object.assign(new Error('failed'), { status, stdout: '', stderr });

/**
 * Windows' programs stood in for: whoami (`sid`, `name`), icacls (each call kept), reg (the install record's values in
 * `record`, none when it is null; a value added kept), powershell (PS_WHOSE's names for SIDs, from `names`).
 */
function windows({ sid = ANA, name = 'LAPTOP\\ana', record = null, names = {} } = {}) {
  const calls = [];
  const run = (exe, args) => {
    const n = path.win32.basename(exe);
    calls.push({ name: n, args });
    if (n === 'whoami.exe') return '"' + name + '","' + sid + '"\r\n';
    if (n === 'icacls.exe') return 'processed 1 files';
    if (n === 'reg.exe') {
      if (args[0] !== 'query') return '';
      if (!record || args[1] !== 'HKLM\\SOFTWARE\\AGMessage') throw fail(1);
      return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\AGMessage\r\n' + Object.entries(record).map(([k, v]) => '    ' + k + '    REG_SZ    ' + v).join('\r\n') + '\r\n';
    }
    if (n === 'powershell.exe') return JSON.stringify({ names }) + '\r\n';
    throw new Error('not stood in for: ' + n + ' ' + args.join(' '));
  };
  return { run, calls };
}
/** The install record of a first install whose admin is Ana, as finish reads it to name her. */
const ANA_RECORD = Object.freeze({ InstallDir: 'C:\\Program Files\\AGMessage', Admin: ANA, AdminName: 'LAPTOP\\ana' });
/** machine.js import --step finish, as the installer runs it: the record read through reg.exe, Windows' names through powershell.exe. */
const finish = (root, id, stand = { run: windows({ record: ANA_RECORD }).run }) => machine.run(['import', '--step', 'finish', '--for', ANA, '--machine', root, '--sys', SYS, '--id', id], stand);
/** A machine folder as prepare makes it, on this disk. */
function machineFolder() {
  const root = path.join(tmp('agm-imp-'), 'AGMessage');
  machine.prepare({ '--machine': root, '--sys': SYS }, { run: windows().run });
  return root;
}
/** Every file under `dir` with its bytes' SHA-256, '/' between folders: what a test compares a copy by. */
function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; /* not there: no file */ }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r); else out[r] = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex') + ':' + st.mtimeMs;
    }
  };
  walk(dir, '');
  return out;
}
const bytesOf = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.split(':')[0]]));

/**
 * A portable copy run once on this disk and stopped, as a person's would be: its data and uploads in <folder>\app, its
 * keys in the account's profile (`home`/.agmessage, where lib/secretbox.js keeps them off Windows), a certificate made, a
 * hall with two messages, an account, a screen, a sealed AI key, and its start file. {src, keys, env}.
 */
async function portable() {
  const src = path.join(tmp('agm-port-'), 'AGMessage');
  const keys = path.join(tmp('agm-home-'), '.agmessage');
  fs.mkdirSync(path.join(src, 'app'), { recursive: true });
  fs.writeFileSync(path.join(src, 'start-agmessage.bat'), '@echo off\r\nREM the portable folder\'s own start\r\n');
  const env = { AGM_DATA_DIR: path.join(src, 'app', 'data'), AGM_UPLOAD_DIR: path.join(src, 'app', 'uploads'), AGM_KEY_DIR: keys, AGM_TLS: '1', AGM_TEST_SNAPSHOTS: path.join(path.dirname(keys), 'snapshots.txt') };
  const srv = await h.startServer(env);
  let hall;
  try {
    const tok = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
    hall = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: tok })).body.code;
    const ctl = await h.connect(srv.base, tok);
    const made = await h.emit(ctl, 'display:create', { code: hall, name: 'Lectern' });
    assert.equal(made.ok, true, JSON.stringify(made));
    const keyed = await h.emit(ctl, 'admin:settings', { aiKey: 'a key typed for the import test' });
    assert.equal(keyed.ok, true, JSON.stringify(keyed));
    ctl.close();
    assert.equal((await h.api(srv.base, 'POST', '/api/setup', { token: h.TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).status, 200);
    const g = await h.connect(srv.base);
    assert.equal((await h.emit(g, 'join', { roomCode: hall, name: 'Gus', role: 'research' })).ok, true);
    for (const text of ['one', 'two']) { const sent = await h.emit(g, 'message', { type: 'text', text, cid: 'c-' + text }); assert.equal(sent.ok, true, JSON.stringify(sent)); }
    g.close();
    fs.mkdirSync(env.AGM_UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.AGM_UPLOAD_DIR, 'abc123.png'), h.pngOf(2, 2));
  } finally { await h.stopServer(srv.child); }
  return { src, keys, env, hall, data: env.AGM_DATA_DIR };
}

/** One of app's scripts run to its end with `env` (a portable copy's): {code, out}, its output and its error output together. */
function ended(script, env) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(h.ROOT, script)], { env: { ...process.env, HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// ---------------------------------------------------------------- end to end

test('end to end: a stopped portable copy is exported as its account, taken and verified elevated, its keys forgotten, the installed node starts on it, and the portable copy no longer does', async (t) => {
  const { src, keys, env, hall, data } = await portable();
  const root = machineFolder();
  const before = bytesOf(tree(data));
  const keysBefore = bytesOf(tree(keys));
  const win = windows();
  // stage: a fresh import\ folder in the account's inbox, which it may add files to and never a folder.
  const stage = await machine.run(['import', '--step', 'stage', '--for', ANA, '--machine', root, '--sys', SYS], { run: win.run });
  assert.equal(stage.code, machine.DONE, stage.text);
  const dir = machine.importDir(root, ANA);
  assert.ok(fs.statSync(dir).isDirectory());
  const grants = win.calls.filter((c) => c.name === 'icacls.exe' && c.args[0] === dir).map((c) => c.args.slice(1));
  assert.deepEqual(grants, [['/inheritance:r', '/grant:r', ...machine.BASE_GRANTS, '*' + ANA + ':(WD)'], ['/grant', '*' + ANA + ':(OI)(IO)W']], 'the inbox\'s own grants: add a file, write it, never a folder');
  // export: the bundle, as the account, its answer for the installer.
  const ex = await launch.exportPortable({ source: src, machine: root, sys: SYS, run: win.run, profile: keys });
  assert.equal(ex.code, launch.DONE, ex.text);
  const manifest = JSON.parse(read(path.join(dir, launch.MANIFEST)));
  assert.deepEqual([manifest.v, manifest.id, manifest.sid, manifest.source], [1, ex.id, ANA, path.resolve(src)]);
  assert.deepEqual(JSON.parse(read(path.join(dir, launch.EXPORT_SAID))).code, 0);
  const rows = manifest.files.map((f) => f.area + '/' + f.rel);
  for (const want of ['data/settings.json', 'data/secret.key', 'data/accounts.json', 'data/displays.json', 'data/format.json', 'data/audit.jsonl', 'uploads/abc123.png', 'keys/machine.key', 'keys/tls.json']) assert.ok(rows.includes(want), want + ' is carried');
  assert.ok(rows.some((r) => r.startsWith('keys/audit/')), 'the audit records travel');
  assert.ok(!rows.some((r) => /^data\/(?:logs|backups)\/|^data\/watchdog\./.test(r)), 'the copy\'s console, backups and watchdog files stay');
  assert.deepEqual([manifest.facts.halls, manifest.facts.messages >= 2, manifest.facts.accounts, manifest.facts.screens, manifest.facts.sealed.open, manifest.facts.sealed.total], [1, true, 1, 1, manifest.facts.sealed.total, manifest.facts.sealed.total]);
  assert.ok(manifest.facts.sealed.total >= 3, 'the AI key, the screen\'s link and the certificate\'s private key: ' + manifest.facts.sealed.total);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, manifest.files.length, 'one part a file, named by its place');
  assert.deepEqual(bytesOf(tree(data)), before, 'the export copies: the portable folder is as it was');
  // take: copied and verified; the verdict in the account's outbox.
  const out = path.join(tmp('agm-out-'), 'take.json');
  const take = await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', root, '--app', h.REPO, '--source', src, '--sys', SYS, '--out', out]);
  assert.equal(take.code, machine.DONE, take.text);
  const rec = JSON.parse(read(out));
  assert.deepEqual([rec.verified, rec.id, rec.checks], [true, ex.id, []]);
  assert.match(rec.words, /^Imported and verified: 1 hall, \d+ messages, 1 account and 1 screen, counted alike; every sealed value opens \(\d+\); the certificate's fingerprint is unchanged; the audit chain checks \(\d+ entries\)\.$/);
  const laid = bytesOf(tree(path.join(root, 'data')));
  for (const [rel, sha] of Object.entries(before)) {
    if (/^(?:logs|backups)\/|^watchdog\./.test(rel)) continue;
    assert.equal(laid[rel], sha, 'data/' + rel + ' laid byte for byte');
  }
  assert.equal(bytesOf(tree(path.join(root, 'keys')))['machine.key'], keysBefore['machine.key'], 'the machine key travelled: every sealed value opens with it');
  assert.equal(bytesOf(tree(path.join(root, 'uploads')))['abc123.png'], require('crypto').createHash('sha256').update(h.pngOf(2, 2)).digest('hex'));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.part')), [], 'each part goes once it is laid');
  const verdict = JSON.parse(read(machine.importVerdict(root, ANA)));
  assert.deepEqual([verdict.verified, verdict.id, verdict.source, verdict.halls, verdict.accounts, verdict.screens], [true, ex.id, path.resolve(src), 1, 1, 1]);
  // forget-keys: the mark, then the copies removed, each checked.
  const fk = launch.forgetKeys({ source: src, machine: root, sys: SYS, id: ex.id, run: win.run, profile: keys });
  assert.equal(fk.code, launch.DONE, fk.text);
  assert.deepEqual([fk.verified, fk.moved, fk.bat, fk.keys, fk.secret], [true, true, 'replaced', { ok: true, was: true }, { ok: true, was: true }]);
  assert.ok(!fs.existsSync(keys), 'the profile\'s AGMessage folder is gone');
  assert.ok(!fs.existsSync(path.join(data, 'secret.key')), 'and the folder\'s secret.key');
  assert.equal(dataformat.movedOf(data).state, 'moved');
  assert.equal(read(path.join(src, 'start-agmessage.bat.moved')), '@echo off\r\nREM the portable folder\'s own start\r\n', 'the original start file kept');
  assert.match(read(path.join(src, 'start-agmessage.bat')), /moved into the AGMessage installed on this PC/);
  // finish: one machine event, the import folder cleared, the verdict gone.
  const fin = await finish(root, ex.id);
  assert.equal(fin.code, machine.DONE, fin.text);
  assert.match(fin.text, /^Imported: 1 hall, \d+ messages, 1 account and 1 screen, verified\. The import is verified, so the old copies are gone: /);
  const events = read(path.join(root, 'machine', 'events.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.kind, e.by.sid, e.for.sid]), [['machine.import', ANA, ANA]]);
  assert.match(events[0].words, /^LAPTOP\\ana imported a portable AGMessage folder \(build [^)]+\): 1 hall, \d+ messages, 1 account and 1 screen, verified; its old copies of the keys were removed and the folder is marked as moved\.$/);
  for (const p of [keys, src, os.homedir()]) assert.ok(!events[0].words.includes(p), 'no path in a profile, nor the folder, is in the event');
  assert.ok(!fs.existsSync(dir) && !fs.existsSync(machine.importVerdict(root, ANA)));
  // The installed node starts on what was imported, under the task: a sealed value that did not open would stop it.
  const task = { AGM_RUNS: 'task', AGM_DATA_DIR: path.join(root, 'data'), AGM_UPLOAD_DIR: path.join(root, 'uploads'), AGM_KEY_DIR: path.join(root, 'keys'), AGM_MACHINE_EVENTS: path.join(root, 'machine', 'events.jsonl'), AGM_TLS: '1' };
  const srv = await h.startServer(task);
  t.after(() => h.stopServer(srv.child));
  const served = (await h.api(srv.base, 'GET', '/api/rooms/' + hall)).body;
  assert.deepEqual([served.exists, served.name], [true, 'Hall 1'], 'its hall is served, by its code');
  const log = () => { try { return read(path.join(root, 'data', 'audit.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  await h.until(() => log().some((e) => e.action === 'machine.import'), 15000, 'the import is a row of the audit log');
  const row = log().find((e) => e.action === 'machine.import');
  assert.deepEqual([row.actor.t, row.actor.id, row.target], ['windows', ANA, ANA]);
  assert.ok(log().some((e) => e.action === 'audit.moved'), 'the chain carries on, and says where it was written last');
  await h.stopServer(srv.child);
  // The portable copy refuses to start, its server and its watchdog alike, before either writes anything.
  const left = tree(data);
  for (const script of ['server.js', 'supervise.js']) {
    const r = await ended(script, { ...env, PORT: String(await h.freePort()) });
    assert.equal(r.code, 3, script + ': ' + r.out);
    assert.match(r.out, /AGMessage cannot start: this folder's AGMessage \(.+\) was moved into the AGMessage installed on this PC on \d{4}-\d\d-\d\d \(build [^)]+\): its halls, accounts and keys are there now/, script);
  }
  assert.deepEqual(tree(data), left, 'nothing written in the portable folder');
  assert.ok(!fs.existsSync(keys), 'and no new machine key made in the profile');
});

/** A portable copy and its keys copied whole into new folders (a test's own, so one seeded copy serves several). */
function copyOf({ src, keys }) {
  const to = path.join(tmp('agm-port-'), 'AGMessage');
  const k = path.join(tmp('agm-home-'), '.agmessage');
  fs.cpSync(src, to, { recursive: true });
  fs.cpSync(keys, k, { recursive: true });
  return { src: to, keys: k, data: path.join(to, 'app', 'data') };
}

test('export refuses, with nothing exported: a copy running on the folder, a folder last run by another build, keys another account\'s, an audit log that does not check, a link anywhere in what it carries', async (t) => {
  const seeded = await portable();
  const win = windows();
  const ready = () => { const root = machineFolder(); assert.equal(machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run }).words.startsWith('The import is ready'), true); return root; };
  const refused = async (p, root, re) => {
    const r = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
    assert.equal(r.code, launch.NOT_DONE, r.text);
    assert.match(r.text, re);
    assert.match(r.text, /Nothing was exported\.$/);
    const dir = machine.importDir(root, ANA);
    assert.deepEqual(fs.readdirSync(dir), [launch.EXPORT_SAID], 'no part and no manifest: only its answer, for the installer');
    assert.deepEqual([JSON.parse(read(path.join(dir, launch.EXPORT_SAID))).code, JSON.parse(read(path.join(dir, launch.EXPORT_SAID))).words], [launch.NOT_DONE, r.text]);
  };
  // A copy running on the folder: its folder pipe answers.
  const running = copyOf(seeded);
  const srv = await h.startServer({ AGM_DATA_DIR: running.data, AGM_UPLOAD_DIR: path.join(running.src, 'app', 'uploads'), AGM_KEY_DIR: running.keys, AGM_TLS: '1', AGM_TEST_SNAPSHOTS: path.join(path.dirname(running.keys), 'snapshots.txt') });
  t.after(() => h.stopServer(srv.child));
  await refused(running, ready(), /^The portable AGMessage in .+ is running \(it says it is (?:busy: \d+ pages? active|idle: nothing in the last 10 minutes[^)]*)\): press Ctrl\+C in its window, then import again\./);
  // An AGMessage answering on the installed node's port.
  const onPort = await launch.exportPortable({ source: copyOf(seeded).src, machine: ready(), sys: SYS, run: win.run, profile: copyOf(seeded).keys, port: srv.port });
  assert.match(onPort.text, /^AGMessage [^ ]+ answers on port \d+: a portable copy is still running\./);
  await h.stopServer(srv.child);
  // Last run by another build.
  const older = copyOf(seeded);
  fs.writeFileSync(path.join(older.data, 'format.json'), JSON.stringify({ format: 2, build: '0.6.0+7.abc1234', at: Date.now() }));
  await refused(older, ready(), /^This folder was last run by AGMessage 0\.6\.0\+7\.abc1234, and this AGMessage is .+: the import takes only a folder last run by this same build\./);
  const unmarked = copyOf(seeded);
  fs.rmSync(path.join(unmarked.data, 'format.json'));
  await refused(unmarked, ready(), /^This folder was last run by AGMessage 0\.5 or earlier, or by none \(app\\data holds no format\.json\)/);
  // Keys another account's: a profile with a machine key of its own, or none.
  const other = copyOf(seeded);
  fs.writeFileSync(path.join(other.keys, 'machine.key'), require('crypto').randomBytes(32).toString('base64'));
  await refused(other, ready(), /^This folder's keys are another Windows account's: install from that account\. \(\d+ of \d+ sealed values do not open with the machine key in .+: .*settings\.json aiKeySealed/);
  const none = copyOf(seeded);
  fs.rmSync(none.keys, { recursive: true });
  await refused(none, ready(), /^This folder's keys are another Windows account's: install from that account\. \(No machine key is in this account's profile/);
  // What the installed node's own start refuses is never carried: a machine key that is not one (over a folder that
  // sealed nothing with it, and over one that did), a server secret that is not one, a certificate it cannot use.
  const keyless = { src: path.join(tmp('agm-port-'), 'AGMessage'), keys: path.join(tmp('agm-home-'), '.agmessage') };
  fs.mkdirSync(path.join(keyless.src, 'app', 'data'), { recursive: true });
  fs.writeFileSync(path.join(keyless.src, 'app', 'data', 'format.json'), JSON.stringify({ format: dataformat.FORMAT, build: BUILD.full, at: Date.now() }));
  fs.mkdirSync(keyless.keys, { recursive: true });
  fs.writeFileSync(path.join(keyless.keys, 'machine.key'), 'not a key');
  await refused(keyless, ready(), /^The machine key in this account's profile \(.+machine\.key\) is not a key AGMessage made, and the installed AGMessage never starts on one it cannot read\. Nothing in the folder was sealed with it: move it aside, then import again\./);
  fs.rmSync(path.join(keyless.keys, 'machine.key'));
  assert.equal((await launch.exportPortable({ source: keyless.src, machine: ready(), sys: SYS, run: win.run, profile: keyless.keys })).code, launch.DONE, 'with it moved aside, the folder that sealed nothing is exported');
  const badKey = copyOf(seeded);
  fs.writeFileSync(path.join(badKey.keys, 'machine.key'), 'not a key');
  await refused(badKey, ready(), /^The machine key in this account's profile \(.+\) is not a key AGMessage made, and the installed AGMessage never starts on one it cannot read\. The folder's sealed values cannot be carried without it: put back the copy it had, then import again\./);
  const badSecret = copyOf(seeded);
  fs.writeFileSync(path.join(badSecret.data, 'secret.key'), 'not a secret');
  await refused(badSecret, ready(), /^The folder's server secret \(app\\data\\secret\.key\) could not be read or holds no server secret, and the installed AGMessage never starts on one it cannot read\./);
  const badCert = copyOf(seeded);
  const tls = JSON.parse(read(path.join(badCert.keys, 'tls.json')));
  fs.writeFileSync(path.join(badCert.keys, 'tls.json'), JSON.stringify({ ...tls, certDer: Buffer.from('not a certificate').toString('base64') }));
  await refused(badCert, ready(), /^The certificate in this account's profile \(.+tls\.json\) cannot be used \(EBADCERT\), and the installed AGMessage never starts on one it cannot use\. Put back the copy it had; or move it aside/);
  // An audit log that does not check.
  const broken = copyOf(seeded);
  const auditFile = path.join(broken.data, 'audit.jsonl');
  const lines = read(auditFile).split('\n');
  lines[1] = lines[1].replace(/"words":"/, '"words":"changed ');
  fs.writeFileSync(auditFile, lines.join('\n'));
  await refused(broken, ready(), /^The portable folder's audit log does not check \(Broken at line 2 of audit\.jsonl: entry 2 was changed after it was written\)\. Start the portable copy, see Admin → Health/);
  // A link anywhere in what it carries: never followed, never carried.
  const linked = copyOf(seeded);
  const elsewhere = tmp('agm-else-');
  fs.writeFileSync(path.join(elsewhere, 'theirs.txt'), 'not the folder\'s');
  fs.symlinkSync(elsewhere, path.join(linked.data, 'stage-link'), 'junction');
  await refused(linked, ready(), /stage-link is a link or a junction: an import carries files, never what a link names\./);
  // The folder chosen, or its app\, a link or junction: never followed, whatever it names.
  const real = copyOf(seeded);
  const viaLink = path.join(tmp('agm-via-'), 'AGMessage');
  fs.symlinkSync(real.src, viaLink, 'junction');
  await refused({ src: viaLink, keys: real.keys }, ready(), /AGMessage is a link or a junction: an import reads the portable folder itself, never what a link names\. Choose the folder it names\./);
  fs.renameSync(path.join(real.src, 'app'), path.join(real.src, 'app.real'));
  fs.symlinkSync(path.join(real.src, 'app.real'), path.join(real.src, 'app'), 'junction');
  await refused(real, ready(), /app is a link or a junction: an import reads the portable folder itself/);
  // What a data folder keeps that an import leaves (its backups, its console) is never walked: a link there is not met.
  const kept = copyOf(seeded);
  fs.mkdirSync(path.join(kept.data, 'backups'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(kept.data, 'backups', 'old'), 'junction');
  assert.ok(launch.filesOf('data', kept.data).files.length > 0, 'its backups are not walked');
  // The walk stops once more files than a bundle carries are seen.
  const many = tmp('agm-many-');
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(many, n), n);
  let looked = 0;
  const counting = { ...fs, lstatSync: (...a) => { looked++; return fs.lstatSync(...a); } };
  assert.deepEqual(launch.filesOf('uploads', many, { max: 1, fsImpl: counting }), { over: true });
  assert.ok(looked <= 3, 'the walk stopped at the file past its bound (' + looked + ' looks)');
  assert.equal(launch.filesOf('uploads', many, { max: 3 }).files.length, 3);
  // A file swapped between the walk and its copy: the file read is not the one the walk saw, so nothing is copied.
  const walked = tmp('agm-walked-');
  fs.writeFileSync(path.join(walked, 'a.json'), '{}');
  fs.writeFileSync(path.join(walked, 'b.json'), '{}');
  const seen = fs.lstatSync(path.join(walked, 'b.json'), { bigint: true });
  assert.throws(() => launch.copyBytes(fs, path.join(walked, 'a.json'), path.join(walked, 'copy'), seen), { code: 'ECHANGED' });
  assert.ok(!fs.existsSync(path.join(walked, 'copy')), 'nothing written');
  assert.equal(launch.copyBytes(fs, path.join(walked, 'b.json'), path.join(walked, 'copy'), seen).size, 2, 'the file the walk saw is copied');
  // A file id is read whole: two ids that a Number reads as one (an NTFS id past 2^53) are two files.
  const big = { ino: 2n ** 53n + 1n, dev: 7n };
  const near = { ino: 2n ** 53n, dev: 7n };
  assert.equal(Number(big.ino), Number(near.ino), 'a Number cannot tell them apart');
  for (const same of [launch.sameFile, machine.sameFile]) {
    assert.deepEqual([same(big, near), same(big, { ...big }), same(big, { ...big, dev: 8n })], [false, true, false]);
  }
  // Not a portable folder at all, and the installed one itself.
  const root = ready();
  await refused({ src: tmp('agm-empty-'), keys: seeded.keys }, root, /holds no portable AGMessage's data \(app\\data\): choose the folder that holds start-agmessage\.bat\./);
  // No import made ready: nothing written anywhere.
  const bare = machineFolder();
  const r = await launch.exportPortable({ source: seeded.src, machine: bare, sys: SYS, run: win.run, profile: seeded.keys });
  assert.match(r.text, /^The import was not made ready for LAPTOP\\ana on this PC/);
  assert.ok(!fs.existsSync(machine.importDir(bare, ANA)));
});

test('the elevated import refuses a node that has served (any hall, account or audit row, or keys of its own), with its words: nothing is ever merged', () => {
  const win = windows();
  const fresh = machineFolder();
  assert.deepEqual(machine.servedOf(fresh), [], 'a node that never started has served nothing');
  const cases = [
    [(root) => { fs.mkdirSync(path.join(root, 'data', 'rooms')); fs.writeFileSync(path.join(root, 'data', 'rooms', 'ABC234.json'), '{}'); }, '1 hall or room file'],
    [(root) => fs.writeFileSync(path.join(root, 'data', 'accounts.json'), JSON.stringify({ v: 1, users: [{ id: 'u1' }, { id: 'u2' }] })), '2 accounts'],
    [(root) => fs.writeFileSync(path.join(root, 'data', 'audit.jsonl'), '{"seq":1}\n'), 'an audit log'],
    [(root) => fs.writeFileSync(path.join(root, 'keys', 'machine.key'), 'k'), 'its own machine.key'],
    [(root) => fs.writeFileSync(path.join(root, 'data', 'secret.key'), 's'), 'its own secret.key'],
  ];
  for (const [make, said] of cases) {
    const root = machineFolder();
    make(root);
    assert.deepEqual(machine.servedOf(root), [said]);
    for (const step of [['stage', '--sys', SYS], ['take', '--app', h.REPO, '--source', path.join(tmp('agm-src-'), 'AGMessage')]]) {
      const opts = { '--step': step[0], '--for': ANA, '--machine': root, [step[1]]: step[2], ...(step[3] ? { [step[3]]: step[4] } : {}) };
      assert.throws(() => machine.importStep(opts, { run: win.run }), (e) => e.refused === true && e.words === machine.servedWords([said]) && /cannot be merged: nothing is ever merged\./.test(e.words), step[0] + ': ' + said);
    }
    assert.ok(!fs.existsSync(machine.importDir(root, ANA)), 'nothing made for the import');
  }
  // An empty accounts file and an empty audit log are a node that never served.
  const empty = machineFolder();
  fs.writeFileSync(path.join(empty, 'data', 'accounts.json'), JSON.stringify({ v: 1, users: [] }));
  fs.writeFileSync(path.join(empty, 'data', 'audit.jsonl'), '');
  assert.deepEqual(machine.servedOf(empty), []);
});

test('take lays nothing it cannot vouch for: no answer, an export that refused, a manifest that is not one or names a path outside its places, a part that is a link or changed, a file already there, a copy its own start would refuse; what it laid is taken out again, and nothing of the bundle stays', async () => {
  const seeded = await portable();
  let m0;
  const win = windows();
  /** A folder made ready and exported into, from a copy of the seeded portable folder. */
  const exported = async () => {
    const p = copyOf(seeded);
    const root = machineFolder();
    machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
    const ex = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
    assert.equal(ex.code, launch.DONE, ex.text);
    return { ...p, root, dir: machine.importDir(root, ANA), id: ex.id };
  };
  const take = (x, extra = {}) => machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS], extra);
  const clean = (root) => {
    for (const area of ['data', 'uploads', 'keys']) assert.deepEqual(fs.readdirSync(path.join(root, area)), [], area + ' as it was: nothing laid, or all of it taken out again');
    assert.ok(!fs.existsSync(machine.importVerdict(root, ANA)), 'and no verdict');
    assert.ok(!fs.existsSync(machine.importDir(root, ANA)), 'and nothing of the bundle left in the account\'s inbox: no part (the keys among them), no manifest, no answer');
  };
  // No answer from an export, and an export that refused (part way: the parts it wrote are cleared too).
  let x = await exported();
  fs.rmSync(path.join(x.dir, launch.EXPORT_SAID));
  let r = await take(x);
  assert.deepEqual([r.code, r.text], [machine.REFUSED, 'The portable folder\'s export left no answer, so there is no bundle to take. Nothing was imported.']);
  clean(x.root);
  x = await exported();
  fs.rmSync(path.join(x.dir, launch.MANIFEST));
  assert.ok(fs.readdirSync(x.dir).some((n) => n.endsWith('.part')), 'an export stopped part way leaves parts its account cannot remove');
  fs.writeFileSync(path.join(x.dir, launch.EXPORT_SAID), JSON.stringify({ v: 1, id: x.id, code: 2, words: 'The portable AGMessage in X is running: press Ctrl+C in its window, then import again. Nothing was exported.' }));
  r = await take(x);
  assert.deepEqual([r.code, r.text], [machine.REFUSED, 'The portable AGMessage in X is running: press Ctrl+C in its window, then import again. Nothing was exported.']);
  clean(x.root);
  // A node that has served by the time of the take: refused, and the bundle cleared all the same.
  x = await exported();
  fs.writeFileSync(path.join(x.root, 'data', 'secret.key'), 'theirs');
  r = await take(x);
  assert.deepEqual([r.code, r.text], [machine.REFUSED, machine.servedWords(['its own secret.key'])]);
  assert.ok(!fs.existsSync(x.dir), 'the bundle cleared');
  // The copy's own format marker is read, never the export's word for it: a marker of another build laid under facts that
  // claim this one is no pass.
  x = await exported();
  m0 = JSON.parse(read(path.join(x.dir, launch.MANIFEST)));
  const fi = m0.files.findIndex((f) => f.area === 'data' && f.rel === 'format.json');
  const other = Buffer.from(JSON.stringify({ format: dataformat.FORMAT, build: '0.6.0+7.abc1234', at: Date.now() }));
  fs.rmSync(path.join(x.dir, machine.importPart(fi)));
  fs.writeFileSync(path.join(x.dir, machine.importPart(fi)), other);
  m0.files[fi] = { ...m0.files[fi], size: other.length, sha256: require('crypto').createHash('sha256').update(other).digest('hex') };
  fs.writeFileSync(path.join(x.dir, launch.MANIFEST), JSON.stringify(m0));
  r = await take(x);
  assert.equal(r.code, machine.NOT_DONE);
  assert.deepEqual(r.out.checks.map((c) => c.check), ['format']);
  assert.match(r.text, /^The import did not pass its verify: the copy was not last run by this build \(its format marker names AGMessage 0\.6\.0\+7\.abc1234; this is .+\)\. What it copied was taken out again\./);
  clean(x.root);
  // A machine key the installed node would not start on, laid under facts that claim the portable folder's: no pass.
  x = await exported();
  m0 = JSON.parse(read(path.join(x.dir, launch.MANIFEST)));
  const ki = m0.files.findIndex((f) => f.area === 'keys' && f.rel === 'machine.key');
  const notKey = Buffer.from('not a key');
  fs.rmSync(path.join(x.dir, machine.importPart(ki)));
  fs.writeFileSync(path.join(x.dir, machine.importPart(ki)), notKey);
  m0.files[ki] = { ...m0.files[ki], size: notKey.length, sha256: require('crypto').createHash('sha256').update(notKey).digest('hex') };
  fs.writeFileSync(path.join(x.dir, launch.MANIFEST), JSON.stringify(m0));
  r = await take(x);
  assert.ok(r.out.checks.map((c) => c.check).includes('usable'), JSON.stringify(r.out.checks));
  assert.match(r.text, /the installed AGMessage would not start on the machine key \(EBADKEY\)/);
  clean(x.root);
  // Another folder than the installer named.
  x = await exported();
  r = await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', path.join(path.dirname(x.src), 'Other'), '--sys', SYS]);
  assert.match(r.text, /^The bundle is of .+, not of .+Other: nothing was imported\.$/);
  clean(x.root);
  // A manifest naming a path outside its places is refused before anything is laid.
  for (const rel of ['../../escaped.txt', 'rooms/../../x', 'C:\\Windows\\x', 'backups/old.json', 'a\u0000b']) {
    x = await exported();
    const m = JSON.parse(read(path.join(x.dir, launch.MANIFEST)));
    m.files[0].rel = rel;
    fs.writeFileSync(path.join(x.dir, launch.MANIFEST), JSON.stringify(m));
    r = await take(x);
    assert.deepEqual([r.code, r.text], [machine.REFUSED, 'the bundle\'s manifest names a file an import does not carry: nothing was imported.'], JSON.stringify(rel));
    clean(x.root);
    assert.ok(!fs.existsSync(path.join(path.dirname(x.root), 'escaped.txt')));
  }
  // A part that is a link, deep in the copy: what was laid before it is taken out again.
  x = await exported();
  let m = JSON.parse(read(path.join(x.dir, launch.MANIFEST)));
  const last = m.files.length - 1;
  const outside = path.join(tmp('agm-else-'), 'secret.txt');
  fs.writeFileSync(outside, 'x'.repeat(m.files[last].size));
  fs.rmSync(path.join(x.dir, machine.importPart(last)));
  // A link in its place: on Windows a junction, which needs no privilege to make (a file's link would).
  if (process.platform === 'win32') fs.symlinkSync(path.dirname(outside), path.join(x.dir, machine.importPart(last)), 'junction');
  else fs.symlinkSync(outside, path.join(x.dir, machine.importPart(last)));
  r = await take(x);
  assert.equal(r.code, machine.NOT_DONE);
  assert.match(r.text, /^The import did not lay .+ \(\d+\.part is not a part the export wrote \(a link, or not a file\)\)\. What it copied was taken out again\. Nothing was removed from the portable folder or your profile\.$/);
  clean(x.root);
  // A part whose bytes changed after the export read them.
  x = await exported();
  m = JSON.parse(read(path.join(x.dir, launch.MANIFEST)));
  const i = m.files.findIndex((f) => f.area === 'data' && f.rel === 'settings.json');
  const part = path.join(x.dir, machine.importPart(i));
  const bytes = fs.readFileSync(part);
  bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
  fs.writeFileSync(part, bytes);
  r = await take(x);
  assert.match(r.text, /^The import did not pass its verify: data\\settings\.json did not arrive whole \(its bytes are not the ones the export read\)\. What it copied was taken out again\./);
  clean(x.root);
  // A file of that name already there: an import never lays a file over one, and takes out what it laid.
  x = await exported();
  fs.writeFileSync(path.join(x.root, 'uploads', 'abc123.png'), 'the node\'s own');
  r = await take(x);
  assert.match(r.text, /^The import did not lay uploads\\abc123\.png: there is a file of that name here already, and an import never lays a file over one\./);
  assert.deepEqual(fs.readdirSync(path.join(x.root, 'uploads')), ['abc123.png']);
  assert.equal(read(path.join(x.root, 'uploads', 'abc123.png')), 'the node\'s own', 'the file there is left as it was');
  for (const area of ['data', 'keys']) assert.deepEqual(fs.readdirSync(path.join(x.root, area)), [], area);
  assert.ok(!fs.existsSync(x.dir), 'and the bundle cleared');
});

test('clear: an import left before its end (Start with no halls, or Setup closed) leaves nothing of its bundle or its verdict, on any node, and never reaches through a link', async () => {
  const seeded = await portable();
  const win = windows();
  const p = copyOf(seeded);
  const root = machineFolder();
  machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
  assert.equal((await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys })).code, launch.DONE);
  const dir = machine.importDir(root, ANA);
  fs.writeFileSync(machine.importVerdict(root, ANA), '{"v":1}');
  const r = await machine.run(['import', '--step', 'clear', '--for', ANA, '--machine', root]);
  assert.deepEqual([r.code, r.text], [machine.DONE, 'Nothing of an import is left in ' + dir + '.']);
  assert.ok(!fs.existsSync(dir) && !fs.existsSync(machine.importVerdict(root, ANA)));
  assert.equal((await machine.run(['import', '--step', 'clear', '--for', ANA, '--machine', root])).code, machine.DONE, 'none left is cleared already');
  // An import folder that is a link or junction is removed itself, never what it names.
  const elsewhere = tmp('agm-else-');
  fs.writeFileSync(path.join(elsewhere, 'theirs.txt'), 'not the import\'s');
  fs.symlinkSync(elsewhere, dir, 'junction');
  assert.equal((await machine.run(['import', '--step', 'clear', '--for', ANA, '--machine', root])).code, machine.DONE);
  assert.ok(!fs.existsSync(dir));
  assert.equal(read(path.join(elsewhere, 'theirs.txt')), 'not the import\'s', 'what the link named untouched');
  // What cannot be removed is said, not done.
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0000000.part'), 'k');
  const stuck = { ...fs, unlinkSync: (f) => { if (String(f).endsWith('.part')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.unlinkSync(f); } };
  assert.throws(() => machine.importClear({ '--for': ANA, '--machine': root }, { fsImpl: stuck }), (e) => !e.refused && /could not all be removed \(.+0000000\.part \(EBUSY\)\): remove it yourself, since it may hold the portable folder's keys\./.test(e.words));
});

test('the verify says each check that did not pass, and takes out what was copied: the counts, the key, the sealed values, the fingerprint, the chain; a verify that cannot be read is no pass', async () => {
  const seeded = await portable();
  const win = windows();
  const p = copyOf(seeded);
  const root = machineFolder();
  machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
  const ex = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
  const manifest = JSON.parse(read(path.join(machine.importDir(root, ANA), launch.MANIFEST)));
  const s = manifest.facts;
  // The checks themselves (pure): each on its own.
  assert.deepEqual(machine.verifyChecks(s, s), [], 'the same facts pass every check');
  const off = (edit) => machine.verifyChecks(s, { ...structuredClone(s), ...edit(structuredClone(s)) }).map((c) => c.check);
  assert.deepEqual(off((t) => ({ halls: t.halls + 1 })), ['counts']);
  assert.deepEqual(off((t) => ({ messages: t.messages - 1 })), ['counts']);
  assert.deepEqual(off(() => ({ accounts: 0, screens: 0 })), ['counts']);
  assert.deepEqual(off((t) => ({ key: { ...t.key, kid: '0'.repeat(16) } })), ['key']);
  assert.deepEqual(off((t) => ({ sealed: { ...t.sealed, open: t.sealed.open - 1, shut: ['settings.json aiKeySealed'] } })), ['sealed']);
  assert.deepEqual(off((t) => ({ cert: { ...t.cert, fp: 'sha256:' + '0'.repeat(64) } })), ['fingerprint']);
  assert.deepEqual(off((t) => ({ chain: { ...t.chain, done: false, mark: 'broken', words: 'Broken at line 3' } })), ['chain']);
  assert.deepEqual(off((t) => ({ chain: { ...t.chain, entries: t.chain.entries - 1 } })), ['chain'], 'entries counted alike');
  assert.match(machine.verifyChecks(s, { ...structuredClone(s), sealed: { ...s.sealed, open: s.sealed.open - 1, shut: ['settings.json aiKeySealed'] } })[0].words, /^1 of \d+ sealed values do not open here \(settings\.json aiKeySealed\)$/);
  // What the installed node's own start refuses, read from the copy's facts alone.
  assert.deepEqual(off((t) => ({ format: { ...t.format, build: '0.6.0+7.abc1234' } })), ['format'], 'another build\'s marker laid');
  assert.deepEqual(off((t) => ({ format: { ...t.format, format: t.format.current + 1 } })), ['format'], 'a marker of this build in a format it does not write');
  assert.deepEqual(off((t) => ({ format: { ...t.format, state: 'none' } })), ['format'], 'no marker: 0.5\'s');
  assert.deepEqual(machine.verifyChecks({ ...s, build: '0.6.0+7.abc1234' }, s).map((c) => c.check), ['format'], 'an export by another build than this one');
  assert.match(machine.verifyChecks(s, { ...structuredClone(s), format: { ...s.format, build: '0.6.0+7.abc1234' } })[0].words, /^the copy was not last run by this build \(its format marker names AGMessage 0\.6\.0\+7\.abc1234; this is /);
  assert.deepEqual(off((t) => ({ key: { state: 'unusable', kid: t.key.kid, code: 'EBADKEY' } })), ['key', 'usable']);
  assert.deepEqual(off(() => ({ secret: 'unusable' })), ['usable']);
  assert.deepEqual(off((t) => ({ cert: { ...t.cert, state: 'unusable', code: 'EBADCERT' } })), ['usable'], 'a private key that is not its certificate\'s, the fingerprint the same');
  assert.match(machine.verifyChecks(s, { ...structuredClone(s), secret: 'unusable', cert: { ...s.cert, state: 'unusable', code: 'EBADCERT' } })[0].words, /^the installed AGMessage would not start on the certificate \(EBADCERT\), the server secret laid here$/);
  assert.deepEqual([off(() => ({ secret: 'absent' })), off((t) => ({ cert: { ...t.cert, state: 'renew' } }))], [[], []], 'a secret it makes, and a certificate due for renewal, are no refusal');
  assert.deepEqual(off(() => ({ held: true, busy: 'busy: 2 pages active' })), ['held']);
  assert.match(machine.verifyChecks(s, { ...structuredClone(s), held: true, busy: 'busy: 2 pages active' })[0].words, /^a copy of AGMessage runs on this PC's AGMessage data folder \(it says it is busy: 2 pages active\): stop it, then import again$/);
  assert.deepEqual(off(() => ({ moved: 'moved' })), ['moved']);
  assert.deepEqual(machine.verifyChecks(s, {}).map((c) => c.check), ['counts', 'key', 'sealed', 'fingerprint', 'chain', 'format', 'usable', 'held', 'moved'], 'nothing read is nothing passed');
  // Taken, with the copy's facts read otherwise: the words name the check, and nothing stays.
  const wrong = (runFile) => machine.run(['import', '--step', 'take', '--for', ANA, '--machine', root, '--app', h.REPO, '--source', p.src, '--sys', SYS], { runFile });
  const asked = [];
  let r = await wrong((exe, args, opts) => { asked.push({ exe, args, env: opts.env, cwd: opts.cwd }); return JSON.stringify({ v: 1, facts: { ...s, halls: s.halls + 2 } }) + '\n'; });
  assert.equal(r.code, machine.NOT_DONE);
  assert.match(r.text, /^The import did not pass its verify: the counts differ: 3 halls here, 1 in the portable folder\. What it copied was taken out again\. Nothing was removed from the portable folder or your profile\.$/);
  assert.deepEqual(r.out.checks.map((c) => c.check), ['counts']);
  assert.deepEqual([asked[0].exe, asked[0].args.slice(1)], [process.execPath, ['--data', path.join(root, 'data'), '--keys', path.join(root, 'keys')]], 'the install\'s own facts reader, on the installed node\'s folders');
  assert.equal(asked[0].args[0], path.join(h.REPO, 'app', 'lib', 'importfacts.js'));
  assert.deepEqual(asked[0].env, { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp' }, 'an environment made from the System32 folder alone, none of the elevated account\'s');
  for (const area of ['data', 'uploads', 'keys']) assert.deepEqual(fs.readdirSync(path.join(root, area)), [], area);
  // A reader that gives no facts is no pass either; nor is a manifest of another import.
  machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
  const again = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
  assert.notEqual(again.id, ex.id, 'each export is an import of its own');
  r = await wrong(() => { throw Object.assign(new Error('killed'), { code: 'ETIMEDOUT', stdout: '' }); });
  assert.match(r.text, /^The import did not pass its verify: the copy's facts could not be read \(ETIMEDOUT\)\./);
  for (const area of ['data', 'uploads', 'keys']) assert.deepEqual(fs.readdirSync(path.join(root, area)), [], area);
});

test('forget-keys runs only after a verify that passed, for this import and this folder; each removal is checked, and one that fails is named with its path and stays on the import\'s last words', async () => {
  const seeded = await portable();
  const win = windows();
  const ready = async () => {
    const p = copyOf(seeded);
    const root = machineFolder();
    machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
    const ex = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
    return { ...p, root, id: ex.id };
  };
  const untouched = (x) => {
    assert.ok(fs.existsSync(path.join(x.keys, 'machine.key')), 'the profile\'s keys stay');
    assert.ok(fs.existsSync(path.join(x.data, 'secret.key')), 'the folder\'s secret stays');
    assert.equal(dataformat.movedOf(x.data).state, 'none', 'and it is not marked');
  };
  // No verify yet: the export alone lets nothing go.
  let x = await ready();
  let r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys });
  assert.deepEqual([r.code, r.verified], [launch.NOT_DONE, false]);
  assert.match(r.text, /^No import of .+ into this PC's AGMessage was verified, so nothing was removed: the keys stay where they are\.$/);
  untouched(x);
  // A verify that did not pass leaves no verdict; a verdict of another import, or another folder, is none.
  const runFile = () => JSON.stringify({ v: 1, facts: { halls: -1 } });
  assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS], { runFile })).code, machine.NOT_DONE);
  r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys });
  assert.equal(r.verified, false);
  untouched(x);
  x = await ready();
  assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS])).code, machine.DONE);
  for (const [id, source] of [['f'.repeat(24), x.src], [x.id, path.join(path.dirname(x.src), 'Another')]]) {
    r = launch.forgetKeys({ source, machine: x.root, sys: SYS, id, run: win.run, profile: x.keys });
    assert.equal(r.verified, false, id + ' ' + source);
    untouched(x);
  }
  // A verdict the account could write is not read: only the outbox's, which only SYSTEM and Administrators write.
  const inboxVerdict = path.join(machine.importDir(x.root, ANA), 'import.json');
  fs.writeFileSync(inboxVerdict, read(machine.importVerdict(x.root, ANA)));
  fs.rmSync(machine.importVerdict(x.root, ANA));
  r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys });
  assert.equal(r.verified, false);
  untouched(x);
  // Verified, with the profile's removal failing (a stubbed fs): marked, the secret gone, the profile named with its path.
  x = await ready();
  assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS])).code, machine.DONE);
  const fsImpl = { ...fs, rmSync: (p, o) => { if (p === x.keys) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys, fsImpl });
  assert.deepEqual([r.code, r.verified, r.moved, r.keys, r.secret], [launch.NOT_DONE, true, true, { ok: false, was: true }, { ok: true, was: true }]);
  assert.ok(r.text.includes('The import is verified, but not every old copy is gone: ' + x.keys + ' (EBUSY). Remove it yourself: the keys of the halls this PC\'s AGMessage now serves are in it.'), r.text);
  assert.ok(fs.existsSync(x.keys) && !fs.existsSync(path.join(x.data, 'secret.key')) && dataformat.movedOf(x.data).state === 'moved');
  // finish: imported all the same, not done, its words the person's with the path; the event says not every copy went.
  const fin = await finish(x.root, x.id);
  assert.equal(fin.code, machine.NOT_DONE);
  assert.ok(fin.text.includes(x.keys + ' (EBUSY)'), fin.text);
  assert.deepEqual([fin.out.imported, fin.out.event], [true, 1]);
  const ev = JSON.parse(read(path.join(x.root, 'machine', 'events.jsonl')).trim());
  assert.match(ev.words, /; not every old copy of its keys was removed and the folder is marked as moved\.$/);
  assert.ok(!ev.words.includes(x.keys), 'the path in a profile is the person\'s words alone, never the event\'s');
  // The mark not made: said apart from the copies (the folder could still start), and not done, here and at finish.
  x = await ready();
  assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS])).code, machine.DONE);
  const unmarked = { ...fs, renameSync: (a, b) => { if (path.basename(b) === 'moved.json') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.renameSync(a, b); } };
  r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys, fsImpl: unmarked });
  assert.deepEqual([r.code, r.moved, r.keys.ok, r.secret.ok], [launch.NOT_DONE, false, true, true]);
  assert.ok(r.text.startsWith('The import is verified, so the old copies are gone: '), r.text);
  assert.ok(r.text.includes(' The folder is not marked as moved (' + path.join(x.data, 'moved.json') + ': EACCES), so it could still start, beside the installed AGMessage and with its halls: never start it again, and delete it once you no longer need it.'), r.text);
  assert.ok(!/Remove (?:it|them) yourself/.test(r.text), 'a mark never written is never one to remove');
  const noMark = await finish(x.root, x.id);
  assert.equal(noMark.code, machine.NOT_DONE, 'a folder not marked is no finished import');
  assert.match(JSON.parse(read(path.join(x.root, 'machine', 'events.jsonl')).trim()).words, /; its old copies of the keys were removed, and the folder is not marked as moved\.$/);
  // The folder a link or junction by the time of forget-keys: nothing removed, nothing marked through it.
  x = await ready();
  assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS])).code, machine.DONE);
  fs.renameSync(x.src, x.src + '.real');
  fs.symlinkSync(x.src + '.real', x.src, 'junction');
  r = launch.forgetKeys({ source: x.src, machine: x.root, sys: SYS, id: x.id, run: win.run, profile: x.keys });
  assert.equal(r.code, launch.NOT_DONE);
  assert.match(r.text, /AGMessage is a link or a junction now, so nothing was removed: the keys stay where they are\./);
  assert.ok(fs.existsSync(path.join(x.keys, 'machine.key')) && fs.existsSync(path.join(x.src + '.real', 'app', 'data', 'secret.key')) && dataformat.movedOf(path.join(x.src + '.real', 'app', 'data')).state === 'none');
  // A finish with no answer from forget-keys says so, and asks the person to remove the copies.
  x = await ready();
  await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', x.root, '--app', h.REPO, '--source', x.src, '--sys', SYS]);
  const quiet = await finish(x.root, x.id);
  assert.equal(quiet.code, machine.NOT_DONE);
  assert.match(quiet.text, /Its old copies of the keys were not confirmed removed, nor the folder marked as moved \(forget-keys gave no answer\): remove %LOCALAPPDATA%\\AGMessage and the folder's app\\data\\secret\.key yourself, and never start that folder again/);
  assert.match(JSON.parse(read(path.join(x.root, 'machine', 'events.jsonl')).trim()).words, /; its old copies of the keys were not confirmed removed, nor the folder marked as moved\.$/);
  assert.ok(!fs.existsSync(machine.importDir(x.root, ANA)) && !fs.existsSync(machine.importVerdict(x.root, ANA)), 'finish clears the import, done or not');
  // finish is the verdict's: none (or another id) records nothing.
  const none = await finish(x.root, x.id);
  assert.deepEqual([none.code, none.text], [machine.REFUSED, 'No verified import of this id is here to finish: nothing was recorded.']);
});

test('the import\'s machine event names the account as the machine does (the install record\'s admin, else Windows\' own name for its SID), never as its bundle says', async () => {
  const seeded = await portable();
  const win = windows();
  const run = async () => {
    const p = copyOf(seeded);
    const root = machineFolder();
    machine.importStage({ '--for': ANA, '--machine': root, '--sys': SYS }, { run: win.run });
    const ex = await launch.exportPortable({ source: p.src, machine: root, sys: SYS, run: win.run, profile: p.keys });
    // The account wrote its manifest: a name it gives there is its own word, never the machine's.
    const file = path.join(machine.importDir(root, ANA), launch.MANIFEST);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), name: 'LAPTOP\\mallory' }));
    assert.equal((await machine.run(['import', '--step', 'take', '--for', ANA, '--machine', root, '--app', h.REPO, '--source', p.src, '--sys', SYS])).code, machine.DONE);
    assert.ok(!('name' in JSON.parse(read(machine.importVerdict(root, ANA)))), 'the verdict names no account');
    assert.equal(launch.forgetKeys({ source: p.src, machine: root, sys: SYS, id: ex.id, run: win.run, profile: p.keys }).code, launch.DONE);
    return { root, id: ex.id };
  };
  const event = (root) => JSON.parse(read(path.join(root, 'machine', 'events.jsonl')).trim());
  // The laptop's admin: the install record's name.
  let x = await run();
  assert.equal((await finish(x.root, x.id)).code, machine.DONE);
  let ev = event(x.root);
  assert.deepEqual([ev.by, ev.for], [{ sid: ANA, name: 'LAPTOP\\ana' }, { sid: ANA, name: 'LAPTOP\\ana' }]);
  assert.match(ev.words, /^LAPTOP\\ana imported a portable AGMessage folder/);
  assert.ok(!JSON.stringify(ev).includes('mallory'));
  // Not the record's admin: Windows' own name for the SID; none at all: the SID.
  x = await run();
  assert.equal((await finish(x.root, x.id, { run: windows({ record: { ...ANA_RECORD, Admin: 'S-1-5-21-1-2-3-1009' }, names: { [ANA]: 'LAPTOP\\ana.b' } }).run })).code, machine.DONE);
  assert.match(event(x.root).words, /^LAPTOP\\ana\.b imported/);
  x = await run();
  assert.equal((await finish(x.root, x.id, { run: windows().run })).code, machine.DONE);
  ev = event(x.root);
  assert.deepEqual(ev.by, { sid: ANA, name: '' });
  assert.ok(ev.words.startsWith(ANA + ' imported'), ev.words);
  // finish reads the record: --sys is one of its arguments.
  assert.throws(() => machine.importFinish({ '--for': ANA, '--machine': x.root, '--id': x.id }, {}), (e) => e.usage && /--sys/.test(e.words));
});

test('what an export carries, and the paths a bundle may name: launch.js and machine.js hold one rule each side of the elevation', () => {
  const rels = ['settings.json', 'rooms/ABC234.json', 'rooms/ABC234.LEGAL1.log', 'audit-archive/audit-0a1b2c3d-1-9/log/audit.jsonl', 'stage/ABC234.json', 'logs/server.log', 'backups/format-1-x/settings.json',
    'watchdog.json', 'watchdog.log', 'watchdog.seen.json', 'moved.json', 'settings.json.tmp', 'rooms/.partial-1/x.json', 'machine.key', 'tls.json', 'audit/head-abc.json', 'audit', 'stores/latest.json', 'secret.key', 'abc123.png'];
  for (const area of ['data', 'uploads', 'keys', 'other']) for (const rel of rels) assert.equal(machine.importCarries(area, rel), launch.carried(area, rel), area + '/' + rel);
  assert.deepEqual(rels.filter((r) => launch.carried('data', r)), ['settings.json', 'rooms/ABC234.json', 'rooms/ABC234.LEGAL1.log', 'audit-archive/audit-0a1b2c3d-1-9/log/audit.jsonl', 'stage/ABC234.json', 'machine.key', 'tls.json', 'audit/head-abc.json', 'audit', 'stores/latest.json', 'secret.key', 'abc123.png']);
  assert.deepEqual(rels.filter((r) => launch.carried('keys', r)), ['machine.key', 'tls.json', 'audit/head-abc.json'], 'of the profile\'s key folder: the machine key, the certificate and the audit records (answer 42)');
  assert.equal(launch.carried('other', 'settings.json'), false, 'an unknown place carries nothing');
  const names = ['settings.json', 'a/b/c.json', 'Hall 2 notes.txt', '..', '.', 'a/../b', 'a//b', '', '/abs', 'C:\\x', 'c:x', 'a\\b', 'x'.repeat(201), 'a/' + 'b'.repeat(239), 'nul\u0000', 'bell\u0007', 'pipe|x', 'q?', 'star*'];
  for (const n of names) assert.equal(machine.importRelOk(n), launch.relOk(n), JSON.stringify(n));
  assert.deepEqual(names.filter((n) => launch.relOk(n)), ['settings.json', 'a/b/c.json', 'Hall 2 notes.txt']);
  assert.equal(machine.IMPORT_REL_MAX, launch.REL_MAX);
  assert.equal(machine.IMPORT_FILES_MAX, launch.BUNDLE_FILES_MAX);
  assert.deepEqual([machine.importPart(0), machine.importPart(41)], [launch.partOf(0), launch.partOf(41)]);
  assert.deepEqual([machine.importDir('/m', ANA), machine.importVerdict('/m', ANA)], [launch.importDirOf('/m', ANA), launch.verdictOf('/m', ANA)].map((p) => p.split(path.sep).join('/')));
});

test('a manifest is read by type: whole JSON of an import\'s shape, its files in their three places, none twice, each with its size and SHA-256', () => {
  const sha = 'a'.repeat(64);
  const good = { v: 1, id: 'b'.repeat(24), sid: ANA, name: 'LAPTOP\\ana', source: path.join(os.tmpdir(), 'AGMessage'), build: '0.6.0+41.abc1234', facts: { halls: 1 }, files: [{ area: 'data', rel: 'settings.json', size: 2, sha256: sha }, { area: 'keys', rel: 'machine.key', size: 44, sha256: sha }] };
  const m = machine.manifestOf(Buffer.from(JSON.stringify(good)));
  assert.deepEqual([m.problem, m.manifest.id, m.manifest.files.length, 'name' in m.manifest], [undefined, good.id, 2, false], 'a name the bundle gives is never read: the machine names the account');
  const bad = (edit, why) => assert.match(machine.manifestOf(JSON.stringify(edit({ ...structuredClone(good) }))).problem, why);
  assert.match(machine.manifestOf('{"v":1').problem, /not whole JSON/);
  bad((j) => ({ ...j, v: 2 }), /not one an export of this build writes/);
  bad((j) => ({ ...j, id: 'short' }), /does not name its import/);
  bad((j) => ({ ...j, sid: 'S-1-1-0x' }), /does not name its import, its account/);
  bad((j) => ({ ...j, source: 'relative\\folder' }), /its folder/);
  bad((j) => ({ ...j, facts: null }), /holds no facts/);
  bad((j) => ({ ...j, files: 'all' }), /no list of files/);
  bad((j) => ({ ...j, files: [{ ...j.files[0], area: 'machine' }] }), /names a file an import does not carry/);
  bad((j) => ({ ...j, files: [{ ...j.files[0], rel: '../settings.json' }] }), /does not carry/);
  bad((j) => ({ ...j, files: [{ ...j.files[0], area: 'keys', rel: 'stores/latest.json' }] }), /does not carry/);
  bad((j) => ({ ...j, files: [{ ...j.files[0], size: -1 }] }), /does not carry/);
  bad((j) => ({ ...j, files: [{ ...j.files[0], sha256: 'zz' }] }), /does not carry/);
  bad((j) => ({ ...j, files: [j.files[0], { ...j.files[0], rel: 'SETTINGS.json' }] }), /names one file twice \(data\/SETTINGS\.json\)/);
});

test('the start file an import leaves names the installed AGMessage and starts nothing; the import\'s mark is read before anything is written, a mark that cannot be read refused too', () => {
  const bat = launch.movedBat({ build: '0.6.0+41.abc1234 & del *', at: Date.UTC(2026, 10, 7, 20, 31) });
  assert.match(bat, /^@echo off\r\n/);
  assert.ok(bat.includes('(build 0.6.0+41.abc1234del) on 2026-11-07'), 'a build of a build\'s characters alone');
  assert.ok(bat.includes('Start ^> AGMessage ^> Open AGMessage'), 'cmd\'s > escaped');
  assert.ok(!/[%&|<]|[^^]>|node\.exe|supervise/.test(bat), 'nothing cmd would run or expand, and no start of AGMessage');
  assert.match(bat, /\r\nexit \/b 3\r\n$/, 'the .bat\'s own "did not start" code');
  const dir = tmp('agm-moved-');
  assert.deepEqual(dataformat.movedOf(dir).state, 'none');
  assert.equal(dataformat.movedRefusal(dataformat.movedOf(dir), { dataDir: dir }), '');
  fs.writeFileSync(path.join(dir, 'moved.json'), JSON.stringify({ v: 1, at: Date.UTC(2026, 10, 7), build: '0.6.0+41.abc1234' }));
  const m = dataformat.movedOf(dir);
  assert.deepEqual([m.state, m.at, m.build], ['moved', Date.UTC(2026, 10, 7), '0.6.0+41.abc1234']);
  assert.equal(dataformat.movedRefusal(m, { dataDir: dir }), 'this folder\'s AGMessage (' + dir + ') was moved into the AGMessage installed on this PC on 2026-11-07 (build 0.6.0+41.abc1234): its halls, accounts and keys are there now, and its keys were removed from this Windows account, so this copy does not start. Open the installed AGMessage from Start > AGMessage > Open AGMessage.');
  fs.writeFileSync(path.join(dir, 'moved.json'), '{"v":1,"at"');
  assert.deepEqual([dataformat.movedOf(dir).state, dataformat.movedOf(dir).at], ['moved', null], 'a torn mark is still the import\'s mark');
  fs.rmSync(path.join(dir, 'moved.json'));
  fs.mkdirSync(path.join(dir, 'moved.json'));
  const unread = dataformat.movedOf(dir);
  assert.equal(unread.state, 'unread');
  assert.match(dataformat.movedRefusal(unread, { dataDir: dir }), /^this folder's import mark .+moved\.json could not be read \(E[A-Z]+\), so whether its AGMessage was moved into the one installed on this PC cannot be told\. Nothing was changed\./);
});

test('the profile\'s key folder is where a portable copy keeps it; the import\'s command lines are read by type, each step\'s own', () => {
  assert.equal(launch.profileKeys({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, home: 'C:\\Users\\ana' }), 'C:\\Users\\ana\\AppData\\Local\\AGMessage');
  assert.equal(launch.profileKeys({ platform: 'win32', env: { LOCALAPPDATA: 'relative' }, home: '/h' }), path.join('/h', '.agmessage'), 'a LOCALAPPDATA that is no drive path is not taken');
  assert.equal(launch.profileKeys({ platform: 'linux', env: {}, home: '/home/ana' }), path.join('/home/ana', '.agmessage'));
  const src = path.join(os.tmpdir(), 'AGMessage');
  const m = path.join(os.tmpdir(), 'ProgramData', 'AGMessage');
  assert.deepEqual(launch.parse(['export', '--source', src, '--machine', m, '--sys', SYS, '--port', '3023']), { verb: 'export', source: src, machine: m, sys: SYS, port: 3023 });
  assert.deepEqual(launch.parse(['forget-keys', '--source', src, '--machine', m, '--sys', SYS, '--id', 'c'.repeat(24)]), { verb: 'forget-keys', source: src, machine: m, sys: SYS, id: 'c'.repeat(24) });
  assert.match(launch.parse(['export', '--source', 'rel', '--machine', m, '--sys', SYS]).problem, /needs --source <folder>, a full path \(the portable AGMessage folder/);
  assert.match(launch.parse(['export', '--source', src, '--machine', m, '--sys', 'System32']).problem, /System32 folder named from its drive/);
  assert.match(launch.parse(['export', '--source', src, '--machine', m, '--sys', SYS, '--id', 'x']).problem, /"--id" is not an argument launch\.js export knows/);
  assert.match(launch.parse(['forget-keys', '--source', src, '--machine', m, '--sys', SYS, '--id', 'nothex']).problem, /needs --id <the import's id>/);
  assert.match(launch.parse(['forget-keys', '--source', src, '--machine', m, '--sys', SYS, '--port', '1']).problem, /"--port" is not an argument launch\.js forget-keys knows/);
  assert.match(launch.parse(['export', '--source', src, '--machine', m, '--sys', SYS, '--port', '70000']).problem, /a port from 1 to 65535/);
  assert.equal(launch.parse(['reboot']).problem.includes('export or forget-keys'), true, 'an unknown verb\'s words name the import\'s two');
  // machine.js import: its options, and a step it does not know refused (64).
  assert.deepEqual(machine.parse(['import', '--step', 'take', '--for', ANA, '--machine', m, '--app', src, '--source', src]).opts['--step'], 'take');
  assert.equal(machine.parse(['import', '--port', '1']).problem, '"--port" is not an argument machine.js import knows.');
  assert.throws(() => machine.importStep({ '--step': 'merge', '--for': ANA, '--machine': m }, {}), (e) => e.usage && /--step stage, take or finish/.test(e.words));
  assert.throws(() => machine.importStep({ '--step': 'stage', '--for': 'S-1-5-32-544', '--machine': m, '--sys': SYS }, {}), (e) => e.usage && /one person's account/.test(e.words), 'a group is no account to import for');
  assert.throws(() => machine.importStep({ '--step': 'finish', '--for': ANA, '--machine': m, '--id': 'x' }, {}), (e) => e.usage && /--id <the import's id>/.test(e.words));
  assert.throws(() => machine.importStep({ '--step': 'take', '--for': ANA, '--machine': m, '--app': tmp('agm-app-'), '--source': src }, {}), (e) => e.usage && /holds no app\\lib\\importfacts\.js/.test(e.words));
});

test('the facts reader writes nothing: the rooms loaded without compaction, the chain walked as it lies, the key read and never made; its command line read by type', async () => {
  const p = await portable();
  const keysBefore = tree(p.keys);
  const dataBefore = tree(p.data);
  const f = await importfacts.factsOf({ dataDir: p.data, keyDir: p.keys });
  assert.deepEqual([f.halls, f.rooms, f.accounts, f.screens, f.moved, f.held, f.busy, f.secret, f.key.state, f.cert.state], [1, 0, 1, 1, 'none', false, '', 'read', 'key', 'ok']);
  assert.deepEqual([f.format.state, f.format.build, f.format.format, f.format.current], ['read', BUILD.full, dataformat.FORMAT, dataformat.FORMAT], 'the marker as it lies, and the format this build writes');
  assert.deepEqual([f.chain.done, f.chain.mark, f.chain.kid, f.chain.newestKid], [true, 'intact', f.key.kid, f.key.kid], 'the chain keyed under the profile\'s key, intact');
  assert.match(f.cert.fp, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([f.sealed.open, f.sealed.shut], [f.sealed.total, []]);
  const where = importfacts.sealedIn(p.data).map(([w]) => w);
  assert.ok(where.includes('settings.json aiKeySealed') && where.includes('displays.json tokenSealed'), 'each sealed value named by its store and field: ' + where.join(', '));
  assert.equal(f.sealed.total, where.length + 1, 'and the certificate\'s private key beside them');
  assert.deepEqual(tree(p.data), dataBefore, 'no file of the data folder written or touched');
  assert.deepEqual(tree(p.keys), keysBefore, 'nor of the key folder');
  // Words a person typed that look sealed are never taken for a sealed value: only a store's …Sealed fields are.
  const settings = JSON.parse(read(path.join(p.data, 'settings.json')));
  fs.writeFileSync(path.join(p.data, 'settings.json'), JSON.stringify({ ...settings, eventName: 'enc1:not a sealed value' }));
  assert.equal((await importfacts.factsOf({ dataDir: p.data, keyDir: p.keys })).sealed.total, f.sealed.total);
  // A key folder with no key: nothing made in it.
  const empty = tmp('agm-nokey-');
  const g = await importfacts.factsOf({ dataDir: p.data, keyDir: empty });
  assert.deepEqual([g.key.state, g.sealed.open, g.chain.kid, fs.readdirSync(empty)], ['absent', 0, '', []]);
  const lines = [];
  assert.equal(await importfacts.main(['--data', p.data], (l) => lines.push(l)), 64);
  assert.equal(await importfacts.main(['--data', 'rel', '--keys', empty], (l) => lines.push(l)), 64);
  assert.equal(await importfacts.main(['--data', p.data, '--data', p.data], (l) => lines.push(l)), 64);
  assert.equal(await importfacts.main(['--x', p.data], (l) => lines.push(l)), 64);
  assert.deepEqual(lines.map((l) => JSON.parse(l).error), ['lib/importfacts.js needs --data <folder> and --keys <folder>.', '--data needs its folder, as a full path.', '--data is given twice.', '"--x" is not an argument lib/importfacts.js knows.']);
  const out = [];
  assert.equal(await importfacts.main(['--data', p.data, '--keys', p.keys], (l) => out.push(l)), 0);
  assert.equal(JSON.parse(out[0]).facts.halls, 1);
  // As the import runs it: a process of its own, one line of JSON.
  const viaChild = launch.factsAt({ data: p.data, keys: p.keys });
  assert.deepEqual([viaChild.facts.halls, viaChild.facts.cert.fp], [1, f.cert.fp]);
  assert.match(launch.factsAt({ data: p.data, keys: p.keys, runFile: () => 'nothing here' }).error, /not whole/);
  assert.equal(launch.factsAt({ data: p.data, keys: p.keys, runFile: () => JSON.stringify({ v: 1, error: 'the folder could not be read (EACCES)' }) }).error, 'the folder could not be read (EACCES)');
});
