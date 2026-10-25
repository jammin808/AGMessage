'use strict';
/**
 * Resilience parts with no I/O policy of their own (pure or file-only), tested in test/units.test.js:
 *   SupervisorPolicy : when the watchdog restarts the server, how long it waits, when it gives up
 *   writeFileAtomic  : tmp → fsync → rename, with a .bak kept only when the old file is whole
 *   WriteLane        : one writer for a file; bursts coalesce (latest wins); a failed write is retried until it lands
 *   Ring             : a fixed-size window of numbers with percentiles (latency, loop delay)
 *   ClockSampler     : NTP-style offset to a peer, from the exchange with the smallest round trip of the last 8
 */
const fs = require('fs');
const path = require('path');

/** Exit codes with intent: what the server asks of its supervisor. */
const EXIT = Object.freeze({
  STOP: 0,          // closed on purpose (Ctrl+C, admin): stay stopped
  CONFIG: 3,        // can't run as configured (port in use): restarting would fail the same way
  CRASH: 70,        // an uncaught error: restart
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
    this.backoff = o.backoffSec || [2, 4, 8, 15, 30];
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
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);
    const reason = hung ? 'not responding (no heartbeat)' : 'stopped unexpectedly (code ' + code + ')';
    if (this.crashes.length > this.maxCrashes) {
      return { action: 'giveup', delayMs: 0, reason: reason + ' — ' + this.crashes.length + ' times in ' + Math.round(this.windowMs / 60_000) + ' minutes' };
    }
    const delayMs = this.backoff[Math.min(this.step, this.backoff.length - 1)] * 1000;
    this.step++;
    return { action: 'restart', delayMs, reason };
  }
}

/**
 * Write a file so a power cut leaves either the old or the new one, never half of either:
 * write a temporary file, flush it to the disk, then rename it over the target. With `keepBak`, the old
 * file is kept as `.bak` — but only when `worthKeeping(oldText)` says it is whole, so a torn file never
 * replaces a good backup. Every byte reaches the temporary file or the write throws: a disk that fills part-way
 * never has a short file renamed over a whole one. A write that throws removes its temporary file, so it does not
 * keep the disk full.
 */
function writeFileAtomic(file, data, { keepBak = false, worthKeeping = isJson, mode } = {}) {
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
        const old = fs.readFileSync(file, 'utf8');
        if (worthKeeping(old)) fs.copyFileSync(file, file + '.bak');
      } catch { /* no old file yet */ }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never made, or already gone */ }
    throw e;
  }
}

function isJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Read a JSON file, falling back to its .bak when the file is missing or torn. */
function readJsonWithBak(file) {
  for (const f of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* next */ }
  }
  return null;
}

/**
 * One writer for one file. `save(produce)` asks for a write; bursts coalesce (only the latest
 * content is written) and writes never overlap or land out of order. A write that fails (a file another program holds,
 * a full disk) keeps its content and is tried again on its own, sooner at first, then every 30 s at most, until it
 * lands; `lastError` says why it has not. `flushSync()` writes what is pending at once (shutdown) and returns false
 * when it still cannot.
 */
class WriteLane {
  constructor(file, { delayMs = 200, keepBak = true, mode } = {}) {
    this.file = file; this.delayMs = delayMs; this.keepBak = keepBak; this.mode = mode;
    this.pending = null;      // () => string, the latest content
    this.timer = null;
    this.writes = 0; this.coalesced = 0; this.lastError = null; this.failures = 0;
  }

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
      writeFileAtomic(this.file, produce(), { keepBak: this.keepBak, mode: this.mode });
      this.writes++;
      this.lastError = null;
      this.failures = 0;
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

/** A fixed-size window of numbers: no allocation once full. */
class Ring {
  constructor(size = 120) { this.buf = new Float64Array(size); this.n = 0; this.i = 0; }
  push(v) { if (!Number.isFinite(v)) return; this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++; }
  get count() { return this.n; }
  last() { return this.n ? this.buf[(this.i - 1 + this.buf.length) % this.buf.length] : null; }
  stats() {
    if (!this.n) return { count: 0, p50: null, p95: null, max: null };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
    return { count: this.n, p50: round(at(0.5)), p95: round(at(0.95)), max: round(a[a.length - 1]) };
  }
}
const round = (v) => Math.round(v * 10) / 10;

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

module.exports = { EXIT, SupervisorPolicy, writeFileAtomic, readJsonWithBak, isJson, WriteLane, Ring, ClockSampler };
