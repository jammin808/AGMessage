'use strict';
// What an On stage seat may do, end to end, on a real server: it chats, replies, answers questions and asks for help; it
// shares no file, asks no question and sends nothing into another room, and the server refuses each by the seat,
// whatever the page sends, for the admin seated On stage too. The seat's limit itself is pure (rbac.seatAllows, in
// test/accounts.test.js).
const test = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, api, connect, emit, answer, until, TOKEN } = require('./helpers');

const STAYS = 'Messages from On stage stay in this room.';
const BACKSTAGE = 'Do that from a backstage page.';
const NO_FILES = 'On stage seats send messages, not files.';
const NO_ASKING = 'Questions for the Board come from the backstage team.';
const FILES_BACKSTAGE = 'Files are moved by the backstage team.';

test('an On stage seat chats, answers and asks for help; it shares no file, asks no question and forwards nothing', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };

  const admin = (await api(base, 'POST', '/api/setup', { username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB, hallC, hallD] = [await hall('Hall A'), await hall('Hall B'), await hall('Hall C'), await hall('Hall D')];
  const ctl = await open(admin);
  const guest = async (code, name, role, extra = {}) => { const s = await open(); const j = await emit(s, 'join', { roomCode: code, name, role, ...extra }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });   // an event whose ack is its only argument
  const messagesOf = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).messages;
  // A hall's newest number, read by a page already seated there joining again on its own socket (not announced).
  const seqOf = async (l) => (await emit(l.s, 'join', { roomCode: l.j.roomCode, name: l.j.name, role: l.j.role, uid: l.j.identity })).seq;
  const upload = async (token, name = 'plot.png') => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' }), name);
    const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, body: await r.json() };
  };

  // Ana is backstage in A: she writes, shares a file and asks the Board a question. Bea is On stage in A and backstage
  // in B (one identity, two pages), so a forward from A into B would be taken but for the seat it comes from.
  const ana = await guest(hallA, 'Ana', 'research');
  const said = await emit(ana.s, 'message', { type: 'text', text: 'Capex is on slide 14' });
  const up = await upload(ana.j.uploadToken);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const file = await emit(ana.s, 'message', { type: 'file', url: up.body.url, filename: 'plot.png' });
  const question = await emit(ana.s, 'message', { type: 'action', text: 'Take questions now?', options: ['Yes', 'No'] });
  assert.ok(said.ok && file.ok && question.ok);
  const bea = await guest(hallA, 'Bea', 'board');
  const beaB = await guest(hallB, 'Bea', 'research', { uid: bea.j.identity });
  assert.equal(beaB.j.uid, bea.j.uid);
  const lis = await guest(hallB, 'Lis', 'observer');

  await t.test('an On stage seat is given no upload token, and posts no file and no question', async () => {
    assert.deepEqual([bea.j.role, bea.j.uploadToken, typeof ana.j.uploadToken], ['board', null, 'string']);
    const before = (await messagesOf(hallA)).length;
    assert.deepEqual(await emit(bea.s, 'message', { type: 'file', url: up.body.url, filename: 'plot.png' }), { ok: false, error: NO_FILES }, 'a backstage upload, named On stage');
    assert.deepEqual(await emit(bea.s, 'message', { type: 'action', text: 'Shall we break?', options: ['Yes', 'No'] }), { ok: false, error: NO_ASKING });
    assert.equal((await messagesOf(hallA)).length, before, 'nothing posted');
  });

  await t.test('it sends a text, a reply, 🔥 Priority and a help request, reacts 👍 and answers a question in words, each stored', async () => {
    const reply = await emit(bea.s, 'message', { type: 'text', text: 'Thank you', replyTo: said.id });
    const loud = await emit(bea.s, 'message', { type: 'text', text: 'Two minutes please', priority: true });
    const help = await emit(bea.s, 'message', { type: 'help', category: 'Sound', text: 'My microphone is off' });
    assert.ok(reply.ok && loud.ok && help.ok, JSON.stringify([reply, loud, help]));
    assert.deepEqual(await emit(bea.s, 'react', { messageId: said.id, emoji: '👍' }), { ok: true });
    const note = 'n'.repeat(201);
    assert.deepEqual(await emit(bea.s, 'actionResponse', { messageId: question.id, note }), { ok: true });
    const byId = new Map((await messagesOf(hallA)).map((m) => [m.id, m]));
    assert.deepEqual([byId.get(reply.id).replyTo.id, byId.get(reply.id).from.role], [said.id, 'board']);
    assert.equal(byId.get(loud.id).priority, true, 'a Board member sends 🔥 Priority');
    assert.deepEqual([byId.get(help.id).type, byId.get(help.id).help.state], ['help', 'open']);
    assert.ok(byId.get(said.id).reactions.some((r) => r.uid === bea.j.uid && r.emoji === '👍'));
    const answered = byId.get(question.id).responses.find((r) => r.uid === bea.j.uid);
    assert.deepEqual([answered.role, answered.note.length], ['board', 200]);
  });

  await t.test('it forwards nothing into another room, text, file or question, and is offered no room to forward into', async () => {
    const seq = await seqOf(lis);
    for (const m of [said, file, question]) {
      assert.deepEqual(await emit(bea.s, 'forward', { messageId: m.id, targetRoom: hallB }), { ok: false, error: STAYS }, 'refused, whatever it carries');
    }
    assert.equal(await seqOf(lis), seq, 'hall B took nothing');
    for (const m of [said, file]) assert.deepEqual(await answer(bea.s, 'myRooms', { messageId: m.id }), { ok: true, rooms: [] });
    assert.deepEqual(await ask(bea.s, 'myRooms'), { ok: true, rooms: [] });
    // Her backstage page in B is not limited: the seat is the page's.
    assert.deepEqual((await answer(beaB.s, 'myRooms', {})).rooms.map((r) => r.code), [hallA]);
  });

  await t.test('screens, a hall\'s set-up, the show network and drafts are not driven from an On stage page', async () => {
    assert.deepEqual(await emit(bea.s, 'display:list', { code: hallA }), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(bea.s, 'hall:settings', { code: hallA }), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(bea.s, 'nodes:list', {}), { ok: false, error: BACKSTAGE }, 'refused, never an empty list');
    assert.deepEqual(await emit(bea.s, 'nodes:command', { id: 'pat', line: 'GO', mode: 'propose' }), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(bea.s, 'ai:draft', {}), { ok: false, error: 'Drafting is for the backstage team.' });
    // Every other screen and set-up verb answers in the same sentence first, whatever it carries.
    const verbs = [['display:take', { id: 'x', content: { kind: 'clear' } }], ['display:create', { code: hallA, name: 'Lectern' }],
      ['display:update', { id: 'x', name: 'Foyer' }], ['display:identify', { id: 'x' }], ['display:rotate', { id: 'x' }], ['display:remove', { id: 'x' }],
      ['display:hallHolding', { code: hallA, image: '' }], ['hall:configure', { code: hallA, name: 'Renamed' }], ['hall:acceptCertificate', { code: hallA }]];
    for (const [verb, args] of verbs) assert.deepEqual(await emit(bea.s, verb, args), { ok: false, error: BACKSTAGE }, verb);
  });

  await t.test('a file or a question goes only where its forwarder sits backstage: never into a room where the same person sits On stage', async () => {
    const cal = await guest(hallA, 'Cal', 'research');
    const calB = await guest(hallB, 'Cal', 'board', { uid: cal.j.identity });
    assert.equal(calB.j.role, 'board');
    const seq = await seqOf(lis);
    assert.deepEqual(await emit(cal.s, 'forward', { messageId: question.id, targetRoom: hallB }), { ok: false, error: NO_ASKING });
    assert.deepEqual(await emit(cal.s, 'forward', { messageId: file.id, targetRoom: hallB }), { ok: false, error: 'You may not share files in that hall.' });
    assert.equal(await seqOf(lis), seq, 'hall B took no question and no file');
    // The picker offers no room that would refuse either, and says the question's rule in the forward's words.
    assert.deepEqual(await answer(cal.s, 'myRooms', { messageId: question.id }), { ok: true, rooms: [], why: NO_ASKING });
    assert.deepEqual(await answer(cal.s, 'myRooms', { messageId: file.id }), { ok: true, rooms: [] });
    assert.deepEqual((await answer(cal.s, 'myRooms', { messageId: said.id })).rooms.map((r) => r.code), [hallB], 'a text may still go');
  });

  await t.test('a person seated On stage and backstage in one room forwards into it as backstage, whichever page joined first', async () => {
    const dan = await guest(hallA, 'Dan', 'research');
    await guest(hallD, 'Dan', 'board', { uid: dan.j.identity });
    await guest(hallD, 'Dan', 'research', { uid: dan.j.identity });
    const fwd = await emit(dan.s, 'forward', { messageId: question.id, targetRoom: hallD });
    assert.ok(fwd.ok, JSON.stringify(fwd));
    const landed = (await messagesOf(hallD)).find((m) => m.id === fwd.id);
    assert.deepEqual([landed.type, landed.from.name, landed.from.role], ['action', 'Dan', 'research']);
  });

  await t.test('the admin\'s link: a backstage guest still forwards a file through it; an On stage guest forwards nothing, text included', async () => {
    const eve = await guest(hallA, 'Eve', 'research');
    const own = await upload(eve.j.uploadToken, 'run.png');
    const posted = await emit(eve.s, 'message', { type: 'file', url: own.body.url, filename: 'run.png' });
    assert.ok(posted.ok, JSON.stringify(posted));
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: eve.s.id, targetRoom: hallC })).ok);
    const fwd = await emit(eve.s, 'forward', { messageId: posted.id, targetRoom: hallC });
    assert.ok(fwd.ok, JSON.stringify(fwd));
    const landed = (await messagesOf(hallC)).find((m) => m.id === fwd.id);
    assert.deepEqual([landed.type, landed.filename, landed.from.role], ['file', 'run.png', 'research']);

    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: bea.s.id, targetRoom: hallC })).ok);
    const inC = (await messagesOf(hallC)).length;
    assert.deepEqual(await emit(bea.s, 'forward', { messageId: said.id, targetRoom: hallC }), { ok: false, error: STAYS });
    assert.equal((await messagesOf(hallC)).length, inC);
    assert.deepEqual(await ask(bea.s, 'myRooms'), { ok: true, rooms: [] }, 'the link is offered nowhere On stage');
  });

  await t.test('a file moves only from a seat that may share files where it is', async () => {
    // Gil reads hall A only (seated as an observer) and sits backstage in B: A's files stay in A.
    const gil = await guest(hallA, 'Gil', 'observer');
    await guest(hallB, 'Gil', 'research', { uid: gil.j.identity });
    const seq = await seqOf(lis);
    assert.deepEqual(await emit(gil.s, 'forward', { messageId: file.id, targetRoom: hallB }), { ok: false, error: FILES_BACKSTAGE });
    assert.equal(await seqOf(lis), seq);
    assert.deepEqual(await answer(gil.s, 'myRooms', { messageId: file.id }), { ok: true, rooms: [], why: FILES_BACKSTAGE }, 'the picker says the rule, not "open another hall"');
    assert.deepEqual((await answer(gil.s, 'myRooms', { messageId: said.id })).rooms.map((r) => r.code), [hallB], 'a text from the hall he reads may go');
  });

  await t.test('an upload token is checked again at use: a seat moved On stage or to observer uploads nothing more with it', async () => {
    const fay = await guest(hallA, 'Fay', 'research');
    const gus = await guest(hallA, 'Gus', 'research');
    const hal = await guest(hallA, 'Hal', 'research');
    assert.ok(fay.j.uploadToken && gus.j.uploadToken && hal.j.uploadToken);
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallA, socketId: fay.s.id, role: 'board' })).ok);
    assert.deepEqual(await upload(fay.j.uploadToken), { status: 403, body: { error: NO_FILES } });
    assert.deepEqual(await upload(fay.j.uploadToken), { status: 403, body: { error: 'Join a room to share files.' } }, 'and the token is gone');
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallA, socketId: gus.s.id, role: 'observer' })).ok);
    assert.deepEqual(await upload(gus.j.uploadToken), { status: 403, body: { error: 'Observers can read but not post.' } });
    assert.equal((await upload(ana.j.uploadToken)).status, 200, 'a backstage token still uploads');
    // The move ends the token in its own tick: moved On stage and back before it is used, it never uploads again, and
    // the page's join after its reload takes a new one.
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallA, socketId: hal.s.id, role: 'board' })).ok);
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: hallA, socketId: hal.s.id, role: 'research' })).ok);
    assert.deepEqual(await upload(hal.j.uploadToken), { status: 403, body: { error: 'Join a room to share files.' } });
    const again = await emit(hal.s, 'join', { roomCode: hallA, name: 'Hal', role: 'research', uid: hal.j.identity });
    assert.ok(again.uploadToken && again.uploadToken !== hal.j.uploadToken);
    assert.equal((await upload(again.uploadToken)).status, 200, 'the new seat\'s own token uploads');
    // The moved page is held to its new seat on every verb, not only the upload.
    assert.deepEqual(await emit(fay.s, 'forward', { messageId: said.id, targetRoom: hallB }), { ok: false, error: STAYS });
  });

  await t.test('the admin seated On stage is held to the seat on that page; its admin verbs and its unseated pages are not', async () => {
    const token = (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
    const host = await open(token);
    const hj = await emit(host, 'join', { roomCode: hallA, name: 'Host', role: 'board' });
    assert.deepEqual([hj.ok, hj.role, hj.uploadToken, hj.canSendToStage, hj.canPropose], [true, 'board', null, false, false]);
    assert.deepEqual(await emit(host, 'message', { type: 'file', url: up.body.url, filename: 'plot.png' }), { ok: false, error: NO_FILES });
    assert.deepEqual(await emit(host, 'message', { type: 'action', text: 'Vote now?', options: ['Yes'] }), { ok: false, error: NO_ASKING });
    assert.deepEqual(await emit(host, 'forward', { messageId: said.id, targetRoom: hallB }), { ok: false, error: STAYS });
    assert.deepEqual(await emit(host, 'display:list', { code: hallA }), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(host, 'hall:settings', { code: hallA }), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(host, 'nodes:list', {}), { ok: false, error: BACKSTAGE });
    assert.deepEqual(await emit(host, 'stage:send', { text: 'From the Board' }), { ok: false, error: 'The speaker\'s screen is for the backstage team.' });
    assert.deepEqual(await emit(host, 'ai:draft', {}), { ok: false, error: 'Drafting is for the backstage team.' });
    assert.ok((await emit(host, 'message', { type: 'text', text: 'The admin, On stage' })).ok, 'it still chats');
    // Every admin verb answers in its own words, as it does from any page of the admin's.
    assert.deepEqual(await emit(host, 'admin:setRole', { roomCode: hallA, socketId: 'nobody', role: 'wizard' }), { ok: false, error: 'Invalid role' });
    assert.equal((await emit(host, 'admin:watchRoom', { roomCode: hallA })).ok, true);
    assert.deepEqual(await emit(host, 'nodes:link', { id: 'not a node id' }), { ok: false, error: 'A node id is the one its hello announces.' });
    // The same token's page in no room is unseated: it drives the hall's screens.
    const desk = await open(token);
    const listed = await emit(desk, 'display:list', { code: hallA });
    assert.deepEqual([listed.ok, listed.code], [true, hallA]);
    await until(async () => (await emit(desk, 'nodes:list', {})).ok, 3000, 'the show network listed off stage');
  });
});
