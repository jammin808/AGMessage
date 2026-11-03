'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): cloudflared is stood in for, and its address with it. A
// spawn of cloudflared gives a child that says what cloudflared says (an address of its own, as each Quick Tunnel has,
// never one a server started before it had, then a registered connection, unless AGM_TEST_TUNNEL_QUIET is set: a
// cloudflared that words that line otherwise) and exits when it is killed; a fetch of any address it gave goes to the
// local server AGM_TEST_TUNNEL names, which stands in for the link (Cloudflare and cloudflared, out and back). Every other
// spawn and fetch is the real one. With AGM_TEST_TUNNEL_FAIL it says an error instead and exits with code 1, no address
// given (a cloudflared at a boot before the network is up); AGM_TEST_TUNNEL_KILLS names a file each kill of it is written
// to, so a test reads that a server ended it; AGM_TEST_TUNNEL_RUNS names a file each program the server asked to run as
// cloudflared is written to, one line each, as it named it (a bare name too, which this stand-in answers as well, so a
// test reads what the server asked for); and AGM_TEST_TUNNEL_CRASH (ms) raises an error nothing catches that long after
// it gave its address, so the server meets a crash with its tunnel up.
// The server's look for its own cloudflared (a stat of it) is answered too: a file is there, whatever this checkout's bin
// holds. AGM_TEST_TUNNEL_GONE says it is not: `look`, none there when looked for (a copy without its cloudflared), so
// nothing may be run; `run`, there when looked for and gone when run (an antivirus took it in between), so the run is
// the real one of a path that is not there, which says 'error' and never 'exit'. AGM_TEST_TUNNEL_LOGS names a file each
// open of a cloudflared.log is written to, one line each, so a test counts the server's reads of cloudflared's log.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const standIn = process.env.AGM_TEST_TUNNEL;
if (standIn) {
  const quiet = !!process.env.AGM_TEST_TUNNEL_QUIET;
  const fail = !!process.env.AGM_TEST_TUNNEL_FAIL;
  const kills = process.env.AGM_TEST_TUNNEL_KILLS;
  const runs = process.env.AGM_TEST_TUNNEL_RUNS;
  const crashMs = Number(process.env.AGM_TEST_TUNNEL_CRASH) || 0;
  const gone = process.env.AGM_TEST_TUNNEL_GONE || '';
  const logs = process.env.AGM_TEST_TUNNEL_LOGS;
  const ADDRESS_RE = /^https:\/\/agm-test-link-\d+\.trycloudflare\.com/;
  const CLOUDFLARED_RE = /cloudflared(\.exe)?$/i;
  const statSync = fs.statSync;
  /** Where a cloudflared that is not there is run: a folder under the temp folder that is never made. */
  const NOWHERE = path.join(os.tmpdir(), 'agm-no-such-folder-' + process.pid, 'cloudflared');
  fs.statSync = (file, ...rest) => {
    if (!CLOUDFLARED_RE.test(String(file))) return statSync(file, ...rest);
    if (gone !== 'look') return statSync(process.execPath, ...rest);   // a file, standing for cloudflared
    if (rest[0] && rest[0].throwIfNoEntry === false) return undefined;
    throw Object.assign(new Error('ENOENT: no such file or directory, stat \'' + file + '\''), { code: 'ENOENT' });
  };
  if (logs) {
    const openSync = fs.openSync;
    fs.openSync = (file, ...rest) => {
      if (/cloudflared\.log$/.test(String(file))) fs.appendFileSync(logs, String(file) + '\n');
      return openSync(file, ...rest);
    };
  }
  let spawned = 0;
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (!CLOUDFLARED_RE.test(String(command))) return spawn(command, args, options);
    if (runs) fs.appendFileSync(runs, String(command) + '\n');
    if (gone) return spawn(NOWHERE, args, options);
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
