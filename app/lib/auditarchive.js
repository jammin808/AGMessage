'use strict';
/**
 * The audit log carried across events (H.10): the admin's split at an archive point into a signed archive in
 * data/audit-archive/, a split finished (or its leftovers removed) at the next start, the points a split may be made at,
 * and an archive checked alone on the laptop.
 *
 * Invariants:
 *   - Nothing is written before the gate passes. A split is made only at an archive point under this machine's key in the
 *     live log, not its first entry, that is the first line of its file and names where its run began, with nothing open
 *     and nothing broken before it, a head that is read and saved, and no archive of that name: a split can never make
 *     the check read better than it did.
 *   - In this order: the check through the files' handles; the archive made aside (`.<name>.partial`, its four small files
 *     written whole); `audit.split`, pinning the archive by the SHA-256 of its SHA256SUMS, on disk before anything moves;
 *     the files before the point renamed into it, oldest first (one volume: no byte is copied); the folder renamed to its
 *     name; the head saved at once. Every state a stop leaves is read whole: a `.partial` folder a keyed split pins is
 *     walked first and finished at the next start, and one no split pins (it holds no log file) is removed then.
 *   - Nothing is deleted: a split moves files; a `.partial` folder is removed only when it holds no log file and a check
 *     that walked the log to its end met no split that pins it. AGMessage has no act that removes an archive.
 *   - An entry once chained is never withdrawn: a split whose own entry the disk refused keeps its folder made aside, so
 *     the entry, written ahead of the next one, pins a split not finished (finished as any other), never a missing archive.
 *   - An archive's own Check reads no better than what pins it: its SHA256SUMS the one the split pinned, signed by this
 *     laptop's key when it carries this laptop's key id; one the chain does not pin reads ◇ at best, △ under another key.
 *   - One at a time, and never beside an export: a split asked while an export streams, or while a split runs, is refused
 *     with who holds it and since when; an export or a check asked while a split runs waits for it.
 *   - No synchronous file call but the four small files of a split, written whole through writeFileAtomic. An archive's
 *     Check turns the event loop every SLICE entries, and Checks of one archive asked together share one walk.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./resilience');
const rules = require('../verify/auditrules');
const verifier = require('../verify/verify-audit');

const MAX_OPEN_TRIES = 3;
const SLICE = 1000;        // entries MAC-checked between turns of the event loop
const FIRST_LINE = 64 * 1024 + 1;   // an entry is at most 64 KB: its first line is in this many bytes, or the file has none
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LINE_SEQ = /^\{"seq":([1-9][0-9]{0,15}),/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (at) => { const d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const day = (at) => { const d = new Date(at); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
const span = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
const grouped = (fp) => fp.match(/.{4}/g).join(' ');
/** What a failure that changes nothing resolves to (a handle that will not close, a folder already gone), and a path's being there. */
const none = () => null;
const turn = () => new Promise((resolve) => { setImmediate(resolve); });
const exists = (p) => fs.promises.lstat(p).then((st) => st, none);
/** Close every handle; a handle that will not close is gone with its file. */
const closeAll = (handles) => Promise.all(handles.map((h) => h.fh.close().catch(none)));
/** An error's code from its message ("EACCES: permission denied, …" → EACCES), or the message. */
const codeOf = (message) => { const m = /^([A-Z][A-Z0-9_]{2,20}):/.exec(String(message)); return m ? m[1] : String(message).slice(0, 80); };
/** The event an archive point names in its words (“Spring Summit”), or ''. */
const eventOf = (words) => { const m = /“([^”]{1,80})”/.exec(String(words || '')); return m ? m[1] : ''; };

/** A file's whole content through its handle, from byte 0. */
async function readAll(fh) {
  const { size: n } = await fh.stat();
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === n ? buf : buf.subarray(0, got);
}
/** The seq of the first and the last whole line of a buffer (0 when none). */
function seqRange(buf) {
  const seqAt = (start) => { const m = LINE_SEQ.exec(buf.toString('utf8', start, Math.min(buf.length, start + 40))); return m ? Number(m[1]) : 0; };
  if (!buf.length) return { first: 0, last: 0 };
  return { first: seqAt(0), last: seqAt(buf.length > 1 ? buf.lastIndexOf(10, buf.length - 2) + 1 : 0) };
}
/** The first whole line of a file as an entry, or null: only its first bytes are read. */
async function firstEntry(file) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(FIRST_LINE);
    const { bytesRead } = await fh.read(buf, 0, FIRST_LINE, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    return nl > 0 ? rules.wholeEntry(buf.toString('utf8', 0, nl)) : null;
  } catch { return null; } finally {   // a file not there names no entry
    if (fh) await fh.close().catch(none);
  }
}
/** "1 entry waits" / "3 entries wait". */
const waitWords = (n) => (n === 1 ? '1 entry waits' : n + ' entries wait');

class Archiver {
  /**
   * @param o `audit`: the AuditLog; `signingKey()`: this machine's {privateKey, publicKey, fingerprint}, derived when called
   *   (throws when this run has none); `node()`: {id, name, version, build}; `exporter`: the Exporter (its slot), set after.
   */
  constructor({ audit, signingKey, node, exporter = null }) {
    this.audit = audit;
    this.signingKey = signingKey;
    this.node = node;
    this.exporter = exporter;
    this.slot = null;      // the split being made now: {by, since}
    this.running = null;   // its promise, which an export waits for
    this.checks = new Map();   // archive name -> its own Check running now: a second click shares it
  }

  /** The split being made now, or null: who it is for, and since when. */
  busy() { return this.slot ? { ...this.slot } : null; }
  /** Resolves once no split is being made. */
  idle() { return this.running || Promise.resolve(); }

  /**
   * Hold the one slot for `fn` (a split, or its finish): refused while an export streams or another split runs; a check
   * already running is waited for first, and every check or export asked meanwhile waits for this one.
   */
  async _hold(actor, fn) {
    const audit = this.audit;
    const ex = this.exporter && this.exporter.busy();
    if (ex) return { ok: false, status: 409, error: 'An export is being made for ' + ex.by + ' since ' + hhmm(ex.since) + ': split when it ends.' };
    if (this.slot) return { ok: false, status: 409, error: 'A split is being made for ' + this.slot.by + ' since ' + hhmm(this.slot.since) + ': try again when it ends.' };
    this.slot = { by: actor.name || actor.t, since: Date.now() };
    let release = null;
    this.running = new Promise((resolve) => { release = resolve; });
    let out;
    try {
      if (audit.checking) await audit.checking.catch(none);
      audit.splitting = this.running;
      out = await fn();
    } finally {
      audit.splitting = null;
      this.slot = null;
      this.running = null;
      release();
    }
    // What the split left is what health, the rows and the next export read: a whole check, published.
    await audit.verify().catch(none);
    return out;
  }

  /**
   * The archive points in the live log, newest first, each with what a split there would move or why it would not; and a
   * split not finished. From the newest whole check (one is run now).
   */
  async points() {
    const audit = this.audit;
    const c = await audit.verify();
    const list = audit.points.slice().reverse().map((p) => {
      const why = this._gate(p.seq, { points: audit.points, from: audit.from, findings: c.findings, last: c.why ? c.from + c.entries - 1 : Infinity });
      return { seq: p.seq, at: p.at, event: eventOf(p.words), name: p.name, from: audit.from, to: p.seq - 1, ...(why ? { why } : {}) };
    });
    return { ok: true, points: list, from: audit.from, unfinished: audit.unfinished ? { ...audit.unfinished } : null };
  }

  /** Why a split at `seq` is refused, from a walk's facts ('' when it is not): the rows of H.10.2's table, in its order. */
  _gate(seq, { points, from, findings, last }) {
    const audit = this.audit;
    const p = points.find((x) => x.seq === seq);
    if (last < seq) return 'Not split: entry ' + (last + 1) + ' is broken, and a split would make the log read better than it is.';
    if (!p || seq === from) return 'Entry ' + seq + ' is not an archive point this log can be split at.';
    if (!p.first) return 'This archive point is not the first line of a file (the disk refused entries when it was written): split at another point.';
    if (!p.run || p.run.first === '?') return 'This archive point does not say where its run of entries began (the head record could not be read when it was written): split at another point.';
    const before = (f) => {
      if (f.held || f.id === 'more') return true;
      if (/^s[0-9]/.test(f.id)) return f.from < seq;
      if (/^[ea][0-9]/.test(f.id)) return f.id.charAt(0) === 'a' || Number(f.id.slice(1)) < seq;
      return true;
    };
    if (findings.some(before)) return 'Not split: entries before ' + seq + ' have open findings. Accept them first (Admin → Health), or split at an earlier point.';
    if (audit.headOff) return 'Not split: the head record could not be read at this start (' + audit.headOff + ').';
    if (audit.headLane.lastError) return 'Not split: the head record could not be saved (' + codeOf(audit.headLane.lastError) + ').';
    if (audit.unwritten) return this._waiting();
    return '';
  }

  /** Why no split is made while entries wait for the disk: the split's own entry would wait behind them. */
  _waiting() {
    const audit = this.audit;
    return 'Not split: ' + waitWords(audit.unwritten) + ' for the disk (' + (audit.lastCode || 'EIO') + '): split once the log has written ' + (audit.unwritten === 1 ? 'it' : 'them') + '.';
  }

  /**
   * Split the log at the archive point `seq` (POST /api/audit/split): the caller has decided `actor` is the admin. At the
   * point of a split not finished, finish it. Resolves {ok, status?, error?, archive?, entries?, moved?, waiting?, waits?,
   * words?}: `waits` true for a split recorded or chained but not finished (`waiting` the files still to move).
   */
  async split(seq, actor, ip) {
    const audit = this.audit;
    audit.open();
    if (audit.keyless) return { ok: false, status: 503, error: 'Not split: this run has no machine key (' + audit.keyless.code + '), so the archive cannot be signed.' };
    if (!Number.isSafeInteger(seq) || seq < 1) return { ok: false, status: 400, error: 'Name the archive point to split at.' };
    return this._hold(actor, async () => {
      // A folder made aside that this run does not know as a split not finished (its split's entry reached the disk after
      // the newest check) is read by a whole walk first: inside the slot, nothing else moves the files it reads.
      if (!audit.unfinished && (await audit._partials()).length) await audit._verify().catch(none);
      if (audit.unfinished && audit.unfinished.seq === seq) return this._finish(actor, ip, { atStart: false });
      return this._split(seq, actor, ip);
    });
  }

  /** The files of the live log listed once and opened; listed and opened again while a rotation moved them (at most three times). */
  async _open() {
    const audit = this.audit;
    for (let tries = 1; ; tries++) {
      const before = audit.rotations;
      const handles = [];
      let moved = false;
      for (const p of audit.files()) {
        try { handles.push({ name: path.basename(p), file: p, fh: await fs.promises.open(p, 'r') }); } catch (e) {
          if (e.code === 'ENOENT' && p === audit.file) continue;   // a current file not made yet: the chain ends in the one before
          if (audit.rotations === before) { await closeAll(handles); throw new Error(path.basename(p) + ' could not be opened (' + (e.code || e.message) + ')', { cause: e }); }
          moved = true;
          break;
        }
      }
      if (!moved && audit.rotations === before) return handles;
      await closeAll(handles);
      if (tries >= MAX_OPEN_TRIES) throw new Error('the log rotated while the split started: try again');
    }
  }

  async _split(seq, actor, ip) {
    const audit = this.audit;
    if (audit.unwritten) return { ok: false, status: 503, error: this._waiting() };
    const left = await audit._partials();
    if (left.length) {
      const u = audit.unfinished;
      return { ok: false, status: 409, error: 'Not split: ' + (u ? 'the split at entry ' + u.seq + ' is not finished: finish it first (Admin → Health).'
        : path.join(path.basename(audit.archiveDir), '.' + left[0].name + '.partial') + ' is left from a split that did not finish, and no split the log holds pins it: the next start removes it, or says why it is left.') };
    }
    // 1. The check through handles, to the newest entry on disk when they were opened. Each file's length, SHA-256, and
    // first and last entry are taken as it is read.
    const stop = { ...audit.onDisk };
    let handles;
    try { handles = await this._open(); } catch (e) { return { ok: false, status: 409, error: 'Not split: ' + e.message }; }
    const facts = [];
    const walk = {};
    let check;
    try {
      const marker = Buffer.from('"h":"' + stop.h + '"}\n');
      const bufs = new Array(handles.length);
      let end = handles.length - 1;
      // The newest file that holds the stop's entry ends the chain this split reads; files after it hold later entries.
      for (; end >= 0; end--) {
        bufs[end] = await readAll(handles[end].fh);
        const at = bufs[end].indexOf(marker);
        if (at >= 0) { bufs[end] = bufs[end].subarray(0, at + marker.length); break; }
      }
      if (end < 0 && stop.seq) return { ok: false, status: 409, error: 'Not split: the newest entry on disk is in none of the log\'s files' };
      const files = handles.slice(0, end + 1);
      async function* source() {
        for (let i = 0; i < files.length; i++) {
          const buf = bufs[i] || await readAll(files[i].fh);
          facts[i] = { name: files[i].name, file: files[i].file, bytes: buf.length, sha256: sha256(buf), ...seqRange(buf) };
          bufs[i] = null;
          yield { name: files[i].name, buf };
        }
      }
      check = await audit.checkForSplit(source(), stop, walk);
    } finally {
      await closeAll(handles);   // the moves rename what they held
    }
    // The gate: everything before the point whole, nothing open, the head held.
    const why = this._gate(seq, { points: walk.points, from: walk.from, findings: check.findings, last: walk.broken ? walk.last : Infinity });
    if (why) return { ok: false, status: why.startsWith('Entry ') ? 400 : audit.unwritten && why === this._waiting() ? 503 : 409, error: why };
    const point = walk.points.find((x) => x.seq === seq);
    const at = facts.findIndex((f) => f.name === point.file);
    const moving = facts.slice(0, at);
    const from = walk.from;
    const name = audit.archiveName(from, seq - 1);
    const show = path.join(path.basename(audit.archiveDir), name);
    if (await exists(path.join(audit.archiveDir, name))) return { ok: false, status: 409, error: 'Not split: ' + show + ' already exists.' };
    let key;
    try { key = this.signingKey(); } catch (e) { return { ok: false, status: 503, error: 'Not split: ' + e.message }; }

    // 2. The archive, made aside: archive.json, the public key, SHA256SUMS over them and the files to move, its signature.
    const fp = key.fingerprint;
    const closed = (walk.took || []).filter((f) => (/^s[0-9]/.test(f.id) ? f.to < seq : /^e[0-9]/.test(f.id) ? Number(f.id.slice(1)) < seq : /^a[0-9]/.test(f.id)));
    const newest = walk.look && walk.look.archives.length ? walk.look.archives[walk.look.archives.length - 1] : null;
    const pin = newest ? walk.splits.find((x) => x.seq === newest.split) : null;
    const made = Date.now();
    const node = this.node();
    const check2 = closed.length
      ? { mark: 'linked', words: 'Linked — ' + closed.map((f) => f.words + ', accepted on the AGMessage laptop on ' + day(walk.accepts.get(f.id).at)).join('; ') + '; the rest of ' + span(from, seq - 1) + ', keyed here, are intact' }
      : { mark: 'intact', words: 'Intact — ' + span(from, seq - 1) + ', keyed on this machine' };
    const archive = {
      kind: 'agmessage audit archive', v: 1, made, by: { t: String(actor.t || ''), id: String(actor.id || ''), name: String(actor.name || '') },
      node: { id: node.id, name: node.name, version: node.version, build: node.build },
      log: audit.l, kid: audit.kid, signingKey: { alg: 'Ed25519', fingerprint: fp },
      entries: { from, to: seq - 1 }, start: { seq: from, prev: walk.firstPrev }, point: { seq, h: point.h },
      previous: from > 1 && newest && pin ? { name: newest.name, digest: pin.digest, split: newest.split } : null,
      check: { ...check2, findings: closed.map((f) => ({ id: f.id, kind: f.kind, words: f.words, accept: { ...walk.accepts.get(f.id) } })) },
      files: moving.map((f) => ({ path: 'log/' + f.name, bytes: f.bytes, first: f.first, last: f.last })),
    };
    const json = Buffer.from(JSON.stringify(archive, null, 2) + '\n');
    const pem = Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' }));
    const sums = Buffer.from([...moving.map((f) => f.sha256 + '  log/' + f.name), sha256(json) + '  archive.json', sha256(pem) + '  signing-key.pem'].join('\n') + '\n');
    const sig = crypto.sign(null, sums, key.privateKey);
    const digest = sha256(sums);
    const partial = path.join(audit.archiveDir, '.' + name + '.partial');
    try {
      await fs.promises.mkdir(audit.archiveDir, { recursive: true });
      await fs.promises.mkdir(partial);
      await fs.promises.mkdir(path.join(partial, 'log'));
      for (const [n, b] of [['archive.json', json], ['signing-key.pem', pem], ['SHA256SUMS', sums], ['SHA256SUMS.sig', sig]]) writeFileAtomic(path.join(partial, n), b, { mode: 0o600 });
    } catch (e) {
      await fs.promises.rm(partial, { recursive: true, force: true }).catch(none);   // nothing of it is pinned yet
      return { ok: false, status: 503, error: 'Not split: the archive could not be made aside (' + (e.code || e.message) + ').' };
    }

    // 3. Its entry, on disk before anything moves.
    const event = eventOf(point.words);
    const words = 'split here: ' + span(from, seq - 1) + ' move into ' + show + ', signed with ' + grouped(fp.slice(0, 16)) + '; the check starts at entry ' + seq
      + (event ? ', where “' + event + '” was archived' : ', the archive point of ' + point.name);
    const e = audit.write(actor, 'audit.split', seq + ';' + digest, words, ip);
    if (audit.onDisk.seq < e.seq) {
      // The entry is chained and cannot be withdrawn: it is written ahead of the next one, or at the stop. The folder made
      // aside is kept for it, so the entry pins a split not finished (Finish the split, or the next start, completes it);
      // should it never reach the disk, no split pins the folder, and the next start removes it.
      const said = 'The split waits: the log would not take its entry yet (' + (audit.lastCode || 'EIO') + '), and nothing has moved. The entry is written ahead of the next one; the split is then finished by Finish the split on Admin → Health, or at the next start.';
      return { ok: false, status: 503, archive: name, entries: { from, to: seq - 1 }, moved: 0, waiting: moving.length, waits: true, error: said, words: said };
    }
    // 4.-6. The moves, the folder's name, the head.
    const done = await this._moves(partial, name, moving.map((f) => f.file), { seq, split: e.seq });
    if (done.left || done.folder) {
      const what = done.left ? plural(done.left, 'file') + ' wait' + (done.left === 1 ? 's' : '') + ' to move' : 'every file is moved, and its folder is not renamed yet';
      return { ok: true, status: 202, archive: name, entries: { from, to: seq - 1 }, moved: done.moved, waiting: done.left, waits: true, words: 'The split is recorded (entry ' + e.seq + '), and ' + what + ' (' + done.code + '): it is finished at the next start, or by Finish the split on Admin → Health.' };
    }
    return { ok: true, archive: name, entries: { from, to: seq - 1 }, moved: done.moved, words: '✓ Split: ' + span(from, seq - 1) + ' are in the archive ' + name + ' (' + plural(done.moved, 'file') + ', signed). The check starts at entry ' + seq + '.' };
  }

  /**
   * Steps 4-6: each file renamed into the folder made aside, oldest first; the folder renamed to its name; the head saved.
   * A rename refused (a backup tool holding a file) stops there: the split is recorded and waits, and says why.
   */
  async _moves(partial, name, files, { seq, split }) {
    const audit = this.audit;
    let moved = 0;
    for (const f of files) {
      try { await fs.promises.rename(f, path.join(partial, 'log', path.basename(f))); moved++; } catch (e) {
        if (e.code === 'ENOENT' && await exists(path.join(partial, 'log', path.basename(f)))) continue;   // moved before a stop
        audit.splitCode = e.code || 'EIO';
        audit.unfinished = { seq, split, name, left: files.length - files.indexOf(f) };
        audit.flush();
        return { moved, left: files.length - files.indexOf(f), code: audit.splitCode };
      }
    }
    try { await fs.promises.rename(partial, path.join(audit.archiveDir, name)); } catch (e) {
      audit.splitCode = e.code || 'EIO';
      audit.unfinished = { seq, split, name, left: 0 };
      audit.flush();
      return { moved, left: 0, code: audit.splitCode, folder: true };
    }
    audit.unfinished = null;
    audit.splitCode = '';
    audit.flush();
    return { moved, left: 0 };
  }

  /**
   * Finish what a stop or a refused rename left (at a start, or by Finish the split): a `.partial` folder a keyed split
   * pins has its remaining files moved and its name given, and `audit.split.finished` says so; one no split pins and that
   * holds no log file was made before its split was written, and is removed, with `audit.split.fail`. One that holds a log
   * file but no split the newest check walked pins it is left as it is, and said. Whether a split pins a folder is known
   * only from a check that walked the log to its end: after one that broke, every folder is left as it is, and said.
   */
  async finish(actor, ip, { atStart = false } = {}) {
    const audit = this.audit;
    audit.open();
    if (audit.keyless) return { ok: false, status: 503, error: 'Not finished: this run has no machine key (' + audit.keyless.code + ').' };
    if (!(await audit._partials()).length) { audit.leftAside = []; return { ok: true, finished: 0, words: 'No split waits to be finished.' }; }
    // At a start the check at start has just walked the log; otherwise a whole walk is taken now, inside the slot.
    return this._hold(actor, async () => {
      if (!atStart) await audit._verify().catch(none);
      return this._finish(actor, ip, { atStart });
    });
  }

  /** The finish itself, inside the slot, from the newest published check (`audit.whole`, `audit.splitsSeen`). */
  async _finish(actor, ip, { atStart }) {
    const audit = this.audit;
    const partials = await audit._partials();
    const left = [];
    const said = [];
    let finished = 0;
    if (!audit.whole) {
      for (const p of partials) left.push({ name: '.' + p.name + '.partial', why: 'the check did not reach the end of the log, so whether a split pins it is not known' });
      audit.leftAside = left;
      for (const x of left) console.error('  [audit] ' + path.join(audit.archiveDir, x.name) + ' is left as it is: ' + x.why);
      return { ok: true, finished: 0, left: left.length, words: left.map((x) => 'A split\'s folder (' + x.name + ') is left as it is: ' + x.why + '.').join(' ') };
    }
    for (const p of partials) {
      const sums = await fs.promises.readFile(path.join(p.dir, 'SHA256SUMS')).catch(none);
      let a = null;
      try { a = JSON.parse(await fs.promises.readFile(path.join(p.dir, 'archive.json'), 'utf8')); } catch { /* a folder made before its files were whole */ }
      const pin = sums ? audit.splitsSeen.find((x) => x.digest === sha256(sums)) : null;
      const at = a && a.point && Number.isSafeInteger(a.point.seq) ? a.point.seq : 0;
      if (!pin && !p.logs.length) {
        await fs.promises.rm(p.dir, { recursive: true, force: true });
        audit.write(actor, 'audit.split.fail', String(at || ''), 'a split at ' + (at ? 'entry ' + at : 'an archive point') + ' did not finish before a stop; nothing was moved', ip);
        said.push('A split at ' + (at ? 'entry ' + at : 'an archive point') + ' did not finish before a stop; nothing was moved.');
        continue;
      }
      if (!pin || !a || rules.archiveProblem(a)) {
        const why = !pin ? 'it holds files no split in the log pins' : 'its archive.json cannot be read';
        console.error('  [audit] ' + p.dir + ' is left as it is: ' + why);
        left.push({ name: '.' + p.name + '.partial', why });
        said.push('A split\'s folder (.' + p.name + '.partial) is left as it is: ' + why + '.');
        continue;
      }
      const moved = new Set(p.logs.map((f) => path.basename(f)));
      const rest = a.files.map((f) => path.basename(f.path)).filter((n) => !moved.has(n)).map((n) => path.join(path.dirname(audit.file), n));
      const r = await this._moves(p.dir, p.name, rest, { seq: pin.point, split: pin.seq });
      if (r.left || r.folder) {
        said.push('The split at entry ' + pin.point + ' is still not finished: ' + (r.left ? plural(r.left, 'file') + ' to move' : 'its folder is not renamed yet') + ' (' + r.code + ').');
        continue;
      }
      finished++;
      audit.write(actor, 'audit.split.finished', pin.point + ';' + pin.digest, 'the split at entry ' + pin.point + ' was finished ' + (atStart ? 'at this start' : 'by Finish the split') + ': ' + plural(r.moved, 'file') + ' moved after ' + (atStart ? 'a stop' : 'it stopped'), ip);
      said.push('✓ The split at entry ' + pin.point + ' is finished: ' + plural(r.moved, 'file') + ' moved.');
    }
    audit.leftAside = left;
    return { ok: true, finished, ...(left.length ? { left: left.length } : {}), words: said.join(' ') };
  }

  /**
   * An archive checked alone, on this laptop (H.10.3): its signature by its own key, its files against its SHA256SUMS, its
   * archive.json, its entries from the one its first follows (the verifier's own check), then each entry under this
   * machine's key by MAC, then what pins it: the SHA-256 of its SHA256SUMS against the pin the chain holds for it, and,
   * under this laptop's key id, this laptop's signing key; and its point: the entry after it here (the live log's first,
   * or the next archive's) is the point archive.json names, and follows its last. Answers as the check does, with
   * `archive` at the end. Checks of one archive asked together share one walk.
   */
  checkArchive(name) {
    this.audit.open();
    if (!rules.archiveRange(name)) return Promise.resolve({ ok: false, status: 400, error: 'No such archive.' });
    if (!this.checks.has(name)) this.checks.set(name, this._checkArchive(name).finally(() => { this.checks.delete(name); }));
    return this.checks.get(name);
  }

  async _checkArchive(name) {
    const audit = this.audit;
    const dir = path.join(audit.archiveDir, name);
    const broken = (why) => ({ ok: false, mark: 'broken', words: 'Broken: ' + why, error: 'Broken: ' + why, entries: 0, findings: [], why, archive: { name } });
    // What pins the archive is the chain's: before any check has published one, a check runs first.
    if (!audit.pins) await audit.verify().catch(none);
    const there = await exists(dir);
    if (!there || !there.isDirectory()) return broken('the archive ' + name + ' is not on this laptop');
    const r = await verifier.check(dir, { keep: true });
    if (r.code === 3) return broken(r.why);
    if (r.kind !== 'archive') return broken('the folder ' + name + ' is not an archive\'s');
    const a = r.m;
    let checked = 0;
    let last = null;
    let n = 0;
    for (const text of r.texts.values()) {
      if (++n % SLICE === 0) await turn();
      const e = JSON.parse(text);
      last = e;
      if (e.k !== audit.kid) continue;
      if (!audit.macHolds(e)) return broken('entry ' + e.seq + ' was changed after it was written');
      checked++;
    }
    let ownKey = '';
    try { ownKey = this.signingKey().fingerprint; } catch { /* a run with no machine key: the archive's key is named as its own claim */ }
    const ownKid = !audit.keyless && a.kid === audit.kid;
    const signer = 'key ' + grouped(r.fp.slice(0, 16)) + ' …';
    // Under this laptop's key id the archive is this laptop's, and only this laptop's signing key signs one.
    if (ownKid && r.fp !== ownKey) return broken('the archive ' + name + ' carries this laptop\'s key id and is signed by ' + signer + ', not this laptop\'s key: it is not what this laptop split off');
    const pin = audit.pins ? audit.pins.get(name) : undefined;
    if (pin && r.sums !== pin) return broken('the archive ' + name + ' is not what was split off: its SHA256SUMS is not the one the split pinned');
    // The point after it, where this laptop holds it: the live log's first entry, or the first of the next archive.
    const after = audit.archives.find((x) => x.from === a.point.seq);
    const next = audit.from === a.point.seq ? await firstEntry(audit.files()[0]) : after ? await this._firstOf(after.name) : null;
    if (next && (next.seq !== a.point.seq || next.h !== a.point.h || next.prev !== last.h)) return broken('entry ' + a.point.seq + ', the archive point after it here, is not the one archive.json names');
    // The mark: the laptop's at the split, never better than what vouches for it here. Under another key id it is linked
    // (its MACs cannot be checked here); with no pin the chain reaches, ◇ under this laptop's key and △ under another.
    const RANK = { intact: 0, linked: 1, unvouched: 2 };
    let mark = a.check.mark;
    const cap = (m) => { if (RANK[m] > RANK[mark]) mark = m; };
    if (!ownKid) cap('linked');
    if (!pin) cap(ownKid ? 'linked' : 'unvouched');
    const entries = a.entries.to - a.entries.from + 1;
    const head = { intact: 'Intact — ', linked: 'Linked — ', unvouched: 'Not vouched for — ' }[mark];
    const words = head + span(a.entries.from, a.entries.to) + ' in the archive ' + name + ', split off on ' + day(a.made)
      + ': signed by ' + (r.fp === ownKey ? 'this laptop\'s key' : signer + ' (its own claim)') + ', every file what its SHA256SUMS says'
      + (pin ? '' : '; no split the live log reaches pins it, so it is not shown to be what was split off')
      + (ownKid ? '; ' + (checked === 1 ? '1 entry' : checked + ' entries') + ' keyed here checked' : '; its entries carry key id ' + a.kid.slice(0, 4) + '…, which this machine no longer holds: their MACs are not checked here')
      + (a.check.mark === 'linked' ? '; ' + a.check.findings.map((f) => f.words + ', accepted by entry ' + f.accept.seq + ' on ' + day(f.accept.at)).join('; ') : '')
      + (next ? '' : '; its archive point (entry ' + a.point.seq + ') is not on this laptop');
    const out = { ok: mark === 'intact', mark, words, entries, findings: [], from: a.entries.from, archives: [], archive: { name, from: a.entries.from, to: a.entries.to, made: a.made, signKey: r.fp, pinned: !!pin } };
    if (mark !== 'intact') out.error = words;
    return out;
  }

  /** The first entry of an archive's first log file, by its archive.json. */
  async _firstOf(name) {
    try {
      const a = JSON.parse(await fs.promises.readFile(path.join(this.audit.archiveDir, name, 'archive.json'), 'utf8'));
      return firstEntry(path.join(this.audit.archiveDir, name, ...a.files[0].path.split('/')));
    } catch { return null; }   // an archive whose archive.json cannot be read names no entry here
  }
}

module.exports = { Archiver, eventOf };
