'use strict';
/**
 * An Office file's archive (docx, xlsx, pptx), checked before anyone opens it: its end record, its ZIP64 records and its
 * central directory are read and held to the bounds, and nothing is inflated. Pure over bytes: it is handed a source,
 * `{size, read(offset, length) → Promise<Uint8Array>}`, and asks it for the archive's last 98 bytes at most (its end
 * record and its ZIP64 records) and its central directory.
 *
 * One check, two callers: the server, which reads the file at upload (lib/zipcheck.js, through `fs.promises`), and the
 * page's document worker, which hands it the bytes it holds (`bytesSource`). Each gives it its own reader and nothing
 * else, so the verdicts cannot drift.
 *
 * Invariants:
 *   - A verdict is `{ok: true, entries, total, zip64}`, or `{ok: false, why, n?, bound?}` with `why` one of WHYS. Whatever
 *     this reader cannot read as a whole archive is refused ('shape'), never passed.
 *   - The directory checked is the one every reader of the file finds, so no reader is handed a part the check has not
 *     counted. The readers the pages open a file with (SheetJS's zip reader, and JSZip inside mammoth) take the last end
 *     record signature in the file, JSZip the last ZIP64 locator signature too, and JSZip reads a gap between where the
 *     directory's records end and where the end record sits as bytes before the archive, moving every offset by it. So:
 *     the end record ends the file, with no comment; no end record or locator signature follows the one chosen; the
 *     ZIP64 end record, of no extensible data, sits right before its locator; and an end record of an archive with ZIP64
 *     records marks a field as held there, as a reader of the end record alone looks for. Anything else is 'shape'.
 *   - The count of entries and the directory's size are held to their bounds before the directory is read: an archive
 *     that declares more is refused unread.
 *   - Every entry is held to its bounds as declared, its ZIP64 sizes alike: its size unpacked, its ratio, the declared
 *     total. A size the bytes cannot hold ('sizes': a stored entry whose two sizes differ, an entry whose data would run
 *     into the directory) is refused, as are an encrypted entry, two entries whose data overlap (one compressed stream
 *     read as many files), a missing `[Content_Types].xml` and a macro part (`vbaProject.bin`). An entry with two ZIP64
 *     fields is 'shape': this reader would take the first and JSZip takes the last.
 *   - A 64-bit number past what a double holds exactly reads as Infinity: over every bound, never wrapped.
 *
 * Loaded by Node (`require`), and as a classic script (the document worker's `importScripts`), where it is `AGMZip`.
 */
(function (scope) {
  const MB = 1024 * 1024;
  /**
   * Each a ceiling on one input, refused with words (lib/zipcheck.js): entries, the declared total unpacked, one entry
   * unpacked, an entry's ratio of unpacked to packed, and the central directory's size. Each sits at or above four times
   * the largest of the board-pack files measured for it, which test/zipcheck.test.js lists and holds.
   */
  const BOUNDS = Object.freeze({ entries: 2000, total: 200 * MB, entry: 100 * MB, ratio: 200, directory: 1 * MB });
  /** Why an archive is refused. */
  const WHYS = Object.freeze(['shape', 'entries', 'directory', 'sizes', 'encrypted', 'entry', 'ratio', 'total', 'overlap', 'macros', 'types']);

  const END = 0x06054b50;         // the end of central directory record
  const LOCATOR = 0x07064b50;     // the ZIP64 end of central directory locator
  const END64 = 0x06064b50;       // the ZIP64 end of central directory record
  const ENTRY = 0x02014b50;       // a central directory header
  const END_SIZE = 22;
  const LOCATOR_SIZE = 20;
  const END64_SIZE = 56;          // a ZIP64 end record of no extensible data: its own size field reads 44
  const TAIL = END64_SIZE + LOCATOR_SIZE + END_SIZE;   // the records an archive with no comment ends with
  const ENTRY_SIZE = 46;
  const LOCAL_SIZE = 30;          // a local header before its name and extra field
  const DESCRIPTOR_MIN = 12;      // a data descriptor at its shortest (no signature, 32-bit sizes)

  const refuse = (why, n, bound) => (n === undefined ? { ok: false, why } : { ok: false, why, n, bound });
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  /** A little-endian 64-bit number as a double: exact up to 2^53, Infinity past it. */
  const u64 = (v, at) => {
    const hi = v.getUint32(at + 4, true);
    return hi > 0x1fffff ? Infinity : hi * 0x100000000 + v.getUint32(at, true);
  };
  /** The last place in `v` where the signature `sig` starts, or -1: where a reader that searches backwards finds it. */
  const lastSignature = (v, sig) => {
    for (let p = v.byteLength - 4; p >= 0; p--) if (v.getUint32(p, true) === sig) return p;
    return -1;
  };
  /** The bytes a name holds, lower-cased as ASCII: Office's part names are ASCII, and OPC compares them without case. */
  const lowerAscii = (b) => {
    let s = '';
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      s += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 32 : c);
    }
    return s;
  };

  /** `length` bytes at `at` of the source, or null when the source holds fewer there. */
  async function readExactly(source, at, length) {
    if (!(at >= 0) || !(length >= 0) || at + length > source.size) return null;
    const b = await source.read(at, length);
    return b && b.length === length ? b : null;
  }

  /**
   * The archive's directory as its end records declare it: `{entries, size, offset, endsAt, zip64}`, `endsAt` where the
   * directory must end (its end record, or the ZIP64 one), or a refusal. The records are read from the archive's last 98
   * bytes, where every reader finds them (above). Where there are ZIP64 records, each field of the end record is either
   * its ZIP64 value or the mark that it is held there (all ones), and one at least is the mark; anything else is refused.
   */
  async function directoryOf(source) {
    const tailLength = Math.min(source.size, TAIL);
    const tailAt = source.size - tailLength;
    const tail = await readExactly(source, tailAt, tailLength);
    if (!tail) return refuse('shape');
    const v = view(tail);
    const p = tail.length - END_SIZE;
    if (v.getUint32(p, true) !== END || v.getUint16(p + 20, true) !== 0 || lastSignature(v, END) !== p) return refuse('shape');
    const small = { disk: v.getUint16(p + 4, true), dirDisk: v.getUint16(p + 6, true), here: v.getUint16(p + 8, true),
      entries: v.getUint16(p + 10, true), size: v.getUint32(p + 12, true), offset: v.getUint32(p + 16, true) };
    const marks = { disk: 0xffff, dirDisk: 0xffff, here: 0xffff, entries: 0xffff, size: 0xffffffff, offset: 0xffffffff };
    const marked = Object.keys(marks).some((k) => small[k] === marks[k]);
    const l = p - LOCATOR_SIZE;
    let d = small, endsAt = tailAt + p, zip64 = false;
    if (l >= 0 && v.getUint32(l, true) === LOCATOR) {
      const r = l - END64_SIZE;
      if (!marked || lastSignature(v, LOCATOR) !== l || v.getUint32(l + 4, true) !== 0 || v.getUint32(l + 16, true) !== 1) return refuse('shape');
      if (r < 0 || u64(v, l + 8) !== tailAt + r || v.getUint32(r, true) !== END64 || u64(v, r + 4) !== END64_SIZE - 12) return refuse('shape');
      const wide = { disk: v.getUint32(r + 16, true), dirDisk: v.getUint32(r + 20, true), here: u64(v, r + 24), entries: u64(v, r + 32), size: u64(v, r + 40), offset: u64(v, r + 48) };
      for (const k of Object.keys(marks)) if (small[k] !== marks[k] && small[k] !== wide[k]) return refuse('shape');
      d = wide;
      endsAt = tailAt + r;
      zip64 = true;
    } else if (marked) return refuse('shape');
    if (d.disk !== 0 || d.dirDisk !== 0 || d.here !== d.entries) return refuse('shape');
    return { entries: d.entries, size: d.size, offset: d.offset, endsAt, zip64 };
  }

  /**
   * The verdict on an archive: `source` is `{size, read(offset, length)}`, `bounds` BOUNDS unless a caller holds it to
   * others (a test's). The entries are walked in the directory's order; the first entry that breaks a rule decides.
   */
  async function check(source, bounds) {
    const b = bounds || BOUNDS;
    if (!source || !(source.size >= END_SIZE)) return refuse('shape');
    const d = await directoryOf(source);
    if (d.ok === false) return d;
    if (d.entries > b.entries) return refuse('entries', d.entries, b.entries);
    if (d.size > b.directory) return refuse('directory', d.size, b.directory);
    if (d.offset + d.size !== d.endsAt) return refuse('shape');
    const dir = await readExactly(source, d.offset, d.size);
    if (!dir) return refuse('shape');
    const v = view(dir);
    const ranges = [];
    let at = 0, total = 0, types = false, macros = false;
    while (at < dir.length) {
      if (at + ENTRY_SIZE > dir.length || v.getUint32(at, true) !== ENTRY) return refuse('shape');
      const flags = v.getUint16(at + 8, true);
      const method = v.getUint16(at + 10, true);
      let packed = v.getUint32(at + 20, true);
      let unpacked = v.getUint32(at + 24, true);
      const nameLength = v.getUint16(at + 28, true);
      const extraLength = v.getUint16(at + 30, true);
      const commentLength = v.getUint16(at + 32, true);
      let startDisk = v.getUint16(at + 34, true);
      let local = v.getUint32(at + 42, true);
      const nameAt = at + ENTRY_SIZE;
      const next = nameAt + nameLength + extraLength + commentLength;
      if (next > dir.length) return refuse('shape');
      if (unpacked === 0xffffffff || packed === 0xffffffff || local === 0xffffffff || startDisk === 0xffff) {
        // The ZIP64 extended information (header 0x0001), once: only the fields saturated above, in this order.
        let e = nameAt + nameLength;
        const extraEnd = e + extraLength;
        let wide = -1;
        while (e + 4 <= extraEnd) {
          const id = v.getUint16(e, true), length = v.getUint16(e + 2, true);
          if (e + 4 + length > extraEnd) return refuse('shape');
          if (id === 0x0001) {
            if (wide >= 0) return refuse('shape');
            wide = e;
          }
          e += 4 + length;
        }
        if (wide < 0) return refuse('shape');
        let f = wide + 4;
        const fieldsEnd = f + v.getUint16(wide + 2, true);
        const take64 = () => { if (f + 8 > fieldsEnd) return NaN; const n = u64(v, f); f += 8; return n; };
        if (unpacked === 0xffffffff) unpacked = take64();
        if (packed === 0xffffffff) packed = take64();
        if (local === 0xffffffff) local = take64();
        if (startDisk === 0xffff) { if (f + 4 > fieldsEnd) return refuse('shape'); startDisk = v.getUint32(f, true); }
        if (Number.isNaN(unpacked) || Number.isNaN(packed) || Number.isNaN(local)) return refuse('shape');
      }
      if ((flags & 0x0001) || (flags & 0x0040) || method === 99) return refuse('encrypted');
      if ((method !== 0 && method !== 8) || startDisk !== 0) return refuse('shape');
      if (method === 0 && packed !== unpacked) return refuse('sizes');
      if (unpacked > b.entry) return refuse('entry', unpacked, b.entry);
      const ratio = packed > 0 ? unpacked / packed : unpacked > 0 ? Infinity : 0;
      if (ratio > b.ratio) return refuse('ratio', ratio, b.ratio);
      total += unpacked;
      const name = lowerAscii(dir.subarray(nameAt, nameAt + nameLength));
      if (name === '[content_types].xml') types = true;
      if (name === 'vbaproject.bin' || name.endsWith('/vbaproject.bin')) macros = true;
      // The least the entry's local header, name and data take: its local extra field is not read, so the end is a floor.
      ranges.push({ from: local, to: local + LOCAL_SIZE + nameLength + packed + ((flags & 0x0008) ? DESCRIPTOR_MIN : 0) });
      at = next;
    }
    if (ranges.length !== d.entries) return refuse('shape');
    if (total > b.total) return refuse('total', total, b.total);
    ranges.sort((x, y) => x.from - y.from);
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i].to > d.offset) return refuse('sizes');
      if (i + 1 < ranges.length && ranges[i].to > ranges[i + 1].from) return refuse('overlap');
    }
    if (macros) return refuse('macros');
    if (!types) return refuse('types');
    return { ok: true, entries: d.entries, total, zip64: d.zip64 };
  }

  /** A source over bytes held whole (a Uint8Array or an ArrayBuffer): the document worker's reader. */
  function bytesSource(bytes) {
    const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return { size: all.length, read: (at, length) => Promise.resolve(all.subarray(at, at + length)) };
  }

  const api = Object.freeze({ BOUNDS, WHYS, check, bytesSource });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else scope.AGMZip = api;
})(globalThis);
