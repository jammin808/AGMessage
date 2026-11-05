'use strict';
/**
 * Which check an upload has before it is kept, and the refusal it answers: a type the stage can show whose first bytes
 * are a zip's has its archive read (lib/zipcheck.js), a picture its size (lib/imagesize.js), any other type none here; a
 * transfer-only type is never opened.
 *
 * Invariants:
 *   - Fail closed: a check that cannot finish (its file could not be read) refuses the file, never keeps it unread, and
 *     says so in words of its own, to the uploader (try again) and to the audit ("could not be checked"), never in the
 *     words of a check that found something.
 *   - A refusal is `{status, error, words, failed?}`: the answer's status, the uploader's words, the audit's words (never
 *     the file's name), and for a check that could not finish the code of what failed, for the console. No synchronous
 *     call, and nothing logged here.
 */
const zipcheck = require('./zipcheck');
const imagesize = require('./imagesize');
const { STAGE_TYPES, TRANSFER_ONLY } = require('./pages');

/** What the uploader is told when the check could not finish: the file is not kept, and sending it again may pass. */
const UNCHECKED = 'That file could not be checked, so it wasn\'t shared. Try sending it again.';

/** Each check by the types it reads. */
const CHECKS = Object.freeze([
  { types: zipcheck.ARCHIVES, words: zipcheck, run: (file) => zipcheck.checkFile(file) },
  { types: imagesize.IMAGES, words: imagesize, run: (file, ext) => imagesize.checkFile(file, ext) },
]);

/** The refusal of the stored upload at `file`, of type `ext` (its checked extension), or null when it may be kept. */
async function refusalOf(file, ext) {
  if (!STAGE_TYPES.includes(ext) || TRANSFER_ONLY.includes(ext)) return null;
  const check = CHECKS.find((c) => c.types.includes(ext));
  if (!check) return null;
  let verdict;
  try {
    verdict = await check.run(file, ext);
  } catch (e) {
    return { status: 503, error: UNCHECKED, words: check.words.auditWords(ext, { why: 'unchecked' }), failed: (e && e.code) || 'its read failed' };
  }
  return verdict.ok ? null : { status: 400, error: check.words.refusalWords(verdict), words: check.words.auditWords(ext, verdict) };
}

module.exports = { UNCHECKED, refusalOf };
