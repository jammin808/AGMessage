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
const {
  Pages, cleanPage, askedOf, canShow, describePage, sourceOk, webUrl, personKey, layerOf, layersOf, reportsOf, inViewOf, KINDS, LAYERS, SHOW_LAYER, INFO_LAYER, ARRIVALS, EARLIER_TOLD,
  IMAGE_EXT, STAGE_TYPES, TRANSFER_ONLY, REPORTS, ANSWERS, AGAIN_MS, VIEWS, MARKS, BOUNDS, WEB_MAX, STAGE_FULL,
  fileOf,
} = require('../lib/pages');
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
/** A web take as the store keeps it: its host and its address sealed (lib/secretbox.js's shape). */
const WEB_KEPT = { kind: 'web', host: 'vote.example.com', urlSealed: 'enc1:c2VhbGVk' };
const KINDS_WORDS = { error: 'Choose what to show: back to chat, Stagewatch, the clock, holding, blank, a web page, a document or a picture.' };
const dirs = [];
const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-pages-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
test('the stage\'s file types: every upload type is one the stage can show, every transfer type is transfer-only, and none is both', () => {
  // A type added to the uploads is a stage type, checked at upload and parsed on the Board's pages, unless it is listed
  // as a transfer only (lib/guard.js TRANSFER_TYPES, owner answer 18): then it is never opened, so a type added for
  // transfer is never parsed on the Board's devices unasked.
  assert.deepEqual([...STAGE_TYPES].sort(), Object.keys(guard.UPLOAD_TYPES).sort(), 'the stage types are the upload types');
  assert.deepEqual([...TRANSFER_ONLY].sort(), Object.keys(guard.TRANSFER_TYPES).sort(), 'the transfer-only types are the transfer types');
  assert.deepEqual([...TRANSFER_ONLY].sort(), ['m4a', 'mov', 'mp3', 'mp4', 'odp', 'ods', 'odt', 'wav', 'zip']);
  assert.ok(Object.keys(guard.UPLOAD_TYPES).every((ext) => !Object.hasOwn(guard.TRANSFER_TYPES, ext)), 'no key in both tables');
  assert.ok(STAGE_TYPES.every((ext) => !TRANSFER_ONLY.includes(ext)), 'no type is both');
  // sourceOk refuses a transfer-only file: a transfer type by its extension, and a protected Office file by its upload's or
  // its message's word.
  const refused = { error: 'That file is for download only: AGMessage does not open it.' };
  assert.deepEqual(sourceOk('/uploads/1700000000000-abcdefghijkl-pack.zip', { main: 'HALL01' }), refused);
  assert.deepEqual(sourceOk('/uploads/1700000000000-abcdefghijkl-agenda.docx', { main: 'HALL01', uid: 'u1', fresh: () => ({ room: 'HALL01', uid: 'u1', name: 'Agenda.docx', transferOnly: true }) }), refused);
  assert.deepEqual(sourceOk('/uploads/1700000000000-abcdefghijkl-agenda.docx', { main: 'HALL01', holders: () => [{ key: 'HALL01', at: 1, name: 'Agenda.docx', transferOnly: true }] }), refused);
  assert.deepEqual(sourceOk('/uploads/1700000000000-abcdefghijkl-agenda.docx', { main: 'HALL01', holders: () => [{ key: 'HALL01', at: 1, name: 'Agenda.docx' }] }), { name: 'Agenda.docx', room: '', roomName: '' }, 'the same type as a zip is a stage type');
  assert.ok(IMAGE_EXT.every((ext) => STAGE_TYPES.includes(ext)), 'a holding slide\'s picture is a stage type');
  assert.ok(Object.isFrozen(STAGE_TYPES) && Object.isFrozen(TRANSFER_ONLY));
});

/** A store in a folder of its own, held (so it writes) unless asked not to be. */
function store({ held = true, file = path.join(folder(), 'pages.json') } = {}) {
  const p = new Pages(file);
  if (held) p.hold();
  p.file = file;
  return p;
}
const onDisk = (p) => (p.flush(), JSON.parse(fs.readFileSync(p.file, 'utf8')));

test('cleanPage: an unknown kind, or none, is refused with the kinds in words, never defaulted', () => {
  // `brand` went (the owner's answer 31: one Holding page with the logo); the quote is a later unit's.
  for (const kind of ['brand', 'snippet', 'iframe', 'message', 'black', 'CLOCK', 'WEB', 'DOC', 'region', '', ' clock']) assert.deepEqual(cleanPage({ kind }), KINDS_WORDS, kind);
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
  // The information handed back alone (Take down) is a hand-back of its own; any other layer is refused, never widened
  // to both.
  assert.deepEqual(cleanPage({ kind: 'chat', layer: 'info', seq: 3 }), { kind: 'chat', layer: 'info' });
  for (const layer of ['show', null, 5, '', 'INFO', ['info']]) assert.deepEqual(cleanPage({ kind: 'chat', layer }), KINDS_WORDS, JSON.stringify(layer));
  assert.deepEqual(cleanPage({ kind: 'clock', layer: 'info' }), { kind: 'clock' }, 'a layer is chat\'s word alone: on another kind it is a key not known');
  assert.deepEqual(KINDS, ['chat', 'stage', 'clock', 'holding', 'blank', 'web', 'doc', 'image']);
  // Two layers: the show (the operator's) and the information drawn over it; a hand-back's are its own.
  assert.deepEqual(LAYERS, ['show', 'info']);
  assert.ok(Object.isFrozen(KINDS) && Object.isFrozen(LAYERS));
  assert.deepEqual(KINDS.map((k) => [k, layerOf(k)]), [['chat', ''], ['stage', 'show'], ['clock', 'show'], ['holding', 'show'], ['blank', 'show'], ['web', 'info'], ['doc', 'info'], ['image', 'info']]);
  assert.deepEqual([layersOf({ kind: 'chat' }), layersOf({ kind: 'chat', layer: 'info' }), layersOf({ kind: 'clock' }), layersOf({ kind: 'web' }), layersOf({ kind: 'brand' })], [['show', 'info'], ['info'], ['show'], ['info'], []]);
  assert.deepEqual([SHOW_LAYER, INFO_LAYER, ARRIVALS], [['stage', 'clock', 'holding', 'blank'], ['web', 'doc', 'image', 'snippet'], ['over', 'side']]);
  assert.equal(layerOf('brand'), '');
  // What a pusher asked for, read before anything else of it.
  assert.deepEqual([askedOf({ kind: 'web', url: 5 }), askedOf({ kind: 'chat' }), askedOf({ kind: 'chat', layer: 'info' }), askedOf({ kind: 'chat', layer: 'show' }), askedOf({ kind: 'brand' }), askedOf('chat')],
    [{ kind: 'web', layer: '' }, { kind: 'chat', layer: '' }, { kind: 'chat', layer: 'info' }, null, null, null]);
});

test('cleanPage: Stagewatch only where the hall has one linked', () => {
  const none = { error: 'This hall has no Stagewatch linked — link one in Set up.' };
  assert.deepEqual(cleanPage({ kind: 'stage' }, { stagewatch: true }), { kind: 'stage' });
  for (const facts of [undefined, {}, { stagewatch: false }, { stagewatch: 'yes' }, { stagewatch: 1 }, null]) assert.deepEqual(cleanPage({ kind: 'stage' }, facts), none, JSON.stringify(facts));
});

test('cleanPage: the holding rules: no picture, or a picture of ours from a place the stage may show it from (sourceOk)', () => {
  const asked = [];
  const source = (url) => { asked.push(url); return url === PIC ? { name: 'stage.png', room: '' } : { error: 'That file belongs to another room — send it from there.' }; };
  assert.deepEqual(cleanPage({ kind: 'holding' }, {}), { kind: 'holding' }, 'no picture needs no facts');
  assert.deepEqual(cleanPage({ kind: 'holding', image: PIC }, { source }), { kind: 'holding', image: PIC });
  assert.deepEqual(asked, [PIC], 'the file is asked of the server\'s facts by its address');
  // Not a picture of ours: a type a screen does not show, or an address that is not an upload.
  const notOurs = { error: 'A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage.' };
  const anywhere = () => ({ name: 'p', room: '' });
  for (const image of ['/uploads/1730000000000-abcdefghijkl-deck.pdf', '/uploads/1730000000000-abcdefghijkl-notes.txt', 'https://example.com/a.png', '/uploads/../1730000000000-abcdefghijkl-a.png', '/uploads/a.png', '']) {
    assert.deepEqual(cleanPage({ kind: 'holding', image }, { source: anywhere }), notOurs, JSON.stringify(image));
  }
  // A picture that is not a string is a field of the wrong type: the whole take refused with the kinds in words.
  for (const image of [null, 5, true, { toString: () => PIC }, [PIC]]) assert.deepEqual(cleanPage({ kind: 'holding', image }, { source: anywhere }), KINDS_WORDS, JSON.stringify(image));
  for (const ext of IMAGE_EXT) assert.deepEqual(cleanPage({ kind: 'holding', image: '/uploads/1730000000000-abcdefghijkl-p.' + ext }, { source: anywhere }).image, '/uploads/1730000000000-abcdefghijkl-p.' + ext);
  // The rule is a screen's (lib/displays.js), upload type by upload type: what a screen holds as its holding picture, a
  // person's page does, and nothing else.
  for (const ext of Object.keys(guard.UPLOAD_TYPES)) {
    const image = '/uploads/1730000000000-abcdefghijkl-p.' + ext;
    assert.equal('error' in cleanPage({ kind: 'holding', image }, { source: anywhere }), 'error' in cleanContent({ kind: 'holding', image }), ext);
  }
  // From a place sourceOk refuses, in its words; and facts that cannot say so refuse it in the words of a file held nowhere.
  const other = '/uploads/1730000000000-zyxwvutsrqpo-other.jpg';
  assert.deepEqual(cleanPage({ kind: 'holding', image: other }, { source }), { error: 'That file belongs to another room — send it from there.' });
  const unread = { error: 'That file is in no room of this hall you can read — share it there first.' };
  for (const facts of [undefined, {}, { source: true }, { source: () => 'yes' }, { source: () => null }, { readable: () => true }]) assert.deepEqual(cleanPage({ kind: 'holding', image: PIC }, facts), unread, JSON.stringify(facts));
  // The picture types are the uploads' image types.
  for (const ext of IMAGE_EXT) assert.match(guard.UPLOAD_TYPES[ext].mime, /^image\//, ext);
});

test('describePage: the words for each kind; KINDS and the words are one set', () => {
  const words = KINDS.map((kind) => describePage({ kind }, { hallHolding: '/uploads/x.png' }));
  assert.deepEqual(words, ['back to chat', 'Stagewatch', 'the clock', 'a holding slide', 'blank', 'a web page', 'a document', 'a picture']);
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
  assert.deepEqual(KINDS.map(inViewOf), ['shown', 'shown', 'shown', 'shown', 'shown', 'opened', 'shown', 'shown']);
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
  assert.deepEqual(BOUNDS, { views: 5000, personTakes: 200, answers: 500, earlier: 20, stageFiles: 200, withdrawn: 200 });
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
  assert.deepEqual(p.forgetHall(HALL), [], 'it held no stage file');
  assert.equal(p.forgetHall(HALL), null, 'once');
  assert.equal(p.forgetHall('__proto__'), null);
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
        // Beside the operator's, a take put there (`aside`, arriving in the side bar) is kept; one that did not arrive there,
        // whose mark is not true, a show kind there, or one put beside found over the show, is dropped.
        board: { show: take(6), info: take(5), beside: { ...take(5, WEB_KEPT), arrive: 'side', aside: true } },
        people: {
          [ANA]: { show: take(4) }, [BEN]: { show: take(7) }, [CY]: { show: take(3, { kind: 'brand' }) }, 'u:umissing01': { show: { seq: 2, content: { kind: 'clock' }, at: 5 } },
          'u:uaside0001': { beside: { ...take(1, WEB_KEPT), aside: true } }, 'u:uaside0002': { info: { ...take(1, WEB_KEPT), arrive: 'side', aside: true }, beside: take(1) },
          'u:uaside0003': { beside: { ...take(1, WEB_KEPT), arrive: 'side', aside: 'yes' } },
          'u:uholding01': { show: take(2, { kind: 'holding', image: '/uploads/../x.png' }) }, 'u:uholding02': { show: take(1, { kind: 'holding', image: PIC, drop: 1 }) },
          nokey: { show: take(1) }, 'u:unoshow001': { info: take(1) }, 'u:uattext001': { show: { ...take(1), at: 'now' } },
        },
        answers: { [ANA]: { show: { seq: 4, state: 'dismissed', at: 9 } }, [BEN]: { show: { seq: 6, state: 'shown', at: 9 } }, [CY]: { show: { seq: 9, state: 'dismissed', at: 9 } }, 'u:uans00001': 'dismissed' },
        // Earlier holds information taken off a page, with whom it was for: a show take, a target that is none, a number
        // past the hall's or an arrival that is none are dropped.
        earlier: [
          { ...take(2, WEB_KEPT), to: 'board' }, { ...take(3, WEB_KEPT), to: ANA, arrive: 'side' }, { ...take(4), to: 'board' }, { ...take(5, WEB_KEPT), to: 'everyone' },
          { ...take(9, WEB_KEPT), to: 'board' }, { ...take(5, WEB_KEPT), to: BEN, arrive: 'under' }, { ...take(1, WEB_KEPT) },
        ],
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
  assert.deepEqual(p.halls.HALLD4, { seq: 2, board: {}, people: {}, answers: {}, earlier: [] }, 'a hall\'s parts that do not read are empty, its counter kept');
  const h = p.halls[HALL];
  assert.deepEqual(h.board, { show: take(6), beside: { ...take(5, WEB_KEPT), arrive: 'side', aside: true } }, 'a take in a layer its content does not change (a clock over the show) is dropped');
  assert.deepEqual(h.earlier, [{ ...take(2, WEB_KEPT), to: 'board' }, { ...take(3, WEB_KEPT), to: ANA, arrive: 'side' }]);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, views: { 'u:uguest00001': { view: 'simple', at: 2 } }, halls: { [HALL]: { seq: 1, board: { show: { seq: 1, content: { kind: 'clock' }, by: { name: 'Ada' }, at: 1 } }, people: {}, answers: {}, earlier: [] } } });
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
function sealing({ file = path.join(folder(), 'pages.json'), wait } = {}) {
  const p = new Pages(file, { seal: secretbox.seal, open: secretbox.open, ...(wait ? { wait } : {}) });
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
  assert.deepEqual(again.current(HALL, '', { board: true, layer: 'info' }).take, t, 'a web page is information over the show');
  assert.equal(again.current(HALL, '', { board: true }).take, null, 'and never the show');
  const elsewhere = new Pages(p.file);
  assert.deepEqual(elsewhere.told(elsewhere.current(HALL, '', { board: true, layer: 'info' }).take.content), { kind: 'web', url: '', host: 'vote.example.com' });
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
  fs.writeFileSync(file, JSON.stringify({ v: 1, halls: { [HALL]: { seq: 5, board: { info: take(5, t.content) }, people: {
    [ANA]: { info: take(1, { kind: 'web', url: VOTE, host: 'vote.example.com' }) }, [BEN]: { info: take(2, { kind: 'web', host: 'Vote.Example.com', urlSealed: t.content.urlSealed }) },
    [CY]: { info: take(3, { kind: 'web', host: 'vote.example.com', urlSealed: VOTE }) }, 'u:uok0000001': { info: take(4, { ...t.content, extra: VOTE }) },
    'u:ushow00001': { show: take(4, t.content) },
  }, answers: {} } } }));
  const read = new Pages(file, { seal: secretbox.seal, open: secretbox.open });
  assert.deepEqual(read.halls[HALL].board, { info: take(5, t.content) });
  assert.deepEqual(read.halls[HALL].people, { 'u:uok0000001': { info: take(4, t.content) } }, 'the keys it does not know left behind, and a web page in the show layer dropped');
});

test('a web page reports opened, never shown: in view it opened (◇, never ✓), and Show it again says opened', () => {
  const p = sealing();
  const content = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const t = p.take(HALL, ANA, content, { name: 'Tom' }, { at: 100 });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'shown', at: 101 }), { ok: false, error: 'A page shown a web page on vote.example.com reports one of: opened, hidden, failed, dismissed, minimised.' });
  const page = { sid: 's1', key: ANA, board: false, name: 'Ana' };
  const INFO = { layer: 'info' };
  assert.deepEqual(p.status(HALL, ANA, [page], { name: 'Ana', ...INFO }).mark, MARKS.waiting, 'sending until the page says');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'opened', at: 102 }), { ok: true, answer: null });
  const st = p.status(HALL, ANA, [page], { name: 'Ana', ...INFO });
  assert.deepEqual([st.mark, st.words, st.showing, st.kind, st.on], [MARKS.unseen, 'Opened · AGMessage can\'t see inside web pages', 'a web page on vote.example.com', 'web', 1]);
  assert.ok(!JSON.stringify(st).includes('poll/7'), 'the status names the host alone');
  // Not loaded in time: △ with its words. Back to chat, then Show it again within 10 s: said opened, with `again`.
  assert.ok(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'failed', words: 'the page did not load', at: 103 }).ok);
  assert.deepEqual([p.status(HALL, ANA, [page], INFO).mark, p.status(HALL, ANA, [page], INFO).words], [MARKS.couldNot, 'Couldn\'t show it: the page did not load']);
  assert.equal(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'dismissed', at: 104 }).answer.state, 'dismissed');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'shown', again: true, at: 105 }).ok, false, 'shown is no web page\'s word, even to show it again');
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, seq: t.seq, state: 'opened', again: true, at: 106 }), { ok: true, answer: null });
  assert.equal(p.status(HALL, ANA, [page], INFO).mark, MARKS.unseen);
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
  // Put away by its person (Back to chat): no longer up for them. A show take after it leaves it up, over the show; the
  // information taken down (or another's over it) and the guest's is no longer shown.
  assert.ok(p.report(HALL, 's1', { key: CY, seq: cy.seq, state: 'dismissed' }).ok);
  p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' });
  assert.deepEqual(p.guestWeb(HALL), [{ to: 'board', seq: board.seq }, { to: BEN, seq: ben.seq }]);
  p.take(HALL, 'board', { kind: 'chat', layer: 'info' }, { name: 'Tom', op: true });
  assert.deepEqual(p.guestWeb(HALL), [{ to: BEN, seq: ben.seq }]);
  assert.deepEqual(p.guestWeb('__proto__'), []);
  // As the admin is told them once guests may no longer show web pages: a count, and while any stay, words and the takes.
  assert.deepEqual(p.guestWebLeft(HALL), { up: 1, upWords: '1 web page a guest showed is still up', takeDown: [{ to: BEN, seq: ben.seq }] });
  const ana = p.take(HALL, ANA, content, { name: 'Gil', guest: true });
  assert.deepEqual(p.guestWebLeft(HALL), { up: 2, upWords: '2 web pages guests showed are still up', takeDown: [{ to: BEN, seq: ben.seq }, { to: ANA, seq: ana.seq }] });
  assert.deepEqual([p.guestWebLeft('HALLC3'), p.guestWebLeft('__proto__')], [{ up: 0 }, { up: 0 }]);
});

// ---------------------------------------------------------------- the two layers, and who may show what (plan 4-§5.9)
test('two layers: information over the show, never replacing it; a hand-back of the information alone leaves the show; a hand-back of both clears both; answers per layer', () => {
  const p = sealing();
  const web = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const clock = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' });
  const info = p.take(HALL, 'board', web, { name: 'Sue' }, { onStage: [ANA] });
  // A Board page is shown both: the clock in the show, the web page over it.
  assert.deepEqual([p.current(HALL, ANA, { board: true }).take.seq, p.current(HALL, ANA, { board: true, layer: 'info' }).take.seq], [clock.seq, info.seq]);
  // Each layer's take is reported on by its number: the clock drawn under the web page says so, and the console reads it.
  const page = { sid: 's1', key: ANA, board: true, name: 'Ana' };
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: clock.seq, state: 'hidden', words: 'under a web page', at: 10 }), { ok: true, answer: null });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: info.seq, state: 'opened', at: 11 }), { ok: true, answer: null });
  const show = p.status(HALL, 'board', [page]);
  const over = p.status(HALL, 'board', [page], { layer: 'info' });
  assert.deepEqual([show.mark, show.words, show.on], [MARKS.partly, 'Under a web page', 0], 'drawn underneath: never shown');
  assert.deepEqual([over.mark, over.showing, over.arrive, over.op], [MARKS.unseen, 'a web page on vote.example.com', 'over', false]);
  // Back to chat on the information is an answer in its layer: the show take's stands.
  assert.equal(p.report(HALL, 's1', { key: ANA, board: true, seq: info.seq, state: 'dismissed', at: 12 }).answer.state, 'dismissed');
  assert.deepEqual([p.current(HALL, ANA, { board: true }).answer, p.current(HALL, ANA, { board: true, layer: 'info' }).answer.state], [null, 'dismissed']);
  // A show take leaves the information as it is; the information taken down (a hand-back of the information alone) leaves
  // the show as it is.
  const blank = p.take(HALL, 'board', { kind: 'blank' }, { name: 'Tom' }, { onStage: [ANA] });
  assert.equal(p.current(HALL, ANA, { board: true, layer: 'info' }).take.seq, info.seq);
  const down = p.take(HALL, 'board', cleanPage({ kind: 'chat', layer: 'info' }), { name: 'Tom', op: true }, { onStage: [ANA] });
  assert.deepEqual([p.current(HALL, ANA, { board: true }).take.seq, p.current(HALL, ANA, { board: true, layer: 'info' }).take.content], [blank.seq, { kind: 'chat', layer: 'info' }]);
  assert.equal(describePage(down.content), 'the information taken down');
  const none = p.status(HALL, 'board', [page], { layer: 'info' });
  assert.deepEqual([none.mark, none.words, none.kind, none.showing], [MARKS.off, 'Nothing over the show', 'chat', 'the information taken down'], 'nothing over the show waits for no report');
  // A report on the information's hand-back is no report: it draws nothing.
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: down.seq, state: 'shown', at: 13 }), { ok: false, error: 'That is not what this page is shown now.' });
  // A hand-back of both clears both, with one number.
  p.take(HALL, 'board', web, { name: 'Tom', op: true });
  const both = p.take(HALL, 'board', cleanPage({ kind: 'chat' }), { name: 'Tom', op: true }, { onStage: [ANA] });
  assert.deepEqual([p.current(HALL, ANA, { board: true }).take.seq, p.current(HALL, ANA, { board: true, layer: 'info' }).take.seq], [both.seq, both.seq]);
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: both.seq, state: 'shown', at: 14 }).ok, 'reported on as the show\'s hand-back');
});

test('supersede per layer: a Board take puts away the older takes and answers of those On stage in its layer alone; a Board web page leaves a person\'s clock', () => {
  const p = sealing();
  const web = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const clock = p.take(HALL, ANA, { kind: 'clock' }, { name: 'Tom' });
  const theirs = p.take(HALL, ANA, web, { name: 'Tom' });
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: clock.seq, state: 'minimised' }).ok);
  const board = p.take(HALL, 'board', cleanPage({ kind: 'web', url: 'https://news.example.org/' }, { web: true }), { name: 'Sue' }, { onStage: [ANA, BEN] });
  // Ana's own clock and its answer stay (the show layer); her own web page goes, superseded, into Earlier for her.
  assert.deepEqual(p.current(HALL, ANA, { board: true }), { take: clock, answer: { seq: clock.seq, state: 'minimised', at: p.halls[HALL].answers[ANA].show.at } });
  assert.equal(p.current(HALL, ANA, { board: true, layer: 'info' }).take.seq, board.seq);
  assert.deepEqual(p.halls[HALL].people[ANA], { show: clock });
  assert.deepEqual(p.earlierOf(HALL, ANA).map((e) => e.seq), [theirs.seq]);
  // A newer Board take in the information replaces the Board's, which joins Earlier for the Board.
  const next = p.take(HALL, 'board', web, { name: 'Sue' }, { onStage: [ANA] });
  assert.deepEqual(p.earlierOf(HALL, ANA, { board: true }).map((e) => e.seq), [board.seq, theirs.seq], 'the newest first, the Board\'s and her own');
  assert.deepEqual(p.earlierOf(HALL, BEN).map((e) => e.seq), [], 'a person not On stage is told none of the Board\'s');
  assert.deepEqual(p.earlierOf(HALL, BEN, { board: true }).map((e) => e.seq), [board.seq]);
  assert.equal(p.current(HALL, ANA, { board: true, layer: 'info' }).take.seq, next.seq);
  // An Earlier entry is told as its pages were told it: its address opened, its pusher by name alone.
  const told = p.earlierOf(HALL, BEN, { board: true })[0];
  assert.deepEqual([told.content, told.by, Object.keys(told)], [{ kind: 'web', url: 'https://news.example.org/', host: 'news.example.org' }, { name: 'Sue' }, ['seq', 'content', 'by', 'at']]);
});

test('Earlier: information superseded, handed back or put away joins it once, at most 20 a hall, a page told its newest 10; a show take never', () => {
  const p = sealing();
  const web = (n) => cleanPage({ kind: 'web', url: 'https://example.com/' + n }, { web: true });
  const first = p.take(HALL, 'board', web(0), { name: 'Tom' });
  p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' });
  p.take(HALL, 'board', { kind: 'blank' }, { name: 'Tom' });
  assert.deepEqual(p.earlierOf(HALL, ANA, { board: true }), [], 'a show take superseded joins nothing');
  // Put away with Back to chat by one Board member: it joins Earlier for the Board, once, however many put it away.
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: first.seq, state: 'dismissed', at: 1 }).ok);
  assert.ok(p.report(HALL, 's2', { key: BEN, board: true, seq: first.seq, state: 'dismissed', at: 2 }).ok);
  assert.deepEqual(p.halls[HALL].earlier.map((e) => [e.seq, e.to]), [[first.seq, 'board']]);
  // Handed back: it is there once still; then 24 more, 20 kept, the oldest gone.
  p.take(HALL, 'board', cleanPage({ kind: 'chat', layer: 'info' }), { name: 'Tom', op: true });
  assert.equal(p.halls[HALL].earlier.length, 1);
  for (let i = 1; i <= 24; i++) p.take(HALL, 'board', web(i), { name: 'Tom' });
  assert.equal(p.halls[HALL].earlier.length, BOUNDS.earlier);
  assert.ok(!p.halls[HALL].earlier.some((e) => e.seq === first.seq), 'the oldest went first');
  const told = p.earlierOf(HALL, ANA, { board: true });
  assert.equal(told.length, EARLIER_TOLD);
  assert.ok(told.every((e, i) => i === 0 || e.seq < told[i - 1].seq), 'the newest first');
  // Kept across a restart, as read back.
  p.flush();
  assert.deepEqual(new Pages(p.file, { seal: secretbox.seal, open: secretbox.open }).earlierOf(HALL, ANA, { board: true }), told);
});

test('arrivals: information in the side bar is said so; over the operator\'s it is kept beside it, superseding nothing, reported on as any take; the newest information, a hand-back of both, or a Take down that names it puts it away; a show take never arrives there', () => {
  const p = sealing();
  const web = cleanPage({ kind: 'web', url: VOTE }, { web: true });
  const news = cleanPage({ kind: 'web', url: 'https://news.example.org/' }, { web: true });
  const side = p.take(HALL, 'board', web, { name: 'Sue' }, { arrive: 'side' });
  assert.equal(side.arrive, 'side');
  const page = { sid: 's1', key: ANA, board: true, name: 'Ana' };
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: side.seq, state: 'opened', words: 'in the side bar' }).ok);
  assert.deepEqual(p.status(HALL, 'board', [page], { layer: 'info' }).arrive, 'side');
  // Nothing is beside it: a side arrival with no operator's information up is the layer's own take.
  assert.deepEqual([p.current(HALL, ANA, { board: true, layer: 'beside' }).take, p.status(HALL, 'board', [page], { layer: 'beside' }).seq], [null, 0]);
  // A show take asked to arrive there is kept as arriving over: the show is always drawn over the chat.
  assert.equal(p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' }, { arrive: 'side' }).arrive, undefined);
  assert.equal(p.take(HALL, 'board', { kind: 'clock' }, { name: 'Tom' }, { arrive: 'under' }), null, 'an arrival that is none: nothing numbered');
  // The operator's information, then a researcher's side push over it (aside): kept beside it, the operator's still over
  // the show, the first side take put away into Earlier, the one beside it not (it is up).
  const op = p.take(HALL, 'board', web, { name: 'Tom', op: true }, { onStage: [ANA] });
  const aside = p.take(HALL, 'board', news, { name: 'Sue' }, { arrive: 'side', aside: true, onStage: [ANA] });
  assert.deepEqual([aside.arrive, aside.aside], ['side', true]);
  const over = () => p.current(HALL, ANA, { board: true, layer: 'info' }).take;
  const beside = () => p.current(HALL, ANA, { board: true, layer: 'beside' }).take;
  assert.deepEqual([over().seq, over().by.op, beside().seq], [op.seq, true, aside.seq]);
  assert.deepEqual(p.earlierOf(HALL, ANA, { board: true }).map((e) => e.seq), [side.seq]);
  // Reported on as any take: sending until the page says, then where it is; the operator's over it reported apart.
  const said = (o) => [o.seq, o.mark, o.words, o.arrive, o.op];
  assert.deepEqual(said(p.status(HALL, 'board', [page], { layer: 'beside' })), [aside.seq, MARKS.waiting, 'Sending', 'side', false]);
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: aside.seq, state: 'opened', words: 'in the side bar' }), { ok: true, answer: null });
  assert.deepEqual(said(p.status(HALL, 'board', [page], { layer: 'beside' })), [aside.seq, MARKS.unseen, 'Opened · AGMessage can\'t see inside web pages', 'side', false]);
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: op.seq, state: 'opened' }).ok, 'and the operator\'s, over the show');
  // Kept across a restart, in its place.
  p.flush();
  const again = new Pages(p.file, { seal: secretbox.seal, open: secretbox.open });
  assert.deepEqual([again.current(HALL, ANA, { board: true, layer: 'beside' }).take.seq, again.current(HALL, ANA, { board: true, layer: 'info' }).take.seq], [aside.seq, op.seq]);
  // The operator's Take down of its own (naming the take over the show) leaves what is beside it.
  const opDown = p.take(HALL, 'board', { kind: 'chat', layer: 'info' }, { name: 'Tom', op: true }, { onStage: [ANA], slot: 'info' });
  assert.deepEqual([over().seq, over().content, beside().seq], [opDown.seq, { kind: 'chat', layer: 'info' }, aside.seq]);
  // The researcher's Take down naming it hands back that alone, into Earlier.
  const down = p.take(HALL, 'board', { kind: 'chat', layer: 'info' }, { name: 'Sue' }, { onStage: [ANA], slot: 'beside' });
  assert.deepEqual([beside(), over().seq, p.earlierOf(HALL, ANA, { board: true })[0].seq], [null, opDown.seq, aside.seq]);
  assert.equal(p.status(HALL, 'board', [page], { layer: 'beside' }).words, 'Nothing in their side bar');
  assert.ok(down.seq > opDown.seq);
  // The newest information over the show puts away what is beside it: nothing older beside it shows again, a person's
  // own included.
  const aside2 = p.take(HALL, ANA, news, { name: 'Sue' }, { arrive: 'side', aside: true });
  assert.equal(beside().seq, aside2.seq, 'beside it on Ana\'s pages alone');
  const newer = p.take(HALL, 'board', web, { name: 'Ben' }, { onStage: [] });
  assert.deepEqual([beside(), over().seq], [null, newer.seq], 'Ana was not seated now: her own beside it is older than the Board\'s newest');
  // A hand-back of both clears it too.
  const aside3 = p.take(HALL, 'board', news, { name: 'Sue' }, { arrive: 'side', aside: true, onStage: [ANA] });
  assert.equal(beside().seq, aside3.seq);
  p.take(HALL, 'board', { kind: 'chat' }, { name: 'Tom' }, { onStage: [ANA] });
  assert.equal(beside(), null);
  // Held under blank and drawn under another take are said with words: never on screen, and not out of view.
  const op2 = p.take(HALL, 'board', web, { name: 'Tom', op: true });
  const blank = p.take(HALL, 'board', { kind: 'blank' }, { name: 'Tom' });
  assert.deepEqual(p.report(HALL, 's1', { key: ANA, board: true, seq: op2.seq, state: 'hidden', words: 'held under blank', at: 20 }), { ok: true, answer: null }, 'no time out of view: the page is in view');
  assert.ok(p.report(HALL, 's1', { key: ANA, board: true, seq: blank.seq, state: 'shown', at: 21 }).ok);
  const held = p.status(HALL, 'board', [page], { layer: 'info' });
  assert.deepEqual([held.mark, held.words], [MARKS.partly, 'Held under blank']);
  const mixed = Pages.status({ seq: 4, content: { kind: 'clock' }, by: { name: 'Tom' } }, [{ state: 'shown', name: 'A' }, { state: 'hidden', words: '', name: 'B' }, { state: 'hidden', words: 'under a web page', name: 'C' }], { board: true });
  assert.equal(mixed.words, '1 of 3 showing · 1 asleep or in another app · 1 under a web page');
});

test('canShow: who may show what on the Board\'s pages, each row of the table and each refusal in its words', () => {
  const OPERATOR = 'The operator is showing a web page — ask them, or send it to their side bar.';
  const NO_SHOW = 'Showing files, pages and quotes on the stage needs its own right — ask an admin.';
  const NO_WEB = 'Web pages on the stage need their own right — ask an admin.';
  const GUESTS_OFF = 'Web pages from backstage guests are off in this hall — ask the admin.';
  const OPEN_HALL = 'In an open hall, showing the Board needs an invite link or an account — ask the admin.';
  const TEAM = 'Showing the Board is for the backstage team.';
  const NO_RIGHT = 'Your account may not change what people\'s pages show in this hall.';
  const KINDS_ASKED = ['doc', 'image', 'snippet', 'web', { kind: 'chat', layer: 'info' }];
  const SHOW = ['stage', 'clock', 'holding', 'blank', 'chat'];
  // A researcher's own information up (pushed by canShow), which its Take down names.
  const staff = { canPush: false, account: true, show: true, web: NO_WEB, seat: 'research', inHall: true, post: true, files: true, listed: true, notPush: NO_RIGHT, current: { seq: 3, op: false, kind: 'snippet', name: 'Sue' }, ifSeq: 3 };
  const verdicts = (f, to = 'board', arrive) => KINDS_ASKED.map((k) => canShow(f, k, to, arrive));
  // The admin, and Tech, Senior, Manager by their presets: every kind, any target, either layer and arrival.
  for (const f of [{ canPush: true, admin: true, account: false, web: true }, { canPush: true, account: true, show: true, web: true }]) {
    assert.deepEqual(verdicts(f, { onStage: false }, 'side'), [true, true, true, true, true]);
    for (const k of SHOW) assert.equal(canShow(f, k, 'board'), true);
  }
  // A Tech with stage.show revoked: the show layer only, its web page by its own right.
  const tech = { canPush: true, account: true, show: false, web: true };
  assert.deepEqual(verdicts(tech), [NO_SHOW, NO_SHOW, NO_SHOW, true, NO_SHOW]);
  for (const k of SHOW) assert.equal(canShow(tech, k, 'board'), true);
  assert.deepEqual(verdicts({ ...tech, web: NO_WEB })[3], NO_WEB);
  // A locked hall's backstage guest (canPush): every kind; a web page only while the admin's switch is on.
  const guest = { canPush: true, account: false, web: GUESTS_OFF };
  assert.deepEqual(verdicts(guest), [true, true, true, GUESTS_OFF, true]);
  assert.equal(canShow({ ...guest, web: true }, 'web', 'board'), true);
  // An open hall's backstage guest: nothing, every kind, in the words of who it is.
  const open = { canPush: false, account: false, seat: 'research', inHall: true, post: true, notPush: OPEN_HALL };
  for (const k of [...KINDS_ASKED, ...SHOW]) assert.equal(canShow(open, k, 'board'), OPEN_HALL, JSON.stringify(k));
  // A Staff account backstage: documents, pictures and quotes to the Board or a person On stage, over or in the side bar;
  // never a web page without its right, never the show, never a hand-back of both.
  assert.deepEqual(verdicts(staff), [true, true, true, NO_WEB, true]);
  assert.deepEqual(verdicts(staff, { onStage: true }, 'side'), [true, true, true, NO_WEB, true]);
  for (const k of SHOW) assert.equal(canShow(staff, k, 'board'), NO_RIGHT, k);
  assert.equal(canShow({ ...staff, web: true }, 'web', 'board'), true, 'with stage.web granted');
  // Its own files right revoked: quotes only. Its stage.show revoked and no stage.web: nothing.
  assert.deepEqual(verdicts({ ...staff, files: false }), ['Your account may not share files here, so it shows quotes only.', 'Your account may not share files here, so it shows quotes only.', true, NO_WEB, true]);
  assert.deepEqual(verdicts({ ...staff, show: false }), [NO_SHOW, NO_SHOW, NO_SHOW, NO_WEB, NO_SHOW]);
  // A take-down only of a kind it could have put up itself: a web page by its web right, a quote by stage.show.
  const TAKE_DOWN = { kind: 'chat', layer: 'info' };
  const webUp = { ...staff, current: { seq: 3, op: false, kind: 'web', name: 'Sue' } };
  assert.equal(canShow({ ...webUp, show: false, web: true }, TAKE_DOWN, 'board', 'over'), true, 'its web pages taken down by its web right');
  assert.equal(canShow({ ...staff, show: false, web: true }, TAKE_DOWN, 'board', 'over'), NO_SHOW, 'a quote, never by the web right alone');
  assert.equal(canShow(webUp, TAKE_DOWN, 'board'), NO_WEB, 'a web page, never by stage.show alone');
  assert.equal(canShow(staff, TAKE_DOWN, 'board'), true, 'a quote by stage.show');
  // An observer seat (a Viewer granted the rights, Staff with hall.post revoked), On stage, a side room's Member guest.
  assert.deepEqual(verdicts({ ...staff, seat: 'observer', post: false, web: true }), [TEAM, TEAM, TEAM, TEAM, TEAM]);
  assert.deepEqual(verdicts({ ...staff, seat: 'board', notPush: 'Do that from a backstage page.' }), Array(5).fill('Do that from a backstage page.'));
  assert.deepEqual(verdicts({ canPush: false, account: false, seat: 'research', notPush: TEAM }), Array(5).fill(TEAM));
  // Only the people on stage: a person who is not is no one canShow reaches.
  assert.deepEqual(verdicts(staff, { onStage: false }), Array(5).fill('Only the people on stage can be shown this.'));
  // From a side room off the Main room's list: nothing, a take-down included.
  assert.deepEqual(verdicts({ ...staff, listed: false, ifSeq: 4, current: { seq: 4, op: false, kind: 'web', name: 'Ben' } }), [...Array(3).fill('This room may not send to the Main room\'s Board — ask an admin.'), NO_WEB, 'This room may not send to the Main room\'s Board — ask an admin.']);
  // Over the operator's information: refused over, taken in the side bar; its take-down refused.
  const opUp = { ...staff, web: true, current: { seq: 7, op: true, kind: 'web', name: 'Tom' } };
  assert.deepEqual(verdicts(opUp, 'board', 'over').slice(0, 4), Array(4).fill(OPERATOR));
  assert.deepEqual(verdicts(opUp, 'board', 'side').slice(0, 4), [true, true, true, true]);
  assert.equal(canShow({ ...opUp, ifSeq: 7 }, { kind: 'chat', layer: 'info' }, 'board'), OPERATOR);
  // The operator's information on one of the Board's pages (a person On stage shown their own) while the Board's own is a
  // researcher's: over the Board refused, the side bar taken, and the Take down of the Board's refused (it would put the
  // operator's away there).
  const opOn = { ...staff, web: true, current: { seq: 9, op: false, kind: 'web', name: 'Ben' }, ifSeq: 9, opOn: { kind: 'web' } };
  assert.deepEqual(verdicts(opOn, 'board', 'over').slice(0, 4), Array(4).fill(OPERATOR));
  assert.deepEqual(verdicts(opOn, 'board', 'side').slice(0, 4), [true, true, true, true]);
  assert.equal(canShow(opOn, { kind: 'chat', layer: 'info' }, 'board'), OPERATOR);
  assert.equal(canShow({ ...opOn, opOn: 'web' }, { kind: 'chat', layer: 'info' }, 'board'), true, 'a fact that is not one is none');
  // A take-down names the take it takes down, put up by canShow, still up.
  const mineUp = { ...staff, web: true, ifSeq: undefined, current: { seq: 9, op: false, kind: 'web', name: 'Ben' } };
  assert.equal(canShow(mineUp, { kind: 'chat', layer: 'info' }, 'board'), 'Take down names the take it takes down.');
  assert.equal(canShow({ ...mineUp, ifSeq: 8 }, { kind: 'chat', layer: 'info' }, 'board'), 'Ben\'s web page is up now — yours was already replaced.');
  assert.equal(canShow({ ...mineUp, ifSeq: 9 }, { kind: 'chat', layer: 'info' }, 'board'), true);
  assert.equal(canShow({ ...staff, ifSeq: 9, current: null }, { kind: 'chat', layer: 'info' }, 'board'), 'Nothing is shown over the show there now — yours was already taken down.');
  // Between two researchers the latest wins: over another's is taken.
  assert.equal(canShow(mineUp, 'snippet', 'board', 'over'), true);
  // Facts that are none refuse.
  assert.equal(canShow(null, 'web', 'board'), TEAM);
  assert.equal(canShow({}, 'clock', 'board'), TEAM);
});

// ---------------------------------------------------------------- a document and a picture (plan 4-§5.9.3, §5.9.5)
const PDF = '/uploads/1730000000000-abcdefghijkl-pack.pdf';
const DOCX = '/uploads/1730000000000-abcdefghijkl-minutes.docx';
const XLSX = '/uploads/1730000000000-abcdefghijkl-q3.xlsx';
/** A source the server's facts would answer for every file: the Main room's, by the name AGMessage holds for it. */
const held = (name = 'Board pack.pdf', room = '') => () => ({ name, room, roomName: room ? 'Legal' : '' });
/** Two web takes, as a pusher asks for them (a store that seals their addresses keeps them: sealing). */
const VOTE_PAGE = { kind: 'web', url: 'https://vote.example.com/' };
const POLL_PAGE = { kind: 'web', url: 'https://poll.example.com/' };

test('cleanPage: a document is the whole file, its place its type\'s, Download only when sent as true, never to an observer; no region is read', () => {
  const facts = { source: held() };
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF, at: { page: 12 }, name: 'Final approved budget.pdf', download: true, note: '  Look at the totals  ', region: { x: 1 } }, facts),
    { kind: 'doc', url: PDF, name: 'Board pack.pdf', at: { page: 12 }, download: true, note: 'Look at the totals' }, 'the name is the server\'s, a region is no key of it');
  for (const download of [undefined, 'true', 1, null, false]) assert.equal(cleanPage({ kind: 'doc', url: PDF, download }, facts).download, false, JSON.stringify(download));
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF }, facts), { kind: 'doc', url: PDF, name: 'Board pack.pdf', download: false }, 'no place: opened at its start');
  // Each type's own place, in its range; a place of another type, or past it, refuses the whole take.
  const AT = { error: 'That place cannot be read for this file: a page or a slide (1-9999), a sheet (1-64), a paragraph or a line (1-999999).' };
  const place = (url, at) => cleanPage({ kind: 'doc', url, at }, facts);
  assert.deepEqual(place(DOCX, { block: 40, page: 3, approx: true }).at, { block: 40, page: 3, approx: true });
  assert.deepEqual(place(DOCX, { block: 40, page: 3, approx: false }).at, { block: 40, page: 3 });
  assert.deepEqual(place(XLSX, { sheet: 64 }).at, { sheet: 64 });
  assert.deepEqual(place('/uploads/1730000000000-abcdefghijkl-n.md', { line: 999999 }).at, { line: 999999 });
  assert.deepEqual(place('/uploads/1730000000000-abcdefghijkl-d.pptx', { slide: 9999 }).at, { slide: 9999 });
  for (const [url, at] of [[PDF, { page: 0 }], [PDF, { page: 10000 }], [PDF, { page: 1.5 }], [PDF, { page: '3' }], [PDF, { slide: 2 }], [PDF, { page: 2, approx: true }], [PDF, {}],
    [XLSX, { sheet: 65 }], [DOCX, { page: 3 }], [DOCX, { block: 2, approx: true }], [DOCX, { block: 2, page: 1, approx: 'yes' }], [PIC, { page: 1 }], [PDF, 5], [PDF, null], [PDF, [1]]]) {
    assert.deepEqual(place(url, at), AT, url.slice(-5) + ' ' + JSON.stringify(at));
  }
  assert.deepEqual(place(PIC, {}), { kind: 'doc', url: PIC, name: 'Board pack.pdf', download: false }, 'a picture opens whole: no place');
  // A document hands over the whole file: never to a person seated as an observer.
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF }, { ...facts, observer: true }), { error: 'Observers are shown pictures and quotes, not documents.' });
  // An address of ours of a type the stage shows, by where it may come from; a note is a string.
  const FILE = { error: 'A document or a picture is a file shared in AGMessage.' };
  for (const url of ['https://example.com/a.pdf', '/uploads/a.pdf', '/uploads/../1730000000000-abcdefghijkl-a.pdf', 5, null, undefined]) assert.deepEqual(cleanPage({ kind: 'doc', url }, facts), FILE, JSON.stringify(url));
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF, note: 5 }, facts), KINDS_WORDS);
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF }, { source: () => ({ error: 'That file belongs to another room — send it from there.' }) }), { error: 'That file belongs to another room — send it from there.' });
  for (const f of [undefined, {}, { source: true }, { source: () => null }]) assert.deepEqual(cleanPage({ kind: 'doc', url: PDF }, f), { error: 'That file is in no room of this hall you can read — share it there first.' }, JSON.stringify(f));
  // A side room's file keeps the room it belongs to (its key on this laptop alone) and its name.
  assert.deepEqual(cleanPage({ kind: 'doc', url: PDF }, { source: held('Q3.pdf', 'LEGAL1') }), { kind: 'doc', url: PDF, name: 'Q3.pdf', download: false, room: 'LEGAL1', roomName: 'Legal' });
});

test('cleanPage: a picture is an image of ours, and says what it is a picture of: a file\'s place (by its source, never its address) or the pusher\'s own copy', () => {
  const sources = { [PDF]: { name: 'Board pack.pdf', room: '' }, [PIC]: { name: 'p12.png', room: '' } };
  const facts = { source: (url) => sources[url] || { error: 'That file is in no room of this hall you can read — share it there first.' } };
  assert.deepEqual(cleanPage({ kind: 'image', url: PIC, from: { url: PDF, at: { page: 12 } }, note: 'p. 12' }, facts),
    { kind: 'image', url: PIC, name: 'p12.png', from: { name: 'Board pack.pdf', type: 'pdf', at: { page: 12 } }, note: 'p. 12' });
  assert.deepEqual(cleanPage({ kind: 'image', url: PIC, from: { local: true, name: 'Board pack.pdf', at: { page: 3 } } }, facts),
    { kind: 'image', url: PIC, name: 'p12.png', from: { local: true, name: 'Board pack.pdf', type: 'pdf', at: { page: 3 } } });
  assert.deepEqual(cleanPage({ kind: 'image', url: PIC }, facts), { kind: 'image', url: PIC, name: 'p12.png' }, 'shown whole');
  // Never a file that is not an image; a source that may not be shown refuses the picture; a source's place is its own type's.
  for (const url of [PDF, DOCX, '/uploads/a.png']) assert.deepEqual(cleanPage({ kind: 'image', url }, facts), { error: 'A picture is a PNG, JPEG, GIF or WebP shared in AGMessage.' }, url);
  assert.deepEqual(cleanPage({ kind: 'image', url: PIC, from: { url: XLSX } }, facts), { error: 'That file is in no room of this hall you can read — share it there first.' });
  assert.equal(cleanPage({ kind: 'image', url: PIC, from: { url: PDF, at: { slide: 2 } } }, facts).error.startsWith('That place cannot be read'), true);
  for (const from of [5, 'x', null, { url: 5 }, { local: 'yes', name: 'a.pdf' }, { local: true }, { local: true, name: 5 }]) assert.ok(cleanPage({ kind: 'image', url: PIC, from }, facts).error, JSON.stringify(from));
  assert.deepEqual(cleanPage({ kind: 'image', url: PIC, from: { local: true, name: 'setup.exe' } }, facts), { error: 'AGMessage does not show that kind of file on the stage: share it for download.' });
  // What a page is told of it: no side room's key, and a source's address never there to tell.
  const p = new Pages(path.join(folder(), 'pages.json'));
  const told = p.told({ kind: 'image', url: PIC, name: 'p12.png', from: { name: 'Q3.pdf', type: 'pdf', at: { page: 2 }, room: 'LEGAL1', roomName: 'Legal' }, room: 'LEGAL1', roomName: 'Legal' });
  assert.deepEqual(told, { kind: 'image', url: PIC, name: 'p12.png', from: { name: 'Q3.pdf', type: 'pdf', at: { page: 2 }, roomName: 'Legal' }, roomName: 'Legal' });
});

test('sourceOk: a fresh upload of the pusher\'s for Main or a listed room it posts files in; a Main file; a listed side room\'s it reads; the stage\'s own record by its room; never another\'s fresh upload, a transfer-only file or a room off Main\'s list', () => {
  const MAIN = 'HALLA1';
  const LEGAL = 'LEGAL1';
  const MEDIA = 'MEDIA1';
  const rooms = { [LEGAL]: 'Legal', [MEDIA]: 'Media' };
  const facts = (o = {}) => ({
    main: MAIN, uid: 'uana', holders: () => [], fresh: () => null, recorded: () => null, reads: (k) => k === LEGAL, listed: () => false, files: () => true, roomName: (k) => rooms[k] || '', ...o,
  });
  const LEGAL_OFF = { error: 'That file belongs to Legal, which may not send into the Main room — send it there first, or ask an admin.' };
  const OTHER = { error: 'That file belongs to another room — send it from there.' };
  // Rule 2: a file in a message of the Main room passes, by the oldest message's name.
  assert.deepEqual(sourceOk(PDF, facts({ holders: () => [{ key: MAIN, at: 2, name: 'Renamed.pdf' }, { key: MAIN, at: 1, name: 'Board pack.pdf' }] })), { name: 'Board pack.pdf', room: '', roomName: '' }, 'a re-post under a new name keeps the first');
  // Rule 3: a side room's, refused off Main's list (naming Legal to a reader of it, "another room" to anyone else), passed on it.
  assert.deepEqual(sourceOk(PDF, facts({ holders: () => [{ key: LEGAL, at: 1, name: 'Q3.pdf' }] })), LEGAL_OFF);
  assert.deepEqual(sourceOk(PDF, facts({ holders: () => [{ key: MEDIA, at: 1, name: 'Q3.pdf' }] })), OTHER, 'Media is not read: not named');
  assert.deepEqual(sourceOk(PDF, facts({ holders: () => [{ key: LEGAL, at: 1, name: 'Q3.pdf' }], listed: (k) => k === LEGAL })), { name: 'Q3.pdf', room: LEGAL, roomName: 'Legal' });
  assert.deepEqual(sourceOk(PDF, facts({ holders: () => [{ key: MEDIA, at: 1, name: 'Q3.pdf' }], listed: () => true })), OTHER, 'on the list, but not read');
  // Rule 1: the pusher's own fresh upload, for Main, or for a listed room where it posts files; never another's.
  const mine = (room) => () => ({ room, uid: 'uana', name: 'p. 12.png' });
  assert.deepEqual(sourceOk(PIC, facts({ fresh: mine(MAIN) })), { name: 'p. 12.png', room: '', roomName: '', fresh: true });
  assert.deepEqual(sourceOk(PIC, facts({ fresh: mine(LEGAL) })), LEGAL_OFF, 'made from a Legal page while Legal is off the list');
  assert.deepEqual(sourceOk(PIC, facts({ fresh: mine(LEGAL), listed: (k) => k === LEGAL })), { name: 'p. 12.png', room: LEGAL, roomName: 'Legal', fresh: true });
  assert.deepEqual(sourceOk(PIC, facts({ fresh: mine(LEGAL), listed: (k) => k === LEGAL, files: () => false, reads: () => false })), OTHER, 'a room it may not post files in');
  assert.deepEqual(sourceOk(PIC, facts({ fresh: () => ({ room: MAIN, uid: 'uben', name: 'x.png' }) })), { error: 'That file is in no room of this hall you can read — share it there first.' }, 'another\'s fresh upload');
  // Once posted, the pusher's own upload is its room's (rule 2), never fresh: the stage does not keep a message's file.
  assert.deepEqual(sourceOk(PIC, facts({ fresh: mine(MAIN), holders: () => [{ key: MAIN, at: 1, name: 'p. 12.png' }] })), { name: 'p. 12.png', room: '', roomName: '' });
  // Rule 4: what the stage recorded, by the room it was recorded for (passing rule 2 or 3 now).
  assert.deepEqual(sourceOk(PIC, facts({ recorded: () => ({ room: MAIN, name: 'p. 12.png' }) })), { name: 'p. 12.png', room: '', roomName: '' });
  assert.deepEqual(sourceOk(PIC, facts({ recorded: () => ({ room: LEGAL, name: 'p. 12.png' }) })), LEGAL_OFF, 'its room checked again');
  // Not ours, not a stage type, held nowhere.
  assert.deepEqual(sourceOk('https://example.com/a.pdf', facts()), { error: 'A document or a picture is a file shared in AGMessage.' });
  assert.deepEqual(sourceOk('/uploads/1730000000000-abcdefghijkl-a.exe', facts()), { error: 'AGMessage does not show that kind of file on the stage: share it for download.' });
  assert.deepEqual(sourceOk(PDF, facts()), { error: 'That file is in no room of this hall you can read — share it there first.' });
  assert.deepEqual(sourceOk(PDF, null), { error: 'That file is in no room of this hall you can read — share it there first.' });
});

test('describePage: a document and a picture in two voices, the console\'s by name and place, the audit\'s by type alone; a side room and a push sent from one said', () => {
  const doc = { kind: 'doc', url: PDF, name: 'Board pack.pdf', at: { page: 12 }, download: false };
  const word = { kind: 'doc', url: DOCX, name: 'Minutes.docx', at: { block: 9, page: 3, approx: true }, download: false };
  assert.deepEqual([describePage(doc), describePage(doc, { voice: 'audit' })], ['Board pack.pdf at p. 12', 'a PDF at p. 12']);
  assert.deepEqual([describePage(word), describePage(word, { voice: 'audit' })], ['Minutes.docx at ≈ p. 3', 'a Word document at ≈ p. 3']);
  assert.equal(describePage({ ...word, at: { block: 9, page: 3 } }, { voice: 'audit' }), 'a Word document at p. 3');
  const page = { kind: 'image', url: PIC, name: 'p12.png', from: { name: 'Board pack.pdf', type: 'pdf', at: { page: 12 } } };
  assert.deepEqual([describePage(page, { by: 'Ana' }), describePage(page, { voice: 'audit', by: 'Ana' })], ['Ana\'s picture of Board pack.pdf, p. 12', 'a picture of a PDF page (p. 12)']);
  const part = { kind: 'image', url: PIC, name: 'crop.png', from: { name: 'Stage plan.png', type: 'png' } };
  assert.deepEqual([describePage(part, { by: 'Ana' }), describePage(part, { voice: 'audit' })], ['Ana\'s picture of part of Stage plan.png', 'a picture of part of an image']);
  const local = { kind: 'image', url: PIC, name: 'p12.png', from: { local: true, name: 'Board pack.pdf', type: 'pdf', at: { page: 12 } } };
  assert.deepEqual([describePage(local, { by: 'Ana' }), describePage(local, { voice: 'audit' })], ['Ana\'s picture of their copy of Board pack.pdf, p. 12', 'a picture of a PDF page (p. 12), from a local copy']);
  const legal = { kind: 'doc', url: XLSX, name: 'Q3.xlsx', at: { sheet: 2 }, download: false, room: 'LEGAL1', roomName: 'Legal' };
  assert.deepEqual([describePage(legal, { sent: 'Legal' }), describePage(legal, { voice: 'audit', sent: 'Legal' })], ['Q3.xlsx in Legal at sheet 2, sent from Legal', 'a spreadsheet in Legal at sheet 2, sent from Legal']);
  // The audit's voice never names a file nor carries its path.
  for (const c of [doc, word, page, part, local, legal]) {
    const w = describePage(c, { voice: 'audit', by: 'Ana' });
    assert.ok(!/pack|Minutes|Q3|plan|\/uploads|\.pdf|\.png|\.xlsx|\.docx/.test(w), w);
  }
});

test('the stage\'s files: kept while a take or Earlier names them and for the wait after, 200 in use a hall, the oldest in use no longer let go past it, a hall\'s gone with it; a withdrawal starts its wait', () => {
  const WAIT = 60_000;
  const p = sealing({ wait: WAIT });
  const name = (i) => '1730000000' + String(i).padStart(3, '0') + '-abcdefghijkl-p' + i + '.png';
  const url = (i) => '/uploads/' + name(i);
  const pic = (i) => ({ kind: 'image', url: url(i), name: 'p' + i + '.png' });
  const files = () => p.halls[HALL].files;
  // A take naming a fresh upload keeps it as the hall's stage file, named while it is up and under Earlier.
  const t1 = p.take(HALL, 'board', pic(1), { name: 'Ana', who: 'account:aana' }, { at: 1000 });
  assert.deepEqual(p.recordFile(HALL, name(1), { at: 900, room: HALL, uid: 'uana', name: 'p1.png' }, 1000), []);
  assert.deepEqual(files(), { [name(1)]: { at: 900, room: HALL, uid: 'uana', name: 'p1.png', named: true } });
  assert.deepEqual(p.recordOf(HALL, name(1)), { room: HALL, name: 'p1.png' });
  assert.equal(p.namesUrl(HALL, url(1)), true);
  // Superseded, it is under Earlier: still named, still in use long after its upload's hour.
  assert.ok(p.take(HALL, 'board', VOTE_PAGE, { name: 'Ana' }, { at: 5000 }));
  assert.ok(p.stageInUse(10 * WAIT).has(name(1)));
  // Withdrawn: gone from Earlier, so its wait starts then; in use for the wait, let go after it, its record gone.
  assert.equal(p.withdraw(HALL, t1.seq, { at: 20_000, who: 'account:aana' }).take.seq, t1.seq);
  assert.deepEqual(p.withdrawnOf(HALL, t1.seq), { who: 'account:aana' });
  assert.equal(p.find(HALL, t1.seq), null);
  assert.deepEqual(files()[name(1)], { at: 20_000, room: HALL, uid: 'uana', name: 'p1.png' });
  assert.ok(p.stageInUse(20_000 + WAIT - 1).has(name(1)), 'inside its wait');
  assert.deepEqual(p.stageGone(20_000 + WAIT - 1), []);
  assert.deepEqual(p.stageGone(20_000 + WAIT), [name(1)], 'past it');
  assert.equal(p.recordOf(HALL, name(1)), null);
  assert.ok(!Object.hasOwn(p.halls[HALL], 'files'), 'no stage file kept: none written');
  // The bound: 200 in use a hall (named, or inside their wait); a new one then has no room until one is in use no longer,
  // the oldest of which goes.
  const T = 100_000;
  for (let i = 10; i < 210; i++) p.recordFile(HALL, name(i), { at: T + i, room: HALL, uid: 'uana', name: 'p.png' }, T + i);
  assert.equal(Object.keys(files()).length, 200);
  assert.equal(p.fileRoom(HALL, name(300), T + 300), false, '200 in use: no room');
  assert.equal(p.fileRoom(HALL, name(10), T + 300), true, 'one it holds');
  assert.equal(p.fileRoom(HALL, name(300), T + 10 + WAIT), true, 'the oldest past its wait');
  assert.deepEqual(p.recordFile(HALL, name(300), { at: T + 10 + WAIT, room: HALL, uid: 'uana', name: 'p.png' }, T + 10 + WAIT), [name(10)]);
  assert.equal(Object.keys(files()).length, 200);
  assert.equal(STAGE_FULL, 'This hall\'s stage holds 200 files — take some down.');
  // A hall closed returns its stage files' names, for the server to remove with or without its rooms' files.
  assert.equal(p.forgetHall(HALL).length, 200);
});

test('a holding slide\'s picture is the stage\'s while the slide is up (fileOf), never a take-down\'s; a file only the stage still holds is adopted as a stage file, its author\'s or none, and let go after its wait', () => {
  const WAIT = 60_000;
  const p = sealing({ wait: WAIT });
  const name = '1730000000001-abcdefghijkl-slide.png';
  const url = '/uploads/' + name;
  assert.deepEqual([fileOf({ kind: 'holding', image: url }), fileOf({ kind: 'image', url }), fileOf({ kind: 'doc', url: PDF }), fileOf({ kind: 'holding' }), fileOf({ kind: 'web', url: 'https://example.com/a.png' }), fileOf({ kind: 'holding', image: 'https://example.com/a.png' }), fileOf(null)],
    [url, url, PDF, '', '', '', '']);
  const slide = p.take(HALL, 'board', { kind: 'holding', image: url }, { name: 'Op' }, { at: 1000 });
  assert.ok(slide);
  assert.ok(p.stageInUse(10 * WAIT).has(name), 'the slide names it');
  assert.equal(p.namesUrl(HALL, url), false, 'no information take names it: the admin\'s delete asks nothing');
  // Its message gone while the slide is up: the stage keeps it as its own from then (a message's author, or none known).
  assert.deepEqual(p.adopt(name, { room: HALL, uid: '', name: 'slide.png' }, 2000), []);
  assert.deepEqual(p.halls[HALL].files, { [name]: { at: 2000, room: HALL, uid: '', name: 'slide.png', named: true } });
  assert.deepEqual(onDisk(p).halls[HALL].files[name], { at: 2000, room: HALL, uid: '', name: 'slide.png', named: true });
  assert.deepEqual(new Pages(p.file).halls[HALL].files[name], { at: 2000, room: HALL, uid: '', name: 'slide.png', named: true }, 'read back: an author none knew');
  assert.deepEqual(p.adopt(name, { room: HALL, uid: 'uben', name: 'other.png' }, 3000), [], 'kept once');
  assert.equal(p.halls[HALL].files[name].name, 'slide.png');
  assert.deepEqual(p.adopt('1730000000002-abcdefghijkl-none.png', { room: HALL, uid: '', name: 'x.png' }, 3000), [], 'one nothing names is not the stage\'s');
  assert.ok(!Object.hasOwn(p.halls[HALL].files, '1730000000002-abcdefghijkl-none.png'));
  // The slide put away: its wait starts, and the file is let go after it.
  assert.ok(p.take(HALL, 'board', { kind: 'clock' }, { name: 'Op' }, { at: 5000 }));
  assert.deepEqual(p.stageGone(5000), []);
  assert.deepEqual(p.stageGone(5000 + WAIT), [name]);
});

test('what ends a take: every information take of a hall (a Main reset, Earlier emptied), those a side room holds the source of, those showing a file; handed back on the pages that show them, the show left', () => {
  const p = sealing();
  const clock = p.take(HALL, 'board', { kind: 'clock' }, { name: 'Op' }, { at: 1 });
  const legal = p.take(HALL, 'board', { kind: 'doc', url: PDF, name: 'Q3.pdf', download: false, room: 'LEGAL1', roomName: 'Legal' }, { name: 'Ana' }, { at: 2 });
  assert.ok(p.take(HALL, ANA, VOTE_PAGE, { name: 'Len' }, { at: 3, sent: { key: 'LEGAL1', name: 'Legal' } }));
  const mainDoc = p.take(HALL, BEN, { kind: 'doc', url: DOCX, name: 'Minutes.docx', download: false }, { name: 'Ana' }, { at: 4 });
  assert.deepEqual(p.find(HALL, legal.seq).to, ['board']);
  // A side room's reset: what it holds the source of, or sent; the Main room's and the show stay.
  const sourced = (t) => t.content.room === 'LEGAL1' || (!!t.sent && t.sent.key === 'LEGAL1');
  assert.equal(p.endTakes(HALL, sourced, { at: 10 }), 2);
  assert.equal(p.current(HALL, '', { board: true, layer: 'info' }).take.content.kind, 'chat', 'handed back');
  assert.equal(p.current(HALL, ANA, { layer: 'info' }).take.content.kind, 'chat');
  assert.equal(p.current(HALL, BEN, { layer: 'info' }).take.seq, mainDoc.seq);
  assert.equal(p.current(HALL, '', { board: true }).take.seq, clock.seq, 'the show left');
  assert.equal(p.endTakes(HALL, sourced, { at: 11 }), 0, 'nothing more of it');
  // A file's message deleted: what shows that file.
  assert.equal(p.endTakes(HALL, (t) => t.content.url === DOCX, { at: 12 }), 1);
  assert.equal(p.find(HALL, mainDoc.seq), null);
  // A Main reset: every information take, and Earlier emptied whole.
  const web = p.take(HALL, 'board', VOTE_PAGE, { name: 'Op' }, { at: 13 });
  p.take(HALL, 'board', POLL_PAGE, { name: 'Op' }, { at: 14 });
  assert.equal(p.earlierOf(HALL, '', { board: true })[0].seq, web.seq);
  assert.equal(p.endTakes(HALL, () => true, { at: 15, earlier: 'all' }), 2);
  assert.deepEqual(p.halls[HALL].earlier, []);
  assert.equal(p.current(HALL, '', { board: true }).take.seq, clock.seq);
});

test('a document is told a page seated as an observer without its address, under Earlier too; a document and a picture are read back as they were kept, and a wrong shape is dropped', () => {
  const file = path.join(folder(), 'pages.json');
  const p = store({ file });
  const doc = { kind: 'doc', url: PDF, name: 'Board pack.pdf', at: { page: 12 }, download: true, room: 'LEGAL1', roomName: 'Legal' };
  const t = p.take(HALL, BEN, doc, { name: 'Ana' });
  assert.deepEqual(p.told(t.content, { observer: true }), { kind: 'doc', name: 'Board pack.pdf', at: { page: 12 }, withheld: true, roomName: 'Legal' });
  assert.deepEqual(p.told(t.content), { kind: 'doc', url: PDF, name: 'Board pack.pdf', at: { page: 12 }, download: true, roomName: 'Legal' });
  p.take(HALL, BEN, { kind: 'chat', layer: 'info' }, { name: 'Ana' });
  assert.deepEqual(p.earlierOf(HALL, BEN, { observer: true })[0].content, { kind: 'doc', name: 'Board pack.pdf', at: { page: 12 }, withheld: true, roomName: 'Legal' });
  p.flush();
  const again = new Pages(file);
  assert.deepEqual(again.halls[HALL].earlier[0].content, doc, 'read back whole');
  // A stored document or picture of the wrong shape is no take.
  const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
  bad.halls[HALL].people[ANA] = { info: { seq: 1, content: { kind: 'doc', url: PDF, name: 'x', at: { slide: 2 }, download: false }, by: { name: 'A' }, at: 1 } };
  bad.halls[HALL].people[CY] = { info: { seq: 1, content: { kind: 'image', url: PDF, name: 'x' }, by: { name: 'A' }, at: 1 } };
  fs.writeFileSync(file, JSON.stringify(bad));
  const read = new Pages(file);
  assert.deepEqual(Object.keys(read.halls[HALL].people), [BEN], 'a place of another type, a picture that is no image: dropped');
});
