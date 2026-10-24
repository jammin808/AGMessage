'use strict';
// The fence on the fence: agm/no-unescaped-html refuses an unescaped value on its way into a page's HTML and lets the
// escaped shapes through, so a refactor of the rule cannot quietly stop catching the defect it is there for.
const test = require('node:test');
const assert = require('node:assert');
const { Linter } = require('eslint');
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
