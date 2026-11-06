'use strict';
/**
 * The document worker: a file's bytes read away from the page, one task per worker, ended by the page when it answers,
 * when its clock runs out or when the page closes the document (docmodel.mjs readInWorker). It parses Office files (the
 * CSV and text a page reads itself) and answers plain data; it holds no socket and draws nothing.
 *
 *   {task: 'sheet', bytes, opts: {ext}}   → {ok, book: {kind: 'book', sheets: [{name, hidden, rows, hiddenRows, hiddenCols, noValue, merges, origin, truncated, shown, cutCols, frozen?}]}}
 *   {task: 'word', bytes}                 → {ok, html, scan, pictures: [{n, type, bytes, why}]}   (the pictures' bytes transferred;
 *                                           a picture the page may not draw has none, and `why`: 'type', 'unreadable', 'pixels')
 *   {task: 'deck', bytes}                 → {ok, parts: {name: xml}, pictures: [{name, type, bytes, why}]}
 *   anything else, or a refusal           → {ok: false, why}
 *
 * Invariants:
 *   - An Office file is held to the archive check first (zipcore.js, the server's own check), and a part is inflated
 *     only as far as its declared size: a stream that runs past it is cut and the file refused.
 *   - Every name is the one every reader of the file finds: printable ASCII, a canonical path (no `.` or `..` part, no
 *     empty one, no leading `/`, no `\`), the same in the local header JSZip reads it from as in the directory checked,
 *     and none twice, whatever its case. A file with any other is refused ('packed') before a library sees it.
 *   - Every entry is scanned for a document type or entity declaration, in whatever encoding a parser may read it,
 *     before any parser is handed the file (SheetJS's, mammoth's and wordpages.js's alike); such a file is refused
 *     ('dtd'). The scan reads every entry, not the ones named like XML, since a reader finds its parts by relationship.
 *   - mammoth never sees Word's hidden text: it is handed a copy of the file whose main document, footnotes, endnotes and
 *     comments, found as mammoth finds them (wordpages.js partsOf), have had every hidden run removed (wordpages.js
 *     stripHidden, by the styles part mammoth reads, zipcore.js repack). A hidden mark that cannot be resolved, or
 *     WordprocessingML bound to a prefix the scanner does not read, refuses the file ('hidden').
 *   - Pictures leave as bytes, never as addresses: mammoth's picture becomes `agm-img:<n>`, and the page makes (and
 *     revokes) the object URL it draws it with. Each picture's size is read from its header (imagecore.js) first: one of
 *     no type a browser here draws, of no size that can be read, or over PIXELS leaves with no bytes, so no page decodes
 *     it. External pictures and links are never fetched.
 *   - Formulas are never computed: a cell's saved value is read, and a formula with none is marked. A sheet is read to
 *     its first ROWS rows, its first COLS columns, and as many rows as CELLS allow at that width, each cut said.
 *   - A sheet's frozen panes (its first view's, as Excel saves them) are read from its own part, found by the workbook's
 *     relationships as SheetJS finds it, and answered as `frozen`: the rows and columns frozen from the top and the left
 *     of what was read. A pick's labels default to them (docmodel.mjs labelsOf). An Excel 97-2003 file's are not read.
 *   - A device without `DecompressionStream('deflate-raw')` reads no zipped Office file: the answer says so ('device').
 *   - The libraries load only for the task that needs them: SheetJS for a sheet, mammoth for a Word file.
 */
importScripts('/zipcore.js', '/wordpages.js', '/imagecore.js');

/** A sheet's first rows read (BOUNDS.rows); SheetJS reads one more, to know it was cut. */
const ROWS = 5000;
/** A sheet's first columns read (BOUNDS.cols). */
const COLS = 256;
/** A sheet's cells read at most (BOUNDS.cells): a wide sheet's rows are cut to keep within it. */
const CELLS = 100000;
/** A picture's pixels at most (BOUNDS.pixels): one larger leaves without its bytes. */
const PIXELS = 40000000;
/** The pictures a deck or a Word file hands back, and the types the page may draw. */
const PICTURES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const COMPOUND = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const begins = (b, sig) => sig.every((x, i) => b[i] === x);

class Refusal extends Error {
  constructor(why) { super(why); this.why = why; }
}

/** A stream that inflates raw deflate, or the refusal of a device that has none. */
function inflater() {
  try {
    if (typeof DecompressionStream === 'function') return new DecompressionStream('deflate-raw');
  } catch { /* a stream that does not know 'deflate-raw': this device reads no zipped file */ }
  throw new Refusal('device');
}

/** An entry's bytes, inflated where it is deflated, never past its declared size. */
async function inflate(all, e, offset) {
  const data = AGMZip.stored(all, e, offset);
  if (!data) throw new Refusal('shape');
  if (e.method === 0) return data;
  const out = new Uint8Array(e.unpacked);
  let got = 0;
  const reader = new Blob([data]).stream().pipeThrough(inflater()).getReader();
  for (;;) {
    let step;
    try { step = await reader.read(); } catch { throw new Refusal('shape'); }
    if (step.done) break;
    if (got + step.value.length > out.length) { await reader.cancel(); throw new Refusal('packed'); }
    out.set(step.value, got);
    got += step.value.length;
  }
  if (got !== out.length) throw new Refusal('packed');
  return out;
}

/** A part's text: UTF-16 where its byte-order mark says so, else UTF-8 (a UTF-8 mark dropped). */
function text(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Whether `b` declares a document type or an entity (`<!DOCTYPE`, `<!ENTITY`, in any case) in the encodings a parser may
 * read it in: NUL bytes, UTF-16's and UTF-32's high bytes for these letters, are passed over.
 */
function declares(b) {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0x3c) continue;
    let j = i + 1;
    const next = () => { while (j < b.length && b[j] === 0) j++; return j < b.length ? b[j++] : -1; };
    if (next() !== 0x21) continue;
    let word = '';
    for (let k = 0; k < 7; k++) { const c = next(); if (c < 0) break; word += String.fromCharCode(c).toUpperCase(); }
    if (word.startsWith('DOCTYPE') || word.startsWith('ENTITY')) return true;
  }
  return false;
}

/** Whether a name is one every reader finds as written: printable ASCII and a canonical path. */
const canonical = (name) => /^[\x20-\x7e]+$/.test(name) && !name.includes('\\') && name.split('/').every((p, i, all) => (p !== '' || i === all.length - 1) && p !== '.' && p !== '..') && !name.startsWith('/');
/** Whether an entry is a folder to JSZip: a name ending in `/`, or the folder bit of its external attributes. */
const folder = (e) => e.name.endsWith('/') || (e.external & 0x10) !== 0;

/** Whether the local header at the entry's offset names it with the same bytes as the directory does. */
function sameName(all, e) {
  if (e.local + 30 > all.length) return false;
  const n = all[e.local + 26] | (all[e.local + 27] << 8);
  if (n !== e.raw.length || e.local + 30 + n > all.length) return false;
  for (let i = 0; i < n; i++) if (all[e.local + 30 + i] !== e.raw[i]) return false;
  return true;
}

/**
 * An Office file opened: the check passed, every name held to the names every reader finds, and every entry inflated
 * once and scanned for a declaration. {all, list, offset, files: Map(name → entry), read(name) → its text or ''}.
 */
async function open(bytes) {
  const all = new Uint8Array(bytes);
  const r = await AGMZip.entries(AGMZip.bytesSource(all));
  if (r.ok === false) throw new Refusal('packed');
  const files = new Map();
  const seen = new Set();
  for (const e of r.list) {
    const lower = e.name.toLowerCase();
    if (!canonical(e.name) || !sameName(all, e) || seen.has(lower)) throw new Refusal('packed');
    seen.add(lower);
    if (folder(e)) { if (e.unpacked !== 0) throw new Refusal('packed'); continue; }
    if (declares(await inflate(all, e, r.offset))) throw new Refusal('dtd');
    files.set(e.name, e);
  }
  const read = async (name) => (files.has(name) ? text(await inflate(all, files.get(name), r.offset)) : '');
  return { all, list: r.list, offset: r.offset, files, read };
}

/** Throws the reason a wordpages.js reader refused for, in the worker's own words. */
const refusedBy = (e) => { throw new Refusal(e && typeof e.why === 'string' ? e.why : 'shape'); };

/**
 * A picture leaving the worker: its bytes where it is one of the types a page may draw, its size read from its header
 * and within PIXELS; else none, and why ('type', 'unreadable', 'pixels').
 */
async function picture(type, bytes) {
  if (!PICTURES[type] || !bytes) return { bytes: null, why: 'type' };
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const size = await AGMImage.sizeOf(b);
  if (!size) return { bytes: null, why: 'unreadable' };
  if (size.width * size.height > PIXELS) return { bytes: null, why: 'pixels' };
  return { bytes: b.slice().buffer, why: '' };
}

// ---------------------------------------------------------------- spreadsheets

/** Whether a part's root element is a worksheet: past an XML declaration, processing instructions and comments. */
function worksheet(xml) {
  let i = 0;
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i])) i++;
    const close = xml.startsWith('<?', i) ? '?>' : xml.startsWith('<!--', i) ? '-->' : '';
    if (!close) break;
    const end = xml.indexOf(close, i);
    if (end < 0) return false;
    i = end + close.length;
  }
  if (xml[i] !== '<') return false;
  let j = i + 1;
  while (j < xml.length && !/[\s/>]/.test(xml[j])) j++;
  const name = xml.slice(i + 1, j);
  return name.slice(name.indexOf(':') + 1) === 'worksheet';
}
const attrText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * A worksheet's text with each formula cell that has no saved value (no `<v>`, or an empty one where its type is not a
 * string's, and no inline string) written as SheetJS reads an error with no value: `t="e"`, its `<v>` taken out, its
 * formula kept. SheetJS reads a boolean with no value as FALSE and a string with none as "", which a saved FALSE or ""
 * cannot be told from; this is the one shape it leaves without a value. Null where nothing changed.
 */
function markNoValue(xml) {
  const path = [];
  const edits = [];
  let cell = null;
  AGMWord.walk(xml, (tk) => {
    if (tk.t === 'text') { if (cell && cell.inV) cell.v += tk.text; return; }
    const name = tk.name.slice(tk.name.indexOf(':') + 1);
    if (tk.t === 'close') {
      path.pop();
      if (cell && name === 'v' && path.length === cell.depth) { cell.inV = false; cell.spans.push([cell.vAt, tk.end]); }
      if (cell && name === 'c' && path.length === cell.depth - 1) {
        const t = cell.attrs.t || 'n';
        const saved = cell.inline || (cell.hasV && (t === 'str' || cell.v.trim() !== ''));
        if (cell.formula && !saved) {
          const head = '<' + cell.name + Object.entries(cell.attrs).filter(([k]) => k !== 't').map(([k, v]) => ' ' + k + '="' + attrText(v) + '"').join('') + ' t="e">';
          edits.push([cell.at, cell.headEnd, head], ...cell.spans.map(([a, b]) => [a, b, '']));
        }
        cell = null;
      }
      return;
    }
    const parent = path.length ? path[path.length - 1].slice(path[path.length - 1].indexOf(':') + 1) : '';
    if (name === 'c' && parent === 'row' && tk.t === 'open') cell = { at: tk.at, headEnd: tk.end, name: tk.name, attrs: tk.attrs, depth: path.length + 1, formula: false, hasV: false, inV: false, v: '', inline: false, spans: [] };
    else if (cell && path.length === cell.depth) {
      if (name === 'f') cell.formula = true;
      else if (name === 'is') cell.inline = true;
      else if (name === 'v') { cell.hasV = true; if (tk.t === 'empty') cell.spans.push([tk.at, tk.end]); else { cell.inV = true; cell.vAt = tk.at; } }
    }
    if (tk.t === 'open') path.push(tk.name);
  });
  if (!edits.length) return null;
  edits.sort((a, b) => b[0] - a[0]);
  let out = xml;
  for (const [a, b, w] of edits) out = out.slice(0, a) + w + out.slice(b);
  return out;
}

/**
 * Each tag of `xml` in order, handed to `fn(tag, closes, local)` (its text, whether it closes an element, its name without
 * its prefix) until `fn` answers true. Comments, declarations and processing instructions are passed over.
 */
function eachTag(xml, fn) {
  const s = String(xml);
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    const close = s.indexOf('>', i);
    if (close < 0) return;
    const tag = s.slice(i, close + 1);
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)/.exec(tag);
    if (m && fn(tag, m[1] === '/', m[2].slice(m[2].indexOf(':') + 1)) === true) return;
    i = close;
  }
}
/** The start tags of the elements of local name `name` in `xml`, in order. */
function tagsOf(xml, name) {
  const out = [];
  eachTag(xml, (tag, closes, local) => { if (!closes && local === name) out.push(tag); });
  return out;
}
/** An attribute's value in a start tag, by its local name (whatever its prefix): '' where it has none. */
function attrOf(tag, name) {
  const re = /\s([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) if (m[1].slice(m[1].indexOf(':') + 1) === name) return m[2] !== undefined ? m[2] : m[3];
  return '';
}
/** A relationship's target as a part's name: from the folder of the part that names it, or from the root where it begins with `/`. */
function partAt(folder, target) {
  const out = [];
  for (const p of (target.startsWith('/') ? target.slice(1) : folder + target).split('/')) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}
/** A workbook's sheets' parts, in its order (the order SheetJS lists them in), found by its relationships: '' for one not found. */
async function sheetPartsOf(file) {
  const office = tagsOf(await file.read('_rels/.rels'), 'Relationship').find((t) => attrOf(t, 'Type').endsWith('/officeDocument'));
  const book = office ? partAt('', attrOf(office, 'Target')) : 'xl/workbook.xml';
  const folder = book.slice(0, book.lastIndexOf('/') + 1);
  const rels = new Map(tagsOf(await file.read(folder + '_rels/' + book.slice(folder.length) + '.rels'), 'Relationship').map((t) => [attrOf(t, 'Id'), partAt(folder, attrOf(t, 'Target'))]));
  return tagsOf(await file.read(book), 'sheet').map((t) => rels.get(attrOf(t, 'id')) || '');
}
/**
 * A worksheet's frozen panes, as its first view saves them (`<pane state="frozen" xSplit ySplit>`): {rows, cols}, the rows
 * frozen from its top and the columns from its left, or null where it freezes none (a split that is not frozen is none).
 * Its views come before its cells: the cells are never read for it.
 */
function frozenOf(xml) {
  let pane = '';
  let inView = false;
  eachTag(xml, (tag, closes, local) => {
    if (local === 'sheetData') return true;
    if (!inView) {
      if (!closes && local === 'sheetView') { if (tag.endsWith('/>')) return true; inView = true; }
      return false;
    }
    if (local === 'sheetView') return true;
    if (!closes && local === 'pane') { pane = tag; return true; }
    return false;
  });
  if (!pane || !attrOf(pane, 'state').startsWith('frozen')) return null;
  const count = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 1048576 ? n : 0; };
  const rows = count(attrOf(pane, 'ySplit')), cols = count(attrOf(pane, 'xSplit'));
  return rows || cols ? { rows, cols } : null;
}

async function sheet(bytes) {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  let read = new Uint8Array(bytes);
  const panes = [];
  if (begins(head, ZIP)) {
    // A zipped workbook: checked, scanned, and its formula cells with no saved value written so that SheetJS keeps them so.
    const file = await open(bytes);
    const replaced = {};
    for (const name of file.files.keys()) {
      const xml = await file.read(name);
      // A worksheet, whatever its name (SheetJS finds its sheets by relationship), with a formula in it.
      if (!worksheet(xml) || !/[<:]f[\s>/]/.test(xml)) continue;
      let marked;
      try { marked = markNoValue(xml); } catch (e) { refusedBy(e); }
      if (marked !== null) replaced[name] = new TextEncoder().encode(marked);
    }
    if (Object.keys(replaced).length) {
      const copy = await AGMZip.repack(file.all, replaced);
      if (copy.ok === false) throw new Refusal('packed');
      read = copy.bytes;
    }
    for (const part of await sheetPartsOf(file)) panes.push(part ? frozenOf(await file.read(part)) : null);
  } else if (!begins(head, COMPOUND)) throw new Refusal('shape');   // neither a workbook's archive nor an Excel 97-2003 file
  importScripts('/vendor/xlsx.full.min.js');
  const wb = XLSX.read(read, { type: 'array', dense: true, sheetRows: ROWS + 1, cellFormula: true, cellStyles: true, cellHTML: false, cellNF: false, bookVBA: false, bookFiles: false });
  const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
  const sheets = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name] || {};
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const full = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']) : range;
    const data = ws['!data'] || [];
    // The columns read: the first COLS of the sheet's range. The rows: the sheet's first ROWS, and no more than CELLS
    // allow at that width.
    const width = Math.max(0, Math.min(range.e.c - range.s.c + 1, COLS));
    const lastCol = range.s.c + width - 1;
    const last = Math.min(range.e.r, ROWS - 1, range.s.r + Math.floor(CELLS / Math.max(1, width)) - 1);
    const rows = [];
    const noValue = [];
    for (let r = range.s.r; r <= last; r++) {
      const row = [];
      for (let c = range.s.c; c <= lastCol; c++) {
        const cell = data[r] && data[r][c];
        if (cell && cell.f !== undefined && (cell.t === 'z' || cell.v === undefined)) { noValue.push([r - range.s.r, c - range.s.c]); row.push(''); continue; }
        const w = cell ? XLSX.utils.format_cell(cell) : '';
        row.push(w === undefined || w === null ? '' : String(w));
      }
      rows.push(row);
    }
    const hiddenRows = [];
    (ws['!rows'] || []).forEach((p, r) => { if (p && p.hidden && r >= range.s.r && r <= last) hiddenRows.push(r - range.s.r); });
    const hiddenCols = [];
    (ws['!cols'] || []).forEach((p, c) => { if (p && p.hidden && c >= range.s.c && c <= lastCol) hiddenCols.push(c - range.s.c); });
    const merges = (ws['!merges'] || []).filter((m) => m.s.r <= last && m.s.c <= lastCol)
      .map((m) => ({ r0: m.s.r - range.s.r, c0: m.s.c - range.s.c, r1: Math.min(m.e.r, last) - range.s.r, c1: Math.min(m.e.c, lastCol) - range.s.c }));
    const hidden = meta[i] && (meta[i].Hidden === 1 || meta[i].Hidden === 2) ? meta[i].Hidden : 0;
    // Its frozen rows and columns counted from the first row and column read (the sheet's range may begin below row 1).
    const pane = panes[i];
    const frozen = pane ? { rows: Math.max(0, pane.rows - range.s.r), cols: Math.max(0, pane.cols - range.s.c) } : null;
    return { name: String(name), hidden, rows, hiddenRows, hiddenCols, noValue, merges, origin: { r: range.s.r, c: range.s.c },
      truncated: Math.max(range.e.r, full.e.r) > last, shown: last + 1, cutCols: range.e.c - range.s.c + 1 > COLS,
      ...(frozen && (frozen.rows || frozen.cols) ? { frozen } : {}) };
  });
  return { ok: true, book: { kind: 'book', sheets } };
}

// ---------------------------------------------------------------- Word

async function word(bytes) {
  const file = await open(bytes);
  const has = (name) => file.files.has(name);
  let parts;
  try { parts = await AGMWord.partsOf(has, file.read); } catch (e) { refusedBy(e); }
  const read = async (name) => (has(name) ? file.read(name) : '');
  // Every part mammoth reads as WordprocessingML is held to the prefix the scanner reads it by.
  for (const name of new Set([parts.main, parts.styles, parts.numbering, parts.footnotes, parts.endnotes, parts.comments])) {
    if (!has(name)) continue;
    const ns = AGMWord.namespaces(await read(name));
    if (!ns.ok) throw new Refusal(ns.why);
  }
  const styles = await read(parts.styles);
  let table;
  try { table = AGMWord.styles(styles); } catch (e) { refusedBy(e); }
  const replaced = {};
  let hidden = 0;
  for (const name of new Set([parts.main, parts.footnotes, parts.endnotes, parts.comments])) {
    if (!has(name)) continue;
    const s = AGMWord.stripHidden(await read(name), table);
    if (!s.ok) throw new Refusal(s.why);
    hidden += s.removed;
    replaced[name] = new TextEncoder().encode(s.xml);
  }
  const scan = AGMWord.scan({ document: await read(parts.main), styles, app: await read(parts.app) });
  if (!scan.ok) throw new Refusal(scan.why);
  const copy = await AGMZip.repack(file.all, replaced);
  if (copy.ok === false) throw new Refusal('packed');
  importScripts('/vendor/mammoth.browser.min.js');
  const pictures = [];
  // A picture of a type the page may draw, within the bound, leaves as its bytes; any other (EMF, WMF, one too large)
  // as its place alone, said in words.
  const convertImage = mammoth.images.imgElement((image) => {
    const type = String(image.contentType || '').toLowerCase();
    const n = pictures.length + 1;
    const slot = { n, type, bytes: null, why: 'type' };
    pictures.push(slot);
    if (!PICTURES[type]) return { src: 'agm-img:' + n };
    return image.readAsArrayBuffer().then((b) => picture(type, b)).then((p) => {
      slot.bytes = p.bytes;
      slot.why = p.why;
      return { src: 'agm-img:' + n };
    });
  });
  const ab = copy.bytes.buffer.slice(copy.bytes.byteOffset, copy.bytes.byteOffset + copy.bytes.byteLength);
  const r = await mammoth.convertToHtml({ arrayBuffer: ab }, { convertImage, externalFileAccess: false });
  // `hidden`: how many hidden runs were removed, so the page knows the file has hidden parts (never shown with Download).
  return { ok: true, html: String(r.value || ''), scan: { basis: scan.basis, pages: scan.pages, approx: scan.approx, paras: scan.paras }, hidden, pictures, transfer: pictures.map((p) => p.bytes).filter(Boolean) };
}

// ---------------------------------------------------------------- slides

async function deck(bytes) {
  const file = await open(bytes);
  const parts = {};
  for (const name of file.files.keys()) {
    // A presentation, its slides and their relationships: never the notes, the masters or the layouts.
    if (name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/(_rels\/)?slide\d{1,5}\.xml(\.rels)?$/.test(name)) parts[name] = await file.read(name);
  }
  if (!parts['ppt/presentation.xml']) throw new Refusal('shape');
  // The pictures the slides name: each slide's relationships to ppt/media, of a type the page may draw.
  const wanted = new Set();
  for (const [name, t] of Object.entries(parts)) {
    if (!name.endsWith('.rels') || name.startsWith('ppt/_rels/')) continue;
    for (const m of t.matchAll(/Target="\.\.\/media\/([A-Za-z0-9._-]{1,80})"/g)) wanted.add('ppt/media/' + m[1]);
  }
  const pictures = [];
  for (const e of file.list) {
    if (!wanted.has(e.name) || !file.files.has(e.name)) continue;
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(e.name) || [])[1];
    const type = EXT_TYPES[String(ext || '').toLowerCase()];
    if (!type) continue;
    const p = await picture(type, await inflate(file.all, e, file.offset));
    pictures.push({ name: e.name, type, bytes: p.bytes, why: p.why });
  }
  return { ok: true, parts, pictures, transfer: pictures.map((p) => p.bytes).filter(Boolean) };
}

const TASKS = { sheet, word, deck };

self.onmessage = async (event) => {
  const m = event.data || {};
  try {
    const run = Object.prototype.hasOwnProperty.call(TASKS, m.task) ? TASKS[m.task] : null;
    if (!run || !(m.bytes instanceof ArrayBuffer)) throw new Refusal('shape');
    const answer = await run(m.bytes, m.opts || {});
    const transfer = answer.transfer || [];
    delete answer.transfer;
    self.postMessage(answer, transfer);
  } catch (e) {
    self.postMessage({ ok: false, why: e instanceof Refusal ? e.why : 'shape' });
  }
};
