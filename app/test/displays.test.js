'use strict';
// Displays: what a screen may be told to show, the store (a capability URL looked up by hash, replaced at once), and end
// to end — a screen opened by its link shows what an operator takes and confirms it; "on screen" only after it did; the
// link only shows, never sends; rights per hall; the hall's countdown reaches its screens; nothing of the link in the
// audit log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { Displays, cleanContent, describe } = require('../lib/displays');
const { startServer, stopServer, api, connect, emit, wait, until, fakeStagewatch } = require('./helpers');

const IMG = '/uploads/1777424589360-onmqm0a3ew2r-holding.png';

test('displays: content is cleaned, or refused in words', () => {
  assert.deepEqual(cleanContent({ kind: 'holding' }), { kind: 'holding' });
  assert.deepEqual(cleanContent({ kind: 'holding', image: IMG }), { kind: 'holding', image: IMG });
  for (const bad of ['/uploads/../x.png', 'https://evil.example/a.png', '/uploads/1777424589360-onmqm0a3ew2r-notes.txt']) assert.ok(cleanContent({ kind: 'holding', image: bad }).error, bad);
  assert.deepEqual(cleanContent({ kind: 'message', text: '  Five minutes\u0007 ', tone: 'loud' }), { kind: 'message', text: 'Five minutes', tone: 'info', sub: '' });
  assert.ok(cleanContent({ kind: 'message', text: '   ' }).error);
  assert.deepEqual(cleanContent({ kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-deck.pdf', name: 'deck.pdf', page: 3 }), { kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-deck.pdf', name: 'deck.pdf', page: 3, pdf: true });
  assert.ok(cleanContent({ kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-sheet.xlsx' }).error, 'a spreadsheet is not a screen');
  assert.deepEqual(cleanContent({ kind: 'countdown', text: 'Wrap up', tone: 'warn' }), { kind: 'countdown', text: 'Wrap up', tone: 'warn' });
  assert.ok(cleanContent({ kind: 'iframe', url: 'x' }).error, 'an unknown kind is refused');
  assert.equal(describe({ kind: 'message', tone: 'urgent', text: 'Fire alarm test' }), 'urgent message: “Fire alarm test”');
  assert.equal(describe({ kind: 'countdown', text: '' }), 'the countdown');
});

test('displays: the token is looked up by its hash, sealed at rest, replaced at once; "shown" only for the newest take', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-disp-'));
  const seal = (t) => 'enc1:' + Buffer.from(t).toString('base64');
  const open = (s) => Buffer.from(String(s).slice(5), 'base64').toString();
  const store = new Displays(path.join(dir, 'displays.json'), { seal, open });
  const { display, path: p } = store.create('HALL01', 'Lectern monitor', 'pat');
  const token = p.slice(3);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.byToken(token), display);
  assert.equal(store.byToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(store.path(display), p, 'a manager can copy the link again');
  store.flush();
  const raw = fs.readFileSync(path.join(dir, 'displays.json'), 'utf8');
  assert.ok(!raw.includes(token), 'the token is not on disk in clear');
  assert.ok(!raw.includes('"live"'), 'runtime state is not saved');
  assert.equal(Displays.status(display).state, 'offline');
  display.live.sockets = 1;
  store.take(display.id, { kind: 'black' }, 'pat');
  assert.equal(Displays.status(display).state, 'sending');
  assert.equal(store.shown(display, display.seq - 1, true), true, 'an older seq still moves the confirmation forward');
  assert.equal(Displays.status(display).state, 'sending', '…but the newest take is not on screen yet');
  assert.equal(store.shown(display, display.seq, true), true);
  assert.deepEqual([Displays.status(display).state, Displays.status(display).mark], ['shown', '✓']);
  assert.equal(store.shown(display, display.seq - 2, true), false, 'a late echo of an older take is ignored');
  store.take(display.id, { kind: 'file', url: IMG }, 'pat');
  store.shown(display, display.seq, false, 'the image did not load');
  assert.deepEqual([Displays.status(display).state, Displays.status(display).mark], ['error', '△']);
  const next = store.rotate(display.id);
  assert.equal(store.byToken(token), null, 'the old link stops at once');
  assert.equal(store.byToken(next.slice(3)), display);
  const again = new Displays(path.join(dir, 'displays.json'), { seal, open });
  store.flush();
  assert.equal(new Displays(path.join(dir, 'displays.json'), { seal, open }).byToken(next.slice(3)).name, 'Lectern monitor', 'a restart keeps the screens');
  assert.ok(again);
});

test('displays end to end: links, takes, confirmations, rights, the countdown, the audit', async (t) => {
  const sw = await fakeStagewatch({ name: 'Hall 3 timer' });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const other = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall], password: 'mixing desk on stage left' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'stu', name: 'Stu Staff', role: 'staff', halls: [hall], password: 'coffee urn in the foyer' }, { cookie: admin });
  const sam = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' })).cookie;
  const stu = (await api(base, 'POST', '/api/auth/login', { username: 'stu', password: 'coffee urn in the foyer' })).cookie;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const tech = await connect(base, sam); sockets.push(tech);
  const staff = await connect(base, stu); sockets.push(staff);

  const made = await emit(ctl, 'display:create', { code: hall, name: 'Lectern monitor' });
  assert.ok(made.ok, JSON.stringify(made));
  const link = made.display.path;
  const token = link.slice(3);
  const screen = (tok) => new Promise((resolve, reject) => {
    const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: tok } });
    sockets.push(s);
    const got = { states: [], stages: [], identify: [], unknown: null, socket: s };
    s.on('display:state', (x) => got.states.push(x));
    s.on('display:stage', (x) => got.stages.push(x));
    s.on('display:identify', (x) => got.identify.push(x));
    s.on('display:unknown', (x) => { got.unknown = x; });
    s.once('connect', () => resolve(got));
    s.once('connect_error', reject);
  });

  await t.test('the link\'s page is the same page for any token, never cached, never indexed', async () => {
    const good = await fetch(base + link);
    const bad = await fetch(base + '/d/' + 'x'.repeat(43));
    assert.equal(good.status, 200); assert.equal(bad.status, 200);
    assert.equal(await good.text(), await bad.text());
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.match(good.headers.get('x-robots-tag'), /noindex/);
    assert.equal(good.headers.get('referrer-policy'), 'no-referrer');
  });

  let scr;
  await t.test('a screen opened by its link gets what to show; it is offline until then, sending, then on screen once it says so', async () => {
    let list = await emit(ctl, 'display:list', { code: hall });
    assert.equal(list.displays[0].state, 'offline');
    scr = await screen(token);
    await until(() => scr.states.length === 1, 3000, 'the first state');
    assert.equal(scr.states[0].content.kind, 'holding');
    assert.equal(scr.states[0].name, 'Lectern monitor');
    assert.equal(scr.states[0].hallName, 'Hall 3');
    const take = await emit(tech, 'display:take', { id: made.display.id, content: { kind: 'message', text: 'Five minutes, please wrap up', tone: 'warn' } });
    assert.ok(take.ok, JSON.stringify(take));
    assert.equal(take.status.state, 'sending', 'sent is not shown');
    await until(() => scr.states.length === 2, 3000, 'the take');
    assert.deepEqual(scr.states[1].content, { kind: 'message', text: 'Five minutes, please wrap up', tone: 'warn', sub: '' });
    scr.socket.emit('display:shown', { seq: scr.states[1].seq, ok: true });
    await until(async () => (await emit(tech, 'display:list', { code: hall })).displays[0].state === 'shown', 3000, 'on screen');
    list = await emit(tech, 'display:list', { code: hall });
    assert.equal(list.displays[0].showing, 'warning: “Five minutes, please wrap up”');
    assert.equal(list.displays[0].path, undefined, 'a tech drives screens but does not get their links');
  });

  await t.test('the link only shows: everything else it says is not listened to', async () => {
    const noAck = (ev, arg) => Promise.race([new Promise((resolve) => scr.socket.emit(ev, arg, () => resolve('answered'))), wait(500).then(() => 'silence')]);
    assert.equal(await noAck('join', { roomCode: hall, name: 'Screen', role: 'research' }), 'silence');
    assert.equal(await noAck('display:take', { id: made.display.id, content: { kind: 'black' } }), 'silence');
    assert.equal(await noAck('board:watch', {}), 'silence');
  });

  await t.test('rights: staff cannot drive screens; a tech cannot drive another hall\'s or make screens; a bad content is refused', async () => {
    assert.equal((await emit(staff, 'display:list', { code: hall })).ok, false);
    assert.equal((await emit(staff, 'display:take', { id: made.display.id, content: { kind: 'black' } })).ok, false);
    const o = await emit(ctl, 'display:create', { code: other, name: 'Foyer TV' });
    assert.equal((await emit(tech, 'display:take', { id: o.display.id, content: { kind: 'black' } })).ok, false);
    assert.equal((await emit(tech, 'display:create', { code: hall, name: 'Mine' })).ok, false, 'making screens is display.manage');
    const bad = await emit(tech, 'display:take', { id: made.display.id, content: { kind: 'holding', image: 'https://evil.example/x.png' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /holding image/);
  });

  await t.test('the hall\'s countdown reaches its screens, with the message under it', async () => {
    assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall3_node_key_00001' })).ok);
    await until(() => sw.connected, 6000, 'Stagewatch linked');
    assert.ok((await emit(tech, 'display:take', { id: made.display.id, content: { kind: 'countdown', text: 'Q&A next', tone: 'info' } })).ok);
    await until(() => scr.states.some((s) => s.content.kind === 'countdown'), 3000, 'countdown take');
    sw.frame({ text: '03:00', seconds: 180 });
    await until(() => scr.stages.some((st) => st.text === '03:00'), 3000, 'the frame on the screen');
    assert.equal(scr.stages[scr.stages.length - 1].title, 'Hall 3 timer');
  });

  await t.test('identify shows the name; a new link stops the old screen at once; an unknown link is told so', async () => {
    assert.equal((await emit(tech, 'display:identify', { id: made.display.id })).screens, 1);
    await until(() => scr.identify.length === 1, 3000, 'identify');
    assert.equal(scr.identify[0].name, 'Lectern monitor');
    const r = await emit(ctl, 'display:rotate', { id: made.display.id });
    assert.ok(r.ok && r.path !== link);
    await until(() => scr.unknown, 3000, 'the old screen told');
    const old = await screen(token);
    await until(() => old.unknown, 3000, 'the old link refused');
    assert.equal(old.states.length, 0);
    const fresh = await screen(r.path.slice(3));
    await until(() => fresh.states.length === 1, 3000, 'the new link works');
  });

  await t.test('the audit log says who put what on which screen — and never a link', async () => {
    const a = await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin });
    const takes = a.body.entries.filter((e) => e.action === 'display.take');
    assert.ok(takes.some((e) => e.actor.name === 'sam' && /Five minutes/.test(e.words)));
    assert.ok(a.body.entries.some((e) => e.action === 'display.rotate'));
    const raw = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
    assert.ok(!raw.includes(token), 'no screen link in the audit log');
    assert.ok(!/\/d\/[A-Za-z0-9_-]{43}/.test(raw));
  });

  await t.test('closing a hall removes its screens and stops their links', async () => {
    const o = (await emit(ctl, 'display:list', { code: other })).displays[0];
    const foyer = await screen(o.path.slice(3));
    await until(() => foyer.states.length === 1, 3000, 'foyer screen');
    assert.ok((await emit(ctl, 'admin:deleteRoom', { roomCode: other })).ok);
    await until(() => foyer.unknown, 3000, 'the foyer screen told');
    assert.equal((await emit(ctl, 'display:list', { code: other })).ok, false);
  });
});
