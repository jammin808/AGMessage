'use strict';
// Halls: the board's pure parts, and end to end — two halls each following its own Stagewatch (countdowns, sends and
// receipts never cross), the halls board for a project manager and a tech, help requests answered from the board and
// from the hall, and a hall's Stagewatch key kept sealed in the server's settings, never in the room's log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const board = require('../lib/board');
const { buildContext } = require('../lib/context');
const { cleanText } = require('../lib/guard');
const { startServer, stopServer, api, connect, emit, wait, until, fakeStagewatch } = require('./helpers');

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
});

test('halls end to end: two Stagewatches, the board, help', async (t) => {
  const swA = await fakeStagewatch({ name: 'Hall A timer', messageId: 12 });
  const swB = await fakeStagewatch({ name: 'Hall B timer', messageId: 12 });   // the same message id: they must not cross
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await swA.close(); await swB.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
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
    assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: swA.url, stagewatchKey: 'swk_hallA_node_key_0001' })).ok);
    assert.ok((await emit(ctl, 'hall:configure', { code: hallB, stagewatchUrl: swB.url, stagewatchKey: 'swk_hallB_node_key_0002', name: 'Hall B (Auditorium)' })).ok);
    await until(() => swA.connected && swB.connected, 6000, 'both Stagewatches linked');
    const s = await emit(ctl, 'hall:settings', { code: hallA });
    assert.equal(s.stagewatch.keySet, true);
    assert.equal(s.stagewatch.url, 'http://' + swA.url);
    await wait(300);   // the settings lane writes within 100 ms
    const settingsFile = fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8');
    assert.ok(!settingsFile.includes('swk_hallA_node_key_0001'), 'no clear key on disk');
    assert.match(settingsFile, /hallStagewatch/);
    for (const f of fs.readdirSync(path.join(srv.dataDir, 'rooms'))) {
      assert.ok(!/swk_|enc1:/.test(fs.readFileSync(path.join(srv.dataDir, 'rooms', f), 'utf8')), 'nothing of the key in a room file: ' + f);
    }
    const authA = swA.requests.find((r) => r.headers.authorization);
    assert.equal(authA.headers.authorization, 'Bearer swk_hallA_node_key_0001', 'each hall\'s key goes to its own Stagewatch');
    assert.ok(!swA.requests.some((r) => r.headers.authorization === 'Bearer swk_hallB_node_key_0002'));
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
