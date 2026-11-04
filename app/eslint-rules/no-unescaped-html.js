'use strict';
/**
 * agm/no-unescaped-html — every value written into a page as HTML is escaped where it is written.
 *
 * innerHTML, outerHTML and insertAdjacentHTML take markup; a message, a name or a file name that reaches one of them
 * unescaped is script in everyone's browser. A value may go into them only as:
 *   - a string, number or template literal with no expressions (markup the page itself wrote)
 *   - a call to an escaper the page defines (escapeHtml, sanitizeHtml, renderMessageText, esc)
 *   - a name that ends in "Html" (whoHtml, roleOptionsHtml(…)): markup already built from escaped parts, said so by its name
 *   - a count (anything.length, a numeric literal)
 *   - those joined with + or a template, or chosen between with ?: / || / ??
 * Anything else is refused: escape it, or build it with textContent.
 *
 * Four sinks are refused whatever they are given, since no escape makes them safe and the page never needs them: a
 * frame's `srcdoc` (a document of the page's own origin, by property or by setAttribute), `setHTMLUnsafe(`,
 * `createContextualFragment(` (markup that runs its scripts), and innerHTML or outerHTML named by a computed key
 * (`el['innerHTML']`), which the checks above would not read. A page builds its one frame with framePage
 * (public/pagelayer.mjs), from an https address, never from markup.
 */
const ESCAPERS = new Set(['escapeHtml', 'sanitizeHtml', 'renderMessageText', 'esc']);

function calleeName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
  return '';
}

function safe(node) {
  if (!node) return true;
  switch (node.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': return node.expressions.every(safe);
    case 'BinaryExpression': return node.operator === '+' && safe(node.left) && safe(node.right);
    case 'ConditionalExpression': return safe(node.consequent) && safe(node.alternate);
    case 'LogicalExpression': return safe(node.left) && safe(node.right);
    case 'CallExpression': { const n = calleeName(node.callee); return ESCAPERS.has(n) || /Html$|HTML$/.test(n); }
    case 'Identifier': return /Html$|HTML$/.test(node.name);
    case 'MemberExpression':
      if (!node.computed && node.property.type === 'Identifier') return node.property.name === 'length' || /Html$|HTML$/.test(node.property.name);
      return false;
    default: return false;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'HTML written into a page is built only from escaped parts' },
    schema: [],
    messages: {
      unescaped: 'This value reaches {{sink}} unescaped: pass it through escapeHtml (or build it with textContent).',
      never: '{{sink}} is never used by a page: build the nodes with textContent, and a frame with framePage (public/pagelayer.mjs).',
    },
  },
  create(context) {
    const check = (sink, value, at) => { if (!safe(value)) context.report({ node: at || value, messageId: 'unescaped', data: { sink } }); };
    const never = (sink, node) => context.report({ node, messageId: 'never', data: { sink } });
    /** A member's key as written: `el.name`, or `el['name']` / el[`name`] with a key that is a string. */
    const keyOf = (m) => {
      if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : '';
      if (m.property.type === 'Literal' && typeof m.property.value === 'string') return m.property.value;
      if (m.property.type === 'TemplateLiteral' && m.property.expressions.length === 0) return m.property.quasis[0].value.cooked;
      return '';
    };
    const MARKUP = new Set(['innerHTML', 'outerHTML']);
    return {
      AssignmentExpression(node) {
        const l = node.left;
        if (l.type !== 'MemberExpression') return;
        const key = keyOf(l);
        if (key.toLowerCase() === 'srcdoc') return never('srcdoc', node);
        if (l.computed && MARKUP.has(key)) return never(l.object.type === 'Identifier' ? l.object.name + "['" + key + "']" : "['" + key + "']", node);
        if (!l.computed && MARKUP.has(key)) check(key, node.right);
      },
      CallExpression(node) {
        const n = node.callee.type === 'MemberExpression' ? keyOf(node.callee) : calleeName(node.callee);
        if (n === 'insertAdjacentHTML') check('insertAdjacentHTML', node.arguments[1], node);
        if (n === 'setHTMLUnsafe' || n === 'createContextualFragment') never(n + '()', node);
        const first = node.arguments[0];
        const named = first && first.type === 'Literal' && typeof first.value === 'string' ? first.value
          : first && first.type === 'TemplateLiteral' && first.expressions.length === 0 ? first.quasis[0].value.cooked : '';
        if (n === 'setAttribute' && named.toLowerCase() === 'srcdoc') never('srcdoc', node);
      },
    };
  },
};
