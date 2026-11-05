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
//               placeWords(), refit(), destroy()}
//   loadPdfJs()   pdf.js, imported once for the page's life
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
import { BOUNDS, WORDS, decodeText, textLines, parseCsv, markdownBlocks, parseInert, inertText, pptxOutline, planSheet, planBook, planSlides, documentText, pageWords, readInWorker, seatOf, columnName, rowsWords, tableWords } from './docmodel.mjs';
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
    destroy: () => v.destroy(),
  };
}

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
    if (this.seat !== 'research') img.setAttribute('draggable', 'false');
    img.src = url;
    try { await img.decode(); } catch { return { state: 'failed', words: 'the picture could not be read' }; }
    if (img.naturalWidth * img.naturalHeight > BOUNDS.pixels) { this.drop(url); return { state: 'failed', words: WORDS.pixels }; }
    this.natural = { width: img.naturalWidth, height: img.naturalHeight };
    this.img = img;
    this.zoomBox();
    this.body.appendChild(img);
    this.layoutImage();
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
    const head = make('tr');
    head.appendChild(make('th', 'dv-corner'));
    for (const c of plan.cols) {
      const th = make('th', 'dv-col', columnName(c + sheet.origin.c) + ((sheet.hiddenCols || []).includes(c) ? ' hidden' : ''));
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
      tr.appendChild(make('th', 'dv-row', String(row.r + 1 + sheet.origin.r) + (row.hidden ? ' hidden' : '')));
      for (const cell of row.cells) {
        const td = make('td', '', cell.noValue ? WORDS.noValue : cell.text);
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
    this.model = { kind: 'word', blocks, scan };
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
      if (b.kind === 'h') el = make('h' + Math.min(6, Math.max(1, b.level || 1)), '', b.text);
      else if (b.kind === 'li') {
        el = make('p', 'dv-li');
        const lvl = Math.min(8, b.level || 1);
        el.style.paddingLeft = (lvl * 1.25) + 'rem';
        counters.length = lvl;
        counters[lvl - 1] = (counters[lvl - 1] || 0) + 1;
        el.appendChild(make('span', 'dv-marker', b.list === 'ol' ? counters[lvl - 1] + '.' : '•'));
        el.appendChild(document.createTextNode(' ' + b.text));
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
      if (b.kind === 'table' && b.cut) host.appendChild(make('p', 'muted dv-cut', tableWords(b.rows.length, b.width)));
    }
  }
  table(b) {
    const t = make('table', 'dv-table');
    (b.rows || []).forEach((row, r) => {
      const tr = make('tr');
      for (const cell of row) {
        const td = make(r < (b.head || 0) ? 'th' : 'td', '', cell.text);
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

  destroy() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.abort) this.abort.abort();
    if (this.sized) this.sized.disconnect();
    this.closePdf();
    for (const off of this.off) off();
    this.off = [];
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.root.remove();
    this.settle({ state: 'failed', words: 'closed' });
  }
}
