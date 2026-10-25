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
    messages: { unescaped: 'This value reaches {{sink}} unescaped: pass it through escapeHtml (or build it with textContent).' },
  },
  create(context) {
    const check = (sink, value, at) => { if (!safe(value)) context.report({ node: at || value, messageId: 'unescaped', data: { sink } }); };
    return {
      AssignmentExpression(node) {
        const l = node.left;
        if (l.type !== 'MemberExpression' || l.computed || l.property.type !== 'Identifier') return;
        if (l.property.name === 'innerHTML' || l.property.name === 'outerHTML') check(l.property.name, node.right);
      },
      CallExpression(node) {
        if (calleeName(node.callee) === 'insertAdjacentHTML') check('insertAdjacentHTML', node.arguments[1], node);
      },
    };
  },
};
