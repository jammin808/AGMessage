'use strict';
/**
 * Latest wins, never a backlog, for a frame of state: the halls board, a hall's screens, its people list and its seen
 * receipts each go through one. A key is marked when its state changes; each key marked since the last flush is
 * flushed once, with its newest value (or the values `merge` folds together), and never dropped.
 *
 * - At most one flush per `delayMs`. A mark after a quiet window is flushed on the next turn (a zero-delay timer), so a
 *   lone change goes at once; the marks that come while a window lasts fold into one flush at its end. A burst therefore
 *   costs its first frame and then one per window, and n flushes span at least (n - 1) windows.
 * - A window with nothing marked in it ends the run: no timer is left waiting while nothing changes.
 * - `flush(map)` is given every key marked since the last flush, each with its value; it reads the state it sends when
 *   it runs, so what goes is the newest, and it skips a key whose subject (a hall) is gone. `sendEach` sends each
 *   subject of a flush apart, so one subject's fault holds back no other's.
 * - Nothing here is volatile and nothing is queued per key: a slow reader is bounded by the transport's heartbeat.
 *
 * Pure: the timers are `schedule`'s ({setTimeout, clearTimeout}, the runtime's unless one is given), each `unref()`'d
 * where it can be, so a frame waiting to go never keeps a process alive. `stats()` is what coalescing saved:
 * `{marks, flushes}`.
 */

const newer = (prev, next) => next;

class Latest {
  /**
   * @param {{name: string, delayMs: number, flush: (batch: Map) => void, merge?: (prev: any, next: any) => any,
   *          schedule?: {setTimeout: Function, clearTimeout: Function}}} opts
   */
  constructor({ name, delayMs, flush, merge = newer, schedule = { setTimeout, clearTimeout } } = {}) {
    if (typeof name !== 'string' || !name) throw new TypeError('A Latest needs a name.');
    if (!Number.isInteger(delayMs) || delayMs < 1) throw new TypeError('Latest ' + name + ': delayMs is a whole number of milliseconds, at least 1.');
    if (typeof flush !== 'function') throw new TypeError('Latest ' + name + ': flush is a function.');
    if (typeof merge !== 'function') throw new TypeError('Latest ' + name + ': merge is a function.');
    if (!schedule || typeof schedule.setTimeout !== 'function' || typeof schedule.clearTimeout !== 'function') throw new TypeError('Latest ' + name + ': schedule is {setTimeout, clearTimeout}.');
    this.name = name;
    this.delayMs = delayMs;
    this._flush = flush;
    this._merge = merge;
    this._schedule = schedule;
    this._pending = new Map();
    this._timer = null;    // the next turn's flush, or the end of the window a flush opened; null while quiet
    this._marks = 0;
    this._flushes = 0;
  }

  /** A key's state changed: it is flushed once, with `value` (merged with what is waiting for it), as the window allows. */
  mark(key, value) {
    this._marks++;
    this._pending.set(key, this._pending.has(key) ? this._merge(this._pending.get(key), value) : value);
    if (!this._timer) this._arm(0);
  }

  /** Flush what is waiting now, whatever the window, and start the window again from it. The number of keys flushed. */
  flushNow() {
    if (!this._pending.size) return 0;
    if (this._timer) { this._schedule.clearTimeout(this._timer); this._timer = null; }
    return this._run();
  }

  /** What coalescing saved: the changes marked, and the flushes made for them. */
  stats() { return { marks: this._marks, flushes: this._flushes }; }

  _arm(ms) {
    const t = this._schedule.setTimeout(() => this._fire(), ms);
    if (t && typeof t.unref === 'function') t.unref();
    this._timer = t;
  }

  _fire() {
    this._timer = null;
    if (this._pending.size) this._run();
  }

  /** One flush of everything waiting. The window it opens is armed before `flush` runs, so a throw there leaves the
   *  next mark to the end of that window, as any other. */
  _run() {
    const batch = this._pending;
    this._pending = new Map();
    this._flushes++;
    this._arm(this.delayMs);
    this._flush(batch);
    return batch.size;
  }
}

/**
 * Each subject of a flush given to `send`, in order. One whose send throws is handed to `fault` with its error and its
 * subject, and the rest are still sent: a fault building one subject's frame never holds back another's. The number
 * sent.
 */
function sendEach(subjects, send, fault) {
  let sent = 0;
  for (const subject of subjects) {
    try { send(subject); sent++; } catch (e) { fault(e, subject); }
  }
  return sent;
}

module.exports = { Latest, sendEach };
