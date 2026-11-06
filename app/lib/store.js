'use strict';
/**
 * Room store: every change is an operation with a per-room sequence number, appended to an
 * append-only log (data/rooms/<CODE>.log, one JSON line per op) — O(1) per change instead of
 * rewriting the whole room — and compacted into the snapshot (<CODE>.json) every N ops, and at a start and a stop only
 * when the room is dirty: it holds what its snapshot on disk does not (`dirty`). Every line of a log counts toward the
 * N its room is compacted at, the lines a start replays (or finds already in the snapshot) included, so a log stays
 * bounded however many restarts come between two snapshots. A torn last line (power cut mid-write, or a disk that took
 * only part of it) is skipped, never fatal, and the next append starts on a line of its own, so the op after it is
 * never lost with it.
 *
 * Recent ops stay in memory (a ring per room), so a client that drops off for a moment resumes
 * with just what it missed (`opsSince(seq)`) instead of reloading the whole history — the game
 * netcode pattern: sequence numbers, deltas while they cover the gap, a first open otherwise. A first open is bounded
 * (`firstOpen`): the room's newest WINDOW messages and what a page keeps in view from before them, the earlier ones read
 * back a WINDOW at a time (`before`).
 *
 * Halls and rooms. A hall is its Main room: `rooms`, `get` and `has` mean a hall, by its key, and every reader that
 * means a hall reads them and nothing else. A hall's other rooms (Legal, Media) are side rooms: each a room as a Main
 * room is (its own op log, seq, ring, snapshot, seats and lock), kept beside its hall as
 * data/rooms/<HALL>.<KEY>.json|.log|.json.bak and in memory in `side`, which only the "any room" readers reach:
 * `room(key)`, `hasRoom(key)`, `allRooms()` (the Main rooms, then the side rooms) and `roomsOf(hall)` (its Main room
 * first, then its side rooms in the order they were made). A reader of a hall never sees a side room, so one that
 * should have read any room answers "Room not found": it fails closed. A room's `hall` is its hall's key, a Main room's
 * its own. A side room loads only beside a hall that loaded, under a key no other room has; a file whose name is
 * neither is said and left on disk. A hall's stem has no dot and a side room's has one, so 0.5.1, which loads only
 * stems CODE_RE takes, reads the halls and leaves the side rooms' files as they are.
 *
 * Guest codes. A room's key is its address (a hall's is its Main room's), and the code guests type is its guest code
 * (`guestCodeOf`): a side room's own (`guestCode`, given as it is made), a Main room's own once it was renewed and its key
 * until then, so a hall of 0.5.1 keeps the code its guests know with nothing written. A renewed code moves the one before
 * it into `retired` (the newest RETIRED_KEEP), which admits only a person already seated there. Both are the store's
 * alone: a code is changed by `setGuestCode`, never by an op, so it reaches no op log, ring or resuming page, and is
 * written by the snapshot it takes at once. The codes are indexed (`codes`, `retiredCodes`: a code to the key of its
 * room), rebuilt at a load and at every change; a code is one room's: a live code, a retired one and a key are never
 * shared, and of two rooms on disk claiming one code (a file edited by hand) the first, by key, holds it and the other's
 * admits nobody, said on the console by its room, never by the code. Whether a code admits guests is its room's setting
 * (`codeOn`): a Main room's is on until switched off, a side room's off until switched on.
 *
 * References. A send into another room names that room to a page by its reference (`roomRef`), never by its key or a
 * code: made once per room from its key by the server's `refOf` (the same at every start), indexed with the codes
 * (`refs`, read through `byRef`), and never written: a snapshot holds none.
 *
 * Ops: {o:'add', m} {o:'upd', id, f} {o:'del', id} {o:'reset'} {o:'meta', name}
 *
 * A send is said once. A message a page sent with its client id (`cid`) is indexed by who sent it and that id
 * (`byCid`), so a repeat of the send is answered with what the first one became and commits nothing. A message removed
 * (`del`, `reset`) leaves a tombstone: its id, its seq and who sent it, with the client id when it had one. The newest
 * GONE_KEEP of them are kept in memory and in the snapshot (`gone`), so a repeat of a removed send, or a second delete,
 * is still answered for what happened after a restart. Every index is kept in `_apply`, where the one writer applies an
 * op, so an op replayed from the log builds the same indexes as one committed now.
 *
 * Durability: the op append is synchronous on purpose, and is not flushed to the disk by AGMessage:
 * an acknowledged message is in the system's file cache. A crash of AGMessage or of a browser loses nothing; a power
 * cut can lose the last few seconds, what the system had not yet written back to the disk. An append the disk refuses
 * leaves its op in memory only (`unsaved`, named in health) until the room's next snapshot lands: a crash before then
 * loses it. A snapshot is written tmp -> fsync -> rename, keeping the previous snapshot as .bak only when it is whole,
 * and a torn snapshot falls back to the .bak on load — the log is replayed on top of whichever loaded. The store knows
 * its own snapshot (`snapWhole`): true once it wrote one, or loaded one that parsed, and then the next compaction
 * copies it to .bak unread; false after a load that fell back to the .bak, and then the snapshot on disk is read and
 * parsed before it may replace the .bak.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonWhole } = require('./resilience');

const RING = 2000;          // ops kept in memory per room for resume
const COMPACT_EVERY = 500;  // ops between snapshots
const CODE_RE = /^[A-Z0-9]{4,12}$/;
// A side room's file stem: its hall's key, a dot, its own key. CODE_RE never takes it.
const SIDE_RE = /^([A-Z0-9]{4,12})\.([A-Z0-9]{4,12})$/;
const SIDE_MAX = 20;        // side rooms per hall: a bound, not a governor (each is a switcher button and its files)
const GONE_KEEP = 500;      // tombstones kept per room, the newest
const RETIRED_KEEP = 3;     // a room's earlier guest codes kept, the newest: each admits only a person seated there
// The room's newest messages a first open carries, and each page of earlier ones (`firstOpen`, `before`): a bound on the
// run of messages one answer sends however long a room's history. What a first open also carries from before its window
// is not bounded by it: the messages a page keeps in view (keptInView) and the room's file index grow with the day.
const WINDOW = 200;

/**
 * Whether a message older than a first open's window is still carried with it: one a page keeps in view however old it
 * is. A pinned message (the pinned strip), a help request not yet resolved (Help's chip, its answers), and a question
 * nobody has answered yet (the Board answers it where it is drawn).
 */
const keptInView = (m) => !!m && (!!m.pinned
  || (m.type === 'help' && !(m.help && m.help.state === 'resolved'))
  || (m.type === 'action' && !(Array.isArray(m.responses) && m.responses.length > 0)));
/**
 * A file as the first open's index names it: its message's id, its address, its name and its kind, and whether it is
 * transfer-only (one AGMessage never opens).
 */
const fileEntry = (m) => ({ id: m.id, url: m.url, filename: m.filename, mime: m.mime, ...(m.transferOnly === true ? { transferOnly: true } : {}) });
/**
 * A message as a page reading the room is sent it (a first open, a read back, one message read): a reply whose quoted
 * message is no longer in the room (removed; a withdrawn one's quote says so already) is a copy whose quote says it has
 * gone (`replyTo.gone`), so no page offers to read back to it; every other message is the room's record itself.
 */
function asRead(room, m) {
  const q = m && m.replyTo;
  if (!q || typeof q !== 'object' || q.withdrawn || typeof q.id !== 'string' || room.byId.has(q.id)) return m;
  return { ...m, replyTo: { ...q, gone: true } };
}

/**
 * Every field a snapshot holds, and the change that makes it differ from the snapshot on disk, which makes its room dirty:
 * an op, committed now or replayed from the log at a start, is a line of the log and counts toward `logCount`; a change
 * made without one calls `markDirty`. A start and a stop write only the dirty rooms, so a field the snapshot writes is a
 * row here first, with the change that marks it (test/units.test.js holds the snapshot's fields to these rows).
 */
const SNAPSHOT_FIELDS = Object.freeze({
  code: 'made with the room, whose first snapshot create() (a hall) or createIn() (a side room) writes at once; never changed',
  name: 'a meta op',
  createdAt: 'made with the room, whose first snapshot create() (a hall) or createIn() (a side room) writes at once; never changed',
  seq: 'every op',
  settings: 'a meta op; a side room\'s first, made with it, in the first snapshot createIn() writes at once',
  messages: 'an add, upd, del or reset op; a message moved to today\'s words as it loads (the load\'s onMigrate) calls markDirty',
  savedAt: 'the snapshot itself: each one writes it',
  gone: 'a del or reset op',
  // Written only when the room has one: a hall that was never renewed writes 0.5.1's shape, byte for byte.
  guestCode: 'setGuestCode, which calls markDirty and writes the snapshot at once; a side room\'s first, made with it, in the first snapshot createIn() writes at once',
  retired: 'setGuestCode, which calls markDirty and writes the snapshot at once',
});
/** The snapshot fields a room writes only when it holds them (SNAPSHOT_FIELDS' last rows). */
const SNAPSHOT_OPTIONAL = Object.freeze(['guestCode', 'retired']);

/** A message's key in `byCid`: who sent it and its client id, or '' when it has none. */
const cidKey = (m) => (m && typeof m.cid === 'string' && m.cid && m.from && typeof m.from.uid === 'string' && m.from.uid ? m.from.uid + ':' + m.cid : '');
/** A tombstone as a snapshot keeps it, or null for a shape no snapshot of ours writes. */
function readTomb(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) return null;
  return {
    id: t.id,
    ...(Number.isInteger(t.seq) ? { seq: t.seq } : {}),
    ...(typeof t.uid === 'string' && t.uid ? { uid: t.uid } : {}),
    ...(typeof t.cid === 'string' && t.cid ? { cid: t.cid } : {}),
  };
}

class RoomStore {
  /**
   * `make: false`: the folder is not made here (a server makes it once it holds its data folder, and loads before).
   * `refOf(key)`: a room's reference, made once per room as it is made or loaded (the server's: a MAC of its key under the
   * server's secret, so it is the same at every start and names nothing a client could open); none, and rooms have none.
   */
  constructor(dir, { make = true, refOf = null } = {}) {
    this.dir = dir;
    if (make) fs.mkdirSync(dir, { recursive: true });
    this.refOf = typeof refOf === 'function' ? refOf : null;
    this.rooms = new Map();  // the halls (their Main rooms), by key
    this.side = new Map();   // the side rooms, by key: reached only through the any-room readers
    // Each hall's side rooms, in the order they were made (`roomsOf`), so a hall's rooms are read without a walk of every
    // side room of every hall; kept with `side`, which holds the same rooms by key.
    this.sideByHall = new Map();
    // The newest createdAt this store holds, loaded or made: a room made now is stamped after it (`_madeNow`), so rooms
    // keep the order they were made in even when the clock has not moved on or has stepped back.
    this.newestMade = 0;
    // The guest codes: each live code, and each earlier one a room keeps (`retired`), to the key of its room. Rebuilt at a
    // load and at every change (`_index`); read through `byCode`, `byRetired` and `codeHeld`.
    this.codes = new Map();
    this.retiredCodes = new Map();
    // Each room's reference to its key (`byRef`): how a send into another room names it to a page, which is told no key.
    // Rebuilt with the codes, at a load and at every change (`_index`).
    this.refs = new Map();
    this.lastError = null;  // the last append or snapshot that failed, until every room is on disk again
    this.snapshots = 0;      // snapshots written this run (health)
    // What the last load found on disk, which a stop that saved never leaves: the rooms whose log held lines, and the
    // newest snapshot's `savedAt` (lib/laststop.js `judge` reads a stop's record against them).
    this.found = { lines: 0, newest: 0 };
    // The halls whose files the last load found on disk (a snapshot or its .bak), loaded or not: a hall that could not be
    // read at this start (its files busy, or both torn) is still one, and loads again once it can be; what is kept beside a
    // hall (its stage record) goes only with a hall in neither this nor `rooms`.
    this.hallsOnDisk = new Set();
    // Told of each snapshot written: (ms it took — the stall a commit waits — the room's message count). Health's peaks.
    this.onCompact = null;
  }

  static validCode(code) { return typeof code === 'string' && CODE_RE.test(code); }

  /** A room's file stem: its key for a hall (its Main room), `<HALL>.<KEY>` for a side room. */
  static stemOf(room) { return room.hall === room.code ? room.code : room.hall + '.' + room.code; }
  /** One of a room's files: `ext` is .json, .log or .json.bak. */
  file(room, ext) { return this._at(RoomStore.stemOf(room), ext); }
  _at(stem, ext) { return path.join(this.dir, stem + ext); }

  /**
   * Load every room: snapshot + replay of its log. Returns the number loaded. Each dirty room is then compacted (a log
   * replayed, a snapshot that fell back to its .bak, a room `onMigrate` changed and marked); a clean one is not written.
   * With `compact: false` nothing is written (a server that does not yet own its port must not touch the files another
   * copy may be appending to); the caller compacts the dirty rooms once it does (`compactDirty`). Every hall loads first,
   * as 0.5.1 loads them; then each side room whose hall loaded, whose key no room has and whose hall holds fewer than
   * SIDE_MAX side rooms, in the order of its file's name, so which of two rooms claiming one key, or which rooms past the
   * bound, load is the same at every start. A file of no hall and no room, and a side room left out, is said on the
   * console, and its files stay on disk.
   */
  loadAll(onMigrate, { compact = true } = {}) {
    let n = 0;
    this.found = { lines: 0, newest: 0 };
    // A room whose snapshot was lost mid-rename still has its .bak: both name the room. A folder not made yet holds none;
    // one that cannot be read throws, with its code.
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const stems = new Set(names.map((f) => (/^(.+)\.json(\.bak)?$/.exec(f) || [])[1]).filter(Boolean));
    this.hallsOnDisk = new Set([...stems].filter((stem) => RoomStore.validCode(stem)));
    const sides = [];
    for (const stem of stems) {
      const side = SIDE_RE.exec(stem);
      if (RoomStore.validCode(stem)) { if (this._load(stem, stem, onMigrate, compact)) n++; }
      else if (side) sides.push(side);
      else console.warn('  Not loaded: ' + stem + ' names no hall and no room (its files are kept)');
    }
    for (const [stem, hall, key] of sides.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!this.rooms.has(hall)) console.warn('  Not loaded: room ' + key + ' — its hall ' + hall + ' is gone (its files are kept as ' + stem + ')');
      else if (this.hasRoom(key)) console.warn('  Not loaded: room ' + key + ' of hall ' + hall + ' — another room has its key (its files are kept as ' + stem + ')');
      else if (this._sidesOf(hall).length >= SIDE_MAX) console.warn('  Not loaded: room ' + key + ' of hall ' + hall + ' — the hall holds ' + SIDE_MAX + ' rooms beside it already (its files are kept as ' + stem + ')');
      else if (this._load(key, hall, onMigrate, compact)) n++;
    }
    this._index(true);
    return n;
  }

  /** Load one room, a hall when `hall` is its own key and a side room of `hall` otherwise; true when it loaded. */
  _load(code, hall, onMigrate, compact) {
    const stem = hall === code ? code : hall + '.' + code;
    try {
      const { data, whole } = readJsonWhole(this._at(stem, '.json'));
      if (!data) throw new Error('snapshot and its backup are both unreadable');
      const room = this._blank(code, typeof data.name === 'string' ? data.name : '', data.createdAt || Date.now(), { hall, ...readCodes(data, code) });
      if (Number(room.createdAt) > this.newestMade) this.newestMade = Number(room.createdAt);
      room.messages = Array.isArray(data.messages) ? data.messages.filter((m) => m && typeof m.id === 'string') : [];
      room.seq = Number.isInteger(data.seq) ? data.seq : room.messages.length;
      room.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      room.snapWhole = whole;   // the snapshot on disk parsed; one that fell back to the .bak is read again before it may replace it
      for (const m of room.messages) {
        room.byId.set(m.id, m);
        const key = cidKey(m);
        if (key) room.byCid.set(key, { id: m.id, seq: m.seq });
      }
      // A snapshot written before tombstones were kept has no `gone`: the room loads with none.
      for (const t of Array.isArray(data.gone) ? data.gone : []) { const tomb = readTomb(t); if (tomb) this._bury(room, tomb); }
      this._replay(room);
      if (room.logCount) this.found.lines++;
      if (Number.isFinite(data.savedAt) && data.savedAt > this.found.newest) this.found.newest = data.savedAt;
      if (onMigrate) onMigrate(room);
      if (hall === code) this.rooms.set(code, room); else this._keepSide(room);
      if (compact && this.dirty(room)) this.compact(code);   // fold the replayed log into a fresh snapshot
      return true;
    } catch (e) {
      console.warn('  Failed to load room', stem, e.message);
      return false;
    }
  }

  /** The createdAt of a room made now: the clock's time, or a millisecond after the newest this store holds when that is no later. */
  _madeNow() {
    const t = Date.now();
    this.newestMade = t > this.newestMade ? t : this.newestMade + 1;
    return this.newestMade;
  }

  _blank(code, name, createdAt, { hall = code, guestCode = '', retired = [] } = {}) {
    return {
      code, hall, name, createdAt, guestCode, retired, ref: this.refOf ? this.refOf(code) : '', messages: [], byId: new Map(), byCid: new Map(), gone: new Map(), goneKeys: new Map(), seq: 0, ring: [],
      users: new Map(), settings: {}, logCount: 0, logFd: null, unsaved: false, ragged: false, snapKb: null, snapWhole: false, marked: false,
      news: null,   // news(): what is new here, read when first asked
    };
  }

  _replay(room) {
    const logPath = this.file(room, '.log');
    if (!fs.existsSync(logPath)) return;
    const text = fs.readFileSync(logPath, 'utf8');
    room.ragged = text.length > 0 && !text.endsWith('\n');   // a torn last line: the next append ends it first
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // Every line is a line of the log, replayed or not (one the snapshot holds already, a torn one): each counts toward
      // the compaction that empties it, and makes the room dirty.
      room.logCount++;
      let op;
      try { op = JSON.parse(line); } catch { continue; }   // torn write: skip
      if (!op || typeof op.s !== 'number' || op.s <= room.seq) continue;
      this._apply(room, op);
      room.seq = op.s;
    }
  }

  /** A hall (its Main room) by its key; never a side room. */
  get(code) { return this.rooms.get(code); }
  /** Whether a hall has this key; a side room's key is none. */
  has(code) { return this.rooms.has(code); }

  /** Any room by its key: a hall's Main room or a side room. */
  room(key) { return this.rooms.get(key) || this.side.get(key); }
  /** Whether any room, Main or side, has this key. */
  hasRoom(key) { return this.rooms.has(key) || this.side.has(key); }
  /** Every room: the Main rooms, then the side rooms. */
  allRooms() { return [...this.rooms.values(), ...this.side.values()]; }
  /** A hall's rooms: its Main room first, then its side rooms in the order they were made; none for a key that is no hall. */
  roomsOf(hall) {
    const main = this.rooms.get(hall);
    return main ? [main, ...this._sidesOf(hall)] : [];
  }
  /** Whether a room is its hall's Main room. */
  isMain(room) { return !!room && room.hall === room.code; }
  /**
   * The scope a room's rights are asked in (lib/rbac.js canIn): its key, its hall's key and whether it is that hall's
   * Main room; null for no room, so a right asked of a room that is gone answers no.
   */
  scopeOf(room) { return room ? Object.freeze({ code: room.code, hall: room.hall, main: this.isMain(room) }) : null; }

  /** The code a room's guests type: a side room's own, a Main room's own once renewed and its key until then; '' for none. */
  guestCodeOf(room) { return room ? room.guestCode || (this.isMain(room) ? room.code : '') : ''; }
  /** Whether a room's guest code admits guests: a Main room's unless switched off, a side room's only once switched on. */
  codeOn(room) { return !!room && (this.isMain(room) ? room.settings.codeOff !== true : room.settings.codeOff === false); }
  /** The room whose guest code this is, live (on or off), or null. */
  byCode(code) { const key = typeof code === 'string' ? this.codes.get(code) : undefined; return key === undefined ? null : this.room(key) || null; }
  /** The room that kept this as an earlier guest code (it admits only a person seated there), or null. */
  byRetired(code) { const key = typeof code === 'string' ? this.retiredCodes.get(code) : undefined; return key === undefined ? null : this.room(key) || null; }
  /** Whether a code is taken: a room's key, a live guest code or an earlier one. A new key or code is none of them. */
  codeHeld(code) { return this.hasRoom(code) || this.codes.has(code) || this.retiredCodes.has(code); }
  /**
   * The room a reference names (`roomRef`), Main or side, or null: a reference never passes CODE_RE, so no join or lookup
   * by code takes one, and one of a room removed names nothing.
   */
  byRef(ref) { const key = typeof ref === 'string' ? this.refs.get(ref) : undefined; return key === undefined ? null : this.room(key) || null; }
  /** A room's reference: what a page is told of a room it may send into or that sent to it, never its key; '' for none. */
  roomRef(room) { return (room && room.ref) || ''; }

  /**
   * A room's guest code renewed: `code` becomes its live code and the one before it joins its earlier codes (the newest
   * RETIRED_KEEP), which admit only a person seated there; the index follows, and the snapshot is written at once. Never an
   * op: the code reaches no op log, ring or resuming page, so the snapshot is the one place it is kept, and a renewal holds
   * only once that is written: one the disk refuses is taken back whole (the code, the codes before it, the index, the
   * room's mark), so the code before it still admits and nothing answered names a code a restart would not bring back.
   * Answers the code before it ('' when it had none); null when refused: no such room, or a code that is no code or is
   * taken (`codeHeld`); false when the disk refused its snapshot, with nothing changed.
   */
  setGuestCode(room, code) {
    if (!room || this.room(room.code) !== room || !RoomStore.validCode(code) || this.codeHeld(code)) return null;
    const before = this.guestCodeOf(room);
    const was = { guestCode: room.guestCode, retired: room.retired, marked: room.marked };
    room.retired = [...room.retired.filter((c) => c !== before), ...(before ? [before] : [])].slice(-RETIRED_KEEP);
    room.guestCode = code;
    this._index();
    this.markDirty(room);
    if (this.compact(room.code)) return before;
    Object.assign(room, was);
    this._index();
    return false;
  }

  /**
   * The codes indexed again from the rooms: every live code first, then every earlier one, each room in the order of its
   * key (the halls, then the side rooms by their file's name), so which of two rooms claiming one code holds it is the same
   * at every start. A code a room claims that another holds is left out (it admits nobody); at a load (`say`) the room is
   * named on the console, never its code.
   */
  _index(say = false) {
    const codes = new Map();
    const retired = new Map();
    const byKey = (a, b) => (a.code < b.code ? -1 : 1);
    const order = [...[...this.rooms.values()].sort(byKey), ...[...this.side.values()].sort((a, b) => (RoomStore.stemOf(a) < RoomStore.stemOf(b) ? -1 : 1))];
    const taken = (room, what) => { if (say) console.warn('  Room ' + room.code + (this.isMain(room) ? '' : ' of hall ' + room.hall) + ': ' + what + ' is another room\'s, so it admits nobody here (New code gives it one of its own)'); };
    for (const room of order) {
      const code = this.guestCodeOf(room);
      if (!code) continue;
      if (codes.has(code) || this.side.has(code) || (code !== room.code && this.rooms.has(code))) taken(room, 'its guest code');
      else codes.set(code, room.code);
    }
    for (const room of order) {
      for (const code of room.retired) {
        if (codes.has(code) || retired.has(code) || (code !== room.code && this.hasRoom(code))) { if (codes.get(code) !== room.code && retired.get(code) !== room.code) taken(room, 'an earlier guest code of it'); }
        else retired.set(code, room.code);
      }
    }
    this.codes = codes;
    this.retiredCodes = retired;
    // A reference to its room, the first of two that would share one (an HMAC's 96 bits: never met in practice) holding it.
    const refs = new Map();
    for (const room of order) if (room.ref && !refs.has(room.ref)) refs.set(room.ref, room.code);
    this.refs = refs;
  }

  /** A hall's side rooms in the order they were made (the index's own list: never handed out to be changed). */
  _sidesOf(hall) { return this.sideByHall.get(hall) || []; }
  /** A side room kept, by its key and in its hall's list, which stays in the order its rooms were made. */
  _keepSide(room) {
    this.side.set(room.code, room);
    const made = (a, b) => (Number(a.createdAt) - Number(b.createdAt)) || (a.code < b.code ? -1 : 1);
    this.sideByHall.set(room.hall, [...this._sidesOf(room.hall), room].sort(made));
  }
  /** A side room let go, by its key and from its hall's list. */
  _forgetSide(room) {
    this.side.delete(room.code);
    const left = this._sidesOf(room.hall).filter((r) => r !== room);
    if (left.length) this.sideByHall.set(room.hall, left); else this.sideByHall.delete(room.hall);
  }

  /**
   * What a person's send with this client id became in the room: `{id, seq}` while the message is there,
   * `{id, seq, gone: true}` once it was removed (among the newest GONE_KEEP removals), or null when no send of theirs
   * carried it.
   */
  sentAs(room, uid, cid) {
    if (typeof uid !== 'string' || !uid || typeof cid !== 'string' || !cid) return null;
    const key = uid + ':' + cid;
    const live = room.byCid.get(key);
    if (live) return { id: live.id, seq: live.seq };
    const id = room.goneKeys.get(key);
    const tomb = id ? room.gone.get(id) : null;
    return tomb ? { id: tomb.id, seq: tomb.seq, gone: true } : null;
  }

  /** The tombstone of a message removed from the room (among the newest GONE_KEEP removals), or null. */
  removed(room, id) {
    return typeof id === 'string' ? room.gone.get(id) || null : null;
  }

  /**
   * What is new in a room, as the hall page's switcher reads it for a dot: `seq`, the seq of its newest message that is
   * not a system line, and `prioritySeq`, of its newest priority (🔥) one; each 0 for none (a message kept from before
   * messages carried their seq counts as none). A presence line, a reaction or a pin is no news. Read from the messages
   * once, then kept as each is added; a removal or a clear has it read again, so no dot stands for a message that has
   * gone.
   */
  news(room) {
    if (!room.news) {
      let seq = 0;
      let prioritySeq = 0;
      for (let i = room.messages.length - 1; i >= 0 && !prioritySeq; i--) {
        const m = room.messages[i];
        if (!m || m.type === 'system' || !Number.isInteger(m.seq)) continue;
        if (!seq) seq = m.seq;
        if (m.priority) prioritySeq = m.seq;
      }
      room.news = { seq, prioritySeq };
    }
    return room.news;
  }

  /** Keep a tombstone, the newest last; past GONE_KEEP the oldest goes, and its client id with it. */
  _bury(room, tomb) {
    room.gone.delete(tomb.id);
    room.gone.set(tomb.id, tomb);
    if (tomb.uid && tomb.cid) room.goneKeys.set(tomb.uid + ':' + tomb.cid, tomb.id);
    while (room.gone.size > GONE_KEEP) {
      const [oldId, old] = room.gone.entries().next().value;
      room.gone.delete(oldId);
      if (old.uid && old.cid && room.goneKeys.get(old.uid + ':' + old.cid) === oldId) room.goneKeys.delete(old.uid + ':' + old.cid);
    }
  }

  /** A removed message's tombstone: its id, its seq, who sent it and its client id, as far as it had them. */
  _tomb(room, m) {
    const key = cidKey(m);
    const live = key ? room.byCid.get(key) : null;
    const seq = live && Number.isInteger(live.seq) ? live.seq : m.seq;
    if (key) room.byCid.delete(key);
    this._bury(room, readTomb({ id: m.id, seq, uid: m.from && m.from.uid, cid: key ? m.cid : '' }));
  }

  /** Make a hall: its key is its guest code until it is renewed (`setGuestCode`), and its first snapshot is written at once. */
  create(code, name) {
    const room = this._blank(code, name || '', this._madeNow());
    this.rooms.set(code, room);
    this._index();
    this.compact(code);
    return room;
  }

  /**
   * Make a side room of `hall` under `key`, with its own guest code (`guestCode`, a code no room holds, never its key):
   * its first snapshot is written at once, as a hall's is, its guest code off (`codeOff`) unless `settings` says
   * otherwise, so a new room is for accounts until it is switched on. Null when refused: no such hall, a key that is no
   * key or that a room has already, a guest code that is no code or is taken (`codeHeld`), or a hall with SIDE_MAX side
   * rooms.
   */
  createIn(hall, key, name, { guestCode = '', settings = {} } = {}) {
    if (!this.rooms.has(hall) || !RoomStore.validCode(key) || this.hasRoom(key)) return null;
    if (guestCode !== '' && (!RoomStore.validCode(guestCode) || guestCode === key || this.codeHeld(guestCode))) return null;
    if (this._sidesOf(hall).length >= SIDE_MAX) return null;
    const room = this._blank(key, name || '', this._madeNow(), { hall, guestCode });
    room.settings = { codeOff: true, ...(settings && typeof settings === 'object' ? settings : {}) };
    this._keepSide(room);
    this._index();
    this.compact(key);
    return room;
  }

  /** Apply an op to the in-memory room (no I/O). */
  _apply(room, op) {
    switch (op.o) {
      case 'add': {
        if (room.byId.has(op.m.id)) return;
        // A message carries its seq from its op, in the log as in memory, so one replayed after a restart has it too.
        if (Number.isInteger(op.s)) op.m.seq = op.s;
        room.messages.push(op.m);
        room.byId.set(op.m.id, op.m);
        const key = cidKey(op.m);
        if (key) room.byCid.set(key, { id: op.m.id, seq: op.m.seq });
        if (room.news && op.m.type !== 'system' && Number.isInteger(op.m.seq)) room.news = { seq: op.m.seq, prioritySeq: op.m.priority ? op.m.seq : room.news.prioritySeq };
        break;
      }
      case 'upd': {
        const m = room.byId.get(op.id);
        if (m) Object.assign(m, op.f);
        break;
      }
      case 'del': {
        const i = room.messages.findIndex((m) => m.id === op.id);
        if (i >= 0) this._tomb(room, room.messages.splice(i, 1)[0]);
        room.byId.delete(op.id);
        room.news = null;
        break;
      }
      case 'reset':
        // A system line is nobody's send and no delete can name one: only what people wrote leaves a tombstone, the
        // newest GONE_KEEP of them.
        for (const m of room.messages.filter((x) => x.type !== 'system').slice(-GONE_KEEP)) this._tomb(room, m);
        room.messages = [];
        room.byId.clear();
        room.byCid.clear();
        room.news = null;
        break;
      case 'meta':
        if (typeof op.name === 'string') room.name = op.name;
        if (op.settings && typeof op.settings === 'object') room.settings = { ...room.settings, ...op.settings };
        break;
    }
  }

  /**
   * Record a change: apply, number it, keep it for resume, append to the log.
   * Returns the op (with its seq `s`) — broadcast it as is.
   */
  commit(room, op) {
    op.s = ++room.seq;
    this._apply(room, op);
    room.ring.push(op);
    if (room.ring.length > RING) room.ring.splice(0, room.ring.length - RING);
    let appended = false;
    try {
      if (room.logFd === null) room.logFd = fs.openSync(this.file(room, '.log'), 'a');
      // After a line the disk cut short (or a power cut tore), this one starts on a line of its own: replay skips the
      // fragment and reads this op, instead of both being lost as one unreadable line.
      const line = (room.ragged ? '\n' : '') + JSON.stringify(op) + '\n';
      const n = fs.writeSync(room.logFd, line);
      if (n !== Buffer.byteLength(line)) {
        if (n > 0) room.ragged = true;
        throw new Error('the disk took ' + n + ' of ' + Buffer.byteLength(line) + ' bytes');
      }
      room.ragged = false;
      appended = true;
    } catch (e) {
      room.unsaved = true;   // the op is in memory only: the next snapshot puts it on disk
      this.lastError = e.message;
      this._closeLog(room);  // the next append opens the log again
      console.error('  log append failed for', room.code, e.message);
    }
    // A room with an op missing from its log is snapshotted as soon as the disk takes writes again.
    if (++room.logCount >= COMPACT_EVERY || (appended && room.unsaved)) this.compact(room.code);
    return op;
  }

  /** Ops after `since`, or null when the ring no longer covers the gap (send a full history instead). */
  opsSince(room, since) {
    if (!Number.isInteger(since) || since < 0 || since > room.seq) return null;
    if (since === room.seq) return [];
    const first = room.ring.length ? room.ring[0].s : room.seq + 1;
    if (since + 1 < first) return null;
    return room.ring.filter((op) => op.s > since);
  }

  /**
   * What a page opens a room with (a join that names no change it holds): its newest WINDOW messages (`history`, oldest
   * first), and of those before them only what a page keeps in view however old it is (`older`, in the room's order: every
   * pinned message, help not yet resolved and every question nobody has answered yet); whether messages before the window
   * were left out (`more`), which `before` reads; and every file of the room (`files`: its id, address, name and kind, in
   * the room's order), so a page lists them all without holding their messages. Its run of messages is bounded by the
   * window, whatever the room's whole history; what it keeps in view from before them and its file index are not, and
   * grow with the day. Each message is as a reader is sent it (asRead).
   */
  firstOpen(room, n = WINDOW) {
    const list = room.messages;
    const start = Math.max(0, list.length - n);
    const older = list.slice(0, start).filter(keptInView);
    const read = (m) => asRead(room, m);
    return { history: list.slice(start).map(read), older: older.map(read), more: older.length < start, files: list.filter((m) => m && m.type === 'file').map(fileEntry) };
  }

  /**
   * The `n` messages before a change (`beforeSeq`, a page's oldest message's seq): those before the first message whose
   * seq is it or later (all of them where none is), oldest first, each as a reader is sent it (asRead), and whether any
   * came before those that a first open does not carry (`more`): the page that reads back holds those it keeps in view
   * already (a first open's `older`, a message pinned since read with `readMessage`), so where only they are left there
   * is nothing more to show. A message kept from before messages carried their seq is read by its place, as it stands
   * among the others.
   */
  before(room, beforeSeq, n = WINDOW) {
    const list = room.messages;
    let end = list.findIndex((m) => m && Number.isInteger(m.seq) && m.seq >= beforeSeq);
    if (end < 0) end = list.length;
    const start = Math.max(0, end - n);
    let more = false;
    for (let i = 0; i < start && !more; i++) more = !keptInView(list[i]);
    return { history: list.slice(start, end).map((m) => asRead(room, m)), more };
  }

  /** One message of the room by its id, as a reader is sent it (asRead), or null where the room holds none by it. */
  readMessage(room, id) {
    const m = typeof id === 'string' && id ? room.byId.get(id) : null;
    return m ? asRead(room, m) : null;
  }

  /**
   * What a snapshot of the room holds, its fields in SNAPSHOT_FIELDS' order: the object compact() writes. Its guest code
   * and its earlier ones only when it has them, so a hall never renewed is written as 0.5.1 wrote it.
   */
  snapshotOf(room, savedAt = Date.now()) {
    const snap = { code: room.code, name: room.name || '', createdAt: room.createdAt, seq: room.seq, settings: room.settings, messages: room.messages, savedAt, gone: Array.from(room.gone.values()) };
    if (room.guestCode) snap.guestCode = room.guestCode;
    if (room.retired.length) snap.retired = room.retired.slice();
    return snap;
  }

  /**
   * Whether the room holds what its snapshot on disk does not: a line in its log (an op committed since its snapshot, or
   * one a start found there), an op its log refused (`unsaved`), a change made without an op (`markDirty`), or no
   * snapshot on disk it knows whole (one never written, or one a start found torn and fell back to the .bak for).
   */
  dirty(room) { return room.logCount > 0 || room.unsaved || room.marked || !room.snapWhole; }

  /** A change to the room made without an op (SNAPSHOT_FIELDS): its next compaction at a start or a stop writes it. */
  markDirty(room) { room.marked = true; }

  /** Keys of the dirty rooms, side rooms included. */
  dirtyCodes() { return this.allRooms().filter((r) => this.dirty(r)).map((r) => r.code); }

  /** Write the snapshot of each dirty room, side rooms included, and of no other (a start, a stop). Returns how many were written. */
  compactDirty() {
    let n = 0;
    for (const room of this.allRooms()) if (this.dirty(room) && this.compact(room.code)) n++;
    return n;
  }

  /**
   * Write the snapshot atomically and truncate the log; true when it was written. The snapshot's size is kept as
   * `room.snapKb` (null until the first one this run), so health reads a hall's size with no file call of its own. The
   * snapshot it replaces is kept as .bak unread when the store knows it whole (`snapWhole`), and read first otherwise;
   * once the new one is in place the store knows it whole, and the room is clean. A snapshot that failed leaves
   * `snapWhole` as it was (the file on disk is still the one before), and the room dirty.
   */
  compact(code) {
    const room = this.room(code);
    if (!room) return false;
    const t0 = performance.now();
    const out = this.snapshotOf(room);
    try {
      const bytes = writeFileAtomic(this.file(room, '.json'), JSON.stringify(out), { keepBak: true, knownWhole: room.snapWhole });
      room.snapWhole = true;
      this._closeLog(room);
      fs.writeFileSync(this.file(room, '.log'), '');
      room.snapKb = Math.round(bytes / 102.4) / 10;
      room.logCount = 0;
      room.unsaved = false;
      room.ragged = false;
      room.marked = false;
      this.snapshots++;
      if (!this.unsaved().length) this.lastError = null;
    } catch (e) {
      this.lastError = e.message;   // the log still holds what the snapshot did not
      console.error('  snapshot failed for', code, e.message);
      return false;
    }
    if (this.onCompact) {
      // The snapshot is written whatever its timing's reader does: a throw there never reaches the commit that asked for it.
      try { this.onCompact(performance.now() - t0, room.messages.length); } catch (e) { console.error('  a snapshot\'s time could not be noted for', code, e.message); }
    }
    return true;
  }

  _closeLog(room) {
    if (room.logFd !== null) { try { fs.closeSync(room.logFd); } catch { /* already closed: nothing to release */ } room.logFd = null; }
  }

  /** Keys of the rooms, side rooms included, holding a change that is not on disk yet. */
  unsaved() { return this.allRooms().filter((r) => r.unsaved).map((r) => r.code); }

  /**
   * Remove a room and its files: a side room alone, a hall with its side rooms (`removeHall`). Returns the rooms removed,
   * the file of each whose files stay on disk because another program held it (`kept`, each said on the console:
   * `_unlink`), and the keys of the rooms removed that load again at the next start for it (`back`) and how many
   * (`again`): what names one of those (an account given it) is left to name it, since it comes back.
   */
  remove(key) {
    if (this.rooms.has(key)) return this.removeHall(key);
    const room = this.side.get(key);
    const kept = room ? this._drop(room) : this._unlink(key);
    this._index();
    const back = room && loadsAgain(kept) ? [room.code] : [];
    return { rooms: room ? [room] : [], kept, again: back.length, back };
  }

  /**
   * Remove a hall and its files: its side rooms' first, then its Main room's, so a stop part way leaves a whole hall with
   * fewer rooms, never a side room without its hall. Returns what `remove` does, the rooms Main first. A side room whose
   * snapshot stays loads again only beside its hall, so only when the Main room's stays too.
   */
  removeHall(hall) {
    const rooms = this.roomsOf(hall);
    const sides = rooms.slice(1).map((r) => [r.code, this._drop(r)]);
    const main = rooms.length ? this._drop(rooms[0]) : this._unlink(hall);
    this._index();
    const back = loadsAgain(main) ? [hall, ...sides.filter(([, kept]) => loadsAgain(kept)).map(([code]) => code)] : [];
    return { rooms, kept: [...sides.flatMap(([, kept]) => kept), ...main], again: back.length, back };
  }

  /** Let a room go, its log closed, and remove its files; returns the files that stay (`_unlink`). */
  _drop(room) {
    this._closeLog(room);
    if (this.isMain(room)) this.rooms.delete(room.code); else this._forgetSide(room);
    return this._unlink(RoomStore.stemOf(room));
  }

  /**
   * Remove a room's files: its backup, then its snapshot, then its log. A file not there is nothing to remove. One another
   * program holds (EBUSY or EPERM on Windows: an antivirus, a backup) stops it there, said on the console: it and the
   * files after it stay, so a room whose backup or snapshot stays loads again at the next start whole, from its snapshot
   * and its log, never cut back to its backup alone (a log alone loads nothing). Returns the file it stopped at, or none.
   */
  _unlink(stem) {
    for (const ext of ['.json.bak', '.json', '.log']) {
      try { fs.unlinkSync(this._at(stem, ext)); } catch (e) {
        if (e.code === 'ENOENT') continue;   // not there: nothing to remove
        console.warn('  Could not remove ' + stem + ext + ' (' + (e.code || e.message) + '): it and the files of its room after it stay on disk');
        return [stem + ext];
      }
    }
    return [];
  }
}

/** Whether a room's files that stay (`_unlink`) load it again at the next start: they start at its backup or its snapshot. */
function loadsAgain(kept) { return kept.some((f) => !f.endsWith('.log')); }

/**
 * A room's guest code and its earlier ones as a snapshot holds them, read only where each is a code (CODE_RE) and is not
 * the room's key (an address, never a code its guests type): `{guestCode, retired}`, '' and [] for none. A snapshot
 * without them (0.5.1's, a hall never renewed) reads as none, and a hall's code is then its key.
 */
function readCodes(data, key) {
  const guestCode = typeof data.guestCode === 'string' && CODE_RE.test(data.guestCode) && data.guestCode !== key ? data.guestCode : '';
  const listed = Array.isArray(data.retired) ? data.retired.filter((c) => typeof c === 'string' && CODE_RE.test(c) && c !== guestCode) : [];
  return { guestCode, retired: [...new Set(listed)].slice(-RETIRED_KEEP) };
}

module.exports = { RoomStore, GONE_KEEP, COMPACT_EVERY, SNAPSHOT_FIELDS, SNAPSHOT_OPTIONAL, RETIRED_KEEP, CODE_RE, SIDE_RE, SIDE_MAX, WINDOW };
