'use strict';
// Which rooms may send into a room (plan 1-§4.1), end to end: a list per room of rooms of any hall, set by the admin alone
// with `room:update {sendFrom}` (and `sendBack`, its "↔ and send back"s: the rooms it sends into, the room put on the list
// of each and taken off the list of every other that names it), each key a room that is here and not the room itself,
// each once, at most 50, an unknown key refused in words and never dropped; saved once in the settings (`roomSends`,
// absent until a list is set and again once none is left) and one `room.sendFrom` row naming the rooms by name, never a
// key; kept across a restart; told only to those who read a room's settings (the admin, and those who set halls up, who
// are not told every hall's rooms); what the picker draws, both ways, is what is kept, a save from it removing no ↔ it
// did not draw unticked; a room removed, or a hall with its rooms, taken off every list, and one whose files another
// program held keeping its places through a save until it comes back; no page in a room ever sent a list. The picker's
// pure half (public/sendfrom.js) last.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { RoomStore } = require('../lib/store');
const { ROOT, startServer, restartServer, stopServer, api, connect, emit, once, until, wait, TOKEN, readSource } = require('./helpers');
const ops = require('../lib/ops');

/** An audit row as the tests read it: its target, its words, who. */
const rowsOf = (dataDir, action) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action === action).map((e) => [e.target, e.words, e.actor.name]);
/** The settings as saved: the file, read whole (a save in flight is waited for by the caller). */
const settingsOf = (dataDir) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); } catch { return null; } };   // a save in flight is read again
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}
const PASSWORD = 'the green room kettle';
/** The picker's pure half (public/sendfrom.js), as the pages load it. */
function loadPicker() {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'sendfrom.js')), ctx, { filename: 'sendfrom.js' });
  return ctx.AGM.sendFrom;
}
/** A value made in the picker's context, as this one compares it. */
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The lists as saved, each room's and each list sorted: the order a start reads the rooms in is the folder's. */
const listsOf = (dataDir) => { const all = (settingsOf(dataDir) || {}).roomSends || {}; return JSON.stringify(Object.keys(all).sort().map((k) => [k, [...all[k]].sort()])); };
const listsAs = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, [...o[k]].sort()]));
/** An answer of room:update with its lists sorted, as `listsOf`. */
const sorted = (r) => ({ ...r, ...Object.fromEntries(['sendFrom', 'sendBack', 'into', 'notInto'].filter((k) => Array.isArray(r[k])).map((k) => [k, [...r[k]].sort()])) });

test('which rooms may send into a room: the admin\'s alone, each key a room that is here and not itself, once each, at most 50, ↔ and send back in the same save, one row; what the picker draws, both ways, is what is kept; told only to who reads a room\'s settings; kept across a restart; taken off every list as a room or a hall goes', { timeout: 120_000 }, async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  let admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: PASSWORD })).cookie;
  const account = async (username, role, extra = {}) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: 'clipboard and coffee', ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: 'clipboard and coffee' })).cookie;
  };
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  let ctl = await page(admin);
  const made = async (h, name) => { const r = await act(ctl, 'room:create', { hall: h, name }); assert.ok(r.ok, JSON.stringify(r)); return r.key; };
  const LEGAL = await made(hallA, 'Legal');
  const MEDIA = await made(hallB, 'Media');
  const pat = await page(await account('pat', 'manager'));   // sets halls up; not the admin
  const louCookie = await account('lou', 'staff', { rooms: [LEGAL] });   // given Legal alone

  // Every frame and answer two pages in rooms are sent while the lists change: Lou's in Legal (and its halls board), a
  // guest's in Hall B's Main room.
  const heard = { lou: [], gus: [] };
  const lou = await page(louCookie);
  lou.onAny((ev, ...args) => heard.lou.push([ev, args]));
  // A join's answer, kept beside the frames the page heard before it (its own joined line may come first).
  const louJoined = await emit(lou, 'join', { roomCode: LEGAL, as: 'account' });
  heard.lou.push(['join', louJoined]);
  assert.equal(louJoined.ok, true, JSON.stringify(louJoined));
  const louBoard = await page(louCookie);
  louBoard.onAny((ev, ...args) => heard.lou.push([ev, args]));
  heard.lou.push(['board:watch', await emit(louBoard, 'board:watch', {})]);
  const gus = await page();
  gus.onAny((ev, ...args) => heard.gus.push([ev, args]));
  const gusJoined = await emit(gus, 'join', { roomCode: hallB, name: 'Gus', role: 'research' });
  heard.gus.push(['join', gusJoined]);
  assert.equal(gusJoined.ok, true, JSON.stringify(gusJoined));

  // None at first: no list is kept, and the admin is told every hall's rooms a list may name.
  const told = (s, code) => act(s, 'room:settings', { code });
  const before = await told(ctl, LEGAL);
  assert.deepEqual([before.sendFrom, before.sendBack, before.rooms.map((r) => r.sendFrom)], [[], [], [[], []]]);
  assert.deepEqual(before.everyHall, [
    { key: hallA, name: 'Hall A', rooms: [{ key: hallA, name: 'Hall A', main: true }, { key: LEGAL, name: 'Legal', main: false }] },
    { key: hallB, name: 'Hall B', rooms: [{ key: hallB, name: 'Hall B', main: true }, { key: MEDIA, name: 'Media', main: false }] },
  ]);
  assert.ok(!Object.hasOwn(settingsOf(srv.dataDir), 'roomSends'), 'no list is saved until one is set');

  // The admin's alone: one who sets halls up is refused, and a member of the room is told nothing of it.
  assert.deepEqual(await act(pat, 'room:update', { code: LEGAL, sendFrom: [hallB] }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(pat, 'room:update', { code: LEGAL, sendBack: [] }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(lou, 'room:update', { code: LEGAL, sendFrom: [hallB] }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(lou, 'room:settings', { code: LEGAL }), { ok: false, error: 'Your account may not set halls up.' });
  // Read by type, each refused in words, with nothing saved: an unknown key is never dropped, a list is never cut.
  const NOTHING = 'Nothing was saved.';
  const fifty = Array.from({ length: 51 }, (_, i) => 'K' + String(i).padStart(7, '0'));
  for (const [args, error] of [
    [{ code: LEGAL, sendFrom: hallB }, 'Say which rooms may send here: a list of their keys (an empty list for none).'],
    [{ code: LEGAL, sendFrom: [hallB, 7] }, 'Say which rooms may send here: a list of their keys (an empty list for none).'],
    [{ code: LEGAL, sendFrom: [hallB], sendBack: hallB }, 'Say which of them this room sends back into: a list of their keys.'],
    [{ code: LEGAL, sendBack: [hallB] }, 'Which rooms it sends back into is said with the rooms that may send in (sendFrom).'],
    [{ code: LEGAL, codeOn: true, sendBack: [] }, 'Which rooms it sends back into is said with the rooms that may send in (sendFrom).'],
    [{ code: LEGAL, sendFrom: [hallB], keepGuests: true }, 'Whether the guests stay is said as the code is switched off.'],
    [{ code: LEGAL, newCode: true, keepGuests: false }, 'Whether the guests stay is said as the code is switched off.'],
    [{ code: LEGAL, sendFrom: [hallB, 'NOROOM12'] }, 'No such room: NOROOM12. ' + NOTHING],
    [{ code: LEGAL, sendFrom: [hallB, LEGAL.toLowerCase()] }, 'A room does not send into itself: leave it off its own list. ' + NOTHING],
    [{ code: LEGAL, sendFrom: fifty }, 'At most 50 rooms may send into one room: this list names 51. ' + NOTHING],
    [{ code: LEGAL, sendFrom: [hallB], sendBack: [MEDIA] }, 'This room sends back only into a room that may send here: tick that room too. ' + NOTHING],
    [{ code: LEGAL, sendFrom: [hallB], sendBack: ['NOROOM12'] }, 'No such room: NOROOM12. ' + NOTHING],
    [{ code: LEGAL, sendFrom: [hallB], sendBack: [LEGAL] }, 'A room does not send into itself: leave it off its own list. ' + NOTHING],
    [{ code: LEGAL, sendFrom: [hallB], name: 'Lawyers' }, 'One change at a time: the name, the code on or off, a new code, or the rooms that may send in.'],
    [{ code: LEGAL, sendFrom: [hallB], sendTo: [hallB] }, 'A room\'s name, its guest code and the rooms that may send into it are the settings changed here.'],
    [{ code: 'NOROOM12', sendFrom: [hallB] }, 'No such room.'],
  ]) assert.deepEqual(await act(ctl, 'room:update', args), { ok: false, error }, JSON.stringify(args).slice(0, 120));
  const still = await told(ctl, LEGAL);
  assert.deepEqual([still.sendFrom, still.codeOn, still.guestCode], [[], false, before.guestCode], 'nothing was saved, switched or renewed');

  // Set: each key once (in any case), in the order given; saved, told, and one row naming the rooms, never a key.
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, sendFrom: [hallB, hallB.toLowerCase(), MEDIA, hallB] }), { ok: true, sendFrom: [hallB, MEDIA], sendBack: [], into: [], notInto: [] });
  await until(() => JSON.stringify((settingsOf(srv.dataDir) || {}).roomSends) === JSON.stringify({ [LEGAL]: [hallB, MEDIA] }), 4000, 'the list saved');
  const fromB = [{ key: hallB, name: 'Hall B', main: true, hallName: 'Hall B' }, { key: MEDIA, name: 'Media', main: false, hallName: 'Hall B' }];
  const legal = await told(ctl, LEGAL);
  assert.deepEqual([legal.sendFrom, legal.sendBack, legal.rooms.find((r) => r.key === LEGAL).sendFrom, legal.rooms.find((r) => r.main).sendFrom], [fromB, [], fromB, []]);
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, sendFrom: [MEDIA, hallB] }), { ok: true, already: true, sendFrom: [hallB, MEDIA], sendBack: [] }, 'the same rooms in another order: done, no row');
  // ↔ and send back: Legal put on Media's list in the same save; both lists' changes in one row.
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, sendFrom: [hallB, MEDIA], sendBack: [MEDIA] }), { ok: true, sendFrom: [hallB, MEDIA], sendBack: [MEDIA], into: [MEDIA], notInto: [] });
  await until(() => JSON.stringify((settingsOf(srv.dataDir) || {}).roomSends) === JSON.stringify({ [LEGAL]: [hallB, MEDIA], [MEDIA]: [LEGAL] }), 4000, 'both lists saved');
  // One who sets halls up reads the lists, each room by name and key, and is not told every hall's rooms.
  const media = await told(pat, MEDIA);
  assert.deepEqual([media.sendFrom, media.sendBack, Object.hasOwn(media, 'everyHall')], [[{ key: LEGAL, name: 'Legal', main: false, hallName: 'Hall A' }], [LEGAL], false]);
  // The ↔ unticked, with Hall B's Main room: Legal taken off Media's list, which then holds none and is gone.
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, sendFrom: [MEDIA], sendBack: [] }), { ok: true, sendFrom: [MEDIA], sendBack: [], into: [], notInto: [MEDIA] });
  await until(() => JSON.stringify((settingsOf(srv.dataDir) || {}).roomSends) === JSON.stringify({ [LEGAL]: [MEDIA] }), 4000, 'Media\'s list gone');
  assert.deepEqual(await act(ctl, 'room:update', { code: LEGAL, sendFrom: [MEDIA], sendBack: [MEDIA] }), { ok: true, sendFrom: [MEDIA], sendBack: [MEDIA], into: [MEDIA], notInto: [] }, 'only the ↔ changed');
  assert.deepEqual(await act(ctl, 'room:update', { code: hallB, sendFrom: [LEGAL] }), { ok: true, sendFrom: [LEGAL], sendBack: [], into: [], notInto: [] }, 'a Main room has a list too; sendBack not given leaves Legal\'s as it is');
  await until(() => JSON.stringify((settingsOf(srv.dataDir) || {}).roomSends) === JSON.stringify({ [LEGAL]: [MEDIA], [MEDIA]: [LEGAL], [hallB]: [LEGAL] }), 4000, 'the three lists');
  assert.deepEqual(rowsOf(srv.dataDir, 'room.sendFrom'), [
    [LEGAL, 'may send here: Main (Hall B), Media (Hall B)', 'ana'],
    [LEGAL, 'may send here: Main (Hall B), Media (Hall B); it sends back into: Media (Hall B)', 'ana'],
    [LEGAL, 'may send here: Media (Hall B); it no longer sends into: Media (Hall B)', 'ana'],
    [LEGAL, 'may send here: Media (Hall B); it sends back into: Media (Hall B)', 'ana'],
    [hallB, 'may send here: Legal (Hall A)', 'ana'],
  ]);

  // No page in a room was sent a list, nor a key of a room of another hall on it.
  await wait(300);   // the last frames in flight
  const lists = /sendFrom|sendBack|roomSends|everyHall/;
  for (const [who, frames, others] of [['Lou, in Legal', heard.lou, [hallB, MEDIA]], ['Gus, in Hall B', heard.gus, [LEGAL]]]) {
    const all = JSON.stringify(frames);
    assert.ok(frames.length > 2, who + ' heard frames');
    assert.ok(!lists.test(all), who + ' was sent no list: ' + (all.match(lists) || [''])[0]);
    for (const k of others) assert.ok(!all.includes(k), who + ' was sent no key of a room of another hall on a list');
  }
  const louHalls = JSON.stringify((await api(srv.base, 'GET', '/api/halls', undefined, { cookie: louCookie })).body);
  assert.ok(!lists.test(louHalls) && !louHalls.includes(MEDIA) && !louHalls.includes(hallB), 'nor in /api/halls');

  // Kept across a restart, as it was set.
  srv = await restartServer(srv);
  admin = (await api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: PASSWORD })).cookie;
  ctl = await page(admin);
  const again = await told(ctl, LEGAL);
  assert.deepEqual([again.sendFrom.map((r) => r.key), [...again.sendBack].sort()], [[MEDIA], [hallB, MEDIA].sort()], 'Legal sends into Media and Hall B');
  assert.deepEqual((await told(ctl, hallB)).sendFrom.map((r) => r.key), [LEGAL]);

  // What the picker draws is what is kept, both ways, and a save from it takes away no ↔ it did not draw unticked (its own
  // pure half against this server). Legal sends into Hall B's Main room, which may not send into Legal: drawn unticked
  // with its ↔ ticked. Ticked, the ↔ left as drawn: Hall B's list still names Legal.
  const P = loadPicker();
  const drawn = (settings) => P.groupsFor(settings).flatMap((g) => g.rooms);
  const rowOf = (settings, key) => { const r = drawn(settings).find((x) => x.key === key); return { on: r.on, back: r.back }; };
  const save = async (settings, edit) => {
    const change = plain(P.changeOf(settings, drawn(settings).map(({ key, on, back }) => (key === edit.key ? { key, on, back, ...edit } : { key, on, back }))));
    const res = await act(ctl, 'room:update', change);
    return [change, sorted(res), P.words(res, 'Hall A › Legal', settings)];
  };
  let open = await told(ctl, LEGAL);
  assert.deepEqual(rowOf(open, hallB), { on: false, back: true }, 'Legal sends into Hall B, which may not send into Legal');
  assert.deepEqual(await save(open, { key: hallB, on: true }), [
    { code: LEGAL, sendFrom: [hallB, MEDIA], sendBack: [hallB, MEDIA] },
    sorted({ ok: true, sendFrom: [hallB, MEDIA], sendBack: [hallB, MEDIA], into: [], notInto: [] }),
    'Saved: 2 rooms may send into Hall A › Legal.',
  ]);
  await until(() => listsOf(srv.dataDir) === listsAs({ [LEGAL]: [hallB, MEDIA], [MEDIA]: [LEGAL], [hallB]: [LEGAL] }), 4000, 'Hall B\'s list kept');
  open = await told(ctl, LEGAL);
  assert.deepEqual(rowOf(open, hallB), { on: true, back: true }, 'both ways, as kept');
  // Unticked, its ↔ left as it is: Legal still sends into Hall B, and the picker says so when it opens again.
  assert.deepEqual(await save(open, { key: hallB, on: false }), [
    { code: LEGAL, sendFrom: [MEDIA], sendBack: [hallB, MEDIA] },
    sorted({ ok: true, sendFrom: [MEDIA], sendBack: [hallB, MEDIA], into: [], notInto: [] }),
    'Saved: 1 room may send into Hall A › Legal.',
  ]);
  open = await told(ctl, LEGAL);
  assert.deepEqual([rowOf(open, hallB), (await told(ctl, hallB)).sendFrom.map((r) => r.key)], [{ on: false, back: true }, [LEGAL]], 'what is drawn is what is kept');
  // Its ↔ unticked too: Legal taken off Hall B's list, said by name.
  assert.deepEqual(await save(open, { key: hallB, back: false }), [
    { code: LEGAL, sendFrom: [MEDIA], sendBack: [MEDIA] },
    sorted({ ok: true, sendFrom: [MEDIA], sendBack: [MEDIA], into: [], notInto: [hallB] }),
    'Saved: 1 room may send into Hall A › Legal. It no longer sends into Hall B.',
  ]);
  open = await told(ctl, LEGAL);
  assert.deepEqual([rowOf(open, hallB), (await told(ctl, hallB)).sendFrom], [{ on: false, back: false }, []]);
  await until(() => listsOf(srv.dataDir) === listsAs({ [LEGAL]: [MEDIA], [MEDIA]: [LEGAL] }), 4000, 'Hall B\'s list gone');
  assert.deepEqual(await act(ctl, 'room:update', { code: hallB, sendFrom: [LEGAL] }), { ok: true, sendFrom: [LEGAL], sendBack: [], into: [], notInto: [] }, 'set again from Hall B');

  // A room whose own list holds 50 takes no 51st by ↔: the whole save is refused, Hall A's list with it.
  await stopServer(srv.child);
  const file = path.join(srv.dataDir, 'settings.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.roomSends[MEDIA] = [LEGAL, ...fifty.slice(0, 49)];
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  srv = await startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  admin = (await api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: PASSWORD })).cookie;
  ctl = await page(admin);
  assert.deepEqual(await act(ctl, 'room:update', { code: hallA, sendFrom: [MEDIA], sendBack: [MEDIA] }),
    { ok: false, error: 'At most 50 rooms may send into one room, and Media (Hall B) has 50 already: this room cannot send back into it. ' + NOTHING });
  assert.deepEqual((await told(ctl, hallA)).sendFrom, [], 'Hall A\'s list was not saved either');
  assert.equal(rowsOf(srv.dataDir, 'room.sendFrom').length, 9, 'no row');

  // A room removed is taken off every list, as the room listed and as a room on a list; a hall with its rooms likewise.
  assert.ok((await act(ctl, 'admin:deleteRoom', { roomCode: MEDIA, purgeFiles: true })).ok);
  await until(() => JSON.stringify((settingsOf(srv.dataDir) || {}).roomSends) === JSON.stringify({ [hallB]: [LEGAL] }), 4000, 'Media gone from every list');
  assert.deepEqual((await told(ctl, LEGAL)).sendFrom, []);
  assert.ok((await act(ctl, 'admin:deleteRoom', { roomCode: hallA, purgeFiles: true })).ok);
  await until(() => { const s = settingsOf(srv.dataDir); return !!s && !Object.hasOwn(s, 'roomSends'); }, 4000, 'no list left, and none saved');
  assert.deepEqual((await told(ctl, hallB)).sendFrom, []);
  assert.deepEqual(rowsOf(srv.dataDir, 'room.sendFrom').slice(5), [
    [LEGAL, 'may send here: Main (Hall B), Media (Hall B)', 'ana'],
    [LEGAL, 'may send here: Media (Hall B)', 'ana'],
    [LEGAL, 'may send here: Media (Hall B); it no longer sends into: Main (Hall B)', 'ana'],
    [hallB, 'may send here: Legal (Hall A)', 'ana'],
  ], 'the picker\'s saves; a room removed writes its own row, never one of these');
  for (const [, words] of rowsOf(srv.dataDir, 'room.sendFrom')) for (const k of [hallA, hallB, LEGAL, MEDIA]) assert.ok(!words.includes(k), 'a row names rooms by name, never by a key (a hall\'s is its code): ' + words);
});

test('a room whose files another program held, removed, keeps its places through a save, counted toward the bound, and is back on both lists at the next start', { timeout: 60_000 }, async (t) => {
  const data = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agm-sends-'));
  const rooms = path.join(data, 'rooms');
  fs.mkdirSync(rooms);
  const room = (code, roomName) => JSON.stringify({ code, name: roomName, createdAt: 1, seq: 0, settings: {}, messages: [], savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(rooms, 'HALLA1.json'), room('HALLA1', 'Hall A'));
  fs.writeFileSync(path.join(rooms, 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal'));
  fs.writeFileSync(path.join(rooms, 'HALLB2.json'), room('HALLB2', 'Hall B'));
  fs.writeFileSync(path.join(rooms, 'HALLC3.json'), room('HALLC3', 'Hall C'));
  // Legal, Hall A and 48 rooms no start opens may send into Hall B: 50, the bound; Hall B may send into Legal.
  const gone48 = Array.from({ length: 48 }, (_, i) => 'GONE' + String(i).padStart(4, '0'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ roomSends: { HALLB2: ['LGQ4MZP8', 'HALLA1', ...gone48], LGQ4MZP8: ['HALLB2'] } }));
  // test/busy-preload.js: Legal's snapshot cannot be removed, as when an antivirus or a backup holds it.
  const preload = '--require "' + path.join(__dirname, 'busy-preload.js').split(path.sep).join('/') + '"';
  let srv = await startServer({ AGM_DATA_DIR: data, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_UNREMOVABLE: 'HALLA1.LGQ4MZP8.json' });
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const adminPage = async () => { const s = await connect(srv.base, (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie); sockets.push(s); return s; };
  let ctl = await adminPage();
  const removed = await act(ctl, 'admin:deleteRoom', { roomCode: 'LGQ4MZP8', purgeFiles: true });
  assert.deepEqual([removed.ok, removed.kept], [true, 1], JSON.stringify(removed));
  // Gone from this run: no list tells it, and both lists keep it, its own and Hall B's.
  const hallB = await act(ctl, 'room:settings', { code: 'HALLB2' });
  assert.deepEqual([hallB.sendFrom.map((r) => r.key), hallB.sendBack], [['HALLA1'], []]);
  assert.deepEqual(settingsOf(data).roomSends, { HALLB2: ['LGQ4MZP8', 'HALLA1', ...gone48], LGQ4MZP8: ['HALLB2'] });
  // The rooms not open now count toward the bound: Hall C beside Hall A makes 51, refused with why.
  assert.deepEqual(await act(ctl, 'room:update', { code: 'HALLB2', sendFrom: ['HALLA1', 'HALLC3'] }),
    { ok: false, error: 'At most 50 rooms may send into one room: this list names 2, and with the 49 not open now that keep their places on it, 51. Nothing was saved.' });
  // A save of Hall B's list from its picker, Hall A unticked: Legal, which no picker shows, keeps its place.
  const P = loadPicker();
  const change = plain(P.changeOf(hallB, P.groupsFor(hallB).flatMap((g) => g.rooms).map(({ key, back }) => ({ key, on: false, back }))));
  assert.deepEqual(change, { code: 'HALLB2', sendFrom: [], sendBack: [] });
  assert.deepEqual(await act(ctl, 'room:update', change), { ok: true, sendFrom: [], sendBack: [], into: [], notInto: [] });
  await until(() => JSON.stringify(settingsOf(data).roomSends) === JSON.stringify({ HALLB2: ['LGQ4MZP8', ...gone48], LGQ4MZP8: ['HALLB2'] }), 4000, 'Hall A off Hall B\'s list, the others kept');
  assert.deepEqual(rowsOf(data, 'room.sendFrom').map(([target, words]) => [target, words]), [['HALLB2', 'may send here: 49 rooms not open now']]);
  // Back at the next start, on both lists, as it was.
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer(srv.child);
  srv = await startServer({ AGM_DATA_DIR: data });
  ctl = await adminPage();
  assert.deepEqual((await act(ctl, 'room:settings', { code: 'HALLB2' })).sendFrom.map((r) => r.key), ['LGQ4MZP8']);
  const legal = await act(ctl, 'room:settings', { code: 'LGQ4MZP8' });
  assert.deepEqual([legal.sendFrom.map((r) => r.key), legal.sendBack], [['HALLB2'], ['HALLB2']]);
});

// ---------------------------------------------------------------- sending into another room (plan 1-§4.2, §4.3)
const pdf = (text = 'contract') => new Blob([Buffer.from('%PDF-1.4\n% ' + text + '\n%%EOF\n')], { type: 'application/pdf' });
/** An upload made with a page's token, for its room: its answer. */
async function uploadWith(base, token, name = 'contract.pdf', text) {
  const f = new FormData();
  f.append('file', pdf(text), name);
  return (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f })).json();
}
const STAYS_HERE = 'Messages from On stage stay in this room.';

test('a message or a file is sent into another room by that room\'s list, with a copy kept here: across halls, by reference, read on every send; the copy and the message say where, and nothing of either room\'s key or code reaches the other\'s pages; a repeat lands once; refused for an observer, a seat that shares no file, a question and a help request, a stale or forged reference, and the rate; Send back threads under the question; one row, no words; the file outlives its room\'s reset', { timeout: 120_000 }, async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: PASSWORD })).cookie;
  const account = async (username, role, extra = {}) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: 'clipboard and coffee', ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: 'clipboard and coffee' })).cookie;
  };
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await page(admin);
  const LEGAL = (await act(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const legalCode = (await act(ctl, 'room:settings', { code: LEGAL })).guestCode;
  assert.ok(legalCode && legalCode !== LEGAL);
  const list = async (code, sendFrom) => { const r = await act(ctl, 'room:update', { code, sendFrom }); assert.ok(r.ok, JSON.stringify(r)); };

  // Every frame and answer each page hears: Lou in Legal (given it alone), Gus in Hall A's Main room, Bea in Hall B's.
  const heard = new Map();
  const seated = async (name, join, cookie) => {
    const s = await page(cookie);
    const frames = [];
    heard.set(name, frames);
    s.onAny((ev, ...args) => frames.push([ev, args]));
    const j = await emit(s, 'join', join);
    frames.push(['join', j]);
    assert.equal(j.ok, true, name + ': ' + JSON.stringify(j));
    return { s, j, frames };
  };
  /** Whether a page heard a message (a `message` frame) that `pred` holds of. */
  const heardMessage = (name, pred) => heard.get(name).some(([ev, args]) => ev === 'message' && Array.isArray(args) && !!args[0] && pred(args[0]));
  const louCookie = await account('lou', 'staff', { rooms: [LEGAL] });
  const lou = await seated('lou', { roomCode: LEGAL, as: 'account' }, louCookie);
  const gus = await seated('gus', { roomCode: hallA, name: 'Gus', role: 'research' });
  await seated('bea', { roomCode: hallB, name: 'Bea', role: 'research' });
  // An observer of Legal (a Viewer given it), and a Staff of Legal who shares no file.
  const vic = await seated('vic', { roomCode: LEGAL, as: 'account' }, await account('vic', 'viewer', { rooms: [LEGAL] }));
  const sid = await seated('sid', { roomCode: LEGAL, as: 'account' }, await account('sid', 'staff', { rooms: [LEGAL], revoke: ['hall.files'] }));
  assert.deepEqual([lou.j.role, vic.j.role, sid.j.role, !!sid.j.uploadToken], ['research', 'observer', 'research', false]);
  const targets = async (p) => act(p.s, 'room:sendTargets', {});
  const send = (p, args) => act(p.s, 'room:send', args);
  /** A room's newest number, as its newest message carries it. */
  const seqOf = async (code) => Math.max(0, ...(await act(ctl, 'admin:watchRoom', { roomCode: code })).messages.map((m) => m.seq || 0));
  const messagesOf = async (code) => (await act(ctl, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.type !== 'system');

  // No list: no room to send to, and the join says so.
  assert.equal(lou.j.sends, false);
  assert.deepEqual(await targets(lou), { ok: true, targets: [] });
  const forged = 'r' + 'A'.repeat(16);
  assert.deepEqual(await send(lou, { to: forged, type: 'text', text: 'Hello' }), { ok: false, error: 'That room is gone.' });

  // Hall A takes Legal in: Legal's pages are told to ask again (and Hall A's are not), and Lou may send there, by reference.
  const nudged = once(lou.s, 'sendsChanged');
  await list(hallA, [LEGAL]);
  await nudged;
  const toA = await targets(lou);
  assert.equal(toA.targets.length, 1);
  const REF_A = toA.targets[0].ref;
  assert.deepEqual(toA, { ok: true, targets: [{ ref: REF_A, name: 'Hall A', hallName: 'Hall A' }] }, 'a Main room by its hall\'s name: no key, no code, no people, no numbers');
  assert.ok(/^r[A-Za-z0-9_-]{16}$/.test(REF_A) && REF_A !== hallA);
  assert.deepEqual([(await emit(await page(louCookie), 'join', { roomCode: LEGAL, as: 'account' })).sends, (await targets(gus)).targets, (await targets(vic)).targets], [true, [], []],
    'the join says so; Hall A sends nowhere; an observer of Legal may send nowhere');
  assert.ok(!heard.get('gus').some(([ev]) => ev === 'sendsChanged'), 'Hall A\'s pages are not nudged: where Hall A sends did not change');

  // A message: into Hall A first, marked from Legal, then Legal's copy, marked with where it went; one answer.
  const aSeq = await seqOf(hallA);
  const sent = await send(lou, { to: REF_A, type: 'text', text: 'Is the contract signed?', cid: 'cid-lou-1', heldMs: 4200 });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual(sent.to, { name: 'Hall A', hallName: 'Hall A' });
  const [there] = (await messagesOf(hallA)).slice(-1);
  const copy = (await messagesOf(LEGAL)).find((m) => m.id === sent.id);
  const REF_L = there.sentFrom.ref;
  assert.deepEqual({ type: there.type, text: there.text, from: there.from, sentFrom: there.sentFrom, cid: there.cid, held: there.held },
    { type: 'text', text: 'Is the contract signed?', from: { uid: lou.j.uid, name: 'lou', role: 'research', acct: true }, sentFrom: { roomName: 'Legal', hallName: 'Hall A', ref: REF_L }, cid: undefined, held: 4 });
  assert.deepEqual({ text: copy.text, cid: copy.cid, seq: copy.seq, sentTo: copy.sentTo }, { text: 'Is the contract signed?', cid: 'cid-lou-1', seq: sent.seq, sentTo: { roomName: 'Hall A', hallName: 'Hall A', ref: REF_A, id: there.id } });
  assert.ok(REF_L !== REF_A && REF_L !== LEGAL && !RoomStore.validCode(REF_L));
  assert.equal(await seqOf(hallA), aSeq + 1, 'one message into Hall A');
  // Heard live by each room's pages, as they hear any message.
  await until(() => heardMessage('gus', (m) => m.id === there.id) && heardMessage('lou', (m) => m.id === sent.id), 4000, 'both rooms heard it');
  // A repeat (the outbox's, after a drop) is answered with what it did, and writes nothing into Hall A.
  assert.deepEqual(await send(lou, { to: REF_A, type: 'text', text: 'Is the contract signed?', cid: 'cid-lou-1' }), sent);
  assert.equal(await seqOf(hallA), aSeq + 1, 'a repeat writes nothing into Hall A');
  // A client id a message of another kind holds here names no send: refused, never answered as one that went through.
  const CID_HELD = 'That message\'s id is another message\'s.';
  assert.equal((await act(lou.s, 'message', { type: 'text', text: 'Only for Legal', cid: 'cid-lou-here' })).ok, true);
  assert.deepEqual(await send(lou, { to: REF_A, type: 'text', text: 'Only for Legal', cid: 'cid-lou-here' }), { ok: false, error: CID_HELD });
  assert.equal(await seqOf(hallA), aSeq + 1, 'nothing reached Hall A');

  // One of Legal's own messages, and a file: by its id, and new, the file uploaded for Legal by Lou.
  const said = await act(lou.s, 'message', { type: 'text', text: 'Draft attached below' });
  const up = await uploadWith(srv.base, lou.j.uploadToken);
  assert.ok(up.url, JSON.stringify(up));
  const fileSent = await send(lou, { to: REF_A, type: 'file', url: up.url, filename: 'contract.pdf', mime: 'application/pdf', caption: 'signed copy', cid: 'cid-lou-2' });
  assert.equal(fileSent.ok, true, JSON.stringify(fileSent));
  const byId = await send(lou, { to: REF_A, messageId: said.id, cid: 'cid-lou-3' });
  assert.equal(byId.ok, true, JSON.stringify(byId));
  const inA = await messagesOf(hallA);
  const fileThere = inA.find((m) => m.type === 'file');
  assert.deepEqual({ url: fileThere.url, filename: fileThere.filename, caption: fileThere.caption, sentFrom: fileThere.sentFrom.roomName }, { url: up.url, filename: 'contract.pdf', caption: 'signed copy', sentFrom: 'Legal' });
  assert.deepEqual(inA.filter((m) => m.sentFrom).map((m) => m.text || m.filename), ['Is the contract signed?', 'contract.pdf', 'Draft attached below']);
  // Its link serves Hall A's people, and outlives Legal's reset: Hall A still holds it.
  assert.equal((await fetch(srv.base + up.url)).status, 200);
  const fileFromLegal = (await messagesOf(LEGAL)).find((m) => m.type === 'file');
  assert.deepEqual(fileFromLegal.sentTo.id, fileThere.id);

  // Refused, each in words, and nothing written into Hall A.
  const before = await seqOf(hallA);
  const legalAction = await act(lou.s, 'message', { type: 'action', text: 'Sign it?', options: ['Yes', 'No'] });
  const legalHelp = await act(lou.s, 'message', { type: 'help', category: 'Sound', text: 'mic' });
  for (const [who, args, error] of [
    [vic, { to: REF_A, type: 'text', text: 'From an observer' }, 'Observers can read but not post.'],
    [sid, { to: REF_A, messageId: fileFromLegal.id }, 'Your account may not share files here.'],
    [lou, { to: REF_A, type: 'action', text: 'Sign it?', options: ['Yes'] }, 'Only a message or a file is sent into another room.'],
    [lou, { to: REF_A, messageId: legalAction.id }, 'Only a message or a file is sent into another room.'],
    [lou, { to: REF_A, type: 'help', category: 'Sound', text: 'mic' }, 'A help request belongs to its room — ask in the other room instead.'],
    [lou, { to: REF_A, messageId: legalHelp.id }, 'A help request belongs to its room — ask in the other room instead.'],
    [lou, { to: REF_A, messageId: 'nope' }, 'Message not found'],
    [lou, { to: REF_A, messageId: said.id, type: 'text', text: 'both' }, 'Send a message of this room (messageId) or a new one (type), one of them.'],
    [lou, { to: REF_A }, 'Send a message of this room (messageId) or a new one (type), one of them.'],
    [lou, { to: forged, type: 'text', text: 'x' }, 'That room is gone.'],
    [lou, { to: REF_L, type: 'text', text: 'x' }, 'That room is gone.'],
    [lou, { to: LEGAL, type: 'text', text: 'x' }, 'That room is gone.'],
    [lou, { to: hallA, type: 'text', text: 'x' }, 'That room is gone.'],
    [lou, { to: REF_A, type: 'text', text: 'x', cid: 'bad cid!' }, 'That message\'s id could not be read.'],
  ]) assert.deepEqual(await send(who, args), { ok: false, error }, JSON.stringify(args));
  // Hall A sends nowhere yet: Gus is refused Legal, which Legal's own pages are not even told of.
  assert.deepEqual(await send(gus, { to: REF_L, type: 'text', text: 'Hello Legal' }), { ok: false, error: 'This room may not send there — ask an admin.' });
  assert.equal(await seqOf(hallA), before, 'nothing refused reached Hall A');

  // Across halls: Hall B takes Legal in, and Lou sends there; taken off mid-show, the next send is refused at once.
  await list(hallB, [LEGAL]);
  const both = await targets(lou);
  assert.deepEqual(both.targets.map((x) => x.name), ['Hall A', 'Hall B']);
  const REF_B = both.targets[1].ref;
  assert.equal((await send(lou, { to: REF_B, type: 'text', text: 'Hall B, the contract' })).ok, true);
  await list(hallB, []);
  assert.deepEqual(await send(lou, { to: REF_B, type: 'text', text: 'again' }), { ok: false, error: 'This room may not send there — ask an admin.' });
  assert.deepEqual((await targets(lou)).targets.map((x) => x.ref), [REF_A]);
  // A room removed: its reference names nothing.
  const MEDIA = (await act(ctl, 'room:create', { hall: hallB, name: 'Media' })).key;
  await list(MEDIA, [LEGAL]);
  const REF_M = (await targets(lou)).targets.find((x) => x.name === 'Media').ref;
  // A room it sends into renamed, then that room's hall: Legal's pages are told to ask again each time, and hear the names.
  const renamed = once(lou.s, 'sendsChanged');
  assert.ok((await act(ctl, 'room:update', { code: MEDIA, name: 'Press' })).ok);
  await renamed;
  assert.deepEqual((await targets(lou)).targets.find((x) => x.ref === REF_M), { ref: REF_M, name: 'Press', hallName: 'Hall B' });
  const hallRenamed = once(lou.s, 'sendsChanged');
  assert.ok((await act(ctl, 'room:update', { code: hallB, name: 'Hall Bee' })).ok);
  await hallRenamed;
  assert.deepEqual((await targets(lou)).targets.find((x) => x.ref === REF_M), { ref: REF_M, name: 'Press', hallName: 'Hall Bee' });
  assert.ok((await act(ctl, 'admin:deleteRoom', { roomCode: MEDIA })).ok);
  assert.deepEqual(await send(lou, { to: REF_M, type: 'text', text: 'Media?' }), { ok: false, error: 'That room is gone.' });

  // Send back: Hall A sends into Legal too (↔), and Gus answers the question under it; Legal reads the answer under its copy.
  await list(LEGAL, [hallA]);
  assert.deepEqual((await targets(gus)).targets, [{ ref: REF_L, name: 'Legal', hallName: 'Hall A' }]);
  // A file is sent only from the room its upload was made for: one Lou uploaded for Legal is refused from Hall A by its link.
  const legalOnly = await uploadWith(srv.base, lou.j.uploadToken, 'notes.pdf', 'notes');
  assert.deepEqual(await send(gus, { to: REF_L, type: 'file', url: legalOnly.url, filename: 'notes.pdf' }), { ok: false, error: 'That file belongs to another room — send it from there.' });
  const back = await send(gus, { to: there.sentFrom.ref, type: 'text', text: 'Signed this morning.', replyTo: there.id, cid: 'cid-gus-1' });
  assert.equal(back.ok, true, JSON.stringify(back));
  const answered = (await messagesOf(LEGAL)).slice(-1)[0];
  assert.deepEqual({ text: answered.text, replyTo: answered.replyTo, sentFrom: answered.sentFrom }, { text: 'Signed this morning.', replyTo: { id: copy.id, name: 'lou', snippet: 'Is the contract signed?' }, sentFrom: { roomName: 'Hall A', hallName: 'Hall A', ref: REF_A } });
  assert.deepEqual((await messagesOf(hallA)).find((m) => m.id === back.id).replyTo, { id: there.id, name: 'lou', snippet: 'Is the contract signed?' }, 'and Hall A\'s copy answers the question there');

  // The rate: the writes bucket holds a burst of sends, refused ones included.
  const burst = await Promise.all(Array.from({ length: 24 }, () => emit(lou.s, 'room:send', { to: forged, type: 'text', text: 'x' })));
  assert.ok(burst.some((r) => r && r.busy === true && r.error === 'Slow down a little.'), 'the writes bucket applies: ' + JSON.stringify(burst.map((r) => r.error)));
  await wait(3200);

  // One row per send, naming the rooms by name and the message by its kind and size: never its words or a file's name.
  const rows = rowsOf(srv.dataDir, 'room.send');
  assert.deepEqual(rows, [
    [hallA, 'a message (23 characters) from Legal (Hall A) to Main (Hall A)', 'lou'],
    [hallA, 'a file (pdf, 1 KB) from Legal (Hall A) to Main (Hall A)', 'lou'],
    [hallA, 'a message (20 characters) from Legal (Hall A) to Main (Hall A)', 'lou'],
    [hallB, 'a message (20 characters) from Legal (Hall A) to Main (Hall B)', 'lou'],
    [LEGAL, 'a message (20 characters) from Main (Hall A) to Legal (Hall A)', 'Gus'],
  ]);
  assert.ok(!JSON.stringify(rows).match(/contract|signed|\/uploads\//i), 'no words, no file name, no link');

  // Legal's reset keeps the file Hall A holds.
  assert.ok((await act(ctl, 'admin:resetRoom', { roomCode: LEGAL })).ok);
  assert.equal((await fetch(srv.base + up.url)).status, 200, 'the file outlives Legal\'s reset');

  // No frame a page in either room heard carries a key or a code of a room it is not in: Lou's (Legal) none of Hall A's or
  // Hall B's, Gus's (Hall A) none of Legal's or Hall B's, Bea's (Hall B) none of Legal's.
  const scan = (name, keys) => { const text = JSON.stringify(heard.get(name)); return keys.filter((k) => text.includes(k)); };
  assert.deepEqual(scan('lou', [hallA, hallB, MEDIA]), []);
  assert.deepEqual(scan('gus', [LEGAL, legalCode, hallB, MEDIA]), []);
  assert.deepEqual(scan('bea', [LEGAL, legalCode, hallA]), []);
  assert.ok(heardMessage('bea', (m) => m.text === 'Hall B, the contract'), 'Bea heard the send into Hall B');

  // A restart: each room's reference is the same, and the copy's still names its room.
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  srv = await restartServer(srv);
  const again = await page(louCookie);
  assert.equal((await emit(again, 'join', { roomCode: LEGAL, as: 'account' })).sends, true);
  assert.deepEqual((await act(again, 'room:sendTargets', {})).targets, [{ ref: REF_A, name: 'Hall A', hallName: 'Hall A' }]);
});

test('On stage nothing is sent into another room (owner answer B2): a Board guest and a Board account on its On stage page are refused room:send in both forms, Send back included, and told no room; the same account sends from its Legal page, and may delete its copy there but not the message where it went', { timeout: 90_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: PASSWORD })).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await page(admin);
  const LEGAL = (await act(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  // Hall B takes Hall A in, Hall A takes Legal in, and Legal takes Hall A in: every list holds the room a Board page is in.
  for (const [code, from] of [[hallB, [hallA]], [hallA, [LEGAL]], [LEGAL, [hallA]]]) assert.ok((await act(ctl, 'room:update', { code, sendFrom: from })).ok);
  const made = await api(srv.base, 'POST', '/api/users', { username: 'kib', name: 'Kib', role: 'tech', halls: [hallA], rooms: [LEGAL], board: [hallA], password: 'board pack on the lectern' }, { cookie: admin });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const kib = (await api(srv.base, 'POST', '/api/auth/login', { username: 'kib', password: 'board pack on the lectern' })).cookie;
  const join = async (args, cookie) => { const s = await page(cookie); const j = await emit(s, 'join', args); assert.equal(j.ok, true, JSON.stringify(j)); return { s, j }; };
  const ana = await join({ roomCode: hallA, name: 'Ana', role: 'research' });
  const chair = await join({ roomCode: hallA, name: 'Chair', role: 'board' });
  const kibStage = await join({ roomCode: hallA, as: 'account' }, kib);
  const kibLegal = await join({ roomCode: LEGAL, as: 'account' }, kib);
  assert.deepEqual([chair.j.role, kibStage.j.role, kibLegal.j.role], ['board', 'board', 'research']);
  // Hall A's text and file, and one Legal sent in: what a Board page could send on, or send back to.
  const text = await act(ana.s, 'message', { type: 'text', text: 'Slides are loaded' });
  const up = await uploadWith(srv.base, ana.j.uploadToken, 'deck.pdf');
  const file = await act(ana.s, 'message', { type: 'file', url: up.url, filename: 'deck.pdf', mime: 'application/pdf' });
  const REF_A = (await act(kibLegal.s, 'room:sendTargets', {})).targets[0].ref;
  const fromLegal = await act(kibLegal.s, 'room:send', { to: REF_A, type: 'text', text: 'From Legal' });
  assert.equal(fromLegal.ok, true, JSON.stringify(fromLegal));
  const watch = async (code) => (await act(ctl, 'admin:watchRoom', { roomCode: code }));
  const inA = (await watch(hallA)).messages;
  const legalsInA = inA.find((m) => m.sentFrom && m.text === 'From Legal');
  const REF_L = legalsInA.sentFrom.ref;
  const REF_B = (await act(ana.s, 'room:sendTargets', {})).targets.find((x) => x.name === 'Hall B').ref;
  const seqs = async () => [(await watch(hallB)).messages.length, (await watch(LEGAL)).messages.length];
  const was = await seqs();
  for (const [name, p] of [['a Board guest', chair], ['a Board account', kibStage]]) {
    assert.deepEqual([p.j.sends, await act(p.s, 'room:sendTargets', {})], [false, { ok: true, targets: [] }], name + ': no room to send to');
    for (const args of [
      { to: REF_B, type: 'text', text: 'From the Board' },
      { to: REF_B, type: 'file', url: up.url, filename: 'deck.pdf' },
      { to: REF_B, messageId: text.id },
      { to: REF_B, messageId: file.id },
      // Send back on the message Legal sent in: the same path.
      { to: REF_L, type: 'text', text: 'Thanks', replyTo: legalsInA.id },
    ]) assert.deepEqual(await act(p.s, 'room:send', args), { ok: false, error: STAYS_HERE }, name + ' ' + JSON.stringify(args));
  }
  // A client id the Board guest's own message holds is no send of its: refused, never answered as one that went through.
  const boardSaid = await act(chair.s, 'message', { type: 'text', text: 'A note from the Board', cid: 'cid-board-1' });
  assert.equal(boardSaid.ok, true, JSON.stringify(boardSaid));
  assert.deepEqual(await act(chair.s, 'room:send', { to: REF_B, type: 'text', text: 'A note from the Board', cid: 'cid-board-1' }), { ok: false, error: 'That message\'s id is another message\'s.' });
  assert.deepEqual(await seqs(), was, 'nothing reached Hall B or Legal');
  // The same account, from its Legal page: a file of Legal's into Hall A, where it sits On stage (the rights in Legal decide).
  const legalUp = await uploadWith(srv.base, kibLegal.j.uploadToken, 'brief.pdf');
  const legalFile = await act(kibLegal.s, 'room:send', { to: REF_A, type: 'file', url: legalUp.url, filename: 'brief.pdf', mime: 'application/pdf' });
  assert.equal(legalFile.ok, true, JSON.stringify(legalFile));
  assert.equal((await watch(hallA)).messages.slice(-1)[0].sentFrom.roomName, 'Legal');

  // What Legal sent into Hall A is Hall A's while it holds it (plan 1-§4.3): its sender's page there may not delete it,
  // so Legal's copy is still true when it says "delivered"; the sender deletes the copy in Legal, and the admin removes
  // the message in Hall A.
  const SENT_STAYS = 'A message sent from another room stays here: its sender withdraws it from that room, or the admin removes it.';
  assert.deepEqual(await act(kibStage.s, 'delete', { messageId: legalsInA.id }), { ok: false, error: SENT_STAYS });
  assert.ok((await watch(hallA)).messages.some((m) => m.id === legalsInA.id), 'Hall A still holds it');
  const copyInLegal = (await watch(LEGAL)).messages.find((m) => m.sentTo && m.sentTo.id === legalsInA.id);
  assert.equal(copyInLegal.id, fromLegal.id);
  assert.deepEqual(await act(kibLegal.s, 'delete', { messageId: copyInLegal.id }), { ok: true });
  assert.ok((await watch(hallA)).messages.some((m) => m.id === legalsInA.id), 'the copy deleted, Hall A still holds the message');
  assert.deepEqual(await act(ctl, 'admin:deleteMessage', { roomCode: hallA, messageId: legalsInA.id }), { ok: true });
  assert.ok(!(await watch(hallA)).messages.some((m) => m.id === legalsInA.id));
});

// ---------------------------------------------------------------- a send withdrawn (plan 1-§4.4)
test('a mis-sent message is withdrawn: by its sender or the admin, never another, the support view or a seat On stage, each refusal taking a token; it goes from the room it went to with a line saying who, and a reply there keeps no word of it; the copy keeps when and each room\'s pages hear it in order, a resumed page reads it from the ops, a repeat is answered as done before the rate, one no longer there is said so; the file stays while the copy holds it; one row each, no words', { timeout: 120_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const page = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: PASSWORD })).cookie;
  const account = async (username, role, extra = {}) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: username, role, password: 'clipboard and coffee', ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: 'clipboard and coffee' })).cookie;
  };
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await page(admin);
  const LEGAL = (await act(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const MEDIA = (await act(ctl, 'room:create', { hall: hallB, name: 'Media' })).key;
  // Hall A and Media take Legal in, and Legal takes Hall A in.
  for (const [code, from] of [[hallA, [LEGAL]], [MEDIA, [LEGAL]], [LEGAL, [hallA]]]) assert.ok((await act(ctl, 'room:update', { code, sendFrom: from })).ok);

  // Every frame and answer each page hears.
  const heard = new Map();
  const seated = async (name, join, cookie) => {
    const s = await page(cookie);
    const frames = [];
    heard.set(name, frames);
    s.onAny((ev, ...args) => frames.push([ev, args]));
    const j = await emit(s, 'join', join);
    assert.equal(j.ok, true, name + ': ' + JSON.stringify(j));
    return { s, j };
  };
  /** The numbers a page heard on the changes it was sent (lib/ops.js EVENTS), in the order heard. */
  const seqsOf = (name) => heard.get(name).filter(([ev, args]) => ops.EVENTS.includes(ev) && args[0] && Number.isInteger(args[0].seq)).map(([, args]) => args[0].seq);
  const heardSystem = (name, text) => heard.get(name).some(([ev, args]) => ev === 'system' && args[0] && args[0].text === text);
  const louCookie = await account('lou', 'staff', { rooms: [LEGAL] });
  const vicCookie = await account('vic', 'viewer', { rooms: [LEGAL] });
  const lou = await seated('lou', { roomCode: LEGAL, as: 'account' }, louCookie);
  const sid = await seated('sid', { roomCode: LEGAL, as: 'account' }, await account('sid', 'staff', { rooms: [LEGAL] }));
  const vic = await seated('vic', { roomCode: LEGAL, as: 'account' }, vicCookie);
  const root = await seated('root', { roomCode: LEGAL, as: 'account' }, admin);
  const support = await seated('support', { roomCode: LEGAL, name: 'lou', role: 'research', adminView: true }, admin);
  const gus = await seated('gus', { roomCode: hallA, name: 'Gus', role: 'research' });
  // An admin account seated On stage in Hall A: the seat's limit holds the admin as anyone there.
  const ada = await seated('ada', { roomCode: hallA, as: 'account' }, await account('ada', 'admin', { halls: [hallA], board: [hallA] }));
  assert.deepEqual([lou.j.admin, sid.j.admin, root.j.admin, support.j.admin, gus.j.admin, ada.j.admin, ada.j.role], [false, false, true, false, false, true, 'board'],
    'the join says whether the page is the admin\'s own: the support view is not');

  const targets = async (p) => (await act(p.s, 'room:sendTargets', {})).targets;
  const REF_A = (await targets(lou)).find((x) => x.name === 'Hall A').ref;
  const REF_M = (await targets(lou)).find((x) => x.name === 'Media').ref;
  const REF_L = (await targets(gus)).find((x) => x.name === 'Legal').ref;
  const send = async (p, args) => { const r = await act(p.s, 'room:send', args); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  const messagesIn = async (code) => (await act(ctl, 'admin:watchRoom', { roomCode: code })).messages;
  const first = await send(lou, { to: REF_A, type: 'text', text: 'Wrong room: the fee is 40k' });
  const up = await uploadWith(srv.base, lou.j.uploadToken, 'fees.pdf', 'fees');
  const fileSent = await send(lou, { to: REF_A, type: 'file', url: up.url, filename: 'fees.pdf', mime: 'application/pdf' });
  const second = await send(lou, { to: REF_A, type: 'text', text: 'And the venue is booked' });
  const third = await send(lou, { to: REF_A, type: 'text', text: 'Removed there by the admin' });
  const toMedia = await send(lou, { to: REF_M, type: 'text', text: 'Media, a room that goes' });
  const fromA = await send(gus, { to: REF_L, type: 'text', text: 'From Hall A, sent by mistake' });
  const inA = await messagesIn(hallA);
  const thereOf = (text) => inA.find((m) => m.sentFrom && m.text === text);
  const copyFirst = (await messagesIn(LEGAL)).find((m) => m.id === first.id);
  assert.deepEqual(copyFirst.sentTo, { roomName: 'Hall A', hallName: 'Hall A', ref: REF_A, id: thereOf('Wrong room: the fee is 40k').id });

  // Refused, each in words, and nothing taken back: another member of the room, an observer, the admin's support view of
  // the sender, a message that is no copy of a send (this room's own, and the message where it went), none at all, and the
  // admin On stage.
  const withdraw = (p, messageId) => act(p.s, 'room:withdraw', { messageId });
  const NOT_YOURS = 'Only its sender or the admin withdraws it.';
  const NOT_SENT = 'Only a message this room sent into another room is withdrawn.';
  const plainHere = await act(lou.s, 'message', { type: 'text', text: 'Only for Legal' });
  for (const [who, p, id, error] of [
    ['another member', sid, first.id, NOT_YOURS],
    ['an observer', vic, first.id, NOT_YOURS],
    ['the support view', support, first.id, 'This is someone else\'s view — act from your own page.'],
    ['this room\'s own message', lou, plainHere.id, NOT_SENT],
    ['no message', lou, 'nope', 'Message not found'],
    ['the message where it went', gus, thereOf('Wrong room: the fee is 40k').id, NOT_SENT],
    ['the admin On stage', ada, fromA.id, 'Do that from a backstage page.'],
  ]) assert.deepEqual(await withdraw(p, id), { ok: false, error }, who);
  assert.deepEqual((await messagesIn(hallA)).map((m) => m.id), inA.map((m) => m.id), 'nothing went from Hall A');
  assert.ok((await messagesIn(LEGAL)).some((m) => m.sentFrom && m.text === 'From Hall A, sent by mistake'), 'nothing went from Legal');
  // A refusal is never free: one who may not withdraw a copy, or asks of a message that is not here, takes a token for
  // each ask, so a burst of them meets the rate (lib/gate.js); only a repeat of what was done is answered before it.
  for (const [who, p, id, error] of [['another member', sid, first.id, NOT_YOURS], ['no message', vic, 'nope', 'Message not found']]) {
    const asked = await Promise.all(Array.from({ length: 24 }, () => emit(p.s, 'room:withdraw', { messageId: id })));
    assert.ok(asked.some((r) => r && r.busy === true) && asked.every((r) => r && r.ok === false && (r.busy === true || r.error === error)), who + ': ' + JSON.stringify(asked.map((r) => r && r.error)));
  }
  assert.deepEqual((await messagesIn(hallA)).map((m) => m.id), inA.map((m) => m.id), 'nothing went from Hall A in a burst either');

  // Replies in Hall A that quote the first: Gus's, and Hall A's copy of what Gus sends back into Legal under it.
  const thereFirst = thereOf('Wrong room: the fee is 40k');
  const noted = await act(gus.s, 'message', { type: 'text', text: 'Noted', replyTo: thereFirst.id });
  assert.equal(noted.ok, true, JSON.stringify(noted));
  const whichFee = await send(gus, { to: REF_L, type: 'text', text: 'Which fee?', replyTo: thereFirst.id });
  assert.deepEqual((await messagesIn(hallA)).filter((m) => m.replyTo && m.replyTo.id === thereFirst.id).map((m) => [m.id, m.replyTo.snippet]), [[noted.id, 'Wrong room: the fee is 40k'], [whichFee.id, 'Wrong room: the fee is 40k']]);

  // A page that leaves before the sends are withdrawn, to come back by resuming: Vic's, from the last change it heard.
  const vicSince = Math.max(vic.j.seq, ...seqsOf('vic'));
  vic.s.close();

  // Gus takes back what Hall A sent into Legal: it goes from Legal, which says who took it back.
  const fromAThere = (await messagesIn(LEGAL)).find((m) => m.sentFrom && m.text === 'From Hall A, sent by mistake');
  const legalHeard = once(lou.s, 'messageDeleted');
  assert.deepEqual(await withdraw(gus, fromA.id), { ok: true });
  assert.equal((await legalHeard).messageId, fromAThere.id);
  await until(() => heardSystem('lou', 'Gus withdrew a message sent from Hall A'), 4000, 'Legal\'s line');
  assert.ok(!(await messagesIn(LEGAL)).some((m) => m.id === fromAThere.id), 'it went from Legal');

  // Lou takes back the first: it goes from Hall A, with its line; Legal's copy keeps when, heard by Legal's pages under the
  // next number; a repeat is answered as done and changes nothing.
  const updated = once(lou.s, 'sentUpdate');
  const deleted = once(gus.s, 'messageDeleted');
  const copyAt = copyFirst.at;
  assert.deepEqual(await withdraw(lou, first.id), { ok: true });
  const upd = await updated;
  assert.equal((await deleted).messageId, thereOf('Wrong room: the fee is 40k').id);
  assert.deepEqual({ messageId: upd.messageId, sentTo: { ...upd.sentTo, withdrawn: 0 } }, { messageId: first.id, sentTo: { ...copyFirst.sentTo, withdrawn: 0 } });
  assert.ok(Number.isInteger(upd.sentTo.withdrawn) && upd.sentTo.withdrawn >= copyAt && Number.isInteger(upd.seq), JSON.stringify(upd));
  await until(() => heardSystem('gus', 'lou withdrew a message sent from Hall A › Legal'), 4000, 'Hall A\'s line');
  const nowA = await messagesIn(hallA);
  assert.ok(!nowA.some((m) => m.id === thereOf('Wrong room: the fee is 40k').id), 'it went from Hall A');
  assert.deepEqual((await messagesIn(LEGAL)).find((m) => m.id === first.id).sentTo, upd.sentTo, 'the copy stays, its mark kept');
  // Hall A's replies to it keep who wrote it and no word of it, each a change Hall A's pages hear; Legal's own answer under
  // its copy keeps its quote, Legal's own words.
  const unquoted = { id: thereFirst.id, name: 'lou', snippet: '', withdrawn: true };
  assert.deepEqual((await messagesIn(hallA)).filter((m) => m.replyTo && m.replyTo.id === thereFirst.id).map((m) => [m.id, m.replyTo]), [[noted.id, unquoted], [whichFee.id, unquoted]]);
  await until(() => heard.get('gus').filter(([ev, args]) => ev === 'replyUpdate' && args[0] && args[0].replyTo && args[0].replyTo.withdrawn === true && Number.isInteger(args[0].seq)).map(([, args]) => args[0].messageId).join() === [noted.id, whichFee.id].join(), 4000, 'Hall A\'s pages hear the quotes go');
  assert.ok(!JSON.stringify(await messagesIn(hallA)).includes('40k'), 'Hall A holds no word of it');
  const transcriptA = await (await fetch(srv.base + '/api/admin/transcript/' + hallA, { headers: { cookie: admin } })).text();
  assert.ok(!transcriptA.includes('40k') && (transcriptA.match(/↩ replying to lou: <em>⊘ withdrawn<\/em>/g) || []).length === 2, 'nor its transcript');
  assert.deepEqual((await messagesIn(LEGAL)).find((m) => m.text === 'Which fee?').replyTo, { id: first.id, name: 'lou', snippet: 'Wrong room: the fee is 40k' }, 'Legal keeps its own words');
  assert.deepEqual(await withdraw(lou, first.id), { ok: true, already: true });
  assert.deepEqual((await messagesIn(hallA)).map((m) => m.id), nowA.map((m) => m.id), 'a repeat takes nothing more from Hall A');

  // The admin takes back what Lou sent, from the admin's own page in Legal: Hall A's line says whose it was.
  assert.deepEqual(await withdraw(root, second.id), { ok: true });
  await until(() => heardSystem('gus', 'Ana Admin withdrew a message lou sent from Hall A › Legal'), 4000, 'the admin\'s line');

  // A file: it goes from Hall A, and stays on the laptop while Legal's copy holds it; the copy deleted, it goes.
  assert.deepEqual(await withdraw(lou, fileSent.id), { ok: true });
  await until(() => heardSystem('gus', 'lou withdrew a file sent from Hall A › Legal'), 4000, 'the file\'s line');
  assert.ok(!(await messagesIn(hallA)).some((m) => m.url === up.url), 'it went from Hall A');
  assert.equal((await fetch(srv.base + up.url)).status, 200, 'Legal\'s copy still holds the file');
  assert.deepEqual(await act(lou.s, 'delete', { messageId: fileSent.id }), { ok: true });
  await until(async () => (await fetch(srv.base + up.url)).status === 404, 4000, 'the file removed once nothing holds it');

  // No longer there: removed by the admin where it went, or its room removed, it is said so; the rate holds a burst.
  const thirdThere = (await messagesIn(hallA)).find((m) => m.text === 'Removed there by the admin');
  assert.deepEqual(await act(ctl, 'admin:deleteMessage', { roomCode: hallA, messageId: thirdThere.id }), { ok: true });
  assert.deepEqual(await withdraw(lou, third.id), { ok: false, error: 'It is no longer in Hall A: there is nothing to withdraw.' });
  const burst = await Promise.all(Array.from({ length: 24 }, () => emit(lou.s, 'room:withdraw', { messageId: third.id })));
  assert.ok(burst.some((r) => r && r.busy === true && r.error === 'Slow down a little.'), 'the writes bucket applies: ' + JSON.stringify(burst.map((r) => r.error)));
  // While the rate holds the rest, a repeat of what was done is still answered as done: it takes no token.
  assert.deepEqual(await emit(lou.s, 'room:withdraw', { messageId: first.id }), { ok: true, already: true }, 'a repeat is answered before the rate');
  await wait(3200);
  assert.ok((await act(ctl, 'admin:deleteRoom', { roomCode: MEDIA })).ok);
  assert.deepEqual(await withdraw(lou, toMedia.id), { ok: false, error: 'It is no longer in Hall B › Media: there is nothing to withdraw.' });

  // Every change Legal's pages were sent, Lou's from its join on, reached them under the next number: no gap, so no page
  // rejoins to catch up.
  const legalNow = (await emit(await page(louCookie), 'join', { roomCode: LEGAL, as: 'account' })).seq;
  const louSeqs = seqsOf('lou');
  assert.deepEqual(louSeqs, Array.from({ length: legalNow - lou.j.seq }, (_, i) => lou.j.seq + 1 + i), 'Lou\'s page heard every change in order');
  // And Hall A's, its quotes taken out among them.
  const gusSeqs = seqsOf('gus');
  assert.deepEqual(gusSeqs, Array.from({ length: gusSeqs.length }, (_, i) => gus.j.seq + 1 + i), 'Gus\'s page heard every change in order');
  // Vic's page, back by resuming, is sent each withdrawal's mark among the changes it missed.
  const back = await emit(await page(vicCookie), 'join', { roomCode: LEGAL, as: 'account', since: vicSince });
  assert.ok(Array.isArray(back.ops), JSON.stringify(back).slice(0, 200));
  assert.deepEqual(back.ops.map((o) => o.s), Array.from({ length: back.ops.length }, (_, i) => vicSince + 1 + i), 'the ops it missed, in order');
  assert.deepEqual(back.ops.filter((o) => o.o === 'upd' && o.f.sentTo).map((o) => [o.id, Number.isInteger(o.f.sentTo.withdrawn)]), [[first.id, true], [second.id, true], [fileSent.id, true]]);

  // The transcript says it of each copy: withdrawn and after how long, or where it went.
  const transcript = await (await fetch(srv.base + '/api/admin/transcript/' + LEGAL, { headers: { cookie: admin } })).text();
  assert.equal((transcript.match(/⊘ Withdrawn from Hall A after \d+ s — a copy kept here/g) || []).length, 2, 'the two copies withdrawn and kept');
  assert.ok(transcript.includes('↗ Sent to Hall A — a copy kept here') && transcript.includes('↗ Sent to Hall B › Media — a copy kept here'), 'the copies not withdrawn say where they went');

  // One row each, by the room it went from and how long it was there: never the words or a file's name.
  const rows = rowsOf(srv.dataDir, 'room.withdraw');
  assert.deepEqual(rows.map(([target, , who]) => [target, who]), [[LEGAL, 'Gus'], [hallA, 'lou'], [hallA, 'ana'], [hallA, 'lou']]);
  assert.deepEqual(rows.map(([, words]) => words.replace(/there \d+ s$/, 'there N s')), [
    'a message sent from Main (Hall A), there N s',
    'a message sent from Legal (Hall A), there N s',
    'a message by lou sent from Legal (Hall A), there N s',
    'a file sent from Legal (Hall A), there N s',
  ]);
  assert.ok(!JSON.stringify(rows).match(/fee|venue|mistake|\/uploads\//i), 'no words, no file name, no link');
});

// ---------------------------------------------------------------- the picker (public/sendfrom.js), its pure half
test('the picker: every hall\'s rooms grouped, this room not offered, each ticked where it may send here and its ↔ where this room sends into it, ticked or not; a save is the ticks and the ↔s, a ↔ added only beside a tick, nothing changed sends nothing, and the words name what changed', () => {
  const P = loadPicker();
  const settings = {
    key: 'LGQ4MZP8', name: 'Legal', main: false, hallName: 'Hall 2',
    sendFrom: [{ key: 'K7P2QX', name: 'Hall 3', main: true, hallName: 'Hall 3' }, { key: 'M3DR7VX2', name: 'Media', main: false, hallName: 'Hall 2' }], sendBack: ['H2H2H2', 'M3DR7VX2'],
    everyHall: [
      { key: 'H2H2H2', name: 'Hall 2', rooms: [{ key: 'H2H2H2', name: 'Hall 2', main: true }, { key: 'LGQ4MZP8', name: 'Legal', main: false }, { key: 'M3DR7VX2', name: 'Media', main: false }] },
      { key: 'K7P2QX', name: 'Hall 3', rooms: [{ key: 'K7P2QX', name: 'Hall 3', main: true }] },
    ],
  };
  // Hall 2's Main room may not send into Legal, but Legal sends into it: its ↔ is drawn ticked beside no tick.
  const groups = plain(P.groupsFor(settings));
  assert.deepEqual(groups, [
    { hall: 'Hall 2', rooms: [
      { key: 'H2H2H2', name: 'Main room', self: false, on: false, back: true },
      { key: 'LGQ4MZP8', name: 'Legal', self: true, on: false, back: false },
      { key: 'M3DR7VX2', name: 'Media', self: false, on: true, back: true },
    ] },
    { hall: 'Hall 3', rooms: [{ key: 'K7P2QX', name: 'Main room', self: false, on: true, back: false }] },
  ]);
  // The ticks as they were: nothing to send.
  const ticks = (list) => list.map(([key, on, back]) => ({ key, on, back }));
  assert.equal(P.changeOf(settings, ticks([['H2H2H2', false, true], ['M3DR7VX2', true, true], ['K7P2QX', true, false]])), null);
  // Ticks added and ↔s taken off: every room ticked and every ↔ ticked; this room is never sent.
  assert.deepEqual(plain(P.changeOf(settings, ticks([['H2H2H2', true, false], ['M3DR7VX2', true, false], ['K7P2QX', true, true], ['LGQ4MZP8', true, true]]))),
    { code: 'LGQ4MZP8', sendFrom: ['H2H2H2', 'M3DR7VX2', 'K7P2QX'], sendBack: ['K7P2QX'] }, 'this room is never sent, ticked or not');
  // None ticked, every ↔ as drawn: the ↔s where Legal sends now are kept; one beside no tick where it does not is never sent.
  assert.deepEqual(plain(P.changeOf(settings, ticks([['H2H2H2', false, true], ['M3DR7VX2', false, true], ['K7P2QX', false, true]]))),
    { code: 'LGQ4MZP8', sendFrom: [], sendBack: ['H2H2H2', 'M3DR7VX2'] }, 'none ticked: none may send here, and Legal still sends where it did');
  // A room newly ticked beside a ↔ drawn ticked (Legal sends there already) is sent with it, so the save keeps it.
  assert.deepEqual(plain(P.changeOf(settings, ticks([['H2H2H2', true, true], ['M3DR7VX2', true, true], ['K7P2QX', true, false]]))),
    { code: 'LGQ4MZP8', sendFrom: ['H2H2H2', 'M3DR7VX2', 'K7P2QX'], sendBack: ['H2H2H2', 'M3DR7VX2'] });
  // What a save said, from the server's answer, each room it now sends into or no longer does by name.
  const where = 'Hall 2 › Legal';
  assert.equal(P.words({ ok: true, already: true }, where, settings), 'Nothing changed.');
  assert.equal(P.words({ ok: true, sendFrom: ['A', 'B'], sendBack: ['K7P2QX'], into: ['K7P2QX'], notInto: ['H2H2H2', 'M3DR7VX2'] }, where, settings),
    'Saved: 2 rooms may send into Hall 2 › Legal. It now sends into Hall 3. It no longer sends into Hall 2 and Hall 2 › Media.');
  assert.equal(P.words({ ok: true, sendFrom: ['A'], sendBack: ['M3DR7VX2'], into: [], notInto: [] }, where, settings), 'Saved: 1 room may send into Hall 2 › Legal.');
  assert.equal(P.words({ ok: true, sendFrom: [], sendBack: [], into: [], notInto: ['M3DR7VX2'] }, where, settings), 'Saved: no room may send into Hall 2 › Legal. It no longer sends into Hall 2 › Media.');
  assert.equal(P.words({ ok: true, sendFrom: [], sendBack: [], into: ['H2H2H2', 'M3DR7VX2', 'K7P2QX', 'NOROOM12', 'NOROOM34'], notInto: [] }, where, settings),
    'Saved: no room may send into Hall 2 › Legal. It now sends into Hall 2, Hall 2 › Media, Hall 3 and 2 more.', 'the fourth on counted');
  assert.equal(P.words({ ok: true, sendFrom: [], sendBack: [], into: [], notInto: ['NOROOM12'] }, where, settings), 'Saved: no room may send into Hall 2 › Legal. It no longer sends into a room.', 'a room the picker did not draw');
  // Read without the admin's everyHall (one who sets halls up): no picker.
  assert.deepEqual(plain(P.groupsFor({ ...settings, everyHall: undefined })), [], 'no picker without every hall\'s rooms');
});
