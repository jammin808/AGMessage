'use strict';
/**
 * Events (the 0.6.0 plan's Part 6, U15; tested in test/events.test.js): one data folder holds one event at a time, the
 * current one, and every event before it archived under data/archive/, never deleted silently. The server, the one
 * writer, archives the current event at the admin's act and begins the next one: a continuation of an archived event, a
 * copy of an event's settings and structure, or a fresh one. What the node itself holds (its settings and links, its keys,
 * the audit log and its archives) is never in an event.
 *
 *   data/event.json            the current event: {v, id, name, began, kind, from, after}. `kind` is how it began (first,
 *                              fresh, copy, continue), `from` the archive it was copied or continued from, `after` the
 *                              archive made as it began. A folder with none is its first event's (`firstOf`) until an
 *                              archive is made; then one is written once the next event has begun, and only then.
 *   data/archive/<time>/       an event archived, `<time>` the archive's time to the millisecond (2026-10-27T14-02-00-000Z):
 *     event.json               {v, id, name, began, ended, kind, from, next, counts, sends, halls, codes, busy, reason,
 *                              split, point, began, continued, purged}: what it was, what came next ({kind, from, name,
 *                              keepScreens}), what it held, the rooms that might send into each room (`sends`), its halls
 *                              by key and name, every code its rooms held (`codes`, so no code given out for it is ever
 *                              made again), the busy line and the reason typed where it was archived while busy, whether
 *                              the split was asked (`split`), and then the archive point's entry (`point`), the next event
 *                              begun (`next.began`: {id, at, name, kind, from}, written before the current event's record,
 *                              so a start never begins it twice), a continue (`continued`) and a deletion of its contents
 *                              (`purged`, with what could not be deleted `left`)
 *     rooms/ stage/ uploads/   its halls and side rooms with their messages, its stage record, its uploads
 *     pages.json displays.json desk-results.json accounts.json sessions.json admin-sessions.json (and each .bak)
 *     aside/                   a file of the event written after its archive began, whose name the archive held already:
 *                              kept apart, never over the archive's own (which is what the event held when it began)
 *   data/archive/.<time>.partial/  an archive being made: its event.json first, then the moves, then renamed whole. A start
 *                              finishes one before it serves, so no file is ever left in neither place.
 *
 *   nameAt / timeOf   an archive's name for a time, and the time a name says
 *   firstOf           the record of a folder's first event, which has none on disk
 *   readLive / writeLive   the current event's record: read with whether it is there, absent, or not read (and why)
 *   liveOf            the current event's record as an archive's `next.began` names it
 *   begin             step 3: the archive's folder made aside, its event.json written first
 *   moveIn            step 4: the event's files moved into the folder made aside (each a rename on one volume; the
 *                     uploads copied, counted and sized alike, then removed, where they are on another), then renamed whole
 *   moveBack          a continue: an archive's files moved back into the data folder (the sign-ins stay: they ended)
 *   partials / names  the archives being made, and the archives made
 *   readArchived / markArchived   an archive's event.json read, and written again with a field added
 *   copyPlan          the files a move takes from a folder: their names and bytes, whether it is a rename, the room left
 *   list              the archives, newest first (asynchronous)
 *   purge             an archive's contents deleted, its event.json kept and marked (asynchronous)
 *
 * The moves are synchronous on purpose: every store's file goes into the archive in one turn of the loop, so no save of
 * the event lands between two of its files and no request is answered half way; the act runs only behind the busy check,
 * and a copy across volumes sends the watchdog its beat as it runs (`beat`).
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonWhole } = require('./resilience');

const ARCHIVE = 'archive';
const LIVE = 'event.json';
/** An archive's name: its time to the millisecond, as ISO 8601 writes it with ':' and '.' made '-'. */
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const PARTIAL = /^\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.partial$/;
/** What may come next. */
const NEXT = Object.freeze(['continue', 'copy', 'fresh']);
/** How an event began: a folder's first, fresh, a copy, or an archived event continued. */
const BEGAN = Object.freeze(['first', 'fresh', 'copy', 'continue']);
/** An event's id. */
const ID = /^e[0-9a-z]{8,24}$/;
/** The folders an event holds in the data folder, moved file by file (their live folders stay, empty, for the next event). */
const FOLDERS = Object.freeze(['rooms', 'stage']);
/** The files an event holds in the data folder, each with its .bak. The current event's own record is written apart. */
const FILES = Object.freeze(['pages.json', 'displays.json', 'desk-results.json', 'accounts.json', 'sessions.json', 'admin-sessions.json']);
/** What a continue leaves in its archive: the sign-ins, which ended with it. */
const SIGN_INS = Object.freeze(['sessions.json', 'admin-sessions.json']);
/** The archive's folder of uploads. */
const UPLOADS = 'uploads';
/** The archive's folder of the files set aside: one of the event's written after the archive began, under a name it held. */
const ASIDE = 'aside';
/** The most uploads one archive takes: past it the folder is not this AGMessage's to move whole. */
const FILES_MAX = 1_000_000;
/** The watchdog is told this copy lives at least this often while a copy across volumes holds its loop. */
const BEAT_MS = 250;
/** An event's name, in characters. */
const NAME_MAX = 80;

const nameAt = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
/** The time an archive's name says, or NaN. */
function timeOf(name) {
  const m = NAME.test(String(name)) ? /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name) : null;
  return m ? Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + 'Z') : NaN;
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v, max = NAME_MAX) => (typeof v === 'string' ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : '');
const archiveName = (v) => (typeof v === 'string' && NAME.test(v) ? v : '');
const KEY = /^[A-Z0-9]{4,12}$/;

/** The record of a folder's first event, which has none on disk: begun with its oldest hall, its id this node's. */
function firstOf(nodeId, began) {
  return { v: 1, id: 'e' + String(nodeId || '').replace(/[^0-9a-z]/g, '').padEnd(8, '0').slice(0, 24), name: '', began: Number.isFinite(began) ? began : 0, kind: 'first', from: '', after: '' };
}

/** The current event's record as read: its fields by type, or null for none (or one that is not a record). */
function cleanLive(raw) {
  if (!isRecord(raw) || !ID.test(raw.id || '') || !BEGAN.includes(raw.kind)) return null;
  return { v: 1, id: raw.id, name: text(raw.name), began: Number.isFinite(raw.began) ? raw.began : 0, kind: raw.kind, from: archiveName(raw.from), after: archiveName(raw.after) };
}
/** The counts an archive's record keeps, each a whole number. */
const COUNTS = Object.freeze(['halls', 'rooms', 'messages', 'help', 'files', 'bytes', 'accounts', 'screens', 'takes', 'deskResults']);
const cleanCounts = (c) => Object.fromEntries(COUNTS.map((k) => [k, isRecord(c) && whole(c[k]) ? c[k] : 0]));
/** The rooms that might send into each room, as settings.roomSends keeps them: lists of keys. */
function cleanSends(s) {
  const out = {};
  if (isRecord(s)) for (const [k, v] of Object.entries(s)) if (KEY.test(k) && Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && KEY.test(x)).slice(0, 50);
  return out;
}
/** The next event begun, as its archive's record says it: {id, at, name, kind, from}, or null for none yet. */
function cleanBegan(b) {
  if (!isRecord(b) || !ID.test(b.id || '') || !Number.isFinite(b.at) || !BEGAN.includes(b.kind)) return null;
  return { id: b.id, at: b.at, name: text(b.name), kind: b.kind, from: archiveName(b.from) };
}
/** An archive's record as read: its fields by type, or null for none. */
function cleanArchived(raw) {
  const live = cleanLive(raw);
  if (!live) return null;
  const n = isRecord(raw.next) ? raw.next : {};
  const next = NEXT.includes(n.kind) ? { kind: n.kind, from: n.kind === 'fresh' ? '' : n.from === 'current' ? 'current' : archiveName(n.from), name: text(n.name), keepScreens: n.keepScreens === true, began: cleanBegan(n.began) } : null;
  return {
    ...live, ended: Number.isFinite(raw.ended) ? raw.ended : 0, next, counts: cleanCounts(raw.counts), sends: cleanSends(raw.sends),
    halls: Array.isArray(raw.halls) ? raw.halls.filter((h) => isRecord(h) && KEY.test(h.key || '')).slice(0, 1000).map((h) => ({ key: h.key, name: text(h.name) })) : [],
    codes: Array.isArray(raw.codes) ? raw.codes.filter((c) => typeof c === 'string' && KEY.test(c)).slice(0, 20_000) : [],
    split: raw.split === true,
    point: isRecord(raw.point) && whole(raw.point.seq) ? { seq: raw.point.seq } : null,
    continued: isRecord(raw.continued) && Number.isFinite(raw.continued.at) ? { at: raw.continued.at, into: archiveName(raw.continued.into) } : null,
    purged: isRecord(raw.purged) && Number.isFinite(raw.purged.at)
      ? { at: raw.purged.at, by: text(raw.purged.by, 60), left: Array.isArray(raw.purged.left) ? raw.purged.left.filter((x) => typeof x === 'string').map((x) => text(x, 120)).slice(0, 50) : [] }
      : null,
    // An archive made while AGMessage was busy: the busy line in words, and the reason typed (the archive point says both).
    busy: text(raw.busy, 200), reason: text(raw.reason, 200),
  };
}
/** The current event's record as an archive's next event begun names it (the archive `name` made as it began). */
function liveOf(name, began) {
  return { v: 1, id: began.id, name: began.name, began: began.at, kind: began.kind, from: began.from, after: archiveName(name) };
}

const archiveDir = (dataDir) => path.join(dataDir, ARCHIVE);
const partialOf = (dataDir, name) => path.join(archiveDir(dataDir), '.' + name + '.partial');
const livePath = (dataDir) => path.join(dataDir, LIVE);
const json = (o) => JSON.stringify(o, null, 2) + '\n';

/**
 * The current event's record, read: {rec, state, code}. `state` is 'ok' (the record), 'absent' (neither the file nor its
 * .bak is there: a folder's first event, or one between two events), or 'unread' (one is there and could not be read,
 * `code` why: busy, refused, torn, or not a record of an event). Only 'absent' is ever read as no record.
 */
function readLive(dataDir) {
  const r = readJsonWhole(livePath(dataDir));
  const rec = cleanLive(r.data);
  if (rec) return { rec, state: 'ok', code: '' };
  if (r.codes.every((c) => c === 'ENOENT')) return { rec: null, state: 'absent', code: 'ENOENT' };
  return { rec: null, state: 'unread', code: r.codes.find((c) => c && c !== 'ENOENT') || (r.data ? 'not an event\'s record' : 'not JSON') };
}
/** The current event's record written whole (its .bak kept beside it). */
function writeLive(dataDir, rec) { writeFileAtomic(livePath(dataDir), json(rec), { keepBak: true, mode: 0o600 }); }

// ---------------------------------------------------------------- the file calls (each the one call of its kind here)
/** What is at a path, not following a link: 'file', 'dir', 'other', or '' for nothing. */
function kindAt(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
}
/** A file's size, not following a link (-1 for none). */
function sizeOf(p) {
  try { const st = fs.lstatSync(p); return st.isFile() ? st.size : -1; } catch (e) { if (e.code === 'ENOENT') return -1; throw e; }
}
/** The files of a folder (not a link nor a folder), sorted; a folder not there holds none. */
function filesOf(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  if (out.length > FILES_MAX) throw Object.assign(new Error('more than ' + FILES_MAX + ' files in ' + dir), { code: 'E2BIG' });
  return out;
}
/** The folders of a folder, sorted; a folder not there holds none. */
function foldersOf(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
const makeDir = (d) => fs.mkdirSync(d, { recursive: true });
const rename = (a, b) => fs.renameSync(a, b);
const remove = (p) => { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const copy = (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
/** A folder removed where it is empty (one a continue emptied); one that still holds anything, or is not there, stays. */
const removeEmpty = (d) => { try { fs.rmdirSync(d); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; } };
/** The volume a folder is on (its device number): two folders on one volume rename into each other. */
const volumeOf = (p) => fs.statSync(p).dev;
/** The bytes free for this account on the volume of `p`. */
const freeAt = (p) => { const s = fs.statfsSync(p); return s.bavail * s.bsize; };

/** A move that did not finish, in words, with the file it stopped at: the archive stays aside for the next try or start. */
function moveFailed(e, file, tally) {
  const code = (e && e.code) || 'EIO';
  return Object.assign(new Error(file + ' could not be moved (' + code + ')'), { code, file, moved: tally ? tally.moved : 0, words: path.basename(file) + ' could not be moved (' + code + ')' });
}
/** Where a file is set aside in `dir`: its own name, or the first `name.N` that is free, so nothing set aside is ever replaced. */
function asidePath(dir, name) {
  makeDir(dir);
  let p = path.join(dir, name);
  for (let i = 1; kindAt(p); i++) p = path.join(dir, name + '.' + i);
  return p;
}

/**
 * The files a move takes from `from` into `to`, and whether it is a rename (one volume): {files: [{name, bytes}], bytes,
 * same, free}. `free` is the room on `to`'s volume, read only where it is not (a copy needs room).
 */
function copyPlan(from, to) {
  const files = filesOf(from).map((name) => ({ name, bytes: Math.max(0, sizeOf(path.join(from, name))) }));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  let same = true;
  if (files.length && kindAt(from) === 'dir' && kindAt(to) === 'dir') same = volumeOf(from) === volumeOf(to);
  return { files, bytes, same, free: same ? null : freeAt(to) };
}
/** The uploads an archive takes from the uploads folder into the data folder's volume (copyPlan). */
const uploadsPlan = (dataDir, uploadDir) => copyPlan(uploadDir, dataDir);

/** Step 3: the archive's folder made aside, and its event.json written first: a stop from here on leaves its intent on disk. */
function begin(dataDir, name, record) {
  const partial = partialOf(dataDir, name);
  makeDir(partial);
  writeFileAtomic(path.join(partial, LIVE), json(record), { mode: 0o600 });
  return partial;
}

/**
 * Move the files of `from` into `to` (each a rename; where `copyAcross`, a copy counted and sized alike, the originals
 * removed only once every one is copied): the folder's files only, `to` made. A name `to` holds already is never written
 * over silently: with `keep: 'to'` (an archive being made, whose own file is what the event held as it began) the file of
 * `from` is set aside in `aside`; with `keep: 'from'` (a continue: the archive's is the event's) the file at `to` is set
 * aside there first. An upload copied across volumes is the one exception: an upload's name is its own, so a copy at `to`
 * of another size is a copy a stop cut short, made again. Counts in `tally` ({moved, aside}); throws moveFailed.
 */
function moveFiles(from, to, { copyAcross = false, beat = null, tally, keep = 'to', aside }) {
  const names = filesOf(from);
  if (!names.length) return;
  makeDir(to);
  if (!copyAcross) {
    for (const n of names) {
      const src = path.join(from, n);
      const dst = path.join(to, n);
      try {
        if (kindAt(dst) && keep === 'to') { rename(src, asidePath(aside, n)); tally.aside++; tally.moved++; continue; }
        if (kindAt(dst)) { rename(dst, asidePath(aside, n)); tally.aside++; }
        rename(src, dst);
      } catch (e) { throw moveFailed(e, src, tally); }
      tally.moved++;
    }
    return;
  }
  let last = Date.now();
  for (const n of names) {
    const src = path.join(from, n);
    const dst = path.join(to, n);
    try {
      if (sizeOf(dst) >= 0 && sizeOf(dst) !== sizeOf(src)) remove(dst);
      if (sizeOf(dst) < 0) copy(src, dst);
      if (sizeOf(dst) !== sizeOf(src)) throw Object.assign(new Error('its copy is not the same size'), { code: 'ESIZE' });
    } catch (e) { throw moveFailed(e, src, tally); }
    if (beat && Date.now() - last >= BEAT_MS) { beat(); last = Date.now(); }
  }
  // Every one copied and sized alike: only now are the originals removed, so no upload is ever in neither place.
  for (const n of names) {
    try { remove(path.join(from, n)); } catch (e) { throw moveFailed(e, path.join(from, n), tally); }
    tally.moved++;
  }
}

/**
 * Step 4: the event's files moved into its archive made aside, then the folder renamed whole. A folder of the event
 * (rooms, stage) is moved file by file and stays, empty, for the next event; its uploads go into the archive's uploads/,
 * renamed on one volume and copied across two. A file whose name the archive holds already (one written after a try that
 * stopped part way) is set aside in its aside/, never over the archive's own. Answers {moved, aside}; a move refused
 * throws moveFailed, and the archive stays aside, its event.json naming what it is for, for the next try or start.
 */
function moveIn(dataDir, uploadDir, name, { beat = null } = {}) {
  const partial = partialOf(dataDir, name);
  const tally = { moved: 0, aside: 0 };
  for (const dir of FOLDERS) moveFiles(path.join(dataDir, dir), path.join(partial, dir), { tally, aside: path.join(partial, ASIDE, dir) });
  for (const f of FILES) {
    for (const file of [f, f + '.bak']) {
      const p = path.join(dataDir, file);
      if (kindAt(p) !== 'file') continue;
      const dst = path.join(partial, file);
      const clash = !!kindAt(dst);
      try { rename(p, clash ? asidePath(path.join(partial, ASIDE), file) : dst); } catch (e) { throw moveFailed(e, p, tally); }
      if (clash) tally.aside++;
      tally.moved++;
    }
  }
  const uploads = uploadsPlan(dataDir, uploadDir);
  moveFiles(uploadDir, path.join(partial, UPLOADS), { copyAcross: !uploads.same, beat, tally, aside: path.join(partial, ASIDE, UPLOADS) });
  // The current event's record goes last: from here on the folder has no current event until the next one begins.
  for (const file of [LIVE, LIVE + '.bak']) {
    try { remove(path.join(dataDir, file)); } catch (e) { throw moveFailed(e, path.join(dataDir, file), tally); }
  }
  try { rename(partial, path.join(archiveDir(dataDir), name)); } catch (e) { throw moveFailed(e, partial, tally); }
  return { moved: tally.moved, aside: tally.aside };
}

/**
 * A continue: the archive's files moved back into the data folder and its uploads into the uploads folder, all but its
 * sign-ins, which ended. A store's file the data folder holds is the empty one written as the event before it was let
 * go, and is replaced; a room's, a stage record's or an upload the data folder holds is set aside in the archive's aside/
 * first. The archive keeps its event.json and the sign-ins. Answers {moved, aside}; a move refused throws moveFailed.
 */
function moveBack(dataDir, uploadDir, name, { beat = null } = {}) {
  const dir = path.join(archiveDir(dataDir), name);
  const tally = { moved: 0, aside: 0 };
  for (const d of FOLDERS) { makeDir(path.join(dataDir, d)); moveFiles(path.join(dir, d), path.join(dataDir, d), { tally, keep: 'from', aside: path.join(dir, ASIDE, d) }); }
  for (const f of FILES) {
    if (SIGN_INS.includes(f)) continue;
    for (const file of [f, f + '.bak']) {
      const p = path.join(dir, file);
      if (kindAt(p) !== 'file') continue;
      try { rename(p, path.join(dataDir, file)); } catch (e) { throw moveFailed(e, p, tally); }
      tally.moved++;
    }
  }
  makeDir(uploadDir);
  const back = copyPlan(path.join(dir, UPLOADS), uploadDir);
  moveFiles(path.join(dir, UPLOADS), uploadDir, { copyAcross: !back.same, beat, tally, keep: 'from', aside: path.join(dir, ASIDE, UPLOADS) });
  // Its folders, emptied, go: the archive keeps its record and the sign-ins that ended, and nothing else of the event.
  for (const d of [...FOLDERS, UPLOADS]) removeEmpty(path.join(dir, d));
  return { moved: tally.moved, aside: tally.aside };
}

/** The archives being made (a `.partial` folder each), by their names, oldest first. */
function partials(dataDir) { return foldersOf(archiveDir(dataDir)).map((n) => (PARTIAL.exec(n) || [])[1]).filter(Boolean); }
/** The names of every archive made, oldest first. */
function names(dataDir) { return foldersOf(archiveDir(dataDir)).filter((n) => NAME.test(n)); }

/** An archive's record (an archive made, or `partial: true` one being made), or null. */
function readArchived(dataDir, name, { partial = false } = {}) {
  if (!NAME.test(String(name))) return null;
  const dir = partial ? partialOf(dataDir, name) : path.join(archiveDir(dataDir), name);
  return cleanArchived(readJsonWhole(path.join(dir, LIVE)).data);
}
/**
 * An archive's record written again with `fields` added (its point, its next event begun, its continue), or the fields
 * `fields(raw)` makes of the record as it is: the rest as it was. False where it holds no record that could be read; a
 * write refused throws.
 */
function markArchived(dataDir, name, fields) {
  const file = path.join(archiveDir(dataDir), name, LIVE);
  const raw = readJsonWhole(file).data;
  if (!isRecord(raw)) return false;
  writeFileAtomic(file, json({ ...raw, ...(typeof fields === 'function' ? fields(raw) : fields) }), { mode: 0o600 });
  return true;
}
/** An archive's folder. */
const folderOf = (dataDir, name) => path.join(archiveDir(dataDir), name);

/**
 * The archives, newest first, at most `max`, each {name, ...its record, contents}: `contents` whether anything but its
 * record is in it (a continued or deleted one holds none of the event's own). Read off the event loop.
 */
async function list(dataDir, max = 200) {
  let entries = [];
  try { entries = await fs.promises.readdir(archiveDir(dataDir), { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const name of entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort().reverse().slice(0, max)) {
    let raw = null;
    try { raw = JSON.parse(await fs.promises.readFile(path.join(archiveDir(dataDir), name, LIVE), 'utf8')); } catch { /* an archive whose record cannot be read is listed by its name alone */ }
    let held = [];
    try { held = (await fs.promises.readdir(path.join(archiveDir(dataDir), name))).filter((n) => n !== LIVE && !SIGN_INS.includes(n) && !SIGN_INS.some((s) => n === s + '.bak')); } catch { /* listed as holding nothing */ }
    out.push({ name, record: cleanArchived(raw), contents: held.length > 0 });
  }
  return out;
}

/** A record written whole off the loop: its bytes in a file of this process's own, on disk (fsync), then renamed into place. */
async function writeWhole(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  const fh = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally { await fh.close(); }
  try { await fs.promises.rename(tmp, file); } catch (e) { await fs.promises.rm(tmp, { force: true }).catch(() => { /* the write's own error is the one said */ }); throw e; }
}

/**
 * An archive's contents deleted at the token's typed ask: every file and folder in it but its event.json, read first and
 * then written again with `purged` (and what could not be deleted, `left`), so the archive's existence stays recorded and
 * a later ask deletes what was left. Never on a timer, and never data/audit-archive/, which no event act reaches. Resolves
 * {removed: [names], left: [[name, code]], recorded: '' or why its record was not written}; a record that cannot be read
 * rejects before anything is deleted.
 */
async function purge(dataDir, name, { at = Date.now(), by = '' } = {}) {
  const dir = path.join(archiveDir(dataDir), name);
  const raw = JSON.parse(await fs.promises.readFile(path.join(dir, LIVE), 'utf8'));
  if (!isRecord(raw)) throw Object.assign(new Error('its record is not one'), { code: 'EBADREC' });
  const left = [];
  const removed = [];
  for (const n of await fs.promises.readdir(dir)) {
    if (n === LIVE) continue;
    try { await fs.promises.rm(path.join(dir, n), { recursive: true, force: true }); removed.push(n); } catch (e) { left.push([n, e.code || 'EIO']); }
  }
  let recorded = '';
  try {
    await writeWhole(path.join(dir, LIVE), json({ ...raw, purged: { at, by: text(by, 60), ...(left.length ? { left: left.map(([n]) => n) } : {}) } }));
  } catch (e) { recorded = e.code || e.message; }
  return { removed, left, recorded };
}
/** Whether an archive holds anything but its record (what a deletion of its contents would remove), read off the loop. */
async function holdsAny(dataDir, name) {
  try { return (await fs.promises.readdir(path.join(archiveDir(dataDir), name))).some((n) => n !== LIVE); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

module.exports = {
  ARCHIVE, LIVE, NAME, NEXT, BEGAN, ID, FOLDERS, FILES, SIGN_INS, UPLOADS, ASIDE, NAME_MAX, COUNTS,
  nameAt, timeOf, firstOf, cleanLive, cleanArchived, liveOf, readLive, writeLive, copyPlan, uploadsPlan, begin, moveIn, moveBack, partials, names,
  readArchived, markArchived, folderOf, list, purge, holdsAny, archiveDir,
};
