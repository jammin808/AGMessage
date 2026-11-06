// A file's readers, pure: what a document holds, as one block model, for the drawing (docview.mjs) and the AI's text.
// Nothing here draws, holds a socket or fetches: the page hands it text, bytes or the document worker's answer
// (docworker.js) and draws what it returns. The readers that need no DOM run under `node --test`.
//
// A block is {kind: 'p'|'h'|'li'|'quote'|'code'|'table'|'img', text, level?, list?, rows?, src?, alt?, at, page?,
// pageApprox?, hidden?}: `at` is where it is in its file (a line, a row, a sheet and cell, a slide, a paragraph), `rows`
// a table's cells as an occupancy grid, `src` a picture's name inside its file, never an address.
//
// Invariants:
//   - HTML is parsed in one place, parseInert: an inert <template>, walked into plain objects and strings. No node
//     parsed is ever adopted into the live page, and nothing it returns is a node (structuredClone takes it whole).
//   - What a renderer would not show is never read: an HTML comment, <style>, <script>, <noscript>, <template> and an
//     element marked hidden, display:none or visibility:hidden; a Markdown comment; a slide's hidden shapes, pictures,
//     frames and groups with all they hold; presenter notes, which no reader opens.
//   - Hidden sheets, rows and columns and hidden slides are drawn only on the research seat, marked, and never on a
//     Board or observer seat (`seat` is the page's own); the AI's text leaves them out on every seat.
//   - A file the readers found hidden parts in (hiddenPartsOf: those, a slide's hidden shapes, Word's hidden text) is
//     never shown with Download ticked: a download hands over the whole file, hidden parts and all.
//   - Every reader is bounded: BOUNDS.rows rows a sheet or a CSV, BOUNDS.cols columns of any grid or table, BOUNDS.cells
//     cells of one (its rows cut to fit at its width), BOUNDS.lines lines of text, each said where it cut.

/** Each a ceiling on one input, said with words where it cuts (WORDS). */
export const BOUNDS = Object.freeze({
  rows: 5000,          // a sheet's or a CSV's rows drawn
  cols: 256,           // a sheet's, a CSV's or a table's columns drawn: an Excel 97-2003 sheet's whole width
  cells: 100000,       // a sheet's, a CSV's or a table's cells drawn: its rows cut to fit at its width
  lines: 20000,        // a text file's or a Markdown file's lines drawn
  workerMs: 15000,     // a document worker's task, then the worker is ended
  pdfMs: 20000,        // a PDF's first page drawn, then pdf.js's worker is replaced
  pixels: 40000000,    // a picture's pixels, before it is drawn
  aiChars: 60000,      // the AI's text of a document
  aiPages: 80,         // the AI's text of a PDF, in pages
});

export const WORDS = Object.freeze({
  rows: 'Showing the first 5,000 rows.',
  cols: 'Showing the first 256 columns.',
  lines: 'Showing the first 20,000 lines.',
  time: 'This file took too long to read, so it is not shown.',
  timeBackstage: '⬇ Download opens it in its own application.',
  shape: 'This file cannot be read.',
  packed: 'That file is packed in a way AGMessage will not open. Share it as a PDF.',
  dtd: 'This file declares a document type, which AGMessage never reads. Share it as a PDF.',
  hidden: 'This Word file has hidden text AGMessage could not leave out — show a picture or a quote.',
  pixels: 'This picture is too big for this device.',
  noValue: 'formula — no saved value',
  pdfTime: 'the file took too long to read',
  device: 'this device cannot open documents — ask for a picture',
  picture: 'a picture this browser cannot show',
});

/** A count as the words write it: 5000 → "5,000". */
export const counted = (n) => {
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i++) out += (i > 0 && (digits.length - i) % 3 === 0 ? ',' : '') + digits[i];
  return out;
};
/** The words of a grid cut to its first `n` rows: "Showing the first 5,000 rows." */
export const rowsWords = (n) => 'Showing the first ' + counted(n) + ' rows.';
/** The words of a table cut to its first rows and columns. */
export const tableWords = (rows, cols) => 'Showing the first ' + counted(rows) + ' rows and ' + counted(cols) + ' columns of this table.';

// ---------------------------------------------------------------- text

/**
 * A text file's bytes as text: a byte-order mark decides (UTF-8, UTF-16 LE or BE) and is dropped; otherwise UTF-8 if
 * every byte is UTF-8, else windows-1252. {text, encoding}.
 */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8' };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' }; } catch { /* not UTF-8: Windows' own code page, as Excel and Notepad wrote it */ }
  return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252' };
}

/** A text file's lines, at most `max`: {lines, truncated}. */
export function textLines(text, max = BOUNDS.lines) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > max ? { lines: lines.slice(0, max), truncated: true } : { lines, truncated: false };
}

// ---------------------------------------------------------------- CSV (RFC 4180)

const DELIMITERS = [',', ';', '\t'];
/** How much of a CSV its delimiter is sniffed from: its first ten lines, within this many characters. */
const SNIFF = 65536;
/**
 * The delimiter a CSV is written with: of `,` `;` and tab, the one found the same number of times (and at least once),
 * outside quotes, on most of its first ten lines (within its first SNIFF characters); `,` where none is.
 */
export function sniffDelimiter(text) {
  const head = String(text).slice(0, SNIFF);
  const lines = DELIMITERS.map(() => []);    // per delimiter, its count on each line
  let now = DELIMITERS.map(() => 0), q = false, any = false;
  const endLine = () => { if (any) lines.forEach((l, k) => l.push(now[k])); now = DELIMITERS.map(() => 0); any = false; };
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') q = !q;
    if (!q && (c === '\n' || c === '\r')) {
      endLine();
      if (lines[0].length >= 10) break;
      continue;
    }
    if (q && c !== '"') continue;
    any = true;
    const k = DELIMITERS.indexOf(c);
    if (k >= 0) now[k]++;
  }
  if (lines[0].length < 10) endLine();
  let best = ',', bestScore = 0;
  DELIMITERS.forEach((d, k) => {
    const counts = lines[k];
    const first = counts.find((n) => n > 0) || 0;
    const score = first ? counts.filter((n) => n === first).length : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  });
  return best;
}

/**
 * A CSV's rows of fields, RFC 4180: a field in double quotes may hold the delimiter, line ends and "" for a quote; a
 * line ends with CR LF, LF or CR. At most `maxCols` fields a row (the rest read past, never kept), and at most
 * `maxRows` rows, fewer where `maxCells` cells would be passed at the widest row's width: {rows, delimiter, truncated,
 * cutCols}.
 */
export function parseCsv(text, { maxRows = BOUNDS.rows, maxCols = BOUNDS.cols, maxCells = BOUNDS.cells, delimiter } = {}) {
  const s = String(text);
  const d = delimiter || sniffDelimiter(s);
  const rows = [];
  let row = [], field = '', q = false, fresh = true, cutCols = false, width = 0;
  /** A field ends: kept while its row has room, else read past. */
  const endField = () => { if (row.length < maxCols) row.push(field); else cutCols = true; field = ''; };
  const endRow = () => { endField(); width = Math.max(width, row.length); rows.push(row); row = []; fresh = true; };
  /** The rows that fit at the widest row so far: the widest only grows, so a row past it is past it at the end. */
  const fit = () => Math.min(maxRows, Math.floor(maxCells / Math.max(1, width)));
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const keep = row.length < maxCols;
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { if (keep) field += '"'; i++; } else q = false; } else if (keep) field += c;
      continue;
    }
    if (c === '"' && field === '' && fresh) { q = true; fresh = false; continue; }
    fresh = false;
    if (c === d) { endField(); fresh = true; } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      if (rows.length > fit()) break;
    } else if (keep) field += c;
  }
  if (field !== '' || row.length) endRow();
  const truncated = rows.length > fit();
  return { rows: truncated ? rows.slice(0, fit()) : rows, delimiter: d, truncated, cutCols };
}

// ---------------------------------------------------------------- tables

/**
 * A table's cells placed on its grid: `rows` are rows of {text, colspan?, rowspan?} as written, each cell put in the
 * first column its row has free (a cell spanning rows above takes its place below), so column C is the grid's column C.
 * The grid is cut to its first `maxCols` columns (a cell past them left out, a span held inside them) and to the rows
 * whose cells stay within `maxCells`: {rows: [[{text, c, colspan, rowspan}]], width, cut}, `cut` true where either cut.
 */
export function occupancy(rows, { maxCols = BOUNDS.cols, maxCells = BOUNDS.cells } = {}) {
  const taken = [];
  const out = [];
  let width = 0, cells = 0, cut = false;
  for (let r = 0; r < rows.length; r++) {
    const placed = [];
    let c = 0;
    for (const cell of rows[r]) {
      while (taken[r] && taken[r][c]) c++;
      if (c >= maxCols) { cut = true; break; }
      const colspan = Math.max(1, Math.min(maxCols - c, cell.colspan | 0 || 1));
      const rowspan = Math.max(1, Math.min(rows.length - r, cell.rowspan | 0 || 1));
      for (let y = r; y < r + rowspan; y++) for (let x = c; x < c + colspan; x++) (taken[y] = taken[y] || [])[x] = true;
      placed.push({ text: String(cell.text || ''), c, colspan, rowspan });
      c += colspan;
      width = Math.max(width, c);
    }
    if (cells + placed.length > maxCells) { cut = true; break; }
    cells += placed.length;
    out.push(placed);
  }
  // A cell spanning rows past the cut ends at it.
  for (let r = 0; r < out.length; r++) for (const cell of out[r]) cell.rowspan = Math.min(cell.rowspan, out.length - r);
  return { rows: out, width, cut };
}

/** A1's column letters for a column index from 0. */
export function columnName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------------------------------------------------------------- Markdown

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const HTML_START = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*|\/[A-Za-z]|!)/;
const TAGGED = /<[A-Za-z/!]/;
/** A thematic break: three or more of one of - * _, spaces and tabs between them, indented at most three spaces. */
const isRule = (line) => /^ {0,3}[-*_]/.test(line) && /^(-{3,}|\*{3,}|_{3,})$/.test(line.replace(/[ \t]/g, ''));

/**
 * Each line with its HTML comments taken out (a comment may run over lines; inside a fenced code block it is the code's
 * text and stays), the line count unchanged.
 */
function uncommented(lines) {
  const out = [];
  let inComment = false, fence = '';
  for (const line of lines) {
    if (!inComment) {
      const f = FENCE.exec(line);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(line.indexOf(f[1]) + f[1].length).trim()) fence = ''; out.push(line); continue; }
      if (f) { fence = f[1]; out.push(line); continue; }
    }
    let rest = line, kept = '';
    while (rest) {
      if (inComment) {
        const e = rest.indexOf('-->');
        if (e < 0) break;
        rest = rest.slice(e + 3);
        inComment = false;
      } else {
        const s = rest.indexOf('<!--');
        if (s < 0) { kept += rest; break; }
        kept += rest.slice(0, s);
        rest = rest.slice(s + 4);
        inComment = true;
      }
    }
    out.push(kept);
  }
  return out;
}

/** A pipe table's row as its cells' text: split on each `|` not escaped as `\|`, the outer ones dropped. */
function pipeCells(line) {
  const t = line.trim();
  const cells = [];
  let cell = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cell += '|'; i++; } else if (t[i] === '|') { cells.push(cell); cell = ''; } else cell += t[i];
  }
  cells.push(cell);
  if (t.startsWith('|')) cells.shift();
  if (t.endsWith('|') && !t.endsWith('\\|') && cells.length) cells.pop();
  return cells.map((c) => c.trim());
}
/** Whether a line is a pipe table's delimiter row: cells of dashes, each with a colon at either end or none. */
const tableRule = (line) => line.includes('-') && pipeCells(line).every((c) => /^:?-+:?$/.test(c));

/**
 * A Markdown file's blocks: ATX headings, paragraphs, list items (with their level and kind), quotes, fenced code and
 * pipe tables, each `at` {line, to} (from 1), its inline marks kept as the text they are. HTML comments are left out;
 * raw HTML, and text with a tag in it, is read by `inert` (html → its visible text: parseInert's, on the page), and is
 * left out where no `inert` is given, since what it would hide cannot be told. At most `maxLines` lines are read:
 * {blocks, truncated}.
 */
export function markdownBlocks(text, { inert, maxLines = BOUNDS.lines } = {}) {
  const all = textLines(text, maxLines);
  const lines = uncommented(all.lines);
  const blocks = [];
  const visible = (s) => (TAGGED.test(s) ? (typeof inert === 'function' ? String(inert(s)) : '') : s);
  const push = (b) => { const t = b.kind === 'table' || b.kind === 'code' ? b.text : visible(b.text).replace(/\s+/g, ' ').trim(); if (b.kind === 'table' || b.kind === 'code' || t) blocks.push({ ...b, text: t }); };
  let i = 0;
  const blank = (l) => !l || !l.trim();
  const starts = (l, next) => FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || ITEM.test(l) || isRule(l) || HTML_START.test(l) || (l.includes('|') && next !== undefined && tableRule(next));
  while (i < lines.length) {
    const line = lines[i];
    const at = { line: i + 1, to: i + 1 };
    if (blank(line)) { i++; continue; }
    const f = FENCE.exec(line);
    if (f) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const g = FENCE.exec(lines[j]);
        if (g && g[1][0] === f[1][0] && g[1].length >= f[1].length && !lines[j].slice(lines[j].indexOf(g[1]) + g[1].length).trim()) break;
        body.push(all.lines[j]);
      }
      push({ kind: 'code', text: body.join('\n'), at: { line: i + 1, to: Math.min(j + 1, lines.length) } });
      i = j + 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { push({ kind: 'h', level: h[1].length, text: h[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, ''), at }); i++; continue; }
    if (isRule(line)) { i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && tableRule(lines[i + 1])) {
      const rows = [pipeCells(line).map((t) => ({ text: visible(t) }))];
      let j = i + 2;
      for (; j < lines.length && !blank(lines[j]) && lines[j].includes('|'); j++) rows.push(pipeCells(lines[j]).map((t) => ({ text: visible(t) })));
      const grid = occupancy(rows);
      push({ kind: 'table', text: grid.rows.map((r) => r.map((c) => c.text).join('\t')).join('\n'), rows: grid.rows, width: grid.width, cut: grid.cut, head: 1, at: { line: i + 1, to: j } });
      i = j;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      let j = i;
      for (; j < lines.length && QUOTE.test(lines[j]); j++) body.push(QUOTE.exec(lines[j])[1]);
      push({ kind: 'quote', text: body.join(' '), at: { line: i + 1, to: j } });
      i = j;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const body = [item[3]];
      let j = i + 1;
      for (; j < lines.length && !blank(lines[j]) && !starts(lines[j], lines[j + 1]); j++) body.push(lines[j].trim());
      push({ kind: 'li', list: /\d/.test(item[2]) ? 'ol' : 'ul', level: Math.floor(item[1].length / 2) + 1, text: body.join(' '), at: { line: i + 1, to: j } });
      i = j;
      continue;
    }
    if (HTML_START.test(line)) {
      const body = [];
      let j = i;
      for (; j < lines.length && !blank(lines[j]); j++) body.push(lines[j]);
      push({ kind: 'p', text: body.join('\n'), at: { line: i + 1, to: j } });
      i = j;
      continue;
    }
    const body = [line.trim()];
    let j = i + 1;
    for (; j < lines.length && !blank(lines[j]) && !starts(lines[j], lines[j + 1]); j++) body.push(lines[j].trim());
    push({ kind: 'p', text: body.join(' '), at: { line: i + 1, to: j } });
    i = j;
  }
  return { blocks, truncated: all.truncated };
}

// ---------------------------------------------------------------- HTML: parsed in one place

const DROPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'SVG', 'MATH', 'SELECT', 'TEXTAREA', 'INPUT', 'BUTTON', 'CANVAS', 'VIDEO', 'AUDIO']);
const HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'INS', 'DEL', 'LABEL']);
/** A picture's name as the document worker hands it back (`agm-img:<n>`): no other source is ever drawn. */
const OWN_PICTURE = /^agm-img:\d{1,6}$/;

/** Whether an element would be drawn: not one a renderer never shows, not marked hidden, display:none or visibility:hidden. */
function shown(el) {
  const tag = String(el.tagName || '').toUpperCase();
  if (DROPPED.has(tag)) return false;
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return false;
  const st = el.style;
  if (st && (String(st.display).trim().toLowerCase() === 'none' || /^(hidden|collapse)$/i.test(String(st.visibility).trim()))) return false;
  return true;
}

/** An attribute's value, or ''. */
const attr = (el, name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) || '' : '');

/**
 * The blocks of a parsed tree (`root`: a node whose childNodes are what was parsed), walked as plain data: {blocks}.
 * Elements a renderer would not show are passed over with all they hold; inline formatting is dropped, its text kept;
 * links are text; a picture is kept only when it is one the document worker handed back (`agm-img:<n>`).
 */
export function inertBlocks(root) {
  const blocks = [];
  let buf = '';
  const flush = (kind = 'p', extra = {}) => {
    const t = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (t) blocks.push({ kind, text: t, at: { block: blocks.length + 1 }, ...extra });
  };
  const kids = (n) => Array.from(n.childNodes || []);
  /** Inline content into `buf`, pictures as blocks of their own. */
  function inline(n, kind, extra) {
    for (const c of kids(n)) {
      if (c.nodeType === 3) { buf += c.nodeValue || ''; continue; }
      if (c.nodeType !== 1 || !shown(c)) continue;
      const tag = String(c.tagName).toUpperCase();
      if (tag === 'BR') buf += ' ';
      else if (tag === 'IMG') picture(c, kind, extra);
      else if (tag === 'UL' || tag === 'OL') { flush(kind, extra); list(c, (extra && extra.level ? extra.level : 0) + 1); }
      else if (INLINE.has(tag)) inline(c, kind, extra);
      else { flush(kind, extra); block(c); }
    }
  }
  function picture(img, kind, extra) {
    const src = attr(img, 'src');
    if (!OWN_PICTURE.test(src)) return;
    flush(kind, extra);
    blocks.push({ kind: 'img', text: '', src, alt: attr(img, 'alt').slice(0, 300), at: { block: blocks.length + 1 } });
  }
  function list(el, level) {
    const kind = String(el.tagName).toUpperCase() === 'OL' ? 'ol' : 'ul';
    for (const li of kids(el)) {
      if (li.nodeType !== 1 || !shown(li)) continue;
      if (String(li.tagName).toUpperCase() !== 'LI') { block(li); continue; }
      inline(li, 'li', { list: kind, level });
      flush('li', { list: kind, level });
    }
  }
  function table(el) {
    const rows = [];
    const walkRows = (n) => {
      for (const c of kids(n)) {
        if (c.nodeType !== 1 || !shown(c)) continue;
        const tag = String(c.tagName).toUpperCase();
        if (tag === 'TR') {
          const cells = [];
          for (const td of kids(c)) {
            if (td.nodeType !== 1 || !shown(td)) continue;
            const t = String(td.tagName).toUpperCase();
            if (t !== 'TD' && t !== 'TH') continue;
            cells.push({ text: textOf(td), colspan: Number(attr(td, 'colspan')) || 1, rowspan: Number(attr(td, 'rowspan')) || 1 });
          }
          rows.push(cells);
        } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') walkRows(c);
      }
    };
    walkRows(el);
    if (!rows.length) return;
    const grid = occupancy(rows);
    blocks.push({ kind: 'table', text: grid.rows.map((r) => r.map((c) => c.text).join('\t')).join('\n'), rows: grid.rows, width: grid.width, cut: grid.cut, at: { block: blocks.length + 1 } });
  }
  /** An element's visible text, its hidden parts left out. */
  function textOf(n) {
    let t = '';
    for (const c of kids(n)) {
      if (c.nodeType === 3) t += c.nodeValue || '';
      else if (c.nodeType === 1 && shown(c)) t += (String(c.tagName).toUpperCase() === 'BR' ? ' ' : '') + textOf(c) + (INLINE.has(String(c.tagName).toUpperCase()) ? '' : ' ');
    }
    return t.replace(/\s+/g, ' ').trim();
  }
  function block(el) {
    if (el.nodeType !== 1 || !shown(el)) return;
    const tag = String(el.tagName).toUpperCase();
    if (HEADINGS[tag]) { flush(); inline(el, 'h', { level: HEADINGS[tag] }); flush('h', { level: HEADINGS[tag] }); return; }
    if (tag === 'UL' || tag === 'OL') { flush(); list(el, 1); return; }
    if (tag === 'TABLE') { flush(); table(el); return; }
    if (tag === 'PRE') { flush(); const t = textOf(el); if (t) blocks.push({ kind: 'code', text: t, at: { block: blocks.length + 1 } }); return; }
    if (tag === 'BLOCKQUOTE') { flush(); buf = textOf(el); flush('quote'); return; }
    if (tag === 'IMG') { picture(el, 'p', {}); return; }
    if (tag === 'P') { flush(); inline(el, 'p', {}); flush(); return; }
    inline(el, 'p', {});
    flush();
  }
  inline(root, 'p', {});
  flush();
  return { blocks };
}

/**
 * HTML's blocks, parsed by the browser's own parser into an inert <template> (nothing in it runs, loads or applies) and
 * walked into plain data by inertBlocks: {blocks}. The one HTML parse of the documents' modules: mammoth's HTML, and the
 * raw HTML of a Markdown file, reach the page only through it.
 */
export function parseInert(html) {
  const t = document.createElement('template');
  // eslint-disable-next-line agm/no-unescaped-html -- the one parse: an inert template, walked into plain data and never adopted into the page
  t.innerHTML = String(html || '');
  return inertBlocks(t.content);
}

/** HTML's visible text, through parseInert: what a Markdown file's raw HTML reads as. */
export const inertText = (html) => parseInert(html).blocks.map((b) => b.text).filter(Boolean).join(' ');

// ---------------------------------------------------------------- XML, for the slides

/** A local name: `p:sp` → `sp`. */
const local = (name) => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const xmlDecode = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (w, e) => {
  if (e[0] !== '#') return Object.prototype.hasOwnProperty.call(XML_ENTITIES, e) ? XML_ENTITIES[e] : w;
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}));

/**
 * An XML part as a tree of {name, attrs, kids} (a kid is an element or a string of text), read by a tag scanner. A
 * part with a document type or entity declaration, or one that does not end its tags, is refused (throws, with `why`
 * 'dtd' or 'shape').
 */
export function xmlTree(xml) {
  const s = String(xml);
  const fail = (why) => { const e = new Error(why); e.why = why; throw e; };
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) fail('dtd');
  const root = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { if (s.slice(i).trim()) top.kids.push(xmlDecode(s.slice(i))); break; }
    if (lt > i) top.kids.push(xmlDecode(s.slice(i, lt)));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) fail('shape'); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) fail('shape'); top.kids.push(s.slice(lt + 9, e)); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); if (e < 0) fail('shape'); i = e + 2; continue; }
    if (s[lt + 1] === '!') fail('dtd');
    const gt = tagEnd(s, lt);
    if (gt < 0) fail('shape');
    const inner = s.slice(lt + 1, gt);
    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      if (stack.length < 2 || stack[stack.length - 1].name !== name) fail('shape');
      stack.pop();
    } else {
      const empty = inner.endsWith('/');
      const body = empty ? inner.slice(0, -1) : inner;
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) fail('shape');
      const el = { name: m[1], attrs: {}, kids: [] };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(body.slice(m[1].length)))) el.attrs[a[1]] = xmlDecode(a[3] !== undefined ? a[3] : a[4]);
      top.kids.push(el);
      if (!empty) stack.push(el);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) fail('shape');
  return root;
}
/** Where the tag at `lt` ends (its `>`), past quoted attribute values, or -1. */
function tagEnd(s, lt) {
  let q = '';
  for (let j = lt + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === '\'') q = c; else if (c === '>') return j;
  }
  return -1;
}
const elements = (n) => (n && n.kids ? n.kids.filter((k) => typeof k === 'object') : []);
const child = (n, name) => elements(n).find((k) => local(k.name) === name) || null;
const children = (n, name) => elements(n).filter((k) => local(k.name) === name);
/** Every text under a node, in order. */
const textUnder = (n) => (typeof n === 'string' ? n : n.kids.map(textUnder).join(''));

// ---------------------------------------------------------------- slides (pptx), an outline

/** A part's relationships: id → {target, external}. */
function rels(xml, base) {
  const out = new Map();
  if (!xml) return out;
  for (const r of children(child(xmlTree(xml), 'Relationships'), 'Relationship')) {
    const external = r.attrs.TargetMode === 'External';
    out.set(r.attrs.Id, { target: external ? '' : resolve(base, r.attrs.Target || ''), external });
  }
  return out;
}
/** A relationship's target inside the package, from the folder of the part that names it. */
function resolve(base, target) {
  const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

const NON_CONTENT = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
/** Whether a shape, picture, frame, connector or group is marked hidden: it is never read, nor anything it holds. */
function hiddenShape(el) {
  const nv = elements(el).find((k) => /^nv.*Pr$/.test(local(k.name)));
  const c = nv && child(nv, 'cNvPr');
  return !!c && /^(1|true)$/i.test(c.attrs.hidden || '');
}
/** A drawing paragraph's text: its runs and fields, a break as a space. */
const paraText = (p) => elements(p).map((k) => {
  const n = local(k.name);
  if (n === 'r' || n === 'fld') return textUnder(child(k, 't') || { kids: [] });
  return n === 'br' ? ' ' : '';
}).join('');

/**
 * A deck's outline from its parts' text (`parts`: {name: xml}, the document worker's): slides in `p:sldIdLst`'s order,
 * each {n, hidden, blocks, hiddenShapes?}: a title as a heading, a placeholder's or a bulleted paragraph as an item at
 * its level, any other text as a paragraph, a table as a table, a picture as a picture (`src` its part name). A slide
 * marked `show="0"` is `hidden`; a shape, picture, frame or group marked hidden is skipped with all it holds, and counted
 * (`hiddenShapes`, only on a slide with one), since the file still holds it; presenter notes are never read. Throws,
 * with `why`, on a part it cannot read.
 */
export function pptxOutline(parts) {
  const get = (n) => (Object.prototype.hasOwnProperty.call(parts, n) ? parts[n] : '');
  const pres = xmlTree(get('ppt/presentation.xml'));
  const presRels = rels(get('ppt/_rels/presentation.xml.rels'), 'ppt/');
  const ids = children(child(child(pres, 'presentation'), 'sldIdLst'), 'sldId');
  const slides = [];
  ids.forEach((sid, k) => {
    const rel = presRels.get(sid.attrs['r:id']);
    if (!rel || rel.external || !get(rel.target)) return;
    const name = rel.target;
    const slash = name.lastIndexOf('/');
    const own = rels(get(name.slice(0, slash) + '/_rels/' + name.slice(slash + 1) + '.rels'), name.slice(0, slash + 1));
    const sld = child(xmlTree(get(name)), 'sld');
    if (!sld) return;
    const n = k + 1;
    const blocks = [];
    const at = { slide: n };
    let hiddenShapes = 0;
    const walkShapes = (tree) => {
      for (const el of elements(tree)) {
        const kind = local(el.name);
        if (['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(kind) && hiddenShape(el)) { hiddenShapes++; continue; }
        if (kind === 'grpSp') walkShapes(el);
        else if (kind === 'AlternateContent') { const choice = child(el, 'Choice'); if (choice) walkShapes(choice); }
        else if (kind === 'sp') shape(el);
        else if (kind === 'pic') picture(el);
        else if (kind === 'graphicFrame') frame(el);
      }
    };
    const shape = (sp) => {
      const nv = child(sp, 'nvSpPr');
      const ph = nv && child(child(nv, 'nvPr') || { kids: [] }, 'ph');
      const type = ph ? ph.attrs.type || 'body' : '';
      if (NON_CONTENT.has(type)) return;
      const body = child(sp, 'txBody');
      if (!body) return;
      const paras = children(body, 'p');
      if (type === 'title' || type === 'ctrTitle') {
        const t = paras.map(paraText).join(' ').replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ kind: 'h', level: 1, text: t, at });
        return;
      }
      for (const p of paras) {
        const t = paraText(p).replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const pPr = child(p, 'pPr');
        const lvl = pPr ? Math.min(8, Number(pPr.attrs.lvl) || 0) : 0;
        const bulleted = (ph && type !== 'subTitle') || (pPr && (child(pPr, 'buChar') || child(pPr, 'buAutoNum')));
        blocks.push(bulleted ? { kind: 'li', list: 'ul', level: lvl + 1, text: t, at } : { kind: 'p', text: t, at });
      }
    };
    const picture = (pic) => {
      const blip = child(child(pic, 'blipFill') || { kids: [] }, 'blip');
      const r = blip && own.get(blip.attrs['r:embed']);
      if (!r || r.external) return;
      const c = child(child(pic, 'nvPicPr') || { kids: [] }, 'cNvPr');
      blocks.push({ kind: 'img', text: '', src: r.target, alt: c ? String(c.attrs.descr || '').slice(0, 300) : '', at });
    };
    const frame = (gf) => {
      const data = child(child(gf, 'graphic') || { kids: [] }, 'graphicData');
      const tbl = data && child(data, 'tbl');
      if (!tbl) return;
      const rows = children(tbl, 'tr').map((tr) => children(tr, 'tc')
        .filter((tc) => !/^(1|true)$/i.test(tc.attrs.hMerge || '') && !/^(1|true)$/i.test(tc.attrs.vMerge || ''))
        .map((tc) => ({ text: children(child(tc, 'txBody') || { kids: [] }, 'p').map(paraText).join(' ').replace(/\s+/g, ' ').trim(), colspan: Number(tc.attrs.gridSpan) || 1, rowspan: Number(tc.attrs.rowSpan) || 1 })));
      const grid = occupancy(rows);
      blocks.push({ kind: 'table', text: grid.rows.map((r) => r.map((c) => c.text).join('\t')).join('\n'), rows: grid.rows, width: grid.width, cut: grid.cut, at });
    };
    walkShapes(child(child(sld, 'cSld') || { kids: [] }, 'spTree'));
    slides.push({ n, hidden: sld.attrs.show === '0' || sld.attrs.show === 'false', blocks, ...(hiddenShapes ? { hiddenShapes } : {}) });
  });
  return { slides };
}

// ---------------------------------------------------------------- what a seat draws

/** The page's own seat as the readers read it: the research seat sees hidden parts marked; every other seat never. */
export const seatOf = (seat) => (seat === 'research' ? 'research' : seat === 'board' ? 'board' : 'observer');

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/**
 * What a seat draws of a spreadsheet's sheet (the worker's {rows, hiddenRows, hiddenCols, noValue, origin}): {rows: [{r,
 * hidden, cells: [{c, text, noValue, hidden}]}], cols: [c], notShown}. The research seat draws every row and column, the
 * hidden ones marked; every other seat draws none of them and says how many it left out.
 */
export function planSheet(sheet, seat) {
  const research = seatOf(seat) === 'research';
  const hr = new Set(sheet.hiddenRows || []);
  const hc = new Set(sheet.hiddenCols || []);
  const nv = new Set((sheet.noValue || []).map(([r, c]) => r + ',' + c));
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  const cols = [];
  for (let c = 0; c < width; c++) if (research || !hc.has(c)) cols.push(c);
  const rows = [];
  sheet.rows.forEach((cells, r) => {
    if (!research && hr.has(r)) return;
    rows.push({ r, hidden: hr.has(r), cells: cols.map((c) => ({ c, text: nv.has(r + ',' + c) ? '' : String(cells[c] === undefined ? '' : cells[c]), noValue: nv.has(r + ',' + c), hidden: hc.has(c) })) });
  });
  const leftRows = research ? 0 : sheet.rows.filter((_, r) => hr.has(r)).length;
  const leftCols = research ? 0 : [...hc].filter((c) => c < width).length;
  const notShown = [leftRows ? plural(leftRows, 'hidden row', 'hidden rows') : '', leftCols ? plural(leftCols, 'hidden column', 'hidden columns') : ''].filter(Boolean).join(' and ');
  return { rows, cols, notShown: notShown ? notShown + ' not shown' : '' };
}

/** The sheets a seat draws: every sheet on the research seat (hidden ones marked), only the visible ones elsewhere. */
export function planBook(book, seat) {
  const research = seatOf(seat) === 'research';
  const sheets = book.sheets.filter((s) => research || !s.hidden);
  const left = book.sheets.length - sheets.length;
  return { sheets, notShown: left ? plural(left, 'hidden sheet', 'hidden sheets') + ' not shown' : '' };
}

/** The slides a seat draws: every slide on the research seat (hidden ones marked), only the shown ones elsewhere. */
export function planSlides(deck, seat) {
  const research = seatOf(seat) === 'research';
  const slides = deck.slides.filter((s) => research || !s.hidden);
  const left = deck.slides.length - slides.length;
  return { slides, notShown: left ? plural(left, 'hidden slide', 'hidden slides') + ' not shown' : '' };
}

/**
 * Whether a reader's model of a file found hidden parts in it (pure): a hidden sheet ("very hidden" alike), row or column,
 * a hidden slide or shape, or Word's hidden text (removed before the file was read, and counted). The file still holds
 * them, so a file with one is never shown with Download ticked; the server never parses a document, so this is the
 * researcher's page's guard. Any other model (a PDF, a picture, text, Markdown) has none.
 */
export function hiddenPartsOf(m) {
  if (!m) return false;
  if (m.kind === 'word') return m.hidden > 0;
  if (m.kind === 'deck') return (m.slides || []).some((s) => !!s.hidden || s.hiddenShapes > 0);
  return Array.isArray(m.sheets) && m.sheets.some((s) => !!s.hidden || (s.hiddenRows || []).length > 0 || (s.hiddenCols || []).length > 0);
}

// ---------------------------------------------------------------- the AI's text

/** A text capped at BOUNDS.aiChars. */
const capped = (s) => (s.length > BOUNDS.aiChars ? s.slice(0, BOUNDS.aiChars) : s);

/** A block's text as the AI reads it: a table's rows as tab-separated lines. */
const blockText = (b) => (b.kind === 'img' ? '' : b.text || '');

/**
 * The AI's text of a document's model, hidden parts left out on every seat: blocks in order (a Word file's with a mark
 * where each page starts, "— p. 12 —" or "— ≈ p. 12 —"), a book's visible sheets' visible cells, a deck's shown slides.
 */
export function documentText(model) {
  if (model.kind === 'book') {
    return capped(model.sheets.filter((s) => !s.hidden).map((s) => {
      const plan = planSheet(s, 'board');
      return '# ' + s.name + '\n' + plan.rows.map((r) => r.cells.map((c) => c.text).join('\t')).join('\n');
    }).join('\n\n'));
  }
  if (model.kind === 'deck') {
    return capped(model.slides.filter((s) => !s.hidden).map((s) => '— slide ' + s.n + ' —\n' + s.blocks.map(blockText).filter(Boolean).join('\n')).join('\n'));
  }
  const out = [];
  let page = 0;
  for (const b of model.blocks || []) {
    if (model.kind === 'word' && b.page && b.page !== page) { page = b.page; out.push('— ' + (b.pageApprox ? '≈ ' : '') + 'p. ' + page + ' —'); }
    const t = blockText(b);
    if (t) out.push(t);
  }
  return capped(out.join('\n'));
}

/** The words of a Word file's page box: "p. 12 of 30", or "≈ p. 12 of ≈ 30" where either is approximate. */
export const pageWords = (page, total, approx) => (approx ? '≈ p. ' + page + ' of ≈ ' + total : 'p. ' + page + ' of ' + total);

// ---------------------------------------------------------------- the document worker

/**
 * One task of the document worker (docworker.js) on a file's bytes, under a wall clock: the worker `make()` returns is
 * handed {task, bytes, opts} (the bytes transferred) and ended when it answers, fails, `ms` pass or `signal` aborts (the
 * page closed the document), whichever is first. Answers the worker's {ok: true, …} or {ok: false, why}: 'time' when the
 * clock ran out, 'closed' when it was aborted, 'worker' when it could not run, 'shape' when its answer is not one.
 */
export function readInWorker(bytes, task, { ms = BOUNDS.workerMs, make = () => new Worker('/docworker.js'), opts = {}, signal = null } = {}) {
  return new Promise((resolve) => {
    let worker = null;
    let timer = null;
    let done = false;
    const closed = () => end({ ok: false, why: 'closed' });
    const end = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', closed);
      try { if (worker) worker.terminate(); } catch { /* a worker that cannot be ended has ended */ }
      resolve(answer);
    };
    if (signal) {
      if (signal.aborted) { end({ ok: false, why: 'closed' }); return; }
      signal.addEventListener('abort', closed);
    }
    try { worker = make(); } catch { end({ ok: false, why: 'worker' }); return; }
    timer = setTimeout(() => end({ ok: false, why: 'time' }), ms);
    worker.onmessage = (e) => end(e && e.data && typeof e.data === 'object' && typeof e.data.ok === 'boolean' ? e.data : { ok: false, why: 'shape' });
    worker.onerror = (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); end({ ok: false, why: 'worker' }); };
    const transfer = bytes && bytes.byteLength !== undefined && !ArrayBuffer.isView(bytes) ? [bytes] : [];
    try { worker.postMessage({ task, bytes, opts }, transfer); } catch { end({ ok: false, why: 'worker' }); }
  });
}

// ---------------------------------------------------------------- picks: what a researcher sends to the stage (plan 4-§5.9.4, §5.9.6)

/**
 * A quote's bounds, as the server holds them (lib/pages.js SNIPPET): characters counted as code points. The bar refuses
 * before sending what the server would refuse, and offers the cut as the researcher's own choice.
 */
export const QUOTE_BOUNDS = Object.freeze({ text: 1200, items: 20, item: 300, rows: 25, cols: 10, cell: 200, blocks: 12, whole: 4000 });
/** A string's length in characters (code points). */
export const charsOf = (s) => Array.from(String(s || '')).length;
/** The first `n` characters of a string, never half a surrogate pair. */
export const firstChars = (s, n) => Array.from(String(s || '')).slice(0, n).join('');
/** A grid's cell in A1 notation, from its row and column (from 0): "C14". */
export const cellRef = (r, c) => columnName(c) + (r + 1);

/**
 * The segment of `text` of a `granularity` ('word' or 'sentence') that holds [start, end): {start, end, text}, or null
 * where the span crosses segments (or holds no word: a space, a mark). Read with Intl.Segmenter, so a tap on a word works
 * in every script it knows; without it, words are runs of letters and digits and sentences end at . ! ? and a space.
 */
export function segmentOf(text, start, end, granularity) {
  const s = String(text || '');
  const segs = [];
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    for (const g of new Intl.Segmenter(undefined, { granularity }).segment(s)) {
      if (granularity === 'word' && !g.isWordLike) continue;
      segs.push({ start: g.index, end: g.index + g.segment.length });
    }
  } else {
    const re = granularity === 'word' ? /[\p{L}\p{N}\p{M}'’_-]+/gu : /[^.!?]+(?:[.!?]+|$)/g;
    for (let m = re.exec(s); m; m = re.exec(s)) { segs.push({ start: m.index, end: m.index + m[0].length }); if (!m[0].length) re.lastIndex++; }
  }
  const hit = segs.find((g) => g.start <= start && end <= g.end && (end > start || start < g.end));
  if (!hit) return null;
  const t = s.slice(hit.start, hit.end).trim();
  return t ? { start: hit.start, end: hit.end, text: t } : null;
}

/**
 * A grid's cells for a quote (pure): a cell, a row, a column or a range of `get(r, c)` (the cell's words), over the rows and
 * columns a seat may pick (`rows`, `cols`: their indexes in order, hidden ones never among them), with the sheet's labels
 * (`labels`: {row, col}, the row of headers and the column of names, either -1 for none) where `withLabels`:
 *   - a cell: with each label it has, its value the focus: the 2 × 2 table of its corner, its column's label, its row's
 *     label and itself; the 2 × 1 of its column's label over it, or the 1 × 2 of its row's label beside it, where only one
 *     is marked; alone (1 × 1) without labels, or where it is a label itself;
 *   - a row: the label row above it; a column: its label cell above it; a range: the label row and column beside it where
 *     they are outside it.
 * {unit, table: {rows, head, side, ref, focus?}, size} (`size`: its cells but a single cell's characters, for the bar), or
 * where it is over QUOTE_BOUNDS's 25 rows × 10 columns {error, over: {rows, cols}}; with `cut`, its first 25 rows and 10 columns,
 * the labels kept, `cut` true and `more` the rows and columns left out. `name` makes `ref` a sheet's ("'Q3'!C14"). null where a
 * row or a column it names (r, c, r1, c1) is not among `rows` and `cols`: a hidden one is never quoted.
 */
export function gridQuote(get, { unit, r, c, r1 = r, c1 = c, rows, cols, labels = { row: -1, col: -1 }, withLabels = true, name = '', cut = false }) {
  if (![r, r1].every((x) => rows.includes(x)) || ![c, c1].every((x) => cols.includes(x))) return null;
  const lr = withLabels && rows.includes(labels.row) ? labels.row : -1;
  const lc = withLabels && cols.includes(labels.col) ? labels.col : -1;
  const sheetRef = (ref) => (name ? '\'' + String(name).replace(/'/g, '\'\'') + '\'!' + ref : ref);
  let rowIds, colIds, head, side = 0, focus = null, ref;
  if (unit === 'cell') {
    const label = r === lr || c === lc;
    const above = !label && lr >= 0;
    const beside = !label && lc >= 0;
    rowIds = above ? [lr, r] : [r];
    colIds = beside ? [lc, c] : [c];
    head = above ? 1 : 0;
    side = beside ? 1 : 0;
    focus = [head, side];
    ref = cellRef(r, c);
  } else if (unit === 'row') {
    rowIds = lr >= 0 && r !== lr ? [lr, r] : [r];
    colIds = cols.slice();
    head = rowIds.length > 1 ? 1 : 0;
    side = lc >= 0 && colIds[0] === lc ? 1 : 0;
    ref = 'row ' + (r + 1);
  } else if (unit === 'column') {
    rowIds = lr >= 0 && c !== lc ? [lr, ...rows.filter((x) => x !== lr)] : rows.slice();
    colIds = [c];
    head = lr >= 0 && c !== lc ? 1 : 0;
    ref = 'column ' + columnName(c);
  } else {
    const inRows = rows.filter((x) => x >= Math.min(r, r1) && x <= Math.max(r, r1));
    const inCols = cols.filter((x) => x >= Math.min(c, c1) && x <= Math.max(c, c1));
    rowIds = lr >= 0 && !inRows.includes(lr) && lr < inRows[0] ? [lr, ...inRows] : inRows;
    colIds = lc >= 0 && !inCols.includes(lc) && lc < inCols[0] ? [lc, ...inCols] : inCols;
    head = lr >= 0 && rowIds[0] === lr ? 1 : 0;
    side = lc >= 0 && colIds[0] === lc ? 1 : 0;
    ref = cellRef(Math.min(r, r1), Math.min(c, c1)) + ':' + cellRef(Math.max(r, r1), Math.max(c, c1));
  }
  const over = { rows: Math.max(0, rowIds.length - QUOTE_BOUNDS.rows), cols: Math.max(0, colIds.length - QUOTE_BOUNDS.cols) };
  if ((over.rows || over.cols) && !cut) return { error: 'Too big for the stage: narrow it to 25 rows × 10 columns', over: { rows: rowIds.length, cols: colIds.length } };
  const keptRows = rowIds.slice(0, QUOTE_BOUNDS.rows);
  const keptCols = colIds.slice(0, QUOTE_BOUNDS.cols);
  const table = { rows: keptRows.map((y) => keptCols.map((x) => String(get(y, x) || ''))), head, side, ref: unit === 'cell' || unit === 'range' ? sheetRef(ref) : ref };
  if (focus) table.focus = focus;
  const values = Math.max(0, keptRows.length - head) * Math.max(0, keptCols.length - side);
  const size = unit === 'cell' ? charsOf(table.rows[focus[0]][focus[1]]) + ' ch' : values + (values === 1 ? ' cell' : ' cells');
  return { unit, table, size, ...(over.rows || over.cols ? { cut: true, more: over } : {}) };
}

/**
 * A sheet's labels by default (pure; plan 4-§5.9.4): its label row the last of its frozen rows and its label column the
 * last of its frozen columns (`frozen`, {rows, cols} counted from the first read), where it freezes them and a pick may
 * read that row or column; else the first row and the first column a pick may read (row 1 and column A where none is
 * hidden). A finance sheet's title rows above its frozen header are so never a cell's label. {row, col}, -1 for none.
 */
export function labelsOf(frozen, rows, cols) {
  const f = frozen && typeof frozen === 'object' ? frozen : {};
  const at = (n, list) => (Number.isInteger(n) && n >= 1 && list.includes(n - 1) ? n - 1 : list.length ? list[0] : -1);
  return { row: at(f.rows, rows), col: at(f.cols, cols) };
}

/**
 * A tagged PDF's table cell, row or column as a quote's body (pure): `get(r, c)` its cells' words, `roles` its rows' cells'
 * structure roles ('TH' or 'TD'), the first row its labels where every cell of it is a TH. {unit, table, cut?, more?}, or
 * {error, over} over 25 rows × 10 columns unless the researcher chose the cut, or null for any other unit or a cell not
 * in it. A cell's place is said as its row and column, which is all a PDF's table names.
 */
export function structQuote(get, roles, { unit, r, c, labels = true, cut = false }) {
  if (!['cell', 'row', 'column'].includes(unit) || !roles[r] || c >= roles[r].length) return null;
  const width = Math.max(0, ...roles.map((x) => x.length));
  const headRow = roles[0] && roles[0].length && roles[0].every((k) => k === 'TH') ? 0 : -1;
  const q = gridQuote(get, { unit, r, c, rows: roles.map((_, i) => i), cols: Array.from({ length: width }, (_, i) => i), labels: { row: headRow, col: -1 }, withLabels: labels, cut });
  if (!q || q.error) return q;
  return { unit, table: { ...q.table, ref: unit === 'cell' ? 'row ' + (r + 1) + ', column ' + (c + 1) : q.table.ref }, ...(q.cut ? { cut: true, more: q.more } : {}) };
}

/** A dense grid of a table's words from its occupancy rows ({text, c, colspan, rowspan}): a merged cell's words in each place it covers. */
export function denseRows(rows, width) {
  const out = rows.map(() => Array.from({ length: width }, () => ''));
  rows.forEach((row, r) => {
    for (const cell of row) {
      for (let y = r; y < Math.min(rows.length, r + (cell.rowspan || 1)); y++) {
        for (let x = cell.c; x < Math.min(width, cell.c + (cell.colspan || 1)); x++) out[y][x] = String(cell.text || '');
      }
    }
  });
  return out;
}

/**
 * Words cut to a quote's bound, as the researcher chose: {text, cut} — the first QUOTE_BOUNDS.text characters and `cut` true where
 * it was longer, the words as they are otherwise.
 */
export function cutText(text) {
  const all = Array.from(String(text || ''));
  return all.length > QUOTE_BOUNDS.text ? { text: all.slice(0, QUOTE_BOUNDS.text).join(''), cut: true } : { text: all.join(''), cut: false };
}

/** A quote's size as the bar says it beside its unit: "240 ch", "6 cells", "3 items". */
export function quoteSize(q) {
  if (!q) return '';
  if (q.table && q.unit !== 'cell') {
    const n = Math.max(0, q.table.rows.length - (q.table.head || 0)) * Math.max(0, (q.table.rows[0] || []).length - (q.table.side || 0));
    return n + (n === 1 ? ' cell' : ' cells');
  }
  if (q.table && Array.isArray(q.table.focus)) return charsOf(q.table.rows[q.table.focus[0]][q.table.focus[1]]) + ' ch';
  if (Array.isArray(q.items) && q.unit === 'item') return q.items.length + (q.items.length === 1 ? ' item' : ' items');
  const words = [q.title, q.text, ...(q.items || []), ...((q.blocks || []).map((b) => (b.table ? b.table.rows.flat().join(' ') : b.text)))].filter(Boolean).join(' ');
  return charsOf(words) + ' ch';
}

/** Every string of a quote the stage draws, as the server counts them (lib/pages.js snippetStrings): its title, note and body. */
function quoteStrings(q) {
  const out = [q.title, q.note, q.text, ...(Array.isArray(q.items) ? q.items : [])];
  const cells = (t) => { if (t && t.ref) out.push(t.ref); for (const r of (t && t.rows) || []) out.push(...r); };
  if (q.table) cells(q.table);
  for (const b of q.blocks || []) { if (b.table) cells(b.table); else out.push(b.text); }
  return out.filter((s) => typeof s === 'string');
}
/**
 * The bound a quote passes, in the server's words, or '' within every bound (pure): a cell of more than 200 characters, more
 * than 12 blocks, a block's text of more than 1,200, more than 4,000 characters in all. The bar says it before anything goes.
 */
export function quoteOver(q) {
  if (!q) return '';
  const B = QUOTE_BOUNDS;
  const tables = [q.table, ...((q.blocks || []).map((b) => b.table))].filter(Boolean);
  const cell = Math.max(0, ...tables.flatMap((t) => (t.rows || []).flat().map(charsOf)));
  if (cell > B.cell) return 'Too long for the stage: a cell ' + counted(B.cell) + ' characters at most (this is ' + counted(cell) + ')';
  if (Array.isArray(q.blocks) && q.blocks.length > B.blocks) return 'Too much for the stage: ' + B.blocks + ' blocks at most (this is ' + counted(q.blocks.length) + ')';
  const block = Math.max(0, ...(q.blocks || []).filter((b) => !b.table).map((b) => charsOf(b.text)));
  if (block > B.text) return 'Too long for the stage: ' + counted(B.text) + ' characters a block at most (this is ' + counted(block) + ')';
  const all = quoteStrings(q).reduce((n, s) => n + charsOf(s), 0);
  if (all > B.whole) return 'Too long for the stage: ' + counted(B.whole) + ' characters at most (this is ' + counted(all) + ')';
  return '';
}
/**
 * The blocks in view as What I see sends them (pure; `blocks` each {kind, text} or {kind: 'table', table}, a table whole as
 * drawn): {blocks} within the stage's bounds, else {blocks, over} with `over` the first bound passed in words and `blocks`
 * what fits — the first 12 blocks, each table's first 25 rows × 10 columns, each block's first 1,200 characters, a cell's
 * first 200, and no block past 4,000 characters in all with its `note`. What fits goes only as the researcher chooses (Send
 * what fits), told first how much is in view.
 */
export function viewQuote(blocks, { note = '' } = {}) {
  const B = QUOTE_BOUNDS;
  const tableOver = blocks.find((b) => b.table && ((b.table.rows || []).length > B.rows || Math.max(0, ...(b.table.rows || []).map((r) => r.length)) > B.cols));
  const whole = { unit: 'view', blocks, ...(note ? { note } : {}) };
  const over = blocks.length > B.blocks ? 'Too much in view for the stage: ' + counted(blocks.length) + ' blocks (' + B.blocks + ' at most)'
    : tableOver ? 'Too much in view for the stage: a table of ' + counted(tableOver.table.rows.length) + ' rows × ' + counted(Math.max(0, ...tableOver.table.rows.map((r) => r.length))) + ' columns (25 rows × 10 columns at most)'
      : quoteOver(whole).replace(/^Too (long|much) for the stage/, 'Too much in view for the stage');
  if (!over) return { blocks };
  const fit = [];
  let left = B.whole - charsOf(note);
  for (const b of blocks.slice(0, B.blocks)) {
    if (b.table) {
      const rows = b.table.rows.slice(0, B.rows).map((r) => r.slice(0, B.cols).map((c) => firstChars(c, B.cell)));
      const n = rows.flat().reduce((s, c) => s + charsOf(c), 0);
      if (n > left) break;
      left -= n;
      fit.push({ ...b, table: { ...b.table, rows } });
      continue;
    }
    const text = firstChars(b.text, Math.min(B.text, left));
    if (!text) break;
    left -= charsOf(text);
    fit.push({ ...b, text });
  }
  return { blocks: fit, over };
}
