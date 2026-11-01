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
 *   - A chain that begins after entry 1 begins at an archive point (`audit.archive`, H.10) under the chain's key, whose
 *     target names the run it stands in (`<event archive>;<kid>:<first entry>`): the walk goes on from it as from that
 *     run. Any other chain that begins after entry 1 is missing its first entries.
 *   - An export's bundle holds its fixed paths and nothing else (H.9.5), and an archive's folder its own (H.10.3): a path
 *     holding `..`, `\`, a drive letter, a NUL or a leading `/`, or one off the set, is refused before anything is
 *     opened, so a crafted bundle never makes a checker read elsewhere. Each `SHA256SUMS` lists every file of its folder
 *     but itself and its signature, in `sha256sum`'s form.
 *   - The folder check (`verifyFolder`) is one: the Node verifier and the browser page each hand it their own way to read
 *     a file, hash it and check a signature, and nothing else, so the two cannot answer differently.
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

/** An archive point's target, `<event archive>;<kid>:<first entry>`: {name, run: {kind, first}}, or null. */
function pointRun(target) {
  const t = String(target);
  const i = t.lastIndexOf(';');
  const run = i < 0 ? null : parseRef(t.slice(i + 1));
  return run ? { name: t.slice(0, i), run } : null;
}
const SPLIT = /^([1-9][0-9]{0,15});([0-9a-f]{64})$/;
/** A split's target, `<the archive point's seq>;<the SHA-256 of the archive's SHA256SUMS>`: {point, digest}, or null. */
function splitOf(target) {
  const m = SPLIT.exec(String(target));
  return m ? { point: Number(m[1]), digest: m[2] } : null;
}
/**
 * Where a chain that begins after entry 1 may begin: an archive point, keyed, naming a run of its own key (H.10). Under
 * the chain's key it is that machine's own; under another it stands in a span like the entries after it.
 */
function beginsAt(e) {
  const p = e.k && e.action === 'audit.archive' ? pointRun(e.target) : null;
  return p && p.run.kind === e.k ? p.run : null;
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
  /** `atPoint`: the chain may begin after entry 1, at an archive point under `kid` (an archive's or a live log's, H.10). */
  constructor(kid, { atPoint = false } = {}) {
    this.kid = kid;
    this.prev = { seq: 0, h: GENESIS };
    this.runs = new Runs();
    this.spans = [];        // [{from, to, runs: [{kind, from, to}]}]
    this.span = null;
    this.accepts = new Map();   // finding id -> {seq, at} of the accept that names it
    this.findings = [];     // the laptop's own cut and head entries: [{id, kind, words}]
    this.splits = [];       // the keyed splits walked: [{seq, at, k, point, digest}]
    this.atPoint = atPoint;
    this.from = 0;          // the first entry walked
    this.count = 0;
  }
  /** '' when the entry keeps the chain's rules, or why it breaks them. */
  next(e) {
    if (!this.count && e.seq !== 1) {
      const run = this.atPoint ? beginsAt(e) : null;
      if (!run) return missing(1, e.seq - 1) + ' before entry ' + e.seq;
      this.prev = { seq: e.seq - 1, h: e.prev };
      this.runs.run = { kind: run.kind, first: run.first };
    }
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
    // A split is structure under any key, as a boundary is: keyed, it pins the archive it made (H.10.7).
    const split = e.k && e.action === 'audit.split' ? splitOf(e.target) : null;
    if (split) this.splits.push({ seq: e.seq, at: e.at, k: e.k, point: split.point, digest: split.digest });
    if (!this.count) this.from = e.seq;
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

// ---------------------------------------------------------------- an export's bundle and an archive's folder (H.9.3, H.10.3)
// The current file, and a rotated one named by the time it was set aside.
const LOG_CURRENT = 'log/audit.jsonl';
const LOG_ROTATED = /^log\/audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/;
/** The bundle's fixed paths, beside its `log/` files and the archives it carries. */
const FIXED_PATHS = Object.freeze(['manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig', 'signing-key.pem', 'README.txt', 'verify/verify-audit.js', 'verify/auditrules.js', 'verify/verify.html']);
/** An archive's own files, beside its `log/` files; in an export they sit under `archive/<name>/`. */
const ARCHIVE_PATHS = Object.freeze(['archive.json', 'signing-key.pem', 'SHA256SUMS', 'SHA256SUMS.sig']);
/** An archive's name: `audit-<the log id's first 8 hex>-<its first entry>-<its last>`. */
const ARCHIVE_NAME = /^audit-([0-9a-f]{8})-([1-9][0-9]{0,9})-([1-9][0-9]{0,9})$/;
const SUMS_LINE = /^([0-9a-f]{64}) {2}([^\n]{1,200})$/;
const MARKS = Object.freeze(['intact', 'linked', 'unvouched', 'broken']);
const MAX_LINE = 65536;   // a line longer than this is no entry AGMessage writes: the check fails there

/** Whether `p` is one of an export's log files: its current file, or a rotated one. */
const isLogPath = (p) => p === LOG_CURRENT || LOG_ROTATED.test(p);
/** Whether `p` is one of an archive's log files: rotated files only, since a split moves only files set aside before its point. */
const isArchiveLog = (p) => LOG_ROTATED.test(p);
/** An archive's name as {l8, from, to}, or null. */
function archiveRange(name) {
  const m = ARCHIVE_NAME.exec(String(name));
  return m && Number(m[2]) <= Number(m[3]) ? { l8: m[1], from: Number(m[2]), to: Number(m[3]) } : null;
}
/** An export's path to a file of an archive it carries, as {name, path} (the path inside the archive), or null. */
function inArchive(p) {
  const m = /^archive\/([^/]{1,40})\/([^/]{1,40}|log\/[^/]{1,60})$/.exec(String(p));
  return m && ARCHIVE_NAME.test(m[1]) && (ARCHIVE_PATHS.indexOf(m[2]) >= 0 || isArchiveLog(m[2])) ? { name: m[1], path: m[2] } : null;
}
/**
 * '' when `p` is a path the folder holds, or why not: an export's (its fixed paths, its log files and each archive's under
 * `archive/<name>/`) or, with `folder` 'archive', an archive's own. Nothing is opened before every path has been read so.
 */
function pathProblem(p, folder = 'export') {
  if (typeof p !== 'string' || !p) return 'an empty path';
  if (p.indexOf('\u0000') >= 0) return 'a path holding a NUL';
  if (p.indexOf('\\') >= 0) return 'a path holding a backslash: ' + p;
  if (p.charAt(0) === '/') return 'a path from the root: ' + p;
  if (/^[A-Za-z]:/.test(p)) return 'a path on a drive: ' + p;
  if (p.indexOf('..') >= 0) return 'a path holding "..": ' + p;
  if (folder === 'archive') return ARCHIVE_PATHS.indexOf(p) >= 0 || isArchiveLog(p) ? '' : 'not a file an archive holds: ' + p;
  if (!isLogPath(p) && FIXED_PATHS.indexOf(p) < 0 && !inArchive(p)) return 'not a file an export holds: ' + p;
  return '';
}

/** `SHA256SUMS`'s lines: {list: [{digest, path}]} or {why}. Each path is held to `pathProblem`; none twice; never itself or its signature. */
function parseSums(text, folder = 'export') {
  if (typeof text !== 'string' || !text.length || text.charAt(text.length - 1) !== '\n') return { why: 'SHA256SUMS does not end with a line end' };
  const list = [];
  const seen = {};
  const lines = text.slice(0, -1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SUMS_LINE.exec(lines[i]);
    if (!m) return { why: 'line ' + (i + 1) + ' of SHA256SUMS is not "<sha256>  <path>"' };
    const why = pathProblem(m[2], folder);
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
const isRange = (en) => !!en && isInt(en.from) && isInt(en.to) && en.from >= 1 && en.to >= en.from;
/** '' when `o` says when it was made, by whom, on which AGMessage, of which log and key, signed by which key; or why not. */
function madeProblem(o, file, maker) {
  if (!isInt(o.made)) return file + ' has no time it was made';
  const by = o.by;
  if (!by || typeof by !== 'object' || !sameKeys(by, ACTOR_KEYS) || !ACTOR_KEYS.every((x) => isStr(by[x]))) return file + ' does not say who ' + maker;
  const n = o.node;
  if (!n || typeof n !== 'object' || !['id', 'name', 'version', 'build'].every((x) => isStr(n[x]))) return file + ' does not name its AGMessage';
  if (!HEX32.test(String(o.log)) || !HEX16.test(String(o.kid))) return file + ' does not name its log and key id';
  const sk = o.signingKey;
  if (!sk || sk.alg !== 'Ed25519' || !HEX64.test(String(sk.fingerprint))) return file + ' does not name an Ed25519 signing key';
  return '';
}
/** '' when `m` is an export's manifest in its shape (H.9.3, H.10.7), or why not. What it says is checked against the bundle after. */
function manifestProblem(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest.json is not an object';
  if (m.kind !== 'agmessage audit export' || m.v !== 1) return 'manifest.json is not an AGMessage audit export\'s (kind, v)';
  const made = madeProblem(m, 'manifest.json', 'exported');
  if (made) return made;
  if (!isRange(m.entries)) return 'manifest.json does not give its range of entries';
  if (!m.head || !isInt(m.head.seq) || !HEX64.test(String(m.head.h))) return 'manifest.json does not name the chain\'s head';
  const c = m.check;
  if (!c || MARKS.indexOf(c.mark) < 0 || !isStr(c.words) || !Array.isArray(c.findings)) return 'manifest.json does not carry the laptop\'s check';
  if (!Array.isArray(m.files) || !m.files.length) return 'manifest.json lists no log file';
  for (const f of m.files) {
    if (!f || !isLogPath(String(f.path)) || !isInt(f.bytes) || !isInt(f.first) || !isInt(f.last)) return 'manifest.json lists a log file it does not describe';
  }
  if (m.archives !== undefined) {
    if (!Array.isArray(m.archives)) return 'manifest.json\'s archives are not a list';
    for (const a of m.archives) {
      if (!a || !archiveRange(a.name) || !isRange(a.entries) || !isInt(a.split) || !HEX64.test(String(a.digest)) || typeof a.present !== 'boolean') return 'manifest.json lists an archive it does not describe';
    }
  }
  return '';
}
/** '' when `a` is an archive's archive.json in its shape (H.10.3), or why not. What it says is checked against the folder after. */
function archiveProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'archive.json is not an object';
  if (a.kind !== 'agmessage audit archive' || a.v !== 1) return 'archive.json is not an AGMessage audit archive\'s (kind, v)';
  const made = madeProblem(a, 'archive.json', 'split it off');
  if (made) return made;
  const en = a.entries;
  if (!isRange(en)) return 'archive.json does not give its range of entries';
  if (!a.start || a.start.seq !== en.from || !HEX64.test(String(a.start.prev)) || (en.from === 1) !== (a.start.prev === GENESIS)) return 'archive.json does not say what its first entry follows';
  if (!a.point || a.point.seq !== en.to + 1 || !HEX64.test(String(a.point.h))) return 'archive.json does not name the archive point after it';
  const pr = a.previous;
  if (en.from === 1 ? pr !== null : !(pr && archiveRange(pr.name) && HEX64.test(String(pr.digest)) && isInt(pr.split))) return 'archive.json does not name the archive before it';
  const c = a.check;
  if (!c || (c.mark !== 'intact' && c.mark !== 'linked') || !isStr(c.words) || !Array.isArray(c.findings)) return 'archive.json does not carry the laptop\'s check at the split';
  for (const f of c.findings) {
    if (!f || !isStr(f.id) || !isStr(f.words) || !f.accept || !isInt(f.accept.seq) || !isInt(f.accept.at)) return 'archive.json names a finding without the accept that closed it';
  }
  if (!Array.isArray(a.files) || !a.files.length) return 'archive.json lists no log file';
  for (const f of a.files) {
    if (!f || !isArchiveLog(String(f.path)) || !isInt(f.bytes) || !isInt(f.first) || !isInt(f.last)) return 'archive.json lists a log file it does not describe';
  }
  if (a.files[0].first !== en.from || a.files[a.files.length - 1].last !== en.to) return 'archive.json\'s files do not hold its range of entries';
  return '';
}

/** The verifier's exit code for a folder that is whole and signed by the expected key, from the laptop's own mark (H.9.5). */
const codeFor = (mark) => (mark === 'intact' ? 0 : mark === 'broken' ? 2 : 1);

// ---------------------------------------------------------------- the folder check, the Node verifier's and the page's
// Each hands it `io`: read(path) the folder's bytes (refusing, with its words, a path it cannot or will not read),
// unlisted(isListed) the paths present that are not listed, sha256(bytes) a hex digest, publicKey(der, file) an Ed25519
// key or a refusal, verify(key, sig, bytes), text(bytes) and bytes(text) in UTF-8, base64(text) its bytes.
class Refused extends Error {}
/** A refusal about an archive the laptop's own signed check names as not what was split off: the bundle is what was exported. */
class Named extends Refused {}
const refuse = (why) => { throw new Refused(why); };
const grouped = (fp) => String(fp).match(/.{1,4}/g).join(' ');
const shortKey = (fp) => grouped(String(fp).slice(0, 16)) + ' …';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
/** "18:40 UTC on 26 Oct 2026": the laptop's clock, read in UTC wherever this runs. */
const whenUtc = (at) => { const d = new Date(at); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC on ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
const dayUtc = (at) => { const d = new Date(at); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
const rangeOf = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);
const PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]{40,200})\n-----END PUBLIC KEY-----\n?$/;
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

/** The last line of a file that ends with a line end, without it ('' when it is over 64 KB). */
function lastLine(io, buf) {
  if (!buf.length) return '';
  const start = buf.lastIndexOf(10, buf.length - 2) + 1;
  return buf.length - 1 - start > MAX_LINE ? '' : io.text(buf.subarray(start, buf.length - 1));
}
/** A public key's PEM as {key, fp}: the key, and the SHA-256 of its DER. */
async function keyFrom(io, pem, file) {
  const m = PEM.exec(io.text(pem));
  if (!m) refuse(file + ' is not a public key in PEM');
  const der = io.base64(m[1].replace(/\n/g, ''));
  return { key: await io.publicKey(der, file), fp: await io.sha256(der) };
}
/** A folder's listed files whole: each its signed digest, each log file its size and a whole last line. Returns their sizes. */
async function filesHold(io, listed, logs, { onFile } = {}) {
  const sizes = new Map();
  for (const [p, digest] of listed) {
    const buf = await io.read(p);
    if ((await io.sha256(buf)) !== digest) refuse(p + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
    const f = logs.get(p);
    if (f && f.bytes !== undefined && buf.length !== f.bytes) refuse(p + ' is ' + buf.length + ' bytes; ' + f.by + ' says ' + f.bytes);
    if (f && buf.length && buf[buf.length - 1] !== 10) refuse('the last line of ' + p + ' is not whole');
    sizes.set(p, buf.length);
    if (onFile) onFile(p, buf);
  }
  return sizes;
}
/**
 * Walk the log files `parts` ({path, f: {first, last}, by}) into `chain`, each read again against its digest: whole lines,
 * links, legacy hashes, the runs, an earlier export's entries byte for byte, and each archive's point where it names it.
 * `w` collects: walked (where a refusal came from), last, entries, texts.
 */
async function walk(io, parts, listed, chain, w) {
  let walked = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const buf = await io.read(p.path);
    if ((await io.sha256(buf)) !== listed.get(p.path)) refuse(p.path + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
    let start = 0;
    let line = 0;
    let first = 0;
    let lastHere = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(10, start);
      line++;
      // A break in the chain's own rules here may be the one the laptop's check named (code 2).
      w.walked = { file: i, line };
      // A reader that shares its thread with others (the laptop's server) hands a turn of its event loop: taken every 1000 lines.
      if (io.turn && ++walked % 1000 === 0) await io.turn();
      if (nl - start > MAX_LINE) refuse('line ' + line + ' of ' + p.path + ' is over 64 KB');
      const text = io.text(buf.subarray(start, nl));
      start = nl + 1;
      const e = wholeEntry(text);
      if (!e) refuse('line ' + line + ' of ' + p.path + ' is not a whole entry');
      if (!e.k && (await io.sha256(io.bytes(canonical(e)))) !== e.h) refuse('entry ' + e.seq + ' (line ' + line + ' of ' + p.path + ') was changed after it was written');
      const why = chain.next(e);
      if (why) refuse(why + ' (line ' + line + ' of ' + p.path + ')');
      w.walked = null;
      if (chain.count === 1) w.firstPrev = e.prev;
      if (w.points && w.points.has(e.seq) && w.points.get(e.seq) !== e.h) refuse('entry ' + e.seq + ' (line ' + line + ' of ' + p.path + ') is not the archive point the archive before it names');
      lastHere = e.seq;
      if (w.against && w.against.texts.has(e.seq) && w.against.texts.get(e.seq) !== text) {
        refuse('entry ' + e.seq + ' is not the same in the two exports: the log was written again between ' + dayUtc(w.against.made) + ' and ' + dayUtc(w.made));
      }
      if (!first) first = e.seq;
      w.last = e;
      if (w.entries) w.entries.push(e);
      if (w.texts) w.texts.set(e.seq, text);
    }
    if (first !== p.f.first || lastHere !== p.f.last) refuse(p.path + ' holds ' + rangeOf(first, lastHere) + '; ' + p.by + ' says ' + rangeOf(p.f.first, p.f.last));
  }
}
/** Each span of a walked chain, said with its accept: one the chain holds, or (an archive's) one its archive.json names. */
function spanLines(chain, closed = new Map()) {
  return chain.spans.map((s) => {
    const id = 's' + s.from + '-' + s.to;
    const a = chain.accepts.get(id) || closed.get(id);
    const what = s.runs.map((r) => (r.kind === 'plain' ? rangeOf(r.from, r.to) + ' with plain hashes' : rangeOf(r.from, r.to) + ' under key id ' + r.kind.slice(0, 4) + '… (their own claim)')).join(', ');
    return (a ? '◇ ' : '△ ') + what + ': ' + (a ? 'accepted on the AGMessage laptop by entry ' + a.seq + ' (' + dayUtc(a.at) + ')' : 'not accepted on the laptop');
  });
}

/** Which folder SHA256SUMS describes: an archive's alone (it lists archive.json, and no manifest), or an export. */
const folderOf = (text) => (/(^|\n)[0-9a-f]{64} {2}archive\.json\n/.test(text) && !/(^|\n)[0-9a-f]{64} {2}manifest\.json\n/.test(text) ? 'archive' : 'export');

/**
 * Check the folder of an export, or an archive's folder alone (H.9.5, H.10.3), through `io`. `fingerprint`: the 64 hex the
 * auditor expects (none: code 4 at best); `list`: keep the entries for reading; `keep`: keep each entry's line by seq (for
 * a later compare); `against`: an earlier export's {texts, log, made, fp} to compare with. Resolves {code, kind, why?,
 * said, m (the manifest, or archive.json), fp, entries?, texts?, spans?, accepts?, broken?, bundled}.
 */
async function verifyFolder(io, opts = {}) {
  let sums;
  try { sums = await io.read('SHA256SUMS'); } catch (e) {
    if (e instanceof Refused) return { code: 3, kind: 'export', why: e.message, said: [], m: null, fp: '', bundled: {} };
    throw e;
  }
  const text = io.text(sums);
  return folderOf(text) === 'archive' ? verifyArchive(io, sums, text, opts) : verifyExport(io, sums, text, opts);
}

async function verifyExport(io, sumsBuf, sumsText, { fingerprint = '', list = false, keep = false, against = null } = {}) {
  const said = [];
  const st = { m: null, fp: '', tailOwn: false, parts: [] };
  const w = { walked: null, last: null, entries: list ? [] : null, texts: keep ? new Map() : null, against, made: 0, points: new Map() };
  const bundled = {};   // the bundle's verify/ files, digest-checked, for where a verifier came from
  try {
    // 0. The folder: SHA256SUMS's paths, then the manifest's, each of the set, before anything else is opened.
    const sums = parseSums(sumsText);
    if (sums.why) refuse(sums.why);
    const listed = new Map(sums.list.map((s) => [s.path, s.digest]));
    if (!listed.has('manifest.json') || !listed.has('signing-key.pem')) refuse('SHA256SUMS does not list manifest.json and signing-key.pem');
    let m;
    try { m = JSON.parse(io.text(await io.read('manifest.json'))); } catch (e) { if (e instanceof Refused) throw e; refuse('manifest.json is not JSON'); }
    st.m = m;
    const shape = manifestProblem(m);
    if (shape) refuse(shape);
    w.made = m.made;
    for (const f of m.files) { const why = pathProblem(f.path); if (why) refuse('manifest.json names ' + why); }
    const logs = m.files.map((f) => f.path);
    if (new Set(logs).size !== logs.length) refuse('manifest.json lists a log file twice');
    for (const p of logs) if (!listed.has(p)) refuse('SHA256SUMS does not list ' + p + ', which manifest.json names');
    for (const p of listed.keys()) if (isLogPath(p) && !logs.includes(p)) refuse('SHA256SUMS lists ' + p + ', which manifest.json does not name');
    // The archives it names, oldest first: a present one's own four files are listed under archive/<name>/, and nothing
    // is listed under a name it does not carry (H.10.7).
    const arcs = (m.archives || []).slice().sort((x, y) => x.entries.from - y.entries.from);
    const byName = new Map();
    for (const a of arcs) { if (byName.has(a.name)) refuse('manifest.json lists the archive ' + a.name + ' twice'); byName.set(a.name, a); }
    for (const p of listed.keys()) {
      const x = inArchive(p);
      if (x && !(byName.has(x.name) && byName.get(x.name).present)) refuse('SHA256SUMS lists ' + p + ', which is in no archive manifest.json says the export holds');
    }
    const extra = await io.unlisted((p) => listed.has(p) || p === 'SHA256SUMS' || p === 'SHA256SUMS.sig');
    if (extra.length) refuse(extra.slice(0, 20).map((p) => p + ' is not part of the export').join('; ') + ' (not read)');

    // 1. The key: the signing key's fingerprint is the manifest's, and the one expected.
    const { key, fp } = await keyFrom(io, await io.read('signing-key.pem'), 'signing-key.pem');
    st.fp = fp;
    if (fp !== m.signingKey.fingerprint) refuse('manifest.json names key ' + shortKey(m.signingKey.fingerprint) + ', and signing-key.pem is key ' + shortKey(fp));
    if (fingerprint && fp !== fingerprint) refuse('signed by key ' + shortKey(fp) + ', not the key you expected (' + shortKey(fingerprint) + ')');

    // 2. The signature, over SHA256SUMS's exact bytes.
    const sig = await io.read('SHA256SUMS.sig');
    if (sig.length !== 64 || !(await io.verify(key, sig, sumsBuf))) refuse('the signature over SHA256SUMS does not check against signing-key.pem');
    said.push('✓ signed by key ' + grouped(fp) + (fingerprint ? ', the key you expected' : ''));

    // 3. Every listed file against its digest, the logs' included, before any entry is read. Each of the live log's files
    // is also the size the manifest gives and ends with a whole line; the last one's last line is kept, to be the
    // export's own entry. An archive's log files end with a whole line too; their sizes are its archive.json's.
    const lastPath = m.files[m.files.length - 1].path;
    const described = new Map(m.files.map((f) => [f.path, { bytes: f.bytes, by: 'manifest.json' }]));
    for (const p of listed.keys()) { const x = inArchive(p); if (x && isArchiveLog(x.path)) described.set(p, { by: 'archive.json' }); }
    const small = new Map();   // each archive's own four files, read here once
    let tail = null;
    const sizes = await filesHold(io, listed, described, {
      onFile: (p, buf) => {
        if (p === lastPath) tail = wholeEntry(lastLine(io, buf));
        if (p.startsWith('verify/')) bundled[p] = buf;
        const x = inArchive(p);
        if (x && ARCHIVE_PATHS.indexOf(x.path) >= 0) small.set(p, buf);
      },
    });
    const target = '1-' + m.entries.to + ';' + m.signingKey.fingerprint.slice(0, 16);
    /** The export's own entry: the last of the bundle, the head and the range manifest.json names. */
    const own = (e) => !!e && e.action === 'audit.export' && e.k === m.kid && e.l === m.log && e.seq === m.entries.to && e.seq === m.head.seq && e.h === m.head.h && e.target === target;
    st.tailOwn = own(tail);

    // 4. Each archive the export carries, as a folder of its own inside it: its own signature by its own key, its files
    // against its own SHA256SUMS, its archive.json, the pin manifest.json gives it, and the archive before it. A failure
    // the laptop's own signed check names is the log as it was exported (code 2); any other, the bundle disagreeing with
    // itself (3).
    const named = (a) => m.check.findings.some((f) => f && f.id === 'a' + a.split);
    const fail = (a, why) => { const words = 'the archive ' + a.name + ' ' + why; if (named(a)) throw new Named(words); refuse(words); };
    const parts = [];
    let before = null;
    for (const a of arcs) {
      if (!a.present) { before = a; continue; }
      const base = 'archive/' + a.name + '/';
      for (const f of ARCHIVE_PATHS) if (!small.has(base + f)) fail(a, 'is not what was split off: ' + f + ' is not in it');
      const aSums = small.get(base + 'SHA256SUMS');
      if ((await io.sha256(aSums)) !== a.digest) fail(a, 'is not the one manifest.json pins: its SHA256SUMS differs');
      const ownSums = parseSums(io.text(aSums), 'archive');
      if (ownSums.why) fail(a, 'does not check: ' + ownSums.why);
      const ownListed = new Map(ownSums.list.map((x) => [x.path, x.digest]));
      for (const [p, d] of ownListed) if (listed.get(base + p) !== d) fail(a, 'is not what was split off: ' + p + (listed.has(base + p) ? ' is not what its SHA256SUMS says' : ' is not in it'));
      for (const p of listed.keys()) {
        const rel = p.startsWith(base) ? p.slice(base.length) : '';
        if (rel && !ownListed.has(rel) && rel !== 'SHA256SUMS' && rel !== 'SHA256SUMS.sig') fail(a, 'holds ' + rel + ', which its SHA256SUMS does not list');
      }
      let aj;
      try { aj = JSON.parse(io.text(small.get(base + 'archive.json'))); } catch { fail(a, 'is not what was split off: archive.json is not JSON'); }
      const ashape = archiveProblem(aj);
      if (ashape) fail(a, 'is not what was split off: ' + ashape);
      let akey;
      try { akey = await keyFrom(io, small.get(base + 'signing-key.pem'), base + 'signing-key.pem'); } catch (e) { if (e instanceof Refused) fail(a, 'does not check: ' + e.message); throw e; }
      if (akey.fp !== aj.signingKey.fingerprint) fail(a, 'names key ' + shortKey(aj.signingKey.fingerprint) + ', and its signing-key.pem is key ' + shortKey(akey.fp));
      const asig = small.get(base + 'SHA256SUMS.sig');
      if (asig.length !== 64 || !(await io.verify(akey.key, asig, aSums))) fail(a, 'does not check: its signature over its SHA256SUMS does not check against its own signing-key.pem');
      if (aj.log !== m.log) fail(a, 'is of another log (' + aj.log.slice(0, 8) + '…)');
      if (aj.entries.from !== a.entries.from || aj.entries.to !== a.entries.to) fail(a, 'holds ' + rangeOf(aj.entries.from, aj.entries.to) + '; manifest.json says ' + rangeOf(a.entries.from, a.entries.to));
      const want = before ? { name: before.name, digest: before.digest, split: before.split } : null;
      const pr = aj.previous;
      if (want ? !(pr && pr.name === want.name && pr.digest === want.digest && pr.split === want.split) : pr !== null) fail(a, 'does not name the archive before it as manifest.json does');
      for (const f of aj.files) {
        const p = base + f.path;
        if (!ownListed.has(f.path)) fail(a, 'does not list ' + f.path + ' in its SHA256SUMS');
        if (sizes.get(p) !== f.bytes) fail(a, 'is not what was split off: ' + f.path + ' is ' + sizes.get(p) + ' bytes; archive.json says ' + f.bytes);
        parts.push({ path: p, f, by: 'archive.json' });
      }
      w.points.set(aj.point.seq, aj.point.h);
      // Named, not failed: the bundle's own signature, by the expected key, covers every byte of the archive.
      said.push((akey.fp === fp ? '✓ ' : '△ ') + 'the archive ' + a.name + ' (' + rangeOf(a.entries.from, a.entries.to) + ') is signed by '
        + (akey.fp === fp ? 'the same key, and every file of it is what its SHA256SUMS says' : 'key ' + shortKey(akey.fp) + ' (its own claim): the machine key changed after the split'));
      before = a;
    }
    for (const f of m.files) parts.push({ path: f.path, f, by: 'manifest.json' });
    st.parts = parts;

    // 5. The entries, the archives' first, oldest first, then log/, as one chain: from entry 1, or from the point after
    // the newest archive the export lists as no longer on the laptop.
    const chain = new Chain(m.kid, { atPoint: m.entries.from > 1 });
    await walk(io, parts, listed, chain, w);
    const open = chain.end();
    if (open) refuse(open);
    if (!own(w.last)) refuse('the last entry is not the export\'s own (audit.export, ' + target + ', the head manifest.json names)');
    if (chain.from !== m.entries.from) refuse('the entries do not begin at entry ' + m.entries.from);
    const gone = arcs.filter((a) => !a.present);
    if (m.entries.from > 1 && !gone.some((a) => a.entries.to === m.entries.from - 1)) refuse('the entries do not begin at entry 1, and no archive manifest.json lists as gone ends before entry ' + m.entries.from);
    // Each archive is pinned by the keyed split that made it: its point, and the SHA-256 of its SHA256SUMS.
    for (const a of arcs) {
      const s = chain.splits.find((x) => x.seq === a.split);
      if (!s || s.point !== a.entries.to + 1 || s.digest !== a.digest) refuse('no split in the bundle pins the archive ' + a.name + ' (entry ' + a.split + ', as manifest.json says)');
    }
    if (against) {
      if (against.log !== m.log) refuse('the two exports are of different logs (' + against.log.slice(0, 8) + '…, ' + m.log.slice(0, 8) + '…)');
      const seqs = Array.from(against.texts.keys());
      const beyond = seqs.filter((s) => s > w.last.seq);
      if (beyond.length) refuse(rangeOf(beyond[0], beyond[beyond.length - 1]) + ' of the earlier export are not in this one');
      const missingHere = seqs.filter((s) => s < chain.from);
      if (missingHere.length) {
        const a = gone.find((x) => x.entries.to === chain.from - 1);
        const acc = a ? chain.accepts.get('a' + a.split) : null;
        said.push('△ ' + rangeOf(missingHere[0], missingHere[missingHere.length - 1]) + ' are not in the later export: their archive was accepted as gone' + (acc ? ' (entry ' + acc.seq + ')' : ''));
      }
      const compared = seqs.filter((s) => s >= chain.from);
      if (compared.length) said.push('✓ the same: ' + rangeOf(compared[0], compared[compared.length - 1]) + ' of the earlier export (made ' + whenUtc(against.made) + ') are in this one, byte for byte');
    }
    const held = arcs.filter((a) => a.present);
    const inArchives = held.length ? ' (' + rangeOf(held[0].entries.from, held[held.length - 1].entries.to) + ' from ' + plural(held.length, 'archive') + ')' : '';
    said.push('✓ whole: ' + rangeOf(m.entries.from, m.entries.to) + inArchives + ' in ' + plural(parts.length, 'file') + ', every line whole and linked to the one before, the plain hashes holding, the key changing only at a named boundary, and the last entry the export\'s own');
    for (const a of gone) {
      const acc = chain.accepts.get('a' + a.split);
      said.push('△ ' + rangeOf(a.entries.from, a.entries.to) + ' are not in this bundle: archive ' + a.name + ', no longer on the laptop (' + (acc ? 'accepted at entry ' + acc.seq + ' on ' + dayUtc(acc.at) : 'not accepted on the laptop') + '); its pin is ' + shortKey(a.digest));
    }
    said.push(...spanLines(chain));
    return { code: fingerprint ? codeFor(m.check.mark) : 4, kind: 'export', said, m, fp, entries: w.entries, texts: w.texts, spans: chain.spans, accepts: chain.accepts, bundled };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const m = st.m;
    const signed = (!fingerprint || st.fp === fingerprint) && st.tailOwn;
    // The laptop's own signed check names this archive as not what was split off: the bundle is what was exported (2).
    if (e instanceof Named && signed) {
      said.push('✓ every file is what was signed: each matches its SHA-256 in SHA256SUMS, and the last entry is the export\'s own');
      said.push('✕ the entries break where the laptop\'s own check said they do: ' + e.message);
      return { code: fingerprint ? 2 : 4, kind: 'export', said, m, fp: st.fp, broken: e.message, bundled };
    }
    // The entries break at or after the line the laptop's own check named. `walked` is set only inside the entries' walk,
    // so steps 0-4 passed: the key, the signature and every file's digest. With the last entry the export's own, the
    // bundle is what was exported, and the log was broken then (code 2). Anywhere else, the bundle disagrees with itself (3).
    if (w.walked && m.check.mark === 'broken' && signed && st.parts.length && st.parts[0].f.first === m.entries.from) {
      const at = st.parts.findIndex((p) => p.path === 'log/' + m.check.file);
      if (at >= 0 && Number.isSafeInteger(m.check.brokenAt) && (at < w.walked.file || (at === w.walked.file && m.check.brokenAt <= w.walked.line))) {
        said.push('✓ every file is what was signed: each matches its SHA-256 in SHA256SUMS, and the last entry is the export\'s own');
        said.push('✕ the entries break where the laptop\'s own check said they do: ' + e.message);
        return { code: fingerprint ? 2 : 4, kind: 'export', said, m, fp: st.fp, broken: e.message, bundled };
      }
    }
    return { code: 3, kind: 'export', why: e.message, said, m, fp: st.fp, bundled };
  }
}

/**
 * An archive's folder checked alone (H.10.3, H.10.7): its signature by its own key, compared with the one expected; its
 * files against its SHA256SUMS; its archive.json; its entries from the one its first follows, as the laptop walked them.
 * Its verdict is the laptop's at the split, signed: 0 ✓, 1 ◇, 3 on any failure or another key, 4 with no key to compare.
 */
async function verifyArchive(io, sumsBuf, sumsText, { fingerprint = '', list = false, keep = false } = {}) {
  const said = [];
  let a = null;
  let fp = '';
  try {
    const sums = parseSums(sumsText, 'archive');
    if (sums.why) refuse(sums.why);
    const listed = new Map(sums.list.map((s) => [s.path, s.digest]));
    if (!listed.has('archive.json') || !listed.has('signing-key.pem')) refuse('SHA256SUMS does not list archive.json and signing-key.pem');
    try { a = JSON.parse(io.text(await io.read('archive.json'))); } catch (e) { if (e instanceof Refused) throw e; refuse('archive.json is not JSON'); }
    const shape = archiveProblem(a);
    if (shape) refuse(shape);
    const logs = a.files.map((f) => f.path);
    if (new Set(logs).size !== logs.length) refuse('archive.json lists a log file twice');
    for (const p of logs) if (!listed.has(p)) refuse('SHA256SUMS does not list ' + p + ', which archive.json names');
    for (const p of listed.keys()) if (isArchiveLog(p) && !logs.includes(p)) refuse('SHA256SUMS lists ' + p + ', which archive.json does not name');
    const extra = await io.unlisted((p) => listed.has(p) || p === 'SHA256SUMS' || p === 'SHA256SUMS.sig');
    if (extra.length) refuse(extra.slice(0, 20).map((p) => p + ' is not part of the archive').join('; ') + ' (not read)');
    const k = await keyFrom(io, await io.read('signing-key.pem'), 'signing-key.pem');
    fp = k.fp;
    if (fp !== a.signingKey.fingerprint) refuse('archive.json names key ' + shortKey(a.signingKey.fingerprint) + ', and signing-key.pem is key ' + shortKey(fp));
    if (fingerprint && fp !== fingerprint) refuse('signed by key ' + shortKey(fp) + ', not the key you expected (' + shortKey(fingerprint) + ')');
    const sig = await io.read('SHA256SUMS.sig');
    if (sig.length !== 64 || !(await io.verify(k.key, sig, sumsBuf))) refuse('the signature over SHA256SUMS does not check against signing-key.pem');
    said.push('✓ signed by key ' + grouped(fp) + (fingerprint ? ', the key you expected' : ''));
    await filesHold(io, listed, new Map(a.files.map((f) => [f.path, { bytes: f.bytes, by: 'archive.json' }])));
    const chain = new Chain(a.kid, { atPoint: a.entries.from > 1 });
    const w = { walked: null, last: null, entries: list ? [] : null, texts: keep ? new Map() : null, against: null, made: a.made, points: null };
    await walk(io, a.files.map((f) => ({ path: f.path, f, by: 'archive.json' })), listed, chain, w);
    if (chain.from !== a.entries.from || w.firstPrev !== a.start.prev) refuse('the first entry is not the one archive.json says (' + rangeOf(a.entries.from, a.entries.from) + ', following ' + a.start.prev.slice(0, 8) + '…)');
    const open = chain.end();
    if (open) refuse(open);
    said.push('✓ whole: ' + rangeOf(a.entries.from, a.entries.to) + ' in ' + plural(a.files.length, 'file') + ', every line whole and linked to the one before, the plain hashes holding, and the key changing only at a named boundary');
    // An accept written after the point, in the live log, is named by archive.json (H.10.5).
    said.push(...spanLines(chain, new Map(a.check.findings.map((f) => [f.id, f.accept]))));
    // `sums`: the SHA-256 of its SHA256SUMS, which a split's pin names it by.
    return { code: fingerprint ? codeFor(a.check.mark) : 4, kind: 'archive', said, m: a, fp, entries: w.entries, texts: w.texts, spans: chain.spans, accepts: chain.accepts, bundled: {}, sums: await io.sha256(sumsBuf) };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { code: 3, kind: 'archive', why: e.message, said, m: a, fp, bundled: {} };
  }
}

const api = {
  GENESIS, LEGACY_KEYS, KEYED_KEYS, BOUNDARIES, wholeEntry, canonical, canonical2, missing, kindOf, refOf, parseRef, pointRun, splitOf, beginsAt, Runs, Chain,
  FIXED_PATHS, ARCHIVE_PATHS, ARCHIVE_NAME, MARKS, MAX_LINE, pathProblem, isLogPath, isArchiveLog, inArchive, archiveRange, parseSums, manifestProblem, archiveProblem, codeFor,
  Refused, verifyFolder, grouped, whenUtc, dayUtc,
};
if (typeof module === 'object' && module.exports) module.exports = api;
else globalThis.AGMAuditRules = api;
