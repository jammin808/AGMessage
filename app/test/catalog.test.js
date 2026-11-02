'use strict';
// The action catalogue (public/catalog.js), pure, run as a page runs it (a vm with nothing but the script): its entries
// hold to their shape, their modes and their verbs (each a verb the server registers, a route it mounts, or local); one
// word is one act; and for each seat a page can be, the acts it is shown on each object, its inline bar and its menu's
// size are asserted. The server's refusal of each act hidden by rights is test/menus.test.js's; the doors' agreement on
// the page is the browser smoke's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, handlerFiles } = require('./helpers');

/** catalog.js as a page loads it: a classic script that extends window.AGM. */
function loadCatalog() {
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'catalog.js'), 'utf8'), ctx, { filename: 'catalog.js' });
  return ctx.AGM.catalog;
}
const C = loadCatalog();
const plain = (v) => JSON.parse(JSON.stringify(v));   // a value from the script's realm, compared as data
const KINDS = Object.keys(C.KINDS);
const all = () => KINDS.flatMap((k) => C.KINDS[k].map((e) => ({ kind: k, e })));

/** The socket verbs the server registers (the fuzz's own read) and the HTTP routes it mounts, as `METHOD /path`. */
const SOCKET_VERBS = new Set(handlerFiles().flatMap((f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1])));
const ROUTES = new Set(['server.js', 'lib/http-accounts.js'].flatMap((f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[1].toUpperCase() + ' ' + m[2])));
/** The verbs §16.7 names for the kinds landed so far (msg, file, screen): each must be some entry's. A unit that adds an act adds its verb. */
const REQUIRED = ['react', 'actionResponse', 'help:respond', 'ai:draft', 'stage:propose', 'stage:send', 'display:take', 'forward', 'pin', 'delete', 'display:identify', 'display:update', 'display:rotate', 'display:remove'];
/** The status marks the pages draw (the marks table of the plan's §15.6): no act's icon is one, so a mark has one meaning. */
const MARKS = ['✓', '◐', '◇', '▭', '○', '⊘', '◷', '△', '✕', '■', '▶', '●', '▲', 'i'];
/** The action icons kept to one act each (§15.6): ↩ is Reply, ↗ is Send to and Send back, ⤴ is Show again. */
const RESERVED_ICONS = { '↩': ['reply'], '↗': ['send', 'sendBack'], '⤴': ['show'] };
/** Acts of different names that are one act, and so share an icon: 🗑 takes a thing away for good. */
const ONE_ACT = [['delete', 'remove']];
/** Acts that open a dialog of their own (Stagewatch's, the Screens console) and so end their label with "…" as an ask does. */
const OPENS_DIALOG = new Set(['msg.speaker', 'msg.screens', 'file.screens']);
/** The keys a single key may be: a letter or a digit that needs no Shift (shown upper case), or one of these named keys. */
const NAMED_KEYS = ['Enter', 'Delete'];

// ---------------------------------------------------------------- the fixtures: seats, as their join answers make them
const at = 1_700_000_000_000;
const ANA = 'u-ana', CHAIR = 'u-chair', CY = 'u-cy', OBS = 'u-obs';
const live = { status: 'connected', desk: true, key: 'ok' };
const screens = (n, manage = false) => ({ manage, displays: Array.from({ length: n }, (_, i) => ({ id: 'd' + i })) });
const seat = (o) => C.facts({ connected: true, ai: true, stage: live, ...o });
const SEATS = {
  research: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true }),
  researchAlone: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: false, ai: false }),
  researchNoDesk: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: true }),
  researchLinkDown: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, stage: { status: 'reconnecting', desk: true, key: 'ok' } }),
  researchOffline: seat({ role: 'research', uid: ANA, uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, connected: false }),
  board: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false }),
  // The Board in the simple view: two plain messages and one 🔥 wait for its answer.
  boardSimple: seat({ role: 'board', uid: CHAIR, uploadToken: null, forwardable: false, view: 'simple', waiting: { plain: ['m8', 'm9'], priority: ['m10'] } }),
  observer: seat({ role: 'observer', uid: OBS, uploadToken: null, forwardable: false }),
  observerElsewhere: seat({ role: 'observer', uid: OBS, uploadToken: null, forwardable: true }),
  viewer: seat({ role: 'observer', uid: 'a-vic', uploadToken: null, forwardable: false, account: { role: 'viewer' } }),
  // A Viewer account granted hall.post sits backstage, and its page still holds no file's link.
  viewerPost: seat({ role: 'research', uid: 'a-vic', uploadToken: 't', forwardable: false, ai: false, account: { role: 'viewer' } }),
  staff: seat({ role: 'research', uid: 'a-sid', uploadToken: 't', canSendToStage: false, canPropose: false, forwardable: true }),
  tech: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: false, screens: screens(1) }),
  techNoScreens: seat({ role: 'research', uid: 'a-tia', uploadToken: 't', canSendToStage: true, canPropose: false, forwardable: false, screens: screens(0) }),
  admin: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, screens: screens(2, true) }),
  support: seat({ role: 'research', uid: 'a-root', uploadToken: 't', canSendToStage: true, canPropose: true, forwardable: true, adminView: true, name: 'Kim' }),
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
};
const ids = (kind, f, o) => plain(C.ids(kind, f, o));

test('the entries: kind.verb ids, known groups in order with danger last, labels, keys, icons that are no marks', () => {
  assert.deepEqual(KINDS, ['msg', 'file', 'screen'], 'the kinds landed so far');
  const seen = new Set();
  for (const kind of KINDS) {
    const list = C.KINDS[kind];
    const keys = new Set();
    let last = -1;
    for (const e of list) {
      assert.ok(/^[a-z]+\.[a-z][A-Za-z]*$/.test(e.id) && e.id.split('.')[0] === kind, e.id + ': shaped kind.verb, in its kind');
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
  for (const { e } of all()) {
    for (const [f, o] of Object.values(OBJECTS).flatMap((x) => [SEATS.admin, SEATS.researchNoDesk, SEATS.boardSimple].map((f2) => [f2, x]))) {
      const label = typeof e.label === 'function' ? e.label(f, o) : e.label;
      assert.ok(typeof label === 'string' && label.length > 0, e.id + ': a label for every object');
      assert.equal(label.endsWith('…'), !!e.confirm || OPENS_DIALOG.has(e.id), e.id + ': "' + label + '" ends with "…" exactly when it asks first or opens a dialog');
      if (/screen/i.test(label)) assert.ok(e.verb.startsWith('display:') || (e.verb.startsWith('stage:') && /speaker's screen/i.test(label)), e.id + ': "' + label + '" says screen and acts on one');
      if (e.verb === 'page:push') assert.match(label, /\bShow\b/, e.id + ': an act that puts something on people\'s pages says Show');
      if (e.short) assert.ok(e.fold, e.id + ': a short label is a fold\'s');
    }
  }
});

test('the facts: read from the server\'s answers, the link\'s words by its state, and nothing a page could name for itself', () => {
  const f = plain(C.facts({ role: 'director', uid: 'u1', uploadToken: '', canSendToStage: 1, stage: { status: 'connected' }, forwardable: 'yes', screens: { manage: true, displays: [{}, {}] }, connected: true }));
  assert.deepEqual(f, { role: 'board', view: 'full', uid: 'u1', post: true, viewer: false, pin: true, ask: false, respondHelp: false, waiting: { plain: [], priority: [] }, files: false, canSendToStage: true, canPropose: false, stageWhy: '', ai: false, canScreens: true, screensManage: true, screens: 2, forwardable: true, connected: true, support: '' });
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
    // Alone in this hall with AI off: no Send to and no draft.
    researchAlone: { boardText: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.pin', 'msg.copy'] },
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
    staff: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.send', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.look', 'msg.download'] },
    tech: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.pin', 'msg.copy'], anaFile: ['msg.reply', 'msg.react', 'msg.screens', 'msg.pin', 'msg.look', 'msg.download'] },
    // A question is not a thing a screen shows: no ⧉ on it.
    admin: { anaQuestion: ['msg.reply', 'msg.react', 'msg.answer', 'msg.answerWords', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'], anaText: ['msg.reply', 'msg.react', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.send', 'msg.pin', 'msg.copy'] },
    support: { boardText: ['msg.reply', 'msg.react', 'msg.draft', 'msg.speaker', 'msg.sendNow', 'msg.send', 'msg.pin', 'msg.copy'] },
  };
  // The full view's sets are its menus; the simple view has no menu, and its sets are what its buttons may be.
  for (const [s, objs] of Object.entries(M)) {
    for (const [o, want] of Object.entries(objs)) {
      const set = SEATS[s].view === 'simple' ? plain(C.shown('msg', SEATS[s], OBJECTS[o])).map((e) => e.id) : ids('msg', SEATS[s], OBJECTS[o]);
      assert.deepEqual(set, want, s + ' on ' + o);
      if (SEATS[s].view === 'simple') assert.deepEqual(ids('msg', SEATS[s], OBJECTS[o]), [], s + ' on ' + o + ': no menu door');
    }
  }
  // The Board, either view: none of what §17.1 keeps from an On stage seat, by right or by its view.
  const NEVER_ON_STAGE = ['msg.helpRespond', 'msg.send', 'msg.speaker', 'msg.sendNow', 'msg.screens', 'msg.download', 'msg.draft'];
  for (const s of ['board', 'boardSimple']) for (const o of Object.keys(OBJECTS)) {
    const set = plain(C.shown('msg', SEATS[s], OBJECTS[o])).map((e) => e.id);
    assert.deepEqual(set.filter((id) => NEVER_ON_STAGE.includes(id)), [], s + ' on ' + o);
    if (s === 'board') assert.ok(!set.includes('msg.ack'), 'Got it is the simple view\'s only: the full view\'s React ▸ 👍 is the same fact');
  }
  // Every act asserted absent somewhere exists, and is shown to another seat: none passes by its absence.
  const everyId = new Set(C.KINDS.msg.map((e) => e.id));
  const shownSomewhere = new Set(Object.values(M).flatMap((objs) => Object.values(objs).flat()));
  for (const id of everyId) assert.ok(shownSomewhere.has(id), id + ' is shown to some seat in the matrix');
});

test('what a seat may do but not now is shown, disabled, with the words why; the support view acts on nothing', () => {
  const disabled = (s, o) => Object.fromEntries(plain(C.items('msg', SEATS[s], OBJECTS[o])).filter((i) => !i.sep).flatMap((i) => (i.children || [i])).map((i) => [i.id, i.disabled || i.held || '']));
  // The link down: the speaker's screen says why, and the rest acts.
  assert.deepEqual(disabled('researchLinkDown', 'boardText'), { 'msg.reply': '', 'msg.react': '', 'msg.draft': '', 'msg.speaker': C.WORDS.linkDown, 'msg.sendNow': C.WORDS.linkDown, 'msg.send': '', 'msg.pin': '', 'msg.copy': '' });
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
  assert.deepEqual(plain(C.entry('msg', 'msg.answerWords').confirm(SEATS.board, OBJECTS.anaQuestion)).fields, [{ name: 'note', label: 'Your answer', max: 200 }], 'answered in a field of 200 characters, as the server keeps');
});

test('a single key on the focused object: R E F P D, Enter, Delete or Backspace, each the act that carries it', () => {
  const key = (s, o, k, kind = 'msg') => { const e = C.byKey(kind, SEATS[s], o, k); return e ? e.id : null; };
  assert.deepEqual(['r', 'E', 'f', 'p', 'Delete', 'Backspace', 'x', 'Enter'].map((k) => key('research', OBJECTS.anaText, k)), ['msg.reply', 'msg.react', 'msg.send', 'msg.pin', 'msg.delete', 'msg.delete', null, null]);
  assert.deepEqual(['Enter', 'd'].map((k) => key('research', OBJECTS.anaFile, k)), ['msg.look', 'msg.download']);
  assert.equal(key('observer', OBJECTS.anaText, 'p'), null, 'a key runs only what the seat is shown');
  assert.equal(key('board', OBJECTS.anaFile, 'd'), null, 'On stage downloads nothing, by key either');
});
