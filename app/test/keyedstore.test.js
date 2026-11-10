'use strict';
// The keyed stores (lib/keyedstore.js, the 0.6.0 plan's 3-K): each file keyed whole, each sign-in by its keyed hash, every
// save recorded outside the data folder, and what a start decides of a folder, in-process with the fixture keys (no
// test reaches a real key folder). The server's end of it is test/keyedsignins.test.js.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ks = require('../lib/keyedstore');
const acc = require('../lib/accounts');
const secretbox = require('../lib/secretbox');
const { WriteLane } = require('../lib/resilience');
const { openStores, storesKeys, storesKid, storesOf, readSource, FIXTURE_KEY, OTHER_KEY } = require('./helpers');

const tmp = (p = 'agm-ks-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (f) => fs.readFileSync(f, 'utf8');
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const PW = 'the green room kettle';
const K = storesKeys(FIXTURE_KEY)();
const KID = storesKid(FIXTURE_KEY);
/** A 0.5.1 account record, its hash in the public form hashPassword writes. */
async function plainUser(id, username, role, more = {}) {
  return { id, username, name: username, role, halls: [], grant: [], revoke: [], disabled: false, mustChange: false, pw: await acc.hashPassword(PW), pwSetAt: 1, epoch: 1, createdAt: 1, createdBy: '', lastLoginAt: 0, ...more };
}
/** A store's file sealed under the fixture's keys, as a key holder could write one. */
function sealed(name, fields, head = {}, { key = K, indent } = {}) {
  return ks.sealText(key[name], ks.LABELS[name], { v: 2, store: name, set: 'a'.repeat(32), gen: 1, kid: KID, at: Date.now(), ...head }, fields, indent).text;
}
/** A folder with an admin and a Staff account, saved and recorded: {dir, st, admin, staff}. */
async function seeded(dir = tmp()) {
  const st = openStores(dir);
  const admin = (await st.accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: PW })).account;
  const staff = (await st.accounts.create({ username: 'sam', name: 'Sam', role: 'staff', password: PW })).account;
  st.flush();
  return { dir, st, admin, staff };
}

test('a file is keyed whole: its MAC is over its bytes, so a changed byte, a repeated key or an added space fails, and each store has its own key', () => {
  const text = sealed('accounts', { users: [] });
  assert.match(text, /,"m":"[0-9a-f]{64}"\}$/, 'the file ends with its MAC in place of the body\'s last }');
  assert.ok(ks.checkText(K.accounts, ks.LABELS.accounts, text));
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ['v', 'store', 'set', 'gen', 'kid', 'at', 'users', 'm'], 'the save\'s fields first, its MAC last');
  for (const changed of [text.replace('"users":[]', '"users":[ ]'), text.replace('"store":"accounts"', '"store":"accounts","store":"accounts"'), text.replace('"gen":1', '"gen":2'), text + '\n', text.replace(/,"m":"[0-9a-f]{64}"\}$/, '}')]) {
    assert.equal(ks.checkText(K.accounts, ks.LABELS.accounts, changed), '', 'fails: ' + changed.slice(0, 80));
  }
  // Domain separation: a file sealed under another store's key, or another label, never checks.
  assert.equal(ks.checkText(K.sessions, ks.LABELS.sessions, text), '', 'an accounts file is no sessions file');
  assert.equal(ks.checkText(K.accounts, ks.LABELS.sessions, text), '');
  assert.equal(ks.checkText(K.accounts, ks.LABELS.accounts, sealed('accounts', { users: [] }, {}, { key: { accounts: K.sessions } })), '', 'sealed with Ks: fails as an accounts file');
  assert.equal(ks.checkText(K.accounts, ks.LABELS.accounts, 42), '');
  // The five labels are secretbox's to derive, each its own key.
  assert.deepEqual(new Set(Object.values(ks.LABELS).map((l) => secretbox.deriveFrom(FIXTURE_KEY, l).toString('hex'))).size, 5);
  assert.throws(() => secretbox.deriveFrom(FIXTURE_KEY, 'agmessage something else v1'), /no key is derived/);
});

test('the stores refuse to start without their keyed store, and nothing is read or written before open()', () => {
  const dir = tmp();
  for (const make of [() => new acc.Accounts(path.join(dir, 'a.json')), () => new acc.Sessions(path.join(dir, 's.json'), {}), () => new acc.TokenSessions(path.join(dir, 't.json'), { token: 'x' })]) {
    assert.throws(make, /keyed store/);
  }
  assert.throws(() => new ks.KeyedStores({ records: '', dataDir: dir, keys: () => K }), /keys, their records folder and the data folder/);
  fs.writeFileSync(path.join(dir, 'accounts.json'), sealed('accounts', { users: [] }));
  const st = openStores(dir, { open: false });
  assert.equal(st.accounts.size, 0, 'empty until open()');
  st.accounts.users.set('x', { id: 'x' });
  st.accounts.save({ twice: true });
  st.accounts.flush();
  assert.equal(st.accounts.lane.writes, 0, 'no save before open()');
  assert.ok(!fs.existsSync(storesOf(dir)), 'no record either');
});

test('a sign-in is kept by its keyed hash: neither the token nor its SHA-256 is in the file, a hash of another kind never resolves, and a sign-in stamped ahead is dropped', async () => {
  const { dir, st, admin } = await seeded();
  const token = st.sessions.create(admin);
  const sid = st.tokens.create();
  st.flush();
  for (const [file, secret] of [['sessions.json', token], ['admin-sessions.json', sid]]) {
    const text = read(path.join(dir, file));
    for (const v of [secret, sha256(secret), Buffer.from(secret).toString('base64')]) assert.ok(!text.includes(v), file + ' holds no ' + v.slice(0, 8));
  }
  assert.equal(st.sessions.hashOf(token), st.ks.idHash('session', token));
  assert.notEqual(st.ks.idHash('token sign-in', token), st.sessions.hashOf(token), 'a hash made with the kind "token sign-in" is not a session\'s');
  assert.equal(st.sessions.touch(st.ks.idHash('token sign-in', token)), null);
  assert.equal(st.tokens.tag.length, 64, 'the token\'s tag, keyed with Kt');
  assert.ok(!read(path.join(dir, 'admin-sessions.json')).includes('testadmintoken01'));
  // A record a key holder wrote with `seen` ten minutes ahead of now is dropped at load, and one five minutes behind kept.
  const now = Date.now();
  const rec = (h, ahead) => ({ h, uid: admin.id, epoch: admin.epoch, created: now - 1000, seen: now + ahead, ip: '', ua: '' });
  const set = JSON.parse(read(path.join(dir, 'accounts.json'))).set;
  const gen = st.ks.parts.sessions.landed.gen + 1;
  fs.writeFileSync(path.join(dir, 'sessions.json'), sealed('sessions', { sessions: [rec('a'.repeat(64), 10 * 60_000), rec('b'.repeat(64), -1000)] }, { set, gen }));
  const again = openStores(dir);
  assert.deepEqual([...again.sessions.map.keys()], ['b'.repeat(64)], 'the one stamped ahead is dropped');
  assert.equal(again.ks.report().sessions.state, 'ok');
});

test('the first start of 0.6.0 on 0.5.1 files: the accounts that reach only their halls are keyed as found, those that can manage AGMessage or reach past their halls wait, and 0.5.1\'s sign-ins end', async () => {
  const dir = tmp();
  const users = [await plainUser('aana0000001', 'ana', 'admin'), await plainUser('asam0000001', 'sam', 'staff'), await plainUser('alou0000001', 'lou', 'staff'), await plainUser('amia0000001', 'mia', 'manager')];
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ v: 1, sessions: [{ h: sha256('old-token'), uid: 'aana0000001', epoch: 1, created: Date.now(), seen: Date.now(), ip: '', ua: '' }] }));
  fs.writeFileSync(path.join(dir, 'admin-sessions.json'), JSON.stringify({ v: 1, k: 'zKx0WvWIlqu2Q3U0rO0h1d', sessions: [{ h: sha256('old-sid'), created: Date.now() }] }));
  const st = openStores(dir);
  assert.deepEqual([...st.accounts.users.values()].map((u) => u.username).sort(), ['lou', 'sam'], 'the Staff accounts open at once');
  assert.ok(await st.accounts.authenticate('sam', PW).then((r) => !!r.account), 'and sign in with their passwords');
  assert.deepEqual(st.ks.heldFacts(), { state: 'first', waiting: 2, words: ks.FIRST_WORDS });
  assert.ok(st.ks.waits('ana') && st.ks.waits('mia') && !st.ks.waits('sam'), 'the admin and the manager wait');
  st.flush();
  const text = read(path.join(dir, 'accounts.json'));
  assert.equal(JSON.parse(text).v, 2);
  assert.ok(ks.checkText(K.accounts, ks.LABELS.accounts, text), 'its MAC checks with the fixture key');
  assert.deepEqual(JSON.parse(text.slice(0, -72) + '}').users.map((u) => u.username).sort(), ['lou', 'sam'], 'the bytes before the tail are the keyed users');
  const rows = Object.fromEntries(st.rows.map((r) => [r.action + ':' + r.target, r.words]));
  assert.match(rows['accounts.keyed:accounts'], /^4 accounts from AGMessage 0\.5\.1 keyed as accounts\.json held them; waiting for the token: ana, mia$/);
  assert.match(rows['accounts.held:accounts'], /wait for the token \(copy kept as accounts\.held-.*\.json\): ana, mia$/);
  assert.equal(rows['signins.ended:sessions'], '1 sign-in ended: from AGMessage 0.5.1');
  assert.equal(rows['signins.ended:adminSessions'], '1 sign-in ended: from AGMessage 0.5.1');
  assert.equal(st.sessions.resolve('old-token'), null, '0.5.1\'s cookie is nobody');
  assert.ok(fs.existsSync(path.join(storesOf(dir), 'keyed.json')), 'keyed.json says this laptop has keyed');
  assert.match(st.ks.lines.join('\n'), /4 accounts from AGMessage 0\.5\.1 are keyed to this laptop from here on[\s\S]*2 that can manage AGMessage or reach past their halls wait for you: ana, mia[\s\S]*Sign-ins from 0\.5\.1 have ended/);
  // The held copy is 0.5.1's file byte for byte; the panel lists the waiting ones with no one-time password, and the open ones.
  const view = st.ks.heldView([...st.accounts.users.values()], acc.Accounts.view);
  assert.equal(read(path.join(dir, view.file)), JSON.stringify({ v: 1, users }, null, 1));
  assert.deepEqual(view.accounts.map((a) => [a.username, a.adopt, a.confirm, a.reset, a.mark]), [['ana', false, true, false, 'new'], ['mia', true, false, false, 'new']]);
  assert.ok(view.accounts.every((a) => !('pw' in a)), 'never a hash');
  assert.deepEqual(view.open, ['lou', 'sam']);
  // A restart keeps them waiting, from the same copy.
  const again = openStores(dir);
  assert.deepEqual([again.ks.heldFacts().state, again.ks.heldFacts().waiting, again.ks.hold.file], ['first', 2, view.file]);
  // One tick each and the token open them: no one-time password at the first start.
  const j = again.ks.judgeAdoption({ digest: view.digest, adopt: [{ id: 'aana0000001' }, { id: 'amia0000001' }], confirm: ['aana0000001'], keep: [] }, [...again.accounts.users.values()]);
  assert.equal(j.rows.length, 2, JSON.stringify(j));
  const made = await again.accounts.prepareAdoption(j.rows);
  again.accounts.take(made.accounts);
  assert.deepEqual(again.ks.adopted([...again.accounts.users.values()]), { left: 0, file: view.file, why: '' });
  again.accounts.save({ twice: true });
  again.accounts.flush();
  assert.equal(again.ks.heldFacts(), null, 'nothing held now');
  assert.ok(await again.accounts.authenticate('ana', PW).then((r) => !!r.account), 'the admin signs in with its own password');
  // A second plain folder at another path on this key folder: plain ✕, held whole, never keyed as found.
  const other = tmp();
  fs.writeFileSync(path.join(other, 'accounts.json'), JSON.stringify({ v: 1, users: [users[1]] }));
  const two = openStores(other, { records: storesOf(dir) });
  assert.deepEqual([two.ks.report().accounts.state, two.accounts.size, two.ks.heldFacts().state], ['plain', 0, 'plain']);
});

test('a stop between the stores\' writes and their records: the next start reads unrecorded △ and loads, never plain', async () => {
  const { dir } = await seeded();
  fs.rmSync(storesOf(dir), { recursive: true, force: true });
  const st = openStores(dir);
  assert.deepEqual([st.ks.report().accounts.state, st.accounts.size], ['unrecorded', 2]);
  assert.match(st.ks.report().accounts.words, /^no record of this folder's saves outside the data folder/);
  st.flush();
  assert.equal(openStores(dir).ks.report().accounts.state, 'ok', 'the records are written again');
});

test('accounts.json written into: held aside whole as changed, the copy kept byte for byte, no first admin made, and the genuine sign-ins kept, not loaded, until an adoption', async () => {
  const { dir, st, admin } = await seeded();
  const token = st.sessions.create(admin);
  st.flush();
  const file = path.join(dir, 'accounts.json');
  const sessionsBefore = read(path.join(dir, 'sessions.json'));
  const minted = await plainUser('aeve0000001', 'eve', 'admin');
  const text = read(file).replace('"users": [', '"users": [\n  ' + JSON.stringify(minted) + ',');
  fs.writeFileSync(file, text);
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.size, b.ks.signInRefusal()], ['changed', 0, ks.HELD_WORDS]);
  assert.match(b.ks.report().accounts.words, /^accounts\.json was changed after AGMessage saved it \(kept aside as accounts\.held-.*\.json\)$/);
  assert.equal(read(path.join(dir, b.ks.hold.file)), text, 'the held copy is what was read');
  assert.equal(b.rows.find((r) => r.action === 'accounts.held').words, b.ks.report().accounts.words);
  assert.match((await b.accounts.create({ username: 'zed', role: 'admin', password: PW }, 'setup', { firstAdmin: true })).error, /Adopt the accounts held aside/);
  assert.match(b.ks.setupRefusal(), /Adopt the accounts held aside/);
  // The sign-ins of the untouched sessions.json: kept, never resolved, touched, swept or saved while the accounts are held.
  assert.equal(b.ks.report().sessions.state, 'ok');
  assert.equal(b.sessions.resolve(token), null);
  b.sessions.sweep(new Set([b.sessions.hashOf(token)]));
  b.flush();
  assert.equal(read(path.join(dir, 'sessions.json')), sessionsBefore, 'still in the file as it was');
  assert.equal(read(file), text, 'and accounts.json is not written over');
  // The panel: the added account unticked, with its confirmation and its one-time password ticked; the others as this
  // laptop last saved them, ticked, no one-time password.
  const view = b.ks.heldView([], acc.Accounts.view);
  const row = (u) => view.accounts.find((a) => a.username === u);
  assert.deepEqual([row('eve').mark, row('eve').adopt, row('eve').confirm, row('eve').reset], ['new', false, true, true]);
  assert.deepEqual([row('ana').mark, row('ana').adopt, row('ana').confirm, row('ana').reset], ['saved', true, false, false]);
  // The refusals: a stale digest, an id not in the copy, an admin without its confirmation, a one-time password unticked
  // without `keep`.
  const ask = (o) => b.ks.judgeAdoption({ digest: view.digest, adopt: [], confirm: [], keep: [], ...o }, []);
  assert.match(ask({ digest: 'f'.repeat(64) }).error, /changed since you read it/);
  assert.match(ask({ adopt: [{ id: 'nobody' }] }).error, /not in the copy/);
  assert.match(ask({ adopt: [{ id: minted.id, reset: true }] }).error, /eve can manage AGMessage: confirm it/);
  assert.match(ask({ adopt: [{ id: minted.id }], confirm: [minted.id] }).error, /copy's own claim/);
  // Adopted as it was in the same run, ana's sign-in lives again.
  const j = ask({ adopt: [{ id: admin.id }] });
  const made = await b.accounts.prepareAdoption(j.rows);
  b.accounts.take(made.accounts);
  assert.deepEqual(b.ks.adopted([...b.accounts.users.values()]).left, 2);
  b.accounts.save({ twice: true });
  b.sessions.restoreKept();
  assert.equal(b.sessions.resolve(token).account.username, 'ana', 'adopted as it was: its sign-in works again');
  assert.equal(b.ks.heldFacts().state, 'left');
  assert.match(b.ks.heldFacts().words, /^2 accounts were left out on \d+ \w+ and are kept aside: the token at the laptop may adopt them$/);
  b.flush();
  // A restart: ana open, the two left out offered again from the same copy.
  const c = openStores(dir);
  assert.deepEqual([c.ks.report().accounts.state, c.accounts.size, c.ks.heldFacts().state, c.ks.heldFacts().waiting], ['ok', 1, 'left', 2]);
  // Leave the rest out: the hold ends, its copy stays.
  c.ks.adopted([...c.accounts.users.values()], { leaveRest: true });
  assert.equal(c.ks.heldFacts(), null);
  assert.ok(fs.existsSync(path.join(dir, view.file)));
});

test('one save behind loads △, two or below the floor of a change that took a right away reads older ✕; a save that takes a right away is written twice and recorded at once', async () => {
  const { dir, st, admin } = await seeded();
  // Made an admin, then made Staff: the .bak holds the demotion.
  st.accounts.update(admin.id, { role: 'staff' });
  st.flush();
  const file = path.join(dir, 'accounts.json');
  const head = JSON.parse(read(path.join(storesOf(dir), 'set-' + st.ks.set + '.json')));
  assert.equal(head.accounts.floor, head.accounts.gen - 1, 'the floor is the first write of the change');
  fs.copyFileSync(file + '.bak', file);
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.byUsername('ana').role], ['behind', 'staff']);
  assert.match(b.rows.find((r) => r.action === 'accounts.behind').words, /^one save behind \(\d+ of \d+\)$/);
  b.accounts.signedIn(b.accounts.byUsername('sam'));
  b.flush();
  assert.equal(JSON.parse(read(file)).gen, head.accounts.gen + 1, 'after a behind load the next save is the record\'s plus one');
  // Two saves old: older ✕, held.
  const old = read(file);
  const c = openStores(dir);
  c.accounts.signedIn(c.accounts.byUsername('sam')); c.flush();
  c.accounts.signedIn(c.accounts.byUsername('sam')); c.flush();
  fs.writeFileSync(file, old);
  const d = openStores(dir);
  assert.deepEqual([d.ks.report().accounts.state, d.accounts.size], ['older', 0]);
  assert.match(d.ks.report().accounts.words, /^accounts\.json is an older save \(\d+; this laptop recorded \d+\), put back from a copy/);
});

test('a demotion\'s first write landed and the process ended before its second: the record already names its floor, and the save before it put back reads older', async () => {
  const { dir, st, admin } = await seeded();
  const file = path.join(dir, 'accounts.json');
  const before = read(file);
  st.accounts.update(admin.id, { role: 'staff' });
  st.accounts.lane._run();   // the first write lands; its record is written at once; the second waits in the lane
  assert.ok(st.accounts.lane.pending, 'the second write is asked');
  const rec = JSON.parse(read(path.join(storesOf(dir), 'set-' + st.ks.set + '.json')));
  assert.equal(rec.accounts.floor, rec.accounts.gen);
  st.accounts.lane.close();
  fs.writeFileSync(file, before);
  assert.equal(openStores(dir).ks.report().accounts.state, 'older');
});

test('a power cut that loses a store\'s last rename while its record\'s later write survives: one save behind, loaded, no account held', async () => {
  const { dir, st } = await seeded();
  const file = path.join(dir, 'accounts.json');
  const prev = read(file);
  st.accounts.signedIn(st.accounts.byUsername('sam'));
  st.flush();
  fs.writeFileSync(file, prev);
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.size, b.ks.heldFacts()], ['behind', 2, null]);
});

test('relabelled, another machine, another folder: changed where this laptop recorded the folder, elsewhere where it never did, other for another folder\'s saves', async () => {
  const { dir, st } = await seeded();
  const file = path.join(dir, 'accounts.json');
  const genuine = read(file);
  // Its kid changed to 16 other hex characters, at a path this laptop recorded: changed, not elsewhere.
  fs.writeFileSync(file, genuine.replace(/"kid": "[0-9a-f]{16}"/, '"kid": "3fa2000000000000"'));
  let b = openStores(dir);
  assert.equal(b.ks.report().accounts.state, 'changed');
  assert.match(b.ks.report().accounts.words, /names another machine key \(3fa2…, its own claim\), but this laptop recorded this folder's saves/);
  // The machine key made new at this start: its words say so.
  b = openStores(dir, { made: true });
  assert.match(b.ks.report().accounts.words, /^the machine key was made new at this start; these accounts were saved under the key it replaced/);
  // The same with the folder record removed and the set kept: still changed.
  fs.rmSync(path.join(storesOf(dir), 'folder-' + st.ks.folderId + '.json'));
  assert.equal(openStores(dir).ks.report().accounts.state, 'changed');
  // A genuine folder of key folder A at a new path under key folder B: elsewhere, its kid quoted as its claim.
  fs.writeFileSync(file, genuine);
  const moved = tmp();
  for (const f of fs.readdirSync(dir)) if (!fs.statSync(path.join(dir, f)).isDirectory()) fs.copyFileSync(path.join(dir, f), path.join(moved, f));
  const e = openStores(moved, { key: OTHER_KEY });
  assert.deepEqual([e.ks.report().accounts.state, e.ks.report().sessions.state], ['elsewhere', 'none']);
  assert.ok(e.ks.report().accounts.words.includes('saved under another machine key (' + KID.slice(0, 4) + '…, its own claim)'), e.ks.report().accounts.words);
  const view = e.ks.heldView([], acc.Accounts.view);
  assert.ok(view.cannotCheck);
  assert.deepEqual(view.accounts.map((a) => [a.username, a.reset]), [['ana', true], ['sam', false]], 'under elsewhere: a one-time password for the admin, and none for Staff');
  // A restart of that folder keeps the same hold, its words unchanged.
  const e2 = openStores(moved, { key: OTHER_KEY });
  assert.deepEqual([e2.ks.report().accounts.state, e2.ks.hold.file], ['elsewhere', e.ks.hold.file]);
  // accounts.json from another folder of this machine (another set): other.
  const two = await seeded(tmp());
  fs.copyFileSync(path.join(two.dir, 'accounts.json'), file);
  const o = openStores(dir);
  assert.equal(o.ks.report().accounts.state, 'other');
  assert.match(o.ks.report().accounts.words, /belongs to another folder's saves \(set [0-9a-f]{4}…; this folder holds [0-9a-f]{4}…\)/);
});

test('a move on this machine: a folder copied to a new path from the copy this laptop ran last keeps its accounts and sign-ins, and the set forks', async () => {
  const { dir, st, admin } = await seeded();
  const token = st.sessions.create(admin);
  st.flush();
  const moved = tmp();
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(moved, f));
  const m = openStores(moved, { records: storesOf(dir) });
  assert.deepEqual([m.ks.report().accounts.state, m.accounts.size, !!m.sessions.resolve(token)], ['move', 2, true]);
  assert.notEqual(m.ks.set, st.ks.set, 'a new set');
  assert.match(m.ks.lines.join('\n'), /this folder was last saved at .*; its accounts and sign-ins go on here/);
  m.flush();
  const latest = JSON.parse(read(path.join(storesOf(dir), 'latest.json')));
  assert.deepEqual([latest.set, latest.path], [m.ks.set, path.resolve(moved)]);
  assert.equal(JSON.parse(read(path.join(moved, 'accounts.json'))).set, m.ks.set);
  // The old copy started again loads its own set; its accounts.json copied into the new folder later reads other.
  const old = openStores(dir);
  assert.deepEqual([old.ks.report().accounts.state, old.ks.set], ['ok', st.ks.set]);
  old.flush();
  fs.copyFileSync(path.join(dir, 'accounts.json'), path.join(moved, 'accounts.json'));
  assert.equal(openStores(moved, { records: storesOf(dir) }).ks.report().accounts.state, 'other');
  // Another folder's genuine newest saves put at a new path before its first start, while another set is latest: other,
  // naming both paths.
  const third = tmp();
  fs.copyFileSync(path.join(dir, 'accounts.json'), path.join(third, 'accounts.json'));
  const t = openStores(third, { records: storesOf(dir) });
  assert.equal(t.ks.report().accounts.state, 'other');
  assert.ok(t.ks.report().accounts.words.includes(path.resolve(dir)) && t.ks.report().accounts.words.includes(path.resolve(moved)), t.ks.report().accounts.words);
});

test('a file changed while AGMessage runs is never made the .bak: kept aside, said, and AGMessage\'s own save written over it', async () => {
  const { dir, st } = await seeded();
  const file = path.join(dir, 'accounts.json');
  const genuine = read(file);
  fs.writeFileSync(file, genuine.replace('"name": "Sam"', '"name": "Sim"'));
  st.accounts.signedIn(st.accounts.byUsername('sam'));
  st.flush();
  assert.equal(read(file + '.bak'), read(file + '.bak'), 'the .bak is untouched');
  assert.ok(ks.checkText(K.accounts, ks.LABELS.accounts, read(file + '.bak')), 'the .bak holds a genuine save');
  const aside = fs.readdirSync(dir).find((f) => /^accounts\.changed-.*\.json$/.test(f));
  assert.ok(aside, 'kept aside');
  assert.match(read(path.join(dir, aside)), /"name": "Sim"/);
  assert.match(st.rows.find((r) => r.action === 'stores.changed').words, /^accounts\.json was changed while AGMessage ran: kept aside as accounts\.changed-.*\.json; AGMessage's own save is written over it$/);
  assert.equal(st.ks.report().changed, 1);
});

test('a store or a record that cannot be read is unread: nothing of it loads, and neither it nor its file is written over', async () => {
  const { dir, st } = await seeded();
  st.flush();
  // accounts.json a folder (EISDIR): unread, nothing written, its .bak untouched.
  const file = path.join(dir, 'accounts.json');
  const bak = read(file + '.bak');
  fs.renameSync(file, file + '.real');
  fs.mkdirSync(file);
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.size, b.ks.signInRefusal()], ['unread', 0, ks.UNREAD_WORDS]);
  assert.match(b.ks.report().accounts.words, /^accounts\.json could not be read \(EISDIR\): account sign-ins wait for a start that can read it; nothing was written over it$/);
  assert.match(b.ks.setupRefusal(), /could not be read on this start/);
  b.accounts.users.set('x', { id: 'x' });
  b.accounts.save({ twice: true }); b.flush();
  assert.equal(read(file + '.bak'), bak);
  fs.rmdirSync(file);
  fs.renameSync(file + '.real', file);
  // The set record a folder: every store unread, the record left as it is, and stores.record written.
  const rec = path.join(storesOf(dir), 'set-' + st.ks.set + '.json');
  const recText = read(rec);
  fs.renameSync(rec, rec + '.real');
  fs.mkdirSync(rec);
  const c = openStores(dir);
  assert.deepEqual(['accounts', 'sessions', 'adminSessions'].map((n) => c.ks.report()[n].state), ['unread', 'unread', 'unread']);
  assert.equal(c.ks.report().record.state, 'unread');
  assert.match(c.rows.find((r) => r.action === 'stores.record').words, /^could not be read \(EISDIR\): the stores were not opened this start$/);
  c.tokens.create(); c.flush();
  assert.ok(fs.statSync(rec).isDirectory());
  fs.rmdirSync(rec);
  fs.renameSync(rec + '.real', rec);
  assert.equal(read(rec), recText);
  assert.equal(openStores(dir).ks.report().accounts.state, 'ok', 'a start that can read it loads everything as before');
});

test('no machine key: nothing is checked or written, account sign-ins wait, and the token signs in for this run', async () => {
  const { dir } = await seeded();
  const before = fs.readdirSync(dir).map((f) => [f, read(path.join(dir, f))]);
  const records = fs.readdirSync(storesOf(dir)).map((f) => [f, read(path.join(storesOf(dir), f))]);
  const keyless = new ks.KeyedStores({ keys: () => { throw Object.assign(new Error('no key'), { code: 'EBUSY' }); }, kid: KID, records: storesOf(dir), dataDir: dir });
  const accounts = new acc.Accounts(path.join(dir, 'accounts.json'), { keyed: keyless.part('accounts') });
  const sessions = new acc.Sessions(path.join(dir, 'sessions.json'), accounts, { keyed: keyless.part('sessions') });
  const tokens = new acc.TokenSessions(path.join(dir, 'admin-sessions.json'), { keyed: keyless.part('adminSessions'), token: 'x' });
  keyless.open();
  assert.deepEqual([keyless.report().accounts.state, accounts.size, keyless.signInRefusal(), keyless.archiveRefusal() !== ''], ['keyless', 0, ks.KEYLESS_WORDS, true]);
  assert.match(keyless.bannerLines().join('\n'), /this run has no machine key \(EBUSY\): account sign-ins wait for a start that has it/);
  const sid = tokens.create();
  assert.ok(tokens.has(sid), 'the token signs in for this run');
  accounts.flush(); sessions.flush(); tokens.flush(); keyless.head.flushSync();
  assert.deepEqual(fs.readdirSync(dir).map((f) => [f, read(path.join(dir, f))]), before, 'no store file changes, byte for byte');
  assert.deepEqual(fs.readdirSync(storesOf(dir)).map((f) => [f, read(path.join(storesOf(dir), f))]), records);
  assert.equal(openStores(dir).ks.report().accounts.state, 'ok', 'a start with the key loads everything as before');
});

test('removed: accounts.json and its .bak gone is missing ✕ with the folder\'s count and save; accounts.json alone gone loads its .bak by the rule of saves', async () => {
  const { dir, st } = await seeded();
  st.flush();
  const file = path.join(dir, 'accounts.json');
  const keep = [read(file), read(file + '.bak')];
  fs.rmSync(file);
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.size], ['behind', 2]);
  assert.match(b.ks.report().accounts.words, /^accounts\.json was missing; its \.bak was loaded\. accounts\.json is one save behind/);
  fs.rmSync(file, { force: true }); fs.rmSync(file + '.bak');
  const c = openStores(dir);
  assert.equal(c.ks.report().accounts.state, 'missing');
  assert.match(c.ks.report().accounts.words, /^accounts\.json is missing: this folder held 2 accounts at save \d+\. Put it back and start again, or make the first admin account with the token$/);
  assert.equal(c.ks.setupRefusal(), '', 'the first admin account may be made, with the token');
  fs.writeFileSync(file, keep[0]); fs.writeFileSync(file + '.bak', keep[1]);
});

test('repeated accounts: a keyed file that checks and repeats a username reads changed; a held copy with two ben marks both repeated, refuses opening both, and opens one', async () => {
  const { dir } = await seeded();
  const file = path.join(dir, 'accounts.json');
  const data = JSON.parse(read(file));
  const ben = await plainUser('aben0000001', 'ben', 'admin');
  const ben2 = await plainUser('aben0000002', 'ben', 'staff');
  fs.writeFileSync(file, sealed('accounts', { users: [...data.users, ben, ben2] }, { set: data.set, gen: data.gen + 1 }, { indent: 1 }));
  const b = openStores(dir);
  assert.equal(b.ks.report().accounts.state, 'changed', 'AGMessage never saves one account twice');
  assert.match(b.ks.report().accounts.words, /holds one account twice/);
  const view = b.ks.heldView([], acc.Accounts.view);
  const bens = view.accounts.filter((a) => a.username === 'ben');
  assert.deepEqual(bens.map((a) => [a.repeated, a.adopt]), [[true, false], [true, false]]);
  const ask = (adopt) => b.ks.judgeAdoption({ digest: view.digest, adopt, confirm: [ben.id], keep: [ben.id, ben2.id] }, []);
  assert.match(ask([{ id: ben.id }, { id: ben2.id }]).error, /ben would be open twice/);
  assert.equal(ask([{ id: ben2.id }]).rows.length, 1);
});

test('rollback: 0.5.1 reads the keyed accounts and signs nobody in from the keyed sign-in files; plain files it writes read plain ✕ here, each account it left as it was marked as this laptop last saved it', async () => {
  const { dir, st, admin } = await seeded();
  const token = st.sessions.create(admin);
  const sid = st.tokens.create();
  st.flush();
  // 0.5.1's rule (accounts.js:165-166): every account it would load.
  const v051 = (data) => (data && Array.isArray(data.users) ? data.users : []).filter((u) => u && typeof u.id === 'string' && /^[a-z0-9][a-z0-9._-]{1,31}$/.test(u.username || '') && ['admin', 'manager', 'senior', 'tech', 'staff', 'viewer'].includes(u.role));
  const users = v051(JSON.parse(read(path.join(dir, 'accounts.json'))));
  assert.deepEqual(users.map((u) => u.username).sort(), ['ana', 'sam']);
  const sessions = JSON.parse(read(path.join(dir, 'sessions.json'))).sessions;
  assert.ok(!sessions.some((s) => s.h === sha256(token)), 'no sign-in by its sha256');
  assert.ok(!JSON.parse(read(path.join(dir, 'admin-sessions.json'))).sessions.some((s) => s.h === sha256(sid)));
  // 0.5.1 writes plain files (accounts.js:170, :328, :420), one account's password changed.
  users.find((u) => u.username === 'sam').pw = await acc.hashPassword('another password altogether');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ v: 1, sessions: sessions.map((s) => ({ ...s, h: sha256(token) })) }));
  fs.writeFileSync(path.join(dir, 'admin-sessions.json'), JSON.stringify({ v: 1, k: 'x', sessions: [] }));
  const b = openStores(dir);
  assert.deepEqual([b.ks.report().accounts.state, b.ks.report().sessions.state, b.sessions.resolve(token)], ['plain', 'ended', null]);
  const view = b.ks.heldView([], acc.Accounts.view);
  const row = (u) => view.accounts.find((a) => a.username === u);
  assert.deepEqual([row('ana').mark, row('ana').adopt, row('ana').reset], ['saved', true, false], 'as this laptop last saved it: ticked, no one-time password');
  assert.deepEqual([row('sam').mark, row('sam').reset], ['changed', true], 'changed since: its one-time password ticked');
});

test('the event archive\'s claim and pins: claimed before step 3, the pin opens only the accounts the archive took, and a start clears a claim nothing came of', async () => {
  const { dir, st } = await seeded();
  st.flush();
  assert.equal(st.ks.claim({ time: '2026-10-31T14-02-00-000Z', kind: 'continue', next: '2026-10-01T10-00-00-000Z' }), '');
  const pin = st.ks.pinOf('2026-10-31T14-02-00-000Z');
  assert.deepEqual(pin, { set: st.ks.set, gen: st.ks.parts.accounts.landed.gen, d: st.ks.parts.accounts.landed.d, n: 2 }, 'the pin names the save on disk by its set');
  assert.deepEqual(st.ks.underWay(), { time: '2026-10-31T14-02-00-000Z', kind: 'continue', next: '2026-10-01T10-00-00-000Z', accounts: pin });
  const claim = openStores(dir, { open: false }).ks.peekClaim();
  assert.deepEqual([claim.state, claim.claim.time, claim.claim.kind], ['claim', '2026-10-31T14-02-00-000Z', 'continue']);
  // The archive's accounts as it took them open against its pin; an older copy of the same set reads older and is held.
  const archived = path.join(dir, 'archived-accounts.json');
  fs.copyFileSync(path.join(dir, 'accounts.json'), archived);
  assert.equal(st.ks.openArchived(archived, '2026-10-31T14-02-00-000Z').users.length, 2);
  fs.copyFileSync(path.join(dir, 'accounts.json.bak'), archived);
  assert.match(st.ks.openArchived(archived, '2026-10-31T14-02-00-000Z').held, /an older save/);
  assert.equal(st.ks.report().accounts.state, 'older');
  assert.equal(st.ks.openArchived(path.join(dir, 'gone.json'), '2026-10-31T14-02-00-000Z').missing, true, 'its contents deleted: none, and the first account is made with the token');
  st.ks.clearClaim();
  assert.equal(st.ks.underWay(), null);
  assert.deepEqual(st.ks.pinOf('2026-10-31T14-02-00-000Z'), pin, 'the pin stays');
  // A start whose claim names no archive made (a stop before step 3): the claim and its pin are cleared.
  st.ks.claim({ time: '2026-11-01T09-00-00-000Z', kind: 'fresh', next: '' });
  const b = openStores(dir, { archive: () => ({ exists: false, begun: false }) });
  assert.deepEqual([b.ks.underWay(), b.ks.pinOf('2026-11-01T09-00-00-000Z')], [null, null]);
  // An archive under way at a start: no live store is loaded, its step 7 makes the next event's.
  b.ks.claim({ time: '2026-11-02T09-00-00-000Z', kind: 'fresh', next: '' });
  b.flush();
  const c = openStores(dir, { archive: () => ({ exists: true, begun: false }) });
  assert.deepEqual([c.ks.report().accounts.state, c.accounts.size], ['archiving', 0]);
  const d = openStores(dir, { archive: () => ({ exists: true, begun: true }) });
  assert.deepEqual([d.ks.underWay(), d.ks.report().accounts.state], [null, 'ok'], 'its next began: the claim is cleared');
});

test('a continue resumed at a start opens the archive\'s own accounts, or the continue\'s own save made after its claim; an older save of the set put in their place is held as older', async () => {
  const dir = tmp();
  const st = openStores(dir);
  await st.accounts.create({ username: 'ana', name: 'Ana', role: 'admin', password: PW });
  const sam = (await st.accounts.create({ username: 'sam', name: 'Sam', role: 'admin', password: PW })).account;
  st.flush();
  const file = path.join(dir, 'accounts.json');
  // The saves the two creates made depend on when their hashing ended against the lane's wait (two of them, or one where
  // the second came inside the first's), so the save numbers below are read from the files, never counted here.
  const older = read(file);   // sam an admin
  const olderGen = JSON.parse(older).gen;
  st.accounts.update(sam.id, { role: 'staff' });   // the demotion, saved twice
  st.flush();
  // Archive A takes the accounts (sam Staff), pinned; archive B, next: continue A, claimed.
  const A = '2026-11-01T10-00-00-000Z';
  const B = '2026-11-02T10-00-00-000Z';
  assert.equal(st.ks.claim({ time: A, kind: 'fresh', next: '' }), '');
  fs.mkdirSync(path.join(dir, 'archive', A), { recursive: true });
  fs.copyFileSync(file, path.join(dir, 'archive', A, 'accounts.json'));
  const asArchived = read(file);
  const archivedGen = JSON.parse(asArchived).gen;
  assert.equal(archivedGen, olderGen + 2, 'the demotion is two saves after the older one');
  st.ks.clearClaim();
  assert.equal(st.ks.claim({ time: B, kind: 'continue', next: A }), '');
  st.flush();
  const atStart = () => openStores(dir, { archive: () => ({ exists: true, begun: false }) });
  // A stop once A's files were back in the folder, and an older keyed save of this set put in their place before the next
  // start: held aside as older, never taken as the run's own.
  fs.writeFileSync(file, older);
  const b = atStart();
  assert.deepEqual([b.ks.report().accounts.state, b.ks.underWay().time], ['archiving', B]);
  const held = b.ks.openArchived(file, A);
  const heldWords = held.held || '';
  assert.ok(heldWords.startsWith('accounts.json is an older save (' + olderGen + '; this laptop recorded ' + archivedGen + '), put back from a copy (kept aside as accounts.held-') && heldWords.endsWith('.json)'), heldWords);
  assert.deepEqual([b.ks.report().accounts.state, b.accounts.size], ['older', 0]);
  // A's own file in place: it opens, against its pin.
  fs.writeFileSync(file, asArchived);
  const c = atStart();
  const back = c.ks.openArchived(file, A);
  assert.deepEqual((back.users || []).map((u) => u.username + ':' + u.role), ['ana:admin', 'sam:staff']);
  // The continue's step 7 saved them (twice), and a stop came before its claim cleared: the next start opens that save.
  c.accounts.replace({ users: back.users });
  c.ks.nextEvent();
  c.accounts.save({ twice: true });
  c.flush();
  const saved = JSON.parse(read(file));
  assert.ok(saved.gen > archivedGen, 'a save made after the claim');
  const d = atStart();
  assert.deepEqual((d.ks.openArchived(file, A).users || []).map((u) => u.username + ':' + u.role), ['ana:admin', 'sam:staff'], 'the continue\'s own save, made after its claim');
  // The older save put back over it: held as older again.
  fs.writeFileSync(file, older);
  assert.match(atStart().ks.openArchived(file, A).held || '', /an older save/);
  // A copy of an archive's accounts is never taken as the continue's own: only the live accounts.json of the continue.
  fs.writeFileSync(path.join(dir, 'archive', A, 'accounts.json'), JSON.stringify(saved));
  assert.match(atStart().ks.openArchived(path.join(dir, 'archive', A, 'accounts.json'), A).held || '', /changed after AGMessage saved it/);
});

test('a move, then a continue: an archive pinned before the folder moved opens after it, against its pin\'s own set; another set\'s file reads other', async () => {
  const { dir, st } = await seeded();
  const time = '2026-11-01T10-00-00-000Z';
  assert.equal(st.ks.claim({ time, kind: 'fresh', next: '' }), '');
  fs.mkdirSync(path.join(dir, 'archive', time), { recursive: true });
  fs.copyFileSync(path.join(dir, 'accounts.json'), path.join(dir, 'archive', time, 'accounts.json'));
  st.ks.clearClaim();
  st.flush();
  assert.equal(st.ks.openArchived(path.join(dir, 'archive', time, 'accounts.json'), time).users.length, 2, 'before the move');
  // The folder moved (a portable upgrade, the import), under the same records: the set forks, the pin keeps its own.
  const moved = tmp();
  fs.cpSync(dir, moved, { recursive: true });
  const m = openStores(moved, { records: storesOf(dir), archive: () => ({ exists: true, begun: true }) });
  assert.deepEqual([m.ks.report().accounts.state, m.ks.set !== st.ks.set, m.ks.pinOf(time).set], ['move', true, st.ks.set]);
  const r = m.ks.openArchived(path.join(moved, 'archive', time, 'accounts.json'), time);
  assert.deepEqual((r.users || []).map((u) => u.username).sort(), ['ana', 'sam'], 'continued after the move: ' + JSON.stringify(r.held || ''));
  // The pin's set travels in the record: after a restart of the moved folder too.
  m.flush();
  const again = openStores(moved, { records: storesOf(dir), archive: () => ({ exists: true, begun: true }) });
  assert.equal(again.ks.openArchived(path.join(moved, 'archive', time, 'accounts.json'), time).users.length, 2);
  // The moved folder's own newest save in the archive's place: of another set than the pin's, held as other.
  fs.copyFileSync(path.join(moved, 'accounts.json'), path.join(moved, 'archive', time, 'accounts.json'));
  assert.match(again.ks.openArchived(path.join(moved, 'archive', time, 'accounts.json'), time).held || '', /belongs to another folder's saves/);
  assert.equal(again.ks.report().accounts.state, 'other');
});

test('an archive whose record cannot be read keeps its claim and its pin at a start, said; an archive\'s accounts file that cannot be read throws, nothing written over it; one whose contents were deleted is missing once the next event begins', async () => {
  const { dir, st } = await seeded();
  const time = '2026-11-01T10-00-00-000Z';
  assert.equal(st.ks.claim({ time, kind: 'fresh', next: '' }), '');
  st.flush();
  const b = openStores(dir, { archive: () => ({ exists: true, begun: false, unread: 'EACCES' }) });
  assert.deepEqual([b.ks.underWay() && b.ks.underWay().time, !!b.ks.pinOf(time), b.ks.report().accounts.state, b.accounts.size], [time, true, 'archiving', 0]);
  assert.match(b.ks.report().accounts.words, /^the event archive under way \(2026-11-01T10-00-00-000Z\) could not be read \(EACCES\): its claim is kept for a start that can read it/);
  assert.match(b.ks.lines.join('\n'), /could not be read \(EACCES\)/);
  b.flush();
  // Only an archive that is not there clears them.
  const c = openStores(dir, { archive: () => ({ exists: false, begun: false }) });
  assert.deepEqual([c.ks.underWay(), c.ks.pinOf(time)], [null, null]);
  // An archive's accounts file that cannot be read: thrown with its words, so the step waits and nothing is opened.
  const unreadable = path.join(dir, 'archive', time);
  fs.mkdirSync(path.join(unreadable, 'accounts.json'), { recursive: true });   // a folder where the file is: EISDIR
  assert.throws(() => c.ks.openArchived(path.join(unreadable, 'accounts.json'), time), (e) => /^accounts\.json of the archive .* could not be read \(EISDIR\): nothing was opened or written over it$/.test(e.words));
  // An archive whose contents were deleted (its pin stays): none, and missing once the next event begins, until an account is made.
  st.ks.claim({ time: '2026-11-02T10-00-00-000Z', kind: 'fresh', next: '' });
  st.flush();
  const d = openStores(dir, { archive: () => ({ exists: true, begun: true }) });
  assert.deepEqual(d.ks.openArchived(path.join(dir, 'archive', 'gone', 'accounts.json'), '2026-11-02T10-00-00-000Z'), { users: [], missing: true });
  d.accounts.replace(null);
  d.ks.nextEvent();
  assert.equal(d.ks.report().accounts.state, 'missing');
  assert.match(d.ks.report().accounts.words, /^accounts\.json of the archive 2026-11-02T10-00-00-000Z is missing \(its contents were deleted, or it was taken out\): it held 2 accounts at save \d+\. Nobody signs in by account until the first admin account is made with the token$/);
  assert.match(d.lines.join('\n'), /accounts\.json of the archive 2026-11-02T10-00-00-000Z is missing/);
  d.accounts.save({ twice: true });
  d.flush();
  assert.equal(d.ks.report().accounts.state, 'missing', 'an empty save keeps it said');
  assert.equal(d.ks.setupRefusal(), '', 'the first admin account is made with the token');
  await d.accounts.create({ username: 'zed', name: 'Zed', role: 'admin', password: PW }, 'setup', { firstAdmin: true });
  d.flush();
  assert.equal(d.ks.report().accounts.state, 'ok', 'once an account is made');
});

test('a first start whose held copy was changed or cannot be read offers no account from it, says so, and Leave these out ends the hold; one where none waits keeps no copy', async () => {
  const dir = tmp();
  const users = [await plainUser('aana0000001', 'ana', 'admin'), await plainUser('asam0000001', 'sam', 'staff')];
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  const st = openStores(dir);
  st.flush();
  const copy = st.ks.hold.file;
  fs.writeFileSync(path.join(dir, copy), read(path.join(dir, copy)).replace('"ana"', '"anb"'));
  const b = openStores(dir);
  const words = 'the copy held aside (' + copy + ') was changed since it was held: no account can be adopted from it';
  assert.deepEqual(b.ks.heldFacts(), { state: 'first', waiting: 0, words, unusable: true });
  assert.deepEqual(b.ks.pageFacts(), { state: 'first', waiting: 0, words: ks.FIRST_WORDS }, 'the sign-in page keeps its own words');
  assert.equal(b.ks.report().accounts.words, words);
  assert.match(b.ks.lines.join('\n'), /no account can be adopted from it\. The token at the laptop may leave them out/);
  assert.deepEqual(b.rows.filter((r) => r.action === 'stores.changed').map((r) => [r.target, r.words]), [[copy, words]]);
  const view = b.ks.heldView([...b.accounts.users.values()], acc.Accounts.view);
  assert.deepEqual([view.ok, view.unusable, view.accounts, view.open, view.words], [true, true, [], ['sam'], words]);
  assert.match(b.ks.archiveRefusal(), /waits until the accounts are open/);
  assert.match(b.ks.judgeAdoption({ digest: view.digest, adopt: [{ id: 'aana0000001' }], confirm: ['aana0000001'], keep: [] }, []).error, /no account can be adopted from it/);
  assert.match(b.ks.judgeAdoption({ digest: 'f'.repeat(64), adopt: [], confirm: [], keep: [] }, []).error, /changed since you read it/);
  const j = b.ks.judgeAdoption({ digest: view.digest, adopt: [], confirm: [], keep: [] }, []);
  assert.deepEqual(j, { rows: [], fresh: true });
  assert.deepEqual(b.ks.adopted([...b.accounts.users.values()], { leaveRest: true }), { left: 0, file: copy, why: words });
  b.accounts.save({ twice: true });
  b.flush();
  assert.deepEqual([b.ks.heldFacts(), b.ks.archiveRefusal()], [null, '']);
  assert.equal(openStores(dir).ks.heldFacts(), null, 'and it stays ended');
  // A copy that cannot be read: the same, with why.
  const two = tmp();
  fs.writeFileSync(path.join(two, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  const s2 = openStores(two);
  s2.flush();
  fs.rmSync(path.join(two, s2.ks.hold.file));
  assert.match(openStores(two).ks.heldFacts().words, /could not be read \(ENOENT\): no account can be adopted from it$/);
  // A first start where nobody waits keeps no held copy: nothing would ever refer to it.
  const three = tmp();
  fs.writeFileSync(path.join(three, 'accounts.json'), JSON.stringify({ v: 1, users: [users[1]] }, null, 1));
  const s3 = openStores(three);
  s3.flush();
  assert.deepEqual([s3.ks.hold, fs.readdirSync(three).filter((f) => f.startsWith('accounts.held-'))], [null, []]);
});

test('the first start\'s writes: the records wait until every store it saves has landed, and the sign-in files wait for the accounts\' keyed save, so a plain accounts.json never sits beside keyed.json', async () => {
  const dir = tmp();
  const users = [await plainUser('asam0000001', 'sam', 'staff')];
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ v: 1, sessions: [{ h: sha256('old'), uid: 'asam0000001', epoch: 1, created: Date.now(), seen: Date.now() }] }));
  const plainSessions = read(path.join(dir, 'sessions.json'));
  // The accounts' keyed write refused (its temporary file's name is a folder): EISDIR.
  const blocker = path.join(dir, 'accounts.json.' + process.pid + '.tmp');
  fs.mkdirSync(blocker);
  const st = openStores(dir);
  assert.deepEqual([st.ks.report().accounts.state, st.ks.report().record.state], ['first', 'waiting']);
  assert.match(st.ks.report().record.words, /^the record of this folder's saves waits until accounts\.json and sessions\.json are saved keyed \(EISDIR/);
  assert.match(st.ks.lines.join('\n'), /△ the record of this folder's saves waits until/);
  assert.match(st.ks.archiveRefusal(), /^Archive this event… waits: the record of this folder's saves waits/);
  assert.equal(st.ks.claim({ time: '2026-11-01T10-00-00-000Z', kind: 'fresh', next: '' }) !== '', true, 'no claim while the records wait');
  assert.deepEqual([fs.existsSync(path.join(storesOf(dir), 'keyed.json')), JSON.parse(read(path.join(dir, 'accounts.json'))).v, read(path.join(dir, 'sessions.json'))], [false, 1, plainSessions], 'nothing keyed beside the plain accounts.json');
  // A stop now: the next start is the first start again, and sam signs in.
  st.accounts.lane.close(); st.sessions.lane.close(); st.tokens.lane.close();
  fs.rmdirSync(blocker);
  const again = openStores(dir);
  assert.deepEqual([again.ks.report().accounts.state, again.ks.signInRefusal(), again.accounts.size], ['first', '', 1]);
  again.flush();
  assert.equal(openStores(dir).ks.report().accounts.state, 'ok');
  // The same refusal lifted within the run: once the accounts' write lands the sign-in files are saved, then the records.
  const two = tmp();
  fs.writeFileSync(path.join(two, 'accounts.json'), JSON.stringify({ v: 1, users }, null, 1));
  fs.writeFileSync(path.join(two, 'sessions.json'), plainSessions);
  const blocker2 = path.join(two, 'accounts.json.' + process.pid + '.tmp');
  fs.mkdirSync(blocker2);
  const s2 = openStores(two);
  fs.rmdirSync(blocker2);
  s2.accounts.flush();
  s2.sessions.flush();
  s2.ks.head.flushSync();
  assert.deepEqual([JSON.parse(read(path.join(two, 'accounts.json'))).v, JSON.parse(read(path.join(two, 'sessions.json'))).v, fs.existsSync(path.join(storesOf(two), 'keyed.json')), s2.ks.report().record.state], [2, 2, true, 'ok']);
  s2.flush();
  assert.equal(openStores(two).ks.report().accounts.state, 'ok');
});

test('what a start would decide is read with nothing written (lib/importfacts.js reads the installed node\'s copy so)', async () => {
  const { dir, st, admin } = await seeded();
  st.sessions.create(admin);
  st.flush();
  const records = fs.readdirSync(storesOf(dir)).map((f) => [f, read(path.join(storesOf(dir), f))]);
  assert.deepEqual(ks.judgeFolder({ dataDir: dir, records: storesOf(dir), K, kid: KID }), { accounts: 'ok', sessions: 'ok', adminSessions: 'none' });
  const moved = tmp();
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(moved, f));
  assert.deepEqual(ks.judgeFolder({ dataDir: moved, records: storesOf(dir), K, kid: KID }), { accounts: 'move', sessions: 'move', adminSessions: 'none' });
  assert.deepEqual(ks.judgeFolder({ dataDir: moved, records: tmp(), K: storesKeys(OTHER_KEY)(), kid: storesKid(OTHER_KEY) }), { accounts: 'elsewhere', sessions: 'ended', adminSessions: 'none' });
  assert.deepEqual(fs.readdirSync(storesOf(dir)).map((f) => [f, read(path.join(storesOf(dir), f))]), records, 'nothing written');
});

// What the stores' open, a save and a set record do, counted as work, never timed (how long they take is the machine's,
// how much they do is the code's; test/audit-preload.js counts the audit log's work alike): MACs and hashes made and the
// bytes each was given, files read and their bytes, and JSON parsed, while `fn` runs.
function counted(fn) {
  const n = { macs: 0, macBytes: 0, hashes: 0, hashBytes: 0, reads: 0, readBytes: 0, parses: 0 };
  const made = { createHmac: crypto.createHmac, createHash: crypto.createHash };
  const counting = (name, kind, bytes) => function (...args) {
    const h = made[name].apply(this, args);
    n[kind]++;
    const update = h.update.bind(h);
    h.update = (data, enc) => { n[bytes] += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), enc || 'utf8'); return update(data, enc); };
    return h;
  };
  const readFileSync = fs.readFileSync, parse = JSON.parse;
  crypto.createHmac = counting('createHmac', 'macs', 'macBytes');
  crypto.createHash = counting('createHash', 'hashes', 'hashBytes');
  fs.readFileSync = function (...args) { const r = readFileSync.apply(this, args); n.reads++; n.readBytes += Buffer.isBuffer(r) ? r.length : Buffer.byteLength(r); return r; };
  JSON.parse = function (...args) { n.parses++; return parse.apply(this, args); };
  const t = process.hrtime.bigint();
  try { return { value: fn(), n, ms: Number(process.hrtime.bigint() - t) / 1e6 }; } finally {
    Object.assign(crypto, made); fs.readFileSync = readFileSync; JSON.parse = parse;
  }
}

test('speed: 5,000 sessions, 1,000 accounts and 50 token sign-ins open with the work 50 sessions, 10 accounts and 5 sign-ins take (one MAC a file, never one a record, each byte read once and MACed once); a save of the sessions and a record of 1,000 digests each one MAC', async (t) => {
  const hash = await acc.hashPassword(PW);
  const run = (accounts, sessions, tokens) => {
    const dir = tmp();
    const st = openStores(dir);
    for (let i = 0; i < accounts; i++) st.accounts.users.set('a' + String(i).padStart(11, '0'), { id: 'a' + String(i).padStart(11, '0'), username: 'u' + i, name: 'U' + i, role: 'staff', halls: [], grant: [], revoke: [], disabled: false, mustChange: false, pw: hash, epoch: 1, createdAt: 1, lastLoginAt: 0 });
    const now = Date.now();
    for (let i = 0; i < sessions; i++) { const h = crypto.randomBytes(32).toString('hex'); st.sessions.map.set(h, { h, uid: 'a' + String(i % accounts).padStart(11, '0'), epoch: 1, created: now, seen: now, ip: '10.0.0.' + (i % 250), ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }); }
    for (let i = 0; i < tokens; i++) st.tokens.create(now);
    st.accounts.save(); st.tokens.save(); st.flush();
    const save = counted(() => { st.sessions.save(); st.sessions.flush(); });
    st.flush();
    const record = counted(() => st.ks.recordNow());
    const open = counted(() => openStores(dir));
    const b = open.value;
    assert.deepEqual([b.accounts.size, b.sessions.map.size, b.tokens.map.size], [accounts, sessions, tokens]);
    const bytes = (f) => fs.statSync(path.join(dir, f)).size;
    return { save, record, open, sessionsBytes: bytes('sessions.json'), filesBytes: ['accounts.json', 'sessions.json', 'admin-sessions.json'].reduce((s, f) => s + bytes(f), 0) };
  };
  const small = run(10, 50, 5);
  const big = run(1000, 5000, 50);
  const work = (c) => [c.n.macs, c.n.hashes, c.n.reads, c.n.parses];
  // The open: what it makes and reads is the same however many records the files hold; only the bytes grow, every file
  // read whole once and its bytes MACed once (a MAC a record would be 6,050 of them).
  assert.deepEqual(work(big.open), work(small.open), 'the same MACs, hashes, reads and parses at both sizes: ' + JSON.stringify([small.open.n, big.open.n]));
  assert.ok(big.open.n.macs <= 12, 'a MAC a file and its record, never one a record: ' + big.open.n.macs);
  assert.ok(big.open.n.readBytes >= big.filesBytes, 'each of the three files read whole: ' + big.open.n.readBytes + ' of ' + big.filesBytes);
  assert.ok(big.open.n.macBytes <= big.open.n.readBytes, 'nothing MACed twice: ' + big.open.n.macBytes + ' MACed of ' + big.open.n.readBytes + ' read');
  // A save of the 5,000 sessions: one MAC, over the bytes it writes, and nothing read back.
  assert.deepEqual([big.save.n.macs, big.save.n.hashes, big.save.n.reads, big.save.n.parses], [1, 0, 0, 0]);
  assert.ok(big.save.n.macBytes <= big.sessionsBytes, 'the save MACs the file it writes, once: ' + big.save.n.macBytes + ' of ' + big.sessionsBytes);
  // A set record with 1,000 accounts' digests: one MAC, one read and one parse, as with ten.
  assert.deepEqual(work(big.record), work(small.record), 'the record: ' + JSON.stringify([small.record.n, big.record.n]));
  assert.deepEqual(work(big.record), [1, 0, 1, 1]);
  // How long each took here: a record, not a pass mark (the plan measured 10-11 ms for the open and 12-14 ms for the save).
  t.diagnostic(`at 1,000 accounts, 5,000 sessions and 50 token sign-ins: open ${big.open.ms.toFixed(1)} ms, the save ${big.save.ms.toFixed(1)} ms, the record ${big.record.ms.toFixed(1)} ms (a record, not a pass mark)`);
});

test('guard rails: lib/keyedstore.js requires Node\'s crypto, path and lib/resilience.js alone, never lib/secretbox.js; its lane is one storesHead names', () => {
  const src = readSource('app/lib/keyedstore.js');
  assert.deepEqual([...src.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort(), ['./resilience', 'crypto', 'path']);
  assert.equal((src.match(/\bfs\.\w+Sync/g) || []).length, 0);
  const before = WriteLane.built;
  const st = new ks.KeyedStores({ keys: () => K, kid: KID, records: tmp(), dataDir: tmp() });
  assert.equal(WriteLane.built, before + 1, 'one lane: the record outside the data folder');
  st.head.close();
});
