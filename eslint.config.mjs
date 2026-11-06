// AGMessage's analyzers are fences: `npm run lint` fails on any finding, and CI runs it before the tests. Each rule below
// is here for a defect class that breaks a live event or opens a hole, with the reason beside it; the measured baseline,
// the rules judged and left out, and why, are in docs/ANALYSIS.md. A rule is silenced only on its line, with
// `// eslint-disable-next-line <rule> -- <reason>`; an unexplained or unused disable fails the build too.
// It lives at the repository's root so it covers app/ and tools/ alike; the packages come from app/node_modules (the one
// package.json), run as `npm run lint` in app/.
import { createRequire } from 'node:module';

const require = createRequire(new URL('./app/package.json', import.meta.url));
const js = require('@eslint/js');
const security = require('eslint-plugin-security');
const globals = require('globals');
const agm = { rules: { 'no-unescaped-html': require('./eslint-rules/no-unescaped-html.js'), 'inert-html': require('./eslint-rules/inert-html.js'), 'test-helpers': require('./eslint-rules/test-helpers.js') } };

// The calls AGMessage never makes, with the reason each (the house's banned-API list).
const bannedProperties = [
  { object: 'Math', property: 'random', message: 'ids, tokens and jitter come from node:crypto (crypto.randomInt / randomBytes): Math.random is predictable' },
  { object: 'child_process', property: 'exec', message: 'exec runs a shell: spawn with an argument array, never a command line built from strings' },
  { object: 'child_process', property: 'execSync', message: 'a shell, and a blocking one: spawn with an argument array' },
  { object: 'document', property: 'write', message: 'document.write takes markup unescaped: build the node, or set textContent' },
];
const bannedSyntax = [
  { selector: "Property[key.name='rejectUnauthorized'][value.value=false]", message: 'a certificate is pinned (lib/tls.js), never ignored; only the pin probe may read an unverified certificate, on its line' },
  { selector: "AssignmentExpression[left.object.object.name='process'][left.object.property.name='env'][left.property.name='NODE_TLS_REJECT_UNAUTHORIZED']", message: 'turning certificate checks off for the whole process is never the fix' },
  { selector: "CallExpression[callee.type='Identifier'][callee.name=/^(exec|execSync)$/]", message: 'exec runs a shell: spawn with an argument array' },
  { selector: "NewExpression[callee.name='Function']", message: 'new Function is eval' },
];

// The page floor's half in the lint: what Safari lacks is reached only through its helper or behind its probe, and no page
// reads the user agent, however it reaches it (`navigator.userAgent`, `window.navigator.userAgent`, `userAgentData`, a
// computed key or a destructuring).
const UA = '/^userAgent(Data)?$/';
const pageFloor = {
  'no-restricted-globals': ['error',
    { name: 'requestIdleCallback', message: 'use AGM.idle: Safari has none' },
    { name: 'cancelIdleCallback', message: 'use AGM.idle: Safari has none' }],
  'no-restricted-syntax': ['error', ...bannedSyntax,
    { selector: `:matches(MemberExpression[property.name=${UA}], MemberExpression[property.value=${UA}], ObjectPattern > Property[key.name=${UA}], ObjectPattern > Property[key.value=${UA}])`,
      message: 'no page reads the user agent: a fallback is chosen by a probe or by what failed' },
    { selector: "CallExpression[callee.property.name='requestSubmit']",
      message: 'requestSubmit() is Safari 16, above the page floor: call it behind its probe, with the form\'s submit button clicked where it is missing' }],
};

// Every status a page draws is a mark of one table, AGM.MARKS (app/public/common.js), each mark with one meaning: no page
// script writes one of its own in a string, and none writes the marks the table retired (✗ ⚠ ⏳ ⏸) in their place.
// common.js holds the table; the screen page (display.js) loads none of the people's pages' scripts, and its three tones
// are held to the table by test/modules.test.js.
const MARK_GLYPHS = '✓◐◇▭○⊘◷△✕■▶●▲✗⚠⏳⏸';
const MARK_WORDS = 'a status mark is AGM.MARKS\' (common.js): AGM.mark(name), or AGM.chip(el, name, words), so each mark keeps one meaning';
const marksFromTable = {
  'no-restricted-syntax': [...pageFloor['no-restricted-syntax'],
    { selector: `Literal[value=/[${MARK_GLYPHS}]/u]`, message: MARK_WORDS },
    // A template's text as written and as it reads: a mark written as its escape (\u2713) is that mark.
    { selector: `TemplateElement:matches([value.raw=/[${MARK_GLYPHS}]/u], [value.cooked=/[${MARK_GLYPHS}]/u])`, message: MARK_WORDS }],
};

export default [
  { ignores: ['app/public/vendor/**', '**/node_modules/**', 'app/uploads/**', 'app/data/**', '**/coverage/**', 'dist/**', 'node/**', 'bin/**', 'artifacts/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' } },

  // Everything: the recommended correctness rules, the security rules that find real defects, the banned calls.
  {
    files: ['**/*.js', '**/*.mjs'],
    plugins: { security, agm },
    languageOptions: { ecmaVersion: 2025, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: false }],   // a swallowed error says why in a comment
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-proto': 'error',
      'no-extend-native': 'error',
      'no-caller': 'error',
      'no-throw-literal': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-restricted-properties': ['error', ...bannedProperties],
      'no-restricted-syntax': ['error', ...bannedSyntax],
      'security/detect-eval-with-expression': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-child-process': 'error',
      'security/detect-unsafe-regex': 'error',          // a regular expression with nested repetition is a ReDoS
      'security/detect-non-literal-regexp': 'error',    // a pattern built from input is a ReDoS
      'security/detect-buffer-noassert': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-bidi-characters': 'error',       // Trojan Source
      'security/detect-invisible-characters': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-disable-mustache-escape': 'error',
    },
  },

  // The server, its libraries, the verifier and the tools: strict mode, and a promise's executor returns nothing.
  {
    files: ['app/server.js', 'app/supervise.js', 'app/launch.js', 'app/lib/**/*.js', 'app/verify/**/*.js', 'app/eslint-rules/**/*.js', 'tools/**/*.js'],
    rules: { strict: ['error', 'global'], 'no-promise-executor-return': 'error' },
  },
  // The audit log's key-free rules run on the laptop and in a checker on another computer, so they are pure: every Node
  // global the block above gives is turned off here (so `require`, `process` or `Buffer` is an undefined name), no browser
  // global is given, and `module` is there only to be exported where there is one.
  {
    files: ['app/verify/auditrules.js'],
    languageOptions: { sourceType: 'script', globals: { ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, 'off'])), module: 'writable' } },
    rules: {
      'no-restricted-syntax': ['error', ...bannedSyntax,
        { selector: "MemberExpression[object.name='module'][property.name!='exports']", message: 'auditrules.js is pure: `module` is there only to export it' },
        { selector: 'ImportExpression', message: 'auditrules.js is pure: it loads nothing' }],
    },
  },
  // The browser verifier's script, put inline in verify.html beside auditrules.js: a page opened from disk, so browser
  // globals only (no Node global), one function scope, and HTML only from escaped parts, as the pages'.
  {
    files: ['app/verify/page.js'],
    languageOptions: { sourceType: 'script', globals: { ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, 'off'])), ...globals.browser } },
    rules: { strict: ['error', 'function'], 'agm/no-unescaped-html': 'error' },
  },
  // A library never ends the process: the server decides, and its exit codes carry intent (lib/resilience.js EXIT).
  {
    files: ['app/lib/**/*.js'],
    rules: { 'no-restricted-properties': ['error', ...bannedProperties, { object: 'process', property: 'exit', message: 'a library never ends the process: return or throw, and let server.js or supervise.js decide' }] },
  },

  // The pages: browser globals, one script scope per page, and HTML only from escaped parts. Every page holds the page
  // floor (Safari 14.1, Chrome 84; docs/DEVICES.md): a feature newer than it is reached through its helper, which probes
  // for it (`window.requestIdleCallback` behind AGM.idle is a member, not the bare global), and no page reads the user
  // agent, so a fallback is chosen by what the browser has, never by what it calls itself. No page opens a native alert,
  // confirm or prompt: it pauses the page's scripts, and a page paused 20 s drops its socket (measured; the plan's 5-§16.1);
  // a question is asked in place (AGM.ask) and words go to the page's toast. Every page script and module parses as
  // ES2020, whose newest syntax Safari parses from 14: a class field, a static block, `||=`, a numeric separator or a
  // top-level await is a parse error here, so each Board device parses what it is sent (the vendored files are ignored
  // above: pdf.js's legacy build sets the document floor, docs/DEVICES.md).
  {
    files: ['app/public/**/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: { ...globals.browser, io: 'readonly', pdfjsLib: 'readonly', mammoth: 'readonly', XLSX: 'readonly', AGM: 'writable', AGMLine: 'readonly' } },
    rules: { 'agm/no-unescaped-html': 'error', 'no-alert': 'error', ...pageFloor },
  },
  { files: ['app/public/**/*.mjs'], languageOptions: { ecmaVersion: 2020, sourceType: 'module', globals: { ...globals.browser } }, rules: { 'agm/no-unescaped-html': 'error', 'no-alert': 'error', ...pageFloor } },
  { files: ['app/public/**/*.js', 'app/public/**/*.mjs'], ignores: ['app/public/common.js', 'app/public/display.js'], rules: marksFromTable },
  // The pure cores the page's document worker loads as classic scripts, also loadable by require: the archive check's
  // (zipcore.js, the server's too, through lib/zipcheck.js), a picture's size from its header (imagecore.js, the
  // server's too, through lib/imagesize.js) and Word's pages and hidden text (wordpages.js); and the speaker's line of a
  // push (linecore.js, which the hall page loads as a script and the server through lib/stagelines.js). Pure over
  // what they are handed, so no global of Node's or of a page's but the language's own (the pages' own names and
  // libraries' included), `module` there only to be exported where there is one, and nothing loaded.
  {
    files: ['app/public/zipcore.js', 'app/public/imagecore.js', 'app/public/wordpages.js', 'app/public/linecore.js'],
    languageOptions: { globals: { ...Object.fromEntries([...Object.keys(globals.node), ...Object.keys(globals.browser), 'io', 'pdfjsLib', 'mammoth', 'XLSX', 'AGM', 'AGMLine'].map((name) => [name, 'off'])), module: 'writable' } },
    rules: {
      'no-restricted-syntax': ['error', ...marksFromTable['no-restricted-syntax'].slice(1),
        { selector: "MemberExpression[object.name='module'][property.name!='exports']", message: 'a pure core: `module` is there only to export it' },
        { selector: 'ImportExpression', message: 'a pure core loads nothing' },
        { selector: "CallExpression[callee.name='require']", message: 'a pure core loads nothing' }],
    },
  },
  // The document worker: a worker's globals, not a page's (no document, no window), the cores and libraries it loads
  // with importScripts by their names, and no page's own names.
  {
    files: ['app/public/docworker.js'],
    languageOptions: { globals: { ...Object.fromEntries([...Object.keys(globals.browser), 'io', 'pdfjsLib', 'AGM'].map((name) => [name, 'off'])), ...globals.worker, AGMZip: 'readonly', AGMWord: 'readonly', AGMImage: 'readonly', XLSX: 'readonly', mammoth: 'readonly' } },
  },
  // The documents' modules, and the take layer that draws a document or a picture through them, parse HTML in one place,
  // parseInert, and adopt nothing parsed into the page (agm/inert-html).
  { files: ['app/public/docmodel.mjs', 'app/public/docview.mjs', 'app/public/docworker.js', 'app/public/pagelayer.mjs'], rules: { 'agm/inert-html': 'error' } },
  // The first script of every page with people says the floor's words below it, so it parses there: ES5 only (a newer
  // syntax is a parse error), `var` with it.
  { files: ['app/public/theme-init.js'], languageOptions: { ecmaVersion: 5 }, rules: { 'no-var': 'off', 'prefer-const': 'off' } },

  // The tests: the same fences (they run on the show laptop's runtime too), with the test runner's globals; a file of the
  // checkout read through readSource and a free port from test/helpers.js (agm/test-helpers).
  { files: ['app/test/**/*.js'], languageOptions: { globals: { ...globals.node } }, rules: { 'agm/test-helpers': 'error' } },
  { files: ['eslint.config.mjs'], languageOptions: { sourceType: 'module' } },
];
