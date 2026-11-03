'use strict';
/**
 * The data folder says which build and format last wrote it: `format.json` in it, {format, build, at}, and `backup`, the
 * copy of the folder kept before that build moved it from a lower format (tested in test/dataformat.test.js).
 *
 *   FORMAT    the format this build writes. A folder with no marker is format 1 (0.5 and earlier write none), unless it
 *             holds nothing a server wrote: then it is new
 *   read      the marker off disk, read before anything is written: {state, format, build, at, backup, backupThere, code};
 *             only a marker that is not there (ENOENT) reads as none, and nothing stands in for one that could not be read
 *   refusal   why this build may not open the folder, in words, or '' (pure): a format above this build's, named with the
 *             build that wrote it and the copy that build kept of the folder before; a marker that could not be read, or
 *             that holds no format. The server and its watchdog each ask it before either writes anything in the folder
 *   settle    once this copy holds the folder, before anything else is written in it: the marker read again (what was read
 *             before the hold is not trusted past it) and refused as `refusal` says; a new folder marked; a lower format
 *             copied whole into backups/ first (a copy a stop left part way removed, and the disk's free space checked for
 *             it and the reserve), then each step up to this format, then the marker, written last, so a stop part way
 *             leaves the folder at its old format and the next start begins again; the same format marked again only when
 *             another build wrote it. Whatever cannot be done throws with its words and the marker as it was: a folder
 *             whose marker cannot be written would not say which build and format last wrote it, so no copy serves it
 *   rowWords  the audit row (`server.upgraded`) for a marker whose build changed, or '' (pure)
 *
 * "Newer" is MAJOR.MINOR.BUILD (lib/version.js `compareBuilds`). A build that opens a folder of a higher format refuses it;
 * one that opens a folder a newer build of the same format wrote serves it, says so (health's `format`, "This laptop"),
 * and marks it as its own.
 */
const fs = require('fs');
const path = require('path');
const { compareBuilds } = require('./version');
const { writeFileAtomic, readText } = require('./resilience');

/** The format this build writes: 2 (0.6). 1 is a folder 0.5 or earlier wrote, which carries no marker. */
const FORMAT = 2;
const FILE = 'format.json';
/** Where the copies of the folder are kept, inside it; a copy is never copied again. */
const BACKUPS = 'backups';
/** What the watchdog writes in the data folder before any server runs: a folder holding only these is new. */
const WATCHDOG_OWN = new Set(['logs', 'watchdog.log', 'watchdog.json', 'watchdog.seen.json', BACKUPS, '.gitkeep']);
/** Left out of a copy: the copies themselves, and the console the watchdog keeps writing while it is made. */
const NOT_COPIED = new Set([BACKUPS, 'logs']);
/** A build as a marker may name one (the characters lib/version.js composes a build from), else none is named. */
const BUILD_NAME = /^[0-9A-Za-z.+-]{1,80}$/;
/** A copy as `settle` names it: inside backups/, its name its format, time and a suffix of its own. */
const BACKUP_NAME = /^backups\/format-[1-9]\d{0,2}-\d{8}T\d{6}Z-[0-9A-Za-z]{6}$/;
/** A copy being made: never read as one, and removed by the next copy's start (only the copy holding the folder makes one). */
const PARTIAL = '.partial-';
/** The watchdog is told this copy lives at least this often while a long copy holds its loop (its beat is each second). */
const BEAT_MS = 250;
const MB = (n) => Math.ceil(n / (1024 * 1024)) + ' MB';

/**
 * The steps from each format to the next, run in order after the copy and before the marker. Each may be run again over
 * what it left part way: a stop part way leaves the marker as it was, and the next start copies the folder and runs the
 * steps again. From 1 to 2 nothing is rewritten: 0.6 reads a 0.5 folder's rooms, accounts, settings and audit log in
 * their 0.5 shape (design §1.7).
 */
const STEPS = Object.freeze({
  1: Object.freeze({ to: 2, run: () => {} }),
});

/** A folder's entries, or none when it is not there. */
function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** A file or folder removed with what is in it; throws when it cannot be. */
function remove(p) { fs.rmSync(p, { recursive: true, force: true }); }

/** The marker off disk; never throws. */
function read(dataDir) {
  const file = path.join(dataDir, FILE);
  const { text, code } = readText(file);
  if (code) return code === 'ENOENT' ? { state: 'none', file } : { state: 'unread', file, code };
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON: no format read */ }
  if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.format) || j.format < 1) return { state: 'invalid', file };
  const backup = typeof j.backup === 'string' && BACKUP_NAME.test(j.backup) ? j.backup : '';
  let backupThere = false;
  if (backup) { try { backupThere = list(path.join(dataDir, ...backup.split('/'))) !== null; } catch { /* there, unread: not offered */ } }
  return {
    state: 'read', file, format: j.format,
    build: typeof j.build === 'string' && BUILD_NAME.test(j.build) ? j.build : '',
    at: Number.isFinite(j.at) ? j.at : null, backup, backupThere,
  };
}

/** Why this build may not open the folder (`found`, read's), in words, or '' (pure). */
function refusal(found, { dataDir, build }) {
  if (found.state === 'unread') {
    return 'the data folder\'s format marker ' + found.file + ' could not be read (' + found.code + '), so which format the folder is in cannot be told. Nothing was changed. Start AGMessage again once it can be read (another program, often an antivirus or a backup, may hold it).';
  }
  if (found.state === 'invalid') {
    return found.file + ' holds no format AGMessage can read. Nothing was changed. Put back the copy it had; or, if no build newer than this one has written the folder, move it aside, and this build copies the folder into ' + path.join(dataDir, BACKUPS) + ' and marks it again.';
  }
  if (found.state !== 'read' || found.format <= FORMAT) return '';
  const by = found.build ? 'AGMessage ' + found.build : 'a build its marker does not name';
  const back = found.backup && found.backupThere
    ? ' To go back to this build, start it on the copy that build kept of the folder before it changed it: ' + path.join(dataDir, ...found.backup.split('/')) + ' (set AGM_DATA_DIR to it, or copy what it holds into a data folder of its own).'
    : found.backup ? ' The copy that build kept of the folder before it changed it, ' + path.join(dataDir, ...found.backup.split('/')) + ', is no longer there.'
      : ' That build names no copy of the folder from before it changed it.';
  return 'this data folder (' + dataDir + ') was last written by ' + by + ' in format ' + found.format + ', and this build (' + build + ') reads format ' + FORMAT + ' and older. Nothing was changed. Start ' + (found.build ? found.build + ' or a newer build' : 'the build that wrote it') + ' on this folder.' + back;
}

/** Whether the folder holds anything a server wrote: a file anywhere in it but the watchdog's own. */
function holdsData(dir, top = true) {
  for (const e of list(dir) || []) {
    if (top && WATCHDOG_OWN.has(e.name)) continue;
    if (!e.isDirectory() || holdsData(path.join(dir, e.name), false)) return true;
  }
  return false;
}

/** The bytes a copy of the folder takes: every file in it but the copies and the console, by its size on disk. */
function sizeOf(dir, top = true) {
  let n = 0;
  for (const e of list(dir) || []) {
    if (top && NOT_COPIED.has(e.name)) continue;
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? sizeOf(p, false) : fs.lstatSync(p).size;
  }
  return n;
}

/** The bytes free on the folder's disk for this account, or null when the system does not say. */
function freeOn(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/** "20261102T203105Z": a time in a folder's name, UTC. */
const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

/**
 * The folder copied whole, but the copies and the console, into backups/format-<from>-<time>-<suffix>: into a folder
 * named `.partial-…` first, renamed once every file is in it, so a copy that did not finish never reads as one. `tick`
 * is called as each file and folder is copied. Returns its path inside the data folder (forward slashes). A copy that
 * fails is removed and throws.
 */
function copyFolder(dataDir, from, now, tick) {
  const backups = path.join(dataDir, BACKUPS);
  fs.mkdirSync(backups, { recursive: true });
  const partial = fs.mkdtempSync(path.join(backups, PARTIAL + 'format-' + from + '-' + stamp(now) + '-'));
  const name = path.basename(partial).slice(PARTIAL.length);
  try {
    for (const e of list(dataDir) || []) {
      if (NOT_COPIED.has(e.name)) continue;
      fs.cpSync(path.join(dataDir, e.name), path.join(partial, e.name), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, filter: () => { tick(); return true; } });
    }
    fs.renameSync(partial, path.join(backups, name));
  } catch (e) {
    try { remove(partial); } catch { /* left as .partial-…, which never reads as a copy, and the next copy's start removes it */ }
    throw e;
  }
  return BACKUPS + '/' + name;
}

/**
 * The copies a start stopped part way (killed, or the power gone) removed, before a new one is made: only the copy that
 * holds the folder makes one, so none of them is being made now. One that cannot be removed is left; it never reads as a
 * copy.
 */
function removePartials(dataDir) {
  const backups = path.join(dataDir, BACKUPS);
  for (const e of list(backups) || []) {
    if (!e.name.startsWith(PARTIAL)) continue;
    try { remove(path.join(backups, e.name)); } catch { /* left: the disk's free space below is read with it there */ }
  }
}

/** The marker written whole: '' when it was, else why not. */
function mark(dataDir, marker) {
  try { writeFileAtomic(path.join(dataDir, FILE), JSON.stringify(marker, null, 2) + '\n'); return ''; } catch (e) { return e.code || e.message || 'EIO'; }
}

/** An error whose words are `words`. */
function said(words) {
  const err = new Error(words);
  err.words = words;
  return err;
}
/** An error whose words say what failed, and why (`e`'s code). */
function failed(words, e) { return said(words + ' (' + ((e && (e.code || e.message)) || 'EIO') + ')'); }

/**
 * Once this copy holds the folder, before anything else is written in it: the marker is read again here. Returns
 * {format, was (0 for a new folder), before (the build the marker named, '' when none), newer (that build newer than this
 * one by MAJOR.MINOR.BUILD: true, false, or null when no build is named or the two are not ordered), backup (the copy
 * kept at this start, '' when none), upgraded (the marker's build changed: a `server.upgraded` row)}; or throws with its
 * words. `reserve` is the free space the disk keeps beside a copy (the saves' and logs' room); `beat` is called at most
 * every BEAT_MS while a copy runs, so the watchdog never takes a long copy for a hang; `steps` is STEPS unless a test
 * stands in for them.
 */
function settle(dataDir, { build, now = Date.now(), steps = STEPS, reserve = 0, beat = () => {} }) {
  const found = read(dataDir);
  const why = refusal(found, { dataDir, build });
  if (why) throw said(why);
  const before = found.state === 'read' ? found.build : '';
  // Not newer than itself; neither newer nor older when no build is named, either is a local build, or both carry one number.
  const cmp = before && before !== build ? compareBuilds(before, build) : null;
  const newer = !before ? null : before === build ? false : cmp ? cmp > 0 : null;
  const out = { format: FORMAT, was: 0, before, newer, backup: '', upgraded: false };
  const named = before || 'a build its marker does not name';
  if (found.state === 'read' && found.format === FORMAT) {
    out.was = FORMAT;
    if (before === build) return out;
    const code = mark(dataDir, { format: FORMAT, build, at: now });
    if (code) throw failed('the data folder\'s marker ' + found.file + ' could not be written, so the folder would go on naming ' + named + ' as the build that last wrote it. Nothing in it was changed. Start AGMessage again once the marker can be written (another program, often an antivirus or a backup, may hold it)', { code });
    out.upgraded = true;
    return out;
  }
  let from;
  try { from = found.state === 'read' ? found.format : holdsData(dataDir) ? 1 : 0; } catch (e) {
    throw failed('the data folder ' + dataDir + ' could not be read through, so whether it holds a 0.5 folder to copy first cannot be told. Nothing in it was changed', e);
  }
  if (!from) {
    const code = mark(dataDir, { format: FORMAT, build, at: now });
    if (code) throw failed('the new data folder\'s marker ' + found.file + ' could not be written, so the folder would not say which build and format wrote it. No hall, account or setting was written in it. Start AGMessage again once the marker can be written (another program, often an antivirus or a backup, may hold it)', { code });
    return out;
  }
  out.was = from;
  // Paced on the steady clock, as the watchdog judges the beats: a wall clock stepped back during a long copy never holds
  // a beat back.
  let last = -Infinity;
  const tick = () => { const t = performance.now(); if (t - last >= BEAT_MS) { last = t; beat(); } };
  try {
    removePartials(dataDir);
    const need = sizeOf(dataDir);
    const free = freeOn(dataDir);
    if (free !== null && free < need + reserve) {
      throw said('the data folder ' + dataDir + ' is moved from format ' + from + ' to ' + FORMAT + ' only once a copy of it is kept, and its disk has ' + MB(free) + ' free: the copy needs ' + MB(need) + ', and ' + MB(reserve) + ' is kept free beside it for the saves and the logs. Nothing in the folder was changed. Free some space on that disk and start AGMessage again');
    }
    out.backup = copyFolder(dataDir, from, now, tick);
  } catch (e) {
    if (e.words) throw e;
    throw failed('the copy of the data folder ' + dataDir + ' that is kept before it is moved from format ' + from + ' to ' + FORMAT + ' could not be made in ' + path.join(dataDir, BACKUPS) + ', so nothing in the folder was changed. Free some space, or let this Windows account write there, and start AGMessage again', e);
  }
  for (let f = from; f < FORMAT; f++) {
    try { steps[f].run(dataDir); } catch (e) {
      throw failed('the data folder ' + dataDir + ' could not be moved from format ' + f + ' to ' + steps[f].to + ', and its marker is as it was, so the next start copies it and tries again. The folder as it was is kept in ' + path.join(dataDir, ...out.backup.split('/')), e);
    }
  }
  const code = mark(dataDir, { format: FORMAT, build, at: now, backup: out.backup });
  if (code) throw failed('the data folder ' + dataDir + ' was moved to format ' + FORMAT + ', and its marker ' + found.file + ' could not be written, so the next start copies it and tries again. The folder as it was is kept in ' + path.join(dataDir, ...out.backup.split('/')), { code });
  out.upgraded = true;
  return out;
}

/** The `server.upgraded` row's words for what `settle` did, or '' when the marker's build did not change (pure). */
function rowWords(now, build) {
  if (!now || !now.upgraded) return '';
  if (now.was !== now.format) {
    const from = now.before || (now.was === 1 ? 'a folder with no marker (format 1, as 0.5 and earlier leave it)' : 'a build its marker did not name');
    return 'from ' + from + ' to ' + build + ': the folder moved from format ' + now.was + ' to ' + now.format + ', and the folder as it was is kept in ' + now.backup;
  }
  const order = now.newer === true ? ', an older build than the one before it' : now.newer === false ? ', a newer build' : '';
  return 'from ' + (now.before || 'a build its marker did not name') + ' to ' + build + ' (format ' + now.format + order + ')';
}

module.exports = { FORMAT, FILE, BACKUPS, STEPS, BEAT_MS, read, refusal, settle, rowWords, holdsData };
