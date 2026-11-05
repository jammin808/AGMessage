'use strict';
// Uploads are bounded: the rate per connection and per network (an address on the venue, a /64 for an IPv6 phone through
// the tunnel: a re-join, more sockets or the next address refill nothing), a floor of free disk space below which files
// pause before anything is written (so the room logs, the audit log and the saves always have room), files nobody posted
// removed after a while, and files a reset or a deletion cleared removed from the disk — unless another hall or a
// screen still shows them. A file is posted only in the room it was uploaded for, by who uploaded it, or again in a room
// that holds it already; it reaches another room by a forward.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { startServer, stopServer, restartServer, api, connect, emit, until, pngOf, TOKEN } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const form = (name, bytes) => { const f = new FormData(); f.append('file', new Blob([bytes], { type: 'text/plain' }), name); return f; };
const upload = (base, token, name = 'notes.txt', bytes = 'Capex was 4.2m') => fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: form(name, bytes) });
const files = (dir) => fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
const OTHER_ROOM = 'That file belongs to another room — send it from there.';

async function hallServer(t, env = {}) {
  const uploads = tmp('agm-up-');
  const srv = await startServer({ AGM_UPLOAD_DIR: uploads, ...env });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const guest = async (code, name, extra = {}) => {
    const s = await connect(srv.base, extra.cookie); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name, role: 'research', ...extra.join });
    assert.ok(j.ok, JSON.stringify(j));
    return { s, j };
  };
  return { srv, uploads, admin, hall, guest, sockets };
}

test('a re-join does not refill the upload rate, and several sockets from one address share one', async (t) => {
  const { srv, hall, guest } = await hallServer(t);
  const code = await hall('Hall 1');
  const { s, j } = await guest(code, 'Ana');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await upload(srv.base, j.uploadToken)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 429], 'four at once, then slow down');
  const again = await emit(s, 'join', { roomCode: code, name: 'Ana', role: 'research', uid: j.identity });
  assert.ok(again.uploadToken && again.uploadToken !== j.uploadToken, 'a new token for the new join');
  assert.equal((await upload(srv.base, again.uploadToken)).status, 429, 'the same connection: the same rate');

  // Four more sockets from this address, each with its own token: together they get the address's share, not 4 each.
  const more = [];
  for (let i = 0; i < 4; i++) more.push((await guest(code, 'Guest ' + i)).j.uploadToken);
  const statuses = [];
  for (const tok of more) for (let k = 0; k < 4; k++) statuses.push((await upload(srv.base, tok)).status);
  const accepted = statuses.filter((x) => x === 200).length;
  assert.ok(accepted <= 8, 'one address shares one upload rate, not four each: ' + statuses.join(' '));
  assert.ok(statuses.includes(429));
});

test('through the tunnel the sockets of one IPv6 network share one upload rate, whichever addresses of its /64 they come from; another network has its own', async (t) => {
  const { srv, hall } = await hallServer(t);
  const code = await hall('Remote hall');
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  /** A phone through the tunnel at `address`, seated in the hall: its upload token. */
  const phone = (address, name) => new Promise((resolve, reject) => {
    const s = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'cf-connecting-ip': address, 'cf-ray': '8f00aa' + sockets.length } });
    sockets.push(s);
    s.once('connect_error', reject);
    s.once('connect', () => { emit(s, 'join', { roomCode: code, name, role: 'research' }).then((j) => (j.ok ? resolve(j.uploadToken) : reject(new Error(JSON.stringify(j))))); });
  });
  // Three addresses of one /64, each its own connection with its own four: together the network's eight, not twelve.
  const one = [await phone('2001:db8:4:4::a', 'Ana'), await phone('2001:db8:4:4::b', 'Ben'), await phone('2001:db8:4:4:1:2:3:4', 'Cy')];
  const began = Date.now();
  const statuses = [];
  for (const tok of one) for (let k = 0; k < 4; k++) statuses.push((await upload(srv.base, tok)).status);
  const earned = Math.floor(((Date.now() - began) / 1000) * 0.5);
  const accepted = statuses.filter((x) => x === 200).length;
  assert.ok(accepted >= 8 && accepted <= 8 + earned, 'one network shares one upload rate: ' + statuses.join(' '));
  assert.equal(statuses.filter((x) => x === 429).length, 12 - accepted, 'the rest: slow down');
  // The next /64 is another network, with its own rate.
  const other = await phone('2001:db8:4:5::a', 'Dee');
  assert.equal((await upload(srv.base, other)).status, 200);
});

test('below the free-space floor files pause before anything is written', async (t) => {
  const { srv, uploads, hall, guest } = await hallServer(t, { AGM_UPLOAD_MIN_FREE: '1e15' });
  const { j } = await guest(await hall('Hall 1'), 'Ana');
  const r = await upload(srv.base, j.uploadToken);
  assert.equal(r.status, 507);
  assert.match((await r.json()).error, /disk space/);
  assert.deepEqual(files(uploads), [], 'nothing reached the folder');
});

test('a reset or a deletion removes the hall\'s files from the disk, except those another hall (shared there by a forward) or a screen still shows', async (t) => {
  const { srv, uploads, admin, hall, guest, sockets } = await hallServer(t);
  const a = await hall('Hall A');
  const b = await hall('Hall B');
  const ga = await guest(a, 'Ana');
  const gb = await guest(b, 'Ben');
  // Ana is in hall B too (one identity, two pages), so a message of hers in A may be forwarded there.
  await guest(b, 'Ana', { join: { uid: ga.j.identity } });
  const adm = await connect(srv.base, admin);
  sockets.push(adm);
  const filesIn = async (code) => (await emit(adm, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.type === 'file');
  const put = async (name, bytes = 'text of ' + name) => {
    const url = (await (await upload(srv.base, ga.j.uploadToken, name, bytes)).json()).url;
    const m = await emit(ga.s, 'message', { type: 'file', url, filename: name });
    assert.ok(m.ok, JSON.stringify(m));
    return { url, id: m.id };
  };
  const shared = await put('shared.txt');
  const own = await put('own.txt');
  const holding = await put('holding.png', pngOf());
  const deleted = await put('deleted.txt');
  // Hall B shares one of them: its link posted there directly is hall A's file, refused; it crosses by Ana's forward.
  assert.deepEqual(await emit(gb.s, 'message', { type: 'file', url: shared.url, filename: 'shared.txt' }), { ok: false, error: OTHER_ROOM });
  assert.deepEqual(await filesIn(b), [], 'nothing posted in hall B');
  const fwd = await emit(ga.s, 'forward', { messageId: shared.id, targetRoom: b });
  assert.ok(fwd.ok, JSON.stringify(fwd));
  assert.deepEqual((await filesIn(b)).map((m) => [m.id, m.url, m.from.name, m.forwardedFrom.roomName]), [[fwd.id, shared.url, 'Ana', 'Hall A']], 'hall B holds hall A\'s file by the forward');
  assert.ok((await emit(adm, 'display:hallHolding', { code: b, image: holding.url })).ok, 'hall B\'s screens hold on another');
  const onDisk = (u) => files(uploads).some((f) => u.url.endsWith(f));

  assert.ok((await emit(adm, 'admin:deleteMessage', { roomCode: a, messageId: deleted.id })).ok);
  assert.equal((await fetch(srv.base + deleted.url)).status, 404, 'a deleted file message takes its file with it');
  assert.ok(!onDisk(deleted));

  assert.ok((await emit(adm, 'admin:resetRoom', { roomCode: a })).ok);
  assert.equal((await fetch(srv.base + own.url)).status, 404, 'hall A\'s own file is gone after the reset');
  assert.ok(!onDisk(own), 'from the disk too');
  assert.equal((await fetch(srv.base + shared.url)).status, 200, 'the file hall B shares is still served');
  assert.equal((await fetch(srv.base + holding.url)).status, 200, 'and so is the one hall B\'s screens hold on');
  assert.ok(onDisk(shared) && onDisk(holding));
});

test('a file message is posted only in the room it was uploaded for, by the person who uploaded it, or again in a room that holds it already', async (t) => {
  const { srv, admin, hall, guest, sockets } = await hallServer(t);
  const a = await hall('Hall A');
  const b = await hall('Hall B');
  const ana = await guest(a, 'Ana');
  const anaB = await guest(b, 'Ana', { join: { uid: ana.j.identity } });
  const cy = await guest(a, 'Cy');
  const adm = await connect(srv.base, admin);
  sockets.push(adm);
  const filesIn = async (code) => (await emit(adm, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.type === 'file').map((m) => [m.url, m.from.name]);
  const urlOf = async (token, name) => (await (await upload(srv.base, token, name)).json()).url;
  const post = (s, url, name) => emit(s, 'message', { type: 'file', url, filename: name });

  // An upload made for hall A, by Ana's page there: from her page in hall B it is another room's, and in hall A itself
  // it is hers to post, not Cy's, until it is posted.
  const forA = await urlOf(ana.j.uploadToken, 'agenda.txt');
  assert.deepEqual(await post(anaB.s, forA, 'agenda.txt'), { ok: false, error: OTHER_ROOM });
  assert.deepEqual(await post(cy.s, forA, 'agenda.txt'), { ok: false, error: 'Only the person who uploaded that file can post it.' });
  assert.deepEqual([await filesIn(a), await filesIn(b)], [[], []], 'nothing posted in either hall');
  assert.ok((await post(ana.s, forA, 'agenda.txt')).ok);
  // Posted, it is hall A's: Cy posts it again there, and Ana's page in hall B still may not.
  assert.ok((await post(cy.s, forA, 'agenda.txt')).ok);
  assert.deepEqual(await post(anaB.s, forA, 'agenda.txt'), { ok: false, error: OTHER_ROOM });

  // An upload made for hall B by her page there is refused in hall A, and taken in hall B.
  const forB = await urlOf(anaB.j.uploadToken, 'notes.txt');
  assert.deepEqual(await post(ana.s, forB, 'notes.txt'), { ok: false, error: OTHER_ROOM });
  assert.ok((await post(anaB.s, forB, 'notes.txt')).ok);
  assert.deepEqual(await filesIn(a), [[forA, 'Ana'], [forA, 'Cy']]);
  assert.deepEqual(await filesIn(b), [[forB, 'Ana']]);

  // A forward takes hall A's file into hall B, between halls Ana is in; from then on hall B holds it, and it is posted
  // there again directly.
  const first = (await emit(adm, 'admin:watchRoom', { roomCode: a })).messages.find((m) => m.type === 'file');
  assert.ok((await emit(ana.s, 'forward', { messageId: first.id, targetRoom: b })).ok);
  assert.ok((await post(anaB.s, forA, 'agenda.txt')).ok);
  assert.deepEqual(await filesIn(b), [[forB, 'Ana'], [forA, 'Ana'], [forA, 'Ana']]);
});

test('an upload not yet posted when AGMessage restarts is uploaded again: its post is refused with reupload, and the new upload is posted under the same client id', async (t) => {
  const uploads = tmp('agm-up-');
  let srv = await startServer({ AGM_UPLOAD_DIR: uploads });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const code = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const join = async (uid) => {
    const s = await connect(srv.base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Ana', role: 'research', ...(uid ? { uid } : {}) });
    assert.ok(j.ok, JSON.stringify(j));
    return { s, j };
  };
  const before = await join();
  const early = (await (await upload(srv.base, before.j.uploadToken, 'deck-notes.txt')).json()).url;
  sockets.splice(0).forEach((s) => s.close());
  srv = await restartServer(srv, { AGM_UPLOAD_DIR: uploads });
  const after = await join(before.j.identity);
  assert.equal((await fetch(srv.base + early)).status, 200, 'the file is still on the laptop');
  assert.deepEqual(await emit(after.s, 'message', { type: 'file', url: early, filename: 'deck-notes.txt', cid: 'notes_once' }),
    { ok: false, error: 'That upload has expired: choose the file again.', reupload: true });
  const again = (await (await upload(srv.base, after.j.uploadToken, 'deck-notes.txt')).json()).url;
  const sent = await emit(after.s, 'message', { type: 'file', url: again, filename: 'deck-notes.txt', cid: 'notes_once' });
  assert.ok(sent.ok, JSON.stringify(sent));
  const adm = await connect(srv.base, admin); sockets.push(adm);
  const posted = (await emit(adm, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.type === 'file');
  assert.deepEqual(posted.map((m) => [m.id, m.url, m.cid]), [[sent.id, again, 'notes_once']], 'the refused post wrote nothing');
});

test('after a restart a posted file keeps to the rooms that hold it: its link is another room\'s elsewhere, and a file only a screen holds is chosen again', async (t) => {
  const uploads = tmp('agm-up-');
  let srv = await startServer({ AGM_UPLOAD_DIR: uploads });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const join = async (code, uid) => {
    const s = await connect(srv.base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Ana', role: 'research', ...(uid ? { uid } : {}) });
    assert.ok(j.ok, JSON.stringify(j));
    return { s, j };
  };
  const post = (s, url, name) => emit(s, 'message', { type: 'file', url, filename: name });
  const filesIn = async (code) => {
    const adm = await connect(srv.base, admin); sockets.push(adm);
    return (await emit(adm, 'admin:watchRoom', { roomCode: code })).messages.filter((m) => m.type === 'file').map((m) => m.url);
  };
  const one = await hall('Hall 1');
  const two = await hall('Hall 2');
  const ana = await join(one);
  const urlOf = async (name, bytes) => (await (await upload(srv.base, ana.j.uploadToken, name, bytes)).json()).url;
  // Before the restart: notes posted in hall 1; a picture posted there, made hall 1's holding image, and its message
  // deleted, so a screen alone holds it.
  const notes = await urlOf('notes.txt');
  assert.ok((await post(ana.s, notes, 'notes.txt')).ok);
  const poster = await urlOf('poster.png', pngOf());
  const shown = await post(ana.s, poster, 'poster.png');
  assert.ok(shown.ok, JSON.stringify(shown));
  const adm = await connect(srv.base, admin); sockets.push(adm);
  assert.ok((await emit(adm, 'display:hallHolding', { code: one, image: poster })).ok);
  assert.ok((await emit(ana.s, 'delete', { messageId: shown.id })).ok);
  sockets.splice(0).forEach((s) => s.close());
  srv = await restartServer(srv, { AGM_UPLOAD_DIR: uploads });

  // This run holds no record of either upload: hall 1's notes posted directly in hall 2 are hall 1's (no upload again
  // would make them hall 2's), and posted again in hall 1 they are taken; the picture only a screen holds is not.
  const inTwo = await join(two, ana.j.identity);
  assert.deepEqual(await post(inTwo.s, notes, 'notes.txt'), { ok: false, error: OTHER_ROOM });
  const inOne = await join(one, ana.j.identity);
  assert.ok((await post(inOne.s, notes, 'notes.txt')).ok);
  assert.equal((await fetch(srv.base + poster)).status, 200, 'the holding image is still on the laptop');
  assert.deepEqual(await post(inOne.s, poster, 'poster.png'), { ok: false, error: 'That file is on a screen, not in a room: choose the file again.', reupload: true });
  assert.deepEqual([await filesIn(one), await filesIn(two)], [[notes, notes], []], 'nothing refused was posted');
});

test('a file a hall\'s side room holds is in use: the Main room\'s reset keeps it; removing the room, then the hall, takes it and the room\'s files', async (t) => {
  // No act makes a side room yet: the folder is laid out as a store keeps one, a hall and two rooms beside it, before the start.
  const data = tmp('agm-side-');
  const uploads = tmp('agm-up-');
  const rooms = path.join(data, 'rooms');
  fs.mkdirSync(rooms);
  const name = (n) => '1700000000000-abcdefabcdef-' + n;
  for (const n of ['legal.txt', 'media.txt', 'main.txt']) fs.writeFileSync(path.join(uploads, name(n)), 'text of ' + n);
  const file = (id, n) => ({ id, type: 'file', url: '/uploads/' + name(n), filename: n, at: 1, seq: 1, from: { uid: 'u1', name: 'Ana', role: 'research' } });
  const room = (code, roomName, messages) => JSON.stringify({ code, name: roomName, createdAt: 1, seq: messages.length, settings: {}, messages, savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(rooms, 'HALLA1.json'), room('HALLA1', 'Hall A', [file('m1', 'legal.txt'), file('m2', 'main.txt')]));
  fs.writeFileSync(path.join(rooms, 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal', [file('m3', 'legal.txt')]));
  fs.writeFileSync(path.join(rooms, 'HALLA1.MDR7VX2C.json'), room('MDR7VX2C', 'Media', [file('m4', 'media.txt')]));
  const srv = await startServer({ AGM_DATA_DIR: data, AGM_UPLOAD_DIR: uploads });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const adm = await connect(srv.base, admin);
  sockets.push(adm);
  const health = async () => (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  const served = async (n) => (await fetch(srv.base + '/uploads/' + name(n))).status;
  const roomFiles = () => fs.readdirSync(rooms).filter((f) => !f.endsWith('.tmp')).sort();
  // The audit log's rows, as written (each on disk before its act is answered).
  const audit = (action) => fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words]);
  assert.deepEqual([(await health()).rooms, (await health()).sideRooms], [1, 2], 'one hall, two rooms beside it');

  // The Main room's reset: its own file goes; the one Legal holds too stays.
  assert.ok((await emit(adm, 'admin:resetRoom', { roomCode: 'HALLA1' })).ok);
  assert.equal(await served('main.txt'), 404, 'the Main room\'s own file is gone');
  assert.equal(await served('legal.txt'), 200, 'the file Legal still holds is still served');
  assert.ok(files(uploads).includes(name('legal.txt')));

  // A side room removed alone: its files and the file only it held go; its hall and the other room stay.
  const media = await emit(adm, 'admin:deleteRoom', { roomCode: 'MDR7VX2C', purgeFiles: true });
  assert.deepEqual([media.ok, media.purged], [true, 1]);
  assert.equal(await served('media.txt'), 404);
  assert.deepEqual(roomFiles().filter((f) => f.endsWith('.json')), ['HALLA1.LGQ4MZP8.json', 'HALLA1.json']);
  assert.deepEqual([(await health()).rooms, (await health()).sideRooms], [1, 1]);
  assert.deepEqual(audit('room.remove'), [['MDR7VX2C', 'Media (Hall A), files removed']]);

  // The hall removed goes with its room: every file of both, and the file Legal held.
  const hall = await emit(adm, 'admin:deleteRoom', { roomCode: 'HALLA1', purgeFiles: true });
  assert.deepEqual([hall.ok, hall.purged], [true, 1]);
  assert.equal(await served('legal.txt'), 404);
  assert.deepEqual(roomFiles(), [], 'no file of the hall or its room is left');
  assert.deepEqual([(await health()).rooms, (await health()).sideRooms], [0, 0]);
  assert.deepEqual(audit('hall.remove'), [['HALLA1', 'Hall A with 1 other room, files removed: Legal · LGQ4MZP8']]);
  assert.deepEqual(audit('room.remove'), [['MDR7VX2C', 'Media (Hall A), files removed'], ['LGQ4MZP8', 'Legal (Hall A), with its hall']], 'its room\'s own row too');
});

test('a side room whose snapshot another program holds: gone from this run, said to the admin, in its row and on the console, its uploads and its accounts kept, and back at the next start; likewise a hall', async (t) => {
  const data = tmp('agm-side-');
  const uploads = tmp('agm-up-');
  const rooms = path.join(data, 'rooms');
  fs.mkdirSync(rooms);
  const upload = '1700000000000-abcdefabcdef-legal.txt';
  fs.writeFileSync(path.join(uploads, upload), 'the contract');
  const room = (code, roomName, messages) => JSON.stringify({ code, name: roomName, createdAt: 1, seq: messages.length, settings: {}, messages, savedAt: 1, gone: [] });
  fs.writeFileSync(path.join(rooms, 'HALLA1.json'), room('HALLA1', 'Hall A', []));
  fs.writeFileSync(path.join(rooms, 'HALLA1.LGQ4MZP8.json'), room('LGQ4MZP8', 'Legal', [{ id: 'm1', type: 'file', url: '/uploads/' + upload, filename: 'legal.txt', at: 1, seq: 1, from: { uid: 'u1', name: 'Ana', role: 'research' } }]));
  // An account given the hall and its room, as the store keeps them (no page gives an account a room yet).
  const accountsFile = path.join(data, 'accounts.json');
  fs.writeFileSync(accountsFile, JSON.stringify({ v: 1, users: [{ id: 'a1', username: 'tom', name: 'Tom', role: 'tech', hash: 'x', createdAt: 1, halls: ['HALLA1'], rooms: ['LGQ4MZP8'] }] }));
  const tom = () => { const u = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).users[0]; return { halls: u.halls, rooms: u.rooms }; };
  // test/busy-preload.js: the room's snapshot cannot be removed, as when an antivirus or a backup holds it.
  const preload = '--require "' + path.join(__dirname, 'busy-preload.js').split(path.sep).join('/') + '"';
  const holding = (file) => ({ AGM_DATA_DIR: data, AGM_UPLOAD_DIR: uploads, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_UNREMOVABLE: file });
  let srv = await startServer(holding('HALLA1.LGQ4MZP8.json'));
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const adm = await connect(srv.base, admin);
  sockets.push(adm);
  const health = async () => (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  const gone = await emit(adm, 'admin:deleteRoom', { roomCode: 'LGQ4MZP8', purgeFiles: true });
  assert.deepEqual(gone, {
    ok: true, purged: 0, kept: 1,
    keptWords: 'Another program (an antivirus or a backup) held the files of 1 room, which stay in the data folder: the room opens again at the next start unless they are removed first, and its uploads are kept for it.',
  });
  assert.equal((await health()).sideRooms, 0, 'gone from this run');
  assert.equal((await fetch(srv.base + '/uploads/' + upload)).status, 200, 'its upload kept for it');
  assert.deepEqual(fs.readdirSync(rooms).filter((f) => f.startsWith('HALLA1.LGQ4MZP8')).sort(), ['HALLA1.LGQ4MZP8.json', 'HALLA1.LGQ4MZP8.log'], 'its backup went first; its snapshot held, it and its log stay, so it loads again whole');
  const rows = (action) => fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words]);
  assert.deepEqual(rows('room.remove'), [['LGQ4MZP8', 'Legal (Hall A), the files of 1 room held by another program and kept: it opens again at the next start']], 'no account updated');
  assert.match(srv.out(), /Could not remove HALLA1\.LGQ4MZP8\.json \(EBUSY\): it and the files of its room after it stay on disk/);
  // The account given the room keeps it: the room comes back with its members.
  assert.deepEqual(tom(), { halls: ['HALLA1'], rooms: ['LGQ4MZP8'] });
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer(srv.child);
  srv = await startServer({ AGM_DATA_DIR: data, AGM_UPLOAD_DIR: uploads });
  const back = await api(srv.base, 'GET', '/api/health', undefined, { cookie: (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie });
  assert.equal(back.body.sideRooms, 1, 'back at the next start, as the admin was told');
  assert.deepEqual(tom(), { halls: ['HALLA1'], rooms: ['LGQ4MZP8'] }, 'and given to the account that had it');

  // The hall's own snapshot held: the hall comes back, its room does not (its files went). The account keeps the hall
  // and is given the room no more, counted in the room's row and once in the hall's.
  await stopServer(srv.child);
  srv = await startServer(holding('HALLA1.json'));
  const adm2 = await connect(srv.base, (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie);
  sockets.push(adm2);
  const hall = await emit(adm2, 'admin:deleteRoom', { roomCode: 'HALLA1', purgeFiles: true });
  assert.deepEqual([hall.ok, hall.purged, hall.kept], [true, 0, 1], JSON.stringify(hall));
  assert.deepEqual(rows('room.remove').slice(1), [['LGQ4MZP8', 'Legal (Hall A), with its hall, 1 account updated']]);
  assert.deepEqual(rows('hall.remove'), [['HALLA1', 'Hall A with 1 other room, the files of 1 room held by another program and kept: it opens again at the next start, 1 account updated: Legal · LGQ4MZP8']]);
  await until(() => tom().rooms.length === 0, 3000, 'the account saved');
  assert.deepEqual(tom(), { halls: ['HALLA1'], rooms: [] });
  assert.equal((await fetch(srv.base + '/uploads/' + upload)).status, 200, 'the hall\'s uploads kept for it');
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer(srv.child);
  srv = await startServer({ AGM_DATA_DIR: data, AGM_UPLOAD_DIR: uploads });
  const after = await api(srv.base, 'GET', '/api/health', undefined, { cookie: (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie });
  assert.deepEqual([after.body.rooms, after.body.sideRooms], [1, 0], 'the hall back, its room not');
});

test('a file nobody posted is removed after a while; a posted one stays', async (t) => {
  const { srv, uploads, hall, guest } = await hallServer(t, { AGM_UPLOAD_ORPHAN_MS: '400' });
  const { s, j } = await guest(await hall('Hall 1'), 'Ana');
  const posted = await (await upload(srv.base, j.uploadToken, 'posted.txt')).json();
  const orphan = await (await upload(srv.base, j.uploadToken, 'orphan.txt')).json();
  assert.ok((await emit(s, 'message', { type: 'file', url: posted.url, filename: 'posted.txt' })).ok);
  assert.equal(files(uploads).length, 2);
  await until(() => files(uploads).length === 1, 5000, 'the orphan removed');
  assert.ok(posted.url.endsWith(files(uploads)[0]), 'the posted file stays');
  assert.equal((await fetch(srv.base + orphan.url)).status, 404);
});
