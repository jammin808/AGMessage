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
 * netcode pattern: sequence numbers, deltas while they cover the gap, a full snapshot otherwise.
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
});

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
  /** `make: false`: the folder is not made here (a server makes it once it holds its data folder, and loads before). */
  constructor(dir, { make = true } = {}) {
    this.dir = dir;
    if (make) fs.mkdirSync(dir, { recursive: true });
    this.rooms = new Map();  // the halls (their Main rooms), by key
    this.side = new Map();   // the side rooms, by key: reached only through the any-room readers
    // Each hall's side rooms, in the order they were made (`roomsOf`), so a hall's rooms are read without a walk of every
    // side room of every hall; kept with `side`, which holds the same rooms by key.
    this.sideByHall = new Map();
    this.lastError = null;  // the last append or snapshot that failed, until every room is on disk again
    this.snapshots = 0;      // snapshots written this run (health)
    // What the last load found on disk, which a stop that saved never leaves: the rooms whose log held lines, and the
    // newest snapshot's `savedAt` (lib/laststop.js `judge` reads a stop's record against them).
    this.found = { lines: 0, newest: 0 };
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
    return n;
  }

  /** Load one room, a hall when `hall` is its own key and a side room of `hall` otherwise; true when it loaded. */
  _load(code, hall, onMigrate, compact) {
    const stem = hall === code ? code : hall + '.' + code;
    try {
      const { data, whole } = readJsonWhole(this._at(stem, '.json'));
      if (!data) throw new Error('snapshot and its backup are both unreadable');
      const room = this._blank(code, typeof data.name === 'string' ? data.name : '', data.createdAt || Date.now(), { hall });
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

  _blank(code, name, createdAt, { hall = code } = {}) {
    return {
      code, hall, name, createdAt, messages: [], byId: new Map(), byCid: new Map(), gone: new Map(), goneKeys: new Map(), seq: 0, ring: [],
      users: new Map(), settings: {}, logCount: 0, logFd: null, unsaved: false, ragged: false, snapKb: null, snapWhole: false, marked: false,
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

  create(code, name) {
    const room = this._blank(code, name || '', Date.now());
    this.rooms.set(code, room);
    this.compact(code);
    return room;
  }

  /**
   * Make a side room of `hall` under `key`: its first snapshot is written at once, as a hall's is, its guest code off
   * (`codeOff`) unless `settings` says otherwise, so a new room is for accounts until it is switched on. Null when
   * refused: no such hall, a key that is no key or that a room has already, or a hall with SIDE_MAX side rooms.
   */
  createIn(hall, key, name, { settings = {} } = {}) {
    if (!this.rooms.has(hall) || !RoomStore.validCode(key) || this.hasRoom(key)) return null;
    if (this._sidesOf(hall).length >= SIDE_MAX) return null;
    const room = this._blank(key, name || '', Date.now(), { hall });
    room.settings = { codeOff: true, ...(settings && typeof settings === 'object' ? settings : {}) };
    this._keepSide(room);
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
        break;
      }
      case 'reset':
        // A system line is nobody's send and no delete can name one: only what people wrote leaves a tombstone, the
        // newest GONE_KEEP of them.
        for (const m of room.messages.filter((x) => x.type !== 'system').slice(-GONE_KEEP)) this._tomb(room, m);
        room.messages = [];
        room.byId.clear();
        room.byCid.clear();
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

  /** What a snapshot of the room holds, its fields in SNAPSHOT_FIELDS' order: the object compact() writes. */
  snapshotOf(room, savedAt = Date.now()) {
    return { code: room.code, name: room.name || '', createdAt: room.createdAt, seq: room.seq, settings: room.settings, messages: room.messages, savedAt, gone: Array.from(room.gone.values()) };
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
   * `_unlink`) and how many of the rooms removed load again at the next start for it (`again`).
   */
  remove(key) {
    if (this.rooms.has(key)) return this.removeHall(key);
    const room = this.side.get(key);
    const kept = room ? this._drop(room) : this._unlink(key);
    return { rooms: room ? [room] : [], kept, again: room && loadsAgain(kept) ? 1 : 0 };
  }

  /**
   * Remove a hall and its files: its side rooms' first, then its Main room's, so a stop part way leaves a whole hall with
   * fewer rooms, never a side room without its hall. Returns what `remove` does, the rooms Main first. A side room whose
   * snapshot stays loads again only beside its hall, so only when the Main room's stays too.
   */
  removeHall(hall) {
    const rooms = this.roomsOf(hall);
    const sides = rooms.slice(1).map((r) => this._drop(r));
    const main = rooms.length ? this._drop(rooms[0]) : this._unlink(hall);
    return { rooms, kept: [...sides.flat(), ...main], again: loadsAgain(main) ? 1 + sides.filter(loadsAgain).length : 0 };
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

module.exports = { RoomStore, GONE_KEEP, COMPACT_EVERY, SNAPSHOT_FIELDS, CODE_RE, SIDE_RE, SIDE_MAX };
