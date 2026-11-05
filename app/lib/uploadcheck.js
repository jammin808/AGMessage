'use strict';
/**
 * Which check an upload has before it is kept, and the refusal it answers: a type the stage can show whose first bytes
 * are a zip's has its archive read (lib/zipcheck.js), a picture its size (lib/imagesize.js), any other type none here; a
 * transfer-only type is never opened.
 *
 * Invariants:
 *   - Fail closed: a check that cannot finish (its file could not be read, or is no file: a folder, which Windows opens
 *     and reads as empty) refuses the file, never keeps it unread, and says so in words of its own, to the uploader (try again) and to the audit ("could not be checked"), never in the
 *     words of a check that found something.
 *   - A refusal is `{status, error, words, failed?}`: the answer's status, the uploader's words, the audit's words (never
 *     the file's name), and for a check that could not finish the code of what failed, for the console. No synchronous
 *     call, and nothing logged here.
 *   - A file shown on the stage is checked again at its take (`stageRefusalOf`), for what an upload does not hold it to:
 *     a picture the Board's devices draw holds at most STAGE_PIXELS, and a file that never had its check (one uploaded
 *     before the checks, or before a restart) has it then. What a check found is kept by the upload's name for the run
 *     (at most KEPT names, the oldest let go), so each file is read once: an upload's name is never given to another.
 */
const fs = require('node:fs');
const zipcheck = require('./zipcheck');
const imagesize = require('./imagesize');
const { STAGE_TYPES, TRANSFER_ONLY } = require('./pages');

/** What the uploader is told when the check could not finish: the file is not kept, and sending it again may pass. */
const UNCHECKED = 'That file could not be checked, so it wasn\'t shared. Try sending it again.';
/**
 * The most pixels a picture shown on the stage may hold: what the Board's oldest devices are taken to decode, provisional
 * until it is measured on the device matrix's oldest rows (plan 4-§5.10.3).
 */
const STAGE_PIXELS = 40 * 1000 * 1000;
const STAGE_TOO_LARGE = 'Too large for the Board\'s devices — send a region.';
/** What a pusher is told when the file a take would show could not be read at its take: nothing is shown. */
const STAGE_UNREAD = 'That file could not be read, so it was not shown.';
/** What each upload's check found this run, by its name (a verdict, a picture's pixels with it): at most KEPT names. */
const KEPT = 2000;
const found = new Map();
function remember(name, verdict) {
  if (typeof name !== 'string' || !name) return;
  found.delete(name);
  found.set(name, verdict);
  if (found.size > KEPT) found.delete(found.keys().next().value);
}

/** Each check by the types it reads. */
const CHECKS = Object.freeze([
  { types: zipcheck.ARCHIVES, words: zipcheck, run: (file) => zipcheck.checkFile(file) },
  { types: imagesize.IMAGES, words: imagesize, run: (file, ext) => imagesize.checkFile(file, ext) },
]);

/**
 * The refusal of the stored upload at `file`, of type `ext` (its checked extension), or null when it may be kept. What
 * the check found is kept by the upload's name (`name`) for its take.
 */
async function refusalOf(file, ext, name = '') {
  if (!STAGE_TYPES.includes(ext) || TRANSFER_ONLY.includes(ext)) return null;
  const check = CHECKS.find((c) => c.types.includes(ext));
  if (!check) return null;
  let verdict;
  try {
    const kind = await fs.promises.stat(file);
    if (!kind.isFile()) throw Object.assign(new Error('not a file'), { code: kind.isDirectory() ? 'EISDIR' : 'ENOTFILE' });
    verdict = await check.run(file, ext);
  } catch (e) {
    return { status: 503, error: UNCHECKED, words: check.words.auditWords(ext, { why: 'unchecked' }), failed: (e && e.code) || 'its read failed' };
  }
  if (verdict.ok) remember(name, verdict);
  return verdict.ok ? null : { status: 400, error: check.words.refusalWords(verdict), words: check.words.auditWords(ext, verdict) };
}

/**
 * Why the upload at `file` (named `name`, of type `ext`) may not be shown on the stage, in words ({error, failed?}), or
 * null when it may: its check as at upload, run now where this run has none on record for it (and kept), and a picture
 * held to STAGE_PIXELS. A file that cannot be read now is not shown.
 */
async function stageRefusalOf(file, ext, name) {
  if (!STAGE_TYPES.includes(ext) || TRANSFER_ONLY.includes(ext)) return null;
  const check = CHECKS.find((c) => c.types.includes(ext));
  if (!check) return null;
  let verdict = found.get(name);
  if (!verdict) {
    try {
      verdict = await check.run(file, ext);
    } catch (e) {
      return { error: STAGE_UNREAD, failed: (e && e.code) || 'its read failed' };
    }
    if (verdict.ok) remember(name, verdict);
  }
  if (verdict.why === 'pixels' || (verdict.ok && verdict.pixels > STAGE_PIXELS)) return { error: STAGE_TOO_LARGE };
  return verdict.ok ? null : { error: check.words.refusalWords(verdict) };
}

module.exports = { UNCHECKED, STAGE_PIXELS, STAGE_TOO_LARGE, STAGE_UNREAD, refusalOf, stageRefusalOf };
