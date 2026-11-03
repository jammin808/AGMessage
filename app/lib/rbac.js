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
 * rights and halls, and hands out only those; and nobody changes their own role or rights.
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
  'display.control': 'Change what a hall\'s screens show',
  'display.manage': 'Create, rename, move and revoke screens',
  'stage.send': 'Send to Stagewatch: the speaker\'s screen, or to the operator to pass on',
  'nodes.control': 'Propose commands to Patterns and PlayMap (to the show desk)',
  'halls.manage': 'Create halls and set them up (Stagewatch link, holding image, codes)',
  'users.manage': 'Create accounts and set their roles, halls and rights',
  'settings.manage': 'App settings: AI key, HTTPS, the tunnel, the show network',
  'audit.read': 'Read the audit log',
  'audit.export': 'Export the whole audit log, signed, to check on another computer (an account with it signs in through the tunnel only when admins may)',
});

const HALL_SCOPED = new Set(['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'nodes.control']);
// The rights a room holds, not its hall: what a person reads, writes and shares there. Answered by canIn alone.
const ROOM_SCOPED = new Set(['hall.view', 'hall.post', 'hall.files']);
// The rights only an admin hands out. An account holding one is admin-level: changed only by an admin, and kept off the
// tunnel unless admins may sign in there. audit.export is one: an export carries every entry off the laptop.
const ADMIN_ONLY = new Set(['users.manage', 'settings.manage', 'audit.export']);

const ROLES = Object.freeze({
  admin: { label: 'Admin', allHalls: true, caps: Object.keys(CAPS), words: 'Everything, every hall: accounts, rights and settings' },
  manager: {
    label: 'Project manager', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'nodes.control', 'halls.manage', 'audit.read'],
    words: 'Every hall: messages, files, screens, Stagewatch, show network; sets halls up',
  },
  senior: {
    label: 'Senior tech', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send', 'nodes.control'],
    words: 'Every hall: messages, files, screens, Stagewatch, show network',
  },
  tech: {
    label: 'Tech', allHalls: false,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send'],
    words: 'Their halls: messages, files, screens, Stagewatch',
  },
  staff: { label: 'Staff', allHalls: false, caps: ['hall.view', 'hall.post', 'hall.files'], words: 'Their halls: messages and files' },
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
 * Whether `actor` may make `change` to `target` (an account; null when creating). Returns null when allowed, else the
 * reason in words. `change` holds only the fields being set: role, grant, revoke, disabled, halls, allHalls.
 */
function mayChange(actor, target, change, { activeAdmins = 1 } = {}) {
  if (!can(actor, 'users.manage')) return 'You may not manage accounts.';
  const actorIsAdmin = actor.role === 'admin';
  if (target && target.id === actor.id && ('role' in change || 'grant' in change || 'revoke' in change || 'disabled' in change || 'allHalls' in change || 'halls' in change)) {
    return 'Nobody changes their own role, rights or halls — ask another admin.';
  }
  if ('role' in change && !isRole(change.role)) return 'Unknown role.';
  if ((change.role === 'admin' || (target && target.role === 'admin')) && !actorIsAdmin) return 'Only an admin may make or change an admin.';
  // An account that may manage accounts or settings, or export the audit log, is changed (reset, signed out, removed,
  // re-enabled) by an admin only: otherwise one holder of users.manage could take over another's settings.manage. Read
  // with the account enabled, so a disabled holder is not re-enabled by a non-admin either. Changing one's own name is not this.
  if (target && target.id !== actor.id && !actorIsAdmin && holdsAdminOnly(target)) return 'Only an admin may change an account that manages accounts or settings, or exports the audit log.';
  for (const c of [].concat(change.grant || [])) {
    if (!isCap(c)) return 'Unknown right: ' + String(c).slice(0, 40);
    if (ADMIN_ONLY.has(c) && !actorIsAdmin) return 'Only an admin may grant ' + c + '.';
  }
  for (const c of [].concat(change.revoke || [])) if (!isCap(c)) return 'Unknown right: ' + String(c).slice(0, 40);
  // A holder of users.manage who is not an admin reaches no further through the accounts it manages than it reaches
  // itself: it neither makes nor widens an account past its own rights and halls, nor resets, signs out or removes one
  // that holds more (a reset hands it that account's one-time password).
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

/** Whether `account`, enabled, would hold a right or reach a hall that `actor` does not. */
function exceeds(account, actor) {
  const mine = effective(actor);
  const theirs = effective({ ...account, disabled: false });
  for (const c of theirs.caps) if (!mine.caps.has(c)) return true;
  if (mine.allHalls) return false;
  if (theirs.allHalls) return true;
  for (const h of theirs.halls) if (!mine.halls.has(h)) return true;
  return false;
}

/**
 * The account as it would be after `change` (a new one when `target` is null), read as Accounts.create and update
 * apply it: a role only when it is one, halls and revokes only as lists, a grant as whatever it names (never fewer rights
 * than would be stored), and an allHalls that is not true or false meaning the role's own.
 */
function afterChange(target, change) {
  const a = { ...(target || { role: 'staff', halls: [], grant: [], revoke: [] }) };
  if (isRole(change.role)) a.role = change.role;
  if (Array.isArray(change.halls)) a.halls = change.halls.map((h) => (typeof h === 'string' ? h.toUpperCase() : ''));
  if ('grant' in change) a.grant = [].concat(change.grant || []);
  if (Array.isArray(change.revoke)) a.revoke = change.revoke;
  if ('allHalls' in change) { if (typeof change.allHalls === 'boolean') a.allHalls = change.allHalls; else delete a.allHalls; }
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

/** What a page needs to know about an account's rights (no secrets). */
function rightsView(account) {
  const e = effective(account);
  return { role: account ? account.role : '', roleLabel: account && isRole(account.role) ? ROLES[account.role].label : '', caps: Array.from(e.caps).sort(), allHalls: e.allHalls, halls: Array.from(e.halls).sort() };
}

module.exports = {
  CAPS, ROLES, HALL_SCOPED, ROOM_SCOPED, ADMIN_ONLY, SEAT_LIMITS, LINKED_CAPS, GUEST_CAPS, GUEST_CAPS_SIDE, isCap, isRole, effective,
  can, canIn, seesHall, seesRoom, holdsAdminOnly, mayChange, giveable, seatAllows, guestCaps, roomRoleFor, answersHelp, rightsView,
};
