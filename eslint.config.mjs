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
const agm = { rules: { 'no-unescaped-html': require('./eslint-rules/no-unescaped-html.js') } };

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
  // a question is asked in place (AGM.ask) and words go to the page's toast.
  {
    files: ['app/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, io: 'readonly', pdfjsLib: 'readonly', mammoth: 'readonly', XLSX: 'readonly', AGM: 'writable' } },
    rules: { 'agm/no-unescaped-html': 'error', 'no-alert': 'error', ...pageFloor },
  },
  { files: ['app/public/**/*.mjs'], languageOptions: { sourceType: 'module', globals: { ...globals.browser } }, rules: { 'agm/no-unescaped-html': 'error', 'no-alert': 'error', ...pageFloor } },
  // The first script of every page with people says the floor's words below it, so it parses there: ES5 only (a newer
  // syntax is a parse error), `var` with it.
  { files: ['app/public/theme-init.js'], languageOptions: { ecmaVersion: 5 }, rules: { 'no-var': 'off', 'prefer-const': 'off' } },

  // The tests: the same fences (they run on the show laptop's runtime too), with the test runner's globals.
  { files: ['app/test/**/*.js'], languageOptions: { globals: { ...globals.node } } },
  { files: ['eslint.config.mjs'], languageOptions: { sourceType: 'module' } },
];
