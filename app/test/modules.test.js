'use strict';
// The module fence (docs/ANALYSIS.md §3.5): the server's layers, read from its require() calls, the wire's words, read
// from the files that register socket verbs (`handlerFiles()`) and from every page script, closed both ways, and the
// store's any-room readers, counted per file. Each rule is a function of the sources it is given, so the tree is held to
// it and a planted breach of each kind fails it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, filesUnder, handlerFiles, pageScripts } = require('./helpers');
const ops = require('../lib/ops');
const gateLib = require('../lib/gate');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sourcesOf = (files) => new Map(files.map((f) => [f, read(f)]));
/** The files the shipped server is made of: its two processes' entry points, lib/ and the audit log's verifier. */
const serverCode = () => ['server.js', 'supervise.js', ...filesUnder('lib', /\.[cm]?js$/), ...filesUnder('verify', /\.[cm]?js$/)];

// ---------------------------------------------------------------- (a)-(c) the server's layers
/** The pure core: functions of what they are given, their clocks default arguments. They require only each other. */
const PURE = ['lib/board.js', 'lib/busy.js', 'lib/context.js', 'lib/deskresults.js', 'lib/gate.js', 'lib/latest.js', 'lib/ops.js', 'lib/rbac.js', 'lib/stagelines.js', 'lib/tunnelend.js'];
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

// ---------------------------------------------------------------- (d), (i), (j) the handler modules
/** A handler module: a file directly in lib/handlers/ (plan 5-§14.2). */
const HANDLER_MODULE = /^lib\/handlers\/[^/]+\.js$/;
/**
 * What every handler module may require besides the pure core, each file with the names it may take from it (null:
 * any), and why. Nothing else: no built-in (fs, child_process), no package, no store or edge (lib/resilience.js
 * included): a store or a link reaches a handler module only through its context.
 */
const HANDLER_MAY = {
  'lib/guard.js': { names: ['str', 'cleanText', 'mac', 'Bucket'], why: 'its pure helpers, by name: guard reads the server secret once, at server.js\'s first require of it, and a handler module reaches none of what touches a disk' },
  'lib/ids.js': { names: null, why: 'ids made from node:crypto, nothing kept' },
};
/** A store or an edge one handler module requires by name, for the pure functions it holds, with why. */
const HANDLER_ROWS = {
  'lib/handlers/takes.js': {
    'lib/pages.js': { names: ['cleanPage', 'describePage', 'canShow', 'cleanSnippet'], why: 'the pages\' pure vocabulary, kept where it is tested; the store itself reaches the module through its context' },
  },
};

/**
 * `src` with its comments blanked and, unless `strings` is false, the words of its strings and templates blanked too
 * (their quotes, and a template's `${…}` code, kept): the same length, line for line, so an index or a line of it is the
 * source's. A regular expression literal is read as code, as every read here does.
 */
function blank(src, { strings = true } = {}) {
  const out = src.split('');
  const fill = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const quoted = (open) => {
    const q = src[open];
    let from = open + 1, j = open + 1;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === q || (q !== '`' && src[j] === '\n')) break;
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
        if (strings) fill(from, j);
        const g = groupAt(src, j + 1);
        if (!g) return src.length;
        const inner = blank(src.slice(j + 2, g.end), { strings });
        for (let k = 0; k < inner.length; k++) out[j + 2 + k] = inner[k];
        j = g.end;
        from = j + 1;
      }
    }
    if (strings) fill(from, Math.min(j, src.length));
    return j + 1;
  };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); const end = n < 0 ? src.length : n; fill(i, end); i = end; }
    else if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); const end = n < 0 ? src.length : n + 2; fill(i, end); i = end; }
    else if (c === "'" || c === '"' || c === '`') i = quoted(i);
    else i++;
  }
  return out.join('');
}
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

/** A destructuring's entries (`a`, `b: c`, `d = 1`, `...e`): the names it takes and the names it binds, or null. */
const IDENT = /^[A-Za-z_$][\w$]*$/;
function destructured(inner) {
  const takes = [], binds = [];
  for (const raw of inner.split(',').map((e) => e.trim()).filter(Boolean)) {
    if (raw.startsWith('...')) {
      const name = raw.slice(3).trim();
      if (!IDENT.test(name)) return null;
      takes.push('...');
      binds.push(name);
      continue;
    }
    const [key, bind = key] = raw.split('=')[0].split(':').map((e) => e.trim());
    if (!IDENT.test(key) || !IDENT.test(bind)) return null;
    takes.push(key);
    binds.push(bind);
  }
  return { takes, binds };
}
/** A declaration's binding from a require: a name (`const x = require(…)`) or a destructuring (`const { a } = require(…)`). */
const REQUIRE_DECL = /\b(?:const|let|var)(?:\s+([A-Za-z_$][\w$]*)|\s*\{([^{}]*)\})\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)/g;
/** A declaration from a name, or from one member of it: `const B = guard.Bucket`, `const r = roles`, `const { X } = m`. */
const NAME_DECL = /\b(?:const|let|var)(?:\s+([A-Za-z_$][\w$]*)|\s*\{([^{}]*)\})\s*=\s*([A-Za-z_$][\w$]*)/g;
/** The member a declaration from a name takes, read after it (`.Bucket` of `= guard.Bucket`), or null. */
const memberAfter = (code, i) => { const m = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i)); return m ? m[1] : null; };
/**
 * What a source requires and how, read as code with its strings kept: each require's spec with the names it takes (null:
 * the module whole), the names bound to that module whole (`whole`, followed through `const r = roles`) and the names
 * taken from one of those later (`via`: `const { can } = roles`, `const may = roles.can`, each with where); and every
 * name bound to anything it requires, followed through the names given each other (`bound`).
 */
function requireBindings(src) {
  const code = blank(src, { strings: false });
  const decls = [];
  const bound = new Set();
  for (const m of code.matchAll(REQUIRE_DECL)) {
    const d = m[2] === undefined ? null : destructured(m[2]);
    decls.push({ spec: m[4], at: m.index, end: m.index + m[0].length, takes: m[1] ? null : d ? d.takes : ['an unread destructuring'], whole: new Set(m[1] ? [m[1]] : []), via: [] });
    for (const n of m[1] ? [m[1]] : d ? d.binds : []) bound.add(n);
  }
  // A require outside a declaration (`require('../guard').str(x)`) takes its module whole.
  const loose = [...code.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)]
    .filter((m) => !decls.some((d) => m.index >= d.at && m.index < d.end))
    .map((m) => ({ spec: m[2], at: m.index, end: m.index + m[0].length, takes: null, whole: new Set(), via: [] }));
  const requires = [...decls, ...loose];
  for (let grew = true; grew;) {
    grew = false;
    for (const m of code.matchAll(NAME_DECL)) {
      const d = m[2] === undefined ? null : destructured(m[2]);
      const binds = m[1] ? [m[1]] : d ? d.binds : [];
      const member = memberAfter(code, m.index + m[0].length);
      if (bound.has(m[3])) for (const n of binds) if (!bound.has(n)) { bound.add(n); grew = true; }
      for (const r of requires) {
        if (!r.whole.has(m[3])) continue;
        const taken = member ? [member] : d ? d.takes : [];
        if (!member && m[1] && !r.whole.has(m[1])) { r.whole.add(m[1]); grew = true; }
        for (const k of taken) if (!r.via.some((v) => v.name === k && v.at === m.index)) { r.via.push({ name: k, at: m.index }); grew = true; }
      }
    }
  }
  return { requires, bound };
}

/**
 * What reaches a module, the machine or another process without a literal require: none of it is named in a handler
 * module (read as code), so what it requires is what (d) reads. `module.exports` is its own.
 */
const HANDLER_NEVER = [
  [/\bimport\s*\(/g, 'imports at run time: a handler module requires by a literal path'],
  [/\brequire\b(?!\s*\(\s*['"])/g, 'names require other than to require a literal path'],
  [/(?<![.\w$])process\b/g, 'names process: the server hands a handler module what it reads of the machine'],
  [/(?<![.\w$])module\s*\.\s*(?!exports\b)/g, 'names module other than for its exports'],
  [/(?<![.\w$])(?:globalThis|global)\b/g, 'names the global object, where what it requires cannot be read'],
];

/**
 * (d) What a handler module in `sources` (file → source) requires beyond what the plan's row allows, reaches without a
 * literal require, or makes of what it requires (`new`). `has` says what else is in the tree. Sorted.
 */
function requireProblems(sources, { pure = PURE, may = HANDLER_MAY, rows = HANDLER_ROWS, has = (f) => sources.has(f) } = {}) {
  const problems = [];
  for (const [file, src] of sources) {
    if (!HANDLER_MODULE.test(file)) continue;
    const { requires, bound } = requireBindings(src);
    const code = blank(src);
    for (const r of requires) {
      const where = file + ':' + lineAt(src, r.at) + ': ';
      if (!/^\.\.?(\/|$)/.test(r.spec)) { problems.push(where + 'requires ' + r.spec + ': a handler module requires no built-in and no package'); continue; }
      const to = resolve(file, r.spec, has);
      if (!to || pure.includes(to)) continue;   // a file not there is the layers' (a)-(c) to say
      const row = Object.hasOwn(may, to) ? may[to] : rows[file] && Object.hasOwn(rows[file], to) ? rows[file][to] : null;
      if (!row) { problems.push(where + 'requires ' + to + ': a store, a link or an edge reaches a handler module only through its context'); continue; }
      if (!row.names) continue;
      if (!r.takes) problems.push(where + 'takes ' + to + ' whole: it takes ' + row.names.join(', ') + ' by name (const { … } = require(…))');
      else for (const n of r.takes) if (!row.names.includes(n)) problems.push(where + 'takes ' + n + ' from ' + to + ', which is not among its pure helpers (' + row.names.join(', ') + ')');
    }
    for (const [re, words] of HANDLER_NEVER) for (const m of code.matchAll(re)) problems.push(file + ':' + lineAt(src, m.index) + ': ' + words);
    for (const m of code.matchAll(/\bnew\s+[\s(]*([A-Za-z_$][\w$]*)/g)) {
      if (m[1] === 'require' || bound.has(m[1])) problems.push(file + ':' + lineAt(src, m.index) + ': makes what it requires (new ' + m[1] + '): it is given the server\'s, through its context');
    }
  }
  return problems.sort();
}

/**
 * (d) A handler module's context read anywhere but once: `register(socket, conn, ctx)` names it, and its first statement,
 * `const { … } = ctx;` (no rest), is then the one other place it is named, so that line is the module's list of what it
 * reaches of the server (plan 5-§14.2, as lib/http-accounts.js does). A module that reads nothing of it names it only
 * as register's. Sorted.
 */
function contextProblems(sources) {
  const problems = [];
  for (const [file, src] of sources) {
    if (!HANDLER_MODULE.test(file)) continue;
    const code = blank(src);
    const head = /\bfunction\s+register\s*\(/.exec(code);
    const params = head ? groupAt(code, head.index + head[0].length - 1) : null;
    if (!params || params.entries.join(',') !== 'socket,conn,ctx') { problems.push(file + ': gives no function register(socket, conn, ctx)'); continue; }
    const named = namedAt(code, 'ctx').filter((i) => i > params.end);
    if (!named.length) continue;
    let open = params.end + 1;
    while (/\s/.test(code[open] || '')) open++;
    const rest = code.slice(open + 1);
    const first = rest.trimStart();
    const line = /^const\s*\{([^{}]*)\}\s*=\s*ctx\s*;/.exec(first);
    const d = line ? destructured(line[1]) : null;
    const at = open + 1 + (rest.length - first.length);
    const ok = code[open] === '{' && d && !d.takes.includes('...') && named.length === 1 && named[0] > at && named[0] < at + line[0].length;
    if (!ok) problems.push(file + ':' + lineAt(src, named.find((i) => !(line && i > at && i < at + line[0].length)) ?? named[0]) + ': reads ctx other than once, destructured as register\'s first statement (const { … } = ctx;, no rest): that line is the module\'s list of what it reaches');
  }
  return problems.sort();
}

/** The block body of the function written at `at` (an arrow or a function expression): where its `{` opens, or -1. */
function bodyOpen(src, at) {
  let i = at;
  const spaces = () => { while (/\s/.test(src[i] || '')) i++; };
  const name = () => { const from = i; while (/[\w$]/.test(src[i] || '')) i++; return src.slice(from, i); };
  const word = (w) => src.startsWith(w, i) && !/[\w$]/.test(src[i + w.length] || '');
  if (word('async')) { i += 5; spaces(); }
  if (word('function')) { i += 8; spaces(); name(); spaces(); }
  if (src[i] === '(') { const g = groupAt(src, i); if (!g) return -1; i = g.end + 1; }
  else if (!IDENT.test(name())) return -1;
  spaces();
  if (src.startsWith('=>', i)) { i += 2; spaces(); }
  return src[i] === '{' ? i : -1;
}
/**
 * The parameters of the function written at `at` (an arrow or a function expression), each as written (`args`,
 * `{ id } = {}`, `ack`), or null when they cannot be read.
 */
function paramsAt(src, at) {
  let i = at;
  const spaces = () => { while (/\s/.test(src[i] || '')) i++; };
  const name = () => { const from = i; while (/[\w$]/.test(src[i] || '')) i++; return src.slice(from, i); };
  const word = (w) => src.startsWith(w, i) && !/[\w$]/.test(src[i + w.length] || '');
  if (word('async')) { i += 5; spaces(); }
  if (word('function')) { i += 8; spaces(); name(); spaces(); }
  if (src[i] === '(') { const g = groupAt(src, i); return g ? g.entries : null; }
  const one = name();
  return IDENT.test(one) ? [one] : null;
}
const GATE_CALL = /\bconn\s*\.\s*gate\s*\(/g;
const GATE_FIRST = /^if\s*\(\s*!\s*conn\s*\.\s*gate\s*\(/;
/** The connection's buckets (conn.writes, conn.chatter: server.js's conn, held by the contexts' source read). */
const CONN_BUCKETS = ['writes', 'chatter'];
/** A reason in a comment: two words at least. */
const REASON = /\/\/\s*\S+\s+\S|\/\*\s*\S+\s+\S/;
/** The names a source takes from `conn` as themselves (`const { writes, gate } = conn`): a rename is not one. */
function takenFromConn(code) {
  const names = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*conn\b/g)) {
    const d = destructured(m[1]);
    if (d) d.takes.forEach((k, i) => { if (d.binds[i] === k) names.add(k); });
  }
  return names;
}

/**
 * (i) Each listener a handler module adds (`socket.on(`, but Socket.IO's own `disconnect` and `disconnecting`, which no
 * page sends and which carry no acknowledgement) whose first statement is not its one gate call,
 * `if (!conn.gate(ack, {…})) return;`, answering the listener's own last argument (its acknowledgement, by name), or
 * whose gate does not name one of the connection's buckets (`conn.writes`, or `writes` taken from conn as itself) or say
 * `bucket: null` with why on its line or the line before, takes an option the gate does not, or is passed more than
 * once; and a gate call outside a verb. Sorted.
 */
function gateProblems(sources, options = gateLib.OPTIONS) {
  const problems = [];
  for (const [file, src] of sources) {
    if (!HANDLER_MODULE.test(file)) continue;
    const code = blank(src);
    const fromConn = takenFromConn(code);
    const listeners = [...code.matchAll(/\bsocket\s*\.\s*on\s*\(/g)].map((m) => {
      const call = groupAt(src, m.index + m[0].length - 1);
      const verb = call && call.entries[0] ? call.entries[0] : '(unread)';
      return { m, call, verb, own: /^'[^']+'$/.test(verb) && SERVER_OWN.includes(verb.slice(1, -1)) };
    });
    const verbs = listeners.filter((l) => !l.own);
    const gates = (code.match(GATE_CALL) || []).length;
    if (gates !== verbs.length) problems.push(file + ': ' + gates + ' gate calls for ' + verbs.length + ' verbs: each verb passes one, first, and none stands outside a verb');
    for (const { m, call, verb } of verbs) {
      const where = file + ':' + lineAt(src, m.index) + ': ' + verb + ' ';
      const open = call && call.entries.length === 2 ? bodyOpen(src, call.at[1]) : -1;
      const body = open >= 0 ? groupAt(src, open) : null;
      if (!body) { problems.push(where + 'is not a listener written in place with a block body: its gate cannot be read'); continue; }
      const inBody = (code.slice(open, body.end).match(GATE_CALL) || []).length;
      if (inBody > 1) problems.push(where + 'passes the gate ' + inBody + ' times: once, first');
      const rest = src.slice(open + 1, body.end);
      const first = afterComments(rest);
      const head = GATE_FIRST.exec(first);
      if (!head) { problems.push(where + 'does not start with its gate: if (!conn.gate(ack, { bucket: … })) return;'); continue; }
      const paren = open + 1 + (rest.length - first.length) + head[0].length - 1;
      const g = groupAt(src, paren);
      if (!g || !/^\s*\)\s*return\b/.test(src.slice(g.end + 1))) { problems.push(where + 'does not return when its gate refuses: if (!conn.gate(ack, { bucket: … })) return;'); continue; }
      // The refusal answers the sender: the gate is handed the listener's own acknowledgement, its last argument.
      const params = paramsAt(src, call.at[1]);
      const ack = params && params.length ? params[params.length - 1] : null;
      if (!ack || !IDENT.test(ack)) problems.push(where + 'takes no acknowledgement its gate could answer: its last argument is the ack, by name (args, ack)');
      else if (g.entries[0] !== ack) problems.push(where + 'gives its gate ' + (g.entries[0] || 'nothing') + ' to answer, not its acknowledgement: if (!conn.gate(' + ack + ', { bucket: … })) return;');
      const opts = g.entries[1] && g.entries[1].startsWith('{') ? groupAt(src, g.at[1]) : null;
      if (!opts || opts.end !== g.at[1] + g.entries[1].length - 1 || g.entries.length !== 2) { problems.push(where + 'gives its gate options it does not write out: (ack, { bucket: … })'); continue; }
      const keys = opts.entries.map(keyOf);
      const odd = keys.find((k) => !('key' in k));
      if (odd) { problems.push(where + 'gives its gate ' + odd.unread); continue; }
      for (const k of keys) if (!options.includes(k.key)) problems.push(where + 'gives its gate an option it does not take: ' + k.key);
      const i = keys.findIndex((k) => k.key === 'bucket');
      if (i < 0 || keys[i].value === null) { problems.push(where + 'names no bucket: bucket: conn.writes, or bucket: null with why'); continue; }
      const value = keys[i].value;
      if (value === 'null') {
        const at = opts.at[i];
        const lines = src.split('\n');
        const n = lineAt(src, at) - 1;
        if (!REASON.test(lines[n]) && !(n > 0 && /^\s*\/[/*]/.test(lines[n - 1]) && REASON.test(lines[n - 1]))) problems.push(where + 'says bucket: null without why: a comment on its line, or the line before');
      } else if (!CONN_BUCKETS.some((b) => value.replace(/\s+/g, '') === 'conn.' + b || (value === b && fromConn.has(b)))) {
        problems.push(where + 'gives its gate a bucket that is not the connection\'s: bucket: ' + value + ' (conn.writes, conn.chatter, or one taken from conn by its name)');
      }
    }
  }
  return problems.sort();
}

/** The takes module reaches a page by its socket's id alone (takesCtx.sendTo): none of these names a room or a broadcast. */
const TAKES_NEVER = [
  ['io', /\bio\b/g],
  ['.to(', /\.\s*to\s*\(/g],
  ['.in(', /\.\s*in\s*\(/g],
  ['.broadcast', /\.\s*broadcast\b/g],
  ['.nsp', /\.\s*nsp\b/g],
  ['.server', /\.\s*server\b/g],
  ['.except(', /\.\s*except\s*\(/g],
  ['socket.join(', /\bsocket\s*\.\s*join\s*\(/g],
  ['socket.leave(', /\bsocket\s*\.\s*leave\s*\(/g],
  ['a member named by a string', /[\w$)\]]\s*\[\s*['"`]/g],
];
/**
 * The room store's readers, the one way the takes module reaches it: a take reads who is in a room and writes none
 * (lib/store.js: the halls' `get` and `has`, the any-room readers `room`, `hasRoom`, `allRooms`, `roomsOf`, and
 * `isMain`). A unit whose take reads another adds it here, with why.
 */
const TAKES_STORE_READS = ['get', 'has', 'room', 'hasRoom', 'allRooms', 'roomsOf', 'isMain'];
/**
 * What a call on a path into settings may be: a read, which returns what it reads or a copy and changes nothing.
 * Anything else (`push`, `splice`, `sort`, `set`, `add`, `delete`, a method named by an expression) may write it.
 */
const SETTINGS_READS = [
  'at', 'concat', 'entries', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'get', 'has',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'reduce', 'reduceRight', 'slice', 'some', 'toReversed', 'toSorted', 'toSpliced',
  'values', 'with', 'endsWith', 'startsWith', 'toLowerCase', 'toUpperCase', 'trim', 'toString',
];
/** A read of a part that is a count, never an object a write could go through. */
const COUNTS = ['length', 'size'];
/** The operators that assign: `=`, and each compound one. */
const ASSIGNS = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='];
/** Before a path that writes settings through a call: Object's and Reflect's writers. */
const WRITERS = /\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty))\s*\(\s*$/;
/** Before a path handed to a function as its `this` or its first argument, where what the function does to it cannot be read. */
const handedAsThis = (before) => /\.\s*(?:call|apply)\s*\(\s*$/.test(before) || /\.\s*(?:call|apply)\s*\(\s*[\w$.]+\s*,\s*$/.test(before);

/** Each index in `code` where `name` stands as a whole word (not part of a longer name). */
function namedAt(code, name) {
  const at = [];
  for (let i = code.indexOf(name); i >= 0; i = code.indexOf(name, i + 1)) {
    if (/[\w$]/.test(code[i - 1] || '') || /[\w$]/.test(code[i + name.length] || '')) continue;
    at.push(i);
  }
  return at;
}
/**
 * Each place `name` stands in `code` (comments and strings blanked), read as a path: the names before it (`root`: `ctx`
 * for `ctx.settings`, '' for none), its members after it (`.x`, `?.x`, `[k]`, each a name or '[]'), and the code before
 * the path and after it.
 */
function pathsOf(code, name) {
  return namedAt(code, name).map((index) => {
    let start = index;
    for (;;) {
      let k = start;
      while (k > 0 && /\s/.test(code[k - 1])) k--;
      if (code[k - 1] !== '.' || code[k - 2] === '.') break;
      k -= code[k - 2] === '?' ? 2 : 1;
      while (k > 0 && /\s/.test(code[k - 1])) k--;
      const end = k;
      while (k > 0 && /[\w$]/.test(code[k - 1])) k--;
      if (k === end) break;
      start = k;
    }
    const members = [];
    let i = index + name.length;
    for (;;) {
      let k = i;
      while (/\s/.test(code[k] || '')) k++;
      if (code[k] === '[') { const close = code.indexOf(']', k); if (close < 0) break; i = close + 1; members.push('[]'); continue; }
      if (code.startsWith('?.', k) && code[k + 2] !== '[' && code[k + 2] !== '(') k += 2;
      else if (code[k] === '.' && code[k + 1] !== '.') k += 1;
      else break;
      while (/\s/.test(code[k] || '')) k++;
      const from = k;
      while (/[\w$]/.test(code[k] || '')) k++;
      if (k === from) break;
      i = k;
      members.push(code.slice(from, k));
    }
    const root = code.slice(start, index).replace(/\s+/g, '').replace(/\??\.$/, '');
    return { index, root, members, before: code.slice(0, start).trimEnd(), after: code.slice(i).trimStart() };
  });
}
/** A path called (`x.y(`, `x.y?.(`). */
const called = (p) => p.after.startsWith('(') || p.after.startsWith('?.(');
/** A path given to a binding of another name: `const s = x`, `y = x.a;`, `const { a } = x;`, or `{ x: s }` in a destructuring. */
const takenUnderAnotherName = (p) => (/(?:^|[^=!<>+\-*/%&|^?])=$/.test(p.before) && /^(?:[;,)\]}]|$)/.test(p.after))
  || (!p.members.length && /\b(?:const|let|var)\s*\{[^{}]*$/.test(p.before) && p.after.startsWith(':'));
/** The rest of a destructuring of ctx, read from just after one of its entries: `, pages } = ctx`, `} = ctx`. */
const closesOnCtx = (after) => /^\}\s*=\s*ctx\b/.test(after) || /^,[^{}]*\}\s*=\s*ctx\b/.test(after);
/** An entry of a destructuring: a bare name with a declaration's `{` open before it. */
const inDestructuring = (p) => !p.root && !p.members.length && /\b(?:const|let|var)\s*\{[^{}]*$/.test(p.before);
/** A bare name that is an entry of a destructuring of ctx as itself: `const { store, pages } = ctx;`. */
const takenFromCtx = (p) => inDestructuring(p) && closesOnCtx(p.after);

/**
 * Each write into settings in `code` (comments and strings blanked), as [index, words]: a path into it (`settings.x`,
 * `settings[k]`, `ctx.settings.x`) assigned, counted, deleted or called by a method that is not a read
 * (`settings.roomSends.push(…)`), settings given to Object's or Reflect's writers or handed to a function as its `this`,
 * and settings, or a part of it, taken under another name, where a write through that name could not be read.
 */
function settingsWrites(code) {
  const found = [];
  for (const p of pathsOf(code, 'settings')) {
    const { members, before, after } = p;
    const op = ASSIGNS.filter((o) => after.startsWith(o)).sort((x, y) => y.length - x.length)[0];
    const last = members[members.length - 1];
    if (members.length && op && !after.startsWith('==') && !after.startsWith('=>')) found.push([p.index, 'assigns into settings']);
    else if (members.length && (after.startsWith('++') || after.startsWith('--') || before.endsWith('++') || before.endsWith('--'))) found.push([p.index, 'counts in settings']);
    else if (/\bdelete$/.test(before)) found.push([p.index, 'deletes from settings']);
    else if (WRITERS.test(before)) found.push([p.index, 'writes settings through Object or Reflect']);
    else if (handedAsThis(before)) found.push([p.index, 'hands settings to a function as its this, where what it writes cannot be read']);
    else if (members.length && called(p) && !SETTINGS_READS.includes(last)) found.push([p.index, 'calls ' + (last === '[]' ? 'a method named by an expression' : last) + ' on settings, which may write it (a read: ' + SETTINGS_READS.slice(0, 4).join(', ') + ', …)']);
    else if (takenUnderAnotherName(p) && !COUNTS.includes(last)) found.push([p.index, 'takes ' + (members.length ? 'a part of settings' : 'settings') + ' under another name, where its writes cannot be read']);
  }
  return found;
}
/**
 * (j) The takes module naming a room or a broadcast, joining its socket to a room, reaching the room store but through
 * its readers, or taking the store or the socket under another name; and any handler module asking a right of rbac
 * (`rbac.can(`, under any name rbac is bound to, or `can` taken from it) instead of its connection, naming `sendTo` but
 * to call it (so (f) reads each take's event), or writing into settings. Read as code: a word in a comment or a string
 * is not the code's. Sorted.
 */
function narrowProblems(sources) {
  const problems = new Set();
  for (const [file, src] of sources) {
    if (!HANDLER_MODULE.test(file)) continue;
    const { requires } = requireBindings(src);
    const code = blank(src);
    const at = (i, words) => problems.add(file + ':' + lineAt(src, i) + ': ' + words);
    if (file === 'lib/handlers/takes.js') {
      for (const [name, re] of TAKES_NEVER) for (const m of code.matchAll(re)) at(m.index, 'names ' + name + ': a take reaches a page by its socket\'s id alone (ctx.sendTo), never a room or a broadcast');
      for (const p of pathsOf(code, 'store')) {
        if (p.root && p.root !== 'ctx') continue;   // another object's member named store
        if (p.members.length) { if (p.members.length > 1 || !TAKES_STORE_READS.includes(p.members[0]) || !called(p)) at(p.index, 'reaches the room store other than through its readers (store.room(…), …): a take writes no room'); }
        else if (!takenFromCtx(p)) at(p.index, 'takes the room store under another name, or hands it on, where its writes cannot be read');
      }
      for (const p of pathsOf(code, 'socket')) {
        if ((!p.root || p.root === 'conn') && !p.members.length && takenUnderAnotherName(p)) at(p.index, 'takes the socket under another name, where its rooms and broadcasts cannot be read');
      }
      // What the takes context does not hold is not asked of it (io is named nowhere, above): it would be undefined.
      for (const name of gateLib.ROOM_SENDS.filter((n) => n !== 'io')) {
        for (const p of pathsOf(code, name)) if (p.root === 'ctx' || (inDestructuring(p) && closesOnCtx(p.after.replace(/^:\s*[\w$]+/, '').trimStart()))) {
          at(p.index, 'takes ' + name + ' from ctx, which the takes context does not hold: a take makes no room\'s op');
        }
      }
    }
    // A right is asked of the connection: of rbac under no name it is bound to, nor by its can taken out of it.
    for (const r of requires) {
      if (!/(^|\/)rbac(\.js)?$/.test(r.spec)) continue;
      if (r.takes && r.takes.includes('can')) at(r.at, 'takes can from rbac: its connection answers a right');
      for (const v of r.via) if (v.name === 'can') at(v.at, 'takes can from rbac: its connection answers a right');
      // (its can taken under another name, `const may = roles.can`, is said once, as taken, above)
      for (const n of r.whole) for (const p of pathsOf(code, n)) if (!p.root && ['can', '[]'].includes(p.members[0]) && !(p.members.length === 1 && takenUnderAnotherName(p))) at(p.index, 'asks a right of rbac: its connection answers it (conn.allowed, conn.mayPost, conn.canManageHall)');
      if (!r.takes && !r.whole.size && /^\s*(?:\??\.\s*can\b|\[)/.test(code.slice(r.end))) at(r.at, 'asks a right of rbac: its connection answers it (conn.allowed, conn.mayPost, conn.canManageHall)');
    }
    for (const m of code.matchAll(/\brbac\s*(?:\??\.\s*can\b|\[)/g)) at(m.index, 'asks a right of rbac: its connection answers it (conn.allowed, conn.mayPost, conn.canManageHall)');
    // A take's event is read where sendTo is called: it is named only to be called, or taken from ctx as itself.
    for (const p of pathsOf(code, 'sendTo')) if (!(called(p) && !p.members.length) && !takenFromCtx(p)) at(p.index, 'names sendTo other than to call it: (f) reads a take\'s event where sendTo is called');
    for (const [i, words] of settingsWrites(code)) at(i, words + ': a handler module reads settings and never writes them');
  }
  return [...problems].sort();
}

/**
 * The verbs server.js registers, read as the fuzz reads them (`socket.on('verb'`): the ones it held when the handler
 * modules came (plan 5-§14.2), a list that only shrinks. A new verb registers in a handler module (lib/handlers/),
 * behind its gate; one written here leaves this list when a unit rewrites it into a module.
 */
const SERVER_VERBS = [
  'actionResponse', 'admin:acceptCertificate', 'admin:createRoom', 'admin:deleteMessage', 'admin:deleteRoom', 'admin:invites', 'admin:kick',
  'admin:laptop', 'admin:linkRoom', 'admin:listRooms', 'admin:lockRoles', 'admin:postSummary', 'admin:renewCertificate', 'admin:resetRoom',
  'admin:setRole', 'admin:settings', 'admin:summary', 'admin:tunnelStart', 'admin:tunnelStatus', 'admin:tunnelStop', 'admin:tunnelUntil',
  'admin:unlinkRoom', 'admin:watchRoom', 'ai:draft', 'ai:options', 'board:watch', 'delete', 'disconnect', 'display:create',
  'display:hallHolding', 'display:identify', 'display:list', 'display:remove', 'display:rotate', 'display:shown', 'display:take',
  'display:update', 'forward', 'hall:acceptCertificate', 'hall:configure', 'hall:settings', 'help:respond', 'join', 'message', 'myRooms',
  'nodes:acceptCertificate', 'nodes:command', 'nodes:link', 'nodes:list', 'nodes:unlink', 'pin', 'react', 'seen', 'stage:propose',
  'stage:send', 'stage:targets', 'userState:push', 'userState:requestPeers',
];
/** A verb server.js registers that it did not hold (a new one: a handler module's), or a row it registers no more. Sorted. */
function serverVerbProblems(src, held = SERVER_VERBS) {
  const verbs = new Set([...src.matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1]));
  return [
    ...[...verbs].filter((v) => !held.includes(v)).map((v) => 'server.js registers ' + v + ': a new verb registers in a handler module (lib/handlers/), behind its gate'),
    ...held.filter((v) => !verbs.has(v)).map((v) => v + ' is no longer registered in server.js: its row in SERVER_VERBS goes'),
  ].sort();
}

test('(d), (i), (j) the handler modules: narrow requires, the context read once, one gate first in each verb, no room or broadcast from takes, no right asked of rbac, no settings written; and no new verb in server.js', () => {
  const sources = sourcesOf(serverCode());
  const has = (f) => sources.has(f) || onDisk(f);
  const modules = [...sources.keys()].filter((f) => HANDLER_MODULE.test(f)).sort();
  assert.deepEqual(modules, handlerFiles().slice(1), 'the fences read the handler files\' modules');
  assert.deepEqual(modules, ['lib/handlers/rooms.js', 'lib/handlers/takes.js']);
  assert.deepEqual(requireProblems(sources, { has }), []);
  assert.deepEqual(contextProblems(sources), []);
  assert.deepEqual(gateProblems(sources), []);
  assert.deepEqual(narrowProblems(sources), []);
  assert.deepEqual(serverVerbProblems(sources.get('server.js')), []);
  // What the rows allow is there: guard's helpers by those names, and the gate's options are the ones (i) reads.
  const guard = require('../lib/guard');
  for (const n of HANDLER_MAY['lib/guard.js'].names) assert.equal(typeof guard[n], 'function', 'guard.' + n);
  assert.deepEqual([...gateLib.OPTIONS], ['joined', 'bucket', 'admin', 'may']);
  // Each module is server.js's alone to require, and gives the connection one register(socket, conn, ctx).
  for (const m of [require('../lib/handlers/rooms'), require('../lib/handlers/takes')]) assert.deepEqual(Object.keys(m), ['register']);
});

test('(d), (i), (j) the contexts: conn made in the connection after each helper it holds, ctx and takesCtx built once and last from the parts alone, the modules registered on every page\'s socket but a screen\'s', () => {
  const server = read('server.js');
  // The connection's function, from its first line to the first line at the top level after it (its close, `});`).
  const at = server.indexOf("io.on('connection', (socket) => {");
  const end = server.indexOf('\n});\n', at);
  assert.ok(at > 0 && end > at, 'the connection is read');
  const inClosure = (i) => i > at && i < end;
  const once = (text) => { const i = server.indexOf(text); assert.ok(i > 0 && server.indexOf(text, i + 1) < 0, text + ' once'); return i; };
  // conn: frozen, its room and person read when asked, each helper it holds made before it in the connection.
  const made = once('const conn = Object.freeze(');
  assert.ok(inClosure(made), 'conn is made in the connection');
  const conn = groupAt(server, made + 'const conn = Object.freeze('.length);
  const keys = conn.entries.map(keyOf);
  assert.deepEqual(keys.map((k) => k.key), ['socket', 'room', 'me', 'ok', 'limited', 'writes', 'chatter', 'need', 'mayPost', 'allowed', 'admin', 'actor', 'canManageHall', 'gate']);
  assert.deepEqual(keys.filter((k) => k.value !== null).map((k) => [k.key, k.value]), [['room', '() => room'], ['me', '() => me']]);
  for (const { key } of keys.filter((k) => k.value === null && k.key !== 'socket')) {
    const decl = server.indexOf('  const ' + key + ' = ', at);
    assert.ok(inClosure(decl) && decl < made, key + ' is made in the connection before conn holds it');
  }
  // The buckets (i) accepts are the ones conn holds, each a bucket of the connection's own.
  for (const b of CONN_BUCKETS) assert.ok(keys.some((k) => k.key === b) && inClosure(server.indexOf('  const ' + b + ' = new guard.Bucket(', at)), b);
  // The three of today's helpers that are the gate's steps alone answer in its words, and limited in its bucket's.
  assert.ok(server.includes('const need = (ack) => gate(ack, { bucket: null });'));
  assert.ok(server.includes("const mayPost = (ack) => gate(ack, { joined: false, bucket: null, may: 'hall.post' });"));
  assert.ok(server.includes('const admin = (ack) => gate(ack, { joined: false, bucket: null, admin: true });'));
  assert.ok(server.includes('const limited = (ack) => { ok(ack)({ ok: false, error: GATE_WORDS.slow, busy: true }); };'));
  assert.ok(once("const { gateOf, contexts, WORDS: GATE_WORDS } = require('./lib/gate');"));
  // The modules, each registered once, after conn, on a socket that is not a screen's.
  const rooms = once('roomVerbs.register(socket, conn, ctx);');
  const takes = once('takeVerbs.register(socket, conn, takesCtx);');
  const screen = once('if (displayToken) { serveDisplay(socket, displayToken); return; }');
  assert.ok(inClosure(rooms) && inClosure(takes) && inClosure(screen) && screen < made && made < rooms && rooms < takes);
  assert.ok(once("const roomVerbs = require('./lib/handlers/rooms');") && once("const takeVerbs = require('./lib/handlers/takes');"));
  // ctx and takesCtx: built once, outside the connection, from the parts alone (the sockets sendTo reaches are read from
  // io by lib/gate.js, never handed in), after each part they name is declared, before the port is held.
  const built = once('const { ctx, takesCtx } = contexts(');
  const call = groupAt(server, built + 'const { ctx, takesCtx } = contexts('.length - 1);
  assert.equal(call.entries.length, 1, 'contexts() is given the parts and nothing else');
  const parts = groupAt(server, call.at[0]).entries.map(keyOf);
  assert.deepEqual(parts.map((k) => k.key), ['store', 'apply', 'systemMessage', 'buildMessage', 'removeUnused', 'fileNamesOf', 'audit', 'accounts', 'boardDirty', 'settings', 'linkFor', 'stagePayload', 'io']);
  assert.ok(parts.every((k) => k.value === null), 'each part by its own name');
  const declared = new Map();
  for (const m of server.matchAll(/^(?:const|let|var|class|function\*?|async function\*?)\s+([A-Za-z_$][\w$]*)/gm)) if (!declared.has(m[1])) declared.set(m[1], m.index);
  for (const { key } of parts) assert.ok(declared.has(key) && declared.get(key) < built, key + ' is declared at the top level before the contexts are built');
  assert.ok(built > end && built < server.indexOf('holdDataFolder(() => front.listen('), 'built after the connection is written and before this copy holds its port');
  // The io they are given is the server's own Socket.IO server, the one every page's socket connects to.
  assert.ok(once('const io = new Server(') < built);
});

test('(d) a planted handler module that requires past its row, or makes what it requires, fails it', () => {
  const tree = ['lib/board.js', 'lib/rbac.js', 'lib/guard.js', 'lib/ids.js', 'lib/store.js', 'lib/resilience.js', 'lib/pages.js'];
  const has = (f) => tree.includes(f);
  const pure = ['lib/board.js', 'lib/rbac.js'];
  const base = ["const rbac = require('../rbac');", "const { str, cleanText: clean } = require('../guard');", "const ids = require('../ids');", "const board = require('../board.js');", 'const seen = new Map(); const later = new Set();'].join('\n');
  const run = (f, line, p = pure) => requireProblems(new Map([[f, base + '\n' + line]]), { pure: p, has });
  const rooms = (line) => run('lib/handlers/rooms.js', line);
  assert.deepEqual(rooms(''), [], 'the planted module passes: the pure core, guard\'s helpers by name (one renamed), ids, and a Map of its own');
  assert.deepEqual(rooms("const fs = require('fs');"), ['lib/handlers/rooms.js:6: requires fs: a handler module requires no built-in and no package']);
  assert.deepEqual(rooms("const { spawn } = require('node:child_process');"), ['lib/handlers/rooms.js:6: requires node:child_process: a handler module requires no built-in and no package']);
  assert.deepEqual(rooms("const { Server } = require('socket.io');"), ['lib/handlers/rooms.js:6: requires socket.io: a handler module requires no built-in and no package']);
  assert.deepEqual(rooms("const { RoomStore } = require('../store');"), ['lib/handlers/rooms.js:6: requires lib/store.js: a store, a link or an edge reaches a handler module only through its context']);
  assert.deepEqual(rooms("const { writeFileAtomic } = require('../resilience');"), ['lib/handlers/rooms.js:6: requires lib/resilience.js: a store, a link or an edge reaches a handler module only through its context']);
  // guard by its pure helpers' names, never whole, and never what reads or makes the secret.
  assert.deepEqual(rooms("const guard = require('../guard');"), ['lib/handlers/rooms.js:6: takes lib/guard.js whole: it takes str, cleanText, mac, Bucket by name (const { … } = require(…))']);
  assert.deepEqual(rooms("const ok = require('../guard').str(x);"), ['lib/handlers/rooms.js:6: takes lib/guard.js whole: it takes str, cleanText, mac, Bucket by name (const { … } = require(…))']);
  assert.deepEqual(rooms("const { readSecret, mac } = require('../guard');"), ['lib/handlers/rooms.js:6: takes readSecret from lib/guard.js, which is not among its pure helpers (str, cleanText, mac, Bucket)']);
  assert.deepEqual(rooms("const { ...all } = require('../guard');"), ['lib/handlers/rooms.js:6: takes ... from lib/guard.js, which is not among its pure helpers (str, cleanText, mac, Bucket)']);
  // The one row: the takes module takes the pages' pure vocabulary by name; no other module requires the store.
  assert.deepEqual(run('lib/handlers/takes.js', "const { cleanPage, canShow } = require('../pages');"), []);
  assert.deepEqual(run('lib/handlers/takes.js', "const { PagesStore } = require('../pages');"), ['lib/handlers/takes.js:6: takes PagesStore from lib/pages.js, which is not among its pure helpers (cleanPage, describePage, canShow, cleanSnippet)']);
  assert.deepEqual(rooms("const { cleanPage } = require('../pages');"), ['lib/handlers/rooms.js:6: requires lib/pages.js: a store, a link or an edge reaches a handler module only through its context']);
  // Nothing it requires is made in it, however it is reached; a word in a comment or a string is not code.
  assert.deepEqual(rooms("const { Bucket } = require('../guard');\nconst b = new Bucket(5, 15);"), ['lib/handlers/rooms.js:7: makes what it requires (new Bucket): it is given the server\'s, through its context']);
  assert.deepEqual(rooms('const t = new ids.Thing();'), ['lib/handlers/rooms.js:6: makes what it requires (new ids): it is given the server\'s, through its context']);
  assert.deepEqual(rooms("const { Bucket } = require('../guard');\nconst B = Bucket;\nconst b = new (B)(1, 2);"), ['lib/handlers/rooms.js:8: makes what it requires (new B): it is given the server\'s, through its context']);
  assert.deepEqual(rooms("const x = new (require('../board').Board)();"), ['lib/handlers/rooms.js:6: makes what it requires (new require): it is given the server\'s, through its context']);
  assert.deepEqual(rooms("// new board.Thing() is never made here\nconst words = 'new board.Thing()';"), []);
  // Nothing is reached without a literal require: an import at run time, require by a path not written out or handed on,
  // the process, the module's loader, the global object. Its own exports, and a word in a comment or a string, pass.
  for (const [line, words] of [
    ["const fs = await import('node:fs');", 'imports at run time: a handler module requires by a literal path'],
    ['const fs = require(name);', 'names require other than to require a literal path'],
    ["const load = require; load('fs');", 'names require other than to require a literal path'],
    ["const fs = require.call(null, 'fs');", 'names require other than to require a literal path'],
    ["const fs = process.binding('fs');", 'names process: the server hands a handler module what it reads of the machine'],
    ['const { env } = process;', 'names process: the server hands a handler module what it reads of the machine'],
    ["const fs = module.constructor._load('fs');", 'names module other than for its exports'],
    ["const p = globalThis.process;", 'names the global object, where what it requires cannot be read'],
  ]) assert.deepEqual(rooms(line), ['lib/handlers/rooms.js:6: ' + words], line);
  assert.deepEqual(rooms("module.exports = { register };\n// import('fs'), process.binding, require(x)\nconst words = 'process.env and import(x)';\nconst x = args.process;"), []);
  // The pure core is the pure set the fence is given: a file outside it is a store or an edge.
  assert.deepEqual(run('lib/handlers/rooms.js', '', ['lib/rbac.js']), ['lib/handlers/rooms.js:4: requires lib/board.js: a store, a link or an edge reaches a handler module only through its context']);
  // A file that is not a module directly in lib/handlers/ is not read as one.
  assert.deepEqual(requireProblems(new Map([['lib/handlers/parts/x.js', "require('fs');"], ['lib/store.js', "require('fs');"]]), { pure, has }), []);
});

test('(d) a planted handler module that reads its context anywhere but once, destructured as register\'s first statement, fails it', () => {
  const run = (body, head = 'function register(socket, conn, ctx) {') => contextProblems(new Map([['lib/handlers/rooms.js', ['\'use strict\';', head, ...body, '}', 'module.exports = { register };'].join('\n')]]));
  const VERB = "  socket.on('a', (args, ack) => { if (!conn.gate(ack, { bucket: conn.writes })) return; store.room(conn.room().code); });";
  const read = 'reads ctx other than once, destructured as register\'s first statement (const { … } = ctx;, no rest): that line is the module\'s list of what it reaches';
  assert.deepEqual(run(['  const { store, audit: log } = ctx;', VERB]), [], 'the module\'s list of what it reaches, its first statement');
  assert.deepEqual(run(['  // what it reaches of the server, read once', '  const {', '    store,', '    audit,', '  } = ctx;', VERB]), [], 'over lines, a comment before it');
  assert.deepEqual(run(['  // no verb reads the server yet: ctx is named only as register\'s']), []);
  assert.deepEqual(run([VERB.replace('store.room', 'ctx.store.room')]), ['lib/handlers/rooms.js:3: ' + read]);
  assert.deepEqual(run(['  const x = 1;', '  const { store } = ctx;', VERB]), ['lib/handlers/rooms.js:4: ' + read], 'not its first statement');
  assert.deepEqual(run(['  const { store } = ctx;', '  const { audit } = ctx;', VERB]), ['lib/handlers/rooms.js:4: ' + read], 'read twice');
  assert.deepEqual(run(['  const { store } = ctx;', VERB.replace('store.room(', 'ctx.store.room(')]), ['lib/handlers/rooms.js:4: ' + read], 'read again in a verb');
  assert.deepEqual(run(['  const { ...all } = ctx;', VERB]), ['lib/handlers/rooms.js:3: ' + read], 'a rest takes it whole');
  assert.deepEqual(run(['  const parts = ctx;', VERB]), ['lib/handlers/rooms.js:3: ' + read]);
  assert.deepEqual(run(['  const { store } = ctx;'], 'function register(socket, conn, context) {'), ['lib/handlers/rooms.js: gives no function register(socket, conn, ctx)']);
  assert.deepEqual(run([], 'function wire(socket, conn, ctx) {'), ['lib/handlers/rooms.js: gives no function register(socket, conn, ctx)']);
});

test('server.js registers no new verb: a planted one fails it, and a verb gone from it takes its row with it', () => {
  const src = "socket.on('join', (a, ack) => {});\nsocket.on('message', (a, ack) => {});";
  assert.deepEqual(serverVerbProblems(src, ['join', 'message']), []);
  assert.deepEqual(serverVerbProblems(src + "\nsocket.on('room:create', (a, ack) => {});", ['join', 'message']), ['server.js registers room:create: a new verb registers in a handler module (lib/handlers/), behind its gate']);
  assert.deepEqual(serverVerbProblems(src, ['join', 'message', 'pin']), ['pin is no longer registered in server.js: its row in SERVER_VERBS goes']);
  assert.deepEqual([...SERVER_VERBS].sort(), SERVER_VERBS, 'the list is sorted, once each');
  assert.equal(new Set(SERVER_VERBS).size, SERVER_VERBS.length);
});

test('(i) a planted verb that does not pass its one gate first, or does not name its bucket, fails it', () => {
  const verb = (name, first, rest = '      ack({ ok: true });') => ['    socket.on(\'' + name + '\', (args, ack) => {', '      ' + first, rest, '    });'].join('\n');
  const GATED = 'if (!conn.gate(ack, { bucket: conn.writes, may: \'hall.post\' })) return;';
  const READ = 'if (!conn.gate(ack, { joined: true, bucket: null })) return;   // a read of its own room, from memory';
  const mod = (...verbs) => ['function register(socket, conn, ctx) {', ...verbs, '}'].join('\n');
  const run = (src, f = 'lib/handlers/rooms.js') => gateProblems(new Map([[f, src]]));
  assert.deepEqual(run(mod(verb('room:create', GATED), verb('history:before', READ))), [], 'the planted module passes');
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(ack, { bucket: null })) return;', '      // the join answered this page already, so it spends nothing\n      ack({ ok: true });'))), ['lib/handlers/rooms.js:2: \'a\' says bucket: null without why: a comment on its line, or the line before']);
  assert.deepEqual(run(mod(verb('a', '// the join answered this page already, so it spends nothing\n      if (!conn.gate(ack, { bucket: null })) return;'))), [], 'a reason on the line before');
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(ack, {\n        joined: false,\n        bucket: null,   // read from the admin page, from no room\n        admin: true,\n      })) return;'))), [], 'options over lines, the reason on the bucket\'s');
  // Each listener is held: an async one, a function expression, and destructured arguments with defaults.
  assert.deepEqual(run(mod("    socket.on('a', async ({ id } = {}, ack) => {\n      " + GATED + '\n    });', "    socket.on('b', function (args, ack) {\n      /* first, always */ " + GATED + '\n    });')), []);

  // No gate, a gate not first, a gate twice, a gate outside a verb.
  assert.deepEqual(run(mod(verb('room:create', 'ack({ ok: true });', ''), verb('history:before', READ))), ['lib/handlers/rooms.js: 1 gate calls for 2 verbs: each verb passes one, first, and none stands outside a verb', 'lib/handlers/rooms.js:2: \'room:create\' does not start with its gate: if (!conn.gate(ack, { bucket: … })) return;']);
  assert.deepEqual(run(mod(verb('a', 'const id = guard.str(args.id);', '      ' + GATED))), ['lib/handlers/rooms.js:2: \'a\' does not start with its gate: if (!conn.gate(ack, { bucket: … })) return;']);
  assert.deepEqual(run(mod(verb('a', GATED, '      ' + GATED))), ['lib/handlers/rooms.js: 2 gate calls for 1 verbs: each verb passes one, first, and none stands outside a verb', 'lib/handlers/rooms.js:2: \'a\' passes the gate 2 times: once, first']);
  assert.deepEqual(run(mod('    conn.gate(null, { bucket: null });   // asked of nobody', verb('a', GATED))), ['lib/handlers/rooms.js: 2 gate calls for 1 verbs: each verb passes one, first, and none stands outside a verb']);
  assert.deepEqual(run(mod(verb('a', 'const { gate } = conn;', '      if (!gate(ack, { bucket: conn.writes })) return;'))), ['lib/handlers/rooms.js: 0 gate calls for 1 verbs: each verb passes one, first, and none stands outside a verb', 'lib/handlers/rooms.js:2: \'a\' does not start with its gate: if (!conn.gate(ack, { bucket: … })) return;']);
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(ack, { bucket: conn.writes })) ack({ ok: false });'))), ['lib/handlers/rooms.js:2: \'a\' does not return when its gate refuses: if (!conn.gate(ack, { bucket: … })) return;']);
  assert.deepEqual(run(mod("    socket.on('a', onCreate);\n    function onCreate(args, ack) { " + GATED + ' }')), ['lib/handlers/rooms.js:2: \'a\' is not a listener written in place with a block body: its gate cannot be read']);
  assert.deepEqual(run(mod("    socket.on('a', (args, ack) => conn.gate(ack, { bucket: conn.writes }) && ack({ ok: true }));")), ['lib/handlers/rooms.js:2: \'a\' is not a listener written in place with a block body: its gate cannot be read']);
  // A gate in a comment or a string is none.
  assert.deepEqual(run(mod(verb('a', "// if (!conn.gate(ack, { bucket: conn.writes })) return;\n      const why = 'conn.gate(ack, x)';", ''))), ['lib/handlers/rooms.js: 0 gate calls for 1 verbs: each verb passes one, first, and none stands outside a verb', 'lib/handlers/rooms.js:2: \'a\' does not start with its gate: if (!conn.gate(ack, { bucket: … })) return;']);

  // Its refusal answers the sender: the gate is handed the listener's own acknowledgement, its last argument by name.
  const notAck = (given, ack = 'ack') => 'lib/handlers/rooms.js:2: \'a\' gives its gate ' + given + ' to answer, not its acknowledgement: if (!conn.gate(' + ack + ', { bucket: … })) return;';
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(null, { bucket: conn.writes })) return;'))), [notAck('null')]);
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(args, { bucket: conn.writes })) return;'))), [notAck('args')]);
  assert.deepEqual(run(mod(verb('a', 'if (!conn.gate(() => {}, { bucket: conn.writes })) return;'))), [notAck('() => {}')]);
  assert.deepEqual(run(mod("    socket.on('a', (args, reply) => {\n      if (!conn.gate(ack, { bucket: conn.writes })) return;\n    });")), [notAck('ack', 'reply')]);
  assert.deepEqual(run(mod("    socket.on('a', (args, reply) => {\n      if (!conn.gate(reply, { bucket: conn.writes })) return;\n    });")), [], 'its acknowledgement under the name it is given');
  assert.deepEqual(run(mod("    socket.on('a', async ack => {\n      if (!conn.gate(ack, { bucket: conn.writes })) return;\n    });")), [], 'a verb with no arguments but its acknowledgement');
  assert.deepEqual(run(mod("    socket.on('a', ({ id }, { ok } = {}) => {\n      if (!conn.gate(ok, { bucket: conn.writes })) return;\n    });")), ['lib/handlers/rooms.js:2: \'a\' takes no acknowledgement its gate could answer: its last argument is the ack, by name (args, ack)']);
  assert.deepEqual(run(mod("    socket.on('a', () => {\n      if (!conn.gate(ack, { bucket: conn.writes })) return;\n    });")), ['lib/handlers/rooms.js:2: \'a\' takes no acknowledgement its gate could answer: its last argument is the ack, by name (args, ack)']);
  // Socket.IO's own events are no verbs: no page sends them and they carry no acknowledgement, so they pass no gate,
  // and a gate in one stands outside a verb.
  const LEFT = "    socket.on('disconnect', (reason) => {\n      forget(conn.socket.id);\n    });";
  assert.deepEqual(run(mod(verb('a', GATED), LEFT)), [], 'a page that left, forgotten');
  assert.deepEqual(run(mod(verb('a', GATED), LEFT.replace('forget(', 'if (!conn.gate(reason, { bucket: null })) return;   // never asked\n      forget('))), ['lib/handlers/rooms.js: 2 gate calls for 1 verbs: each verb passes one, first, and none stands outside a verb']);

  // Its options: written out, the gate's own, its bucket one of the connection's.
  const gated = (opts, before = '') => run(mod(before, verb('a', 'if (!conn.gate(ack, ' + opts + ')) return;')).replace('{\n\n', '{\n'));
  const notConns = (value) => ['lib/handlers/rooms.js:2: \'a\' gives its gate a bucket that is not the connection\'s: bucket: ' + value + ' (conn.writes, conn.chatter, or one taken from conn by its name)'];
  assert.deepEqual(gated("{ may: 'hall.post' }"), ['lib/handlers/rooms.js:2: \'a\' names no bucket: bucket: conn.writes, or bucket: null with why']);
  assert.deepEqual(gated('{ bucket }'), ['lib/handlers/rooms.js:2: \'a\' names no bucket: bucket: conn.writes, or bucket: null with why']);
  assert.deepEqual(gated('{ bucket: undefined }'), notConns('undefined'));
  assert.deepEqual(gated('{ bucket: pick(conn) }'), notConns('pick(conn)'));
  assert.deepEqual(gated('{ bucket: free }'), notConns('free'), 'a bucket of the module\'s own, however it takes');
  assert.deepEqual(gated('{ bucket: conn.uploads }'), notConns('conn.uploads'));
  assert.deepEqual(gated('{ bucket: chatter }'), notConns('chatter'), 'a name not taken from conn');
  assert.deepEqual(gated('{ bucket: conn . chatter }'), [], 'conn.chatter, however it is spaced');
  const takes = (line) => run(mod('  ' + line, verb('a', 'if (!conn.gate(ack, { bucket: chatter })) return;')));
  assert.deepEqual(takes('const { chatter, gate } = conn;'), [], 'a bucket the module took from conn by its name');
  assert.deepEqual(takes('const { writes: chatter } = conn;').map((p) => p.replace(':3:', ':2:')), notConns('chatter'), 'a bucket renamed is not read as the one its name says');
  assert.deepEqual(takes('const { chatter } = other;').map((p) => p.replace(':3:', ':2:')), notConns('chatter'));
  assert.deepEqual(gated('{ bucket: conn.writes, addmin: true }'), ['lib/handlers/rooms.js:2: \'a\' gives its gate an option it does not take: addmin']);
  assert.deepEqual(gated('{ ...WRITE, admin: true }'), ['lib/handlers/rooms.js:2: \'a\' gives its gate a spread (...WRITE)']);
  assert.deepEqual(gated('WRITE'), ['lib/handlers/rooms.js:2: \'a\' gives its gate options it does not write out: (ack, { bucket: … })']);
  assert.deepEqual(gated('{ bucket: conn.writes }, extra'), ['lib/handlers/rooms.js:2: \'a\' gives its gate options it does not write out: (ack, { bucket: … })']);
  // Only a module directly in lib/handlers/ is read as one.
  assert.deepEqual(run(mod(verb('a', 'ack({});')), 'server.js'), []);
});

test('(j) a planted take that names a room or a broadcast, a right asked of rbac and a write into settings each fail it', () => {
  const run = (f, line) => narrowProblems(new Map([[f, "const rbac = require('../rbac');\nfunction register(socket, conn, ctx) {\n" + line + '\n}']]));
  const takes = (line) => run('lib/handlers/takes.js', line);
  const ROOMS = 'lib/handlers/rooms.js';
  const never = 'a take reaches a page by its socket\'s id alone (ctx.sendTo), never a room or a broadcast';
  assert.deepEqual(takes("const { sendTo, settings } = ctx;\nsendTo([id], 'clock', { show: settings.clock });"), [], 'a take sent to a socket by its id, settings read');
  assert.deepEqual(takes("ctx.io.to(code).emit('page:push', x);"), ['lib/handlers/takes.js:3: names .to(: ' + never, 'lib/handlers/takes.js:3: names io: ' + never]);
  for (const [line, name] of [
    ["conn.socket.broadcast.emit('x', 1);", '.broadcast'], ["socket.in(code).emit('x', 1);", '.in('], ['const all = conn.socket.nsp;', '.nsp'],
    ['const s = socket.server;', '.server'], ["socket.except(code).emit('x', 1);", '.except('], ["socket['to'](code);", 'a member named by a string'],
    ['const { io } = ctx;', 'io'],
  ]) assert.deepEqual(takes(line), ['lib/handlers/takes.js:3: names ' + name + ': ' + never], line);
  assert.deepEqual(takes("// never io.to(code), never socket.broadcast\nconst words = 'io.to(';"), [], 'a comment and a string are not code');
  // eslint-disable-next-line no-template-curly-in-string -- the planted source holds a template's ${…} on purpose
  assert.deepEqual(takes('const words = `io.to( ${ctx.io.name}`;'), ['lib/handlers/takes.js:3: names io: ' + never], 'a template\'s words are not code, and its ${…} is');
  assert.deepEqual(run(ROOMS, "ctx.io.to(room.code).emit('roomMeta', { name });"), [], 'the rooms module broadcasts to a room');
  // A right is asked of the connection, never of rbac, in any module.
  const right = 'asks a right of rbac: its connection answers it (conn.allowed, conn.mayPost, conn.canManageHall)';
  assert.deepEqual(run(ROOMS, "if (!rbac.can(account, 'hall.post')) return;"), ['lib/handlers/rooms.js:3: ' + right]);
  assert.deepEqual(run(ROOMS, "if (!rbac['can'](account, 'hall.post')) return;"), ['lib/handlers/rooms.js:3: ' + right]);
  assert.deepEqual(narrowProblems(new Map([[ROOMS, "const { can, seesHall } = require('../rbac');"]])), ['lib/handlers/rooms.js:1: takes can from rbac: its connection answers a right']);
  assert.deepEqual(run(ROOMS, "const named = rbac.ROLES[role].label;\nif (!conn.allowed('hall.post')) return;"), [], 'rbac\'s words read, the right asked of the connection');
  // Settings are read, never written, however the write is spelt.
  const reads = 'a handler module reads settings and never writes them';
  for (const [line, words] of [
    ['settings.roomSends = [];', 'assigns into settings'], ['ctx.settings.roomSends = list;', 'assigns into settings'], ["settings['a'] = 1;", 'assigns into settings'],
    ['settings.n += 1;', 'assigns into settings'], ['settings.list ??= [];', 'assigns into settings'], ['settings.n++;', 'counts in settings'], ['--ctx.settings.n;', 'counts in settings'],
    ['delete settings.roomSends;', 'deletes from settings'], ['Object.assign(settings, patch);', 'writes settings through Object or Reflect'],
    ["Reflect.set(ctx.settings, 'x', 1);", 'writes settings through Object or Reflect'], ['const { settings: s } = ctx;', 'takes settings under another name, where its writes cannot be read'],
    ['const s = ctx.settings;', 'takes settings under another name, where its writes cannot be read'],
  ]) assert.deepEqual(run(ROOMS, line), ['lib/handlers/rooms.js:3: ' + words + ': ' + reads], line);
  assert.deepEqual(run(ROOMS, "const { settings } = ctx;\nif (settings.x === 1 || settings.y !== 2 || settings.n <= 3 || settings.m >= 4) go(settings.roomSends.length);\nconst sends = settings.roomSends.slice();\n// settings.roomSends = []"), [], 'settings read, compared and copied');
  // A write through a method, a method named by an expression, a hand-off as `this`, and a part taken under another name.
  for (const [line, words] of [
    ['settings.roomSends.push(code);', 'calls push on settings, which may write it (a read: at, concat, entries, every, …)'],
    ['settings.roomSends.splice(0);', 'calls splice on settings, which may write it (a read: at, concat, entries, every, …)'],
    ['ctx.settings.roomSends?.sort();', 'calls sort on settings, which may write it (a read: at, concat, entries, every, …)'],
    ['settings.seen.set(code, 1);', 'calls set on settings, which may write it (a read: at, concat, entries, every, …)'],
    ['settings.reset();', 'calls reset on settings, which may write it (a read: at, concat, entries, every, …)'],
    ["settings.roomSends['push'](code);", 'calls a method named by an expression on settings, which may write it (a read: at, concat, entries, every, …)'],
    ['Array.prototype.push.call(settings.roomSends, code);', 'hands settings to a function as its this, where what it writes cannot be read'],
    ['[].push.apply(settings.roomSends, codes);', 'hands settings to a function as its this, where what it writes cannot be read'],
    ['const sends = settings.roomSends;', 'takes a part of settings under another name, where its writes cannot be read'],
    ['let sends; sends = ctx.settings.roomSends;', 'takes a part of settings under another name, where its writes cannot be read'],
    ['const { roomSends } = settings;', 'takes settings under another name, where its writes cannot be read'],
  ]) assert.deepEqual(run(ROOMS, line), ['lib/handlers/rooms.js:3: ' + words + ': ' + reads], line);
  assert.deepEqual(run(ROOMS, "const n = settings.roomSends.length;\nif (settings.roomSends.includes(code) && settings.roomSends.some(ok)) go(settings.roomSends.map(nameOf).join(', '), settings.seen.get(code));"), [], 'settings read through its reads, and a count taken');

  // A take reads the room store through its readers and never under another name; it joins its socket to no room; it
  // asks nothing of ctx that the takes context does not hold.
  const store = 'reaches the room store other than through its readers (store.room(…), …): a take writes no room';
  assert.deepEqual(takes("const { store, audit: log } = ctx;\nconst seated = [...store.room(code).users.keys()];\nif (!store.hasRoom(code) || !store.isMain(store.get(code))) return;\nconst x = other.store.commit(1);"), [], 'the store read through its readers; another object\'s store is not it');
  for (const [line, words] of [
    ['store.commit(conn.room(), op);', store], ['ctx.store.commit(conn.room(), op);', store], ['store.remove(code);', store], ['store.rooms.get(code);', store],
    ['const reader = store.room;', store], ['store.room = null;', store],
    ['const s = ctx.store;', 'takes the room store under another name, or hands it on, where its writes cannot be read'],
    ['const { store: rooms } = ctx;', 'takes the room store under another name, or hands it on, where its writes cannot be read'],
    ['helper(store);', 'takes the room store under another name, or hands it on, where its writes cannot be read'],
    ["conn.socket.join('ABC234');", 'names socket.join(: ' + never], ['socket.leave(code);', 'names socket.leave(: ' + never],
    ['const s = conn.socket;', 'takes the socket under another name, where its rooms and broadcasts cannot be read'],
    ['const { socket: s } = conn;', 'takes the socket under another name, where its rooms and broadcasts cannot be read'],
    ['const { apply } = ctx;', 'takes apply from ctx, which the takes context does not hold: a take makes no room\'s op'],
    ['const { audit, systemMessage: say } = ctx;', 'takes systemMessage from ctx, which the takes context does not hold: a take makes no room\'s op'],
    ["ctx.systemMessage(conn.room(), 'x');", 'takes systemMessage from ctx, which the takes context does not hold: a take makes no room\'s op'],
  ]) assert.deepEqual(takes(line), ['lib/handlers/takes.js:3: ' + words], line);
  assert.deepEqual(run(ROOMS, "const { store, apply, systemMessage } = ctx;\nstore.commit(room, op);\nconst r = conn.socket;"), [], 'the rooms module is given the room\'s op');
  // The review's plant: a take that makes a system line, an op and a commit, and joins another hall's room.
  assert.deepEqual(takes("const { apply, systemMessage, store } = ctx;\nsystemMessage(conn.room(), 'x'); apply(conn.room(), { o: 'add', m: {} }); store.commit(conn.room(), {}); conn.socket.join('ABC234');"), [
    'lib/handlers/takes.js:3: takes apply from ctx, which the takes context does not hold: a take makes no room\'s op',
    'lib/handlers/takes.js:3: takes systemMessage from ctx, which the takes context does not hold: a take makes no room\'s op',
    'lib/handlers/takes.js:4: names socket.join(: ' + never,
    'lib/handlers/takes.js:4: ' + store,
  ]);

  // rbac asked under any name it is bound to, or its can taken out of it however.
  const mod = (lines) => narrowProblems(new Map([[ROOMS, lines.join('\n')]]));
  assert.deepEqual(mod(["const roles = require('../rbac');", "if (!roles.can(account, 'hall.post')) return;"]), ['lib/handlers/rooms.js:2: ' + right]);
  assert.deepEqual(mod(["const roles = require('../rbac');", 'const r = roles;', "if (!r?.can(account, 'hall.post')) return;"]), ['lib/handlers/rooms.js:3: ' + right]);
  assert.deepEqual(mod(["const roles = require('../rbac');", 'const { can: may } = roles;']), ['lib/handlers/rooms.js:2: takes can from rbac: its connection answers a right']);
  assert.deepEqual(mod(["const roles = require('../rbac.js');", 'const may = roles.can;']), ['lib/handlers/rooms.js:2: takes can from rbac: its connection answers a right']);
  assert.deepEqual(mod(["if (!require('../rbac').can(account, 'hall.post')) return;"]), ['lib/handlers/rooms.js:1: ' + right]);
  assert.deepEqual(mod(["const roles = require('../rbac');", 'const label = roles.ROLES[role].label;', 'const { seesHall } = roles;']), [], 'rbac\'s words and its other questions read');

  // sendTo is named only to be called (so (f) reads each take's event), or taken from ctx as itself.
  const send = 'names sendTo other than to call it: (f) reads a take\'s event where sendTo is called';
  assert.deepEqual(takes("const { sendTo, settings } = ctx;\nsendTo([id], 'clock', {});\nctx.sendTo([id], 'clock', {});"), []);
  for (const line of ['const { sendTo: send } = ctx;', 'const send = ctx.sendTo;', "sendTo.call(null, [id], 'clock', {});", 'later(sendTo);']) assert.deepEqual(takes(line), ['lib/handlers/takes.js:3: ' + send], line);
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
/**
 * A server emit that no page hears, with why. The fence fails on a row a page hears, or that no handler file sends. None
 * today: every emit is heard (the hall page hears linkedRoomsChanged, which keeps its `forwardable` fact live).
 */
const UNHEARD = {};

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
    // A take sent to people's pages by their sockets' ids (lib/gate.js `sendTo(socketIds, event, payload)`): its event is
    // the call's second argument, read as code (a mention in a comment is none). (j) holds sendTo to being named only to
    // be called, so no take is sent under another name.
    const code = blank(src, { strings: false });
    for (const m of code.matchAll(/\bsendTo\s*\(/g)) {
      const call = groupAt(code, m.index + m[0].length - 1);
      const ev = call && call.entries[1];
      const lit = ev ? /^(['"])([^'"]+)\1$/.exec(ev) : null;
      if (!ev) unread.push(file + ' sends to pages by their ids in a form the fence does not read: ' + code.slice(m.index, m.index + 60).split('\n')[0]);
      else if (lit) note(emits, lit[2], file);
      else note(computed, ev, file);
    }
  }
  for (const [file, src] of pages) {
    for (const v of literal(/socket\.emit\(\s*(['"])([^'"]+)\1/g, src)) note(sends, v, file);
    for (const v of literal(/AGM\.outbox\.(?:hold|now|self)\(\s*(['"])([^'"]+)\1/g, src)) note(sends, v, file);
    // A catalogue row's verb is a socket verb its runner sends; 'local' sends nothing, and an HTTP route is not a socket's.
    if (file === 'public/catalog.js') for (const v of literal(/\bverb:\s*(['"])([^'"]+)\1/g, src)) if (v !== 'local' && !v.startsWith('http:')) note(sends, v, file);
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
  assert.equal(w.hears.get('linkedRoomsChanged'), 'public/app.js', 'the hall page hears linkedRoomsChanged: its forwardable fact is kept live');
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
  // A planted allow-list row: an emit no page of the planted tree hears, with its reason.
  const unheard = { linkedRoomsChanged: 'told to a guest\'s pages when the admin links them to another hall; no planted page hears it' };
  const run = ({ handlers = {}, pages = {} } = {}, opts = {}) => wireProblems(new Map(Object.entries({ ...base.handlers, ...handlers })), new Map(Object.entries({ ...base.pages, ...pages })), { named, pageNamed: {}, unheard, ...opts });
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
  assert.deepEqual(run({ ...roomCreate, pages: { 'public/halls.js': "AGM.outbox.hold('room:create', {}); AGM.outbox.hold('room:send', {});", 'public/catalog.js': "{ id: 'msg.copy', verb: 'local' }, { id: 'account.edit', verb: 'http:PATCH /api/users/:id' }" } }), [], 'a local act and an HTTP route are no socket sends');
  assert.deepEqual(run({ ...roomCreate, pages: { 'public/halls.js': "AGM.outbox.now('room:create', {}); const row = { verb: 'room:send' };" } }), ["lib/handlers/rooms.js registers 'room:send', which no page sends"]);

  // A take sent to pages by their ids is an event the server sends: heard by a page, or open; named by an expression, unread.
  const take = (line) => ({ handlers: { 'lib/handlers/takes.js': "socket.on('join', f);\n" + line } });
  assert.deepEqual(run(take("ctx.sendTo([s.id], 'roomMeta', { name }); // sendTo(ids, ev, x) in a comment is none")), []);
  assert.deepEqual(run(take("const n = sendTo(ids, 'clock', { show: 'off' });")), ["lib/handlers/takes.js sends 'clock', which no page hears"]);
  assert.deepEqual(run(take('sendTo(ids, ev, payload);')), ['lib/handlers/takes.js sends an event named by `ev`, which the fence cannot read']);
  assert.deepEqual(run(take('sendTo(ids);')), ['lib/handlers/takes.js sends to pages by their ids in a form the fence does not read: sendTo(ids);']);
  assert.deepEqual(run({ ...take("sendTo([id], 'clock', {});"), ...plus('pages', 'public/app.js', "socket.on('clock', f);") }), [], 'heard by the hall page');

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

// ---------------------------------------------------------------- (l) the any-room readers
/**
 * Every call in a shipped server file to the store's any-room readers (lib/store.js: `store.room`, `hasRoom`, `allRooms`
 * and `roomsOf`), counted per file, each with why it reads any room — a hall's Main room or a side room — and not a hall
 * (`store.get`, `has`, `rooms`). A reader of a hall never sees a side room, so a reader missed fails closed ("Room not
 * found"); one moved reaches side rooms, so each says why it may. A new any-room reader moves this list, with its words.
 * No file but the store reaches its side rooms by another way (`store.side`, `store.sideByHall`).
 */
const ANY_ROOM = {
  'server.js': [
    'a stop\'s halls left unwritten: a side room left unwritten counts as its hall',
    'a people list and seen receipts are a room\'s, Main or side (a screens frame names a hall, its Main room)',
    'the power request: a hall is live with a page seated in any of its rooms, a side room alone included',
    'the busy line: a message any room holds from the window, keyed by the room its page is in',
    'a locked room\'s saved seats follow its seats while it is still here, Main or side',
    'the boot\'s saved seats nobody took up are let go in every room',
    'a file any room holds is in use: a hall\'s reset or deletion never removes one a side room still holds',
    'the admin\'s transcript of any room',
    'health\'s sideRooms: every room but the halls',
    'a new hall\'s key is no room\'s, side rooms included',
    '"This laptop"\'s Pages row names the room a hall page on another build is in, a side room by its hall\'s name and its own',
    'an account and the admin\'s support view join a room by its key (a guest\'s code names a hall)',
    'a page\'s room is still here, Main or side',
    'the forward picker: the rooms this person sits in or is linked to that are still here',
    'and this person\'s rights in each',
    'and each named by its name',
    'a forward\'s target room, where the person\'s seat or the admin\'s link takes it',
    'a send to the speaker\'s screen is written into the room it came from only while that room is still kept',
    'and a proposal to the show desk likewise',
    'an admin\'s link names its room by its name',
    'the admin\'s watch of any room',
    'the admin\'s reset of any room',
    'the admin\'s removal of any room',
    'and a hall removed goes with every room it holds',
    'the admin\'s removal of a message in any room',
    'the admin\'s change of a seat in any room',
    'the admin\'s lock of any room\'s seats',
    'the admin\'s link of a person into any room',
    'and the room that person is in',
    'the admin\'s unlink, in the room that person is in',
    'the admin sends a person out of the room they are in',
    'the admin\'s AI summary of any room',
    'and the minutes posted in it',
    'a page gone past the grace is said to have left a room that is still here',
    'and a locked room it left keeps its seats',
    'a hall that follows another Stagewatch tells every room it holds',
    'a Stagewatch\'s frame reaches every room of each hall that follows it',
    'after a stop that did not save, every room says AGMessage restarted',
  ],
};
/** A call to one of the store's any-room readers, however it is spaced. */
const ANY_ROOM_CALL = /\bstore\s*\.\s*(?:room|hasRoom|allRooms|roomsOf)\s*\(/g;
/** The store's side rooms reached past its readers: by key (`side`) or by hall (`sideByHall`). */
const SIDE_REACHED = /\bstore\s*\.\s*side(?:ByHall)?\b/;
/** The any-room calls in `sources` (file → source) that the rows do not account for, and rows of no file. Sorted. */
function anyRoomProblems(sources, rows = ANY_ROOM) {
  const problems = [];
  for (const [file, src] of sources) {
    const calls = (src.match(ANY_ROOM_CALL) || []).length;
    const why = Object.hasOwn(rows, file) ? rows[file] : [];
    if (calls !== why.length) problems.push(file + ': ' + calls + ' calls to the any-room readers, ' + why.length + ' with a reason: each reads a side room too, and says why');
    if (SIDE_REACHED.test(src)) problems.push(file + ' reaches the store\'s side rooms past its readers (store.side, store.sideByHall)');
  }
  for (const file of Object.keys(rows)) if (!sources.has(file)) problems.push(file + ' is not in the tree: its row goes');
  return problems.sort();
}

test('(l) the any-room readers: each call that reads a side room too is counted per file, with its reason', () => {
  const sources = sourcesOf(serverCode());
  assert.ok(sources.has('server.js') && sources.has('lib/store.js') && sources.has('lib/board.js'));
  assert.deepEqual(anyRoomProblems(sources), []);
  // §3.5's readers among them: the transcript, the forward, uploads in use, the boot's seats, the restart line and the stage.
  for (const reader of ['admin\'s transcript', 'forward\'s target', 'a file any room holds', 'boot\'s saved seats', 'every room says AGMessage restarted', 'tells every room it holds']) {
    assert.ok(ANY_ROOM['server.js'].some((w) => w.includes(reader)), reader);
  }
});

test('(l) a planted any-room call without its reason, a row without its call, and the side rooms reached past the store, each fail it', () => {
  const base = { 'server.js': 'const r = store.room(key);\nfor (const x of store.allRooms()) n++;', 'lib/board.js': 'const h = store.get(code);' };
  const rows = { 'server.js': ['a room by its key', 'every room'] };
  const run = (edit = {}, r = rows) => anyRoomProblems(new Map(Object.entries({ ...base, ...edit })), r);
  assert.deepEqual(run(), [], 'the planted tree passes');
  assert.deepEqual(run({ 'server.js': base['server.js'] + '\nif (store . hasRoom (k)) go();' }), ['server.js: 3 calls to the any-room readers, 2 with a reason: each reads a side room too, and says why']);
  assert.deepEqual(run({ 'lib/board.js': 'for (const r of store.roomsOf(hall)) count(r);' }), ['lib/board.js: 1 calls to the any-room readers, 0 with a reason: each reads a side room too, and says why']);
  assert.deepEqual(run({ 'server.js': 'const r = store.room(key);' }), ['server.js: 1 calls to the any-room readers, 2 with a reason: each reads a side room too, and says why']);
  for (const past of ['for (const r of store.side.values()) count(r);', 'const list = store.sideByHall.get(hall);']) {
    assert.deepEqual(run({ 'lib/board.js': past }), ['lib/board.js reaches the store\'s side rooms past its readers (store.side, store.sideByHall)'], past);
  }
  assert.deepEqual(run({}, { ...rows, 'lib/gone.js': ['x'] }), ['lib/gone.js is not in the tree: its row goes']);
  // A hall's readers, a method of the same name on another object, and a room's own fields are none of them.
  assert.deepEqual(run({ 'lib/board.js': 'store.get(c); store.has(c); store.rooms.values(); this.room(k); hall.roomsOf; r.side; displays.room(k);' }), []);
});
