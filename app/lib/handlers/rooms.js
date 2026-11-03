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
 * is; a room's guest code (switched on or off, renewed: `room:update`'s `codeOn` and `newCode`), who may send into it,
 * resetting and removing it are the admin's alone (`conn.admin`), never from an On stage page. A room is named by its
 * key; a hall, whose key is its Main room's, by its own. Every change is one audit row, written before it is answered,
 * naming the room by its name and its hall's, never a code; a change that changes nothing writes none and is answered
 * `already`.
 */
const { str, cleanText } = require('../guard');

/**
 * What `room:update` reads: the room's key, one change, each read by its type, and the client id every act from a page
 * carries (public/outbox.js), which a repeat needs nothing of: a change already made is answered as done. The changes:
 * its name (`name`), whether its guest code admits guests (`codeOn`, with `keepGuests` as it is switched off: whether the
 * guest pages in it stay, true unless it says false), or a new guest code (`newCode: true`). Any other key is refused,
 * never ignored (fail closed), and so are two changes in one.
 */
const UPDATES = Object.freeze(['code', 'name', 'codeOn', 'keepGuests', 'newCode', 'cid']);
const CHANGES = Object.freeze(['name', 'codeOn', 'newCode']);
const NO_RIGHT = 'Your account may not set halls up.';
const BACKSTAGE = 'Do that from a backstage page.';
const OP_REFUSED = 'That change could not be made: nothing was saved.';
/** What a guest page sent out as its room's code is switched off is told. */
const FOR_ACCOUNTS = 'This room is for signed-in accounts now.';
/** "3 guest pages", "1 guest page": a count of pages, never who. */
const pages = (n) => n + ' guest page' + (n === 1 ? '' : 's');

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
  const { store, apply, audit, boardDirty, newSideRoom, renameRoom, roomNameRefused, newGuestCode, guestPagesOf, sendGuestsOut, codeChanged } = ctx;

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

  // A room's settings changed: its name, or its guest code switched on or off or renewed. A hall's Main room renamed is
  // the hall renamed (its screens and the halls board say so), written as the hall's set-up writes it; a side room's is
  // its own row. The guest code is the admin's alone, and never from an On stage page. A change already made is answered
  // as done (`already`), with no row. A setting this verb does not change is refused with words, as are two at once.
  socket.on('room:update', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.writes })) return;
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const asked = CHANGES.filter((k) => Object.hasOwn(a, k));
    if (asked.includes('codeOn') || asked.includes('newCode') || Object.hasOwn(a, 'keepGuests')) {
      if (!conn.admin(ack)) return;
      // The admin passes canManageHall wherever it does not sit On stage.
      if (!conn.canManageHall()) return answer({ ok: false, error: BACKSTAGE });
    } else if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    if (Object.keys(a).some((k) => !UPDATES.includes(k))) return answer({ ok: false, error: 'A room\'s name and its guest code are the settings changed here.' });
    if (asked.length > 1) return answer({ ok: false, error: 'One change at a time: the name, the code on or off, or a new code.' });
    const room = store.room(keyOf(a.code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    if (asked[0] === 'codeOn') return switchCode(room, a.codeOn, a.keepGuests, answer);
    if (asked[0] === 'newCode') return renewCode(room, a.newCode, answer);
    if (Object.hasOwn(a, 'keepGuests')) return answer({ ok: false, error: 'Whether the guests stay is said as the code is switched off.' });
    const name = cleanText(a.name, 80);
    if (!name) return answer({ ok: false, error: 'Type its new name.' });
    if (name === room.name) return answer({ ok: true, already: true, name });
    const taken = roomNameRefused(store.get(room.hall), name, room);
    if (taken) return answer({ ok: false, error: taken });
    if (!renameRoom(room, name)) return answer({ ok: false, error: OP_REFUSED });
    write(store.isMain(room) ? 'hall.update' : 'room.update', room.code, 'name → ' + name);
    answer({ ok: true, name });
  });

  /**
   * The guest code switched on (the same code admits again) or off (`room.settings.codeOff`, one meta op its pages hear,
   * the code itself never in it). Off, the guest pages in the room stay (`keepGuests`, true unless false: a seated guest
   * whose Wi-Fi drops comes back within the grace, and a newcomer is refused), or are sent out with the seats they held
   * (`keepGuests: false`: the op clears the saved seats too, and each guest page is told why and closed). An account's
   * pages stay either way. One `room.code` row, counting the guest pages and never naming the code.
   */
  function switchCode(room, on, keepGuests, answer) {
    if (typeof on !== 'boolean') return answer({ ok: false, error: 'Say whether the code is on (true) or off (false).' });
    if (keepGuests !== undefined && (on || typeof keepGuests !== 'boolean')) return answer({ ok: false, error: 'Whether the guests stay is said as the code is switched off: true or false.' });
    const keep = keepGuests !== false;
    const now = guestPagesOf(room);
    const seats = Object.keys(room.settings.seats || {}).length;
    // Already so: on and on, or off and off with nothing to send out (no guest page, no saved seat).
    if (store.codeOn(room) === on && (on || keep || (!now && !seats))) return answer({ ok: true, already: true, codeOn: on });
    // Sent out, the switch and the seats that go are the one op sendGuestsOut commits before it closes a page.
    const out = on || keep ? 0 : sendGuestsOut(room, { codeOff: true }, FOR_ACCOUNTS);
    if (out === null || ((on || keep) && !apply(room, { o: 'meta', settings: { codeOff: !on } }))) return answer({ ok: false, error: OP_REFUSED });
    write('room.code', room.code, on ? 'code on' : keep ? 'code off (' + pages(now) + ' kept)' : 'code off (' + pages(out) + ' sent home)');
    codeChanged(room);
    answer({ ok: true, codeOn: on, ...(on ? {} : keep ? { kept: now } : { sentOut: out }) });
  }

  /**
   * A new guest code (`store.setGuestCode`, its snapshot written at once and never an op): the one before it admits only a
   * person already seated there, the invites made with it stop, and the guests in the room stay. The admin is answered
   * the new code; each page in the room is told it as that page may know it (`codeChanged`). One `room.code` row, which
   * names no code. A renewal the disk refuses changes nothing, and is answered so: the code stays as it was.
   */
  function renewCode(room, asked, answer) {
    if (asked !== true) return answer({ ok: false, error: 'Ask for a new code with newCode: true.' });
    const before = store.setGuestCode(room, newGuestCode());
    if (before === false) return answer({ ok: false, error: 'No new code was made: it could not be saved. The code stays as it was.' });
    if (before === null) return answer({ ok: false, error: 'No new code was made: try again.' });
    write('room.code', room.code, 'a new code was issued');
    codeChanged(room);
    answer({ ok: true, guestCode: store.guestCodeOf(room), codeOn: store.codeOn(room) });
  }

  // A room's settings, read: its name, its hall and whether it is the hall's Main room, its hall's rooms in the order they
  // were made (Main first), each by name and key with its guest code, whether it admits guests and the guest pages in it
  // now (a count, never who: what the admin's code-off ask says), and the asked room's guest code. For those who set rooms
  // up (Set up's Rooms reads it); a read, from memory. A code is told as this page may be told it (`conn.codeTold`, the
  // rule every list reads: those who set halls up hand codes out, but never one of a hall whose Main room their account
  // sits On stage in), '' otherwise.
  socket.on('room:settings', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.chatter })) return;
    const answer = conn.ok(ack);
    if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    const room = store.room(keyOf((isRecord(args) ? args : {}).code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    const hall = store.get(room.hall);
    answer({
      ok: true, key: room.code, name: room.name || '', main: store.isMain(room), hall: hall.code, hallName: hall.name || '',
      rooms: store.roomsOf(hall.code).map((r) => ({ key: r.code, name: r.name || '', main: store.isMain(r), guestCode: conn.codeTold(r), codeOn: store.codeOn(r), guests: guestPagesOf(r) })),
      guestCode: conn.codeTold(room), codeOn: store.codeOn(room),
    });
  });
}

module.exports = { register };
