'use strict';
/**
 * Health's readings, and the peaks a show day reaches (pure: no I/O, the clock passed in; tested in test/units.test.js).
 * The server measures each 5 s window and notes what it read; each show day keeps the highest of every reading, so one
 * look after a show is the reading (docs/DESIGN.md, "Measured on the show laptop"). The days are saved by the server
 * through the `peaks` write lane (data/peaks.json) at the end of each 5 s window in which one rose, and read back at
 * start, so a restart or a crash loses none of the day they are for, and a hang or a power cut at most that window.
 *
 *   loopDelayMs  : the loop's true delay from a delay histogram: its p99 less the sampler's own resolution, never below 0
 *   countSockets : the most sockets one address holds, and how many came through the tunnel (counts, never an address)
 *   Burst        : the most arrivals one key (a hall) took in any 5 s, read at each arrival, not cut at a window's edge
 *   Hist         : durations in fixed buckets; its p99 is the bucket bound it falls under (never above the max), its max exact
 *   Peaks        : one record per show day (06:00 to 06:00), the newest 14; a reading only ever raises its day's value
 */

/**
 * The loop's delay in ms for one window. `h` is a `monitorEventLoopDelay` histogram (or anything with `percentile(q)` in
 * nanoseconds): its timer fires every `resolutionMs`, so an idle loop reads that resolution as delay. It is taken off.
 */
function loopDelayMs(h, resolutionMs) {
  const p99 = Number(h.percentile(99)) / 1e6;
  return Number.isFinite(p99) ? Math.max(0, p99 - resolutionMs) : 0;
}

/** The most sockets one address holds, and the sockets through the tunnel, from the open sockets' `data`. */
function countSockets(datas) {
  const per = new Map();
  let tunnel = 0;
  for (const d of datas) {
    if (!d) continue;
    if (d.viaTunnel) tunnel++;
    if (typeof d.ip === 'string' && d.ip) per.set(d.ip, (per.get(d.ip) || 0) + 1);
  }
  let most = 0;
  for (const n of per.values()) if (n > most) most = n;
  return { maxPerAddress: most, tunnel };
}

/**
 * The most arrivals one key took in any `windowMs`, wherever the window falls: arrivals are counted per key in slots of
 * `slotMs`, and each arrival reads the sum of its own slot and those before it in the window, so a storm that crosses
 * the 5 s tick is read whole (up to one slot's arrivals at the window's far edge). Bounded: one fixed set of slots per
 * key that had an arrival in the last window; `take` lets the others go. `at` is a monotonic clock in ms.
 */
class Burst {
  constructor({ windowMs = 5000, slotMs = 250 } = {}) {
    this.slotMs = slotMs; this.slots = Math.max(1, Math.round(windowMs / slotMs));
    this.keys = new Map(); this.most = 0;
  }

  /** One arrival for `key`: returns how many it took in the window that ends now. */
  add(key, at) {
    const s = Math.floor(at / this.slotMs);
    let k = this.keys.get(key);
    if (!k) { k = { slot: new Float64Array(this.slots).fill(-Infinity), n: new Uint32Array(this.slots), last: s }; this.keys.set(key, k); }
    const i = ((s % this.slots) + this.slots) % this.slots;
    if (k.slot[i] !== s) { k.slot[i] = s; k.n[i] = 0; }
    k.n[i]++;
    if (s > k.last) k.last = s;
    let sum = 0;
    for (let j = 0; j < this.slots; j++) if (k.slot[j] > s - this.slots && k.slot[j] <= s) sum += k.n[j];
    if (sum > this.most) this.most = sum;
    return sum;
  }

  /** The most any key took in one window since the last take; a key with no arrival in the window that ends `at` goes. */
  take(at) {
    const most = this.most;
    this.most = 0;
    const s = Math.floor(at / this.slotMs);
    for (const [key, k] of this.keys) if (k.last <= s - this.slots) this.keys.delete(key);
    return most;
  }
}

// Bucket bounds in ms. 2 ms and 100 ms are bounds, so reading 3 (p99 ≤ 2 ms, max ≤ 100 ms) is decided exactly.
const BOUNDS = [0.1, 0.2, 0.5, 1, 1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const round = (v, digits) => { const f = 10 ** digits; return Math.round(v * f) / f; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Durations in fixed buckets: bounded whatever the count, and kept as plain numbers on disk. */
class Hist {
  constructor() { this.buckets = new Array(BOUNDS.length + 1).fill(0); this.count = 0; this.max = 0; }
  add(ms) {
    if (!(typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)) return;
    let i = 0;
    while (i < BOUNDS.length && ms > BOUNDS[i]) i++;
    this.buckets[i]++;
    this.count++;
    if (ms > this.max) this.max = ms;
  }
  /** The bound under which `q` of the durations fall (at most the max): an upper bound on that percentile. */
  quantile(q) {
    if (!this.count) return null;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (let i = 0; i < BOUNDS.length; i++) {
      seen += this.buckets[i];
      if (seen >= rank) return round(Math.min(BOUNDS[i], this.max), 2);
    }
    return round(this.max, 2);   // past the last bound: the max itself
  }
  view() { return { count: this.count, p99: this.quantile(0.99), max: this.count ? round(this.max, 2) : null }; }
  toJSON() { return { count: this.count, max: round(this.max, 3), buckets: this.buckets.slice() }; }
  /** A saved histogram, or an empty one when what was saved is not one (fail closed: never a count it cannot account for). */
  static from(o) {
    const h = new Hist();
    if (!o || !Array.isArray(o.buckets) || o.buckets.length !== h.buckets.length) return h;
    if (!o.buckets.every((n) => Number.isInteger(n) && n >= 0)) return h;
    h.buckets = o.buckets.slice();
    h.count = h.buckets.reduce((a, b) => a + b, 0);
    h.max = h.count ? num(o.max) : 0;
    return h;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
// A show day turns at 06:00 by the laptop's clock, not at midnight, so an evening that runs past midnight is one day's.
const DAY_TURNS_AT_HOUR = 6;
/** The show day a time falls in, named by the date it starts on (by the laptop's own clock and zone). */
const dayOf = (at) => {
  const d = new Date(at);
  if (d.getHours() < DAY_TURNS_AT_HOUR) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
// The readings a window raises, and the digits each keeps.
const WINDOW = { loopMs: 1, elu: 3, socketsPerAddress: 0, tunnelSockets: 0, hallMessages: 0, hallKb: 1, joinBurst: 0 };

class Peaks {
  constructor({ keepDays = 14 } = {}) {
    this.keepDays = keepDays; this.days = [];
    this.dirty = false;   // a record changed since the server last asked the lane for a save
  }

  /** Read what peaks.json held: each day that names a day, its readings by type; anything else is left out. */
  load(saved) {
    const list = saved && Array.isArray(saved.days) ? saved.days : [];
    const byDay = new Map();
    for (const d of list) {
      if (!d || typeof d.day !== 'string' || !DAY_RE.test(d.day)) continue;
      const rec = this._blank(d.day);
      for (const k of Object.keys(WINDOW)) rec[k] = round(num(d[k]), WINDOW[k]);
      const c = d.compactMs || {};
      rec.compactMs = { max: round(num(c.max), 1), messages: Math.floor(num(c.messages)) };
      rec.auditPutMs = Hist.from(d.auditPutMs);
      rec.at = num(d.at);
      byDay.set(rec.day, rec);
    }
    this.days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-this.keepDays);
    return this;
  }

  _blank(day) {
    return { day, loopMs: 0, elu: 0, socketsPerAddress: 0, tunnelSockets: 0, hallMessages: 0, hallKb: 0, joinBurst: 0, compactMs: { max: 0, messages: 0 }, auditPutMs: new Hist(), at: 0 };
  }

  /** The record of the day `at` falls on, made when it is the first reading of that day; only the newest days are kept. */
  _day(at) {
    const day = dayOf(at);
    let rec = this.days.find((d) => d.day === day);
    if (rec) return rec;
    rec = this._blank(day);
    this.days.push(rec);
    this.days.sort((a, b) => (a.day < b.day ? -1 : 1));
    if (this.days.length > this.keepDays) this.days.splice(0, this.days.length - this.keepDays);
    return rec;
  }

  // Each reading below returns whether its day's record changed, and marks the peaks dirty when it did (the server saves
  // them at the window's end); `at` is when the record last changed.

  /** One window's readings ({loopMs, elu, …}); each raises its day's value, never lowers it. */
  note(readings, at) {
    const rec = this._day(at);
    let rose = false;
    for (const k of Object.keys(WINDOW)) {
      const v = round(num(readings[k]), WINDOW[k]);
      if (v > rec[k]) { rec[k] = v; rose = true; }
    }
    if (rose) { rec.at = at; this.dirty = true; }
    return rose;
  }

  /** A snapshot written: how long it took, and how many messages its hall held. The day keeps its longest. */
  compacted(ms, messages, at) {
    const rec = this._day(at);
    const v = round(num(ms), 1);
    const n = Math.floor(num(messages));
    if (v < rec.compactMs.max || (v === rec.compactMs.max && n <= rec.compactMs.messages)) return false;
    rec.compactMs = { max: v, messages: n };
    rec.at = at;
    this.dirty = true;
    return true;
  }

  /** One audit append on disk (open, write, fsync, close): every one counts toward the day's p99. */
  auditPut(ms, at) {
    const rec = this._day(at);
    rec.auditPutMs.add(ms);
    rec.at = at;
    this.dirty = true;
    return true;
  }

  /** What health shows: the days, oldest first, the audit writes as {count, p99, max}. */
  view() { return this.days.map((d) => ({ ...d, compactMs: { ...d.compactMs }, auditPutMs: d.auditPutMs.view() })); }

  /** What peaks.json keeps: the days with each histogram's buckets, so the day goes on counting after a restart. */
  toJSON() { return { v: 1, days: this.days.map((d) => ({ ...d, compactMs: { ...d.compactMs }, auditPutMs: d.auditPutMs.toJSON() })) }; }
}

module.exports = { loopDelayMs, countSockets, Burst, Hist, Peaks, dayOf, BOUNDS };
