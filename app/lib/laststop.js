'use strict';
/**
 * The last stop, and what a stop cut short leaves behind (tested in test/laststop.test.js):
 *
 *   record   what a stop writes last, once it has saved the audit log, then every write lane, then each dirty hall:
 *            data/last-stop.json, {at, build, saved}, `saved` true only when every one of them was written, and when
 *            not, what was not (`unsaved`: a store's name, "the audit log", a count of halls; never a hall's code)
 *   take     at a start, once this copy holds its data folder: the record read by type, then moved aside to
 *            last-stop.seen.json (removed where it cannot be moved, and where it can be neither, kept as the one seen
 *            too, so the next start reads it as taken), so a crash or a kill after this start is never read as the stop
 *            before it; a stop that saved is `saved`, and a record missing, unread, already taken or not saying so is not
 *   judge    a record that says it saved, read against what the start found in the folder: a hall's log with lines, or
 *            a snapshot newer than the record, is something a copy did after that stop (a build that keeps no record, as
 *            0.5.1 is, then its end), so the record is `stale`, a stop that did not save: fail closed
 *   sweep    at a start, once this copy holds its data folder: each atomic write's temporary file (`<file>.<pid>.tmp`,
 *            lib/resilience.js writeFileAtomic) whose process is no longer running removed, as a stop the watchdog's kill
 *            cut short leaves one; a running process's, this one's included, is kept
 *
 * Only the copy that holds the folder takes the record or sweeps: a copy refused at the lock reads and removes nothing.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readText } = require('./resilience');

const FILE = 'last-stop.json';
const SEEN = 'last-stop.seen.json';

/** Write a stop's record into the data folder: {at, build, saved, unsaved?}. Throws when it cannot be written. */
function record(dir, { at, build, unsaved = [] }) {
  const rec = { at, build, saved: !unsaved.length, ...(unsaved.length ? { unsaved } : {}) };
  writeFileAtomic(path.join(dir, FILE), JSON.stringify(rec));
  return rec;
}

/**
 * A record as text, read by type (pure): {state, saved, at, build, unsaved, code}. `state` is 'saved' (the stop saved
 * everything, at the time it names), 'unsaved' (a stop that could not, with what it could not), 'none' (no record: the
 * copy before this start did not stop, or kept none) or 'unread' (a record that could not be read, or is not one, with
 * its code); `take` and `judge` add 'stale' (a record that says it saved, with why it is not the stop before this start).
 * Only 'saved' is `saved`.
 */
function readRecord(text, code = '') {
  const none = { saved: false, at: null, build: '', unsaved: [], code: '' };
  if (code === 'ENOENT') return { state: 'none', ...none };
  if (code) return { state: 'unread', ...none, code };
  let rec;
  try { rec = JSON.parse(text); } catch { return { state: 'unread', ...none, code: 'not JSON' }; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { state: 'unread', ...none, code: 'not a record' };
  const at = Number.isFinite(rec.at) ? rec.at : null;
  const build = typeof rec.build === 'string' ? rec.build.slice(0, 80) : '';
  const unsaved = Array.isArray(rec.unsaved) ? rec.unsaved.filter((w) => typeof w === 'string').slice(0, 20).map((w) => w.slice(0, 80)) : [];
  // A stop that saved is read against the folder by its time (`judge`): one that names none is not a record ours.
  if (rec.saved === true) return at === null ? { state: 'unread', ...none, code: 'not a record' } : { state: 'saved', saved: true, at, build, unsaved: [], code: '' };
  return { state: 'unsaved', saved: false, at, build, unsaved, code: '' };
}

/** A record that says it saved, read as one that is not the stop before this start, with why (pure). */
const stale = (said, why) => ({ ...said, state: 'stale', saved: false, code: why });

/**
 * At a start that holds the data folder: the record read, then moved aside to last-stop.seen.json, or removed where it
 * cannot be moved. One equal to the record seen (by its time and build) was taken by a start before this one, which could
 * neither move it nor remove it: it is `stale`. Returns what it said (readRecord's), with `left`: why the record is still
 * there ('' when it is not; the caller says so), where it is then also written as the one seen (a new file, which a hold
 * on the record does not stop), so the next start reads it as taken.
 */
function take(dir) {
  const file = path.join(dir, FILE);
  const seenFile = path.join(dir, SEEN);
  const r = readText(file);
  let said = readRecord(r.text, r.code);
  if (said.state === 'none') return { ...said, left: '' };
  if (said.saved) {
    const s = readText(seenFile);
    const seen = s.code ? null : readRecord(s.text);
    if (seen && seen.saved && seen.at === said.at && seen.build === said.build) said = stale(said, 'taken by an earlier start');
  }
  let left = '';
  try { fs.renameSync(file, seenFile); } catch {
    try { fs.unlinkSync(file); } catch (e) {
      left = e.code || 'EIO';
      if (said.saved) { try { writeFileAtomic(seenFile, r.text); } catch (w) { left += '; ' + SEEN + ' ' + (w.code || 'EIO'); } }
    }
  }
  return { ...said, left };
}

/**
 * A record read against what the start found in the folder (pure; `found`: lib/store.js's, {lines: the halls whose log
 * held lines, newest: the newest snapshot's savedAt}). A stop that saved leaves every hall's log empty and no snapshot
 * newer than itself, and nothing after its record writes a hall: a log with lines, or a newer snapshot, is what a copy did
 * after that stop and before this start (one that keeps no record, as 0.5.1, rolled back to, then a crash or a kill), so
 * the record is `stale`. A record that does not say it saved is returned as it was.
 */
function judge(said, { lines = 0, newest = 0 } = {}) {
  if (!said.saved) return said;
  if (lines > 0) return stale(said, (lines === 1 ? 'a hall\'s log' : lines + ' halls\' logs') + ' written after it');
  if (newest > said.at) return stale(said, 'a hall\'s snapshot written after it');
  return said;
}

/** The pid an atomic write's temporary file carries (`<file>.<pid>.tmp`), or 0 when the name is not one (pure). */
function tmpPid(name) {
  const m = /\.(\d{1,10})\.tmp$/.exec(name);
  const pid = m ? Number(m[1]) : 0;
  return pid > 0 ? pid : 0;
}

/** Whether a process with this pid is running: this one is, and so is one this account may not signal (EPERM). */
function running(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

/**
 * Remove, in each folder (not below it), every atomic write's temporary file whose process is not running. A folder that
 * is not there holds none. Returns {removed: [names], failed: [[name, code]]}.
 */
function sweep(dirs, { isRunning = running } = {}) {
  const removed = [];
  const failed = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') failed.push([dir, e.code || 'EIO']); }
    for (const e of entries) {
      const pid = e.isFile() ? tmpPid(e.name) : 0;
      if (!pid || isRunning(pid)) continue;
      try { fs.unlinkSync(path.join(dir, e.name)); removed.push(e.name); } catch (err) { if (err.code !== 'ENOENT') failed.push([e.name, err.code || 'EIO']); }
    }
  }
  return { removed, failed };
}

module.exports = { FILE, SEEN, record, readRecord, take, judge, tmpPid, running, sweep };
