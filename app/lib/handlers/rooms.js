'use strict';
/**
 * The verbs on a hall's rooms: making and naming them, their settings, which rooms may send into them, a message sent
 * from one room into another and taken back, and a room's earlier messages. They are registered by the connection
 * (server.js), after its own verbs, on every page's socket but a screen's.
 *
 * Each verb is a literal listener on `socket` whose first statement is its one gate call,
 * `if (!conn.gate(ack, {…})) return;` (lib/gate.js), its `ack` the listener's own last argument, naming one of the
 * connection's buckets (`conn.writes`, `conn.chatter`) or saying `bucket: null` with why on its line
 * (test/modules.test.js (i)). Of the connection it reads `conn`: its room and person read when asked, so no verb holds a
 * room its page has left, its answers and its rights' questions (never `rbac.can`). Of the server it reads `ctx`, once,
 * destructured on the function's first line, which is the module's list of what it reaches: the stores and their named
 * effects, `settings` to read and never to write ((j)), and `io` for a room's broadcast. It requires only the pure core,
 * guard's pure helpers and ids, by a literal path, and makes nothing it requires ((d)).
 */

/**
 * @param {object} socket a page's socket (never a screen's), its listeners guarded (server.js `guardHandlers`)
 * @param {object} conn   the connection's context, frozen
 * @param {object} ctx    the server's context, frozen (lib/gate.js `contexts`)
 */
// eslint-disable-next-line no-unused-vars -- the seam's three arguments, each read by the verbs registered here
function register(socket, conn, ctx) {
  // The room verbs register here, each behind its gate.
}

module.exports = { register };
