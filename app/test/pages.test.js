'use strict';
// People's pages as a store and a vocabulary (lib/pages.js), pure: what a pusher may ask for and what is refused, what a
// take is called, which take a page is shown, the persons' answers, a Board take putting away what could never show
// again, the bounds, a take's status from its pages' reports, a record of the wrong shape dropped, and nothing written
// before the copy holds its data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pages, cleanPage, describePage, webUrl, personKey, layerOf, reportsOf, inViewOf, KINDS, LAYERS, IMAGE_EXT, REPORTS, ANSWERS, AGAIN_MS, VIEWS, MARKS, BOUNDS, WEB_MAX } = require('../lib/pages');
const { cleanContent } = require('../lib/displays');
const guard = require('../lib/guard');
const { VIEWS: ACCOUNT_VIEWS } = require('../lib/accounts');
const { RoomStore } = require('../lib/store');
const { clockOf } = require('../lib/tunnelend');

const HALL = 'HALLA1';
const OTHER = 'HALLB2';
const ANA = 'a:aanaaccount01';
const BEN = 'u:ubenguest0001';
const CY = 'u:ucyguest00001';
const PIC = '/uploads/1730000000000-abcdefghijkl-stage.png';
const KINDS_WORDS = { error: 'Choose what to show: back to chat, Stagewatch, the clock, holding, blank or a web page.' };
const dirs = [];
const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-pages-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
/** A store in a folder of its own, held (so it writes) unless asked not to be. */
function store({ held = true, file = path.join(folder(), 'pages.json') } = {}) {
  const p = new Pages(file);
  if (held) p.hold();
  p.file = file;
  return p;
}
const onDisk = (p) => (p.flush(), JSON.parse(fs.readFileSync(p.file, 'utf8')));

test('cleanPage: an unknown kind, or none, is refused with the kinds in words, never defaulted', () => {
  // `brand` went (the owner's answer 31: one Holding page with the logo); the documents are later units'.
  for (const kind of ['brand', 'doc', 'image', 'snippet', 'iframe', 'message', 'black', 'CLOCK', 'WEB', '', ' clock']) assert.deepEqual(cleanPage({ kind }), KINDS_WORDS, kind);
  for (const c of [undefined, null, 'clock', 5, ['clock'], {}, { kind: 5 }, { kind: ['clock'] }, { kind: { toString: () => 'clock' } }, { kind: null }]) assert.deepEqual(cleanPage(c), KINDS_WORDS, JSON.stringify(c));
  // Only its own kind: one it inherits is not read.
  assert.deepEqual(cleanPage(Object.create({ kind: 'clock' })), KINDS_WORDS);
});

test('cleanPage: each kind in its clean shape, a fresh object, with the keys it does not know left behind', () => {
  for (const kind of ['chat', 'clock', 'blank']) {
    const asked = { kind, image: PIC, url: 'https://example.com/', seq: 9, by: 'me' };
    const clean = cleanPage(asked);
    assert.deepEqual(clean, { kind });
    assert.notEqual(clean, asked);
  }
  assert.deepEqual(cleanPage({ kind: 'holding', text: 'x' }), { kind: 'holding' });
  // Back to chat of one layer is a hand-back the store does not keep: refused, never widened to every layer.
  for (const layer of ['info', 'show', null, 5, '']) assert.deepEqual(cleanPage({ kind: 'chat', layer }), KINDS_WORDS, JSON.stringify(layer));
  assert.deepEqual(cleanPage({ kind: 'clock', layer: 'info' }), { kind: 'clock' }, 'a layer is chat\'s word alone: on another kind it is a key not known');
  assert.deepEqual(KINDS, ['chat', 'stage', 'clock', 'holding', 'blank', 'web']);
  assert.ok(Object.isFrozen(KINDS) && KINDS.every((k) => layerOf(k) === 'show'), 'every kind is the show layer\'s');
  assert.deepEqual(LAYERS, ['show']);
  assert.equal(layerOf('brand'), '');
});

test('cleanPage: Stagewatch only where the hall has one linked', () => {
  const none = { error: 'This hall has no Stagewatch linked — link one in Set up.' };
  assert.deepEqual(cleanPage({ kind: 'stage' }, { stagewatch: true }), { kind: 'stage' });
  for (const facts of [undefined, {}, { stagewatch: false }, { stagewatch: 'yes' }, { stagewatch: 1 }, null]) assert.deepEqual(cleanPage({ kind: 'stage' }, facts), none, JSON.stringify(facts));
});

test('cleanPage: the holding rules: no picture, or a picture of ours in a room of the hall the pusher may read', () => {
  const asked = [];
  const readable = (url) => { asked.push(url); return url === PIC; };
  assert.deepEqual(cleanPage({ kind: 'holding' }, {}), { kind: 'holding' }, 'no picture needs no facts');
  assert.deepEqual(cleanPage({ kind: 'holding', image: PIC }, { readable }), { kind: 'holding', image: PIC });
  assert.deepEqual(asked, [PIC], 'the file is asked of the server\'s facts by its address');
  // Not a picture of ours: a type a screen does not show, or an address that is not an upload.
  const notOurs = { error: 'A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage.' };
  for (const image of ['/uploads/1730000000000-abcdefghijkl-deck.pdf', '/uploads/1730000000000-abcdefghijkl-notes.txt', 'https://example.com/a.png', '/uploads/../1730000000000-abcdefghijkl-a.png', '/uploads/a.png', '']) {
    assert.deepEqual(cleanPage({ kind: 'holding', image }, { readable: () => true }), notOurs, JSON.stringify(image));
  }
  // A picture that is not a string is a field of the wrong type: the whole take refused with the kinds in words.
  for (const image of [null, 5, true, { toString: () => PIC }, [PIC]]) assert.deepEqual(cleanPage({ kind: 'holding', image }, { readable: () => true }), KINDS_WORDS, JSON.stringify(image));
  for (const ext of IMAGE_EXT) assert.deepEqual(cleanPage({ kind: 'holding', image: '/uploads/1730000000000-abcdefghijkl-p.' + ext }, { readable: () => true }).image, '/uploads/1730000000000-abcdefghijkl-p.' + ext);
  // The rule is a screen's (lib/displays.js), upload type by upload type: what a screen holds as its holding picture, a
  // person's page does, and nothing else.
  for (const ext of Object.keys(guard.UPLOAD_TYPES)) {
    const image = '/uploads/1730000000000-abcdefghijkl-p.' + ext;
    assert.equal('error' in cleanPage({ kind: 'holding', image }, { readable: () => true }), 'error' in cleanContent({ kind: 'holding', image }), ext);
  }
  // Ours, but in no message of a room of the hall the pusher may read; and facts that cannot say so refuse it too.
  const unread = { error: 'That picture is in no room of this hall you can read — share it there first.' };
  const other = '/uploads/1730000000000-zyxwvutsrqpo-other.jpg';
  assert.deepEqual(cleanPage({ kind: 'holding', image: other }, { readable }), unread);
  for (const facts of [undefined, {}, { readable: true }, { readable: () => 'yes' }, { readable: () => 1 }]) assert.deepEqual(cleanPage({ kind: 'holding', image: PIC }, facts), unread);
  // The picture types are the uploads' image types.
  for (const ext of IMAGE_EXT) assert.match(guard.UPLOAD_TYPES[ext].mime, /^image\//, ext);
});

test('describePage: the words for each kind, the same for the console and the audit; KINDS and the words are one set', () => {
  const words = KINDS.map((kind) => describePage({ kind }, { hallHolding: '/uploads/x.png' }));
  assert.deepEqual(words, ['back to chat', 'Stagewatch', 'the clock', 'a holding slide', 'blank', 'a web page']);
  assert.equal(new Set(words).size, KINDS.length, 'one kind, one set of words');
  // A holding slide with no picture of its own, in a hall with none, draws the AGMessage mark (owner answer 31).
  assert.equal(describePage({ kind: 'holding' }), 'a holding slide with the AGMessage mark');
  assert.equal(describePage({ kind: 'holding', image: PIC }), 'a holding slide');
  assert.equal(describePage({ kind: 'holding' }, { hallHolding: PIC }), 'a holding slide');
  // No take: the page shows its chat. A kind that is not one has no words.
  assert.equal(describePage(null), 'the chat');
  for (const c of [{ kind: 'brand' }, 'clock', { kind: 5 }]) assert.equal(describePage(c), '', JSON.stringify(c));
  // No words name a file or carry its address; a web page is named by its host alone, as it is kept and as it is told.
  assert.ok(!describePage({ kind: 'holding', image: PIC }).includes('stage.png'));
  assert.equal(describePage({ kind: 'web', host: 'vote.example.com', urlSealed: 'enc1:AAAA' }), 'a web page on vote.example.com');
  assert.equal(describePage({ kind: 'web', url: 'https://vote.example.com/poll/7?token=abc#q2', host: 'vote.example.com' }), 'a web page on vote.example.com');
});

test('personKey: an account\'s pages by its id, a guest\'s device by its uid', () => {
  assert.equal(personKey('aanaaccount01', true), 'a:aanaaccount01');
  assert.equal(personKey('ubenguest0001'), 'u:ubenguest0001');
  for (const uid of ['', 'a b', 'x'.repeat(65), null, {}, '../x']) assert.equal(personKey(uid), '', JSON.stringify(uid));
});

test('which take a page shows: the highest-numbered addressed to it, its person\'s or the Board\'s on a Board page', () => {
  const p = store();
  assert.deepEqual(p.current(HALL, ANA, { board: true }), { take: null, answer: null }, 'nothing yet: the chat');
  const clock = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 1000 });
  assert.deepEqual(clock, { seq: 1, content: { kind: 'clock' }, by: { name: 'Ada' }, at: 1000 });
  const blank = p.take(HALL, ANA, { kind: 'blank' }, { name: 'Ada' }, { at: 2000 });
  assert.equal(blank.seq, 2, 'one counter per hall, the Board\'s and each person\'s');
  assert.equal(p.current(HALL, ANA, { board: true }).take, blank, 'Ana on the Board: hers is newer');
  assert.equal(p.current(HALL, ANA).take, blank, 'Ana in a side room: hers');
  assert.equal(p.current(HALL, BEN, { board: true }).take, clock, 'Ben on the Board: the Board\'s');
  assert.equal(p.current(HALL, BEN).take, null, 'Ben in a side room: nothing addressed to him');
  // A newer Board take is drawn on Ana's Board page over her own older one.
  const handBack = p.take(HALL, 'board', { kind: 'chat' }, { name: 'Ada' }, { at: 3000 });
  assert.equal(p.current(HALL, ANA, { board: true }).take, handBack);
  assert.equal(p.current(HALL, ANA).take, blank, 'Ana was not seated On stage: her own take stays where it shows');
  // Each hall numbers its own; a layer, hall or person the store does not keep shows nothing.
  assert.equal(p.take(OTHER, 'board', { kind: 'clock' }, { name: 'Ada' }).seq, 1);
  assert.deepEqual(p.current(HALL, ANA, { layer: 'info' }), { take: null, answer: null });
  assert.deepEqual(p.current('nohall', ANA, { board: true }), { take: null, answer: null });
  assert.deepEqual(p.current(HALL, 'ana', { board: true }).take, handBack, 'a key not a person\'s: the Board\'s alone');
  assert.equal(p.current(HALL, BEN, { board: 'yes' }).take, null, 'board only when the server says true');
});

test('a take the store does not keep is not numbered: a hall, a target or a content it would not read back', () => {
  const p = store();
  for (const [hall, to, content, opts] of [['hall', 'board', { kind: 'clock' }], [HALL, 'everyone', { kind: 'clock' }], [HALL, 'ana', { kind: 'clock' }], [HALL, 'board', { kind: 'brand' }],
    [HALL, 'board', { kind: 'holding', image: 'https://example.com/a.png' }], [HALL, 'board', null], [HALL, 'board', { kind: 'clock' }, { at: NaN }], ['__proto__', 'board', { kind: 'clock' }]]) {
    assert.equal(p.take(hall, to, content, { name: 'Ada' }, opts), null, JSON.stringify([hall, to, content]));
  }
  assert.deepEqual(p.halls, {}, 'no hall made');
  // What is kept is the store's own copy: the content rebuilt, the pusher's name cleaned.
  const asked = { kind: 'holding', image: PIC, extra: 'x' };
  const t = p.take(HALL, 'board', asked, { name: '  Ada\u202E Lovelace ' + 'x'.repeat(80), id: 'secret' });
  assert.deepEqual(t.content, { kind: 'holding', image: PIC });
  assert.notEqual(t.content, asked);
  assert.equal(t.by.name, ('Ada Lovelace ' + 'x'.repeat(80)).slice(0, 60));
  assert.deepEqual(Object.keys(t.by), ['name']);
  assert.equal(p.take(HALL, 'board', { kind: 'blank' }, 'Ada').by.name, '', 'a pusher that is not a record has no name');
});

test('Back to chat taken back within 10 s: Show it again clears it, a card\'s Undo makes it a Minimise; after 10 s each is refused', () => {
  const p = store();
  const t = p.take(HALL, ANA, { kind: 'clock' }, { name: 'Ada' });
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: t.seq, state: 'dismissed', at: 1000 }).answer, { seq: t.seq, state: 'dismissed', at: 1000 });
  // A routine word from her tablet (it drew the take, it went out of view) is still refused: only her acts take it back.
  for (const [state, again] of [['shown', false], ['hidden', true], ['failed', false]]) {
    assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: t.seq, state, again, at: 2000 }), { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' }, state);
  }
  // Show it again, 10 s after to the millisecond: the answer goes, on every page of hers.
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: t.seq, state: 'shown', again: true, at: 1000 + AGAIN_MS }), { ok: true, answer: null });
  assert.deepEqual(p.current(HALL, ANA), { take: t, answer: null });
  assert.deepEqual(p.pageState(HALL, { sid: 'phone', key: ANA }), { seq: t.seq, state: 'shown', words: '', at: 1000 + AGAIN_MS });
  // A card's Remove (Back to chat from her side bar), then its Undo within the window: a Minimise again, its time the Undo's.
  assert.equal(p.report(HALL, 'phone', { key: ANA, seq: t.seq, state: 'dismissed', at: 20_000 }).answer.state, 'dismissed');
  assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: t.seq, state: 'minimised', at: 29_999 }), { ok: true, answer: { seq: t.seq, state: 'minimised', at: 29_999 } });
  assert.deepEqual(p.current(HALL, ANA).answer, { seq: t.seq, state: 'minimised', at: 29_999 });
  // After the window: final. Neither act changes the answer, and nothing is written for them.
  assert.equal(p.report(HALL, 'phone', { key: ANA, seq: t.seq, state: 'dismissed', at: 40_000 }).answer.state, 'dismissed');
  let saves = 0;
  const save = p.save.bind(p);
  p.save = () => { saves++; save(); };
  for (const [state, again] of [['shown', true], ['minimised', false]]) {
    assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: t.seq, state, again, at: 40_000 + AGAIN_MS + 1 }), { ok: false, error: 'Back to chat was chosen for that one more than 10 s ago: a newer take shows again.' }, state);
  }
  assert.deepEqual(p.current(HALL, ANA).answer, { seq: t.seq, state: 'dismissed', at: 40_000 });
  assert.equal(saves, 0, 'a refused act saves nothing');
  // A Board take's answer by a person On stage, alike: their Show it again on their Board page.
  const board = p.take(HALL, 'board', { kind: 'blank' }, { name: 'Ada' });
  assert.equal(p.report(HALL, 'ben', { key: BEN, board: true, seq: board.seq, state: 'dismissed', at: 50_000 }).answer.state, 'dismissed');
  assert.deepEqual(p.report(HALL, 'ben-phone', { key: BEN, board: true, seq: board.seq, state: 'shown', again: true, at: 55_000 }), { ok: true, answer: null });
  // His page that said Back to chat is waiting again, not "went back to chat": its word was his answer, now taken back.
  assert.deepEqual(p.pageState(HALL, { sid: 'ben', key: BEN, board: true }), { seq: board.seq, state: 'waiting', words: '', at: 0 });
  p.left('ben-phone');
  assert.deepEqual(p.report(HALL, 'ben', { key: BEN, board: true, seq: board.seq, state: 'shown', at: 56_000 }), { ok: true, answer: null });
  // Status reads it: what the take shows by its kind, and how many of its pages show it now.
  assert.deepEqual(p.status(HALL, 'board', [{ sid: 'ben', key: BEN, board: true, name: 'Ben' }, { sid: 'cy', key: CY, board: true, name: 'Cy' }]),
    { seq: board.seq, showing: 'blank', kind: 'blank', mark: '◷', words: 'Sending · on 1 of 2 pages', pages: 2, on: 1 });
});

test('answers only on the current take: Back to chat for all of a person\'s pages, final for that take; a newer take shows again', () => {
  const p = store();
  const t = p.take(HALL, ANA, { kind: 'clock' }, { name: 'Ada' });
  // A report for any other take than the one shown now is refused, and changes nothing.
  for (const seq of [0, 2, '1', null]) assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq, state: 'dismissed' }), { ok: false, error: 'That is not what this page is shown now.' }, String(seq));
  assert.deepEqual(p.report(HALL, 's1', { key: BEN, seq: 1, state: 'shown' }), { ok: false, error: 'That is not what this page is shown now.' }, 'another person\'s take');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: 1, state: 'seen' }), { ok: false, error: 'A report is one of: shown, hidden, opened, failed, dismissed, minimised.' });
  assert.deepEqual(p.report(HALL, '', { key: ANA, seq: 1, state: 'shown' }), { ok: false, error: 'No page to report for.' });
  assert.deepEqual(REPORTS, ['shown', 'hidden', 'opened', 'failed', 'dismissed', 'minimised']);
  assert.deepEqual(ANSWERS, ['dismissed', 'minimised']);
  assert.equal(p.current(HALL, ANA).answer, null);
  // Back to chat on her phone is her answer on her tablet too.
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 1, state: 'dismissed', at: 5000 }), { ok: true, answer: { seq: 1, state: 'dismissed', at: 5000 } });
  assert.deepEqual(p.current(HALL, ANA).answer, { seq: 1, state: 'dismissed', at: 5000 });
  assert.deepEqual(p.pageState(HALL, { sid: 'tablet', key: ANA }), { seq: 1, state: 'dismissed', words: '', at: 5000 });
  // Final for that take: shown or out of view is refused; Show it again and a card's Undo only within 10 s of it (below);
  // Back to chat again is answered as done.
  for (const state of ['shown', 'hidden']) assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: 1, state }), { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' }, state);
  for (const [state, again] of [['shown', true], ['minimised', false]]) assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: 1, state, again, at: 15_001 }), { ok: false, error: 'Back to chat was chosen for that one more than 10 s ago: a newer take shows again.' }, state);
  assert.equal(AGAIN_MS, 10_000);
  assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: 1, state: 'dismissed', at: 6000 }), { ok: true, answer: { seq: 1, state: 'dismissed', at: 5000 } });
  // A newer take shows again: the old answer answers nothing now, and is put away.
  const again = p.take(HALL, ANA, { kind: 'clock' }, { name: 'Ada' });
  assert.deepEqual(p.current(HALL, ANA), { take: again, answer: null });
  assert.ok(!Object.hasOwn(p.halls[HALL].answers, ANA), 'the answer to the older take is not kept');
  assert.notEqual(again, t);
  // Minimise, then Show again: the answer is taken back.
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'minimised', at: 7000 }).answer, { seq: 2, state: 'minimised', at: 7000 });
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'minimised', at: 8000 }).answer, { seq: 2, state: 'minimised', at: 7000 }, 'minimised again: as it was');
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'hidden' }).answer, { seq: 2, state: 'minimised', at: 7000 }, 'a report that is no answer keeps it');
  // Her tablet drew the take and says so (it comes back into view) before it hears of the Minimise on her phone: its
  // report is its own, and the Minimise stands on every page of hers. Only Show again (`again`, nothing else) takes it back.
  for (const again of [false, undefined, 'yes', 1]) assert.deepEqual(p.report(HALL, 'tablet', { key: ANA, seq: 2, state: 'shown', again, at: 8500 }), { ok: true, answer: { seq: 2, state: 'minimised', at: 7000 } }, String(again));
  assert.deepEqual(p.pageState(HALL, { sid: 'tablet', key: ANA }), { seq: 2, state: 'minimised', words: '', at: 7000 }, 'the person\'s answer first');
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'hidden', again: true }).answer, { seq: 2, state: 'minimised', at: 7000 }, 'Show again is a shown report');
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'shown', again: true, at: 9000 }), { ok: true, answer: null });
  assert.equal(p.current(HALL, ANA).answer, null);
  assert.deepEqual(p.report(HALL, 'phone', { key: ANA, seq: 2, state: 'dismissed', at: 9500 }).answer, { seq: 2, state: 'dismissed', at: 9500 }, 'Back to chat after a Minimise');
  // An answer to the Board's take is kept by the person, and counts only on their Board pages.
  const board = p.take(HALL, 'board', { kind: 'blank' }, { name: 'Ada' });
  assert.deepEqual(p.report(HALL, 'ben', { key: BEN, board: true, seq: board.seq, state: 'minimised', at: 1 }).answer, { seq: board.seq, state: 'minimised', at: 1 });
  assert.deepEqual(p.current(HALL, BEN, { board: true }).answer, { seq: board.seq, state: 'minimised', at: 1 });
  assert.deepEqual(p.report(HALL, 'ben2', { key: BEN, seq: board.seq, state: 'shown' }), { ok: false, error: 'That is not what this page is shown now.' }, 'Ben\'s page in a side room is not shown the Board\'s');
  // Kept across a restart; the reports are not.
  p.flush();
  const back = new Pages(p.file);
  assert.deepEqual(back.current(HALL, BEN, { board: true }).answer, { seq: board.seq, state: 'minimised', at: 1 });
  assert.deepEqual(back.current(HALL, ANA, { board: true }), { take: { ...board }, answer: null }, 'Ana\'s Back to chat answered her own take, not the Board\'s');
  assert.equal(back.live.size, 0);
  assert.ok(!JSON.stringify(onDisk(p)).includes('phone'), 'no page\'s report is written');
});

test('a report of no person, at no time, keeps nothing: no answer, no report, nothing written', () => {
  const p = store();
  const t = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 1 });
  const before = JSON.stringify(onDisk(p));
  const noPerson = { ok: false, error: 'No person to report for.' };
  // A Board page's report names the Board's take, so only its person's key stands between it and the answers.
  for (const key of ['', '__proto__', 'toString', 'constructor', undefined, null, 5, 'ana', 'a:', 'x:ana', { toString: () => ANA }]) {
    for (const state of ['dismissed', 'minimised', 'shown']) assert.deepEqual(p.report(HALL, 's1', { key, board: true, seq: t.seq, state }), noPerson, JSON.stringify([key, state]));
  }
  assert.deepEqual(p.report(HALL, 's1', { board: true, seq: t.seq, state: 'dismissed' }), noPerson, 'no key at all');
  for (const at of [NaN, Infinity, -Infinity, '5', null]) assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: t.seq, state: 'dismissed', at }), noPerson, String(at));
  assert.deepEqual(p.halls[HALL].answers, {});
  assert.equal(Object.getPrototypeOf(p.halls[HALL].answers), Object.prototype, 'the answers\' own prototype, untouched');
  assert.equal(p.live.size + p.liveHall.size, 0, 'no report kept');
  assert.deepEqual(p.pageState(HALL, { sid: 'other', key: '', board: true }), { seq: t.seq, state: 'waiting', words: '', at: 0 });
  assert.equal(JSON.stringify(onDisk(p)), before, 'nothing written');
});

test('a page reports only what a take of its kind can be: back on its chat in view or not; opened, a web page\'s alone, which is never shown', () => {
  assert.deepEqual(reportsOf('chat'), ['shown', 'hidden']);
  for (const kind of KINDS.filter((k) => k !== 'chat' && k !== 'web')) assert.deepEqual(reportsOf(kind), ['shown', 'hidden', 'failed', 'dismissed', 'minimised'], kind);
  // A web page is never seen into: in view it opened, and nothing else reports opened.
  assert.deepEqual(reportsOf('web'), ['opened', 'hidden', 'failed', 'dismissed', 'minimised']);
  assert.deepEqual(KINDS.filter((k) => reportsOf(k).includes('opened')), ['web'], 'opened is a web page\'s alone');
  assert.deepEqual(KINDS.map(inViewOf), ['shown', 'shown', 'shown', 'shown', 'shown', 'opened']);
  assert.ok(KINDS.every((k) => reportsOf(k).every((s) => REPORTS.includes(s))));
  const p = store();
  const clock = p.take(HALL, ANA, { kind: 'clock' }, { name: 'Ada' });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: clock.seq, state: 'opened' }), { ok: false, error: 'A page shown the clock reports one of: shown, hidden, failed, dismissed, minimised.' });
  const back = p.take(HALL, 'board', { kind: 'chat' }, { name: 'Ada' });
  for (const state of ['opened', 'failed', 'dismissed', 'minimised']) {
    assert.deepEqual(p.report(HALL, 's2', { key: BEN, board: true, seq: back.seq, state }), { ok: false, error: 'A page shown back to chat reports one of: shown, hidden.' }, state);
  }
  assert.deepEqual(p.halls[HALL].answers, {}, 'nothing to put away or minimise on a page back on its chat');
  assert.equal(p.live.size, 0);
  assert.deepEqual(p.report(HALL, 's2', { key: BEN, board: true, seq: back.seq, state: 'hidden' }), { ok: true, answer: null });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: clock.seq, state: 'shown' }), { ok: true, answer: null });
});

test('a Board take puts away the older takes and answers of everyone seated On stage, in its layer, and no one else\'s', () => {
  const p = store();
  const old = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' });
  const ana = p.take(HALL, ANA, { kind: 'blank' }, { name: 'Ada' });
  const ben = p.take(HALL, BEN, { kind: 'blank' }, { name: 'Ada' });
  const cy = p.take(HALL, CY, { kind: 'clock' }, { name: 'Ada' });
  assert.ok(p.report(HALL, 's-ana', { key: ANA, board: true, seq: ana.seq, state: 'dismissed' }).ok);
  assert.ok(p.report(HALL, 's-cy', { key: CY, board: true, seq: cy.seq, state: 'minimised' }).ok);
  // Ben's own take is newer than the Board's, so his Board page shows it; Ana and Ben sit On stage now, Cy does not.
  const next = p.take(HALL, 'board', { kind: 'stage' }, { name: 'Ada' }, { onStage: [ANA, BEN, 'not a key', 5, null] });
  assert.equal(next.seq, old.seq + 4);
  assert.deepEqual(Object.keys(p.halls[HALL].people), [CY], 'Ana\'s and Ben\'s could never show on a Board page again');
  assert.deepEqual(Object.keys(p.halls[HALL].answers), [CY], 'their answers go with them; Cy\'s stays');
  assert.equal(p.current(HALL, ANA, { board: true }).take, next);
  assert.equal(p.current(HALL, BEN).take, null, 'Ben\'s page in a side room is handed back to its chat');
  assert.deepEqual(p.current(HALL, CY), { take: cy, answer: { seq: cy.seq, state: 'minimised', at: p.halls[HALL].answers[CY].show.at } });
  assert.equal(ben.seq, 3);
  // An answer to the Board's own take is put away by the next Board take too.
  assert.ok(p.report(HALL, 's-ana', { key: ANA, board: true, seq: next.seq, state: 'minimised' }).ok);
  p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { onStage: [ANA] });
  assert.ok(!Object.hasOwn(p.halls[HALL].answers, ANA));
});

test('the bounds: 200 person takes and 500 answers a hall, 5,000 guests\' views, the oldest going first', () => {
  assert.deepEqual(BOUNDS, { views: 5000, personTakes: 200, answers: 500 });
  const p = store();
  const key = (i) => 'u:ubound' + String(i).padStart(6, '0');
  for (let i = 0; i < 201; i++) {
    const t = p.take(HALL, key(i), { kind: 'clock' }, { name: 'Ada' });
    if (i < 2) assert.ok(p.report(HALL, 's' + i, { key: key(i), seq: t.seq, state: 'minimised' }).ok);
  }
  const people = Object.keys(p.halls[HALL].people);
  assert.equal(people.length, 200);
  assert.ok(!people.includes(key(0)) && people.includes(key(1)) && people.includes(key(200)), 'the oldest take went');
  assert.deepEqual(Object.keys(p.halls[HALL].answers), [key(1)], 'and its answer with it');
  // 501 answers: the one given longest ago goes, an answer to an older take given just now among those kept.
  const q = store();
  const own = q.take(HALL, key(600), { kind: 'clock' }, { name: 'Ada' });
  const board = q.take(HALL, 'board', { kind: 'blank' }, { name: 'Ada' });
  for (let i = 0; i < 500; i++) assert.ok(q.report(HALL, 's' + i, { key: key(i), board: true, seq: board.seq, state: 'dismissed', at: 1000 + i }).ok);
  assert.ok(q.report(HALL, 's600', { key: key(600), seq: own.seq, state: 'minimised', at: 5000 }).ok);
  const answered = Object.keys(q.halls[HALL].answers);
  assert.equal(answered.length, 500);
  assert.ok(!answered.includes(key(0)) && answered.includes(key(1)) && answered.includes(key(600)));
  // The laptop's clock stepped back: the answer given now is kept, as its report said, and the one given longest ago goes.
  const late = q.report(HALL, 's500', { key: key(500), board: true, seq: board.seq, state: 'minimised', at: 1 });
  assert.deepEqual(late, { ok: true, answer: { seq: board.seq, state: 'minimised', at: 1 } });
  assert.deepEqual(q.current(HALL, key(500), { board: true }).answer, late.answer, 'kept, as answered');
  assert.ok(!Object.hasOwn(q.halls[HALL].answers, key(1)) && Object.hasOwn(q.halls[HALL].answers, key(2)));
  // An answer changed moves to the end: given most recently, so the last to go.
  assert.notEqual(Object.keys(q.halls[HALL].answers).at(-1), key(600));
  assert.ok(q.report(HALL, 's600', { key: key(600), seq: own.seq, state: 'dismissed', at: 2 }).ok);
  assert.equal(Object.keys(q.halls[HALL].answers).at(-1), key(600));
  // Across a restart the order given stands, whatever their `at` says.
  q.flush();
  assert.deepEqual(Object.keys(new Pages(q.file).halls[HALL].answers), Object.keys(q.halls[HALL].answers));
  // 5,001 guests' views: the one set longest ago goes.
  const v = store();
  for (let i = 0; i < 5000; i++) assert.equal(v.setView('uview' + i, i % 2 ? 'full' : 'simple', 10_000 + i), true);
  assert.equal(v.setView('uview0', 'simple', 1), true, 'set again (a laptop clock stepped back changes nothing of the order)');
  assert.equal(v.setView('uview5000', 'full', 20_000), true);
  assert.equal(v.views.size, 5000);
  assert.equal(v.viewOf('uview0'), 'simple', 'set again most recently, so kept');
  assert.equal(v.viewOf('uview1'), '', 'the one set longest ago went');
  // Across a restart too: the next to go is the one set longest ago, never the one whose `at` is oldest.
  v.flush();
  const v2 = new Pages(v.file);
  v2.hold();
  assert.equal(v2.setView('uview5001', 'full', 20_001), true);
  assert.deepEqual([v2.viewOf('uview2'), v2.viewOf('uview0'), v2.viewOf('uview3')], ['', 'simple', 'full']);
  // A file over its bounds is held to them as it is read, in the file's order: the order set, as the store writes it.
  const big = { v: 1, views: {}, halls: { [HALL]: { seq: 300, board: {}, people: {}, answers: {} } } };
  for (let i = 5001; i >= 0; i--) big.views['u:uview' + i] = { view: 'full', at: i };
  for (let i = 1; i <= 210; i++) big.halls[HALL].people[key(i)] = { show: { seq: i, content: { kind: 'clock' }, by: { name: 'Ada' }, at: i } };
  const file = path.join(folder(), 'pages.json');
  fs.writeFileSync(file, JSON.stringify(big));
  const read = new Pages(file);
  assert.equal(read.views.size, 5000);
  assert.ok(!read.views.has('u:uview5001') && !read.views.has('u:uview5000') && read.views.has('u:uview4999') && read.views.has('u:uview0'), 'the first two set went, whatever their `at` says');
  assert.equal(Object.keys(read.halls[HALL].people).length, 200);
  assert.ok(!Object.hasOwn(read.halls[HALL].people, key(10)) && Object.hasOwn(read.halls[HALL].people, key(11)));
});

test('a guest\'s chat view: Simple or Full, or by their seat again; the words are the accounts\'', () => {
  assert.deepEqual(VIEWS, ACCOUNT_VIEWS);
  const p = store();
  assert.equal(p.viewOf('uguest00001'), '', 'by their seat until it is set');
  assert.equal(p.setView('uguest00001', 'simple', 1), true);
  assert.equal(p.viewOf('uguest00001'), 'simple');
  assert.equal(p.setView('uguest00001', 'full', 2), true);
  assert.deepEqual(onDisk(p).views, { 'u:uguest00001': { view: 'full', at: 2 } });
  for (const [uid, view] of [['uguest00001', 'director'], ['uguest00001', 5], ['uguest00001', undefined], ['', 'full'], ['a b', 'full'], [null, 'full'], ['__proto__', 'x']]) assert.equal(p.setView(uid, view), false, JSON.stringify([uid, view]));
  assert.equal(p.viewOf('uguest00001'), 'full', 'a refused view changes nothing');
  assert.equal(p.setView('uguest00001', null), true, 'null: by their seat again');
  assert.equal(p.viewOf('uguest00001'), '');
  assert.equal(p.setView('uguest00001', ''), true, 'by their seat again, again: nothing to change');
  assert.deepEqual(onDisk(p).views, {});
  assert.equal(p.viewOf({ toString: () => 'uguest00001' }), '');
});

test('status: a mark and its words, person first, from each page\'s report on the take it holds', () => {
  const at = Date.UTC(2026, 10, 4, 14, 2);
  const take = { seq: 4, content: { kind: 'clock' }, by: { name: 'Ada' }, at };
  const pg = (state, name = 'Ana', more = {}) => ({ state, name, words: '', at, ...more });
  const st = (pages, o = {}) => Pages.status(take, pages, o);
  const said = (r) => [r.mark, r.words];
  assert.deepEqual(st([pg('shown')], { name: 'Ana' }), { seq: 4, showing: 'the clock', kind: 'clock', mark: '✓', words: 'On Ana\'s page', pages: 1, on: 1 });
  assert.deepEqual(said(st([pg('shown'), pg('shown')], { name: 'Ana' })), ['✓', 'On all 2 of Ana\'s pages']);
  assert.deepEqual(said(st([1, 2, 3, 4, 5, 6].map(() => pg('shown')), { board: true })), ['✓', 'On all 6 Board pages']);
  assert.deepEqual(said(st([pg('shown')], { board: true })), ['✓', 'On the 1 Board page']);
  // ◷ sending until every page has said; △ when one could not.
  assert.deepEqual(said(st([pg('shown'), pg('shown'), pg('waiting'), pg('waiting')], { board: true })), ['◷', 'Sending · on 2 of 4 pages']);
  assert.deepEqual(said(st([pg('waiting')], { board: true })), ['◷', 'Sending']);
  assert.deepEqual(said(st([pg('failed', 'Ana', { words: 'the picture didn\'t load' })], { name: 'Ana' })), ['△', 'Couldn\'t show it: the picture didn\'t load']);
  assert.deepEqual(said(st([pg('shown'), pg('failed'), pg('waiting')], { board: true })), ['△', 'Couldn\'t show it on 1 of 3 pages']);
  // ○ every page back to chat, ▭ every page minimised, by whom and when (the laptop's clock).
  assert.deepEqual(said(st([pg('dismissed'), pg('dismissed', 'Ana', { at: at - 60_000 })], { name: 'Ana' })), ['○', 'Ana went back to chat at ' + clockOf(at)]);
  assert.deepEqual(said(st([pg('dismissed', 'Ana'), pg('dismissed', 'Ben')], { board: true })), ['○', 'Ana and Ben went back to chat']);
  assert.deepEqual(said(st([pg('dismissed', 'Ana'), pg('dismissed', 'Ben'), pg('dismissed', 'Cy'), pg('dismissed', '')], { board: true })), ['○', 'Ana, Ben and 2 more went back to chat']);
  assert.deepEqual(said(st([pg('minimised')], { name: 'Ana', clock: () => '14:02' })), ['▭', 'Ana minimised it at 14:02']);
  // ◇ a web page opened, which cannot be seen into: never ✓.
  assert.deepEqual(said(st([pg('opened'), pg('shown')], { name: 'Ana' })), ['◇', 'Opened · AGMessage can\'t see inside web pages']);
  // ◐ the rest: how many show it, and why the others do not.
  assert.deepEqual(said(st([pg('shown'), pg('shown'), pg('shown'), pg('shown'), pg('shown'), pg('hidden')], { board: true })), ['◐', '5 of 6 showing · 1 asleep or in another app']);
  assert.deepEqual(said(st([pg('shown', 'Cy'), pg('dismissed', 'Ana'), pg('minimised', 'Ben'), pg('other', 'Di')], { board: true })), ['◐', '1 of 4 showing · Ana went back to chat · Ben minimised it · 1 showing something else']);
  // ✕ no page open; ○ nothing shown yet.
  assert.deepEqual(st([], { board: true }), { seq: 4, showing: 'the clock', kind: 'clock', mark: '✕', words: 'Nobody on the Board is online', pages: 0, on: 0 });
  assert.deepEqual(said(st([], { name: 'Ana' })), ['✕', 'Ana has no page open in this hall']);
  assert.deepEqual(said(st(undefined)), ['✕', 'No page of theirs is open in this hall'], 'no list, no name');
  assert.deepEqual(said(st([pg('shown'), pg('shown')])), ['✓', 'On all 2 of their pages']);
  assert.deepEqual(said(st([pg('shown')])), ['✓', 'On their page']);
  assert.deepEqual(Pages.status(null, [pg('waiting')], { board: true }), { seq: 0, showing: 'the chat', kind: '', mark: '○', words: 'Nothing shown yet', pages: 1, on: 0 });
  assert.equal(Pages.status({ seq: 1, content: { kind: 'holding' } }, [pg('shown')], { hallHolding: PIC }).showing, 'a holding slide');
  // A hand-back (`chat`) every page says it is back on: ○ back to chat, never ✓ on screen; ◷ until each has said.
  const back = (pages, o) => said(Pages.status({ seq: 5, content: { kind: 'chat' } }, pages, o));
  assert.deepEqual(Pages.status({ seq: 5, content: { kind: 'chat' } }, [pg('shown'), pg('shown')], { board: true }), { seq: 5, showing: 'back to chat', kind: 'chat', mark: '○', words: 'Back to chat on all 2 Board pages', pages: 2, on: 2 });
  assert.deepEqual(back([pg('shown')], { board: true }), ['○', 'Back to chat on the 1 Board page']);
  assert.deepEqual(back([pg('shown')], { name: 'Ana' }), ['○', 'Back to chat on Ana\'s page']);
  assert.deepEqual(back([pg('shown'), pg('shown')], { name: 'Ana' }), ['○', 'Back to chat on all 2 of Ana\'s pages']);
  assert.deepEqual(back([pg('shown'), pg('shown'), pg('hidden')], { board: true }), ['◐', '2 of 3 back to chat · 1 asleep or in another app']);
  assert.deepEqual(back([pg('shown'), pg('waiting')], { board: true }), ['◷', 'Sending · on 1 of 2 pages']);
  // Every mark it draws is one of the marks' table, each with one meaning; ◷ is sending and ○ back to chat.
  const drawn = new Set([st([pg('shown')]), st([pg('waiting')]), st([pg('failed')]), st([pg('dismissed')]), st([pg('minimised')]), st([pg('opened')]), st([pg('hidden')]), st([]), Pages.status(null, [pg('waiting')])].map((r) => r.mark));
  assert.deepEqual([...drawn].sort(), Object.values(MARKS).sort(), 'every mark it draws, and no other');
});

test('status read from the store: each page\'s report on the take it is shown now, its person\'s answer first', () => {
  const p = store();
  const t = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 1 });
  const board = [{ sid: 's-ana', key: ANA, board: true, name: 'Ana' }, { sid: 's-ben', key: BEN, board: true, name: 'Ben' }, { sid: 's-ben2', key: BEN, board: true, name: 'Ben' }];
  const look = () => { const r = p.status(HALL, 'board', board); return [r.seq, r.mark, r.words]; };
  assert.deepEqual(look(), [t.seq, '◷', 'Sending'], 'sent is not shown');
  assert.ok(p.report(HALL, 's-ana', { key: ANA, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.ok(p.report(HALL, 's-ben', { key: BEN, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.deepEqual(look(), [t.seq, '◷', 'Sending · on 2 of 3 pages']);
  assert.ok(p.report(HALL, 's-ben2', { key: BEN, board: true, seq: t.seq, state: 'hidden' }).ok);
  assert.deepEqual(look(), [t.seq, '◐', '2 of 3 showing · 1 asleep or in another app']);
  assert.ok(p.report(HALL, 's-ben2', { key: BEN, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.deepEqual(look(), [t.seq, '✓', 'On all 3 Board pages']);
  // A page that goes takes its report with it: one that comes back says again.
  p.left('s-ben2');
  p.left('never-here');
  assert.deepEqual(look(), [t.seq, '◷', 'Sending · on 2 of 3 pages']);
  // In another hall, the operator hands the Board back to its chat: sending, then back to chat once every page says so.
  const handBack = p.take(OTHER, 'board', { kind: 'chat' }, { name: 'Ada' });
  const there = board.slice(0, 2);
  assert.equal(p.status(OTHER, 'board', there).mark, '◷');
  for (const pg of there) assert.ok(p.report(OTHER, pg.sid, { key: pg.key, board: true, seq: handBack.seq, state: 'shown' }).ok);
  assert.deepEqual(p.status(OTHER, 'board', there), { seq: handBack.seq, showing: 'back to chat', kind: 'chat', mark: '○', words: 'Back to chat on all 2 Board pages', pages: 2, on: 2 });
  p.forgetHall(OTHER);
  assert.ok(p.report(HALL, 's-ana', { key: ANA, board: true, seq: t.seq, state: 'shown' }).ok, 'its pages report in this hall again');
  assert.ok(p.report(HALL, 's-ben', { key: BEN, board: true, seq: t.seq, state: 'shown' }).ok);
  // Ana's own newer take: her Board page shows something else; her status is her own take's.
  const mine = p.take(HALL, ANA, { kind: 'blank' }, { name: 'Ada' }, { at: 2 });
  assert.ok(p.report(HALL, 's-ben2', { key: BEN, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.deepEqual(look(), [t.seq, '◐', '2 of 3 showing · 1 showing something else']);
  const ana = [{ sid: 's-ana', key: ANA, board: true, name: 'Ana' }, { sid: 's-ana-legal', key: ANA, board: false, name: 'Ana' }];
  assert.deepEqual(p.status(HALL, ANA, ana, { name: 'Ana' }), { seq: mine.seq, showing: 'blank', kind: 'blank', mark: '◷', words: 'Sending', pages: 2, on: 0 });
  assert.ok(p.report(HALL, 's-ana-legal', { key: ANA, seq: mine.seq, state: 'dismissed', at: 3 }).ok);
  assert.equal(p.status(HALL, ANA, ana, { name: 'Ana' }).words, 'Ana went back to chat at ' + clockOf(3), 'her Back to chat holds on her Board page too');
  assert.deepEqual(p.pageState(HALL, { sid: 's-ana', key: ANA, board: true }), { seq: mine.seq, state: 'dismissed', words: '', at: 3 });
  // A report's words are cleaned and bounded; a report from a page of another person is not that page's.
  assert.ok(p.report(OTHER, 'x', { key: BEN, seq: 1, state: 'shown' }).ok === false);
  const c = p.take(OTHER, BEN, { kind: 'clock' }, { name: 'Ada' });
  assert.ok(p.report(OTHER, 'x', { key: BEN, seq: c.seq, state: 'failed', words: '\u202Ebad ' + 'w'.repeat(300) }).ok);
  assert.equal(p.pageState(OTHER, { sid: 'x', key: BEN }).words, ('bad ' + 'w'.repeat(300)).slice(0, 160));
  assert.equal(p.pageState(OTHER, { sid: 'x', key: CY }).state, 'waiting', 'nothing for Cy, and Ben\'s report is not Cy\'s');
  assert.deepEqual(p.status(OTHER, 'board', []), { seq: 0, showing: 'the chat', kind: '', mark: '✕', words: 'Nobody on the Board is online', pages: 0, on: 0 });
  assert.equal(p.status(HALL, 'board', 'not a list').mark, '✕');
  // A page that moved to another hall reports there: its report in the first is gone.
  assert.ok(p.report(HALL, 'x', { key: BEN, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.equal(p.pageState(OTHER, { sid: 'x', key: BEN }).state, 'waiting');
});

test('a Board page out of view while a take is drawn on it: from its first report out of view to the report or the leave that ends it', () => {
  const p = store();
  const t = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 1 });
  const rep = (sid, state, at, o = {}) => p.report(HALL, sid, { key: BEN, board: true, seq: t.seq, state, at, ...o });
  assert.deepEqual(rep('s1', 'shown', 1000), { ok: true, answer: null }, 'in view: no time out of view to say');
  assert.deepEqual(rep('s1', 'hidden', 2000), { ok: true, answer: null }, 'out of view: its time begins, said once it ends');
  assert.deepEqual(rep('s1', 'hidden', 2500), { ok: true, answer: null }, 'still out of view: it goes on from the first');
  // A newer take while it is out of view: the page says it is hidden on that one too, and the time goes on.
  const next = p.take(HALL, 'board', { kind: 'blank' }, { name: 'Ada' }, { at: 2600 });
  assert.deepEqual(p.report(HALL, 's1', { key: BEN, board: true, seq: next.seq, state: 'hidden', at: 9000 }), { ok: true, answer: null });
  assert.deepEqual(p.report(HALL, 's1', { key: BEN, board: true, seq: next.seq, state: 'shown', at: 34_000 }), { ok: true, answer: null, hiddenMs: 32_000 }, 'back in view: 2,000 to 34,000');
  // A leave ends it too; a page that reported nothing, or was in view, leaves with nothing to say.
  assert.ok(p.report(HALL, 's2', { key: BEN, board: true, seq: next.seq, state: 'hidden', at: 40_000 }).ok);
  assert.deepEqual(p.left('s2', 52_500), { hall: HALL, hiddenMs: 12_500 });
  assert.deepEqual(p.left('s1', 60_000), { hall: HALL }, 'in view as it went');
  assert.equal(p.left('never-here'), null);
  // Only a Board page, and only while a take is drawn: a person's page in a side room, and a page handed back to its
  // chat, are no reading of the Board's tablets with a take up.
  const mine = p.take(HALL, CY, { kind: 'clock' }, { name: 'Ada' }, { at: 60_100 });
  assert.ok(p.report(HALL, 's3', { key: CY, seq: mine.seq, state: 'hidden', at: 61_000 }).ok);
  assert.deepEqual(p.report(HALL, 's3', { key: CY, seq: mine.seq, state: 'shown', at: 99_000 }), { ok: true, answer: null }, 'not On stage');
  const back = p.take(HALL, 'board', { kind: 'chat' }, { name: 'Ada' }, { at: 100_000 });
  assert.ok(p.report(HALL, 's4', { key: BEN, board: true, seq: back.seq, state: 'hidden', at: 101_000 }).ok);
  assert.deepEqual(p.left('s4', 200_000), { hall: HALL }, 'back on its chat');
  // A report refused (another take's number) neither begins nor ends it.
  assert.ok(p.report(HALL, 's5', { key: BEN, board: true, seq: back.seq, state: 'shown', at: 1 }).ok);
  const drawn = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 300_000 });
  assert.ok(p.report(HALL, 's5', { key: BEN, board: true, seq: drawn.seq, state: 'hidden', at: 300_500 }).ok);
  assert.equal(p.report(HALL, 's5', { key: BEN, board: true, seq: back.seq, state: 'shown', at: 301_000 }).ok, false);
  assert.deepEqual(p.report(HALL, 's5', { key: BEN, board: true, seq: drawn.seq, state: 'shown', at: 302_000 }), { ok: true, answer: null, hiddenMs: 1_500 });
});

test('a hall closed takes what its people\'s pages were shown with it', () => {
  const p = store();
  const t = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' });
  p.take(OTHER, 'board', { kind: 'blank' }, { name: 'Ada' });
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: t.seq, state: 'shown' }).ok);
  assert.equal(p.forgetHall(HALL), true);
  assert.equal(p.forgetHall(HALL), false, 'once');
  assert.equal(p.forgetHall('__proto__'), false);
  assert.deepEqual(Object.keys(onDisk(p).halls), [OTHER]);
  assert.equal(p.live.has(HALL) || p.liveHall.has('s1'), false, 'its pages\' reports too');
  p.left('s1');
  assert.equal(p.current(HALL, ANA, { board: true }).take, null);
});

test('a record of the wrong shape is dropped as the file is read; the rest is kept', () => {
  const file = path.join(folder(), 'pages.json');
  const take = (seq, content = { kind: 'clock' }) => ({ seq, content, by: { name: 'Ada' }, at: 5 });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    views: {
      'u:ugood00001': { view: 'simple', at: 1 }, 'u:ugood00002': { view: 'full', at: 2, clockLater: true },
      'a:aaccount01': { view: 'full', at: 1 }, 'u:bad key': { view: 'full', at: 1 }, 'u:ubadview01': { view: 'director', at: 1 }, 'u:unoat00001': { view: 'full' },
      'u:uempty0001': { view: '', at: 1 }, 'u:ulist00001': ['full'], 'u:PROTO': { view: 'full', at: 1 },
    },
    halls: {
      [HALL]: {
        seq: 6,
        board: { show: take(6), info: take(5) },
        people: {
          [ANA]: { show: take(4) }, [BEN]: { show: take(7) }, [CY]: { show: take(3, { kind: 'brand' }) }, 'u:umissing01': { show: { seq: 2, content: { kind: 'clock' }, at: 5 } },
          'u:uholding01': { show: take(2, { kind: 'holding', image: '/uploads/../x.png' }) }, 'u:uholding02': { show: take(1, { kind: 'holding', image: PIC, drop: 1 }) },
          nokey: { show: take(1) }, 'u:unoshow001': { info: take(1) }, 'u:uattext001': { show: { ...take(1), at: 'now' } },
        },
        answers: { [ANA]: { show: { seq: 4, state: 'dismissed', at: 9 } }, [BEN]: { show: { seq: 6, state: 'shown', at: 9 } }, [CY]: { show: { seq: 9, state: 'dismissed', at: 9 } }, 'u:uans00001': 'dismissed' },
      },
      lowercase: { seq: 1, board: {}, people: {}, answers: {} },
      HALLC3: { seq: 1.5, board: {}, people: {}, answers: {} },
      HALLD4: { seq: 2, board: 'clock', people: [], answers: null },
      HALLE5: [1],
    },
  }).replace('"u:PROTO"', '"__proto__"'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('"__proto__"'), 'a key a parse makes its own');
  const p = new Pages(file);
  assert.equal(p.unread, '');
  assert.deepEqual(Object.fromEntries(p.views), { 'u:ugood00001': { view: 'simple', at: 1 }, 'u:ugood00002': { view: 'full', at: 2 } });
  assert.deepEqual(Object.keys(p.halls), [HALL, 'HALLD4']);
  assert.deepEqual(p.halls.HALLD4, { seq: 2, board: {}, people: {}, answers: {} }, 'a hall\'s parts that do not read are empty, its counter kept');
  const h = p.halls[HALL];
  assert.deepEqual(h.board, { show: take(6) }, 'a layer the store does not keep is dropped');
  assert.deepEqual(h.people, { [ANA]: { show: take(4) }, 'u:uholding02': { show: take(1, { kind: 'holding', image: PIC }) } });
  assert.deepEqual(h.answers, { [ANA]: { show: { seq: 4, state: 'dismissed', at: 9 } } });
  // A file whose whole is not one: nothing kept, and the next take numbers from 1. Neither file there: the same.
  for (const text of ['[1, 2]', '"pages"', 'null', '{"v": 1, "views": [], "halls": []}']) {
    fs.writeFileSync(file, text);
    fs.rmSync(file + '.bak', { force: true });
    const q = new Pages(file);
    assert.deepEqual([q.views.size, q.halls], [0, {}], text);
  }
  const none = new Pages(path.join(folder(), 'pages.json'));
  assert.deepEqual([none.views.size, none.halls, none.unread], [0, {}, '']);
  // A file that cannot be read says why: what it holds is not known this run.
  const dir = path.join(folder(), 'pages.json');
  fs.mkdirSync(dir);
  assert.equal(new Pages(dir).unread, 'EISDIR');
});

test('hold(): nothing is written until this copy holds its data folder; then what changed before is written', async () => {
  const file = path.join(folder(), 'pages.json');
  const p = new Pages(file);
  p.take(HALL, 'board', { kind: 'clock' }, { name: 'Ada' }, { at: 1 });
  assert.equal(p.setView('uguest00001', 'simple', 2), true);
  assert.equal(p.flush(), true, 'nothing waits in the lane');
  await new Promise((resolve) => { setTimeout(resolve, 250); });   // past the lane's own wait
  assert.equal(fs.existsSync(file), false, 'nothing written before the hold');
  assert.equal(p.dirty, true);
  p.hold();
  p.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, views: { 'u:uguest00001': { view: 'simple', at: 2 } }, halls: { [HALL]: { seq: 1, board: { show: { seq: 1, content: { kind: 'clock' }, by: { name: 'Ada' }, at: 1 } }, people: {}, answers: {} } } });
  assert.equal(p.dirty, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'read by this account alone');
  // Held with nothing changed: nothing is written.
  const quiet = path.join(folder(), 'pages.json');
  const q = new Pages(quiet);
  q.hold();
  q.flush();
  assert.equal(fs.existsSync(quiet), false);
  // A restart reads it back whole, the store's keys are the plan's.
  const back = new Pages(file);
  assert.deepEqual([back.viewOf('uguest00001'), back.current(HALL, ANA, { board: true }).take.content], ['simple', { kind: 'clock' }]);
});

test('the store\'s hall keys are the rooms\' keys', () => {
  for (const code of ['ABC234', 'ABCD2345', 'abc234', 'A.B', 'AB', 'ABCDEFGHJKLMN', 'HALLA1.LEGAL123']) {
    const p = store({ held: false });
    assert.equal(p.take(code, 'board', { kind: 'clock' }, {}) !== null, RoomStore.validCode(code), code);
  }
});

// ---------------------------------------------------------------- a web page (plan 1-§5.6, 4-§5.9.2.2, 4-§5.9.9)
const secretbox = require('../lib/secretbox');
const WEB_WORDS = { error: 'A web page is shown by its https address, as a browser shows it.' };
const WEB_SELF = { error: 'That address is AGMessage itself: show a page of another site.' };
const VOTE = 'https://vote.example.com/poll/7?token=abc#q2';
/** A store that seals a web page's address with a machine key of its own (lib/secretbox.js, as the server's store does). */
function sealing({ file = path.join(folder(), 'pages.json') } = {}) {
  const p = new Pages(file, { seal: secretbox.seal, open: secretbox.open });
  p.hold();
  p.file = file;
  return p;
}
test.before(() => { process.env.AGM_KEY_DIR = folder(); secretbox._reset(); });

test('webUrl: an https address as the URL parser writes it, with its host; another scheme, a user name or password, AGMessage itself, an address too long or none, refused in words', () => {
  assert.deepEqual(webUrl('https://Vote.Example.com/poll?q=1#:~:text=net%20revenue'), { url: 'https://vote.example.com/poll?q=1#:~:text=net%20revenue', host: 'vote.example.com' }, 'its fragment kept, its host in lower case');
  assert.deepEqual(webUrl('  https://example.com  '), { url: 'https://example.com/', host: 'example.com' });
  assert.deepEqual(webUrl('https://bücher.example/'), { url: 'https://xn--bcher-kva.example/', host: 'xn--bcher-kva.example' });
  assert.deepEqual(webUrl('https://[2001:db8::7]:8443/x'), { url: 'https://[2001:db8::7]:8443/x', host: '[2001:db8::7]' });
  // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
  for (const v of ['http://example.com/', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'blob:https://example.com/1', 'file:///etc/passwd', 'ftp://example.com/', 'wss://example.com/',
    'example.com', '//example.com/', 'https://', 'https:', 'https://exa mple.com/', 'https://a..b/', '', '   ', 5, null, undefined, true, { toString: 1 }, { toString: () => 'https://example.com/' }, ['https://example.com/']]) {
    assert.deepEqual(webUrl(v), WEB_WORDS, JSON.stringify(v) + '');
  }
  for (const v of ['https://ana@example.com/', 'https://ana:pw@example.com/', 'https://:pw@example.com/']) assert.deepEqual(webUrl(v), { error: 'An address with a user name or a password is not shown: show the page without them.' }, v);
  // This machine, by every name a machine gives itself, however it is written: the URL parser writes each in one form.
  for (const v of ['https://localhost/', 'https://LOCALHOST:8443/', 'https://app.localhost/', 'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://127.255.255.254/',
    'https://0.0.0.0/', 'https://[::1]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[::]/', 'https://[::ffff:127.0.0.1]/',
    // A name's trailing dot names the same machine (the parser keeps it on a name, and drops it from an address).
    'https://localhost./', 'https://LocalHost.:8443/x', 'https://app.localhost./', 'https://127.0.0.1./']) assert.deepEqual(webUrl(v), WEB_SELF, v);
  // And by the names and addresses this AGMessage answers on: its machine's name, its network addresses, the tunnel.
  const self = ['AGM-Laptop', '192.168.1.20', 'abc-def.trycloudflare.com'];
  for (const v of ['https://agm-laptop/', 'https://AGM-LAPTOP.:443/', 'https://192.168.1.20/admin.html', 'https://abc-def.trycloudflare.com/app.html']) assert.deepEqual(webUrl(v, self), WEB_SELF, v);
  assert.deepEqual(webUrl('https://192.168.1.21/', self), { url: 'https://192.168.1.21/', host: '192.168.1.21' }, 'another machine of the venue is not this one');
  assert.deepEqual(webUrl('https://agm-laptop/', [5, null, '']), { url: 'https://agm-laptop/', host: 'agm-laptop' }, 'a name that is not one is not read');
  // At most WEB_MAX characters, as typed and as the parser writes it.
  const head = 'https://example.com/';
  assert.equal(webUrl(head + 'a'.repeat(WEB_MAX - head.length)).url.length, WEB_MAX);
  assert.deepEqual(webUrl(head + 'a'.repeat(WEB_MAX - head.length + 1)), { error: 'That address is longer than 2048 characters.' });
  assert.deepEqual(webUrl(head + ' '.repeat(10) + 'a'.repeat(WEB_MAX - head.length - 10)), WEB_WORDS, 'written out by the parser, longer than the bound');
});

test('cleanPage: a web page needs its right before its address is read, then the address rules; {kind, url, host}, nothing else kept', () => {
  const facts = { web: true, selfHosts: ['agm-laptop'] };
  assert.deepEqual(cleanPage({ kind: 'web', url: VOTE, host: 'evil.example', urlSealed: 'enc1:AAAA', extra: 1 }, facts), { kind: 'web', url: VOTE, host: 'vote.example.com' }, 'the host is the address\'s, never the asker\'s');
  // The right first, in the words the server gives for who asks (or its own), whatever the address.
  const noRight = { error: 'Web pages on the stage need their own right — ask an admin.' };
  for (const f of [undefined, null, {}, { web: false }, { web: 1 }, { web: '' }, { web: () => true }]) assert.deepEqual(cleanPage({ kind: 'web', url: VOTE }, f), noRight, JSON.stringify(f));
  const off = 'Web pages from backstage guests are off in this hall — ask the admin.';
  assert.deepEqual(cleanPage({ kind: 'web', url: 'javascript:x' }, { web: off }), { error: off }, 'the right is read before the address');   // eslint-disable-line no-script-url
  // Then the address, read by its type: a field of another type refused with the address's words.
  for (const url of [undefined, null, 5, { toString: () => VOTE }, [VOTE]]) assert.deepEqual(cleanPage({ kind: 'web', url }, facts), WEB_WORDS, JSON.stringify(url));
  assert.deepEqual(cleanPage({ kind: 'web', url: 'https://agm-laptop/' }, facts), WEB_SELF, 'the server\'s own names, from its facts');
  assert.deepEqual(cleanPage({ kind: 'web', url: 'http://vote.example.com/' }, facts), WEB_WORDS);
});

test('a web take is kept sealed beside its host, never its address in clear; told to the pages it is shown on opened; a run that cannot seal keeps none', () => {
  const p = sealing();
  const content = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const t = p.take(HALL, 'board', content, { name: 'Gil', guest: true, id: 'secret', who: 'code:ugil0000001' });
  assert.deepEqual([t.content.kind, t.content.host, Object.keys(t.content)], ['web', 'vote.example.com', ['kind', 'host', 'urlSealed']]);
  assert.match(t.content.urlSealed, /^enc1:/);
  assert.deepEqual(t.by, { name: 'Gil', guest: true, who: 'code:ugil0000001' }, 'a code guest\'s take is kept as one, with who put it up');
  // Who put it up is kept only as an actor's kind and id: anything else is not kept.
  for (const who of ['ugil0000001', 'guest:ugil0000001', 'code:', 'code:u g', 'code:' + 'u'.repeat(65), 5, null, { t: 'code' }]) {
    assert.deepEqual(p.take(OTHER, 'board', content, { name: 'Gil', who }).by, { name: 'Gil' }, JSON.stringify(who));
  }
  for (const who of ['account:a1b2c3', 'admin:host']) assert.deepEqual(p.take(OTHER, 'board', content, { name: 'Ana', who }).by, { name: 'Ana', who });
  assert.deepEqual(p.told(t.content), { kind: 'web', url: VOTE, host: 'vote.example.com' }, 'opened for a page it is shown on');
  assert.deepEqual(p.told({ kind: 'clock' }), { kind: 'clock' }, 'every other kind told as it is kept');
  assert.equal(describePage(t.content), 'a web page on vote.example.com');
  // The file: the host, and no part of the address in clear (read the file).
  const text = (p.flush(), fs.readFileSync(p.file, 'utf8'));
  for (const part of ['https://', 'poll/7', 'token=abc', '#q2']) assert.ok(!text.includes(part), 'pages.json holds no clear address: ' + part);
  assert.ok(text.includes('"host":"vote.example.com"'));
  // Read back by this machine: the take as it was; by a store whose key is another's, its address opens as none.
  const again = new Pages(p.file, { seal: secretbox.seal, open: secretbox.open });
  assert.deepEqual(again.current(HALL, '', { board: true }).take, t);
  const elsewhere = new Pages(p.file);
  assert.deepEqual(elsewhere.told(elsewhere.current(HALL, '', { board: true }).take.content), { kind: 'web', url: '', host: 'vote.example.com' });
  // A run that cannot seal (no machine key: seal throws, or seals nothing) keeps no web take, and numbers none.
  for (const seal of [() => { throw new Error('no machine key'); }, () => '', () => 'plain https://x/']) {
    const q = new Pages(path.join(folder(), 'pages.json'), { seal, open: secretbox.open });
    assert.equal(q.take(HALL, 'board', content, { name: 'Gil' }), null);
    assert.deepEqual(q.halls, {}, 'nothing numbered');
  }
  // Only what cleanPage made is kept: a sealed address handed in, an http one, none, a host alone.
  for (const c of [{ kind: 'web', host: 'example.com', urlSealed: t.content.urlSealed }, { kind: 'web', url: 'http://example.com/', host: 'example.com' }, { kind: 'web' }, { kind: 'web', host: 'example.com' }]) {
    assert.equal(p.take(HALL, ANA, c, { name: 'Gil' }), null, JSON.stringify(c));
  }
  assert.equal(p.halls[HALL].seq, 1);
  // A web take read from a file in a shape no store of ours writes is dropped: an address in clear, a host that is not one, a seal that is not one.
  const file = path.join(folder(), 'pages.json');
  const take = (seq, c) => ({ seq, content: c, by: { name: 'Gil' }, at: 5 });
  fs.writeFileSync(file, JSON.stringify({ v: 1, halls: { [HALL]: { seq: 5, board: { show: take(5, t.content) }, people: {
    [ANA]: { show: take(1, { kind: 'web', url: VOTE, host: 'vote.example.com' }) }, [BEN]: { show: take(2, { kind: 'web', host: 'Vote.Example.com', urlSealed: t.content.urlSealed }) },
    [CY]: { show: take(3, { kind: 'web', host: 'vote.example.com', urlSealed: VOTE }) }, 'u:uok0000001': { show: take(4, { ...t.content, extra: VOTE }) },
  }, answers: {} } } }));
  const read = new Pages(file, { seal: secretbox.seal, open: secretbox.open });
  assert.deepEqual(read.halls[HALL].board, { show: take(5, t.content) });
  assert.deepEqual(read.halls[HALL].people, { 'u:uok0000001': { show: take(4, t.content) } }, 'the keys it does not know left behind');
});

test('a web page reports opened, never shown: in view it opened (◇, never ✓), and Show it again says opened', () => {
  const p = sealing();
  const content = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const t = p.take(HALL, ANA, content, { name: 'Tom' }, { at: 100 });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'shown', at: 101 }), { ok: false, error: 'A page shown a web page on vote.example.com reports one of: opened, hidden, failed, dismissed, minimised.' });
  const page = { sid: 's1', key: ANA, board: false, name: 'Ana' };
  assert.deepEqual(p.status(HALL, ANA, [page], { name: 'Ana' }).mark, MARKS.waiting, 'sending until the page says');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'opened', at: 102 }), { ok: true, answer: null });
  const st = p.status(HALL, ANA, [page], { name: 'Ana' });
  assert.deepEqual([st.mark, st.words, st.showing, st.kind, st.on], [MARKS.unseen, 'Opened · AGMessage can\'t see inside web pages', 'a web page on vote.example.com', 'web', 1]);
  assert.ok(!JSON.stringify(st).includes('poll/7'), 'the status names the host alone');
  // Not loaded in time: △ with its words. Back to chat, then Show it again within 10 s: said opened, with `again`.
  assert.ok(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'failed', words: 'the page did not load', at: 103 }).ok);
  assert.deepEqual([p.status(HALL, ANA, [page]).mark, p.status(HALL, ANA, [page]).words], [MARKS.couldNot, 'Couldn\'t show it: the page did not load']);
  assert.equal(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'dismissed', at: 104 }).answer.state, 'dismissed');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'shown', again: true, at: 105 }).ok, false, 'shown is no web page\'s word, even to show it again');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'opened', again: true, at: 106 }), { ok: true, answer: null });
  assert.equal(p.status(HALL, ANA, [page]).mark, MARKS.unseen);
});

test('the web pages a guest put up that stay up: the Board\'s, and each person\'s not put away, a page of theirs open or not; an account\'s and an older one are not; counted in words for the admin', () => {
  const p = sealing();
  const content = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  assert.deepEqual(p.guestWeb(HALL), [], 'a hall with no book has none');
  const board = p.take(HALL, 'board', content, { name: 'Gil', guest: true });
  const ben = p.take(HALL, BEN, content, { name: 'Gil', guest: true });
  const cy = p.take(HALL, CY, content, { name: 'Gil', guest: true });
  p.take(HALL, ANA, content, { name: 'Tom' });
  p.take(OTHER, 'board', content, { name: 'Gil', guest: true });
  assert.deepEqual(p.guestWeb(HALL), [{ to: 'board', seq: board.seq }, { to: BEN, seq: ben.seq }, { to: CY, seq: cy.seq }]);
  // Put away by its person (Back to chat): no longer up for them. A take after it: the guest's is no longer shown.
  assert.ok(p.report(HALL, 's1', { key: CY, seq: cy.seq, state: 'dismissed' }).ok);
  p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' });
  assert.deepEqual(p.guestWeb(HALL), [{ to: BEN, seq: ben.seq }]);
  assert.deepEqual(p.guestWeb('__proto__'), []);
  // As the admin is told them once guests may no longer show web pages: a count, and while any stay, words and the takes.
  assert.deepEqual(p.guestWebLeft(HALL), { up: 1, upWords: '1 web page a guest showed is still up', takeDown: [{ to: BEN, seq: ben.seq }] });
  const ana = p.take(HALL, ANA, content, { name: 'Gil', guest: true });
  assert.deepEqual(p.guestWebLeft(HALL), { up: 2, upWords: '2 web pages guests showed are still up', takeDown: [{ to: BEN, seq: ben.seq }, { to: ANA, seq: ana.seq }] });
  assert.deepEqual([p.guestWebLeft('HALLC3'), p.guestWebLeft('__proto__')], [{ up: 0 }, { up: 0 }]);
});
