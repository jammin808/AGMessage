'use strict';
/**
 * The upgrade's backup of the data folder, the way back's (the 0.6.0 plan's Part 6, U.6.1 step 3; tested in
 * test/machine.test.js). The server, the one writer, makes it at a stop this PC's machine asked for an upgrade (lib/
 * machinewire.js, `reason: 'upgrade'`), once the audit log, every store and each hall that changed are saved and before its
 * record is written (lib/laststop.js), so the record names it:
 *
 *   data/backups/upgrade-<build>-<time>-<suffix>/
 *     data/        the data folder as the stop left it: a hard link to each file only ever replaced whole by a rename
 *                  (every store, a hall's snapshot, every marker and record), which costs no room and keeps the file as
 *                  it was whatever replaces it after; a copy of each file written where it lies (KIND: an append-only log,
 *                  a hall's op log, the audit log, watchdog.log, crash.log; a .bak, which a save copies over), which a
 *                  link would let the next build change
 *     uploads/     a hard link to each upload (a posted file is never written again), a copy where the uploads folder is
 *                  on another volume
 *     backup.json  {v, build, stopAt, saved, data, uploads, linked, copied, bytes, ms}: the stop it was made at (its
 *                  time and build, as the stop's record names them), whether that stop saved, its counts
 *   It is made in a folder named `.partial-…` first and renamed whole, so one a stop did not finish never reads as a
 *   backup; one left so is removed when the next is made. backups/ and logs/ are never in one, nor any temporary file.
 *   KEEP (2) are kept, the newest; older ones are removed once a new one is whole.
 *
 *   kindOf    what a backup does with a file of the data folder, by its path inside it: 'link', 'copy' or 'skip' (pure)
 *   plan      the files a backup takes, each with its kind and size, and the bytes its copies take
 *   make      the backup made, or a throw with its words (`words`) when it cannot be: the disk short of room for its copies
 *             and the reserve beside them, or a file that cannot be linked or copied (the folder is then removed)
 *   list      the backups whole in the data folder, newest first
 *
 * app/machine.js, which requires Node's built-ins only, carries its own copy of `kindOf` (its restore and its estimate of
 * the room a backup takes), held to this one by test/machine.test.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKUPS = 'backups';
const PREFIX = 'upgrade-';
const PARTIAL = '.partial-';
/** How many backups are kept: the one this upgrade made, and the one before it. */
const KEEP = 2;
/** A backup's folder name: its build (the characters lib/version.js composes one from), its time (UTC) and a suffix. */
const NAME = /^upgrade-([0-9A-Za-z.+-]{1,80})-(\d{8}T\d{6}Z)-([0-9A-Za-z]{6})$/;
/** A file written where it lies, which a link would let a later write change: an append-only log, a .bak a save copies over. */
const IN_PLACE = /\.(?:log|jsonl|bak)$/i;
/** The watchdog is told this copy lives at least this often while a backup holds its loop (its beat is each second). */
const BEAT_MS = 250;
/** The most files one backup takes from a folder: past it the folder is not this AGMessage's to copy whole. */
const FILES_MAX = 1_000_000;

/** "20261102T203105Z": a time in a folder's name, UTC. */
const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const MB = (n) => (n < 1024 * 1024 ? Math.ceil(n / 1024) + ' KB' : Math.ceil(n / (1024 * 1024)) + ' MB');

/**
 * What a backup does with a file of the data folder, by its path inside it, '/' between folders (pure): 'skip' for the
 * backups and the console (backups/, logs/) and a temporary file (an atomic write's `.tmp`, a `.partial-` folder's);
 * 'copy' for a file written where it lies (IN_PLACE); 'link' for every other, which is only ever replaced whole.
 */
function kindOf(rel) {
  const parts = String(rel).split('/');
  if (parts[0] === BACKUPS || parts[0] === 'logs') return 'skip';
  const name = parts[parts.length - 1];
  if (/\.tmp$/i.test(name) || parts.some((p) => p.startsWith(PARTIAL))) return 'skip';
  return IN_PLACE.test(name) ? 'copy' : 'link';
}

/** Every file under `dir` (not following a link), '/' between folders, at most FILES_MAX; a folder not there holds none. */
function filesIn(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) { out.push(r); if (out.length > FILES_MAX) throw Object.assign(new Error('more than ' + FILES_MAX + ' files in ' + dir), { code: 'E2BIG' }); }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * The files a backup of `dataDir` and `uploadDir` takes: {files: [{area ('data' or 'uploads'), rel, kind, size}],
 * copyBytes}, `copyBytes` what its copies take on the disk (an upload is counted there too when the uploads folder is on
 * another volume than the data folder, where no link can be made).
 */
function plan(dataDir, uploadDir) {
  const files = [];
  let copyBytes = 0;
  const sameVolume = (() => { try { return fs.statSync(dataDir).dev === fs.statSync(uploadDir).dev; } catch { return true; /* no uploads folder: nothing of it to copy */ } })();
  for (const [area, dir] of [['data', dataDir], ['uploads', uploadDir]]) {
    if (area === 'uploads' && path.resolve(uploadDir).startsWith(path.resolve(dataDir) + path.sep)) continue;   // inside data: taken there
    for (const rel of filesIn(dir)) {
      const kind = area === 'data' ? kindOf(rel) : (/\.tmp$/i.test(rel) ? 'skip' : 'link');
      if (kind === 'skip') continue;
      let size;
      try { size = fs.statSync(path.join(dir, ...rel.split('/'))).size; } catch { continue; /* gone since it was listed */ }
      files.push({ area, rel, kind, size });
      if (kind === 'copy' || (area === 'uploads' && !sameVolume)) copyBytes += size;
    }
  }
  return { files, copyBytes };
}

/** Free bytes on the disk that holds `dir`, or null when it cannot be read. */
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/** An error whose words say what happened, for the stop's record and its console. */
function failed(words, cause) { return Object.assign(new Error(words), { words, code: cause && cause.code }); }

/** The backups whole in `dataDir`, newest first (by their time, then their name): [{name, build, at}]. */
function list(dataDir) {
  let entries;
  try { entries = fs.readdirSync(path.join(dataDir, BACKUPS), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => {
    const m = NAME.exec(e.name);
    return { name: e.name, build: m[1], at: m[2] };
  }).sort((a, b) => (a.at === b.at ? (a.name < b.name ? 1 : -1) : a.at < b.at ? 1 : -1));
}

/**
 * The backup made (see the head of this file): {name ('backups/<folder>'), linked, copied, bytes, ms}. `stopAt` and
 * `build` are the stop's, as its record names them; `saved` whether everything was saved before it; `reserve` the free
 * space the disk keeps beside its copies; `beat` told this copy lives while it runs. A disk short of room, or a file that
 * cannot be taken, throws with its words, and the folder it began is removed.
 */
function make({ dataDir, uploadDir, build, stopAt, saved, reserve = 1024 ** 3, beat = () => {}, now = Date.now() }) {
  const t0 = Date.now();
  let told = t0;
  const tick = () => { const t = Date.now(); if (t - told >= BEAT_MS) { told = t; beat(); } };
  const p = plan(dataDir, uploadDir);
  const free = freeBytes(dataDir);
  if (free !== null && free < p.copyBytes + reserve) {
    throw failed('no backup was made for the way back: its copies take ' + MB(p.copyBytes) + ' and the disk has ' + MB(free) + ' free, under that and the ' + MB(reserve) + ' it keeps beside them. Free some space, then upgrade again');
  }
  const backups = path.join(dataDir, BACKUPS);
  fs.mkdirSync(backups, { recursive: true });
  for (const e of fs.readdirSync(backups, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(PARTIAL + PREFIX)) remove(path.join(backups, e.name));
  }
  const safeBuild = /^[0-9A-Za-z.+-]{1,80}$/.test(String(build)) ? String(build) : 'unknown';
  const suffix = crypto.randomBytes(6).toString('base64').replace(/[^0-9A-Za-z]/g, '').slice(0, 6).padEnd(6, '0');
  const name = PREFIX + safeBuild + '-' + stamp(now) + '-' + suffix;
  const partial = path.join(backups, PARTIAL + name);
  let linked = 0, copied = 0, bytes = 0;
  try {
    fs.mkdirSync(partial);
    for (const f of p.files) {
      const from = path.join(f.area === 'data' ? dataDir : uploadDir, ...f.rel.split('/'));
      const to = path.join(partial, f.area, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      let link = f.kind === 'link';
      if (link) {
        try { fs.linkSync(from, to); linked++; } catch (e) {
          if (e.code === 'ENOENT') { tick(); continue; }   // gone since it was listed: a file the stop no longer holds
          link = false;   // another volume, or a file system without links: copied instead
        }
      }
      if (!link) {
        try { fs.copyFileSync(from, to); } catch (e) { if (e.code === 'ENOENT') { tick(); continue; } throw e; }
        copied++;
        bytes += f.size;
      }
      tick();
    }
    const ms = Date.now() - t0;
    const counts = { data: p.files.filter((f) => f.area === 'data').length, uploads: p.files.filter((f) => f.area === 'uploads').length };
    fs.writeFileSync(path.join(partial, 'backup.json'), JSON.stringify({ v: 1, build: safeBuild, stopAt, saved: saved === true, ...counts, linked, copied, bytes, ms }));
    fs.renameSync(partial, path.join(backups, name));
  } catch (e) {
    remove(partial);
    throw failed('no backup was made for the way back: ' + (e.code || e.message) + ' while it was being made, and what it began is removed', e);
  }
  for (const old of list(dataDir).slice(KEEP)) remove(path.join(backups, old.name));
  return { name: BACKUPS + '/' + name, linked, copied, bytes, ms: Date.now() - t0 };
}

/** A folder removed, links and all; one that cannot be is left (it never reads as a backup while its name is `.partial-`). */
function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left: the next backup tries again */ }
}

module.exports = { BACKUPS, KEEP, NAME, IN_PLACE, kindOf, plan, make, list, freeBytes };
