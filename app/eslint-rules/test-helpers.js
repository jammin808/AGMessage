'use strict';
/**
 * agm/test-helpers — a test reads the checkout's files, and finds a free port, through test/helpers.js.
 *
 *   A file of the checkout read as text: fs.readFileSync (or a readFile) given an encoding, whose path names the checkout
 *   (__dirname, a name ROOT, REPO or APP, or a member .ROOT or .REPO, anywhere in the path's expression, or in what a
 *   name in it was made from: a const's initialiser or a parameter's default, a few steps deep), is refused:
 *   read it with readSource(rel) (test/helpers.js), which gives LF line ends on every checkout. A Windows checkout has
 *   CR LF (.gitattributes' text=auto), so a test that reads a source and matches LF passes on Linux and fails on Windows.
 *   A read for its bytes (no encoding) is not refused, nor a file the test or its server wrote (its path names none of
 *   those).
 *   A free port: a function or a variable named free…Port, pick…Port or find…Port (freePort, findUdpPort; never
 *   findExport) is test/helpers.js's alone (freePort for TCP, freeUdpPort for UDP). A port one protocol finds free may be one the other cannot bind: Windows keeps
 *   excluded port ranges for each.
 * test/helpers.js, which defines both, is not held to either.
 */
const CHECKOUT = new Set(['__dirname', 'ROOT', 'REPO', 'APP']);
const PICKER = /^(?:free|pick|find)[A-Z]?\w*Port$/;
/** How many names deep a path is followed back to what it was made from. */
const DEPTH = 4;

/** The variable a name refers to where it is used, from the innermost scope out. */
function variableOf(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name);
    if (v) return v;
  }
  return null;
}

/** What a name was made from: a const's (or let's) initialiser, or a parameter's default; null for anything else. */
function madeFrom(variable) {
  for (const def of variable ? variable.defs : []) {
    if (def.type === 'Variable' && def.node.init && def.node.id === def.name) return def.node.init;
    if (def.type === 'Parameter' && def.name.parent && def.name.parent.type === 'AssignmentPattern' && def.name.parent.left === def.name) return def.name.parent.right;
  }
  return null;
}

/** The calls a path is joined by: path.join, path.resolve, path.normalize (or those names alone). */
const JOINS = new Set(['join', 'resolve', 'normalize']);

/**
 * Whether a path expression names the checkout, followed only through what makes a path: a name (back to what it was
 * made from, DEPTH names deep), a member's object, path.join/resolve/normalize's arguments, + and a template's parts,
 * either side of ?: || ??. Any other call (a temporary folder, a server started) makes a path of its own, never the
 * checkout's, and a function's body is never read.
 */
function namesCheckout(node, scope, seen = new Set(), depth = 0) {
  const on = (n) => namesCheckout(n, scope, seen, depth);
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'Identifier': {
      if (CHECKOUT.has(node.name)) return true;
      const v = variableOf(scope, node.name);
      if (!v || seen.has(v) || depth >= DEPTH) return false;
      seen.add(v);
      return namesCheckout(madeFrom(v), scope, seen, depth + 1);
    }
    case 'MemberExpression':
      if (!node.computed && node.property.type === 'Identifier' && (node.property.name === 'ROOT' || node.property.name === 'REPO')) return true;
      return on(node.object);
    case 'CallExpression': {
      const c = node.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
      return JOINS.has(name) && node.arguments.some(on);
    }
    case 'BinaryExpression': return node.operator === '+' && (on(node.left) || on(node.right));
    case 'TemplateLiteral': return node.expressions.some(on);
    case 'ConditionalExpression': return on(node.consequent) || on(node.alternate);
    case 'LogicalExpression': return on(node.left) || on(node.right);
    default: return false;
  }
}

/** Whether a read's second argument asks for text: 'utf8', 'utf-8' or {encoding: 'utf8'}, or one not written out; latin1, base64 and the rest read bytes as characters, never a source's lines. */
function asksText(arg) {
  const literal = (n) => n && n.type === 'Literal' && typeof n.value === 'string';
  if (literal(arg)) return /^utf-?8$/i.test(arg.value);
  if (arg.type === 'ObjectExpression') {
    const enc = arg.properties.find((p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.key.name === 'encoding');
    return !enc || !literal(enc.value) || /^utf-?8$/i.test(enc.value.value);
  }
  return true;
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
        if (!asksText(node.arguments[1])) return;
        if (namesCheckout(node.arguments[0], context.sourceCode.getScope(node))) context.report({ node, messageId: 'source' });
      },
      'FunctionDeclaration, FunctionExpression'(node) { picker(node.id); },
      VariableDeclarator(node) { picker(node.id); },
    };
  },
};
