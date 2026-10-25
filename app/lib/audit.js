'use strict';
/**
 * The audit log: who did what, when, from where — sign-ins, rights, halls, displays, sends to Stagewatch, commands to
 * other show systems, settings. Append-only (data/audit.jsonl, one JSON line per entry) and hash-chained, as a medical
 * device's audit trail is: each entry carries the SHA-256 of the one before it and of itself.
 *
 * One chain from the genesis hash across files: at 20 MB the file is renamed audit-<time>.jsonl and the chain goes on in
 * a new audit.jsonl. `verify()` reads the rotated files oldest first, then this one, so an edited, removed or reordered
 * line breaks the chain at that line — the first and the last included — and it names the file and the line; the
 * newest entry on disk must also be the one this server wrote last. A chain without a key cannot show the newest lines
 * removed while the server is stopped, or the whole chain rewritten: that is said where the log is described.
 *
 * Written synchronously and flushed: an entry is on disk (fsync) before the action is acknowledged. When the disk will
 * not take it (full, or the file held by another program) the entry stays chained in memory, the console and health say
 * so, and it is written ahead of the next one, so the chain on disk stays whole. A half-written last line left by a
 * power cut is cut when the log is opened, and the cut is an entry of its own ('audit.repair'). Nothing is written until
 * the first `write()` or `open()`: a second copy of the server reading the folder changes nothing.
 *
 * Never a secret: passwords, tokens, keys and display URLs are not fields an entry can carry (the caller passes words
 * and ids, and `write()` keeps only the listed fields, each cut short).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROTATE_BYTES = 20 * 1024 * 1024;
const GENESIS = '0'.repeat(64);
const SLICE = 1000;        // lines checked between turns of the event loop
const ROTATED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const canonical = (e) => JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, words: e.words, ip: e.ip, prev: e.prev });
const hashOf = (e) => crypto.createHash('sha256').update(canonical(e)).digest('hex');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v === undefined || v === null ? '' : String(v).slice(0, n));
const readOr = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const turn = () => new Promise((resolve) => { setImmediate(resolve); });
const missing = (from, to) => (from === to ? 'entry ' + from + ' is missing' : 'entries ' + from + ' to ' + to + ' are missing');

/** The whole lines of a buffer as [text, line number], without one big string; a last line with no newline is not whole yet. */
function* wholeLines(buf) {
  let start = 0;
  let n = 0;
  for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
    n++;
    if (nl > start) yield [buf.toString('utf8', start, nl), n];
    start = nl + 1;
  }
}

class AuditLog {
  constructor(file) {
    this.file = file;
    this.stem = path.basename(file).replace(/\.jsonl$/, '');
    this.seq = 0;
    this.last = GENESIS;
    this.onDisk = { seq: 0, h: GENESIS };   // the newest entry known to be on disk
    this.recent = [];       // the last 500 entries, newest last, for the admin page
    this.pending = '';      // whole lines chained but not yet on disk, written ahead of the next entry
    this.unwritten = 0;     // entries in `pending`
    this.lastError = null;  // why the last write did not reach the disk, until one does
    this.rotations = 0;
    this.opened = false;
    this.checking = null;   // the check running now: a second click shares it
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let buf = readOr(file) || Buffer.alloc(0);
    const whole = buf.lastIndexOf(10) + 1;
    this.torn = buf.length - whole;     // a last line without its newline (a power cut mid-append): cut at open()
    buf = buf.subarray(0, whole);
    this.size = whole;
    // A file with no entry yet (a rotation the power cut interrupted) goes on from the newest rotated file.
    if (!this._load(buf)) { const older = this.rotated().pop(); if (older) this._load(readOr(older) || Buffer.alloc(0)); }
  }

  /** Take the newest 500 entries and the chain's tail from a log's text. Returns whether it held an entry. */
  _load(buf) {
    const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(-500);
    const recent = [];
    for (const line of lines) { try { recent.push(JSON.parse(line)); } catch { /* not a whole entry: verify() reports it */ } }
    const tail = recent[recent.length - 1];
    if (!(tail && Number.isInteger(tail.seq) && /^[0-9a-f]{64}$/.test(tail.h || ''))) return false;
    this.recent = recent;
    this.seq = tail.seq; this.last = tail.h;
    this.onDisk = { seq: tail.seq, h: tail.h };
    return true;
  }

  /** The rotated files beside this one, oldest first (their names sort by time). */
  rotated() {
    const dir = path.dirname(this.file);
    const prefix = this.stem + '-';
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no folder: no rotated files */ }
    return names.filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl') && ROTATED_TIME.test(f.slice(prefix.length, -6))).sort().map((f) => path.join(dir, f));
  }

  /** Take the log for writing (the first write does this): a half-written last line is cut, and the cut recorded. */
  open() {
    if (this.opened) return;
    this.opened = true;
    if (!this.torn) return;
    const cut = this.torn;
    this.torn = 0;
    try { fs.truncateSync(this.file, this.size); } catch (err) {
      this.pending = '\n';   // the fragment cannot be cut: end it, so the next entry is a line of its own
      console.error('  [audit] could not cut a half-written last line: ' + err.message);
    }
    this.write({ t: 'system' }, 'audit.repair', '', 'a half-written last line (' + cut + ' bytes) was cut after an unclean stop');
  }

  /**
   * Record one action. `actor` {t:'account'|'admin'|'code'|'display'|'node'|'system', id, name}; `target` what it acted
   * on (an id, a username, a hall code); `words` what happened, in plain words, never a secret.
   */
  write(actor, action, target = '', words = '', ip = '') {
    this.open();
    const e = {
      seq: this.seq + 1, at: Date.now(),
      actor: { t: str(actor && actor.t, 12) || 'system', id: str(actor && actor.id, 40), name: str(actor && actor.name, 60) },
      action: str(action, 40), target: str(target, 80), words: str(words, 300), ip: str(ip, 64), prev: this.last,
    };
    e.h = hashOf(e);
    this.seq = e.seq; this.last = e.h;
    this.pending += JSON.stringify(e) + '\n';
    this.unwritten++;
    this.recent.push(e);
    if (this.recent.length > 500) this.recent.shift();
    this._put();
    return e;
  }

  /** Put every pending line on disk in one append, or none of them. */
  _put() {
    if (this.size > ROTATE_BYTES) this._rotate();
    let fd = null;
    try {
      // Written at the file's end through a handle that can also cut it back: Windows does not truncate through a
      // handle opened for appending, so there a short write would stay as a fragment the next entry is glued to.
      fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
      const before = fs.fstatSync(fd).size;
      const bytes = Buffer.from(this.pending);
      const n = fs.writeSync(fd, bytes, 0, bytes.length, before);
      if (n !== bytes.length) { fs.ftruncateSync(fd, before); throw new Error('the disk took ' + n + ' of ' + bytes.length + ' bytes'); }
      this.size = before + n;
      this.pending = ''; this.unwritten = 0;
      this.onDisk = { seq: this.seq, h: this.last };
      fs.fsyncSync(fd);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.error('  [audit] could not write' + (this.unwritten ? ' (' + this.unwritten + ' kept, written ahead of the next entry)' : '') + ': ' + err.message);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* the write itself said what went wrong */ } }
    }
  }

  /** Rename the full file aside; the chain goes on in a new one. A rename that fails leaves it growing, and is tried again. */
  _rotate() {
    try {
      fs.renameSync(this.file, path.join(path.dirname(this.file), this.stem + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl'));
      this.size = 0;
      this.rotations++;
    } catch (err) {
      if (err.code === 'ENOENT') this.size = 0;
      else console.error('  [audit] could not rotate (written on in ' + path.basename(this.file) + '): ' + err.message);
    }
  }

  /** The newest `limit` entries, newest first. */
  latest(limit = 200) { return this.recent.slice(-Math.max(1, Math.min(500, limit))).reverse(); }

  /**
   * Check the whole chain, rotated files included: {ok, entries, file?, brokenAt?, why?, unwritten?}. It reads the files
   * off the event loop and checks them in slices, so the show goes on while it runs; calls while one runs share it.
   */
  verify() {
    if (!this.checking) this.checking = this._verify().finally(() => { this.checking = null; });
    return this.checking;
  }

  async _verify() {
    const rotations = this.rotations;
    const expect = { ...this.onDisk };
    const files = [...this.rotated(), this.file];
    let prev = { seq: 0, h: GENESIS };
    let entries = 0;
    let lineCount = 0;
    let checked = 0;
    for (const f of files) {
      let buf;
      try { buf = await fs.promises.readFile(f); } catch (err) {
        if (f !== this.file || err.code !== 'ENOENT') return { ok: false, entries, file: path.basename(f), brokenAt: 0, why: 'the file could not be read: ' + err.code };
        buf = Buffer.alloc(0);
      }
      lineCount = 0;
      const at = (n, why) => ({ ok: false, entries, file: path.basename(f), brokenAt: n, why });
      for (const [text, n] of wholeLines(buf)) {
        lineCount = n;
        if (++checked % SLICE === 0) await turn();
        let e;
        try { e = JSON.parse(text); } catch { return at(n, 'line ' + n + ' is not a whole entry'); }
        if (!e || typeof e !== 'object') return at(n, 'line ' + n + ' is not a whole entry');
        if (e.seq !== prev.seq + 1) return at(n, Number.isInteger(e.seq) && e.seq > prev.seq + 1 ? missing(prev.seq + 1, e.seq - 1) + ' before entry ' + e.seq : 'entry ' + e.seq + ' is out of order');
        if (e.prev !== prev.h) return at(n, 'entry ' + e.seq + ' does not follow the one before it');
        if (hashOf(e) !== e.h) return at(n, 'entry ' + e.seq + ' was changed after it was written');
        prev = e;
        entries++;
      }
    }
    if (this.rotations !== rotations) return this._verify();   // a rotation moved the files under the check: read them again
    const tail = { ok: false, entries, file: path.basename(this.file), brokenAt: lineCount + 1 };
    if (prev.seq < expect.seq) return { ...tail, why: (prev.seq ? 'after entry ' + prev.seq + ', ' : '') + missing(prev.seq + 1, expect.seq) + ' (the newest written)' };
    if (prev.seq === expect.seq && prev.h !== expect.h) return { ...tail, why: 'the newest entry is not the one this server wrote last' };
    return { ok: true, entries, ...(this.unwritten ? { unwritten: this.unwritten } : {}) };
  }
}

module.exports = { AuditLog, hashOf, GENESIS };
