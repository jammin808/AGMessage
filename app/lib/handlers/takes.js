'use strict';
/**
 * The verbs of takes on people's pages: a push to a person's page or to everyone On stage, what a page reports it shows,
 * the admin's read of it, and the views, clock and On stage settings the admin sets for a person. They are registered by
 * the connection (server.js), after its own verbs, on every page's socket but a screen's: the admin's verbs among them
 * are sent from the admin page.
 *
 * A take reaches a page and nothing else: never a room, a room's op or a room's broadcast. So this module is given the
 * takes context, which holds none of the server's parts that make a room, a room's op or send to a room (`io`, `apply`,
 * `systemMessage`, `newSideRoom`, `renameRoom`: lib/gate.js `ROOM_SENDS`), and reaches a page through
 * `ctx.sendTo(socketIds, event, payload)`, which sends only to a socket open now named by its id (a hall's key given as
 * one reaches nobody). It names none of the server's broadcast paths nor the socket's own, joins its socket to no room,
 * reads the room store only through its readers (its `room`, `hasRoom`, `get`, …) and never takes the store or the
 * socket under another name (test/modules.test.js (j)).
 *
 * Each verb is a literal listener on `socket` whose first statement is its one gate call,
 * `if (!conn.gate(ack, {…})) return;` (lib/gate.js), its `ack` the listener's own last argument, naming one of the
 * connection's buckets or saying `bucket: null` with why on its line ((i)). Of the connection it reads `conn` (its room
 * and person read when asked, its answers, its rights' questions: never `rbac.can`); of the server, `ctx`, once,
 * destructured on the function's first line, `settings` to read and never to write ((j)). It requires only the pure
 * core, guard's pure helpers, ids and the pages' pure vocabulary (`lib/pages.js` by name), by a literal path, and makes
 * nothing it requires ((d)).
 *
 * A take (plan 1-§5.2, §5.3): `page:push {code, to, content, cid}` puts `content` (lib/pages.js cleanPage: back to the
 * chat, Stagewatch, the clock, holding or blank) on the hall's Board (`to: 'board'`: every page seated On stage in its
 * Main room, now and as each joins, a Board account's included) or on one person's pages (`to: {uid}`, a person's key as
 * `page:status` lists them: every page of theirs in the hall's rooms, and the admin's support view of them). Who may
 * push is the connection's `canPush` (plan 1-§2.6): the admin, an account with display.control in the hall, or a code
 * guest seated backstage in its Main room while its seats are locked; never an On stage page or the support view. A key
 * that is no hall's is refused in the words a hall the asker may not push in would get (the admin, who sees every hall,
 * is told there is none), so neither verb says whether a code is real. Each
 * page whose take changed (the take's own targets, and a person's pages elsewhere in the hall that a Board take puts
 * their own take away from) is sent `page:take` by its socket's id; one `page.push` row is written per target, naming
 * what it shows in a few words (lib/pages.js describePage), never a file. The answer is "sending", never "on screen":
 * each page says what it did with the take (`page:report`), and only those reports make the status (lib/pages.js
 * `Pages.status`), which a console reads (`page:status`) whenever it is told the hall's pages changed (`pages:changed`).
 * Two layers (plan 4-§5.9.1): the show (Stagewatch, the clock, holding, blank) and information drawn over it (a web page
 * now); `chat` hands back both, `{chat, layer: 'info'}` the information alone (Take down). Who may push which kind to
 * whom, over what is up there now, is lib/pages.js `canShow` (pure): the operator (canPush) every kind, an account's
 * information with stage.show; and an account seated backstage in a room of the hall (a side room on the Main room's
 * list) by a right of its own (`conn.canShow`): information alone, to the people On stage alone, never over what the
 * operator put up, on the target's take or on any page of theirs (refused `over`; taken `side`, kept beside the
 * operator's, replacing nothing), and a take-down only of what such a seat put up, by the take it names (over the show,
 * or beside it). Such a page reads the console too, the people On stage alone.
 * A web page (`web`, an https address its target's page frames) needs a right of its own beside canPush, stage.web
 * (conn.canWeb: an account's by its rights in the hall, a code guest's only while the admin lets the hall's backstage
 * guests show web pages); refused without it in words that say which, before its address is read. Its address goes to
 * the pages it is shown on, and back to the one who put it up: the answer, the console's status and the row name its host.
 * A push asked again with its client id (the outbox sends one again after a drop) is answered with what the first did.
 * The answer gives back what the target was shown before (`previous`), which the pusher's Undo of a show take puts up again
 * as a take of its own (information is taken down, never put back: an Undo could pop up again what the Board had closed),
 * and only as this pusher could show it itself: a picture shared in a room it may not read comes back as no
 * content (a file's path is its capability), so that take is never handed to it nor put back by it; a web page comes back
 * only to whoever put it up (the take keeps its pusher, `by.who`) and to the admin, so a pusher never reads another's
 * address (a query's token among it). A push that names the take it goes over (`ifSeq`: the Board chip's ↶ Back to) is
 * refused once anything newer is up, so it never undoes someone else's later take. The admin's take-down of a person's
 * take (back to chat over it, by its number) is taken with no page of theirs open: what a guest put up for them would
 * otherwise show again when they come back (lib/pages.js Pages#guestWeb counts it).
 *
 * A chat view (plan 1-§6): `admin:setView {roomCode, socketId, view}`, the admin's, sets the view a person's pages draw
 * (By seat, Simple or Full), kept for a guest by their uid and for an account on it, and tells their pages by the
 * server's named effect (`viewChanged`), which reaches each page of theirs by its socket alone.
 */
const { str } = require('../guard');
const { cleanPage, askedOf, canShow, describePage, personKey, layerOf, ARRIVALS } = require('../pages');
const { mayChange } = require('../rbac');

/** What the admin's support view is told of an act: it shows the person's page, and acts on nothing (as its doors say). */
const SUPPORT = 'This is someone else\'s view — act from your own page.';
/** What an On stage page is told of a push: its seat holds messages only (rbac.SEAT_LIMITS). */
const BACKSTAGE = 'Do that from a backstage page.';
/** What an account without display.control in the hall is told. */
const NO_RIGHT = 'Your account may not change what people\'s pages show in this hall.';
/**
 * What an account that would show information on the Board's pages by a right of its own is told from a side room that
 * is not on the Main room's list (who may not post into Main's chat draws over no Board tablet either).
 */
const OFF_LIST = 'This room may not send to the Main room\'s Board — ask an admin.';
/** What a code guest seated backstage in an open hall's Main room is told: anyone with the code may sit there. */
const OPEN_HALL = 'In an open hall, showing the Board needs an invite link or an account — ask the admin.';
/** What an account that may change what people's pages show, but not show a web page there, is told (stage.web). */
const NO_WEB = 'Web pages on the stage need their own right — ask an admin.';
/** What a code guest seated backstage in a locked hall is told while the admin has its guests' web pages off (S4). */
const GUESTS_WEB_OFF = 'Web pages from backstage guests are off in this hall — ask the admin.';
/** What any other code guest is told: an observer, a Member of a side room, or a page of another hall. */
const BACKSTAGE_TEAM = 'Showing the Board is for the backstage team.';
/** What the admin, who sees every hall, is told of a key that is none. Anyone else is told what a hall they may not push in tells them. */
const NO_HALL = 'No such hall.';
/** A person named who has no page open in a room of the hall the pusher may read (it hides who sits in the others). */
const NOT_HERE = 'That person is not in this hall now.';
/** Whom the audit row names for the admin's take-down of a person's take with no page of theirs open. */
const AWAY = 'a person with no page open';
const TARGETS = 'Show the Board (to: \'board\') or one person (to: {uid}).';
/** A take the store would not keep (a part of it it does not read back): nothing was shown or numbered. */
const NOT_KEPT = 'That could not be kept: nothing was shown.';
/** A web page the store could not keep: its address is kept only sealed, with the machine key this run has not. */
const WEB_NOT_KEPT = 'A web page\'s address is kept sealed with this laptop\'s key, which this run has not: nothing was shown.';
/** A push asked for over a take (`ifSeq`, ↶ Back to) that is no longer what its target is shown: nothing changed. */
const NEWER = 'Something newer is showing there now: nothing changed.';
const IF_SEQ = 'That act\'s take could not be read.';
/** An arrival that is none, or the show (or a hand-back) asked to arrive in the side bar: only information arrives there. */
const ARRIVE_WORDS = 'Information arrives over their chat or in their side bar.';
const SHOW_OVER = 'The show is drawn over the chat: only information arrives in the side bar.';
/** What the support view is told of a report: it shows a person's page, and says nothing for it. */
const SUPPORT_REPORTS = 'This is someone else\'s view: it reports nothing.';
const NOT_SEATED = 'This page is not seated here: it reports nothing.';
/** A chat view the admin sets: '' by the person's seat (On stage simple, elsewhere full), or one for them alone. */
const VIEWS = Object.freeze(['', 'simple', 'full']);
/** Each view in an audit row's words, as the Accounts page's rows say it (lib/http-accounts.js). */
const VIEW_SAID = Object.freeze({ '': 'by seat', simple: 'simple', full: 'full' });
const VIEW_WORDS = 'Choose By seat, Simple or Full.';
/** The person a chat view is set for has no page in that room now (or the room is gone). */
const NOT_IN_ROOM = 'That person is not in this room now.';
/** A client id as a page makes one (public/outbox.js), as a send's is read (server.js `CID_RE`). */
const CID = /^[A-Za-z0-9_-]{1,40}$/;
/**
 * The answers of the pushes made lately in each hall, by the hall's key, who asked and the client id their page gave the
 * act, so a `page:push` sent again with its id is answered with what the first did, never made a second take. The
 * newest PUSHED_KEEP a hall, the oldest let go, and only for halls still here (a hall's book goes at the next push once
 * the hall is gone), in memory: after a restart a repeat is a new take of the same content, which latest wins makes
 * harmless.
 */
const PUSHED_KEEP = 200;
const pushed = new Map();

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A key a client named, as the store keys rooms: upper case, or '' for anything that is no string. */
const keyOf = (v) => str(v).toUpperCase();
/** "6 pages", "1 page": a count of pages, never who. */
const pagesWords = (n) => n + ' page' + (n === 1 ? '' : 's');

/**
 * @param {object} socket a page's socket (never a screen's), its listeners guarded (server.js `guardHandlers`)
 * @param {object} conn   the connection's context, frozen
 * @param {object} ctx    the takes context, frozen: none of lib/gate.js `ROOM_SENDS` (`contexts`)
 */
function register(socket, conn, ctx) {
  const { store, audit, accounts, linkFor, sendersOf, pages, hallPages, takeSends, holdingOf, pagesChanged, pageHidden, selfHosts, viewChanged, sendTo } = ctx;

  const write = (action, target, words) => audit.write(conn.actor(), action, target, words, socket.data.ip);
  /**
   * Why this page may not push in `hall`, in the words of who it is (conn.canPush said no), or why a key it named is
   * none (`hall` null): the same words for both, so neither verb tells anyone but the admin, who sees every hall,
   * whether a key is a hall's (a hall's key is its guest code until New code, a guest's credential). A guest's own
   * hall, whose code it holds, is the one it is told it may not push in for being open.
   */
  const whyNot = (hall) => {
    if (!hall && socket.data.isAdmin) return NO_HALL;
    if (socket.data.adminView) return SUPPORT;
    if (conn.onStage()) return BACKSTAGE;
    const me = conn.me();
    if (socket.data.account) {
      const here = conn.room();
      const shows = !!hall && !!here && here.hall === hall.code && here !== hall && !!me && me.role === 'research' && (conn.canIn('stage.show', hall) || conn.canIn('stage.web', hall));
      return shows ? OFF_LIST : NO_RIGHT;
    }
    return !!hall && conn.room() === hall && me && me.role === 'research' ? OPEN_HALL : BACKSTAGE_TEAM;
  };
  /**
   * The hall a page asks of by its key, or by the guest code it joined its Main room with (a guest's page knows its room
   * by that code alone once New code parted it from the key), when it may push there (canPush) or show information on its
   * Board's pages (canShow); else null, with why answered (whyNot).
   */
  const pushHall = (code, answer) => {
    const hall = store.get(code) || joinedHall(code);
    if (hall && (conn.canPush(hall) || conn.canShow(hall))) return hall;
    answer({ ok: false, error: whyNot(hall) });
    return null;
  };
  /**
   * The Main room this page sits in, where the code it names is the guest code it joined with; else null. A comparison
   * with the socket's own data, never a lookup of what it names, so a repeat's book is found by it before the rate.
   */
  const joinedHall = (code) => {
    const own = conn.room();
    return !!code && code === socket.data.joinedAs && !!own && store.isMain(own) ? own : null;
  };
  /**
   * The Board's pages as the asker's answer names them: by their people's names for one who may read the hall's Main
   * room, where they sit; else nameless, so a status says "Someone went back to chat" and never who sits On stage in a
   * room the asker cannot read.
   */
  const boardOf = (hall, seated, rooms) => {
    const board = seated.filter((p) => p.board);
    return rooms.includes(hall) ? board : board.map((p) => ({ ...p, name: '' }));
  };
  /**
   * The rooms of a hall this page may read: the admin every one, an account each its rights there let it see, and a code
   * guest the one it sits in. A holding picture is one shared in them, and the people a push names or a console lists
   * sit in them, so a push never says who sits in a room its pusher cannot read.
   */
  const readable = (hall) => store.roomsOf(hall.code).filter((r) => conn.canIn('hall.view', r) || r === conn.room());
  /** Who a take says put it up: the name this page sits under, else the account's, else the actor's (the laptop). */
  const byName = () => { const me = conn.me(); const a = socket.data.account; return me ? me.name : a ? a.name || a.username : conn.actor().name; };
  /**
   * Whether this page may show a web page in `hall` (which it may push or show in): true, or why not, in the words of who
   * it is: a code guest's hall has its guests' web pages off; anyone else lacks the right.
   */
  const webOf = (hall) => conn.canWeb(hall) || (conn.actor().t === 'code' ? GUESTS_WEB_OFF : NO_WEB);
  /**
   * The facts canShow reads (lib/pages.js) for this page in `hall`: whether it is the operator (canPush), who it is, its
   * rights there, where it sits, and the target's information take now (`current`, with whether the operator put it up).
   */
  const showFacts = (hall, current, ifSeq) => {
    const here = conn.room();
    const me = conn.me();
    return {
      canPush: conn.canPush(hall), account: !!socket.data.account, admin: !!socket.data.isAdmin,
      show: conn.canIn('stage.show', hall), web: webOf(hall), seat: me && !socket.data.adminView ? me.role : '', inHall: !!here && here.hall === hall.code,
      post: !!here && conn.canIn('hall.post', here), files: !!here && conn.canIn('hall.files', here),
      listed: !!here && (here === hall || sendersOf(hall.code).includes(here.code)), notPush: whyNot(hall),
      current: current ? { seq: current.seq, op: current.by.op === true, kind: current.content.kind, name: current.by.name } : null,
      ...(Number.isInteger(ifSeq) ? { ifSeq } : {}),
    };
  };
  /** Each page whose take moved told what it is shown now, by its socket's id: never a room, never a broadcast. */
  const tell = (hall, before) => { for (const s of takeSends(hall, before)) sendTo([s.sid], 'page:take', s.take); };

  // A take on the Board's pages or one person's (plan 1-§5.3, 4-§5.9): the repeat of a push its client id names is
  // answered with what the first did, before the rate; then the rate, then the hall and who may push or show there (one
  // answer for both), whom it is for, what it asks to show and how it arrives, then who may push that kind to them over
  // what is there now (lib/pages.js canShow: the operator's information stays up, a researcher's goes to the side bar),
  // then what is shown, made safe. The store numbers it in its layers (a Board take puts away the older takes and
  // answers, in its places, of those seated On stage now; an information take put away so joins Earlier; a researcher's
  // side-bar push over the operator's information is kept beside it), each page it moved is told, one row per target,
  // the consoles are told, and the answer is "sending", read from the place it went to.
  socket.on('page:push', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: null })) return;   // a repeat is answered as done before the rate: the token is taken below, before any lookup of the hall
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const cid = a.cid === undefined || a.cid === null ? null : a.cid;
    if (cid !== null && !(typeof cid === 'string' && CID.test(cid))) return answer({ ok: false, error: 'That act\'s id could not be read.' });
    // Whose acts the repeats are kept by: the account, the admin's token, or the code guest seated here; a socket that is
    // none of them has pushed nothing, so nothing of anyone's is read back for it.
    const who = socket.data.actor || conn.me() ? conn.actor() : null;
    const whoKey = who ? who.t + ':' + who.id : '';
    const asked = cid === null || !who ? '' : whoKey + '|' + cid;
    const code = keyOf(a.code);
    // The book is the hall's, by its key: a guest's page that names its hall by the code it joined with reads its own.
    const own = joinedHall(code);
    const bookKey = own ? own.code : code;
    const kept = asked && pushed.has(bookKey) ? pushed.get(bookKey).get(asked) : undefined;
    if (kept) return answer(kept);
    if (!conn.writes.take()) return conn.limited(ack);
    const hall = pushHall(code, answer);
    if (!hall) return;
    // The Board, by its word alone, or one person by their key ({uid}: `a:<account id>`, `u:<uid>`), never one for the other.
    const board = a.to === 'board';
    const person = !board && isRecord(a.to) ? str(a.to.uid) : '';
    if (!board && !person) return answer({ ok: false, error: TARGETS });
    // What it asks to show (its kind, and a hand-back's layer), read before anything else of it; then its layer: the show,
    // the information, or both (a hand-back of both); and how an information take arrives (over their chat by default).
    const want = askedOf(a.content);
    if (!want) return answer({ ok: false, error: cleanPage(a.content).error });
    const layer = want.kind === 'chat' ? (want.layer === 'info' ? 'info' : 'both') : layerOf(want.kind);
    const arrive = a.arrive === undefined || a.arrive === null ? 'over' : a.arrive;
    if (!ARRIVALS.includes(arrive)) return answer({ ok: false, error: ARRIVE_WORDS });
    if (arrive === 'side' && (layer !== 'info' || want.kind === 'chat')) return answer({ ok: false, error: SHOW_OVER });
    if (a.ifSeq !== undefined && a.ifSeq !== null && (!Number.isInteger(a.ifSeq) || a.ifSeq < 0)) return answer({ ok: false, error: IF_SEQ });
    const rooms = readable(hall);
    const before = hallPages(hall.code);
    const seated = before.filter((p) => !p.support);
    // Whom it is for: the Board's pages, or the person's pages in the rooms this page may read (one of theirs open there).
    const target = board ? boardOf(hall, seated, rooms) : seated.filter((p) => p.key === person && rooms.includes(p.room));
    // A person with no page open is the admin's to take a take down from alone (a hand-back over their own take, named by
    // its number, which is read below as any `ifSeq` is): the admin reads every room, and the take is the store's, so
    // nothing names who sits where.
    const away = !board && !target.length && socket.data.isAdmin && want.kind === 'chat' && Number.isInteger(a.ifSeq);
    if (!board && !target.length && !away) return answer({ ok: false, error: NOT_HERE });
    const to = board ? 'board' : person;
    const name = board ? 'the Board' : target.length ? target[0].name : '';
    // What the target is shown now in a place (the show, the information over it, beside it): the Board's own take, or the
    // newest of the person's pages' (the store's, with no page of theirs open).
    const wasIn = (l) => (board ? pages.current(hall.code, '', { board: true, layer: l }).take
      : !target.length ? pages.current(hall.code, person, { layer: l }).take
      : target.reduce((t, p) => { const c = (l === 'info' ? p.info : l === 'beside' ? p.beside : p.current).take; return c && (!t || c.seq > t.seq) ? c : t; }, null));
    const info = wasIn('info');
    const beside = wasIn('beside');
    // A Take down (the information handed back alone, over the take it names) hands back that take: over the show, or
    // beside it.
    const takeDown = want.kind === 'chat' && layer === 'info' && Number.isInteger(a.ifSeq);
    const named = !takeDown ? '' : beside && beside.seq === a.ifSeq ? 'beside' : 'info';
    const was = named === 'beside' ? beside : wasIn(layer === 'info' ? 'info' : 'show');
    // The operator's information drawn on one of the Board's pages in place of the Board's own (a person On stage shown one
    // of their own): a researcher's push over the Board, or its Take down, would put it away there.
    const opOf = (t) => !!t && t.by.op === true && t.content.kind !== 'chat';
    const opOn = board && !opOf(info) ? target.map((p) => p.info.take).find(opOf) || null : null;
    // Who may push this kind to them over what is up there now: the operator (canPush) as before; a researcher by a right
    // of its own (canShow), never over the operator's information (its side bar instead), and taking down only its own.
    const may = canShow({ ...showFacts(hall, named === 'beside' ? beside : info, a.ifSeq), ...(opOn && named !== 'beside' ? { opOn: { kind: opOn.content.kind } } : {}) }, want, board ? 'board' : { onStage: target.some((p) => p.board) }, arrive);
    if (may !== true) return answer({ ok: false, error: may });
    // A push that names the take it goes over (`ifSeq`: ↶ Back to, a Take down) is refused once anything newer is up in its
    // place (a hand-back of both, in any; of the information, over the show or beside it), so it never undoes someone
    // else's later take.
    if (a.ifSeq !== undefined && a.ifSeq !== null) {
      const up = (layer === 'both' ? [was, info, beside] : layer === 'info' ? [info, beside] : [was]).filter(Boolean);
      if (!(up.length ? up : [null]).some((t) => (t ? t.seq : 0) === a.ifSeq)) return answer({ ok: false, error: NEWER });
    }
    const facts = {
      stagewatch: !!linkFor(hall.code).base,
      readable: (url) => rooms.some((r) => r.messages.some((m) => m.type === 'file' && m.url === url)),
      web: webOf(hall),
      selfHosts: selfHosts(),
    };
    const content = cleanPage(a.content, facts);
    if (content.error) return answer({ ok: false, error: content.error });
    const onStage = [...new Set(seated.filter((p) => p.board).map((p) => p.key))];
    // The operator's information (canPush) stays up: a researcher's side-bar push over it is kept beside it, superseding
    // nothing over the show.
    const op = conn.canPush(hall);
    const aside = layer === 'info' && want.kind !== 'chat' && arrive === 'side' && !op && (opOf(info) || !!opOn);
    // A code guest's take is kept as one (`guest`): the web pages guests put up are counted when the admin turns them off.
    // A web page keeps who put it up (`who`): a later push's answer gives its address back to them alone, and the admin.
    // An information take keeps whether its pusher held canPush (`op`).
    const by = { name: byName(), guest: conn.actor().t === 'code', ...(layer !== 'show' && op ? { op: true } : {}), ...(content.kind === 'web' && whoKey ? { who: whoKey } : {}) };
    const take = pages.take(hall.code, to, content, by, { onStage, arrive, aside, slot: named });
    if (!take) return answer({ ok: false, error: content.kind === 'web' ? WEB_NOT_KEPT : NOT_KEPT });
    tell(hall.code, before);
    const holding = holdingOf(hall.code);
    // In the audit's voice: whom, how many of the Board's pages it reached, what it shows in a few words (never a file),
    // and an arrival in the side bar.
    const side = take.arrive === 'side' ? ', in their side bar' + (aside ? ', beside the operator\'s' : '') : named === 'beside' ? ', from their side bar' : '';
    write('page.push', hall.code, (board ? 'the Board (' + pagesWords(target.length) + ')' : name || AWAY) + ' → ' + describePage(take.content, { hallHolding: holding }) + side);
    pagesChanged(hall.code);
    // The status of the place it went to: beside the operator's, over the show, or the show.
    const status = pages.status(hall.code, to, target, { name: board ? '' : name, hallHolding: holding, layer: aside || named === 'beside' ? 'beside' : layer === 'info' ? 'info' : 'show' });
    // A web page's address comes back to whoever put it up and to the admin alone: to any other pusher, no content.
    const back = was && (was.content.kind !== 'web' || conn.theAdmin() || (!!whoKey && was.by.who === whoKey)) ? cleanPage(pages.told(was.content), facts) : null;
    const res = {
      ok: true, seq: take.seq, ...(take.arrive === 'side' ? { arrive: 'side' } : {}), ...(aside ? { aside: true } : {}),
      results: [{ key: to, name, ok: true, status }], previous: was && !aside ? { seq: was.seq, content: !back || back.error ? null : back } : null,
    };
    if (asked) {
      for (const k of pushed.keys()) if (!store.get(k)) pushed.delete(k);
      if (!pushed.has(hall.code)) pushed.set(hall.code, new Map());
      const book = pushed.get(hall.code);
      book.set(asked, res);
      if (book.size > PUSHED_KEEP) book.delete(book.keys().next().value);
    }
    answer(res);
  });

  // What a page did with the take it is shown now (plan 1-§5.3, §5.4): `{seq, state, words, again}`, counted only for
  // that take, never an older one (lib/pages.js report). Back to chat and Minimise are the person's answer, for every page
  // of theirs: each of their pages is told it, and so is a Show again that takes a Minimise back. A Board page out of
  // view while a take is drawn on it says for how long once it is back (the day's peaks). The support view, and a page
  // seated nowhere, report nothing.
  socket.on('page:report', (args, ack) => {
    if (!conn.gate(ack, { bucket: conn.chatter })) return;
    const answer = conn.ok(ack);
    if (socket.data.adminView) return answer({ ok: false, error: SUPPORT_REPORTS });
    const hall = conn.room().hall;
    const a = isRecord(args) ? args : {};
    const before = hallPages(hall);
    const mine = before.find((p) => p.sid === socket.id && !p.support);
    if (!mine) return answer({ ok: false, error: NOT_SEATED });
    const r = pages.report(hall, socket.id, {
      key: mine.key, board: mine.board, seq: Number.isInteger(a.seq) ? a.seq : 0, state: str(a.state), again: a.again === true, words: str(a.words),
    });
    // A person's act refused (Back to chat, Minimise, Show again, a card's Undo): the page acted at once on its own screen
    // (it draws before it reports), so it is told again what it is shown now, back in step with every page of its person.
    // A page's routine word of what it drew, refused, is told nothing: the take it is behind is on its way to it.
    if (!r.ok) {
      const acted = a.state === 'dismissed' || a.state === 'minimised' || (a.state === 'shown' && a.again === true);
      if (acted) for (const s of takeSends(hall, [{ sid: socket.id, seq: -1, answer: null }])) sendTo([s.sid], 'page:take', s.take);
      return answer({ ok: false, error: r.error });
    }
    if (r.hiddenMs !== undefined) pageHidden(r.hiddenMs);
    tell(hall, before);
    pagesChanged(hall);
    answer({ ok: true });
  });

  // Where a hall's people's pages stand (plan 1-§5.3, 4-§5.9.1): the Board's take in each layer, read from each Board
  // page's report (its people named only to one who may read the Main room), and each person seated in a room of the hall
  // this page may read, with theirs: the show take's status, and the information over it (`info`, with how it arrived and
  // whether the operator put it up). A read, for whoever may push (canPush) or show (canShow) there, refused in the same
  // words for a key that is no hall's. One who may only show is told the people seated On stage alone, whom it may show,
  // and a web take by its host, as everyone is.
  socket.on('page:status', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.chatter })) return;
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const hall = pushHall(keyOf(a.code), answer);
    if (!hall) return;
    const holding = holdingOf(hall.code);
    const rooms = readable(hall);
    const onlyShows = !conn.canPush(hall);
    const seated = hallPages(hall.code).filter((p) => !p.support);
    const people = new Map();
    for (const p of seated) {
      if (!rooms.includes(p.room) || (onlyShows && !p.board)) continue;
      if (!people.has(p.key)) people.set(p.key, { key: p.key, name: p.name, room: store.isMain(p.room) ? 'Main' : p.room.name || '', list: [] });
      people.get(p.key).list.push(p);
    }
    // Each target's show take, the information over it (`info`) and, while one is there, the information beside it
    // (`beside`, in their side bar beside the operator's).
    const both = (to, list, o) => {
      const beside = pages.status(hall.code, to, list, { ...o, layer: 'beside' });
      return { ...pages.status(hall.code, to, list, o), info: pages.status(hall.code, to, list, { ...o, layer: 'info' }), ...(beside.seq ? { beside } : {}) };
    };
    answer({
      ok: true,
      board: both('board', boardOf(hall, seated, rooms), { hallHolding: holding }),
      people: Array.from(people.values(), (x) => ({ uid: x.key, name: x.name, room: x.room, ...both(x.key, x.list, { name: x.name, hallHolding: holding }) })),
      // Whether this asker's information pushes and Take downs hold stage.show (the admin's and a code guest's always; an
      // account's by its right in the hall): its console greys what the server would refuse.
      show: !socket.data.account || !!socket.data.isAdmin || conn.canIn('stage.show', hall),
    });
  });

  // The admin's choice of a person's chat view (plan 1-§6, "How it is changed"): By seat (''), Simple or Full, for the
  // person seated on `socketId` in the room `roomCode` names, from the admin page's people rows or the hall page's People
  // panel. A guest's is kept by their uid (pages.json), an account's on the account (accounts.json), as the Accounts page
  // sets it: an account reached from an account's page only where the Accounts page would let that account change it.
  // Every page of the person's, and the admin's view of them, is told the view to draw now (`view`), live, nothing
  // closed; the admin's people rows (and theirs alone) are drawn again; one row says it. A view is no right: no check
  // reads it.
  socket.on('admin:setView', (args, ack) => {
    if (!conn.gate(ack, { joined: false, bucket: conn.writes, admin: true })) return;
    const answer = conn.ok(ack);
    const a = isRecord(args) ? args : {};
    const view = a.view === null ? '' : a.view;
    if (typeof view !== 'string' || !VIEWS.includes(view)) return answer({ ok: false, error: VIEW_WORDS });
    // The room by its key; a page that names its own room by the code it joined with (the token's page) means its own.
    const own = conn.room();
    const room = own && keyOf(a.roomCode) === keyOf(socket.data.joinedAs) ? own : store.room(keyOf(a.roomCode));
    const target = room ? room.users.get(str(a.socketId)) : undefined;
    if (!target) return answer({ ok: false, error: NOT_IN_ROOM });
    const key = personKey(target.uid, !!target.acct);
    if (!key) return answer({ ok: false, error: NOT_IN_ROOM });
    const said = VIEW_SAID[view];
    if (target.acct) {
      const account = accounts.get(target.uid);
      if (!account) return answer({ ok: false, error: NOT_IN_ROOM });
      const actor = socket.data.account;
      const refusal = actor ? mayChange(actor, account, { view }, { activeAdmins: accounts.activeAdmins() }) : null;
      if (refusal) return answer({ ok: false, error: refusal });
      if (!accounts.update(account.id, { view }).length) return answer({ ok: true, already: true, view });
      write('user.update', account.username, 'view → ' + said);
    } else {
      if (pages.viewOf(target.uid) === view) return answer({ ok: true, already: true, view });
      if (!pages.setView(target.uid, view)) return answer({ ok: false, error: NOT_IN_ROOM });
      write('person.view', room.hall, target.name + ' (guest) → ' + (view ? said + ' view' : 'the view by their seat'));
    }
    viewChanged(key);
    answer({ ok: true, view });
  });
}

module.exports = { register };
