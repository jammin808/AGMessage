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
const KEY = 'swk_hall3_node_key_00001';   // secret-scan: fixture — a fake node key for the fake Stagewatch

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
  // Holding with no image of its own shows the hall's holding image when the hall has one: the words say so.
  assert.equal(describe({ kind: 'holding' }, IMG), 'holding image');
  assert.equal(describe({ kind: 'holding' }), 'holding (black)');
  assert.equal(describe({ kind: 'holding' }, ''), 'holding (black)');
  assert.equal(describe({ kind: 'holding', image: IMG }), 'holding image');
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
  store.joined(display, 'projector');
  store.take(display.id, { kind: 'black' }, 'pat');
  assert.equal(Displays.status(display).state, 'sending');
  assert.equal(store.shown(display, 'projector', display.seq - 1, true), true, 'an older seq still moves the confirmation forward');
  assert.equal(Displays.status(display).state, 'sending', '…but the newest take is not on screen yet');
  assert.equal(store.shown(display, 'projector', display.seq, true), true);
  assert.deepEqual([Displays.status(display).state, Displays.status(display).mark], ['shown', '✓']);
  assert.equal(store.shown(display, 'projector', display.seq - 2, true), false, 'a late echo of an older take is ignored');
  assert.equal(store.shown(display, 'nobody', display.seq, true), false, 'a report from a browser not on the link is ignored');
  store.take(display.id, { kind: 'file', url: IMG }, 'pat');
  store.shown(display, 'projector', display.seq, false, 'the image did not load');
  assert.deepEqual([Displays.status(display).state, Displays.status(display).mark], ['error', '△']);
  const next = store.rotate(display.id);
  assert.equal(store.byToken(token), null, 'the old link stops at once');
  assert.equal(store.byToken(next.slice(3)), display);
  const again = new Displays(path.join(dir, 'displays.json'), { seal, open });
  store.flush();
  assert.equal(new Displays(path.join(dir, 'displays.json'), { seal, open }).byToken(next.slice(3)).name, 'Lectern monitor', 'a restart keeps the screens');
  assert.ok(again);
});

const scratchStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-disp-'));
  return new Displays(path.join(dir, 'displays.json'), { seal: (t) => 'enc1:' + Buffer.from(t).toString('base64'), open: (x) => Buffer.from(String(x).slice(5), 'base64').toString() });
};

test('displays: every browser on a link reports for itself — one that could not show a take is never hidden by one that did', () => {
  const store = scratchStore();
  const { display: d } = store.create('HALL01', 'Projector', 'pat');
  store.joined(d, 'projector'); store.joined(d, 'laptop');
  store.take(d.id, cleanContent({ kind: 'file', url: IMG, name: 'holding.png' }), 'pat');
  assert.ok(store.shown(d, 'projector', d.seq, false, 'the image did not load'));
  assert.ok(store.shown(d, 'laptop', d.seq, true));
  let st = Displays.status(d);
  assert.deepEqual([st.state, st.mark, st.screens], ['error', '△', 2], 'the laptop\'s ✓ does not hide the projector\'s △');
  assert.match(st.words, /on 1 of 2 screens/);
  assert.match(st.words, /the image did not load/);
  store.take(d.id, { kind: 'black' }, 'pat');
  st = Displays.status(d);
  assert.deepEqual([st.state, st.words], ['sending', 'sending'], 'a new take: no browser has shown it yet');
  store.shown(d, 'laptop', d.seq, true);
  st = Displays.status(d);
  assert.deepEqual([st.state, st.mark, st.words], ['sending', '…', 'sending — on 1 of 2 screens'], 'one of two is not ✓');
  store.shown(d, 'projector', d.seq, true);
  st = Displays.status(d);
  assert.deepEqual([st.state, st.mark, st.words], ['shown', '✓', 'on all 2 screens']);
  store.left(d, 'projector');
  st = Displays.status(d);
  assert.deepEqual([st.state, st.words, st.screens], ['shown', 'on screen', 1], 'a browser that left no longer counts');
  // The same page reconnecting (a blip) is the same screen: its new connection replaces the old one's entry, and the
  // old connection going later does not take the new one with it.
  store.joined(d, 'laptop', 'sock-2');
  assert.equal(Displays.status(d).screens, 1);
  assert.equal(store.shown(d, 'laptop', d.seq, true, '', 'sock-1'), false, 'a report from the old connection is not the screen\'s');
  assert.equal(Displays.status(d).state, 'sending', 'the reconnected page has not said what it shows yet');
  assert.ok(store.shown(d, 'laptop', d.seq, true, '', 'sock-2'));
  store.left(d, 'laptop', 'sock-1');
  assert.deepEqual([Displays.status(d).state, Displays.status(d).screens], ['shown', 1]);
  store.left(d, 'laptop', 'sock-2');
  assert.equal(Displays.status(d).state, 'offline');
});

test('displays: a PDF page past the end — the screen\'s note reaches the operator beside ✓', () => {
  const store = scratchStore();
  const { display: d } = store.create('HALL01', 'Projector', 'pat');
  store.joined(d, 'projector');
  store.take(d.id, cleanContent({ kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-agenda.pdf', name: 'agenda.pdf', page: 7 }), 'pat');
  store.shown(d, 'projector', d.seq, true, 'the PDF has 2 pages: showing the last');
  const st = Displays.status(d);
  assert.deepEqual([st.state, st.mark], ['shown', '✓']);
  assert.match(st.words + ' — ' + st.showing, /on screen: the PDF has 2 pages: showing the last — PDF page 7 of agenda\.pdf/, 'the board\'s line');
  store.take(d.id, cleanContent({ kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-agenda.pdf', name: 'agenda.pdf', page: 1 }), 'pat');
  store.shown(d, 'projector', d.seq, true, '');
  assert.equal(Displays.status(d).words, 'on screen', 'no note, no words after ✓');
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
    assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
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

  await t.test('a new name reaches the screen; remove stops its link; both are display.manage', async () => {
    const d = (await emit(ctl, 'display:list', { code: hall })).displays.find((x) => x.id === made.display.id);
    const live = await screen(d.path.slice(3));
    await until(() => live.states.length === 1, 3000, 'the screen');
    assert.equal((await emit(tech, 'display:update', { id: d.id, name: 'Mine now' })).ok, false, 'renaming is display.manage');
    assert.equal((await emit(tech, 'display:remove', { id: d.id })).ok, false, 'removing is display.manage');
    assert.equal((await emit(ctl, 'display:update', { id: d.id, hall: 'NOSUCH' })).ok, false, 'an unknown hall is refused');
    assert.ok((await emit(ctl, 'display:update', { id: d.id, name: 'Lectern left' })).ok);
    await until(() => live.states.some((x) => x.name === 'Lectern left'), 3000, 'the new name on the screen');
    assert.ok((await emit(ctl, 'display:remove', { id: d.id })).ok);
    await until(() => live.unknown, 3000, 'the removed screen told');
    assert.ok(!(await emit(ctl, 'display:list', { code: hall })).displays.some((x) => x.id === d.id));
    const again = await screen(d.path.slice(3));
    await until(() => again.unknown, 3000, 'the removed link refused');
  });

  await t.test('the audit log says who put what on which screen — and never a link', async () => {
    const a = await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin });
    const takes = a.body.entries.filter((e) => e.action === 'display.take');
    assert.ok(takes.some((e) => e.actor.name === 'sam' && /Five minutes/.test(e.words)));
    for (const action of ['display.rotate', 'display.update', 'display.remove']) assert.ok(a.body.entries.some((e) => e.action === action), action);
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

/** A browser on a screen link: what it was told, and (with `answer`) it says it showed every take, as display.js does. */
const openScreen = (base, token, sockets, { answer = false, screen } = {}) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: token, ...(screen ? { screen } : {}) } });
  sockets.push(s);
  const got = { states: [], socket: s };
  s.on('display:state', (x) => { got.states.push(x); if (answer) s.emit('display:shown', { seq: x.seq, ok: true, words: '' }); });
  s.once('connect', () => resolve(got));
  s.once('connect_error', reject);
});

test('displays end to end, a hall of screens: every browser counts, one take reaches all, the hall\'s holding image named, the server\'s zone, one re-read per burst', { timeout: 120_000 }, async (t) => {
  const srv = await startServer({ TZ: 'Europe/London' });
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const big = (await api(base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie: admin })).body.code;
  const other = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall, big], password: 'mixing desk on stage left' }, { cookie: admin });
  const sam = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' })).cookie;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const tech = await connect(base, sam); sockets.push(tech);
  const status = async (code, id) => (await emit(ctl, 'display:list', { code })).displays.find((d) => d.id === id);

  await t.test('a screen is told AGMessage\'s time zone with its time, so its clock reads the server\'s time of day', async () => {
    const made = await emit(ctl, 'display:create', { code: hall, name: 'Foyer clock' });
    const scr = await openScreen(base, made.display.path.slice(3), sockets);
    await until(() => scr.states.length === 1, 3000, 'the first state');
    assert.equal(scr.states[0].tz, 'Europe/London');
    assert.ok(Number.isFinite(scr.states[0].now));
    scr.socket.close();
  });

  await t.test('two browsers on one link: a failure on one is not hidden by the other\'s ✓; the count is in the words', async () => {
    const made = await emit(ctl, 'display:create', { code: hall, name: 'Projector' });
    const id = made.display.id;
    const token = made.display.path.slice(3);
    const projector = await openScreen(base, token, sockets, { screen: 'a'.repeat(32) });
    await until(() => projector.states.length === 1, 3000, 'the projector\'s state');
    const take = await emit(tech, 'display:take', { ids: [id], content: { kind: 'file', url: IMG, name: 'holding.png' } });
    assert.ok(take.ok, JSON.stringify(take));
    await until(() => projector.states.length === 2, 3000, 'the take');
    const seq = projector.states[1].seq;
    projector.socket.emit('display:shown', { seq, ok: false, words: 'the image did not load' });
    await until(async () => (await status(hall, id)).state === 'error', 3000, 'the projector says it failed');
    // The manager clicks "Open" to see why: a laptop tab joins the link, renders the take and says it showed it.
    const laptop = await openScreen(base, token, sockets, { screen: 'b'.repeat(32) });
    await until(() => laptop.states.length === 1, 3000, 'the laptop\'s state');
    assert.equal(laptop.states[0].seq, seq);
    laptop.socket.emit('display:shown', { seq, ok: true, words: '' });
    await until(async () => (await status(hall, id)).screens === 2, 3000, 'two screens');
    await wait(300);
    let st = await status(hall, id);
    assert.deepEqual([st.state, st.mark, st.screens], ['error', '△', 2], JSON.stringify(st));
    assert.match(st.words, /1 of 2/);
    assert.match(st.words, /the image did not load/);
    assert.equal((await emit(tech, 'display:identify', { id })).screens, 2);
    const board = (await emit(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hall).displays.find((d) => d.id === id);
    assert.equal(board.state, 'error');
    assert.match(board.words, /could not show it on 1 of 2 screens: the image did not load — image holding\.png/, 'the halls board carries the count');

    assert.ok((await emit(tech, 'display:take', { ids: [id], content: { kind: 'black' } })).ok);
    await until(() => laptop.states.length === 2 && projector.states.length === 3, 3000, 'black on both');
    laptop.socket.emit('display:shown', { seq: laptop.states[1].seq, ok: true });
    await until(async () => /on 1 of 2 screens/.test((await status(hall, id)).words), 3000, 'one of two');
    st = await status(hall, id);
    assert.equal(st.state, 'sending', 'one of two browsers confirmed: not ✓ yet');
    projector.socket.emit('display:shown', { seq: projector.states[2].seq, ok: true });
    await until(async () => (await status(hall, id)).state === 'shown', 3000, 'both confirmed');
    assert.equal((await status(hall, id)).words, 'on all 2 screens');
    // The projector's page blips: its new connection is the same screen, not a third one.
    const again = await openScreen(base, token, sockets, { screen: 'a'.repeat(32), answer: true });
    await until(() => again.states.length === 1, 3000, 'the projector back');
    await until(async () => (await status(hall, id)).state === 'shown', 3000, 'the projector confirms again');
    assert.deepEqual([(await status(hall, id)).screens, (await status(hall, id)).words], [2, 'on all 2 screens']);
    projector.socket.close();
    await wait(300);
    assert.equal((await status(hall, id)).screens, 2, 'the old connection going does not take the reconnected page with it');
    laptop.socket.close();
    await until(async () => (await status(hall, id)).screens === 1, 3000, 'the laptop gone');
    assert.deepEqual([(await status(hall, id)).state, (await status(hall, id)).words], ['shown', 'on screen']);
    again.socket.close();
    await until(async () => (await status(hall, id)).state === 'offline', 3000, 'offline once no browser holds the link');
  });

  await t.test('Holding names the hall\'s holding image on the console, the board and in the audit log', async () => {
    const made = await emit(ctl, 'display:create', { code: other, name: 'Green room' });
    const id = made.display.id;
    assert.equal(made.display.showing, 'holding (black)');
    assert.ok((await emit(ctl, 'display:hallHolding', { code: other, image: IMG })).ok);
    assert.equal((await status(other, id)).showing, 'holding image', 'a screen on Holding shows the hall\'s image');
    const take = await emit(ctl, 'display:take', { ids: [id], content: { kind: 'holding' } });
    assert.ok(take.ok, JSON.stringify(take));
    assert.equal(take.results[0].status.showing, 'holding image');
    const board = (await emit(ctl, 'board:watch', {})).board.halls.find((h) => h.code === other).displays.find((d) => d.id === id);
    assert.match(board.words, /— holding image$/);
    const a = await api(base, 'GET', '/api/audit?limit=50', undefined, { cookie: admin });
    assert.ok(a.body.entries.some((e) => e.action === 'display.take' && e.target === id && e.words === 'Green room → holding image'), 'the audit row names the image');
    assert.ok((await emit(ctl, 'display:hallHolding', { code: other, image: '' })).ok);
    assert.equal((await status(other, id)).showing, 'holding (black)');
  });

  const screens = [];
  await t.test('a take on every ticked screen reaches all of them, a second take right after does too; a screen not the operator\'s is refused on its own line', async () => {
    for (let i = 0; i < 20; i++) screens.push((await emit(ctl, 'display:create', { code: big, name: 'Screen ' + String(i + 1).padStart(2, '0') })).display);
    for (const d of screens) await openScreen(base, d.path.slice(3), sockets, { answer: true });
    const ids = screens.map((d) => d.id);
    const list = async () => (await emit(tech, 'display:list', { code: big })).displays;
    const urgent = await emit(tech, 'display:take', { ids, content: { kind: 'message', text: 'Evacuate via door B', tone: 'urgent' } });
    assert.ok(urgent.ok, JSON.stringify(urgent));
    assert.equal(urgent.results.length, 20);
    assert.ok(urgent.results.every((r) => r.ok && Number.isInteger(r.seq)), JSON.stringify(urgent.results.filter((r) => !r.ok)));
    assert.ok((await list()).every((d) => d.content.kind === 'message'));
    const black = await emit(tech, 'display:take', { ids, content: { kind: 'black' } });
    assert.ok(black.ok && black.results.every((r) => r.ok), JSON.stringify(black));
    let now = await list();
    assert.ok(now.every((d) => d.content.kind === 'black'), 'every screen took black: ' + now.filter((d) => d.content.kind !== 'black').map((d) => d.name).join(', '));
    assert.ok(!now.some((d) => d.content.kind === 'message'), 'no screen is left on the message');
    const hold = await emit(tech, 'display:take', { ids: [...ids, ids[0]], content: { kind: 'holding' } });
    assert.ok(hold.ok && hold.results.length === 20, 'a screen named twice is taken once');
    now = await list();
    assert.ok(now.every((d) => d.content.kind === 'holding'));
    const theirs = (await emit(ctl, 'display:create', { code: other, name: 'Not Sam\'s' })).display.id;
    const mixed = await emit(tech, 'display:take', { ids: [ids[0], theirs, ids[1]], content: { kind: 'clock' } });
    assert.equal(mixed.ok, false);
    assert.deepEqual(mixed.results.map((r) => r.ok), [true, false, true]);
    assert.match(mixed.results[1].error, /not yours/);
    assert.match(mixed.error, /1 of 3/);
    assert.equal((await status(other, theirs)).content.kind, 'holding', 'the other hall\'s screen is untouched');
    assert.equal((await emit(tech, 'display:take', { ids: 'everything', content: { kind: 'black' } })).ok, false, 'ids is a list');
    assert.equal((await emit(tech, 'display:take', { ids: [], content: { kind: 'black' } })).ok, false, 'at least one screen');
    assert.equal((await emit(tech, 'display:take', { ids: Array.from({ length: 51 }, (_, i) => 'd' + i), content: { kind: 'black' } })).ok, false, 'at most 50');
    const a = await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin });
    assert.equal(a.body.entries.filter((e) => e.action === 'display.take' && /Evacuate via door B/.test(e.words)).length, 20, 'one audit row per screen');
  });

  await t.test('one take on 20 screens: each operator in the hall re-reads the list a bounded number of times, and the last read is the newest', async () => {
    const consoles = [];
    for (let i = 0; i < 4; i++) {
      const c = i === 0 ? tech : await connect(base, sam);
      if (i) sockets.push(c);
      assert.ok((await emit(c, 'join', { roomCode: big, as: 'account' })).ok);
      const stats = { events: 0, lists: 0, last: null };
      c.on('displays:changed', ({ code }) => { stats.events++; if (code === big) c.emit('display:list', { code: big }, (r) => { stats.lists++; stats.last = r; }); });
      consoles.push(stats);
    }
    await wait(1500);
    for (const s of consoles) { s.events = 0; s.lists = 0; s.last = null; }
    const r = await emit(tech, 'display:take', { ids: screens.map((d) => d.id), content: { kind: 'black' } });
    assert.ok(r.ok, JSON.stringify(r));
    await wait(2000);
    for (const s of consoles) {
      assert.ok(s.events >= 1 && s.events <= 3, 'each console heard of the change a bounded number of times: ' + consoles.map((x) => x.events).join(', '));
      assert.ok(s.last && s.last.displays.length === 20 && s.last.displays.every((d) => d.state === 'shown' && d.content.kind === 'black'), 'the last read is the newest state');
    }
  });
});
