'use strict';
/**
 * People's pages: what a person's hall page is shown over its chat, as a store and a vocabulary.
 *
 * A take is numbered, as a screen's is (lib/displays.js), and goes to the Board (every page seated On stage in a hall's
 * Main room) or to one person (`a:<account id>`, every device of the account; `u:<uid>`, that device's guest). Each hall
 * numbers its takes with one counter, so a page shows the highest-numbered take addressed to it in each layer: its
 * person's, or the Board's when it sits On stage in Main. Latest wins, and `chat` hands a page back to its chat.
 *
 * A page holds two layers (plan 4-§5.9.1): the show (Stagewatch, the clock, holding, blank: the operator's, canPush's
 * alone) and information over it (a web page, a document, a picture; quotes as they land), drawn over the show take and never
 * replacing it. `chat` hands back both; `{kind: 'chat', layer: 'info'}` the information alone, which is all `canShow` may
 * hand back, and only over a take `canShow` put up. An information take keeps whether its pusher held canPush (`by.op`),
 * so a researcher's push never covers or takes down what the operator put over the Board's chat, on the Board's take or
 * on one of its people's: it goes to their side bar instead (`arrive: 'side'`), kept beside the operator's (`beside`, a
 * place of its own, numbered as every take is and reported on as one: "in the side bar"), superseding nothing. The newest
 * information to a page puts away what is beside it, as it puts away the information over the show. An information take
 * superseded, handed back or put away with Back to chat joins Earlier (at most BOUNDS.earlier a hall, the oldest going
 * first), which a page draws in its side bar and opens as a Look: no report, no take. Who may push what is `canShow`
 * (pure, below).
 *
 * Attempts are not facts: a take is sent, and each page says what it did with it (a report). The status of a take is
 * read from those reports, page by page, never from the send: "sending" until every page that holds it said, "on every
 * page" only once each said it showed it (a hand-back to the chat never read as on screen), and a page put away (Back
 * to chat) or minimised said so in the person's name. A page reports only what a take of its kind can be. A person's
 * answer (Back to chat, Minimise) counts only for the take it answered: a newer take shows again.
 *
 * A document or a picture shows a file the hall holds, from a place the stage may show it from (sourceOk, pure); a
 * fresh upload one names is kept as the hall's stage file while a take or Earlier names it and for the wait after
 * (`files`); a take shown by mistake is withdrawn, from its pages and Earlier, and kept by its number (`withdrawn`); a
 * reset or a deleted file ends the takes it names (endTakes). A document may carry its stand-in (plan 4-§5.15.2), what a
 * page that cannot open documents draws in its place: a picture of the place (an image upload, kept as a stage file named
 * by the take, as the document is) or what its pusher sees there, as a quote's body. A take's status counts the pages
 * that joined without documents (`nodocs`), those of them that drew the stand-in (`standin`, "as a picture") and those
 * that could not show it (`cannot`).
 *
 * Stored in `pages.json` (one write lane, written only once this copy holds its data folder: `hold()`): the takes by
 * hall and layer, the persons' answers, each hall's Earlier list, stage files and withdrawn takes, and the guests' chat
 * views; each bounded, the oldest going first. A record of
 * the wrong shape is dropped when it is read. The reports are the run's alone: never saved, and a page that goes takes
 * its report with it.
 *
 *   askedOf(c)           : the kind and layer a pusher asked for, read before anything else of it, or null (pure)
 *   canShow(f, k, to, a) : whether a push of a kind to a target may be made: true, or why not in words (pure)
 *   cleanPage(c, facts)  : a take a pusher asked for, made safe, or {error} (pure, fail closed)
 *   sourceOk(url, facts) : where a file shown on the stage may come from: its name and room, or {error} (pure)
 *   mayDownload(who, t)  : whether a seat may download a file shared in its room, or a take's (pure)
 *   placeOf(at, ext)     : a document's place made safe for its file's type (pure)
 *   fileOf(c)            : the upload a take's content shows (a document's, a picture's, a holding slide's), or '' (pure)
 *   filesOf(c)           : every upload a take's content names: fileOf's, and a document's stand-in picture (pure)
 *   webUrl(v, selfHosts) : a web page's address made safe, {url, host}, or {error} (pure, fail closed)
 *   describePage(c, o)   : what a take shows, in a few words, in the console's voice or the audit's (pure)
 *   Pages.status(...)    : a take's status over the pages that hold it: a mark and its words, person first (pure)
 *
 * A web page (`web`) is a take of its own: an https address a person's page frames (public/pagelayer.mjs framePage).
 * The server never fetches it. At rest it is sealed (`urlSealed`, this machine's key: lib/secretbox.js) beside its host;
 * the address is opened only to be sent to the pages it is shown on (`told`), and everything else that names a web take,
 * the audit, the console's words and the halls board among them, names its host alone.
 */
const { WriteLane, readJsonWhole } = require('./resilience');
const guard = require('./guard');
const { clockOf } = require('./tunnelend');

/**
 * The kinds a take may be: back to the chat; Stagewatch's countdown; AGMessage's clock; a holding slide (the picture given,
 * the hall's holding picture, or the AGMessage mark and the hall's name on black); black; a web page (an https address,
 * framed by the page); a document (a file shared in AGMessage, the whole of it, opened at a place, which its target pages
 * through); a picture (an image shared in AGMessage, or one drawn of a page or a part of one); a quote (words or cells a
 * researcher picked, carried as data, never HTML: cleanSnippet). Anything else is refused, never defaulted.
 */
const KINDS = Object.freeze(['chat', 'stage', 'clock', 'holding', 'blank', 'web', 'doc', 'image', 'snippet']);
const KINDS_WORDS = 'Choose what to show: back to chat, Stagewatch, the clock, holding, blank, a web page, a document, a picture or a quote.';
/** The layers a page holds, each with its own take and its own answer: the show, and information drawn over it. */
const LAYERS = Object.freeze(['show', 'info']);
/**
 * Where a target's takes are kept, each place with its own take and its own answer, numbered by the hall's one counter: the
 * two layers, and `beside`, a researcher's information that arrived in the side bar beside the operator's (plan 4-§5.9.1),
 * drawn as a card there. A place shows the highest-numbered take addressed to the page; `beside` draws only a take put
 * there so (`aside`): any other take there is the information that put it away, or a hand-back, and draws nothing.
 */
const SLOTS = Object.freeze(['show', 'info', 'beside']);
/** The show layer's kinds: the operator's (canPush's alone). */
const SHOW_LAYER = Object.freeze(['stage', 'clock', 'holding', 'blank']);
/** The information layer's kinds, by name: a web page, a document, a picture and a quote. */
const INFO_LAYER = Object.freeze(['web', 'doc', 'image', 'snippet']);
/** The kinds that show a file the hall holds (a document, a picture): each names its upload, and the stage keeps it while it does. */
const FILE_KINDS = Object.freeze(['doc', 'image']);
/**
 * The upload a take's content shows, by its address ('' for none): a document's or a picture's file, and a holding slide's
 * own picture, which the stage keeps while a take names it as it keeps a document's.
 */
const fileOf = (c) => {
  if (!isRecord(c)) return '';
  const url = FILE_KINDS.includes(own(c, 'kind')) ? own(c, 'url') : own(c, 'kind') === 'holding' ? own(c, 'image') : undefined;
  return typeof url === 'string' && guard.validUploadUrl(url) ? url : '';
};
/**
 * Every upload a take's content names, by its address: fileOf's, and a document's stand-in picture, which the stage keeps
 * while the take names it as it keeps the document.
 */
const filesOf = (c) => {
  const main = fileOf(c);
  const st = isRecord(c) && own(c, 'kind') === 'doc' && isRecord(own(c, 'standin')) ? own(c.standin, 'url') : undefined;
  return [main, typeof st === 'string' && guard.validUploadUrl(st) ? st : ''].filter(Boolean);
};
/** A kind's layer: 'show' or 'info'; '' for `chat`, whose layers are its own (layersOf), and for anything else. */
const layerOf = (kind) => (SHOW_LAYER.includes(kind) ? 'show' : INFO_LAYER.includes(kind) ? 'info' : '');
/** The layers a take's content changes: `chat` both, or the information alone (`layer: 'info'`); any other its kind's. */
const layersOf = (c) => {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (kind === 'chat') return own(c, 'layer') === 'info' ? ['info'] : ['show', 'info'];
  const l = layerOf(kind);
  return l ? [l] : [];
};
/**
 * The places a take is kept in (SLOTS): a show kind the show's; `chat` all three (back to chat: nothing over the show and
 * nothing beside it); an information take put beside the operator's (`aside`) `beside` alone; any other information take
 * the information layer's, and `beside` with it (the newest information puts away what is beside it). A hand-back of the
 * information alone (`{chat, layer: 'info'}`) the place it names (`slot`: the take its Take down names is over the show,
 * or beside it), else both.
 */
const slotsOf = (c, { aside = false, slot = '' } = {}) => {
  const layers = layersOf(c);
  if (!layers.includes('info')) return layers;
  if (own(c, 'kind') === 'chat') return layers.length > 1 ? [...SLOTS] : slot === 'info' || slot === 'beside' ? [slot] : ['info', 'beside'];
  return aside ? ['beside'] : ['info', 'beside'];
};
/** How an information take arrives on a page: over its chat (the layer), or as an open card in its side bar. */
const ARRIVALS = Object.freeze(['over', 'side']);
/** A page is told the newest EARLIER_TOLD Earlier entries of its own (a hall keeps BOUNDS.earlier). */
const EARLIER_TOLD = 10;
/** A holding slide's picture: an image shared in AGMessage, of the types a screen shows (lib/displays.js). */
const IMAGE_EXT = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/**
 * The file types the stage can show: a file of one of them may be read and drawn on the Board's pages, and is checked at
 * upload (its archive, its pixels) before anyone opens it. Every type an upload may be (lib/guard.js UPLOAD_TYPES) is one.
 */
const STAGE_TYPES = Object.freeze(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'pptx']);
/**
 * The file types that are only ever transfers (lib/guard.js TRANSFER_TYPES, owner answer 18): downloaded through a
 * ticket, never opened, parsed, drawn or shown, and none in STAGE_TYPES, so a type added for transfer is never parsed on
 * the Board's devices unasked. A Word, Excel or PowerPoint file protected with a password is transfer-only too, decided
 * per file (its upload's `transferOnly`, its message's, and its first bytes: lib/uploadcheck.js transferOnlyFile).
 */
const TRANSFER_ONLY = Object.freeze(Object.keys(guard.TRANSFER_TYPES));
/**
 * Where a document opens, by its file's type: the keys of a place each type reads, its own key first (the one a place of
 * that type must name), each a whole number up to its bound. A Word document's place is a paragraph (`block`), with the
 * page it is on where the researcher's reader knew it (`page`) and whether that page is Word's own or a guess (`approx`,
 * only with a page); a CSV's is a row, kept as its `line`. A picture has no place: it is shown whole.
 */
const PLACES = Object.freeze({
  pdf: ['page'], pptx: ['slide'], xlsx: ['sheet'], xls: ['sheet'], docx: ['block', 'page', 'approx'], txt: ['line'], md: ['line'], csv: ['line'],
  png: [], jpg: [], jpeg: [], gif: [], webp: [],
});
const PLACE_KEYS = Object.freeze(['page', 'slide', 'sheet', 'block', 'line', 'approx']);
const PLACE_MAX = Object.freeze({ page: 9999, slide: 9999, sheet: 64, block: 999999, line: 999999 });
const AT_WORDS = 'That place cannot be read for this file: a page or a slide (1-9999), a sheet (1-64), a paragraph or a line (1-999999).';
/** A file's type in the audit's words ("a PDF at p. 12"), never its name. */
const TYPE_SAID = Object.freeze({
  pdf: 'a PDF', docx: 'a Word document', xlsx: 'a spreadsheet', xls: 'a spreadsheet', pptx: 'a slide deck', csv: 'a table', txt: 'a text file',
  md: 'a Markdown file', png: 'an image', jpg: 'an image', jpeg: 'an image', gif: 'an image', webp: 'an image',
});
/** The words a file the stage shows is refused in (plan 4-§5.9.3, §5.9.5). */
const FILE_WORDS = 'A document or a picture is a file shared in AGMessage.';
const IMAGE_WORDS = 'A picture is a PNG, JPEG, GIF or WebP shared in AGMessage.';
const NOT_STAGE = 'AGMessage does not show that kind of file on the stage: share it for download.';
const FOR_DOWNLOAD = 'That file is for download only: AGMessage does not open it.';
const NOT_HELD = 'That file is in no room of this hall you can read — share it there first.';
const OTHER_ROOM = 'That file belongs to another room — send it from there.';
const OBSERVERS = 'Observers are shown pictures and quotes, not documents.';
/** The stage's files a hall keeps at most, and the words a new one is refused in once that many are on its pages. */
const STAGE_FULL = 'This hall\'s stage holds 200 files — take some down.';
/** What a page reports of a take: drawn and in view, drawn out of view, a web page opened, not drawn, put away, minimised. */
const REPORTS = Object.freeze(['shown', 'hidden', 'opened', 'failed', 'dismissed', 'minimised']);
/**
 * What a page may report of a take of each kind: back on its chat, a page is in view or not, and has nothing to fail,
 * put away or minimise; a take drawn over the chat may also fail, be put away or be minimised. A web page is never
 * `shown`: its page cannot see inside the frame (a site that refuses to be framed still fires its `load`), so in view it
 * is `opened`, and `opened` is a web page's alone.
 */
const CHAT_REPORTS = Object.freeze(['shown', 'hidden']);
const DRAWN_REPORTS = Object.freeze(['shown', 'hidden', 'failed', 'dismissed', 'minimised']);
const WEB_REPORTS = Object.freeze(['opened', 'hidden', 'failed', 'dismissed', 'minimised']);
const reportsOf = (kind) => (kind === 'chat' ? CHAT_REPORTS : kind === 'web' ? WEB_REPORTS : DRAWN_REPORTS);
/** The report a page makes of a take of `kind` drawn and in view: `opened` for a web page, `shown` for every other. */
const inViewOf = (kind) => (kind === 'web' ? 'opened' : 'shown');
/**
 * A web page's address: at most WEB_MAX characters, https alone (http would be mixed content under HTTPS and the tunnel,
 * and javascript:, data:, blob: and file: are no page of the web), no user name or password, and a host that is not
 * AGMessage itself (this machine by any name or address, or the tunnel's host: a frame of AGMessage's own origin, with the
 * scripts a web page is allowed, would own the page around it).
 */
const WEB_MAX = 2048;
const WEB_WORDS = 'A web page is shown by its https address, as a browser shows it.';
const WEB_SELF = 'That address is AGMessage itself: show a page of another site.';
/**
 * Whether a host is one a web take keeps: a name or an IPv4 address in lower case (labels of letters, digits, `-` and
 * `_`, at most 253 characters, a trailing dot allowed), or an IPv6 address in brackets.
 */
const LABEL = /^[a-z0-9_-]{1,63}$/;
const isHost = (h) => typeof h === 'string' && h.length <= 253 && (/^\[[0-9a-f:.]{2,45}\]$/.test(h) || h.replace(/\.$/, '').split('.').every((l) => LABEL.test(l)));
/** What a sealed address looks like (lib/secretbox.js): read only by the machine that sealed it. */
const SEALED = /^enc1:[A-Za-z0-9+/]+=*$/;
/**
 * A person's answer to a take, kept with the take it answered: Back to chat and Minimise. Back to chat is final for that
 * take but for AGAIN_MS after it is chosen: then the same person's Show it again (a `shown` report with `again`) takes it
 * back, and so does a card's Undo (a `minimised` report), which puts the take back in the person's side bar.
 */
const ANSWERS = Object.freeze(['dismissed', 'minimised']);
const AGAIN_MS = 10_000;
/** A guest's chat view: '' (by their seat), Simple or Full, as an account's (lib/accounts.js VIEWS). */
const VIEWS = Object.freeze(['', 'simple', 'full']);
/**
 * The marks a take's status is drawn with, by their names in the pages' one table (public/common.js AGM.MARKS), each with
 * its one meaning there; test/modules.test.js holds each to that table, name and mark.
 */
const MARKS = Object.freeze({ ok: '✓', partly: '◐', unseen: '◇', minimised: '▭', off: '○', waiting: '◷', couldNot: '△', fault: '✕' });
const BOUNDS = Object.freeze({ views: 5000, personTakes: 200, answers: 500, earlier: 20, stageFiles: 200, withdrawn: 200 });

const HALL = /^[A-Z0-9]{4,12}$/;
const PERSON = /^[au]:[A-Za-z0-9_-]{1,64}$/;
const GUEST = /^[A-Za-z0-9_-]{1,64}$/;
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (n, min = 1) => Number.isInteger(n) && n >= min;

/** A person's key: `a:<account id>` for an account's pages, `u:<uid>` for a guest's device. '' for anything else. */
function personKey(uid, account = false) {
  const key = (account ? 'a:' : 'u:') + guard.str(uid);
  return PERSON.test(key) ? key : '';
}

/**
 * Whether a URL's host is this machine by a name every machine gives itself: localhost (and a name under it), an
 * address of 127.0.0.0/8 or 0.0.0.0/8, the IPv6 loopback or unspecified address, or an IPv4 one written as IPv6. The
 * URL parser has already written each in its one form (`127.1` and `2130706433` are `127.0.0.1`).
 */
function loopback(host) {
  // A name's trailing dot (`localhost.`, `app.localhost.`) names the same machine: the URL parser keeps it on a name.
  const h = host.replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^(?:127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (!h.startsWith('[')) return false;
  const v6 = h.slice(1, -1);
  return v6 === '::1' || v6 === '::' || /^::ffff:/.test(v6);
}

/**
 * A web page's address made safe (pure): {url, host}, the address as the URL parser writes it (its fragment kept) and
 * its host, or {error} in words. `v` is read as a string only (a client's object is none), and `selfHosts` are the other
 * names and addresses this AGMessage answers on (its machine's name, its network addresses, the tunnel's host), each
 * compared in lower case and without brackets.
 */
function webUrl(v, selfHosts = []) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw || raw.length > WEB_MAX) return { error: raw ? 'That address is longer than ' + WEB_MAX + ' characters.' : WEB_WORDS };
  let u;
  try { u = new URL(raw); } catch { return { error: WEB_WORDS }; }
  if (u.protocol !== 'https:' || !u.hostname || !isHost(u.hostname) || u.href.length > WEB_MAX) return { error: WEB_WORDS };
  if (u.username || u.password) return { error: 'An address with a user name or a password is not shown: show the page without them.' };
  const host = u.hostname;
  const bare = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const self = new Set((Array.isArray(selfHosts) ? selfHosts : []).filter((h) => typeof h === 'string' && h).map(bare));
  if (loopback(host) || self.has(bare(host))) return { error: WEB_SELF };
  return { url: u.href, host };
}

/**
 * What a pusher asked for, read before anything else of it (pure): {kind, layer} for a kind of KINDS (`layer`, a hand-back's:
 * 'info' for the information alone, '' for both), or null for anything else, which cleanPage refuses in its words. The
 * rights (canShow) are read from it before an address is.
 */
function askedOf(c) {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (kind !== 'chat') return { kind, layer: '' };
  const layer = own(c, 'layer');
  return layer === undefined ? { kind, layer: '' } : layer === 'info' ? { kind, layer } : null;
}

/**
 * A place a document opens at, made safe for its file's type `ext` (pure): {at} (a fresh object of the keys that type reads,
 * each a whole number in its range, `approx` kept only as true, with a Word document's page), {} for none asked, or {error}.
 * A key of another type's place, or one out of its range, refuses it; a type with a place of its own must name it.
 */
function placeOf(at, ext) {
  if (at === undefined) return {};
  if (!isRecord(at)) return { error: AT_WORDS };
  const keys = Object.hasOwn(PLACES, ext) ? PLACES[ext] : [];
  if (PLACE_KEYS.some((k) => Object.hasOwn(at, k) && !keys.includes(k))) return { error: AT_WORDS };
  const out = {};
  for (const k of keys) {
    if (!Object.hasOwn(at, k)) continue;
    const v = at[k];
    if (k === 'approx') { if (typeof v !== 'boolean') return { error: AT_WORDS }; continue; }
    if (!whole(v) || v > PLACE_MAX[k]) return { error: AT_WORDS };
    out[k] = v;
  }
  if (Object.hasOwn(at, 'approx') && !Object.hasOwn(out, 'page')) return { error: AT_WORDS };
  if (at.approx === true) out.approx = true;
  if (keys.length && !Object.hasOwn(out, keys[0])) return { error: AT_WORDS };
  return keys.length ? { at: out } : {};
}

/**
 * A place in words, for a file of type `ext` (pure): "p. 12", "≈ p. 3" (a Word page that is a guess), "slide 3", "sheet 2",
 * "line 40", "row 4" (a CSV's), "¶ 12" (a Word paragraph whose page was not known); '' for none.
 */
function placeWords(at, ext) {
  if (!isRecord(at)) return '';
  if (whole(at.page)) return (at.approx === true ? '≈ p. ' : 'p. ') + at.page;
  if (whole(at.slide)) return 'slide ' + at.slide;
  if (whole(at.sheet)) return 'sheet ' + at.sheet;
  if (whole(at.block)) return '¶ ' + at.block;
  if (whole(at.line)) return (ext === 'csv' ? 'row ' : 'line ') + at.line;
  return '';
}

/**
 * Where a file the stage would show may come from (pure; plan 4-§5.9.5): {name, room, roomName, fresh?} (`name`, the
 * file's name as AGMessage holds it, never the pusher's; `room`, the side room it belongs to, '' for the Main room;
 * `fresh`, its record when it is this pusher's own upload, not yet in any message), or {error} in words. One of:
 *   1. a fresh upload by this pusher no message holds yet, made for the hall's Main room, or for a side room on Main's
 *      list where the pusher may post with files;
 *   2. a file in a message of the Main room;
 *   3. a file in a message of a side room the pusher may read, on Main's list;
 *   4. a file the hall's stage records (a stage file, or one a take or Earlier names), when the room it was recorded for
 *      passes rule 2 or 3.
 * Never a transfer-only file: a transfer type by its extension, or one its upload or a message holding it says is
 * (`transferOnly`). A refusal names the room the file belongs to only to one who may read it.
 *
 * `facts`, the server's: `main` (the Main room's key), `uid` (the pusher's), `holders(url)` (the rooms of the hall whose
 * messages hold the file, each {key, at, name, transferOnly?}: the room, the oldest such message's time, its file's name
 * and whether it is transfer-only), `fresh(name)` (this run's record of an upload, {room, uid, name, transferOnly}, or null), `recorded(name)` (the hall's record of it,
 * {room, name}, or null), `reads(key)`, `listed(key)` (the Main room, or on its list), `files(key)` (the pusher may post
 * with files there), `roomName(key)`.
 */
function sourceOk(url, facts = {}) {
  const f = isRecord(facts) ? facts : {};
  const fn = (k) => (typeof f[k] === 'function' ? f[k] : () => null);
  if (!guard.validUploadUrl(url)) return { error: FILE_WORDS };
  const file = url.slice(9);
  const ext = guard.extOf(file);
  if (TRANSFER_ONLY.includes(ext)) return { error: FOR_DOWNLOAD };
  if (!STAGE_TYPES.includes(ext)) return { error: NOT_STAGE };
  const main = typeof f.main === 'string' ? f.main : '';
  const reads = (k) => fn('reads')(k) === true;
  const listed = (k) => k === main || fn('listed')(k) === true;
  // Rules 2 and 3: the Main room's, or a side room's the pusher reads that is on Main's list.
  const passes = (k) => !!k && (k === main || (reads(k) && listed(k)));
  const named = (k, name) => ({ name: guard.cleanText(name, 120) || file.replace(/^[0-9]+-[a-z0-9]+-/, ''), room: k === main ? '' : k, roomName: k === main ? '' : guard.cleanText(fn('roomName')(k), 60) });
  // Rule 1 is an upload no message holds yet: one posted is its room's (rules 2 and 3), never the stage's to keep.
  const holders = (Array.isArray(fn('holders')(url)) ? fn('holders')(url) : []).filter((h) => isRecord(h) && typeof h.key === 'string');
  const fresh = fn('fresh')(file);
  // A file whose upload or message says it is transfer-only (a Word, Excel or PowerPoint file protected with a password).
  if ((isRecord(fresh) && fresh.transferOnly === true) || holders.some((h) => h.transferOnly === true)) return { error: FOR_DOWNLOAD };
  const mine = isRecord(fresh) && typeof fresh.uid === 'string' && fresh.uid === f.uid && typeof fresh.room === 'string';
  if (mine && !holders.length && (fresh.room === main || (listed(fresh.room) && fn('files')(fresh.room) === true))) return { ...named(fresh.room, fresh.name), fresh: true };
  const held = holders.filter((h) => passes(h.key)).sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0))[0];
  if (held) return named(held.key, held.name);
  const rec = fn('recorded')(file);
  if (isRecord(rec) && passes(rec.room)) return named(rec.room, rec.name);
  // Refused: by the room it belongs to (a message's, the pusher's own upload's, the stage's record), named only to a reader.
  const owner = (holders[0] && holders[0].key) || (mine ? fresh.room : '') || (isRecord(rec) && typeof rec.room === 'string' ? rec.room : '');
  if (!owner) return { error: NOT_HELD };
  if (owner !== main && reads(owner)) return { error: 'That file belongs to ' + (guard.cleanText(fn('roomName')(owner), 60) || 'another room') + ', which may not send into the Main room — send it there first, or ask an admin.' };
  return { error: OTHER_ROOM };
}

/**
 * Whether a seat may download a file (pure; plan 4-§4.6.6, owner answers 12 and 20): the admin; a seat backstage
 * (`research`) whose account, if it has one, is not a Viewer; and, for a take shown with Download ticked (`take.download`
 * true), a target seated On stage too. Never an observer, and never a Viewer account, whatever its seat (a Viewer granted
 * hall.post sits backstage). `who`: `{admin, seat, viewer}`, the server's. Every download ticket reads it, and so do the
 * moves of a file to another room (`forward`, `room:send`) and the pages' `download` fact.
 */
function mayDownload(who, take = null) {
  const w = isRecord(who) ? who : {};
  if (w.admin === true) return true;
  if (w.viewer === true) return false;
  if (w.seat === 'research') return true;
  return w.seat === 'board' && isRecord(take) && take.download === true;
}

/**
 * A picture's source, as a page is told it and the store keeps it (pure): `from` as the pusher sent it, {url, at} of a
 * file (read through `source`, sourceOk's verdict on it) or {local: true, name, at} for the researcher's own copy, made
 * {name, type, at?, room?, roomName?} or {local: true, name, type, at?} (`type`, the source file's type, which its place
 * is read for): never the source's address. {from}, {} for none, or {error}.
 */
function fromOf(from, source) {
  if (from === undefined) return {};
  if (!isRecord(from)) return { error: FILE_WORDS };
  if (own(from, 'local') !== undefined) {
    if (own(from, 'local') !== true || typeof own(from, 'name') !== 'string') return { error: FILE_WORDS };
    const name = guard.cleanText(from.name, 120);
    const ext = guard.extOf(name);
    if (!name || !STAGE_TYPES.includes(ext)) return { error: NOT_STAGE };
    const p = placeOf(own(from, 'at'), ext);
    return p.error ? p : { from: { local: true, name, type: ext, ...(p.at ? { at: p.at } : {}) } };
  }
  const url = own(from, 'url');
  if (typeof url !== 'string') return { error: FILE_WORDS };
  const src = typeof source === 'function' ? source(url) : null;
  if (!isRecord(src) || src.error) return { error: isRecord(src) && src.error ? src.error : NOT_HELD };
  const type = guard.extOf(url);
  const p = placeOf(own(from, 'at'), type);
  if (p.error) return p;
  return { from: { name: src.name, type, ...(p.at ? { at: p.at } : {}), ...(src.room ? { room: src.room, roomName: src.roomName } : {}) } };
}

/**
 * A take a pusher asked for, made safe, or {error} (pure). `facts` are the server's: `stagewatch`, whether the hall
 * has a Stagewatch linked; `source(url)`, sourceOk's verdict on a file the take would show (a holding slide's picture, a
 * document, a picture and the file a picture was drawn of); `observer`, whether the target sits as an observer on a page
 * of theirs (a document hands over the whole file, which observers are never given); `web`, true when this pusher may
 * show a web page here (its own right, `stage.web`), else the words that say why not; `selfHosts`, the names this
 * AGMessage answers on (webUrl). Every result is a fresh object. An unknown kind, or a known key of the wrong type,
 * refuses the whole take with the kinds in words; a key it does not know is ignored. A `chat` names the information layer
 * alone (`layer: 'info'`) or no layer (both): any other layer is refused, never widened to both. Missing facts refuse what
 * needs them: a web page's right is read before its address, a file's source before anything is kept of it.
 *
 * A document is {kind: 'doc', url, name, at?, download, note?, room?, roomName?, standin?}: the file whole, opened at a
 * place of its type (placeOf), `download` true only when sent as true, `note` the pusher's line above it, `standin` what a
 * page that cannot open documents draws in its place (standinOf; a `standin` on any other kind is refused). A picture is {kind: 'image',
 * url, name, from?, note?, room?, roomName?}: an image shared in AGMessage, and what it is a picture of (fromOf). There
 * is no region: a part of a page or a picture is drawn into a picture of its own on the pusher's page. `name`, `room` (a
 * side room's key the file belongs to, kept on this laptop alone) and `roomName` are the server's, from the file's source.
 * A quote is cleanSnippet's.
 */
function cleanPage(c, facts = {}) {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return { error: KINDS_WORDS };
  if (kind !== 'doc' && own(c, 'standin') !== undefined) return { error: STANDIN_KIND };
  switch (kind) {
    case 'chat': {
      const asked = askedOf(c);
      if (!asked) return { error: KINDS_WORDS };
      return asked.layer ? { kind, layer: asked.layer } : { kind };
    }
    case 'stage':
      if (!(facts && facts.stagewatch === true)) return { error: 'This hall has no Stagewatch linked — link one in Set up.' };
      return { kind };
    case 'holding': {
      const image = own(c, 'image');
      if (image === undefined) return { kind };
      if (typeof image !== 'string') return { error: KINDS_WORDS };
      if (!guard.validUploadUrl(image) || !IMAGE_EXT.includes(guard.extOf(image))) return { error: 'A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage.' };
      const src = facts && typeof facts.source === 'function' ? facts.source(image) : null;
      if (!isRecord(src) || src.error) return { error: isRecord(src) && src.error ? src.error : NOT_HELD };
      return { kind, image };
    }
    case 'doc':
    case 'image': return cleanFile(kind, c, facts);
    case 'snippet': return cleanSnippet(c, facts);
    case 'web': {
      const may = facts ? facts.web : undefined;
      if (may !== true) return { error: typeof may === 'string' && may ? may : 'Web pages on the stage need their own right — ask an admin.' };
      const url = own(c, 'url');
      if (typeof url !== 'string') return { error: WEB_WORDS };
      const w = webUrl(url, facts.selfHosts);
      return w.error ? { error: w.error } : { kind, url: w.url, host: w.host };
    }
    default: return { kind };
  }
}

/**
 * A document or a picture a pusher asked for, made safe (cleanPage's `doc` and `image`): its address an upload of a type
 * the stage shows (a picture's an image's), its source passed (facts.source), a document never to an observer, its place
 * one of its type's, its note a line of at most 200 characters, and for a picture what it is a picture of.
 */
function cleanFile(kind, c, facts) {
  const f = isRecord(facts) ? facts : {};
  // A document's stand-in by its shape first, so a wrong one is refused whatever else the take holds.
  const st = kind === 'doc' ? standinOf(own(c, 'standin')) : {};
  if (st.error) return st;
  const url = own(c, 'url');
  if (typeof url !== 'string' || !guard.validUploadUrl(url)) return { error: kind === 'image' ? IMAGE_WORDS : FILE_WORDS };
  const ext = guard.extOf(url);
  if (kind === 'image' && !IMAGE_EXT.includes(ext)) return { error: IMAGE_WORDS };
  if (kind === 'doc' && f.observer === true) return { error: OBSERVERS };
  const note = own(c, 'note');
  if (note !== undefined && typeof note !== 'string') return { error: KINDS_WORDS };
  const src = typeof f.source === 'function' ? f.source(url) : null;
  if (!isRecord(src) || src.error) return { error: isRecord(src) && src.error ? src.error : NOT_HELD };
  const room = src.room ? { room: src.room, roomName: src.roomName } : {};
  const said = note !== undefined && guard.cleanText(note, 200) ? { note: guard.cleanText(note, 200) } : {};
  if (kind === 'doc') {
    const p = placeOf(own(c, 'at'), ext);
    if (p.error) return p;
    if (st.standin && !standinFits(st.standin, ext)) return { error: STANDIN_TYPE };
    // A stand-in picture comes from where a picture shown on the stage may come from (sourceOk), as an `image` take's does.
    if (st.standin && st.standin.url) {
      const from = typeof f.source === 'function' ? f.source(st.standin.url) : null;
      if (!isRecord(from) || from.error) return { error: isRecord(from) && from.error ? from.error : NOT_HELD };
    }
    return { kind, url, name: src.name, ...(p.at ? { at: p.at } : {}), download: own(c, 'download') === true, ...said, ...room, ...(st.standin ? { standin: st.standin } : {}) };
  }
  const from = fromOf(own(c, 'from'), f.source);
  if (from.error) return from;
  return { kind, url, name: src.name, ...(from.from ? { from: from.from } : {}), ...said, ...room };
}

/** A stand-in that is neither shape, or both; one of the other shape than its document's type; one on a take that is no document. */
const STANDIN_WORDS = 'A document\'s stand-in is a picture of its place or what you see there: one of the two.';
const STANDIN_TYPE = 'A PDF\'s or a picture\'s stand-in is a picture of its place; any other document\'s is what you see there.';
const STANDIN_KIND = 'Only a document has a stand-in.';
/**
 * Whether a stand-in's shape is its document's (pure; plan 4-§5.15.2): a picture of the place ({url}) for a PDF or an image,
 * what is seen there ({snippet}) for every other type.
 */
const standinFits = (st, ext) => (ext === 'pdf' || IMAGE_EXT.includes(ext)) === (isRecord(st) && st.url !== undefined);
/**
 * A document's stand-in as its pusher sent it, by its shape (pure; plan 4-§5.15.2), what a page that cannot open documents
 * draws in the document's place: none ({}); {url}, a picture of the place, an upload of an image's type (where it may come
 * from is read with the document, cleanFile); or {snippet}, what the pusher sees there, as a quote's body made safe by
 * cleanSnippet's rules, its source the document's own, so a source, a note or a kind of its own is not read. Never both,
 * never neither: {standin} or {error}, a fresh object.
 */
function standinOf(v) {
  if (v === undefined) return {};
  if (!isRecord(v)) return { error: STANDIN_WORDS };
  const url = own(v, 'url');
  const snippet = own(v, 'snippet');
  if ((url === undefined) === (snippet === undefined)) return { error: STANDIN_WORDS };
  if (url !== undefined) return typeof url === 'string' && guard.validUploadUrl(url) && IMAGE_EXT.includes(guard.extOf(url)) ? { standin: { url } } : { error: STANDIN_WORDS };
  if (!isRecord(snippet)) return { error: STANDIN_WORDS };
  const q = cleanSnippet(Object.fromEntries(Object.entries(snippet).filter(([k]) => k !== 'from' && k !== 'note' && k !== 'kind')), {});
  return q.error ? q : { standin: { snippet: q } };
}

// ---------------------------------------------------------------- a quote (plan 4-§5.9.4)
/**
 * The units a quote is picked by, each with the one body it carries: words as `text`; list items as `items`; a slide as its
 * `title` and `items`; cells as a `table`; what a reader shows (`view`) as its `blocks`.
 */
const UNITS = Object.freeze(['word', 'sentence', 'line', 'item', 'paragraph', 'cell', 'row', 'column', 'range', 'slide', 'selection', 'view', 'text']);
const UNIT_BODY = Object.freeze({
  word: 'text', sentence: 'text', line: 'text', paragraph: 'text', selection: 'text', text: 'text', item: 'items', slide: 'items',
  cell: 'table', row: 'table', column: 'table', range: 'table', view: 'blocks',
});
const BODIES = Object.freeze(['text', 'items', 'table', 'blocks']);
/** What a block of what a reader shows may be: a paragraph, a heading, a list's item, a quotation, or a table. */
const VIEW_BLOCKS = Object.freeze(['p', 'h', 'li', 'quote', 'table']);
/**
 * A quote's bounds: characters (code points, so no count splits a surrogate pair) and counts. Read at a glance, so never
 * cut: a quote over one is refused in words, and the cut is the researcher's own choice (`cut`).
 */
const SNIPPET = Object.freeze({ text: 1200, items: 20, item: 300, rows: 25, cols: 10, cell: 200, blocks: 12, whole: 4000, title: 120, ref: 64, heading: 120, start: 9999, more: 1048576 });
const UNIT_WORDS = 'Choose what to send: a word, sentence, line, item, paragraph, cell, row, column, range, slide, selection, what you see or text.';
/** A unit as a refusal names it ("A row"), and a body as a unit is sent ("as a table"). */
const UNIT_SAID = Object.freeze({
  word: 'A word', sentence: 'A sentence', line: 'A line', item: 'An item', paragraph: 'A paragraph', cell: 'A cell', row: 'A row', column: 'A column', range: 'A range',
  slide: 'A slide', selection: 'A selection', view: 'What you see', text: 'Text',
});
const BODY_SAID = Object.freeze({ text: 'as text', items: 'as a list', table: 'as a table', blocks: 'as the blocks in view' });
const SNIPPET_WORDS = 'That quote could not be read.';
const EMPTY_WORDS = 'There is nothing to show in that quote.';
const TOO_BIG = 'Too big for the stage: narrow it to 25 rows × 10 columns';
const NOT_CUT = 'Only text cut to its first 1,200 characters, or a table cut to 25 rows × 10 columns, is sent as cut.';
const FROM_WORDS = 'A quote comes from a file of this hall, your own copy of one or a web page, or it is typed.';
const IMAGE_QUOTE = 'A picture has no words to quote: show a picture of it instead.';
const SNIPPET_AT = 'That place cannot be read for this file: a page or a slide (1-9999), a sheet (1-64), a paragraph or a line (1-999999), a run of lines, a cell\'s reference or a heading.';
const TEXT_IS = 'Too long for the stage:';
const ITEM_IS = 'Too long for the stage: an item is';
const CELL_IS = 'Too long for the stage: a cell is';
/** A count as the words write it: 1860 → "1,860". */
function grouped(n) {
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i++) out += (i > 0 && (digits.length - i) % 3 === 0 ? ',' : '') + digits[i];
  return out;
}
/** A string's length in characters (code points). */
const chars = (s) => Array.from(s).length;
const tooLong = (max, n, what = 'characters') => 'Too long for the stage: ' + grouped(max) + ' ' + what + ' at most (this is ' + grouped(n) + ')';
/** Where a quote was picked, by its file's type: the keys a place of each type may hold (a picture has no words). */
const SNIPPET_PLACES = Object.freeze({
  pdf: ['page'], pptx: ['slide'], xlsx: ['sheet', 'ref'], xls: ['sheet', 'ref'], docx: ['block', 'page', 'approx', 'heading'],
  txt: ['line', 'lines'], md: ['line', 'lines', 'heading'], csv: ['line', 'lines', 'ref'],
});
const SNIPPET_PLACE_KEYS = Object.freeze(['page', 'slide', 'sheet', 'block', 'line', 'lines', 'ref', 'heading', 'approx']);

/**
 * Where in its file a quote was picked, made safe for the file's type `ext` (pure): {at} (a fresh object of the keys that
 * type reads: a page, a slide, a sheet, a paragraph or a line, each a whole number in its range; a run of lines `[a, b]`,
 * a ≤ b; a cell's reference and a heading, each words within its bound; `approx` kept only as true, with a Word document's
 * page), {} for none asked, or {error}. A key of another type's place, or one out of its range, refuses it.
 */
function snippetPlace(at, ext) {
  if (at === undefined) return {};
  if (!isRecord(at)) return { error: SNIPPET_AT };
  const keys = Object.hasOwn(SNIPPET_PLACES, ext) ? SNIPPET_PLACES[ext] : [];
  if (SNIPPET_PLACE_KEYS.some((k) => Object.hasOwn(at, k) && !keys.includes(k))) return { error: SNIPPET_AT };
  const out = {};
  for (const k of keys) {
    if (!Object.hasOwn(at, k)) continue;
    const v = at[k];
    if (k === 'approx') { if (typeof v !== 'boolean') return { error: SNIPPET_AT }; continue; }
    if (k === 'ref' || k === 'heading') {
      if (typeof v !== 'string') return { error: SNIPPET_AT };
      const t = guard.cleanText(v, v.length);
      if (chars(t) > SNIPPET[k]) return { error: SNIPPET_AT };
      if (t) out[k] = t;
      continue;
    }
    if (k === 'lines') {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => whole(n) && n <= PLACE_MAX.line) || v[0] > v[1]) return { error: SNIPPET_AT };
      out.lines = [v[0], v[1]];
      continue;
    }
    if (!whole(v) || v > PLACE_MAX[k]) return { error: SNIPPET_AT };
    out[k] = v;
  }
  if (Object.hasOwn(at, 'approx') && !Object.hasOwn(out, 'page')) return { error: SNIPPET_AT };
  if (at.approx === true) out.approx = true;
  return Object.keys(out).length ? { at: out } : {};
}

/**
 * Where a quote comes from, made safe (pure): `from` as the pusher sent it, one of {url, at} (a file of the hall, read
 * through `f.source`, sourceOk's verdict, and kept by its name and room, never its address), {local: true, name, at} (the
 * researcher's own copy, said as theirs) or {web} (a web page's address, webUrl's rules); {from}, {} for none (typed), or
 * {error}. A picture has no words to quote. A web page's address is kept ({web, host}: sealed at rest, and told the pages
 * the quote is shown on, whose Open the source opens it) only when this pusher may show a web page itself (`f.web` true:
 * stage.web, or a code guest by the hall's setting): the address is a web page offered on the Board's devices. Without
 * that right the quote keeps its host alone ({host}): the pages name the site, and no address is kept or told.
 */
function snippetFrom(from, f) {
  if (from === undefined) return {};
  if (!isRecord(from)) return { error: FROM_WORDS };
  const ways = ['url', 'local', 'web'].filter((k) => own(from, k) !== undefined);
  if (ways.length !== 1) return { error: FROM_WORDS };
  if (ways[0] === 'web') {
    if (typeof from.web !== 'string') return { error: FROM_WORDS };
    const w = webUrl(from.web, f.selfHosts);
    if (w.error) return { error: w.error };
    return { from: f.web === true ? { web: w.url, host: w.host } : { host: w.host } };
  }
  if (ways[0] === 'local') {
    if (own(from, 'local') !== true || typeof own(from, 'name') !== 'string') return { error: FROM_WORDS };
    const name = guard.cleanText(from.name, 120);
    const type = guard.extOf(name);
    if (!name || !STAGE_TYPES.includes(type)) return { error: NOT_STAGE };
    if (IMAGE_EXT.includes(type)) return { error: IMAGE_QUOTE };
    const p = snippetPlace(own(from, 'at'), type);
    return p.error ? p : { from: { local: true, name, type, ...(p.at ? { at: p.at } : {}) } };
  }
  const url = own(from, 'url');
  if (typeof url !== 'string' || !guard.validUploadUrl(url)) return { error: FILE_WORDS };
  const type = guard.extOf(url);
  if (IMAGE_EXT.includes(type)) return { error: IMAGE_QUOTE };
  const src = typeof f.source === 'function' ? f.source(url) : null;
  if (!isRecord(src) || src.error) return { error: isRecord(src) && src.error ? src.error : NOT_HELD };
  const p = snippetPlace(own(from, 'at'), type);
  if (p.error) return p;
  return { from: { name: src.name, type, ...(p.at ? { at: p.at } : {}), ...(src.room ? { room: src.room, roomName: src.roomName } : {}) } };
}

/** A string of a quote's body cleaned as a block (guard.cleanBlock) within `max` characters: {t}, or {error} in words. */
function blockOf(v, max, what) {
  if (typeof v !== 'string') return { error: SNIPPET_WORDS };
  const t = guard.cleanBlock(v);
  const n = chars(t);
  return n > max ? { error: what + ' ' + grouped(max) + ' characters at most (this is ' + grouped(n) + ')' } : { t };
}

/**
 * A quote's table, made safe (pure): {rows, head, side, ref?, focus?} with its rows at most SNIPPET.rows of at most
 * SNIPPET.cols cells (each a block of at most SNIPPET.cell characters), a short row padded with '', `head` and `side` 0 or 1
 * (whether its first row or column holds labels), `ref` words of where it is (cleanText(64)) and `focus` the cell [r, c]
 * the quote is of, inside the table. {table, empty} (`empty`: no cell holds words), or {error}. A list's length is read
 * before it is walked.
 */
function snippetTable(t) {
  if (!isRecord(t) || !Array.isArray(own(t, 'rows'))) return { error: SNIPPET_WORDS };
  const rows = t.rows;
  if (rows.length > SNIPPET.rows) return { error: TOO_BIG };
  if (!rows.length || !rows.every(Array.isArray)) return { error: rows.length ? SNIPPET_WORDS : EMPTY_WORDS };
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (width > SNIPPET.cols) return { error: TOO_BIG };
  if (!width) return { error: EMPTY_WORDS };
  const out = [];
  for (const r of rows) {
    const cells = [];
    for (const c of r) {
      const b = blockOf(c, SNIPPET.cell, CELL_IS);
      if (b.error) return b;
      cells.push(b.t);
    }
    while (cells.length < width) cells.push('');
    out.push(cells);
  }
  const head = own(t, 'head');
  const side = own(t, 'side');
  if (!(head === 0 || head === 1) || !(side === 0 || side === 1)) return { error: SNIPPET_WORDS };
  const ref = own(t, 'ref');
  if (ref !== undefined && typeof ref !== 'string') return { error: SNIPPET_WORDS };
  const said = ref === undefined ? '' : guard.cleanText(ref, SNIPPET.ref);
  const focus = own(t, 'focus');
  if (focus !== undefined && !(Array.isArray(focus) && focus.length === 2 && focus.every((n) => Number.isInteger(n) && n >= 0) && focus[0] < out.length && focus[1] < width)) return { error: SNIPPET_WORDS };
  return { table: { rows: out, head, side, ...(said ? { ref: said } : {}), ...(focus ? { focus: [focus[0], focus[1]] } : {}) }, empty: out.every((r) => r.every((c) => !c)) };
}

/** Every string of a quote that the stage draws: its title, note and body, a table's reference among them. */
function snippetStrings(q) {
  const out = [];
  if (q.title) out.push(q.title);
  if (q.note) out.push(q.note);
  if (typeof q.text === 'string') out.push(q.text);
  if (Array.isArray(q.items)) out.push(...q.items);
  const cells = (t) => { if (t.ref) out.push(t.ref); for (const r of t.rows) out.push(...r); };
  if (q.table) cells(q.table);
  for (const b of q.blocks || []) { if (b.table) cells(b.table); else out.push(b.text); }
  return out;
}

/**
 * A quote a pusher asked for, made safe, or {error} (pure; plan 4-§5.9.4): {kind: 'snippet', unit, title?, text | items
 * (ordered?, start?) | table | blocks, from?, note?, cut?, more?}, a fresh object. `unit` is one of UNITS and carries its
 * one body (UNIT_BODY) and no other; every string is read as a string (a field of the wrong type refuses the whole take)
 * and cleaned as a block (guard.cleanBlock); nothing is defaulted. Over a bound it is refused in words, never cut: the cut
 * is the researcher's own (`cut`, true only as sent, on text or on a table cut to its full 25 rows or 10 columns; `more`,
 * with a cut table alone, the rows and columns left out). `from` is snippetFrom's. The quote is its pusher's claim: the
 * server never parses a document, so it cannot check that the words are in the file.
 */
function cleanSnippet(c, facts = {}) {
  const f = isRecord(facts) ? facts : {};
  if (!isRecord(c)) return { error: SNIPPET_WORDS };
  const unit = own(c, 'unit');
  if (typeof unit !== 'string' || !UNITS.includes(unit)) return { error: UNIT_WORDS };
  const body = UNIT_BODY[unit];
  const given = BODIES.filter((b) => own(c, b) !== undefined);
  if (given.length !== 1 || given[0] !== body) return { error: UNIT_SAID[unit] + ' is sent ' + (unit === 'slide' ? 'as a title and a list' : BODY_SAID[body]) + '.' };
  const out = { kind: 'snippet', unit };
  const title = own(c, 'title');
  if (title !== undefined && typeof title !== 'string') return { error: SNIPPET_WORDS };
  if (title !== undefined && guard.cleanText(title, SNIPPET.title)) out.title = guard.cleanText(title, SNIPPET.title);
  let full = false;
  if (body === 'text') {
    const b = blockOf(c.text, SNIPPET.text, TEXT_IS);
    if (b.error) return b;
    if (!b.t) return { error: EMPTY_WORDS };
    out.text = b.t;
  } else if (body === 'items') {
    const items = c.items;
    if (!Array.isArray(items)) return { error: SNIPPET_WORDS };
    if (items.length > SNIPPET.items) return { error: tooLong(SNIPPET.items, items.length, 'items') };
    const list = [];
    for (const v of items) {
      const b = blockOf(v, SNIPPET.item, ITEM_IS);
      if (b.error) return b;
      if (b.t) list.push(b.t);
    }
    if (!list.length && !out.title) return { error: EMPTY_WORDS };
    out.items = list;
    const ordered = own(c, 'ordered');
    const start = own(c, 'start');
    if ((ordered !== undefined && typeof ordered !== 'boolean') || (start !== undefined && !(whole(start) && start <= SNIPPET.start))) return { error: SNIPPET_WORDS };
    if (ordered === true) out.ordered = true;
    if (start !== undefined) out.start = start;
  } else if (body === 'table') {
    const t = snippetTable(c.table);
    if (t.error) return { error: t.error };
    if (t.empty) return { error: EMPTY_WORDS };
    out.table = t.table;
    full = t.table.rows.length === SNIPPET.rows || t.table.rows[0].length === SNIPPET.cols;
  } else {
    const blocks = c.blocks;
    if (!Array.isArray(blocks)) return { error: SNIPPET_WORDS };
    if (blocks.length > SNIPPET.blocks) return { error: tooLong(SNIPPET.blocks, blocks.length, 'blocks') };
    const list = [];
    for (const b of blocks) {
      if (!isRecord(b) || !VIEW_BLOCKS.includes(own(b, 'kind'))) return { error: SNIPPET_WORDS };
      if (b.kind === 'table') {
        const t = snippetTable(own(b, 'table'));
        if (t.error) return { error: t.error };
        if (!t.empty) list.push({ kind: 'table', table: t.table });
        continue;
      }
      const x = blockOf(own(b, 'text'), SNIPPET.text, TEXT_IS);
      if (x.error) return x;
      if (x.t) list.push({ kind: b.kind, text: x.t });
    }
    if (!list.length) return { error: EMPTY_WORDS };
    out.blocks = list;
  }
  const from = snippetFrom(own(c, 'from'), f);
  if (from.error) return from;
  if (from.from) out.from = from.from;
  const note = own(c, 'note');
  if (note !== undefined && typeof note !== 'string') return { error: SNIPPET_WORDS };
  if (note !== undefined && guard.cleanText(note, 200)) out.note = guard.cleanText(note, 200);
  const cut = own(c, 'cut');
  const more = own(c, 'more');
  if (cut !== undefined && typeof cut !== 'boolean') return { error: SNIPPET_WORDS };
  if (cut === true && !(body === 'text' || (body === 'table' && full))) return { error: NOT_CUT };
  if (more !== undefined) {
    const n = (v) => Number.isInteger(v) && v >= 0 && v <= SNIPPET.more;
    if (cut !== true || body !== 'table' || !isRecord(more) || !n(own(more, 'rows')) || !n(own(more, 'cols'))) return { error: NOT_CUT };
    out.more = { rows: more.rows, cols: more.cols };
  }
  if (cut === true) out.cut = true;
  const all = snippetStrings(out).reduce((n, s) => n + chars(s), 0);
  if (all > SNIPPET.whole) return { error: tooLong(SNIPPET.whole, all) };
  return out;
}

/**
 * A quote's source read back as the store keeps it: a file's ({name, type, at?, room?, roomName?}), the pusher's own
 * copy's ({local: true, name, type, at?}) or a web page's ({host, urlSealed?}, its address sealed); null for any other.
 */
function storedSnippetFrom(from) {
  if (!isRecord(from)) return null;
  if (own(from, 'host') !== undefined) {
    const sealed = own(from, 'urlSealed');
    if (!isHost(from.host) || (sealed !== undefined && !(typeof sealed === 'string' && sealed.length <= 4 * WEB_MAX && SEALED.test(sealed)))) return null;
    return { host: from.host, ...(sealed !== undefined ? { urlSealed: sealed } : {}) };
  }
  const local = own(from, 'local');
  if (typeof own(from, 'name') !== 'string' || from.name.length > 120 || !STAGE_TYPES.includes(own(from, 'type')) || IMAGE_EXT.includes(from.type) || (local !== undefined && local !== true)) return null;
  const p = snippetPlace(own(from, 'at'), from.type);
  const room = local ? {} : storedRoom(from);
  if (p.error || !room || (local && own(from, 'room') !== undefined)) return null;
  return { ...(local ? { local: true } : {}), name: from.name, type: from.type, ...(p.at ? { at: p.at } : {}), ...room };
}
/** A quote read back in its clean shape (its body as cleanSnippet reads it, its source as the store keeps it), or null. */
function storedSnippet(c) {
  const rest = {};
  for (const [k, v] of Object.entries(c)) if (k !== 'from') rest[k] = v;
  const body = cleanSnippet(rest, {});
  if (body.error) return null;
  if (own(c, 'from') === undefined) return body;
  const from = storedSnippetFrom(c.from);
  return from ? { ...body, from } : null;
}

/** A stored place for a file of type `ext`, read back: {at} or {} (none), or null for one that is not its type's. */
const storedPlace = (at, ext) => { const p = placeOf(at, ext); return p.error ? null : p; };
/** A stored side room of a file ({room, roomName}), read back: {} for the Main room's, or null for one of the wrong shape. */
function storedRoom(c) {
  const room = own(c, 'room');
  if (room === undefined) return own(c, 'roomName') === undefined ? {} : null;
  return HALL.test(guard.str(room)) && typeof own(c, 'roomName') === 'string' && c.roomName.length <= 60 ? { room, roomName: c.roomName } : null;
}
/** A stored document or picture, read back in its clean shape, or null. */
function storedFile(c) {
  const kind = own(c, 'kind');
  const url = own(c, 'url');
  const name = own(c, 'name');
  if (!guard.validUploadUrl(url) || typeof name !== 'string' || name.length > 120) return null;
  const ext = guard.extOf(url);
  if (!STAGE_TYPES.includes(ext) || (kind === 'image' && !IMAGE_EXT.includes(ext))) return null;
  const note = own(c, 'note');
  if (note !== undefined && !(typeof note === 'string' && note.length <= 200)) return null;
  const room = storedRoom(c);
  if (!room) return null;
  const said = note !== undefined ? { note } : {};
  if (kind === 'doc') {
    const p = storedPlace(own(c, 'at'), ext);
    const st = own(c, 'standin') === undefined ? {} : standinOf(c.standin);
    if (!p || typeof own(c, 'download') !== 'boolean' || st.error || (st.standin && !standinFits(st.standin, ext))) return null;
    return { kind, url, name, ...(p.at ? { at: p.at } : {}), download: c.download, ...said, ...room, ...(st.standin ? { standin: st.standin } : {}) };
  }
  const from = own(c, 'from');
  if (from === undefined) return { kind, url, name, ...said, ...room };
  if (!isRecord(from) || typeof from.name !== 'string' || from.name.length > 120 || !STAGE_TYPES.includes(own(from, 'type'))) return null;
  const local = own(from, 'local');
  if (local !== undefined && local !== true) return null;
  const p = storedPlace(own(from, 'at'), from.type);
  const fromRoom = local ? {} : storedRoom(from);
  if (!p || !fromRoom || (local && own(from, 'room') !== undefined)) return null;
  return { kind, url, name, from: { ...(local ? { local: true } : {}), name: from.name, type: from.type, ...(p.at ? { at: p.at } : {}), ...fromRoom }, ...said, ...room };
}

/**
 * A take as it is stored, read back: a fresh object of a kind of KINDS in its clean shape, or null. A web page is kept
 * as its host and its sealed address ({kind, host, urlSealed}), never its address in clear; a document and a picture as
 * cleanPage made them (storedFile).
 */
function storedPage(c) {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (kind === 'chat') { const asked = askedOf(c); return asked ? (asked.layer ? { kind, layer: asked.layer } : { kind }) : null; }
  if (kind === 'web') {
    const host = own(c, 'host');
    const urlSealed = own(c, 'urlSealed');
    return isHost(host) && typeof urlSealed === 'string' && urlSealed.length <= 4 * WEB_MAX && SEALED.test(urlSealed) ? { kind, host, urlSealed } : null;
  }
  if (FILE_KINDS.includes(kind)) return storedFile(c);
  if (kind === 'snippet') return storedSnippet(c);
  if (kind !== 'holding') return { kind };
  const image = own(c, 'image');
  if (image === undefined) return { kind };
  return guard.validUploadUrl(image) && IMAGE_EXT.includes(guard.extOf(image)) ? { kind, image } : null;
}

/**
 * What a take hands back says: a `chat` of both layers is "back to chat"; of the information alone, "the information
 * taken down" (plan 4-§5.9.3, in the console's voice and the audit's alike).
 */
const handBack = (c) => (own(c, 'layer') === 'info' ? 'the information taken down' : 'back to chat');

/**
 * A document in a few words: in the console's voice by its name ("Board pack.pdf at p. 12"), in the audit's by its type
 * ("a PDF at p. 12"); a side room's file adds its room ("… in Legal").
 */
function docSaid(c, voice) {
  const ext = guard.extOf(typeof own(c, 'url') === 'string' ? c.url : guard.str(own(c, 'name')));
  const place = placeWords(own(c, 'at'), ext);
  const what = voice === 'audit' ? (Object.hasOwn(TYPE_SAID, ext) ? TYPE_SAID[ext] : 'a document') : guard.str(own(c, 'name')) || 'a document';
  return what + (typeof own(c, 'roomName') === 'string' && c.roomName ? ' in ' + c.roomName : '') + (place ? ' at ' + place : '');
}
/**
 * A picture in a few words: in the console's voice by whose picture it is and of what ("Ana's picture of Board pack.pdf,
 * p. 12", "… of part of Stage plan.png", "… of their copy of Board pack.pdf, p. 12"), or, shown whole, by its name; in the
 * audit's by kinds alone ("a picture of a PDF page (p. 12)", "a picture of part of an image", "…, from a local copy").
 */
function imageSaid(c, voice, by) {
  const from = isRecord(own(c, 'from')) ? c.from : null;
  const audit = voice === 'audit';
  const inRoom = (o) => (typeof own(o, 'roomName') === 'string' && o.roomName ? ' in ' + o.roomName : '');
  if (!from) return (audit ? 'a picture' : guard.str(own(c, 'name')) || 'a picture') + inRoom(c);
  const type = guard.str(own(from, 'type'));
  const place = placeWords(own(from, 'at'), type);
  const local = own(from, 'local') === true;
  const part = IMAGE_EXT.includes(type);
  if (audit) {
    const of = part ? 'part of an image' : (Object.hasOwn(TYPE_SAID, type) ? TYPE_SAID[type] : 'a file') + (type === 'pdf' ? ' page' : '');
    return 'a picture of ' + of + (place && !part ? ' (' + place + ')' : '') + inRoom(from) + (local ? ', from a local copy' : '');
  }
  const who = (by ? by + '\'s picture' : 'a picture') + ' of ' + (part ? 'part of ' : '') + (local ? 'their copy of ' : '');
  return who + guard.str(own(from, 'name')) + inRoom(from) + (place && !part ? ', ' + place : '');
}

/**
 * A quote's words in reading order, as one text (pure): its title, then its body (a list's items and a table's rows one a
 * line, a row's cells joined by " · ", the blocks in view one a line), at most SNIPPET.whole characters as the quote is.
 */
function snippetText(c) {
  if (!isRecord(c) || c.kind !== 'snippet') return '';
  const rows = (t) => (isRecord(t) && Array.isArray(t.rows) ? t.rows.map((r) => r.filter(Boolean).join(' · ')).filter(Boolean) : []);
  const lines = [];
  if (typeof c.title === 'string' && c.title) lines.push(c.title);
  if (typeof c.text === 'string') lines.push(c.text);
  if (Array.isArray(c.items)) lines.push(...c.items);
  lines.push(...rows(c.table));
  for (const b of Array.isArray(c.blocks) ? c.blocks : []) lines.push(...(b.kind === 'table' ? rows(b.table) : [b.text]));
  return lines.join('\n');
}
/** A quote's unit in words: "a table cell", "a paragraph", "3 list items", "what they see". */
const UNIT_NOUN = Object.freeze({
  word: 'a word', sentence: 'a sentence', line: 'a line', item: 'a list item', paragraph: 'a paragraph', cell: 'a table cell', row: 'a table row',
  column: 'a table column', range: 'a table range', slide: 'a slide', selection: 'a selection', view: 'what they see', text: 'a quote',
});
const unitNoun = (c) => (c.unit === 'item' && Array.isArray(c.items) && c.items.length > 1 ? c.items.length + ' list items' : Object.hasOwn(UNIT_NOUN, c.unit) ? UNIT_NOUN[c.unit] : 'a quote');
/**
 * A quote's size in the audit's words: a table's cells but a single cell's ("6 cells"), else its characters ("18
 * characters"), a table cell's its value's (the cell in `focus`).
 */
function snippetSize(c) {
  const t = isRecord(c.table) ? c.table : null;
  if (t && c.unit !== 'cell') {
    const n = Math.max(0, t.rows.length - (t.head || 0)) * Math.max(0, (t.rows[0] || []).length - (t.side || 0));
    return n + (n === 1 ? ' cell' : ' cells');
  }
  const words = t && Array.isArray(t.focus) ? [t.rows[t.focus[0]][t.focus[1]]] : snippetStrings({ ...c, title: '', note: '' });
  const n = words.reduce((k, x) => k + chars(String(x)), 0);
  return grouped(n) + (n === 1 ? ' character' : ' characters');
}
/** Where in its file a quote was picked, in words: a cell's reference ("'Sheet1'!C4"), "lines 4-9" ("rows" in a CSV), or placeWords'. */
function snippetPlaceWords(at, type) {
  if (!isRecord(at)) return '';
  if (typeof at.ref === 'string' && at.ref) return at.ref;
  if (Array.isArray(at.lines)) return (type === 'csv' ? 'rows ' : 'lines ') + at.lines[0] + '-' + at.lines[1];
  return placeWords(at, type);
}
/**
 * A quote in a few words: in the console's voice by its unit, file and place ("❝ a table cell from Q3.xlsx, 'Sheet1'!C4",
 * "❝ a paragraph from their copy of Minutes.docx, ≈ p. 3", "❝ a quote from vote.example.com", "❝ a quote typed by Ana (42
 * characters)"); in the audit's by its unit, size and file's type alone ("a quote (a table cell, 18 characters) from a
 * spreadsheet", "a quote (typed, 42 characters)", "a quote from a web page on vote.example.com"). A side room's file adds
 * its room ("… in Legal").
 */
function snippetSaid(c, voice, by) {
  if (!UNITS.includes(own(c, 'unit'))) return 'a quote';
  const from = isRecord(own(c, 'from')) ? c.from : null;
  const audit = voice === 'audit';
  const noun = unitNoun(c);
  if (!from) {
    const n = snippetStrings({ ...c, note: '' }).reduce((k, x) => k + chars(x), 0);
    const size = grouped(n) + (n === 1 ? ' character' : ' characters');
    return audit ? 'a quote (typed, ' + size + ')' : '❝ a quote typed' + (by ? ' by ' + by : '') + ' (' + size + ')';
  }
  if (typeof own(from, 'host') === 'string') return audit ? 'a quote from a web page on ' + from.host : '❝ ' + noun + ' from ' + from.host;
  const type = guard.str(own(from, 'type'));
  const inRoom = typeof own(from, 'roomName') === 'string' && from.roomName ? ' in ' + from.roomName : '';
  const local = own(from, 'local') === true;
  if (audit) return 'a quote (' + noun + ', ' + snippetSize(c) + ') from ' + (Object.hasOwn(TYPE_SAID, type) ? TYPE_SAID[type] : 'a file') + inRoom + (local ? ', from a local copy' : '');
  const place = snippetPlaceWords(own(from, 'at'), type);
  return '❝ ' + noun + ' from ' + (local ? 'their copy of ' : '') + guard.str(own(from, 'name')) + inRoom + (place ? ', ' + place : '');
}

/**
 * What a take shows, in a few words (pure), in one of two voices (`voice`): the console's ('console', what a pusher reads:
 * a document or a picture by its file's name and place) and the audit's ('audit', which never names a file, quotes a text
 * or carries a path: a file by its type). A web page is named by its host in both. A holding slide with no picture of its
 * own shows the hall's (`hallHolding`) when the hall has one, else the AGMessage mark. `by` names who put a picture up
 * ("Ana's picture of …"), and a take sent from a side room says so (`sent`, its name: "…, sent from Legal"). No take is
 * the chat; anything else, ''.
 */
function describePage(c, { hallHolding = '', voice = 'console', by = '', sent = '' } = {}) {
  if (!c) return 'the chat';
  let words;
  switch (isRecord(c) ? own(c, 'kind') : undefined) {
    case 'chat': words = handBack(c); break;
    case 'stage': words = 'Stagewatch'; break;
    case 'clock': words = 'the clock'; break;
    case 'holding': words = own(c, 'image') || hallHolding ? 'a holding slide' : 'a holding slide with the AGMessage mark'; break;
    case 'blank': words = 'blank'; break;
    case 'web': words = typeof own(c, 'host') === 'string' && own(c, 'host') ? 'a web page on ' + own(c, 'host') : 'a web page'; break;
    case 'doc': words = docSaid(c, voice); break;
    case 'image': words = imageSaid(c, voice, guard.cleanText(by, 60)); break;
    case 'snippet': words = snippetSaid(c, voice, guard.cleanText(by, 60)); break;
    default: return '';
  }
  return sent ? words + ', sent from ' + guard.cleanText(sent, 60) : words;
}

// ---------------------------------------------------------------- who may show what (plan 4-§5.9.2.2)
const NO_WEB = 'Web pages on the stage need their own right — ask an admin.';
const NO_SHOW = 'Showing files, pages and quotes on the stage needs its own right — ask an admin.';
const BACKSTAGE_TEAM = 'Showing the Board is for the backstage team.';
const ONLY_ON_STAGE = 'Only the people on stage can be shown this.';
const NO_FILES = 'Your account may not share files here, so it shows quotes only.';
const OFF_LIST = 'This room may not send to the Main room\'s Board — ask an admin.';
const TAKE_DOWN_NAMES = 'Take down names the take it takes down.';
/** An information kind in the words the console says it with ("a web page"), for the refusals that name one. */
const INFO_SAID = Object.freeze({ web: 'a web page', doc: 'a document', image: 'a picture', snippet: 'a quote' });
const infoSaid = (kind) => (Object.hasOwn(INFO_SAID, kind) ? INFO_SAID[kind] : 'something');
/** What a researcher is told over the operator's information (an `over` push, or a take-down). */
const operatorWords = (kind) => 'The operator is showing ' + infoSaid(kind) + ' — ask them, or send it to their side bar.';
/** What a take-down is told once what it named is no longer up there. */
const replacedWords = (cur) => (cur && cur.kind !== 'chat'
  ? (cur.name || 'Someone') + '\'s ' + infoSaid(cur.kind).replace(/^an? /, '') + ' is up now — yours was already replaced.'
  : 'Nothing is shown over the show there now — yours was already taken down.');

/**
 * Whether a push may be made (pure, over facts the server gathers): true, or the refusal in words. `kind` is the kind
 * asked for, a string or {kind, layer} (a `chat` with `layer: 'info'` hands back the information alone: Take down; any
 * other `chat`, both layers); `to` the Board ('board') or one person ({onStage}: whether they sit On stage in the hall's
 * Main room); `arrive` an information take's way onto a page ('over' or 'side').
 *
 * `facts`: `canPush` (the operator's: the admin, display.control, a locked hall's backstage guest); `account` (an
 * account's page, the admin's token's not), `admin`; `show` and `web` (stage.show, a boolean; a web page's right, true or
 * why not in words, a code guest's by the hall's setting); `seat`, where it sits ('research', 'board', 'observer'),
 * `inHall` (in a room of this hall), `post` and `files` there, `listed` (that room is the Main room or on its list);
 * `notPush`, why this page may not push at all, in the words of who it is; `current`, the target's information take now
 * ({seq, op, kind, name}, `op` whether its pusher held canPush) or null: over the show, or, for a take-down that names the
 * take beside it, that one; `opOn`, the operator's information drawn on one of the target's pages in place of the
 * target's own ({kind}: a person On stage shown one of their own while the Board's is a researcher's) or null; `ifSeq`, the
 * take a take-down names.
 *
 *   1. canPush: every kind, any target, either layer and arrival; for an account, the information kinds and the take-down
 *      with stage.show, a web page with its right.
 *   2. Otherwise an account seated backstage in a room of the hall, where it may post, to the Board or a person On stage:
 *      stage.show for a document, a picture or a quote (and its files right for a document or a picture), stage.web for a
 *      web page, and a take-down of a kind it could have put up itself by those rights; from a side room, that room on the
 *      Main room's list; never `over` the operator's information, the target's or on any page of theirs (its `side` is
 *      taken), and a take-down only of the take it names, put up by canShow, while no page of theirs shows the operator's.
 *      Never the show layer, nor a hand-back of both.
 */
function canShow(facts, kind, to, arrive = 'over') {
  const f = isRecord(facts) ? facts : {};
  const k = typeof kind === 'string' ? kind : isRecord(kind) ? own(kind, 'kind') : '';
  const takeDown = k === 'chat' && isRecord(kind) && own(kind, 'layer') === 'info';
  const info = takeDown || layerOf(k) === 'info';
  const notPush = typeof f.notPush === 'string' && f.notPush ? f.notPush : BACKSTAGE_TEAM;
  const webWhy = f.web === true ? true : typeof f.web === 'string' && f.web ? f.web : NO_WEB;
  if (f.canPush === true) {
    if (!info) return true;
    if (k === 'web') return webWhy;
    return f.account === true && f.admin !== true && f.show !== true ? NO_SHOW : true;
  }
  if (!info || f.account !== true) return notPush;
  if (f.seat !== 'research' || f.inHall !== true || f.post !== true) return f.seat === 'board' ? notPush : BACKSTAGE_TEAM;
  if (!(to === 'board' || (isRecord(to) && to.onStage === true))) return ONLY_ON_STAGE;
  if (k === 'web') { if (webWhy !== true) return webWhy; }
  else if (takeDown) { if (f.show !== true && f.web !== true) return NO_SHOW; }
  else {
    if (f.show !== true) return NO_SHOW;
    if ((k === 'doc' || k === 'image') && f.files !== true) return NO_FILES;
  }
  if (f.listed !== true) return OFF_LIST;
  const cur = isRecord(f.current) && whole(f.current.seq) ? f.current : null;
  const opOn = isRecord(f.opOn) && typeof f.opOn.kind === 'string' ? f.opOn : null;
  if (takeDown) {
    if (!Number.isInteger(f.ifSeq)) return TAKE_DOWN_NAMES;
    if (!cur || cur.kind === 'chat' || cur.seq !== f.ifSeq) return replacedWords(cur);
    if (cur.op === true) return operatorWords(cur.kind);
    if (opOn) return operatorWords(opOn.kind);
    // Only what it could have put up itself: a web page by its web right, the other kinds by stage.show.
    if (cur.kind === 'web') return webWhy;
    return f.show === true ? true : NO_SHOW;
  }
  if (arrive !== 'side' && cur && cur.op === true && cur.kind !== 'chat') return operatorWords(cur.kind);
  if (arrive !== 'side' && opOn) return operatorWords(opOn.kind);
  return true;
}

/**
 * Who put a take up, as the store keeps it: their name; `guest` when a code guest did (a web page a guest showed is
 * counted when the admin stops guests showing them: Pages#guestWeb); `op` when its pusher held canPush (the operator's
 * information stays up: canShow); and `who`, the pusher by its actor's kind and id (`account:a…`, `code:u…`,
 * `admin:host`), kept for an information take: its pusher may withdraw it, and a web page's address a push's answer gives
 * back to its own pusher and to no other (lib/handlers/takes.js). None of `guest`, `op` or `who` goes to a page: a page is
 * told the name alone.
 */
const WHO = /^(?:account|code|admin):[A-Za-z0-9_-]{1,64}$/;
const byOf = (by) => ({
  name: guard.cleanText(isRecord(by) ? by.name : '', 60),
  ...(isRecord(by) && by.guest === true ? { guest: true } : {}),
  ...(isRecord(by) && by.op === true ? { op: true } : {}),
  ...(isRecord(by) && typeof by.who === 'string' && WHO.test(by.who) ? { who: by.who } : {}),
});
/**
 * A take read back: {seq, content, by: {name, guest?, op?, who?}, at, arrive?, aside?}, its number at most the hall's, or
 * null. `arrive` is kept only as 'side', an information take's way onto a page in its side bar ('over' when absent), and
 * `aside` only with it: that take was put beside the operator's (kept `beside`).
 */
function storedTake(t, top) {
  if (!isRecord(t) || !whole(t.seq) || t.seq > top || !Number.isFinite(t.at) || !isRecord(t.by) || typeof t.by.name !== 'string') return null;
  const content = storedPage(t.content);
  if (!content || (t.arrive !== undefined && !(t.arrive === 'side' && layerOf(content.kind) === 'info'))) return null;
  if (t.aside !== undefined && !(t.aside === true && t.arrive === 'side')) return null;
  const sent = sentOf(t.sent);
  if (t.sent !== undefined && !sent) return null;
  return { seq: t.seq, content, by: byOf(t.by), at: t.at, ...(t.arrive === 'side' ? { arrive: 'side' } : {}), ...(t.aside === true ? { aside: true } : {}), ...(sent ? { sent } : {}) };
}
/**
 * The side room a take was sent from ({key, name}: kept on this laptop, said by its name, "…, sent from Legal"), read
 * back, or null for none.
 */
const sentOf = (v) => (isRecord(v) && HALL.test(guard.str(v.key)) && typeof v.name === 'string' ? { key: v.key, name: guard.cleanText(v.name, 60) } : null);
/** A stage file read back: the upload a take named, {at, room, uid, name, named?}, or null. */
const storedStageFile = (f) => (isRecord(f) && Number.isFinite(f.at) && HALL.test(guard.str(f.room)) && (f.uid === '' || GUEST.test(guard.str(f.uid))) && typeof f.name === 'string' && f.name.length <= 120
  ? { at: f.at, room: f.room, uid: f.uid, name: f.name, ...(f.named === true ? { named: true } : {}) } : null);
/** A withdrawn take read back: its number and who withdrew it (an actor's kind and id), or null. */
const storedWithdrawn = (w, top) => (isRecord(w) && whole(w.seq) && w.seq <= top ? { seq: w.seq, ...(typeof w.who === 'string' && WHO.test(w.who) ? { who: w.who } : {}) } : null);
/** Whether a take read back belongs in a place (SLOTS): one of its layers, the information's never a take put beside. */
const fitsSlot = (t, slot) => (slot === 'beside' ? layersOf(t.content).includes('info') : layersOf(t.content).includes(slot) && !(slot === 'info' && t.aside === true));
/** An Earlier entry read back: a take of the information layer with whom it was for (`to`: 'board' or a person's key). */
function storedEarlier(e, top) {
  const t = isRecord(e) ? storedTake(e, top) : null;
  return t && layerOf(t.content.kind) === 'info' && (e.to === 'board' || PERSON.test(guard.str(e.to))) ? { ...t, to: e.to } : null;
}
/** An answer read back: {seq, state, at}, or null. */
function storedAnswer(a, top) {
  return isRecord(a) && whole(a.seq) && a.seq <= top && ANSWERS.includes(a.state) && Number.isFinite(a.at) ? { seq: a.seq, state: a.state, at: a.at } : null;
}
/** Each place of `o` (SLOTS) read by `read(value, slot)`, the places that read whole kept, or null when none did. */
function readLayers(o, read) {
  if (!isRecord(o)) return null;
  const out = {};
  for (const slot of SLOTS) { const r = read(own(o, slot), slot); if (r) out[slot] = r; }
  return Object.keys(out).length ? out : null;
}
/**
 * A hall's book read back: its counter, the Board's takes, each person's takes and answers, and its Earlier list; null
 * when it is no book. A take is kept only in a place it belongs (fitsSlot: a clock found in the information layer is no
 * take there). (A book numbers its own takes: it is no room's, and its counter is no room's change number.)
 */
function storedHall(book) {
  if (!isRecord(book) || !whole(book.seq, 0)) return null;
  const take = (t, slot) => { const r = storedTake(t, book.seq); return r && fitsSlot(r, slot) ? r : null; };
  const answer = (a) => storedAnswer(a, book.seq);
  const keyed = (o, read) => {
    const out = {};
    if (isRecord(o)) for (const [k, v] of Object.entries(o)) { const r = PERSON.test(k) ? readLayers(v, read) : null; if (r) out[k] = r; }
    return out;
  };
  // A hall's stage files and its withdrawn takes are kept only once it has any.
  const files = {};
  if (isRecord(book.files)) for (const [name, f] of Object.entries(book.files)) { const r = guard.validUploadUrl('/uploads/' + name) ? storedStageFile(f) : null; if (r) files[name] = r; }
  const withdrawn = Array.isArray(book.withdrawn) ? book.withdrawn.slice(-BOUNDS.withdrawn).map((w) => storedWithdrawn(w, book.seq)).filter(Boolean) : [];
  return {
    seq: book.seq, board: readLayers(book.board, take) || {}, people: keyed(book.people, take), answers: keyed(book.answers, answer),
    earlier: Array.isArray(book.earlier) ? book.earlier.slice(-BOUNDS.earlier).map((e) => storedEarlier(e, book.seq)).filter(Boolean) : [],
    ...(Object.keys(files).length ? { files } : {}), ...(withdrawn.length ? { withdrawn } : {}),
  };
}

/** Names in words: "Ana", "Ana and Ben", "Ana, Ben and 2 more". */
function namesWords(names) {
  const list = [...new Set(names.map((n) => n || 'Someone'))];
  if (list.length <= 2) return list.join(' and ');
  return list.slice(0, 2).join(', ') + ' and ' + (list.length - 2) + ' more';
}

class Pages {
  /**
   * The store at `file`, read now and written only once `hold()` is called: until then a change is kept and marks the
   * store to be saved. `unread` is why the file itself could not be read (EBUSY, EACCES), or '' (it was, or is not there).
   * `seal` and `open` keep a web page's address at rest (lib/secretbox.js): `seal` throws or answers '' where this run
   * cannot seal, and then no web take is kept; `open` answers '' for an address it cannot read.
   */
  constructor(file, { seal = () => '', open = () => '', wait = 60 * 60_000 } = {}) {
    this.seal = seal;
    this.open = open;
    // How long a stage file is kept once nothing names it (the server's UPLOAD_ORPHAN_MS).
    this.wait = Number.isFinite(wait) && wait >= 0 ? wait : 60 * 60_000;
    this.lane = new WriteLane(file, { delayMs: 100, keepBak: true, mode: 0o600 });
    const read = readJsonWhole(file);
    this.unread = read.codes[0] && read.codes[0] !== 'ENOENT' ? read.codes[0] : '';
    const data = isRecord(read.data) ? read.data : {};
    // The guests' views, in the order they were set (the oldest first), as the store writes them: the file's order is the
    // order set, never the laptop's clock, so the bound lets the oldest go at no cost and a clock stepped back moves none.
    this.views = new Map();
    if (isRecord(data.views)) {
      for (const [k, v] of Object.entries(data.views)) {
        if (/^u:/.test(k) && GUEST.test(k.slice(2)) && isRecord(v) && VIEWS.includes(v.view) && v.view && Number.isFinite(v.at)) this.views.set(k, { view: v.view, at: v.at });
      }
    }
    this.halls = {};
    if (isRecord(data.halls)) for (const [code, book] of Object.entries(data.halls)) { const r = HALL.test(code) ? storedHall(book) : null; if (r) this.halls[code] = r; }
    for (const book of Object.values(this.halls)) this._trim(book);
    this._trimViews();
    // The run's reports: by hall, each page (its socket's id) with the take it reported on. Never saved.
    this.live = new Map();
    this.liveHall = new Map();
    this.held = false;
    this.dirty = false;
  }

  /** This copy holds its data folder: from now on it writes, beginning with what changed before. */
  hold() {
    this.held = true;
    if (this.dirty) this.save();
  }

  save() {
    if (!this.held) { this.dirty = true; return; }
    this.dirty = false;
    this.lane.save(() => JSON.stringify({ v: 1, views: Object.fromEntries(this.views), halls: this.halls }));
  }
  flush() { return this.lane.flushSync(); }

  /**
   * A take: `content` as cleanPage made it, to `'board'` or a person's key, numbered next in its hall, in each place it
   * changes (slotsOf: `chat` every one, a show kind the show's, information the layer over the show and what is beside
   * it). A Board take puts away the older takes and answers, in its places, of everyone seated On stage now (`onStage`,
   * their keys): a Board page shows the highest-numbered take, so none of theirs could show there again. A person's take
   * puts away that person's answer to an older one. An information take put away so (superseded, handed back) joins
   * Earlier, whom it was for with it. An information take keeps its arrival when it is `side`; with `aside` (a side push
   * over the operator's information, plan 4-§5.9.1) it is kept `beside` alone, superseding nothing over the show. A
   * hand-back of the information alone hands back the place `slot` names ('info' or 'beside', what its Take down named),
   * else both. Where a place takes a take it does not draw (`beside` an information take over the show), it keeps that
   * take's number as a hand-back, so nothing older beside it shows again. A web page's address is kept sealed (`_kept`);
   * `by.guest` marks a code guest's take, `by.op` one its pusher held canPush for. Returns the take, or null when a part is
   * not one the store keeps (a web page this run cannot seal among them).
   */
  take(hall, to, content, by = {}, { onStage = [], at = Date.now(), arrive = 'over', aside = false, slot = '', sent = null } = {}) {
    const clean = storedPage(this._kept(content));
    if (!HALL.test(guard.str(hall)) || !(to === 'board' || PERSON.test(guard.str(to))) || !clean || !Number.isFinite(at) || !ARRIVALS.includes(arrive)) return null;
    const side = arrive === 'side' && layerOf(clean.kind) === 'info';
    const beside = aside === true && side;
    const slots = slotsOf(clean, { aside: beside, slot });
    const from = sentOf(sent);
    const book = this._book(hall);
    book.seq += 1;
    const t = { seq: book.seq, content: clean, by: byOf(by), at, ...(side ? { arrive: 'side' } : {}), ...(beside ? { aside: true } : {}), ...(from ? { sent: from } : {}) };
    const kept = (s) => (s === 'beside' && !beside && clean.kind !== 'chat' ? { seq: t.seq, content: { kind: 'chat', layer: 'info' }, by: t.by, at } : t);
    for (const s of slots) {
      const k = kept(s);
      if (to === 'board') {
        this._earlier(book, own(book.board, s), 'board');
        book.board[s] = k;
        for (const key of Array.isArray(onStage) ? onStage : []) {
          if (typeof key !== 'string' || !PERSON.test(key)) continue;
          this._earlier(book, own(book.people, key) && own(book.people[key], s), key);
          this._drop(book.people, key, s);
          this._drop(book.answers, key, s);
        }
      } else {
        this._earlier(book, own(book.people, to) && own(book.people[to], s), to);
        book.people[to] = { ...(book.people[to] || {}), [s]: k };
        this._drop(book.answers, to, s);
      }
    }
    this._trim(book, at);
    this.save();
    return t;
  }

  /** A hall's book, made empty where it has none yet. */
  _book(hall) {
    return this.halls[hall] || (this.halls[hall] = { seq: 0, board: {}, people: {}, answers: {}, earlier: [] });
  }

  /**
   * An information take put away (`t`: superseded, handed back, Back to chat) joins the hall's Earlier list with whom it
   * was for (`to`), once, at its end: the newest last. A hand-back, a show take and no take join nothing.
   */
  _earlier(book, t, to) {
    if (!isRecord(t) || !isRecord(t.content) || layerOf(t.content.kind) !== 'info') return;
    if (!Array.isArray(book.earlier)) book.earlier = [];
    book.earlier = book.earlier.filter((e) => e.seq !== t.seq);
    book.earlier.push({ ...t, to });
  }

  /**
   * The Earlier entries a page is told (plan 4-§5.9.1): those for its person (`key`) and, on a page seated On stage in
   * Main (`board`), the Board's, the newest EARLIER_TOLD, the newest first, each as {seq, content, by: {name}, at}: its
   * content as the pages it was shown on are told it (`told`: a web page's address opened).
   */
  earlierOf(hall, key, { board = false, observer = false } = {}) {
    return this._earlierFor(hall, key, board).map((e) => ({ seq: e.seq, content: this.told(e.content, { observer }), by: { name: e.by.name }, at: e.at }));
  }
  /** The numbers of the Earlier entries a page is told, as one word: what moved there, read without opening an address. */
  earlierSaid(hall, key, { board = false } = {}) {
    return this._earlierFor(hall, key, board).map((e) => e.seq).join(',');
  }
  /** The Earlier entries a page is told, as the store keeps them: the newest EARLIER_TOLD of its own, the newest first. */
  _earlierFor(hall, key, board) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book || !Array.isArray(book.earlier)) return [];
    const mine = book.earlier.filter((e) => (PERSON.test(guard.str(key)) && e.to === key) || (board === true && e.to === 'board'));
    return mine.slice(-EARLIER_TOLD).reverse();
  }

  /**
   * A take as cleanPage made it, as the store keeps it: a web page's address sealed beside its host ({kind, host,
   * urlSealed}; null where this run cannot seal it), every other kind as it is.
   */
  _kept(content) {
    if (isRecord(content) && content.kind === 'snippet') return this._keptQuote(content);
    if (!isRecord(content) || content.kind !== 'web') return content;
    const w = webUrl(content.url);
    if (w.error) return null;
    let urlSealed;
    try { urlSealed = this.seal(w.url); } catch { return null; }   // this run has no machine key: nothing is kept in clear
    return { kind: 'web', host: w.host, urlSealed };
  }

  /**
   * A quote as the store keeps it: one from a web page by its host, its address sealed beside it ({host, urlSealed}), or by
   * its host alone where this run cannot seal; every other as it is.
   */
  _keptQuote(content) {
    const from = content.from;
    if (!isRecord(from) || typeof from.web !== 'string') return content;
    let urlSealed;
    try { urlSealed = guard.str(this.seal(from.web)); } catch { urlSealed = ''; }   // this run has no machine key: the host alone is kept
    return { ...content, from: { host: from.host, ...(urlSealed ? { urlSealed } : {}) } };
  }

  /**
   * A take's content as a page it is shown on is told it (and as its pusher may read it back): a web page's address
   * opened ({kind, url, host}, `url` '' where this machine cannot open it); a document or a picture without the key of
   * the side room it belongs to (a room's key is its guest code: its name is said); a document to a page seated as an
   * observer (`observer`) without its address, which would hand over the whole file (`withheld`): that page draws
   * nothing of it. Every other kind as it is kept.
   */
  told(content, { observer = false } = {}) {
    if (!isRecord(content)) return content;
    if (content.kind === 'web') return { kind: 'web', url: guard.str(this.open(content.urlSealed)), host: content.host };
    // A quote names where it comes from by a file's name and its room's name, or a web page's host: never a file's address
    // nor a side room's key. A web page's address is told only where it was kept (its pusher could show a web page:
    // snippetFrom), opened here for the pages it is shown on (their Open the source); one this machine cannot open, or that
    // is no web page's address once opened, is told by its host alone.
    if (content.kind === 'snippet') {
      if (!isRecord(content.from)) return content;
      const { from, ...rest } = content;
      if (typeof from.host === 'string') {
        const opened = typeof from.urlSealed === 'string' ? webUrl(guard.str(this.open(from.urlSealed))) : { error: 'none kept' };
        return { ...rest, from: { host: from.host, ...(opened.error || opened.host !== from.host ? {} : { url: opened.url }) } };
      }
      return { ...rest, from: Object.fromEntries(Object.entries(from).filter(([k]) => k !== 'room')) };
    }
    if (!FILE_KINDS.includes(content.kind)) return content;
    const { room, roomName, from, ...rest } = content;
    const named = room ? { roomName } : {};
    const of = isRecord(from) ? { from: Object.fromEntries(Object.entries(from).filter(([k]) => k !== 'room')) } : {};
    if (content.kind === 'doc' && observer === true) return { kind: 'doc', name: rest.name, ...(rest.at ? { at: rest.at } : {}), withheld: true, ...named };
    return { ...rest, ...of, ...named };
  }

  // ---------------------------------------------------------------- the stage's files (plan 4-§5.11)
  // A stage file is an upload a take of the hall named that no message holds (a picture drawn of a page, a document or a
  // holding slide's picture shown before it was shared, a file whose message went while a take still named it): kept by the
  // hall ({at, room, uid, name}) while a take or an Earlier entry names it, and for its wait (this.wait, the server's
  // UPLOAD_ORPHAN_MS) once nothing does (`named` gone, `at` then), so a push within that wait finds it again; then it is
  // the server's to remove, unless a message, a screen or a hall's holding image holds it. At most BOUNDS.stageFiles a
  // hall in use.

  /**
   * The uploads a hall's takes now and its Earlier entries name, by their file names: a document's and its stand-in
   * picture's, a picture's and a holding slide's own picture (filesOf); `info` true, the information's alone (a document's
   * and its stand-in's, a picture's: what a take-down ends).
   */
  _namedIn(book, { info = false } = {}) {
    const out = new Set();
    const add = (t) => {
      if (!t || (info && !FILE_KINDS.includes(t.content.kind))) return;
      for (const url of filesOf(t.content)) out.add(url.slice(9));
    };
    for (const s of SLOTS) add(own(book.board, s));
    for (const r of Object.values(book.people || {})) for (const s of SLOTS) add(own(r, s));
    for (const e of book.earlier || []) add(e);
    return out;
  }
  /** Each stage file of a hall marked named or not, as its takes and Earlier stand now: one no longer named starts its wait `at`. */
  _settle(book, at) {
    if (!isRecord(book.files)) return;
    const named = this._namedIn(book);
    for (const [name, f] of Object.entries(book.files)) {
      if (named.has(name)) f.named = true;
      else if (f.named) { delete f.named; f.at = at; }
    }
  }
  /** Whether a stage file is in use at `now`: a take or Earlier names it, or nothing has for less than the wait. */
  _inUse(f, now) { return f.named === true || now - f.at < this.wait; }
  /**
   * Whether a hall's stage may keep the uploads `names` (one name, or the list one take names: a document and its stand-in
   * picture) at `now`, all of them together (a take naming them is refused otherwise: "… holds 200 files"): those it does
   * not hold yet fit under BOUNDS.stageFiles with as many it holds in use no longer let go.
   */
  fileRoom(hall, names, now = Date.now()) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    const files = book && isRecord(book.files) ? book.files : {};
    const wanted = [...new Set(Array.isArray(names) ? names : [names])].filter((n) => !Object.hasOwn(files, n));
    const over = Object.keys(files).length + wanted.length - BOUNDS.stageFiles;
    return over <= 0 || Object.values(files).filter((f) => !this._inUse(f, now)).length >= over;
  }
  /**
   * The upload `name` a take of the hall named kept as a stage file ({at: its upload's time, room: the room it was made for,
   * uid: who made it, '' where none is known, name: its name}), once that take is kept; past the bound, the oldest in use
   * no longer goes. Returns the names that went, for the server to remove.
   */
  recordFile(hall, name, rec, at = Date.now()) {
    if (!HALL.test(guard.str(hall)) || !guard.validUploadUrl('/uploads/' + name)) return [];
    const book = this._book(hall);
    const r = storedStageFile({ at: isRecord(rec) && Number.isFinite(rec.at) ? rec.at : at, room: isRecord(rec) ? rec.room : '', uid: isRecord(rec) ? rec.uid : '', name: isRecord(rec) ? guard.cleanText(rec.name, 120) : '' });
    if (!r) return [];
    if (!isRecord(book.files)) book.files = {};
    if (!Object.hasOwn(book.files, name)) book.files[name] = r;
    const gone = [];
    while (Object.keys(book.files).length > BOUNDS.stageFiles) {
      const oldest = Object.entries(book.files).filter(([n, f]) => n !== name && !this._inUse(f, at)).sort((x, y) => x[1].at - y[1].at)[0];
      if (!oldest) break;
      delete book.files[oldest[0]];
      gone.push(oldest[0]);
    }
    this._settle(book, at);
    this.save();
    return gone;
  }
  /**
   * What the hall's stage records of the upload `name`, for a push that names it (sourceOk's rule 4): {room, name}, the
   * room it was recorded for and its name, from its stage file, or from a take or an Earlier entry that names it; or null.
   */
  recordOf(hall, name) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book) return null;
    const f = isRecord(book.files) ? own(book.files, name) : undefined;
    if (f) return { room: f.room, name: f.name };
    const t = this._takes(book).find((x) => FILE_KINDS.includes(x.content.kind) && x.content.url === '/uploads/' + name);
    return t ? { room: t.content.room || hall, name: t.content.name } : null;
  }
  /**
   * Whether an information take of the hall now, or an Earlier entry of it, names the upload at `url` (a document or a
   * picture of it: what a take-down of it ends). A holding slide's picture is the show's: it is kept on the disk while the
   * slide is up (stageInUse), and the operator takes the slide down.
   */
  namesUrl(hall, url) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    return !!book && guard.validUploadUrl(url) && this._namedIn(book, { info: true }).has(url.slice(9));
  }
  /**
   * The upload `name` kept as a stage file of each hall whose takes or Earlier name it and whose stage holds no record of
   * it ({room, uid, name}: the room it belonged to, who shared it, its name), once nothing else holds it (its message
   * deleted, its room reset): its wait then starts when nothing names it, and the sweeps remove it after. Returns the
   * names that went past a hall's bound, for the server to remove.
   */
  adopt(name, rec, at = Date.now()) {
    const gone = [];
    for (const [hall, book] of Object.entries(this.halls)) {
      if (this._namedIn(book).has(name) && !(isRecord(book.files) && Object.hasOwn(book.files, name))) gone.push(...this.recordFile(hall, name, rec, at));
    }
    return gone;
  }
  /**
   * The uploads the stage keeps now, by their file names, in every hall: each a take or an Earlier entry names, and each
   * stage file inside its wait (this.wait since nothing named it).
   */
  stageInUse(now = Date.now()) {
    const out = new Set();
    for (const book of Object.values(this.halls)) {
      for (const n of this._namedIn(book)) out.add(n);
      for (const [n, f] of Object.entries(book.files || {})) if (this._inUse(f, now)) out.add(n);
    }
    return out;
  }
  /** The stage files past their wait (since nothing named them) let go, in every hall: their names, for removal. */
  stageGone(now = Date.now()) {
    const gone = [];
    for (const book of Object.values(this.halls)) {
      this._settle(book, now);
      for (const [n, f] of Object.entries(book.files || {})) if (!this._inUse(f, now)) { delete book.files[n]; gone.push(n); }
      if (isRecord(book.files) && !Object.keys(book.files).length) delete book.files;
    }
    if (gone.length) this.save();
    return gone;
  }

  // ---------------------------------------------------------------- what ends a take (plan 4-§5.9.7, §5.11)

  /** Every take a hall holds, current or Earlier: the Board's, each person's, and its Earlier entries. */
  _takes(book) {
    const out = [];
    for (const s of SLOTS) { const t = own(book.board, s); if (t) out.push(t); }
    for (const r of Object.values(book.people || {})) for (const s of SLOTS) { const t = own(r, s); if (t) out.push(t); }
    for (const e of book.earlier || []) out.push(e);
    return out;
  }
  /**
   * The information take numbered `seq` in a hall, on a page now or under Earlier: {take, to}, `to` whom it was for ('board'
   * or each person's key); null when there is none.
   */
  find(hall, seq) {
    const book = HALL.test(guard.str(hall)) && whole(seq) ? own(this.halls, hall) : undefined;
    if (!book) return null;
    const to = new Set();
    let take = null;
    const see = (t, who) => { if (t && t.seq === seq && layerOf(t.content.kind) === 'info') { take = take || t; to.add(who); } };
    for (const s of SLOTS) see(own(book.board, s), 'board');
    for (const [key, r] of Object.entries(book.people || {})) for (const s of SLOTS) see(own(r, s), key);
    for (const e of book.earlier || []) see(e, e.to);
    return take ? { take, to: [...to] } : null;
  }
  /** Who withdrew the take numbered `seq` in a hall, when it was ({who?}), or null. */
  withdrawnOf(hall, seq) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    const w = book && Array.isArray(book.withdrawn) ? book.withdrawn.find((x) => x.seq === seq) : null;
    return w ? { ...(w.who ? { who: w.who } : {}) } : null;
  }
  /**
   * Every information take of a hall `which` says (a function of a take), on its pages now and under Earlier, ended: each
   * place that shows one handed back (one hand-back of the information, numbered next, by nobody) and its answers let go,
   * and each Earlier entry it names gone (`earlier: 'all'` empties Earlier whole). The stage files they named start their
   * wait. Returns how many takes ended.
   */
  endTakes(hall, which, { at = Date.now(), earlier = '' } = {}) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book || typeof which !== 'function') return 0;
    const ended = new Set();
    let hand = null;
    const handBack = () => hand || (hand = { seq: (book.seq += 1), content: { kind: 'chat', layer: 'info' }, by: { name: '' }, at });
    const end = (holder, key, s) => {
      const t = own(holder, s);
      if (!t || t.content.kind === 'chat' || layerOf(t.content.kind) !== 'info' || !which(t)) return false;
      ended.add(t.seq);
      holder[s] = handBack();
      if (key) this._drop(book.answers, key, s);
      return true;
    };
    for (const s of ['info', 'beside']) {
      if (end(book.board, '', s)) for (const key of Object.keys(book.answers)) { const a = own(book.answers[key], s); if (a && ended.has(a.seq)) this._drop(book.answers, key, s); }
      for (const [key, r] of Object.entries(book.people)) end(r, key, s);
    }
    const kept = [];
    for (const e of book.earlier || []) { if (earlier === 'all' || which(e)) ended.add(e.seq); else kept.push(e); }
    book.earlier = kept;
    if (!ended.size) return 0;
    this._trim(book, at);
    this.save();
    return ended.size;
  }
  /**
   * The information take numbered `seq` withdrawn (a take shown by mistake): handed back wherever a page shows it now (one
   * hand-back, numbered next), gone from Earlier, its answers let go, and kept as withdrawn (with `who`, who withdrew it),
   * so a repeat is told it is done. Returns {take, to} as find() found it, or null when there is none.
   */
  withdraw(hall, seq, { at = Date.now(), who = '' } = {}) {
    const found = this.find(hall, seq);
    if (!found) return null;
    const book = this.halls[hall];
    this.endTakes(hall, (t) => t.seq === seq, { at });
    book.withdrawn = (book.withdrawn || []).filter((w) => w.seq !== seq);
    book.withdrawn.push({ seq, ...(WHO.test(guard.str(who)) ? { who } : {}) });
    this._trim(book, at);
    this.save();
    return found;
  }

  /**
   * The web pages a code guest put up in a hall that stay up (the information layer's): the Board's take, and each
   * person's not put away by them (Back to chat), whether or not a page of theirs is open now (one that comes back is shown
   * it again), each as {to: 'board' or the person's key, seq}.
   */
  guestWeb(hall) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book) return [];
    const theirs = (t) => !!t && t.content.kind === 'web' && t.by.guest === true;
    const out = [];
    const board = own(book.board, 'info');
    if (theirs(board)) out.push({ to: 'board', seq: board.seq });
    for (const [key, r] of Object.entries(book.people)) {
      const t = own(r, 'info');
      const a = own(book.answers, key) && own(book.answers[key], 'info');
      if (theirs(t) && !(a && a.seq === t.seq && a.state === 'dismissed')) out.push({ to: key, seq: t.seq });
    }
    return out;
  }

  /**
   * The web pages guests put up in a hall that stay up, as the admin is told them once guests may no longer show any (the
   * switch turned off, or the hall unlocked): {up}, their count, and while there are any `upWords` ("1 web page a guest
   * showed is still up") and `takeDown`, the takes (Pages#guestWeb) the admin's Take it down hands back.
   */
  guestWebLeft(hall) {
    const up = this.guestWeb(hall);
    const n = up.length;
    return n ? { up: n, upWords: n === 1 ? '1 web page a guest showed is still up' : n + ' web pages guests showed are still up', takeDown: up } : { up: 0 };
  }

  /**
   * The take a page is shown now in a place (`layer`, of SLOTS), and the person's answer to it: the highest-numbered of the
   * person's own and, for a page seated On stage in Main (`board`), the Board's. The answer counts only when it answers
   * that take. In the information layer a `chat` is that layer handed back: nothing over the show. Beside it, only a take
   * put there (`aside`) is shown: anything newer there put it away, and then nothing is (take null).
   */
  current(hall, key, { board = false, layer = 'show' } = {}) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book || !SLOTS.includes(layer)) return { take: null, answer: null };
    const mine = (PERSON.test(guard.str(key)) && own(book.people, key) && own(book.people[key], layer)) || null;
    const group = (board === true && own(book.board, layer)) || null;
    const take = mine && group ? (mine.seq > group.seq ? mine : group) : mine || group;
    if (layer === 'beside' && !(take && take.aside === true)) return { take: null, answer: null };
    const a = take && own(book.answers, key) && own(book.answers[key], layer);
    return { take, answer: a && a.seq === take.seq ? a : null };
  }

  /**
   * The place of the take a page is shown now whose number is `seq`: the show's, else the information's (never its
   * hand-back, which draws nothing to report on), else beside it; '' for a number it is not shown in any.
   */
  _layerOf(hall, key, board, seq) {
    for (const layer of SLOTS) {
      const { take } = this.current(hall, key, { board, layer });
      if (take && take.seq === seq && (layer === 'show' || take.content.kind !== 'chat')) return layer;
    }
    return '';
  }

  /**
   * One page says what it did with a take (its socket's id `sid`, its person's `key`, `board` when it sits On stage in
   * Main, at `at`): counted only for a take that page is shown now in a place (its show take, the information over it, or
   * the information beside it), never an older one, and only in a state a take of its kind has. Back to chat and Minimise are the person's answer,
   * kept with that take for all their pages. Back to chat is final for it once AGAIN_MS have passed; until then the
   * person's Show it again (`again`) takes it back, and a card's Undo (`minimised`) makes it a Minimise again. A Minimise is
   * taken back only by the person's Show again (`again`, a `shown` report): a page that drew the take and says so (`shown`,
   * as it first draws or comes back into view) before it hears of the Minimise keeps it, so one device never undoes what
   * the person did on another. An information take put away with Back to chat joins Earlier. `words` say why a take is
   * not drawn or where it is ("under a web page", "held under blank", "in the side bar"); a `hidden` report with none is a
   * page out of view. Returns {ok, answer}, the person's answer to that take as it now stands, and `hiddenMs` when
   * this report ends a Board page's time out of view with a take drawn on it; or {ok: false, error}; a report of no
   * person, at no time, keeps nothing.
   */
  report(hall, sid, { key, board = false, seq, state, again = false, words = '', at = Date.now() } = {}) {
    if (!REPORTS.includes(state)) return { ok: false, error: 'A report is one of: ' + REPORTS.join(', ') + '.' };
    if (typeof sid !== 'string' || !sid) return { ok: false, error: 'No page to report for.' };
    if (!PERSON.test(guard.str(key)) || !Number.isFinite(at)) return { ok: false, error: 'No person to report for.' };
    const layer = Number.isInteger(seq) ? this._layerOf(hall, key, board, seq) : '';
    if (!layer) return { ok: false, error: 'That is not what this page is shown now.' };
    const { take, answer } = this.current(hall, key, { board, layer });
    const states = reportsOf(take.content.kind);
    if (!states.includes(state)) return { ok: false, error: 'A page shown ' + describePage(take.content) + ' reports one of: ' + states.join(', ') + '.' };
    const inView = inViewOf(take.content.kind);
    // Back to chat taken back: Show it again (in view, `again`) or a card's Undo (minimised), within AGAIN_MS of it.
    const undo = (state === inView && again === true) || state === 'minimised';
    if (answer && answer.state === 'dismissed' && state !== 'dismissed') {
      if (!undo) return { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' };
      if (at - answer.at > AGAIN_MS) return { ok: false, error: 'Back to chat was chosen for that one more than 10 s ago: a newer take shows again.' };
    }
    const book = this.halls[hall];
    let kept = answer;
    if (ANSWERS.includes(state) && !(answer && answer.state === state)) {
      kept = this._answer(book, key, layer, { seq, state, at });
      // Put away with Back to chat, an information take is the person's to find again under Earlier.
      if (state === 'dismissed' && layer !== 'show') this._earlier(book, take, own(book.board, layer) === take ? 'board' : key);
    } else if (state === inView && again === true && answer) { this._drop(book.answers, key, layer); kept = null; }
    if (kept !== answer) { this._trim(book); this.save(); }
    // A Board page out of view (asleep, or another app in front) while a take is drawn on it: how long, from its first
    // such report to the report or the leave that ends it, a take that replaces another while it stays out of view
    // included (health's peaks, `pageHiddenMs`). Out of view is a `hidden` report with no words: one with words is a take
    // drawn under another, or held, on a page in view.
    const was = this._forget(sid, layer);
    const said = guard.cleanText(words, 160);
    const out = state === 'hidden' && !said && board === true && take.content.kind !== 'chat';
    const hiddenSince = out ? (was && was.hiddenSince) || at : 0;
    if (!this.live.has(hall)) this.live.set(hall, new Map());
    const reports = this.live.get(hall);
    const mine = reports.get(sid) || {};
    mine[layer] = { key, seq, state, words: said, at, hiddenSince };
    reports.set(sid, mine);
    this.liveHall.set(sid, hall);
    const ended = !out && was && was.hiddenSince ? Math.max(0, at - was.hiddenSince) : -1;
    return { ok: true, answer: kept || null, ...(ended >= 0 ? { hiddenMs: ended } : {}) };
  }

  /**
   * A page went (its socket closed, or it moved to another room): its reports go with it. Returns the hall it reported
   * in and, when it was a Board page out of view while a take was drawn on it, for how long (`hiddenMs`, the longest of
   * its layers'); or null when it had reported nothing.
   */
  left(sid, at = Date.now()) {
    const hall = this.liveHall.get(sid);
    if (hall === undefined) return null;
    const since = SLOTS.map((layer) => this._forget(sid, layer)).filter((r) => r && r.hiddenSince).map((r) => r.hiddenSince);
    return { hall, ...(since.length && Number.isFinite(at) ? { hiddenMs: Math.max(0, at - Math.min(...since)) } : {}) };
  }

  /** A page's report in one layer taken out of the run's reports, with the hall it was in; null when it had none. */
  _forget(sid, layer) {
    const hall = this.liveHall.get(sid);
    if (hall === undefined) return null;
    const reports = this.live.get(hall);
    const mine = reports.get(sid) || {};
    const r = own(mine, layer);
    delete mine[layer];
    if (!Object.keys(mine).length) {
      reports.delete(sid);
      this.liveHall.delete(sid);
      if (!reports.size) this.live.delete(hall);
    }
    return r ? { ...r, hall } : null;
  }

  /**
   * Where one page stands on the take it is shown now in a layer ({sid, key, board}): {seq, state, words, at}, its state
   * the person's answer to that take, else the page's report on it, else `waiting`. A page's report of an answer (Back to
   * chat, Minimise) is the person's answer, and counts only while that answer stands: once taken back (Show it again),
   * the page is waiting until it says what it does with the take again.
   */
  pageState(hall, { sid, key, board = false } = {}, layer = 'show') {
    const { take, answer } = this.current(hall, key, { board, layer });
    const seq = take ? take.seq : 0;
    if (answer) return { seq, state: answer.state, words: '', at: answer.at };
    const mine = this.live.has(hall) ? this.live.get(hall).get(sid) : undefined;
    const r = mine ? own(mine, layer) : undefined;
    if (r && r.key === key && r.seq === seq && !ANSWERS.includes(r.state)) return { seq, state: r.state, words: r.words, at: r.at };
    return { seq, state: 'waiting', words: '', at: 0 };
  }

  /**
   * A take's status over the pages that hold it (see Pages.status), in a layer: `to` the Board ('board') or a person's
   * key, `pages` each open page of theirs ({sid, key, board, name}). The Board's take is the Board's; a person's is the
   * newest take any of their pages is shown now. A page shown another take is said to show something else. In the
   * information layer, nothing over the show (no take, or the layer handed back) is said so, and a take there says how it
   * arrived (`arrive`) and whether the operator put it up (`op`): a researcher's Take down is only over its own kind.
   * Beside it (`beside`), a take put there is read as any other, from the reports on it ("In the side bar on …"); with
   * none, nothing is beside it (number 0). An information take says too, to an asker (`who`, an actor's kind and id),
   * whether it put it up (`mine`): its pusher may withdraw it; and who put it up (`by`, their name) and how long ago (`ago`,
   * ms at `now`), so a researcher about to replace it is told whose it is and how fresh. A document some of whose pages
   * could not open it carries the file as `docOf(content, mine)` gives it to this asker (`doc`), where it gives one.
   */
  status(hall, to, pages = [], { name = '', hallHolding = '', layer = 'show', who = '', now = Date.now(), docOf = null } = {}) {
    const list = Array.isArray(pages) ? pages : [];
    const states = list.map((p) => ({ ...this.pageState(hall, p, layer), name: p.name, docs: !isRecord(p) || p.docs !== false }));
    let take = null;
    if (to === 'board') take = this.current(hall, '', { board: true, layer }).take;
    else for (const p of list) { const t = this.current(hall, p.key, { board: p.board, layer }).take; if (t && (!take || t.seq > take.seq)) take = t; }
    const seq = take ? take.seq : 0;
    if (layer !== 'show' && (!take || take.content.kind === 'chat')) return { ...Pages.nothingOver(take, list.length, { board: to === 'board', name, beside: layer === 'beside' }), arrive: layer === 'beside' ? 'side' : 'over', op: false };
    const st = Pages.status(take, states.map((s) => (s.seq === seq ? s : { ...s, state: 'other' })), { board: to === 'board', name, hallHolding });
    // A document some of its pages could not open (`cannot`): the file, as `docOf` gives it to this asker ({url, name, at?},
    // or nothing), for Show them a picture.
    const doc = typeof docOf === 'function' && st.kind === 'doc' && st.cannot > 0 ? docOf(take.content, !!who && take.by.who === who) : null;
    return layer !== 'show' ? { ...st, arrive: take.arrive === 'side' ? 'side' : 'over', op: take.by.op === true, ...(who ? { mine: take.by.who === who, by: take.by.name, ago: Number.isFinite(now) ? Math.max(0, now - take.at) : 0 } : {}), ...(isRecord(doc) ? { doc } : {}) } : st;
  }

  /**
   * The information layer's status with nothing over the show (pure): no take, or that layer handed back (`take`, a
   * `chat`): ○ "Nothing over the show" (beside it, `beside`: "Nothing in their side bar"), or ✕ where no page of theirs is
   * open; no page reports on it.
   */
  static nothingOver(take, n, { board = false, name = '', beside = false } = {}) {
    const words = n ? (beside ? 'Nothing in their side bar' : 'Nothing over the show') : board ? 'Nobody on the Board is online' : name ? name + ' has no page open in this hall' : 'No page of theirs is open in this hall';
    return { seq: take ? take.seq : 0, showing: take ? describePage(take.content) : 'nothing', kind: take ? 'chat' : '', mark: n ? MARKS.off : MARKS.fault, words, pages: n, on: 0 };
  }

  /**
   * A take's status (pure): `take` the one the target was given, `pages` each of the target's open pages with its state
   * on it (`waiting`, a report's or an answer's state, or `other`: shown another take), the report's `words` and its
   * person's `name`. One mark, one meaning, never colour alone, and the words person first: ✕ no page open; △ a page could
   * not show it; ◷ sending, until every page has said; ○ every page went back to chat, or every page handed back to its
   * chat by a `chat` take said it is there (back to chat is never "on screen"); ▭ every page minimised it; ◇ opened (a web
   * page, which cannot be seen into); ✓ on every page (in the side bar, for one that arrived there); ◐ every page drew it
   * under another take or held it ("under a web page"); else ◐, how many show it (or, for a `chat` take, are back to chat)
   * and why the rest do not. With them, what it shows (`showing`, in words, and its `kind`), and of its `pages` how many
   * show it now (`on`).
   */
  static status(take, pages, { board = false, name = '', hallHolding = '', clock = clockOf } = {}) {
    const list = Array.isArray(pages) ? pages : [];
    const n = list.length;
    // `kind`, what it shows ('' for nothing), and `on`, how many of its pages show it now (a hand-back: are back on chat).
    const on = take ? list.filter((p) => p.state === 'shown' || p.state === 'opened').length : 0;
    const showing = describePage(take && take.content, { hallHolding, by: take && isRecord(take.by) ? take.by.name : '', sent: take && isRecord(take.sent) ? take.sent.name : '' });
    // The pages that joined without documents (plan 4-§5.15.2): how many; on a document take, how many drew its stand-in
    // (`standin`: shown "as a picture") and how many could not show it (`cannot`, which Send them a picture answers).
    // Each said only where there are some.
    const without = list.filter((p) => isRecord(p) && p.docs === false);
    const doc = !!take && isRecord(take.content) && take.content.kind === 'doc';
    const standin = doc && isRecord(take.content.standin) ? without.filter((p) => p.state === 'shown').length : 0;
    const cannot = doc ? without.filter((p) => p.state === 'failed').length : 0;
    // What the stand-in was drawn as (`standinAs`): a picture of the place, or a quote of what is there.
    const as = standin ? (take.content.standin.url !== undefined ? 'picture' : 'quote') : '';
    const counts = { ...(without.length ? { nodocs: without.length } : {}), ...(standin ? { standin, standinAs: as } : {}), ...(cannot ? { cannot } : {}) };
    const out = (mark, words) => ({ seq: take ? take.seq : 0, showing, kind: take && isRecord(take.content) ? take.content.kind : '', mark, words, pages: n, on, ...counts });
    const pictured = standin ? ', ' + standin + ' as a ' + as : '';
    if (!n) return out(MARKS.fault, board ? 'Nobody on the Board is online' : name ? name + ' has no page open in this hall' : 'No page of theirs is open in this hall');
    if (!take) return out(MARKS.off, 'Nothing shown yet');
    const of = (state) => list.filter((p) => p.state === state);
    const pagesWords = (k) => k + (k === 1 ? ' page' : ' pages');
    const failed = of('failed');
    if (failed.length) return out(MARKS.couldNot, 'Couldn\'t show it' + (n > 1 ? ' on ' + failed.length + ' of ' + pagesWords(n) : '') + (failed[0].words ? ': ' + failed[0].words : ''));
    const waiting = of('waiting').length;
    if (waiting) return out(MARKS.waiting, 'Sending' + (waiting < n ? ' · on ' + (n - waiting) + ' of ' + pagesWords(n) : ''));
    const said = (rows, words) => {
      const names = rows.map((p) => p.name);
      const one = new Set(names).size === 1;
      return namesWords(names) + ' ' + words + (one ? ' at ' + clock(Math.max(...rows.map((p) => p.at))) : '');
    };
    const dismissed = of('dismissed');
    const minimised = of('minimised');
    if (dismissed.length === n) return out(MARKS.off, said(dismissed, 'went back to chat'));
    if (minimised.length === n) return out(MARKS.minimised, said(minimised, 'minimised it'));
    // Drawn under another take or held (a `hidden` report with words): never on screen, and said with where it is.
    const under = of('hidden').filter((p) => typeof p.words === 'string' && p.words);
    const away = of('hidden').length - under.length;
    if (under.length === n && new Set(under.map((p) => p.words)).size === 1) return out(MARKS.partly, under[0].words.charAt(0).toUpperCase() + under[0].words.slice(1));
    const opened = of('opened').length;
    const seen = of('shown').length + opened;
    const chat = isRecord(take.content) && take.content.kind === 'chat';
    if (seen === n) {
      if (opened) return out(MARKS.unseen, 'Opened · AGMessage can\'t see inside web pages');
      const whose = name ? name + '\'s' : 'their';
      const where = board ? (n === 1 ? 'the 1 Board page' : 'all ' + n + ' Board pages') : n === 1 ? whose + ' page' : 'all ' + n + ' of ' + whose + ' pages';
      if (chat) return out(MARKS.off, 'Back to chat on ' + where);
      return out(MARKS.ok, (take.arrive === 'side' ? 'In the side bar on ' : 'On ') + where + pictured);
    }
    const why = [];
    if (away) why.push(away + ' asleep or in another app');
    const byWords = new Map();
    for (const p of under) byWords.set(p.words, (byWords.get(p.words) || 0) + 1);
    for (const [w, k] of byWords) why.push(k + ' ' + w);
    if (dismissed.length) why.push(namesWords(dismissed.map((p) => p.name)) + ' went back to chat');
    if (minimised.length) why.push(namesWords(minimised.map((p) => p.name)) + ' minimised it');
    const other = of('other').length;
    if (other) why.push(other + ' showing something else');
    return out(MARKS.partly, seen + ' of ' + n + (chat ? ' back to chat · ' : ' showing' + pictured + ' · ') + why.join(' · '));
  }

  /** A guest's chat view ('' by their seat, 'simple' or 'full'), kept by their uid. */
  viewOf(uid) {
    const v = this.views.get('u:' + guard.str(uid));
    return v ? v.view : '';
  }

  /** Set a guest's chat view ('' or null: by their seat again). False when the uid or the view is not one kept. */
  setView(uid, view, at = Date.now()) {
    const v = view === null ? '' : view;
    if (!GUEST.test(guard.str(uid)) || !VIEWS.includes(v) || !Number.isFinite(at)) return false;
    const k = 'u:' + uid;
    const had = this.views.delete(k);
    if (v) this.views.set(k, { view: v, at });
    else if (!had) return true;
    this._trimViews();
    this.save();
    return true;
  }

  /**
   * A hall closed: everything its people's pages were shown goes with it. Returns the names of its stage files (uploads a
   * take of it named that no message holds), which go with it whether or not its rooms' files are purged; [] when it held
   * none, and null when it held nothing at all.
   */
  forgetHall(hall) {
    if (!HALL.test(guard.str(hall))) return null;
    const reports = this.live.get(hall);
    if (reports) { for (const sid of reports.keys()) this.liveHall.delete(sid); this.live.delete(hall); }
    if (!Object.hasOwn(this.halls, hall)) return null;
    const files = Object.keys(this.halls[hall].files || {});
    delete this.halls[hall];
    this.save();
    return files;
  }

  /**
   * A person's answer in a layer, kept, and moved to the end: a hall's answers are held in the order given, the oldest
   * first, as the store writes them, so the bound never reads the laptop's clock.
   */
  _answer(book, key, layer, a) {
    const had = own(book.answers, key) || {};
    delete book.answers[key];
    book.answers[key] = { ...had, [layer]: a };
    return a;
  }

  /** `map[key][layer]` taken out, and the key with it once it holds no layer. */
  _drop(map, key, layer) {
    const r = own(map, key);
    if (!r || !Object.hasOwn(r, layer)) return;
    delete r[layer];
    if (!Object.keys(r).length) delete map[key];
  }

  /**
   * A hall held to its bounds: its oldest person takes go first (by number, the hall's own count), each with its answer,
   * then the answers given longest ago (in the order given: an answer to the Board's take is as old as the moment it was
   * given, not as the take). Neither reads the laptop's clock, so the answer just given is never the one that goes.
   */
  _trim(book, at = Date.now()) {
    const rows = (map) => Object.entries(map).flatMap(([key, r]) => Object.entries(r).map(([layer, v]) => ({ key, layer, seq: v.seq })));
    const takes = rows(book.people);
    if (takes.length > BOUNDS.personTakes) {
      for (const t of takes.sort((x, y) => x.seq - y.seq).slice(0, takes.length - BOUNDS.personTakes)) {
        this._drop(book.people, t.key, t.layer);
        const a = own(book.answers, t.key) && own(book.answers[t.key], t.layer);
        if (a && a.seq === t.seq) this._drop(book.answers, t.key, t.layer);
      }
    }
    const answers = rows(book.answers);
    if (answers.length > BOUNDS.answers) for (const a of answers.slice(0, answers.length - BOUNDS.answers)) this._drop(book.answers, a.key, a.layer);
    if (Array.isArray(book.earlier) && book.earlier.length > BOUNDS.earlier) book.earlier = book.earlier.slice(-BOUNDS.earlier);
    if (Array.isArray(book.withdrawn) && book.withdrawn.length > BOUNDS.withdrawn) book.withdrawn = book.withdrawn.slice(-BOUNDS.withdrawn);
    // A stage file named by nothing kept now starts its wait.
    this._settle(book, at);
  }

  /** The guests' views held to their bound: the one set longest ago goes first. */
  _trimViews() {
    for (const k of this.views.keys()) {
      if (this.views.size <= BOUNDS.views) return;
      this.views.delete(k);
    }
  }
}

module.exports = {
  Pages, cleanPage, cleanSnippet, snippetText, askedOf, canShow, describePage, sourceOk, mayDownload, FOR_DOWNLOAD, placeOf, placeWords, webUrl, personKey, layerOf, layersOf, reportsOf, inViewOf, KINDS, LAYERS, SLOTS, SHOW_LAYER, INFO_LAYER,
  FILE_KINDS, fileOf, filesOf, ARRIVALS, EARLIER_TOLD, IMAGE_EXT, STAGE_TYPES, TRANSFER_ONLY, PLACES, UNITS, SNIPPET, REPORTS, ANSWERS, AGAIN_MS, VIEWS, MARKS, BOUNDS, WEB_MAX, STAGE_FULL,
};
