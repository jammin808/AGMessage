'use strict';
/**
 * A picture's size in pixels, read from its header before anything decodes it: PNG's IHDR, GIF's logical screen and its
 * first frame (found by a walk over its blocks), WebP's VP8, VP8L or VP8X header, and JPEG's frame header (SOF0 to SOF15)
 * found by a walk over its segments' markers, each read at its offset. Pure over the bytes it is handed: it is given a
 * reader, `read(offset, length) → Promise<Uint8Array>` (fewer bytes at the end), and asks it for headers only.
 *
 * One reader, three callers: the server at upload and at a take (lib/imagesize.js, through `fs.promises`), the page's
 * document worker for a picture inside a Word file or a deck, and the page itself for a picture it draws (docview.mjs,
 * over the bytes it fetched). Each gives it its own reader and nothing else, so the sizes cannot drift.
 *
 * Invariants:
 *   - Fail closed: a header this reader does not know, a size of 0, a walk that ends before a frame header (a JPEG's) or
 *     an image descriptor (a GIF's), or one past its bounds (64 segments or blocks, nothing read past the first
 *     megabyte) is "cannot be read" (null), never a size.
 *   - A GIF is the size a browser decodes it at: its logical screen grown to hold its first frame, as Chromium's decoder
 *     and WebKit's grow it (a 1 × 1 screen does not hide a 20,000 × 20,000 frame); later frames are clipped to it.
 *   - Only headers are read, never pixels: a few bytes at the start; for a JPEG a few at each segment's offset, so a
 *     frame header after 80 KiB of metadata is found without reading the metadata; for a GIF its blocks before the first
 *     frame, read in windows.
 *   - `sniff` names a picture by its first bytes, as a browser's decoder does, never by its name or declared type: a
 *     picture is sized by the reader of the type it will be decoded as.
 *
 * Loaded by Node (`require`), and as a classic script (the document worker's `importScripts`; docview.mjs loads it for
 * its side effect), where it is `AGMImage`.
 */
(function (scope) {
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

  const ascii = (b, at, n) => { let s = ''; for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const u16le = (b, at) => b[at] | (b[at + 1] << 8);
  const u16be = (b, at) => (b[at] << 8) | b[at + 1];
  const u24le = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
  const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

  /** PNG: the signature, then IHDR first, 13 bytes long, its width and height big-endian. */
  async function png(read) {
    const b = await read(0, 24);
    if (b.length < 24 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  /**
   * GIF: GIF87a or GIF89a, the logical screen's width and height (little-endian), then the walk past the global colour
   * table and each extension's sub-blocks to the first image descriptor, whose frame the screen is grown to hold.
   */
  async function gif(read) {
    const head = await read(0, 13);
    if (head.length < 13 || !/^GIF8[79]a$/.test(ascii(head, 0, 6))) return null;
    let at = 13 + (head[10] & 0x80 ? 3 << ((head[10] & 7) + 1) : 0);
    let win = new Uint8Array(0), winAt = 0;
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
        const [left, top, width, height] = [u16le(d, 0), u16le(d, 2), u16le(d, 4), u16le(d, 6)];
        if (width === 0 || height === 0) return null;
        return { width: Math.max(u16le(head, 6), left + width), height: Math.max(u16le(head, 8), top + height) };
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
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const bits = u32le(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
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
      const length = u16be(b, 2);
      if (length < 2) return null;
      if (isFrame(marker)) return length >= 8 && b.length >= 9 ? { width: u16be(b, 7), height: u16be(b, 5) } : null;
      at += 2 + length;
    }
    return null;
  }
  const READERS = { png, gif, webp, jpg: jpeg, jpeg };

  /**
   * The size of the picture of type `ext` that `read` reads: `{width, height}`, or null when it cannot be read (a type
   * not of these readers' included).
   */
  async function sizeFrom(read, ext) {
    const reader = Object.prototype.hasOwnProperty.call(READERS, ext) ? READERS[ext] : null;
    const size = reader ? await reader(read) : null;
    return size && size.width > 0 && size.height > 0 ? size : null;
  }

  /** The type a browser decodes `bytes` as, by their first bytes: 'png', 'jpg', 'gif' or 'webp', or '' for any other. */
  function sniff(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'gif';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    return '';
  }

  /** The size of a picture held whole, by the type its bytes say: `{type, width, height}`, or null. */
  async function sizeOf(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const type = sniff(b);
    const size = type ? await sizeFrom((at, length) => Promise.resolve(b.subarray(at, at + length)), type) : null;
    return size ? { type, width: size.width, height: size.height } : null;
  }

  const api = Object.freeze({ REACH, JPEG_SEGMENTS, GIF_BLOCKS, GIF_WINDOW, sizeFrom, sniff, sizeOf });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else scope.AGMImage = api;
})(globalThis);
