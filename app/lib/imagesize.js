'use strict';
/**
 * An image's size in pixels, read from its header before anyone draws it: PNG's IHDR, GIF's logical screen and its first
 * frame (found by a walk over its blocks), WebP's VP8, VP8L or VP8X header, and JPEG's frame header (SOF0 to SOF15) found
 * by a walk over its segments' markers, each read at its offset. At upload an image over its bound, or one whose size
 * cannot be read, is refused with words.
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

/** The upload types that are pictures: each has its size read here before it is kept. */
const IMAGES = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** The most pixels an upload may hold: 100 megapixels. */
const PIXELS = 100 * 1000 * 1000;
/** A walk reads nothing past this offset: a JPEG's over its segments, a GIF's over its blocks. */
const REACH = 1024 * 1024;
/**
 * A JPEG's walk takes at most this many segments, its frame header among them; a GIF's this many blocks, its frame's
 * descriptor among them.
 */
const JPEG_SEGMENTS = 64;
const GIF_BLOCKS = 64;
/** A GIF's walk reads its blocks in windows of at most this many bytes. */
const GIF_WINDOW = 64 * 1024;

const TOO_LARGE = 'That image is too large to show.';
const UNREADABLE = 'That image cannot be read.';

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/** PNG: the signature, then IHDR first, 13 bytes long, its width and height big-endian. */
async function png(read) {
  const b = await read(0, 24);
  if (b.length < 24 || b.readUInt32BE(8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
/**
 * GIF: GIF87a or GIF89a, the logical screen's width and height (little-endian), then the walk past the global colour
 * table and each extension's sub-blocks to the first image descriptor, whose frame the screen is grown to hold.
 */
async function gif(read) {
  const head = await read(0, 13);
  if (head.length < 13 || !/^GIF8[79]a$/.test(ascii(head, 0, 6))) return null;
  let at = 13 + (head[10] & 0x80 ? 3 << ((head[10] & 7) + 1) : 0);
  let win = Buffer.alloc(0), winAt = 0;
  /** The byte at `at`, its window read from there when it is not held; -1 past the file's end or the reach. */
  const byteAt = async () => {
    if (at >= REACH) return -1;
    if (at < winAt || at >= winAt + win.length) {
      win = await read(at, Math.min(GIF_WINDOW, REACH - at));
      winAt = at;
    }
    return at - winAt < win.length ? win[at - winAt] : -1;
  };
  for (let block = 0; block < GIF_BLOCKS; block++) {
    const introducer = await byteAt();
    if (introducer === 0x2c) {
      if (at + 9 > REACH) return null;
      const d = await read(at + 1, 8);
      if (d.length < 8) return null;
      const [left, top, width, height] = [d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), d.readUInt16LE(6)];
      if (width === 0 || height === 0) return null;
      return { width: Math.max(head.readUInt16LE(6), left + width), height: Math.max(head.readUInt16LE(8), top + height) };
    }
    if (introducer !== 0x21) return null;   // the trailer, or no block a GIF holds, before any frame
    at += 2;                                  // the introducer and the extension's label
    // Its sub-blocks, each a length byte and that many bytes, to the one of length 0: hopped within the window held.
    for (;;) {
      if ((at < winAt || at >= winAt + win.length) && await byteAt() < 0) return null;
      const length = win[at - winAt];
      at += 1 + length;
      if (length === 0) break;
    }
  }
  return null;
}
/** WebP: a RIFF of WEBP whose first chunk is VP8 (a key frame's header), VP8L (its 14-bit sizes) or VP8X (the canvas). */
async function webp(read) {
  const b = await read(0, 30);
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if ((b[20] & 1) !== 0 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}
/** A JPEG frame header's marker: SOF0 to SOF15, which are C0 to CF but for DHT (C4), JPG (C8) and DAC (CC). */
const isFrame = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** JPEG: SOI, then segment by segment (each marker's length read at its offset) to the first frame header. */
async function jpeg(read) {
  const soi = await read(0, 2);
  if (soi.length < 2 || soi[0] !== 0xff || soi[1] !== 0xd8) return null;
  let at = 2;
  for (let segment = 0; segment < JPEG_SEGMENTS; segment++) {
    if (at + 9 > REACH) return null;
    const b = await read(at, 9);
    if (b.length < 4 || b[0] !== 0xff) return null;
    const marker = b[1];
    if (marker === 0xff) { at += 1; continue; }                      // a fill byte before the marker
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }   // no length of its own
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;   // a second start, the end or a scan before a frame
    const length = b.readUInt16BE(2);
    if (length < 2) return null;
    if (isFrame(marker)) return length >= 8 && b.length >= 9 ? { width: b.readUInt16BE(7), height: b.readUInt16BE(5) } : null;
    at += 2 + length;
  }
  return null;
}
const READERS = { png, gif, webp, jpg: jpeg, jpeg };

/**
 * The size of the image of type `ext` that `read(offset, length) → Promise<Buffer>` reads: `{width, height}`, or null
 * when it cannot be read (a type not of IMAGES included).
 */
async function sizeFrom(read, ext) {
  const reader = Object.hasOwn(READERS, ext) ? READERS[ext] : null;
  const size = reader ? await reader(read) : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

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
