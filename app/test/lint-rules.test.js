'use strict';
// The fence on the fence: agm/no-unescaped-html refuses an unescaped value on its way into a page's HTML and lets the
// escaped shapes through, and the page floor's rules refuse what Safari lacks unless it is reached through its helper, so
// a refactor of a rule or of the config cannot quietly stop catching the defect it is there for. No page script writes a
// status mark of its own: each is AGM.MARKS'.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');
const { Linter, ESLint } = require('eslint');
const { readSource } = require('./helpers');
const rule = require('../eslint-rules/no-unescaped-html');

const linter = new Linter({ configType: 'flat' });
const config = [{ plugins: { agm: { rules: { 'no-unescaped-html': rule } } }, languageOptions: { ecmaVersion: 2025, sourceType: 'script' }, rules: { 'agm/no-unescaped-html': 'error' } }];
const findings = (code) => linter.verify(code, config).map((m) => m.ruleId);

test('agm/no-unescaped-html: unescaped values are refused at every sink', () => {
  for (const code of [
    'el.innerHTML = msg.text;',
    'el.innerHTML = "<b>" + name + "</b>";',
    // eslint-disable-next-line no-template-curly-in-string -- code under test, not a template
    'el.innerHTML = `<b>${user.name}</b>`;',
    'el.outerHTML = html;',
    'el.insertAdjacentHTML("beforeend", "<i>" + caption + "</i>");',
    'el.innerHTML = cond ? escapeHtml(a) : b;',
    'el.innerHTML = list.map(x => "<li>" + x + "</li>").join("");',
    'el.innerHTML = String(n);',
  ]) assert.deepEqual(findings(code), ['agm/no-unescaped-html'], code);
});

// Four sinks no escape makes safe are refused whatever they are given: a frame's srcdoc (by property, by a computed key or
// by setAttribute, in any case), setHTMLUnsafe(), createContextualFragment(), and innerHTML or outerHTML named by a
// computed key, which the rule could not otherwise read. A page's one frame is framePage's, from an https address.
test('agm/no-unescaped-html: srcdoc, setHTMLUnsafe(), createContextualFragment() and a computed innerHTML are refused, escaped or not', () => {
  for (const code of [
    'frame.srcdoc = html;', 'frame.srcdoc = "";', 'frame.srcdoc = escapeHtml(x);', 'frame["srcdoc"] = "<b>x</b>";',
    'frame.setAttribute("srcdoc", html);', 'frame.setAttribute("SrcDoc", "");', 'frame.setAttribute(`srcdoc`, x);',
    'el.setHTMLUnsafe(html);', 'el.setHTMLUnsafe("");', 'el["setHTMLUnsafe"](x);', 'Document.parseHTMLUnsafe; el.setHTMLUnsafe(escapeHtml(x));',
    'range.createContextualFragment(html);', 'document.createRange().createContextualFragment("<p>x</p>");',
    'el["innerHTML"] = html;', 'el["innerHTML"] = "";', "el['outerHTML'] = escapeHtml(x);", 'el[`innerHTML`] = x;',
  ]) assert.deepEqual(findings(code), ['agm/no-unescaped-html'], code);
  // What only names them, and the frame's other attributes, pass: a value written as text, an attribute that is no sink.
  for (const code of ['el.textContent = "srcdoc";', 'frame.setAttribute("sandbox", "allow-scripts allow-same-origin");', 'frame.src = url;', 'const k = "innerHTML"; log(k);', 'el[key] = value;']) {
    assert.deepEqual(findings(code), [], code);
  }
});

test('agm/no-unescaped-html: escaped, literal, counted and named-safe values pass', () => {
  for (const code of [
    'el.innerHTML = "";',
    'el.innerHTML = "<p class=muted>None</p>";',
    // eslint-disable-next-line no-template-curly-in-string -- code under test, not a template
    'el.innerHTML = `<b>${escapeHtml(user.name)}</b> ${items.length}`;',
    'el.innerHTML = "<p>" + sanitizeHtml(doc) + "</p>";',
    'el.innerHTML = renderMessageText(m.text);',
    'el.innerHTML = rowHtml + footerHtml;',
    'el.innerHTML = optionsHtml(current) || "—";',
    'el.insertAdjacentHTML("beforeend", escapeHtml(t));',
    'el.textContent = anything;',
  ]) assert.deepEqual(findings(code), [], code);
});

// HTML is parsed in one place (agm/inert-html): in the documents' modules, outside parseInert, every way of turning markup
// into nodes or of moving parsed nodes into the page is refused, each by a case of its own; inside parseInert the one
// parse passes; and the three modules and the take layer hold exactly one innerHTML site between them, parseInert's.
test('agm/inert-html: outside parseInert, DOMParser as HTML, importNode, adoptNode, document.write and writeln, parseHTMLUnsafe and a template\'s .content are refused; exactly one innerHTML site in the documents\' modules', async () => {
  const inertRule = require('../eslint-rules/inert-html');
  const own = [{ plugins: { agm: { rules: { 'inert-html': inertRule } } }, languageOptions: { ecmaVersion: 2025, sourceType: 'module' }, rules: { 'agm/inert-html': 'error' } }];
  const ids = (code) => linter.verify(code, own).map((m) => m.ruleId);
  for (const code of [
    'new DOMParser().parseFromString(html, "text/html");',
    'new DOMParser().parseFromString(html, `text/html`);',
    'const p = new DOMParser(); p.parseFromString(html, type);',
    'document.importNode(node, true);',
    'document.adoptNode(node);',
    'document.write(html);',
    'document.writeln(html);',
    'Document.parseHTMLUnsafe(html);',
    'el.setHTMLUnsafe(html);',
    'range.createContextualFragment(html);',
    'export const f = (t) => t.content.cloneNode(true);',
    'box.innerHTML = "";',
    'box.outerHTML = x;',
    'box.insertAdjacentHTML("beforeend", x);',
  ]) assert.deepEqual(ids(code), ['agm/inert-html'], code);
  assert.deepEqual(ids('function notParseInert(html) { const t = document.createElement("template"); t.innerHTML = html; return t.content; }'), ['agm/inert-html', 'agm/inert-html'], 'the same parse under another name: its innerHTML and its .content');
  for (const code of [
    'export function parseInert(html) { const t = document.createElement("template"); t.innerHTML = String(html); return walk(t.content); }',
    'export const parseInert = (html) => { const t = document.createElement("template"); t.innerHTML = html; return t.content; };',
    'new DOMParser().parseFromString(xml, "application/xml");',
    'el.textContent = "<b>x</b>";',
    'const text = (await page.getTextContent()).items;',
  ]) assert.deepEqual(ids(code), [], code);
  // The config holds the three modules and the take layer to it, and the tree passes.
  const repo = path.join(__dirname, '..', '..');
  const eslint = new ESLint({ cwd: repo });
  const found = async (code, file) => (await eslint.lintText(code, { filePath: path.join(repo, file) }))[0].messages.map((m) => m.ruleId);
  for (const file of ['app/public/docmodel.mjs', 'app/public/docview.mjs', 'app/public/pagelayer.mjs']) assert.ok((await found('export const f = (n) => document.importNode(n, true);\n', file)).includes('agm/inert-html'), file);
  assert.ok((await found('self.f = (n) => n.content;\n', 'app/public/docworker.js')).includes('agm/inert-html'), 'docworker.js');
  let sites = 0;
  for (const file of ['docmodel.mjs', 'docview.mjs', 'docworker.js', 'pagelayer.mjs']) {
    const code = readSource(path.join('app', 'public', file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    sites += (code.match(/\binnerHTML\b/g) || []).length;
  }
  assert.equal(sites, 1, 'parseInert\'s, and no other');
});

// The page floor's half in the lint (eslint.config.mjs, as `npm run lint` reads it): on a page, what Safari lacks is
// reached only through its helper or behind its probe, and the user agent is never read however it is reached;
// theme-init.js, which says the floor's words below it, parses as ES5.
test('the page floor in the lint: a bare requestIdleCallback or cancelIdleCallback, a bare requestSubmit() and a read of the user agent are refused on a page; theme-init.js parses as ES5', async () => {
  const repo = path.join(__dirname, '..', '..');
  const eslint = new ESLint({ cwd: repo });
  const found = async (code, file) => (await eslint.lintText(code, { filePath: path.join(repo, file) }))[0].messages.map((m) => m.ruleId || (m.fatal ? 'parse' : m.message));
  const page = 'app/public/planted.js';
  assert.deepEqual(await found('requestIdleCallback(() => {});\n', page), ['no-restricted-globals'], 'a bare requestIdleCallback on a page');
  assert.deepEqual(await found('cancelIdleCallback(1);\n', page), ['no-restricted-globals'], 'a bare cancelIdleCallback on a page');
  for (const code of ['AGM.ua = navigator.userAgent;\n', 'AGM.ua = window.navigator.userAgent;\n', 'AGM.ua = navigator.userAgentData;\n', 'AGM.ua = navigator[\'userAgent\'];\n',
    'const { userAgent } = window.navigator; AGM.ua = userAgent;\n', 'const { userAgentData: ua } = navigator; AGM.ua = ua;\n']) {
    assert.deepEqual(await found(code, page), ['no-restricted-syntax'], 'the user agent read on a page, however it is reached: ' + code.trim());
  }
  assert.deepEqual(await found('export const ua = navigator.userAgent;\n', 'app/public/planted.mjs'), ['no-restricted-syntax'], 'and on a page module');
  assert.deepEqual(await found('AGM.form.requestSubmit();\n', page), ['no-restricted-syntax'], 'requestSubmit() (Safari 16) called on a page');
  assert.deepEqual(await found('AGM.x = typeof AGM.form.requestSubmit === \'function\';\n', page), [], 'its probe is no call, and passes');
  assert.ok((await found('AGM.x = new Function(\'\');\n', page)).includes('no-restricted-syntax'), 'the house\'s banned syntax still holds on a page');
  assert.deepEqual(await found('Math.random();\n', page), ['no-restricted-properties'], 'the house\'s banned calls still hold on a page');
  assert.deepEqual(await found('if (typeof window.requestIdleCallback === \'function\') window.requestIdleCallback(() => {});\n', page), [], 'reached behind its probe, as AGM.idle does, it passes');
  assert.deepEqual(await found('(function () { var x = 1; window.x = x; })();\n', 'app/public/theme-init.js'), [], 'ES5 with var passes in theme-init.js');
  for (const code of ['(function () { const x = 1; window.x = x; })();\n', 'window.f = () => 1;\n', 'try { window.x = 1; } catch { window.x = 0; }\n']) {
    assert.deepEqual(await found(code, 'app/public/theme-init.js'), ['parse'], 'newer syntax does not parse in theme-init.js: ' + code.trim());
  }
});

// No page opens a native dialog (eslint.config.mjs's `no-alert` on every page script and page module): alert, confirm and
// prompt pause the page's scripts, and a page paused 20 s drops its socket. A question is asked in place (AGM.ask).
test('no native dialog in the lint: alert, confirm and prompt are refused on every page script and page module, however they are reached', async () => {
  const repo = path.join(__dirname, '..', '..');
  const eslint = new ESLint({ cwd: repo });
  const found = async (code, file) => (await eslint.lintText(code, { filePath: path.join(repo, file) }))[0].messages.map((m) => m.ruleId || (m.fatal ? 'parse' : m.message));
  for (const file of ['app/public/admin.js', 'app/public/admin-plus.js', 'app/public/users.js', 'app/public/halls.js', 'app/public/app.js', 'app/public/planted.js']) {
    for (const code of ['alert(\'Not saved.\');\n', 'if (confirm(\'Remove it?\')) AGM.x = 1;\n', 'AGM.x = prompt(\'Its name\');\n', 'window.alert(\'x\');\n', 'AGM.x = window.confirm(\'y\');\n']) {
      assert.deepEqual(await found(code, file), ['no-alert'], file + ': ' + code.trim());
    }
  }
  assert.deepEqual(await found('export const ask = () => window.prompt(\'x\');\n', 'app/public/planted.mjs'), ['no-alert'], 'and on a page module');
  assert.deepEqual(await found('AGM.ask(null, { title: \'Remove it?\' });\nAGM.toast(\'Not saved.\', true);\n', 'app/public/planted.js'), [], 'an ask in place and a toast pass');
  assert.deepEqual(await found('(function () { const confirm = [1]; AGM.x = confirm.length; })();\n', 'app/public/planted.js'), [], 'a value named confirm is no dialog');
});

// Every status a page draws is a mark of the one table, AGM.MARKS (public/common.js): no page script writes a mark of its
// own in a string or a template, nor one of the marks the table retired, so a mark keeps one meaning on every page.
test('the marks in the lint: a status mark written by a page script is refused, every mark of AGM.MARKS and every retired one; AGM.mark passes; common.js and the screen page hold their own', async () => {
  const repo = path.join(__dirname, '..', '..');
  const eslint = new ESLint({ cwd: repo });
  const found = async (code, file) => (await eslint.lintText(code, { filePath: path.join(repo, file) }))[0].messages.map((m) => m.ruleId || (m.fatal ? 'parse' : m.message));
  const ctx = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(readSource('app/public/common.js'), ctx, { filename: 'common.js' });
  const marks = Object.values(ctx.AGM.MARKS).map((m) => m.mark);
  assert.equal(marks.length, 13, 'the table\'s marks are read');
  for (const glyph of [...marks, '✗', '⚠', '⏳', '⏸']) {
    for (const file of ['app/public/app.js', 'app/public/halls.js', 'app/public/admin.js', 'app/public/admin-plus.js', 'app/public/users.js', 'app/public/audit-export.js', 'app/public/catalog.js', 'app/public/planted.js']) {
      assert.deepEqual(await found('AGM.x = \'' + glyph + ' Sent\';\n', file), ['no-restricted-syntax'], file + ' writes ' + glyph + ' in a string');
    }
    assert.deepEqual(await found('AGM.x = `' + glyph + ' $' + '{AGM.y}`;\n', 'app/public/app.js'), ['no-restricted-syntax'], 'and in a template: ' + glyph);
    // Written as its escape, it is the same mark: in a string (its value) and in a template (its text as it reads).
    const escaped = '\\u' + glyph.codePointAt(0).toString(16).padStart(4, '0');
    assert.deepEqual(await found('AGM.x = \'' + escaped + ' Sent\';\n', 'app/public/app.js'), ['no-restricted-syntax'], 'and escaped in a string: ' + escaped);
    assert.deepEqual(await found('AGM.x = `' + escaped + ' $' + '{AGM.y}`;\n', 'app/public/app.js'), ['no-restricted-syntax'], 'and escaped in a template: ' + escaped);
    assert.deepEqual(await found('export const x = \'' + glyph + '\';\n', 'app/public/planted.mjs'), ['no-restricted-syntax'], 'and in a page module: ' + glyph);
  }
  assert.deepEqual(await found('AGM.x = AGM.mark(\'ok\') + \' Sent\';\nAGM.chip(AGM.el, \'waiting\', \'Sending\');\n', 'app/public/app.js'), [], 'a mark by its name passes');
  assert.deepEqual(await found('AGM.x = \'Sent ↗ to Legal · 📺\';\n', 'app/public/app.js'), [], 'an act\'s icon is no mark');
  assert.deepEqual(await found('AGM.ua = navigator.userAgent;\n', 'app/public/app.js'), ['no-restricted-syntax'], 'the page floor\'s rules still hold beside it');
  assert.deepEqual(await found('AGM.x = \'✓\';\n', 'app/public/common.js'), [], 'common.js holds the table');
  assert.deepEqual(await found('window.x = \'●\';\n', 'app/public/display.js'), [], 'the screen page loads none of the people\'s pages\' scripts: its tones are held by test/modules.test.js');
});

// A test reads the checkout's text through readSource and finds a free port through test/helpers.js (agm/test-helpers):
// a Windows checkout has CR LF, so a source read as it lies and matched with LF passes on Linux and fails on Windows; and
// a port free for TCP may be one Windows keeps from UDP.
test('agm/test-helpers: a test\'s own text read of the checkout and its own port picker are refused; bytes, files it wrote and the helpers pass; every test file is held to it', async () => {
  const helpersRule = require('../eslint-rules/test-helpers');
  const own = [{ plugins: { agm: { rules: { 'test-helpers': helpersRule } } }, languageOptions: { ecmaVersion: 2025, sourceType: 'script' }, rules: { 'agm/test-helpers': 'error' } }];
  const ids = (code, filename = 'app/test/planted.test.js') => linter.verify(code, own, { filename }).map((m) => m.messageId);
  for (const code of [
    'fs.readFileSync(path.join(ROOT, \'server.js\'), \'utf8\');',
    'readFileSync(path.join(__dirname, \'..\', \'lib\', \'x.js\'), { encoding: \'utf8\' });',
    'fs.readFileSync(path.join(h.ROOT, \'public\', f), \'utf8\');',
    'fs.readFileSync(path.resolve(REPO, \'CHANGELOG.md\'), \'utf8\').replace(/\\r\\n/g, \'\\n\');',
    'fs.promises.readFile(path.join(APP, \'server.js\'), \'utf8\');',
    // Through what a name was made from: a parameter's default, a const's initialiser, a few names deep.
    'const read = (f, root = ROOT) => fs.readFileSync(path.join(root, f), \'utf8\');',
    'const app = path.join(ROOT, \'app\'); const lib = app + \'/lib\'; fs.readFileSync(path.join(lib, \'x.js\'), \'utf8\');',
    'const VERIFY_DIR = path.join(__dirname, \'..\', \'verify\'); fs.readFileSync(`$' + '{VERIFY_DIR}/page.js`, \'utf8\');',
    'const VERIFY_DIR = path.join(__dirname, \'..\', \'verify\'); fs.readFileSync(VERIFY_DIR + \'/page.js\', \'utf8\');',
  ]) assert.deepEqual(ids(code), ['source'], code);
  for (const code of ['const freePort = () => 0;', 'function pickUdpPort() {}', 'let findPort;', 'const findFreeTcpPort = 1;']) assert.deepEqual(ids(code), ['port'], code);
  for (const code of [
    'fs.readFileSync(path.join(ROOT, \'public\', \'vendor\', \'a.js\'));',
    'fs.readFileSync(path.join(dir, \'log.jsonl\'), \'utf8\');',
    'readSource(path.join(ROOT, \'server.js\'));',
    'const { freePort, freeUdpPort } = require(\'./helpers\');',
    'fs.readFile(path.join(ROOT, \'x\'), (e, b) => b);',
    'async function start() { const port = await freePort(); return port; }',
    // Names that are not port pickers, and paths of the test's own making: a temporary folder, a server's data folder.
    'function findExport() {} const findReport = 1; const pickImport = 2; function freeSupport() {}',
    'const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p + ROOT)); const dir = tmp(\'x\'); fs.readFileSync(path.join(dir, \'a.log\'), \'utf8\');',
    'async function f() { const srv = await startServer({ cwd: ROOT }); return fs.readFileSync(path.join(srv.dataDir, \'rooms\', \'A.log\'), \'utf8\'); }',
    'fs.readFileSync(path.join(ROOT, \'public\', \'vendor\', \'m.js\'), \'latin1\');',
  ]) assert.deepEqual(ids(code), [], code);
  assert.deepEqual(ids('const freePort = () => 0; fs.readFileSync(path.join(REPO, \'x\'), \'utf8\');', 'app/test/helpers.js'), [], 'test/helpers.js defines them');
  const repo = path.join(__dirname, '..', '..');
  const eslint = new ESLint({ cwd: repo });
  const found = async (code, file) => (await eslint.lintText(code, { filePath: path.join(repo, file) }))[0].messages.map((m) => m.ruleId);
  assert.deepEqual(await found('\'use strict\';\nconst fs = require(\'fs\');\nconst path = require(\'path\');\nmodule.exports = fs.readFileSync(path.join(__dirname, \'..\', \'server.js\'), \'utf8\');\n', 'app/test/planted.test.js'), ['agm/test-helpers'], 'the config holds every test file to it');
  assert.deepEqual(await found('\'use strict\';\nconst net = require(\'net\');\nmodule.exports = function freePort() { return net; };\n', 'app/test/planted-preload.js'), ['agm/test-helpers'], 'a preload too');
});

// The other half: CI runs the suites on Linux on a checkout with Windows' line ends, so a test that reads a source and
// matches LF fails in minutes there, before the Windows job, and the zip is not built until it passes.
test('CI: the suites run on a CR LF checkout on Linux, and the package waits for them', () => {
  const ci = readSource('.github/workflows/ci.yml');
  const at = ci.indexOf('\n  test-crlf:\n');
  assert.ok(at > 0, 'the job');
  const job = ci.slice(at, ci.indexOf('\n  test-windows:\n'));
  assert.match(job, /\n {4}runs-on: ubuntu-latest\n/);
  assert.match(job, /\n {10}git config core\.autocrlf true\n {10}git ls-files -z \| xargs -0 rm -f --\n {10}git checkout -- \.\n/, 'every tracked file checked out again with CR LF');
  assert.match(job, /if ! grep -q \$'\\r\$' app\/server\.js; then echo "::error::[^"]+"; exit 1; fi/, 'and that it took');
  assert.match(job, /if grep -q \$'\\r' app\/public\/vendor\/VENDOR\.json; then echo "::error::[^"]+"; exit 1; fi/, 'the vendored files left byte for byte');
  assert.ok(job.indexOf('git checkout -- .') < job.indexOf('npm ci'), 'before the install');
  assert.match(job, /\n {6}- name: Unit, end-to-end and watchdog tests\n {8}run: npm test\n {8}working-directory: app\n/);
  assert.match(ci, /\n {2}package:\n[^]*?\n {4}needs: \[analyze, test-linux, test-crlf, test-windows\]\n/);
});
