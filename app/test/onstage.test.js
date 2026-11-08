'use strict';
// What an On stage seat may do, end to end, on a real server: it chats, replies, answers questions and asks for help; it
// shares no file, asks no question and sends nothing into another room, and the server refuses each by the seat,
// whatever the page sends, for the admin seated On stage too, and for an account its On stage halls seat there (a Board
// account), on that page alone. The seat's limit itself is pure (rbac.seatAllows, in test/accounts.test.js).
const test = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, api, connect, emit, answer, until, wait, fakeStagewatch, pngOf, inviteOf, TOKEN, setupAdmin } = require('./helpers');

const STAYS = 'Messages from On stage stay in this room.';
const BACKSTAGE = 'Do that from a backstage page.';
const NO_FILES = 'On stage seats send messages, not files.';
const NO_ASKING = 'Questions for the Board come from the backstage team.';
const FILES_BACKSTAGE = 'Files are moved by the backstage team.';
const HELP_BACKSTAGE = 'Help requests are answered by the backstage team.';

test('an On stage seat chats, answers and asks for help; it shares no file, asks no question and forwards nothing', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };

  const admin = (await setupAdmin(base, { username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB, hallC, hallD] = [await hall('Hall A'), await hall('Hall B'), await hall('Hall C'), await hall('Hall D')];
  const ctl = await open(admin);
  // On stage with the link the admin sent (an open hall's code seats nobody there).
  const guest = async (code, name, role, extra = {}) => { const s = await open(); const j = await emit(s, 'join', { roomCode: code, name, role, ...(role === 'board' ? { invite: inviteOf(srv.dataDir, code) } : {}), ...extra }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });   // an event whose ack is its only argument
  const messagesOf = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).messages;
  // A hall's newest number, read by a page already seated there joining again on its own socket (not announced).
  const seqOf = async (l) => (await emit(l.s, 'join', { roomCode: l.j.roomCode, name: l.j.name, role: l.j.role, uid: l.j.identity })).seq;
  const upload = async (token, name = 'plot.png') => {
    const f = new FormData();
    f.append('file', new Blob([pngOf()], { type: 'image/png' }), name);
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

  await t.test('an On stage seat answers only its own help request: it marks it resolved, and no one else\'s, whatever hall it names', async () => {
    const helpOf = async (code, id) => { const h = (await messagesOf(code)).find((m) => m.id === id).help; return [h.state, h.by]; };
    // Ana asks in A and Kim in B, where Bea sits backstage on her other page. Bea's On stage page answers neither, On my
    // way or Resolved, with no code, with A's, or with B's.
    const anaAsks = await emit(ana.s, 'message', { type: 'help', category: 'Vision', text: 'Screen 2 is dark' });
    const kim = await guest(hallB, 'Kim', 'research');
    const kimAsks = await emit(kim.s, 'message', { type: 'help', category: 'Sound', text: 'Radio mic 3 has no signal' });
    assert.ok(anaAsks.ok && kimAsks.ok);
    const [seqA, seqB] = [await seqOf(ana), await seqOf(lis)];
    for (const state of ['coming', 'resolved']) {
      assert.deepEqual(await emit(bea.s, 'help:respond', { messageId: anaAsks.id, state }), { ok: false, error: HELP_BACKSTAGE }, state + ' in its own hall');
      assert.deepEqual(await emit(bea.s, 'help:respond', { code: hallA, messageId: anaAsks.id, state }), { ok: false, error: HELP_BACKSTAGE }, state + ', naming its own hall');
      assert.deepEqual(await emit(bea.s, 'help:respond', { code: hallB, messageId: kimAsks.id, state }), { ok: false, error: HELP_BACKSTAGE }, state + ', naming a hall where the same person sits backstage');
    }
    assert.deepEqual([await helpOf(hallA, anaAsks.id), await helpOf(hallB, kimAsks.id)], [['open', ''], ['open', '']], 'neither request moved');
    assert.deepEqual([await seqOf(ana), await seqOf(lis)], [seqA, seqB], 'and neither hall took a change');

    // The admin seated On stage is held to it on that page; the same token's page in no hall answers from the board.
    const token = (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
    const host = await open(token);
    assert.equal((await emit(host, 'join', { roomCode: hallA, name: 'Stage Host', role: 'board' })).role, 'board');
    const [hostSeqA, hostSeqB] = [await seqOf(ana), await seqOf(lis)];
    assert.deepEqual(await emit(host, 'help:respond', { messageId: anaAsks.id, state: 'coming' }), { ok: false, error: HELP_BACKSTAGE });
    assert.deepEqual(await emit(host, 'help:respond', { code: hallB, messageId: kimAsks.id, state: 'resolved' }), { ok: false, error: HELP_BACKSTAGE });
    assert.deepEqual([await helpOf(hallA, anaAsks.id), await helpOf(hallB, kimAsks.id)], [['open', ''], ['open', '']], 'the admin On stage moved neither request');
    assert.deepEqual([await seqOf(ana), await seqOf(lis)], [hostSeqA, hostSeqB], 'and neither hall took a change from it');
    const desk = await open(token);
    assert.deepEqual(await emit(desk, 'help:respond', { code: hallB, messageId: kimAsks.id, state: 'coming' }), { ok: true });
    assert.deepEqual(await helpOf(hallB, kimAsks.id), ['coming', 'Admin']);

    // A backstage guest still answers both, on Ana's request and on the Board's own.
    const jo = await guest(hallA, 'Jo', 'research');
    assert.deepEqual(await emit(jo.s, 'help:respond', { messageId: anaAsks.id, state: 'coming' }), { ok: true });
    assert.deepEqual(await helpOf(hallA, anaAsks.id), ['coming', 'Jo']);
    assert.deepEqual(await emit(jo.s, 'help:respond', { messageId: anaAsks.id, state: 'resolved' }), { ok: true });
    assert.deepEqual(await helpOf(hallA, anaAsks.id), ['resolved', 'Jo']);

    // Bea's own request: On my way is not hers to say, even on her own; Resolved is, and said again it is done already.
    const beaAsks = await emit(bea.s, 'message', { type: 'help', category: 'Presenter', text: 'Need water at the lectern' });
    assert.ok(beaAsks.ok);
    assert.deepEqual(await emit(bea.s, 'help:respond', { messageId: beaAsks.id, state: 'coming' }), { ok: false, error: HELP_BACKSTAGE }, 'not On my way, even on her own');
    assert.deepEqual(await helpOf(hallA, beaAsks.id), ['open', '']);
    assert.deepEqual(await emit(jo.s, 'help:respond', { messageId: beaAsks.id, state: 'coming' }), { ok: true });
    assert.deepEqual(await emit(bea.s, 'help:respond', { code: hallA, messageId: beaAsks.id, state: 'resolved' }), { ok: true });
    assert.deepEqual(await helpOf(hallA, beaAsks.id), ['resolved', 'Bea']);
    assert.deepEqual(await emit(bea.s, 'help:respond', { messageId: beaAsks.id, state: 'resolved' }), { ok: true, already: true });
    // Her own request in B is her B page's to mark: from the On stage page it is refused as any page outside B is.
    const beaAsksB = await emit(beaB.s, 'message', { type: 'help', category: 'Sound', text: 'Feedback on the lectern mic' });
    assert.ok(beaAsksB.ok);
    assert.deepEqual(await emit(bea.s, 'help:respond', { code: hallB, messageId: beaAsksB.id, state: 'resolved' }), { ok: false, error: 'Only people in that hall can answer its help requests.' });
    assert.deepEqual(await helpOf(hallB, beaAsksB.id), ['open', '']);
    assert.deepEqual(await emit(beaB.s, 'help:respond', { messageId: beaAsksB.id, state: 'coming' }), { ok: true }, 'backstage, she answers');
  });
});

test('a Board account is held to the On stage seat on its On stage page alone: it chats and sends 🔥, shares no file, sends nothing to the stage, drives no screen or node and forwards nothing; from its other pages it is the crew it is, and it answers no help request of the hall where it sits On stage, from any page, but its own Resolved', async (t) => {
  const sw = await fakeStagewatch({ name: 'Hall 2 timer' });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };
  const PW = 'clipboard and coffee';
  const admin = (await setupAdmin(base, { username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hall2, hall3] = [await hall('Hall 2'), await hall('Hall 3')];
  const ctl = await open(admin);
  const asked = async (s, verb, args) => { for (;;) { const r = await emit(s, verb, args); if (!(r && r.busy)) return r; await wait(250); } };
  const LEGAL = (await asked(ctl, 'room:create', { hall: hall2, name: 'Legal' })).key;
  const MEDIA = (await asked(ctl, 'room:create', { hall: hall2, name: 'Media' })).key;
  // Hall 2's own Stagewatch, with a show desk: the speaker's screen is there for every seat whose rights allow it.
  assert.ok((await emit(ctl, 'hall:configure', { code: hall2, stagewatchUrl: sw.url, stagewatchKey: 'swk_board_account_key_01' })).ok);   // secret-scan: fixture
  const guest = async (code, name, role) => { const s = await open(); const j = await emit(s, 'join', { roomCode: code, name, role, ...(role === 'board' ? { invite: inviteOf(srv.dataDir, code) } : {}) }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const ana = await guest(hall2, 'Ana', 'research');
  await until(async () => { const r = await emit(ana.s, 'stage:targets', {}); return r.canSend && r.canPropose; }, 8000, 'Hall 2\'s link and its desk');
  // Kim, a Tech of Hall 2 and Hall 3 who drives the show network, is given Hall 2's On stage seat and its Legal room; Ada,
  // an admin, Hall 2's On stage seat.
  const made = {};
  for (const [username, extra] of [['kim', { role: 'tech', halls: [hall2, hall3], grant: ['nodes.control'], board: [hall2], rooms: [LEGAL] }], ['ada', { role: 'admin', board: [hall2] }]]) {
    const r = await api(base, 'POST', '/api/users', { username, name: username === 'kim' ? 'Kim' : 'Ada', password: PW, ...extra }, { cookie: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    made[username] = r.body.user;
  }
  const kim = (await api(base, 'POST', '/api/auth/login', { username: 'kim', password: PW })).cookie;
  const ada = (await api(base, 'POST', '/api/auth/login', { username: 'ada', password: PW })).cookie;
  const page = async (cookie, code) => { const s = await open(cookie); const j = await emit(s, 'join', { roomCode: code, as: 'account' }); assert.ok(j.ok, JSON.stringify(j)); return { s, j }; };
  const messagesOf = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).messages;
  const seqOf = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).seq;
  const upload = async (token, name) => {
    const f = new FormData();
    f.append('file', new Blob([pngOf()], { type: 'image/png' }), name);
    const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, body: await r.json() };
  };

  // On stage in Hall 2: no upload token, the speaker's screen and the show desk not offered though the link is up and the
  // account holds stage.send there, and no guest code.
  const onStage = await page(kim, hall2);
  assert.deepEqual([onStage.j.role, onStage.j.uploadToken, onStage.j.canSendToStage, onStage.j.canPropose, onStage.j.guestCode, onStage.j.forwardable], ['board', null, false, false, '', false]);
  // Backstage in Legal, the same account sends to its hall's Stagewatch and shares files: the limit is the page's.
  const inLegal = await page(kim, LEGAL);
  assert.deepEqual([inLegal.j.role, typeof inLegal.j.uploadToken, inLegal.j.canSendToStage, inLegal.j.canPropose], ['research', 'string', true, true]);

  // The speaker's screen, screens and the show network, from the On stage page: refused in the table's words; from Legal,
  // each answers.
  assert.deepEqual(await emit(onStage.s, 'stage:send', { text: 'From the Board' }), { ok: false, error: 'The speaker\'s screen is for the backstage team.' });
  assert.deepEqual(await emit(onStage.s, 'stage:propose', { text: 'From the Board', destination: 'speaker' }), { ok: false, error: 'Proposing to the stage is for the backstage team.' });
  assert.deepEqual(await emit(onStage.s, 'display:list', { code: hall2 }), { ok: false, error: BACKSTAGE });
  assert.deepEqual(await emit(onStage.s, 'nodes:list', {}), { ok: false, error: BACKSTAGE }, 'refused, never an empty list');
  assert.deepEqual(await emit(onStage.s, 'nodes:command', { id: 'pat', line: 'GO', mode: 'propose' }), { ok: false, error: BACKSTAGE });
  const listed = await emit(inLegal.s, 'display:list', { code: hall2 });
  assert.deepEqual([listed.ok, listed.code], [true, hall2]);
  assert.equal((await emit(inLegal.s, 'nodes:list', {})).ok, true);
  assert.deepEqual(await emit(inLegal.s, 'nodes:command', { id: 'pat', line: 'GO', mode: 'propose' }), { ok: false, error: 'No such link, or not yours to drive.' }, 'past the seat, to the link\'s own check');

  // It chats and sends 🔥 from the On stage page; it posts no file there, and forwards nothing out of Hall 2, text included.
  const loud = await emit(onStage.s, 'message', { type: 'text', text: 'Two minutes please', priority: true });
  assert.ok(loud.ok, JSON.stringify(loud));
  const stored = (await messagesOf(hall2)).find((m) => m.id === loud.id);
  assert.deepEqual([stored.priority, stored.from.role], [true, 'board']);
  const crewIn3 = await page(kim, hall3);
  assert.equal(crewIn3.j.role, 'research');
  const seq3 = await seqOf(hall3);
  assert.deepEqual(await emit(onStage.s, 'forward', { messageId: loud.id, targetRoom: hall3 }), { ok: false, error: STAYS });
  assert.equal(await seqOf(hall3), seq3, 'Hall 3 took nothing');
  // From Hall 3, where it sits backstage, a file goes nowhere it would sit On stage: refused for Hall 2, and the picker
  // offers Hall 2 for a text alone.
  const shared = await upload(crewIn3.j.uploadToken, 'cue-sheet.png');
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const fileIn3 = await emit(crewIn3.s, 'message', { type: 'file', url: shared.body.url, filename: 'cue-sheet.png' });
  assert.ok(fileIn3.ok);
  const seq2 = await seqOf(hall2);
  assert.deepEqual(await emit(crewIn3.s, 'forward', { messageId: fileIn3.id, targetRoom: hall2 }), { ok: false, error: 'You may not share files in that hall.' });
  assert.equal(await seqOf(hall2), seq2, 'Hall 2 took no file');
  assert.deepEqual(await emit(onStage.s, 'message', { type: 'file', url: shared.body.url, filename: 'cue-sheet.png' }), { ok: false, error: NO_FILES });
  const textIn3 = await emit(crewIn3.s, 'message', { type: 'text', text: 'Cue 4 moved' });
  assert.deepEqual((await answer(crewIn3.s, 'myRooms', { messageId: fileIn3.id })).rooms.map((r) => r.code).includes(hall2), false);
  assert.deepEqual((await answer(crewIn3.s, 'myRooms', { messageId: textIn3.id })).rooms.map((r) => r.code).includes(hall2), true);

  // An admin given Hall 2's On stage seat: held to it on that page alike, handed no code.
  const adaOn = await page(ada, hall2);
  assert.deepEqual([adaOn.j.role, adaOn.j.uploadToken, adaOn.j.guestCode, adaOn.j.setsCode], ['board', null, '', false]);
  assert.deepEqual(await emit(adaOn.s, 'message', { type: 'file', url: shared.body.url, filename: 'cue-sheet.png' }), { ok: false, error: NO_FILES });

  // Help (owner answer B1). Requests: Ana's and Bea's (a Board guest's) in Hall 2's Main room, the admin's in Media (a room
  // of Hall 2 Kim is not given) and in Legal (Kim's), Cy's in Hall 3, and Kim's own in Hall 2.
  const bea = await guest(hall2, 'Bea', 'board');
  const cy = await guest(hall3, 'Cy', 'research');
  const anaMedia = await page(admin, MEDIA);
  const anaLegal = await page(admin, LEGAL);
  const ask = async (s, text) => { const r = await emit(s, 'message', { type: 'help', category: 'Sound', text }); assert.ok(r.ok, JSON.stringify(r)); return r.id; };
  const req = { ana: await ask(ana.s, 'Mic 2 is dead'), bea: await ask(bea.s, 'Water, please'), media: await ask(anaMedia.s, 'Media desk'), legal: await ask(anaLegal.s, 'Legal printer'), cy: await ask(cy.s, 'Hall 3 projector'), own: await ask(onStage.s, 'My clicker') };
  const kimBoard = await open(kim);
  const board = (await emit(kimBoard, 'board:watch', {})).board;
  const itemOf = (id) => board.help.find((h) => h.id === id);
  assert.deepEqual([req.ana, req.bea, req.own, req.legal, req.cy].map((id) => itemOf(id).canRespond), [false, false, false, true, true], 'the board offers what the verb answers');
  assert.equal(itemOf(req.media), undefined, 'a room of Hall 2 it is not given: not on its board, since it is no crew of Hall 2');
  // From the On stage page, someone else's request, whatever its code names.
  assert.deepEqual(await emit(onStage.s, 'help:respond', { code: hall2, messageId: req.ana, state: 'coming' }), { ok: false, error: HELP_BACKSTAGE });
  assert.deepEqual(await emit(onStage.s, 'help:respond', { code: hall3, messageId: req.cy, state: 'coming' }), { ok: false, error: HELP_BACKSTAGE });
  // From the halls board: none of Hall 2's, in the On stage words, its Main room's (a Board member's included) or a room of
  // it Kim would answer only as the hall's crew.
  for (const [code, id] of [[hall2, req.ana], [hall2, req.bea], [MEDIA, req.media]]) {
    for (const state of ['coming', 'resolved']) assert.deepEqual(await asked(kimBoard, 'help:respond', { code, messageId: id, state }), { ok: false, error: HELP_BACKSTAGE }, code + ' ' + state);
  }
  // Legal, where it is a Member, and Hall 3, where it is crew: answered; its own in Hall 2: marked resolved.
  assert.deepEqual(await asked(kimBoard, 'help:respond', { code: LEGAL, messageId: req.legal, state: 'coming' }), { ok: true });
  assert.deepEqual(await asked(kimBoard, 'help:respond', { code: hall3, messageId: req.cy, state: 'coming' }), { ok: true });
  assert.deepEqual(await asked(kimBoard, 'help:respond', { code: hall2, messageId: req.own, state: 'coming' }), { ok: false, error: HELP_BACKSTAGE }, 'not On my way, even on its own');
  assert.deepEqual(await asked(kimBoard, 'help:respond', { code: hall2, messageId: req.own, state: 'resolved' }), { ok: true });
  const stateOf = async (code, id) => { const m = (await messagesOf(code)).find((x) => x.id === id); return [m.help.state, m.help.by]; };
  assert.deepEqual([await stateOf(hall2, req.ana), await stateOf(hall2, req.bea), await stateOf(MEDIA, req.media), await stateOf(LEGAL, req.legal), await stateOf(hall3, req.cy), await stateOf(hall2, req.own)],
    [['open', ''], ['open', ''], ['open', ''], ['coming', 'Kim'], ['coming', 'Kim'], ['resolved', 'Kim']]);
});
