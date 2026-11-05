'use strict';
/**
 * The busy line (pure: the clock passed in): one line of counts that says how live this AGMessage is, read before it is
 * stopped. Busy is activity in the last WINDOW_MS (a message, input on a seated page, a take changed, a help request) or
 * a countdown running now; presence is not activity, so seats and screens open and quiet are counted apart and never make
 * it busy. The line holds counts and nothing else (KEYS): no name, code, token or path ever rides in it, so any reader
 * may be given it, and what another program answers in its place chooses words only, never what is done.
 *
 *   WINDOW_MS  the window activity is counted over: 10 minutes
 *   KEYS       the line's counts, in their order:
 *                active      pages active in the window: a person's page in a hall (`pageKey`, the hall's code and the
 *                            person's uid, so the same person back on a new socket is the same page) that gave input
 *                            (a verb of INPUT from a seated page: an answer, a reaction, a take, a help request, an
 *                            ask of the AI), or whose message the hall holds from the window (`fromMessages`: a
 *                            message by anyone, the admin's support view and the minutes too, and one written before
 *                            a restart, which the hall kept; the system's own lines never)
 *                takes       screens whose take changed in the window
 *                help        help requests raised in the window
 *                countdowns  Stagewatch countdowns running now
 *                seats       pages seated in a hall now that are not active
 *                screens     screens a browser holds now
 *                sockets     every socket open now: pages, screens and the admin's
 *   INPUT      the socket verbs that are a person's input on a page: each changes something, or asks for a person
 *   READS      the verbs a page sends by itself (its join, reads and syncs) and the events no page sends: never input
 *   pageKey    a page's key: its hall's code and its person's uid (held in memory, never in the line)
 *   Activity   the pages that gave input, by key, each kept for the window, oldest first, at most ACTIVITY_MAX
 *   fromMessages  what a hall's messages say of the window: the pages they make active, and its help requests
 *   line       counts made into a line: each key a whole number, nothing else kept
 *   read       a line another program answered, read by type: the counts, or null for anything that is not one
 *   isBusy     whether a line is busy
 *   words      a line in words: its activity when busy ("3 pages active, a countdown running"), else what is open
 */

const WINDOW_MS = 10 * 60_000;
/**
 * The most pages Activity holds, the oldest input let go first: a page is kept by a join's uid, which a page that names
 * none is given new, so a flood of joins that each send one input holds no more than this. A show's halls seat hundreds;
 * a line that reaches it is busy whatever is let go.
 */
const ACTIVITY_MAX = 10_000;
const KEYS = Object.freeze(['active', 'takes', 'help', 'countdowns', 'seats', 'screens', 'sockets']);

const INPUT = new Set([
  'actionResponse', 'admin:acceptCertificate', 'admin:createRoom', 'admin:deleteMessage', 'admin:deleteRoom', 'admin:guestWeb', 'admin:kick', 'admin:newInvite',
  'admin:linkRoom', 'admin:lockRoles', 'admin:postSummary', 'admin:renewCertificate', 'admin:resetRoom', 'admin:setRole',
  'admin:settings', 'admin:summary', 'admin:tunnelStart', 'admin:tunnelStop', 'admin:tunnelUntil', 'admin:unlinkRoom',
  'ai:draft', 'ai:options', 'delete', 'display:create', 'display:hallHolding', 'display:identify', 'display:remove',
  'display:rotate', 'display:take', 'display:update', 'forward', 'hall:acceptCertificate', 'hall:configure', 'help:respond',
  'message', 'nodes:acceptCertificate', 'nodes:command', 'nodes:link', 'nodes:unlink', 'pin', 'react', 'room:create',
  'room:send', 'room:update', 'room:withdraw', 'stage:propose', 'stage:send',
  // A take on people's pages, and what a page says of one: the person's Back to chat, Minimise and Show again, and its
  // page's reports while a take is up on it, which a show running on the Board's tablets is; a take withdrawn.
  'page:push', 'page:report', 'page:withdraw',
  // The admin's choice of the view a person's pages draw: an admin's act.
  'admin:setView',
]);
const READS = new Set([
  'join', 'seen', 'myRooms', 'board:watch', 'userState:push', 'userState:requestPeers', 'stage:targets', 'display:list',
  'display:shown', 'hall:settings', 'nodes:list', 'admin:invites', 'admin:listRooms', 'admin:watchRoom', 'admin:laptop',
  'admin:tunnelStatus', 'room:settings', 'room:sendTargets', 'page:status', 'disconnect',
  // A room's earlier messages read back (Show earlier, a reply's Show it), and one it keeps in view read by its id (a
  // message pinned since a page opened): reads of what the room holds, changing nothing.
  'history:before', 'history:message',
]);

/** A count as the line keeps it: a whole number from 0, anything else 0. */
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/** A page's key: the hall's code and its person's uid, a line apart (neither holds one). */
const pageKey = (code, uid) => String(code) + '\n' + String(uid);

/**
 * The pages that gave input in the window, by key (`pageKey`): a page is counted from its newest input until WINDOW_MS
 * after it, open or gone, so a person who sent a message and closed the page still makes the window busy. Kept in the
 * order of each key's newest input, so what has left the window is taken from the front, and at most `max` are held, the
 * oldest let go first.
 */
class Activity {
  constructor({ windowMs = WINDOW_MS, max = ACTIVITY_MAX } = {}) { this.windowMs = windowMs; this.max = max; this.at = new Map(); }
  /** `key` gave input at `now`. */
  note(key, now) {
    this.at.delete(key);
    this.at.set(key, now);
    this._drop(now);
    for (const k of this.at.keys()) { if (this.at.size <= this.max) break; this.at.delete(k); }
  }
  /** Whether `key` gave input in the window ending at `now`. */
  has(key, now) { const t = this.at.get(key); return t !== undefined && now - t < this.windowMs; }
  /** How many keys gave input in the window ending at `now`. */
  count(now) { this._drop(now); return this.at.size; }
  /** The keys that gave input in the window ending at `now`. */
  keys(now) { this._drop(now); return [...this.at.keys()]; }
  _drop(now) {
    for (const [key, t] of this.at) {
      if (now - t < this.windowMs) break;
      this.at.delete(key);
    }
  }
}

/**
 * What a hall's messages say of the window after `since`: each message it holds from then (read from the newest back,
 * to the first older one) makes its sender's page active, `pageKey(code, sender)`, but the system's own lines; a sender
 * is the message's `from.uid`, else `from.id` (a show system's), else the message itself. Its help requests are counted.
 * {pages: the keys, help}.
 */
function fromMessages(code, messages, since) {
  const pages = new Set();
  let help = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || !(m.at > since)) break;
    if (m.type === 'help') help++;
    if (m.type === 'system') continue;
    const from = m.from || {};
    pages.add(pageKey(code, from.uid || from.id || 'message ' + m.id));
  }
  return { pages, help };
}

/** Counts made into a line: KEYS in their order, each a whole number from 0, nothing else. */
function line(counts) {
  const out = {};
  for (const k of KEYS) out[k] = count(counts && counts[k]);
  return out;
}

/**
 * A line another program answered (the folder's pipe, a server at loopback), read by type: its text's first line as
 * JSON holding KEYS and nothing else, each a whole number from 0; else null. Never authority: whatever holds the pipe's
 * name or the port may answer it.
 */
function read(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  let j;
  try { j = JSON.parse(text.split('\n')[0]); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const keys = Object.keys(j);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  if (!KEYS.every((k) => Number.isSafeInteger(j[k]) && j[k] >= 0)) return null;
  return line(j);
}

/** Whether a line is busy: a page active (a message or input), a take or a help request in the window, or a countdown running. */
const isBusy = (l) => !!l && (l.active > 0 || l.takes > 0 || l.help > 0 || l.countdowns > 0);

const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/**
 * A line in words. Busy: each count that makes it so ("3 pages active, 1 take changed, 1 help request, a countdown
 * running"). Not busy: "nothing in the last 10 minutes", and what is open and quiet ("4 seats and 2 screens open").
 */
function words(l) {
  if (isBusy(l)) {
    const parts = [];
    if (l.active) parts.push(plural(l.active, 'page') + ' active');
    if (l.takes) parts.push(plural(l.takes, 'take') + ' changed');
    if (l.help) parts.push(plural(l.help, 'help request'));
    if (l.countdowns) parts.push(l.countdowns === 1 ? 'a countdown running' : l.countdowns + ' countdowns running');
    return parts.join(', ');
  }
  const open = [];
  if (l && l.seats) open.push(plural(l.seats, 'seat'));
  if (l && l.screens) open.push(plural(l.screens, 'screen'));
  return 'nothing in the last ' + WINDOW_MS / 60_000 + ' minutes' + (open.length ? '; ' + open.join(' and ') + ' open' : '');
}

module.exports = { WINDOW_MS, ACTIVITY_MAX, KEYS, INPUT, READS, pageKey, Activity, fromMessages, line, read, isBusy, words };
