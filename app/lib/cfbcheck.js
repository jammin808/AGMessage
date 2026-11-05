'use strict';
/**
 * Whether a compound file ([MS-CFB]) named as a Word, Excel or PowerPoint file is one protected with a password: its
 * directory holds the encrypted package's two streams, `EncryptionInfo` and `EncryptedPackage` ([MS-OFFCRYPTO]), and
 * none of the streams or storages a Word 97 document, a workbook, a presentation or a macro project is made of. The
 * header alone would admit any compound file: a Word 97 `.doc` with an AutoOpen macro renamed `Agenda.docx` would pass as
 * "download only". A file that passes is transfer-only: AGMessage never opens it, and serves it only through a download
 * ticket.
 *
 * Invariants:
 *   - Fail closed: a header that is not a compound file's, a sector size other than 512 or 4096 bytes, a chain that points
 *     past the file, loops or ends early, and a directory that cannot be read within BUDGET bytes in all are each "not
 *     protected", never passed.
 *   - Only what the directory needs is read, through `fs.promises` at each offset: the header, the FAT sectors (and the
 *     DIFAT sectors past the header's 109) the directory's chain is found through, and the directory's sectors; never a
 *     stream's contents. At most BUDGET bytes are read in all. No synchronous call.
 *   - Names are compared as the format orders them, without regard to case.
 */
const fs = require('fs');

/** The most bytes the check reads of one file: its header, its FAT and DIFAT sectors and its directory, together. */
const BUDGET = 64 * 1024;
/** What a compound file starts with ([MS-CFB] §2.2). */
const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** A chain's end, and the sector numbers that are no sector ([MS-CFB] §2.1). */
const END = 0xfffffffe;
const MAXSECT = 0xfffffffa;
/** The streams an encrypted package holds: both are needed. */
const NEEDED = Object.freeze(['encryptioninfo', 'encryptedpackage']);
/** The streams and storages Office opens and runs: a Word 97 document, a workbook, a presentation, a macro project. */
const REFUSED = Object.freeze(['worddocument', 'workbook', 'powerpoint document', 'macros', '_vba_project_cur']);

/** A reader of the open file `handle` that refuses, by throwing, to read more than BUDGET bytes in all. */
function budgetedReader(handle, size) {
  let spent = 0;
  return async (at, length) => {
    if (at < 0 || at + length > size) throw new RangeError('outside the file');
    spent += length;
    if (spent > BUDGET) throw new RangeError('past the bytes the check reads');
    const b = Buffer.alloc(length);
    const { bytesRead } = await handle.read(b, 0, length, at);
    if (bytesRead !== length) throw new RangeError('the file ended early');
    return b;
  };
}

/**
 * The names in the directory of the compound file read by `read(at, length)` (`size` bytes long): the lower-cased name of
 * every storage and stream. Throws for anything it cannot read.
 */
async function directoryNames(read, size) {
  const head = await read(0, 512);
  if (!head.subarray(0, 8).equals(SIGNATURE)) throw new RangeError('not a compound file');
  const shift = head.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) throw new RangeError('a sector size the format does not have');
  const sector = 1 << shift;
  const perSector = sector / 4;
  const sectors = Math.floor(size / sector) - 1;
  const fatCount = head.readUInt32LE(0x2c);
  const firstDir = head.readUInt32LE(0x30);
  let difat = head.readUInt32LE(0x44);
  const offsetOf = (n) => (n + 1) * sector;
  const inFile = (n) => n <= MAXSECT && n < sectors;
  // The FAT sectors' places: the header's first 109, then the DIFAT sectors' as far as they are needed (read once each).
  const fatPlaces = [];
  for (let i = 0; i < 109 && i < fatCount; i++) fatPlaces.push(head.readUInt32LE(0x4c + i * 4));
  const difatSeen = new Set();
  async function fatPlace(k) {
    while (k >= fatPlaces.length && fatPlaces.length < fatCount) {
      if (!inFile(difat) || difatSeen.has(difat)) throw new RangeError('a DIFAT chain that cannot be followed');
      difatSeen.add(difat);
      const b = await read(offsetOf(difat), sector);
      for (let i = 0; i < perSector - 1 && fatPlaces.length < fatCount; i++) fatPlaces.push(b.readUInt32LE(i * 4));
      difat = b.readUInt32LE(sector - 4);
    }
    if (k >= fatPlaces.length) throw new RangeError('a sector the FAT does not hold');
    return fatPlaces[k];
  }
  const fatSectors = new Map();
  async function next(n) {
    const k = Math.floor(n / perSector);
    if (!fatSectors.has(k)) {
      const place = await fatPlace(k);
      if (!inFile(place)) throw new RangeError('a FAT sector outside the file');
      fatSectors.set(k, await read(offsetOf(place), sector));
    }
    return fatSectors.get(k).readUInt32LE((n % perSector) * 4);
  }
  const names = [];
  const seen = new Set();
  for (let n = firstDir; n !== END;) {
    if (!inFile(n) || seen.has(n)) throw new RangeError('a directory chain that cannot be followed');
    seen.add(n);
    const b = await read(offsetOf(n), sector);
    for (let at = 0; at + 128 <= sector; at += 128) {
      const type = b[at + 66];
      if (type !== 1 && type !== 2 && type !== 5) continue;
      const length = b.readUInt16LE(at + 64);
      if (length < 2 || length > 64 || length % 2) continue;
      names.push(b.subarray(at, at + length - 2).toString('utf16le').toLowerCase());
    }
    n = await next(n);
  }
  return names;
}

/**
 * Whether the file at `file` is a Word, Excel or PowerPoint file protected with a password, as a compound file: true only
 * when its directory holds EncryptionInfo and EncryptedPackage and none of the streams Office runs; false for anything
 * else, a directory that cannot be read within BUDGET bytes included. Rejects only when the file cannot be opened.
 */
async function isProtectedOffice(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const names = await directoryNames(budgetedReader(handle, size), size).catch(() => null);
    return !!names && NEEDED.every((n) => names.includes(n)) && !names.some((n) => REFUSED.includes(n));
  } finally {
    await handle.close();
  }
}

module.exports = { BUDGET, NEEDED, REFUSED, directoryNames, isProtectedOffice };
