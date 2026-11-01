'use strict';
// The fence on the fence: agm/no-unescaped-html refuses an unescaped value on its way into a page's HTML and lets the
// escaped shapes through, and the page floor's rules refuse what Safari lacks unless it is reached through its helper, so
// a refactor of a rule or of the config cannot quietly stop catching the defect it is there for.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Linter, ESLint } = require('eslint');
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
