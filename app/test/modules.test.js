'use strict';
// The module fence (docs/ANALYSIS.md §3.5): the server's layers, read from its require() calls, and the wire's words,
// read from the files that register socket verbs (`handlerFiles()`) and from every page script, closed both ways. Each
// rule is a function of the sources it is given, so the tree is held to it and a planted breach of each kind fails it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, filesUnder, handlerFiles, pageScripts } = require('./helpers');
const ops = require('../lib/ops');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sourcesOf = (files) => new Map(files.map((f) => [f, read(f)]));
/** The files the shipped server is made of: its two processes' entry points, lib/ and the audit log's verifier. */
const serverCode = () => ['server.js', 'supervise.js', ...filesUnder('lib', /\.[cm]?js$/), ...filesUnder('verify', /\.[cm]?js$/)];

// ---------------------------------------------------------------- (a)-(c) the server's layers
/** The pure core: functions of what they are given, their clocks default arguments. They require only each other. */
const PURE = ['lib/board.js', 'lib/context.js', 'lib/deskresults.js', 'lib/latest.js', 'lib/ops.js', 'lib/rbac.js', 'lib/stagelines.js'];
/** What reaches a disk, a network, the machine or another process: a pure module names none of them. */
const IO_BUILTINS = ['fs', 'net', 'http', 'https', 'dgram', 'tls', 'os', 'dns', 'child_process', 'ws'];
/** Only the composition root, server.js, requires these: the HTTP domain and the handler modules. */
const ROOT_ONLY = (f) => f === 'lib/http-accounts.js' || /^lib\/handlers\/[^/]+\.js$/.test(f);

/** Each literal require() in a source, read by a regex as the fuzz reads event names: every path, `./` and `../`. */
const requiresIn = (src) => [...src.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
/** Each folder's package.json `main`, by the folder ('' is app/): a require of the folder is a require of its main. */
const MAINS = { '': JSON.parse(read('package.json')).main };
/**
 * A relative require as Node resolves it here: the path, then with `.js`, then its folder's `main`, then its folder's
 * index.js; else null. So `require('..')` from test/ is server.js, as Node makes it through app/package.json.
 */
function resolve(from, spec, has, mains = MAINS) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\/+$/, '');
  const dir = base === '.' ? '' : base;
  const within = (f) => path.posix.normalize(dir ? dir + '/' + f : f);
  const main = Object.hasOwn(mains, dir) ? [within(mains[dir]), within(mains[dir]) + '.js'] : [];
  return [base, base + '.js', ...main, within('index.js')].find((f) => has(f)) || null;
}

/**
 * The graph: file → [{spec, to}], `to` the file a relative require names (null when it is not there) or absent. A file
 * is there when `has` says so: one of the sources, by default.
 */
function graphOf(sources, { has = (f) => sources.has(f), mains = MAINS } = {}) {
  const graph = new Map();
  for (const [file, src] of sources) {
    graph.set(file, requiresIn(src).map((spec) => (/^\.\.?(\/|$)/.test(spec) ? { spec, to: resolve(file, spec, has, mains) } : { spec })));
  }
  return graph;
}

/**
 * What breaks the layers in `sources` (file → source; test files under test/), with `pure` the pure set and `has` what
 * else is in the tree (a test may require a lint rule or a tool). Sorted.
 */
function layerProblems(sources, pure = PURE, opts = {}) {
  const problems = [];
  const graph = graphOf(sources, opts);
  const pureSet = new Set(pure);
  for (const f of pure) if (!sources.has(f)) problems.push(f + ' is in the pure set and not in the tree');
  for (const [file, edges] of graph) {
    const shipped = !file.startsWith('test/');
    for (const e of edges) {
      // A require of nothing is read as nothing, so a path the resolver gets wrong cannot pass by resolving to null.
      if ('to' in e && e.to === null) problems.push(file + ' requires ' + e.spec + ', which is not in the tree');
      if (e.to === 'server.js') problems.push(file + ' requires server.js');
      if (shipped && e.to && ROOT_ONLY(e.to) && file !== 'server.js') problems.push(file + ' requires ' + e.to + ': only server.js does');
    }
    if (!pureSet.has(file)) continue;
    const src = sources.get(file);
    for (const { spec, to } of edges) {
      const bare = spec.replace(/^node:/, '');
      if (IO_BUILTINS.includes(bare)) problems.push(file + ' (pure) names the I/O built-in ' + spec);
      else if (!to || !pureSet.has(to)) problems.push(file + ' (pure) requires ' + spec + (to ? ' (' + to + ')' : '') + ', outside the pure set');
    }
    if (/\bprocess\s*\./.test(src)) problems.push(file + ' (pure) reads process.');
    if (/\bimport\s*\(/.test(src)) problems.push(file + ' (pure) imports at run time');
  }
  // (b) no cycle among the shipped files: each one found is named once, from its first file in sort order.
  const cycles = new Set();
  const state = new Map();   // file → 'open' while on the path, 'done' after
  const visit = (file, trail) => {
    state.set(file, 'open');
    const here = [...trail, file];
    for (const { to } of graph.get(file) || []) {
      if (!to || to.startsWith('test/')) continue;
      if (state.get(to) === 'open') {
        const loop = here.slice(here.indexOf(to));
        const start = loop.indexOf([...loop].sort()[0]);
        const turned = [...loop.slice(start), ...loop.slice(0, start)];
        cycles.add('a cycle: ' + [...turned, turned[0]].join(' → '));
      } else if (!state.has(to)) visit(to, here);
    }
    state.set(file, 'done');
  };
  for (const file of [...graph.keys()].sort()) if (!file.startsWith('test/') && !state.has(file)) visit(file, []);
  return [...problems, ...cycles].sort();
}
/** A file of the tree on disk, relative to app/ (a test's lint rule or tool, outside the sources read). */
const onDisk = (f) => { try { return fs.statSync(path.join(ROOT, f)).isFile(); } catch { return false; /* not there */ } };

test('(a)-(c) the server\'s layers: the pure set requires only itself, nothing requires server.js, no cycle, one composition root', () => {
  // The tests are read for one rule, that none requires server.js; this file's own sources are planted strings.
  const files = [...serverCode(), ...filesUnder('test', /\.js$/).filter((f) => f !== 'test/modules.test.js')];
  const sources = sourcesOf(files);
  const has = (f) => sources.has(f) || onDisk(f);
  assert.deepEqual(layerProblems(sources, PURE, { has }), []);
  // What the read sees, so the rules above are not passed by reading nothing: a `../` path, a require inside a
  // function, the root's own requires and a test's, and app/ itself, which Node resolves through its package.json.
  const graph = graphOf(sources, { has });
  const to = (f) => graph.get(f).map((e) => e.to).filter(Boolean);
  assert.equal(resolve('test/x.test.js', '..', has), 'server.js', 'a require of app/ is one of its main, server.js');
  assert.ok(to('test/lint-rules.test.js').includes('eslint-rules/no-unescaped-html.js'), 'a test\'s require of a file outside the sources is found on disk');
  assert.ok(to('lib/audit.js').includes('verify/auditrules.js'), 'a ../ path is followed');
  assert.ok(to('lib/audit.js').includes('lib/version.js'), 'a require inside a function is read');
  assert.ok(to('server.js').includes('lib/http-accounts.js') && to('server.js').includes('lib/rbac.js'));
  assert.ok(to('test/resilience.test.js').includes('lib/resilience.js'));
  for (const f of PURE) assert.ok(graph.has(f), f + ' is read');
  assert.ok(files.includes('supervise.js') && files.includes('verify/verify-audit.js'), 'both processes and the verifier are read');
});

test('(a)-(c) a planted breach of each layer rule fails it', () => {
  const base = {
    'server.js': "require('./lib/board'); require('./lib/http-accounts'); const { WriteLane } = require('./lib/resilience'); require('./lib/store');",
    'lib/board.js': "const rbac = require('./rbac');",
    'lib/rbac.js': '// pure',
    'lib/store.js': "const fs = require('fs'); require('./resilience');",
    'lib/resilience.js': "const fs = require('node:fs');",
    'lib/http-accounts.js': "require('./guard');",
    'lib/guard.js': "const crypto = require('crypto');",
    'lib/handlers/rooms.js': "require('../rbac');",
    'test/units.test.js': "require('../lib/store'); require('../lib/handlers/rooms');",
  };
  const pure = ['lib/board.js', 'lib/rbac.js'];
  const run = (edit = {}, p = pure) => layerProblems(new Map(Object.entries({ ...base, ...edit })), p);
  assert.deepEqual(run(), [], 'the planted tree passes, a test requiring a handler module included');
  const add = (f, line) => ({ [f]: base[f] + '\n' + line });
  assert.deepEqual(run(add('lib/board.js', "const fs = require('node:fs');")), ['lib/board.js (pure) names the I/O built-in node:fs']);
  assert.deepEqual(run(add('lib/rbac.js', "const ws = require('ws');")), ['lib/rbac.js (pure) names the I/O built-in ws']);
  assert.deepEqual(run(add('lib/rbac.js', "const { RoomStore } = require('./store');")), ['lib/rbac.js (pure) requires ./store (lib/store.js), outside the pure set']);
  assert.deepEqual(run(add('lib/rbac.js', "const util = require('util');")), ['lib/rbac.js (pure) requires util, outside the pure set']);
  assert.deepEqual(run(add('lib/board.js', 'const now = () => process.hrtime();')), ['lib/board.js (pure) reads process.']);
  assert.deepEqual(run(add('lib/board.js', "const later = () => import('./rbac.js');")), ['lib/board.js (pure) imports at run time']);
  assert.deepEqual(run({}, [...pure, 'lib/nothere.js']), ['lib/nothere.js is in the pure set and not in the tree']);
  assert.deepEqual(run(add('lib/resilience.js', "require('./store');")), ['a cycle: lib/resilience.js → lib/store.js → lib/resilience.js']);
  assert.deepEqual(run(add('test/units.test.js', "require('../server');")), ['test/units.test.js requires server.js']);
  // app/ itself, by any spelling, is its package.json's main.
  for (const spec of ['..', '../', '../.', './..']) assert.deepEqual(run(add('test/units.test.js', "require('" + spec + "');")), ['test/units.test.js requires server.js'], spec);
  assert.deepEqual(run(add('test/units.test.js', "require('../lib/gone');")), ['test/units.test.js requires ../lib/gone, which is not in the tree']);
  assert.deepEqual(run(add('lib/store.js', "require('./http-accounts');")), ['lib/store.js requires lib/http-accounts.js: only server.js does']);
  assert.deepEqual(run(add('lib/guard.js', "require('./handlers/rooms');")), ['lib/guard.js requires lib/handlers/rooms.js: only server.js does']);
  assert.deepEqual(run(add('lib/store.js', "require('./nothere');")), ['lib/store.js requires ./nothere, which is not in the tree']);
});

// ---------------------------------------------------------------- (f) the wire's words, closed both ways
/** Socket.IO's own events: a page hears these from its client library, and the server's are not verbs a page sends. */
const CLIENT_OWN = ['connect', 'connect_error', 'disconnect'];
const SERVER_OWN = ['disconnect', 'disconnecting'];
/**
 * A server emit whose event is named by an expression, with the names it takes and why. The fence fails on an
 * expression it has no row for, and on a row whose expression no handler file holds any more.
 */
const NAMED_BY_EXPRESSION = {
  opEvent: { names: [...ops.EVENTS], why: 'apply() sends each change under the event the op table (lib/ops.js) names for it: an added message under its kind, an upd\'s fields under theirs, a removal, a reset, a hall\'s new name' },
};
/**
 * A page that names an event by an expression, by `<file>: <call>(<expression>`, with the events it names and why: a
 * carrier that sends what its callers name (their names read at the call sites, so `names` is empty), or listeners made
 * from a table. The fence fails on an expression it has no row for, and on a row whose expression no page holds.
 */
const PAGE_NAMED_BY_EXPRESSION = {
  'public/app.js: socket.on(event': { names: Object.values(ops.UPD_EVENTS), why: 'the op table\'s listeners, one per row of the hall page\'s table, which (k) holds equal to lib/ops.js\'s' },
  'public/outbox.js: socket.emit(verb': { names: [], why: 'the outbox sends what its callers name, each read where it is called: AGM.outbox.hold(\'x\', AGM.outbox.now(\'x\', AGM.outbox.self(\'x\'' },
};
/** A server emit that no page hears, with why. The fence fails on a row a page hears, or that no handler file sends. */
const UNHEARD = {
  linkedRoomsChanged: 'told to a guest\'s pages when the admin lets them forward into another hall, or takes it back; the hall page asks which halls it may forward into as its forward picker opens (myRooms), and hears this once it keeps that fact live',
};

const literal = (re, src) => [...src.matchAll(re)].map((m) => m[2]);
/** Every way a listener is added to a socket, its first argument as written. The fuzz reads one: `socket.on('x'`. */
const LISTENS = /\bsocket\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*([^,)]*)/g;
/** A listener's event: the name a literal gives, or the expression as written. */
const eventOf = (arg) => { const m = /^(['"])([^'"]*)\1$/.exec(arg.trim()); return m ? m[2] : arg.trim(); };
const note = (map, word, file) => { if (!map.has(word)) map.set(word, file); };
/** The words each side uses, read from the handler files (file → source) and the page scripts (file → source). */
function wireWords(handlers, pages) {
  const verbs = new Map(), emits = new Map(), computed = new Map(), sends = new Map(), hears = new Map(), pageComputed = new Map();
  const unread = [];
  for (const [file, src] of handlers) {
    // The fuzz's own read. A listener added in any other form, `once` and `addListener` included, escapes the fuzz, so
    // only Socket.IO's own events, which no page sends, may be heard that way.
    for (const v of [...src.matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1])) note(verbs, v, file);
    for (const m of src.matchAll(LISTENS)) {
      if (/^socket\.on\('[^']+'$/.test(m[0].trim()) || (/^'[^']+'$/.test(m[1].trim()) && SERVER_OWN.includes(eventOf(m[1])))) continue;
      unread.push(file + ' registers a verb in a form the fuzz does not read: ' + m[0].trim());
    }
    for (const e of literal(/\.emit\(\s*(['"])([^'"]+)\1/g, src)) note(emits, e, file);
    for (const m of src.matchAll(/\.emit\(\s*(?![\s'"])([^,)]+)/g)) note(computed, m[1].trim(), file);
  }
  for (const [file, src] of pages) {
    for (const v of literal(/socket\.emit\(\s*(['"])([^'"]+)\1/g, src)) note(sends, v, file);
    for (const v of literal(/AGM\.outbox\.(?:hold|now|self)\(\s*(['"])([^'"]+)\1/g, src)) note(sends, v, file);
    if (file === 'public/catalog.js') for (const v of literal(/\bverb:\s*(['"])([^'"]+)\1/g, src)) note(sends, v, file);
    for (const e of literal(/socket\.(?:on|once)\(\s*(['"])([^'"]+)\1/g, src)) note(hears, e, file);
    for (const m of src.matchAll(/(socket\.(?:emit|on|once)|AGM\.outbox\.(?:hold|now|self))\(\s*(?![\s'"])([^,)]*)/g)) {
      note(pageComputed, file + ': ' + m[1] + '(' + m[2].trim(), { file, sends: !/^socket\.(?:on|once)$/.test(m[1]) });
    }
  }
  return { verbs, emits, computed, sends, hears, pageComputed, unread };
}

/** What leaves the wire's words open, in either direction. Sorted. */
function wireProblems(handlers, pages, { named = NAMED_BY_EXPRESSION, pageNamed = PAGE_NAMED_BY_EXPRESSION, unheard = UNHEARD } = {}) {
  const w = wireWords(handlers, pages);
  const problems = [...w.unread];
  for (const [expr, file] of w.computed) {
    if (!Object.hasOwn(named, expr)) problems.push(file + ' sends an event named by `' + expr + '`, which the fence cannot read');
    else for (const e of named[expr].names) note(w.emits, e, file);
  }
  for (const expr of Object.keys(named)) if (!w.computed.has(expr)) problems.push('no handler file sends `' + expr + '`: its row goes');
  for (const [key, { file, sends }] of w.pageComputed) {
    if (!Object.hasOwn(pageNamed, key)) problems.push(file + ' names an event by an expression the fence cannot read: ' + key.slice(file.length + 2));
    else for (const e of pageNamed[key].names) note(sends ? w.sends : w.hears, e, file);
  }
  for (const key of Object.keys(pageNamed)) if (!w.pageComputed.has(key)) problems.push('no page script holds `' + key + '`: its row goes');
  for (const [v, file] of w.sends) if (!w.verbs.has(v)) problems.push(file + " sends '" + v + "', which no handler file registers");
  for (const [v, file] of w.verbs) if (!SERVER_OWN.includes(v) && !w.sends.has(v)) problems.push(file + " registers '" + v + "', which no page sends");
  for (const [e, file] of w.emits) if (!w.hears.has(e) && !Object.hasOwn(unheard, e)) problems.push(file + " sends '" + e + "', which no page hears");
  for (const [e, file] of w.hears) if (!CLIENT_OWN.includes(e) && !w.emits.has(e)) problems.push(file + " hears '" + e + "', which no handler file sends");
  for (const e of Object.keys(unheard)) {
    if (w.hears.has(e)) problems.push("'" + e + "' is heard now (" + w.hears.get(e) + '): its row in UNHEARD goes');
    else if (!w.emits.has(e)) problems.push("'" + e + "' is no longer sent: its row in UNHEARD goes");
  }
  return problems.sort();
}

test('(f) the wire\'s words: every page send is a verb, every verb is sent, every emit is heard, every listener hears one', () => {
  const handlers = sourcesOf(handlerFiles());
  const pages = sourcesOf(pageScripts());
  assert.deepEqual(wireProblems(handlers, pages), []);
  const w = wireWords(handlers, pages);
  // What each side says, its literals with the names its rows give an expression, so the rules are not passed by reading
  // nothing.
  const emitted = new Set([...w.emits.keys(), ...[...w.computed.keys()].flatMap((e) => NAMED_BY_EXPRESSION[e].names)]);
  const heard = new Set([...w.hears.keys(), ...[...w.pageComputed.keys()].flatMap((k) => PAGE_NAMED_BY_EXPRESSION[k].names)]);
  assert.ok(w.verbs.size > 50 && w.sends.size > 50 && emitted.size > 20 && heard.size > 20, 'read from the tree: ' + JSON.stringify([w.verbs.size, w.sends.size, emitted.size, heard.size]));
  assert.equal(w.sends.get('forward'), 'public/app.js', 'a send in double quotes is read');
  assert.equal(w.sends.get('display:shown'), 'public/display.js', 'the screen\'s page is read');
  assert.ok(!w.verbs.has('typing') && !w.emits.has('typing'), 'no typing: no page sent it or heard it');
  // The pages' writes are sent through the outbox, read at its callers: every message the hall page sends is held by it.
  assert.ok(w.pageComputed.has('public/outbox.js: socket.emit(verb'), 'the outbox sends what its callers name');
  assert.ok(/AGM\.outbox\.hold\('message'/.test(pages.get('public/app.js')) && !/socket\.emit\(\s*['"]message['"]/.test(pages.get('public/app.js')), 'the hall page sends a message only through the outbox');
  // The op table's events are sent through one expression and heard through one, each read by its row.
  assert.equal(w.computed.get('opEvent'), 'server.js', 'apply() sends every change through the op table');
  assert.ok(w.pageComputed.has('public/app.js: socket.on(event'), 'the hall page hears every upd through its table');
  const hallPage = pages.get('public/app.js');
  // Each named once in the hall page, by its table, in whatever quotes: a listener written beside the made ones is a second.
  const namings = (e) => ["'", '"', '`'].reduce((n, q) => n + hallPage.split(q + e + q).length - 1, 0);
  for (const e of Object.values(ops.UPD_EVENTS)) assert.ok(!w.emits.has(e) && namings(e) === 1, e + ' is named by the tables alone, the server\'s and the hall page\'s (' + namings(e) + ' in app.js)');
  // The fuzz reads its events from the same files with the same regex as the verbs here.
  const fuzz = read('test/inputs.test.js');
  assert.ok(fuzz.includes('handlerFiles().flatMap') && fuzz.includes(String.raw`matchAll(/socket\.on\('([^']+)'/g)`), 'the fuzz reads handlerFiles() as the fence does');
});

test('(f) a planted word left open, in either direction, fails it', () => {
  // An event named by an expression is read through a row of the planted tree's own, as the tree's are through theirs.
  const ternary = "io.to(room.code).emit(op.m.type === 'system' ? 'system' : 'message', op.m);";
  const named = { "op.m.type === 'system' ? 'system' : 'message'": { names: ['system', 'message'], why: 'an added message under its kind' } };
  const base = {
    handlers: { 'server.js': ["socket.on('join', (a, ack) => {});", "socket.on('disconnect', () => {});", "io.to(code).emit('roomMeta', {});", ternary, "s.emit('linkedRoomsChanged', { added: code });"].join('\n') },
    pages: { 'public/app.js': ["socket.emit('join', {});", "socket.on('roomMeta', f);", "socket.on('message', f);", "socket.on('system', f);", "socket.on('connect', f);", "socket.on('disconnect', f);"].join('\n') },
  };
  const run = ({ handlers = {}, pages = {} } = {}, opts = {}) => wireProblems(new Map(Object.entries({ ...base.handlers, ...handlers })), new Map(Object.entries({ ...base.pages, ...pages })), { named, pageNamed: {}, ...opts });
  const plus = (side, f, line) => ({ [side]: { [f]: (base[side][f] || '') + '\n' + line } });
  assert.deepEqual(run(), [], 'the planted tree passes');

  // A verb the server registers and an event it broadcasts, which no page sends or hears: open both ways.
  assert.deepEqual(run(plus('handlers', 'server.js', "socket.on('typing', ({ isTyping } = {}) => { socket.to(room.code).emit('typing', { isTyping }); });")),
    ["server.js registers 'typing', which no page sends", "server.js sends 'typing', which no page hears"]);
  assert.deepEqual(run(plus('pages', 'public/app.js', "socket.emit('nope', {});")), ["public/app.js sends 'nope', which no handler file registers"]);
  assert.deepEqual(run(plus('pages', 'public/app.js', "socket.on('ghost', f);")), ["public/app.js hears 'ghost', which no handler file sends"]);
  assert.deepEqual(run(plus('pages', 'public/app.js', 'socket.emit(name, {});')), ['public/app.js names an event by an expression the fence cannot read: socket.emit(name']);
  assert.deepEqual(run(plus('handlers', 'server.js', 'io.emit(ev, {});')), ['server.js sends an event named by `ev`, which the fence cannot read']);
  assert.deepEqual(run(plus('handlers', 'server.js', 'socket.on("quoted", () => {});')), ['server.js registers a verb in a form the fuzz does not read: socket.on("quoted"']);
  // Every other way to add a listener escapes the fuzz, so a verb added that way fails; Socket.IO's own events do not.
  for (const form of ['once', 'addListener', 'prependListener', 'prependOnceListener']) {
    assert.deepEqual(run(plus('handlers', 'server.js', 'socket.' + form + "('ghost', () => {});")), ["server.js registers a verb in a form the fuzz does not read: socket." + form + "('ghost'"], form);
  }
  assert.deepEqual(run(plus('handlers', 'server.js', 'socket .on(\'spaced\', f); socket.once(verb, f);')),
    ["server.js registers a verb in a form the fuzz does not read: socket .on('spaced'", 'server.js registers a verb in a form the fuzz does not read: socket.once(verb']);
  assert.deepEqual(run(plus('handlers', 'server.js', "socket.once('disconnect', onGone); socket.on('disconnecting', f);")), [], 'Socket.IO\'s own events, in any form');

  // A verb in a handler module, sent through the outbox or by a catalogue row, is closed; a `verb:` outside
  // catalog.js is not a send.
  const roomCreate = { handlers: { 'lib/handlers/rooms.js': "socket.on('room:create', (a, ack) => {}); socket.on('room:send', (a, ack) => {});" } };
  assert.deepEqual(run({ ...roomCreate, pages: { 'public/halls.js': "AGM.outbox.hold('room:create', {});", 'public/catalog.js': "{ id: 'msg.send', verb: 'room:send' }" } }), []);
  assert.deepEqual(run({ ...roomCreate, pages: { 'public/halls.js': "AGM.outbox.now('room:create', {}); const row = { verb: 'room:send' };" } }), ["lib/handlers/rooms.js registers 'room:send', which no page sends"]);

  // A page that names an event by an expression is read through its row: a carrier whose callers name the verbs, and
  // listeners made from a table, each with the events it names. A row whose expression has gone goes.
  const carrier = { 'public/outbox.js: socket.emit(verb': { names: [], why: 'the outbox sends what its callers name' }, 'public/app.js: socket.on(ev': { names: ['roomMeta'], why: 'the op table\'s listeners' } };
  const carried = { pages: { 'public/outbox.js': 'socket.emit(verb, args, ack);', 'public/halls.js': "AGM.outbox.hold('join', {});", 'public/app.js': base.pages['public/app.js'].replace("socket.on('roomMeta', f);", 'for (const ev of EVENTS) socket.on(ev, f);') } };
  assert.deepEqual(run(carried, { pageNamed: carrier }), [], 'each expression has its row');
  assert.deepEqual(run(carried), ['public/app.js names an event by an expression the fence cannot read: socket.on(ev', 'public/outbox.js names an event by an expression the fence cannot read: socket.emit(verb', "server.js sends 'roomMeta', which no page hears"], 'no row, no read');
  assert.deepEqual(run({}, { pageNamed: carrier }), ['no page script holds `public/app.js: socket.on(ev`: its row goes', 'no page script holds `public/outbox.js: socket.emit(verb`: its row goes']);

  // The allow-list's rows go with their reasons.
  assert.deepEqual(run(plus('pages', 'public/app.js', "socket.on('linkedRoomsChanged', f);")), ["'linkedRoomsChanged' is heard now (public/app.js): its row in UNHEARD goes"]);
  assert.deepEqual(run({ handlers: { 'server.js': base.handlers['server.js'].replace("s.emit('linkedRoomsChanged', { added: code });", '') } }), ["'linkedRoomsChanged' is no longer sent: its row in UNHEARD goes"]);
  assert.deepEqual(run({ handlers: { 'server.js': base.handlers['server.js'].replace(ternary, "io.to(room.code).emit('message', op.m);") } }),
    ["no handler file sends `op.m.type === 'system' ? 'system' : 'message'`: its row goes", "public/app.js hears 'system', which no handler file sends"]);
});

// ---------------------------------------------------------------- (g) one file list
/**
 * A shipped file outside `handlerFiles()` that listens on a socket, with the events it listens for and why none is a
 * verb. A verb registered anywhere else is fuzzed by nobody and held to no page, so the fence fails on any other
 * listener there, and on a row whose listeners have changed or gone.
 */
const LISTENERS_ELSEWHERE = {
  'lib/tls.js': { names: ['data', 'error'], why: 'the shared port\'s own TCP socket, before HTTP or TLS: its first byte, which says which server takes it, and a reset by its peer' },
};
/** What listens on a socket outside the handler files, in `sources` (file → source). Sorted. */
function elsewhereProblems(sources, handlers, rows = LISTENERS_ELSEWHERE) {
  const problems = [];
  const held = new Set(handlers);
  for (const [file, src] of sources) {
    if (held.has(file)) continue;
    const found = [...src.matchAll(LISTENS)].map((m) => eventOf(m[1])).sort();
    if (!Object.hasOwn(rows, file)) {
      for (const e of found) problems.push(file + " listens on a socket for '" + e + "', outside the handler files, where no fuzz reads it");
    } else if (!found.length) problems.push(file + ' listens on no socket now: its row goes');
    else if (JSON.stringify(found) !== JSON.stringify([...rows[file].names].sort())) problems.push(file + ' listens on a socket for ' + found.join(', ') + ', and its row says ' + [...rows[file].names].sort().join(', '));
  }
  for (const file of Object.keys(rows)) if (!sources.has(file)) problems.push(file + ' is not in the tree: its row goes');
  return problems.sort();
}

test('(g) the handler files are server.js and each module in lib/handlers/, and nothing else', () => {
  const tree = handlerFiles();
  assert.equal(tree[0], 'server.js');
  for (const f of tree.slice(1)) assert.match(f, /^lib\/handlers\/[^/]+\.js$/);
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-handlers-'));
  try {
    assert.deepEqual(handlerFiles(planted), ['server.js'], 'no lib/handlers/ folder: the root alone');
    fs.mkdirSync(path.join(planted, 'lib', 'handlers', 'parts'), { recursive: true });
    for (const f of ['takes.js', 'rooms.js', 'notes.txt', 'parts/helper.js']) fs.writeFileSync(path.join(planted, 'lib', 'handlers', f), '');
    assert.deepEqual(handlerFiles(planted), ['server.js', 'lib/handlers/rooms.js', 'lib/handlers/takes.js'], 'each module, sorted; no other file and no folder below');
  } finally { fs.rmSync(planted, { recursive: true, force: true }); }
});

test('(g) no shipped file outside the handler files listens on a socket, so every verb is one the fuzz and the fence read', () => {
  const sources = sourcesOf(serverCode());
  assert.deepEqual(elsewhereProblems(sources, handlerFiles()), []);
  assert.ok(sources.has('lib/tls.js') && sources.has('supervise.js') && sources.has('verify/page.js'), 'every shipped server file is read');

  const base = { 'server.js': "socket.on('join', f);", 'lib/tls.js': "socket.on('error', f); socket.once('data', g);", 'lib/rbac.js': '// pure' };
  const run = (edit = {}, handlers = ['server.js']) => elsewhereProblems(new Map(Object.entries({ ...base, ...edit })), handlers);
  assert.deepEqual(run(), [], 'the planted tree passes');
  assert.deepEqual(run({ 'lib/extra.js': "function register(socket) { socket.on('sneaky', (a, ack) => {}); }" }), ["lib/extra.js listens on a socket for 'sneaky', outside the handler files, where no fuzz reads it"]);
  assert.deepEqual(run({ 'lib/handlers/parts/more.js': "socket.prependListener('alsoSneaky', f);" }, ['server.js', 'lib/handlers/rooms.js']), ["lib/handlers/parts/more.js listens on a socket for 'alsoSneaky', outside the handler files, where no fuzz reads it"], 'a folder below lib/handlers/ is outside the list');
  assert.deepEqual(run({ 'lib/tls.js': base['lib/tls.js'] + " socket.on('verb', h);" }), ['lib/tls.js listens on a socket for data, error, verb, and its row says data, error']);
  assert.deepEqual(run({ 'lib/tls.js': '// no socket' }), ['lib/tls.js listens on no socket now: its row goes']);
  assert.deepEqual(elsewhereProblems(new Map([['server.js', '']]), ['server.js']), ['lib/tls.js is not in the tree: its row goes']);
});

// ---------------------------------------------------------------- (k) one op table
const CLOSES = { '(': ')', '[': ']', '{': '}' };
/** Where the string, or template, that opens at `i` ends (a template's `${…}` read as code); -1 when it never does. */
function stringEnd(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { const g = groupAt(src, j + 1); if (!g) return -1; j = g.end; continue; }
    if (q !== '`' && src[j] === '\n') return -1;
  }
  return -1;
}
/**
 * The bracketed group that opens at `open` (`{`, `[` or `(`), read as code: strings, templates and comments are passed
 * over, so a bracket or a comma inside one is not the code's. Its top-level entries, split at its commas, each with the
 * comments before it passed over (an entry that is only a comment is none), where each starts (`at`), and the index of
 * its close; null when it never closes, or closes on another bracket.
 */
function groupAt(src, open) {
  const stack = [];
  const entries = [], at = [];
  let start = open + 1;
  const entry = (end) => {
    const raw = src.slice(start, end), code = afterComments(raw).trimEnd();
    if (code) { entries.push(code); at.push(start + raw.length - afterComments(raw).length); }
  };
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = stringEnd(src, i); if (i < 0) return null; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) return null; i = n + 1; continue; }
    if (Object.hasOwn(CLOSES, c)) stack.push(CLOSES[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return null;
      if (!stack.length) { entry(i); return { entries, at, end: i }; }
    } else if (c === ',' && stack.length === 1) { entry(i); start = i + 1; }
  }
  return null;
}
/** Code with the comments before it passed over. */
function afterComments(code) {
  let e = code.trimStart();
  for (;;) {
    const end = e.startsWith('//') ? e.indexOf('\n') : e.startsWith('/*') ? e.indexOf('*/') + 1 : -2;
    if (end === -2) return e;
    e = end < 1 ? '' : e.slice(end + 1).trimStart();
  }
}
/** An object literal's entry: its key and the code of its value (null for a shorthand), or what it is when it has none. */
function keyOf(entry) {
  const e = afterComments(entry);
  if (e.startsWith('...')) return { unread: 'a spread (' + e + ')' };
  const m = /^(?:(['"])([^'"\\]*)\1|([A-Za-z_$][\w$]*))\s*(:|$)/.exec(e);
  if (!m) return { unread: 'an entry the fence cannot read (' + e.split('\n')[0] + ')' };
  return { key: m[2] ?? m[3], value: m[4] === ':' ? e.slice(m[0].length).trim() : null };
}
/** The `{` of the object literal around `i`, read back over the brackets between; -1 when `i` is in no object literal. */
function objectAround(src, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (!depth) return c === '{' ? j : -1; depth--; }
  }
  return -1;
}
/** A kind written `upd`: an `o` key, bare or quoted, and the kind in any quotes. */
const UPD_KIND = /(?:\bo|(['"])o\1)\s*:\s*([`'"])upd\2/g;
/** A call of apply(): not a method's `.apply(`, not a function of that name being declared. */
const APPLY_CALL = /(?<![\w$.])(?<!\bfunction\s+)apply\s*\(/g;
/**
 * What an op literal's entries (each read by keyOf) say: its kind and, for an `upd`, the fields its `f` names, written
 * out; or why the fence cannot read it: a spread or a computed key in the op (either could carry an `o` or an `f` of
 * its own) or in its `f`, or a kind or an `f` that is not written out. A key written twice is lint's (no-dupe-keys).
 */
function readOp(keys) {
  const odd = keys.find((k) => !('key' in k));
  if (odd) return { unread: 'its op holds ' + odd.unread };
  const o = keys.find((k) => k.key === 'o');
  const kind = o && o.value ? /^([`'"])(\w+)\1$/.exec(o.value) : null;
  if (!kind) return { unread: 'its kind is not written out (' + (o ? 'o: ' + (o.value ?? 'o') : 'no o') + ')' };
  if (kind[2] !== 'upd') return { kind: kind[2] };
  const f = keys.find((k) => k.key === 'f');
  const fields = f && f.value && f.value.startsWith('{') ? groupAt(f.value, 0) : null;
  if (!fields || fields.end !== f.value.length - 1) return { unread: 'its f is not written out (' + (f ? 'f: ' + (f.value ?? 'f') : 'no f') + ')' };
  const named = fields.entries.map(keyOf);
  const unread = named.find((k) => !('key' in k));
  return unread ? { unread: 'its f holds ' + unread.unread } : { kind: 'upd', fields: named.map((k) => k.key) };
}
/**
 * Every op in `src` the fence reads, by its line, each once: the op each `apply(` call passes, and every object literal
 * whose kind is written `upd`, wherever it is built. An `apply()` with nothing in it passes no op (a mention, or a call
 * the table refuses); one written out in a comment is read as code. An op it cannot read, or whose kind it cannot read,
 * is never taken for one in the table.
 */
function opLiterals(src) {
  const found = new Map();
  const note = (i, read) => { if (!found.has(i)) found.set(i, { line: src.slice(0, i).split('\n').length, ...read }); };
  for (const m of src.matchAll(APPLY_CALL)) {
    const call = groupAt(src, m.index + m[0].length - 1);
    if (call && !call.entries.length) continue;
    const op = call && call.entries[1];
    const group = op && op.startsWith('{') ? groupAt(src, call.at[1]) : null;
    if (group && group.end === call.at[1] + op.length - 1) note(call.at[1], readOp(group.entries.map(keyOf)));
    else note(m.index, { unread: 'its op is not written out (' + (call ? 'apply(' + call.entries.join(', ').split('\n')[0] + ')' : 'its call does not close') + ')' });
  }
  for (const m of src.matchAll(UPD_KIND)) {
    const open = objectAround(src, m.index);
    const group = open >= 0 ? groupAt(src, open) : null;
    if (group) note(open, readOp(group.entries.map(keyOf)));
    else note(m.index, { unread: 'its op is not an object literal the fence can read' });
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}
/** The hall page's op table, read from its source: field → event, and each row it cannot read. */
function pageTable(src) {
  const m = /\bconst\s+UPD_EVENTS\s*=\s*\{/.exec(src);
  const g = m ? groupAt(src, m.index + m[0].length - 1) : null;
  if (!g) return { rows: new Map(), problems: [m ? 'its op table does not close' : 'it holds no op table (const UPD_EVENTS = {…})'] };
  const rows = new Map();
  const problems = [];
  for (const k of g.entries.map(keyOf)) {
    const ev = k.value ? /^\[\s*(['"])([^'"]+)\1\s*,/.exec(k.value) : null;
    if (ev) rows.set(k.key, ev[2]);
    else problems.push('a row of its op table is not field: [\'event\', draw]: ' + (k.key || k.unread));
  }
  return { rows, problems };
}
/**
 * What leaves the op table open: the hall page's table (`page`, [file, source]) not the server's (`table`, field →
 * event), field by field and event by event; an op in a handler file (file → source) that is not written out, of a kind
 * the table does not hold (`kinds`), or an `upd` whose fields are not written out or not in the table; a row of the
 * table no `upd` sends. Sorted.
 */
function opTableProblems(handlers, [pageFile, pageSrc], table = ops.UPD_EVENTS, kinds = ops.KINDS) {
  const problems = [];
  const read = pageTable(pageSrc);
  for (const p of read.problems) problems.push(pageFile + ': ' + p);
  for (const [f, e] of Object.entries(table)) {
    if (!read.rows.has(f)) problems.push(pageFile + " has no row for '" + f + "', which lib/ops.js sends as '" + e + "'");
    else if (read.rows.get(f) !== e) problems.push("'" + f + "' is sent as '" + e + "' (lib/ops.js) and heard as '" + read.rows.get(f) + "' (" + pageFile + ')');
  }
  for (const f of read.rows.keys()) if (!Object.hasOwn(table, f)) problems.push(pageFile + " has a row for '" + f + "', which lib/ops.js does not send");
  const sent = new Set();
  for (const [file, src] of handlers) {
    for (const u of opLiterals(src)) {
      if (u.unread) { problems.push(file + ':' + u.line + ': an op the fence cannot read: ' + u.unread); continue; }
      if (!kinds.includes(u.kind)) { problems.push(file + ':' + u.line + ": an op of kind '" + u.kind + "', which the op table (lib/ops.js) does not hold"); continue; }
      if (u.kind !== 'upd') continue;
      if (!u.fields.length) problems.push(file + ':' + u.line + ': an upd of no field');
      for (const f of u.fields) {
        if (Object.hasOwn(table, f)) sent.add(f);
        else problems.push(file + ':' + u.line + ": an upd of '" + f + "', a field outside the op table (lib/ops.js)");
      }
    }
  }
  for (const f of Object.keys(table)) if (!sent.has(f)) problems.push("the op table's '" + f + "' is a field no upd sends: its row goes");
  return problems.sort();
}

test('(k) one op table: the hall page\'s is the server\'s, field by field, and every upd changes only its fields', () => {
  const handlers = sourcesOf(handlerFiles());
  const page = ['public/app.js', read('public/app.js')];
  assert.deepEqual(opTableProblems(handlers, page), []);
  // What the read sees, so the rule is not passed by reading nothing: the page's six rows, and the op of every apply()
  // call in server.js, of every kind, each upd's one field (the Stagewatch followers', a spread inside its value) included.
  assert.deepEqual([...pageTable(page[1]).rows], Object.entries(ops.UPD_EVENTS));
  const server = handlers.get('server.js');
  const seen = opLiterals(server);
  assert.equal(seen.length, [...server.matchAll(/(?<![\w$.])apply\((?!\))/g)].length, 'each call\'s op is read once');
  assert.ok(seen.length >= 20 && seen.every((u) => u.kind), JSON.stringify(seen));
  assert.deepEqual([...new Set(seen.map((u) => u.kind))].sort(), [...ops.KINDS].sort(), 'an op of every kind is read');
  const upds = seen.filter((u) => u.kind === 'upd');
  assert.ok(upds.length >= 9 && upds.every((u) => u.fields.length === 1), JSON.stringify(upds));
  assert.deepEqual([...new Set(upds.flatMap((u) => u.fields))].sort(), Object.keys(ops.UPD_EVENTS).sort());
});

test('(k) apply() is the op table\'s: made once in server.js by lib/ops.js, and its refusal is a log line and nothing more', () => {
  const handlers = sourcesOf(handlerFiles());
  const server = handlers.get('server.js');
  const MADE = 'const apply = ops.applier(';
  const at = server.indexOf(MADE);
  assert.ok(at > 0 && server.indexOf(MADE, at + 1) < 0, 'server.js makes apply() once, from the op table');
  // No other apply() is declared or assigned in a handler file, so every call the fence reads is the table's.
  for (const [file, src] of handlers) {
    assert.doesNotMatch(file === 'server.js' ? src.replace(MADE, '') : src, /\bfunction\s+apply\s*\(|\b(?:const|let|var)\s+apply\b|(?<![\w$.])apply\s*=(?!=)/, file + ' makes no apply() of its own');
  }
  // What it is given: the store's commit, the hall's send (the wire fence reads its event, opEvent), the board's mark,
  // and a refusal that only logs the words ops.refusal() gives (a kind and field names, never a value), so the
  // refusal's own path cannot throw, the Stagewatch followers' included.
  const given = groupAt(server, at + MADE.length);
  const wiring = new Map(given.entries.map(keyOf).map((k) => [k.key, k.value]));
  assert.deepEqual([...wiring.keys()], ['commit', 'send', 'changed', 'refused']);
  assert.equal(wiring.get('commit'), '(room, op) => store.commit(room, op)');
  assert.match(wiring.get('refused'), /^\(why\) => console\.error\('[^'\\]*' \+ why\)$/);
});

test('(k) a planted upd of a field outside the table, and a page table out of step, each fail it', () => {
  const table = { pinned: 'pinUpdate', stage: 'stageAck' };
  const base = {
    handlers: {
      'server.js': [
        "apply(room, { o: 'upd', id: messageId, f: { pinned: !!pinned } });",
        "if (m && m.stage) apply(room, { o: 'upd', id, f: { stage: { ...m.stage, ack, by: t.by } } });",
      ].join('\n'),
    },
    page: "const UPD_EVENTS = {\n  pinned: ['pinUpdate', setMessagePinned],\n  stage: ['stageAck', setStage],\n};",
  };
  const run = ({ handlers = {}, page = base.page } = {}) => opTableProblems(new Map(Object.entries({ ...base.handlers, ...handlers })), ['public/app.js', page], table);
  const plus = (line) => ({ handlers: { 'server.js': base.handlers['server.js'] + '\n' + line } });
  assert.deepEqual(run(), [], 'the planted tree passes');

  // An upd of a field outside the table: in server.js or a handler module, in either quotes, its `o` anywhere in the op.
  assert.deepEqual(run(plus("apply(S, { o: 'upd', id: copy, f: { sentTo: { ...copy.sentTo, withdrawn: Date.now() } } });")), ["server.js:3: an upd of 'sentTo', a field outside the op table (lib/ops.js)"]);
  assert.deepEqual(run({ handlers: { 'lib/handlers/rooms.js': 'apply(r, { id: m.id, f: { pinned: true, sentTo: x }, o: "upd" });' } }), ["lib/handlers/rooms.js:1: an upd of 'sentTo', a field outside the op table (lib/ops.js)"]);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { 'help': h } });")), ["server.js:3: an upd of 'help', a field outside the op table (lib/ops.js)"], 'a quoted key is read');
  // Its fields are read as code: a bracket, a comma or a field-like word in a string, a template or a comment is none.
  // eslint-disable-next-line no-template-curly-in-string -- the planted source holds a template's ${…} on purpose
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { stage: { ack: '}, help: 1', by: `${a ? '{' : ''}, x` } /* , help: 1 */ } });")), []);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { /* the one field */ pinned: true, // and no other\n } });")), [], 'a comment before a key, or after the last');
  // An upd whose fields are not written out is never taken for one in the table.
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { ...fields } });")), ['server.js:3: an op the fence cannot read: its f holds a spread (...fields)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { [field]: v } });")), ['server.js:3: an op the fence cannot read: its f holds an entry the fence cannot read ([field]: v)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: fields });")), ['server.js:3: an op the fence cannot read: its f is not written out (f: fields)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f });")), ['server.js:3: an op the fence cannot read: its f is not written out (f: f)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id });")), ['server.js:3: an op the fence cannot read: its f is not written out (no f)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: { pinned } || x });")), ['server.js:3: an op the fence cannot read: its f is not written out (f: { pinned } || x)']);
  assert.deepEqual(run(plus("const kind = [o: 'upd'];")), ['server.js:3: an op the fence cannot read: its op is not an object literal the fence can read']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', id, f: {} });")), ['server.js:3: an upd of no field']);
  // However its kind is written: a quoted `o`, a kind in a template's quotes.
  assert.deepEqual(run(plus(`apply(room, { "o": 'upd', id: messageId, f: { sentTo: 1 } });`)), ["server.js:3: an upd of 'sentTo', a field outside the op table (lib/ops.js)"]);
  assert.deepEqual(run(plus('apply(room, { o: `upd`, id: messageId, f: { sentTo: 1 } });')), ["server.js:3: an upd of 'sentTo', a field outside the op table (lib/ops.js)"]);
  // An op given to apply() whose kind, or whose own entries, are not written out is never taken for one in the table: a
  // kind from a variable, a spread over the op (which may bring an `f` or an `o` of its own), a computed key, an op held
  // in a variable (and an upd built in one is read where it is built), no op at all.
  assert.deepEqual(run(plus("const UPD = 'upd'; apply(room, { o: UPD, id: messageId, f: { sentTo: 1 } });")), ['server.js:3: an op the fence cannot read: its kind is not written out (o: UPD)']);
  assert.deepEqual(run(plus("apply(room, { o: 'upd', f: { pinned: true }, id: messageId, ...{ f: { sentTo: 1 } } });")), ['server.js:3: an op the fence cannot read: its op holds a spread (...{ f: { sentTo: 1 } })']);
  assert.deepEqual(run(plus("apply(room, { o: 'add', m, ...extra });")), ['server.js:3: an op the fence cannot read: its op holds a spread (...extra)']);
  assert.deepEqual(run(plus("apply(room, { [key]: 'upd', id, f: { sentTo: 1 } });")), ['server.js:3: an op the fence cannot read: its op holds an entry the fence cannot read ([key]: \'upd\')']);
  assert.deepEqual(run(plus("apply(room, { id, f: { sentTo: 1 } });")), ['server.js:3: an op the fence cannot read: its kind is not written out (no o)']);
  assert.deepEqual(run(plus("const op = { o: 'upd', id, f: { sentTo: 1 } };\napply(room, op);")), [
    "server.js:3: an upd of 'sentTo', a field outside the op table (lib/ops.js)",
    'server.js:4: an op the fence cannot read: its op is not written out (apply(room, op))',
  ]);
  assert.deepEqual(run(plus('apply(room);')), ['server.js:3: an op the fence cannot read: its op is not written out (apply(room))']);
  assert.deepEqual(run(plus("apply(room, { o: 'rename', name });")), ["server.js:3: an op of kind 'rename', which the op table (lib/ops.js) does not hold"]);
  // Every other kind the table holds passes, written out; a method's .apply(, and apply() with nothing in it, are not its.
  assert.deepEqual(run(plus("apply(r, { o: 'add', m }); apply(r, { o: 'del', id }); apply(r, { o: 'reset' }); apply(r, { o: \"meta\", name: n });")), []);
  assert.deepEqual(run(plus('fn.apply(this, args); Math.max.apply(null, xs); // apply() answers null')), []);

  // The page's table, field by field and event by event, and a row of the table no upd sends.
  assert.deepEqual(run({ page: base.page.replace("  stage: ['stageAck', setStage],\n", '') }), ["public/app.js has no row for 'stage', which lib/ops.js sends as 'stageAck'"]);
  assert.deepEqual(run({ page: base.page.replace('};', "  sentTo: ['sentUpdate', setSentTo],\n};") }), ["public/app.js has a row for 'sentTo', which lib/ops.js does not send"]);
  assert.deepEqual(run({ page: base.page.replace("['stageAck'", "['stageUpdate'") }), ["'stage' is sent as 'stageAck' (lib/ops.js) and heard as 'stageUpdate' (public/app.js)"]);
  assert.deepEqual(run({ page: base.page.replace("['pinUpdate', setMessagePinned]", 'PIN_ROW') }), ["public/app.js has no row for 'pinned', which lib/ops.js sends as 'pinUpdate'", "public/app.js: a row of its op table is not field: ['event', draw]: pinned"]);
  assert.deepEqual(run({ page: '// no table' }), ["public/app.js has no row for 'pinned', which lib/ops.js sends as 'pinUpdate'", "public/app.js has no row for 'stage', which lib/ops.js sends as 'stageAck'", 'public/app.js: it holds no op table (const UPD_EVENTS = {…})']);
  assert.deepEqual(run({ handlers: { 'server.js': base.handlers['server.js'].split('\n')[0] } }), ["the op table's 'stage' is a field no upd sends: its row goes"]);
});
