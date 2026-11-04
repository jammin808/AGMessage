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
const ONE_ACT = [['send', 'sendBack', 'sendTo'], ['delete', 'remove'], ['draft', 'minutes'], ['helpRespond', 'respond'], ['helpResolve', 'resolve'], ['setup', 'configure'], ['toggle', 'codeToggle'], ['new', 'newCode']];
/** Acts that open a dialog of their own (Stagewatch's, the Screens console, a hall's set-up, the show network, the editor, the export) and so end their label with "…" as an ask does. */
const OPENS_DIALOG = new Set(['msg.speaker', 'msg.screens', 'file.screens', 'chip.speaker', 'header.screens', 'compose.attach', 'hall.setup', 'hall.network', 'room.setup', 'account.edit', 'audit.export', 'adminRoom.members', 'adminRoom.sendFrom']);
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
  // What Hall 2's Main room sent into this room, and this room's copy of what it sent there.
  fromHall: { id: 'm12', type: 'text', text: 'Is the contract signed?', from: from(ANA, 'research', 'Ana'), at, reactions: [], sentFrom: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa' } },
  // What this seat itself sent here from Hall 2: here it is that room's, not its sender's to delete.
  fromLou: { id: 'm14', type: 'text', text: 'Contract is signed', from: from('u-lou', 'research', 'Lou'), at, reactions: [], sentFrom: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa' } },
  sentThere: { id: 'm13', type: 'file', url: '/uploads/2-brief.pdf', filename: 'brief.pdf', mime: 'application/pdf', from: from('u-lou', 'research', 'Lou'), at, sentTo: { roomName: 'Hall 2', hallName: 'Hall 2', ref: 'rH2aaaaaaaaaaaaaaa', id: 'm1' } },
  // This room's copy of what it sent into Hall 2's Legal, withdrawn from there 40 s after it went.
  sentWithdrawn: { id: 'm15', type: 'text', text: 'Wrong room', from: from('u-lou', 'research', 'Lou'), at, reactions: [], sentTo: { roomName: 'Legal', hallName: 'Hall 2', ref: 'rLGcccccccccccccccc', id: 'm2', withdrawn: at + 40_000 } },
};
const ids = (kind, f, o) => plain(C.ids(kind, f, o));
// The rest of the hall page's objects: its composers (`form`, `room`, the `file` chosen, whom it is `replying` to, 🔥
// `priority`), the stage chip, the code chip.
const COMPOSE = {
  text: { id: 'compose:text', form: 'text', room: 'Hall 2', file: '', replying: '', priority: false },
  replying: { id: 'compose:text', form: 'text', room: 'Hall 2', file: '', replying: 'Chair', priority: true },
  action: { id: 'compose:action', form: 'action', room: 'Hall 2', file: '', replying: '', priority: false },
  fileEmpty: { id: 'compose:file', form: 'file', room: 'Hall 2', file: '', replying: '', priority: false },
  fileChosen: { id: 'compose:file', form: 'file', room: 'Hall 2', file: 'capex.pdf', replying: '', priority: false },
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
const HALL_OBJECTS = { compose: Object.values(COMPOSE), chip: [STAGE], header: [HEADER, HEADER_OFF, HEADER_UNTOLD, HEADER_ACCOUNT] };

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
  },
  adminMsg: {
    text: { id: 'm1', type: 'text', text: 'Capex is on slide 14', from: from(ANA, 'research', 'Ana'), at, hall: 'Hall 2' },
    file: { id: 'm2', type: 'file', filename: 'capex.pdf', from: from(ANA, 'research', 'Ana'), at, hall: 'Hall 2' },
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
  adminRoom: [PAGE.admin, PAGE.adminNoAi, PAGE.adminUsers, PAGE.boardAdmin], person: [PAGE.admin, SEATS.research, SEATS.board], adminMsg: [PAGE.admin], link: [PAGE.admin], tunnel: [PAGE.admin], laptop: [PAGE.admin],
  hall: [PAGE.board], room: [PAGE.board, SEATS.research], help: [PAGE.board], account: [PAGE.accountsAdmin], audit: [PAGE.accountsAdmin, PAGE.filtered],
};
/** Every seat of a kind with every object of it ([f, o] pairs): messages, a file where it is listed and where it is open, a screen, and the other pages' objects. */
function pairsOf(kind) {
  const objs = PAGE_OBJECTS[kind] ? Object.values(PAGE_OBJECTS[kind]) : HALL_OBJECTS[kind] ? HALL_OBJECTS[kind]
    : kind === 'file' ? ['list', 'preview'].map((where) => Object.assign({}, OBJECTS.anaFile, { where }))
      : kind === 'screen' ? [SCREEN] : Object.values(OBJECTS);
  return KIND_SEATS[kind].flatMap((f) => objs.map((o) => [f, o]));
}

test('the entries: kind.verb ids, known groups in order with danger last, labels, keys, icons that are no marks', () => {
  assert.deepEqual(KINDS, ['msg', 'file', 'screen', 'compose', 'chip', 'header', 'adminRoom', 'person', 'adminMsg', 'link', 'tunnel', 'laptop', 'hall', 'room', 'help', 'account', 'audit'], 'the kinds landed so far');
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
      if (/screen/i.test(label)) assert.ok(e.verb.startsWith('display:') || (e.verb.startsWith('stage:') && /speaker's screen/i.test(label)), e.id + ': "' + label + '" says screen and acts on one');
      if (e.verb === 'page:push') assert.match(label, /\bShow\b/, e.id + ': an act that puts something on people\'s pages says Show');
      if (e.short) assert.ok(e.fold, e.id + ': a short label is a fold\'s');
    }
  }
  assert.deepEqual(all().map(({ e }) => e.id).filter((id) => !read.has(id)), [], 'every act\'s words are read on an object it fits');
});

test('the facts: read from the server\'s answers, the link\'s words by its state, and nothing a page could name for itself', () => {
  const f = plain(C.facts({ role: 'director', uid: 'u1', uploadToken: '', canSendToStage: 1, stage: { status: 'connected' }, forwardable: 'yes', screens: { manage: true, displays: [{}, {}] }, connected: true }));
  assert.deepEqual(f, { page: 'hall', role: 'board', view: 'full', uid: 'u1', post: true, viewer: false, pin: true, ask: false, respondHelp: false, waiting: { plain: [], priority: [] }, files: false, canSendToStage: true, canPropose: false, stageWhy: '', ai: false, canScreens: true, screensManage: true, screens: 2, forwardable: true, sends: false, targets: [], mayKnowCode: false, setsCode: false, admin: false, connected: true, support: '' });
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
      anaFile: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.delete'],
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
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.pin', 'msg.copy'],
      chairHelp: ['msg.reply', 'msg.react', 'msg.helpResolve', 'msg.pin', 'msg.copy', 'msg.delete'],
      cyHelp: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'],
      anaNote: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'],
    },
    // On stage, the simple view: no menu, its acts are its buttons. The newest plain message waiting and each 🔥 one
    // waiting carry Got it and Reply; an older one waiting, one's own message and the help requests carry none; a
    // question its answers; a file its Look.
    boardSimple: {
      anaNote: ['msg.ack', 'msg.reply'], anaHot: ['msg.ack', 'msg.reply'], anaOld: [], anaText: [], boardText: [],
      anaQuestion: ['msg.answer', 'msg.answerWords'], anaFile: ['msg.look'], chairHelp: [], cyHelp: [], system: [],
    },
    // An observer and a Viewer: Copy, and Send to only for text where they may post elsewhere; no pin, no Look, no
    // Download (their pages hold no file's link).
    observer: { boardText: ['msg.copy'], anaFile: [], anaQuestion: ['msg.copy'], chairHelp: ['msg.copy'] },
    observerElsewhere: { boardText: ['msg.send', 'msg.copy'], anaFile: [], anaQuestion: ['msg.send', 'msg.copy'] },
    viewer: { boardText: ['msg.copy'], anaFile: [], anaQuestion: ['msg.copy'] },
    viewerPost: { anaFile: ['msg.reply', 'msg.react', 'msg.pin'], anaText: ['msg.reply', 'msg.react', 'msg.pin', 'msg.copy'] },
    // Staff: messages and files, no Stagewatch: neither 📝 nor 🖥. Tech: Stagewatch's speaker's screen (no show desk), and
    // the hall's screens.
    // (What this room sent into another, by someone else, is not Staff's to withdraw.)
    staff: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.send', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download'], sentThere: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download'] },
    tech: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.screens', 'msg.pin', 'msg.look', 'msg.download'] },
    // A question is not a thing a screen shows: no ⧉ on it.
    // The admin withdraws any send this room made, and deletes only its own.
    admin: {
      anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'], anaText: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.send', 'msg.pin', 'msg.copy'],
      sentThere: ['msg.reply', 'msg.react', 'msg.screens', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.withdraw'], sentWithdrawn: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.send', 'msg.pin', 'msg.copy'],
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
      sentThere: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download', 'msg.withdraw', 'msg.delete'],
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
  const NEVER_ON_STAGE = ['msg.helpRespond', 'msg.send', 'msg.sendBack', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.download', 'msg.draft', 'msg.withdraw'];
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
  // The support view draws the person's doors, every one disabled with its words.
  const sv = plain(C.items('msg', SEATS.support, OBJECTS.boardText)).filter((i) => !i.sep).flatMap((i) => (i.children || [i]));
  assert.ok(sv.length > 5 && sv.every((i) => i.disabled === 'This is Kim\'s view — act from your own page.'), JSON.stringify(sv.map((i) => i.disabled)));
  assert.equal(C.ready('msg', 'msg.copy', SEATS.support, OBJECTS.boardText), C.supportWords('Kim'), 'a local act too');
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
  assert.deepEqual(ids('file', SEATS.research, list), ['file.look', 'file.download', 'file.pin']);
  assert.deepEqual(ids('file', SEATS.research, preview), ['file.download', 'file.pin', 'file.close']);
  assert.deepEqual(ids('file', SEATS.tech, list), ['file.screens', 'file.look', 'file.download', 'file.pin']);
  assert.deepEqual(ids('file', SEATS.board, list), ['file.look', 'file.pin'], 'On stage: no Download');
  assert.deepEqual(ids('file', SEATS.observer, list), [], 'an observer: nothing of a file');
  assert.deepEqual(ids('file', SEATS.viewerPost, list), ['file.pin'], 'a Viewer granted hall.post: no Look and no Download');
  assert.deepEqual(plain(C.inline('file', SEATS.research, list)).map((i) => [i.id, i.label]), [['file.look', 'Look'], ['file.pin', 'Unpin']]);
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
  assert.deepEqual(plain(C.entry('msg', 'msg.answerWords').confirm(SEATS.board, OBJECTS.anaQuestion)).fields, [{ name: 'note', label: 'Your answer', max: 200 }], 'answered in a field of 200 characters, as the server keeps');
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
    // Backstage: ✨ Draft a reply in the Message tab, Send, 🔥 Priority and Attach a file… in every tab; Remove the file
    // once one is chosen; Cancel the reply while replying. Send is the composer's one act on its row.
    ['compose', 'research', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach']],
    ['compose', 'research', COMPOSE.replying, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach', 'compose.cancelReply']],
    ['compose', 'research', COMPOSE.action, ['compose.send', 'compose.priority', 'compose.attach']],
    ['compose', 'research', COMPOSE.fileChosen, ['compose.send', 'compose.priority', 'compose.attach', 'compose.removeFile']],
    // On stage: its words, 🔥 and Send, no file and no draft.
    ['compose', 'board', COMPOSE.director, ['compose.send', 'compose.priority']],
    ['compose', 'board', COMPOSE.directorReplying, ['compose.send', 'compose.priority', 'compose.cancelReply']],
    // A Viewer granted posting sits backstage: it drafts, sends and attaches.
    ['compose', 'viewerPost', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.priority', 'compose.attach']],
    ['compose', 'observer', COMPOSE.text, []],
    // A room that may send into others: To ▸ on the message and the file composer, never on a question's.
    ['compose', 'researchSends', COMPOSE.text, ['compose.draft', 'compose.send', 'compose.sendTo', 'compose.priority', 'compose.attach']],
    ['compose', 'researchSends', COMPOSE.fileChosen, ['compose.send', 'compose.sendTo', 'compose.priority', 'compose.attach', 'compose.removeFile']],
    ['compose', 'researchSends', COMPOSE.action, ['compose.send', 'compose.priority', 'compose.attach']],
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
  for (const [kind, o] of [['chip', STAGE], ['header', HEADER], ['person', PERSON]]) assert.deepEqual(plain(C.inline(kind, SEATS.admin, o)), [], kind + ': no act on a row, only the menu');

  // Disabled, with the reason: a file not chosen, AI drafts off, the link down, no screens, not connected; a send held
  // by the outbox stays live; the support view acts on nothing.
  const why = (seat, kind, o) => Object.fromEntries(plain(C.items(kind, SEATS[seat], o)).filter((i) => !i.sep).map((i) => [i.id, i.disabled || i.held || '']));
  assert.deepEqual(why('research', 'compose', COMPOSE.fileEmpty), { 'compose.send': C.WORDS.noFile, 'compose.priority': '', 'compose.attach': '' });
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
    ['header.people', 'People · 3', 'menuitemcheckbox', false, false], ['header.screens', 'Screens…', '', '', false], ['header.size', 'Text size', '', '', true],
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
    ['person', 'admin', O.person.guest, ['person.seat', 'person.forward', 'person.view', 'person.kick']],
    ['person', 'admin', O.person.account, ['person.forward', 'person.unforward', 'person.view', 'person.kick']],
    ['person', 'notAdmin', O.person.guest, []],
    ['adminMsg', 'admin', O.adminMsg.text, ['adminMsg.copy', 'adminMsg.delete']],
    ['adminMsg', 'admin', O.adminMsg.file, ['adminMsg.delete']],
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
  // The person kind's other half, the hall page's (a seat there, read by its facts): it mentions a person.
  M.push(['person', 'research', O.person.guest, ['person.mention']]);
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
