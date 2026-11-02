'use strict';
// The end-to-end helper itself (test/helpers.js startServer). The test files run in parallel, so a port freePort() chose
// can be taken by another file's server, or by a connection, before this server binds it. Here each port startServer is
// handed is held on purpose, by a program that is not AGMessage or by a running AGMessage, so the case is the same on
// every run.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const h = require('./helpers');

/** A program that is not AGMessage holding a port: it takes each connection and closes it, answering nothing. */
function otherProgram() {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => { /* the reader went first: nothing to answer */ }); c.end(); });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((done) => { s.close(done); }) }));
  });
}
/** A pickPort that hands out `first` in order, then fresh ports; `handed` is every port it gave. */
function picker(first) {
  const queue = [...first];
  const handed = [];
  const pickPort = async () => { const p = queue.length ? queue.shift() : await h.freePort(); handed.push(p); return p; };
  return { pickPort, handed };
}
const count = (text, part) => text.split(part).length - 1;
/** The error a start that must fail fails with. A server that starts after all is stopped first, so it outlives no test. */
async function refusal(env, opts) {
  let srv;
  try { srv = await h.startServer(env, opts); } catch (e) { return e; }
  await h.stopServer(srv.child);
  return assert.fail('the server started, on port ' + srv.port);
}

let other = null;   // a program that is not AGMessage, on its port
let holder = null;  // a running AGMessage, on its own
before(async () => { [other, holder] = await Promise.all([otherProgram(), h.startServer()]); });
after(async () => { await Promise.all([other && other.close(), holder && h.stopServer(holder.child)]); });

test('startServer: a port held by the time the server binds it, by another program or another AGMessage, is left for a fresh one', async (t) => {
  const { pickPort, handed } = picker([other.port, holder.port]);
  const srv = await h.startServer({}, { pickPort });
  t.after(() => h.stopServer(srv.child));
  assert.deepEqual(handed.slice(0, 2), [other.port, holder.port], 'it was handed both held ports first');
  assert.ok(handed.length >= 3 && handed.length <= h.START_TRIES, 'then a fresh one (another only if that was taken too): ' + handed.join(', '));
  assert.equal(srv.port, handed.at(-1), 'it serves on the last port it was handed');
  assert.equal(srv.base, `http://127.0.0.1:${srv.port}`);
  assert.ok(srv.out().includes(`Local:   http://localhost:${srv.port}`) && srv.out().includes('\n  Uploads:'), 'its banner, whole, names its own port:\n' + srv.out());
  assert.ok(!/is using port|already running on port/.test(srv.out()), 'out() is the server that serves, not a refused try:\n' + srv.out());

  const [mine, theirs] = await Promise.all([h.api(srv.base, 'GET', '/api/health'), h.api(holder.base, 'GET', '/api/health')]);
  assert.equal(mine.status, 200, 'it answers on its own port');
  assert.equal(mine.body.ok, true);
  assert.equal(theirs.status, 200, 'the AGMessage that held the port still serves on it');
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 200, 'and it is a whole server: the admin signs in');
});

test(`startServer: a port held on every try fails after ${h.START_TRIES} ports, with the server's own words`, async () => {
  assert.equal(h.START_TRIES, 5, 'the bound');
  const tries = [];
  const pickPort = async () => { tries.push(other.port); return other.port; };
  const e = await refusal({}, { pickPort });
  assert.match(e.message, /^server did not start: each of 5 ports was held by the time it bound it/);
  assert.ok(e.message.includes(`Another program is using port ${other.port}. Close it, or set PORT to another number.`), e.message);
  assert.ok(!/ is running\b/.test(e.message), 'no try served:\n' + e.message);
  assert.equal(tries.length, 5, 'five ports, then no more');
});

test('startServer: a port the test names is tried once, never moved; the refusal is the server\'s words', async () => {
  const { pickPort, handed } = picker([]);
  const e = await refusal({ PORT: String(holder.port) }, { pickPort });
  assert.match(e.message, /^server did not start:\n/);
  // The words of the flake this guards against, when the holder is another test's AGMessage.
  assert.ok(e.message.includes(`is already running on port ${holder.port}. Use its window, or close it and start this copy again.`), e.message);
  assert.equal(count(e.message, `port ${holder.port}`), 1, 'one server tried it, once:\n' + e.message);
  assert.deepEqual(handed, [], 'no other port was chosen');
  assert.equal((await h.api(holder.base, 'GET', '/api/health')).status, 200, 'the holder still serves');
});

test('startServer: a server that stops for another reason than its port fails at once, on the port it was given', async () => {
  // A data folder another server holds: the second start stops before it binds the port, and a fresh port would not help.
  const { pickPort, handed } = picker([]);
  const from = Date.now();
  const e = await refusal({ AGM_DATA_DIR: holder.dataDir }, { pickPort });
  assert.match(e.message, /^server did not start:\n/);
  assert.match(e.message, /already running on this data folder/);
  assert.equal(handed.length, 1, 'one port chosen, no retry: ' + handed.join(', '));
  assert.ok(Date.now() - from < 10000, 'it fails when the server has gone, not after the 15 s a server is given to start');
  assert.equal((await h.api(holder.base, 'GET', '/api/health')).status, 200, 'the holder still serves');
});

test('throwaway folders: a server\'s own goes when it stops (kept across restartServer); a test\'s when the test ends, after its server', async (t) => {
  const srv = await h.startServer();
  const dir = srv.dataDir;
  const beside = [dir, dir + '-keys', dir + '-uploads'];
  assert.ok(beside.every((d) => fs.existsSync(d)), 'the data, key and upload folders, while it serves');
  const again = await h.restartServer(srv);
  assert.equal(again.dataDir, dir);
  await h.stopServer(again.child);
  for (const d of beside) assert.ok(!fs.existsSync(d), d + ' went with its server, after the restart that kept it');
  await assert.rejects(h.startServer({ AGM_DATA_DIR: dir }), /went with the server that stopped on it/, 'never served again, empty');
  assert.ok(!fs.existsSync(dir), 'and not made again');

  let mine = '';
  await t.test('a test\'s folder with a server in it', async (st) => {
    mine = h.tmpDir(st, 'agm-e2e-');
    const first = await h.startServer({ AGM_DATA_DIR: mine });
    await h.stopServer(first.child);
    assert.ok(fs.existsSync(mine) && fs.existsSync(mine + '-keys'), 'a test\'s folder outlives a server stopped in it');
    const s = await h.startServer({ AGM_DATA_DIR: mine });
    // The test's hooks run in the order they were added: the folder's first, then these two.
    st.after(() => { assert.ok(fs.existsSync(mine) && fs.existsSync(mine + '-keys'), 'kept while its server runs'); });
    st.after(() => h.stopServer(s.child));
  });
  assert.ok(![mine, mine + '-keys', mine + '-uploads'].some((d) => fs.existsSync(d)), 'removed once the test ended and its last server stopped');
});
