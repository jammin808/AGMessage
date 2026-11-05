'use strict';
/**
 * People's pages: what a person's hall page is shown over its chat, as a store and a vocabulary.
 *
 * A take is numbered, as a screen's is (lib/displays.js), and goes to the Board (every page seated On stage in a hall's
 * Main room) or to one person (`a:<account id>`, every device of the account; `u:<uid>`, that device's guest). Each hall
 * numbers its takes with one counter, so a page shows the highest-numbered take addressed to it in each layer: its
 * person's, or the Board's when it sits On stage in Main. Latest wins, and `chat` hands a page back to its chat.
 *
 * Attempts are not facts: a take is sent, and each page says what it did with it (a report). The status of a take is
 * read from those reports, page by page, never from the send: "sending" until every page that holds it said, "on every
 * page" only once each said it showed it (a hand-back to the chat never read as on screen), and a page put away (Back
 * to chat) or minimised said so in the person's name. A page reports only what a take of its kind can be. A person's
 * answer (Back to chat, Minimise) counts only for the take it answered: a newer take shows again.
 *
 * Stored in `pages.json` (one write lane, written only once this copy holds its data folder: `hold()`): the takes by
 * hall and layer, the persons' answers, and the guests' chat views; each bounded, the oldest going first. A record of
 * the wrong shape is dropped when it is read. The reports are the run's alone: never saved, and a page that goes takes
 * its report with it.
 *
 *   cleanPage(c, facts)  : a take a pusher asked for, made safe, or {error} (pure, fail closed)
 *   webUrl(v, selfHosts) : a web page's address made safe, {url, host}, or {error} (pure, fail closed)
 *   describePage(c, o)   : what a take shows, in a few words (pure)
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
 * The kinds a take may be, each a kind of the show layer: back to the chat; Stagewatch's countdown; AGMessage's clock;
 * a holding slide (the picture given, the hall's holding picture, or the AGMessage mark and the hall's name on black);
 * black; a web page (an https address, framed by the page). Anything else is refused, never defaulted.
 */
const KINDS = Object.freeze(['chat', 'stage', 'clock', 'holding', 'blank', 'web']);
const KINDS_WORDS = 'Choose what to show: back to chat, Stagewatch, the clock, holding, blank or a web page.';
/** The layers a page holds, each with its own take and its own answer. Every kind of KINDS is the show layer's. */
const LAYERS = Object.freeze(['show']);
const layerOf = (kind) => (KINDS.includes(kind) ? 'show' : '');
/** A holding slide's picture: an image shared in AGMessage, of the types a screen shows (lib/displays.js). */
const IMAGE_EXT = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/**
 * The file types the stage can show: a file of one of them may be read and drawn on the Board's pages, and is checked at
 * upload (its archive, its pixels) before anyone opens it. Every type an upload may be (lib/guard.js UPLOAD_TYPES) is one.
 */
const STAGE_TYPES = Object.freeze(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'pptx']);
/**
 * The file types that are only ever transfers: downloaded, never opened, parsed, drawn or shown, and not in STAGE_TYPES.
 * None is taken yet; each that is lists its key of lib/guard.js's transfer types here, so a type added for transfer is
 * never parsed on the Board's devices unasked.
 */
const TRANSFER_ONLY = Object.freeze([]);
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
const BOUNDS = Object.freeze({ views: 5000, personTakes: 200, answers: 500 });

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
 * A take a pusher asked for, made safe, or {error} (pure). `facts` are the server's: `stagewatch`, whether the hall
 * has a Stagewatch linked; `readable(url)`, whether the file is in a message of a room of the hall the pusher may read;
 * `web`, true when this pusher may show a web page here (its own right, `stage.web`), else the words that say why not;
 * `selfHosts`, the names this AGMessage answers on (webUrl). Every result is a fresh object. An unknown kind, or a known
 * key of the wrong type, refuses the whole take with the kinds in words; a key it does not know is ignored. A `chat`
 * that names a layer is refused: the store keeps the show layer alone, so a hand-back of one layer is never widened to
 * every layer. Missing facts refuse what needs them: a web page's right is read before its address.
 */
function cleanPage(c, facts = {}) {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return { error: KINDS_WORDS };
  switch (kind) {
    case 'chat':
      if (own(c, 'layer') !== undefined) return { error: KINDS_WORDS };
      return { kind };
    case 'stage':
      if (!(facts && facts.stagewatch === true)) return { error: 'This hall has no Stagewatch linked — link one in Set up.' };
      return { kind };
    case 'holding': {
      const image = own(c, 'image');
      if (image === undefined) return { kind };
      if (typeof image !== 'string') return { error: KINDS_WORDS };
      if (!guard.validUploadUrl(image) || !IMAGE_EXT.includes(guard.extOf(image))) return { error: 'A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage.' };
      if (!(facts && typeof facts.readable === 'function' && facts.readable(image) === true)) return { error: 'That picture is in no room of this hall you can read — share it there first.' };
      return { kind, image };
    }
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
 * A take as it is stored, read back: a fresh object of a kind of KINDS in its clean shape, or null. A web page is kept
 * as its host and its sealed address ({kind, host, urlSealed}), never its address in clear.
 */
function storedPage(c) {
  const kind = isRecord(c) ? own(c, 'kind') : undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (kind === 'web') {
    const host = own(c, 'host');
    const urlSealed = own(c, 'urlSealed');
    return isHost(host) && typeof urlSealed === 'string' && urlSealed.length <= 4 * WEB_MAX && SEALED.test(urlSealed) ? { kind, host, urlSealed } : null;
  }
  if (kind !== 'holding') return { kind };
  const image = own(c, 'image');
  if (image === undefined) return { kind };
  return guard.validUploadUrl(image) && IMAGE_EXT.includes(guard.extOf(image)) ? { kind, image } : null;
}

/**
 * What a take shows, in a few words, for the console and the audit alike (pure): no kind names a file or carries a
 * path. A holding slide with no picture of its own shows the hall's (`hallHolding`) when the hall has one, else the
 * AGMessage mark. No take is the chat; anything else, ''.
 */
function describePage(c, { hallHolding = '' } = {}) {
  if (!c) return 'the chat';
  switch (isRecord(c) ? own(c, 'kind') : undefined) {
    case 'chat': return 'back to chat';
    case 'stage': return 'Stagewatch';
    case 'clock': return 'the clock';
    case 'holding': return own(c, 'image') || hallHolding ? 'a holding slide' : 'a holding slide with the AGMessage mark';
    case 'blank': return 'blank';
    case 'web': return typeof own(c, 'host') === 'string' && own(c, 'host') ? 'a web page on ' + own(c, 'host') : 'a web page';
    default: return '';
  }
}

/**
 * Who put a take up, as the store keeps it: their name; `guest` when a code guest did (a web page a guest showed is
 * counted when the admin stops guests showing them: Pages#guestWeb); and `who`, the pusher by its actor's kind and id
 * (`account:a…`, `code:u…`, `admin:host`), kept for a web page alone, whose address a push's answer gives back to its own
 * pusher and to no other (lib/handlers/takes.js). Neither goes to a page: a page is told the name alone.
 */
const WHO = /^(?:account|code|admin):[A-Za-z0-9_-]{1,64}$/;
const byOf = (by) => ({
  name: guard.cleanText(isRecord(by) ? by.name : '', 60),
  ...(isRecord(by) && by.guest === true ? { guest: true } : {}),
  ...(isRecord(by) && typeof by.who === 'string' && WHO.test(by.who) ? { who: by.who } : {}),
});
/** A take read back: {seq, content, by: {name, guest?, who?}, at}, its number at most the hall's, or null. */
function storedTake(t, top) {
  if (!isRecord(t) || !whole(t.seq) || t.seq > top || !Number.isFinite(t.at) || !isRecord(t.by) || typeof t.by.name !== 'string') return null;
  const content = storedPage(t.content);
  return content ? { seq: t.seq, content, by: byOf(t.by), at: t.at } : null;
}
/** An answer read back: {seq, state, at}, or null. */
function storedAnswer(a, top) {
  return isRecord(a) && whole(a.seq) && a.seq <= top && ANSWERS.includes(a.state) && Number.isFinite(a.at) ? { seq: a.seq, state: a.state, at: a.at } : null;
}
/** Each layer of `o` read by `read`, the layers that read whole kept, or null when none did. */
function layersOf(o, read) {
  if (!isRecord(o)) return null;
  const out = {};
  for (const layer of LAYERS) { const r = read(own(o, layer)); if (r) out[layer] = r; }
  return Object.keys(out).length ? out : null;
}
/**
 * A hall's book read back: its counter, the Board's takes, each person's takes and answers; null when it is no book.
 * (A book numbers its own takes: it is no room's, and its counter is no room's change number.)
 */
function storedHall(book) {
  if (!isRecord(book) || !whole(book.seq, 0)) return null;
  const take = (t) => storedTake(t, book.seq);
  const answer = (a) => storedAnswer(a, book.seq);
  const keyed = (o, read) => {
    const out = {};
    if (isRecord(o)) for (const [k, v] of Object.entries(o)) { const r = PERSON.test(k) ? layersOf(v, read) : null; if (r) out[k] = r; }
    return out;
  };
  return { seq: book.seq, board: layersOf(book.board, take) || {}, people: keyed(book.people, take), answers: keyed(book.answers, answer) };
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
  constructor(file, { seal = () => '', open = () => '' } = {}) {
    this.seal = seal;
    this.open = open;
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
   * A take: `content` as cleanPage made it, to `'board'` or a person's key, numbered next in its hall. A Board take puts
   * away the older takes and answers, in its layer, of everyone seated On stage now (`onStage`, their keys): a Board page
   * shows the highest-numbered take, so none of theirs could show there again. A person's take puts away that person's
   * answer to an older one. A web page's address is kept sealed (`_kept`); `by.guest` marks a code guest's take. Returns
   * the take, or null when a part is not one the store keeps (a web page this run cannot seal among them).
   */
  take(hall, to, content, by = {}, { onStage = [], at = Date.now() } = {}) {
    const clean = storedPage(this._kept(content));
    if (!HALL.test(guard.str(hall)) || !(to === 'board' || PERSON.test(guard.str(to))) || !clean || !Number.isFinite(at)) return null;
    const layer = layerOf(clean.kind);
    const book = this.halls[hall] || (this.halls[hall] = { seq: 0, board: {}, people: {}, answers: {} });
    book.seq += 1;
    const t = { seq: book.seq, content: clean, by: byOf(by), at };
    if (to === 'board') {
      book.board[layer] = t;
      for (const k of Array.isArray(onStage) ? onStage : []) {
        if (typeof k !== 'string' || !PERSON.test(k)) continue;
        this._drop(book.people, k, layer);
        this._drop(book.answers, k, layer);
      }
    } else {
      book.people[to] = { ...(book.people[to] || {}), [layer]: t };
      this._drop(book.answers, to, layer);
    }
    this._trim(book);
    this.save();
    return t;
  }

  /**
   * A take as cleanPage made it, as the store keeps it: a web page's address sealed beside its host ({kind, host,
   * urlSealed}; null where this run cannot seal it), every other kind as it is.
   */
  _kept(content) {
    if (!isRecord(content) || content.kind !== 'web') return content;
    const w = webUrl(content.url);
    if (w.error) return null;
    let urlSealed;
    try { urlSealed = this.seal(w.url); } catch { return null; }   // this run has no machine key: nothing is kept in clear
    return { kind: 'web', host: w.host, urlSealed };
  }

  /**
   * A take's content as a page it is shown on is told it (and as its pusher may read it back): a web page's address
   * opened ({kind, url, host}, `url` '' where this machine cannot open it), every other kind as it is kept.
   */
  told(content) {
    if (!isRecord(content) || content.kind !== 'web') return content;
    return { kind: 'web', url: guard.str(this.open(content.urlSealed)), host: content.host };
  }

  /**
   * The web pages a code guest put up in a hall that stay up: the Board's take, and each person's not put away by them
   * (Back to chat), whether or not a page of theirs is open now (one that comes back is shown it again), each as {to:
   * 'board' or the person's key, seq}.
   */
  guestWeb(hall) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book) return [];
    const theirs = (t) => !!t && t.content.kind === 'web' && t.by.guest === true;
    const out = [];
    const board = own(book.board, 'show');
    if (theirs(board)) out.push({ to: 'board', seq: board.seq });
    for (const [key, r] of Object.entries(book.people)) {
      const t = own(r, 'show');
      const a = own(book.answers, key) && own(book.answers[key], 'show');
      if (theirs(t) && !(a && a.seq === t.seq && a.state === 'dismissed')) out.push({ to: key, seq: t.seq });
    }
    return out;
  }

  /**
   * The web pages guests put up in a hall that stay up, as the admin is told them once guests may no longer show any (the
   * switch turned off, or the hall unlocked): {up}, their count, and while there are any `upWords` ("1 web page a guest
   * showed is still up") and `takeDown`, the takes (Pages#guestWeb) the admin's Take it down hands back to chat.
   */
  guestWebLeft(hall) {
    const up = this.guestWeb(hall);
    const n = up.length;
    return n ? { up: n, upWords: n === 1 ? '1 web page a guest showed is still up' : n + ' web pages guests showed are still up', takeDown: up } : { up: 0 };
  }

  /**
   * The take a page is shown now in a layer, and the person's answer to it: the highest-numbered of the person's own and,
   * for a page seated On stage in Main (`board`), the Board's. The answer counts only when it answers that take.
   */
  current(hall, key, { board = false, layer = 'show' } = {}) {
    const book = HALL.test(guard.str(hall)) ? own(this.halls, hall) : undefined;
    if (!book || !LAYERS.includes(layer)) return { take: null, answer: null };
    const mine = (PERSON.test(guard.str(key)) && own(book.people, key) && own(book.people[key], layer)) || null;
    const group = (board === true && own(book.board, layer)) || null;
    const take = mine && group ? (mine.seq > group.seq ? mine : group) : mine || group;
    const a = take && own(book.answers, key) && own(book.answers[key], layer);
    return { take, answer: a && a.seq === take.seq ? a : null };
  }

  /**
   * One page says what it did with a take (its socket's id `sid`, its person's `key`, `board` when it sits On stage in
   * Main, at `at`): counted only for the take that page is shown now, never an older one, and only in a state a take of
   * its kind has. Back to chat and Minimise are the person's answer, kept with that take for all their pages. Back to
   * chat is final for it once AGAIN_MS have passed; until then the person's Show it again (`again`) takes it back, and a
   * card's Undo (`minimised`) makes it a Minimise again. A Minimise is taken back only by the person's Show again
   * (`again`, a `shown` report): a page that drew the take and says so (`shown`, as it first draws or comes back into
   * view) before it hears of the Minimise keeps it, so one device never undoes what the person did on another. Returns
   * {ok, answer}, the person's answer to that take as it now stands, and `hiddenMs` when this report ends a Board page's
   * time out of view with a take drawn on it; or {ok: false, error}; a report of no person, at no time, keeps nothing.
   */
  report(hall, sid, { key, board = false, seq, state, again = false, words = '', at = Date.now() } = {}) {
    if (!REPORTS.includes(state)) return { ok: false, error: 'A report is one of: ' + REPORTS.join(', ') + '.' };
    if (typeof sid !== 'string' || !sid) return { ok: false, error: 'No page to report for.' };
    if (!PERSON.test(guard.str(key)) || !Number.isFinite(at)) return { ok: false, error: 'No person to report for.' };
    const { take, answer } = this.current(hall, key, { board });
    if (!take || seq !== take.seq) return { ok: false, error: 'That is not what this page is shown now.' };
    const states = reportsOf(take.content.kind);
    if (!states.includes(state)) return { ok: false, error: 'A page shown ' + describePage(take.content) + ' reports one of: ' + states.join(', ') + '.' };
    const layer = layerOf(take.content.kind);
    const inView = inViewOf(take.content.kind);
    // Back to chat taken back: Show it again (in view, `again`) or a card's Undo (minimised), within AGAIN_MS of it.
    const undo = (state === inView && again === true) || state === 'minimised';
    if (answer && answer.state === 'dismissed' && state !== 'dismissed') {
      if (!undo) return { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' };
      if (at - answer.at > AGAIN_MS) return { ok: false, error: 'Back to chat was chosen for that one more than 10 s ago: a newer take shows again.' };
    }
    const book = this.halls[hall];
    let kept = answer;
    if (ANSWERS.includes(state) && !(answer && answer.state === state)) kept = this._answer(book, key, layer, { seq, state, at });
    else if (state === inView && again === true && answer) { this._drop(book.answers, key, layer); kept = null; }
    if (kept !== answer) { this._trim(book); this.save(); }
    // A Board page out of view (asleep, or another app in front) while a take is drawn on it: how long, from its first
    // such report to the report or the leave that ends it, a take that replaces another while it stays out of view
    // included (health's peaks, `pageHiddenMs`).
    const was = this._forget(sid);
    const out = state === 'hidden' && board === true && take.content.kind !== 'chat';
    const hiddenSince = out ? (was && was.hiddenSince) || at : 0;
    if (!this.live.has(hall)) this.live.set(hall, new Map());
    this.live.get(hall).set(sid, { key, seq, state, words: guard.cleanText(words, 160), at, hiddenSince });
    this.liveHall.set(sid, hall);
    const ended = !out && was && was.hiddenSince ? Math.max(0, at - was.hiddenSince) : -1;
    return { ok: true, answer: kept || null, ...(ended >= 0 ? { hiddenMs: ended } : {}) };
  }

  /**
   * A page went (its socket closed, or it moved to another room): its report goes with it. Returns the hall it reported
   * in and, when it was a Board page out of view while a take was drawn on it, for how long (`hiddenMs`); or null when it
   * had reported nothing.
   */
  left(sid, at = Date.now()) {
    const was = this._forget(sid);
    if (!was) return null;
    return { hall: was.hall, ...(was.hiddenSince && Number.isFinite(at) ? { hiddenMs: Math.max(0, at - was.hiddenSince) } : {}) };
  }

  /** A page's report taken out of the run's reports, with the hall it was in; null when it had none. */
  _forget(sid) {
    const hall = this.liveHall.get(sid);
    if (hall === undefined) return null;
    this.liveHall.delete(sid);
    const reports = this.live.get(hall);
    const r = reports.get(sid);
    reports.delete(sid);
    if (!reports.size) this.live.delete(hall);
    return { ...r, hall };
  }

  /**
   * Where one page stands on the take it is shown now ({sid, key, board}): {seq, state, words, at}, its state the
   * person's answer to that take, else the page's report on it, else `waiting`. A page's report of an answer (Back to
   * chat, Minimise) is the person's answer, and counts only while that answer stands: once taken back (Show it again),
   * the page is waiting until it says what it does with the take again.
   */
  pageState(hall, { sid, key, board = false } = {}) {
    const { take, answer } = this.current(hall, key, { board });
    const seq = take ? take.seq : 0;
    if (answer) return { seq, state: answer.state, words: '', at: answer.at };
    const r = this.live.has(hall) ? this.live.get(hall).get(sid) : undefined;
    if (r && r.key === key && r.seq === seq && !ANSWERS.includes(r.state)) return { seq, state: r.state, words: r.words, at: r.at };
    return { seq, state: 'waiting', words: '', at: 0 };
  }

  /**
   * A take's status over the pages that hold it (see Pages.status): `to` the Board ('board') or a person's key, `pages`
   * each open page of theirs ({sid, key, board, name}). The Board's take is the Board's; a person's is the newest take
   * any of their pages is shown now. A page shown another take is said to show something else.
   */
  status(hall, to, pages = [], { name = '', hallHolding = '' } = {}) {
    const list = Array.isArray(pages) ? pages : [];
    const states = list.map((p) => ({ ...this.pageState(hall, p), name: p.name }));
    let take = null;
    if (to === 'board') take = this.current(hall, '', { board: true }).take;
    else for (const p of list) { const t = this.current(hall, p.key, { board: p.board }).take; if (t && (!take || t.seq > take.seq)) take = t; }
    const seq = take ? take.seq : 0;
    return Pages.status(take, states.map((s) => (s.seq === seq ? s : { ...s, state: 'other' })), { board: to === 'board', name, hallHolding });
  }

  /**
   * A take's status (pure): `take` the one the target was given, `pages` each of the target's open pages with its state
   * on it (`waiting`, a report's or an answer's state, or `other`: shown another take) and its person's `name`. One mark,
   * one meaning, never colour alone, and the words person first: ✕ no page open; △ a page could not show it; ◷ sending,
   * until every page has said; ○ every page went back to chat, or every page handed back to its chat by a `chat` take
   * said it is there (back to chat is never "on screen"); ▭ every page minimised it; ◇ opened (a web page, which cannot
   * be seen into); ✓ on every page; else ◐, how many show it (or, for a `chat` take, are back to chat) and why the rest
   * do not. With them, what it shows (`showing`, in words, and its `kind`), and of its `pages` how many show it now (`on`).
   */
  static status(take, pages, { board = false, name = '', hallHolding = '', clock = clockOf } = {}) {
    const list = Array.isArray(pages) ? pages : [];
    const n = list.length;
    // `kind`, what it shows ('' for nothing), and `on`, how many of its pages show it now (a hand-back: are back on chat).
    const on = take ? list.filter((p) => p.state === 'shown' || p.state === 'opened').length : 0;
    const out = (mark, words) => ({ seq: take ? take.seq : 0, showing: describePage(take && take.content, { hallHolding }), kind: take && isRecord(take.content) ? take.content.kind : '', mark, words, pages: n, on });
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
    const opened = of('opened').length;
    const showing = of('shown').length + opened;
    const chat = isRecord(take.content) && take.content.kind === 'chat';
    if (showing === n) {
      if (opened) return out(MARKS.unseen, 'Opened · AGMessage can\'t see inside web pages');
      const whose = name ? name + '\'s' : 'their';
      const where = board ? (n === 1 ? 'the 1 Board page' : 'all ' + n + ' Board pages') : n === 1 ? whose + ' page' : 'all ' + n + ' of ' + whose + ' pages';
      return chat ? out(MARKS.off, 'Back to chat on ' + where) : out(MARKS.ok, 'On ' + where);
    }
    const why = [];
    const hidden = of('hidden').length;
    if (hidden) why.push(hidden + ' asleep or in another app');
    if (dismissed.length) why.push(namesWords(dismissed.map((p) => p.name)) + ' went back to chat');
    if (minimised.length) why.push(namesWords(minimised.map((p) => p.name)) + ' minimised it');
    const other = of('other').length;
    if (other) why.push(other + ' showing something else');
    return out(MARKS.partly, showing + ' of ' + n + (chat ? ' back to chat · ' : ' showing · ') + why.join(' · '));
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

  /** A hall closed: everything its people's pages were shown goes with it. True when it held any. */
  forgetHall(hall) {
    if (!HALL.test(guard.str(hall))) return false;
    const reports = this.live.get(hall);
    if (reports) { for (const sid of reports.keys()) this.liveHall.delete(sid); this.live.delete(hall); }
    if (!Object.hasOwn(this.halls, hall)) return false;
    delete this.halls[hall];
    this.save();
    return true;
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
  _trim(book) {
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
  }

  /** The guests' views held to their bound: the one set longest ago goes first. */
  _trimViews() {
    for (const k of this.views.keys()) {
      if (this.views.size <= BOUNDS.views) return;
      this.views.delete(k);
    }
  }
}

module.exports = { Pages, cleanPage, describePage, webUrl, personKey, layerOf, reportsOf, inViewOf, KINDS, LAYERS, IMAGE_EXT, STAGE_TYPES, TRANSFER_ONLY, REPORTS, ANSWERS, AGAIN_MS, VIEWS, MARKS, BOUNDS, WEB_MAX };
