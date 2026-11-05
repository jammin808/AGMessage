'use strict';
/**
 * An image's size in pixels, read from its header before anyone draws it, by the header reader the pages share
 * (public/imagecore.js: PNG's IHDR, GIF's logical screen and its first frame, WebP's VP8, VP8L or VP8X header, and
 * JPEG's frame header found by a walk over its segments' markers), here over the file read with `fs.promises` at each
 * offset. At upload an image over its bound, or one whose size cannot be read, is refused with words.
 *
 * Invariants:
 *   - Fail closed: a header this reader does not know, a size of 0, a walk that ends before a frame header (a JPEG's) or
 *     an image descriptor (a GIF's), or one past its bounds (64 segments or blocks, nothing read past the file's first
 *     megabyte) is "cannot be read", never passed.
 *   - A GIF is the size a browser decodes it at: its logical screen grown to hold its first frame, as Chromium's decoder
 *     and WebKit's grow it (a 1 × 1 screen does not hide a 20,000 × 20,000 frame); later frames are clipped to it.
 *   - Only headers are read, never pixels: a few bytes at the start; for a JPEG a few at each segment's offset, so a frame
 *     header after 80 KiB of metadata is found without reading the metadata; for a GIF its blocks before the first frame,
 *     read in windows. No synchronous call.
 *   - The audit's words name the type, the size in megapixels and the bound, never the file's name.
 */
const fs = require('fs');
const { REACH, JPEG_SEGMENTS, GIF_BLOCKS, GIF_WINDOW, sizeFrom } = require('../public/imagecore.js');

/** The upload types that are pictures: each has its size read here before it is kept. */
const IMAGES = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** The most pixels an upload may hold: 100 megapixels. */
const PIXELS = 100 * 1000 * 1000;

const TOO_LARGE = 'That image is too large to show.';
const UNREADABLE = 'That image cannot be read.';

/** `length` bytes of the open file `handle` at `at` (fewer at its end). */
async function readAt(handle, at, length) {
  const b = Buffer.alloc(length);
  const { bytesRead } = await handle.read(b, 0, length, at);
  return b.subarray(0, bytesRead);
}

/**
 * The verdict on the image at `file`, of type `ext`: `{ok: true, width, height, pixels}`, or `{ok: false, why}` with
 * `why` 'unreadable', or 'pixels' with `pixels` and `bound` (PIXELS unless a caller holds it to another).
 */
async function checkFile(file, ext, bound = PIXELS) {
  const handle = await fs.promises.open(file, 'r');
  let size;
  try {
    size = await sizeFrom((at, length) => readAt(handle, at, length), ext);
  } finally {
    await handle.close();
  }
  if (!size) return { ok: false, why: 'unreadable' };
  const pixels = size.width * size.height;
  return pixels > bound ? { ok: false, why: 'pixels', pixels, bound, width: size.width, height: size.height } : { ok: true, ...size, pixels };
}

/** Megapixels to one place, rounded up, so a size over its bound never reads as the bound. */
const megapixels = (n) => String(Math.ceil(n / 100000) / 10);
/** The uploader's words for a refused image. */
const refusalWords = (v) => (v.why === 'pixels' ? TOO_LARGE : UNREADABLE);
/** The audit row's words for a refused image of type `ext`, never its name. */
function auditWords(ext, v) {
  if (v.why === 'pixels') return 'a ' + ext + ' of ' + megapixels(v.pixels) + ' MP (bound ' + megapixels(v.bound) + ')';
  return 'a ' + ext + (v.why === 'unchecked' ? ' that could not be checked' : ' whose size cannot be read');
}

module.exports = { IMAGES, PIXELS, REACH, JPEG_SEGMENTS, GIF_BLOCKS, GIF_WINDOW, TOO_LARGE, UNREADABLE, sizeFrom, checkFile, refusalWords, auditWords };
