'use strict';
/**
 * The verbs of takes on people's pages: a push to a person's page or to everyone On stage, what a page reports it shows,
 * the admin's read of it, and the views, clock and On stage settings the admin sets for a person. They are registered by
 * the connection (server.js), after its own verbs, on every page's socket but a screen's: the admin's verbs among them
 * are sent from the admin page.
 *
 * A take reaches a page and nothing else: never a room's op, never a room's broadcast. So this module is given the takes
 * context, which holds none of the server's parts that make a room's op or send to a room (`io`, `apply`,
 * `systemMessage`: lib/gate.js `ROOM_SENDS`), and reaches a page through `ctx.sendTo(socketIds, event, payload)`, which
 * sends only to a socket open now named by its id (a hall's key given as one reaches nobody). It names none of the
 * server's broadcast paths nor the socket's own, joins its socket to no room, reads the room store only through its
 * readers (its `room`, `hasRoom`, `get`, …) and never takes the store or the socket under another name
 * (test/modules.test.js (j)).
 *
 * Each verb is a literal listener on `socket` whose first statement is its one gate call,
 * `if (!conn.gate(ack, {…})) return;` (lib/gate.js), its `ack` the listener's own last argument, naming one of the
 * connection's buckets or saying `bucket: null` with why on its line ((i)). Of the connection it reads `conn` (its room
 * and person read when asked, its answers, its rights' questions: never `rbac.can`); of the server, `ctx`, once,
 * destructured on the function's first line, `settings` to read and never to write ((j)). It requires only the pure
 * core, guard's pure helpers, ids and the pages' pure vocabulary (`lib/pages.js` by name), by a literal path, and makes
 * nothing it requires ((d)).
 */

/**
 * @param {object} socket a page's socket (never a screen's), its listeners guarded (server.js `guardHandlers`)
 * @param {object} conn   the connection's context, frozen
 * @param {object} ctx    the takes context, frozen: no io, apply or systemMessage (lib/gate.js `contexts`)
 */
// eslint-disable-next-line no-unused-vars -- the seam's three arguments, each read by the verbs registered here
function register(socket, conn, ctx) {
  // The take verbs register here, each behind its gate.
}

module.exports = { register };
