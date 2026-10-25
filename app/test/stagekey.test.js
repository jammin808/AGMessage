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
    await until(() => link.status === 'connected', 3000, 'connected after auth ok');
    assert.deepEqual([link.keyState, link.keyVia, link.keyNode], ['accepted', 'auth', 'ab12cd34'], 'its node is what it said back');
    assert.equal(pins.pins['url:127.0.0.1:' + sw.port], sw.fp, 'pinned once accepted');
    assert.deepEqual(verdicts.map((v) => v.state), ['accepted']);
    await until(() => link.view && link.view.text === '05:00', 2000, 'the frame that waited behind the auth message');
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

  assert.ok((await emit(ctl, 'admin:settings', { stagewatchKey: KEY })).ok);   // the admin enters the key Stagewatch lists
  await until(async () => (await emit(ctl, 'admin:settings')).stage === 'connected', 6000, 'connected with the right key');
  await until(() => seen.some((v) => v.status === 'connected' && v.text === '05:00'), 4000, 'the hall shows the timer');
  await until(() => Object.keys(settingsOnDisk().tlsPins || {}).includes('url:127.0.0.1:' + sw.port), 4000, 'the certificate pinned once accepted');
  const rowsNow = await keyRows();
  assert.equal(rowsNow.length, 2);
  assert.match(rowsNow[0].words, /^Stagewatch accepted the key \(an authenticated read\), certificate pinned$/);
});
