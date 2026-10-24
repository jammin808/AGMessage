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

  // The server, its libraries and the tools: strict mode, and a promise's executor returns nothing.
  {
    files: ['app/server.js', 'app/supervise.js', 'app/lib/**/*.js', 'app/eslint-rules/**/*.js', 'tools/**/*.js'],
    rules: { strict: ['error', 'global'], 'no-promise-executor-return': 'error' },
  },
  // A library never ends the process: the server decides, and its exit codes carry intent (lib/resilience.js EXIT).
  {
    files: ['app/lib/**/*.js'],
    rules: { 'no-restricted-properties': ['error', ...bannedProperties, { object: 'process', property: 'exit', message: 'a library never ends the process: return or throw, and let server.js or supervise.js decide' }] },
  },

  // The pages: browser globals, one script scope per page, and HTML only from escaped parts.
  {
    files: ['app/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, io: 'readonly', pdfjsLib: 'readonly', mammoth: 'readonly', XLSX: 'readonly', AGM: 'writable' } },
    rules: { 'agm/no-unescaped-html': 'error' },
  },
  { files: ['app/public/**/*.mjs'], languageOptions: { sourceType: 'module', globals: { ...globals.browser } }, rules: { 'agm/no-unescaped-html': 'error' } },

  // The tests: the same fences (they run on the show laptop's runtime too), with the test runner's globals.
  { files: ['app/test/**/*.js'], languageOptions: { globals: { ...globals.node } } },
  { files: ['eslint.config.mjs'], languageOptions: { sourceType: 'module' } },
];
