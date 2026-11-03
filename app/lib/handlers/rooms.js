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
 * is; a room's guest code (switched on or off, renewed: `room:update`'s `codeOn` and `newCode`), who may send into it
 * (`room:update`'s `sendFrom`, with `sendBack`), resetting and removing it are the admin's alone (`conn.admin`), never
 * from an On stage page. A room is named by its key; a hall, whose key is its Main room's, by its own. Every change is
 * one audit row, written before it is answered, naming the room by its name and its hall's, never a code; a change that
 * changes nothing writes none and is answered `already`.
 *
 * Which rooms may send into a room (plan 1-§4.1) is a list per room, of the keys of rooms of any hall, kept in the
 * settings (`settings.roomSends`), read through `ctx.sendersOf` and written only through `ctx.setRoomSends`. It is told
 * only to those who read a room's settings (`room:settings`: the admin and those who set halls up), each room on it by
 * its name and key and its hall's name, never a code; no page in a room is sent it.
 *
 * Sending into another room (plan 1-§4.2, §4.3): a page in room S is told the rooms whose list names S
 * (`room:sendTargets`), each by its reference (`store.roomRef`, never its key or a code), its name and its hall's, and
 * sends a message or a file into one of them (`room:send`): a new one, or one of S's. The rights in S decide (the list is
 * the admin saying that who may post in S may post into T), read on every send, so a list changed mid-show holds at once.
 * The message goes into T first, marked with where it came from (`sentFrom`), and S keeps a copy marked with where it went
 * (`sentTo`), so a copy is there only for a message that is in T; nothing else of T (its people, its seen receipts, its
 * replies, its numbers) comes back to S. A seat On stage sends nothing out of its room (owner answer B2): it is refused
 * first, whatever it sends, and is told no room to send to. One `room.send` row per send, naming the rooms by name and
 * the message by its kind and size, never its words or a file's name.
 */
const { str, cleanText } = require('../guard');

/** What a seat On stage is told of a send out of its room: what it writes stays in its room's feed (owner answer B2). */
const STAYS_HERE = 'Messages from On stage stay in this room.';
/** What `room:send` answers a client id a message of another kind holds here: no send of this person's carries it. */
const CID_HELD = 'That message\'s id is another message\'s.';
/** What `room:send` sends: a message's words, or a file. A question and a help request are asked in their own room. */
const SENDABLE = Object.freeze(['text', 'file']);
/** A file's size as a row says it: "340 KB", "2.1 MB". */
const sizeWords = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
/** A file's kind as a row says it: its upload's extension (an upload is named by the server, `<id>.<ext>`). */
const kindWords = (url) => url.slice(url.lastIndexOf('.') + 1).toLowerCase();
/** A message quoted by a reply: who wrote it and its first words, as the message verb quotes one (server.js). */
const quoteOf = (m) => ({ id: m.id, name: (m.from && m.from.name) || 'system', snippet: m.text ? m.text.slice(0, 120) : m.filename ? '📄 ' + m.filename : '' });

/**
 * What `room:update` reads: the room's key, one change, each read by its type, and the client id every act from a page
 * carries (public/outbox.js), which a repeat needs nothing of: a change already made is answered as done. The changes:
 * its name (`name`), whether its guest code admits guests (`codeOn`, with `keepGuests` as it is switched off: whether the
 * guest pages in it stay, true unless it says false), a new guest code (`newCode: true`), or which rooms may send into it
 * (`sendFrom`, their keys, with `sendBack`: the rooms it sends into, its "↔ and send back"s). Any other key is refused,
 * never ignored (fail closed), and so are two changes in one.
 */
const UPDATES = Object.freeze(['code', 'name', 'codeOn', 'keepGuests', 'newCode', 'sendFrom', 'sendBack', 'cid']);
const CHANGES = Object.freeze(['name', 'codeOn', 'newCode', 'sendFrom']);
/** What the admin alone changes: the guest code (and whether its guests stay), and which rooms may send in (and back). */
const ADMINS = Object.freeze(['codeOn', 'keepGuests', 'newCode', 'sendFrom', 'sendBack']);
/** The rooms a room's list may hold (server.js ROOM_SENDS_MAX, which setRoomSends holds it to as well). */
const SENDS_MAX = 50;
/** An audit row's words, in characters (lib/audit.js WORDS_MAX): a list in them is cut by whole names, the rest counted. */
const ROW_MAX = 300;
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
/** Keys a client listed, as the store keys rooms, each once in the order given; null for anything but a list of strings. */
const keysOf = (v) => (Array.isArray(v) && v.every((k) => typeof k === 'string') ? [...new Set(v.map((k) => k.toUpperCase()))] : null);
/** Whether two lists of keys hold the same keys, in any order. */
const sameKeys = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
/**
 * `head`, then ': ' and the names joined with commas as far as `room` characters hold them, the rest counted ("…, Media
 * (Hall 2) and 3 more"), so a list is never cut part way through a name.
 */
function listWords(head, names, room) {
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const next = (out ? out + ', ' : '') + names[i];
    const rest = names.length - i - 1;
    if (head.length + 2 + next.length + (rest ? (' and ' + rest + ' more').length : 0) > room) return head + ': ' + (out ? out + ' and ' : '') + (names.length - i) + ' more';
    out = next;
  }
  return head + ': ' + out;
}
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
  const { store, apply, readSend, messageOf, uploadOnDisk, makeMessageId, audit, boardDirty, newSideRoom, renameRoom, roomNameRefused, newGuestCode, guestPagesOf, sendGuestsOut, codeChanged, sendersOf, sendsInto, setRoomSends } = ctx;

  /** A hall as a refusal names it: its name, or "This hall" when it has none. */
  const hallSaid = (hall) => hall.name || 'This hall';
  /** A hall as a row names it: its name, or that it has none (its key is its guest code until New code, so never that). */
  const hallRow = (hall) => hall.name || 'a hall with no name';
  const write = (action, target, words) => audit.write(conn.actor(), action, target, words, socket.data.ip);
  /** A room by its key, Main or side, or null: the one way this module reads a room a client or a list names. */
  const roomOf = (key) => store.room(key);
  /** A room as a row names it: "Legal (Hall 2)", a Main room "Main (Hall 2)"; never its key, which may be a code. */
  const roomRow = (r) => (store.isMain(r) ? 'Main' : r.name || 'a room with no name') + ' (' + hallRow(store.get(r.hall)) + ')';
  /** A room as the settings tell it: its key, its name, whether it is a Main room, and its hall's name; never a code. */
  const roomTold = (r) => { const h = store.get(r.hall); return { key: r.code, name: r.name || '', main: store.isMain(r), hallName: (h && h.name) || '' }; };
  /** The rooms that may send into `r`, as the settings tell them: those on its list that are here, in its order. */
  const sendersTold = (r) => sendersOf(r.code).map(roomOf).filter(Boolean).map(roomTold);
  /**
   * Every room here, Main or side, of every hall, Main rooms first: the rooms whose lists a room's "↔ and send back"s are
   * read from and set on. A list of a room not here (one whose files another program held) is never read through it: it
   * is neither told nor changed.
   */
  const everyRoom = () => store.allRooms();
  /** The rooms whose list names `r`: those `r` may send into (its "↔ and send back"s), by key, Main rooms first. */
  const intoOf = (r) => sendsInto(r).map((x) => x.code);

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

  // A room's settings changed: its name, its guest code switched on or off or renewed, or which rooms may send into it. A
  // hall's Main room renamed is the hall renamed (its screens and the halls board say so), written as the hall's set-up
  // writes it; a side room's is its own row. The guest code and the rooms that may send in are the admin's alone, and
  // never from an On stage page. A change already made is answered as done (`already`), with no row. A setting this verb
  // does not change is refused with words, as are two at once.
  socket.on('room:update', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.writes })) return;
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const asked = CHANGES.filter((k) => Object.hasOwn(a, k));
    if (ADMINS.some((k) => Object.hasOwn(a, k))) {
      if (!conn.admin(ack)) return;
      // The admin passes canManageHall wherever it does not sit On stage.
      if (!conn.canManageHall()) return answer({ ok: false, error: BACKSTAGE });
    } else if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    if (Object.keys(a).some((k) => !UPDATES.includes(k))) return answer({ ok: false, error: 'A room\'s name, its guest code and the rooms that may send into it are the settings changed here.' });
    if (asked.length > 1) return answer({ ok: false, error: 'One change at a time: the name, the code on or off, a new code, or the rooms that may send in.' });
    const room = roomOf(keyOf(a.code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    // What comes with one change is refused beside any other, never ignored.
    if (Object.hasOwn(a, 'keepGuests') && asked[0] !== 'codeOn') return answer({ ok: false, error: 'Whether the guests stay is said as the code is switched off.' });
    if (Object.hasOwn(a, 'sendBack') && asked[0] !== 'sendFrom') return answer({ ok: false, error: 'Which rooms it sends back into is said with the rooms that may send in (sendFrom).' });
    if (asked[0] === 'codeOn') return switchCode(room, a.codeOn, a.keepGuests, answer);
    if (asked[0] === 'newCode') return renewCode(room, a.newCode, answer);
    if (asked[0] === 'sendFrom') return sendFrom(room, a.sendFrom, a.sendBack, answer);
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

  /**
   * Which rooms may send into `room` (its list): `from`, the keys of rooms of any hall, each a room that is here and not
   * this one (an unknown key refused in words, never dropped), each once, at most SENDS_MAX (a list is refused, never cut).
   * A key on the list whose room is not here (one whose files another program held, which comes back at the next start)
   * keeps its place: no picker shows it, so no save drops it, and it counts toward the bound.
   *
   * With `back`, which rooms this room sends into ("↔ and send back"), each a room here and not this one: this room put on
   * the list of each room `back` names and taken off the list of each other room that names it now, so what the picker
   * draws, the ↔ of every room, is what is kept. A room this room does not send into yet is added only beside a room that
   * `from` names (a ↔ is ticked only beside a room ticked to send here); one it sends into already may stay or go whether
   * or not that room may send here. Without `back`, no other room's list changes.
   *
   * The lists that change are saved together (`setRoomSends`, which refuses settings this run could not read) and written
   * in one `room.sendFrom` row, each room by its name and its hall's, never a key; no change is answered `already`, with no
   * row. Answered with the rooms on the list that are here (`sendFrom`) and those this room sends into (`sendBack`), by key,
   * and, for a change, those it was let send into (`into`) and those it no longer sends into (`notInto`).
   */
  function sendFrom(room, from, back, answer) {
    const keys = keysOf(from);
    if (!keys) return answer({ ok: false, error: 'Say which rooms may send here: a list of their keys (an empty list for none).' });
    const backKeys = back === undefined ? null : keysOf(back);
    if (back !== undefined && !backKeys) return answer({ ok: false, error: 'Say which of them this room sends back into: a list of their keys.' });
    if (keys.length > SENDS_MAX) return answer({ ok: false, error: 'At most ' + SENDS_MAX + ' rooms may send into one room: this list names ' + keys.length + '. Nothing was saved.' });
    for (const k of keys.concat(backKeys || [])) {
      const r = roomOf(k);
      if (!r) return answer({ ok: false, error: 'No such room: ' + cleanText(k, 40) + '. Nothing was saved.' });
      if (r === room) return answer({ ok: false, error: 'A room does not send into itself: leave it off its own list. Nothing was saved.' });
    }
    const sources = keys.map(roomOf);
    const before = intoOf(room);
    if (backKeys && backKeys.some((k) => !keys.includes(k) && !before.includes(k))) return answer({ ok: false, error: 'This room sends back only into a room that may send here: tick that room too. Nothing was saved.' });
    const held = sendersOf(room.code).filter((k) => !roomOf(k));
    const list = keys.concat(held);
    if (list.length > SENDS_MAX) return answer({ ok: false, error: 'At most ' + SENDS_MAX + ' rooms may send into one room: this list names ' + keys.length + ', and with the ' + held.length + ' not open now that keep their places on it, ' + list.length + '. Nothing was saved.' });
    const next = {};
    if (!sameKeys(sendersOf(room.code), list)) next[room.code] = list;
    const into = [];
    const notInto = [];
    for (const r of backKeys ? everyRoom() : []) {
      if (r === room) continue;
      const theirs = sendersOf(r.code);
      const has = theirs.includes(room.code);
      if (has === backKeys.includes(r.code)) continue;
      if (!has && theirs.length >= SENDS_MAX) return answer({ ok: false, error: 'At most ' + SENDS_MAX + ' rooms may send into one room, and ' + roomRow(r) + ' has ' + theirs.length + ' already: this room cannot send back into it. Nothing was saved.' });
      next[r.code] = has ? theirs.filter((k) => k !== room.code) : theirs.concat([room.code]);
      (has ? notInto : into).push(r);
    }
    const now = () => ({ sendFrom: sendersOf(room.code).filter((k) => roomOf(k)), sendBack: intoOf(room) });
    if (!Object.keys(next).length) return answer({ ok: true, already: true, ...now() });
    const why = setRoomSends(next);
    if (why) return answer({ ok: false, error: why });
    // The row: the list as it now is (the rooms not open now that keep their places counted), then the rooms this one was
    // let send into and those it no longer sends into, each list as far as its share of the row holds it.
    const listed = sources.map(roomRow).concat(held.length ? [held.length + (held.length === 1 ? ' room' : ' rooms') + ' not open now'] : []);
    const parts = [[list.length ? 'may send here' : 'no room may send here', listed], ['it sends back into', into.map(roomRow)], ['it no longer sends into', notInto.map(roomRow)]]
      .filter(([, names], i) => i === 0 || names.length);
    const share = Math.floor((ROW_MAX - 2 * (parts.length - 1)) / parts.length);
    write('room.sendFrom', room.code, parts.map(([head, names]) => (names.length ? listWords(head, names, share) : head)).join('; '));
    answer({ ok: true, ...now(), into: into.map((r) => r.code), notInto: notInto.map((r) => r.code) });
  }

  // A room's settings, read: its name, its hall and whether it is the hall's Main room, its hall's rooms in the order they
  // were made (Main first), each by name and key with its guest code, whether it admits guests, the guest pages in it now
  // (a count, never who: what the admin's code-off ask says) and the rooms that may send into it, and the asked room's
  // guest code. For those who set rooms up (Set up's Rooms reads it); a read, from memory. A code is told as this page may
  // be told it (`conn.codeTold`, the rule every list reads: those who set halls up hand codes out, but never one of a hall
  // whose Main room their account sits On stage in), '' otherwise. Last, the rooms that may send into the asked room
  // (`sendFrom`) and the rooms of any hall it sends into (`sendBack`, by key: those whose list names it, each a ↔ of its
  // picker, whether or not that room may send here), and, for the admin, who alone sets them, every hall's rooms by name
  // (`everyHall`: the halls by name, each hall's rooms Main first), the rooms a list may name.
  socket.on('room:settings', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.chatter })) return;
    const answer = conn.ok(ack);
    if (!conn.canManageHall()) return answer({ ok: false, error: NO_RIGHT });
    const room = roomOf(keyOf((isRecord(args) ? args : {}).code));
    if (!room) return answer({ ok: false, error: 'No such room.' });
    const hall = store.get(room.hall);
    // conn.admin, asked with no acknowledgement to answer, only reads whether this page is the admin's.
    const everyHall = conn.admin() ? [...store.rooms.values()]
      .map((h) => ({ key: h.code, name: h.name || '', rooms: store.roomsOf(h.code).map((r) => ({ key: r.code, name: r.name || '', main: store.isMain(r) })) }))
      .sort((x, y) => (x.name || x.key).localeCompare(y.name || y.key)) : undefined;
    answer({
      ok: true, key: room.code, name: room.name || '', main: store.isMain(room), hall: hall.code, hallName: hall.name || '',
      rooms: store.roomsOf(hall.code).map((r) => ({ key: r.code, name: r.name || '', main: store.isMain(r), guestCode: conn.codeTold(r), codeOn: store.codeOn(r), guests: guestPagesOf(r), sendFrom: sendersTold(r) })),
      guestCode: conn.codeTold(room), codeOn: store.codeOn(room),
      sendFrom: sendersTold(room), sendBack: intoOf(room),
      ...(everyHall ? { everyHall } : {}),
    });
  });

  /**
   * The rooms this page may send into now: each whose list names its room, none On stage (nothing leaves its room), none
   * for a seat that may not post there, and none from the support view, which is unseated and acts on nothing.
   */
  const targetsNow = () => (conn.onStage() || socket.data.adminView || !conn.allowed('hall.post') ? [] : sendsInto(conn.room()));
  /** A room as a page is told it, where it may send or where a send came from: its reference, its name and its hall's. */
  const refTold = (r) => { const h = store.get(r.hall); return { ref: store.roomRef(r), name: r.name || '', hallName: (h && h.name) || '' }; };
  /** A room as a send's mark names it (`sentFrom`, `sentTo`): its name and its hall's, and its reference; never a key. */
  const markOf = (r) => { const t = refTold(r); return { roomName: t.name, hallName: t.hallName, ref: t.ref }; };

  // The rooms this page may send into (plan 1-§4.2), each by its reference, its name and its hall's name: no key, no
  // code, no people and no numbers of any of them. A read, from memory.
  socket.on('room:sendTargets', (args, ack) => {
    if (!conn.gate(ack, { bucket: conn.chatter })) return;
    conn.ok(ack)({ ok: true, targets: targetsNow().map(refTold) });
  });

  // A message sent into another room, with a copy kept here (plan 1-§4.2, §4.3): `{to, messageId}` sends a message or a
  // file of this room; `{to, type: 'text' | 'file', text, url, filename, mime, caption, priority, replyTo}` a new one,
  // its file uploaded for this room by this person (its provenance). `to` is the room's reference. A repeat of a send
  // that went through (its client id) is answered with what it did, before anything else, so it is never refused for
  // what succeeded; then a seat On stage is refused, whatever it sends; then the rate, then the rights here: posting, and
  // sharing files for a file. T is written first, then one row, then the copy here, then the answer.
  socket.on('room:send', (args, ack) => {
    if (!conn.gate(ack, { bucket: null })) return;   // a repeat is answered as done before the rate: the token is taken below
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const sent = readSend(a, { held: true });
    if (sent.error) return answer({ ok: false, error: sent.error });
    const room = conn.room();
    const me = conn.me();
    // A repeat is a client id this person's copy of a send carries (or carried, removed since); one a message of another
    // kind holds here names no send, and is refused as a client id this verb cannot use, before any check reads it.
    const was = sent.cid ? store.sentAs(room, me.uid, sent.cid) : null;
    if (was && was.gone) return answer({ ok: true, id: was.id, seq: was.seq, gone: true });
    if (was) {
      const copy = room.byId.get(was.id);
      if (!copy || !copy.sentTo) return answer({ ok: false, error: CID_HELD });
      return answer({ ok: true, id: was.id, seq: was.seq, to: { name: copy.sentTo.roomName, hallName: copy.sentTo.hallName } });
    }
    if (conn.onStage()) return answer({ ok: false, error: STAYS_HERE });
    if (!conn.writes.take()) return conn.limited(ack);
    if (!conn.mayPost(ack)) return;
    // Which form: one of this room's messages, or a new one; never both, never neither.
    const byId = Object.hasOwn(a, 'messageId');
    if (byId === Object.hasOwn(a, 'type')) return answer({ ok: false, error: 'Send a message of this room (messageId) or a new one (type), one of them.' });
    const src = byId ? room.byId.get(str(a.messageId)) : null;
    if (byId && !src) return answer({ ok: false, error: 'Message not found' });
    const type = src ? src.type : a.type;
    if (!SENDABLE.includes(type)) return answer({ ok: false, error: type === 'help' ? 'A help request belongs to its room — ask in the other room instead.' : 'Only a message or a file is sent into another room.' });
    if (type === 'file' && !conn.allowed('hall.files')) return answer({ ok: false, error: 'Your account may not share files here.' });
    const into = store.byRef(str(a.to));
    if (!into || into === room) return answer({ ok: false, error: 'That room is gone.' });
    if (!targetsNow().includes(into)) return answer({ ok: false, error: 'This room may not send there — ask an admin.' });
    // The message: one of this room's, its words or its file as they are, or a new one made as `message` makes it.
    let body;
    let size = -1;
    if (src) {
      if (src.type === 'file') {
        size = uploadOnDisk(src.url);
        if (size < 0) return answer({ ok: false, error: 'That file is no longer on the AGMessage laptop.' });
      }
      body = { type: src.type, priority: !!src.priority, ...(src.type === 'text' ? { text: src.text } : { url: src.url, filename: src.filename, mime: src.mime, caption: src.caption || '' }) };
    } else {
      const built = messageOf(me, a, room, {});
      if (built.refused) return answer({ ok: false, ...built.refused });
      const { id, at, from, pinned, cid, held, ...rest } = built.msg;
      body = rest;
      size = built.size;
    }
    const now = Date.now();
    const from = { uid: me.uid, name: me.name, role: me.role, ...(me.acct ? { acct: true } : {}) };
    const author = src && src.from && src.from.name && src.from.uid !== me.uid ? src.from.name : '';
    // A reply here that answers a message from T, or this room's copy of one sent to T, answers its counterpart there.
    const parent = !src && typeof a.replyTo === 'string' ? room.byId.get(a.replyTo) : null;
    const answered = !parent ? null
      : parent.sentFrom && parent.sentFrom.ref === store.roomRef(into) ? into.messages.find((m) => m.sentTo && m.sentTo.id === parent.id) || null
        : parent.sentTo && parent.sentTo.ref === store.roomRef(into) ? into.byId.get(parent.sentTo.id) || null : null;
    const there = {
      ...body, id: makeMessageId(), at: now, from, pinned: false, ...(sent.held ? { held: sent.held } : {}),
      sentFrom: { ...markOf(room), ...(author ? { originalAuthor: author } : {}) }, ...(answered ? { replyTo: quoteOf(answered) } : {}),
    };
    if (!apply(into, { o: 'add', m: there })) return answer({ ok: false, error: OP_REFUSED });
    // The row once the message is in T, whatever becomes of the copy: nothing crosses rooms without one.
    write('room.send', into.code, (type === 'file' ? 'a file (' + kindWords(body.url) + ', ' + sizeWords(size) + ')' : 'a message (' + Array.from(body.text).length + ' characters)')
      + ' from ' + roomRow(room) + ' to ' + roomRow(into));
    const copy = {
      ...body, id: makeMessageId(), at: now, from, pinned: false, ...(sent.cid ? { cid: sent.cid } : {}), ...(sent.held ? { held: sent.held } : {}),
      sentTo: { ...markOf(into), id: there.id }, ...(parent ? { replyTo: quoteOf(parent) } : {}),
    };
    if (!apply(room, { o: 'add', m: copy })) return answer({ ok: false, error: 'It reached ' + roomRow(into) + ', but no copy could be kept here.' });
    answer({ ok: true, id: copy.id, seq: copy.seq, to: { name: copy.sentTo.roomName, hallName: copy.sentTo.hallName } });
  });
}

module.exports = { register };
