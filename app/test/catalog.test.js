'use strict';
// The action catalogue (public/catalog.js), pure, run as a page runs it (a vm with nothing but the script): its entries
// hold to their shape, their modes and their verbs (each a verb the server registers, a route it mounts, or local); one
// word is one act; and for each seat a page can be, the acts it is shown on each object, its inline bar and its menu's
// size are asserted. The server's refusal of each act hidden by rights is test/menus.test.js's; the doors' agreement on
// the page is the browser smoke's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { ROOT, handlerFiles, readSource } = require('./helpers');
const ops = require('../lib/ops');

/** catalog.js as a page loads it: a classic script that extends window.AGM, after common.js (the marks' table). */
function loadCatalog() {
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(readSource(path.join(ROOT, 'public', 'common.js')), ctx, { filename: 'common.js' });
  vm.runInContext(readSource(path.join(ROOT, 'public', 'catalog.js')), ctx, { filename: 'catalog.js' });
  return ctx.AGM;
}
const AGM = loadCatalog();
const C = AGM.catalog;
const plain = (v) => JSON.parse(JSON.stringify(v));   // a value from the script's realm, compared as data
const KINDS = Object.keys(C.KINDS);
const all = () => KINDS.flatMap((k) => C.KINDS[k].map((e) => ({ kind: k, e })));

/** The socket verbs the server registers (the fuzz's own read) and the HTTP routes it mounts, as `METHOD /path`. */
const SOCKET_VERBS = new Set(handlerFiles().flatMap((f) => [...readSource(path.join(ROOT, f)).matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1])));
const ROUTES = new Set(['server.js', 'lib/http-accounts.js'].flatMap((f) => [...readSource(path.join(ROOT, f)).matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[1].toUpperCase() + ' ' + m[2])));
/** The verbs §16.7 names for the kinds landed so far: each must be some entry's. A unit that adds an act adds its verb. */
const REQUIRED = ['react', 'actionResponse', 'help:respond', 'ai:draft', 'stage:propose', 'stage:send', 'display:take', 'forward', 'pin', 'delete', 'display:identify', 'display:update', 'display:rotate', 'display:remove',
  // the rest of the hall page (compose, chip, code, person's hall half)
  'message',
  // a message or a file sent into another room (msg.sendBack, compose.sendTo; msg.send's runner too)
  'room:send',
  // people's pages: a take pushed (the Board chip, a person's Show them ▸) and a page's report on its own (the layer, a card)
  'page:push', 'page:report',
  // a download, by a ticket (msg.download, file.download, take.download, card.download, adminMsg.download)
  'file:download',
  // a room's earlier messages (earlier: Show earlier, and a reply's Show it)
  'history:before',
  // the admin page, the halls board and the Accounts page (adminRoom, person, adminMsg, link, tunnel, hall, help, account, audit)
  'admin:watchRoom', 'admin:summary', 'admin:invites', 'admin:resetRoom', 'admin:deleteRoom', 'admin:setRole', 'admin:linkRoom', 'admin:unlinkRoom', 'admin:kick', 'admin:deleteMessage',
  // a hall's rooms made and renamed (adminRoom)
  'room:create', 'room:update',
  'admin:settings', 'nodes:link', 'nodes:unlink', 'nodes:acceptCertificate', 'nodes:command', 'admin:acceptCertificate', 'admin:tunnelStart', 'admin:tunnelStop', 'admin:tunnelStatus', 'admin:tunnelUntil',
  // "This laptop" (laptop)
  'admin:laptop',
  'hall:settings', 'nodes:list', 'http:PATCH /api/users/:id', 'http:POST /api/users/:id/password', 'http:POST /api/users/:id/signout', 'http:DELETE /api/users/:id',
  'http:GET /api/audit/verify', 'http:POST /api/audit/export', 'http:POST /api/audit/split'];
/** The status marks the pages draw (AGM.MARKS, common.js's one table): no act's icon is one, so a mark has one meaning. */
const MARKS = Object.values(AGM.MARKS).map((m) => m.mark);
/** The action icons kept to one act each (§15.6): ↩ is Reply, ↗ is Send to and Send back, ⤴ is Show again. */
const RESERVED_ICONS = { '↩': ['reply'], '↗': ['send', 'sendBack', 'sendTo'], '⤴': ['show'] };
/**
 * Acts of different names that are one act, and so share an icon: 🗑 takes a thing away for good; ✨ is an AI draft a
 * person reads before anything is sent (a reply, the minutes); ↗ sends into another room (Send to ▸, Send back, the
 * composer's To ▸); ▷ and 🏁 answer a help request, on a message or on the
 * halls board; ⚙ sets a link up (a node's, or the default Stagewatch's).
 */
// 📺 Show the Board ▸ on a file (msg.stage, file.stage) and Show them ▸ on a person are one act: showing on people's pages.
// 📄 Show them a document… on a person and The document at this place on a pick are one act: a document shown whole.
const ONE_ACT = [['send', 'sendBack', 'sendTo'], ['delete', 'remove'], ['draft', 'minutes'], ['helpRespond', 'respond'], ['helpResolve', 'resolve'], ['setup', 'configure'], ['toggle', 'codeToggle'], ['new', 'newCode'], ['stage', 'show'], ['doc', 'document']];
/** Acts that open a dialog of their own (Stagewatch's, the Screens console, a hall's set-up, the show network, the editor, the export, the short document bar) and so end their label with "…" as an ask does. */
const OPENS_DIALOG = new Set(['msg.speaker', 'msg.screens', 'file.screens', 'chip.speaker', 'header.screens', 'board.screens', 'compose.attach', 'hall.setup', 'hall.network', 'room.setup', 'account.edit', 'audit.export', 'adminRoom.members', 'adminRoom.sendFrom', 'person.doc']);
/** The keys a single key may be: a letter or a digit that needs no Shift (shown upper case), or one of these named keys. */
const NAMED_KEYS = ['Enter', 'Delete', 'Escape'];

// ---------------------------------------------------------------- the fixtures: seats, as their join answers make them
const at = 1_700_000_000_000;
const ANA = 'u-ana', CHAIR = 'u-chair', CY = 'u-cy', OBS = 'u-obs';
const live = { status: 'connected', desk: true, key: 'ok' };
const screens = (n, manage = false) => ({ manage, displays: Array.from({ length: n }, (_, i) => ({ id: 'd' + i })) });
const seat = (o) => C.facts({ connected: true, ai: true, stage: live, ...o });
// The guest code each seat's join answer carries (the server's codeFor): a guest the code it typed, an account whose rights
// cover what the code gives, the admin (who may switch it and renew it, setsCode); none On stage, to a Viewer or to Staff.
const GC = 'K7P2QX';
const SEATS = {
  research: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, guestCode: GC, codeOn: true }),
  researchAlone: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: false, ai: false, guestCode: GC, codeOn: true }),
  researchNoDesk: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: true, guestCode: GC, codeOn: true }),
  researchLinkDown: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, stage: { status: 'reconnecting', desk: true, key: 'ok' }, guestCode: GC, codeOn: true }),
  researchOffline: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, connected: false, guestCode: GC, codeOn: true }),
  board: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, guestCode: '', codeOn: true }),
  // The Board in the simple view: two plain messages and one 🔥 wait for its answer.
  boardSimple: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] } }),
  // A Board account (an account its On stage halls seat On stage): its join answer as the Chair's page, its account's
  // rights behind it (a Tech's: the speaker's screen and files elsewhere), held to the seat on this page.
  boardAccount: seat({ role: 'board', uid: CHAIR, uploadToken: null, canSendToStage: false, canPropose: false, forwardable: false, account: { role: 'tech' }, guestCode: '', codeOn: true }),
  boardAccountSimple: seat({ role: 'board', uid: CHAIR, uploadToken: null, canSendToStage: false, canPropose: false, forwardable: false, account: { role: 'tech' }, guestCode: '', codeOn: true, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] } }),
  // The admin's own page seated On stage (an admin account a hall's Board seats): the seat's limit holds it as anyone there.
  adminOnStage: seat({ role: 'board', uid: 'a-root', uploadToken: null, canSendToStage: false, canPropose: false, forwardable: false, account: { role: 'admin' }, guestCode: '', codeOn: true, admin: true }),
  observer: seat({ role: 'observer', uid: OBS, uploadToken: null, forwardable: false, guestCode: GC, codeOn: true }),
  observerElsewhere: seat({ role: 'observer', uid: OBS, uploadToken: null, forwardable: true, guestCode: GC, codeOn: true }),
  viewer: seat({ role: 'observer', uid: 'a-vic', uploadToken: null, forwardable: false, account: { role: 'viewer' }, guestCode: '', codeOn: true }),
  // A Viewer account granted hall.post sits backstage, and its page still holds no file's link.
  viewerPost: seat({ role: 'research', uid: 'a-vic', uploadToken: 't', forwardable: false, ai: false, account: { role: 'viewer' } }),
  staff: seat({ role: 'research', uid: 'a-sid', uploadToken: 't', canSendToStage: false, canPropose: false, forwardable: true, guestCode: '', codeOn: true }),
  tech: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: false, screens: screens(1), guestCode: GC, codeOn: true }),
  techNoScreens: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: false, screens: screens(0), guestCode: GC, codeOn: true }),
  admin: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, screens: screens(2, true), guestCode: GC, codeOn: true, setsCode: true, admin: true }),
  // A side room's Member whose room may send into Hall 2's Main room by its list (room:sendTargets), and into nothing by a
  // forward: Send to ▸ by the list alone, Send back on what Hall 2 sent here, and the composer's To ▸.
  researchSends: seat({ role: 'research', uid: 'u-lou', uploadToken: 't', forwardable: false, sends: true, targets: [{ ref: 'rH2aaaaaaaaaaaaaaa', name: 'Hall 2', hallName: 'Hall 2' }, { ref: 'rMDbbbbbbbbbbbbbbb', name: 'Media', hallName: 'Hall 2' }], guestCode: '', codeOn: false }),
  // Its list emptied since: no Send back on what Hall 2 sent before.
  researchSentNowhere: seat({ role: 'research', uid: 'u-lou', uploadToken: 't', forwardable: false, sends: false, targets: [] }),
  adminOffline: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, screens: screens(2, true), guestCode: GC, codeOn: true, setsCode: true, admin: true, connected: false }),
  support: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, adminView: true, name: 'Kim', guestCode: GC, codeOn: true, setsCode: true }),
  // Who may change what people's pages show (the join's canPush): the admin, a Tech in its hall, a locked hall's backstage
  // guest; one in a hall with no Stagewatch; and a Board page on a device that can go full screen.
  adminPush: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, screens: screens(2, true), guestCode: GC, codeOn: true, setsCode: true, admin: true, canPush: true }),
  techPush: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: false, screens: screens(1), guestCode: GC, codeOn: true, canPush: true }),
  guestPush: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: false, guestCode: GC, codeOn: true, canPush: true }),
  pushNoStagewatch: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', forwardable: false, screens: screens(1), stage: null, canPush: true }),
  // Who may show a web page too (canWeb: canPush and stage.web): the admin, a Tech with its preset, and a locked hall's
  // backstage guest while the admin lets its guests (a code guest's comes and goes with pages:rights).
  adminWeb: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, screens: screens(2, true), guestCode: GC, codeOn: true, setsCode: true, admin: true, canPush: true, canWeb: true }),
  guestWeb: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: false, guestCode: GC, codeOn: true, canPush: true, canWeb: true }),
  // A Staff account backstage that may show information on the Board's pages by a right of its own (canShow: stage.show),
  // and one granted stage.web as well.
  staffShow: seat({ role: 'research', uid: 'a-sid', uploadToken: 't', canSendToStage: false, canPropose: false, forwardable: true, guestCode: '', codeOn: true, canShow: true }),
  staffShowWeb: seat({ role: 'research', uid: 'a-sid', uploadToken: 't', canSendToStage: false, canPropose: false, forwardable: true, guestCode: '', codeOn: true, canShow: true, canWeb: true }),
  supportPush: seat({ role: 'research', uid: 'a-root', uploadToken: 't', forwardable: true, adminView: true, name: 'Kim', canPush: true }),
  boardFull: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, fullscreen: true }),
  boardSimpleFull: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', fullscreen: true }),
  // The simple view's second door: an older waiting message tapped (its own row), and one this person answered tapped
  // (Reply alone); a question answered, its answers brought back by Change.
  boardSimpleTapped: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] }, tapped: 'm8' }),
  boardSimpleTappedGot: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] }, tapped: 'm2' }),
  boardSimpleChanging: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] }, changing: 'm11' }),
  supportBoard: seat({ role: 'board', uid: 'a-root', uploadToken: null, forwardable: false, adminView: true, name: 'Kim' }),
};
const from = (uid, role, name) => ({ uid, role, name });
const OBJECTS = {
  boardText: { id: 'm1', type: 'text', text: 'Can we take questions now?', from: from(CHAIR, 'board', 'Chair'), at, reactions: [] },
  anaText: { id: 'm2', type: 'text', text: 'Capex is on slide 14', from: from(ANA, 'research', 'Ana'), at, reactions: [{ uid: CHAIR, name: 'Chair', emoji: '👍' }] },
  anaFile: { id: 'm3', type: 'file', url: '/uploads/1-capex.pdf', filename: 'capex.pdf', mime: 'application/pdf', from: from(ANA, 'research', 'Ana'), at },
  anaQuestion: { id: 'm4', type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'], responses: [], from: from(ANA, 'research', 'Ana'), at },
  chairHelp: { id: 'm5', type: 'help', category: 'Sound', text: 'mic 3 is dead', help: { state: 'open' }, from: from(CHAIR, 'board', 'Chair'), at },
  cyHelp: { id: 'm6', type: 'help', category: 'Vision', text: 'screen 2 is dark', help: { state: 'coming', by: 'Ana' }, from: from(CY, 'research', 'Cy'), at },
  system: { id: 'm7', type: 'system', text: 'Ana joined Backstage', at },
  anaOld: { id: 'm8', type: 'text', text: 'Slides are loaded', from: from(ANA, 'research', 'Ana'), at, reactions: [] },
  anaNote: { id: 'm9', type: 'text', text: 'Doors open in five', from: from(ANA, 'research', 'Ana'), at, reactions: [] },
  anaHot: { id: 'm10', type: 'text', text: 'Wrap up now', priority: true, from: from(ANA, 'research', 'Ana'), at, reactions: [] },
  // A question the Chair answered: in the simple view its line says how, with Change.
  anaAnswered: { id: 'm11', type: 'action', text: 'Proxies counted?', options: ['Yes', 'No'], responses: [{ uid: CHAIR, name: 'Chair', role: 'board', optionIndex: 0, note: '', at }], from: from(ANA, 'research', 'Ana'), at },
  // What Hall 2's Main room sent into this room, and this room's copy of what it sent there.
  fromHall: { id: 'm12', type: 'text', text: 'Is the contract signed?', from: from(ANA, 'research', 'Ana'), at, reactions: [], sentFrom: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa' } },
  // What this seat itself sent here from Hall 2: here it is that room's, not its sender's to delete.
  fromLou: { id: 'm14', type: 'text', text: 'Contract is signed', from: from('u-lou', 'research', 'Lou'), at, reactions: [], sentFrom: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa' } },
  sentThere: { id: 'm13', type: 'file', url: '/uploads/2-brief.pdf', filename: 'brief.pdf', mime: 'application/pdf', from: from('u-lou', 'research', 'Lou'), at, sentTo: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa', id: 'm1' } },
  // This room's copy of what it sent into Hall 2's Legal, withdrawn from there 40 s after it went.
  sentWithdrawn: { id: 'm15', type: 'text', text: 'Wrong room', from: from('u-lou', 'research', 'Lou'), at, reactions: [], sentTo: { roomName: 'Legal', hallName: 'Hall 2', ref: 'rLGcccccccccccccccc', id: 'm2', withdrawn: at + 40_000 } },
  // A file for download only (a zip): AGMessage never opens it, so no Look, no Show, no screen; it is downloaded, moved.
  anaZip: { id: 'm16', type: 'file', url: '/uploads/1-pack.zip', filename: 'pack.zip', mime: 'application/octet-stream', size: 2048, transferOnly: true, from: from(ANA, 'research', 'Ana'), at },
  // A file as an observer's or a Viewer account's page is sent it: no link (the server withholds it).
  anaFileLinkless: { id: 'm17', type: 'file', filename: 'capex.pdf', mime: 'application/pdf', from: from(ANA, 'research', 'Ana'), at },
};
const ids = (kind, f, o) => plain(C.ids(kind, f, o));
// The rest of the hall page's objects: its composers (`form`, `room`, the `file` chosen, whom it is `replying` to, 🔥
// `priority`), the stage chip, the code chip.
const COMPOSE = {
  text: { id: 'compose:text', form: 'text', room: 'Hall 2', file: '', replying: '', priority: false },
  replying: { id: 'compose:text', form: 'text', room: 'Hall 2', file: '', replying: 'Chair', priority: true },
  action: { id: 'compose:action', form: 'action', room: 'Hall 2', file: '', replying: '', priority: false },
  // A file attached to the next message (📎): the message composer, its words the file's caption.
  fileChosen: { id: 'compose:text', form: 'text', room: 'Hall 2', file: 'capex.pdf', replying: '', priority: false },
  director: { id: 'compose:director', form: 'director', room: 'Hall 2', file: '', replying: '', priority: false },
  directorReplying: { id: 'compose:director', form: 'director', room: '', file: '', replying: 'Ana', priority: false },
};
const STAGE = { id: 'stage', live: true, text: '04:30', words: 'Live from Stagewatch: Keynote' };
// The header: three in the room, the People panel shut, standard text, light; the room's guest code as the server tells
// the page (on, or off), or none; a guest's way out, or an account's.
const HEADER = { id: 'header', people: 3, peopleShown: false, zoom: 1, dark: false, code: 'K7P2QX', on: true, hall: 'Hall 2', account: false, away: '/' };
const HEADER_OFF = { ...HEADER, on: false };
const HEADER_UNTOLD = { ...HEADER, code: '' };
const HEADER_ACCOUNT = { ...HEADER, code: '', account: true, away: '/halls.html?stay=1', peopleShown: true, dark: true, zoom: 1.3 };
// A take on this page (the layer): the clock, with a 🔥 message in its strip, and full screen now; a card, minimised.
const TAKE = { id: 'take', seq: 4, kind: 'clock', strip: false, full: false };
const TAKE_HOT = { ...TAKE, strip: true };
const TAKE_FULL = { ...TAKE, full: true };
// A web page shown to this page, with its address: Open in a new tab.
const TAKE_WEB = { ...TAKE, kind: 'web', url: 'https://vote.example.com/poll/7' };
const TAKE_QUOTE_WEB = { ...TAKE, kind: 'snippet', url: 'https://vote.example.com/results#:~:text=Turnout%20was%2064%25' };
const CARD = { id: 'card', seq: 4, kind: 'stage', layer: 'show', side: false };
// A document shown with Let them download it ticked: ⬇ Download on its layer's bar (the full view's menu) and its card.
const TAKE_DOC = { ...TAKE, kind: 'doc', file: '/uploads/1-capex.pdf', name: 'capex.pdf', download: true };
const TAKE_DOC_PLAIN = { ...TAKE_DOC, download: false };
const CARD_DOC = { id: 'card', seq: 9, kind: 'doc', layer: 'info', side: false, file: '/uploads/1-capex.pdf', name: 'capex.pdf', download: true };
// Information that arrived in the side bar, as a card: Show over the chat, Remove.
const CARD_SIDE = { id: 'card', seq: 6, kind: 'web', layer: 'info', side: true };
// Blank, with information from backstage held under it: a touch shows it.
const TAKE_HELD = { ...TAKE, kind: 'blank', held: 1 };
// An Earlier entry: information taken off this page lately, a Look.
const PAST = { id: 'past:5', seq: 5, kind: 'web', url: 'https://vote.example.com/poll/7' };
// A document under Earlier that was shown with Let them download it ticked.
const PAST_DOC = { id: 'past:6', seq: 6, kind: 'doc', url: '', file: '/uploads/1700000000000-abcdefghijkl-capex.pdf', name: 'capex.pdf', download: true };
// The Board as the console reads it: on its chat, nothing shown yet; showing the clock on all 6 pages (this page's take,
// over a Stagewatch take before it); the clock put up by someone else since; nobody On stage.
const BOARD_CHAT = { id: 'board', seq: 0, kind: 'chat', pages: 6, on: 0, mark: '○', words: 'Nothing shown yet', showing: 'the chat', mine: null };
const BOARD_MINE = { id: 'board', seq: 7, kind: 'clock', pages: 6, on: 6, mark: '✓', words: 'On all 6 Board pages', showing: 'the clock', mine: { seq: 7, previous: { kind: 'stage' }, time: '14:02' } };
const BOARD_THEIRS = { ...BOARD_MINE, seq: 8, mine: null };
const BOARD_EMPTY = { id: 'board', seq: 8, kind: 'holding', pages: 0, on: 0, mark: '✕', words: 'Nobody on the Board is online', showing: 'a holding slide', mine: null };
// The information over the Board's show: a web page a researcher put up (canShow), and one the operator put up (canPush).
const INFO_SHOWN = { seq: 9, kind: 'web', mark: '◇', words: 'Opened · AGMessage can\'t see inside web pages', showing: 'a web page on vote.example.com', arrive: 'over', op: false, on: 6, pages: 6 };
const BOARD_INFO = { ...BOARD_MINE, info: INFO_SHOWN };
const BOARD_OPERATOR = { ...BOARD_MINE, info: { ...INFO_SHOWN, op: true } };
// The operator's over the show, and a researcher's beside it in their side bar; then that one alone, the operator's taken
// down; and a researcher's over the show while the operator's is on one Board member's page (`opOn`).
const BESIDE = { ...INFO_SHOWN, seq: 10, arrive: 'side', words: 'In the side bar on all 6 Board pages' };
const BOARD_BESIDE = { ...BOARD_OPERATOR, beside: BESIDE };
const BOARD_BESIDE_ONLY = { ...BOARD_MINE, info: null, beside: BESIDE };
const BOARD_OP_ON = { ...BOARD_INFO, opOn: true };
// A document this page put up that two of the Board's six pages could not open (no stand-in), and what Show them a picture
// sends them (plan 4-§5.15.2).
const DOC_INFO = { seq: 11, kind: 'doc', mark: '△', words: 'Couldn\'t show it on 2 of 6 pages: this device cannot open documents — ask for a picture', showing: 'Board pack.pdf at p. 12', arrive: 'over', op: true, mine: true, on: 4, pages: 6, nodocs: 2, cannot: 2, standin: 0 };
const BOARD_DOC = { ...BOARD_MINE, info: DOC_INFO, nodocs: 2, standin: { said: 'a picture of p. 12' } };
// The simple view's ⋯ sheet: standard text, dark, the screen not full, the hall as Leave names it; and at the bounds.
const SHEET = { id: 'sheet', zoom: 1, dark: true, full: false, hall: 'Hall 2' };
const SHEET_SMALLEST = { ...SHEET, zoom: 0.7, dark: false };
const SHEET_FULL = { ...SHEET, zoom: 2.2, full: true };
// The room's earlier messages: Show earlier while the server holds some (`more`), none once it holds none; a reply's Show
// it, its quoted message (`find`) earlier than those held.
const EARLIER = { id: 'earlier', more: true, find: '' };
const EARLIER_NONE = { ...EARLIER, more: false };
const QUOTE_EARLIER = { id: 'earlier:m8', more: true, find: 'm8' };
// A pick in the Preview: words of a PDF's page (a selection holding a word, its line and its paragraph, the people On stage
// to send it to), a paragraph over the stage's bound, a guess of an untagged PDF's (≈), a cell of a sheet, a region of a
// picture, a picture in a Word document, and a pick with nobody On stage.
const PEOPLE = [{ key: 'u:u-cy', name: 'Cy' }];
const PICK_WORDS = { id: 'pick', units: [{ unit: 'selection', size: '6 ch' }, { unit: 'word', size: '6 ch' }, { unit: 'line', size: '47 ch' }, { unit: 'paragraph', size: '47 ch' }], copy: 'agenda', picture: 'page', seen: true, doc: true, people: PEOPLE };
const PICK_LONG = { ...PICK_WORDS, units: [{ unit: 'selection', size: '6 ch' }, { unit: 'paragraph', size: '', over: 'Too long for the stage: 1,200 characters at most (this is 1,860)' }] };
const PICK_GUESS = { ...PICK_WORDS, units: [{ unit: 'selection', size: '1 ch' }, { unit: 'paragraph', size: '30 ch', approx: true }] };
const PICK_CELL = { id: 'pick', units: [{ unit: 'cell', size: '3 ch' }, { unit: 'row', size: '3 cells' }, { unit: 'column', size: '2 cells' }], copy: '4.2', picture: '', seen: true, doc: true, people: PEOPLE };
const PICK_REGION = { id: 'pick', units: [], copy: '', picture: 'region', seen: true, doc: false, people: PEOPLE };
const PICK_INSIDE = { id: 'pick', units: [], copy: '', picture: 'inside', seen: true, doc: true, people: PEOPLE };
const PICK_ALONE = { ...PICK_WORDS, people: [] };
// Every other unit: a sentence and items of a document's blocks, a range of a sheet's cells, and a slide.
const PICK_MORE = { ...PICK_WORDS, units: [{ unit: 'sentence', size: '40 ch' }, { unit: 'item', size: '2 items' }, { unit: 'range', size: '4 cells' }, { unit: 'slide', size: '30 ch' }] };
const HALL_OBJECTS = { compose: Object.values(COMPOSE), chip: [STAGE], header: [HEADER, HEADER_OFF, HEADER_UNTOLD, HEADER_ACCOUNT], take: [TAKE, TAKE_HOT, TAKE_FULL, TAKE_WEB, TAKE_HELD, TAKE_DOC, TAKE_DOC_PLAIN], card: [CARD, CARD_SIDE, CARD_DOC], past: [PAST, PAST_DOC], sheet: [SHEET, SHEET_SMALLEST, SHEET_FULL], board: [BOARD_CHAT, BOARD_MINE, BOARD_THEIRS, BOARD_EMPTY, BOARD_INFO, BOARD_OPERATOR, BOARD_BESIDE, BOARD_BESIDE_ONLY, BOARD_OP_ON, BOARD_DOC], earlier: [EARLIER, EARLIER_NONE, QUOTE_EARLIER],
  pick: [PICK_WORDS, PICK_LONG, PICK_GUESS, PICK_CELL, PICK_REGION, PICK_INSIDE, PICK_ALONE, PICK_MORE] };

// ---------------------------------------------------------------- the other pages' seats and objects, as their answers make them
const HALLS = [{ code: 'K7P2QX', name: 'Hall 2' }, { code: 'M3N4PQ', name: 'Legal' }];
const caps = (...c) => ({ rights: { caps: c } });
const PAGE = {
  // The admin page: the token or an admin account ("the admin"), a manager given settings.manage (the page, not the
  // split), with AI drafts off, not connected, and a socket the page's gate does not admit.
  admin: C.adminFacts({ ok: true, admin: true, ai: true, halls: HALLS, connected: true }),
  adminNoAi: C.adminFacts({ ok: true, admin: true, ai: false, halls: HALLS, connected: true }),
  manager: C.adminFacts({ ok: true, admin: false, ai: true, halls: HALLS, connected: true }),
  adminOffline: C.adminFacts({ ok: true, admin: true, ai: true, halls: HALLS, connected: false }),
  notAdmin: C.adminFacts({ connected: true }),
  // The admin page of an admin account, which manages accounts too: a room's Members….
  adminUsers: C.adminFacts({ ok: true, admin: true, manageUsers: true, ai: true, halls: HALLS, connected: true }),
  // The halls board: a manager who sets halls up and drives the show network, and a hall's crew; an admin account's
  // (the admin, who manages accounts too: Set up's codes, removal and Members…), and one who manages accounts alone.
  board: C.boardFacts({ canManageHalls: true, canDrive: true, connected: true }),
  boardCrew: C.boardFacts({ connected: true }),
  boardAdmin: C.boardFacts({ canManageHalls: true, isAdmin: true, canManageUsers: true, canDrive: true, connected: true }),
  boardUsers: C.boardFacts({ canManageUsers: true, connected: true }),
  // The Accounts page: an admin, a manager (users.manage, audit.read), one who reads the log alone, and the admin with the
  // log kept to Ana's entries.
  accountsAdmin: C.accountFacts({ account: { id: 'a-root', ...caps('users.manage', 'audit.read', 'audit.export') }, admin: true }),
  accountsManager: C.accountFacts({ account: { id: 'a-mia', ...caps('users.manage', 'audit.read') }, admin: false }),
  auditor: C.accountFacts({ account: { id: 'a-aud', ...caps('audit.read') } }),
  filtered: C.accountFacts({ account: { id: 'a-root', ...caps('users.manage', 'audit.read', 'audit.export') }, admin: true, filter: { by: 'actor', value: 'account:a-ana' } }),
};
const ENTRY = { seq: 12, at, action: 'user.update', actor: { t: 'account', id: 'a-ana', name: 'Ana' }, target: 'kim', words: 'role → tech', mark: 'intact' };
const PAGE_OBJECTS = {
  adminRoom: {
    // A hall whose code is still its key, three guest pages in with it; watched.
    listed: { code: 'K7P2QX', name: 'Hall 2', hall: 'Hall 2', main: true, watched: false, guestCode: 'K7P2QX', on: true, guests: 3, codeIsKey: true },
    watched: { code: 'K7P2QX', name: 'Hall 2', hall: 'Hall 2', main: true, watched: true, guestCode: 'K7P2QX', on: true, guests: 3, codeIsKey: true },
    // A side room beside Hall 2, by its key, its code off, in the list and watched.
    side: { code: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2 › Legal', main: false, watched: false, guestCode: 'K3TW9A', on: false, guests: 0, codeIsKey: false },
    sideWatched: { code: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2 › Legal', main: false, watched: true, guestCode: 'K3TW9A', on: false, guests: 0, codeIsKey: false },
  },
  person: {
    guest: { socketId: 's-kim', uid: 'u-kim', name: 'Kim', role: 'research', account: false, linkedRooms: [], hall: 'Hall 2' },
    account: { socketId: 's-ana', uid: 'a-ana', name: 'Ana', role: 'research', account: true, linkedRooms: ['M3N4PQ'], hall: 'Hall 2' },
    // On the hall page: a person whose key on people's pages the page knows, their pages showing the clock.
    keyed: { id: 'person:u-kim', uid: 'u-kim', name: 'Kim', role: 'research', key: 'u:u-kim', kind: 'clock' },
    // And a web page over their clock, which Take down hands back.
    keyedInfo: { id: 'person:u-kim', uid: 'u-kim', name: 'Kim', role: 'research', key: 'u:u-kim', kind: 'clock', info: INFO_SHOWN },
    // In the console: a document on their pages that one of them could not open, and what Show them a picture sends.
    keyedDoc: { id: 'person:u:u-kim', uid: 'u-kim', name: 'Kim', role: '', key: 'u:u-kim', kind: 'clock', where: 'console', info: { ...DOC_INFO, pages: 1, on: 0, nodocs: 1, cannot: 1 }, standin: { said: 'a picture of p. 12' } },
  },
  adminMsg: {
    text: { id: 'm1', type: 'text', text: 'Capex is on slide 14', from: from(ANA, 'research', 'Ana'), at, hall: 'Hall 2' },
    file: { id: 'm2', type: 'file', url: '/uploads/1-capex.pdf', filename: 'capex.pdf', from: from(ANA, 'research', 'Ana'), at, hall: 'Hall 2' },
  },
  link: {
    stagewatch: { t: 'main', name: 'Stagewatch', url: '10.0.4.21:9924', changed: false },
    stagewatchChanged: { t: 'main', name: 'Stagewatch', url: '10.0.4.21:9924', changed: true },
    heardStagewatch: { id: 'sw2', t: 'main', name: 'Hall 3 FOH', url: '10.0.4.22:9924', heard: true, hall: '' },
    heardNode: { id: 'p1', t: 'patterns', name: 'Patterns FOH', url: '', heard: true, hall: '' },
    node: { id: 'p1', t: 'patterns', name: 'Patterns FOH', hall: '', linked: true, certificateWaits: false, certificateChanged: false, desk: true, commands: [{ verb: 'CUE <n>' }, { verb: 'BLACKOUT' }] },
    nodeWaits: { id: 'p2', t: 'playmap', name: 'PlayMap 1', hall: 'K7P2QX', linked: true, certificateWaits: true, certificateChanged: true, desk: false, commands: [{ verb: 'PLAY <clip>' }] },
    nodeQuiet: { id: 'p3', t: 'patterns', name: 'Patterns 2', hall: '', linked: true, certificateWaits: false, desk: true, commands: [] },
    heardAgent: { id: 'a1', t: 'agent', name: 'Lectern PC', url: '', heard: true, hall: '' },
  },
  tunnel: {
    off: { running: false, url: '', checking: false, checkedAgo: null },
    starting: { running: true, url: '', checking: false, checkedAgo: null, untilWords: '06:00 tomorrow', untilClock: '06:00' },
    checking: { running: true, url: 'https://a-b.trycloudflare.com', checking: true, checkedAgo: null, untilWords: '06:00 tomorrow', untilClock: '06:00' },
    justChecked: { running: true, url: 'https://a-b.trycloudflare.com', checking: false, checkedAgo: 20.4, untilWords: '06:00 tomorrow', untilClock: '06:00' },
    on: { running: true, url: 'https://a-b.trycloudflare.com', checking: false, checkedAgo: 90, untilWords: '23:30 today', untilClock: '23:30' },
    // Off with its end still kept: cloudflared ended, or a start could not turn it on again.
    kept: { running: false, url: '', checking: false, checkedAgo: null, untilWords: '23:30 today', untilClock: '23:30' },
  },
  // "This laptop": its addresses as devices open them, and whether Windows is read now.
  laptop: {
    two: { addresses: ['http://192.168.1.20:3023', 'http://10.0.4.7:3023'], reading: false },
    reading: { addresses: ['http://192.168.1.20:3023'], reading: true },
    none: { addresses: [], reading: false },
  },
  // A hall's row as the board's watcher reads it: its guest code told, or not (a Staff account's, a Viewer's).
  hall: { row: { code: 'K7P2QX', name: 'Hall 2', guestCode: 'K7P2QX' }, untold: { code: 'K7P2QX', name: 'Hall 2', guestCode: '' },
    // A hall with side rooms this watcher may enter: its room buttons, and Rooms ▸.
    rooms: { code: 'K7P2QX', name: 'Hall 2', guestCode: 'K7P2QX', rooms: [{ key: 'LGQ4MZP8', name: 'Legal', people: 2 }, { key: 'MDQ4MZP8', name: 'Media', people: 0 }] } },
  // A room this person may enter. On the halls board: a room button on its hall's row (its guest code told, or not) and
  // a room under Your rooms (a hall not seen: no hall key, so no Set up). On the hall page's switcher: this room (its
  // code as the page is told it) and another (the page is told no other room's code); none carries a hall key there.
  room: {
    button: { key: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2', href: '/app.html?code=LGQ4MZP8&as=account&role=research', current: false, guestCode: 'K3TW9A', hallKey: 'K7P2QX' },
    untold: { key: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2', href: '/app.html?code=LGQ4MZP8&as=account&role=research', current: false, guestCode: '', hallKey: 'K7P2QX' },
    yours: { key: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2', href: '/app.html?code=LGQ4MZP8&as=account&role=observer', current: false, guestCode: '', hallKey: '' },
    here: { id: 'room:LGQ4MZP8', key: 'LGQ4MZP8', name: 'Legal', hall: 'Hall 2', title: 'Hall 2 › Legal', href: '/app.html?code=LGQ4MZP8&as=account&role=research', current: true, guestCode: 'K3TW9A', hallKey: '' },
    there: { id: 'room:K7P2QX', key: 'K7P2QX', name: 'Main', hall: 'Hall 2', title: 'Hall 2', href: '/app.html?code=K7P2QX&as=account&role=board', current: false, guestCode: '', hallKey: '' },
    // The switcher's other rooms with news this person has not read there: a message, and a priority one among them.
    news: { id: 'room:K7P2QX', key: 'K7P2QX', name: 'Main', hall: 'Hall 2', title: 'Hall 2', href: '/app.html?code=K7P2QX&as=account&role=board', current: false, guestCode: '', hallKey: '', news: 'news' },
    hot: { id: 'room:MDR7VX2C', key: 'MDR7VX2C', name: 'Media', hall: 'Hall 2', title: 'Hall 2 › Media', href: '/app.html?code=MDR7VX2C&as=account&role=research', current: false, guestCode: '', hallKey: '', news: 'priority' },
  },
  // A help request on the board: its room's key, whether this watcher answers it and may open its room (a side room's
  // reaches the hall's crew who may not read it, to answer from the board), and a side room's name (`room`).
  help: {
    open: { code: 'K7P2QX', id: 'h1', state: 'open', canRespond: true, canOpen: true, hall: 'Hall 2', room: '', category: 'Sound' },
    coming: { code: 'K7P2QX', id: 'h2', state: 'coming', canRespond: true, canOpen: true, hall: 'Hall 2', room: '', category: 'Vision' },
    notTheirs: { code: 'M3N4PQ', id: 'h3', state: 'open', canRespond: false, canOpen: true, hall: 'Hall 3', room: '', category: 'Presenter' },
    side: { code: 'LGQ4MZP8', id: 'h4', state: 'open', canRespond: true, canOpen: true, hall: 'Hall 2 › Legal', room: 'Legal', category: 'Sound' },
    sideCrew: { code: 'LGQ4MZP8', id: 'h5', state: 'coming', canRespond: true, canOpen: false, hall: 'Hall 2 › Legal', room: 'Legal', category: 'Vision' },
  },
  account: {
    other: { id: 'a-kim', name: 'Kim Tech', username: 'kim', disabled: false, locked: '', self: false },
    off: { id: 'a-kim', name: 'Kim Tech', username: 'kim', disabled: true, locked: '', self: false },
    locked: { id: 'a-root', name: 'Root Admin', username: 'root', disabled: false, locked: 'Only an admin may change an admin\'s account.', self: false },
    self: { id: 'a-root', name: 'Root Admin', username: 'root', disabled: false, locked: '', self: true },
  },
  audit: {
    entry: ENTRY,
    archive: { seq: 9, at, action: 'audit.archive', actor: { t: 'admin', id: 'host', name: 'AGMessage laptop' }, target: 'event:2026-10-31', words: 'an archive point', mark: 'intact' },
    noTarget: { seq: 13, at, action: 'login', actor: { t: 'account', id: 'a-ana', name: 'Ana' }, target: '', words: 'signed in', mark: 'intact' },
    bad: { line: 7, file: 'audit.jsonl', mark: 'broken', words: 'line 7 of audit.jsonl is not a whole entry' },
  },
};
/** The seats an act's words are read for, per kind: the hall page's for its kinds, each other page's own. */
const KIND_SEATS = {
  msg: [SEATS.admin, SEATS.researchNoDesk, SEATS.boardSimple, SEATS.researchSends], file: [SEATS.admin, SEATS.researchNoDesk, SEATS.boardSimple], screen: [SEATS.admin, SEATS.researchNoDesk, SEATS.boardSimple],
  compose: [SEATS.admin, SEATS.researchNoDesk, SEATS.board, SEATS.boardSimple, SEATS.researchSends], chip: [SEATS.admin, SEATS.researchNoDesk], header: [SEATS.admin, SEATS.board, SEATS.research],
  take: [SEATS.board, SEATS.boardSimple, SEATS.boardFull, SEATS.research], card: [SEATS.board, SEATS.boardSimple, SEATS.observer], past: [SEATS.board, SEATS.boardSimple, SEATS.observer], sheet: [SEATS.boardSimple, SEATS.boardSimpleFull, SEATS.supportBoard], board: [SEATS.adminPush, SEATS.pushNoStagewatch, SEATS.adminWeb, SEATS.staffShow],
  earlier: [SEATS.research, SEATS.boardSimple, SEATS.observer], pick: [SEATS.adminPush, SEATS.staffShow],
  adminRoom: [PAGE.admin, PAGE.adminNoAi, PAGE.adminUsers, PAGE.boardAdmin], person: [PAGE.admin, SEATS.research, SEATS.board, SEATS.techPush, SEATS.guestWeb], adminMsg: [PAGE.admin], link: [PAGE.admin], tunnel: [PAGE.admin], laptop: [PAGE.admin],
  hall: [PAGE.board], room: [PAGE.board, SEATS.research], help: [PAGE.board], account: [PAGE.accountsAdmin], audit: [PAGE.accountsAdmin, PAGE.filtered],
};
/** Every seat of a kind with every object of it ([f, o] pairs): messages, a file where it is listed and where it is open, a screen, and the other pages' objects. */
function pairsOf(kind) {
  const objs = PAGE_OBJECTS[kind] ? Object.values(PAGE_OBJECTS[kind]) : HALL_OBJECTS[kind] ? HALL_OBJECTS[kind]
    : kind === 'file' ? ['list', 'preview'].map((where) => Object.assign({}, OBJECTS.anaFile, { where }))
      : kind === 'screen' ? [SCREEN] : Object.values(OBJECTS);
  return KIND_SEATS[kind].flatMap((f) => objs.map((o) => [f, o]));
}

test('the file types: the pages\' one copy of the types the stage shows and of those only ever transferred is the server\'s, and the pages read no other', () => {
  const STAGE_TYPES = [...require('../lib/pages').STAGE_TYPES];
  assert.deepEqual(plain(C.STAGE_EXT), STAGE_TYPES);
  assert.deepEqual(plain(C.TRANSFER_EXT), Object.keys(require('../lib/guard').TRANSFER_TYPES));
  // The take layer (pagelayer.mjs), a module that reads nothing of the page's, keeps the stage's types of its own: held to
  // the server's too.
  const layer = /const STAGE_TYPES = Object\.freeze\((\[[^\]]*\])\)/.exec(readSource(path.join(ROOT, 'public', 'pagelayer.mjs')));
  assert.ok(layer, 'pagelayer.mjs names the stage\'s types');
  assert.deepEqual(JSON.parse(layer[1].replace(/'/g, '"')), STAGE_TYPES);
  // The stage's types a device that cannot open documents has no reader for (plan 4-§5.15.2): the catalogue's, and the take
  // layer's own copy held to it; each a type the stage shows.
  assert.deepEqual(plain(C.READER_EXT), ['pdf', 'xlsx', 'docx', 'pptx']);
  const readers = /const READERS_NEEDED = Object\.freeze\((\[[^\]]*\])\)/.exec(readSource(path.join(ROOT, 'public', 'pagelayer.mjs')));
  assert.ok(readers, 'pagelayer.mjs names the types it has no reader for without documents');
  assert.deepEqual(JSON.parse(readers[1].replace(/'/g, '"')).sort(), plain(C.READER_EXT).sort());
  // No other page script names a table of its own: a type list is read from the catalogue's.
  for (const f of ['app.js', 'admin.js', 'admin-plus.js', 'halls.js', 'users.js', 'menus.js', 'docview.mjs']) {
    const src = readSource(path.join(ROOT, 'public', f));
    assert.ok(!/\[\s*'zip',\s*'mp4'/.test(src) && !/\[\s*'pdf',[^\]]*'pptx'\s*\]/.test(src), f + ' names a file type table of its own');
  }
});

test('the entries: kind.verb ids, known groups in order with danger last, labels, keys, icons that are no marks', () => {
  assert.deepEqual(KINDS, ['msg', 'file', 'screen', 'compose', 'chip', 'header', 'take', 'card', 'past', 'sheet', 'board', 'earlier', 'pick', 'adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop', 'hall', 'room', 'help', 'account', 'audit'], 'the kinds landed so far');
  const seen = new Set();
  for (const kind of KINDS) {
    const list = C.KINDS[kind];
    const keys = new Set();
    let last = -1;
    for (const e of list) {
      assert.ok(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/.test(e.id) && e.id.split('.')[0] === kind, e.id + ': shaped kind.verb, in its kind');
      assert.ok(!seen.has(e.id), e.id + ': unique');
      seen.add(e.id);
      const g = C.GROUPS.indexOf(e.group);
      assert.ok(g >= 0, e.id + ': a known group (' + e.group + ')');
      assert.ok(g >= last, e.id + ': the groups in their fixed order (' + C.GROUPS.join(', ') + ')');
      last = g;
      assert.ok(typeof e.may === 'function' && typeof e.fits === 'function', e.id + ': may and fits');
      assert.ok(typeof e.label === 'string' || typeof e.label === 'function', e.id + ': a label');
      if (e.group === '9_danger') assert.ok(e.confirm || e.undo, e.id + ': a danger act asks first or can be undone');
      if (e.key) {
        assert.ok(/^[A-Z0-9]$/.test(e.key) || NAMED_KEYS.includes(e.key), e.id + ': one key with no Shift and no modifier, or a named key (' + e.key + ')');
        // Entries that share a fold share its one key, counted once.
        const k = e.fold ? e.fold + ':' + e.key : e.key;
        assert.ok(!keys.has(e.key) || (e.fold && keys.has(k)), e.id + ': its key ' + e.key + ' is its own in ' + kind);
        keys.add(e.key); keys.add(k);
      }
      if (e.icon) assert.ok(!MARKS.includes(e.icon), e.id + ': its icon ' + e.icon + ' is no status mark');
      if (e.icon && RESERVED_ICONS[e.icon]) assert.ok(RESERVED_ICONS[e.icon].includes(e.id.split('.')[1]), e.id + ': ' + e.icon + ' is kept for ' + RESERVED_ICONS[e.icon].join(' and '));
    }
    // Danger last: once the danger group starts, nothing else follows, and it holds at most two acts.
    const danger = list.filter((e) => e.group === '9_danger');
    assert.ok(danger.length <= 2, kind + ': at most two danger acts');
    assert.ok(list.slice(list.length - danger.length).every((e) => e.group === '9_danger'), kind + ': danger last');
    // A fold's entries are adjacent, in one group, and share one key.
    for (const fold of new Set(list.filter((e) => e.fold).map((e) => e.fold))) {
      const at2 = list.map((e, i) => (e.fold === fold ? i : -1)).filter((i) => i >= 0);
      assert.ok(at2.length >= 2 && at2.every((i, n) => n === 0 || i === at2[n - 1] + 1), kind + ': the fold ' + fold + '\'s entries are adjacent');
      assert.equal(new Set(at2.map((i) => list[i].group)).size, 1, kind + ': the fold ' + fold + ' is in one group');
      assert.equal(new Set(at2.map((i) => list[i].key || '')).size, 1, kind + ': the fold ' + fold + ' has one key');
      assert.ok(C.FOLDS[fold] && C.FOLDS[fold].label, kind + ': the fold ' + fold + ' has its label');
    }
  }
});

test('one icon, one act: entries that share an icon are the same act, in any kind', () => {
  const same = (a, b) => a === b || ONE_ACT.some((set) => set.includes(a) && set.includes(b));
  const byIcon = new Map();
  for (const { e } of all()) {
    if (!e.icon) continue;
    const act = e.id.split('.')[1];
    const first = byIcon.get(e.icon);
    if (first) assert.ok(same(first.act, act), e.id + ' shares ' + e.icon + ' with ' + first.id + ', another act');
    else byIcon.set(e.icon, { act, id: e.id });
  }
  assert.ok(byIcon.size > 15, 'the icons are read');
});

test('the verbs: each is one the server registers, a route it mounts, or local; the modes follow the verbs; every required verb is an act', () => {
  assert.ok(SOCKET_VERBS.has('join') && SOCKET_VERBS.size > 50, 'the server\'s verbs are read');
  assert.ok(ROUTES.has('POST /api/upload'), 'its routes are read');
  for (const { e } of all()) {
    if (e.verb === 'local') { assert.equal(e.mode, 'local', e.id + ': a local act sends nothing'); continue; }
    if (e.verb.startsWith('http:')) { assert.ok(ROUTES.has(e.verb.slice(5)), e.id + ': ' + e.verb + ' is a route the server mounts'); continue; }
    assert.ok(SOCKET_VERBS.has(e.verb), e.id + ': ' + e.verb + ' is a socket verb the server registers');
    assert.ok(['now', 'hold', 'self'].includes(e.mode), e.id + ': a mode of the outbox');
    // What a person wrote or answered is held; a report of one's own page is self; an act on something is now.
    if (['message', 'room:send', 'actionResponse', 'help:respond', 'forward'].includes(e.verb)) assert.equal(e.mode, 'hold', e.id + ': ' + e.verb + ' is held');
    if (e.verb === 'page:report') assert.equal(e.mode, 'self', e.id);
    // Got it sets the person's 👍 (react with on), so a replay is harmless and it is held through a blip; every other
    // reaction is an act on the message now.
    if (e.verb === 'react') assert.equal(e.mode, e.id === 'msg.ack' ? 'hold' : 'now', e.id);
  }
  const used = new Set(all().map(({ e }) => e.verb));
  for (const v of REQUIRED) assert.ok(used.has(v), v + ' is the verb of an act');
});

test('one word for one act: "…" for an act that asks first or opens a dialog, "screen" only for a screen or the speaker\'s screen', () => {
  const read = new Set();
  for (const { kind, e } of all()) {
    for (const [f, o] of pairsOf(kind)) {
      const label = typeof e.label === 'function' ? e.label(f, o) : e.label;
      assert.ok(typeof label === 'string' && label.length > 0, e.id + ': a label for every object');
      // What an act asks is read of an object it fits: the ask names it.
      if (!e.fits(f, o)) continue;
      read.add(e.id);
      const asks = !!(e.confirm && e.confirm(f, o));
      assert.equal(label.endsWith('…'), asks || OPENS_DIALOG.has(e.id), e.id + ': "' + label + '" ends with "…" exactly when it asks first or opens a dialog');
      if (asks) {
        const a = plain(e.confirm(f, o));
        // Its verbs: yes and no, or more than one way to say yes (`choices`, each an answer and its words) and no.
        const verbs = Array.isArray(a.choices) ? a.choices.length > 1 && a.choices.every((c) => typeof c.answer === 'string' && typeof c.label === 'string' && c.label.length > 0) && !('yes' in a) : typeof a.yes === 'string';
        assert.ok(typeof a.title === 'string' && a.title.length > 0 && verbs && typeof a.no === 'string', e.id + ': an ask has its title and its verbs');
        assert.equal(!!a.danger, e.group === '9_danger' || e.id === 'link.accept', e.id + ': an ask is a danger exactly when its act is (and a certificate accepted)');
      }
      // "Full screen" is the device's own mode, which a take enters only by the person's gesture: no screen of the hall's.
      if (/screen/i.test(label) && !/^(Leave )?[Ff]ull screen$/.test(label)) assert.ok(e.verb.startsWith('display:') || (e.verb.startsWith('stage:') && /speaker's screen/i.test(label)), e.id + ': "' + label + '" says screen and acts on one');
      // What puts something on people's pages says Show (Show the clock, Show them); what takes it off says the words that
      // undo it (Back to chat, Back to Stagewatch (undo your …), Take down), and nothing else does. A pick's list names what
      // is shown (a paragraph, a picture of this page, what I see): the stage addendum's previewActions exactly, whose
      // Show is its bar's button.
      if (e.verb === 'page:push' && kind !== 'pick') assert.match(label, /^Show\b|^Back to\b|^Take down\b/, e.id + ': an act on people\'s pages says Show, or Back to (Take down) where it undoes one');
      if (e.verb === 'page:push' && /^Back to\b/.test(label)) assert.ok(/\.(chat|back)$/.test(e.id), e.id + ': Back to is a hand-back (chat) or an undo (back)');
      if (e.short) assert.ok(e.fold, e.id + ': a short label is a fold\'s');
    }
  }
  assert.deepEqual(all().map(({ e }) => e.id).filter((id) => !read.has(id)), [], 'every act\'s words are read on an object it fits');
});

test('the facts: read from the server\'s answers, the link\'s words by its state, and nothing a page could name for itself', () => {
  const f = plain(C.facts({ role: 'director', uid: 'u1', uploadToken: '', canSendToStage: 1, stage: { status: 'connected' }, forwardable: 'yes', screens: { manage: true, displays: [{}, {}] }, connected: true }));
  assert.deepEqual(f, { page: 'hall', role: 'board', view: 'full', uid: 'u1', post: true, viewer: false, pin: true, ask: false, respondHelp: false, waiting: { plain: [], priority: [] }, tapped: '', changing: '', files: false, canSendToStage: true, canPropose: false, stageWhy: '', ai: false, download: false, takeDownloads: true, canScreens: true, screensManage: true, screens: 2, forwardable: true, sends: false, targets: [], mayKnowCode: false, setsCode: false, admin: false, connected: true, support: '', canPush: false, stagewatch: true, fullscreen: false, canWeb: false, canShow: false, docs: true });
  // Whether this device opens documents (its own probe at load, plan 4-§5.15.2): only its probe's false says it cannot.
  assert.deepEqual([C.facts({ docs: false }).docs, C.facts({ docs: true }).docs, C.facts({}).docs, C.facts({ docs: 0 }).docs], [false, true, true, true]);
  // Who may download (lib/pages.js mayDownload, as the server answers the seat): a seat backstage that is not a Viewer
  // account, and the admin's own page where it does not sit On stage; a take shown with Download ticked, On stage too,
  // never an observer or a Viewer account.
  const dl = (o) => { const x = C.facts(o); return [x.download, x.takeDownloads]; };
  assert.deepEqual([dl({ role: 'research' }), dl({ role: 'research', account: { role: 'viewer' } }), dl({ role: 'board' }), dl({ role: 'board', admin: true }), dl({ role: 'observer' }), dl({ role: 'observer', admin: true }), dl({ role: 'board', account: { role: 'viewer' } })],
    [[true, true], [false, false], [false, true], [false, true], [false, false], [true, false], [false, false]]);
  // Whether the page may change what people's pages show, true alone; the hall's Stagewatch as the page is told it (none,
  // or switched off); the device's Fullscreen API, the page's own probe.
  assert.deepEqual([C.facts({ canPush: true }).canPush, C.facts({ canPush: 'yes' }).canPush, C.facts({ canPush: 1 }).canPush], [true, false, false]);
  assert.deepEqual([C.facts({ stage: null }).stagewatch, C.facts({ stage: { status: 'off', desk: false } }).stagewatch, C.facts({ stage: { status: 'reconnecting' } }).stagewatch], [false, false, true]);
  assert.deepEqual([C.facts({ fullscreen: true }).fullscreen, C.facts({ fullscreen: 'yes' }).fullscreen], [true, false]);
  // Whether a web page shown from the page would be taken (the join's canWeb, or pages:rights): true alone.
  assert.deepEqual([C.facts({ canWeb: true }).canWeb, C.facts({ canWeb: 'yes' }).canWeb, C.facts({ canWeb: 1 }).canWeb, C.facts({}).canWeb], [true, false, false, false]);
  // The rooms a page may send into are room:sendTargets', read by type: each with a reference, its names strings.
  assert.deepEqual(plain(C.facts({ sends: 1, targets: [{ ref: 'rA', name: 'Legal', hallName: 'Hall 2', key: 'LGQ4MZP8' }, { ref: '', name: 'x' }, { name: 'y' }, 'rB', null, { ref: 'rC', name: 7 }] })),
    plain(C.facts({ sends: true, targets: [{ ref: 'rA', name: 'Legal', hallName: 'Hall 2' }, { ref: 'rC', name: '', hallName: '' }] })));
  assert.deepEqual(plain(C.facts({ targets: 'rA' }).targets), [], 'a list, or none');
  // The guest code is the server's to tell (codeFor), whatever the seat: an observer guest is told the code it typed, a
  // backstage account whose rights do not cover it is told none; switching it is the admin's (setsCode), read by type.
  assert.deepEqual([C.facts({ role: 'observer', guestCode: 'K7P2QX' }).mayKnowCode, C.facts({ role: 'research', guestCode: '' }).mayKnowCode, C.facts({ role: 'research', guestCode: 7 }).mayKnowCode], [true, false, false]);
  assert.deepEqual([C.facts({ setsCode: true }).setsCode, C.facts({ setsCode: 'yes' }).setsCode, C.facts({}).setsCode], [true, true, false]);
  // Whether the page is the admin's own (the join's `admin`): true alone says so.
  assert.deepEqual([C.facts({ admin: true }).admin, C.facts({ admin: 'yes' }).admin, C.facts({ admin: 1 }).admin, C.facts({}).admin], [true, false, false, false]);
  assert.equal(C.facts({ role: 'nonsense' }).role, 'observer', 'an unknown seat reads as the one with no rights');
  assert.deepEqual(['observer', 'board', 'research'].map((role) => { const x = C.facts({ role }); return [x.post, x.ask, x.respondHelp]; }), [[false, false, false], [true, false, false], [true, true, true]],
    'a question and an answer to others\' help come from backstage');
  assert.deepEqual([C.facts({ view: 'simple' }).view, C.facts({ view: 'tiny' }).view, C.facts({ account: { role: 'viewer' } }).viewer, C.facts({ account: { role: 'staff' } }).viewer], ['simple', 'full', true, false]);
  assert.deepEqual(plain(C.facts({ waiting: { plain: ['a', 3, '', 'b'], priority: 'c' } }).waiting), { plain: ['a', 'b'], priority: [] }, 'what waits is a list of ids');
  assert.deepEqual([undefined, { status: 'reconnecting' }, { status: 'connected', stale: true }, { status: 'checking key' }, { status: 'connected', cert: true }, { status: 'off', key: 'refused' }].map(C.stageWhy),
    [C.WORDS.linkDown, C.WORDS.linkDown, C.WORDS.linkDown, C.WORDS.linkKey, C.WORDS.linkCert, C.WORDS.linkRefused]);
  assert.equal(C.facts({ role: 'research', adminView: true, name: 'Kim' }).support, 'Kim', 'the support view knows whose view it draws');
});

test('the seat matrix: what each seat is shown on each message', () => {
  const M = {
    research: {
      boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'],
      anaText: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy', 'msg.delete'],
      anaFile: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential', 'msg.delete'],
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy', 'msg.delete'],
      chairHelp: ['msg.reply', 'msg.react', 'msg.helpRespond', 'msg.helpResolve', 'msg.pin', 'msg.copy'],
      cyHelp: ['msg.reply', 'msg.react', 'msg.helpResolve', 'msg.pin', 'msg.copy'],
      system: [],
    },
    // Alone in this hall with AI off: no Send to; the draft is there, saying why it cannot be made (the laptop's state).
    researchAlone: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.pin', 'msg.copy'] },
    // A Stagewatch that keeps no show desk: the line box is still there to edit the line before it goes, beside Send now.
    researchNoDesk: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'] },
    // On stage (the full view): it answers, reacts, pins and copies; it sends nothing elsewhere, shows nothing, downloads
    // nothing, asks the speaker's screen nothing, and answers only its own help request.
    board: {
      boardText: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy', 'msg.delete'],
      anaText: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'],
      anaFile: ['msg.reply', 'msg.react', 'msg.pin', 'msg.look'],
      // On stage a file for download only is a card alone: no Look (AGMessage never opens it), no Download.
      anaZip: ['msg.reply', 'msg.react', 'msg.pin'],
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.pin', 'msg.copy'],
      chairHelp: ['msg.reply', 'msg.react', 'msg.helpResolve', 'msg.pin', 'msg.copy', 'msg.delete'],
      cyHelp: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'],
      anaNote: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'],
      anaAnswered: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.pin', 'msg.copy'],
    },
    // On stage, the simple view: no menu, its acts are its buttons. The newest plain message waiting and each 🔥 one
    // waiting carry Got it and Reply; an older one waiting, one's own message and the help requests carry none; a
    // question its answers; a file its Look.
    boardSimple: {
      anaNote: ['msg.ack', 'msg.reply'], anaHot: ['msg.ack', 'msg.reply'], anaOld: [], anaText: [], boardText: [],
      anaQuestion: ['msg.answer', 'msg.answerWords'], anaFile: ['msg.look'], chairHelp: [], cyHelp: [], system: [],
      // A question answered: its line and Change, the answers gone until Change brings them back.
      anaAnswered: ['msg.change'],
    },
    // A tap brings a message's own row back: Got it where it waits (Got it, never Got all), Reply; on one answered, Reply.
    boardSimpleTapped: { anaOld: ['msg.ack', 'msg.reply'], anaNote: ['msg.ack', 'msg.reply'], anaText: [] },
    boardSimpleTappedGot: { anaText: ['msg.reply'], anaOld: [] },
    boardSimpleChanging: { anaAnswered: ['msg.answer', 'msg.answerWords'], anaQuestion: ['msg.answer', 'msg.answerWords'] },
    // An observer and a Viewer: Copy, and Send to only for text where they may post elsewhere; no pin, no Look, no
    // Download (their pages hold no file's link).
    observer: { boardText: ['msg.copy'], anaFile: [], anaFileLinkless: [], anaQuestion: ['msg.copy'], chairHelp: ['msg.copy'] },
    observerElsewhere: { boardText: ['msg.send', 'msg.copy'], anaFile: [], anaFileLinkless: [], anaQuestion: ['msg.send', 'msg.copy'] },
    viewer: { boardText: ['msg.copy'], anaFile: [], anaFileLinkless: [], anaQuestion: ['msg.copy'] },
    // A Viewer granted hall.post sits backstage, and still never downloads nor moves a file (mayDownload).
    viewerPost: { anaFile: ['msg.reply', 'msg.react', 'msg.pin'], anaFileLinkless: ['msg.reply', 'msg.react', 'msg.pin'], anaText: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'] },
    // Staff: messages and files, no Stagewatch: neither 📝 nor 🖥. Tech: Stagewatch's speaker's screen (no show desk), and
    // the hall's screens.
    // (What this room sent into another, by someone else, is not Staff's to withdraw.)
    staff: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.send', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential'], sentThere: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential'],
      // A file for download only: downloaded and moved, never opened.
      anaZip: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.download', 'msg.confidential'] },
    // A seat that may show the Board (canShow): 📺 Show the Board ▸ on a file the stage shows, never on one for download
    // only; the operator (canPush) too.
    staffShow: { anaFile: ['msg.reply', 'msg.react', 'msg.stage', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential'], anaZip: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.download', 'msg.confidential'], anaText: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.copy'] },
    techPush: { anaFile: ['msg.reply', 'msg.react', 'msg.stage', 'msg.screens', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential'] },
    tech: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.screens', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential'] },
    // A question is not a thing a screen shows: no ⧉ on it.
    // The admin withdraws any send this room made, and deletes only its own.
    admin: {
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'], anaText: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.send', 'msg.pin', 'msg.copy'],
      sentThere: ['msg.reply', 'msg.react', 'msg.screens', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential', 'msg.withdraw'], sentWithdrawn: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.send', 'msg.pin', 'msg.copy'],
    },
    support: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'] },
    // A room that may send into others by its list: Send to ▸ on words and a file (never a question, which only a forward
    // carries, and this seat forwards nowhere); Send back on what a room it sends into sent here, and none once its list
    // no longer lets it; the copy of what it sent is a message like any other, and what it sent here from another room is
    // not its to delete here.
    researchSends: {
      anaText: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.copy'],
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.pin', 'msg.copy'],
      fromHall: ['msg.reply', 'msg.react', 'msg.send', 'msg.sendBack', 'msg.pin', 'msg.copy'],
      sentThere: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.confidential', 'msg.withdraw', 'msg.delete'],
      fromLou: ['msg.reply', 'msg.react', 'msg.send', 'msg.sendBack', 'msg.pin', 'msg.copy'],
      // Withdrawn already: no Withdraw; still its copy here, to delete.
      sentWithdrawn: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.copy', 'msg.delete'],
    },

    researchSentNowhere: { fromHall: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'] },
  };
  // The full view's sets are its menus; the simple view has no menu, and its sets are what its buttons may be.
  for (const [s, objs] of Object.entries(M)) {
    for (const [o, want] of Object.entries(objs)) {
      const set = SEATS[s].view === 'simple' ? plain(C.shown('msg', SEATS[s], OBJECTS[o])).map((e) => e.id) : ids('msg', SEATS[s], OBJECTS[o]);
      assert.deepEqual(set, want, s + ' on ' + o);
      if (SEATS[s].view === 'simple') assert.deepEqual(ids('msg', SEATS[s], OBJECTS[o]), [], s + ' on ' + o + ': no menu door');
    }
  }
  // The Board, either view, a guest's page or an account's: none of what §17.1 keeps from an On stage seat, by right or by
  // its view.
  const NEVER_ON_STAGE = ['msg.helpRespond', 'msg.send', 'msg.sendBack', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.download', 'msg.draft', 'msg.withdraw', 'msg.stage'];
  // The admin seated there too, who withdraws any send of this room's from a backstage page.
  for (const s of ['board', 'boardSimple', 'boardAccount', 'boardAccountSimple', 'adminOnStage']) for (const o of Object.keys(OBJECTS)) {
    const set = plain(C.shown('msg', SEATS[s], OBJECTS[o])).map((e) => e.id);
    assert.deepEqual(set.filter((id) => NEVER_ON_STAGE.includes(id)), [], s + ' on ' + o);
    if (SEATS[s].view !== 'simple') assert.ok(!set.includes('msg.ack'), 'Got it is the simple view\'s only: the full view\'s React ▸ 👍 is the same fact');
  }
  // Every act asserted absent somewhere exists, and is shown to another seat: none passes by its absence.
  const everyId = new Set(C.KINDS.msg.map((e) => e.id));
  const shownSomewhere = new Set(Object.values(M).flatMap((objs) => Object.values(objs).flat()));
  for (const id of everyId) assert.ok(shownSomewhere.has(id), id + ' is shown to some seat in the matrix');
});

test('a Board account\'s page is the Board\'s: in either view, on every object of the hall page, it is shown what a Board guest is, whatever its account holds', () => {
  const HALL_KINDS = { msg: Object.values(OBJECTS), file: [{ ...OBJECTS.anaFile, where: 'list' }, { ...OBJECTS.anaFile, where: 'preview' }], compose: Object.values(COMPOSE), chip: [STAGE], header: [HEADER, HEADER_OFF, HEADER_UNTOLD] };
  const shown = (s, kind, o) => plain(C.shown(kind, SEATS[s], o)).map((e) => e.id);
  for (const [account, guest] of [['boardAccount', 'board'], ['boardAccountSimple', 'boardSimple']]) {
    for (const [kind, list] of Object.entries(HALL_KINDS)) {
      for (const o of list) assert.deepEqual(shown(account, kind, o), shown(guest, kind, o), account + ' · ' + kind + ' ' + (o.id || ''));
    }
  }
  // Its account would send to the speaker's screen and share files on a backstage page; here it holds neither.
  assert.deepEqual([SEATS.boardAccount.files, SEATS.boardAccount.canSendToStage, SEATS.boardAccount.ask, SEATS.boardAccount.respondHelp, SEATS.boardAccount.mayKnowCode], [false, false, false, false, false]);
});

test('what a seat may do but not now is shown, disabled, with the words why; the support view acts on nothing', () => {
  const disabled = (s, o) => Object.fromEntries(plain(C.items('msg', SEATS[s], OBJECTS[o])).filter((i) => !i.sep).flatMap((i) => (i.children || [i])).map((i) => [i.id, i.disabled || i.held || '']));
  // The link down: the speaker's screen says why, and the rest acts.
  assert.deepEqual(disabled('researchLinkDown', 'boardText'), { 'msg.reply': '', 'msg.react': '', 'msg.draft': '', 'msg.speaker': C.WORDS.linkDown, 'msg.sendNow': C.WORDS.linkDown, 'msg.send': '', 'msg.pin': '', 'msg.copy': '' });
  // AI drafts off: the message's ✨ and the composer's say why alike, and the rest acts.
  assert.deepEqual(disabled('researchAlone', 'boardText'), { 'msg.reply': '', 'msg.react': '', 'msg.draft': C.WORDS.aiOff, 'msg.speaker': '', 'msg.sendNow': '', 'msg.pin': '', 'msg.copy': '' });
  // Not connected: an act on something says so; a send held by the outbox and a local act go on (◷ for the held).
  assert.deepEqual(disabled('researchOffline', 'anaQuestion'), {
    'msg.reply': '', 'msg.react': C.WORDS.offline, 'msg.answer': C.WORDS.held, 'msg.answerWords': C.WORDS.held, 'msg.speaker': C.WORDS.offline, 'msg.sendNow': C.WORDS.offline,
    'msg.send': C.WORDS.held, 'msg.pin': C.WORDS.offline, 'msg.copy': '', 'msg.delete': C.WORDS.offline,
  });
  assert.equal(C.ready('msg', 'msg.answer', SEATS.researchOffline, OBJECTS.anaQuestion), true, 'a held send is ready while down');
  // No screens yet: ⧉ says where to add one.
  assert.equal(C.ready('msg', 'msg.screens', SEATS.techNoScreens, OBJECTS.boardText), C.WORDS.noScreens);
  // A file marked confidential: ⧉ drawn and greyed with the server's words, screens or none (plan 4-§5.14, S3).
  const marked = Object.assign({}, OBJECTS.anaFile, { confidential: true });
  for (const seat of ['tech', 'techNoScreens']) assert.equal(C.ready('msg', 'msg.screens', SEATS[seat], marked), C.WORDS.secretScreens, seat);
  assert.equal(C.WORDS.secretScreens, 'A confidential file is never shown on screens: anyone near them can see it.');
  assert.equal(C.ready('msg', 'msg.screens', SEATS.tech, OBJECTS.anaFile), true, 'an unmarked file: ready');
  // The support view draws the person's doors, every one disabled with its words.
  const sv = plain(C.items('msg', SEATS.support, OBJECTS.boardText)).filter((i) => !i.sep).flatMap((i) => (i.children || [i]));
  assert.ok(sv.length > 5 && sv.every((i) => i.disabled === 'This is Kim\'s view — act from your own page.'), JSON.stringify(sv.map((i) => i.disabled)));
  assert.equal(C.ready('msg', 'msg.copy', SEATS.support, OBJECTS.boardText), C.supportWords('Kim'), 'a local act too');
});

test('the room\'s earlier messages: Show earlier and a reply\'s Show it for every seat while the server holds earlier ones, none once it holds none; offline and in the support view, shown and disabled with why', () => {
  const shown = (s, o) => plain(C.inline('earlier', SEATS[s], o, 2)).map((i) => [i.id, i.label, i.disabled]);
  for (const s of Object.keys(SEATS)) {
    const why = SEATS[s].support ? C.supportWords(SEATS[s].support) : SEATS[s].connected ? '' : C.WORDS.offline;
    assert.deepEqual([shown(s, EARLIER), shown(s, QUOTE_EARLIER), shown(s, EARLIER_NONE)], [[['earlier.show', 'Show earlier', why]], [['earlier.show', 'Show it', why]], []], s + ': every seat reads its room, a page at a time');
  }
  // A read of the room's own earlier messages: it sends history:before at once, and waits for no outbox.
  assert.deepEqual([C.entry('earlier', 'earlier.show').verb, C.entry('earlier', 'earlier.show').mode], ['history:before', 'now']);
  // A text action of its own: the simple view, which has no menu, draws it as the full view does.
  assert.deepEqual([plain(C.items('earlier', SEATS.boardSimple, EARLIER)), plain(C.items('earlier', SEATS.research, EARLIER)).map((i) => i.id)], [[], ['earlier.show']]);
});

test('the inline bar: at most two, the lowest ranks, Reply then the seat\'s main act', () => {
  const bar = (s, o, kind = 'msg') => plain(C.inline(kind, SEATS[s], typeof o === 'string' ? OBJECTS[o] : o)).map((i) => i.id);
  assert.deepEqual(bar('research', 'boardText'), ['msg.reply', 'msg.speaker'], 'Ask the operator first where there is a desk');
  assert.deepEqual(bar('researchNoDesk', 'boardText'), ['msg.reply', 'msg.sendNow'], 'else Send now');
  assert.deepEqual(plain(C.inline('msg', SEATS.boardSimple, OBJECTS.anaNote)).map((i) => [i.id, i.label]), [['msg.ack', 'Got all 2'], ['msg.reply', 'Reply']], 'the simple view: Got it first, then Reply');
  assert.deepEqual(bar('tech', 'boardText'), ['msg.reply', 'msg.sendNow']);
  assert.deepEqual(bar('tech', 'anaFile'), ['msg.reply', 'msg.screens'], 'a file: Show on screens');
  assert.deepEqual(bar('staff', 'boardText'), ['msg.reply'], 'no main act: Reply alone');
  assert.deepEqual(bar('board', 'anaQuestion'), ['msg.reply']);
  assert.deepEqual(bar('observer', 'boardText'), [], 'an observer has no bar, only ⋯');
  for (const s of Object.keys(SEATS)) for (const o of Object.keys(OBJECTS)) {
    const b = bar(s, o);
    assert.ok(b.length <= 2, s + ' on ' + o + ': at most two inline');
    // The bar is in the menu; in the simple view, which has none, it is what the seat is shown.
    const menu = SEATS[s].view === 'simple' ? plain(C.shown('msg', SEATS[s], OBJECTS[o])).map((e) => e.id) : ids('msg', SEATS[s], OBJECTS[o]);
    assert.ok(b.every((id) => menu.includes(id)), s + ' on ' + o + ': the bar is in the menu');
    // Each inline act's name is its menu label: a flat item's label, or a fold's entry's own full label when alone.
    const labels = new Map(plain(C.items('msg', SEATS[s], OBJECTS[o])).filter((i) => !i.sep && !i.children).map((i) => [i.id, i.label]));
    for (const i of plain(C.inline('msg', SEATS[s], OBJECTS[o]))) if (labels.has(i.id)) assert.equal(i.label, labels.get(i.id), s + ' on ' + o + ': ' + i.id);
  }
});

test('the menu: groups apart, a fold as one item of its entries, flat when one is shown; at most 12 items and 2 dangers', () => {
  const m = plain(C.items('msg', SEATS.research, OBJECTS.anaQuestion));
  const shape = m.map((i) => (i.sep ? '—' : i.children ? i.fold + '▸' + i.children.map((c) => c.id + ':' + c.label).join(',') : i.id));
  assert.deepEqual(shape, ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', '—', 'speaker▸msg.speaker:Ask the operator…,msg.sendNow:Send now', 'msg.send', '—', 'msg.pin', 'msg.copy', '—', 'msg.delete']);
  const noDesk = plain(C.items('msg', SEATS.researchNoDesk, OBJECTS.boardText)).find((i) => i.fold);
  assert.deepEqual(noDesk.children.map((c) => [c.id, c.label]), [['msg.speaker', 'Edit, then send…'], ['msg.sendNow', 'Send now']], 'with no show desk the line box edits the line, then sends it');
  assert.equal(C.entry('msg', 'msg.speaker').label(SEATS.researchNoDesk, OBJECTS.boardText), 'Edit, then send to the speaker\'s screen…');
  assert.deepEqual(m.find((i) => i.fold), { id: '', fold: 'speaker', label: 'Speaker\'s screen', icon: '🖥', key: '', group: '2_send', disabled: '', held: '', submenu: true, children: m.find((i) => i.fold).children });
  // A show desk and no line to the speaker's screen of this seat's own: the line box alone, drawn flat with its full label.
  const deskOnly = seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: false, canPropose: true });
  const flat = plain(C.items('msg', deskOnly, OBJECTS.boardText)).filter((i) => !i.sep && i.group === '2_send');
  assert.deepEqual(flat.map((i) => [i.id, i.label, !!i.children]), [['msg.speaker', 'Ask the operator…', false]], 'one of a fold alone is drawn flat, with its full label');
  assert.deepEqual(plain(C.items('msg', SEATS.research, OBJECTS.anaText)).find((i) => i.id === 'msg.react').submenu, true);
  assert.deepEqual(plain(C.submenu('msg', 'msg.react', SEATS.board, OBJECTS.anaText)).find((v) => v.value === '👍'), { value: '👍', label: '👍', role: 'menuitemcheckbox', checked: true }, 'my reaction is checked');
  assert.deepEqual(plain(C.submenu('msg', 'msg.answer', SEATS.research, OBJECTS.anaQuestion)).map((v) => v.label), ['Yes', 'No']);
  assert.equal(C.submenu('msg', 'msg.send', SEATS.research, OBJECTS.anaText), null, 'the rooms are the server\'s, asked as the submenu opens');
  assert.equal(plain(C.items('msg', SEATS.research, Object.assign({}, OBJECTS.anaText, { pinned: true }))).find((i) => i.id === 'msg.pin').label, 'Unpin');
  // The caps, on the richest seat of each kind.
  const rich = { msg: [SEATS.admin, OBJECTS.anaQuestion], file: [SEATS.admin, Object.assign({}, OBJECTS.anaFile, { where: 'preview', pinned: true })], screen: [SEATS.admin, SCREEN] };
  for (const [kind, [f, o]] of Object.entries(rich)) {
    const items = plain(C.items(kind, f, o)).filter((i) => !i.sep);
    assert.ok(items.length <= 12, kind + ': ' + items.length + ' items, at most 12');
    assert.ok(items.filter((i) => i.group === '9_danger').length <= 2, kind + ': at most 2 dangers');
  }
});

test('the simple view\'s second door: a tap brings a message\'s own row, Got it (never Got all) where it waits, Reply; Change brings a question\'s answers back', () => {
  const label = (f, o) => { const i = plain(C.inline('msg', f, o)).find((x) => x.id === 'msg.ack'); return i ? i.label : null; };
  assert.equal(label(SEATS.boardSimpleTapped, OBJECTS.anaOld), 'Got it', 'an older one tapped answers itself alone');
  assert.equal(label(SEATS.boardSimpleTapped, OBJECTS.anaNote), 'Got all 2', 'the newest still answers every plain one');
  assert.deepEqual(plain(C.inline('msg', SEATS.boardSimpleTapped, OBJECTS.anaOld)).map((i) => [i.id, i.icon]), [['msg.ack', '👍'], ['msg.reply', '↩']], 'its row: Got it then Reply');
  assert.deepEqual(plain(C.inline('msg', SEATS.boardSimpleTappedGot, OBJECTS.anaText)).map((i) => i.id), ['msg.reply'], 'one answered: Reply alone');
  assert.deepEqual(plain(C.inline('msg', SEATS.boardSimple, OBJECTS.anaOld)), [], 'untapped, an older one has no buttons');
  // A message this person answered by a reply waits no more (the page leaves it out of `waiting`): tapped, Reply alone,
  // never Got it. One's own message tapped draws no button (its status words are its line); nor does a line of the room's.
  const tapped = (id) => seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m9'], priority: [] }, tapped: id });
  assert.deepEqual(plain(C.inline('msg', tapped('m8'), OBJECTS.anaOld)).map((i) => i.id), ['msg.reply'], 'answered by a reply, then tapped: Reply alone');
  assert.deepEqual(plain(C.inline('msg', tapped('m1'), OBJECTS.boardText)).map((i) => i.id), [], 'one\'s own message tapped: no button');
  assert.deepEqual(plain(C.inline('msg', tapped('m7'), OBJECTS.system)).map((i) => i.id), [], 'a line of the room\'s tapped: no button');
  assert.deepEqual(plain(C.inline('msg', tapped('m4'), OBJECTS.anaQuestion)).map((i) => i.id), [], 'a question tapped: its answers are its row');
  // Change: the simple view's own act on a question answered (local), never the full view's, nor on a question not answered.
  const change = C.entry('msg', 'msg.change');
  assert.deepEqual([change.verb, change.mode, change.label], ['local', 'local', 'Change']);
  assert.deepEqual([SEATS.boardSimple, SEATS.board, SEATS.boardSimpleChanging].map((f) => change.fits(f, OBJECTS.anaAnswered)), [true, false, false]);
  assert.equal(change.fits(SEATS.boardSimple, OBJECTS.anaQuestion), false, 'nothing to change on a question not answered');
  assert.equal(change.fits(SEATS.boardSimple, OBJECTS.anaText), false, 'a question\'s act alone');
});

test('the simple view\'s ⋯ sheet: Text size, Theme, Full screen only where the device has it, Leave asked in place; none in the full view; the support view acts on none', () => {
  const shown = (f, o) => plain(C.shown('sheet', f, o)).map((e) => e.id);
  assert.deepEqual(shown(SEATS.boardSimple, SHEET), ['sheet.size', 'sheet.theme', 'sheet.leave'], 'a device without the Fullscreen API: no Full screen row');
  assert.deepEqual(shown(SEATS.boardSimpleFull, SHEET), ['sheet.size', 'sheet.theme', 'sheet.fullscreen', 'sheet.leave']);
  assert.deepEqual([shown(SEATS.board, SHEET), shown(SEATS.boardFull, SHEET), shown(SEATS.research, SHEET)], [[], [], []], 'the full view has its header\'s ⋯');
  assert.deepEqual(ids('sheet', SEATS.boardSimpleFull, SHEET), [], 'no menu: the sheet draws its rows');
  // Text size steps by a tenth between the page's bounds; the theme is one of two, the one drawn checked.
  const sub = (id, o) => plain(C.submenu('sheet', id, SEATS.boardSimple, o));
  assert.deepEqual(sub('sheet.size', SHEET).map((v) => [v.label, v.value, v.disabled]), [['Aa−', -0.1, ''], ['Aa+', 0.1, '']]);
  assert.deepEqual(sub('sheet.size', SHEET_SMALLEST).map((v) => v.disabled), ['The text is as small as it goes.', '']);
  assert.deepEqual(sub('sheet.size', SHEET_FULL).map((v) => v.disabled), ['', 'The text is as large as it goes.']);
  assert.deepEqual(sub('sheet.theme', SHEET).map((v) => [v.value, v.checked]), [['light', false], ['dark', true]]);
  assert.deepEqual(sub('sheet.theme', SHEET_SMALLEST).map((v) => [v.value, v.checked]), [['light', true], ['dark', false]]);
  assert.deepEqual([SHEET, SHEET_FULL].map((o) => C.entry('sheet', 'sheet.fullscreen').label(SEATS.boardSimpleFull, o)), ['Full screen', 'Leave full screen']);
  // Leave asks in place, in the sheet's words; it is not a danger (it loses nothing).
  assert.deepEqual(plain(C.entry('sheet', 'sheet.leave').confirm(SEATS.boardSimple, SHEET)), { title: 'Leave Hall 2?', words: 'You\'ll stop getting messages from backstage.', yes: 'Leave', no: 'Stay' });
  // Every row is local, and the support view draws the person's, every one disabled with whose view it is (R8).
  for (const e of C.KINDS.sheet) assert.deepEqual([e.verb, e.mode], ['local', 'local'], e.id);
  for (const id of shown(SEATS.supportBoard, SHEET)) assert.equal(C.ready('sheet', id, SEATS.supportBoard, SHEET), 'This is Kim\'s view — act from your own page.', id);
});

test('Chat view ▸: the admin\'s choice of the view a person\'s pages draw, By seat · Simple · Full, the one chosen checked; on the hall page only in the full view and on a person of the room', () => {
  const values = (f, o) => plain(C.submenu('person', 'person.chatView', f, o)).map((v) => [v.value, v.label, v.checked]);
  assert.deepEqual(values(PAGE.admin, { socketId: 's-kim', uid: 'u-kim', name: 'Kim', view: 'simple' }), [['', 'By seat', false], ['simple', 'Simple', true], ['full', 'Full', false]]);
  assert.deepEqual(values(PAGE.admin, { socketId: 's-kim', uid: 'u-kim', name: 'Kim' }).map((v) => v[2]), [true, false, false], 'none chosen: By seat');
  const e = C.entry('person', 'person.chatView');
  assert.deepEqual([e.verb, e.mode, e.group], ['admin:setView', 'now', '4_manage']);
  const row = { id: 'person:u-kim', uid: 'u-kim', name: 'Kim', role: 'research', key: 'u:u-kim', socketId: 's-kim', view: '' };
  // The hall page: the admin's own page, in the full view, on a person of the People panel (a sender's name has no page).
  assert.deepEqual([SEATS.admin, SEATS.research, SEATS.boardSimple, SEATS.support].map((f) => plain(C.shown('person', f, row)).some((x) => x.id === 'person.chatView')), [true, false, false, false]);
  assert.equal(plain(C.shown('person', SEATS.admin, { ...row, socketId: '' })).some((x) => x.id === 'person.chatView'), false, 'a sender carries no page');
});

test('Got it: the simple view\'s answer to backstage, held, rank 1, "Got all N" for N plain messages waiting', () => {
  const e = C.entry('msg', 'msg.ack');
  assert.deepEqual([e.verb, e.mode, e.group, e.inline(SEATS.boardSimple, OBJECTS.anaNote)], ['react', 'hold', '1_respond', 1]);
  const label = (f, o) => C.inline('msg', f, o).find((i) => i.id === 'msg.ack')?.label || null;
  const waits = (plainIds, priority = []) => seat({ role: 'board', uid: CHAIR, uploadToken: null, view: 'simple', waiting: { plain: plainIds, priority } });
  assert.equal(label(waits(['m9']), OBJECTS.anaNote), 'Got it', 'alone, it is Got it');
  assert.equal(label(waits(['m8', 'm9', 'm2']), Object.assign({}, OBJECTS.anaNote, { id: 'm2' })), 'Got all 3', 'three waiting: Got all 3, on the newest');
  assert.equal(label(waits(['m8', 'm9']), OBJECTS.anaOld), null, 'an older one waiting has none of its own');
  assert.equal(label(waits(['m9'], ['m10']), OBJECTS.anaHot), 'Got it', 'a 🔥 message waiting has its own');
  assert.equal(label(waits([]), OBJECTS.anaNote), null, 'answered, nothing waits');
  // Got it answers the backstage team: on a 🔥 message from another Board member, only Reply.
  const chairHot = { id: 'm11', type: 'text', text: 'Mic check', priority: true, from: from('u-bea', 'board', 'Bea'), at, reactions: [] };
  assert.deepEqual(plain(C.shown('msg', waits([], ['m11']), chairHot)).map((x) => x.id), ['msg.reply']);
  // Once this person's 👍 is on it, it waits no more, whatever the page's list says.
  assert.equal(label(waits(['m9']), Object.assign({}, OBJECTS.anaNote, { reactions: [{ uid: CHAIR, emoji: '👍' }] })), null);
  assert.equal(label(seat({ role: 'board', uid: CHAIR, waiting: { plain: ['m9'] } }), OBJECTS.anaNote), null, 'the full view has no Got it');
  assert.equal(label(seat({ role: 'observer', uid: OBS, view: 'simple', waiting: { plain: ['m9'] } }), OBJECTS.anaNote), null, 'an observer answers nothing');
});

const SCREEN = { id: 'd1', name: 'Lectern monitor', path: '/d/abc', state: 'shown', mark: '✓', words: 'on screen', showing: 'the clock' };
test('a file and a screen: what each seat is shown, its bar, and its asks', () => {
  const list = Object.assign({}, OBJECTS.anaFile, { where: 'list', pinned: true });
  const preview = Object.assign({}, OBJECTS.anaFile, { where: 'preview', pinned: true });
  assert.deepEqual(ids('file', SEATS.research, list), ['file.look', 'file.download', 'file.pin', 'file.confidential']);
  assert.deepEqual(ids('file', SEATS.research, preview), ['file.download', 'file.pin', 'file.confidential', 'file.close']);
  assert.deepEqual(ids('file', SEATS.tech, list), ['file.screens', 'file.look', 'file.download', 'file.pin', 'file.confidential']);
  assert.equal(C.ready('file', 'file.screens', SEATS.tech, Object.assign({}, list, { confidential: true })), C.WORDS.secretScreens, 'a confidential file: ⧉ greyed with why');
  assert.deepEqual(ids('file', SEATS.board, list), ['file.look', 'file.pin'], 'On stage: no Download');
  assert.deepEqual(ids('file', SEATS.observer, list), [], 'an observer: nothing of a file');
  assert.deepEqual(ids('file', SEATS.viewerPost, list), ['file.pin'], 'a Viewer granted hall.post: no Look and no Download');
  // Backstage a file opens in the Preview; On stage it is a Look.
  assert.deepEqual(plain(C.inline('file', SEATS.research, list)).map((i) => [i.id, i.label]), [['file.look', 'Preview'], ['file.pin', 'Unpin']]);
  assert.deepEqual(plain(C.inline('file', SEATS.board, list)).map((i) => [i.id, i.label]), [['file.look', 'Look'], ['file.pin', 'Unpin']]);
  // A seat that may show the Board: 📺 Show the Board ▸ a picture of p. 1, of a page, or the document (a PDF); the picture
  // (an image); the document (any other type); never on a file for download only, which opens nowhere and downloads alone.
  assert.deepEqual(ids('file', SEATS.staffShow, list), ['file.stage', 'file.look', 'file.download', 'file.pin', 'file.confidential']);
  assert.deepEqual(plain(C.submenu('file', 'file.stage', SEATS.staffShow, list)).map((v) => [v.value, v.label]), [['picture1', 'A picture of p. 1'], ['picture', 'A picture of a page…'], ['doc', 'The document…']]);
  const png = Object.assign({}, list, { url: '/uploads/1-plan.png', filename: 'plan.png', mime: 'image/png' });
  const xlsx = Object.assign({}, list, { url: '/uploads/1-q3.xlsx', filename: 'q3.xlsx', mime: 'application/octet-stream' });
  assert.deepEqual([png, xlsx].map((o) => plain(C.submenu('file', 'file.stage', SEATS.staffShow, o)).map((v) => v.label)), [['This picture', 'The document…'], ['The document…']]);
  const zip = Object.assign({}, OBJECTS.anaZip, { where: 'list', pinned: true });
  assert.deepEqual(ids('file', SEATS.staffShow, zip), ['file.download', 'file.pin', 'file.confidential'], 'a file for download only');
  assert.deepEqual(ids('file', SEATS.board, zip), ['file.pin'], 'On stage: neither Look nor Download');
  assert.deepEqual(plain(C.submenu('msg', 'msg.stage', SEATS.staffShow, OBJECTS.anaFile)).map((v) => v.value), ['picture1', 'picture', 'doc']);
  assert.deepEqual(plain(C.inline('file', SEATS.research, preview)).map((i) => [i.id, i.label]), [['file.pin', 'Unpin'], ['file.close', 'Close']]);

  const noPath = Object.assign({}, SCREEN, { path: undefined });
  assert.deepEqual(ids('screen', SEATS.admin, SCREEN), ['screen.identify', 'screen.only', 'screen.copy', 'screen.open', 'screen.rename', 'screen.rotate', 'screen.remove']);
  assert.deepEqual(ids('screen', SEATS.tech, noPath), ['screen.identify', 'screen.only'], 'display.control without display.manage: Identify and Tick');
  assert.deepEqual(ids('screen', SEATS.research, SCREEN), [], 'a guest drives no screen');
  assert.deepEqual(plain(C.inline('screen', SEATS.admin, SCREEN)).map((i) => i.id), ['screen.identify']);
  const ask = (id, o) => plain(C.entry('screen', id).confirm(SEATS.admin, o));
  assert.deepEqual(ask('screen.remove', SCREEN), { title: 'Remove Lectern monitor?', words: 'Its link stops working on every screen that has it open.', yes: 'Remove', no: 'Keep it', danger: true }, 'an ask names the object and what follows');
  assert.deepEqual(ask('screen.rename', SCREEN).fields, [{ name: 'name', label: 'Name', value: 'Lectern monitor', max: 60 }], 'Rename is a field in place, not a prompt()');
  assert.match(plain(C.entry('msg', 'msg.delete').confirm(SEATS.research, OBJECTS.anaText)).words, /^“Capex is on slide 14” goes from everyone's page/);
  // Withdraw asks first, naming the room it goes from and how long it has been there by the time it is asked.
  assert.equal(C.entry('msg', 'msg.withdraw').label(SEATS.researchSends, OBJECTS.sentThere), 'Withdraw from Hall 2…');
  assert.deepEqual(plain(C.entry('msg', 'msg.withdraw').confirm(SEATS.researchSends, OBJECTS.sentThere, at + 40_000)),
    { title: 'Withdraw from Hall 2?', words: 'It goes from Hall 2\'s chat now; people there may have read it (it was there 40 s).', yes: 'Withdraw', no: 'Keep it', danger: true });
  assert.match(plain(C.entry('msg', 'msg.withdraw').confirm(SEATS.admin, OBJECTS.sentThere, at + 3_725_000)).words, /\(it was there 1 h 2 min\)\.$/);
  // Deleting the copy of a send not withdrawn says the message stays where it went; once withdrawn, nothing more.
  assert.deepEqual([plain(C.entry('msg', 'msg.delete').confirm(SEATS.researchSends, OBJECTS.sentThere)).words, plain(C.entry('msg', 'msg.delete').confirm(SEATS.researchSends, OBJECTS.sentWithdrawn)).words],
    ['“brief.pdf” goes from everyone\'s page in this room now. It stays in Hall 2: withdraw it first to take it from there, which this copy alone can do. This cannot be undone.',
      '“Wrong room” goes from everyone\'s page in this room now. This cannot be undone.']);
  assert.deepEqual(plain(C.entry('msg', 'msg.answerWords').confirm(SEATS.board, OBJECTS.anaQuestion)).fields, [{ name: 'note', label: 'Your answer…', max: 200 }], 'answered in a field of 200 characters, as the server keeps');
});

test('a single key on the focused object: R E F P D, Enter, Delete or Backspace, each the act that carries it', () => {
  const key = (s, o, k, kind = 'msg') => { const e = C.byKey(kind, SEATS[s], o, k); return e ? e.id : null; };
  assert.deepEqual(['r', 'E', 'f', 'p', 'Delete', 'Backspace', 'x', 'Enter'].map((k) => key('research', OBJECTS.anaText, k)), ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.delete', 'msg.delete', null, null]);
  assert.deepEqual(['Enter', 'd'].map((k) => key('research', OBJECTS.anaFile, k)), ['msg.look', 'msg.download']);
  assert.equal(key('observer', OBJECTS.anaText, 'p'), null, 'a key runs only what the seat is shown');
  assert.equal(key('board', OBJECTS.anaFile, 'd'), null, 'On stage downloads nothing, by key either');
  // On the composer: Escape takes back a reply begun, and is nothing while none is.
  assert.deepEqual([key('research', COMPOSE.replying, 'Escape', 'compose'), key('board', COMPOSE.directorReplying, 'Escape', 'compose'), key('research', COMPOSE.text, 'Escape', 'compose')],
    ['compose.cancelReply', 'compose.cancelReply', null]);
});

// ---------------------------------------------------------------- the rest of the hall page: the composer, the chips, a person
test('the rest of the hall page: what each seat is shown on the composer, the stage chip, the header\'s ⋯ and a person', () => {
  const PERSON = { id: 'person:u-kim', uid: 'u-kim', name: 'Kim', role: 'research' };
  const SELF = { id: 'person:' + ANA, uid: ANA, name: 'Ana', role: 'research' };
  const M = [
    // Backstage: ✨ Draft a reply, Send, 🔥 Priority and 📎 Attach a file… in the Message tab (a question attaches none);
    // Remove the file once one is attached; Cancel the reply while replying. Send is the composer's one act on its row.
    ['compose', 'research', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach']],
    ['compose', 'research', COMPOSE.replying, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach', 'compose.cancelReply']],
    ['compose', 'research', COMPOSE.action, ['compose.send', 'compose.priority']],
    ['compose', 'research', COMPOSE.fileChosen, ['compose.draft', 'compose.send', 'compose.priority', 'compose.confidential', 'compose.attach', 'compose.removeFile']],
    // On stage: its words, 🔥 and Send, no file and no draft.
    ['compose', 'board', COMPOSE.director, ['compose.send', 'compose.priority']],
    ['compose', 'board', COMPOSE.directorReplying, ['compose.send', 'compose.priority', 'compose.cancelReply']],
    // A Viewer granted posting sits backstage: it drafts, sends and attaches.
    ['compose', 'viewerPost', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach']],
    ['compose', 'observer', COMPOSE.text, []],
    // A room that may send into others: To ▸ on the message composer (a file attached to it too), never on a question's.
    ['compose', 'researchSends', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.sendTo', 'compose.priority', 'compose.attach']],
    ['compose', 'researchSends', COMPOSE.fileChosen, ['compose.draft', 'compose.send', 'compose.sendTo', 'compose.priority', 'compose.confidential', 'compose.attach', 'compose.removeFile']],
    ['compose', 'researchSends', COMPOSE.action, ['compose.send', 'compose.priority']],
    // The stage chip: the speaker's screen for a seat with its rights, the countdown on screens for one that drives them.
    ['chip', 'research', STAGE, ['chip.speaker']],
    ['chip', 'tech', STAGE, ['chip.speaker', 'chip.screens']],
    ['chip', 'admin', STAGE, ['chip.speaker', 'chip.screens']],
    ['chip', 'staff', STAGE, []],
    ['chip', 'board', STAGE, []],
    ['chip', 'observer', STAGE, []],
    // The header's ⋯: People, the text size, the theme and the way out for every seat; Screens… for a seat that drives
    // the hall's screens; the guest code copied by a page the server tells it (a guest the code it typed, an observer's
    // too; an account whose rights cover it), never On stage, a Viewer's or a Staff account's, and none when the page is
    // told no code; switched and renewed by the admin.
    ['header', 'research', HEADER, ['header.people', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.leave']],
    ['header', 'research', HEADER_UNTOLD, ['header.people', 'header.size', 'header.theme', 'header.leave']],
    ['header', 'observer', HEADER, ['header.people', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.leave']],
    ['header', 'tech', HEADER, ['header.people', 'header.screens', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.leave']],
    ['header', 'board', HEADER, ['header.people', 'header.size', 'header.theme', 'header.leave']],
    ['header', 'viewer', HEADER, ['header.people', 'header.size', 'header.theme', 'header.leave']],
    ['header', 'staff', HEADER_ACCOUNT, ['header.people', 'header.size', 'header.theme', 'header.leave']],
    ['header', 'admin', HEADER, ['header.people', 'header.screens', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.codeToggle', 'header.newCode', 'header.leave']],
    ['header', 'admin', HEADER_OFF, ['header.people', 'header.screens', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.codeToggle', 'header.newCode', 'header.leave']],
    ['header', 'boardSimple', HEADER, []],
    // A person: mentioned by a seat that posts, never oneself; the hall page's admin account is shown the hall page's half
    // only (the admin's rows are the admin page's, run on its socket).
    ['person', 'research', PERSON, ['person.mention']],
    ['person', 'research', SELF, []],
    ['person', 'board', PERSON, ['person.mention']],
    ['person', 'admin', PERSON, ['person.mention']],
    ['person', 'observer', PERSON, []],
  ];
  for (const [kind, seat, o, want] of M) assert.deepEqual(ids(kind, SEATS[seat], o), want, kind + ' · ' + seat + ' on ' + JSON.stringify(o).slice(0, 60));
  for (const kind of ['compose', 'chip', 'header']) for (const e of C.KINDS[kind]) assert.ok(M.some((r) => r[0] === kind && r[3].includes(e.id)), e.id + ' is shown to some seat in the matrix');
  // The admin page's facts show none of the hall page's half, and the hall page's none of the admin's.
  assert.deepEqual(ids('person', PAGE.admin, PERSON), ['person.seat', 'person.forward', 'person.view', 'person.kick']);
  for (const f of Object.values(SEATS)) assert.ok(ids('person', f, PERSON).every((id) => id === 'person.mention'), 'a hall seat is shown only the hall page\'s half');

  // The simple view: no menu door; its composer's acts are its buttons (Send, 🔥).
  assert.deepEqual([ids('compose', SEATS.boardSimple, COMPOSE.director), plain(C.shown('compose', SEATS.boardSimple, COMPOSE.director)).map((e) => e.id)], [[], ['compose.send', 'compose.priority']]);
  assert.deepEqual([ids('person', SEATS.boardSimple, PERSON), ids('chip', SEATS.boardSimple, STAGE)], [[], []], 'nothing of a person or the chip in the simple view');

  // The bar: Send alone, named for where it sends (its aria-label and its menu item alike).
  assert.deepEqual(plain(C.inline('compose', SEATS.research, COMPOSE.text)).map((i) => [i.id, i.label]), [['compose.send', 'Send to Hall 2']]);
  // A question asks the Board in a Main room, and the room by its name in a side room; a file attached is shared.
  assert.deepEqual(plain(C.inline('compose', SEATS.research, COMPOSE.action)).map((i) => [i.label, i.icon]), [['Ask the Board', '❓']]);
  assert.deepEqual(plain(C.inline('compose', SEATS.research, { ...COMPOSE.action, askWho: 'Legal' })).map((i) => [i.label, i.icon]), [['Ask Legal', '❓']]);
  assert.deepEqual(plain(C.inline('compose', SEATS.research, COMPOSE.fileChosen)).map((i) => [i.label, i.icon]), [['Share for download', '📎']]);
  // To ▸: This room, then each room this room may send into, by its reference, named as a room is named; the one chosen
  // checked, and Send named for it.
  const toMedia = { ...COMPOSE.text, room: 'Media', to: 'rMDbbbbbbbbbbbbbbb' };
  assert.deepEqual(plain(C.submenu('compose', 'compose.sendTo', SEATS.researchSends, COMPOSE.text)), [
    { value: '', label: 'This room', role: 'menuitemradio', checked: true },
    { value: 'rH2aaaaaaaaaaaaaaa', label: 'Hall 2', role: 'menuitemradio', checked: false },
    { value: 'rMDbbbbbbbbbbbbbbb', label: 'Hall 2 › Media', role: 'menuitemradio', checked: false },
  ]);
  assert.deepEqual(plain(C.submenu('compose', 'compose.sendTo', SEATS.researchSends, toMedia)).map((v) => v.checked), [false, false, true]);
  assert.deepEqual(plain(C.inline('compose', SEATS.researchSends, toMedia)).map((i) => [i.id, i.label]), [['compose.send', 'Send to Media']]);
  assert.equal(C.entry('msg', 'msg.sendBack').label(SEATS.researchSends, OBJECTS.fromHall), 'Send back to Hall 2');
  assert.deepEqual([C.placeOf({ name: 'Legal', hallName: 'Hall 2' }), C.placeOf({ roomName: 'Hall 2', hallName: 'Hall 2' }), C.placeOf({ name: 'Legal', hallName: '' }), C.placeOf(null)],
    ['Hall 2 › Legal', 'Hall 2', 'A hall with no name › Legal', 'another room']);
  // The server's readers of a send's mark (the transcript, the AI's thread: lib/ops.js placeOf) name a room as the pages do.
  for (const mark of [{ roomName: 'Legal', hallName: 'Hall 2' }, { roomName: 'Hall 2', hallName: 'Hall 2' }, { roomName: 'Legal', hallName: '' }, { roomName: '', hallName: 'Hall 2' }, { roomName: '', hallName: '' }, {}, null]) {
    assert.equal(ops.placeOf(mark), C.placeOf(mark), JSON.stringify(mark));
  }
  // How long a withdrawn send was there, said alike by the pages and by the server's readers and rows (lib/ops.js lasted).
  const spans = [-5, 0, 999, 1000, 40_999, 59_999, 60_000, 3_599_999, 3_600_000, 3_725_000, 86_399_999, 86_400_000, 97_200_000, 90_000_000, NaN, Infinity, '40000', null];
  assert.deepEqual(spans.map((ms) => C.lasted(ms)), ['0 s', '0 s', '0 s', '1 s', '40 s', '59 s', '1 min', '59 min', '1 h', '1 h 2 min', '23 h 59 min', '1 d', '1 d 3 h', '1 d 1 h', '0 s', '0 s', '0 s', '0 s']);
  for (const ms of spans) assert.equal(ops.lasted(ms), C.lasted(ms), String(ms));
  assert.deepEqual(plain(C.inline('compose', SEATS.board, COMPOSE.directorReplying)).map((i) => [i.id, i.label]), [['compose.send', 'Send']], 'before the room is named: Send');
  // With a file attached, Send reads 📎 Share for download, and Share in Legal with To: set.
  assert.deepEqual(plain(C.inline('compose', SEATS.research, COMPOSE.fileChosen)).map((i) => [i.id, i.label, i.icon]), [['compose.send', 'Share for download', '📎']]);
  assert.deepEqual(plain(C.inline('compose', SEATS.researchSends, { ...COMPOSE.fileChosen, room: 'Legal', to: 'rLGcccccccccccccccc' })).map((i) => i.label), ['Share in Legal']);
  for (const [kind, o] of [['chip', STAGE], ['header', HEADER], ['person', PERSON]]) assert.deepEqual(plain(C.inline(kind, SEATS.admin, o)), [], kind + ': no act on a row, only the menu');

  // Disabled, with the reason: AI drafts off, the link down, no screens, not connected; a send held by the outbox stays
  // live; the support view acts on nothing.
  const why = (seat, kind, o) => Object.fromEntries(plain(C.items(kind, SEATS[seat], o)).filter((i) => !i.sep).map((i) => [i.id, i.disabled || i.held || '']));
  assert.equal(why('researchAlone', 'compose', COMPOSE.text)['compose.draft'], C.WORDS.aiOff, 'AI drafts off: shown, with why');
  assert.deepEqual(why('researchLinkDown', 'chip', STAGE), { 'chip.speaker': C.WORDS.linkDown });
  assert.deepEqual(why('techNoScreens', 'chip', STAGE), { 'chip.speaker': '', 'chip.screens': C.WORDS.noScreens });
  assert.deepEqual(why('researchOffline', 'compose', COMPOSE.text), { 'compose.draft': C.WORDS.offline, 'compose.send': C.WORDS.held, 'compose.priority': '', 'compose.attach': '' });
  assert.deepEqual(why('researchOffline', 'chip', STAGE), { 'chip.speaker': C.WORDS.offline });
  assert.deepEqual([...new Set(Object.values(why('support', 'compose', COMPOSE.text)))], [C.supportWords('Kim')], 'the support view: every act disabled, whose view it is');

  // 🔥 Priority is a toggle in the menu: checked while pressed.
  const pri = (o) => plain(C.items('compose', SEATS.research, o)).find((i) => i.id === 'compose.priority');
  assert.deepEqual([pri(COMPOSE.text).role, pri(COMPOSE.text).checked, pri(COMPOSE.replying).checked], ['menuitemcheckbox', false, true]);
  assert.equal(plain(C.items('header', SEATS.research, HEADER)).find((i) => i.id === 'header.code').role, undefined, 'an act that is no toggle is a plain item');
  // The admin's two acts on the code: Turn the code off… asks the three-way choice (the guests stay, or are sent out),
  // Turn the code on asks nothing, New code… says who stays and what stops; each refused offline, and none in the support
  // view.
  const codeItems = (f, o) => plain(C.items('header', f, o)).filter((i) => !i.sep && /^header\.(code|copy|codeToggle|newCode)$/.test(i.id)).map((i) => [i.id, i.label, i.asks, i.disabled]);
  assert.deepEqual(codeItems(SEATS.admin, HEADER), [['header.code', 'Copy guest code K7P2QX', false, ''], ['header.copy', 'Copy join link', false, ''], ['header.codeToggle', 'Turn the code off…', true, ''], ['header.newCode', 'New code…', true, '']]);
  assert.deepEqual(codeItems(SEATS.admin, HEADER_OFF).slice(0, 3).map((x) => x.slice(1, 3)), [['Copy guest code K7P2QX (off)', false], ['Copy join link', false], ['Turn the code on', false]], 'a code that is off says so where it is copied');
  assert.deepEqual(codeItems(SEATS.adminOffline, HEADER).map((x) => x[3]), ['', '', C.WORDS.offline, C.WORDS.offline]);
  assert.deepEqual(plain(C.entry('header', 'header.codeToggle').confirm(SEATS.admin, HEADER)), {
    title: 'Turn off the guest code of Hall 2?',
    words: ['Turn off: nobody new joins with it, and a guest already in comes back within a few seconds of a dropped connection. Turn off and send them out: every guest page closes, and its seat goes. Accounts stay either way.'],
    choices: [{ answer: 'keep', label: 'Turn off' }, { answer: 'out', label: 'Turn off and send them out', danger: true }], no: 'Keep it on' });
  assert.deepEqual(plain(C.entry('header', 'header.newCode').confirm(SEATS.admin, HEADER)), { title: 'New guest code for Hall 2?', words: ['Guests in the room now stay. Anyone joining or reconnecting after a long break needs the new code, and the invite links made with this one stop working.'], yes: 'Make a new code', no: 'Keep this code' });

  // The caps, on the richest seat of each kind.
  for (const [kind, o] of [['compose', COMPOSE.replying], ['chip', STAGE], ['header', HEADER], ['person', PERSON]]) {
    const items = plain(C.items(kind, SEATS.admin, o)).filter((i) => !i.sep);
    assert.ok(items.length > 0 && items.length <= 12 && items.filter((i) => i.group === '9_danger').length <= 2, kind + ': at most 12 items and 2 dangers');
  }
});

// ---------------------------------------------------------------- the header's ⋯
test('the header\'s ⋯: People, Screens…, Text size ▸, Dark theme, the guest code and the way out, Leave last behind its separator; toggles checked as they stand; the simple view has none; the support view acts on none', () => {
  const menu = (f, o) => plain(C.items('header', f, o)).map((i) => (i.sep ? '—' : [i.id, i.label, i.role || '', i.checked === undefined ? '' : i.checked, i.submenu]));
  assert.deepEqual(menu(SEATS.tech, HEADER), [
    ['header.people', 'People · 3', 'menuitemcheckbox', false, false], ['header.screens', 'Screens & pages…', '', '', false], ['header.size', 'Text size', '', '', true],
    ['header.theme', 'Dark theme', 'menuitemcheckbox', false, false], ['header.code', 'Copy guest code K7P2QX', '', '', false], ['header.copy', 'Copy join link', '', '', false],
    '—', ['header.leave', 'Leave', '', '', false]]);
  // An account's way out is its halls; the panel open and the dark theme checked; no code told, none offered.
  assert.deepEqual(menu(SEATS.staff, HEADER_ACCOUNT), [['header.people', 'People · 3', 'menuitemcheckbox', true, false], ['header.size', 'Text size', '', '', true], ['header.theme', 'Dark theme', 'menuitemcheckbox', true, false], '—', ['header.leave', 'All halls', '', '', false]]);
  // Text size ▸: the sizes, one checked where the text is that size, none where it is between two.
  const sizes = (zoom) => plain(C.submenu('header', 'header.size', SEATS.board, { ...HEADER, zoom }));
  assert.deepEqual(sizes(1).map((v) => [v.value, v.label, v.role, v.checked]), [[0.85, 'Small', 'menuitemradio', false], [1, 'Standard', 'menuitemradio', true], [1.15, 'Large', 'menuitemradio', false], [1.3, 'Larger', 'menuitemradio', false], [1.6, 'Very large', 'menuitemradio', false], [2, 'Largest', 'menuitemradio', false]]);
  assert.deepEqual(sizes(1.3).filter((v) => v.checked).map((v) => v.label), ['Larger']);
  assert.deepEqual(sizes(2).filter((v) => v.checked).map((v) => v.label), ['Largest'], 'up to twice the standard size');
  assert.deepEqual(sizes(1.1).filter((v) => v.checked), [], 'a size between two checks neither');
  // The richest seat's menu holds 12 items or fewer, none of them a danger; nothing is drawn in the simple view.
  const admin = plain(C.items('header', SEATS.admin, HEADER)).filter((i) => !i.sep);
  assert.ok(admin.length <= 12 && admin.every((i) => i.group !== '9_danger'), JSON.stringify(admin.map((i) => i.id)));
  assert.equal(admin[admin.length - 1].id, 'header.leave', 'the way out is last');
  assert.deepEqual([ids('header', SEATS.boardSimple, HEADER), ids('header', SEATS.boardAccountSimple, HEADER)], [[], []], 'the simple view has no menu door: its sheet is its own');
  // While the page is down, what acts on this page alone acts, and Screens… (which reads the screens' list) and the code's
  // switch and renewal say why not.
  const offline = Object.fromEntries(plain(C.items('header', SEATS.adminOffline, HEADER)).filter((i) => !i.sep).map((i) => [i.id, i.disabled]));
  assert.deepEqual(offline, { 'header.people': '', 'header.screens': C.WORDS.offline, 'header.size': '', 'header.theme': '', 'header.code': '', 'header.copy': '', 'header.codeToggle': C.WORDS.offline, 'header.newCode': C.WORDS.offline, 'header.leave': '' });
  // The support view: the person's menu, every item disabled with whose view it is.
  const sv = plain(C.items('header', SEATS.support, HEADER)).filter((i) => !i.sep);
  assert.ok(sv.length >= 6 && sv.every((i) => i.disabled === C.supportWords('Kim')), JSON.stringify(sv.map((i) => [i.id, i.disabled])));
});

test('the marks: one table, each mark one name, one meaning and a colour role of the tokens; a chip\'s mark is the table\'s, and a name that is none is refused', () => {
  const table = plain(AGM.MARKS);
  assert.deepEqual(Object.keys(table), ['ok', 'partly', 'unseen', 'minimised', 'off', 'withdrawn', 'waiting', 'couldNot', 'fault', 'urgent', 'coming', 'note', 'soon']);
  assert.deepEqual(Object.values(table).map((m) => m.mark).join(''), '✓◐◇▭○⊘◷△✕■▶●▲');
  assert.equal(new Set(Object.values(table).map((m) => m.mark)).size, 13, 'no mark is given two names');
  const css = readSource(path.join(ROOT, 'public', 'styles.css'));
  for (const [name, m] of Object.entries(table)) {
    assert.ok(['ok', 'warn', 'info', 'fault', 'off'].includes(m.role) && css.includes('--c-' + m.role + ':'), name + ': its colour role is a token (--c-' + m.role + ')');
    assert.ok(typeof m.means === 'string' && m.means.length > 3, name + ': its meaning');
    assert.equal(AGM.mark(name), m.mark);
    assert.equal(AGM.markOf(m.mark), name, 'its name read back from its mark');
  }
  assert.equal(table.fault.role, 'fault', 'red is a fault\'s');
  assert.deepEqual(Object.entries(table).filter(([, m]) => m.role === 'fault').map(([n]) => n), ['fault', 'urgent'], 'and only a fault\'s or an urgent wait\'s');
  assert.throws(() => AGM.mark('sending'), /No mark is named sending/);
  assert.throws(() => AGM.mark('toString'), /No mark is named toString/, 'only the table\'s own names');
  // A chip and a status line hold to the same names: a chip named for no mark, an inherited name included, is refused
  // before anything is drawn; a line's colour is the role of the table's mark it starts with, and none for words alone.
  const el = () => ({ textContent: '', dataset: {}, classList: { add() {} }, querySelector() { return null; } });
  for (const name of ['toString', 'constructor', 'sending']) assert.throws(() => AGM.chip(el(), name, 'x'), (e) => e.message === 'No mark is named ' + name, name);
  const line = (text) => { const l = el(); AGM.toned(l, text); return [l.textContent, l.dataset.tone]; };
  assert.deepEqual([line(AGM.mark('couldNot') + ' Approved but it failed'), line(AGM.mark('coming') + ' Ana is on the way'), line('Sent to Stagewatch'), line('✔ not the table\'s')],
    [[AGM.mark('couldNot') + ' Approved but it failed', 'warn'], [AGM.mark('coming') + ' Ana is on the way', 'info'], ['Sent to Stagewatch', undefined], ['✔ not the table\'s', undefined]]);
  assert.equal(AGM.markOf('…'), '', 'a retired mark is none of them');
  // The catalogue's own words name their marks from the table: an act held by the outbox says ◷.
  assert.equal(C.WORDS.held.split(' ')[0], AGM.mark('waiting'));
  for (const f of Object.values(C.FOLDS)) assert.ok(!MARKS.includes(f.icon), 'a fold\'s icon is no mark: ' + f.icon);
});

// ---------------------------------------------------------------- the admin page, the halls board, the Accounts page
test('the other pages\' facts: read from the server\'s answers, and nothing a page could name for itself', () => {
  assert.deepEqual(plain(C.adminFacts({ ok: 1, admin: 0, ai: 'yes', halls: [{ code: 'K7P2QX', name: 'Hall 2', extra: 1 }, { name: 'no code' }, null], connected: true, role: 'admin' })),
    { page: 'admin', admin: true, theAdmin: false, manageUsers: false, canDrive: true, ai: true, halls: [{ code: 'K7P2QX', name: 'Hall 2' }], connected: true, support: '' }, 'the gate\'s answer, "the admin", the drive right it carries, AI, the halls by code and name');
  assert.deepEqual(plain(C.adminFacts({})), { page: 'admin', admin: false, theAdmin: false, manageUsers: false, canDrive: false, ai: false, halls: [], connected: false, support: '' }, 'nothing told: no right');
  // Members… is offered on the server's word that this account may manage accounts, a true and nothing like it.
  assert.deepEqual([C.adminFacts({ ok: true, manageUsers: true }).manageUsers, C.adminFacts({ ok: true, manageUsers: 'yes' }).manageUsers, C.adminFacts({ ok: true, manageUsers: 1 }).manageUsers], [true, false, false]);
  assert.deepEqual(plain(C.boardFacts({ canManageHalls: true, canDrive: 1, connected: true, isAdmin: true, canManageUsers: true })), { page: 'halls', manageHalls: true, admin: true, manageUsers: true, canDrive: true, connected: true, support: '' });
  assert.deepEqual(plain(C.boardFacts({ canManageHalls: true, isAdmin: 'yes', canManageUsers: 1 })), { page: 'halls', manageHalls: true, admin: false, manageUsers: false, canDrive: false, connected: false, support: '' }, 'the admin and Members… only on a true');
  assert.deepEqual(plain(C.accountFacts({ account: { id: 'a-1', rights: { caps: ['users.manage', 'audit.read', 'audit.export'] } }, admin: true, filter: { by: 'actor', value: 'account:a-2', words: 'x' } })),
    { page: 'accounts', uid: 'a-1', manageUsers: true, auditRead: true, auditExport: true, theAdmin: true, filter: { by: 'actor', value: 'account:a-2' }, connected: true, support: '' });
  assert.deepEqual([C.accountFacts({ account: { rights: { caps: ['audit.export'] } } }).auditExport, C.accountFacts({ filter: { by: 'role', value: 'x' } }).filter, C.accountFacts({}).connected],
    [false, null, true], 'an export reads every entry (audit.read as well); a filter of no known kind is none; HTTP has no connection to lose');
});

test('the other pages\' matrix: what each seat is shown on each object of the admin page, the halls board and the Accounts page', () => {
  const O = PAGE_OBJECTS;
  const M = [
    // A hall: Watch, its transcript, the minutes and its seats' lock, a room made in it, its name; clearing and closing it
    // last. Watched, no Watch. A side room: the same but its seats' lock (its guest code's) and a room made in it.
    ['adminRoom', 'admin', O.adminRoom.listed, ['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.create', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    ['adminRoom', 'admin', O.adminRoom.watched, ['adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.create', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    ['adminRoom', 'manager', O.adminRoom.listed, ['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.create', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    // A side room's invites are a Member's, made with its own code; no room is made in a room.
    ['adminRoom', 'admin', O.adminRoom.side, ['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    ['adminRoom', 'admin', O.adminRoom.sideWatched, ['adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    ['adminRoom', 'notAdmin', O.adminRoom.listed, []],
    ['adminRoom', 'notAdmin', O.adminRoom.side, []],
    // An admin account, which manages accounts: Members… on a side room, Board members… on a hall, beside its code.
    ['adminRoom', 'adminUsers', O.adminRoom.listed, ['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.create', 'adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    ['adminRoom', 'adminUsers', O.adminRoom.side, ['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']],
    // Set up's Rooms on the halls board: the hall's name is Set up's own and the hall is closed on the admin page, so its
    // Main room has no Rename… or Close; none of the admin page's own acts. One who sets halls up makes and names rooms;
    // the admin switches and renews codes and removes a room; one who manages accounts chooses members; a crew, nothing.
    ['adminRoom', 'boardAdmin', O.adminRoom.listed, ['adminRoom.create', 'adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode']],
    ['adminRoom', 'boardAdmin', O.adminRoom.side, ['adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.remove']],
    ['adminRoom', 'board', O.adminRoom.listed, ['adminRoom.create']],
    ['adminRoom', 'board', O.adminRoom.side, ['adminRoom.rename']],
    ['adminRoom', 'boardUsers', O.adminRoom.side, ['adminRoom.members']],
    ['adminRoom', 'boardCrew', O.adminRoom.listed, []],
    ['adminRoom', 'boardCrew', O.adminRoom.side, []],
    // A person: a code guest's seat is the admin's to set; an account's follows its rights (no Seat).
    // Chat view ▸ first, for every person seated here, a guest's or an account's.
    ['person', 'admin', O.person.guest, ['person.chatView', 'person.seat', 'person.forward', 'person.view', 'person.kick']],
    ['person', 'admin', O.person.account, ['person.chatView', 'person.forward', 'person.unforward', 'person.view', 'person.kick']],
    ['person', 'notAdmin', O.person.guest, []],
    ['adminMsg', 'admin', O.adminMsg.text, ['adminMsg.copy', 'adminMsg.delete']],
    // A file of the watched room: ⬇ Download, the server's act by a ticket, as on the hall page.
    ['adminMsg', 'admin', O.adminMsg.file, ['adminMsg.download', 'adminMsg.confidential', 'adminMsg.delete']],
    ['adminMsg', 'admin', { ...O.adminMsg.file, url: undefined }, ['adminMsg.delete']],
    ['adminMsg', 'notAdmin', O.adminMsg.text, []],
    // The links: the default Stagewatch (set up in one form, its certificate accepted only when it changed), one heard (its
    // address used), a Patterns or PlayMap heard (linked with its token) and linked (proposed to, set up, confirmed,
    // unlinked); a presenter PC heard is no link.
    ['link', 'admin', O.link.stagewatch, ['link.copy', 'link.configure']],
    ['link', 'admin', O.link.stagewatchChanged, ['link.copy', 'link.configure', 'link.accept']],
    ['link', 'admin', O.link.heardStagewatch, ['link.use', 'link.copy']],
    ['link', 'admin', O.link.heardNode, ['link.setup']],
    ['link', 'admin', O.link.node, ['link.propose', 'link.setup', 'link.unlink']],
    ['link', 'admin', O.link.nodeWaits, ['link.propose', 'link.setup', 'link.confirm', 'link.unlink']],
    ['link', 'admin', O.link.nodeQuiet, ['link.setup', 'link.unlink']],
    ['link', 'admin', O.link.heardAgent, []],
    ['link', 'notAdmin', O.link.node, []],
    ['tunnel', 'admin', O.tunnel.off, ['tunnel.check', 'tunnel.on']],
    ['tunnel', 'admin', O.tunnel.on, ['tunnel.check', 'tunnel.copy', 'tunnel.until', 'tunnel.off']],
    ['tunnel', 'admin', O.tunnel.starting, ['tunnel.check', 'tunnel.until', 'tunnel.off']],
    ['tunnel', 'admin', O.tunnel.kept, ['tunnel.check', 'tunnel.on', 'tunnel.off']],
    ['tunnel', 'notAdmin', O.tunnel.on, []],
    // "This laptop": read again, and each LAN address copied, where it has one.
    ['laptop', 'admin', O.laptop.two, ['laptop.refresh', 'laptop.copy']],
    ['laptop', 'admin', O.laptop.none, ['laptop.refresh']],
    ['laptop', 'notAdmin', O.laptop.two, []],
    // A hall's row: opened (here or in a tab) by everyone it is listed for, its guest code copied where the server told it;
    // set up and the show network by right.
    ['hall', 'board', O.hall.row, ['hall.open', 'hall.tab', 'hall.copy', 'hall.code', 'hall.setup', 'hall.network']],
    ['hall', 'boardCrew', O.hall.row, ['hall.open', 'hall.tab', 'hall.copy', 'hall.code']],
    ['hall', 'boardCrew', O.hall.untold, ['hall.open', 'hall.tab', 'hall.copy']],
    // With side rooms this watcher may enter: Rooms ▸ beside Open Main.
    ['hall', 'board', O.hall.rooms, ['hall.open', 'hall.tab', 'hall.rooms', 'hall.copy', 'hall.code', 'hall.setup', 'hall.network']],
    ['hall', 'boardCrew', O.hall.rooms, ['hall.open', 'hall.tab', 'hall.rooms', 'hall.copy', 'hall.code']],
    // A room button: opened here or in a tab and its link copied by everyone it is listed for; its guest code copied where
    // the server told it; its hall's Set up by one who sets halls up. Under Your rooms, a hall not seen: no Set up.
    ['room', 'board', O.room.button, ['room.open', 'room.tab', 'room.copy', 'room.code', 'room.setup']],
    ['room', 'boardCrew', O.room.button, ['room.open', 'room.tab', 'room.copy', 'room.code']],
    ['room', 'boardCrew', O.room.untold, ['room.open', 'room.tab', 'room.copy']],
    ['room', 'board', O.room.yours, ['room.open', 'room.tab', 'room.copy']],
    // The hall page's switcher: this room is not opened again; its code copied where the page is told it (never On
    // stage); another room opened. No Set up on the hall page, whatever the account holds; no menu in the simple view.
    ['room', 'research', O.room.here, ['room.tab', 'room.copy', 'room.code']],
    ['room', 'research', O.room.there, ['room.open', 'room.tab', 'room.copy']],
    ['room', 'board', { ...O.room.here, guestCode: '' }, ['room.tab', 'room.copy']],
    ['room', 'admin', O.room.there, ['room.open', 'room.tab', 'room.copy']],
    ['room', 'boardSimple', O.room.there, []],
    // A room of the switcher with news this person has not read there (its dot, or 🔥): Mark as read, a local act that
    // goes on offline. Never on this room, which is read as it is shown; never on the halls board, whose rooms carry no
    // news; no menu in the simple view.
    ['room', 'research', O.room.news, ['room.open', 'room.tab', 'room.copy', 'room.markRead']],
    ['room', 'researchOffline', O.room.hot, ['room.open', 'room.tab', 'room.copy', 'room.markRead']],
    ['room', 'research', { ...O.room.here, news: 'news' }, ['room.tab', 'room.copy', 'room.code']],
    ['room', 'board', { ...O.room.button, news: 'priority' }, ['room.open', 'room.tab', 'room.copy', 'room.code', 'room.setup']],
    ['room', 'boardSimple', O.room.hot, []],
    ['help', 'board', O.help.open, ['help.respond', 'help.resolve', 'help.open']],
    ['help', 'board', O.help.coming, ['help.resolve', 'help.open']],
    ['help', 'boardCrew', O.help.notTheirs, ['help.open']],
    // A side room's: opened where this account reads it; answered from the board alone by the hall's crew who may not read it.
    ['help', 'boardCrew', O.help.side, ['help.respond', 'help.resolve', 'help.open']],
    ['help', 'boardCrew', O.help.sideCrew, ['help.resolve']],
    // An account: Edit, a new one-time password and Sign out everywhere; Turn off and Remove last, never on one's own;
    // a locked row keeps Edit alone (disabled, with its reason); one who reads only the log is shown none.
    ['account', 'accountsAdmin', O.account.other, ['account.edit', 'account.password', 'account.signout', 'account.disable', 'account.remove']],
    ['account', 'accountsAdmin', O.account.self, ['account.edit', 'account.password', 'account.signout']],
    ['account', 'accountsManager', O.account.locked, ['account.edit']],
    ['account', 'auditor', O.account.other, []],
    // An entry of the log: copied, the list kept to its actor or its target, the whole log checked and exported; split
    // at an archive point by the admin alone; a manager exports nothing (audit.export is the admin's).
    ['audit', 'accountsAdmin', O.audit.entry, ['audit.copy', 'audit.actor', 'audit.target', 'audit.check', 'audit.export']],
    ['audit', 'accountsAdmin', O.audit.archive, ['audit.copy', 'audit.actor', 'audit.target', 'audit.check', 'audit.export', 'audit.split']],
    ['audit', 'accountsManager', O.audit.archive, ['audit.copy', 'audit.actor', 'audit.target', 'audit.check']],
    ['audit', 'auditor', O.audit.noTarget, ['audit.copy', 'audit.actor', 'audit.check']],
    ['audit', 'auditor', O.audit.bad, ['audit.copy', 'audit.check']],
    ['audit', 'filtered', O.audit.entry, ['audit.copy', 'audit.target', 'audit.all', 'audit.check', 'audit.export']],
    ['audit', 'accountsManager', O.audit.entry, ['audit.copy', 'audit.actor', 'audit.target', 'audit.check']],
  ];
  // The person kind's other half, the hall page's (a seat there, read by its facts): it mentions a person; a seat that may
  // change what people's pages show shows them a take, or hands them back to their chat, once the page knows their key.
  M.push(['person', 'research', O.person.guest, ['person.mention']]);
  // A document on their pages too, by the short bar (Show them a document…).
  M.push(['person', 'techPush', { ...O.person.guest, key: 'u:u-kim', kind: 'clock' }, ['person.mention', 'person.show', 'person.doc', 'person.chat']]);
  // A web page on their pages too, for a seat that may show one (canWeb).
  M.push(['person', 'guestWeb', { ...O.person.guest, key: 'u:u-kim', kind: 'clock' }, ['person.mention', 'person.show', 'person.web', 'person.doc', 'person.chat']]);
  // Information over their show: Take down, for the operator (canPush), and for a seat that may only show, on a person On
  // stage alone (the console lists no one else to it).
  M.push(['person', 'techPush', { ...O.person.guest, key: 'u:u-kim', kind: 'clock', info: INFO_SHOWN }, ['person.mention', 'person.show', 'person.doc', 'person.chat', 'person.takeDown', 'person.withdraw']]);
  M.push(['person', 'staffShowWeb', { ...O.person.guest, role: 'board', key: 'u:u-kim', kind: 'clock', info: INFO_SHOWN }, ['person.mention', 'person.web', 'person.doc', 'person.takeDown', 'person.withdraw']]);
  M.push(['person', 'staffShowWeb', { ...O.person.guest, key: 'u:u-kim', kind: 'clock', info: INFO_SHOWN }, ['person.mention']]);
  // A document on their pages that some of them could not open, in the console: Show them a picture (plan 4-§5.15.2).
  M.push(['person', 'techPush', { ...O.person.guest, key: 'u:u-kim', kind: 'clock', where: 'console', info: DOC_INFO, standin: { said: 'a picture of p. 12' } }, ['person.show', 'person.doc', 'person.chat', 'person.takeDown', 'person.picture', 'person.withdraw']]);
  const facts = (seat) => PAGE[seat] || SEATS[seat];
  for (const [kind, seat, o, want] of M) assert.deepEqual(ids(kind, facts(seat), o), want, kind + ' · ' + seat + ' on ' + JSON.stringify(o).slice(0, 60));
  // Every act of these kinds is shown to some seat: none passes the matrix by its absence.
  const kinds = ['adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop', 'hall', 'room', 'help', 'account', 'audit'];
  const shownSomewhere = new Set(M.flatMap((r) => r[3]));
  for (const k of kinds) for (const e of C.KINDS[k]) assert.ok(shownSomewhere.has(e.id), e.id + ' is shown to some seat in the matrix');
  // Every act a seat is shown is one its rights allow: the admin page's acts need its gate, the split "the admin".
  for (const k of ['adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop']) for (const o of Object.values(PAGE_OBJECTS[k])) assert.deepEqual(ids(k, PAGE.notAdmin, o), [], k + ': nothing to a page the admin page\'s gate does not admit');
  // The admin page's own acts are never drawn in Set up, whoever looks: their runners are the admin page's.
  for (const seat of ['board', 'boardCrew', 'boardAdmin', 'boardUsers']) for (const o of Object.values(PAGE_OBJECTS.adminRoom)) {
    assert.deepEqual(ids('adminRoom', PAGE[seat], o).filter((id) => /\.(watch|transcript|minutes|invites|clear)$/.test(id)), [], seat);
  }
});

test('the other pages: what may be done but not now is shown, disabled, with the words why', () => {
  const O = PAGE_OBJECTS;
  const why = (kind, seat, o) => Object.fromEntries(plain(C.items(kind, PAGE[seat], o)).filter((i) => !i.sep).map((i) => [i.id, i.disabled]));
  // Check again: off, waiting for its address, a check running, and one in the last minute each say why; after it, ready.
  assert.deepEqual([O.tunnel.off, O.tunnel.starting, O.tunnel.checking, O.tunnel.justChecked, O.tunnel.on].map((o) => C.ready('tunnel', 'tunnel.check', PAGE.admin, o)),
    ['The internet link is off.', 'Waiting for Cloudflare to give the address.', 'Checking the internet link…', 'Checked 20 s ago.', true]);
  // A locked account: Edit shown, disabled with the server's words, so they can be read on a touch screen too.
  assert.deepEqual(why('account', 'accountsManager', O.account.locked), { 'account.edit': 'Only an admin may change an admin\'s account.' });
  // The minutes with no AI key, and a line to a node whose Stagewatch keeps no show desk.
  assert.equal(why('adminRoom', 'adminNoAi', O.adminRoom.listed)['adminRoom.minutes'], C.WORDS.noAi);
  assert.equal(why('link', 'admin', O.link.nodeWaits)['link.propose'], 'PlayMap 1\'s lines go to the show desk, and its Stagewatch keeps none now — nothing can be proposed.');
  // Not connected: an act on something says so; one that sends nothing (the transcript, a copy) goes on.
  assert.deepEqual(why('adminRoom', 'adminOffline', O.adminRoom.listed), {
    'adminRoom.watch': C.WORDS.offline, 'adminRoom.transcript': '', 'adminRoom.minutes': C.WORDS.offline, 'adminRoom.invites': C.WORDS.offline,
    'adminRoom.create': C.WORDS.offline, 'adminRoom.sendFrom': C.WORDS.offline, 'adminRoom.codeToggle': C.WORDS.offline, 'adminRoom.newCode': C.WORDS.offline,
    'adminRoom.rename': C.WORDS.offline, 'adminRoom.clear': C.WORDS.offline, 'adminRoom.remove': C.WORDS.offline,
  });
  assert.deepEqual(why('adminMsg', 'adminOffline', O.adminMsg.text), { 'adminMsg.copy': '', 'adminMsg.delete': C.WORDS.offline });
  // "This laptop": Refresh while Windows is read says so, and offline says so too; a copy sends nothing, so it goes on.
  assert.deepEqual(why('laptop', 'admin', O.laptop.reading), { 'laptop.refresh': 'Reading Windows\' facts now…', 'laptop.copy': '' });
  assert.deepEqual(why('laptop', 'adminOffline', O.laptop.two), { 'laptop.refresh': C.WORDS.offline, 'laptop.copy': '' });
  // The Accounts page has no socket: nothing there is refused for a connection.
  assert.deepEqual(Object.values(why('account', 'accountsAdmin', O.account.other)).filter(Boolean), []);
});

test('the other pages: the inline bar, the asks and their words, the caps and the keys', () => {
  const O = PAGE_OBJECTS;
  const bar = (kind, seat, o) => plain(C.inline(kind, PAGE[seat], o)).map((i) => i.id);
  assert.deepEqual(bar('adminRoom', 'admin', O.adminRoom.listed), ['adminRoom.watch'], 'a hall in the list: Watch');
  assert.deepEqual(bar('adminRoom', 'admin', O.adminRoom.watched), [], 'the watched hall\'s header: only ⋯');
  assert.deepEqual([bar('adminRoom', 'admin', O.adminRoom.side), bar('adminRoom', 'admin', O.adminRoom.sideWatched)], [['adminRoom.watch'], []], 'a side room\'s row as a hall\'s');
  assert.deepEqual(bar('person', 'admin', O.person.guest), [], 'a person\'s row keeps its Seat select, and a ⋯');
  assert.deepEqual(bar('link', 'admin', O.link.heardStagewatch), ['link.use']);
  assert.deepEqual(bar('link', 'admin', O.link.nodeWaits), ['link.confirm', 'link.setup']);
  assert.deepEqual(bar('link', 'admin', O.link.stagewatchChanged), ['link.accept']);
  assert.deepEqual(bar('tunnel', 'admin', O.tunnel.on), ['tunnel.check', 'tunnel.copy']);
  assert.deepEqual(bar('laptop', 'admin', O.laptop.two), ['laptop.refresh', 'laptop.copy'], '"This laptop": Refresh, then Copy LAN address');
  // Copy LAN address ▸: each address, as devices open it.
  assert.deepEqual(plain(C.submenu('laptop', 'laptop.copy', PAGE.admin, O.laptop.two)), [{ value: 'http://192.168.1.20:3023', label: 'http://192.168.1.20:3023' }, { value: 'http://10.0.4.7:3023', label: 'http://10.0.4.7:3023' }]);
  assert.deepEqual(bar('hall', 'board', O.hall.row), [], 'a hall\'s row opens by its name, its one link');
  // A room is its own link: no bar, wherever it is drawn; Enter on it opens it, and nothing on the room this page is in.
  for (const o of Object.values(O.room)) assert.deepEqual([bar('room', 'board', o), plain(C.inline('room', SEATS.research, o))], [[], []], 'a room has no bar of its own');
  assert.deepEqual([(C.byKey('room', PAGE.board, O.room.button, 'Enter') || {}).id, (C.byKey('room', SEATS.research, O.room.there, 'Enter') || {}).id, C.byKey('room', SEATS.research, O.room.here, 'Enter')], ['room.open', 'room.open', null]);
  // Its menu: its ways in, then what one hands out or sets up for it (Open · Open in a new tab · Copy link — Copy guest
  // code · Set up…).
  assert.deepEqual(plain(C.items('room', PAGE.board, O.room.button)).map((i) => (i.sep ? '—' : i.id)), ['room.open', 'room.tab', 'room.copy', '—', 'room.code', 'room.setup']);
  // On the switcher, a room with news: its ways in, then Mark as read set apart (Open · Open in a new tab · Copy link —
  // Mark as read), its words the plan's; offline it goes on, a local act.
  assert.deepEqual(plain(C.items('room', SEATS.research, O.room.news)).map((i) => (i.sep ? '—' : i.id + ':' + i.label)), ['room.open:Open', 'room.tab:Open in a new tab', 'room.copy:Copy link', '—', 'room.markRead:Mark as read']);
  assert.equal(plain(C.items('room', SEATS.researchOffline, O.room.hot)).find((i) => i.id === 'room.markRead').disabled, '');
  // Mark as read is a group of its own: were a room's guest code and its Set up ever to fit beside it, the menu would still
  // read as the plan draws it (Open · Open in a new tab · Copy link — Mark as read — Copy guest code · Set up…).
  const every = { ...O.room.news, guestCode: 'K3TW9A', hallKey: 'K7P2QX' };
  assert.deepEqual(plain(C.items('room', { ...SEATS.research, manageHalls: true }, every)).map((i) => (i.sep ? '—' : i.id)), ['room.open', 'room.tab', 'room.copy', '—', 'room.markRead', '—', 'room.code', 'room.setup']);
  assert.ok(C.GROUPS.indexOf('3_keep') < C.GROUPS.indexOf('3_mark') && C.GROUPS.indexOf('3_mark') < C.GROUPS.indexOf('4_manage'));
  // The support view draws the switcher's doors, every one disabled with whose view it is; offline, Set up says so and
  // the local acts go on.
  assert.deepEqual([...new Set(plain(C.items('room', SEATS.support, O.room.there)).filter((i) => !i.sep).map((i) => i.disabled))], [C.supportWords('Kim')]);
  assert.deepEqual(Object.fromEntries(plain(C.items('room', C.boardFacts({ canManageHalls: true, connected: false }), O.room.button)).filter((i) => !i.sep).map((i) => [i.id, i.disabled])),
    { 'room.open': '', 'room.tab': '', 'room.copy': '', 'room.code': '', 'room.setup': C.WORDS.offline });
  assert.deepEqual(bar('help', 'board', O.help.open), ['help.respond', 'help.resolve'], 'a help request: its two answers');
  // Its way in names what it opens: a hall's Main room, or a side room.
  assert.deepEqual([O.help.open, O.help.side].map((o) => C.items('help', PAGE.board, o).find((e) => e.id === 'help.open').label), ['Open its hall', 'Open its room']);
  assert.deepEqual(bar('account', 'accountsAdmin', O.account.other), ['account.edit']);
  assert.deepEqual(bar('audit', 'accountsAdmin', O.audit.entry), [], 'an entry: only ⋯');
  for (const kind of Object.keys(PAGE_OBJECTS)) {
    for (const [f, o] of [...pairsOf(kind), ...Object.values(PAGE).map((p) => [p, Object.values(PAGE_OBJECTS[kind])[0]])]) {
      const items = plain(C.items(kind, f, o)).filter((i) => !i.sep);
      assert.ok(items.length <= 12 && items.filter((i) => i.group === '9_danger').length <= 2, kind + ': at most 12 items and 2 dangers');
      const menu = ids(kind, f, o);
      assert.ok(plain(C.inline(kind, f, o)).every((i) => menu.includes(i.id)), kind + ': the bar is in the menu');
    }
  }
  // The asks name the object and what follows, and their buttons are verbs; a node is linked in one form of three
  // fields, its pairing token a password field kept out of the browser's memory.
  const ask = (kind, id, seat, o) => plain(C.entry(kind, id).confirm(PAGE[seat], o));
  assert.deepEqual(ask('adminRoom', 'adminRoom.clear', 'admin', O.adminRoom.listed), { title: 'Clear every message in Hall 2?', words: 'Files used nowhere else go too. Everyone stays in the hall. This cannot be undone.', yes: 'Clear messages', no: 'Keep them', danger: true });
  assert.deepEqual(ask('adminRoom', 'adminRoom.remove', 'admin', O.adminRoom.listed).fields, [{ name: 'purge', type: 'checkbox', label: 'Also delete the files shared only in this hall', value: true }]);
  // A side room is named with its hall, and removed as a room: the hall and its other rooms stay.
  const label = (id, o) => C.entry('adminRoom', id).label(PAGE.admin, o);
  assert.deepEqual([label('adminRoom.remove', O.adminRoom.listed), label('adminRoom.remove', O.adminRoom.side)], ['Close hall…', 'Remove room…']);
  // Members… of a side room; on a hall, the accounts seated On stage in its Main room: Board members….
  assert.deepEqual([label('adminRoom.members', O.adminRoom.side), label('adminRoom.members', O.adminRoom.listed)], ['Members…', 'Board members…']);
  // A hall's row with side rooms opens its Main room by name, and its rooms from Rooms ▸, each with how many are in.
  const hallLabel = (o) => C.entry('hall', 'hall.open').label(PAGE.board, o);
  assert.deepEqual([hallLabel(O.hall.row), hallLabel(O.hall.rooms)], ['Open', 'Open Main']);
  assert.deepEqual(plain(C.submenu('hall', 'hall.rooms', PAGE.board, O.hall.rooms)), [{ value: 'LGQ4MZP8', label: 'Legal · 2 in' }, { value: 'MDQ4MZP8', label: 'Media · 0 in' }]);
  assert.deepEqual(ask('adminRoom', 'adminRoom.clear', 'admin', O.adminRoom.side), { title: 'Clear every message in Hall 2 › Legal?', words: 'Files used nowhere else go too. Everyone stays in the room. This cannot be undone.', yes: 'Clear messages', no: 'Keep them', danger: true });
  assert.deepEqual(ask('adminRoom', 'adminRoom.remove', 'admin', O.adminRoom.side), {
    title: 'Remove room Hall 2 › Legal?', words: 'Everyone in it is sent out and its saved history is deleted; the hall and its other rooms stay. Open its transcript first if you need it.',
    fields: [{ name: 'purge', type: 'checkbox', label: 'Also delete the files shared only in this room', value: true }], yes: 'Remove and delete', no: 'Keep it', danger: true });
  // A room is made in a hall by its name, and a hall or a room renamed in place, its name as it is now filled in.
  assert.deepEqual(ask('adminRoom', 'adminRoom.create', 'admin', O.adminRoom.listed), {
    title: 'New room in Hall 2', words: 'A room of its own beside the hall\'s Main room (Legal, Media), with its own messages and people. Its guest code is off: the admin, and the accounts given it, go in.',
    fields: [{ name: 'name', label: 'Room name (for example Legal)', max: 80 }], yes: 'Make the room', no: 'Cancel' });
  assert.deepEqual([ask('adminRoom', 'adminRoom.rename', 'admin', O.adminRoom.listed).fields, ask('adminRoom', 'adminRoom.rename', 'admin', O.adminRoom.side).fields],
    [[{ name: 'name', label: 'Hall name', value: 'Hall 2', max: 80 }], [{ name: 'name', label: 'Room name', value: 'Legal', max: 80 }]]);
  // A room's guest code: Turn the code off… names the guest pages in with it and asks which way (they stay, or go); a code
  // that is off is turned on with no ask; New code… says who stays and what stops, and, for a hall whose code is its
  // address, that the new code separates them.
  assert.deepEqual([label('adminRoom.codeToggle', O.adminRoom.listed), label('adminRoom.codeToggle', O.adminRoom.side), C.entry('adminRoom', 'adminRoom.codeToggle').confirm(PAGE.admin, O.adminRoom.side)], ['Turn the code off…', 'Turn the code on', null]);
  assert.deepEqual(ask('adminRoom', 'adminRoom.codeToggle', 'admin', O.adminRoom.listed), {
    title: 'Turn off the guest code of Hall 2?',
    words: ['3 guest pages are in with the code.', 'Turn off: nobody new joins with it, and a guest already in comes back within a few seconds of a dropped connection. Turn off and send them out: every guest page closes, and its seat goes. Accounts stay either way.'],
    choices: [{ answer: 'keep', label: 'Turn off' }, { answer: 'out', label: 'Turn off and send them out', danger: true }], no: 'Keep it on' });
  assert.equal(ask('adminRoom', 'adminRoom.codeToggle', 'admin', { ...O.adminRoom.listed, guests: 1 }).words[0], '1 guest page is in with the code.');
  assert.deepEqual([ask('adminRoom', 'adminRoom.newCode', 'admin', O.adminRoom.listed).words, ask('adminRoom', 'adminRoom.newCode', 'admin', O.adminRoom.side).title], [[
    'Guests in the room now stay. Anyone joining or reconnecting after a long break needs the new code, and the invite links made with this one stop working.',
    'This hall\'s code is also its address: the new code separates them.'], 'New guest code for Hall 2 › Legal?']);
  assert.deepEqual([ask('adminRoom', 'adminRoom.rename', 'admin', O.adminRoom.side).title, ask('adminRoom', 'adminRoom.rename', 'admin', O.adminRoom.side).words],
    ['Rename Hall 2 › Legal', 'The room\'s new name, on its pages. Its people and messages stay.']);
  assert.deepEqual(ask('adminMsg', 'adminMsg.delete', 'admin', O.adminMsg.text), { title: 'Delete this message for everyone in Hall 2?', words: '“Capex is on slide 14” goes from every page in the hall now. This cannot be undone.', yes: 'Delete for everyone', no: 'Keep it', danger: true });
  assert.deepEqual([ask('person', 'person.kick', 'admin', O.person.guest).words, ask('person', 'person.kick', 'admin', O.person.account).words, ask('person', 'person.kick', 'admin', O.person.guest).no],
    ['Every page Kim has open here closes. Kim can join again with the code.', 'Every page Ana has open here closes. Ana\'s account still has Hall 2 and can open it again. To keep Ana out, take Hall 2 off the account on the Accounts page.', 'Keep Kim in'], 'Log out says, by case, whether they can come back');
  const form = ask('link', 'link.setup', 'admin', O.link.nodeWaits);
  assert.deepEqual(form.fields.map((x) => [x.name, x.type || 'text']), [['token', 'password'], ['hall', 'select'], ['fingerprint', 'text']], 'one form of three fields');
  assert.deepEqual(form.fields[1].options, [{ value: '', label: 'Every hall' }, { value: 'K7P2QX', label: 'Hall 2 · K7P2QX' }, { value: 'M3N4PQ', label: 'Legal · M3N4PQ' }], 'the hall from a pick list of the halls');
  assert.equal(form.fields[1].value, 'K7P2QX', 'a linked node\'s hall chosen');
  // A node linked for a hall the page does not list (closed since, or the list not read yet) keeps it, chosen: a Save
  // never moves it to every hall unasked.
  const closed = ask('link', 'link.setup', 'admin', { ...O.link.nodeWaits, hall: 'Z9Z9Z9' });
  assert.deepEqual([closed.fields[1].value, closed.fields[1].options.slice(-1)[0]], ['Z9Z9Z9', { value: 'Z9Z9Z9', label: 'Z9Z9Z9 · not listed here now' }]);
  const unread = plain(C.entry('link', 'link.setup').confirm(C.adminFacts({ ok: true, connected: true }), O.link.nodeWaits)).fields[1];
  assert.deepEqual([unread.value, unread.options.map((x) => x.value)], ['K7P2QX', ['', 'K7P2QX']], 'before the halls are read, the linked hall is still the choice');
  // The default Stagewatch is set up in one form of three fields: its address, its node key (a password field, never
  // filled), its certificate's fingerprint.
  const sw = ask('link', 'link.configure', 'admin', { ...O.link.stagewatch, keySet: true, fingerprint: 'sha256:ab12' });
  assert.deepEqual(sw.fields.map((x) => [x.name, x.type || 'text', x.value === undefined ? null : x.value]), [['url', 'text', '10.0.4.21:9924'], ['key', 'password', null], ['fingerprint', 'text', 'sha256:ab12']]);
  assert.equal(sw.fields[1].hint, 'Leave it empty to keep the saved one.');
  // No longer forward into ▸: the halls the person may forward into now, by name.
  assert.deepEqual(plain(C.submenu('person', 'person.unforward', PAGE.admin, { ...O.person.account, linkedNames: { M3N4PQ: 'Legal · M3N4PQ' } })), [{ value: 'M3N4PQ', label: 'Legal · M3N4PQ' }]);
  // Seat ▸: a hall's Main room's three seats; a side room's two, its backstage seat a Member's (no seat there is On stage).
  const seats = (o) => plain(C.submenu('person', 'person.seat', PAGE.admin, o)).map((v) => [v.value, v.label, v.checked]);
  assert.deepEqual(seats(O.person.guest), [['board', 'On stage', false], ['research', 'Backstage', true], ['observer', 'Observer', false]]);
  assert.deepEqual(seats({ ...O.person.guest, main: true }), seats(O.person.guest));
  assert.deepEqual(seats({ ...O.person.guest, main: false }), [['research', 'Member', true], ['observer', 'Observer', false]]);
  // Propose… is the drive right's (mayDriveNode admits the admin page's socket for every node).
  assert.deepEqual([C.entry('link', 'link.propose').may(PAGE.admin, O.link.node), C.entry('link', 'link.propose').may(PAGE.notAdmin, O.link.node)], [true, false]);
  assert.deepEqual([ask('account', 'account.disable', 'accountsAdmin', O.account.off), C.entry('account', 'account.disable').label(PAGE.accountsAdmin, O.account.off)], [null, 'Turn on'], 'turning an account on asks nothing');
  assert.deepEqual(ask('audit', 'audit.split', 'accountsAdmin', O.audit.archive).fields, [{ name: 'word', label: 'Type the word split to split there', max: 10 }]);
  // Tunnel until…: asked with a time of day, its end now filled in, and what the end and a restart before it do.
  assert.deepEqual(ask('tunnel', 'tunnel.until', 'admin', O.tunnel.on), {
    title: 'Keep the internet link on until…',
    words: ['It is on until 23:30 today. At the time you give, it is turned off and stays off.', 'If AGMessage starts again before then, the link is turned on again, with a new address to send to remote people.'],
    fields: [{ name: 'until', type: 'time', label: 'Until (this laptop\'s clock; a time already past today is tomorrow\'s)', value: '23:30' }],
    yes: 'Keep it on until then', no: 'Cancel',
  });
  assert.equal(ask('tunnel', 'tunnel.until', 'admin', { ...O.tunnel.starting, untilWords: '', untilClock: '' }).words[0], 'It is on. At the time you give, it is turned off and stays off.', 'no end read yet: none named');
  // Turn off…: on, it cuts everyone off; off with its end kept, it keeps the link off, so no start before the end turns it on.
  assert.deepEqual([O.tunnel.on, O.tunnel.kept].map((o) => { const a = ask('tunnel', 'tunnel.off', 'admin', o); return [a.title, a.yes, a.danger]; }),
    [['Turn the internet link off?', 'Turn it off', true], ['Keep the internet link off?', 'Keep it off', true]]);
  assert.equal(ask('tunnel', 'tunnel.off', 'admin', O.tunnel.kept).words, 'It was to stay on until 23:30 today, so a start of AGMessage before then would turn it on again. Kept off, it stays off until it is turned on here.');
  // The keys: Enter opens a hall, an account and a help request's hall, and watches a hall; Delete deletes a message.
  const key = (kind, seat, o, k) => { const e = C.byKey(kind, PAGE[seat], o, k); return e ? e.id : null; };
  assert.deepEqual([key('hall', 'boardCrew', O.hall.row, 'Enter'), key('account', 'accountsAdmin', O.account.other, 'Enter'), key('help', 'board', O.help.open, 'Enter'),
    key('adminRoom', 'admin', O.adminRoom.listed, 'Enter'), key('adminMsg', 'admin', O.adminMsg.text, 'Backspace'), key('adminRoom', 'admin', O.adminRoom.watched, 'Enter')],
    ['hall.open', 'account.edit', 'help.open', 'adminRoom.watch', 'adminMsg.delete', null]);
});

// ---------------------------------------------------------------- people's pages: a take, its card, the Board chip, a person
test('a take on this page: Back to chat and Minimise on its bar, Full screen only where the device has it, Open chat with a 🔥 in its strip; Escape minimises; the simple view has its buttons and no menu', () => {
  const menu = (s, o) => ids('take', SEATS[s], o);
  assert.deepEqual(menu('board', TAKE), ['take.chat', 'take.minimise']);
  assert.deepEqual(menu('board', TAKE_HOT), ['take.chat', 'take.minimise', 'take.openChat']);
  assert.deepEqual(menu('boardFull', TAKE_HOT), ['take.chat', 'take.minimise', 'take.openChat', 'take.fullscreen']);
  assert.deepEqual(menu('research', TAKE), ['take.chat', 'take.minimise'], 'a take reaches any seat: a person\'s own');
  assert.deepEqual(plain(C.items('take', SEATS.boardFull, TAKE_FULL)).filter((i) => !i.sep).map((i) => [i.id, i.label, i.icon]),
    [['take.chat', 'Back to chat', '💬'], ['take.minimise', 'Minimise', '🔽'], ['take.fullscreen', 'Leave full screen', '⛶']]);
  // Its bar holds every act it shows with an inline rank, in order: three on a device that goes full screen; the simple
  // view has no menu door, and the bar is the doors.
  assert.deepEqual(plain(C.inline('take', SEATS.boardSimpleFull, TAKE_HOT, Infinity)).map((i) => i.id), ['take.chat', 'take.minimise', 'take.fullscreen']);
  assert.deepEqual(ids('take', SEATS.boardSimpleFull, TAKE_HOT), [], 'no menu in the simple view');
  assert.deepEqual(plain(C.shown('take', SEATS.boardSimpleFull, TAKE_HOT)).map((e) => e.id), ['take.chat', 'take.minimise', 'take.openChat', 'take.fullscreen']);
  // Escape minimises, never Back to chat; each act is the person's on their own page (self), Full screen the page's own.
  assert.equal(C.byKey('take', SEATS.board, TAKE, 'Escape').id, 'take.minimise');
  assert.deepEqual(plain(C.KINDS.take.map((e) => [e.id, e.verb, e.mode])), [['take.chat', 'page:report', 'self'], ['take.minimise', 'page:report', 'self'], ['take.openChat', 'page:report', 'self'], ['take.held', 'local', 'local'], ['take.tab', 'local', 'local'], ['take.download', 'file:download', 'now'], ['take.fullscreen', 'local', 'local']]);
  // A document shown with Let them download it ticked: ⬇ Download on the layer's bar in either view, and in its ⋯ in the
  // full view, On stage too; never on one shown without it, never for an observer or a Viewer account (no ticket is given
  // them).
  assert.deepEqual([menu('board', TAKE_DOC), menu('research', TAKE_DOC), menu('board', TAKE_DOC_PLAIN), menu('observer', TAKE_DOC), menu('viewer', TAKE_DOC)],
    [['take.chat', 'take.minimise', 'take.download'], ['take.chat', 'take.minimise', 'take.download'], ['take.chat', 'take.minimise'], ['take.chat', 'take.minimise'], ['take.chat', 'take.minimise']]);
  assert.deepEqual([SEATS.boardSimple, SEATS.board].map((f) => plain(C.inline('take', f, TAKE_DOC, Infinity)).map((i) => [i.id, i.label, i.icon])),
    [[['take.chat', 'Back to chat', '💬'], ['take.minimise', 'Minimise', '🔽'], ['take.download', 'Download', '⬇']], [['take.chat', 'Back to chat', '💬'], ['take.minimise', 'Minimise', '🔽'], ['take.download', 'Download', '⬇']]], 'on the layer\'s bar, the simple view\'s and the full view\'s');
  assert.deepEqual([plain(C.inline('take', SEATS.boardSimple, TAKE_DOC_PLAIN, Infinity)).map((i) => i.id), plain(C.inline('take', SEATS.observer, TAKE_DOC, Infinity)).map((i) => i.id)], [['take.chat', 'take.minimise'], ['take.chat', 'take.minimise']]);
  // Information held under the operator's blank: "1 from backstage" on blank's bar, the person's touch shows it; on no
  // other kind, and never while nothing is held.
  assert.deepEqual(plain(C.inline('take', SEATS.boardSimple, TAKE_HELD, Infinity)).map((i) => [i.id, i.label]), [['take.chat', 'Back to chat'], ['take.minimise', 'Minimise'], ['take.held', '1 from backstage']]);
  assert.deepEqual([menu('board', { ...TAKE_HELD, held: 0 }), menu('board', { ...TAKE, held: 1 })], [['take.chat', 'take.minimise'], ['take.chat', 'take.minimise']]);
  // A web page: Open in a new tab in the layer's ⋯ and its right-click, in the full view only, wherever its address was
  // told; never on its bar, never in the simple view (the layer's buttons alone), never on another kind.
  assert.deepEqual(plain(C.inline('take', SEATS.boardFull, TAKE_WEB, Infinity)).map((i) => i.id), ['take.chat', 'take.minimise', 'take.fullscreen']);
  assert.deepEqual(plain(C.items('take', SEATS.boardFull, TAKE_WEB)).filter((i) => !i.sep).map((i) => [i.id, i.label, i.icon]),
    [['take.chat', 'Back to chat', '💬'], ['take.minimise', 'Minimise', '🔽'], ['take.tab', 'Open in a new tab', '🗗'], ['take.fullscreen', 'Full screen', '⛶']]);
  assert.deepEqual([menu('board', TAKE_WEB), menu('research', { ...TAKE_WEB, url: '' }), menu('board', { ...TAKE, url: 'https://vote.example.com/' })],
    [['take.chat', 'take.minimise', 'take.tab'], ['take.chat', 'take.minimise'], ['take.chat', 'take.minimise']]);
  assert.deepEqual([plain(C.shown('take', SEATS.boardSimpleFull, TAKE_WEB)).map((e) => e.id), plain(C.inline('take', SEATS.boardSimpleFull, TAKE_WEB, Infinity)).map((i) => i.id)],
    [['take.chat', 'take.minimise', 'take.fullscreen'], ['take.chat', 'take.minimise', 'take.fullscreen']], 'the simple view: the buttons alone');
  // A quote from a web page whose address was told (its pusher may show a web page): Open the source, the same act, in the
  // layer's ⋯ and its right-click in the full view; never for a quote told no address, never in the simple view (its
  // source line's link is there).
  assert.deepEqual(plain(C.items('take', SEATS.boardFull, TAKE_QUOTE_WEB)).filter((i) => !i.sep).map((i) => [i.id, i.label, i.icon]),
    [['take.chat', 'Back to chat', '💬'], ['take.minimise', 'Minimise', '🔽'], ['take.tab', 'Open the source', '🗗'], ['take.fullscreen', 'Full screen', '⛶']]);
  assert.deepEqual([menu('board', { ...TAKE_QUOTE_WEB, url: '' }), menu('observer', TAKE_QUOTE_WEB), plain(C.shown('take', SEATS.boardSimpleFull, TAKE_QUOTE_WEB)).map((e) => e.id)],
    [['take.chat', 'take.minimise'], ['take.chat', 'take.minimise', 'take.tab'], ['take.chat', 'take.minimise', 'take.fullscreen']]);
  // Not connected: the report waits in the outbox, and every door stays live; the support view acts on none.
  assert.deepEqual(plain(C.items('take', seat({ role: 'board', uid: CHAIR, connected: false }), TAKE_HOT)).map((i) => i.disabled), ['', '', '']);
  assert.ok(plain(C.items('take', SEATS.supportBoard, TAKE_HOT)).every((i) => i.disabled === C.supportWords('Kim')));
});

test('a take minimised, as a card in the side bar: Show again, and Remove with Undo in the full view; an observer has both; the support view acts on none', () => {
  assert.deepEqual(ids('card', SEATS.board, CARD), ['card.show', 'card.remove']);
  // ⬇ Download on the card of a document shown with Download ticked, in either view: that item alone; never an observer's.
  assert.deepEqual([ids('card', SEATS.board, CARD_DOC), plain(C.shown('card', SEATS.boardSimple, CARD_DOC)).map((e) => e.id), ids('card', SEATS.observer, CARD_DOC), ids('card', SEATS.board, { ...CARD_DOC, download: false })],
    [['card.show', 'card.download', 'card.remove'], ['card.show', 'card.download'], ['card.show', 'card.remove'], ['card.show', 'card.remove']]);
  assert.deepEqual(plain(C.inline('card', SEATS.boardSimple, CARD_DOC)).map((i) => [i.id, i.label]), [['card.show', 'Look'], ['card.download', 'Download']]);
  assert.deepEqual(ids('card', SEATS.observer, CARD), ['card.show', 'card.remove'], 'an observer\'s minimised take has its card too');
  assert.deepEqual(plain(C.shown('card', SEATS.boardSimple, CARD)).map((e) => e.id), ['card.show'], 'no Remove in the simple view');
  assert.deepEqual(plain(C.inline('card', SEATS.board, CARD)).map((i) => [i.id, i.label, i.icon]), [['card.show', 'Show again', '⤴'], ['card.remove', 'Remove', '🗑']]);
  assert.equal(C.entry('card', 'card.remove').undo, 'card.remove', 'Remove is taken back by its own Undo');
  assert.ok(plain(C.items('card', seat({ role: 'board', uid: CHAIR, adminView: true, name: 'Kim' }), CARD)).filter((i) => !i.sep).every((i) => i.disabled === C.supportWords('Kim')));
  // Information that arrived in the side bar: Show over the chat, by the person's choice, and Remove; Look in the simple view.
  assert.deepEqual(plain(C.inline('card', SEATS.board, CARD_SIDE)).map((i) => [i.id, i.label]), [['card.show', 'Show over the chat'], ['card.remove', 'Remove']]);
  assert.deepEqual(plain(C.inline('card', SEATS.boardSimple, CARD_SIDE, Infinity)).map((i) => [i.id, i.label]), [['card.show', 'Look']]);
});

test('a pick in the Preview: previewActions exactly, in its order, Copy first, then each unit that holds it with its size, a picture, what is in view, the document and a person; for a backstage seat that may show the Board, in the full view', () => {
  const ids = (f, o) => plain(C.ids('pick', f, o));
  // The operator (canPush) and a researcher by a right of their own (canShow) alike: the one list, Copy first.
  for (const f of [SEATS.adminPush, SEATS.staffShow]) {
    assert.deepEqual(ids(f, PICK_WORDS), ['pick.copy', 'pick.selection', 'pick.word', 'pick.line', 'pick.paragraph', 'pick.picture', 'pick.view', 'pick.document', 'pick.person']);
    assert.deepEqual(ids(f, PICK_CELL), ['pick.copy', 'pick.cell', 'pick.row', 'pick.column', 'pick.view', 'pick.document', 'pick.person'], 'a sheet\'s cell: no picture of a page');
    assert.deepEqual(ids(f, PICK_REGION), ['pick.picture', 'pick.view', 'pick.person'], 'a region: its picture, what is in view and a person, nothing to copy or send as words');
    assert.deepEqual(ids(f, PICK_INSIDE), ['pick.picture', 'pick.view', 'pick.document', 'pick.person'], 'a picture in a document: that picture alone, what is in view, the document and a person');
  }
  // Each unit says its size; a guess read from an untagged PDF says so; a unit over the stage's bound is shown, disabled
  // with the bound's words (the bar offers the cut); the region's picture says it is of the region.
  const label = (o, id) => plain(C.items('pick', SEATS.adminPush, o)).find((i) => i.id === id);
  assert.deepEqual([label(PICK_WORDS, 'pick.word').label, label(PICK_WORDS, 'pick.paragraph').label, label(PICK_GUESS, 'pick.paragraph').label, label(PICK_CELL, 'pick.row').label],
    ['Word · 6 ch', 'Paragraph · 47 ch', 'Paragraph (≈ best guess) · 30 ch', 'Row · 3 cells']);
  assert.deepEqual([label(PICK_LONG, 'pick.paragraph').disabled, label(PICK_LONG, 'pick.selection').disabled], ['Too long for the stage: 1,200 characters at most (this is 1,860)', '']);
  assert.deepEqual([label(PICK_WORDS, 'pick.picture').label, label(PICK_REGION, 'pick.picture').label, label(PICK_INSIDE, 'pick.picture').label], ['Picture of this page', 'Picture of this region', 'This picture alone']);
  // ▸ a person: those it may go to, one level down, for words, a region and a picture alike; with nobody On stage, disabled
  // with why.
  for (const o of [PICK_WORDS, PICK_REGION, PICK_INSIDE]) assert.deepEqual(plain(C.submenu('pick', 'pick.person', SEATS.adminPush, o)), [{ value: 'u:u-cy', label: 'Cy' }]);
  assert.equal(label(PICK_ALONE, 'pick.person').disabled, 'Nobody is seated On stage now.');
  // Copy is the page's own; every other entry is a take on people's pages (page:push), now.
  assert.deepEqual(plain(C.KINDS.pick.map((e) => [e.id, e.verb, e.mode])), [['pick.copy', 'local', 'local'], ...C.PICK_UNITS.map(([u]) => ['pick.' + u, 'page:push', 'now']),
    ['pick.picture', 'page:push', 'now'], ['pick.view', 'page:push', 'now'], ['pick.document', 'page:push', 'now'], ['pick.person', 'page:push', 'now']]);
  // A seat that may not show the Board (a Board seat, an observer, a backstage seat without the right) is shown Copy
  // alone; the simple view has no menu at all; the support view draws the list, every act disabled.
  for (const f of [SEATS.board, SEATS.observer, SEATS.research]) assert.deepEqual(ids(f, PICK_WORDS), ['pick.copy'], f.role);
  assert.deepEqual(plain(C.items('pick', { ...SEATS.adminPush, view: 'simple' }, PICK_WORDS)), []);
  assert.ok(plain(C.items('pick', SEATS.supportPush, PICK_WORDS)).filter((i) => !i.sep).every((i) => i.disabled === C.supportWords('Kim')));
  // The units the bar offers are the store's (lib/pages.js UNITS) but What I see and a typed quote, which are acts of
  // their own.
  assert.deepEqual([...C.PICK_UNITS.map((x) => x[0])].sort(), [...require('../lib/pages').UNITS].filter((u) => u !== 'view' && u !== 'text').sort());
});

test('Earlier: the information taken off this page lately, each a Look on this page alone, for every seat, and ⬇ on a document shown with Download ticked; the support view acts on none', () => {
  for (const s of ['board', 'observer', 'research']) assert.deepEqual(ids('past', SEATS[s], PAST), ['past.look'], s);
  assert.deepEqual(plain(C.inline('past', SEATS.boardSimple, PAST, Infinity)).map((i) => [i.id, i.label, i.icon]), [['past.look', 'Look', '👁']], 'the simple view: its button');
  assert.deepEqual(plain(C.KINDS.past.map((e) => [e.id, e.label, e.verb, e.mode])), [['past.look', 'Look', 'local', 'local'], ['past.download', 'Download', 'file:download', 'now']], 'a Look: no report, no take');
  // A document shown with Let them download it ticked keeps its ⬇ under Earlier, in either view, until it is withdrawn;
  // never one shown without it, never for an observer or a Viewer account.
  assert.deepEqual([ids('past', SEATS.board, PAST_DOC), ids('past', SEATS.research, PAST_DOC), ids('past', SEATS.board, { ...PAST_DOC, download: false }), ids('past', SEATS.observer, PAST_DOC), ids('past', SEATS.viewer, PAST_DOC)],
    [['past.look', 'past.download'], ['past.look', 'past.download'], ['past.look'], ['past.look'], ['past.look']]);
  assert.deepEqual(plain(C.inline('past', SEATS.boardSimple, PAST_DOC, Infinity)).map((i) => [i.id, i.label, i.icon]), [['past.look', 'Look', '👁'], ['past.download', 'Download', '⬇']], 'the simple view: both its buttons');
  assert.ok(plain(C.items('past', SEATS.supportBoard, PAST)).every((i) => i.disabled === C.supportWords('Kim')));
});

test('the Board chip: the show kinds as radio, the one the Board shows checked and not chosen again; Stagewatch where the hall has one; ↶ Back to over this page\'s own take only; Screens & pages…', () => {
  const menu = (s, o) => plain(C.items('board', SEATS[s], o)).map((i) => (i.sep ? '—' : [i.id, i.label, i.role || '', !!i.checked, i.disabled]));
  assert.deepEqual(menu('adminPush', BOARD_MINE), [
    ['board.chat', 'Back to chat', 'menuitemradio', false, ''], ['board.stage', 'Show Stagewatch', 'menuitemradio', false, ''],
    ['board.clock', 'Show the clock', 'menuitemradio', true, 'Already showing the clock.'], ['board.holding', 'Show holding', 'menuitemradio', false, ''],
    ['board.blank', 'Show blank', 'menuitemradio', false, ''], '—', ['board.back', 'Back to Stagewatch (undo your Clock, 14:02)', '', false, ''], '—',
    ['board.screens', 'Screens & pages…', '', false, '']]);
  // Someone else's take is the Board's now: no Back to, so it never undoes their take.
  assert.deepEqual(ids('board', SEATS.adminPush, BOARD_THEIRS), ['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank', 'board.screens']);
  // Nothing shown yet: the chat is checked, and Back to chat says it is already there.
  assert.deepEqual(menu('techPush', BOARD_CHAT).slice(0, 2), [['board.chat', 'Back to chat', 'menuitemradio', true, 'Already on chat.'], ['board.stage', 'Show Stagewatch', 'menuitemradio', false, '']]);
  // No Stagewatch linked: Show Stagewatch says so; no Board page open: the holding slide still checked (it arrives as one joins).
  assert.equal(menu('pushNoStagewatch', BOARD_MINE)[1][4], 'This hall has no Stagewatch linked — link one in Set up.');
  assert.deepEqual(menu('guestPush', BOARD_EMPTY).filter((i) => i[3]).map((i) => [i[0], i[4]]), [['board.holding', 'Already showing holding.']]);
  // Before the console's first read: nothing checked, and every kind says it is reading where the pages stand.
  assert.deepEqual(menu('adminPush', { ...BOARD_CHAT, kind: undefined }).slice(0, 5).map((i) => [i[0], i[3], i[4]]),
    ['chat', 'stage', 'clock', 'holding', 'blank'].map((k) => ['board.' + k, false, 'Reading where their pages stand…']));
  // The console's row of the Board: its five kinds, with their words, its bar; the chip itself has none.
  assert.deepEqual(plain(C.inline('board', SEATS.adminPush, BOARD_MINE, Infinity)).map((i) => i.id), ['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank']);
  // Only a seat that may change what people's pages show: never On stage, an observer, Staff or a guest of an open hall.
  for (const s of ['research', 'board', 'boardSimple', 'observer', 'viewer', 'staff', 'tech', 'admin']) for (const o of HALL_OBJECTS.board) assert.deepEqual(ids('board', SEATS[s], o), [], s);
  // The support view draws the person's doors, every one disabled.
  assert.ok(plain(C.items('board', SEATS.supportPush, BOARD_MINE)).filter((i) => !i.sep).every((i) => i.disabled === C.supportWords('Kim')));
  // A web page on every Board page, for a seat that may show one (canWeb): information over the show, never a show kind
  // (no radio), chosen again for another address; absent without the right (the server refuses it).
  assert.deepEqual(menu('adminWeb', BOARD_MINE).filter((i) => i !== '—').map((i) => i[0]), ['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank', 'board.web', 'board.back', 'board.screens']);
  assert.deepEqual(menu('adminWeb', BOARD_INFO)[5], ['board.web', 'Show a web page…', '', false, '']);
  assert.deepEqual(plain(C.inline('board', SEATS.adminWeb, BOARD_CHAT, Infinity)).map((i) => i.id), ['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank', 'board.web']);
  assert.equal(C.ready('board', 'board.web', SEATS.adminWeb, { ...BOARD_CHAT, kind: undefined }), 'Reading where their pages stand…');
  for (const s of ['adminPush', 'techPush', 'guestPush']) assert.ok(!C.ids('board', SEATS[s], BOARD_MINE).includes('board.web'), s + ': no web page without canWeb');
  // Its ask: the address, then Preview (on this page alone) or Show it; Cancel last.
  const ask = plain(C.entry('board', 'board.web').confirm(SEATS.adminWeb, BOARD_MINE));
  assert.deepEqual([ask.title, ask.fields.map((x) => [x.name, x.max]), ask.choices.map((c) => [c.answer, c.label]), ask.no], ['Show a web page on the Board\'s pages', [['url', 2048]], [['preview', 'Preview'], ['show', 'Show it']], 'Cancel']);
  // The header's console item: Screens & pages… for whoever drives the screens or may change people's pages.
  assert.deepEqual(['guestPush', 'tech', 'research'].map((s) => ids('header', SEATS[s], HEADER).includes('header.screens')), [true, true, false]);
  // Take down: the information over the show handed back, while there is some, else what is beside it; the operator's
  // takes down anything, but an account's whose information pushes lack stage.show is greyed with the server's words.
  assert.ok(!ids('board', SEATS.adminPush, BOARD_MINE).includes('board.takeDown'), 'nothing over the show: no Take down');
  assert.deepEqual([C.ready('board', 'board.takeDown', SEATS.adminPush, BOARD_INFO), C.ready('board', 'board.takeDown', SEATS.adminPush, BOARD_OPERATOR)], [true, true]);
  assert.deepEqual([C.downOf(SEATS.adminPush, BOARD_BESIDE).seq, C.downOf(SEATS.adminPush, BOARD_BESIDE_ONLY).seq, C.downOf(SEATS.adminPush, BOARD_MINE)], [9, 10, null]);
  assert.equal(C.ready('board', 'board.takeDown', SEATS.techPush, { ...BOARD_INFO, show: false }), 'Showing files, pages and quotes on the stage needs its own right — ask an admin.');
  // Withdraw (a take shown by mistake: from their pages and from Earlier), the operator's on any information, last of
  // the menu and asked first, naming what goes; nothing to withdraw, no Withdraw.
  assert.deepEqual(menu('adminPush', BOARD_INFO).filter((i) => i !== '—').at(-1), ['board.withdraw', 'Withdraw…', '', false, '']);
  assert.ok(!ids('board', SEATS.adminPush, BOARD_MINE).includes('board.withdraw'));
  assert.deepEqual([C.withdrawOf(SEATS.adminPush, BOARD_INFO).seq, C.withdrawOf(SEATS.adminPush, BOARD_BESIDE_ONLY).seq, C.withdrawOf(SEATS.adminPush, BOARD_MINE)], [9, 10, null]);
  const gone = plain(C.entry('board', 'board.withdraw').confirm(SEATS.adminPush, BOARD_INFO));
  assert.deepEqual([gone.title, gone.yes, gone.no, gone.danger], ['Withdraw it from the Board\'s pages?', 'Withdraw', 'Keep it', true]);
  assert.match(gone.words, /^“a web page on vote\.example\.com” goes from their pages and from Earlier now/);
  // Show them a picture (plan 4-§5.15.2): on a document this page put up (`standin`, the console's: what goes) that some
  // Board pages could not open (`info.cannot`), for the operator and a seat that may only show alike; never otherwise.
  assert.deepEqual(menu('adminPush', BOARD_DOC).filter((i) => i !== '—').find((i) => i[0] === 'board.picture'), ['board.picture', 'Show them a picture of p. 12', '', false, '']);
  assert.equal(plain(C.items('board', SEATS.adminPush, { ...BOARD_DOC, standin: { said: 'what is at slide 3' } })).find((i) => i.id === 'board.picture').label, 'Show them what is at slide 3');
  assert.ok(ids('board', SEATS.staffShow, BOARD_DOC).includes('board.picture'), 'a seat that may only show');
  for (const o of [{ ...BOARD_DOC, standin: null }, { ...BOARD_DOC, info: { ...DOC_INFO, cannot: 0 } }, { ...BOARD_DOC, info: { ...DOC_INFO, kind: 'image' } }, BOARD_INFO, BOARD_MINE]) {
    assert.ok(!ids('board', SEATS.adminPush, o).includes('board.picture'), JSON.stringify(o.info || null));
  }
  for (const s of ['research', 'board', 'observer']) assert.ok(!ids('board', SEATS[s], BOARD_DOC).includes('board.picture'), s);
  // A person in the console whose pages could not open a document: the same act, to them; never outside the console,
  // without what it sends, or where every page of theirs showed it.
  const kim = { id: 'person:u:u-kim', uid: 'u-kim', name: 'Kim', role: '', key: 'u:u-kim', kind: 'clock', where: 'console', info: { ...DOC_INFO, pages: 1, on: 0, nodocs: 1, cannot: 1 }, standin: { said: 'what is at slide 3' } };
  assert.equal(plain(C.items('person', SEATS.adminPush, kim)).find((i) => i.id === 'person.picture').label, 'Show them what is at slide 3');
  assert.ok(ids('person', SEATS.staffShow, { ...kim, role: 'board' }).includes('person.picture'), 'a seat that may only show');
  for (const o of [{ ...kim, where: undefined }, { ...kim, standin: null }, { ...kim, info: { ...kim.info, cannot: 0 } }, { ...kim, info: INFO_SHOWN }]) {
    assert.ok(!ids('person', SEATS.adminPush, o).includes('person.picture'), JSON.stringify([o.where, o.standin, o.info.cannot, o.info.kind]));
  }
});

test('the Board chip for a seat that may only show (canShow): Take down over its own kind of take, the operator\'s disabled with why; a web page with its right; no show kind, no ↶ Back to; Screens & pages…', () => {
  const menu = (s, o) => plain(C.items('board', SEATS[s], o)).filter((i) => !i.sep).map((i) => [i.id, i.disabled]);
  // A researcher's web page: taken down by a seat with its web right, greyed for one without (it could not have put it up).
  // Withdraw, last, is greyed on a take this seat did not put up (the server refuses it in those words).
  assert.deepEqual(menu('staffShowWeb', BOARD_INFO), [['board.web', ''], ['board.takeDown', ''], ['board.screens', ''], ['board.withdraw', 'Only who showed it, the operator or the admin can withdraw it.']]);
  assert.deepEqual(menu('staffShow', BOARD_INFO), [['board.takeDown', 'Web pages on the stage need their own right — ask an admin.'], ['board.screens', ''], ['board.withdraw', 'Only who showed it, the operator or the admin can withdraw it.']]);
  assert.deepEqual(menu('staffShow', BOARD_OPERATOR), [['board.takeDown', 'The operator put this up — ask them.'], ['board.screens', ''], ['board.withdraw', 'Only who showed it, the operator or the admin can withdraw it.']]);
  assert.deepEqual(menu('staffShow', BOARD_MINE), [['board.screens', '']], 'nothing over the show: nothing to take down');
  // Beside the operator's, in their side bar: its own Take down names it, the operator's over the show left; the
  // operator's on one Board member's page holds the Board's Take down back.
  assert.deepEqual([C.downOf(SEATS.staffShowWeb, BOARD_BESIDE).seq, C.ready('board', 'board.takeDown', SEATS.staffShowWeb, BOARD_BESIDE)], [10, true]);
  assert.deepEqual([C.downOf(SEATS.staffShowWeb, BOARD_BESIDE_ONLY).seq, C.ready('board', 'board.takeDown', SEATS.staffShowWeb, BOARD_BESIDE_ONLY)], [10, true]);
  assert.equal(C.ready('board', 'board.takeDown', SEATS.staffShowWeb, BOARD_OP_ON), 'The operator is showing something on a Board page — ask them.');
  // A person On stage: Take down of a researcher's on their pages, the operator's greyed.
  const gil = { ...PAGE_OBJECTS.person.keyed, role: 'board', where: 'console', info: INFO_SHOWN };
  assert.deepEqual([C.ready('person', 'person.takeDown', SEATS.staffShowWeb, gil), C.ready('person', 'person.takeDown', SEATS.staffShowWeb, { ...gil, info: { ...INFO_SHOWN, op: true } })], [true, 'The operator put this up — ask them.']);
  assert.equal(C.downOf(SEATS.staffShowWeb, { ...gil, info: { ...INFO_SHOWN, op: true }, beside: BESIDE }).seq, 10, 'what is beside the operator\'s is its own');
  assert.deepEqual(menu('staffShowWeb', BOARD_MINE).map((i) => i[0]), ['board.web', 'board.screens'], 'its stage.web: Show a web page…');
  // Withdraw: what this seat put up itself (`mine`, the console's read), over the show or beside it; another's greyed.
  assert.deepEqual(menu('staffShowWeb', { ...BOARD_MINE, info: { ...INFO_SHOWN, mine: true } }), [['board.web', ''], ['board.takeDown', ''], ['board.screens', ''], ['board.withdraw', '']]);
  assert.equal(C.withdrawOf(SEATS.staffShowWeb, { ...BOARD_OPERATOR, beside: { ...BESIDE, mine: true } }).seq, 10, 'its own beside the operator\'s');
  assert.deepEqual([C.ready('person', 'person.withdraw', SEATS.staffShowWeb, { ...gil, info: { ...INFO_SHOWN, mine: true } }), C.ready('person', 'person.withdraw', SEATS.staffShowWeb, gil)], [true, 'Only who showed it, the operator or the admin can withdraw it.']);
  assert.deepEqual(['staffShow', 'staffShowWeb'].map((s) => ids('header', SEATS[s], HEADER).includes('header.screens')), [true, true], 'its console');
  // A person: Show them a web page… with its right, and a document by the short bar, on a person On stage alone (the
  // console lists no one else to it).
  const kim = PAGE_OBJECTS.person.keyed;
  assert.deepEqual([ids('person', SEATS.staffShowWeb, { ...kim, role: 'board' }), ids('person', SEATS.staffShowWeb, { ...kim, role: 'research' }), ids('person', SEATS.staffShow, { ...kim, role: 'board' })],
    [['person.mention', 'person.web', 'person.doc'], ['person.mention'], ['person.mention', 'person.doc']]);
});

test('a person, from a seat that may change what people\'s pages show: 📺 Show them ▸ the show kinds, the one their pages show checked; Back to chat on their pages, said already where they are', () => {
  const kim = PAGE_OBJECTS.person.keyed;
  assert.deepEqual(ids('person', SEATS.guestPush, kim), ['person.mention', 'person.show', 'person.doc', 'person.chat']);
  assert.deepEqual(ids('person', SEATS.guestPush, { ...kim, where: 'console' }), ['person.show', 'person.doc', 'person.chat'], 'in the console: no Mention');
  assert.deepEqual(ids('person', SEATS.research, kim), ['person.mention'], 'nothing of their pages without canPush');
  assert.deepEqual(plain(C.submenu('person', 'person.show', SEATS.guestPush, kim)), [
    { value: 'stage', label: 'Stagewatch', role: 'menuitemradio', checked: false }, { value: 'clock', label: 'Clock', role: 'menuitemradio', checked: true, disabled: 'Already showing the clock.' },
    { value: 'holding', label: 'Holding', role: 'menuitemradio', checked: false }, { value: 'blank', label: 'Blank', role: 'menuitemradio', checked: false }]);
  assert.equal(plain(C.submenu('person', 'person.show', SEATS.pushNoStagewatch, kim))[0].disabled, 'This hall has no Stagewatch linked — link one in Set up.');
  // Back to chat on their pages: said already where they are on chat; where the console's read lists no page of theirs
  // open in the hall, or has not come yet, Show them ▸ and Back to chat say so, and nothing is checked that nobody read.
  const chat = (o) => C.ready('person', 'person.chat', SEATS.guestPush, o);
  const show = (o) => C.ready('person', 'person.show', SEATS.guestPush, o);
  assert.deepEqual([chat(kim), chat({ ...kim, kind: 'chat' }), chat({ ...kim, kind: '' }), chat({ ...kim, kind: undefined })],
    [true, 'Already on chat.', 'They have no page open in this hall now.', 'Reading where their pages stand…']);
  assert.deepEqual([show(kim), show({ ...kim, kind: 'chat' }), show({ ...kim, kind: '' }), show({ ...kim, kind: undefined })],
    [true, true, 'They have no page open in this hall now.', 'Reading where their pages stand…']);
  assert.deepEqual(plain(C.submenu('person', 'person.show', SEATS.guestPush, { ...kim, kind: undefined })).map((i) => [i.value, i.checked, i.disabled]),
    [['stage', false, 'Reading where their pages stand…'], ['clock', false, 'Reading where their pages stand…'], ['holding', false, 'Reading where their pages stand…'], ['blank', false, 'Reading where their pages stand…']]);
  // An AI's line (the Minutes) is no person's page: the hall page gives it no key, and nothing of pages is offered on it.
  assert.deepEqual(ids('person', SEATS.guestPush, { id: 'person:minutes', uid: 'minutes', name: 'Minutes', role: 'observer', key: '', kind: '' }), ['person.mention']);
  // A web page on their pages, for a seat that may show one (canWeb), asked by its address; Show them ▸ keeps the show
  // kinds, a web page never among them. Another address may follow one they are shown; no page of theirs open, it says so.
  assert.deepEqual(ids('person', SEATS.guestWeb, kim), ['person.mention', 'person.show', 'person.web', 'person.doc', 'person.chat']);
  assert.deepEqual(plain(C.submenu('person', 'person.show', SEATS.guestWeb, kim)).map((i) => i.value), ['stage', 'clock', 'holding', 'blank']);
  const web = (o) => C.ready('person', 'person.web', SEATS.guestWeb, o);
  assert.deepEqual([web(kim), web({ ...kim, kind: 'web' }), web({ ...kim, kind: '' }), web({ ...kim, kind: undefined })], [true, true, 'They have no page open in this hall now.', 'Reading where their pages stand…']);
  assert.equal(plain(C.entry('person', 'person.web').confirm(SEATS.guestWeb, kim)).title, 'Show a web page on Kim\'s pages');
});

// An ask the hall page opens before an act is held to its object: at every refresh of what the page shows (a message, a
// person come or gone) the page reads the object again (objectNow) and closes the ask when it is gone. So each kind whose
// acts the hall page runs and whose row may ask has its case there; one without would read as gone at the first refresh
// and close the ask under the person's finger (the sheet's Leave the hall… did).
test('every kind the hall page runs whose acts may ask is read again by objectNow, so a refresh never closes its ask', () => {
  const app = readSource(path.join(ROOT, 'public', 'app.js'));
  const now = /\nfunction objectNow\(kind, o\) \{\n([\s\S]*?)\n\}\n/.exec(app);
  assert.ok(now, 'objectNow, the page\'s one read of an object as it is now');
  const read = new Set([...now[1].matchAll(/kind === '([a-z]+)'/g)].map((m) => m[1]));
  // The page's runners (RUN's keys, `'kind.verb': …`): the kinds the hall page acts on.
  const runs = new Set([...app.matchAll(/^\s*'([a-z]+)\.[a-zA-Z]+': /gm)].map((m) => m[1]));
  assert.ok(runs.has('msg') && runs.has('sheet'), 'the runners are read: ' + [...runs]);
  const asking = KINDS.filter((k) => C.KINDS[k].some((e) => typeof e.confirm === 'function'));
  const missing = asking.filter((k) => runs.has(k) && !read.has(k));
  assert.deepEqual(missing, [], 'kinds the hall page runs that may ask, with no case in objectNow');
  assert.ok(read.has('sheet'));
});
