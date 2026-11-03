'use strict';
// A room's members by account (public/members.js, the catalogue's adminRoom.members), its pure half: the checklist read
// from the Accounts route's answer, each row ticked where the account holds the room and not offered, with why, where
// this person may not change it; what one account's PATCH sends for a tick; and what a save says. The dialog, its saves
// and their answers on a real server are the browser smoke's; each save's refusal by right is test/menus.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { ROOT, readSource } = require('./helpers');
const rbac = require('../lib/rbac');

function loadMembers() {
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'members.js')), ctx, { filename: 'members.js' });
  return ctx.AGM.members;
}
const M = loadMembers();
const plain = (v) => JSON.parse(JSON.stringify(v));

const HALL = 'K7P2QX', LEGAL = 'LGQ4MZP8', MEDIA = 'MDQ4MZP8';
// The roles and each row as the Accounts route tells them: a row's `rights` are the server's (none for a turned-off one).
const ROLES = Object.entries(rbac.ROLES).map(([id, r]) => ({ id, label: r.label, allHalls: r.allHalls, caps: r.caps, words: r.words }));
const user = (id, name, role, extra = {}) => {
  const u = { id, username: name.toLowerCase(), name, role, halls: [], allHalls: null, grant: [], revoke: [], rooms: [], board: [], locked: '', disabled: false, ...extra };
  return { ...u, rights: rbac.rightsView(u) };
};
const ANA = user('a-ana', 'Ana', 'admin');
const KIM = user('a-kim', 'Kim', 'tech', { halls: [HALL], rooms: [LEGAL], board: [HALL] });
const LOU = user('a-lou', 'Lou', 'staff', { rooms: [MEDIA], disabled: true });
const VIC = user('a-vic', 'Vic', 'viewer', { halls: [HALL] });
const ROB = user('a-rob', 'Rob', 'tech', { halls: [HALL], locked: 'Only an admin may make or change an admin.' });
const DATA = { users: [ANA, KIM, LOU, VIC, ROB], roles: ROLES, giveable: { admin: true, allHalls: true, halls: [] }, giveableRooms: { all: true, rooms: [] } };
const LEGAL_ROOM = { code: LEGAL, main: false, hall: 'Hall 2 › Legal', hallName: 'Hall 2' };
const MAIN = { code: HALL, main: true, hall: 'Hall 2', hallName: 'Hall 2' };

test('the checklist: each account ticked where it holds the room, and not offered, with why, where this person may not change it', () => {
  // A side room: ticked by the account's rooms; one's own row and a locked one shown and not offered; a turned-off one said.
  assert.deepEqual(plain(M.rowsFor(DATA, LEGAL_ROOM, 'a-ana')), [
    { id: 'a-ana', name: 'Ana', meta: 'ana · Admin', held: false, why: 'Your own account: another admin changes it.', adds: '' },
    { id: 'a-kim', name: 'Kim', meta: 'kim · Tech', held: true, why: '', adds: '' },
    { id: 'a-lou', name: 'Lou', meta: 'lou · Staff · turned off', held: false, why: '', adds: '' },
    { id: 'a-vic', name: 'Vic', meta: 'vic · Viewer', held: false, why: '', adds: '' },
    { id: 'a-rob', name: 'Rob', meta: 'rob · Tech', held: false, why: 'Only an admin may make or change an admin.', adds: '' },
  ]);
  // A hall's Main room: ticked by the On stage halls; one that reads only cannot sit On stage; one that does not reach the
  // hall is given it too by its tick, and its row says so before the Save.
  const main = plain(M.rowsFor(DATA, MAIN, 'a-ana'));
  assert.deepEqual(main.map((r) => [r.id, r.held, r.why, r.adds]), [
    ['a-ana', false, 'Your own account: another admin changes it.', ''],
    ['a-kim', true, '', ''],
    ['a-lou', false, '', 'Hall 2'],
    ['a-vic', false, 'Reads only: On stage needs Send messages.', ''],
    ['a-rob', false, 'Only an admin may make or change an admin.', ''],
  ]);
  // A Viewer already seated there keeps its untick.
  assert.equal(M.rowsFor({ ...DATA, users: [{ ...VIC, board: [HALL] }] }, MAIN, 'a-ana')[0].why, '');
  // Read as the server judges a seat given (the account enabled, its role, grants and revokes; its halls as stored): a
  // turned-off Tech of the hall is offered the seat and given no hall by it; a Tech whose Send messages is revoked, and a
  // Viewer granted it, the other way about.
  const off = user('a-ted', 'Ted', 'tech', { halls: [HALL], disabled: true });
  const rows = (u) => plain(M.rowsFor({ ...DATA, users: [u] }, MAIN, 'a-ana')).map((r) => [r.why, r.adds]);
  assert.deepEqual([rows(off), rows({ ...KIM, board: [], revoke: ['hall.post'] }), rows({ ...VIC, grant: ['hall.post'] })], [[['', '']], [['Reads only: On stage needs Send messages.', '']], [['', '']]]);
  assert.deepEqual(off.rights.caps, [], 'the route tells a turned-off account no rights');
  // A person who may not give this room is offered none of it.
  const manager = { ...DATA, giveable: { admin: false, allHalls: false, halls: ['M3N4PQ'] }, giveableRooms: { all: false, rooms: [MEDIA] } };
  for (const room of [LEGAL_ROOM, MAIN]) assert.ok(M.rowsFor(manager, room, 'a-mia').every((r) => r.why === 'You give only the rooms and halls you hold yourself — ask an admin.'));
  assert.deepEqual(M.rowsFor(manager, { ...LEGAL_ROOM, code: MEDIA }, 'a-mia').map((r) => r.why).filter(Boolean), ['Only an admin may make or change an admin.'], 'a room it holds itself: offered');
  assert.deepEqual(plain(M.rowsFor({ users: 'none' }, LEGAL_ROOM, '')), [], 'an answer with no list: no rows');
});

test('a tick: one account\'s own list with the room put in or taken out, and a hall with its On stage seat where it does not reach it', () => {
  assert.deepEqual(plain(M.changeFor(KIM, LEGAL_ROOM, false)), { rooms: [] });
  assert.deepEqual(plain(M.changeFor(LOU, LEGAL_ROOM, true)), { rooms: [MEDIA, LEGAL] });
  assert.deepEqual(plain(M.changeFor({ ...KIM, rooms: [LEGAL] }, LEGAL_ROOM, true)), { rooms: [LEGAL] }, 'never twice');
  assert.deepEqual(plain(M.changeFor(KIM, MAIN, false)), { board: [] }, 'off the Board, the hall kept');
  assert.deepEqual(plain(M.changeFor(LOU, MAIN, true, ROLES)), { board: [HALL], halls: [HALL] }, 'On stage in a hall it does not reach: the hall too');
  assert.deepEqual(plain(M.changeFor(VIC, MAIN, true, ROLES)), { board: [HALL] }, 'a hall it reaches: the seat alone');
  assert.deepEqual(plain(M.changeFor({ ...LOU, allHalls: true }, MAIN, true, ROLES)), { board: [HALL] }, 'an account of every hall reaches it');
  assert.deepEqual(plain(M.changeFor(user('a-pat', 'Pat', 'manager'), MAIN, true, ROLES)), { board: [HALL] }, 'by its role\'s every hall');
  assert.deepEqual(plain(M.changeFor(user('a-ted', 'Ted', 'tech', { halls: [HALL], disabled: true }), MAIN, true, ROLES)), { board: [HALL] }, 'a turned-off account, by the halls it holds');
  assert.deepEqual(plain(M.changeFor({ ...LOU, rooms: [7, MEDIA] }, LEGAL_ROOM, true)), { rooms: [MEDIA, LEGAL] }, 'a list read by type');
});

test('what a save says: how many were saved, then each refusal by the account\'s name in the server\'s words', () => {
  assert.equal(M.words([]), 'Nothing changed.');
  assert.equal(M.words([{ name: 'Kim', ok: true }, { name: 'Lou', ok: true }]), '2 saved');
  assert.equal(M.words([{ name: 'Kim', ok: true }, { name: 'Rob', ok: false, error: 'Only an admin may make or change an admin.' }]), '1 saved · Rob: Only an admin may make or change an admin.');
  assert.equal(M.words([{ name: 'Rob', ok: false, error: 'No such account.' }]), 'None saved · Rob: No such account.');
});
