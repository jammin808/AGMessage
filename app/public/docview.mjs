// A document drawn into a box: the research page's Preview, the Board's panel and the take layer (a document or a picture
// shown on people's pages, pagelayer.mjs) draw through this one module, so the researcher and the Board see one drawing.
// It holds no socket: the page that opens a document says what it drew.
//
//   open(box, source, {at, seat, name, mime, ext, ranged, deadline}) → view
//     source   {url} (fetched no-store) or {file} (a local File)
//     at       the place it opens at: {page} (a page, a slide, a sheet, a line), and for a Word document {block}, the
//              paragraph by its number, which the view opens at
//     ext      the file's own type (an upload's, read from its address), which chooses the reader over its name
//     ranged   a PDF read by its pages' ranges alone, never streamed or fetched ahead (a take on the Board's devices)
//     seat     the page's own seat: 'research' (the admin's support view reads as research), 'board' or 'observer'.
//              Only the research seat draws hidden rows, columns, sheets and slides (dimmed and marked) and reads the
//              AI's text; every other seat gets the Board's drawing, without them.
//     view     {ready: Promise<{state: 'shown'|'failed', words}>, place(), goto(at), visible(), text(), find(words),
//               placeWords(), refit(), hiddenParts(), pagePicture(n), destroy()}
//     hiddenParts()   whether the reader found hidden parts in the file (hidden sheets, rows, columns, slides or shapes,
//                     Word's hidden text): such a file is never shown with Download ticked
//     picks (the research seat alone; plan 4-§5.9.6): onPick(fn) is told the pick each time it changes (null for none);
//     pick() the pick now: {type, units: [{unit, size, approx?}], words}; quote(unit, {cut, labels, note}) the pick as a
//     quote's body (lib/pages.js cleanSnippet's shape, its source's place as `at`), or {error, over?} where it passes a bound
//     the server holds; seen({note}) what is in view, as a quote (the blocks or the range in view; over a bound {quote:
//     {error}, fits}, what fits sent only as the researcher chooses) or as a picture's place ({page, rect}); regionPicture(page, rect) that part
//     drawn into a new picture; pickPicture() a picture picked in a Word document or a deck (a tap on it) drawn again
//     into a new one; region(on) a region drawn by hand over a PDF's page or a picture; labels() and
//     setLabels(row, col) a sheet's label row and column; clearPick(); onMenu(fn) told of a second tap on the pick (a
//     touch's door to its menu); tagged() whether a PDF carries its structure
//     pagePicture(n)  a PDF's page n drawn into a new picture (a PNG Blob, its long edge 2,048 px, never over 4,096 px a
//                     side nor PICTURE_PIXELS in all), or null for any other kind
//   loadPdfJs()   pdf.js, imported once for the page's life
//   pagePictureOf(source, n)  a PDF's page n drawn into a new picture, from a file not open in a view
//   pdfState()    {workers, open}: the pdf.js workers this page made, and the PDF documents open now
//
// Invariants:
//   - One pdf.js worker serves the page's life, and every PDF document is destroyed when its view is. A PDF whose first
//     page is not drawn within `deadline` (BOUNDS.pdfMs) is failed: its loading and the shared worker are destroyed, and
//     the next PDF makes a new one. pdf.js runs no script and no XFA, draws no annotation (no live link), and leaves out
//     an image over 16,777,216 pixels; pages are fetched as they come into view.
//   - An Office file is read in the document worker (docworker.js) under BOUNDS.workerMs, never on the page; its HTML
//     reaches the page only through parseInert, and every node drawn is built with the DOM and textContent.
//   - Every picture is drawn from bytes through an object URL this module makes and revokes with the document, and only
//     once its size, read from its header before anything decodes it (imagecore.js; in the document worker for one in an
//     Office file), is within BOUNDS.pixels.
//   - The place is kept: {page, zoom, offset} survives a resize, a collapse or a zoom, and goto() returns to it. While
//     the box has no layout (a collapsed panel) the view is left as it was and the last place seen stands; once the box
//     is laid out again the view returns to it.
//   - Closing a view ends its document worker at once, whatever it is reading.
import { BOUNDS, WORDS, decodeText, textLines, parseCsv, markdownBlocks, parseInert, inertText, pptxOutline, planSheet, planBook, planSlides, hiddenPartsOf, documentText, pageWords, readInWorker, seatOf, columnName, rowsWords, tableWords,
  QUOTE_BOUNDS, charsOf, segmentOf, gridQuote, structQuote, denseRows, cutText, quoteSize, quoteOver, viewQuote, counted, labelsOf } from './docmodel.mjs';
import './wordpages.js';
import './imagecore.js';

/** pdf.js leaves out an image larger than this many pixels (its default is no limit). */
const PDF_MAX_IMAGE = 16777216;
/** A rendered PDF page's backing store, at most: past it a page is drawn at a lower resolution, never larger. */
const CANVAS_PIXELS = 16777216;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;

let pdfLib = null;
let pdfWorker = null;
let workersMade = 0;
const openPdfs = new Set();

/** pdf.js, imported once for the page's life, its worker at the vendored file's own address. */
export function loadPdfJs() {
  if (!pdfLib) {
    pdfLib = import('/vendor/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      return lib;
    }, (e) => { pdfLib = null; throw e; });
  }
  return pdfLib;
}
/** The page's one pdf.js worker, made again only after the last was destroyed. */
function sharedWorker(lib) {
  if (!pdfWorker || pdfWorker.destroyed) { pdfWorker = new lib.PDFWorker(); workersMade++; }
  return pdfWorker;
}
/** The pdf.js workers this page made, and the PDF documents open now. */
export const pdfState = () => ({ workers: workersMade, open: openPdfs.size });

/** How far apart two pointers are: a pinch's measure. */
const spread = (pointers) => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
};
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

/** Which reader draws a file, by its name and type. */
export function kindOf(name, mime) {
  const ext = extOf(name);
  const type = String(mime || '').toLowerCase();
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'md') return 'md';
  if (ext === 'csv' || type.startsWith('text/csv')) return 'csv';
  if (ext === 'txt' || ext === 'log') return 'text';
  if (ext === 'docx' || type.includes('wordprocessingml')) return 'word';
  if (ext === 'xlsx' || ext === 'xls' || type.includes('spreadsheetml') || type === 'application/vnd.ms-excel') return 'book';
  if (ext === 'pptx' || type.includes('presentationml')) return 'deck';
  return 'none';
}

/** A document drawn into `box` (see the head of this file). */
export function open(box, source, opts) {
  const v = new View(box, source || {}, opts || {});
  return {
    ready: v.ready,
    place: () => v.place(),
    goto: (at) => v.goto(at),
    visible: () => v.visible(),
    text: () => v.text(),
    find: (words) => v.find(words),
    placeWords: () => v.placeWords(),
    refit: () => v.refit(),
    hiddenParts: () => v.hiddenParts(),
    pagePicture: (n) => v.pagePicture(n),
    onPick: (fn) => { v.pickers.add(fn); },
    onMenu: (fn) => { v.menuers.add(fn); },
    pick: () => v.pickNow(),
    quote: (unit, o) => v.quoteOf(unit, o || {}),
    seen: (o) => v.inView(o || {}),
    regionPicture: (page, rect) => v.regionPicture(page, rect),
    pickPicture: () => v.pickPicture(),
    textSize: (n) => v.textSize(n),
    region: (on) => v.regionMode(on),
    labels: () => v.labelsNow(),
    setLabels: (row, col) => v.setLabels(row, col),
    clearPick: () => v.clearPick(),
    tagged: () => v.isTagged(),
    holds: (target, x, y) => v.holds(target, x, y),
    destroy: () => v.destroy(),
  };
}
/** A page picture's backing store, at most: what pdf.js's own viewer sets on a phone or a tablet (maxCanvasPixels). */
const PICTURE_PIXELS = 5242880;
/** A page picture's long edge, and the most a side may be. */
const PICTURE_EDGE = 2048;
const PICTURE_SIDE = 4096;
/**
 * A pdf.js page drawn into a new picture: a PNG Blob on white, its long edge PICTURE_EDGE px, never over PICTURE_SIDE a
 * side nor PICTURE_PIXELS in all. Its drawing is held in `renders` while it runs, so a view that closes cancels it.
 */
async function drawPicture(page, renders) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(PICTURE_EDGE / Math.max(base.width, base.height), PICTURE_SIDE / base.width, PICTURE_SIDE / base.height, Math.sqrt(PICTURE_PIXELS / Math.max(1, base.width * base.height)));
  const vp = page.getViewport({ scale });
  const c = make('canvas');
  c.width = Math.max(1, Math.floor(vp.width));
  c.height = Math.max(1, Math.floor(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  const task = page.render({ canvasContext: ctx, viewport: vp });
  if (renders) renders.add(task);
  try { await task.promise; } finally { if (renders) renders.delete(task); }
  return new Promise((resolve) => c.toBlob((b) => resolve(b || null), 'image/png'));
}
/**
 * Page `n` of a PDF not open in a view (`source`: {url}, fetched no-store, or {file}, a copy on this device) drawn into a
 * new picture (drawPicture), the document destroyed once it is drawn; null for a page it does not hold or a file that
 * cannot be read.
 */
export async function pagePictureOf(source, n) {
  const lib = await loadPdfJs();
  let data;
  try {
    if (source && source.file) data = new Uint8Array(await source.file.arrayBuffer());
    else {
      const res = await fetch(source.url, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return null;
      data = new Uint8Array(await res.arrayBuffer());
    }
  } catch {
    return null;
  }
  const task = lib.getDocument({ data, worker: sharedWorker(lib), withCredentials: false, isEvalSupported: false, enableXfa: false, maxImageSize: PDF_MAX_IMAGE });
  openPdfs.add(task);
  try {
    const doc = await task.promise;
    if (!(n >= 1) || n > doc.numPages) return null;
    return await drawPicture(await doc.getPage(n), null);
  } catch {
    return null;
  } finally {
    openPdfs.delete(task);
    try { task.destroy(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- picks: the research seat's Preview (plan 4-§5.9.6)

/** The units each reader offers for words picked in it, in the order a pick is read; a grid's are its own. */
const TEXT_UNITS = Object.freeze({
  text: ['word', 'sentence', 'line', 'paragraph', 'selection'],
  md: ['word', 'sentence', 'line', 'item', 'paragraph', 'selection'],
  word: ['word', 'sentence', 'item', 'paragraph', 'selection'],
  deck: ['word', 'item', 'paragraph', 'slide', 'selection'],
  pdf: ['word', 'line', 'item', 'paragraph', 'cell', 'row', 'column', 'selection'],
});
/** What a pick of an untagged PDF cannot be read as, and what to send instead. */
export const UNTAGGED = 'Tables in this PDF cannot be read as cells — send the region as a picture';
/** A list's marker at the start of a line of an untagged PDF: a bullet, a dash, or a number or letter with its stop. */
const MARKER = /^\s*(?:[•◦▪‣∙·*–—-]|\d{1,3}[.)]|[a-zA-Z][.)])\s/;
/** The roles of a tagged PDF's structure a pick is read by. */
const PARA_ROLES = ['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BlockQuote', 'Caption', 'Note'];

/**
 * A page's structure tree (pdf.js getStructTree) read into nodes, each {role, parent, kids, ids} (`ids` every marked content
 * id under it, in reading order), and each marked content's id → the node that holds it: {byId, tagged}. Untagged: no ids.
 */
function structOf(tree) {
  const byId = new Map();
  const walk = (n, parent) => {
    const node = { role: String(n.role || ''), parent, kids: [], ids: [] };
    for (const c of Array.isArray(n.children) ? n.children : []) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'content' && typeof c.id === 'string') { byId.set(c.id, node); node.ids.push(c.id); continue; }
      if (c.role === undefined) continue;
      const kid = walk(c, node);
      node.kids.push(kid);
      node.ids.push(...kid.ids);
    }
    return node;
  };
  if (tree && typeof tree === 'object') walk(tree, null);
  return { byId, tagged: byId.size > 0 };
}
/** The nearest node at or above `node` whose role is one of `roles`, or null. */
const upTo = (node, roles) => { for (let n = node; n; n = n.parent) if (roles.includes(n.role)) return n; return null; };
/** The text spans of a PDF's text layer (not the marked content around them), with their words. */
const spansIn = (root) => [...root.querySelectorAll('span[role="presentation"]')].filter((s) => s.textContent.length > 0);
/** The marked content id a text span sits in ('' for none). */
const contentOf = (span) => { const m = span.parentElement && span.parentElement.closest('.markedContent[id]'); return m ? m.id : ''; };

/**
 * A page's text spans in lines, as they sit on the page: each line {spans (left to right), top, bottom}, the lines top to
 * bottom. Spans whose middles stand within half a line's height of each other are one line.
 */
function linesOf(spans) {
  const boxes = spans.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((b) => b.r.height > 0);
  boxes.sort((a, b) => (a.r.top + a.r.bottom) / 2 - (b.r.top + b.r.bottom) / 2 || a.r.left - b.r.left);
  const lines = [];
  for (const b of boxes) {
    const mid = (b.r.top + b.r.bottom) / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(mid - last.mid) <= Math.max(b.r.height, last.h) / 2) { last.spans.push(b); last.top = Math.min(last.top, b.r.top); last.bottom = Math.max(last.bottom, b.r.bottom); last.h = Math.max(last.h, b.r.height); }
    else lines.push({ spans: [b], top: b.r.top, bottom: b.r.bottom, h: b.r.height, mid });
  }
  for (const l of lines) l.spans.sort((a, b) => a.r.left - b.r.left);
  return lines.map((l) => ({ spans: l.spans.map((b) => b.el), boxes: l.spans, top: l.top, bottom: l.bottom, h: l.h }));
}
/** A line's words: its spans' words, a space between two that stand apart and hold none between them. */
function lineText(boxes, slices) {
  let out = '';
  let prev = null;
  for (const b of boxes) {
    const t = slices ? slices.get(b.el) : b.el.textContent;
    if (t === undefined) continue;
    if (prev && out && !/\s$/.test(out) && !/^\s/.test(t) && b.r.left - prev.r.right > prev.r.height * 0.15) out += ' ';
    out += t;
    prev = b;
  }
  return out.replace(/\s+/g, ' ').trim();
}
/** Where `node` (an offset in it) falls in `el`'s words: the length of the words before it. */
function offsetIn(el, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(el);
  try { r.setEnd(node, offset); } catch { return 0; }
  return r.toString().length;
}
/** The part of `el`'s words `range` holds: {start, end}, or null where it holds none. */
function partOf(el, range) {
  if (!range.intersectsNode(el)) return null;
  const len = el.textContent.length;
  const start = el.contains(range.startContainer) ? offsetIn(el, range.startContainer, range.startOffset) : 0;
  const end = el.contains(range.endContainer) ? offsetIn(el, range.endContainer, range.endOffset) : len;
  return end > start ? { start, end } : null;
}
/** The cell of a table under a node, or null: a grid's (a sheet's, a CSV's) or a document's table's. */
const cellOf = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); const td = el && el.closest ? el.closest('table.dv-grid td, table.dv-table td, table.dv-table th') : null; return td && td.dataset.r !== undefined ? td : null; };
/** The caret where a point is: {node, offset}, or null (caretPositionFromPoint where the browser has it, else caretRangeFromPoint). */
function caretAt(x, y) {
  if (typeof document.caretPositionFromPoint === 'function') { const p = document.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; }
  if (typeof document.caretRangeFromPoint === 'function') { const r = document.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, offset: r.startOffset } : null; }
  return null;
}
/** The CSS Custom Highlight API's registry, where the browser has it (Safari 17.2): else a pick is outlined on its blocks. */
const highlights = () => (typeof CSS === 'object' && CSS && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);
const PICK_HIGHLIGHT = 'agm-pick';
/** A page picture's backing store, in pixels, at most, for a part of a page or a picture (pdf.js's own on a phone). */
const regionScale = (w, h) => Math.min(PICTURE_EDGE / Math.max(w, h, 1), PICTURE_SIDE / Math.max(w, 1), PICTURE_SIDE / Math.max(h, 1), Math.sqrt(PICTURE_PIXELS / Math.max(1, w * h)));
/** A canvas's picture as a Blob: PNG, or JPEG at 0.9 for a photograph's (a JPEG's) part. */
const blobOf = (c, jpeg) => new Promise((resolve) => c.toBlob((b) => resolve(b || null), jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.9 : undefined));

class View {
  constructor(box, source, opts) {
    this.box = box;
    this.source = source;
    this.seat = seatOf(opts.seat);
    this.name = String(opts.name || (source.file && source.file.name) || '');
    this.kind = kindOf(typeof opts.ext === 'string' && opts.ext ? 'file.' + opts.ext : this.name, opts.ext ? '' : opts.mime || (source.file && source.file.type));
    this.deadline = opts.deadline > 0 ? opts.deadline : BOUNDS.pdfMs;
    this.ranged = opts.ranged === true;
    this.want = opts.at || null;
    this.dead = false;
    this.urls = [];
    this.off = [];
    this.units = [];       // the place's units in order: {n, el}
    this.total = 0;
    this.zoom = { mode: 'width', scale: 1 };
    this.model = null;
    this.hits = [];
    this.hit = -1;
    this.abort = typeof AbortController === 'function' ? new AbortController() : null;
    this.kept = null;      // the last place seen while the box was laid out
    this.frozen = false;   // the box lost its layout: the view waits, at `kept`, for it to come back
    // Picks, on the research seat alone: the blocks a selection is read from (an element → its block), the pick now, the
    // sheets' labels, and who is told of each change.
    this.picks = this.seat === 'research';
    this.blockEls = new Map();
    this.picked = null;
    this.pickers = new Set();
    this.menuers = new Set();
    this.labelsBy = new Map();
    this.tables = [];
    this.gridSheets = new WeakMap();   // a sheet's or a CSV's grid → {sheet, n}: the sheet a pick in it reads
    this.pics = new WeakMap();         // a picture in a Word document or a deck, not hidden → its block: a tap picks it
    this.textSizes = new Map();        // a PDF's page at a zoom → how tall its body text stands (textSize), 64 at most
    this.structs = new Map();
    this.regionOn = false;
    box.textContent = '';
    this.root = make('div', 'dv');
    this.root.dataset.kind = this.kind;
    this.bar = make('div', 'dv-bar');
    this.notice = make('p', 'dv-notice');
    this.notice.hidden = true;
    this.body = make('div', 'dv-body');
    this.root.append(this.bar, this.notice, this.body);
    box.appendChild(this.root);
    // The document's body takes the focus (PageUp and PageDown move the page box from it), named by the file.
    this.body.tabIndex = 0;
    this.body.setAttribute('aria-label', this.name || 'Document');
    this.listen(box, 'scroll', () => this.scrolled(), { passive: true });
    this.listen(box, 'keydown', (e) => this.key(e));
    if (this.picks) this.listenPicks();
    // A box that loses its layout (its panel collapsed) leaves the view as it was; one laid out again goes back to the
    // place kept. Any other change of size is the page's to call refit() for.
    if (typeof ResizeObserver === 'function') {
      this.sized = new ResizeObserver(() => { if (!this.laidOut()) this.frozen = true; else if (this.frozen) this.refit(); });
      this.sized.observe(box);
    }
    let settle;
    this.ready = new Promise((r) => { settle = r; });
    this.settle = settle;
    this.draw().then((r) => this.done(r), () => this.done({ state: 'failed', words: WORDS.shape }));
  }

  listen(target, type, fn, o) { target.addEventListener(type, fn, o); this.off.push(() => target.removeEventListener(type, fn, o)); }

  done(r) {
    if (this.dead || this.settled) return;
    this.settled = true;
    if (r.state === 'failed') this.fail(r.words);
    else this.keep();
    this.settle(r);
  }
  /** Whether the box is laid out: rendered, with a size. A collapsed panel's is not. */
  laidOut() {
    const r = this.box.getBoundingClientRect();
    return this.box.isConnected && r.width > 0 && r.height > 0;
  }
  /**
   * The place seen now kept, while the box is laid out and the view is not waiting for it; a box found with no layout
   * makes the view wait (its next refit lays it out again at the place kept).
   */
  keep() {
    if (!this.laidOut()) { this.frozen = true; return; }
    if (!this.frozen) this.kept = this.place();
  }
  fail(words) {
    this.body.textContent = '';
    this.bar.textContent = '';
    this.body.appendChild(make('p', 'error', words));
  }
  say(words) {
    this.notice.textContent = words;
    this.notice.hidden = !words;
  }

  /** The source's bytes: a local file's, or the upload's, fetched without a copy in the browser's cache. */
  async bytes() {
    if (this.source.file) return this.source.file.arrayBuffer();
    const r = await fetch(this.source.url, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error('fetch');
    return r.arrayBuffer();
  }

  async draw() {
    try {
      switch (this.kind) {
        case 'pdf': return await this.pdf();
        case 'image': return await this.image();
        case 'text': return await this.textFile();
        case 'md': return await this.markdown();
        case 'csv': return await this.csv();
        case 'word': return await this.office('word');
        case 'book': return await this.office('sheet');
        case 'deck': return await this.office('deck');
        default:
          this.body.appendChild(make('p', 'muted', 'This file is not shown here. Save it as a PDF to show it.'));
          return { state: 'failed', words: 'not a file AGMessage shows' };
      }
    } catch (e) {
      return { state: 'failed', words: e && e.message === 'fetch' ? 'the file could not be fetched' : WORDS.shape };
    }
  }

  // ---------------------------------------------------------------- the bar: the place, zoom and find

  /** The page box: a number to type, ‹ ›, "of N", with the words before it (`prefix`: p., Slide, Line, Row). */
  placeBox(label, total, prefix) {
    this.prefix = prefix || label;
    this.total = total;
    const g = make('div', 'dv-place');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    const prev = make('button', 'btn ghost small dv-prev', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous');
    this.pre = make('span', 'dv-pre');
    this.input = make('input', 'dv-n');
    this.input.type = 'text';
    this.input.inputMode = 'numeric';
    this.input.setAttribute('aria-label', label + ' number');
    this.input.value = '1';
    this.of = make('span', 'dv-of');
    const next = make('button', 'btn ghost small dv-next', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next');
    g.append(prev, this.pre, this.input, this.of, next);
    this.listen(prev, 'click', () => this.step(-1));
    this.listen(next, 'click', () => this.step(1));
    this.listen(this.input, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const n = parseInt(this.input.value, 10);
      if (n > 0) this.goto({ page: Math.min(n, this.total), offset: 0 });
    });
    this.bar.appendChild(g);
    this.label = label;
    this.current = 1;
    this.showPlace();
  }
  showPlace() {
    if (!this.input) return;
    const approx = this.kind === 'word' && this.approxAt(this.current);
    this.pre.textContent = this.kind === 'word' ? (approx ? '≈ p.' : 'p.') : this.prefix;
    if (document.activeElement !== this.input) this.input.value = String(this.current);
    this.of.textContent = 'of ' + (approx ? '≈ ' : '') + this.total;
    const g = this.input.parentNode;
    const differs = this.kind === 'word' && this.differsAt(this.current);
    const said = globalThis.AGMWord.WORDS;
    g.title = (approx ? said.approx : '') + (differs ? (approx ? '; ' : '') + said.differs : '');
    if (this.differsNote) this.differsNote.hidden = !differs;
  }
  /** What the page box says, as words: "p. 12 of 30", "≈ p. 12 of ≈ 30", "Slide 3 of 12", "Line 40 of 200". */
  placeWords() {
    if (!this.total) return '';
    if (this.kind === 'word') return pageWords(this.current, this.total, this.approxAt(this.current));
    if (this.kind === 'pdf') return 'p. ' + this.current + ' of ' + this.total;
    return this.label + ' ' + this.current + ' of ' + this.total;
  }
  step(d) { this.goto({ page: Math.max(1, Math.min(this.total, this.current + d)), offset: 0 }); }
  key(e) {
    if (!this.total || (e.key !== 'PageDown' && e.key !== 'PageUp')) return;
    if (!['pdf', 'deck', 'word'].includes(this.kind)) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
    e.preventDefault();
    this.step(e.key === 'PageDown' ? 1 : -1);
  }

  zoomBox() {
    const g = make('div', 'dv-zoom');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', 'Zoom');
    const b = (text, label, fn) => { const x = make('button', 'btn ghost small', text); x.type = 'button'; x.setAttribute('aria-label', label); this.listen(x, 'click', fn); g.appendChild(x); return x; };
    b('−', 'Zoom out', () => this.setZoom({ mode: 'free', scale: this.scaleNow() / ZOOM_STEP }));
    b('Fit width', 'Fit the width', () => this.setZoom({ mode: 'width', scale: 1 }));
    b('Fit page', 'Fit the page', () => this.setZoom({ mode: 'page', scale: 1 }));
    b('+', 'Zoom in', () => this.setZoom({ mode: 'free', scale: this.scaleNow() * ZOOM_STEP }));
    this.bar.appendChild(g);
    // A pinch: a trackpad's arrives as a wheel with Ctrl held; a touch screen's as two pointers moving apart.
    this.listen(this.box, 'wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom({ mode: 'free', scale: this.scaleNow() * (e.deltaY < 0 ? 1.1 : 1 / 1.1) });
    }, { passive: false });
    const pointers = new Map();
    let from = 0;
    this.listen(this.box, 'pointerdown', (e) => { pointers.set(e.pointerId, e); if (pointers.size === 2) from = spread(pointers); });
    this.listen(this.box, 'pointermove', (e) => { if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e); });
    const up = (e) => {
      if (pointers.size === 2 && from > 0) {
        const to = spread(pointers);
        if (Math.abs(to - from) > 24) this.setZoom({ mode: 'free', scale: this.scaleNow() * (to / from) });
      }
      pointers.delete(e.pointerId);
      from = 0;
    };
    this.listen(this.box, 'pointerup', up);
    this.listen(this.box, 'pointercancel', up);
  }
  scaleNow() { return this.zoom.mode === 'free' ? this.zoom.scale : this.fitScale(this.zoom.mode); }
  setZoom(z) {
    const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z.scale));
    const at = this.place();
    this.zoom = { mode: z.mode, scale };
    this.layout();
    this.goto({ page: at.page, offset: at.offset });
  }

  findBox() {
    const g = make('form', 'dv-find');
    g.setAttribute('role', 'search');
    const input = make('input', 'dv-q');
    input.type = 'search';
    input.placeholder = 'Find';
    input.setAttribute('aria-label', 'Find in this file');
    const go = make('button', 'btn ghost small', 'Next');
    go.type = 'submit';
    this.found = make('span', 'dv-found muted');
    this.found.setAttribute('role', 'status');
    g.append(input, go, this.found);
    this.listen(g, 'submit', (e) => { e.preventDefault(); this.find(input.value); });
    this.bar.appendChild(g);
  }

  // ---------------------------------------------------------------- PDF

  async pdf() {
    const lib = await loadPdfJs();
    if (this.dead) return { state: 'failed', words: '' };
    this.lib = lib;
    const params = { worker: sharedWorker(lib), withCredentials: false, isEvalSupported: false, enableXfa: false, maxImageSize: PDF_MAX_IMAGE };
    if (this.source.file) params.data = new Uint8Array(await this.source.file.arrayBuffer());
    else params.url = this.source.url;
    // pdf.js stops fetching ahead only with streaming off too: then only what is drawn is fetched, each range `no-store`.
    if (this.ranged && params.url) { params.disableStream = true; params.disableAutoFetch = true; }
    const task = lib.getDocument(params);
    this.task = task;
    openPdfs.add(task);
    let expired = false;
    this.timer = setTimeout(() => {
      expired = true;
      this.closePdf(true);
      // The shared worker may be the one stuck: it goes too, and the next document makes a new one.
      if (pdfWorker) { try { pdfWorker.destroy(); } catch { /* already gone */ } pdfWorker = null; }
      if (this.onFirst) { this.onFirst(); this.onFirst = null; }
      this.done({ state: 'failed', words: WORDS.pdfTime });
    }, this.deadline);
    const doc = await task.promise;
    if (this.dead || expired) return { state: 'failed', words: WORDS.pdfTime };
    this.doc = doc;
    const first = await doc.getPage(1);
    if (this.dead || expired) return { state: 'failed', words: WORDS.pdfTime };
    this.sizes = new Map([[1, first.getViewport({ scale: 1 })]]);
    this.pages = new Map([[1, first]]);
    this.placeBox('Page', doc.numPages, 'p.');
    this.zoomBox();
    this.findBox();
    this.drawn = new Map();   // page → the zoom generation it was drawn at
    this.renders = new Set(); // the pages being drawn now, cancelled when the document closes
    this.gen = 0;
    this.pageEls = [];
    const frame = make('div', 'dv-pdf');
    for (let n = 1; n <= doc.numPages; n++) {
      const p = make('div', 'dv-page');
      p.dataset.page = String(n);
      const c = make('canvas', 'pdf-page pdf-page-pending');
      c.setAttribute('aria-label', 'Page ' + n);
      p.appendChild(c);
      frame.appendChild(p);
      this.pageEls.push(p);
      this.units.push({ n, el: p });
    }
    this.body.appendChild(frame);
    this.firstDrawn = new Promise((r) => { this.onFirst = r; });
    this.seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(Number(e.target.dataset.page));
    }, { root: this.box, rootMargin: '400px 0px' });
    this.layout();
    for (const p of this.pageEls) this.seen.observe(p);
    if (this.want) this.goto(this.want);
    await this.firstDrawn;
    clearTimeout(this.timer);
    if (this.dead || expired) return { state: 'failed', words: WORDS.pdfTime };
    return { state: 'shown', words: '' };
  }
  fitScale(mode) {
    const base = this.kind === 'image' ? this.natural : this.sizes && this.sizes.get(this.current || 1);
    if (!base) return 1;
    const w = Math.max(120, this.box.clientWidth - 40);
    const h = Math.max(120, this.box.clientHeight - (this.bar.offsetHeight || 0) - 40);
    return mode === 'page' ? Math.min(w / base.width, h / base.height) : w / base.width;
  }
  /** Each page's placeholder sized for the zoom; drawn again as it comes into view. */
  layout() {
    if (this.kind === 'image') return this.layoutImage();
    if (this.kind !== 'pdf' || !this.pageEls) return;
    this.gen++;
    const scale = this.scaleNow();
    const base1 = this.sizes.get(1);
    for (const p of this.pageEls) {
      const n = Number(p.dataset.page);
      const base = this.sizes.get(n) || base1;
      p.style.width = Math.floor(base.width * scale) + 'px';
      p.style.height = Math.floor(base.height * scale) + 'px';
    }
    // The pages in view now are drawn at once at the new size; the rest as they come into view.
    for (const p of this.pageEls) {
      const r = p.getBoundingClientRect();
      const b = this.box.getBoundingClientRect();
      if (r.bottom >= b.top - 400 && r.top <= b.bottom + 400) this.renderPage(Number(p.dataset.page));
    }
  }
  async renderPage(n) {
    if (this.dead || !this.doc || this.drawn.get(n) === this.gen) return;
    const gen = this.gen;
    this.drawn.set(n, gen);
    let page = this.pages.get(n);
    try {
      if (!page) { page = await this.doc.getPage(n); this.pages.set(n, page); }
    } catch { this.drawn.delete(n); return; }
    if (this.dead || gen !== this.gen) return;
    const base = page.getViewport({ scale: 1 });
    if (!this.sizes.has(n)) {
      this.sizes.set(n, base);
      const scale0 = this.scaleNow();
      const p0 = this.pageEls[n - 1];
      p0.style.width = Math.floor(base.width * scale0) + 'px';
      p0.style.height = Math.floor(base.height * scale0) + 'px';
    }
    const scale = this.scaleNow();
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = Math.min(dpr, Math.sqrt(CANVAS_PIXELS / Math.max(1, vp.width * vp.height)));
    const off = make('canvas');
    off.width = Math.floor(vp.width * ratio);
    off.height = Math.floor(vp.height * ratio);
    const task = page.render({ canvasContext: off.getContext('2d'), viewport: page.getViewport({ scale: scale * ratio }) });
    this.renders.add(task);
    try {
      await task.promise;
    } catch { if (gen === this.gen) this.drawn.delete(n); return; } finally { this.renders.delete(task); }
    if (this.dead || gen !== this.gen) return;
    const host = this.pageEls[n - 1];
    const c = host.querySelector('canvas');
    c.width = off.width;
    c.height = off.height;
    c.style.width = Math.floor(vp.width) + 'px';
    c.style.height = Math.floor(vp.height) + 'px';
    c.getContext('2d').drawImage(off, 0, 0);
    c.classList.remove('pdf-page-pending');
    if (this.onFirst) { this.onFirst(); this.onFirst = null; }
    if (this.picks) this.textLayer(n, page, scale, gen);
  }
  /**
   * The text layer of page `n` (the research seat's: what a pick reads), built for a page in view as it is drawn and built
   * again at a new zoom: pdf.js's TextLayer, its marked content kept (each span's id is its structure's content id), and
   * the page's structure tree read once, where the PDF carries one (a tagged PDF).
   */
  async textLayer(n, page, scale, gen) {
    const host = this.pageEls[n - 1];
    const old = host.querySelector('.textLayer');
    if (old && old.dataset.gen === String(gen)) return;
    if (old) old.remove();
    host.style.setProperty('--scale-factor', String(scale));
    const layer = make('div', 'textLayer');
    layer.dataset.gen = String(gen);
    layer.dataset.page = String(n);
    host.appendChild(layer);
    try {
      const tl = new this.lib.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true }), container: layer, viewport: page.getViewport({ scale }) });
      await tl.render();
      if (!this.structs.has(n)) this.structs.set(n, structOf(await page.getStructTree()));
    } catch {
      layer.remove();   // a page whose text cannot be read offers the picture and the region alone
    }
  }
  /**
   * The document closed: its pages being drawn cancelled, and the document destroyed in the shared worker once it has
   * finished loading (one destroyed mid-load fails inside the worker when its data arrives), or after 30 s whatever it
   * is doing; `now` destroys it at once (its deadline passed, and the worker goes with it).
   */
  closePdf(now) {
    if (this.seen) this.seen.disconnect();
    for (const r of this.renders || []) { try { r.cancel(); } catch { /* a drawing already ended */ } }
    if (this.task) {
      const task = this.task;
      this.task = null;
      openPdfs.delete(task);
      let closed = false;
      const close = () => { if (closed) return; closed = true; try { task.destroy(); } catch { /* a document already destroyed */ } };
      if (now) close();
      else { task.promise.then(close, close); setTimeout(close, 30000); }
    }
    this.doc = null;
  }
  /** The text of the PDF's pages, as many as `upTo`, "[page N] …" each. */
  async pdfText(upTo) {
    const doc = this.doc;
    if (!doc) return [];
    const out = [];
    for (let n = 1; n <= Math.min(doc.numPages, upTo); n++) {
      if (this.dead || this.doc !== doc) break;
      try {
        const page = this.pages.get(n) || await doc.getPage(n);
        const tc = await page.getTextContent();
        out.push({ n, text: tc.items.map((x) => x.str).join(' ') });
      } catch { break; }
    }
    return out;
  }

  // ---------------------------------------------------------------- an image

  async image() {
    const bytes = new Uint8Array(await this.bytes());
    if (this.dead) return { state: 'failed', words: '' };
    // Its size from its header, before anything decodes it.
    const size = await globalThis.AGMImage.sizeOf(bytes);
    if (!size) return { state: 'failed', words: 'the picture could not be read' };
    if (size.width * size.height > BOUNDS.pixels) return { state: 'failed', words: WORDS.pixels };
    const url = this.url(new Blob([bytes]));
    const img = make('img', 'dv-img');
    img.alt = this.name;
    // A picture is never dragged out on the Board's seats; on the research seat a drag over it draws a region to send.
    img.setAttribute('draggable', 'false');
    img.src = url;
    try { await img.decode(); } catch { return { state: 'failed', words: 'the picture could not be read' }; }
    if (img.naturalWidth * img.naturalHeight > BOUNDS.pixels) { this.drop(url); return { state: 'failed', words: WORDS.pixels }; }
    this.natural = { width: img.naturalWidth, height: img.naturalHeight };
    this.img = img;
    this.zoomBox();
    this.body.appendChild(img);
    this.layoutImage();
    if (this.picks) this.root.classList.add('dv-regions');
    return { state: 'shown', words: '' };
  }
  layoutImage() {
    if (!this.img) return;
    const s = this.scaleNow();
    this.img.style.width = Math.floor(this.natural.width * s) + 'px';
    this.img.style.height = Math.floor(this.natural.height * s) + 'px';
  }
  url(blob) { const u = URL.createObjectURL(blob); this.urls.push(u); return u; }
  drop(url) { URL.revokeObjectURL(url); this.urls = this.urls.filter((u) => u !== url); }

  // ---------------------------------------------------------------- text, Markdown, CSV

  async textFile() {
    const { text } = decodeText(await this.bytes());
    if (this.dead) return { state: 'failed', words: '' };
    const { lines, truncated } = textLines(text);
    const pre = make('div', 'doc-text dv-lines');
    lines.forEach((line, i) => {
      const d = make('div', 'dv-line', line || ' ');
      d.dataset.line = String(i + 1);
      d.dataset.find = '1';
      pre.appendChild(d);
      this.units.push({ n: i + 1, el: d });
      if (this.picks) this.blockEls.set(d, { kind: 'line', text: line, at: { line: i + 1 } });
    });
    this.model = { kind: 'text', blocks: lines.map((t, i) => ({ kind: 'p', text: t, at: { line: i + 1 } })) };
    this.placeBox('Line', lines.length);
    this.findBox();
    this.body.appendChild(pre);
    this.say(truncated ? WORDS.lines : '');
    if (this.want) this.goto(this.want);
    return { state: 'shown', words: '' };
  }

  async markdown() {
    const { text } = decodeText(await this.bytes());
    if (this.dead) return { state: 'failed', words: '' };
    const { blocks, truncated } = markdownBlocks(text, { inert: inertText });
    this.model = { kind: 'md', blocks };
    const host = make('div', 'doc-html');
    this.drawBlocks(host, blocks, (b, el) => { el.dataset.line = String(b.at.line); this.units.push({ n: b.at.line, el }); });
    this.placeBox('Line', textLines(text).lines.length);
    this.findBox();
    this.body.appendChild(host);
    this.say(truncated ? WORDS.lines : '');
    if (this.want) this.goto(this.want);
    return { state: 'shown', words: '' };
  }

  async csv() {
    const { text } = decodeText(await this.bytes());
    if (this.dead) return { state: 'failed', words: '' };
    const { rows, truncated, cutCols } = parseCsv(text);
    const sheet = { name: this.name, hidden: 0, rows, hiddenRows: [], hiddenCols: [], noValue: [], origin: { r: 0, c: 0 } };
    this.model = { kind: 'book', sheets: [sheet] };
    this.placeBox('Row', rows.length);
    this.findBox();
    const host = make('div', 'doc-html doc-sheet');
    host.appendChild(this.grid(sheet, (r, tr) => this.units.push({ n: r + 1, el: tr })));
    this.body.appendChild(host);
    this.say([truncated ? rowsWords(rows.length) : '', cutCols ? WORDS.cols : ''].filter(Boolean).join(' '));
    if (this.want) this.goto(this.want);
    return { state: 'shown', words: '' };
  }

  // ---------------------------------------------------------------- Office files, in the document worker

  async office(task) {
    const bytes = await this.bytes();
    if (this.dead) return { state: 'failed', words: '' };
    this.body.appendChild(make('p', 'muted', 'Reading…'));
    const r = await readInWorker(bytes, task, { opts: { ext: extOf(this.name) }, signal: this.abort && this.abort.signal });
    if (this.dead) return { state: 'failed', words: '' };
    this.body.textContent = '';
    if (!r.ok) {
      const words = r.why === 'time' ? WORDS.time + (this.seat === 'research' ? ' ' + WORDS.timeBackstage : '')
        : r.why === 'hidden' ? WORDS.hidden : r.why === 'dtd' ? WORDS.dtd : r.why === 'packed' ? WORDS.packed : r.why === 'device' ? WORDS.device : WORDS.shape;
      return { state: 'failed', words };
    }
    if (task === 'sheet') return this.book(r.book);
    if (task === 'word') return this.word(r);
    return this.deck(r);
  }

  book(book) {
    this.model = book;
    const plan = planBook(book, this.seat);
    const tabs = make('div', 'sheet-tabs');
    tabs.setAttribute('role', 'tablist');
    const host = make('div', 'doc-html doc-sheet');
    this.sheetHost = make('div', 'sheet-view');
    this.sheets = plan.sheets;
    this.label = 'Sheet';
    this.total = plan.sheets.length;
    this.current = 1;
    plan.sheets.forEach((s, i) => {
      const b = make('button', 'sheet-tab' + (i === 0 ? ' active' : ''), s.name + (s.hidden ? ' (hidden)' : ''));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === 0));
      if (s.hidden) b.classList.add('dv-hidden');
      this.listen(b, 'click', () => this.showSheet(i + 1));
      tabs.appendChild(b);
    });
    this.tabs = tabs;
    if (plan.sheets.length > 1 || plan.notShown) this.bar.appendChild(tabs);
    this.findBox();
    host.appendChild(this.sheetHost);
    this.body.appendChild(host);
    this.bookNote = plan.notShown;
    if (!plan.sheets.length) { this.say(plan.notShown); return { state: 'shown', words: plan.notShown }; }
    this.showSheet(this.want && this.want.page > 0 ? Math.min(this.want.page, plan.sheets.length) : 1);
    return { state: 'shown', words: '' };
  }
  showSheet(n) {
    const s = this.sheets[n - 1];
    if (!s) return;
    this.current = n;
    [...this.tabs.children].forEach((b, i) => { b.classList.toggle('active', i === n - 1); b.setAttribute('aria-selected', String(i === n - 1)); });
    // A pick is of the sheet it was made in: another sheet drawn lets it go.
    if (this.picked && this.picked.type === 'grid' && this.sheetHost.contains(this.picked.table)) this.clearPick();
    this.sheetHost.textContent = '';
    this.units = [];
    this.sheetHost.appendChild(this.grid(s, (r, tr) => this.units.push({ n: r + 1, el: tr })));
    const plan = planSheet(s, this.seat);
    this.say([this.bookNote, plan.notShown, s.truncated ? rowsWords(s.shown || s.rows.length) : '', s.cutCols ? WORDS.cols : ''].filter(Boolean).join(' '));
    this.keep();
  }
  /** A sheet's grid as this seat draws it: column letters and row numbers, hidden ones marked on the research seat. */
  grid(sheet, unit) {
    const plan = planSheet(sheet, this.seat);
    const table = make('table', 'dv-grid');
    // A hidden sheet is drawn on the research seat dimmed and marked, and nothing of it is ever picked.
    if (sheet.hidden) table.classList.add('dv-hidden');
    else if (this.picks) { table.tabIndex = 0; table.setAttribute('aria-label', 'Cells: tap or use the arrow keys to pick, Shift to pick a range'); }
    this.gridOf = { sheet, plan };
    this.gridSheets.set(table, { sheet, n: this.kind === 'book' ? this.current || 1 : 1 });
    const head = make('tr');
    head.appendChild(make('th', 'dv-corner'));
    for (const c of plan.cols) {
      const th = make('th', 'dv-col', columnName(c + sheet.origin.c) + ((sheet.hiddenCols || []).includes(c) ? ' hidden' : ''));
      th.dataset.c = String(c);
      if ((sheet.hiddenCols || []).includes(c)) th.classList.add('dv-hidden');
      head.appendChild(th);
    }
    const thead = make('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = make('tbody');
    for (const row of plan.rows) {
      const tr = make('tr');
      if (row.hidden) tr.classList.add('dv-hidden');
      const rh = make('th', 'dv-row', String(row.r + 1 + sheet.origin.r) + (row.hidden ? ' hidden' : ''));
      rh.dataset.r = String(row.r);
      tr.appendChild(rh);
      for (const cell of row.cells) {
        const td = make('td', '', cell.noValue ? WORDS.noValue : cell.text);
        td.dataset.r = String(row.r);
        td.dataset.c = String(cell.c);
        if (cell.noValue) td.classList.add('dv-novalue');
        if (cell.hidden) td.classList.add('dv-hidden');
        else if (!row.hidden && !cell.noValue && cell.text) td.dataset.find = '1';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
      unit(row.r, tr);
    }
    table.appendChild(tbody);
    return table;
  }

  word(r) {
    const map = new Map();
    for (const p of r.pictures || []) map.set('agm-img:' + p.n, p);
    const { blocks } = parseInert(r.html);
    const W = globalThis.AGMWord;
    const scan = { ok: true, basis: r.scan.basis, pages: r.scan.pages, approx: r.scan.approx, paras: r.scan.paras };
    const pages = W.place(blocks.map((b) => (b.kind === 'img' ? '' : b.text)), scan);
    blocks.forEach((b, i) => { b.page = pages[i].page; b.pageApprox = pages[i].approx; b.differs = pages[i].differs; });
    this.model = { kind: 'word', blocks, scan, hidden: Number.isInteger(r.hidden) ? r.hidden : 0 };
    this.pageOf = new Map();
    const host = make('div', 'doc-html');
    let page = 0;
    this.placeBox('Page', scan.pages, 'p.');
    this.differsNote = make('span', 'dv-differs muted', W.WORDS.differs);
    this.differsNote.hidden = true;
    this.bar.appendChild(this.differsNote);
    this.findBox();
    // Each paragraph's place by its number (¶, `at.block`), where a take opens a Word document at one.
    this.blockAt = new Map();
    this.drawBlocks(host, blocks, (b, el) => {
      if (b.at && b.at.block > 0) this.blockAt.set(b.at.block, { el, page: b.page });
      if (b.page !== page) {
        page = b.page;
        const mark = make('div', 'dv-pagemark', (b.pageApprox ? '≈ p. ' : 'p. ') + page);
        el.before(mark);
        this.units.push({ n: page, el: mark });
        this.pageOf.set(page, b);
      }
    }, map);
    this.body.appendChild(host);
    this.showPlace();
    if (this.want) this.goto(this.want);
    return { state: 'shown', words: '' };
  }
  approxAt(n) {
    if (!this.model || this.model.kind !== 'word') return false;
    if (this.model.scan.approx) return true;
    const b = this.pageOf && this.pageOf.get(n);
    return !!(b && b.pageApprox);
  }
  differsAt(n) { const b = this.pageOf && this.pageOf.get(n); return !!(b && b.differs); }

  deck(r) {
    const pics = new Map((r.pictures || []).map((p) => [p.name, p]));
    let outline;
    try { outline = pptxOutline(r.parts || {}); } catch (e) { return { state: 'failed', words: e && e.why === 'dtd' ? WORDS.dtd : WORDS.shape }; }
    this.model = { kind: 'deck', slides: outline.slides };
    const plan = planSlides(outline, this.seat);
    this.placeBox('Slide', plan.slides.length);
    this.findBox();
    const host = make('div', 'doc-html dv-deck');
    plan.slides.forEach((s, i) => {
      const sec = make('section', 'dv-slide');
      sec.dataset.slide = String(s.n);
      if (s.hidden) sec.classList.add('dv-hidden');
      sec.appendChild(make('div', 'dv-slidemark', 'Slide ' + s.n + (s.hidden ? ' — hidden slide' : '')));
      this.drawBlocks(sec, s.blocks, null, pics);
      host.appendChild(sec);
      this.units.push({ n: i + 1, el: sec });
    });
    this.body.appendChild(host);
    this.say(plan.notShown);
    if (this.want) this.goto(this.want);
    return { state: 'shown', words: '' };
  }

  /**
   * Blocks drawn with the DOM and textContent: headings, paragraphs, items (with their marker), quotes, code, tables
   * (a first head row where the block has one) and pictures, whose bytes `pictures` holds (name → {type, bytes}).
   */
  drawBlocks(host, blocks, each, pictures) {
    const counters = [];
    for (const b of blocks) {
      let el;
      let number = 0;      // a numbered list's item: its number as drawn, which a quote of it starts from
      if (b.kind === 'h') el = make('h' + Math.min(6, Math.max(1, b.level || 1)), '', b.text);
      else if (b.kind === 'li') {
        el = make('p', 'dv-li');
        const lvl = Math.min(8, b.level || 1);
        el.style.paddingLeft = (lvl * 1.25) + 'rem';
        counters.length = lvl;
        counters[lvl - 1] = (counters[lvl - 1] || 0) + 1;
        if (b.list === 'ol') number = counters[lvl - 1];
        el.appendChild(make('span', 'dv-marker', b.list === 'ol' ? counters[lvl - 1] + '.' : '•'));
        el.appendChild(document.createTextNode(' '));
        el.appendChild(make('span', 'dv-li-text', b.text));
      } else if (b.kind === 'quote') el = make('blockquote', '', b.text);
      else if (b.kind === 'code') el = make('pre', 'dv-code', b.text);
      else if (b.kind === 'table') el = this.table(b);
      else if (b.kind === 'img') el = this.picture(b, pictures);
      else el = make('p', '', b.text);
      if (b.kind !== 'li') counters.length = 0;
      if (!el) continue;
      if (b.kind !== 'img' && b.kind !== 'table') el.dataset.find = '1';
      host.appendChild(el);
      if (each) each(b, el);
      // A block a pick may be read from: its words (a list item's after its marker), and a table's cells by the grid.
      if (this.picks && !b.hidden && !(host.classList && host.classList.contains('dv-hidden'))) {
        if (b.kind === 'table') { el.dataset.block = String(this.tables.length); this.tables.push({ b, el }); } else if (b.kind === 'img') { if (el.tagName === 'IMG') this.pics.set(el, { ...b, slide: Number(host.dataset.slide) || 0 }); } else this.blockEls.set(b.kind === 'li' ? el.querySelector('.dv-li-text') : el, { ...b, slide: Number(host.dataset.slide) || 0, ...(number ? { number } : {}) });
      }
      if (b.kind === 'table' && b.cut) host.appendChild(make('p', 'muted dv-cut', tableWords(b.rows.length, b.width)));
    }
  }
  table(b) {
    const t = make('table', 'dv-table');
    if (this.picks) { t.tabIndex = 0; t.setAttribute('aria-label', 'A table: tap a cell to pick it, Shift to pick a range'); }
    (b.rows || []).forEach((row, r) => {
      const tr = make('tr');
      for (const cell of row) {
        const td = make(r < (b.head || 0) ? 'th' : 'td', '', cell.text);
        td.dataset.r = String(r);
        td.dataset.c = String(cell.c);
        if (cell.colspan > 1) td.colSpan = cell.colspan;
        if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
        if (cell.text) td.dataset.find = '1';
        tr.appendChild(td);
      }
      t.appendChild(tr);
    });
    return t;
  }
  picture(b, pictures) {
    const p = pictures && pictures.get(b.src);
    if (!p) return null;
    // The document worker read its size from its header: one past the pixel bound, or of a size or type that cannot be
    // read, came without its bytes and is said in words, never decoded here.
    if (!p.bytes) return make('p', 'muted', p.why === 'pixels' ? WORDS.pixels : WORDS.picture);
    const img = make('img', 'dv-pic');
    img.alt = b.alt || '';
    img.dataset.type = String(p.type || '');
    if (this.seat !== 'research') img.setAttribute('draggable', 'false');
    const url = this.url(new Blob([p.bytes], { type: p.type }));
    img.src = url;
    img.decode().then(() => {
      if (img.naturalWidth * img.naturalHeight <= BOUNDS.pixels) return;
      this.drop(url);
      img.replaceWith(make('p', 'muted', WORDS.pixels));
    }, () => { this.drop(url); img.replaceWith(make('p', 'muted', WORDS.picture)); });
    return img;
  }

  // ---------------------------------------------------------------- the place

  topIn(el) { return el.getBoundingClientRect().top - this.box.getBoundingClientRect().top + this.box.scrollTop; }
  /** The unit at the top of the view (a PDF's: the page with the most of it in view). */
  unitNow() {
    if (!this.units.length) return null;
    const top = this.box.scrollTop + (this.bar.offsetHeight || 0) + 2;
    if (this.kind === 'pdf') {
      const view = this.box.getBoundingClientRect();
      let best = this.units[0], most = -1;
      for (const u of this.units) {
        const r = u.el.getBoundingClientRect();
        const seen = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
        if (seen > most) { most = seen; best = u; }
        if (r.top > view.bottom) break;
      }
      return best;
    }
    let at = this.units[0];
    for (const u of this.units) { if (this.topIn(u.el) <= top) at = u; else break; }
    return at;
  }
  scrolled() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dead) return;
      if (!this.laidOut()) { this.frozen = true; return; }
      if (this.frozen) return;
      if (this.kind !== 'book') {
        const u = this.unitNow();
        if (u && u.n !== this.current) { this.current = u.n; this.showPlace(); }
      }
      this.keep();
    });
  }
  /**
   * Whether the reader found hidden parts in the file: a hidden sheet, row or column, a hidden slide or shape, or Word's
   * hidden text (removed before the file was read). Whichever seat draws it, a file with one is never shown with Download
   * ticked.
   */
  hiddenParts() {
    return hiddenPartsOf(this.model);
  }
  /**
   * A PDF's page `n` drawn into a new picture, nothing else of the file in it: a PNG Blob whose long edge is
   * PICTURE_EDGE px, never over PICTURE_SIDE a side nor PICTURE_PIXELS in all; null for another kind, a page it does not
   * hold, or a drawing that failed.
   */
  async pagePicture(n) {
    if (this.kind !== 'pdf' || !this.doc || !(n >= 1) || n > this.doc.numPages) return null;
    try {
      const page = this.pages.get(n) || await this.doc.getPage(n);
      const blob = await drawPicture(page, this.renders);
      return this.dead ? null : blob;
    } catch {
      return null;
    }
  }
  /** Where the view is: {page, zoom, offset}, `offset` how far into its unit the view's top is (0 to 1). */
  place() {
    if (this.kind === 'book' ? !this.sheets : !this.units.length) return this.want || { page: 1, zoom: null, offset: 0 };
    // A box with no layout has no place of its own: the last one seen stands.
    if (this.frozen || !this.laidOut()) return this.kept || this.want || { page: 1, zoom: null, offset: 0 };
    if (this.kind === 'book') return { page: this.current || 1, zoom: null, offset: this.box.scrollTop };
    const u = this.unitNow();
    const zoom = this.kind === 'pdf' || this.kind === 'image' ? { mode: this.zoom.mode, scale: this.zoom.scale } : null;
    if (!u) return { page: 1, zoom, offset: this.box.scrollTop };
    const h = Math.max(1, u.el.offsetHeight);
    const offset = Math.max(0, Math.min(1, (this.box.scrollTop - this.topIn(u.el)) / h));
    return { page: u.n, zoom, offset };
  }
  /** Go to a place ({page, zoom?, offset?}, or a page number). */
  goto(at) {
    const a = typeof at === 'number' ? { page: at } : at || {};
    if (this.dead) return;
    // A drawn document in a box with no layout is neither scrolled nor laid out: the place asked for is kept for when
    // the box is laid out again.
    if ((this.kind === 'book' ? this.sheets : this.units.length) && !this.laidOut()) {
      const was = this.kept || {};
      this.kept = { page: a.page > 0 ? a.page : was.page || 1, zoom: a.zoom || was.zoom || null, offset: typeof a.offset === 'number' ? a.offset : 0, ...(a.block > 0 ? { block: a.block } : {}) };
      this.frozen = true;
      return;
    }
    if (a.zoom && (this.kind === 'pdf' || this.kind === 'image') && (a.zoom.mode !== this.zoom.mode || a.zoom.scale !== this.zoom.scale)) {
      this.zoom = { mode: a.zoom.mode, scale: a.zoom.scale };
      this.layout();
    }
    // Before the document is drawn, the place is kept for when it is.
    if (this.kind === 'book' ? !this.sheets : !this.units.length) { this.want = a; return; }
    if (this.kind === 'book') {
      if (a.page > 0 && a.page !== this.current) this.showSheet(Math.min(a.page, this.total));
      if (typeof a.offset === 'number') this.box.scrollTop = a.offset;
      this.keep();
      return;
    }
    // A Word paragraph by its number: the view at that paragraph, its page the place.
    const para = a.block > 0 && this.blockAt ? this.blockAt.get(a.block) : null;
    if (para) {
      this.box.scrollTop = Math.max(0, this.topIn(para.el) - (this.bar.offsetHeight || 0));
      this.current = para.page;
      this.showPlace();
      this.keep();
      return;
    }
    if (!(a.page > 0)) return;
    let u = this.units[0];
    for (const x of this.units) { if (x.n <= a.page) u = x; else break; }
    const off = typeof a.offset === 'number' && a.offset > 0 && a.offset <= 1 ? a.offset : 0;
    this.box.scrollTop = Math.max(0, this.topIn(u.el) + off * u.el.offsetHeight - (off ? 0 : (this.bar.offsetHeight || 0)));
    this.current = u.n;
    this.showPlace();
    if (this.kind === 'pdf') this.renderPage(u.n);
    this.keep();
  }
  /**
   * The view laid out again for the box's size (a resize, a splitter, a collapsed panel opened again), at the place it
   * was. While the box has no layout nothing is laid out: the view waits, at the place kept, until it has one.
   */
  refit() {
    if (this.dead) return;
    if (!this.laidOut()) { this.frozen = true; return; }
    const w = this.box.clientWidth, h = this.box.clientHeight;
    if (!this.frozen && this.fitted && this.fitted.w === w && this.fitted.h === h) return;
    const at = this.kept || this.place();
    this.frozen = false;
    this.fitted = { w, h };
    this.layout();
    this.goto(at);
  }

  /**
   * How tall a PDF page's body text stands, and the page's size, in the page's own units: {text, width, height}, the text
   * the median of its lines' heights on the text layer drawn for it; null where none is drawn (a page out of view, a scan
   * with no words). Read once a page at each zoom.
   */
  textSize(n) {
    if (this.kind !== 'pdf') return null;
    const key = n + '@' + this.scaleNow();
    if (this.textSizes.has(key)) return this.textSizes.get(key);
    const layer = this.body.querySelector('.textLayer[data-page="' + Number(n) + '"]');
    const page = this.pages && this.pages.get(n);
    if (!layer || !page) return null;
    const hs = linesOf(spansIn(layer)).map((l) => l.h).sort((a, b) => a - b);
    if (!hs.length) return null;
    const vp = page.getViewport({ scale: 1 });
    const out = { text: hs[Math.floor(hs.length / 2)] / this.scaleNow(), width: vp.width, height: vp.height };
    if (this.textSizes.size > 64) this.textSizes.clear();
    this.textSizes.set(key, out);
    return out;
  }
  /** What is in view: {page, rect} for a PDF or a picture, the blocks or rows in view for the others. */
  visible() {
    const view = this.box.getBoundingClientRect();
    if (this.kind === 'pdf' || this.kind === 'image') {
      const el = this.kind === 'pdf' ? (this.unitNow() || {}).el : this.img;
      if (!el) return { page: this.current || 1, rect: null };
      const r = el.getBoundingClientRect();
      const s = this.scaleNow();
      return { page: this.current || 1, rect: { x: Math.max(0, view.left - r.left) / s, y: Math.max(0, view.top - r.top) / s, w: (Math.min(r.right, view.right) - Math.max(r.left, view.left)) / s, h: (Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top)) / s } };
    }
    const seen = [];
    for (const el of this.body.querySelectorAll('[data-find]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > view.top && r.top < view.bottom) seen.push(el.textContent);
    }
    return { page: this.current || 1, text: seen };
  }

  // ---------------------------------------------------------------- find

  /** The next match of `words` after the place, moved to (on a page not yet drawn too): {n, of, page}. */
  async find(words) {
    const q = String(words || '').trim().toLowerCase();
    if (this.hitEl) { this.hitEl.classList.remove('dv-hit'); this.hitEl = null; }
    if (!q) { if (this.found) this.found.textContent = ''; return { n: 0, of: 0 }; }
    if (q !== this.query) {
      this.query = q;
      this.hit = -1;
      if (this.kind === 'pdf') {
        const pages = await this.pdfText(this.doc ? this.doc.numPages : 0);
        this.hits = pages.filter((p) => p.text.toLowerCase().includes(q)).map((p) => ({ page: p.n }));
      } else if (this.kind === 'book') {
        this.hits = [];
        this.sheets.forEach((s, i) => planSheet(s, this.seat).rows.forEach((row) => {
          if (!row.hidden && row.cells.some((c) => !c.hidden && c.text.toLowerCase().includes(q))) this.hits.push({ page: i + 1, row: row.r });
        }));
      } else this.hits = [...this.body.querySelectorAll('[data-find]')].filter((el) => el.textContent.toLowerCase().includes(q)).map((el) => ({ el }));
    }
    if (!this.hits.length) { if (this.found) this.found.textContent = 'Not found'; return { n: 0, of: 0 }; }
    this.hit = (this.hit + 1) % this.hits.length;
    const h = this.hits[this.hit];
    if (this.kind === 'pdf') this.goto({ page: h.page, offset: 0 });
    else if (this.kind === 'book') {
      this.goto({ page: h.page });
      const u = this.units.find((x) => x.n === h.row + 1);
      if (u) { this.box.scrollTop = Math.max(0, this.topIn(u.el) - (this.bar.offsetHeight || 0) - 8); this.mark(u.el); }
    } else {
      this.box.scrollTop = Math.max(0, this.topIn(h.el) - (this.bar.offsetHeight || 0) - 8);
      this.mark(h.el);
      const u = this.unitNow();
      if (u) { this.current = u.n; this.showPlace(); }
    }
    if (this.found) this.found.textContent = (this.hit + 1) + ' of ' + this.hits.length;
    return { n: this.hit + 1, of: this.hits.length, page: this.kind === 'pdf' || this.kind === 'book' ? h.page : this.current };
  }
  mark(el) { this.hitEl = el; el.classList.add('dv-hit'); }

  // ---------------------------------------------------------------- the AI's text

  /** The document's text for the AI, hidden parts left out: on the research seat only, else ''. */
  async text() {
    if (this.seat !== 'research' || this.dead) return '';
    await this.ready;
    if (this.kind === 'pdf') {
      const out = [];
      let size = 0;
      for (const p of await this.pdfText(BOUNDS.aiPages)) {
        const line = '[page ' + p.n + '] ' + p.text;
        out.push(line);
        size += line.length + 1;
        if (size > BOUNDS.aiChars) break;
      }
      return out.join('\n').slice(0, BOUNDS.aiChars);
    }
    return this.model ? documentText(this.model) : '';
  }

  // ---------------------------------------------------------------- picks (the research seat's Preview, plan 4-§5.9.6)
  // A pick is what the researcher highlighted: words (a selection, or a word tapped), cells of a table (a tap, a drag, the
  // arrow keys; Shift for a range; a column's or a row's header), or a part of a PDF's page or of a picture (a region).
  // It is read from the reader's own model, never from the selection's text, and only from what this seat draws: a hidden
  // row, column, sheet, slide or shape is never picked.

  listenPicks() {
    let raf = 0;
    this.listen(document, 'selectionchange', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (!this.dead) this.readSelection(); });
    });
    let down = null;
    this.listen(this.body, 'pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, type: e.pointerType, on: this.holds(e.target, e.clientX, e.clientY) };
      if (this.regionDown(e)) return;
      this.gridDown(e);
    });
    this.listen(this.body, 'pointermove', (e) => { if (!this.regionMove(e)) this.gridMove(e); });
    this.listen(this.body, 'pointerup', (e) => {
      const d = down;
      down = null;
      if (this.regionUp(e) || this.gridUp(e)) return;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;   // a drag: its selection says what it picked
      // A second tap on what is picked opens its menu: a touch's door, where a long press is the browser's own selection.
      if (d.on && d.type !== 'mouse') { for (const fn of this.menuers) fn({ x: e.clientX, y: e.clientY }); return; }
      if (this.picTap(e.target)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      this.tapWord(e.clientX, e.clientY);
    });
    this.listen(this.body, 'keydown', (e) => this.gridKey(e));
  }
  /** Whether a point on `target` is on what is picked now: its cells, its words' boxes, or its region. */
  holds(target, x, y) {
    const p = this.picked;
    if (!p || !target || !target.closest) return false;
    if (p.type === 'grid') { const td = cellOf(target); return !!td && td.closest('table') === p.table && this.inGrid(td); }
    if (p.type === 'region') { const r = this.overlay && this.overlay.isConnected ? this.overlay.getBoundingClientRect() : null; return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    if (p.type === 'picture') return target === p.img;
    return [...p.range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }
  /**
   * A tap on a picture in a Word document or a deck picks it, to be sent as a picture of its own (drawn again, without its
   * metadata): only one this seat may pick, never one of a hidden slide or shape. Whether it picked one.
   */
  picTap(target) {
    const info = target && target.tagName === 'IMG' && !target.closest('.dv-hidden') ? this.pics.get(target) : null;
    if (!info || !(target.naturalWidth > 0)) return false;
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    const at = this.kind === 'deck' ? (info.slide ? { slide: info.slide } : {})
      : { ...(info.at && info.at.block ? { block: info.at.block } : {}), ...(Number.isInteger(info.page) && info.page > 0 && info.at && info.at.block ? { page: info.page, ...(info.pageApprox || (this.model && this.model.scan && this.model.scan.approx) ? { approx: true } : {}) } : {}) };
    this.setPick({ type: 'picture', img: target, at, jpeg: target.dataset.type === 'image/jpeg' });
    return true;
  }
  /** The picture picked in a document drawn again into a new one, its metadata left behind: a Blob, or null. */
  async pickPicture() {
    const p = this.picked;
    if (!p || p.type !== 'picture' || !p.img.isConnected) return null;
    try {
      const natural = { width: p.img.naturalWidth, height: p.img.naturalHeight };
      return await this.partOf(p.img, natural, { x: 0, y: 0, w: natural.width, h: natural.height }, p.jpeg);
    } catch {
      return null;
    }
  }
  /** A tap on words picks the word under it: the selection is set to it (Intl.Segmenter's word), and read as any. */
  tapWord(x, y) {
    const at = caretAt(x, y);
    if (!at || !at.node || at.node.nodeType !== 3 || !this.body.contains(at.node)) return;
    const el = at.node.parentElement;
    const host = this.kind === 'pdf' ? el.closest('span[role="presentation"]') : this.blockEls.has(el) ? el : null;
    if (!host || host.firstChild !== at.node) return;
    const g = segmentOf(at.node.nodeValue, at.offset, at.offset, 'word');
    if (!g) return;
    const r = document.createRange();
    r.setStart(at.node, g.start);
    r.setEnd(at.node, g.end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  /** The selection read as a pick: words of the reader's blocks (or a PDF's text spans), or the cells between its ends in one table. */
  readSelection() {
    if (this.regionOn) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { if (this.picked && this.picked.type === 'text') this.setPick(null); return; }
    const range = sel.getRangeAt(0);
    if (!this.body.contains(range.commonAncestorContainer)) return;
    // Tables are never picked by a selection: one inside a table is its cells, from its first to its last.
    const a = cellOf(range.startContainer);
    const b = cellOf(range.endContainer);
    if (a && b && a.closest('table') === b.closest('table')) { sel.removeAllRanges(); this.gridPick(a.closest('table'), a, b, 'range'); return; }
    const parts = this.kind === 'pdf' ? this.spanParts(range) : this.blockParts(range);
    this.setPick(parts.length ? { type: 'text', range: range.cloneRange(), parts } : null);
  }
  /** The blocks a range holds part of, in order, each {el, info, text, start, end}. */
  blockParts(range) {
    const out = [];
    for (const [el, info] of this.blockEls) {
      if (!el.isConnected) continue;
      const p = partOf(el, range);
      if (p) out.push({ el, info, text: el.textContent, ...p });
    }
    return out;
  }
  /** The text spans of a PDF's pages a range holds part of, in order, each {el, page, text, start, end}. */
  spanParts(range) {
    const out = [];
    for (const layer of this.body.querySelectorAll('.textLayer')) {
      if (!range.intersectsNode(layer)) continue;
      for (const el of spansIn(layer)) { const p = partOf(el, range); if (p) out.push({ el, page: Number(layer.dataset.page), text: el.textContent, ...p }); }
    }
    return out;
  }
  setPick(p) {
    this.picked = p;
    this.markPick();
    const now = this.pickNow();
    for (const fn of this.pickers) fn(now);
  }
  clearPick() {
    const sel = window.getSelection();
    if (this.picked && this.picked.type === 'text' && sel) sel.removeAllRanges();
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    this.setPick(null);
  }
  /** What is picked now, for the bar: {type, units: [{unit, size, approx?, over?}], words}, or null for nothing. */
  pickNow() {
    const p = this.picked;
    if (!p) return null;
    if (p.type === 'region') return { type: 'region', units: [], words: 'A region of ' + (this.kind === 'pdf' ? 'p. ' + p.page : 'the picture') + ', as a picture', page: p.page, rect: p.rect };
    if (p.type === 'picture') return { type: 'picture', units: [], words: 'A picture in ' + (this.kind === 'deck' ? (p.at.slide ? 'slide ' + p.at.slide : 'the deck') : p.at.page ? (p.at.approx ? '≈ p. ' : 'p. ') + p.at.page : 'the document') + ', as a picture of its own', at: p.at };
    const units = [];
    // A header picks its row or its column alone; a cell, the cell and its row and column; a range, the range (and its row
    // or column where it is one).
    const GRID_UNITS = { range: ['range', 'row', 'column'], row: ['row'], column: ['column'], cell: ['cell', 'row', 'column'] };
    const list = p.type === 'grid' ? GRID_UNITS[p.mode] || [] : TEXT_UNITS[this.kind] || [];
    for (const unit of list) {
      const q = this.quoteOf(unit);
      if (!q) continue;
      units.push({ unit, size: q.error ? '' : quoteSize(q), ...(q.approx ? { approx: true } : {}), ...(q.error ? { over: q.error } : {}) });
    }
    return { type: p.type, units, words: p.type === 'grid' ? this.gridWords() : '', untagged: this.kind === 'pdf' && !this.isTagged() };
  }
  /** Whether this PDF carries its structure (a tagged PDF): read from the pages drawn so far. */
  isTagged() { return [...this.structs.values()].some((s) => s.tagged); }

  /**
   * The pick as a quote's body for `unit` (lib/pages.js cleanSnippet's shape, its place in its file as `at`), or null where
   * the unit does not hold the pick, or {error, over?} where it is over the stage's bounds; `cut` cuts it to them as the
   * researcher chose (text to its first 1,200 characters, a table to 25 rows × 10 columns), `labels` false sends a cell
   * without its row's and column's labels.
   */
  quoteOf(unit, { cut = false, labels = true, note = '', copy = false } = {}) {
    const p = this.picked;
    if (!p || (p.type !== 'grid' && p.type !== 'text')) return null;
    const q = p.type === 'grid' ? this.gridQuoteOf(unit, { cut, labels }) : this.kind === 'pdf' ? this.pdfQuote(unit, p.parts, { labels, cut }) : this.blockQuote(unit, p.parts);
    // Copied words go to this person's own clipboard, not the stage: the stage's bounds are not theirs.
    if (!q || q.error || copy) return q;
    let out = q;
    if (typeof q.text === 'string') {
      const n = charsOf(q.text);
      if (n > QUOTE_BOUNDS.text) {
        if (!cut) return { error: 'Too long for the stage: 1,200 characters at most (this is ' + counted(n) + ')', over: { chars: n } };
        out = { ...q, text: cutText(q.text).text, cut: true };
      }
    }
    if (Array.isArray(q.items) && (q.items.length > QUOTE_BOUNDS.items || q.items.some((x) => charsOf(x) > QUOTE_BOUNDS.item))) return { error: 'Too long for the stage: 20 items of 300 characters at most' };
    // Every other bound the server holds (a cell's 200 characters, 4,000 in all with the note): said here, never cut.
    const over = quoteOver({ ...out, ...(note ? { note } : {}) });
    return over ? { error: over } : out;
  }
  /** The words a unit of a reader's blocks holds, as a quote's body: {unit, text | items | title, at}, or null. */
  blockQuote(unit, parts) {
    const one = parts.length === 1 ? parts[0] : null;
    const slice = (x) => x.text.slice(x.start, x.end).trim();
    const at = (list) => this.blocksAt(list);
    switch (unit) {
      case 'selection': { const t = parts.map(slice).filter(Boolean).join('\n'); return t ? { unit, text: t, at: at(parts) } : null; }
      case 'word':
      case 'sentence': {
        if (!one) return null;
        const g = segmentOf(one.text, one.start, one.end, unit);
        return g ? { unit, text: g.text, at: at(parts) } : null;
      }
      case 'line': {
        if (!one) return null;
        if (one.info.kind === 'line' || (this.kind === 'md' && one.info.at && one.info.at.line === one.info.at.to && one.info.kind !== 'li')) return { unit, text: one.text.trim(), at: at(parts) };
        return null;
      }
      case 'paragraph': {
        if (this.kind === 'text') {
          const run = this.lineRun(parts);
          return run ? { unit, text: run.text, at: { lines: run.lines } } : null;
        }
        return one && ['p', 'h', 'quote', 'code'].includes(one.info.kind) ? { unit, text: one.text.trim(), at: at(parts) } : null;
      }
      case 'item': {
        // Items of one list, numbered from the first's number as the Preview draws it: never renumbered from 1 on the stage.
        if (!parts.every((x) => x.info.kind === 'li' && x.info.list === parts[0].info.list && x.info.level === parts[0].info.level)) return null;
        const first = parts[0].info;
        const numbered = first.list === 'ol' && Number.isInteger(first.number) && first.number >= 1 && first.number <= 9999;
        return { unit, items: parts.map((x) => x.text.trim()).filter(Boolean), ...(numbered ? { ordered: true, start: first.number } : {}), at: at(parts) };
      }
      case 'slide': {
        const n = parts[0].info.slide;
        if (!n || !parts.every((x) => x.info.slide === n)) return null;
        const blocks = [...this.blockEls.values()].filter((b) => b.slide === n);
        const title = blocks.find((b) => b.kind === 'h');
        return { unit, ...(title ? { title: title.text } : {}), items: blocks.filter((b) => b !== title).map((b) => b.text), at: { slide: n } };
      }
      default: return null;
    }
  }
  /** A text file's paragraph that holds every part: the run of lines that are not blank around them, {text, lines: [a, b]}. */
  lineRun(parts) {
    const lines = this.model && this.model.blocks ? this.model.blocks.map((b) => b.text) : [];
    const first = parts[0].info.at.line - 1;
    const last = parts[parts.length - 1].info.at.line - 1;
    const blank = (i) => !String(lines[i] || '').trim();
    for (let i = first; i <= last; i++) if (blank(i)) return null;
    let a = first, b = last;
    while (a > 0 && !blank(a - 1)) a--;
    while (b < lines.length - 1 && !blank(b + 1)) b++;
    return { text: lines.slice(a, b + 1).join('\n').trim(), lines: [a + 1, b + 1] };
  }
  /**
   * Where a pick of blocks is in its file: a text file's line or lines; a Markdown file's line or lines and the heading over
   * it; a Word document's paragraph, its page (≈ where approximate) and heading; a slide's number.
   */
  blocksAt(parts) {
    const first = parts[0].info;
    const last = parts[parts.length - 1].info;
    if (this.kind === 'text') return first.at.line === last.at.line ? { line: first.at.line } : { lines: [first.at.line, last.at.line] };
    if (this.kind === 'deck') return first.slide ? { slide: first.slide } : {};
    const heading = this.headingOf(parts[0].el);
    const head = heading ? { heading: Array.from(heading).slice(0, 120).join('') } : {};
    if (this.kind === 'md') {
      const a = first.at.line, b = last.at.to || last.at.line;
      return { ...(a === b ? { line: a } : { lines: [a, b] }), ...head };
    }
    if (this.kind === 'word') {
      const page = Number.isInteger(first.page) && first.page > 0 ? { page: first.page, ...(first.pageApprox || (this.model && this.model.scan && this.model.scan.approx) ? { approx: true } : {}) } : {};
      return { ...(first.at && first.at.block ? { block: first.at.block } : {}), ...page, ...head };
    }
    return {};
  }
  /** The heading over a block: the last heading drawn before it, '' for none. */
  headingOf(el) {
    let h = '';
    for (const [x, info] of this.blockEls) { if (x === el) break; if (info.kind === 'h') h = info.text; }
    return h;
  }

  /** The words a unit of a PDF's text spans holds: a word, a line, the selection, and by its structure (or a guess) a paragraph, an item, a cell, a row or a column. */
  pdfQuote(unit, parts, { labels = true, cut = false } = {}) {
    const page = parts[0].page;
    const at = { page };
    const one = parts.length === 1 ? parts[0] : null;
    const layer = parts[0].el.closest('.textLayer');
    const lines = linesOf(spansIn(layer));
    const lineOf = (el) => lines.findIndex((l) => l.spans.includes(el));
    if (unit === 'selection') {
      const slices = new Map(parts.map((x) => [x.el, x.text.slice(x.start, x.end)]));
      const used = [...new Set(parts.map((x) => lineOf(x.el)))].filter((i) => i >= 0).sort((a, b) => a - b);
      const t = used.map((i) => lineText(lines[i].boxes.filter((b) => slices.has(b.el)), slices)).filter(Boolean).join('\n');
      return t ? { unit, text: t, at } : null;
    }
    if (unit === 'word') {
      if (!one) return null;
      const g = segmentOf(one.text, one.start, one.end, 'word');
      return g ? { unit, text: g.text, at } : null;
    }
    if (parts.some((x) => x.page !== page)) return null;
    const lineNos = [...new Set(parts.map((x) => lineOf(x.el)))];
    if (unit === 'line') return lineNos.length === 1 && lineNos[0] >= 0 ? { unit, text: lineText(lines[lineNos[0]].boxes), at } : null;
    const struct = this.structs.get(page);
    if (struct && struct.tagged) return this.taggedQuote(unit, parts, struct, layer, { at, labels, cut });
    // An untagged PDF: a paragraph is a run of lines close together, an item one that starts with a list's marker; both a
    // guess (≈), and cells are never read.
    if (unit !== 'paragraph' && unit !== 'item') return null;
    if (lineNos.some((i) => i < 0)) return null;
    let a = Math.min(...lineNos), b = Math.max(...lineNos);
    const near = (i, j) => lines[j].top - lines[i].bottom < Math.max(lines[i].h, lines[j].h) * 0.8;
    const marked = (i) => MARKER.test(lineText(lines[i].boxes));
    if (unit === 'item') {
      while (a > 0 && !marked(a) && near(a - 1, a)) a--;
      if (!marked(a)) return null;
      for (let i = a + 1; i <= b; i++) if (marked(i)) return null;
      while (b < lines.length - 1 && near(b, b + 1) && !marked(b + 1)) b++;
    } else {
      while (a > 0 && near(a - 1, a) && !marked(a)) a--;
      while (b < lines.length - 1 && near(b, b + 1) && !marked(b + 1)) b++;
    }
    const t = lines.slice(a, b + 1).map((l) => lineText(l.boxes)).join(unit === 'item' ? ' ' : '\n');
    return unit === 'item' ? { unit, items: [t], at, approx: true } : { unit, text: t, at, approx: true };
  }
  /**
   * A tagged PDF's paragraph, item, cell, row or column that holds every part, read by its structure: a table over 25 rows
   * × 10 columns refused with its size, or, as the researcher chose (`cut`), its first 25 × 10 marked cut with what was
   * left out.
   */
  taggedQuote(unit, parts, struct, layer, { at, labels, cut }) {
    const nodes = parts.map((x) => struct.byId.get(contentOf(x.el)) || null);
    if (nodes.some((n) => !n)) return null;
    const one = (roles) => { const found = nodes.map((n) => upTo(n, roles)); return found[0] && found.every((x) => x === found[0]) ? found[0] : null; };
    const words = (node) => {
      const spans = [];
      for (const id of node.ids) { const m = layer.querySelector('#' + CSS.escape(id)); if (m) spans.push(...spansIn(m)); }
      return linesOf(spans).map((l) => lineText(l.boxes)).join('\n').trim();
    };
    if (unit === 'paragraph') { const n = one(PARA_ROLES); return n ? { unit, text: words(n), at } : null; }
    if (unit === 'item') { const n = one(['LI']); if (!n) return null; const body = n.kids.find((k) => k.role === 'LBody') || n; return { unit, items: [words(body)], at }; }
    const cell = one(['TD', 'TH']);
    if (!cell) return null;
    const table = upTo(cell, ['Table']);
    if (!table) return null;
    const rows = [];
    const walk = (n) => { for (const k of n.kids) { if (k.role === 'TR') rows.push(k); else if (['THead', 'TBody', 'TFoot'].includes(k.role)) walk(k); } };
    walk(table);
    const grid = rows.map((tr) => tr.kids.filter((k) => k.role === 'TD' || k.role === 'TH'));
    const r = rows.findIndex((tr) => tr === cell.parent);
    const c = r >= 0 ? grid[r].indexOf(cell) : -1;
    if (r < 0 || c < 0) return null;
    const q = structQuote((y, x) => (grid[y] && grid[y][x] ? words(grid[y][x]) : ''), grid.map((tr) => tr.map((k) => k.role)), { unit, r, c, labels, cut });
    return q && !q.error ? { ...q, at } : q;
  }

  // ---- cells: a sheet's, a CSV's, a document's table's
  /**
   * What a table's cells are, for a pick: their words (`get`), the rows and columns this seat may pick (the Board's: no
   * hidden row or column, and nothing of a hidden sheet or of a table on a hidden slide), its labels, its name and its
   * place; null for a table no pick reads.
   */
  gridData(table) {
    if (!table || !table.classList) return null;
    if (table.classList.contains('dv-grid')) {
      const g = this.gridSheets.get(table);
      if (!g) return null;
      const { sheet, n } = g;
      const plan = planSheet(sheet, 'board');
      const o = sheet.origin || { r: 0, c: 0 };
      const nv = new Set((sheet.noValue || []).map(([r, c]) => r + ',' + c));
      const get = (r, c) => (nv.has(r + ',' + c) ? WORDS.noValue : String(sheet.rows[r] && sheet.rows[r][c] !== undefined ? sheet.rows[r][c] : ''));
      const shown = !sheet.hidden;
      return { get, rows: shown ? plan.rows.map((x) => x.r) : [], cols: shown ? plan.cols : [], origin: o, key: 'sheet:' + n, name: this.kind === 'book' ? sheet.name : '', at: this.kind === 'book' ? { sheet: n } : {}, frozen: sheet.frozen || null };
    }
    const t = table.dataset.block !== undefined && !table.closest('.dv-hidden') ? this.tables[Number(table.dataset.block)] : null;
    if (!t) return null;
    const dense = denseRows(t.b.rows, t.b.width);
    const info = { ...t.b, slide: Number((table.closest('.dv-slide') || { dataset: {} }).dataset.slide) || 0 };
    return { get: (r, c) => (dense[r] ? dense[r][c] : ''), rows: dense.map((_, i) => i), cols: Array.from({ length: t.b.width }, (_, i) => i), origin: { r: 0, c: 0 }, key: 'table:' + table.dataset.block, name: '', at: this.blocksAt([{ info, el: table }]) };
  }
  /** A sheet's (or a table's) label row and column: as marked, else its frozen panes', else its first row and column shown. */
  labelsNow(table = this.picked && this.picked.table) {
    const d = table ? this.gridData(table) : null;
    if (!d) return null;
    return this.labelsBy.get(d.key) || labelsOf(d.frozen, d.rows, d.cols);
  }
  /** The label row and column marked for the table picked now (-1 for none), and the pick read again with them. */
  setLabels(row, col) {
    const p = this.picked;
    const d = p && p.type === 'grid' ? this.gridData(p.table) : null;
    if (!d) return;
    this.labelsBy.set(d.key, { row, col });
    this.setPick(p);
  }
  gridQuoteOf(unit, { cut, labels }) {
    const p = this.picked;
    const d = this.gridData(p.table);
    if (!d) return null;
    const one = p.r0 === p.r1 && p.c0 === p.c1;
    if (unit === 'cell' && !one) return null;
    if (unit === 'range' && one) return null;
    if (unit === 'row' && p.r0 !== p.r1) return null;
    if (unit === 'column' && p.c0 !== p.c1) return null;
    const q = gridQuote(d.get, { unit, r: p.r0, c: p.c0, r1: p.r1, c1: p.c1, rows: d.rows, cols: d.cols, labels: this.labelsNow(p.table), withLabels: labels, name: d.name, cut });
    if (!q || q.error) return q;
    const ref = q.table.ref;
    const csv = this.kind === 'csv';
    const rowsAt = unit === 'column' ? [d.rows[0] + 1, d.rows[d.rows.length - 1] + 1] : [Math.min(p.r0, p.r1) + 1, Math.max(p.r0, p.r1) + 1];
    const at = csv ? { ...(rowsAt[0] === rowsAt[1] ? { line: rowsAt[0] } : { lines: rowsAt }), ref: Array.from(ref).slice(0, 64).join('') }
      : d.at.sheet ? { sheet: d.at.sheet, ref: Array.from(ref).slice(0, 64).join('') } : d.at;
    return { unit, table: q.table, at, ...(q.cut ? { cut: true, more: q.more } : {}) };
  }
  /** The bar's words of a cell picked in a sheet: "C14 · Revenue (row 14) · Q3 (column C)". */
  gridWords() {
    const p = this.picked;
    if (!p || p.r0 !== p.r1 || p.c0 !== p.c1) return '';
    const d = this.gridData(p.table);
    const l = this.labelsNow(p.table);
    if (!d || !l) return '';
    const ref = columnName(p.c0) + (p.r0 + 1);
    const rowName = l.col >= 0 && l.col !== p.c0 ? d.get(p.r0, l.col) : '';
    const colName = l.row >= 0 && l.row !== p.r0 ? d.get(l.row, p.c0) : '';
    return [ref, rowName ? rowName + ' (row ' + (p.r0 + 1) + ')' : '', colName ? colName + ' (column ' + columnName(p.c0) + ')' : ''].filter(Boolean).join(' · ');
  }
  inGrid(td) {
    const p = this.picked;
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    return r >= Math.min(p.r0, p.r1) && r <= Math.max(p.r0, p.r1) && c >= Math.min(p.c0, p.c1) && c <= Math.max(p.c0, p.c1);
  }
  /**
   * Cells picked: from `a` to `b` (two cells of `table`), a row (a row's header) or a column (a column's header). Nothing
   * hidden is ever picked: a hidden row's, column's or sheet's cell or header, or a table on a hidden slide, is refused
   * by what is drawn (marked hidden) and again by what the Board may read (gridData's rows and columns).
   */
  gridPick(table, a, b, mode) {
    if (!table || [a, b].some((el) => !el || el.closest('.dv-hidden'))) return;
    const d = this.gridData(table);
    if (!d || !d.rows.length || !d.cols.length) return;
    const n = (td, k) => Number(td.dataset[k]);
    if (mode === 'column') {
      const c = n(a, 'c');
      if (d.cols.includes(c)) this.setPick({ type: 'grid', table, mode: 'column', r0: d.rows[0], r1: d.rows[0], c0: c, c1: c, all: true });
      return;
    }
    if (mode === 'row') {
      const r = n(a, 'r');
      if (d.rows.includes(r)) this.setPick({ type: 'grid', table, mode: 'row', r0: r, r1: r, c0: d.cols[0], c1: d.cols[0], all: true });
      return;
    }
    const r0 = n(a, 'r'), c0 = n(a, 'c'), r1 = n(b, 'r'), c1 = n(b, 'c');
    if (![r0, r1].every((x) => d.rows.includes(x)) || ![c0, c1].every((x) => d.cols.includes(x))) return;
    this.setPick({ type: 'grid', table, mode: r0 === r1 && c0 === c1 ? 'cell' : 'range', r0, c0, r1, c1 });
  }
  gridDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const head = e.target.closest && e.target.closest('table.dv-grid th.dv-col, table.dv-grid th.dv-row');
    if (head) { this.gridPick(head.closest('table'), head, head, head.classList.contains('dv-col') ? 'column' : 'row'); return; }
    const td = cellOf(e.target);
    if (!td) return;
    const p = this.picked;
    if (e.shiftKey && p && p.type === 'grid' && p.table === td.closest('table')) {
      const anchor = p.table.querySelector('td[data-r="' + p.r0 + '"][data-c="' + p.c0 + '"]');
      if (anchor) { this.gridPick(p.table, anchor, td, 'range'); return; }
    }
    this.dragFrom = e.pointerType === 'mouse' ? td : null;   // a finger's drag scrolls; a mouse's picks a range
    this.gridPick(td.closest('table'), td, td, 'cell');
  }
  gridMove(e) {
    if (!this.dragFrom) return;
    const td = cellOf(document.elementFromPoint(e.clientX, e.clientY));
    if (td && td.closest('table') === this.dragFrom.closest('table')) { const p = this.picked; if (!p || Number(td.dataset.r) !== p.r1 || Number(td.dataset.c) !== p.c1) this.gridPick(td.closest('table'), this.dragFrom, td, 'range'); }
  }
  gridUp() { const had = !!this.dragFrom; this.dragFrom = null; return had; }
  /** The arrow keys move the picked cell, Shift and the arrows stretch it into a range, inside the rows and columns this seat may pick. */
  gridKey(e) {
    const p = this.picked;
    if (!p || p.type !== 'grid' || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) || !e.target.closest || e.target.closest('table') !== p.table) return;
    const d = this.gridData(p.table);
    if (!d || !d.rows.length || !d.cols.length) return;
    const step = (list, v, by) => { const i = list.indexOf(v); return list[Math.max(0, Math.min(list.length - 1, i + by))]; };
    const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    e.preventDefault();
    const r1 = step(d.rows, p.r1, dr), c1 = step(d.cols, p.c1, dc);
    if (e.shiftKey) this.setPick({ ...p, mode: 'range', r1, c1, all: false });
    else this.setPick({ type: 'grid', table: p.table, mode: 'cell', r0: r1, c0: c1, r1, c1 });
    const td = p.table.querySelector('td[data-r="' + r1 + '"][data-c="' + c1 + '"]');
    if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---- a region: part of a PDF's page or of a picture, drawn by hand
  /** Regions drawn by hand on a PDF's pages (a picture's are always): a drag draws one, the arrow keys nudge it, Shift resizes it. */
  regionMode(on) {
    this.regionOn = !!on && (this.kind === 'pdf' || this.kind === 'image');
    this.root.classList.toggle('dv-regions', this.regionOn || this.kind === 'image');
    if (!this.regionOn && this.picked && this.picked.type === 'region' && this.kind === 'pdf') this.clearPick();
    return this.regionOn;
  }
  /** The surface a region is drawn on under a pointer: a PDF's page (in region mode) or the picture; with its scale. */
  regionHost(target) {
    if (!this.picks) return null;
    if (this.kind === 'image' && this.img && (target === this.img || target === this.overlay)) return { el: this.img, page: 1, scale: this.scaleNow() };
    if (this.kind === 'pdf' && this.regionOn) { const host = target.closest && target.closest('.dv-page'); return host ? { el: host, page: Number(host.dataset.page), scale: this.scaleNow() } : null; }
    return null;
  }
  regionDown(e) {
    const h = this.regionHost(e.target);
    if (!h) return false;
    e.preventDefault();
    const r = h.el.getBoundingClientRect();
    this.drawing = { ...h, x0: e.clientX - r.left, y0: e.clientY - r.top };
    return true;
  }
  regionMove(e) {
    const d = this.drawing;
    if (!d) return false;
    const r = d.el.getBoundingClientRect();
    const x1 = Math.max(0, Math.min(r.width, e.clientX - r.left)), y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
    this.showRegion(d, { x: Math.min(d.x0, x1), y: Math.min(d.y0, y1), w: Math.abs(x1 - d.x0), h: Math.abs(y1 - d.y0) });
    return true;
  }
  regionUp() {
    const d = this.drawing;
    if (!d) return false;
    this.drawing = null;
    const b = this.regionBox;
    if (!b || b.w < 4 || b.h < 4) { if (this.overlay) { this.overlay.remove(); this.overlay = null; } return true; }
    this.setPick({ type: 'region', page: d.page, rect: { x: b.x / d.scale, y: b.y / d.scale, w: b.w / d.scale, h: b.h / d.scale } });
    return true;
  }
  /** The region drawn over its surface, at `box` (pixels of the surface as drawn): an outline the arrow keys move. */
  showRegion(h, box) {
    if (!this.overlay) {
      this.overlay = make('div', 'dv-region');
      this.overlay.tabIndex = 0;
      this.overlay.setAttribute('role', 'img');
      this.overlay.setAttribute('aria-label', 'The region to send: the arrow keys move it, Shift and the arrows resize it');
      this.listen(this.overlay, 'keydown', (e) => this.nudge(e));
    }
    const host = h.el === this.img ? this.body : h.el;
    if (this.overlay.parentNode !== host) host.appendChild(this.overlay);
    const off = h.el === this.img ? { x: this.img.offsetLeft, y: this.img.offsetTop } : { x: 0, y: 0 };
    Object.assign(this.overlay.style, { left: (off.x + box.x) + 'px', top: (off.y + box.y) + 'px', width: box.w + 'px', height: box.h + 'px' });
    this.regionBox = box;
    this.regionSurface = h;
  }
  nudge(e) {
    const p = this.picked;
    if (!p || p.type !== 'region' || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const by = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -2 : 2;
    const b = { ...this.regionBox };
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (e.shiftKey) { if (vertical) b.h = Math.max(4, b.h + by); else b.w = Math.max(4, b.w + by); } else if (vertical) b.y = Math.max(0, b.y + by); else b.x = Math.max(0, b.x + by);
    const h = this.regionSurface;
    this.showRegion(h, b);
    this.setPick({ type: 'region', page: p.page, rect: { x: b.x / h.scale, y: b.y / h.scale, w: b.w / h.scale, h: b.h / h.scale } });
  }
  /**
   * A part of a PDF's page `page` (`rect` in the page's own units) or of the picture (`rect` in its pixels) drawn into a new
   * picture: nothing else of the file goes, and a picture's metadata (EXIF, a place among it) never does, since it is drawn
   * again. Its long edge PICTURE_EDGE px at most, never over PICTURE_SIDE a side nor PICTURE_PIXELS in all. A Blob, or null.
   */
  async regionPicture(page, rect) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
    try {
      if (this.kind === 'image' && this.img) return await this.partOf(this.img, this.natural, rect, /\.jpe?g$/i.test(this.name));
      if (this.kind !== 'pdf' || !this.doc || !(page >= 1) || page > this.doc.numPages) return null;
      const pg = this.pages.get(page) || await this.doc.getPage(page);
      const scale = regionScale(rect.w, rect.h);
      const vp = pg.getViewport({ scale, offsetX: -rect.x * scale, offsetY: -rect.y * scale });
      const c = make('canvas');
      c.width = Math.max(1, Math.floor(rect.w * scale));
      c.height = Math.max(1, Math.floor(rect.h * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, c.width, c.height);
      const task = pg.render({ canvasContext: ctx, viewport: vp });
      this.renders.add(task);
      try { await task.promise; } finally { this.renders.delete(task); }
      return this.dead ? null : await blobOf(c, false);
    } catch {
      return null;
    }
  }

  /**
   * The part `rect` (in its pixels) of a picture drawn on this page (`img`, its size `natural`) drawn again into a new one,
   * its metadata left behind: through createImageBitmap where the browser has it (Safari 15 and later), else by drawing
   * the part of the element on a canvas, which every browser of the page floor does.
   */
  async partOf(img, natural, rect, jpeg) {
    const sx = Math.max(0, Math.floor(rect.x)), sy = Math.max(0, Math.floor(rect.y));
    const sw = Math.max(1, Math.floor(Math.min(rect.w, natural.width - sx))), sh = Math.max(1, Math.floor(Math.min(rect.h, natural.height - sy)));
    const scale = Math.min(1, regionScale(sw, sh));
    const c = make('canvas');
    c.width = Math.max(1, Math.floor(sw * scale));
    c.height = Math.max(1, Math.floor(sh * scale));
    const ctx = c.getContext('2d');
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(img, sx, sy, sw, sh, { imageOrientation: 'from-image' });
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      if (typeof bmp.close === 'function') bmp.close();
    } else ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return this.dead ? null : await blobOf(c, jpeg);
  }

  /**
   * What is in view now, to send as it is (What I see): a PDF's or a picture's part as a picture's place ({picture: {page,
   * rect}}); the blocks in view as a quote (`view`, a table's rows in view among them), a text file's lines as one block;
   * a sheet's or a CSV's cells in view as a range. Hidden parts are never among them, and nothing of a hidden sheet is. Over
   * the stage's bounds it is never cut here: {quote: {error}, fits} says how much is in view, and `fits` is what would fit
   * (a range's first 25 rows × 10 columns, marked cut; the first 12 blocks), sent only as the researcher chooses.
   */
  inView({ note = '' } = {}) {
    if (this.kind === 'pdf' || this.kind === 'image') { const v = this.visible(); return v.rect ? { picture: { page: v.page, rect: v.rect } } : null; }
    const view = this.box.getBoundingClientRect();
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom && r.height > 0; };
    if (this.kind === 'book' || this.kind === 'csv') {
      const grid = this.body.querySelector('table.dv-grid');
      if (!grid || grid.classList.contains('dv-hidden')) return null;
      const cells = [...grid.querySelectorAll('td[data-r]')].filter((td) => !td.closest('.dv-hidden') && inView(td));
      if (!cells.length) return null;
      const wide = cells.filter((td) => { const r = td.getBoundingClientRect(); return r.right > view.left && r.left < view.right; });
      if (!wide.length) return null;
      const rs = wide.map((td) => Number(td.dataset.r)), cs = wide.map((td) => Number(td.dataset.c));
      const was = this.picked;
      this.picked = { type: 'grid', table: grid, mode: 'range', r0: Math.min(...rs), c0: Math.min(...cs), r1: Math.max(...rs), c1: Math.max(...cs) };
      const q = this.gridQuoteOf('range', { cut: false, labels: true });
      const fits = q && q.error ? this.gridQuoteOf('range', { cut: true, labels: true }) : null;
      this.picked = was;
      if (!q) return null;
      if (q.error) return { quote: { error: q.error.replace(/narrow it to/, 'the range in view is over'), over: q.over }, fits: fits && !fits.error && !quoteOver({ ...fits, note }) ? fits : null };
      const over = quoteOver({ ...q, note });
      return over ? { quote: { error: over }, fits: null } : { quote: q };
    }
    const blocks = [];
    let at = null;
    if (this.kind === 'text') {
      const lines = [...this.blockEls].filter(([el]) => inView(el));
      if (!lines.length) return null;
      const t = lines.map(([el]) => el.textContent).join('\n').trim();
      if (!t) return null;
      blocks.push({ kind: 'p', text: t });
      at = { lines: [lines[0][1].at.line, lines[lines.length - 1][1].at.line] };
    } else {
      const seenEls = [...this.body.querySelectorAll('[data-find], table.dv-table')].filter((el) => !el.closest('.dv-hidden') && inView(el));
      for (const el of seenEls) {
        if (el.tagName === 'TABLE') {
          const t = el.dataset.block !== undefined ? this.tables[Number(el.dataset.block)] : null;
          if (!t) continue;
          const dense = denseRows(t.b.rows, t.b.width);
          const rows = [...el.querySelectorAll('tr')].map((tr, i) => (inView(tr) ? i : -1)).filter((i) => i >= 0);
          if (rows.length) blocks.push({ kind: 'table', table: { rows: rows.map((r) => dense[r]), head: rows[0] === 0 && (t.b.head || 0) > 0 ? 1 : 0, side: 0 } });
          continue;
        }
        const info = this.blockEls.get(el) || this.blockEls.get(el.querySelector('.dv-li-text'));
        if (!info) continue;
        if (!at) at = this.blocksAt([{ info, el }]);
        blocks.push({ kind: info.kind === 'code' ? 'p' : info.kind, text: info.text });
      }
      if (!blocks.length) return null;
    }
    const v = viewQuote(blocks, { note });
    const quote = { unit: 'view', blocks: v.blocks, at: at || {} };
    return v.over ? { quote: { error: v.over }, fits: v.blocks.length ? quote : null } : { quote };
  }

  /** What is picked, shown: the words in the CSS Custom Highlight API where the browser has it (else outlined on their blocks), the cells and the region outlined. */
  markPick() {
    for (const el of this.body.querySelectorAll('.dv-pick')) el.classList.remove('dv-pick');
    const reg = highlights();
    if (reg && this.highlight && reg.get(PICK_HIGHLIGHT) === this.highlight) reg.delete(PICK_HIGHLIGHT);
    this.highlight = null;
    const p = this.picked;
    if (!p) return;
    if (p.type === 'grid') {
      for (const td of p.table.querySelectorAll('td[data-r]')) {
        if (td.closest('.dv-hidden')) continue;
        const r = Number(td.dataset.r), c = Number(td.dataset.c);
        const on = p.mode === 'column' ? c === p.c0 : p.mode === 'row' ? r === p.r0 : this.inGrid(td);
        if (on) td.classList.add('dv-pick');
      }
      return;
    }
    if (p.type === 'picture') { p.img.classList.add('dv-pick'); return; }
    if (p.type === 'text') {
      if (reg) { this.highlight = new Highlight(p.range); reg.set(PICK_HIGHLIGHT, this.highlight); } else for (const part of p.parts) (part.el.closest('[data-find]') || part.el).classList.add('dv-pick');
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.abort) this.abort.abort();
    if (this.sized) this.sized.disconnect();
    this.closePdf();
    // The page's highlight of a pick holds a range into this document: let go with it.
    const reg = this.highlight ? highlights() : null;
    if (reg && reg.get(PICK_HIGHLIGHT) === this.highlight) reg.delete(PICK_HIGHLIGHT);
    this.highlight = null;
    for (const off of this.off) off();
    this.off = [];
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.root.remove();
    this.settle({ state: 'failed', words: 'closed' });
  }
}
