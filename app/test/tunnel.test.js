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
const { TOKEN, startServer, stopServer, api, connect, emit, wait, until } = require('./helpers');

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
    assert.deepEqual(h.tunnel, { places: 4, max: 4, share: 2, networks: 4, refused: { rate: 0, share: 0, full: 1, idle: 0, wrongCode: 0 } });
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
    const ana = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
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
 * cloudflared does, from loopback with Cloudflare's headers, and counts them. `mode`: 'on', 'off' (a link that does not
 * answer) or 'slow' (each answer 1.5 s late). With a server under test whose cloudflared it stands in for (the preload).
 */
async function linkServer(t, env = {}) {
  const link = { asked: [], mode: 'on', target: '' };
  const standIn = http.createServer((req, res) => {
    link.asked.push(req.url);
    if (link.mode === 'off') { res.writeHead(502); res.end('Bad gateway'); return; }
    const pass = () => fetch(link.target + req.url, { headers: viaTunnel('203.0.113.200') })
      .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
      .catch(() => { res.writeHead(502); res.end(); });
    if (link.mode === 'slow') setTimeout(pass, 1500); else pass();
  });
  await new Promise((resolve) => { standIn.listen(0, '127.0.0.1', resolve); });
  const preload = '--require "' + path.join(__dirname, 'tunnel-preload.js').split(path.sep).join('/') + '"';
  const srv = await startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_TUNNEL: 'http://127.0.0.1:' + standIn.address().port, ...env });
  link.target = srv.base;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); standIn.close(); });
  const login = await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN });
  const ctl = await connect(srv.base, login.cookie);
  sockets.push(ctl);
  const heard = [];
  ctl.on('tunnel:status', (st) => heard.push(st));
  return { link, srv, ctl, heard };
}
const ADDRESS = /^https:\/\/agm-test-link-\d+\.trycloudflare\.com$/;

test('the internet link is checked from the laptop when it is up, and again only a minute after its last check', async (t) => {
  const { link, ctl, heard } = await linkServer(t);
  const { asked } = link;

  assert.deepEqual(await ask(ctl, 'admin:tunnelStatus'), { ok: true, running: false, url: null, error: null, checking: false, check: null }, 'off: no check');
  assert.equal((await ask(ctl, 'admin:tunnelStart')).ok, true);
  await until(() => heard.some((s) => s.check), 15_000, 'the check on tunnel:status');
  const done = heard.find((s) => s.check);
  assert.deepEqual(Object.keys(done), ['running', 'url', 'error', 'checking', 'check'], 'check appended at the end');
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
