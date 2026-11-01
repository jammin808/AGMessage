'use strict';
/**
 * The audit log's rules that need no key, in one pure file with no require: what a whole entry is, the two canonical
 * forms an entry's hash is taken over, how the entries link, and the runs and boundaries of a log whose key changed
 * (H.4). The laptop's log (lib/audit.js) applies them before its own key checks; a checker on another computer applies
 * the same file, so the two never drift.
 *
 * Invariants:
 *   - A line is an entry only when it is exactly `JSON.stringify` of what it parses to, with exactly the written keys in
 *     the written order (nine for a legacy entry, eleven for a keyed one, `actor` exactly `t, id, name`), each of its type,
 *     `l` 32 and `k` 16 lower-case hex characters. Anything else is not read as an entry, whatever a reader would make of it.
 *   - A legacy entry (no `l`, no `k`) is hashed over `canonical`, as AGMessage 0.5.1 and earlier wrote it; a keyed one is
 *     MACed over `canonical2`, whose `v: 2` keeps the two forms from ever being the same bytes.
 *   - The key changes only at a boundary entry under the new key whose target names the run before it,
 *     `<plain or kid>:<its first entry>`. The one change with no boundary is a change to plain, since 0.5.1 cannot write
 *     one; that plain run must end at an `audit.unkeyed` that names it.
 */
const GENESIS = '0'.repeat(64);
const LEGACY_KEYS = ['seq', 'at', 'actor', 'action', 'target', 'words', 'ip', 'prev', 'h'];
const KEYED_KEYS = ['seq', 'at', 'actor', 'action', 'target', 'words', 'ip', 'prev', 'l', 'k', 'h'];
const ACTOR_KEYS = ['t', 'id', 'name'];
const TEXT_KEYS = ['action', 'target', 'words', 'ip'];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const REF = /^(plain|[0-9a-f]{16}):([1-9][0-9]{0,15}|\?)$/;
/** The boundaries, and the run each may end: the key changes only at one of these, under the new key. */
const BOUNDARIES = Object.freeze({
  'audit.keyed': (before) => before.kind === 'plain' && before.first === 1,     // plain entries from entry 1
  'audit.unkeyed': (before) => before.kind === 'plain' && before.first > 1,     // plain entries after keyed ones
  'audit.rekey': (before) => before.kind !== 'plain',                           // a run under another key
  'audit.keyless': () => true,                                                  // opens a run with no machine key
});

const sameKeys = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

/** A line of the log as its entry, or null when it is not a whole one. */
function wholeEntry(text) {
  if (typeof text !== 'string') return null;
  let e;
  try { e = JSON.parse(text); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const keyed = Object.prototype.hasOwnProperty.call(e, 'k');
  if (!sameKeys(e, keyed ? KEYED_KEYS : LEGACY_KEYS)) return null;
  if (!Number.isSafeInteger(e.seq) || e.seq < 1 || !Number.isSafeInteger(e.at) || e.at < 0) return null;
  const a = e.actor;
  if (!a || typeof a !== 'object' || Array.isArray(a) || !sameKeys(a, ACTOR_KEYS) || !ACTOR_KEYS.every((x) => typeof a[x] === 'string')) return null;
  if (!TEXT_KEYS.every((x) => typeof e[x] === 'string')) return null;
  if (!HEX64.test(e.prev) || !HEX64.test(e.h)) return null;
  if (keyed && !(HEX32.test(e.l) && HEX16.test(e.k))) return null;
  return JSON.stringify(e) === text ? e : null;
}

/** What a legacy entry's SHA-256 is taken over: its fields but `h`, in the order 0.5.1 wrote them. */
const canonical = (e) => JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, words: e.words, ip: e.ip, prev: e.prev });
/** What a keyed entry's HMAC is taken over. */
const canonical2 = (e) => JSON.stringify({ v: 2, seq: e.seq, at: e.at, actor: { t: e.actor.t, id: e.actor.id, name: e.actor.name }, action: e.action, target: e.target, words: e.words, ip: e.ip, prev: e.prev, l: e.l, k: e.k });

/** "entry 5 is missing", "entries 5 to 9 are missing". */
const missing = (from, to) => (from === to ? 'entry ' + from + ' is missing' : 'entries ' + from + ' to ' + to + ' are missing');

/** A run's kind: 'plain' for an entry with no key, else its key id. */
const kindOf = (e) => e.k || 'plain';
/** A run as a boundary names it: `plain:1`, `3fa2c1d0e9b8a7f6:812`. */
const refOf = (run) => run.kind + ':' + run.first;
/** The run a boundary's target names (the part before any `;`): {kind, first} (`first` a number, or '?'), or null. */
function parseRef(target) {
  const m = REF.exec(String(target).split(';')[0]);
  return m ? { kind: m[1], first: m[2] === '?' ? '?' : Number(m[2]) } : null;
}

/**
 * The runs of a chain, walked one whole, linked entry at a time (H.4). `next(e)` answers '' when the entry keeps the rules,
 * or why it breaks them; `run` is the run the entry just taken stands in.
 */
class Runs {
  constructor() { this.run = null; }
  next(e) {
    const kind = kindOf(e);
    const before = this.run;
    if (!before) { this.run = { kind, first: e.seq }; return ''; }
    if (before.kind === kind) return '';
    if (kind !== 'plain') {
      const ends = Object.prototype.hasOwnProperty.call(BOUNDARIES, e.action) ? BOUNDARIES[e.action] : null;
      const named = parseRef(e.target);
      if (!ends || !named || named.kind !== before.kind || named.first !== before.first || !ends(before)) {
        return 'entry ' + e.seq + ' changes the key without a boundary that names the run before it (' + refOf(before) + ')';
      }
    }
    this.run = { kind, first: e.seq };
    return '';
  }
}

const api = { GENESIS, LEGACY_KEYS, KEYED_KEYS, BOUNDARIES, wholeEntry, canonical, canonical2, missing, kindOf, refOf, parseRef, Runs };
if (typeof module === 'object' && module.exports) module.exports = api;
