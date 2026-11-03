'use strict';
/**
 * The one gate a socket verb passes before it reads anything a client named, and the two contexts a handler module
 * (`lib/handlers/`) is given of the server.
 *
 * The gate (`gateOf(facts)` → `gate(ack, {joined, bucket, admin, may})`): true when the request may go on; otherwise
 * the sender is answered with the refusal and it is false. Its steps are in one order, each refused in its own words:
 *
 *   1. joined: the socket is seated in a room ("Not joined"), and that room is still here ("Room gone"). On by default;
 *      `joined: false` for a verb a socket sends from no room (the admin page's).
 *   2. bucket: a token is taken from it ("Slow down a little.", with `busy`, so the outbox sends a held write again
 *      shortly). Named by every verb: one of the connection's buckets, or `null` where the verb takes none, with why.
 *   3. admin: `admin: true` for the admin's verbs ("Not admin").
 *   4. may: a right, or a list of rights each read in turn, the room's seat and rights answering it (`allowed`), each
 *      refused in its words (RIGHTS).
 *
 * Nothing a client names is looked up before a token is taken, so a refused lookup (a stale reference, another hall's
 * code) is never a free oracle: a request refused at its admin or its right has spent its token, as `message`'s does. An
 * option the gate does not take, a bucket not named, a bucket that cannot be taken from and a right it has no words for
 * each throw before any step is read: a verb written so is refused whole (the socket's guard answers it), never let
 * through with a step left out.
 *
 * The contexts (`contexts(parts)`), each frozen: `ctx`, every part the server names (its stores, their named effects,
 * `settings` to read and `io`), for the rooms module; `takesCtx`, for the takes module, the same parts but those that make
 * a room, a room's op or send to a room (`ROOM_SENDS`: `io`, `apply`, `systemMessage`, `newSideRoom`, `renameRoom`,
 * `sendGuestsOut`, `codeChanged`), and with `sendTo`, so a take reaches people's pages one socket at a time and never makes a room, a room's op or a room's
 * broadcast.
 *
 * Pure: it requires nothing. What it reads of a socket, a room, the buckets and the sockets open, it is given.
 */

/** The gate's words for its first three steps: today's, as the server's own `need`, `limited` and `admin` say them. */
const WORDS = Object.freeze({
  joined: 'Not joined',
  gone: 'Room gone',
  slow: 'Slow down a little.',
  admin: 'Not admin',
});
/**
 * The rights the gate reads, each with its words. A seat On stage holds messages only (lib/rbac.js SEAT_LIMITS), and is
 * refused a file in its own words. A right with no row here is refused by the gate whole: a unit that gates on one adds
 * its row, with its words.
 */
const RIGHTS = Object.freeze({
  'hall.post': Object.freeze({ words: 'Observers can read but not post.' }),
  'hall.files': Object.freeze({ words: 'Your account may not share files here.', onStage: 'On stage seats send messages, not files.' }),
});
/** The options the gate takes. */
const OPTIONS = Object.freeze(['joined', 'bucket', 'admin', 'may']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `opts` read whole, or a TypeError saying what is wrong with it: nothing is read of the request before this holds. */
function readOptions(opts) {
  if (!isRecord(opts)) throw new TypeError('the gate is given its options as an object: {joined, bucket, admin, may}');
  const unknown = Object.keys(opts).filter((k) => !OPTIONS.includes(k));
  if (unknown.length) throw new TypeError('the gate takes no option ' + unknown.join(', ') + ': it takes ' + OPTIONS.join(', '));
  if (!Object.hasOwn(opts, 'bucket')) throw new TypeError('the gate names its bucket, or says bucket: null with why');
  const { joined = true, bucket, admin = false, may = [] } = opts;
  if (bucket !== null && !(bucket && typeof bucket.take === 'function')) throw new TypeError('the gate\'s bucket is one it can take a token from, or null');
  if (typeof joined !== 'boolean' || typeof admin !== 'boolean') throw new TypeError('the gate\'s joined and admin are true or false');
  const rights = typeof may === 'string' ? [may] : may;
  if (!Array.isArray(rights)) throw new TypeError('the gate\'s may is a right, or a list of rights');
  for (const r of rights) if (typeof r !== 'string' || !Object.hasOwn(RIGHTS, r)) throw new TypeError('the gate has no words for the right ' + (typeof r === 'string' ? r.slice(0, 40) : 'given as a ' + typeof r) + ': it reads ' + Object.keys(RIGHTS).join(', '));
  return { joined, bucket, admin, rights };
}

/**
 * The refusal a request meets, or null when it may go on. `facts` answers for the socket: `joined()` (seated in a room),
 * `here()` (that room still here), `isAdmin()`, `allowed(right)` and `onStage()`. Each step is read only once the step
 * before it has passed, so a refused request reads nothing past its refusal, and takes a token only when it reaches its
 * bucket.
 */
function refusal(opts, facts) {
  const o = readOptions(opts);
  if (o.joined) {
    if (!facts.joined()) return { ok: false, error: WORDS.joined };
    if (!facts.here()) return { ok: false, error: WORDS.gone };
  }
  if (o.bucket && !o.bucket.take()) return { ok: false, error: WORDS.slow, busy: true };
  if (o.admin && !facts.isAdmin()) return { ok: false, error: WORDS.admin };
  for (const right of o.rights) {
    if (facts.allowed(right)) continue;
    const row = RIGHTS[right];
    return { ok: false, error: row.onStage && facts.onStage() ? row.onStage : row.words };
  }
  return null;
}

/** The gate of one socket: `gate(ack, opts)` answers `ack` (when it is a function) with the refusal and is false, or is true. */
function gateOf(facts) {
  return function gate(ack, opts) {
    const r = refusal(opts, facts);
    if (!r) return true;
    if (typeof ack === 'function') ack(r);
    return false;
  };
}

/**
 * The parts of the server's context that make a room, a room's op or send to a room: `io` (a room's broadcast), `apply`
 * (an op committed and sent to its room), `systemMessage` (a system line, through `apply`), `newSideRoom` (a room made,
 * its snapshot written), `renameRoom` (a room's new name, a meta op through `apply`), `sendGuestsOut` (a room's guest
 * pages told why and closed) and `codeChanged` (each page of a room told its guest code). The rooms module's alone: the
 * takes context holds none of them.
 */
const ROOM_SENDS = Object.freeze(['io', 'apply', 'systemMessage', 'newSideRoom', 'renameRoom', 'sendGuestsOut', 'codeChanged']);

/**
 * `sendTo(socketIds, event, payload)`: the event sent to each socket named by its id, one socket at a time, each once,
 * and the number reached. Only an id found among the sockets open now (`io.sockets.sockets`, Socket.IO's map of the
 * connected sockets by id) is sent to, so a hall's key given as an id reaches nobody, where a room broadcast
 * (`io.to(ids)`) would reach the whole hall; a list is the only way to name them, so a string is never read a character
 * at a time.
 */
function sendToOf(io) {
  return function sendTo(socketIds, event, payload) {
    if (!Array.isArray(socketIds)) return 0;
    let reached = 0;
    for (const id of new Set(socketIds)) {
      const s = typeof id === 'string' ? io.sockets.sockets.get(id) : undefined;
      if (!s) continue;
      s.emit(event, payload);
      reached++;
    }
    return reached;
  };
}

/**
 * The server's two contexts for the handler modules: `ctx` (every part, `io` among them) and `takesCtx` (the same parts
 * but `ROOM_SENDS`, and `sendTo` over `io`'s open sockets), both frozen. A part that is undefined (a name built after
 * the contexts, or misspelt) throws, as does `ctx` without an `io` whose open sockets can be read by id and a part that
 * would stand in for `sendTo`: the server does not start with a context it does not hold. The sockets `sendTo` reaches
 * are read here from `io`, never handed in, so the server's `takesCtx` is the one its tests hold.
 */
function contexts(parts) {
  if (!isRecord(parts)) throw new TypeError('the contexts are built from the server\'s parts, named');
  const missing = Object.keys(parts).filter((k) => parts[k] === undefined);
  if (missing.length) throw new TypeError('the contexts name ' + missing.join(', ') + ', which the server has not built: they are built last');
  if (!Object.hasOwn(parts, 'io')) throw new TypeError('the server\'s context holds io, for the rooms module');
  const open = parts.io && parts.io.sockets && parts.io.sockets.sockets;
  if (!open || typeof open.get !== 'function') throw new TypeError('sendTo finds each socket open by its id: io.sockets.sockets');
  if (Object.hasOwn(parts, 'sendTo')) throw new TypeError('sendTo is the takes context\'s own, made here');
  const takes = Object.fromEntries(Object.entries(parts).filter(([k]) => !ROOM_SENDS.includes(k)));
  return {
    ctx: Object.freeze({ ...parts }),
    takesCtx: Object.freeze({ ...takes, sendTo: sendToOf(parts.io) }),
  };
}

module.exports = { WORDS, RIGHTS, OPTIONS, ROOM_SENDS, refusal, gateOf, sendToOf, contexts };
