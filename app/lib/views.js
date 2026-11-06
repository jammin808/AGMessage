'use strict';
/**
 * What the admin chooses for a person's chat view beyond the view itself (pure): the clock or countdown the simple view
 * draws in its header and on the take layer's bar (plan 7-§17.3), and what a seat On stage may do beyond the room's feed
 * (plan 7-§17.6).
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
 *
 * What a seat On stage may do beyond the room's feed (owner answers B2 and B4) is `{screens, people, clears}`, each a
 * boolean and each off until the admin turns it on: whether a message of theirs may also go to the line under the
 * countdown on their hall's screens that show it (`screens`), whether it may also be shown on the pages of everyone
 * seated On stage, beside their chat (`people`), and whether their Got it also takes the message off their own feed
 * (`clears`). The server reads the first two at each send; the third is the person's pages' to draw.
 *
 *   onStageAsked(o)         : what a change names, each switch a boolean, or {error} (fails closed)
 *   cleanOnStage(o, was)    : the switches `o` makes over `was` (whole ones), or {error} (fails closed)
 *   onStageOf(o)            : the switches as a store keeps them: whole, every one off where none is kept
 *   sameOnStage(a, b)       : whether two sets of switches are one
 *   onStageSaid(o, guest)   : the switches in an audit row's words
 *   alsoAsked(a)            : where else a message from On stage asks to go ({screens?, people?}), or {error}
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

/** The switches of what a seat On stage may do, in the order the admin's doors draw them. */
const ON_STAGE_KEYS = Object.freeze(['screens', 'people', 'clears']);
/** What nobody has turned on: a seat On stage writes into its room's feed alone, and Got it keeps the message there. */
const ON_STAGE_NONE = Object.freeze({ screens: false, people: false, clears: false });
const ON_STAGE_WORDS = 'Choose on or off.';
/** What turning a switch is refused with from anyone but the admin (the host token, or an account whose role is admin). */
const ON_STAGE_ADMIN = 'Only an admin may choose what an On stage seat may do.';
/** Each switch in an audit row's words: a guest's row by the switch's name, an account's row in short. */
const ON_STAGE_SAID = Object.freeze({ screens: 'may send to a countdown screen', people: 'may send to people On stage', clears: 'Got it clears' });
const ON_STAGE_SHORT = Object.freeze({ screens: 'countdown screens', people: 'people On stage', clears: 'Got it clears' });

/** Whole switches as a store keeps them: a record holding each of the three keys, each a boolean, and nothing else. */
const isOnStage = (o) => isRecord(o) && Object.keys(o).every((k) => ON_STAGE_KEYS.includes(k)) && ON_STAGE_KEYS.every((k) => typeof o[k] === 'boolean');

/**
 * What a change names of the switches, each by its type: a record holding only `screens`, `people` and `clears`, each a
 * boolean, at least one of them, any of them left out (a change names only the switches it changes). Anything else (none
 * named, a key of another name, a value that is no boolean, a string, null, `{toString: 1}`) is refused in the one set of
 * words, never made into a value or answered as done.
 */
function onStageAsked(o) {
  if (!isRecord(o) || !Object.keys(o).length || Object.keys(o).some((k) => !ON_STAGE_KEYS.includes(k))) return { error: ON_STAGE_WORDS };
  const out = {};
  for (const k of ON_STAGE_KEYS) {
    if (!Object.hasOwn(o, k)) continue;
    if (typeof o[k] !== 'boolean') return { error: ON_STAGE_WORDS };
    out[k] = o[k];
  }
  return out;
}

/** The switches a change `o` makes over those kept (`was`, whole; none kept is every one off), or {error} as onStageAsked refuses. */
function cleanOnStage(o, was = ON_STAGE_NONE) {
  const asked = onStageAsked(o);
  if (asked.error) return asked;
  const base = isOnStage(was) ? was : ON_STAGE_NONE;
  const out = {};
  for (const k of ON_STAGE_KEYS) out[k] = Object.hasOwn(asked, k) ? asked[k] : base[k];
  return out;
}

/** The switches as they are read from a store: whole ones, else every one off. */
const onStageOf = (o) => (isOnStage(o) ? { screens: o.screens, people: o.people, clears: o.clears } : { ...ON_STAGE_NONE });
const sameOnStage = (a, b) => ON_STAGE_KEYS.every((k) => onStageOf(a)[k] === onStageOf(b)[k]);
/** Whether the switches are those nobody turned on (a store keeps none of them). */
const noOnStage = (o) => sameOnStage(o, ON_STAGE_NONE);
/**
 * The switches a change moved (`now` from `was`) in an audit row's words: for a guest, each switch moved by its name
 * ("may send to a countdown screen: on"); for an account, all three in short ("countdown screens on, people On stage off,
 * Got it clears off"). Never a code or a text.
 */
function onStageSaid(now, was, { guest = false } = {}) {
  const n = onStageOf(now);
  const w = onStageOf(was);
  if (!guest) return ON_STAGE_KEYS.map((k) => ON_STAGE_SHORT[k] + ' ' + (n[k] ? 'on' : 'off')).join(', ');
  return ON_STAGE_KEYS.filter((k) => n[k] !== w[k]).map((k) => ON_STAGE_SAID[k] + ': ' + (n[k] ? 'on' : 'off')).join(', ');
}

/** What a message's `also` is refused with, from a seat or of a shape it may not have, and by each place's own check. */
const ALSO_WORDS = Object.freeze({
  onStage: 'Only On stage seats send this way: use ⧉ Show on screens or 📺 Show the Board.',
  shape: 'Choose where else it goes: a countdown screen or people On stage.',
  text: 'Only a message goes there, not a help request.',
  noScreens: 'The admin has not let you send to countdown screens.',
  noPeople: 'The admin has not let you send to people On stage.',
  noCountdown: 'No screen in this hall shows the countdown now.',
  nobody: 'Nobody else is On stage now.',
});
/** The places a message from On stage may also go: the line under a countdown screen's countdown, and the Board's pages. */
const ALSO_PLACES = Object.freeze(['screens', 'people']);
/**
 * Where else a message from On stage asks to go, read by type (pure): an object naming at least one of `screens` and
 * `people`, each `true`, and nothing else. Anything else (`{}`, a place of another name, a value that is not `true`, a
 * string, null) is refused in one set of words, never defaulted.
 */
function alsoAsked(a) {
  if (!isRecord(a)) return { error: ALSO_WORDS.shape };
  const keys = Object.keys(a);
  if (!keys.length || keys.some((k) => !ALSO_PLACES.includes(k) || a[k] !== true)) return { error: ALSO_WORDS.shape };
  return { ...(a.screens === true ? { screens: true } : {}), ...(a.people === true ? { people: true } : {}) };
}

module.exports = { ALSO_WORDS, ALSO_PLACES, alsoAsked, ON_STAGE_KEYS, ON_STAGE_NONE, ON_STAGE_WORDS, ON_STAGE_ADMIN, onStageAsked, cleanOnStage, onStageOf, sameOnStage, noOnStage, onStageSaid, isOnStage,
  CLOCK_SHOWS, CLOCK_NONE, CLOCK_WORDS, CLOCK_LOCK, CLOCK_ADMIN, clockAsked, cleanClock, clockOf, sameClock, noClock, clockWords, lockWords, isClock };
