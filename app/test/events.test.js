'use strict';
// Events (lib/events.js, server.js; the 0.6.0 plan's 6-U15): the current event archived into data/archive/<time>/, never
// deleted silently; the next one a copy of an event's settings and structure, an archived event continued, or a fresh
// one; what the node holds (its links, keys, pins, the last machine event, the confidential holds) kept in all three;
// every sign-in ended; the archive point the act's one audit row; a stop part way finished by the next start; an
// archive's contents deleted only by the laptop's token typed, its record kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const events = require('../lib/events');
const nodes = require('../lib/nodes');
const { startServer, stopServer, restartServer, api, connect, emit, until, inviteOf, TOKEN, setupAdmin } = require('./helpers');

const PASSWORD = 'the green room kettle';
const STAFF_PASSWORD = 'cable ties and gaffer';
// The node's own settings: none of them is ever an event's. Sealed values that open with no key here stay as they are.
const KEPT = ['stagewatchUrl', 'stagewatchKeySealed', 'stagewatchFingerprint', 'hallStagewatch', 'peerLinks', 'tlsPins', 'nodeId', 'contextTokenSealed', 'aiKeySealed', 'machineSeq'];
// A hold on the default Stagewatch's frame, as the stage keeps one (lib/pages.js storedHold): it belongs to the link.
const HOLD = { mac: 'k2Jd9fQ0', messageId: 41, sends: [], proposals: [], caught: [], rooms: [] };

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const settingsOf = (dir) => readJson(path.join(dir, 'settings.json'));
const keptOf = (s) => JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, s[k]])));
const filesIn = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const archives = (dataDir) => filesIn(path.join(dataDir, 'archive')).filter((n) => events.NAME.test(n));
/** The audit log's live entries, oldest first. */
const liveAudit = (dataDir) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allAudit = (dataDir) => [...filesIn(dataDir).filter((n) => /^audit-.*\.jsonl$/.test(n)).flatMap((n) => fs.readFileSync(path.join(dataDir, n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))), ...liveAudit(dataDir)];

/** A screen's browser on its link: the states it is told, and whether it was told the link is not in use. */
const screen = (base, token, sockets) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: token } });
  sockets.push(s);
  const got = { states: [], unknown: null, socket: s };
  s.on('display:state', (x) => got.states.push(x));
  s.on('display:unknown', (x) => { got.unknown = x; });
  s.once('connect', () => resolve(got));
  s.once('connect_error', reject);
});

/**
 * A server with an event in it: the first admin, a Staff account (its clock and On stage switches set by the admin), two
 * halls (Hall 2 with a side room, locked, its guests' web pages on, its own Stagewatch link), a guest's messages, a help
 * request and a file, a screen with a take, a room that may send into another, and the node's settings and a hold seeded.
 */
async function eventServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-event-'));
  // The node's settings as an earlier run left them, and a hold on the default Stagewatch's frame.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ nodeId: 'c0ffee01', stagewatchUrl: '127.0.0.1:9', stagewatchKeySealed: 'enc1:not-this-machine', stagewatchFingerprint: 'sha256:' + 'ab'.repeat(32), peerLinks: { patterns01: { t: 'patterns', url: 'http://127.0.0.1:9', name: 'Patterns FOH', tokenSealed: 'enc1:node', hall: '' } }, tlsPins: { '127.0.0.1:9': 'sha256:' + 'cd'.repeat(32) }, contextTokenSealed: 'enc1:context', aiKeySealed: 'enc1:ai', machineSeq: 7 }, null, 2)); // secret-scan: fixture
  fs.writeFileSync(path.join(dataDir, 'pages.json'), JSON.stringify({ v: 1, views: {}, halls: {}, holds: { default: HOLD } }));
  // A show-desk result waiting for the default Stagewatch, not linked now (lib/deskresults.js): its tag is that link's
  // address, so a desk tick keeps it waiting (a result naming any other Stagewatch is ended as having nobody to tell),
  // and it is archived with its event.
  fs.writeFileSync(path.join(dataDir, 'desk-results.json'), JSON.stringify({ results: [{ sw: nodes.addressTag(nodes.normaliseBase('127.0.0.1:9')), link: 'default', id: 'p3', created: 1_700_000_000_000, line: 'Hall 2: Five minutes', target: 'c0ffee01', ok: true, words: 'Shown', ran: 1_700_000_000_500 }] }));
  const srv = await startServer({ AGM_DATA_DIR: dataDir, ...env });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const base = srv.base;
  const root = (await setupAdmin(base, { username: 'root', name: 'Root Admin', password: PASSWORD })).cookie;
  assert.ok(root, 'the first admin');
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: root })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: root })).body.code;
  const made = await api(base, 'POST', '/api/users', { username: 'sid', name: 'Sid Staff', role: 'staff', halls: [hallA], password: STAFF_PASSWORD }, { cookie: root });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const sidId = made.body.user.id;
  assert.equal((await api(base, 'PATCH', '/api/users/' + sidId, { clock: { show: 'stage', locked: true }, onStage: { people: true } }, { cookie: root })).status, 200);
  const ctl = await connect(base, root); sockets.push(ctl);
  const side = await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' });
  assert.ok(side.ok, JSON.stringify(side));
  assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: '127.0.0.1:19' })).ok, 'Hall 2 follows a Stagewatch of its own');
  // A guest seated Backstage in Hall 2 before it is locked: the locked hall keeps her seat for a restart (settings.seats).
  const rae = await connect(base); sockets.push(rae);
  assert.ok((await emit(rae, 'join', { roomCode: hallA, name: 'Rae', role: 'research' })).ok);
  assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: hallA, on: true })).ok);
  assert.ok((await emit(ctl, 'admin:guestWeb', { roomCode: hallA, on: true })).ok, 'its backstage guests may show web pages');
  assert.ok((await emit(ctl, 'room:update', { code: hallB, sendFrom: [hallA] })).ok, 'Hall 2 may send into Hall 3');

  // A guest's messages, a help request and a file in Hall 3; a screen of Hall 3 with a take on it.
  const guest = await connect(base); sockets.push(guest);
  const gj = await emit(guest, 'join', { roomCode: hallB, name: 'Gus', role: 'research' });
  assert.ok(gj.ok, JSON.stringify(gj));
  assert.ok((await emit(guest, 'message', { type: 'text', text: 'Capex is on slide 14' })).ok);
  assert.ok((await emit(guest, 'message', { type: 'help', category: 'Sound', text: 'mic 3 is dead' })).ok);
  const f = new FormData(); f.append('file', new Blob(['notes for the board'], { type: 'text/plain' }), 'notes.txt');
  const url = (await (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': gj.uploadToken }, body: f })).json()).url;
  assert.ok((await emit(guest, 'message', { type: 'file', url, filename: 'notes.txt' })).ok);
  const shown = await emit(ctl, 'display:create', { code: hallB, name: 'Lectern monitor' });
  assert.ok(shown.ok, JSON.stringify(shown));
  assert.ok((await emit(ctl, 'display:take', { id: shown.display.id, content: { kind: 'countdown', text: 'Wrap up', tone: 'warn' } })).ok);
  const was = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms;
  return { was, hallAWas: was.find((r) => r.code === hallA), srv, base, dataDir, sockets, root, ctl, guest, hallA, hallB, sideKey: side.key, sidId, url, screenToken: shown.display.path.slice(3), screenId: shown.display.id };
}
const archive = (e, cookie, body) => api(e.base, 'POST', '/api/event/archive', body, { cookie });
const signIn = async (base) => (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
const rooms = (s) => new Promise((r) => { s.emit('admin:listRooms', r); });

test('events: copy, then continue, then fresh: each archived whole, what the node holds kept, every sign-in ended', async (t) => {
  const e = await eventServer(t);
  const { base, dataDir } = e;
  await until(() => !!settingsOf(dataDir).hallStagewatch, 3000, 'the settings saved');
  const keptBefore = keptOf(settingsOf(dataDir));
  const sid = (await api(base, 'POST', '/api/auth/login', { username: 'sid', password: STAFF_PASSWORD })).cookie;
  const laptop = await signIn(base);
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: laptop })).body.token, true, 'the laptop\'s token signed in');
  const scr = await screen(base, e.screenToken, e.sockets);
  await until(() => scr.states.length > 0, 3000, 'the screen\'s state');
  const oldCode = e.hallAWas.guestCode;
  const oldInvite = inviteOf(dataDir, oldCode, 'board');

  // The event has no name yet, and the server is busy: each is refused before anything is written.
  assert.deepEqual((await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum' })).body.error, 'Name this event first: it is archived under its name.');
  const busy = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit' });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.busy, true, 'busy without a reason is refused');
  assert.match(busy.body.error, /^Not archived: AGMessage is busy \(.+\)\. Type a reason to archive it anyway\.$/);
  assert.deepEqual(archives(dataDir), [], 'nothing archived');
  assert.equal((await rooms(e.ctl)).rooms.length, 2, 'nothing moved');

  // Copy this event's settings and structure, with a reason typed.
  const r = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'rehearsal over', split: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.signedOut, true);
  const [first] = archives(dataDir);
  assert.equal(r.body.archive, first);
  const dir = path.join(dataDir, 'archive', first);
  // The archive holds every room, upload, screen, take and account file the event had, counted alike.
  const rec = readJson(path.join(dir, 'event.json'));
  const { began, ...next } = rec.next;
  assert.deepEqual([rec.name, rec.kind, next], ['Spring Summit', 'first', { kind: 'copy', from: 'current', name: 'Autumn Forum', keepScreens: false }]);
  // The next event begun, said in the archive's record before the current event's record was written.
  assert.deepEqual([began.name, began.kind, began.from, began.id], ['Autumn Forum', 'copy', first, events.readLive(dataDir).rec.id]);
  assert.deepEqual({ halls: rec.counts.halls, rooms: rec.counts.rooms, messages: rec.counts.messages, help: rec.counts.help, files: rec.counts.files, accounts: rec.counts.accounts, screens: rec.counts.screens, deskResults: rec.counts.deskResults }, { halls: 2, rooms: 3, messages: 3, help: 1, files: 1, accounts: 2, screens: 1, deskResults: 1 });
  assert.equal(readJson(path.join(dir, 'desk-results.json')).results.length, 1, 'the desk result, archived');
  assert.deepEqual(filesIn(path.join(dir, 'rooms')).filter((n) => n.endsWith('.json')).length, 3, 'every room\'s snapshot');
  assert.deepEqual(filesIn(path.join(dir, 'uploads')), [e.url.slice(9)], 'the upload');
  assert.equal(readJson(path.join(dir, 'displays.json')).displays.length, 1, 'the screen, its take with it');
  assert.equal(readJson(path.join(dir, 'displays.json')).displays[0].content.text, 'Wrap up');
  assert.equal(readJson(path.join(dir, 'accounts.json')).users.length, 2);
  for (const f of ['pages.json', 'sessions.json', 'admin-sessions.json']) assert.ok(fs.existsSync(path.join(dir, f)), f + ' archived');
  // The guest a restart would keep seated in the locked hall is the archive's, never the copy's: a copy seats nobody.
  assert.deepEqual(Object.values(readJson(path.join(dir, 'rooms', e.hallA + '.json')).settings.seats || {}).map((x) => [x.name, x.role]), [['Rae', 'research']]);
  assert.equal(readJson(path.join(dataDir, 'rooms', e.hallA + '.json')).settings.seats, undefined, 'no seat in the copy');
  assert.deepEqual(filesIn(e.srv.dataDir + '-uploads'), [], 'no upload left in the uploads folder');
  // What the node holds is kept, byte for byte.
  assert.equal(keptOf(settingsOf(dataDir)), keptBefore, 'the node\'s settings unchanged');
  // The archive point is the act's one row: the first line of a new file, its target naming the archive and its run.
  const live = liveAudit(dataDir);
  assert.equal(live[0].action, 'audit.archive', 'the point opens a new audit.jsonl');
  assert.ok(live[0].target.startsWith(first + ';'), live[0].target);
  assert.match(live[0].target.slice(first.length + 1), /^[0-9a-f]{16}:\d+$/, 'and the run it stands in');
  assert.match(live[0].words, /^the event “Spring Summit” was archived into archive.2\d{3}-\d\d-\d\dT[0-9-]+Z while busy, for: rehearsal over; “Autumn Forum” begins as a copy of its settings and structure; links kept\. The audit log carries on, and can be split here \(Admin → Health\)\.$/);
  assert.equal(allAudit(dataDir).filter((x) => x.action === 'audit.archive').length, 1);
  assert.equal(allAudit(dataDir).filter((x) => /^event\./.test(x.action)).length, 0, 'no event.archived of its own');
  assert.deepEqual(rec.point, { seq: live[0].seq }, 'the point\'s entry is noted in the archive\'s record');

  // Every sign-in ended: the admin's account, the Staff account and the laptop's token.
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: e.root })).body.ok, false, 'the admin\'s session ended');
  assert.equal((await api(base, 'GET', '/api/auth/me', undefined, { cookie: sid })).body.account, null, 'Sid\'s session ended');
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: laptop })).body.ok, false, 'the token\'s sign-in ended');
  const root = (await api(base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).cookie;
  assert.ok(root, 'the accounts were copied, their passwords with them');
  const ctl = await connect(base, root); e.sockets.push(ctl);
  // The halls by their keys, each with a new code; the side room, the lock and its guests' web pages, the hall's
  // Stagewatch; no message, file or help request; no earlier code or invite opens it.
  const after = (await rooms(ctl)).rooms;
  assert.deepEqual(after.map((x) => [x.code, x.name, x.messageCount, x.side.map((y) => [y.key, y.name])]).sort(), [[e.hallA, 'Hall 2', 0, [[e.sideKey, 'Legal']]], [e.hallB, 'Hall 3', 0, []]].sort());
  const a2 = after.find((x) => x.code === e.hallA);
  assert.notEqual(a2.guestCode, oldCode, 'a new code');
  assert.equal(a2.locked, true, 'its lock');
  assert.equal(a2.guestWeb, true, 'its guests\' web pages, with its lock');
  assert.notEqual(a2.side[0].guestCode, e.hallAWas.side[0].guestCode);
  assert.equal((await api(base, 'GET', '/api/rooms/' + oldCode)).body.exists, false, 'the earlier code opens nothing');
  const late = await connect(base); e.sockets.push(late);
  const lj = await emit(late, 'join', { roomCode: a2.guestCode, name: 'Ivy', role: 'board', invite: oldInvite });
  assert.equal(lj.role, 'observer', 'an earlier event\'s invite seats nobody On stage');
  assert.equal((await emit(ctl, 'hall:settings', { code: e.hallA })).stagewatch.url, 'http://127.0.0.1:19', 'its Stagewatch link followed it');
  assert.deepEqual((await emit(ctl, 'room:settings', { code: e.hallB })).sendFrom.map((x) => x.key), [e.hallA], 'its allow-list');
  // The accounts with their rights and views: Sid's clock and On stage switches.
  const sidAfter = (await api(base, 'GET', '/api/users', undefined, { cookie: root })).body.users.find((u) => u.username === 'sid');
  assert.deepEqual([sidAfter.halls, sidAfter.clock, sidAfter.onStage.people], [[e.hallA], { show: 'stage', locked: true }, true]);
  // The screen by its name and hall, its countdown without its words, on a new link; the old link is told so.
  const screens = (await emit(ctl, 'display:list', { code: e.hallB })).displays;
  assert.deepEqual(screens.map((d) => [d.name, d.content.kind, d.content.text]), [['Lectern monitor', 'countdown', '']]);
  await until(() => scr.unknown, 3000, 'the old link told');
  assert.match(scr.unknown.words, /archived/);
  // The hold is in the new event's pages.json.
  await until(() => { try { return readJson(path.join(dataDir, 'pages.json')).holds; } catch { return null; } }, 3000, 'pages.json written');
  assert.deepEqual(readJson(path.join(dataDir, 'pages.json')).holds.default, HOLD, 'the hold carried');
  const ev = (await api(base, 'GET', '/api/event', undefined, { cookie: root })).body;
  assert.deepEqual([ev.event.name, ev.event.kind, ev.event.from, ev.archives.length, ev.archives[0].event.name], ['Autumn Forum', 'copy', first, 1, 'Spring Summit']);

  // Continue the archived event: the copy is archived first, then the first event comes back as it was.
  await new Promise((res) => setTimeout(res, 5));
  const laptop2 = await signIn(base);
  const c = await archive(e, root, { next: { kind: 'continue', from: first }, name: 'Spring Summit', reason: 'the next day' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const second = c.body.archive;
  assert.deepEqual(archives(dataDir), [first, second]);
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: root })).body.ok, false, 'its sign-ins ended too');
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: laptop2 })).body.ok, false, 'the token\'s too');
  const root2 = (await api(base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).cookie;
  const ctl2 = await connect(base, root2); e.sockets.push(ctl2);
  const back = (await rooms(ctl2)).rooms;
  const codes = (list) => list.map((x) => [x.code, x.guestCode, x.messageCount, x.locked, x.side.map((y) => [y.key, y.guestCode])]).sort();
  assert.deepEqual(codes(back), codes(e.was), 'its rooms, codes and messages as they were');
  assert.equal((await api(base, 'GET', '/api/rooms/' + oldCode)).body.exists, true, 'its code opens again');
  assert.deepEqual(filesIn(e.srv.dataDir + '-uploads'), [e.url.slice(9)], 'its upload back');
  await until(() => { try { return readJson(path.join(dataDir, 'desk-results.json')).results.length === 1; } catch { return false; } }, 3000, 'its desk result back');
  const again = await screen(base, e.screenToken, e.sockets);
  await until(() => again.states.length > 0 || again.unknown, 3000, 'the screen\'s link');
  assert.equal(again.unknown, null, 'its screen\'s link opens again');
  assert.equal(again.states[0].content.text, 'Wrap up', 'with its take');
  const firstRec = events.readArchived(dataDir, first);
  assert.equal(firstRec.continued.into, second, 'its record says it was continued');
  assert.deepEqual(filesIn(path.join(dataDir, 'archive', first)).filter((n) => !/^(event|sessions|admin-sessions)\.json/.test(n)), [], 'its archive keeps its record and the sign-ins that ended');
  const ev2 = (await api(base, 'GET', '/api/event', undefined, { cookie: root2 })).body;
  assert.deepEqual([ev2.event.name, ev2.event.kind, ev2.event.id], ['Spring Summit', 'continue', rec.id]);
  assert.equal(keptOf(settingsOf(dataDir)), keptBefore, 'the node\'s settings unchanged');
  assert.deepEqual(readJson(path.join(dataDir, 'pages.json')).holds.default, HOLD);

  // Start fresh: no halls, screens or accounts; each hall's Stagewatch link kept as an earlier hall's.
  await new Promise((res) => setTimeout(res, 5));
  const laptop3 = await signIn(base);
  const fr = await archive(e, root2, { next: { kind: 'fresh' }, name: 'Winter Gala', reason: 'a new show' });
  assert.equal(fr.status, 200, JSON.stringify(fr.body));
  assert.deepEqual([(await api(base, 'GET', '/api/admin/me', undefined, { cookie: root2 })).body.ok, (await api(base, 'GET', '/api/admin/me', undefined, { cookie: laptop3 })).body.ok], [false, false], 'every sign-in ended, the token\'s too');
  assert.equal((await api(base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).status, 401, 'no account in a fresh event');
  const token = await signIn(base);
  const tctl = await connect(base, token); e.sockets.push(tctl);
  assert.deepEqual((await rooms(tctl)).rooms, []);
  const ev3 = (await api(base, 'GET', '/api/event', undefined, { cookie: token })).body;
  assert.deepEqual([ev3.event.name, ev3.event.kind, ev3.archives.length], ['Winter Gala', 'fresh', 3]);
  assert.deepEqual(ev3.earlierLinks.map((l) => [l.key, l.url, l.hall]), [[e.hallA, 'http://127.0.0.1:19', 'Hall 2']], 'an earlier hall\'s Stagewatch link, listed');
  assert.equal(keptOf(settingsOf(dataDir)), keptBefore, 'the node\'s settings unchanged');
  // The hold in the fresh event's pages.json: the live one went into the archive, and the new event's is written by its
  // lane a moment after the answer, from the state that already holds the hold.
  await until(() => { try { return readJson(path.join(dataDir, 'pages.json')).holds; } catch { return null; } }, 3000, 'pages.json written');
  assert.deepEqual(readJson(path.join(dataDir, 'pages.json')).holds.default, HOLD);
  // The token at the laptop makes the first admin account, as at a first start.
  const made = await setupAdmin(base, { username: 'root', name: 'Root Admin', password: PASSWORD });
  assert.equal(made.status, 200);
  // A new hall is offered the earlier link, on the admin page and on the halls board alike: it moves to the new hall.
  assert.equal((await emit(tctl, 'admin:createRoom', { name: 'Hall 9', link: 'NOSUCH' })).error, 'That earlier hall\'s Stagewatch link is not kept now: make the hall, then set its Stagewatch up.');
  assert.deepEqual((await api(base, 'GET', '/api/halls', undefined, { cookie: made.cookie })).body.earlierLinks.map((l) => [l.key, l.url]), [[e.hallA, 'http://127.0.0.1:19']]);
  assert.equal((await api(base, 'POST', '/api/rooms', { name: 'Hall 9', link: 'NOSUCH' }, { cookie: made.cookie })).status, 409);
  const nh = (await api(base, 'POST', '/api/rooms', { name: 'Hall 2 again', link: e.hallA }, { cookie: made.cookie })).body;
  assert.equal(nh.stagewatch, 'http://127.0.0.1:19', JSON.stringify(nh));
  assert.notEqual(nh.code, e.hallA, 'never an earlier hall\'s key');
  await until(() => Object.keys(settingsOf(dataDir).hallStagewatch).join() === nh.code, 3000, 'the earlier link moved to the new hall');
  assert.deepEqual((await api(base, 'GET', '/api/halls', undefined, { cookie: made.cookie })).body.earlierLinks, [], 'and is offered no more');
  // Three archive points, one per act, and no other event row.
  assert.equal(allAudit(dataDir).filter((x) => x.action === 'audit.archive').length, 3);
});

const preload = (...names) => [process.env.NODE_OPTIONS, ...names.map((n) => '--require "' + path.join(__dirname, n).split(path.sep).join('/') + '"')].filter(Boolean).join(' ');
/** The files an event's folder holds, as relative paths, sorted: what an archive must hold whole, wherever it is. */
const eventFiles = (dataDir, uploadDir) => [
  ...['rooms', 'stage'].flatMap((d) => filesIn(path.join(dataDir, d)).filter((n) => !n.endsWith('.log')).map((n) => d + '/' + n)),
  ...events.FILES.flatMap((f) => [f, f + '.bak']).filter((f) => fs.existsSync(path.join(dataDir, f))),
  ...filesIn(uploadDir).map((n) => 'uploads/' + n),
].sort();
const archivedFiles = (dir) => [
  ...['rooms', 'stage'].flatMap((d) => filesIn(path.join(dir, d)).filter((n) => !n.endsWith('.log')).map((n) => d + '/' + n)),
  ...events.FILES.flatMap((f) => [f, f + '.bak']).filter((f) => fs.existsSync(path.join(dir, f))),
  ...filesIn(path.join(dir, 'uploads')).map((n) => 'uploads/' + n),
].sort();

test('events: a move refused part way leaves the archive aside, every join and write refused; tried again, it finishes', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_MOVE_FAIL: 'displays.json' });
  const { base, dataDir } = e;
  const before = eventFiles(dataDir, dataDir + '-uploads');
  const r = await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing', split: true });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.stuck, true);
  assert.equal(r.body.split, undefined, 'no point yet, so no split');
  assert.match(r.body.error, /^The event is not archived whole: displays\.json could not be moved \(EBUSY\)\. What moved is in archive.\.2\d{3}-.+\.partial and nothing is lost/);
  const [partial] = events.partials(dataDir);
  assert.ok(partial, 'the archive is aside');
  assert.equal(readJson(path.join(dataDir, 'archive', '.' + partial + '.partial', 'event.json')).next.kind, 'fresh', 'its record first');
  assert.ok(fs.existsSync(path.join(dataDir, 'displays.json')), 'what was not moved is where it was');
  assert.equal(archives(dataDir).length, 0, 'not renamed');
  // Meanwhile every new join and every write is refused, a socket's and a request's.
  assert.deepEqual(await emit(e.guest, 'message', { type: 'text', text: 'into an event half archived' }), { ok: false, error: 'AGMessage is starting a new event, and archiving the one before has not finished: the admin finishes it (Admin → Event), or the next start of AGMessage does.' });
  const late = await connect(base); e.sockets.push(late);
  assert.equal((await emit(late, 'join', { roomCode: e.hallB, name: 'Lou', role: 'research' })).ok, false);
  assert.equal((await api(base, 'POST', '/api/rooms', { name: 'Hall 9' }, { cookie: e.root })).status, 503);
  const changing = (await api(base, 'GET', '/api/event', undefined, { cookie: e.root })).body.event.changing;
  assert.deepEqual([changing.stuck, changing.step], [partial, 'moves']);
  assert.equal(allAudit(dataDir).filter((x) => x.action === 'audit.archive').length, 0, 'no archive point yet');
  // Tried again (the file no longer held): it finishes, nothing is left in neither place, and the split asked with it is
  // made by this act, straight after its point.
  const again = await archive(e, e.root, {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.split.ok, true, JSON.stringify(again.body.split));
  const rows = allAudit(dataDir);
  const at = rows.findIndex((x) => x.action === 'audit.archive');
  assert.equal(rows[at + 1].action, 'audit.split', 'the split straight after the point');
  assert.deepEqual(archives(dataDir), [partial]);
  assert.deepEqual(events.partials(dataDir), []);
  for (const f of before) assert.ok(archivedFiles(path.join(dataDir, 'archive', partial)).includes(f), f + ' archived: every file the event had is in its archive');
  assert.deepEqual(eventFiles(dataDir, dataDir + '-uploads').filter((f) => !/^(rooms|stage)\//.test(f) && !/sessions\.json/.test(f) && f !== 'pages.json' && f !== 'accounts.json' && f !== 'accounts.json.bak' && f !== 'displays.json' && f !== 'desk-results.json'), [], 'and nothing of it is left in the folder (the next event\'s accounts are saved twice: their .bak is theirs)');
  assert.equal(allAudit(dataDir).filter((x) => x.action === 'audit.archive').length, 1, 'one point');
  const token = await signIn(base);
  assert.deepEqual((await rooms(await connect(base, token).then((s) => { e.sockets.push(s); return s; }))).rooms, [], 'the fresh event');
});

test('events: an archive a stop cut short is finished by the next start before it serves, then its point and the next event', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_MOVE_FAIL: 'accounts.json', AGM_TEST_MOVE_FAIL_ALL: '1' });
  const { dataDir } = e;
  const before = eventFiles(dataDir, dataDir + '-uploads');
  const r = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal((await archive(e, e.root, {})).status, 503, 'still held: refused again, and still aside');
  const [partial] = events.partials(dataDir);
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: '' });
  t.after(() => stopServer(srv.child));
  assert.match(srv.out(), /Event: {3}archiving “Spring Summit” was cut short by the last stop, and was finished at this start/);
  assert.deepEqual([archives(dataDir), events.partials(dataDir)], [[partial], []]);
  for (const f of before.filter((x) => !/sessions\.json/.test(x))) assert.ok(archivedFiles(path.join(dataDir, 'archive', partial)).includes(f), f + ' archived, none left in neither place');
  const points = allAudit(dataDir).filter((x) => x.action === 'audit.archive');
  assert.equal(points.length, 1, 'the point written by the start');
  assert.ok(points[0].target.startsWith(partial + ';'), points[0].target);
  assert.deepEqual(points[0].actor, { t: 'system', id: '', name: '' });
  // The copy began: the halls by their keys, the accounts.
  const root = (await api(srv.base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).cookie;
  const ctl = await connect(srv.base, root);
  t.after(() => ctl.close());
  assert.deepEqual((await rooms(ctl)).rooms.map((x) => x.code).sort(), [e.hallA, e.hallB].sort());
  assert.equal((await api(srv.base, 'GET', '/api/event', undefined, { cookie: root })).body.event.name, 'Autumn Forum');
});

/** A hall's messages as its snapshot in `dir` holds them, system lines left out. */
const said = (dir, key) => readJson(path.join(dir, 'rooms', key + '.json')).messages.filter((m) => m.type !== 'system').length;

test('events: a room\'s file another program holds as its archive is made: the next start finishes the archive, the room whole in it', async (t) => {
  // Each of a room's files in turn: its snapshot's backup held (the room loads from it at the start), then its snapshot.
  for (const ext of ['.json.bak', '.json']) {
    const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_MOVE_FAIL_ROOM: ext });
    const { dataDir } = e;
    const r = await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
    assert.equal(r.status, 503, ext + ': ' + JSON.stringify(r.body));
    const [partial] = events.partials(dataDir);
    const partialDir = path.join(dataDir, 'archive', '.' + partial + '.partial');
    e.sockets.forEach((s) => s.close());
    const srv = await restartServer(e.srv, { NODE_OPTIONS: '' });
    t.after(() => stopServer(srv.child));
    assert.match(srv.out(), /Event: {3}archiving “Spring Summit” was cut short by the last stop, and was finished at this start/, ext);
    assert.deepEqual([archives(dataDir), events.partials(dataDir)], [[partial], []], ext);
    const dir = path.join(dataDir, 'archive', partial);
    assert.equal(fs.existsSync(partialDir), false);
    // The hall's messages are in its archive as the event held them: nothing the start read of what was left behind is
    // written over them, and nothing of the event is left in the folder.
    assert.equal(said(dir, e.hallB), 3, ext + ': the hall\'s three messages in its archive');
    assert.deepEqual(filesIn(path.join(dataDir, 'rooms')), [], ext + ': no room of it left behind');
    assert.equal(fs.existsSync(path.join(dir, events.ASIDE)), false, ext + ': nothing written meanwhile, so nothing set aside');
    await stopServer(srv.child);
  }
});

test('events: the next event\'s record not put in place: the run waits until Finish puts it there, the split asked with it made once', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_LIVE_FAIL: '1' });
  const { base, dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing', split: true });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  const [name] = archives(dataDir);
  assert.equal(r.body.error, 'The event is archived (archive' + path.sep + name + '), and the next one has not begun: it stopped (the next event\'s record was not put in place (a stop, in this test)). Nothing is lost: Finish archiving begins it (close what holds the file first), and so does the next start of AGMessage.');
  assert.equal(r.body.split.ok, true, 'the split, begun straight after the point, answered with it');
  // Meanwhile every join and write is refused, and health names the step.
  const late = await connect(base); e.sockets.push(late);
  assert.equal((await emit(late, 'join', { roomCode: e.hallB, name: 'Lou', role: 'research' })).ok, false);
  const token = await signIn(base);
  assert.equal((await api(base, 'POST', '/api/rooms', { name: 'Hall 9' }, { cookie: token })).status, 503);
  const ev = (await api(base, 'GET', '/api/event', undefined, { cookie: token })).body.event;
  assert.deepEqual([ev.changing.step, ev.changing.stuck], ['next', name]);
  // Finish: the next event's record is put in place; no second point, and no second split.
  const done = await archive(e, token, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.split, undefined);
  assert.equal(events.readLive(dataDir).rec.name, 'Autumn Forum');
  assert.deepEqual(['audit.archive', 'audit.split'].map((a) => allAudit(dataDir).filter((x) => x.action === a).length), [1, 1]);
  const t2 = await signIn(base);
  assert.equal((await api(base, 'POST', '/api/rooms', { name: 'Hall 9' }, { cookie: t2 })).status, 200, 'the next event takes writes');
});

test('events: a stop before the archive says its next event began: the next start begins it, the holds carried from the archive, its point written once', async (t) => {
  // Its point's entry not noted in its record either: the start finds the point in the log, and writes none again.
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_BEGAN_FAIL: '1', AGM_TEST_POINT_FAIL: '1' });
  const { dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(archives(dataDir).length, 1, 'the archive is whole');
  assert.equal(events.readLive(dataDir).state, 'absent', 'and the folder is between two events');
  assert.equal(events.readArchived(dataDir, archives(dataDir)[0]).next.began, null);
  assert.equal(events.readArchived(dataDir, archives(dataDir)[0]).point, null, 'its point not noted');
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: '' });
  t.after(() => stopServer(srv.child));
  assert.match(srv.out(), /Event: {3}“Autumn Forum” began at this start/);
  assert.equal(events.readLive(dataDir).rec.name, 'Autumn Forum');
  assert.equal(events.readArchived(dataDir, archives(dataDir)[0]).next.began.name, 'Autumn Forum');
  const points = allAudit(dataDir).filter((x) => x.action === 'audit.archive');
  assert.equal(points.length, 1, 'its point written once');
  assert.deepEqual(events.readArchived(dataDir, archives(dataDir)[0]).point, { seq: points[0].seq }, 'and noted now');
  await until(() => { try { return !!readJson(path.join(dataDir, 'pages.json')).holds; } catch { return false; } }, 3000, 'pages.json written');
  assert.deepEqual(readJson(path.join(dataDir, 'pages.json')).holds.default, HOLD, 'the hold, read from the archive');
});

test('events: a stop after the archive says its next event began: the next start puts its record in place, and begins nothing again', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_LIVE_FAIL: '1' });
  const { dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  // The copy's halls, each with the code it was given: a start that began the copy again would give each another.
  const codesOf = () => filesIn(path.join(dataDir, 'rooms')).filter((n) => /^[A-Z0-9]+\.json$/.test(n)).map((n) => [n, readJson(path.join(dataDir, 'rooms', n)).guestCode]);
  const made = codesOf();
  assert.equal(made.length, 2);
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: '' });
  t.after(() => stopServer(srv.child));
  assert.match(srv.out(), /Event: {3}“Autumn Forum”'s record was put in place at this start/);
  assert.deepEqual(codesOf(), made, 'the copy as it was made, not made again');
  assert.equal(events.readLive(dataDir).rec.name, 'Autumn Forum');
  assert.equal(allAudit(dataDir).filter((x) => x.action === 'audit.archive').length, 1);
});

test('events: a current event\'s record that cannot be read at a start is no folder between two events: nothing is begun again or saved over', async (t) => {
  const e = await eventServer(t);
  const { dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The new event in use: a guest's messages with its new code, and an account of its own.
  const token = await signIn(e.base);
  const ctl = await connect(e.base, token); e.sockets.push(ctl);
  const b2 = (await rooms(ctl)).rooms.find((x) => x.code === e.hallB);
  const gus = await connect(e.base); e.sockets.push(gus);
  assert.ok((await emit(gus, 'join', { roomCode: b2.guestCode, name: 'Gus', role: 'research' })).ok);
  for (const text of ['one', 'two', 'three']) assert.ok((await emit(gus, 'message', { type: 'text', text })).ok);
  const root = (await api(e.base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).cookie;
  assert.equal((await api(e.base, 'POST', '/api/users', { username: 'newbie', name: 'New Person', role: 'staff', halls: [], password: STAFF_PASSWORD }, { cookie: root })).status, 200);
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_LIVE_UNREAD: '1' });
  t.after(() => stopServer(srv.child));
  assert.match(srv.out(), /this event's record \(event\.json\) could not be read \(EBUSY\): nothing is written over it/);
  assert.doesNotMatch(srv.out(), /began at this start/);
  assert.equal(said(dataDir, e.hallB), 3, 'its messages kept');
  assert.ok((await api(srv.base, 'POST', '/api/auth/login', { username: 'newbie', password: STAFF_PASSWORD })).cookie, 'its account kept');
  const t2 = await signIn(srv.base);
  const refused = await api(srv.base, 'POST', '/api/event/archive', { next: { kind: 'fresh' }, name: 'Winter Gala', reason: 'x' }, { cookie: t2 });
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /^Not archived: this event's record \(event\.json\) could not be read at this start \(EBUSY\)/);
  assert.equal((await api(srv.base, 'GET', '/api/event', undefined, { cookie: t2 })).body.event.unread, 'EBUSY');
});

test('events: a continue whose files do not all come back waits, its accounts kept, until Finish brings the rest', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_BACK_FAIL: 'accounts.json.bak' });
  const { base, dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [first] = archives(dataDir);
  const root = (await api(base, 'POST', '/api/auth/login', { username: 'root', password: PASSWORD })).cookie;
  const c = await archive(e, root, { next: { kind: 'continue', from: first }, name: 'Spring Summit', reason: 'the next day' });
  assert.equal(c.status, 503, JSON.stringify(c.body));
  const second = archives(dataDir).find((n) => n !== first);
  assert.ok(c.body.error.startsWith('The event is archived (' + path.join('archive', second) + '), and the next one has not begun: accounts.json.bak could not be moved (EBUSY)'), c.body.error);
  // The accounts that came back are what this run holds, so no save of the empty ones lands over them meanwhile.
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(readJson(path.join(dataDir, 'accounts.json')).users.length, 2, 'the accounts that came back, kept');
  const token = await signIn(base);
  const done = await archive(e, token, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const sidIn = await api(base, 'POST', '/api/auth/login', { username: 'sid', password: STAFF_PASSWORD });
  assert.ok(sidIn.cookie, 'its accounts: ' + JSON.stringify([sidIn.body, (await api(base, 'GET', '/api/health')).body.signins]));
  const t2 = await signIn(base);
  const ctl = await connect(base, t2); e.sockets.push(ctl);
  assert.deepEqual((await rooms(ctl)).rooms.map((x) => [x.code, x.guestCode]).sort(), e.was.map((x) => [x.code, x.guestCode]).sort(), 'its halls and codes');
  assert.equal((await emit(ctl, 'display:list', { code: e.hallB })).displays.length, 1, 'its screen');
  assert.equal(events.readLive(dataDir).rec.name, 'Spring Summit');
});

test('events: an archive a start cannot finish (its record unreadable) is served with every join and write refused, and finished once it reads', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_MOVE_FAIL: 'accounts.json', AGM_TEST_MOVE_FAIL_ALL: '1' });
  const { dataDir } = e;
  const r = await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  const [partial] = events.partials(dataDir);
  const recFile = path.join(dataDir, 'archive', '.' + partial + '.partial', 'event.json');
  const kept = fs.readFileSync(recFile, 'utf8');
  fs.writeFileSync(recFile, '{ torn');
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: '' });
  t.after(() => stopServer(srv.child));
  assert.match(srv.out(), /\[event\] The event is not archived whole: archive.\..+\.partial.event\.json cannot be read/);
  const token = await signIn(srv.base);
  assert.equal((await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 9' }, { cookie: token })).status, 503, 'no write into a half-moved event');
  const g = await connect(srv.base); t.after(() => g.close());
  assert.equal((await emit(g, 'join', { roomCode: e.hallB, name: 'Lou', role: 'research' })).ok, false);
  assert.equal((await api(srv.base, 'GET', '/api/event', undefined, { cookie: token })).body.event.changing.step, 'moves');
  const still = await api(srv.base, 'POST', '/api/event/archive', {}, { cookie: token });
  assert.equal(still.status, 503);
  // Its record readable again: Finish archives it, the files the start left where they were moved in with the rest.
  fs.writeFileSync(recFile, kept);
  const done = await api(srv.base, 'POST', '/api/event/archive', {}, { cookie: token });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(fs.existsSync(path.join(dataDir, 'archive', partial, 'accounts.json')));
  assert.equal(said(path.join(dataDir, 'archive', partial), e.hallB), 3);
});

test('events: a continue whose uploads come back across volumes into too little room is refused before anything moves', async (t) => {
  const e = await eventServer(t, { AGM_UPLOAD_MIN_FREE: '1000' });
  const { dataDir } = e;
  assert.equal((await archive(e, e.root, { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' })).status, 200);
  const [first] = archives(dataDir);
  e.sockets.forEach((s) => s.close());
  const srv = await restartServer(e.srv, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_UPLOADS_APART: '500', AGM_UPLOAD_MIN_FREE: '1000' });
  t.after(() => stopServer(srv.child));
  const token = await signIn(srv.base);
  const c = await api(srv.base, 'POST', '/api/event/archive', { next: { kind: 'continue', from: first }, name: 'Spring Summit', reason: 'x' }, { cookie: token });
  assert.equal(c.status, 507, JSON.stringify(c.body));
  assert.match(c.body.error, /^Not archived: the uploads of the event continued come back to the uploads folder, on another volume, which would have 0\.0 GB free/);
  assert.deepEqual(archives(dataDir), [first], 'nothing archived');
  assert.equal(events.readLive(dataDir).rec.name, 'Autumn Forum');
});

test('events: an archive\'s contents a deletion could not all remove are recorded, audited, and deleted by the next ask', async (t) => {
  const e = await eventServer(t, { NODE_OPTIONS: preload('eventmove-preload.js'), AGM_TEST_PURGE_LEFT: 'uploads' });
  const { base, dataDir } = e;
  assert.equal((await archive(e, e.root, { next: { kind: 'fresh' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'testing' })).status, 200);
  const [first] = archives(dataDir);
  const token = await signIn(base);
  const purge = () => api(base, 'POST', '/api/event/purge', { archive: first, token: TOKEN }, { cookie: token });
  const p = await purge();
  assert.equal(p.status, 207, JSON.stringify(p.body));
  assert.match(p.body.error, /^Not all deleted: uploads: EBUSY\. Close what holds them, then delete again\.$/);
  assert.deepEqual(filesIn(path.join(dataDir, 'archive', first)), ['event.json', 'uploads']);
  assert.deepEqual(events.readArchived(dataDir, first).purged.left, ['uploads']);
  const row = liveAudit(dataDir).at(-1);
  assert.equal(row.action, 'event.purged');
  assert.match(row.words, /, but for 1 part that could not be removed \(uploads: EBUSY\); its record is kept$/);
  const listed = (await api(base, 'GET', '/api/event', undefined, { cookie: token })).body.archives.find((a) => a.name === first);
  assert.equal(listed.contents, true, 'still offered for deletion');
  const again = await purge();
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(filesIn(path.join(dataDir, 'archive', first)), ['event.json']);
  assert.deepEqual(events.readArchived(dataDir, first).purged.left, []);
  assert.equal(liveAudit(dataDir).filter((x) => x.action === 'event.purged').length, 2);
  assert.equal((await purge()).body.already, true);
});

test('events: only the admin archives; copy keeps the screens\' links when ticked; the split follows the point; an archive\'s contents go only with the token typed', async (t) => {
  const e = await eventServer(t);
  const { base, dataDir } = e;
  const made = await api(base, 'POST', '/api/users', { username: 'mia', name: 'Mia Manager', role: 'manager', halls: [], grant: ['settings.manage'], password: 'running order on the wall' }, { cookie: e.root });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const mia = (await api(base, 'POST', '/api/auth/login', { username: 'mia', password: 'running order on the wall' })).cookie;
  assert.equal((await api(base, 'GET', '/api/admin/me', undefined, { cookie: mia })).body.ok, true, 'the admin page admits her');
  const ask = { next: { kind: 'copy', from: 'current' }, name: 'Autumn Forum', current: 'Spring Summit', reason: 'rehearsal over', keepScreens: true, split: true };
  assert.deepEqual([(await archive(e, mia, ask)).status, (await archive(e, mia, ask)).body.error], [403, 'Only an admin may archive an event.']);
  assert.equal((await api(base, 'GET', '/api/event', undefined, { cookie: mia })).body.admin, false, 'the page draws Archive this event… disabled for her');
  assert.equal((await archive(e, e.root, { ...ask, keepScreens: 'yes' })).status, 400, 'a tick is a tick');
  assert.deepEqual(archives(dataDir), []);
  const scr = await screen(base, e.screenToken, e.sockets);
  await until(() => scr.states.length > 0, 3000, 'the screen\'s state');
  const r = await archive(e, e.root, ask);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The split, as its own act straight after the point.
  assert.equal(r.body.split.ok, true, JSON.stringify(r.body.split));
  const all = allAudit(dataDir);
  const at = all.findIndex((x) => x.action === 'audit.archive');
  assert.equal(all[at + 1].action, 'audit.split', 'the split straight after the point');
  assert.ok(all[at + 1].target.startsWith(all[at].seq + ';'), all[at + 1].target);
  // The screen kept its link: it is told its new state, and is not sent away.
  await until(() => scr.states.length > 1, 3000, 'the screen\'s new state');
  assert.equal(scr.unknown, null);
  assert.deepEqual([scr.states.at(-1).name, scr.states.at(-1).content.kind, scr.states.at(-1).content.text], ['Lectern monitor', 'countdown', '']);
  assert.equal(scr.socket.connected, true);
  const [first] = archives(dataDir);
  // Copy from an archived event, and deleting an archive's contents: the token typed at the laptop, nothing less.
  const token = await signIn(base);
  const purge = (body) => api(base, 'POST', '/api/event/purge', body, { cookie: token });
  const auditArchive = filesIn(path.join(dataDir, 'audit-archive'));
  assert.ok(auditArchive.length, 'the split made an archive of the log');
  assert.equal((await purge({ archive: first, token: 'not-the-token' })).status, 401);
  assert.equal(liveAudit(dataDir).at(-1).action, 'login.token.fail');
  assert.ok(fs.existsSync(path.join(dataDir, 'archive', first, 'rooms')), 'nothing deleted');
  const p = await purge({ archive: first, token: TOKEN });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(filesIn(path.join(dataDir, 'archive', first)), ['event.json'], 'its record alone stays');
  assert.equal(events.readArchived(dataDir, first).purged.by, 'AGMessage laptop');
  assert.deepEqual(filesIn(path.join(dataDir, 'audit-archive')), auditArchive, 'the audit log\'s archive is never reached');
  const row = liveAudit(dataDir).at(-1);
  assert.deepEqual([row.action, row.target], ['event.purged', first]);
  assert.match(row.words, /^the contents of the archive of “Spring Summit” were deleted \(2 halls, 3 messages, 1 file, 3 accounts, with its takes and stage record\); its record is kept$/);
  assert.equal((await api(base, 'GET', '/api/audit/verify', undefined, { cookie: token })).body.ok, true, 'the log still checks');
  assert.equal((await purge({ archive: first, token: TOKEN })).body.already, true, 'asked again: done already');
  assert.equal((await archive(e, token, { next: { kind: 'copy', from: first }, name: 'Winter Gala', reason: 'x' })).status, 409, 'an archive whose contents went copies nothing');
});

// ---------------------------------------------------------------- lib/events.js on its own
/** A data folder and an uploads folder holding an event: two rooms, the stores, a record, two uploads. */
function eventFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-ev-'));
  const data = path.join(root, 'data');
  const uploads = path.join(root, 'uploads');
  for (const d of [path.join(data, 'rooms'), path.join(data, 'stage'), uploads]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'rooms', 'HALL01.json'), '{"code":"HALL01"}');
  fs.writeFileSync(path.join(data, 'rooms', 'HALL01.log'), '');
  fs.writeFileSync(path.join(data, 'stage', 'HALL01.json'), '{"v":1}');
  for (const f of ['pages.json', 'displays.json', 'accounts.json', 'accounts.json.bak', 'sessions.json']) fs.writeFileSync(path.join(data, f), '{}');
  events.writeLive(data, { v: 1, id: 'e0123456789ab', name: 'Spring Summit', began: 1, kind: 'first', from: '', after: '' });
  fs.writeFileSync(path.join(uploads, '1-a.txt'), 'one');
  fs.writeFileSync(path.join(uploads, '2-b.txt'), 'twotwo');
  return { root, data, uploads };
}
/** fs.statSync answering another device for the uploads folder: a folder on another volume. */
function otherVolume(t, uploads) {
  const statSync = fs.statSync;
  fs.statSync = function stat(p, ...rest) { const st = statSync.call(this, p, ...rest); return p === uploads ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st; };
  t.after(() => { fs.statSync = statSync; });
}

test('events: an archive\'s name is its time to the millisecond, and a record is read by type', () => {
  const at = Date.UTC(2026, 9, 27, 14, 2, 0, 0);
  assert.equal(events.nameAt(at), '2026-10-27T14-02-00-000Z');
  assert.equal(events.timeOf('2026-10-27T14-02-00-000Z'), at);
  assert.ok(Number.isNaN(events.timeOf('../x')) && Number.isNaN(events.timeOf('2026-10-27')));
  assert.deepEqual(events.firstOf('c0ffee01', 5), { v: 1, id: 'ec0ffee01', name: '', began: 5, kind: 'first', from: '', after: '' });
  assert.equal(events.cleanLive({ id: 'x', kind: 'first' }), null, 'an id that is none');
  assert.equal(events.cleanLive({ id: 'e0123456789ab', kind: 'merged' }), null, 'a kind that is none');
  const r = events.cleanArchived({ id: 'e0123456789ab', name: 'Spring\u0007 Summit', kind: 'copy', began: 1, ended: 2, from: '../etc', next: { kind: 'continue', from: '2026-10-27T14-02-00-000Z', name: 'x', keepScreens: 'yes', began: { id: 'e0123456789ab', at: 7, name: 'x', kind: 'continue', from: '2026-10-27T14-02-00-000Z' } }, split: 'yes', counts: { halls: 2, messages: -1 }, sends: { HALL01: ['HALL02', 'bad key', 3], 'not a key': ['HALL01'] }, halls: [{ key: 'HALL01', name: 'Hall 2' }, { key: '../', name: 'x' }], codes: ['HALL01', 'x', 7], point: { seq: 9 }, continued: { at: 3, into: 'nope' }, purged: { at: 4, by: 'AGMessage laptop', left: ['uploads', 7] } });
  assert.deepEqual([r.name, r.from, r.next, r.split, r.counts.halls, r.counts.messages, r.sends, r.halls, r.codes, r.point, r.continued, r.purged],
    ['Spring Summit', '', { kind: 'continue', from: '2026-10-27T14-02-00-000Z', name: 'x', keepScreens: false, began: { id: 'e0123456789ab', at: 7, name: 'x', kind: 'continue', from: '2026-10-27T14-02-00-000Z' } }, false, 2, 0, { HALL01: ['HALL02'] }, [{ key: 'HALL01', name: 'Hall 2' }], ['HALL01'], { seq: 9 }, { at: 3, into: '' }, { at: 4, by: 'AGMessage laptop', left: ['uploads'] }]);
  assert.equal(events.cleanArchived({ id: 'e0123456789ab', kind: 'first', next: { kind: 'fresh', began: { id: 'nope', at: 1, kind: 'fresh' } } }).next.began, null, 'a next begun that is none');
  assert.deepEqual(events.liveOf('2026-10-27T14-02-00-000Z', { id: 'e0123456789ab', at: 7, name: 'x', kind: 'copy', from: '' }), { v: 1, id: 'e0123456789ab', name: 'x', began: 7, kind: 'copy', from: '', after: '2026-10-27T14-02-00-000Z' });
  assert.equal(events.cleanArchived({ id: 'e0123456789ab', kind: 'first', next: { kind: 'merge' } }).next, null, 'a next that is none');
  assert.equal(events.cleanArchived({ id: 'e0123456789ab', kind: 'first', next: { kind: 'fresh', from: '2026-10-27T14-02-00-000Z' } }).next.from, '', 'a fresh start comes from nothing');
});

test('events: an archive as the keyed stores\' claim asks of it at a start: absent only by ENOENT; one being made, or whose record reads, exists; one whose record or list cannot be read exists, unread', () => {
  const f = eventFolder();
  const name = '2026-11-01T10-00-00-000Z';
  assert.deepEqual(events.archiveState(f.data, name), { exists: false, begun: false }, 'no archive folder at all');
  fs.mkdirSync(path.join(events.archiveDir(f.data), '.' + name + '.partial'), { recursive: true });
  assert.deepEqual(events.archiveState(f.data, name), { exists: true, begun: false }, 'one being made');
  fs.rmSync(path.join(events.archiveDir(f.data), '.' + name + '.partial'), { recursive: true });
  const dir = path.join(events.archiveDir(f.data), name);
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(events.archiveState(f.data, name), { exists: false, begun: false }, 'a folder whose record and its .bak are absent');
  const rec = { v: 1, id: 'e0123456789ab', name: 'Spring Summit', kind: 'first', began: 1, ended: 2, next: { kind: 'fresh', name: 'x' } };
  fs.writeFileSync(path.join(dir, events.LIVE), JSON.stringify(rec));
  assert.deepEqual(events.archiveState(f.data, name), { exists: true, begun: false });
  fs.writeFileSync(path.join(dir, events.LIVE), JSON.stringify({ ...rec, next: { ...rec.next, began: { id: 'e0123456789ab', at: 3, name: 'x', kind: 'fresh', from: '' } } }));
  assert.deepEqual(events.archiveState(f.data, name), { exists: true, begun: true });
  // A record that cannot be read (a folder in its place: EISDIR) or is not whole: the archive is there, and unread.
  fs.rmSync(path.join(dir, events.LIVE));
  fs.mkdirSync(path.join(dir, events.LIVE));
  assert.deepEqual(events.archiveState(f.data, name), { exists: true, begun: false, unread: 'EISDIR' });
  fs.rmSync(path.join(dir, events.LIVE), { recursive: true });
  fs.writeFileSync(path.join(dir, events.LIVE), '{"v":1,');
  assert.deepEqual(events.archiveState(f.data, name), { exists: true, begun: false, unread: 'not whole' });
  // The archives that cannot be listed (a file where their folder is): unread, never absent.
  const g = eventFolder();
  fs.writeFileSync(events.archiveDir(g.data), 'not a folder');
  assert.equal(events.archiveState(g.data, name).unread, 'ENOTDIR');
});

test('events: an archive moved across volumes copies the uploads, sized alike, before any is removed; a continue copies them back', async (t) => {
  const f = eventFolder();
  otherVolume(t, f.uploads);
  const plan = events.uploadsPlan(f.data, f.uploads);
  assert.deepEqual([plan.same, plan.files.map((x) => [x.name, x.bytes]), plan.bytes, typeof plan.free], [false, [['1-a.txt', 3], ['2-b.txt', 6]], 9, 'number']);
  const name = events.nameAt(Date.now());
  events.begin(f.data, name, { v: 1, id: 'e0123456789ab', name: 'Spring Summit', began: 1, ended: 2, kind: 'first', next: { kind: 'continue', from: name, name: 'Spring Summit' } });
  assert.deepEqual(events.partials(f.data), [name]);
  const moved = events.moveIn(f.data, f.uploads, name, { beat: () => {} });
  assert.ok(moved.moved >= 8, JSON.stringify(moved));
  const dir = events.folderOf(f.data, name);
  assert.deepEqual([events.partials(f.data), events.names(f.data)], [[], [name]]);
  assert.deepEqual(filesIn(path.join(dir, 'uploads')), ['1-a.txt', '2-b.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'uploads', '2-b.txt'), 'utf8'), 'twotwo');
  assert.deepEqual(filesIn(f.uploads), [], 'removed from the uploads folder once every one was copied');
  assert.deepEqual(events.readLive(f.data), { rec: null, state: 'absent', code: 'ENOENT' }, 'the folder is between two events');
  // Listed, with its contents; continued back across the volumes, the sign-ins stay.
  const listed = await events.list(f.data);
  assert.deepEqual([listed.length, listed[0].name, listed[0].contents, listed[0].record.name], [1, name, true, 'Spring Summit']);
  events.moveBack(f.data, f.uploads, name);
  assert.deepEqual(filesIn(f.uploads), ['1-a.txt', '2-b.txt']);
  assert.deepEqual(filesIn(path.join(f.data, 'rooms')), ['HALL01.json', 'HALL01.log']);
  assert.deepEqual(filesIn(dir), ['event.json', 'sessions.json'], 'its record and the sign-ins that ended stay');
  assert.equal((await events.list(f.data))[0].contents, false);
  assert.equal(events.markArchived(f.data, name, { continued: { at: 3, into: name } }), true);
  assert.equal(events.readArchived(f.data, name).continued.at, 3);
  assert.equal(events.markArchived(f.data, '2000-01-01T00-00-00-000Z', {}), false, 'no archive by that name');
  assert.equal(events.readArchived(f.data, '../x'), null);
});

test('events: a copy across volumes that stops part way leaves every upload in one place or both, never neither; an archive\'s contents deleted keep its record', async (t) => {
  const f = eventFolder();
  otherVolume(t, f.uploads);
  const name = events.nameAt(Date.now());
  events.begin(f.data, name, { v: 1, id: 'e0123456789ab', name: 'Spring Summit', began: 1, ended: 2, kind: 'first', next: { kind: 'fresh', name: 'Next' } });
  const copyFileSync = fs.copyFileSync;
  let n = 0;
  fs.copyFileSync = function refused(a, b, mode) { if (++n === 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return copyFileSync.call(this, a, b, mode); };
  try {
    assert.throws(() => events.moveIn(f.data, f.uploads, name), (e) => e.code === 'EBUSY' && /2-b\.txt could not be moved \(EBUSY\)/.test(e.words));
  } finally { fs.copyFileSync = copyFileSync; }
  const partial = path.join(f.data, 'archive', '.' + name + '.partial');
  assert.deepEqual([filesIn(f.uploads), filesIn(path.join(partial, 'uploads'))], [['1-a.txt', '2-b.txt'], ['1-a.txt']], 'the originals all stay until every copy is whole');
  // A copy left short of its size by a stop is made again at the next try.
  fs.writeFileSync(path.join(partial, 'uploads', '1-a.txt'), 'o');
  events.moveIn(f.data, f.uploads, name);
  const dir = events.folderOf(f.data, name);
  assert.deepEqual([filesIn(f.uploads), fs.readFileSync(path.join(dir, 'uploads', '1-a.txt'), 'utf8')], [[], 'one']);
  const r = await events.purge(f.data, name, { at: 5, by: 'AGMessage laptop' });
  assert.deepEqual([r.left, filesIn(dir)], [[], ['event.json']]);
  assert.deepEqual(events.readArchived(f.data, name).purged, { at: 5, by: 'AGMessage laptop', left: [] });
  assert.deepEqual((await events.list(f.data)).map((a) => [a.name, a.contents]), [[name, false]]);
});

test('events: a file the archive holds already is never written over: the newer one is set aside beside it, and a continue sets aside what is in its way', () => {
  const f = eventFolder();
  const name = events.nameAt(Date.now());
  events.begin(f.data, name, { v: 1, id: 'e0123456789ab', name: 'Spring Summit', began: 1, ended: 2, kind: 'first', next: { kind: 'fresh', name: 'Next' } });
  const partial = path.join(f.data, 'archive', '.' + name + '.partial');
  // A try that stopped moved the room's snapshot and the accounts; a start then wrote both again in the data folder.
  fs.mkdirSync(path.join(partial, 'rooms'), { recursive: true });
  fs.renameSync(path.join(f.data, 'rooms', 'HALL01.json'), path.join(partial, 'rooms', 'HALL01.json'));
  fs.renameSync(path.join(f.data, 'accounts.json'), path.join(partial, 'accounts.json'));
  fs.writeFileSync(path.join(f.data, 'rooms', 'HALL01.json'), '{"code":"HALL01","messages":[]}');
  fs.writeFileSync(path.join(f.data, 'accounts.json'), '{"users":[]}');
  const moved = events.moveIn(f.data, f.uploads, name);
  assert.equal(moved.aside, 2);
  const dir = events.folderOf(f.data, name);
  assert.equal(fs.readFileSync(path.join(dir, 'rooms', 'HALL01.json'), 'utf8'), '{"code":"HALL01"}', 'the archive keeps its own snapshot');
  assert.equal(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), '{}', 'and its own accounts');
  assert.deepEqual([filesIn(path.join(dir, events.ASIDE)), filesIn(path.join(dir, events.ASIDE, 'rooms'))], [['accounts.json', 'rooms'], ['HALL01.json']], 'the later ones set aside, never deleted');
  assert.equal(fs.readFileSync(path.join(dir, events.ASIDE, 'rooms', 'HALL01.json'), 'utf8'), '{"code":"HALL01","messages":[]}');
  // A continue: a room's file in the data folder is set aside in the archive before the archive's comes back; a second
  // one of that name beside the first, never over it.
  fs.mkdirSync(path.join(f.data, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(f.data, 'rooms', 'HALL01.json'), 'in the way');
  const back = events.moveBack(f.data, f.uploads, name);
  assert.equal(back.aside, 1);
  assert.equal(fs.readFileSync(path.join(f.data, 'rooms', 'HALL01.json'), 'utf8'), '{"code":"HALL01"}');
  assert.deepEqual(filesIn(path.join(dir, events.ASIDE, 'rooms')), ['HALL01.json', 'HALL01.json.1']);
  assert.equal(fs.readFileSync(path.join(dir, events.ASIDE, 'rooms', 'HALL01.json.1'), 'utf8'), 'in the way');
});

test('events: the current event\'s record is read as there, absent or not read, and an archive\'s contents are deleted only once its record is read', async (t) => {
  const f = eventFolder();
  assert.equal(events.readLive(f.data).state, 'ok');
  fs.writeFileSync(path.join(f.data, 'event.json'), '{ torn');
  fs.rmSync(path.join(f.data, 'event.json.bak'), { force: true });
  assert.deepEqual(events.readLive(f.data), { rec: null, state: 'unread', code: 'not JSON' }, 'a torn record is not read, and never taken for none');
  fs.writeFileSync(path.join(f.data, 'event.json'), '{"id":"x"}');
  assert.deepEqual(events.readLive(f.data), { rec: null, state: 'unread', code: 'not an event\'s record' });
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function busy(p, ...rest) { if (String(p).endsWith('event.json')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync.call(this, p, ...rest); };
  try { assert.deepEqual(events.readLive(f.data), { rec: null, state: 'unread', code: 'EBUSY' }); } finally { fs.readFileSync = readFileSync; }
  // An archive whose record cannot be read: nothing of it is deleted.
  const name = events.nameAt(Date.now());
  events.begin(f.data, name, { v: 1, id: 'e0123456789ab', name: 'Spring Summit', began: 1, ended: 2, kind: 'first', next: { kind: 'fresh', name: 'Next' } });
  fs.writeFileSync(path.join(f.data, 'event.json'), '{"v":1,"id":"e0123456789ab","kind":"first"}');
  events.moveIn(f.data, f.uploads, name);
  const dir = events.folderOf(f.data, name);
  const rec = fs.readFileSync(path.join(dir, 'event.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'event.json'), '{ torn');
  await assert.rejects(events.purge(f.data, name), SyntaxError);
  assert.ok(filesIn(dir).includes('rooms'), 'nothing deleted');
  fs.writeFileSync(path.join(dir, 'event.json'), rec);
  // A record that cannot be written again: the contents still go, and the answer says why the record was not.
  const rename = fs.promises.rename;
  fs.promises.rename = () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
  t.after(() => { fs.promises.rename = rename; });
  const r = await events.purge(f.data, name, { at: 5, by: 'AGMessage laptop' });
  fs.promises.rename = rename;
  assert.deepEqual([r.left, r.recorded, filesIn(dir)], [[], 'EBUSY', ['event.json']], 'its own temporary file removed with the write that failed');
  assert.equal(events.readArchived(f.data, name).purged, null);
  assert.equal(await events.holdsAny(f.data, name), false);
  assert.equal(await events.holdsAny(f.data, '2000-01-01T00-00-00-000Z'), false);
});
