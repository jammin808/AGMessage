'use strict';
// Halls: the board's pure parts, and end to end — two halls each following its own Stagewatch (countdowns, sends and
// receipts never cross), the halls board for a project manager and a tech, help requests answered from the board and
// from the hall, and a hall's Stagewatch key kept sealed in the server's settings, never in the room's log. Then the rights
// inside a hall: forwarding is posting where it lands, read-only people change nothing, the admin's room list, a rename
// or a lock reaching open pages as one numbered change, and one person on two devices. Last, a side room beside a hall:
// who reaches it by its key, and who, reading halls, never sees it; what it never sends to a Stagewatch, and what it
// still counts for (the power request, the busy line); the rights asked in it, room by room; and a hall's rooms made,
// renamed, reset and removed, the admin's reads of one audited, and a closed hall's node proposing nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const board = require('../lib/board');
const tlsmod = require('../lib/tls');
const { buildContext } = require('../lib/context');
const { cleanText } = require('../lib/guard');
const { io } = require('socket.io-client');
const { startServer, restartServer, stopServer, api, connect, emit, answer, once, wait, until, fakeStagewatch, fakeNode, freePort, TOKEN } = require('./helpers');
const wire = require('../lib/machinewire');

// Fake node keys for the fake Stagewatches: the shape of a real one, so the test proves where each goes.
const KEY_A = 'swk_hallA_node_key_0001';   // secret-scan: fixture
const KEY_B = 'swk_hallB_node_key_0002';   // secret-scan: fixture

test('board: a message in one line, the last message, open help, a hall row', () => {
  assert.equal(board.lineOf({ type: 'text', text: 'Radio mic 3\nbattery low' }), 'Radio mic 3 battery low');
  assert.equal(board.lineOf({ type: 'file', filename: 'run.pdf', caption: 'v4' }), '📄 run.pdf — v4');
  assert.equal(board.lineOf({ type: 'help', category: 'Sound', text: 'no signal' }), 'Help: Sound — no signal');
  assert.equal(board.lineOf({ type: 'text', text: 'x'.repeat(500) }).length, 120);
  const base = { id: 'm1', at: 1000, from: { uid: 'u', name: 'Sam', role: 'research' }, pinned: false, priority: false };
  const h = board.helpMessage(base, { category: 'Lasers', text: 'Projector\u202e off' }, cleanText);
  assert.equal(h.category, 'Other', 'an unknown category is Other');
  assert.equal(h.text, 'Projector off', 'bidi overrides dropped');
  assert.deepEqual(h.help, { state: 'open', by: '', at: 1000 });
  assert.equal(h.priority, true);
  const room = { code: 'HALL01', name: 'Hall 1', users: new Map([['s', {}]]), messages: [
    { ...base, type: 'text', text: 'first' }, h, { id: 'm3', type: 'system', text: 'Sam joined', at: 2000 },
    { ...base, id: 'm4', type: 'help', category: 'Vision', text: 'done', help: { state: 'resolved' } },
  ] };
  assert.deepEqual(board.lastMessage(room), { name: 'Sam', text: 'Help: Vision — done', at: 1000 }, 'system lines are not news');
  assert.deepEqual(board.openHelp(room).map((x) => x.id), ['m1'], 'resolved help leaves the board');
  const row = board.hallRow(room, { stage: { text: '05:00', status: 'connected' }, now: 5 });
  assert.deepEqual({ ...row, last: null }, { code: 'HALL01', name: 'Hall 1', people: 1, last: null, help: 1, stage: { text: '05:00', status: 'connected' }, displays: [], at: 5 });
  const twoDevices = new Map([['laptop', { uid: 'a1' }], ['phone', { uid: 'a1' }], ['tab', { uid: 'g7' }]]);
  assert.equal(board.hallRow({ ...room, users: twoDevices }).people, 2, 'people, not sockets');
});

test('context: help requests are a count, never who or what; a hall\'s own Stagewatch is listed by its own name', () => {
  const ctx = buildContext({
    node: { id: 'ab12cd34', name: 'AGMessage' }, rooms: [], stage: { status: 'off' }, peers: [], aiOn: false, tunnel: false, recent: [],
    help: 2, halls: [{ status: 'connected', view: { text: '12:00' }, context: { node: { name: 'Hall B timer' } } }],
  });
  const help = ctx.items.find((i) => i.id === 'help');
  assert.deepEqual(help, { id: 'help', kind: 'room', label: 'Help requests', light: 'red', state: '2 help requests open' });
  assert.equal(ctx.light, 'red');
  assert.match(ctx.headline, /2 help requests open/);
  assert.equal(ctx.items.find((i) => i.id === 'link:stagewatch:2').label, 'Stagewatch Hall B timer');
  // People, as the board counts them: an account on a laptop and a phone is one person.
  const users = new Map([['laptop', { uid: 'a1', role: 'research' }], ['phone', { uid: 'a1', role: 'research' }], ['tab', { uid: 'g7', role: 'observer' }]]);
  const two = buildContext({ node: { id: 'ab12cd34', name: 'AGMessage' }, rooms: [{ users, messages: [] }], stage: { status: 'off' }, peers: [], aiOn: false, tunnel: false, recent: [] });
  assert.equal(two.items.find((i) => i.id === 'meetings').state, '1 meeting · 2 people (0 board, 1 research, 1 observer)');
});

test('halls end to end: two Stagewatches, the board, help', async (t) => {
  const swA = await fakeStagewatch({ name: 'Hall A timer', messageId: 12 });
  const swB = await fakeStagewatch({ name: 'Hall B timer', messageId: 12 });   // the same message id: they must not cross
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await swA.close(); await swB.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hallA], password: 'mixing desk on stage left' }, { cookie: admin });
  const pat = (await api(base, 'POST', '/api/auth/login', { username: 'pat', password: 'clipboard and coffee' })).cookie;
  const sam = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' })).cookie;

  const ctl = await connect(base, admin); sockets.push(ctl);

  await t.test('a tech may not set a hall up; an admin links each hall to its own Stagewatch, the key sealed in settings only', async () => {
    const tech = await connect(base, sam); sockets.push(tech);
    assert.equal((await emit(tech, 'hall:configure', { code: hallA, stagewatchUrl: swA.url })).ok, false);
    // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
    const bad = await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: 'javascript:alert(1)' });
    assert.equal(bad.ok, false);
    assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: swA.url, stagewatchKey: KEY_A })).ok);
    assert.ok((await emit(ctl, 'hall:configure', { code: hallB, stagewatchUrl: swB.url, stagewatchKey: KEY_B, name: 'Hall B (Auditorium)' })).ok);
    await until(() => swA.connected && swB.connected, 6000, 'both Stagewatches linked');
    const s = await emit(ctl, 'hall:settings', { code: hallA });
    assert.equal(s.stagewatch.keySet, true);
    assert.equal(s.stagewatch.url, 'http://' + swA.url);
    await wait(300);   // the settings lane writes within 100 ms
    const settingsFile = fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8');
    assert.ok(!settingsFile.includes(KEY_A), 'no clear key on disk');
    assert.match(settingsFile, /hallStagewatch/);
    for (const f of fs.readdirSync(path.join(srv.dataDir, 'rooms'))) {
      assert.ok(!/swk_|enc1:/.test(fs.readFileSync(path.join(srv.dataDir, 'rooms', f), 'utf8')), 'nothing of the key in a room file: ' + f);
    }
    const authA = swA.requests.find((r) => r.headers.authorization);
    assert.equal(authA.headers.authorization, 'Bearer ' + KEY_A, 'each hall\'s key goes to its own Stagewatch');
    assert.ok(!swA.requests.some((r) => r.headers.authorization === 'Bearer ' + KEY_B));
  });

  let crewA, crewB;
  await t.test('each hall shows its own countdown; a send and its acknowledgement stay in their hall', async () => {
    crewA = await connect(base); sockets.push(crewA);
    crewB = await connect(base); sockets.push(crewB);
    const ja = await emit(crewA, 'join', { roomCode: hallA, name: 'Alex', role: 'research' });
    const jb = await emit(crewB, 'join', { roomCode: hallB, name: 'Bea', role: 'research' });
    assert.equal(ja.stage.title, 'Hall A timer');
    assert.equal(jb.stage.title, 'Hall B timer');
    assert.ok(ja.canSendToStage && jb.canSendToStage);
    const seenB = [];
    crewB.on('stage', (v) => seenB.push(v));
    swA.frame({ text: '04:59', seconds: 299 });
    await wait(400);
    assert.ok(!seenB.some((v) => v.title === 'Hall A timer'), 'hall B never sees hall A\'s frames');
    const sent = await emit(crewA, 'stage:send', { text: 'Wrap up please' });
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.ok(swA.requests.some((r) => r.url.startsWith('/api/message/Wrap%20up%20please')));
    assert.ok(!swB.requests.some((r) => r.url.startsWith('/api/message/')), 'the send went to hall A\'s Stagewatch only');
    const acksB = [];
    crewB.on('stageAck', (a) => acksB.push(a));
    const ackA = new Promise((resolve) => crewA.on('stageAck', (a) => { if (a.stage.ack === 'done') resolve(a); }));
    swB.frame({ messageId: 12, messageAck: 'done', messageAckBy: 'Speaker B' });   // hall B's message 12, not ours
    await wait(400);
    swA.frame({ messageId: 12, messageAck: 'done', messageAckBy: 'Speaker A' });
    const a = await ackA;
    assert.equal(a.stage.by, 'Speaker A');
    assert.equal(acksB.length, 0, 'the same message number from another Stagewatch acknowledges nothing here');
  });

  await t.test('the board: a project manager sees every hall with its countdown; a tech sees theirs', async () => {
    const pm = await connect(base, pat); sockets.push(pm);
    const r = await emit(pm, 'board:watch', {});
    assert.ok(r.ok);
    const rows = Object.fromEntries(r.board.halls.map((h) => [h.code, h]));
    assert.deepEqual(Object.keys(rows).sort(), [hallA, hallB].sort());
    assert.equal(rows[hallA].stage.title, 'Hall A timer');
    assert.equal(rows[hallB].stage.title, 'Hall B timer');
    assert.equal(rows[hallB].name, 'Hall B (Auditorium)');
    assert.equal(rows[hallA].people, 1);
    const tech = await connect(base, sam); sockets.push(tech);
    const tr = await emit(tech, 'board:watch', {});
    assert.deepEqual(tr.board.halls.map((h) => h.code), [hallA]);
    const anon = await connect(base); sockets.push(anon);
    assert.equal((await emit(anon, 'board:watch', {})).ok, false, 'a code guest has no board');
  });

  await t.test('help: asked in a hall, on the board at once, answered from the board, resolved in the hall; the transcript keeps it', async () => {
    const pm = await connect(base, pat); sockets.push(pm);
    await emit(pm, 'board:watch', {});
    const onBoard = new Promise((resolve) => pm.on('board', (b) => { if (b.help.length) resolve(b); }));
    const m = await emit(crewA, 'message', { type: 'help', category: 'Sound', text: 'Radio mic 3 has no signal' });
    assert.ok(m.ok);
    const b = await onBoard;
    assert.deepEqual(b.help.map((h) => [h.code, h.category, h.text, h.state, h.from, h.canRespond]), [[hallA, 'Sound', 'Radio mic 3 has no signal', 'open', 'Alex', true]]);
    assert.equal(b.halls.find((h) => h.code === hallA).help, 1);
    const ctx = await api(base, 'GET', '/api/context', undefined, { cookie: admin });
    assert.match(ctx.body.headline, /1 help request open/);
    assert.ok(!JSON.stringify(ctx.body).includes('Radio mic'), 'the context never carries what was asked');

    const tech = await connect(base, sam); sockets.push(tech);
    const other = await connect(base); sockets.push(other);
    await emit(other, 'join', { roomCode: hallB, name: 'Bo', role: 'research' });
    assert.equal((await emit(other, 'help:respond', { code: hallA, messageId: m.id, state: 'coming' })).ok, false, 'someone in another hall cannot answer it');
    const updates = [];
    crewA.on('helpUpdate', (u) => updates.push(u));
    assert.ok((await emit(pm, 'help:respond', { code: hallA, messageId: m.id, state: 'coming' })).ok, 'a project manager answers from the board');
    await until(() => updates.length === 1, 3000, 'the hall hears it');
    assert.equal(updates[0].help.state, 'coming');
    assert.equal(updates[0].help.by, 'Pat PM');
    assert.ok((await emit(crewA, 'help:respond', { messageId: m.id, state: 'resolved' })).ok, 'resolved from the hall itself');
    assert.equal((await emit(crewA, 'help:respond', { messageId: m.id, state: 'coming' })).ok, false, 'a resolved request stays resolved');
    const cleared = new Promise((resolve) => pm.on('board', (x) => { if (!x.help.length) resolve(x); }));
    await cleared;
    const tr = await fetch(base + '/api/admin/transcript/' + hallA, { headers: { cookie: admin } });
    assert.match(await tr.text(), /Help — Sound:<\/strong> Radio mic 3 has no signal[\s\S]*resolved — Alex/);
  });

  await t.test('the Help chip\'s two acts are the asker\'s own: an On stage seat cancels one request and marks another sorted; the hall hears each, and each leaves the board', async () => {
    const pm = await connect(base, pat); sockets.push(pm);
    await emit(pm, 'board:watch', {});
    const next = (pred) => new Promise((resolve) => { const on = (b) => { if (pred(b)) { pm.off('board', on); resolve(b); } }; pm.on('board', on); });
    const bea = await connect(base); sockets.push(bea);
    assert.ok((await emit(bea, 'join', { roomCode: hallA, name: 'Bea', role: 'board' })).ok);
    const mine = (b, id) => b.help.filter((h) => h.id === id).map((h) => [h.category, h.text, h.state, h.from]);

    // "Something else" is sent as 'Other'; Cancel request is the author's own delete.
    const askedOne = next((b) => b.help.some((h) => h.text === 'no water at the lectern'));
    const one = await emit(bea, 'message', { type: 'help', category: 'Other', text: 'no water at the lectern' });
    assert.ok(one.ok);
    assert.deepEqual(mine(await askedOne, one.id), [['Other', 'no water at the lectern', 'open', 'Bea']]);
    const deleted = once(crewA, 'messageDeleted');
    const goneOne = next((b) => !b.help.some((h) => h.id === one.id));
    assert.equal((await emit(bea, 'delete', { messageId: one.id })).ok, true);
    assert.equal((await deleted).messageId, one.id, 'the hall hears the request go');
    assert.equal((await goneOne).halls.find((h) => h.code === hallA).help, 0, 'and it leaves the board');

    // It's sorted is the author's own Resolved, whoever was on the way. The hall's updates are kept from before the On my
    // way, so the one read is the resolution itself, however the two are delivered on the hall's socket.
    const askedTwo = next((b) => b.help.some((h) => h.text === 'my lectern mic is dead'));
    const two = await emit(bea, 'message', { type: 'help', category: 'Sound', text: 'my lectern mic is dead' });
    assert.ok(two.ok);
    await askedTwo;
    const updates = [];
    const heardUpdate = (x) => updates.push(x);
    crewA.on('helpUpdate', heardUpdate);
    try {
      assert.ok((await emit(pm, 'help:respond', { code: hallA, messageId: two.id, state: 'coming' })).ok);
      const goneTwo = next((b) => !b.help.some((h) => h.id === two.id));
      assert.ok((await emit(bea, 'help:respond', { messageId: two.id, state: 'resolved' })).ok);
      await until(() => updates.some((x) => x.messageId === two.id && x.help.state === 'resolved'), 4000, 'the hall to hear the request resolved');
      assert.deepEqual(updates.filter((x) => x.messageId === two.id).map((x) => [x.help.state, x.help.by]), [['coming', 'Pat PM'], ['resolved', 'Bea']],
        'the hall hears On my way, then the asker\'s own Resolved');
      assert.equal((await goneTwo).halls.find((h) => h.code === hallA).help, 0);
    } finally {
      crewA.off('helpUpdate', heardUpdate);
    }
    bea.close();
  });

  await t.test('one board tick for every watcher: each gets only the halls it may see, and may answer only where it may post', async () => {
    const pm = await connect(base, pat); sockets.push(pm);
    const tech = await connect(base, sam); sockets.push(tech);
    await emit(pm, 'board:watch', {});
    await emit(tech, 'board:watch', {});
    const seenByTech = [];
    tech.on('board', (b) => seenByTech.push(b));
    const next = (s, ok) => new Promise((resolve) => { const on = (b) => { if (ok(b)) { s.off('board', on); resolve(b); } }; s.on('board', on); });

    const bAsked = next(pm, (b) => b.help.some((h) => h.code === hallB));
    const hb = await emit(crewB, 'message', { type: 'help', category: 'Vision', text: 'Screen 2 is dark' });
    assert.ok(hb.ok);
    const pmB = await bAsked;
    assert.deepEqual(pmB.help.filter((h) => h.code === hallB).map((h) => [h.text, h.canRespond]), [['Screen 2 is dark', true]]);

    const aAsked = (s) => next(s, (b) => b.help.some((h) => h.code === hallA));
    const both = Promise.all([aAsked(pm), aAsked(tech)]);
    const ha = await emit(crewA, 'message', { type: 'help', category: 'Sound', text: 'Lectern mic hum' });
    assert.ok(ha.ok);
    const [pmA, techA] = await both;
    assert.deepEqual(techA.help.map((h) => [h.code, h.text, h.canRespond]), [[hallA, 'Lectern mic hum', true]], 'the tech answers in their own hall');
    assert.ok(seenByTech.length >= 1 && seenByTech.every((b) => b.halls.every((h) => h.code === hallA) && b.help.every((h) => h.code === hallA)), 'nothing of hall B ever reached the tech');
    const rowOf = (b) => { const { nodes, at, stage, ...row } = b.halls.find((h) => h.code === hallA); return row; };
    assert.deepEqual(rowOf(techA), rowOf(pmA), 'hall A\'s row is the same for both');

    const cleared = Promise.all([next(pm, (b) => !b.help.length), next(tech, (b) => !b.help.length)]);
    assert.ok((await emit(crewA, 'help:respond', { messageId: ha.id, state: 'resolved' })).ok);
    assert.ok((await emit(crewB, 'help:respond', { messageId: hb.id, state: 'resolved' })).ok);
    await cleared;
  });

  await t.test('C16: the context posted to hall A\'s Stagewatch carries nothing of hall B\'s meeting', async () => {
    const bodies = (sw) => sw.requests.filter((r) => r.url === '/api/peers/context').map((r) => r.body);
    assert.ok((await emit(crewB, 'message', { type: 'action', text: 'Approve the Client X acquisition price?', options: ['Yes', 'No'] })).ok);
    assert.ok((await emit(crewB, 'message', { type: 'help', category: 'Sound', text: 'mic 3 down' })).ok);
    await until(() => bodies(swB).some((b) => b.includes('Client X acquisition')), 8000, 'hall B\'s own Stagewatch gets its prompt');
    await wait(1300);   // one more push round for every link
    assert.ok(!bodies(swA).some((b) => b.includes('Client X acquisition')), 'hall B\'s prompt is never posted to hall A\'s Stagewatch');
    const lastA = JSON.parse(bodies(swA).at(-1));
    assert.ok(!lastA.items.some((i) => i.id === 'help'), 'no help count from another hall');
    assert.ok(!lastA.items.some((i) => /Hall B timer/.test(i.label)), 'no other hall\'s Stagewatch');
    assert.doesNotMatch(lastA.headline, /Stagewatch not linked/, 'its own link is the one it reads about');
    assert.equal(lastA.items.find((i) => i.id === 'link:stagewatch').light, 'green');
    const lastB = JSON.parse(bodies(swB).at(-1));
    assert.equal(lastB.items.find((i) => i.id === 'help').state, '1 help request open');
    const whole = await api(base, 'GET', '/api/context', undefined, { cookie: admin });
    assert.ok(JSON.stringify(whole.body).includes('Client X acquisition') && whole.body.items.some((i) => i.id === 'help'), 'the node-wide context still has every hall');
  });

  await t.test('a hall back on the default: its own link stops and its key is forgotten', async () => {
    assert.ok((await emit(ctl, 'hall:configure', { code: hallB, stagewatchUrl: '' })).ok);
    await until(() => !swB.connected, 6000, 'hall B\'s link closed');
    await wait(300);
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8').includes(hallB), 'no settings left for hall B');
    const s = await emit(ctl, 'hall:settings', { code: hallB });
    assert.equal(s.stagewatch.url, '');
    assert.equal(s.stagewatch.keySet, false);
  });
});

test('a hall\'s Set up: its screens follow a removed Stagewatch at once; an unchanged save changes and records nothing', async (t) => {
  const hallSw = await fakeStagewatch({ name: 'Lectern timer' });
  const defSw = await fakeStagewatch({ name: 'Default timer' });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await hallSw.close(); await defSw.close(); });
  const admin = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const hallUpdates = async (code) => (await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'hall.update' && e.target === code).length;
  // What halls.js sends on Save: the dialog's fields as hall:settings filled them, with the person's edits.
  const save = async (code, edits = {}) => {
    const s = await emit(ctl, 'hall:settings', { code });
    return emit(ctl, 'hall:configure', { code, name: s.name, stagewatchUrl: s.stagewatch.url, stagewatchFingerprint: s.stagewatch.fp, ...edits });
  };
  const screenOf = async (code) => {
    const made = await emit(ctl, 'display:create', { code, name: 'Lectern monitor' });
    const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
    sockets.push(s);
    const seen = [];
    s.on('display:state', (x) => seen.push(x.stage));
    s.on('display:stage', (x) => seen.push(x));
    await new Promise((resolve) => { s.once('connect', resolve); });
    return seen;
  };
  const live = (st) => !!(st && st.status === 'connected' && !st.stale);

  await t.test('C27: removing a hall\'s own Stagewatch reaches its countdown screens (no default, then an idle default)', async () => {
    const code = (await api(base, 'POST', '/api/rooms', { name: 'Hall S' }, { cookie: admin })).body.code;
    const seen = await screenOf(code);
    assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: hallSw.url, stagewatchKey: KEY_A })).ok);
    await until(() => hallSw.connected, 6000, 'the hall\'s Stagewatch linked');
    hallSw.frame({ text: '07:42' });
    await until(() => live(seen.at(-1)) && seen.at(-1).text === '07:42', 6000, '07:42 on the screen');
    const n = seen.length;
    assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: '' })).ok);
    await until(() => seen.length > n, 2500, 'the screen told');
    assert.ok(!live(seen.at(-1)), 'no confident time from a Stagewatch the hall no longer follows: ' + JSON.stringify(seen.at(-1)));
    // An idle default (paused, beats only): the screen shows the default's frame, not the old hall's.
    await emit(ctl, 'admin:settings', { stagewatchUrl: defSw.url, stagewatchKey: KEY_B });
    await until(() => defSw.connected, 6000, 'the default linked');
    defSw.frame({ text: '15:00', state: 'paused' });
    assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: hallSw.url, stagewatchKey: KEY_A })).ok);
    hallSw.frame({ text: '07:42' });
    await until(() => live(seen.at(-1)) && seen.at(-1).text === '07:42' && seen.at(-1).title === 'Lectern timer', 6000, 'the hall\'s own again');
    const m = seen.length;
    assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: '' })).ok);
    await until(() => seen.length > m, 2500, 'the screen told');
    assert.equal(seen.at(-1).text, '15:00', 'the default\'s frame, not the removed one\'s');
    await emit(ctl, 'admin:settings', { stagewatchUrl: '' });
  });

  await t.test('C51: saving Set up unchanged records nothing; a rename records the name alone', async () => {
    const code = (await api(base, 'POST', '/api/rooms', { name: 'Hall X' }, { cookie: admin })).body.code;
    const none = await save(code);
    assert.deepEqual(none.changed, [], 'a hall with no Stagewatch of its own, saved as it is');
    assert.equal(await hallUpdates(code), 0);
    const linked = await save(code, { stagewatchUrl: hallSw.url, stagewatchKey: KEY_A });
    assert.deepEqual(linked.changed, ['Stagewatch → http://' + hallSw.url + ' (new key, sealed)']);
    assert.equal(await hallUpdates(code), 1);
    assert.deepEqual((await save(code)).changed, [], 'linked, saved as it is');
    assert.equal(await hallUpdates(code), 1, 'no audit line for a change that did not happen');
    assert.deepEqual((await save(code, { name: 'Hall X (Main)' })).changed, ['name → Hall X (Main)']);
    assert.equal((await emit(ctl, 'hall:settings', { code })).stagewatch.keySet, true, 'the key is kept');
    assert.deepEqual((await save(code, { stagewatchUrl: '' })).changed, ['Stagewatch → the default'], 'unlinking is a change');
  });

  await t.test('a save refused for its Stagewatch address changes nothing: no page or screen is renamed; the corrected save records the rename', async () => {
    const code = (await api(base, 'POST', '/api/rooms', { name: 'Hall One' }, { cookie: admin })).body.code;
    const g = await connect(base); sockets.push(g);
    const metas = [];
    g.on('roomMeta', (m) => metas.push(m));
    assert.ok((await emit(g, 'join', { roomCode: code, name: 'Gil', role: 'board' })).ok);
    const seen = await screenOf(code);
    await until(() => seen.length > 0, 3000, 'the screen\'s first state');
    const n = seen.length;
    // What halls.js sends on Save: the new name and a port with one digit too many.
    const refused = await save(code, { name: 'Ballroom', stagewatchUrl: '127.0.0.1:99240' });
    assert.deepEqual([refused.ok, /not a Stagewatch address/.test(refused.error)], [false, true], JSON.stringify(refused));
    await wait(300);
    assert.deepEqual({ name: (await emit(ctl, 'hall:settings', { code })).name, metas: metas.length, screen: seen.length - n, rows: await hallUpdates(code) },
      { name: 'Hall One', metas: 0, screen: 0, rows: 0 }, 'a refused save renames nothing anywhere');
    // The person fixes the address and saves again: the rename is applied and recorded with it.
    const fixed = await save(code, { name: 'Ballroom', stagewatchUrl: hallSw.url });
    assert.deepEqual(fixed.changed, ['name → Ballroom', 'Stagewatch → http://' + hallSw.url]);
    const rows = (await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'hall.update' && e.target === code);
    assert.deepEqual(rows.map((e) => e.words), ['name → Ballroom; Stagewatch → http://' + hallSw.url]);
    await until(() => metas.length === 1, 3000, 'the rename on the joined page');
    assert.deepEqual((await save(code, { stagewatchUrl: '' })).changed, ['Stagewatch → the default']);
  });
});

test('C53: a restart keeps following a stage send the speaker has not acknowledged yet', async (t) => {
  const sw = await fakeStagewatch({ name: 'Lectern timer', messageId: 77 });
  let srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const setup = await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  const code = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall R' }, { cookie: setup.cookie })).body.code;
  const ctl = await connect(srv.base, setup.cookie); sockets.push(ctl);
  assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: sw.url, stagewatchKey: KEY_A })).ok);
  await until(() => sw.connected, 6000, 'linked');
  // A socket open is not a link: AGMessage sends only once Stagewatch has accepted its key, which its own status says.
  await until(async () => (await emit(ctl, 'hall:settings', { code })).stagewatch.status === 'connected', 6000, 'the key accepted');
  const crew = await connect(srv.base); sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: code, name: 'Alex', role: 'research' })).ok);
  const sent = await emit(crew, 'stage:send', { text: 'Wrap up please' });
  assert.deepEqual([sent.ok, sent.messageId], [true, 77]);

  // The watchdog restarts AGMessage on the same data folder before the speaker answers.
  await stopServer(srv.child);
  await until(() => !sw.connected, 6000, 'the old link gone');
  srv = await startServer({ AGM_DATA_DIR: srv.dataDir });
  await until(() => sw.connected, 8000, 'linked again after the restart');
  const admin = (await api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: 'the green room kettle' })).cookie;
  const ctl2 = await connect(srv.base, admin); sockets.push(ctl2);
  const before = (await emit(ctl2, 'admin:watchRoom', { roomCode: code })).messages.find((m) => m.stage && m.stage.ref === 77);
  assert.equal(before.stage.ack, 'sent');
  const crew2 = await connect(srv.base); sockets.push(crew2);
  assert.ok((await emit(crew2, 'join', { roomCode: code, name: 'Alex', role: 'research' })).ok);
  const acked = new Promise((resolve) => crew2.on('stageAck', (a) => { if (a.stage.ack === 'done') resolve(a.stage); }));
  sw.frame({ messageId: 77, messageAck: 'done', messageAckBy: 'Speaker A' });
  const st = await Promise.race([acked, new Promise((resolve) => { setTimeout(() => resolve(null), 4000); })]);
  assert.ok(st, 'the acknowledgement reaches the hall');
  assert.equal(st.by, 'Speaker A');
  const after = (await emit(ctl2, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.stage && m.stage.ref === 77);
  assert.ok(after.length >= 1 && after.every((m) => m.stage.ack === 'done'), 'on the record of the send');
  assert.equal(after[0].stage.link, 'hall:' + code, 'the send keeps the link it went to');
});

test('a restart follows a stage send only while its Stagewatch is the one it went to; one that restarted since ends it as lost', async (t) => {
  // Three halls, each on its own Stagewatch, each sending "Two minutes" that becomes that Stagewatch's message 4:
  // P's Stagewatch restarts while AGMessage runs; Q's restarts while AGMessage is down (overnight); R's carries on.
  const [swP, swQ, swR] = [await fakeStagewatch({ name: 'P timer', messageId: 4 }), await fakeStagewatch({ name: 'Q timer', messageId: 4 }), await fakeStagewatch({ name: 'R timer', messageId: 4 })];
  let srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await swP.close(); await swQ.close(); await swR.close(); });
  const setup = await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  let ctl = await connect(srv.base, setup.cookie); sockets.push(ctl);
  const halls = {};
  for (const [k, sw, seq] of [['P', swP, 10], ['Q', swQ, 50], ['R', swR, 20]]) {
    const code = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall ' + k }, { cookie: setup.cookie })).body.code;
    assert.ok((await emit(ctl, 'hall:configure', { code, stagewatchUrl: sw.url, stagewatchKey: KEY_A })).ok);
    await until(() => sw.connected, 6000, k + ' linked');
    sw.frame({ seq, messageId: 0 });
    const crew = await connect(srv.base); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: code, name: 'Alex', role: 'research' })).ok);
    await until(async () => (await emit(ctl, 'hall:settings', { code })).stagewatch.status === 'connected', 3000, k + ' connected');
    await wait(150);   // the frame of that seq is in before the send
    const sent = await emit(crew, 'stage:send', { text: 'Two minutes' });
    assert.deepEqual([sent.ok, sent.messageId], [true, 4], k);
    halls[k] = { code, crew };
  }
  const records = async (c, k) => (await emit(c, 'admin:watchRoom', { roomCode: halls[k].code })).messages.filter((m) => m.stage && m.stage.ref === 4).map((m) => m.stage.ack);

  // P's Stagewatch restarts (its seq goes back): the send can no longer be followed, and its record says so at once.
  const lost = new Promise((resolve) => { halls.P.crew.on('stageAck', (a) => { if (a.stage.ack === 'lost') resolve(a.stage); }); });
  swP.frame({ seq: 1, messageId: 0, messageAck: '', messageAckBy: '' });
  assert.ok(await Promise.race([lost, wait(3000)]), 'the hall told the send is lost');
  swP.frame({ seq: 2, messageId: 4, messageAck: 'done', messageAckBy: 'Someone else' });
  await wait(400);
  assert.deepEqual(await records(ctl, 'P'), ['lost'], 'the restarted Stagewatch\'s message 4 is not ours');

  // AGMessage stops; Q's Stagewatch restarts while it is down; P's and R's carry on. AGMessage starts on the same folder.
  for (const s of sockets) s.close();
  await stopServer(srv.child);
  swQ.frame({ seq: 1, messageId: 0, messageAck: '', messageAckBy: '' });
  swP.frame({ seq: 3 });
  swR.frame({ seq: 21 });
  srv = await startServer({ AGM_DATA_DIR: srv.dataDir });
  await until(() => swP.connected && swQ.connected && swR.connected, 8000, 'linked again after the restart');
  await wait(400);
  const admin = (await api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: 'the green room kettle' })).cookie;
  ctl = await connect(srv.base, admin); sockets.push(ctl);
  swP.frame({ seq: 4, messageId: 4, messageAck: 'done', messageAckBy: 'Someone else again' });
  swQ.frame({ seq: 2, messageId: 4, messageAck: 'done', messageAckBy: 'Today\'s speaker' });
  swR.frame({ seq: 22, messageId: 4, messageAck: 'done', messageAckBy: 'Speaker R' });
  await until(async () => (await records(ctl, 'R')).every((a) => a === 'done'), 4000, 'R\'s speaker acknowledged the send');
  await wait(300);
  assert.deepEqual({ P: await records(ctl, 'P'), Q: await records(ctl, 'Q'), R: await records(ctl, 'R') }, { P: ['lost'], Q: ['lost'], R: ['done'] },
    'only the Stagewatch the send went to, as it was then, acknowledges it');
  // What the speaker did is a fact: R's Stagewatch restarting afterwards leaves the acknowledgement as it was.
  swR.frame({ seq: 1, messageId: 0, messageAck: '', messageAckBy: '' });
  await wait(500);
  assert.deepEqual(await records(ctl, 'R'), ['done'], 'acknowledged stays acknowledged');
});

test('closing a hall forgets its own Stagewatch\'s certificate pins, unless another hall still follows that address', async (t) => {
  // A Stagewatch on one fixed address: first over TLS (pinned on first use), then the same address serving plain HTTP.
  const stagewatchAt = async (port, cert) => {
    const app = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, node: { t: 'main', id: 'swx', name: 'Hall Stagewatch' }, light: 'green', headline: 'Keynote', items: [], peers: [] })); });
    const wss = new WebSocketServer({ server: app, path: '/ws' });
    wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })));
    const front = cert ? tlsmod.dualPortServer(app, { certPem: tlsmod.toPem(cert.certDer), keyPem: cert.keyPem }) : app;
    await new Promise((resolve) => { front.listen(port, '127.0.0.1', resolve); });
    return { close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(); front.close(() => resolve()); }) };
  };
  const port = await freePort();
  let sw = await stagewatchAt(port, tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] }));
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const pins = () => Object.keys(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8')).tlsPins || {});
  const status = async (code) => (await emit(ctl, 'hall:settings', { code })).stagewatch;

  const [dayOne, alsoThere] = [await hall('Day one'), await hall('Day one, overflow')];
  assert.ok((await emit(ctl, 'hall:configure', { code: dayOne, stagewatchUrl: 'https://127.0.0.1:' + port, stagewatchKey: 'swk_day_one_node_key_01' /* secret-scan: fixture */ })).ok);
  await until(() => pins().includes('url:127.0.0.1:' + port), 8000, 'the hall\'s Stagewatch pinned on disk');
  assert.ok((await emit(ctl, 'hall:configure', { code: alsoThere, stagewatchUrl: 'https://127.0.0.1:' + port, stagewatchKey: 'swk_day_one_node_key_01' /* secret-scan: fixture */ })).ok);
  await until(async () => (await status(alsoThere)).status === 'connected', 6000, 'the second hall on the same Stagewatch');

  assert.ok((await emit(ctl, 'admin:deleteRoom', { roomCode: dayOne })).ok);
  await wait(300);
  assert.ok(pins().includes('url:127.0.0.1:' + port), 'kept: another hall still follows that address');
  assert.ok((await emit(ctl, 'admin:deleteRoom', { roomCode: alsoThere })).ok);
  await until(() => pins().length === 0, 3000, 'the pins gone with the last hall on that address: ' + JSON.stringify(pins()));

  // Next day the address holds a Stagewatch with TLS off, and a new hall is set to it: it links.
  await sw.close();
  sw = await stagewatchAt(port, null);
  const dayTwo = await hall('Day two');
  assert.ok((await emit(ctl, 'hall:configure', { code: dayTwo, stagewatchUrl: '127.0.0.1:' + port, stagewatchKey: 'swk_day_two_node_key_02' /* secret-scan: fixture */ })).ok);
  await until(async () => (await status(dayTwo)).status === 'connected', 6000, 'the new hall linked in plain HTTP');
});

test('a forward an earlier build stored with its hall\'s code is told without it, and saved without it', async (t) => {
  // Two halls on disk as an earlier build left them: hall D holds a message forwarded from hall A that names A's code.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  fs.mkdirSync(path.join(dataDir, 'rooms'));
  const at = Date.now() - 60_000;
  const snapshot = (name, messages) => JSON.stringify({ name, createdAt: at, seq: messages.length, settings: {}, messages });
  const legacy = { id: 'm-legacy', type: 'text', text: 'Doors at seven', at, seq: 1, pinned: false, priority: false, from: { uid: 'u-gus', name: 'Gus', role: 'research' }, forwardedFrom: { roomCode: 'HALLA1', roomName: 'Hall A', originalAuthor: 'Gus', originalAt: at - 1000 } };
  fs.writeFileSync(path.join(dataDir, 'rooms', 'HALLA1.json'), snapshot('Hall A', []));
  fs.writeFileSync(path.join(dataDir, 'rooms', 'HALLD1.json'), snapshot('Hall D', [legacy]));
  const srv = await startServer({ AGM_DATA_DIR: dataDir });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const dot = await connect(srv.base); sockets.push(dot);
  const j = await emit(dot, 'join', { roomCode: 'HALLD1', name: 'Dot', role: 'observer' });
  assert.ok(j.ok, JSON.stringify(j));
  assert.deepEqual(j.history.find((m) => m.id === 'm-legacy').forwardedFrom, { roomName: 'Hall A', originalAuthor: 'Gus', originalAt: at - 1000 });
  assert.ok(!JSON.stringify(j).includes('HALLA1'), 'an observer of hall D is not told hall A\'s code');
  await stopServer(srv.child);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'rooms', 'HALLD1.json'), 'utf8').includes('HALLA1'), 'nor is it kept on disk');
});

test('rights inside a hall: forwards, read-only members, the room list\'s role select, renames and locks, two devices, who is told a hall\'s code', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  // Every socket here comes from 127.0.0.1 and so draws on one connection bucket on the server (3 a second, bursts of
  // 30). open() keeps a copy of it and waits for a token with one to spare, so no subtest leans on another's wait. The
  // copy is never more generous than the server's: each connect is awaited before the next takes its token.
  const bucket = { tokens: 30, at: Date.now() };
  const level = () => Math.min(30, bucket.tokens + ((Date.now() - bucket.at) / 1000) * 3);
  const open = async (cookie) => {
    while (level() < 2) await wait(Math.ceil(((2 - level()) / 3) * 1000));
    bucket.tokens = level() - 1;
    bucket.at = Date.now();
    const s = await connect(base, cookie); sockets.push(s); return s;
  };
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });

  const admin = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB, hallC, hallD, hallE, hallF, hallG] = [await hall('Hall A'), await hall('Hall B'), await hall('Hall C'), await hall('Hall D'), await hall('Hall E'), await hall('Hall F'), await hall('Hall G')];
  const account = async (body) => {
    const made = await api(base, 'POST', '/api/users', body, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(base, 'POST', '/api/auth/login', { username: body.username, password: body.password })).cookie;
  };
  const vic = await account({ username: 'vic', name: 'Vic Viewer', role: 'viewer', halls: [hallA, hallB, hallD], password: 'only looking at screens' });
  const stu = await account({ username: 'stu', name: 'Stu Staff', role: 'staff', halls: [hallA, hallB], password: 'coffee urn in the foyer' });
  const sue = await account({ username: 'sue', name: 'Sue Staff', role: 'staff', halls: [hallA, hallB], revoke: ['hall.files'], password: 'the loading dock door' });
  const ted = await account({ username: 'ted', name: 'Ted Tech', role: 'tech', halls: [hallB, hallE, hallG], password: 'mixing desk on stage left' });
  const pat = await account({ username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' });
  const ctl = await open(admin);

  const asAccount = async (cookie, code) => { const s = await open(cookie); const j = await emit(s, 'join', { roomCode: code, as: 'account' }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const guest = async (code, name, role, extra = {}) => { const s = await open(); const j = await emit(s, 'join', { roomCode: code, name, role, ...extra }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const heard = (s, ...events) => { const got = []; for (const ev of events) s.on(ev, (v) => got.push([ev, v])); return got; };
  const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });   // events whose ack is their only argument
  const myRooms = (s) => ask(s, 'myRooms');
  const png = async (uploadToken) => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' }), 'plot.png');
    return (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': uploadToken }, body: f })).json();
  };

  await t.test('forwarding is posting: the rights in the hall it lands in decide, and the post carries them', async () => {
    const stuA = await asAccount(stu, hallA);
    await asAccount(stu, hallB);
    const vicA = await asAccount(vic, hallA);
    const vicB = await asAccount(vic, hallB);
    assert.deepEqual([vicA.j.role, vicB.j.role], ['observer', 'observer']);
    const inB = heard(vicB.s, 'message');
    const sent = await emit(stuA.s, 'message', { type: 'text', text: 'Revenue was 12m' });
    assert.ok(sent.ok);
    assert.deepEqual((await myRooms(vicA.s)).rooms, [], 'a read-only account is offered no hall to forward into');
    assert.equal((await emit(vicA.s, 'forward', { messageId: sent.id, targetRoom: hallB })).ok, false, 'a viewer may not post in B by forwarding');

    // A code guest backstage in A who only observes in B (the same signed identity in two tabs).
    const gusA = await guest(hallA, 'Gus Guest', 'research');
    const gusB = await guest(hallB, 'Gus Guest', 'observer', { uid: gusA.j.identity });
    assert.equal(gusB.j.uid, gusA.j.uid);
    const own = await emit(gusA.s, 'message', { type: 'text', text: 'Backstage only: the CEO is late' });
    assert.equal((await emit(gusA.s, 'forward', { messageId: own.id, targetRoom: hallB })).ok, false, 'an observer seat in B decides');

    // A locked hall seats the same guest as an observer: forwarding is no way round the lock, nor is an admin's link.
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallC, on: true })).ok);
    const gusC = await guest(hallC, 'Gus Guest', 'research', { uid: gusA.j.identity });
    assert.equal(gusC.j.role, 'observer');
    const inC = heard(gusC.s, 'message');
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: gusA.s.id, targetRoom: hallC })).ok);
    const loud = await emit(gusA.s, 'message', { type: 'text', text: 'Presenter: wrap up now', priority: true });
    assert.equal((await emit(gusA.s, 'forward', { messageId: loud.id, targetRoom: hallC })).ok, false, 'the observer seat in C decides, not the link');
    assert.deepEqual((await myRooms(gusA.s)).rooms, [], 'neither B nor C is offered');

    // The admin's link is a grant where the guest has no seat of their own.
    const dot = await guest(hallD, 'Dot', 'observer');
    const inD = heard(dot.s, 'message');
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: gusA.s.id, targetRoom: hallD })).ok);
    assert.deepEqual((await myRooms(gusA.s)).rooms.map((r) => r.code), [hallD]);
    assert.ok((await emit(gusA.s, 'forward', { messageId: own.id, targetRoom: hallD })).ok, 'a linked hall takes the forward');

    // Staff may post in both halls: the forward lands, as a post of their own in B, marked as an account's.
    assert.deepEqual((await myRooms(stuA.s)).rooms.map((r) => r.code), [hallB]);
    const fwd = await emit(stuA.s, 'forward', { messageId: sent.id, targetRoom: hallB });
    assert.ok(fwd.ok, JSON.stringify(fwd));
    await until(() => inB.length === 1, 3000, 'the forward in B');
    const landed = inB[0][1];
    assert.deepEqual([landed.text, landed.from.name, landed.from.role, landed.from.acct, landed.forwardedFrom.roomName], ['Revenue was 12m', 'Stu Staff', 'research', true, 'Hall A']);

    // A file needs hall.files in the hall it lands in.
    const up = await png(stuA.j.uploadToken);
    const file = await emit(stuA.s, 'message', { type: 'file', url: up.url, filename: 'plot.png' });
    assert.ok(file.ok, JSON.stringify(file));
    const sueA = await asAccount(sue, hallA);
    await asAccount(sue, hallB);
    assert.equal((await emit(sueA.s, 'forward', { messageId: file.id, targetRoom: hallB })).ok, false, 'no files right in B: no file forwarded into it');
    // The picker is asked for the message it is for, and lists only the halls that would take that forward.
    const picker = async (s, messageId) => (await answer(s, 'myRooms', { messageId })).rooms.map((r) => r.code);
    assert.deepEqual(await picker(sueA.s, file.id), [], 'the picker offers no hall that would refuse her file');
    assert.deepEqual(await picker(sueA.s, sent.id), [hallB], 'and still offers B for her text');
    assert.deepEqual(await picker(stuA.s, file.id), [hallB], 'and B for his file');
    assert.ok((await emit(sueA.s, 'forward', { messageId: sent.id, targetRoom: hallB })).ok, 'her text still forwards');
    assert.ok((await emit(stuA.s, 'forward', { messageId: file.id, targetRoom: hallB })).ok, 'his file does');
    await wait(300);
    assert.deepEqual(inB.map(([, m]) => [m.type, m.from.name]), [['text', 'Stu Staff'], ['text', 'Sue Staff'], ['file', 'Stu Staff']], 'nothing refused reached B');
    assert.deepEqual(inC, [], 'nothing reached the locked hall');
    assert.deepEqual(inD.map(([, m]) => [m.text, m.from.name, m.from.role]), [['Backstage only: the CEO is late', 'Gus Guest', 'research']]);
    // A forward names the hall it came from, never its code (a guest's way in): Dot, an observer guest of D, may not open A.
    assert.deepEqual(inD.map(([, m]) => m.forwardedFrom.roomName), ['Hall A']);
    assert.ok(![inB, inD].some((got) => JSON.stringify(got).includes(hallA)), 'no forward tells the hall it lands in the code of the hall it came from');
    const late = await guest(hallD, 'Lou', 'observer');
    assert.ok(!JSON.stringify(late.j).includes(hallA), 'nor does the history a newcomer is sent');
  });

  await t.test('a help request is not forwarded: it belongs to its hall, tracked and answered there', async () => {
    const alexA = await guest(hallA, 'Alex', 'research');
    const alexB = await guest(hallB, 'Alex', 'research', { uid: alexA.j.identity });
    const inB = heard(alexB.s, 'message');
    const help = await emit(alexA.s, 'message', { type: 'help', category: 'Sound', text: 'radio mic 3 dead' });
    assert.ok(help.ok);
    assert.deepEqual((await myRooms(alexA.s)).rooms.map((r) => r.code), [hallB], 'the path is open: Alex may post in B');
    const fwd = await emit(alexA.s, 'forward', { messageId: help.id, targetRoom: hallB });
    assert.equal(fwd.ok, false);
    assert.match(fwd.error, /belongs to its hall/);
    await wait(300);
    assert.deepEqual(inB, []);
    const b = (await emit(ctl, 'board:watch', {})).board;
    assert.deepEqual(b.help.map((h) => [h.code, h.category, h.text]), [[hallA, 'Sound', 'radio mic 3 dead']], 'one request, in its own hall');
    const last = b.halls.find((h) => h.code === hallB).last;
    assert.deepEqual([last.name, last.text], ['Stu Staff', '📄 plot.png'], 'hall B\'s last line is not a hollow help request');
  });

  await t.test('a Viewer follows a help request from the board into a hall it may only read', async () => {
    const page = await open(vic);
    const b = (await emit(page, 'board:watch', {})).board;
    assert.deepEqual(b.help.map((h) => [h.code, h.canRespond]), [[hallA, false]], 'the Viewer sees the request but may not answer it');
    const halls = (await api(base, 'GET', '/api/halls', undefined, { cookie: vic })).body.halls;
    assert.equal(halls.find((h) => h.code === hallA).can.post, false, 'the board builds the hall\'s link from this');
    const j = await emit(page, 'join', { roomCode: hallA, as: 'account', role: 'research' });
    assert.equal(j.role, 'observer', 'the URL\'s role is never the account\'s');
    assert.equal((await emit(page, 'message', { type: 'text', text: 'hello' })).ok, false);
    assert.equal((await emit(page, 'ai:draft', { question: 'What was capex?' })).ok, false);
  });

  await t.test('read-only people (an observer guest, a Viewer account) cannot pin, react or answer a prompt', async () => {
    const crew = await guest(hallD, 'Rae Research', 'research');
    const prompt = await emit(crew.s, 'message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] });
    const note = await emit(crew.s, 'message', { type: 'text', text: 'Agenda item 4' });
    assert.ok(prompt.ok && note.ok);
    assert.ok((await emit(crew.s, 'pin', { messageId: note.id, pinned: true })).ok, 'crew may pin');
    const seen = heard(crew.s, 'pinUpdate', 'messageReact', 'actionUpdate');
    const gallery = await guest(hallD, 'Gallery guest', 'observer');
    const viewer = await asAccount(vic, hallD);
    assert.deepEqual([gallery.j.role, viewer.j.role], ['observer', 'observer']);
    const results = {};
    for (const [who, s] of [['guest', gallery.s], ['viewer', viewer.s]]) {
      results[who + ' unpin'] = (await emit(s, 'pin', { messageId: note.id, pinned: false })).ok;
      results[who + ' react'] = (await emit(s, 'react', { messageId: note.id, emoji: '👍' })).ok;
      results[who + ' answer'] = (await emit(s, 'actionResponse', { messageId: prompt.id, optionIndex: 1 })).ok;
      results[who + ' reply with text'] = (await emit(s, 'actionResponse', { messageId: prompt.id, optionIndex: -1, note: 'from the gallery' })).ok;
    }
    await wait(300);
    assert.deepEqual(Object.values(results), Array(8).fill(false), JSON.stringify(results));
    assert.deepEqual(seen, [], 'nothing a read-only person did reached the hall');
    const fresh = await guest(hallD, 'Fresh Eyes', 'observer');
    const byId = Object.fromEntries(fresh.j.history.map((m) => [m.id, m]));
    assert.deepEqual([byId[note.id].pinned, byId[note.id].reactions, byId[prompt.id].responses], [true, undefined, []]);
    assert.ok((await emit(crew.s, 'react', { messageId: note.id, emoji: '👍' })).ok, 'crew still react');
    assert.ok((await emit(crew.s, 'actionResponse', { messageId: prompt.id, optionIndex: 0 })).ok, 'crew still answer');
  });

  await t.test('the room list\'s role select changes a code guest\'s role, and refuses an account\'s (their rights live on the Accounts page)', async () => {
    const tedE = await asAccount(ted, hallE);
    assert.equal(tedE.j.role, 'research');
    const kim = await guest(hallE, 'Kim', 'research');
    const lines = heard(kim.s, 'system');
    const rows = (await ask(ctl, 'admin:listRooms')).rooms.find((r) => r.code === hallE).users;
    const tedRow = rows.find((u) => u.name === 'Ted Tech');
    const kimRow = rows.find((u) => u.name === 'Kim');
    assert.deepEqual([tedRow.account, kimRow.account], [true, false], 'the list says who signs in with an account');
    assert.ok(!('acct' in tedRow) && !JSON.stringify(rows).includes('"ted"'), 'never the username');
    const refused = await emit(ctl, 'admin:setRole', { roomCode: hallE, socketId: tedRow.socketId, role: 'observer' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Accounts page/);
    assert.ok((await emit(tedE.s, 'message', { type: 'text', text: 'Still on comms' })).ok, 'nothing changed for the account');
    const after = (await ask(ctl, 'admin:listRooms')).rooms.find((r) => r.code === hallE).users;
    assert.equal(after.find((u) => u.name === 'Ted Tech').role, 'research');
    const told = new Promise((resolve) => kim.s.once('roleChanged', resolve));
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallE, socketId: kimRow.socketId, role: 'observer' })).ok);
    assert.equal((await told).role, 'observer');
    assert.equal((await emit(kim.s, 'message', { type: 'text', text: 'hi' })).ok, false, 'the guest\'s change took effect');
    await until(() => lines.some(([, m]) => m.text === 'The admin moved Kim from Backstage to Observer.'), 3000, 'the guest\'s change recorded, in the seats\' words');
    assert.ok(!lines.some(([, m]) => /moved Ted Tech/.test(m.text)), 'the refused one is not');
  });

  await t.test('the room list shows a person once, and what the admin does to that row reaches every page they have open there', async () => {
    const hallH = await hall('Hall H');
    const hallI = await hall('Hall I');
    const tab1 = await guest(hallH, 'Max', 'research');
    const tab2 = await guest(hallH, 'Max', 'research', { uid: tab1.j.identity });   // the same browser, a second tab
    const rows = async () => (await ask(ctl, 'admin:listRooms')).rooms.find((r) => r.code === hallH).users;
    const max = (await rows()).filter((u) => u.name === 'Max');
    assert.equal(max.length, 1, 'one row for the person');
    const sid = max[0].socketId;
    const offered = async () => Promise.all([tab1, tab2].map(async (tab) => (await myRooms(tab.s)).rooms.map((r) => r.code)));

    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: sid, targetRoom: hallI })).ok);
    assert.deepEqual(await offered(), [[hallI], [hallI]], 'linked on both pages');
    assert.equal((await rows()).find((u) => u.name === 'Max').linkedRooms[0], hallI);
    assert.ok((await emit(ctl, 'admin:unlinkRoom', { socketId: sid, targetRoom: hallI })).ok);
    assert.deepEqual(await offered(), [[], []], 'unlinked on both pages');

    const told = [tab1, tab2].map((tab) => new Promise((resolve) => { tab.s.once('roleChanged', resolve); }));
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallH, socketId: sid, role: 'observer' })).ok);
    assert.deepEqual(await Promise.all(told), [{ role: 'observer' }, { role: 'observer' }]);
    const posts = await Promise.all([tab1, tab2].map(async (tab) => (await emit(tab.s, 'message', { type: 'text', text: 'still backstage?' })).ok));
    assert.deepEqual(posts, [false, false], 'the demotion holds on every page, not only the one listed');

    const gone = [tab1, tab2].map((tab) => new Promise((resolve) => { tab.s.once('disconnect', resolve); }));
    assert.ok((await emit(ctl, 'admin:kick', { socketId: sid })).ok);
    assert.deepEqual(await Promise.all(gone), ['io server disconnect', 'io server disconnect'], 'logged out of every page');
    assert.ok(!(await rows()).some((u) => u.name === 'Max'));

    // An account forwards by its own rights in a hall, so the admin's link cannot give it one it does not hold.
    const vicA = await asAccount(vic, hallA);
    const refused = await emit(ctl, 'admin:linkRoom', { socketId: vicA.s.id, targetRoom: hallB });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Accounts page/);
    assert.deepEqual((await myRooms(vicA.s)).rooms, []);
    const stuA = await asAccount(stu, hallA);
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: stuA.s.id, targetRoom: hallB })).ok, 'one that may post there is linked');
    assert.deepEqual((await myRooms(stuA.s)).rooms.map((r) => r.code), [hallB]);
  });

  // A page as app.js runs it: lastSeq, joined, bump() rejoining on the same socket at a gap in the numbers.
  const page = async (code, name, role, cookie) => {
    const s = await open(cookie);
    const st = { last: -1, joined: false, identity: '', joins: 0, role: null, roomName: '', metas: [] };
    const rejoin = () => new Promise((resolve) => {
      st.joins++;
      const who = cookie ? { as: 'account' } : { name, role, uid: st.identity };
      s.emit('join', { roomCode: code, since: st.joined ? st.last : undefined, ...who }, (r) => {
        assert.ok(r && r.ok, JSON.stringify(r));
        if (r.identity) st.identity = r.identity;
        if (Array.isArray(r.ops)) for (const op of r.ops) { if (op.o === 'meta' && typeof op.name === 'string') st.roomName = op.name; if (op.s > st.last) st.last = op.s; }
        else st.roomName = r.roomName;
        st.last = Math.max(st.last, r.seq || 0);
        st.joined = true; st.role = r.role;
        resolve(r);
      });
    });
    const bump = (seq) => { if (!Number.isInteger(seq)) return true; if (st.last >= 0 && seq > st.last + 1 && st.joined) { rejoin(); return false; } if (seq > st.last) st.last = seq; return true; };
    s.on('message', (m) => bump(m.seq));
    s.on('system', (m) => bump(m.seq));
    s.on('roomMeta', (m) => { st.metas.push(m); if (bump(m.seq)) st.roomName = m.name; });
    await rejoin();
    return { s, st };
  };
  const watcher = async (code) => { const w = await guest(code, 'Wren', 'research'); return { w: w.s, lines: heard(w.s, 'system') }; };

  await t.test('renaming a hall reaches every open page as one numbered change; nobody is announced again', async () => {
    const { w, lines } = await watcher(hallF);
    const pages = [await page(hallF, 'Bo', 'board'), await page(hallF, 'Cy', 'board'), await page(hallF, 'Di', 'research')];
    await wait(200);
    lines.length = 0;
    const before = pages.map((p) => p.st.last);
    const pm = await open(pat);
    assert.ok((await emit(pm, 'hall:configure', { code: hallF, name: 'Hall F (Main)' })).ok);
    await until(() => pages.every((p) => p.st.roomName === 'Hall F (Main)'), 3000, 'the new name on every page');
    assert.deepEqual(pages.map((p) => p.st.metas.map((m) => m.seq)), before.map((s) => [s + 1]), 'the next number, no gap');
    const m = await emit(w, 'message', { type: 'text', text: 'Next item' });
    await until(() => pages.every((p) => p.st.last >= m.seq), 3000, 'every page has the message');
    await wait(300);
    assert.deepEqual({ joined: lines.filter(([, x]) => /joined/.test(x.text)).map(([, x]) => x.text), joins: pages.map((p) => p.st.joins) }, { joined: [], joins: [1, 1, 1] });
    const resumed = await guest(hallF, 'Bo', 'board', { uid: pages[0].st.identity, since: before[0] });
    assert.ok(resumed.j.ops.some((op) => op.o === 'meta' && op.name === 'Hall F (Main)'), 'a page that resumes reads the name from the ops');
  });

  await t.test('ticking lock roles takes no seat from someone already in the hall; a rejoin on the same socket is quiet and keeps the role', async () => {
    const { w, lines } = await watcher(hallE);
    const eve = await page(hallE, 'Eve', 'board');
    const obs = await page(hallE, 'Oz', 'observer');
    await wait(200);
    lines.length = 0;
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallE, on: true })).ok);
    const m = await emit(w, 'message', { type: 'text', text: 'Places please' });
    await until(() => eve.st.last >= m.seq, 3000, 'Eve has the message');
    await wait(300);
    assert.deepEqual({ role: eve.st.role, joins: eve.st.joins, post: (await emit(eve.s, 'message', { type: 'text', text: 'Board here' })).ok }, { role: 'board', joins: 1, post: true });
    const again = await emit(eve.s, 'join', { roomCode: hallE, name: 'Eve', role: 'board', uid: eve.st.identity, since: eve.st.last });
    assert.equal(again.role, 'board', 'seated: the lock is for people who join later');
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallE, on: false })).ok);
    const climb = await emit(obs.s, 'join', { roomCode: hallE, name: 'Oz', role: 'research', uid: obs.st.identity, since: obs.st.last });
    assert.equal(climb.role, 'observer', 'and a seat is not changed by joining again on it');
    assert.equal((await emit(obs.s, 'message', { type: 'text', text: 'promoted?' })).ok, false);
    await wait(300);
    assert.deepEqual(lines.filter(([, x]) => /joined/.test(x.text)), [], 'no presence lines');
  });

  await t.test('an account with the hall open on two devices is one person there, and is not announced as gone when one closes', async () => {
    const phoneCookie = (await api(base, 'POST', '/api/auth/login', { username: 'ted', password: 'mixing desk on stage left' })).cookie;
    const { w, lines } = await watcher(hallG);
    const users = [];
    w.on('users', (u) => users.push(u));
    const tedIn = () => (users[users.length - 1] || []).filter((u) => u.name === 'Ted Tech').length;
    const laptopG = await asAccount(ted, hallG);
    const laptopB = await asAccount(ted, hallB);
    await until(() => tedIn() === 1, 3000, 'Ted in the people list');
    const n = users.length;
    const phone = await asAccount(phoneCookie, hallG);
    await until(() => users.length > n, 3000, 'the people list with the phone');
    assert.equal(tedIn(), 1, 'listed once');
    const people = async () => ({
      api: (await api(base, 'GET', '/api/halls', undefined, { cookie: admin })).body.halls.find((h) => h.code === hallG).people,
      board: (await emit(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hallG).people,
    });
    assert.deepEqual(await people(), { api: 2, board: 2 }, 'Wren and Ted');
    const m = users.length;
    phone.s.close();
    await until(() => users.length > m, 3000, 'the people list after the phone');
    assert.equal(tedIn(), 1, 'still listed: the laptop is there');
    assert.ok((await myRooms(laptopB.s)).rooms.some((r) => r.code === hallG), 'hall G is still one of his');
    const post = await emit(laptopB.s, 'message', { type: 'text', text: 'Spare radio mic in the case' });
    assert.ok((await emit(laptopB.s, 'forward', { messageId: post.id, targetRoom: hallG })).ok, 'a hall he is in takes his forward');
    assert.deepEqual(await people(), { api: 2, board: 2 });
    await wait(8600);   // past the 8 s grace before "left"
    const said = lines.filter(([, x]) => /^Ted Tech /.test(x.text)).map(([, x]) => x.text);
    assert.deepEqual(said, ['Ted Tech joined Backstage'], 'one joined line, no left line');
    // The laptop moves to another hall: now he has gone from this one, said at once.
    assert.ok((await emit(laptopG.s, 'join', { roomCode: hallB, as: 'account' })).ok);
    await until(() => lines.some(([, x]) => x.text === 'Ted Tech left'), 3000, 'Ted Tech left');
    assert.deepEqual(await people(), { api: 1, board: 1 });
  });

  await t.test('in a locked hall a seat outlives its page dropping and coming back (Wi-Fi, the reload after the admin\'s change); a logout does not', async () => {
    const hallJ = await hall('Hall J');
    const { lines } = await watcher(hallJ);
    const rows = async () => (await ask(ctl, 'admin:listRooms')).rooms.find((r) => r.code === hallJ).users;
    const listed = async (name) => (await rows()).some((u) => u.name === name);
    const eve = await guest(hallJ, 'Eve', 'board');
    const oz = await guest(hallJ, 'Oz', 'observer');
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallJ, on: true })).ok);
    await wait(200);
    lines.length = 0;

    // Eve's Wi-Fi drops; her page comes back on a new connection with what its link says: board, no invite.
    eve.s.close();
    await until(async () => !(await listed('Eve')), 3000, 'Eve\'s page gone');
    const back = await guest(hallJ, 'Eve', 'board', { uid: eve.j.identity });
    assert.deepEqual([back.j.role, back.j.note], ['board', ''], 'her seat, not an observer\'s');
    assert.ok((await emit(back.s, 'message', { type: 'text', text: 'Board still here' })).ok);
    const second = await guest(hallJ, 'Eve', 'board', { uid: eve.j.identity });
    assert.equal(second.j.role, 'board', 'a second page of hers, while the first is open');

    // The admin seats Oz backstage; the page reloads with that role in its link, and keeps it.
    const told = new Promise((resolve) => { oz.s.once('roleChanged', resolve); });
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallJ, socketId: oz.s.id, role: 'research' })).ok);
    assert.equal((await told).role, 'research');
    oz.s.close();
    await until(async () => !(await listed('Oz')), 3000, 'Oz\'s old page gone');
    const reloaded = await guest(hallJ, 'Oz', 'research', { uid: oz.j.identity });
    assert.equal(reloaded.j.role, 'research', 'the admin\'s change outlives the reload');
    assert.ok((await emit(reloaded.s, 'message', { type: 'text', text: 'Research on it' })).ok);
    await wait(300);
    assert.deepEqual(lines.filter(([, x]) => /joined|left/.test(x.text)).map(([, x]) => x.text), [], 'quiet: they never left');

    // Not a seat of theirs: another name on the same browser, another role, or after the admin's logout.
    assert.equal((await guest(hallJ, 'Not Eve', 'board', { uid: eve.j.identity })).j.role, 'observer');
    assert.equal((await guest(hallJ, 'Oz', 'board', { uid: oz.j.identity })).j.role, 'observer');
    assert.ok((await emit(ctl, 'admin:kick', { socketId: back.s.id })).ok);
    assert.equal((await guest(hallJ, 'Eve', 'board', { uid: eve.j.identity })).j.role, 'observer', 'logged out is not a drop');
  });

  // A hall's code is a guest's way in (lookups and joins are rate limited and locked out): it is told only to those who
  // may have it.
  await t.test('the admin\'s link for one guest reaches that guest and the admin\'s pages, never the rest of the hall', async () => {
    const [hallK, hallL] = [await hall('Hall K'), await hall('Hall L')];
    const desk = await open(admin);
    const deskLists = [];
    desk.on('users', (u) => deskLists.push(u));
    assert.ok((await emit(desk, 'admin:watchRoom', { roomCode: hallK })).ok);
    const gus = await guest(hallK, 'Gus', 'research');
    const olly = await guest(hallK, 'Olly', 'observer');
    const ollyLists = [];
    olly.s.on('users', (u) => ollyLists.push(u));
    assert.ok((await emit(desk, 'admin:linkRoom', { socketId: gus.s.id, targetRoom: hallL })).ok);
    const late = await guest(hallK, 'Late', 'observer');
    await until(() => ollyLists.some((l) => l.some((u) => u.name === 'Late')) && deskLists.some((l) => l.some((u) => u.name === 'Late')), 3000, 'hall K\'s people list after the newcomer');
    assert.ok(!JSON.stringify(ollyLists).includes(hallL), 'an observer in hall K is not sent hall L\'s code');
    assert.ok(!JSON.stringify(late.j.users).includes(hallL), 'nor is a newcomer in its join answer');
    assert.deepEqual(deskLists.at(-1).find((u) => u.name === 'Gus').linkedRooms, [hallL], 'the admin page keeps the link\'s chip and its Unlink');
    assert.deepEqual((await emit(desk, 'admin:watchRoom', { roomCode: hallK })).users.find((u) => u.name === 'Gus').linkedRooms, [hallL]);
    assert.deepEqual((await ask(desk, 'admin:listRooms')).rooms.find((r) => r.code === hallK).users.find((u) => u.name === 'Gus').linkedRooms, [hallL]);
    assert.deepEqual((await myRooms(gus.s)).rooms.map((r) => r.code), [hallL], 'the guest still learns its own link');
  });

  await t.test('a screen\'s connection is never told its hall\'s code, which would let its browser in as a guest', async () => {
    const unnamed = (await api(base, 'POST', '/api/rooms', {}, { cookie: admin })).body.code;
    const hallM = await hall('Hall M');
    for (const [code, name] of [[unnamed, ''], [hallM, 'Hall M']]) {
      const made = await emit(ctl, 'display:create', { code, name: 'Foyer screen' });
      assert.ok(made.ok, JSON.stringify(made));
      const screen = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.split('/d/')[1] } });
      sockets.push(screen);
      const frames = [];
      screen.onAny((ev, x) => frames.push([ev, x]));
      const states = () => frames.filter(([ev]) => ev === 'display:state').map(([, x]) => x);
      await until(() => states().length === 1, 4000, 'the screen\'s state');
      // Every path that tells a screen something: identify, a rename, a take, the hall's holding image, the hall renamed.
      assert.ok((await emit(ctl, 'display:identify', { id: made.display.id })).ok);
      assert.ok((await emit(ctl, 'display:update', { id: made.display.id, name: 'Foyer left' })).ok);
      assert.ok((await emit(ctl, 'display:take', { id: made.display.id, content: { kind: 'message', text: 'Doors at seven' } })).ok);
      assert.ok((await emit(ctl, 'display:hallHolding', { code, image: '' })).ok);
      if (name) assert.ok((await emit(ctl, 'hall:configure', { code, name: name + ' (Foyer)' })).ok);
      await until(() => states().length === (name ? 5 : 4) && frames.some(([ev]) => ev === 'display:identify'), 4000, 'every frame');
      assert.deepEqual(frames.find(([ev]) => ev === 'display:identify')[1], { name: 'Foyer screen', hall: name, seconds: 6 }, 'identify draws the hall\'s name, or none');
      assert.deepEqual(states().map((s) => s.hallName), name ? [name, name, name, name, name + ' (Foyer)'] : ['', '', '', '']);
      assert.ok(!JSON.stringify(frames).includes(code), 'no frame a screen hears carries its hall\'s code: ' + JSON.stringify(frames.map(([ev]) => ev)));
    }
  });
});

test('a locked hall\'s seats outlive the watchdog\'s restart for the pages back in its first seconds; a logout or a seat not taken up does not', async (t) => {
  // The watchdog restarts a crashed or hung server (SIGKILL) on the same folder and port; every page drops at once and
  // comes back on its own, with what its link says (name, role, identity) and no invite.
  const env = (srv) => ({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port), AGM_BOOT_SEAT_MS: '6000' });
  let srv = await startServer({ AGM_BOOT_SEAT_MS: '6000' });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const code = (await api(srv.base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie: admin })).body.code;
  const join = async (name, role, extra = {}) => { const s = await connect(srv.base); sockets.push(s); const j = await emit(s, 'join', { roomCode: code, name, role, ...extra }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const kill = async () => {
    for (const s of sockets.splice(0)) s.close();
    srv.child.kill('SIGKILL');
    await new Promise((resolve) => { if (srv.child.exitCode !== null || srv.child.signalCode !== null) resolve(); else srv.child.once('exit', resolve); });
    srv = await startServer(env(srv));
  };

  // Seated before the lock: Sam backstage, Lee on stage, Kim backstage. Oz joins after it and the admin seats him on stage.
  const sam = await join('Sam Backstage', 'research');
  const lee = await join('Lee Onstage', 'board');
  const kim = await join('Kim Backstage', 'research');
  assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: code, on: true })).ok);
  const oz = await join('Oz Onstage', 'observer');
  assert.equal(oz.j.role, 'observer');
  assert.ok((await emit(ctl, 'admin:setRole', { roomCode: code, socketId: oz.s.id, role: 'board' })).ok);
  oz.s.close();
  const ozBack = await join('Oz Onstage', 'board', { uid: oz.j.identity });
  assert.equal(ozBack.j.role, 'board', 'the reload after the admin\'s change keeps the seat');
  assert.ok((await emit(ctl, 'admin:kick', { socketId: kim.s.id })).ok);
  await wait(300);

  // The server is killed and started again; Sam's and Oz's pages come back, Lee's does not (yet), Kim's was logged out.
  await kill();
  const sam2 = await join('Sam Backstage', 'research', { uid: sam.j.identity, since: sam.j.seq });
  const oz2 = await join('Oz Onstage', 'board', { uid: oz.j.identity, since: ozBack.j.seq });
  const kim2 = await join('Kim Backstage', 'research', { uid: kim.j.identity });
  const post = await emit(sam2.s, 'message', { type: 'text', text: 'Slide 4 is next' });
  assert.deepEqual({ sam: [sam2.j.role, sam2.j.note], oz: [oz2.j.role, oz2.j.note], post: post.ok, kim: kim2.j.role },
    { sam: ['research', ''], oz: ['board', ''], post: true, kim: 'observer' }, 'after the restart: ' + JSON.stringify(post));

  // Past the boot's first seconds a seat nobody took up is gone, and stays gone through the next restart; the seats
  // taken up hold again.
  await wait(6500);
  await kill();
  const lee2 = await join('Lee Onstage', 'board', { uid: lee.j.identity });
  const sam3 = await join('Sam Backstage', 'research', { uid: sam.j.identity });
  const oz3 = await join('Oz Onstage', 'board', { uid: oz.j.identity });
  assert.deepEqual({ lee: [lee2.j.role, /invite/.test(lee2.j.note)], sam: sam3.j.role, oz: oz3.j.role }, { lee: ['observer', true], sam: 'research', oz: 'board' });
});

test('a side room beside a hall: the admin and the support view reach it by its key, no account it is not given, no guest\'s code and no hall reader does; its people and its hall\'s Stagewatch reach its pages', async (t) => {
  // No act makes a side room yet: the folder is laid out as the store keeps one, a hall and a room beside it.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  fs.mkdirSync(path.join(data, 'rooms'));
  const room = (code, name, messages = []) => JSON.stringify({ code, name, createdAt: 1, seq: messages.length, settings: {}, messages, savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.json'), room('HALLA1', 'Hall A'));
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal', [{ id: 'l1', type: 'text', text: 'the contract', at: 1, seq: 1, from: { uid: 'u1', name: 'Lou', role: 'research' } }]));
  const srv = await startServer({ AGM_DATA_DIR: data });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const signIn = async (username, role, extra) => {
    assert.ok((await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: 'clipboard and coffee', ...extra }, { cookie: admin })).body.ok);
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: 'clipboard and coffee' })).cookie;
  };
  const tom = await signIn('tom', 'tech', { halls: ['HALLA1'] });
  const pat = await signIn('pat', 'manager');
  const SIDE = 'LGQ4MZP8';

  // The hall readers never see it: the lookup a guest's code makes, a guest's join, the halls an account sees.
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + SIDE)).body, { code: SIDE, exists: false, name: '', locked: false });
  assert.deepEqual(await emit(await page(), 'join', { roomCode: SIDE, name: 'Gus', role: 'research' }), { ok: false, error: 'Room not found' }, 'a side room\'s key is no code a guest types');
  assert.deepEqual((await api(srv.base, 'GET', '/api/halls', undefined, { cookie: pat })).body.halls.map((h) => h.code), ['HALLA1']);
  // An account's halls reach the Main room and no side room, every hall's or one's own.
  for (const cookie of [tom, pat]) {
    assert.deepEqual(await emit(await page(cookie), 'join', { roomCode: SIDE, as: 'account' }), { ok: false, error: 'Your account has no access to this room — ask an admin.' });
    assert.ok((await emit(await page(cookie), 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  }
  // The admin reaches it by its key, with its history and its own numbers; the support view too.
  const ana = await page(admin);
  const inSide = await emit(ana, 'join', { roomCode: SIDE, as: 'account' });
  // A folder with no record of how its last copy stopped: every room, this one too, says AGMessage restarted.
  assert.deepEqual([inSide.ok, inSide.roomName, inSide.seq, inSide.history.map((m) => m.text)], [true, 'Legal', 2, ['the contract', '— AGMessage restarted · 1 message kept —']]);
  const watch = await page(admin);
  const view = await emit(watch, 'join', { roomCode: SIDE, as: 'account', name: 'Ana Admin', adminView: true });
  assert.deepEqual([view.ok, view.adminView, view.roomName], [true, true, 'Legal']);
  // The laptop's token signs in no account: its support view names the room by its key all the same, unseated.
  const token = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const support = await emit(await page(token), 'join', { roomCode: SIDE, name: 'Gwen', role: 'observer', adminView: true });
  assert.deepEqual([support.ok, support.adminView, support.roomName, support.users.some((u) => u.name === 'Gwen')], [true, true, 'Legal', false]);
  const tomMain = await page(tom);
  assert.ok((await emit(tomMain, 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  const mainHeard = [];
  tomMain.on('message', (m) => mainHeard.push(m.text));
  const heard = once(watch, 'message');
  assert.ok((await emit(ana, 'message', { type: 'text', text: 'in Legal only' })).ok);
  assert.equal((await heard).text, 'in Legal only', 'a page in the room hears it');
  // Its people list is its own, sent to its pages.
  const people = once(watch, 'users');
  const second = await page(admin);
  assert.ok((await emit(second, 'join', { roomCode: SIDE, as: 'account' })).ok);
  assert.ok((await people).some((u) => u.name === 'Ana Admin'));
  // The hall's Stagewatch, set or changed, reaches every room the hall holds.
  const staged = once(ana, 'stage');
  assert.ok((await emit(await page(admin), 'hall:configure', { code: 'HALLA1', name: 'Hall A', stagewatchUrl: '127.0.0.1:9' })).ok);
  assert.ok(Object.hasOwn(await staged, 'cert'), 'the frame of a Stagewatch with an address, not "off"');
  // A forward from the Main room into the side room the admin sits in lands there, and the Main room never hears Legal.
  const anaMain = await page(admin);
  assert.ok((await emit(anaMain, 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  const sent = await emit(anaMain, 'message', { type: 'text', text: 'for the lawyers' });
  const forwarded = once(watch, 'message');
  assert.ok((await emit(anaMain, 'forward', { messageId: sent.id, targetRoom: SIDE })).ok);
  assert.deepEqual([(await forwarded).text, (await forwarded).forwardedFrom.roomName], ['for the lawyers', 'Hall A']);
  await wait(200);
  assert.ok(!mainHeard.includes('in Legal only'), 'the Main room never hears its side room: ' + JSON.stringify(mainHeard));
  // The admin's link: a guest in the Main room may then forward into it; an account, whose halls reach no side room, may not.
  assert.deepEqual(await emit(anaMain, 'admin:linkRoom', { socketId: tomMain.id, targetRoom: SIDE }), { ok: false, error: 'tom signs in with an account that may not post in that room: a side room is only for the accounts it is given to.' });
  const gus = await page();
  assert.ok((await emit(gus, 'join', { roomCode: 'HALLA1', name: 'Gus', role: 'research' })).ok);
  const fromGus = await emit(gus, 'message', { type: 'text', text: 'from the floor' });
  assert.deepEqual(await emit(gus, 'forward', { messageId: fromGus.id, targetRoom: SIDE }), { ok: false, error: 'You must be in the target room too (or ask admin to link you)' });
  assert.ok((await emit(anaMain, 'admin:linkRoom', { socketId: gus.id, targetRoom: SIDE })).ok);
  const linked = once(watch, 'message');
  assert.ok((await emit(gus, 'forward', { messageId: fromGus.id, targetRoom: SIDE })).ok);
  assert.equal((await linked).text, 'from the floor');
  // The admin's room controls reach it by its key.
  assert.ok((await emit(anaMain, 'admin:watchRoom', { roomCode: SIDE })).ok);
  assert.ok((await emit(anaMain, 'admin:lockRoles', { roomCode: SIDE, on: true })).locked);
  const health = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  assert.deepEqual([health.rooms, health.sideRooms], [1, 1]);
});

test('rights in a room: an account given a side room joins it backstage, posts, shares files and is forwarded into there; every hall\'s accounts and its hall\'s own do not; a hall\'s On stage account is seated On stage, and from the side room forwards into its hall only what that seat may post; an account that manages settings joins any room by its key, seated backstage, and one that does not is refused; the admin\'s link follows the account\'s rights in the room', async (t) => {
  // No act gives an account a room yet (the Accounts page does, later): its rooms and its On stage halls are written into
  // the accounts' file while the server is stopped, as the store keeps them.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  fs.mkdirSync(path.join(data, 'rooms'));
  const room = (code, name) => JSON.stringify({ code, name, createdAt: 1, seq: 0, settings: {}, messages: [], savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.json'), room('HALLA1', 'Hall A'));
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal'));
  const SIDE = 'LGQ4MZP8';
  let srv = await startServer({ AGM_DATA_DIR: data });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const PW = 'clipboard and coffee';
  let admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  // Nia and Max are project managers of Hall B alone; Nia also manages settings, which makes her the admin on her pages.
  for (const [username, role, extra] of [['lou', 'staff', { halls: [] }], ['tom', 'tech', { halls: ['HALLA1'] }], ['pat', 'manager', {}], ['kim', 'staff', { halls: ['HALLA1'] }],
    ['nia', 'manager', { allHalls: false, halls: ['HALLB1'], grant: ['settings.manage'] }], ['max', 'manager', { allHalls: false, halls: ['HALLB1'] }]]) {
    assert.ok((await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: PW, ...extra }, { cookie: admin })).body.ok, username);
  }
  await stopServer(srv.child);
  const file = path.join(data, 'accounts.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const given = { lou: { rooms: [SIDE] }, tom: { rooms: [SIDE] }, kim: { rooms: [SIDE], board: ['HALLA1'] } };
  for (const u of store.users) Object.assign(u, given[u.username] || {});
  fs.writeFileSync(file, JSON.stringify(store));
  srv = await startServer({ AGM_DATA_DIR: data, PORT: String(srv.port) });
  // Every sign-in comes from one address, whose allowance is 5 at once, then one every 2 s: past it, a sign-in waits for
  // its next one, as a person would, a few tries at most.
  const signIn = async (username, password = PW) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(srv.base, 'POST', '/api/auth/login', { username, password });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };
  admin = await signIn('ana', 'the green room kettle');
  const [lou, tom, pat, kim, nia, max] = [await signIn('lou'), await signIn('tom'), await signIn('pat'), await signIn('kim'), await signIn('nia'), await signIn('max')];
  const upload = async (token, name) => {
    const f = new FormData();
    f.append('file', new Blob(['clause 4, as agreed'], { type: 'text/plain' }), name);
    return (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f })).json();
  };
  // A message with these words, heard on a page (another page's join line may come first).
  const hears = (s, text) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message "' + text + '"')), 4000);
    const on = (m) => { if (m && m.text === text) { clearTimeout(timer); s.off('message', on); resolve(m); } };
    s.on('message', on);
  });

  // Lou, given Legal and no hall, joins Legal backstage, with an upload token, and posts and shares a file there; Hall
  // A's Main room, and the halls Lou reads, stay closed to Lou.
  const louSide = await page(lou);
  const inSide = await emit(louSide, 'join', { roomCode: SIDE, as: 'account' });
  assert.deepEqual([inSide.ok, inSide.role, typeof inSide.uploadToken], [true, 'research', 'string']);
  assert.ok((await emit(louSide, 'message', { type: 'text', text: 'Clause 4 agreed' })).ok);
  const louFile = await upload(inSide.uploadToken, 'clause4.txt');
  assert.equal(typeof louFile.url, 'string', JSON.stringify(louFile));
  assert.ok((await emit(louSide, 'message', { type: 'file', url: louFile.url, filename: 'clause4.txt' })).ok);
  assert.deepEqual(await emit(await page(lou), 'join', { roomCode: 'HALLA1', as: 'account' }), { ok: false, error: 'Your account has no access to this hall — ask an admin.' });
  assert.deepEqual((await api(srv.base, 'GET', '/api/halls', undefined, { cookie: lou })).body.halls, []);
  // Pat, a project manager of every hall, reaches Hall A and not its Legal room.
  assert.deepEqual(await emit(await page(pat), 'join', { roomCode: SIDE, as: 'account' }), { ok: false, error: 'Your account has no access to this room — ask an admin.' });
  const patMain = await page(pat);
  assert.deepEqual([(await emit(patMain, 'join', { roomCode: 'HALLA1', as: 'account' })).role], ['research']);
  // Hall A's rights in its Main room are 0.5.1's.
  const hallRow = (await api(srv.base, 'GET', '/api/halls', undefined, { cookie: tom })).body.halls[0];
  assert.deepEqual([hallRow.code, hallRow.can], ['HALLA1', { post: true, files: true, displays: true, stage: true }]);

  // Tom, of Hall A and given its Legal room, sits in both: from the Main room the picker lists Legal and a forward lands
  // there, where Lou hears it, by Tom's rights in Legal.
  const tomMain = await page(tom);
  assert.equal((await emit(tomMain, 'join', { roomCode: 'HALLA1', as: 'account' })).role, 'research');
  assert.equal((await emit(await page(tom), 'join', { roomCode: SIDE, as: 'account' })).role, 'research');
  const sent = await emit(tomMain, 'message', { type: 'text', text: 'for the lawyers' });
  // Each room by its reference too (unit 14), so Send to ▸ lists a room a list allows once.
  assert.deepEqual((await emit(tomMain, 'myRooms', { messageId: sent.id })).rooms.map(({ code, name, ref }) => ({ code, name, ref: /^r[A-Za-z0-9_-]{16}$/.test(ref) })), [{ code: SIDE, name: 'Legal', ref: true }]);
  const heard = once(louSide, 'message');
  assert.ok((await emit(tomMain, 'forward', { messageId: sent.id, targetRoom: SIDE })).ok);
  assert.equal((await heard).text, 'for the lawyers');

  // Kim, whose On stage halls name Hall A, is seated On stage in its Main room, and held to the seat's limit there.
  const kimMain = await page(kim);
  const kimJoin = await emit(kimMain, 'join', { roomCode: 'HALLA1', as: 'account' });
  assert.deepEqual([kimJoin.ok, kimJoin.role, kimJoin.uploadToken, kimJoin.forwardable], [true, 'board', null, false]);
  assert.deepEqual(await emit(kimMain, 'message', { type: 'file', url: '/uploads/x.pdf', filename: 'x.pdf' }), { ok: false, error: 'On stage seats send messages, not files.' });
  // Kim is also given Legal, where she sits backstage and shares a file. Forwarding from there into Hall A posts where
  // she would sit On stage, so that seat's limit holds: a text goes, a file does not, and the picker offers Hall A for
  // the text alone.
  const kimSide = await page(kim);
  const kimInSide = await emit(kimSide, 'join', { roomCode: SIDE, as: 'account' });
  assert.deepEqual([kimInSide.ok, kimInSide.role, typeof kimInSide.uploadToken, kimInSide.forwardable], [true, 'research', 'string', true]);
  const kimFile = await upload(kimInSide.uploadToken, 'brief.txt');
  const kimFileMsg = await emit(kimSide, 'message', { type: 'file', url: kimFile.url, filename: 'brief.txt' });
  assert.ok(kimFileMsg.ok, JSON.stringify(kimFileMsg));
  const kimText = await emit(kimSide, 'message', { type: 'text', text: 'Clause 4 is signed' });
  assert.deepEqual(await emit(kimSide, 'myRooms', { messageId: kimFileMsg.id }), { ok: true, rooms: [] }, 'a file is not offered where her seat shares none');
  const kimRooms = await emit(kimSide, 'myRooms', { messageId: kimText.id });
  assert.deepEqual({ ...kimRooms, rooms: kimRooms.rooms.map(({ code, name, ref }) => ({ code, name, ref: /^r[A-Za-z0-9_-]{16}$/.test(ref) })) }, { ok: true, rooms: [{ code: 'HALLA1', name: 'Hall A', ref: true }] });
  assert.deepEqual(await emit(kimSide, 'forward', { messageId: kimFileMsg.id, targetRoom: 'HALLA1' }), { ok: false, error: 'You may not share files in that hall.' });
  const inMain = hears(tomMain, 'Clause 4 is signed');
  assert.ok((await emit(kimSide, 'forward', { messageId: kimText.id, targetRoom: 'HALLA1' })).ok);
  const copy = await inMain;
  assert.deepEqual([copy.type, copy.from.name, copy.from.role, copy.forwardedFrom.roomName], ['text', 'kim', 'board', 'Legal'], 'posted as her seat there');

  // An account that manages settings is the admin on its pages: it joins a hall its halls do not list and a side room it
  // is not given, by their keys, seated backstage (it may post there, and does), never read-only. Without that right, the
  // same project manager is refused both, in the words of each.
  for (const code of ['HALLA1', SIDE]) {
    const niaPage = await page(nia);
    const j = await emit(niaPage, 'join', { roomCode: code, as: 'account' });
    assert.deepEqual([j.ok, j.role, typeof j.uploadToken], [true, 'research', 'string'], code);
    assert.ok((await emit(niaPage, 'message', { type: 'text', text: 'From the production office' })).ok, code);
  }
  assert.deepEqual(await emit(await page(max), 'join', { roomCode: 'HALLA1', as: 'account' }), { ok: false, error: 'Your account has no access to this hall — ask an admin.' });
  assert.deepEqual(await emit(await page(max), 'join', { roomCode: SIDE, as: 'account' }), { ok: false, error: 'Your account has no access to this room — ask an admin.' });

  // The admin's link of an account into a room follows its rights there: Tom may post in Legal, Pat may not.
  const ana = await page(admin);
  assert.ok((await emit(ana, 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  assert.ok((await emit(ana, 'admin:linkRoom', { socketId: tomMain.id, targetRoom: SIDE })).ok);
  assert.deepEqual(await emit(ana, 'admin:linkRoom', { socketId: patMain.id, targetRoom: SIDE }), { ok: false, error: 'pat signs in with an account that may not post in that room: a side room is only for the accounts it is given to.' });
});

test('a side room follows its hall: its countdown, and its sends and proposals to the hall\'s Stagewatch by the seat\'s rights (a Member guest none, an account its stage.send), followed after a restart; a help request there seen whole by the room and without its words by the hall\'s crew, who answer it from the board, and by no one else; the desk\'s notice in every room, counted by halls; its drafts told their hall\'s show and the room', async (t) => {
  // Hall A, its Legal room (its guest code on), and the accounts it is given to, written while the server is stopped (no
  // act gives an account a room yet).
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  fs.mkdirSync(path.join(data, 'rooms'));
  const SIDE = 'LGQ4MZP8';
  const room = (code, name, extra = {}) => JSON.stringify({ code, name, createdAt: 1, seq: 0, settings: {}, messages: [], savedAt: 1, gone: [], ...extra });
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.json'), room('HALLA1', 'Hall A'));
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.' + SIDE + '.json'), room(SIDE, 'Legal', { settings: { codeOff: false }, guestCode: 'LEGAL2' }));
  const swHall = await fakeStagewatch({ name: 'Hall A timer', messageId: 41 });
  const swDef = await fakeStagewatch({ name: 'Default timer', messageId: 99 });
  const model = await fakeModel();
  const ENV = { ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: model.url };
  let srv = await startServer({ AGM_DATA_DIR: data, ...ENV });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await swHall.close(); await swDef.close(); await model.close(); });
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const PW = 'clipboard and coffee';
  let admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  // Tom, a tech of Hall A, Ted, a tech of no hall, and Lou, a Staff account of no hall, are given Legal; Pat manages every
  // hall; Vic reads Hall A; Kim sits On stage in Hall A.
  for (const [username, role, extra] of [['tom', 'tech', { halls: ['HALLA1'] }], ['ted', 'tech', { halls: [] }], ['lou', 'staff', { halls: [] }], ['pat', 'manager', {}], ['vic', 'viewer', { halls: ['HALLA1'] }], ['kim', 'staff', { halls: ['HALLA1'] }]]) {
    assert.ok((await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: PW, ...extra }, { cookie: admin })).body.ok, username);
  }
  await stopServer(srv.child);
  const file = path.join(data, 'accounts.json');
  const given = { tom: { rooms: [SIDE] }, ted: { rooms: [SIDE] }, lou: { rooms: [SIDE] }, kim: { board: ['HALLA1'] } };
  const giveRooms = (more) => {
    const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const u of accounts.users) Object.assign(u, more[u.username] || {});
    fs.writeFileSync(file, JSON.stringify(accounts));
  };
  giveRooms(given);
  srv = await startServer({ AGM_DATA_DIR: data, PORT: String(srv.port), ...ENV });
  const signIn = async (username, password = PW) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(srv.base, 'POST', '/api/auth/login', { username, password });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };
  admin = await signIn('ana', 'the green room kettle');
  const [tom, ted, lou, pat, vic, kim] = [await signIn('tom'), await signIn('ted'), await signIn('lou'), await signIn('pat'), await signIn('vic'), await signIn('kim')];
  const ctl = await page(admin);
  assert.ok((await emit(ctl, 'admin:settings', { stagewatchUrl: swDef.url, stagewatchKey: KEY_B })).ok);
  assert.ok((await emit(ctl, 'hall:configure', { code: 'HALLA1', name: 'Hall A', stagewatchUrl: swHall.url, stagewatchKey: KEY_A })).ok);
  await until(() => swHall.connected && swDef.connected, 8000, 'both Stagewatches linked');
  // The hall's Main room may send and propose to its Stagewatch once its key is accepted and its show desk known.
  const main = await page(admin);
  await until(async () => { const j = await emit(main, 'join', { roomCode: 'HALLA1', as: 'account' }); return j.canSendToStage && j.canPropose && j.stage && j.stage.title === 'Hall A timer'; }, 15000, 'the Main room able to send and propose');
  main.close();
  const sends = () => [swHall, swDef].map((sw) => sw.requests.filter((r) => r.url.startsWith('/api/message/')).length);
  const proposed = () => [swHall, swDef].map((sw) => sw.requests.filter((r) => r.method === 'POST' && r.url === '/api/proposals').length);

  // A Member guest of Legal sees its hall's countdown and sends nothing to it: its seat holds no stage right.
  const gus = await page();
  const gusIn = await emit(gus, 'join', { roomCode: 'LEGAL2', name: 'Gus', role: 'research' });
  assert.deepEqual([gusIn.ok, gusIn.role, gusIn.main, gusIn.stage && gusIn.stage.title, gusIn.canSendToStage, gusIn.canPropose], [true, 'research', false, 'Hall A timer', false, false]);
  const gusTargets = await emit(gus, 'stage:targets', {});
  assert.deepEqual([gusTargets.ok, gusTargets.title, gusTargets.canSend, gusTargets.canPropose], [true, 'Hall A timer', false, false], 'its hall\'s Stagewatch, and nothing it may send');
  assert.deepEqual(await emit(gus, 'stage:send', { text: 'Five minutes' }), { ok: false, error: 'The speaker\'s screen is for the backstage team.' });
  assert.deepEqual(await emit(gus, 'stage:propose', { text: 'Five minutes', destination: 'speaker' }), { ok: false, error: 'Proposing to the stage is for the backstage team.' });
  // Lou, given Legal without a right to the stage, likewise; and Ted, a tech given Legal in no hall: an account sends to
  // a hall's Stagewatch by its stage.send in that hall, which a room given to it does not grant.
  const louIn = await emit(await page(lou), 'join', { roomCode: SIDE, as: 'account' });
  assert.deepEqual([louIn.ok, louIn.role, louIn.canSendToStage, louIn.canPropose], [true, 'research', false, false]);
  const tedSide = await page(ted);
  const tedIn = await emit(tedSide, 'join', { roomCode: SIDE, as: 'account' });
  assert.deepEqual([tedIn.ok, tedIn.role, tedIn.stage && tedIn.stage.title, tedIn.canSendToStage, tedIn.canPropose], [true, 'research', 'Hall A timer', false, false]);
  const tedTargets = await emit(tedSide, 'stage:targets', {});
  assert.deepEqual([tedTargets.ok, tedTargets.canSend, tedTargets.canPropose], [true, false, false]);
  assert.deepEqual(await emit(tedSide, 'stage:send', { text: 'Five minutes' }), { ok: false, error: 'The speaker\'s screen is for the backstage team.' });
  assert.deepEqual(await emit(tedSide, 'stage:propose', { text: 'Five minutes', destination: 'speaker' }), { ok: false, error: 'Proposing to the stage is for the backstage team.' });
  await wait(200);
  assert.deepEqual([sends(), proposed()], [[0, 0], [0, 0]], 'nothing reached either Stagewatch');

  // Tom, given Legal and holding stage.send in Hall A, sends from Legal to Hall A's speaker's screen and proposes to its
  // show desk; the default Stagewatch hears nothing, and both are written into Legal.
  const tomSide = await page(tom);
  const tomIn = await emit(tomSide, 'join', { roomCode: SIDE, as: 'account' });
  assert.deepEqual([tomIn.ok, tomIn.role, tomIn.stage && tomIn.stage.title, tomIn.canSendToStage, tomIn.canPropose], [true, 'research', 'Hall A timer', true, true]);
  const tomTargets = await emit(tomSide, 'stage:targets', {});
  assert.deepEqual([tomTargets.ok, tomTargets.title, tomTargets.canSend, tomTargets.canPropose], [true, 'Hall A timer', true, true]);
  const sent = await emit(tomSide, 'stage:send', { text: 'Clause 4 is signed' });
  assert.deepEqual([sent.ok, sent.messageId], [true, 41], JSON.stringify(sent));
  const asked = await emit(tomSide, 'stage:propose', { text: 'Thank the lawyers', destination: 'speaker' });
  assert.ok(asked.ok, JSON.stringify(asked));
  assert.deepEqual([sends(), proposed()], [[1, 0], [1, 0]], 'the hall\'s Stagewatch alone');
  const legal = async (s) => (await emit(s, 'admin:watchRoom', { roomCode: SIDE })).messages;
  const records = await legal(ctl);
  const sendRecord = records.find((m) => m.stage && m.stage.ref === 41);
  const askRecord = records.find((m) => m.proposal && m.proposal.id === asked.proposal.id);
  assert.deepEqual([sendRecord && sendRecord.stage.link, sendRecord && sendRecord.stage.ack, askRecord && askRecord.proposal.link, askRecord && askRecord.proposal.state], ['hall:HALLA1', 'sent', 'hall:HALLA1', 'pending'], 'written into Legal, with the hall\'s link');

  // A help request in Legal: Legal's pages hear it whole; the halls board shows it whole to whoever reads Legal (the admin,
  // Lou), without its words to the hall's crew who do not (Pat), and to nobody else (Vic reads Hall A only; Kim sits On
  // stage there). The hall's key, its Main room's address and guest code, goes only to a watcher who sees the hall: Lou's
  // board names Hall A by its name alone.
  const tomHears = once(tomSide, 'message');
  const help = await emit(gus, 'message', { type: 'help', category: 'Sound', text: 'the lectern mic in Legal is dead' });
  assert.ok(help.ok, JSON.stringify(help));
  const heardHelp = await tomHears;
  assert.deepEqual([heardHelp.type, heardHelp.text, heardHelp.help.state], ['help', 'the lectern mic in Legal is dead', 'open']);
  const boardOf = async (cookie) => { const s = await page(cookie); return (await emit(s, 'board:watch', {})).board; };
  const itemOf = (b) => b.help.find((h) => h.id === help.id);
  const shape = (x) => x && [x.code, x.hall, x.hallName, x.roomName, x.category, x.from, x.state, x.text, x.canOpen, x.canRespond];
  const whole = [SIDE, 'HALLA1', 'Hall A', 'Legal', 'Sound', 'Gus', 'open', 'the lectern mic in Legal is dead', true, true];
  assert.deepEqual(shape(itemOf(await boardOf(admin))), whole, 'the admin');
  const louBoard = await boardOf(lou);
  assert.deepEqual(shape(itemOf(louBoard)), [SIDE, undefined, 'Hall A', 'Legal', 'Sound', 'Gus', 'open', 'the lectern mic in Legal is dead', true, true], 'Lou, who reads Legal and no hall');
  assert.ok(!('hall' in itemOf(louBoard)), 'no hall key for Lou');
  assert.ok(!JSON.stringify(louBoard).includes('HALLA1'), 'nothing of Main\'s key or guest code in Lou\'s board: ' + JSON.stringify(louBoard));
  assert.deepEqual(shape(itemOf(await boardOf(pat))), [SIDE, 'HALLA1', 'Hall A', 'Legal', 'Sound', 'Gus', 'open', '', false, true], 'Pat, the hall\'s crew: no words, no way in');
  assert.equal(itemOf(await boardOf(vic)), undefined, 'Vic, who reads Hall A alone');
  assert.equal(itemOf(await boardOf(kim)), undefined, 'Kim, On stage in Hall A');
  // The hall row's count is its Main room's; the board counts its rooms' requests by hall.
  assert.equal((await boardOf(pat)).halls.find((h) => h.code === 'HALLA1').help, 0);
  // Pat answers it from the board: Legal hears who is on the way. Vic and Kim may not; Kim, who would answer it as the
  // hall's crew but for her On stage seat there, is told so in the On stage words (owner answer B1).
  const vicBoard = await page(vic);
  assert.deepEqual(await emit(vicBoard, 'help:respond', { code: SIDE, messageId: help.id, state: 'coming' }), { ok: false, error: 'Only people in that hall can answer its help requests.' });
  assert.deepEqual(await emit(await page(kim), 'help:respond', { code: SIDE, messageId: help.id, state: 'coming' }), { ok: false, error: 'Help requests are answered by the backstage team.' });
  const onWay = once(gus, 'helpUpdate');
  assert.deepEqual(await emit(await page(pat), 'help:respond', { code: SIDE, messageId: help.id, state: 'coming' }), { ok: true });
  assert.deepEqual([(await onWay).help.state, (await onWay).help.by], ['coming', 'pat']);
  // Recorded in the events of the hall's Stagewatch's context, never the default's.
  const helpEvent = (sw) => sw.requests.some((r) => r.url === '/api/peers/context' && r.body.includes('a help request was answered'));
  await until(() => helpEvent(swHall), 12000, 'the answer in the hall\'s Stagewatch\'s context');
  assert.equal(helpEvent(swDef), false, 'and not in the default\'s');

  // Nothing of Legal's is in a context: neither its help request (the hall's count is its Main room's, none) nor an action
  // prompt asked there, in what the hall's Stagewatch is posted or in GET /api/context; a prompt of the Main room is.
  assert.ok((await emit(tomSide, 'message', { type: 'action', text: 'Sign the Legal annex?', options: ['Yes', 'No'] })).ok);
  const anaMain = await page(admin);
  assert.ok((await emit(anaMain, 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  assert.ok((await emit(anaMain, 'message', { type: 'action', text: 'Ready for the vote?', options: ['Yes', 'No'] })).ok);
  const posted = () => swHall.requests.filter((r) => r.url === '/api/peers/context').map((r) => r.body);
  await until(() => posted().some((b) => b.includes('Ready for the vote?')), 8000, 'the Main room\'s prompt in the hall\'s Stagewatch\'s context');
  const node = (await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body;
  assert.ok(JSON.stringify(node).includes('Ready for the vote?'), 'the node\'s context has the Main room\'s prompt');
  for (const [said, what] of [[posted().find((b) => b.includes('Ready for the vote?')), 'the hall\'s Stagewatch\'s context'], [JSON.stringify(node), 'GET /api/context']]) {
    assert.ok(!said.includes('Sign the Legal annex') && !said.includes('lectern mic'), what + ' carries nothing of Legal: ' + said);
    const ctx = JSON.parse(said);
    assert.ok(!ctx.items.some((i) => i.id === 'help') && !/help request/.test(ctx.headline), what + ' counts no help: the hall\'s Main room has none open');
  }

  // Gus marks his own request sorted from Legal's page, which names the room by the code it joined with.
  const sorted = once(tomSide, 'helpUpdate');
  assert.deepEqual(await emit(gus, 'help:respond', { code: 'LEGAL2', messageId: help.id, state: 'resolved' }), { ok: true });
  assert.deepEqual([(await sorted).help.state, (await sorted).help.by], ['resolved', 'Gus']);
  assert.equal(itemOf(await boardOf(admin)), undefined, 'gone from the board');

  // The AI, asked in Legal, is told its hall's Stagewatch and that this is Legal, which nobody on stage reads; asked in
  // the Main room, nothing of the room.
  const LINE = 'This chat is the hall\'s \'Legal\' room, not its Main room: nobody on stage reads it.';
  const drafted = await emit(tomSide, 'ai:draft', { question: 'Is clause 4 signed?' });
  assert.ok(drafted.ok, JSON.stringify(drafted));
  const optioned = await emit(tomSide, 'ai:options', { prompt: 'Sign clause 5 now?' });
  assert.ok(optioned.ok, JSON.stringify(optioned));
  const tomMain = await page(tom);
  assert.ok((await emit(tomMain, 'join', { roomCode: 'HALLA1', as: 'account' })).ok);
  assert.ok((await emit(tomMain, 'ai:draft', { question: 'Is clause 4 signed?' })).ok);
  const [legalDraft, legalOptions, mainDraft] = model.bodies.slice(-3).map((b) => JSON.parse(b).messages[0].content);
  for (const [said, what] of [[legalDraft, 'Legal\'s draft'], [legalOptions, 'Legal\'s options']]) {
    assert.ok(said.includes(LINE), what + ' names its room: ' + said.slice(0, 200));
    assert.ok(said.includes('Hall A timer') && !said.includes('Default timer'), what + ' is told its hall\'s Stagewatch: ' + said);
    assert.ok(said.includes('the lectern mic in Legal is dead'), what + ' reads Legal\'s thread');
  }
  assert.ok(mainDraft.includes('Hall A timer') && !mainDraft.includes(LINE) && !mainDraft.includes('the lectern mic in Legal is dead') && !mainDraft.includes('Sign the Legal annex'), 'the Main room\'s draft: its hall\'s show, no room line, nothing of Legal');

  // The show desk's notice lands in every room of the hall, and is answered as shown in one meeting: a hall.
  const ctx = await emit(ctl, 'admin:settings');
  const notice = swHall.add({ line: 'notice Break in 5 minutes', state: 'approved', decidedBy: 'SM', from: { t: 'main', id: 'swdesk', name: 'Desk' }, target: { t: 'messenger', id: ctx.nodeId, name: 'AGMessage' } });
  const tomHearsNotice = new Promise((resolve) => { tomSide.on('system', (m) => { if (/From the show desk/.test(m.text || '')) resolve(m.text); }); });
  await until(() => swHall.proposals.get(notice).state === 'done', 20000, 'the notice reported');
  assert.equal(swHall.proposals.get(notice).words, 'shown in 1 meeting');
  assert.equal(await tomHearsNotice, '📣 From the show desk (approved by SM): Break in 5 minutes');
  const noticed = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.text === '📣 From the show desk (approved by SM): Break in 5 minutes').length;
  assert.deepEqual([await noticed('HALLA1'), await noticed(SIDE)], [1, 1], 'in the Main room and in Legal');

  // AGMessage restarts before the speaker acknowledges and before the operator decides: both are still followed in Legal.
  // While it is stopped, a hall with no name is added beside Hall A, its Media room given to Lou as well.
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer(srv.child);
  const MEDIA = 'MDQ7KXR2';
  fs.writeFileSync(path.join(data, 'rooms', 'HALLB2.json'), room('HALLB2', ''));
  fs.writeFileSync(path.join(data, 'rooms', 'HALLB2.' + MEDIA + '.json'), room(MEDIA, 'Media', { settings: { codeOff: false }, guestCode: 'MEDIA3' }));
  giveRooms({ lou: { rooms: [SIDE, MEDIA] } });
  srv = await startServer({ AGM_DATA_DIR: data, PORT: String(srv.port), ...ENV });
  await until(() => swHall.connected, 8000, 'linked again after the restart');
  admin = await signIn('ana', 'the green room kettle');
  const ctl2 = await page(admin);
  await wait(400);
  swHall.frame({ messageId: 41, messageAck: 'done', messageAckBy: 'Speaker A' });
  swHall.approve(asked.proposal.id);
  await until(async () => { const m = await legal(ctl2); return m.find((x) => x.stage && x.stage.ref === 41).stage.ack === 'done' && m.find((x) => x.proposal && x.proposal.id === asked.proposal.id).proposal.state === 'approved'; }, 10000, 'the speaker\'s acknowledgement and the operator\'s decision in Legal');
  const after = await legal(ctl2);
  assert.deepEqual([after.find((x) => x.stage && x.stage.ref === 41).stage.by, after.find((x) => x.proposal && x.proposal.id === asked.proposal.id).proposal.by], ['Speaker A', 'Show caller']);

  // A help request in the nameless hall's Media room: Lou's board names its hall as one with no name, never by its key, and
  // carries no hall's key at all; the admin, who sees the hall, is told its key.
  const guest = await page();
  assert.ok((await emit(guest, 'join', { roomCode: 'MEDIA3', name: 'Mo', role: 'research' })).ok);
  const mediaHelp = await emit(guest, 'message', { type: 'help', category: 'Vision', text: 'the Media room projector is off' });
  assert.ok(mediaHelp.ok, JSON.stringify(mediaHelp));
  const mediaOf = (b) => b.help.find((h) => h.id === mediaHelp.id);
  const louAgain = await boardOf(await signIn('lou'));
  assert.deepEqual(shape(mediaOf(louAgain)), [MEDIA, undefined, 'A hall with no name', 'Media', 'Vision', 'Mo', 'open', 'the Media room projector is off', true, true]);
  assert.ok(!/HALLA1|HALLB2/.test(JSON.stringify(louAgain)), 'no hall\'s key in Lou\'s board: ' + JSON.stringify(louAgain));
  assert.deepEqual(shape(mediaOf(await boardOf(admin))), [MEDIA, 'HALLB2', 'HALLB2', 'Media', 'Vision', 'Mo', 'open', 'the Media room projector is off', true, true]);

  // Tom sends from Legal again, and the hall's Stagewatch restarts before the speaker sees it (its seq goes back): the send
  // can no longer be followed, and Legal's pages and records say so at once; the one acknowledged keeps its acknowledgement.
  swHall.frame({ seq: 10, messageId: 0, messageAck: '', messageAckBy: '' });
  const tomAgain = await page(await signIn('tom'));
  assert.ok((await emit(tomAgain, 'join', { roomCode: SIDE, as: 'account' })).ok);
  await wait(150);   // the frame of that seq is in before the send
  const again = await emit(tomAgain, 'stage:send', { text: 'Clause 5 is signed' });
  assert.deepEqual([again.ok, again.messageId], [true, 41], JSON.stringify(again));
  const lost = new Promise((resolve) => { tomAgain.on('stageAck', (a) => { if (a.stage.ack === 'lost') resolve(a.stage); }); });
  swHall.frame({ seq: 1 });
  assert.ok(await Promise.race([lost, wait(3000)]), 'Legal told the send is lost');
  const acks = (await legal(ctl2)).filter((x) => x.stage && x.stage.ref === 41).map((x) => [(/Clause \d/.exec(x.text) || [''])[0], x.stage.ack]);
  assert.deepEqual(acks, [['Clause 4', 'done'], ['Clause 5', 'lost']], JSON.stringify(acks));
});

test('a side room\'s pages and messages keep the laptop awake and busy', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-e2e-'));
  fs.mkdirSync(path.join(data, 'rooms'));
  const room = (code, name) => JSON.stringify({ code, name, createdAt: 1, seq: 0, settings: {}, messages: [], savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.json'), room('HALLA1', 'Hall A'));
  fs.writeFileSync(path.join(data, 'rooms', 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal'));
  let srv = await startServer({ AGM_DATA_DIR: data });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const ana = await connect(srv.base, admin);
  sockets.push(ana);
  assert.ok((await emit(ana, 'join', { roomCode: 'LGQ4MZP8', as: 'account' })).ok);
  // A meeting in the side room alone is a live hall: its page is counted where the power request reads the halls.
  let power;
  await until(async () => { power = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body.power; return power.what.pages === 1; }, 5000, 'the side room\'s page counted: ' + JSON.stringify(power));
  // A message it holds from the window makes its page active, across a restart too (no input heard since).
  assert.ok((await emit(ana, 'message', { type: 'text', text: 'Contract signed' })).ok);
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  srv = await restartServer(srv);
  const b = await wire.busy({ port: srv.port, token: TOKEN });
  assert.deepEqual([b.busy, b.line.active, b.line.sockets], [true, 1, 0], 'the side room\'s message: ' + JSON.stringify(b));
});

/** A stand-in for the AI's endpoint (the SDK's ANTHROPIC_BASE_URL): the minutes it answers, and every request's body kept. */
async function fakeModel() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ headline: 'Clause 4 agreed', decisions: [], open: [], actions: [] }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  return { url: 'http://127.0.0.1:' + srv.address().port, bodies, close: () => new Promise((resolve) => { srv.close(resolve); }) };
}

test('rooms are made, renamed, reset and removed by those who set halls up; a side room\'s key is never taken for a hall; the admin\'s reads of a room it is not given are audited once; a hall removed takes its rooms and its accounts\' keys, the next start loads cleanly, and its node proposes nothing', async (t) => {
  const sw = await fakeStagewatch({ name: 'Default timer' });
  const node = await fakeNode({ commands: [{ verb: 'CUE <n>', risk: 'low' }] });
  const model = await fakeModel();
  let srv = await startServer({ ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: model.url });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); await node.close(); await model.close(); });
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const PW = 'clipboard and coffee';
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB, hallC] = [await hall('Hall A'), await hall('Hall B'), await hall('Hall C')];
  for (const [username, role, extra] of [['pat', 'manager', {}], ['tom', 'tech', { halls: [hallA, hallB] }], ['lou', 'staff', { halls: [] }]]) {
    assert.ok((await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: PW, ...extra }, { cookie: admin })).body.ok, username);
  }
  const signIn = async (username, password = PW) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(srv.base, 'POST', '/api/auth/login', { username, password });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };
  const [pat, tom] = [await signIn('pat'), await signIn('tom')];
  const ctl = await page(admin);
  const patPage = await page(pat);
  const tomPage = await page(tom);
  // The audit log's rows of an action, as written (each on disk before its act is answered): target, words, who.
  const rows = (action) => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words, e.actor.name]);
  // A request asked again while its bucket refills (`busy`), as a page's outbox would; a room made so.
  const asked = async (s, verb, args) => { for (;;) { const r = await emit(s, verb, args); if (!r.busy) return r; await wait(250); } };
  const make = (s, at, name) => asked(s, 'room:create', { hall: at, name });
  const NO_RIGHT = { ok: false, error: 'Your account may not set halls up.' };

  // Made by those who set halls up (a project manager, the admin): a tech of the hall and a code guest may not.
  const gus = await page();
  assert.ok((await emit(gus, 'join', { roomCode: hallA, name: 'Gus', role: 'research' })).ok);
  for (const s of [tomPage, gus]) assert.deepEqual(await emit(s, 'room:create', { hall: hallA, name: 'Legal' }), NO_RIGHT);
  assert.deepEqual(await emit(patPage, 'room:create', { hall: 'NOHALL', name: 'Legal' }), { ok: false, error: 'No such hall.' });
  assert.deepEqual(await emit(patPage, 'room:create', { hall: hallA, name: ' \u202e ' }), { ok: false, error: 'Name the room (for example Legal).' });
  const legal = await emit(patPage, 'room:create', { hall: hallA, name: 'Legal' });
  assert.deepEqual([legal.ok, legal.name, legal.hall, /^[A-Z2-9]{8}$/.test(legal.key)], [true, 'Legal', hallA, true], JSON.stringify(legal));
  const LEGAL = legal.key;
  // Asked again with the client id its page gave it (the outbox sends it again after a drop while it was out), a create
  // is answered with the room it made: one room, one row. The same id from another person is that person's own act, and
  // an id that is not one is refused.
  const media = await asked(ctl, 'room:create', { hall: hallA, name: 'Media', cid: 'c-make-media-01' });
  assert.deepEqual([media.ok, media.name], [true, 'Media'], JSON.stringify(media));
  assert.deepEqual(await asked(ctl, 'room:create', { hall: hallA, name: 'Media', cid: 'c-make-media-01' }), media, 'the repeat is answered as the first');
  assert.deepEqual(await asked(patPage, 'room:create', { hall: hallA, name: 'Media', cid: 'c-make-media-01' }), { ok: false, error: 'Hall A has a room named Media already.' });
  assert.deepEqual(await asked(ctl, 'room:create', { hall: hallA, name: 'Press', cid: { id: 1 } }), { ok: false, error: 'That act\'s id could not be read.' });
  const MEDIA = media.key;
  // Its first snapshot is on disk at once, beside its hall, its guest code off.
  const snap = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', hallA + '.' + LEGAL + '.json'), 'utf8'));
  assert.deepEqual([snap.code, snap.name, snap.settings], [LEGAL, 'Legal', { codeOff: true }]);
  // One name to a room in its hall, the Main room's (the hall's) included, in any case; a side room's key is no hall.
  assert.deepEqual(await make(ctl, hallA, 'LEGAL'), { ok: false, error: 'Hall A has a room named LEGAL already.' });
  assert.deepEqual(await make(ctl, hallA, 'hall a'), { ok: false, error: 'Hall A has a room named hall a already.' });
  assert.deepEqual(await make(ctl, LEGAL, 'Press'), { ok: false, error: 'No such hall.' });
  assert.deepEqual(rows('room.create'), [[LEGAL, 'Legal in Hall A (code off)', 'pat'], [MEDIA, 'Media in Hall A (code off)', 'ana']]);
  // At most 20 beside a hall: the 21st is refused with words, and nothing is written for it.
  for (let i = 1; i <= 20; i++) assert.ok((await make(ctl, hallC, 'Room ' + i)).ok, 'Room ' + i);
  assert.deepEqual(await make(ctl, hallC, 'Room 21'), { ok: false, error: 'Hall C holds 20 rooms beside its Main room already: remove one to make another.' });
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'rooms')).filter((f) => f.startsWith(hallC + '.') && f.endsWith('.json') && f.split('.').length === 3).length, 20, 'twenty rooms\' snapshots beside Hall C');
  assert.equal(rows('room.create').length, 22);

  // A side room's key is never taken for a hall: each hall's verb refuses it in its own words.
  const screen = (await emit(ctl, 'display:create', { code: hallA, name: 'Lectern' })).display;
  for (const [verb, args, error] of [
    ['display:list', { code: LEGAL }, 'Your account may not drive this hall\'s screens.'],
    ['display:create', { code: LEGAL, name: 'Side screen' }, 'Your account may not add screens to this hall.'],
    ['display:update', { id: screen.id, hall: LEGAL }, 'No such screen or hall, or not yours to change.'],
    ['display:hallHolding', { code: LEGAL, image: '' }, 'Your account may not set this hall\'s holding image.'],
    ['nodes:link', { id: 'side01', t: 'patterns', url: '127.0.0.1:9', hall: LEGAL }, 'No such hall.'],
    ['hall:settings', { code: LEGAL }, 'No such hall.'],
    ['hall:configure', { code: LEGAL, name: 'Taken for a hall' }, 'No such hall.'],
  ]) assert.deepEqual(await asked(ctl, verb, args), { ok: false, error }, verb);
  // Nor is it listed where halls are: the halls board, /api/halls, the show network's halls, the context. It is listed
  // under its hall's row (`rooms`), to whoever may enter it: the admin's board, never a project manager of every hall,
  // who is given neither room.
  const board = (await emit(ctl, 'board:watch', {})).board;
  const halls = (await api(srv.base, 'GET', '/api/halls', undefined, { cookie: pat })).body;
  const nodesHalls = (await emit(ctl, 'nodes:list', {})).halls;
  const context = (await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body;
  const three = [hallA, hallB, hallC].sort();
  assert.deepEqual([board.halls.map((h) => h.code).sort(), halls.halls.map((h) => h.code).sort(), nodesHalls.map((h) => h.code).sort()], [three, three, three]);
  assert.match(context.items.find((i) => i.id === 'meetings').state, /^3 meetings/, 'the context counts halls');
  const underIts = Object.fromEntries(board.halls.map((h) => [h.code, h.rooms.map((x) => x.name)]));
  assert.deepEqual(underIts, { [hallA]: ['Legal', 'Media'], [hallB]: [], [hallC]: Array.from({ length: 20 }, (_, i) => 'Room ' + (i + 1)) }, 'under its hall, on the admin\'s board');
  assert.deepEqual(board.halls.find((h) => h.code === hallA).rooms.map((x) => x.key), [LEGAL, MEDIA]);
  assert.deepEqual([board.yourRooms, halls.rooms, halls.halls.flatMap((h) => h.rooms)], [[], [], []], 'nowhere else, and not to every hall\'s account');
  const read = JSON.stringify([{ ...board, halls: board.halls.map(({ rooms, ...row }) => row) }, halls, nodesHalls, context]);
  assert.ok(!read.includes(LEGAL) && !read.includes(MEDIA) && !/Legal|Media|Room 1\b/.test(read), 'no side room, by its key or its name: ' + read.slice(0, 200));
  // The admin's room list holds each hall's rooms beside it, by key, in the order they were made; no row of its own.
  const list = async () => (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms;
  const listed = await list();
  assert.deepEqual(listed.map((r) => r.code).sort(), three);
  assert.deepEqual(listed.find((r) => r.code === hallA).side.map((x) => [x.key, x.name, x.messageCount, x.locked, x.users]), [[LEGAL, 'Legal', 0, false, []], [MEDIA, 'Media', 0, false, []]]);
  assert.deepEqual(listed.find((r) => r.code === hallC).side.map((x) => x.name), Array.from({ length: 20 }, (_, i) => 'Room ' + (i + 1)));
  // A room's settings, for those who set halls up: each of the hall's rooms with its guest code (told to those who set
  // halls up), whether it admits guests, the guest pages in it and the rooms that may send into it (Set up's Rooms draws
  // them); the asked room's list, which none may yet, and not every hall's rooms, which only the admin is told.
  const legalCode = listed.find((r) => r.code === hallA).side[0].guestCode;
  const mediaCode = listed.find((r) => r.code === hallA).side[1].guestCode;
  assert.deepEqual(await emit(patPage, 'room:settings', { code: LEGAL }), {
    ok: true, key: LEGAL, name: 'Legal', main: false, hall: hallA, hallName: 'Hall A',
    rooms: [
      { key: hallA, name: 'Hall A', main: true, guestCode: hallA, codeOn: true, guests: 1, sendFrom: [] },   // Gus's page, by count
      { key: LEGAL, name: 'Legal', main: false, guestCode: legalCode, codeOn: false, guests: 0, sendFrom: [] },
      { key: MEDIA, name: 'Media', main: false, guestCode: mediaCode, codeOn: false, guests: 0, sendFrom: [] },
    ],
    guestCode: legalCode, codeOn: false, sendFrom: [], sendBack: [],
  });
  assert.match(legalCode, /^[A-Z2-9]{6}$/, 'those who set rooms up are told a room\'s guest code');
  assert.deepEqual(await emit(tomPage, 'room:settings', { code: LEGAL }), NO_RIGHT);
  assert.deepEqual(await emit(patPage, 'room:settings', { code: 'NOROOM12' }), { ok: false, error: 'No such room.' });

  // The admin's reads of a room it is not given: a page entered (never a resume, nor a page catching up on its own
  // socket), a watch begun (not the room watched already), a transcript, a person's view and the AI's minutes, each one
  // row naming the room by its name and its hall's and never what was read. A hall's Main room writes none.
  const anaLegal = await page(admin);
  const entered = await emit(anaLegal, 'join', { roomCode: LEGAL, as: 'account' });
  assert.ok(entered.ok);
  assert.ok((await emit(anaLegal, 'message', { type: 'text', text: 'the contract, clause 4' })).ok);
  assert.ok((await emit(anaLegal, 'join', { roomCode: LEGAL, as: 'account', since: entered.seq })).ok, 'a resume');
  assert.ok((await emit(anaLegal, 'join', { roomCode: LEGAL, as: 'account' })).ok, 'the same page catching up');
  assert.ok((await emit(await page(admin), 'join', { roomCode: hallA, as: 'account' })).ok, 'the Main room');
  for (const code of [LEGAL, LEGAL, hallA, LEGAL]) assert.ok((await emit(ctl, 'admin:watchRoom', { roomCode: code })).ok);
  const token = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  for (const [cookie, code] of [[token, LEGAL], [admin, LEGAL], [token, hallA]]) assert.equal((await fetch(srv.base + '/api/admin/transcript/' + code, { headers: { cookie } })).status, 200);
  const transcript = await (await fetch(srv.base + '/api/admin/transcript/' + LEGAL, { headers: { cookie: token } })).text();
  assert.ok(transcript.includes('<h1>Legal (Hall A)</h1>') && transcript.includes('Room key <strong>' + LEGAL), 'the transcript names the room with its hall, by its key');
  assert.ok((await emit(await page(token), 'join', { roomCode: LEGAL, name: 'Gwen', role: 'observer', adminView: true })).ok);
  const minutes = await emit(ctl, 'admin:summary', { roomCode: LEGAL });
  assert.deepEqual([minutes.ok, minutes.headline], [true, 'Clause 4 agreed'], JSON.stringify(minutes));
  assert.match(JSON.parse(model.bodies.at(-1)).messages[0].content, /^Hall: Legal \(Hall A\)\n/, 'the minutes are asked of the room with its hall\'s name');
  const reads = rows('room.read');
  assert.deepEqual(reads, [
    [LEGAL, 'entered Legal (Hall A) as the admin', 'ana'],
    [LEGAL, 'watched Legal (Hall A)', 'ana'],
    [LEGAL, 'watched Legal (Hall A)', 'ana'],
    [LEGAL, 'transcript of Legal (Hall A)', 'AGMessage laptop'],
    [LEGAL, 'transcript of Legal (Hall A)', 'ana'],
    [LEGAL, 'transcript of Legal (Hall A)', 'AGMessage laptop'],
    [LEGAL, 'opened Gwen\'s view of Legal (Hall A)', 'AGMessage laptop'],
    [LEGAL, 'minutes of Legal (Hall A) asked of the AI', 'ana'],
  ]);
  assert.ok(!JSON.stringify(reads).includes('contract'), 'what was read is in no row');

  // Renamed by those who set halls up: a side room's name is its own row; the same name again is done, with none; a
  // hall's Main room renamed is the hall renamed, on its screens too, written as its set-up writes it.
  assert.deepEqual(await emit(tomPage, 'room:update', { code: LEGAL, name: 'Lawyers' }), NO_RIGHT);
  // A room's guest code is the admin's alone (owner question 5): switched or renewed, a project manager is refused.
  assert.deepEqual(await emit(patPage, 'room:update', { code: LEGAL, codeOn: true }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await emit(patPage, 'room:update', { code: LEGAL, pinned: true }), { ok: false, error: 'A room\'s name, its guest code and the rooms that may send into it are the settings changed here.' });
  assert.deepEqual(await emit(patPage, 'room:update', { code: LEGAL, name: '' }), { ok: false, error: 'Type its new name.' });
  assert.deepEqual(await emit(patPage, 'room:update', { code: 'NOROOM12', name: 'x' }), { ok: false, error: 'No such room.' });
  assert.deepEqual(await emit(patPage, 'room:update', { code: MEDIA, name: 'legal' }), { ok: false, error: 'Hall A has a room named legal already.' });
  // The hall's Set up holds the same rule, in the same words: a hall named as one of its rooms is refused, and nothing it
  // was asked is applied.
  assert.deepEqual(await asked(patPage, 'hall:configure', { code: hallA, name: 'MEDIA', stagewatchUrl: '' }), { ok: false, error: 'Hall A has a room named MEDIA already.' });
  assert.equal((await emit(patPage, 'room:settings', { code: hallA })).name, 'Hall A');
  const heard = once(anaLegal, 'roomMeta');
  // As a page sends it: with the client id every act from the outbox carries.
  assert.deepEqual(await emit(patPage, 'room:update', { code: LEGAL, name: 'Legal team', cid: 'c-1234567890ab' }), { ok: true, name: 'Legal team' });
  assert.equal((await heard).name, 'Legal team', 'its pages hear the new name as one numbered change');
  assert.deepEqual(await emit(patPage, 'room:update', { code: LEGAL, name: 'Legal team' }), { ok: true, already: true, name: 'Legal team' });
  const scr = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: screen.path.slice(3) } });
  sockets.push(scr);
  await new Promise((resolve, reject) => { scr.once('connect', resolve); scr.once('connect_error', reject); });
  const told = new Promise((resolve) => { scr.on('display:state', (st) => { if (st.hallName === 'Hall Alpha') resolve(st); }); });
  assert.deepEqual(await emit(ctl, 'room:update', { code: hallA, name: 'Hall Alpha' }), { ok: true, name: 'Hall Alpha' });
  await told;
  assert.deepEqual(rows('room.update'), [[LEGAL, 'name → Legal team', 'pat']]);
  assert.deepEqual(rows('hall.update'), [[hallA, 'name → Hall Alpha', 'ana']]);
  assert.equal((await emit(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hallA).name, 'Hall Alpha');

  // Reset by the admin: the room's messages go, one row.
  assert.ok((await emit(ctl, 'admin:resetRoom', { roomCode: LEGAL })).ok);
  assert.deepEqual(rows('room.reset'), [[LEGAL, 'messages and documents cleared, 0 files removed', 'ana']]);
  assert.deepEqual((await emit(ctl, 'admin:watchRoom', { roomCode: LEGAL })).messages.map((m) => m.text), ['— Messages cleared by the admin —']);

  // The rooms and On stage halls accounts are given (no page gives them yet: written while the server is stopped, as the
  // store keeps them), the admin's account given Legal among them.
  const press = (await make(ctl, hallB, 'Press')).key;
  assert.ok((await emit(ctl, 'admin:settings', { stagewatchUrl: sw.url, stagewatchKey: 'swk_default_node_key_0003' /* secret-scan: fixture */ })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'patb', t: 'patterns', url: node.url, name: 'Patterns B', token: 'node-token', hall: hallB })).ok);
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer(srv.child);
  const accountsFile = path.join(srv.dataDir, 'accounts.json');
  const given = { tom: { rooms: [LEGAL, MEDIA, press], board: [hallB] }, lou: { rooms: [MEDIA] }, ana: { rooms: [LEGAL] } };
  const store = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  for (const u of store.users) Object.assign(u, given[u.username] || {});
  fs.writeFileSync(accountsFile, JSON.stringify(store));
  srv = await startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  const ctl2 = await page(admin);
  const readsBefore = rows('room.read').length;
  // The admin's account given the room reads it as a member: no row. The laptop's token, which lists none, still writes one.
  assert.ok((await emit(await page(admin), 'join', { roomCode: LEGAL, as: 'account' })).ok);
  assert.ok((await emit(ctl2, 'admin:watchRoom', { roomCode: LEGAL })).ok);
  assert.equal(rows('room.read').length, readsBefore);
  assert.equal((await fetch(srv.base + '/api/admin/transcript/' + LEGAL, { headers: { cookie: token } })).status, 200);
  assert.deepEqual(rows('room.read').slice(readsBefore), [[LEGAL, 'transcript of Legal team (Hall Alpha)', 'AGMessage laptop']]);

  // A side room removed alone: the accounts given it are given it no more, counted in its row; nobody else changes.
  const accounts = () => Object.fromEntries(JSON.parse(fs.readFileSync(accountsFile, 'utf8')).users.map((u) => [u.username, { halls: u.halls || [], ...(u.rooms ? { rooms: u.rooms } : {}), ...(u.board ? { board: u.board } : {}) }]));
  assert.ok((await emit(ctl2, 'admin:deleteRoom', { roomCode: MEDIA })).ok);
  assert.deepEqual(rows('room.remove'), [[MEDIA, 'Media (Hall Alpha), 2 accounts updated', 'ana']]);
  await until(() => !JSON.stringify(accounts()).includes(MEDIA), 3000, 'the accounts saved');
  assert.deepEqual([accounts().tom, accounts().lou, accounts().ana], [{ halls: [hallA, hallB], rooms: [LEGAL, press], board: [hallB] }, { halls: [], rooms: [] }, { halls: [], rooms: [LEGAL] }]);

  // A node linked for Hall B proposes to the default Stagewatch's desk while Hall B is here, and to no desk once it is
  // closed: a hall's proposals never reach another hall's show caller.
  await until(() => sw.connected, 8000, 'the default Stagewatch linked');
  await until(async () => { const n = (await emit(ctl2, 'nodes:list', {})).linked.find((x) => x.id === 'patb'); return n && n.status === 'live' && n.desk && n.commands.length; }, 8000, 'the node read, with a desk');
  assert.ok((await emit(ctl2, 'nodes:command', { id: 'patb', line: 'CUE 1', mode: 'propose' })).ok);
  const proposed = sw.proposals.size;
  // Hall B removed: its room, its files and its accounts' keys go with it, its room's own row first, then the hall's
  // naming its room by name and key, each account counted once.
  const hallGone = await emit(ctl2, 'admin:deleteRoom', { roomCode: hallB, purgeFiles: true });
  assert.ok(hallGone.ok, JSON.stringify(hallGone));
  assert.deepEqual(rows('room.remove').slice(1), [[press, 'Press (Hall B), with its hall, 1 account updated', 'ana']]);
  assert.deepEqual(rows('hall.remove'), [[hallB, 'Hall B with 1 other room, files removed, 1 account updated: Press · ' + press, 'ana']]);
  assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'rooms')).filter((f) => f.startsWith(hallB)), [], 'no file of the hall or its room is left');
  await until(() => !JSON.stringify(accounts()).includes(hallB), 3000, 'the accounts saved');
  assert.deepEqual(accounts().tom, { halls: [hallA], rooms: [LEGAL], board: [] });
  assert.deepEqual(await emit(ctl2, 'nodes:command', { id: 'patb', line: 'CUE 2', mode: 'propose' }),
    { ok: false, error: 'Patterns B was linked for a hall that has been closed: link it again for a hall, or for every hall (Admin → Show network) — not proposed.' });
  assert.equal(sw.proposals.size, proposed, 'nothing reached the default Stagewatch\'s desk');
  assert.equal((await emit(ctl2, 'nodes:list', {})).linked.find((x) => x.id === 'patb').desk, false);
  // A hall made since is under no code a room, an account or a node's link still names: the node still proposes to no desk.
  const hallD = await hall('Hall D');
  assert.ok(/^[A-Z2-9]{6}$/.test(hallD) && hallD !== hallB, hallD);
  assert.equal((await emit(ctl2, 'nodes:list', {})).linked.find((x) => x.id === 'patb').desk, false);

  // A hall of 20 rooms removed: each room its own row by its key, then the hall's row naming as many as an audit row holds
  // and counting the rest, never cut part way through a name.
  const cRooms = listed.find((r) => r.code === hallC).side;
  assert.ok((await emit(ctl2, 'admin:deleteRoom', { roomCode: hallC })).ok);
  assert.deepEqual(rows('room.remove').slice(2), cRooms.map((x) => [x.key, x.name + ' (Hall C), with its hall', 'ana']));
  const cRow = rows('hall.remove').find((r) => r[0] === hallC)[1];
  assert.equal(cRow, 'Hall C with 20 other rooms: ' + cRooms.slice(0, 13).map((x) => x.name + ' · ' + x.key).join(', ') + ' and 7 more');
  assert.ok(cRow.length <= 300, cRow.length);

  // The next start loads cleanly: every room left, none said not loaded, the accounts as they were saved.
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  srv = await restartServer(srv);
  assert.doesNotMatch(srv.out(), /Not loaded|Failed to load/, srv.out());
  const health = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  assert.deepEqual([health.rooms, health.sideRooms], [2, 1], 'Hall A and Hall D, and Legal');
  const ctl3 = await page(admin);
  const after = await new Promise((r) => { ctl3.emit('admin:listRooms', r); });
  assert.deepEqual(after.rooms.find((r) => r.code === hallA).side.map((x) => [x.key, x.name]), [[LEGAL, 'Legal team']]);
  assert.deepEqual(accounts().tom, { halls: [hallA], rooms: [LEGAL], board: [] });
});

test('the room choice and the switcher: a page is told its hall and the rooms its person may move between, each by the seat it would take; a code page moves nowhere; a move between rooms of one hall is said in neither, and leaving the hall is said where it was left; a second page in another room, or another person on the same socket, is said as it joins; each page hears its hall\'s rooms again when one is made, renamed or removed, or the hall renamed', async (t) => {
  // A short grace, so "left" is said (or not) within the test; the rule is the same at the shipped 8 s.
  const GRACE = 1500;
  const srv = await startServer({ AGM_LEAVE_GRACE_MS: String(GRACE) });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const PW = 'clipboard and coffee';
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const HALL = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const ctl = await page(admin);
  const asked = async (s, verb, args) => { for (;;) { const r = await emit(s, verb, args); if (!r.busy) return r; await wait(250); } };
  const LEGAL = (await asked(ctl, 'room:create', { hall: HALL, name: 'Legal' })).key;
  const MEDIA = (await asked(ctl, 'room:create', { hall: HALL, name: 'Media' })).key;
  // Tom: Hall A's crew, given Legal. Lou: given Legal alone. Kim: Hall A's, seated On stage there, given Legal. Max: as
  // Tom, for the moves. Ned: Hall A's crew, given both its side rooms.
  for (const [username, role, extra] of [['tom', 'tech', { halls: [HALL], rooms: [LEGAL] }], ['lou', 'staff', { halls: [], rooms: [LEGAL] }], ['kim', 'staff', { halls: [HALL], board: [HALL], rooms: [LEGAL] }], ['max', 'tech', { halls: [HALL], rooms: [LEGAL] }], ['ned', 'tech', { halls: [HALL], rooms: [LEGAL, MEDIA] }]]) {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: PW, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, username + ': ' + JSON.stringify(made.body));
  }
  const signIn = async (username, password = PW) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(srv.base, 'POST', '/api/auth/login', { username, password });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };
  const [tom, lou, kim, max, ned] = [await signIn('tom'), await signIn('lou'), await signIn('kim'), await signIn('max'), await signIn('ned')];
  // The halls page is where an account answers the help of a side room of its hall it is not given (helpFor): a reason to
  // stay there (answersOnBoard), which the halls page reads before it takes an account with one room straight into it.
  // Tom answers Media's from there; Ned is given every side room, Lou sees no hall, Kim sits On stage (her hall's crew
  // answers its help), and the admin reads every room.
  const onBoard = async (cookie) => { const b = (await api(srv.base, 'GET', '/api/halls', undefined, { cookie })).body; return [b.answersOnBoard, Object.keys(b).pop()]; };
  assert.deepStrictEqual(await Promise.all([tom, ned, lou, kim, admin].map(onBoard)), [[true, 'answersOnBoard'], [false, 'answersOnBoard'], [false, 'answersOnBoard'], [false, 'answersOnBoard'], [false, 'answersOnBoard']]);
  const hallOf = (j) => ({ ok: j.ok, hall: j.hall, hallName: j.hallName, rooms: j.rooms });
  const room = (key, name, main, seat) => ({ key, name, main, seat });

  // Each account's page is told its hall and the rooms of it its account may enter, the Main room first, each with the seat
  // the account would join with there: Tom backstage in both; Kim On stage in the Main room and backstage in Legal.
  const tomMain = await page(tom);
  assert.deepStrictEqual(hallOf(await emit(tomMain, 'join', { roomCode: HALL, as: 'account' })),
    { ok: true, hall: HALL, hallName: 'Hall A', rooms: [room(HALL, 'Hall A', true, 'research'), room(LEGAL, 'Legal', false, 'research')] });
  const kimMain = await page(kim);
  const kimIn = await emit(kimMain, 'join', { roomCode: HALL, as: 'account' });
  assert.deepStrictEqual([kimIn.role, hallOf(kimIn)], ['board', { ok: true, hall: HALL, hallName: 'Hall A', rooms: [room(HALL, 'Hall A', true, 'board'), room(LEGAL, 'Legal', false, 'research')] }]);
  // Lou, given Legal alone, is told the hall's name and never its key: its Main room's address, and its code until New code.
  const louSide = await page(lou);
  const louIn = await emit(louSide, 'join', { roomCode: LEGAL, as: 'account' });
  assert.deepStrictEqual(hallOf(louIn), { ok: true, hall: '', hallName: 'Hall A', rooms: [room(LEGAL, 'Legal', false, 'research')] });
  assert.ok(!JSON.stringify(louIn).includes(HALL), 'nothing in Lou\'s answer names the hall\'s key');
  // The admin enters every room, seated backstage in each.
  const anaMain = await page(admin);
  assert.deepStrictEqual(hallOf(await emit(anaMain, 'join', { roomCode: HALL, as: 'account' })),
    { ok: true, hall: HALL, hallName: 'Hall A', rooms: [room(HALL, 'Hall A', true, 'research'), room(LEGAL, 'Legal', false, 'research'), room(MEDIA, 'Media', false, 'research')] });
  // A code guest moves nowhere, and is told the hall's name alone.
  const gus = await page();
  assert.deepStrictEqual(hallOf(await emit(gus, 'join', { roomCode: HALL, name: 'Gus', role: 'research' })), { ok: true, hall: '', hallName: 'Hall A', rooms: [] });

  // Max moves Main → Legal → Main, each a page of its own opened as the last one closes (the server has heard it go, as a
  // page its tab leaves closes its socket: reconnect.js), then Legal on that page's own socket: inside the grace each
  // time, so no room says he joined or left. Leaving the hall (from Legal) is said there.
  const said = (who) => async (key) => (await asked(ctl, 'admin:watchRoom', { roomCode: key })).messages.filter((m) => m.type === 'system' && m.text.startsWith(who + ' ')).map((m) => m.text);
  const lines = said('max');
  const inRoom = async (key, name) => (await asked(ctl, 'admin:watchRoom', { roomCode: key })).users.some((u) => u.name === name);
  const join = async (key) => { const s = await page(max); const j = await emit(s, 'join', { roomCode: key, as: 'account' }); assert.ok(j.ok, JSON.stringify(j)); return s; };
  const gone = async (s, key, name) => { s.close(); await until(async () => !(await inRoom(key, name)), 4000, name + ' gone from ' + key); };
  const first = await join(HALL);
  await gone(first, HALL, 'max');
  const second = await join(LEGAL);
  await gone(second, LEGAL, 'max');
  const third = await join(HALL);
  assert.ok((await emit(third, 'join', { roomCode: LEGAL, as: 'account' })).ok, 'the same page moves on its own socket');
  await wait(GRACE + 800);
  assert.deepStrictEqual([await lines(HALL), await lines(LEGAL)], [['max joined Backstage'], []], 'entering the hall is said once, in the room entered; the moves in neither room');
  third.close();
  await until(async () => (await lines(LEGAL)).length > 0, GRACE + 4000, 'Max\'s leaving said');
  await wait(300);
  assert.deepStrictEqual([await lines(HALL), await lines(LEGAL)], [['max joined Backstage'], ['max left']], 'leaving the hall is said in the room it was left from');

  // A page still open in another room is no move: Tom, in the Main room above, opens Legal on a second page (another
  // device, a tab of its own), and Legal's people are told he joined, and that he left as that page goes; the Main room
  // hears neither.
  const tomLines = said('tom');
  const tomLegal = await page(tom);
  assert.ok((await emit(tomLegal, 'join', { roomCode: LEGAL, as: 'account' })).ok);
  await until(async () => (await tomLines(LEGAL)).length > 0, 4000, 'Tom\'s joining Legal said');
  await gone(tomLegal, LEGAL, 'tom');
  await until(async () => (await tomLines(LEGAL)).length > 1, GRACE + 4000, 'Tom\'s leaving Legal said');
  assert.deepStrictEqual([await tomLines(HALL), await tomLines(LEGAL)], [['tom joined Backstage'], ['tom joined as a Member', 'tom left']]);

  // A page that names another person as it joins another room of the hall on its own socket does not move: a guest seated
  // in the Main room as Alice who joins Legal by its code as Mallory, with no identity (the server issues her one), is two
  // people: Mallory is said to join Legal, and Alice to leave the Main room.
  assert.ok((await asked(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok);
  const legalCode = (await asked(ctl, 'admin:watchRoom', { roomCode: LEGAL })).guestCode;
  const two = await page();
  const alice = await emit(two, 'join', { roomCode: HALL, name: 'Alice', role: 'research' });
  const mallory = await emit(two, 'join', { roomCode: legalCode, name: 'Mallory', role: 'research' });
  assert.ok(alice.ok && mallory.ok && alice.uid !== mallory.uid, JSON.stringify([alice.ok, mallory.ok, alice.uid === mallory.uid]));
  await until(async () => (await said('Alice')(HALL)).length > 1 && (await said('Mallory')(LEGAL)).length > 0, GRACE + 4000, 'Alice\'s leaving and Mallory\'s joining said');
  assert.deepStrictEqual([await said('Alice')(HALL), await said('Mallory')(LEGAL)], [['Alice joined Backstage', 'Alice left'], ['Mallory joined as a Member']]);

  // Each page hears its hall's rooms again, as its join told them: a room made (the admin's switcher gains it; Lou's,
  // given Legal alone, does not), a room renamed, the hall renamed, and a room removed. Lou is never told the hall's key.
  const heard = (s) => { const got = []; s.on('rooms:changed', (f) => got.push(f)); return got; };
  const [anaHeard, louHeard, gusHeard, tomHeard] = [heard(anaMain), heard(louSide), heard(gus), heard(tomMain)];
  const last = (got) => got[got.length - 1];
  const PRESS = (await asked(ctl, 'room:create', { hall: HALL, name: 'Press' })).key;
  await until(() => anaHeard.length > 0 && louHeard.length > 0, 4000, 'the hall\'s pages told its rooms');
  assert.deepStrictEqual(last(anaHeard).rooms.map((r) => r.name), ['Hall A', 'Legal', 'Media', 'Press']);
  assert.deepStrictEqual(last(louHeard), { hall: '', hallName: 'Hall A', rooms: [room(LEGAL, 'Legal', false, 'research')] });
  assert.ok((await asked(ctl, 'room:update', { code: LEGAL, name: 'Lawyers' })).ok);
  await until(() => last(louHeard).rooms[0].name === 'Lawyers', 4000, 'Legal renamed');
  assert.ok((await asked(ctl, 'hall:configure', { code: HALL, name: 'Hall Alpha' })).ok);
  await until(() => last(louHeard).hallName === 'Hall Alpha' && last(gusHeard) && last(gusHeard).hallName === 'Hall Alpha', 4000, 'the hall renamed');
  assert.deepStrictEqual(last(gusHeard), { hall: '', hallName: 'Hall Alpha', rooms: [] });
  assert.deepStrictEqual(last(tomHeard), { hall: HALL, hallName: 'Hall Alpha', rooms: [room(HALL, 'Hall Alpha', true, 'research'), room(LEGAL, 'Lawyers', false, 'research')] });
  assert.ok((await asked(ctl, 'admin:deleteRoom', { roomCode: PRESS })).ok);
  await until(() => last(anaHeard).rooms.length === 3, 4000, 'Press removed');
  assert.deepStrictEqual(last(anaHeard).rooms.map((r) => [r.key, r.name]), [[HALL, 'Hall Alpha'], [LEGAL, 'Lawyers'], [MEDIA, 'Media']]);
  assert.ok(!JSON.stringify(louHeard).includes(HALL), 'no frame to Lou names the hall\'s key');
});
