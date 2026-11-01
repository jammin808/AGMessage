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
 *   - An export's bundle holds its fixed paths and nothing else (H.9.5): a path holding `..`, `\`, a drive letter, a NUL
 *     or a leading `/`, or one off the set, is refused before anything is opened, so a crafted bundle never makes a
 *     checker read elsewhere. Its `SHA256SUMS` lists every file of it but itself and its signature, in `sha256sum`'s form.
 *
 * Loaded by Node (`require`), and by the browser verifier as a classic script, where it is `AGMAuditRules`.
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

/**
 * A chain walked entry by entry, as a checker without the key walks it (H.9.5): seq from 1 with no gap, each `prev` the
 * `h` before it, the runs and their boundaries, and the spans of entries not under `kid` (the exporting laptop's key),
 * with the accepts and the findings the laptop wrote under it. The caller holds each line to `wholeEntry` and each legacy
 * entry to its SHA-256 first; a keyed entry's MAC is the laptop's alone to check.
 */
class Chain {
  constructor(kid) {
    this.kid = kid;
    this.prev = { seq: 0, h: GENESIS };
    this.runs = new Runs();
    this.spans = [];        // [{from, to, runs: [{kind, from, to}]}]
    this.span = null;
    this.accepts = new Map();   // finding id -> {seq, at} of the accept that names it
    this.findings = [];     // the laptop's own cut and head entries: [{id, kind, words}]
    this.count = 0;
  }
  /** '' when the entry keeps the chain's rules, or why it breaks them. */
  next(e) {
    if (e.seq !== this.prev.seq + 1) return e.seq > this.prev.seq + 1 ? missing(this.prev.seq + 1, e.seq - 1) + ' before entry ' + e.seq : 'entry ' + e.seq + ' is out of order';
    if (e.prev !== this.prev.h) return 'entry ' + e.seq + ' does not follow the one before it';
    const why = this.runs.next(e);
    if (why) return why;
    if (e.k === this.kid) {
      if (this.span) { this.spans.push(this.span); this.span = null; }
      if (e.action === 'audit.accept') for (const id of e.target.split(',')) if (id) this.accepts.set(id, { seq: e.seq, at: e.at });
      if (e.action === 'audit.cut' || e.action === 'audit.head') this.findings.push({ id: 'e' + e.seq, kind: e.target, words: e.words });
    } else {
      if (!this.span) this.span = { from: e.seq, to: e.seq, runs: [] };
      this.span.to = e.seq;
      const kind = kindOf(e);
      const r = this.span.runs[this.span.runs.length - 1];
      if (r && r.kind === kind) r.to = e.seq; else this.span.runs.push({ kind, from: e.seq, to: e.seq });
    }
    this.prev = e;
    this.count++;
    return '';
  }
  /** '' when the walk may end here, or why not: a span with no boundary under the exporting key after it. */
  end() {
    const s = this.span;
    return s ? (s.from === s.to ? 'entry ' + s.from + ' follows' : 'entries ' + s.from + '–' + s.to + ' follow') + ' entry ' + (s.from - 1) + ' with no boundary under the exporting key after it' : '';
  }
}

// ---------------------------------------------------------------- an export's bundle (H.9.3, H.9.5)
// The current file, and a rotated one named by the time it was set aside.
const LOG_CURRENT = 'log/audit.jsonl';
const LOG_ROTATED = /^log\/audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/;
/** The bundle's fixed paths, beside its `log/` files. */
const FIXED_PATHS = Object.freeze(['manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig', 'signing-key.pem', 'README.txt', 'verify/verify-audit.js', 'verify/auditrules.js', 'verify/verify.html']);
const SUMS_LINE = /^([0-9a-f]{64}) {2}([^\n]{1,200})$/;
const MARKS = Object.freeze(['intact', 'linked', 'unvouched', 'broken']);
const MAX_LINE = 65536;   // a line longer than this is no entry AGMessage writes: the check fails there

/** Whether `p` is one of an export's log files: its current file, or a rotated one. */
const isLogPath = (p) => p === LOG_CURRENT || LOG_ROTATED.test(p);
/** '' when `p` is a path an export holds, or why not. Nothing is opened before every path has been read so. */
function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'an empty path';
  if (p.indexOf('\u0000') >= 0) return 'a path holding a NUL';
  if (p.indexOf('\\') >= 0) return 'a path holding a backslash: ' + p;
  if (p.charAt(0) === '/') return 'a path from the root: ' + p;
  if (/^[A-Za-z]:/.test(p)) return 'a path on a drive: ' + p;
  if (p.indexOf('..') >= 0) return 'a path holding "..": ' + p;
  if (!isLogPath(p) && FIXED_PATHS.indexOf(p) < 0) return 'not a file an export holds: ' + p;
  return '';
}

/** `SHA256SUMS`'s lines: {list: [{digest, path}]} or {why}. Each path is held to `pathProblem`; none twice; never itself or its signature. */
function parseSums(text) {
  if (typeof text !== 'string' || !text.length || text.charAt(text.length - 1) !== '\n') return { why: 'SHA256SUMS does not end with a line end' };
  const list = [];
  const seen = {};
  const lines = text.slice(0, -1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SUMS_LINE.exec(lines[i]);
    if (!m) return { why: 'line ' + (i + 1) + ' of SHA256SUMS is not "<sha256>  <path>"' };
    const why = pathProblem(m[2]);
    if (why) return { why: 'SHA256SUMS names ' + why };
    if (m[2] === 'SHA256SUMS' || m[2] === 'SHA256SUMS.sig') return { why: 'SHA256SUMS lists ' + m[2] };
    if (Object.prototype.hasOwnProperty.call(seen, m[2])) return { why: 'SHA256SUMS lists ' + m[2] + ' twice' };
    seen[m[2]] = true;
    list.push({ digest: m[1], path: m[2] });
  }
  return { list };
}

const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const isStr = (v) => typeof v === 'string';
/** '' when `m` is an export's manifest in its shape (H.9.3), or why not. What it says is checked against the bundle after. */
function manifestProblem(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest.json is not an object';
  if (m.kind !== 'agmessage audit export' || m.v !== 1) return 'manifest.json is not an AGMessage audit export\'s (kind, v)';
  if (!isInt(m.made)) return 'manifest.json has no time it was made';
  const by = m.by;
  if (!by || typeof by !== 'object' || !sameKeys(by, ACTOR_KEYS) || !ACTOR_KEYS.every((x) => isStr(by[x]))) return 'manifest.json does not say who exported';
  const n = m.node;
  if (!n || typeof n !== 'object' || !['id', 'name', 'version', 'build'].every((x) => isStr(n[x]))) return 'manifest.json does not name its AGMessage';
  if (!HEX32.test(String(m.log)) || !HEX16.test(String(m.kid))) return 'manifest.json does not name its log and key id';
  const sk = m.signingKey;
  if (!sk || sk.alg !== 'Ed25519' || !HEX64.test(String(sk.fingerprint))) return 'manifest.json does not name an Ed25519 signing key';
  const en = m.entries;
  if (!en || !isInt(en.from) || !isInt(en.to) || en.from < 1 || en.to < en.from) return 'manifest.json does not give its range of entries';
  if (!m.head || !isInt(m.head.seq) || !HEX64.test(String(m.head.h))) return 'manifest.json does not name the chain\'s head';
  const c = m.check;
  if (!c || MARKS.indexOf(c.mark) < 0 || !isStr(c.words) || !Array.isArray(c.findings)) return 'manifest.json does not carry the laptop\'s check';
  if (!Array.isArray(m.files) || !m.files.length) return 'manifest.json lists no log file';
  for (const f of m.files) {
    if (!f || !isLogPath(String(f.path)) || !isInt(f.bytes) || !isInt(f.first) || !isInt(f.last)) return 'manifest.json lists a log file it does not describe';
  }
  return '';
}

/** The verifier's exit code for a bundle that is whole and signed by the expected key, from the laptop's own mark (H.9.5). */
const codeFor = (mark) => (mark === 'intact' ? 0 : mark === 'broken' ? 2 : 1);

const api = {
  GENESIS, LEGACY_KEYS, KEYED_KEYS, BOUNDARIES, wholeEntry, canonical, canonical2, missing, kindOf, refOf, parseRef, Runs, Chain,
  FIXED_PATHS, MARKS, MAX_LINE, pathProblem, isLogPath, parseSums, manifestProblem, codeFor,
};
if (typeof module === 'object' && module.exports) module.exports = api;
else globalThis.AGMAuditRules = api;
