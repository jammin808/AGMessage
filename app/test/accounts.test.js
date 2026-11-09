'use strict';
// Accounts, rights and the audit trail: the permission model (pure), password hashing and policy, sessions, the
// chain with a key, and the whole of it end to end — first admin, sign-in, managing accounts, joining a hall as an account,
// rights changed under a live socket, the origin check, and the audit log that records it all.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const rbac = require('../lib/rbac');
const acc = require('../lib/accounts');
const guard = require('../lib/guard');
const { startServer, stopServer, api, connect, emit, once, wait, until, fakeStagewatch, inviteOf, TOKEN, FIXTURE_KEY, auditLog, serverAudit, chainOf, keyedChainOf, auditMeter, acceptAll, brief, openStores, resealStore, setupAdmin } = require('./helpers');
const { meter } = require('./audit-preload');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- the permission model
/** A hall's Main room's scope, and a side room's beside it, as the store's scopeOf gives them. */
const main = (hall) => ({ code: hall, hall, main: true });
const side = (key, hall) => ({ code: key, hall, main: false });

test('rbac: roles, hall scope, grants and revokes, deny by default', () => {
  const tech = { id: 'a1', role: 'tech', halls: ['HALL01'] };
  // A room's rights are asked in the room (canIn), its hall's of the hall (seesHall, can): never a room's of can().
  assert.ok(rbac.canIn(tech, 'hall.post', main('HALL01')));
  assert.ok(!rbac.canIn(tech, 'hall.post', main('HALL03')), 'a tech is in their own halls only');
  assert.equal(rbac.can(tech, 'hall.post', 'HALL01'), false, 'the fence: a room\'s right asked of can() with a hall is refused');
  assert.ok(!rbac.can(tech, 'users.manage'));
  assert.ok(rbac.can({ role: 'manager' }, 'display.control', 'ANYHALL'), 'a project manager sees every hall');
  assert.ok(rbac.seesHall({ role: 'senior' }, 'HALL09'), 'a senior tech sees every hall');
  assert.ok(!rbac.can({ role: 'senior' }, 'halls.manage'));
  assert.ok(!rbac.can({ role: 'staff', halls: ['HALL01'] }, 'display.control', 'HALL01'), 'staff message, they do not drive screens');
  assert.ok(rbac.can({ role: 'staff', halls: ['HALL01'], grant: ['display.control'] }, 'display.control', 'HALL01'), 'a grant adds one right');
  assert.ok(!rbac.can({ role: 'tech', halls: ['HALL01'], revoke: ['stage.send'] }, 'stage.send', 'HALL01'), 'a revoke takes one away');
  assert.ok(!rbac.canIn({ role: 'admin', disabled: true }, 'hall.view', main('HALL01')), 'a turned-off account can do nothing');
  assert.ok(!rbac.seesHall({ role: 'admin', disabled: true }, 'HALL01'));
  assert.ok(!rbac.can({ role: 'admin' }, 'no.such.cap'), 'an unknown right is refused');
  assert.ok(!rbac.canIn({ role: 'wizard' }, 'hall.view', main('HALL01')), 'an unknown role is refused');
  assert.ok(!rbac.seesHall({ role: 'wizard' }, 'HALL01'));
  assert.equal(rbac.roomRoleFor({ role: 'viewer', halls: ['H1H1'] }, 'H1H1'), 'observer');
  assert.equal(rbac.roomRoleFor({ role: 'tech', halls: ['H1H1'] }, 'H1H1'), 'research');
});

test('rbac: an On stage seat allows reading and writing messages and nothing else; the other seats are bounded by their rights alone', () => {
  const caps = Object.keys(rbac.CAPS);
  assert.deepEqual(caps.filter((c) => rbac.seatAllows('board', c)), ['hall.view', 'hall.post']);
  for (const seat of ['research', 'observer']) assert.deepEqual(caps.filter((c) => rbac.seatAllows(seat, c)), caps, seat + ' is unlimited');
  assert.ok(!rbac.seatAllows('board', 'no.such.cap'));
  // The admin's link is a set of its own: it keeps post and share files, never the On stage seat's narrower set.
  assert.deepEqual([...rbac.LINKED_CAPS], ['hall.view', 'hall.post', 'hall.files']);
  assert.ok(Object.isFrozen(rbac.SEAT_LIMITS) && Object.isFrozen(rbac.SEAT_LIMITS.board) && Object.isFrozen(rbac.LINKED_CAPS), 'no caller widens a limit');
});

test('rbac: an account answers a room\'s help requests as its crew only where it may post and does not sit On stage', () => {
  const staff = { id: 'a1', role: 'staff', halls: ['HALL01'] };
  assert.equal(rbac.answersHelp(staff, main('HALL01')), true, 'crew in its own hall');
  assert.equal(rbac.answersHelp(staff, main('HALL02')), false, 'not in a hall it is not in');
  assert.equal(rbac.answersHelp({ role: 'viewer', halls: ['HALL01'] }, main('HALL01')), false, 'a Viewer reads only');
  assert.equal(rbac.answersHelp({ role: 'tech', halls: ['HALL01'], revoke: ['hall.post'] }, main('HALL01')), false, 'without hall.post, none');
  assert.equal(rbac.answersHelp({ role: 'manager' }, main('ANYHALL')), true, 'a project manager is every hall\'s crew');
  assert.equal(rbac.answersHelp({ role: 'admin', disabled: true }, main('HALL01')), false, 'a turned-off account answers nothing');
  assert.equal(rbac.answersHelp(null, main('HALL01')), false);
  // A side room's crew is its own members': a project manager of every hall is none of them; the admin role is.
  assert.equal(rbac.answersHelp({ role: 'manager' }, side('LGQ4MZP8', 'HALL01')), false, 'every hall reaches no side room');
  assert.equal(rbac.answersHelp({ ...staff, rooms: ['LGQ4MZP8'] }, side('LGQ4MZP8', 'HALL01')), true, 'a member of the room');
  assert.equal(rbac.answersHelp({ role: 'admin' }, side('LGQ4MZP8', 'HALL01')), true);
  // A hall's key alone is no room's scope: the question fails closed, as can() does.
  assert.equal(rbac.answersHelp({ role: 'manager' }, 'HALL01'), false, 'a string is no scope');
  // It is the account's seat in that room that decides, beside the right: crew wherever roomRoleFor seats it backstage,
  // never where its On stage halls seat it (a Board member of the hall).
  const board = { role: 'staff', halls: ['HALL01'], board: ['HALL01'] };
  for (const a of [staff, board, { role: 'viewer', halls: ['HALL01'] }, { role: 'manager' }]) {
    assert.equal(rbac.answersHelp(a, main('HALL01')), rbac.canIn(a, 'hall.post', main('HALL01')) && rbac.roomRoleFor(a, main('HALL01')) === 'research');
  }
  assert.equal(rbac.answersHelp(board, main('HALL01')), false, 'a Board member answers none of its hall\'s');
});

test('rbac: who is told a room\'s guest code: those who set halls up, and an account whose own rights there hold what the code gives a guest; never On stage, a Viewer, a Staff account in a Main room, nor every hall\'s account in a side room it is not given', () => {
  const HALL = main('HALL01');
  const LEGAL = side('LGQ4MZP8', 'HALL01');
  const tech = { role: 'tech', halls: ['HALL01'] };
  const staff = { role: 'staff', halls: ['HALL01'] };
  const cases = [
    // A Main room's code gives a guest backstage: seeing, posting, sharing files and the speaker's screen of its hall.
    [tech, HALL, true], [staff, HALL, false], [{ role: 'viewer', halls: ['HALL01'] }, HALL, false], [{ role: 'tech', halls: ['HALL02'] }, HALL, false],
    [{ ...tech, revoke: ['stage.send'] }, HALL, false], [{ ...staff, grant: ['stage.send'] }, HALL, true],
    // Those who set halls up hand codes out, every room's; a senior tech of every hall is told a hall's, not a side room's.
    [{ role: 'manager' }, HALL, true], [{ role: 'manager' }, LEGAL, true], [{ role: 'senior' }, HALL, true], [{ role: 'senior' }, LEGAL, false],
    // A side room's gives a Member: seeing, posting, sharing files there, by the room the account is given.
    [{ ...staff, rooms: ['LGQ4MZP8'] }, LEGAL, true], [staff, LEGAL, false], [{ role: 'viewer', rooms: ['LGQ4MZP8'] }, LEGAL, false], [{ role: 'admin' }, LEGAL, true],
    // On stage in the hall's Main room: a Board account's tablet is handed no code, its rights whatever they are.
    [{ ...tech, board: ['HALL01'] }, HALL, false], [{ role: 'manager', board: ['HALL01'] }, HALL, false], [{ ...tech, board: ['HALL01'], rooms: ['LGQ4MZP8'] }, LEGAL, true],
    // Fail closed: no account, one turned off, a scope that is none.
    [null, HALL, false], [{ ...tech, disabled: true }, HALL, false], [tech, 'HALL01', false], [tech, { code: 'HALL01' }, false],
  ];
  for (const [account, scope, told] of cases) assert.equal(rbac.mayKnowCode(account, scope), told, JSON.stringify([account, scope]));
});

test('rbac: a room\'s rights are asked in the room (canIn), behind a fence: can() refuses them with a hall, a side room is reached only by its own members and the admin role', () => {
  const tech = { id: 'a1', role: 'tech', halls: ['HALL01'] };
  const manager = { id: 'a2', role: 'manager' };
  const senior = { id: 'a3', role: 'senior' };
  const allStaff = { id: 'a4', role: 'staff', allHalls: true };
  const admin = { id: 'a5', role: 'admin' };
  const viewer = { id: 'a6', role: 'viewer', halls: ['HALL01'] };
  const LEGAL = side('LGQ4MZP8', 'HALL01');
  const ROOM = [...rbac.ROOM_SCOPED];
  assert.deepEqual(ROOM, ['hall.view', 'hall.post', 'hall.files']);
  // The fence: a room's right asked of can() with a hall (or anything named in its place) is no, whoever asks, the admin
  // and every hall's accounts included; the no-scope question ("in any hall at all?") still answers.
  for (const a of [tech, manager, senior, allStaff, admin, viewer, { role: 'staff', halls: ['HALL01'] }]) {
    for (const cap of ROOM) {
      for (const where of ['HALL01', 'LGQ4MZP8', main('HALL01'), ['HALL01'], 7]) assert.equal(rbac.can(a, cap, where), false, a.role + ' ' + cap + ' ' + JSON.stringify(where));
    }
  }
  assert.deepEqual([rbac.can(tech, 'hall.post'), rbac.can(tech, 'hall.post', ''), rbac.can(tech, 'hall.post', null), rbac.can(viewer, 'hall.post')], [true, true, true, false], 'in any hall at all');
  assert.deepEqual([rbac.can({ role: 'tech', halls: [] }, 'hall.view'), rbac.can(allStaff, 'hall.files')], [false, true], 'no hall at all, and every hall');
  // A hall's own rights are asked of the hall as before; a hall named by anything but its key answers no.
  assert.deepEqual([rbac.can(tech, 'display.control', 'HALL01'), rbac.can(tech, 'display.control', 'HALL02'), rbac.can(manager, 'stage.send', 'ANYHALL')], [true, false, true]);
  assert.deepEqual([rbac.can(manager, 'display.control', main('HALL01')), rbac.can(manager, 'stage.send', ['HALL01'])], [false, false], 'a hall is named by its key');

  // In a Main room canIn answers as 0.5.1's can answered for its hall, for every role, right and hall.
  const accounts = [tech, manager, senior, allStaff, admin, viewer, { role: 'staff', halls: ['HALL01', 'HALL02'] }, { role: 'tech', halls: ['HALL01'], revoke: ['hall.files'] },
    { role: 'viewer', halls: ['HALL02'], grant: ['hall.post'] }, { role: 'manager', allHalls: false, halls: ['HALL02'] }, { role: 'admin', disabled: true }, { role: 'wizard' }, null];
  for (const a of accounts) {
    const e = rbac.effective(a);
    for (const cap of Object.keys(rbac.CAPS)) {
      for (const hall of ['HALL01', 'HALL02', 'HALL09']) {
        const before = e.caps.has(cap) && (!rbac.HALL_SCOPED.has(cap) || e.allHalls || e.halls.has(hall));
        assert.equal(rbac.canIn(a, cap, main(hall)), before, JSON.stringify(a) + ' ' + cap + ' ' + hall);
      }
    }
  }
  assert.deepEqual([rbac.seesHall(tech, 'HALL01'), rbac.seesHall(tech, 'HALL02'), rbac.seesHall(manager, 'HALL09'), rbac.seesHall(viewer, 'HALL01')], [true, false, true, true]);
  assert.deepEqual([rbac.seesRoom(tech, main('HALL01')), rbac.seesRoom(tech, main('HALL02'))], [true, false], 'a Main room is seen as its hall is');

  // A side room needs the room in the account's own rooms: every hall reaches none, its hall's members none, the halls
  // list naming its key none (halls are halls).
  for (const a of [manager, senior, allStaff, tech, { role: 'tech', halls: ['HALL01', 'LGQ4MZP8'] }]) {
    for (const cap of ROOM) assert.equal(rbac.canIn(a, cap, LEGAL), false, a.role + ' ' + cap);
    assert.equal(rbac.seesRoom(a, LEGAL), false);
  }
  const member = { role: 'staff', halls: [], rooms: ['LGQ4MZP8'] };
  assert.deepEqual(ROOM.map((c) => rbac.canIn(member, c, LEGAL)), [true, true, true], 'a member of the room, whose hall it does not see');
  assert.equal(rbac.seesHall(member, 'HALL01'), false, 'its hall\'s Main room is not given with it');
  assert.deepEqual(ROOM.map((c) => rbac.canIn(member, c, side('MDR7VX2C', 'HALL01'))), [false, false, false], 'another room of the hall');
  assert.deepEqual(ROOM.map((c) => rbac.canIn({ role: 'viewer', rooms: ['LGQ4MZP8'] }, c, LEGAL)), [true, false, false], 'its rights still decide: a Viewer reads');
  assert.deepEqual(ROOM.map((c) => rbac.canIn({ ...member, revoke: ['hall.files'] }, c, LEGAL)), [true, true, false], 'a revoke takes one away there too');
  assert.deepEqual(ROOM.map((c) => rbac.canIn({ ...member, disabled: true }, c, LEGAL)), [false, false, false], 'a turned-off account, none');
  // The admin role is a member of every room, whatever its halls say; turned off, of none.
  assert.deepEqual(ROOM.map((c) => rbac.canIn(admin, c, LEGAL)), [true, true, true]);
  assert.deepEqual(ROOM.map((c) => rbac.canIn({ role: 'admin', allHalls: false, halls: [] }, c, LEGAL)), [true, true, true]);
  assert.deepEqual(ROOM.map((c) => rbac.canIn({ role: 'admin', disabled: true }, c, LEGAL)), [false, false, false]);
  // A hall's own rights in a side room are its hall's: its screens, its Stagewatch, its show network.
  assert.deepEqual([rbac.canIn(tech, 'stage.send', LEGAL), rbac.canIn(tech, 'display.control', LEGAL), rbac.canIn(member, 'display.control', LEGAL), rbac.canIn({ ...member, role: 'tech' }, 'stage.send', LEGAL)], [true, true, false, false]);

  // A scope is read whole: a key, a hall, and whether it is the hall's Main room, in agreement; anything else is no.
  for (const bad of ['HALL01', null, undefined, 7, {}, { code: 'HALL01', hall: 'HALL01' }, { code: 'HALL01', hall: 'HALL01', main: 'true' }, { code: 'LGQ4MZP8', hall: 'HALL01', main: true },
    { code: 'HALL01', hall: 'HALL01', main: false }, { code: '', hall: '', main: true }, { code: 7, hall: 7, main: true }, ['HALL01']]) {
    assert.equal(rbac.canIn(admin, 'hall.view', bad), false, JSON.stringify(bad));
    assert.equal(rbac.canIn(admin, 'stage.send', bad), false, JSON.stringify(bad));
  }
  // A frozen scope, as the store gives it, reads as any other.
  assert.equal(rbac.canIn(member, 'hall.post', Object.freeze(side('LGQ4MZP8', 'HALL01'))), true);
});

test('rbac: an account\'s rooms and On stage halls: the seat it joins with (roomRoleFor), by the room\'s scope', () => {
  // effective() reads both lists, strings only; none for a turned-off account.
  const e = rbac.effective({ role: 'staff', halls: ['HALL01'], rooms: ['LGQ4MZP8', 7, '', null, 'MDR7VX2C'], board: ['HALL01', {}] });
  assert.deepEqual([[...e.rooms], [...e.board]], [['LGQ4MZP8', 'MDR7VX2C'], ['HALL01']]);
  assert.deepEqual([...rbac.effective({ role: 'staff', rooms: 'LGQ4MZP8', board: { HALL01: true } }).rooms], [], 'a list, or nothing');
  const off = rbac.effective({ role: 'staff', rooms: ['LGQ4MZP8'], board: ['HALL01'], disabled: true });
  assert.deepEqual([off.rooms.size, off.board.size], [0, 0]);
  const LEGAL = side('LGQ4MZP8', 'HALL01');
  const tech = { role: 'tech', halls: ['HALL01'], rooms: ['LGQ4MZP8'] };
  assert.deepEqual([rbac.roomRoleFor(tech, main('HALL01')), rbac.roomRoleFor(tech, LEGAL), rbac.roomRoleFor(tech, main('HALL02'))], ['research', 'research', 'observer']);
  assert.deepEqual([rbac.roomRoleFor({ role: 'manager' }, LEGAL), rbac.roomRoleFor({ role: 'admin' }, LEGAL)], ['observer', 'research'], 'every hall is no member of a side room; the admin role is');
  assert.equal(rbac.roomRoleFor({ role: 'viewer', rooms: ['LGQ4MZP8'] }, LEGAL), 'observer', 'a member who may only read');
  // A hall its board lists seats the account On stage in that hall's Main room, where it may post, and nowhere else.
  const boardTech = { ...tech, board: ['HALL01'] };
  assert.deepEqual([rbac.roomRoleFor(boardTech, main('HALL01')), rbac.roomRoleFor(boardTech, LEGAL)], ['board', 'research'], 'On stage is a Main room\'s seat');
  assert.equal(rbac.roomRoleFor({ role: 'tech', halls: [], board: ['HALL01'] }, main('HALL01')), 'observer', 'a hall it does not reach seats it nowhere');
  assert.equal(rbac.roomRoleFor({ role: 'viewer', halls: ['HALL01'], board: ['HALL01'] }, main('HALL01')), 'observer', 'nor where it may not post');
  assert.equal(rbac.roomRoleFor({ role: 'manager', board: ['HALL01'] }, main('HALL01')), 'board', 'every hall\'s account, seated On stage in that one');
  // A hall's key given as a string is read as that hall's Main room (0.5.1's callers); anything else seats an observer.
  assert.deepEqual([rbac.roomRoleFor({ role: 'viewer', halls: ['H1H1'] }, 'H1H1'), rbac.roomRoleFor({ role: 'tech', halls: ['H1H1'] }, 'H1H1'), rbac.roomRoleFor(boardTech, 'HALL01')], ['observer', 'research', 'board']);
  for (const bad of ['', null, undefined, {}, { code: 'LGQ4MZP8', hall: 'HALL01', main: true }]) assert.equal(rbac.roomRoleFor({ role: 'admin' }, bad), 'observer', JSON.stringify(bad));
});

test('rbac: a code guest\'s rights by its seat and the kind of room (guestCaps)', () => {
  // A hall's Main room: as 0.5.1's server table, with unit G's On stage (view and post).
  assert.deepEqual(Object.fromEntries(['research', 'board', 'observer'].map((r) => [r, [...rbac.guestCaps(r, 'main')]])), {
    research: ['hall.view', 'hall.post', 'hall.files', 'stage.send'], board: ['hall.view', 'hall.post'], observer: ['hall.view'],
  });
  // A side room: a Member posts and shares files and sends nothing to a Stagewatch; no seat there is On stage.
  assert.deepEqual(Object.fromEntries(['research', 'board', 'observer'].map((r) => [r, [...rbac.guestCaps(r, 'side')]])), {
    research: ['hall.view', 'hall.post', 'hall.files'], board: [], observer: ['hall.view'],
  });
  assert.deepEqual([...rbac.guestCaps('research', 'side')], [...rbac.GUEST_CAPS_SIDE.research]);
  // Fail closed: a seat or a kind not listed, or an object's own names, hold nothing.
  for (const [role, kind] of [['director', 'main'], ['admin', 'main'], ['research', 'hall'], ['research', undefined], ['research', true], ['__proto__', 'main'], ['constructor', 'main'], ['toString', 'side'], [7, 'main'], [null, 'side']]) {
    assert.deepEqual([...rbac.guestCaps(role, kind)], [], String(role) + ' ' + String(kind));
  }
  // Nobody widens a seat through the table it is handed.
  for (const t of [rbac.GUEST_CAPS, rbac.GUEST_CAPS_SIDE, rbac.guestCaps('nobody', 'main'), ...Object.values(rbac.GUEST_CAPS), ...Object.values(rbac.GUEST_CAPS_SIDE)]) assert.ok(Object.isFrozen(t));
  // A seat's base and its limit agree: On stage's rights are its seat's limit, in a hall's Main room.
  assert.deepEqual([...rbac.guestCaps('board', 'main')], Object.keys(rbac.CAPS).filter((c) => rbac.seatAllows('board', c)));
});

test('rbac: rights never escalate', () => {
  const admin = { id: 'a1', role: 'admin' };
  const manager = { id: 'a2', role: 'manager', grant: ['users.manage'] };
  const tech = { id: 'a3', role: 'tech' };
  assert.equal(rbac.mayChange(tech, null, { role: 'staff' }), 'You may not manage accounts.');
  assert.match(rbac.mayChange(manager, null, { role: 'admin' }), /Only an admin/);
  assert.match(rbac.mayChange(manager, tech, { grant: ['settings.manage'] }), /Only an admin may grant/);
  assert.equal(rbac.mayChange(manager, tech, { role: 'staff' }), null, 'a manager with users.manage may manage non-admins');
  assert.match(rbac.mayChange(manager, manager, { role: 'admin' }), /Nobody changes their own/);
  assert.match(rbac.mayChange(admin, admin, { disabled: true }), /Nobody changes their own/);
  assert.match(rbac.mayChange(admin, { id: 'a9', role: 'admin' }, { role: 'staff' }, { activeAdmins: 1 }), /last active admin/);
  assert.equal(rbac.mayChange(admin, { id: 'a9', role: 'admin' }, { role: 'staff' }, { activeAdmins: 2 }), null);
  assert.match(rbac.mayChange(admin, tech, { grant: ['wizardry'] }), /Unknown right/);
  // An account that may manage accounts or settings is changed by an admin only — reset, signed out, removed, re-enabled.
  const peer = { id: 'a4', role: 'staff', grant: ['users.manage'] };
  const keeper = { id: 'a5', role: 'manager', grant: ['settings.manage'] };
  assert.match(rbac.mayChange(manager, keeper, {}), /Only an admin may change an account that manages/, 'a reset or a sign-out');
  assert.match(rbac.mayChange(manager, peer, { disabled: true }), /Only an admin may change an account that manages/, 'a removal');
  assert.match(rbac.mayChange(manager, { ...keeper, disabled: true }, { disabled: false }), /Only an admin/, 'a disabled holder is not re-enabled by a non-admin');
  assert.equal(rbac.mayChange(manager, manager, { name: 'Pat P.' }), null, 'one\'s own name');
  assert.equal(rbac.mayChange(admin, keeper, {}), null, 'an admin may');
  assert.ok(rbac.holdsAdminOnly(keeper) && rbac.holdsAdminOnly({ ...peer, disabled: true }) && !rbac.holdsAdminOnly(tech));
});

test('rbac: the rights and the roles say "screens", the word every page uses for a /d/ link', () => {
  // The Accounts page draws each right's words and each role's from these tables (/api/users: caps, roles).
  const words = [...Object.values(rbac.CAPS), ...Object.values(rbac.ROLES).map((r) => r.words)];
  assert.deepEqual(words.filter((w) => /display/i.test(w)), [], 'no right or role says "displays"');
  assert.deepEqual([rbac.CAPS['hall.view'], rbac.CAPS['display.control'], rbac.CAPS['display.manage']],
    ['See a hall: its messages, files, countdown and screens', 'Change what a hall\'s screens and people\'s pages show', 'Create, rename, move and revoke screens']);
  assert.deepEqual(['manager', 'senior', 'tech'].map((r) => rbac.ROLES[r].words), [
    'Every hall: messages, files, screens, the Board\'s pages, Stagewatch, show network; sets halls up',
    'Every hall: messages, files, screens, the Board\'s pages, Stagewatch, show network',
    'Their halls: messages, files, screens, the Board\'s pages, Stagewatch',
  ]);
});

test('rbac: stage.web, web pages on people\'s pages, is a hall\'s right of its own: Tech, Senior and Manager hold it, Staff and Viewers do not, a grant gives it and a revoke takes it off', () => {
  // Plan 4-§5.9.2.2: its words name what it shows, and it sits in the Show group beside the speaker's screen.
  assert.equal(rbac.CAPS['stage.web'], 'Show web pages on people\'s pages (the Board\'s or one person\'s)');
  assert.deepEqual(Object.keys(rbac.ROLES).filter((r) => rbac.ROLES[r].caps.includes('stage.web')), ['admin', 'manager', 'senior', 'tech']);
  assert.ok(rbac.HALL_SCOPED.has('stage.web') && !rbac.ROOM_SCOPED.has('stage.web') && !rbac.ADMIN_ONLY.has('stage.web'));
  assert.ok(rbac.CAP_GROUPS.find((g) => g.id === 'show').caps.includes('stage.web'));
  const tech = { id: 't1', role: 'tech', halls: ['HALL01'] };
  assert.deepEqual([rbac.can(tech, 'stage.web', 'HALL01'), rbac.can(tech, 'stage.web', 'HALL02'), rbac.can({ ...tech, revoke: ['stage.web'] }, 'stage.web', 'HALL01'),
    rbac.can({ id: 's1', role: 'staff', halls: ['HALL01'] }, 'stage.web', 'HALL01'), rbac.can({ id: 's1', role: 'staff', halls: ['HALL01'], grant: ['stage.web'] }, 'stage.web', 'HALL01'),
    rbac.can({ id: 'v1', role: 'viewer', halls: ['HALL01'] }, 'stage.web', 'HALL01')], [true, false, false, false, true, false], 'a revoke takes it off, a grant gives it');
  assert.deepEqual([rbac.canIn(tech, 'stage.web', { code: 'LEGAL123', hall: 'HALL01', main: false }), rbac.seatAllows('board', 'stage.web'), rbac.guestCaps('research', 'main').includes('stage.web')], [true, false, false],
    'a hall\'s right, in each of its rooms; never On stage; no code guest holds it of its own');
});

test('rbac: stage.show, files, pages and quotes shown to the people on stage, is a hall\'s right of its own: Manager, Senior, Tech and Staff hold it, Viewers do not, a revoke takes it off and a grant gives it', () => {
  // Plan 4-§5.9.2.2: it governs every account's information pushes, the operator's included, so its words name what it shows.
  assert.equal(rbac.CAPS['stage.show'], 'Show files, pages and quotes to the people on stage');
  assert.deepEqual(Object.keys(rbac.ROLES).filter((r) => rbac.ROLES[r].caps.includes('stage.show')), ['admin', 'manager', 'senior', 'tech', 'staff']);
  assert.ok(rbac.HALL_SCOPED.has('stage.show') && !rbac.ROOM_SCOPED.has('stage.show') && !rbac.ADMIN_ONLY.has('stage.show'));
  const show = rbac.CAP_GROUPS.find((g) => g.id === 'show').caps;
  assert.ok(show.indexOf('stage.show') === show.indexOf('stage.web') - 1, 'beside stage.web in the Show group');
  const staff = { id: 's1', role: 'staff', halls: ['HALL01'] };
  assert.deepEqual([rbac.can(staff, 'stage.show', 'HALL01'), rbac.can(staff, 'stage.show', 'HALL02'), rbac.can({ ...staff, revoke: ['stage.show'] }, 'stage.show', 'HALL01'),
    rbac.can({ id: 'v1', role: 'viewer', halls: ['HALL01'] }, 'stage.show', 'HALL01'), rbac.can({ id: 'v1', role: 'viewer', halls: ['HALL01'], grant: ['stage.show'] }, 'stage.show', 'HALL01'),
    rbac.can({ id: 't1', role: 'tech', halls: ['HALL01'], revoke: ['stage.show'] }, 'stage.show', 'HALL01')], [true, false, false, false, true, false], 'a revoke takes it off, a grant gives it');
  assert.deepEqual([rbac.canIn(staff, 'stage.show', { code: 'LEGAL123', hall: 'HALL01', main: false }), rbac.seatAllows('board', 'stage.show'), rbac.guestCaps('research', 'main').includes('stage.show')], [true, false, false],
    'a hall\'s right, in each of its rooms; never On stage; no code guest holds it');
  assert.equal(rbac.ROLES.staff.words, 'Their halls: messages, files, and information for the Board\'s pages');
});

test('rbac: the Accounts page\'s three groups of rights hold every right once, in the rights\' own order, and nothing else', () => {
  assert.deepEqual(rbac.CAP_GROUPS.map((g) => [g.id, g.label]), [['room', 'In the room'], ['show', 'Show'], ['run', 'Run AGMessage']]);
  const grouped = rbac.CAP_GROUPS.flatMap((g) => g.caps);
  assert.deepEqual(grouped, Object.keys(rbac.CAPS), 'each right once, in CAPS\'s order, a new right given its group as it is added');
  assert.deepEqual(rbac.CAP_GROUPS.map((g) => g.caps.length), [3, 6, 5]);
  assert.ok(rbac.CAP_GROUPS[0].caps.every((c) => rbac.ROOM_SCOPED.has(c)), 'In the room: a room\'s own rights');
  assert.ok(rbac.CAP_GROUPS[2].caps.every((c) => !rbac.HALL_SCOPED.has(c)), 'Run AGMessage: no hall\'s right');
  assert.ok(Object.isFrozen(rbac.CAP_GROUPS) && rbac.CAP_GROUPS.every((g) => Object.isFrozen(g) && Object.isFrozen(g.caps)));
});

test('rbac: a holder of users.manage who is not an admin makes, widens and takes over nothing past its own rights and halls', () => {
  const lead = { id: 'a4', role: 'tech', halls: ['HALLA1'], grant: ['users.manage'] };
  const crew = { id: 'a5', role: 'tech', halls: ['HALLA1'] };
  for (const [target, change, why] of [
    [null, { role: 'manager' }, 'a project manager: every hall, halls.manage, audit.read'],
    [null, { role: 'staff', allHalls: true }, 'every hall'],
    [crew, { halls: ['HALLA1', 'HALLB2'] }, 'a hall it is not in'],
    [crew, { allHalls: true }, 'every hall, to another'],
    [crew, { grant: ['nodes.control'] }, 'a right it does not hold'],
    [crew, { grant: 'audit.read' }, 'a grant that is not a list is read as what it names'],
    [{ id: 'a6', role: 'manager' }, {}, 'a reset or sign-out of a richer account (the reset would hand it the password)'],
    [{ id: 'a7', role: 'tech', halls: ['HALLB2'] }, { disabled: true }, 'a removal in a hall it is not in'],
    [{ id: 'a6', role: 'manager', disabled: true }, { disabled: false }, 'turning a richer account back on'],
  ]) assert.match(rbac.mayChange(lead, target, change) || 'allowed', /hold yourself/, why);
  assert.equal(rbac.mayChange(lead, null, { role: 'staff', halls: ['halla1'] }), null, 'staff in its own hall');
  assert.equal(rbac.mayChange(lead, crew, { role: 'viewer' }), null);
  assert.equal(rbac.mayChange(lead, crew, {}), null, 'a reset of an account within its rights');
  assert.equal(rbac.mayChange(lead, lead, { name: 'Lee L.' }), null, 'its own name');
  assert.equal(rbac.mayChange(lead, null, { role: 'senior', allHalls: false, halls: ['HALLA1'], revoke: ['nodes.control'] }), null, 'a richer role with what it lacks taken off');
  assert.equal(rbac.mayChange({ id: 'a2', role: 'manager', grant: ['users.manage'] }, crew, { allHalls: true, grant: ['nodes.control'] }), null, 'a project manager holds every hall');
  // What the Accounts page offers: exactly what mayChange allows.
  // Its Tech preset holds stage.show (unit 24) and stage.web (unit 19), so it gives both, on purpose.
  assert.deepEqual(rbac.giveable(lead), { admin: false, caps: ['display.control', 'hall.files', 'hall.post', 'hall.view', 'stage.send', 'stage.show', 'stage.web'], allHalls: false, halls: ['HALLA1'] });
  assert.deepEqual(rbac.giveable({ id: 'a1', role: 'admin' }), { admin: true, caps: Object.keys(rbac.CAPS), allHalls: true, halls: [] });
  assert.deepEqual(rbac.giveable({ id: 'a2', role: 'manager', grant: ['users.manage'] }).halls, [], 'every hall: no list');
});

test('rbac: an account\'s side rooms, On stage halls and chat view: a side room is read before every hall, an On stage hall as a hall is, and nobody sets their own', () => {
  const LEGAL = 'LGQ4MZP8', MEDIA = 'MDR7VX2C';
  const admin = { id: 'a1', role: 'admin' };
  const crew = { id: 'a5', role: 'tech', halls: ['HALLA1'] };
  // A project manager of every hall who manages accounts reaches no side room by its halls: it gives none it is not given,
  // and manages no account that holds one, though every hall would let it past the halls.
  const pm = { id: 'a2', role: 'manager', grant: ['users.manage'] };
  const HOLD = /hold yourself/;
  assert.match(rbac.mayChange(pm, crew, { rooms: [LEGAL] }) || 'allowed', HOLD, 'every hall gives no side room');
  assert.match(rbac.mayChange(pm, null, { role: 'staff', rooms: ['lgq4mzp8'] }) || 'allowed', HOLD, 'a new account, its key as typed');
  assert.match(rbac.mayChange(pm, { ...crew, rooms: [MEDIA] }, {}) || 'allowed', HOLD, 'nor resets one that holds a room it does not');
  assert.equal(rbac.mayChange({ ...pm, rooms: [LEGAL] }, crew, { rooms: [LEGAL] }), null, 'a room it is given, it gives');
  assert.match(rbac.mayChange({ ...pm, rooms: [LEGAL] }, crew, { rooms: [LEGAL, MEDIA] }) || 'allowed', HOLD, 'and no other');
  assert.equal(rbac.mayChange(admin, crew, { rooms: [LEGAL, MEDIA] }), null, 'the admin, a member of every room, gives any');
  // An On stage hall is read as a hall is: a one-hall lead seats someone On stage in its own hall, never in another; an
  // account of every hall in any.
  const lead = { id: 'a4', role: 'tech', halls: ['HALLA1'], grant: ['users.manage'] };
  assert.equal(rbac.mayChange(lead, crew, { board: ['halla1'] }), null);
  assert.match(rbac.mayChange(lead, crew, { board: ['HALLB2'] }) || 'allowed', HOLD, 'On stage in a hall it is not in');
  assert.match(rbac.mayChange(lead, { ...crew, board: ['HALLB2'] }, {}) || 'allowed', HOLD, 'nor manages one On stage there');
  assert.equal(rbac.mayChange(pm, crew, { board: ['HALLB2'] }), null, 'every hall');
  // A chat view widens nothing: whoever manages the account sets it, as a list of keys is read whatever it holds.
  assert.equal(rbac.mayChange(lead, crew, { view: 'simple' }), null);
  assert.equal(rbac.mayChange(lead, crew, { rooms: [{ toString: 1 }], board: [7] }), null, 'a value that is no name names no room and no hall, and never throws: the route refuses its shape in words');
  // Nobody sets their own side rooms, On stage halls or chat view, in the words a role or a right is refused in.
  for (const change of [{ rooms: [] }, { board: ['HALLA1'] }, { view: 'full' }, { view: '' }]) {
    assert.equal(rbac.mayChange(admin, admin, change), 'Nobody changes their own role, rights or halls — ask another admin.', JSON.stringify(change));
  }
  assert.equal(rbac.mayChange(admin, admin, { name: 'Ana A.' }), null, 'one\'s own name still');
  // A right that is not a name is refused in words, never made into one.
  assert.equal(rbac.mayChange(admin, crew, { grant: [{ toString: 1 }] }), 'Unknown right: one that is not a name');
  assert.equal(rbac.mayChange(admin, crew, { revoke: [{ toString() { throw new Error('read'); } }] }), 'Unknown right: one that is not a name');
  // What the Accounts page offers: the rooms each may give.
  assert.deepEqual(rbac.giveableRooms(admin), { all: true, rooms: [] });
  assert.deepEqual(rbac.giveableRooms({ ...pm, rooms: [MEDIA, LEGAL, 7] }), { all: false, rooms: [LEGAL, MEDIA] });
  assert.deepEqual(rbac.giveableRooms(pm), { all: false, rooms: [] }, 'every hall: no room');
  assert.deepEqual(rbac.giveableRooms({ ...admin, disabled: true }), { all: false, rooms: [] });
  assert.deepEqual(rbac.giveable(lead), { admin: false, caps: ['display.control', 'hall.files', 'hall.post', 'hall.view', 'stage.send', 'stage.show', 'stage.web'], allHalls: false, halls: ['HALLA1'] }, 'giveable keeps its shape');
  // A page is told an account's side rooms and On stage halls with its rights, last.
  const v = rbac.rightsView({ ...crew, rooms: [MEDIA, LEGAL], board: ['HALLA1'] });
  assert.deepEqual([Object.keys(v).slice(-2), v.rooms, v.board], [['rooms', 'board'], [LEGAL, MEDIA], ['HALLA1']]);
  // An On stage seat given is one the account takes, as the join seats it (roomRoleFor): it reaches the hall and may post
  // there, read with the account as changed and enabled; one it holds already passes, whatever its rights are now.
  const vic = { id: 'a6', role: 'viewer', halls: ['HALLA1'] };
  assert.deepEqual(rbac.unseatedOnStage(vic, { board: ['halla1'] }), { hall: 'HALLA1', why: 'post' }, 'a Viewer reads only there');
  assert.deepEqual(rbac.unseatedOnStage(crew, { board: ['HALLA1', 'HALLB2'] }), { hall: 'HALLB2', why: 'hall' }, 'a hall it does not reach');
  assert.equal(rbac.unseatedOnStage(crew, { board: ['HALLB2'], halls: ['HALLA1', 'HALLB2'] }), null, 'given with its hall');
  assert.deepEqual(rbac.unseatedOnStage(crew, { board: ['HALLA1'], revoke: ['hall.post'] }), { hall: 'HALLA1', why: 'post' }, 'its rights as changed');
  assert.equal(rbac.unseatedOnStage(vic, { role: 'staff', board: ['HALLA1'] }), null, 'a role that posts, in the same change');
  assert.equal(rbac.unseatedOnStage({ ...vic, board: ['HALLA1'] }, { board: ['HALLA1'] }), null, 'one held already: an untouched Save');
  assert.equal(rbac.unseatedOnStage({ ...crew, disabled: true }, { board: ['HALLA1'] }), null, 'read enabled');
  assert.equal(rbac.unseatedOnStage(null, { halls: ['HALLA1'], board: ['HALLA1'] }), null, 'a new account, a Staff account by default');
  assert.equal(rbac.unseatedOnStage(pm, { board: ['HALLB2'] }), null, 'every hall');
  assert.equal(rbac.unseatedOnStage(vic, { view: 'simple' }), null, 'no seat given');
  // A page is told the seats it takes: an On stage hall kept where it reads only, or does not reach, is no seat.
  assert.deepEqual([rbac.rightsView({ ...vic, board: ['HALLA1'] }).board, rbac.rightsView({ ...crew, board: ['HALLA1', 'HALLB2'] }).board, rbac.rightsView({ ...crew, board: ['HALLA1'], disabled: true }).board],
    [[], ['HALLA1'], []]);
});

test('accounts: side rooms, On stage halls and a chat view are kept as given, each read by type; an untouched save changes none', async () => {
  const dir = tmp('agm-acc-');
  const file = path.join(dir, 'accounts.json');
  const { accounts } = openStores(dir);
  const pw = 'blue door at the back';
  // Made with them: kept, upper case, once; a value that is no name dropped, never made into one and never a throw.
  const made = await accounts.create({ username: 'kim', role: 'tech', halls: ['halla1', { toString: 1 }], rooms: ['lgq4mzp8', 'LGQ4MZP8', { toString: 1 }, 7], board: ['HALLA1'], view: 'simple', password: pw });
  assert.deepEqual([made.account.halls, made.account.rooms, made.account.board, made.account.view], [['HALLA1'], ['LGQ4MZP8'], ['HALLA1'], 'simple']);
  // Made without them: stored as 0.5.1 stored an account, none of the three written.
  const plain = (await accounts.create({ username: 'sam', role: 'staff', password: pw })).account;
  assert.deepEqual(['rooms', 'board', 'view'].filter((f) => f in plain), []);
  assert.deepEqual((await accounts.create({ username: 'lou', role: 'staff', view: 'tiny', password: pw })).account.view, undefined, 'a view that is none of the three is not kept');
  // What a page is told: the three last, as stored, an account without them told none; then the clock or countdown the
  // admin chose for it, none at first.
  const shown = acc.Accounts.view(accounts.get(made.account.id));
  assert.deepEqual([Object.keys(shown).slice(-5), shown.rooms, shown.board, shown.view, shown.rights.rooms, shown.clock, shown.onStage], [['rooms', 'board', 'view', 'clock', 'onStage'], ['LGQ4MZP8'], ['HALLA1'], 'simple', ['LGQ4MZP8'], { show: null, locked: false }, { screens: false, people: false, clears: false }]);
  assert.deepEqual(['rooms', 'board', 'view'].map((f) => acc.Accounts.view(plain)[f]), [[], [], '']);
  // An untouched editor's lists, in any order or case, are no change; a list that now holds something else, a view now
  // another, is; a view that is none of the three changes nothing (the route refuses it in words).
  const id = made.account.id;
  assert.deepEqual(accounts.update(id, { halls: ['HALLA1'], rooms: ['lgq4mzp8'], board: ['halla1'], view: 'simple' }), []);
  assert.deepEqual(accounts.update(id, { view: 'tiny' }), []);
  assert.deepEqual(accounts.update(id, { view: { toString: 1 } }), []);
  assert.deepEqual(accounts.update(id, { rooms: ['MDR7VX2C', 'LGQ4MZP8'], board: [], view: 'full' }), ['rooms', 'board', 'view']);
  assert.deepEqual(accounts.update(id, { view: '' }), ['view'], 'back to by seat');
  assert.equal('view' in accounts.get(id), false, 'by seat is stored as none');
  assert.deepEqual(accounts.update(id, { rooms: [{ toString: 1 }], halls: [{ toString: 1 }] }), ['halls', 'rooms'], 'read by type: no throw, nothing kept');
  accounts.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.username === 'kim');
  assert.deepEqual([saved.halls, saved.rooms, saved.board, 'view' in saved], [[], [], [], false], 'saved through the lane');
  assert.deepEqual(acc.VIEWS, ['', 'simple', 'full']);
});

// ---------------------------------------------------------------- passwords and sessions
test('passwords: scrypt, the same work for an unknown name, the policy', async () => {
  const h = await acc.hashPassword('purple stage lights');
  assert.match(h, /^scrypt\$15\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.ok((await acc.verifyPassword('purple stage lights', h)).ok);
  assert.ok(!(await acc.verifyPassword('purple stage light', h)).ok);
  assert.ok(!(await acc.verifyPassword('anything', '')).ok, 'no hash: refused, after the same work');
  const old = await acc.hashPassword('purple stage lights', { logN: 14, r: 8, p: 3, keylen: 32 });
  assert.deepEqual(await acc.verifyPassword('purple stage lights', old), { ok: true, rehash: true }, 'an older cost is rehashed at the next sign-in');
  assert.match(acc.passwordProblem('short'), /at least 10/);
  assert.match(acc.passwordProblem('password123'), /too common/);
  assert.match(acc.passwordProblem('aaaaaaaaaaaa'), /repeated/);
  assert.match(acc.passwordProblem('samsamsamsam1', { username: 'sam' }), /username/);
  assert.equal(acc.passwordProblem('the green room kettle'), null);
  assert.match(acc.temporaryPassword(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

test('sessions: only a hash on disk; idle, age, a moved epoch and a turned-off account end them', async () => {
  const dir = tmp('agm-acc-');
  const st = openStores(dir);
  const { accounts, sessions } = st;
  const { account } = await accounts.create({ username: 'sam', name: 'Sam Patel', role: 'tech', password: 'blue door at the back' });
  const token = sessions.create(account, { ip: '10.0.0.9' });
  assert.equal(sessions.resolve(token).account.id, account.id);
  st.flush();
  const onDisk = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
  assert.ok(!onDisk.includes(token), 'the token itself is never stored');
  assert.ok(!onDisk.includes(crypto.createHash('sha256').update(token).digest('hex')), 'nor its SHA-256: its keyed hash alone');
  assert.ok(!fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8').includes('blue door'), 'nor a password');
  const again = openStores(dir).sessions;
  assert.ok(again.resolve(token), 'a restart keeps people signed in');
  assert.equal(sessions.resolve(token, Date.now() + acc.IDLE_MS + 1), null, 'idle too long');
  const t2 = sessions.create(account);
  accounts.signOutEverywhere(account.id);
  assert.equal(sessions.resolve(t2), null, 'sign out everywhere');
  const t3 = sessions.create(accounts.get(account.id));
  accounts.update(account.id, { disabled: true });
  assert.equal(sessions.resolve(t3), null, 'a turned-off account');
  assert.equal(sessions.resolve('x'.repeat(10)), null);
});

test('accounts: a check changes nothing; a password at an older cost is stored again by upgrade, never over a new one', async () => {
  const dir = tmp('agm-acc-');
  const { accounts } = openStores(dir);
  const pw = 'blue door at the back';
  const { account } = await accounts.create({ username: 'sam', role: 'tech', password: pw });
  const old = await acc.hashPassword(pw, { ...acc.SCRYPT, logN: acc.SCRYPT.logN - 1 });
  account.pw = old;
  const r = await accounts.authenticate('sam', pw);
  assert.deepEqual([r.account === account, r.rehash, account.pw, account.lastLoginAt], [true, true, old, 0], 'checked, not yet let in: nothing written');
  await accounts.upgrade(account, pw + 'x'.repeat(200));
  assert.ok(account.pw.startsWith('scrypt$' + acc.SCRYPT.logN + '$'), 'at today\'s cost');
  assert.equal((await accounts.authenticate('sam', pw + 'x'.repeat(200))).rehash, false, 'stored as it was checked: its first 128 characters');
  const other = await acc.hashPassword('a new password while it hashed');
  account.pw = old;
  const racing = accounts.upgrade(account, pw);
  account.pw = other;   // a new password set while the upgrade's hash is made
  await racing;
  assert.equal(account.pw, other, 'a password changed meanwhile is kept');
  accounts.flush();
});

test('sessions: an account\'s device count is the sessions that still let it in', async () => {
  const dir = tmp('agm-acc-');
  const { accounts, sessions } = openStores(dir);
  const { account } = await accounts.create({ username: 'sam', name: 'Sam Patel', role: 'tech', password: 'blue door at the back' });
  sessions.create(account); sessions.create(account);
  assert.equal(sessions.of(account.id).length, 2);
  accounts.signOutEverywhere(account.id);
  assert.equal(sessions.of(account.id).length, 0, 'signed out everywhere: no devices');
  sessions.create(accounts.get(account.id));
  assert.equal(sessions.of(account.id).length, 1);
  assert.equal(sessions.of(account.id, Date.now() + acc.IDLE_MS + 1).length, 0, 'idle too long');
  accounts.update(account.id, { disabled: true });
  assert.equal(sessions.of(account.id).length, 0, 'turned off');
  sessions.flush(); accounts.flush();
});

test('sessions: a session with a page open is in use, and the sweep names the open ones that have ended', async () => {
  const HOUR = 3600_000;
  const dir = tmp('agm-acc-');
  const { accounts, sessions } = openStores(dir);
  const { account } = await accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: 'the green room kettle' });
  const T = Date.now();
  const sha = (t) => sessions.hashOf(t);
  const token = sessions.create(account);
  const h = sha(token);
  const idle = sha(sessions.create(account));
  assert.ok(sessions.touch(h, T + 13 * HOUR), 'in use at hour 13');
  assert.ok(sessions.resolve(token, T + 14.5 * HOUR), 'so not idle at 14.5 h, though 14.5 h after sign-in');
  assert.deepEqual([...sessions.sweep(new Set([h, 'f'.repeat(64)]), T + 27 * HOUR)], ['f'.repeat(64)], 'an open socket keeps its session; an unknown one has ended');
  assert.ok(!sessions.map.has(idle), 'a session nobody uses is dropped by the sweep');
  assert.deepEqual([...sessions.sweep(new Set([h]), T + acc.MAX_AGE_MS + HOUR)], [h], 'seven days old: ended, however much it is used');
  assert.equal(sessions.touch(h), null);
  sessions.flush(); accounts.flush();
});

test('sessions: one account signing in again and again keeps its 20 newest and never signs anyone else out', async () => {
  const dir = tmp('agm-acc-');
  const { accounts, sessions } = openStores(dir);
  const ana = (await accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: 'the green room kettle' })).account;
  const vic = (await accounts.create({ username: 'vic', name: 'Vic', role: 'viewer', password: 'a viewer password here' })).account;
  const [MAX, PER] = [5000, 20];
  const anaToken = sessions.create(ana);
  let last = '';
  for (let i = 0; i < MAX; i++) last = sessions.create(vic);
  assert.ok(sessions.resolve(anaToken), 'the admin is still signed in after the viewer\'s 5000 sign-ins');
  assert.equal(sessions.of(vic.id).length, PER, 'the viewer keeps its 20 newest');
  assert.ok(sessions.resolve(last), 'the newest sign-in holds');
  assert.deepEqual([acc.MAX_SESSIONS, acc.MAX_PER_ACCOUNT], [MAX, PER]);
  // Past MAX_SESSIONS in all, the account with the most gives up its oldest: an account with one keeps it.
  const many = openStores(tmp('agm-acc-'), { accountsOf: { get: (id) => ({ id, epoch: 1 }) } }).sessions;
  const lone = many.create({ id: 'lone' });
  for (let u = 0; u <= MAX / PER; u++) for (let i = 0; i < PER; i++) many.create({ id: 'u' + u });
  assert.equal(many.map.size, MAX);
  assert.ok(many.resolve(lone), 'the account with one session keeps it');
  sessions.flush(); accounts.flush(); many.flush();
});

test('token sessions: only a hash on disk, kept across a restart under the same token, ended by a new token, a day at most', () => {
  const dir = tmp('agm-acc-');
  const file = path.join(dir, 'admin-sessions.json');
  const st = openStores(dir, { token: 'token-one' });
  const a = st.tokens;
  const sid = a.create();
  const gone = a.create();
  assert.ok(a.has(sid) && a.has(gone));
  a.destroy(gone);
  assert.ok(!a.has(gone), 'signed out');
  st.flush();
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes(sid), 'the cookie itself is never stored');
  assert.ok(!onDisk.includes(crypto.createHash('sha256').update(sid).digest('hex')), 'nor its SHA-256: its keyed hash alone');
  assert.ok(!onDisk.includes('token-one'), 'nor the token');
  assert.ok(openStores(dir, { token: 'token-one' }).tokens.has(sid), 'a restart with the same token keeps it');
  // Made here: only the sign-ins this run made, never one read back from the file (whoever wrote it there).
  assert.ok(a.mintedHere(sid), 'this run made it');
  assert.ok(!openStores(dir, { token: 'token-one' }).tokens.mintedHere(sid), 'read back at a restart: not made by that run');
  assert.ok(!a.mintedHere(gone) && !a.mintedHere('') && !a.mintedHere(undefined), 'signed out, or no sign-in');
  const other = openStores(dir, { token: 'token-two' });
  assert.ok(!other.tokens.has(sid), 'a new token ends it');
  assert.deepEqual([other.ks.report().adminSessions.state, other.rows.filter((r) => r.action === 'signins.ended')], ['ok', []], 'silently: the save checks, its tag is another token\'s');
  assert.ok(!a.has(sid, Date.now() + acc.TOKEN_SESSION_MS), 'a day at most');
  assert.ok(!a.has(sid) && !a.has('') && !a.has(undefined));
  a.flush();
});

test('token sessions: a new sign-in takes the ended ones with it, in memory and on disk', () => {
  const dir = tmp('agm-acc-');
  const file = path.join(dir, 'admin-sessions.json');
  const a = openStores(dir).tokens;
  const T = Date.now();
  for (let i = 0; i < 50; i++) a.create(T - acc.TOKEN_SESSION_MS - i);   // signed in more than a day ago, never back
  const sid = a.create(T);
  assert.equal(a.map.size, 1, 'only the sign-in whose day is not over');
  a.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1);
  assert.ok(a.has(sid));
});

test('accounts: two creates of one name at once make one, and two first admins at once make one', async () => {
  const dir = tmp('agm-acc-');
  const { accounts } = openStores(dir);
  const pw = 'blue door at the back';
  const [x, y] = await Promise.all([accounts.create({ username: 'sam', role: 'tech', password: pw }), accounts.create({ username: 'Sam', role: 'tech', password: pw })]);
  assert.deepEqual([x, y].map((r) => (r.account ? 'made' : r.error)).sort(), ['That username is taken.', 'made'], 'the name is reserved before its hash is made');
  const fresh = openStores(tmp('agm-acc-')).accounts;
  const [a, b] = await Promise.all(['ada', 'ben'].map((u) => fresh.create({ username: u, role: 'admin', password: pw }, 'setup', { firstAdmin: true })));
  assert.deepEqual([a, b].map((r) => (r.account ? 'made' : r.exists ? 'exists' : r.error)).sort(), ['exists', 'made'], 'one first admin');
  assert.equal(fresh.size, 1);
  assert.equal((await fresh.create({ username: 'cy', role: 'admin', password: pw }, 'setup', { firstAdmin: true })).exists, true, 'and none once there are accounts');
  accounts.flush(); fresh.flush();
});

test('accounts: what an untouched editor sends back is no change; only a field that now holds something else is one', async () => {
  const dir = tmp('agm-acc-');
  const { accounts } = openStores(dir);
  const pw = 'blue door at the back';
  const { account } = await accounts.create({ username: 'kim', name: 'Kim Tech', role: 'tech', halls: ['HALL01'], allHalls: false, grant: ['nodes.control'], revoke: ['stage.send'], password: pw });
  assert.deepEqual(accounts.update(account.id, { name: 'Kim Tech', role: 'tech', halls: ['hall01', 'HALL01'], allHalls: false, grant: ['nodes.control', 'nodes.control'], revoke: ['stage.send'] }), []);
  assert.deepEqual(accounts.update(account.id, { allHalls: null, grant: ['nodes.control'], revoke: [] }), ['allHalls', 'revoke']);
  assert.deepEqual(accounts.update(account.id, { allHalls: 'x' }), [], 'not true or false: the role\'s own, as it is now');
  assert.deepEqual(accounts.update(account.id, { halls: ['HALL02', 'HALL01'], grant: [] }), ['halls', 'grant']);
  assert.deepEqual([accounts.get(account.id).halls.sort(), accounts.get(account.id).grant, 'allHalls' in accounts.get(account.id)], [['HALL01', 'HALL02'], [], false]);
  accounts.flush();
});

test('accounts: keys of halls and rooms that are gone pruned from every account that names one, once each, and a key still named known', () => {
  const dir = tmp('agm-acc-');
  const file = path.join(dir, 'accounts.json');
  // As the store keeps them (no page gives an account rooms or On stage halls yet): written before the load.
  const user = (id, username, more) => ({ id, username, name: username, role: 'tech', hash: 'x', createdAt: 1, ...more });
  fs.writeFileSync(file, JSON.stringify({ v: 1, users: [
    user('a1', 'tom', { halls: ['HALL01', 'HALL02'], rooms: ['LGQ4MZP8', 'PRS3SS45'], board: ['HALL02'] }),
    user('a2', 'lou', { halls: ['HALL01'], rooms: ['LGQ4MZP8'] }),
    user('a3', 'kim', { halls: ['HALL03'] }),
  ] }));
  // A 0.5.1 file, on a laptop that has never keyed: the first start keys these accounts as found (none reaches past its halls).
  const { accounts } = openStores(dir);
  assert.deepEqual([accounts.names('HALL02'), accounts.names('PRS3SS45'), accounts.names('HALL09'), accounts.names('MDR7VX2C')], [true, true, false, false]);
  // A side room: out of each account's rooms; the ids of the accounts changed, each once.
  assert.deepEqual(accounts.prune({ rooms: ['LGQ4MZP8'] }), ['a1', 'a2']);
  // A hall with its room: out of halls, On stage halls and rooms alike, an account changed in two fields counted once.
  assert.deepEqual(accounts.prune({ halls: ['HALL02'], rooms: ['PRS3SS45'] }), ['a1']);
  assert.deepEqual(accounts.prune({ halls: ['HALL09'] }), [], 'a key nobody names changes nobody');
  assert.deepEqual(accounts.prune(), []);
  accounts.flush();
  const saved = Object.fromEntries(JSON.parse(fs.readFileSync(file, 'utf8')).users.map((u) => [u.username, [u.halls, u.rooms, u.board]]));
  assert.deepStrictEqual(saved, { tom: [['HALL01'], [], []], lou: [['HALL01'], [], undefined], kim: [['HALL03'], undefined, undefined] }, 'saved through the lane');
  assert.deepEqual([accounts.names('HALL02'), accounts.names('PRS3SS45'), accounts.names('HALL01')], [false, false, true]);
});

test('hashing: a check through the tunnel waits in a short queue of its own, leaves it when its request goes, and never holds the venue back', async () => {
  const stored = await acc.hashPassword('the green room kettle');
  const order = [];
  const gone = new AbortController();
  const tunnel = [];
  // One slot for the tunnel: one check runs, LANES.tunnel.queue wait, the next is refused at once.
  for (let i = 0; i <= acc.LANES.tunnel.queue; i++) {
    const signal = i === 3 ? gone.signal : new AbortController().signal;
    tunnel.push(acc.verifyPassword('wrong guess ' + i, stored, { lane: 'tunnel', signal }).then(() => { order.push('tunnel'); return 'hashed'; }, (e) => e.code));
  }
  assert.equal(await acc.verifyPassword('one more guess', stored, { lane: 'tunnel', signal: new AbortController().signal }).then(() => 'hashed', (e) => e.code), 'BUSY');
  const already = new AbortController(); already.abort();
  assert.equal(await acc.verifyPassword('gone already', stored, { lane: 'tunnel', signal: already.signal }).then(() => 'hashed', (e) => e.code), 'ABANDONED');
  gone.abort();
  const venue = await acc.verifyPassword('the green room kettle', stored, { lane: 'venue', signal: new AbortController().signal });
  order.push('venue');
  const made = acc.hashPassword('a new password here', acc.SCRYPT, { lane: 'tunnel' });   // no request: waits its turn, never refused
  assert.equal(venue.ok, true);
  const outcomes = await Promise.all(tunnel);
  assert.equal(outcomes[3], 'ABANDONED', 'a check whose request went is dropped unhashed');
  assert.equal(outcomes.filter((o) => o === 'hashed').length, acc.LANES.tunnel.queue, 'the rest are hashed in turn');
  assert.ok(order.indexOf('venue') <= 2, 'the venue check ran on its own slot, not behind the tunnel\'s queue: ' + order.join(' '));
  assert.match(await made, /^scrypt\$/);
});

test('hashing: a burst of unknown names before their dummy hash exists makes that hash once, not once per guess', async () => {
  // A fresh copy of the module: its dummy hash is not made yet, as after a restart.
  const file = require.resolve('../lib/accounts');
  const kept = require.cache[file];
  delete require.cache[file];
  const fresh = require('../lib/accounts');
  require.cache[file] = kept;
  const real = crypto.scrypt;
  let hashes = 0;
  crypto.scrypt = (...args) => { hashes++; return real(...args); };
  try {
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => fresh.verifyPassword('guess ' + i, '', { lane: 'tunnel', signal: new AbortController().signal }).then(() => 'hashed', (e) => e.code)));
    const hashed = outcomes.filter((o) => o === 'hashed').length;
    assert.equal(hashes, 1 + hashed, 'one dummy hash, then one per check that was hashed — not a dummy per guess: ' + hashes + ' hashes');
    assert.equal(hashed, 1 + fresh.LANES.tunnel.queue, 'the tunnel\'s slot and queue, and the rest told busy at once');
  } finally { crypto.scrypt = real; }
});

test('hashing: a hash scrypt refuses to run (a stored cost past its memory cap) gives its slot back', async () => {
  const tooCostly = ['scrypt', 20, 32, 16, crypto.randomBytes(16).toString('base64url'), crypto.randomBytes(32).toString('base64url')].join('$');
  assert.ok(acc.parseHash(tooCostly), 'within what a stored hash may say, past what scrypt runs in its memory cap');
  for (let i = 0; i < acc.LANES.venue.slots; i++) await assert.rejects(acc.verifyPassword('anything at all', tooCostly), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
  const pw = 'the green room kettle';
  const next = (async () => (await acc.verifyPassword(pw, await acc.hashPassword(pw))).ok)();
  assert.equal(await Promise.race([next, wait(5000).then(() => 'stuck behind slots that were never given back')]), true);
});

test('limits: a flood of new addresses never hands back an allowance used up, nor lifts a lock that holds', () => {
  const T = 1_000_000;
  const buckets = new guard.Buckets(0.5, 5, 100);
  for (let i = 0; i < 5; i++) assert.ok(buckets.take('198.51.100.7', T));
  assert.equal(buckets.take('198.51.100.7', T), false);
  for (let i = 0; i < 1000; i++) buckets.take('2001:db8::' + i, T + i);
  assert.ok(buckets.map.size <= 100, 'bounded: ' + buckets.map.size);
  assert.equal(buckets.take('198.51.100.7', T + 1000), false, 'the slowed address is still slowed');
  assert.equal(buckets.take('198.51.100.7', T + 2000), true, 'until it has earned a try back');
  const lock = new guard.Lockout(5, 60_000, 100);
  for (let i = 0; i < 5; i++) lock.fail('ana|tunnel', T);
  for (let i = 0; i < 1000; i++) lock.fail('guess' + i + '|tunnel', T + i);
  assert.ok(lock.map.size <= 100, 'bounded: ' + lock.map.size);
  assert.ok(lock.locked('ana|tunnel', T + 1000), 'the lock still holds');
  lock.fail('late|tunnel', T + 120_000);
  for (let i = 0; i < 200; i++) lock.fail('later' + i, T + 120_000);
  assert.ok(!lock.map.has('ana|tunnel'), 'an ended window goes first');
  lock.fail('sam|tunnel', T + 120_000); lock.fail('sam|10.0.0.9', T + 120_000);
  lock.forget((k) => k.startsWith('sam|'));
  assert.ok(!lock.map.has('sam|tunnel') && !lock.map.has('sam|10.0.0.9'), 'an admin\'s reset forgets the name');
});

// ---------------------------------------------------------------- the audit chain
test('audit: chained with a key; an edited, removed or reordered line is found; no secret fields', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = auditLog(file);
  for (let i = 0; i < 5; i++) log.write({ t: 'account', id: 'a1', name: 'sam' }, 'display.take', 'D1', 'message ' + i, '10.0.0.' + i);
  assert.deepEqual(brief(await log.verify()), { ok: true, mark: 'intact', entries: 5 });
  log.flush();
  const reopened = auditLog(file);
  reopened.write({ t: 'system' }, 'boot', '', 'restarted');
  assert.deepEqual(brief(await reopened.verify()), { ok: true, mark: 'intact', entries: 6 }, 'the chain goes on across a restart');
  assert.equal(reopened.latest(2)[0].action, 'boot', 'newest first');
  reopened.flush();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const edited = lines.slice(); edited[2] = edited[2].replace('message 2', 'message X');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  assert.match((await auditLog(file).verify()).why, /changed after it was written/);
  fs.writeFileSync(file, lines.filter((_, i) => i !== 3).join('\n') + '\n');
  assert.equal((await auditLog(file).verify()).mark, 'broken', 'a removed line breaks the chain');
  const swapped = lines.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  fs.writeFileSync(file, swapped.join('\n') + '\n');
  assert.equal((await auditLog(file).verify()).mark, 'broken', 'reordered lines break it');
  const e = auditLog(path.join(dir, 'b.jsonl')).write({ t: 'account', id: 'a1', name: 'sam', password: 'x' }, 'login', 'sam', 'ok', '', { token: 'y' });
  assert.deepEqual(Object.keys(e.actor).sort(), ['id', 'name', 't'], 'only the listed fields are kept');
});

const fiveEntries = () => {
  const file = path.join(tmp('agm-audit-'), 'audit.jsonl');
  const log = auditLog(file);
  for (let i = 0; i < 5; i++) log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'entry ' + i);
  log.flush();
  return { file, log, lines: fs.readFileSync(file, 'utf8').trim().split('\n') };
};

test('audit: the first line, the last line and the whole file are part of the chain', async () => {
  const a = fiveEntries();
  fs.writeFileSync(a.file, a.lines.slice(1).join('\n') + '\n');
  const first = await auditLog(a.file).verify();
  assert.equal(first.ok, false, 'the oldest line removed: ' + JSON.stringify(first));
  assert.equal(first.brokenAt, 1);
  assert.match(first.why, /entry 1 is missing/);

  const b = fiveEntries();
  fs.writeFileSync(b.file, b.lines.slice(0, -1).join('\n') + '\n');
  const last = await b.log.verify();
  assert.equal(last.ok, false, 'the newest line removed while the server runs: ' + JSON.stringify(last));
  assert.match(last.why, /after entry 4, entry 5 is missing/);

  const c = fiveEntries();
  fs.unlinkSync(c.file);
  const gone = await c.log.verify();
  assert.equal(gone.ok, false, 'the file removed while the server runs: ' + JSON.stringify(gone));
  assert.match(gone.why, /missing/);
  c.log.write({ t: 'system' }, 'boot', '', 'one more');
  const after = await c.log.verify();
  assert.equal(after.ok, false, 'one more entry does not hide it: ' + JSON.stringify(after));
  assert.match(after.why, /entries 1 to 5 are missing/);
});

test('audit: a rotated log is checked with the current one as one chain', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const text = chainOf(36_000, (i) => 'take ' + i + ' ' + 'x'.repeat(300));   // just over 20 MB
  assert.ok(text.length > 20 * 1024 * 1024);
  fs.writeFileSync(file, text);
  const log = auditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'the first entry of the next file');
  const rotated = fs.readdirSync(dir).filter((f) => /^audit-.+\.jsonl$/.test(f));
  assert.equal(rotated.length, 1, 'rotated at 20 MB');
  // The 0.5.1 entries read △ until accepted; the log opens with `audit.keyed`, so 36,000 + the boundary + the boot.
  const both = await log.verify();
  assert.deepEqual(brief(both), { ok: false, mark: 'unvouched', entries: 36_002 }, 'both files, one chain');
  assert.deepEqual(both.findings.map((f) => [f.id, f.kind]), [['s1-36000', 'plain']]);
  log.flush();
  assert.deepEqual(brief(await auditLog(file).verify()), { ok: false, mark: 'unvouched', entries: 36_002 }, 'and after a restart');
  assert.equal((await acceptAll(log)).ok, true);
  assert.deepEqual(brief(await log.verify()), { ok: false, mark: 'linked', entries: 36_003 }, 'accepted: ◇, never ✓');
  log.flush();

  const old = path.join(dir, rotated[0]);
  const lines = fs.readFileSync(old, 'utf8').split('\n');
  lines[10] = lines[10].replace('take 11 ', 'take 99 ');
  fs.writeFileSync(old, lines.join('\n'));
  const edited = await log.verify();
  assert.deepEqual([edited.ok, edited.file, edited.brokenAt], [false, rotated[0], 11], JSON.stringify(edited));
  assert.match(edited.why, /entry 11 was changed/);

  fs.unlinkSync(old);
  const removed = await log.verify();
  assert.equal(removed.ok, false, 'a rotated file removed: ' + JSON.stringify(removed));
  assert.equal(removed.file, 'audit.jsonl');
  assert.match(removed.why, /entries 1 to 36000 are missing/);
});

test('audit: one failed write is kept and written with the next, so the chain on disk stays whole', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = auditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'first');
  fs.renameSync(file, file + '.held');
  fs.mkdirSync(file);   // the next open fails, as a full disk or a held file does
  log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk would not take it');
  assert.ok(log.lastError, 'the failure is kept for health');
  assert.equal(log.unwritten, 1);
  fs.rmdirSync(file);
  fs.renameSync(file + '.held', file);
  const waiting = await log.verify();
  assert.deepEqual(brief(waiting), { ok: true, mark: 'intact', entries: 1, unwritten: 1 }, 'what is on disk is whole, and one entry waits');
  log.write({ t: 'system' }, 'x', '', 'third');
  log.write({ t: 'system' }, 'x', '', 'fourth');
  assert.equal(log.unwritten, 0);
  assert.equal(log.lastError, null);
  assert.deepEqual(brief(await log.verify()), { ok: true, mark: 'intact', entries: 4 });
  assert.ok(fs.readFileSync(file, 'utf8').includes('second, while the disk would not take it'), 'the entry that failed is on disk now');
});

test('audit: an entry still waiting when the server stops is put on disk by the stop, not lost with it', async (t) => {
  const log = auditLog(path.join(tmp('agm-audit-'), 'audit.jsonl'));
  log.write({ t: 'system' }, 'boot', '', 'first');
  fs.renameSync(log.file, log.file + '.held'); fs.mkdirSync(log.file);
  log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk would not take it');
  assert.equal(log.flush(), false, 'a flush that still cannot write says so');
  fs.rmdirSync(log.file); fs.renameSync(log.file + '.held', log.file);
  assert.equal(log.flush(), true);
  assert.equal(log.unwritten, 0);
  assert.deepEqual(brief(await log.verify()), { ok: true, mark: 'intact', entries: 2 });

  // End to end: the disk refuses one audited action; it is back by the time the server stops (SIGTERM).
  const srv = await startServer();
  let up = true;
  t.after(async () => { if (up) await stopServer(srv.child); });
  const file = path.join(srv.dataDir, 'audit.jsonl');
  assert.equal((await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).status, 200);
  assert.ok(fs.existsSync(file), 'the first sign-in is on disk');
  fs.renameSync(file, file + '.held'); fs.mkdirSync(file);
  assert.equal((await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).status, 200);
  assert.equal((await api(srv.base, 'GET', '/api/health')).body.saves.stores.audit.unwritten, 1, 'health says one entry waits');
  fs.rmdirSync(file); fs.renameSync(file + '.held', file);
  await stopServer(srv.child); up = false;
  const actions = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action);
  assert.deepEqual(actions, ['login.token', 'login.token'], 'the second sign-in is on disk after the stop');
  assert.deepEqual(brief(await serverAudit(srv.dataDir).verify()), { ok: true, mark: 'intact', entries: actions.length }, 'checked under the server\'s own key and records');
});

test('audit: a write the disk takes only part of is cut back, on Windows too, and the chain on disk stays whole', async () => {
  const dir = tmp('agm-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const log = auditLog(file);
  log.write({ t: 'system' }, 'boot', '', 'first');
  const before = fs.readFileSync(file, 'utf8');
  // As on Windows: a handle opened for appending writes only at the end and cannot cut the file back.
  const { openSync, writeSync, ftruncateSync } = fs;
  const appending = new Set();
  fs.openSync = (p, flags, ...rest) => {
    const fd = openSync.call(fs, p, flags, ...rest);
    if (typeof flags === 'string' ? flags.startsWith('a') : (flags & fs.constants.O_APPEND) !== 0) appending.add(fd); else appending.delete(fd);
    return fd;
  };
  fs.ftruncateSync = (fd, ...rest) => {
    if (appending.has(fd)) throw Object.assign(new Error('EPERM: operation not permitted, ftruncate'), { code: 'EPERM' });
    return ftruncateSync.call(fs, fd, ...rest);
  };
  fs.writeSync = (fd, buf, off = 0, len = buf.length - off, pos = null) => {
    fs.writeSync = writeSync;   // the disk is full for this one write: it takes half
    return writeSync.call(fs, fd, buf, off, Math.floor(len / 2), pos);
  };
  try {
    log.write({ t: 'account', id: 'a1', name: 'sam' }, 'login', 'sam', 'second, while the disk was full');
    assert.match(String(log.lastError), /took \d+ of \d+ bytes/);
    assert.equal(log.unwritten, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the part that was written is cut back');
    log.write({ t: 'system' }, 'x', '', 'third');
  } finally { Object.assign(fs, { openSync, writeSync, ftruncateSync }); }
  assert.equal(log.unwritten, 0);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).words), ['first', 'second, while the disk was full', 'third']);
  assert.deepEqual(brief(await log.verify()), { ok: true, mark: 'intact', entries: 3 });
});

for (const [what, tail] of [['a half-written last line', '{"seq":4,"at":17'], ['a NUL-filled tail (NTFS after a power cut)', Buffer.alloc(180)]]) {
  test('audit: ' + what + ' is cut at the next start, the cut is an entry, and the chain goes on whole', async () => {
    const dir = tmp('agm-audit-');
    const file = path.join(dir, 'audit.jsonl');
    const log = auditLog(file);
    for (let i = 0; i < 3; i++) log.write({ t: 'system' }, 'x', '', 'message ' + i);
    log.flush();
    fs.appendFileSync(file, tail);
    const again = auditLog(file);
    again.write({ t: 'account', id: 'a1', name: 'ana' }, 'login', 'ana', 'signed in after the restart');
    const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => e.action), ['x', 'x', 'x', 'audit.repair', 'login'], 'every line whole, the repair before the sign-in');
    assert.match(entries[3].words, /half-written last line \(\d+ bytes\) was cut after an unclean stop, kept aside as audit-torn-/);
    assert.deepEqual(brief(await again.verify()), { ok: true, mark: 'intact', entries: 5 });
    const aside = fs.readdirSync(dir).filter((f) => /^audit-torn-.+\.bin$/.test(f));
    assert.equal(aside.length, 1, 'the cut bytes are kept aside');
    assert.deepEqual(fs.readFileSync(path.join(dir, aside[0])), Buffer.from(tail), 'byte for byte');
  });
}

// Two seeds: the 0.5.1 chain, which reads △ with its one plain finding until accepted, and a chain keyed under this
// machine's key, whose every entry is MAC-checked and which reads ✓. The walk is counted as work by test/audit-preload.js,
// never timed: how long a turn of the loop takes is the machine's (a busy one stretches it), how much a turn does is the
// check's. The loop turns after every 1,000 lines (lib/audit.js's SLICE), which is when a page asking meanwhile is read
// and answered; the log is read off the loop; and a second click while the walk runs shares it.
for (const seed of ['plain', 'keyed']) {
  test('audit: checking a full-size ' + seed + ' log reads it off the event loop and walks at most 1,000 lines between two turns of the loop, one check at a time, and still finds an edited line', async () => {
    const dir = tmp('agm-audit-');
    const file = path.join(dir, 'audit.jsonl');
    const n = 56_000;
    if (seed === 'plain') fs.writeFileSync(file, chainOf(n));   // about 20 MB, just under the rotation size
    else keyedChainOf(n, { file });
    const log = auditLog(file);
    log.open();   // the server's start, before anyone can ask for a check
    const m = meter();
    let r;
    try {
      const check = log.verify();
      assert.strictEqual(log.verify(), check, 'a second click shares the running check');
      r = await check;
    } finally { m.stop(); }
    if (seed === 'plain') {
      assert.deepEqual(brief(r), { ok: false, mark: 'unvouched', entries: n + 1 }, 'the seed and its `audit.keyed`');
      assert.deepEqual(r.findings.map((f) => [f.id, f.kind, f.first]), [['s1-' + n, 'plain', true]]);
    } else assert.deepEqual(brief(r), { ok: true, mark: 'intact', entries: n });
    const w = m.seen();
    const said = JSON.stringify(w);
    assert.deepEqual([w.walks, w.atOnce], [1, 1], 'two clicks, one walk: ' + said);
    assert.equal(w.lines, r.entries, 'the walk read each line of the chain once: ' + said);
    assert.ok(w.most.lines > 0 && w.most.lines <= 1000, 'at most 1,000 lines between two turns of the loop: ' + said);
    assert.ok(w.turns >= Math.ceil(w.lines / 1000), 'the loop turned at least once per 1,000 lines: ' + said);
    assert.deepEqual([w.syncReads, w.asyncReads > 0, w.reading], [0, true, 1], 'the log read off the event loop one read at a time, never with a synchronous read: ' + said);

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[100] = lines[100].replace('Lectern', 'Foyer');
    fs.writeFileSync(file, lines.join('\n'));
    const edited = await log.verify();
    assert.deepEqual([edited.ok, edited.mark, edited.brokenAt], [false, 'broken', 101]);
    assert.match(edited.why, /changed after it was written/);
  });
}

// ---------------------------------------------------------------- end to end
test('accounts end to end: first admin, sign-in, rights, joining a hall, revocation, origin, audit', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  const stagewatches = [];   // closed once the server that links them has stopped
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await Promise.all(stagewatches.map((sw) => sw.close())); });
  // Every sign-in here comes from one address, whose allowance (5 at once, then one every 2 s) the subtests before it have
  // spent: a sign-in that is not about that limit waits for its next one, as a person would — a few tries at most.
  const signIn = async (username, password) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(base, 'POST', '/api/auth/login', { username, password });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };

  // Nobody has an account: the page says so; the first admin is made on this laptop.
  const me0 = await api(base, 'GET', '/api/auth/me');
  assert.deepEqual(me0.body, { ok: true, account: null, setup: true, held: null });
  // A page served under another name that resolves to this laptop (its Origin matching its Host) is not the laptop.
  const rebound = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'ivy', name: 'Ivy', password: 'the green room kettle' });
    const host = 'agm.example:' + new URL(base).port;
    const rq = http.request(base + '/api/setup', { method: 'POST', headers: { host, origin: 'http://' + host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    rq.on('error', reject); rq.end(body);
  });
  assert.equal(rebound, 403, 'the first admin is not made from a page under another name');
  assert.equal((await api(base, 'GET', '/api/auth/me')).body.setup, true, 'still no accounts');
  const weak = await setupAdmin(base, { username: 'ana', name: 'Ana Admin', password: 'short' });
  assert.equal(weak.status, 400);
  const setup = await setupAdmin(base);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const admin = setup.cookie;
  assert.match(admin, /^agm_s=/);
  assert.equal((await setupAdmin(base, { username: 'ben', name: 'B', password: 'the green room kettle' })).status, 409, 'only once');

  // A hall, two accounts: a tech in that hall, a project manager everywhere. One-time passwords, changed at first sign-in.
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const other = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const tech = await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall] }, { cookie: admin });
  assert.equal(tech.status, 200, JSON.stringify(tech.body));
  assert.match(tech.body.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/, 'a one-time password is shown once');
  const pm = await api(base, 'POST', '/api/users', { username: 'pat', name: 'Pat PM', role: 'manager', password: 'clipboard and coffee' }, { cookie: admin });
  assert.equal(pm.status, 200);

  await t.test('sign-in: wrong password refused in the same words as an unknown name; a one-time password must be changed first', async () => {
    const bad = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'nope nope nope' });
    const unknown = await api(base, 'POST', '/api/auth/login', { username: 'nobody', password: 'nope nope nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, unknown.body.error, 'no hint which names exist');
    const first = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: tech.body.password });
    assert.equal(first.status, 200);
    assert.equal(first.body.mustChange, true);
    const blocked = await api(base, 'GET', '/api/halls', undefined, { cookie: first.cookie });
    assert.equal(blocked.status, 403, 'nothing else until the password is changed');
    const changed = await api(base, 'POST', '/api/auth/password', { current: tech.body.password, next: 'mixing desk on stage left' }, { cookie: first.cookie });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await api(base, 'GET', '/api/halls', undefined, { cookie: first.cookie })).status, 401, 'the old session ended with the change');
    const halls = await api(base, 'GET', '/api/halls', undefined, { cookie: changed.cookie });
    assert.deepEqual(halls.body.halls.map((h) => h.code), [hall], 'a tech sees their own hall only');
  });

  const samLogin = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' });
  const sam = samLogin.cookie;
  const pat = (await api(base, 'POST', '/api/auth/login', { username: 'pat', password: 'clipboard and coffee' })).cookie;

  await t.test('a project manager sees every hall; a tech cannot manage accounts or escalate', async () => {
    const h = await api(base, 'GET', '/api/halls', undefined, { cookie: pat });
    assert.deepEqual(h.body.halls.map((x) => x.code).sort(), [hall, other].sort());
    assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: sam })).status, 403);
    assert.equal((await api(base, 'POST', '/api/users', { username: 'eve', role: 'admin' }, { cookie: sam })).status, 403);
  });

  await t.test('a state change from another site is refused (Origin), and the admin token cannot sign in through the tunnel', async () => {
    const r = await api(base, 'POST', '/api/users', { username: 'mallory', role: 'staff' }, { cookie: admin, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /another site/);
    const tunnel = await api(base, 'POST', '/api/auth/login', { username: 'ana', password: 'the green room kettle' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    const wrong = await api(base, 'POST', '/api/auth/login', { username: 'ana', password: 'not the password at all' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.deepEqual([tunnel.status, tunnel.body.error, tunnel.cookie], [401, wrong.body.error, ''], 'admin rights do not sign in through the tunnel by default — answered as a wrong password is');
    const techTunnel = await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(techTunnel.status, 200, 'everyone else may');
  });

  await t.test('an account joins its hall by code with its own name and rights; not another hall; guests cannot take its name', async () => {
    const s = await connect(base, sam); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: hall, as: 'account' });
    assert.ok(j.ok, JSON.stringify(j));
    assert.equal(j.name, 'Sam Tech');
    assert.equal(j.role, 'research', 'a tech posts');
    assert.equal(j.uid, j.account && samLogin.body.account.id);
    assert.ok(j.uploadToken, 'and shares files');
    const m = await emit(s, 'message', { type: 'text', text: 'Radio mic 3 battery low' });
    assert.ok(m.ok);
    const no = await emit(s, 'join', { roomCode: other, as: 'account' });
    assert.equal(no.ok, false);
    assert.match(no.error, /no access/);
    const guest = await connect(base); sockets.push(guest);
    const g = await emit(guest, 'join', { roomCode: hall, name: 'sam tech', role: 'research' });
    assert.equal(g.ok, false);
    assert.match(g.error, /belongs to an AGMessage account/);
    const anon = await connect(base); sockets.push(anon);
    assert.equal((await emit(anon, 'join', { roomCode: hall, as: 'account' })).signIn, true, 'no session: sign in first');
  });

  await t.test('a signed-in browser is refused a code join, without spending the code lock; it enters by its account, and the support view and the host token\'s admin are not code joins', async () => {
    const ctl = await connect(base, admin); sockets.push(ctl);
    const seated = async () => (await new Promise((resolve) => { ctl.emit('admin:listRooms', resolve); })).rooms.find((r) => r.code === hall).users.map((u) => u.name);
    // A guest's join first: it clears this address's count of failed joins.
    const gwen = await connect(base); sockets.push(gwen);
    assert.ok((await emit(gwen, 'join', { roomCode: hall, name: 'Gwen', role: 'observer' })).ok);
    // Sam (a tech: no Stagewatch) has the hall's code: a guest's backstage seat would give Sam the stage. Eleven tries, one
    // more than the lock allows: each is the same refusal, and none is counted as a guess.
    const s = await connect(base, sam); sockets.push(s);
    const tries = [];
    for (let i = 0; i < 11; i++) tries.push(await emit(s, 'join', { roomCode: hall, name: 'Backstage Sam', role: 'research', invite: '' }));
    const words = 'You are signed in as Sam Tech: open the room from your halls, or sign out to join with a code.';
    assert.deepEqual(tries, Array(11).fill({ ok: false, error: words, signedIn: true }));
    assert.ok(!(await seated()).includes('Backstage Sam'), 'not seated');
    assert.equal((await emit(s, 'message', { type: 'text', text: 'from the guest seat' })).error, 'Not joined');
    const guess = await connect(base); sockets.push(guess);
    assert.equal((await emit(guess, 'join', { roomCode: 'ZZZZZZ', name: 'Guess', role: 'observer' })).error, 'Room not found', 'the lock was not reached: the refusals spent none of it');
    assert.ok((await emit(guess, 'join', { roomCode: hall, name: 'Guess', role: 'observer' })).ok, 'and a guest still joins (the count cleared again)');
    const own = await emit(s, 'join', { roomCode: hall, as: 'account' });
    assert.deepEqual([own.ok, own.name, own.role, own.uid], [true, 'Sam Tech', 'research', samLogin.body.account.id], 'the same socket enters by its account');
    // A one-time password not yet changed is still a signed-in browser.
    const made = await api(base, 'POST', '/api/users', { username: 'tia', name: 'Tia Temp', role: 'staff', halls: [hall] }, { cookie: admin });
    const tia = await signIn('tia', made.body.password);
    const t1 = await connect(base, tia); sockets.push(t1);
    assert.deepEqual(await emit(t1, 'join', { roomCode: hall, name: 'Tia', role: 'observer' }), { ok: false, error: 'You are signed in as Tia Temp: open the room from your halls, or sign out to join with a code.', signedIn: true });
    // The admin's support view of a guest is not a code join, from an admin account's browser.
    const view = await emit(ctl, 'join', { roomCode: hall, name: 'Gwen', role: 'observer', adminView: true });
    assert.deepEqual([view.ok, view.adminView, view.role], [true, true, 'observer']);
    // The host token's admin has no account: a browser holding the token's sign-in beside an account's joins with a code.
    const token = (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
    assert.match(token, /^agm_admin=/);
    const desk = await connect(base, token + '; ' + admin); sockets.push(desk);
    const dj = await emit(desk, 'join', { roomCode: hall, name: 'Desk', role: 'research' });
    assert.deepEqual([dj.ok, dj.role, dj.account], [true, 'research', null]);
    assert.ok((await seated()).includes('Desk'));
  });

  await t.test('rights changed under a live socket: it is told and closed, and the next connection has the new rights', async () => {
    const s = await connect(base, sam); sockets.push(s);
    assert.ok((await emit(s, 'join', { roomCode: hall, as: 'account' })).ok);
    const told = once(s, 'account:changed');
    const gone = once(s, 'disconnect');
    const samId = samLogin.body.account.id;
    const r = await api(base, 'PATCH', '/api/users/' + samId, { role: 'viewer' }, { cookie: admin });
    assert.deepEqual(r.body.changed, ['role']);
    await told; await gone;
    const s2 = await connect(base, sam); sockets.push(s2);
    const j = await emit(s2, 'join', { roomCode: hall, as: 'account' });
    assert.equal(j.role, 'observer', 'a viewer reads');
    assert.equal(j.uploadToken, null);
    assert.equal((await emit(s2, 'message', { type: 'text', text: 'x' })).ok, false);
    await api(base, 'PATCH', '/api/users/' + samId, { disabled: true }, { cookie: admin });
    assert.equal((await api(base, 'GET', '/api/halls', undefined, { cookie: sam })).status, 401, 'turned off: signed out everywhere');
    await wait(100);
  });

  await t.test('the last admin cannot be turned off or demoted, not even by themselves', async () => {
    const anaId = setup.body.account.id;
    assert.equal((await api(base, 'PATCH', '/api/users/' + anaId, { role: 'staff' }, { cookie: admin })).status, 403);
  });

  await t.test('the admin\'s room controls, the desk\'s proposals and the lines sent to the speaker\'s screen each write one row of their own, with no message text; a new hall\'s name is cleaned', async () => {
    const sw = await fakeStagewatch({ name: 'Hall 5 timer' });
    stagewatches.push(sw);
    const ctl = await connect(base, admin); sockets.push(ctl);
    // A name typed with control, bidi override and isolate characters is stored cleaned, from the admin page's socket and
    // from the HTTP route alike: the page, the lookup and the audit row all read it so.
    const made = await emit(ctl, 'admin:createRoom', { name: '\u202eHall\u0007 5\u2066 ' });
    assert.deepEqual([made.ok, made.name], [true, 'Hall 5'], JSON.stringify(made));
    const h5 = made.code;
    const posted = await api(base, 'POST', '/api/rooms', { name: '\u200fHall 6\u0000\u2069' }, { cookie: admin });
    assert.equal(posted.body.name, 'Hall 6');
    const h6 = posted.body.code;
    assert.equal((await api(base, 'GET', '/api/rooms/' + h6)).body.name, 'Hall 6');
    const listed = await new Promise((resolve) => { ctl.emit('admin:listRooms', resolve); });   // its ack is its only argument
    assert.equal(listed.rooms.find((r) => r.code === h5).name, 'Hall 5');
    const nameless = await emit(ctl, 'admin:createRoom', { name: '\u202e\u0007 ' });   // nothing left once cleaned
    assert.deepEqual([nameless.ok, nameless.name], [true, '']);
    const hN = nameless.code;

    assert.ok((await emit(ctl, 'hall:configure', { code: h5, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall5_node_key_00001' /* secret-scan: fixture */ })).ok);
    await until(() => sw.connected, 6000, 'Stagewatch linked');
    let ivy = await connect(base); sockets.push(ivy);
    const ij = await emit(ivy, 'join', { roomCode: h5, name: 'Ivy', role: 'board', invite: inviteOf(srv.dataDir, h5) });
    assert.ok(ij.ok, JSON.stringify(ij));
    const kim = await connect(base); sockets.push(kim);
    const kj = await emit(kim, 'join', { roomCode: h5, name: 'Kim', role: 'research' });
    assert.ok(kj.ok, JSON.stringify(kj));
    const upload = async (name) => {
      const f = new FormData(); f.append('file', new Blob(['notes for the board'], { type: 'text/plain' }), name);
      const url = (await (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': kj.uploadToken }, body: f })).json()).url;
      const m = await emit(kim, 'message', { type: 'file', url, filename: name });
      assert.ok(m.ok, JSON.stringify(m));
      return { url, id: m.id };
    };
    const SAID = 'The capex figure is 4.2m';
    const ASK = 'Wrap up in five, the capex slide is next';
    const ASK_TOO = 'Capex questions after the break 🙂';   // an emoji: counted as one character, as a person counts it
    const MINUTES = 'Minutes: capex agreed at 4.2m';
    const said = await emit(kim, 'message', { type: 'text', text: SAID });
    const pack = await upload('board-pack-q3.txt');
    const kept = await upload('kept-notes.txt');
    await until(async () => (await emit(kim, 'stage:targets', {})).canPropose, 8000, 'the desk');
    const asked = await emit(kim, 'stage:propose', { text: ASK, destination: 'speaker' });
    assert.ok(asked.ok, JSON.stringify(asked));
    // A line sent straight to the speaker's screen: one row, its characters counted as a person counts them (an emoji
    // is one), never its words.
    const SENT = 'Two minutes, it is {time} 😀';
    const sent = await emit(kim, 'stage:send', { text: SENT });
    assert.deepEqual([sent.ok, sent.stage], [true, 'applied'], JSON.stringify(sent));
    // A seat On stage holds no stage.send: refused in the speaker's screen's words, nothing reaches Stagewatch, no row.
    const toScreen = () => sw.requests.filter((q) => q.url.startsWith('/api/message/')).length;
    const screenBefore = toScreen();
    assert.deepEqual(await emit(ivy, 'stage:send', { text: 'From the Board' }), { ok: false, error: 'The speaker\'s screen is for the backstage team.' });
    assert.equal(toScreen(), screenBefore, 'nothing sent from the Board');
    // A page that sends and then joins another hall before Stagewatch answers: the line and the row stay with the hall
    // it was sent from.
    const mo = await connect(base); sockets.push(mo);
    const mj = await emit(mo, 'join', { roomCode: h5, name: 'Mo', role: 'research' });
    assert.ok(mj.ok, JSON.stringify(mj));
    const SENT_TOO = 'Mic 4 is live';
    sw.messageDelayMs = 500;
    let delivered = false;
    const sending = emit(mo, 'stage:send', { text: SENT_TOO }).then((r) => { delivered = true; return r; });
    assert.ok((await emit(mo, 'join', { roomCode: h6, name: 'Mo', role: 'research', uid: mj.identity })).ok);
    assert.equal(delivered, false, 'the page moved while Stagewatch had not answered');
    const sent2 = await sending;
    sw.messageDelayMs = 0;
    assert.ok(sent2.ok, JSON.stringify(sent2));

    // A page that proposes and then joins another hall before the desk answers: the proposal, its row and its line stay
    // with the hall it was asked from.
    const lee = await connect(base); sockets.push(lee);
    const lj = await emit(lee, 'join', { roomCode: h5, name: 'Lee', role: 'research' });
    assert.ok(lj.ok, JSON.stringify(lj));
    sw.proposalDelayMs = 500;
    let answered = false;
    const asking = emit(lee, 'stage:propose', { text: ASK_TOO, destination: 'speaker' }).then((r) => { answered = true; return r; });
    const moved = await emit(lee, 'join', { roomCode: h6, name: 'Lee', role: 'research', uid: lj.identity });
    assert.ok(moved.ok, JSON.stringify(moved));
    assert.equal(answered, false, 'the page moved while the desk had not answered');
    const asked2 = await asking;
    sw.proposalDelayMs = 0;
    assert.ok(asked2.ok, JSON.stringify(asked2));
    const lines = async (code) => (await emit(ctl, 'admin:watchRoom', { roomCode: code })).messages.map((m) => m.text || '');
    assert.ok((await lines(h5)).some((x) => x.startsWith('Lee asked Stagewatch\'s operator')), 'the line is in the hall it was asked from');
    assert.ok(!(await lines(h6)).some((x) => x.includes('asked Stagewatch\'s operator')), 'and not in the hall the page went to');
    assert.deepEqual((await lines(h5)).filter((x) => x.includes('sent to the speaker\'s screen')), ['Kim sent to the speaker\'s screen: “Two minutes, it is (time) 😀”', 'Mo sent to the speaker\'s screen: “' + SENT_TOO + '”'], 'each send\'s line in the hall it was sent from');
    assert.ok(!(await lines(h6)).some((x) => x.includes('sent to the speaker\'s screen')), 'and none in the hall Mo went to');

    assert.ok((await emit(ctl, 'admin:deleteMessage', { roomCode: h5, messageId: said.id })).ok);
    assert.ok((await emit(ctl, 'admin:deleteMessage', { roomCode: h5, messageId: pack.id })).ok);
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: h5, on: true })).ok);
    // Ivy's page comes back on a new socket and keeps her seat, now after Kim's in the hall's list: locked again, the
    // same two seats are kept, and nothing changed.
    const was = ivy.id;
    ivy.close();
    await until(async () => !(await new Promise((resolve) => { ctl.emit('admin:listRooms', resolve); })).rooms.find((r) => r.code === h5).users.some((u) => u.socketId === was), 3000, 'Ivy\'s page gone');
    ivy = await connect(base); sockets.push(ivy);
    const back = await emit(ivy, 'join', { roomCode: h5, name: 'Ivy', role: 'board', uid: ij.identity });
    assert.equal(back.role, 'board', JSON.stringify(back));
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: h5, on: true })).ok, 'locked again with the same seats: nothing changes');
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: h5, socketId: kim.id, role: 'observer' })).ok);
    assert.ok((await emit(ctl, 'admin:setRole', { roomCode: h5, socketId: kim.id, role: 'observer' })).ok, 'a role set again is accepted, and changes nothing');
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: h5, on: false })).ok);
    assert.ok((await emit(ctl, 'admin:lockRoles', { roomCode: h5, on: false })).ok, 'unlocked again: nothing changes');
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: kim.id, targetRoom: hall })).ok);
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: kim.id, targetRoom: hall })).ok, 'a link Kim already has: nothing changes');
    assert.ok((await emit(ctl, 'admin:linkRoom', { socketId: kim.id, targetRoom: hN })).ok);
    assert.ok((await emit(ctl, 'admin:unlinkRoom', { socketId: kim.id, targetRoom: hall })).ok);
    assert.ok((await emit(ctl, 'admin:unlinkRoom', { socketId: kim.id, targetRoom: hall })).ok, 'a link no longer there: nothing to undo');
    assert.ok((await emit(ctl, 'admin:postSummary', { roomCode: h5, text: MINUTES })).ok);
    assert.equal((await emit(ctl, 'admin:resetRoom', { roomCode: h5 })).removed, 1);
    const out = once(kim, 'disconnect');
    assert.ok((await emit(ctl, 'admin:kick', { socketId: kim.id })).ok);
    await out;
    // A page in no hall (the join page, before its code) sent out: there is no hall to name.
    const stray = await connect(base); sockets.push(stray);
    const strayGone = once(stray, 'disconnect');
    assert.ok((await emit(ctl, 'admin:kick', { socketId: stray.id })).ok);
    await strayGone;

    const entries = (await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie: admin })).body.entries.slice().reverse();
    const ROWS = new Set(['hall.create', 'stagewatch.propose', 'stagewatch.send', 'message.remove', 'room.lock', 'seat.role', 'room.link', 'room.unlink', 'minutes.post', 'room.reset', 'seat.kick']);
    const rows = entries.filter((e) => ROWS.has(e.action) && [h5, h6, hN].includes(e.target));
    assert.deepEqual(rows.map((e) => [e.action, e.target, e.words]), [
      ['hall.create', h5, 'Hall 5'],
      ['hall.create', h6, 'Hall 6'],
      ['hall.create', hN, '(no name)'],
      ['stagewatch.propose', h5, 'asked the operator: a message (' + ASK.length + ' characters) for the speaker\'s screen — proposal ' + asked.proposal.id],
      ['stagewatch.send', h5, 'a line (27 characters) on the speaker\'s screen, sent now'],
      ['stagewatch.send', h5, 'a line (' + SENT_TOO.length + ' characters) on the speaker\'s screen, sent now'],
      ['stagewatch.propose', h5, 'asked the operator: a message (' + Array.from(ASK_TOO).length + ' characters) for the speaker\'s screen — proposal ' + asked2.proposal.id],
      ['message.remove', h5, 'a message by Kim (text)'],
      ['message.remove', h5, 'a message by Kim (file)'],
      ['room.lock', h5, 'roles locked (2 seats kept)'],
      ['seat.role', h5, 'Kim: research → observer'],
      ['room.lock', h5, 'roles unlocked'],
      ['room.link', h5, 'Kim may forward into Hall 3'],
      ['room.link', h5, 'Kim may forward into another hall'],
      ['room.unlink', h5, 'Kim may no longer forward into Hall 3'],
      ['minutes.post', h5, 'minutes posted (pinned)'],
      ['room.reset', h5, 'messages and documents cleared, 1 file removed'],
      ['seat.kick', h5, 'Kim sent out (1 page closed)'],
    ]);
    const ana = { t: 'account', id: setup.body.account.id, name: 'ana' };
    assert.deepEqual(rows.filter((e) => !e.action.startsWith('stagewatch.')).map((e) => e.actor), Array(14).fill(ana), 'the admin is named on every room control');
    assert.deepEqual(rows.filter((e) => e.action === 'stagewatch.propose').map((e) => e.actor), [{ t: 'code', id: kj.uid, name: 'Kim' }, { t: 'code', id: lj.uid, name: 'Lee' }], 'and each guest who asked the desk');
    assert.deepEqual(rows.filter((e) => e.action === 'stagewatch.send').map((e) => e.actor), [{ t: 'code', id: kj.uid, name: 'Kim' }, { t: 'code', id: mj.uid, name: 'Mo' }], 'and each guest who sent a line');
    assert.ok(entries.some((e) => e.action === 'seat.kick' && e.target === '' && e.words === 'a page in no hall sent out (1 page closed)' && e.actor.name === 'ana'), 'a page in no hall: no hall named');
    assert.ok(!rows.some((e) => e.words.includes(hall) || e.words.includes(hN)), 'a linked hall is named by its name, never by the code its guests join with');
    const raw = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
    for (const never of [SAID, ASK, ASK_TOO, MINUTES, SENT, SENT_TOO, 'Two minutes', '(time)', 'Mic 4', 'capex', 'Capex', 'board-pack-q3', 'kept-notes', pack.url, kept.url, kj.uploadToken, 'swk_hall5_node_key_00001' /* secret-scan: fixture */, '\u202e', '\u2066']) {
      assert.ok(!raw.includes(never), 'not in the audit log: ' + JSON.stringify(never));
    }
  });

  await t.test('a hall closed while Stagewatch answers a send, or its desk a proposal, keeps nothing of either; each is still its row', async () => {
    const sw = await fakeStagewatch({ name: 'Hall 7 timer' });
    stagewatches.push(sw);
    const ctl = await connect(base, admin); sockets.push(ctl);
    const h7 = (await emit(ctl, 'admin:createRoom', { name: 'Hall 7' })).code;
    assert.ok((await emit(ctl, 'hall:configure', { code: h7, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall7_node_key_00001' /* secret-scan: fixture */ })).ok);
    await until(() => sw.connected, 6000, 'Stagewatch linked');
    const pia = await connect(base); sockets.push(pia);
    assert.ok((await emit(pia, 'join', { roomCode: h7, name: 'Pia', role: 'research' })).ok);
    await until(async () => (await emit(pia, 'stage:targets', {})).canPropose, 8000, 'the desk');
    const rooms = path.join(srv.dataDir, 'rooms');
    const files = () => fs.readdirSync(rooms).filter((f) => f.startsWith(h7));
    assert.ok(files().length > 0, 'an open hall has its files');
    sw.messageDelayMs = 800;
    sw.proposalDelayMs = 800;
    // Neither answer reaches the page: the hall's pages are sent home when it closes.
    emit(pia, 'stage:send', { text: 'Closing words' });
    emit(pia, 'stage:propose', { text: 'Closing question', destination: 'speaker' });
    await until(() => sw.requests.some((q) => q.url.startsWith('/api/message/')) && sw.requests.some((q) => q.method === 'POST' && q.url === '/api/proposals'), 3000, 'both on their way');
    assert.ok((await emit(ctl, 'admin:deleteRoom', { roomCode: h7 })).ok);
    assert.deepEqual(files(), [], 'closed: its files are gone');
    const rowsOf = async () => (await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie: admin })).body.entries
      .filter((e) => e.target === h7 && e.action.startsWith('stagewatch.')).map((e) => e.action).sort();
    await until(async () => (await rowsOf()).length === 2, 6000, 'both answered');
    sw.messageDelayMs = 0;
    sw.proposalDelayMs = 0;
    assert.deepEqual(await rowsOf(), ['stagewatch.propose', 'stagewatch.send'], 'each reached Stagewatch, and is its row');
    assert.deepEqual(files(), [], 'and no line of either was written back into the closed hall\'s folder');
  });

  await t.test('the audit log has it all, the chain verifies, and nothing secret is in it', async () => {
    const a = await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie: admin });
    assert.equal(a.status, 200);
    const actions = a.body.entries.map((e) => e.action);
    for (const want of ['setup', 'hall.create', 'user.create', 'login', 'login.fail', 'password.change', 'login.refused', 'user.update',
      'stagewatch.propose', 'stagewatch.send', 'message.remove', 'room.lock', 'seat.role', 'room.link', 'room.unlink', 'minutes.post', 'room.reset', 'seat.kick']) assert.ok(actions.includes(want), want);
    const v = await api(base, 'GET', '/api/audit/verify', undefined, { cookie: admin });
    assert.equal(v.body.ok, true);
    const raw = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
    for (const secret of ['the green room kettle', 'mixing desk on stage left', 'clipboard and coffee', tech.body.password, TOKEN]) assert.ok(!raw.includes(secret), 'no secret in the audit log');
    assert.equal((await api(base, 'GET', '/api/audit', undefined, { cookie: pat })).status, 200, 'a project manager reads it too');
  });

  await t.test('a holder of users.manage cannot reset, sign out, change or remove an account that manages accounts or settings', async () => {
    const una = await api(base, 'POST', '/api/users', { username: 'una', name: 'Una Rota', role: 'manager', grant: ['users.manage'], password: 'the rota on the wall' }, { cookie: admin });
    const sid = await api(base, 'POST', '/api/users', { username: 'sid', name: 'Sid Patch', role: 'manager', grant: ['settings.manage'], password: 'the patch bay labels' }, { cookie: admin });
    const stu = await api(base, 'POST', '/api/users', { username: 'stu', name: 'Stu Foyer', role: 'staff', password: 'the coffee urn table' }, { cookie: admin });
    assert.ok(una.body.ok && sid.body.ok && stu.body.ok, JSON.stringify([una.body, sid.body, stu.body]));
    const u = await signIn('una', 'the rota on the wall');
    const list = (await api(base, 'GET', '/api/users', undefined, { cookie: u })).body.users;
    const row = (name) => list.find((x) => x.username === name);
    assert.match(row('sid').locked, /Only an admin/, 'the page is told, and offers no Edit');
    assert.match(row('ana').locked, /Only an admin/);
    assert.equal(row('stu').locked, '');
    for (const [method, tail, body] of [['POST', '/password', {}], ['POST', '/signout', {}], ['PATCH', '', { name: 'Sid' }], ['DELETE', '', undefined]]) {
      const r = await api(base, method, '/api/users/' + sid.body.user.id + tail, body, { cookie: u });
      assert.equal(r.status, 403, method + ' /api/users/:id' + tail + ' ' + JSON.stringify(r.body));
    }
    assert.equal((await api(base, 'POST', '/api/users/' + setup.body.account.id + '/signout', {}, { cookie: u })).status, 403, 'nor sign an admin out');
    assert.equal((await api(base, 'POST', '/api/users/' + stu.body.user.id + '/password', {}, { cookie: u })).status, 200, 'an account without those rights is still theirs to reset');
    const sidNow = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.find((x) => x.username === 'sid');
    assert.deepEqual([sidNow.mustChange, sidNow.disabled, sidNow.name], [false, false, 'Sid Patch'], 'sid keeps their own password, account and name');
  });
});

// ---------------------------------------------------------------- managing accounts, end to end
test('two first admins sent at once make one; two accounts of one name sent at once make one, and its one-time password signs in', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const pw = 'purple stage lights';
  const [a, b] = await Promise.all([setupAdmin(base, { name: 'Ada Lovelace', username: 'ada', password: pw }), setupAdmin(base, { name: 'Ben Admin', username: 'ben', password: pw })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const admin = (a.status === 200 ? a : b).cookie;
  assert.equal((await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.length, 1, 'one first admin');
  const body = { username: 'sam', name: 'Sam Crew', role: 'staff' };
  const [x, y] = await Promise.all([api(base, 'POST', '/api/users', body, { cookie: admin }), api(base, 'POST', '/api/users', body, { cookie: admin })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  const [made, refused] = x.status === 200 ? [x, y] : [y, x];
  assert.equal(refused.body.error, 'That username is taken.');
  const list = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users;
  assert.equal(list.filter((u) => u.username === 'sam').length, 1);
  assert.equal((await api(base, 'POST', '/api/auth/login', { username: 'sam', password: made.body.password })).status, 200, 'the one-time password shown signs in');
  await until(() => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8')).users.length === 2, 3000, 'accounts.json written');
  assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8')).users.filter((u) => u.username === 'sam').length, 1);
});

test('a one-hall tech given users.manage manages only accounts within its own rights and halls, and the page is told what it may give and no hall it does not hold', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  t.after(() => stopServer(srv.child));
  const admin = (await setupAdmin(base)).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  const made = {};
  for (const [username, extra] of [['lee', { role: 'tech', halls: [hallA], grant: ['users.manage'], password: 'freelancer desk lead' }], ['pat', { role: 'manager', password: 'clipboard and coffee' }], ['cam', { role: 'tech', halls: [hallA], password: 'cable reel orange' }], ['bob', { role: 'tech', halls: [hallB], password: 'sound check one two' }]]) {
    const r = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase(), ...extra }, { cookie: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    made[username] = r.body.user;
  }
  const lee = (await api(base, 'POST', '/api/auth/login', { username: 'lee', password: 'freelancer desk lead' })).cookie;
  for (const [method, url, body, why] of [
    ['POST', '/api/users', { username: 'lee2', name: 'Second Lee', role: 'manager' }, 'a project manager, whose one-time password it would be handed'],
    ['PATCH', '/api/users/' + made.cam.id, { allHalls: true }, 'every hall'],
    ['PATCH', '/api/users/' + made.cam.id, { halls: [hallA, hallB] }, 'a hall it is not in'],
    ['POST', '/api/users/' + made.pat.id + '/password', {}, 'a richer account\'s new password'],
    ['POST', '/api/users/' + made.pat.id + '/signout', {}, 'a richer account signed out'],
  ]) {
    const r = await api(base, method, url, body, { cookie: lee });
    assert.equal(r.status, 403, why + ': ' + r.status + ' ' + JSON.stringify(r.body));
    assert.match(r.body.error, /hold yourself/);
  }
  assert.equal((await api(base, 'POST', '/api/users', { username: 'fred', name: 'Fred', role: 'staff', halls: [hallA] }, { cookie: lee })).status, 200, 'staff in its own hall');
  const view = (await api(base, 'GET', '/api/users', undefined, { cookie: lee })).body;
  const row = (name) => view.users.find((u) => u.username === name);
  assert.match(row('pat').locked, /hold yourself/, 'the page shows the richer account locked');
  assert.equal(row('cam').locked, '');
  assert.deepEqual(view.giveable, { admin: false, caps: ['display.control', 'hall.files', 'hall.post', 'hall.view', 'stage.send', 'stage.show', 'stage.web'], allHalls: false, halls: [hallA] });
  // The page groups the rights as the server does, and the admin page is told who may give rooms there (Members…): an
  // account the Accounts routes let manage accounts, never one they refuse, nor the laptop's token, which is no account.
  assert.deepEqual(view.capGroups, JSON.parse(JSON.stringify(rbac.CAP_GROUPS)));
  const pat = (await api(base, 'POST', '/api/auth/login', { username: 'pat', password: 'clipboard and coffee' })).cookie;
  const tokenAdmin = (await api(base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const told = {};
  for (const [who, cookie] of [['lee', lee], ['pat', pat], ['ana', admin], ['token', tokenAdmin], ['nobody', undefined]]) told[who] = (await api(base, 'GET', '/api/admin/me', undefined, { cookie })).body.manageUsers;
  assert.deepEqual(told, { lee: true, pat: false, ana: true, token: false, nobody: false });
  // A hall's code is a guest's way in: the one-hall manager is told no code of a hall it does not hold — not on the list
  // it ticks halls from, not in another person's row (bob's hall B is a count on a Locked row), nowhere in the reply.
  assert.deepEqual(view.halls.map((h) => h.code), [hallA]);
  assert.ok(!JSON.stringify(view).includes(hallB), 'hall B\'s code is nowhere in a one-hall manager\'s list');
  assert.deepEqual([row('bob').halls, row('bob').rights.halls, row('bob').otherHalls], [[], [], 1]);
  assert.match(row('bob').locked, /hold yourself/);
  assert.deepEqual([row('cam').halls, row('cam').otherHalls], [[hallA], 0], 'a row it may edit keeps every hall it has');
  const forAdmin = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body;
  const now = forAdmin.users;
  assert.deepEqual(forAdmin.halls.map((h) => h.code).sort(), [hallA, hallB].sort(), 'the admin still sees every hall');
  assert.deepEqual(now.find((u) => u.username === 'bob').halls, [hallB]);
  assert.deepEqual(now.filter((u) => u.username === 'pat').map((u) => [u.mustChange, u.rights.allHalls]), [[false, true]], 'pat keeps their own password');
  assert.equal(now.find((u) => u.username === 'cam').rights.allHalls, false);

  // One's own row: the page sends a new name alone (users.js), and that is taken; the rest of one's own account is
  // another admin's to change, so a body that names it is refused whatever it says.
  for (const [who, cookie] of [['lee', lee], ['ana', admin]]) {
    const own = (await api(base, 'GET', '/api/users', undefined, { cookie })).body.users.find((u) => u.username === who);
    assert.equal(own.locked, '', who + ': the page offers Edit on one\'s own row');
    const renamed = await api(base, 'PATCH', '/api/users/' + own.id, { name: own.name + ' Ops' }, { cookie });
    assert.deepEqual([renamed.status, renamed.body.changed], [200, ['name']], who + ': ' + JSON.stringify(renamed.body));
    for (const body of [{ name: own.name, role: own.role, halls: own.halls, grant: [], revoke: [] }, { disabled: true }]) {
      const r = await api(base, 'PATCH', '/api/users/' + own.id, body, { cookie });
      assert.deepEqual([r.status, r.body.error], [403, 'Nobody changes their own role, rights or halls — ask another admin.'], who + ' ' + JSON.stringify(body));
    }
    assert.equal((await api(base, 'DELETE', '/api/users/' + own.id, undefined, { cookie })).status, 403, who + ': nor removes themselves');
  }
});

test('an account made or changed is answered as the list\'s row for whoever asked: the admin\'s whole, a manager\'s told only its own halls and rooms, its devices counted as they are now', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const PW = 'mixing desk on stage left';
  const admin = (await setupAdmin(base)).cookie;
  const hall = async (name) => (await api(base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const hallA = await hall('Hall A');
  const ctl = await connect(base, admin); sockets.push(ctl);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const listed = async (cookie, username) => (await api(base, 'GET', '/api/users', undefined, { cookie })).body.users.find((u) => u.username === username);
  // Made by the admin: the answer is the admin's row of it.
  const made = await api(base, 'POST', '/api/users', { username: 'kim', name: 'Kim Tech', role: 'tech', halls: [hallA], rooms: [LEGAL], password: PW }, { cookie: admin });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual(made.body.user, await listed(admin, 'kim'), 'made: the admin\'s row');
  assert.deepEqual([made.body.user.sessions, made.body.user.locked], [0, '']);
  // Changed by the admin: the row as it is now, its clock among it.
  const clocked = await api(base, 'PATCH', '/api/users/' + made.body.user.id, { clock: { show: 'stage', locked: true } }, { cookie: admin });
  assert.deepEqual([clocked.status, clocked.body.changed, clocked.body.user.clock], [200, ['clock'], { show: 'stage', locked: true }]);
  assert.deepEqual(clocked.body.user, await listed(admin, 'kim'), 'changed: the admin\'s row');
  // A manager of Hall A given Legal: its answer is its own row, told only what it reaches, its counts with it.
  const lee = await api(base, 'POST', '/api/users', { username: 'lee', name: 'Lee Lead', role: 'tech', halls: [hallA], rooms: [LEGAL], grant: ['users.manage'], password: PW }, { cookie: admin });
  const leeIn = (await api(base, 'POST', '/api/auth/login', { username: 'lee', password: PW })).cookie;
  assert.ok(leeIn, 'lee signs in');
  const sam = await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Stage', role: 'staff', halls: [hallA], password: PW }, { cookie: leeIn });
  assert.equal(sam.status, 200, JSON.stringify(sam.body));
  assert.deepEqual(sam.body.user, await listed(leeIn, 'sam'), 'made by a manager: its row');
  const viewed = await api(base, 'PATCH', '/api/users/' + sam.body.user.id, { view: 'simple' }, { cookie: leeIn });
  assert.deepEqual([viewed.status, viewed.body.changed], [200, ['view']]);
  assert.deepEqual(viewed.body.user, await listed(leeIn, 'sam'), 'changed by a manager: its row');
  assert.deepEqual([viewed.body.user.otherRooms, viewed.body.user.otherHalls], [0, 0], 'the counts a manager\'s row carries');
  assert.ok(lee.body.user.id);
  // Turned off with a device signed in: answered with no device, as the list now counts it.
  const samIn = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: PW }, { headers: { 'cf-connecting-ip': '198.51.100.8' } })).cookie;
  assert.ok(samIn, 'sam signs in');
  assert.equal((await listed(admin, 'sam')).sessions, 1);
  const off = await api(base, 'PATCH', '/api/users/' + sam.body.user.id, { disabled: true }, { cookie: admin });
  assert.deepEqual([off.status, off.body.user.disabled, off.body.user.sessions], [200, true, 0]);
  assert.deepEqual(off.body.user, await listed(admin, 'sam'), 'turned off: the admin\'s row');
  // An empty change (a Save that changed nothing) is answered the row as it stands, nothing changed and no row audited.
  const before = wordsOfUpdate(srv.dataDir).length;
  const none = await api(base, 'PATCH', '/api/users/' + made.body.user.id, {}, { cookie: admin });
  assert.deepEqual([none.status, none.body.changed], [200, []]);
  assert.deepEqual(none.body.user, await listed(admin, 'kim'), 'nothing changed: the row as it stands');
  assert.equal(wordsOfUpdate(srv.dataDir).length, before, 'no audit row');
});
/** The audit rows of account changes, as written. */
const wordsOfUpdate = (dataDir) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'user.update');

test('saving an account unchanged changes nothing; the device count is what still signs in', async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await setupAdmin(base)).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const users = {};
  for (const username of ['sam', 'kim', 'lee']) {
    const r = await api(base, 'POST', '/api/users', { username, name: username.toUpperCase() + ' Tech', role: 'tech', halls: [hall], grant: ['nodes.control'], password: 'mixing desk on stage left' }, { cookie: admin });
    users[username] = r.body.user;
  }
  // Two devices each, from addresses of their own (one sign-in allowance each).
  let n = 0;
  const signIn = async (username) => {
    const r = await api(base, 'POST', '/api/auth/login', { username, password: 'mixing desk on stage left' }, { headers: { 'cf-connecting-ip': '198.51.100.' + (++n) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.cookie;
  };
  const sam = await signIn('sam');
  for (const u of ['sam', 'kim', 'kim', 'lee', 'lee']) await signIn(u);
  const devices = async () => Object.fromEntries((await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.filter((u) => users[u.username]).map((u) => [u.username, u.sessions]));
  assert.deepEqual(await devices(), { kim: 2, lee: 2, sam: 2 });

  await t.test('an untouched editor\'s Save: nothing changed, no reconnect, no audit row; a real change still reconnects', async () => {
    const s = await connect(base, sam); sockets.push(s);
    assert.ok((await emit(s, 'join', { roomCode: hall, as: 'account' })).ok);
    let told = false;
    s.on('account:changed', () => { told = true; });
    const view = (await api(base, 'GET', '/api/users', undefined, { cookie: admin })).body;
    const u = view.users.find((x) => x.username === 'sam');
    const role = view.roles.find((r) => r.id === u.role);
    // What users.js formChange() sends for an editor opened and saved untouched.
    const body = { name: u.name, role: u.role, halls: u.halls, grant: u.grant.filter((c) => !role.caps.includes(c)), revoke: u.revoke.filter((c) => role.caps.includes(c)) };
    if (u.allHalls !== null || u.rights.allHalls !== role.allHalls) body.allHalls = u.rights.allHalls;
    const audits = async () => (await api(base, 'GET', '/api/audit?limit=500', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'user.update').length;
    const before = await audits();
    const r = await api(base, 'PATCH', '/api/users/' + u.id, body, { cookie: admin });
    assert.deepEqual(r.body.changed, []);
    await wait(300);
    assert.equal(told, false, 'the open page is not told to reload');
    assert.equal(s.connected, true);
    assert.equal(await audits(), before, 'no audit row for a change that did not happen');
    const gone = once(s, 'disconnect');
    const renamed = await api(base, 'PATCH', '/api/users/' + u.id, { ...body, name: 'Sam Tech-Lead' }, { cookie: admin });
    assert.deepEqual(renamed.body.changed, ['name']);
    await gone;
    assert.equal(told, true);
    assert.equal(await audits(), before + 1);
  });

  await t.test('signed out everywhere, turned off, a new password: no devices left on the list', async () => {
    assert.equal((await api(base, 'POST', '/api/users/' + users.sam.id + '/signout', {}, { cookie: admin })).status, 200);
    assert.equal((await api(base, 'PATCH', '/api/users/' + users.kim.id, { disabled: true }, { cookie: admin })).status, 200);
    assert.equal((await api(base, 'POST', '/api/users/' + users.lee.id + '/password', {}, { cookie: admin })).status, 200);
    assert.deepEqual(await devices(), { kim: 0, lee: 0, sam: 0 });
  });
});

// ---------------------------------------------------------------- side rooms, On stage halls and a chat view
/** An account's row on the Accounts page as the admin is told it. */
const rowOf = async (base, cookie, username) => (await api(base, 'GET', '/api/users', undefined, { cookie })).body.users.find((u) => u.username === username);
/** The words of each audit row of `action`, by its target, as written. */
const wordsOf = (dataDir, action) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words]);

test('an account is given side rooms, On stage halls and a chat view: each entry read by type and known, given only by whoever holds it, never set on oneself, kept across a restart, an untouched Save no change, each audited in words', async (t) => {
  let srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const PW = 'clipboard and coffee';
  let admin = (await setupAdmin(srv.base)).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const MEDIA = (await emit(ctl, 'room:create', { hall: hallB, name: 'Media' })).key;
  assert.ok(LEGAL && MEDIA);
  const post = (body, cookie = admin) => api(srv.base, 'POST', '/api/users', { name: body.username, password: PW, ...body }, { cookie });
  const patch = (id, body, cookie = admin) => api(srv.base, 'PATCH', '/api/users/' + id, body, { cookie });

  // Made with them by the admin: kept as given (upper case, once) and told back last; the row's words name each room by its
  // name, its hall's and its key, the On stage halls by key, and the view.
  const kim = await post({ username: 'kim', role: 'tech', halls: [hallA], rooms: [LEGAL.toLowerCase(), LEGAL], board: [hallA], view: 'simple' });
  assert.equal(kim.status, 200, JSON.stringify(kim.body));
  const u = kim.body.user;
  assert.deepEqual([u.rooms, u.board, u.view, u.rights.rooms, u.rights.board, Object.keys(u).slice(-7)], [[LEGAL], [hallA], 'simple', [LEGAL], [hallA], ['rooms', 'board', 'view', 'clock', 'onStage', 'sessions', 'locked']]);
  assert.deepEqual(wordsOf(srv.dataDir, 'user.create').find((r) => r[0] === 'kim'), ['kim', 'role tech, halls ' + hallA + '; rooms → Legal (Hall A) ' + LEGAL + '; board → On stage in ' + hallA + '; view → simple']);
  const plain = await post({ username: 'sam', role: 'staff', halls: [hallA] });
  assert.deepEqual([plain.body.user.rooms, plain.body.user.board, plain.body.user.view, wordsOf(srv.dataDir, 'user.create').find((r) => r[0] === 'sam')[1]], [[], [], '', 'role staff, halls ' + hallA], 'none of the three, none said');

  // Each list is a list of names and each new entry a side room or a hall that is here; a view is one of the three. Refused
  // with words, never a 500 (a value that is no name included), and nothing made.
  const VIEW_WORDS = 'A chat view is By seat (\'\'), Simple (\'simple\') or Full (\'full\').';
  for (const [body, error] of [
    [{ rooms: [{ toString: 1 }] }, 'An account\'s rooms are a list of their keys.'],
    [{ halls: [{ toString: 1 }] }, 'An account\'s halls are a list of their keys.'],
    [{ board: hallA }, 'An account\'s On stage halls are a list of their keys.'],
    [{ rooms: ['NOSUCH12'] }, 'No such room: NOSUCH12.'],
    [{ rooms: [hallA] }, hallA + ' is a hall: its Main room comes with the hall.'],
    [{ board: ['NOHALL1'] }, 'No such hall: NOHALL1.'],
    [{ board: [LEGAL] }, 'No such hall: ' + LEGAL + '.'],
    [{ role: 'viewer', halls: [hallA], board: [hallA] }, 'Reads only in Hall A: On stage needs Send messages.'],
    [{ halls: [], board: [hallA] }, 'On stage in Hall A needs Hall A too: give its Main room with the seat.'],
    [{ view: 'tiny' }, VIEW_WORDS], [{ view: null }, VIEW_WORDS],
  ]) assert.deepEqual(await post({ username: 'eve', role: 'staff', ...body }).then((r) => [r.status, r.body]), [400, { ok: false, error }], JSON.stringify(body));
  assert.equal(await rowOf(srv.base, admin, 'eve'), undefined, 'none made');
  assert.deepEqual(await patch(u.id, { rooms: ['NOSUCH12'], view: 'full' }).then((r) => [r.status, r.body.error]), [400, 'No such room: NOSUCH12.'], 'a change refused changes nothing');
  assert.equal((await rowOf(srv.base, admin, 'kim')).view, 'simple');

  // Who gives which: a one-hall lead who manages accounts gives a side room only once it is given it itself, and no other;
  // seats On stage only in its own hall; sets a view; and sets none of the three on itself.
  const lee = (await post({ username: 'lee', role: 'tech', halls: [hallA], grant: ['users.manage'] })).body.user;
  const cam = (await post({ username: 'cam', role: 'tech', halls: [hallA] })).body.user;
  assert.equal((await post({ username: 'mo', role: 'staff', halls: [], rooms: [MEDIA] })).status, 200);
  const leeIn = (await api(srv.base, 'POST', '/api/auth/login', { username: 'lee', password: PW })).cookie;
  for (const body of [{ rooms: [LEGAL] }, { board: [hallB] }]) {
    assert.deepEqual(await patch(cam.id, body, leeIn).then((r) => [r.status, r.body.error]), [403, 'You may only give rights and halls you hold yourself.'], JSON.stringify(body));
  }
  assert.deepEqual((await patch(cam.id, { board: [hallA], view: 'full' }, leeIn)).body.changed, ['board', 'view']);
  assert.deepEqual((await patch(lee.id, { rooms: [LEGAL] })).body.changed, ['rooms'], 'the admin gives Lee Legal');
  assert.deepEqual((await patch(cam.id, { rooms: [LEGAL] }, leeIn)).body.changed, ['rooms']);
  assert.match((await patch(cam.id, { rooms: [LEGAL, MEDIA] }, leeIn)).body.error, /hold yourself/);
  for (const body of [{ rooms: [] }, { board: [] }, { view: 'full' }]) {
    assert.deepEqual(await patch(lee.id, body, leeIn).then((r) => [r.status, r.body.error]), [403, 'Nobody changes their own role, rights or halls — ask another admin.'], JSON.stringify(body));
  }
  assert.deepEqual(wordsOf(srv.dataDir, 'user.update').filter((r) => r[0] === 'cam'), [['cam', 'board → On stage in ' + hallA + '; view → full'], ['cam', 'rooms → Legal (Hall A) ' + LEGAL]]);

  // What the Accounts page is told: the admin every room, by key with its name and its hall's; Lee the room it holds, and on
  // each row only those (Mo's Media is a count, and Mo a Locked row), so neither Media's key nor Hall B's is anywhere.
  const forAdmin = (await api(srv.base, 'GET', '/api/users', undefined, { cookie: admin })).body;
  assert.deepEqual([forAdmin.rooms, forAdmin.giveableRooms], [[{ key: LEGAL, name: 'Legal', hall: hallA, hallName: 'Hall A' }, { key: MEDIA, name: 'Media', hall: hallB, hallName: 'Hall B' }], { all: true, rooms: [] }]);
  assert.deepEqual([forAdmin.users.find((x) => x.username === 'mo').rooms, 'otherRooms' in forAdmin.users.find((x) => x.username === 'mo')], [[MEDIA], false]);
  const forLee = (await api(srv.base, 'GET', '/api/users', undefined, { cookie: leeIn })).body;
  assert.deepEqual([forLee.rooms, forLee.giveableRooms], [[{ key: LEGAL, name: 'Legal', hall: hallA, hallName: 'Hall A' }], { all: false, rooms: [LEGAL] }]);
  const moRow = forLee.users.find((x) => x.username === 'mo');
  assert.deepEqual([moRow.rooms, moRow.rights.rooms, moRow.otherRooms], [[], [], 1]);
  assert.match(moRow.locked, /hold yourself/);
  assert.deepEqual([forLee.users.find((x) => x.username === 'cam').rooms, forLee.users.find((x) => x.username === 'cam').otherRooms], [[LEGAL], 0], 'a row it may edit keeps every room it has');
  assert.ok(!JSON.stringify(forLee).includes(MEDIA) && !JSON.stringify(forLee).includes(hallB), 'Media and Hall B are nowhere in Lee\'s list');

  // Kept across a restart; a key an account still holds that no room has now (written while the server was stopped, as a
  // room that comes back at the next start keeps it) passes an untouched Save, and a Save sends it back changing nothing.
  await stopServer(srv.child);
  resealStore(srv.dataDir, 'accounts', (stored) => {
    const kimStored = stored.users.find((x) => x.username === 'kim');
    assert.deepEqual([kimStored.rooms, kimStored.board, kimStored.view], [[LEGAL], [hallA], 'simple'], 'on disk');
    kimStored.rooms = [LEGAL, 'GONE2345'];
  });
  srv = await startServer({ AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  admin = (await api(srv.base, 'POST', '/api/auth/login', { username: 'ana', password: 'the green room kettle' })).cookie;
  const row = await rowOf(srv.base, admin, 'kim');
  assert.deepEqual([row.rooms, row.board, row.view], [[LEGAL, 'GONE2345'], [hallA], 'simple']);
  const untouched = { name: row.name, role: row.role, halls: row.halls, allHalls: row.allHalls, grant: row.grant, revoke: row.revoke, disabled: row.disabled, rooms: row.rooms, board: row.board, view: row.view };
  const updates = wordsOf(srv.dataDir, 'user.update').length;
  assert.deepEqual(await patch(row.id, untouched).then((r) => [r.status, r.body.changed]), [200, []]);
  assert.deepEqual(await patch(row.id, { ...untouched, rooms: [...row.rooms, 'GONE6789'] }).then((r) => [r.status, r.body.error]), [400, 'No such room: GONE6789.'], 'a new one is refused');
  assert.equal(wordsOf(srv.dataDir, 'user.update').length, updates, 'no row for a change that did not happen');
  // A seat held passes a Save whatever the rights now: Kim made a Viewer keeps Hall A's On stage hall as stored, and the
  // page is told no seat there (it would sit as an observer); a seat given now is refused, in words, until it can post.
  assert.deepEqual(await patch(row.id, { ...untouched, role: 'viewer' }).then((r) => [r.status, r.body.changed, r.body.user.board, r.body.user.rights.board]), [200, ['role'], [hallA], []]);
  assert.deepEqual(await patch(row.id, { board: [] }).then((r) => [r.status, r.body.changed]), [200, ['board']]);
  assert.deepEqual(await patch(row.id, { board: [hallA] }).then((r) => [r.status, r.body.error]), [400, 'Reads only in Hall A: On stage needs Send messages.']);
  assert.deepEqual(await patch(row.id, { role: 'tech', board: [hallA] }).then((r) => [r.status, r.body.changed, r.body.user.rights.board]), [200, ['role', 'board'], [hallA]], 'a role that posts, given with it');
});

test('a chat view changed alone is said to the account\'s pages in a room, live, as the view each draws now, and ends none; any other change still ends them', async (t) => {
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const PW = 'clipboard and coffee';
  const admin = (await setupAdmin(srv.base)).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const LEGAL = (await emit(ctl, 'room:create', { hall: hallA, name: 'Legal' })).key;
  const made = {};
  for (const [username, extra] of [['kim', { role: 'tech', halls: [hallA], rooms: [LEGAL], board: [hallA] }], ['cam', { role: 'tech', halls: [hallA] }]]) {
    made[username] = (await api(srv.base, 'POST', '/api/users', { username, name: username, password: PW, ...extra }, { cookie: admin })).body.user;
  }
  const signIn = async (username) => (await api(srv.base, 'POST', '/api/auth/login', { username, password: PW })).cookie;
  const [kim, cam] = [await signIn('kim'), await signIn('cam')];
  // Every frame each page hears, from its first packet.
  const heard = new Map();
  const page = async (who, cookie) => {
    const frames = [];
    const s = await connect(srv.base, cookie);
    s.onAny((ev, x) => frames.push([ev, x]));
    s.on('disconnect', () => frames.push(['disconnect']));
    sockets.push(s);
    heard.set(who, frames);
    return s;
  };
  const kimMain = await page('kimMain', kim);
  assert.equal((await emit(kimMain, 'join', { roomCode: hallA, as: 'account' })).role, 'board');
  const kimSide = await page('kimSide', kim);
  assert.equal((await emit(kimSide, 'join', { roomCode: LEGAL, as: 'account' })).role, 'research');
  const kimBoard = await page('kimBoard', kim);
  assert.ok((await emit(kimBoard, 'board:watch', {})).ok);
  const camMain = await page('camMain', cam);
  assert.equal((await emit(camMain, 'join', { roomCode: hallA, as: 'account' })).role, 'research');
  const views = (who) => heard.get(who).filter(([ev]) => ev === 'view').map(([, x]) => x);
  const ended = (who) => heard.get(who).some(([ev]) => ev === 'account:changed' || ev === 'disconnect');
  const patch = (body) => api(srv.base, 'PATCH', '/api/users/' + made.kim.id, body, { cookie: admin });

  // Full: each page of Kim's in a room is told it, On stage and backstage alike; none is closed, the halls board (no room)
  // is told nothing, and nobody else is.
  assert.deepEqual((await patch({ view: 'full' })).body.changed, ['view']);
  await until(() => views('kimMain').length === 1 && views('kimSide').length === 1, 3000, 'the view said');
  // By seat: the simple view On stage, the full view backstage.
  assert.deepEqual((await patch({ view: '' })).body.changed, ['view']);
  await until(() => views('kimMain').length === 2 && views('kimSide').length === 2, 3000, 'the view said again');
  await wait(300);
  assert.deepEqual([views('kimMain'), views('kimSide'), views('kimBoard'), views('camMain')], [[{ view: 'full' }, { view: 'simple' }], [{ view: 'full' }, { view: 'full' }], [], []]);
  assert.deepEqual(['kimMain', 'kimSide', 'kimBoard', 'camMain'].map(ended), [false, false, false, false], 'no page told to reload, none closed');
  assert.ok(kimMain.connected && kimSide.connected && kimBoard.connected);
  assert.deepEqual(wordsOf(srv.dataDir, 'user.update').filter((r) => r[0] === 'kim'), [['kim', 'view → full'], ['kim', 'view → by seat']]);
  // The same view again is no change: nothing said.
  assert.deepEqual((await patch({ view: '' })).body.changed, []);
  // A view changed with anything else is a change of rights: every page of Kim's is told and closed.
  const gone = Promise.all([kimMain, kimSide, kimBoard].map((s) => once(s, 'disconnect')));
  assert.deepEqual((await patch({ view: 'simple', halls: [hallA, hallB] })).body.changed, ['halls', 'view']);
  await gone;
  assert.deepEqual(['kimMain', 'kimSide', 'kimBoard', 'camMain'].map(ended), [true, true, true, false]);
  assert.equal(views('kimMain').length, 2, 'nor told the view: its next connection reads it');
});

test('an account given a side room alone joins it and not its hall, and no frame, list or answer it is given carries its hall\'s key or guest code, its hall\'s Stagewatch sent to and proposed to from that room included; /api/halls and the halls board list each watcher\'s rooms, with the seat each would join with', async (t) => {
  const srv = await startServer();
  // Hall A's own Stagewatch, with a show desk.
  const sw = await fakeStagewatch({ name: 'Legal timer' });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const PW = 'clipboard and coffee';
  const admin = (await setupAdmin(srv.base)).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const [hallA, hallB] = [await hall('Hall A'), await hall('Hall B')];
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const asked = async (verb, args) => { for (;;) { const r = await emit(ctl, verb, args); if (!r.busy) return r; await wait(250); } };
  const LEGAL = (await asked('room:create', { hall: hallA, name: 'Legal' })).key;
  const MEDIA = (await asked('room:create', { hall: hallA, name: 'Media' })).key;
  const PRESS = (await asked('room:create', { hall: hallB, name: 'Press' })).key;
  const made = {};
  for (const [username, extra] of [['lou', { role: 'staff', halls: [], rooms: [LEGAL] }], ['tom', { role: 'tech', halls: [hallA], rooms: [LEGAL] }],
    ['kim', { role: 'tech', halls: [hallA], board: [hallA], rooms: [PRESS] }], ['vic', { role: 'viewer', halls: [hallA] }], ['pat', { role: 'manager' }]]) {
    made[username] = (await api(srv.base, 'POST', '/api/users', { username, name: username, password: PW, ...extra }, { cookie: admin })).body.user;
    assert.ok(made[username], username);
  }
  const signIn = async (username) => {
    let r;
    for (let i = 0; i < 4; i++) {
      r = await api(srv.base, 'POST', '/api/auth/login', { username, password: PW });
      if (r.status !== 429 || r.body.busy) break;
      await wait(2100);
    }
    assert.equal(r.status, 200, username + ' signs in: ' + JSON.stringify(r.body));
    return r.cookie;
  };
  const cookies = {};
  for (const who of ['lou', 'tom', 'kim', 'vic', 'pat']) cookies[who] = await signIn(who);
  const halls = async (who) => (await api(srv.base, 'GET', '/api/halls', undefined, { cookie: cookies[who] })).body;
  const boardOf = async (who) => { const s = await connect(srv.base, cookies[who]); sockets.push(s); return (await emit(s, 'board:watch', {})).board; };
  const side = (x) => [x.key, x.name, x.seat, x.codeOn];

  // Tom, of Hall A and given Legal: Hall A's row, seated backstage, Legal under it; no room he is not given. Kim, On stage
  // in Hall A and given Press of Hall B, which she does not see: Hall A's row seated On stage, Press apart, by its hall's
  // name. A Viewer of Hall A, its row read only and no room. A project manager of every hall: every hall, no side room.
  const tomHalls = await halls('tom');
  assert.deepEqual(tomHalls.halls.map((h) => [h.code, h.seat, h.rooms.map(side)]), [[hallA, 'research', [[LEGAL, 'Legal', 'research', false]]]]);
  assert.deepEqual(tomHalls.rooms, []);
  const kimHalls = await halls('kim');
  assert.deepEqual(kimHalls.halls.map((h) => [h.code, h.seat, h.guestCode, h.rooms]), [[hallA, 'board', '', []]], 'On stage: no code, no room of Hall A');
  assert.deepEqual(kimHalls.rooms.map((x) => [x.key, x.name, x.hallName, x.seat, typeof x.guestCode]), [[PRESS, 'Press', 'Hall B', 'research', 'string']]);
  assert.ok(!JSON.stringify(kimHalls).includes(hallB), 'Hall B\'s key is nowhere in Kim\'s list');
  assert.deepEqual((await halls('vic')).halls.map((h) => [h.code, h.seat, h.guestCode, h.rooms]), [[hallA, 'observer', '', []]], 'a Viewer is not told Main\'s code');
  assert.deepEqual((await halls('pat')).halls.map((h) => [h.code, h.seat, h.rooms]).sort(), [[hallA, 'research', []], [hallB, 'research', []]].sort());
  // The halls board: the same rooms per watcher, each row's beside the row every watcher shares, and the rooms of a hall
  // the watcher does not see apart (`yourRooms`).
  const tomBoard = await boardOf('tom');
  assert.deepEqual([tomBoard.halls.map((h) => [h.code, h.rooms.map(side)]), tomBoard.yourRooms], [[[hallA, [[LEGAL, 'Legal', 'research', false]]]], []]);
  const kimBoard = await boardOf('kim');
  assert.deepEqual([kimBoard.halls.map((h) => [h.code, h.rooms]), kimBoard.yourRooms.map((x) => [x.key, x.hallName, x.seat])], [[[hallA, []]], [[PRESS, 'Hall B', 'research']]]);
  const anaBoard = await boardOf('pat');
  assert.deepEqual(anaBoard.yourRooms, [], 'every hall seen: nothing apart');
  const theAdmin = (await emit(ctl, 'board:watch', {})).board;
  assert.deepEqual(theAdmin.halls.map((h) => [h.code, h.rooms.map((x) => [x.key, x.seat])]).sort(), [[hallA, [[LEGAL, 'research'], [MEDIA, 'research']]], [hallB, [[PRESS, 'research']]]].sort(), 'the admin: every room');

  // Lou, given Legal and no hall: Legal is listed apart, by its hall's name; Lou joins it backstage and is refused Hall A.
  // Hall A's key (its Main room's address) and its guest code, renewed so the two differ, are in nothing Lou is given:
  // the join's answer, /api/halls, the board's answer, every frame Lou's pages hear while Hall A and Legal are busy, and
  // Legal's history and missed changes when Lou's page comes back. Hall A follows its own Stagewatch, whose link is named
  // by Hall A's key ('hall:<key>').
  assert.ok((await asked('hall:configure', { code: hallA, stagewatchUrl: sw.url, stagewatchKey: 'swk_legal_node_key_00001' /* secret-scan: fixture */ })).ok);
  const NEW = (await asked('room:update', { code: hallA, newCode: true })).guestCode;
  assert.ok(/^[A-Z2-9]{6}$/.test(NEW) && NEW !== hallA);
  const frames = [];
  const listen = async () => { const s = await connect(srv.base, cookies.lou); s.onAny((ev, x) => frames.push([ev, x])); sockets.push(s); return s; };
  const louPage = await listen();
  const louJoin = await emit(louPage, 'join', { roomCode: LEGAL, as: 'account' });
  assert.deepEqual([louJoin.ok, louJoin.role, louJoin.main], [true, 'research', false]);
  assert.deepEqual(await emit(await listen(), 'join', { roomCode: hallA, as: 'account' }), { ok: false, error: 'Your account has no access to this hall — ask an admin.' });
  const louBoardPage = await listen();
  const louBoard = (await emit(louBoardPage, 'board:watch', {})).board;
  assert.deepEqual([louBoard.halls, louBoard.yourRooms.map((x) => [x.key, x.name, x.hallName, x.seat])], [[], [[LEGAL, 'Legal', 'Hall A', 'research']]]);
  const louHalls = await halls('lou');
  assert.deepEqual([louHalls.halls, louHalls.rooms.map((x) => [x.key, x.name, x.hallName, x.seat])], [[], [[LEGAL, 'Legal', 'Hall A', 'research']]]);
  // Hall A busy: a guest's message and help request in its Main room, the admin's in Legal, Legal's code switched on and
  // Hall A renamed (the board and Legal's page are told).
  const gus = await connect(srv.base); sockets.push(gus);
  assert.ok((await emit(gus, 'join', { roomCode: NEW, name: 'Gus', role: 'research' })).ok);
  assert.ok((await emit(gus, 'message', { type: 'text', text: 'Main room only' })).ok);
  assert.ok((await emit(gus, 'message', { type: 'help', category: 'Sound', text: 'mic 2' })).ok);
  const anaLegal = await connect(srv.base, admin); sockets.push(anaLegal);
  assert.ok((await emit(anaLegal, 'join', { roomCode: LEGAL, as: 'account' })).ok);
  assert.ok((await emit(anaLegal, 'message', { type: 'text', text: 'For the lawyers' })).ok);
  assert.ok((await asked('room:update', { code: LEGAL, codeOn: true })).ok);
  assert.ok((await asked('hall:configure', { code: hallA, name: 'Hall A, renamed' })).ok);
  // From Legal, the admin sends a line to Hall A's speaker's screen and asks its show desk for another; the speaker
  // acknowledges the first. Each is written into Legal on a record that names Hall A's link, which the record keeps.
  await until(async () => { const x = await emit(anaLegal, 'stage:targets', {}); return x.canSend && x.canPropose; }, 15000, 'Legal able to send to Hall A\'s Stagewatch and ask its desk');
  const sent = await emit(anaLegal, 'stage:send', { text: 'Five minutes' });
  assert.deepEqual([sent.ok, sent.messageId], [true, 77], JSON.stringify(sent));
  const proposed = await emit(anaLegal, 'stage:propose', { text: 'Thank the lawyers', destination: 'speaker' });
  assert.ok(proposed.ok && proposed.proposal.id && !Object.hasOwn(proposed.proposal, 'link'), JSON.stringify(proposed));
  sw.frame({ messageId: 77, messageAck: 'done', messageAckBy: 'Speaker A' });
  await until(() => frames.some(([ev, x]) => ev === 'stageAck' && x && x.stage && x.stage.ack === 'done'), 4000, 'the acknowledgement heard in Legal');
  const records = (await emit(ctl, 'admin:watchRoom', { roomCode: LEGAL })).messages;
  assert.deepEqual([records.filter((m) => m.stage).map((m) => m.stage.link), records.filter((m) => m.proposal).map((m) => m.proposal.link)], [['hall:' + hallA], ['hall:' + hallA]], 'the records keep the link they went to');
  await until(() => frames.some(([ev, x]) => ev === 'board' && JSON.stringify(x).includes('Hall A, renamed')), 4000, 'Lou\'s board drawn again');
  await until(() => frames.some(([ev, x]) => ev === 'message' && x && x.text === 'For the lawyers'), 4000, 'Legal heard');
  await wait(300);
  // Lou's page comes back: with the changes it missed (a resume), and afresh (the whole history).
  const louResumed = await emit(louPage, 'join', { roomCode: LEGAL, as: 'account', since: louJoin.seq });
  assert.ok(louResumed.ok && louResumed.ops.some((op) => op.o === 'add' && op.m.stage) && louResumed.ops.some((op) => op.o === 'upd' && op.f.stage) && louResumed.ops.some((op) => op.o === 'add' && op.m.proposal), 'the send, its acknowledgement and the proposal missed');
  const louAfresh = await emit(await listen(), 'join', { roomCode: LEGAL, as: 'account' });
  assert.ok(louAfresh.ok && louAfresh.history.some((m) => m.stage && m.stage.ack === 'done') && louAfresh.history.some((m) => m.proposal), 'the send and the proposal in the history');
  const given = JSON.stringify([louJoin, louBoard, louHalls, frames, await halls('lou'), louResumed, louAfresh]);
  assert.ok(!given.includes(hallA) && !given.includes(NEW), 'no Main key or code: ' + [hallA, NEW].filter((c) => given.includes(c)));
  assert.ok(!given.includes('Main room only') && !given.includes('mic 2'), 'nor Hall A\'s messages or its help request');
  assert.ok(given.includes('For the lawyers') && given.includes('Hall A, renamed') && given.includes('Five minutes') && given.includes('Thank the lawyers'), 'the frames were read');
});

// ---------------------------------------------------------------- saves that fail
test('a change to accounts.json that cannot be written is retried until it lands, and health names it meanwhile', async (t) => {
  let srv = await startServer();
  const { dataDir } = srv;
  t.after(async () => { await stopServer(srv.child); });
  const file = path.join(dataDir, 'accounts.json');
  const setup = await setupAdmin(srv.base);
  const admin = setup.cookie;
  const bob = await api(srv.base, 'POST', '/api/users', { username: 'bob', name: 'Bob Staff', role: 'staff', password: 'clipboard and coffee' }, { cookie: admin });
  assert.equal(bob.status, 200, JSON.stringify(bob.body));
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"bob"'), 3000, 'bob on disk');

  // Another program holds accounts.json for a moment: the rename over it fails.
  fs.renameSync(file, file + '.held');
  fs.mkdirSync(file);
  const off = await api(srv.base, 'PATCH', '/api/users/' + bob.body.user.id, { disabled: true }, { cookie: admin });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await wait(300);
  const during = (await api(srv.base, 'GET', '/api/health')).body.saves;
  assert.ok(during.stores && during.stores.accounts && during.stores.accounts.error, 'health names the store that could not be saved: ' + JSON.stringify(during));
  assert.equal(during.stores.settings.error, null, 'and only that one');
  fs.rmdirSync(file);
  fs.renameSync(file + '.held', file);
  await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.username === 'bob').disabled === true, 4000, 'the retry to write bob turned off');
  assert.equal((await api(srv.base, 'GET', '/api/health')).body.saves.stores.accounts.error, null, 'health clears once it is written');

  await stopServer(srv.child);
  srv = await startServer({ AGM_DATA_DIR: dataDir });
  const login = await api(srv.base, 'POST', '/api/auth/login', { username: 'bob', password: 'clipboard and coffee' });
  assert.equal(login.status, 401, 'a turned-off account stays off after a restart');
  assert.equal(login.body.cookie, undefined);
  assert.match(login.body.error, /don't match/, 'in the words a wrong password gets: a refusal never says the password was right');
});

// The check's walk in a real server, counted as work by test/audit-preload.js, never timed: how long a slice takes is the
// machine's (a busy one stretches it), how much a slice does is the check's. The loop turns after every 1,000 lines
// (lib/audit.js's SLICE), which is when a page asking meanwhile is read and answered; the log is read off the loop; and
// six clicks that come while a walk runs share it. The preload's hold has the walk wait to read until all six have come,
// so they share it however the machine schedules them; the check at start, or one after it, is answered first.
for (const seed of ['plain', 'keyed']) test('six quick clicks on Check the log of a full-size ' + seed + ' log share one walk, which reads the log off the event loop and lets the loop turn every 1,000 lines', async (t) => {
  const dataDir = tmp('agm-e2e-');
  const n = 56_000;
  if (seed === 'plain') fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), chainOf(n));
  else {
    // The server's own key and records, as a laptop that wrote this log keeps them.
    const keyDir = dataDir + '-keys';
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, 'machine.key'), FIXTURE_KEY.toString('base64'));
    keyedChainOf(n, { file: path.join(dataDir, 'audit.jsonl'), records: path.join(keyDir, 'audit') });
  }
  const meter = auditMeter(dataDir);
  const srv = await startServer({ AGM_DATA_DIR: dataDir, ...meter.env });
  t.after(async () => { await stopServer(srv.child); meter.remove(); });
  const admin = (await setupAdmin(srv.base)).cookie;
  const first = await api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin });
  assert.equal(first.status, 200, 'the check at start, or one after it, answered: no walk runs now');
  const checks = await Promise.all(Array.from({ length: 6 }, () => api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin, headers: { 'x-agm-test-hold': '6' } })));
  for (const c of checks) {
    assert.equal(c.status, 200);
    assert.equal(c.body.mark, seed === 'plain' ? 'unvouched' : 'intact', JSON.stringify(c.body).slice(0, 400));
    assert.equal(c.body.ok, seed === 'keyed');
    assert.ok(c.body.entries > n, 'the seeded chain and the server\'s own entries: ' + c.body.entries);
  }
  const w = meter.seen();
  const said = JSON.stringify(w);
  assert.deepEqual([w.held, w.opened], [6, 'all came'], 'all six clicks came while the walk waited to read: ' + said);
  assert.deepEqual([w.walks, w.atOnce], [1, 1], 'six clicks, one walk, and never two at once: ' + said);
  assert.equal(w.lines, checks[0].body.entries, 'the walk read each line of the chain once: ' + said);
  assert.ok(w.most.lines > 0 && w.most.lines <= 1000, 'at most 1,000 lines between two turns of the loop: ' + said);
  assert.ok(w.turns >= Math.ceil(w.lines / 1000), 'the loop turned at least once per 1,000 lines: ' + said);
  assert.deepEqual([w.syncReads, w.asyncReads > 0, w.reading], [0, true, 1], 'the log read off the event loop one read at a time, never with a synchronous read: ' + said);
});
