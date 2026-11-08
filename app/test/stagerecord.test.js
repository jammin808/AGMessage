'use strict';
// The stage record (lib/stagerecord.js, plan 4-§5.13): what was shown on people's pages, hall by hall, for the transcript
// and the minutes. Each accepted take is one entry (who, from which seat, for whom, the layer, the kind, what it showed in
// the console's words, a quote's words), a take-down one too; `seen` written once, when every page that held it reported
// or at the deadline; a line sent with it and a withdrawal kept on its entry, which stays; 501 entries keep 500 and count
// the one that went; nothing written before the record is read, each hall through a lane of its own (mode 0600); a Main
// reset clears it and a side room's drops the entries sent from it, neither leaving the words in the `.bak`, and a record
// that could not be read says it was not cleared; a hall removed takes its file and `.bak`, and the boot sweep the record
// of a hall that no longer exists, never of one whose files could not be read at that start. End to end: the record a
// server keeps, its lanes in health, a restart, the transcript's interleaving and the minutes' prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StageRecord, entryOf, storedEntry, confidentialOf, whoSaid, didSaid, seenSaid, MAX, SEEN_MS } = require('../lib/stagerecord');
const { WriteLane } = require('../lib/resilience');
const { uploadRef } = require('../lib/pages');
const ai = require('../lib/ai');
const { startServer, restartServer, stopServer, api, connect, emit, wait, until, pngOf, inviteOf, fakeStagewatch, setupAdmin } = require('./helpers');

const HALL = 'HALLA1';
const LEGAL = 'LEGALKEY';
const dirs = [];
const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-stage-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A take as the pages' store numbers it (lib/pages.js Pages#take). */
const take = (seq, content, extra = {}) => ({ seq, content, by: { name: 'Ana Silva', op: false }, at: 1_700_000_000_000 + seq * 1000, ...extra });
const CELL = { kind: 'snippet', unit: 'cell', table: { rows: [['', 'Q3'], ['Revenue', '£4.2m']], head: 1, side: 1, ref: 'C4', focus: [1, 1] }, from: { name: 'Q3.xlsx', type: 'xlsx', at: { sheet: 1, ref: '\'Sheet1\'!C4' } } };
const ROWS = { kind: 'snippet', unit: 'range', table: { rows: [['Item', 'Q3', 'Q4'], ['Revenue', '4.2', '4.4'], ['Costs', '3.9', '']], head: 1, side: 1 } };
/** The file a record keeps for a hall, read as text (a data file of the test's own, never the checkout's). */
const onDisk = (dir, hall = HALL) => fs.readFileSync(path.join(dir, hall + '.json'), 'utf8');
/** A record in a folder of its own, read (so it writes), its lanes quick. */
async function record(o = {}) {
  const dir = o.dir || folder();
  const r = new StageRecord(dir, { delayMs: 5, ...o });
  await r.load(o.exists);
  r.dir = dir;
  return r;
}
/** Every lane of a record written now. */
const flush = (r) => { for (const [, lane] of r.lanes()) assert.ok(lane.flushSync(), 'written'); };

test('an entry is a take as it was asked: who and from which seat, for whom, the layer, the kind, what it showed in the console\'s words, a quote\'s words; a web page by its host alone; a side room it was sent from or shows', () => {
  const cell = entryOf(take(7, CELL), { to: 'board', role: 'research' });
  assert.deepEqual(cell, {
    seq: 7, at: 1_700_000_007_000, by: { name: 'Ana Silva', role: 'research' }, to: 'board', layer: 'info', kind: 'snippet',
    what: '❝ a table cell from Q3.xlsx, \'Sheet1\'!C4', text: 'Q3\nRevenue · £4.2m',
  });
  // A table's cells joined by " · ", its rows by line breaks, in reading order.
  assert.equal(entryOf(take(8, ROWS)).text, 'Item · Q3 · Q4\nRevenue · 4.2 · 4.4\nCosts · 3.9');
  // A web page: its host, never its address (the store keeps it sealed; the record never holds it at all).
  const web = entryOf(take(9, { kind: 'web', host: 'vote.example.com', urlSealed: 'enc1:c2VhbGVk' }), { to: 'u:ugil', name: 'Gil' });
  assert.deepEqual([web.what, web.to, web.layer, Object.hasOwn(web, 'text')], ['a web page on vote.example.com', { name: 'Gil' }, 'info', false]);
  assert.ok(!JSON.stringify(web).includes('enc1:'), 'no address, sealed or not');
  // A take-down, back to chat and a show take: each its layers.
  assert.deepEqual([entryOf(take(10, { kind: 'chat', layer: 'info' })), entryOf(take(11, { kind: 'chat' })), entryOf(take(12, { kind: 'clock' }))].map((e) => [e.layer, e.kind, e.what]),
    [['info', 'chat', 'the information taken down'], ['both', 'chat', 'back to chat'], ['show', 'clock', 'the clock']]);
  // A push sent from a side room, of a file of that room: both rooms kept, by key and name; a seat it does not know left out.
  const sent = entryOf(take(13, { kind: 'doc', url: '/uploads/1700000000000-abcdefghijkl-pack.pdf', name: 'Board pack.pdf', at: { page: 12 }, download: false, room: LEGAL, roomName: 'Legal' }, { sent: { key: LEGAL, name: 'Legal' } }), { role: 'nobody' });
  assert.deepEqual([sent.sentFrom, sent.from, sent.what, sent.by], [{ key: LEGAL, name: 'Legal' }, { room: LEGAL, name: 'Legal' }, 'Board pack.pdf in Legal at p. 12', { name: 'Ana Silva' }]);
  assert.ok(!JSON.stringify(sent).includes('/uploads/'), 'no file address');
  // A picture of a page: whose picture of what, and the room of the file it was made from.
  const pic = entryOf(take(14, { kind: 'image', url: '/uploads/1700000000000-abcdefghijkl-p12.png', name: 'p12.png', from: { name: 'Board pack.pdf', type: 'pdf', at: { page: 12 }, room: LEGAL, roomName: 'Legal' } }));
  assert.deepEqual([pic.what, pic.from], ['Ana Silva\'s picture of Board pack.pdf in Legal, p. 12', { room: LEGAL, name: 'Legal' }]);
  // Read back whole, and a field of the wrong shape refuses the entry.
  for (const e of [cell, web, sent, pic, { ...cell, line: { text: 'Revenue Q3: £4.2m', via: 'now' }, seen: { shown: 5, of: 6, standin: 2 }, withdrawn: 1_700_000_009_000 }]) assert.deepEqual(storedEntry(JSON.parse(JSON.stringify(e))), e);
  for (const bad of [{ ...cell, seq: 0 }, { ...cell, by: { name: 5 } }, { ...cell, by: { name: 'A', role: 'chair' } }, { ...cell, to: 'everyone' }, { ...cell, layer: 'over' }, { ...cell, kind: 'brand' }, { ...cell, text: 7 },
    { ...web, text: 'words on a page that is no quote' }, { ...cell, line: { text: 'x', via: 'later' } }, { ...cell, seen: { shown: 3, of: 2 } }, { ...cell, seen: { shown: 2, of: 2, standin: 0 } }, { ...cell, sentFrom: { key: 'no', name: 'x' } }, { ...cell, withdrawn: 'soon' }, null, []]) {
    assert.equal(storedEntry(bad), null, JSON.stringify(bad));
  }
});

test('an entry keeps the uploads it shows or was made from by their references, the server\'s alone: a mark set on one later makes it confidential as it is read, and no reader is given them', () => {
  const doc = '1730000000000-abcdefghijkl-advice.pdf';
  const pic = '1730000000000-abcdefghijkl-advice-p1.png';
  const shown = entryOf(take(3, { kind: 'doc', url: '/uploads/' + doc, name: 'Legal advice.pdf', standin: { url: '/uploads/' + pic } }));
  assert.deepEqual(shown.uploads, [uploadRef(doc), uploadRef(pic)]);
  assert.ok(!JSON.stringify(shown.uploads).includes('advice'), 'never an address');
  const quoted = entryOf(take(4, { ...CELL, from: { name: 'Q3.xlsx', type: 'xlsx' } }, { made: [uploadRef(doc)] }));
  assert.deepEqual(quoted.uploads, [uploadRef(doc)]);
  assert.equal(entryOf(take(5, ROWS)).uploads, undefined, 'a typed quote names none');
  assert.deepEqual(storedEntry(quoted), quoted, 'read back with them');
  for (const bad of [[], ['../escape'], [doc], Array(4).fill(uploadRef(doc)), 'x']) assert.equal(storedEntry({ ...quoted, uploads: bad }), null, JSON.stringify(bad));
  const read = confidentialOf([shown, quoted, entryOf(take(5, ROWS))], (r) => r === uploadRef(doc));
  assert.deepEqual(read.map((e) => e.confidential === true), [true, true, false]);
  assert.ok(read.every((e) => !Object.hasOwn(e, 'uploads')), 'no reader is given them');
  assert.deepEqual(confidentialOf([quoted], () => false)[0].confidential, undefined);
});

test('the transcript\'s words for an entry: who and from which seat, what they did for whom, and what the pages reported', () => {
  const e = entryOf(take(7, CELL), { role: 'research' });
  assert.equal(whoSaid(e), 'Ana Silva (backstage)');
  assert.equal(whoSaid({ ...e, by: { name: 'Margaret Lowe', role: 'board' } }), 'Margaret Lowe (On stage)');
  assert.equal(whoSaid({ ...e, by: { name: 'Ben', role: 'admin' } }), 'Ben (admin)');
  assert.equal(whoSaid({ ...e, by: { name: '' } }), 'Someone');
  assert.equal(didSaid(e), 'showed the Board');
  assert.equal(didSaid({ ...e, seen: { shown: 6, of: 6 } }), 'showed the Board (6 pages)');
  assert.equal(didSaid({ ...e, to: { name: 'Gil' }, seen: { shown: 1, of: 1 } }), 'showed Gil (1 page)');
  assert.equal(didSaid({ ...e, kind: 'chat', layer: 'info' }), 'took the information down on the Board\'s pages');
  assert.equal(didSaid({ ...e, kind: 'chat', layer: 'both', to: { name: 'Gil' } }), 'put Gil\'s pages back to chat');
  assert.deepEqual([{ shown: 6, of: 6 }, { shown: 4, of: 6 }, { shown: 6, of: 6, standin: 2 }, { shown: 0, of: 0 }, undefined].map((s) => seenSaid(s)),
    ['✓ on 6 of 6', 'on 4 of 6 within 10 s', '✓ on 6 of 6, 2 as a picture', 'no page of theirs was open', '']);
  assert.equal(SEEN_MS, 10_000);
  // The minutes' lines (lib/ai.js shownText): the record's words, a quote's on one line, a line on the speaker's screen.
  const lines = ai.shownText([{ ...e, at: Date.UTC(2026, 10, 6, 14, 2), line: { text: 'Revenue Q3: £4.2m', via: 'now' }, seen: { shown: 6, of: 6 } }, { ...entryOf(take(8, { kind: 'chat', layer: 'info' })), at: Date.UTC(2026, 10, 6, 14, 3), withdrawn: Date.UTC(2026, 10, 6, 14, 4) }]);
  assert.equal(lines, '[14:02] Ana Silva showed the Board: a table cell from Q3.xlsx, \'Sheet1\'!C4 — "Q3 / Revenue · £4.2m"; on the speaker\'s screen: "Revenue Q3: £4.2m" (on 6 of 6 pages)\n'
    + '[14:03] Ana Silva took the information down on the Board\'s pages; withdrawn at 14:04');
  assert.equal(ai.shownText([]), '');
  // Every entry is given; those the record no longer keeps are counted before them.
  assert.equal(ai.shownText([{ ...e, at: Date.UTC(2026, 10, 6, 14, 2) }], 12), '(12 earlier entries of the hall\'s record are no longer kept, so not included)\n[14:02] Ana Silva showed the Board: a table cell from Q3.xlsx, \'Sheet1\'!C4 — "Q3 / Revenue · £4.2m"');
  assert.equal(ai.shownText([], 1), '(1 earlier entry of the hall\'s record is no longer kept, so not included)');
  assert.equal(ai.shownText(Array.from({ length: 300 }, (_, i) => ({ ...e, seq: i + 1 }))).split('\n').length, 300, 'every entry, none left out');
});

test('a hall\'s record: nothing written before it is read; one lane a hall, mode 0600; `seen` once, when every page reported or at the deadline; a line and a withdrawal on the entry, which stays; 501 entries keep 500', async () => {
  const dir = folder();
  const r = new StageRecord(dir, { delayMs: 5, seenMs: 600 });
  // Asked before it is read: kept in order, written once it is.
  r.shown(HALL, take(1, CELL), { role: 'research', pages: [{ sid: 's1', docs: true }, { sid: 's2', docs: true }] });
  assert.deepEqual(r.lanes(), [], 'no lane before the record is read');
  // A read asked before the record is read waits for it, and is answered after what was asked before it.
  const early = r.of(HALL);
  const cleared = r.clear('HALLB2');
  await wait(30);
  assert.ok(!fs.existsSync(path.join(dir, HALL + '.json')), 'nothing written before it is read');
  await r.load();
  assert.deepEqual([(await early).entries.map((e) => e.seq), await cleared], [[1], { cleared: 0, unread: '' }], 'answered once it is read');
  assert.deepEqual(r.lanes().map(([n]) => n), ['stage ' + HALL], 'one lane, named by its hall');
  flush(r);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, HALL + '.json')).mode & 0o777, 0o600, 'mode 0600');
  let kept = JSON.parse(onDisk(dir));
  assert.deepEqual([kept.v, kept.dropped, kept.entries.length, kept.entries[0].text], [1, 0, 1, 'Q3\nRevenue · £4.2m']);
  // `seen`: once every page that held it has settled on it; a page out of view (or minimised) may still show it, so it is
  // waited for, and one that shows it then counts; a report after that, or from a page that did not hold it, changes
  // nothing.
  r.reported(HALL, 's1', 1, 'shown');
  r.reported(HALL, 'sX', 1, 'shown');
  assert.equal((await r.of(HALL)).entries[0].seen, undefined, 'one page has not said yet');
  r.reported(HALL, 's2', 1, 'hidden');
  r.reported(HALL, 's1', 1, 'minimised');
  assert.equal((await r.of(HALL)).entries[0].seen, undefined, 'a page out of view has not settled');
  r.reported(HALL, 's2', 1, 'shown');
  assert.deepEqual((await r.of(HALL)).entries[0].seen, { shown: 2, of: 2 }, 'shown once in view, and s1 showed it before it minimised it');
  r.reported(HALL, 's2', 1, 'dismissed');
  assert.deepEqual((await r.of(HALL)).entries[0].seen, { shown: 2, of: 2 }, 'written once');
  // A page that could not draw it, or whose person put it back to chat, has settled without showing it: no deadline waited.
  r.shown(HALL, take(20, CELL), { pages: [{ sid: 'f1', docs: true }, { sid: 'f2', docs: true }, { sid: 'f3', docs: true }] });
  r.reported(HALL, 'f1', 20, 'failed');
  r.reported(HALL, 'f2', 20, 'dismissed');
  r.reported(HALL, 'f3', 20, 'hidden');
  assert.equal((await r.of(HALL)).entries[1].seen, undefined);
  r.reported(HALL, 'f3', 20, 'shown');
  assert.deepEqual((await r.of(HALL)).entries[1].seen, { shown: 1, of: 3 });
  // At the deadline, what was said by then: a page that never said is not counted as showing it.
  r.shown(HALL, take(2, { kind: 'doc', url: '/uploads/1700000000000-abcdefghijkl-pack.pdf', name: 'Board pack.pdf', at: { page: 12 }, download: false, standin: { url: '/uploads/1700000000000-abcdefghijkl-p12.png' } }), { pages: [{ sid: 'a', docs: true }, { sid: 'b', docs: false }, { sid: 'c', docs: true }] });
  r.reported(HALL, 'a', 2, 'shown');
  r.reported(HALL, 'b', 2, 'shown');
  r.reported(HALL, 'c', 2, 'hidden');
  assert.equal((await r.of(HALL)).entries[2].seen, undefined);
  await until(async () => !!(await r.of(HALL)).entries[2].seen, 2000, 'the deadline');
  assert.deepEqual((await r.of(HALL)).entries[2].seen, { shown: 2, of: 3, standin: 1 }, 'the page without documents drew the stand-in; the page out of view did not show it');
  // A take no page held: nothing to wait for.
  r.shown(HALL, take(3, { kind: 'chat', layer: 'info' }), { to: 'u:x', name: 'Gil', pages: [] });
  assert.deepEqual((await r.of(HALL)).entries[3].seen, { shown: 0, of: 0 });
  // A line sent with a take, and a withdrawal: on its entry, which stays.
  assert.equal(r.line(HALL, 1, { text: 'Revenue: £4.2m', via: 'operator' }), true);
  assert.equal(r.line(HALL, 99, { text: 'No such take', via: 'now' }), false, 'no entry, no line');
  assert.equal(r.line(HALL, 1, { text: 'x', via: 'later' }), false, 'a way that is none');
  r.withdrawn(HALL, 1, 1_700_000_050_000);
  r.withdrawn(HALL, 1, 1_700_000_060_000);
  flush(r);
  kept = JSON.parse(onDisk(dir));
  assert.deepEqual([kept.entries[0].line, kept.entries[0].withdrawn, kept.entries[0].text], [{ text: 'Revenue: £4.2m', via: 'operator' }, 1_700_000_050_000, 'Q3\nRevenue · £4.2m'], 'withdrawn once, and kept');
  // The bound: the 501st keeps 500, the oldest going first, counted.
  const big = await record({ max: MAX });
  for (let i = 1; i <= MAX + 1; i++) big.shown(HALL, take(i, { kind: 'snippet', unit: 'text', text: 'Quote ' + i }));
  const { entries, dropped } = await big.of(HALL);
  assert.deepEqual([entries.length, dropped, entries[0].seq, entries.at(-1).seq], [500, 1, 2, 501]);
  flush(big);
  assert.deepEqual([JSON.parse(onDisk(big.dir)).entries.length, JSON.parse(onDisk(big.dir)).dropped], [500, 1]);
});

test('read again at a start: kept whole, a torn file read from its .bak, an entry of the wrong shape dropped, a hall\'s file that could not be read never written over; the record of a hall no longer here removed with its .bak', async () => {
  const dir = folder();
  const first = await record({ dir });
  first.shown(HALL, take(1, CELL), { role: 'research' });
  first.shown(HALL, take(2, ROWS), { role: 'research' });
  flush(first);
  // A second write keeps the first as .bak; the file torn after it is read from its .bak.
  const again = await record({ dir });
  assert.deepEqual((await again.of(HALL)).entries.map((e) => e.seq), [1, 2], 'a restart keeps it');
  fs.writeFileSync(path.join(dir, HALL + '.json'), JSON.stringify({ v: 1, dropped: 3, entries: [JSON.parse(onDisk(dir)).entries[0], { seq: 'two' }] }));
  const shaped = await record({ dir });
  assert.deepEqual([(await shaped.of(HALL)).entries.map((e) => e.seq), (await shaped.of(HALL)).dropped], [[1], 3], 'the entry of the wrong shape dropped');
  fs.writeFileSync(path.join(dir, HALL + '.json'), '{"v":1,"entr');
  fs.writeFileSync(path.join(dir, HALL + '.json.bak'), JSON.stringify({ v: 1, dropped: 0, entries: [JSON.parse(JSON.stringify((await first.of(HALL)).entries[1]))] }));
  assert.deepEqual((await (await record({ dir })).of(HALL)).entries.map((e) => e.seq), [2], 'a torn file read from its .bak');
  // A hall's file that cannot be read (a folder in its place) and no .bak: never written over this run.
  const odd = folder();
  fs.mkdirSync(path.join(odd, 'ODDHALL.json'));
  const unread = new StageRecord(odd, { delayMs: 5 });
  const said = await unread.load();
  assert.deepEqual(said.unread.map(([h]) => h), ['ODDHALL']);
  unread.shown('ODDHALL', take(1, CELL));
  assert.deepEqual([(await unread.of('ODDHALL')).entries.length, unread.lanes()], [1, []], 'kept for the run, with no lane to write it');
  // Its clear is this run's alone, and says so: what the file holds is there at the next start that reads it.
  assert.deepEqual(await unread.clear('ODDHALL'), { cleared: 1, unread: 'EISDIR' });
  assert.deepEqual(await unread.drop('ODDHALL', LEGAL), { cleared: 0, unread: 'EISDIR' });
  assert.ok(fs.statSync(path.join(odd, 'ODDHALL.json')).isDirectory(), 'never written over');
  // A folder that cannot be listed holds files that were not read: no hall's record is written that run.
  const unlisted = folder();
  fs.writeFileSync(path.join(unlisted, 'stage'), 'a file where the folder goes');
  const blind = new StageRecord(path.join(unlisted, 'stage'), { delayMs: 5 });
  assert.equal((await blind.load()).unread.length, 1);
  blind.shown(HALL, take(1, CELL));
  assert.deepEqual([blind.lanes(), (await blind.clear(HALL)).unread !== ''], [[], true], 'kept for the run alone, and its clear says so');
  // The boot sweep: the record of a hall that no longer exists goes with its .bak; another hall's and another file stay.
  const swept = folder();
  for (const f of ['GONE01.json', 'GONE01.json.bak', 'GONE02.json.bak', HALL + '.json', 'notes.txt']) fs.writeFileSync(path.join(swept, f), JSON.stringify({ v: 1, dropped: 0, entries: [] }));
  const boot = new StageRecord(swept);
  const r = await boot.load((h) => h === HALL);
  assert.deepEqual([r.gone, r.kept], [['GONE01', 'GONE02'], []]);
  assert.deepEqual(fs.readdirSync(swept).sort(), [HALL + '.json', 'notes.txt']);
  // A folder that is not there yet is no record, and nothing is made by reading it.
  const none = path.join(folder(), 'stage');
  assert.deepEqual(await new StageRecord(none).load(), { gone: [], unread: [], kept: [] });
  assert.ok(!fs.existsSync(none));
});

test('a Main reset clears the hall\'s record and a side room\'s drops the entries sent from it, neither leaving the words in the .bak; a hall removed closes its lane and takes its file and .bak; the lanes counted as made and not closed', async () => {
  const r = await record();
  r.shown(HALL, take(1, { kind: 'snippet', unit: 'text', text: 'Main\'s words' }), { role: 'research' });
  r.shown(HALL, take(2, { kind: 'snippet', unit: 'text', text: 'Legal\'s words' }, { sent: { key: LEGAL, name: 'Legal' } }), { role: 'research' });
  r.shown(HALL, take(3, { kind: 'image', url: '/uploads/1700000000000-abcdefghijkl-p1.png', name: 'p1.png', from: { name: 'Plan.pdf', type: 'pdf', at: { page: 1 }, room: LEGAL, roomName: 'Legal' } }));
  flush(r);
  r.shown(HALL, take(4, { kind: 'clock' }));
  flush(r);
  const bak = () => fs.readFileSync(path.join(r.dir, HALL + '.json.bak'), 'utf8');
  assert.ok(bak().includes('Legal\'s words'), 'the .bak holds the write before the last');
  // A side room's entries are those sent from it; its transcript reads the same. A picture of one of its files shown from
  // the Main room is the hall's record, kept whichever room's file it showed.
  assert.deepEqual((await r.of(HALL, { room: LEGAL })).entries.map((e) => e.seq), [2]);
  assert.deepEqual((await r.of(HALL, { room: HALL })).entries.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(await r.drop(HALL, LEGAL), { cleared: 1, unread: '' });
  assert.deepEqual(await r.drop(HALL, LEGAL), { cleared: 0, unread: '' }, 'nothing more of it');
  flush(r);
  assert.deepEqual(JSON.parse(onDisk(r.dir)).entries.map((e) => e.seq), [1, 3, 4]);
  assert.ok(!bak().includes('Legal\'s words'), 'its words in neither the file nor its .bak');
  assert.ok(onDisk(r.dir).includes('Plan.pdf'), 'what Main showed of Legal\'s file stays');
  // The next write keeps a .bak of the file before it again.
  r.shown(HALL, take(5, { kind: 'blank' }));
  flush(r);
  assert.deepEqual(JSON.parse(bak()).entries.map((e) => e.seq), [1, 3, 4]);
  assert.deepEqual(await r.clear(HALL), { cleared: 4, unread: '' });
  flush(r);
  assert.deepEqual(JSON.parse(onDisk(r.dir)), { v: 1, dropped: 0, entries: [] });
  assert.ok(!bak().includes('Main\'s words'), 'cleared from the .bak too');
  assert.deepEqual(await r.clear(HALL), { cleared: 0, unread: '' }, 'nothing more to clear');
  assert.deepEqual(await r.clear('NOHALL'), { cleared: 0, unread: '' });
  // A hall removed: its lane closed (what is pending dropped), its file and .bak gone, and nothing written by it again.
  const built = WriteLane.built;
  r.shown(HALL, take(6, { kind: 'snippet', unit: 'text', text: 'Last words' }));
  const [[, lane]] = r.lanes();
  assert.deepEqual(await r.forget(HALL), []);
  assert.equal(WriteLane.built, built - 1, 'the closed lane is no longer counted');
  assert.deepEqual([r.lanes(), lane.closed, lane.pending], [[], true, null]);
  lane.save(() => '{"v":1}');
  assert.ok(lane.flushSync());
  assert.deepEqual(fs.readdirSync(r.dir), [], 'its file and .bak gone, and nothing written after');
  assert.deepEqual(await r.of(HALL), { entries: [], dropped: 0 });
});

// ---------------------------------------------------------------- end to end

const PASSWORD = 'clipboard and coffee';
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}

test('end to end: each take recorded with its words and its seat, a take-down too, `seen` once its pages reported, a line and a withdrawal kept; the lanes in health; a restart keeps it; the transcript interleaves it, escaped, no-store, a side room\'s its own; the minutes are given it; a reset clears it from the .bak too; a hall removed takes its record and its stage-only pictures; the boot sweep the record of a hall gone', { timeout: 180_000 }, async (t) => {
  const http = require('http');
  // A stand-in for the AI's endpoint (the SDK's ANTHROPIC_BASE_URL): every request's body kept, minutes answered.
  const bodies = [];
  const model = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ headline: 'Q3', decisions: [], open: [], actions: [] }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { model.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { model.close(resolve); }));
  const sw = await fakeStagewatch({ name: 'Hall 9 timer' });
  t.after(() => sw.close());
  const ENV = { ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + model.address().port };
  let srv = await startServer(ENV);
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const open = async (cookie) => { const s = await connect(srv.base, cookie); sockets.push(s); return s; };
  const joined = async (s, args) => {
    const a = args.role === 'board' && !args.as ? { ...args, invite: inviteOf(srv.dataDir, args.roomCode), docs: true } : { ...args, docs: true };
    const r = await act(s, 'join', a);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const admin = (await setupAdmin(srv.base)).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 9' }, { cookie: admin })).body.code;
  const ctl = await open(admin);
  await joined(ctl, { roomCode: hall, as: 'account' });
  const legal = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  assert.equal((await act(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall9_node_key_0001' })).ok, true);   // secret-scan: fixture
  // Legal may send to the Main room's Board.
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [legal] })).ok, true);
  const account = async (username, name, role, extra) => {
    assert.equal((await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin })).status, 200);
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { halls: [hall], rooms: [legal], grant: ['stage.send'] });   // stage.show: shows by a right of her own
  const tomCookie = await account('tom', 'Tom Tech', 'tech', { halls: [hall] });   // display.control and stage.web: the operator
  const sue = await open(sueCookie);
  await joined(sue, { roomCode: hall, as: 'account' });
  const sueLegal = await open(sueCookie);
  await joined(sueLegal, { roomCode: legal, as: 'account' });
  const tom = await open(tomCookie);
  await joined(tom, { roomCode: hall, as: 'account' });
  const gil = await open();
  await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const flo = await open();
  await joined(flo, { roomCode: hall, name: 'Flo', role: 'board' });
  await until(async () => { const r = await emit(sue, 'stage:targets', {}); return r.ok && r.canSend; }, 15000, 'the hall\'s Stagewatch linked, its key accepted');
  const stageFile = path.join(srv.dataDir, 'stage', hall + '.json');
  const kept = () => (fs.existsSync(stageFile) ? JSON.parse(fs.readFileSync(stageFile, 'utf8')) : { entries: [] });
  const entry = (seq) => kept().entries.find((e) => e.seq === seq);
  const push = async (s, content, extra = {}) => { const r = await act(s, 'page:push', { code: hall, to: 'board', content, ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); return r.seq; };
  const say = async (s, text) => assert.equal((await act(s, 'message', { type: 'text', text })).ok, true);

  // A message, then a quote of a cell with a line on the speaker's screen, both Board pages reporting it.
  await say(sue, 'Before the quote');
  const CELL_E2E = { kind: 'snippet', unit: 'cell', table: { rows: [['', 'Q3'], ['Revenue', '£4.2m <script>alert(1)</script>']], head: 1, side: 1, ref: 'C4', focus: [1, 1] } };
  const cell = await push(sue, CELL_E2E);
  await until(() => !!entry(cell), 4000, 'the quote recorded');
  assert.deepEqual(entry(cell), {
    seq: cell, at: entry(cell).at, by: { name: 'Sue Staff', role: 'research' }, to: 'board', layer: 'info', kind: 'snippet',
    what: '❝ a quote typed by Sue Staff (42 characters)', text: 'Q3\nRevenue · £4.2m <script>alert(1)</script>',
  });
  for (const s of [gil, flo]) assert.ok((await act(s, 'page:report', { seq: cell, state: 'shown' })).ok);
  await until(() => !!(entry(cell) || {}).seen, 4000, 'seen written');
  assert.deepEqual(entry(cell).seen, { shown: 2, of: 2 });
  assert.ok((await act(gil, 'page:report', { seq: cell, state: 'minimised' })).ok);
  await wait(300);
  assert.deepEqual(entry(cell).seen, { shown: 2, of: 2 }, 'written once');
  assert.equal((await act(sue, 'stage:send', { withTake: cell })).ok, true);
  await until(() => !!(entry(cell) || {}).line, 4000, 'the line recorded');
  assert.deepEqual(entry(cell).line, { text: 'Revenue Q3: £4.2m <script>alert(1)</script>', via: 'now' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(stageFile).mode & 0o777, 0o600, 'mode 0600');
  await say(sue, 'After the quote');
  // A web page, by the operator: its host alone, never its address.
  const web = await push(tom, { kind: 'web', url: 'https://vote.example.com/poll/7?token=s3cr3t' });
  await until(() => !!entry(web), 4000, 'the web page recorded');
  assert.deepEqual([entry(web).what, entry(web).by, entry(web).kind], ['a web page on vote.example.com', { name: 'Tom Tech', role: 'research' }, 'web']);
  for (const part of ['https://', 'poll/7', 's3cr3t']) assert.ok(!fs.readFileSync(stageFile, 'utf8').includes(part), 'no address: ' + part);
  // Taken down: an entry of its own.
  const down = await push(tom, { kind: 'chat', layer: 'info' }, { ifSeq: web });
  await until(() => !!entry(down), 4000, 'the take-down recorded');
  assert.deepEqual([entry(down).kind, entry(down).layer, entry(down).what], ['chat', 'info', 'the information taken down']);
  // From Legal, of Legal's own words: sent from Legal; then withdrawn, and its entry stays.
  const fromLegal = await push(sueLegal, { kind: 'snippet', unit: 'text', text: 'Legal\'s advice: wait' });
  await until(() => !!entry(fromLegal), 4000, 'recorded');
  assert.deepEqual(entry(fromLegal).sentFrom, { key: legal, name: 'Legal' });
  assert.equal((await act(sue, 'page:withdraw', { code: hall, seq: fromLegal })).ok, true);
  await until(() => !!(entry(fromLegal) || {}).withdrawn, 4000, 'withdrawn kept');
  assert.equal(entry(fromLegal).text, 'Legal\'s advice: wait', 'what was shown stays recorded');

  // The hall's lane in health, named; the lanes made and named still equal.
  const { saves } = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  assert.deepEqual(saves.stores['stage ' + hall], { writes: saves.stores['stage ' + hall].writes, error: null, failures: 0 });
  assert.ok(saves.stores['stage ' + hall].writes >= 1);
  assert.equal(saves.built, saves.named);

  // The transcript: the entries interleaved with the messages by time, escaped, no-store; Legal's its own.
  const transcript = async (key) => {
    const r = await fetch(srv.base + '/api/admin/transcript/' + key, { headers: { cookie: admin } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    return r.text();
  };
  let main = await transcript(hall);
  const at = (s) => { const i = main.indexOf(s); assert.ok(i > 0, s + ' in the transcript'); return i; };
  assert.ok(at('Before the quote') < at('Sue Staff (backstage) showed the Board (2 pages): ❝ a quote typed by Sue Staff') && at('showed the Board (2 pages)') < at('After the quote'), 'interleaved by time');
  assert.ok(main.includes('— “Q3<br>Revenue · £4.2m &lt;script&gt;alert(1)&lt;/script&gt;” · ✓ on 2 of 2'), 'the quote\'s words, escaped, and what its pages reported');
  assert.ok(!main.includes('<script>'), 'nothing of it unescaped');
  assert.ok(main.includes('🖥 line: “Revenue Q3: £4.2m &lt;script&gt;alert(1)&lt;/script&gt;” (sent now)'));
  assert.ok(at('After the quote') < at('Tom Tech (backstage) showed the Board') && main.includes('a web page on vote.example.com') && !main.includes('s3cr3t'));
  assert.ok(main.includes('Tom Tech (backstage) took the information down on the Board&#39;s pages'));
  assert.match(main, /Legal&#39;s advice: wait” [^<]*<span class="pin">withdrawn /);
  assert.ok(main.includes('4 shown on people\'s pages'));
  const side = await transcript(legal);
  assert.ok(side.includes('Legal&#39;s advice: wait') && side.includes(', sent from Legal') && !side.includes('Revenue') && !side.includes('vote.example.com'), 'a side room\'s transcript: the entries sent from it');
  // The minutes are given the record's lines, a quote with its words.
  const minutes = await act(ctl, 'admin:summary', { roomCode: hall });
  assert.equal(minutes.ok, true, JSON.stringify(minutes));
  const prompt = JSON.parse(bodies.at(-1)).messages[0].content;
  assert.ok(prompt.includes('Shown on people\'s pages') && prompt.includes('Sue Staff showed the Board: a quote typed by Sue Staff (42 characters) — "Q3 / Revenue · £4.2m <script>alert(1)</script>"; on the speaker\'s screen: "Revenue Q3: £4.2m <script>alert(1)</script>" (on 2 of 2 pages)'), prompt);
  assert.ok(prompt.includes('Sue Staff showed the Board: a quote typed by Sue Staff (20 characters) — "Legal\'s advice: wait" [sent from Legal]') && /withdrawn at \d\d:\d\d/.test(prompt), prompt);
  assert.ok(JSON.parse(bodies.at(-1)).system.includes('what was shown to the Board'));

  // A restart keeps it, and a record of 500 entries kept with 12 gone before says so in the transcript.
  srv = await restartServer(srv, ENV);
  assert.ok((await transcript(hall)).includes('❝ a quote typed by Sue Staff (42 characters)'), 'a restart keeps the record');
  await stopServer(srv.child);
  const full = { v: 1, dropped: 12, entries: Array.from({ length: 500 }, (_, i) => ({ seq: 1000 + i, at: 1_700_000_000_000 + i, by: { name: 'Bench', role: 'research' }, to: 'board', layer: 'info', kind: 'snippet', what: '❝ a quote typed by Bench (8 characters)', text: 'Quote ' + i })) };
  fs.writeFileSync(stageFile, JSON.stringify(full));
  // The record of a hall no longer here goes at the start, with its .bak.
  for (const f of ['GONE99.json', 'GONE99.json.bak']) fs.writeFileSync(path.join(srv.dataDir, 'stage', f), JSON.stringify({ v: 1, dropped: 0, entries: [] }));
  srv = await startServer({ ...ENV, AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) });
  main = await transcript(hall);
  assert.ok(main.includes('📺 12 earlier entries are no longer kept') && main.includes('Quote 499') && main.includes('500 shown on people\'s pages'), 'how many are no longer kept');
  // The minutes are given every entry the record keeps, and told how many it no longer does.
  const ctl2 = await open(admin);
  assert.equal((await act(ctl2, 'admin:summary', { roomCode: hall })).ok, true);
  const told = JSON.parse(bodies.at(-1)).messages[0].content;
  assert.ok(told.includes('(12 earlier entries of the hall\'s record are no longer kept, so not included)') && told.includes('"Quote 0"') && told.includes('"Quote 499"'), 'every entry kept, and those no longer kept counted');
  await until(() => !fs.existsSync(path.join(srv.dataDir, 'stage', 'GONE99.json')) && !fs.existsSync(path.join(srv.dataDir, 'stage', 'GONE99.json.bak')), 4000, 'the boot sweep');

  // Resets: Legal's drops its entries; Main's clears the hall's, and neither file nor .bak (the stage's or pages.json's)
  // holds the cleared quote's words.
  const sue2 = await open(sueCookie);
  await joined(sue2, { roomCode: legal, as: 'account' });
  const said = await push(sue2, { kind: 'snippet', unit: 'text', text: 'Words only Legal said' });
  await until(() => !!entry(said), 4000, 'recorded');
  const legalReset = await act(ctl2, 'admin:resetRoom', { roomCode: legal });
  assert.deepEqual([legalReset.ok, legalReset.cleared], [true, 1], JSON.stringify(legalReset));
  await until(() => !entry(said) && kept().entries.length === 499, 4000, 'Legal\'s entry dropped, the hall\'s kept (the 501st had put out the oldest)');
  const sueMain = await open(sueCookie);
  await joined(sueMain, { roomCode: hall, as: 'account' });
  const secret = await push(sueMain, { kind: 'snippet', unit: 'text', text: 'Words cleared by the reset' });
  await until(() => !!entry(secret) && fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8').includes('Words cleared by the reset'), 4000, 'recorded and on people\'s pages');
  // One more write of each, so each .bak holds the quote.
  await push(sueMain, { kind: 'chat', layer: 'info' }, { ifSeq: secret });
  await until(() => fs.existsSync(stageFile + '.bak') && fs.readFileSync(stageFile + '.bak', 'utf8').includes('Words cleared by the reset') && fs.readFileSync(path.join(srv.dataDir, 'pages.json.bak'), 'utf8').includes('Words cleared by the reset'), 4000, 'both .bak hold the quote');
  const reset = await act(ctl2, 'admin:resetRoom', { roomCode: hall });
  assert.deepEqual([reset.ok, reset.cleared], [true, 500], JSON.stringify(reset));
  await until(() => kept().entries.length === 0, 4000, 'cleared');
  for (const f of [stageFile, stageFile + '.bak', path.join(srv.dataDir, 'pages.json'), path.join(srv.dataDir, 'pages.json.bak')]) {
    await until(() => !fs.readFileSync(f, 'utf8').includes('Words cleared by the reset'), 4000, path.basename(f) + ' holds no cleared words');
  }
  const rows = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'room.reset').map((e) => e.words);
  // Legal's ends its one take; Main's every take of the hall, its Earlier included.
  assert.equal(rows.at(-2), 'messages and documents cleared, 0 files removed, 1 take ended, 1 entry dropped from the stage record');
  assert.match(rows.at(-1), /^messages and documents cleared, 0 files removed, \d+ takes ended, the stage record cleared$/);
  main = await transcript(hall);
  assert.ok(!main.includes('📺') && !main.includes('no longer kept'), 'nothing shown left in the transcript');

  // A hall removed without "purge files": its stage-only picture and its record's file and .bak go.
  const picture = new FormData();
  picture.append('file', new Blob([pngOf(4, 4)], { type: 'image/png' }), 'slide.png');
  const up = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': (await act(sueMain, 'join', { roomCode: hall, as: 'account', docs: true })).uploadToken }, body: picture })).json();
  assert.ok(typeof up.url === 'string', JSON.stringify(up));
  const pic = await push(sueMain, { kind: 'image', url: up.url });
  await until(() => !!entry(pic) && fs.existsSync(stageFile + '.bak'), 4000, 'recorded');
  const uploaded = path.join(srv.dataDir + '-uploads', up.url.slice(9));
  assert.ok(fs.existsSync(uploaded));
  assert.equal((await act(ctl2, 'admin:deleteRoom', { roomCode: hall, purgeFiles: false })).ok, true);
  assert.ok(!fs.existsSync(stageFile) && !fs.existsSync(stageFile + '.bak'), 'its record and .bak gone');
  assert.ok(!fs.existsSync(uploaded), 'its stage-only picture gone');
  const after = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body.saves;
  assert.ok(!Object.hasOwn(after.stores, 'stage ' + hall) && after.built === after.named, 'its lane closed, and no longer named or counted');
});

test('a hall whose files could not be read at a start keeps its stage record: the boot sweep removes only the record of a hall whose files are gone, and the hall\'s transcript shows it once it loads again', { timeout: 60_000 }, async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const admin = (await setupAdmin(srv.base)).cookie;
  const make = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const away = await make('Hall away');
  const here = await make('Hall here');
  await stopServer(srv.child);
  // Each hall's record planted, and one of a hall whose files are gone.
  const stage = path.join(srv.dataDir, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const planted = (words) => JSON.stringify({ v: 1, dropped: 0, entries: [{ seq: 1, at: Date.now(), by: { name: 'Ana', role: 'research' }, to: 'board', layer: 'info', kind: 'snippet', what: '❝ a quote typed by Ana (19 characters)', text: words }] });
  fs.writeFileSync(path.join(stage, away + '.json'), planted('Words of the record'));
  fs.writeFileSync(path.join(stage, here + '.json'), planted('Words of another hall'));
  fs.writeFileSync(path.join(stage, 'GONE77.json'), planted('Words of a hall gone'));
  // The away hall's snapshot torn for one start, its .bak out of the folder: it does not load, and its files stay.
  const rooms = path.join(srv.dataDir, 'rooms');
  const snap = path.join(rooms, away + '.json');
  const aside = path.join(srv.dataDir, 'away-snapshot.json');
  fs.renameSync(snap, aside);
  if (fs.existsSync(snap + '.bak')) fs.renameSync(snap + '.bak', aside + '.bak');
  fs.writeFileSync(snap, '{"code":');
  const env = { AGM_DATA_DIR: srv.dataDir, PORT: String(srv.port) };
  srv = await startServer(env);
  const transcript = async (code) => {
    const r = await fetch(srv.base + '/api/admin/transcript/' + code, { headers: { cookie: admin } });
    return { status: r.status, text: await r.text() };
  };
  // Another hall's transcript waits for the record to be read, the boot sweep with it.
  assert.ok((await transcript(here)).text.includes('Words of another hall'));
  assert.equal((await transcript(away)).status, 404, 'the hall did not load this start');
  assert.deepEqual(fs.readdirSync(stage).filter((f) => f.endsWith('.json')).sort(), [away + '.json', here + '.json'].sort(), 'the record of the hall gone removed; the hall that did not load keeps its own');
  assert.ok(fs.readFileSync(path.join(stage, away + '.json'), 'utf8').includes('Words of the record'));
  await stopServer(srv.child);
  // Back whole: the hall loads, and its transcript shows what its record holds.
  fs.rmSync(snap);
  fs.renameSync(aside, snap);
  if (fs.existsSync(aside + '.bak')) fs.renameSync(aside + '.bak', snap + '.bak');
  srv = await startServer(env);
  const back = await transcript(away);
  assert.equal(back.status, 200);
  assert.ok(back.text.includes('Words of the record'), 'its record kept for the start it loads');
});
