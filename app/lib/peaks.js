'use strict';
/**
 * Health's readings, and the peaks a show day reaches (pure: no I/O, the clock passed in; tested in test/units.test.js).
 * The server measures each 5 s window and notes what it read; each show day keeps the highest of every reading, so one
 * look after a show is the reading (docs/DESIGN.md, "Measured on the show laptop"). The days are saved by the server
 * through the `peaks` write lane (data/peaks.json) at the end of each 5 s window in which one rose, and read back at
 * start, so a restart or a crash loses none of the day they are for, and a hang or a power cut at most that window.
 *
 *   loopDelayMs  : the loop's true delay from a delay histogram: its p99 less the sampler's own resolution, never below 0
 *   countSockets : the most sockets one address (one network through the tunnel) holds, per lane, and how many came
 *                  through the tunnel (counts, never an address)
 *   Burst        : the most arrivals one key (a hall) took in any 5 s, read at each arrival, not cut at a window's edge
 *   Hist         : durations in fixed buckets; its p99 is the bucket bound it falls under (never above the max), its max exact
 *   Peaks        : one record per show day (06:00 to 06:00), the newest 14; a reading only ever raises its day's value,
 *                  and the day's refusals through the tunnel, by what was refused, only ever add up; the sleeps the
 *                  watchdog recorded, counted on the day each woke in (its longest kept), the newest 20 kept whole
 *   Refusals     : today's refusals, by lane and by what was refused, and one log line a minute at most while refusing
 *   linkCheck    : the internet link's check, from the round trips of its tries
 */

/**
 * The loop's delay in ms for one window. `h` is a `monitorEventLoopDelay` histogram (or anything with `percentile(q)` in
 * nanoseconds): its timer fires every `resolutionMs`, so an idle loop reads that resolution as delay. It is taken off.
 */
function loopDelayMs(h, resolutionMs) {
  const p99 = Number(h.percentile(99)) / 1e6;
  return Number.isFinite(p99) ? Math.max(0, p99 - resolutionMs) : 0;
}

/**
 * From the open sockets' `data` ({key, lane}: the key its bounds count by, and 'venue' or 'tunnel'): the most one key
 * holds in each lane — an address on the venue, a network through the tunnel — and the sockets through the tunnel.
 */
function countSockets(datas) {
  const per = { venue: new Map(), tunnel: new Map() };
  let tunnel = 0;
  for (const d of datas) {
    if (!d || typeof d.key !== 'string' || !d.key) continue;
    const lane = d.lane === 'tunnel' ? 'tunnel' : 'venue';
    if (lane === 'tunnel') tunnel++;
    per[lane].set(d.key, (per[lane].get(d.key) || 0) + 1);
  }
  const most = (m) => { let n = 0; for (const v of m.values()) if (v > n) n = v; return n; };
  return { maxPerAddress: { venue: most(per.venue), tunnel: most(per.tunnel) }, tunnel };
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
// The readings a window raises, and the digits each keeps; `socketsPerAddress` is kept per lane.
const WINDOW = { loopMs: 1, elu: 3, tunnelSockets: 0, hallMessages: 0, hallKb: 1, joinBurst: 0 };
const LANES = ['venue', 'tunnel'];
// What each lane counts as refused: at connect, the rate (3 a second, bursts of 30, per network), one network's share of
// the tunnel's places and the places all taken; after it, a tunnel socket let go for not joining in time (`idle`), and a
// join through the tunnel answered with the wrong-code lock (`wrongCode`). The first three are the link's capacity
// (reading 7 reads them); the last two are a probe or a stuck page and a guesser, counted beside them.
const REFUSED = { tunnel: ['rate', 'share', 'full', 'idle', 'wrongCode'], venue: ['rate'] };
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
/** Saved refusals by kind: each of `keys` a whole count, anything else none. */
const perKind = (v, keys) => {
  const o = v && typeof v === 'object' ? v : {};
  return Object.fromEntries(keys.map((k) => [k, Math.floor(num(o[k]))]));
};
/**
 * A saved `socketsPerAddress`: per lane, each a whole count. A plain number (a build that counted every address in one)
 * is read as the venue's, the lane its reading (reading 2) is about.
 */
const perLane = (v) => {
  if (typeof v === 'number') return { venue: Math.floor(num(v)), tunnel: 0 };
  const o = v && typeof v === 'object' ? v : {};
  return { venue: Math.floor(num(o.venue)), tunnel: Math.floor(num(o.tunnel)) };
};

/** The most sleeps kept whole (`asleep`); each day counts all of its own. */
const SLEEPS_KEPT = 20;
/** The longest sleep read as one: past it, what was said is not a sleep this watchdog could have measured. */
const SLEEP_MAX_MS = 366 * 86_400_000;
/**
 * A sleep the watchdog recorded ({from, to, parts}: the wall clock's ms, and how many times it went in a row), read by
 * type: whole numbers, `from` before `to`, no longer than SLEEP_MAX_MS, and, when `at` is given, ended by then (a minute's
 * leeway); else null.
 */
function readSleep(s, at = Infinity) {
  if (!s || typeof s !== 'object') return null;
  const { from, to, parts } = s;
  if (![from, to, parts].every(Number.isSafeInteger) || from <= 0 || to <= from || to - from > SLEEP_MAX_MS || parts < 1) return null;
  if (to > at + 60_000) return null;
  return { from, to, parts };
}

class Peaks {
  constructor({ keepDays = 14 } = {}) {
    this.keepDays = keepDays; this.days = [];
    this.asleep = [];     // the newest SLEEPS_KEPT sleeps, oldest first
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
      rec.socketsPerAddress = perLane(d.socketsPerAddress);
      rec.tunnelRefused = perKind(d.tunnelRefused, REFUSED.tunnel);
      const c = d.compactMs || {};
      rec.compactMs = { max: round(num(c.max), 1), messages: Math.floor(num(c.messages)) };
      rec.auditPutMs = Hist.from(d.auditPutMs);
      rec.at = num(d.at);
      rec.sleeps = Math.floor(num(d.sleeps));
      rec.sleptMs = Math.floor(num(d.sleptMs));
      byDay.set(rec.day, rec);
    }
    this.days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-this.keepDays);
    const asleep = saved && Array.isArray(saved.asleep) ? saved.asleep : [];
    this.asleep = asleep.map((x) => readSleep(x)).filter(Boolean).sort((a, b) => a.to - b.to).slice(-SLEEPS_KEPT);
    return this;
  }

  _blank(day) {
    return { day, loopMs: 0, elu: 0, socketsPerAddress: { venue: 0, tunnel: 0 }, tunnelSockets: 0, tunnelRefused: zero(REFUSED.tunnel), hallMessages: 0, hallKb: 0, joinBurst: 0, compactMs: { max: 0, messages: 0 }, auditPutMs: new Hist(), at: 0, sleeps: 0, sleptMs: 0 };
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

  /** One window's readings ({loopMs, elu, socketsPerAddress: {venue, tunnel}, …}); each raises its day's value, never lowers it. */
  note(readings, at) {
    const rec = this._day(at);
    let rose = false;
    for (const k of Object.keys(WINDOW)) {
      const v = round(num(readings[k]), WINDOW[k]);
      if (v > rec[k]) { rec[k] = v; rose = true; }
    }
    const lanes = readings.socketsPerAddress && typeof readings.socketsPerAddress === 'object' ? readings.socketsPerAddress : {};
    for (const lane of LANES) {
      const v = Math.floor(num(lanes[lane]));
      if (v > rec.socketsPerAddress[lane]) { rec.socketsPerAddress[lane] = v; rose = true; }
    }
    if (rose) { rec.at = at; this.dirty = true; }
    return rose;
  }

  /**
   * One refusal through the tunnel, of a kind it counts (REFUSED.tunnel), added to its day's count of that kind, so a
   * restart carries on from it; anything else changes nothing.
   */
  tunnelRefused(why, at) {
    if (!REFUSED.tunnel.includes(why)) return false;
    const rec = this._day(at);
    rec.tunnelRefused[why]++;
    rec.at = at;
    this.dirty = true;
    return true;
  }

  /** The refusals through the tunnel on the show day `at` falls in, by kind (none when it has no record); no record is made. */
  refusedOn(at) {
    const day = dayOf(at);
    const rec = this.days.find((d) => d.day === day);
    return rec ? { ...rec.tunnelRefused } : zero(REFUSED.tunnel);
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

  /**
   * A sleep the watchdog recorded (`s`: {from, to, parts}, read by type, ended by `at`): counted on the show day it woke
   * in, which keeps its longest, and kept whole among the newest SLEEPS_KEPT. Whether it was taken; anything else changes
   * nothing.
   */
  slept(s, at) {
    const r = readSleep(s, at);
    if (!r) return false;
    const rec = this._day(r.to);
    rec.sleeps++;
    if (r.to - r.from > rec.sleptMs) rec.sleptMs = r.to - r.from;
    rec.at = at;
    this.asleep.push(r);
    this.asleep.sort((a, b) => a.to - b.to);
    if (this.asleep.length > SLEEPS_KEPT) this.asleep.splice(0, this.asleep.length - SLEEPS_KEPT);
    this.dirty = true;
    return true;
  }

  /** The sleeps kept whole, oldest first: [{from, to, parts}]. */
  sleeps() { return this.asleep.map((x) => ({ ...x })); }

  /** The show day `at` falls in: how many sleeps woke in it, and the longest (none when it has no record). */
  sleptOn(at) {
    const rec = this.days.find((d) => d.day === dayOf(at));
    return rec ? { sleeps: rec.sleeps, sleptMs: rec.sleptMs } : { sleeps: 0, sleptMs: 0 };
  }

  /** What health shows: the days, oldest first, the audit writes as {count, p99, max}. */
  view() { return this.days.map((d) => ({ ...d, socketsPerAddress: { ...d.socketsPerAddress }, tunnelRefused: { ...d.tunnelRefused }, compactMs: { ...d.compactMs }, auditPutMs: d.auditPutMs.view() })); }

  /** What peaks.json keeps: the days with each histogram's buckets, so the day goes on counting after a restart. */
  toJSON() { return { v: 1, days: this.days.map((d) => ({ ...d, socketsPerAddress: { ...d.socketsPerAddress }, tunnelRefused: { ...d.tunnelRefused }, compactMs: { ...d.compactMs }, auditPutMs: d.auditPutMs.toJSON() })), asleep: this.sleeps() }; }
}

// The log's words for each, in the order its line gives them.
const SAID = { full: 'full', share: "one network's share", rate: 'too fast from one network', wrongCode: 'wrong codes', idle: 'never joined' };

/**
 * Refusals, counted for health: today's (the show day's, from 06:00), by lane and by what was refused, and the tunnel's
 * not yet said in the log, for one line a minute at most while it refuses (the server asks at each 5 s window). The
 * tunnel's carry on from the day's peaks at a start (`carry`), so a restart mid-show keeps them; the venue's count from
 * the start. Counts only: never an address, a hall or a name.
 */
class Refusals {
  constructor({ logEveryMs = 60_000 } = {}) {
    this.logEveryMs = logEveryMs;
    this.day = '';
    this.counts = { tunnel: zero(REFUSED.tunnel), venue: zero(REFUSED.venue) };
    this.unsaid = zero(REFUSED.tunnel);
    this.saidAt = -Infinity;
  }

  /** Today's counts start afresh when the show day turns. */
  _today(at) {
    const day = dayOf(at);
    if (day === this.day) return;
    this.day = day;
    this.counts = { tunnel: zero(REFUSED.tunnel), venue: zero(REFUSED.venue) };
  }

  /** Today's refusals through the tunnel carry on from `tunnel` (the day's peaks, by kind: `Peaks.refusedOn(at)`). */
  carry(tunnel, at) {
    this._today(at);
    this.counts.tunnel = perKind(tunnel, REFUSED.tunnel);
  }

  /** One refusal; whether it is a kind its lane counts (anything else is counted nowhere, never as a new key). */
  note(lane, why, at) {
    if (!Object.hasOwn(REFUSED, lane) || !REFUSED[lane].includes(why)) return false;
    this._today(at);
    this.counts[lane][why]++;
    if (lane === 'tunnel') this.unsaid[why]++;
    return true;
  }

  /** Today's counts: {tunnel: {rate, share, full, idle, wrongCode}, venue: {rate}}. */
  view(at) {
    this._today(at);
    return { tunnel: { ...this.counts.tunnel }, venue: { ...this.counts.venue } };
  }

  /**
   * The log's line for the tunnel's refusals not yet said ("[tunnel] refused 12 in the last minute: 10 full, 2 one
   * network's share"), or null: none since the last line, or that line is not a minute old.
   */
  logLine(at) {
    const total = Object.values(this.unsaid).reduce((a, b) => a + b, 0);
    if (!total || at - this.saidAt < this.logEveryMs) return null;
    const parts = Object.keys(SAID).filter((k) => this.unsaid[k]).map((k) => this.unsaid[k] + ' ' + SAID[k]);
    this.unsaid = zero(REFUSED.tunnel);
    this.saidAt = at;
    return '[tunnel] refused ' + total + ' in the last minute: ' + parts.join(', ');
  }
}

/**
 * The internet link's check from its tries, each the ms its answer took or null for a try that had none: `ok` when every
 * try answered; the middle and the longest round trip in whole ms (null with no answer); and its words.
 */
function linkCheck(tries, at) {
  const list = Array.isArray(tries) ? tries : [];
  const ms = list.filter((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const ok = list.length > 0 && ms.length === list.length;
  const p50Ms = ms.length ? Math.round(ms[Math.ceil(ms.length / 2) - 1]) : null;
  const maxMs = ms.length ? Math.round(ms[ms.length - 1]) : null;
  const words = ok ? 'round trip ' + p50Ms + ' ms (max ' + maxMs + ' ms)'
    : ms.length ? 'The internet link answered ' + ms.length + ' of ' + list.length + ' tries: remote phones may not join.'
      : 'The internet link did not answer: remote phones cannot join.';
  return { at, ok, p50Ms, maxMs, words };
}

module.exports = { loopDelayMs, countSockets, Burst, Hist, Peaks, Refusals, REFUSED, linkCheck, dayOf, BOUNDS, readSleep, SLEEPS_KEPT };
