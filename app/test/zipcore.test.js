'use strict';
// The archive core's other half (public/zipcore.js), the document worker's: an archive the check passed is listed, an
// entry's stored bytes found, and the file repacked with some parts replaced — every other entry's local header, data and
// data descriptor copied byte for byte, each replaced part written stored with its own CRC-32, a new central directory
// after them — so that the copy passes the same check and mammoth opens it, seeing only what was replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const zipcore = require('../public/zipcore.js');
const { ROOT, readSource, officeZip, wordParts, OOXML, W_NS } = require('./helpers');

const source = (b) => zipcore.bytesSource(b);
/**
 * mammoth's browser bundle, as the document worker loads it, in a context of its own: {convert(bytes) → its HTML}, the
 * bytes handed over in that context's own ArrayBuffer, as a worker's are.
 */
function mammoth() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextDecoder, TextEncoder });
  vm.runInContext('globalThis.self = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'vendor', 'mammoth.browser.min.js')), ctx);
  const own = vm.runInContext('(n) => new ArrayBuffer(n)', ctx);
  return { convert: async (b) => { const ab = own(b.length); new Uint8Array(ab).set(b); return (await ctx.mammoth.convertToHtml({ arrayBuffer: ab })).value; } };
}
const body = '<w:p><w:r><w:t>Before</w:t></w:r></w:p>';
const docx = (descriptors = []) => officeZip({ ...wordParts({ body, styles: '', pages: 1 }), 'word/media/raw.bin': Buffer.from('stored bytes, kept') }, { stored: ['word/media/raw.bin'], descriptors });

test('zipcore: an archive the check passed is listed with each entry\'s name, method, sizes and CRC-32, and its stored bytes found', async () => {
  const zip = docx();
  const r = await zipcore.entries(source(zip));
  assert.equal(r.ok, true);
  assert.deepEqual(r.list.map((e) => e.name), Object.keys({ ...wordParts({ body, styles: '', pages: 1 }), 'word/media/raw.bin': 1 }));
  const raw = r.list.find((e) => e.name === 'word/media/raw.bin');
  assert.deepEqual([raw.method, raw.packed, raw.unpacked], [0, 18, 18]);
  assert.equal(Buffer.from(zipcore.stored(zip, raw, r.offset)).toString(), 'stored bytes, kept');
  const doc = r.list.find((e) => e.name === 'word/document.xml');
  assert.equal(doc.method, 8);
  assert.ok(zlib.inflateRawSync(zipcore.stored(zip, doc, r.offset)).toString().includes('Before'));
  assert.equal(doc.crc, zlib.crc32(zlib.inflateRawSync(zipcore.stored(zip, doc, r.offset))));
  assert.equal(zipcore.crc32(Buffer.from('The quick brown fox')), zlib.crc32(Buffer.from('The quick brown fox')));
  // The check's refusal is the listing's: nothing is listed of an archive it refuses.
  assert.deepEqual(await zipcore.entries(source(Buffer.from('PK\u0003\u0004 not an archive'))), { ok: false, why: 'shape' });
  // A local header that is not where the directory says is not found.
  const moved = Buffer.from(zip);
  moved.writeUInt32LE(0, raw.local);
  assert.equal(zipcore.stored(moved, raw, r.offset), null);
});

test('zipcore: repack copies every other entry\'s local header, data and descriptor byte for byte, writes each replaced part stored with its CRC-32, and the copy passes the check', async () => {
  for (const descriptors of [[], ['word/document.xml', '_rels/.rels']]) {
    const zip = docx(descriptors);
    const before = await zipcore.entries(source(zip));
    const replacement = Buffer.from(OOXML + '<w:document ' + W_NS + '><w:body><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>');
    const r = await zipcore.repack(zip, { 'word/document.xml': replacement });
    assert.equal(r.ok, true);
    const copy = Buffer.from(r.bytes);
    assert.deepEqual(await zipcore.check(source(copy)), { ok: true, entries: before.list.length, total: before.list.reduce((n, e) => n + (e.name === 'word/document.xml' ? replacement.length : e.unpacked), 0), zip64: false });
    const after = await zipcore.entries(source(copy));
    assert.deepEqual(after.list.map((e) => e.name), before.list.map((e) => e.name), 'every entry, in its order');
    for (const e of before.list) {
      const n = after.list.find((x) => x.name === e.name);
      if (e.name === 'word/document.xml') {
        assert.deepEqual([n.method, n.flags & 8, n.packed, n.unpacked, n.crc], [0, 0, replacement.length, replacement.length, zlib.crc32(replacement)], 'the replaced part is stored, with its own CRC-32');
        assert.equal(Buffer.from(zipcore.stored(copy, n, after.offset)).toString(), replacement.toString());
        continue;
      }
      // Its local header, its data and its descriptor, as they were.
      const span = (z, x, off) => { const data = zipcore.stored(z, x, off); const end = data.byteOffset - z.byteOffset + data.length + ((x.flags & 8) ? 16 : 0); return Buffer.from(z.subarray(x.local, end)); };
      assert.ok(span(zip, e, before.offset).equals(span(copy, n, after.offset)), e.name + ' is copied byte for byte');
      assert.deepEqual([n.method, n.flags, n.crc, n.packed, n.unpacked], [e.method, e.flags, e.crc, e.packed, e.unpacked], e.name + '\'s directory record says the same');
    }
  }
  // An archive the check refuses is not repacked.
  assert.deepEqual(await zipcore.repack(Buffer.from('nothing here'), {}), { ok: false, why: 'shape' });
});

test('zipcore: mammoth opens the repacked copy and reads the replaced part, never the one it replaced', async () => {
  const zip = officeZip(wordParts({ body: '<w:p><w:r><w:t>Visible </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDENWORD</w:t></w:r></w:p>' }));
  const m = mammoth();
  assert.match(await m.convert(zip), /HIDDENWORD/, 'mammoth draws hidden text when it is there');
  const r = await zipcore.repack(zip, { 'word/document.xml': Buffer.from(OOXML + '<w:document ' + W_NS + '><w:body><w:p><w:r><w:t>Visible </w:t></w:r></w:p></w:body></w:document>') });
  assert.equal(await m.convert(Buffer.from(r.bytes)), '<p>Visible </p>');
});

test('zipcore: an entry with a Unicode Path field (Info-ZIP\'s 0x7075, a second name JSZip reads in place of the one checked) is refused by the check, on the server and in the worker alike; its external attributes are listed', async () => {
  const field = Buffer.alloc(22);
  field.writeUInt16LE(0x7075, 0); field.writeUInt16LE(18, 2); field[4] = 1;
  field.writeUInt32LE(zlib.crc32(Buffer.from('word/media/raw.bin')), 5);
  Buffer.from('word/document.xml').copy(field, 9);
  const parts = { ...wordParts({ body, styles: '', pages: 1 }), 'word/media/raw.bin': Buffer.from('stored bytes, kept') };
  assert.deepEqual(await zipcore.check(source(officeZip(parts, { extras: { 'word/media/raw.bin': field } }))), { ok: false, why: 'shape' });
  // Another extra field (a timestamp's) changes nothing.
  const time = Buffer.alloc(9);
  time.writeUInt16LE(0x5455, 0); time.writeUInt16LE(5, 2);
  assert.equal((await zipcore.check(source(officeZip(parts, { extras: { 'word/media/raw.bin': time } })))).ok, true);
  const listed = await zipcore.entries(source(officeZip(parts, { external: { 'word/media/raw.bin': 0x20 } })));
  assert.deepEqual(listed.list.map((e) => e.external), listed.list.map((e) => (e.name === 'word/media/raw.bin' ? 0x20 : 0)));
});
