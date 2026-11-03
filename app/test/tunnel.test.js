'use strict';
// Remote phones through the tunnel, end to end: the tunnel's places (in all, and one network's share of them), a place
// for a page in a room, the connection rate per network that a flood of new addresses never resets, the wrong-code lock
// in the tunnel's words, every refusal counted in health and never one of the venue's, and the internet link checked
// from the laptop. A tunnel socket is one cloudflared would bring: from loopback, with Cloudflare's headers, as
// test/sessions.test.js builds its visitors. The places are made small (AGM_TUNNEL_MAX=4, so one network's share is 2)
// and the wait for a join short (AGM_TUNNEL_JOIN_MS=300).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { io } = require('socket.io-client');
const { ROOT, TOKEN, startServer, stopServer, api, connect, emit, wait, until } = require('./helpers');
const readings = require('../lib/peaks');
const tunnelend = require('../lib/tunnelend');

const SMALL = { AGM_TUNNEL_MAX: '4', AGM_TUNNEL_JOIN_MS: '300' };
let ray = 0;
/** Cloudflare's headers for a phone at `address`, as cloudflared hands them on. */
const viaTunnel = (address, extra = {}) => ({ 'cf-connecting-ip': address, 'cf-ray': '8f00aa' + (++ray).toString(16), ...extra });
const FULL = (s) => 'AGMessage\'s internet link is full (4 phones). Trying again in ' + s + ' s. On the venue\'s Wi-Fi there is room.';
const SHARE = (s) => 'Many phones from your network are already connected through the internet (2). Trying again in ' + s + ' s.';
const RATE = (s) => 'Busy — many phones are connecting from your network. Trying again in ' + s + ' s.';
const health = async (base) => (await fetch(base + '/api/health')).json();
/** An event whose only argument is its answer (the tunnel's verbs). */
const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });

/** A Socket.IO page with these headers: {s} once connected, {s, err} once refused. */
const open = (base, headers, extra = {}) => new Promise((resolve) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: headers, ...extra });
  s.once('connect', () => resolve({ s }));
  s.once('connect_error', (err) => resolve({ s, err }));
});

/**
 * One connection as a page's Socket.IO makes it, written by hand so thousands are quick: the WebSocket, then the CONNECT.
 * Resolves {ok} (closed at once, its place given back) or {err: {message, data}}.
 */
const raw = (port, headers) => new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket', { headers });
  ws.on('message', (data) => {
    const m = data.toString();
    if (m[0] === '0') ws.send('40');
    else if (m.startsWith('40')) { ws.close(); resolve({ ok: true }); }
    else if (m.startsWith('44')) { ws.close(); resolve({ err: JSON.parse(m.slice(2)) }); }
  });
  ws.on('error', reject);
});

/** The admin's cookie and a new hall on `base`. */
async function hallOn(base) {
  const login = await api(base, 'POST', '/api/admin/login', { token: TOKEN });
  const made = await api(base, 'POST', '/api/rooms', { name: 'Remote hall' }, { cookie: login.cookie });
  return { admin: login.cookie, code: made.body.code };
}

test('the tunnel\'s places: in all and per network, worded and counted; a venue page never waits for them; a place is for a page in a room', async (t) => {
  const srv = await startServer(SMALL);
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const { admin, code } = await hallOn(base);
  let n = 0;
  /** A tunnel page that joins the hall as it connects, as a hall page does. */
  async function seated(address) {
    const r = await open(base, viaTunnel(address));
    sockets.push(r.s);
    if (r.err) return r;
    const ans = await emit(r.s, 'join', { roomCode: code, name: 'Remote ' + (++n), role: 'observer' });
    assert.equal(ans.ok, true, JSON.stringify(ans));
    return r;
  }

  await t.test('full: the fifth tunnel page is refused in words, with why and a wait of 30 to 40 s; a venue page still connects', async () => {
    const four = [];
    for (const a of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) four.push(await seated(a));
    assert.ok(four.every((r) => !r.err), 'four places taken');
    const fifth = await open(base, viaTunnel('203.0.113.5'));
    sockets.push(fifth.s);
    const ms = fifth.err && fifth.err.data && fifth.err.data.retryMs;
    assert.deepEqual(fifth.err.data, { retryMs: ms, why: 'full' });
    assert.ok(Number.isInteger(ms) && ms >= 30_000 && ms <= 40_000, 'retryMs ' + ms);
    assert.equal(fifth.err.message, FULL(Math.ceil(ms / 1000)));
    assert.equal(fifth.s.active, false, 'refused: the page tries again by itself at that wait (reconnect.js)');
    const venue = await open(base, {});
    sockets.push(venue.s);
    assert.equal(venue.err, undefined, 'the venue never waits for the tunnel');
    const h = await health(base);
    assert.deepEqual(h.tunnel, { places: 4, max: 4, share: 2, networks: 4, refused: { rate: 0, share: 0, full: 1, idle: 0, wrongCode: 0 }, until: null });
    assert.deepEqual(h.refused, { venue: { rate: 0 } });
    assert.deepEqual([h.tunnelSockets, h.maxSocketsPerAddress.tunnel], [4, 1], 'the tunnel\'s sockets are the places\' sockets');
    assert.ok(!JSON.stringify(h).includes('203.0.113.'), 'health names no address');

    // A place freed by a disconnect is taken by the next page.
    four[0].s.close();
    await until(async () => (await health(base)).tunnel.places === 3, 4000, 'the place given back');
    const next = await seated('203.0.113.5');
    assert.equal(next.err, undefined, 'the freed place is taken');
    for (const r of [...four.slice(1), next]) r.s.close();
    await until(async () => (await health(base)).tunnel.places === 0, 4000, 'every place given back');
  });

  await t.test('share: one network (an IPv6 /64) holds half the places at most, while another network connects', async () => {
    const a = await seated('2001:db8:1:2::a');
    const b = await seated('2001:db8:1:2::b');
    const c = await open(base, viaTunnel('2001:db8:1:2::c'));
    sockets.push(c.s);
    assert.ok(!a.err && !b.err, 'two from one network');
    const ms = c.err && c.err.data && c.err.data.retryMs;
    assert.deepEqual(c.err.data, { retryMs: ms, why: 'share' }, 'the third, from another address in the same /64, is its share');
    assert.ok(ms >= 30_000 && ms <= 40_000, 'retryMs ' + ms);
    assert.equal(c.err.message, SHARE(Math.ceil(ms / 1000)));
    const other = await seated('2001:db8:1:3::a');
    assert.equal(other.err, undefined, 'the next /64 is another network');
    const h = await health(base);
    assert.deepEqual([h.tunnel.places, h.tunnel.networks, h.tunnel.refused.share, h.maxSocketsPerAddress.tunnel], [3, 2, 1, 2]);
    for (const r of [a, b, other]) r.s.close();
    await until(async () => (await health(base)).tunnel.places === 0, 4000, 'every place given back');
  });

  await t.test('a tunnel page that has not joined within the wait is let go and counted; one that joins, one with an account and the admin\'s stay', async () => {
    const ana = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
    assert.match(ana, /^agm_s=/);
    const idle = await open(base, viaTunnel('198.51.100.1'));
    const gone = new Promise((resolve) => { idle.s.once('disconnect', resolve); });
    const joins = await seated('198.51.100.2');
    const account = await open(base, viaTunnel('198.51.100.3', { cookie: ana }));
    const theAdmin = await open(base, viaTunnel('198.51.100.4', { cookie: admin }));
    sockets.push(idle.s, account.s, theAdmin.s);
    assert.ok([idle, joins, account, theAdmin].every((r) => !r.err));
    assert.equal(await gone, 'io server disconnect', 'let go by the server');
    await wait(500);
    assert.deepEqual([joins.s.connected, account.s.connected, theAdmin.s.connected], [true, true, true]);
    const h = await health(base);
    assert.deepEqual([h.tunnel.refused.idle, h.tunnel.places], [1, 3], 'counted, and its place given back');
    // Connected again, it is counted afresh.
    const again = await open(base, viaTunnel('198.51.100.1'));
    sockets.push(again.s);
    await new Promise((resolve) => { again.s.once('disconnect', resolve); });
    assert.equal((await health(base)).tunnel.refused.idle, 2);
    for (const r of [joins, account, theAdmin]) r.s.close();
    await until(async () => (await health(base)).tunnel.places === 0, 4000, 'every place given back');
  });

  await t.test('wrong codes: through the tunnel the lock speaks of the network; the venue still joins', async () => {
    const guesser = await open(base, viaTunnel('2001:db8:9:9::1'));
    sockets.push(guesser.s);
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push(await emit(guesser.s, 'join', { roomCode: 'ZZZZZ' + 'ABCDEFGHJKL'[i], name: 'Guess', role: 'observer' }));
    assert.deepEqual(answers.slice(0, 10).map((a) => a.error), new Array(10).fill('Room not found'));
    assert.deepEqual(answers[10], { ok: false, error: 'Too many wrong codes from your network — wait a minute.' });
    // Another phone on that network is the network: held too, with the right code.
    const neighbour = await open(base, viaTunnel('2001:db8:9:9::2'));
    sockets.push(neighbour.s);
    assert.deepEqual(await emit(neighbour.s, 'join', { roomCode: code, name: 'Neighbour', role: 'observer' }), { ok: false, error: 'Too many wrong codes from your network — wait a minute.' });
    const venue = await connect(base);
    sockets.push(venue);
    assert.equal((await emit(venue, 'join', { roomCode: code, name: 'At the venue', role: 'observer' })).ok, true, 'the venue still joins');
    assert.equal((await health(base)).tunnel.refused.wrongCode, 2);
  });

  await t.test('wrong context tokens: the addresses of one network share one lock; the next network is not held', async () => {
    const wrong = (address) => api(base, 'GET', '/api/context', undefined, { headers: { ...viaTunnel(address), authorization: 'Bearer not-the-context-token' } });
    const statuses = [];
    for (let i = 1; i <= 11; i++) statuses.push((await wrong('2001:db8:6:6::' + i.toString(16))).status);
    assert.deepEqual(statuses, [...new Array(10).fill(401), 429], 'ten wrong, from ten addresses of one /64, then held');
    assert.equal((await wrong('2001:db8:6:7::1')).status, 401, 'another network: told, not held');
  });
});

test('the connection rate counts a network, and a flood of 5,001 new networks never hands a drained one its burst back', async (t) => {
  const srv = await startServer(SMALL);
  t.after(() => stopServer(srv.child));
  const { port, base } = srv;
  const drained = () => viaTunnel('2001:db8:5:5::' + (++ray).toString(16));   // one network, a new address each time
  const rateOf = (rs) => rs.filter((r) => r.err && r.err.data && r.err.data.why === 'rate');

  // A burst of 40 from one network, from 40 addresses in its /64: 30 pass the rate (two seated, the rest its share), the
  // rest are refused for the rate in the tunnel's words.
  const began = Date.now();
  const burst = await Promise.all(Array.from({ length: 40 }, () => raw(port, drained())));
  const earned = Math.ceil(((Date.now() - began) * 3) / 1000);
  const rate = rateOf(burst);
  assert.ok(rate.length >= 10 - earned && rate.length >= 1, rate.length + ' refused for the rate of 40');
  assert.ok(burst.length - rate.length <= 30 + earned, (burst.length - rate.length) + ' passed the rate');
  for (const { err } of rate) {
    const ms = err.data.retryMs;
    assert.deepEqual(err.data, { retryMs: ms, why: 'rate' });
    assert.ok(Number.isInteger(ms) && ms >= 1000 && ms < 3000 + 334, 'retryMs ' + ms);
    assert.equal(err.message, RATE(Math.ceil(ms / 1000)));
  }

  // 5,001 other networks, the drained one still asking now and then: each of its tries spends what it earned.
  let lastDrain = Date.now();
  const OTHERS = 5001;
  const network = (i) => '10.' + (i >> 16) + '.' + ((i >> 8) & 255) + '.' + (i & 255);
  for (let i = 0; i < OTHERS; i += 50) {
    const batch = Array.from({ length: Math.min(50, OTHERS - i) }, (_, j) => raw(port, viaTunnel(network(i + j))));
    await Promise.all([...batch, raw(port, drained())]);
    lastDrain = Date.now();
  }
  // Then a burst of 30 from the drained network: only what it earned since its last try passes; a reset bucket would
  // pass all 30.
  const again = await Promise.all(Array.from({ length: 30 }, () => raw(port, drained())));
  const passed = again.length - rateOf(again).length;
  const since = Math.ceil(((Date.now() - lastDrain) * 3) / 1000) + 1;
  assert.ok(passed <= since && passed < 30, passed + ' of 30 passed the rate; ' + since + ' at most were earned since its last try');
  const h = await health(base);
  assert.ok(h.tunnel.refused.rate >= rate.length + rateOf(again).length, JSON.stringify(h.tunnel.refused));
  assert.equal(h.refused.venue.rate, 0, 'none of it the venue\'s');
  const today = h.peaks.find((d) => d.day === h.showDay);
  assert.deepEqual(today.tunnelRefused, h.tunnel.refused, 'every refusal through the tunnel is the day\'s too, by kind, kept in the peaks');
});

test('today\'s refusals through the tunnel outlive a restart: the card\'s count carries on from the day\'s peaks, by kind', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const NONE = { AGM_DATA_DIR: dataDir, AGM_TUNNEL_MAX: '0' };   // no places: every tunnel page is refused, for the tunnel full
  let srv = await startServer(NONE);
  t.after(() => stopServer(srv.child));
  const refused = async () => { const r = await open(srv.base, viaTunnel('203.0.113.77')); r.s.close(); return r.err && r.err.data.why; };
  assert.equal(await refused(), 'full');
  assert.equal((await health(srv.base)).tunnel.refused.full, 1);
  await stopServer(srv.child);
  srv = await startServer(NONE);
  const h = await health(srv.base);
  assert.deepEqual([h.tunnel.refused.full, h.peaks.find((d) => d.day === h.showDay).tunnelRefused.full], [1, 1], 'carried on, not 0 again');
  assert.equal(await refused(), 'full');
  assert.equal((await health(srv.base)).tunnel.refused.full, 2);
});

/**
 * A local server standing in for the link (Cloudflare, then cloudflared, back to AGMessage): it hands each request on as
 * cloudflared does, from loopback with Cloudflare's headers, to the server `target` names, and counts them. `mode`: 'on',
 * 'off' (a link that does not answer) or 'slow' (each answer 1.5 s late).
 */
async function standInLink(t) {
  const link = { asked: [], mode: 'on', target: '', port: 0 };
  const standIn = http.createServer((req, res) => {
    link.asked.push(req.url);
    if (link.mode === 'off') { res.writeHead(502); res.end('Bad gateway'); return; }
    const pass = () => fetch(link.target + req.url, { headers: viaTunnel('203.0.113.200') })
      .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
      .catch(() => { res.writeHead(502); res.end(); });
    if (link.mode === 'slow') setTimeout(pass, 1500); else pass();
  });
  await new Promise((resolve) => { standIn.listen(0, '127.0.0.1', resolve); });
  link.port = standIn.address().port;
  t.after(() => { standIn.close(); });
  return link;
}
/** The preloads a server under test runs with: its cloudflared stood in for (and `more`, each a file of test/). */
const preloads = (...more) => [process.env.NODE_OPTIONS, ...['tunnel-preload.js', ...more].map((f) => '--require "' + path.join(__dirname, f).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
/**
 * A server under test whose cloudflared and link are stood in for (`link`, which then hands requests on to it), with the
 * admin's socket hearing tunnel:status: {srv, ctl, heard}. Stopped when the test ends, if it is still running.
 */
async function serverWithLink(t, link, env = {}) {
  const srv = await startServer({ NODE_OPTIONS: preloads(), AGM_TEST_TUNNEL: 'http://127.0.0.1:' + link.port, ...env });
  link.target = srv.base;
  const login = await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN });
  const ctl = await connect(srv.base, login.cookie);
  t.after(async () => { ctl.close(); await stopServer(srv.child); });
  const heard = [];
  ctl.on('tunnel:status', (st) => heard.push(st));
  return { srv, ctl, heard };
}
/** A link stood in for and a server under test on it: {link, srv, ctl, heard}. */
async function linkServer(t, env = {}) {
  const link = await standInLink(t);
  return { link, ...(await serverWithLink(t, link, env)) };
}
const ADDRESS = /^https:\/\/agm-test-link-\d+\.trycloudflare\.com$/;

test('the internet link is checked from the laptop when it is up, and again only a minute after its last check', async (t) => {
  const { link, ctl, heard } = await linkServer(t);
  const { asked } = link;

  assert.deepEqual(await ask(ctl, 'admin:tunnelStatus'), { ok: true, running: false, url: null, error: null, checking: false, check: null, until: null, untilWords: '', untilClock: '', again: null, againWords: '', notKept: '' }, 'off: no check, no end');
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.check), 15_000, 'the check on tunnel:status');
  const done = heard.find((s) => s.check);
  assert.deepEqual(Object.keys(done), ['running', 'url', 'error', 'checking', 'check', 'until', 'untilWords', 'untilClock', 'again', 'againWords', 'notKept'], 'check appended, then the end');
  assert.match(done.url, ADDRESS);
  const c = done.check;
  assert.deepEqual(Object.keys(c), ['at', 'ok', 'p50Ms', 'maxMs', 'words']);
  assert.equal(c.ok, true);
  assert.ok(Number.isInteger(c.p50Ms) && Number.isInteger(c.maxMs) && c.p50Ms <= c.maxMs, JSON.stringify(c));
  assert.equal(c.words, 'round trip ' + c.p50Ms + ' ms (max ' + c.maxMs + ' ms)');
  assert.deepEqual(asked, new Array(5).fill('/api/health'), 'five tries, of the base health, which answers anyone');
  assert.ok(heard.some((s) => s.checking && !s.check), 'said while under way');

  // Asked again within the minute: the newest check, at once, and no new one.
  const soon = await ask(ctl, 'admin:tunnelStatus');
  assert.deepEqual([soon.checking, soon.check], [false, c]);
  await wait(500);
  assert.equal(asked.length, 5, 'no second check within 60 s');

  // A link that does not answer says so, once a new tunnel's check runs.
  link.mode = 'off';
  assert.equal((await ask(ctl, 'admin:tunnelStop')).ok, true);
  await until(() => heard.some((s) => !s.running), 4000, 'the tunnel off');
  heard.length = 0;
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.check), 15_000, 'the second tunnel\'s check');
  const failed = heard.find((s) => s.check).check;
  assert.deepEqual([failed.ok, failed.p50Ms, failed.maxMs, failed.words], [false, null, null, 'The internet link did not answer: remote phones cannot join.']);
  assert.equal(asked.length, 10, 'five tries more');

  // Stopped and started again while a slow check is under way: that check finds nothing and says it has ended, and the
  // new tunnel (its own address, as every Quick Tunnel has) is checked as it ends, though its own ask came meanwhile.
  link.mode = 'slow';
  assert.equal((await ask(ctl, 'admin:tunnelStop')).ok, true);
  await until(() => heard.at(-1) && !heard.at(-1).running, 4000, 'the tunnel off');
  heard.length = 0;
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.checking), 4000, 'the third tunnel\'s check under way');
  const third = heard.find((s) => s.checking).url;
  assert.equal((await ask(ctl, 'admin:tunnelStop')).ok, true);
  await until(() => heard.some((s) => !s.running), 4000, 'the third tunnel off, its check still under way');
  assert.equal(heard.find((s) => !s.running).checking, true);
  link.mode = 'on';
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.check && s.url !== third), 15_000, 'the fourth tunnel\'s check');
  const fourth = heard.find((s) => s.check && s.url !== third);
  assert.match(fourth.url, ADDRESS);
  assert.notEqual(fourth.url, third);
  assert.deepEqual([fourth.check.ok, fourth.checking], [true, false], 'checked, and not under way');
  assert.ok(!heard.some((s) => s.check && s.url === third), 'the stopped tunnel\'s check found nothing');
  await wait(300);
  const last = heard.at(-1);
  assert.deepEqual([last.url, last.checking, last.check && last.check.ok], [fourth.url, false, true], 'the last word is the new check\'s, never "under way"');
  assert.deepEqual(await ask(ctl, 'admin:tunnelStatus'), { ok: true, ...last });
});

test('a cloudflared that never says its connection is registered still has its link checked, once its wait for the address is over', async (t) => {
  const { link, ctl, heard } = await linkServer(t, { AGM_TEST_TUNNEL_QUIET: '1', AGM_TUNNEL_URL_MS: '1500' });
  const began = Date.now();
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.url), 4000, 'the address');
  const early = await ask(ctl, 'admin:tunnelStatus');
  assert.deepEqual([early.checking, early.check, link.asked.length, heard.some((s) => s.checking)], [false, null, 0, false], 'the address alone is not a link up: an admin\'s ask starts no check yet');
  await until(() => heard.some((s) => s.check), 15_000, 'the check');
  assert.ok(Date.now() - began >= 1400, 'at the wait\'s end: ' + (Date.now() - began) + ' ms');
  const done = heard.find((s) => s.check);
  assert.deepEqual([done.check.ok, done.checking, link.asked.length], [true, false, 5]);
});

test('cloudflared is run by its absolute path, this copy\'s own in bin beside app, never by a bare name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = path.join(dir, 'runs.txt');
  const { ctl, heard } = await linkServer(t, { AGM_TEST_TUNNEL_RUNS: runs });
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.url), 4000, 'the address');
  // Whether or not this checkout has a bin folder: the server asks for that file and no other (a bare name was its fallback).
  const own = path.join(fs.realpathSync(path.join(ROOT, '..')), 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  assert.deepEqual(fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean), [own]);
  assert.ok(path.isAbsolute(own));
});

/** Lines of a file a stand-in writes, or none when it has written nothing. */
const linesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const NOT_FOUND = /^cloudflared not found in this copy \(bin[\\/]cloudflared(\.exe)?\): re-extract the portable folder\. AGMessage runs only its own cloudflared, never one from elsewhere on this PC\.$/;

test('a copy without its own cloudflared refuses Turn on with why, runs nothing, keeps no end and leaves nothing polling', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-gone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = path.join(dir, 'runs.txt');
  const logs = path.join(dir, 'logs.txt');
  const { ctl, heard } = await linkServer(t, { AGM_TEST_TUNNEL_GONE: 'look', AGM_TEST_TUNNEL_RUNS: runs, AGM_TEST_TUNNEL_LOGS: logs });
  const off = await ask(ctl, 'admin:tunnelStart');
  assert.equal(off.ok, false);
  assert.match(off.error, NOT_FOUND);
  const st = await ask(ctl, 'admin:tunnelStatus');
  assert.deepEqual([st.running, st.url, st.error, st.until, st.untilWords, st.notKept], [false, null, off.error, null, '', ''], 'off, with why, and no end kept');
  assert.ok(heard.some((s) => s.error === off.error && !s.running), 'the card heard it');
  assert.deepEqual(await linkRow(ctl), ['off: ' + off.error, 'warn'], '"This laptop" says it');
  // Asked again: refused the same, and still nothing run, kept or read.
  assert.deepEqual(await ask(ctl, 'admin:tunnelStart'), off);
  await wait(1300);
  assert.deepEqual([linesOf(runs), linesOf(logs)], [[], []], 'no cloudflared run, and no read of its log');
  assert.equal((await ask(ctl, 'admin:tunnelStatus')).until, null);
});

test('a cloudflared gone between the look and the run (its run says error, never exit) ends its log\'s poll; Turn on again and Turn off leave none polling', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-gone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = path.join(dir, 'runs.txt');
  const logs = path.join(dir, 'logs.txt');
  const { ctl } = await linkServer(t, { AGM_TEST_TUNNEL_GONE: 'run', AGM_TEST_TUNNEL_RUNS: runs, AGM_TEST_TUNNEL_LOGS: logs });
  for (let i = 1; i <= 3; i++) {
    assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true, 'started: its file was there when looked for');
    await until(async () => !(await ask(ctl, 'admin:tunnelStatus')).running, 4000, 'the run\'s error read');
    const st = await ask(ctl, 'admin:tunnelStatus');
    assert.match(st.error, NOT_FOUND);
    assert.deepEqual([st.url, st.until], [null, null], 'no address, and the end Turn on kept forgotten: nothing was on');
    assert.equal(linesOf(runs).length, i);
  }
  await ask(ctl, 'admin:tunnelStop');
  // A poll left behind would open cloudflared.log every 500 ms; none may, after three runs that failed and a Turn off.
  const before = linesOf(logs).length;
  await wait(1300);
  assert.deepEqual([before, linesOf(logs).length], [0, 0], 'no read of cloudflared\'s log left running');
});

// ---------------------------------------------------------------- the tunnel's end, kept across a restart
/**
 * A time of day about `hours` from now by this laptop's clock ("HH:MM") and the end it names (`at`): the first hour on
 * whose wall minute no change of the clocks falls twice, so the end the server reads from it is the moment the test means,
 * and which is not `avoid` (the end already kept, which naming again would not move).
 */
function timeAbout(hours, avoid = null) {
  const now = Date.now();
  for (let h = hours; h < hours + 4; h++) {
    const at = new Date(now + h * 3600_000).setSeconds(0, 0);
    const hm = tunnelend.clockOf(at);
    if (tunnelend.endAt(hm, now) === at && at !== avoid) return { hm, at };
  }
  throw new Error('no time of day near ' + hours + ' h names one moment');
}
/** The audit log's rows of the internet link in the data folder `s` runs on, oldest first: [action, the actor's kind, words]. */
const linkRows = async (s) => fs.readFileSync(path.join(s.srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action.startsWith('tunnel.')).map((e) => [e.action, e.actor.t, e.words]);
/** "This laptop"'s internet link row: [words, mark]. */
const linkRow = async (ctl) => { const r = (await emit(ctl, 'admin:laptop', {})).laptop.facts.find((x) => x.id === 'tunnel'); return [r.words, r.mark]; };
/** One of two words, read before and after a call (a midnight between them changes "tomorrow" to "today"). */
const eitherOf = (f, before) => [f(before), f(Date.now())];

test('the tunnel\'s end, read by type: inside it, past it, nothing kept, or one no act sets; Turn on\'s end an hour or more away; a time of day is its next minute; words by the laptop\'s clock', () => {
  const now = new Date(2026, 10, 2, 22, 15, 30).getTime();
  assert.deepEqual(tunnelend.keptEnd(now + 60_000, now), { on: true, until: now + 60_000, why: '' });
  assert.deepEqual(tunnelend.keptEnd(now, now), { on: false, until: now, why: 'past' }, 'an end that has come is past');
  assert.deepEqual(tunnelend.keptEnd(now - 1, now), { on: false, until: now - 1, why: 'past' });
  assert.deepEqual([undefined, null].map((v) => tunnelend.keptEnd(v, now)), [{ on: false, until: null, why: 'none' }, { on: false, until: null, why: 'none' }]);
  // Further ahead than any act sets one (a day, the hour a default end adds and the hour a change of the clocks adds), or
  // not a time: never a tunnel.
  assert.equal(tunnelend.MAX_AHEAD_MS, 26 * 3600_000);
  assert.deepEqual(tunnelend.keptEnd(now + tunnelend.MAX_AHEAD_MS, now).on, true);
  for (const v of [now + tunnelend.MAX_AHEAD_MS + 1, String(now + 60_000), NaN, Infinity, {}, [now + 60_000], true]) {
    assert.deepEqual(tunnelend.keptEnd(v, now), { on: false, until: null, why: 'unread' }, JSON.stringify(v));
  }
  // Turn on's end: the end of the show day (the next 06:00), or the next day's when that is under an hour away, so a link
  // turned on at 05:50 is not cut at 06:00; every one reads as an end a start turns the link on again inside.
  const at = (d, h, m = 0, sec = 0) => new Date(2026, 10, d, h, m, sec).getTime();
  assert.deepEqual([at(2, 22, 15), at(3, 0, 30), at(3, 4, 59), at(3, 5, 0), at(3, 5, 0, 1), at(3, 5, 50), at(3, 5, 59, 59), at(3, 6, 0), at(3, 12, 0)].map((t) => tunnelend.defaultEnd(t, readings.dayEnds)),
    [at(3, 6), at(3, 6), at(3, 6), at(3, 6), at(4, 6), at(4, 6), at(4, 6), at(4, 6), at(4, 6)]);
  for (const t of [at(3, 5, 0, 1), at(3, 6, 0), at(3, 23, 59)]) {
    const end = tunnelend.defaultEnd(t, readings.dayEnds);
    assert.ok(end - t >= tunnelend.MIN_AHEAD_MS && tunnelend.keptEnd(end, t).on, new Date(t).toString());
  }
  // A time of day: the next such minute after now, so one already past today (or this very minute) is tomorrow's.
  assert.equal(tunnelend.endAt('23:30', now), new Date(2026, 10, 2, 23, 30).getTime());
  assert.equal(tunnelend.endAt(' 6:05 ', now), new Date(2026, 10, 3, 6, 5).getTime());
  assert.equal(tunnelend.endAt('22:15', now), new Date(2026, 10, 3, 22, 15).getTime(), 'this minute, its seconds gone: tomorrow\'s');
  assert.equal(tunnelend.endAt('00:00', now), new Date(2026, 10, 3, 0, 0).getTime());
  // The end kept, when it is the time of day given: a field filled with it and confirmed unchanged moves nothing, though
  // today's such minute is still ahead (Turn on at 05:30 keeps tomorrow's 06:00).
  const early = at(3, 5, 30);
  assert.deepEqual([tunnelend.endAt('06:00', early, at(4, 6)), tunnelend.endAt('6:00', early, at(4, 6)), tunnelend.endAt('06:00', early), tunnelend.endAt('07:00', early, at(4, 6)), tunnelend.endAt('06:00', early, at(3, 5, 0))],
    [at(4, 6), at(4, 6), at(3, 6), at(3, 7), at(3, 6)], 'the end kept; else the next such minute (a kept end already past names nothing)');
  for (const v of ['24:00', '7:60', '23:5', '2330', '11pm', '', '23:30:00', null, 2330, { toString: () => '23:30' }]) assert.equal(tunnelend.endAt(v, now), null, JSON.stringify(String(v)));
  // As a time field holds it, and in words, against now: today, tomorrow, yesterday, else its date.
  assert.deepEqual([at(3, 6, 0), at(2, 23, 5), at(3, 0, 0)].map((t) => tunnelend.clockOf(t)), ['06:00', '23:05', '00:00']);
  assert.deepEqual([new Date(2026, 10, 2, 23, 30), new Date(2026, 10, 3, 6, 0), new Date(2026, 10, 1, 21, 0), new Date(2026, 10, 5, 6, 0)].map((d) => tunnelend.clockWords(d.getTime(), now)),
    ['23:30 today', '06:00 tomorrow', '21:00 yesterday', '06:00 on 2026-11-05']);
});

test('the tunnel is kept on until its end: a start inside it turns it on again with a new address, said to the admin and audited; turned off, it stays off', { timeout: 60_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const settingsOf = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  const link = await standInLink(t);
  const ENV = { AGM_DATA_DIR: dataDir };
  let s = await serverWithLink(t, link, ENV);

  // Turned on: until the end of the show day (the next 06:00 an hour or more away), kept in the settings, and said in its
  // answer, on tunnel:status in the laptop's words and time of day, in health, in "This laptop" and in the audit log.
  const before = Date.now();
  const on = await ask(s.ctl, 'admin:tunnelStart');
  assert.equal(on.ok, true);
  assert.ok(eitherOf((x) => tunnelend.defaultEnd(x, readings.dayEnds), before).includes(on.until), 'the end of the show day: ' + new Date(on.until).toString());
  assert.ok(on.until - before >= tunnelend.MIN_AHEAD_MS, 'never an end minutes away');
  assert.ok(eitherOf((x) => tunnelend.clockWords(on.until, x), before).includes(on.untilWords), on.untilWords);
  assert.equal(on.notKept, '');
  await until(() => s.heard.some((x) => x.url), 8000, 'the address');
  const first = await ask(s.ctl, 'admin:tunnelStatus');
  assert.deepEqual(Object.keys(first), ['ok', 'running', 'url', 'error', 'checking', 'check', 'until', 'untilWords', 'untilClock', 'again', 'againWords', 'notKept']);
  assert.deepEqual([first.running, first.until, first.untilWords, first.untilClock, first.again, first.againWords, first.notKept], [true, on.until, on.untilWords, '06:00', null, '', '']);
  await until(() => settingsOf().tunnelUntil === on.until, 4000, 'the end kept in the settings');
  assert.equal((await health(s.srv.base)).tunnel.until, on.until, 'health says the end');
  assert.deepEqual(await linkRow(s.ctl), ['on: ' + first.url + ' · until ' + on.untilWords + ', then off', 'ok']);
  assert.deepEqual(await ask(s.ctl, 'admin:tunnelStart'), { ok: true, running: true, url: first.url, until: on.until, untilWords: on.untilWords, notKept: '' }, 'one already on keeps its end');

  // Tunnel until…: the next such time by the laptop's clock, kept, said to every admin page with its words; asked again,
  // the same answer and no second row. One that names no time of day, or with the tunnel off, is refused with words.
  const two = timeAbout(2, on.until);
  const words = tunnelend.clockWords(two.at, Date.now());
  const moved = await emit(s.ctl, 'admin:tunnelUntil', { until: two.hm });
  assert.deepEqual(moved, { ok: true, until: two.at, untilWords: words });
  await until(() => s.heard.some((x) => x.until === two.at && x.untilWords === words && x.untilClock === two.hm), 4000, 'the new end on tunnel:status');
  await until(() => settingsOf().tunnelUntil === two.at, 4000, 'the new end kept');
  assert.deepEqual(await emit(s.ctl, 'admin:tunnelUntil', { until: two.hm }), moved, 'asked again, the same answer');
  const NOT_A_TIME = 'Give the end as a time of day, HH:MM by this laptop\'s clock (for example 23:30).';
  for (const p of [{ until: '25:00' }, { until: 2330 }, { until: ['23:30'] }, {}, null, 'x']) assert.deepEqual(await emit(s.ctl, 'admin:tunnelUntil', p), { ok: false, error: NOT_A_TIME }, JSON.stringify(p));
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).until, two.at, 'refusals moved nothing');
  assert.deepEqual(await linkRows(s), [['tunnel.on', 'admin', 'the internet link turned on, until ' + on.untilWords], ['tunnel.until', 'admin', 'the internet link\'s end moved to ' + words]]);

  // AGMessage stops and starts again inside the end: the tunnel is turned on again, its end the same, its address new,
  // and once cloudflared gives that address the admin is told so: `again` on tunnel:status, "This laptop", the console
  // and the audit log.
  await stopServer(s.srv.child);
  const restartedAt = Date.now();
  s = await serverWithLink(t, link, ENV);
  await until(async () => { const st = await ask(s.ctl, 'admin:tunnelStatus'); return st.running && st.url; }, 10_000, 'the tunnel on again');
  const again = await ask(s.ctl, 'admin:tunnelStatus');
  assert.match(again.url, ADDRESS);
  assert.notEqual(again.url, first.url, 'a new address');
  assert.deepEqual([again.until, again.untilClock, again.notKept, again.error], [two.at, two.hm, '', null]);
  assert.ok(Number.isInteger(again.again) && again.again >= restartedAt && again.again <= Date.now(), 'turned on again by this start: ' + again.again);
  assert.equal(again.againWords, tunnelend.clockWords(again.again, Date.now()));
  assert.equal((await health(s.srv.base)).tunnel.until, two.at);
  assert.deepEqual(await linkRow(s.ctl), ['on: ' + again.url + ' · until ' + again.untilWords + ', then off · turned on again as AGMessage started at '
    + again.againWords + ': a new address, so remote people need this one', 'ok']);
  const out = s.srv.out();
  assert.ok(out.indexOf('[tunnel] ' + again.url) >= 0 && out.indexOf('[tunnel] ' + again.url) < out.indexOf('[tunnel] on again until ' + again.untilWords + ': a quick tunnel\'s address is new at each start'),
    'on again said once its address is given:\n' + out);
  await until(() => link.asked.some((u) => u === '/api/health'), 15_000, 'the new address checked from the laptop');
  assert.deepEqual((await linkRows(s)).slice(2), [['tunnel.again', 'system', 'the internet link turned on again as AGMessage started, until ' + again.untilWords + ', with a new address']]);

  // Turned off: forgotten at once, so the next start leaves it off.
  assert.equal((await ask(s.ctl, 'admin:tunnelStop')).ok, true);
  await until(() => s.heard.some((x) => !x.running), 4000, 'the tunnel off');
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 4000, 'the end forgotten');
  assert.deepEqual(await emit(s.ctl, 'admin:tunnelUntil', { until: two.hm }), { ok: false, error: 'The internet link is off: turn it on first.' });
  assert.deepEqual((await linkRows(s)).slice(3), [['tunnel.off', 'admin', 'the internet link turned off']]);
  await stopServer(s.srv.child);
  s = await serverWithLink(t, link, ENV);
  await wait(1500);
  const off = await ask(s.ctl, 'admin:tunnelStatus');
  assert.deepEqual([off.running, off.url, off.until, off.again], [false, null, null, null], 'turned off, it stays off');
  assert.ok(!/\[tunnel\]/.test(s.srv.out()), 'nothing said of a tunnel:\n' + s.srv.out());
});

test('past its end, or with an end no act sets, a start leaves the tunnel off and forgets it; a running tunnel is turned off as its end comes; unread settings turn it on for this run and refuse a new end', { timeout: 90_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const file = path.join(dataDir, 'settings.json');
  const settingsOf = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const keep = (until) => { fs.writeFileSync(file, JSON.stringify({ ...settingsOf(), tunnelUntil: until }, null, 2)); };
  const link = await standInLink(t);
  const ENV = { AGM_DATA_DIR: dataDir };
  let s = await serverWithLink(t, link, ENV);
  await stopServer(s.srv.child);
  const kept = settingsOf();

  // Past its end: off, the end forgotten, and said.
  keep(Date.now() - 60_000);
  s = await serverWithLink(t, link, ENV);
  await until(() => /\[tunnel\] its end, \d\d:\d\d (today|yesterday), came while AGMessage was not running: the internet link stays off/.test(s.srv.out()), 4000, 'the past end said');
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 4000, 'the past end forgotten');
  assert.deepEqual(settingsOf(), kept, 'nothing else of the settings changed');
  const past = await ask(s.ctl, 'admin:tunnelStatus');
  assert.deepEqual([past.running, past.until, past.again], [false, null, null]);
  assert.equal((await health(s.srv.base)).tunnel.until, null);
  await stopServer(s.srv.child);

  // Further ahead than any end can be set (a clock set back, a file written by hand): off, and forgotten.
  keep(Date.now() + tunnelend.MAX_AHEAD_MS + 3600_000);
  s = await serverWithLink(t, link, ENV);
  await until(() => /\[tunnel\] its kept end is not one AGMessage sets: the internet link stays off/.test(s.srv.out()), 4000, 'the unread end said');
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 4000, 'the unread end forgotten');
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).running, false);
  await stopServer(s.srv.child);
  assert.deepEqual(link.asked, [], 'no tunnel was started, so nothing came through the link');

  // Inside its end at the start, then the end comes while it runs: turned off within a health window, forgotten, audited,
  // and off at the next start.
  const soon = Date.now() + 6000;
  keep(soon);
  s = await serverWithLink(t, link, ENV);
  await until(async () => (await ask(s.ctl, 'admin:tunnelStatus')).running, 6000, 'on again inside its end');
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).until, soon);
  await until(() => s.heard.some((x) => !x.running), 20_000, 'turned off as its end comes');
  assert.ok(Date.now() >= soon, 'not before its end');
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 4000, 'the end forgotten');
  assert.match(s.srv.out(), /\[tunnel\] its end, \d\d:\d\d (today|yesterday), has come: the internet link is off/);
  assert.deepEqual((await linkRows(s)).map(([a, who]) => [a, who]), [['tunnel.again', 'system'], ['tunnel.ended', 'system']]);
  await stopServer(s.srv.child);
  s = await serverWithLink(t, link, ENV);
  await wait(1500);
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).running, false, 'its end come, it stays off');
  await stopServer(s.srv.child);

  // Settings that could not be read: Turn on still turns the link on, its end held for this run only, and every answer
  // says a restart does not turn it on again; Tunnel until…, which would only change a setting, is refused with why, as
  // every setting is; nothing is written over the file.
  const bytes = fs.readFileSync(file);
  s = await serverWithLink(t, link, { ...ENV, NODE_OPTIONS: preloads('busy-preload.js'), AGM_TEST_UNREADABLE: 'settings.json' });
  const unkeptOn = await ask(s.ctl, 'admin:tunnelStart');
  assert.match(unkeptOn.notKept, /^Not saved: .*settings\.json could not be read \(EBUSY\), so this run saves no setting over it\. /);
  await until(() => s.heard.some((x) => x.url), 8000, 'the address');
  const unkept = await ask(s.ctl, 'admin:tunnelStatus');
  assert.deepEqual([unkept.notKept, unkept.until], [unkeptOn.notKept, unkeptOn.until], 'its end held in memory, and said not kept');
  assert.deepEqual(await emit(s.ctl, 'admin:tunnelUntil', { until: timeAbout(3).hm }), { ok: false, error: unkept.notKept });
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).until, unkeptOn.until, 'the refusal moved nothing');
  const [words, mark] = await linkRow(s.ctl);
  assert.equal(mark, 'warn');
  assert.ok(words.endsWith(' · ' + unkept.notKept), words);
  await stopServer(s.srv.child);
  assert.deepEqual(fs.readFileSync(file), bytes, 'nothing written over the settings it could not read');
  s = await serverWithLink(t, link, ENV);
  await wait(1500);
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).running, false, 'no end was kept, so the next start leaves it off');
});

test('a start that cannot turn the link on again says so and keeps its end; a crash ends cloudflared and keeps it; with it off and its end kept, Turn on keeps that end and Turn off forgets it', { timeout: 90_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  const file = path.join(dataDir, 'settings.json');
  const kills = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-kills-')), 'kills.txt');
  const settingsOf = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const keep = (until) => { fs.writeFileSync(file, JSON.stringify({ ...settingsOf(), tunnelUntil: until }, null, 2)); };
  const link = await standInLink(t);
  const ENV = { AGM_DATA_DIR: dataDir };
  const FAILS = { ...ENV, AGM_TEST_TUNNEL_FAIL: '1' };
  let s = await serverWithLink(t, link, ENV);
  await stopServer(s.srv.child);
  const end = Date.now() + 3 * 3600_000;
  const NOT_AGAIN = /^Not turned on again as AGMessage started at \d\d:\d\d (today|yesterday): cloudflared exited \(code 1\)\.$/;

  // A start whose cloudflared ends before it gives an address (a boot before the network is up): never said to be on
  // again; said not turned on again on the card, "This laptop" and the console; its end kept for the next start.
  keep(end);
  s = await serverWithLink(t, link, FAILS);
  const notAgain = async () => { const st = await ask(s.ctl, 'admin:tunnelStatus'); return !st.running && !!st.error && st; };
  await until(notAgain, 6000, 'the link not turned on again');
  const failed = await ask(s.ctl, 'admin:tunnelStatus');
  assert.match(failed.error, NOT_AGAIN);
  assert.deepEqual([failed.running, failed.url, failed.until, failed.again], [false, null, end, null]);
  assert.match(s.srv.out(), /\[tunnel\] not turned on again: cloudflared exited \(code 1\)\. It was to stay on until \d\d:\d\d (today|tomorrow): Turn on on the admin page, or a start of AGMessage before then, tries again\./);
  assert.ok(!/\[tunnel\] on again/.test(s.srv.out()), 'never said to be on again:\n' + s.srv.out());
  assert.deepEqual(await linkRow(s.ctl), ['off: ' + failed.error + ' · it was to stay on until ' + failed.untilWords + ': Turn on, or a start of AGMessage before then, turns it on again', 'warn']);
  assert.equal(settingsOf().tunnelUntil, end, 'its end kept');
  assert.deepEqual(await linkRows(s), [], 'nothing turned on, nothing audited');
  // Turn on keeps that end; its own cloudflared ending before an address leaves nothing on, so nothing kept.
  const on = await ask(s.ctl, 'admin:tunnelStart');
  assert.deepEqual([on.ok, on.until], [true, end], 'Turn on keeps the end a start could not turn on again');
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 6000, 'a Turn on that turned nothing on keeps no end');
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).error, 'cloudflared exited (code 1).');
  assert.deepEqual(await linkRows(s), [], 'nothing was on, so nothing is audited');
  await stopServer(s.srv.child);

  // Off with its end kept: Turn off… keeps it off, audited, and the next start leaves it off.
  keep(end);
  s = await serverWithLink(t, link, FAILS);
  await until(notAgain, 6000, 'the link not turned on again');
  assert.equal((await ask(s.ctl, 'admin:tunnelStop')).ok, true);
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).until, null);
  await until(() => !Object.hasOwn(settingsOf(), 'tunnelUntil'), 4000, 'forgotten');
  assert.deepEqual((await linkRows(s)).slice(-1), [['tunnel.off', 'admin', 'the internet link kept off (cloudflared had ended; a start before its end would have turned it on again)']]);
  await stopServer(s.srv.child);
  s = await serverWithLink(t, link, ENV);
  await wait(1500);
  assert.equal((await ask(s.ctl, 'admin:tunnelStatus')).running, false, 'kept off, it stays off');
  await stopServer(s.srv.child);

  // A crash with the link up: cloudflared is ended with the server (never left running beside the next one's) and the end
  // is kept, so the next start turns the link on again.
  keep(end);
  s = await serverWithLink(t, link, { ...ENV, AGM_TEST_TUNNEL_KILLS: kills, AGM_TEST_TUNNEL_CRASH: '2000' });
  const crashedChild = s.srv.child;
  const code = crashedChild.exitCode !== null ? crashedChild.exitCode : await new Promise((resolve) => { crashedChild.once('exit', resolve); });
  assert.equal(code, require('../lib/resilience').EXIT.CRASH, 'a crash');
  assert.match(s.srv.out(), /\[tunnel\] on again until [^\n]*\n[\s\S]*a crash under test, with the tunnel up/, 'on again, then the crash:\n' + s.srv.out());
  assert.deepEqual(fs.readFileSync(kills, 'utf8'), crashedChild.pid + ' SIGTERM\n', 'its cloudflared ended by the crash');
  assert.equal(settingsOf().tunnelUntil, end, 'its end kept through the crash');
  s = await serverWithLink(t, link, ENV);
  await until(async () => { const st = await ask(s.ctl, 'admin:tunnelStatus'); return st.running && st.url && Number.isInteger(st.again); }, 10_000, 'on again after the crash');
});
