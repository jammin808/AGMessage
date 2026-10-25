'use strict';
// Halls: the board's pure parts, and end to end — two halls each following its own Stagewatch (countdowns, sends and
// receipts never cross), the halls board for a project manager and a tech, help requests answered from the board and
// from the hall, and a hall's Stagewatch key kept sealed in the server's settings, never in the room's log. Then the rights
// inside a hall: forwarding is posting where it lands, read-only people change nothing, the admin's room list, a rename
// or a lock reaching open pages as one numbered change, and one person on two devices.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const board = require('../lib/board');
const { buildContext } = require('../lib/context');
const { cleanText } = require('../lib/guard');
const { startServer, stopServer, api, connect, emit, wait, until, fakeStagewatch } = require('./helpers');

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

test('rights inside a hall: forwards, read-only members, the room list\'s role select, renames and locks, two devices', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
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
    assert.deepEqual([landed.text, landed.from.name, landed.from.role, landed.from.acct, landed.forwardedFrom.roomCode], ['Revenue was 12m', 'Stu Staff', 'research', true, hallA]);

    // A file needs hall.files in the hall it lands in.
    const up = await png(stuA.j.uploadToken);
    const file = await emit(stuA.s, 'message', { type: 'file', url: up.url, filename: 'plot.png' });
    assert.ok(file.ok, JSON.stringify(file));
    const sueA = await asAccount(sue, hallA);
    await asAccount(sue, hallB);
    assert.equal((await emit(sueA.s, 'forward', { messageId: file.id, targetRoom: hallB })).ok, false, 'no files right in B: no file forwarded into it');
    assert.ok((await emit(sueA.s, 'forward', { messageId: sent.id, targetRoom: hallB })).ok, 'her text still forwards');
    assert.ok((await emit(stuA.s, 'forward', { messageId: file.id, targetRoom: hallB })).ok, 'his file does');
    await wait(300);
    assert.deepEqual(inB.map(([, m]) => [m.type, m.from.name]), [['text', 'Stu Staff'], ['text', 'Sue Staff'], ['file', 'Stu Staff']], 'nothing refused reached B');
    assert.deepEqual(inC, [], 'nothing reached the locked hall');
    assert.deepEqual(inD.map(([, m]) => [m.text, m.from.name, m.from.role]), [['Backstage only: the CEO is late', 'Gus Guest', 'research']]);
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

  await t.test('read-only people (an observer guest, a Viewer account) cannot pin, react, answer a prompt or type', async () => {
    const crew = await guest(hallD, 'Rae Research', 'research');
    const prompt = await emit(crew.s, 'message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] });
    const note = await emit(crew.s, 'message', { type: 'text', text: 'Agenda item 4' });
    assert.ok(prompt.ok && note.ok);
    assert.ok((await emit(crew.s, 'pin', { messageId: note.id, pinned: true })).ok, 'crew may pin');
    const seen = heard(crew.s, 'pinUpdate', 'messageReact', 'actionUpdate', 'typing');
    const gallery = await guest(hallD, 'Gallery guest', 'observer');
    const viewer = await asAccount(vic, hallD);
    assert.deepEqual([gallery.j.role, viewer.j.role], ['observer', 'observer']);
    const results = {};
    for (const [who, s] of [['guest', gallery.s], ['viewer', viewer.s]]) {
      results[who + ' unpin'] = (await emit(s, 'pin', { messageId: note.id, pinned: false })).ok;
      results[who + ' react'] = (await emit(s, 'react', { messageId: note.id, emoji: '👍' })).ok;
      results[who + ' answer'] = (await emit(s, 'actionResponse', { messageId: prompt.id, optionIndex: 1 })).ok;
      results[who + ' reply with text'] = (await emit(s, 'actionResponse', { messageId: prompt.id, optionIndex: -1, note: 'from the gallery' })).ok;
      s.emit('typing', { isTyping: true });
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
    await until(() => lines.some(([, m]) => /Kim role changed from research to observer/.test(m.text)), 3000, 'the guest\'s change recorded');
    assert.ok(!lines.some(([, m]) => /Ted Tech role changed/.test(m.text)), 'the refused one is not');
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
    assert.deepEqual(said, ['Ted Tech joined as research'], 'one joined line, no left line');
    // The laptop moves to another hall: now he has gone from this one, said at once.
    assert.ok((await emit(laptopG.s, 'join', { roomCode: hallB, as: 'account' })).ok);
    await until(() => lines.some(([, x]) => x.text === 'Ted Tech left'), 3000, 'Ted Tech left');
    assert.deepEqual(await people(), { api: 1, board: 1 });
  });
});
