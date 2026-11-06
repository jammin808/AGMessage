'use strict';
// An archive is checked at upload before anyone opens it (the plan's Part 4 §5.10.3): a docx, xlsx or pptx has its end
// records and its central directory read and held to the bounds, nothing inflated, by one core (public/zipcore.js) that
// the server reads a file through (lib/zipcheck.js) and the page's document worker reads its bytes through. A refused
// upload is not kept, its uploader is told what to do, and the hall's audit has one row that names no file. Every zip
// here is built in the test, byte by byte, with node:zlib: no binary fixture.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const zipcore = require('../public/zipcore.js');
const zipcheck = require('../lib/zipcheck');
const uploadcheck = require('../lib/uploadcheck');
const guard = require('../lib/guard');
const { STAGE_TYPES } = require('../lib/pages');
const vm = require('vm');
const { ROOT, readSource, startServer, stopServer, api, connect, emit, TOKEN } = require('./helpers');

const MB = 1024 * 1024;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A ZIP64 extended information field holding `values` (numbers, or BigInts past 2^53), each 8 bytes. */
function wideExtra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}
/** A data descriptor: its signature, the CRC-32 and both sizes. */
function descriptor(crc, packed, unpacked) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0); b.writeUInt32LE(crc, 4); b.writeUInt32LE(packed, 8); b.writeUInt32LE(unpacked, 12);
  return b;
}

/**
 * A zip of `entries`, each `{name, data, method = 8, flags, packed, unpacked, body, at, wide, descriptor}`: `packed` and
 * `unpacked` declare sizes other than its bytes' (a lie; a BigInt past 2^53 in a ZIP64 field), `body` the packed bytes
 * written in place of deflate's, `at` the index of an entry before it whose local header it names (no header of its own:
 * an overlap), `wide` its sizes and offset in a ZIP64 field (after `extraBefore`; `wideField` false for none, or the
 * values it holds; `twoWide` a second one after it), `descriptor` its CRC and sizes after its data (bit 3).
 * `end`: `{zip64}` the ZIP64 end records (or `marksOnly`, its marks without them; `noMarks`, its records under an end
 * record that marks no field; `extensible`, bytes of extensible data in its ZIP64 end record; `gap`, bytes between that
 * record and its locator), `count` and `dirSize` the end record's (a lie), `disk`, `comment` and `after` (bytes past the
 * end record).
 */
function zipOf(entries, end = {}) {
  const parts = [];
  const central = [];
  const locals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const method = e.method === undefined ? 8 : e.method;
    const body = e.body || (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data);
    const packed = e.packed === undefined ? body.length : e.packed;
    const unpacked = e.unpacked === undefined ? data.length : e.unpacked;
    const flags = (e.flags || 0) | (e.descriptor ? 8 : 0);
    const version = e.wide ? 45 : 20;
    let local;
    if (e.at === undefined) {
      local = offset;
      const extra = e.wide ? wideExtra([unpacked, packed]) : Buffer.alloc(0);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(version, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8);
      if (!e.descriptor) {
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(e.wide ? 0xffffffff : packed, 18);
        h.writeUInt32LE(e.wide ? 0xffffffff : unpacked, 22);
      }
      h.writeUInt16LE(name.length, 26); h.writeUInt16LE(extra.length, 28);
      const after = e.descriptor ? descriptor(crc, body.length, data.length) : Buffer.alloc(0);
      parts.push(h, name, extra, body, after);
      offset += h.length + name.length + extra.length + body.length + after.length;
    } else local = locals[e.at];
    locals.push(local);
    const field = e.wideField === false ? Buffer.alloc(0) : wideExtra((e.wideField || [unpacked, packed, local]).slice(0, e.wideField ? undefined : 3));
    const extra = e.wide ? Buffer.concat([e.extraBefore || Buffer.alloc(0), field, e.twoWide ? field : Buffer.alloc(0)]) : Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(version, 4); c.writeUInt16LE(version, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.wide ? 0xffffffff : packed, 20);
    c.writeUInt32LE(e.wide ? 0xffffffff : unpacked, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(e.wide ? 0xffffffff : local, 42);
    central.push(c, name, extra);
  }
  const dir = Buffer.concat(central);
  const count = end.count === undefined ? entries.length : end.count;
  const records = [];
  if (end.zip64) {
    const extensible = end.extensible || Buffer.alloc(0);
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(BigInt(44 + extensible.length), 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(count), 24); r.writeBigUInt64LE(BigInt(count), 32);
    r.writeBigUInt64LE(BigInt(dir.length), 40); r.writeBigUInt64LE(BigInt(offset), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(offset + dir.length), 8); l.writeUInt32LE(1, 16);
    records.push(r, extensible, end.gap || Buffer.alloc(0), l);
  }
  const wide = (end.zip64 && !end.noMarks) || end.marksOnly;
  const comment = Buffer.from(end.comment || '', 'utf8');
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(end.disk || 0, 4);
  e.writeUInt16LE(wide ? 0xffff : count, 8); e.writeUInt16LE(wide ? 0xffff : count, 10);
  e.writeUInt32LE(wide ? 0xffffffff : end.dirSize === undefined ? dir.length : end.dirSize, 12);
  e.writeUInt32LE(wide ? 0xffffffff : offset, 16);
  e.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, dir, ...records, e, comment, end.after || Buffer.alloc(0)]);
}

// ---------------------------------------------------------------- real-shaped Office files
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const types = (overrides) => XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
  + overrides.map(([part, type]) => '<Override PartName="' + part + '" ContentType="' + type + '"/>').join('') + '</Types>';
const rels = (list) => XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + list.map(([id, type, target]) => '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>').join('') + '</Relationships>';
const props = [
  { name: 'docProps/core.xml', data: XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Board pack</dc:title><dc:creator>Ana</dc:creator></cp:coreProperties>' },
  { name: 'docProps/app.xml', data: XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><Pages>3</Pages></Properties>' },
];
const theme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>' + '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme>'.repeat(20) + '</a:themeElements></a:theme>';
const paragraphs = (n) => Array.from({ length: n }, (_, i) => '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Item ' + (i + 1) + ': the capex review, line ' + (i * 7919 % 10007) + '</w:t></w:r></w:p>').join('');

/** A Word document as Word lays its parts out, a picture among them stored. */
const docxParts = () => [
  { name: '[Content_Types].xml', data: types([['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'], ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'], ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']]) },
  { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]) },
  ...props,
  { name: 'word/document.xml', data: XML + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs(400) + '</w:body></w:document>' },
  { name: 'word/styles.xml', data: XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + Array.from({ length: 60 }, (_, i) => '<w:style w:type="paragraph" w:styleId="S' + i + '"><w:name w:val="Style ' + i + '"/><w:basedOn w:val="Normal"/></w:style>').join('') + '</w:styles>' },
  { name: 'word/settings.xml', data: XML + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>' },
  { name: 'word/fontTable.xml', data: XML + '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Calibri"/><w:font w:name="Times New Roman"/></w:fonts>' },
  { name: 'word/theme/theme1.xml', data: XML + theme },
  { name: 'word/_rels/document.xml.rels', data: rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'settings', 'settings.xml'], ['rId3', 'fontTable', 'fontTable.xml'], ['rId4', 'theme', 'theme/theme1.xml'], ['rId5', 'image', 'media/image1.png']]) },
  { name: 'word/media/image1.png', data: crypto.randomBytes(4096), method: 0 },
];
/** An Excel workbook as Excel streams it: every part's CRC and sizes in a data descriptor after it. */
const xlsxParts = () => [
  { name: '[Content_Types].xml', data: types([['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'], ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']]) },
  { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'xl/workbook.xml']]) },
  ...props,
  { name: 'xl/workbook.xml', data: XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'styles', 'styles.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml']]) },
  { name: 'xl/worksheets/sheet1.xml', data: XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + Array.from({ length: 800 }, (_, r) => '<row r="' + (r + 1) + '"><c r="A' + (r + 1) + '" t="s"><v>' + (r % 40) + '</v></c><c r="B' + (r + 1) + '"><v>' + (r * 104729 % 99991) / 100 + '</v></c></row>').join('') + '</sheetData></worksheet>' },
  { name: 'xl/sharedStrings.xml', data: XML + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + Array.from({ length: 40 }, (_, i) => '<si><t>Line ' + i + '</t></si>').join('') + '</sst>' },
  { name: 'xl/styles.xml', data: XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts></styleSheet>' },
].map((e) => ({ ...e, descriptor: true }));
/** A PowerPoint deck: a master, its layouts, slides with their rels, and a stored thumbnail. */
const pptxParts = () => [
  { name: '[Content_Types].xml', data: types([['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'], ...[1, 2, 3, 4].map((n) => ['/ppt/slides/slide' + n + '.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'])]) },
  { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]) },
  ...props,
  { name: 'docProps/thumbnail.jpeg', data: crypto.randomBytes(2048), method: 0 },
  { name: 'ppt/presentation.xml', data: XML + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>' + [1, 2, 3, 4].map((n) => '<p:sldId id="' + (255 + n) + '" r:id="rId' + n + '"/>').join('') + '</p:sldIdLst></p:presentation>' },
  { name: 'ppt/_rels/presentation.xml.rels', data: rels([1, 2, 3, 4].map((n) => ['rId' + n, 'slide', 'slides/slide' + n + '.xml'])) },
  { name: 'ppt/slideMasters/slideMaster1.xml', data: XML + '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sldMaster>' },
  ...[1, 2, 3].map((n) => ({ name: 'ppt/slideLayouts/slideLayout' + n + '.xml', data: XML + '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj"><p:cSld name="Layout ' + n + '"/></p:sldLayout>' })),
  ...[1, 2, 3, 4].flatMap((n) => [
    { name: 'ppt/slides/slide' + n + '.xml', data: XML + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Item ' + n + ': the capex review</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide' + n + '.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]) },
  ]),
  { name: 'ppt/theme/theme1.xml', data: XML + theme },
];

/** Every archive the tests read, each with the verdict both readers give it: `why` for a refusal, `ok` for a pass. */
function fixtures() {
  const docx = docxParts();
  const small = docx.slice(0, 2);
  const zeros = Buffer.alloc(MB);
  return {
    'a Word document': { bytes: zipOf(docx), ext: 'docx', ok: true, names: docx.map((e) => e.name) },
    'an Excel workbook, streamed with data descriptors': { bytes: zipOf(xlsxParts()), ext: 'xlsx', ok: true, names: xlsxParts().map((e) => e.name) },
    'a PowerPoint deck': { bytes: zipOf(pptxParts()), ext: 'pptx', ok: true, names: pptxParts().map((e) => e.name) },
    'a Word document in ZIP64': { bytes: zipOf(docxParts().map((e) => ({ ...e, wide: true })), { zip64: true }), ext: 'docx', ok: true, zip64: true, names: docx.map((e) => e.name) },
    'a ZIP64 part whose field follows an NTFS times field': { bytes: zipOf(docxParts().map((e) => ({ ...e, wide: true, extraBefore: Buffer.concat([Buffer.from([0x0a, 0x00, 0x20, 0x00]), Buffer.alloc(32)]) })), { zip64: true }), ext: 'docx', ok: true, zip64: true, names: docx.map((e) => e.name) },
    'a ZIP64 part with two ZIP64 fields': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', wide: true, twoWide: true }], { zip64: true }), ext: 'docx', why: 'shape' },
    'ZIP64 marks on a part with no ZIP64 field': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', wide: true, wideField: false }], { zip64: true }), ext: 'docx', why: 'shape' },
    'a ZIP64 field too short for its marks': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', wide: true, wideField: [1] }], { zip64: true }), ext: 'docx', why: 'shape' },
    'an extra field that runs past its entry': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', wide: true, wideField: false, extraBefore: Buffer.from([0x0a, 0x00, 0x40, 0x00, 0, 0]) }], { zip64: true }), ext: 'docx', why: 'shape' },
    '10,000 entries': { bytes: zipOf([...small, ...Array.from({ length: 9998 }, (_, i) => ({ name: 'p/' + i, data: '', method: 0 }))]), ext: 'docx', why: 'entries', n: 10000, bound: 2000, unread: true },
    'an entry whose data would run into the directory': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', packed: 50 * 1000 }]), ext: 'docx', why: 'sizes' },
    'a stored entry whose two sizes differ': { bytes: zipOf([...small, { name: 'word/document.xml', data: 'x', method: 0, unpacked: 90 * 1000 }]), ext: 'docx', why: 'sizes' },
    'entries that overlap, one stream read as three files': { bytes: zipOf([...small, { name: 'word/document.xml', data: paragraphs(50) }, { name: 'word/a.xml', data: paragraphs(50), at: 2 }, { name: 'word/b.xml', data: paragraphs(50), at: 2 }]), ext: 'docx', why: 'overlap' },
    'a 1000:1 entry': { bytes: zipOf([...small, { name: 'xl/worksheets/sheet1.xml', data: zeros }]), ext: 'xlsx', why: 'ratio', n: MB / zlib.deflateRawSync(zeros).length, bound: 200 },
    'an encrypted entry': { bytes: zipOf([...small, { name: 'word/document.xml', data: paragraphs(10), flags: 1 }]), ext: 'docx', why: 'encrypted' },
    'no [Content_Types].xml': { bytes: zipOf(docxParts().slice(1)), ext: 'pptx', why: 'types' },
    'a vbaProject.bin': { bytes: zipOf([...docxParts(), { name: 'word/vbaProject.bin', data: crypto.randomBytes(512) }]), ext: 'docx', why: 'macros' },
    'parts declaring 270 MB unpacked': { bytes: zipOf([...small, ...[1, 2, 3].map((n) => ({ name: 'ppt/media/media' + n + '.bin', body: crypto.randomBytes(500 * 1024), unpacked: 90 * MB }))]), ext: 'pptx', why: 'total', n: 270 * MB + small.reduce((s, e) => s + Buffer.byteLength(e.data), 0), bound: 200 * MB },
    'a part declaring 170 MB unpacked': { bytes: zipOf([...small, { name: 'xl/worksheets/sheet1.xml', body: crypto.randomBytes(MB), unpacked: 170 * MB }]), ext: 'xlsx', why: 'entry', n: 170 * MB, bound: 100 * MB },
    'a ZIP64 part declaring 1 TB unpacked': { bytes: zipOf([...small.map((e) => ({ ...e, wide: true })), { name: 'word/document.xml', body: crypto.randomBytes(1024), unpacked: 2 ** 40, wide: true }], { zip64: true }), ext: 'docx', why: 'entry', n: 2 ** 40, bound: 100 * MB },
    'a ZIP64 part declaring 2^60 bytes, past a double': { bytes: zipOf([...small.map((e) => ({ ...e, wide: true })), { name: 'word/document.xml', body: crypto.randomBytes(1024), unpacked: 2n ** 60n, wide: true }], { zip64: true }), ext: 'docx', why: 'entry', n: Infinity, bound: 100 * MB },
    'a directory declared at 2 MB': { bytes: zipOf(small, { dirSize: 2 * MB }), ext: 'docx', why: 'directory', n: 2 * MB, bound: MB, unread: true },
    'not a zip past its first four bytes': { bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(200)]), ext: 'docx', why: 'shape' },
    'four bytes': { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), ext: 'docx', why: 'shape' },
    'bytes after its end record': { bytes: zipOf(docxParts(), { after: Buffer.from('appended') }), ext: 'docx', why: 'shape' },
    // The end record and the ZIP64 records are where every reader finds them, or the archive is refused.
    'an end record with a comment': { bytes: zipOf(docxParts(), { comment: 'Saved by a tool' }), ext: 'docx', why: 'shape' },
    'an end record signature inside the end record\'s own fields': { bytes: zipOf(small, { dirSize: 0x06054b50 }), ext: 'docx', why: 'shape' },
    'ZIP64 records under an end record that marks no field': { bytes: zipOf(docxParts().map((e) => ({ ...e, wide: true })), { zip64: true, noMarks: true }), ext: 'docx', why: 'shape' },
    'a ZIP64 end record with extensible data': { bytes: zipOf(docxParts().map((e) => ({ ...e, wide: true })), { zip64: true, extensible: Buffer.alloc(16) }), ext: 'docx', why: 'shape' },
    'bytes between the ZIP64 end record and its locator': { bytes: zipOf(docxParts().map((e) => ({ ...e, wide: true })), { zip64: true, gap: Buffer.alloc(16) }), ext: 'docx', why: 'shape' },
    'a second disk': { bytes: zipOf(docxParts(), { disk: 1 }), ext: 'docx', why: 'shape' },
    'a part packed with bzip2': { bytes: zipOf([...small, { name: 'word/document.xml', body: crypto.randomBytes(64), method: 12, unpacked: 200 }]), ext: 'docx', why: 'shape' },
    'an end record that counts one entry more': { bytes: zipOf(docxParts(), { count: docx.length + 1 }), ext: 'docx', why: 'shape' },
    'a directory that does not end at the end record': { bytes: zipOf(docxParts(), { dirSize: 100 }), ext: 'docx', why: 'shape' },
    'ZIP64 marks with no ZIP64 records': { bytes: zipOf(docxParts(), { marksOnly: true }), ext: 'docx', why: 'shape' },
    'an empty archive': { bytes: zipOf([]), ext: 'docx', why: 'types' },
  };
}

/** The verdict a fixture is expected to get, as both readers give it. */
function expected(f) {
  if (f.ok) return null;
  return f.n === undefined ? { ok: false, why: f.why } : { ok: false, why: f.why, n: f.n, bound: f.bound };
}

test('every archive gets the same verdict through the server\'s file reader and the worker\'s byte reader, and the one it should', async () => {
  const dir = tmp('agm-zips-');
  try {
    for (const [name, f] of Object.entries(fixtures())) {
      const file = path.join(dir, 'fixture.' + f.ext);
      fs.writeFileSync(file, f.bytes);
      const server = await zipcheck.checkFile(file);
      const worker = await zipcore.check(zipcore.bytesSource(f.bytes));
      const whole = await zipcore.check(zipcore.bytesSource(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length)));
      assert.deepEqual(worker, server, name + ': the two readers agree');
      assert.deepEqual(whole, server, name + ': and the worker\'s reader over an ArrayBuffer too');
      if (f.ok) assert.deepEqual([server.ok, server.zip64], [true, !!f.zip64], name + ': passes (' + JSON.stringify(server) + ')');
      else assert.deepEqual(server, expected(f), name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loaded as the document worker loads it, a classic script with no module, the core is AGMZip and gives the same verdicts', async () => {
  // A scope with the language's own names and nothing of Node's or a page's: what the worker's importScripts runs it in.
  const scope = vm.createContext({});
  vm.runInContext(readSource(path.join(ROOT, 'public', 'zipcore.js')), scope, { filename: 'zipcore.js' });
  const AGMZip = scope.AGMZip;
  assert.ok(AGMZip && typeof AGMZip.check === 'function', 'AGMZip is the core');
  assert.equal(scope.module, undefined, 'and nothing else is set');
  for (const [name, f] of Object.entries(fixtures())) {
    const there = JSON.parse(JSON.stringify(await AGMZip.check(AGMZip.bytesSource(new Uint8Array(f.bytes)))));
    assert.deepEqual(there, JSON.parse(JSON.stringify(await zipcore.check(zipcore.bytesSource(f.bytes)))), name);
  }
});

test('a passing archive is counted as its directory declares it', async () => {
  const parts = docxParts();
  const v = await zipcore.check(zipcore.bytesSource(zipOf(parts)));
  assert.deepEqual(v, { ok: true, entries: parts.length, total: parts.reduce((s, e) => s + (Buffer.isBuffer(e.data) ? e.data.length : Buffer.byteLength(e.data)), 0), zip64: false });
  // A caller may hold the check to bounds of its own (a test's), each one at a time.
  const file = path.join(tmp('agm-zips-'), 'a.docx');
  fs.writeFileSync(file, zipOf(parts));
  try {
    assert.deepEqual(await zipcheck.checkFile(file, { ...zipcheck.BOUNDS, entries: 5 }), { ok: false, why: 'entries', n: parts.length, bound: 5 });
    assert.deepEqual(await zipcheck.checkFile(file, { ...zipcheck.BOUNDS, total: 1000 }), { ok: false, why: 'total', n: v.total, bound: 1000 });
    assert.equal((await zipcheck.checkFile(file, { ...zipcheck.BOUNDS, ratio: 2 })).why, 'ratio');
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  await assert.rejects(zipcheck.checkFile(path.join(os.tmpdir(), 'agm-no-such-' + crypto.randomUUID() + '.docx')), { code: 'ENOENT' }, 'a file not there is the caller\'s to refuse');
});

test('an archive that declares too many entries, or too large a directory, is refused with its directory unread', async () => {
  const f = fixtures();
  for (const name of ['10,000 entries', 'a directory declared at 2 MB']) {
    const bytes = f[name].bytes;
    const reads = [];
    const source = zipcore.bytesSource(bytes);
    const counted = { size: source.size, read: (at, length) => { reads.push([at, length]); return source.read(at, length); } };
    assert.deepEqual(await zipcore.check(counted), expected(f[name]), name);
    assert.deepEqual(reads, [[bytes.length - 98, 98]], name + ': only its last 98 bytes were read, where its end record and ZIP64 records sit');
  }
  assert.deepEqual(await zipcore.check(null), { ok: false, why: 'shape' }, 'no source: refused');
});

test('the bounds sit at or above four times the largest Office files measured, and every file measured passes', () => {
  // Measured on 2026-11-05 (Python's zipfile and public/zipcore.js agree on every row; every one passes the check).
  // Office's samples: Word's template as python-docx ships it, PowerPoint's (saved by Microsoft PowerPoint for Mac) as
  // python-pptx ships it, and mammoth 1.11.0's 17 Word test documents (the two largest here). The bounds are held to four
  // times these. The owner's own board packs are not measured: when they are, their rows join these and the bounds
  // follow them.
  const SAMPLES = [
    // [file, size, parts, unpacked in all, the largest part, the highest ratio, its directory]
    ['Word template (python-docx)', 38116, 17, 916994, 438677, 32.3, 1121],
    ['PowerPoint template (python-pptx)', 34030, 36, 93799, 11987, 9.3, 2834],
    ['mammoth: comments.docx, the largest of its 17', 15526, 16, 56249, 18084, 7.8, 1051],
    ['mammoth: tiny-picture-target-base-relative.docx', 10881, 19, 50973, 16498, 10.2, 1173],
  ];
  // Made for the measurement, not board packs: generated words, numbers and pictures (python-pptx and python-docx, and a
  // CSV of random numbers) saved by LibreOffice 24.2.7. Stress rows: each must pass the bounds, and none sets them.
  const MADE = [
    ['made: a 60-slide deck with pictures', 2618066, 186, 3130805, 823770, 23.1, 13975],
    ['made: a 150-page paper with tables and pictures', 5014130, 21, 5877734, 824398, 27.9, 1387],
    ['made: a 60,000-row budget from random numbers', 4993239, 10, 38431947, 38148550, 13.9, 640],
  ];
  const most = (i) => Math.max(...SAMPLES.map((r) => r[i]));
  const B = zipcheck.BOUNDS;
  assert.ok(B.entries >= 4 * most(2), 'entries: ' + B.entries + ' against 4 × ' + most(2));
  assert.ok(B.total >= 4 * most(3), 'unpacked in all: ' + B.total + ' against 4 × ' + most(3));
  assert.ok(B.entry >= 4 * most(4), 'one part: ' + B.entry + ' against 4 × ' + most(4));
  assert.ok(B.ratio >= 4 * most(5), 'ratio: ' + B.ratio + ' against 4 × ' + most(5));
  assert.ok(B.directory >= 4 * most(6), 'directory: ' + B.directory + ' against 4 × ' + most(6));
  for (const [file, size, parts, total, largest, ratio, directory] of [...SAMPLES, ...MADE]) {
    assert.ok(size <= 25 * MB, file + ': within the upload\'s 25 MB');
    assert.ok(parts <= B.entries && total <= B.total && largest <= B.entry && ratio <= B.ratio && directory <= B.directory, file + ': within every bound');
  }
  assert.deepEqual(B, { entries: 2000, total: 200 * MB, entry: 100 * MB, ratio: 200, directory: MB }, 'the bounds as the plan writes them');
});

test('every upload type whose first bytes are a zip\'s, and that the stage can show, is checked as an archive', () => {
  const zipHead = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
  const zipped = Object.keys(guard.UPLOAD_TYPES).filter((ext) => guard.UPLOAD_TYPES[ext].magic(zipHead) && STAGE_TYPES.includes(ext)).sort();
  assert.deepEqual(zipped, [...zipcheck.ARCHIVES].sort());
  assert.deepEqual(zipcore.WHYS, ['shape', 'entries', 'directory', 'sizes', 'encrypted', 'entry', 'ratio', 'total', 'overlap', 'macros', 'types']);
});

test('the words: the uploader is told what to do, the audit what was refused and by which bound, never a name', () => {
  const W = zipcheck.auditWords;
  const B = zipcheck.BOUNDS;
  assert.deepEqual(zipcore.WHYS.map((why) => zipcheck.refusalWords({ why })), zipcore.WHYS.map((why) => (why === 'macros' ? zipcheck.MACROS : zipcheck.PACKED)));
  assert.equal(zipcheck.MACROS, 'That file carries macros. Save it without them, or as a PDF.');
  assert.equal(zipcheck.PACKED, 'That file is packed in a way AGMessage will not open. Share it as a PDF.');
  assert.deepEqual([
    W('docx', { why: 'entries', n: 12000, bound: B.entries }),
    W('docx', { why: 'directory', n: 2 * MB, bound: B.directory }),
    W('pptx', { why: 'total', n: 300 * MB, bound: B.total }),
    W('xlsx', { why: 'entry', n: 170 * MB + 1, bound: B.entry }),
    W('docx', { why: 'entry', n: Infinity, bound: B.entry }),
    W('xlsx', { why: 'ratio', n: 1015.7, bound: B.ratio }),
    W('docx', { why: 'ratio', n: Infinity, bound: B.ratio }),
    W('docx', { why: 'encrypted' }), W('docx', { why: 'overlap' }), W('docx', { why: 'sizes' }), W('docx', { why: 'macros' }), W('pptx', { why: 'types' }), W('docx', { why: 'shape' }), W('xlsx', { why: 'unchecked' }),
  ], [
    'a docx: 12,000 parts (bound 2,000)',
    'a docx: a directory of 2 MB (bound 1 MB)',
    'a pptx: 300 MB unpacked (bound 200 MB)',
    'an xlsx: a part of 171 MB unpacked (bound 100 MB)',
    'a docx: a part of at least 8,589,934,592 MB unpacked (bound 100 MB)',
    'an xlsx: a part packed 1,016:1 (bound 200:1)',
    'a docx: a part packed from nothing (bound 200:1)',
    'a docx with an encrypted part', 'a docx whose parts overlap', 'a docx whose sizes cannot be true', 'a docx with macros', 'a pptx without [Content_Types].xml', 'a docx packed in a way AGMessage does not read', 'an xlsx that could not be checked',
  ]);
  assert.deepEqual([0, 7, 999, 1000, 1234567].map(zipcheck.grouped), ['0', '7', '999', '1,000', '1,234,567']);
});

test('at upload: each archive the check refuses leaves the disk, its uploader told what to do, and one upload.refused row in the hall names no file; those it passes are kept', async (t) => {
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  // Each upload from a page of its own, on a network of its own (a phone through the tunnel), so no rate is reached.
  let n = 0;
  const seat = async () => {
    n++;
    const s = await connect(srv.base, null, { headers: { 'cf-connecting-ip': '2001:db8:58:' + n.toString(16) + '::1', 'cf-ray': '58aa' + n } });
    sockets.push(s);
    const j = await emit(s, 'join', { roomCode: hall, name: 'Ana ' + n, role: 'research' });
    assert.ok(j.ok, JSON.stringify(j));
    return j;
  };
  const uploads = srv.dataDir + '-uploads';
  const kept = () => fs.readdirSync(uploads).filter((f) => !f.startsWith('.')).length;
  const upload = async (token, name, bytes) => {
    const f = new FormData();
    f.append('file', new Blob([bytes]), name);
    // From another address than the page's socket: the row names the upload's own.
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token, 'cf-connecting-ip': '2001:db8:5800::' + n.toString(16), 'cf-ray': '58bb' + n }, body: f });
    return { status: r.status, body: await r.json() };
  };
  const all = fixtures();
  const REFUSED = ['10,000 entries', 'an entry whose data would run into the directory', 'entries that overlap, one stream read as three files', 'a 1000:1 entry', 'an encrypted entry', 'no [Content_Types].xml', 'a vbaProject.bin', 'an end record with a comment'];
  const PASSED = ['a Word document', 'an Excel workbook, streamed with data descriptors', 'a PowerPoint deck', 'a Word document in ZIP64'];
  const seats = [];
  for (const name of REFUSED) {
    const f = all[name];
    const j = await seat();
    seats.push(j);
    const before = kept();
    const r = await upload(j.uploadToken, 'q3-board-pack-' + seats.length + '.' + f.ext, f.bytes);
    assert.deepEqual(r, { status: 400, body: { error: f.why === 'macros' ? zipcheck.MACROS : zipcheck.PACKED } }, name);
    assert.equal(kept(), before, name + ': nothing kept');
  }
  for (const name of PASSED) {
    const f = all[name];
    const j = await seat();
    const before = kept();
    const r = await upload(j.uploadToken, 'q3-board-pack.' + f.ext, f.bytes);
    assert.equal(r.status, 200, name + ': ' + JSON.stringify(r.body));
    assert.deepEqual([typeof r.body.url, r.body.size], ['string', f.bytes.length], name);
    assert.equal(kept(), before + 1, name + ': kept');
    assert.ok(fs.readFileSync(path.join(uploads, r.body.url.slice(9))).equals(f.bytes), name + ': kept whole');
  }
  // The audit trail is on disk before the answer goes (lib/audit.js): read as it stands.
  const entries = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows = entries.filter((e) => e.action === 'upload.refused');
  assert.deepEqual(rows.map((e) => [e.target, e.actor, e.words, e.ip]), REFUSED.map((name, i) => [hall, { t: 'code', id: seats[i].identity.split('.')[0], name: 'Ana ' + (i + 1) },
    zipcheck.auditWords(all[name].ext, expected(all[name])), 'cf:2001:db8:5800::' + (i + 1).toString(16)]), 'one row each, in the hall, by its uploader, at the upload\'s own address');
  assert.deepEqual(rows.map((e) => e.words).slice(0, 2), ['a docx: 10,000 parts (bound 2,000)', 'a docx whose sizes cannot be true']);
  assert.ok(!JSON.stringify(entries).includes('board-pack'), 'no row names a file');
});

test('a check that cannot finish refuses the file in words of its own, and a type with no check is not read', async () => {
  const dir = tmp('agm-unchecked-');
  try {
    const gone = path.join(dir, 'removed-before-its-check');
    for (const [ext, words] of [['docx', 'a docx that could not be checked'], ['xlsx', 'an xlsx that could not be checked'], ['png', 'a png that could not be checked']]) {
      assert.deepEqual(await uploadcheck.refusalOf(gone, ext), { status: 503, error: uploadcheck.UNCHECKED, words, failed: 'ENOENT' }, ext + ': a file gone before its check');
    }
    // A folder where the file was is no file to check, on every platform (Windows opens a folder and reads it as empty,
    // which the archive's check would read as a file packed some other way).
    const folder = path.join(dir, 'a-folder');
    fs.mkdirSync(folder);
    for (const [ext, words] of [['pptx', 'a pptx that could not be checked'], ['png', 'a png that could not be checked']]) {
      assert.deepEqual(await uploadcheck.refusalOf(folder, ext), { status: 503, error: uploadcheck.UNCHECKED, words, failed: 'EISDIR' }, ext + ': a folder');
    }
    assert.equal(uploadcheck.UNCHECKED, 'That file could not be checked, so it wasn\'t shared. Try sending it again.');
    // The types it does not read are kept as their first bytes allowed, read or not.
    for (const ext of ['pdf', 'txt', 'md', 'csv', 'xls']) assert.equal(await uploadcheck.refusalOf(gone, ext), null, ext);
    // And it answers as the checks do.
    const file = path.join(dir, 'a.docx');
    fs.writeFileSync(file, zipOf(docxParts()));
    assert.equal(await uploadcheck.refusalOf(file, 'docx'), null, 'a Word document passes');
    fs.writeFileSync(file, fixtures()['a vbaProject.bin'].bytes);
    assert.deepEqual(await uploadcheck.refusalOf(file, 'docx'), { status: 400, error: zipcheck.MACROS, words: 'a docx with macros' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every archive the check passes is read by the pages\' readers as the parts its directory names, and no others', async () => {
  // The readers a page opens a file with: SheetJS's zip reader (xlsx.full.min.js) and mammoth (with JSZip inside it), run
  // as a page runs them, so the check and what is opened after it count the same parts.
  const ctx = vm.createContext({ setTimeout, clearTimeout, TextDecoder });
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'vendor', 'xlsx.full.min.js')), ctx, { filename: 'xlsx.full.min.js' });
  vm.runInContext(readSource(path.join(ROOT, 'public', 'vendor', 'mammoth.browser.min.js')), ctx, { filename: 'mammoth.browser.min.js' });
  /** The bytes as an ArrayBuffer of the readers' own realm. */
  const theirs = (bytes) => { const ab = vm.runInContext('new ArrayBuffer(' + bytes.length + ')', ctx); new Uint8Array(ab).set(bytes); return ab; };
  let read = 0;
  for (const [name, f] of Object.entries(fixtures())) {
    if (!f.ok) continue;
    assert.equal((await zipcore.check(zipcore.bytesSource(f.bytes))).ok, true, name);
    // SheetJS reads no ZIP64 end record: an archive that needs one it does not open at all, which hands it no part.
    let parts = null;
    try {
      const c = ctx.XLSX.CFB.read(new Uint8Array(theirs(f.bytes)), { type: 'array' });
      parts = c.FullPaths.filter((p, i) => c.FileIndex[i].type === 2 && c.FileIndex[i].name !== '\u0001Sh33tJ5').map((p) => p.slice('Root Entry/'.length));
    } catch (e) {
      assert.ok(f.zip64, name + ': SheetJS refuses only a ZIP64 archive (' + e.message + ')');
    }
    if (parts) {
      assert.deepEqual([...parts].sort(), [...f.names].sort(), name + ': SheetJS reads the parts the directory names');
      read++;
    }
    if (f.ext === 'docx') {
      const text = (await ctx.mammoth.extractRawText({ arrayBuffer: theirs(f.bytes) })).value;
      assert.ok(text.startsWith('Item 1: the capex review') && text.includes('Item 400: the capex review'), name + ': mammoth reads the document the directory names');
    }
  }
  assert.ok(read >= 3, 'SheetJS read the Word, Excel and PowerPoint files');
});

// A file shown on the stage is checked again at its take (plan 4-§5.10.3): a picture against what the Board's devices
// draw (40 megapixels), and a file this run never checked by its check as at upload; what a check found is kept by the
// upload's name, so a file is read once; a file that cannot be read is not shown.
test('a stage file\'s check at its first take: its upload\'s check where none is on record, kept by its name; a picture held to 40 MP; an unreadable file not shown', async () => {
  const dir = tmp('agm-stagecheck-');
  try {
    const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2; return b; };
    const at = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
    assert.equal(uploadcheck.STAGE_PIXELS, 40 * 1000 * 1000);
    assert.equal(await uploadcheck.stageRefusalOf(at('1730000000000-aaaaaaaaaaaa-ok.png', png(6000, 6000)), 'png', '1730000000000-aaaaaaaaaaaa-ok.png'), null, '36 MP');
    assert.deepEqual(await uploadcheck.stageRefusalOf(at('1730000000000-bbbbbbbbbbbb-big.png', png(8000, 6000)), 'png', '1730000000000-bbbbbbbbbbbb-big.png'), { error: 'Too large for the Board\'s devices — send a region.' }, '48 MP');
    assert.deepEqual(await uploadcheck.stageRefusalOf(at('1730000000000-cccccccccccc-huge.png', png(20000, 20000)), 'png', '1730000000000-cccccccccccc-huge.png'), { error: 'Too large for the Board\'s devices — send a region.' }, 'over the upload\'s own bound too');
    // A Word file with no check on record has it now; one checked at upload is not read again (its verdict kept).
    const fresh = at('1730000000000-dddddddddddd-m.docx', fixtures()['a vbaProject.bin'].bytes);
    assert.deepEqual(await uploadcheck.stageRefusalOf(fresh, 'docx', '1730000000000-dddddddddddd-m.docx'), { error: zipcheck.MACROS });
    const kept = at('1730000000000-eeeeeeeeeeee-k.docx', zipOf(docxParts()));
    assert.equal(await uploadcheck.refusalOf(kept, 'docx', '1730000000000-eeeeeeeeeeee-k.docx'), null);
    fs.writeFileSync(kept, fixtures()['a vbaProject.bin'].bytes);
    assert.equal(await uploadcheck.stageRefusalOf(kept, 'docx', '1730000000000-eeeeeeeeeeee-k.docx'), null, 'checked at upload: not read again');
    // A file gone, or a type with no check.
    const gone = await uploadcheck.stageRefusalOf(path.join(dir, 'gone.png'), 'png', '1730000000000-ffffffffffff-gone.png');
    assert.deepEqual([gone.error, gone.failed], ['That file could not be read, so it was not shown.', 'ENOENT']);
    // A folder where the file was is not shown either, on every platform (Windows would read it as an empty file).
    const folder = path.join(dir, '1730000000000-gggggggggggg-f.pptx');
    fs.mkdirSync(folder);
    assert.deepEqual(await uploadcheck.stageRefusalOf(folder, 'pptx', '1730000000000-gggggggggggg-f.pptx'), { error: 'That file could not be read, so it was not shown.', failed: 'EISDIR' });
    for (const ext of ['pdf', 'txt', 'csv', 'md', 'xls']) assert.equal(await uploadcheck.stageRefusalOf(path.join(dir, 'gone.' + ext), ext, 'x'), null, ext);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
