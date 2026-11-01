'use strict';
/**
 * A zip written as it streams, for the audit log's export (lib/auditexport.js): each member deflated as it passes, its
 * CRC-32 and sizes in a data descriptor after it (general purpose bit 3, APPNOTE 4.3.9), then the central directory and
 * its end record. Nothing is held whole to start a member, and no temporary file is written.
 *
 * Invariants:
 *   - No offset, size or count passes what a zip without Zip64 can hold (4 GB, 65,535 members): a zip that would is
 *     refused before its first byte (`fits`), and a member that grows past it ends the zip with an error.
 *   - Every byte goes out through `out` with its backpressure, and is counted into the zip's own SHA-256 as it goes. A
 *     destination that closes before the end ends the zip with an error whose `gone` is true.
 *   - No synchronous file call: deflate runs on the thread pool; CRC-32 and the digest on the event loop, chunk by chunk.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const LIMIT = 0xFFFFFFFF;
const MAX_MEMBERS = 0xFFFF;
const LEVEL = 6;

/** Whether `bytes` of members, `members` of them, fit a zip without Zip64, with room for their headers and deflate's worst case. */
function fits(bytes, members) {
  return members <= MAX_MEMBERS && bytes + Math.ceil(bytes / 1000) * 5 + members * 1024 + 65536 < LIMIT;
}

/** A local time as MS-DOS writes it in a zip: {time, date}. */
function dosTime(at) {
  const d = new Date(at);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const gone = () => Object.assign(new Error('the browser went away'), { gone: true });

/** Wait until `out` can take more, or say it went: 'drain', or 'close' / 'error' first. */
function drained(out) {
  return new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain); out.off('close', onClose); out.off('error', onError);
      if (err) reject(err); else resolve();
    };
    const onDrain = () => done(null);
    const onClose = () => done(gone());
    const onError = (e) => done(Object.assign(e instanceof Error ? e : new Error(String(e)), { gone: true }));
    out.on('drain', onDrain); out.on('close', onClose); out.on('error', onError);
    if (out.destroyed) done(gone());
  });
}

class ZipStream {
  /** @param out a writable (an HTTP response) @param o `at`: the members' time (ms) */
  constructor(out, { at = Date.now() } = {}) {
    this.out = out;
    this.dos = dosTime(at);
    this.offset = 0;
    this.members = [];
    this.hash = crypto.createHash('sha256');
    this.ended = false;
  }

  /** Bytes out, counted and hashed, as fast as the destination takes them. */
  async _write(buf) {
    if (this.out.destroyed || this.out.writableEnded) throw gone();
    if (this.offset + buf.length > LIMIT) throw new Error('the zip would pass 4 GB, and no Zip64 is written');
    this.hash.update(buf);
    this.offset += buf.length;
    if (!this.out.write(buf)) await drained(this.out);
  }

  /**
   * One member: `name` (a path inside the zip, ASCII) and `chunks` (an iterable or async iterable of Buffers), deflated as
   * they pass. `onChunk(buf)` sees each uncompressed chunk (a digest taken on the way). Resolves {crc, size, csize}.
   */
  async add(name, chunks, { onChunk } = {}) {
    if (this.ended) throw new Error('the zip has ended');
    if (this.members.length >= MAX_MEMBERS) throw new Error('the zip would hold more than 65,535 members');
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);             // version needed: 2.0 (deflate)
    head.writeUInt16LE(0x0008, 6);         // bit 3: the CRC and sizes follow the data
    head.writeUInt16LE(8, 8);              // deflate
    head.writeUInt16LE(this.dos.time, 10);
    head.writeUInt16LE(this.dos.date, 12);
    head.writeUInt16LE(nameBuf.length, 26);
    await this._write(Buffer.concat([head, nameBuf]));
    let crc = 0;
    let size = 0;
    let csize = 0;
    const deflate = zlib.createDeflateRaw({ level: LEVEL });
    const stopped = () => new Error('the member was not finished');
    /** Until deflate takes more: 'drain', or its end ('error', 'close') when the other side failed first. */
    const roomIn = () => new Promise((resolve, reject) => {
      const off = () => { deflate.off('drain', ok); deflate.off('error', bad); deflate.off('close', bad); };
      const ok = () => { off(); resolve(); };
      const bad = (e) => { off(); reject(e instanceof Error ? e : stopped()); };
      deflate.on('drain', ok); deflate.on('error', bad); deflate.on('close', bad);
    });
    // The source is fed in while the deflated bytes are taken out, so neither side waits on the other for ever.
    const feed = (async () => {
      for await (const c of chunks) {
        if (deflate.destroyed) throw stopped();
        crc = zlib.crc32(c, crc);
        size += c.length;
        if (size > LIMIT) throw new Error('a member would pass 4 GB, and no Zip64 is written');
        if (onChunk) onChunk(c);
        if (!deflate.write(c)) await roomIn();
      }
      deflate.end();
    })();
    feed.catch((e) => { deflate.destroy(e); });
    try {
      for await (const d of deflate) { csize += d.length; await this._write(d); }
      await feed;
    } catch (e) {
      deflate.destroy();
      const first = await feed.then(() => null, (x) => x);
      throw first && first !== e && !e.gone ? first : e;   // the source's own failure, when it came first, is the one said
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(csize, 8);
    desc.writeUInt32LE(size, 12);
    await this._write(desc);
    this.members.push({ name: nameBuf, crc: crc >>> 0, size, csize, offset });
    return { crc: crc >>> 0, size, csize };
  }

  /** The central directory and its end record. Resolves {bytes, sha256}: the zip's whole length and its SHA-256. */
  async end() {
    if (this.ended) throw new Error('the zip has ended');
    this.ended = true;
    const start = this.offset;
    for (const m of this.members) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);              // made by: 2.0, MS-DOS attributes
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0008, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(this.dos.time, 12);
      c.writeUInt16LE(this.dos.date, 14);
      c.writeUInt32LE(m.crc, 16);
      c.writeUInt32LE(m.csize, 20);
      c.writeUInt32LE(m.size, 24);
      c.writeUInt16LE(m.name.length, 28);
      c.writeUInt32LE(m.offset, 42);
      await this._write(Buffer.concat([c, m.name]));
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(this.members.length, 8);
    e.writeUInt16LE(this.members.length, 10);
    e.writeUInt32LE(this.offset - start, 12);
    e.writeUInt32LE(start, 16);
    await this._write(e);
    return { bytes: this.offset, sha256: this.hash.digest('hex') };
  }
}

module.exports = { ZipStream, fits, dosTime };
