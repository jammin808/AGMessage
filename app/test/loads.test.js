'use strict';
// What AGMessage loads and what it runs (docs/ANALYSIS.md §3.7).
//  - It loads only what it ships. The watchdog and its server, and the server started alone, run under a resolve hook
//    (test/resolve-preload.js) with modules planted where Node looks once app has no answer (NODE_PATH, which Node reads
//    only after its walk up every folder above the asking file, as a C:\node_modules is reached only at that walk's end):
//    nothing they load is outside app, nothing is a file the portable folder does not ship or a package only a
//    developer's checkout has (the lockfile's `dev`), nothing they ask for is answered nowhere in app, and no planted
//    module runs. What the run does not reach is read from the source: every ask of the shipped server-side scripts,
//    followed through each file it reaches as Node resolves it, is held to the same, but the asks a register names as
//    never made (ws's switched-off helpers) and the requires whose name is made at run time (express's view engine).
//  - It runs only what it names by its absolute path. Every call in app that starts a program (child_process's spawn,
//    execFile, fork and the rest, however it is reached: required or imported, given another name, destructured,
//    read by a name written in brackets, a default, `this`), read from the source by ESLint's own parser with its scopes,
//    names its program (and fork's execPath) by process.execPath or by a name this file's register holds with where its
//    full path is made, and starts no shell; child_process or one of its functions is handed on only where a row says to
//    whom, and child_process named where none of these takes it fails. Each place a path is made is then held to give a
//    full path or run nothing.
//  - The machine's own commands (launch.js, and machine.js once it is made) require Node's built-ins only, by `node:`,
//    and reach require no other way. What of app they run as a process of their own, elevated (the import's facts
//    reader, lib/importfacts.js), loads under the resolve hook only app\lib, app\verify and Node's built-ins, asks for
//    nothing app cannot answer, and runs no planted module.
// Each rule is a function of what it is given, so the tree is held to it and a planted breach of each kind fails it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const { createRequire, isBuiltin } = require('module');
const { Linter } = require('eslint');
const { io } = require('socket.io-client');
const { ROOT, TOKEN, filesUnder, freePort, startServer, stopServer, until, readSource } = require('./helpers');
const startup = require('../lib/startup');
const laptop = require('../lib/laptop');
const power = require('../lib/power');
const launch = require('../launch');

const read = (f, root = ROOT) => readSource(path.join(root, f));
const LOCK = JSON.parse(read('package-lock.json'));
/** What the portable folder ships of app (tools/build-portable.ps1): these files at its top, these folders whole, and node_modules as `npm ci --omit=dev` makes it. */
const SHIPPED_FILES = ['server.js', 'supervise.js', 'launch.js', 'machine.js', 'package.json', 'package-lock.json', 'README.md', 'build.json'];
const SHIPPED_FOLDERS = ['lib', 'verify', 'public', 'node_modules'];
/** ESLint's own parser and scopes, which both readings below use. */
const linter = new Linter({ configType: 'flat' });

// ---------------------------------------------------------------- only what it ships: the resolve hook
/** A folder of modules where Node looks once app has no answer, each one writing its name into `loaded.txt` beside it as it runs. */
function plant(base) {
  const dir = path.join(base, 'plant', 'node_modules');
  const body = {
    'supports-color': 'module.exports = { stdout: false, stderr: false };',
    bufferutil: 'module.exports = { mask(s, m, o, at, n) { for (let i = 0; i < n; i++) o[at + i] = s[i] ^ m[i & 3]; }, unmask(b, m) { for (let i = 0; i < b.length; i++) b[i] ^= m[i & 3]; } };',
    'utf-8-validate': 'module.exports = () => true;',
  };
  for (const [name, exports] of Object.entries(body)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ name, version: '99.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, name, 'index.js'), "require('node:fs').appendFileSync(require('node:path').join(__dirname, '..', '..', 'loaded.txt'), " + JSON.stringify(name + '\n') + ');\n' + exports + '\n');
  }
  return { dir, loaded: () => { try { return fs.readFileSync(path.join(base, 'plant', 'loaded.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; /* none ran */ } } };
}
/** NODE_OPTIONS that preload the resolve hook, beside what the run already has. */
const hooked = () => [process.env.NODE_OPTIONS, '--require "' + path.join(__dirname, 'resolve-preload.js').split(path.sep).join('/') + '"'].filter(Boolean).join(' ');
/** The rows a run wrote, read back. */
const rowsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The lockfile's package a file of app/node_modules belongs to ('node_modules/a/node_modules/b'), or null. */
function packageOf(rel, lock) {
  const parts = rel.split(/[\\/]/);
  for (let n = parts.length - 1; n > 0; n--) {
    const key = parts.slice(0, n).join('/');
    if (Object.hasOwn(lock.packages || {}, key) && key.startsWith('node_modules/')) return key;
  }
  return null;
}
/**
 * What a run's rows say was loaded from somewhere it should not be, each in words, sorted: a module answered nowhere in
 * app (the walk went on up to the drive's root), one loaded from outside `app` (its real path), one in app that the
 * portable folder does not ship, and one of a package the lockfile does not list or lists for development only. Each is
 * named with the process that asked (by its script) and who asked for it. A module Node has built in is its own.
 */
function loadProblems(rows, { app = fs.realpathSync(ROOT), lock = LOCK } = {}) {
  const who = new Map(rows.filter((r) => 'start' in r).map((r) => [r.pid, r.start ? path.basename(r.start) : 'a process']));
  const where = (url) => { try { const f = fileURLToPath(url); const rel = path.relative(app, f); return rel.startsWith('..') || path.isAbsolute(rel) ? f : rel.split(path.sep).join('/'); } catch { return url; } };
  const problems = [];
  for (const r of rows) {
    if ('start' in r) continue;
    const by = (who.get(r.pid) || 'a process') + ' asked for \'' + r.asked + '\' from ' + where(r.from);
    if (r.nowhere) { problems.push(by + ', which nothing in app answers: Node walks on up every folder above app to the drive\'s root, where any account may plant it'); continue; }
    if (r.url.startsWith('node:')) continue;
    if (!r.url.startsWith('file:')) { problems.push(by + ' and loaded ' + r.url + ', which is no file of app'); continue; }
    const at = where(r.url);
    if (path.isAbsolute(at)) { problems.push(by + ' and loaded ' + at + ', outside app'); continue; }
    const top = at.split('/')[0];
    if (!(at === top ? SHIPPED_FILES.includes(top) : SHIPPED_FOLDERS.includes(top))) { problems.push(by + ' and loaded ' + at + ', which the portable folder does not ship'); continue; }
    if (top !== 'node_modules') continue;
    const pkg = packageOf(at, lock);
    if (!pkg) problems.push(by + ' and loaded ' + at + ', of a package the lockfile does not list');
    else if (lock.packages[pkg].dev) problems.push(by + ' and loaded ' + at + ', of ' + pkg.slice(pkg.lastIndexOf('node_modules/') + 13) + ', a development package the portable folder (npm ci --omit=dev) does not ship');
  }
  return [...new Set(problems)].sort();
}
/** What a run asks of a server that serves on `base`: the start page, health and a socket over WebSocket, as a page's first moments do. */
async function used(base) {
  for (const p of ['/', '/api/health', '/admin', '/socket.io/socket.io.min.js']) assert.ok((await fetch(base + p)).status < 500, p);
  const s = io(base, { transports: ['websocket'], reconnection: false });
  try {
    await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
    const answer = await new Promise((resolve) => { s.emit('join', { roomCode: 'NOHALL', name: 'Ana '.repeat(20) }, resolve); });
    assert.equal(answer.ok, false, 'a join of no hall is answered, refused');
  } finally { s.close(); }
}

test('only what it ships: the watchdog and its server load nothing from outside app, nothing app does not ship, and ask for nothing app cannot answer', { timeout: 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-loads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planted = plant(base);
  const resolves = path.join(base, 'resolves.jsonl');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_DATA_DIR: path.join(base, 'data'), AGM_KEY_DIR: path.join(base, 'keys'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), NODE_OPTIONS: hooked(), NODE_PATH: planted.dir, AGM_TEST_RESOLVES: resolves };
  delete env.WS_NO_BUFFER_UTIL; delete env.WS_NO_UTF_8_VALIDATE;
  const w = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { w.once('exit', resolve); });
  t.after(() => { if (w.exitCode === null && w.signalCode === null) w.kill('SIGKILL'); });
  await until(() => out.includes('\n  Uploads:'), 30_000, 'the server under its watchdog serving (' + out + ')');
  await used('http://127.0.0.1:' + port);
  w.send({ t: 'stop' });
  assert.equal(await done, 0, out);

  const rows = rowsOf(resolves);
  const starts = rows.filter((r) => 'start' in r);
  assert.deepEqual(starts.map((r) => path.basename(r.start)).sort(), ['server.js', 'supervise.js'], 'both processes ran under the hook');
  assert.deepEqual(starts.find((r) => r.start.endsWith('server.js')).ws, ['1', '1'], 'the watchdog starts its server with ws\'s two switches');
  assert.deepEqual(loadProblems(rows), []);
  assert.deepEqual(planted.loaded(), [], 'no planted module ran');
  // The hook saw what the server is made of: the modules that asked for the walk are loaded, and their answers are app's.
  const server = starts.find((r) => r.start.endsWith('server.js')).pid;
  const asked = (name) => rows.filter((r) => r.pid === server && r.asked === name).map((r) => r.url && path.relative(fs.realpathSync(ROOT), fileURLToPath(r.url)).split(path.sep).join('/'));
  assert.deepEqual(asked('supports-color'), ['node_modules/supports-color/index.js'], 'debug finds the supports-color app ships');
  assert.deepEqual([asked('bufferutil'), asked('utf-8-validate')], [[], []], 'ws never asks for its native helpers');
  assert.ok(rows.filter((r) => r.pid === server && r.url).length > 500, 'the server\'s whole graph went through the hook');
});

test('only what it ships: the server started alone (as npm run dev and the tests start it) sets ws\'s switches itself, before its first require', { timeout: 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-loads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planted = plant(base);
  const resolves = path.join(base, 'resolves.jsonl');
  const env = { NODE_OPTIONS: hooked(), NODE_PATH: planted.dir, AGM_TEST_RESOLVES: resolves, WS_NO_BUFFER_UTIL: undefined, WS_NO_UTF_8_VALIDATE: undefined };
  const srv = await startServer(env);
  t.after(() => stopServer(srv.child));
  await used(srv.base);
  await stopServer(srv.child);
  const rows = rowsOf(resolves);
  assert.deepEqual(rows.filter((r) => 'start' in r).map((r) => [path.basename(r.start), r.ws]), [['server.js', ['', '']]], 'started without them');
  assert.deepEqual(loadProblems(rows), []);
  assert.deepEqual(planted.loaded(), []);

  // Read from the source: the two switches come before the first require in server.js's code.
  const src = read('server.js');
  const lineOf = (i) => (i < 0 ? Infinity : src.slice(0, i).split('\n').length);
  const first = parseAsks(src, 'commonjs').requires[0].line;
  const at = ['WS_NO_BUFFER_UTIL', 'WS_NO_UTF_8_VALIDATE'].map((n) => lineOf(src.indexOf('\nprocess.env.' + n + " = '1';\n") + 1));
  assert.ok(at.every((l) => l < first), 'server.js sets both (lines ' + at.join(', ') + ') before its first require (line ' + first + ')');
});

test('only what it ships: the hook and the plant see the walk, and each kind of load out of bounds is named', { timeout: 30_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-loads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planted = plant(base);
  const app = fs.realpathSync(ROOT);
  // ws asked for without its switch: its buffer-util asks for bufferutil, app has none, and Node's walk ends at the plant.
  const asks = path.join(base, 'asks.js');
  fs.writeFileSync(asks, 'require(process.argv[2]);\n');
  /** A run's rows but its own start (the script outside app the test runs, which is not what the fence judges). */
  const rowsOfWs = (file) => rowsOf(file).filter((r) => r.asked !== asks);
  const run = (file, env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [asks, path.join(ROOT, 'node_modules', 'ws')], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: hooked(), AGM_TEST_RESOLVES: file, ...env }, stdio: 'ignore' });
    c.once('exit', resolve);
  });
  const reached = path.join(base, 'reached.jsonl');
  await run(reached, { WS_NO_BUFFER_UTIL: '', NODE_PATH: planted.dir });
  assert.deepEqual(loadProblems(rowsOfWs(reached)), ["asks.js asked for 'bufferutil' from node_modules/ws/lib/buffer-util.js and loaded " + path.join(fs.realpathSync(planted.dir), 'bufferutil', 'index.js') + ', outside app']);
  assert.deepEqual(planted.loaded(), ['bufferutil'], 'the planted module ran');
  const nowhere = path.join(base, 'nowhere.jsonl');
  await run(nowhere, { WS_NO_BUFFER_UTIL: '', NODE_PATH: '' });
  assert.deepEqual(loadProblems(rowsOfWs(nowhere)), ["asks.js asked for 'bufferutil' from node_modules/ws/lib/buffer-util.js, which nothing in app answers: Node walks on up every folder above app to the drive's root, where any account may plant it"]);
  const switched = path.join(base, 'switched.jsonl');
  await run(switched, { WS_NO_BUFFER_UTIL: '1', NODE_PATH: planted.dir });
  assert.deepEqual([loadProblems(rowsOfWs(switched)), planted.loaded()], [[], ['bufferutil']], 'with its switch, ws asks for nothing: the plant ran no more');

  // Each kind, planted (pure): a file app does not ship, a development package, a package the lockfile does not list, a
  // URL that is no file; and a module Node has built in, a shipped file and a production package pass.
  const url = (rel) => pathToFileURL(path.join(app, rel)).href;
  const lock = { packages: { 'node_modules/express': {}, 'node_modules/eslint': { dev: true }, 'node_modules/a/node_modules/b': {} } };
  const rows = [
    { pid: 1, start: path.join(app, 'server.js'), ws: ['1', '1'] },
    { pid: 1, from: url('server.js'), asked: 'fs', url: 'node:fs' },
    { pid: 1, from: url('server.js'), asked: './lib/store', url: url('lib/store.js') },
    { pid: 1, from: url('server.js'), asked: 'express', url: url('node_modules/express/index.js') },
    { pid: 1, from: url('node_modules/a/index.js'), asked: 'b', url: url('node_modules/a/node_modules/b/index.js') },
    { pid: 1, from: url('server.js'), asked: './test/helpers', url: url('test/helpers.js') },
    { pid: 1, from: url('server.js'), asked: 'eslint', url: url('node_modules/eslint/lib/api.js') },
    { pid: 1, from: url('server.js'), asked: 'left-pad', url: url('node_modules/left-pad/index.js') },
    { pid: 1, from: url('server.js'), asked: 'data:text/javascript,1', url: 'data:text/javascript,1' },
  ];
  assert.deepEqual(loadProblems(rows, { app, lock }), [
    "server.js asked for './test/helpers' from server.js and loaded test/helpers.js, which the portable folder does not ship",
    "server.js asked for 'data:text/javascript,1' from server.js and loaded data:text/javascript,1, which is no file of app",
    "server.js asked for 'eslint' from server.js and loaded node_modules/eslint/lib/api.js, of eslint, a development package the portable folder (npm ci --omit=dev) does not ship",
    "server.js asked for 'left-pad' from server.js and loaded node_modules/left-pad/index.js, of a package the lockfile does not list",
  ]);
  // debug's ask is answered by a package app ships: supports-color, a production package of major 8, the last CommonJS one.
  assert.equal(LOCK.packages['node_modules/supports-color'].dev, undefined, 'supports-color is a package the portable folder ships');
  assert.equal(LOCK.packages['node_modules/supports-color'].version.split('.')[0], '8', 'its major 8, the last that is CommonJS');
  assert.equal(JSON.parse(read('package.json')).dependencies['supports-color'].replace(/^\^/, '').split('.')[0], '8');
});

/**
 * Requires a package of app's writes out that app does not answer, each one never made while AGMessage runs, with why. The
 * runs above hold the switches: ws never asks for either.
 */
const NEVER_ASKED = [
  { asked: 'bufferutil', from: /(^|\/)node_modules\/ws\/lib\/buffer-util\.js$/, why: 'ws\'s native helper, asked for only without WS_NO_BUFFER_UTIL, which server.js sets before its first require and the watchdog gives its child' },
  { asked: 'utf-8-validate', from: /(^|\/)node_modules\/ws\/lib\/validation\.js$/, why: 'ws\'s native helper, asked for only without WS_NO_UTF_8_VALIDATE, set as WS_NO_BUFFER_UTIL is' },
];
/** Requires whose name is made at run time, which no reading of the source can judge, each with why it is never reached. */
const MADE_AT_RUN_TIME = [
  { file: 'node_modules/express/lib/view.js', why: 'a view engine, required by res.render, which AGMessage never calls and never sets up (held below: no render, engine or view engine in the server\'s sources)' },
];
/** The server-side scripts the portable folder ships, where the reading of what they ask for starts. */
function shippedScripts(root = ROOT) {
  return [...SHIPPED_FILES.filter((f) => f.endsWith('.js') && fs.existsSync(path.join(root, f))), ...filesUnder('lib', /\.c?js$/, { root }), ...filesUnder('verify', /\.c?js$/, { root })];
}
/**
 * What the shipped scripts ask for, read from their source and followed through every file it reaches as Node resolves
 * each ask from its asking file (the whole graph, a require in a function no run reaches included): rows in the resolve
 * hook's shape ({from, asked, url}, or {nowhere}: answered nowhere, so Node would walk on above app), and each require
 * whose name is made at run time ({made: file, line}). Read with ESLint's parser, a package's own inline configuration
 * ignored, so a require written in a comment is no ask.
 */
function staticAsks(entries, root = fs.realpathSync(ROOT)) {
  const rows = [{ pid: 0, start: 'the source' }];
  const made = [];
  const seen = new Set();
  const queue = entries.map((f) => path.join(root, f));
  for (const f of queue) seen.add(f);
  while (queue.length) {
    const file = queue.shift();
    if (!/\.[cm]?js$/.test(file)) continue;
    const asks = [];
    const rule = { create: () => ({
      CallExpression(n) {
        if (n.callee.type !== 'Identifier' || n.callee.name !== 'require' || n.arguments.length !== 1) return;
        const a = n.arguments[0];
        const name = a.type === 'Literal' && typeof a.value === 'string' ? a.value : a.type === 'TemplateLiteral' && !a.expressions.length ? a.quasis[0].value.cooked : null;
        if (name === null) made.push({ made: path.relative(root, file).split(path.sep).join('/'), line: n.loc.start.line }); else asks.push(name);
      },
      ImportDeclaration(n) { asks.push(n.source.value); },
      ImportExpression(n) { if (n.source.type === 'Literal') asks.push(n.source.value); else made.push({ made: path.relative(root, file).split(path.sep).join('/'), line: n.loc.start.line }); },
    }) };
    const src = readSource(file);
    const parsed = (file.endsWith('.mjs') ? ['module'] : ['commonjs', 'module']).some((sourceType) => {
      asks.length = 0;
      return !linter.verify(src, [{ languageOptions: { ecmaVersion: 'latest', sourceType }, linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' }, plugins: { asks: { rules: { read: rule } } }, rules: { 'asks/read': 'error' } }]).some((m) => m.fatal);
    });
    assert.ok(parsed, 'the reading cannot parse ' + file);
    const from = pathToFileURL(file).href;
    const resolve = createRequire(file).resolve;
    for (const asked of asks) {
      if (isBuiltin(asked)) { rows.push({ pid: 0, from, asked, url: 'node:' + asked.replace(/^node:/, '') }); continue; }
      let to;
      try { to = resolve(asked); } catch (e) { rows.push({ pid: 0, from, asked, nowhere: e.code || 'unknown' }); continue; }
      rows.push({ pid: 0, from, asked, url: isBuiltin(to) ? 'node:' + to : pathToFileURL(to).href });
      if (!isBuiltin(to) && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  return { rows, made, files: seen.size };
}

test('only what it ships: what the shipped scripts ask for, read from the source through every file it reaches, is answered in app, and each ask app leaves unanswered is one never made', { timeout: 60_000 }, () => {
  const entries = shippedScripts();
  for (const f of ['server.js', 'supervise.js', 'launch.js', 'lib/startup.js', 'verify/verify-audit.js']) assert.ok(entries.includes(f), 'the reading starts at ' + f);
  const { rows, made, files } = staticAsks(entries);
  assert.ok(files > 500, 'the whole graph was read (' + files + ' files)');
  const app = fs.realpathSync(ROOT);
  const rel = (url) => path.relative(app, fileURLToPath(url)).split(path.sep).join('/');
  const usedNever = new Set();
  const judged = rows.filter((r) => {
    const row = r.nowhere && NEVER_ASKED.find((x) => x.asked === r.asked && x.from.test(rel(r.from)));
    if (row) usedNever.add(row);
    return !row;
  });
  assert.deepEqual(loadProblems(judged), []);
  assert.deepEqual(NEVER_ASKED.filter((x) => !usedNever.has(x)).map((x) => x.asked), [], 'each row is an ask a package still makes');
  assert.deepEqual([...new Set(made.map((m) => m.made))].sort(), MADE_AT_RUN_TIME.map((x) => x.file).sort(), 'every require whose name is made at run time has its row, and every row its require (' + made.map((m) => m.made + ':' + m.line).join(', ') + ')');
  // express's view engine is required only by res.render: the server never renders, nor sets up an engine.
  for (const f of entries) assert.doesNotMatch(read(f), /\.render\(|['"]view engine['"]|\.engine\(/, f);
  // supports-color is debug's ask, answered by the package app ships; the SDK's zod helpers are no file the server reaches.
  assert.ok(rows.some((r) => r.asked === 'supports-color' && r.url && rel(r.url) === 'node_modules/supports-color/index.js'));
  assert.ok(!rows.some((r) => /helpers\/(beta\/)?zod\.js$/.test(r.from)), 'the SDK\'s zod helpers are never reached');

  // The reading itself, on a planted tree: an ask in code is followed, one in a comment is none, a name made at run time
  // is kept apart, and an ask nothing answers is named.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-asks-'));
  try {
    // (A relative file this test has: the module fence reads a require written in these strings as this file's own.)
    fs.writeFileSync(path.join(base, 'server.js'), "// require('ejs') in a comment is no ask\nconst a = require('./helpers');\nconst fs = require('node:fs');\nrequire(a.name);\n");
    fs.writeFileSync(path.join(base, 'helpers.js'), "/* eslint-env node */\nmodule.exports = { name: 'x', b: () => require('agm-planted-nowhere') };\n");
    const r = staticAsks(['server.js'], fs.realpathSync(base));
    assert.deepEqual(r.rows.slice(1).map((x) => [x.asked, x.url ? (x.url.startsWith('node:') ? x.url : path.basename(fileURLToPath(x.url))) : x.nowhere]), [['./helpers', 'helpers.js'], ['node:fs', 'node:fs'], ['agm-planted-nowhere', 'MODULE_NOT_FOUND']]);
    assert.deepEqual(r.made, [{ made: 'server.js', line: 4 }]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- only what it names by absolute path: the source
/** The child_process functions that start a program. `exec` and `execSync` run a shell, which the lint bans outright. */
const STARTS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']);
const CHILD_PROCESS = /^(?:node:)?child_process$/;
/** A full path: from the root, from a drive, or a network share's. */
const FULL_PATH = /^(?:\/|[A-Za-z]:\\|\\\\[^\\])/;
/** Ways to load code around require(), which the machine's commands never use. */
const AROUND_REQUIRE = new Set(['createRequire', 'dlopen', 'binding', 'linkedBinding', '_load']);
/** Every script of app that AGMessage writes: its top folder's, and every folder below but node_modules, the data and upload folders and the vendored libraries. */
function appScripts(root = ROOT) {
  const SCRIPT = /\.[cm]?js$/;
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && SCRIPT.test(e.name)) out.push(e.name);
    else if (e.isDirectory() && !['node_modules', 'data', 'uploads', 'coverage'].includes(e.name) && !e.name.startsWith('.')) out.push(...filesUnder(e.name, SCRIPT, { root, skip: e.name === 'public' ? ['vendor'] : [] }));
  }
  return out.sort();
}
/** How a script is parsed: a module by its name, a page's script as a script, the rest as CommonJS. */
const sourceTypeOf = (f) => (f.endsWith('.mjs') ? 'module' : f.startsWith('public/') || f === 'verify/page.js' ? 'script' : 'commonjs');

/**
 * What a source does with child_process and require, read by ESLint's parser with its scopes: {calls, handed, unfollowed,
 * requires, around}, each with its line.
 *  - `calls`: each call that starts a program, with its program as written (its first argument, spaces made one). child_process
 *    is followed as `require('child_process')` (or `node:`, or `X.require(…)`, as module.require and a Module's), `await
 *    import(…)` and an import declaration (its default, namespace or named functions), and through every name it is given
 *    (a declaration, a default, an assignment, a rest of a destructuring); a function that starts one is any of child_process's
 *    above read off it by name (`cp.spawn`, `cp['spawn']`) or destructured from it, any name one of these is given
 *    (a declaration, a default, an assignment, `this.x =`), and any name of its own that is one of theirs (a parameter called
 *    `spawn`).
 *  - `handed`: each place child_process itself or one of those functions is used as a value other than called, read by name
 *    or given a name (passed, returned, put in an object or on another's member, read by a name made at run time), whose
 *    calls happen where the fence does not read them ({kind: 'module' | 'function'}).
 *  - `unfollowed`: each place `child_process` is written where none of the ways above takes it (a require given another
 *    name, a re-export), so nothing reached through it goes unread.
 *  - `requires`: each require() with its literal, null when it is not one; `around`: an import, a way around require
 *    (createRequire, dlopen, binding, `_load`, any `.require`), and require itself read as a value (aliased, `.call`,
 *    `.resolve`), but for `require.main`. {unread} when it does not parse.
 */
function parseAsks(src, sourceType) {
  const found = { calls: [], handed: [], unfollowed: [], requires: [], around: [] };
  const rule = { create: (context) => ({ 'Program:exit': (program) => collect(context.sourceCode, program, found) }) };
  const messages = linter.verify(src, [{ languageOptions: { ecmaVersion: 'latest', sourceType }, plugins: { fence: { rules: { read: rule } } }, rules: { 'fence/read': 'error' } }]);
  const fatal = messages.find((m) => m.fatal);
  return fatal ? { unread: fatal.message + ' (line ' + fatal.line + ')' } : found;
}
function collect(sc, program, found) {
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    for (const k of sc.visitorKeys[n.type] || []) {
      const c = n[k];
      if (Array.isArray(c)) { for (const x of c) if (x) walk(x); } else if (c && typeof c.type === 'string') walk(c);
    }
  };
  walk(program);
  const refs = new Map();    // an identifier read or written → its reference (resolved: its variable, null for a global)
  const decls = new Map();   // an identifier that declares a name → its variable
  for (const s of sc.scopeManager.scopes) {
    for (const r of s.references) refs.set(r.identifier, r);
    for (const v of s.variables) for (const id of v.identifiers) decls.set(id, v);
  }
  const text = (n) => sc.getText(n).replace(/\s+/g, ' ');
  const line = (n) => n.loc.start.line;
  /** A string written out: a literal, or a template with nothing in it; null for anything else. */
  const written = (a) => (a && a.type === 'Literal' && typeof a.value === 'string' ? a.value : a && a.type === 'TemplateLiteral' && !a.expressions.length ? a.quasis[0].value.cooked : null);
  /** A member's name as written (`x.name`, `x['name']`), or null when it is made at run time. */
  const named = (n) => (n && n.type === 'MemberExpression' ? (!n.computed && n.property.type === 'Identifier' ? n.property.name : written(n.property)) : null);
  const isRequire = (n) => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require';
  /** require('child_process') (or node:, or a template), and X.require(…) of it (module.require, a Module's). */
  const isCpCall = (n) => n && n.type === 'CallExpression' && (isRequire(n) || named(n.callee) === 'require') && n.arguments.length === 1 && CHILD_PROCESS.test(written(n.arguments[0]) ?? '');
  const isCpImport = (n) => n && n.type === 'ImportExpression' && CHILD_PROCESS.test(written(n.source) ?? '');
  const modules = new Set();
  const fns = new Set();
  const thisNames = new Set();
  const variableOf = (id) => (refs.has(id) ? refs.get(id).resolved : decls.get(id) || null);
  /** child_process itself: required, awaited from an import, or a name it was given. */
  const isModule = (n) => !!n && (isCpCall(n) || (n.type === 'AwaitExpression' && isCpImport(n.argument)) || (n.type === 'Identifier' && modules.has(variableOf(n))));
  const isFn = (n) => {
    if (!n) return false;
    if (n.type === 'Identifier') { const v = variableOf(n); return !!v && fns.has(v); }
    const name = named(n);
    if (!name) return false;
    if (n.object.type === 'ThisExpression') return thisNames.has(name);
    return STARTS.has(name) && isModule(n.object);
  };
  /** A place a value may be given its name: a variable, or this.x (read back by name as a method). */
  const isThisName = (to) => to.type === 'MemberExpression' && to.object.type === 'ThisExpression' && named(to) !== null;
  /**
   * Each name child_process is given by `pattern` (`from`, the module as written): the module itself, or each of its
   * functions destructured by name, or the rest; a target the fence cannot follow (a member, an array, a key made at run
   * time) is kept in `cannot`, to be named as handed on.
   */
  const fromModule = (pattern, from, cannot) => {
    if (pattern.type === 'Identifier') { const v = variableOf(pattern); if (v) modules.add(v); return; }
    if (pattern.type !== 'ObjectPattern') { cannot.push({ line: line(pattern), value: text(from) }); return; }
    for (const p of pattern.properties) {
      if (p.type === 'RestElement') { fromModule(p.argument, from, cannot); continue; }
      const key = p.computed ? written(p.key) : p.key.name ?? p.key.value;
      if (key === null || key === undefined) { cannot.push({ line: line(p), value: text(from) }); continue; }
      if (!STARTS.has(key)) continue;
      const to = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
      if (to.type === 'Identifier' && variableOf(to)) fns.add(variableOf(to));
      else if (isThisName(to)) thisNames.add(named(to));
      else cannot.push({ line: line(p), value: text(from) });
    }
  };
  // A name of its own that is one of theirs is taken for one; an import's names are taken as they are declared; then each
  // name given the module or a function, until none is added.
  for (const s of sc.scopeManager.scopes) for (const v of s.variables) if (STARTS.has(v.name) && v.defs.length) fns.add(v);
  for (const n of nodes) {
    if (n.type !== 'ImportDeclaration' || !CHILD_PROCESS.test(written(n.source) ?? '')) continue;
    for (const sp of n.specifiers) {
      const v = decls.get(sp.local);
      if (!v) continue;
      if (sp.type === 'ImportSpecifier') { if (STARTS.has(sp.imported.name ?? sp.imported.value)) fns.add(v); } else modules.add(v);
    }
  }
  const cannot = [];
  for (let more = true; more;) {
    const before = modules.size + fns.size + thisNames.size;
    cannot.length = 0;
    for (const n of nodes) {
      const given = n.type === 'VariableDeclarator' ? [n.id, n.init] : n.type === 'AssignmentPattern' ? [n.left, n.right] : n.type === 'AssignmentExpression' && n.operator === '=' ? [n.left, n.right] : null;
      if (!given || !given[1]) continue;
      const [to, from] = given;
      if (isModule(from)) fromModule(to, from, cannot);
      else if (isFn(from)) {
        if (to.type === 'Identifier') { const v = variableOf(to); if (v) fns.add(v); } else if (isThisName(to)) thisNames.add(named(to));
      }
    }
    more = modules.size + fns.size + thisNames.size > before;
  }
  /** Where the module may stand: read by a name written out, given a name or destructured, or required for its loading alone. */
  const moduleKept = (n) => {
    const p = n.parent;
    if (p.type === 'MemberExpression' && p.object === n) return named(p) !== null;
    if (p.type === 'VariableDeclarator' && p.init === n) return true;
    if ((p.type === 'AssignmentPattern' || (p.type === 'AssignmentExpression' && p.operator === '=')) && p.right === n) return true;
    return p.type === 'ExpressionStatement' && isCpCall(n);
  };
  /** Where a function that starts a program may stand without being handed on: called, given a name (a variable or this.x), or replaced (a test's stand-in). */
  const kept = (n) => {
    const p = n.parent;
    if (p.type === 'CallExpression' && p.callee === n) return true;
    if (p.type === 'AssignmentExpression' && p.left === n) return true;
    const to = p.type === 'VariableDeclarator' && p.init === n ? p.id : (p.type === 'AssignmentPattern' || (p.type === 'AssignmentExpression' && p.operator === '=')) && p.right === n ? p.left : null;
    return !!to && (to.type === 'Identifier' || isThisName(to));
  };
  // Each pattern that took the module where the fence cannot follow it (a computed key, a target that is no name) is handed on.
  for (const c of cannot) found.handed.push({ ...c, kind: 'module' });
  for (const n of nodes) {
    if (n.type === 'CallExpression' && isFn(n.callee)) {
      found.calls.push({ line: line(n), program: n.arguments[0] ? text(n.arguments[0]) : '', written: written(n.arguments[0]), arg: n.arguments[0] });
      // Its options written in place: a program named in them (fork's execPath) is its program too, and a shell (cmd.exe
      // by ComSpec, else its bare name) is one it never names.
      for (const o of n.arguments.filter((a) => a.type === 'ObjectExpression')) {
        for (const p of o.properties) {
          const key = p.type === 'Property' ? (p.computed ? written(p.key) : p.key.name ?? p.key.value) : null;
          if (key === 'execPath') found.calls.push({ line: line(p), program: text(p.value), written: written(p.value) });
          if (key === 'shell' && !(p.value.type === 'Literal' && p.value.value === false)) found.calls.push({ line: line(p), shell: text(p.value) });
        }
      }
    }
    const read = n.type === 'Identifier' && refs.has(n) && refs.get(n).isRead();
    if ((read || n.type === 'MemberExpression') && isFn(n) && !kept(n)) found.handed.push({ line: line(n), value: text(n), kind: 'function' });
    if ((read || n.type === 'CallExpression' || n.type === 'AwaitExpression') && isModule(n) && !moduleKept(n)) found.handed.push({ line: line(n), value: text(n), kind: 'module' });
    if (isCpImport(n) && n.parent.type !== 'AwaitExpression') found.handed.push({ line: line(n), value: text(n), kind: 'module' });
    // child_process handed to a call the fence does not follow (a require by another name, createRequire's), or re-exported.
    const cp = written(n);
    const p = n.parent;
    if (cp !== null && CHILD_PROCESS.test(cp) && (((p.type === 'CallExpression' || p.type === 'NewExpression') && p.arguments.includes(n) && !isCpCall(p)) || (/^Export/.test(p.type) && p.source === n))) found.unfollowed.push({ line: line(n), where: text(p) });
    if (isRequire(n)) found.requires.push({ line: line(n), required: n.arguments.length === 1 ? written(n.arguments[0]) : null });
    if (n.type === 'ImportExpression' || n.type === 'ImportDeclaration') found.around.push({ line: line(n), what: 'an import' });
    const name = named(n);
    if (name !== null && (AROUND_REQUIRE.has(name) || name === 'require')) found.around.push({ line: line(n), what: name === 'require' ? text(n) : name });
    else if (n.type === 'Identifier' && AROUND_REQUIRE.has(n.name) && read) found.around.push({ line: line(n), what: n.name });
    // require itself as a value (aliased, .call, .resolve, .cache), but require.main, which loads nothing.
    if (n.type === 'Identifier' && n.name === 'require' && read && !(n.parent.type === 'CallExpression' && n.parent.callee === n) && named(n.parent) !== 'main') found.around.push({ line: line(n), what: 'require read as a value: ' + text(n.parent) });
  }
  // A program that is a parameter of a function of this file with a name, a function only ever called: its program is
  // named at each call of it, so each of those is judged as a call that starts one (`via`), in place of the call inside.
  const followed = new Set();
  for (const c of found.calls) {
    const v = c.arg && c.arg.type === 'Identifier' ? variableOf(c.arg) : null;
    const def = v && v.defs.length === 1 && v.defs[0].type === 'Parameter' ? v.defs[0] : null;
    if (!def) continue;
    const fn = def.node;
    const at = fn.params.indexOf(v.identifiers[0]);
    const nameId = fn.type === 'FunctionDeclaration' ? fn.id : fn.parent.type === 'VariableDeclarator' && fn.parent.init === fn && fn.parent.id.type === 'Identifier' ? fn.parent.id : null;
    const wrapper = nameId ? decls.get(nameId) : null;
    if (at < 0 || !wrapper || !wrapper.references.every((r) => !r.isRead() || (r.identifier.parent.type === 'CallExpression' && r.identifier.parent.callee === r.identifier))) continue;
    c.wrapped = wrapper.name;
    if (followed.has(wrapper)) continue;
    followed.add(wrapper);
    for (const r of wrapper.references) {
      if (!r.isRead()) continue;
      const call = r.identifier.parent;
      const a = call.arguments[at];
      found.calls.push({ line: line(call), program: a ? text(a) : '', written: written(a), via: wrapper.name, arg: a });
    }
  }
}

/**
 * Every call in app that starts a program by a name and not by process.execPath: its file, its program as written, and
 * where that program's full path is made. The fence holds each call to a row and each row to a call, so a new call, or a
 * program named another way, needs a row, with its reason; the places named are held below to give a full path or none.
 */
const RUNS = [
  { file: 'server.js', program: 'CLOUDFLARED', why: 'this copy\'s own cloudflared, in bin beside app: lib/startup.js cloudflaredFile, from the folder app is in (__dirname\'s), or none' },
  { file: 'supervise.js', program: 'CHILD', why: 'fork runs this node.exe (process.execPath) on server.js beside the watchdog, by its path from __dirname, or on AGM_CHILD (a test\'s stand-in server), which a start refuses unless it is a full path (lib/startup.js isFullPath: from a drive or a share on Windows, never one the current drive or folder completes)' },
  { file: 'launch.js', program: "path.win32.join(sys, 'reg.exe')", why: 'reg.exe in the System32 folder --sys names (the installer\'s {sys}), named from its drive: adminName runs nothing otherwise' },
  { file: 'launch.js', program: 'exe(name)', why: 'windowsHands: status\'s schtasks.exe and reg.exe, the requests\' whoami.exe and schtasks.exe /Run of the person\'s own control task, and Who may run\'s reg.exe and WindowsPowerShell\\v1.0\\powershell.exe, each in the System32 folder --sys names, by its absolute path (exe = path.win32.join(sys, name)); a --sys that is no drive path runs nothing' },
  { file: 'launch.js', program: 'execPath', why: 'serve: process.execPath (or a test\'s stand-in) runs the watchdog supervise.js beside launch.js, by its absolute path from __dirname; an elevated console\'s request runs machine.js control --elevated beside it the same way' },
  { file: 'launch.js', program: 'plan.file', why: 'open: openPlan\'s explorer.exe, in the Windows folder the System32 folder --sys names sits in (path.win32.dirname(sys)), named from its drive, or nothing is opened' },
  { file: 'machine.js', program: 'exe(name)', why: 'the machine commands run schtasks.exe, icacls.exe, reg.exe, whoami.exe and WindowsPowerShell\\v1.0\\powershell.exe in the System32 folder --sys names (the installer\'s {sys}), each by its absolute path (exe = path.win32.join(sys, name)), from that folder; hands refuses a --sys that is no drive path' },
  { file: 'machine.js', program: 'runnerNode', why: 'startRunner, for an elevated console\'s request: a copy of this node.exe (process.execPath, or a test\'s stand-in) made by copyFileSync into a new folder machine\\work\\upgrade-<id>\\ of the machine folder --machine names (a full path), run there on machine.js\'s own copy beside it, so nothing runs from {app} while an installer replaces it (a control task\'s runner is that same copy, as the action of a task of its own that schtasks.exe, by exe(name), registers and runs)' },
  { file: 'machine.js', program: 'installer', why: 'runInstaller: the runner\'s plan\'s installer, which planOf takes only where its control task put it: the file of its release\'s name in one folder of the plan\'s own machine\\staged\\, or the kept installer {app}\\installers\\AGMessage-Setup-<to>-unsigned.exe (the record\'s InstallDir)' },
  { file: 'lib/laptop.js', program: 'plan.file', why: 'readWindows runs windowsPlan\'s powershell.exe: lib/laptop.js powershellPlan, under a SystemRoot named from its drive, or no run' },
  { file: 'lib/power.js', program: 'p.file', why: 'the power request runs planOf()\'s powershell.exe: lib/laptop.js powershellPlan, as for "This laptop"' },
  { file: 'lib/startup.js', program: 'plan.file', why: 'openBrowser runs openerPlan\'s explorer.exe, under a SystemRoot named from its drive, or opens nothing' },
  { file: 'test/browser-smoke.js', program: 'exe', why: 'browserPath(): the first of AGM_BROWSER and the browsers\' install paths that is a file named by a full path' },
  { file: 'test/opener-preload.js', program: 'command', why: 'every program but explorer.exe handed on to the real spawn as the server named it: the server\'s calls are the rows above' },
  { file: 'test/startbat.test.js', program: 'cmd', why: 'cmd.exe in SystemRoot\'s System32 (C:\\Windows\'s when SystemRoot is unset), as a double-click runs a .bat' },
  { file: 'test/tunnel-preload.js', program: 'command', why: 'every program but cloudflared handed on to the real spawn as the server named it: the server\'s calls are the rows above' },
  { file: 'test/tunnel-preload.js', program: 'NOWHERE', why: 'a cloudflared that is not there (AGM_TEST_TUNNEL_GONE): a file in a folder under os.tmpdir() (a full path) that is never made' },
  { file: 'test/readings.test.js', program: "path.join(T.system32(), 'icacls.exe')", why: 'tools/readings-take.js system32(): the System32 folder of a SystemRoot named from its drive, or it throws' },
  { file: 'test/sleep.test.js', program: 'p.file', why: 'on Windows, the power request\'s own powershell.exe: lib/power.js plan, by its absolute path' },
  { file: 'test/laptop.test.js', program: 'plan.file', why: 'on Windows, "This laptop"\'s own powershell.exe started with nothing to do: lib/laptop.js windowsPlan, under a SystemRoot named from its drive (the test holds plan.run first)' },
];
/** Each place a function that starts a program is handed on as a value, and to whom: its calls are read there. */
const HANDED = [
  { file: 'server.js', value: 'spawn', why: 'to lib/startup.js openBrowser, whose parameter spawn the fence reads (lib/startup.js plan.file, above)' },
  { file: 'machine.js', value: 'run', why: 'the runner (childProcess.execFileSync, or a test\'s stand-in) to hands, directly and through holderPid, whose calls run(exe(name), …) the fence reads above (machine.js exe(name))' },
  { file: 'launch.js', value: 'run', why: 'open hands its runner (childProcess.execFileSync, or a test\'s stand-in) to statusOf, and each request and Who may run to windowsHands and adminName, whose calls run(exe(name), …) and run(path.win32.join(sys, \'reg.exe\'), …) the fence reads above' },
];
/** The machine's own commands: Node's built-ins only, so a bug or a planted file in app\node_modules never runs as SYSTEM or as the person at the PC. */
const MACHINE_FILES = ['launch.js', 'machine.js'];

/** What breaks "runs only what it names by absolute path" in `sources` (file → source), against `runs` and `handed`. Sorted. */
function runProblems(sources, runs = RUNS, handed = HANDED) {
  const problems = [];
  const usedRuns = new Set();
  const usedHanded = new Set();
  for (const [file, src] of sources) {
    const r = parseAsks(src, sourceTypeOf(file));
    if (r.unread) { problems.push(file + ': the fence cannot read it: ' + r.unread); continue; }
    for (const c of r.calls) {
      if (c.program === 'process.execPath' || c.wrapped) continue;
      const at = file + ':' + c.line + ' runs ' + (c.via ? '(through ' + c.via + ') ' : '');
      if ('shell' in c) problems.push(at + 'a shell (shell: ' + c.shell + '), a program it does not name: an argument array, and no shell');
      else if (!c.program) problems.push(at + 'a program it does not name');
      else if (c.written !== null) { if (!FULL_PATH.test(c.written)) problems.push(at + c.program + ', not a full path: a bare name is looked for in the current folder and on PATH first, and a relative one is the current folder\'s'); } else {
        const row = runs.find((x) => x.file === file && x.program === c.program);
        if (row) usedRuns.add(row);
        else problems.push(at + 'the program ' + c.program + ', which the register does not hold: name it by its absolute path, made where a row of RUNS says');
      }
    }
    for (const h of r.handed) {
      const row = handed.find((x) => x.file === file && x.value === h.value);
      if (row) usedHanded.add(row);
      else if (h.kind === 'module') problems.push(file + ':' + h.line + ' hands on ' + h.value + ', child_process itself, where the fence does not read what is called on it: read its functions here by name, or give HANDED a row naming whose calls they become');
      else problems.push(file + ':' + h.line + ' hands on ' + h.value + ', a function that starts a program, where the fence does not read its calls: call it here, or give HANDED a row naming whose calls it becomes');
    }
    for (const u of r.unfollowed) problems.push(file + ':' + u.line + ' names child_process where the fence does not follow it (' + u.where + '): require it, or import it, by its name');
  }
  for (const row of runs) if (sources.has(row.file) && !usedRuns.has(row)) problems.push(row.file + ': RUNS holds ' + row.program + ', which no call there runs any more: its row goes');
  for (const row of handed) if (sources.has(row.file) && !usedHanded.has(row)) problems.push(row.file + ': HANDED holds ' + row.value + ', which is no longer handed on there: its row goes');
  return problems.sort();
}
/** What breaks "the machine's commands require Node's built-ins only" in `sources` (file → source). Sorted. */
function machineProblems(sources) {
  const problems = [];
  for (const [file, src] of sources) {
    const r = parseAsks(src, 'commonjs');
    if (r.unread) { problems.push(file + ': the fence cannot read it: ' + r.unread); continue; }
    for (const q of r.requires) {
      if (q.required === null) problems.push(file + ':' + q.line + ' requires what it does not write out');
      else if (!q.required.startsWith('node:')) problems.push(file + ':' + q.line + " requires '" + q.required + "', not one of Node's built-ins by node:");
    }
    for (const a of r.around) problems.push(file + ':' + a.line + ' loads code around require (' + a.what + ')');
  }
  return problems.sort();
}

test('runs only what it names by absolute path: every call in app that starts a program names it by process.execPath or by a row with where its full path is made', () => {
  const files = appScripts();
  for (const f of ['server.js', 'supervise.js', 'launch.js', 'lib/startup.js', 'lib/laptop.js', 'lib/power.js', 'verify/verify-audit.js', 'public/app.js', 'test/helpers.js', 'test/browser-smoke.js', 'eslint-rules/no-unescaped-html.js']) assert.ok(files.includes(f), 'the fence reads ' + f);
  assert.ok(!files.some((f) => f.startsWith('node_modules/') || f.startsWith('public/vendor/')), 'and no package or vendored library');
  assert.deepEqual(runProblems(new Map(files.map((f) => [f, read(f)]))), []);
});

test('runs only what it names by absolute path: a planted bare name, a program the register does not hold, a function handed on and a row whose call has gone each fail it', () => {
  const check = (src, rows = [], handed = []) => runProblems(new Map([['lib/x.js', src]]), rows, handed);
  // The cloudflared fallback: a bare name returned, and the same name written in place.
  assert.deepEqual(check("const { spawn } = require('child_process');\nfunction bin() { return 'cloudflared'; }\nspawn(bin(), ['tunnel']);"), ['lib/x.js:3 runs the program bin(), which the register does not hold: name it by its absolute path, made where a row of RUNS says']);
  const bare = (line, name) => 'lib/x.js:' + line + ' runs ' + name + ", not a full path: a bare name is looked for in the current folder and on PATH first, and a relative one is the current folder's";
  assert.deepEqual(check("const { spawn } = require('child_process');\nspawn('cloudflared', ['tunnel']);\nspawn('bin/cloudflared.exe');\nspawn(`cloudflared`);"), [bare(2, "'cloudflared'"), bare(3, "'bin/cloudflared.exe'"), bare(4, '`cloudflared`')]);
  // However it is reached: the module by another name, node:, required in place, a name it is given, a default, this.
  assert.deepEqual(check("const cp = require('node:child_process');\nconst run = cp.execFile;\nrun('reg.exe', []);"), [bare(3, "'reg.exe'")]);
  assert.deepEqual(check("require('child_process').execFileSync(`whoami.exe`);"), [bare(1, '`whoami.exe`')]);
  assert.deepEqual(check("const childProcess = require('child_process');\nfunction a(plan, { run = childProcess.execFile } = {}) {\n  return run('powershell.exe', plan.args);\n}"), [bare(3, "'powershell.exe'")]);
  assert.deepEqual(check("const childProcess = require('child_process');\nclass P {\n  constructor({ spawn = childProcess.spawn } = {}) { this.go = spawn; }\n  start() { return this.go('schtasks.exe', []); }\n}"), [bare(4, "'schtasks.exe'")]);
  assert.deepEqual(check("const { fork: f, spawnSync } = require('child_process');\nf('server.js');\nspawnSync('icacls.exe');"), [bare(2, "'server.js'"), bare(3, "'icacls.exe'")]);
  assert.deepEqual(check("let s;\ns = require('child_process').spawn;\ns('netsh.exe');"), [bare(3, "'netsh.exe'")]);
  assert.deepEqual(check('function open(plan, spawn) { return spawn(plan.file, plan.args); }'), ['lib/x.js:1 runs the program plan.file, which the register does not hold: name it by its absolute path, made where a row of RUNS says'], 'a parameter called spawn is taken for one');
  assert.deepEqual(check("const { exec } = require('child_process');\nexec('dir');"), [bare(2, "'dir'")]);
  assert.deepEqual(check("const { spawn } = require('child_process');\nspawn();"), ['lib/x.js:2 runs a program it does not name']);
  // A wrapper whose program is its parameter: each of its calls is judged; one handed on as a value needs a row instead.
  assert.deepEqual(check("const { spawn } = require('child_process');\nconst run = (cmd, args) => spawn(cmd, args);\nfunction go(exe) { return run(exe, []); }\nrun('/usr/bin/unzip', ['-t']);\nrun('unzip', []);\ngo('sh');\nrun(process.execPath, []);"), [
    "lib/x.js:5 runs (through run) 'unzip', not a full path: a bare name is looked for in the current folder and on PATH first, and a relative one is the current folder's",
    "lib/x.js:6 runs (through go) 'sh', not a full path: a bare name is looked for in the current folder and on PATH first, and a relative one is the current folder's",
  ]);
  assert.deepEqual(check("const { spawn } = require('child_process');\nconst run = (cmd) => spawn(cmd);\n['x'].map(run);"), ['lib/x.js:2 runs the program cmd, which the register does not hold: name it by its absolute path, made where a row of RUNS says']);
  // Its options: fork's execPath is its program too, and a shell is a program it does not name.
  assert.deepEqual(check("const { fork, spawn } = require('child_process');\nfork('/opt/a/server.js', [], {\n  execPath: 'node' });\nspawn(process.execPath, [], { shell: true });\nspawn(process.execPath, [], { shell: false, execPath: process.execPath });"), [
    bare(3, "'node'"),
    "lib/x.js:4 runs a shell (shell: true), a program it does not name: an argument array, and no shell",
  ]);
  // The module followed through every name it is given: another variable, destructured from it by another name, its rest,
  // read by a name written in brackets, module.require, awaited from an import.
  assert.deepEqual(check("const cp = require('child_process');\nconst c2 = cp;\nc2.spawn('reg.exe');"), [bare(3, "'reg.exe'")]);
  assert.deepEqual(check("const cp = require('child_process');\nconst { spawn: go } = cp;\ngo('reg.exe');"), [bare(3, "'reg.exe'")]);
  assert.deepEqual(check("let cp;\ncp = module.require('node:child_process');\nconst { ...rest } = cp;\nrest.execFile('reg.exe');"), [bare(4, "'reg.exe'")]);
  assert.deepEqual(check("const cp = require('child_process');\ncp['spawn']('reg.exe');\ncp[`execFileSync`]('whoami.exe');"), [bare(2, "'reg.exe'"), bare(3, "'whoami.exe'")]);
  assert.deepEqual(check("async function f() {\n  const cp = await import('node:child_process');\n  cp.spawn('reg.exe');\n  (await import('child_process')).fork('server.js');\n}"), [bare(3, "'reg.exe'"), bare(4, "'server.js'")]);
  // An import declaration: its named functions (by another name too), its namespace, its default.
  const mjs = (src) => runProblems(new Map([['lib/x.mjs', src]]), [], []);
  const bareMjs = (ln, name) => bare(ln, name).replace('lib/x.js', 'lib/x.mjs');
  assert.deepEqual(mjs("import { spawn as go } from 'node:child_process';\ngo('reg.exe');"), [bareMjs(2, "'reg.exe'")]);
  assert.deepEqual(mjs("import * as cp from 'node:child_process';\ncp.execFile('reg.exe');"), [bareMjs(2, "'reg.exe'")]);
  assert.deepEqual(mjs("import cp from 'child_process';\ncp.spawnSync('icacls.exe');"), [bareMjs(2, "'icacls.exe'")]);
  // Handed on as a value: passed, or put in an object, where the fence does not read its calls.
  const handedOn = (line, value) => 'lib/x.js:' + line + ' hands on ' + value + ', a function that starts a program, where the fence does not read its calls: call it here, or give HANDED a row naming whose calls it becomes';
  assert.deepEqual(check("const { spawn } = require('child_process');\nopenBrowser(plan, spawn, say);"), [handedOn(2, 'spawn')]);
  assert.deepEqual(check("const cp = require('child_process');\nnew Power({ launch: cp.spawn });"), [handedOn(2, 'cp.spawn')]);
  assert.deepEqual(check("const { spawn } = require('child_process');\nmake({ spawn });"), [handedOn(2, 'spawn')]);
  assert.deepEqual(check("const cp = require('child_process');\ncp.spawn.call(null, 'x');"), [handedOn(2, 'cp.spawn')]);
  // Given to a member that is not this.x (an object's, the exports'), it is handed on too.
  assert.deepEqual(check("const { spawn } = require('child_process');\nconst o = {};\no.run = spawn;\no.run('reg.exe');"), [handedOn(3, 'spawn')]);
  assert.deepEqual(check("const cp = require('child_process');\nmodule.exports.run = cp.execFile;"), [handedOn(2, 'cp.execFile')]);
  // child_process itself handed on: held in an object, passed, put on the exports, destructured into a member or by a key
  // made at run time, read by a name made at run time, or an import not awaited.
  const handedModule = (line, value) => 'lib/x.js:' + line + ' hands on ' + value + ', child_process itself, where the fence does not read what is called on it: read its functions here by name, or give HANDED a row naming whose calls they become';
  assert.deepEqual(check("const deps = { cp: require('child_process') };\ndeps.cp.spawn('reg.exe');"), [handedModule(1, "require('child_process')")]);
  assert.deepEqual(check("const cp = require('child_process');\nmake(cp);"), [handedModule(2, 'cp')]);
  assert.deepEqual(check("const cp = require('child_process');\nmodule.exports = cp;"), [handedModule(2, 'cp')]);
  assert.deepEqual(check("const cp = require('child_process');\nconst o = {};\n({ spawn: o.go } = cp);\nconst { [name]: f } = cp;"), [handedModule(3, 'cp'), handedModule(4, 'cp')]);
  assert.deepEqual(check("const cp = require('child_process');\nconst k = 'spawn';\ncp[k]('reg.exe');"), [handedModule(3, 'cp')]);
  assert.deepEqual(check("import('node:child_process').then((cp) => cp.spawn('reg.exe'));"), [handedModule(1, "import('node:child_process')")]);
  // child_process named where none of these takes it: a require by another name or through .call, a re-export.
  const unfollowed = (file, line, where) => file + ':' + line + ' names child_process where the fence does not follow it (' + where + '): require it, or import it, by its name';
  assert.deepEqual(check("const r = require;\nr('child_process').spawn('reg.exe');"), [unfollowed('lib/x.js', 2, "r('child_process')")]);
  assert.deepEqual(check("require.call(null, 'node:child_process').execFile('reg.exe');"), [unfollowed('lib/x.js', 1, "require.call(null, 'node:child_process')")]);
  assert.deepEqual(mjs("export { spawn } from 'node:child_process';"), [unfollowed('lib/x.mjs', 1, "export { spawn } from 'node:child_process';")]);
  assert.deepEqual(check("const NAMES = ['fs', 'child_process'];"), [], 'a list of names is not a load');
  assert.deepEqual(check("const { spawn } = require('child_process');\nopenBrowser(plan, spawn, say);", [], [{ file: 'lib/x.js', value: 'spawn', why: 'read there' }]), [], 'a row says whose calls it becomes');
  // What passes: process.execPath; a program a row holds; a regular expression's exec, and anything else of that name not child_process's.
  assert.deepEqual(check("const { spawn, spawnSync, execFileSync } = require('child_process');\nspawn(process.execPath, ['server.js']);\nspawnSync(process.execPath, ['-e', '1']);\nexecFileSync('/bin/sh', ['-c', 'x']);\nspawn('C:\\\\Windows\\\\System32\\\\reg.exe');"), [], 'process.execPath, and a full path written out');
  // eslint-disable-next-line no-template-curly-in-string -- the planted source holds a template's ${…} on purpose
  assert.deepEqual(check("const { spawn } = require('child_process');\nspawn(`${dir}/cloudflared`);"), ['lib/x.js:2 runs the program `${dir}/cloudflared`, which the register does not hold: name it by its absolute path, made where a row of RUNS says'], 'a template with something in it is a program made elsewhere');
  assert.deepEqual(check("const { spawn } = require('child_process');\nspawn(EXE, []);", [{ file: 'lib/x.js', program: 'EXE', why: 'made absolute' }]), []);
  assert.deepEqual(check("const m = /x/.exec(s); const n = RE.exec(s); const o = { spawn: stub, fork: 1 }; o.exec = 2; queue.fork();"), []);
  // A row whose call has gone, and one whose handing has gone, each fail; a source that does not parse fails.
  assert.deepEqual(check('', [{ file: 'lib/x.js', program: 'EXE', why: 'gone' }], [{ file: 'lib/x.js', value: 'spawn', why: 'gone' }]), ['lib/x.js: HANDED holds spawn, which is no longer handed on there: its row goes', 'lib/x.js: RUNS holds EXE, which no call there runs any more: its row goes']);
  assert.match(check('spawn(').join(''), /^lib\/x\.js: the fence cannot read it: /);
});

test('runs only what it names by absolute path: the watchdog runs its server by a full path only, and a relative stand-in is refused before anything runs or is written', { timeout: 30_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-loads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A server.js in the folder the watchdog is started from, which would run in AGMessage's place by a relative name.
  fs.writeFileSync(path.join(base, 'server.js'), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'ran');\n");
  const data = path.join(base, 'data');
  const env = { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', AGM_TLS: '0', AGM_DATA_DIR: data, AGM_CHILD: 'server.js' };
  const w = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => { w.once('exit', resolve); });
  assert.equal(code, 3, out);
  assert.match(out, /AGMessage cannot start: AGM_CHILD \(server\.js\) is not a full path, and AGMessage runs its server only by its full path\./);
  assert.deepEqual([fs.existsSync(path.join(base, 'ran.txt')), fs.existsSync(data)], [false, false], 'nothing ran, and no data folder was made');
});

test('runs only what it names by absolute path: each place a program\'s path is made gives a full path, or runs nothing', () => {
  const winFull = (f) => /^(?:[A-Za-z]:\\|\\\\[^\\])/.test(f);
  // cloudflared: this copy's own, in bin beside app.
  assert.equal(startup.cloudflaredFile({ programDir: 'C:\\Tools\\AGMessage', platform: 'win32' }), 'C:\\Tools\\AGMessage\\bin\\cloudflared.exe');
  assert.equal(startup.cloudflaredFile({ programDir: '\\\\venue-nas\\shows\\AGMessage', platform: 'win32' }), '\\\\venue-nas\\shows\\AGMessage\\bin\\cloudflared.exe');
  assert.equal(startup.cloudflaredFile({ programDir: '/opt/agmessage', platform: 'linux' }), '/opt/agmessage/bin/cloudflared');
  for (const [programDir, platform] of [['AGMessage', 'win32'], ['\\AGMessage', 'win32'], ['C:AGMessage', 'win32'], ['', 'win32'], ['.', 'linux'], ['agmessage', 'linux'], [undefined, 'linux'], [null, 'win32']]) assert.equal(startup.cloudflaredFile({ programDir, platform }), null, String(programDir));
  assert.ok(path.isAbsolute(startup.cloudflaredFile({ programDir: path.dirname(ROOT) })), 'this checkout\'s, by the server\'s own call');
  // Without it, the words say why and the way back for how the copy runs: the portable folder extracted again, the installed node repaired.
  assert.equal(startup.noCloudflaredWords({ runs: 'portable', platform: 'win32' }), 'cloudflared not found in this copy (bin\\cloudflared.exe): re-extract the portable folder. AGMessage runs only its own cloudflared, never one from elsewhere on this PC.');
  assert.equal(startup.noCloudflaredWords({ runs: 'task', platform: 'win32' }), 'cloudflared not found in this copy (bin\\cloudflared.exe): repair AGMessage by running its installer again. AGMessage runs only its own cloudflared, never one from elsewhere on this PC.');
  assert.match(startup.noCloudflaredWords({ runs: 'portable', platform: 'linux' }), /^cloudflared not found in this copy \(bin\/cloudflared\): re-extract/);
  // The watchdog's server (AGM_CHILD, a test's stand-in) and every folder above: whole, or refused. On Windows a path the
  // current drive or folder completes is not whole: \server.js is the current drive's root, C:server.js that drive's folder.
  for (const [p, platform, whole] of [['C:\\AGMessage\\app\\server.js', 'win32', true], ['\\\\nas\\shows\\server.js', 'win32', true], ['\\server.js', 'win32', false], ['C:server.js', 'win32', false], ['server.js', 'win32', false], ['.\\server.js', 'win32', false], ['\\\\?\\C:\\server.js', 'win32', false], ['/opt/agmessage/app/server.js', 'linux', true], ['server.js', 'linux', false], ['./server.js', 'linux', false], [undefined, 'linux', false]]) assert.equal(startup.isFullPath(p, platform), whole, p + ' on ' + platform);
  // explorer.exe, powershell.exe (This laptop and the power request) and reg.exe: under a Windows folder named from its drive, or nothing run.
  const roots = ['C:\\Windows', 'D:\\WINDOWS ', 'Windows', '\\Windows', 'C:Windows', '', undefined];
  for (const SystemRoot of roots) {
    const env = { AGM_OPEN: '1', SystemRoot };
    const plans = [startup.openerPlan(env, { restarts: 0, port: 3023, platform: 'win32' }), laptop.windowsPlan(env, { platform: 'win32', node: 'C:\\AGMessage\\node\\node.exe' }), power.plan(env, { platform: 'win32' })];
    const good = typeof SystemRoot === 'string' && /^[A-Za-z]:\\/.test(SystemRoot.trim());
    assert.deepEqual(plans.map((p) => (p.open || p.run ? winFull(p.file) : null)), good ? [true, true, true] : [null, null, null], String(SystemRoot));
    // The options they hand to the call, which the source fence cannot read there: no shell, and no program of their own.
    for (const p of plans) assert.ok(!p.options || (!('shell' in p.options) && !('execPath' in p.options)), JSON.stringify(p.options));
  }
  for (const platform of ['linux', 'darwin']) assert.deepEqual([startup.openerPlan({ AGM_OPEN: '1', SystemRoot: 'C:\\Windows' }, { restarts: 0, port: 3023, platform }).open, laptop.windowsPlan({ SystemRoot: 'C:\\Windows' }, { platform }).run, power.plan({ SystemRoot: 'C:\\Windows' }, { platform }).run], [false, false, false], platform);
  for (const sys of ['C:\\Windows\\System32', 'Windows\\System32', '\\Windows\\System32', '']) {
    const ran = [];
    launch.adminName({ sys, platform: 'win32', run: (file) => { ran.push(file); return ''; } });
    assert.deepEqual(ran, sys.startsWith('C:') ? ['C:\\Windows\\System32\\reg.exe'] : [], sys);
  }
});

/** What app runs as a process of its own from the machine's commands, as an administrator or SYSTEM: its script and why. */
const ELEVATED_CHILDREN = Object.freeze([
  { script: 'lib/importfacts.js', why: 'machine.js import --step take reads the installed node\'s facts with it, elevated (launch.js export runs it as the person)' },
]);

test('what the machine\'s commands run of app as a process of its own, elevated, loads only app\\lib, app\\verify and Node\'s built-ins, and asks for nothing app cannot answer', { timeout: 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-loads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planted = plant(base);
  const resolves = path.join(base, 'resolves.jsonl');
  // A data folder and a key folder with a machine key in it, so the reader walks its keyed paths too.
  const data = path.join(base, 'data');
  const keys = path.join(base, 'keys');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, 'machine.key'), require('crypto').randomBytes(32).toString('base64'));
  const env = { ...process.env, NODE_OPTIONS: hooked(), NODE_PATH: planted.dir, AGM_TEST_RESOLVES: resolves };
  const app = fs.realpathSync(ROOT);
  // Each one a machine command runs is named here, by the file the command names it by.
  for (const f of ['machine.js', 'launch.js']) assert.ok(read(f).includes("'lib', 'importfacts.js'"), f + ' runs lib/importfacts.js');
  for (const { script } of ELEVATED_CHILDREN) {
    const child = spawn(process.execPath, [path.join(ROOT, ...script.split('/')), '--data', data, '--keys', keys], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => { child.once('exit', resolve); });
    assert.equal(code, 0, script + ': ' + out);
    assert.ok(JSON.parse(out.trim().split(/\r?\n/).pop()).facts, script + ' answered its facts');
    const rows = rowsOf(resolves).filter((r) => r.pid === child.pid);
    assert.deepEqual(loadProblems(rows), [], script);
    const beyond = rows.filter((r) => !('start' in r)).filter((r) => {
      if (r.nowhere) return true;
      if (r.url.startsWith('node:')) return false;
      const rel = path.relative(app, fileURLToPath(r.url)).split(path.sep).join('/');
      return !(rel.startsWith('lib/') || rel.startsWith('verify/'));
    }).map((r) => r.asked + ' from ' + r.from);
    assert.deepEqual(beyond, [], script + ' loads nothing but app\\lib, app\\verify and Node\'s built-ins, so nothing in app\\node_modules or above app runs elevated');
    assert.ok(rows.filter((r) => r.url && !r.url.startsWith('node:')).length >= 10, script + '\'s graph went through the hook');
  }
  assert.deepEqual(planted.loaded(), [], 'no planted module ran');
});

test('the machine\'s own commands require Node\'s built-ins only, by node:, and load no code around require', () => {
  const present = MACHINE_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
  assert.ok(present.includes('launch.js'), 'launch.js is read (machine.js too, once it is made)');
  assert.deepEqual(machineProblems(new Map(present.map((f) => [f, read(f)]))), []);
  assert.ok(parseAsks(read('launch.js'), 'commonjs').requires.length >= 3, 'its requires are read');
  // Planted: a relative file, a package, a built-in without node:, a computed name, an import, createRequire, a native addon,
  // and require reached around its plain call.
  const check = (src) => machineProblems(new Map([['machine.js', src]]));
  // (A relative file this test has: the module fence reads a require written in these strings as this file's own.)
  assert.deepEqual(check("const fs = require('node:fs');\nconst h = require('./helpers');\nconst ws = require('ws');\nconst os = require('os');\nconst x = require(name);"), [
    "machine.js:2 requires './helpers', not one of Node's built-ins by node:",
    "machine.js:3 requires 'ws', not one of Node's built-ins by node:",
    "machine.js:4 requires 'os', not one of Node's built-ins by node:",
    'machine.js:5 requires what it does not write out',
  ]);
  assert.deepEqual(check("const m = require('node:module');\nconst r = m.createRequire(__filename);\nimport('./x.mjs');\nprocess.dlopen(mod, file);"), [
    'machine.js:2 loads code around require (createRequire)',
    'machine.js:3 loads code around require (an import)',
    'machine.js:4 loads code around require (dlopen)',
  ]);
  // require reached some other way: module.require, a Module's, require given another name, through .call, .resolve.
  assert.deepEqual(check("const ws = module.require('ws');\nconst { Module } = require('node:module');\nnew Module().require('ws');"), [
    'machine.js:1 loads code around require (module.require)',
    'machine.js:3 loads code around require (new Module().require)',
  ]);
  assert.deepEqual(check("const r = require;\nconst ws = r('ws');\nconst x = require.call(null, 'ws');\nconst f = require.resolve('ws');"), [
    'machine.js:1 loads code around require (require read as a value: r = require)',
    'machine.js:3 loads code around require (require read as a value: require.call)',
    'machine.js:4 loads code around require (require read as a value: require.resolve)',
  ]);
  assert.deepEqual(check("const fs = require('node:fs');\nconst cp = require('node:child_process');\nif (require.main === module) fs.statSync('.');"), [], 'require.main loads nothing');
});
