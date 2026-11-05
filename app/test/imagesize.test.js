'use strict';
// An image's size is read from its header at upload, before anyone draws it (the plan's Part 4 §5.10.3): PNG's IHDR,
// GIF's logical screen grown to hold its first frame (found by a walk over its blocks), WebP's VP8, VP8L and VP8X, and a
// JPEG's frame header found by a walk over its segments' markers, each read at its offset. Over 100 megapixels, or a size that cannot be read, is refused at upload: the file is not
// kept, its uploader is told, and the hall's audit has one row that names no file. Every image here is built in the test.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imagesize = require('../lib/imagesize');
const guard = require('../lib/guard');
const { STAGE_TYPES } = require('../lib/pages');
const { startServer, stopServer, api, connect, emit, pngOf, TOKEN, ROOT, readSource } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const be16 = (n) => Buffer.from([n >> 8, n & 255]);
const le16 = (n) => Buffer.from([n & 255, n >> 8]);
const le24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/** A PNG's signature and IHDR of `w` × `h` (the header is all the reader reads). */
function pngHead(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2;
  return b;
}
/**
 * A GIF: its version, a logical screen of `w` × `h` with a global colour table of 256 entries (or `table: false`), the
 * `blocks` before its first frame (each an extension, written whole), that frame's descriptor (`frame`: [left, top,
 * width, height], the screen's whole by default), a few bytes of its image data and the trailer.
 */
function gif(w, h, { version = '89a', table = true, blocks = [], frame = [0, 0, w, h] } = {}) {
  const [left, top, fw, fh] = frame;
  return Buffer.concat([Buffer.from('GIF' + version, 'latin1'), le16(w), le16(h), Buffer.from([table ? 0xf7 : 0x00, 0, 0]), table ? Buffer.alloc(768) : Buffer.alloc(0),
    ...blocks, Buffer.from([0x2c]), le16(left), le16(top), le16(fw), le16(fh), Buffer.from([0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
}
/** A GIF extension: its label, then `data` in sub-blocks of at most 255 bytes, then the empty one. */
const extension = (label, data) => {
  const subs = [];
  for (let at = 0; at < data.length; at += 255) { const part = data.subarray(at, at + 255); subs.push(Buffer.from([part.length]), part); }
  return Buffer.concat([Buffer.from([0x21, label]), ...subs, Buffer.from([0])]);
};
/** A graphic control extension, a comment and the looping extension: what an animated GIF carries before its frame. */
const animated = [extension(0xf9, Buffer.from([0x04, 0x0a, 0, 0])), extension(0xfe, Buffer.from('made for the stage', 'latin1')), extension(0xff, Buffer.from('NETSCAPE2.0\x03\x01\x00\x00', 'latin1'))];
const riff = (chunk, body) => Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(4 + 8 + body.length), Buffer.from('WEBP' + chunk, 'latin1'), le32(body.length), body]);
const vp8 = (w, h) => riff('VP8 ', Buffer.concat([Buffer.from([0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a]), le16(w), le16(h), Buffer.alloc(8)]));
const vp8l = (w, h) => riff('VP8L', Buffer.concat([Buffer.from([0x2f]), le32((w - 1) | ((h - 1) << 14)), Buffer.alloc(8)]));
const vp8x = (w, h) => riff('VP8X', Buffer.concat([Buffer.from([0x10, 0, 0, 0]), le24(w - 1), le24(h - 1)]));

/** A JPEG segment: its marker and length, then `payload`. */
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
/** A baseline frame header (SOF0) of `w` × `h`, three components. */
const sof = (w, h, marker = 0xc0) => segment(marker, Buffer.concat([Buffer.from([8]), be16(h), be16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]));
/** A JPEG: SOI, `before` (its segments), the frame header, a scan's start and a few bytes of it, EOI. */
const jpeg = (w, h, before = [], marker = 0xc0) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, sof(w, h, marker), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), crypto.randomBytes(32), Buffer.from([0xff, 0xd9])]);
/** EXIF-sized metadata: 80 KiB of APP1 in two segments (one holds at most 65,533 bytes). */
const exif80 = [segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), crypto.randomBytes(65527)])), segment(0xe1, crypto.randomBytes(80 * 1024 - 65533))];

/** A reader over `bytes` that counts what it reads, as lib/imagesize.js's file reader reads: `{read, reads}`. */
function counted(bytes) {
  const reads = [];
  return { reads, read: async (at, length) => { reads.push([at, length]); return bytes.subarray(at, at + length); } };
}

test('PNG, GIF, WebP (VP8, VP8L, VP8X) and a JPEG whose frame header sits after 80 KiB of APP1 are read, from their headers alone', async () => {
  const cases = [
    ['png', pngHead(1920, 1080), [1920, 1080]],
    ['png', pngOf(3, 2), [3, 2]],
    ['gif', gif(640, 480), [640, 480]],
    ['gif', gif(640, 480, { version: '87a', table: false }), [640, 480]],
    ['gif', gif(640, 480, { blocks: animated }), [640, 480]],
    ['gif', gif(640, 480, { frame: [10, 20, 100, 80] }), [640, 480]],
    ['webp', vp8(1024, 768), [1024, 768]],
    ['webp', vp8l(4000, 3000), [4000, 3000]],
    ['webp', vp8x(16000, 9000), [16000, 9000]],
    ['jpg', jpeg(4032, 3024, exif80), [4032, 3024]],
    ['jpeg', jpeg(800, 600, [segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), segment(0xdb, Buffer.alloc(65)), Buffer.from([0xff, 0xff])]), [800, 600]],
    ['jpg', jpeg(1200, 900, [], 0xc2), [1200, 900]],   // progressive (SOF2)
  ];
  for (const [ext, bytes, [width, height]] of cases) {
    const r = counted(bytes);
    assert.deepEqual(await imagesize.sizeFrom(r.read, ext), { width, height }, ext + ' ' + width + '×' + height);
    const read = r.reads.reduce((s, [, n]) => s + n, 0);
    // A GIF's walk reads its header, then one window from past its colour table, then its frame's descriptor.
    if (ext === 'gif') assert.ok(r.reads.length === 3 && r.reads[1][1] === imagesize.GIF_WINDOW, ext + ': ' + JSON.stringify(r.reads));
    else assert.ok(read <= 64, ext + ': ' + read + ' bytes read (' + JSON.stringify(r.reads) + ')');
  }
  // The JPEG's walk read each segment's marker at its offset and skipped its metadata unread.
  const r = counted(jpeg(4032, 3024, exif80));
  await imagesize.sizeFrom(r.read, 'jpg');
  assert.deepEqual(r.reads, [[0, 2], [2, 9], [2 + exif80[0].length, 9], [2 + exif80[0].length + exif80[1].length, 9]], 'SOI, the two APP1 markers, the frame header: 29 bytes of 80 KiB');
});

test('a size that cannot be read is refused: a header this reader does not know, a size of 0, a scan before any frame, a walk past its bounds', async () => {
  const unreadable = [
    ['jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(200).map((b) => b & 0x7f)]), 'a JPEG whose bytes after SOI are no marker'],
    ['jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.alloc(10)), crypto.randomBytes(64)]), 'a scan before any frame header'],
    ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'SOI then EOI'],
    ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]), 'a segment length under 2'],
    ['jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'not a JPEG'],
    ['jpg', jpeg(0, 600), 'a frame of no width'],
    ['jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x05, 8, 0, 1])]), 'a frame header too short'],
    ['png', pngHead(0, 10), 'a PNG of no width'],
    ['png', Buffer.concat([pngHead(10, 10).subarray(0, 12), Buffer.from('IDAT'), Buffer.alloc(17)]), 'a PNG whose first chunk is not IHDR'],
    ['gif', Buffer.from('GIF90a\x10\x00\x10\x00\x00\x00\x00\x2c', 'latin1'), 'a GIF of no known version'],
    ['gif', gif(16, 16, { frame: [0, 0, 0, 16] }), 'a GIF whose frame has no width'],
    ['gif', Buffer.concat([gif(16, 16).subarray(0, 13 + 768), Buffer.from([0x3b])]), 'a GIF that ends before any frame'],
    ['gif', Buffer.concat([gif(16, 16).subarray(0, 13 + 768), Buffer.from([0x99])]), 'a GIF block that is none a GIF holds'],
    ['gif', Buffer.concat([gif(16, 16).subarray(0, 13 + 768), Buffer.from([0x21, 0xfe, 0x40, 0x01])]), 'a GIF extension cut short'],
    ['gif', gif(16, 16).subarray(0, 13 + 768 + 4), 'a GIF frame descriptor cut short'],
    ['webp', riff('VP8 ', Buffer.concat([Buffer.from([0x51, 0x01, 0x00, 0x9d, 0x01, 0x2a]), le16(10), le16(10), Buffer.alloc(8)])), 'a VP8 frame that is not a key frame'],
    ['webp', riff('VP8L', Buffer.concat([Buffer.from([0x2e]), Buffer.alloc(12)])), 'VP8L without its signature'],
    ['webp', riff('ALPH', Buffer.alloc(16)), 'a first chunk the reader does not know'],
    ['webp', Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(20), Buffer.from('WAVE', 'latin1'), Buffer.alloc(20)]), 'a RIFF that is not WEBP'],
    ['bmp', pngHead(10, 10), 'a type that is not a picture the stage shows'],
    ['png', Buffer.alloc(0), 'nothing'],
  ];
  for (const [ext, bytes, what] of unreadable) assert.equal(await imagesize.sizeFrom(counted(bytes).read, ext), null, what);

  // At most 64 segments, the frame header among them: 63 before it are walked, 64 are not.
  const comments = (n) => Array.from({ length: n }, () => segment(0xfe, Buffer.from('c')));
  assert.deepEqual(await imagesize.sizeFrom(counted(jpeg(640, 480, comments(63))).read, 'jpg'), { width: 640, height: 480 });
  const capped = counted(jpeg(640, 480, comments(64)));
  assert.equal(await imagesize.sizeFrom(capped.read, 'jpg'), null, 'the 64-segment cap');
  assert.equal(capped.reads.length, 1 + imagesize.JPEG_SEGMENTS, 'SOI, then 64 segments read and no more');
  // Nothing read past the file's first megabyte: 17 full APP2 segments (an ICC profile's) put the frame header past it.
  const icc = Array.from({ length: 17 }, () => segment(0xe2, crypto.randomBytes(65533)));
  const far = counted(jpeg(640, 480, icc));
  assert.equal(await imagesize.sizeFrom(far.read, 'jpg'), null, 'a frame header past the first megabyte');
  assert.ok(far.reads.every(([at, n]) => at + n <= imagesize.REACH), 'and nothing read past it');
  // A GIF's walk: at most 64 blocks, its frame's descriptor among them (63 extensions before it are walked, 64 are not),
  // and nothing read past the first megabyte either.
  const notes = (n) => Array.from({ length: n }, () => extension(0xfe, Buffer.from('c')));
  assert.deepEqual(await imagesize.sizeFrom(counted(gif(640, 480, { blocks: notes(63) })).read, 'gif'), { width: 640, height: 480 });
  assert.equal(await imagesize.sizeFrom(counted(gif(640, 480, { blocks: notes(64) })).read, 'gif'), null, 'the 64-block cap');
  const xmp = extension(0xff, crypto.randomBytes(1100 * 1024));
  const farGif = counted(gif(640, 480, { blocks: [xmp] }));
  assert.equal(await imagesize.sizeFrom(farGif.read, 'gif'), null, 'a frame past the first megabyte');
  assert.ok(farGif.reads.every(([at, n]) => at + n <= imagesize.REACH), 'and nothing read past it (' + farGif.reads.length + ' reads)');
  assert.ok(farGif.reads.length <= 1 + imagesize.REACH / imagesize.GIF_WINDOW + 1, 'read in its windows, never a byte at a time');
  // Metadata within the reach is walked past: a frame after 200 KiB of it is found.
  assert.deepEqual(await imagesize.sizeFrom(counted(gif(640, 480, { blocks: [extension(0xff, crypto.randomBytes(200 * 1024))] })).read, 'gif'), { width: 640, height: 480 });
  assert.deepEqual([imagesize.JPEG_SEGMENTS, imagesize.GIF_BLOCKS, imagesize.GIF_WINDOW, imagesize.REACH, imagesize.PIXELS], [64, 64, 64 * 1024, 1024 * 1024, 100000000]);
});

test('a GIF is held to the size a browser decodes it at: its screen grown to hold its first frame', async () => {
  // A 1 × 1 screen does not hide a 20,000 × 20,000 frame: the browsers' decoders grow the image to hold its first frame.
  const cases = [
    [gif(1, 1, { table: false, frame: [0, 0, 20000, 20000] }), [20000, 20000]],
    [gif(1, 1, { version: '87a', table: false, frame: [0, 0, 20000, 20000] }), [20000, 20000]],
    [gif(100, 100, { frame: [9000, 50, 3000, 20] }), [12000, 100]],
    [gif(4000, 3000, { blocks: animated, frame: [0, 0, 10, 10] }), [4000, 3000]],
  ];
  for (const [bytes, [width, height]] of cases) assert.deepEqual(await imagesize.sizeFrom(counted(bytes).read, 'gif'), { width, height });
  const dir = tmp('agm-gifs-');
  try {
    const file = path.join(dir, 'a.gif');
    fs.writeFileSync(file, cases[0][0]);
    assert.deepEqual(await imagesize.checkFile(file, 'gif'), { ok: false, why: 'pixels', pixels: 4e8, bound: 1e8, width: 20000, height: 20000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the file check: 100 megapixels pass, one more is refused, as are 400 MP PNG and JPEG; the words never name the file', async () => {
  const dir = tmp('agm-images-');
  try {
    const at = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
    assert.deepEqual(await imagesize.checkFile(at('a.png', pngHead(10000, 10000)), 'png'), { ok: true, width: 10000, height: 10000, pixels: 1e8 });
    assert.deepEqual(await imagesize.checkFile(at('b.png', pngHead(10000, 10001)), 'png'), { ok: false, why: 'pixels', pixels: 100010000, bound: 1e8, width: 10000, height: 10001 });
    assert.deepEqual(await imagesize.checkFile(at('c.png', pngHead(20000, 20000)), 'png'), { ok: false, why: 'pixels', pixels: 4e8, bound: 1e8, width: 20000, height: 20000 });
    assert.deepEqual(await imagesize.checkFile(at('d.jpg', jpeg(20000, 20000, exif80)), 'jpg'), { ok: false, why: 'pixels', pixels: 4e8, bound: 1e8, width: 20000, height: 20000 });
    assert.deepEqual(await imagesize.checkFile(at('e.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 'jpg'), { ok: false, why: 'unreadable' });
    assert.deepEqual(await imagesize.checkFile(at('f.webp', vp8x(8000, 6000)), 'webp', 40e6), { ok: false, why: 'pixels', pixels: 48e6, bound: 40e6, width: 8000, height: 6000 }, 'a bound of its caller\'s');
    await assert.rejects(imagesize.checkFile(path.join(dir, 'gone.png'), 'png'), { code: 'ENOENT' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual([imagesize.refusalWords({ why: 'pixels' }), imagesize.refusalWords({ why: 'unreadable' })], ['That image is too large to show.', 'That image cannot be read.']);
  assert.deepEqual([
    imagesize.auditWords('png', { why: 'pixels', pixels: 4e8, bound: 1e8 }),
    imagesize.auditWords('jpg', { why: 'pixels', pixels: 100010000, bound: 1e8 }),
    imagesize.auditWords('jpg', { why: 'unreadable' }),
    imagesize.auditWords('gif', { why: 'unchecked' }),
  ], ['a png of 400 MP (bound 100)', 'a jpg of 100.1 MP (bound 100)', 'a jpg whose size cannot be read', 'a gif that could not be checked']);
});

test('every upload type that is a picture has its size read, and each is a type the stage can show', () => {
  const pictures = Object.keys(guard.UPLOAD_TYPES).filter((ext) => guard.UPLOAD_TYPES[ext].mime.startsWith('image/')).sort();
  assert.deepEqual(pictures, [...imagesize.IMAGES].sort());
  assert.ok(imagesize.IMAGES.every((ext) => STAGE_TYPES.includes(ext)));
});

test('at upload: a 400 MP PNG or JPEG and a JPEG whose size cannot be read leave the disk with their words and one upload.refused row each that names no file; pictures within the bound are kept', async (t) => {
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  // Each upload from a page of its own, on a network of its own (a phone through the tunnel), so no rate is reached.
  const seats = [];
  const seat = async () => {
    const n = seats.length + 1;
    const s = await connect(srv.base, null, { headers: { 'cf-connecting-ip': '2001:db8:59:' + n.toString(16) + '::1', 'cf-ray': '59aa' + n } });
    sockets.push(s);
    const j = await emit(s, 'join', { roomCode: hall, name: 'Ana ' + n, role: 'research' });
    assert.ok(j.ok, JSON.stringify(j));
    seats.push(j);
    return j;
  };
  const uploads = srv.dataDir + '-uploads';
  const kept = () => fs.readdirSync(uploads).filter((f) => !f.startsWith('.')).length;
  const upload = async (name, bytes) => {
    const j = await seat();
    const f = new FormData();
    f.append('file', new Blob([bytes]), name);
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': j.uploadToken }, body: f });
    return { status: r.status, body: await r.json() };
  };
  const refused = [
    ['stage-plot.png', pngHead(20000, 20000), 'That image is too large to show.', 'a png of 400 MP (bound 100)'],
    ['stage-plot.jpg', jpeg(20000, 20000, exif80), 'That image is too large to show.', 'a jpg of 400 MP (bound 100)'],
    ['stage-plot.jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(300).map((b) => b & 0x7f)]), 'That image cannot be read.', 'a jpeg whose size cannot be read'],
    ['stage-plot.gif', gif(1, 1, { table: false, frame: [0, 0, 20000, 20000] }), 'That image is too large to show.', 'a gif of 400 MP (bound 100)'],
  ];
  for (const [name, bytes, error] of refused) {
    const before = kept();
    assert.deepEqual(await upload(name, bytes), { status: 400, body: { error } }, name);
    assert.equal(kept(), before, name + ': nothing kept');
  }
  // Within the bound, each type.
  for (const [name, bytes] of [['plot.png', pngOf(4, 3)], ['plot.webp', vp8l(4000, 3000)], ['plot.gif', gif(640, 480)], ['plot.jpg', jpeg(10000, 10000, exif80)]]) {
    const r = await upload(name, bytes);
    assert.equal(r.status, 200, name + ': ' + JSON.stringify(r.body));
    assert.ok(fs.readFileSync(path.join(uploads, r.body.url.slice(9))).equals(bytes), name + ': kept whole');
  }
  const entries = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows = entries.filter((e) => e.action === 'upload.refused');
  assert.deepEqual(rows.map((e) => [e.target, e.actor, e.words]), refused.map((r, i) => [hall, { t: 'code', id: seats[i].identity.split('.')[0], name: 'Ana ' + (i + 1) }, r[3]]), 'one row each, in the hall, by its uploader');
  assert.ok(!JSON.stringify(entries).includes('stage-plot'), 'no row names a file');
});

test('the header reader is one core: lib/imagesize.js requires public/imagecore.js, the page and its worker load it as a classic script, and each reads the same sizes; it names a picture by its bytes', async () => {
  const vm = require('node:vm');
  const core = require('../public/imagecore.js');
  const scope = vm.createContext({});
  vm.runInContext('globalThis.self = globalThis;', scope);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'imagecore.js')), scope, { filename: 'imagecore.js' });
  const there = scope.AGMImage;
  assert.equal(imagesize.sizeFrom, core.sizeFrom, 'the server\'s reader is the core\'s');
  const pngHead = (w, h) => { const b = Buffer.from(pngOf(1, 1)); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const gifHead = Buffer.from('GIF89a\x10\x00\x08\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x10\x00\x08\x00\x00', 'latin1');
  const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 48, 0, 64, 3, 0, 0, 0]);
  const webpHead = Buffer.alloc(30); webpHead.write('RIFF', 0); webpHead.write('WEBP', 8); webpHead.write('VP8X', 12); webpHead.writeUIntLE(99, 24, 3); webpHead.writeUIntLE(49, 27, 3);
  for (const [bytes, expected] of [[pngHead(640, 480), { type: 'png', width: 640, height: 480 }], [gifHead, { type: 'gif', width: 16, height: 8 }], [jpegHead, { type: 'jpg', width: 64, height: 48 }], [webpHead, { type: 'webp', width: 100, height: 50 }]]) {
    assert.deepEqual(await core.sizeOf(bytes), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(await there.sizeOf(new Uint8Array(bytes)))), expected, 'the classic script reads it alike');
  }
  assert.equal(core.sniff(pngHead(1, 1)), 'png');
  assert.equal(await core.sizeOf(Buffer.from('BM a bitmap')), null, 'a type no reader here knows is no size');
  assert.equal(await core.sizeOf(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(4)])), null, 'a PNG with no IHDR');
  assert.deepEqual([core.REACH, core.JPEG_SEGMENTS, core.GIF_BLOCKS, core.GIF_WINDOW], [imagesize.REACH, imagesize.JPEG_SEGMENTS, imagesize.GIF_BLOCKS, imagesize.GIF_WINDOW]);
});
