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
 *     fields is 'shape': this reader would take the first and JSZip takes the last. So is an entry with a Unicode Path
 *     field (Info-ZIP's 0x7075), a second name JSZip reads in place of the one checked.
 *   - A 64-bit number past what a double holds exactly reads as Infinity: over every bound, never wrapped.
 *
 * The document worker also lists the entries of an archive the check passed (`entries`), to inflate the parts it reads,
 * and repacks it (`repack`): every entry's local header, compressed bytes and data descriptor copied as they are, the
 * parts it replaces written stored with their CRC-32, and a new central directory after them, so a reader handed the
 * copy (mammoth) sees the replaced parts and nothing else changed. Both refuse what the check refuses.
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
  const UNICODE_PATH = 0x7075;    // Info-ZIP's Unicode Path extra field: another name for the entry

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
    const r = await read(source, bounds);
    return r.ok === false ? r : r.verdict;
  }

  /**
   * The archive's entries, once it passes the check: `{ok: true, list, offset}`, each `{name, raw, flags, method, crc,
   * packed, unpacked, local, time, date, wide, external}` (`raw` the name's bytes, `wide` whether its sizes were ZIP64's,
   * `external` its external attributes, whose bit 4 a reader takes for a folder), in the
   * directory's order, and where the central directory starts (`stored` reads an entry's data before it); or the
   * check's refusal.
   */
  async function entries(source, bounds) {
    const r = await read(source, bounds);
    return r.ok === false ? r : { ok: true, list: r.list, offset: r.offset };
  }

  /** The check, and the entries it read: `{verdict, list, offset}` or a refusal. */
  async function read(source, bounds) {
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
    const list = [];
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
      const wide = unpacked === 0xffffffff || packed === 0xffffffff;
      const nameAt = at + ENTRY_SIZE;
      const next = nameAt + nameLength + extraLength + commentLength;
      if (next > dir.length) return refuse('shape');
      // A reader that names an entry by its Info-ZIP Unicode Path field (JSZip, inside mammoth, where the name is not
      // marked UTF-8) would find a part under a name this check never read: such an entry is refused.
      for (let e = nameAt + nameLength, extraEnd = e + extraLength; e + 4 <= extraEnd; e += 4 + v.getUint16(e + 2, true)) {
        if (v.getUint16(e, true) === UNICODE_PATH) return refuse('shape');
      }
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
      const raw = dir.slice(nameAt, nameAt + nameLength);
      const name = lowerAscii(raw);
      if (name === '[content_types].xml') types = true;
      if (name === 'vbaproject.bin' || name.endsWith('/vbaproject.bin')) macros = true;
      list.push({ name: utf8(raw), raw, flags, method, crc: v.getUint32(at + 16, true), packed, unpacked, local,
        time: v.getUint16(at + 12, true), date: v.getUint16(at + 14, true), wide, external: v.getUint32(at + 38, true) });
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
    return { verdict: { ok: true, entries: d.entries, total, zip64: d.zip64 }, list, offset: d.offset };
  }

  /** A name's bytes as text: UTF-8, as Office writes its part names (ASCII), a sequence that is not UTF-8 as U+FFFD. */
  function utf8(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      const n = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1;
      let cp = n === 0 ? b : n === 1 ? b & 0x1f : n === 2 ? b & 0x0f : b & 0x07;
      let k = 1;
      while (k <= n && i + k < bytes.length && (bytes[i + k] & 0xc0) === 0x80) { cp = (cp << 6) | (bytes[i + k] & 0x3f); k++; }
      const whole = n >= 0 && k === n + 1 && !(n === 2 && cp < 0x800) && !(n === 3 && (cp < 0x10000 || cp > 0x10ffff)) && !(cp >= 0xd800 && cp < 0xe000);
      s += whole ? String.fromCodePoint(cp) : '\ufffd';
      i += whole ? n + 1 : Math.max(1, k);
    }
    return s;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  /** The CRC-32 of `bytes` (ISO 3309, as a zip records it). */
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Where an entry's local header starts and its data begins and ends in `all`, with its data descriptor's length:
   * `{from, data, to}` (`to` past the descriptor), or null where the local header is not where the directory says, or
   * its data would run past `limit` (the central directory).
   */
  function located(all, e, limit) {
    if (e.local + LOCAL_SIZE > limit) return null;
    const v = new DataView(all.buffer, all.byteOffset + e.local, LOCAL_SIZE);
    if (v.getUint32(0, true) !== 0x04034b50) return null;
    const data = e.local + LOCAL_SIZE + v.getUint16(26, true) + v.getUint16(28, true);
    let to = data + e.packed;
    if (e.flags & 0x0008) {
      const signed = to + 4 <= limit && new DataView(all.buffer, all.byteOffset + to, 4).getUint32(0, true) === 0x08074b50;
      to += (signed ? 4 : 0) + 4 + (e.wide ? 16 : 8);
    }
    return to > limit ? null : { from: e.local, data, to };
  }

  /** An entry's data as it is stored (compressed or not), from bytes held whole, or null where it cannot be found. */
  function stored(bytes, e, offset) {
    const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const at = located(all, e, offset);
    return at ? all.subarray(at.data, at.data + e.packed) : null;
  }

  /**
   * A copy of the archive in `bytes` with each part named in `replaced` ({name: Uint8Array}) written in its place,
   * stored: `{ok: true, bytes}`, or the check's refusal ('shape' where a local header is not where the directory says).
   * Every other entry's local header, data and data descriptor are copied as they are, in their order; a new central
   * directory and end record follow, with no ZIP64 records and no comment.
   */
  async function repack(bytes, replaced) {
    const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const r = await read(bytesSource(all));
    if (r.ok === false) return r;
    const swap = replaced || {};
    const pieces = [];
    const central = [];
    let offset = 0;
    for (const e of r.list) {
      const at = located(all, e, r.offset);
      if (!at) return refuse('shape');
      const own = Object.prototype.hasOwnProperty.call(swap, e.name) ? swap[e.name] : null;
      const entry = own
        ? { flags: e.flags & 0x0800, method: 0, crc: crc32(own), packed: own.length, unpacked: own.length }
        : { flags: e.flags, method: e.method, crc: e.crc, packed: e.packed, unpacked: e.unpacked };
      if (own) {
        const head = new Uint8Array(LOCAL_SIZE);
        const h = new DataView(head.buffer);
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, entry.flags, true); h.setUint16(8, 0, true);
        h.setUint16(10, e.time, true); h.setUint16(12, e.date, true); h.setUint32(14, entry.crc, true);
        h.setUint32(18, own.length, true); h.setUint32(22, own.length, true); h.setUint16(26, e.raw.length, true);
        pieces.push(head, e.raw, own);
      } else pieces.push(all.subarray(at.from, at.to));
      const rec = new Uint8Array(ENTRY_SIZE);
      const c = new DataView(rec.buffer);
      c.setUint32(0, ENTRY, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, entry.flags, true);
      c.setUint16(10, entry.method, true); c.setUint16(12, e.time, true); c.setUint16(14, e.date, true); c.setUint32(16, entry.crc, true);
      c.setUint32(20, entry.packed, true); c.setUint32(24, entry.unpacked, true); c.setUint16(28, e.raw.length, true);
      c.setUint32(42, offset, true);
      central.push(rec, e.raw);
      offset += own ? LOCAL_SIZE + e.raw.length + own.length : at.to - at.from;
    }
    const dirSize = central.reduce((n, p) => n + p.length, 0);
    const end = new Uint8Array(END_SIZE);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, END, true); ev.setUint16(8, r.list.length, true); ev.setUint16(10, r.list.length, true);
    ev.setUint32(12, dirSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + dirSize + END_SIZE);
    let w = 0;
    for (const p of [...pieces, ...central, end]) { out.set(p, w); w += p.length; }
    return { ok: true, bytes: out };
  }

  /** A source over bytes held whole (a Uint8Array or an ArrayBuffer): the document worker's reader. */
  function bytesSource(bytes) {
    const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return { size: all.length, read: (at, length) => Promise.resolve(all.subarray(at, at + length)) };
  }

  const api = Object.freeze({ BOUNDS, WHYS, check, entries, stored, repack, crc32, bytesSource });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else scope.AGMZip = api;
})(globalThis);
