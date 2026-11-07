'use strict';
// The admin token is said only where a person sits: the watchdog, which makes it, says it in the banner on a console and
// never in output that is kept; the installed node writes it into a token folder of its own once its server serves, and
// takes no secret from its environment; a server run alone prints it as it always has; the first admin account is made
// with the token, typed at the laptop or by the token's sign-in made by this run, never from loopback alone; and
// `launch.js token` shows the installed node's token to whoever may read it, or says whom to ask.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const h = require('./helpers');
const startup = require('../lib/startup');
const launch = require('../launch');

const ROOT = h.ROOT;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await h.wait(50); } return false; };
/** The installed node's four folders under `base`, none of them made but the token folder, which its installer makes. */
function taskFolders(base, { tokenMade = true } = {}) {
  const f = { AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys'), AGM_TOKEN_DIR: path.join(base, 'token') };
  if (tokenMade) fs.mkdirSync(f.AGM_TOKEN_DIR, { recursive: true });
  return f;
}
const PRELOAD = (file) => '--require "' + path.join(__dirname, file).split(path.sep).join('/') + '"';   // forward slashes: no escapes inside the quotes

/**
 * The watchdog, run with its output captured (a pipe, as a log or a redirect keeps it): {p, out(), done, stop()}. `env`
 * replaces the defaults; ADMIN_TOKEN is the tests' unless `env` says otherwise (undefined: none given).
 */
async function watchdog(env) {
  const base = { ...process.env, PORT: String(await h.freePort()), HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05' };
  const all = { ...base, ...env };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], { env: all, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { p.once('exit', (code) => resolve(code)); });
  const stop = async () => { if (p.exitCode === null && p.signalCode === null) { try { p.send({ t: 'stop' }); } catch { p.kill('SIGKILL'); } } return done; };
  return { p, out: () => out, done, stop };
}
/** The banner's lines from its Admin login line to the rule under it: what the person reads there. */
const loginBlock = (out) => {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l === '  Admin login (only from this host laptop):');
  return at < 0 ? [] : lines.slice(at, at + 4);
};
/** The port a banner says it serves on. */
const portOf = (out) => Number((/Local: {3}http:\/\/localhost:(\d+)/.exec(out) || [])[1]);

// ---------------------------------------------------------------- the rules (pure)
test('the banner\'s Token line holds the token on a console only; elsewhere it says where the token is', () => {
  const file = 'C:\\ProgramData\\AGMessage\\token\\admin-token';
  assert.equal(startup.tokenLine({ tty: true, runs: 'portable', token: 'a1b2c3d4e5f60718', file: '' }), '    Token: a1b2c3d4e5f60718');
  assert.equal(startup.tokenLine({ tty: true, runs: 'task', token: 'a1b2c3d4e5f60718', file }), '    Token: a1b2c3d4e5f60718', 'a console is where a person sits, whatever the channel');
  const kept = startup.tokenLine({ tty: false, runs: 'portable', token: 'a1b2c3d4e5f60718', file: '' });
  assert.equal(kept, '    Token: not shown here, since this output is not a window a person reads and may be kept. Start AGMessage in its own window to see it, or set ADMIN_TOKEN, 16 or more random letters and digits, before it starts.');
  const task = startup.tokenLine({ tty: false, runs: 'task', token: 'a1b2c3d4e5f60718', file });
  assert.equal(task, '    Token: not shown here. It is in ' + file + ', which this PC\'s AGMessage admin reads (Start → AGMessage → Show the admin token).');
  for (const line of [kept, task]) assert.ok(!line.includes('a1b2c3d4e5f60718'));
  assert.equal(startup.TOKEN_FILE, 'admin-token');
});

test('the installed node takes no secret from its environment, and its token folder is a full path of its own', () => {
  const linux = { programDir: '/opt/AGMessage', platform: 'linux' };
  const all = { AGM_RUNS: 'task', AGM_DATA_DIR: '/var/lib/agm/data', AGM_UPLOAD_DIR: '/var/lib/agm/uploads', AGM_KEY_DIR: '/var/lib/agm/keys', AGM_TOKEN_DIR: '/var/lib/agm/token' };
  assert.equal(startup.taskTokenProblem(all, linux), '');
  assert.equal(startup.taskTokenProblem({ ...all, ADMIN_TOKEN: '', ANTHROPIC_API_KEY: '' }, linux), '', 'an empty value is none');
  // A portable copy may be given its token and its AI key (start-agmessage.bat leaves both to the person).
  assert.equal(startup.taskTokenProblem({ ADMIN_TOKEN: 'mine', ANTHROPIC_API_KEY: 'sk-x' }, linux), '');
  assert.equal(startup.taskTokenProblem({ AGM_RUNS: 'portable', ADMIN_TOKEN: 'mine' }, linux), '');
  assert.equal(startup.taskTokenProblem({ ...all, ADMIN_TOKEN: 'chosen01' }, linux),
    'ADMIN_TOKEN is set in the installed node\'s environment, where every account that may read its task reads it too. Its watchdog makes the admin token at each start and writes it where this PC\'s AGMessage admin reads it: remove ADMIN_TOKEN from it.');
  assert.equal(startup.taskTokenProblem({ ...all, ANTHROPIC_API_KEY: 'sk-ant-x' }, linux),   // secret-scan: fixture
    'ANTHROPIC_API_KEY is set in the installed node\'s environment, where every account that may read its task reads it too. Add the key on the admin page instead (Admin → AI), where it is sealed with this PC\'s machine key: remove ANTHROPIC_API_KEY from it.');
  for (const s of [startup.taskTokenProblem({ ...all, ADMIN_TOKEN: 'chosen01' }, linux), startup.taskTokenProblem({ ...all, ANTHROPIC_API_KEY: 'sk-ant-x' }, linux)]) {   // secret-scan: fixture
    assert.ok(!s.includes('chosen01') && !s.includes('sk-ant-x'), 'the words never hold the value');   // secret-scan: fixture
  }
  assert.deepEqual(startup.TASK_SECRETS.map(([name]) => name), ['ADMIN_TOKEN', 'ANTHROPIC_API_KEY']);

  for (const unset of [undefined, '']) {
    assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: unset }, linux), 'the installed node needs its token folder in AGM_TOKEN_DIR, and it is not set. It is a full path outside /opt/AGMessage, a folder of its own.');
  }
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: 'token' }, linux), 'AGM_TOKEN_DIR is "token", which is not a full path. The installed node\'s token folder is a full path outside /opt/AGMessage, a folder of its own.');
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/opt/AGMessage/token' }, linux), 'AGM_TOKEN_DIR is /opt/AGMessage/token, inside the program\'s folder /opt/AGMessage. The installed node\'s token folder is outside it, where an upgrade never replaces it.');
  // Of its own: not another of the node's folders, inside one, or holding one.
  const own = (dir, name, other) => `AGM_TOKEN_DIR is ${dir}, and the ${name} folder (${other[0]}) is ${other[1]}. The token folder is one of its own, neither inside another of the node's folders nor holding one: whoever is given the token reads that folder, and nothing else of the node.`;
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/var/lib/agm/keys' }, linux), own('/var/lib/agm/keys', 'key', ['AGM_KEY_DIR', '/var/lib/agm/keys']));
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/var/lib/agm/keys/token' }, linux), own('/var/lib/agm/keys/token', 'key', ['AGM_KEY_DIR', '/var/lib/agm/keys']));
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/var/lib/agm/data/token' }, linux), own('/var/lib/agm/data/token', 'data', ['AGM_DATA_DIR', '/var/lib/agm/data']));
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/var/lib/agm' }, linux), own('/var/lib/agm', 'data', ['AGM_DATA_DIR', '/var/lib/agm/data']), 'a folder that holds the data folder');
  assert.equal(startup.taskTokenProblem({ ...all, AGM_TOKEN_DIR: '/var/lib/agm/uploads' }, linux), own('/var/lib/agm/uploads', 'uploads', ['AGM_UPLOAD_DIR', '/var/lib/agm/uploads']));
  // Windows: the installed layout passes; letter case does not make a folder another.
  const win = { programDir: 'C:\\Program Files\\AGMessage', platform: 'win32' };
  const pd = { AGM_RUNS: 'task', AGM_DATA_DIR: 'C:\\ProgramData\\AGMessage\\data', AGM_UPLOAD_DIR: 'C:\\ProgramData\\AGMessage\\uploads', AGM_KEY_DIR: 'C:\\ProgramData\\AGMessage\\keys', AGM_TOKEN_DIR: 'C:\\ProgramData\\AGMessage\\token' };
  assert.equal(startup.taskTokenProblem(pd, win), '');
  assert.match(startup.taskTokenProblem({ ...pd, AGM_TOKEN_DIR: 'c:\\programdata\\agmessage\\KEYS' }, win), /^AGM_TOKEN_DIR is c:\\programdata\\agmessage\\KEYS, and the key folder \(AGM_KEY_DIR\)/);
  assert.match(startup.taskTokenProblem({ ...pd, AGM_TOKEN_DIR: '\\\\?\\C:\\ProgramData\\AGMessage\\token' }, win), /which is not a full path/);
});

// ---------------------------------------------------------------- the watchdog and the server
test('a portable copy\'s captured output never holds the token: the Token line says how to see it, in its place in the banner', async (t) => {
  const base = tmp('agm-tok-');
  const w = await watchdog({ AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys') });
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:')), 'it serves:\n' + w.out());
  assert.deepEqual(loginBlock(w.out()), [
    '  Admin login (only from this host laptop):',
    `    URL:   http://localhost:${portOf(w.out())}/admin`,
    '    Token: not shown here, since this output is not a window a person reads and may be kept. Start AGMessage in its own window to see it, or set ADMIN_TOKEN, 16 or more random letters and digits, before it starts.',
    '  ============================================',
  ]);
  assert.ok(!w.out().includes(h.TOKEN), 'the capture never holds the token');
  // The token is the one it was given: the person who set it signs in with it.
  assert.equal((await h.api(`http://127.0.0.1:${portOf(w.out())}`, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200);
  assert.equal(await w.stop(), 0);
});

test('on a console the watchdog says the token in the banner\'s Token line, where the server would have', async (t) => {
  const base = tmp('agm-tok-');
  const w = await watchdog({ AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys'), NODE_OPTIONS: [process.env.NODE_OPTIONS, PRELOAD('tty-preload.js')].filter(Boolean).join(' ') });
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:')), 'it serves:\n' + w.out());
  assert.deepEqual(loginBlock(w.out()), [
    '  Admin login (only from this host laptop):',
    `    URL:   http://localhost:${portOf(w.out())}/admin`,
    '    Token: ' + h.TOKEN,
    '  ============================================',
  ], 'the line holds its place: after the URL, before the rule and the audit log\'s lines');
  assert.equal(w.out().split('\n').filter((l) => l.includes(h.TOKEN)).length, 1, 'said once, on the Token line');
  assert.equal(await w.stop(), 0);
});

test('a server its watchdog runs never says the token itself; one with no watchdog answering says so after its wait and goes on', async (t) => {
  const srv = await h.startServer({ AGM_SUPERVISED: '1' });
  t.after(() => h.stopServer(srv.child));
  assert.deepEqual(loginBlock(srv.out()), [
    '  Admin login (only from this host laptop):',
    `    URL:   http://localhost:${srv.port}/admin`,
    '    Token: not shown here: the watchdog that keeps it did not answer.',
    '  ============================================',
  ]);
  assert.ok(!srv.out().includes(h.TOKEN), 'the server never prints it');
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200, 'and the token is the one it was handed');
});

test('a server run alone prints its token in the banner', async (t) => {
  const srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  assert.deepEqual(loginBlock(srv.out()), ['  Admin login (only from this host laptop):', `    URL:   http://localhost:${srv.port}/admin`, '    Token: ' + h.TOKEN, '  ============================================']);
});

test('what the check at start says waits for the banner to be whole: no line of it falls inside the Admin login block while the Token line is awaited', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200);   // a keyed entry, which names the log
  await h.stopServer(srv.child);
  const l = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').pop()).l;
  // A split's folder made aside before a stop, which no split pins and which holds no log file: the check at start
  // removes it, and says so at once, long before the server's 2 s wait for a watchdog that never answers ends.
  const aside = path.join(srv.dataDir, 'audit-archive', '.audit-' + l.slice(0, 8) + '-1-5.partial');
  fs.mkdirSync(aside, { recursive: true });
  fs.writeFileSync(path.join(aside, 'archive.json'), JSON.stringify({ kind: 'agmessage audit archive', v: 1, point: { seq: 5 } }));
  fs.writeFileSync(path.join(aside, 'SHA256SUMS'), '0'.repeat(64) + '  archive.json\n');
  srv = await h.restartServer(srv, { AGM_SUPERVISED: '1' });
  const said = '  Audit log:   A split at entry 5 did not finish before a stop; nothing was moved.';
  await h.until(() => srv.out().includes(said), 8000, 'the check\'s words');
  assert.deepEqual(loginBlock(srv.out()), [
    '  Admin login (only from this host laptop):',
    `    URL:   http://localhost:${srv.port}/admin`,
    '    Token: not shown here: the watchdog that keeps it did not answer.',
    '  ============================================',
  ]);
  const lines = srv.out().split('\n');
  assert.ok(lines.indexOf(said) > lines.findIndex((x) => x.startsWith('  Uploads:')), 'said after the banner:\n' + srv.out());
  assert.equal(fs.existsSync(aside), false, 'and the folder removed');
});

test('the installed node: an ADMIN_TOKEN or ANTHROPIC_API_KEY in its environment, or a token folder not its own, stops it with code 3 before anything is written', async () => {
  const cases = [
    [{ ADMIN_TOKEN: 'chosen0123456789' }, 'ADMIN_TOKEN is set in the installed node\'s environment'],
    [{ ADMIN_TOKEN: undefined, ANTHROPIC_API_KEY: 'sk-ant-api03-x' }, 'ANTHROPIC_API_KEY is set in the installed node\'s environment'],   // secret-scan: fixture
    [{ ADMIN_TOKEN: undefined, AGM_TOKEN_DIR: undefined }, 'the installed node needs its token folder in AGM_TOKEN_DIR, and it is not set.'],
    [{ ADMIN_TOKEN: undefined, AGM_TOKEN_DIR: 'keys-too' }, 'AGM_TOKEN_DIR is "keys-too", which is not a full path.'],
  ];
  for (const [i, [env, words]] of cases.entries()) {
    const base = tmp('agm-tok-');
    const f = taskFolders(base);
    const w = await watchdog({ ...f, AGM_RUNS: 'task', ...env });
    const code = await Promise.race([w.done, h.wait(15000).then(() => 'still running')]);
    if (code === 'still running') await w.stop();
    assert.equal(code, 3, i + ': ' + w.out());
    assert.ok(w.out().includes('AGMessage cannot start: ' + words), i + ': ' + w.out());
    assert.ok(!w.out().includes('chosen0123456789') && !w.out().includes('sk-ant-api03-x'), 'the words never hold the value');   // secret-scan: fixture
    assert.deepEqual(fs.readdirSync(base).sort(), ['token'], 'nothing written: no data, uploads or key folder');
    assert.deepEqual(fs.readdirSync(f.AGM_TOKEN_DIR), [], 'and no token file');
  }
  // The same folder, its own: the watchdog's own token folder inside its keys folder is refused too.
  const base = tmp('agm-tok-');
  const f = taskFolders(base, { tokenMade: false });
  const w = await watchdog({ ...f, AGM_RUNS: 'task', ADMIN_TOKEN: undefined, AGM_TOKEN_DIR: path.join(f.AGM_KEY_DIR, 'token') });
  assert.equal(await w.done, 3);
  assert.ok(w.out().includes('The token folder is one of its own'), w.out());
  assert.deepEqual(fs.readdirSync(base), []);
});

test('the installed node writes its token into its token folder only once its server serves: a copy whose port is held writes nothing there, and the capture never holds it', async (t) => {
  const port = await h.freePort();
  const squatter = net.createServer((c) => c.destroy());
  await new Promise((resolve) => { squatter.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { squatter.close(() => resolve()); }));
  const base = tmp('agm-tok-');
  const f = taskFolders(base);
  const file = path.join(f.AGM_TOKEN_DIR, 'admin-token');
  fs.writeFileSync(file, 'beforetoken00000');   // the token another copy, serving, wrote
  const w = await watchdog({ ...f, AGM_RUNS: 'task', PORT: String(port), ADMIN_TOKEN: undefined });
  t.after(() => w.stop());
  assert.ok(await until(() => (w.out().match(/\(code 75\)/g) || []).length >= 3), 'held, and tried again:\n' + w.out());
  assert.equal(fs.readFileSync(file, 'utf8'), 'beforetoken00000', 'a copy that does not serve writes over no token');
  squatter.close();
  assert.ok(await until(() => w.out().includes('\n  Uploads:')), 'it serves once the port is free:\n' + w.out());
  const token = fs.readFileSync(file, 'utf8');
  assert.match(token, /^[0-9a-f]{16}$/, 'the token it made, written whole');
  assert.deepEqual(fs.readdirSync(f.AGM_TOKEN_DIR), ['admin-token'], 'replaced whole by a rename: no temporary file left beside it');
  assert.deepEqual(loginBlock(w.out()), [
    '  Admin login (only from this host laptop):',
    `    URL:   http://localhost:${port}/admin`,
    '    Token: not shown here. It is in ' + file + ', which this PC\'s AGMessage admin reads (Start → AGMessage → Show the admin token).',
    '  ============================================',
  ]);
  assert.ok(!w.out().includes(token), 'the capture never holds it');
  assert.ok(!fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.log'), 'utf8').includes(token), 'nor watchdog.log');
  assert.equal((await h.api(`http://127.0.0.1:${port}`, 'POST', '/api/admin/login', { token })).status, 200, 'the file\'s token is the serving server\'s');
  assert.equal(await w.stop(), 0);
});

test('the installed node whose token cannot be written serves on without it, and says why on its console and in watchdog.log', async (t) => {
  const base = tmp('agm-tok-');
  const f = taskFolders(base, { tokenMade: false });   // its folder is not there: the installer's, which this test never ran
  const w = await watchdog({ ...f, AGM_RUNS: 'task', ADMIN_TOKEN: undefined });
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:')), 'it serves:\n' + w.out());
  const why = 'the admin token could not be written to ' + path.join(f.AGM_TOKEN_DIR, 'admin-token') + ' (ENOENT), so nobody can read it this run: AGMessage serves on without it.';
  assert.ok(w.out().includes('  [watchdog] ' + why), w.out());
  assert.equal(loginBlock(w.out())[3], '    Token: not shown here, and not written (the line above says why).');
  assert.ok(fs.readFileSync(path.join(f.AGM_DATA_DIR, 'watchdog.log'), 'utf8').includes(why));
  assert.ok(!fs.existsSync(f.AGM_TOKEN_DIR), 'its folder is never made by the node');
  assert.equal((await h.api(`http://127.0.0.1:${portOf(w.out())}`, 'GET', '/api/health')).status, 200, 'still serving');
  assert.equal(await w.stop(), 0);
});

// ---------------------------------------------------------------- the first admin account
test('the first admin account is made only with the token: typed at the laptop, or by the token\'s sign-in made by this run, never from loopback alone', async (t) => {
  const srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const ANA = { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' };
  const log = () => { try { return fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8'); } catch { return ''; } };   // none until its first row
  const rows = (action) => log().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action);
  const accounts = async () => (await h.api(srv.base, 'GET', '/api/auth/me')).body.setup;

  // From loopback with no token: refused, told to type it, nothing made, nothing counted or written.
  let r = await h.api(srv.base, 'POST', '/api/setup', ANA);
  assert.deepEqual([r.status, r.body.error], [401, 'Type the token from the AGMessage window (installed: Start → AGMessage → Show the admin token).']);
  assert.equal(await accounts(), true, 'no account was made');
  assert.equal(rows('login.token.fail').length, 0);
  // A body that is not an object, or a token that is not a string: the same.
  for (const body of [{ ...ANA, token: 12345 }, { ...ANA, token: ['x'] }]) assert.equal((await h.api(srv.base, 'POST', '/api/setup', body)).status, 401);
  // Under another name that leads back to the laptop: refused before the token is read.
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: h.TOKEN }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.deepEqual([r.status, r.body.error], [403, 'The first admin account is made on the AGMessage laptop itself, with its token.']);
  // Wrong tokens: refused, counted toward the token's lockout, written with where they were typed; once it holds, a wrong
  // one is refused 429 and not written again, and the right one is still taken.
  for (let i = 0; i < 5; i++) {
    r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: 'wrongtoken' + i });
    assert.deepEqual([r.status, r.body.error], [401, 'That is not the token in the AGMessage window.']);
  }
  assert.deepEqual(rows('login.token.fail').map((e) => [e.actor.id, e.target, e.words]), Array(5).fill(['host', 'host', 'a wrong admin token (at setup)']));
  assert.ok(!log().includes('wrongtoken'), 'a typed token is never written');
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: 'wrongtoken5' });
  assert.deepEqual([r.status, r.body.error], [429, 'Too many wrong tokens — wait a minute.']);
  assert.equal(rows('login.token.fail').length, 5, 'not written while the lock holds');
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 429, 'the token sign-in waits for the lock, as it did');
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: ' ' + h.TOKEN.toUpperCase() + ' ' });
  assert.equal(r.status, 200, 'the right token, typed while the lock holds, is taken: ' + JSON.stringify(r.body));
  assert.match(r.cookie, /^agm_s=/);
  assert.equal(await accounts(), false);
  assert.deepEqual(rows('setup').map((e) => [e.actor.id, e.target, e.words]), [['host', 'ana', 'the first admin account was made, with the token typed at the laptop']]);
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200, 'the right token let go of the lock');
});

test('the installed node makes its first admin account only with the token too: loopback alone is refused', async (t) => {
  const base = tmp('agm-tok-');
  const srv = await h.startServer({ AGM_RUNS: 'task', AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys') });
  t.after(() => h.stopServer(srv.child));
  const ANA = { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' };
  let r = await h.api(srv.base, 'POST', '/api/setup', ANA);
  assert.deepEqual([r.status, r.body.error], [401, 'Type the token from the AGMessage window (installed: Start → AGMessage → Show the admin token).']);
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: 'notthetoken' });
  assert.deepEqual([r.status, r.body.error], [401, 'That is not the token in the AGMessage window.']);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true, 'no account was made');
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: h.TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, false);
});

test('the token\'s sign-in made by this run makes the first admin account when no token is typed; one read back after a restart does not', async (t) => {
  let srv = await h.startServer();
  t.after(() => h.stopServer(srv.child));
  const ANA = { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' };
  const tok = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  // A restart under the same token (as the watchdog's): the sign-in is kept, but read back from its file.
  srv = await h.restartServer(srv);
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: tok })).body.ok, true, 'the sign-in held across the restart');
  let r = await h.api(srv.base, 'POST', '/api/setup', ANA, { cookie: tok });
  assert.equal(r.status, 401, 'a sign-in read back from its file is a record anyone who could write the folder could add');
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true);
  const fresh = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  // A token typed beside the sign-in is judged: a wrong one is refused, and counted, whatever the sign-in.
  r = await h.api(srv.base, 'POST', '/api/setup', { ...ANA, token: 'notthetoken' }, { cookie: fresh });
  assert.deepEqual([r.status, r.body.error], [401, 'That is not the token in the AGMessage window.']);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true);
  r = await h.api(srv.base, 'POST', '/api/setup', ANA, { cookie: fresh });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const setup = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'setup');
  assert.deepEqual(setup.map((e) => e.words), ['the first admin account was made, by the token\'s sign-in at the laptop']);
});

// ---------------------------------------------------------------- Show the admin token (launch.js token)
test('launch.js token prints the file\'s token, or, when the read is refused, whom to ask; never anything else the file holds', () => {
  const machine = path.join(os.tmpdir(), 'agm-machine');
  const file = path.join(machine, 'token', 'admin-token');
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  let asked = 0;
  const sys = 'C:\\Windows\\System32';
  const ana = (o) => { asked++; assert.deepEqual(o, { sys }, 'the System32 folder it was given, and no other'); return 'LAPTOP\\ana'; };
  const reads = [];
  const ok = launch.showToken({ machine, read: (f, enc) => { reads.push([f, enc]); return '0123456789abcdef\r\n'; }, admin: ana });
  assert.deepEqual(ok, { code: 0, text: 'AGMessage\'s admin token on this PC:\n\n    0123456789abcdef\n\nType it at Admin login on this PC. It holds while AGMessage serves; each start makes a new one. If it is not taken, AGMessage has started again or is not serving: show the token again once it serves.' });
  assert.deepEqual(reads, [[file, 'utf8']], 'the token folder\'s one file, read once');
  assert.equal(asked, 0, 'the admin\'s name is read only to say whom to ask');
  for (const code of ['EACCES', 'EPERM']) {
    assert.deepEqual(launch.showToken({ machine, sys, read: fail(code), admin: ana }), { code: 2, text: 'This PC\'s AGMessage admin has not given you the token: ask LAPTOP\\ana.' });
  }
  assert.deepEqual(launch.showToken({ machine, read: fail('EACCES'), admin: () => '' }), { code: 2, text: 'This PC\'s AGMessage admin has not given you the token: ask them, or an administrator of this PC.' });
  assert.deepEqual(launch.showToken({ machine, read: fail('ENOENT'), admin: ana }), { code: 2, text: 'AGMessage has no admin token on this PC yet: its server writes one each time it starts serving. Start AGMessage, then show the token again.' });
  assert.deepEqual(launch.showToken({ machine, read: fail('EBUSY'), admin: ana }), { code: 2, text: 'The admin token could not be read (EBUSY): try again in a moment.' });
  assert.deepEqual(launch.showToken({ machine, read: () => { throw new Error('no code'); }, admin: ana }).text, 'The admin token could not be read (EIO): try again in a moment.');
  for (const held of ['', 'not a token, a secret password', '0123456789ABCDEF', '0123456789abcdef0']) {
    const r = launch.showToken({ machine, read: () => held, admin: ana });
    assert.equal(r.code, 2);
    assert.equal(r.text, 'The token file (' + file + ') holds no token AGMessage wrote. Start AGMessage again: its server writes a new one.');
  }
  assert.equal(asked, 2, 'asked for the name at each refusal');
});

test('launch.js reads this PC\'s AGMessage admin from the install record by reg.exe\'s absolute path in the System32 folder it is given, and names no one when it cannot', () => {
  const calls = [];
  const sys = 'C:\\Windows\\System32';
  const run = (file, args, o) => { calls.push([file, args, o.cwd, o.timeout, o.windowsHide]); return '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\AGMessage\r\n    AdminName    REG_SZ    LAPTOP\\ana\u001b[2J\r\n\r\n'; };
  assert.equal(launch.adminName({ sys, platform: 'win32', run }), 'LAPTOP\\ana[2J', 'its control characters taken out');
  assert.deepEqual(calls, [['C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\AGMessage', '/v', 'AdminName', '/reg:64'], sys, 5000, true]], 'by its absolute path, from that folder');
  assert.equal(launch.adminName({ sys, platform: 'win32', run: () => { throw Object.assign(new Error('gone'), { status: 1 }); } }), '', 'no record');
  assert.equal(launch.adminName({ sys, platform: 'win32', run: () => 'nothing like it' }), '');
  // No System32 folder named from its drive: nothing is run, and no machine path is taken from the environment.
  const before = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  try {
    for (const given of [{}, { sys: '' }, { sys: 'Windows\\System32' }, { sys: '\\\\host\\share' }]) {
      assert.equal(launch.adminName({ ...given, platform: 'win32', run: () => { throw new Error('never run'); } }), '', 'not run: ' + JSON.stringify(given));
    }
  } finally { if (before === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = before; }
  assert.equal(launch.adminName({ sys, platform: 'linux', run: () => { throw new Error('never run'); } }), '');
  // launch.js reads no machine path from its environment: the installer passes each folder as an argument. Its one read
  // of its environment is taskEnv's, which hands the watchdog Windows' own names (TASK_PASSED) and nothing else of it, so
  // no NODE_OPTIONS, no AGM_… and no secret reaches the installed node from whatever started the task.
  const src = h.readSource(path.join(ROOT, 'launch.js'));
  assert.deepEqual(src.match(/process\.env\b.{0,1}/g), ['process.env)'], 'one read of its environment');
  assert.match(src, /function taskEnv\(a, inherited = process\.env\) \{\n {2}const env = \{\};\n {2}for \(const name of TASK_PASSED\) if \(typeof inherited\[name\] === 'string' && inherited\[name\]\) env\[name\] = inherited\[name\];\n/, 'and it copies the named names only');
  assert.ok(!launch.TASK_PASSED.some((n) => /^(AGM_|NODE_|ADMIN|ANTHROPIC|PATH$)/i.test(n)), 'none of them AGMessage\'s, Node\'s, a secret or the search path');
});

test('launch.js knows serve, token, status and open, and refuses any other word; token takes --machine <full path> [--sys <System32 folder>]', () => {
  const said = [];
  const out = (t) => said.push(t);
  const machine = tmp('agm-machine-');
  assert.equal(launch.main([], { out }), 64);
  assert.equal(launch.main(['boot'], { out }), 64);
  assert.equal(launch.main(['token'], { out }), 64);
  assert.equal(launch.main(['token', '--machine', 'relative\\folder'], { out }), 64);
  assert.equal(launch.main(['token', '--machine', machine, '--print'], { out }), 64);
  assert.equal(launch.main(['token', '--machine'], { out }), 64);
  assert.equal(launch.main(['token', '--machine', machine, '--machine', machine], { out }), 64);
  assert.equal(launch.main(['token', '--machine', machine, '--sys', 'System32'], { out }), 64);
  assert.equal(launch.main(['token', '--sys', 'C:\\Windows\\System32'], { out }), 64);
  const fits = 'launch.js token takes --machine <folder> and --sys <folder>, each once and each with its folder; ';
  const needs = 'launch.js token needs --machine <folder>, the installed node\'s folder as a full path (%ProgramData%\\AGMessage).';
  assert.deepEqual(said, [
    'launch.js knows serve, token, status or open.',
    'launch.js knows serve, token, status or open. "boot" is not one of them.',
    needs,
    needs,
    fits + '"--print" does not fit.',
    fits + '"--machine" does not fit.',
    fits + '"--machine" does not fit.',
    'launch.js token\'s --sys is the System32 folder named from its drive (C:\\Windows\\System32); "System32" is not one.',
    needs,
  ]);
  assert.deepEqual(launch.parse(['token', '--sys', 'C:\\Windows\\System32', '--machine', machine]), { verb: 'token', machine, sys: 'C:\\Windows\\System32' });
  assert.deepEqual(launch.parse(['token', '--machine', machine]), { verb: 'token', machine, sys: '' });
  fs.mkdirSync(path.join(machine, 'token'));
  fs.writeFileSync(path.join(machine, 'token', 'admin-token'), 'fedcba9876543210');
  assert.equal(launch.main(['token', '--machine', machine], { out }), 0);
  assert.match(said.at(-1), /\n {4}fedcba9876543210\n/);
});

test('launch.js token, run as the person runs it: the token printed with code 0; a read refused says whom to ask, with code 2', async () => {
  const machine = tmp('agm-machine-');
  fs.mkdirSync(path.join(machine, 'token'));
  fs.writeFileSync(path.join(machine, 'token', 'admin-token'), '00112233aabbccdd');
  const run = (args, env = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'launch.js'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  let r = await run(['token', '--machine', machine]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('\n    00112233aabbccdd\n'), r.out);
  assert.ok(!r.out.includes('Press Enter'), 'only a console window waits for Enter');
  // The account may not read the file (as a file this account was not given, which a test run as root cannot make).
  r = await run(['token', '--machine', machine], { NODE_OPTIONS: [process.env.NODE_OPTIONS, PRELOAD('busy-preload.js')].filter(Boolean).join(' '), AGM_TEST_UNREADABLE: 'admin-token', AGM_TEST_UNREADABLE_CODE: 'EACCES' });
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('This PC\'s AGMessage admin has not given you the token: ask '), r.out);
  assert.ok(!r.out.includes('00112233aabbccdd'), 'never the file\'s bytes');
  r = await run(['upgrade']);
  assert.equal(r.code, 64, r.out);
});
