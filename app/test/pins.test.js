'use strict';
// Pins for the room or for oneself (plan 7-§17.5, unit 20c), end to end on a real server. A pin for the room is the
// message's own `pinned`, a room's op every page in it hears, made by a seat that may post and is not On stage; a pin for
// oneself is kept for the person alone (pages.json `pins`, by their key and the room), by every seat that reads the room,
// told to that person's pages in the room and the admin's view of them, and to nobody else. The store's own rules (its
// bounds, its read-back, a room's pins forgotten) are pure and read in test/pages.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stopServer, restartServer, api, connect, emit, until, wait, inviteOf, TOKEN, setupAdmin } = require('./helpers');

const PASSWORD = 'the green room kettle';
const BACKSTAGE_PINS = 'Pinning for everyone is for the backstage team.';
const OBSERVERS = 'Observers can read but not post.';
const OWN = 'Pins are the person\'s own.';
const SAY = 'Say pin or unpin.';
const FULL = '50 pins in this room at most: unpin one first.';
const NOT_FOUND = 'Message not found';

test('pins for the room or for me: every seat pins for itself, kept by its key and told to its own pages alone; the room\'s pin from backstage alone, never On stage', { timeout: 120_000 }, async (t) => {
  let srv = await startServer();
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
  const joined = async (s, args) => { const r = await emit(s, 'join', args); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const told = (s, ev) => heard.get(s).filter(([e]) => e === ev).map(([, v]) => v);
  const kept = () => { try { return JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).pins || {}; } catch { return null; } };

  const admin = (await setupAdmin(srv.base, { username: 'root', name: 'Root Admin', password: PASSWORD })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return { id: made.body.user.id, cookie: (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie };
  };
  const bea = await account('bea', 'Bea Board', 'staff', { halls: [hall], board: [hall] });   // a Board account
  const vic = await account('vic', 'Vic Viewer', 'viewer', { halls: [hall] });                // a Viewer account

  // Ana and Ben backstage, Obi an observer, Gil On stage on two devices, Bea's tablet and phone, Vic, and the admin's view
  // of Gil and of Bea.
  const ana = await page(undefined, 'Ana backstage');
  const anaJoin = await joined(ana, { roomCode: hall, name: 'Ana', role: 'research' });
  const ben = await page(undefined, 'Ben backstage');
  await joined(ben, { roomCode: hall, name: 'Ben', role: 'research' });
  const obi = await page(undefined, 'Obi observing');
  const obiJoin = await joined(obi, { roomCode: hall, name: 'Obi', role: 'observer' });
  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board', invite: inviteOf(srv.dataDir, hall) });
  const gil2 = await page(undefined, 'Gil\'s second device');
  await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  const beaTab = await page(bea.cookie, 'Bea\'s tablet');
  const beaJoin = await joined(beaTab, { roomCode: hall, as: 'account' });
  const beaPhone = await page(bea.cookie, 'Bea\'s phone');
  await joined(beaPhone, { roomCode: hall, as: 'account' });
  const vicPage = await page(vic.cookie, 'Vic viewing');
  const vicJoin = await joined(vicPage, { roomCode: hall, as: 'account' });
  const gilView = await page(admin, 'the admin\'s view of Gil');
  await joined(gilView, { roomCode: hall, name: 'Gil', role: 'board', adminView: true, viewOf: gilJoin.uid });
  const beaView = await page(admin, 'the admin\'s view of Bea');
  await joined(beaView, { roomCode: hall, name: 'Bea Board', role: 'board', adminView: true, viewOf: bea.id });
  assert.deepEqual([anaJoin.role, obiJoin.role, gilJoin.role, beaJoin.role, vicJoin.role], ['research', 'observer', 'board', 'board', 'observer']);
  // The join answer's pins: this person's in this room, none yet, and its last key.
  for (const j of [anaJoin, obiJoin, gilJoin, beaJoin, vicJoin]) assert.deepEqual([j.pins, Object.keys(j).at(-2)], [[], 'pins'], 'pins before onStage, the last key');

  const said = await emit(ana, 'message', { type: 'text', text: 'Capex is on slide 14' });
  const second = await emit(ana, 'message', { type: 'text', text: 'Resolution 3: proxies counted' });
  const asked = await emit(ana, 'message', { type: 'action', text: 'Take questions now?', options: ['Yes', 'No'] });
  assert.ok(said.ok && second.ok && asked.ok);
  const everyone = [ana, ben, obi, gil, gil2, beaTab, beaPhone, vicPage, gilView, beaView];
  await wait(300);
  for (const s of everyone) heard.get(s).length = 0;

  await t.test('for me, On stage: kept under the guest\'s uid, once; told to the guest\'s other device and its support view, nobody else; no room op', async () => {
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: said.id, on: true }), { ok: true, ids: [said.id] });
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: said.id, on: true }), { ok: true, ids: [said.id], already: true }, 'twice keeps one');
    await until(() => told(gil2, 'pins').length === 1 && told(gilView, 'pins').length === 1, 4000, 'Gil\'s other device and his support view told');
    assert.deepEqual([told(gil, 'pins'), told(gil2, 'pins'), told(gilView, 'pins')], [[{ ids: [said.id] }], [{ ids: [said.id] }], [{ ids: [said.id] }]]);
    await until(() => kept() && kept()['u:' + gilJoin.uid], 4000, 'pages.json keeps it');
    assert.deepEqual(kept()['u:' + gilJoin.uid], { [hall]: [said.id] });
    await wait(200);
    for (const s of [ana, ben, obi, beaTab, beaPhone, vicPage, beaView]) assert.deepEqual(told(s, 'pins'), [], s.who + ' is told nothing of Gil\'s pins');
    for (const s of everyone) assert.deepEqual(told(s, 'pinUpdate'), [], s.who + ' hears no room op for a pin of Gil\'s own');
    const m = (await emit(ana, 'join', { roomCode: hall, name: 'Ana', role: 'research', uid: anaJoin.identity })).ops || [];
    assert.ok(!m.some((op) => op && op.f && 'pinned' in op.f), 'the room\'s ops carry no pin');
    // A page that joins again is told its pins: a reload keeps them.
    const gil3 = await page(undefined, 'Gil, reloaded');
    assert.deepEqual((await joined(gil3, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity })).pins, [said.id]);
    gil3.close();
    // Unpinned: gone from the store (nothing left for him), and told.
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: said.id, on: false }), { ok: true, ids: [] });
    await until(() => told(gil2, 'pins').length === 2, 4000, 'the unpin told');
    assert.deepEqual(told(gil2, 'pins').at(-1), { ids: [] });
    await until(() => kept() && !kept()['u:' + gilJoin.uid], 4000, 'pages.json keeps none for Gil');
  });

  await t.test('for me: what is refused, in its words, and nothing kept', async () => {
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: 'nope', on: true }), { ok: false, error: NOT_FOUND });
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: said.id, on: 'yes' }), { ok: false, error: SAY });
    assert.deepEqual(await emit(gil, 'pin:mine', { messageId: said.id }), { ok: false, error: SAY });
    // The admin's support view joins under the admin browser's uid: it pins for nobody, under its uid or the person's.
    assert.deepEqual(await emit(gilView, 'pin:mine', { messageId: said.id, on: true }), { ok: false, error: OWN });
    assert.deepEqual(await emit(beaView, 'pin:mine', { messageId: said.id, on: true }), { ok: false, error: OWN });
    await wait(200);
    assert.deepEqual(kept(), {}, 'nothing kept, under anyone\'s key');
  });

  // What each page heard, from the step it is read in.
  const fresh = () => { for (const s of everyone) heard.get(s).length = 0; };

  await t.test('for me, every seat: backstage, an observer and a Viewer account, each under its own key, told to itself alone', async () => {
    fresh();
    assert.deepEqual(await emit(ana, 'pin:mine', { messageId: second.id, on: true }), { ok: true, ids: [second.id] });
    assert.deepEqual(await emit(obi, 'pin:mine', { messageId: said.id, on: true }), { ok: true, ids: [said.id] });
    assert.deepEqual(await emit(vicPage, 'pin:mine', { messageId: asked.id, on: true }), { ok: true, ids: [asked.id] });
    await until(() => { const k = kept(); return k && k['u:' + anaJoin.uid] && k['u:' + obiJoin.uid] && k['a:' + vic.id]; }, 4000, 'all three kept');
    assert.deepEqual([kept()['u:' + anaJoin.uid], kept()['u:' + obiJoin.uid], kept()['a:' + vic.id]], [{ [hall]: [second.id] }, { [hall]: [said.id] }, { [hall]: [asked.id] }]);
    await wait(200);
    assert.deepEqual([told(ana, 'pins'), told(obi, 'pins'), told(vicPage, 'pins')], [[{ ids: [second.id] }], [{ ids: [said.id] }], [{ ids: [asked.id] }]]);
    for (const s of [ben, gil, gil2, beaTab, beaPhone, gilView, beaView]) assert.deepEqual(told(s, 'pins'), [], s.who + ' told nothing of theirs');
    for (const s of [ana, obi, vicPage]) assert.deepEqual((await emit(s, 'pin:mine', { messageId: s === ana ? second.id : s === obi ? said.id : asked.id, on: false })).ids, []);
  });

  await t.test('a Board account\'s pin on its tablet reaches its phone in the same room and its support view, kept on the account\'s key', async () => {
    fresh();
    assert.deepEqual(await emit(beaTab, 'pin:mine', { messageId: second.id, on: true }), { ok: true, ids: [second.id] });
    await until(() => told(beaPhone, 'pins').length === 1 && told(beaView, 'pins').length === 1, 4000, 'Bea\'s phone and her support view told');
    assert.deepEqual([told(beaPhone, 'pins')[0], told(beaView, 'pins')[0]], [{ ids: [second.id] }, { ids: [second.id] }]);
    await until(() => kept() && kept()['a:' + bea.id], 4000, 'kept on her key');
    assert.deepEqual(kept()['a:' + bea.id], { [hall]: [second.id] });
    assert.deepEqual(told(gil, 'pins'), [], 'another On stage seat is told nothing');
  });

  await t.test('for the room: from backstage, heard by every page; refused an observer and a Viewer by today\'s words, and every On stage seat first', async () => {
    fresh();
    const pinnedNow = async (id) => (await emit(gilView, 'admin:watchRoom', { roomCode: hall })).messages.find((m) => m.id === id).pinned;
    assert.deepEqual(await emit(ana, 'pin', { messageId: said.id, pinned: true }), { ok: true });
    await until(() => [ben, obi, gil, beaTab, vicPage].every((s) => told(s, 'pinUpdate').length === 1), 4000, 'every page hears the room\'s pin');
    for (const s of [ben, obi, gil, beaTab, vicPage]) assert.deepEqual(told(s, 'pinUpdate')[0].messageId, said.id, s.who);
    assert.equal(await pinnedNow(said.id), true);
    assert.deepEqual(await emit(ana, 'pin', { messageId: said.id, pinned: false }), { ok: true });
    assert.equal(await pinnedNow(said.id), false);
    // An observer and a Viewer account post nothing: today's words, nothing changed.
    assert.deepEqual(await emit(obi, 'pin', { messageId: second.id, pinned: true }), { ok: false, error: OBSERVERS });
    assert.deepEqual(await emit(vicPage, 'pin', { messageId: second.id, pinned: true }), { ok: false, error: OBSERVERS });
    // On stage: a Board guest, a Board account, and the host token's admin seated On stage, read before mayPost.
    const token = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
    const host = await page(token, 'the host On stage');
    const hostJoin = await joined(host, { roomCode: hall, name: 'Stage Host', role: 'board' });
    assert.equal(hostJoin.role, 'board');
    for (const s of [gil, beaTab, host]) assert.deepEqual(await emit(s, 'pin', { messageId: second.id, pinned: true }), { ok: false, error: BACKSTAGE_PINS }, s.who);
    assert.equal(await pinnedNow(second.id), false, 'nobody pinned it for the room');
    // Each still pins for itself.
    for (const s of [gil, host]) assert.equal((await emit(s, 'pin:mine', { messageId: second.id, on: true })).ok, true, s.who);
  });

  await t.test('a question pinned for the room is answered from On stage, and the answer stored', async () => {
    assert.deepEqual(await emit(ben, 'pin', { messageId: asked.id, pinned: true }), { ok: true });
    assert.deepEqual(await emit(gil, 'actionResponse', { messageId: asked.id, optionIndex: 0 }), { ok: true });
    const q = (await emit(gilView, 'admin:watchRoom', { roomCode: hall })).messages.find((m) => m.id === asked.id);
    assert.deepEqual([q.pinned, q.responses.map((r) => [r.uid, r.optionIndex])], [true, [[gilJoin.uid, 0]]]);
  });

  await t.test('a deleted message\'s id is dropped at the person\'s next pin write; 50 a room, the 51st refused', async () => {
    const doomed = await emit(ana, 'message', { type: 'text', text: 'Wrong room, sorry' });
    assert.deepEqual((await emit(obi, 'pin:mine', { messageId: doomed.id, on: true })).ids, [doomed.id]);
    // On disk before the delete: the pin's save lands a moment after its answer, so what the delete leaves is read against
    // the file that holds the pin.
    await until(() => { const k = kept(); return !!k && ((k['u:' + obiJoin.uid] || {})[hall] || []).includes(doomed.id); }, 4000, 'the pin kept');
    assert.deepEqual(await emit(ana, 'delete', { messageId: doomed.id }), { ok: true });
    // Kept until then, but never told: a page that joins again is told only the pins whose messages the room holds.
    await wait(200);   // time for a wrongful save of the delete to land: a slow one could only pass this falsely, never fail it
    assert.deepEqual(kept()['u:' + obiJoin.uid], { [hall]: [doomed.id] });
    const obiAgain = await page(undefined, 'Obi, reloaded');
    assert.deepEqual((await joined(obiAgain, { roomCode: hall, name: 'Obi', role: 'observer', uid: obiJoin.identity })).pins, [], 'a gone message\'s id is not told');
    obiAgain.close();
    assert.deepEqual(await emit(obi, 'pin:mine', { messageId: said.id, on: true }), { ok: true, ids: [said.id] }, 'the gone one dropped as the next is written');
    // Fifty pinned (made under the rate: one per message, a few at a time), then the 51st refused and nothing kept of it.
    const ids = [said.id];
    for (let n = 0; ids.length < 50; n++) {
      const m = await emit(ben, 'message', { type: 'text', text: 'Note ' + n });
      if (!m.ok) { await wait(400); continue; }
      let r = await emit(obi, 'pin:mine', { messageId: m.id, on: true });
      while (r.busy) { await wait(400); r = await emit(obi, 'pin:mine', { messageId: m.id, on: true }); }
      assert.equal(r.ok, true, JSON.stringify(r));
      ids.push(m.id);
    }
    let last = await emit(ben, 'message', { type: 'text', text: 'One more' });
    while (!last.ok) { await wait(400); last = await emit(ben, 'message', { type: 'text', text: 'One more' }); }
    await wait(400);
    let full = await emit(obi, 'pin:mine', { messageId: last.id, on: true });
    while (full.busy) { await wait(400); full = await emit(obi, 'pin:mine', { messageId: last.id, on: true }); }
    assert.deepEqual(full, { ok: false, error: FULL });
    await until(() => kept() && (kept()['u:' + obiJoin.uid] || {})[hall] && kept()['u:' + obiJoin.uid][hall].length === 50, 4000, 'fifty kept');
    assert.deepEqual(kept()['u:' + obiJoin.uid][hall], ids);
  });

  await t.test('a room reset drops every person\'s pins in it, and their pages are told', async () => {
    const ctl = await page(admin, 'the admin page');
    const before = told(obi, 'pins').length;
    assert.equal((await emit(ctl, 'admin:resetRoom', { roomCode: hall })).ok, true);
    await until(() => told(obi, 'pins').length === before + 1, 4000, 'Obi told his pins went');
    assert.deepEqual(told(obi, 'pins').at(-1), { ids: [] });
    await until(() => kept() && !Object.values(kept()).some((rooms) => Object.hasOwn(rooms, hall)), 4000, 'none kept in the room');
  });

  await t.test('a side room removed, and a hall removed, drop every person\'s pins in them; the hall\'s other rooms keep theirs', async () => {
    const ctl = await page(admin, 'the admin page, removing');
    const asked = async (s, verb, args) => { for (;;) { const r = await emit(s, verb, args); if (!r.busy) return r; await wait(250); } };
    const legal = await asked(ctl, 'room:create', { hall, name: 'Legal' });
    assert.equal(legal.ok, true, JSON.stringify(legal));
    const other = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
    // The admin's own page pins for itself in the hall, in Legal and in Hall 3, each a room of its own key.
    const rootIn = async (code, who) => { const s = await page(admin, who); await joined(s, { roomCode: code, as: 'account' }); return s; };
    const pinned = async (s, words) => {
      const m = await asked(s, 'message', { type: 'text', text: words });
      assert.equal(m.ok, true, JSON.stringify(m));
      assert.equal((await asked(s, 'pin:mine', { messageId: m.id, on: true })).ok, true);
    };
    const inMain = await rootIn(hall, 'root in Hall 2');
    const inLegal = await rootIn(legal.key, 'root in Legal');
    const inOther = await rootIn(other, 'root in Hall 3');
    await pinned(inMain, 'The order of business');
    await pinned(inLegal, 'Counsel\'s note');
    await pinned(inOther, 'Hall 3\'s running order');
    const rootKey = 'a:' + (await api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: admin })).body.account.id;
    await until(() => kept() && Object.keys(kept()[rootKey] || {}).length === 3, 4000, 'three rooms kept on the admin\'s account');
    assert.deepEqual(Object.keys(kept()[rootKey]).sort(), [hall, legal.key, other].sort());
    // Legal removed: its pins go, the hall's stay.
    assert.equal((await emit(ctl, 'admin:deleteRoom', { roomCode: legal.key })).ok, true);
    await until(() => !Object.hasOwn(kept()[rootKey] || {}, legal.key), 4000, 'Legal\'s pins gone');
    assert.deepEqual(Object.keys(kept()[rootKey]).sort(), [hall, other].sort());
    // Hall 3 removed: its pins go too.
    assert.equal((await emit(ctl, 'admin:deleteRoom', { roomCode: other })).ok, true);
    await until(() => !Object.hasOwn(kept()[rootKey] || {}, other), 4000, 'Hall 3\'s pins gone');
    assert.deepEqual(Object.keys(kept()[rootKey]), [hall]);
    inMain.close();
  });

  await t.test('an account removed: its pins go with it; a start drops every pin in a room no longer here, and keeps the rest', async () => {
    let note = await emit(ben, 'message', { type: 'text', text: 'After the reset' });
    while (!note.ok) { await wait(400); note = await emit(ben, 'message', { type: 'text', text: 'After the reset' }); }
    assert.deepEqual(await emit(vicPage, 'pin:mine', { messageId: note.id, on: true }), { ok: true, ids: [note.id] });
    await until(() => kept() && kept()['a:' + vic.id], 4000, 'Vic\'s pin kept');
    assert.equal((await api(srv.base, 'DELETE', '/api/users/' + vic.id, undefined, { cookie: admin })).status, 200);
    await until(() => kept() && !kept()['a:' + vic.id], 4000, 'Vic\'s pins gone with the account');
    // Stopped, and pages.json given pins in a room no longer here (none of its files on disk): the start drops them, and
    // a person with none left goes whole.
    const rootKey = 'a:' + (await api(srv.base, 'GET', '/api/auth/me', undefined, { cookie: admin })).body.account.id;
    const keptBefore = kept()[rootKey][hall];
    await stopServer(srv.child);
    const file = path.join(srv.dataDir, 'pages.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.pins[rootKey].GONE99 = ['m1', 'm2'];
    data.pins['u:ghost'] = { GONE99: ['m3'] };
    fs.writeFileSync(file, JSON.stringify(data));
    srv = await restartServer(srv);
    await until(() => kept() && !kept()['u:ghost'], 6000, 'the start\'s sweep');
    assert.deepEqual(kept()[rootKey], { [hall]: keptBefore }, 'the hall\'s pins kept, the gone room\'s dropped');
  });

  await t.test('no pin of either kind is an audit row', async () => {
    const rows = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length > 0, 'the log holds the day\'s other rows');
    assert.deepEqual(rows.filter((e) => /pin/i.test(e.action)).map((e) => e.action), [], 'no row for a pin, for the room or for oneself');
  });
});
