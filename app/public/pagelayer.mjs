// What a person's page is shown over its chat (a take), drawn: Stagewatch's countdown, AGMessage's clock, a holding slide,
// black, a web page, a document (the whole file, opened at its place, paged and zoomed: docview.mjs, the drawing the page's
// seat draws), a picture (with zoom) and a quote (words or cells a researcher picked, drawn from data in the largest type
// that fits). The hall page (app.js) loads this module with import() 2 s after a Board page's
// join, or at its first take, hands it a box and plain values (Stagewatch's frame, AGMessage's clock offset and zone, the
// hall's name and holding picture, who put the take up, the page's seat, whether the page is connected, and `card` where the
// box is a card in the side bar) and reads back
// what it drew; the page alone says so to the server (page:report), so what was drawn is said in one place, from the
// drawing. Nothing here holds a socket, and every node is built with the DOM and textContent.
//
//   render(box, content, ctx) → Promise<{state, words}>   the take drawn into box (what it held before let go first):
//                                                          'shown' (a web page: 'opened'), or 'failed' and why
//   clear(box)                                             what box holds let go: a document's reader destroyed, its
//                                                          object URLs revoked, the box emptied
//   card(content, ctx)        → element                   the take as a card in the side bar: its icon, its name, and its
//                                                          live words (the countdown's time, the clock's)
//   tick(root, ctx)                                        the live parts under root drawn again (the clock, Stagewatch)
//   prepare()                 → Promise                    the document reader imported ahead of a first document
//   webAddress(url)           → {url, host} | {error}      a web page's address as a frame may be given it
//   framePage(url)            → {frame, url, host} | {error}  the one frame a page makes, for a web page (a take, a Preview)
//   quote(content, ctx)       → element                   a quote as the stage draws it, unfitted (the researcher's bar
//                                                          shows it so before it goes)
//   fitQuote(box, el, o)      → {fits}                    a quote's type set to the largest that fits its box (`keep`: its
//                                                          own type kept, a card's), its tables marked long where it is not
//   quoteWords(content)       → string                    a quote's words in reading order, one line each
//
// Invariants for a file a take shows (a document, a picture):
//   - Checked again here: its address is an upload of AGMessage's (/uploads/<name>) of a type the stage shows (a
//     picture's an image's), or nothing of it is fetched and the take is `failed`; a document told without its address
//     (a page seated as an observer) draws nothing of it.
//   - Drawn from memory and kept by no device: fetched `no-store`, a picture through an object URL revoked when the take
//     goes, a document's reader (its pdf.js document among it) destroyed then (clear), as docview.mjs keeps them.
//   - Never dragged out: every picture in the box is `draggable=false` and a drag that starts in it is cancelled; the page
//     holds the box's menus (AGMessage's, Shift+right-click included) and hides it from print.
//   - docview.mjs is imported with import() only, never statically, so a device that cannot load it loses documents and
//     pictures alone, and says so.
//
// Invariants for a quote:
//   - Drawn from its data with the DOM and textContent alone, never as HTML: a paragraph in a <blockquote>, items in a list,
//     cells in a <table>, each paragraph and cell `dir="auto"`, its line breaks kept (white-space: pre-wrap).
//   - The largest type that fits, found in at most QUOTE_STEPS steps between QUOTE_MIN px (QUOTE_PHONE px under 600 px
//     wide, a phone) and 12vw; a quote longer than the screen at the smallest scrolls, and its take says so when shown. In a
//     side bar's card it keeps the card's type.
//   - A table wider than its card scrolls sideways inside it, and one in a quote longer than its box scrolls down inside it
//     too, its label row and column kept in view either way; numbers read to the
//     right; the cell it is of is outlined and bold, never marked by colour alone; a table cut short says how much is left.
//   - Its source line says who quoted it and from where, in their voice: the quote is their claim, never AGMessage's.

/** Each kind's card: its icon (no status mark: each mark has one meaning, common.js AGM.MARKS) and its name. */
const KINDS = Object.freeze({
  stage: Object.freeze({ icon: '⏱', name: 'Stagewatch' }),
  clock: Object.freeze({ icon: '🕐', name: 'Clock' }),
  holding: Object.freeze({ icon: '🖼', name: 'Holding' }),
  blank: Object.freeze({ icon: '🌑', name: 'Blank' }),
  web: Object.freeze({ icon: '🌍', name: 'Web page' }),
  doc: Object.freeze({ icon: '📄', name: 'Document' }),
  image: Object.freeze({ icon: '🖼', name: 'Picture' }),
  snippet: Object.freeze({ icon: '❝', name: 'Quote' }),
});
/** An upload's address as AGMessage makes one (lib/guard.js validUploadUrl), and the file types the stage shows. */
const UPLOAD = /^\/uploads\/[0-9]{10,16}-[a-z0-9]{12}-[A-Za-z0-9._-]{1,60}$/;
const STAGE_TYPES = Object.freeze(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'pptx']);
const IMAGES = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const extOf = (url) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; };
/** The readers' seats (docview.mjs): the page's own, never the take's. */
const SEATS = Object.freeze(['research', 'board', 'observer']);
/**
 * How long a web page has to load before its take says it did not (`failed`). A frame the site refuses (its
 * X-Frame-Options or frame-ancestors) still fires `load`, and nothing inside it can be read, so `load` is all that is
 * known: the page opened.
 */
const WEB_WAIT_MS = 15000;
const WEB_MAX = 2048;

const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** A kind's icon and name, or none for a kind this page does not draw. */
const kindOf = (content) => (content && Object.prototype.hasOwnProperty.call(KINDS, content.kind) ? KINDS[content.kind] : null);

/**
 * Whether Stagewatch's time is live: the link connected (or viewing its public frame), its frame fresh, and this page
 * connected. Otherwise the time reads --:--, never a confident stale time (the screen page's rule, display.js).
 */
const liveStage = (ctx) => {
  const v = ctx && ctx.stage;
  return !!(v && (v.status === 'connected' || v.status === 'viewing') && !v.stale && ctx.connected !== false);
};

// The clock by AGMessage's clock (the server's `now` against this device's, `offset`) and in AGMessage's time zone; a
// browser that does not know that zone shows its own rather than no clock.
const formats = new Map();
function clockFormats(tz) {
  const key = tz || '';
  if (formats.has(key)) return formats.get(key);
  const t = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const d = { weekday: 'long', day: 'numeric', month: 'long' };
  let f = null;
  if (tz) {
    try { f = [new Intl.DateTimeFormat([], { ...t, timeZone: tz }), new Intl.DateTimeFormat([], { ...d, timeZone: tz })]; } catch { /* a zone this browser does not know: its own, below */ }
  }
  if (!f) f = [new Intl.DateTimeFormat([], t), new Intl.DateTimeFormat([], d)];
  formats.set(key, f);
  return f;
}
const nowOf = (ctx) => new Date(Date.now() + ((ctx && Number.isFinite(ctx.offset)) ? ctx.offset : 0));

/** Stagewatch's frame drawn into its parts (a take's, or a card's time alone). */
function drawStage(root, ctx) {
  const v = (ctx && ctx.stage) || null;
  const live = liveStage(ctx);
  const time = root.querySelector('.take-time');
  if (time) time.textContent = live && v.text ? v.text : '--:--';
  root.classList.toggle('stale', !live);
  const title = root.querySelector('.take-title');
  if (title) title.textContent = v && v.title ? v.title : v ? '' : 'No stage timer linked';
  const next = root.querySelector('.take-next');
  if (next) next.textContent = live && v.next ? 'Next: ' + v.next : '';
  const message = root.querySelector('.take-message');
  if (message) { message.textContent = live && v.message ? v.message : ''; message.hidden = !message.textContent; }
}
/** The clock drawn into its parts. */
function drawClock(root, ctx) {
  const f = clockFormats(ctx && ctx.tz);
  const now = nowOf(ctx);
  const time = root.querySelector('.take-time');
  if (time) time.textContent = f[0].format(now);
  const date = root.querySelector('.take-date');
  if (date) date.textContent = f[1].format(now);
}

/**
 * A web page's address as a frame may be given it, checked again in the page (the server's rules, lib/pages.js webUrl):
 * a string of at most WEB_MAX characters that parses, https alone, no user name or password, and not this page's own
 * origin nor this device by a loopback name. {url, host}, or {error} in words.
 */
export function webAddress(v) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw || raw.length > WEB_MAX) return { error: raw ? 'That address is longer than ' + WEB_MAX + ' characters.' : 'A web page is shown by its https address, as a browser shows it.' };
  let u;
  try { u = new URL(raw); } catch { return { error: 'A web page is shown by its https address, as a browser shows it.' }; }
  if (u.protocol !== 'https:' || !u.hostname) return { error: 'A web page is shown by its https address, as a browser shows it.' };
  if (u.username || u.password) return { error: 'An address with a user name or a password is not shown: show the page without them.' };
  const h = u.hostname;
  // A name's trailing dot (`localhost.`) names the same machine: the URL parser keeps it on a name.
  const b = h.replace(/\.+$/, '');
  const loop = b === 'localhost' || b.endsWith('.localhost') || /^(?:127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b) || b === '[::1]' || b === '[::]' || /^\[::ffff:/.test(b);
  if (u.origin === location.origin || loop) return { error: 'That address is AGMessage itself: show a page of another site.' };
  return { url: u.href, host: h };
}

/**
 * The one frame a page makes (a web page shown to a person, or previewed by the one who shows it): scripts but no forms,
 * popups, top navigation, modal dialogs or downloads (sandbox: owner question 6), no referrer (the hall page's address
 * carries its code and its invite), no feature the page itself may use (`allow`), no cookies of the site's own where
 * the browser offers that (`credentialless`), and a title naming its host. {frame, url, host}, or {error} for an address
 * webAddress refuses.
 */
export function framePage(url) {
  const w = webAddress(url);
  if (w.error) return w;
  const frame = document.createElement('iframe');
  frame.className = 'take-web-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  if ('credentialless' in frame) frame.credentialless = true;
  frame.title = 'Web page from ' + w.host;
  frame.src = w.url;
  return { frame, url: w.url, host: w.host };
}

/**
 * A web page drawn into `box`: a strip in AGMessage's own words (who chose it, its host, and not to type a password), and
 * the page framed under it. 'opened' once the frame loads, or 'failed' when it has not in WEB_WAIT_MS or its address is
 * refused; the frame is left in place either way, so a page that loads late is still seen.
 */
function drawWeb(box, content, ctx) {
  const by = (ctx && ctx.by) || 'someone';
  const made = framePage(content && content.url);
  const w = make('div', 'take-web');
  const note = make('p', 'take-web-note', 'A web page chosen by ' + by + ' (' + (made.host || (content && content.host) || 'no address') + '). Don\'t type passwords here.');
  w.append(note);
  box.append(w);
  if (made.error) return Promise.resolve({ state: 'failed', words: made.error });
  return new Promise((resolve) => {
    let done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => end({ state: 'failed', words: 'the page did not load' }), WEB_WAIT_MS);
    made.frame.addEventListener('load', () => end({ state: 'opened', words: '' }), { once: true });
    w.append(made.frame);
  });
}

// ---------------------------------------------------------------- a document, a picture
/** docview.mjs, imported once: the document reader the Preview and the panel draw with. */
let reader = null;
export function prepare() {
  if (!reader) reader = import('./docview.mjs').catch((e) => { reader = null; throw e; });
  return reader;
}
/** Each box's document or picture now: its reader, destroyed when the box is let go (clear). */
const views = new WeakMap();
/** The boxes whose drags are cancelled: a picture is never dragged out of a take. */
const guarded = new WeakSet();

/** A place in words: "p. 12", "≈ p. 3", "slide 3", "sheet 2", "line 40", "row 4" (a CSV's), "¶ 12"; '' for none. */
function placeSaid(at, ext) {
  if (!at || typeof at !== 'object') return '';
  const n = (k) => (Number.isInteger(at[k]) && at[k] > 0 ? at[k] : 0);
  if (n('page')) return (at.approx === true ? '≈ p. ' : 'p. ') + n('page');
  if (n('slide')) return 'slide ' + n('slide');
  if (n('sheet')) return 'sheet ' + n('sheet');
  if (n('block')) return '¶ ' + n('block');
  if (n('line')) return (ext === 'csv' ? 'row ' : 'line ') + n('line');
  return '';
}
/**
 * Where docview opens a place: its unit by number (a page, a slide, a sheet, a line or row), and a Word paragraph by its
 * number (¶), at which the view opens, on its page where one is given.
 */
function placeAt(at) {
  if (!at || typeof at !== 'object') return null;
  const block = Number.isInteger(at.block) && at.block > 0 ? { block: at.block } : {};
  for (const k of ['page', 'slide', 'sheet', 'line']) if (Number.isInteger(at[k]) && at[k] > 0) return { page: at[k], ...block };
  return block.block ? block : null;
}
const text = (v) => (typeof v === 'string' ? v : '');
/** Whose picture, of what: "Ana's picture of Board pack.pdf, p. 12", "… of part of Stage plan.png", "… of their copy of …". */
function pictureSaid(content, by) {
  const from = content.from && typeof content.from === 'object' ? content.from : null;
  if (!from) return text(content.name) || 'A picture';
  const type = text(from.type);
  const part = IMAGES.includes(type);
  const room = text(from.roomName) ? ' (' + from.roomName + ')' : '';
  const place = part ? '' : placeSaid(from.at, type);
  return (by ? by + '\'s picture' : 'A picture') + ' of ' + (part ? 'part of ' : '') + (from.local === true ? 'their copy of ' : '') + text(from.name) + room + (place ? ', ' + place : '');
}
/** What a file's take says under its drawing: its name and place, a side room's in brackets; a picture, whose and of what. */
function fileSaid(content, ctx) {
  if (content.kind === 'image') return pictureSaid(content, (ctx && ctx.by) || '');
  const place = placeSaid(content.at, extOf(content.url) || extOf(content.name));
  return (text(content.name) || 'A document') + (text(content.roomName) ? ' (' + content.roomName + ')' : '') + (place ? ' · ' + place : '');
}
/** A reader's failure in the take's words (plan 4-§5.9.11): a picture's, or a document's. */
function failedSaid(kind, words) {
  const w = text(words);
  if (kind === 'image') return /too big/i.test(w) ? 'too big for this device' : 'the picture did not load';
  if (/fetch/.test(w)) return 'the file could not be read';
  return w || 'the file could not be read';
}
/** No picture in `box` is dragged out: each is draggable=false, and a drag that starts in the box is cancelled. */
function noDrag(box) {
  for (const img of box.querySelectorAll('img')) img.setAttribute('draggable', 'false');
  if (guarded.has(box)) return;
  guarded.add(box);
  box.addEventListener('dragstart', (e) => e.preventDefault());
}
/**
 * A document or a picture drawn into `box` through docview.mjs, at its place, as the page's seat draws it (`ctx.seat`),
 * with its line under it (its name and place, or whose picture of what) and the pusher's note above it. 'shown' once its
 * place has drawn, or 'failed' with why: an address that is not an upload of a type the stage shows, a document told
 * without its address, a reader this device cannot load, or the reader's own failure.
 */
async function drawFile(box, content, ctx) {
  const url = text(content.url);
  const ext = extOf(url);
  if (content.kind === 'doc' && content.withheld === true) return { state: 'failed', words: 'observers are shown pictures and quotes, not documents' };
  if (!UPLOAD.test(url) || !STAGE_TYPES.includes(ext) || (content.kind === 'image' && !IMAGES.includes(ext))) return { state: 'failed', words: 'the file is not one of this hall\'s' };
  const wrap = make('div', 'take-file');
  wrap.dataset.kind = content.kind;
  if (text(content.note)) wrap.append(make('p', 'take-file-note', content.note));
  const inner = make('div', 'take-file-box');
  wrap.append(inner, make('p', 'take-file-line', fileSaid(content, ctx)));
  box.append(wrap);
  noDrag(box);
  let dv;
  try { dv = await prepare(); } catch { return { state: 'failed', words: 'this page could not load the document reader — reload' }; }
  if (!box.contains(wrap)) return { state: 'failed', words: 'closed' };
  const seat = ctx && SEATS.includes(ctx.seat) ? ctx.seat : 'observer';
  const view = dv.open(inner, { url }, { at: placeAt(content.at), seat, name: text(content.name), ext, ranged: true });
  views.set(box, view);
  const r = await view.ready;
  if (views.get(box) !== view) return { state: 'failed', words: 'closed' };
  noDrag(box);
  return r && r.state === 'shown' ? { state: 'shown', words: '' } : { state: 'failed', words: failedSaid(content.kind, r && r.words) };
}

// ---------------------------------------------------------------- a quote
/** A quote's type: at least QUOTE_MIN px (QUOTE_PHONE under PHONE_WIDTH px wide), at most 12vw, found in QUOTE_STEPS steps. */
const QUOTE_MIN = 28;
const QUOTE_PHONE = 20;
const PHONE_WIDTH = 600;
const QUOTE_STEPS = 12;
/** Whether words read as a number (in brackets or not, a sign, a currency, digits with their separators, a percentage or a scale): set to the right. */
function numeric(words) {
  const t = words.trim().replace(/^\((.*)\)$/, '$1').replace(/^[-+−]/, '').replace(/^[£$€¥]\s?/, '').replace(/(?:%|[kKmMbB]n?)$/, '');
  return /^\d[\d,. ]*$/.test(t);
}
const withDir = (el) => { el.dir = 'auto'; return el; };
/** Where a quote was picked, in words: a cell's reference, a run of lines ("rows" in a CSV), or a place as placeSaid has it. */
function quotePlace(at, type) {
  if (!at || typeof at !== 'object') return '';
  if (text(at.ref)) return at.ref;
  if (Array.isArray(at.lines) && at.lines.length === 2) return (type === 'csv' ? 'rows ' : 'lines ') + at.lines[0] + '-' + at.lines[1];
  return placeSaid(at, type);
}
/**
 * A quote's source line, in its pusher's voice: "Quoted by Ana · Board pack.pdf, p. 12", "… · Minutes.docx (Legal), ≈ p.
 * 3", "Quoted by Ana from their copy of Board pack.pdf", "Quoted by Ana · vote.example.com", "Typed by Ana".
 */
function quoteSource(content, by) {
  const from = content.from && typeof content.from === 'object' ? content.from : null;
  const who = by || 'someone';
  if (!from) return 'Typed by ' + who;
  if (text(from.host)) return 'Quoted by ' + who + ' · ' + from.host;
  const room = text(from.roomName) ? ' (' + from.roomName + ')' : '';
  const place = quotePlace(from.at, text(from.type));
  const of = text(from.name) + room + (place ? ', ' + place : '');
  return from.local === true ? 'Quoted by ' + who + ' from their copy of ' + of : 'Quoted by ' + who + ' · ' + of;
}
const rowsOf = (t) => (t && Array.isArray(t.rows) ? t.rows.filter(Array.isArray) : []);
/** A quote's words in reading order, one line each: its title, its text, its items, its table's rows (cells joined by " · "). */
export function quoteWords(content) {
  const c = content && typeof content === 'object' ? content : {};
  const lines = [];
  const table = (t) => { for (const r of rowsOf(t)) { const l = r.map(text).filter(Boolean).join(' · '); if (l) lines.push(l); } };
  if (text(c.title)) lines.push(c.title);
  if (text(c.text)) lines.push(c.text);
  if (Array.isArray(c.items)) lines.push(...c.items.map(text).filter(Boolean));
  table(c.table);
  for (const b of Array.isArray(c.blocks) ? c.blocks : []) { if (b && b.table) table(b.table); else if (b && text(b.text)) lines.push(b.text); }
  return lines.join('\n');
}
/** A quote's table: its label row and column as headers kept in view, numbers to the right, its cell outlined and bold. */
function quoteTable(t, content) {
  const wrap = make('div', 'take-quote-scroll');
  const table = make('table', 'take-quote-table');
  const head = t.head === 1 ? 1 : 0;
  const side = t.side === 1 ? 1 : 0;
  const focus = Array.isArray(t.focus) ? t.focus : null;
  rowsOf(t).forEach((row, r) => {
    const tr = make('tr');
    row.forEach((cell, c) => {
      const words = text(cell);
      const label = r < head || c < side;
      const td = withDir(make(label ? 'th' : 'td', '', words));
      if (r < head) { td.classList.add('take-quote-head'); td.scope = 'col'; } else if (c < side) { td.classList.add('take-quote-side'); td.scope = 'row'; }
      if (!label && numeric(words)) td.classList.add('take-quote-num');
      if (focus && focus[0] === r && focus[1] === c) { td.classList.add('take-quote-focus'); td.setAttribute('aria-current', 'true'); }
      tr.append(td);
    });
    table.append(tr);
  });
  wrap.append(table);
  const more = content && content.cut === true && content.more && typeof content.more === 'object' ? content.more : null;
  const left = more ? [more.rows > 0 ? more.rows + (more.rows === 1 ? ' more row' : ' more rows') : '', more.cols > 0 ? more.cols + (more.cols === 1 ? ' more column' : ' more columns') : ''].filter(Boolean) : [];
  if (left.length) wrap.append(make('p', 'take-quote-more', '… ' + left.join(' and ') + ' not shown'));
  return wrap;
}
/** A list of a quote's items: numbered from its start where it was a numbered list. */
function quoteList(items, ordered, start) {
  const l = make(ordered ? 'ol' : 'ul', 'take-quote-list');
  if (ordered && Number.isInteger(start) && start > 1) l.start = start;
  for (const it of items) l.append(withDir(make('li', '', text(it))));
  return l;
}
/** A quote's paragraphs: its blank lines part them, its other line breaks are kept. */
function quoteText(words) {
  const q = make('blockquote', 'take-quote-text');
  for (const para of text(words).split(/\n{2,}/)) q.append(withDir(make('p', '', para)));
  return q;
}
/**
 * A quote as the stage draws it (not yet fitted): its note above it, its title, its body (a paragraph, a list, a table or
 * the blocks in view), and its source line in its pusher's voice (`ctx.by`). Every node built with the DOM and textContent.
 */
export function quote(content, ctx) {
  const c = content && typeof content === 'object' ? content : {};
  const q = make('div', 'take-quote');
  q.dataset.unit = text(c.unit);
  if (text(c.note)) q.append(withDir(make('p', 'take-quote-note', c.note)));
  const body = make('div', 'take-quote-body');
  if (text(c.title)) body.append(withDir(make('p', 'take-quote-title', c.title)));
  if (typeof c.text === 'string') body.append(quoteText(c.text));
  if (Array.isArray(c.items)) body.append(quoteList(c.items, c.ordered === true, c.start));
  if (c.table && typeof c.table === 'object') body.append(quoteTable(c.table, c));
  const blocks = Array.isArray(c.blocks) ? c.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    if (b.kind === 'table') { body.append(quoteTable(b.table || {}, null)); continue; }
    if (b.kind === 'li') {
      const run = [];
      for (; i < blocks.length && blocks[i] && blocks[i].kind === 'li'; i++) run.push(blocks[i].text);
      i--;
      body.append(quoteList(run, false, 1));
      continue;
    }
    if (b.kind === 'quote') { body.append(quoteText(b.text)); continue; }
    body.append(withDir(make('p', b.kind === 'h' ? 'take-quote-title' : 'take-quote-p', text(b.text))));
  }
  q.append(body, make('p', 'take-quote-line', quoteSource(c, (ctx && ctx.by) || '')));
  return q;
}
/**
 * A quote's type set to the largest that fits `box` (its height: a table's width scrolls inside its card): between
 * QUOTE_MIN px (QUOTE_PHONE px on a screen under PHONE_WIDTH px wide) and 12vw, in at most QUOTE_STEPS steps. {fits: false}
 * where even the smallest is longer than the box: it scrolls, and its tables are marked long (`data-long`), so each scrolls
 * inside its own card with its label row and column kept in view. `keep` leaves the quote at the type it has (the
 * stylesheet's, in a side bar's card) and only reads whether it fits. It is measured whole: a mark from before is let go first.
 */
export function fitQuote(box, el, { keep = false } = {}) {
  el.removeAttribute('data-long');
  const cs = window.getComputedStyle(box);
  const room = Math.max(1, box.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0));
  const done = (r) => { if (!r.fits) el.setAttribute('data-long', ''); return r; };
  if (keep) return done({ fits: el.scrollHeight <= room + 1, px: 0 });
  const w = window.innerWidth || box.clientWidth || 1024;
  const min = w < PHONE_WIDTH ? QUOTE_PHONE : QUOTE_MIN;
  const max = Math.max(min, Math.floor(w * 0.12));
  const fits = (px) => { el.style.fontSize = px + 'px'; return el.scrollHeight <= room + 1; };
  if (fits(max)) return done({ fits: true, px: max });
  if (!fits(min)) return done({ fits: false, px: min });
  let lo = min, hi = max;
  for (let step = 0; step < QUOTE_STEPS && hi - lo > 1; step++) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(lo);
  return done({ fits: true, px: lo });
}
/**
 * A quote drawn into `box` and fitted, fitted again as the box changes size: 'shown' on the next frame once laid out (a
 * frame is drawn only while the page is in view), with "longer than the screen: it scrolls" where it does not fit. In a
 * side bar's card (`ctx.card`) it keeps the card's type, and says it scrolls there.
 */
function drawQuote(box, content, ctx) {
  const el = quote(content, ctx);
  box.append(el);
  const card = !!(ctx && ctx.card === true);
  const fit = () => fitQuote(box, el, { keep: card });
  let r = fit();
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (box.contains(el)) r = fit(); }) : null;
  if (sized) sized.observe(box);
  views.set(box, { destroy: () => { if (sized) sized.disconnect(); } });
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve(r.fits ? { state: 'shown', words: '' } : { state: 'shown', words: card ? 'longer than its card in the side bar: it scrolls' : 'longer than the screen: it scrolls' }));
  });
}

/** What `box` holds let go: a document's or a picture's reader destroyed (its object URLs revoked), the box emptied. */
export function clear(box) {
  if (!box) return;
  const view = views.get(box);
  if (view) { views.delete(box); view.destroy(); }
  box.textContent = '';
}

/** The live parts under `root` drawn again: each clock and each Stagewatch time, a take's and a card's alike. */
export function tick(root, ctx) {
  if (!root) return;
  for (const n of root.querySelectorAll('[data-live="clock"]')) drawClock(n, ctx);
  for (const n of root.querySelectorAll('[data-live="stage"]')) drawStage(n, ctx);
}

/**
 * The take drawn into `box` (emptied first): what it drew, 'shown', or 'failed' with words. A holding picture that does
 * not load leaves black, never the picture before it.
 */
export function render(box, content, ctx) {
  clear(box);
  const kind = content && content.kind;
  box.dataset.kind = kind || '';
  switch (kind) {
    case 'stage': {
      const s = make('div', 'take-stage');
      s.dataset.live = 'stage';
      s.append(make('div', 'take-time', '--:--'), make('div', 'take-title'), make('div', 'take-next'));
      const message = make('p', 'take-message');
      message.hidden = true;
      s.append(message);
      box.append(s);
      drawStage(s, ctx);
      return Promise.resolve({ state: 'shown', words: '' });
    }
    case 'clock': {
      const c = make('div', 'take-clock');
      c.dataset.live = 'clock';
      const time = make('time', 'take-time');
      c.append(time, make('div', 'take-date'));
      box.append(c);
      drawClock(c, ctx);
      return Promise.resolve({ state: 'shown', words: '' });
    }
    case 'holding': {
      const image = typeof content.image === 'string' && content.image ? content.image : (ctx && typeof ctx.holding === 'string' ? ctx.holding : '');
      if (!image) {
        // No picture of its own and none of the hall's: the AGMessage mark, enlarged, and the hall's name, on black.
        const h = make('div', 'take-holding');
        const mark = make('span', 'brand-mark take-mark', 'AG');
        mark.setAttribute('aria-hidden', 'true');
        h.append(mark, make('div', 'take-hall', (ctx && ctx.hallName) || 'AGMessage'));
        box.append(h);
        return Promise.resolve({ state: 'shown', words: '' });
      }
      // Only a picture AGMessage keeps (/uploads/<name>), as the server allows: anything else draws black and says so.
      if (!/^\/uploads\/[\w.-]+$/.test(image)) return Promise.resolve({ state: 'failed', words: 'the image is not one of this hall\'s' });
      return new Promise((resolve) => {
        const img = make('img', 'take-image');
        img.alt = 'A holding slide';
        img.draggable = false;
        img.addEventListener('load', () => resolve({ state: 'shown', words: '' }), { once: true });
        img.addEventListener('error', () => { img.remove(); resolve({ state: 'failed', words: 'the image did not load' }); }, { once: true });
        img.src = image;
        box.append(img);
      });
    }
    case 'blank':
      return Promise.resolve({ state: 'shown', words: '' });
    case 'web':
      return drawWeb(box, content, ctx);
    case 'doc':
    case 'image':
      return drawFile(box, content, ctx);
    case 'snippet':
      return drawQuote(box, content, ctx);
    default:
      return Promise.resolve({ state: 'failed', words: 'this page cannot show that' });
  }
}

/** The first `n` characters of words, on one line, "…" after where they were cut: a quote's card ("❝ Revenue Q3 £4.2m"). */
function firstWords(words, n) {
  const all = Array.from(text(words).replace(/\s+/g, ' ').trim());
  return all.length > n ? all.slice(0, n).join('').trimEnd() + '…' : all.join('');
}
/** The take as a card in the side bar: its icon and name, and what is live in it (the countdown's time, the clock's). */
export function card(content, ctx) {
  const k = kindOf(content) || { icon: '📺', name: 'Shown to you' };
  const c = make('div', 'take-card-what');
  const icon = make('span', 'take-card-icon', k.icon);
  icon.setAttribute('aria-hidden', 'true');
  // A web page's card names its host ("🌍 vote.example.com"), never its address; a document its name and place ("📄 Board
  // pack.pdf · p. 12"); a picture whose it is and its place ("🖼 Ana's picture · p. 12"), or its name when shown whole.
  const kind = content && content.kind;
  const from = kind === 'image' && content.from && typeof content.from === 'object' ? content.from : null;
  const fromPlace = from && !IMAGES.includes(text(from.type)) ? placeSaid(from.at, text(from.type)) : '';
  const name = kind === 'web' && text(content.host) ? content.host
    : kind === 'snippet' ? firstWords(quoteWords(content), 40) || k.name
    : kind === 'doc' ? fileSaid(content, ctx)
    : kind === 'image' ? (from ? ((ctx && ctx.by) ? ctx.by + '\'s picture' : 'A picture') + (fromPlace ? ' · ' + fromPlace : '') : text(content.name) || k.name)
    : k.name;
  c.append(icon, make('strong', 'take-card-name', name));
  if (content && content.kind === 'stage') {
    const live = make('span', 'take-card-live');
    live.dataset.live = 'stage';
    live.append(make('span', 'take-time', '--:--'));
    c.append(live);
    drawStage(live, ctx);
  } else if (content && content.kind === 'clock') {
    const live = make('span', 'take-card-live');
    live.dataset.live = 'clock';
    live.append(make('time', 'take-time'));
    c.append(live);
    drawClock(live, ctx);
  }
  return c;
}
