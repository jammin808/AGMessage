'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): cloudflared is stood in for, and its address with it. A
// spawn of cloudflared gives a child that says what cloudflared says (an address of its own, as each Quick Tunnel has,
// then a registered connection, unless AGM_TEST_TUNNEL_QUIET is set: a cloudflared that words that line otherwise) and
// exits when it is killed; a fetch of any address it gave goes to the local server AGM_TEST_TUNNEL names, which stands in
// for the link (Cloudflare and cloudflared, out and back). Every other spawn and fetch is the real one.
const childProcess = require('child_process');
const { EventEmitter } = require('events');

const standIn = process.env.AGM_TEST_TUNNEL;
if (standIn) {
  const quiet = !!process.env.AGM_TEST_TUNNEL_QUIET;
  const ADDRESS_RE = /^https:\/\/agm-test-link-\d+\.trycloudflare\.com/;
  let spawned = 0;
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (!/cloudflared(\.exe)?$/i.test(String(command))) return spawn(command, args, options);
    const address = 'https://agm-test-link-' + (++spawned) + '.trycloudflare.com';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('exit', 0, 'SIGTERM')); return true; };
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  ' + address + '  |\n'));
      if (!quiet) setImmediate(() => { child.stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0 location=test protocol=quic\n')); });
    });
    return child;
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    const m = u.match(ADDRESS_RE);
    return realFetch(m ? standIn + u.slice(m[0].length) : url, init);
  };
}
