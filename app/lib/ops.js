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
});
/** The kinds of op a room's log holds (`lib/store.js`). */
const KINDS = Object.freeze(['add', 'upd', 'del', 'reset', 'meta']);
/** Every event `apply()` sends, whatever the op: the wire fence's names for the server's send (`opEvent`). */
const EVENTS = Object.freeze(['message', 'system', ...Object.values(UPD_EVENTS), 'messageDeleted', 'roomReset', 'roomMeta']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
 * `room` is the hall after the op was applied.
 */
function eventsOf(op, room) {
  const s = op.s;
  switch (op.o) {
    case 'add': op.m.seq = s; return [[op.m.type === 'system' ? 'system' : 'message', op.m]];
    case 'upd': return Object.keys(UPD_EVENTS).filter((f) => Object.hasOwn(op.f, f)).map((f) => [UPD_EVENTS[f], { messageId: op.id, [f]: op.f[f], seq: s }]);
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

module.exports = { UPD_EVENTS, KINDS, EVENTS, refusal, eventsOf, applier };
