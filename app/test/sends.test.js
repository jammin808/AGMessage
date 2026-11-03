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
const { ROOT, startServer, restartServer, stopServer, api, connect, emit, until, wait, TOKEN } = require('./helpers');

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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'sendfrom.js'), 'utf8'), ctx, { filename: 'sendfrom.js' });
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
