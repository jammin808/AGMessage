'use strict';
/**
 * Room store: every change is an operation with a per-room sequence number, appended to an
 * append-only log (data/rooms/<CODE>.log, one JSON line per op) — O(1) per change instead of
 * rewriting the whole room — and compacted into the snapshot (<CODE>.json) every N ops, at boot
 * and at shutdown. A torn last line (power cut mid-write, or a disk that took only part of it) is skipped, never
 * fatal, and the next append starts on a line of its own, so the op after it is never lost with it.
 *
 * Recent ops stay in memory (a ring per room), so a client that drops off for a moment resumes
 * with just what it missed (`opsSince(seq)`) instead of reloading the whole history — the game
 * netcode pattern: sequence numbers, deltas while they cover the gap, a full snapshot otherwise.
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
const GONE_KEEP = 500;      // tombstones kept per room, the newest

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
    this.rooms = new Map();
    this.lastError = null;   // the last append or snapshot that failed, until every room is on disk again
    // Told of each snapshot written: (ms it took — the stall a commit waits — the room's message count). Health's peaks.
    this.onCompact = null;
  }

  static validCode(code) { return typeof code === 'string' && CODE_RE.test(code); }

  file(code, ext) { return path.join(this.dir, code + ext); }

  /**
   * Load every room: snapshot + replay of its log. Returns the number loaded. With `compact: false` nothing is written
   * (a server that does not yet own its port must not touch the files another copy may be appending to); the caller
   * compacts once it does.
   */
  loadAll(onMigrate, { compact = true } = {}) {
    let n = 0;
    // A room whose snapshot was lost mid-rename still has its .bak: both name the room. A folder not made yet holds none;
    // one that cannot be read throws, with its code.
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const codes = new Set(names.map((f) => (/^(.+)\.json(\.bak)?$/.exec(f) || [])[1]).filter(Boolean));
    for (const code of codes) {
      if (!RoomStore.validCode(code)) continue;
      try {
        const { data, whole } = readJsonWhole(this.file(code, '.json'));
        if (!data) throw new Error('snapshot and its backup are both unreadable');
        const room = this._blank(code, typeof data.name === 'string' ? data.name : '', data.createdAt || Date.now());
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
        if (onMigrate) onMigrate(room);
        this.rooms.set(code, room);
        if (compact) this.compact(code);   // fold the replayed log into a fresh snapshot
        n++;
      } catch (e) {
        console.warn('  Failed to load room', code, e.message);
      }
    }
    return n;
  }

  _blank(code, name, createdAt) {
    return {
      code, name, createdAt, messages: [], byId: new Map(), byCid: new Map(), gone: new Map(), goneKeys: new Map(), seq: 0, ring: [],
      users: new Map(), settings: {}, logCount: 0, logFd: null, unsaved: false, ragged: false, snapKb: null, snapWhole: false,
    };
  }

  _replay(room) {
    const logPath = this.file(room.code, '.log');
    if (!fs.existsSync(logPath)) return;
    const text = fs.readFileSync(logPath, 'utf8');
    room.ragged = text.length > 0 && !text.endsWith('\n');   // a torn last line: the next append ends it first
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }   // torn write: skip
      if (!op || typeof op.s !== 'number' || op.s <= room.seq) continue;
      this._apply(room, op);
      room.seq = op.s;
    }
  }

  get(code) { return this.rooms.get(code); }
  has(code) { return this.rooms.has(code); }

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
      if (room.logFd === null) room.logFd = fs.openSync(this.file(room.code, '.log'), 'a');
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
   * Write the snapshot atomically and truncate the log. The snapshot's size is kept as `room.snapKb` (null until the
   * first one this run), so health reads a hall's size with no file call of its own. The snapshot it replaces is kept as
   * .bak unread when the store knows it whole (`snapWhole`), and read first otherwise; once the new one is in place the
   * store knows it whole. A snapshot that failed leaves `snapWhole` as it was: the file on disk is still the one before.
   */
  compact(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    const t0 = performance.now();
    const out = { code: room.code, name: room.name || '', createdAt: room.createdAt, seq: room.seq, settings: room.settings, messages: room.messages, savedAt: Date.now(), gone: Array.from(room.gone.values()) };
    try {
      const bytes = writeFileAtomic(this.file(code, '.json'), JSON.stringify(out), { keepBak: true, knownWhole: room.snapWhole });
      room.snapWhole = true;
      this._closeLog(room);
      fs.writeFileSync(this.file(code, '.log'), '');
      room.snapKb = Math.round(bytes / 102.4) / 10;
      room.logCount = 0;
      room.unsaved = false;
      room.ragged = false;
      if (!this.unsaved().length) this.lastError = null;
    } catch (e) {
      this.lastError = e.message;   // the log still holds what the snapshot did not
      console.error('  snapshot failed for', code, e.message);
      return;
    }
    if (this.onCompact) {
      // The snapshot is written whatever its timing's reader does: a throw there never reaches the commit that asked for it.
      try { this.onCompact(performance.now() - t0, room.messages.length); } catch (e) { console.error('  a snapshot\'s time could not be noted for', code, e.message); }
    }
  }

  compactAll() { for (const code of this.rooms.keys()) this.compact(code); }

  _closeLog(room) {
    if (room.logFd !== null) { try { fs.closeSync(room.logFd); } catch { /* already closed: nothing to release */ } room.logFd = null; }
  }

  /** Codes of the rooms holding a change that is not on disk yet. */
  unsaved() { return Array.from(this.rooms.values()).filter((r) => r.unsaved).map((r) => r.code); }

  /** Remove a room and its files. */
  remove(code) {
    const room = this.rooms.get(code);
    if (room) this._closeLog(room);
    this.rooms.delete(code);
    for (const ext of ['.json', '.log', '.json.bak']) { try { fs.unlinkSync(this.file(code, ext)); } catch { /* ignore */ } }
  }
}

module.exports = { RoomStore, GONE_KEEP };
