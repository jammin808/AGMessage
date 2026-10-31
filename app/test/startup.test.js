'use strict';
// What a start opens and says (lib/startup.js): the browser opener, the portable channel's alone and only once the copy
// serves; and a port already in use named by who holds it, read once at loopback with no token.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const startup = require('../lib/startup');

const ROOT = path.join(__dirname, '..');
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await h.wait(25); } return false; };

// ---------------------------------------------------------------- the opener's plan
test('opener: only the .bat\'s first start of a portable copy opens, through explorer.exe by its absolute path', () => {
  const facts = { restarts: 0, port: 3023, platform: 'win32' };
  const asked = { AGM_OPEN: '1', SystemRoot: 'C:\\Windows' };
  const open = startup.openerPlan(asked, facts);
  assert.deepEqual(open, {
    open: true, file: 'C:\\Windows\\explorer.exe', args: ['http://localhost:3023'], url: 'http://localhost:3023',
    options: { windowsHide: true, detached: true, stdio: 'ignore' },
  });
  assert.deepEqual(startup.openerPlan({ ...asked, AGM_RUNS: 'portable' }, facts), open, 'the portable channel named');
  assert.deepEqual(startup.openerPlan({ ...asked, AGM_RUNS: '' }, facts), open, 'an empty channel is no channel (cmd cannot set one)');
  assert.equal(startup.openerPlan({ ...asked, SystemRoot: 'D:\\WIN' }, { ...facts, port: 4023 }).file, 'D:\\WIN\\explorer.exe');

  // Not asked, a restart, or another channel: nothing opens, and nothing is said.
  for (const [env, f, why] of [
    [{ SystemRoot: 'C:\\Windows' }, facts, 'AGM_OPEN unset'],
    [{ ...asked, AGM_OPEN: 'yes' }, facts, 'AGM_OPEN is "1" or nothing'],
    [asked, { ...facts, restarts: 1 }, 'a watchdog restart'],
    [{ ...asked, AGM_RUNS: 'task' }, facts, 'the installed node (session 0)'],
    [{ ...asked, AGM_RUNS: 'service' }, facts, 'any channel but portable'],
    [{ ...asked, AGM_RUNS: 'Portable' }, facts, 'the channel\'s word as it is spelled'],
  ]) assert.deepEqual(startup.openerPlan(env, f), { open: false, say: '' }, why);

  // Asked, but nothing it can run: one line, and nothing spawned.
  const noRoot = startup.openerPlan({ AGM_OPEN: '1' }, facts);
  assert.equal(noRoot.open, false);
  assert.match(noRoot.say, /SystemRoot/);
  assert.match(noRoot.say, /http:\/\/localhost:3023$/);
  for (const root of ['', '  ', 'Windows', '\\Windows', '..\\Windows', '\\\\host\\share']) {
    assert.equal(startup.openerPlan({ AGM_OPEN: '1', SystemRoot: root }, facts).open, false, 'a SystemRoot that names no folder from its drive: ' + JSON.stringify(root));
  }
  const elsewhere = startup.openerPlan(asked, { ...facts, platform: 'linux' });
  assert.equal(elsewhere.open, false, 'Windows only');
  assert.match(elsewhere.say, /Windows only/);
});

test('opener: the browser is started once, with an argument array and no shell, and let go; a failure is one line', () => {
  const calls = [];
  const lines = [];
  const say = (l) => lines.push(l);
  const child = { handlers: {}, unrefs: 0, on(ev, fn) { this.handlers[ev] = fn; return this; }, unref() { this.unrefs++; } };
  const plan = startup.openerPlan({ AGM_OPEN: '1', SystemRoot: 'C:\\Windows' }, { restarts: 0, port: 3023, platform: 'win32' });
  assert.equal(startup.openBrowser(plan, (file, args, options) => { calls.push({ file, args, options }); return child; }, say), true);
  assert.deepEqual(calls, [{ file: 'C:\\Windows\\explorer.exe', args: ['http://localhost:3023'], options: { windowsHide: true, detached: true, stdio: 'ignore' } }]);
  assert.equal(child.unrefs, 1, 'the browser is let go: this copy never waits on it');
  assert.deepEqual(lines, [], 'nothing is said when it is asked to open');
  child.handlers.error(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not opened \(ENOENT\)\. Open http:\/\/localhost:3023$/);

  lines.length = 0;
  assert.equal(startup.openBrowser(plan, () => { throw new Error('bad'); }, say), false, 'a spawn that throws is caught');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not opened \(bad\)/);

  lines.length = 0;
  let spawned = 0;
  assert.equal(startup.openBrowser({ open: false, say: '' }, () => { spawned++; return child; }, say), false);
  assert.equal(startup.openBrowser(startup.openerPlan({ AGM_OPEN: '1' }, { restarts: 0, port: 3023, platform: 'win32' }), () => { spawned++; return child; }, say), false);
  assert.equal(spawned, 0, 'a plan that does not open spawns nothing');
  assert.equal(lines.length, 1, 'only the plan that has something to say says it');
});

// ---------------------------------------------------------------- the opener, in the server
const PRELOAD = path.join(__dirname, 'opener-preload.js');
// Windows keeps its own SystemRoot (its sockets need it); elsewhere one is stood in. The preload never runs explorer.exe.
const SYSTEM_ROOT = process.platform === 'win32' ? process.env.SystemRoot : 'C:\\StubWindows';
async function serverWithOpener(env) {
  const opened = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-open-')), 'opened.jsonl');
  const preload = '--require "' + PRELOAD.split(path.sep).join('/') + '"';   // forward slashes: no escapes inside the quotes
  const srv = await h.startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_OPENED: opened, SystemRoot: SYSTEM_ROOT, ...env });
  const read = () => { try { return fs.readFileSync(opened, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { srv, read };
}

test('opener: the server opens http://localhost:<PORT> once, after it serves; never on a restart, unasked or in another channel', async (t) => {
  const cases = await Promise.all([
    serverWithOpener({ AGM_OPEN: '1' }),
    serverWithOpener({ AGM_OPEN: '1', AGM_RUNS: 'portable' }),
    serverWithOpener({ AGM_OPEN: '1', AGM_RESTARTS: '1' }),
    serverWithOpener({}),
    serverWithOpener({ AGM_OPEN: '1', AGM_RUNS: 'task' }),
    serverWithOpener({ AGM_OPEN: '1', AGM_RUNS: 'service' }),
  ]);
  t.after(() => Promise.all(cases.map((c) => h.stopServer(c.srv.child))));
  const [first, portable, restarted, unasked, task, other] = cases;
  for (const c of [first, portable]) {
    assert.ok(await until(() => c.read().length > 0), 'the opener ran:\n' + c.srv.out());
    await h.wait(300);
    assert.deepEqual(c.read(), [{
      command: path.win32.join(SYSTEM_ROOT, 'explorer.exe'), args: [`http://localhost:${c.srv.port}`],
      options: { windowsHide: true, detached: true, stdio: 'ignore' }, serving: true,
    }], 'exactly once, by its absolute path, while this copy answers on its port');
  }
  await h.wait(300);
  for (const [c, why] of [[restarted, 'a watchdog restart'], [unasked, 'AGM_OPEN unset'], [task, 'AGM_RUNS=task'], [other, 'AGM_RUNS=service']]) {
    assert.deepEqual(c.read(), [], why + ' opens nothing');
    assert.ok(!/Browser:/.test(c.srv.out()), why + ' says nothing of a browser');
  }
});

// ---------------------------------------------------------------- the port's holder
/** A holder of `port` that answers /api/health with `answer` (an object, or a function of the request), keeping each request. */
function fakeHealth(port, answer) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const a = typeof answer === 'function' ? answer(req) : answer;
    if (a.cut) {   // an answer that promises more than it sends, and is cut off part way
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write(a.cut);
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(a.status || 200, { 'content-type': 'application/json' });
    res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
  });
  return new Promise((resolve) => { srv.listen(port, '127.0.0.1', () => resolve({ requests, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })); });
}
/** A holder of `port` that takes connections and never answers them, keeping when each was opened and closed. */
function silentHolder(port) {
  const sockets = new Set();
  const conns = [];
  const srv = net.createServer((c) => {
    const at = { openedAt: Date.now(), closedAt: 0 };
    conns.push(at);
    sockets.add(c);
    c.on('close', () => { at.closedAt = Date.now(); });
    c.on('error', () => { /* the reader gave up: nothing to answer */ });
    c.resume();   // what is asked is read and never answered, so the asker's end is seen when it comes
  });
  return new Promise((resolve) => { srv.listen(port, '127.0.0.1', () => resolve({ conns, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) })); });
}

test('the port\'s holder: read from its health once, cleaned and cut short; anything else is another program', async (t) => {
  const port = await h.freePort();
  let reply = { body: { ok: true, version: '0.5.1', build: '0.5.1+9.abc1234', uptime: 4 } };
  const fake = await fakeHealth(port, () => reply);
  t.after(() => fake.close());
  assert.deepEqual(await startup.readPortHolder(port), { version: '0.5.1', build: '0.5.1+9.abc1234', runs: '' });
  reply = { body: { ok: true, version: '0.6.0', build: '0.6.0+3.def5678', install: { runs: 'task', dir: 'C:\\ProgramData\\AGMessage' } } };
  assert.deepEqual(await startup.readPortHolder(port), { version: '0.6.0', build: '0.6.0+3.def5678', runs: 'task' });
  reply = { body: { version: '0.6.0\u001b[2J\nFAKE', build: 'b'.repeat(500) + '\u202e' } };
  const cleaned = await startup.readPortHolder(port);
  assert.equal(cleaned.version, '0.6.0[2JFAKE', 'control characters dropped: a holder cannot draw on this window');
  assert.equal(cleaned.build, 'b'.repeat(80), 'cut short');
  for (const [r, why] of [
    [{ status: 404, body: { version: '0.5.1', build: 'x' } }, 'not 200'],
    [{ body: 'not json' }, 'not JSON'],
    [{ body: ['0.5.1'] }, 'a list'],
    [{ body: { version: 5, build: 'x' } }, 'a version that is not words'],
    [{ body: { version: '0.5.1' } }, 'no build'],
    [{ body: { version: '\u0007', build: 'x' } }, 'nothing left once cleaned'],
    [{ body: { version: '0.5.1', build: 'x', pad: 'p'.repeat(300 * 1024) } }, 'an answer too large to be a health'],
    [{ cut: '{"version":"0.5.1","build":' }, 'an answer cut off part way'],
  ]) { reply = r; assert.equal(await startup.readPortHolder(port), null, why); }
  for (const r of fake.requests) {
    assert.equal(r.method, 'GET');
    assert.equal(r.url, '/api/health');
    assert.ok(!('authorization' in r.headers) && !('cookie' in r.headers), 'no token, no cookie: ' + JSON.stringify(r.headers));
  }

  const silentPort = await h.freePort();
  const silent = await silentHolder(silentPort);
  t.after(() => silent.close());
  const t0 = Date.now();
  assert.equal(await startup.readPortHolder(silentPort, { timeoutMs: 150 }), null, 'a holder that never answers');
  assert.ok(Date.now() - t0 < 1500, 'bounded by its timeout');
  assert.equal(await startup.readPortHolder(await h.freePort(), { timeoutMs: 150 }), null, 'nothing listening');
  for (const bad of [-1, 70000]) assert.equal(await startup.readPortHolder(bad, { timeoutMs: 150 }), null, 'a port no request can be made to resolves, never rejects: ' + bad);
});

test('the port\'s holder: the words for each holder, in each channel', () => {
  const at = { port: 3023 };
  assert.equal(startup.portHolderWords(null, at), 'Another program is using port 3023. Close it, or set PORT to another number.');
  assert.equal(startup.portHolderWords({ version: '0.5.1', build: '0.5.1+9.abc1234', runs: '' }, at),
    'AGMessage 0.5.1 (build 0.5.1+9.abc1234) is already running on port 3023. Use its window, or close it and start this copy again.');
  assert.equal(startup.portHolderWords({ version: '0.6.0', build: '0.6.0+3.def5678', runs: 'task' }, { ...at, runs: 'portable' }),
    'The AGMessage installed on this PC (0.6.0, build 0.6.0+3.def5678) is serving on port 3023. Open it from Start → AGMessage → Open AGMessage, or set PORT to another number to run this copy beside it.');
  const task = { ...at, runs: 'task' };
  assert.equal(startup.portHolderWords(null, task), 'Another program is using port 3023. AGMessage tries again; AGMessage status names the program\'s process.');
  for (const runs of ['', 'task']) {
    assert.equal(startup.portHolderWords({ version: '0.6.0', build: '0.6.0+4.aaa1111', runs }, task),
      'Another copy of AGMessage, 0.6.0 (build 0.6.0+4.aaa1111), holds port 3023. Close its window: AGMessage takes the port back on its next try.');
  }
});

/** A server started on a port someone else holds (with `settings` in its data folder): resolves {code, out, ms, exitAt} once it has gone. */
function refused(port, env = {}, settings = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-port-'));
  if (settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', AGM_UPLOAD_DIR: dataDir + '-uploads', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), 15000);   // a copy that served on a held port is a failure, not a hang
    c.on('exit', (code) => { clearTimeout(kill); resolve({ code, out, ms: Date.now() - t0, exitAt: Date.now() }); });
  });
}

test('a port in use says who holds it, and the copy stops without serving; the read sends no token', async (t) => {
  const ports = await Promise.all([1, 2, 3, 4, 5].map(() => h.freePort()));
  const older = await fakeHealth(ports[0], { body: { ok: true, version: '0.5.1', build: '0.5.1+9.abc1234', uptime: 60 } });
  const installed = await fakeHealth(ports[1], { body: { ok: true, version: '0.6.0', build: '0.6.0+3.def5678', install: { runs: 'task' } } });
  const other = await silentHolder(ports[2]);
  const olderForTask = await fakeHealth(ports[3], { body: { ok: true, version: '0.6.0', build: '0.6.0+4.aaa1111' } });
  const otherForTask = await silentHolder(ports[4]);
  t.after(() => Promise.all([older, installed, other, olderForTask, otherForTask].map((f) => f.close())));

  const [a, b, c, d, e] = await Promise.all([
    refused(ports[0]), refused(ports[1], { AGM_RUNS: 'portable' }), refused(ports[2]),
    refused(ports[3], { AGM_RUNS: 'task' }), refused(ports[4], { AGM_RUNS: 'task' }),
  ]);
  for (const r of [a, b, c]) assert.equal(r.code, 3, 'a portable copy: "cannot run as configured", which the watchdog does not restart:\n' + r.out);
  for (const r of [a, b, c, d, e]) {
    assert.notEqual(r.code, 0, 'it ended as refused (the installed node\'s own code is its channel\'s):\n' + r.out);
    assert.ok(!/is running/.test(r.out), 'it never served:\n' + r.out);
  }
  assert.ok(a.out.includes(`AGMessage 0.5.1 (build 0.5.1+9.abc1234) is already running on port ${ports[0]}. Use its window, or close it and start this copy again.`), a.out);
  assert.ok(b.out.includes(`The AGMessage installed on this PC (0.6.0, build 0.6.0+3.def5678) is serving on port ${ports[1]}.`), b.out);
  assert.ok(c.out.includes(`Another program is using port ${ports[2]}. Close it, or set PORT to another number.`), c.out);
  assert.ok(c.ms < 10000 && !/is already running|installed on this PC/.test(c.out), 'a holder that never answers is another program, once the read gives up');
  assert.ok(d.out.includes(`Another copy of AGMessage, 0.6.0 (build 0.6.0+4.aaa1111), holds port ${ports[3]}. Close its window: AGMessage takes the port back on its next try.`), d.out);
  assert.ok(e.out.includes(`Another program is using port ${ports[4]}. AGMessage tries again; AGMessage status names the program's process.`), e.out);

  for (const fake of [older, installed, olderForTask]) {
    assert.equal(fake.requests.length, 1, 'the holder is asked once');
    const [r] = fake.requests;
    assert.equal(r.method + ' ' + r.url, 'GET /api/health');
    assert.ok(!('authorization' in r.headers) && !('cookie' in r.headers), 'no token, no cookie: ' + JSON.stringify(r.headers));
    assert.ok(!JSON.stringify(r.headers).includes(h.TOKEN), 'the admin token goes nowhere');
  }
});

test('a copy refused at the port leaves the show network before it reads the holder', async (t) => {
  // The holder never answers, so the read waits out its whole second. The copy's Stagewatch link, started before the port
  // was known, is stopped when the port is refused: a connection it made is closed then (or never made), not a second
  // later when the copy exits.
  const [port, swPort] = await Promise.all([h.freePort(), h.freePort()]);
  const holder = await silentHolder(port);
  const stagewatch = await silentHolder(swPort);
  t.after(() => Promise.all([holder.close(), stagewatch.close()]));
  const r = await refused(port, {}, { nodeId: 'a1b2c3d4', stagewatchUrl: 'http://127.0.0.1:' + swPort });
  assert.equal(r.code, 3, r.out);
  assert.ok(r.out.includes(`Another program is using port ${port}.`), r.out);
  assert.ok(r.ms >= 900, 'the read waited for the holder:\n' + r.out);
  assert.ok(await until(() => stagewatch.conns.every((c) => c.closedAt > 0)), 'every connection the link made is closed');
  for (const c of stagewatch.conns) {
    assert.ok(r.exitAt - c.closedAt >= 500, `the Stagewatch link was closed when the port was refused, not when the copy exited (closed ${r.exitAt - c.closedAt} ms before exit)`);
  }
});
