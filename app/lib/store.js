'use strict';
/**
 * Room store: every change is an operation with a per-room sequence number, appended to an
 * append-only log (data/rooms/<CODE>.log, one JSON line per op) — O(1) per change instead of
 * rewriting the whole room — and compacted into the snapshot (<CODE>.json) every N ops, at boot
 * and at shutdown. A torn last line (power cut mid-write) is skipped, never fatal.
 *
 * Recent ops stay in memory (a ring per room), so a client that drops off for a moment resumes
 * with just what it missed (`opsSince(seq)`) instead of reloading the whole history — the game
 * netcode pattern: sequence numbers, deltas while they cover the gap, a full snapshot otherwise.
 *
 * Ops: {o:'add', m} {o:'upd', id, f} {o:'del', id} {o:'reset'} {o:'meta', name}
 *
 * Durability: the op append is synchronous on purpose (an acknowledged message is on disk). A snapshot is written
 * tmp -> fsync -> rename, keeping the previous snapshot as .bak only when it parses, and a torn snapshot falls back
 * to the .bak on load — the log is replayed on top of whichever loaded.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonWithBak } = require('./resilience');

const RING = 2000;          // ops kept in memory per room for resume
const COMPACT_EVERY = 500;  // ops between snapshots
const CODE_RE = /^[A-Z0-9]{4,12}$/;

class RoomStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.rooms = new Map();
    this.lastError = null;   // the last append or snapshot that failed, until every room is on disk again
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
    // A room whose snapshot was lost mid-rename still has its .bak: both name the room.
    const codes = new Set(fs.readdirSync(this.dir).map((f) => (/^(.+)\.json(\.bak)?$/.exec(f) || [])[1]).filter(Boolean));
    for (const code of codes) {
      if (!RoomStore.validCode(code)) continue;
      try {
        const data = readJsonWithBak(this.file(code, '.json'));
        if (!data) throw new Error('snapshot and its backup are both unreadable');
        const room = this._blank(code, typeof data.name === 'string' ? data.name : '', data.createdAt || Date.now());
        room.messages = Array.isArray(data.messages) ? data.messages.filter((m) => m && typeof m.id === 'string') : [];
        room.seq = Number.isInteger(data.seq) ? data.seq : room.messages.length;
        room.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
        for (const m of room.messages) room.byId.set(m.id, m);
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
    return { code, name, createdAt, messages: [], byId: new Map(), seq: 0, ring: [], users: new Map(), settings: {}, logCount: 0, logFd: null, unsaved: false };
  }

  _replay(room) {
    const logPath = this.file(room.code, '.log');
    if (!fs.existsSync(logPath)) return;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
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

  create(code, name) {
    const room = this._blank(code, name || '', Date.now());
    this.rooms.set(code, room);
    this.compact(code);
    return room;
  }

  /** Apply an op to the in-memory room (no I/O). */
  _apply(room, op) {
    switch (op.o) {
      case 'add':
        if (room.byId.has(op.m.id)) return;
        room.messages.push(op.m);
        room.byId.set(op.m.id, op.m);
        break;
      case 'upd': {
        const m = room.byId.get(op.id);
        if (m) Object.assign(m, op.f);
        break;
      }
      case 'del': {
        const i = room.messages.findIndex((m) => m.id === op.id);
        if (i >= 0) room.messages.splice(i, 1);
        room.byId.delete(op.id);
        break;
      }
      case 'reset':
        room.messages = [];
        room.byId.clear();
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
      const line = JSON.stringify(op) + '\n';
      const n = fs.writeSync(room.logFd, line);
      if (n !== Buffer.byteLength(line)) throw new Error('the disk took ' + n + ' of ' + Buffer.byteLength(line) + ' bytes');
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

  /** Write the snapshot atomically and truncate the log. */
  compact(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    const out = { code: room.code, name: room.name || '', createdAt: room.createdAt, seq: room.seq, settings: room.settings, messages: room.messages, savedAt: Date.now() };
    try {
      writeFileAtomic(this.file(code, '.json'), JSON.stringify(out), { keepBak: true });
      this._closeLog(room);
      fs.writeFileSync(this.file(code, '.log'), '');
      room.logCount = 0;
      room.unsaved = false;
      if (!this.unsaved().length) this.lastError = null;
    } catch (e) {
      this.lastError = e.message;   // the log still holds what the snapshot did not
      console.error('  snapshot failed for', code, e.message);
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

module.exports = { RoomStore };
