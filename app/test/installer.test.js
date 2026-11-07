'use strict';
// The installer (the 0.6.0 plan's Part 6, unit U13): installer/AGMessage.iss and what it runs. The script itself is
// compiled and its life cycle run on Windows only (the installer job builds it; its life cycle is a later unit's elevated
// job); here it is held by its text to what it must and must not do, and every machine-level act it asks for is one of
// app/machine.js's commands, each run here against stand-ins for Windows' programs and, where it asks AGMessage, a real
// server: whose AGMessage it is (whose), the start and its verify (start), the first admin account (first-account), the
// open console of the Start menu (preinstall-check --app, upgrade-stop --app), the busy line the busy page shows, and
// the launcher (launch.js open). The defines it is compiled with are tools/installer-defines.js's, read from a stage.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const launch = require('../launch');
const defines = require('../../tools/installer-defines.js');

const SYS = 'C:\\Windows\\System32';
const ANA = 'S-1-5-21-111-222-333-1001';
const BEN = 'S-1-5-21-111-222-333-1002';
const IT = 'S-1-5-21-111-222-333-500';
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const base = (exe) => path.win32.basename(exe);
const ISS = h.readSource(path.join(h.REPO, 'installer', 'AGMessage.iss'));
/** The machine folder as a full path on this platform: launch.js takes the one Inno passes, {commonappdata}\AGMessage. */
const MACHINE = path.join(os.tmpdir(), 'ProgramData', 'AGMessage');
const CODE = ISS.slice(ISS.indexOf('\n[Code]\n'));

/**
 * A stand-in for Windows' programs, each answer by its absolute path's name: whoami (`me`), the scripts (`whose`,
 * `programs`: the answers PS_WHOSE and PS_PROGRAMS give, or a function of what they are handed), schtasks and reg. What
 * each was asked is kept in order, with the environment powershell.exe was handed.
 */
function windows({ me = '"laptop\\it-admin","' + IT + '"', whose = {}, programs = { programs: [] }, record = null } = {}) {
  const calls = [];
  const run = (exe, args, opts) => {
    const name = base(exe);
    calls.push({ exe, name, args, env: opts && opts.env, cwd: opts && opts.cwd });
    if (name === 'whoami.exe') return me + '\r\n';
    if (name === 'powershell.exe') {
      const script = args[args.length - 1];
      const answer = (a) => JSON.stringify(typeof a === 'function' ? a(opts.env) : a) + '\r\n';
      if (script === machine.PS_WHOSE) return answer(whose);
      if (script === machine.PS_PROGRAMS) return answer(programs);
      if (script === machine.PS_STATUS) return '{"pid":0,"codeIntegrity":{"found":false}}\r\n';
    }
    if (name === 'schtasks.exe') return 'SUCCESS';
    if (name === 'reg.exe') { if (!record) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: 'none' }); return Object.entries(record).map(([k, v]) => '    ' + k + '    ' + (k === 'Port' ? 'REG_DWORD    0x' + Number(v).toString(16) : 'REG_SZ    ' + v)).join('\r\n'); }
    throw new Error('the stand-in was asked what it does not know: ' + name + ' ' + args.join(' '));
  };
  return { run, calls };
}
/** A machine folder with its setup folder's one-time folder, as prepare leaves them, and the whoami answer written in it. */
function setupWith(answer) {
  const root = path.join(tmp('agm-whose-'), 'AGMessage');
  const once = path.join(root, 'setup', 'a'.repeat(32));
  fs.mkdirSync(once, { recursive: true });
  const file = path.join(once, 'started.csv');
  if (answer !== null) fs.writeFileSync(file, answer);
  return { root, file };
}

// ---------------------------------------------------------------- whose AGMessage it is (the plan's U.5.1)

test('whose: a person\'s SID, and the whoami answer read by position; both readings naming one person decide it, said with who approved', () => {
  for (const sid of [ANA, IT, 'S-1-12-1-1-2-3-4']) assert.equal(machine.personSid(sid), true, sid);
  for (const sid of ['S-1-5-18', 'S-1-5-19', 'S-1-5-32-544', 'S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-21-111-222-333-513', 'S-1-5-87-1-2-3-4-5', 'S-1-5-80-1-2-3-4-5', 'nobody', '']) assert.equal(machine.personSid(sid), false, sid);
  assert.deepEqual(machine.accountOf('"laptop\\ana","' + ANA + '"\r\n'), { name: 'laptop\\ana', sid: ANA });
  assert.equal(machine.accountOf('ERROR: Access is denied.'), null);
  assert.equal(machine.accountOf('"laptop\\ana","not a sid"'), null);
  const ana = { name: 'LAPTOP\\ana', sid: ANA };
  const it = { name: 'LAPTOP\\it-admin', sid: IT };
  let w = machine.whoseOf({ started: ana, screen: ana, approver: it });
  assert.deepEqual([w.agree, w.admin, w.choices.length], [true, ana, 1]);
  assert.equal(w.words, 'AGMessage\'s admin on this PC will be LAPTOP\\ana, the account that started this installer. LAPTOP\\it-admin approved it and gets no AGMessage rights.', 'the plan\'s words');
  w = machine.whoseOf({ started: ana, screen: ana, approver: ana });
  assert.equal(w.words, 'AGMessage\'s admin on this PC will be LAPTOP\\ana, the account that started this installer.', 'the admin approved it itself: nobody else is named');
});

test('whose: readings that disagree, or one that cannot be read, are the person\'s to choose between, never a third; none is a refusal that asks for /ADMIN', () => {
  const ana = { name: 'LAPTOP\\ana', sid: ANA };
  const ben = { name: 'LAPTOP\\ben', sid: BEN };
  let w = machine.whoseOf({ started: ana, screen: ben });
  assert.deepEqual([w.agree, w.admin, w.choices.map((c) => c.sid)], [false, null, [ANA, BEN]]);
  assert.match(w.words, /^The account that started this installer is LAPTOP\\ana, and the account signed in at this screen is LAPTOP\\ben\. Choose which of them is AGMessage's admin on this PC/);
  w = machine.whoseOf({ started: ana, screen: { why: 'no explorer.exe runs in this session' } });
  assert.deepEqual(w.choices.map((c) => c.sid), [ANA], 'one reading read: asked, not decided');
  assert.match(w.words, /the account signed in at this screen could not be read \(no explorer\.exe runs in this session\)\. Choose it:/);
  // A deployment by SYSTEM with nobody at the screen: no person to offer.
  w = machine.whoseOf({ started: { name: 'NT AUTHORITY\\SYSTEM', sid: 'S-1-5-18' }, screen: { why: 'no explorer.exe runs in this session' } });
  assert.equal(w.refused, true);
  assert.equal(w.choices.length, 0);
  assert.match(w.words, /^AGMessage needs to know whose it is: add \/ADMIN=<account>\. The account that started this installer is SYSTEM \(a deployment\), not a person's account/);
  assert.ok(ISS.includes("QuietAdminWords = 'AGMessage needs to know whose it is: add /ADMIN=<account>.';"), 'the installer\'s quiet refusal says the same');
  // /ADMIN decides, only for an account Windows confirms is one person's here: a local user, or one with a profile on this
  // PC (it has signed in here; no group ever has one).
  w = machine.whoseOf({ started: ana, screen: ben, admin: ben });
  assert.deepEqual([w.agree, w.admin.sid], [true, BEN]);
  assert.match(w.words, /^AGMessage's admin on this PC will be LAPTOP\\ben, as \/ADMIN names it\./);
  const answer = (o) => ({ sid: BEN, name: 'LAPTOP\\ben', translated: true, group: false, user: false, profile: false, ...o });
  assert.deepEqual(machine.adminOf('LAPTOP\\ben', answer({ user: true })), ben, 'a local user');
  const DOMAIN_ANA = 'S-1-5-21-444-555-666-1104';
  assert.deepEqual(machine.adminOf('VENUE\\ana', answer({ sid: DOMAIN_ANA, name: 'VENUE\\ana', profile: true })), { name: 'VENUE\\ana', sid: DOMAIN_ANA }, 'a domain account that has signed in here');
  const ENTRA = 'S-1-12-1-11-22-33-44';
  assert.deepEqual(machine.adminOf('AzureAD\\ana', answer({ sid: ENTRA, name: 'AzureAD\\ana', profile: true })).sid, ENTRA, 'a work account that has signed in here');
  assert.throws(() => machine.adminOf('Administrators', answer({ sid: 'S-1-5-32-544', name: 'BUILTIN\\Administrators', group: true })), /which is not one person's account \(a group or a service\)/);
  assert.throws(() => machine.adminOf('ShowCrew', answer({ sid: 'S-1-5-21-111-222-333-1005', name: 'LAPTOP\\ShowCrew', group: true })), /not one person's account/, 'a local group the admin made');
  assert.throws(() => machine.adminOf('LAPTOP\\nobody', { error: 'Some or all identity references could not be translated.' }), /which Windows does not know as an account on this PC \(Some or all identity/);
  // A group of a domain or of Entra ID has a person's shape and is no local group: no local user, no profile, refused.
  for (const [sid, name] of [['S-1-5-21-444-555-666-1105', 'VENUE\\Show Crew'], ['S-1-12-1-55-66-77-88', 'AzureAD\\Show Crew']]) {
    assert.throws(() => machine.adminOf(name, answer({ sid, name })), (e) => e.refused && /which Windows cannot confirm is one person's account on this PC: it is no local account and has never signed in here/.test(e.words), name);
  }
  // A SID Windows names no account for (typed as a SID, so it "resolves" without one): refused, never taken as given.
  assert.throws(() => machine.adminOf('S-1-5-21-444-555-666-1999', answer({ sid: 'S-1-5-21-444-555-666-1999', name: '', translated: false, user: false, profile: true })), /which Windows does not know as an account on this PC/);
});

test('machine.js whose: the account that started Setup read from its one-time file and the file removed, explorer.exe\'s owner and the names from one powershell.exe, its values handed in by name; flat fields for the installer', async () => {
  const { root, file } = setupWith('"LAPTOP\\ana","' + ANA + '"\r\n');
  const win = windows({ whose: (env) => ({ session: 1, screen: [ANA], names: { [ANA]: 'LAPTOP\\ana', [IT]: 'LAPTOP\\it-admin', sids: env.AGM_SIDS } }) });
  const out = path.join(root, '..', 'whose.json');
  let r = await machine.run(['whose', '--machine', root, '--sys', SYS, '--started', file, '--out', out], { run: win.run });
  assert.equal(r.code, 0, r.text);
  const j = JSON.parse(read(out));
  assert.deepEqual([j.agree, j.admin, j.adminName, j.approverName, j.choiceCount, j.startedSid, j.screenSid], [true, ANA, 'LAPTOP\\ana', 'LAPTOP\\it-admin', 1, ANA, ANA]);
  assert.equal(j.words, 'AGMessage\'s admin on this PC will be LAPTOP\\ana, the account that started this installer. LAPTOP\\it-admin approved it and gets no AGMessage rights.');
  assert.equal(fs.existsSync(file), false, 'the one-time answer is read once, then removed');
  const ps = win.calls.find((c) => c.name === 'powershell.exe');
  assert.equal(ps.env.AGM_SIDS, IT + ',' + ANA, 'the SIDs to name are handed in by name, never written into the script');
  assert.equal(ps.env.AGM_ACCOUNT, undefined, 'no /ADMIN, nothing to resolve');
  assert.deepEqual(win.calls.map((c) => [c.name, c.cwd]), [['whoami.exe', SYS], ['powershell.exe', SYS]], 'each by its absolute path in --sys, from there');
  assert.equal(win.calls[0].exe, path.win32.join(SYS, 'whoami.exe'));
  // They disagree: the two choices, flat, for the installer's page.
  const two = setupWith('"LAPTOP\\ana","' + ANA + '"');
  r = await machine.run(['whose', '--machine', two.root, '--sys', SYS, '--started', two.file, '--out', out], { run: windows({ whose: { screen: [BEN], names: { [ANA]: 'LAPTOP\\ana', [BEN]: 'LAPTOP\\ben' } } }).run });
  let k = JSON.parse(read(out));
  assert.deepEqual([r.code, k.agree, k.admin, k.choiceCount, k.choice1Sid, k.choice1Name, k.choice2Sid, k.choice2Name], [0, false, '', 2, ANA, 'LAPTOP\\ana', BEN, 'LAPTOP\\ben']);
  // /ADMIN resolved by Windows and handed in by name; a group refused (3).
  const three = setupWith(null);
  r = await machine.run(['whose', '--machine', three.root, '--sys', SYS, '--started', three.file, '--admin', 'LAPTOP\\ben', '--out', out], { run: windows({ whose: (env) => ({ screen: [], names: {}, account: { sid: env.AGM_ACCOUNT === 'LAPTOP\\ben' ? BEN : '', name: 'LAPTOP\\ben', translated: true, group: false, user: true, profile: false } }) }).run });
  k = JSON.parse(read(out));
  assert.deepEqual([r.code, k.agree, k.admin, k.adminName], [0, true, BEN, 'LAPTOP\\ben']);
  r = await machine.run(['whose', '--machine', three.root, '--sys', SYS, '--admin', 'Users', '--out', out], { run: windows({ whose: { screen: [], names: {}, account: { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users', translated: true, group: true, user: false, profile: false } } }).run });
  assert.deepEqual([r.code, JSON.parse(read(out)).code], [3, 3]);
  assert.match(r.text, /BUILTIN\\Users, which is not one person's account/);
  // Nobody to offer (a SYSTEM deployment, no screen): refused, with the plan's words.
  const sys = setupWith('"nt authority\\system","S-1-5-18"');
  r = await machine.run(['whose', '--machine', sys.root, '--sys', SYS, '--started', sys.file], { run: windows({ me: '"nt authority\\system","S-1-5-18"', whose: { screen: [], names: {} } }).run });
  assert.equal(r.code, 3);
  assert.match(r.text, /^AGMessage needs to know whose it is: add \/ADMIN=<account>\./);
  // The answer is taken only from a file of a one-time folder of setup\, and only when it is a real file.
  assert.equal((await machine.run(['whose', '--machine', root, '--sys', SYS, '--started', path.join(root, 'elsewhere.csv')], { run: win.run })).code, 64);
  assert.equal((await machine.run(['whose', '--machine', root, '--sys', SYS, '--started', path.join(root, 'setup', 'not-hex', 'x.csv')], { run: win.run })).code, 64);
  const linked = setupWith(null);
  assert.deepEqual(machine.startedFrom(fs, linked.root, path.join(path.dirname(linked.file), 'none.csv')), { why: 'it wrote no answer' });
  // A file link needs an administrator on Windows; there a folder in its place stands for it.
  if (process.platform === 'win32') fs.mkdirSync(linked.file);
  else {
    const target = path.join(tmp('agm-elsewhere-'), 'answer.csv');
    fs.writeFileSync(target, '"LAPTOP\\ben","' + BEN + '"');
    fs.symlinkSync(target, linked.file);
  }
  assert.deepEqual(machine.startedFrom(fs, linked.root, linked.file), { why: 'what is there is not a file it wrote' });
});

test('on Windows, whose\'s and the programs\' scripts answer in their own shape: this account by whoami, this session\'s explorer.exe owners and their names, an account resolved, this test\'s own node.exe found by its folder', { skip: process.platform !== 'win32' && 'the scripts run on Windows only' }, () => {
  const sys = path.win32.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32');
  const H = machine.hands(sys);
  const me = H.whoami(['/user', '/fo', 'csv', '/nh']);
  const account = machine.accountOf(me.out);
  assert.ok(account && /^S-1-\d/.test(account.sid), 'whoami read by position: ' + me.out);
  const w = H.powershell(machine.PS_WHOSE, { AGM_SIDS: account.sid, AGM_ACCOUNT: account.sid });
  assert.equal(w.error, undefined, JSON.stringify(w));
  assert.ok(Number.isInteger(w.session), 'this process\'s session: ' + JSON.stringify(w));
  assert.ok(typeof w.screenError === 'string' || Array.isArray(w.screen) || typeof w.screen === 'string', 'the owners of explorer.exe here, none or some: ' + JSON.stringify(w));
  assert.equal(typeof w.names[account.sid], 'string', 'Windows names the SID');
  assert.deepEqual([w.account.sid, w.account.translated, typeof w.account.group, typeof w.account.user, typeof w.account.profile], [account.sid, true, 'boolean', 'boolean', 'boolean'], 'an account resolved from its SID, named, and whether it is a local group, a local user and has a profile here: ' + JSON.stringify(w.account));
  assert.ok(w.account.user === true || w.account.profile === true, 'the account this test runs as is confirmed one person\'s: ' + JSON.stringify(w.account));
  if (machine.personSid(account.sid)) assert.deepEqual(machine.adminOf(account.name, w.account).sid, account.sid, '/ADMIN naming this account is taken');
  const groups = H.powershell(machine.PS_WHOSE, { AGM_SIDS: '', AGM_ACCOUNT: 'S-1-5-32-545' });
  assert.deepEqual([groups.account.group, groups.account.user, groups.account.profile], [true, false, false], 'Users is a local group, no user, with no profile: ' + JSON.stringify(groups.account));
  const p = H.powershell(machine.PS_PROGRAMS, { AGM_APP: path.dirname(process.execPath) });
  assert.equal(p.error, undefined, JSON.stringify(p));
  const list = Array.isArray(p.programs) ? p.programs : [p.programs];
  const mine = list.find((x) => x && x.pid === process.pid);
  assert.ok(mine && /node\.exe$/i.test(mine.name) && typeof mine.cmd === 'string' && mine.exe.toLowerCase() === process.execPath.toLowerCase(), 'this test\'s own node.exe, found by its folder: ' + JSON.stringify(list.map((x) => x && x.pid)));
  assert.equal(mine.ancestor, true, 'this test is an ancestor of the script that listed it: its parent\'s chain is read');
});

// ---------------------------------------------------------------- the start and its verify

/**
 * A stand-in for AGMessage at loopback, from `afterMs`: /api/health answers `build`, the machine's hello `build` with the
 * proof under `token` (a random proof when `token` is null: a program that holds no token), /api/auth/me says `setup`, and
 * /api/setup answers made. `seen` keeps each request as "<connection> <method> <path>" and its body, `bytes` every byte
 * each connection was sent; `close` after the hello ends that connection.
 */
async function standIn({ build, afterMs = 0, setup = true, token = h.TOKEN, closeAfterHello = false } = {}) {
  const port = await h.freePort();
  const started = Date.now();
  const seen = [];
  const bytes = [];
  const srv = http.createServer((req, res) => {
    const conn = bytes.indexOf(req.socket.agmBytes);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ at: conn + ' ' + req.method + ' ' + req.url.replace(/\?.*$/, ''), body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('content-type', 'application/json');
      if (Date.now() - started < afterMs) { res.statusCode = 503; res.end('{}'); return; }
      if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, version: '0.6.0', build, install: { runs: 'task' } })); return; }
      if (req.url.startsWith('/api/machine/hello?c=')) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const challenge = req.url.slice('/api/machine/hello?c='.length);
        if (closeAfterHello) res.setHeader('connection', 'close');
        res.end(JSON.stringify({ ok: true, nonce, build, proof: token === null ? crypto.randomBytes(32).toString('hex') : machine.serverProof(machine.tokenOf(token), nonce, challenge) }));
        return;
      }
      if (req.url === '/api/auth/me') { res.end(JSON.stringify({ ok: true, account: null, setup })); return; }
      if (req.url === '/api/setup') { res.end(JSON.stringify({ ok: true, account: { username: 'ana' } })); return; }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  srv.on('connection', (sock) => { const b = { text: '' }; sock.agmBytes = b; bytes.push(b); sock.on('data', (d) => { b.text += d.toString('latin1'); }); });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  return { port, seen, bytes, close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); }) };
}
/** A machine folder holding the token the stand-ins prove themselves with. */
function withToken(root) {
  fs.mkdirSync(path.join(root, 'token'), { recursive: true });
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN + '\r\n');
  return root;
}

test('machine.js start: the server task run, and the server waited for until it proves it holds the machine folder\'s token as this build; whether the node has an account yet asked of it, on the connection it proved itself on', async (t) => {
  const root = withToken(tmp('agm-start-'));
  const s = await standIn({ build: '0.6.0+41.abc1234', afterMs: 600 });
  t.after(s.close);
  const win = windows();
  const out = path.join(root, 'start.json');
  const r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(s.port), '--build', '0.6.0+41.abc1234', '--out', out], { run: win.run });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, 'AGMessage build 0.6.0+41.abc1234 answers on port ' + s.port + ' and proves it holds this PC\'s token.');
  const j = JSON.parse(read(out));
  assert.deepEqual([j.answered, j.build, j.needsAccount], [true, '0.6.0+41.abc1234', true]);
  assert.deepEqual(win.calls.map((c) => c.args.slice(0, 3)), [['/Run', '/TN', machine.SERVER_TASK]], 'the task run, nothing ended');
  const asked = s.seen.filter((x) => !x.at.endsWith('/api/health')).map((x) => x.at);
  assert.equal(asked.at(-1).split(' ')[0], asked.at(-2).split(' ')[0], 'the account question on the hello\'s own connection');
  assert.deepEqual(asked.slice(-2).map((x) => x.split(' ').slice(1).join(' ')), ['GET /api/machine/hello', 'GET /api/auth/me']);
  assert.ok(!s.seen.some((x) => x.at.endsWith('/api/health')), 'the verify reads no unproven health');
  assert.ok(!s.bytes.some((b) => b.text.includes(h.TOKEN)), 'the token never crosses the socket');
  assert.equal(machine.START_WAIT_MS, 35_000, 'the watchdog\'s 30 s start window and 5 s for the task to start');
  assert.equal(machine.parse(['start', '--machine', root, '--port', '1', '--build', 'x', '--force', 'y']).problem, '"--force" is not an argument machine.js start knows.');
  assert.equal((await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(s.port), '--build', '0.6.0-dev+abc1234'], { run: win.run })).code, 64, 'a local build is no build an installer lays down');
});

test('machine.js start: a server that does not prove itself as this build in time is ended and refused as not done, its log\'s last lines said; a program answering the build\'s health that proves nothing is no answer; without --build any proven build counts', async (t) => {
  const root = withToken(tmp('agm-start-'));
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', 'server.log'), 'one\ntwo\nAGMessage cannot start as configured: the data folder is format 3\n');
  const old = await standIn({ build: '0.6.0+40.abc1234' });
  t.after(old.close);
  let win = windows();
  const out = path.join(root, 'start.json');
  let r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(old.port), '--build', '0.6.0+41.abc1234', '--out', out], { run: win.run, net: { waitMs: 700, portAnswers: async () => false } });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /^AGMessage 0\.6\.0\+41\.abc1234 did not start: it answered as build 0\.6\.0\+40\.abc1234, not 0\.6\.0\+41\.abc1234 within 1 s, so it was stopped\. The last lines of its log: one \| two \| AGMessage cannot start as configured/);
  const j = JSON.parse(read(out));
  assert.deepEqual([j.code, j.answered, j.build, j.tail.split('\n').length], [2, false, '0.6.0+40.abc1234', 3]);
  assert.deepEqual(win.calls.map((c) => c.args[0]), ['/Run', '/End'], 'ended, since it never served this build');
  // A program on the port that answers health with this very build, but holds no token: not the verify's answer.
  const impostor = await standIn({ build: '0.6.0+41.abc1234', token: null });
  t.after(impostor.close);
  r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(impostor.port), '--build', '0.6.0+41.abc1234', '--out', out], { run: windows().run, net: { waitMs: 400, portAnswers: async () => false } });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /^AGMessage 0\.6\.0\+41\.abc1234 did not start: the program on port \d+ did not prove it holds this PC's AGMessage token within 0 s, so it was stopped\./);
  assert.deepEqual([...new Set(impostor.seen.map((x) => x.at.split(' ').slice(1).join(' ')))], ['GET /api/machine/hello'], 'asked the hello alone, never whether it has an account');
  assert.equal(JSON.parse(read(out)).needsAccount, undefined, 'so no first-account page is opened on its word');
  // Nothing on the port at all.
  const port = await h.freePort();
  win = windows();
  r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(port)], { run: win.run, net: { waitMs: 400, portAnswers: async () => false } });
  assert.equal(r.code, 2);
  assert.match(r.text, /^AGMessage did not start: nothing answered on port \d+ within 0 s, so it was stopped\./);
  // No token to prove anything with (the first start writes it): said so.
  const bare = tmp('agm-start-');
  r = await machine.run(['start', '--machine', bare, '--sys', SYS, '--port', String(old.port)], { run: windows().run, net: { waitMs: 300, portAnswers: async () => false } });
  assert.equal(r.code, 2);
  assert.match(r.text, /did not start: its token \(token\\admin-token\) was never there to read, so nothing could prove it is this PC's AGMessage/);
  // No --build (the earlier build started again after an install that did not finish): any proven AGMessage counts.
  r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(old.port)], { run: windows().run });
  assert.equal(r.code, 0, r.text);
  // A task that cannot be run.
  const refused = (exe, args, opts) => { if (base(exe) === 'schtasks.exe') throw Object.assign(new Error('x'), { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }); return windows().run(exe, args, opts); };
  r = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', String(port)], { run: refused });
  assert.equal(r.code, 2);
  assert.match(r.text, /^The server task \\AGMessage\\Server could not be started \(ERROR: The system cannot find the file specified\.\)/);
});

// ---------------------------------------------------------------- the first admin account, through /api/setup

/** A machine folder as the installed node lays it out (its token the test server's), and a server serving from it. */
async function servedNode() {
  const root = tmp('agm-node-');
  for (const d of ['data', 'uploads', 'keys', 'token', path.join('machine', 'work')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN + '\r\n');
  const srv = await h.startServer({ AGM_DATA_DIR: path.join(root, 'data'), AGM_UPLOAD_DIR: path.join(root, 'uploads'), AGM_KEY_DIR: path.join(root, 'keys') });
  return { root, srv };
}

test('machine.js first-account: the first admin account made through /api/setup with the machine folder\'s token, from the installer\'s file, which is removed first; the password in no --out; a second refused in the server\'s words', async (t) => {
  const { root, srv } = await servedNode();
  t.after(() => h.stopServer(srv.child));
  const work = path.join(root, 'machine', 'work');
  const file = path.join(work, 'account.txt');
  const PASSWORD = 'four words make a key';
  // SaveStringsToUTF8File's form: a byte-order mark, CR LF between lines.
  fs.writeFileSync(file, '\uFEFFana\r\nAna Lopez\r\n' + PASSWORD + '\r\n');
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true, 'no account yet');
  const out = path.join(root, 'first.json');
  let r = await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', file, '--out', out]);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, 'The first admin account, ana, is made: sign in with it on AGMessage\'s page (Start → AGMessage → Open AGMessage).');
  assert.equal(fs.existsSync(file), false, 'the file that held the password is gone');
  const j = JSON.parse(read(out));
  assert.deepEqual([j.made, j.username], [true, 'ana']);
  assert.ok(!read(out).includes(PASSWORD) && !read(out).includes(h.TOKEN), 'no password and no token in --out');
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, false, 'the node has its first account');
  const signIn = await h.api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: PASSWORD });
  assert.equal(signIn.status, 200, 'it signs in with what the installer\'s page took');
  assert.ok(!srv.out().includes(PASSWORD), 'the password is in no line the server said');
  // A second: the server refuses in its own words (3), and the file is removed all the same.
  fs.writeFileSync(file, 'ben\r\nBen\r\n' + PASSWORD + '\r\n');
  r = await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', file, '--out', out]);
  assert.deepEqual([r.code, r.text, JSON.parse(read(out)).made, fs.existsSync(file)], [3, 'Accounts are set up already — sign in.', false, false]);
});

test('machine.js first-account: a password the server takes not is refused in its words and nothing is made; a file that is no file of machine\\work\\ is never read', async (t) => {
  const { root, srv } = await servedNode();
  t.after(() => h.stopServer(srv.child));
  const file = path.join(root, 'machine', 'work', 'account.txt');
  fs.writeFileSync(file, 'ana\r\nAna\r\nshort\r\n');
  let r = await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', file]);
  assert.equal(r.code, 3);
  assert.match(r.text, /^Use at least \d+ characters/);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true, 'no account was made');
  assert.equal(fs.existsSync(file), false);
  // Elsewhere than machine\work\, or a link there: refused before anything is read or asked.
  const outside = path.join(root, 'data', 'account.txt');
  fs.writeFileSync(outside, 'ana\r\nAna\r\nfour words make a key\r\n');
  assert.equal((await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', outside])).code, 64);
  assert.equal(fs.existsSync(outside), true, 'a file it may not take is left as it was');
  // A file link needs an administrator on Windows; there a folder in its place stands for it.
  if (process.platform === 'win32') fs.mkdirSync(file); else fs.symlinkSync(outside, file);
  r = await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', file]);
  assert.deepEqual([r.code, r.text], [3, '--account names something that is not a file the installer wrote: no account was made.']);
  assert.equal((await h.api(srv.base, 'GET', '/api/auth/me')).body.setup, true);
  // No token to read: refused, never a guess.
  fs.rmSync(path.join(root, 'token', 'admin-token'));
  fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, 'ana\r\nAna\r\nfour words make a key\r\n');
  r = await machine.run(['first-account', '--machine', root, '--port', String(srv.port), '--account', file]);
  assert.equal(r.code, 3);
  assert.match(r.text, /token \(token\\admin-token\) could not be read/);
  assert.deepEqual(machine.accountFile('\uFEFFa\nb\nc d e'), { username: 'a', name: 'b', password: 'c d e' });
});

test('machine.js first-account: a program on the port that proves nothing is asked the hello alone, and no byte it is sent holds the token or the password; nothing is said made', async (t) => {
  const PASSWORD = 'four words make a key';
  const account = (root) => { const f = path.join(root, 'machine', 'work', 'account.txt'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'ana\r\nAna\r\n' + PASSWORD + '\r\n'); return f; };
  const clean = (s) => { for (const b of s.bytes) { assert.ok(!b.text.includes(h.TOKEN), 'no byte holds the token'); assert.ok(!b.text.includes(PASSWORD), 'no byte holds the password'); } };
  // It holds no token: its hello's proof is not the token's.
  const impostor = await standIn({ build: '0.6.0+41.abc1234', token: null });
  t.after(impostor.close);
  let root = withToken(tmp('agm-first-'));
  const out = path.join(root, 'first.json');
  let r = await machine.run(['first-account', '--machine', root, '--port', String(impostor.port), '--account', account(root), '--build', '0.6.0+41.abc1234', '--out', out]);
  assert.equal(r.code, 3, r.text);
  assert.match(r.text, /^The program on port \d+ did not prove it holds this PC's AGMessage token, so neither the token nor the password was sent to it: no account was made\./);
  assert.equal(JSON.parse(read(out)).made, false);
  assert.deepEqual(impostor.seen.map((x) => x.at.split(' ').slice(1).join(' ')), ['GET /api/machine/hello'], 'asked nothing after the hello');
  clean(impostor);
  assert.equal(fs.existsSync(path.join(root, 'machine', 'work', 'account.txt')), false, 'the file is removed all the same');
  // It proves the token, then ends the connection it proved itself on: nothing else is written to any connection.
  const closer = await standIn({ build: '0.6.0+41.abc1234', closeAfterHello: true });
  t.after(closer.close);
  root = withToken(tmp('agm-first-'));
  r = await machine.run(['first-account', '--machine', root, '--port', String(closer.port), '--account', account(root)]);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /closed the connection it proved itself on before anything else was sent\): no account was made\.$/);
  assert.deepEqual(closer.seen.map((x) => x.at.split(' ').slice(1).join(' ')), ['GET /api/machine/hello']);
  clean(closer);
  // A proven server of another build than the one laid down: refused, nothing sent.
  const other = await standIn({ build: '0.6.0+40.abc1234' });
  t.after(other.close);
  root = withToken(tmp('agm-first-'));
  r = await machine.run(['first-account', '--machine', root, '--port', String(other.port), '--account', account(root), '--build', '0.6.0+41.abc1234']);
  assert.equal(r.code, 3, r.text);
  assert.match(r.text, /^AGMessage on port \d+ is build 0\.6\.0\+40\.abc1234, not 0\.6\.0\+41\.abc1234, the build this installer laid down: no account was made\.$/);
  assert.deepEqual(other.seen.map((x) => x.at.split(' ').slice(1).join(' ')), ['GET /api/machine/hello']);
  clean(other);
  // The proven server of this build: the hello, then /api/setup on that same connection, and only there.
  const mine = await standIn({ build: '0.6.0+41.abc1234' });
  t.after(mine.close);
  root = withToken(tmp('agm-first-'));
  r = await machine.run(['first-account', '--machine', root, '--port', String(mine.port), '--account', account(root), '--build', '0.6.0+41.abc1234']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(mine.seen.map((x) => x.at), ['0 GET /api/machine/hello', '0 POST /api/setup'], 'one connection, the hello first');
  assert.deepEqual(JSON.parse(mine.seen[1].body), { token: h.TOKEN, username: 'ana', name: 'Ana', password: PASSWORD });
  assert.deepEqual([mine.bytes.length, mine.bytes[0].text.includes(h.TOKEN), mine.bytes[0].text.includes(PASSWORD)], [1, true, true], 'the bytes each connection is sent are read: the proven server alone is sent the two');
  assert.equal(machine.parse(['first-account', '--machine', root, '--port', '1', '--account', 'x', '--build', '0.6.0-dev+abc1234']).opts['--build'], '0.6.0-dev+abc1234');
  assert.equal((await machine.run(['first-account', '--machine', root, '--port', '1', '--account', account(root), '--build', '0.6.0-dev+abc1234'])).code, 64, 'a local build is no build an installer lays down');
});

// ---------------------------------------------------------------- the busy page and an open console

test('preinstall-check: a busy AGMessage is refused with `busy` and its line of counts in --out, which the busy page shows; a typed reason lets it go on', async (t) => {
  const root = tmp('agm-busy-');
  for (const d of ['data', 'uploads', 'keys', 'token']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN);
  const srv = await h.startServer({ AGM_DATA_DIR: path.join(root, 'data'), AGM_UPLOAD_DIR: path.join(root, 'uploads'), AGM_KEY_DIR: path.join(root, 'keys') });
  t.after(() => h.stopServer(srv.child));
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  const out = path.join(root, 'check.json');
  let r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port), '--out', out]);
  let j = JSON.parse(read(out));
  assert.deepEqual([r.code, j.ready, j.busy], [0, true, false], r.text);
  assert.deepEqual(Object.keys(j.line), machine.BUSY_KEYS, 'the line\'s counts, in its order');
  const ana = await h.connect(srv.base);
  assert.equal((await h.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'board', invite: h.inviteOf(srv.dataDir, code) })).role, 'board');
  await h.emit(ana, 'message', { type: 'text', text: 'Hello' });
  ana.close();
  r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port), '--out', out]);
  j = JSON.parse(read(out));
  assert.deepEqual([r.code, j.busy, j.line.active], [3, true, 1]);
  assert.match(j.words, /^AGMessage is busy \(1 page active\): type a reason to go on anyway, or wait\.$/);
  assert.ok(ISS.includes("Result := (Code = 3) and JsonTrue(Json, 'busy');"), 'the busy page is shown on exactly that refusal');
  r = await machine.run(['preinstall-check', '--machine', root, '--port', String(srv.port), '--force', 'the doors are closed', '--out', out]);
  assert.deepEqual([r.code, JSON.parse(read(out)).busy], [0, true], 'a typed reason goes on, the line still said');
});

test('the programs of {app}: the server task\'s own told from a person\'s console by their command line; preinstall-check refuses a console before anything is stopped, upgrade-stop one still running once the server has ended', async () => {
  const APP = 'C:\\Program Files\\AGMessage';
  const node = APP + '\\node\\node.exe';
  const serve = { pid: 4120, name: 'node.exe', cmd: '"' + node + '" "' + APP + '\\app\\launch.js" serve --data "C:\\ProgramData\\AGMessage\\data"' };
  const watchdog = { pid: 4121, name: 'node.exe', cmd: '"' + node + '" "' + APP + '\\app\\supervise.js"' };
  const server = { pid: 4122, name: 'node.exe', cmd: '"' + node + '" ' + APP + '\\app\\server.js' };
  const tunnel = { pid: 4123, name: 'cloudflared.exe', cmd: '"' + APP + '\\bin\\cloudflared.exe" tunnel --url http://localhost:3023' };
  const token = { pid: 5000, name: 'node.exe', cmd: '"' + node + '" "' + APP + '\\app\\launch.js" token --machine "C:\\ProgramData\\AGMessage" --sys "C:\\Windows\\system32"' };
  for (const p of [serve, watchdog, server, tunnel]) assert.equal(machine.serverProgram(p), true, p.cmd);
  for (const p of [token, { pid: 1, name: 'node.exe', cmd: '"' + node + '" "' + APP + '\\app\\launch.js" open' }, { pid: 2, name: 'notepad.exe', cmd: 'notepad' }, { pid: 3, name: 'node.exe', cmd: '"' + node + '" -e 1' }]) assert.equal(machine.serverProgram(p), false, p.cmd);
  assert.equal(machine.programWords([token, server, tunnel, serve]), 'node.exe (pid 5000), node.exe (pid 4122), cloudflared.exe (pid 4123) and 1 more');
  const root = tmp('agm-progs-');
  // A console of the Start menu open: refused before the port is asked, naming it; the command line is never said.
  let win = windows({ programs: (env) => ({ programs: env.AGM_APP === APP ? [serve, watchdog, server, token] : [] }) });
  let r = await machine.run(['preinstall-check', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP, '--out', path.join(root, 'c.json')], { run: win.run, net: { portAnswers: async () => { throw new Error('never asked'); } } });
  assert.equal(r.code, 3);
  assert.equal(r.text, 'AGMessage\'s own console is open (node.exe (pid 5000) runs from ' + APP + '): close its window, then continue.');
  assert.deepEqual(JSON.parse(read(path.join(root, 'c.json'))).programs, [{ pid: 5000, name: 'node.exe' }]);
  assert.ok(!read(path.join(root, 'c.json')).includes('--machine'), 'no command line in --out');
  // Only the server's own: the check goes on to the port.
  win = windows({ programs: { programs: [serve, watchdog, server] } });
  r = await machine.run(['preinstall-check', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP], { run: win.run, net: { portAnswers: async () => false } });
  assert.deepEqual([r.code, r.text], [0, 'Port 3023 is free: nothing is serving on it.']);
  // A list that cannot be read is refused, fail closed; --app needs --sys.
  r = await machine.run(['preinstall-check', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP], { run: windows({ programs: { error: 'Access is denied' } }).run });
  assert.deepEqual([r.code, /What runs from .* could not be read \(Access is denied\)/.test(r.text)], [3, true]);
  assert.equal((await machine.run(['preinstall-check', '--machine', root, '--port', '3023', '--app', APP], { net: { portAnswers: async () => false } })).code, 64);
  // upgrade-stop: the server stopped and saved, then a program of {app} that does not end is refused, naming it.
  fs.mkdirSync(path.join(root, 'token'));
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), h.TOKEN);
  const stop = async () => ({ ok: true, status: 200, json: { ok: true, stopping: true } });
  const net = { stop, portAnswers: async () => false, estimate: () => ({ copyBytes: 0, free: null }), programsWaitMs: 300 };
  r = await machine.run(['upgrade-stop', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP], { run: windows({ programs: { programs: [token] } }).run, net });
  assert.equal(r.code, 3);
  assert.match(r.text, /^AGMessage stopped for the upgrade at \d\d:\d\d, but node\.exe \(pid 5000\) still runs from C:\\Program Files\\AGMessage: close it, then run the installer again\.$/);
  // The server's own programs end after it: once they have, the stop's record is read as before.
  let asked = 0;
  win = windows({ programs: () => ({ programs: asked++ < 2 ? [watchdog] : [] }) });
  fs.mkdirSync(path.join(root, 'data'));
  const saved = { stop: async () => { fs.writeFileSync(path.join(root, 'data', 'last-stop.json'), JSON.stringify({ at: Date.now() + 1000, saved: true, backup: 'backups/upgrade-0.6.0+40.abc1234-20261107T010000Z-abcdef' })); return stop(); } };
  r = await machine.run(['upgrade-stop', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP], { run: win.run, net: { ...net, ...saved } });
  assert.equal(r.code, 0, r.text);
  assert.ok(asked >= 3, 'asked again until the watchdog had ended');
});

test('the installer\'s own chain is left out of the programs of {app}: the kept installer running the way back (and its instance that asked for the elevation) passes preinstall-check; any other program of {app}, an ancestor or not, is refused', async () => {
  const APP = 'C:\\Program Files\\AGMessage';
  const KEPT = APP + '\\installers\\AGMessage-Setup-0.6.40-unsigned.exe';
  const loader = { pid: 6100, name: 'AGMessage-Setup-0.6.40-unsigned.exe', cmd: '"' + KEPT + '" /VERYSILENT /ROLLBACK', exe: KEPT, ancestor: true };
  const asker = { ...loader, pid: 6090, ancestor: false };
  const older = { pid: 6200, name: 'AGMessage-Setup-0.6.39-unsigned.exe', cmd: 'x', exe: APP + '\\installers\\AGMessage-Setup-0.6.39-unsigned.exe', ancestor: false };
  const nodeUp = { pid: 6300, name: 'node.exe', cmd: '"' + APP + '\\node\\node.exe" "' + APP + '\\app\\machine.js" back', exe: APP + '\\node\\node.exe', ancestor: true };
  const elsewhere = { pid: 6400, name: 'AGMessage-Setup-0.6.40-unsigned.exe', cmd: 'x', exe: APP + '\\AGMessage-Setup-0.6.40-unsigned.exe', ancestor: true };
  const pids = (list) => machine.outsideOwnChain(list, APP).map((p) => p.pid);
  assert.deepEqual(pids([loader, asker]), [], 'the running kept installer, both its instances');
  assert.deepEqual(pids([asker]), [6090], 'a kept installer this check was not run by stays');
  assert.deepEqual(pids([loader, older, nodeUp, elsewhere]), [6200, 6300, 6400], 'another kept installer, a node.exe of {app} and a look-alike outside installers\\ stay, ancestors or not');
  assert.deepEqual(pids([{ ...loader, exe: KEPT.toUpperCase() }]), [], 'Windows\' paths compared without case');
  const root = tmp('agm-chain-');
  const check = (programs, more = {}) => machine.run(['preinstall-check', '--machine', root, '--sys', SYS, '--port', '3023', '--app', APP, ...(more.rollback ? ['--rollback'] : [])], { run: windows({ programs: { programs } }).run, net: { portAnswers: async () => !!more.answers, pid: () => 4120 } });
  let r = await check([loader, asker]);
  assert.deepEqual([r.code, r.text], [0, 'Port 3023 is free: nothing is serving on it.'], 'the way back\'s own check passes');
  r = await check([loader, nodeUp]);
  assert.equal(r.code, 3);
  assert.match(r.text, /^AGMessage's own console is open \(node\.exe \(pid 6300\) runs from C:\\Program Files\\AGMessage\)/);
  // The way back stops nothing, so it lays nothing down while anything answers on the port.
  r = await check([loader], { rollback: true, answers: true });
  assert.equal(r.code, 3);
  assert.equal(r.text, 'Something answers on port 3023 (pid 4120): the way back lays an earlier build down only where nothing serves, once the newer build has ended. Stop it, then go back again.');
  r = await check([loader], { rollback: true });
  assert.equal(r.code, 0, 'nothing serving: the way back may lay its files down');
  assert.equal(machine.parse(['preinstall-check', '--rollback', 'x']).problem, '"x" is not an argument machine.js preinstall-check knows.', '--rollback takes no value');
});

test('machine.js waits for Enter only for a person reading it in a console: never on the installer\'s hidden runs, which name --out', () => {
  const src = h.readSource(path.join(h.ROOT, 'machine.js'));
  assert.match(src, /if \(process\.stdin\.isTTY && !argv\.includes\('--out'\)\) \{ process\.stdout\.write\('\\nPress Enter to close this window\.\\n'\)/);
  // Every call the installer makes of machine.js names --out.
  assert.ok(/Exec\(NodeExe, Arg\(MachineJs\) \+ ' ' \+ Verb \+ ' ' \+ Params \+ ' --out ' \+ Arg\(OutFile\)/.test(CODE));
  assert.ok(/' uninstall --machine ' \+ Arg\(MachineDir\) \+ ' --sys ' \+ Arg\(ExpandConstant\('\{sys\}'\)\) \+ ' --app ' \+ Arg\(ExpandConstant\('\{app\}'\)\) \+ ' --out ' \+ Arg\(Said\)/.test(CODE), 'the uninstall waits for the programs of {app}, and refuses an open console');
});

// ---------------------------------------------------------------- the launcher (launch.js open)

test('launch.js open: the browser opened by explorer.exe by its absolute path in the Windows folder --sys sits in, only when the installed node answers; the console closes', async () => {
  assert.deepEqual(launch.openPlan({ sys: SYS, url: 'http://localhost:3023', platform: 'win32' }), { file: 'C:\\Windows\\explorer.exe', args: ['http://localhost:3023'], cwd: 'C:\\Windows' });
  assert.equal(launch.openPlan({ sys: SYS, url: 'x', platform: 'linux' }), null, 'nothing opened off Windows');
  assert.equal(launch.openPlan({ sys: 'System32', url: 'x', platform: 'win32' }), null, 'nor from a folder not named from its drive');
  const spawned = [];
  const opener = (file, args, opts) => { spawned.push({ file, args, opts }); return { on() {}, unref() { spawned.at(-1).unref = true; } }; };
  const win = windows({ record: { AdminName: 'LAPTOP\\ana', Port: '3123' } });
  const r = await launch.openAgm({ machine: 'C:\\ProgramData\\AGMessage', sys: SYS, run: win.run, read: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, ask: async (port) => ({ state: 'agm', version: '0.6.0', build: '0.6.0+41.abc1234', runs: 'task', port }), spawn: opener, platform: 'win32' });
  assert.deepEqual([r.code, r.opened], [0, true]);
  assert.equal(r.text, 'Opening AGMessage 0.6.0 (build 0.6.0+41.abc1234) at http://localhost:3123 in your browser.', 'the port the install record names');
  assert.deepEqual(spawned.map((s) => [s.file, s.args, s.opts.detached, s.opts.stdio, s.unref]), [['C:\\Windows\\explorer.exe', ['http://localhost:3123'], true, 'ignore', true]]);
  // The console stays only when it did not open the browser.
  assert.match(h.readSource(path.join(h.ROOT, 'launch.js')), /if \(process\.stdin\.isTTY && !\(argv\[0\] === 'open' && code === DONE\)\) \{/);
});

test('launch.js open: anything but the installed node is said, with what to do, and nothing is opened: a portable copy, another program, a silent port, nothing serving', async () => {
  const opener = () => { throw new Error('nothing is opened'); };
  const noRecord = windows();
  const logs = (f) => { if (f.endsWith('server.log')) return 'first\nAGMessage cannot start as configured: the keys folder is not readable\n'; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const open = (state) => launch.openAgm({ machine: 'C:\\ProgramData\\AGMessage', sys: SYS, run: noRecord.run, read: logs, ask: async () => state, spawn: opener, platform: 'win32' });
  let r = await open({ state: 'agm', version: '0.5.1', build: '0.5.1+30.abc1234', runs: '' });
  assert.deepEqual([r.code, r.opened], [2, false]);
  assert.equal(r.text, 'A portable copy of AGMessage (0.5.1, build 0.5.1+30.abc1234) holds port 3023, not the AGMessage installed on this PC: use that copy\'s own window, or press Ctrl+C there to close it; the installed AGMessage takes the port back on its next try.', 'the default port when the record names none');
  r = await open({ state: 'other' });
  assert.match(r.text, /^Another program holds port 3023, so the AGMessage installed on this PC cannot serve on it/);
  r = await open({ state: 'silent' });
  assert.match(r.text, /^Something on port 3023 did not answer within 3 s/);
  r = await open({ state: 'none' });
  assert.equal(r.code, 2);
  assert.match(r.text, /^AGMessage is not serving on this PC\.\n {2}the server task: [^\n]+\n {2}the log's last line: AGMessage cannot start as configured: the keys folder is not readable\n\nAGMessage starts with Windows\. To start it now, restart this PC, or ask an administrator to run the task \\AGMessage\\Server in Task Scheduler\.$/);
  // Off Windows (or with no --sys from its drive) the installed node answering is said with its address, never opened.
  r = await launch.openAgm({ machine: '/m', sys: SYS, run: noRecord.run, read: logs, ask: async () => ({ state: 'agm', version: '0.6.0', build: 'b', runs: 'task' }), spawn: opener, platform: 'linux' });
  assert.deepEqual([r.code, r.opened], [2, false]);
  assert.match(r.text, /answers at http:\/\/localhost:3023, but no browser could be started from here/);
});

test('launch.js open asks /api/health once: AGMessage\'s answer read by type, another program\'s, and nothing at all, each told apart', async (t) => {
  const s = await standIn({ build: '0.6.0+41.abc1234' });
  t.after(s.close);
  assert.deepEqual(await launch.healthAt(s.port), { state: 'agm', version: '0.6.0', build: '0.6.0+41.abc1234', runs: 'task' });
  const other = http.createServer((req, res) => { res.statusCode = 404; res.end('not here'); });
  const otherPort = await h.freePort();
  await new Promise((resolve) => other.listen(otherPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  assert.deepEqual(await launch.healthAt(otherPort), { state: 'other' });
  assert.deepEqual(await launch.healthAt(await h.freePort()), { state: 'none' });
  const said = [];
  assert.equal(launch.main(['open', '--machine', MACHINE], { out: (x) => said.push(x) }), 64);
  assert.match(said[0], /^launch\.js open needs --sys <folder>, the System32 folder named from its drive/);
  assert.deepEqual(launch.parse(['open', '--machine', '/m', '--sys', SYS]), { verb: 'open', machine: '/m', sys: SYS });
  const code = await launch.main(['open', '--machine', '/m', '--sys', SYS], { out: (x) => said.push(x), run: windows().run, read: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, ask: async () => ({ state: 'none' }) });
  assert.equal(code, 2, 'main gives open\'s exit code once it has asked');
});

// ---------------------------------------------------------------- installer/AGMessage.iss, held by its text

test('the installer\'s [Setup]: one fixed AppId, Program Files only and no folder page, administrators only with no per-user form, Inno never closes AGMessage, no [Dirs] or [Registry]; a local build makes none', () => {
  const setup = ISS.slice(ISS.indexOf('\n[Setup]\n'), ISS.indexOf('\n[Files]\n'));
  const directives = new Map(setup.split('\n').map((l) => /^(\w+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  const directive = (name) => (directives.has(name) ? directives.get(name) : null);
  assert.match(directive('AppId'), /^\{\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/, 'one GUID, written once');
  assert.equal(directive('DefaultDirName'), '{autopf}\\AGMessage');
  assert.deepEqual([directive('DisableDirPage'), directive('UsePreviousAppDir'), directive('DisableProgramGroupPage')], ['yes', 'no', 'yes']);
  assert.equal(directive('PrivilegesRequired'), 'admin');
  assert.equal(directive('PrivilegesRequiredOverridesAllowed'), null, 'no per-user override of an installer that registers tasks');
  assert.ok(!/PrivilegesRequiredOverridesAllowed\s*=/.test(ISS));
  assert.deepEqual([directive('CloseApplications'), directive('RestartApplications')], ['no', 'no']);
  assert.equal(directive('OutputBaseFilename'), 'AGMessage-Setup-{#Label}-unsigned');
  assert.equal(directive('AppVersion'), '{#InstallVersion}', 'installs are ordered by MAJOR.MINOR.BUILD');
  assert.equal(directive('SetupLogging'), 'yes');
  assert.equal(directive('ArchitecturesInstallIn64BitMode'), 'x64os');
  assert.match(ISS, /^#ifndef InstallVersion\n {2}#error An installer is made from a numbered build only/m);
  for (const section of ['Dirs', 'Registry', 'Run', 'UninstallRun', 'UninstallDelete', 'Tasks']) assert.ok(!ISS.includes('\n[' + section + ']\n'), 'no [' + section + ']');
  assert.ok(!/HKLM|HKEY_LOCAL_MACHINE/.test(CODE.replace(/RegQuery(?:String|DWord)Value\(HKLM(?:64)?, /g, '')), 'the record is read here, never written: it is machine.js install\'s');
  assert.ok([...ISS].every((c) => c === '\n' || c === '\t' || (c >= ' ' && c <= '~')), 'ASCII only: ISCC reads it whatever its code page');
});

test('the installer\'s files: the checks\' node.exe and machine.js first, the stage laid whole, this installer kept by its install version (two kept, never copied over itself)', () => {
  const files = ISS.slice(ISS.indexOf('\n[Files]\n') + 9, ISS.indexOf('\n[Icons]\n')).split('\n').filter((l) => l.startsWith('Source:'));
  assert.deepEqual(files, [
    'Source: "{#Payload}\\node\\node.exe"; Flags: dontcopy',
    'Source: "{#Payload}\\app\\machine.js"; Flags: dontcopy',
    'Source: "{#Payload}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion',
    'Source: "{srcexe}"; DestDir: "{app}\\installers"; DestName: "AGMessage-Setup-{#InstallVersion}-unsigned.exe"; Flags: external ignoreversion; Check: KeepThisInstaller',
  ]);
  assert.match(CODE, /ExtractTemporaryFile\('node\.exe'\);\n {2}ExtractTemporaryFile\('machine\.js'\);/);
  assert.match(CODE, /Mine := 'AGMessage-Setup-\{#InstallVersion\}-unsigned\.exe';\n {2}Earlier := 'AGMessage-Setup-' \+ InstalledVersion \+ '-unsigned\.exe';/, 'this one and the earlier build\'s are kept');
});

test('the Start menu: each item is node.exe on launch.js, a verb launch.js knows with the folders it needs, run as the person and never elevated by itself', () => {
  const icons = ISS.slice(ISS.indexOf('\n[Icons]\n') + 9, ISS.indexOf('\n[Code]\n')).split('\n').filter((l) => l.startsWith('Name:'));
  const items = icons.map((l) => {
    const fields = new Map([...l.matchAll(/(\w+): "((?:[^"]|"")*)"/g)].map((m) => [m[1], m[2].replace(/""/g, '"')]));
    return { name: fields.get('Name'), file: fields.get('Filename'), params: fields.get('Parameters'), dir: fields.get('WorkingDir'), flags: /Flags:/.test(l) };
  });
  assert.deepEqual(items.map((i) => i.name), ['{group}\\Open AGMessage', '{group}\\Show the admin token', '{group}\\Start AGMessage', '{group}\\Stop AGMessage...', '{group}\\Who may run AGMessage...', '{group}\\AGMessage status'], 'the items this build has, in the plan\'s order: Upgrade and Go back are a later unit\'s');
  const verbs = [];
  for (const i of items) {
    assert.equal(i.file, '{app}\\node\\node.exe', i.name + ': the signed node.exe, never a .bat or a program of its own');
    assert.equal(i.dir, '{app}\\app');
    assert.equal(i.flags, false, i.name + ': no flag (none of Inno\'s asks for an elevation)');
    // {commonappdata} as a folder full on this platform (launch.js takes a full path), {sys} as Inno gives it.
    const argv = [...i.params.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]))
      .map((a) => a.replace('{commonappdata}\\AGMessage', MACHINE).replace('{sys}', SYS).replace('{app}', 'C:\\Program Files\\AGMessage'));
    assert.equal(argv[0], 'C:\\Program Files\\AGMessage\\app\\launch.js');
    const a = launch.parse(argv.slice(1));
    assert.equal(a.problem, undefined, i.name + ': ' + a.problem);
    assert.deepEqual([a.machine, a.sys], [MACHINE, SYS], i.name + ': its folders, as launch.js reads none from its environment');
    verbs.push(a.verb);
  }
  assert.deepEqual(verbs, ['open', 'token', 'start', 'stop', 'rights', 'status']);
});

test('the installer\'s code: every machine-level act is a machine.js command it knows, with options it takes; the password goes in a file of machine\\work\\, never a command line or the log', () => {
  const verbs = [...new Set([...CODE.matchAll(/Machine\('([a-z-]+)'/g)].map((m) => m[1]))];
  assert.deepEqual(verbs.sort(), ['first-account', 'install', 'preinstall-check', 'prepare', 'restore', 'start', 'upgrade-stop', 'whose']);
  for (const v of verbs) assert.ok(machine.VERBS.includes(v), v);
  assert.ok(machine.VERBS.includes('uninstall') && /' uninstall --machine '/.test(CODE), 'the uninstaller runs the installed machine.js uninstall');
  const known = new Set(Object.values(machine.VERB_OPTS).flat());
  const used = [...new Set([...CODE.matchAll(/'[^']*?(--[a-z-]+)/g)].map((m) => m[1]))];
  for (const o of used) assert.ok(known.has(o), o + ' is an option machine.js knows');
  // Where it runs in the order: prepare and whose at the start, the checks before the files, the rest after.
  const at = (re) => CODE.search(re);
  const init = at(/\nfunction InitializeSetup\(\)/);
  const prep = at(/\nfunction PrepareToInstall\(/);
  const post = at(/\nprocedure CurStepChanged\(/);
  assert.ok(at(/Machine\('prepare'/) > init && at(/Machine\('prepare'/) < prep, 'prepare once the elevation is in');
  assert.ok(CODE.indexOf("Machine('upgrade-stop'", prep) > prep && CODE.indexOf("Machine('upgrade-stop'", prep) < post, 'upgrade-stop in PrepareToInstall');
  assert.ok(CODE.indexOf("Machine('install'", post) > post && CODE.indexOf("Machine('start'", post) > CODE.indexOf("Machine('install'", post), 'install, then the start and its verify');
  // The password: in the account file's third line, compared once, never on a command line and never in the log.
  const pw = [...CODE.matchAll(/AccountPage\.Values\[(?:2|3)\]/g)].map((m) => CODE.slice(CODE.lastIndexOf('\n', m.index) + 1, CODE.indexOf('\n', m.index)).trim());
  assert.deepEqual(pw, [
    "if (Trim(AccountPage.Values[0]) = '') and (Trim(AccountPage.Values[1]) = '') and (AccountPage.Values[2] = '') and (AccountPage.Values[3] = '') then",
    "if (Trim(AccountPage.Values[0]) = '') and (Trim(AccountPage.Values[1]) = '') and (AccountPage.Values[2] = '') and (AccountPage.Values[3] = '') then",
    'if AccountPage.Values[2] <> AccountPage.Values[3] then',
    'if AccountPage.Values[2] <> AccountPage.Values[3] then',
    'Lines[2] := AccountPage.Values[2];',
  ]);
  assert.match(CODE, /FileName := MachineDir \+ '\\machine\\work\\account\.txt';/);
  assert.match(CODE, /Machine\('first-account', '--machine ' \+ Arg\(MachineDir\) \+ ' --port ' \+ IntToStr\(Port\) \+ ' --build ' \+ Arg\('\{#Full\}'\) \+ ' --account ' \+ Arg\(FileName\), Json, Words\);\n {2}DeleteFile\(FileName\);/, 'sent only to this build\'s server, proven');
  assert.ok(!/Log\([^)]*(?:Lines|AccountPage)/.test(CODE), 'nothing of the page is logged');
});

test('the installer\'s switches and refusals: /ADMIN, /PUBLICFIREWALL, /FORCE, /ROLLBACK and /REMOVEDATA; an older or the same build refused with words; /ROLLBACK only to the recorded Previous', () => {
  for (const s of ["{param:ADMIN|}", "{param:PUBLICFIREWALL|}", "{param:FORCE|}", "CmdLineHas('/ROLLBACK')", "CmdLineHas('/REMOVEDATA')"]) assert.ok(CODE.includes(s), s);
  assert.ok(CODE.includes("Refuse(InstalledWords() + ' is newer than this installer''s {#SemVer} (build {#Build}): uninstall it first to go back. Nothing was changed.');"));
  assert.ok(CODE.includes("Refuse(InstalledWords() + ' is installed already: an installer upgrades only an older build. Nothing was changed.');"));
  assert.ok(CODE.includes("if not ((CompareVersions(PreviousVersion, '{#InstallVersion}') = 0) or ((CompareVersions(InstalledVersion, '{#InstallVersion}') = 0) and (LaidVersion() <> '') and (CompareVersions(LaidVersion(), '{#InstallVersion}') <> 0))) then"), '/ROLLBACK lays back the recorded Previous, or the build the record still names only where the laid files are another build\'s');
  assert.ok(CODE.includes("Result := JsonText(Utf8File(InstallFolder() + '\\app\\build.json'), 'installVersion');"), 'the laid files\' build read from their own build.json');
  assert.match(CODE, /\n {2}if Rollback then Result := Result \+ ' --rollback';\n/, 'the way back\'s checks refuse anything answering on the port');
  assert.match(CODE, /\n {2}if Rollback then Params := Params \+ ' --rollback';\n {2}Code := Machine\('install', Params, Json, Words\);/, 'and its record names nothing to go back to');
  // /DIR= refused before prepare makes anything; a refusal after it says nothing was installed, never that nothing changed.
  const init = CODE.slice(CODE.indexOf('\nfunction InitializeSetup()'), CODE.indexOf('\nprocedure InitializeWizard()'));
  assert.ok(init.indexOf("{param:DIR|}") > 0 && init.indexOf("{param:DIR|}") < init.indexOf("Machine('prepare'"), '/DIR= before prepare');
  const prepare = CODE.slice(CODE.indexOf('\nfunction PrepareToInstall('), CODE.indexOf('\nprocedure KeepTwoInstallers()'));
  assert.ok(!prepare.includes('Nothing was changed.'), 'PrepareToInstall runs after prepare made the machine folder');
  assert.match(prepare, /Result := RefusalWords\(Json, Words, 'Nothing was installed\.'\);/);
  assert.match(CODE, /if JsonTrue\(Json, 'forceable'\) then\n {4}Result := Result \+ ' To go on anyway, run this installer again from a command prompt with \/FORCE="<why>"\.';/, 'a refusal a reason lifts says how, the wizard having no field for it');
  assert.match(prepare, /if JsonTrue\(Json, 'forced'\) then SuppressibleMsgBox\(Words, mbInformation, MB_OK, IDOK\);/, 'going on without a way back is said to the person');
  // A first install that did not start says what works: the record names this build, so this installer would refuse.
  assert.ok(!CODE.includes('Run this installer again once the cause is cleared'));
  assert.match(CODE, /Its server task starts it again with Windows: once the cause is cleared, restart this PC\. Or uninstall AGMessage/);
  assert.match(CODE, /To uninstall a busy AGMessage anyway, run "' \+ ExpandConstant\('\{uninstallexe\}'\) \+ '" \/FORCE="<why>" from a command prompt/, 'the uninstaller says its one way to stop a busy AGMessage anyway, whole');
  assert.match(CODE, /if WizardSilent and not Installed and \(Trim\(ExpandConstant\('\{param:ADMIN\|\}'\)\) = ''\) then\n {2}begin\n {4}Refuse\(QuietAdminWords/, 'a quiet first install names whose it is');
  assert.match(CODE, /PublicPage\.Add\('Also on Public networks \(hotels, airports, fresh venue Wi-Fi\)'\);/);
  assert.match(CODE, /if P = '1' then Result := True\n {2}else if P = '0' then Result := False\n {2}else Result := PublicRecorded;/, 'unticked unless asked, or kept as the record has it');
  assert.match(CODE, /RemoveData := MsgBox\(RemoveDataQuestion\(MachineDir\), mbConfirmation, MB_YESNO or MB_DEFBUTTON2\) = IDYES;/, 'the data is kept unless the person says Yes');
  assert.match(CODE, /'\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/ROLLBACK \/LOG=' \+ Arg\(/, 'the way back runs the kept installer of the earlier build');
  assert.ok(CODE.indexOf("Machine('restore'") < CODE.indexOf("/ROLLBACK /LOG="), 'the backup laid back before the earlier build starts');
  // The command line machine.js gets: one argument per value, as Windows reads it (machine.js winArg's rule).
  assert.match(CODE, /if S\[I\] = '"' then\n {8}Result := Result \+ StringOfChar\('\\', Slashes \* 2 \+ 1\)/);
});

test('the installer\'s defines: read from a stage\'s build.json by lib/version.js\'s rules; a local build makes none; the stage\'s two .bat files are left out', () => {
  const pkg = JSON.stringify({ version: '0.6.0' });
  const stamp = (channel) => JSON.stringify({ version: '0.6.0', build: 41, installVersion: '0.6.41', commit: 'abc1234def', channel, builtAt: '2026-11-07T00:00:00Z' });
  assert.deepEqual(defines.definesOf(pkg, stamp('release')), { SemVer: '0.6.0', Build: '41', InstallVersion: '0.6.41', FileVersion: '0.6.0.41', Full: '0.6.0+41.abc1234', Label: '0.6.0', LeftOut: ['start-agmessage.bat', 'make-shareable-copy.bat'] });
  assert.deepEqual(defines.definesOf(pkg, stamp('dev')).Label, '0.6.0-dev.41_abc1234', 'a CI build named as its zip is');
  assert.deepEqual(defines.definesOf(pkg, stamp('dev')).Full, '0.6.0-dev.41+abc1234');
  assert.equal(machine.installOf(defines.definesOf(pkg, stamp('dev')).Full).version, '0.6.41', 'the build machine.js install records');
  assert.throws(() => defines.definesOf(pkg, null), /made from a numbered build only/);
  assert.throws(() => defines.definesOf(pkg, '{not json'), /a local build of 0\.6\.0/);
  assert.throws(() => defines.definesOf(pkg, JSON.stringify({ version: '0.5.1', build: 41, installVersion: '0.5.41', commit: 'abc1234', channel: 'dev' })), /local build/, 'a stamp of another version is no stamp');
  // The two files left out are the two the portable build adds beside README.txt; every define the script uses is passed.
  assert.match(h.readSource(path.join(h.REPO, 'tools', 'build-portable.ps1')), /^Copy-Item README\.txt, start-agmessage\.bat, make-shareable-copy\.bat \$stage\r?$/m);
  const build = h.readSource(path.join(h.REPO, 'installer', 'build-installer.ps1'));
  const passed = [...build.matchAll(/"\/D(\w+)=/g)].map((m) => m[1]).sort();
  const usedInIss = [...new Set([...ISS.matchAll(/\{#(\w+)\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(passed, usedInIss, 'every {#…} the script uses is a define the build passes');
  assert.match(build, /foreach \(\$f in \$d\.LeftOut\) \{/, 'the .bat files taken out of the payload');
  assert.match(build, /if \(\$info\.FileVersion -ne \$d\.FileVersion -or \$info\.ProductVersion -ne \$d\.Full\) \{/, 'the file read back says the build');
  // The portable build lays every file the installer needs into the stage: each one of app\ by name, the rest by the
  // folder copied whole or the file copied to the stage's top. machine.js among them, which the installer and its
  // uninstaller run.
  const portable = h.readSource(path.join(h.REPO, 'tools', 'build-portable.ps1'));
  const toApp = new Set(portable.split('\n').filter((l) => l.includes('Copy-Item app\\') && l.includes('"$stage\\app"') && !l.includes('-Recurse'))
    .flatMap((l) => [...l.matchAll(/app\\([\w.-]+)(?=,| ")/g)].map((m) => m[1])));
  const whole = new Set([...portable.matchAll(/^Copy-Item (\w+) "\$stage\\\1" -Recurse\r?$/gm)].map((m) => m[1]));
  const top = new Set(portable.split('\n').filter((l) => /^Copy-Item [^"]+ \$stage\r?$/.test(l)).flatMap((l) => l.replace(/^Copy-Item /, '').replace(/ \$stage\r?$/, '').split(', ')));
  for (const f of defines.NEEDED) {
    const [first, ...rest] = f.split('/');
    const laid = first === 'app' && rest.length === 1 ? toApp.has(rest[0]) : rest.length ? whole.has(first) : top.has(first);
    assert.ok(laid, f + ' is laid into the stage by tools/build-portable.ps1');
  }
  assert.ok(toApp.has('machine.js') && toApp.has('launch.js'), 'the two programs the installed node runs from app\\');
  // A stage with what the installer runs: its defines; one without: refused with what it lacks.
  const stage = tmp('agm-stage-');
  for (const f of defines.NEEDED) { fs.mkdirSync(path.join(stage, ...f.split('/').slice(0, -1)), { recursive: true }); fs.writeFileSync(path.join(stage, ...f.split('/')), ''); }
  fs.writeFileSync(path.join(stage, 'app', 'package.json'), pkg);
  fs.writeFileSync(path.join(stage, 'app', 'build.json'), stamp('dev'));
  assert.equal(defines.stageDefines(stage).InstallVersion, '0.6.41');
  fs.rmSync(path.join(stage, 'licenses'), { recursive: true });
  assert.throws(() => defines.stageDefines(stage), /lacks licenses\/nodejs\/LICENSE, licenses\/cloudflared\/LICENSE$/);
});

test('the installer in CI: built on windows-2025 from the zip the package job built, Inno Setup pinned by hash and checked against its release\'s digest and its publisher\'s signature, every action pinned by its commit, kept as an artifact', () => {
  const ci = h.readSource(path.join(h.REPO, '.github', 'workflows', 'ci.yml'));
  const start = ci.indexOf('\n  installer:\n');
  const job = ci.slice(start, ci.indexOf('\n  readings:\n'));
  assert.ok(start > ci.indexOf('\n  package:\n'), 'after the package job');
  assert.match(job, /\n {4}needs: package\n {4}runs-on: windows-2025\n/);
  for (const [, ref, comment] of job.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)) assert.match(ref + comment, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, ref + ' is pinned by its commit');
  assert.match(job, /\$pin = '[0-9A-F]{64}'\n/);
  assert.match(job, /if \("\$digest"\.Trim\(\) -ne "sha256:\$\(\$pin\.ToLowerInvariant\(\)\)"\) \{ throw/, 'the pin is the release API\'s digest');
  assert.match(job, /if \(\$signature\.Status -ne 'Valid'\) \{ throw/);
  assert.match(job, /\.\/installer\/build-installer\.ps1 -Stage \(Join-Path \$dest 'AGMessage'\) -Iscc \$env:ISCC -Out installer-dist\n/);
  assert.match(job, /name: agmessage-installer-\$\{\{ github\.sha \}\}\n\s+path: \|\n\s+installer-dist\/AGMessage-Setup-\*-unsigned\.exe\n\s+installer-dist\/SHA256SUMS\.payload\n\s+if-no-files-found: error\n/);
  assert.ok(!/\/VERYSILENT[^\n]*AGMessage-Setup|Start-Process[^\n]*installer-dist/.test(job), 'built here, never run: its life cycle is an elevated job of its own');
  const release = ci.slice(ci.indexOf('\n  release:\n'));
  assert.match(release, /--generate-notes dist\/\*\.zip dist\/AGMessage-Setup-\*-unsigned\.exe dist\/SHA256SUMS\.payload dist\/agmessage-sbom\.cdx\.json dist\/SHA256SUMS\n/);
  assert.match(release, /Smart App Control: on a PC where it is on \(Windows Security > App & browser control > Smart App Control\), Windows blocks the installer and it never runs/, 'the release notes say the Smart App Control words');
  assert.ok(release.indexOf('name: agmessage-installer-$' + '{{ github.sha }}') < release.indexOf('sha256sum > SHA256SUMS'), 'SHA256SUMS made again once the installer is beside the zip');
});
