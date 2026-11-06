'use strict';
// The readers, pure (public/docmodel.mjs), and the document worker's spreadsheets and slides (public/docworker.js, run
// as a browser runs a worker): text decoded, CSV as RFC 4180 has it, Markdown's blocks with their lines, tables placed on
// their grid, HTML walked into plain data with what a renderer would not show left out, a deck's outline without its
// hidden shapes, and what each seat draws — the research seat sees hidden rows, columns, sheets and slides marked, every
// other seat never, and the AI's text never. Every reader is bounded and says where it cut. parseInert's own parse needs
// a browser's: the smoke holds it there.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, readSource, officeZip, docWorker, pngOf, OOXML, deckParts, deckShape: sp, deckPicture: pic, deckSlide: slide, workbookParts: bookParts, sheetParts, relsOf } = require('./helpers');

let M;
test.before(async () => { M = await import('../public/docmodel.mjs'); });

// ---------------------------------------------------------------- text and CSV
test('decodeText: a byte-order mark decides and is dropped; UTF-8 where every byte is, windows-1252 otherwise', () => {
  assert.deepEqual(M.decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Café')])), { text: 'Café', encoding: 'utf-8' });
  assert.deepEqual(M.decodeText(Buffer.from([0xff, 0xfe, ...Buffer.from('Hi', 'utf16le')])), { text: 'Hi', encoding: 'utf-16le' });
  assert.deepEqual(M.decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), { text: 'Hi', encoding: 'utf-16be' });
  assert.deepEqual(M.decodeText(Buffer.from('Ünïcode', 'utf8')), { text: 'Ünïcode', encoding: 'utf-8' });
  // Excel's own "CSV" on Windows: windows-1252, where 0x80 is the euro sign and 0xe9 é.
  assert.deepEqual(M.decodeText(Buffer.from([0x80, 0x32, 0x30, 0x20, 0x63, 0x61, 0x66, 0xe9])), { text: '€20 café', encoding: 'windows-1252' });
});

test('parseCsv: RFC 4180 — quoted fields hold the delimiter, line ends and "" for a quote; CR LF, LF and CR end a line', () => {
  assert.deepEqual(M.parseCsv('a,b,c\r\n1,"two, three","say ""hi"""\r\n"multi\nline",,x\n').rows, [['a', 'b', 'c'], ['1', 'two, three', 'say "hi"'], ['multi\nline', '', 'x']]);
  assert.deepEqual(M.parseCsv('a,b\rc,d').rows, [['a', 'b'], ['c', 'd']], 'a bare CR ends a line');
  assert.deepEqual(M.parseCsv('a,b,\n').rows, [['a', 'b', '']], 'a last empty field is kept');
  assert.deepEqual(M.parseCsv('x,a"b"c\n').rows, [['x', 'a"b"c']], 'a quote inside an unquoted field is text');
  assert.deepEqual(M.parseCsv('').rows, []);
  // The BOM is the decoder's to drop: a CSV saved by Excel as UTF-8 reads its first header whole.
  assert.equal(M.parseCsv(M.decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Name,Cost\n')])).text).rows[0][0], 'Name');
});

test('parseCsv: the delimiter is sniffed — , ; or tab, whichever the first lines agree on outside quotes', () => {
  assert.equal(M.sniffDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(M.sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(M.sniffDelimiter('a,b\n"1;2;3",4\n'), ',', 'a ; inside quotes is not counted');
  assert.equal(M.sniffDelimiter('one column\nonly\n'), ',', 'none found: a comma');
  assert.deepEqual(M.parseCsv('Name;Cost\n"Hall; main";1,5\n'), { rows: [['Name', 'Cost'], ['Hall; main', '1,5']], delimiter: ';', truncated: false, cutCols: false });
  // Only the first lines are read for it, within the first 64 KiB: a file of one enormous line costs no more.
  const t0 = Date.now();
  assert.equal(M.sniffDelimiter(';'.repeat(5000000)), ';');
  assert.ok(Date.now() - t0 < 1000);
});

test('the readers are bounded and say where they cut: "Showing the first 5,000 rows." and "Showing the first 20,000 lines."', () => {
  const csv = Array.from({ length: 5003 }, (_, i) => 'row' + i + ',x').join('\n');
  const r = M.parseCsv(csv);
  assert.deepEqual([r.rows.length, r.truncated, r.rows[4999][0]], [5000, true, 'row4999']);
  assert.equal(M.parseCsv(Array.from({ length: 5000 }, () => 'a').join('\n')).truncated, false);
  const t = M.textLines(Array.from({ length: 20001 }, (_, i) => 'line ' + i).join('\n'));
  assert.deepEqual([t.lines.length, t.truncated], [20000, true]);
  assert.equal(M.textLines('a\nb\n').lines.length, 2, 'a last line end is no line');
  assert.equal(M.markdownBlocks(Array.from({ length: 20005 }, (_, i) => 'Para ' + i + '\n').join('')).truncated, true);
  assert.deepEqual([M.BOUNDS.rows, M.BOUNDS.lines, M.WORDS.rows, M.WORDS.lines], [5000, 20000, 'Showing the first 5,000 rows.', 'Showing the first 20,000 lines.']);
  // The worker reads one row more than it draws, to know it cut: the same numbers, its columns and cells too.
  const worker = readSource(path.join(ROOT, 'public', 'docworker.js'));
  assert.ok(worker.includes('\nconst ROWS = ' + M.BOUNDS.rows + ';\n'), 'the worker\'s ROWS is BOUNDS.rows');
  assert.ok(worker.includes('\nconst COLS = ' + M.BOUNDS.cols + ';\n') && worker.includes('\nconst CELLS = ' + M.BOUNDS.cells + ';\n') && worker.includes('\nconst PIXELS = ' + M.BOUNDS.pixels + ';\n'), 'and its COLS, CELLS and PIXELS');
});

test('a grid\'s width and cells are bounded too: one line of commas, or a wide file, draws at most 256 columns and 100,000 cells, and says so', () => {
  assert.deepEqual([M.BOUNDS.cols, M.BOUNDS.cells, M.WORDS.cols], [256, 100000, 'Showing the first 256 columns.']);
  // Measured: 5 MB of commas parsed to one row of 5,000,001 fields; it is one row of 256 now.
  const long = M.parseCsv(','.repeat(5000000));
  assert.deepEqual([long.rows.length, long.rows[0].length, long.cutCols, long.truncated], [1, 256, true, false]);
  // 300 columns wide: 256 kept, and the rows cut to the 100,000 cells they fit in (390 rows of 256).
  const wide = M.parseCsv(('x,'.repeat(299) + 'last\n').repeat(1000));
  assert.deepEqual([wide.rows.length, wide.rows[0].length, wide.cutCols, wide.truncated, wide.rows.length * wide.rows[0].length <= M.BOUNDS.cells], [390, 256, true, true, true]);
  assert.equal(M.rowsWords(390), 'Showing the first 390 rows.');
  assert.equal(M.rowsWords(5000), M.WORDS.rows);
  // A quoted field past the columns kept is read past whole: its line end is the CSV's, not the field's.
  const quoted = M.parseCsv('a,b,"c\nstill c"\nd,e,f\n', { maxCols: 2 });
  assert.deepEqual([quoted.rows, quoted.cutCols], [[['a', 'b'], ['d', 'e']], true]);
  // Exactly as wide as the bound is not cut.
  assert.equal(M.parseCsv('a,b\n', { maxCols: 2 }).cutCols, false);
});

// ---------------------------------------------------------------- Markdown
test('markdownBlocks: ATX headings, paragraphs, items with their kind and level, quotes, fenced code and pipe tables, each with its lines', () => {
  const md = [
    '# Board pack', '', 'First paragraph', 'runs on.', '', '- one', '  - nested', '1. first', '', '> quoted', '> more', '',
    '```', 'code <!-- kept -->', '```', '', '| Item | Cost |', '|:-----|-----:|', '| Capex \\| plant | 4 |', '| Opex | 2 |', '', '---', 'Last **bold** kept as typed',
  ].join('\n');
  const { blocks } = M.markdownBlocks(md);
  assert.deepEqual(blocks.map((b) => [b.kind, b.level || 0, b.list || '', b.text, b.at.line, b.at.to]), [
    ['h', 1, '', 'Board pack', 1, 1],
    ['p', 0, '', 'First paragraph runs on.', 3, 4],
    ['li', 1, 'ul', 'one', 6, 6],
    ['li', 2, 'ul', 'nested', 7, 7],
    ['li', 1, 'ol', 'first', 8, 8],
    ['quote', 0, '', 'quoted more', 10, 11],
    ['code', 0, '', 'code <!-- kept -->', 13, 15],
    ['table', 0, '', 'Item\tCost\nCapex | plant\t4\nOpex\t2', 17, 20],
    ['p', 0, '', 'Last **bold** kept as typed', 23, 23],
  ]);
  const table = blocks.find((b) => b.kind === 'table');
  assert.deepEqual(table.rows.map((r) => r.map((c) => [c.text, c.c])), [[['Item', 0], ['Cost', 1]], [['Capex | plant', 0], ['4', 1]], [['Opex', 0], ['2', 1]]]);
  assert.equal(table.head, 1);
});

test('markdownBlocks: an HTML comment is left out, over lines too; raw HTML is read by `inert`, and left out where none is given', () => {
  const md = 'Visible <!-- secret note --> text\n\n<!--\nhidden\nblock\n-->\nAfter\n\n<div>\n<span hidden>SECRET</span> shown\n</div>\n\nInline <b>bold</b> here';
  const handed = [];
  const inert = (html) => { handed.push(html); return html.replace(/<span hidden>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ''); };
  const { blocks } = M.markdownBlocks(md, { inert });
  const text = blocks.map((b) => b.text).join(' | ');
  assert.equal(text, 'Visible text | After | shown | Inline bold here');
  assert.ok(!/secret|hidden|block/.test(text), 'no comment\'s words');
  assert.deepEqual(handed, ['<div>\n<span hidden>SECRET</span> shown\n</div>', 'Inline <b>bold</b> here'], 'only text with a tag in it is handed over');
  // No reader for HTML: what it would hide cannot be told, so it is left out.
  assert.equal(M.markdownBlocks(md).blocks.map((b) => b.text).join(' | '), 'Visible text | After');
});

// ---------------------------------------------------------------- tables
test('occupancy: a cell spanning rows and columns takes its place on the grid, so column C is the grid\'s column C', () => {
  const g = M.occupancy([
    [{ text: 'A1:A2', rowspan: 2 }, { text: 'B1:C1', colspan: 2 }, { text: 'D1' }],
    [{ text: 'B2' }, { text: 'C2' }, { text: 'D2' }],
  ]);
  assert.equal(g.width, 4);
  assert.deepEqual(g.rows.map((r) => r.map((c) => c.text + '@' + M.columnName(c.c))), [['A1:A2@A', 'B1:C1@B', 'D1@D'], ['B2@B', 'C2@C', 'D2@D']]);
  assert.deepEqual([M.columnName(0), M.columnName(25), M.columnName(26), M.columnName(701), M.columnName(702)], ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.equal(g.cut, false);
});

test('occupancy: a table is cut to its first 256 columns and the rows within 100,000 cells, a span held inside the cut, and says it was cut', () => {
  const span = M.occupancy([[{ text: 'wide', colspan: 5000 }], [{ text: 'a' }, { text: 'b' }]]);
  assert.deepEqual([span.width, span.cut, span.rows[0][0].colspan], [256, false, 256], 'a span past the columns is held to them');
  const wide = M.occupancy([Array.from({ length: 300 }, (_, i) => ({ text: 'c' + i }))]);
  assert.deepEqual([wide.width, wide.cut, wide.rows[0].length, wide.rows[0][255].text], [256, true, 256, 'c255']);
  const tall = M.occupancy(Array.from({ length: 10 }, () => [{ text: 'x', rowspan: 9 }, { text: 'y' }]), { maxCells: 5 });
  assert.deepEqual([tall.rows.length, tall.cut, tall.rows[0][0].rowspan], [2, true, 2], 'rows past the cells left out, and a row span ending at the cut');
  // A Markdown pipe table and an HTML table carry the cut for the drawing to say.
  const md = M.markdownBlocks('|' + Array.from({ length: 300 }, (_, i) => 'h' + i).join('|') + '|\n|' + '-|'.repeat(300) + '\n');
  assert.equal(md.blocks[0].cut, true);
  assert.equal(M.tableWords(2, 256), 'Showing the first 2 rows and 256 columns of this table.');
});

// ---------------------------------------------------------------- HTML, walked into plain data
/** A parsed tree as a browser's template gives it, for the walk: elements with their attributes and style, and text. */
const el = (tag, attrs, ...kids) => {
  const a = attrs || {};
  const style = { display: /display\s*:\s*none/i.test(a.style || '') ? 'none' : '', visibility: (/visibility\s*:\s*(\w+)/i.exec(a.style || '') || [])[1] || '' };
  return { nodeType: 1, tagName: tag.toUpperCase(), style, childNodes: kids.map((k) => (typeof k === 'string' ? { nodeType: 3, nodeValue: k } : k)), getAttribute: (n) => (Object.hasOwn(a, n) ? a[n] : null), hasAttribute: (n) => Object.hasOwn(a, n) };
};
const fragment = (...kids) => ({ nodeType: 11, childNodes: kids });

test('inertBlocks: a parsed tree walked into plain data — blocks, never nodes — with style, script, noscript, template and hidden elements left out', () => {
  const tree = fragment(
    el('style', null, 'p { color: red }'), el('script', null, 'alert(1)'), el('noscript', null, 'NOSCRIPT'), el('template', null, 'TEMPLATE'),
    el('meta', { 'http-equiv': 'refresh', content: '0;url=https://example.invalid/' }),
    el('h2', null, 'Agenda ', el('em', null, 'today')),
    el('p', null, 'Item one ', el('span', { hidden: '' }, 'HIDDENATTR'), el('span', { style: 'display:none' }, 'DISPLAYNONE'), el('b', { style: 'visibility: hidden' }, 'VISHIDDEN'), el('a', { href: 'https://example.invalid/' }, 'a link'), el('br'), 'line two'),
    el('ul', null, el('li', null, 'first', el('ul', null, el('li', null, 'nested'))), el('li', null, 'second')),
    el('ol', null, el('li', null, 'numbered')),
    el('blockquote', null, el('p', null, 'quoted')),
    el('pre', null, 'code'),
    el('table', null, el('tbody', null, el('tr', null, el('td', { colspan: '2' }, 'wide'), el('td', null, 'C')), el('tr', { hidden: '' }, el('td', null, 'HIDDENROW')))),
    el('p', null, el('img', { src: 'agm-img:1', alt: 'chart' }), el('img', { src: 'https://example.invalid/x.png', alt: 'remote' }), el('img', { src: 'blob:x', alt: 'blob' })),
    el('div', null, el('div', null, 'nested div')),
  );
  const { blocks } = M.inertBlocks(tree);
  assert.deepEqual(structuredClone(blocks), blocks, 'plain data, cloned whole');
  assert.deepEqual(blocks.map((b) => [b.kind, b.text, b.level || 0, b.list || '']), [
    ['h', 'Agenda today', 2, ''],
    ['p', 'Item one a link line two', 0, ''],
    ['li', 'first', 1, 'ul'],
    ['li', 'nested', 2, 'ul'],
    ['li', 'second', 1, 'ul'],
    ['li', 'numbered', 1, 'ol'],
    ['quote', 'quoted', 0, ''],
    ['code', 'code', 0, ''],
    ['table', 'wide\tC', 0, ''],
    ['img', '', 0, ''],
    ['p', 'nested div', 0, ''],
  ]);
  const all = JSON.stringify(blocks);
  for (const gone of ['NOSCRIPT', 'TEMPLATE', 'alert', 'color', 'HIDDENATTR', 'DISPLAYNONE', 'VISHIDDEN', 'HIDDENROW', 'refresh', 'example.invalid', 'blob:']) assert.ok(!all.includes(gone), gone + ' is left out');
  assert.deepEqual(blocks.find((b) => b.kind === 'img'), { kind: 'img', text: '', src: 'agm-img:1', alt: 'chart', at: { block: 10 } });
  assert.deepEqual(blocks.find((b) => b.kind === 'table').rows.map((r) => r.map((c) => [c.text, c.c, c.colspan])), [[['wide', 0, 2], ['C', 2, 1]]]);
});

// ---------------------------------------------------------------- XML and the deck's outline
test('xmlTree: a part read into a tree of elements and text; a document type or entity declaration, or a tag left open, is refused', () => {
  const t = M.xmlTree('<?xml version="1.0"?><!-- c --><a:x k="1 &amp; 2"><a:y>Tom &lt;&#38;&#x26;&gt; Jerry</a:y><z/><![CDATA[<raw>]]></a:x>');
  assert.deepEqual(JSON.parse(JSON.stringify(t)), { name: '#root', attrs: {}, kids: [{ name: 'a:x', attrs: { k: '1 & 2' }, kids: [{ name: 'a:y', attrs: {}, kids: ['Tom <&&> Jerry'] }, { name: 'z', attrs: {}, kids: [] }, '<raw>'] }] });
  assert.throws(() => M.xmlTree('<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY a "b">]><p:sld/>'), (e) => e.why === 'dtd');
  assert.throws(() => M.xmlTree('<a><b></a>'), (e) => e.why === 'shape');
  assert.throws(() => M.xmlTree('<a>'), (e) => e.why === 'shape');
  assert.throws(() => M.pptxOutline({ 'ppt/presentation.xml': '<!ENTITY x "y">' }), (e) => e.why === 'dtd');
});

test('pptxOutline: slides in the presentation\'s order — a title, items by level, paragraphs, tables and pictures; hidden shapes, pictures and groups skipped with all they hold; notes never read; a show="0" slide marked', () => {
  const tableFrame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>Wide</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>C</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const group = (inner, hidden) => '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"' + (hidden ? ' hidden="1"' : '') + '/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + inner + '</p:grpSp>';
  const parts = deckParts([
    { xml: slide(sp('Q3 results', { ph: 'title' }) + sp(['Revenue up', 'Costs flat'], { ph: 'body' }) + sp('Detail', { ph: 'body', lvl: 1 }) + sp('HIDDENSHAPE', { hidden: true }) + pic('rId1') + pic('rId1', { hidden: true }) + group(sp('in a group'), false) + group(sp('HIDDENGROUP') + pic('rId1'), true) + sp('Footer', { ph: 'ftr' }) + sp('A text box')), rels: [['rId1', 'image', '../media/chart.png']] },
    { xml: slide(sp('Backup', { ph: 'title' }) + sp('Only for questions'), '0') },
    { xml: slide(tableFrame) },
  ]);
  const out = M.pptxOutline(parts);
  assert.deepEqual(out.slides.map((s) => [s.n, s.hidden, s.hiddenShapes || 0]), [[1, false, 3], [2, true, 0], [3, false, 0]], 'a slide counts the hidden shapes, pictures and groups it skipped');
  assert.ok(!Object.hasOwn(out.slides[2], 'hiddenShapes'), 'a slide with none says nothing of them');
  assert.deepEqual(out.slides[0].blocks.map((b) => [b.kind, b.text, b.level || 0, b.src || '']), [
    ['h', 'Q3 results', 1, ''], ['li', 'Revenue up', 1, ''], ['li', 'Costs flat', 1, ''], ['li', 'Detail', 2, ''], ['img', '', 0, 'ppt/media/chart.png'], ['p', 'in a group', 0, ''], ['p', 'A text box', 0, ''],
  ]);
  const all = JSON.stringify(out);
  for (const gone of ['HIDDENSHAPE', 'HIDDENGROUP', 'PRESENTERNOTE', 'Footer']) assert.ok(!all.includes(gone), gone + ' is left out');
  assert.equal(out.slides[0].blocks.filter((b) => b.kind === 'img').length, 1, 'the hidden picture is not read');
  assert.deepEqual(out.slides[2].blocks[0].rows.map((r) => r.map((c) => [c.text, c.c, c.colspan])), [[['Wide', 0, 2], ['C', 2, 1]]]);
  // The Board draws no hidden slide, and says so; the research seat draws it, marked.
  assert.deepEqual(M.planSlides(out, 'board'), { slides: [out.slides[0], out.slides[2]], notShown: '1 hidden slide not shown' });
  assert.deepEqual(M.planSlides(out, 'observer').slides.map((s) => s.n), [1, 3]);
  assert.deepEqual(M.planSlides(out, 'research'), { slides: out.slides, notShown: '' });
  const text = M.documentText({ kind: 'deck', slides: out.slides });
  assert.ok(text.includes('Q3 results') && !text.includes('Only for questions'), 'the AI\'s text leaves the hidden slide out');
});

test('hiddenPartsOf: a file with a hidden sheet, row, column, slide or shape, or Word\'s hidden text, is one the page never shows with Download ticked', () => {
  const shapeOnly = M.pptxOutline(deckParts([{ xml: slide(sp('Agenda', { ph: 'title' }) + sp('SALARIES', { hidden: true })) }]));
  assert.deepEqual(shapeOnly.slides.map((s) => [s.hidden, s.hiddenShapes]), [[false, 1]], 'a deck with a hidden shape and no hidden slide');
  const plain = M.pptxOutline(deckParts([{ xml: slide(sp('Agenda', { ph: 'title' })) }]));
  const sheet = (o) => ({ name: 'S', rows: [['a']], ...o });
  assert.deepEqual([
    M.hiddenPartsOf({ kind: 'deck', slides: shapeOnly.slides }), M.hiddenPartsOf({ kind: 'deck', slides: [{ n: 1, hidden: true, blocks: [] }] }), M.hiddenPartsOf({ kind: 'deck', slides: plain.slides }),
    M.hiddenPartsOf({ kind: 'word', blocks: [], hidden: 2 }), M.hiddenPartsOf({ kind: 'word', blocks: [], hidden: 0 }),
    M.hiddenPartsOf({ kind: 'book', sheets: [sheet({ hidden: 2 })] }), M.hiddenPartsOf({ kind: 'book', sheets: [sheet({ hiddenRows: [3] })] }), M.hiddenPartsOf({ kind: 'book', sheets: [sheet({ hiddenCols: [0] })] }), M.hiddenPartsOf({ kind: 'book', sheets: [sheet({ hidden: 0, hiddenRows: [], hiddenCols: [] })] }),
    M.hiddenPartsOf({ kind: 'md', blocks: [] }), M.hiddenPartsOf({ kind: 'text', blocks: [] }), M.hiddenPartsOf(null),
  ], [true, true, false, true, false, true, true, true, false, false, false, false]);
});

test('the document worker: a deck\'s slides, their relationships and the pictures they name come back as text and bytes; its notes are never read out', async () => {
  const parts = deckParts([{ xml: slide(sp('Title', { ph: 'title' }) + pic('rId1')), rels: [['rId1', 'image', '../media/chart.png'], ['rId2', 'image', 'https://example.invalid/x.png']] }], { 'chart.png': pngOf(2, 2), 'unused.png': pngOf(1, 1) });
  const r = await docWorker('deck', officeZip(parts));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.parts).sort(), ['ppt/_rels/presentation.xml.rels', 'ppt/presentation.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slides/slide1.xml']);
  assert.deepEqual(r.pictures.map((p) => [p.name, p.type, Buffer.compare(p.bytes, pngOf(2, 2))]), [['ppt/media/chart.png', 'image/png', 0]]);
  assert.deepEqual(M.pptxOutline(r.parts).slides[0].blocks.map((b) => b.kind + ':' + (b.text || b.src)), ['h:Title', 'img:ppt/media/chart.png']);
});

// ---------------------------------------------------------------- spreadsheets, and what each seat draws
test('the document worker: a workbook\'s sheets, with hidden ("very hidden" alike) sheets, rows and columns flagged as data and a formula with no saved value marked, never computed', async () => {
  const r = await docWorker('sheet', officeZip(bookParts()), { ext: 'xlsx' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [budget, salaries, old] = r.book.sheets;
  assert.deepEqual([budget.name, budget.hidden, salaries.hidden, old.hidden], ['Budget', 0, 2, 1]);
  assert.deepEqual(budget.rows, [['Item', 'SECRETCOL', 'Cost', ''], ['SECRETROW', '', '', ''], ['Total', '', '', '2']]);
  assert.deepEqual([budget.hiddenRows, budget.hiddenCols, budget.noValue, budget.truncated], [[1], [1], [[2, 2]], false]);
  // A file with a declared document type is refused before SheetJS sees it.
  const dtd = bookParts();
  dtd['xl/worksheets/sheet3.xml'] = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "y">]>' + dtd['xl/worksheets/sheet3.xml'].slice(OOXML.length);
  assert.deepEqual(await docWorker('sheet', officeZip(dtd), { ext: 'xlsx' }), { ok: false, why: 'dtd' });
  // An archive the check refuses is not opened.
  const macros = bookParts();
  macros['xl/vbaProject.bin'] = Buffer.from('macros');
  assert.deepEqual(await docWorker('sheet', officeZip(macros), { ext: 'xlsx' }), { ok: false, why: 'packed' });
});

test('the document worker: a formula saved with no value is marked whatever its type — never FALSE, "undefined" or a blank — while a saved FALSE, "" and error stay as saved', async () => {
  const parts = bookParts();
  parts['xl/worksheets/sheet1.xml'] = OOXML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">'
    + '<c r="A1" t="str"><f>B9</f></c><c r="B1" t="b"><f>TRUE()</f></c><c r="C1" t="e"><f>1/0</f></c><c r="D1"><f>1+1</f><v></v></c><c r="E1"><f t="shared" ref="E1:E2" si="0">1+1</f></c>'
    + '<c r="F1" t="str"><f>""</f><v></v></c><c r="G1" t="b"><f>FALSE()</f><v>0</v></c><c r="H1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="I1" t="e"/><c r="J1" s="2" t="b"><f>A1&amp;"&lt;"</f></c></row>'
    + '<row r="2"><c r="E2"><f t="shared" si="0"/><v>3</v></c></row></sheetData></worksheet>';
  const r = await docWorker('sheet', officeZip(parts), { ext: 'xlsx' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = r.book.sheets[0];
  assert.deepEqual(s.noValue, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 9]]);
  assert.deepEqual(s.rows[0].slice(5, 9), ['', 'FALSE', '#DIV/0!', ''], 'a saved "" and FALSE and error as saved; an error cell with neither drawn blank, never "undefined"');
  assert.equal(s.rows[1][4], '3', 'a shared formula\'s other cell keeps its saved value');
  assert.ok(!JSON.stringify(s.rows).includes('undefined'));
});

test('the document worker: a sheet is read to its first 256 columns and as many rows as 100,000 cells allow, rows counted from the sheet\'s first, each cut said', async () => {
  // Measured: 2,316 bytes with cells at A1 and XFD1000 read as 1,000 × 16,384 = 16,384,000 cells (362 MB in Node).
  const wide = bookParts();
  wide['xl/worksheets/sheet1.xml'] = OOXML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1000"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row><row r="1000"><c r="XFD1000" t="inlineStr"><is><t>last</t></is></c></row></sheetData></worksheet>';
  const w = (await docWorker('sheet', officeZip(wide), { ext: 'xlsx' })).book.sheets[0];
  assert.deepEqual([w.rows.length, w.rows[0].length, w.rows.length * w.rows[0].length <= 100000, w.cutCols, w.truncated, w.shown, w.rows[0][0]], [390, 256, true, true, true, 390, 'first']);
  // A sheet whose data begins at row 11 is read to its row 5,000 and said cut.
  const low = bookParts();
  low['xl/worksheets/sheet1.xml'] = OOXML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + Array.from({ length: 5003 }, (_, i) => '<row r="' + (i + 11) + '"><c r="A' + (i + 11) + '" t="inlineStr"><is><t>r' + i + '</t></is></c></row>').join('') + '</sheetData></worksheet>';
  const l = (await docWorker('sheet', officeZip(low), { ext: 'xlsx' })).book.sheets[0];
  assert.deepEqual([l.rows.length, l.truncated, l.shown, l.origin.r, l.rows[0][0], l.rows[l.rows.length - 1][0]], [4990, true, 5000, 10, 'r0', 'r4989']);
  // The same, with its dimension saying how far it runs.
  low['xl/worksheets/sheet1.xml'] = low['xl/worksheets/sheet1.xml'].replace('<sheetData>', '<dimension ref="A11:A5013"/><sheetData>');
  assert.equal((await docWorker('sheet', officeZip(low), { ext: 'xlsx' })).book.sheets[0].truncated, true);
});

test('the document worker: a sheet\'s frozen panes, its first view\'s, read from the part its relationship names and counted from the first row read; a split that is not frozen is none', async () => {
  const frozen = await docWorker('sheet', officeZip(sheetParts([['Results for Q3'], ['', 'Q1', 'Q2'], ['Revenue', '1', '2']], 'Results', { frozen: { rows: 2, cols: 1 }, hiddenSheet: [['x']] })), { ext: 'xlsx' });
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.deepEqual(frozen.book.sheets.map((x) => [x.name, x.frozen]), [['Results', { rows: 2, cols: 1 }], ['Hidden', undefined]]);
  // The sheets found by the workbook's relationships, as SheetJS finds them, never by their parts' names: the first sheet
  // is the second part here, named from the root; and a sheet whose data begins at row 3 counts its frozen rows from there.
  const parts = sheetParts([['a']], 'First', { hiddenSheet: [['b']] });
  parts['xl/_rels/workbook.xml.rels'] = relsOf([['rId1', 'worksheet', '/xl/worksheets/sheet2.xml'], ['rId2', 'worksheet', 'worksheets/sheet1.xml']]);
  parts['xl/worksheets/sheet2.xml'] = OOXML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" state="frozen"/></sheetView></sheetViews>'
    + '<sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Title</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Head</t></is></c></row></sheetData></worksheet>';
  parts['xl/worksheets/sheet1.xml'] = OOXML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/><sheetView workbookViewId="1"><pane xSplit="2" state="frozen"/></sheetView></sheetViews>'
    + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>b</t></is></c></row></sheetData></worksheet>';
  const found = await docWorker('sheet', officeZip(parts), { ext: 'xlsx' });
  assert.deepEqual(found.book.sheets.map((x) => [x.rows[0][0], x.origin.r, x.frozen]), [['Title', 2, { rows: 2, cols: 0 }], ['b', 0, undefined]], 'the second view\'s pane is not the first view\'s');
  const split = sheetParts([['a']]);
  split['xl/worksheets/sheet1.xml'] = split['xl/worksheets/sheet1.xml'].replace('<sheetData>', '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1200" ySplit="900" state="split"/></sheetView></sheetViews><sheetData>');
  assert.equal((await docWorker('sheet', officeZip(split), { ext: 'xlsx' })).book.sheets[0].frozen, undefined, 'a split is not frozen');
});

test('picks: a sheet\'s labels default to its frozen panes (the last frozen row and column a pick may read), else to the first row and column a pick may read', () => {
  assert.deepEqual(M.labelsOf({ rows: 2, cols: 1 }, [0, 1, 2], [0, 1, 2]), { row: 1, col: 0 }, 'a title row above the frozen header is no label');
  assert.deepEqual(M.labelsOf(null, [0, 1, 2], [0, 1, 2]), { row: 0, col: 0 }, 'none frozen: row 1 and column A');
  assert.deepEqual(M.labelsOf({ rows: 2, cols: 0 }, [0, 2], [1, 2]), { row: 0, col: 1 }, 'a frozen row that is hidden, and no column frozen: the first a pick may read');
  assert.deepEqual(M.labelsOf({ rows: 1 }, [], []), { row: -1, col: -1 }, 'nothing a pick may read: no labels');
});

test('the document worker: an Excel 97-2003 file is read as itself; a file that is neither a workbook\'s archive nor one is refused, and a zip named .xls is held to the archive check', async () => {
  const vm = require('node:vm');
  const ctx = vm.createContext({ TextDecoder, TextEncoder });
  vm.runInContext('globalThis.self = globalThis;' + readSource(path.join(ROOT, 'public', 'vendor', 'xlsx.full.min.js')), ctx);
  const book = ctx.XLSX.utils.book_new();
  ctx.XLSX.utils.book_append_sheet(book, ctx.XLSX.utils.aoa_to_sheet([['Item', 'Cost'], ['Plant', 4]]), 'Budget');
  const xls = Buffer.from(ctx.XLSX.write(book, { type: 'array', bookType: 'biff8' }));
  assert.deepEqual([...xls.subarray(0, 4)], [0xd0, 0xcf, 0x11, 0xe0]);
  const r = await docWorker('sheet', xls, { ext: 'xls' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.book.sheets[0].rows, [['Item', 'Cost'], ['Plant', '4']]);
  assert.deepEqual(await docWorker('sheet', Buffer.from('<table><tr><td>an HTML table</td></tr></table>'), { ext: 'xls' }), { ok: false, why: 'shape' });
  const macros = bookParts();
  macros['xl/vbaProject.bin'] = Buffer.from('macros');
  assert.deepEqual(await docWorker('sheet', officeZip(macros), { ext: 'xls' }), { ok: false, why: 'packed' }, 'the archive check, whatever the name says');
});

test('the document worker: a deck\'s picture over the pixel bound leaves without its bytes', async () => {
  const pngHead = (w, h) => { const b = Buffer.from(pngOf(1, 1)); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const parts = deckParts([{ xml: slide(sp('Title', { ph: 'title' }) + pic('rId1') + pic('rId2')), rels: [['rId1', 'image', '../media/huge.png'], ['rId2', 'image', '../media/fine.png']] }], { 'huge.png': pngHead(10000, 5000), 'fine.png': pngOf(2, 2) });
  const r = await docWorker('deck', officeZip(parts));
  assert.deepEqual(r.pictures.map((p) => [p.name, !!p.bytes, p.why]), [['ppt/media/huge.png', false, 'pixels'], ['ppt/media/fine.png', true, '']]);
});

test('what each seat draws of a workbook: the Board and an observer never a hidden sheet, row or column, and say how many; the research seat every one, marked; the AI\'s text none', async () => {
  const r = await docWorker('sheet', officeZip(bookParts()), { ext: 'xlsx' });
  const book = r.book;
  const budget = book.sheets[0];
  for (const seat of ['board', 'observer', 'anything else']) {
    const plan = M.planSheet(budget, seat);
    assert.deepEqual(plan.cols, [0, 2, 3], seat + ': column B is not drawn');
    assert.deepEqual(plan.rows.map((x) => x.r), [0, 2], seat + ': row 2 is not drawn');
    assert.equal(plan.notShown, '1 hidden row and 1 hidden column not shown');
    assert.ok(!JSON.stringify(plan).includes('SECRET'), seat + ': nothing hidden in the drawing');
    assert.deepEqual(M.planBook(book, seat), { sheets: [budget], notShown: '2 hidden sheets not shown' });
  }
  const research = M.planSheet(budget, 'research');
  assert.deepEqual([research.cols, research.rows.map((x) => [x.r, x.hidden]), research.notShown], [[0, 1, 2, 3], [[0, false], [1, true], [2, false]], '']);
  assert.deepEqual(research.rows[0].cells.map((c) => c.hidden), [false, true, false, false], 'hidden column marked');
  assert.deepEqual(research.rows[2].cells[2], { c: 2, text: '', noValue: true, hidden: false }, 'the formula with no saved value is marked, not drawn as a blank');
  assert.equal(M.WORDS.noValue, 'formula — no saved value');
  assert.equal(M.planBook(book, 'research').sheets.length, 3);
  const text = M.documentText(book);
  assert.ok(text.startsWith('# Budget\nItem\tCost\t\nTotal\t\t2'), text);
  for (const gone of ['SECRETCOL', 'SECRETROW', 'VERYHIDDEN', 'JUSTHIDDEN']) assert.ok(!text.includes(gone), gone + ' is not in the AI\'s text');
  // One hidden row alone is said in the singular, as a Board seat's Look of it draws.
  assert.equal(M.planSheet({ rows: [['a'], ['b']], hiddenRows: [1], hiddenCols: [] }, 'board').notShown, '1 hidden row not shown');
});

test('documentText: a Word file\'s text marks where each page starts, "— p. 12 —" or "— ≈ p. 12 —"; it is capped', () => {
  const blocks = [{ kind: 'h', text: 'Minutes', page: 1 }, { kind: 'p', text: 'Opening', page: 1 }, { kind: 'img', text: '', page: 2 }, { kind: 'p', text: 'Item 4', page: 2, pageApprox: true }];
  assert.equal(M.documentText({ kind: 'word', blocks }), '— p. 1 —\nMinutes\nOpening\n— p. 2 —\nItem 4');
  assert.equal(M.documentText({ kind: 'md', blocks: [{ kind: 'p', text: 'x'.repeat(70000) }] }).length, M.BOUNDS.aiChars);
  assert.equal(M.documentText({ kind: 'word', blocks: [{ kind: 'p', text: 'A', page: 3, pageApprox: true }] }), '— ≈ p. 3 —\nA');
  assert.equal(M.pageWords(1, 3, false), 'p. 1 of 3');
  assert.equal(M.pageWords(1, 2, true), '≈ p. 1 of ≈ 2');
  assert.deepEqual(['research', 'board', 'observer', 'admin', undefined].map(M.seatOf), ['research', 'board', 'observer', 'observer', 'observer']);
});

// ---------------------------------------------------------------- the worker's clock
/** A worker that answers after `ms` (never, when null), and says whether it was ended. */
const standIn = (ms, answer = { ok: true, done: 1 }) => {
  const w = { ended: 0, posted: null, terminate() { w.ended++; } };
  w.postMessage = (m, transfer) => { w.posted = { m, transfer }; if (ms !== null) setTimeout(() => w.onmessage({ data: answer }), ms); };
  return w;
};

test('readInWorker: a task answered in time is the worker\'s answer; one that is not is ended at its cap, and every worker is ended once', async () => {
  const quick = standIn(5);
  const bytes = new ArrayBuffer(8);
  assert.deepEqual(await M.readInWorker(bytes, 'sheet', { ms: 500, make: () => quick, opts: { ext: 'xlsx' } }), { ok: true, done: 1 });
  assert.equal(quick.ended, 1, 'ended once it answered');
  assert.deepEqual([quick.posted.m.task, quick.posted.m.opts, quick.posted.transfer[0] === bytes], ['sheet', { ext: 'xlsx' }, true], 'the bytes are transferred, not copied');
  const stuck = standIn(null);
  const t0 = Date.now();
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { ms: 60, make: () => stuck }), { ok: false, why: 'time' });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(stuck.ended, 1, 'ended at its cap');
  const late = standIn(150);
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { ms: 30, make: () => late }), { ok: false, why: 'time' });
  await new Promise((r) => { setTimeout(r, 200); });
  assert.equal(late.ended, 1, 'an answer after the cap changes nothing');
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { make: () => { throw new Error('no workers here'); } }), { ok: false, why: 'worker' });
  const failing = standIn(null);
  const failed = M.readInWorker(new ArrayBuffer(8), 'word', { ms: 500, make: () => failing });
  let prevented = false;
  failing.onerror({ preventDefault: () => { prevented = true; } });
  assert.deepEqual([await failed, prevented, failing.ended], [{ ok: false, why: 'worker' }, true, 1]);
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { ms: 500, make: () => standIn(1, 'not an answer') }), { ok: false, why: 'shape' });
  assert.equal(M.BOUNDS.workerMs, 15000);
});

test('readInWorker: a document closed while its worker reads ends the worker at once, and one closed before it starts makes none', async () => {
  const reading = standIn(null);
  const close = new AbortController();
  const t0 = Date.now();
  const answer = M.readInWorker(new ArrayBuffer(8), 'word', { ms: 10000, make: () => reading, signal: close.signal });
  close.abort();
  assert.deepEqual(await answer, { ok: false, why: 'closed' });
  assert.ok(Date.now() - t0 < 1000, 'at once, not at its cap');
  assert.equal(reading.ended, 1);
  let made = 0;
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { make: () => { made++; return standIn(1); }, signal: already.signal }), { ok: false, why: 'closed' });
  assert.equal(made, 0);
  // Answered first, a later close changes nothing.
  const quick = standIn(1);
  const later = new AbortController();
  assert.deepEqual(await M.readInWorker(new ArrayBuffer(8), 'word', { make: () => quick, signal: later.signal }), { ok: true, done: 1 });
  later.abort();
  assert.equal(quick.ended, 1);
});

test('picks: a grid\'s cell with its two labels, its row with the label row, its column with its label cell, a range with the labels beside it; hidden rows and columns never among them; over 25 × 10 refused, or cut as chosen', () => {
  const g = [['', 'Q1', 'Q2', 'Q3'], ['Revenue', '1', 'HIDDEN', '4.2'], ['Costs', '3', '4', '3.9'], ['SECRET', '9', '9', '9']];
  const get = (r, c) => g[r][c];
  // Column C (2) and row 4 (3) are hidden: never among the rows and columns a pick may read.
  const o = { rows: [0, 1, 2], cols: [0, 1, 3], labels: { row: 0, col: 0 } };
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'cell', r: 1, c: 3, name: 'Q3 sheet' }), { unit: 'cell', table: { rows: [['', 'Q3'], ['Revenue', '4.2']], head: 1, side: 1, ref: '\'Q3 sheet\'!D2', focus: [1, 1] }, size: '3 ch' });
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'cell', r: 1, c: 3, withLabels: false }).table, { rows: [['4.2']], head: 0, side: 0, ref: 'D2', focus: [0, 0] }, 'with labels off: the cell alone');
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'cell', r: 0, c: 3 }).table.rows, [['Q3']], 'a label itself has no labels');
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'row', r: 2, c: 1 }).table, { rows: [['', 'Q1', 'Q3'], ['Costs', '3', '3.9']], head: 1, side: 1, ref: 'row 3' });
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'column', r: 1, c: 3 }), { unit: 'column', table: { rows: [['Q3'], ['4.2'], ['3.9']], head: 1, side: 0, ref: 'column D' }, size: '2 cells' });
  assert.deepEqual(M.gridQuote(get, { ...o, unit: 'range', r: 1, c: 1, r1: 2, c1: 3 }).table, { rows: [['', 'Q1', 'Q3'], ['Revenue', '1', '4.2'], ['Costs', '3', '3.9']], head: 1, side: 1, ref: 'B2:D3' });
  // A label row or column marked elsewhere, or none (-1); a cell with one label goes with that one.
  assert.deepEqual(M.gridQuote(get, { ...o, labels: { row: -1, col: -1 }, unit: 'cell', r: 1, c: 3 }).table.rows, [['4.2']]);
  assert.deepEqual(M.gridQuote(get, { ...o, labels: { row: 0, col: -1 }, unit: 'cell', r: 1, c: 3 }).table, { rows: [['Q3'], ['4.2']], head: 1, side: 0, ref: 'D2', focus: [1, 0] }, 'a header row alone: the label over it');
  assert.deepEqual(M.gridQuote(get, { ...o, labels: { row: -1, col: 0 }, unit: 'cell', r: 1, c: 3 }).table, { rows: [['Revenue', '4.2']], head: 0, side: 1, ref: 'D2', focus: [0, 1] }, 'a label column alone: the name beside it');
  // A hidden row or column is never quoted, whatever names it: a header's pick, a cell's, a range's end.
  assert.equal(M.gridQuote(get, { ...o, unit: 'column', r: 0, c: 2 }), null, 'the hidden column C');
  assert.equal(M.gridQuote(get, { ...o, unit: 'row', r: 3, c: 0 }), null, 'the hidden row 4');
  assert.equal(M.gridQuote(get, { ...o, unit: 'cell', r: 1, c: 2 }), null, 'a cell of a hidden column');
  assert.equal(M.gridQuote(get, { ...o, unit: 'cell', r: 3, c: 1 }), null, 'a cell of a hidden row');
  assert.equal(M.gridQuote(get, { ...o, unit: 'range', r: 1, c: 1, r1: 3, c1: 3 }), null, 'a range ending in a hidden row');
  assert.equal(M.gridQuote(get, { unit: 'cell', r: 1, c: 1, rows: [], cols: [], labels: { row: 0, col: 0 } }), null, 'a hidden sheet: nothing among its rows');
  // Over 25 rows × 10 columns: refused with how big it is, or cut to it as the researcher chose, the labels kept.
  const big = (r, c) => (r === 0 ? 'H' + c : String(r * c));
  const rows = Array.from({ length: 40 }, (_, i) => i);
  const cols = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(M.gridQuote(big, { unit: 'range', r: 0, c: 0, r1: 39, c1: 11, rows, cols, labels: { row: 0, col: -1 } }), { error: 'Too big for the stage: narrow it to 25 rows × 10 columns', over: { rows: 40, cols: 12 } });
  const cut = M.gridQuote(big, { unit: 'range', r: 0, c: 0, r1: 39, c1: 11, rows, cols, labels: { row: 0, col: -1 }, cut: true });
  assert.deepEqual([cut.table.rows.length, cut.table.rows[0].length, cut.table.rows[0][0], cut.cut, cut.more], [25, 10, 'H0', true, { rows: 15, cols: 2 }]);
});

test('picks: a tagged PDF\'s table by its structure: a cell under its header row alone, a column over 25 rows refused with its size, or cut to it as chosen and said cut with what was left out', () => {
  const roles = Array.from({ length: 40 }, (_, r) => ['TH', 'TD', 'TD'].map((k) => (r === 0 ? 'TH' : k)));
  const get = (r, c) => (r === 0 ? ['Item', 'Q1', 'Q2'][c] : c === 0 ? 'Line ' + r : String(r * 10 + c));
  assert.deepEqual(M.structQuote(get, roles, { unit: 'cell', r: 2, c: 1 }), { unit: 'cell', table: { rows: [['Q1'], ['21']], head: 1, side: 0, ref: 'row 3, column 2', focus: [1, 0] } }, 'a header row and no label column: the label over it');
  assert.deepEqual(M.structQuote(get, roles, { unit: 'column', r: 2, c: 1 }), { error: 'Too big for the stage: narrow it to 25 rows × 10 columns', over: { rows: 40, cols: 1 } });
  const cut = M.structQuote(get, roles, { unit: 'column', r: 2, c: 1, cut: true });
  assert.deepEqual([cut.unit, cut.table.rows.length, cut.table.rows[0][0], cut.table.rows[24][0], cut.table.head, cut.cut, cut.more], ['column', 25, 'Q1', '241', 1, true, { rows: 15, cols: 0 }]);
  assert.equal(M.structQuote(get, roles, { unit: 'paragraph', r: 2, c: 1 }), null, 'a table gives cells, rows and columns alone');
  assert.equal(M.structQuote(get, roles, { unit: 'cell', r: 2, c: 5 }), null, 'a cell not in it');
});

test('picks: What I see within the stage\'s bounds goes as it is; over them it is never cut by itself — the bound is said, and what fits (the first 12 blocks, a table\'s first 25 rows × 10 columns) offered', () => {
  const p = (n) => ({ kind: 'p', text: 'Paragraph ' + n });
  assert.deepEqual(M.viewQuote([p(1), p(2)]), { blocks: [p(1), p(2)] });
  const many = M.viewQuote(Array.from({ length: 13 }, (_, i) => p(i + 1)));
  assert.deepEqual([many.over, many.blocks.length, many.blocks[11].text], ['Too much in view for the stage: 13 blocks (12 at most)', 12, 'Paragraph 12']);
  const tall = M.viewQuote([p(1), { kind: 'table', table: { rows: Array.from({ length: 30 }, (_, r) => Array.from({ length: 12 }, (__, c) => r + '.' + c)), head: 1, side: 0 } }]);
  assert.equal(tall.over, 'Too much in view for the stage: a table of 30 rows × 12 columns (25 rows × 10 columns at most)');
  assert.deepEqual([tall.blocks.length, tall.blocks[1].table.rows.length, tall.blocks[1].table.rows[0].length, tall.blocks[1].table.head], [2, 25, 10, 1]);
  const long = M.viewQuote([{ kind: 'p', text: 'x'.repeat(3000) }, { kind: 'p', text: 'y'.repeat(1500) }], { note: 'For the vote' });
  assert.match(long.over, /^Too much in view for the stage: (1,200 characters a block|4,000 characters) at most/);
  assert.ok(long.blocks.reduce((n, b) => n + M.charsOf(b.text), 0) + M.charsOf('For the vote') <= 4000 && long.blocks.every((b) => M.charsOf(b.text) <= 1200), 'what fits fits');
});

test('picks: a word and a sentence by Intl.Segmenter (a span crossing two is neither), words cut to 1,200 characters as chosen, a quote\'s size for the bar, a merged cell\'s words in each place it covers', () => {
  const t = 'Net revenue rose. Costs fell!';
  assert.deepEqual(M.segmentOf(t, 5, 8, 'word'), { start: 4, end: 11, text: 'revenue' });
  assert.deepEqual(M.segmentOf(t, 4, 4, 'word'), { start: 4, end: 11, text: 'revenue' }, 'a tap: the word under it');
  assert.equal(M.segmentOf(t, 2, 6, 'word'), null, 'across two words: no word');
  assert.equal(M.segmentOf(t, 3, 3, 'word'), null, 'a space is no word');
  assert.equal(M.segmentOf(t, 0, 5, 'sentence').text, 'Net revenue rose.');
  assert.equal(M.segmentOf(t, 10, 22, 'sentence'), null, 'across two sentences: no sentence');
  assert.equal(M.segmentOf('売上は増えた。費用は減った。', 0, 2, 'sentence').text, '売上は増えた。', 'a script with no spaces');
  assert.deepEqual(M.cutText('😀'.repeat(1201)), { text: '😀'.repeat(1200), cut: true }, 'code points, never half a pair');
  assert.deepEqual(M.cutText('short'), { text: 'short', cut: false });
  assert.deepEqual([M.quoteSize({ unit: 'paragraph', text: 'x'.repeat(240) }), M.quoteSize({ unit: 'item', items: ['a', 'b', 'c'] }), M.quoteSize({ unit: 'column', table: { rows: [['Q3'], ['1'], ['2']], head: 1, side: 0 } }), M.quoteSize({ unit: 'cell', table: { rows: [['', 'Q3'], ['Rev', '4.2']], head: 1, side: 1, focus: [1, 1] } })],
    ['240 ch', '3 items', '2 cells', '3 ch']);
  assert.deepEqual(M.denseRows([[{ text: 'Wide', c: 0, colspan: 2 }, { text: 'C', c: 2 }], [{ text: 'a', c: 0 }, { text: 'b', c: 1 }, { text: 'c', c: 2 }]], 3), [['Wide', 'Wide', 'C'], ['a', 'b', 'c']]);
  assert.equal(M.cellRef(13, 2), 'C14');
  assert.deepEqual(M.QUOTE_BOUNDS, { text: 1200, items: 20, item: 300, rows: 25, cols: 10, cell: 200, blocks: 12, whole: 4000 }, 'the server\'s bounds (lib/pages.js SNIPPET), so the bar refuses what it would');
  const S = require('../lib/pages').SNIPPET;
  for (const k of Object.keys(M.QUOTE_BOUNDS)) assert.equal(M.QUOTE_BOUNDS[k], S[k], k);
});
