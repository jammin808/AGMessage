'use strict';
/**
 * Who may do what, in which hall (pure, tested in test/accounts.test.js).
 *
 * A capability is one thing a person may do. A role is a preset of capabilities and of hall access; an admin may grant
 * or revoke single capabilities on one account and choose its halls. Deny by default: an unknown capability, a disabled
 * account, or a hall outside the account's list is refused.
 *
 * Hall-scoped capabilities need access to that hall as well; global ones (managing halls, accounts, settings, reading
 * the audit log) do not. Two rules keep the rights from escalating: only an admin may make an admin or hand out
 * users.manage or settings.manage, and nobody changes their own role or rights.
 */

const CAPS = Object.freeze({
  'hall.view': 'See a hall: its messages, files, countdown and displays',
  'hall.post': 'Send messages, replies, action prompts and help requests',
  'hall.files': 'Share files and push them to a hall',
  'display.control': 'Change what a hall\'s displays show',
  'display.manage': 'Create, rename, move and revoke displays',
  'stage.send': 'Send to Stagewatch: the speaker\'s screen, or to the operator to pass on',
  'nodes.control': 'Propose or send commands to Patterns and PlayMap',
  'halls.manage': 'Create halls and set them up (Stagewatch link, holding image, codes)',
  'users.manage': 'Create accounts and set their roles, halls and rights',
  'settings.manage': 'App settings: AI key, HTTPS, the tunnel, the show network',
  'audit.read': 'Read the audit log',
});

const HALL_SCOPED = new Set(['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'nodes.control']);
const ADMIN_ONLY = new Set(['users.manage', 'settings.manage']);

const ROLES = Object.freeze({
  admin: { label: 'Admin', allHalls: true, caps: Object.keys(CAPS), words: 'Everything, every hall: accounts, rights and settings' },
  manager: {
    label: 'Project manager', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'display.manage', 'stage.send', 'nodes.control', 'halls.manage', 'audit.read'],
    words: 'Every hall: messages, files, displays, Stagewatch, show network; sets halls up',
  },
  senior: {
    label: 'Senior tech', allHalls: true,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send', 'nodes.control'],
    words: 'Every hall: messages, files, displays, Stagewatch, show network',
  },
  tech: {
    label: 'Tech', allHalls: false,
    caps: ['hall.view', 'hall.post', 'hall.files', 'display.control', 'stage.send'],
    words: 'Their halls: messages, files, displays, Stagewatch',
  },
  staff: { label: 'Staff', allHalls: false, caps: ['hall.view', 'hall.post', 'hall.files'], words: 'Their halls: messages and files' },
  viewer: { label: 'Viewer', allHalls: false, caps: ['hall.view'], words: 'Their halls: read only' },
});

const isCap = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CAPS, c);
const isRole = (r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(ROLES, r);

/** An account's effective rights: {caps:Set, allHalls, halls:Set}. Nothing for a missing or disabled account. */
function effective(account) {
  if (!account || account.disabled || !isRole(account.role)) return { caps: new Set(), allHalls: false, halls: new Set() };
  const role = ROLES[account.role];
  const caps = new Set(role.caps);
  for (const c of Array.isArray(account.grant) ? account.grant : []) if (isCap(c)) caps.add(c);
  for (const c of Array.isArray(account.revoke) ? account.revoke : []) caps.delete(c);
  const allHalls = typeof account.allHalls === 'boolean' ? account.allHalls : role.allHalls;
  return { caps, allHalls, halls: new Set(Array.isArray(account.halls) ? account.halls : []) };
}

/** May this account do `cap` (in `hall`, for a hall-scoped capability)? */
function can(account, cap, hall) {
  if (!isCap(cap)) return false;
  const e = effective(account);
  if (!e.caps.has(cap)) return false;
  if (!HALL_SCOPED.has(cap)) return true;
  if (hall === undefined || hall === null || hall === '') return e.allHalls || e.halls.size > 0;
  return e.allHalls || e.halls.has(hall);
}

/** May the account see this hall at all? */
const seesHall = (account, hall) => can(account, 'hall.view', hall);

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
  for (const c of [].concat(change.grant || [])) {
    if (!isCap(c)) return 'Unknown right: ' + String(c).slice(0, 40);
    if (ADMIN_ONLY.has(c) && !actorIsAdmin) return 'Only an admin may grant ' + c + '.';
  }
  for (const c of [].concat(change.revoke || [])) if (!isCap(c)) return 'Unknown right: ' + String(c).slice(0, 40);
  // The last admin who can still sign in stays one: a venue is never left with nobody able to manage it.
  if (target && target.role === 'admin' && !target.disabled && activeAdmins <= 1 && ((change.role && change.role !== 'admin') || change.disabled === true)) {
    return 'This is the last active admin: make another admin first.';
  }
  return null;
}

/** The room view an account joins a hall with: crew (can post) or observer (read only). */
const roomRoleFor = (account, hall) => (can(account, 'hall.post', hall) ? 'research' : 'observer');

/** What a page needs to know about an account's rights (no secrets). */
function rightsView(account) {
  const e = effective(account);
  return { role: account ? account.role : '', roleLabel: account && isRole(account.role) ? ROLES[account.role].label : '', caps: Array.from(e.caps).sort(), allHalls: e.allHalls, halls: Array.from(e.halls).sort() };
}

module.exports = { CAPS, ROLES, HALL_SCOPED, ADMIN_ONLY, isCap, isRole, effective, can, seesHall, mayChange, roomRoleFor, rightsView };
