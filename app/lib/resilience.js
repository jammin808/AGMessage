'use strict';
/**
 * Resilience parts with no I/O policy of their own (pure or file-only), tested in test/units.test.js:
 *   SupervisorPolicy : when the watchdog restarts the server, how long it waits, when it gives up
 *   writeFileAtomic  : tmp → fsync → rename, with a .bak kept only when the old file is whole
 *   publishOnce      : a file made only where none is: published whole, never over one that is there
 *   readText         : a file's text, or the code of why it was not read (only ENOENT means it is not there)
 *   WriteLane        : one writer for a file; bursts coalesce (latest wins); a failed write is retried until it lands
 *   Ring             : a fixed-size window of numbers with percentiles (latency, loop delay)
 *   ClockSampler     : NTP-style offset to a peer, from the exchange with the smallest round trip of the last 8
 *   placeId          : one id for one place on disk, however its path is spelled
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Exit codes with intent: what the server asks of its supervisor. */
const EXIT = Object.freeze({
  STOP: 0,          // closed on purpose (Ctrl+C, admin): stay stopped
  CONFIG: 3,        // can't run as configured (a folder, a key, the port in a portable copy): restarting would fail the same way
  CRASH: 70,        // an uncaught error: restart
  HELD: 75,         // the installed node's port or data folder is held by another program or copy: try again on the ladder, never a crash
  RESTART: 82,      // asked to restart (e.g. after an update): restart at once, not counted as a crash
});

class SupervisorPolicy {
  /**
   * @param {object} o
   * @param {number[]} [o.backoffSec] waits between crash restarts, the last repeating
   * @param {number} [o.maxCrashes] more than this many crashes inside the window → give up
   * @param {number} [o.windowMs]
   * @param {number} [o.stableMs] a run at least this long resets the backoff
   */
  constructor(o = {}) {
    // The first restart waits 0.5 s: by then a killed server's port and folder lock are free again, which the Windows job
    // shows 20 kills in a row (test/resilience.test.js). A port still held would end the start with code 3, and that
    // stops the watchdog for good, so that test is this step's gate.
    this.backoff = o.backoffSec || [0.5, 4, 8, 15, 30];
    this.maxCrashes = o.maxCrashes ?? 6;
    this.windowMs = o.windowMs ?? 10 * 60_000;
    this.stableMs = o.stableMs ?? 5 * 60_000;
    this.crashes = [];
    this.step = 0;
    this.startedAt = 0;
  }

  started(now) { this.startedAt = now; }

  /**
   * The child stopped. `hung` = the watchdog killed it for missing heartbeats.
   * Returns {action:'stop'|'restart'|'giveup', delayMs, reason}.
   */
  exited(code, now, hung = false) {
    if (!hung && code === EXIT.STOP) return { action: 'stop', delayMs: 0, reason: 'stopped' };
    if (!hung && code === EXIT.CONFIG) return { action: 'stop', delayMs: 0, reason: 'cannot start as configured (code 3)' };
    if (!hung && code === EXIT.RESTART) return { action: 'restart', delayMs: 0, reason: 'restart requested' };
    if (this.startedAt && now - this.startedAt >= this.stableMs) this.step = 0;   // it ran well: start the ladder again
    // Its port or folder held (the installed node's, which nobody at a window can free): tried again on the ladder for as
    // long as it is held, and never counted as a crash, so a copy that holds them during a restart cannot make it give up.
    if (!hung && code === EXIT.HELD) return { action: 'restart', delayMs: this._next(), reason: 'could not take its port or data folder, which another program holds (code 75)' };
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);
    const reason = hung ? 'not responding (no heartbeat)' : 'stopped unexpectedly (code ' + code + ')';
    if (this.crashes.length > this.maxCrashes) {
      return { action: 'giveup', delayMs: 0, reason: reason + ' — ' + this.crashes.length + ' times in ' + Math.round(this.windowMs / 60_000) + ' minutes' };
    }
    return { action: 'restart', delayMs: this._next(), reason };
  }

  /** The ladder's next wait, in ms; the last step repeats. */
  _next() {
    const delayMs = this.backoff[Math.min(this.step, this.backoff.length - 1)] * 1000;
    this.step++;
    return delayMs;
  }
}

/**
 * Write a file so a power cut leaves either the old or the new one, never half of either:
 * write a temporary file, flush it to the disk, then rename it over the target. With `keepBak`, the old
 * file is kept as `.bak` — but only when it is whole, so a torn file never replaces a good backup. It is whole when the
 * caller says so with `knownWhole` (the file is one it wrote itself, or read whole: only the one writer of the file
 * may say it), and then it is copied unread; otherwise it is read, and kept only when `worthKeeping(oldText)` says it
 * is whole. Every byte reaches the temporary file or the write throws: a disk that fills part-way
 * never has a short file renamed over a whole one. A write that throws removes its temporary file, so it does not
 * keep the disk full. Returns the number of bytes written.
 */
function writeFileAtomic(file, data, { keepBak = false, knownWhole = false, worthKeeping = isJson, mode } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  const bytes = Buffer.from(data);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      for (let off = 0; off < bytes.length;) {
        const n = fs.writeSync(fd, bytes, off, bytes.length - off);
        if (!(n > 0)) throw new Error('the disk took ' + off + ' of ' + bytes.length + ' bytes');
        off += n;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (keepBak) {
      try {
        if (knownWhole || worthKeeping(fs.readFileSync(file, 'utf8'))) fs.copyFileSync(file, file + '.bak');
      } catch { /* no old file yet */ }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never made, or already gone */ }
    throw e;
  }
  return bytes.length;
}

function isJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Publish a file that is never written over: its bytes whole in a temporary file (fsynced), then a hard link into place,
 * which fails when a file is already there. Returns true when this call published it, false when one was there (the
 * caller reads that one). In a folder this copy holds (`held`), where nothing else of AGMessage writes, a drive that
 * cannot hold a hard link (FAT, exFAT) publishes it by the atomic writer's rename instead. Any other failure throws.
 * The temporary file is removed either way.
 */
function publishOnce(file, data, { mode, held = false } = {}) {
  const fresh = file + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.new';
  writeFileAtomic(fresh, data, { mode });
  let published = null;
  try {
    fs.linkSync(fresh, file);
    published = true;
  } catch (e) {
    if (e.code === 'EEXIST') published = false;
    else if (!held) throw e;
  } finally {
    try { fs.unlinkSync(fresh); } catch { /* gone already: the link or the rename took its place */ }
  }
  if (published === null) {
    writeFileAtomic(file, data, { mode });
    published = true;
  }
  return published;
}

/**
 * A file's text: `{text, code}`, `code` '' when it was read, else why it was not (only 'ENOENT' says the file is not
 * there; EBUSY, EACCES or EISDIR say nothing of what it holds). Never throws.
 */
function readText(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), code: '' }; } catch (e) { return { text: null, code: e.code || 'EIO' }; }
}

/**
 * Read a JSON file, falling back to its .bak when the file is missing or torn: `{data, whole}`, `data` null when
 * neither parses, and `whole` true only when the file itself parsed, so its writer may keep it as `.bak` unread
 * (`knownWhole`). A file that fell back to its .bak is not whole: its next save reads it before it may replace the .bak.
 * `codes` is why each of the two was not read ('' when it was, whether it parsed or not).
 */
function readJsonWhole(file) {
  const tries = [file, file + '.bak'];
  const codes = [];
  for (let i = 0; i < tries.length; i++) {
    const r = readText(tries[i]);
    codes.push(r.code);
    if (r.code) continue;
    try { return { data: JSON.parse(r.text), whole: i === 0, codes }; } catch { /* torn: the next */ }
  }
  return { data: null, whole: false, codes };
}

/** Read a JSON file, falling back to its .bak when the file is missing or torn. */
function readJsonWithBak(file) { return readJsonWhole(file).data; }

/**
 * One writer for one file. `save(produce)` asks for a write; bursts coalesce (only the latest
 * content is written) and writes never overlap or land out of order. A write that fails (a file another program holds,
 * a full disk) keeps its content and is tried again on its own, sooner at first, then every 30 s at most, until it
 * lands; `lastError` says why it has not. `flushSync()` writes what is pending at once (shutdown) and returns false
 * when it still cannot. A lane that keeps a set of small files together (`files: true`) is given [[file, text], …] by
 * `produce`, and writes each atomically, in that order.
 *
 * `WriteLane.built` counts every lane this process has made, wherever it was made: health carries it beside the
 * distinct lanes the server flushes at a stop or a crash, and a test holds the two equal, so no store has a lane
 * nothing flushes.
 */
class WriteLane {
  static #built = 0;

  constructor(file, { delayMs = 200, keepBak = true, mode, files = false } = {}) {
    this.file = file; this.delayMs = delayMs; this.keepBak = keepBak; this.mode = mode; this.files = files;
    this.pending = null;      // () => string, the latest content
    this.timer = null;
    this.writes = 0; this.coalesced = 0; this.lastError = null; this.failures = 0;
    this.onSaved = null;      // told after each write that landed
    WriteLane.#built++;
  }

  /** How many lanes this process has made, in any file. */
  static get built() { return WriteLane.#built; }

  save(produce) {
    if (this.pending) this.coalesced++;
    this.pending = produce;
    if (!this.timer) {
      this.timer = setTimeout(() => this._run(), this.delayMs);
      this.timer.unref();
    }
  }

  _run() {
    this.timer = null;
    const produce = this.pending;
    this.pending = null;
    if (!produce) return;
    try {
      const content = produce();
      if (this.files) for (const [file, text] of content) writeFileAtomic(file, text, { keepBak: this.keepBak, mode: this.mode });
      else writeFileAtomic(this.file, content, { keepBak: this.keepBak, mode: this.mode });
      this.writes++;
      this.lastError = null;
      this.failures = 0;
      if (this.onSaved) this.onSaved();
    } catch (e) {
      this.lastError = e.message;
      this.failures++;
      console.error('  save failed for', path.basename(this.file) + ' (' + this.failures + '×, kept and tried again):', e.message);
      // `produce` reads the live state, so the retry writes whatever is newest by then.
      if (!this.pending) this.pending = produce;
      if (!this.timer) {
        this.timer = setTimeout(() => this._run(), Math.min(30_000, 1000 * 2 ** (this.failures - 1)));
        this.timer.unref();
      }
    }
  }

  /** Write whatever is pending now, trying three times. Returns true when nothing is left unwritten. */
  flushSync() {
    for (let i = 0; i < 3 && this.pending; i++) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this._run();
    }
    return this.pending === null;
  }
}

/** A fixed-size window of numbers: no allocation once full. Its stats keep `digits` decimals (a fraction such as ELU needs 3). */
class Ring {
  constructor(size = 120, digits = 1) { this.buf = new Float64Array(size); this.n = 0; this.i = 0; this.f = 10 ** digits; }
  push(v) { if (!Number.isFinite(v)) return; this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++; }
  get count() { return this.n; }
  last() { return this.n ? this.buf[(this.i - 1 + this.buf.length) % this.buf.length] : null; }
  stats() {
    if (!this.n) return { count: 0, p50: null, p95: null, max: null };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
    const round = (v) => Math.round(v * this.f) / this.f;
    return { count: this.n, p50: round(at(0.5)), p95: round(at(0.95)), max: round(a[a.length - 1]) };
  }
}

/**
 * Clock offset to a peer from ping exchanges (Show Bus §5): offset = ((t2 − t1) + (t3 − t4)) / 2,
 * rtt = (t4 − t1) − (t3 − t2); the sample with the smallest rtt of the last 8 wins.
 */
class ClockSampler {
  constructor(keep = 8) { this.keep = keep; this.samples = []; }
  add(t1, t2, t3, t4) {
    if (![t1, t2, t3, t4].every(Number.isFinite) || t4 < t1) return null;
    const rtt = (t4 - t1) - (t3 - t2);
    if (rtt < 0) return null;
    const offset = ((t2 - t1) + (t3 - t4)) / 2;
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.keep) this.samples.shift();
    return this.best();
  }
  best() {
    if (!this.samples.length) return null;
    const b = this.samples.reduce((m, s) => (s.rtt < m.rtt ? s : m));
    return { offsetMs: Math.round(b.offset), rttMs: Math.round(b.rtt), apart: Math.abs(b.offset) > 2000 };
  }
  reset() { this.samples = []; }
}

/**
 * One id for one place on disk: 16 hex characters of the SHA-256 of the folder's real path (joined with `name` when one
 * is given), lower-cased on Windows. A junction, a `subst` drive, a short name or a symbolic link to the folder give the
 * same id; a folder whose real path cannot be read is taken by its path as given, and that is said once, except for a
 * folder not made yet when its caller makes it later (`absentOk`): there is nothing to say of it.
 */
function placeId(dir, name, { absentOk = false } = {}) {
  let real;
  try { real = fs.realpathSync.native(dir); } catch (e) {
    real = path.resolve(dir);
    if (!(absentOk && e.code === 'ENOENT')) console.warn('  [folder] ' + real + ' is taken by its path as given: its real path could not be read (' + (e.code || e.message) + ')');
  }
  const p = name ? path.join(real, name) : real;
  return crypto.createHash('sha256').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 16);
}

module.exports = { EXIT, SupervisorPolicy, writeFileAtomic, publishOnce, readText, readJsonWhole, readJsonWithBak, isJson, WriteLane, Ring, ClockSampler, placeId };
