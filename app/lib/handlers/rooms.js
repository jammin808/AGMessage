'use strict';
/**
 * The verbs on a hall's rooms: making and naming them, their settings, which rooms may send into them, a message sent
 * from one room into another and taken back, and a room's earlier messages. They are registered by the connection
 * (server.js), after its own verbs, on every page's socket but a screen's.
 *
 * Each verb is a literal listener on `socket` whose first statement is its one gate call,
 * `if (!conn.gate(ack, {…})) return;` (lib/gate.js), its `ack` the listener's own last argument, naming one of the
 * connection's buckets (`conn.writes`, `conn.chatter`) or saying `bucket: null` with why on its line
 * (test/modules.test.js (i)). Of the connection it reads `conn`: its room and person read when asked, so no verb holds a
 * room its page has left, its answers and its rights' questions (never `rbac.can`). Of the server it reads `ctx`, once,
 * destructured on the function's first line, which is the module's list of what it reaches: the stores and their named
 * effects, `settings` to read and never to write ((j)), and `io` for a room's broadcast. It requires only the pure core,
 * guard's pure helpers and ids, by a literal path, and makes nothing it requires ((d)).
 *
 * Setting rooms up (owner question 5, plan 1-§2.4): making a side room, renaming a room and reading a room's settings
 * are `halls.manage`'s and the admin's (`conn.canManageHall`, which an On stage seat never passes), as a hall's set-up
 * is; a room's guest code, who may send into it, resetting and removing it are the admin's alone (the admin page's
 * verbs, and `room:update`'s other settings as the units that bring them land). A room is named by its key; a hall,
 * whose key is its Main room's, by its own. Every change is one audit row, written before it is answered, naming the room
 * by its name and its hall's, never a code; a change that changes nothing writes none.
 */
const { str, cleanText } = require('../guard');

/**
 * What `room:update` reads: the room's key, the settings it changes (each read by its type) and the client id every act
 * from a page carries (public/outbox.js), which a repeat needs nothing of: the same name again is answered as done. Any
 * other key is refused, never ignored (fail closed).
 */
const UPDATES = Object.freeze(['code', 'name', 'cid']);
const NO_RIGHT = 'Your account may not set halls up.';

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A key a client named, as the store keys rooms: upper case, or '' for anything that is no string. */
const keyOf = (v) => str(v).toUpperCase();
/** A client id as a page makes one (public/outbox.js), and as a send's is read (server.js `CID_RE`). */
const CID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The answers of the rooms made lately, by who asked and the client id their page gave the act, so a `room:create` sent
 * again with its id (the outbox sends one again after a drop while it was out) is answered with what the first made,
 * never refused for the name that room now has. The newest MADE_KEEP, the oldest let go: a bound on memory, not on acts.
 */
const MADE_KEEP = 200;
const made = new Map();

/**
 * @param {object} socket a page's socket (never a screen's), its listeners guarded (server.js `guardHandlers`)
 * @param {object} conn   the connection's context, frozen
 * @param {object} ctx    the server's context, frozen (lib/gate.js `contexts`)
 */
function register(socket, conn, ctx) {
  const { store, audit, boardDirty, newSideRoom, renameRoom, roomNameRefused } = ctx;

  /** A hall as a refusal names it: its name, or "This hall" when it has none. */
  const hallSaid = (hall) => hall.name || 'This hall';
  /** A hall as a row names it: its name, or that it has none (its key is its guest code until New code, so never that). */
  const hallRow = (hall) => hall.name || 'a hall with no name';
  const write = (action, target, words) => audit.write(conn.actor(), action, target, words, socket.data.ip);

  // A side room of a hall (Legal, Media), beside its Main room: made by name, under a key of its own (8 characters, an
  // address and never a guest's code), its guest code off, so it is for the admin and the accounts it is given until the
  // admin switches its code on. At most 20 beside a hall (lib/store.js SIDE_MAX), a bound said in words. Asked again with
  // the client id of a create that made its room, it is answered with that room (`made`).
  socket.on('room:create', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.writes })) return;
    const answer = conn.ok(ack);
    if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    const a = isRecord(args) ? args : {};
    const cid = a.cid === undefined || a.cid === null ? null : a.cid;
    if (cid !== null && !(typeof cid === 'string' && CID.test(cid))) return answer({ ok: false, error: 'That act\'s id could not be read.' });
    const who = conn.actor();
    const asked = cid === null ? '' : who.t + ':' + who.id + '|' + cid;
    if (made.has(asked)) return answer(made.get(asked));
    const hall = store.get(keyOf(a.hall));
    if (!hall) return answer({ ok: false, error: 'No such hall.' });
    const name = cleanText(a.name, 80);
    if (!name) return answer({ ok: false, error: 'Name the room (for example Legal).' });
    const taken = roomNameRefused(hall, name, null);
    if (taken) return answer({ ok: false, error: taken });
    const room = newSideRoom(hall.code, name);
    if (!room) return answer({ ok: false, error: hallSaid(hall) + ' holds ' + (store.roomsOf(hall.code).length - 1) + ' rooms beside its Main room already: remove one to make another.' });
    write('room.create', room.code, name + ' in ' + hallRow(hall) + ' (code off)');
    boardDirty();
    const res = { ok: true, key: room.code, name: room.name, hall: hall.code };
    if (asked) {
      made.set(asked, res);
      if (made.size > MADE_KEEP) made.delete(made.keys().next().value);
    }
    answer(res);
  });

  // A room's settings changed: its name, here. A hall's Main room renamed is the hall renamed (its screens and the halls
  // board say so), written as the hall's set-up writes it; a side room's is its own row. The same name again is
  // answered as done (`already`), with no row. A setting this verb does not change is refused with words.
  socket.on('room:update', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.writes })) return;
    const answer = conn.ok(ack);
    if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    const a = isRecord(args) ? args : {};
    if (Object.keys(a).some((k) => !UPDATES.includes(k))) return answer({ ok: false, error: 'A room\'s name is the one setting changed here.' });
    const room = store.room(keyOf(a.code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    const name = cleanText(a.name, 80);
    if (!name) return answer({ ok: false, error: 'Type its new name.' });
    if (name === room.name) return answer({ ok: true, already: true, name });
    const taken = roomNameRefused(store.get(room.hall), name, room);
    if (taken) return answer({ ok: false, error: taken });
    if (!renameRoom(room, name)) return answer({ ok: false, error: 'That change could not be made: nothing was saved.' });
    write(store.isMain(room) ? 'hall.update' : 'room.update', room.code, 'name → ' + name);
    answer({ ok: true, name });
  });

  // A room's settings, read: its name, its hall and whether it is the hall's Main room, and its hall's rooms in the order
  // they were made (Main first), each by name and key. For those who set rooms up; a read, from memory.
  socket.on('room:settings', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.chatter })) return;
    const answer = conn.ok(ack);
    if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    const room = store.room(keyOf((isRecord(args) ? args : {}).code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    const hall = store.get(room.hall);
    answer({
      ok: true, key: room.code, name: room.name || '', main: store.isMain(room), hall: hall.code, hallName: hall.name || '',
      rooms: store.roomsOf(hall.code).map((r) => ({ key: r.code, name: r.name || '', main: store.isMain(r) })),
    });
  });
}

module.exports = { register };
