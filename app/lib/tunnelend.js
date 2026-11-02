'use strict';
/**
 * The internet link's end (pure: the clock passed in). "On until <time>" is kept in the settings (`tunnelUntil`, ms since
 * the epoch) from Turn on until Turn off, its end or a start past it, so a start inside it turns the tunnel on again and a
 * start past it leaves it off. Times of day are the laptop's own clock and zone, as a show day's are (lib/peaks.js
 * `dayOf`, `dayEnds`); a page shows the words and the time of day the server reads here, never its own clock's.
 *
 *   MIN_AHEAD_MS : the nearest a default end may be: an end of the show day closer than this is the next day's
 *   MAX_AHEAD_MS : the furthest ahead an end can be: a day, the hour a default end may add to it, and the hour a change of
 *                  the clocks may add
 *   keptEnd      : a kept end read by type against now: inside it, past it, nothing kept, or one no act could have set
 *   defaultEnd   : Turn on's end: the end of the show day, or the next one when that is under MIN_AHEAD_MS away
 *   endAt        : the end a time of day names ("23:30"): the end kept when it is that time of day, else the next such
 *                  minute after now; null when the text is no time of day
 *   clockOf      : a time as a time field holds it, "HH:MM" by the laptop's clock
 *   clockWords   : an end, or a start, in words by the laptop's clock ("06:00 tomorrow")
 */

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const MIN_AHEAD_MS = HOUR_MS;
const MAX_AHEAD_MS = DAY_MS + MIN_AHEAD_MS + HOUR_MS;
const pad = (n) => String(n).padStart(2, '0');
const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * A kept end read against `now`: {on, until, why}. `on` only for a number inside its time and no further ahead than any
 * act sets one (`why` ''); past it, `why` is 'past' and `until` the end that passed; a number further ahead than that (a
 * clock set back, a file written by hand) or anything else is 'unread', and nothing kept is 'none'. Only an end it can
 * read, and inside its time, turns a tunnel on.
 */
function keptEnd(v, now) {
  if (v === undefined || v === null) return { on: false, until: null, why: 'none' };
  if (typeof v !== 'number' || !Number.isFinite(v) || v > now + MAX_AHEAD_MS) return { on: false, until: null, why: 'unread' };
  if (v <= now) return { on: false, until: v, why: 'past' };
  return { on: true, until: v, why: '' };
}

/**
 * Turn on's end: the end of the show day `now` falls in (`dayEnds`, the next 06:00), or, when that is under MIN_AHEAD_MS
 * away (a load-in in the hour before 06:00), the end of the next show day, so a link turned on is never cut minutes later.
 */
function defaultEnd(now, dayEnds) {
  const end = dayEnds(now);
  return end - now >= MIN_AHEAD_MS ? end : dayEnds(end);
}

/**
 * The end a time of day names, "HH:MM" (or "H:MM") by the laptop's clock: the end `kept` (one still ahead) when it is that
 * time of day, so the end a field was filled with and confirmed unchanged stays where it is (Turn on's 06:00 can be
 * tomorrow's while today's is still ahead); else the next such minute after `now`, so a time already past today is
 * tomorrow's. Null when the text is no time of day.
 */
function endAt(text, now, kept = null) {
  const m = typeof text === 'string' ? TIME_OF_DAY.exec(text.trim()) : null;
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  const next = d.getTime();
  return Number.isFinite(kept) && kept > now && clockOf(kept) === clockOf(next) ? kept : next;
}

/** A time as a time field holds it: "HH:MM" by the laptop's clock. */
function clockOf(at) {
  const d = new Date(at);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** The calendar days from `now`'s date to `at`'s by the laptop's clock, each date read at its noon (no change of the clocks falls there). */
function daysBetween(now, at) {
  const noon = (t) => { const d = new Date(t); d.setHours(12, 0, 0, 0); return d.getTime(); };
  return Math.round((noon(at) - noon(now)) / DAY_MS);
}

/** A time in words by the laptop's clock, against `now`: "06:00 tomorrow", "23:30 today", "21:00 yesterday", else "06:00 on 2026-11-05". */
function clockWords(at, now) {
  const d = new Date(at);
  const hm = clockOf(at);
  const days = daysBetween(now, at);
  if (days === 0) return hm + ' today';
  if (days === 1) return hm + ' tomorrow';
  if (days === -1) return hm + ' yesterday';
  return hm + ' on ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

module.exports = { MIN_AHEAD_MS, MAX_AHEAD_MS, keptEnd, defaultEnd, endAt, clockOf, clockWords };
