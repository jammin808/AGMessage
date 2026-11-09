'use strict';
// What the console says reaches the admin page, a bounded log and "This laptop" (the plan's Part 6, unit U3): the
// watchdog keeps the console in data/logs/server.log, bounded, rotated and never with the token, and its line for a
// server that could not start carries the server's own words; the admin page's answer gains the LAN addresses and the
// port, and why HTTPS is off; a certificate due for renewal waits for a start with a network address; and "This laptop"
// gives each fact with where it was read, Windows' facts read by one powershell.exe within its time (stood in for here by
// test/windows-preload.js) or unknown with why. This laptop's network adapters are stood in for by
// test/network-preload.js, so no test depends on the machine it runs on.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const h = require('./helpers');
const { readSource } = h;
const { ServerLog, Lines, redact, HIDDEN } = require('../lib/serverlog');
const laptop = require('../lib/laptop');
const startup = require('../lib/startup');
const machine = require('../machine');
const tlsmod = require('../lib/tls');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await h.wait(50); } return false; };
/** NODE_OPTIONS that preload these test files, beside what the run already has. */
const preload = (...names) => [process.env.NODE_OPTIONS, ...names.map((n) => '--require "' + path.join(__dirname, n).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
/** The log's lines without their times: what the console said. */
const said = (text) => text.split('\n').filter(Boolean).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
/** The log's lines that say something. */
const spoken = (text) => said(text).filter((l) => l.trim());

/** The watchdog on folders of its own: {p, out(), done, stop()}. */
async function watchdog(env) {
  const all = { ...process.env, PORT: String(await h.freePort()), HOST: '127.0.0.1', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', AGM_BACKOFF: '0.05', ...env };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  const p = spawn(process.execPath, [path.join(ROOT, 'supervise.js')], { env: all, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => { p.once('exit', (code) => resolve(code)); });
  const stop = async () => { if (p.exitCode === null && p.signalCode === null) { try { p.send({ t: 'stop' }); } catch { p.kill('SIGKILL'); } } return done; };
  return { p, out: () => out, done, stop, port: Number(all.PORT) };
}
const folders = (base) => ({ AGM_DATA_DIR: path.join(base, 'data'), AGM_UPLOAD_DIR: path.join(base, 'uploads'), AGM_KEY_DIR: path.join(base, 'keys') });
/** The admin page's answer to its settings, as the laptop's token signs in to it. */
async function adminAnswer(base) {
  const cookie = (await h.api(base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const s = await h.connect(base, cookie);
  return { s, cookie, settings: () => h.answer(s, 'admin:settings', null) };
}
const row = (l, id) => l.facts.find((f) => f.id === id);
const rowsOf = (l, ids) => Object.fromEntries(ids.map((id) => { const r = row(l, id); return [id, r ? [r.words, r.mark] : null]; }));

// ---------------------------------------------------------------- the log (pure)
test('the log reads its stream in whole lines, cut at its bound, and writes the token as never there', () => {
  const got = [];
  const lines = new Lines((l) => got.push(l), { max: 4 });
  lines.push('ab');
  lines.push('c\nde\r\nf');
  assert.deepEqual(got, ['abc', 'de\r'], 'a line given only once whole; a \\r before the newline kept');
  lines.end();
  assert.deepEqual(got.splice(0), ['abc', 'de\r', 'f'], 'what is left goes at the end');
  lines.push('abcdefghij\n');
  assert.deepEqual(got.splice(0), ['abcd', 'efgh', 'ij'], 'a line past the bound goes as several');
  lines.push('abcdefgh');
  assert.deepEqual(got.splice(0), ['abcd', 'efgh'], 'and goes at once, never held in memory past the bound');
  lines.end();
  assert.deepEqual(got, [], 'nothing left');
  const token = 'a1b2c3d4e5f60718';
  assert.equal(redact('Token: ' + token + ' / ' + token.toUpperCase() + ' / ' + token, [token]), 'Token: ' + HIDDEN + ' / ' + HIDDEN + ' / ' + HIDDEN);
  assert.equal(redact('short abc', ['abc', undefined, 7]), 'short abc', 'a secret under 8 characters, or not a string, is not one');
  // A secret across the cut, in one line or arriving in two chunks with no newline yet, is never written in two halves.
  const pieces = [];
  const cut = new Lines((l) => pieces.push(l), { max: 64, secrets: [token] });
  cut.push('x'.repeat(64 - 8) + token + ' tail\n');
  for (let at = 1; at < token.length; at++) {
    cut.push('y'.repeat(64 - at) + token.slice(0, at));
    cut.push(token.slice(at) + ' and on\n');
  }
  cut.push('q'.repeat(100) + token.slice(0, 5));   // past the bound with part of it: cut where none of it can be
  cut.push(token.slice(5) + '\n');
  cut.push('z'.repeat(200) + token.toUpperCase());
  cut.push('w'.repeat(70));
  cut.end();
  assert.ok(pieces.every((l) => l.length <= 64), 'each piece within its bound');
  const all = pieces.join('');
  assert.ok(!all.includes(token) && !all.toLowerCase().includes(token), 'no piece, and no two pieces joined, hold the token');
  assert.equal(all.split(HIDDEN).length - 1, 1 + (token.length - 1) + 1 + 1, 'each one written as never there');
  assert.equal(pieces[0] + pieces[1], 'x'.repeat(56) + HIDDEN + ' tail', 'a whole line: taken out before it is cut');
});

test('the log stays under its bound: past it the file becomes server.1.log and a new one begins; one that cannot be written says so once and loses no console line', () => {
  const dir = tmp('agm-log-');
  const file = path.join(dir, 'logs', 'server.log');
  const failed = [];
  const at = new Date('2026-11-02T13:00:00.000Z');
  const log = new ServerLog(file, { maxBytes: 300, secrets: ['secrettoken12345'], onFail: (w) => failed.push(w), now: () => at });
  for (let i = 0; i < 40; i++) log.line('line ' + String(i).padStart(2, '0') + ' of the console');
  const now = fs.readFileSync(file, 'utf8');
  const before = fs.readFileSync(path.join(dir, 'logs', 'server.1.log'), 'utf8');
  assert.ok(Buffer.byteLength(now) <= 300 && Buffer.byteLength(before) <= 300, 'each file under its bound: ' + [now.length, before.length]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['server.1.log', 'server.log'], 'two files at most');
  assert.equal(said(now).pop(), 'line 39 of the console', 'the newest line is in server.log');
  assert.equal(said(before).pop(), said(now).length ? 'line ' + String(39 - said(now).length).padStart(2, '0') + ' of the console' : '', 'and the ones before it in server.1.log, in order');
  assert.ok(now.startsWith('2026-11-02T13:00:00.000Z line '), 'each line with its time');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'read by this account alone');
  log.line('Token: secrettoken12345');
  assert.ok(!read(file).includes('secrettoken12345') && read(file).includes('Token: ' + HIDDEN), 'the token, searched for by value, is never written');
  assert.equal(log.written, 41);
  // A folder in the log's place cannot be written: said once, each line tried again, and the first that lands says so.
  const other = path.join(dir, 'held');
  fs.writeFileSync(other, '');
  const held = new ServerLog(path.join(other, 'server.log'), { onFail: (w) => failed.push(w), now: () => at });
  held.line('one');
  held.line('two');
  assert.equal(failed.length, 1, 'said once: ' + failed.join(' | '));
  assert.match(failed[0], /held[\\/]server\.log could not be written \((ENOTDIR|EEXIST)\): the console keeps its lines, and each is tried here again$/);
  fs.rmSync(other);
  held.line('three');
  assert.deepEqual(said(read(path.join(other, 'server.log'))), ['three', '[log] 2 lines were not written here before this one: the console had them']);
  assert.deepEqual([held.written, held.lost, held.failed], [1, 0, '']);
});

// ---------------------------------------------------------------- the watchdog keeps the console
test('the watchdog keeps its server\'s console in data/logs/server.log, bounded and rotated, and never the token, which only its console shows', async (t) => {
  const base = tmp('agm-tee-');
  const f = folders(base);
  // A console window (test/tty-preload.js), where the Token line holds the token, and a bound the banner passes.
  const w = await watchdog({ ...f, AGM_LOG_MAX: '800', NODE_OPTIONS: preload('tty-preload.js') });
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:'), 20000), 'it serves:\n' + w.out());
  const logs = path.join(f.AGM_DATA_DIR, 'logs');
  assert.ok(await until(() => said(read(path.join(logs, 'server.log'))).some((l) => l.startsWith('  Uploads:'))), 'the banner reaches the log');
  assert.equal(await w.stop(), 0);
  const now = read(path.join(logs, 'server.log'));
  const older = read(path.join(logs, 'server.1.log'));
  assert.ok(Buffer.byteLength(now) <= 800 && Buffer.byteLength(older) <= 800 && older.length > 0, 'rotated at its bound: ' + [now.length, older.length]);
  const kept = said(older + now);
  for (const line of [/^ {2}AGMessage \S+ is running$/, /^ {4}URL: {3}http:\/\/localhost:\d+\/admin$/, /^ {2}Audit log: {3}keyed/, /^ {2}Saving…$/, /^ {2}Saved: the audit log, every store and /]) assert.ok(kept.some((l) => line.test(l)), line + ' kept:\n' + kept.join('\n'));
  // The console has the Token line with the token, once; the log has neither, nor the line that marks its place.
  assert.equal(w.out().split('\n').filter((l) => l === '    Token: ' + h.TOKEN).length, 1, 'the console shows the token where a person sits');
  for (const file of fs.readdirSync(logs)) {
    const text = read(path.join(logs, file));
    assert.ok(!text.includes(h.TOKEN) && !text.includes('Token:') && !text.includes('\u0000'), file + ' holds no token, no Token line and no marker');
  }
  // Every line the log holds was said on the console, in its order.
  const console = w.out().split('\n');
  let at = 0;
  for (const l of kept.filter((x) => x.trim())) { at = console.indexOf(l, at); assert.ok(at >= 0, 'said on the console too: ' + JSON.stringify(l)); }
});

test('a console that goes away ends no watchdog: its server still stops as asked, saved, and server.log keeps the lines', async (t) => {
  const base = tmp('agm-gone-');
  const f = folders(base);
  const w = await watchdog(f);
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:'), 20000), 'it serves:\n' + w.out());
  // The window closed: nothing reads its output any more, and every line written there now fails.
  w.p.stdout.destroy();
  w.p.stderr.destroy();
  w.p.send({ t: 'stop' });
  assert.equal(await w.done, 0, 'stopped as asked, not ended by its console');
  const stopLines = spoken(read(path.join(f.AGM_DATA_DIR, 'logs', 'server.log')));
  assert.ok(stopLines.includes('  Saving…') && stopLines.some((l) => l.startsWith('  Saved: the audit log, every store and ')), 'the stop\'s lines are kept, the one that says it saved last:\n' + stopLines.join('\n'));
});

test('a log that cannot be written stops nothing: the watchdog says so once, on its console, and its server serves', async (t) => {
  const base = tmp('agm-nolog-');
  const f = folders(base);
  fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.AGM_DATA_DIR, 'logs'), '');   // a file where the log's folder goes
  const w = await watchdog(f);
  t.after(() => w.stop());
  assert.ok(await until(() => w.out().includes('\n  Uploads:'), 20000), 'it serves:\n' + w.out());
  const said = w.out().split('\n').filter((l) => l.includes('server.log could not be written'));
  assert.equal(said.length, 1, 'said once:\n' + w.out());
  assert.match(said[0], /^ {2}\[watchdog\] .+[\\/]logs[\\/]server\.log could not be written \((ENOTDIR|EEXIST)\): the console keeps its lines, and each is tried here again$/);
  assert.equal(await w.stop(), 0);
});

test('a server that cannot start as configured: the watchdog\'s line, in watchdog.log, server.log and on its console, carries the server\'s own words', async () => {
  const base = tmp('agm-said-');
  const file = path.join(base, 'a-file');
  fs.writeFileSync(file, '');   // a folder below a file can never be made
  const f = { ...folders(base), AGM_UPLOAD_DIR: path.join(file, 'uploads') };
  const w = await watchdog(f);
  assert.equal(await w.done, 3);
  const words = 'the uploads folder ' + path.join(file, 'uploads') + ' cannot be made (ENOTDIR). Choose a folder this Windows account can write to (AGM_UPLOAD_DIR), or fix that one\'s permissions.';
  const line = 'server stopped: cannot start as configured (code 3): ' + words;
  assert.ok(read(path.join(f.AGM_DATA_DIR, 'watchdog.log')).endsWith(' ' + line + '\n'), 'watchdog.log: ' + read(path.join(f.AGM_DATA_DIR, 'watchdog.log')));
  const kept = spoken(read(path.join(f.AGM_DATA_DIR, 'logs', 'server.log')));
  assert.deepEqual(kept.slice(-2), ['  AGMessage cannot start: ' + words, '  [watchdog] ' + line], 'server.log: the server\'s words, then the watchdog\'s line');
  assert.ok(w.out().includes('  [watchdog] ' + line), w.out());
});

test('the installed node\'s port held: each try is in server.log with the holder\'s words, and the start that serves hands them to "This laptop"', async (t) => {
  const port = await h.freePort();
  const squatter = net.createServer((c) => c.destroy());
  await new Promise((resolve) => { squatter.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { squatter.close(() => resolve()); }));
  const base = tmp('agm-held-');
  const f = { ...folders(base), AGM_TOKEN_DIR: path.join(base, 'token') };
  fs.mkdirSync(f.AGM_TOKEN_DIR);
  const w = await watchdog({ ...f, AGM_RUNS: 'task', PORT: String(port), ADMIN_TOKEN: undefined });
  t.after(() => w.stop());
  const holder = `Another program is using port ${port}. AGMessage tries again; AGMessage status names the program's process.`;
  const log = () => said(read(path.join(f.AGM_DATA_DIR, 'logs', 'server.log')));
  // Each try's own words; the watchdog's line for a held try as often as watchdog.log takes it (the first of a run), and
  // no blank line: a port held for days rotates through the log at a bounded pace.
  assert.ok(await until(() => log().filter((l) => l === '  ' + holder).length >= 3, 20000), 'each try said with its words:\n' + log().join('\n'));
  const watchdogs = log().filter((l) => l.startsWith('  [watchdog] server could not take its port or data folder, which another program holds (code 75): ' + holder));
  assert.equal(watchdogs.length, 1, 'the watchdog\'s line for the first try alone:\n' + log().join('\n'));
  assert.ok(log().every((l) => l.trim()), 'no blank line kept');
  squatter.close();
  assert.ok(await until(() => /AGMessage \S+ is running/.test(w.out()), 15000), 'it serves once the port is free:\n' + w.out());
  assert.ok(await until(() => /^[0-9a-f]{16}$/.test(read(path.join(f.AGM_TOKEN_DIR, 'admin-token')))), 'its token written');
  const token = read(path.join(f.AGM_TOKEN_DIR, 'admin-token'));
  const cookie = (await h.api(`http://127.0.0.1:${port}`, 'POST', '/api/admin/login', { token })).cookie;
  const s = await h.connect(`http://127.0.0.1:${port}`, cookie);
  t.after(() => s.close());
  const before = row((await h.answer(s, 'admin:settings', null)).laptop, 'before');
  assert.equal(before.mark, 'warn');
  assert.equal(before.from, 'the watchdog');
  const lead = 'server could not take its port or data folder, which another program holds (code 75): ' + holder;
  const rest = before.words.slice(lead.length);
  assert.ok(before.words.startsWith(lead) && (rest === '' || /^ \(try \d+\)$/.test(rest)), before.words);
});

test('the installed node\'s start refused as configured: the next start, from another watchdog, says why on "This laptop" and the admin page\'s health, once', async (t) => {
  const base = tmp('agm-refused-');
  const f = { ...folders(base), AGM_TOKEN_DIR: path.join(base, 'token') };
  fs.mkdirSync(f.AGM_TOKEN_DIR);
  fs.mkdirSync(f.AGM_DATA_DIR, { recursive: true });
  const rooms = path.join(f.AGM_DATA_DIR, 'rooms');
  fs.writeFileSync(rooms, '');   // a file where the rooms folder is: it cannot be listed
  const task = { ...f, AGM_RUNS: 'task', ADMIN_TOKEN: undefined };
  const refused = await watchdog(task);
  assert.equal(await refused.done, 3, refused.out());
  const words = 'the rooms folder ' + rooms + ' cannot be read (ENOTDIR). Choose a data folder this Windows account can read and write (AGM_DATA_DIR), or fix that one\'s permissions.';
  const kept = JSON.parse(read(path.join(f.AGM_DATA_DIR, 'watchdog.json')));
  assert.deepEqual([typeof kept.at, kept.reason, kept.refused], ['number', 'cannot start as configured (code 3): ' + words, true], 'recorded for the next start');
  // Fixed, and started again by the next boot or a person: a watchdog of its own, which knows nothing of the one before.
  fs.rmSync(rooms);
  const w = await watchdog(task);
  t.after(() => w.stop());
  assert.ok(await until(() => /AGMessage \S+ is running/.test(w.out()) && /^[0-9a-f]{16}$/.test(read(path.join(f.AGM_TOKEN_DIR, 'admin-token'))), 20000), w.out());
  const port = w.port;
  // The installed node says how it runs on the host's health, its program folder named: what a copy refused at the port
  // and machine.js read, with no token, to choose their words (run 115's life cycle found it missing).
  const programDir = path.dirname(ROOT);
  const local = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.deepEqual(local.install, { runs: 'task', installed: true, dir: programDir, light: 'green', words: 'installed in ' + programDir + ', run by its server task' });
  assert.equal((await machine.healthOf(port)).runs, 'task', 'machine.js reads the installed node as the task');
  assert.equal((await startup.readPortHolder(port)).runs, 'task', 'and so does a copy refused at the port');
  const cookie = (await h.api(`http://127.0.0.1:${port}`, 'POST', '/api/admin/login', { token: read(path.join(f.AGM_TOKEN_DIR, 'admin-token')) })).cookie;
  const s = await h.connect(`http://127.0.0.1:${port}`, cookie);
  t.after(() => s.close());
  const settings = await h.answer(s, 'admin:settings', null);
  const before = row(settings.laptop, 'before');
  const at = new Date(kept.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  assert.deepEqual([before.words, before.mark, before.from], ['the start at ' + at + ' was refused: cannot start as configured (code 3): ' + words, 'warn', 'the watchdog']);
  assert.deepEqual(settings.health.watchdog, { at: kept.at, reason: kept.reason, refused: true });
  assert.ok(!fs.existsSync(path.join(f.AGM_DATA_DIR, 'watchdog.json')) && fs.existsSync(path.join(f.AGM_DATA_DIR, 'watchdog.seen.json')), 'marked seen once it serves: the start after says nothing of it');
});

test('a give-up the watchdog recorded is "Before this start" for the start after it; a start with no record has no such row', async (t) => {
  const dataDir = tmp('agm-gaveup-');
  const at = Date.UTC(2026, 10, 2, 13, 5);
  fs.writeFileSync(path.join(dataDir, 'watchdog.json'), JSON.stringify({ at, reason: 'crashed 7 times in 10 minutes' }));
  const srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  const s = await a.settings();
  assert.deepEqual(rowsOf(s.laptop, ['before']), { before: ['the watchdog gave up at 2026-11-02 13:05 UTC: crashed 7 times in 10 minutes', 'warn'] });
  assert.deepEqual(s.health.watchdog, { at, reason: 'crashed 7 times in 10 minutes', refused: false });
  await h.stopServer(srv.child);
  const next = await h.restartServer(srv, { AGM_DATA_DIR: dataDir });
  t.after(() => h.stopServer(next.child));
  const b = await adminAnswer(next.base);
  t.after(() => b.s.close());
  const later = await b.settings();
  assert.deepEqual([row(later.laptop, 'before'), later.health.watchdog], [undefined, null], 'shown once');
});

// The real script, on Windows: its answer is the script's, each part read or refused by Windows with Windows' words, and
// never one AGMessage could not read. On a CI runner, where AGMessage is not installed, the task and the install record
// read as missing.
test('on Windows, the script itself answers in its own shape: each part read, or refused with Windows\' reason', { skip: process.platform !== 'win32' && 'the script runs on Windows only' }, async (t) => {
  const plan = laptop.windowsPlan(process.env);
  assert.equal(plan.run, true, plan.why);
  // When each part's line came, from the start: what a read ended at its time had said, and which part held it.
  const began = Date.now();
  const came = [];
  const heard = (child) => {
    let rest = '';
    child.stdout.on('data', (d) => {
      rest += d;
      for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
        const line = rest.slice(0, at).trim();
        rest = rest.slice(at + 1);
        if (line) came.push((/^\{"(\w+)"/.exec(line) || ['', '?'])[1] + ' ' + (Date.now() - began) + ' ms');
      }
    });
  };
  const answer = await laptop.readWindows(plan, { timeoutMs: 60000, started: heard });
  t.diagnostic('the read took ' + (Date.now() - began) + ' ms: ' + came.join(', '));
  // A reading beside it: how long powershell.exe takes to start and end with nothing to do, in the plan's environment and
  // in this process's (its own module path kept), twice each.
  const bare = (env) => new Promise((resolve) => {
    const at = Date.now();
    execFile(plan.file, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '0'], { ...plan.options, env, timeout: 60000 }, (err) => resolve((Date.now() - at) + ' ms' + (err ? ' (' + (err.killed ? 'ended at 60 s' : err.code) + ')' : '')));
  });
  const full = { ...process.env, PSModulePath: plan.options.env.PSModulePath };
  const starts = [];
  for (const [name, env] of [['plan', plan.options.env], ['full', full], ['plan', plan.options.env], ['full', full]]) starts.push(name + ' ' + await bare(env));
  t.diagnostic('powershell.exe started and ended in: ' + starts.join(', '));
  assert.equal(answer.why, '', 'it answered: ' + answer.why + ' (' + came.join(', ') + ')\n' + answer.text);
  const lines = answer.text.split(/\r?\n/).filter((l) => l.trim());
  assert.deepEqual(JSON.parse(lines[0]), { v: 1 }, answer.text);
  assert.deepEqual(lines.slice(1).map((l) => Object.keys(JSON.parse(l))), [['standbyAc'], ['lidAc'], ['task'], ['record'], ['network'], ['rules']], answer.text);
  const w = laptop.windowsFacts(answer);
  for (const [part, fact] of Object.entries(w)) assert.ok(fact.ok || /^Windows said: /.test(fact.why), part + ': ' + JSON.stringify(fact) + '\n' + answer.text);
  if (process.env.CI) assert.deepEqual([w.task, w.record], [{ ok: true, missing: true }, { ok: true, missing: true }], answer.text);
});

// ---------------------------------------------------------------- the admin page's answer
test('the admin page\'s answer: the LAN addresses and the port, as the banner says them, and why HTTPS is off', async (t) => {
  const srv = await h.startServer({ AGM_TEST_LAN: '192.0.2.10,198.51.100.7', NODE_OPTIONS: preload('network-preload.js') });
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  const s = await a.settings();
  assert.deepEqual([s.addresses, s.port], [['192.0.2.10', '198.51.100.7'], srv.port]);
  assert.ok(srv.out().includes(`  LAN:     http://192.0.2.10:${srv.port}\n  LAN:     http://198.51.100.7:${srv.port}\n`), 'the banner says the same:\n' + srv.out());
  assert.deepEqual([s.tls.on, s.tls.off, s.tls.renewal], [false, 'AGM_TLS=0 turned it off for this run', '']);
  assert.equal((await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: a.cookie })).body.tls.off, 'AGM_TLS=0 turned it off for this run', 'health says it too');
  // "This laptop": what AGMessage knows, each with where it was read; Windows' facts unknown off Windows, with why.
  const l = s.laptop;
  assert.deepEqual([l.addresses, l.port], [['192.0.2.10', '198.51.100.7'], srv.port]);
  // Off Windows nothing is run, so the read is done at once; on Windows its powershell.exe may still be reading.
  if (process.platform !== 'win32') assert.deepEqual([l.reading, typeof l.at], [false, 'number']);
  // The rights given are a row only where there is an install record (a Windows runner's read may find none).
  assert.deepEqual(l.facts.map((r) => r.id).filter((id) => id !== 'grants'), ['build', 'format', 'addresses', 'https', 'sealed', 'screens', 'pages', 'stagewatch', 'tunnel', 'asleep', 'awake', 'stop', 'network', 'firewall', 'sleep', 'lid', 'task', 'admin']);
  if (process.platform !== 'win32') assert.equal(l.facts[l.facts.length - 1].id, 'grants');
  assert.ok(l.facts.every((r) => typeof r.label === 'string' && r.label && typeof r.words === 'string' && r.words && typeof r.from === 'string' && r.from), 'each row says where it was read');
  assert.deepEqual(rowsOf(l, ['format', 'addresses', 'https', 'sealed', 'screens', 'pages', 'stagewatch', 'tunnel']), {
    format: ['format 2 · begun by this build', ''],
    addresses: [`http://192.0.2.10:${srv.port} · http://198.51.100.7:${srv.port}`, ''],
    https: ['off: AGM_TLS=0 turned it off for this run', 'off'],
    sealed: ['1 of 1 open', 'ok'],   // the context token, made for the answer's own contextToken
    screens: ['none in any hall', ''], pages: ['every open page and screen is on this build', 'ok'], stagewatch: ['not linked', 'off'], tunnel: ['off', 'off'],
  });
  // No watchdog runs a server started alone, and no hall is live: neither a sleep recorded nor a power request asked.
  assert.deepEqual(rowsOf(l, ['asleep', 'awake']), {
    asleep: ['none recorded: no watchdog runs this server, so a sleep goes unseen', 'off'],
    awake: ['not asked: no hall is live', 'off'],
  });
  // A folder this start began had no stop before it to save.
  assert.deepEqual(rowsOf(l, ['stop']), { stop: ['none: this start began the data folder', ''] });
  assert.equal(row(l, 'stop').from, 'the record the stop before this start writes last (' + path.join(srv.dataDir, 'last-stop.json') + '), read at this start');
  assert.match(row(l, 'build').words, /^\S+ · the portable folder$/);
  const off = 'unknown (AGMessage is not running on Windows)';
  if (process.platform !== 'win32') for (const id of ['network', 'firewall', 'sleep', 'lid', 'task', 'admin', 'grants']) assert.deepEqual([row(l, id).words, row(l, id).mark], [off, ''], id);
  // Refresh: its answer is the facts, and only the admin page's answers carry them, never health.
  const r = await h.answer(a.s, 'admin:laptop', null);
  assert.deepEqual([r.ok, r.laptop.facts[0].id, r.laptop.port], [true, 'build', srv.port]);
  assert.ok(!('laptop' in (await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: a.cookie })).body), 'health carries no "This laptop"');
  const guest = await h.connect(srv.base);
  t.after(() => guest.close());
  assert.deepEqual(await h.answer(guest, 'admin:laptop', null), { ok: false, error: 'Not admin' });
});

test('HTTPS off for a certificate that cannot be used: the admin page says what the banner says', async (t) => {
  const keys = tmp('agm-https-off-');
  fs.writeFileSync(path.join(keys, 'tls.json'), '{"not": "a certificate"}');
  const srv = await h.startServer({ AGM_KEY_DIR: keys, AGM_TLS: '1' });
  t.after(() => h.stopServer(srv.child));
  const banner = (/\n {2}HTTPS: {3}off — (.+)\n/.exec(srv.out()) || [])[1];
  assert.equal(banner, path.join(keys, 'tls.json') + ' holds no certificate AGMessage wrote. It is left as it is');
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  const s = await a.settings();
  assert.deepEqual([s.tls.on, s.tls.off], [false, banner]);
  assert.deepEqual(rowsOf(s.laptop, ['https']), { https: ['off: ' + banner, 'warn'] });
  assert.equal(row(s.laptop, 'https').from, 'the certificate in ' + path.join(keys, 'tls.json'));
});

// ---------------------------------------------------------------- the certificate's renewal
/** A machine key, written as lib/secretbox.js keeps one, and a certificate with `days` to run sealed with it. */
function plantCertificate(keyDir, days) {
  const key = crypto.randomBytes(32);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'machine.key'), key.toString('base64'));
  const { certDer, keyPem } = tlsmod.makeCertificate({ name: 'AGMessage here', hosts: ['localhost'], ips: ['127.0.0.1'], days });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(keyPem, 'utf8'), c.final()]);
  const sealed = 'enc1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  fs.writeFileSync(path.join(keyDir, 'tls.json'), JSON.stringify({ v: 1, certDer: certDer.toString('base64'), keySealed: sealed, created: new Date().toISOString() }));
  return tlsmod.fingerprint(certDer);
}

const WAITS_NONE = 'due for renewal, and not renewed at this start, which has no network address yet: New certificate renews it once this laptop has one, as does a start that has one';
const WAITS_NOW = 'due for renewal, and not renewed at this start, which had no network address: New certificate renews it now';

test('a certificate due for renewal is not renewed at a start with no network address: it serves on, said in words true now; the next start with one renews it, naming that address', async (t) => {
  assert.deepEqual([tlsmod.renewalWaits({ state: 'renew' }, []), tlsmod.renewalWaits({ state: 'renew' }, ['192.0.2.10']), tlsmod.renewalWaits({ state: 'ok' }, []), tlsmod.renewalWaits({ state: 'absent' }, []), tlsmod.renewalWaits(null, [])],
    [true, false, false, false, false], 'only a renewal waits, and only for an address: a first certificate is still made');
  assert.equal(tlsmod.renewalWaits({ state: 'renew' }, ['169.254.20.7']), true, 'an address an adapter gave itself (169.254/16), no network\'s, is none');
  assert.deepEqual(tlsmod.networkAddresses(['169.254.20.7', '192.0.2.10', 7, '169.2.0.1']), ['192.0.2.10', '169.2.0.1']);
  const keys = tmp('agm-renew-');
  const fp = plantCertificate(keys, 15);   // 15 days to run: due for renewal at start
  const tlsFile = path.join(keys, 'tls.json');
  const planted = fs.readFileSync(tlsFile);
  const lan = path.join(keys, '..', path.basename(keys) + '.lan');
  fs.writeFileSync(lan, '169.254.20.7');   // the adapter's own address, before the network answers it
  const net = { AGM_KEY_DIR: keys, AGM_TLS: '1', AGM_TEST_LAN_FILE: lan, NODE_OPTIONS: preload('network-preload.js') };
  let srv = await h.startServer(net);
  t.after(() => h.stopServer(srv.child));
  assert.match(srv.out(), /\[tls\] the certificate, which ends .+, is due for renewal and not renewed at this start, which has no network address: it serves on; New certificate on the admin page renews it once this laptop has one, as does a start that has one/);
  let a = await adminAnswer(srv.base);
  let s = await a.settings();
  assert.deepEqual([s.tls.on, s.tls.fingerprint, s.tls.off, s.tls.renewal], [true, fp, '', WAITS_NONE]);
  assert.deepEqual(s.addresses, ['169.254.20.7']);
  assert.equal(row(s.laptop, 'https').mark, 'warn');
  assert.ok(row(s.laptop, 'https').words.endsWith(' · ' + WAITS_NONE), row(s.laptop, 'https').words);
  // The network gives the laptop an address while it serves: the words say what is true now, and how to renew.
  fs.writeFileSync(lan, '192.0.2.10');
  s = await a.settings();
  assert.deepEqual([s.tls.fingerprint, s.tls.renewal, s.addresses], [fp, WAITS_NOW, ['192.0.2.10']]);
  assert.deepEqual(rowsOf(s.laptop, ['addresses']), { addresses: [`http://192.0.2.10:${srv.port}`, ''] });
  assert.ok(row(s.laptop, 'https').words.endsWith(' · ' + WAITS_NOW), row(s.laptop, 'https').words);
  a.s.close();
  await h.stopServer(srv.child);
  assert.deepEqual(fs.readFileSync(tlsFile), planted, 'tls.json left as it was: never renewed behind a person\'s back');
  // With an address the next start renews it, and the new certificate names it.
  srv = await h.restartServer(srv, net);
  a = await adminAnswer(srv.base);
  s = await a.settings();
  a.s.close();
  assert.deepEqual([s.tls.on, s.tls.renewal, s.tls.fingerprint === fp], [true, '', false], 'renewed');
  const x = new crypto.X509Certificate(Buffer.from(JSON.parse(fs.readFileSync(tlsFile, 'utf8')).certDer, 'base64'));
  assert.ok(x.subjectAltName.includes('IP Address:192.0.2.10'), x.subjectAltName);
  assert.equal(row(s.laptop, 'https').mark, 'ok');
});

test('a renewal left at a start with no network address: New certificate renews it once there is one, and the words go', async (t) => {
  const keys = tmp('agm-renew-');
  const fp = plantCertificate(keys, 15);
  const lan = path.join(keys, '..', path.basename(keys) + '.lan');
  fs.writeFileSync(lan, '');
  const srv = await h.startServer({ AGM_KEY_DIR: keys, AGM_TLS: '1', AGM_TEST_LAN_FILE: lan, NODE_OPTIONS: preload('network-preload.js') });
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  assert.equal((await a.settings()).tls.renewal, WAITS_NONE);
  fs.writeFileSync(lan, '192.0.2.10');
  const r = await new Promise((resolve) => { a.s.emit('admin:renewCertificate', resolve); });   // asked with its answer alone
  assert.deepEqual([r.ok, r.tls.renewal, r.tls.fingerprint === fp], [true, '', false], JSON.stringify(r));
  const x = new crypto.X509Certificate(Buffer.from(JSON.parse(fs.readFileSync(path.join(keys, 'tls.json'), 'utf8')).certDer, 'base64'));
  assert.ok(x.subjectAltName.includes('IP Address:192.0.2.10'), x.subjectAltName);
  const s = await a.settings();
  assert.deepEqual([s.tls.renewal, row(s.laptop, 'https').mark], ['', 'ok']);
  // An adapter list the system refuses: the admin page's answer is drawn all the same, "This laptop" saying why it is not.
  fs.writeFileSync(lan, 'throw');
  const refused = await a.settings();
  assert.deepEqual([refused.addresses, refused.tls.on, refused.laptop.facts], [[], true, [{ id: 'unread', label: 'This laptop', words: 'unknown (its facts could not be read: ENOMEM)', mark: 'warn', from: 'this server' }]]);
});

// ---------------------------------------------------------------- Windows' facts
test('Windows is asked by one powershell.exe by its absolute path, a fixed script, no secret handed to it; one that does not answer in time leaves each fact unknown, with why', async (t) => {
  const dir = tmp('agm-win-');
  const plans = path.join(dir, 'plans.jsonl');
  const srv = await h.startServer({ AGM_TEST_WINDOWS_PLAN: plans, AGM_TEST_WINDOWS_ANSWER: 'hang', AGM_LAPTOP_MS: '3000', ANTHROPIC_API_KEY: 'sk-ant-not-a-key-0123456789', NODE_OPTIONS: preload('windows-preload.js') });   // secret-scan: fixture
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  // Read once it serves: under way now, and Refresh asked meanwhile starts no second read.
  const first = (await a.settings()).laptop;
  assert.equal(first.reading, true, 'Windows is being read');
  assert.equal((await h.answer(a.s, 'admin:laptop', null)).laptop.reading, true);
  const told = h.once(a.s, 'laptop:facts', 5000);
  const l = await told;
  assert.deepEqual([l.reading, typeof l.at], [false, 'number'], 'the admin page is told once the read ends');
  for (const id of ['network', 'firewall', 'sleep', 'lid', 'task', 'admin', 'grants']) assert.deepEqual([row(l, id).words, row(l, id).mark], ['unknown (Windows did not answer within 3 s)', ''], id);
  assert.deepEqual(rowsOf(l, ['network', 'sleep', 'task', 'admin']), {
    network: ['unknown (Windows did not answer within 3 s)', ''], sleep: ['unknown (Windows did not answer within 3 s)', ''],
    task: ['unknown (Windows did not answer within 3 s)', ''], admin: ['unknown (Windows did not answer within 3 s)', ''],
  });
  assert.equal(row(l, 'sleep').from, 'Windows: the power plan (powercfg)');
  const made = read(plans).trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(made.length, 1, 'one read at a time');
  const p = made[0];
  assert.deepEqual([p.run, p.file, p.args, p.options.cwd, p.options.windowsHide], [true, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', laptop.SCRIPT], 'C:\\Windows\\System32', true]);
  assert.equal(p.options.env.AGM_NODE, process.execPath, 'the firewall\'s rules are read for this node.exe');
  assert.equal(p.options.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', 'Windows\' own modules, never the account\'s');
  const passed = new Set(['SystemRoot', 'PSModulePath', 'AGM_NODE', ...laptop.PASSED]);
  assert.deepEqual(Object.keys(p.options.env).filter((k) => !passed.has(k)), [], 'only the names it is to have: no secret, no PATH, no NODE_OPTIONS');
  assert.ok(!JSON.stringify(p).includes(h.TOKEN) && !JSON.stringify(p).includes('sk-ant-not-a-key'), 'searched by value');
});

test('a read that runs out of time part way keeps each part Windows said before it: only the rest read unknown', async (t) => {
  const dir = tmp('agm-win-');
  const answer = path.join(dir, 'answer.txt');
  // As the script says them: its first line, the cheap parts, then nothing more (the firewall's query never came back).
  fs.writeFileSync(answer, [{ v: 1 }, { standbyAc: 0 }, { lidAc: 0 }, { task: ANSWER.task }, { record: ANSWER.record }, { network: ANSWER.network }].map((o) => JSON.stringify(o)).join('\n') + '\n{"rules":[{"na\nHANG\n');
  const srv = await h.startServer({ AGM_TEST_WINDOWS_PLAN: path.join(dir, 'plans.jsonl'), AGM_TEST_WINDOWS_ANSWER: answer, AGM_LAPTOP_MS: '1500', NODE_OPTIONS: preload('windows-preload.js') });
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  let l = null;
  assert.ok(await until(async () => { l = (await a.settings()).laptop; return !l.reading && typeof l.at === 'number'; }), JSON.stringify(l));
  assert.deepEqual(rowsOf(l, ['network', 'firewall', 'sleep', 'lid', 'task', 'admin']), {
    network: ['Venue-WiFi (Wi-Fi): Private · Guest (Ethernet 2): Public', ''],
    firewall: ['unknown (Windows did not answer within 2 s)', ''],
    sleep: ['never', 'ok'], lid: ['do nothing', 'ok'],
    task: ['Running · last result 0x0 at 2026-11-02 13:02 UTC', 'ok'], admin: ['LAPTOP\\ana', ''],
  });
});

test('a server that stops while Windows is read ends the read: no powershell.exe is left behind it', async (t) => {
  const dir = tmp('agm-win-');
  const plans = path.join(dir, 'plans.jsonl');
  const srv = await h.startServer({ AGM_TEST_WINDOWS_PLAN: plans, AGM_TEST_WINDOWS_ANSWER: 'hang', AGM_LAPTOP_MS: '60000', NODE_OPTIONS: preload('windows-preload.js') });
  t.after(() => h.stopServer(srv.child));
  assert.ok(await until(() => /^\d+\n$/.test(read(plans + '.pids'))), 'the read is under way');
  const pid = Number(read(plans + '.pids'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true);
  await h.stopServer(srv.child);
  assert.ok(await until(() => !alive(), 5000), 'the read ended with the server');
});

const ANSWER = {
  v: 1,
  network: [{ name: 'Venue-WiFi', alias: 'Wi-Fi', category: 'Private' }, { name: 'Guest', alias: 'Ethernet 2', category: 'Public' }],
  rules: [
    { name: 'AGMessage (TCP 3023)', enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Domain, Private' },
    { name: 'node.exe', enabled: true, direction: 'Inbound', action: 'Block', profile: 'Public' },
  ],
  standbyAc: 0, lidAc: 1,
  task: { state: 'Running', lastResult: 0, lastRun: '2026-11-02T13:02:11.0000000Z' },
  record: { admin: 'S-1-5-21-1-2-3-1001', adminName: 'LAPTOP\\ana', grants: [{ sid: 'S-1-5-21-1-2-3-1002', name: 'LAPTOP\\ben', rights: 'start,stop' }, { sid: 'S-1-5-21-1-2-3-1003', name: '', rights: 'token' }] },
};

test('Windows\' answer: the network\'s profile and the firewall on it, sleep and the lid on mains, the server task, the laptop\'s admin and the rights given', async (t) => {
  const dir = tmp('agm-win-');
  const answer = path.join(dir, 'answer.json');
  fs.writeFileSync(answer, JSON.stringify(ANSWER));
  const srv = await h.startServer({ AGM_TEST_WINDOWS_PLAN: path.join(dir, 'plans.jsonl'), AGM_TEST_WINDOWS_ANSWER: answer, NODE_OPTIONS: preload('windows-preload.js') });
  t.after(() => h.stopServer(srv.child));
  const a = await adminAnswer(srv.base);
  t.after(() => a.s.close());
  // Read once it serves; the settings' answer, which reads nothing again, says it once that read has ended.
  let l = null;
  assert.ok(await until(async () => { l = (await a.settings()).laptop; return !l.reading && typeof l.at === 'number'; }), JSON.stringify(l));
  const firstAt = l.at;
  // Refresh reads it again, and the page is told the facts when that read ends.
  const told = h.once(a.s, 'laptop:facts', 8000);
  assert.equal((await h.answer(a.s, 'admin:laptop', null)).laptop.reading, true);
  l = await told;
  assert.ok(!l.reading && l.at >= firstAt);
  assert.equal(read(path.join(dir, 'plans.jsonl')).trim().split('\n').length, 2, 'two reads: at start and at Refresh');
  assert.deepEqual(rowsOf(l, ['network', 'firewall', 'sleep', 'lid', 'task', 'admin', 'grants']), {
    network: ['Venue-WiFi (Wi-Fi): Private · Guest (Ethernet 2): Public', ''],
    firewall: ['allowed on Private · a block rule on Public: phones there cannot reach AGMessage', 'fault'],
    sleep: ['never', 'ok'],
    lid: ['sleep', 'warn'],
    task: ['Running · last result 0x0 at 2026-11-02 13:02 UTC', 'ok'],
    admin: ['LAPTOP\\ana', ''],
    grants: ['LAPTOP\\ben: start,stop · S-1-5-21-1-2-3-1003: token', ''],
  });
  assert.equal(row(l, 'admin').from, 'Windows: the install record (HKLM\\SOFTWARE\\AGMessage)');
  assert.equal(row(l, 'firewall').from, 'Windows Firewall\'s rules for ' + process.execPath);
  // The context, read with the admin's token, carries none of it.
  const ctx = JSON.stringify((await h.api(srv.base, 'GET', '/api/context', undefined, { cookie: a.cookie })).body);
  assert.ok(!ctx.includes('LAPTOP\\\\ana') && !ctx.includes('ben') && !ctx.includes('S-1-5-21'), 'the context names no Windows account');
});

// ---------------------------------------------------------------- the rules (pure)
test('how Windows is asked: on Windows only, by its absolute path under a SystemRoot named from its drive, a script of one line with no double quote', () => {
  assert.deepEqual(laptop.windowsPlan({ SystemRoot: 'C:\\Windows' }, { platform: 'linux' }), { run: false, why: 'AGMessage is not running on Windows' });
  for (const root of [undefined, '', 'Windows', '%SystemRoot%', '\\\\server\\share']) {
    assert.deepEqual(laptop.windowsPlan({ SystemRoot: root }, { platform: 'win32' }), { run: false, why: 'SystemRoot does not name the Windows folder, so powershell.exe has no path to run from' }, String(root));
  }
  // Its environment is named, never this server's: no secret whatever the case of its name (Windows reads names in any
  // case), no PATH, no module path of the account's own.
  const env = { SystemRoot: 'D:\\WINDOWS ', ADMIN_TOKEN: 'x', Admin_Token: 'x2', ANTHROPIC_API_KEY: 'y', anthropic_api_key: 'y2', PATH: 'C:\\bin', PSModulePath: 'C:\\Users\\ana\\Documents\\WindowsPowerShell\\Modules', TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', COMPUTERNAME: 'LAPTOP', NODE_OPTIONS: '--require x' };
  const p = laptop.windowsPlan(env, { platform: 'win32', node: 'C:\\Program Files\\AGMessage\\node\\node.exe' });
  assert.deepEqual([p.file, p.options.cwd, p.options.env], ['D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'D:\\WINDOWS\\System32', {
    SystemRoot: 'D:\\WINDOWS', TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', COMPUTERNAME: 'LAPTOP',
    PSModulePath: 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\Modules', AGM_NODE: 'C:\\Program Files\\AGMessage\\node\\node.exe',
  }]);
  assert.ok(laptop.PASSED.every((n) => !/TOKEN|KEY|SECRET|PASS|PATH|NODE/i.test(n)), 'no name it passes could hold a secret or a search path: ' + laptop.PASSED);
  const s = laptop.SCRIPT;
  assert.ok(!s.includes('"') && !s.includes('\n') && !s.includes('\r'), 'one line, single quotes only');
  assert.ok(s.includes("& ($env:SystemRoot + '\\System32\\powercfg.exe')"), 'powercfg by its absolute path');
  // Each part said on its own line as soon as it is read, the firewall's rules last; each says why when it is not read.
  const said = ['standbyAc', 'lidAc', 'task', 'record', 'network', 'rules'].map((part) => s.indexOf("AgmSay '" + part + "' "));
  said.unshift(s.indexOf("'{' + [char]34 + 'v' + [char]34 + ':1}'; AgmUse 'Microsoft.PowerShell.Utility';"));
  assert.ok(said.every((at, i) => at > 0 && (i === 0 || at > said[i - 1])), 'in that order, the first before any module: ' + said);
  // Each module by its manifest's path under $PSHOME, never found by name; each before the part that uses it.
  assert.ok(s.includes("function AgmUse($m) { Import-Module ($PSHOME + '\\Modules\\' + $m + '\\' + $m + '.psd1') }"), 'Windows\' own module, by its path');
  for (const [mod, cmd] of [['Microsoft.PowerShell.Utility', 'ConvertTo-Json -InputObject'], ['ScheduledTasks', 'Get-ScheduledTask '], ['Microsoft.PowerShell.Management', 'Get-ItemProperty '], ['NetConnection', 'Get-NetConnectionProfile'], ['NetSecurity', 'Get-NetFirewallApplicationFilter']]) {
    const use = s.indexOf("AgmUse '" + mod + "'");
    assert.ok(use > 0 && (mod === 'Microsoft.PowerShell.Utility' || use < s.indexOf(cmd)), mod + ' imported before ' + cmd);
  }
  assert.ok(s.trim().endsWith("AgmSay 'rules' $v"), 'the firewall\'s rules last');
  assert.equal(s.split('$v = @{ error = (AgmWhy $_) }').length - 1, 6, 'each part says why it was not read');
  // The firewall's rules from its own object, the cmdlets only under Constrained Language Mode (which allows no COM
  // object); either read that fails says its own reason; each list kept a list.
  assert.ok(s.indexOf("New-Object -ComObject 'HNetCfg.FwPolicy2'") > 0, 'the firewall\'s own object');
  assert.ok(s.includes("try { if ([string]$ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $v = @(AgmRulesFast $env:AGM_NODE) } else { $v = @(AgmRulesSlow $env:AGM_NODE) } } catch { $v = @{ error = (AgmWhy $_) } }; AgmSay 'rules' $v"), 'chosen by the language mode, each list taken with @()');
});

// PowerShell runs an alias before a function of the same name: a function named as one of Windows PowerShell's aliases
// (`ac` is Add-Content) runs that command instead. Windows PowerShell's own aliases are single words, never Verb-Noun and
// never beginning Agm, so every function, filter or workflow a script AGMessage runs defines is named one of those two
// ways (a scope before the name fails the rule, so it is never passed over), and none is made through the Function: drive.
test('every PowerShell AGMessage runs names its functions so that no alias of Windows PowerShell\'s runs in their place', () => {
  const root = path.join(__dirname, '..', '..');
  const lane = require('../../tools/readings-take');
  const scripts = [['lib/laptop.js SCRIPT', laptop.SCRIPT], ['lib/power.js SCRIPT', require('../lib/power').SCRIPT], ...Object.entries(lane.SCRIPTS).map(([k, v]) => ['tools/readings-take.js SCRIPTS.' + k, v])];
  for (const f of fs.readdirSync(path.join(root, 'tools')).filter((n) => /\.ps1$/i.test(n))) scripts.push(['tools/' + f, readSource(path.join(root, 'tools', f))]);
  const named = [];
  for (const [where, text] of scripts) {
    assert.ok(!/\$\{function:|\bfunction:\\?\w/i.test(text), where + ' makes a function through the Function: drive');
    for (const m of text.matchAll(/(?:^|[\s;{}(])(?:function|filter|workflow)\s+([^\s({]+)/gi)) {
      named.push(where + ': ' + m[1]);
      assert.ok(/^Agm[A-Z]\w*$/.test(m[1]) || /^[A-Z][a-z]+-[A-Z]\w*$/.test(m[1]), where + ' names a function ' + m[1] + ': not Verb-Noun, nor Agm…');
    }
  }
  assert.ok(named.some((n) => n.startsWith('lib/laptop.js SCRIPT: AgmPower')) && named.some((n) => n.startsWith('lib/power.js SCRIPT: AgmTell')), 'the fence reads the scripts: ' + named);
  // The rule refuses the names that ran Add-Content and their other forms.
  const refused = (text) => [...text.matchAll(/(?:^|[\s;{}(])(?:function|filter|workflow)\s+([^\s({]+)/gi)].map((m) => m[1]).filter((n) => !(/^Agm[A-Z]\w*$/.test(n) || /^[A-Z][a-z]+-[A-Z]\w*$/.test(n)));
  assert.deepEqual(refused("function Ac($sub, $set) { }; filter sc { $_ }; workflow h { }; function script:AgmX { }; function Read-Defender { }; function AgmSay($k) { }"), ['Ac', 'sc', 'h', 'script:AgmX']);
  for (const alias of ['ac', 'r', 'h', 'sc', 'set', 'sort', 'type', 'write', 'where', 'select', 'start', 'sleep', 'kill']) {
    assert.ok(!named.some((n) => n.toLowerCase().endsWith(': ' + alias)), alias + ' is one of Windows PowerShell\'s aliases');
  }
});

test('running the plan: its output, or why there is none: not in time, not run, too large; never a rejection', async () => {
  const plan = { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-Command', 'x'], options: { cwd: 'C:\\Windows\\System32' } };
  const stand = (fn) => (file, args, options, done) => { stand.asked = { file, args, options }; fn(done); };
  assert.deepEqual(await laptop.readWindows(plan, { run: stand((done) => done(null, '{"v":1}')) }), { text: '{"v":1}', why: '' });
  assert.deepEqual([stand.asked.options.timeout, stand.asked.options.killSignal, stand.asked.options.maxBuffer, stand.asked.options.cwd], [5000, 'SIGKILL', 256 * 1024, 'C:\\Windows\\System32'], 'within 5 s, its answer bounded');
  assert.deepEqual(await laptop.readWindows(plan, { timeoutMs: 5000, run: stand((done) => done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '')) }), { text: '', why: 'Windows did not answer within 5 s' });
  assert.deepEqual(await laptop.readWindows(plan, { timeoutMs: 5000, run: stand((done) => done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '{"v":1}\n{"lidAc":1}\n')) }), { text: '{"v":1}\n{"lidAc":1}\n', why: 'Windows did not answer within 5 s' }, 'what it said before its time ran out is kept');
  assert.deepEqual(await laptop.readWindows(plan, { run: stand((done) => done(Object.assign(new Error('nope'), { code: 'ENOENT' }), '')) }), { text: '', why: 'powershell.exe could not be run (ENOENT)' });
  assert.deepEqual(await laptop.readWindows(plan, { run: stand((done) => done(Object.assign(new Error('big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '')) }), { text: '', why: 'Windows\' answer was larger than AGMessage reads' });
  assert.deepEqual(await laptop.readWindows(plan, { run: stand((done) => done(Object.assign(new Error('exit 1'), { code: 1 }), '{"v":1}')) }), { text: '{"v":1}', why: '' }, 'an end that is not 0 with an answer: the answer is read');
  assert.deepEqual(await laptop.readWindows(plan, { run: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); } }), { text: '', why: 'powershell.exe could not be run (EACCES)' });
});

test('Windows\' answer is read by type, part by part: a part refused, missing or of another type is unknown alone, with why', () => {
  const unknownAll = (why) => Object.fromEntries(['network', 'rules', 'standbyAc', 'lidAc', 'task', 'record'].map((p) => [p, { ok: false, why }]));
  assert.deepEqual(laptop.windowsFacts(null), unknownAll('not read yet'));
  assert.deepEqual(laptop.windowsFacts({ text: '', why: 'Windows did not answer within 5 s' }), unknownAll('Windows did not answer within 5 s'));
  for (const text of ['not json', 'null', '[]', '{"v":2}', '{"standbyAc":0}\n{"v":1}']) assert.deepEqual(laptop.windowsFacts({ text, why: '' }), unknownAll('Windows\' answer could not be read'), text);
  assert.deepEqual(laptop.windowsFacts({ text: 'Get-NetConnectionProfile : not', why: 'Windows did not answer within 5 s' }), unknownAll('Windows did not answer within 5 s'), 'nothing of its own said: why it said nothing');
  // As the script says it: a line per part; one cut short as the child was ended is passed over, and only the parts' names
  // are taken (no other key, the prototype's included).
  const lines = laptop.windowsFacts({ text: '{"v":1}\r\n{"standbyAc":600}\n\n{"lidAc":0,"__proto__":{"ok":true}}\n{"task":{"missing":true}}\n{"record":{"miss', why: 'Windows did not answer within 5 s' });
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), {
    network: { ok: false, why: 'Windows did not answer within 5 s' }, rules: { ok: false, why: 'Windows did not answer within 5 s' },
    standbyAc: { ok: true, value: 600 }, lidAc: { ok: true, value: 0 }, task: { ok: true, missing: true }, record: { ok: false, why: 'Windows did not answer within 5 s' },
  });
  const partly = laptop.windowsFacts({ text: JSON.stringify({ v: 1, network: { error: 'AccessDenied' }, rules: [], standbyAc: { error: 'powercfg ended with 1' }, lidAc: 'one', task: { missing: true }, record: { missing: true } }), why: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(partly)), {
    network: { ok: false, why: 'Windows said: AccessDenied' }, rules: { ok: true, list: [] }, standbyAc: { ok: false, why: 'Windows said: powercfg ended with 1' },
    lidAc: { ok: false, why: 'not in Windows\' answer' }, task: { ok: true, missing: true }, record: { ok: true, missing: true },
  });
  const known = { build: '0.6.0+31', runs: 'task', addresses: [], port: 3023, node: 'C:\\Program Files\\AGMessage\\node\\node.exe', https: { on: false, off: 'x', file: 'f' }, sealed: { total: 0 }, screens: { total: 0 }, stagewatch: { total: 0 }, tunnel: { running: false }, before: '', without: [] };
  const rows = laptop.facts(known, partly);
  assert.deepEqual(Object.fromEntries(rows.slice(7).map((r) => [r.id, [r.words, r.mark]])), {
    network: ['unknown (Windows said: AccessDenied)', ''], firewall: ['unknown (Windows said: AccessDenied)', ''],
    sleep: ['unknown (Windows said: powercfg ended with 1)', ''], lid: ['unknown (not in Windows\' answer)', ''],
    task: ['none: AGMessage is not installed on this PC', 'off'], admin: ['none: no install record on this PC', 'off'],
  }, 'no record: no rights row');
  // R12 (CI runs 101 and 115): Windows does not start the task again after its watchdog ends non-zero, so the row says so.
  assert.equal(rows[0].words, '0.6.0+31 · installed: a Windows task starts it with Windows, and does not start it again if its watchdog crashes (Start AGMessage, or restart the PC)');
  // Strange values are read by type: a grant that is no SID goes, a name is cleaned and cut, the task's numbers checked.
  const odd = laptop.windowsFacts({ text: JSON.stringify({ v: 1, network: [{ name: 'Café\u0007', alias: 7, category: 'DomainAuthenticated' }, 'x'], rules: { error: 'PermissionDenied' }, standbyAc: 1800, lidAc: 3,
    task: { state: 'Ready', lastResult: 2147942402, lastRun: '' }, record: { admin: 'S-1-5-21-9', adminName: '', grants: [{ sid: 'Everyone', name: 'x', rights: 'all' }, { sid: 'S-1-5-21-9-1', name: 'LAPTOP\\cy', rights: 'stop' }], grantsError: 'x' } }), why: '' });
  const r2 = Object.fromEntries(laptop.facts(known, odd).slice(7).map((r) => [r.id, [r.words, r.mark]]));
  assert.deepEqual(r2, {
    network: ['Café: Domain', ''], firewall: ['unknown (Windows said: PermissionDenied)', ''],
    sleep: ['after 30 min idle: the laptop sleeps, and AGMessage with it', 'warn'], lid: ['shut down', 'warn'],
    task: ['Ready · last result 0x80070002', ''], admin: ['S-1-5-21-9', ''], grants: ['unknown (Windows said: x)', ''],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(odd.record.grants)), [{ sid: 'S-1-5-21-9-1', name: 'LAPTOP\\cy', rights: 'stop' }]);
  // The firewall's rule: a block rule wins, Any covers every profile, a rule off or outbound covers nothing.
  const rule = (o) => ({ name: 'r', enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Private', ...o });
  assert.equal(laptop.reach([rule({}), rule({ action: 'Block', profile: 'Any' })], 'Private'), 'blocked');
  assert.equal(laptop.reach([rule({ profile: 'Any' })], 'Public'), 'allowed');
  assert.equal(laptop.reach([rule({ profile: 'Domain, Private, Public' })], 'Public'), 'allowed');
  assert.equal(laptop.reach([rule({ enabled: false, profile: 'Public' }), rule({ direction: 'Outbound', profile: 'Public' })], 'Public'), 'none');
  // Every rule is judged: a block rule after many allow rules still wins; past what is read, the reach is unknown, never
  // guessed. Networks and rights past what is listed are counted.
  const allows = Array.from({ length: 40 }, (_, i) => ({ name: 'allow ' + i, enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Any' }));
  const many = (o) => laptop.facts(known, laptop.windowsFacts({ text: JSON.stringify({ ...ANSWER, ...o }), why: '' }));
  const fw = (o) => { const r = many(o).find((x) => x.id === 'firewall'); return [r.words, r.mark]; };
  assert.deepEqual(fw({ rules: [...allows, { name: 'blocked', enabled: true, direction: 'Inbound', action: 'Block', profile: 'Public' }] }),
    ['allowed on Private · a block rule on Public: phones there cannot reach AGMessage', 'fault'], 'the 41st rule read');
  assert.deepEqual(fw({ rules: Array.from({ length: laptop.RULES_MAX + 1 }, () => allows[0]) }), ['unknown (more than ' + laptop.RULES_MAX + ' rules name this node.exe, more than AGMessage reads)', '']);
  const nets = Array.from({ length: laptop.LISTED_MAX + 3 }, (_, i) => ({ name: 'Net ' + i, alias: '', category: 'Private' }));
  const grants = Array.from({ length: laptop.LISTED_MAX + 2 }, (_, i) => ({ sid: 'S-1-5-21-1-2-3-' + (2000 + i), name: 'LAPTOP\\u' + i, rights: 'start' }));
  const listed = Object.fromEntries(many({ network: nets, record: { ...ANSWER.record, grants } }).map((x) => [x.id, x.words]));
  assert.ok(listed.network.endsWith('Net ' + (laptop.LISTED_MAX - 1) + ': Private · and 3 more'), listed.network);
  assert.ok(listed.grants.endsWith('LAPTOP\\u' + (laptop.LISTED_MAX - 1) + ': start · and 2 more'), listed.grants);
});

test('what AGMessage knows, row by row: each with its mark, its words and where it was read', () => {
  const w = laptop.windowsFacts({ text: JSON.stringify({ ...ANSWER, network: [], rules: [] }), why: '' });
  const k = {
    build: '0.6.0+31', runs: 'portable', addresses: ['192.0.2.10'], port: 3023, node: '/usr/bin/node',
    https: { on: true, fingerprint: 'sha256:' + 'ab'.repeat(32), validTo: 'Jan 10 12:00:00 2028 GMT', off: '', renewal: '', file: '/k/tls.json' },
    sealed: { total: 5, open: 4, keyWords: '' }, screens: { total: 3, shown: 1, offline: 2 }, stagewatch: { total: 3, connected: 2 },
    tunnel: { running: true, url: 'https://a-b.trycloudflare.com', error: '', until: '06:00 tomorrow', again: '', notKept: '' }, before: 'server not responding (no heartbeat)', without: ['the secret could not be read', 'the settings could not be read'],
  };
  const r = (rows) => Object.fromEntries(rows.map((x) => [x.id, [x.words, x.mark]]));
  assert.deepEqual(r(laptop.facts(k, w)), {
    build: ['0.6.0+31 · the portable folder', ''], addresses: ['http://192.0.2.10:3023', ''],
    https: ['on · certificate ' + 'ab'.repeat(8) + '… until Jan 10 12:00:00 2028 GMT', 'ok'],
    sealed: ['4 of 5 open', 'warn'], screens: ['1 of 3 confirmed what they show · 2 offline', 'warn'], stagewatch: ['2 of 3 links connected', 'warn'],
    tunnel: ['on: https://a-b.trycloudflare.com · until 06:00 tomorrow, then off', 'ok'],
    before: ['server not responding (no heartbeat)', 'warn'], without: ['the secret could not be read · the settings could not be read', 'warn'],
    network: ['none connected', 'warn'], firewall: ['no network to check it on', ''], sleep: ['never', 'ok'], lid: ['sleep', 'warn'],
    task: ['Running · last result 0x0 at 2026-11-02 13:02 UTC', 'ok'], admin: ['LAPTOP\\ana', ''], grants: ['LAPTOP\\ben: start,stop · S-1-5-21-1-2-3-1003: token', ''],
  });
  const all = { ...k, sealed: { total: 2, open: 2, keyWords: '' }, screens: { total: 2, shown: 2, offline: 0 }, stagewatch: { total: 1, connected: 1 }, tunnel: { running: true, url: '', error: '' }, before: '', without: [] };
  assert.deepEqual(r(laptop.facts(all, w).slice(3, 7)), { sealed: ['2 of 2 open', 'ok'], screens: ['2 of 2 confirmed what they show', 'ok'], stagewatch: ['connected', 'ok'], tunnel: ['starting', ''] });
  const many = { ...all, stagewatch: { total: 2, connected: 2 }, sealed: { total: 3, open: 0, keyWords: 'this run has no machine key (EACCES)' }, tunnel: { running: false, url: '', error: 'cloudflared not found' } };
  assert.deepEqual(r(laptop.facts(many, w).slice(3, 7)), { sealed: ['none of 3 open: this run has no machine key (EACCES)', 'fault'], screens: ['2 of 2 confirmed what they show', 'ok'], stagewatch: ['all 2 links connected', 'ok'], tunnel: ['off: cloudflared not found', 'warn'] });
  // The internet link: on until its end; turned on again by a start inside it, its address said to be new; △ where a
  // restart would not turn it on again (the settings could not be read), and its end still said.
  const linkRow = (tunnel) => r(laptop.facts({ ...all, tunnel }, w).filter((x) => x.id === 'tunnel')).tunnel;
  const AGAIN = { running: true, url: 'https://c-d.trycloudflare.com', error: '', until: '23:30 today', again: '14:02 today', notKept: '' };
  assert.deepEqual(linkRow(AGAIN), ['on: https://c-d.trycloudflare.com · until 23:30 today, then off · turned on again as AGMessage started at 14:02 today: a new address, so remote people need this one', 'ok']);
  assert.deepEqual(linkRow({ ...AGAIN, url: '' }), ['starting · until 23:30 today, then off · turned on again as AGMessage started at 14:02 today: its address will be new', '']);
  assert.deepEqual(linkRow({ ...AGAIN, again: '', notKept: 'Not saved: settings.json could not be read (EBUSY).' }), ['on: https://c-d.trycloudflare.com · until 23:30 today, then off · Not saved: settings.json could not be read (EBUSY).', 'warn']);
  // Off with its end still kept (cloudflared ended, or a start could not turn it on again): what turns it on again, △.
  assert.deepEqual(linkRow({ running: false, url: '', error: 'Not turned on again as AGMessage started at 08:02 today: cloudflared exited (code 1).', until: '23:30 today', again: '', notKept: '' }),
    ['off: Not turned on again as AGMessage started at 08:02 today: cloudflared exited (code 1). · it was to stay on until 23:30 today: Turn on, or a start of AGMessage before then, turns it on again', 'warn']);
  assert.deepEqual(linkRow({ running: false, url: '', error: '', until: '23:30 today', again: '', notKept: '' }), ['off · it was to stay on until 23:30 today: Turn on, or a start of AGMessage before then, turns it on again', 'warn']);
  assert.equal(laptop.facts({ ...all, tunnel: AGAIN }, w).find((x) => x.id === 'tunnel').from, 'cloudflared, turned on from this page, and again by a start before its end (kept in the settings)');
  const grantsNone = laptop.windowsFacts({ text: JSON.stringify({ ...ANSWER, lidAc: 9, record: { admin: '', adminName: '', grants: [] } }), why: '' });
  assert.deepEqual(r(laptop.facts(k, grantsNone).slice(-4)), { lid: ['action 9', 'warn'], task: ['Running · last result 0x0 at 2026-11-02 13:02 UTC', 'ok'], admin: ['not named in the install record', ''], grants: ['none given', ''] });
});

test('the pages row: every page on this build, or each on another by the build it named: 0.5 screens to reload by hand, 0.5 pages told at a time of day and then said told, and each other build with when each kind reloads, LISTED_MAX builds at most', () => {
  const p = (o) => ({ kind: 'hall', build: '0.6.0+40.abc1234', newer: -1, where: '', hall: 'Hall 1', who: 'Ana', ...o });
  const said = (pages, oldAt) => { const x = laptop.pagesRow(pages, oldAt); return [x.id, x.label, x.words, x.mark]; };
  assert.deepEqual(said([]), ['pages', 'Pages', 'every open page and screen is on this build', 'ok']);
  assert.equal(laptop.pagesRow([]).from, 'the build each open page and screen named as it connected (a 0.5 page or screen names none)');
  // 0.5's: screens by name, to reload by hand; its pages by kind, told to reload once no 0.5 file can still be fresh in
  // a browser (the time of day it comes), then said told.
  const old = [p({ kind: 'screen', build: null, newer: null, where: 'Foyer', who: '' }), p({ kind: 'screen', build: null, newer: null, where: 'Lectern', hall: '', who: '' }), p({ build: null, newer: null }), p({ kind: 'halls', build: null, newer: null, who: 'Sam' })];
  assert.deepEqual(said(old, '14:05'),
    ['pages', 'Pages', '4 on another build · 0.5 screens: Foyer in Hall 1, Lectern: reload each once by hand, since a 0.5 screen does not reload by itself · 0.5 pages: 1 hall page (Hall 1: Ana), 1 halls board (Sam): each is told to reload at 14:05, once no 0.5 script can still be in its browser\'s cache', 'warn']);
  assert.equal(said(old, '')[2], '4 on another build · 0.5 screens: Foyer in Hall 1, Lectern: reload each once by hand, since a 0.5 screen does not reload by itself · 0.5 pages: 1 hall page (Hall 1: Ana), 1 halls board (Sam): each was told to reload; reload by hand one that stays listed');
  assert.equal(said(old)[2], said(old, '')[2], 'no time given: the time has come');
  // Another build's: older or newer by MAJOR.MINOR.BUILD, each kind at its own moment; one that is not a build, said so.
  assert.deepEqual(said([p({}), p({ who: 'Ben' }), p({ kind: 'screen', where: 'Foyer', who: '' }), p({ kind: 'admin', who: 'the laptop\'s token' }), p({ kind: 'halls', build: '0.6.1+50.abc1234', newer: 1, who: 'Sam' }), p({ kind: 'page', build: '', newer: null, who: '' })])[2],
    '6 on another build · on 0.6.0+40.abc1234 (an older build): 1 screen (Foyer in Hall 1) reloads at its next take, 2 hall pages (Hall 1: Ana, Hall 1: Ben) each reloads at a quiet moment, 1 admin page (the laptop\'s token) reloads once its admin agrees · on 0.6.1+50.abc1234 (a newer build): 1 halls board (Sam) reloads at a quiet moment · on a build it did not name: 1 page not yet in a hall');
  // A name that comes more than once is said once, with how many; past LISTED_MAX the rest are counted.
  const crowd = Array.from({ length: laptop.LISTED_MAX + 3 }, (_, i) => p({ kind: 'screen', build: null, newer: null, where: 'S' + i, hall: '' }));
  assert.ok(said(crowd)[2].includes('S' + (laptop.LISTED_MAX - 1) + ' and 3 more: reload each'), said(crowd)[2]);
  assert.ok(said([p({ build: null }), p({ build: null })])[2].includes('2 hall pages (Hall 1: Ana ×2)'));
  // A build is the page's own word: past LISTED_MAX builds, the rest are counted, so the row is bounded however many a
  // client names.
  const many = Array.from({ length: laptop.LISTED_MAX + 4 }, (_, i) => p({ build: '0.0.1+' + (i + 1) + '.abc1234', who: 'P' + i }));
  many.push(p({ build: '0.0.1+' + (laptop.LISTED_MAX + 4) + '.abc1234', who: 'Again' }));
  const w = said(many)[2];
  assert.equal(w.split(' · ').length, 1 + laptop.LISTED_MAX + 1, 'the count, LISTED_MAX builds and the rest');
  assert.ok(w.startsWith((laptop.LISTED_MAX + 5) + ' on another build · on 0.0.1+1.abc1234 (an older build): 1 hall page (Hall 1: P0)'), w);
  assert.ok(w.endsWith(' · on 4 more builds: 5 pages or screens'), w);
  assert.ok(said([...many.slice(0, laptop.LISTED_MAX), p({ build: '0.0.2+1.abc1234' })])[2].endsWith(' · on 1 more build: 1 page or screen'));
  // In the panel, after the screens.
  const win = laptop.windowsFacts({ text: '', why: 'not read' });
  const k = { build: 'b', runs: 'portable', addresses: [], port: 1, node: '/n', https: { on: false, off: 'x', file: '/k' }, sealed: { total: 0 }, screens: { total: 0 }, stagewatch: { total: 0 }, tunnel: { running: false }, before: '', without: [] };
  const rows = laptop.facts({ ...k, pages: { list: [], oldAt: '14:05' } }, win);
  const ids = rows.map((x) => x.id);
  assert.deepEqual(ids.slice(ids.indexOf('screens'), ids.indexOf('screens') + 3), ['screens', 'pages', 'stagewatch']);
  assert.equal(laptop.facts({ ...k, pages: { list: old, oldAt: '14:05' } }, win).find((x) => x.id === 'pages').words, said(old, '14:05')[2], 'the time of day passed on');
  assert.ok(!laptop.facts(k, win).some((x) => x.id === 'pages'), 'none where the server names no pages');
});

test('the last stop\'s row: saved, with when and by which build; or not, with why and the halls told AGMessage restarted; none for a folder this start began', () => {
  const s = (o) => { const x = laptop.stopRow({ state: 'none', saved: false, at: null, build: '', unsaved: [], code: '', said: 0, left: '', fresh: false, file: '/d/last-stop.json', ...o }); return [x.id, x.label, x.words, x.mark]; };
  const at = Date.UTC(2026, 10, 3, 20, 31, 5);
  assert.deepEqual(s({ state: 'saved', saved: true, at, build: '0.6.0+41' }), ['stop', 'Last stop', 'saved at 2026-11-03 20:31 UTC by 0.6.0+41: the audit log, every store and each hall that changed, so no hall says AGMessage restarted', 'ok']);
  assert.deepEqual(s({ fresh: true }), ['stop', 'Last stop', 'none: this start began the data folder', '']);
  assert.deepEqual(s({ said: 3 }), ['stop', 'Last stop', 'not saved: AGMessage ended without its stop (a crash, the watchdog\'s kill of a hang, Windows shutting down or restarting, a power cut), or the build before it kept no record · so 3 halls say AGMessage restarted', 'warn']);
  assert.deepEqual(s({ state: 'unsaved', at, build: '0.6.0+41', unsaved: ['peaks', '2 halls'], said: 1 }), ['stop', 'Last stop', 'not saved at 2026-11-03 20:31 UTC by 0.6.0+41: peaks, 2 halls could not be written · so 1 hall says AGMessage restarted', 'warn']);
  assert.deepEqual(s({ state: 'unread', code: 'EACCES' }), ['stop', 'Last stop', 'not known to have saved: its record could not be read (EACCES)', 'warn']);
  // A record the folder does not bear out (lib/laststop.js `judge`, or one an earlier start took).
  assert.deepEqual(s({ state: 'stale', at, build: '0.6.0+41', code: 'a hall\'s log written after it', said: 2 }), ['stop', 'Last stop', 'not known to have saved: the record of a stop at 2026-11-03 20:31 UTC by 0.6.0+41 is not the stop before this start (a hall\'s log written after it), so a copy ran on the folder after it · so 2 halls say AGMessage restarted', 'warn']);
  // A record this start could not move aside, whichever it said: warned, with what the next start makes of it.
  assert.deepEqual(s({ state: 'saved', saved: true, at, build: '0.6.0+41', left: 'EBUSY' }), ['stop', 'Last stop', 'saved at 2026-11-03 20:31 UTC by 0.6.0+41: the audit log, every store and each hall that changed, so no hall says AGMessage restarted · its record could not be moved aside (EBUSY): the next start reads it as taken', 'warn']);
  assert.deepEqual(s({ said: 1, left: 'EBUSY; last-stop.seen.json EBUSY' })[2], 'not saved: AGMessage ended without its stop (a crash, the watchdog\'s kill of a hang, Windows shutting down or restarting, a power cut), or the build before it kept no record · so 1 hall says AGMessage restarted · its record could not be moved aside (EBUSY; last-stop.seen.json EBUSY): the next start reads it again, as stale once a hall has changed');
  assert.equal(laptop.stopRow({ state: 'none', saved: false, unsaved: [], said: 0, file: '/d/last-stop.json' }).from, 'the record the stop before this start writes last (/d/last-stop.json), read at this start');
  // After the power request, before the watchdog's line.
  const w = laptop.windowsFacts({ text: '', why: 'not read' });
  const k = { build: 'b', runs: 'portable', addresses: [], port: 1, node: '/n', https: { on: false, off: 'x', file: '/k' }, sealed: { total: 0 }, screens: { total: 0 }, stagewatch: { total: 0 }, tunnel: { running: false }, power: { state: 'off' }, before: 'w', without: [] };
  const ids = laptop.facts({ ...k, stop: { state: 'saved', saved: true, unsaved: [], said: 0, file: '/d' } }, w).map((x) => x.id);
  assert.deepEqual(ids.slice(ids.indexOf('stop') - 1, ids.indexOf('stop') + 2), ['awake', 'stop', 'before']);
  assert.ok(!laptop.facts(k, w).some((x) => x.id === 'stop'), 'none before this copy holds its folder');
});
