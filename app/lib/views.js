'use strict';
/**
 * What the admin chooses for a person's chat view beyond the view itself (pure): the clock or countdown the simple view
 * draws in its header and on the take layer's bar (plan 7-§17.3).
 *
 * The admin's choice is `{show, locked}`: `show` is 'off' (nothing), 'time' (AGMessage's time of day), 'stage' (the hall's
 * Stagewatch countdown) or null (not set by the admin: the person's own choice, the time of day until they make one), and
 * `locked` keeps the admin's choice on the person's devices whatever they chose there. A lock holds a choice: `locked`
 * with `show: null` is refused. The device's own choice is never the server's to read; the page draws the one that wins
 * (public/catalog.js AGM.clockFor).
 *
 *   clockAsked(c)       : what a change names, each field by its type ({show?, locked?}), or {error} (fails closed)
 *   cleanClock(c, was)  : the clock `c` makes over `was` (a whole one, {show, locked}), or {error} (fails closed)
 *   sameClock(a, b)     : whether two clocks are one
 *   clockWords(c)       : a clock in an audit row's words ("countdown", "time of day", "their choice")
 *   lockWords(now, was) : its lock in an audit row's words ("locked", "unlocked", or none)
 */

/** What the clock or countdown shows: nothing, the time of day, or Stagewatch's countdown. */
const CLOCK_SHOWS = Object.freeze(['off', 'time', 'stage']);
/** The clock nobody has chosen: the person's own choice, nothing locked. */
const CLOCK_NONE = Object.freeze({ show: null, locked: false });
const CLOCK_WORDS = 'Choose Off, Time of day or Countdown.';
const CLOCK_LOCK = 'Choose one to lock it.';
/** What a change of the lock is refused with from anyone but the admin (the host token, or an account whose role is admin). */
const CLOCK_ADMIN = 'Only an admin may lock the clock or countdown.';
/** Each choice in an audit row's words. */
const CLOCK_SAID = Object.freeze({ off: 'off', time: 'time of day', stage: 'countdown' });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isShow = (v) => v === null || CLOCK_SHOWS.includes(v);
/** A whole clock as a store keeps it: `show` one of the choices or null, `locked` a boolean, and no lock on no choice. */
const isClock = (c) => isRecord(c) && isShow(c.show) && typeof c.locked === 'boolean' && !(c.locked && c.show === null);

/**
 * What a change names of the clock, each field by its type: a record holding only `show` (a choice, or null for theirs)
 * and `locked` (a boolean), either left out; null clears the admin's choice and its lock. Anything else (a key of another
 * name, a value of the wrong type, `{toString: 1}`) is refused in the one set of words, never made into a value.
 */
function clockAsked(c) {
  if (c === null) return { show: null, locked: false };
  if (!isRecord(c) || Object.keys(c).some((k) => k !== 'show' && k !== 'locked')) return { error: CLOCK_WORDS };
  const out = {};
  if (Object.hasOwn(c, 'show')) { if (!isShow(c.show)) return { error: CLOCK_WORDS }; out.show = c.show; }
  if (Object.hasOwn(c, 'locked')) { if (typeof c.locked !== 'boolean') return { error: CLOCK_WORDS }; out.locked = c.locked; }
  return out;
}

/**
 * The clock a change `c` makes over the one kept (`was`, a whole clock; none kept is CLOCK_NONE): each field it names
 * taken, each it leaves out kept. Refused as clockAsked refuses, and a lock on no choice in its own words.
 */
function cleanClock(c, was = CLOCK_NONE) {
  const asked = clockAsked(c);
  if (asked.error) return asked;
  const base = isClock(was) ? was : CLOCK_NONE;
  const next = { show: Object.hasOwn(asked, 'show') ? asked.show : base.show, locked: Object.hasOwn(asked, 'locked') ? asked.locked : base.locked };
  if (next.locked && next.show === null) return { error: CLOCK_LOCK };
  return next;
}

/** A clock as it is read from a store: a whole one, else none chosen. */
const clockOf = (c) => (isClock(c) ? { show: c.show, locked: c.locked } : { ...CLOCK_NONE });
const sameClock = (a, b) => clockOf(a).show === clockOf(b).show && clockOf(a).locked === clockOf(b).locked;
/** Whether a clock is the one nobody chose (a store keeps none of it). */
const noClock = (c) => sameClock(c, CLOCK_NONE);
/** A clock's choice in an audit row's words: never a person's own, which is no row. */
const clockWords = (c) => (clockOf(c).show === null ? 'their choice' : CLOCK_SAID[clockOf(c).show]);
/** What an audit row says of the lock going from `was` to `now`: 'locked' while it holds, 'unlocked' as it is taken off, else ''. */
const lockWords = (now, was) => (clockOf(now).locked ? 'locked' : clockOf(was).locked ? 'unlocked' : '');

module.exports = { CLOCK_SHOWS, CLOCK_NONE, CLOCK_WORDS, CLOCK_LOCK, CLOCK_ADMIN, clockAsked, cleanClock, clockOf, sameClock, noClock, clockWords, lockWords, isClock };
