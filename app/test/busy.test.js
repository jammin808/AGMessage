'use strict';
// The busy line, and a stop that saves, at loopback with a proof of the token (the plan's Part 6, unit U8). The line holds
// counts only, presence is never activity, and a server that does not answer reads busy (lib/busy.js). The machine's
// requests at loopback (lib/machinewire.js) are answered only on this PC, with a nonce issued within its time and used
// once, and a proof of the token that compares; a wrong proof is counted toward the token's lockout. The stop saves, ends
// with 0, and writes server.stop.forced when a busy server is stopped with a typed reason. A program on the port without
// the token is asked nothing after the hello, and no byte the machine sends holds the token. The data folder's pipe
// answers the line, and a second copy refused at the folder says it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const h = require('./helpers');
const busy = require('../lib/busy');
const wire = require('../lib/machinewire');

const MIN = 60_000;
const read = (f) => fs.readFileSync(f, 'utf8');
/** The audit log's rows of `action` (none while nothing has been written to it). */
const auditRows = (dataDir, action) => {
  const file = path.join(dataDir, 'audit.jsonl');
  return (fs.existsSync(file) ? read(file) : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action);
};

// ---------------------------------------------------------------- the line (pure)

test('the busy line: counts only, each a whole number; read by type from another program; busy is activity or a countdown, never presence', () => {
  assert.deepEqual(busy.KEYS, ['active', 'takes', 'help', 'countdowns', 'seats', 'screens', 'sockets']);
  assert.equal(busy.WINDOW_MS, 10 * MIN);
  // Made: the keys in order, nothing else kept, anything not a whole number from 0 is 0.
  const made = busy.line({ active: 2, takes: 1.5, help: -1, countdowns: '3', seats: 4, screens: 1, sockets: 9, name: 'Ana', code: 'ABC234', token: 'x' });
  assert.deepEqual(made, { active: 2, takes: 0, help: 0, countdowns: 0, seats: 4, screens: 1, sockets: 9 });
  assert.deepEqual(Object.keys(made), busy.KEYS, 'no name, code, token or path ever rides in it');
  assert.deepEqual(busy.line(null), { active: 0, takes: 0, help: 0, countdowns: 0, seats: 0, screens: 0, sockets: 0 });
  // Read: a line, its first line only; anything else is no line.
  const text = JSON.stringify(made);
  assert.deepEqual(busy.read(text + '\nmore'), made);
  for (const bad of [
    JSON.stringify({ ...made, name: 'Ana' }), JSON.stringify({ ...made, active: '2' }), JSON.stringify({ ...made, help: -1 }),
    JSON.stringify({ ...made, takes: 0.5 }), JSON.stringify({ active: 1 }), '[1,2]', 'null', '"busy"', '{', '', undefined, 7,
    JSON.stringify({ ...made, sockets: 1 }) + ' '.repeat(1100),
  ]) assert.equal(busy.read(bad), null, String(bad).slice(0, 60));
  // Busy: input, a take or a help request in the window, or a countdown running; seats, screens and sockets never.
  const quiet = busy.line({ seats: 40, screens: 12, sockets: 60 });
  assert.equal(busy.isBusy(quiet), false, 'a full house that does nothing is not busy');
  for (const k of ['active', 'takes', 'help', 'countdowns']) assert.equal(busy.isBusy({ ...quiet, [k]: 1 }), true, k);
  assert.equal(busy.isBusy(null), false);
  // Words: what makes it busy, or what is open and quiet.
  assert.equal(busy.words(busy.line({ active: 3, takes: 1, help: 2, countdowns: 1, seats: 9 })), '3 pages active, 1 take changed, 2 help requests, a countdown running');
  assert.equal(busy.words(busy.line({ active: 1, countdowns: 2 })), '1 page active, 2 countdowns running');
  assert.equal(busy.words(busy.line({ takes: 2 })), '2 takes changed');
  assert.equal(busy.words(quiet), 'nothing in the last 10 minutes; 40 seats and 12 screens open');
  assert.equal(busy.words(busy.line({ seats: 1 })), 'nothing in the last 10 minutes; 1 seat open');
  assert.equal(busy.words(busy.line({ screens: 1, sockets: 3 })), 'nothing in the last 10 minutes; 1 screen open');
  assert.equal(busy.words(busy.line({ sockets: 2 })), 'nothing in the last 10 minutes');
});

test('the busy line\'s window: a page counts from its newest input until 10 minutes after it, open or gone, and a later input moves it on; at most 10,000 held, the oldest let go', () => {
  const p1 = busy.pageKey('ABC234', 'u1');
  const p2 = busy.pageKey('ABC234', 'u2');
  assert.equal(p1, 'ABC234\nu1', 'a page is its hall and its person, whatever socket carries it');
  assert.notEqual(busy.pageKey('ABC234', 'u1'), busy.pageKey('DEF567', 'u1'), 'the same person in two halls is two pages');
  const a = new busy.Activity();
  a.note(p1, 1000);
  a.note(p2, 2000);
  a.note(p1, 1500);   // the same page again, on a new socket after a drop: one page
  assert.deepEqual([a.count(2000), a.has(p1, 2000), a.has('p3', 2000), a.keys(2000)], [2, true, false, [p2, p1]]);
  a.note(p1, 5 * MIN);   // newer input: counted from it now
  assert.deepEqual([a.count(10 * MIN + 1000), a.has(p1, 10 * MIN + 1000), a.has(p2, 10 * MIN + 1000)], [2, true, true]);
  assert.deepEqual([a.count(10 * MIN + 2000), a.has(p2, 10 * MIN + 2000)], [1, false], 'p2 left the window 10 minutes after its input');
  assert.equal(a.count(15 * MIN), 0, 'and p1 10 minutes after its newest');
  assert.equal(a.at.size, 0, 'nothing kept past the window');
  const short = new busy.Activity({ windowMs: 100 });
  short.note('x', 0);
  short.note('y', 150);
  assert.deepEqual([...short.at.keys()], ['y'], 'what left the window is let go as the next input comes');
  // Bounded: a flood of new pages each giving one input holds no more than the bound, the oldest input let go first.
  assert.equal(busy.ACTIVITY_MAX, 10_000);
  const full = new busy.Activity();
  for (let i = 0; i < 10_050; i++) full.note('flood' + i, 1000 + i);
  assert.deepEqual([full.at.size, full.has('flood49', 20_000), full.has('flood50', 20_000), full.has('flood10049', 20_000)], [10_000, false, true, true]);
  const three = new busy.Activity({ max: 3 });
  for (const k of ['a', 'b', 'c', 'a', 'd']) three.note(k, 10);
  assert.deepEqual(three.keys(10), ['c', 'a', 'd'], 'a page that gave input again is kept over one that did not');
});

test('a hall\'s messages from the window make their senders\' pages active, whoever sent them and across a restart; help counted; the system\'s own lines never', () => {
  const since = 100 * MIN;
  const at = since + MIN;
  const messages = [
    { id: 'm0', type: 'text', at: since - 1, from: { uid: 'old' } },                             // before the window
    { id: 'm1', type: 'text', at, from: { uid: 'ana', name: 'Ana', role: 'board' } },
    { id: 'm2', type: 'text', at, from: { uid: 'ana', name: 'Ana', role: 'board' } },             // the same page again
    { id: 'm3', type: 'help', at, from: { uid: 'ben', name: 'Ben', role: 'research' } },
    { id: 'm4', type: 'system', at, text: 'Ana joined' },
    { id: 'm5', type: 'text', at, from: { uid: 'minutes', name: 'Minutes', role: 'observer', ai: true } },
    { id: 'm6', type: 'text', at, from: { t: 'messenger', id: 'node-1', name: 'AGMessage' } },
    { id: 'm7', type: 'text', at },                                                             // no sender kept
    { id: 'm8', type: 'help', at: since + 1, from: { uid: 'cy' } },
  ];
  const r = busy.fromMessages('ABC234', messages, since);
  assert.deepEqual([...r.pages].sort(), ['ana', 'ben', 'cy', 'message m7', 'minutes', 'node-1'].map((u) => busy.pageKey('ABC234', u)).sort());
  assert.equal(r.help, 2);
  // Read from the newest back to the first older one: a hall of 10,000 messages is read to its window's edge only.
  const big = Array.from({ length: 10_000 }, (_, i) => ({ id: 'b' + i, type: 'text', at: i, from: { uid: 'u' + i } }));
  assert.equal(busy.fromMessages('BIG234', big, 9_995).pages.size, 4);
  assert.equal(busy.fromMessages('BIG234', big, 10_000).pages.size, 0, 'at the edge itself: outside');
  for (const none of [undefined, null, [], [null]]) assert.deepEqual(busy.fromMessages('X', none, 0), { pages: new Set(), help: 0 });
});

test('every socket verb is input or a page\'s own read, and each named is one a handler registers; what a page holds for its person is input', () => {
  const registered = new Set(h.handlerFiles().flatMap((f) => [...read(path.join(h.ROOT, f)).matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1])));
  assert.ok(registered.size > 40 && registered.has('message') && registered.has('display:shown') && registered.has('disconnect'), 'the verbs are read');
  for (const v of registered) assert.ok(busy.INPUT.has(v) !== busy.READS.has(v), v + ' is either input or a read, and not both');
  for (const v of [...busy.INPUT, ...busy.READS]) assert.ok(registered.has(v), v + ' is a verb a handler registers');
  // A write a page holds in its outbox is something a person wrote or answered: always input.
  const held = new Set(h.pageScripts().flatMap((f) => [...read(path.join(h.ROOT, f)).matchAll(/AGM\.outbox\.hold\(\s*'([^']+)'/g)].map((m) => m[1])));
  assert.ok(held.has('message'));
  for (const v of held) assert.ok(busy.INPUT.has(v), v + ' is held for its person, so it is input');
  for (const v of ['join', 'seen', 'myRooms', 'userState:push', 'userState:requestPeers', 'board:watch']) assert.ok(busy.READS.has(v), v + ' a page sends by itself');
});

// ---------------------------------------------------------------- the wire's rules (pure)

test('the proofs: the server\'s over its nonce and the machine\'s challenge, the machine\'s over the nonce, method, path and body; neither stands for the other', () => {
  const token = 'aaaabbbbccccdddd';
  const nonce = 'ab'.repeat(16);
  const challenge = 'cd'.repeat(16);
  const hmac = (text) => crypto.createHmac('sha256', token).update(text).digest('hex');
  assert.equal(wire.serverProof(token, nonce, challenge), hmac('agmessage machine server\n' + nonce + '\n' + challenge));
  const body = Buffer.from('{"reason":"upgrade","by":"LAPTOP\\\\ana","force":""}');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const proof = wire.askProof(token, { nonce, method: 'POST', path: '/api/machine/stop', body });
  assert.equal(proof, hmac('agmessage machine\n' + nonce + '\nPOST\n/api/machine/stop\n' + sha));
  assert.equal(wire.askProof(token, { nonce, method: 'GET', path: '/api/machine/busy' }), hmac('agmessage machine\n' + nonce + '\nGET\n/api/machine/busy\n' + crypto.createHash('sha256').update('').digest('hex')), 'no body is the empty body');
  // Bound to each part: another nonce, method, path, body or token is another proof.
  for (const other of [
    wire.askProof(token, { nonce: 'ef'.repeat(16), method: 'POST', path: '/api/machine/stop', body }),
    wire.askProof(token, { nonce, method: 'GET', path: '/api/machine/stop', body }),
    wire.askProof(token, { nonce, method: 'POST', path: '/api/machine/events', body }),
    wire.askProof(token, { nonce, method: 'POST', path: '/api/machine/stop', body: Buffer.from('{"reason":"stop","by":"LAPTOP\\\\ana","force":""}') }),
    wire.askProof('eeeeffff00001111', { nonce, method: 'POST', path: '/api/machine/stop', body }),
    wire.serverProof(token, nonce, challenge),
  ]) assert.equal(wire.sameProof(proof, other), false);
  assert.equal(wire.sameProof(proof, proof), true);
  for (const bad of [undefined, '', 'x', proof.toUpperCase(), proof.slice(1), proof + '0']) assert.equal(wire.sameProof(bad, proof), false, String(bad));
});

test('the token the machine reads is the server\'s as a typed one is read (lower case, its line\'s end trimmed); one under 16 characters is answered for nothing; a browser\'s request is never the machine\'s', () => {
  assert.equal(wire.tokenOf('ABCDabcd12345678\r\n'), 'abcdabcd12345678');
  assert.equal(wire.TOKEN_MIN, 16);
  assert.equal(wire.weakToken('0123456789abcdef'), '', 'the watchdog\'s: 16 hex characters');
  for (const short of ['0123456789abcde', '', undefined]) {
    assert.equal(wire.weakToken(short), 'This AGMessage\'s admin token is shorter than 16 characters, so this PC\'s machine is not answered: a program on this PC could test guesses at it from a hello. Start it without ADMIN_TOKEN, or with one of 16 or more random letters and digits.');
  }
  assert.equal(wire.fromBrowser({ host: '127.0.0.1:3000', 'content-length': '0' }), false, 'what the machine sends');
  for (const k of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) assert.equal(wire.fromBrowser({ host: '127.0.0.1', [k]: 'x' }), true, k);
  assert.equal(wire.fromBrowser({ origin: '' }), true, 'an empty Origin is still a browser\'s');
  assert.equal(wire.fromBrowser(undefined), false);
});

test('the nonces: each good for one request within 30 s of its hello, at most 256 held, the oldest let go first; the judge reads the nonce before the proof', () => {
  assert.equal(wire.NONCE_MS, 30_000);
  const n = new wire.Nonces();
  const a = n.issue(0);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(n.take(a, 29_999), true);
  assert.equal(n.take(a, 29_999), false, 'used once');
  const b = n.issue(0);
  assert.equal(n.take(b, 31_000), false, '31 s old');
  assert.equal(n.take('ff'.repeat(16), 0), false, 'never issued');
  const first = n.issue(100_000);
  for (let i = 0; i < 256; i++) n.issue(100_000);
  assert.equal(n.issued.size, 256);
  assert.equal(n.take(first, 100_000), false, 'the oldest was let go for the newest');
  const old = n.issue(200_000);
  n.issue(240_000);
  assert.equal(n.issued.has(old), false, 'one past its time is let go at the next hello');
  // The judge: no proof, a nonce not this server's, a wrong proof (the one counted), then a right one.
  const token = 'aaaabbbbccccdddd';
  const nonces = new wire.Nonces();
  const ask = (nonce, proof, extra = {}) => wire.judge({ token, nonces, nonce, proof, method: 'GET', path: '/api/machine/busy', body: Buffer.alloc(0), now: 1000, ...extra });
  assert.deepEqual([ask(undefined, undefined).status, ask(undefined, undefined).wrong, ask(undefined, undefined).again], [401, false, false]);
  const right = (nonce) => wire.askProof(token, { nonce, method: 'GET', path: '/api/machine/busy' });
  const unissued = 'cd'.repeat(16);
  assert.deepEqual(ask(unissued, right(unissued)), { status: 401, error: 'That nonce is not one this server issued in the last 30 s, or it was used: ask /api/machine/hello again.', wrong: false, again: true });
  const c = nonces.issue(1000);
  assert.deepEqual(ask(c, wire.askProof('wrongwrongwrong1', { nonce: c, method: 'GET', path: '/api/machine/busy' })), { status: 401, error: 'That is not a proof of this PC\'s token.', wrong: true, again: false });
  assert.equal(ask(c, right(c)).wrong, false, 'a wrong guess used its nonce');
  const d = nonces.issue(1000);
  assert.deepEqual(ask(d, right(d)), { ok: true });
  const e = nonces.issue(1000);
  assert.equal(ask(e, right(e), { method: 'POST' }).wrong, true, 'the method is the proof\'s');
  const f = nonces.issue(1000);
  assert.equal(ask(f, 'zz').wrong, true, 'a proof not of its shape is wrong');
});

test('the stop\'s body: whole JSON of reason, by and force, an unknown key or word refused, never defaulted; words cleaned', () => {
  const b = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));
  assert.deepEqual(wire.STOP_REASONS, ['stop', 'upgrade', 'back']);
  assert.deepEqual(wire.readStop(b({ reason: 'upgrade', by: 'LAPTOP\\ana' })), { reason: 'upgrade', by: 'LAPTOP\\ana', force: '' });
  const rlo = String.fromCharCode(0x202e);   // a right-to-left override, which would make a name read otherwise
  assert.deepEqual(wire.readStop(b({ reason: 'stop', by: ' LAPTOP\\ben' + rlo + ' ', force: 'the show is over' + String.fromCharCode(7) })), { reason: 'stop', by: 'LAPTOP\\ben', force: 'the show is over' });
  assert.equal(wire.readStop(b({ reason: 'back', by: 'x'.repeat(200), force: 'y'.repeat(400) })).by.length, 80);
  for (const [bad, words] of [
    [b('{'), /is JSON/], [b('[]'), /is JSON/], [undefined, /is JSON/], [b('null'), /is JSON/],
    [b({ reason: 'stop', by: 'a', why: 'x' }), /"why" is not one of them/],
    [b({ reason: 'reboot', by: 'a' }), /reason is one of stop, upgrade, back/],
    [b({ reason: 'stop' }), /names who asked/], [b({ reason: 'stop', by: '  ' }), /names who asked/], [b({ reason: 'stop', by: 7 }), /names who asked/],
    [b({ reason: 'stop', by: 'a', force: true }), /force is the reason a person typed/],
  ]) assert.match(wire.readStop(bad).error, words);
});

// ---------------------------------------------------------------- the machine against programs that are not its server

/** A program on a port, recording every byte each connection sent it; `answer(req, res)` answers each request. */
async function standIn(answer) {
  const bytes = [];
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.method + ' ' + req.url); answer(req, res); });
  srv.on('connection', (c) => c.on('data', (d) => bytes.push(d)));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { port: srv.address().port, seen, bytes: () => Buffer.concat(bytes), close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); }) };
}
/** Whether `bytes` hold the token anywhere, in any case. */
const holdsToken = (bytes) => bytes.toString('latin1').toLowerCase().includes(h.TOKEN.toLowerCase());
/** An answer of JSON, with its status. */
const answerJson = (res, o, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
/** A hello as a server that holds `token` answers it, to the challenge in `url`. */
const provenHello = (url, token = h.TOKEN) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return { ok: true, nonce, build: '0.6.0', proof: wire.serverProof(token, nonce, new URL(url, 'http://x').searchParams.get('c') || '') };
};

test('a program on the port without the token is asked nothing after the hello, and no byte the machine sends holds the token', async (t) => {
  const json = (res, o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  // It answers a hello of the right shape with a proof it cannot make, and anything else as a server would.
  const fake = await standIn((req, res) => json(res, req.url.startsWith('/api/machine/hello') ? { ok: true, nonce: crypto.randomBytes(16).toString('hex'), build: '0.6.0', proof: crypto.randomBytes(32).toString('hex') } : { ok: true, busy: false, line: busy.line({}), stopping: true }));
  t.after(() => fake.close());
  const b = await wire.busy({ port: fake.port, token: h.TOKEN });
  assert.deepEqual([b.answered, b.running, b.busy, b.line], [false, true, true, null], 'a program that does not prove it reads as busy');
  assert.equal(b.words, 'the program on port ' + fake.port + ' did not prove it holds this PC\'s AGMessage token, so nothing was asked of it: read as busy');
  const s = await wire.stop({ port: fake.port, token: h.TOKEN, reason: 'upgrade', by: 'LAPTOP\\ana', force: 'typed' });
  assert.deepEqual([s.ok, s.why], [false, 'unproven']);
  assert.deepEqual([(await wire.nudge({ port: fake.port, token: h.TOKEN })).why], ['unproven']);
  assert.equal(fake.seen.length, 3);
  for (const r of fake.seen) assert.match(r, /^GET \/api\/machine\/hello\?c=[0-9a-f]{32}$/, 'only the hello, three times');
  assert.equal(new Set(fake.seen).size, 3, 'each hello its own challenge');
  assert.equal(holdsToken(fake.bytes()), false, 'no byte the machine sent holds the token');
  assert.ok(fake.bytes().length > 100, 'the bytes were read');

  // One that knows the token but answers no line: read as busy, with why.
  const odd = await standIn((req, res) => {
    const c = new URL(req.url, 'http://x').searchParams.get('c') || '';
    const nonce = crypto.randomBytes(16).toString('hex');
    json(res, req.url.startsWith('/api/machine/hello') ? { ok: true, nonce, build: '0.6.0', proof: wire.serverProof(h.TOKEN, nonce, c) } : { ok: true, line: { active: 'many' } });
  });
  t.after(() => odd.close());
  const o = await wire.busy({ port: odd.port, token: h.TOKEN });
  assert.deepEqual([o.answered, o.busy, o.words], [false, true, 'AGMessage on port ' + odd.port + ' answered no busy line (200): read as busy']);

  // One that never answers: busy, once the wait (5 s for the machine, short here) is over.
  assert.equal(wire.ANSWER_MS, 5000);
  const held = [];
  const silent = net.createServer((c) => { held.push(c); });   // takes the connection and says nothing
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { held.forEach((c) => c.destroy()); silent.close(resolve); }));
  const sl = await wire.busy({ port: silent.address().port, token: h.TOKEN, timeoutMs: 300 });
  assert.deepEqual([sl.answered, sl.running, sl.busy, sl.words], [false, true, true, 'AGMessage on port ' + silent.address().port + ' did not answer within 0.3 s: read as busy']);
  // Nothing on the port: nothing running, so nothing busy.
  const free = await h.freePort();
  const none = await wire.busy({ port: free, token: h.TOKEN });
  assert.deepEqual([none.answered, none.running, none.busy, none.words], [false, false, false, 'nothing answers on port ' + free]);
});

test('the machine\'s wait is for the whole answer: a program that answers a byte at a time is silent at the time, on the port and on the folder\'s pipe', async (t) => {
  const ticks = [];
  t.after(() => ticks.forEach((x) => clearInterval(x)));
  // The hello's answer one byte every 100 ms: its 200 bytes would take 20 s, each byte well inside any idle time.
  const dribble = http.createServer((req, res) => {
    const body = Buffer.from(JSON.stringify(provenHello(req.url)));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    let i = 0;
    const tick = setInterval(() => { if (i >= body.length || res.destroyed) { clearInterval(tick); return; } res.write(body.subarray(i, i + 1)); i++; }, 100);
    ticks.push(tick);
  });
  await new Promise((resolve) => dribble.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { dribble.closeAllConnections(); dribble.close(resolve); }));
  const port = dribble.address().port;
  let t0 = Date.now();
  const b = await wire.busy({ port, token: h.TOKEN, timeoutMs: 500 });
  let took = Date.now() - t0;
  assert.deepEqual([b.answered, b.running, b.busy, b.words], [false, true, true, 'AGMessage on port ' + port + ' did not answer within 0.5 s: read as busy']);
  assert.ok(took < 4000, 'read as busy at its time, not after the answer\'s 20 s (' + took + ' ms)');
  // The pipe likewise: a holder that never ends its line is let go at the time, with what it said by then.
  const pipe = net.createServer((c) => {
    c.on('error', () => { /* the reader let it go */ });
    const tick = setInterval(() => { if (c.destroyed) { clearInterval(tick); return; } c.write('{'); }, 50);
    ticks.push(tick);
  });
  await new Promise((resolve) => pipe.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => pipe.close(resolve)));
  t0 = Date.now();
  const said = await wire.askPipe({ port: pipe.address().port, host: '127.0.0.1' }, { ms: 300 });
  took = Date.now() - t0;
  assert.deepEqual([said.connected, /^\{+$/.test(said.text), busy.read(said.text)], [true, true, null]);
  assert.ok(took < 3000, took + ' ms');
});

test('a proven server\'s nonce let go before it was used is asked for again once, from a fresh hello, never more; a wrong proof is never asked again', async (t) => {
  let refusals = 1;
  const again = await standIn((req, res) => {
    if (req.url.startsWith(wire.PATHS.hello)) return answerJson(res, provenHello(req.url));
    if (refusals-- > 0) return answerJson(res, { ok: false, error: 'That nonce is not one this server issued in the last 30 s, or it was used: ask /api/machine/hello again.', again: true }, 401);
    return answerJson(res, { ok: true, busy: false, line: busy.line({ seats: 1, sockets: 1 }), words: '' });
  });
  t.after(() => again.close());
  const paths = () => again.seen.map((x) => x.split('?')[0]);
  const once = await wire.busy({ port: again.port, token: h.TOKEN });
  assert.deepEqual([once.answered, once.busy, once.line], [true, false, busy.line({ seats: 1, sockets: 1 })]);
  assert.deepEqual(paths(), ['GET /api/machine/hello', 'GET /api/machine/busy', 'GET /api/machine/hello', 'GET /api/machine/busy']);
  assert.notEqual(again.seen[0], again.seen[2], 'a fresh challenge for the second hello');
  refusals = 5;
  const twice = await wire.busy({ port: again.port, token: h.TOKEN });
  assert.deepEqual([twice.answered, twice.busy, twice.words], [false, true, 'AGMessage on port ' + again.port + ' answered no busy line (401): read as busy']);
  assert.equal(again.seen.length, 8, 'two tries, never a third');
  // A wrong proof says nothing of a nonce: one try.
  const wrong = await standIn((req, res) => (req.url.startsWith(wire.PATHS.hello) ? answerJson(res, provenHello(req.url)) : answerJson(res, { ok: false, error: 'That is not a proof of this PC\'s token.' }, 401)));
  t.after(() => wrong.close());
  const w = await wire.stop({ port: wrong.port, token: h.TOKEN, reason: 'stop', by: 'LAPTOP\\ana' });
  assert.deepEqual([w.ok, w.status, wrong.seen.length], [true, 401, 2]);
  // The token as the machine reads it from its file (a line's end, another case) proves the same.
  refusals = 0;
  const cased = await wire.busy({ port: again.port, token: h.TOKEN.toUpperCase() + '\r\n' });
  assert.equal(cased.answered, true, cased.words);
});

// ---------------------------------------------------------------- the server

const CLOCK = path.join(__dirname, 'clock-preload.js');
/** A server whose wall clock a test moves on (test/clock-preload.js). */
async function serverWithClock(env = {}) {
  const clock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-clock-')), 'offset');
  fs.writeFileSync(clock, '0');
  const preload = '--require "' + CLOCK.split(path.sep).join('/') + '"';
  const srv = await h.startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_CLOCK: clock, ...env });
  const setClock = async (ms) => {
    fs.writeFileSync(clock, String(ms));
    await h.until(() => { try { return read(clock + '.ack') === String(ms); } catch { return false; } }, 3000, 'the server on the moved clock');
  };
  return { ...srv, setClock };
}
/** One request to the server as the machine makes it, with the headers given (no hello unless they carry its nonce). */
const raw = (port, method, p, { headers = {}, body } = {}) => wire.request({ port, method, path: p, headers, body: body === undefined ? Buffer.alloc(0) : Buffer.from(body) });
/** A nonce from the server's hello, and the machine's headers for one request with it. */
async function signed(port, method, p, body = Buffer.alloc(0), token = h.TOKEN) {
  const c = crypto.randomBytes(16).toString('hex');
  const hello = (await raw(port, 'GET', wire.PATHS.hello + '?c=' + c)).json;
  return { [wire.NONCE_HEADER]: hello.nonce, [wire.PROOF_HEADER]: wire.askProof(token, { nonce: hello.nonce, method, path: p, body }) };
}
/** A TCP relay in front of `port` that keeps every byte sent through it toward the server. */
async function recordingRelay(port) {
  const bytes = [];
  const relay = net.createServer((c) => {
    const up = net.connect(port, '127.0.0.1');
    c.on('data', (d) => bytes.push(d));
    c.pipe(up); up.pipe(c);
    c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  return { port: relay.address().port, bytes: () => Buffer.concat(bytes), close: () => new Promise((resolve) => relay.close(resolve)) };
}
/** A second copy started on `dataDir`, which its lock refuses: {code, out}. */
const secondCopy = (dataDir, port) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(h.ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', AGM_UPLOAD_DIR: dataDir + '-uploads', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const kill = setTimeout(() => c.kill('SIGKILL'), 8000);
  c.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
});
/** The data folder's pipe, by the name 0.5.1 gave it (the folder's path as given). */
const pipeOf = (dataDir) => {
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(dataDir).toLowerCase() : path.resolve(dataDir)).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + id : path.join(os.tmpdir(), 'agmessage-' + id + '.sock');
};

test('at loopback: the hello proves the token, every request but it is refused off this PC, without a proof, with a nonce used or 31 s old; the busy line counts input, takes, help and countdowns, never presence', async (t) => {
  const sw = await h.fakeStagewatch({ name: 'Hall 1 timer' });
  const srv = await serverWithClock();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await h.stopServer(srv.child); await sw.close(); });
  const { port } = srv;
  // Off this PC (a forwarded request, or a name that is not this laptop's loopback): refused, every one.
  const c = crypto.randomBytes(16).toString('hex');
  for (const headers of [{ 'x-forwarded-for': '10.0.0.7' }, { host: 'agm.example:' + port }, { 'cf-connecting-ip': '203.0.113.9' }]) {
    for (const [method, p] of [['GET', wire.PATHS.hello + '?c=' + c], ['GET', wire.PATHS.busy], ['POST', wire.PATHS.stop], ['POST', wire.PATHS.events]]) {
      const r = await raw(port, method, p, { headers });
      assert.deepEqual([r.status, r.json.ok], [403, false], method + ' ' + p + ' ' + JSON.stringify(headers));
    }
  }
  // A browser's request on this PC (an Origin or a Sec-Fetch-* header, which the machine never sends): refused, every one.
  for (const headers of [{ origin: 'http://127.0.0.1:' + port }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' }]) {
    for (const [method, p] of [['GET', wire.PATHS.hello + '?c=' + c], ['GET', wire.PATHS.busy], ['POST', wire.PATHS.stop], ['POST', wire.PATHS.events]]) {
      const r = await raw(port, method, p, { headers });
      assert.deepEqual([r.status, r.json.error], [403, 'A browser\'s request is never this PC\'s machine\'s: nothing is answered here to a page.'], method + ' ' + p + ' ' + JSON.stringify(headers));
    }
  }
  // The hello: a nonce, the build, and the server's proof under the token over the nonce and the machine's challenge.
  assert.equal((await raw(port, 'GET', wire.PATHS.hello)).status, 400, 'a hello names its challenge');
  assert.equal((await raw(port, 'GET', wire.PATHS.hello + '?c=xyz')).status, 400);
  const hello = (await raw(port, 'GET', wire.PATHS.hello + '?c=' + c)).json;
  const health = (await h.api(srv.base, 'GET', '/api/health')).body;
  assert.deepEqual([Object.keys(hello), hello.build], [['ok', 'nonce', 'build', 'proof'], health.build]);
  assert.equal(wire.sameProof(hello.proof, wire.serverProof(h.TOKEN, hello.nonce, c)), true, 'it proves it holds the token');
  assert.equal(wire.sameProof(hello.proof, wire.serverProof('wrongwrongwrong1', hello.nonce, c)), false);
  assert.notEqual((await raw(port, 'GET', wire.PATHS.hello + '?c=' + c)).json.nonce, hello.nonce, 'each hello a fresh nonce');
  // No proof: refused, and never counted (six in a row, then a proof that holds is answered).
  for (let i = 0; i < 6; i++) assert.equal((await raw(port, 'GET', wire.PATHS.busy)).status, 401);
  const right = await signed(port, 'GET', wire.PATHS.busy);
  let r = await raw(port, 'GET', wire.PATHS.busy, { headers: right });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // The nonce used: refused, however right its proof.
  r = await raw(port, 'GET', wire.PATHS.busy, { headers: right });
  assert.deepEqual([r.status, r.json.error], [401, 'That nonce is not one this server issued in the last 30 s, or it was used: ask /api/machine/hello again.']);
  // A nonce 31 s old: refused.
  const aging = await signed(port, 'GET', wire.PATHS.busy);
  await srv.setClock(31_000);
  r = await raw(port, 'GET', wire.PATHS.busy, { headers: aging });
  assert.equal(r.status, 401);
  assert.equal(auditRows(srv.dataDir, 'login.token.fail').length, 0, 'none of these was a wrong proof');
  // A hello read before, given back by a program that took the port: it proves nothing to a machine that asks now.
  const replay = await standIn((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(hello)); });
  t.after(() => replay.close());
  assert.equal((await wire.busy({ port: replay.port, token: h.TOKEN })).words.includes('did not prove'), true);
  assert.deepEqual(replay.seen.map((x) => x.slice(0, 22)), ['GET /api/machine/hello'], 'asked nothing after the hello');

  // The line now: nothing open but the admin's page, which sits in no hall.
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  const ctl = await h.connect(srv.base, login.cookie); sockets.push(ctl);
  const line = async () => { const b = await wire.busy({ port, token: h.TOKEN }); assert.equal(b.answered, true, b.words); return b; };
  assert.deepEqual((await line()).line, { active: 0, takes: 0, help: 0, countdowns: 0, seats: 0, screens: 0, sockets: 1 });
  // A seat and a screen, open and quiet, whatever the admin's own page does: not busy.
  const ana = await h.connect(srv.base); sockets.push(ana);
  assert.ok((await h.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'research' })).ok);
  await h.emit(ana, 'myRooms', {});
  const made = await h.emit(ctl, 'display:create', { code, name: 'Lectern' });
  assert.ok(made.ok, JSON.stringify(made));
  const screen = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(screen);
  screen.on('display:state', (st) => screen.emit('display:shown', { seq: st.seq, ok: true, words: '' }));
  await h.until(() => screen.connected, 3000, 'the screen');
  await h.until(async () => (await line()).line.screens === 1, 3000, 'the screen counted');
  let b = await line();
  assert.deepEqual([b.busy, b.line], [false, { active: 0, takes: 0, help: 0, countdowns: 0, seats: 1, screens: 1, sockets: 3 }], b.words);
  assert.equal(b.words, 'nothing in the last 10 minutes; 1 seat and 1 screen open');
  // Input on the seat: busy. A help request, a take and a countdown each count.
  assert.ok((await h.emit(ana, 'message', { type: 'text', text: 'Doors in five' })).ok);
  b = await line();
  assert.deepEqual([b.busy, b.line.active, b.line.seats, b.words], [true, 1, 0, '1 page active']);
  assert.ok((await h.emit(ana, 'message', { type: 'help', category: 'Sound', text: 'radio mic 3' })).ok);
  assert.ok((await h.emit(ctl, 'display:take', { id: made.display.id, content: { kind: 'message', text: 'Five minutes', tone: 'warn' } })).ok);
  assert.ok((await h.emit(ctl, 'hall:configure', { code, stagewatchUrl: sw.url })).ok);
  await h.until(async () => (await line()).line.countdowns === 1, 5000, 'the countdown running');
  b = await line();
  assert.deepEqual(b.line, { active: 1, takes: 1, help: 1, countdowns: 1, seats: 0, screens: 1, sockets: 3 }, 'the admin\'s take is a take, never a seat\'s input');
  assert.equal(b.words, '1 page active, 1 take changed, 1 help request, a countdown running');
  // The data folder's pipe answers the same line, and a second copy on the folder says it.
  const piped = await wire.askPipe(pipeOf(srv.dataDir));
  assert.deepEqual([piped.connected, busy.read(piped.text)], [true, b.line]);
  const refused = await secondCopy(srv.dataDir, await h.freePort());
  assert.equal(refused.code, 3, refused.out);
  assert.match(refused.out, /AGMessage is already running on this data folder \([^)]+\)\. It says it is busy: 1 page active, 1 take changed, 1 help request, a countdown running\. Use that window, or give this copy a folder of its own\./);
  // The countdown held, then the window over: presence alone again.
  sw.frame({ state: 'paused' });
  await h.until(async () => (await line()).line.countdowns === 0, 5000, 'the countdown held');
  assert.ok((await h.emit(ctl, 'hall:configure', { code, stagewatchUrl: '' })).ok);
  await srv.setClock(31_000 + 10 * MIN + 1000);
  b = await line();
  assert.deepEqual([b.busy, b.line], [false, { active: 0, takes: 0, help: 0, countdowns: 0, seats: 1, screens: 1, sockets: 3 }], b.words);
  const quiet = await secondCopy(srv.dataDir, await h.freePort());
  assert.match(quiet.out, /\. It says it is idle: nothing in the last 10 minutes; 1 seat and 1 screen open\. /);
  // The nudge for the machine's events carries nothing, and is answered for what it did.
  const nudge = await wire.nudge({ port, token: h.TOKEN });
  assert.deepEqual([nudge.status, nudge.json], [200, { ok: true, read: 0, words: 'Heard. This AGMessage keeps no machine events to read.' }]);
  const loaded = await wire.ask({ port, token: h.TOKEN, method: 'POST', path: wire.PATHS.events, body: { seq: 1 } });
  assert.deepEqual([loaded.status, loaded.json.error], [400, 'The nudge carries nothing.']);
  assert.equal(srv.child.exitCode, null, 'still serving');
});

test('the stop: refused while busy without a typed reason, then saved and ended with 0, server.stop.forced written; the token never crosses the socket; a wrong proof is counted as a wrong token', async (t) => {
  const srv = await serverWithClock();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); if (srv.child.exitCode === null) await h.stopServer(srv.child); });
  const { port } = srv;
  const relay = await recordingRelay(port);
  t.after(() => relay.close());
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;

  // Five wrong proofs: each refused, written as a wrong token is, and the sixth, right, waits out the token's lockout.
  for (let i = 0; i < 5; i++) {
    const r = await raw(port, 'GET', wire.PATHS.busy, { headers: await signed(port, 'GET', wire.PATHS.busy, Buffer.alloc(0), 'wrongwrongwrong1') });
    assert.deepEqual([r.status, r.json.error], [401, 'That is not a proof of this PC\'s token.']);
  }
  const fails = auditRows(srv.dataDir, 'login.token.fail');
  assert.deepEqual(fails.map((e) => [e.actor.id, e.target, e.words]), Array(5).fill(['host', 'host', 'a wrong proof of the admin token (at /api/machine/busy)']));
  let r = await raw(port, 'GET', wire.PATHS.busy, { headers: await signed(port, 'GET', wire.PATHS.busy) });
  assert.equal(r.status, 429, 'counted toward the token\'s lockout');
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 429, 'the same lockout the token sign-in reads');
  await srv.setClock(61_000);
  r = await raw(port, 'GET', wire.PATHS.busy, { headers: await signed(port, 'GET', wire.PATHS.busy) });
  assert.equal(r.status, 200, 'a minute on, a right proof is answered');

  // Words the stop does not know are refused, never defaulted.
  for (const [body, words] of [[{ reason: 'reboot', by: 'LAPTOP\\ana' }, /reason is one of/], [{ reason: 'stop', by: 'LAPTOP\\ana', now: true }, /"now" is not one of them/], [{ reason: 'stop' }, /names who asked/]]) {
    const x = await wire.ask({ port, token: h.TOKEN, method: 'POST', path: wire.PATHS.stop, body });
    assert.equal(x.status, 400);
    assert.match(x.json.error, words);
  }
  // Busy (a seated page wrote): no stop without a typed reason.
  const ana = await h.connect(srv.base); sockets.push(ana);
  assert.equal((await h.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'board', invite: h.inviteOf(srv.dataDir, code) })).role, 'board');
  assert.ok((await h.emit(ana, 'message', { type: 'text', text: 'Thank you all' })).ok);
  const held = await wire.stop({ port: relay.port, token: h.TOKEN, reason: 'upgrade', by: 'LAPTOP\\ana' });
  assert.deepEqual([held.status, held.json.busy, held.json.error], [409, true, 'Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.']);
  assert.equal(srv.child.exitCode, null, 'still serving');
  assert.equal(auditRows(srv.dataDir, 'server.stop.forced').length, 0);
  // With the reason a person typed: it stops, saves, and says so; the forced stop is written.
  const ended = new Promise((resolve) => srv.child.once('exit', (c) => resolve(c)));
  const stopped = await wire.stop({ port: relay.port, token: h.TOKEN, reason: 'upgrade', by: 'LAPTOP\\ana', force: 'the show ended early' });
  assert.deepEqual([stopped.status, stopped.json.ok, stopped.json.stopping, stopped.json.forced], [200, true, true, true]);
  assert.equal(await ended, 0, 'ended with 0, which the watchdog and the task read as stopped');
  assert.equal(JSON.parse(read(path.join(srv.dataDir, 'last-stop.json'))).saved, true, 'saved as every stop is');
  const forced = auditRows(srv.dataDir, 'server.stop.forced');
  assert.deepEqual(forced.map((e) => [e.actor.t, e.actor.id, e.target, e.words]), [['admin', 'host', 'LAPTOP\\ana', 'stopped while busy (1 page active) for an upgrade: the show ended early']]);
  assert.match(srv.out(), /\n {2}Stopping for an upgrade, asked at loopback by LAPTOP\\ana while busy \(1 page active\), with a reason typed\.\n/);
  // Everything the machine sent the server went through the relay: the token is in none of it.
  assert.ok(relay.bytes().length > 500, 'the relay carried the hellos, the refusal and the stop');
  assert.equal(holdsToken(relay.bytes()), false, 'the token never crossed the socket');
});

test('the stop of a server that is not busy needs no reason and writes no forced row; two asked at once stop it once, the second answered with what is being done', async (t) => {
  const srv = await h.startServer();
  t.after(async () => { if (srv.child.exitCode === null) await h.stopServer(srv.child); });
  const ended = new Promise((resolve) => srv.child.once('exit', (c) => resolve(c)));
  const [one, two] = await Promise.all([
    wire.stop({ port: srv.port, token: h.TOKEN, reason: 'stop', by: 'LAPTOP\\ben', force: 'not needed' }),
    wire.stop({ port: srv.port, token: h.TOKEN, reason: 'stop', by: 'LAPTOP\\ben' }),
  ]);
  const answers = [one, two].filter((x) => x.ok).map((x) => x.json);
  assert.equal(answers.filter((x) => x.ok === true && x.stopping === true && x.forced === false && !x.already).length, 1, JSON.stringify([one, two]));
  for (const x of answers) assert.deepEqual([x.ok, x.stopping], [true, true]);
  assert.equal(await ended, 0);
  assert.equal(JSON.parse(read(path.join(srv.dataDir, 'last-stop.json'))).saved, true);
  assert.equal(auditRows(srv.dataDir, 'server.stop.forced').length, 0, 'a stop of a quiet server is no forced stop');
  // It stopped once: one stop said, one save, one record of it.
  const out = srv.out();
  assert.equal((out.match(/\n {2}Stopping for a stop, asked at loopback by LAPTOP\\ben\.\n/g) || []).length, 1, out);
  assert.equal((out.match(/\n {2}Saving…\n/g) || []).length, 1, out);
  assert.equal((out.match(/\n {2}Saved: /g) || []).length, 1, out);
});

test('a message is activity whoever sent it, and across a restart: the admin\'s support view and the minutes make it busy, and a server restarted within the window still is, so a stop without a reason is refused', async (t) => {
  let srv = await h.startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((x) => x.close()); if (srv.child.exitCode === null) await h.stopServer(srv.child); });
  const line = () => wire.busy({ port: srv.port, token: h.TOKEN });
  const login = await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN });
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: login.cookie })).body.code;
  const ctl = await h.connect(srv.base, login.cookie); sockets.push(ctl);
  const ana = await h.connect(srv.base); sockets.push(ana);
  const seat = await h.emit(ana, 'join', { roomCode: code, name: 'Ana', role: 'research' });
  assert.ok(seat.ok);
  assert.deepEqual((await line()).line, { active: 0, takes: 0, help: 0, countdowns: 0, seats: 1, screens: 0, sockets: 2 });
  // The admin's support view sits in no seat, and the minutes are no page's: each message is still a message.
  assert.ok((await h.emit(ctl, 'join', { roomCode: code, name: 'Gwen', role: 'observer', adminView: true })).ok);
  assert.ok((await h.emit(ctl, 'message', { type: 'text', text: 'Mic check in Hall 1' })).ok);
  let b = await line();
  assert.deepEqual([b.busy, b.line.active, b.line.seats, b.words], [true, 1, 1, '1 page active'], 'the support view\'s message');
  assert.ok((await h.emit(ctl, 'admin:postSummary', { roomCode: code, text: 'Minutes so far' })).ok);
  assert.ok((await h.emit(ana, 'message', { type: 'text', text: 'Doors in five' })).ok);
  b = await line();
  assert.deepEqual([b.line.active, b.line.seats, b.words], [3, 0, '3 pages active'], 'Ana\'s page once, by her input and her message alike');
  // Stopped and started again within the window (the watchdog's restart after a crash, or a stop): the hall kept its
  // messages, so the line still reads busy, and Ana back on a new socket is the same page, active, never a quiet seat.
  sockets.forEach((x) => x.close());
  sockets.length = 0;
  srv = await h.restartServer(srv);
  b = await line();
  assert.deepEqual([b.busy, b.line, b.words], [true, { active: 3, takes: 0, help: 0, countdowns: 0, seats: 0, screens: 0, sockets: 0 }, '3 pages active']);
  const back = await h.connect(srv.base); sockets.push(back);
  assert.ok((await h.emit(back, 'join', { roomCode: code, name: 'Ana', role: 'research', uid: seat.identity })).ok);
  b = await line();
  assert.deepEqual([b.line.active, b.line.seats, b.line.sockets], [3, 0, 1]);
  const held = await wire.stop({ port: srv.port, token: h.TOKEN, reason: 'upgrade', by: 'LAPTOP\\ana' });
  assert.deepEqual([held.status, held.json.busy, held.json.error], [409, true, 'Not stopped: AGMessage is busy (3 pages active). Type a reason to stop it anyway.']);
  assert.equal(srv.child.exitCode, null, 'still serving');
});

test('a server whose token is shorter than 16 characters answers this PC\'s machine nothing, saying why: its hello would let a program on this PC test guesses at it', async (t) => {
  const weak = 'show-token-1';
  const srv = await h.startServer({ ADMIN_TOKEN: weak });
  t.after(() => h.stopServer(srv.child));
  const c = crypto.randomBytes(16).toString('hex');
  for (const [method, p] of [['GET', wire.PATHS.hello + '?c=' + c], ['GET', wire.PATHS.busy], ['POST', wire.PATHS.stop], ['POST', wire.PATHS.events]]) {
    const r = await raw(srv.port, method, p);
    assert.deepEqual([r.status, r.json.error, 'proof' in r.json], [403, wire.weakToken(weak), false], method + ' ' + p);
  }
  const b = await wire.busy({ port: srv.port, token: weak });
  assert.deepEqual([b.answered, b.running, b.busy], [false, true, true], 'read as busy: it proves nothing');
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: weak })).status, 200, 'the token\'s sign-in is as it was');
});
