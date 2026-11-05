'use strict';
// Word's pages and Word's hidden text (public/wordpages.js), over XML strings built here, and the page's document worker
// (public/docworker.js, run as a browser runs a worker) handing mammoth a copy of the file without its hidden runs.
// The pages are Word's own: its rendered breaks where it saved them (exact), else the explicit breaks (approximate); a
// hidden run never reaches mammoth, the drawing, a pick or the AI's text, and a hidden mark that cannot be resolved
// refuses the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const W = require('../public/wordpages.js');
const { officeZip, wordParts, wordPicture, docWorker, pngOf, OOXML, W_NS, ROOT, readSource } = require('./helpers');

const doc = (body) => OOXML + '<w:document ' + W_NS + '><w:body>' + body + '</w:body></w:document>';
const styles = (inner) => OOXML + '<w:styles ' + W_NS + '>' + inner + '</w:styles>';
const p = (text, { pPr = '', rPr = '' } = {}) => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t>' + text + '</w:t></w:r></w:p>';
const RENDERED = '<w:r><w:lastRenderedPageBreak/></w:r>';
const pages = (sc) => sc.paras.map((x) => x.text + ':' + x.page + (x.last !== x.page ? '-' + x.last : ''));
const plain = (v) => JSON.parse(JSON.stringify(v));

test('wordpages: Word\'s rendered breaks give exact pages; a paragraph holding one spans two, and one starting with one begins the next page', () => {
  const body = p('One') + '<w:p><w:r><w:t>Two starts</w:t></w:r><w:r><w:lastRenderedPageBreak/><w:t> and ends</w:t></w:r></w:p>' + '<w:p>' + RENDERED + '<w:r><w:t>Three</w:t></w:r></w:p>' + p('Four');
  const sc = W.scan({ document: doc(body) });
  assert.equal(sc.ok, true);
  assert.deepEqual([sc.basis, sc.pages, sc.approx], ['word', 3, false]);
  assert.deepEqual(pages(sc), ['One:1', 'Two starts and ends:1-2', 'Three:3', 'Four:3']);
});

test('wordpages: a hard page break followed by Word\'s rendered break counts once; explicit breaks alone give basis "breaks", approximate', () => {
  const both = W.scan({ document: doc(p('A') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p>' + RENDERED + '<w:r><w:t>B</w:t></w:r></w:p>') });
  assert.deepEqual([both.basis, both.pages, both.approx], ['word', 2, false]);
  assert.deepEqual(pages(both).filter((x) => !x.startsWith(':')), ['A:1', 'B:2']);
  const explicit = W.scan({ document: doc(p('A') + '<w:p><w:r><w:t>B</w:t><w:br w:type="page"/><w:t>C</w:t></w:r></w:p>' + p('D') + '<w:p><w:r><w:br w:type="page"/><w:t>E</w:t></w:r></w:p>') });
  assert.deepEqual([explicit.basis, explicit.pages, explicit.approx], ['breaks', 3, true]);
  assert.deepEqual(pages(explicit), ['A:1', 'B C:1-2', 'D:2', 'E:3']);
  // A line break that is not a page's is only a space.
  assert.deepEqual(pages(W.scan({ document: doc('<w:p><w:r><w:t>x</w:t><w:br/><w:t>y</w:t><w:tab/><w:t>z</w:t></w:r></w:p>') })), ['x y z:1']);
});

test('wordpages: w:pageBreakBefore set on the paragraph and through a w:basedOn chain breaks the page; a chain past 10 links is cut, and the pages marked approximate', () => {
  const chain = (n, last) => Array.from({ length: n }, (_, i) => '<w:style w:type="paragraph" w:styleId="S' + i + '"><w:basedOn w:val="S' + (i + 1) + '"/></w:style>').join('') + '<w:style w:type="paragraph" w:styleId="S' + n + '">' + last + '</w:style>';
  const direct = W.scan({ document: doc(p('A') + p('B', { pPr: '<w:pageBreakBefore/>' }) + p('C', { pPr: '<w:pageBreakBefore w:val="0"/>' })) });
  assert.deepEqual(pages(direct), ['A:1', 'B:2', 'C:2']);
  const first = W.scan({ document: doc(p('A', { pPr: '<w:pageBreakBefore/>' })) });
  assert.deepEqual(pages(first), ['A:1'], 'the first paragraph is on page 1 already');
  const ten = W.scan({ document: doc(p('A') + p('B', { pPr: '<w:pStyle w:val="S0"/>' })), styles: styles(chain(10, '<w:pPr><w:pageBreakBefore/></w:pPr>')) });
  assert.deepEqual([pages(ten), ten.cut, ten.approx], [['A:1', 'B:2'], false, true]);
  // Past 10 links the break is not known: an empty paragraph's (a run's text would be refused, since its hidden mark could
  // not be resolved either) leaves the page where it was, and every page is approximate.
  const eleven = W.scan({ document: doc(p('A') + '<w:p><w:pPr><w:pStyle w:val="S0"/></w:pPr></w:p>' + p('B')), styles: styles(chain(11, '<w:pPr><w:pageBreakBefore/></w:pPr>')) });
  assert.deepEqual([pages(eleven), eleven.cut, eleven.approx], [['A:1', ':1', 'B:1'], true, true]);
  assert.deepEqual(W.scan({ document: doc(p('A') + p('B', { pPr: '<w:pStyle w:val="S0"/>' })), styles: styles(chain(11, '<w:pPr><w:pageBreakBefore/></w:pPr>')) }), { ok: false, why: 'hidden' });
  // A style with no pStyle named: the default paragraph style's break applies.
  const byDefault = W.scan({ document: doc(p('A') + p('B')), styles: styles('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:pageBreakBefore/></w:pPr></w:style>') });
  assert.deepEqual(pages(byDefault), ['A:1', 'B:2']);
});

test('wordpages: a section with no w:type breaks the page, a continuous one does not, an odd page one counts one', () => {
  const sect = (type) => '<w:sectPr>' + (type ? '<w:type w:val="' + type + '"/>' : '') + '</w:sectPr>';
  const ends = (text) => '<w:p><w:pPr>' + '</w:pPr><w:r><w:t>' + text + '</w:t></w:r></w:p>';
  const endSection = (text) => '<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>' + text + '</w:t></w:r></w:p>';
  const sc = (type) => W.scan({ document: doc(endSection('A') + ends('B') + sect(type)) });
  assert.deepEqual(pages(sc('')), ['A:1', 'B:2'], 'next page, the default');
  assert.deepEqual(pages(sc('nextPage')), ['A:1', 'B:2']);
  assert.deepEqual(pages(sc('continuous')), ['A:1', 'B:1']);
  assert.deepEqual(pages(sc('oddPage')), ['A:1', 'B:2'], 'counts one: a blank page Word may add is not known');
});

test('wordpages: <Pages> that disagrees with Word\'s rendered breaks gives "word-stale", approximate; one that agrees stays exact', () => {
  const body = doc(p('A') + '<w:p>' + RENDERED + '<w:r><w:t>B</w:t></w:r></w:p>');
  const app = (n) => '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>' + n + '</Pages></Properties>';
  assert.deepEqual((({ basis, pages: n, approx }) => [basis, n, approx])(W.scan({ document: body, app: app(5) })), ['word-stale', 2, true]);
  assert.deepEqual((({ basis, approx }) => [basis, approx])(W.scan({ document: body, app: app(2) })), ['word', false]);
});

test('wordpages: mammoth\'s blocks are placed on the scan\'s paragraphs by their text; one with no match takes the page before it, approximate', () => {
  const body = doc(p('Agenda') + p('') + '<w:p><w:r><w:t>Item 1 kept</w:t></w:r><w:del><w:r><w:delText>struck</w:delText></w:r></w:del></w:p>' + '<w:p>' + RENDERED + '<w:r><w:t>' + 'Long paragraph '.repeat(10) + '</w:t></w:r></w:p>' + p('Last'));
  const sc = W.scan({ document: body });
  assert.deepEqual(pages(sc), ['Agenda:1', ':1', 'Item 1 kept:1', 'Long paragraph '.repeat(10).trim() + ':2', 'Last:2']);
  // As mammoth draws them: no empty paragraph, the deleted text left out, a long paragraph matched by its first 40.
  const placed = W.place(['Agenda', 'Item 1 kept', 'Long paragraph '.repeat(10).trim() + ' (as drawn)', 'A footnote mammoth adds', '', 'Last'], sc);
  assert.deepEqual(placed.map((x) => [x.page, x.approx]), [[1, false], [1, false], [2, false], [2, true], [2, true], [2, false]]);
  // On an approximate basis every block is approximate.
  const rough = W.place(['A'], W.scan({ document: doc(p('A')) }));
  assert.deepEqual(rough, [{ page: 1, approx: true, differs: false }]);
  // A failed scan places every block approximately, on page 1.
  assert.deepEqual(W.place(['A'], { ok: false }), [{ page: 1, approx: true, differs: false }]);
});

test('wordpages: a section that restarts its page numbers marks its paragraphs "the printed page numbers differ here"', () => {
  const body = doc('<w:p><w:pPr><w:sectPr><w:pgNumType w:fmt="lowerRoman"/></w:sectPr></w:pPr><w:r><w:t>Cover</w:t></w:r></w:p>' + p('Body') + '<w:sectPr><w:pgNumType w:start="1"/></w:sectPr>');
  const sc = W.scan({ document: body });
  assert.deepEqual(sc.paras.map((x) => [x.text, x.page, x.differs]), [['Cover', 1, true], ['Body', 2, true]]);
  const plainNumbers = W.scan({ document: doc(p('A') + '<w:sectPr><w:pgNumType w:start="1"/></w:sectPr>') });
  assert.deepEqual(plainNumbers.paras.map((x) => x.differs), [false], 'a first section starting at 1 is the physical page');
  assert.equal(W.place(['Body'], sc)[0].differs, true);
  assert.equal(W.WORDS.differs, 'the printed page numbers differ here');
});

test('wordpages: a part with a document type or entity declaration is refused before it is scanned', () => {
  const dtd = '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "boom">]>' + doc(p('&x;')).slice(OOXML.length);
  assert.equal(W.hasDtd(dtd), true);
  assert.deepEqual(W.scan({ document: dtd }), { ok: false, why: 'dtd' });
  assert.deepEqual(W.scan({ document: doc(p('A')), styles: '<!ENTITY y "z">' }), { ok: false, why: 'dtd' });
  assert.deepEqual(W.stripHidden(dtd), { ok: false, why: 'dtd' });
  assert.deepEqual(W.scan({ document: '<w:document><w:body><w:p' }), { ok: false, why: 'shape' }, 'a tag that never ends');
});

// ---------------------------------------------------------------- hidden text
const HIDDEN_STYLES = styles(
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="character" w:styleId="Secret"><w:rPr><w:vanish/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Notes"><w:rPr><w:vanish/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:specVanish/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr></w:style>');
/** A body with one visible word and each way of hiding a run, each hidden word unique. */
const HIDDEN_BODY = p('Visible')
  + '<w:p><w:r><w:t>Kept </w:t></w:r><w:r><w:rPr><w:b/><w:vanish/></w:rPr><w:t>DIRECTWORD</w:t></w:r></w:p>'
  + p('SPECWORD', { rPr: '<w:specVanish/>' })
  + p('RSTYLEWORD', { rPr: '<w:rStyle w:val="Secret"/>' })
  + p('PSTYLEWORD', { pPr: '<w:pStyle w:val="Notes"/>' })
  + p('CHAINWORD', { pPr: '<w:pStyle w:val="Derived"/>' })
  + p('Shown again', { rPr: '<w:rStyle w:val="Secret"/><w:vanish w:val="0"/>' })
  + p('Old formatting', { rPr: '<w:rPrChange w:id="1" w:author="A"><w:rPr><w:vanish/></w:rPr></w:rPrChange>' })
  + '<w:p><w:r><w:t>Box </w:t><w:pict><w:txbxContent><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>BOXWORD</w:t></w:r><w:r><w:t>box shown</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>'
  + '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:pict><w:txbxContent><w:p><w:r><w:t>INBOXWORD</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>';
const HIDDEN_WORDS = ['DIRECTWORD', 'SPECWORD', 'RSTYLEWORD', 'PSTYLEWORD', 'CHAINWORD', 'BOXWORD', 'INBOXWORD'];

test('wordpages: every run hidden directly, by w:specVanish, through w:rStyle, its paragraph\'s w:pStyle and a w:basedOn chain is removed; w:vanish w:val="0", tracked old formatting and the paragraph mark\'s own keep theirs', () => {
  const table = W.styles(HIDDEN_STYLES);
  const s = W.stripHidden(doc(HIDDEN_BODY), table);
  assert.equal(s.ok, true);
  for (const word of HIDDEN_WORDS) assert.ok(!s.xml.includes(word), word + ' is removed');
  for (const kept of ['Visible', 'Kept ', 'Shown again', 'Old formatting', 'Box ', 'box shown']) assert.ok(s.xml.includes(kept), kept + ' is kept');
  assert.equal(s.removed, 7, 'each hidden run once, the one inside a hidden run with it');
  // The scan reads the same text: hidden runs left out of the paragraphs it places blocks on.
  const sc = W.scan({ document: doc(HIDDEN_BODY), styles: HIDDEN_STYLES });
  const text = sc.paras.map((x) => x.text).join(' ');
  for (const word of HIDDEN_WORDS) assert.ok(!text.includes(word), word + ' is not in the scan');
  // The default paragraph style's own paragraph-mark rPr hides no run; docDefaults' vanish hides every run.
  const allHidden = W.styles(styles('<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>'));
  assert.deepEqual(W.stripHidden(doc(p('A') + p('B')), allHidden).removed, 2);
  const shownAgain = W.stripHidden(doc(p('C', { rPr: '<w:vanish w:val="false"/>' })), allHidden);
  assert.ok(shownAgain.xml.includes('<w:t>C</w:t>'), 'a run\'s own setting decides');
  // A character style by default hides every run that names none.
  const charDefault = W.styles(styles('<w:style w:type="character" w:default="1" w:styleId="Dpf"><w:rPr><w:vanish/></w:rPr></w:style>'));
  assert.equal(W.stripHidden(doc(p('A')), charDefault).removed, 1);
});

test('wordpages: a hidden mark that cannot be resolved fails closed — a w:basedOn chain past 10 links, a style it cannot find', () => {
  const chain = (n) => Array.from({ length: n }, (_, i) => '<w:style w:type="character" w:styleId="C' + i + '"><w:basedOn w:val="C' + (i + 1) + '"/></w:style>').join('') + '<w:style w:type="character" w:styleId="C' + n + '"><w:rPr><w:vanish/></w:rPr></w:style>';
  const ten = W.stripHidden(doc(p('X', { rPr: '<w:rStyle w:val="C0"/>' })), W.styles(styles(chain(10))));
  assert.deepEqual([ten.ok, ten.removed], [true, 1], 'ten links are followed, and the run is hidden');
  assert.deepEqual(W.stripHidden(doc(p('X', { rPr: '<w:rStyle w:val="C0"/>' })), W.styles(styles(chain(11)))), { ok: false, why: 'hidden' });
  assert.deepEqual(W.stripHidden(doc(p('X', { rPr: '<w:rStyle w:val="Nowhere"/>' })), W.styles(styles(''))), { ok: false, why: 'hidden' });
  assert.deepEqual(W.stripHidden(doc(p('X', { pPr: '<w:pStyle w:val="Nowhere"/>' })), W.styles(styles(''))), { ok: false, why: 'hidden' });
  const loop = styles('<w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style>');
  assert.deepEqual(W.stripHidden(doc(p('X', { pPr: '<w:pStyle w:val="A"/>' })), W.styles(loop)), { ok: false, why: 'hidden' }, 'a loop is a chain past 10');
  assert.deepEqual(W.scan({ document: doc(p('X', { pPr: '<w:pStyle w:val="A"/>' })), styles: loop }), { ok: false, why: 'hidden' });
  assert.equal(W.WORDS.hidden, 'This Word file has hidden text AGMessage could not leave out — show a picture or a quote.');
});

test('the document worker: mammoth is handed the file without its hidden runs — none in its HTML, its pages or its text; tracked deletions and comments absent too', async () => {
  const body = HIDDEN_BODY + '<w:p><w:r><w:t>Agreed </w:t></w:r><w:del w:id="2" w:author="A"><w:r><w:delText>DELETEDWORD</w:delText></w:r></w:del><w:commentRangeStart w:id="3"/><w:r><w:t>text</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>';
  const parts = wordParts({ body, styles: HIDDEN_STYLES.slice(OOXML.length).replace(/^<w:styles [^>]+>|<\/w:styles>$/g, '') });
  parts['word/comments.xml'] = OOXML + '<w:comments ' + W_NS + '><w:comment w:id="3" w:author="A"><w:p><w:r><w:t>COMMENTWORD</w:t></w:r></w:p></w:comment></w:comments>';
  parts['word/footnotes.xml'] = OOXML + '<w:footnotes ' + W_NS + '><w:footnote w:id="1"><w:p><w:r><w:t>Note </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>FOOTWORD</w:t></w:r></w:p></w:footnote></w:footnotes>';
  const r = await docWorker('word', officeZip(parts));
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const word of [...HIDDEN_WORDS, 'DELETEDWORD', 'COMMENTWORD', 'FOOTWORD']) {
    assert.ok(!r.html.includes(word), word + ' is not in mammoth\'s HTML');
    assert.ok(!JSON.stringify(r.scan).includes(word), word + ' is not in the pages\' scan');
  }
  for (const kept of ['Visible', 'Shown again', 'box shown', 'Agreed']) assert.ok(r.html.includes(kept), kept + ' is drawn');
  // A file whose hidden mark cannot be resolved is refused, never drawn.
  const broken = await docWorker('word', officeZip(wordParts({ body: p('X', { rPr: '<w:rStyle w:val="Nowhere"/>' }), styles: '' })));
  assert.deepEqual(broken, { ok: false, why: 'hidden' });
});

test('the document worker: a Word file\'s pages come from its own breaks, its pictures leave as bytes with a placeholder in the HTML, and a declared document type refuses it', async () => {
  const body = p('Cover') + '<w:p>' + RENDERED + '<w:r><w:t>Second</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Chart</w:t></w:r>' + wordPicture('rId10', 'Capex chart') + wordPicture('rId11', 'Old logo') + '</w:p>' + '<w:p>' + RENDERED + '<w:r><w:t>Third</w:t></w:r></w:p>';
  const withEmf = wordParts({ body, pages: 3, media: { 'chart.png': pngOf(3, 2), 'logo.emf': Buffer.from('an EMF picture') } });
  withEmf['[Content_Types].xml'] = withEmf['[Content_Types].xml'].replace('<Default Extension="png"', '<Default Extension="emf" ContentType="image/x-emf"/><Default Extension="png"');
  const r = await docWorker('word', officeZip(withEmf));
  assert.equal(r.ok, true);
  assert.deepEqual([r.scan.basis, r.scan.pages, r.scan.approx], ['word', 3, false]);
  assert.deepEqual(plain(r.scan.paras.map((x) => [x.text, x.page])), [['Cover', 1], ['Second', 2], ['Chart', 2], ['Third', 3]]);
  assert.match(r.html, /<img [^>]*src="agm-img:1"/, 'the picture by its placeholder, never an address of the worker\'s');
  assert.ok(!/blob:|data:/.test(r.html), 'no blob: or data: address leaves the worker');
  assert.deepEqual(r.pictures.map((x) => [x.n, x.type, !!x.bytes]), [[1, 'image/png', true], [2, 'image/x-emf', false]], 'an EMF picture keeps its place, and no bytes the page could not draw');
  assert.ok(Buffer.compare(r.pictures[0].bytes, pngOf(3, 2)) === 0, 'the picture\'s own bytes');
  assert.match(r.html, /src="agm-img:2"/);
  const explicit = await docWorker('word', officeZip(wordParts({ body: p('A') + '<w:p><w:r><w:br w:type="page"/><w:t>B</w:t></w:r></w:p>' })));
  assert.deepEqual([explicit.scan.basis, explicit.scan.pages, explicit.scan.approx], ['breaks', 2, true]);
  const dtd = wordParts({ body: p('A') });
  dtd['word/settings.xml'] = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:settings ' + W_NS + '/>';
  assert.deepEqual(await docWorker('word', officeZip(dtd)), { ok: false, why: 'dtd' });
  assert.deepEqual(await docWorker('word', Buffer.from('not a zip at all, just bytes')), { ok: false, why: 'packed' });
  assert.deepEqual(await docWorker('poem', officeZip(wordParts({ body: p('A') }))), { ok: false, why: 'shape' }, 'an unknown task is refused');
});

// ---------------------------------------------------------------- tables, late marks, namespaces and the parts mammoth reads
const TABLE = (style, text, { tblPr = '' } = {}) => '<w:tbl><w:tblPr>' + (style ? '<w:tblStyle w:val="' + style + '"/>' : '') + tblPr + '</w:tblPr><w:tr><w:tc>' + p(text) + '</w:tc></w:tr></w:tbl>';

test('wordpages: a table\'s style hides its cells\' runs, through w:basedOn and as the default table style; a conditional format\'s mark, a table style it cannot find, or one named after a run fails closed', () => {
  const st = styles('<w:style w:type="table" w:styleId="HiddenGrid"><w:rPr><w:vanish/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="Child"><w:basedOn w:val="HiddenGrid"/></w:style>'
    + '<w:style w:type="table" w:styleId="Plain"><w:rPr><w:b/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="Banded"><w:tblStylePr w:type="firstRow"><w:rPr><w:vanish/></w:rPr></w:tblStylePr></w:style>');
  const table = W.styles(st);
  const s = W.stripHidden(doc(p('Before') + TABLE('HiddenGrid', 'TABLEWORD') + TABLE('Child', 'CHILDWORD') + TABLE('Plain', 'Shown cell') + p('After')), table);
  assert.equal(s.ok, true);
  for (const word of ['TABLEWORD', 'CHILDWORD']) assert.ok(!s.xml.includes(word), word + ' is removed');
  for (const kept of ['Before', 'Shown cell', 'After']) assert.ok(s.xml.includes(kept), kept + ' is kept');
  // A nested table inside a hidden one: its runs sit in both.
  assert.ok(!W.stripHidden(doc('<w:tbl><w:tblPr><w:tblStyle w:val="HiddenGrid"/></w:tblPr><w:tr><w:tc>' + TABLE('Plain', 'NESTEDWORD') + '</w:tc></w:tr></w:tbl>'), table).xml.includes('NESTEDWORD'));
  // The default table style hides a table that names none.
  const byDefault = W.styles(styles('<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:rPr><w:vanish/></w:rPr></w:style>'));
  assert.equal(W.stripHidden(doc(TABLE('', 'DEFAULTWORD') + p('Outside')), byDefault).removed, 1);
  assert.deepEqual(W.stripHidden(doc(TABLE('Banded', 'X')), table), { ok: false, why: 'hidden' }, 'a conditional format that hides');
  assert.deepEqual(W.stripHidden(doc(TABLE('Nowhere', 'X')), table), { ok: false, why: 'hidden' }, 'a table style the file does not have');
  const late = '<w:tbl><w:tr><w:tc>' + p('X') + '</w:tc></w:tr><w:tblPr><w:tblStyle w:val="HiddenGrid"/></w:tblPr></w:tbl>';
  assert.deepEqual(W.stripHidden(doc(late), table), { ok: false, why: 'hidden' }, 'a table style named after its runs were read');
  assert.deepEqual(W.scan({ document: doc(TABLE('Banded', 'X')), styles: st }), { ok: false, why: 'hidden' });
  const sc = W.scan({ document: doc(p('Before') + TABLE('HiddenGrid', 'TABLEWORD')), styles: st });
  assert.ok(!JSON.stringify(sc).includes('TABLEWORD'), 'the scan leaves a hidden table\'s text out');
});

test('wordpages: a run\'s hidden mark read after its text began (its properties after its text, or inside a markup-compatibility wrapper) fails closed; tracked old formatting still keeps the run', () => {
  const after = '<w:p><w:r><w:t>LATEWORD</w:t><w:rPr><w:vanish/></w:rPr></w:r></w:p>';
  assert.deepEqual(W.stripHidden(doc(after), W.styles('')), { ok: false, why: 'hidden' });
  const wrapped = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="w14"><w:rPr><w:vanish/></w:rPr></mc:Choice><mc:Fallback><w:t>WRAPWORD</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>';
  assert.deepEqual(W.stripHidden(doc(wrapped), W.styles('')), { ok: false, why: 'hidden' });
  const lateStyle = '<w:p><w:r><w:t>X</w:t><w:rPr><w:rStyle w:val="Secret"/></w:rPr></w:r></w:p>';
  assert.deepEqual(W.stripHidden(doc(lateStyle), W.styles(HIDDEN_STYLES)), { ok: false, why: 'hidden' }, 'a hiding character style named late');
  // A late mark that shows (w:val="0"), or a late style that hides nothing, changes nothing that was judged.
  assert.equal(W.stripHidden(doc('<w:p><w:r><w:t>X</w:t><w:rPr><w:vanish w:val="0"/></w:rPr></w:r></w:p>'), W.styles('')).ok, true);
  // A paragraph mark's own run properties inside a text box are not its container run's.
  const box = '<w:p><w:r><w:t>Box </w:t><w:pict><w:txbxContent><w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>inner shown</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>';
  const kept = W.stripHidden(doc(box), W.styles(''));
  assert.ok(kept.ok && kept.xml.includes('inner shown') && kept.xml.includes('Box '));
});

test('wordpages: WordprocessingML is read by the prefix w only — bound to another prefix or as the default namespace, a part is refused; strict OOXML\'s namespace as w is read', () => {
  const T = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const S = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
  assert.deepEqual(W.namespaces(doc(p('A'))), { ok: true });
  assert.deepEqual(W.namespaces('<w:document xmlns:w="' + S + '"><w:body/></w:document>'), { ok: true });
  assert.deepEqual(W.namespaces('<w:document xmlns:w="' + T + '"><w:body><w:p><x:r xmlns:x="' + T + '"><x:t>X</x:t></x:r></w:p></w:body></w:document>'), { ok: false, why: 'hidden' });
  assert.deepEqual(W.namespaces('<document xmlns="' + T + '"><body/></document>'), { ok: false, why: 'hidden' });
  assert.deepEqual(W.namespaces('<w:document xmlns:w="' + T + '" xmlns:q="&#104;ttp://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'), { ok: false, why: 'hidden' }, 'a character reference spells the namespace too');
  assert.deepEqual(W.namespaces('<w:document xmlns:w="' + T + '" xmlns:x="' + S.toUpperCase() + '"/>'), { ok: false, why: 'hidden' }, 'whatever its case');
  assert.deepEqual(W.namespaces('<?xml version="1.0"?><!DOCTYPE x><w:document/>'), { ok: false, why: 'dtd' });
  assert.deepEqual(W.namespaces('<w:document'), { ok: false, why: 'shape' });
  assert.deepEqual(W.WML, [T, S]);
});

test('wordpages: a relationships part is read as mammoth reads it, and one written any other way than Office\'s is refused', () => {
  const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const rel = (type, target) => '<Relationship Id="r" Type="' + type + '" Target="' + target + '"/>';
  assert.deepEqual(W.relationships('<?xml version="1.0"?><Relationships xmlns="' + NS + '">' + rel('a', 'x.xml') + rel('b', '/y.xml') + '</Relationships>'), [{ type: 'a', target: 'x.xml' }, { type: 'b', target: '/y.xml' }]);
  assert.deepEqual(W.relationships(''), [], 'an absent part has none');
  const refused = (xml, what) => assert.throws(() => W.relationships(xml), (e) => e.why === 'shape', what);
  refused('<p:Relationships xmlns:p="' + NS + '">' + rel('a', 'x') + '</p:Relationships>', 'a prefix');
  refused('<Relationships xmlns="urn:other">' + rel('a', 'x') + '</Relationships>', 'another namespace');
  refused('<Relationships xmlns="' + NS + '"><Relationship xmlns="urn:other" Type="a" Target="x"/></Relationships>', 'a namespace declared below the root');
  refused('<Relationships xmlns="' + NS + '"/><Relationships xmlns="' + NS + '">' + rel('a', 'x') + '</Relationships>', 'a second root');
  refused('<Relationships xmlns="' + NS + '"><Relationship r:Type="a" Target="x"/></Relationships>', 'a prefixed attribute');
  assert.throws(() => W.relationships('<!DOCTYPE x><Relationships/>'), (e) => e.why === 'dtd');
});

test('wordpages: partsOf finds the main document, its styles, numbering, notes and comments as mammoth does — by relationship, else the fixed names', async () => {
  const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const rels = (list) => '<Relationships xmlns="' + NS + '">' + list.map(([t, target]) => '<Relationship Id="r" Type="' + R + t + '" Target="' + target + '"/>').join('') + '</Relationships>';
  const of = (files) => W.partsOf((n) => Object.hasOwn(files, n), async (n) => (Object.hasOwn(files, n) ? files[n] : ''));
  assert.deepEqual(await of({ 'word/document.xml': '' }), { main: 'word/document.xml', styles: 'word/styles.xml', numbering: 'word/numbering.xml', footnotes: 'word/footnotes.xml', endnotes: 'word/endnotes.xml', comments: 'word/comments.xml', app: 'docProps/app.xml' }, 'no relationships: the fixed names');
  const renamed = {
    '_rels/.rels': rels([['officeDocument', 'missing.xml'], ['officeDocument', 'word/document2.xml'], ['extended-properties', 'docProps/app2.xml']]),
    'word/document2.xml': '', 'word/_rels/document2.xml.rels': rels([['styles', 'st.xml'], ['footnotes', '/notes/f.xml'], ['endnotes', '../e.xml'], ['comments', 'nowhere.xml']]),
    'word/st.xml': '', 'notes/f.xml': '', 'docProps/app2.xml': '',
  };
  assert.deepEqual(await of(renamed), { main: 'word/document2.xml', styles: 'word/st.xml', numbering: 'word/numbering.xml', footnotes: 'notes/f.xml', endnotes: 'word/endnotes.xml', comments: 'word/comments.xml', app: 'docProps/app2.xml' },
    'the first target the archive holds; a leading / from the root; a target it does not hold (a .. is joined, never resolved, as mammoth joins it) falls back');
  await assert.rejects(of({ '_rels/.rels': rels([['officeDocument', 'gone.xml']]) }), (e) => e.why === 'shape', 'no main document');
  await assert.rejects(of({ '_rels/.rels': '<x:Relationships xmlns:x="' + NS + '"/>', 'word/document.xml': '' }), (e) => e.why === 'shape');
});

const T_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const relsXml = (list) => OOXML + '<Relationships xmlns="' + RELS + '">' + list.map(([id, t, target]) => '<Relationship Id="' + id + '" Type="' + OFFICE_REL + t + '" Target="' + target + '"/>').join('') + '</Relationships>';
const SECRET_P = '<w:p><w:r><w:t>Visible</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>SECRETHIDDEN</w:t></w:r></w:p>';

test('the document worker: the main document under another name, its styles and notes found by relationship, are stripped as mammoth reads them; a hiding style in a renamed styles part and w:docDefaults reach no drawing', async () => {
  const parts = wordParts({ body: SECRET_P });
  parts['word/document2.xml'] = parts['word/document.xml'];
  delete parts['word/document.xml'];
  delete parts['word/_rels/document.xml.rels'];
  parts['_rels/.rels'] = relsXml([['rId1', 'officeDocument', 'word/document2.xml']]);
  parts['word/_rels/document2.xml.rels'] = relsXml([['rId1', 'styles', 'look.xml'], ['rId2', 'footnotes', 'notes.xml']]);
  parts['word/look.xml'] = OOXML + '<w:styles ' + W_NS + '><w:style w:type="paragraph" w:styleId="Quiet"><w:rPr><w:vanish/></w:rPr></w:style></w:styles>';
  parts['word/notes.xml'] = OOXML + '<w:footnotes ' + W_NS + '><w:footnote w:id="1"><w:p><w:r><w:t>Note </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>FOOTHIDDEN</w:t></w:r></w:p></w:footnote></w:footnotes>';
  parts['word/document2.xml'] = parts['word/document2.xml'].replace('</w:body>', p('STYLEHIDDEN', { pPr: '<w:pStyle w:val="Quiet"/>' }) + '</w:body>');
  const r = await docWorker('word', officeZip(parts));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.html, /Visible/);
  for (const word of ['SECRETHIDDEN', 'STYLEHIDDEN', 'FOOTHIDDEN']) assert.ok(!r.html.includes(word) && !JSON.stringify(r.scan).includes(word), word + ' is not drawn');
  // The document's defaults hide every run that does not show itself again.
  const defaults = await docWorker('word', officeZip(wordParts({ body: p('DEFAULTHIDDEN') + p('Shown', { rPr: '<w:vanish w:val="0"/>' }), styles: '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>' })));
  assert.equal(defaults.ok, true);
  assert.ok(!defaults.html.includes('DEFAULTHIDDEN') && defaults.html.includes('Shown'));
  // A hidden table style, through the worker.
  const tbl = await docWorker('word', officeZip(wordParts({ body: p('Before') + TABLE('HiddenGrid', 'SECRETTABLE'), styles: '<w:style w:type="table" w:styleId="HiddenGrid"><w:rPr><w:vanish/></w:rPr></w:style>' })));
  assert.equal(tbl.ok, true);
  assert.ok(!tbl.html.includes('SECRETTABLE') && tbl.html.includes('Before'));
});

test('the document worker: WordprocessingML under another prefix or as the default namespace, and a hidden mark it cannot resolve, refuse the file', async () => {
  const prefixed = wordParts({ body: '<w:p><w:r><w:t>Visible</w:t></w:r><x:r xmlns:x="' + T_NS + '"><x:rPr><x:vanish/></x:rPr><x:t>SECRETPREFIX</x:t></x:r></w:p>' });
  assert.deepEqual(await docWorker('word', officeZip(prefixed)), { ok: false, why: 'hidden' });
  const plainNs = wordParts({ body: '' });
  plainNs['word/document.xml'] = OOXML + '<document xmlns="' + T_NS + '"><body><p><r><t>Visible</t></r><r><rPr><vanish/></rPr><t>SECRETDEFAULTNS</t></r></p></body></document>';
  assert.deepEqual(await docWorker('word', officeZip(plainNs)), { ok: false, why: 'hidden' });
  const styled = wordParts({ body: SECRET_P, styles: '<w:style w:type="paragraph" w:styleId="X"/>' });
  styled['word/styles.xml'] = OOXML + '<s:styles xmlns:s="' + T_NS + '"><s:docDefaults><s:rPrDefault><s:rPr><s:vanish/></s:rPr></s:rPrDefault></s:docDefaults></s:styles>';
  assert.deepEqual(await docWorker('word', officeZip(styled)), { ok: false, why: 'hidden' }, 'the styles part is held to it too');
  const banded = wordParts({ body: TABLE('Banded', 'X'), styles: '<w:style w:type="table" w:styleId="Banded"><w:tblStylePr w:type="band1Horz"><w:rPr><w:vanish/></w:rPr></w:tblStylePr></w:style>' });
  assert.deepEqual(await docWorker('word', officeZip(banded)), { ok: false, why: 'hidden' });
  const oddRels = wordParts({ body: p('A') });
  oddRels['_rels/.rels'] = OOXML + '<r:Relationships xmlns:r="' + RELS + '"/>';
  assert.deepEqual(await docWorker('word', officeZip(oddRels)), { ok: false, why: 'shape' });
});

test('the document worker: an entry named one way in the directory and another in its local header, a name that is not canonical, two names that differ only in case, a folder with data, or a Unicode Path name refuse the file', async () => {
  const base = () => wordParts({ body: SECRET_P });
  // JSZip (mammoth's) names an entry by its local header: a body under another name there is a part the check never read.
  const swapped = base();
  swapped['word/other.xml'] = swapped['word/document.xml'];
  swapped['word/document.xml'] = OOXML + '<w:document ' + W_NS + '><w:body>' + p('Decoy') + '</w:body></w:document>';
  assert.deepEqual(await docWorker('word', officeZip(swapped, { localNames: { 'word/other.xml': 'word/doc.xml' } })), { ok: false, why: 'packed' });
  for (const odd of ['word/./document.xml', 'word//document.xml', 'x/../word/document.xml', '/word/document.xml', 'word\\document.xml', 'word/döcument.xml']) {
    const parts = base();
    parts[odd] = parts['word/document.xml'];
    assert.deepEqual(await docWorker('word', officeZip(parts)), { ok: false, why: 'packed' }, JSON.stringify(odd));
  }
  const twice = base();
  twice['Word/Document.xml'] = twice['word/document.xml'];
  assert.deepEqual(await docWorker('word', officeZip(twice)), { ok: false, why: 'packed' }, 'a name twice, whatever its case');
  const dir = base();
  dir['word/media'] = 'bytes in a folder';
  assert.deepEqual(await docWorker('word', officeZip(dir, { external: { 'word/media': 0x10 } })), { ok: false, why: 'packed' }, 'a folder that holds data');
  const empty = base();
  empty['word/media/'] = '';
  assert.equal((await docWorker('word', officeZip(empty))).ok, true, 'an empty folder entry is passed over');
  const unicode = base();
  const field = Buffer.alloc(5 + 17); field.writeUInt16LE(0x7075, 0); field.writeUInt16LE(18, 2); field[4] = 1;
  assert.deepEqual(await docWorker('word', officeZip(unicode, { extras: { 'word/document.xml': field.subarray(0, 22) } })), { ok: false, why: 'packed' });
});

test('the document worker: a declaration is found in any entry, whatever its name or encoding; a device without DecompressionStream is said to be one', async () => {
  const named = wordParts({ body: p('A') });
  named['word/media/item.bin'] = '<?xml version="1.0"?><!ENTITY x "y"><r/>';
  assert.deepEqual(await docWorker('word', officeZip(named)), { ok: false, why: 'dtd' }, 'a part named like no XML');
  const wide = wordParts({ body: p('A') });
  wide['customXml/item1.xml'] = Buffer.from('﻿<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE r [<!ENTITY a "b">]><r/>', 'utf16le');
  assert.deepEqual(await docWorker('word', officeZip(wide)), { ok: false, why: 'dtd' }, 'UTF-16');
  assert.deepEqual(await docWorker('word', officeZip(wordParts({ body: p('A') })), {}, { without: ['DecompressionStream'] }), { ok: false, why: 'device' });
  const storedOnly = Object.keys(wordParts({ body: p('A') }));
  assert.equal((await docWorker('word', officeZip(wordParts({ body: p('A') }), { stored: storedOnly }), {}, { without: ['DecompressionStream'] })).ok, true, 'an archive with nothing deflated needs no stream');
});

test('the document worker: a picture in a Word file over the pixel bound, or one whose size cannot be read, leaves without its bytes and says why', async () => {
  const pngHead = (w, h) => { const b = Buffer.from(pngOf(1, 1)); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const body = '<w:p>' + wordPicture('rId10', 'Huge') + wordPicture('rId11', 'Broken') + wordPicture('rId12', 'Fine') + '</w:p>';
  const r = await docWorker('word', officeZip(wordParts({ body, media: { 'huge.png': pngHead(8000, 6000), 'broken.png': Buffer.from('not a picture'), 'fine.png': pngOf(4, 3) } })));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.pictures.map((x) => [x.n, !!x.bytes, x.why]), [[1, false, 'pixels'], [2, false, 'unreadable'], [3, true, '']]);
  assert.ok(readSource(path.join(ROOT, 'public', 'docworker.js')).includes('\nconst PIXELS = 40000000;\n'));
});

test('wordpages: a style id written twice, or two default styles of a type, cannot hide a run unseen: the first refuses a file whose runs it reaches, the second hides where either hides', () => {
  const twice = W.styles(styles('<w:style w:type="paragraph" w:styleId="Body"/><w:style w:type="paragraph" w:styleId="Body"><w:rPr><w:vanish/></w:rPr></w:style>'));
  assert.deepEqual(W.stripHidden(doc(p('X', { pPr: '<w:pStyle w:val="Body"/>' })), twice), { ok: false, why: 'hidden' });
  assert.equal(W.stripHidden(doc(p('Y')), twice).ok, true, 'a run it does not reach is read');
  const two = W.styles(styles('<w:style w:type="paragraph" w:default="1" w:styleId="A"/><w:style w:type="paragraph" w:default="1" w:styleId="B"><w:rPr><w:vanish/></w:rPr></w:style>'));
  assert.equal(W.stripHidden(doc(p('TWODEFAULTS')), two).removed, 1);
});
