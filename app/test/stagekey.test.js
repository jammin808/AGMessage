'use strict';
// A Stagewatch link is "connected", and its certificate pinned, only once Stagewatch accepted AGMessage's key: 2.18 says
// so in its first /ws message ({"type":"auth","ok",…}); 2.16 says nothing on the socket and sends its public frames to any
// key, so one authenticated read (GET /api/context) is the verdict. A refused key lets the socket go, shows Stagewatch's
// words everywhere and is asked again only after Stagewatch's lockout minute, so a wrong key never locks this machine out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nodes = require('../lib/nodes');
const tlsmod = require('../lib/tls');
const { buildContext, showBrief } = require('../lib/context');
const { startServer, stopServer, api, connect, emit, until, wait, fakeStagewatch } = require('./helpers');

const KEY = 'swk_right_node_key_0001';     // secret-scan: fixture — the node key the fake Stagewatch lists
const WRONG = 'swk_wrong_node_key_0002';   // secret-scan: fixture — a key it does not list
const OTHER = 'swk_another_key_000003';    // secret-scan: fixture — the key it lists after AGMessage's was revoked
const certOf = () => tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });

function linkWith(extra = {}) {
  const pins = new tlsmod.PinStore();
  const statuses = [];
  const verdicts = [];
  let pinSaves = 0;
  const link = new nodes.StagewatchLink({ nodeId: 'ab12cd34', pins, onStatus: (s) => statuses.push(s), onKey: (k) => verdicts.push(k), onPins: () => { pinSaves++; }, ...extra });
  return { link, pins, statuses, verdicts, saves: () => pinSaves };
}

test('2.18: the auth message comes first — checking until ok:true, then connected and pinned', async () => {
  const sw = await fakeStagewatch({ key: KEY, auth18: true, authDelayMs: 400, cert: certOf() });
  const { link, pins, statuses, verdicts } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => sw.open === 1, 4000, 'the socket open');
    await wait(150);
    assert.equal(link.status, 'checking key', 'not connected before Stagewatch says it accepted the key: ' + statuses.join(' → '));
    assert.deepEqual(Object.keys(pins.pins), [], 'nothing pinned before the key is accepted');
    assert.match((await link.propose({ line: 'x' })).error, /has not accepted this AGMessage's key yet — not proposed/);
    assert.equal((await link.reportResult('p1', true, 'x')).status, 0, 'nothing authenticated goes before the verdict');
    assert.deepEqual(sw.requests, [], 'not one request');
    await until(() => link.status === 'connected', 3000, 'connected after auth ok');
    assert.deepEqual([link.keyState, link.keyVia, link.keyNode], ['accepted', 'auth', 'ab12cd34'], 'its node is what it said back');
    assert.equal(pins.pins['url:127.0.0.1:' + sw.port], sw.fp, 'pinned once accepted');
    assert.deepEqual(verdicts.map((v) => v.state), ['accepted']);
    await until(() => link.view && link.view.text === '05:00', 2000, 'the frame that waited behind the auth message');
    await until(() => link.context && link.context.v === 1, 2000, 'its context read once the key is accepted');
  } finally { link.stop(); await sw.close(); }
});

test('2.18: auth ok:false — refused with Stagewatch\'s words, never connected or pinned, the socket let go, no redial', async () => {
  for (const closeOnRefuse of [false, true]) {
    const sw = await fakeStagewatch({ key: KEY, auth18: true, closeOnRefuse, cert: certOf() });
    const { link, pins, statuses } = linkWith();
    try {
      link.configure(sw.url, WRONG);
      await until(() => link.keyState === 'refused', 4000, 'refused');
      await wait(2000);
      assert.ok(!statuses.includes('connected'), 'never connected: ' + statuses.join(' → '));
      assert.equal(link.status, 'key refused: unknown or revoked API key', 'its words field');
      assert.deepEqual(Object.keys(pins.pins), []);
      assert.equal(sw.open, 0, 'the socket is let go');
      assert.equal(sw.counts.upgrades, 1, 'no redial inside the hold');
      assert.deepEqual(sw.requests, [], 'not one HTTP request: the auth message was the verdict');
      const r = await link.sendToStage('Two minutes');
      assert.equal(r.stage, 'not sent');
      assert.match(r.error, /refused this AGMessage's key \(unknown or revoked API key\)/);
      assert.ok(!sw.requests.some((q) => q.url.startsWith('/api/message/')), 'nothing sent with a refused key');
    } finally { link.stop(); await sw.close(); }
  }
});

test('2.16, the right key: frames alone say nothing of the key — checking until an authenticated read answers, then connected and pinned', async () => {
  const sw = await fakeStagewatch({ key: KEY, contextDelayMs: 400, cert: certOf() });
  const { link, pins, statuses } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => sw.open === 1 && link.view, 4000, 'the socket open, a frame in');
    sw.frame({ text: '04:59' }); sw.frame({ text: '04:58' });
    await wait(150);
    assert.equal(link.status, 'checking key', statuses.join(' → '));
    assert.deepEqual(Object.keys(pins.pins), [], 'frames do not pin');
    assert.equal(link.linked, false);
    await until(() => link.status === 'connected', 3000, 'connected once /api/context answered 200');
    assert.equal(link.keyVia, 'request');
    assert.equal(pins.pins['url:127.0.0.1:' + sw.port], sw.fp);
    assert.ok(link.context && link.context.v === 1, 'the read that decided is the context the AI and the admin page are given');
    assert.equal(sw.requests.filter((q) => q.url === '/api/context').length, 1, 'one read decided');
  } finally { link.stop(); await sw.close(); }
});

test('2.16, a wrong key: frames still flow, yet refused, no timer shown, nothing pinned, the socket let go', async () => {
  const sw = await fakeStagewatch({ key: KEY, cert: certOf() });
  const { link, pins, statuses } = linkWith();
  try {
    link.configure(sw.url, WRONG);
    await wait(2500);
    assert.ok(!statuses.includes('connected'), 'never connected: ' + statuses.join(' → '));
    assert.equal(link.status, 'key refused: unknown or revoked API key');
    assert.equal(link.view, null, 'no timer from a Stagewatch that refused the key');
    assert.equal(link.context, null);
    assert.deepEqual(Object.keys(pins.pins), [], 'not pinned');
    assert.equal(sw.open, 0, 'the socket let go');
    assert.ok(sw.counts.failures <= 2, 'one upgrade and one read, far under its lockout of 5 a minute: ' + sw.counts.failures);
  } finally { link.stop(); await sw.close(); }
});

test('2.16 with a viewing code: its refusal stays the status (never "reconnecting"), and no fast redials', async () => {
  const sw = await fakeStagewatch({ key: KEY, viewCode: true });
  const { link, statuses } = linkWith();
  try {
    link.configure(sw.url, WRONG);
    await wait(4000);
    assert.equal(link.status, 'key refused: This screen needs the viewing code', statuses.join(' → '));
    assert.ok(!statuses.includes('reconnecting'), statuses.join(' → '));
    assert.equal(sw.counts.upgrades, 1, 'one dial, then the hold');
    assert.ok(sw.counts.failures < 5, 'under its lockout: ' + sw.counts.failures);
  } finally { link.stop(); await sw.close(); }
});

test('the pin waits for the key: frames while the verdict cannot be had (404 in Stagewatch\'s first second) pin nothing', async () => {
  const sw = await fakeStagewatch({ key: KEY, contextFail: 3, cert: certOf() });
  const { link, pins, saves } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => sw.open === 1 && link.view, 4000, 'frames in');
    for (let i = 0; i < 3; i++) sw.frame({ text: '04:5' + i });
    await wait(200);
    assert.deepEqual(Object.keys(pins.pins), [], 'no pin while the key is unknown, frames or not');
    assert.equal(saves(), 0);
    assert.equal(link.status, 'checking key');
    await until(() => sw.requests.filter((q) => q.url === '/api/context').length >= 2, 4000, 'asked again');
    await until(() => link.status === 'connected', 8000, 'connected once the context answered 200');
    assert.deepEqual(Object.keys(pins.pins), ['url:127.0.0.1:' + sw.port]);
    assert.equal(saves(), 1);
    assert.equal(sw.counts.failures, 0, 'a 404 is no refusal');
  } finally { link.stop(); await sw.close(); }
});

test('a key revoked while connected: the next authenticated answer (401) refuses the link, and sends stop being tried', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const { link } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => link.status === 'connected', 4000, 'connected');
    assert.ok(await link.checkDesk('ab12cd34') && link.context, 'a desk and a context while accepted');
    sw.key = OTHER;   // the operator revoked AGMessage's key
    const r = await link.sendToStage('Two minutes');
    assert.deepEqual([r.ok, r.stage], [false, 'refused']);
    assert.equal(link.status, 'key refused: unknown or revoked API key');
    assert.equal(link.linked, false);
    const sends = sw.requests.filter((q) => q.url.startsWith('/api/message/')).length;
    const again = await link.sendToStage('Two minutes');
    assert.equal(again.stage, 'not sent');
    assert.equal(sw.requests.filter((q) => q.url.startsWith('/api/message/')).length, sends, 'the next send is not even tried');
    assert.equal((await link.propose({ line: 'x' })).ok, false);
    assert.deepEqual([link.context, link.desk], [null, false], 'what the refused key read is not shown, the desk asked again later');
    const asked = sw.requests.length;
    for (const a of [await link.proposalAnswer('p1'), await link.reportResult('p1', true, 'x')]) assert.equal(a.status, 0);
    assert.equal(await link.checkDesk('ab12cd34'), false);
    assert.equal(sw.requests.length, asked, 'the refused key goes nowhere: no follow, no result, no desk check');
  } finally { link.stop(); await sw.close(); }
});

test('a refused key is asked again only after the hold; a key Stagewatch now lists connects', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const { link, verdicts } = linkWith({ refusedRetryMs: 1500 });
  try {
    link.configure(sw.url, WRONG);
    await until(() => link.keyState === 'refused', 4000, 'refused');
    const n = sw.counts.upgrades;
    await wait(1000);
    assert.equal(sw.counts.upgrades, n, 'nothing inside the hold');
    sw.key = WRONG;   // the operator adds that key in Stagewatch
    await until(() => link.status === 'connected', 5000, 'connected after the hold');
    assert.ok(link.view && link.view.text === '05:00', 'the frame that came while it was checked again is shown once accepted');
    assert.deepEqual(verdicts.map((v) => v.state), ['refused', 'accepted']);
  } finally { link.stop(); await sw.close(); }
});

test('each socket earns its own verdict: after a drop, a key revoked meanwhile is refused, not carried over', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const { link, statuses } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => link.status === 'connected', 4000, 'connected');
    sw.key = OTHER;
    sw.drop();   // the network dropped: the link redials
    await until(() => link.keyState === 'refused', 8000, 'refused on the new socket');
    const after = statuses.slice(statuses.lastIndexOf('reconnecting'));
    assert.ok(after.includes('checking key'), after.join(' → '));
    assert.ok(!after.includes('connected'), 'not connected on the new socket before its verdict: ' + after.join(' → '));
  } finally { link.stop(); await sw.close(); }
});

test('no key: viewing — frames, nothing authenticated sent, never pinned; a viewing code refuses it, lifted it views again', async () => {
  const sw = await fakeStagewatch({ key: KEY, cert: certOf() });
  const { link, pins } = linkWith({ refusedRetryMs: 800 });
  try {
    link.configure(sw.url, '');
    await until(() => link.view && link.view.text === '05:00', 4000, 'a frame');
    await wait(300);
    assert.equal(link.status, 'viewing');
    assert.equal(link.linked, false);
    assert.deepEqual(sw.requests, [], 'not one HTTP request');
    assert.deepEqual(Object.keys(pins.pins), []);
    assert.equal((await link.sendToStage('x')).stage, 'not sent');
  } finally { link.stop(); await sw.close(); }

  const coded = await fakeStagewatch({ key: KEY, viewCode: true });
  const view = linkWith({ refusedRetryMs: 800 });
  try {
    view.link.configure(coded.url, '');
    await until(() => view.link.keyState === 'refused', 4000, 'refused by the viewing code');
    assert.equal(view.link.status, 'refused: This screen needs the viewing code');
    coded.viewCode = false;   // the operator lifts the viewing code
    await until(() => view.link.status === 'viewing', 4000, 'viewing again after the hold');
    assert.equal(view.link.keyState, 'none');
  } finally { view.link.stop(); await coded.close(); }
});

test('the context and the AI\'s brief: one light for a link\'s state, its own or a hall\'s; a refusal named in Stagewatch\'s words', () => {
  const cases = [
    [{ status: 'checking key', key: 'checking' }, 'amber', 'checking AGMessage\'s key'],
    [{ status: 'viewing', key: 'none' }, 'amber', 'viewing — no key, nothing is sent to the stage'],
    [{ status: 'key refused: unknown or revoked API key', key: 'refused', keyWords: 'unknown or revoked API key' }, 'red', 'refused AGMessage\'s key: unknown or revoked API key'],
    [{ status: 'connected', key: 'accepted', view: { text: '05:00' } }, 'green', 'timer 05:00'],
  ];
  for (const [stage, light, words] of cases) {
    const ctx = buildContext({ node: { id: 'ab12cd34', name: 'AGMessage' }, rooms: [], stage, halls: [stage], peers: [], recent: [] });
    const own = ctx.items.find((i) => i.id === 'link:stagewatch');
    const hall = ctx.items.find((i) => i.id === 'link:stagewatch:2');
    assert.deepEqual([own.light, hall.light], [light, light], stage.status);
    assert.equal(own.state, words);
    assert.equal(hall.state, words);
  }
  // A certificate problem met while a refused key is asked again shows as itself, not as the key's refusal.
  const changed = { status: 'CERTIFICATE CHANGED for Stagewatch — refused until the admin accepts it', key: 'refused', keyWords: 'unknown or revoked API key' };
  const cctx = buildContext({ node: { id: 'ab12cd34', name: 'AGMessage' }, rooms: [], stage: changed, halls: [changed], peers: [], recent: [] });
  assert.deepEqual(cctx.items.filter((i) => i.kind === 'link' && /stagewatch/.test(i.id)).map((i) => [i.light, i.state]), [[ 'red', changed.status ], [ 'red', changed.status ]]);
  assert.match(showBrief({ ...changed, view: null }, []), /^Stage timer: Stagewatch link is CERTIFICATE CHANGED/);
  const brief = showBrief({ status: 'key refused: unknown or revoked API key', key: 'refused', keyWords: 'unknown or revoked API key', view: null }, []);
  assert.match(brief, /refused AGMessage's key \(unknown or revoked API key\): nothing can be sent to its stage/);
  assert.match(showBrief({ status: 'checking key', key: 'checking', view: { text: '05:00' } }, []), /key is being checked: nothing is sent/);
  assert.match(showBrief({ status: 'viewing', key: 'none', view: { title: 'Keynote', text: '05:00' } }, []), /Keynote — 05:00 \(no key: nothing can be sent to the stage\)/);
});

test('end to end: a wrong key reads "key refused" on every page, sends nothing, pins nothing and never locks this machine out', async (t) => {
  const sw = await fakeStagewatch({ name: 'Keynote timer', key: KEY, cert: certOf() });
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const { base } = srv;
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie: admin })).body.code;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const crew = await connect(base); sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: hall, name: 'Alex', role: 'research' })).roomCode);
  const seen = [];
  crew.on('stage', (v) => seen.push(v));
  const board = await emit(ctl, 'board:watch', {});
  assert.ok(board.ok);

  assert.ok((await emit(ctl, 'admin:settings', { stagewatchUrl: sw.url, stagewatchKey: WRONG })).ok);
  await until(async () => /^key refused/.test((await emit(ctl, 'admin:settings')).stage), 6000, 'the admin page says key refused');
  await wait(8000);   // 0.5.0 made about 1.4 wrong-key requests a second here, and Stagewatch locks an address at 5 a minute
  const s = await emit(ctl, 'admin:settings');
  assert.equal(s.stage, 'key refused: unknown or revoked API key');
  assert.equal(s.health.stageKey.state, 'refused');
  assert.equal(s.tls.link.pinned, false);
  assert.ok(sw.counts.failures <= 2, 'at most the upgrade and one read in the lockout minute: ' + sw.counts.failures);
  const last = seen[seen.length - 1];
  assert.deepEqual([last.status, last.key, last.text], ['key refused: unknown or revoked API key', 'refused', undefined], 'the hall is told, with no timer');
  const row = (await emit(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hall);
  assert.equal(row.stage.key, 'refused');
  const targets = await emit(crew, 'stage:targets', {});
  assert.deepEqual([targets.key, targets.canSend, targets.linked], ['refused', false, false]);
  const sent = await emit(crew, 'stage:send', { text: 'Wrap up please' });
  assert.equal(sent.stage, 'not sent');
  assert.ok(!sw.requests.some((q) => q.url.startsWith('/api/message/')), 'nothing reached Stagewatch');
  const settingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settingsOnDisk().tlsPins || {}), [], 'no certificate pinned for a Stagewatch that refused the key');
  const keyRows = async () => (await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'stagewatch.key');
  const refusedRows = await keyRows();
  assert.equal(refusedRows.length, 1, 'one row for the verdict, not one per attempt');
  assert.equal(refusedRows[0].words, 'Stagewatch refused the key: unknown or revoked API key');
  assert.ok(!JSON.stringify(refusedRows).includes('swk_'), 'never the key');

  const late = await connect(base); sockets.push(late);
  assert.equal((await emit(late, 'join', { roomCode: hall, name: 'Bea', role: 'research' })).canSendToStage, false, 'a page opened now is offered no send');
  assert.ok((await emit(ctl, 'admin:settings', { stagewatchKey: KEY })).ok);   // the admin enters the key Stagewatch lists
  await until(async () => (await emit(ctl, 'admin:settings')).stage === 'connected', 6000, 'connected with the right key');
  await until(() => seen.some((v) => v.status === 'connected' && v.text === '05:00'), 4000, 'the hall shows the timer');
  await until(() => Object.keys(settingsOnDisk().tlsPins || {}).includes('url:127.0.0.1:' + sw.port), 4000, 'the certificate pinned once accepted');
  const rowsNow = await keyRows();
  assert.equal(rowsNow.length, 2);
  assert.match(rowsNow[0].words, /^Stagewatch accepted the key \(an authenticated read\), certificate pinned$/);
  sw.drop();   // the network dropped: the same key accepted again on a new socket is no news
  await until(async () => (await emit(ctl, 'admin:settings')).stage === 'connected' && sw.counts.upgrades >= 3, 8000, 'connected again');
  assert.equal((await keyRows()).length, 2);
  sw.key = OTHER;   // a new key, listed: its verdict is news
  assert.ok((await emit(ctl, 'admin:settings', { stagewatchKey: OTHER })).ok);
  await until(async () => (await keyRows()).length === 3, 8000, 'the new key\'s acceptance recorded');
});

test('the hold and the words: longer than Stagewatch\'s lockout minute; a refusal shown without control characters or a key', () => {
  assert.ok(nodes.REFUSED_RETRY_MS > nodes.LOCKOUT_MS && nodes.LOCKOUT_MS >= 60_000);
  assert.equal(nodes.refusalWords('unknown key swk_abcdefgh12345 \u0007from\nhere'), 'unknown key swk_… from here');
  assert.equal(nodes.refusalWords('x'.repeat(300)).length, 120);
  assert.equal(nodes.refusalWords(42), '');
});

test('a new key or address shows nothing of the last: "connecting" at once, no old timer, nothing sent until its verdict', async () => {
  const sw = await fakeStagewatch({ key: KEY, auth18: true, authDelayMs: 600 });
  const { link } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => link.status === 'connected' && link.view, 4000, 'connected');
    link.configure(sw.url, WRONG);
    assert.deepEqual([link.status, link.view, link.linked], ['connecting', null, false], 'not connected with the last key\'s timer');
    assert.equal((await link.pushContext({ v: 1 })), false);
    await until(() => link.keyState === 'refused', 4000, 'refused');
    assert.deepEqual(sw.requests.filter((q) => q.headers.authorization === 'Bearer ' + WRONG).map((q) => q.url), [], 'nothing went with the new key before its verdict');
  } finally { link.stop(); await sw.close(); }
});

test('a 401 to a request made under the last key refuses nothing once a new key is accepted', async () => {
  const sw = await fakeStagewatch({ key: KEY, messageDelayMs: 800 });
  const { link } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => link.status === 'connected', 4000, 'connected');
    const late = link.sendToStage('Two minutes');   // judged by Stagewatch only after the key has changed
    sw.key = OTHER;
    link.configure(sw.url, OTHER);
    await until(() => link.status === 'connected', 4000, 'connected with the new key');
    assert.equal((await late).stage, 'refused', 'the old request was refused');
    assert.equal(link.status, 'connected', 'and the new key stays accepted');
  } finally { link.stop(); await sw.close(); }
});

test('an answer that comes after the refusal is not taken: no context shown for a refused key', async () => {
  const sw = await fakeStagewatch({ key: KEY, contextDelayMs: 600 });
  const { link } = linkWith();
  try {
    link.configure(sw.url, KEY);
    await until(() => link.status === 'connected', 6000, 'connected');
    const pending = link.fetchContext();   // judged under the key now, answered 600 ms later
    await wait(150);
    sw.key = OTHER;
    await link.sendToStage('x');           // the 401 that refuses the key comes first
    assert.equal(link.keyState, 'refused');
    assert.equal(await pending, null);
    assert.equal(link.context, null, 'the late context is not shown');
  } finally { link.stop(); await sw.close(); }
});

test('the verdict\'s read: a 403 refuses, a 429 waits its Retry-After, and a refused key asked again keeps its own words', async () => {
  const forbidden = await fakeStagewatch({ key: KEY, answerContext: [{ status: 403, error: 'HTTPS is required for keys' }] });
  const a = linkWith();
  try {
    a.link.configure(forbidden.url, KEY);
    await until(() => a.link.keyState === 'refused', 4000, 'refused');
    assert.equal(a.link.status, 'key refused: HTTPS is required for keys');
  } finally { a.link.stop(); await forbidden.close(); }

  const busy = await fakeStagewatch({ key: KEY, answerContext: [{ status: 429, error: 'rate limit: too many requests with this key', retryAfter: 2 }] });
  const b = linkWith();
  try {
    b.link.configure(busy.url, KEY);
    await until(() => b.link.status === 'connected', 6000, 'connected after its Retry-After');
    const reads = busy.requests.filter((q) => q.url === '/api/context');
    assert.ok(reads[1].at - reads[0].at >= 2000, 'asked again only after Retry-After: ' + (reads[1].at - reads[0].at) + ' ms');
  } finally { b.link.stop(); await busy.close(); }

  const sw = await fakeStagewatch({ key: KEY });
  const c = linkWith({ refusedRetryMs: 500 });
  try {
    c.link.configure(sw.url, WRONG);
    await until(() => c.link.keyState === 'refused', 4000, 'refused');
    // The key is listed now, but its minute is spent: Stagewatch answers the read 429 (Authorize, then Spend).
    sw.key = WRONG;
    sw.answerContext = [{ status: 429, error: 'rate limit: too many requests with this key', retryAfter: 5 }];
    await until(() => sw.answerContext.length === 0, 4000, 'asked again, and met a 429');
    await wait(100);
    assert.equal(c.link.keyState, 'refused');
    assert.equal(c.link.keyWords, 'unknown or revoked API key', 'still its refusal\'s words');
    assert.match((await c.link.sendToStage('x')).error, /\(unknown or revoked API key\)/);
  } finally { c.link.stop(); await sw.close(); }
});

test('a certificate is accepted only when the link refused one: never a way round a refused key\'s hold', async () => {
  const sw = await fakeStagewatch({ key: KEY, cert: certOf() });
  const { link } = linkWith();
  try {
    link.configure(sw.url, WRONG);
    await until(() => link.keyState === 'refused', 4000, 'refused');
    const n = sw.counts.upgrades;
    assert.equal(link.acceptCertificate(), false, 'no certificate problem: nothing to accept');
    await wait(500);
    assert.deepEqual([sw.counts.upgrades, link.keyState], [n, 'refused'], 'no dial with the refused key');
  } finally { link.stop(); await sw.close(); }
});

/** The most wrong keys Stagewatch counted from here in any `windowMs`, from its failure times (at or after `from`). */
const worstWindow = (times, windowMs, from = 0) => { const t = times.filter((x) => x >= from); return t.length ? Math.max(...t.map((x) => t.filter((y) => y >= x && y < x + windowMs).length)) : 0; };

test('the shared minute\'s arithmetic: room while at most two wrong attempts are in the window, never a wait past it', () => {
  const at = 'budget-arithmetic:1';
  assert.equal(nodes.lockoutRoomIn(at, 3000, 1000), 0, 'nothing counted');
  nodes.noteWrong(at, 2, 3000, 1000);
  assert.equal(nodes.lockoutRoomIn(at, 3000, 1500), 0, 'two in the window: a re-ask (two more) makes four');
  nodes.noteWrong(at, 1, 3000, 1500);
  assert.equal(nodes.lockoutRoomIn(at, 3000, 1600), 2401, 'three: until the oldest is out of the window');
  assert.equal(nodes.lockoutRoomIn(at, 3000, 4001), 0, 'it has aged out');
  nodes.noteWrong(at, 3, 3000, 50_000);
  assert.ok(nodes.lockoutRoomIn(at, 3000, 50_000) <= 3001, 'never a wait longer than the window');
});

test('three links of this machine refused by one Stagewatch, by its address and by its name, share its lockout: never five wrong keys in its window', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  // Stagewatch's minute as 3 s, each link's own hold 300 ms: on its own, each would ask again ten times a window.
  const links = [1, 2, 3].map(() => linkWith({ refusedRetryMs: 300, lockoutMs: 3000 }).link);
  try {
    const start = Date.now();
    links.forEach((l, i) => l.configure(i === 2 ? 'localhost:' + sw.port : sw.url, WRONG));
    await wait(10_000);
    const times = sw.failureTimes.filter((x) => x >= start + 3500);   // the first refusals of all three, aged out
    assert.ok(times.length >= 4, 'they did ask again: ' + times.length);
    assert.ok(worstWindow(times, 3000) <= 4, 'wrong keys in any window: ' + worstWindow(times, 3000));
  } finally { for (const l of links) l.stop(); await sw.close(); }
});

test('a revoked key\'s requests already on their way are each counted: another refused key waits for room', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const a = linkWith({ refusedRetryMs: 3600, lockoutMs: 3000 }).link;
  const b = linkWith({ refusedRetryMs: 3600, lockoutMs: 3000 }).link;
  try {
    const start = Date.now();
    b.configure(sw.url, WRONG);
    a.configure(sw.url, KEY);
    await until(() => b.keyState === 'refused' && a.status === 'connected', 4000, 'one refused, one connected');
    await wait(start + 3300 - Date.now());   // b's first refusal has left the window; its hold has not ended
    sw.key = OTHER;                          // a's key revoked while three of its requests are out
    await Promise.all([a.pushContext({ v: 1 }), a.fetchContext(), a.checkDesk('ab12cd34')]);
    assert.equal(a.keyState, 'refused');
    await wait(5000);
    assert.ok(b.keyState === 'refused' && sw.counts.upgrades >= 3, 'b did ask again');
    assert.ok(worstWindow(sw.failureTimes, 3000) <= 4, 'wrong keys in any window: ' + worstWindow(sw.failureTimes, 3000) + ' at ' + sw.failureTimes.map((x) => x - start));
  } finally { a.stop(); b.stop(); await sw.close(); }
});

test('a re-ask whose second attempt comes late holds its places until its verdict: never five in the window', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const links = [1, 2, 3].map(() => linkWith({ refusedRetryMs: 300, lockoutMs: 3000 }).link);
  try {
    const start = Date.now();
    for (const l of links) l.configure(sw.url, WRONG);
    await until(() => links.every((l) => l.keyState === 'refused'), 4000, 'all refused');
    sw.firstFrameDelayMs = 1200;   // from now on each socket's key read is sent 1.2 s after its upgrade
    await wait(9000);
    const times = sw.failureTimes.filter((x) => x >= start + 3500);
    assert.ok(times.length >= 4, 'they did ask again: ' + times.length);
    assert.ok(worstWindow(times, 3000) <= 4, 'wrong keys in any window: ' + worstWindow(times, 3000));
  } finally { for (const l of links) l.stop(); await sw.close(); }
});

test('other links\' first refusals count: a refused key waits while they fill the window', async () => {
  const sw = await fakeStagewatch({ key: KEY });
  const a = linkWith({ refusedRetryMs: 3600, lockoutMs: 3000 }).link;
  const others = [1, 2].map(() => linkWith({ refusedRetryMs: 3600, lockoutMs: 3000 }).link);
  try {
    const start = Date.now();
    a.configure(sw.url, WRONG);
    await until(() => a.keyState === 'refused', 4000, 'a refused');
    await wait(start + 2900 - Date.now());
    for (const l of others) l.configure(sw.url, WRONG);   // four wrong keys just before a's hold ends
    await until(() => others.every((l) => l.keyState === 'refused'), 4000, 'both refused');
    const n = sw.counts.upgrades;
    await wait(start + 5500 - Date.now());
    assert.equal(sw.counts.upgrades, n, 'a did not ask again while the window held four');
    await until(() => sw.counts.upgrades > n, 4000, 'and asked once two of them aged out');
  } finally { a.stop(); for (const l of others) l.stop(); await sw.close(); }
});

test('only the certificate\'s fingerprint changed for a refused key: it stays refused and its hold stands', async () => {
  const sw = await fakeStagewatch({ key: KEY, cert: certOf() });
  const { link } = linkWith();
  try {
    link.configure(sw.url, WRONG);
    await until(() => link.keyState === 'refused', 4000, 'refused');
    const n = sw.counts.upgrades;
    link.configure(sw.url, WRONG, sw.fp);
    link.configure(sw.url, WRONG, '');
    await wait(600);
    assert.deepEqual([sw.counts.upgrades, link.keyState, link.status], [n, 'refused', 'key refused: unknown or revoked API key'], 'no dial with the refused key');
  } finally { link.stop(); await sw.close(); }
});
