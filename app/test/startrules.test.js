'use strict';
// A start's rules: the channel (AGM_RUNS) and, for the installed node, its folders are checked before anything is
// written; nothing is written, in the data folder or the key folder, before the data folder and the port are held; a
// folder that cannot be used stops the start with its words (code 3), never a crash loop; the installed node never runs
// without its keys, and its port or folder held is code 75, which its watchdog tries again; the machine key, the server
// secret, the certificate and the context token are made only where there is none, never over one that could not be
// read or does not open; and an error on the port once it listens never ends a serving copy unsaved.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers');
const tlsmod = require('../lib/tls');

const ROOT = h.ROOT;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await h.wait(50); } return false; };

/** The folders a copy is given, under `base`: none of them made. The token folder is the installed node's watchdog's alone. */
const folders = (base) => ({ AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys'), AGM_TOKEN_DIR: path.join(base, 'token') });
/** Every folder and file under `dir`, with each file's bytes: what a copy may not change. */
function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const at = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out[at + '/'] = ''; walk(path.join(d, e.name), at); } else out[at] = fs.readFileSync(path.join(d, e.name)).toString('base64');
    }
  };
  walk(dir, '');
  return out;
}
/**
 * `server.js` or `supervise.js` run to its end on its own folders (never the tree's): {code, out}. The installed node's
 * watchdog is given no ADMIN_TOKEN, which it refuses: it makes its own.
 */
function run(file, env, { cwd = os.tmpdir(), ms = 20000 } = {}) {
  return new Promise((resolve) => {
    const all = { ...process.env, PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05', ...env };
    if (file === 'supervise.js' && all.AGM_RUNS === 'task') delete all.ADMIN_TOKEN;
    const c = spawn(process.execPath, [path.join(ROOT, file)], { cwd, env: all, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), ms);   // a copy that ran when it should have stopped is a failure, not a hang
    c.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}
/** The name the server holds a data folder by (0.5.1's: its path as given), and a holder of it, as another copy is. */
const holdName = (dir) => {
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + id : path.join(os.tmpdir(), 'agmessage-' + id + '.sock');
};
const hold = (where) => new Promise((resolve) => { const s = net.createServer((c) => c.end()); s.listen(where, () => resolve(s)); });
/** A machine key a test writes into a key folder (base64 of 32 bytes), returned; and a value sealed by no key this run has. */
const machineKey = (keyDir) => { const k = crypto.randomBytes(32); fs.mkdirSync(keyDir, { recursive: true }); fs.writeFileSync(path.join(keyDir, 'machine.key'), k.toString('base64')); return k; };
const sealedElsewhere = () => 'enc1:' + crypto.randomBytes(44).toString('base64');
/** A value sealed with `key` as lib/secretbox.js seals one: "enc1:" and the base64 of the IV, the tag and the AES-256-GCM text. */
function sealWith(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
/**
 * The environment that makes the files named (base names) unreadable to the server, as a file another program holds or
 * this account may not read (test/busy-preload.js), with `code` (EBUSY unless told); `unwritable` cannot be replaced.
 */
function busy(unreadable, { code = 'EBUSY', unwritable = [] } = {}) {
  const preload = '--require "' + path.join(__dirname, 'busy-preload.js').split(path.sep).join('/') + '"';   // forward slashes: no escapes inside the quotes
  return { NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_UNREADABLE: unreadable.join('|'), AGM_TEST_UNREADABLE_CODE: code, AGM_TEST_UNWRITABLE: unwritable.join('|') };
}
/** The bytes of each file named, or null where there is none. */
const bytesOf = (files) => files.map((f) => { try { return fs.readFileSync(f); } catch { return null; } });
/** A tls.json whose certificate is whole and whose private key was sealed by another machine's key. */
function certSealedElsewhere(keyDir) {
  const { certDer } = tlsmod.makeCertificate({ name: 'AGMessage elsewhere', hosts: ['localhost'], ips: ['127.0.0.1'] });
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'tls.json'), JSON.stringify({ v: 1, certDer: certDer.toString('base64'), keySealed: sealedElsewhere(), created: new Date().toISOString() }));
}
/** A tls.json as AGMessage writes one, its private key sealed with `key`, with `days` to run; its fingerprint returned. */
function certSealedWith(keyDir, key, days = 825) {
  const { certDer, keyPem } = tlsmod.makeCertificate({ name: 'AGMessage here', hosts: ['localhost'], ips: ['127.0.0.1'], days });
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'tls.json'), JSON.stringify({ v: 1, certDer: certDer.toString('base64'), keySealed: sealWith(key, keyPem), created: new Date().toISOString() }));
  return tlsmod.fingerprint(certDer);
}

// ---------------------------------------------------------------- nothing before the hold
test('a copy refused at its data folder has written nothing, there or in its key folder: no folder, key, certificate, secret or settings', async (t) => {
  const base = tmp('agm-hold-');
  const f = folders(base);
  fs.mkdirSync(f.AGM_DATA_DIR);   // as its watchdog makes it
  // A key 0.2 kept in clear and no node id: a copy that ran would seal the one and save the other.
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), JSON.stringify({ aiKey: 'kept in clear by 0.2' }));
  const before = tree(base);
  const other = await hold(holdName(f.AGM_DATA_DIR));
  t.after(() => other.close());
  for (const [env, code] of [[{}, 3], [{ AGM_RUNS: 'task' }, 75]]) {
    const r = await run('server.js', { ...f, AGM_TLS: '1', ...env });
    assert.equal(r.code, code, 'refused: ' + (code === 3 ? 'the portable folder stops' : 'the installed node is tried again') + ':\n' + r.out);
    assert.match(r.out, /AGMessage is already running on this data folder/);
    assert.ok(!/AGMessage \S+ is running/.test(r.out), 'it never served:\n' + r.out);
    assert.deepEqual(tree(base), before, 'nothing written: no rooms or uploads folder, no secret.key, no settings saved, no key folder, machine key or certificate');
  }
  // A data folder not there at all (a server started without its watchdog) is not made either.
  const bare = tmp('agm-hold-');
  const g = folders(bare);
  const another = await hold(holdName(g.AGM_DATA_DIR));
  t.after(() => another.close());
  const r = await run('server.js', { ...g, AGM_TLS: '1' });
  assert.equal(r.code, 3, r.out);
  assert.deepEqual(fs.readdirSync(bare), [], 'no folder made');
  assert.ok(!/is taken by its path as given/.test(r.out), 'a folder not made yet is held by its path, without a word:\n' + r.out);
});

test('a first start makes its folders, machine key, certificate, secret and settings once it holds its folder and port, and a key 0.2 kept in clear is sealed', async (t) => {
  const base = tmp('agm-first-');
  const f = folders(base);
  fs.mkdirSync(f.AGM_DATA_DIR);
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), JSON.stringify({ aiKey: 'kept in clear by 0.2' }));
  const srv = await h.startServer({ ...f, AGM_TLS: '1' });
  t.after(() => h.stopServer(srv.child));
  for (const made of ['data/rooms/', 'data/secret.key', 'uploads/', 'keys/machine.key', 'keys/tls.json']) assert.ok(made in tree(base), made + ' made');
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const admin = await h.connect(srv.base, login.cookie);
  t.after(() => admin.close());
  const s = await h.emit(admin, 'admin:settings');
  assert.deepEqual([s.aiKeySet, s.tls.on, /^[0-9a-f]{8}$/.test(s.nodeId)], [true, true, true], 'the key sealed with the key made now; HTTPS on with the certificate made now');
  assert.equal(s.tls.fingerprint, tlsmod.fingerprint(Buffer.from(JSON.parse(fs.readFileSync(path.join(f.AGM_KEY_DIR, 'tls.json'), 'utf8')).certDer, 'base64')));
  assert.ok(await until(() => /"nodeId"/.test(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), 'utf8'))), 'the settings saved');
  const saved = JSON.parse(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual([saved.nodeId, 'aiKey' in saved, /^enc1:/.test(saved.aiKeySealed)], [s.nodeId, false, true]);
});

// ---------------------------------------------------------------- a folder that cannot be used
test('a data, uploads or key folder that cannot be made stops the start with code 3 and the folder named, and its watchdog never starts it again', async () => {
  const base = tmp('agm-folders-');
  const file = path.join(base, 'a-file');
  fs.writeFileSync(file, '');   // a folder below a file can never be made, whoever runs it
  const cases = [
    ['task', 'AGM_DATA_DIR', 'data'], ['task', 'AGM_UPLOAD_DIR', 'uploads'], ['task', 'AGM_KEY_DIR', 'keys'],
    ['portable', 'AGM_DATA_DIR', 'data'], ['portable', 'AGM_UPLOAD_DIR', 'uploads'],
  ];
  // One at a time: every copy here is a whole server's start, and the suite's timing tests run beside this file.
  const results = [];
  for (const [i, [channel, name, what]] of cases.entries()) {
    results.push(await run('supervise.js', { ...folders(path.join(base, 'ok-' + i)), AGM_RUNS: channel, AGM_TLS: '1', [name]: path.join(file, what) }));
  }
  results.forEach((r, i) => {
    const [channel, name, what] = cases[i];
    const why = channel + ' ' + name + ':\n' + r.out;
    assert.equal(r.code, 3, why);
    assert.ok(r.out.includes('AGMessage cannot start: ') && r.out.includes(path.join(file, what)), 'its words name the folder: ' + why);
    assert.match(r.out, /\(ENOTDIR\)/, why);
    assert.ok(!/restarting|AGMessage \S+ is running/.test(r.out), 'started at most once, and never served: ' + why);
    const log = path.join(base, 'ok-' + i, 'data', 'watchdog.log');
    // The watchdog's line carries the server's own words, which name the folder.
    const own = (/^ {2}AGMessage cannot start: (.+)$/m.exec(r.out) || [])[1] || '';
    if (name !== 'AGM_DATA_DIR') assert.ok(own.includes(path.join(file, what)) && fs.readFileSync(log, 'utf8').endsWith('server stopped: cannot start as configured (code 3): ' + own + '\n'), why + '\n' + fs.readFileSync(log, 'utf8'));
  });
  // A portable copy whose key folder cannot be made runs keyless, as one whose key cannot be read does (test/audit.test.js).
});

test('a rooms folder that is there but cannot be read stops the start with code 3 and its words, in either channel, never a crash loop', async () => {
  const base = tmp('agm-rooms-');
  for (const [i, channel] of ['portable', 'task'].entries()) {
    const where = path.join(base, String(i));
    const f = folders(where);
    fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'rooms'), '');   // a file where the rooms folder is: it cannot be listed
    const before = tree(where);
    const r = await run('supervise.js', { ...f, AGM_RUNS: channel, AGM_TLS: '1' });
    const why = channel + ':\n' + r.out;
    assert.equal(r.code, 3, why);
    assert.ok(r.out.includes('AGMessage cannot start: the rooms folder ' + path.join(f.AGM_DATA_DIR, 'rooms') + ' cannot be read (ENOTDIR).'), why);
    assert.ok(!/restarting|giving up|\[error\]|AGMessage \S+ is running/.test(r.out), 'started once, no crash, never served: ' + why);
    const after = tree(where);
    // The watchdog's line, in watchdog.log and the console it keeps (logs/server.log), carries the server's words.
    const line = 'server stopped: cannot start as configured (code 3): the rooms folder ' + path.join(f.AGM_DATA_DIR, 'rooms') + ' cannot be read (ENOTDIR). Choose a data folder this Windows account can read and write (AGM_DATA_DIR), or fix that one\'s permissions.';
    assert.match(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.log'), 'utf8'), /^\S+ server stopped: /, why);
    assert.equal(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.log'), 'utf8').replace(/^\S+ /, ''), line + '\n', why);
    assert.ok(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'logs', 'server.log'), 'utf8').endsWith('  [watchdog] ' + line + '\n'), why);
    // The installed node, which has no window, records the refusal for its next start (the watchdog's own file); a
    // portable copy's refusal is read in its window, and leaves none.
    const record = (() => { try { return JSON.parse(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.json'), 'utf8')); } catch { return null; } })();
    if (channel === 'task') assert.deepEqual([record && record.reason, record && record.refused], [line.replace(/^server stopped: /, ''), true], why);
    else assert.equal(record, null, why);
    for (const watchdogs of ['data/watchdog.log', 'data/watchdog.json', 'data/logs/', 'data/logs/server.log']) delete after[watchdogs];
    assert.deepEqual(after, before, 'the server wrote nothing: ' + why);
  }
});

test('an unknown channel, and the installed node\'s folders unset, relative or inside the program\'s folder, are refused by the watchdog and the server before anything is written', async () => {
  const base = tmp('agm-runs-');
  const inside = path.join(ROOT, 'u1-inside-uploads');
  const cases = [
    [{ AGM_RUNS: 'service' }, 'AGM_RUNS is "service", which names no way AGMessage runs.'],
    [{ AGM_RUNS: 'session' }, 'AGM_RUNS is "session", which names no way AGMessage runs.'],
    [{ AGM_RUNS: 'Portable' }, 'AGM_RUNS is "Portable", which names no way AGMessage runs.'],
    [{ AGM_RUNS: 'task', AGM_DATA_DIR: 'data' }, 'AGM_DATA_DIR is "data", which is not a full path.'],
    [{ AGM_RUNS: 'task', AGM_UPLOAD_DIR: inside }, 'AGM_UPLOAD_DIR is ' + inside + ', inside the program\'s folder ' + path.dirname(ROOT) + '.'],
    [{ AGM_RUNS: 'task', AGM_KEY_DIR: '' }, 'the installed node needs its key folder in AGM_KEY_DIR, and it is not set.'],
  ];
  let i = 0;
  for (const file of ['supervise.js', 'server.js']) {
    for (const [env, words] of cases) {
      const where = path.join(base, String(i++));
      fs.mkdirSync(where);
      const r = await run(file, { ...folders(where), ...env }, { cwd: where });
      assert.equal(r.code, 3, file + ' ' + JSON.stringify(env) + ':\n' + r.out);
      assert.ok(r.out.includes('AGMessage cannot start: ' + words), file + ':\n' + r.out);
      assert.deepEqual(fs.readdirSync(where), [], file + ' ' + JSON.stringify(env) + ': nothing made, a relative folder included');
    }
  }
  assert.ok(!fs.existsSync(inside), 'nothing made inside the program\'s folder');
});

// ---------------------------------------------------------------- the installed node's keys
test('the installed node never runs without its keys: one that cannot be read, a machine key missing beside values sealed with one, or a sealed value that does not open is code 3, and nothing is made over them', async () => {
  const base = tmp('agm-keys-');
  const settings = (dir, s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s)); };
  const cases = [
    ['machine.key unreadable', (f) => fs.mkdirSync(path.join(f.AGM_KEY_DIR, 'machine.key'), { recursive: true }), (f) => 'the machine key at ' + path.join(f.AGM_KEY_DIR, 'machine.key') + ' could not be read (EISDIR)'],
    ['secret.key unreadable', (f) => { machineKey(f.AGM_KEY_DIR); fs.mkdirSync(path.join(f.AGM_DATA_DIR, 'secret.key'), { recursive: true }); }, (f) => path.join(f.AGM_DATA_DIR, 'secret.key') + ' could not be read (EISDIR)'],
    ['tls.json unreadable', (f) => { machineKey(f.AGM_KEY_DIR); fs.mkdirSync(path.join(f.AGM_KEY_DIR, 'tls.json')); }, (f) => path.join(f.AGM_KEY_DIR, 'tls.json') + ' could not be read (EISDIR)'],
    ['tls.json of another key', (f) => { machineKey(f.AGM_KEY_DIR); certSealedElsewhere(f.AGM_KEY_DIR); }, (f) => 'the private key in ' + path.join(f.AGM_KEY_DIR, 'tls.json') + ' does not open with this laptop\'s machine key'],
    ['a context token of another key', (f) => { machineKey(f.AGM_KEY_DIR); settings(f.AGM_DATA_DIR, { nodeId: 'a1b2c3d4', contextTokenSealed: sealedElsewhere() }); },
      (f) => '1 sealed value in ' + f.AGM_DATA_DIR + ' does not open with the machine key in ' + f.AGM_KEY_DIR + ' (the context token)'],
    ['values sealed, and no machine key', (f) => settings(f.AGM_DATA_DIR, { nodeId: 'a1b2c3d4', stagewatchKeySealed: sealedElsewhere(), aiKeySealed: sealedElsewhere() }),
      (f) => 'the machine key is not in ' + f.AGM_KEY_DIR + ', and 2 values in ' + f.AGM_DATA_DIR + ' were sealed with one (the AI key, the Stagewatch key)'],
    // Real files another program holds, or this account may not read (EBUSY, EACCES): each kept byte for byte.
    ['machine.key held (EACCES)', (f) => machineKey(f.AGM_KEY_DIR), (f) => 'the machine key at ' + path.join(f.AGM_KEY_DIR, 'machine.key') + ' could not be read (EACCES)', busy(['machine.key'], { code: 'EACCES' })],
    ['secret.key held (EACCES)', (f) => { machineKey(f.AGM_KEY_DIR); fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'secret.key'), crypto.randomBytes(32).toString('hex')); },
      (f) => path.join(f.AGM_DATA_DIR, 'secret.key') + ' could not be read (EACCES)', busy(['secret.key'], { code: 'EACCES' })],
    ['tls.json held (EBUSY)', (f) => certSealedWith(f.AGM_KEY_DIR, machineKey(f.AGM_KEY_DIR)), (f) => path.join(f.AGM_KEY_DIR, 'tls.json') + ' could not be read (EBUSY)', busy(['tls.json'])],
    // No machine key, and a file that may hold values sealed with one could not be read: none can be ruled out, so none is made.
    ['settings.json held, and no machine key', (f) => settings(f.AGM_DATA_DIR, { nodeId: 'a1b2c3d4', stagewatchKeySealed: sealedElsewhere() }),
      (f) => 'the machine key is not in ' + f.AGM_KEY_DIR + ', and ' + path.join(f.AGM_DATA_DIR, 'settings.json') + ' (EBUSY) could not be read, so whether values were sealed with one cannot be told. Start it again once that file can be read', busy(['settings.json'])],
    ['displays.json held, and no machine key', (f) => fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'displays.json'), JSON.stringify({ v: 1, halls: {}, displays: [] })),
      (f) => 'the machine key is not in ' + f.AGM_KEY_DIR + ', and ' + path.join(f.AGM_DATA_DIR, 'displays.json') + ' (EACCES) could not be read, so whether values were sealed with one cannot be told. Start it again once that file can be read', busy(['displays.json'], { code: 'EACCES' })],
  ];
  const prepared = cases.map(([, make], i) => {
    const where = path.join(base, String(i));
    const f = folders(where);
    fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
    make(f);
    return { f, where, before: tree(where) };
  });
  const results = [];
  for (const [i, { f }] of prepared.entries()) results.push(await run('server.js', { ...f, AGM_RUNS: 'task', AGM_TLS: '1', ...(cases[i][3] || {}) }));
  results.forEach((r, i) => {
    const [why, , words] = cases[i];
    const { f, where, before } = prepared[i];
    assert.equal(r.code, 3, why + ':\n' + r.out);
    assert.ok(r.out.includes('AGMessage cannot start: ' + words(f) + '. Nothing was changed'), why + ':\n' + r.out);
    assert.deepEqual(tree(where), before, why + ': nothing made or changed');
  });
});

// ---------------------------------------------------------------- the portable folder goes on without them
test('a portable copy goes on without a secret or certificate it cannot read, says why, and leaves each as it is', async (t) => {
  const base = tmp('agm-without-');
  const f = folders(base);
  fs.mkdirSync(path.join(f.AGM_DATA_DIR, 'secret.key'), { recursive: true });   // read errors, as EBUSY or EACCES
  fs.mkdirSync(path.join(f.AGM_KEY_DIR, 'tls.json'), { recursive: true });
  const srv = await h.startServer({ ...f, AGM_TLS: '1' });
  const out = srv.out();
  assert.ok(out.includes('  HTTPS:   off — ' + path.join(f.AGM_KEY_DIR, 'tls.json') + ' could not be read (EISDIR). It is left as it is'), out);
  assert.ok(out.includes('  Secret:  ' + path.join(f.AGM_DATA_DIR, 'secret.key') + ' could not be read (EISDIR). This run signs guests and invite links with a secret of its own'), out);
  const health = (await h.api(srv.base, 'GET', '/api/health')).body;
  assert.equal(health.tls.on, false, 'HTTPS off');
  // It serves: a hall, and a guest the secret of this run signs.
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  const guest = await h.connect(srv.base);
  const joined = await h.emit(guest, 'join', { roomCode: code, name: 'Ana', role: 'research' });
  guest.close();
  assert.ok(joined.ok && joined.identity, 'a guest is seated and given an identity');
  await h.stopServer(srv.child);
  for (const kept of [path.join(f.AGM_DATA_DIR, 'secret.key'), path.join(f.AGM_KEY_DIR, 'tls.json')]) {
    assert.ok(fs.statSync(kept).isDirectory() && fs.readdirSync(kept).length === 0, kept + ' left as it is');
  }

  // A certificate whose key does not open with this laptop's: HTTPS off, the file byte for byte as it was.
  const other = tmp('agm-without-');
  const g = folders(other);
  machineKey(g.AGM_KEY_DIR);
  certSealedElsewhere(g.AGM_KEY_DIR);
  const before = fs.readFileSync(path.join(g.AGM_KEY_DIR, 'tls.json'));
  const second = await h.startServer({ ...g, AGM_TLS: '1' });
  t.after(() => h.stopServer(second.child));
  assert.ok(second.out().includes('  HTTPS:   off — the private key in ' + path.join(g.AGM_KEY_DIR, 'tls.json') + ' does not open with this laptop\'s machine key. It is left as it is'), second.out());
  assert.equal((await h.api(second.base, 'GET', '/api/health')).body.tls.on, false);
  await h.stopServer(second.child);
  assert.deepEqual(fs.readFileSync(path.join(g.AGM_KEY_DIR, 'tls.json')), before, 'never a new certificate over it');

  // No machine key this run (keyless) and no certificate yet: none can be sealed, so none is made, and HTTPS is off.
  const third = tmp('agm-without-');
  const k = folders(third);
  fs.mkdirSync(path.join(k.AGM_KEY_DIR, 'machine.key'), { recursive: true });
  const keyless = await h.startServer({ ...k, AGM_TLS: '1' });
  t.after(() => h.stopServer(keyless.child));
  assert.ok(keyless.out().includes('  HTTPS:   off — no certificate can be made (the machine key at ' + path.join(k.AGM_KEY_DIR, 'machine.key') + ' could not be read (EISDIR))'), keyless.out());
  assert.equal((await h.api(keyless.base, 'GET', '/api/health')).body.tls.on, false);
  assert.deepEqual(fs.readdirSync(k.AGM_KEY_DIR).filter((n) => n !== 'audit'), ['machine.key'], 'no certificate, and nothing in the machine key\'s place');
});

test('a portable copy whose secret, certificate and settings another program holds serves on, says each, and after a start, a save asked and a stop leaves each byte for byte', async (t) => {
  const base = tmp('agm-held-files-');
  const f = folders(base);
  const key = machineKey(f.AGM_KEY_DIR);
  certSealedWith(f.AGM_KEY_DIR, key);
  fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
  const secretFile = path.join(f.AGM_DATA_DIR, 'secret.key');
  const tlsFile = path.join(f.AGM_KEY_DIR, 'tls.json');
  const settingsFile = path.join(f.AGM_DATA_DIR, 'settings.json');
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(settingsFile, JSON.stringify({ nodeId: 'a1b2c3d4', contextTokenSealed: sealWith(key, 'agn_' + 'k'.repeat(24)) }, null, 2));
  const kept = [secretFile, tlsFile, settingsFile, path.join(f.AGM_KEY_DIR, 'machine.key')];
  const before = bytesOf(kept);
  const srv = await h.startServer({ ...f, AGM_TLS: '1', ...busy(['secret.key', 'tls.json', 'settings.json'], { code: 'EACCES' }) });
  t.after(() => h.stopServer(srv.child));
  const out = srv.out();
  assert.ok(out.includes('  HTTPS:   off — ' + tlsFile + ' could not be read (EACCES). It is left as it is'), out);
  assert.ok(out.includes('  Secret:  ' + secretFile + ' could not be read (EACCES).'), out);
  assert.ok(out.includes('  Settings: ' + settingsFile + ' could not be read (EACCES). Nothing is saved over it this run'), out);
  assert.equal((await h.api(srv.base, 'GET', '/api/health')).body.tls.on, false, 'HTTPS off');
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const admin = await h.connect(srv.base, login.cookie);
  t.after(() => admin.close());
  assert.equal((await h.emit(admin, 'admin:settings', { remoteAdmin: true })).ok, false, 'a setting changed is refused, never dropped');
  await h.wait(300);   // a lane's save would have landed by now
  await h.stopServer(srv.child);
  assert.deepEqual(bytesOf(kept), before, 'the secret, the certificate, the settings and the machine key, each byte for byte');
  assert.deepEqual(fs.readdirSync(f.AGM_DATA_DIR).filter((n) => /^(secret\.key|settings\.json)/.test(n)).sort(), ['secret.key', 'settings.json'], 'no .bak or other copy made beside them');
});

test('settings.json that cannot be read is never written over: its .bak is not taken for it, no context token is made, and a setting changed is refused with why', async (t) => {
  const base = tmp('agm-settings-');
  const f = folders(base);
  const key = machineKey(f.AGM_KEY_DIR);
  fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
  const file = path.join(f.AGM_DATA_DIR, 'settings.json');
  const token = 'agn_' + 'r'.repeat(24);
  fs.writeFileSync(file, JSON.stringify({ nodeId: 'a1b2c3d4', contextTokenSealed: sealWith(key, token), stagewatchUrl: 'http://10.0.0.9:9924' }, null, 2));
  fs.writeFileSync(file + '.bak', JSON.stringify({ nodeId: 'a1b2c3d4' }, null, 2));   // a save behind: the token's save is the last one
  const before = bytesOf([file, file + '.bak']);
  const srv = await h.startServer({ ...f, ...busy(['settings.json']) });
  t.after(() => h.stopServer(srv.child));
  const AGAIN = 'Start AGMessage again once nothing else holds it (an antivirus or a backup may).';
  assert.ok(srv.out().includes('  Settings: ' + file + ' could not be read (EBUSY). Nothing is saved over it this run, which goes without its links and keys, and refuses a setting changed. ' + AGAIN), srv.out());
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const admin = await h.connect(srv.base, login.cookie);
  t.after(() => admin.close());
  const s = await h.emit(admin, 'admin:settings');
  const WHY = 'This AGMessage could not read its settings (EBUSY), so no context token answers this run. ' + AGAIN;
  assert.deepEqual([s.contextToken, s.contextTokenWhy, s.stagewatchUrl], ['', WHY, ''], 'no token made over the stored one; nothing of the .bak taken for the file');
  const read = await h.api(srv.base, 'GET', '/api/context', undefined, { headers: { authorization: 'Bearer ' + token } });
  assert.deepEqual([read.status, read.body.error], [503, WHY], 'context reads refused with why');
  // Every act that changes a setting is refused with why, before anything is taken: never answered as done.
  const NOT_SAVED = 'Not saved: ' + file + ' could not be read (EBUSY), so this run saves no setting over it. ' + AGAIN;
  for (const patch of [{ remoteAdmin: true }, { newContextToken: true }, { stagewatchUrl: '10.0.0.10' }, { aiKey: 'typed-now' }]) {
    assert.deepEqual(await h.emit(admin, 'admin:settings', patch), { ok: false, error: NOT_SAVED }, JSON.stringify(patch));
  }
  assert.deepEqual(await h.emit(admin, 'nodes:link', { id: 'playmap01', t: 'playmap', url: 'http://127.0.0.1:1', name: 'PlayMap', token: 'node-token' }), { ok: false, error: NOT_SAVED });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  assert.deepEqual(await h.emit(admin, 'hall:configure', { code, name: 'Renamed', stagewatchUrl: '10.0.0.9' }), { ok: false, error: NOT_SAVED }, 'a hall\'s Stagewatch refused');
  assert.equal((await h.emit(admin, 'hall:settings', { code })).name, 'Hall 1', 'and its name with it: the save is one');
  const other = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: login.cookie })).body.code;
  assert.deepEqual(await h.emit(admin, 'room:update', { code, sendFrom: [other], sendBack: [other] }), { ok: false, error: NOT_SAVED }, 'which rooms may send into a hall: refused');
  assert.deepEqual([(await h.emit(admin, 'room:settings', { code })).sendFrom, (await h.emit(admin, 'room:settings', { code: other })).sendFrom], [[], []], 'and neither list was set');
  assert.deepEqual(await h.emit(admin, 'hall:configure', { code, name: 'Renamed', stagewatchUrl: '' }), { ok: true, changed: ['name → Renamed'] }, 'a change of no setting goes through');
  await h.wait(300);   // a lane's save would have landed by now
  await h.stopServer(srv.child);
  assert.deepEqual(bytesOf([file, file + '.bak']), before, 'settings.json and its .bak byte for byte');
});

test('settings.json\'s .bak stands in only for a file not there or not whole: one missing beside a .bak that cannot be read, or not whole with no .bak, is kept as it is; one missing beside a .bak not whole begins anew', async () => {
  const base = tmp('agm-settings-bak-');
  const cases = [
    ['missing, its .bak held', { 'settings.json.bak': JSON.stringify({ nodeId: 'a1b2c3d4', stagewatchUrl: 'http://10.0.0.9:9924' }) }, busy(['settings.json.bak']),
      (file) => '  Settings: ' + file + ' is missing, and its .bak could not be read (EBUSY). Nothing is saved over it this run'],
    ['not whole, no .bak', { 'settings.json': '{"nodeId": "a1b2c3d4", "contextTokenSea' }, {},
      (file) => '  Settings: ' + file + ' holds no settings AGMessage can read, nor does its .bak. Nothing is saved over it this run, which goes without its links and keys, and refuses a setting changed. Put back a copy of it, or move it aside and start AGMessage again to begin with new settings (its links and keys set again).'],
    ['missing, its .bak not whole', { 'settings.json.bak': '{"nodeId": "a1b2' }, {}, null],
  ];
  for (const [i, [why, files, env, said]] of cases.entries()) {
    const f = folders(path.join(base, String(i)));
    fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(f.AGM_DATA_DIR, name), text);
    const file = path.join(f.AGM_DATA_DIR, 'settings.json');
    const kept = [file, file + '.bak'];
    const before = bytesOf(kept);
    const srv = await h.startServer({ ...f, ...env });
    const out = srv.out();
    if (said) {
      assert.ok(out.includes(said(file)), why + ':\n' + out);
      await h.wait(300);   // a lane's save would have landed by now
      await h.stopServer(srv.child);
      assert.deepEqual(bytesOf(kept), before, why + ': both as they were, nothing made in the file\'s place');
    } else {
      assert.ok(!out.includes('  Settings: '), why + ': nothing to say:\n' + out);
      assert.ok(await until(() => { const [b] = bytesOf([file]); return !!b && /"nodeId": "[0-9a-f]{8}"/.test(b.toString('utf8')); }), why + ': new settings saved, with a node id');
      await h.stopServer(srv.child);
      assert.deepEqual(bytesOf([file + '.bak']), [before[1]], why + ': the .bak left as it was');
    }
  }
});

test('the installed node\'s certificate, in date, whose renewal fails serves on with it and says so; it is never code 3', async (t) => {
  const base = tmp('agm-renew-');
  const f = folders(base);
  const fp = certSealedWith(f.AGM_KEY_DIR, machineKey(f.AGM_KEY_DIR), 15);   // 15 days to run: renewed at start
  const tlsFile = path.join(f.AGM_KEY_DIR, 'tls.json');
  const before = fs.readFileSync(tlsFile);
  const srv = await h.startServer({ ...f, AGM_RUNS: 'task', AGM_TLS: '1', ...busy([], { unwritable: ['tls.json'] }) });
  t.after(() => h.stopServer(srv.child));
  assert.match(srv.out(), /\[tls\] the certificate, which ends .+, could not be renewed \(EBUSY\): it serves on, and the next start tries again/);
  const tls = (await h.api(srv.base, 'GET', '/api/health')).body.tls;
  assert.deepEqual([tls.on, tls.fingerprint], [true, fp], 'HTTPS on, with the certificate whose key opened');
  await h.stopServer(srv.child);
  assert.deepEqual(fs.readFileSync(tlsFile), before, 'left as it was');
  assert.deepEqual(fs.readdirSync(f.AGM_KEY_DIR).filter((n) => n.startsWith('tls.json')), ['tls.json'], 'no temporary file left beside it');
});

test('a saved context token that does not open is kept: token reads are refused with why, until the admin makes a new one', async (t) => {
  const base = tmp('agm-ctx-');
  const f = folders(base);
  machineKey(f.AGM_KEY_DIR);
  const stored = sealedElsewhere();
  fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), JSON.stringify({ nodeId: 'a1b2c3d4', contextTokenSealed: stored }));
  const srv = await h.startServer(f);
  t.after(() => h.stopServer(srv.child));
  const WHY = 'This AGMessage\'s context token does not open with its laptop\'s machine key, so no context token answers. Its admin makes a new one: New token, on the admin page.';
  assert.ok(srv.out().includes('  Context: ' + WHY), srv.out());
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const admin = await h.connect(srv.base, login.cookie);
  t.after(() => admin.close());
  let s = await h.emit(admin, 'admin:settings');
  assert.deepEqual([s.contextToken, s.contextTokenWhy], ['', WHY], 'no token made over it, and why');
  const read = (token) => h.api(srv.base, 'GET', '/api/context', undefined, { headers: { authorization: 'Bearer ' + token } });
  for (const token of ['agn_' + 'x'.repeat(24), '']) {
    const r = await read(token);
    assert.deepEqual([r.status, r.body.error], token ? [503, WHY] : [401, 'A context token is needed (AGMessage admin → Show network).']);
  }
  for (let i = 0; i < 12; i++) assert.equal((await read('agn_guess' + i)).status, 503, 'refused for why, never counted as a guess (no lockout)');
  // A setting saved meanwhile keeps the token as it is.
  assert.equal((await h.emit(admin, 'admin:settings', { remoteAdmin: false })).ok, true);
  assert.ok(await until(() => /"remoteAdmin": false/.test(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), 'utf8'))), 'saved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), 'utf8')).contextTokenSealed, stored, 'kept byte for byte');
  // New token, the admin's act: one is made, and it answers.
  s = await h.emit(admin, 'admin:settings', { newContextToken: true });
  assert.match(s.contextToken, /^agn_/);
  assert.equal(s.contextTokenWhy, '');
  assert.equal((await read(s.contextToken)).status, 200);
  assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'settings.json'), 'utf8')).contextTokenSealed !== stored), 'the new one saved');
});

// ---------------------------------------------------------------- held: the installed node tries again
test('the installed node\'s port held: code 75, and its watchdog starts it again on the ladder, never giving up, until the port is free and it serves', async (t) => {
  const port = await h.freePort();
  const squatter = net.createServer((c) => c.destroy());
  await new Promise((resolve) => { squatter.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { squatter.close(() => resolve()); }));
  const base = tmp('agm-held-');
  const f = folders(base);
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], {
    env: { ...process.env, ...f, AGM_RUNS: 'task', PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: '', AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { p.once('exit', resolve); });
  t.after(async () => { if (p.exitCode === null) { p.kill('SIGKILL'); await done; } });
  const log = () => { try { return fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.log'), 'utf8'); } catch { return ''; } };
  const heldLines = (text) => text.split('\n').filter((l) => l.includes('could not take its port or data folder, which another program holds (code 75)') && l.includes(' — restarting')).length;
  assert.ok(await until(() => heldLines(out) >= 8, 40000), 'tried again past where seven crashes give up:\n' + out);
  assert.equal(heldLines(log()), 1, 'the log takes the run\'s first try, not each: ' + log());
  assert.ok(out.includes(`Another program is using port ${port}. AGMessage tries again; AGMessage status names the program's process.`), out);
  assert.ok(!/giving up/.test(log()) && !fs.existsSync(path.join(f.AGM_DATA_DIR, 'watchdog.json')), 'never given up');
  squatter.close();
  assert.ok(await until(() => /AGMessage \S+ is running/.test(out), 15000), 'it serves once the port is free:\n' + out);
  assert.equal((await h.api(`http://127.0.0.1:${port}`, 'GET', '/api/health')).status, 200);
  p.send({ t: 'stop' });
  assert.equal(await done, 0, 'stopped as asked');
});

// ---------------------------------------------------------------- the port, once it listens
test('an error on the port once it listens keeps the copy serving, counted in health; a port that stopped listening saves and ends as a crash, which the watchdog restarts', async (t) => {
  const preload = '--require "' + path.join(__dirname, 'accept-preload.js').split(path.sep).join('/') + '"';
  const srv = await h.startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ') });
  t.after(() => h.stopServer(srv.child));
  const health = async () => (await h.api(srv.base, 'GET', '/api/health')).body;
  assert.deepEqual((await health()).acceptErrors, { count: 0, last: '' });
  srv.child.send({ t: 'test:acceptError' });
  assert.ok(await until(async () => (await health()).acceptErrors.count === 1), srv.out());
  assert.deepEqual((await health()).acceptErrors, { count: 1, last: 'EMFILE' });
  assert.match(srv.out(), /\[port\] a connection could not be taken \(EMFILE, 1 so far\): still serving/);
  // Still serving: a hall, a guest and a message, written to the hall's log.
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  const guest = await h.connect(srv.base);
  assert.ok((await h.emit(guest, 'join', { roomCode: code, name: 'Ana', role: 'research' })).ok);
  assert.ok((await h.emit(guest, 'message', { type: 'text', text: 'said before the port went' })).ok);
  guest.close();
  assert.equal(srv.child.exitCode, null, 'the copy serves on');
  const snapshot = path.join(srv.dataDir, 'rooms', code + '.json');
  const inSnapshot = () => { try { return fs.readFileSync(snapshot, 'utf8').includes('said before the port went'); } catch { return false; } };
  assert.equal(inSnapshot(), false, 'in the hall\'s log, not yet in its snapshot');
  // The port stops listening: saved, then ended as a crash (70), which the watchdog restarts on its ladder.
  const gone = new Promise((resolve) => { srv.child.once('exit', (c) => resolve(c)); });
  srv.child.send({ t: 'test:acceptError', close: true });
  assert.equal(await gone, 70, srv.out());
  assert.match(srv.out(), /the port stopped listening, so AGMessage saves and stops for its watchdog to start it again/);
  assert.ok(inSnapshot(), 'the hall was saved before it went');
  assert.equal(fs.readFileSync(path.join(srv.dataDir, 'rooms', code + '.log'), 'utf8'), '', 'its log folded into the snapshot');
});
