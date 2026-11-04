'use strict';
/**
 * The op table: the event each change to a hall is sent under. The server sends it from here (`apply()`, made by
 * `applier`); the hall page hears it and applies a resumed op through one table of its own (`public/app.js`,
 * `UPD_EVENTS`), which `test/modules.test.js` (k) holds equal to this one, field by field and event by event.
 *
 * Every op is numbered (its `s`, the room's seq) and a page takes each number once, in order: an op committed under a
 * number that no event carries leaves every page of the hall with a gap, and each would rejoin. So an op the table
 * cannot send is refused before it is committed, said in one log line, and `apply()` answers null. It never throws for
 * it: `apply()` is also called by the Stagewatch followers, outside the guarded socket handlers, where a throw would be
 * an uncaught exception and a watchdog restart.
 *
 * Pure: it requires nothing. What it commits, sends, marks and logs with, it is given.
 */

/** Each field an `upd` op may change → the event it is sent under, carrying `{messageId, <field>, seq}`. In order. */
const UPD_EVENTS = Object.freeze({
  responses: 'actionUpdate',
  pinned: 'pinUpdate',
  reactions: 'messageReact',
  stage: 'stageAck',
  proposal: 'proposalUpdate',
  help: 'helpUpdate',
  sentTo: 'sentUpdate',
  replyTo: 'replyUpdate',
});
/** The kinds of op a room's log holds (`lib/store.js`). */
const KINDS = Object.freeze(['add', 'upd', 'del', 'reset', 'meta']);
/** Every event `apply()` sends, whatever the op: the wire fence's names for the server's send (`opEvent`). */
const EVENTS = Object.freeze(['message', 'system', ...Object.values(UPD_EVENTS), 'messageDeleted', 'roomReset', 'roomMeta']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The fields of a message (and of an `upd`) whose record names the link it went to (`link`): a stage send's and a
 * proposal's. A hall's own link is named by the hall's key ('hall:<key>'), which is its Main room's address and its guest
 * code until New code, and which a side room's readers are never given; a page draws nothing by it. So a page is sent
 * each of these without it, and the record keeps it on the server, whose followers alone read it (a restart's
 * re-follow).
 */
const LINKED = Object.freeze(['stage', 'proposal']);
const linked = (v) => isRecord(v) && Object.hasOwn(v, 'link');
/** A stage send's or a proposal's record as a page is sent it: a copy without `link`, or the very record when it has none. */
function unlinked(v) {
  if (!linked(v)) return v;
  const { link, ...rest } = v;
  return rest;
}
/**
 * What a page is sent of a message, or of an `upd`'s fields: a copy without the link a stage send or a proposal went to
 * (LINKED), or the very value when it holds none. The record itself is never changed.
 */
function forPage(m) {
  if (!isRecord(m) || !LINKED.some((f) => linked(m[f]))) return m;
  const out = { ...m };
  for (const f of LINKED) if (linked(m[f])) out[f] = unlinked(m[f]);
  return out;
}
/** What a resuming page is sent of a committed op: an added message, or an `upd`'s fields, as forPage sends them. */
function opForPage(op) {
  if (!isRecord(op)) return op;
  if (op.o === 'add') { const m = forPage(op.m); return m === op.m ? op : { ...op, m }; }
  if (op.o === 'upd') { const f = forPage(op.f); return f === op.f ? op : { ...op, f }; }
  return op;
}
/** A key as a log line may carry it: a few of them, each cut short, nothing but a name's characters. */
const named = (keys) => keys.slice(0, 5).map((k) => k.replace(/[^\w$-]/g, '?').slice(0, 40)).join(', ') + (keys.length > 5 ? ' and ' + (keys.length - 5) + ' more' : '');

/** Why the table cannot send `op`, or '' when it can. The words name its kind and its fields, never a value. */
function refusal(op) {
  if (!isRecord(op) || !KINDS.includes(op.o)) return 'an op of a kind the table does not hold';
  if (op.o === 'add') return isRecord(op.m) && typeof op.m.id === 'string' ? '' : 'an added message with no id';
  if ((op.o === 'upd' || op.o === 'del') && typeof op.id !== 'string') return 'a change to no message';
  if (op.o !== 'upd') return '';
  const fields = isRecord(op.f) ? Object.keys(op.f) : [];
  if (!fields.length) return 'a change of no field';
  const outside = fields.filter((f) => !Object.hasOwn(UPD_EVENTS, f));
  return outside.length ? 'a change of ' + named(outside) + ', a field outside the op table' : '';
}

/**
 * The events a committed op is sent under, in order, as [event, payload]: an added message under its kind (and given
 * its seq), each field of an `upd` under the table's event for it, a removal, a reset and a hall's new name or settings.
 * A message and a field are sent as a page is sent them (forPage). `room` is the hall after the op was applied.
 */
function eventsOf(op, room) {
  const s = op.s;
  switch (op.o) {
    case 'add': op.m.seq = s; return [[op.m.type === 'system' ? 'system' : 'message', forPage(op.m)]];
    case 'upd': { const f = forPage(op.f); return Object.keys(UPD_EVENTS).filter((k) => Object.hasOwn(f, k)).map((k) => [UPD_EVENTS[k], { messageId: op.id, [k]: f[k], seq: s }]); }
    case 'del': return [['messageDeleted', { messageId: op.id, seq: s }]];
    case 'reset': return [['roomReset', { roomCode: room.code, seq: s }]];
    case 'meta': return [['roomMeta', { name: room.name || '', seq: s }]];
    default: return [];
  }
}

/**
 * `apply(room, op)`: the op committed (numbered, kept for resume, on disk: `commit`), each of its events sent to the hall
 * (`send(room, event, payload)`), the change marked (`changed(room)`), and the op answered. An op the table cannot send
 * is said (`refused(why)`) and nothing is committed, sent or marked: `apply()` answers null.
 */
function applier({ commit, send, changed, refused }) {
  return function apply(room, op) {
    const why = refusal(op);
    if (why) { refused(why); return null; }
    commit(room, op);
    for (const [event, payload] of eventsOf(op, room)) send(room, event, payload);
    changed(room);
    return op;
  };
}

/**
 * A room a send's mark names (a message's `sentFrom` or `sentTo`: `{roomName, hallName}`), as every reader of the record
 * says it, the transcript and the AI's thread alike, and the pages' catalogue (`public/catalog.js` `placeOf`, held to this
 * one by its test): a hall's Main room by its hall's name, a side room by its hall's and its own ("Hall 2 › Legal").
 */
function placeOf(mark) {
  const room = (isRecord(mark) && typeof mark.roomName === 'string' && mark.roomName) || '';
  const hall = (isRecord(mark) && typeof mark.hallName === 'string' && mark.hallName) || '';
  return !room || room === hall ? hall || room || 'another room' : (hall || 'A hall with no name') + ' › ' + room;
}

/**
 * How long a message was in a room, as every reader says it (a withdrawn send's "after 40 s", the row's "there 40 s"),
 * the pages' catalogue too (`public/catalog.js` `lasted`, held to this one by its test): whole seconds under a minute,
 * whole minutes under an hour, then hours and minutes, then days and hours; anything that is no length of time, none.
 */
function lasted(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  const and = (n, unit) => (n ? ' ' + n + ' ' + unit : '');
  if (s < 86400) return Math.floor(s / 3600) + ' h' + and(Math.floor((s % 3600) / 60), 'min');
  return Math.floor(s / 86400) + ' d' + and(Math.floor((s % 86400) / 3600), 'h');
}

module.exports = { UPD_EVENTS, KINDS, EVENTS, LINKED, refusal, eventsOf, applier, forPage, opForPage, unlinked, placeOf, lasted };
