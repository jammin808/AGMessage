'use strict';
/**
 * Who may do what, in which hall (pure, tested in test/accounts.test.js).
 *
 * A capability is one thing a person may do. A role is a preset of capabilities and of hall access; an admin may grant
 * or revoke single capabilities on one account and choose its halls. Deny by default: an unknown capability, a disabled
 * account, or a hall outside the account's list is refused.
 *
 * Hall-scoped capabilities need access to that hall as well; global ones (managing halls, accounts, settings, reading
 * the audit log) do not. Three rules keep the rights from escalating: only an admin may make an admin or hand out
 * users.manage, settings.manage or audit.export; an account that is not an admin manages only accounts within its own
 * rights, halls and side rooms, and hands out only those; and nobody changes their own role, rights, halls, rooms, On
 * stage halls or chat view.
 *
 * Rights in a room. Seeing, posting and sharing files (ROOM_SCOPED) are a room's: in a hall's Main room by the account's
 * halls, as before, and in a side room (Legal, Media) only by the account's own `rooms`, or by the admin role, which is
 * a member of every room. Only `canIn(account, cap, scope)` answers them, for a room named by its scope `{code, hall,
 * main}` (the store's `scopeOf`); `can()` asked one of them with a hall's code refuses it, so a room's question asked of
 * `can()` with a room's key fails closed, even for an account of every hall, whose halls never reach a side room. The
 * no-scope question ("in any hall at all?") still answers. A code guest's rights are its seat's, by the kind of room it
 * sits in (`guestCaps`).
 */

const CAPS = Object.freeze({
  'hall.view': 'See a hall: its messages, files, countdown and screens',
  'hall.post': 'Send messages, replies, action prompts and help requests',
  'hall.files': 'Share files and push them to a hall',
  'display.control': 'Change what a hall\'s screens and people\'s pages show',
  'display.manage': 'Create, rename, move and revoke screens',
  'stage.send': 'Send to Stagewatch: the speaker\'s screen, or to the operator to pass on',
  'stage.show': 'Show files, pages and quotes to the people on stage',
  'stage.web': 'Show web pages on people\'s pages (the Board\'s or one person\'s)',
  'nodes.control': 'Propose commands to Patterns and PlayMap (to the show desk)',
  'halls.manage': 'Create halls and their rooms, set them up (names, Stagewatch link, holding image) and hand out their guest codes',
  'users.manage': 'Create accounts and set their roles, halls and rights',
  'settings.manage': 'App settings: AI key, HTTPS, the tunnel, the show network',
  'audit.read': 'Read the audit log',
  'audit.export': 'Export the whole audit log, signed, to check on another computer (an account with it signs in through the tunnel only when admins may)',
});

/**
 * The rights as the Accounts page groups them, in CAPS's order within each: what a person does in a room, what it shows
 * or sends to the show (screens, Stagewatch, the show network), and what runs AGMessage itself. Every right is in exactly
 * one group (test/accounts.test.js), so a right added to CAPS is given its group in the same change.
 */
const CAP_GROUPS = Object.freeze([
  Object.freeze({ id: 'room', label: 'In the room', caps: Object.freeze(['hall.view', 'hall.post', 'hall.files']) }),
  Object.freeze({ id: 'show', label: 'Show', caps: Object.freeze(['display.control', 'display.manage', 'stage.send', 'stage.show', 'stage.web', 'nodes.control']) }),
  Object.freeze({ id: 'run', label: 'Run AGMessage', caps: Object.freeze(['halls.manage', 'users.manage', 'settings.manage', 'audit.read', 'audit.export']) }),
]);

const HALL_SCOPED = new Set(['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'stage.show', 'stage.web', 'nodes.control']);
// The rights a room holds, not its hall: what a person reads, writes and shares there. Answered by canIn alone.
const ROOM_SCOPED = new Set(['hall.view', 'hall.post', 'hall.files']);
// The rights only an admin hands out. An account holding one is admin-level: changed only by an admin, and kept off the
// tunnel unless admins may sign in there. audit.export is one: an export carries every entry off the laptop.
const ADMIN_ONLY = new Set(['users.manage', 'settings.manage', 'audit.export']);

const ROLES = Object.freeze({
  admin: { label: 'Admin', allHalls: true, caps: Object.keys(CAPS), words: 'Everything, every hall: accounts, rights and settings' },
  manager: {
    label: 'Project manager', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'stage.show', 'stage.web', 'nodes.control', 'halls.manage', 'audit.read'],
    words: 'Every hall: messages, files, screens, Stagewatch, show network; sets halls up',
  },
  senior: {
    label: 'Senior tech', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send', 'stage.show', 'stage.web', 'nodes.control'],
    words: 'Every hall: messages, files, screens, Stagewatch, show network',
  },
  tech: {
    label: 'Tech', allHalls: false,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send', 'stage.show', 'stage.web'],
    words: 'Their halls: messages, files, screens, Stagewatch',
  },
  staff: { label: 'Staff', allHalls: false, caps: ['hall.view', 'hall.post', 'hall.files', 'stage.show'], words: 'Their halls: messages and files, and what they show the people on stage' },
  viewer: { label: 'Viewer', allHalls: false, caps: ['hall.view'], words: 'Their halls: read only' },
});

const isCap = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CAPS, c);
const isRole = (r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(ROLES, r);

/** The keys a list an account holds names (its side rooms, its On stage halls); none when it is not a list. */
const keysOf = (list) => new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string' && k !== '') : []);

/**
 * An account's effective rights: {caps:Set, allHalls, halls:Set, rooms:Set, board:Set}. `rooms`: the side rooms it is
 * given; `board`: the halls in whose Main room it sits On stage. Nothing for a missing or disabled account.
 */
function effective(account) {
  if (!account || account.disabled || !isRole(account.role)) return { caps: new Set(), allHalls: false, halls: new Set(), rooms: new Set(), board: new Set() };
  const role = ROLES[account.role];
  const caps = new Set(role.caps);
  for (const c of Array.isArray(account.grant) ? account.grant : []) if (isCap(c)) caps.add(c);
  for (const c of Array.isArray(account.revoke) ? account.revoke : []) caps.delete(c);
  const allHalls = typeof account.allHalls === 'boolean' ? account.allHalls : role.allHalls;
  return { caps, allHalls, halls: new Set(Array.isArray(account.halls) ? account.halls : []), rooms: keysOf(account.rooms), board: keysOf(account.board) };
}

/** Whether the account, enabled, would hold a right only an admin may hand out (users.manage, settings.manage, audit.export). */
function holdsAdminOnly(account) {
  if (!account) return false;
  const caps = effective({ ...account, disabled: false }).caps;
  return [...ADMIN_ONLY].some((c) => caps.has(c));
}

/** Whether a question names no hall: "in any hall at all?". */
const noScope = (hall) => hall === undefined || hall === null || hall === '';

/** May this account do `cap` in `hall` by its rights and halls (in any hall at all, when none is named)? */
function hallCan(account, cap, hall) {
  if (!isCap(cap)) return false;
  const e = effective(account);
  if (!e.caps.has(cap)) return false;
  if (!HALL_SCOPED.has(cap)) return true;
  if (noScope(hall)) return e.allHalls || e.halls.size > 0;
  return typeof hall === 'string' && (e.allHalls || e.halls.has(hall));
}

/**
 * May this account do `cap` (in `hall`, for a hall-scoped capability)? The fence: a room's right (ROOM_SCOPED) asked with
 * a hall is refused, whatever the account holds, since a room's key asked here would read as a hall an account of every
 * hall reaches. Those are canIn's; asked with no hall ("in any hall at all?") they still answer.
 */
function can(account, cap, hall) {
  if (ROOM_SCOPED.has(cap) && !noScope(hall)) return false;
  return hallCan(account, cap, hall);
}

/** A room's scope read whole, or null: its key, its hall's, and whether it is that hall's Main room (its key the hall's). */
function readScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const { code, hall, main } = scope;
  if (typeof code !== 'string' || !code || typeof hall !== 'string' || !hall || typeof main !== 'boolean') return null;
  return main === (code === hall) ? { code, hall, main } : null;
}
/** A hall's Main room's scope, by the hall's key. */
const mainScope = (hall) => ({ code: hall, hall, main: true });

/**
 * May this account do `cap` in the room `scope` names ({code, hall, main}: the store's scopeOf)? A hall's right (its
 * screens, its Stagewatch, its show network) is its hall's, and every right in a Main room is its hall's, as before; in a
 * side room, seeing, posting and sharing files need the room in the account's own `rooms`, or the admin role: an account
 * of every hall reaches no side room by its halls. A scope that is not one (a string, a part missing, a Main room whose
 * key is not its hall's) answers no.
 */
function canIn(account, cap, scope) {
  const s = readScope(scope);
  if (!s) return false;
  if (!ROOM_SCOPED.has(cap) || s.main) return hallCan(account, cap, s.hall);
  const e = effective(account);
  return e.caps.has(cap) && (account.role === 'admin' || e.rooms.has(s.code));
}

/** May the account see this hall: its Main room, and its hall's own parts (its screens, its Stagewatch, its nodes)? */
const seesHall = (account, hall) => hallCan(account, 'hall.view', hall);
/** May the account see the room `scope` names (a hall's Main room by its halls, a side room by its own rooms)? */
const seesRoom = (account, scope) => canIn(account, 'hall.view', scope);

/**
 * What nobody sets on their own account: its role and rights, its halls, its side rooms and On stage halls (`rooms`,
 * `board`), and its chat view, which another person who manages accounts chooses for it.
 */
const NOT_ONES_OWN = Object.freeze(['role', 'grant', 'revoke', 'disabled', 'allHalls', 'halls', 'rooms', 'board', 'view']);
/** A right as a refusal names it: what was sent, when it is a name, cut short; never a value made into one. */
const rightWords = (c) => (typeof c === 'string' ? c.slice(0, 40) : 'one that is not a name');

/**
 * Whether `actor` may make `change` to `target` (an account; null when creating). Returns null when allowed, else the
 * reason in words. `change` holds only the fields being set: role, grant, revoke, disabled, halls, allHalls, rooms,
 * board, view.
 */
function mayChange(actor, target, change, { activeAdmins = 1 } = {}) {
  if (!can(actor, 'users.manage')) return 'You may not manage accounts.';
  const actorIsAdmin = actor.role === 'admin';
  if (target && target.id === actor.id && NOT_ONES_OWN.some((k) => k in change)) {
    return 'Nobody changes their own role, rights or halls — ask another admin.';
  }
  if ('role' in change && !isRole(change.role)) return 'Unknown role.';
  if ((change.role === 'admin' || (target && target.role === 'admin')) && !actorIsAdmin) return 'Only an admin may make or change an admin.';
  // An account that may manage accounts or settings, or export the audit log, is changed (reset, signed out, removed,
  // re-enabled) by an admin only: otherwise one holder of users.manage could take over another's settings.manage. Read
  // with the account enabled, so a disabled holder is not re-enabled by a non-admin either. Changing one's own name is not this.
  if (target && target.id !== actor.id && !actorIsAdmin && holdsAdminOnly(target)) return 'Only an admin may change an account that manages accounts or settings, or exports the audit log.';
  for (const c of [].concat(change.grant || [])) {
    if (!isCap(c)) return 'Unknown right: ' + rightWords(c);
    if (ADMIN_ONLY.has(c) && !actorIsAdmin) return 'Only an admin may grant ' + c + '.';
  }
  for (const c of [].concat(change.revoke || [])) if (!isCap(c)) return 'Unknown right: ' + rightWords(c);
  // A holder of users.manage who is not an admin reaches no further through the accounts it manages than it reaches
  // itself: it neither makes nor widens an account past its own rights, halls and side rooms, nor resets, signs out or
  // removes one that holds more (a reset hands it that account's one-time password).
  if (!actorIsAdmin) {
    if (target && target.id !== actor.id && exceeds(target, actor)) return 'You may only manage accounts whose rights and halls you hold yourself.';
    if (exceeds(afterChange(target, change), actor)) return 'You may only give rights and halls you hold yourself.';
  }
  // The last admin who can still sign in stays one: a venue is never left with nobody able to manage it.
  if (target && target.role === 'admin' && !target.disabled && activeAdmins <= 1 && ((change.role && change.role !== 'admin') || change.disabled === true)) {
    return 'This is the last active admin: make another admin first.';
  }
  return null;
}

/**
 * Whether `account`, enabled, would hold a right, reach a hall or a side room, or sit On stage in a hall that `actor`
 * does not reach. A side room is read before every hall is: an account of every hall reaches no side room by that, so it
 * gives only the rooms it is given itself (the admin role, a member of every room, gives any). An On stage hall is read
 * as a hall is.
 */
function exceeds(account, actor) {
  const mine = effective(actor);
  const theirs = effective({ ...account, disabled: false });
  for (const c of theirs.caps) if (!mine.caps.has(c)) return true;
  if (!(actor && actor.role === 'admin')) for (const k of theirs.rooms) if (!mine.rooms.has(k)) return true;
  if (mine.allHalls) return false;
  if (theirs.allHalls) return true;
  for (const h of theirs.halls) if (!mine.halls.has(h)) return true;
  for (const h of theirs.board) if (!mine.halls.has(h)) return true;
  return false;
}

/** A list of keys as the store reads it (upper case); anything that is not a name reads as none. */
const keysAsStored = (list) => list.map((k) => (typeof k === 'string' ? k.toUpperCase() : ''));

/**
 * The account as it would be after `change` (a new one when `target` is null), read as Accounts.create and update
 * apply it: a role only when it is one, halls, side rooms, On stage halls and revokes only as lists, a grant as whatever
 * it names (never fewer rights than would be stored), an allHalls that is not true or false meaning the role's own, and
 * a chat view as the value it is (it widens nothing).
 */
function afterChange(target, change) {
  const a = { ...(target || { role: 'staff', halls: [], grant: [], revoke: [] }) };
  if (isRole(change.role)) a.role = change.role;
  if (Array.isArray(change.halls)) a.halls = keysAsStored(change.halls);
  if (Array.isArray(change.rooms)) a.rooms = keysAsStored(change.rooms);
  if (Array.isArray(change.board)) a.board = keysAsStored(change.board);
  if ('grant' in change) a.grant = [].concat(change.grant || []);
  if (Array.isArray(change.revoke)) a.revoke = change.revoke;
  if ('allHalls' in change) { if (typeof change.allHalls === 'boolean') a.allHalls = change.allHalls; else delete a.allHalls; }
  if ('view' in change) a.view = change.view;
  return a;
}

/**
 * What `actor` may hand out on the Accounts page, so it offers no more than mayChange allows: {admin, caps, allHalls,
 * halls} (halls empty when allHalls). An admin gives everything; anyone else the rights and halls it holds, never
 * users.manage, settings.manage or audit.export.
 */
function giveable(actor) {
  const e = effective(actor);
  const admin = !!actor && actor.role === 'admin' && !actor.disabled;
  if (admin) return { admin: true, caps: Object.keys(CAPS), allHalls: true, halls: [] };
  return { admin: false, caps: Array.from(e.caps).filter((c) => !ADMIN_ONLY.has(c)).sort(), allHalls: e.allHalls, halls: e.allHalls ? [] : Array.from(e.halls).sort() };
}

/**
 * The side rooms `actor` may give on the Accounts page, so it offers no more than mayChange allows: {all, rooms}. An
 * admin gives every room (`all`, the list empty); anyone else only the rooms it is given itself, every hall's account
 * included (its halls reach no side room).
 */
function giveableRooms(actor) {
  const admin = !!actor && actor.role === 'admin' && !actor.disabled;
  return { all: admin, rooms: admin ? [] : Array.from(effective(actor).rooms).sort() };
}

/**
 * What a seat allows at all, whatever the rights behind it: an On stage seat reads and writes messages, and nothing else
 * (it shares no file, drives no screen, sends nothing to the stage or the show network). A seat with no limit here
 * (backstage, observer) is bounded by its rights alone. The admin seated On stage is held to it on that page too.
 */
const SEAT_LIMITS = Object.freeze({ board: Object.freeze(['hall.view', 'hall.post']) });
/** Whether a seat allows a right at all: only a seat with a limit narrows anything. */
const seatAllows = (seat, cap) => !Object.prototype.hasOwnProperty.call(SEAT_LIMITS, seat) || SEAT_LIMITS[seat].includes(cap);
/** What the admin's link (admin:linkRoom) lets a guest do in a hall where it has no seat: post and share files. */
const LINKED_CAPS = Object.freeze(['hall.view', 'hall.post', 'hall.files']);

/**
 * What a code guest's seat holds, by the kind of room it sits in. In a hall's Main room (GUEST_CAPS): backstage posts,
 * shares files and sends to Stagewatch; On stage posts (as its seat's limit, SEAT_LIMITS); an observer reads. In a side
 * room (GUEST_CAPS_SIDE): a Member (backstage) posts and shares files and sends nothing to a Stagewatch; an observer
 * reads; no seat there is On stage.
 */
const GUEST_CAPS = Object.freeze({
  research: Object.freeze(['hall.view', 'hall.post', 'hall.files', 'stage.send']),
  board: Object.freeze(['hall.view', 'hall.post']),
  observer: Object.freeze(['hall.view']),
});
const GUEST_CAPS_SIDE = Object.freeze({
  research: Object.freeze(['hall.view', 'hall.post', 'hall.files']),
  observer: Object.freeze(['hall.view']),
});
const NO_CAPS = Object.freeze([]);
/** A code guest's rights, by its seat and the kind of room it sits in (`'main'` or `'side'`); none for any other. */
function guestCaps(role, kind) {
  const table = kind === 'main' ? GUEST_CAPS : kind === 'side' ? GUEST_CAPS_SIDE : null;
  return table && typeof role === 'string' && Object.hasOwn(table, role) ? table[role] : NO_CAPS;
}

/**
 * The seat an account joins a room with, by its rights there: On stage (`board`) in a hall's Main room whose hall its
 * `board` lists, where it may post; backstage (`research`) wherever else it may post; else an observer (read only). A
 * hall's key given as a string is read as that hall's Main room.
 */
function roomRoleFor(account, scope) {
  const s = typeof scope === 'string' ? (scope ? mainScope(scope) : null) : readScope(scope);
  if (!s || !canIn(account, 'hall.post', s)) return 'observer';
  return s.main && effective(account).board.has(s.hall) ? 'board' : 'research';
}

/**
 * Whether an account answers the help requests of the room `scope` names as its crew (On my way, Resolved): it may post
 * there and does not sit On stage there, so a Board member answers none of that hall's, from any page (owner answer B1).
 * help:respond's account branch and the halls board's canRespond both read it, so the board never offers what the verb
 * refuses. A scope that is not one answers no.
 */
const answersHelp = (account, scope) => canIn(account, 'hall.post', scope) && roomRoleFor(account, scope) !== 'board';

/**
 * Whether an account is told a room's guest code (the code guests type, plan 1-§2.3): it sets halls up (`halls.manage`:
 * it hands codes out), or its own rights in that room already hold what the code gives a guest there (a side room's
 * Member: seeing, posting, sharing files; a Main room's backstage seat: those and the speaker's screen of its hall), and
 * in either case it does not sit On stage there (a Board account's tablet is not handed the code). So a Viewer, a Staff
 * account in a Main room and an account of every hall that is not given a side room are told none. A scope that is not
 * one answers no.
 */
function mayKnowCode(account, scope) {
  const s = readScope(scope);
  if (!s || !account || account.disabled || roomRoleFor(account, s) === 'board') return false;
  if (can(account, 'halls.manage')) return true;
  return (s.main ? GUEST_CAPS.research : GUEST_CAPS_SIDE.research).every((cap) => canIn(account, cap, s));
}

/**
 * The first hall a change newly seats an account On stage in (an entry of `change.board` the account does not hold
 * already) where the account as changed, enabled, would not sit On stage (roomRoleFor), and why: it does not reach the
 * hall (`'hall'`), or reaches it and may not post there (`'post'`); null when each one seats it. An entry already on the
 * account passes, so a Save that sends its On stage halls back as they are is never refused for one a change of role or
 * rights has since left reading only (it sits there as an observer, and rightsView's `board` leaves it out).
 */
function unseatedOnStage(target, change) {
  if (!Array.isArray(change.board)) return null;
  const after = { ...afterChange(target, change), disabled: false };
  const held = new Set(target && Array.isArray(target.board) ? target.board : []);
  const e = effective(after);
  for (const k of keysAsStored(change.board)) {
    if (!k || held.has(k) || roomRoleFor(after, k) === 'board') continue;
    return { hall: k, why: e.allHalls || e.halls.has(k) ? 'post' : 'hall' };
  }
  return null;
}

/**
 * What a page needs to know about an account's rights (no secrets): with its side rooms and its On stage halls last. Its
 * On stage halls are those it sits On stage in (roomRoleFor: it reaches the hall and may post there), so a page that
 * says "On stage" says the seat the account takes; an On stage hall kept on an account that reads only there is its
 * stored `board` alone.
 */
function rightsView(account) {
  const e = effective(account);
  return {
    role: account ? account.role : '', roleLabel: account && isRole(account.role) ? ROLES[account.role].label : '', caps: Array.from(e.caps).sort(), allHalls: e.allHalls, halls: Array.from(e.halls).sort(),
    rooms: Array.from(e.rooms).sort(), board: Array.from(e.board).filter((h) => roomRoleFor(account, h) === 'board').sort(),
  };
}

module.exports = {
  CAPS, CAP_GROUPS, ROLES, HALL_SCOPED, ROOM_SCOPED, ADMIN_ONLY, SEAT_LIMITS, LINKED_CAPS, GUEST_CAPS, GUEST_CAPS_SIDE, isCap, isRole, effective,
  can, canIn, seesHall, seesRoom, holdsAdminOnly, mayChange, unseatedOnStage, giveable, giveableRooms, seatAllows, guestCaps, roomRoleFor, answersHelp, mayKnowCode, rightsView,
};
