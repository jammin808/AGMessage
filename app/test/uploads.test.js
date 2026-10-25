'use strict';
// Uploads are bounded: the rate per connection and per address (a re-join or more sockets refill nothing), a floor of
// free disk space below which files pause before anything is written (so the room logs, the audit log and the saves
// always have room), files nobody posted removed after a while, and files a reset or a deletion cleared removed from
// the disk — unless another hall or a screen still shows them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, stopServer, api, connect, emit, until, TOKEN } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const form = (name, bytes) => { const f = new FormData(); f.append('file', new Blob([bytes], { type: 'text/plain' }), name); return f; };
const upload = (base, token, name = 'notes.txt', bytes = 'Capex was 4.2m') => fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: form(name, bytes) });
const files = (dir) => fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();

async function hallServer(t, env = {}) {
  const uploads = tmp('agm-up-');
  const srv = await startServer({ AGM_UPLOAD_DIR: uploads, ...env });
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(srv.base, 'POST', '/api/admin/login', { token: TOKEN })).cookie;
  const hall = async (name) => (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const guest = async (code, name, extra = {}) => {
    const s = await connect(srv.base, extra.cookie); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name, role: 'research', ...extra.join });
    assert.ok(j.ok, JSON.stringify(j));
    return { s, j };
  };
  return { srv, uploads, admin, hall, guest, sockets };
}

test('a re-join does not refill the upload rate, and several sockets from one address share one', async (t) => {
  const { srv, hall, guest } = await hallServer(t);
  const code = await hall('Hall 1');
  const { s, j } = await guest(code, 'Ana');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await upload(srv.base, j.uploadToken)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 429], 'four at once, then slow down');
  const again = await emit(s, 'join', { roomCode: code, name: 'Ana', role: 'research', uid: j.identity });
  assert.ok(again.uploadToken && again.uploadToken !== j.uploadToken, 'a new token for the new join');
  assert.equal((await upload(srv.base, again.uploadToken)).status, 429, 'the same connection: the same rate');

  // Four more sockets from this address, each with its own token: together they get the address's share, not 4 each.
  const more = [];
  for (let i = 0; i < 4; i++) more.push((await guest(code, 'Guest ' + i)).j.uploadToken);
  const statuses = [];
  for (const tok of more) for (let k = 0; k < 4; k++) statuses.push((await upload(srv.base, tok)).status);
  const accepted = statuses.filter((x) => x === 200).length;
  assert.ok(accepted <= 8, 'one address shares one upload rate, not four each: ' + statuses.join(' '));
  assert.ok(statuses.includes(429));
});

test('below the free-space floor files pause before anything is written', async (t) => {
  const { srv, uploads, hall, guest } = await hallServer(t, { AGM_UPLOAD_MIN_FREE: '1e15' });
  const { j } = await guest(await hall('Hall 1'), 'Ana');
  const r = await upload(srv.base, j.uploadToken);
  assert.equal(r.status, 507);
  assert.match((await r.json()).error, /disk space/);
  assert.deepEqual(files(uploads), [], 'nothing reached the folder');
});

test('a reset or a deletion removes the hall\'s files from the disk, except those another hall or a screen still shows', async (t) => {
  const { srv, uploads, admin, hall, guest } = await hallServer(t);
  const a = await hall('Hall A');
  const b = await hall('Hall B');
  const ga = await guest(a, 'Ana');
  const gb = await guest(b, 'Ben');
  const put = async (name, bytes = 'text of ' + name) => {
    const url = (await (await upload(srv.base, ga.j.uploadToken, name, bytes)).json()).url;
    const m = await emit(ga.s, 'message', { type: 'file', url, filename: name });
    assert.ok(m.ok, JSON.stringify(m));
    return { url, id: m.id };
  };
  const shared = await put('shared.txt');
  const own = await put('own.txt');
  const holding = await put('holding.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const deleted = await put('deleted.txt');
  assert.ok((await emit(gb.s, 'message', { type: 'file', url: shared.url, filename: 'shared.txt' })).ok, 'hall B shares one of them');
  const adm = await connect(srv.base, admin);
  t.after(() => adm.close());
  assert.ok((await emit(adm, 'display:hallHolding', { code: b, image: holding.url })).ok, 'hall B\'s screens hold on another');
  const onDisk = (u) => files(uploads).some((f) => u.url.endsWith(f));

  assert.ok((await emit(adm, 'admin:deleteMessage', { roomCode: a, messageId: deleted.id })).ok);
  assert.equal((await fetch(srv.base + deleted.url)).status, 404, 'a deleted file message takes its file with it');
  assert.ok(!onDisk(deleted));

  assert.ok((await emit(adm, 'admin:resetRoom', { roomCode: a })).ok);
  assert.equal((await fetch(srv.base + own.url)).status, 404, 'hall A\'s own file is gone after the reset');
  assert.ok(!onDisk(own), 'from the disk too');
  assert.equal((await fetch(srv.base + shared.url)).status, 200, 'the file hall B shares is still served');
  assert.equal((await fetch(srv.base + holding.url)).status, 200, 'and so is the one hall B\'s screens hold on');
  assert.ok(onDisk(shared) && onDisk(holding));
});

test('a file nobody posted is removed after a while; a posted one stays', async (t) => {
  const { srv, uploads, hall, guest } = await hallServer(t, { AGM_UPLOAD_ORPHAN_MS: '400' });
  const { s, j } = await guest(await hall('Hall 1'), 'Ana');
  const posted = await (await upload(srv.base, j.uploadToken, 'posted.txt')).json();
  const orphan = await (await upload(srv.base, j.uploadToken, 'orphan.txt')).json();
  assert.ok((await emit(s, 'message', { type: 'file', url: posted.url, filename: 'posted.txt' })).ok);
  assert.equal(files(uploads).length, 2);
  await until(() => files(uploads).length === 1, 5000, 'the orphan removed');
  assert.ok(posted.url.endsWith(files(uploads)[0]), 'the posted file stays');
  assert.equal((await fetch(srv.base + orphan.url)).status, 404);
});
