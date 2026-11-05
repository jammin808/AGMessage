'use strict';
/**
 * agm/inert-html — in the documents' modules (docmodel.mjs, docview.mjs, docworker.js) and the take layer that draws a
 * document or a picture through them (pagelayer.mjs), HTML is parsed in one place:
 * parseInert (public/docmodel.mjs), an inert <template> walked into plain data. Outside a function named parseInert,
 * each way of turning markup into nodes, or of moving parsed nodes into the page, is refused:
 *   - writing `innerHTML` or `outerHTML`, `insertAdjacentHTML(`, `setHTMLUnsafe(`, `parseHTMLUnsafe(`,
 *     `createContextualFragment(`, `document.write(` and `document.writeln(`;
 *   - `DOMParser`'s `parseFromString(` as HTML (a type of 'text/html', or one not written as a string);
 *   - `importNode(` and `adoptNode(`, which bring parsed nodes into a live document, where a <meta http-equiv=refresh>
 *     would navigate and a <style> would apply;
 *   - a template's `.content` read, the parsed fragment itself.
 * Inside parseInert they are what it is for; a test holds the three files to one innerHTML site between them.
 */
const CALLS = new Set(['insertAdjacentHTML', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'createContextualFragment', 'importNode', 'adoptNode']);
const MARKUP = new Set(['innerHTML', 'outerHTML']);

/** A member's key as written: `x.name`, or `x['name']` / x[`name`] with a key that is a string. */
function keyOf(m) {
  if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : '';
  if (m.property.type === 'Literal' && typeof m.property.value === 'string') return m.property.value;
  if (m.property.type === 'TemplateLiteral' && m.property.expressions.length === 0) return m.property.quasis[0].value.cooked;
  return '';
}

/** Whether a function node is parseInert: declared, assigned to a name, or a method of that name. */
function isParseInert(fn, parent) {
  if (fn.id && fn.id.name === 'parseInert') return true;
  if (!parent) return false;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && parent.id.name === 'parseInert') return true;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && keyName(parent.key) === 'parseInert') return true;
  return false;
}
const keyName = (k) => (k.type === 'Identifier' ? k.name : k.type === 'Literal' ? String(k.value) : '');
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'HTML is parsed only in parseInert, and nothing parsed is adopted into the page' },
    schema: [],
    messages: { outside: '{{what}} outside parseInert: HTML is parsed in one place (docmodel.mjs parseInert), walked into plain data, and never adopted into the page.' },
  },
  create(context) {
    const source = context.sourceCode || context.getSourceCode();
    const inside = (node) => {
      const chain = source.getAncestors(node);
      for (let i = chain.length - 1; i >= 0; i--) if (FUNCTIONS.has(chain[i].type) && isParseInert(chain[i], chain[i - 1])) return true;
      return false;
    };
    const refuse = (node, what) => { if (!inside(node)) context.report({ node, messageId: 'outside', data: { what } }); };
    return {
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression' && MARKUP.has(keyOf(node.left))) refuse(node, 'Writing ' + keyOf(node.left));
      },
      CallExpression(node) {
        const c = node.callee;
        const name = c.type === 'MemberExpression' ? keyOf(c) : c.type === 'Identifier' ? c.name : '';
        if (CALLS.has(name)) return refuse(node, name + '()');
        if ((name === 'write' || name === 'writeln') && c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'document') return refuse(node, 'document.' + name + '()');
        if (name === 'parseFromString') {
          const type = node.arguments[1];
          const literal = type && type.type === 'Literal' && typeof type.value === 'string' ? type.value.toLowerCase()
            : type && type.type === 'TemplateLiteral' && type.expressions.length === 0 ? type.quasis[0].value.cooked.toLowerCase() : null;
          if (literal === null || literal === 'text/html') refuse(node, 'parseFromString() as HTML');
        }
      },
      MemberExpression(node) {
        if (keyOf(node) === 'content' && !(node.parent && node.parent.type === 'CallExpression' && node.parent.callee === node)) refuse(node, 'A template\'s .content');
      },
    };
  },
};
