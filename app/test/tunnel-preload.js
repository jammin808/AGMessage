'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): cloudflared is stood in for, and its address with it. A
// spawn of cloudflared gives a child that says what cloudflared says (an address of its own, as each Quick Tunnel has,
// never one a server started before it had, then a registered connection, unless AGM_TEST_TUNNEL_QUIET is set: a
// cloudflared that words that line otherwise) and exits when it is killed; a fetch of any address it gave goes to the
// local server AGM_TEST_TUNNEL names, which stands in for the link (Cloudflare and cloudflared, out and back). Every other
// spawn and fetch is the real one. With AGM_TEST_TUNNEL_FAIL it says an error instead and exits with code 1, no address
// given (a cloudflared at a boot before the network is up); AGM_TEST_TUNNEL_KILLS names a file each kill of it is written
// to, so a test reads that a server ended it; and AGM_TEST_TUNNEL_CRASH (ms) raises an error nothing catches that long
// after it gave its address, so the server meets a crash with its tunnel up.
const childProcess = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

const standIn = process.env.AGM_TEST_TUNNEL;
if (standIn) {
  const quiet = !!process.env.AGM_TEST_TUNNEL_QUIET;
  const fail = !!process.env.AGM_TEST_TUNNEL_FAIL;
  const kills = process.env.AGM_TEST_TUNNEL_KILLS;
  const crashMs = Number(process.env.AGM_TEST_TUNNEL_CRASH) || 0;
  const ADDRESS_RE = /^https:\/\/agm-test-link-\d+\.trycloudflare\.com/;
  let spawned = 0;
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (!/cloudflared(\.exe)?$/i.test(String(command))) return spawn(command, args, options);
    const address = 'https://agm-test-link-' + (process.pid * 1000 + (++spawned)) + '.trycloudflare.com';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal = 'SIGTERM') => {
      if (kills) fs.appendFileSync(kills, process.pid + ' ' + signal + '\n');
      setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    if (fail) {
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('ERR Error requesting new tunnel: dial tcp: lookup api.trycloudflare.com: no such host\n'));
        child.emit('exit', 1, null);
      }, 300);
      return child;
    }
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  ' + address + '  |\n'));
      if (!quiet) setImmediate(() => { child.stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0 location=test protocol=quic\n')); });
      if (crashMs) setTimeout(() => { throw new Error('a crash under test, with the tunnel up'); }, crashMs);
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
