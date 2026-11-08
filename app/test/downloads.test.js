'use strict';
// A shared file is a transfer (plan 4-§4.6): a download for the backstage team, by a ticket the server issues per seat,
// never opened by itself on anyone's page; files to transfer take more types than the stage shows, none of which AGMessage
// opens; and an observer's page or a Viewer account's is never given a file message's link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, restartServer, stopServer, api, connect, emit, wait, until, inviteOf, TOKEN, setupAdmin } = require('./helpers');
const guard = require('../lib/guard');
const pagesLib = require('../lib/pages');
const ops = require('../lib/ops');
const cfbcheck = require('../lib/cfbcheck');
const downloads = require('../lib/downloads');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PASSWORD = 'clipboard and coffee';

// ---------------------------------------------------------------- the files the tests are made of
const zipHead = (entry, data, { method = 0 } = {}) => {
  const name = Buffer.from(entry, 'latin1');
  const body = Buffer.from(data, 'latin1');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(method, 8);
  h.writeUInt32LE(body.length, 18);
  h.writeUInt32LE(body.length, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name, body]);
};
const odfOf = (type) => Buffer.concat([zipHead('mimetype', 'application/vnd.oasis.opendocument.' + type), zipHead('content.xml', '<office:document-content/>', { method: 8 })]);
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand, 'latin1'), Buffer.alloc(16)]);
const BYTES = {
  zip: zipHead('readme.txt', 'Load-in at 7.'),
  mp4: ftyp('isom'),
  m4a: ftyp('M4A '),
  mov: ftyp('qt  '),
  mp3: Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32)]),
  wav: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt ', 'latin1'), Buffer.alloc(24)]),
  odt: odfOf('text'),
  ods: odfOf('spreadsheet'),
  odp: odfOf('presentation'),
};
/** An MPEG audio frame's header (MPEG-1 Layer III, 128 kbit/s, 44.1 kHz), with no ID3 tag before it. */
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(32)]);

/**
 * A compound file ([MS-CFB], version 3, 512-byte sectors) whose directory names `entries` ([name, type]: 1 a storage, 2 a
 * stream; the root entry first by itself), spread over `dirSectors` sectors (four entries each, the last ones holding
 * them), its FAT in the sectors before them.
 */
function cfbOf(entries, { dirSectors = 1 } = {}) {
  const all = [['Root Entry', 5], ...entries];
  const n = Math.max(dirSectors, Math.ceil(all.length / 4));
  let fat = 1;
  while (fat * 128 < fat + n) fat++;
  const header = Buffer.alloc(512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(fat, 0x2c);
  header.writeUInt32LE(fat, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c);
  header.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fat ? i : 0xffffffff, 0x4c + i * 4);
  const fats = Buffer.alloc(fat * 512, 0xff);
  for (let i = 0; i < fat; i++) fats.writeUInt32LE(0xfffffffd, i * 4);
  for (let i = 0; i < n; i++) fats.writeUInt32LE(i === n - 1 ? 0xfffffffe : fat + i + 1, (fat + i) * 4);
  const dir = Buffer.alloc(n * 512, 0);
  // The entries fill the last sectors of the chain, so a long chain is read to its end before they are found.
  const first = n * 4 - all.length;
  all.forEach(([name, type], i) => {
    const at = (first + i) * 128;
    dir.write(name, at, 'utf16le');
    dir.writeUInt16LE((name.length + 1) * 2, at + 64);
    dir[at + 66] = type;
  });
  return Buffer.concat([header, fats, dir]);
}
const PROTECTED = cfbOf([['\u0006DataSpaces', 1], ['EncryptionInfo', 2], ['EncryptedPackage', 2]]);

// ---------------------------------------------------------------- pure: the types, the compound file, the tickets
test('files to transfer: each type is taken by its first bytes alone, as application/octet-stream and transfer-only; the wrong bytes are refused; a Word name that is a compound file is decided per file', () => {
  for (const [ext, bytes] of Object.entries(BYTES)) {
    assert.deepEqual(guard.uploadType('pack.' + ext, bytes), { ext, mime: 'application/octet-stream', transferOnly: true }, ext);
    assert.equal(guard.uploadType('pack.' + ext, Buffer.from('Just some words, not a ' + ext)), null, ext + ' with the wrong first bytes');
    assert.ok(guard.uploadable('Pack.' + ext.toUpperCase()), ext + ' may be uploaded');
  }
  assert.deepEqual(guard.uploadType('song.mp3', MP3_FRAME), { ext: 'mp3', mime: 'application/octet-stream', transferOnly: true }, 'an MPEG frame header with no ID3 tag');
  assert.equal(guard.uploadType('song.mp3', Buffer.from([0xff, 0xfb, 0xf0, 0x64, 0, 0])), null, 'a bitrate of 1111 is no frame');
  assert.equal(guard.uploadType('clip.mov', Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moov', 'latin1'), Buffer.alloc(8)])), null, 'a QuickTime file that does not start with ftyp');
  assert.equal(guard.uploadType('notes.odt', odfOf('spreadsheet')), null, 'an ODF file whose mimetype is another type\'s');
  assert.equal(guard.uploadType('notes.odt', Buffer.concat([zipHead('content.xml', 'x'), zipHead('mimetype', 'application/vnd.oasis.opendocument.text')])), null, 'mimetype not first');
  assert.equal(guard.uploadType('notes.odt', zipHead('mimetype', 'application/vnd.oasis.opendocument.text', { method: 8 })), null, 'mimetype compressed');
  for (const ext of guard.PROTECTED_OFFICE) {
    assert.deepEqual(guard.uploadType('Agenda.' + ext, PROTECTED), { ext, mime: 'application/octet-stream', transferOnly: true, compound: true }, ext + ' as a compound file');
    assert.equal(guard.uploadType('Agenda.' + ext, BYTES.zip).transferOnly, false, ext + ' as a zip is a stage type');
  }
  assert.equal(guard.uploadType('book.xls', PROTECTED).transferOnly, false, 'an Excel 97 file is a compound file of its own, a stage type');
  for (const name of ['run.exe', 'page.html', 'pic.svg', 'notes.rtf', 'tool.js']) assert.equal(guard.uploadable(name), false, name);
  // Two tables, no key in both; every upload type the stage shows, every transfer type transfer-only.
  assert.deepEqual(Object.keys(guard.UPLOAD_TYPES).filter((k) => Object.hasOwn(guard.TRANSFER_TYPES, k)), []);
  assert.deepEqual([...pagesLib.TRANSFER_ONLY].sort(), Object.keys(guard.TRANSFER_TYPES).sort());
  assert.ok(Object.keys(guard.TRANSFER_TYPES).every((ext) => /^[a-z0-9]{1,5}$/.test(ext)), 'each within the extensions extOf reads');
});

test('a compound file is a protected Office file only when its directory holds the encrypted package and nothing Office runs, read within 64 KB', async (t) => {
  const dir = tmp('agm-cfb-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
  assert.equal(await cfbcheck.isProtectedOffice(at('ok.docx', PROTECTED)), true);
  assert.equal(await cfbcheck.isProtectedOffice(at('lower.docx', cfbOf([['encryptioninfo', 2], ['ENCRYPTEDPACKAGE', 2]]))), true, 'names compared without regard to case');
  for (const [name, entries] of [
    ['renamed-doc.docx', [['WordDocument', 2], ['1Table', 2], ['EncryptionInfo', 2], ['EncryptedPackage', 2]]],
    ['macros.docx', [['Macros', 1], ['EncryptionInfo', 2], ['EncryptedPackage', 2]]],
    ['vba.xlsx', [['_VBA_PROJECT_CUR', 1], ['EncryptionInfo', 2], ['EncryptedPackage', 2]]],
    ['workbook.xlsx', [['Workbook', 2]]],
    ['deck.pptx', [['PowerPoint Document', 2], ['EncryptionInfo', 2], ['EncryptedPackage', 2]]],
    ['half.docx', [['EncryptionInfo', 2]]],
  ]) assert.equal(await cfbcheck.isProtectedOffice(at(name, cfbOf(entries))), false, name);
  // A directory whose chain runs past what the check reads (140 sectors, 70 KB) is refused, never read on.
  const long = cfbOf([['EncryptionInfo', 2], ['EncryptedPackage', 2]], { dirSectors: 140 });
  assert.equal(await cfbcheck.isProtectedOffice(at('long.docx', long)), false, 'past 64 KB');
  assert.equal(await cfbcheck.isProtectedOffice(at('short.docx', cfbOf([['EncryptionInfo', 2], ['EncryptedPackage', 2]], { dirSectors: 100 }))), true, 'within 64 KB');
  // A chain that loops, or points past the file, and a header that is no compound file's.
  const loop = Buffer.from(PROTECTED);
  loop.writeUInt32LE(1, 512 + 4);   // the directory's sector (1) points at itself
  assert.equal(await cfbcheck.isProtectedOffice(at('loop.docx', loop)), false, 'a loop');
  const past = Buffer.from(PROTECTED);
  past.writeUInt32LE(4000, 0x30);
  assert.equal(await cfbcheck.isProtectedOffice(at('past.docx', past)), false, 'past the file');
  assert.equal(await cfbcheck.isProtectedOffice(at('zip.docx', BYTES.zip)), false, 'not a compound file');
  await assert.rejects(cfbcheck.isProtectedOffice(path.join(dir, 'none.docx')), { code: 'ENOENT' });
});

test('download tickets: one use, at its address, for its file, within 60 s; four a page and eight a person, read before the thousand in all; a withdrawn take\'s void', () => {
  let now = 1_000_000;
  const book = new downloads.Tickets({ now: () => now });
  const rec = (o = {}) => ({ name: '1700000000000-abcdefghijkl-pack.pdf', filename: 'Board pack.pdf', transferOnly: false, uid: 'ana', address: '10.0.0.5', sid: 's1', hall: 'HALL01', ...o });
  const { ticket } = book.issue(rec());
  assert.match(ticket, /^[A-Za-z0-9_-]{24}$/, '18 random bytes');
  assert.equal(book.take(ticket, { name: rec().name, address: '10.0.0.6' }), null, 'another address');
  assert.equal(book.take(ticket, { name: rec().name, address: '10.0.0.5' }), null, 'spent by the try from another address');
  const t2 = book.issue(rec()).ticket;
  assert.equal(book.take(t2, { name: '1700000000000-abcdefghijkl-other.pdf', address: '10.0.0.5' }), null, 'another file');
  const t3 = book.issue(rec()).ticket;
  now += 60_000;
  assert.equal(book.take(t3, { name: rec().name, address: '10.0.0.5' }), null, 'expired');
  const t4 = book.issue(rec()).ticket;
  assert.equal(book.take(t4, { name: rec().name, address: '10.0.0.5' }).filename, 'Board pack.pdf');
  assert.equal(book.take(t4, { name: rec().name, address: '10.0.0.5' }), null, 'once');
  // Four live for one page, eight for one person; another person's stay live.
  const ben = book.issue(rec({ uid: 'ben', sid: 'b1' })).ticket;
  for (let i = 0; i < 4; i++) assert.ok(book.issue(rec()).ticket);
  assert.deepEqual(book.issue(rec()), { error: 'Finish the downloads already started first.' }, 'a fifth for the page');
  for (let i = 0; i < 4; i++) assert.ok(book.issue(rec({ sid: 's2' })).ticket);
  assert.deepEqual(book.issue(rec({ sid: 's3' })), { error: 'Finish the downloads already started first.' }, 'a ninth for the person');
  assert.ok(book.take(ben, { name: rec().name, address: '10.0.0.5' }), 'another person\'s ticket is still live');
  // Past a thousand live, the oldest goes.
  const many = new downloads.Tickets({ now: () => now });
  const firsts = [];
  for (let i = 0; i < 1001; i++) firsts.push(many.issue(rec({ uid: 'p' + i, sid: 's' + i })).ticket);
  assert.equal(many.size, 1000);
  assert.equal(many.take(firsts[0], { name: rec().name, address: '10.0.0.5' }), null, 'the 1,001st pushed the oldest out');
  assert.ok(many.take(firsts[1], { name: rec().name, address: '10.0.0.5' }));
  // A take's tickets are voided when it is withdrawn; another take's and a message's stay.
  const takes = new downloads.Tickets({ now: () => now });
  const [a, b, c] = [takes.issue(rec({ seq: 7 })).ticket, takes.issue(rec({ seq: 8 })).ticket, takes.issue(rec()).ticket];
  assert.equal(takes.voidTake('HALL01', 7), 1);
  assert.deepEqual([a, b, c].map((x) => !!takes.take(x, { name: rec().name, address: '10.0.0.5' })), [false, true, true]);
});

test('a download saves under the message\'s name with the stored file\'s extension: an ASCII fallback, the true name in filename*, nothing Windows refuses', () => {
  assert.equal(downloads.attachment('Bericht für März.pdf', 'pdf'), 'attachment; filename="Bericht f_r M_rz.pdf"; filename*=UTF-8\'\'Bericht%20f%C3%BCr%20M%C3%A4rz.pdf');
  assert.equal(downloads.attachment('x.cmd', 'txt'), 'attachment; filename="x.txt"; filename*=UTF-8\'\'x.txt', 'its own extension is never kept');
  assert.equal(downloads.attachment('Agenda.cmd', 'txt'), 'attachment; filename="Agenda.txt"; filename*=UTF-8\'\'Agenda.txt');
  assert.equal(downloads.attachment('a"b<c>:d|e?f*g\\h/i.. ', 'pdf'), 'attachment; filename="abcdefghi.pdf"; filename*=UTF-8\'\'abcdefghi.pdf');
  assert.equal(downloads.attachment('', 'zip'), 'attachment; filename="file.zip"; filename*=UTF-8\'\'file.zip');
  assert.equal(downloads.attachment('100% (final)', 'xlsx'), 'attachment; filename="100_ (final).xlsx"; filename*=UTF-8\'\'100%25%20%28final%29.xlsx');
});

test('who may download: the admin, a backstage seat that is not a Viewer account, and On stage a take shown with Download ticked; never an observer or a Viewer', () => {
  const may = pagesLib.mayDownload;
  const ticked = { kind: 'doc', download: true };
  assert.deepEqual([
    may({ admin: true, seat: 'observer' }), may({ seat: 'research' }), may({ seat: 'research', viewer: true }), may({ seat: 'board' }), may({ seat: 'observer' }),
    may({ seat: 'board' }, ticked), may({ seat: 'board' }, { kind: 'doc', download: false }), may({ seat: 'observer' }, ticked), may({ seat: 'board', viewer: true }, ticked), may(null), may({ seat: 'research' }, ticked),
  ], [true, true, false, false, false, true, false, false, false, false, true]);
  // What a page given no file's link is sent: a file message without its address, no `url` key at all; others as they are.
  const file = { id: 'm1', type: 'file', url: '/uploads/1700000000000-abcdefghijkl-a.pdf', filename: 'a.pdf' };
  assert.deepEqual(ops.linkless(file), { id: 'm1', type: 'file', filename: 'a.pdf' });
  assert.ok(!Object.hasOwn(ops.linkless(file), 'url') && file.url, 'the record keeps its address');
  const text = { id: 'm2', type: 'text', text: 'hi' };
  assert.equal(ops.linkless(text), text);
  assert.deepEqual(ops.opLinkless({ o: 'add', s: 3, m: file }), { o: 'add', s: 3, m: { id: 'm1', type: 'file', filename: 'a.pdf' } });
});

// ---------------------------------------------------------------- end to end
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}
/** The download itself: the ticket posted as the hall page's form posts it, from `address` (a tunnel phone's) when given. */
const fetchDownload = (base, url, body, { address = '', type = 'application/x-www-form-urlencoded' } = {}) => fetch(base + url + '/download', {
  method: 'POST', headers: { 'Content-Type': type, ...(address ? { 'cf-connecting-ip': address } : {}) }, body, redirect: 'manual',
});

test('a file shared is a download: the server\'s name and size on the message, a ticket per seat that may download, the file by its ticket alone, every other outcome 204; observers and Viewer accounts are never given its link, a seat moved to observer in the same tick; a file moves to another room only from a seat that may download it', { timeout: 120_000 }, async (t) => {
  const uploads = tmp('agm-dl-');
  const srv = await startServer({ AGM_UPLOAD_DIR: uploads });
  t.after(async () => { await stopServer(srv.child); fs.rmSync(uploads, { recursive: true, force: true }); });
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, extra) => {
    const s = await connect(srv.base, cookie, extra);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    return s;
  };
  const joined = async (s, args) => {
    const j = await emit(s, 'join', args && args.role === 'board' && !args.as ? { ...args, invite: inviteOf(srv.dataDir, args.roomCode) } : args);
    assert.equal(j.ok, true, JSON.stringify(j));
    return j;
  };
  const events = (s, ev) => heard.get(s).filter(([e]) => e === ev).map(([, p]) => p);
  const upload = async (token, name, bytes) => {
    const f = new FormData();
    f.append('file', new Blob([bytes]), name);
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, ...(await r.json()) };
  };
  const admin = (await setupAdmin(srv.base, { username: 'ada', name: 'Ada Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 5' }, { cookie: admin })).body.code;
  const other = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 6' }, { cookie: admin })).body.code;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const ctl = await page(admin);
  const ctlJoin = await joined(ctl, { roomCode: hall, as: 'account' });
  const ana = await page();
  const anaJoin = await joined(ana, { roomCode: hall, name: 'Ana', role: 'research' });
  const obi = await page();
  const obiJoin = await joined(obi, { roomCode: hall, name: 'Obi', role: 'observer' });
  const bea = await page();
  await joined(bea, { roomCode: hall, name: 'Bea', role: 'board' });
  // A Viewer account given the rights to post and share files sits backstage, and is still never given a file's link.
  const vic = await page(await account('vic', 'Vic Viewer', 'viewer', { halls: [hall, other], grant: ['hall.post', 'hall.files'] }));
  const vicJoin = await joined(vic, { roomCode: hall, as: 'account' });
  assert.equal(vicJoin.role, 'research', 'a Viewer granted hall.post sits backstage');

  // Shared under the name it was uploaded with, whatever the post says, with its size; never transfer-only for a stage type.
  const up = await upload(anaJoin.uploadToken, 'Board pack.txt', 'Capex: 4.2m');
  assert.equal(up.status, 200, JSON.stringify(up));
  assert.deepEqual([up.transferOnly, up.size], [false, 11]);
  const sent = await act(ana, 'message', { type: 'file', url: up.url, filename: 'Final approved budget.pdf', mime: 'application/pdf', caption: 'v4' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await until(() => events(obi, 'message').some((m) => m.id === sent.id) && events(vic, 'message').some((m) => m.id === sent.id) && events(ana, 'message').some((m) => m.id === sent.id), 4000, 'the file message heard');
  const anaSaw = events(ana, 'message').find((m) => m.id === sent.id);
  assert.deepEqual([anaSaw.filename, anaSaw.size, anaSaw.mime, anaSaw.url, Object.hasOwn(anaSaw, 'transferOnly')], ['Board pack.txt', 11, 'text/plain', up.url, false], 'the server\'s name, its size');
  for (const s of [obi, vic]) {
    const m = events(s, 'message').find((x) => x.id === sent.id);
    assert.ok(!Object.hasOwn(m, 'url'), 'an observer and a Viewer account are sent no url key at all');
    assert.deepEqual([m.filename, m.size, m.caption], ['Board pack.txt', 11, 'v4'], 'the card is whole but for the link');
  }
  assert.equal(events(bea, 'message').find((m) => m.id === sent.id).url, up.url, 'On stage holds the link: its Look reads it');
  // A post again of the same file keeps its first name.
  const again = await act(ana, 'message', { type: 'file', url: up.url, filename: 'Renamed.txt' });
  await until(() => events(ana, 'message').some((m) => m.id === again.id), 4000, 'heard');
  assert.equal(events(ana, 'message').find((m) => m.id === again.id).filename, 'Board pack.txt');

  // A join's history and files: whole for a backstage page, without the link for an observer's and a Viewer's.
  const obi2 = await page();
  const obi2Join = await joined(obi2, { roomCode: hall, name: 'Obi', role: 'observer', uid: obiJoin.identity });
  const fileIn = (j) => j.history.find((m) => m.id === sent.id);
  assert.ok(!Object.hasOwn(fileIn(obi2Join), 'url') && obi2Join.files.every((f) => !Object.hasOwn(f, 'url')), 'an observer\'s join holds no link');
  const vic2 = await page(await api(srv.base, 'POST', '/api/auth/login', { username: 'vic', password: PASSWORD }).then((r) => r.cookie));
  const vic2Join = await joined(vic2, { roomCode: hall, as: 'account' });
  assert.ok(!Object.hasOwn(fileIn(vic2Join), 'url') && vic2Join.files.every((f) => !Object.hasOwn(f, 'url')), 'nor a Viewer account\'s');
  const ana2 = await page();
  const ana2Join = await joined(ana2, { roomCode: hall, name: 'Ana', role: 'research', uid: anaJoin.identity });
  assert.equal(fileIn(ana2Join).url, up.url);
  // A resume and a read back are withheld the same way.
  const resumed = await emit(obi2, 'join', { roomCode: hall, name: 'Obi', role: 'observer', uid: obiJoin.identity, since: 0 });
  const added = (resumed.ops || []).find((op) => op.o === 'add' && op.m.id === sent.id);
  assert.ok(added && !Object.hasOwn(added.m, 'url'), 'a resume\'s ops');
  assert.ok(!Object.hasOwn((await act(obi2, 'history:message', { messageId: sent.id })).message, 'url'), 'a message read by its id');
  assert.equal((await act(ana2, 'history:message', { messageId: sent.id })).message.url, up.url);
  const readBack = async (s) => (await act(s, 'history:before', { beforeSeq: 1_000_000 })).history.find((m) => m.id === sent.id);
  assert.ok(!Object.hasOwn(await readBack(obi2), 'url') && !Object.hasOwn(await readBack(vic2), 'url'), 'earlier messages read back');
  assert.equal((await readBack(ana2)).url, up.url);

  // A ticket: a backstage seat and the admin; never an observer or a Viewer account; On stage, a take's alone.
  const ticketOf = (s, args) => act(s, 'file:download', args);
  assert.deepEqual(await ticketOf(obi, { messageId: sent.id }), { ok: false, error: 'Downloads are for the backstage team.' });
  assert.deepEqual(await ticketOf(vic, { messageId: sent.id }), { ok: false, error: 'Downloads are for the backstage team.' });
  assert.deepEqual(await ticketOf(bea, { messageId: sent.id }), { ok: false, error: 'On stage tablets keep no copies — ask the backstage team to show it to you with Download ticked.' });
  assert.deepEqual(await ticketOf(ana, { messageId: sent.id, seq: 1 }), { ok: false, error: 'Say what to download: a file of this room (messageId), or something shown to you with Download (seq).' });
  assert.deepEqual(await ticketOf(ana, { messageId: 'nope' }), { ok: false, error: 'Message not found' });
  const got = await ticketOf(ana, { messageId: sent.id });
  assert.deepEqual([got.ok, got.name, got.size, typeof got.ticket], [true, 'Board pack.txt', 11, 'string'], JSON.stringify(got));
  assert.equal((await ticketOf(ctl, { messageId: sent.id })).ok, true, 'the admin');
  // The file, by its ticket alone: an attachment under its name, no-store, nosniff; told to the page that asked.
  const res = await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(got.ticket));
  assert.equal(res.status, 200);
  assert.deepEqual([res.headers.get('content-disposition'), res.headers.get('cache-control'), res.headers.get('x-content-type-options'), res.headers.get('content-type')],
    ['attachment; filename="Board pack.txt"; filename*=UTF-8\'\'Board%20pack.txt', 'private, no-store', 'nosniff', 'text/plain; charset=utf-8']);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await res.text(), 'Capex: 4.2m');
  await until(() => events(ana, 'file:sent').some((x) => x.ticket === got.ticket), 4000, 'file:sent');
  assert.deepEqual([events(ana, 'file:sending'), events(ana, 'file:sent')].map((l) => l.map((x) => x.ticket)), [[got.ticket], [got.ticket]], 'the page that asked is told, in order');
  assert.ok(!events(ctl, 'file:sending').length, 'and no other');
  // Every other outcome is 204, never a JSON answer in the hall page's place: a second use, another address, another file,
  // a field twice, a body over 1 KB, a third field, no field, JSON.
  const fresh = async () => (await ticketOf(ana, { messageId: sent.id })).ticket;
  const t1 = await fresh();
  const other204 = [
    ['a second use', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(got.ticket))],
    ['another address', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(t1), { address: '203.0.113.9' })],
    ['spent by that try', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(t1))],
    ['another file', await fetchDownload(srv.base, '/uploads/1700000000000-abcdefghijkl-other.txt', 't=' + encodeURIComponent(await fresh()))],
    ['t twice', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(await fresh()) + '&t=x')],
    ['over 1 KB', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(await fresh()) + '&x=' + 'a'.repeat(2048))],
    ['three fields', await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(await fresh()) + '&a=1&b=2')],
    ['no field', await fetchDownload(srv.base, up.url, '')],
    ['JSON', await fetchDownload(srv.base, up.url, '{"t": "x"', { type: 'application/json' })],
  ];
  for (const [why, r] of other204) {
    assert.equal(r.status, 204, why);
    assert.equal(await r.text(), '', why + ': no body');
  }

  // A seat moved to observer is sent the next file without its link in the same tick, though its page ignores roleChanged.
  const rexJoin = await joined(await page(), { roomCode: hall, name: 'Rex', role: 'research' });
  const rex = sockets.at(-1);
  const users = await act(ctl, 'admin:watchRoom', { roomCode: hall });
  const rexSid = users.users.find((u) => u.name === 'Rex').socketId;
  assert.ok((await act(ctl, 'admin:setRole', { roomCode: hall, socketId: rexSid, role: 'observer' })).ok);
  const up2 = await upload(anaJoin.uploadToken, 'Rider.txt', 'Two bottles of water.');
  const sent2 = await act(ana, 'message', { type: 'file', url: up2.url });
  await until(() => events(rex, 'message').some((m) => m.id === sent2.id), 4000, 'Rex heard the file');
  assert.ok(!Object.hasOwn(events(rex, 'message').find((m) => m.id === sent2.id), 'url'), 'moved to observer: no link');
  assert.ok(rexJoin.uploadToken);

  // A file moves to another room only from a seat that may download it here: a code guest observing here and backstage in
  // the other hall is refused, as is a Viewer account backstage; text still moves, and the backstage team moves files with
  // their size.
  const gus = await page();
  const gusJoin = await joined(gus, { roomCode: other, name: 'Gus', role: 'research' });
  const gusHere = await page();
  await joined(gusHere, { roomCode: hall, name: 'Gus', role: 'observer', uid: gusJoin.identity });
  assert.deepEqual(await act(gusHere, 'forward', { messageId: sent.id, targetRoom: other }), { ok: false, error: 'Files are moved by the backstage team.' });
  await joined(vic2, { roomCode: other, as: 'account' });   // Vic is in the other hall too, backstage there
  assert.deepEqual(await act(vic, 'forward', { messageId: sent.id, targetRoom: other }), { ok: false, error: 'Files are moved by the backstage team.' });
  assert.deepEqual(await act(bea, 'forward', { messageId: sent.id, targetRoom: other }), { ok: false, error: 'Messages from On stage stay in this room.' }, 'On stage, every forward');
  await joined(await page(admin), { roomCode: other, as: 'account' });   // the admin is in the other hall too
  const moved = await act(ctl, 'forward', { messageId: sent.id, targetRoom: other });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  await until(() => events(gus, 'message').some((m) => m.id === moved.id), 4000, 'forwarded');
  const fwd = events(gus, 'message').find((m) => m.id === moved.id);
  assert.deepEqual([fwd.filename, fwd.size, fwd.url], ['Board pack.txt', 11, up.url]);
  // The forward's picker answers by the forward's rule: a Viewer account backstage is offered no hall for a file, and told
  // why; a text it may still take there.
  assert.deepEqual(await act(vic, 'myRooms', { messageId: sent.id }), { ok: true, rooms: [], why: 'Files are moved by the backstage team.' });
  const said = await act(ana, 'message', { type: 'text', text: 'Doors at seven.' });
  assert.deepEqual((await act(vic, 'myRooms', { messageId: said.id })).rooms.map((r) => r.code), [other], 'a text may go');
  // A file to transfer only moves as one: its copy is transfer-only, with its size.
  const zipUp = await upload(anaJoin.uploadToken, 'Stems.zip', BYTES.zip);
  assert.deepEqual([zipUp.status, zipUp.transferOnly], [200, true], JSON.stringify(zipUp));
  const zipSent = await act(ana, 'message', { type: 'file', url: zipUp.url });
  const zipMoved = await act(ctl, 'forward', { messageId: zipSent.id, targetRoom: other });
  assert.equal(zipMoved.ok, true, JSON.stringify(zipMoved));
  await until(() => events(gus, 'message').some((m) => m.id === zipMoved.id), 4000, 'the zip forwarded');
  const zipFwd = events(gus, 'message').find((m) => m.id === zipMoved.id);
  assert.deepEqual([zipFwd.filename, zipFwd.size, zipFwd.transferOnly], ['Stems.zip', BYTES.zip.length, true]);

  // room:send moves a file by the same rule. Hall 5 may send into Hall 6: a Viewer account is refused a file and sends a
  // text; Ana's file reaches Hall 6 transfer-only with its size, without its link for the observer seated there, and the
  // copy kept here reaches Hall 5's observer without it too.
  assert.equal((await act(ctl, 'room:update', { code: other, sendFrom: [hall] })).ok, true);
  const oli = await page();
  await joined(oli, { roomCode: other, name: 'Oli', role: 'observer' });
  const intoOther = (await act(ana, 'room:sendTargets', {})).targets;
  assert.deepEqual(intoOther.map((x) => x.hallName), ['Hall 6']);
  const to = intoOther[0].ref;
  assert.deepEqual(await act(vic, 'room:send', { to, messageId: sent.id }), { ok: false, error: 'Files are moved by the backstage team.' });
  assert.equal((await act(vic, 'room:send', { to, messageId: said.id })).ok, true, 'a text');
  const across = await act(ana, 'room:send', { to, messageId: zipSent.id });
  assert.equal(across.ok, true, JSON.stringify(across));
  const landed = (s) => events(s, 'message').find((m) => m.sentFrom && m.filename === 'Stems.zip');
  await until(() => landed(oli) && landed(gus) && events(obi, 'message').some((m) => m.id === across.id), 4000, 'the file sent into Hall 6');
  assert.deepEqual([landed(gus).url, landed(gus).size, landed(gus).transferOnly], [zipUp.url, BYTES.zip.length, true]);
  assert.ok(!Object.hasOwn(landed(oli), 'url'), 'the observer seated there is sent no link');
  assert.deepEqual([landed(oli).size, landed(oli).transferOnly], [BYTES.zip.length, true], 'the card is whole but for the link');
  const keptHere = events(obi, 'message').find((m) => m.id === across.id);
  assert.ok(keptHere.sentTo && !Object.hasOwn(keptHere, 'url'), 'nor the copy kept here, to Hall 5\'s observer');

  // The admin page downloads a file of the room it watches, seated nowhere, by its message.
  const desk = await page(admin);
  assert.equal((await act(desk, 'admin:watchRoom', { roomCode: hall })).ok, true);
  assert.deepEqual(await act(desk, 'file:download', { seq: 1 }), { ok: false, error: 'Say what to download: a file of this room (messageId), or something shown to you with Download (seq).' }, 'by its message alone');
  const deskGot = await act(desk, 'file:download', { messageId: sent.id });
  assert.deepEqual([deskGot.ok, deskGot.name, deskGot.size], [true, 'Board pack.txt', 11], JSON.stringify(deskGot));
  const deskRes = await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(deskGot.ticket));
  assert.deepEqual([deskRes.status, await deskRes.text()], [200, 'Capex: 4.2m']);
  await until(() => events(desk, 'file:sent').some((x) => x.ticket === deskGot.ticket), 4000, 'the admin page is told');

  // The support view: a file a person opens follows them there; one the support view opens reaches nobody.
  const support = await page(admin);
  await joined(support, { roomCode: hall, name: 'Ana', role: 'research', adminView: true, viewOf: anaJoin.uid });
  ana.emit('userState:push', { key: 'doc', value: { messageId: sent.id } });   // a relay: it answers nothing
  await until(() => events(support, 'userState:push').length > 0, 4000, 'the support view follows the person');
  assert.deepEqual(events(support, 'userState:push').at(-1), { key: 'doc', value: { messageId: sent.id } });
  assert.ok(events(ana2, 'userState:push').some((p) => p.key === 'doc'), 'and their other page');
  const anaHeard = events(ana, 'userState:push').length;
  support.emit('userState:push', { key: 'doc', value: { messageId: sent2.id } });
  await wait(400);
  assert.equal(events(ana, 'userState:push').length, anaHeard, 'the support view opens nothing on the person\'s panel');
  assert.ok(!events(ana2, 'userState:push').some((p) => p.value && p.value.messageId === sent2.id), 'on none of their pages');

  // A take shown with Download ticked: a ticket On stage too, by its number; without the tick, or withdrawn, none.
  const plain = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url } });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.deepEqual(await ticketOf(bea, { seq: plain.seq }), { ok: false, error: 'This was shown without Download.' });
  const ticked = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, download: true } });
  const beaGot = await ticketOf(bea, { seq: ticked.seq });
  assert.deepEqual([beaGot.ok, beaGot.name, beaGot.size], [true, 'Board pack.txt', 11], JSON.stringify(beaGot));
  assert.deepEqual(await ticketOf(obi, { seq: ticked.seq }), { ok: false, error: 'Downloads are for the backstage team.' });
  assert.deepEqual(await ticketOf(ana, { seq: ticked.seq }), { ok: false, error: 'That is not on your pages now.' }, 'not shown to Ana');
  assert.deepEqual(await ticketOf(bea, { seq: plain.seq }), { ok: false, error: 'This was shown without Download.' }, 'under Earlier now, still without');
  const spare = (await ticketOf(bea, { seq: ticked.seq })).ticket;
  assert.ok((await act(ctl, 'page:withdraw', { code: hall, seq: ticked.seq })).ok);
  assert.deepEqual(await ticketOf(bea, { seq: ticked.seq }), { ok: false, error: 'This was withdrawn.' });
  assert.equal((await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(spare))).status, 204, 'its ticket voided');
  const beaRes = await fetchDownload(srv.base, up.url, 't=' + encodeURIComponent(beaGot.ticket));
  assert.equal(beaRes.status, 204, 'every ticket of a withdrawn take');
  assert.ok(ctlJoin.ok);
});

test('files to transfer only: taken with their first bytes checked, never read by a GET, a take or a screen, downloaded as application/octet-stream; a protected Office file decided by its directory, before and after a restart', { timeout: 120_000 }, async (t) => {
  const uploads = tmp('agm-tr-');
  let srv = await startServer({ AGM_UPLOAD_DIR: uploads });
  t.after(async () => { await stopServer(srv.child); fs.rmSync(uploads, { recursive: true, force: true }); });
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 7' }, { cookie: admin })).body.code;
  /** A page through the tunnel from its own address, so each has the upload rate of a network of its own. */
  let n = 0;
  const phone = async (name) => {
    const address = '198.51.100.' + (++n);
    const s = await connect(srv.base, undefined, { headers: { 'cf-connecting-ip': address, 'cf-ray': '8f00bb' + n } });
    sockets.push(s);
    const j = await emit(s, 'join', { roomCode: hall, name, role: 'research' });
    assert.equal(j.ok, true, JSON.stringify(j));
    return { s, j, address };
  };
  const upload = async (token, name, bytes) => {
    const f = new FormData();
    f.append('file', new Blob([bytes]), name);
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, ...(await r.json()) };
  };
  const ctl = await connect(srv.base, admin);
  sockets.push(ctl);
  assert.ok((await emit(ctl, 'join', { roomCode: hall, name: 'Admin', role: 'research' })).ok);
  // Each type, from a phone of its own: taken transfer-only, its message saying so, its type octet-stream.
  const taken = {};
  for (const [ext, bytes] of [...Object.entries(BYTES), ['mp3', MP3_FRAME], ['docx', PROTECTED]]) {
    const { s, j, address } = await phone('P' + n);
    const up = await upload(j.uploadToken, 'Pack.' + ext, bytes);
    assert.deepEqual([up.status, up.transferOnly, up.mime], [200, true, 'application/octet-stream'], ext + ': ' + JSON.stringify(up));
    const posted = await act(s, 'message', { type: 'file', url: up.url });
    assert.equal(posted.ok, true, ext);
    taken[ext] = { url: up.url, id: posted.id, s, address };
  }
  // The wrong first bytes, and a compound file that is a Word 97 document or carries macros, or whose directory lies past
  // what the check reads, are refused with the words; nothing is kept of them.
  const before = fs.readdirSync(uploads).length;
  const { j: wrong } = await phone('W');
  for (const [name, bytes] of [['Pack.zip', 'not a zip at all'], ['Clip.mov', Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moov', 'latin1'), Buffer.alloc(8)])],
    ['Agenda.docx', cfbOf([['WordDocument', 2], ['EncryptionInfo', 2], ['EncryptedPackage', 2]])], ['Budget.xlsx', cfbOf([['Macros', 1], ['EncryptionInfo', 2], ['EncryptedPackage', 2]])]]) {
    const r = await upload(wrong.uploadToken, name, bytes);
    assert.deepEqual([r.status, r.error], [400, 'That file\'s contents don\'t match its type, so it wasn\'t shared.'], name);
  }
  const { j: wrong2 } = await phone('W2');
  for (const [name, bytes] of [['Deck.pptx', cfbOf([['_VBA_PROJECT_CUR', 1], ['EncryptionInfo', 2], ['EncryptedPackage', 2]])], ['Long.docx', cfbOf([['EncryptionInfo', 2], ['EncryptedPackage', 2]], { dirSectors: 140 })]]) {
    const r = await upload(wrong2.uploadToken, name, bytes);
    assert.deepEqual([r.status, r.error], [400, 'That file\'s contents don\'t match its type, so it wasn\'t shared.'], name);
  }
  const unsupported = await upload(wrong2.uploadToken, 'run.exe', 'MZ');
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.error, /zip, MP4, M4A, MOV, MP3, WAV and OpenDocument files can be shared for download/);
  await wait(200);
  assert.equal(fs.readdirSync(uploads).length, before, 'nothing refused is kept');

  // Never read by a GET (404, by its extension or its first bytes), nor shown on the stage or a screen.
  for (const [ext, f] of Object.entries(taken)) {
    assert.equal((await fetch(srv.base + f.url)).status, 404, ext + ' GET');
    const pushed = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: f.url } });
    assert.deepEqual(pushed, { ok: false, error: 'That file is for download only: AGMessage does not open it.' }, ext + ' as a take');
  }
  // A screen shows images and PDF pages alone: neither a file to transfer nor a protected Office file reaches one.
  for (const f of [taken.zip, taken.mp4, taken.docx]) {
    for (const content of [{ kind: 'file', url: f.url }, { kind: 'holding', image: f.url }]) {
      const r = await act(ctl, 'display:take', { id: 'any', content });
      assert.equal(r.ok, false, f.url + ' ' + content.kind);
      assert.match(r.error, content.kind === 'file' ? /^A screen shows images and PDF pages/ : /^A holding image is a PNG, JPEG, GIF or WebP/);
    }
  }
  // Downloaded by a ticket alone, as application/octet-stream, under its name.
  const zip = taken.zip;
  const tk = await act(zip.s, 'file:download', { messageId: zip.id });
  const res = await fetchDownload(srv.base, zip.url, 't=' + encodeURIComponent(tk.ticket), { address: zip.address });
  assert.deepEqual([res.status, res.headers.get('content-type'), res.headers.get('content-disposition')], [200, 'application/octet-stream', 'attachment; filename="Pack.zip"; filename*=UTF-8\'\'Pack.zip']);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(BYTES.zip));
  const dtk = await act(taken.docx.s, 'file:download', { messageId: taken.docx.id });
  const dres = await fetchDownload(srv.base, taken.docx.url, 't=' + encodeURIComponent(dtk.ticket), { address: taken.docx.address });
  assert.deepEqual([dres.status, dres.headers.get('content-type')], [200, 'application/octet-stream'], 'a protected Word file too');
  await dres.arrayBuffer();
  // After a restart the protected file is still never read by a GET: its first bytes decide, not a record.
  srv = await restartServer(srv, { AGM_UPLOAD_DIR: uploads });
  assert.equal((await fetch(srv.base + taken.docx.url)).status, 404, 'after a restart');
  assert.equal((await fetch(srv.base + taken.zip.url)).status, 404);
});
