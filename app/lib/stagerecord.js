'use strict';
/**
 * The stage record: what was shown on people's pages, hall by hall, for the admin's transcript and the AI's minutes (plan
 * 4-§5.13, owner answer 19). One entry per take a hall accepted (both layers, the Board's or one person's) and per
 * take-down, kept as it was asked: who put it up and from which seat, for whom, what it showed in the console's words (a
 * file by its name and place, a web page by its host alone, never its address), a quote's words, the line sent with it to
 * the speaker's screen, what the pages reported of it, and when it was withdrawn. What was shown was shown: a withdrawal
 * marks its entry, and never takes it out.
 *
 * `seen` is written once, when every page that holds the take has settled on it, or `seenMs` after it, whichever is
 * first: how many of them showed it (`shown`), of how many (`of`), and, of a document, how many drew its stand-in
 * (`standin`). A page settles when it says it showed it, or that it could not or was put back to chat by its person; a
 * page that says it holds it out of view (asleep, in another app, under another take) may still show it, so it is waited
 * for. Visible or it did not happen: it counts the pages that said they showed it, nothing more.
 *
 * Kept per hall in `<dir>/<HALL>.json` (`{v, dropped, entries}`), at most `max` entries, the oldest going first and
 * counted (`dropped`, so the transcript says how many are no longer kept). Each hall's file is written through a write
 * lane of its own (mode 0600), made when the hall's first entry is written, listed by `lanes()` for the server to flush at
 * a stop or a crash and to name in health. Read once, after this copy holds its data folder (`load`, through fs.promises:
 * nothing here holds the loop), when the record of a hall that no longer exists (none of its files on disk, loaded or
 * not, as the server says) is removed with its `.bak` (the boot sweep); whatever is asked before then waits for it, in
 * order. A hall's file that could not be read (EBUSY, EACCES, and
 * no `.bak` either), and every hall's when the folder could not be listed, is never written over this run: what it is
 * asked is kept for the run alone, and said.
 *
 * A Main room's reset clears its hall's record, a side room's drops the entries sent from it, each written with no copy
 * of the file before it (`clearBak`), so the words cleared are in neither file; what was shown from the Main room stays
 * the hall's, whichever room's file it showed. A hall's file that could not be read is not cleared on disk, and the clear
 * says so. A hall removed closes its lane and takes its file and `.bak` with it.
 *
 *   entryOf(take, o)  : a take as the record keeps it (pure)
 *   storedEntry(e)    : an entry read back in its clean shape, or null (pure)
 *   whoSaid(e)        : who put it up, in the transcript's words: "Ana (backstage)" (pure)
 *   didSaid(e)        : what they did, for whom: "showed the Board (6 pages)", "took the information down on Gil's pages" (pure)
 *   seenSaid(seen)    : what the pages reported: "✓ on 6 of 6", "on 4 of 6 within 10 s", "✓ on 6 of 6, 2 as a picture" (pure)
 */
const fs = require('fs');
const path = require('path');
const { WriteLane } = require('./resilience');
const { describePage, snippetText, layersOf, KINDS } = require('./pages');
const guard = require('./guard');

/** At most this many entries a hall; the oldest go first. */
const MAX = 500;
/** `seen` is written at the latest this long after a take. */
const SEEN_MS = 10_000;
/** A hall's key, as the store keys rooms; a record's file by it, and its backup. */
const HALL = /^[A-Z0-9]{4,12}$/;
const FILE = /^([A-Z0-9]{4,12})\.json(?:\.bak)?$/;
/** The seats a pusher may sit in, and the admin (the admin page, or the laptop's token), each in the transcript's words. */
const ROLE_SAID = Object.freeze({ research: 'backstage', board: 'On stage', observer: 'observer', admin: 'admin' });
const LAYERS = Object.freeze(['show', 'info', 'both']);
/** A page's word on a take that no later report of it undoes, short of showing it: it could not draw it, or its person put it away. */
const SETTLED = Object.freeze(['failed', 'dismissed']);
const VIA = Object.freeze(['now', 'operator']);
/** The bounds of a field read back: a name, a room's name, what it showed in words, a quote's words, a line. */
const BOUNDS = Object.freeze({ name: 60, what: 1000, text: 20_000, line: 2000 });
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const whole = (n, min = 0) => Number.isInteger(n) && n >= min;
const words = (v, max) => typeof v === 'string' && v.length <= max;
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

/**
 * The side room a take's content shows something of ({room, name}): a document's or a picture's own file there, or the
 * file a picture or a quote was made from; null for the Main room's, or for content of no file.
 */
function sourceOf(c) {
  const o = isRecord(c) && typeof c.room === 'string' ? c : isRecord(c) && isRecord(c.from) && typeof c.from.room === 'string' ? c.from : null;
  return o && HALL.test(o.room) ? { room: o.room, name: guard.cleanText(o.roomName, BOUNDS.name) } : null;
}

/**
 * A take as the record keeps it (pure): `take` as the pages' store numbered it, `to` 'board' or a person (`name`, never
 * their key), `role` the pusher's seat (ROLE_SAID's keys; any other is left out) and `hallHolding` the hall's holding
 * picture, which a holding slide with no picture of its own shows. `what` is the console's words for it (lib/pages.js
 * describePage), `text` a quote's words in reading order (snippetText), `sentFrom` the side room it was sent from and
 * `from` the side room whose file it shows something of.
 */
function entryOf(take, { to = 'board', name = '', role = '', hallHolding = '' } = {}) {
  const c = take.content;
  const layers = layersOf(c);
  const from = sourceOf(c);
  const sent = isRecord(take.sent) && HALL.test(guard.str(take.sent.key)) ? { key: take.sent.key, name: guard.cleanText(take.sent.name, BOUNDS.name) } : null;
  return {
    seq: take.seq, at: take.at,
    by: { name: guard.cleanText(take.by && take.by.name, BOUNDS.name), ...(Object.hasOwn(ROLE_SAID, role) ? { role } : {}) },
    to: to === 'board' ? 'board' : { name: guard.cleanText(name, BOUNDS.name) },
    ...(sent ? { sentFrom: sent } : {}),
    layer: layers.length === 2 ? 'both' : layers[0] || 'show',
    kind: c.kind,
    what: describePage(c, { hallHolding, by: take.by && take.by.name }),
    ...(c.kind === 'snippet' ? { text: snippetText(c) } : {}),
    ...(from ? { from } : {}),
  };
}

/** A side room as an entry keeps it ({key, name} sent from; {room, name} shown from), read back, or null. */
const storedRoom = (v, k) => (isRecord(v) && HALL.test(guard.str(v[k])) && words(v.name, BOUNDS.name) ? { [k]: v[k], name: v.name } : null);
/** What the pages reported, read back: {shown, of, standin?}, or null. */
function storedSeen(v) {
  if (!isRecord(v) || !whole(v.of) || !whole(v.shown) || v.shown > v.of) return null;
  const st = own(v, 'standin');
  if (st !== undefined && !(whole(st, 1) && st <= v.shown)) return null;
  return { shown: v.shown, of: v.of, ...(st !== undefined ? { standin: st } : {}) };
}
/**
 * An entry read back in its clean shape (pure), or null for one of the wrong shape: every field of its type and within
 * its bound, nothing it does not know kept.
 */
function storedEntry(e) {
  if (!isRecord(e) || !whole(e.seq, 1) || !Number.isFinite(e.at) || !isRecord(e.by) || !words(e.by.name, BOUNDS.name)) return null;
  const role = own(e.by, 'role');
  if (role !== undefined && !Object.hasOwn(ROLE_SAID, role)) return null;
  const to = e.to === 'board' ? 'board' : isRecord(e.to) && words(e.to.name, BOUNDS.name) ? { name: e.to.name } : null;
  if (!to || !LAYERS.includes(e.layer) || !KINDS.includes(e.kind) || !words(e.what, BOUNDS.what)) return null;
  // Each field that may be left out, read by its reader: absent, its clean value, or null for one of the wrong shape.
  const readers = {
    sentFrom: (v) => storedRoom(v, 'key'),
    text: (v) => (words(v, BOUNDS.text) && e.kind === 'snippet' ? v : null),
    line: (v) => (isRecord(v) && words(v.text, BOUNDS.line) && v.text && VIA.includes(v.via) ? { text: v.text, via: v.via } : null),
    from: (v) => storedRoom(v, 'room'),
    seen: storedSeen,
    withdrawn: (v) => (Number.isFinite(v) ? v : null),
  };
  const opt = {};
  for (const [k, read] of Object.entries(readers)) {
    const v = own(e, k);
    if (v === undefined) continue;
    opt[k] = read(v);
    if (opt[k] === null) return null;
  }
  const { sentFrom, ...rest } = opt;
  return {
    seq: e.seq, at: e.at, by: { name: e.by.name, ...(role !== undefined ? { role } : {}) }, to,
    ...(sentFrom ? { sentFrom } : {}), layer: e.layer, kind: e.kind, what: e.what, ...rest,
  };
}

/** Who put it up, in the transcript's words: "Ana (backstage)", "Ben (admin)", or the name alone. */
const whoSaid = (e) => (e.by.name || 'Someone') + (e.by.role ? ' (' + ROLE_SAID[e.by.role] + ')' : '');
/**
 * What they did, for whom (pure), with how many pages it reached where the pages have said: "showed the Board (6
 * pages)", "showed Gil", "took the information down on the Board's pages", "put Gil's pages back to chat".
 */
function didSaid(e) {
  const board = e.to === 'board';
  const whose = board ? 'the Board\'s pages' : (e.to.name || 'their') + (e.to.name ? '\'s pages' : ' pages');
  if (e.kind === 'chat') return e.layer === 'info' ? 'took the information down on ' + whose : 'put ' + whose + ' back to chat';
  const n = e.seen && e.seen.of ? ' (' + plural(e.seen.of, 'page') + ')' : '';
  return 'showed ' + (board ? 'the Board' : e.to.name || 'someone') + n;
}
/**
 * What the pages reported of it (pure), from its `seen`: "✓ on 6 of 6" (every page that held it showed it), "on 4 of 6
 * within 10 s", "✓ on 6 of 6, 2 as a picture" (a document's stand-in drawn), "no page of theirs was open"; '' before
 * it is written.
 */
function seenSaid(seen, { seenMs = SEEN_MS } = {}) {
  if (!seen) return '';
  if (!seen.of) return 'no page of theirs was open';
  const pictured = seen.standin ? ', ' + seen.standin + ' as a picture' : '';
  if (seen.shown === seen.of) return '✓ on ' + seen.shown + ' of ' + seen.of + pictured;
  return 'on ' + seen.shown + ' of ' + seen.of + ' within ' + Math.round(seenMs / 1000) + ' s' + pictured;
}

/**
 * A file's text and why it could not be read: {text} or {code} (only ENOENT says it is not there). What is no file (a
 * folder, which Windows may open and read as empty) is not read, on every platform: EISDIR, or ENOTFILE.
 */
async function readText(file) {
  try {
    const kind = await fs.promises.stat(file);
    if (!kind.isFile()) return { text: null, code: kind.isDirectory() ? 'EISDIR' : 'ENOTFILE' };
    return { text: await fs.promises.readFile(file, 'utf8'), code: '' };
  } catch (e) { return { text: null, code: e.code || 'EIO' }; }
}
/**
 * A record's file read back, falling back to its `.bak` when it is missing or torn: {data, code, whole} (`code`, why the
 * file itself was not read; `whole`, the file on disk is whole or not there, so its lane may keep it as `.bak` unread).
 */
async function readRecord(file) {
  let first = '';
  for (const f of [file, file + '.bak']) {
    const r = await readText(f);
    if (f === file) first = r.code;
    if (r.code) continue;
    try { return { data: JSON.parse(r.text), code: first, whole: f === file || first === 'ENOENT' }; } catch { /* torn: the next */ }
  }
  return { data: null, code: first, whole: first === 'ENOENT' };
}
/** A hall's record as it is kept: its entries, the count gone past the bound, its lane, why its file could not be read, and whether that file is whole. */
const blankBook = (whole = true, unread = '') => ({ entries: [], dropped: 0, lane: null, unread, whole });

class StageRecord {
  /**
   * The record kept in `dir` (one file a hall), read by `load()`: until it is, everything asked of it waits, in order.
   * `seenMs` is how long after a take its `seen` is written at the latest, `max` the entries a hall keeps.
   */
  constructor(dir, { mode = 0o600, delayMs = 200, max = MAX, seenMs = SEEN_MS } = {}) {
    this.dir = dir; this.mode = mode; this.delayMs = delayMs;
    this.max = whole(max, 1) ? max : MAX;
    this.seenMs = Number.isFinite(seenMs) && seenMs >= 0 ? seenMs : SEEN_MS;
    this.books = new Map();     // hall → {entries, dropped, lane, unread, whole}
    this.watches = new Map();   // hall + '\n' + seq → a take waiting for its `seen`
    this.loaded = false;
    this.loading = null;
    this.unlisted = '';         // why the folder could not be listed at the load ('' when it was, or is not there yet)
    this.queue = [];
  }

  /**
   * Read every hall's record once (after this copy holds its data folder), the record of a hall `exists` says is gone
   * removed with its `.bak` (the boot sweep), then do what was asked meanwhile, in order. Resolves to {gone, unread, kept}:
   * the halls whose records went, those whose files could not be read (each with why), and the files that could not be
   * removed (each with why).
   */
  load(exists = () => true) {
    if (!this.loading) this.loading = this._load(exists);
    return this.loading;
  }
  async _load(exists) {
    let names = [];
    const unread = [];
    // A folder that could not be listed holds files that were not read: no hall's is written this run.
    try { names = await fs.promises.readdir(this.dir); } catch (e) { if (e.code !== 'ENOENT') { this.unlisted = e.code || 'EIO'; unread.push(['', this.unlisted]); } }
    const halls = [...new Set(names.map((n) => FILE.exec(n)).filter(Boolean).map((m) => m[1]))].sort();
    const gone = [];
    const kept = [];
    for (const hall of halls) {
      if (!exists(hall)) {
        gone.push(hall);
        kept.push(...await this._unlink(hall));
        continue;
      }
      const read = await readRecord(this._file(hall));
      const data = isRecord(read.data) ? read.data : null;
      const book = blankBook(read.whole);
      if (data) {
        book.entries = (Array.isArray(data.entries) ? data.entries : []).map(storedEntry).filter(Boolean);
        book.dropped = whole(data.dropped) ? data.dropped : 0;
      } else if (read.code && read.code !== 'ENOENT') {
        book.unread = read.code;
        unread.push([hall, read.code]);
      }
      this.books.set(hall, book);
      this._trim(book);
    }
    this.loaded = true;
    for (const fn of this.queue.splice(0)) fn();
    return { gone, unread, kept };
  }
  /** Run `fn` now once the record is read, else once it is, after what was asked before it. */
  _do(fn) {
    if (this.loaded) return fn();
    this.queue.push(fn);
    return undefined;
  }
  /** Once the record is read, the value `fn` gives (a read, or a change that answers with what it did). */
  async _when(fn) {
    if (!this.loaded) await new Promise((resolve) => { this.queue.push(resolve); });
    return fn();
  }

  _file(hall) { return path.join(this.dir, hall + '.json'); }
  _book(hall) {
    let book = this.books.get(hall);
    if (!book) { book = blankBook(true, this.unlisted); this.books.set(hall, book); }
    return book;
  }
  /** A hall's record held to its bound: the oldest entries go first, and are counted. */
  _trim(book) {
    const over = book.entries.length - this.max;
    if (over > 0) { book.entries.splice(0, over); book.dropped += over; }
  }
  /**
   * A hall's record written through its own lane (made at its first write), unless its file could not be read; with
   * `clearBak`, with no copy of the file before it. The record is its file's one writer, so a file it read whole (or found
   * none of) is kept as `.bak` unread.
   */
  _save(hall, { clearBak = false } = {}) {
    const book = this.books.get(hall);
    if (!book || book.unread) return;
    if (!book.lane) book.lane = new WriteLane(this._file(hall), { delayMs: this.delayMs, keepBak: true, mode: this.mode, whole: book.whole });
    if (clearBak) book.lane.clearBak();
    book.lane.save(() => JSON.stringify({ v: 1, dropped: book.dropped, entries: book.entries }));
  }
  /** A hall's entry by its take's number, or null. */
  _entry(hall, seq) {
    const book = this.books.get(hall);
    return book ? book.entries.find((e) => e.seq === seq) || null : null;
  }

  /**
   * A take a hall accepted, recorded (entryOf's options, and `pages`: each page that holds it now, {sid, docs}, whose
   * reports make its `seen`). Returns the entry, or null for a hall or a take that is none.
   */
  shown(hall, take, { to = 'board', name = '', role = '', hallHolding = '', pages = [] } = {}) {
    if (!HALL.test(guard.str(hall)) || !isRecord(take) || !whole(take.seq, 1) || !isRecord(take.content)) return null;
    const entry = entryOf(take, { to, name, role, hallHolding });
    this._do(() => {
      const book = this._book(hall);
      book.entries.push(entry);
      this._trim(book);
      this._save(hall);
    });
    this._watch(hall, take, Array.isArray(pages) ? pages : []);
    return entry;
  }
  /** Wait for the pages that hold a take to report on it, `seenMs` at most. */
  _watch(hall, take, pages) {
    const held = new Map(pages.filter((p) => isRecord(p) && typeof p.sid === 'string').map((p) => [p.sid, p.docs !== false]));
    const w = { hall, seq: take.seq, pages: held, latest: new Map(), shown: new Set(), standin: new Set(), stands: take.content.kind === 'doc' && isRecord(take.content.standin), timer: null };
    if (!held.size) return this._seen(w);
    this.watches.set(hall + '\n' + take.seq, w);
    w.timer = setTimeout(() => this._seen(w), this.seenMs);
    w.timer.unref();
    return undefined;
  }
  /**
   * A page said what it did with a take (`state`, a report's), for a take that page held when it was recorded: shown once
   * it drew it in view (`shown`, or `opened` for a web page), as its stand-in when the page cannot open documents. A page
   * has settled once it showed it, or its last word is one no later report of it undoes (it could not draw it, or its
   * person put it back to chat); out of view or minimised, it may yet show it. Once every page has settled, `seen` is
   * written; else at the deadline, with the pages that showed it by then.
   */
  reported(hall, sid, seq, state) {
    const w = this.watches.get(hall + '\n' + seq);
    if (!w || !w.pages.has(sid)) return;
    w.latest.set(sid, state);
    if (state === 'shown' || state === 'opened') {
      w.shown.add(sid);
      if (w.stands && !w.pages.get(sid)) w.standin.add(sid);
    }
    const settled = (p) => w.shown.has(p) || SETTLED.includes(w.latest.get(p));
    if ([...w.pages.keys()].every(settled)) this._seen(w);
  }
  /** A take's `seen` written, once: what its pages had said by now. */
  _seen(w) {
    if (w.timer) clearTimeout(w.timer);
    this.watches.delete(w.hall + '\n' + w.seq);
    const seen = { shown: w.shown.size, of: w.pages.size, ...(w.standin.size ? { standin: w.standin.size } : {}) };
    this._do(() => {
      const e = this._entry(w.hall, w.seq);
      if (!e || e.seen) return;
      e.seen = seen;
      this._save(w.hall);
    });
  }
  /**
   * The line sent with a take to the speaker's screen (`text`, as the server built it; `via` 'now' or 'operator'), kept
   * on its entry. False when the hall has no entry of that take.
   */
  line(hall, seq, { text, via } = {}) {
    if (!words(text, BOUNDS.line) || !text || !VIA.includes(via)) return false;
    return this._do(() => {
      const e = this._entry(hall, seq);
      if (!e) return false;
      e.line = { text, via };
      this._save(hall);
      return true;
    }) !== false;
  }
  /** A take withdrawn at `at`: its entry stays, marked (what was shown was shown). */
  withdrawn(hall, seq, at = Date.now()) {
    if (!Number.isFinite(at)) return;
    this._do(() => {
      const e = this._entry(hall, seq);
      if (!e || e.withdrawn) return;
      e.withdrawn = at;
      this._save(hall);
    });
  }

  /**
   * A hall's record as the transcript and the minutes read it, once it is read: {entries, dropped}, its entries the
   * oldest first, each a copy. A side room's (`room`, its key) is the entries sent from it.
   */
  async of(hall, { room = '' } = {}) {
    return this._when(() => {
      const book = this.books.get(hall);
      if (!book) return { entries: [], dropped: 0 };
      const mine = (e) => !room || room === hall || (!!e.sentFrom && e.sentFrom.key === room);
      return { entries: book.entries.filter(mine).map((e) => JSON.parse(JSON.stringify(e))), dropped: book.dropped };
    });
  }
  /**
   * A Main room's reset: the hall's record cleared, written with no copy of the file before it. Resolves to {cleared,
   * unread}: how many entries went, and why its file could not be read ('' when it was), which leaves that file as it was
   * on disk: this run's entries go, and what the file holds is there at the next start that reads it.
   */
  async clear(hall) {
    return this._when(() => {
      for (const [k, w] of this.watches) if (w.hall === hall) { clearTimeout(w.timer); this.watches.delete(k); }
      const book = this.books.get(hall);
      if (!book) return { cleared: 0, unread: '' };
      if (!book.entries.length && !book.dropped) return { cleared: 0, unread: book.unread };
      const n = book.entries.length;
      book.entries = [];
      book.dropped = 0;
      this._save(hall, { clearBak: true });
      return { cleared: n, unread: book.unread };
    });
  }
  /**
   * A side room's reset (`room`, its key): the entries sent from it dropped from its hall's record, written with no copy
   * of the file before it. Resolves to {cleared, unread}, as clear() does.
   */
  async drop(hall, room) {
    return this._when(() => {
      const book = this.books.get(hall);
      if (!book) return { cleared: 0, unread: '' };
      const from = (e) => !!e.sentFrom && e.sentFrom.key === room;
      const n = book.entries.filter(from).length;
      if (n) {
        book.entries = book.entries.filter((e) => !from(e));
        this._save(hall, { clearBak: true });
      }
      return { cleared: n, unread: book.unread };
    });
  }
  /**
   * A hall removed: its lane closed (what is pending dropped), its record let go and its file and `.bak` removed.
   * Resolves to the files that could not be removed, each with why ([] when every one went).
   */
  async forget(hall) {
    return this._when(async () => {
      for (const [k, w] of this.watches) if (w.hall === hall) { clearTimeout(w.timer); this.watches.delete(k); }
      const book = this.books.get(hall);
      if (book && book.lane) book.lane.close();
      this.books.delete(hall);
      return this._unlink(hall);
    });
  }
  /** A hall's record file and its `.bak` removed: those that could not be, each [file, why]. */
  async _unlink(hall) {
    const left = [];
    for (const f of [this._file(hall), this._file(hall) + '.bak']) {
      try { await fs.promises.unlink(f); } catch (e) { if (e.code !== 'ENOENT') left.push([path.basename(f), e.code || 'EIO']); }
    }
    return left;
  }

  /** Each hall's lane made so far, by the name health gives it: [['stage <HALL>', lane], …]. */
  lanes() {
    const out = [];
    for (const [hall, book] of this.books) if (book.lane) out.push(['stage ' + hall, book.lane]);
    return out;
  }
}

module.exports = { StageRecord, entryOf, storedEntry, whoSaid, didSaid, seenSaid, ROLE_SAID, MAX, SEEN_MS };
