'use strict';
/**
 * Which check an upload has before it is kept, and the refusal it answers: a type the stage can show whose first bytes
 * are a zip's has its archive read (lib/zipcheck.js), a picture its size (lib/imagesize.js), any other type none here; a
 * transfer-only type is never opened.
 *
 * Invariants:
 *   - Fail closed: a check that cannot finish (its file could not be read, or is no file: a folder, which Windows opens
 *     and reads as empty) refuses the file, never keeps it unread, and says so in words of its own, to the uploader (try
 *     again) and to the audit ("could not be checked"), never in the words of a check that found something.
 *   - A refusal is `{status, error, words, failed?}`: the answer's status, the uploader's words, the audit's words (never
 *     the file's name), and for a check that could not finish the code of what failed, for the console. No synchronous
 *     call, and nothing logged here.
 *   - A transfer-only file is never opened (owner answer 18): a transfer type has its first bytes checked at upload and
 *     nothing more, and a Word, Excel or PowerPoint name whose first bytes are a compound file's is kept only when its
 *     directory holds an encrypted package (lib/cfbcheck.js). Whether a file is one (`transferOnlyFile`) is read from its
 *     first bytes, kept by its name, so a take and a screen read the same verdict, after a restart too.
 *   - A file shown on the stage is checked again at its take (`stageRefusalOf`), for what an upload does not hold it to:
 *     a picture the Board's devices draw holds at most STAGE_PIXELS, and a file that never had its check (one uploaded
 *     before the checks, or before a restart) has it then. What a check found is kept by the upload's name for the run
 *     (at most KEPT names, the oldest let go), so each file is read once: an upload's name is never given to another.
 */
const fs = require('node:fs');
const zipcheck = require('./zipcheck');
const imagesize = require('./imagesize');
const cfbcheck = require('./cfbcheck');
const { STAGE_TYPES, TRANSFER_ONLY, FOR_DOWNLOAD } = require('./pages');
const { PROTECTED_OFFICE, isCompoundFile } = require('./guard');

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
/** Whether each Word, Excel or PowerPoint upload is a protected one (transfer-only), by its name: at most KEPT names. */
const shapes = new Map();
function keep(map, name, value) {
  if (typeof name !== 'string' || !name) return;
  map.delete(name);
  map.set(name, value);
  if (map.size > KEPT) map.delete(map.keys().next().value);
}
const remember = (name, verdict) => keep(found, name, verdict);

/** Each check by the types it reads. */
const CHECKS = Object.freeze([
  { types: zipcheck.ARCHIVES, words: zipcheck, run: (file) => zipcheck.checkFile(file) },
  { types: imagesize.IMAGES, words: imagesize, run: (file, ext) => imagesize.checkFile(file, ext) },
]);

/** What an uploader is told of a file whose contents are not its type's: the words the first-bytes check answers with. */
const MISMATCH = 'That file\'s contents don\'t match its type, so it wasn\'t shared.';

/**
 * The refusal of the stored upload at `file`, of type `ext` (its checked extension), or null when it may be kept. What
 * the check found is kept by the upload's name (`name`) for its take. A transfer-only file (`transferOnly`: a transfer
 * type, or a Word, Excel or PowerPoint name whose first bytes are a compound file's) is never opened: a compound file is
 * kept only when lib/cfbcheck.js finds it protected with a password, and refused with the first-bytes words otherwise.
 */
async function refusalOf(file, ext, name = '', { transferOnly = false, compound = false } = {}) {
  if (compound) {
    let ok;
    try {
      ok = await cfbcheck.isProtectedOffice(file);
    } catch (e) {
      return { status: 503, error: UNCHECKED, words: 'a ' + ext + ' that could not be checked', failed: (e && e.code) || 'its read failed' };
    }
    if (ok) keep(shapes, name, true);
    return ok ? null : { status: 400, error: MISMATCH, words: 'a ' + ext + ' that is a compound file but no protected one' };
  }
  if (transferOnly || !STAGE_TYPES.includes(ext) || TRANSFER_ONLY.includes(ext)) return null;
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
  if (TRANSFER_ONLY.includes(ext)) return { error: FOR_DOWNLOAD };
  if (!STAGE_TYPES.includes(ext)) return null;
  try {
    if (await transferOnlyFile(file, ext, name)) return { error: FOR_DOWNLOAD };
  } catch (e) {
    return { error: STAGE_UNREAD, failed: (e && e.code) || 'its read failed' };
  }
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

/**
 * Whether the stored upload at `file` (named `name`, of type `ext`) is transfer-only: a transfer type by its extension, or
 * a Word, Excel or PowerPoint file whose first eight bytes are a compound file's (one the upload kept is protected with
 * a password, lib/cfbcheck.js). Read from the bytes, never a record, so the answer holds after a restart and for a room
 * not loaded; kept by the upload's name for the run, as the checks' verdicts are. Rejects when the file cannot be read.
 */
async function transferOnlyFile(file, ext, name = '') {
  if (TRANSFER_ONLY.includes(ext)) return true;
  if (!PROTECTED_OFFICE.includes(ext)) return false;
  if (shapes.has(name)) return shapes.get(name);
  const handle = await fs.promises.open(file, 'r');
  let head;
  try {
    head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const verdict = isCompoundFile(head);
  keep(shapes, name, verdict);
  return verdict;
}

module.exports = { UNCHECKED, MISMATCH, STAGE_PIXELS, STAGE_TOO_LARGE, STAGE_UNREAD, refusalOf, stageRefusalOf, transferOnlyFile };
