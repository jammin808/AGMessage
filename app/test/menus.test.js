'use strict';
// Hiding is never the check (the plan's §16.2 R3, §16.8 2): every act of the catalogue that sends a verb, sent as each
// seat whose rights (`may`) hide it, on a real server, is refused with words, and changes nothing; the On stage seat's
// refusals are the words its table names. The seats' facts are read from the server's own answers (the join's,
// display:list's) through the catalogue's facts(), as a page reads them, with the hall's Stagewatch linked, so the
// speaker's screen is hidden by a seat's rights and never by a link that is not there. Only `may` is iterated: an act
// hidden by `fits` (the object's kind or state) is never sent, so the server is never asked to read a view. The
// catalogue's own rules are test/catalog.test.js's. And where a menu is drawn (menus.js spot(), its pure rule): from a
// button, never over it, wherever the button is and however tall the menu; the page held still under an open menu is the
// browser smoke's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { ROOT, startServer, stopServer, api, connect, emit, once, until, fakeStagewatch, fakeNode, inviteOf, TOKEN, readSource } = require('./helpers');

function loadCatalog() {
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'common.js')), ctx, { filename: 'common.js' });
  vm.runInContext(readSource(path.join(ROOT, 'public', 'catalog.js')), ctx, { filename: 'catalog.js' });
  return ctx.AGM.catalog;
}
const C = loadCatalog();
/** menus.js as a page loads it, in a vm with the few names it reads as it loads: AGM.menu, for its placement rule. */
function loadMenus() {
  const hear = () => {};
  const ctx = vm.createContext({ document: { addEventListener: hear }, innerWidth: 1400, addEventListener: hear });
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'menus.js')), ctx, { filename: 'menus.js' });
  return ctx.AGM.menu;
}
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
  // The header's Screens…: the screens console's list is a backstage page's to read.
  'display:list': 'Do that from a backstage page.',
  forward: 'Messages from On stage stay in this room.',
  'room:send': 'Messages from On stage stay in this room.',
  delete: 'Only the author can delete this message',
  // What the room sent into another is its sender's and the admin's to withdraw: neither On stage page sent it.
  'room:withdraw': 'Only its sender or the admin withdraws it.',
  // A room's guest code is the admin's to switch and renew, whatever the seat: refused as every seat but the admin is.
  'room:update': 'Not admin',
  // What people's pages show is changed from a backstage page (the Board chip, a person's Show them ▸).
  'page:push': 'Do that from a backstage page.',
  // A person's chat view is the admin's to choose, whatever the seat: refused as every seat but the admin is.
  'admin:setView': 'Not admin',
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
  const [hallA, hallB, hallC] = [await hall('Hall A'), await hall('Hall B'), await hall('Hall C')];
  const account = async (username, role, halls, password, extra = {}) => {
    const made = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase(), role, halls, password, ...extra }, { cookie: root });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(base, 'POST', '/api/auth/login', { username, password })).cookie;
  };
  const vic = await account('vic', 'viewer', [hallA, hallB], 'only looking at screens');
  const sid = await account('sid', 'staff', [hallA], 'cable ties and gaffer');
  const tia = await account('tia', 'tech', [hallA], 'mixing desk on stage left');
  // A Tech whose web pages right is revoked: it changes what people's pages show, and shows them no web page.
  const tom = await account('tom', 'tech', [hallA], 'faders and a torch', { revoke: ['stage.web'] });
  // A Tech of hall A given its On stage seat: the Board's account, whose rights hold what the seat does not.
  const kib = await account('kib', 'tech', [hallA, hallB], 'board pack on the lectern', { board: [hallA] });
  // Hall A's Stagewatch, with a show desk: the speaker's screen is there for every seat whose rights allow it.
  const ctl = await open(root);
  assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
  const probe = await open();
  assert.ok((await emit(probe, 'join', { roomCode: hallA, name: 'Probe', role: 'research' })).ok);
  await until(async () => { const r = await emit(probe, 'stage:targets', {}); return r.canSend && r.canPropose; }, 8000, 'the link and its desk');
  probe.close();

  // A seat: its socket, joined in hall A, and its facts as its page reads them, in the full view: the server refuses an
  // act by the seat whatever the view, and the full view draws every act a right hides (the simple view draws fewer, by
  // what fits there), so each is sent.
  const seatOf = async (join, cookie) => {
    const s = await open(cookie);
    const j = await emit(s, 'join', { roomCode: hallA, ...join });
    assert.ok(j.ok, JSON.stringify(j));
    const screens = await emit(s, 'display:list', { code: hallA });
    return { s, j, f: C.facts({ ...j, view: 'full', screens: screens && screens.ok ? screens : null, connected: true }) };
  };
  const ana = await seatOf({ name: 'Ana', role: 'research' });
  const seats = {
    research: ana,
    board: await seatOf({ name: 'Chair', role: 'board', invite: inviteOf(srv.dataDir, hallA) }),
    observer: await seatOf({ name: 'Obs', role: 'observer' }),
    viewer: await seatOf({ as: 'account' }, vic),
    staff: await seatOf({ as: 'account' }, sid),
    tech: await seatOf({ as: 'account' }, tia),
    techNoWeb: await seatOf({ as: 'account' }, tom),
    admin: await seatOf({ as: 'account' }, root),
    boardAccount: await seatOf({ as: 'account' }, kib),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, v.f.role])), { research: 'research', board: 'board', observer: 'observer', viewer: 'observer', staff: 'research', tech: 'research', techNoWeb: 'research', admin: 'research', boardAccount: 'board' });
  // The view each page draws, from the join: the simple view On stage, a Board guest's and a Board account's alike.
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, v.j.view])), { research: 'full', board: 'simple', observer: 'full', viewer: 'full', staff: 'full', tech: 'full', techNoWeb: 'full', admin: 'full', boardAccount: 'simple' });
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, [v.f.canPush, v.f.canWeb]])),
    { research: [false, false], board: [false, false], observer: [false, false], viewer: [false, false], staff: [false, false], tech: [true, true], techNoWeb: [true, false], admin: [true, true], boardAccount: [false, false] },
    'who may change what people\'s pages show, and who may show a web page there, from the join');
  assert.deepEqual([seats.tech.f.canScreens, seats.tech.f.screensManage, seats.admin.f.screensManage, seats.staff.f.canScreens], [true, false, true, false], 'the screens each may drive, from display:list');
  assert.deepEqual(Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, [v.f.canSendToStage, v.f.canPropose]])),
    { research: [true, true], board: [false, false], observer: [false, false], viewer: [false, false], staff: [false, false], tech: [true, true], techNoWeb: [true, true], admin: [true, true], boardAccount: [false, false] },
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
  // And Hall A's copy of what Ana sent into Hall C, whose list names Hall A: Withdraw is its sender's and the admin's.
  assert.ok((await emit(seats.admin.s, 'room:update', { code: hallC, sendFrom: [hallA] })).ok);
  const toC = (await emit(ana.s, 'room:sendTargets', {})).targets[0].ref;
  const sentToC = await emit(ana.s, 'room:send', { to: toC, type: 'text', text: 'Is the overflow room open?' });
  assert.ok(sentToC.ok, JSON.stringify(sentToC));
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
  // The rest of the hall page: each composer, the stage chip (the link up), the header's ⋯, and the people of the room as
  // the server lists them (a person: `person`'s hall half; the admin's rows fit the admin page alone).
  const composer = (form) => ({ id: 'compose:' + form, form, room: 'Hall A', file: form === 'file' ? 'capex.pdf' : '', replying: '', priority: false });
  // Each with information over their show, so Take down on them is iterated too.
  const INFO = { seq: 1, kind: 'web', mark: '◇', words: 'Opened', showing: 'a web page on vote.example.com', arrive: 'over', op: false, on: 1, pages: 1 };
  const people = (await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallA })).users.map((u) => ({ id: 'person:' + u.uid, uid: u.uid, name: u.name, role: u.role, key: (u.account ? 'a:' : 'u:') + u.uid, kind: 'clock', socketId: u.socketId, view: u.view, info: INFO }));
  // What people's pages show: the Board as the console reads it (the clock up, so every other kind may be chosen), a
  // take on a page and its card (a page's own report, every seat's: no right hides it).
  const boardNow = (await emit(seats.admin.s, 'page:status', { code: hallA })).board;
  assert.ok(boardNow, 'the admin reads the console');
  const objects = {
    msg: messages, file: [fileOf('list'), fileOf('preview')], screen: [screen],
    compose: ['director', 'text', 'action', 'file'].map(composer), chip: [{ id: 'stage', live: true, text: '04:30', words: 'Live from Stagewatch' }],
    header: [{ id: 'header', people: people.length, peopleShown: false, zoom: 1, dark: false, code: hallA, on: true, hall: 'Hall A', account: false, away: '/' }], person: people,
    take: [{ id: 'take', seq: 1, kind: 'clock', strip: true, full: false }], card: [{ id: 'card', seq: 1, kind: 'clock' }],
    board: [{ id: 'board', seq: 1, kind: 'clock', pages: boardNow.pages, on: 0, mark: '◷', words: 'Sending', showing: 'the clock', mine: { seq: 1, previous: { kind: 'chat' }, time: '14:02' }, info: INFO }],
    // The room's earlier messages: Show earlier at the top of what a page holds, and a reply's Show it.
    earlier: [{ id: 'earlier', more: true, find: '' }, { id: 'earlier:' + messages[0].id, more: true, find: messages[0].id }],
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
    // A room this hall's list does not name (no list names it here): the reference is no room's.
    'room:send': () => ({ to: 'r' + 'A'.repeat(16), type: 'text', text: 'From a seat that may not send it' }),
    pin: (o) => ({ messageId: o.id, pinned: !o.pinned }),
    delete: (o) => ({ messageId: o.id }),
    'room:withdraw': (o) => ({ messageId: o.id }),
    'display:identify': (o) => ({ id: o.id }),
    'display:update': (o) => ({ id: o.id, name: 'Renamed by a seat that may not' }),
    'display:rotate': (o) => ({ id: o.id }),
    'display:remove': (o) => ({ id: o.id }),
    message: () => ({ type: 'text', text: 'From a seat that may not post' }),
    'room:update': (o, e) => (e.id === 'header.newCode' ? { code: hallA, newCode: true } : { code: hallA, codeOn: false, keepGuests: false }),
    'display:list': () => ({ code: hallA }),
    // A show kind on the Board, or on the person; Back to over the take the object names (ifSeq).
    // A web page by an address of its own (Show a web page…, Show them a web page…).
    // Take down: the information alone handed back, over the take it names.
    'page:push': (o, e) => {
      const web = { kind: 'web', url: 'https://vote.example.com/poll/7' };
      const down = { content: { kind: 'chat', layer: 'info' }, ifSeq: o.info ? o.info.seq : 0 };
      if (e.id === 'person.takeDown') return { code: hallA, to: { uid: o.key }, ...down };
      if (e.id.startsWith('person.')) return { code: hallA, to: { uid: o.key }, content: e.id === 'person.web' ? web : { kind: e.id === 'person.chat' ? 'chat' : 'blank' } };
      if (e.id === 'board.takeDown') return { code: hallA, to: 'board', ...down };
      return { code: hallA, to: 'board', content: e.id === 'board.back' ? o.mine.previous : e.id === 'board.web' ? web : { kind: e.id.slice('board.'.length) }, ...(e.id === 'board.back' ? { ifSeq: o.seq } : {}) };
    },
    // A page's word on the take it is shown (the layer's acts, a card's): Back to chat on the object's take.
    'page:report': (o) => ({ seq: o.seq, state: 'dismissed' }),
    // The person's chat view, the admin's (Chat view ▸ in the People panel).
    'admin:setView': (o) => ({ roomCode: hallA, socketId: o.socketId, view: 'full' }),
    // The room's earlier messages, read back from its newest change.
    'history:before': () => ({ beforeSeq: 1 }),
  };
  // The verbs no right hides from any seat, so none is sent below as a seat it is hidden from, each with why. Every entry
  // is still iterated by its `may` alone: one of these an entry hides from a seat by a right is refused like any other,
  // and this list is then wrong (asserted below).
  const OPEN_TO_EVERY_SEAT = {
    // A page's report on its own take: every seated page's, whatever its rights; the server refuses it from the support
    // view and from a page seated nowhere (test/takes.test.js).
    'page:report': 'every seated page reports on its own take',
    // A room's earlier messages: every seated page reads its own room, the support view included; the server refuses a
    // page seated nowhere and a change number it cannot read (test/server.test.js).
    'history:before': 'every seated page reads its own room\'s earlier messages',
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
  // The verbs each On stage fixture was refused: a Board guest's, and a Board account's (unit 9), in the same words.
  const onStage = { board: new Set(), boardAccount: new Set() };
  const wrong = [];
  for (const [name, { s, f }] of Object.entries(seats)) {
    for (const [kind, list] of Object.entries(objects)) {
      for (const o of list) {
        for (const e of hallEntries[kind]) {
          if (e.verb === 'local' || e.verb.startsWith('http:') || !e.fits(f, o) || e.may(f, o)) continue;
          const r = await refusal(s, e.verb, PAYLOADS[e.verb](o, e));
          if (!r || r.ok !== false || typeof r.error !== 'string' || !r.error || r.busy) wrong.push(name + ' · ' + e.id + ' on ' + (o.type || kind) + ': ' + JSON.stringify(r));
          // On stage, the words are the table's: a refusal for another reason would hide a check that never ran.
          else if (onStage[name] && r.error !== ON_STAGE_WORDS[e.verb]) wrong.push(name + ' · ' + e.id + ' on ' + (o.type || kind) + ': "' + r.error + '", not "' + ON_STAGE_WORDS[e.verb] + '"');
          refused.set(e.verb, (refused.get(e.verb) || 0) + 1);
          if (onStage[name]) onStage[name].add(e.verb);
        }
      }
    }
  }
  assert.deepEqual(wrong, [], 'each hidden act is refused with words');
  // Hidden by the web page's own right alone (its seat may change what people's pages show): refused in that right's words.
  for (const id of ['board.web', 'person.web']) {
    const kind = id.split('.')[0];
    assert.ok(!seats.techNoWeb.f.canWeb && C.entry(kind, id).may(seats.techNoWeb.f) === false && C.entry(kind, id).may(seats.tech.f) === true, id + ' is hidden by canWeb alone');
    assert.deepEqual(await refusal(seats.techNoWeb.s, 'page:push', PAYLOADS['page:push'](objects[kind][0], C.entry(kind, id))), { ok: false, error: 'Web pages on the stage need their own right — ask an admin.' }, id);
  }
  for (const [name, verbs] of Object.entries(onStage)) assert.deepEqual([...verbs].sort(), Object.keys(ON_STAGE_WORDS).sort(), 'every verb of the On stage table was sent as ' + name);
  // Every verb was refused to some seat, so none passes by never being sent; those no right hides, none, and only they.
  assert.deepEqual([...sent].filter((v) => !refused.get(v) && !OPEN_TO_EVERY_SEAT[v]), [], 'every verb is sent as a seat it is hidden from: ' + JSON.stringify(Object.fromEntries(refused)));
  assert.deepEqual(Object.keys(OPEN_TO_EVERY_SEAT).filter((v) => !sent.has(v) || refused.get(v)), [], 'a verb no right hides is one an act sends, and no seat was refused it');
  // And nothing changed: no message pinned, reacted to, answered, removed or moved on; the screen as it was.
  const after = await hallNow();
  const brief = (h) => ({ messages: h.messages.map((m) => [m.id, !!m.pinned, (m.reactions || []).length, (m.responses || []).length, (m.help && m.help.state) || '']), displays: h.displays.map((d) => [d.id, d.name, d.path, d.content && d.content.kind]) });
  assert.deepEqual(brief(after), brief(before));
  const pagesAfter = await emit(seats.admin.s, 'page:status', { code: hallA });
  assert.deepEqual([pagesAfter.board.seq, pagesAfter.people.map((p) => p.seq).filter(Boolean)], [0, []], 'no take was put up on anyone\'s page');
  const inB = (await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallB })).messages.filter((m) => m.type !== 'system');
  assert.deepEqual(inB, [], 'nothing was forwarded into hall B');
  const inC = (await emit(seats.admin.s, 'admin:watchRoom', { roomCode: hallC })).messages.filter((m) => m.type !== 'system');
  assert.deepEqual(inC.map((m) => [m.text, !!m.sentFrom]), [['Is the overflow room open?', true]], 'nothing was withdrawn from hall C');
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
  // The same person backstage in B too: from A, B takes a message; the answer says so, its keys appended at the end in
  // the order they landed (the build serving now, which a page on another build reloads for; then the hall's facts; then
  // whether a message here may be sent into another room by its list, `sends`: no list names Hall A, so it may not; then
  // whether the page is the admin's own, `admin`, which a guest's is not; then what the page is shown over its chat,
  // `page`, whether it may push to people's pages, `canPush`, AGMessage's clock and zone, `now` and `tz`, and whether a web
  // page pushed from it would be taken, `canWeb`; then whether it may show information on its Board's pages by a right of
  // its own, `canShow`, the information over its show, `over`, its Earlier, `earlier`, and the information beside the
  // operator's in its side bar, `beside`; then the chat view it draws,
  // `view`; then, on a first open, whether the room holds earlier messages, `more`, what a page keeps in view from before
  // its newest, `older`, and its files, `files`).
  const anaB = await open();
  await join(anaB, hallB, 'Ana', 'research', { uid: first.identity });
  const again = await join(anaA, hallA, 'Ana', 'research', { uid: first.identity });
  assert.deepEqual([again.forwardable, await rooms(anaA), Object.keys(again).slice(-24), again.sends, again.admin, again.page, again.canPush, again.canWeb, again.canShow, again.over, again.earlier, again.beside, again.view, again.more, again.older, again.files], [true, [hallB],
    ['forwardable', 'main', 'guestCode', 'codeOn', 'setsCode', 'build', 'hall', 'hallName', 'rooms', 'sends', 'admin', 'page', 'canPush', 'now', 'tz', 'canWeb', 'canShow', 'over', 'earlier', 'beside', 'view', 'more', 'older', 'files'], false, false, null, false, false, false, null, [], null, 'full', false, [], []]);
  // On stage, nothing leaves the room: false, though the same person sits backstage in B.
  const beaA = await open();
  const bea = await join(beaA, hallA, 'Bea', 'board', { invite: inviteOf(srv.dataDir, hallA) });
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
  const kib = await account('kib', 'tech', [hallA], 'board pack on the lectern', { board: [hallA] });   // Hall A's crew, and its On stage seat

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
  // A side room beside Hall A, as the admin page lists it under its hall.
  assert.ok((await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).ok);
  const rooms = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms;
  const watched = await emit(ctl, 'admin:watchRoom', { roomCode: hallA });
  const listed = (await emit(ctl, 'nodes:list', {})).linked;
  const nodeObj = { id: listed[0].id, t: listed[0].t, name: listed[0].name, hall: listed[0].hall || '', linked: true, certificateWaits: !!listed[0].certificateWaits, desk: !!listed[0].desk, commands: listed[0].commands };
  const codeOf = (r, h) => ({ guestCode: r.guestCode, on: r.codeOn, guests: r.guests, codeIsKey: !!h.codeIsKey && r === h });
  const hallObj = (r, w) => ({ code: r.code, name: r.name, hall: r.name || r.code, main: true, watched: w, ...codeOf(r, r) });
  const sideObj = (h, x) => ({ code: x.key, name: x.name, hall: (h.name || h.code) + ' › ' + x.name, main: false, watched: false, ...codeOf(x, h) });
  const objects = {
    adminRoom: rooms.map((r) => hallObj(r, false)).concat([hallObj(rooms.find((r) => r.code === hallA), true)], rooms.flatMap((h) => h.side.map((x) => sideObj(h, x)))),
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
  // A halls board's help requests are its own (each with its own canRespond), so a seat's are read from its own board.
  const boardSeat = async (cookie) => {
    const s = await open(cookie);
    const halls = (await api(base, 'GET', '/api/halls', undefined, { cookie })).body;
    const board = await emit(s, 'board:watch', {});
    const help = board.board.help.map((x) => ({ code: x.code, id: x.id, state: x.state, canRespond: !!x.canRespond, canOpen: !!x.canOpen, hall: x.hallName || x.code, room: x.roomName || '', category: x.category }));
    return { s, cookie, f: C.boardFacts({ canManageHalls: halls.canManageHalls, isAdmin: halls.isAdmin, canManageUsers: halls.canManageUsers, canDrive: board.board.canDrive, connected: true }), board: board.board, objects: { help } };
  };
  const accountSeat = async (cookie) => ({ cookie, f: C.accountFacts({ account: (await api(base, 'GET', '/api/auth/me', undefined, { cookie })).body.account, admin: (await me(cookie)).admin }) });
  const seats = {
    admin: { staff: await adminSeat(sid), codeGuest: await adminSeat(undefined) },
    // A project manager sets halls up and is not the admin: in Set up it makes and renames rooms, and its code, New code,
    // Remove room… and Members… are hidden from it and refused.
    board: { viewer: await boardSeat(vic), boardAccount: await boardSeat(kib), setsUp: await boardSeat(mia) },
    accounts: { staff: await accountSeat(sid), manager: await accountSeat(mia), usersManager: await accountSeat(kim) },
  };
  assert.deepEqual([seats.admin.staff.f.admin, seats.admin.codeGuest.f.admin, seats.board.viewer.f.manageHalls, seats.board.viewer.f.canDrive], [false, false, false, false]);
  assert.deepEqual(Object.fromEntries(Object.entries(seats.accounts).map(([k, v]) => [k, [v.f.manageUsers, v.f.auditRead, v.f.auditExport, v.f.theAdmin]])),
    { staff: [false, false, false, false], manager: [false, true, false, false], usersManager: [true, true, false, false] }, 'the Accounts page\'s rights, from /api/auth/me and /api/admin/me');
  objects.hall = seats.board.viewer.board.halls.map((h) => ({ code: h.code, name: h.name || h.code, guestCode: h.guestCode, rooms: h.rooms }));
  // A room button on Hall A's row, as the halls board draws it for an account given Legal (its hall's key for Set up).
  const legalRow = rooms.find((r) => r.code === hallA).side[0];
  objects.room = [{ key: legalRow.key, name: legalRow.name, hall: 'Hall A', href: '/app.html?code=' + legalRow.key + '&as=account&role=research', current: false, guestCode: '', hallKey: hallA }];
  assert.deepEqual([seats.board.viewer.f.admin, seats.board.viewer.f.manageUsers, seats.board.boardAccount.f.admin, seats.admin.staff.f.manageUsers], [false, false, false, false], 'no seat here sets codes in Set up or chooses members');
  assert.deepEqual([seats.board.setsUp.f.manageHalls, seats.board.setsUp.f.admin, seats.board.setsUp.f.manageUsers], [true, false, false], 'one who sets halls up: not the admin, and manages no account');
  objects.help = seats.board.viewer.objects.help;
  assert.deepEqual(objects.help.map((x) => [x.canRespond, x.canOpen]), [[false, true]], 'a Viewer answers no help request, and opens the hall it reads: the board says so');
  // A Board account of Hall A answers none of Hall A's either, from its halls board (owner answer B1): no On my way, no
  // Resolved, and the verb refused in the On stage words.
  const boardItems = seats.board.boardAccount.board.help;
  assert.deepEqual(boardItems.map((x) => [x.id, x.canRespond, x.canOpen]), objects.help.map((x) => [x.id, false, true]));
  const helpActs = (o) => [...C.ids('help', seats.board.boardAccount.f, o)].filter((id) => /^help\.(respond|resolve)$/.test(id)).sort();
  assert.deepEqual([helpActs(objects.help[0]), helpActs({ ...objects.help[0], canRespond: true })], [[], ['help.resolve', 'help.respond']], 'the board\'s canRespond decides: none on Hall A\'s request');
  assert.deepEqual(await emit(seats.board.boardAccount.s, 'help:respond', { code: hallA, messageId: objects.help[0].id, state: 'coming' }), { ok: false, error: 'Help requests are answered by the backstage team.' });
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
    'admin:setView': (o) => ({ roomCode: hallA, socketId: o.socketId, view: 'full' }),
    'admin:unlinkRoom': (o) => ({ socketId: o.socketId, targetRoom: o.linkedRooms[0] }), 'admin:settings': () => ({ stagewatchUrl: 'http://127.0.0.1:9' }),
    'admin:kick': (o) => ({ socketId: o.socketId }), 'admin:deleteMessage': (o) => ({ roomCode: hallA, messageId: o.id }),
    'nodes:link': (o) => ({ id: o.id, token: 'not-the-token' }), 'nodes:unlink': (o) => ({ id: o.id }), 'nodes:acceptCertificate': (o) => ({ id: o.id, fingerprint: '0123456789abcdef' }),
    'nodes:command': (o) => ({ id: o.id, line: 'CUE 1', mode: 'propose' }),
    'admin:acceptCertificate': null, 'admin:tunnelStart': null, 'admin:tunnelStop': null, 'admin:tunnelStatus': null, 'admin:laptop': null,   // the ack alone
    'admin:tunnelUntil': () => ({ until: '23:30' }),
    'hall:settings': (o) => ({ code: o.hallKey || o.code }), 'nodes:list': () => ({}),
    'room:create': (o) => ({ hall: o.code, name: 'Media' }),
    'room:update': (o, e) => (e.id === 'adminRoom.newCode' ? { code: o.code, newCode: true } : e.id === 'adminRoom.codeToggle' ? { code: o.code, codeOn: !o.on, ...(o.on ? { keepGuests: false } : {}) }
      : e.id === 'adminRoom.sendFrom' ? { code: o.code, sendFrom: [o.code === hallB ? hallA : hallB], sendBack: [o.code === hallB ? hallA : hallB] } : { code: o.code, name: 'Renamed by a seat that may not' }),
    'help:respond': (o, e) => ({ code: o.code, messageId: o.id, state: e.id === 'help.respond' ? 'coming' : 'resolved' }),
  };
  // Members… saves each account with its own PATCH: sent here for Sid, the side room put in his rooms (Board members… on
  // a hall: the hall put in his On stage halls).
  const sidId = users.find((u) => u.username === 'sid').id;
  const BODIES = { 'account.edit': { name: 'Renamed by a seat that may not' }, 'account.disable': { disabled: true }, 'audit.split': { seq: 2 } };
  const HTTP = { 'adminRoom.members': (o) => ({ id: sidId, body: o.main ? { board: [o.code] } : { rooms: [o.code] } }) };
  // The halls board draws a hall's rooms in its Set up (kind adminRoom, the same rooms as the admin page's), and its room
  // buttons (kind room: its hall's Set up from there).
  const KINDS = { admin: ['adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop'], board: ['hall', 'room', 'help', 'adminRoom'], accounts: ['account', 'audit'] };
  // The acts these pages draw: each that fits some seat's facts and some object here (a kind's rows the hall page draws, a
  // person's Show them ▸ among them, never fit these pages).
  const fitsOn = (page, k, e) => Object.values(seats[page]).some((seat) => ((seat.objects && seat.objects[k]) || objects[k]).some((o) => e.fits(seat.f, o)));
  const verbsOf = Object.entries(KINDS).flatMap(([page, kinds]) => kinds.flatMap((k) => C.KINDS[k].filter((e) => e.verb !== 'local' && fitsOn(page, k, e))));
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
        for (const o of (seat.objects && seat.objects[kind]) || objects[kind]) {
          for (const e of C.KINDS[kind]) {
            if (e.verb === 'local' || !e.fits(seat.f, o) || e.may(seat.f, o)) continue;
            let r;
            if (e.verb.startsWith('http:')) {
              const [method, route] = e.verb.slice(5).split(' ');
              const at = HTTP[e.id] ? HTTP[e.id](o) : { id: o.id || '', body: BODIES[e.id] || (method === 'GET' ? undefined : {}) };
              const res = await api(base, method, route.replace(':id', encodeURIComponent(at.id)), at.body, { cookie: seat.cookie });
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
  assert.deepEqual(roomsAfter.map((r) => r.side.map((x) => [x.key, x.name, x.messageCount])), rooms.map((r) => r.side.map((x) => [x.key, x.name, x.messageCount])), 'no room made, renamed, cleared or removed');
  const codes = (list) => list.flatMap((r) => [r, ...r.side]).map((x) => [x.guestCode, x.codeOn]);
  assert.deepEqual(codes(roomsAfter), codes(rooms), 'no guest code switched or renewed');
  for (const x of roomsAfter.flatMap((r) => [r.code, ...r.side.map((y) => y.key)])) assert.deepEqual((await emit(ctl, 'room:settings', { code: x })).sendFrom, [], 'no room may send into ' + x);
  assert.equal(rooms.find((r) => r.code === hallA).side.length, 1, 'the side room was read');
  assert.deepEqual((await emit(ctl, 'nodes:list', {})).linked.map((l) => l.id), ['patterns01'], 'the node still linked');
  assert.deepEqual(roomsAfter.find((r) => r.code === hallA).users.map((u) => u.linkedRooms), [[hallB]], 'the guest still forwards into Hall B');
  assert.equal((await emit(ctl, 'admin:settings', null)).stagewatchUrl, '', 'no Stagewatch was set');
  const usersAfter = (await api(base, 'GET', '/api/users', undefined, { cookie: root })).body.users;
  assert.deepEqual(usersAfter.map((u) => [u.username, u.name, !!u.disabled, u.rooms, u.board]), users.map((u) => [u.username, u.name, !!u.disabled, u.rooms, u.board]), 'no account given a room or an On stage seat');
  assert.ok(guest.connected, 'the guest was not logged out');
  assert.deepEqual((await api(base, 'GET', '/api/audit/split', undefined, { cookie: root })).body.unfinished || null, null, 'no split was begun');
});

test('a menu opened from a button is drawn under it or above it and never over it, wherever the button is and however tall the menu: where it fits on neither side it scrolls on the side with more room; an ask is drawn whole, a pointer\'s menu and a submenu where they were', () => {
  const { spot } = loadMenus();
  const M = 8;
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const at = (s, w, h) => ({ left: s.x, top: s.y, right: s.x + w, bottom: s.y + (s.h === null ? h : s.h) });
  // The hall's nine-row menu (321 px) from a ⋯ in the middle of a window 420 px high: room for 190 px under it and 186
  // above it, so under it, cut to 190 and scrolled, where a menu kept whole inside the window would lie over the ⋯.
  const dots = { left: 624, top: 196, right: 648, bottom: 220 };
  assert.deepEqual(plain(spot({ under: dots }, { w: 236, h: 321 }, { w: 1400, h: 420 })), { x: 624, y: 222, h: 190 });
  // Every place of a 24 px button on four windows (the smoke's, Windows' 1376 × 808, a laptop's and a short one), and
  // menus of five heights: never over the button, inside the window by 8 px; whole, it touches the button (under it, else
  // above it); cut, it takes all the room on the side with more.
  let whole = 0, cut = 0;
  for (const view of [{ w: 1400, h: 757 }, { w: 1376, h: 808 }, { w: 1366, h: 600 }, { w: 1024, h: 420 }]) {
    for (const h of [120, 321, 360, 474, 700]) {
      for (let top = 0; top + 24 <= view.h; top += 3) {
        for (const left of [0, 16, 624, view.w - 24]) {
          const b = { left, top, right: left + 24, bottom: top + 24 };
          const s = spot({ under: b }, { w: 236, h }, view);
          const m = at(s, 236, h);
          const where = JSON.stringify({ view, h, b, s });
          assert.ok(!over(m, b), 'never over its button: ' + where);
          assert.ok(m.left >= M && m.right <= view.w - M && m.top >= M && m.bottom <= view.h - M, 'inside the window: ' + where);
          if (s.h === null) {
            whole++;
            assert.ok(m.top === b.bottom + 2 || m.bottom === b.top - 2, 'whole, under its button or above it: ' + where);
            if (m.top !== b.bottom + 2) assert.ok(view.h - M - (b.bottom + 2) < h, 'above only where it does not fit under: ' + where);
          } else {
            cut++;
            const below = view.h - M - (b.bottom + 2), above = b.top - 2 - M;
            assert.ok(h > below && h > above, 'cut only where it fits on neither side: ' + where);
            assert.equal(s.h, Math.max(below, above), 'cut to the room on the side with more: ' + where);
            assert.ok(below >= above ? m.top === b.bottom + 2 : m.bottom === b.top - 2, 'on that side: ' + where);
          }
        }
      }
    }
  }
  assert.ok(whole > 0 && cut > 0, `both kinds are read (${whole} whole, ${cut} cut)`);
  // An ask does not scroll: drawn whole and kept inside the window, as before.
  assert.deepEqual(plain(spot({ under: dots }, { w: 352, h: 300 }, { w: 1400, h: 420 }, { whole: true })), { x: 624, y: 8, h: null });
  // A pointer's menu: at it + 2 px, flipped where it does not fit, kept inside; a submenu beside its row, flipped.
  assert.deepEqual(plain(spot({ x: 100, y: 100 }, { w: 236, h: 321 }, { w: 1400, h: 757 })), { x: 102, y: 102, h: null });
  assert.deepEqual(plain(spot({ x: 1300, y: 700 }, { w: 236, h: 321 }, { w: 1400, h: 757 })), { x: 1062, y: 377, h: null });
  assert.deepEqual(plain(spot({ x: 100, y: 300 }, { w: 236, h: 700 }, { w: 1400, h: 757 })), { x: 102, y: 8, h: null });
  const row = { left: 624, top: 300, right: 860, bottom: 332 };
  assert.deepEqual(plain(spot({ beside: row }, { w: 200, h: 120 }, { w: 1400, h: 757 })), { x: 858, y: 300, h: null });
  assert.deepEqual(plain(spot({ beside: row }, { w: 200, h: 120 }, { w: 1000, h: 757 })), { x: 426, y: 300, h: null });
});
