'use strict';
// Hiding is never the check (the plan's §16.2 R3, §16.8 2): every act of the catalogue that sends a verb, sent as each
// seat whose rights (`may`) hide it, on a real server, is refused with words, and changes nothing; the On stage seat's
// refusals are the words its table names. The seats' facts are read from the server's own answers (the join's,
// display:list's) through the catalogue's facts(), as a page reads them, with the hall's Stagewatch linked, so the
// speaker's screen is hidden by a seat's rights and never by a link that is not there. Only `may` is iterated: an act
// hidden by `fits` (the object's kind or state) is never sent, so the server is never asked to read a view. The
// catalogue's own rules are test/catalog.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, startServer, stopServer, api, connect, emit, once, until, fakeStagewatch, fakeNode, TOKEN } = require('./helpers');

function loadCatalog() {
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'catalog.js'), 'utf8'), ctx, { filename: 'catalog.js' });
  return ctx.AGM.catalog;
}
const C = loadCatalog();
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const KEY = 'swk_menus_node_key_0001';   // secret-scan: fixture
/** What an On stage seat is told for each verb its rights hide (the plan's §17.1 table, in the server's words). */
const ON_STAGE_WORDS = {
  'help:respond': 'Help requests are answered by the backstage team.',
  'ai:draft': 'Drafting is for the backstage team.',
  'stage:propose': 'Proposing to the stage is for the backstage team.',
  'stage:send': 'The speaker\'s screen is for the backstage team.',
  'display:take': 'Do that from a backstage page.',
  'display:identify': 'Do that from a backstage page.',
  'display:update': 'Do that from a backstage page.',
  'display:rotate': 'Do that from a backstage page.',
  'display:remove': 'Do that from a backstage page.',
  forward: 'Messages from On stage stay in this room.',
  delete: 'Only the author can delete this message',
};

test('every act hidden from a seat by its rights is refused by the server as that seat, with words, and changes nothing', async (t) => {
  const sw = await fakeStagewatch({ name: 'Lectern timer' });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };

  const root = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: root })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const account = async (username, role, halls, password) => {
    const made = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase(), role, halls, password }, { cookie: root });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(base, 'POST', '/api/auth/login', { username, password })).cookie;
  };
  const vic = await account('vic', 'viewer', [hallA, hallB], 'only looking at screens');
  const sid = await account('sid', 'staff', [hallA], 'cable ties and gaffer');
  const tia = await account('tia', 'tech', [hallA], 'mixing desk on stage left');
  // Hall A's Stagewatch, with a show desk: the speaker's screen is there for every seat whose rights allow it.
  const ctl = await open(root);
  assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
  const probe = await open();
  assert.ok((await emit(probe, 'join', { roomCode: hallA, name: 'Probe', role: 'research' })).ok);
  await until(async () => { const r = await emit(probe, 'stage:targets', {}); return r.canSend && r.canPropose; }, 8000, 'the link and its desk');
  probe.close();

  // A seat: its socket, joined in hall A, and its facts as its page reads them.
  const seatOf = async (join, cookie) => {
    const s = await open(cookie);
    const j = await emit(s, 'join', { roomCode: hallA, ...join });
    assert.ok(j.ok, JSON.stringify(j));
    const screens = await emit(s, 'display:list', { code: hallA });
    return { s, j, f: C.facts({ ...j, screens: screens && screens.ok ? screens : null, connected: true }) };
  };
  const ana = await seatOf({ name: 'Ana', role: 'research' });
  const seats = {
    research: ana,
    board: await seatOf({ name: 'Chair', role: 'board' }),
    observer: await seatOf({ name: 'Obs', role: 'observer' }),
    viewer: await seatOf({ as: 'account' }, vic),
    staff: await seatOf({ as: 'account' }, sid),
    tech: await seatOf({ as: 'account' }, tia),
    admin: await seatOf({ as: 'account' }, root),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, v.f.role])), { research: 'research', board: 'board', observer: 'observer', viewer: 'observer', staff: 'research', tech: 'research', admin: 'research' });
  assert.deepEqual([seats.tech.f.canScreens, seats.tech.f.screensManage, seats.admin.f.screensManage, seats.staff.f.canScreens], [true, false, true, false], 'the screens each may drive, from display:list');
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, [v.f.canSendToStage, v.f.canPropose]])),
    { research: [true, true], board: [false, false], observer: [false, false], viewer: [false, false], staff: [false, false], tech: [true, true], admin: [true, true] },
    'the speaker\'s screen, by each seat\'s rights, with the link up');

  // The objects: Ana's text, file, question and help request, the Chair's text and help request, and a screen.
  const upload = async (token) => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'capex.pdf');
    return (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f })).json();
  };
  const up = await upload(ana.j.uploadToken);
  const said = [
    await emit(ana.s, 'message', { type: 'text', text: 'Capex is on slide 14' }),
    await emit(ana.s, 'message', { type: 'file', url: up.url, filename: 'capex.pdf', mime: 'application/pdf' }),
    await emit(ana.s, 'message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] }),
    await emit(ana.s, 'message', { type: 'help', category: 'Sound', text: 'mic 3 is dead' }),
    await emit(seats.board.s, 'message', { type: 'text', text: 'Can we take questions now?' }),
    await emit(seats.board.s, 'message', { type: 'help', category: 'Presenter', text: 'water, please' }),
  ];
  assert.ok(said.every((r) => r && r.ok), JSON.stringify(said));
  const made = await emit(seats.admin.s, 'display:create', { code: hallA, name: 'Lectern monitor' });
  assert.ok(made.ok, JSON.stringify(made));
  const hallNow = async () => {
    const w = await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallA });
    const d = (await emit(seats.admin.s, 'display:list', { code: hallA })).displays;
    return { messages: w.messages.filter((m) => m.type !== 'system'), displays: d };
  };
  const before = await hallNow();
  const messages = before.messages;
  const screen = before.displays[0];
  const fileOf = (where) => ({ ...messages.find((m) => m.type === 'file'), where });
  // The rest of the hall page: each composer, the stage chip (the link up), the code chip, and the people of the room as
  // the server lists them (a person: `person`'s hall half; the admin's rows fit the admin page alone).
  const composer = (form) => ({ id: 'compose:' + form, form, room: 'Hall A', file: form === 'file' ? 'capex.pdf' : '', replying: '', priority: false });
  const people = (await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallA })).users.map((u) => ({ id: 'person:' + u.uid, uid: u.uid, name: u.name, role: u.role }));
  const objects = {
    msg: messages, file: [fileOf('list'), fileOf('preview')], screen: [screen],
    compose: ['director', 'text', 'action', 'file'].map(composer), chip: [{ id: 'stage', live: true, text: '04:30', words: 'Live from Stagewatch' }], code: [{ id: 'code', code: hallA }], person: people,
  };
  assert.ok(people.length >= 7, 'the room\'s people, as the join lists them');

  // Each verb's smallest payload, naming the object. A verb an act sends that has no row here fails the test, so a new
  // act is held to its refusal from the day it is written.
  const PAYLOADS = {
    react: (o) => ({ messageId: o.id, emoji: '👍', on: true }),
    actionResponse: (o) => ({ messageId: o.id, optionIndex: 0 }),
    'help:respond': (o, e) => ({ code: hallA, messageId: o.id, state: e.id === 'msg.helpRespond' ? 'coming' : 'resolved' }),
    'ai:draft': (o) => ({ question: o.text || '' }),
    'stage:propose': (o) => ({ text: o.text || '', destination: 'speaker', messageId: o.id }),
    'stage:send': (o) => ({ text: o.text || '', messageId: o.id }),
    'display:take': () => ({ ids: [screen.id], content: { kind: 'black' } }),
    forward: (o) => ({ messageId: o.id, targetRoom: hallB }),
    pin: (o) => ({ messageId: o.id, pinned: !o.pinned }),
    delete: (o) => ({ messageId: o.id }),
    'display:identify': (o) => ({ id: o.id }),
    'display:update': (o) => ({ id: o.id, name: 'Renamed by a seat that may not' }),
    'display:rotate': (o) => ({ id: o.id }),
    'display:remove': (o) => ({ id: o.id }),
    message: () => ({ type: 'text', text: 'From a seat that may not post' }),
  };
  // The acts the hall page draws: each that fits some seat's facts and some object here (a kind's rows another page draws
  // never fit this one).
  const fitsHere = (kind, e) => Object.values(seats).some(({ f }) => objects[kind].some((o) => e.fits(f, o)));
  const hallEntries = Object.fromEntries(Object.keys(objects).map((k) => [k, C.KINDS[k].filter((e) => fitsHere(k, e))]));
  const sent = new Set(Object.values(hallEntries).flat().filter((e) => e.verb !== 'local' && !e.verb.startsWith('http:')).map((e) => e.verb));
  assert.deepEqual([...sent].filter((v) => !PAYLOADS[v]), [], 'every verb an act sends has its refusal case');
  assert.ok(['message', 'ai:draft', 'stage:propose', 'display:take'].every((v) => sent.has(v)), 'the composer\'s and the stage chip\'s verbs are among them');

  // A refusal for the rate is not the verb's: asked again once the rate allows.
  const refusal = async (s, verb, payload) => {
    for (let i = 0; i < 20; i++) {
      const r = await emit(s, verb, payload);
      if (!(r && r.busy)) return r;
      await wait(300);
    }
    return { busy: true };
  };
  const refused = new Map();   // verb → how many seats' refusals were read
  const onStage = new Set();   // the verbs the On stage seat was refused
  const wrong = [];
  for (const [name, { s, f }] of Object.entries(seats)) {
    for (const [kind, list] of Object.entries(objects)) {
      for (const o of list) {
        for (const e of hallEntries[kind]) {
          if (e.verb === 'local' || e.verb.startsWith('http:') || !e.fits(f, o) || e.may(f, o)) continue;
          const r = await refusal(s, e.verb, PAYLOADS[e.verb](o, e));
          if (!r || r.ok !== false || typeof r.error !== 'string' || !r.error || r.busy) wrong.push(name + ' · ' + e.id + ' on ' + (o.type || kind) + ': ' + JSON.stringify(r));
          // On stage, the words are the table's: a refusal for another reason would hide a check that never ran.
          else if (name === 'board' && r.error !== ON_STAGE_WORDS[e.verb]) wrong.push('board · ' + e.id + ' on ' + (o.type || kind) + ': "' + r.error + '", not "' + ON_STAGE_WORDS[e.verb] + '"');
          refused.set(e.verb, (refused.get(e.verb) || 0) + 1);
          if (name === 'board') onStage.add(e.verb);
        }
      }
    }
  }
  assert.deepEqual(wrong, [], 'each hidden act is refused with words');
  assert.deepEqual([...onStage].sort(), Object.keys(ON_STAGE_WORDS).sort(), 'every verb of the On stage table was sent as the On stage seat');
  // Every verb was refused to some seat, so none passes by never being sent.
  assert.deepEqual([...sent].filter((v) => !refused.get(v)), [], 'every verb is sent as a seat it is hidden from: ' + JSON.stringify(Object.fromEntries(refused)));
  // And nothing changed: no message pinned, reacted to, answered, removed or moved on; the screen as it was.
  const after = await hallNow();
  const brief = (h) => ({ messages: h.messages.map((m) => [m.id, !!m.pinned, (m.reactions || []).length, (m.responses || []).length, (m.help && m.help.state) || '']), displays: h.displays.map((d) => [d.id, d.name, d.path, d.content && d.content.kind]) });
  assert.deepEqual(brief(after), brief(before));
  const inB = (await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallB })).messages.filter((m) => m.type !== 'system');
  assert.deepEqual(inB, [], 'nothing was forwarded into hall B');
});

test('the join\'s forwardable is the forward picker\'s rule: a hall to send to, never On stage, and asked again when the admin\'s link changes', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };
  const root = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: root })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const join = async (s, code, name, role, extra = {}) => { const j = await emit(s, 'join', { roomCode: code, name, role, ...extra }); assert.ok(j.ok, JSON.stringify(j)); return j; };
  const rooms = async (s) => (await emit(s, 'myRooms', {})).rooms.map((r) => r.code);

  // Ana backstage in A alone: no other hall, so nothing is forwardable, as the picker lists none.
  const anaA = await open();
  const first = await join(anaA, hallA, 'Ana', 'research');
  assert.deepEqual([first.forwardable, await rooms(anaA)], [false, []]);
  // The same person backstage in B too: from A, B takes a message; the answer's last key says so.
  const anaB = await open();
  await join(anaB, hallB, 'Ana', 'research', { uid: first.identity });
  const again = await join(anaA, hallA, 'Ana', 'research', { uid: first.identity });
  assert.deepEqual([again.forwardable, await rooms(anaA), Object.keys(again).pop()], [true, [hallB], 'forwardable']);
  // On stage, nothing leaves the room: false, though the same person sits backstage in B.
  const beaA = await open();
  const bea = await join(beaA, hallA, 'Bea', 'board');
  const beaB = await open();
  await join(beaB, hallB, 'Bea', 'research', { uid: bea.identity });
  assert.deepEqual([(await join(beaA, hallA, 'Bea', 'board', { uid: bea.identity })).forwardable, await rooms(beaA)], [false, []]);
  // An observer with no other hall: false, until the admin links it to B, which its page is told (linkedRoomsChanged)
  // and asks again; taken back, it is false again.
  const obs = await open();
  const o = await join(obs, hallA, 'Obs', 'observer');
  assert.equal(o.forwardable, false);
  const ctl = await open(root);
  const told = once(obs, 'linkedRoomsChanged');
  assert.equal((await emit(ctl, 'admin:linkRoom', { socketId: obs.id, targetRoom: hallB })).ok, true);
  assert.deepEqual(await told, { added: hallB });
  assert.deepEqual([await rooms(obs), (await join(obs, hallA, 'Obs', 'observer', { uid: o.identity })).forwardable], [[hallB], true]);
  const untold = once(obs, 'linkedRoomsChanged');
  assert.equal((await emit(ctl, 'admin:unlinkRoom', { socketId: obs.id, targetRoom: hallB })).ok, true);
  assert.deepEqual(await untold, { removed: hallB });
  assert.deepEqual([await rooms(obs), (await join(obs, hallA, 'Obs', 'observer', { uid: o.identity })).forwardable], [[], false]);
  // The admin's support view is unseated: it is told no forwardable of its own.
  const view = await open(root);
  assert.equal((await emit(view, 'join', { roomCode: hallA, name: 'Ana', role: 'research', adminView: true })).forwardable, false);
});

// The admin page, the halls board and the Accounts page (kinds adminRoom, person, adminMsg, link, tunnel, laptop; hall,
// help; account, audit): each act hidden from a seat by its rights, sent as that seat — its socket, or its HTTP sign-in — is
// refused with words, and changes nothing. Each seat's facts are read from the server's own answers, as its page reads
// them (/api/admin/me, /api/halls and the board, /api/auth/me).
test('every act of the admin page, the halls board and the Accounts page hidden by rights is refused as that seat, with words, and changes nothing', async (t) => {
  const node = await fakeNode({ commands: [{ verb: 'CUE <n>', risk: 'low' }] });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await node.close(); });
  const open = async (cookie) => { const s = await connect(base, cookie); sockets.push(s); return s; };
  const root = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: root })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const account = async (username, role, halls, password, extra = {}) => {
    const made = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase(), role, halls, password, ...extra }, { cookie: root });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(base, 'POST', '/api/auth/login', { username, password })).cookie;
  };
  const sid = await account('sid', 'staff', [hallA], 'cable ties and gaffer');
  const vic = await account('vic', 'viewer', [hallA, hallB], 'only looking at screens');
  const mia = await account('mia', 'manager', [], 'running order on the wall');               // audit.read; no users.manage, no audit.export
  const kim = await account('kim', 'manager', [], 'mixing desk on stage left', { grant: ['users.manage'] });   // may manage accounts, not an admin's

  // The objects, as the pages read them: a hall and its people and feed (the admin's own answers), a linked Patterns.
  const ctl = await open(root);
  const guest = await open();
  assert.ok((await emit(guest, 'join', { roomCode: hallA, name: 'Gus', role: 'research' })).ok);
  assert.ok((await emit(guest, 'message', { type: 'text', text: 'Capex is on slide 14' })).ok);
  assert.ok((await emit(guest, 'message', { type: 'help', category: 'Sound', text: 'mic 3 is dead' })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'patterns01', t: 'patterns', url: node.url, name: 'Patterns FOH', token: 'node-token' })).ok);
  await until(async () => ((await emit(ctl, 'nodes:list', {})).linked || []).some((l) => l.commands.length), 8000, 'the node read');
  // The guest may forward into Hall B: No longer forward into ▸ is there to be refused.
  const gusId = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms.find((r) => r.code === hallA).users[0].socketId;
  assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: gusId, targetRoom: hallB })).ok);
  const rooms = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms;
  const watched = await emit(ctl, 'admin:watchRoom', { roomCode: hallA });
  const listed = (await emit(ctl, 'nodes:list', {})).linked;
  const nodeObj = { id: listed[0].id, t: listed[0].t, name: listed[0].name, hall: listed[0].hall || '', linked: true, certificateWaits: !!listed[0].certificateWaits, desk: !!listed[0].desk, commands: listed[0].commands };
  const hallObj = (r, w) => ({ code: r.code, name: r.name, hall: r.name || r.code, watched: w });
  const objects = {
    adminRoom: rooms.map((r) => hallObj(r, false)).concat([hallObj(rooms.find((r) => r.code === hallA), true)]),
    person: watched.users.map((u) => ({ ...u, hall: 'Hall A' })),
    adminMsg: watched.messages.filter((m) => m.type !== 'system').map((m) => ({ ...m, hall: 'Hall A' })),
    // A node over plain HTTP on this laptop waits for no certificate, and a default Stagewatch whose certificate changed
    // needs a TLS peer: those two states are the page's to draw, and the acts they show are refused by right alike.
    link: [nodeObj, { ...nodeObj, certificateWaits: true, certificateChanged: true }, { t: 'main', name: 'Stagewatch', url: '127.0.0.1:9', changed: true }],
    tunnel: [{ running: false, url: '', checking: false, checkedAgo: null }, { running: true, url: 'https://a-b.trycloudflare.com', checking: false, checkedAgo: null }],
    laptop: [{ addresses: (await emit(ctl, 'admin:settings', null)).addresses.map((a) => 'http://' + a + ':' + srv.port), reading: false }],
  };

  // Each seat of a page: its socket (or none), its HTTP cookie, and its facts from the server's answers.
  const me = async (cookie) => (await api(base, 'GET', '/api/admin/me', undefined, { cookie })).body;
  const adminSeat = async (cookie) => ({ s: await open(cookie), cookie, f: C.adminFacts({ ...(await me(cookie)), ai: true, halls: rooms, connected: true }) });
  const boardSeat = async (cookie) => {
    const s = await open(cookie);
    const halls = (await api(base, 'GET', '/api/halls', undefined, { cookie })).body;
    const board = await emit(s, 'board:watch', {});
    return { s, cookie, f: C.boardFacts({ canManageHalls: halls.canManageHalls, canDrive: board.board.canDrive, connected: true }), board: board.board };
  };
  const accountSeat = async (cookie) => ({ cookie, f: C.accountFacts({ account: (await api(base, 'GET', '/api/auth/me', undefined, { cookie })).body.account, admin: (await me(cookie)).admin }) });
  const seats = {
    admin: { staff: await adminSeat(sid), codeGuest: await adminSeat(undefined) },
    board: { viewer: await boardSeat(vic) },
    accounts: { staff: await accountSeat(sid), manager: await accountSeat(mia), usersManager: await accountSeat(kim) },
  };
  assert.deepEqual([seats.admin.staff.f.admin, seats.admin.codeGuest.f.admin, seats.board.viewer.f.manageHalls, seats.board.viewer.f.canDrive], [false, false, false, false]);
  assert.deepEqual(Object.fromEntries(Object.entries(seats.accounts).map(([k, v]) => [k, [v.f.manageUsers, v.f.auditRead, v.f.auditExport, v.f.theAdmin]])),
    { staff: [false, false, false, false], manager: [false, true, false, false], usersManager: [true, true, false, false] }, 'the Accounts page\'s rights, from /api/auth/me and /api/admin/me');
  objects.hall = seats.board.viewer.board.halls.map((h) => ({ code: h.code, name: h.name || h.code }));
  objects.help = seats.board.viewer.board.help.map((x) => ({ code: x.code, id: x.id, state: x.state, canRespond: !!x.canRespond, hall: x.hallName || x.code, category: x.category }));
  assert.deepEqual(objects.help.map((x) => x.canRespond), [false], 'a Viewer answers no help request: the board says so');
  const users = (await api(base, 'GET', '/api/users', undefined, { cookie: root })).body.users;
  const kimsView = (await api(base, 'GET', '/api/users', undefined, { cookie: kim })).body.users;
  objects.account = users.map((u) => ({ id: u.id, name: u.name, username: u.username, disabled: !!u.disabled, locked: (kimsView.find((x) => x.id === u.id) || {}).locked || '', self: false }));
  const entries = (await api(base, 'GET', '/api/audit?limit=300', undefined, { cookie: root })).body.entries;
  objects.audit = [entries[0], { ...entries[0], seq: 2, action: 'audit.archive' }];

  // Each verb's smallest payload, naming the object; a verb with no row here fails the test.
  const PAYLOADS = {
    'admin:watchRoom': (o) => ({ roomCode: o.code }), 'admin:summary': (o) => ({ roomCode: o.code }), 'admin:invites': (o) => ({ roomCode: o.code }),
    'admin:resetRoom': (o) => ({ roomCode: o.code }), 'admin:deleteRoom': (o) => ({ roomCode: o.code, purgeFiles: true }),
    'admin:setRole': (o) => ({ roomCode: hallA, socketId: o.socketId, role: 'observer' }), 'admin:linkRoom': (o) => ({ socketId: o.socketId, targetRoom: hallB }),
    'admin:unlinkRoom': (o) => ({ socketId: o.socketId, targetRoom: o.linkedRooms[0] }), 'admin:settings': () => ({ stagewatchUrl: 'http://127.0.0.1:9' }),
    'admin:kick': (o) => ({ socketId: o.socketId }), 'admin:deleteMessage': (o) => ({ roomCode: hallA, messageId: o.id }),
    'nodes:link': (o) => ({ id: o.id, token: 'not-the-token' }), 'nodes:unlink': (o) => ({ id: o.id }), 'nodes:acceptCertificate': (o) => ({ id: o.id, fingerprint: '0123456789abcdef' }),
    'nodes:command': (o) => ({ id: o.id, line: 'CUE 1', mode: 'propose' }),
    'admin:acceptCertificate': null, 'admin:tunnelStart': null, 'admin:tunnelStop': null, 'admin:tunnelStatus': null, 'admin:laptop': null,   // the ack alone
    'hall:settings': (o) => ({ code: o.code }), 'nodes:list': () => ({}),
    'help:respond': (o, e) => ({ code: o.code, messageId: o.id, state: e.id === 'help.respond' ? 'coming' : 'resolved' }),
  };
  const BODIES = { 'account.edit': { name: 'Renamed by a seat that may not' }, 'account.disable': { disabled: true }, 'audit.split': { seq: 2 } };
  const KINDS = { admin: ['adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop'], board: ['hall', 'help'], accounts: ['account', 'audit'] };
  const verbsOf = Object.values(KINDS).flat().flatMap((k) => C.KINDS[k]).filter((e) => e.verb !== 'local');
  assert.deepEqual([...new Set(verbsOf.filter((e) => !e.verb.startsWith('http:') && !(e.verb in PAYLOADS)).map((e) => e.verb))], [], 'every socket verb an act sends has its refusal case');
  const say = (s, verb, payload) => new Promise((resolve) => { if (payload === null) s.emit(verb, resolve); else s.emit(verb, payload, resolve); });
  const refusal = async (s, verb, payload) => {
    for (let i = 0; i < 20; i++) {
      const r = await say(s, verb, payload);
      if (!(r && r.busy)) return r;
      await wait(300);
    }
    return { busy: true };
  };
  const refused = new Map();
  const wrong = [];
  for (const [page, kinds] of Object.entries(KINDS)) {
    for (const [name, seat] of Object.entries(seats[page])) {
      for (const kind of kinds) {
        for (const o of objects[kind]) {
          for (const e of C.KINDS[kind]) {
            if (e.verb === 'local' || !e.fits(seat.f, o) || e.may(seat.f, o)) continue;
            let r;
            if (e.verb.startsWith('http:')) {
              const [method, route] = e.verb.slice(5).split(' ');
              const res = await api(base, method, route.replace(':id', encodeURIComponent(o.id || '')), BODIES[e.id] || (method === 'GET' ? undefined : {}), { cookie: seat.cookie });
              r = { status: res.status, ...(res.body && typeof res.body === 'object' ? res.body : { ok: true }) };
              if (res.status < 400) wrong.push(page + ' · ' + name + ' · ' + e.id + ': answered ' + res.status);
            } else r = await refusal(seat.s, e.verb, PAYLOADS[e.verb] ? PAYLOADS[e.verb](o, e) : null);
            if (!r || r.ok !== false || typeof r.error !== 'string' || !r.error || r.busy) wrong.push(page + ' · ' + name + ' · ' + e.id + ': ' + JSON.stringify(r).slice(0, 160));
            refused.set(e.verb, (refused.get(e.verb) || 0) + 1);
          }
        }
      }
    }
  }
  assert.deepEqual(wrong, [], 'each hidden act is refused with words');
  assert.deepEqual([...new Set(verbsOf.map((e) => e.verb))].filter((v) => !refused.get(v)), [], 'every verb is sent as a seat it is hidden from: ' + JSON.stringify(Object.fromEntries(refused)));
  // And nothing changed: the halls, their people and messages, the link, the accounts, the log unsplit.
  const roomsAfter = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms;
  assert.deepEqual(roomsAfter.map((r) => [r.code, r.name, r.messageCount, r.users.map((u) => [u.name, u.role, (u.linkedRooms || []).length])]), rooms.map((r) => [r.code, r.name, r.messageCount, r.users.map((u) => [u.name, u.role, (u.linkedRooms || []).length])]));
  assert.deepEqual((await emit(ctl, 'nodes:list', {})).linked.map((l) => l.id), ['patterns01'], 'the node still linked');
  assert.deepEqual(roomsAfter.find((r) => r.code === hallA).users.map((u) => u.linkedRooms), [[hallB]], 'the guest still forwards into Hall B');
  assert.equal((await emit(ctl, 'admin:settings', null)).stagewatchUrl, '', 'no Stagewatch was set');
  const usersAfter = (await api(base, 'GET', '/api/users', undefined, { cookie: root })).body.users;
  assert.deepEqual(usersAfter.map((u) => [u.username, u.name, !!u.disabled]), users.map((u) => [u.username, u.name, !!u.disabled]));
  assert.ok(guest.connected, 'the guest was not logged out');
  assert.deepEqual((await api(base, 'GET', '/api/audit/split', undefined, { cookie: root })).body.unfinished || null, null, 'no split was begun');
});
