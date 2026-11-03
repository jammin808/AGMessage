'use strict';
/**
 * agm/test-helpers — a test reads the checkout's files, and finds a free port, through test/helpers.js.
 *
 *   A file of the checkout read as text: fs.readFileSync (or a readFile) given an encoding, whose path names the checkout
 *   (__dirname, a name ROOT, REPO or APP, or a member .ROOT or .REPO, anywhere in the path's expression), is refused:
 *   read it with readSource(rel) (test/helpers.js), which gives LF line ends on every checkout. A Windows checkout has
 *   CR LF (.gitattributes' text=auto), so a test that reads a source and matches LF passes on Linux and fails on Windows.
 *   A read for its bytes (no encoding) is not refused, nor a file the test or its server wrote (its path names none of
 *   those).
 *   A free port: a function or a variable named free…Port, pick…Port or find…Port is test/helpers.js's alone (freePort
 *   for TCP, freeUdpPort for UDP). A port one protocol finds free may be one the other cannot bind: Windows keeps
 *   excluded port ranges for each.
 * test/helpers.js, which defines both, is not held to either.
 */
const CHECKOUT = new Set(['__dirname', 'ROOT', 'REPO', 'APP']);
const PICKER = /^(?:free|pick|find)\w*Port$/i;

/** Whether an expression names the checkout anywhere in it. */
function namesCheckout(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier') return CHECKOUT.has(node.name);
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && (node.property.name === 'ROOT' || node.property.name === 'REPO')) return true;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v) ? v.some(namesCheckout) : v && typeof v.type === 'string' && namesCheckout(v)) return true;
  }
  return false;
}

/** The name a call is made by: readFileSync, or fs.readFileSync's readFileSync. */
function calleeName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
  return '';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'a test reads the checkout with readSource and finds a free port with test/helpers.js' },
    schema: [],
    messages: {
      source: 'A file of the checkout read as text: read it with readSource(rel) from test/helpers.js, which gives LF line ends on a Windows checkout too.',
      port: '"{{name}}" finds a free port: use test/helpers.js (freePort for TCP, freeUdpPort for UDP), one helper per protocol.',
    },
  },
  create(context) {
    const file = String(context.filename || '').split('\\').join('/');
    if (/(?:^|\/)test\/helpers\.js$/.test(file)) return {};
    const picker = (id) => {
      if (id && id.type === 'Identifier' && PICKER.test(id.name)) context.report({ node: id, messageId: 'port', data: { name: id.name } });
    };
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== 'readFileSync' && name !== 'readFile') return;
        if (node.arguments.length < 2 || node.arguments[1].type === 'ArrowFunctionExpression' || node.arguments[1].type === 'FunctionExpression') return;   // bytes, or readFile's callback with no encoding
        if (namesCheckout(node.arguments[0])) context.report({ node, messageId: 'source' });
      },
      'FunctionDeclaration, FunctionExpression'(node) { picker(node.id); },
      VariableDeclarator(node) { picker(node.id); },
    };
  },
};
