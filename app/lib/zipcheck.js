'use strict';
/**
 * The archive check at upload: a docx, xlsx or pptx is read by public/zipcore.js (its end records and its central
 * directory, nothing inflated) through `fs.promises` before anyone opens it, and refused with words when it breaks a
 * bound or carries a macro part.
 *
 * Invariants:
 *   - The check is zipcore's, the page's document worker's too: this file only hands it a reader of the stored file, and
 *     words for what it found. No synchronous call; the file is opened once and closed whatever the verdict.
 *   - The words to the uploader say what to do; the audit's words say what was refused and by which bound, never the
 *     file's name.
 */
const fs = require('fs');
const zipcore = require('../public/zipcore.js');

/** The upload types whose first bytes are a zip's and which the stage can show: each is checked here before it is kept. */
const ARCHIVES = Object.freeze(['docx', 'xlsx', 'pptx']);

/** What the uploader is told: a macro part's own words, and one line for every other refusal. */
const MACROS = 'That file carries macros. Save it without them, or as a PDF.';
const PACKED = 'That file is packed in a way AGMessage will not open. Share it as a PDF.';
const refusalWords = (verdict) => (verdict.why === 'macros' ? MACROS : PACKED);

/** A whole number `n` with its thousands grouped by commas, the same on every machine. */
function grouped(n) {
  const s = String(Math.round(n));
  let out = '';
  for (let i = 0; i < s.length; i++) out += (i > 0 && (s.length - i) % 3 === 0 ? ',' : '') + s[i];
  return out;
}
const MB = 1024 * 1024;
/** A size in whole megabytes, rounded up (so a size over a bound never reads as the bound); a 64-bit size past 2^53 as that. */
const megabytes = (n) => (n === Infinity ? 'at least 8,589,934,592 MB' : grouped(Math.ceil(n / MB)) + ' MB');
const ratioWords = (n) => (n === Infinity ? 'from nothing' : grouped(Math.ceil(n)) + ':1');

/** The audit row's words for a refused archive of type `ext`: what was found and the bound it broke, never a name. */
function auditWords(ext, v) {
  const a = (ext === 'xlsx' ? 'an ' : 'a ') + ext;
  switch (v.why) {
    case 'entries': return a + ': ' + grouped(v.n) + ' parts (bound ' + grouped(v.bound) + ')';
    case 'directory': return a + ': a directory of ' + megabytes(v.n) + ' (bound ' + megabytes(v.bound) + ')';
    case 'total': return a + ': ' + megabytes(v.n) + ' unpacked (bound ' + megabytes(v.bound) + ')';
    case 'entry': return a + ': a part of ' + megabytes(v.n) + ' unpacked (bound ' + megabytes(v.bound) + ')';
    case 'ratio': return a + ': a part packed ' + ratioWords(v.n) + ' (bound ' + ratioWords(v.bound) + ')';
    case 'encrypted': return a + ' with an encrypted part';
    case 'overlap': return a + ' whose parts overlap';
    case 'sizes': return a + ' whose sizes cannot be true';
    case 'macros': return a + ' with macros';
    case 'types': return a + ' without [Content_Types].xml';
    case 'unchecked': return a + ' that could not be checked';
    default: return a + ' packed in a way AGMessage does not read';
  }
}

/** `length` bytes of the open file `handle` at `at` (fewer at its end). */
async function readAt(handle, at, length) {
  const b = Buffer.alloc(length);
  const { bytesRead } = await handle.read(b, 0, length, at);
  return b.subarray(0, bytesRead);
}

/** zipcore's verdict on the file at `file`, read through `fs.promises`; `bounds` zipcore's unless a test gives others. */
async function checkFile(file, bounds) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    return await zipcore.check({ size, read: (at, length) => readAt(handle, at, length) }, bounds);
  } finally {
    await handle.close();
  }
}

module.exports = { ARCHIVES, BOUNDS: zipcore.BOUNDS, MACROS, PACKED, checkFile, refusalWords, auditWords, grouped };
