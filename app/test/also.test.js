'use strict';
// What the admin lets a seat On stage do (plan 7-§17.6, owner answers B2 and B4), end to end: the three switches, each
// off by default, kept for a guest by their uid and on an account, set by the admin alone (the host token or an account
// whose role is admin; a manager granted settings.manage or users.manage is refused) on the socket and over the Accounts
// page's PATCH, never by `create`, told live to the person's pages and support view and nobody else, one audit row a
// change; and where a message from On stage also goes with them: the line under the countdown of the hall's screens that
// show it, and a typed line beside the chat of everyone On stage that supersedes nothing there, each refused in words
// before anything is written, the switch read from the store at each send, and the message saying where it went, by
// names alone, as its targets confirm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, stopServer, api, connect, emit, wait, until, inviteOf, TOKEN } = require('./helpers');
const { io } = require('socket.io-client');

const PASSWORD = 'clipboard and coffee';
const OFF = { screens: false, people: false, clears: false };
const ADMIN_ONLY = 'Only an admin may choose what an On stage seat may do.';
const SHAPE = 'Choose where else it goes: a countdown screen or people On stage.';
const NO_SCREENS = 'The admin has not let you send to countdown screens.';
const NO_PEOPLE = 'The admin has not let you send to people On stage.';
/** A join with the hall's On stage link when it asks for that seat as a guest (an open hall's code seats nobody there). */
const invited = (dataDir, args) => (args.role === 'board' && !args.as && !args.adminView ? { ...args, invite: inviteOf(dataDir, args.roomCode), docs: true } : { ...args, docs: true });
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}
/** The audit rows of an action: [target, words]. */
const rowsOf = (dataDir, action) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words]);

/** A rig: the server, an admin account, a hall, and pages that remember every event they hear. */
async function rig(t) {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const events = (s, name) => heard.get(s).filter(([ev]) => ev === name).map(([, v]) => v);
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return { id: made.body.user.id, user: made.body.user, cookie: (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie };
  };
  const onAccount = (username) => { try { return JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8')).users.find((u) => u.username === username); } catch { return null; } };
  const views = () => { try { return JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).views; } catch { return null; } };
  return { srv, sockets, heard, page, joined, events, admin, hall, account, onAccount, views };
}

test('the admin\'s On stage settings: three switches, off by default and never set by create, the admin\'s alone on the socket and over the PATCH, kept for a guest and on an account, told live to the person\'s pages and support view alone, nothing closed, one row each', { timeout: 120_000 }, async (t) => {
  const { srv, page, joined, events, admin, hall, account, onAccount, views } = await rig(t);
  const rows = (action) => rowsOf(srv.dataDir, action);

  // Made with every switch off and nothing kept, whoever makes it and whatever the make asked (a clock too).
  const bea = await account('bea', 'Bea Board', 'staff', { halls: [hall], board: [hall], onStage: { screens: true, people: true, clears: true }, clock: { show: 'off', locked: true } });
  assert.deepEqual([bea.user.onStage, bea.user.clock], [OFF, { show: null, locked: false }]);
  await until(() => onAccount('bea'), 4000, 'accounts.json written');
  assert.deepEqual([Object.hasOwn(onAccount('bea'), 'onStage'), Object.hasOwn(onAccount('bea'), 'clock')], [false, false]);
  const tom = await account('tom', 'Tom Tech', 'tech', { halls: [hall] });
  const max = await account('max', 'Max Manager', 'staff', { halls: [hall], grant: ['settings.manage'] });
  const mo = await account('mo', 'Mo Manager', 'staff', { halls: [hall], grant: ['settings.manage', 'users.manage'] });
  const byMo = await api(srv.base, 'POST', '/api/users', { username: 'cy', name: 'Cy Crew', role: 'staff', halls: [hall], password: PASSWORD, onStage: { screens: true }, clock: { show: 'time' } }, { cookie: mo.cookie });
  assert.deepEqual([byMo.status, byMo.body.user.onStage, byMo.body.user.clock], [200, OFF, { show: null, locked: false }], JSON.stringify(byMo.body));
  await until(() => onAccount('cy'), 4000, 'accounts.json written');
  assert.deepEqual([Object.hasOwn(onAccount('cy'), 'onStage'), Object.hasOwn(onAccount('cy'), 'clock')], [false, false]);

  // The join's last key: every switch off, no screens named while screens is off.
  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const gil2 = await page(undefined, 'Gil\'s phone');
  await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  const ria = await page(undefined, 'Ria backstage');
  const riaJoin = await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' });
  const beaPage = await page(bea.cookie, 'Bea On stage');
  const beaJoin = await joined(beaPage, { roomCode: hall, as: 'account' });
  const tomPage = await page(tom.cookie, 'Tom backstage');
  await joined(tomPage, { roomCode: hall, as: 'account' });
  const anaPage = await page(admin, 'Ana in the hall');
  const anaJoin = await joined(anaPage, { roomCode: hall, as: 'account' });
  assert.deepEqual([gilJoin.onStage, riaJoin.onStage, beaJoin.onStage, Object.keys(gilJoin).at(-1), Object.keys(beaJoin).at(-1)], [OFF, OFF, OFF, 'onStage', 'onStage']);
  assert.deepEqual(Object.keys(gilJoin).slice(-3), ['clock', 'pins', 'onStage'], 'clock, pins and onStage the last three');

  // The admin page's people rows carry each person's switches; no other page's list does.
  const ctl = await page(admin, 'the admin page');
  const watched = await emit(ctl, 'admin:watchRoom', { roomCode: hall });
  const sid = (name) => watched.users.find((u) => u.name === name).socketId;
  assert.ok(watched.users.every((u) => JSON.stringify(u.onStage) === JSON.stringify(OFF)), JSON.stringify(watched.users));
  assert.ok(riaJoin.users.every((u) => !('onStage' in u)), 'a guest\'s list says none');
  const gilView = await page(admin, 'the admin\'s view of Gil');
  const gilViewJoin = await joined(gilView, { roomCode: hall, name: 'Gil', role: 'board', adminView: true, viewOf: gilJoin.uid });
  assert.deepEqual(gilViewJoin.onStage, OFF, 'the support view is told the person\'s');

  // A guest's: told to both of Gil's devices and the admin's view of him, nobody else; kept by his uid; one row.
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), screens: true }), { ok: true, onStage: { screens: true, people: false, clears: false } });
  await until(() => [gil, gil2, gilView].every((s) => events(s, 'onStage').length === 1), 4000, 'Gil\'s pages told');
  assert.deepEqual([events(gil, 'onStage'), events(gil2, 'onStage'), events(gilView, 'onStage'), events(ria, 'onStage'), events(beaPage, 'onStage'), events(anaPage, 'onStage')],
    [[{ screens: true, people: false, clears: false, countdownScreens: [] }], [{ screens: true, people: false, clears: false, countdownScreens: [] }], [{ screens: true, people: false, clears: false, countdownScreens: [] }], [], [], []]);
  await until(() => views() && views()['u:' + gilJoin.uid], 4000, 'pages.json keeps it');
  assert.deepEqual(views()['u:' + gilJoin.uid].onStage, { screens: true, people: false, clears: false });
  // As they stand: said so, no row, nobody told.
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), screens: true }), { ok: true, already: true, onStage: { screens: true, people: false, clears: false } });
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), people: true, clears: true }), { ok: true, onStage: { screens: true, people: true, clears: true } });
  // A page that joins again is told them: a reload keeps them.
  const gil3 = await page(undefined, 'Gil, reloaded');
  assert.deepEqual((await joined(gil3, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity })).onStage, { screens: true, people: true, clears: true, countdownScreens: [] });
  gil3.close();
  // Every one off: the record goes.
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), screens: false, people: false, clears: false }), { ok: true, onStage: OFF });
  await until(() => events(gil, 'onStage').length === 3, 4000, 'Gil told each');
  assert.deepEqual(events(gil, 'onStage').at(-1), OFF);
  await until(() => views() && !views()['u:' + gilJoin.uid], 4000, 'pages.json keeps none for Gil');
  // What is no switch, and a request that names none or names anything else: refused in words, never answered as done;
  // nothing kept, nobody told.
  for (const bad of [{ screens: 'yes' }, { people: 1 }, { clears: null }, {}, { web: true }, { screens: true, web: true }]) {
    assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Ria'), ...bad }), { ok: false, error: 'Choose on or off.' }, JSON.stringify(bad));
  }
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: 'nobody', screens: true }), { ok: false, error: 'That person is not in this room now.' });
  assert.deepEqual(events(ria, 'onStage'), []);

  // Not the admin: a manager granted settings.manage (the admin page's gate admits it), one granted users.manage too, and
  // a page the gate does not admit; nothing kept.
  const maxPage = await page(max.cookie, 'Max on the admin page');
  const moPage = await page(mo.cookie, 'Mo on the admin page');
  assert.deepEqual(await act(maxPage, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), screens: true }), { ok: false, error: ADMIN_ONLY });
  assert.deepEqual(await act(moPage, 'admin:setOnStage', { roomCode: hall, socketId: sid('Bea Board'), screens: true }), { ok: false, error: ADMIN_ONLY });
  assert.deepEqual(await act(tomPage, 'admin:setOnStage', { roomCode: hall, socketId: sid('Gil'), screens: true }), { ok: false, error: 'Not admin' });
  // The admin's own account seated in the room changes none of its own, in the words a role or a right is refused in.
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Ana Admin'), screens: true }), { ok: false, error: 'Nobody changes their own role, rights or halls — ask another admin.' });

  // An account's: kept on the account, its page told, none closed; its row the Accounts page's words.
  assert.deepEqual(await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: sid('Bea Board'), people: true }), { ok: true, onStage: { screens: false, people: true, clears: false } });
  await until(() => events(beaPage, 'onStage').length === 1, 4000, 'Bea\'s page told');
  await until(() => { const a = onAccount('bea'); return !!a && !!a.onStage; }, 4000, 'accounts.json keeps it');
  assert.deepEqual(onAccount('bea').onStage, { screens: false, people: true, clears: false });
  assert.deepEqual((await api(srv.base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.find((u) => u.username === 'bea').onStage, { screens: false, people: true, clears: false });
  // The Accounts page's PATCH, by the admin: told live, nothing closed.
  const patched = await api(srv.base, 'PATCH', '/api/users/' + bea.id, { onStage: { clears: true } }, { cookie: admin });
  assert.deepEqual([patched.status, patched.body.changed, patched.body.user.onStage], [200, ['onStage'], { screens: false, people: true, clears: true }]);
  await until(() => events(beaPage, 'onStage').length === 2, 4000, 'the PATCH told Bea\'s page');
  assert.deepEqual(events(beaPage, 'onStage').at(-1), { screens: false, people: true, clears: true });
  // A users.manage holder who is not an admin: refused, whatever it names; on oneself, the self-change words first.
  const moPatch = await api(srv.base, 'PATCH', '/api/users/' + bea.id, { onStage: { clears: false } }, { cookie: mo.cookie });
  assert.deepEqual([moPatch.status, moPatch.body.error], [403, ADMIN_ONLY]);
  const moOwn = await api(srv.base, 'PATCH', '/api/users/' + mo.id, { onStage: { screens: true } }, { cookie: mo.cookie });
  assert.deepEqual([moOwn.status, moOwn.body.error], [403, 'Nobody changes their own role, rights or halls — ask another admin.']);
  const anaOwn = await api(srv.base, 'PATCH', '/api/users/' + anaJoin.uid, { onStage: { screens: true } }, { cookie: admin });
  assert.deepEqual([anaOwn.status, anaOwn.body.error], [403, 'Nobody changes their own role, rights or halls — ask another admin.']);
  // What is no switch: 400 in words, never thrown.
  for (const onStage of [{ toString: 1 }, 'yes', { web: true }, { screens: 'on' }, null, {}]) {
    const r = await api(srv.base, 'PATCH', '/api/users/' + bea.id, { onStage }, { cookie: admin });
    assert.deepEqual([r.status, r.body.error], [400, 'Choose on or off.'], JSON.stringify(onStage));
  }
  await wait(300);
  assert.deepEqual(onAccount('bea').onStage, { screens: false, people: true, clears: true }, 'unchanged by each refusal');
  assert.ok(events(beaPage, 'account:changed').length === 0 && beaPage.connected, 'a change of the switches alone ends no socket');

  // One row each, in the words of the switches moved (a guest's) or all three (an account's); no code, no text.
  assert.deepEqual(rows('person.onStage'), [
    [hall, 'Gil (guest) → may send to a countdown screen: on'],
    [hall, 'Gil (guest) → may send to people On stage: on, Got it clears: on'],
    [hall, 'Gil (guest) → may send to a countdown screen: off, may send to people On stage: off, Got it clears: off'],
  ]);
  assert.deepEqual(rows('user.update').filter(([, w]) => /onStage/.test(w)), [
    ['bea', 'onStage → countdown screens off, people On stage on, Got it clears off'],
    ['bea', 'onStage → countdown screens off, people On stage on, Got it clears on'],
  ]);
  assert.ok(rows('person.onStage').concat(rows('user.update')).every(([, w]) => !w.includes(hall) && !w.includes(gilJoin.identity)), 'no code and no identity in the words');
});

/** A browser on a screen's link, saying it showed every take it is told, as display.js does. */
const openScreen = (base, token, sockets) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: token } });
  sockets.push(s);
  const got = { states: [], socket: s };
  s.on('display:state', (x) => { got.states.push(x); s.emit('display:shown', { seq: x.seq, ok: true, words: '' }); });
  s.once('connect', () => resolve(got));
  s.once('connect_error', reject);
});

test('a message from On stage also goes where the admin allows: refused in words before anything is written; the line under the countdown of the hall\'s screens that show it; a typed line beside the chat of everyone On stage, superseding nothing, in Earlier; the switch read at each send; the message saying where it went, by names alone, as its targets confirm', { timeout: 120_000 }, async (t) => {
  const { srv, sockets, heard, page, joined, events, admin, hall, account } = await rig(t);
  const rows = (action) => rowsOf(srv.dataDir, action);
  const ctl = await page(admin, 'the admin page');
  // Two screens of the hall: Lectern, put on the countdown below, and Foyer, on holding.
  const lectern = (await emit(ctl, 'display:create', { code: hall, name: 'Lectern' })).display;
  const foyer = (await emit(ctl, 'display:create', { code: hall, name: 'Foyer' })).display;
  const lecternScreen = await openScreen(srv.base, lectern.path.slice(3), sockets);
  await openScreen(srv.base, foyer.path.slice(3), sockets);
  await until(() => lecternScreen.states.length === 1, 4000, 'Lectern open');

  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const ria = await page(undefined, 'Ria backstage');
  const riaJoin = await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' });
  const watched = await emit(ctl, 'admin:watchRoom', { roomCode: hall });
  const sidOf = async (name) => (await emit(ctl, 'admin:watchRoom', { roomCode: hall })).users.find((u) => u.name === name).socketId;
  const seqNow = async () => (await emit(ria, 'join', { roomCode: hall, name: 'Ria', role: 'research', uid: riaJoin.identity, docs: true })).seq;
  assert.ok(watched.ok);
  const send = (s, payload) => act(s, 'message', { type: 'text', ...payload });

  // By default nowhere else: each refused, nothing posted (the room's seq unchanged).
  const seq0 = await seqNow();
  assert.deepEqual(await send(gil, { text: 'Five minutes', also: { screens: true } }), { ok: false, error: NO_SCREENS });
  assert.deepEqual(await send(gil, { text: 'Five minutes', also: { people: true } }), { ok: false, error: NO_PEOPLE });
  assert.deepEqual(await send(ria, { text: 'From backstage', also: { screens: true } }), { ok: false, error: 'Only On stage seats send this way: use ⧉ Show on screens or 📺 Show the Board.' });
  for (const also of [{}, { screens: 'yes' }, { web: true }, null, 'screens', { screens: true, web: true }]) {
    assert.deepEqual(await send(gil, { text: 'Five minutes', also }), { ok: false, error: SHAPE }, JSON.stringify(also));
  }
  assert.deepEqual(await act(gil, 'message', { type: 'help', text: 'Mic three', also: { screens: true } }), { ok: false, error: 'Only a message goes there, not a help request.' });
  assert.equal(await seqNow(), seq0, 'nothing posted');

  // Screens on, and no screen on the countdown: said so. Its pages are told the countdown screens, by name, when they move.
  assert.ok((await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: await sidOf('Gil'), screens: true })).ok);
  assert.deepEqual(await send(gil, { text: 'Five minutes', also: { screens: true } }), { ok: false, error: 'No screen in this hall shows the countdown now.' });
  assert.ok((await act(ctl, 'display:take', { id: lectern.id, content: { kind: 'countdown' } })).ok);
  await until(() => events(gil, 'onStage').some((o) => o.countdownScreens && o.countdownScreens.length === 1), 4000, 'Gil told the countdown screens');
  assert.deepEqual(events(gil, 'onStage').at(-1), { screens: true, people: false, clears: false, countdownScreens: ['Lectern'] });
  assert.deepEqual(events(ria, 'onStage'), [], 'nobody else is told');
  // Over the line's length: said with the count; nothing posted.
  assert.deepEqual(await send(gil, { text: 'x'.repeat(161), also: { screens: true } }), { ok: false, error: 'A countdown screen\'s line holds 160 characters (this is 161).' });
  assert.equal(await seqNow(), seq0, 'nothing posted');
  const lecternSeq = (await emit(ctl, 'display:list', { code: hall })).displays.find((d) => d.id === lectern.id).seq;

  // Sent: posted with where it went, the Lectern's line under its countdown at its next take, the Foyer untouched.
  const sent = await send(gil, { text: 'Five minutes, please', also: { screens: true } });
  assert.deepEqual([sent.ok, sent.also], [true, { screens: [{ name: 'Lectern', seq: lecternSeq + 1, state: 'sending' }] }], JSON.stringify(sent));
  const list = (await emit(ctl, 'display:list', { code: hall })).displays;
  assert.deepEqual(list.find((d) => d.id === lectern.id).content, { kind: 'countdown', text: 'Five minutes, please', tone: 'info' });
  assert.deepEqual(list.find((d) => d.id === foyer.id).content, { kind: 'holding' });
  await until(() => heard.get(ria).some(([ev, m]) => ev === 'message' && m.id === sent.id), 4000, 'the room told');
  const posted = heard.get(ria).find(([ev, m]) => ev === 'message' && m.id === sent.id)[1];
  assert.deepEqual(posted.also, { screens: [{ name: 'Lectern', seq: lecternSeq + 1, state: 'sending' }] });
  // The screen's confirm turns it to ✓ for every reader of the room.
  await until(() => events(ria, 'alsoUpdate').some((u) => u.messageId === sent.id && u.also.screens[0].state === 'shown'), 4000, 'the Lectern\'s confirm told');
  assert.ok(events(gil, 'alsoUpdate').some((u) => u.messageId === sent.id && u.also.screens[0].state === 'shown'), 'the sender too');
  const take = rows('display.take').at(-1);
  assert.deepEqual(take, [lectern.id, 'Lectern → the countdown with a line from Gil, On stage (20 characters)']);
  assert.ok(!take[1].includes('Five minutes'), 'the row holds no text');
  // A 🔥 message's line is urgent.
  const hot = await send(gil, { text: 'Wrap up now', priority: true, also: { screens: true } });
  assert.equal(hot.ok, true, JSON.stringify(hot));
  assert.deepEqual((await emit(ctl, 'display:list', { code: hall })).displays.find((d) => d.id === lectern.id).content, { kind: 'countdown', text: 'Wrap up now', tone: 'urgent' });
  // The older message's line was replaced on the Lectern by the newer: said so on it, with when.
  await until(() => events(ria, 'alsoUpdate').some((u) => u.messageId === sent.id && u.also.screens[0].state === 'replaced' && Number.isFinite(u.also.screens[0].at)), 4000, 'the first line said replaced');
  // A line on screen is followed until the screen moves on: the operator's take there is said on the newer one too.
  await until(() => events(ria, 'alsoUpdate').some((u) => u.messageId === hot.id && u.also.screens[0].state === 'shown'), 4000, 'the 🔥 line shown');
  assert.ok((await act(ctl, 'display:take', { id: lectern.id, content: { kind: 'countdown', text: 'Back to the plan' } })).ok);
  await until(() => events(ria, 'alsoUpdate').some((u) => u.messageId === hot.id && u.also.screens[0].state === 'replaced'), 4000, 'the 🔥 line said replaced');

  // People on: a second Board page; a quote the operator put over the Board's chat before the line; and a typed quote a
  // Staff account (stage.show, no canPush) put beside it for the Board, and one beside it for Hana alone, which she
  // minimised (her answer).
  assert.ok((await act(ctl, 'admin:setOnStage', { roomCode: hall, socketId: await sidOf('Gil'), people: true })).ok);
  assert.deepEqual(await send(gil, { text: 'Alone', also: { people: true } }), { ok: false, error: 'Nobody else is On stage now.' });
  // Gil's second device is Gil: nobody else.
  const gilPhone = await page(undefined, 'Gil\'s phone');
  await joined(gilPhone, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  assert.deepEqual(await send(gil, { text: 'Alone', also: { people: true } }), { ok: false, error: 'Nobody else is On stage now.' });
  gilPhone.close();
  const hana = await page(undefined, 'Hana On stage');
  const hanaJoin = await joined(hana, { roomCode: hall, name: 'Hana', role: 'board' });
  const sal = await page((await account('sal', 'Sal Staff', 'staff', { halls: [hall] })).cookie, 'Sal backstage');
  await joined(sal, { roomCode: hall, as: 'account' });
  const book = () => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).halls[hall];
  const hanaKey = 'u:' + hanaJoin.uid;
  // A researcher's quote over the Board's chat first, which Hana minimised: a line sent then leaves it the Board's, with
  // her answer, and draws on no page over it.
  const salOver = await act(sal, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Q3 revenue: 4.2m' } });
  assert.equal(salOver.ok, true, JSON.stringify(salOver));
  assert.deepEqual(await act(hana, 'page:report', { seq: salOver.seq, state: 'minimised' }), { ok: true });
  const first = await send(gil, { text: 'Is that net?', also: { people: true } });
  assert.deepEqual([first.ok, first.also], [true, { people: { seq: salOver.seq + 1, of: 2 } }], JSON.stringify(first));
  await wait(300);
  assert.deepEqual([book().board.info.seq, book().answers[hanaKey].info.seq, book().answers[hanaKey].info.state, book().board.line.seq], [salOver.seq, salOver.seq, 'minimised', first.also.people.seq]);
  const hanaBack = await page(undefined, 'Hana, back');
  const back0 = await joined(hanaBack, { roomCode: hall, name: 'Hana', role: 'board', uid: hanaJoin.identity });
  assert.deepEqual([back0.over.seq, back0.over.answer, back0.line.seq], [salOver.seq, 'minimised', first.also.people.seq], 'the researcher\'s quote over the chat stays the Board\'s, with Hana\'s answer, the line beside it');
  hanaBack.close();
  const quote = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Resolution 4 reads…' } });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  const salBoard = await act(sal, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'For the Board: the vote is at 3' }, arrive: 'side' });
  assert.deepEqual([salBoard.ok, salBoard.aside], [true, true], JSON.stringify(salBoard));
  const salHana = await act(sal, 'page:push', { code: hall, to: { uid: 'u:' + hanaJoin.uid }, content: { kind: 'snippet', unit: 'text', text: 'For Hana: your slide is next' }, arrive: 'side' });
  assert.deepEqual([salHana.ok, salHana.aside], [true, true], JSON.stringify(salHana));
  assert.deepEqual(await act(hana, 'page:report', { seq: salHana.seq, state: 'minimised' }), { ok: true });
  // A line longer than a card holds: refused in words of its own, nothing posted (a hand-made page: the composer holds 300).
  const seqPeople = await seqNow();
  assert.deepEqual(await send(gil, { text: 'y'.repeat(1201), also: { people: true } }), { ok: false, error: 'A line shown On stage holds 1,200 characters (this is 1,201).' });
  assert.equal(await seqNow(), seqPeople, 'nothing posted');
  const line = await send(gil, { text: 'Can we take five?', also: { people: true } });
  assert.equal(line.ok, true, JSON.stringify(line));
  assert.deepEqual(line.also, { people: { seq: salHana.seq + 1, of: 2 } });
  await until(() => heard.get(ria).some(([ev, m]) => ev === 'message' && m.id === line.id), 4000, 'the room told');
  assert.deepEqual(heard.get(ria).find(([ev, m]) => ev === 'message' && m.id === line.id)[1].also, { people: { seq: salHana.seq + 1, shown: 0, of: 2, state: 'sending' } }, 'posted saying where it goes, as the take is numbered');
  // Each Board page, the sender's own included, is told it in its own place in the side bar, by its socket.
  const lineOf = (s) => events(s, 'page:take').filter((x) => x.layer === 'line' && x.seq === line.also.people.seq);
  await until(() => lineOf(gil).length && lineOf(hana).length, 4000, 'the Board\'s pages told the line');
  for (const s of [gil, hana]) {
    const b = lineOf(s).at(-1);
    assert.deepEqual([b.arrive, b.content, b.by], ['side', { kind: 'snippet', unit: 'text', text: 'Can we take five?' }, { name: 'Gil', onStage: true }]);
  }
  assert.equal(lineOf(ria).length + lineOf(sal).length, 0, 'a backstage page is told no card');
  // It supersedes nothing: the operator's quote over the chat, Sal's card beside it for the Board, and Sal's card for Hana
  // with her answer all stay, in the store and on a page that comes back.
  await wait(300);
  const now = book();
  assert.deepEqual([now.board.info.seq, now.board.beside.seq, now.board.line.seq, now.people[hanaKey].beside.seq, now.answers[hanaKey].beside.seq, now.answers[hanaKey].beside.state],
    [quote.seq, salBoard.seq, line.also.people.seq, salHana.seq, salHana.seq, 'minimised']);
  const hana2 = await page(undefined, 'Hana, reloaded');
  const again = await joined(hana2, { roomCode: hall, name: 'Hana', role: 'board', uid: hanaJoin.identity });
  assert.deepEqual([again.over && again.over.seq, again.beside && again.beside.seq, again.beside && again.beside.answer, again.line && again.line.seq], [quote.seq, salHana.seq, 'minimised', line.also.people.seq]);
  assert.ok(again.earlier.some((e) => e.seq === line.also.people.seq && e.by.onStage === true), 'and in Earlier, so a page that comes back draws it there');
  const gil2 = await page(undefined, 'Gil, reloaded');
  const gilAgain = await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  assert.deepEqual([gilAgain.over.seq, gilAgain.beside.seq, gilAgain.line.seq], [quote.seq, salBoard.seq, line.also.people.seq], 'Sal\'s card for the Board stays beside the quote');
  gil2.close();
  // The Board's pages confirm it in their side bars, counted by person, never by page: Hana's, then Hana's again from a
  // page that came back, and a page of someone who sat down On stage after it was sent, leave it at 1 of 2.
  const shownOf = (id) => events(ria, 'alsoUpdate').filter((u) => u.messageId === id && u.also.people).map((u) => [u.also.people.shown, u.also.people.of, u.also.people.state]);
  assert.ok((await act(hana, 'page:report', { seq: line.also.people.seq, state: 'shown', words: 'in the side bar' })).ok);
  await until(() => shownOf(line.id).some(([n]) => n === 1), 4000, 'Hana\'s confirm told');
  assert.ok((await act(hana2, 'page:report', { seq: line.also.people.seq, state: 'shown', words: 'in the side bar' })).ok);
  const ivo = await page(undefined, 'Ivo, On stage since');
  await joined(ivo, { roomCode: hall, name: 'Ivo', role: 'board' });
  assert.ok((await act(ivo, 'page:report', { seq: line.also.people.seq, state: 'shown', words: 'in the side bar' })).ok);
  await wait(1500);
  assert.deepEqual(shownOf(line.id).at(-1), [1, 2, 'sending'], 'still 1 of 2: a page that came back is its person, a late joiner is nobody it went to');
  assert.ok((await act(gil, 'page:report', { seq: line.also.people.seq, state: 'shown', words: 'in the side bar' })).ok);
  await until(() => shownOf(line.id).some(([n, of, st]) => n === 2 && of === 2 && st === 'shown'), 4000, 'every card confirmed');
  hana2.close();
  ivo.close();
  assert.deepEqual(rows('page.push').at(-1), [hall, 'the Board (2 pages) → a line typed by Gil, On stage (17 characters), beside their chat']);
  // With the operator's web page over the Board's chat, the web page stays and the next line is a card beside it; the line
  // before it moves to Earlier.
  const web = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: 'https://vote.example.com/poll/7' } });
  assert.equal(web.ok, true, JSON.stringify(web));
  const line2 = await send(gil, { text: 'Thank you', also: { people: true } });
  assert.equal(line2.ok, true, JSON.stringify(line2));
  const hana3 = await page(undefined, 'Hana, back again');
  const back = await joined(hana3, { roomCode: hall, name: 'Hana', role: 'board', uid: hanaJoin.identity });
  assert.deepEqual([back.over && back.over.seq, back.over && back.over.content.kind, back.line && back.line.seq], [web.seq, 'web', line2.also.people.seq]);
  assert.ok(back.earlier.some((e) => e.seq === line.also.people.seq), 'the first line is under Earlier');
  hana3.close();

  // No frame to a page of the room, the ack, the message or its updates holds a screen's id, link or token.
  const secrets = [lectern.id, foyer.id, lectern.path.slice(3), foyer.path.slice(3)];
  for (const s of [gil, ria, hana]) {
    const said = JSON.stringify(heard.get(s));
    assert.ok(secrets.every((x) => !said.includes(x)), s.who + ' was told a screen\'s id or link');
  }
  assert.ok(secrets.every((x) => !JSON.stringify([sent, hot, line]).includes(x)), 'an ack holds no screen\'s id or link');
  assert.ok(gilJoin.ok);
});

test('a Board account\'s switch is read at each send: turned off by the admin while its page is open, its next send is refused and nothing posted', { timeout: 120_000 }, async (t) => {
  const { srv, page, joined, events, admin, hall, account, sockets } = await rig(t);
  const ctl = await page(admin, 'the admin page');
  const lectern = (await emit(ctl, 'display:create', { code: hall, name: 'Lectern' })).display;
  await openScreen(srv.base, lectern.path.slice(3), sockets);
  assert.ok((await act(ctl, 'display:take', { id: lectern.id, content: { kind: 'countdown' } })).ok);
  const tech = await account('tess', 'Tess Tech', 'tech', { halls: [hall], board: [hall] });
  assert.equal((await api(srv.base, 'PATCH', '/api/users/' + tech.id, { onStage: { screens: true } }, { cookie: admin })).status, 200);
  const tess = await page(tech.cookie, 'Tess On stage');
  const j = await joined(tess, { roomCode: hall, as: 'account' });
  assert.deepEqual([j.role, j.onStage], ['board', { screens: true, people: false, clears: false, countdownScreens: ['Lectern'] }]);
  const first = await act(tess, 'message', { type: 'text', text: 'Two minutes', also: { screens: true } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await api(srv.base, 'PATCH', '/api/users/' + tech.id, { onStage: { screens: false } }, { cookie: admin })).status, 200);
  await until(() => events(tess, 'onStage').length === 1, 4000, 'told live');
  const seq = (await emit(tess, 'join', { roomCode: hall, as: 'account', docs: true })).seq;
  assert.deepEqual(await act(tess, 'message', { type: 'text', text: 'One minute', also: { screens: true } }), { ok: false, error: NO_SCREENS });
  assert.equal((await emit(tess, 'join', { roomCode: hall, as: 'account', docs: true })).seq, seq, 'nothing posted');
  assert.deepEqual((await emit(ctl, 'display:list', { code: hall })).displays[0].content, { kind: 'countdown', text: 'Two minutes', tone: 'info' }, 'the screen keeps the line it had');
});
