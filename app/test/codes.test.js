'use strict';
// Each room's guest code, end to end: a side room's is its own and off at birth, refused exactly as a wrong code is;
// switched on, a guest joins it as a Member and never On stage; switched off, the guests in it stay through a drop and a
// newcomer is refused, or they are sent out with their seats while accounts stay; renewed, the code before it admits only
// a person seated there, spends no lock, and the invite links made with it stop, and the new one outlives a restart. Who is
// told a code (the halls board, /api/halls, the join's answer, a room's settings, each page as it changes) and where it is
// never written (an op, the ring, a resume, an audit row, a frame to a page that may not know it). The store's half is
// test/units.test.js's; the rights' pure half (rbac.mayKnowCode), test/accounts.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, restartServer, stopServer, api, connect, emit, once, wait, until, TOKEN } = require('./helpers');

/** An audit row as the tests read it: its target, its words, who. */
const rowsOf = (dataDir, action) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action === action).map((e) => [e.target, e.words, e.actor.name]);
const NOT_FOUND = { ok: false, error: 'Room not found' };
const MISS = (code) => ({ code, exists: false, name: '', locked: false });
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}

/**
 * A server's pages, opened within the connection bucket every socket from 127.0.0.1 shares (3 a second, bursts of 30):
 * each waits for a token with one to spare. Accounts made by the admin and signed in.
 */
async function showOf(srv, t) {
  const sockets = [];
  const bucket = { tokens: 30, at: Date.now() };
  const level = () => Math.min(30, bucket.tokens + ((Date.now() - bucket.at) / 1000) * 3);
  const page = async (cookie) => {
    while (level() < 2) await wait(Math.ceil(((2 - level()) / 3) * 1000));
    bucket.tokens = level() - 1;
    bucket.at = Date.now();
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    return s;
  };
  t.after(() => sockets.forEach((s) => s.close()));
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const account = async (username, role, extra = {}) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: 'clipboard and coffee', ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: 'clipboard and coffee' })).cookie;
  };
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  /** A guest's page joined with a code: its socket and the join's answer. */
  const guest = async (code, name, role, extra = {}) => { const s = await page(); return { s, j: await emit(s, 'join', { roomCode: code, name, role, ...extra }) }; };
  return { sockets, page, admin, account, hall, guest };
}

test('a side room\'s guest code: off at birth and refused as a wrong code is; on, a guest joins as a Member and never On stage; off, the guests in stay through a drop and a newcomer is refused, or they are sent out with their seats and the accounts stay; the admin\'s alone, one row each', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, account, hall, guest } = await showOf(srv, t);
  const pat = await account('pat', 'manager');
  const hallA = await hall('Hall A');
  const ctl = await page(admin);
  const made = await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' });
  assert.ok(made.ok, JSON.stringify(made));
  const LEGAL = made.key;
  // Its own code, made with it: six characters, never its key, told to the admin and to those who set halls up.
  const listed = () => new Promise((r) => { ctl.emit('admin:listRooms', r); }).then((x) => x.rooms.find((h) => h.code === hallA));
  const side = (await listed()).side[0];
  assert.match(side.guestCode, /^[A-Z2-9]{6}$/);
  assert.notEqual(side.guestCode, LEGAL);
  const CODE = side.guestCode;
  assert.deepEqual([side.codeOn, side.guests, (await listed()).codeOn, (await listed()).guestCode, (await listed()).codeIsKey], [false, 0, true, hallA, true], 'a side room\'s code is off; a hall\'s is on, and is its key until New code');
  const patPage = await page(pat);
  const settings = await emit(patPage, 'room:settings', { code: LEGAL });
  assert.deepEqual([settings.guestCode, settings.codeOn], [CODE, false]);

  // Off: its lookup and its join are a wrong code's, word for word, and its key is no code at all.
  for (const code of [CODE, LEGAL.slice(0, 6), 'ZZZ234']) assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + code)).body, MISS(code));
  assert.deepEqual((await guest(CODE, 'Gus', 'research')).j, NOT_FOUND);
  assert.deepEqual((await guest(LEGAL, 'Gus', 'research')).j, NOT_FOUND, 'a room\'s key is an address, never a code');

  // Only the admin switches it, never from an On stage page.
  assert.deepEqual(await act(patPage, 'room:update', { code: LEGAL, codeOn: true }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(patPage, 'room:update', { code: LEGAL, newCode: true }), { ok: false, error: 'Not admin' });
  for (const [args, error] of [
    [{ code: LEGAL, codeOn: 'yes' }, 'Say whether the code is on (true) or off (false).'],
    [{ code: LEGAL, codeOn: true, keepGuests: true }, 'Whether the guests stay is said as the code is switched off: true or false.'],
    [{ code: LEGAL, codeOn: false, keepGuests: 'no' }, 'Whether the guests stay is said as the code is switched off: true or false.'],
    [{ code: LEGAL, keepGuests: false }, 'Whether the guests stay is said as the code is switched off.'],
    [{ code: LEGAL, newCode: 1 }, 'Ask for a new code with newCode: true.'],
    [{ code: LEGAL, name: 'Lawyers', codeOn: true }, 'One change at a time: the name, the code on or off, or a new code.'],
    [{ code: LEGAL, codeOn: true, guests: 3 }, 'A room\'s name and its guest code are the settings changed here.'],
    [{ code: 'NOROOM12', codeOn: true }, 'No such room.'],
  ]) assert.deepEqual(await act(ctl, 'room:update', args), { ok: false, error }, JSON.stringify(args));
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false }), { ok: true, already: true, codeOn: false }, 'off already: done, no row');
  const heardOn = once(ctl, 'guestCode');
  assert.ok((await emit(ctl, 'admin:watchRoom', { roomCode: LEGAL })).ok);
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: true }), { ok: true, codeOn: true });
  assert.deepEqual(await heardOn, { guestCode: CODE, codeOn: true }, 'the admin page watching it is told');
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: true }), { ok: true, already: true, codeOn: true });

  // On: looked up as the room it opens, named with its hall; a guest joins it as a Member or an observer, never On stage.
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + CODE)).body, { code: CODE, exists: true, name: 'Legal', locked: false, hallName: 'Hall A', main: false });
  assert.deepEqual((await guest(CODE, 'Bea', 'board')).j, { ok: false, error: 'On stage seats are in the hall\'s Main room.' });
  const rita = await guest(CODE, 'Rita', 'research');
  assert.deepEqual([rita.j.ok, rita.j.role, rita.j.roomCode, rita.j.roomName, rita.j.main, rita.j.guestCode, rita.j.codeOn, rita.j.setsCode], [true, 'research', CODE, 'Legal', false, CODE, true, false], 'a guest is told the code it joined with, and that its room is no Main room (its seat a Member\'s)');
  await until(async () => (await emit(ctl, 'admin:watchRoom', { roomCode: LEGAL })).messages.some((m) => m.type === 'system' && m.text === 'Rita joined as a Member'), 3000, 'a side room\'s backstage seat said as a Member\'s');
  const olly = await guest(CODE, 'Olly', 'observer');
  assert.equal(olly.j.role, 'observer');
  // The admin's seat move keeps to the room's kind too.
  assert.deepEqual(await emit(ctl, 'admin:setRole', { roomCode: LEGAL, socketId: olly.s.id, role: 'board' }), { ok: false, error: 'On stage seats are in the hall\'s Main room.' });
  // An account given the room (the admin's) is seated, and stays whatever the code does.
  const anaPage = await page(admin);
  const anaIn = await emit(anaPage, 'join', { roomCode: LEGAL, as: 'account' });
  assert.deepEqual([anaIn.ok, anaIn.guestCode, anaIn.setsCode], [true, CODE, true], 'the admin is told the code, and may switch it from a page that names the room by its key');
  assert.equal((await listed()).side[0].guests, 2, 'two guest pages in it');

  // Turn off (the guests stay): one meta op its pages hear, the code never in it; a newcomer is refused as a wrong code is,
  // and a guest whose connection drops comes back within the grace.
  const ritaTold = once(rita.s, 'guestCode');
  const metaOp = once(anaPage, 'roomMeta');
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false }), { ok: true, codeOn: false, kept: 2 });
  assert.deepEqual(await ritaTold, { guestCode: CODE, codeOn: false });
  await metaOp;
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + CODE)).body, MISS(CODE));
  assert.deepEqual((await guest(CODE, 'Newt', 'research')).j, NOT_FOUND);
  rita.s.close();
  await until(async () => (await listed()).side[0].guests === 1, 3000, 'Rita\'s page gone');
  const ritaBack = await guest(CODE, 'Rita', 'research', { uid: rita.j.identity });
  assert.deepEqual([ritaBack.j.ok, ritaBack.j.role], [true, 'research'], 'back within the grace, to her seat');
  assert.deepEqual((await guest(CODE, 'Rita', 'observer', { uid: rita.j.identity })).j, NOT_FOUND, 'a seat she did not hold');
  // A change that keeps them, asked again: done, no row.
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false, keepGuests: true }), { ok: true, already: true, codeOn: false });

  // Turn off and send them out: each guest page is told why and closed, the seats they held go (the op clears the saved
  // ones too), the accounts stay; a guest sent out comes back to no seat.
  assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: LEGAL, on: true })).locked);
  const out = [once(ritaBack.s, 'kicked'), once(olly.s, 'kicked')];
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false, keepGuests: false }), { ok: true, codeOn: false, sentOut: 2 });
  assert.deepEqual(await Promise.all(out), [{ reason: 'This room is for signed-in accounts now.' }, { reason: 'This room is for signed-in accounts now.' }]);
  await until(() => !ritaBack.s.connected && !olly.s.connected, 3000, 'the guest pages closed');
  assert.ok(anaPage.connected, 'an account\'s page stays');
  const resumed = await emit(anaPage, 'join', { roomCode: LEGAL, as: 'account', since: 0 });
  const metas = resumed.ops.filter((op) => op.o === 'meta' && op.settings && Object.hasOwn(op.settings, 'codeOff')).map((op) => op.settings);
  assert.deepEqual(metas, [{ codeOff: false }, { codeOff: true }, { codeOff: true, seats: {} }], 'each switch one meta op: the code\'s state, never the code');
  assert.deepEqual((await guest(CODE, 'Rita', 'research', { uid: rita.j.identity })).j, NOT_FOUND, 'sent out: no seat to come back to');
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false, keepGuests: false }), { ok: true, already: true, codeOn: false }, 'nobody left to send out');

  // One row for each switch that changed something, naming the room by its key and counting guest pages, never the code.
  assert.deepEqual(rowsOf(srv.dataDir, 'room.code'), [[LEGAL, 'code on', 'ana'], [LEGAL, 'code off (2 guest pages kept)', 'ana'], [LEGAL, 'code off (2 guest pages sent home)', 'ana']]);
  assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').includes(CODE), 'no audit row carries the guest code');
});

test('New code: the code before admits only a person seated there and spends no lock, the invites made with it stop, the hall\'s key stops being its code, and the new one outlives a restart', async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const show = await showOf(srv, t);
  const hallA = await show.hall('Hall A');
  const ctl = await show.page(show.admin);
  // A locked hall: its invite links are made with its code, which is its key.
  assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallA, on: true })).locked);
  const oldInvites = (await emit(ctl, 'admin:invites', { roomCode: hallA })).invites;
  assert.deepEqual(Object.keys(oldInvites), ['board', 'research']);
  assert.ok(oldInvites.research.startsWith('/?code=' + hallA + '&role=research&invite='));
  const inviteOf = (link) => new URL(link, srv.base).searchParams.get('invite');
  const rita = await show.guest(hallA, 'Rita', 'research', { invite: inviteOf(oldInvites.research) });
  assert.deepEqual([rita.j.ok, rita.j.role, rita.j.guestCode], [true, 'research', hallA]);

  const ritaTold = once(rita.s, 'guestCode');
  const renewed = await act(ctl, 'room:update', { code: hallA, newCode: true });
  assert.ok(renewed.ok && /^[A-Z2-9]{6}$/.test(renewed.guestCode) && renewed.guestCode !== hallA, JSON.stringify(renewed));
  const NEW = renewed.guestCode;
  assert.deepEqual(await ritaTold, { guestCode: '', codeOn: true }, 'a guest in the room stays, and is not handed the new code');
  assert.ok(rita.s.connected);
  // The hall's key is an address now: looked up, it is a wrong code; the new code opens the hall.
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + hallA)).body, MISS(hallA));
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + NEW)).body, { code: NEW, exists: true, name: 'Hall A', locked: true, hallName: 'Hall A', main: true });
  const row = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms.find((h) => h.code === hallA);
  assert.deepEqual([row.guestCode, row.codeIsKey], [NEW, false]);
  // The invites made with the code before stop: with the new code an old link seats an observer, with the old code nobody.
  const newInvites = (await emit(ctl, 'admin:invites', { roomCode: hallA })).invites;
  assert.ok(newInvites.research.startsWith('/?code=' + NEW + '&role=research&invite=') && inviteOf(newInvites.research) !== inviteOf(oldInvites.research));
  const stale = await show.guest(NEW, 'Sam', 'research', { invite: inviteOf(oldInvites.research) });
  assert.deepEqual([stale.j.ok, stale.j.role, stale.j.note], [true, 'observer', 'This room needs an invite link for that seat — you joined as an observer.']);
  const fresh = await show.guest(NEW, 'Tia', 'research', { invite: inviteOf(newInvites.research) });
  assert.deepEqual([fresh.j.role, fresh.j.guestCode], ['research', NEW]);
  assert.deepEqual((await show.guest(hallA, 'Uma', 'research', { invite: inviteOf(oldInvites.research) })).j, NOT_FOUND);
  // The code before admits whoever holds a seat: Rita, back from a drop on the link she has, told no code.
  rita.s.close();
  await wait(300);
  const ritaBack = await show.guest(hallA, 'Rita', 'research', { uid: rita.j.identity });
  assert.deepEqual([ritaBack.j.ok, ritaBack.j.role, ritaBack.j.roomCode, ritaBack.j.guestCode], [true, 'research', hallA, '']);
  // An earlier code spends no join lock (a hall of phones coming back on it behind one address is not locked out): a dozen
  // refused, and a join still goes through.
  for (let i = 0; i < 12; i++) assert.deepEqual((await show.guest(hallA, 'Walk-in ' + i, 'observer')).j, NOT_FOUND);
  assert.ok((await show.guest(NEW, 'Vic', 'observer')).j.ok, 'the join lock is not spent by an earlier code');
  assert.deepEqual(rowsOf(srv.dataDir, 'room.code'), [[hallA, 'a new code was issued', 'ana']]);
  assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').includes(NEW), 'no row carries the new code');

  // A restart keeps the new code and the one before it, written with the hall's snapshot (0.5.1's shape and two fields).
  for (const s of show.sockets) s.close();
  srv = await restartServer(srv);
  const snapshot = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', hallA + '.json'), 'utf8'));
  assert.deepEqual([snapshot.guestCode, snapshot.retired, Object.keys(snapshot).slice(-2)], [NEW, [hallA], ['guestCode', 'retired']]);
  assert.equal((await api(srv.base, 'GET', '/api/rooms/' + NEW)).body.exists, true);
  assert.deepEqual((await api(srv.base, 'GET', '/api/rooms/' + hallA)).body, MISS(hallA));
  const wes = await connect(srv.base);
  t.after(() => wes.close());
  const wesIn = await emit(wes, 'join', { roomCode: NEW, name: 'Wes', role: 'observer' });
  assert.deepEqual([wesIn.ok, wesIn.guestCode], [true, NEW]);
});

test('a code switched off counts against the lookup\'s lock and the join\'s, as a wrong code does: none can be told from another', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, hall } = await showOf(srv, t);
  const hallA = await hall('Hall A');
  const ctl = await page(admin);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const OFF = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms[0].side[0].guestCode;
  // Twelve misses lock the lookup for this network (its burst of ten taken, then at its pace): a code switched off is
  // one of them, and a code that opens a room is refused after.
  let misses = 0;
  for (let i = 0; misses < 12 && i < 60; i++) {
    const r = await api(srv.base, 'GET', '/api/rooms/' + (i % 2 ? OFF : 'ZZZ234'));
    if (r.status === 200) { assert.deepEqual(r.body, MISS(i % 2 ? OFF : 'ZZZ234')); misses++; } else { assert.equal(r.status, 429); await wait(600); }
  }
  assert.equal(misses, 12);
  await wait(1100);   // the bucket has tokens again: what refuses now is the lock
  assert.equal((await api(srv.base, 'GET', '/api/rooms/' + hallA)).status, 429, 'locked out after twelve misses, a code switched off among them');
  // Ten refused joins lock the network's joins, a code that opens a room included.
  for (let i = 0; i < 10; i++) assert.deepEqual(await emit(await page(), 'join', { roomCode: i % 2 ? OFF : 'ZZZ234', name: 'Probe ' + i, role: 'observer' }), NOT_FOUND);
  assert.deepEqual(await emit(await page(), 'join', { roomCode: hallA, name: 'Wes', role: 'observer' }), { ok: false, error: 'Too many attempts — wait a minute.' });
  assert.ok(LEGAL);
});

test('who is told a room\'s guest code: the admin, those who set halls up, an account whose rights cover what the code gives, a guest the code it typed; never a Viewer, a Staff account in a Main room, an On stage page, nor any frame, op, resume or row of a page that may not know it', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, account, hall, guest } = await showOf(srv, t);
  const hallA = await hall('Hall A');
  const [tom, sid, vic, pat] = [await account('tom', 'tech', { halls: [hallA] }), await account('sid', 'staff', { halls: [hallA] }), await account('vic', 'viewer', { halls: [hallA] }), await account('pat', 'manager')];
  const ctl = await page(admin);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  assert.ok((await act(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok);

  // Every frame each page hears, from its first packet.
  const heard = new Map();
  const listen = async (who, cookie) => { const s = await page(cookie); const frames = []; s.onAny((ev, x) => frames.push([ev, x])); heard.set(who, frames); return s; };
  const pages = {};
  for (const [who, cookie] of [['tom', tom], ['sid', sid], ['vic', vic]]) {
    pages[who] = await listen(who, cookie);
    const j = await emit(pages[who], 'join', { roomCode: hallA, as: 'account' });
    assert.ok(j.ok, who + ' ' + JSON.stringify(j));
    pages[who].joined = j;
  }
  const chair = await listen('chair', undefined);
  const onStage = await emit(chair, 'join', { roomCode: hallA, name: 'Chair', role: 'board' });
  const obs = await listen('obs', undefined);
  const obsIn = await emit(obs, 'join', { roomCode: hallA, name: 'Obi', role: 'observer' });
  const lou = await listen('lou', undefined);
  const louIn = await emit(lou, 'join', { roomCode: (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms[0].side[0].guestCode, name: 'Lou', role: 'research' });
  // The join's answer: a tech's rights cover what the hall's code gives, a Staff account's and a Viewer's do not; an On
  // stage page is handed none; a guest is told the code it typed (an observer too), a side room's guest its own.
  assert.deepEqual([pages.tom.joined.guestCode, pages.sid.joined.guestCode, pages.vic.joined.guestCode, onStage.guestCode, obsIn.guestCode, louIn.ok], [hallA, '', '', '', hallA, true]);
  // The halls board and /api/halls: the same rule, with the code's state.
  const boardRow = async (cookie) => (await emit(await page(cookie), 'board:watch', {})).board.halls.find((h) => h.code === hallA);
  const apiRow = async (cookie) => (await api(srv.base, 'GET', '/api/halls', undefined, { cookie })).body.halls.find((h) => h.code === hallA);
  const told = {};
  for (const [who, cookie] of [['tom', tom], ['sid', sid], ['vic', vic], ['pat', pat], ['ana', admin]]) told[who] = [(await boardRow(cookie)).guestCode, (await apiRow(cookie)).guestCode, (await apiRow(cookie)).codeOn];
  assert.deepEqual(told, { tom: [hallA, hallA, true], sid: ['', '', true], vic: ['', '', true], pat: [hallA, hallA, true], ana: [hallA, hallA, true] });

  // New code for the hall: each page in it is told it as it may know it, and the board is drawn again.
  const tomTold = once(pages.tom, 'guestCode');
  const vicTold = once(pages.vic, 'guestCode');
  const watcher = await page(sid);
  const boards = [];
  watcher.on('board', (b) => boards.push(b));
  await emit(watcher, 'board:watch', {});
  const NEW = (await act(ctl, 'room:update', { code: hallA, newCode: true })).guestCode;
  assert.deepEqual([await tomTold, await vicTold], [{ guestCode: NEW, codeOn: true }, { guestCode: '', codeOn: true }]);
  await until(() => boards.length > 0, 3000, 'the board drawn again');
  assert.equal(boards.at(-1).halls.find((h) => h.code === hallA).guestCode, '', 'a Staff account\'s board is not told it');
  assert.equal((await boardRow(tom)).guestCode, NEW);
  // A resume holds every op the hall has: none carries the new code; nor does any audit row.
  const all = await emit(ctl, 'join', { roomCode: hallA, as: 'account', since: 0 });
  assert.ok(Array.isArray(all.ops) && all.ops.length > 3);
  assert.ok(!JSON.stringify(all.ops).includes(NEW), 'no op, in the ring or a resume, carries the code');
  assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').includes(NEW), 'no audit row carries it');
  // Each page that may not know it heard every frame of the change and of the room since it joined: none carries it.
  await wait(300);
  for (const who of ['sid', 'vic', 'chair', 'obs', 'lou']) assert.ok(!JSON.stringify(heard.get(who)).includes(NEW), who + ' heard no frame with the new code');
  assert.ok(JSON.stringify(heard.get('tom')).includes(NEW), 'the tech heard it');
  // The new code's guests and those who set halls up are told it.
  assert.equal((await guest(NEW, 'Gus', 'research')).j.guestCode, NEW);
  assert.equal((await emit(await page(pat), 'room:settings', { code: hallA })).guestCode, NEW);
});

test('a room\'s settings (Set up\'s Rooms) tell each of the hall\'s rooms with its code as that page may be told it, whether it admits guests and how many guest pages are in it: a project manager seated On stage in the hall is told none of its Main room\'s code, there or in its row', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, account, hall, guest } = await showOf(srv, t);
  const hallA = await hall('Hall A');
  const ctl = await page(admin);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  assert.ok((await act(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok);
  const legalCode = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms[0].side[0].guestCode;
  // Hall A's code renewed, so its code is no longer its key (the residual ends): what is told of it is the code alone.
  const NEW = (await act(ctl, 'room:update', { code: hallA, newCode: true })).guestCode;
  assert.ok(typeof NEW === 'string' && NEW.length === 6 && NEW !== hallA);
  // Two guest pages in Legal: counted, never named.
  for (const name of ['Gus', 'Gil']) assert.ok((await guest(legalCode, name, 'research')).j.ok);
  const rows = (s) => s.rooms.map((r) => [r.key, r.main, r.guestCode, r.codeOn, r.guests]);
  const pat = await account('pat', 'manager');
  const patSays = await emit(await page(pat), 'room:settings', { code: hallA });
  assert.deepEqual([patSays.guestCode, rows(patSays)], [NEW, [[hallA, true, NEW, true, 0], [LEGAL, false, legalCode, true, 2]]], 'those who set halls up are told every room\'s code, its state and its guest pages');
  // A project manager whose account sits On stage in Hall A's Main room: its own page is no Board tablet, but the rule
  // every list reads holds here too, so Set up never hands it the code of the hall it sits On stage in.
  const kai = await account('kai', 'manager', { board: [hallA] });
  const kaiSays = await emit(await page(kai), 'room:settings', { code: hallA });
  assert.deepEqual([kaiSays.ok, kaiSays.guestCode, rows(kaiSays)], [true, '', [[hallA, true, '', true, 0], [LEGAL, false, legalCode, true, 2]]]);
  assert.ok(!JSON.stringify(kaiSays).includes(NEW), 'Hall A\'s code is nowhere in its answer');
  assert.equal((await emit(await page(kai), 'room:settings', { code: LEGAL })).guestCode, legalCode, 'Legal\'s, where it does not sit On stage');
  assert.ok(!JSON.stringify(kaiSays).includes('Gus') && !JSON.stringify(patSays).includes('Gil'), 'a count, never who');
  // The halls board agrees: its row is told no code either.
  const kaiRow = (await emit(await page(kai), 'board:watch', {})).board.halls.find((h) => h.code === hallA);
  assert.deepEqual([kaiRow.guestCode, JSON.stringify(kaiRow).includes(NEW)], ['', false]);
});

test('the laptop\'s token admin\'s own page is a member of every room: a code admits it on or off, and so does a key, its misses spend no lock, and it is never a guest page (not counted, not sent out, no seat saved); a send-out with two seated guests is one meta op; a side room\'s invites are a Member\'s, made with its code', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, hall, guest } = await showOf(srv, t);
  const tok = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hallA = await hall('Hall A');
  const ctl = await page(admin);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const side = async () => (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms.find((h) => h.code === hallA).side[0];
  const CODE = (await side()).guestCode;

  // A side room's invites: a Member's alone, made with its guest code, with whether that code admits now.
  assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: LEGAL, on: true })).locked);
  const invites = await emit(ctl, 'admin:invites', { roomCode: LEGAL });
  assert.deepEqual([Object.keys(invites.invites), invites.codeOn], [['research'], false]);
  assert.ok(invites.invites.research.startsWith('/?code=' + CODE + '&role=research&invite='), invites.invites.research);
  assert.ok((await act(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok);
  const member = new URL(invites.invites.research, srv.base).searchParams.get('invite');
  // Locked, a Member's seat is the link's; without it a guest sits as an observer.
  const rita = await guest(CODE, 'Rita', 'research', { invite: member });
  const gil = await guest(CODE, 'Gil', 'research', { invite: member });
  const sam = await guest(CODE, 'Sam', 'research');
  assert.deepEqual([rita.j.role, gil.j.role, sam.j.role, sam.j.note], ['research', 'research', 'observer', 'This room needs an invite link for that seat — you joined as an observer.']);

  // The token admin's own page, by the room's key: seated, told the code, may switch it there, and no guest page.
  const own = await page(tok);
  const ownIn = await emit(own, 'join', { roomCode: LEGAL, name: 'Laptop', role: 'research' });
  assert.deepEqual([ownIn.ok, ownIn.role, ownIn.main, ownIn.guestCode, ownIn.setsCode], [true, 'research', false, CODE, true]);
  assert.equal((await side()).guests, 3, 'three guest pages: the token admin\'s own is none');

  // Turn off and send them out: one meta op (the switch, every seat a guest held gone), none more as each page closes; the
  // token admin's page stays.
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false, keepGuests: false }), { ok: true, codeOn: false, sentOut: 3 });
  await until(() => !rita.s.connected && !gil.s.connected && !sam.s.connected, 3000, 'the guest pages closed');
  await wait(300);
  assert.ok(own.connected, 'the token admin\'s own page stays');
  const resumed = await emit(own, 'join', { roomCode: LEGAL, name: 'Laptop', role: 'research', uid: ownIn.identity, since: ownIn.seq });
  assert.deepEqual(resumed.ops.filter((op) => op.o === 'meta').map((op) => op.settings), [{ codeOff: true, seats: {} }], 'one meta op for the send-out, none for each page it closed');
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, codeOn: false, keepGuests: false }), { ok: true, already: true, codeOn: false }, 'nobody left to send out: the token admin\'s page holds no seat');

  // Off, the token admin comes back by the code and by the key; a guest does not.
  for (const [roomCode, name] of [[CODE, 'Laptop 2'], [LEGAL, 'Laptop 3']]) {
    const j = await emit(await page(tok), 'join', { roomCode, name, role: 'research' });
    assert.deepEqual([j.ok, j.role, j.codeOn], [true, 'research', false], roomCode);
  }
  assert.deepEqual((await guest(CODE, 'Rita', 'research', { uid: rita.j.identity })).j, NOT_FOUND);
  assert.equal((await side()).guests, 0, 'the token admin\'s pages are no guest pages');
  // Its misses are not code guessing: a dozen spend no join lock.
  const probe = await page(tok);
  for (let i = 0; i < 12; i++) assert.deepEqual(await emit(probe, 'join', { roomCode: 'ZZZ234', name: 'Laptop', role: 'observer' }), NOT_FOUND);
  assert.ok((await guest(hallA, 'Wes', 'observer')).j.ok, 'the token admin\'s misses spend no join lock');
});

test('the admin\'s support view is told of a room\'s code what the person\'s own page is told, and switches nothing (R8)', async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const { page, admin, account, hall, guest } = await showOf(srv, t);
  const hallA = await hall('Hall A');
  const [tom, sid] = [await account('tom', 'tech', { halls: [hallA] }), await account('sid', 'staff', { halls: [hallA] })];
  for (const cookie of [tom, sid]) assert.ok((await emit(await page(cookie), 'join', { roomCode: hallA, as: 'account' })).ok);
  assert.ok((await guest(hallA, 'Gus', 'research')).j.ok);
  const view = async (name) => { const s = await page(admin); return { s, j: await emit(s, 'join', { roomCode: hallA, adminView: true, name, role: 'research' }) }; };
  const views = { tom: await view('tom'), sid: await view('sid'), Gus: await view('Gus'), nobody: await view('Nobody') };
  const facts = (pick) => Object.fromEntries(Object.entries(views).map(([who, v]) => [who, pick(v)]));
  assert.deepEqual(facts((v) => [v.j.ok, v.j.guestCode, v.j.setsCode]), { tom: [true, hallA, false], sid: [true, '', false], Gus: [true, hallA, false], nobody: [true, '', false] },
    'a Tech\'s view shows the code, a Staff account\'s none, a guest\'s the code it typed, one of nobody here none; none may switch it');
  // Renewed, each view is told it as the person's page is: the Tech the new code, the others none.
  const told = facts((v) => once(v.s, 'guestCode'));
  const NEW = (await act(await page(admin), 'room:update', { code: hallA, newCode: true })).guestCode;
  assert.deepEqual({ tom: await told.tom, sid: await told.sid, Gus: await told.Gus, nobody: await told.nobody },
    { tom: { guestCode: NEW, codeOn: true }, sid: { guestCode: '', codeOn: true }, Gus: { guestCode: '', codeOn: true }, nobody: { guestCode: '', codeOn: true } });
});
