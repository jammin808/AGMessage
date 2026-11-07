'use strict';
/**
 * The audit log: who did what, when, from where — sign-ins, rights, halls, displays, sends to Stagewatch, commands to
 * other show systems, settings. Append-only (data/audit.jsonl, one JSON line per entry) and chained with a key, as a
 * medical device's audit trail is: each entry carries the hash of the one before it and its own HMAC-SHA256 under Ke, a
 * key derived from this machine's key (lib/secretbox.js), so an entry written, rewritten or relabelled without the key
 * does not check. The rules that need no key (whole lines, links, the legacy hash, runs and boundaries) are
 * verify/auditrules.js, which a checker on another computer runs too.
 *
 * One chain across files: at 20 MB the file is renamed audit-<time>.jsonl and the chain goes on in a new audit.jsonl.
 * `verify()` reads the rotated files oldest first, then this one, and names the first broken file and line.
 *
 * Invariants:
 *   - `write()` makes keyed entries only. An entry from AGMessage 0.5.1 or earlier keeps its SHA-256 and is never
 *     rewritten. The key changes only at a boundary entry under the new key (`audit.keyed`, `audit.rekey`,
 *     `audit.unkeyed`, `audit.keyless`) that names the run before it; `open()` writes the one a log needs.
 *   - Entries not under this machine's key are a span: △ "not vouched for" until the person at the laptop accepts it with
 *     the typed token (an `audit.accept` under this key), ◇ "linked" after, never ✓. A span's kind and words are this
 *     machine's, from what it holds; a boundary inside a span is structure only, and its words are its claim.
 *   - Records outside the data folder (<keyDir>/audit/, MACed under Kh): the head (the newest entry on disk, fsynced),
 *     the log this machine wrote last and where, which log each file path last held, whether this machine has keyed a
 *     log, and the runs it wrote without its key. They are read once, at `open()`, and written through one lane, only
 *     once an entry carrying the log's id is on disk. A disagreement between them and the log is an entry of its own
 *     (`audit.cut`, `audit.head`) and a finding of every check until accepted; a record that cannot be read leaves this
 *     run △ and is not written over. The entry the head names, found with its hash under another key id, is a changed
 *     entry: ✕ at every check, never a span and never accepted.
 *   - A check broken at a line is what health reads until a whole check replaces it.
 *   - An export's check (`checkThrough`, lib/auditexport.js) reads the bytes the export holds open, up to its own entry,
 *     and changes nothing this run reads; the newest export sent whole under this key is health's "Last export".
 *   - The head covers only what is durable: an entry counts as on disk once its fsync returned.
 *   - The log carries on across events (H.10). An archive point (`audit.archive`, `point()`) is the first line of a file
 *     of its own and names the run it stands in, so a split there (lib/auditarchive.js) moves whole files and never
 *     rewrites a line. After a split the walk begins at that point, which a keyed `audit.split` must name, and names every
 *     archive back to entry 1 (each pinned by the split that made it, and each naming the one before it): one gone or
 *     changed is a finding, a split stopped part way is a condition (its files are walked first), and the mark is the
 *     worst of the live log's and each archive's, so a split never makes the log read better than it did.
 *   - Two rotated files never share a name: each is named by the later of now and 1 ms after the newest rotated file.
 *
 * Written synchronously and flushed: an entry is on disk (fsync) before the action is acknowledged. When the disk will
 * not take it (full, or the file held by another program) the entry stays chained in memory, the console and health say
 * so, and it is written ahead of the next one (or by `flush()` when the server stops), so the chain on disk stays
 * whole. A half-written last line left by a power cut is kept aside (audit-torn-<time>.bin) and cut when the log is
 * opened, and the cut is an entry of its own ('audit.repair'). Nothing is written until the first `write()` or `open()`:
 * a second copy of the server reading the folder changes nothing.
 *
 * What it cannot show (docs/ACCOUNTS.md): anything done by whoever can change AGMessage's code, its Node or its start
 * script, or holds this machine's key; a whole machine restored from one image; which person acted, when the actor can
 * write the data folder; the earlier entries of a log first seen keyed here (△ until accepted); the newest entries
 * removed after a crash, between their fsync and the head's save.
 *
 * Never a secret: passwords, tokens, keys and display URLs are not fields an entry or a record can carry (the caller
 * passes words and ids, and `write()` keeps only the listed fields, each cut short); a computed MAC is never in words.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WriteLane, writeFileAtomic, placeId } = require('./resilience');
const rules = require('../verify/auditrules');

const ROTATE_BYTES = 20 * 1024 * 1024;
const WORDS_MAX = 300;   // an entry's words, in characters: a row written longer is cut at it
// A Windows account's row (actor `windows`, the machine's events) names its accounts by SID, whole: the longest a SID can be
// written ("S-1-", a 48-bit authority, fifteen sub-authorities). Every other actor's id is at most 40, its target 80.
const SID_MAX = 184;
const GENESIS = rules.GENESIS;
const SLICE = 1000;        // lines checked between turns of the event loop
const RECENT = 500;        // rows kept for the list
const HELD_MAX = 16;       // findings a head carries while their entries are not on disk, then one `more`
const TORN_ENTRY = 4096;   // a fragment longer than this held more than one half-written line
const ROTATED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
/** The folder beside the log that holds its archives (H.10.3), and a split's folder while it is made aside. */
const ARCHIVES = 'audit-archive';
const PARTIAL = /^\.(audit-[0-9a-f]{8}-[1-9][0-9]{0,9}-[1-9][0-9]{0,9})\.partial$/;
const ARCHIVE_IN_WORDS = /audit-[0-9a-f]{8}-[1-9][0-9]{0,9}-[1-9][0-9]{0,9}/g;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The labels of the log's two keys (lib/secretbox.js derives only allow-listed ones). */
const LABELS = Object.freeze({ entry: 'agmessage audit entry v1', head: 'agmessage audit head v1' });
const SYSTEM = Object.freeze({ t: 'system', id: '', name: '' });
const SHAPE = Object.freeze({ intact: '✓', linked: '◇', unvouched: '△', broken: '✕' });
const RANK = Object.freeze({ intact: 0, linked: 1, unvouched: 2, broken: 3 });
/** What each kind of finding `open()` writes reads until accepted: ✕ is accepted only with its own confirmation. */
const FINDING = Object.freeze({
  cut: 'broken', fork: 'broken', another: 'broken', last: 'broken', nohead: 'broken', changed: 'broken', lost: 'broken',
  otherkey: 'unvouched', unread: 'unvouched', record: 'unvouched', archive: 'broken',
});
const CUTS = new Set(['cut', 'fork', 'another', 'last']);
// The records' fields, in the order their MAC is taken over.
const FIELDS = Object.freeze({
  head: ['v', 'log', 'path', 'kid', 'seq', 'h', 'run', 'held', 'at'],
  latest: ['v', 'log', 'path', 'seq', 'at'],
  folder: ['v', 'folder', 'path', 'log', 'at'],
  keyed: ['v', 'since', 'log'],
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
/** A legacy entry's hash, as AGMessage 0.5.1 and earlier wrote it. */
const hashOf = (e) => sha256(rules.canonical(e));
/** A keyed entry's HMAC under Ke. */
const macOf = (e, key) => hmac(key, rules.canonical2(e));
/** The id of a log key: never a prefix of it, the same for one key on every machine. */
const kidOf = (key) => crypto.createHash('sha256').update('agmessage audit key id\n').update(key).digest('hex').slice(0, 16);
/** Two hex MACs compared in constant time, once both are the right shape. */
const sameMac = (a, b) => typeof a === 'string' && typeof b === 'string' && HEX64.test(a) && HEX64.test(b) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
/** A record's text: its fields in order, then the MAC of them under Kh. */
function sealRecord(rec, key) { return JSON.stringify({ ...rec, mac: hmac(key, JSON.stringify(rec)) }); }
/** The log's keys from a `derive(label)` (secretbox.derive, or a fixed key's in tests): {entry: Ke, head: Kh}. */
const keysFrom = (derive) => () => ({ entry: derive(LABELS.entry), head: derive(LABELS.head) });

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v === undefined || v === null ? '' : String(v).slice(0, n));

/**
 * An entry's words that end in a list: `head`, then ': ' and the names joined with commas, as many as fit in an entry's
 * words (WORDS_MAX), the rest counted ("…, Media · MDR7VX2C and 3 more"; "20 more" when not one fits), so a list is
 * never cut part way through a name by the entry's own bound. No names, the head alone.
 */
function wordsWithList(head, names) {
  if (!names.length) return head;
  const room = WORDS_MAX - head.length - 2;
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const next = (out ? out + ', ' : '') + names[i];
    const rest = names.length - i - 1;
    if (next.length + (rest ? (' and ' + rest + ' more').length : 0) > room) return head + ': ' + (out ? out + ' and ' : '') + (names.length - i) + ' more';
    out = next;
  }
  return head + ': ' + out;
}
/** A file's bytes, or why not: {buf, code} ('' when read). The one way this file reads a file. */
const readOr = (f) => { try { return { buf: fs.readFileSync(f), code: '' }; } catch (e) { return { buf: null, code: e.code || 'EIO' }; } };
const turn = () => new Promise((resolve) => { setImmediate(resolve); });
const missing = rules.missing;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
/** A rotated file's name for its time, and the time a rotated file's name gives (0 when it gives none). */
const rotatedName = (stem, t) => stem + '-' + new Date(t).toISOString().replace(/[:.]/g, '-') + '.jsonl';
const timeOfRotated = (file) => {
  const m = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/.exec(path.basename(String(file)));
  return m ? Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + 'Z') || 0 : 0;
};
/** "1,204": a count of bytes as a person reads it. */
const count = (n) => Number(n).toLocaleString('en-US');
const pad = (n) => String(n).padStart(2, '0');
/** "14:02 on 25 Oct", by this laptop's clock. */
const when = (at) => { const d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' on ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; };
/** "26 Oct". */
const day = (at) => { const d = new Date(at); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
const short = (kid) => String(kid).slice(0, 4) + '…';
/** "entry 5 has" / "entries 1–5 have": a range with its verb. */
const range = (a, b, one, many) => (a === b ? 'entry ' + a + ' ' + one : 'entries ' + a + '–' + b + ' ' + many);
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** The whole lines of a buffer, oldest first, as [text, line number], without one big string; a last line with no newline is not whole yet. */
function* wholeLines(buf) {
  let start = 0;
  let n = 0;
  for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
    n++;
    if (nl > start) yield [buf.toString('utf8', start, nl), n];
    start = nl + 1;
  }
}
/** The whole lines of a buffer, newest first, as [text, line number]. */
function* linesBack(buf) {
  let n = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) n++;
  let end = buf.lastIndexOf(10);
  while (end >= 0) {
    const nl = end === 0 ? -1 : buf.lastIndexOf(10, end - 1);
    if (end > nl + 1) yield [buf.toString('utf8', nl + 1, end), n];
    n--;
    end = nl;
  }
}

// A line's seq, key and hash read from its two ends, without parsing it: what open() scans the tail by.
const LINE_SEQ = /^\{"seq":([1-9][0-9]{0,15}),/;
const LINE_KEYED = /,"l":"([0-9a-f]{32})","k":"([0-9a-f]{16})","h":"([0-9a-f]{64})"\}$/;
const LINE_PLAIN = /,"prev":"[0-9a-f]{64}","h":"([0-9a-f]{64})"\}$/;
function factsOf(text) {
  const s = LINE_SEQ.exec(text);
  if (!s) return null;
  const k = LINE_KEYED.exec(text);
  if (k) return { seq: Number(s[1]), l: k[1], k: k[2], h: k[3] };
  const p = LINE_PLAIN.exec(text);
  return p ? { seq: Number(s[1]), l: '', k: '', h: p[1] } : null;
}

/**
 * The words a span is told by: each of its runs, as this machine knows it (`first`: the first keyed start's own log).
 * `linked`: the shorter words of a span already accepted, which the ◇ answer names.
 */
function spanWords(runs, { first, keyless, linked = false }) {
  if (linked) {
    return runs.map((r) => {
      if (r.kind === 'plain') return range(r.from, r.to, 'has', 'have') + ' plain hashes' + (r.from === 1 ? (first ? ' (as AGMessage 0.5.1 and earlier wrote them)' : ' (with no record of them on this laptop)') : ' after entry ' + (r.from - 1) + ' (a rollback, or anyone who could write the folder)');
      return keyless.some((x) => x.kid === r.kind)
        ? range(r.from, r.to, 'was', 'were') + ' written here while this machine had no machine key'
        : range(r.from, r.to, 'carries', 'carry') + ' key id ' + short(r.kind) + ' (their own claim)';
    }).join('; ');
  }
  return runs.map((r) => {
    if (r.kind === 'plain' && r.from === 1) {
      return first
        ? range(r.from, r.to, 'has', 'have') + ' plain hashes, as AGMessage 0.5.1 and earlier wrote them, and nothing vouches for them until they are accepted'
        : range(r.from, r.to, 'has', 'have') + ' plain hashes and came to this laptop with no record of them: from an AGMessage that does not key its log (0.5.1 or earlier), or changed by anyone who could write the folder';
    }
    if (r.kind === 'plain') return range(r.from, r.to, 'has', 'have') + ' plain hashes after entry ' + (r.from - 1) + ': written by an AGMessage that does not key its log (0.5.1 or earlier, a rollback), or by anyone who could write the folder';
    const k = keyless.find((x) => x.kid === r.kind);
    if (k) return range(r.from, r.to, 'was', 'were') + ' written here while this machine had no machine key (' + k.code + ', ' + when(k.at) + '): linked, and not checkable';
    return range(r.from, r.to, 'carries', 'carry') + ' key id ' + short(r.kind) + ' (their own claim), a key this machine does not hold: keyed on another computer or Windows account, or written by anyone who could write the folder; this machine cannot check them';
  }).join('; ');
}
/**
 * A split stopped part way, in words: its point, how many files are still to move (or, every file moved, that its folder
 * still has the name it was made aside under), and why when this run knows.
 */
const unfinishedWords = (u, code) => 'the split at entry ' + u.seq + ' is not finished: '
  + (u.left ? (u.left === 1 ? '1 file' : u.left + ' files') + ' still to move' : 'every file is moved, and its folder is not renamed yet') + (code ? ' (' + code + ')' : '');
/** The entry this machine recorded last, found with its hash under another key id: changed, and never accepted. */
const relabelWords = (f) => 'entry ' + f.seq + ' was changed after it was written: it carries the hash this machine recorded for its entry ' + f.seq + ', under key id ' + short(f.k || 'plain') + ' (their own claim), not this machine\'s key';
/** What Health's "Last export" says of an `audit.export.sent` entry: when, by whom, and its range (its target, `1-1702`). */
function exportOf(e) {
  const m = /^([1-9][0-9]{0,15})-([1-9][0-9]{0,15})$/.exec(e.target);
  return { at: e.at, by: e.actor.name || e.actor.t, from: m ? Number(m[1]) : 0, to: m ? Number(m[2]) : 0 };
}
/** A span's kind: plain from entry 1, unkeyed (plain after keyed), keyless (this machine without its key), or another key. */
function spanKind(runs, keyless) {
  if (runs.every((r) => r.kind === 'plain')) return runs[0].from === 1 ? 'plain' : 'unkeyed';
  if (runs.every((r) => r.kind !== 'plain' && keyless.some((x) => x.kid === r.kind))) return 'keyless';
  return 'other';
}

class AuditLog {
  /**
   * @param {string} file the current file (data/audit.jsonl)
   * @param {object} o `keys`: () => {entry, head}, which throws when this machine has no key (keysFrom); `records`: the
   *   folder outside the data folder that holds the records (<keyDir>/audit); `version`: the running version, for words.
   *   It refuses to start without both, so nothing can run on a key or a folder it was not given.
   */
  constructor(file, { keys, records, version } = {}) {
    if (typeof keys !== 'function' || typeof records !== 'string' || !records) throw new Error('the audit log needs its keys and its records folder');
    this.file = file;
    this.path = path.resolve(file);
    this.stem = path.basename(file).replace(/\.jsonl$/, '');
    this.keysOf = keys;
    this.records = records;
    this.version = version || require('./version').BUILD.version;
    this.seq = 0;
    this.last = GENESIS;
    this.onDisk = { seq: 0, h: GENESIS };   // the newest entry known to be on disk: its fsync returned
    this.recent = [];       // the last 500 rows, newest last: {e, mark} or {bad: {line, file}}, for the admin page
    this.pending = '';      // whole lines chained but not yet on disk, written ahead of the next entry
    this.unwritten = 0;     // entries in `pending`
    this.lastError = null;  // why the last write did not reach the disk, until one does
    this.lastCode = '';     // its error code (ENOSPC, EBUSY), for words that name it
    this.rotations = 0;
    this.opened = false;
    this.checking = null;   // the check running now: a second click shares it
    this.onPut = null;      // told how long each append that reached the disk took (open, write, fsync, close), in ms: health's peaks
    this.keyless = null;    // why this run has no machine key: {code, words}
    this.kid = '';
    this.l = '';            // this log's id, carried by every keyed entry
    this.runFirst = null;   // the first entry of this machine's run the newest entry stands in
    this.headOff = '';      // why the head is not written this run (it could not be read)
    this.latestOff = false; // latest.json could not be read: not written this run
    this.folderOff = false;
    this.keyedOff = false;
    this.keyedState = '';   // keyed.json: 'absent' until this machine keys a log ('unread', 'changed' and 'ok' all say it has)
    this.keylessRuns = [];  // this log's runs this machine wrote without its key (its markers)
    this.keylessCode = '';  // why the keyless marker could not be read (any error but ENOENT)
    this.saved = null;      // the head this run last saved: {seq, h}
    this.base = 0;          // the newest entry on disk at open(): what the head was compared with, not what it covers
    this.lOnDisk = false;   // an entry carrying this log's id is on disk: only then are its records written
    this.lFrom = 0;         // the first entry this run writes under a new log id
    this.openDue = false;   // the records open() writes (the folder record, keyed.json) are still to land
    this.anchor = null;     // the head read at open(): {seq, h}, the entry this machine recorded last
    this.moved = '';        // where the head says this log was last written, when that is another path
    this.producing = null;
    this.findings = [];     // the cut and head entries this run wrote: {seq, kind, words}
    this.found = [];        // what open() found, for the console and health until a check has run
    this.spans = [];        // spans known (open, then each check): {id, from, to}
    this.accepted = new Map();   // finding id -> when an accept on disk took it
    this.waitingAccepts = [];    // accepts not on disk yet: [{seq, ids, at}]
    this.lastCheck = null;  // the newest check's open findings, for health
    this.lastExport = null; // the newest export sent whole, under this key, on disk: {at, by, from, to} (Health's "Last export")
    this.exportWaiting = null; // an `audit.export.sent` not on disk yet: it becomes "Last export" once its fsync returned
    this.archiveDir = path.join(path.dirname(file), ARCHIVES);   // the archives a split makes (H.10.3)
    this.rotatedAt = null;  // the newest rotated file's time, read once when a rotation first needs it
    this.backCut = false;   // the newest backward read stopped at an older file it could not read
    this.splitting = null;  // a split being made now: a check asked meanwhile waits for it
    this.splitCode = '';    // why the last split's files did not all move (EBUSY), for its condition's words
    this.from = 1;          // the newest whole check's first entry: 1, or the archive point after the newest split
    this.archives = [];     // the archives it named, oldest first (H.10.4)
    this.unreached = [];    // this log's archive folders the chain of archives does not reach
    this.points = [];       // the archive points in the live log
    this.splitsSeen = [];   // the keyed splits the newest whole check walked
    this.unfinished = null; // a split stopped part way: {seq (its point), split, name, left}
    this.whole = false;     // the newest published check walked the log to its end: only then may a split's leftovers be removed
    this.pins = null;       // archive name -> the SHA-256 of its SHA256SUMS that the chain pins it by, from the newest published check
    this.leftAside = [];    // split folders the newest finish left as they are (`.<name>.partial`), with why
    this.headLane = new WriteLane(path.join(records, 'head.json'), { delayMs: 200, keepBak: false, mode: 0o600, files: true });
    this.headLane.onSaved = () => {
      const p = this.producing;
      if (!p) return;
      if (p.head) this.saved = p.at;
      if (p.open) this.openDue = false;
    };
    let buf = readOr(file).buf || Buffer.alloc(0);
    const whole = buf.lastIndexOf(10) + 1;
    this.torn = buf.length - whole;     // a last line without its newline (a power cut mid-append): kept aside and cut at open()
    this.tornBytes = this.torn ? Buffer.from(buf.subarray(whole)) : null;
    buf = buf.subarray(0, whole);
    this.size = whole;
    this.buf = buf;           // the newest file's whole lines, kept until open() has read its tail
    this.loadedFrom = file;
    // A file with no entry yet (a rotation the power cut interrupted) goes on from the newest rotated file.
    if (!this._load(buf, path.basename(file))) {
      const older = this.rotated().pop();
      if (older) { this.buf = readOr(older).buf || Buffer.alloc(0); this.loadedFrom = older; this._load(this.buf, path.basename(older)); }
    }
  }

  /** Take the newest 500 rows and the chain's tail from a log's text. Returns whether it held an entry. */
  _load(buf, name) {
    const rows = [];
    for (const [text, n] of linesBack(buf)) {
      rows.push({ text, n });
      if (rows.length >= RECENT) break;
    }
    rows.reverse();
    let tail = null;
    const recent = [];
    for (const { text, n } of rows) {
      const e = rules.wholeEntry(text);
      if (e) recent.push({ e, mark: null });
      else recent.push({ bad: { line: n, file: name } });
      const f = factsOf(text);
      if (f) tail = f;
    }
    if (!tail) return false;
    this.recent = recent;
    this.seq = tail.seq; this.last = tail.h;
    this.onDisk = { seq: tail.seq, h: tail.h };
    return true;
  }

  /** The rotated files beside a log file (this one's by default), oldest first: their names sort by time. */
  rotated(file = this.file) {
    const dir = path.dirname(file);
    const prefix = path.basename(file).replace(/\.jsonl$/, '') + '-';
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no folder: no rotated files */ }
    return names.filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl') && ROTATED_TIME.test(f.slice(prefix.length, -6))).sort().map((f) => path.join(dir, f));
  }

  /** The log's entries newest first, as facts read from each line's ends: the newest file, then each older one. */
  * _back() {
    this.backCut = false;
    for (const [text] of linesBack(this.buf || Buffer.alloc(0))) { const f = factsOf(text); if (f) { f.text = text; yield f; } }
    const files = this.rotated();
    for (let i = (this.loadedFrom === this.file ? files.length : files.indexOf(this.loadedFrom)) - 1; i >= 0; i--) {
      const r = readOr(files[i]);
      // An older file that cannot be read: what lies before it is the check's to say, and where a run began is not known.
      if (!r.buf) { this.backCut = true; return; }
      for (const [text] of linesBack(r.buf)) { const f = factsOf(text); if (f) { f.text = text; yield f; } }
    }
  }

  /**
   * What open() needs from the tail, read backward and only as far as it must: the newest entry, its run, the newest
   * keyed entry, whether this key wrote any of it, the runs of the span at the tail (entries not under this key), and the
   * entry at the head's seq.
   */
  _tail(head, { runOnly = false } = {}) {
    const t = { newest: null, run: null, keyed: null, own: false, spanRuns: [], atHead: null };
    let runOpen = true;
    let spanOpen = true;
    let oldest = null;
    for (const f of this._back()) {
      oldest = f;
      const kind = f.k || 'plain';
      if (!t.newest) { t.newest = f; t.run = { kind, first: f.seq }; spanOpen = f.k !== this.kid; }
      else if (runOpen) { if (kind === t.run.kind) t.run.first = f.seq; else runOpen = false; }
      if (!t.keyed && f.k) t.keyed = f;
      if (f.k === this.kid) { t.own = true; spanOpen = false; }
      if (spanOpen) {
        const r = t.spanRuns[0];
        if (r && r.kind === kind) r.from = f.seq; else t.spanRuns.unshift({ kind, from: f.seq, to: f.seq });
      }
      if (head && f.seq === head.seq) {
        t.atHead = f;
        // This key's run reaches the head's entry: where it began is the head's to say.
        if (runOpen && t.run.kind === this.kid && f.k === this.kid && f.h === head.h && Number.isSafeInteger(head.run)) { t.run.first = head.run; runOpen = false; }
      }
      if (!runOpen && (runOnly || (t.keyed && !spanOpen && (!head || f.seq <= head.seq)))) break;
    }
    if (runOpen && t.run) {
      // The run reaches the oldest entry this file set holds. After a split that is an archive point, which names where the
      // run began (H.10.1); an older file that could not be read leaves it unknown ('?').
      const first = oldest && oldest.seq > 1 ? rules.wholeEntry(oldest.text) : null;
      const named = first ? rules.beginsAt(first) : null;
      if (this.backCut) t.run.first = '?';
      else if (named && named.kind === t.run.kind) t.run.first = named.first;
    }
    return t;
  }

  /** A record outside the data folder: {state: 'absent' | 'unread' | 'changed' | 'otherkey' | 'ok', rec, code, aside}. */
  _readRecord(name, fields) {
    const r = readOr(path.join(this.records, name));
    if (!r.buf) return r.code === 'ENOENT' ? { state: 'absent' } : { state: 'unread', code: r.code };
    let rec = null;
    try { rec = JSON.parse(r.buf.toString('utf8')); } catch { /* not JSON: kept aside below */ }
    const ok = rec && typeof rec === 'object' && !Array.isArray(rec);
    if (ok && fields === FIELDS.head && typeof rec.kid === 'string' && HEX16.test(rec.kid) && rec.kid !== this.kid) return { state: 'otherkey', rec };
    if (ok && sameMac(rec.mac, hmac(this.Kh, JSON.stringify(Object.fromEntries(fields.map((f) => [f, rec[f]])))))) return { state: 'ok', rec };
    return { state: 'changed', aside: this._keepAside(name, r.buf) };
  }

  /** A record that did not check, copied aside (never renamed: nothing is lost if the copy fails). Returns its name. */
  _keepAside(name, buf) {
    const aside = name.replace(/\.json$/, '') + '.changed-' + stamp() + '.json';
    try { writeFileAtomic(path.join(this.records, aside), buf, { mode: 0o600 }); } catch (e) { console.error('  [audit] could not keep ' + name + ' aside: ' + e.message); }
    return aside;
  }

  /** Whether the log at `file` still holds log `l`: 'there', 'gone', 'other', or a read error's code. */
  _logAt(file, l) {
    for (const f of [file, ...this.rotated(file).reverse()]) {
      const r = readOr(f);
      if (!r.buf) { if (r.code === 'ENOENT') continue; return r.code; }
      for (const [text] of linesBack(r.buf)) {
        const facts = factsOf(text);
        if (facts && facts.k) return facts.l === l ? 'there' : 'other';
      }
    }
    return 'gone';
  }

  /** The newest keyed entry's facts: what names this log (its `l`). */
  _newestKeyed() {
    for (const f of this._back()) if (f.k) return f;
    return null;
  }

  /**
   * The newest export sent whole that the newest file holds (H.6 step 2): a whole `audit.export.sent` under this key whose
   * MAC checks, read backward by line. Anything else that says so is not one.
   */
  _lastExportIn(buf) {
    if (!buf || this.keyless) return null;
    for (const [text] of linesBack(buf)) {
      if (text.indexOf('"action":"audit.export.sent"') < 0) continue;
      const e = rules.wholeEntry(text);
      if (e && e.action === 'audit.export.sent' && e.k === this.kid && sameMac(e.h, macOf(e, this.Ke))) return exportOf(e);
    }
    return null;
  }

  /** Take the log for writing (the first write does this): the keys, the tail, the records, and what they disagree on. */
  open() {
    if (this.opened) return;
    this.opened = true;
    // Its folder is made here, at the first write, never when the log is read: a server reads it before it holds its data
    // folder. One that cannot be made is said by the first append that fails.
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch { /* the append that follows says why */ }
    try {
      const k = this.keysOf();
      this.Ke = k.entry; this.Kh = k.head;
    } catch (err) {
      this.keyless = { code: err.code || 'EIO', words: err.message };
      this.Ke = crypto.randomBytes(32); this.Kh = null;
    }
    this.kid = kidOf(this.Ke);
    const keyed = this._newestKeyed();
    this.l = keyed ? keyed.l : crypto.randomBytes(16).toString('hex');
    // A new log id names nothing until an entry carrying it is on disk: a start that writes none leaves the records of
    // the log before it as they were, so the next start finds the same log and the same evidence.
    this.lOnDisk = !!keyed;
    this.lFrom = this.seq + 1;
    this.base = this.onDisk.seq;
    this.openDue = true;
    this.headLane.file = path.join(this.records, 'head-' + this.l + '.json');
    const repair = this._cutTorn();
    const keyless = this._readKeyless();
    if (this.keyless) this._openKeyless(keyless);
    else this._openKeyed(keyless);
    this.lastExport = this._lastExportIn(this.buf) || this.lastExport;
    this.buf = null;
    if (repair) this.write(SYSTEM, 'audit.repair', '', repair);
    if (this.moved) this.write(SYSTEM, 'audit.moved', '', 'this log was last written at ' + path.dirname(this.moved));
    this._markRows();
    this._saveRecords();
    this.headLane.flushSync();
  }

  /**
   * Ask the lane for the records (latest wins). Never in a keyless run (no key to MAC them); never before an entry
   * carrying this log's id is on disk; and while the head could not be read, only the records open() writes, after which
   * the lane stays off for the run.
   */
  _saveRecords() {
    if (this.keyless || !this.lOnDisk || (this.headOff && !this.openDue)) return;
    this.headLane.save(() => this._recordFiles());
  }

  /** A half-written last line: its bytes kept aside, then cut. The words for `audit.repair`, or ''. */
  _cutTorn() {
    if (!this.torn) return '';
    const cut = this.torn;
    this.torn = 0;
    let aside = this.stem + '-torn-' + stamp() + '.bin';
    try { writeFileAtomic(path.join(path.dirname(this.file), aside), this.tornBytes, { mode: 0o600 }); } catch (err) {
      aside = '';
      console.error('  [audit] could not keep a half-written last line aside: ' + err.message);
    }
    this.tornBytes = null;
    try { fs.truncateSync(this.file, this.size); } catch (err) {
      this.pending = '\n';   // the fragment cannot be cut: end it, so the next entry is a line of its own
      console.error('  [audit] could not cut a half-written last line: ' + err.message);
    }
    return 'a half-written last line (' + cut + ' bytes) was cut after an unclean stop' + (aside ? ', kept aside as ' + aside : '')
      + (cut > TORN_ENTRY ? '; more than a half-written line: whole entries may have been in it' : '');
  }

  /** This log's runs written without the machine key, from its marker (no MAC: there was no key to make one). */
  _readKeyless() {
    const r = readOr(path.join(this.records, 'keyless-' + this.l + '.json'));
    // Only ENOENT means no marker: a marker that cannot be read is said, and never written over this run.
    this.keylessCode = r.buf || r.code === 'ENOENT' ? '' : r.code;
    let m = null;
    try { m = r.buf ? JSON.parse(r.buf.toString('utf8')) : null; } catch { /* not a marker: no runs */ }
    const runs = m && Array.isArray(m.runs) ? m.runs : [];
    this.keylessRuns = runs.filter((x) => x && typeof x.kid === 'string' && HEX16.test(x.kid) && typeof x.code === 'string' && Number.isSafeInteger(x.at)).map((x) => ({ kid: x.kid, from: x.from, at: x.at, code: x.code.slice(0, 20) }));
    return this.keylessRuns;
  }

  /** No machine key: this run is keyed with a random key of its own, opened by `audit.keyless`, and marked for the next. */
  _openKeyless(runs) {
    const t = this._tail(null, { runOnly: true });
    const before = t.newest ? rules.refOf(t.run) : '';
    const e = this.write(SYSTEM, 'audit.keyless', before, 'this run has no machine key (' + this.keyless.code + '): its entries are linked, and cannot be checked after a restart');
    this.runFirst = e.seq;
    if (this.keylessCode) { console.error('  [audit] the marker of this machine\'s runs without its key could not be read (' + this.keylessCode + '): this run is not added to it'); return; }
    const marker = { v: 1, log: this.l, runs: [...runs, { kid: this.kid, from: e.seq, at: e.at, code: this.keyless.code }].slice(-16) };
    try { writeFileAtomic(path.join(this.records, 'keyless-' + this.l + '.json'), JSON.stringify(marker), { mode: 0o600 }); } catch (err) {
      console.error('  [audit] could not mark this keyless run in ' + this.records + ': ' + err.message);
    }
  }

  /** This machine's key: the records against the tail, then the boundary the tail needs, then each disagreement. */
  _openKeyed(keyless) {
    const found = [];
    const add = (kind, words) => found.push({ kind, words });
    const head = this._readRecord('head-' + this.l + '.json', FIELDS.head);
    const valid = head.state === 'ok' && Number.isSafeInteger(head.rec.seq) && HEX64.test(String(head.rec.h)) ? head.rec : null;
    const t = this._tail(valid);
    if (head.state === 'unread') {
      this.headOff = head.code;
      add('unread', 'the head record could not be read (' + head.code + '): this start could not compare the log with it, and entries from here on are not vouched for until a start that can');
    } else if (head.state === 'changed') add('changed', 'the head record outside the data folder was changed: kept aside as ' + head.aside);
    else if (head.state === 'otherkey') add('otherkey', 'this log\'s head is under a key this machine no longer holds (' + short(head.rec.kid) + ', entry ' + head.rec.seq + '): the key was replaced');
    else if (head.state === 'absent' && t.own) add('nohead', 'this machine keyed this log and has no record of it: the head record outside the data folder is missing');
    const newest = t.newest ? t.newest.seq : 0;
    let relabelled = null;
    if (valid) {
      // Every check of this run holds the entry at this seq to this key and this hash (H.7).
      this.anchor = { seq: valid.seq, h: valid.h };
      if (newest < valid.seq) add('cut', missing(newest + 1, valid.seq) + ': this machine recorded entry ' + valid.seq + '; the log ended at entry ' + newest);
      else if (t.atHead && t.atHead.h !== valid.h) add('fork', 'the log forked: this machine\'s entry ' + valid.seq + ' is not the log\'s entry ' + valid.seq);
      else if (t.atHead && t.atHead.k !== this.kid) relabelled = t.atHead;
      if (typeof valid.path === 'string' && !samePath(valid.path, this.path)) this.moved = valid.path;
    }
    // The folder record: a log last written at this path that is not here.
    this.folderId = placeId(path.dirname(this.file), path.basename(this.file));
    const folder = this._readRecord('folder-' + this.folderId + '.json', FIELDS.folder);
    let goneHere = '';
    if (folder.state === 'unread') { this.folderOff = true; add('unread', 'the folder record could not be read (' + folder.code + '): this start could not tell whether another log was here'); }
    else if (folder.state === 'changed') add('record', 'the folder record outside the data folder did not check: changed, or written under a key this machine no longer holds; kept aside as ' + folder.aside);
    else if (folder.state === 'ok' && folder.rec.log !== this.l) {
      const other = this._readRecord('head-' + folder.rec.log + '.json', FIELDS.head);
      if (other.state === 'ok' && samePath(other.rec.path, this.path)) {
        goneHere = folder.rec.log;
        add('another', 'this folder held another log (' + other.rec.seq + ' entries, the newest at ' + when(other.rec.at) + '); it is not here');
      }
    }
    // The log this machine wrote last: still where it was written, or not.
    const latest = this._readRecord('latest.json', FIELDS.latest);
    if (latest.state === 'unread') { this.latestOff = true; add('unread', 'the record of the log this machine wrote last could not be read (' + latest.code + ')'); }
    else if (latest.state === 'changed') add('record', 'the record of the log this machine wrote last did not check: changed, or written under a key this machine no longer holds; kept aside as ' + latest.aside);
    else if (latest.state === 'ok' && latest.rec.log !== this.l && latest.rec.log !== goneHere) {
      const there = this._logAt(latest.rec.path, latest.rec.log);
      if (there === 'gone' || there === 'other') add('last', 'the log this machine wrote last (' + latest.rec.seq + ' entries, at ' + path.dirname(latest.rec.path) + ', ' + when(latest.rec.at) + ') is not there; this is another log');
      else if (there !== 'there') add('unread', 'the log this machine wrote last could not be read at ' + path.dirname(latest.rec.path) + ' (' + there + ')');
    }
    const keyed = this._readRecord('keyed.json', FIELDS.keyed);
    this.keyedState = keyed.state;
    if (keyed.state === 'unread') { this.keyedOff = true; add('unread', 'the record that this machine has keyed a log before could not be read (' + keyed.code + '): the words about older entries cannot say whether this is its first'); }
    if (this.keylessCode) add('unread', 'the record of the runs this machine made without its key could not be read (' + this.keylessCode + '): a run written here without the key reads as another key\'s');
    if (relabelled) {
      // The entry this machine recorded last, under another key id: a changed entry, never a span. No boundary vouches for
      // the run it stands in, so this machine's next entry breaks the chain for every later check too.
      this.runFirst = this.seq + 1;
      this.found.push({ kind: 'broken', mark: 'broken', words: relabelWords(relabelled) });
    } else this._boundary(t, keyless);   // the boundary the tail needs comes first, directly after the run it names
    for (const f of found) this._finding(f.kind, f.words);
    // Findings an earlier start held that never reached the disk are found again.
    if (valid && Array.isArray(valid.held)) {
      for (const h of valid.held) {
        if (h && h.kind === 'more' && Number.isSafeInteger(h.n)) this._finding('lost', (h.n === 1 ? '1 more finding' : h.n + ' more findings') + ' of an earlier start never reached the disk');
        else if (h && Object.prototype.hasOwnProperty.call(FINDING, h.kind) && /^e[0-9]+$/.test(String(h.id)) && Number(h.id.slice(1)) > newest) this._finding(h.kind, str(h.words, 260) + ' (found at an earlier start; its entry never reached the disk)');
      }
    }
  }

  /** The boundary the tail's kind asks for (H.4), from this machine's own records, and the span it ends. */
  _boundary(t, keyless) {
    if (!t.newest) { this.runFirst = this.seq + 1; return; }
    if (t.newest.k === this.kid) { this.runFirst = t.run.first === '?' ? null : t.run.first; return; }
    const runs = t.spanRuns.length ? t.spanRuns : [{ kind: t.run.kind, from: t.run.first, to: t.newest.seq }];
    const first = this.keyedState === 'absent';
    let action;
    let target = rules.refOf(t.run);
    let words = spanWords(runs, { first, keyless });
    if (t.newest.k) action = 'audit.rekey';
    else if (t.keyed || t.run.first !== 1) action = 'audit.unkeyed';   // plain after keyed ones, or a plain log whose first files are gone
    else {
      action = 'audit.keyed';
      if (first) target += ';first';
      words = 'the log is keyed from here on (key ' + short(this.kid) + ')' + (first ? ', from this first start of AGMessage ' + this.version + ' on this laptop' : '') + '; ' + words;
    }
    const e = this.write(SYSTEM, action, target, words);
    this.runFirst = e.seq;
    const span = { id: 's' + runs[0].from + '-' + (e.seq - 1), from: runs[0].from, to: e.seq - 1 };
    this.spans.push(span);
    const kind = spanKind(runs, keyless);
    this.found.push({ id: span.id, kind, mark: 'unvouched', from: span.from, to: span.to, words: spanWords(runs, { first, keyless }), ...(kind === 'plain' ? { first } : {}) });
  }

  /** One disagreement, written as its own entry (`audit.cut` or `audit.head`) and held in the head until it is on disk. */
  _finding(kind, words) {
    const e = this.write(SYSTEM, CUTS.has(kind) ? 'audit.cut' : 'audit.head', kind, words);
    this.findings.push({ seq: e.seq, kind, words: e.words });
    this.found.push({ id: 'e' + e.seq, kind, mark: FINDING[kind], words: e.words, ...(FINDING[kind] === 'broken' ? { confirm: true } : {}) });
    // Not on disk yet: the head carries it, so a stop or a crash before the disk takes it does not lose it.
    if (e.seq > this.onDisk.seq) this._saveRecords();
    return e;
  }

  /** The marks of the rows read from disk: whole, then MAC-checked under this key; a span's by its state now. */
  _markRows() {
    for (const r of this.recent) {
      if (r.bad || r.mark) continue;
      if (r.e.k === this.kid) r.mark = sameMac(r.e.h, macOf(r.e, this.Ke)) ? 'intact' : 'broken';
      else if (!r.e.k && hashOf(r.e) !== r.e.h) r.mark = 'broken';
      else r.mark = 'span';
    }
  }

  /** The findings this run's head carries while their entries are not on disk, oldest first; past 16, one `more`. */
  _held() {
    const waiting = this.findings.filter((f) => f.seq > this.onDisk.seq);
    const out = waiting.slice(0, HELD_MAX).map((f) => ({ id: 'e' + f.seq, kind: f.kind, mark: FINDING[f.kind], words: f.words }));
    if (waiting.length > HELD_MAX) out.push({ kind: 'more', n: waiting.length - HELD_MAX });
    return out;
  }

  /**
   * The records the lane writes: the head (unless it could not be read) and the log written last, and until they have
   * landed once, the folder record and keyed.json (each unless it could not be read).
   */
  _recordFiles() {
    const at = Date.now();
    const files = [];
    const rec = (name) => path.join(this.records, name);
    const open = this.openDue;
    this.producing = { at: { seq: this.onDisk.seq, h: this.onDisk.h }, head: !this.headOff, open };
    if (!this.headOff) files.push([rec('head-' + this.l + '.json'), sealRecord({ v: 1, log: this.l, path: this.path, kid: this.kid, seq: this.onDisk.seq, h: this.onDisk.h, run: this.runFirst, held: this._held(), at }, this.Kh)]);
    if (!this.latestOff) files.push([rec('latest.json'), sealRecord({ v: 1, log: this.l, path: this.path, seq: this.onDisk.seq, at }, this.Kh)]);
    if (open && !this.folderOff) files.push([rec('folder-' + this.folderId + '.json'), sealRecord({ v: 1, folder: this.folderId, path: this.path, log: this.l, at }, this.Kh)]);
    if (open && !this.keyedOff && this.keyedState !== 'ok') files.push([rec('keyed.json'), sealRecord({ v: 1, since: at, log: this.l }, this.Kh)]);
    return files;
  }

  /**
   * An entry reached the disk: accepts waiting for it take effect, an export sent whole becomes "Last export", and the
   * head is asked for (latest wins, 200 ms). The first entry on disk that carries a new log's id has its records written
   * at once.
   */
  _durable() {
    for (const a of this.waitingAccepts.splice(0)) {
      if (a.seq <= this.onDisk.seq) for (const id of a.ids) this.accepted.set(id, a.at);
      else this.waitingAccepts.push(a);
    }
    if (this.exportWaiting && this.exportWaiting.seq <= this.onDisk.seq) {
      this.lastExport = exportOf(this.exportWaiting);
      this.exportWaiting = null;
    }
    if (!this.opened) return;
    const first = !this.lOnDisk && this.onDisk.seq >= this.lFrom;
    if (first) this.lOnDisk = true;
    this._saveRecords();
    if (first) this.headLane.flushSync();
  }

  /** Entries on disk that the saved head does not cover yet. */
  _lag(seq, saved) { return Math.max(0, seq - (saved ? saved.seq : this.base)); }

  /**
   * Record one action. `actor` {t:'account'|'admin'|'code'|'display'|'node'|'system'|'windows', id, name}; `target` what
   * it acted on (an id, a username, a hall code; a Windows account's SID); `words` what happened, in plain words, never a
   * secret. A `windows` row keeps its SIDs whole (SID_MAX), so no two accounts of one PC ever read as one.
   */
  write(actor, action, target = '', words = '', ip = '') {
    this.open();
    const t = str(actor && actor.t, 12) || 'system';
    const sids = t === 'windows';
    const e = {
      seq: this.seq + 1, at: Date.now(),
      actor: { t, id: str(actor && actor.id, sids ? SID_MAX : 40), name: str(actor && actor.name, 60) },
      action: str(action, 40), target: str(target, sids ? SID_MAX : 80), words: str(words, WORDS_MAX), ip: str(ip, 64), prev: this.last, l: this.l, k: this.kid,
    };
    e.h = macOf(e, this.Ke);
    this.seq = e.seq; this.last = e.h;
    this.pending += JSON.stringify(e) + '\n';
    this.unwritten++;
    this.recent.push({ e, mark: 'intact' });
    if (this.recent.length > RECENT) this.recent.shift();
    if (e.action === 'audit.export.sent') this.exportWaiting = e;
    this._put();
    return e;
  }

  /** Put every pending line on disk in one append, or none of them; what an fsync returned for is on disk. */
  _put() {
    if (this.size > ROTATE_BYTES) this._rotate();
    const upTo = { seq: this.seq, h: this.last };
    const t0 = performance.now();
    let fd = null;
    let took = false;
    try {
      // Written at the file's end through a handle that can also cut it back: Windows does not truncate through a
      // handle opened for appending, so there a short write would stay as a fragment the next entry is glued to.
      fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
      const before = fs.fstatSync(fd).size;
      const bytes = Buffer.from(this.pending);
      const n = fs.writeSync(fd, bytes, 0, bytes.length, before);
      if (n !== bytes.length) { fs.ftruncateSync(fd, before); throw new Error('the disk took ' + n + ' of ' + bytes.length + ' bytes'); }
      this.size = before + n;
      this.pending = ''; this.unwritten = 0;
      fs.fsyncSync(fd);
      this.onDisk = upTo;
      this.lastError = null;
      this.lastCode = '';
      took = true;
    } catch (err) {
      this.lastError = err.message;
      this.lastCode = err.code || 'EIO';
      console.error('  [audit] could not write' + (this.unwritten ? ' (' + this.unwritten + ' kept, written ahead of the next entry)' : '') + ': ' + err.message);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* the write itself said what went wrong */ } }
    }
    if (took) this._durable();
    if (took && this.onPut) {
      // The entry is on disk whatever its timing's reader does: a throw there never reaches the action being audited.
      try { this.onPut(performance.now() - t0); } catch (err) { console.error('  [audit] an append\'s time could not be noted: ' + err.message); }
    }
  }

  /**
   * Put the entries still waiting on disk now (a stop, a crash), then the head that covers them, so neither is lost with
   * the process. True when no entry is left waiting.
   */
  flush() {
    if (this.pending || this.onDisk.seq !== this.seq) this._put();
    this.headLane.flushSync();
    return !this.pending;
  }

  /**
   * Rename the full file aside; the chain goes on in a new one. A rename that fails leaves it growing, and is tried again.
   * The name's time is the later of now and 1 ms after the newest rotated file's, so a forced rotation (an archive point)
   * that follows a size rotation within one millisecond never renames onto it: a rename replaces what it lands on.
   * True when the file was set aside.
   */
  _rotate() {
    if (this.rotatedAt === null) this.rotatedAt = timeOfRotated(this.rotated().pop() || '');
    const t = Math.max(Date.now(), this.rotatedAt + 1);
    try {
      fs.renameSync(this.file, path.join(path.dirname(this.file), rotatedName(this.stem, t)));
      this.rotatedAt = t;
      this.size = 0;
      this.rotations++;
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') this.size = 0;
      else console.error('  [audit] could not rotate (written on in ' + path.basename(this.file) + '): ' + err.message);
      return false;
    }
  }

  /** The run the newest entry stands in, as a boundary names it: `<kid>:<first entry>`, or `<kid>:?` when not known. */
  runRef() { return this.kid + ':' + (Number.isSafeInteger(this.runFirst) ? this.runFirst : '?'); }

  /**
   * An archive point (H.10.1): an event's data was archived, and the log carries on. What waits is put on disk first, then
   * the current file is set aside when it holds anything, so the point is the first line of a file of its own and a split
   * there moves whole files. While entries still wait (the disk refused them) it is written where it falls, and no split
   * is made at it. `name` is the event archive's folder; the target adds the run (`<name>;<kid>:<first entry>`).
   */
  point(actor, name, words = '', ip = '') {
    this.open();
    if (this.pending || this.onDisk.seq !== this.seq) this._put();
    if (!this.pending && this.size > 0) this._rotate();
    const run = this.runRef();
    return this.write(actor, 'audit.archive', str(name, 79 - run.length) + ';' + run, words, ip);
  }

  /** Whether an entry under this machine's key carries its MAC (compared in constant time); false under any other key. */
  macHolds(e) { return !this.keyless && e.k === this.kid && sameMac(e.h, macOf(e, this.Ke)); }

  /** An archive's name for a range of this log: audit-<its id's first 8 hex>-<from>-<to>. */
  archiveName(from, to) { return 'audit-' + this.l.slice(0, 8) + '-' + from + '-' + to; }

  /** A span row's mark now: ◇ once its span is accepted, △ until then. */
  _spanMark(seq) {
    const s = this.spans.find((x) => seq >= x.from && seq <= x.to);
    return s && this.accepted.has(s.id) ? 'linked' : 'unvouched';
  }

  /** The newest `limit` rows, newest first, each with its mark at the end; a line that is not whole is said as one. */
  latest(limit = 200) {
    this.open();
    return this.recent.slice(-Math.max(1, Math.min(RECENT, limit))).reverse().map((r) => (r.bad
      ? { line: r.bad.line, file: r.bad.file, mark: 'broken', words: 'line ' + r.bad.line + ' of ' + r.bad.file + ' is not a whole entry' }
      : { ...r.e, mark: r.mark === 'span' ? this._spanMark(r.e.seq) : r.mark }));
  }

  /** What this run cannot vouch for, apart from the findings: no machine key, a head that cannot be read or saved. */
  conditions() {
    const out = [];
    if (this.keyless) out.push({ kind: 'keyless', mark: 'unvouched', words: 'this run has no machine key (' + this.keyless.code + '): its entries are linked, and cannot be checked after a restart — ' + this.keyless.words });
    if (this.headOff) out.push({ kind: 'head', mark: 'unvouched', words: 'entries from here on are not vouched for: the head record could not be read (' + this.headOff + ')' });
    else if (this.headLane.lastError) out.push({ kind: 'head', mark: 'unvouched', words: 'entries after ' + (this.saved ? this.saved.seq : 0) + ' are not vouched for: the head record could not be saved (' + this.headLane.lastError + ')' });
    if (this.unfinished) out.push({ kind: 'split', mark: 'unvouched', words: unfinishedWords(this.unfinished, this.splitCode) });
    for (const x of this.leftAside) out.push({ kind: 'split', mark: 'unvouched', words: 'a split\'s folder (' + x.name + ') is left as it is: ' + x.why });
    return out;
  }

  /**
   * Everything health and the console say needs a person: the open findings (the newest check's, or open()'s until a
   * check has run; a check broken at a line first, with no id, since it is never accepted), then the conditions.
   */
  attention() {
    const open = (this.lastCheck || this.found).filter((f) => !this.accepted.has(f.id));
    return [...open.map((f) => ({ ...f })), ...this.conditions()];
  }

  /** Health's facts about the log, by name. */
  facts() {
    // No head is kept in a keyless run or while it cannot be read: its condition says why, and no lag is counted.
    return {
      kid: this.kid, headLag: this.keyless || this.headOff ? 0 : this._lag(this.onDisk.seq, this.saved),
      attention: this.attention().map((f) => ({ ...(f.id ? { id: f.id } : {}), kind: f.kind, mark: f.mark, words: f.words, ...(f.first ? { first: true } : {}) })),
      keyless: !!this.keyless,
      from: this.from,
      archives: this.archives.length,
      lastExport: this.lastExport ? { ...this.lastExport } : null,
    };
  }

  /** The files of the chain as they stand now: the rotated ones, oldest first, then the current one. */
  files() { return [...this.rotated(), this.file]; }

  /**
   * Check the whole chain, rotated files included (H.7). It reads the files off the event loop and checks them in
   * slices, so the show goes on while it runs; calls while one runs share it. The answer:
   * {ok, mark, words, entries, findings, digest, head: {seq, lag, error?}, unwritten?, file?, brokenAt?, why?, error?};
   * `ok` is true only for ✓, and anything else carries `error`, so a page that reads only `ok` never shows ✓ for it.
   */
  verify() {
    this.open();
    // A split moves the files a check reads: one asked while a split is made waits for it, then reads what it left.
    // (A split's promise only resolves: its slot is released whatever the split did.)
    if (!this.checking) this.checking = (this.splitting ? this.splitting.then(() => this._verify()) : this._verify()).finally(() => { this.checking = null; });
    return this.checking;
  }

  /**
   * The check an export runs on its own bytes (H.9.4): `source` yields {name, buf} for each file of the chain, oldest
   * first, the last one cut just after `stop`, the export's own entry, which is where the chain must end. A check
   * already running began before that entry, so it is waited for, not shared. It never re-runs, and what it finds
   * changes nothing this run reads (health, the rows' marks): it is the export's.
   */
  async checkThrough(source, stop, { archives = null, walk = null } = {}) {
    this.open();
    if (this.checking) await this.checking.catch(() => null);
    return this._verify({ source, expect: { seq: stop.seq, h: stop.h }, publish: false, archives, walk });
  }

  /**
   * The check a split runs on its own handles (lib/auditarchive.js): as an export's, but it neither waits for a check that
   * waits for it, nor reads past `stop`. What it found is the split's (`walk`), not this run's.
   */
  checkForSplit(source, stop, walk) {
    return this._verify({ source, expect: { seq: stop.seq, h: stop.h }, publish: false, walk });
  }

  /** The chain's files, read off the event loop one at a time: {name, buf}, or {name, code} for one that cannot be read. */
  async * _read(files) {
    for (const f of files) {
      try { yield { name: path.basename(f), buf: await fs.promises.readFile(f) }; } catch (err) {
        if (f !== this.file || err.code !== 'ENOENT') yield { name: path.basename(f), code: err.code || 'EIO' };
        else yield { name: path.basename(f), buf: Buffer.alloc(0) };
      }
    }
  }

  async _verify({ source = null, expect: until = null, publish = true, archives = null, walk = null } = {}) {
    const rotations = this.rotations;
    const expect = until || { ...this.onDisk };
    const saved = this.saved ? { ...this.saved } : null;
    const held = this._held();
    // A split stopped part way is a condition this walk finds again, never one carried from the walk before.
    const conditions = this.conditions().filter((c) => c.kind !== 'split');
    const own = this.kid;
    const anchor = this.anchor;
    // A split stopped part way left its moved files aside: they come first, then the live files, as one chain (H.10.2).
    const partials = source ? [] : await this._partials();
    const files = source || this._read([...partials.flatMap((p) => p.logs), ...this.files()]);
    let prev = { seq: 0, h: GENESIS };
    let entries = 0;
    let lineCount = 0;
    let checked = 0;
    const runs = new rules.Runs();
    const spans = [];
    let span = null;   // the stretch not under this key being walked: {from, runs: [{kind, from, to}]}
    const found = [];  // findings from this key's own cut and head entries
    const accepted = new Map();
    const acceptsAt = new Map();   // finding id -> {seq, at} of the accept on disk that names it
    const points = [];   // this key's archive points: {seq, at, name, run, first (the first line of its file), file, words}
    const splits = [];   // keyed splits: {seq, at, k, point, digest, words, actor}
    let from = 0;
    let fromKey = '';
    let firstFile = '';
    let firstPrev = GENESIS;
    let atHead = null;
    const answer = async (fields, look = null) => {
      // Broken at a line after a split, the archives it names are still looked at: an export of it carries them.
      if (!fields.done && !look && from > 1) look = await this._look({ splits, from, fromKey, reader: archives || this._reader(), partials });
      if (walk) Object.assign(walk, { points, splits, accepts: acceptsAt, from: from || 1, firstPrev, last: prev.seq, look, broken: !fields.done });
      return this._answer({ fields, entries, spans, found, accepted, held, conditions, expect, saved, publish, from: from || 1, last: prev.seq, look, points, splits, walk });
    };
    let last = path.basename(this.file);
    for await (const f of files) {
      if (f.code) return answer({ file: f.name, brokenAt: 0, why: 'the file could not be read: ' + f.code });
      const buf = f.buf;
      last = f.name;
      lineCount = 0;
      const at = (n, why) => answer({ file: f.name, brokenAt: n, why });
      for (const [text, n] of wholeLines(buf)) {
        lineCount = n;
        if (++checked % SLICE === 0) await turn();
        const e = rules.wholeEntry(text);
        if (!e) return at(n, 'line ' + n + ' is not a whole entry');
        if (!entries && e.seq !== 1) {
          // A chain that begins after entry 1 begins at an archive point naming a run of its own key (H.4, H.10.4).
          const run = rules.beginsAt(e);
          if (!run) return at(n, missing(1, e.seq - 1) + ' before entry ' + e.seq);
          prev = { seq: e.seq - 1, h: e.prev };
          runs.run = { kind: run.kind, first: run.first };
        }
        if (!entries) { from = e.seq; fromKey = e.k; firstFile = f.name; firstPrev = e.prev; }
        if (e.seq !== prev.seq + 1) return at(n, e.seq > prev.seq + 1 ? missing(prev.seq + 1, e.seq - 1) + ' before entry ' + e.seq : 'entry ' + e.seq + ' is out of order');
        if (e.prev !== prev.h) return at(n, 'entry ' + e.seq + ' does not follow the one before it');
        if (e.k === own ? !sameMac(e.h, macOf(e, this.Ke)) : !e.k && hashOf(e) !== e.h) return at(n, 'entry ' + e.seq + ' was changed after it was written');
        // The entry the head read at open names, with the hash this machine recorded for it, under another key id.
        if (anchor && e.seq === anchor.seq && e.h === anchor.h && e.k !== own) return at(n, relabelWords(e));
        const why = runs.next(e);
        if (why) return at(n, why);
        if (e.k === own) {
          if (span) {
            span.to = e.seq - 1;
            span.first = e.action === 'audit.keyed' && /;first$/.test(e.target);
            spans.push(span);
            span = null;
          }
          if ((e.action === 'audit.cut' || e.action === 'audit.head') && Object.prototype.hasOwnProperty.call(FINDING, e.target)) found.push({ id: 'e' + e.seq, kind: e.target, words: e.words });
          if (e.action === 'audit.accept') for (const id of e.target.split(',')) if (id) { accepted.set(id, e.at); acceptsAt.set(id, { seq: e.seq, at: e.at }); }
          if (e.action === 'audit.archive') {
            const p = rules.pointRun(e.target);
            points.push({ seq: e.seq, at: e.at, h: e.h, name: p ? p.name : '', run: p ? p.run : null, first: n === 1, file: f.name, words: e.words });
          }
        } else {
          const kind = e.k || 'plain';
          if (!span) span = { from: e.seq, runs: [] };
          const r = span.runs[span.runs.length - 1];
          if (r && r.kind === kind) r.to = e.seq; else span.runs.push({ kind, from: e.seq, to: e.seq });
        }
        // A split is structure under any key, as a boundary is: keyed, it pins the archive it made (H.10.4).
        const sp = e.k && e.action === 'audit.split' ? rules.splitOf(e.target) : null;
        if (sp) splits.push({ seq: e.seq, at: e.at, k: e.k, point: sp.point, digest: sp.digest, words: e.words, actor: e.actor });
        if (saved && e.seq === saved.seq) atHead = e;
        prev = e;
        entries++;
      }
    }
    // A rotation moved the files under a routine check: read them again. An export's check reads its own handles.
    if (!source && this.rotations !== rotations) return this._verify({ publish, archives, walk });
    const tail = { file: last, brokenAt: lineCount + 1 };
    if (span) return answer({ ...tail, why: range(span.from, prev.seq, 'follows', 'follow') + ' entry ' + (span.from - 1) + ' with no boundary under this key after it: added behind the running server\'s back' });
    if (prev.seq < expect.seq) return answer({ ...tail, why: (prev.seq ? 'after entry ' + prev.seq + ', ' : '') + missing(prev.seq + 1, expect.seq) + ' (the newest written)' });
    if (prev.seq === expect.seq && prev.h !== expect.h) return answer({ ...tail, why: 'the newest entry is not the one this server wrote last' });
    if (saved && saved.seq > 0 && saved.seq <= prev.seq && !(atHead && atHead.k === own && atHead.h === saved.h)) return answer({ ...tail, why: 'entry ' + saved.seq + ', the newest this machine recorded, is not under its key with the hash it recorded' });
    // After a split the walk begins at its archive point, which a keyed split under the point's own key must name: files
    // removed by hand, or a split forged in plain, leave the first entries missing (H.10.4).
    if (from > 1 && !splits.some((x) => x.point === from && x.k === fromKey)) return answer({ file: firstFile, brokenAt: 1, why: missing(1, from - 1) + ': no split names entry ' + from });
    const look = await this._look({ splits, from: from || 1, fromKey, reader: archives || this._reader(), partials });
    return answer({ done: true }, look);
  }

  /** The folders a split left part way, this log's (H.10.2): {name, dir, logs: [the log files moved into it, oldest first]}. */
  async _partials() {
    let names;
    try { names = await fs.promises.readdir(this.archiveDir); } catch { return []; }   // no archive folder: no split was ever made aside
    const out = [];
    for (const n of names.sort()) {
      const m = PARTIAL.exec(n);
      if (!m || !m[1].startsWith('audit-' + this.l.slice(0, 8) + '-')) continue;
      const dir = path.join(this.archiveDir, n);
      let logs = [];
      try { logs = (await fs.promises.readdir(path.join(dir, 'log'))).filter((f) => rules.isArchiveLog('log/' + f)).sort().map((f) => path.join(dir, 'log', f)); } catch { /* nothing moved into it yet */ }
      out.push({ name: m[1], dir, logs });
    }
    return out;
  }

  /** How the routine check looks at the archives: two small reads and a size per file (`full` false: no file is hashed). */
  _reader() {
    const dir = this.archiveDir;
    const at = (name, rel) => path.join(dir, name, ...rel.split('/'));
    return {
      full: false,
      async list() {
        try { return { names: (await fs.promises.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name), code: '' }; } catch (e) {
          return { names: [], code: e.code === 'ENOENT' ? '' : e.code || 'EIO' };
        }
      },
      async read(name, rel) { try { return { buf: await fs.promises.readFile(at(name, rel)), code: '' }; } catch (e) { return { buf: null, code: e.code || 'EIO' }; } },
      async size(name, rel) { try { const st = await fs.promises.lstat(at(name, rel)); return st.isFile() ? st.size : null; } catch { return null; } },
    };
  }

  /**
   * The archives the walk names (H.10.4): from the split that names the live log's first entry (or, with the walk from
   * entry 1, the newest split it met), then each archive's `previous`, back to entry 1. Each is looked at, not re-read:
   * its SHA256SUMS against the split's pin, its archive.json, and each listed log file's size; with `reader.full` (an
   * export's), every file's SHA-256 against its SHA256SUMS too. Also: a split stopped part way (a condition), the keyed
   * splits that name no archive on the chain (findings), and this log's archive folders the chain does not reach.
   */
  async _look({ splits, from, fromKey = '', reader, partials }) {
    const out = { archives: [], findings: [], unfinished: null, unreached: [], unread: '' };
    if (!splits.length && !partials.length) {
      if (reader.full) return out;
      // No split names an archive: any folder of this log's there is out of reach (moved back, or another copy's).
      const listed = await reader.list();
      out.unreached = listed.names.filter((n) => { const r = rules.archiveRange(n); return r && r.l8 === this.l.slice(0, 8); }).sort();
      return out;
    }
    const listed = await reader.list();
    if (listed.code) out.unread = listed.code;
    const l8 = this.l.slice(0, 8);
    const mine = listed.names.filter((n) => { const r = rules.archiveRange(n); return r && r.l8 === l8; });
    // A split stopped part way, pinned by its keyed split: its files are walked above, and it is finished at the next
    // start or by "Finish the split" (lib/auditarchive.js).
    let pending = null;
    for (const p of partials) {
      const sums = await reader.read('.' + p.name + '.partial', 'SHA256SUMS');
      const digest = sums && sums.buf ? crypto.createHash('sha256').update(sums.buf).digest('hex') : '';
      const s = digest ? splits.find((x) => x.digest === digest) : null;
      if (!s) continue;
      let listedFiles = [];
      try { listedFiles = JSON.parse((await reader.read('.' + p.name + '.partial', 'archive.json')).buf.toString('utf8')).files.map((f) => f.path); } catch { /* what moved is still walked: only the count is unknown */ }
      const moved = new Set(p.logs.map((f) => 'log/' + path.basename(f)));
      pending = s;
      out.unfinished = { seq: s.point, split: s.seq, name: p.name, left: listedFiles.filter((f) => !moved.has(f)).length };
    }
    const done = splits.filter((x) => x !== pending);
    // The split that names the live log's first entry under that entry's own key (one under another key lies in a span, and
    // pins nothing); with the walk from entry 1 (files moved back), the newest split.
    let start = null;
    for (const x of done) if (from > 1 ? x.point === from && x.k === fromKey : !start || x.point > start.point) start = x;
    let cur = start ? { name: this._nameOf(start, mine), digest: start.digest, split: start.seq, to: start.point - 1, at: start.at } : null;
    const seen = new Set();
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      const one = await this._lookOne(reader, cur, mine.includes(cur.name), listed.code);
      out.archives.push(one.item);
      if (one.finding) out.findings.push(one.finding);
      cur = one.previous;
    }
    out.archives.reverse();   // oldest first
    for (const x of done) {
      if (!out.archives.some((a) => a.split === x.seq)) out.findings.push({ id: 'a' + x.seq, kind: 'archive', words: 'the split at entry ' + x.point + ' (entry ' + x.seq + ') names an archive that is not on the chain of archives back to entry 1' });
    }
    out.unreached = mine.filter((n) => !seen.has(n)).sort();
    return out;
  }

  /** The archive a split made, by its name in the split's own (keyed) words, or the one folder that ends where it should. */
  _nameOf(s, mine) {
    const want = (n) => { const r = rules.archiveRange(n); return r && r.l8 === this.l.slice(0, 8) && r.to === s.point - 1; };
    const said = (String(s.words).match(ARCHIVE_IN_WORDS) || []).find(want);
    if (said) return said;
    const there = mine.filter(want);
    return there.length === 1 ? there[0] : this.archiveName('?', s.point - 1);
  }

  /** One archive looked at, as `_look` says: {item, finding?, previous ({name, digest, split, to, at}, or null)}. */
  async _lookOne(reader, cur, there, unread) {
    const r = rules.archiveRange(cur.name);
    const span = r ? range(r.from, cur.to, '', '').trim() : 'entries up to ' + cur.to;
    const item = { name: cur.name, from: r ? r.from : 0, to: cur.to, split: cur.split, mark: 'broken', words: '', digest: cur.digest };
    const changed = (why) => {
      const words = 'the archive of ' + span + ' is not what was split off: ' + why;
      return { item: { ...item, words, finding: 'a' + cur.split }, finding: { id: 'a' + cur.split, kind: 'archive', words }, previous: null };
    };
    if (unread) return { item: { ...item, mark: 'unvouched', words: 'the archive of ' + span + ' (' + cur.name + ') could not be looked at: the archive folder could not be read (' + unread + ')' }, previous: null };
    if (!there) {
      const words = 'the archive of ' + span + ' (' + cur.name + ') is not where the split put it: moved off this laptop, or removed';
      return { item: { ...item, words, finding: 'a' + cur.split }, finding: { id: 'a' + cur.split, kind: 'archive', words }, previous: null };
    }
    const sums = await reader.read(cur.name, 'SHA256SUMS');
    if (!sums.buf) return changed('SHA256SUMS is missing (' + sums.code + ')');
    if (crypto.createHash('sha256').update(sums.buf).digest('hex') !== cur.digest) return changed('its SHA256SUMS is not the one the split pinned');
    const listedSums = rules.parseSums(sums.buf.toString('utf8'), 'archive');
    if (listedSums.why) return changed(listedSums.why);
    // archive.json is one of the two small reads: held to its line in the pinned SHA256SUMS, so a change to it is seen.
    const json = await reader.read(cur.name, 'archive.json');
    if (!json.buf) return changed('archive.json is missing (' + json.code + ')');
    const jsonLine = listedSums.list.find((x) => x.path === 'archive.json');
    if (!jsonLine || crypto.createHash('sha256').update(json.buf).digest('hex') !== jsonLine.digest) return changed('archive.json is not what its SHA256SUMS says');
    let a;
    try { a = JSON.parse(json.buf.toString('utf8')); } catch { return changed('archive.json is not JSON'); }
    const shape = rules.archiveProblem(a);
    if (shape) return changed(shape);
    if (a.log !== this.l || a.entries.to !== cur.to || (r && a.entries.from !== r.from)) return changed('archive.json names ' + range(a.entries.from, a.entries.to, '', '').trim() + ' of log ' + a.log.slice(0, 8) + '…');
    for (const f of a.files) {
      const size = await reader.size(cur.name, f.path);
      if (size === null) return changed(f.path + ' is missing');
      if (size !== f.bytes) return changed(f.path + ' is ' + count(Math.abs(f.bytes - size)) + ' bytes ' + (size < f.bytes ? 'shorter' : 'longer'));
    }
    if (reader.full) {
      for (const x of listedSums.list) {
        const got = await reader.read(cur.name, x.path);
        if (!got.buf) return changed(x.path + ' is missing');
        if (crypto.createHash('sha256').update(got.buf).digest('hex') !== x.digest) return changed(x.path + ' is not what its SHA256SUMS says');
      }
    }
    const held = a.check.findings.map((f) => { const m = /^s([0-9]+)-([0-9]+)$/.exec(f.id); return (m ? range(Number(m[1]), Number(m[2]), '', '').trim() : f.words) + ' accepted on ' + day(f.accept.at); });
    const words = range(a.entries.from, a.entries.to, '', '').trim() + ': archive ' + cur.name + ', split off on ' + day(cur.at || a.made) + (a.check.mark === 'linked' ? ' (◇: holds ' + held.join(', ') + ')' : '');
    const previous = a.previous ? { name: a.previous.name, digest: a.previous.digest, split: a.previous.split, to: a.entries.from - 1, at: 0 } : null;
    return { item: { ...item, from: a.entries.from, mark: a.check.mark, words, held: held.join(', '), digest: cur.digest }, previous };
  }

  /** A check's answer from what its walk found (H.7): the open findings, the mark by precedence, the words, the digest. */
  _answer({ fields, entries, spans, found, accepted, held, conditions: cond, expect, saved, publish = true, from = 1, last = 0, look = null, points = [], splits = [], walk = null }) {
    const keyless = this.keylessRuns;
    // What the archives add (H.10.4): their findings, a split stopped part way, a folder that could not be read.
    const conditions = [...cond];
    if (look && look.unfinished) conditions.push({ kind: 'split', mark: 'unvouched', words: unfinishedWords(look.unfinished, this.splitCode) });
    if (look && look.unread) conditions.push({ kind: 'archives', mark: 'unvouched', words: 'the archive folder could not be read (' + look.unread + '): the archives the log names were not looked at' });
    const spanFindings = spans.map((s) => {
      const kind = spanKind(s.runs, keyless);
      return { id: 's' + s.from + '-' + s.to, kind, from: s.from, to: s.to, words: spanWords(s.runs, { first: s.first, keyless }), linked: spanWords(s.runs, { first: s.first, keyless, linked: true }), ...(kind === 'plain' ? { first: s.first } : {}) };
    });
    const all = [...spanFindings.map(({ linked, ...f }) => ({ ...f, mark: 'unvouched', linked })), ...[...found, ...(look ? look.findings : [])].map((f) => ({ ...f, mark: FINDING[f.kind], ...(FINDING[f.kind] === 'broken' ? { confirm: true } : {}) }))];
    const onDisk = new Set(all.map((f) => f.id));
    const open = all.filter((f) => !accepted.has(f.id)).map(({ linked, ...f }) => f);
    for (const h of held) {
      if (h.kind === 'more') open.push({ id: 'more', kind: 'more', mark: 'broken', held: true, words: (h.n === 1 ? '1 more finding is' : h.n + ' more findings are') + ' not on disk yet' });
      else if (!onDisk.has(h.id)) open.push({ ...h, held: true });
    }
    const took = all.filter((f) => accepted.has(f.id));
    // What the split's own check hands it: each finding closed, in the words a ◇ answer names it by.
    if (walk) walk.took = took.map((f) => ({ id: f.id, kind: f.kind, from: f.from, to: f.to, words: f.linked || f.words }));
    // An archive with a finding reads ✕ until it is accepted, ◇ after; one looked at whole carries the mark it was split
    // off with, so a split never makes the log read better than it did.
    const archives = (look ? look.archives : []).map(({ held: h, digest: d, ...a }) => (a.finding ? { ...a, mark: accepted.has(a.finding) ? 'linked' : 'broken', held: h } : { ...a, held: h }));
    const digest = sha256(JSON.stringify(open.map((f) => [f.id, f.words]))).slice(0, 16);
    const head = { seq: saved ? saved.seq : 0, lag: this._lag(expect.seq, saved), ...(conditions.some((c) => c.kind === 'head') ? { error: conditions.find((c) => c.kind === 'head').words } : {}) };
    const extra = this.unwritten ? { unwritten: this.unwritten } : {};
    // An export's own check (publish false) is the export's: this run reads what the routine check found. Whole or broken
    // at a line, the archives it looked at give their pins, by which an archive's own Check knows it (lib/auditarchive.js).
    if (publish) {
      this.whole = !!fields.done;
      this.pins = new Map((look ? look.archives : []).map((a) => [a.name, a.digest]));
    }
    if (publish && fields.done) {
      // The walk is whole: what it found is what the rows' marks and health read from now on.
      this.spans = spans.map((s) => ({ id: 's' + s.from + '-' + s.to, from: s.from, to: s.to }));
      for (const [id, at] of accepted) this.accepted.set(id, at);   // an accept is never taken back: it only adds
      this.lastCheck = open;
      this.from = from;
      this.archives = archives.map(({ held: h, ...a }) => a);
      this.unreached = look ? look.unreached : [];
      this.points = points;
      this.splitsSeen = splits;
      this.unfinished = look ? look.unfinished : null;
      if (!this.unfinished) this.splitCode = '';
    } else if (publish) {
      // Broken at a line: health, the console and the opener read ✕ until a whole check replaces it.
      this.lastCheck = [{ kind: 'broken', mark: 'broken', words: 'Broken at line ' + fields.brokenAt + ' of ' + fields.file + ': ' + fields.why }, ...open];
    }
    let mark = 'intact';
    let words;
    const worst = (m) => { if (RANK[m] > RANK[mark]) mark = m; };
    for (const f of open) worst(f.mark);
    for (const c of conditions) worst(c.mark);
    for (const a of archives) if (!a.finding) worst(a.mark);
    const span = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);
    if (!fields.done) {
      mark = 'broken';
      words = 'Broken at line ' + fields.brokenAt + ' of ' + fields.file + ': ' + fields.why;
    } else if (mark === 'broken') {
      const x = open.filter((f) => f.mark === 'broken');
      words = x[0].words + (x.length > 1 ? ' (and ' + (x.length - 1) + ' more ✕ finding' + (x.length > 2 ? 's' : '') + ')' : '');
    } else if (mark === 'unvouched') {
      const u = open.filter((f) => f.mark === 'unvouched');
      words = 'Not vouched for — ' + [...u.map((f) => f.words), ...conditions.map((c) => c.words)].join('; ') + (u.length ? ': accept them on the AGMessage laptop (Admin → Health)' : '');
    } else if (took.length || mark === 'linked') {
      mark = 'linked';
      const live = took.filter((f) => !/^a[0-9]/.test(f.id)).map((f) => (f.linked || f.words) + ', accepted on the AGMessage laptop on ' + day(accepted.get(f.id)));
      if (!archives.length) words = 'Linked — ' + live.join('; ') + '; the rest of the ' + entries + ' entries, keyed here, are intact';
      else {
        const held = archives.map((a) => (a.finding ? a.words + ', accepted on the AGMessage laptop on ' + day(accepted.get(a.finding))
          : span(a.from, a.to) + ' are in the archive ' + a.name + (a.mark === 'linked' ? ', which holds ' + a.held : ', intact')));
        words = 'Linked — ' + (live.length ? live.join('; ') + '; the rest of ' : '') + span(from, last) + ', keyed here, are intact; ' + held.join('; ');
      }
    } else if (archives.length) words = 'Intact — ' + span(from, last) + ', keyed on this machine; ' + span(archives[0].from, archives[archives.length - 1].to) + ' in ' + archives.length + ' archive' + (archives.length === 1 ? '' : 's') + ', intact';
    else words = 'Intact — ' + entries + ' entries, all keyed on this machine';
    const out = { ok: mark === 'intact', mark, words, entries, findings: open, digest, head, ...extra };
    if (!fields.done) Object.assign(out, { file: fields.file, brokenAt: fields.brokenAt, why: fields.why });
    if (mark !== 'intact') out.error = words;
    // At the end (H.10.4): the first entry walked, and every archive the walk names.
    out.from = from;
    out.archives = archives.map(({ held: h, ...a }) => a);
    return out;
  }

  /**
   * Accept what a person at the laptop ticked, having typed its token (the caller checks the token): `digest` is the one
   * the check they were shown gave, `ids` the findings ticked, `confirm` the ✕ ones confirmed. Checked again here; the
   * `audit.accept` entry takes effect once it is on disk, and only then is the head saved.
   * Returns {ok, status?, error?, entry?, head?: 'saved' | 'waiting', words?}.
   */
  async accept({ digest, ids, confirm }, actor, ip) {
    if (this.keyless) return { ok: false, status: 503, error: 'not accepted: this run has no machine key (' + this.keyless.code + '), so nothing it writes can be checked' };
    const c = await this.verify();
    if (c.why) return { ok: false, status: 409, error: 'not accepted: the log is broken at line ' + c.brokenAt + ' of ' + c.file + ' (' + c.why + '), and a broken entry is never accepted' };
    if (typeof digest !== 'string' || digest !== c.digest) return { ok: false, status: 409, error: 'the log changed since your check: check again' };
    const want = Array.from(new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []));
    const sure = new Set(Array.isArray(confirm) ? confirm.filter((x) => typeof x === 'string') : []);
    if (!want.length) return { ok: false, status: 400, error: 'tick what to accept first' };
    const take = [];
    for (const id of want) {
      const f = c.findings.find((x) => x.id === id);
      if (!f) return { ok: false, status: 400, error: id.slice(0, 20) + ' is not an open finding: check again' };
      if (f.held) return { ok: false, status: 409, error: 'not on disk yet: ' + f.words.slice(0, 120) + ' — it can be accepted once it is' };
      if (f.mark === 'broken' && !sure.has(id)) return { ok: false, status: 400, error: 'confirm it first: ' + f.words.slice(0, 160) };
      take.push(f);
    }
    const target = take.map((f) => f.id).join(',');
    if (target.length > 80) return { ok: false, status: 400, error: 'too many at once: accept fewer, then accept again for the rest' };
    const e = this.write(actor, 'audit.accept', target, 'accepted on the AGMessage laptop: ' + take.map((f) => f.words).join('; '), ip);
    if (this.onDisk.seq >= e.seq) {
      for (const f of take) this.accepted.set(f.id, e.at);
      if (this.lastCheck) this.lastCheck = this.lastCheck.filter((f) => !this.accepted.has(f.id));
      this.headLane.flushSync();
      return { ok: true, entry: e.seq, head: 'saved' };
    }
    this.waitingAccepts.push({ seq: e.seq, ids: take.map((f) => f.id), at: e.at });
    return { ok: true, entry: e.seq, head: 'waiting', words: 'not accepted yet: the disk would not take the entry (' + (this.lastError || 'no answer') + '); it takes effect when it does' };
  }
}

module.exports = { AuditLog, hashOf, macOf, kidOf, keysFrom, sealRecord, wordsWithList, LABELS, SHAPE, GENESIS, WORDS_MAX, SID_MAX };
