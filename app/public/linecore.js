'use strict';
/**
 * The one line of plain text a push carries to the speaker's screen (plan 4-§5.9.10): a quote's words in one line, its
 * marked labels with them ("Revenue Q3: £4.2m", "Q3: Revenue £4.2m · Costs £3.9m"), or a document's or a picture's note.
 * Pure over the take's content it is handed, whatever that content's source.
 *
 * One core, two callers: the server, which builds the line from the take it stored (lib/stagelines.js flatten: the line
 * sent with a push is its own words, never the page's), and the hall page, which shows that line in the bar before it
 * goes and sends it with the push's number. So the line a person read is the line the server builds, and a line that is
 * not is refused.
 *
 * Invariants:
 *   - The line holds the words drawn on the stage and nothing else: never a file's name, an address, a page or a cell's
 *     reference, a cut's count or a source, unless a person typed them as the words or the note.
 *   - A quote's line is its title and its body: text as it reads, items joined by " · ", a table by its marked labels
 *     (`head` rows of column labels, `side` columns of row labels), the blocks in view each as one of those. A cell is
 *     its labels, then its value ("Revenue Q3: 4.2"); one row or one column is its own label, then each value with the
 *     other's label ("Q3: Revenue 4.2 · Costs 3.9"); a range is each row so, the rows joined by "; ". An empty value and
 *     the corner over the labels say nothing.
 *   - A document's or a picture's line is its note alone; every other kind has none ('').
 *   - The line of a content as the page holds it is the line of that content as the server stores it: each string is
 *     first read as the server's cleaner keeps it (lib/guard.js: a quote's words as cleanBlock, a title and a note as
 *     cleanText, cut where it cuts them: a title at TITLE_MAX, a note at NOTE_MAX), so the page never shows a line the
 *     server would build otherwise (test/showbus.test.js holds the two equal over every character of the BMP).
 *   - One line: line breaks and runs of white space are one space, control and invisible characters are dropped (every
 *     one either cleaner drops), the ends trimmed, and `{` `}` are `(` `)` (Stagewatch reads a brace as its own
 *     placeholder): what the speaker's screen shows. Never cut beyond the cleaner's own cuts: the bounds are Stagewatch's
 *     (SENT_MAX sent now, DESK_MAX through the show desk), said by the bar and kept by the server's send.
 *
 * Loaded by Node (`require`), and as a classic script on the hall page, where it is `AGMLine`.
 */
(function (scope) {
  /** Stagewatch keeps this many UTF-16 units of a message sent now (lib/stagelines.js MESSAGE_MAX). */
  const SENT_MAX = 500;
  /** …and this many of the words of a message asked of its show desk, whose line it keeps at 400 (lib/stagelines.js lineFor). */
  const DESK_MAX = 377;
  /** A line reads at a glance up to about this many characters (an estimate from Stagewatch's layout, not measured). */
  const GLANCE = 60;
  /** A quote's title is kept to this many UTF-16 units by the server (lib/pages.js SNIPPET.title). */
  const TITLE_MAX = 120;
  /** A document's, a picture's or a quote's note is kept to this many UTF-16 units by the server (lib/pages.js). */
  const NOTE_MAX = 200;

  /** What guard.cleanBlock drops from a quote's words (its UNSAFE_BLOCK): every control character but the line break, the bidirectional marks, overrides and isolates, U+200B, U+2060 and U+FEFF. */
  const BLOCK_DROPS = /(?!\n)[\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
  /** What guard.cleanText drops from a title or a note (its UNSAFE_TEXT): every control character, and the bidirectional marks, overrides and isolates. */
  const TEXT_DROPS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
  /** What a line never carries: every character either of the two drops. */
  const INVISIBLE = /[\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

  const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');
  /** The words as one line of the speaker's screen: one space for every break and run of spaces, nothing invisible, `(` `)` for braces. */
  const one = (s) => str(s).replace(/[\r\n\t\v\f]+/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().replace(/\{/g, '(').replace(/\}/g, ')');
  /** A quote's words as guard.cleanBlock keeps them, in one line (the cleaner never cuts them: a bound is refused). */
  const words = (s) => one(str(s).replace(/\r\n|[\r\u2028\u2029]/g, '\n').replace(/\t/g, ' ').replace(BLOCK_DROPS, ''));
  /** A title or a note as guard.cleanText keeps it, cut where it cuts (`max`), in one line. */
  const kept = (s, max) => one(str(s).replace(TEXT_DROPS, '').trim().slice(0, max));
  /** Words given, one space between them; '' for none. */
  const joined = (list, sep) => list.map(words).filter(Boolean).join(sep);

  /** A table's cells in one line, by its marked labels. */
  function tableLine(t) {
    if (!isRecord(t) || !Array.isArray(t.rows)) return '';
    const rows = t.rows.map((r) => (Array.isArray(r) ? r : []));
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    const head = Number.isInteger(t.head) && t.head > 0 ? Math.min(t.head, rows.length) : 0;
    const side = Number.isInteger(t.side) && t.side > 0 ? Math.min(t.side, width) : 0;
    const cell = (r, c) => words(rows[r][c]);
    const colLabel = (c) => joined(rows.slice(0, head).map((r) => r[c]), ' ');
    const rowLabel = (r) => joined(rows[r].slice(0, side), ' ');
    const dataRows = [];
    for (let r = head; r < rows.length; r++) dataRows.push(r);
    const dataCols = [];
    for (let c = side; c < width; c++) dataCols.push(c);
    const labelled = (label, said) => (label && said ? label + ': ' + said : said);
    if (dataRows.length === 1 && dataCols.length === 1) {
      const r = dataRows[0], c = dataCols[0];
      return labelled([rowLabel(r), colLabel(c)].filter(Boolean).join(' '), cell(r, c));
    }
    if (dataCols.length === 1) {
      const c = dataCols[0];
      return labelled(colLabel(c), dataRows.map((r) => (cell(r, c) ? [rowLabel(r), cell(r, c)].filter(Boolean).join(' ') : '')).filter(Boolean).join(' · '));
    }
    const rowWords = (r) => labelled(rowLabel(r), dataCols.map((c) => (cell(r, c) ? [colLabel(c), cell(r, c)].filter(Boolean).join(' ') : '')).filter(Boolean).join(' · '));
    return dataRows.map(rowWords).filter(Boolean).join('; ');
  }

  /** A quote's words in one line: its title, then its body. */
  function quoteLine(c) {
    const body = [];
    if (typeof c.text === 'string') body.push(words(c.text));
    if (Array.isArray(c.items)) body.push(joined(c.items, ' · '));
    if (isRecord(c.table)) body.push(tableLine(c.table));
    if (Array.isArray(c.blocks)) body.push(c.blocks.map((b) => (!isRecord(b) ? '' : isRecord(b.table) ? tableLine(b.table) : words(b.text))).filter(Boolean).join(' · '));
    const said = body.filter(Boolean).join(' · ');
    const title = kept(c.title, TITLE_MAX);
    return title && said ? title + ': ' + said : title || said;
  }

  /** The line a take's content carries to the speaker's screen, or '' where it carries none. */
  function flatten(content) {
    if (!isRecord(content)) return '';
    if (content.kind === 'snippet') return quoteLine(content);
    if (content.kind === 'doc' || content.kind === 'image') return kept(content.note, NOTE_MAX);
    return '';
  }

  const api = Object.freeze({ SENT_MAX, DESK_MAX, GLANCE, TITLE_MAX, NOTE_MAX, flatten, one });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else scope.AGMLine = api;
})(globalThis);
