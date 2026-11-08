'use strict';
// The audit log carried across events (lib/audit.js point() and the walk from an archive point, lib/auditarchive.js,
// verify/auditrules.js and verify/verify-audit.js for archives): the archive point, the admin's split into a signed
// archive, the mark a split carries, every refusal, what a writer of the data folder can do after a split, a split
// stopped part way, two splits, an archive checked alone, the export across a split, a rollback, the routes and their
// rights, speed, and no secret in an archive. Each is asserted by its fields: the files on disk, archive.json, the rows,
// the check's answer, the verifier's codes.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const audit = require('../lib/audit');
const { Archiver, eventOf } = require('../lib/auditarchive');
const { Exporter } = require('../lib/auditexport');
const verifier = require('../verify/verify-audit');
const rules = require('../verify/auditrules');
const secretbox = require('../lib/secretbox');
const h = require('./helpers');
const { readSource } = h;

const { auditLog, recordsOf, chainOf, keyedLogWithPoints, acceptAll, FIXTURE_KEY, OTHER_KEY, HOST, ROOT } = h;
const SIGN = 'agmessage audit sign v1';
const VERIFY = path.join(ROOT, 'verify', 'verify-audit.js');
const VERIFY_DIR = path.join(ROOT, 'verify');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fresh = () => path.join(tmp('agm-arc-'), 'audit.jsonl');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const keyOf = (machine = FIXTURE_KEY) => secretbox.signingKeyFrom(secretbox.deriveFrom(machine, SIGN));
const FP = keyOf().fingerprint;
const SAM = Object.freeze({ t: 'account', id: 'a1', name: 'sam' });
const ANA = Object.freeze({ t: 'account', id: 'a9', name: 'ana' });
const NODE = () => ({ id: 'a1b2c3d4', name: 'AGMessage test', version: '0.6.0', build: '0.6.0-test' });
const EVENT = 'the event “Spring Summit” was archived (messages, files, help requests into archive\\2026-10-27T14-02-00-000Z); links kept. The audit log carries on, and can be split here (Admin → Health).';
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const entries = (file) => lines(file).map((l) => JSON.parse(l));
const firstOf = (file) => JSON.parse(lines(file)[0]);
const rotated = (file) => fs.readdirSync(path.dirname(file)).filter((f) => /^audit-\d{4}-.*\.jsonl$/.test(f)).sort();
const archiveDir = (file) => path.join(path.dirname(file), 'audit-archive');

/** `n` entries written by this machine (the fixture key) on `log`. */
function writeOn(log, n, words = (i) => 'message ' + i) {
  for (let i = 1; i <= n; i++) log.write(SAM, 'display.take', 'D1', words(i), '10.0.0.9');
  return log;
}
/** A log of `before` entries, an archive point, and `after` more, flushed: {log, file, point}. */
function pointed({ file = fresh(), before = 5, after = 3, key = FIXTURE_KEY } = {}) {
  const log = writeOn(auditLog(file, { key }), before);
  const point = log.point(HOST, '2026-10-27T14-02-00-000Z', EVENT, '127.0.0.1');
  writeOn(log, after, (i) => 'after ' + i);
  log.flush();
  return { log, file, point };
}
/** The archiver over `log`, signing with the fixture key (or `machine`'s). */
const archiverOf = (log, { machine = FIXTURE_KEY, exporter = null } = {}) => new Archiver({ audit: log, signingKey: () => keyOf(machine), node: NODE, exporter });
/** The fs call `name` (of fs, or fs.promises with `promises`) throws `code` while `when(args)` holds, for the length of `fn`. */
async function failing(name, code, when, fn, { promises = false } = {}) {
  const host = promises ? fs.promises : fs;
  const real = host[name];
  host[name] = (...args) => {
    if (when(...args)) {
      const e = Object.assign(new Error(code + ': stubbed, ' + name), { code });
      if (promises) return Promise.reject(e);
      throw e;
    }
    return real.apply(host, args);
  };
  try { return await fn(); } finally { host[name] = real; }
}
/** The verifier run as an auditor runs it, a process of its own: {code, out}. */
function verify(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [VERIFY, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}
/** An export of `log` behind a plain HTTP server, as http-accounts mounts it, unpacked: {dir, zip, headers}. */
async function exported(log, { machine = FIXTURE_KEY, archiver = null } = {}) {
  const exporter = new Exporter({ audit: log, signingKey: () => keyOf(machine), verifyDir: VERIFY_DIR, version: 'test', node: NODE, archiver });
  const runs = [];
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    runs.push(exporter.run(res, ANA, '10.0.0.9'));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/', { method: 'POST' });
    const body = Buffer.from(await r.arrayBuffer());
    await Promise.all(runs);
    assert.equal(r.status, 200, body.toString().slice(0, 300));
    return { dir: h.unzipTo(body, tmp('agm-bundle-')), zip: body, headers: r.headers };
  } finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
}
const copy = (dir) => { const to = path.join(tmp('agm-copy-'), path.basename(dir)); fs.cpSync(dir, to, { recursive: true }); return to; };
/**
 * An archive's folder signed again, as anyone who can write it could: `edit(dir)` first, then `key`'s public key put in and
 * named in archive.json, SHA256SUMS taken again over the files it lists, and signed by `key` ({privateKey, publicKey}).
 */
function resign(dir, key, edit = () => {}) {
  edit(dir);
  fs.writeFileSync(path.join(dir, 'signing-key.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'archive.json')));
  a.signingKey.fingerprint = sha(key.publicKey.export({ type: 'spki', format: 'der' }));
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(a, null, 2) + '\n');
  const listed = rules.parseSums(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), 'archive').list;
  const sums = Buffer.from(listed.map((x) => sha(fs.readFileSync(path.join(dir, ...x.path.split('/')))) + '  ' + x.path).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sig'), crypto.sign(null, sums, key.privateKey));
}
/** An archived log file's line for entry `seq` changed in place to `to` (the same length), its MAC kept. */
function editArchived(dir, seq, from, to) {
  for (const f of fs.readdirSync(path.join(dir, 'log'))) {
    const file = path.join(dir, 'log', f);
    const ls = lines(file);
    const i = ls.findIndex((l) => JSON.parse(l).seq === seq);
    if (i < 0) continue;
    assert.equal(from.length, to.length);
    ls[i] = ls[i].replace(from, to);
    fs.writeFileSync(file, ls.join('\n') + '\n');
    return;
  }
  throw new Error('no entry ' + seq);
}
const flip = (file, at = 10) => { const b = fs.readFileSync(file); b[at] ^= 1; fs.writeFileSync(file, b); };
/** The browser verifier's script against a stand-in document, the folder chosen and the key typed: {code, text, said, entries}. */
async function onPage(dir, { fp = '' } = {}) {
  const els = new Map();
  const node = () => {
    const n = { hidden: false, disabled: false, value: '', dataset: {}, files: [], kids: [], on: {}, text: '' };
    Object.defineProperty(n, 'textContent', { get: () => n.text + n.kids.map((k) => k.textContent).join('\n'), set: (v) => { n.text = String(v); n.kids = []; } });
    n.addEventListener = (ev, fn) => { (n.on[ev] = n.on[ev] || []).push(fn); };
    n.appendChild = (c) => { n.kids.push(c); return c; };
    return n;
  };
  const $ = (id) => { if (!els.has(id)) els.set(id, node()); return els.get(id); };
  const document = { getElementById: $, createElement: () => node(), addEventListener: () => {}, body: { classList: { add: () => {}, remove: () => {} } } };
  vm.runInNewContext(readSource(path.join(VERIFY_DIR, 'page.js')), { document, AGMAuditRules: rules, crypto: globalThis.crypto, TextDecoder, TextEncoder, atob }, { filename: 'verify-page.js' });
  $('fp').value = fp;
  $('folder').files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((rel) => ({
    name: path.basename(rel), webkitRelativePath: path.basename(dir) + '/' + rel.split(path.sep).join('/'),
    arrayBuffer: async () => { const b = fs.readFileSync(path.join(dir, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  }));
  for (const f of $('folder').on.change || []) f();
  await h.until(() => /^[0-4]$/.test($('state').dataset.code || ''), 20000, 'the page\'s answer');
  return { code: Number($('state').dataset.code), text: $('state').textContent, said: $('said').kids.map((k) => k.textContent), entries: $('entriesBox').hidden ? 0 : $('rows').kids.length };
}

// ---------------------------------------------------------------- the archive point
test('the point: the first line of a new file, the one before it rotated; on an empty file nothing is rotated; its target names its run', async () => {
  const { log, file, point } = pointed({ before: 5, after: 0 });
  assert.deepEqual([point.seq, point.action, point.actor], [6, 'audit.archive', { ...HOST }]);
  assert.equal(point.target, '2026-10-27T14-02-00-000Z;' + log.kid + ':1', 'the event archive\'s folder, then the run it stands in');
  assert.equal(point.words, EVENT);
  assert.equal(rotated(file).length, 1, 'the file before it was set aside');
  assert.deepEqual(entries(path.join(path.dirname(file), rotated(file)[0])).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(entries(file).map((e) => [e.seq, e.action]), [[6, 'audit.archive']], 'the point opens a file of its own');
  assert.equal(eventOf(point.words), 'Spring Summit');
  // On an empty current file (a fresh log) nothing is rotated.
  const empty = fresh();
  const e2 = auditLog(empty).point(HOST, 'x', 'first', '');
  assert.deepEqual([e2.seq, rotated(empty).length], [1, 0]);
  // After a restart whose newest file starts after the run began, the head's run names it: a 0.5.1 seed keyed at entry 6.
  const seeded = fresh();
  fs.writeFileSync(seeded, chainOf(5));
  const first = auditLog(seeded);
  await acceptAll(first);   // the boundary (6), the accept (7)
  writeOn(first, 3);
  first.point(HOST, 'one', 'the first event', '');
  writeOn(first, 2);
  first.flush();
  const again = auditLog(seeded);
  assert.ok(firstOf(seeded).seq > 6, 'the newest file starts after the run began');
  const p2 = again.point(HOST, 'two', 'the second event', '');
  assert.equal(p2.target, 'two;' + again.kid + ':6', 'from the head\'s run');
  assert.equal(JSON.parse(fs.readFileSync(path.join(recordsOf(seeded), 'head-' + again.l + '.json'))).run, 6);
});

test('the point: with an entry waiting (the disk refusing) it is written where it falls; a size rotation and a forced one in one millisecond give two files', async () => {
  const file = fresh();
  const log = writeOn(auditLog(file), 3);
  log.flush();
  const p = await failing('writeSync', 'ENOSPC', () => true, () => { writeOn(log, 1, () => 'while the disk was full'); return log.point(HOST, 'full', 'while the disk was full', ''); });
  assert.equal(log.unwritten, 2, 'the point waits with the entry before it');
  log.flush();
  assert.deepEqual([rotated(file).length, entries(file).map((e) => e.seq)], [0, [1, 2, 3, 4, 5]], 'no rotation: the point is not the first line of a file');
  assert.equal(p.seq, 5);
  const r = await archiverOf(log).split(p.seq, HOST, '');
  assert.deepEqual([r.ok, r.error], [false, 'This archive point is not the first line of a file (the disk refused entries when it was written): split at another point.']);
  // A size rotation, then a forced one in the same millisecond (a stubbed clock): two files, neither replacing the other.
  const f2 = fresh();
  const l2 = writeOn(auditLog(f2), 2);
  l2.flush();
  const realNow = Date.now;
  const T = realNow();
  Date.now = () => T;
  try {
    l2.size = 21 * 1024 * 1024;   // as if the file were over 20 MB: the next write rotates first
    writeOn(l2, 1, () => 'rotated by size');
    l2.point(HOST, 'same ms', 'forced in the same millisecond', '');
  } finally { Date.now = realNow; }
  l2.flush();
  const names = rotated(f2);
  assert.equal(names.length, 2, names.join(' '));
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(names.map((n) => entries(path.join(path.dirname(f2), n)).map((e) => e.seq)), [[1, 2], [3]], 'both files keep their entries');
  assert.deepEqual(entries(f2).map((e) => e.action), ['audit.archive']);
  assert.equal((await l2.verify()).mark, 'intact');
});

test('the point: in a run with no machine key it is written, and no split is made at it (503, no row, nothing in audit-archive)', async () => {
  const file = fresh();
  const log = new audit.AuditLog(file, { keys: () => { throw Object.assign(new Error('no key'), { code: 'EBUSY' }); }, records: recordsOf(file) });
  writeOn(log, 3);
  const p = log.point(HOST, 'keyless', 'an event archived with no key', '');
  log.flush();
  assert.equal(p.action, 'audit.archive');
  const before = lines(file).length;
  const r = await archiverOf(log).split(p.seq, HOST, '');
  assert.deepEqual([r.ok, r.status, r.error], [false, 503, 'Not split: this run has no machine key (EBUSY), so the archive cannot be signed.']);
  assert.equal(lines(file).length, before, 'no row');
  assert.equal(fs.existsSync(archiveDir(file)), false, 'nothing made');
});

// ---------------------------------------------------------------- the split
test('the split: the files before the point move into a signed archive, byte for byte; the check walks from the point and names it; after a restart, the same', async () => {
  const file = fresh();
  const log = writeOn(auditLog(file), 3);
  log.size = 21 * 1024 * 1024;   // a size rotation before the point: two files move
  writeOn(log, 2);
  const point = log.point(HOST, '2026-10-27T14-02-00-000Z', EVENT, '127.0.0.1');
  writeOn(log, 3, (i) => 'after ' + i);
  log.flush();
  const before = rotated(file).map((n) => [n, fs.readFileSync(path.join(path.dirname(file), n))]);
  assert.equal(before.length, 2);
  const run = JSON.parse(fs.readFileSync(path.join(recordsOf(file), 'head-' + log.l + '.json'))).run;
  const r = await archiverOf(log).split(point.seq, HOST, '127.0.0.1');
  const name = 'audit-' + log.l.slice(0, 8) + '-1-5';
  assert.deepEqual(r, { ok: true, archive: name, entries: { from: 1, to: 5 }, moved: 2, words: '✓ Split: entries 1–5 are in the archive ' + name + ' (2 files, signed). The check starts at entry 6.' });
  const dir = path.join(archiveDir(file), name);
  assert.deepEqual(rotated(file), [], 'none left live');
  for (const [n, bytes] of before) assert.ok(fs.readFileSync(path.join(dir, 'log', n)).equals(bytes), n + ', byte for byte');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['SHA256SUMS', 'SHA256SUMS.sig', 'archive.json', 'log', 'signing-key.pem']);
  // archive.json: what the archive is.
  const jsonBuf = fs.readFileSync(path.join(dir, 'archive.json'));
  const a = JSON.parse(jsonBuf);
  assert.equal(jsonBuf.toString(), JSON.stringify(a, null, 2) + '\n');
  assert.equal(rules.archiveProblem(a), '');
  assert.deepEqual(Object.keys(a), ['kind', 'v', 'made', 'by', 'node', 'log', 'kid', 'signingKey', 'entries', 'start', 'point', 'previous', 'check', 'files']);
  assert.deepEqual({ ...a, made: 0 }, {
    kind: 'agmessage audit archive', v: 1, made: 0, by: { ...HOST }, node: NODE(), log: log.l, kid: log.kid,
    signingKey: { alg: 'Ed25519', fingerprint: FP }, entries: { from: 1, to: 5 }, start: { seq: 1, prev: audit.GENESIS },
    point: { seq: 6, h: point.h }, previous: null,
    check: { mark: 'intact', words: 'Intact — entries 1–5, keyed on this machine', findings: [] },
    files: before.map(([n, b], i) => ({ path: 'log/' + n, bytes: b.length, first: i ? 4 : 1, last: i ? 5 : 3 })),
  });
  // SHA256SUMS over every file, its signature by the fixture key, and the split's entry pinning it.
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  const listed = rules.parseSums(sums.toString(), 'archive').list;
  assert.deepEqual(listed.map((x) => x.path), [...before.map(([n]) => 'log/' + n), 'archive.json', 'signing-key.pem']);
  for (const x of listed) assert.equal(sha(fs.readFileSync(path.join(dir, ...x.path.split('/')))), x.digest, x.path);
  assert.ok(crypto.verify(null, sums, keyOf().publicKey, fs.readFileSync(path.join(dir, 'SHA256SUMS.sig'))), 'signed by the fixture key');
  assert.equal(sha(verifier.pemDer(fs.readFileSync(path.join(dir, 'signing-key.pem'), 'utf8'))), FP);
  const split = entries(file).find((e) => e.action === 'audit.split');
  assert.deepEqual([split.target, split.actor], ['6;' + sha(sums), { ...HOST }]);
  assert.equal(split.words, 'split here: entries 1–5 move into ' + path.join('audit-archive', name) + ', signed with ' + FP.slice(0, 16).match(/.{4}/g).join(' ') + '; the check starts at entry 6, where “Spring Summit” was archived');
  assert.equal(firstOf(file).seq, 6, 'the live log begins at the point');
  // The check walks from the point, reads ✓, and names the archive with its range.
  const c = await log.verify();
  assert.deepEqual([c.ok, c.mark, c.from, c.entries], [true, 'intact', 6, 5]);
  assert.equal(c.words, 'Intact — entries 6–10, keyed on this machine; entries 1–5 in 1 archive, intact');
  assert.deepEqual(c.archives.map((x) => ({ ...x, words: x.words.replace(/on \d+ \w{3}/, 'on D') })), [{ name, from: 1, to: 5, split: split.seq, mark: 'intact', words: 'entries 1–5: archive ' + name + ', split off on D' }]);
  assert.deepEqual(Object.keys(c).slice(-2), ['from', 'archives'], 'at the end of the answer');
  assert.deepEqual([log.facts().from, log.facts().archives], [6, 1]);
  // The head: saved at once, at the split's row or later; its run unchanged.
  const head = JSON.parse(fs.readFileSync(path.join(recordsOf(file), 'head-' + log.l + '.json')));
  assert.ok(head.seq >= split.seq && head.run === run, JSON.stringify(head));
  // After a restart, the same.
  const again = auditLog(file);
  const c2 = await again.verify();
  assert.deepEqual([c2.mark, c2.from, c2.archives.map((x) => x.name)], ['intact', 6, [name]]);
  assert.equal(again.attention().length, 0);
});

test('the mark carries: a 0.5.1 seed accepted (◇) and then split off stays ◇, never ✓; a span accepted after the point is named in archive.json, and the archive alone reads ◇', async () => {
  const file = fresh();
  fs.writeFileSync(file, chainOf(5));
  const log = auditLog(file);
  await acceptAll(log);
  writeOn(log, 2);
  const point = log.point(HOST, 'one', EVENT, '');
  writeOn(log, 1);
  log.flush();
  assert.equal((await archiverOf(log).split(point.seq, HOST, '')).ok, true);
  const c = await log.verify();
  assert.deepEqual([c.ok, c.mark], [false, 'linked']);
  assert.match(c.words, /^Linked — entries 10–12, keyed here, are intact; entries 1–9 are in the archive audit-[0-9a-f]{8}-1-9, which holds entries 1–5 accepted on \d+ \w{3}$/);
  assert.equal(c.archives[0].mark, 'linked');
  // A span accepted after the event was archived: the accept stays in the live log, and archive.json names it by seq.
  const f2 = fresh();
  fs.writeFileSync(f2, chainOf(4));
  const l2 = auditLog(f2);
  writeOn(l2, 1);
  const p2 = l2.point(HOST, 'two', EVENT, '');
  l2.flush();
  const refused = await archiverOf(l2).split(p2.seq, HOST, '');
  assert.equal(refused.error, 'Not split: entries before ' + p2.seq + ' have open findings. Accept them first (Admin → Health), or split at an earlier point.');
  const acc = await acceptAll(l2);
  assert.ok(acc.ok && acc.entry > p2.seq, 'accepted after the point');
  const r = await archiverOf(l2).split(p2.seq, HOST, '');
  assert.equal(r.ok, true, r.error);
  const dir = path.join(archiveDir(f2), r.archive);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'archive.json')));
  assert.deepEqual(a.check.findings.map((f) => [f.id, f.accept.seq]), [['s1-4', acc.entry]]);
  assert.equal(a.check.mark, 'linked');
  const alone = await verify([dir, '--fingerprint', FP, '--list']);
  assert.equal(alone.code, 1, alone.out);
  assert.match(alone.out, /^1 {2}\S+ {2}◇ {2}sam {2}display\.take {2}dlectern1 {2}/m, 'a span\'s rows listed ◇, by the accept archive.json names');
  assert.match(alone.out, /^ {4}◇ entries 1–4 have plain hashes .+ \(accepted by entry \d+ on \d+ \w{3}\)$/m);
  const extra = copy(dir);
  fs.writeFileSync(path.join(extra, 'notes.txt'), 'not read');
  const three = await verify([extra, '--fingerprint', FP]);
  assert.equal(three.code, 3);
  assert.match(three.out, /^✕ notes\.txt is not part of the archive \(not read\)$/m);
  assert.match(alone.out, /^◇ entries 1–4 with plain hashes: accepted on the AGMessage laptop by entry \d+ /m);
  assert.match(alone.out, /said ◇ when it split this archive off: read its findings \(exit 1\)\.$/m);
  const checked = await archiverOf(l2).checkArchive(r.archive);
  assert.deepEqual([checked.mark, checked.archive.name, checked.archive.pinned], ['linked', r.archive, true]);
  // archive.json rewritten from ◇ to ✓ and the folder re-signed: by a stranger's key it is not this laptop's archive, and by
  // the laptop's own key (as whoever holds it could) it is not the one the split pinned. Both read ✕, here and in the routine
  // check, never ✓.
  const toIntact = (d) => { const f = path.join(d, 'archive.json'); const a2 = JSON.parse(fs.readFileSync(f)); a2.check.mark = 'intact'; a2.check.findings = []; fs.writeFileSync(f, JSON.stringify(a2, null, 2) + '\n'); };
  const saved = copy(dir);
  const stranger = crypto.generateKeyPairSync('ed25519');
  resign(dir, stranger, toIntact);
  assert.equal((await verifier.check(dir, { fingerprint: sha(stranger.publicKey.export({ type: 'spki', format: 'der' })) })).code, 0, 'whole and signed, by its own claim');
  const forged = await archiverOf(l2).checkArchive(r.archive);
  assert.deepEqual([forged.ok, forged.mark], [false, 'broken']);
  assert.match(forged.why, /^the archive audit-[0-9a-f]{8}-1-\d+ carries this laptop's key id and is signed by key \S{4} \S{4} \S{4} \S{4} …, not this laptop's key: it is not what this laptop split off$/);
  assert.match((await l2.verify()).words, /is not what was split off: its SHA256SUMS is not the one the split pinned$/);
  fs.rmSync(dir, { recursive: true });
  fs.cpSync(saved, dir, { recursive: true });
  resign(dir, keyOf(), toIntact);
  const ownKey = await archiverOf(l2).checkArchive(r.archive);
  assert.deepEqual([ownKey.mark, ownKey.why], ['broken', 'the archive ' + r.archive + ' is not what was split off: its SHA256SUMS is not the one the split pinned']);
  fs.rmSync(dir, { recursive: true });
  fs.cpSync(saved, dir, { recursive: true });
  assert.equal((await archiverOf(l2).checkArchive(r.archive)).mark, 'linked', 'put back, it reads as it was split off');
});

// ---------------------------------------------------------------- refused
test('refused: a point under another key, the live log\'s first entry, a point that says `:?`, an open span or a broken entry before it, a head that could not be read, an export or a split running, an archive that exists', async () => {
  // A point under another machine's key: it lies in a span.
  const other = pointed({ key: OTHER_KEY });
  const onB = auditLog(other.file);
  await acceptAll(onB);
  assert.equal((await archiverOf(onB).split(other.point.seq, HOST, '')).error, 'Entry ' + other.point.seq + ' is not an archive point this log can be split at.');
  // The live log's first entry, and an entry that is no point.
  const p = pointed();
  const ar = archiverOf(p.log);
  assert.equal((await ar.split(2, HOST, '')).error, 'Entry 2 is not an archive point this log can be split at.');
  assert.equal((await ar.split(p.point.seq, HOST, '')).ok, true);
  assert.equal((await ar.split(p.point.seq, HOST, '')).error, 'Entry ' + p.point.seq + ' is not an archive point this log can be split at.', 'the live log\'s first entry now');
  // A broken entry before the point.
  const b = pointed();
  const ls = lines(path.join(path.dirname(b.file), rotated(b.file)[0]));
  ls[1] = ls[1].replace('message 2', 'message X');
  fs.writeFileSync(path.join(path.dirname(b.file), rotated(b.file)[0]), ls.join('\n') + '\n');
  assert.equal((await archiverOf(b.log).split(b.point.seq, HOST, '')).error, 'Not split: entry 2 is broken, and a split would make the log read better than it is.');
  // A head that could not be read at this start, and a point whose run's first entry it could not know (`:?`).
  const c = pointed({ before: 3, after: 0 });
  writeOn(c.log, 2);
  c.log.flush();
  const older = path.join(path.dirname(c.file), rotated(c.file)[0]);
  const heads = (f) => typeof f === 'string' && (path.basename(f).startsWith('head-') || path.resolve(f) === path.resolve(older));
  const blind = await failing('readFileSync', 'EBUSY', heads, () => { const l = auditLog(c.file); l.open(); return l; });
  const q = blind.point(HOST, 'blind', 'an event archived while the head could not be read', '');
  blind.flush();
  assert.match(q.target, /:\?$/);
  writeOn(blind, 1);
  blind.flush();
  assert.equal((await archiverOf(blind).split(q.seq, HOST, '')).error, 'This archive point does not say where its run of entries began (the head record could not be read when it was written): split at another point.');
  assert.equal((await archiverOf(blind).split(c.point.seq, HOST, '')).error, 'Not split: the head record could not be read at this start (EBUSY).');
  // A head that cannot be saved (its lane failing): the split says so, with the error's code.
  const saving = pointed();
  saving.log.headLane.lastError = 'EACCES: permission denied, open ' + path.join(recordsOf(saving.file), 'head.json');
  assert.equal((await archiverOf(saving.log).split(saving.point.seq, HOST, '')).error, 'Not split: the head record could not be saved (EACCES).');
  saving.log.headLane.lastError = null;
  // While an export streams, and while a split runs: 409 with who and since when.
  const d = pointed();
  const since = Date.now();
  const busy = archiverOf(d.log, { exporter: { busy: () => ({ by: 'Ana', since }) } });
  const hhmm = (t) => { const x = new Date(t); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
  assert.deepEqual(await busy.split(d.point.seq, HOST, ''), { ok: false, status: 409, error: 'An export is being made for Ana since ' + hhmm(since) + ': split when it ends.' });
  const two = archiverOf(d.log);
  const first = two.split(d.point.seq, ANA, '');
  const second = await two.split(d.point.seq, HOST, '');
  assert.equal(second.status, 409);
  assert.match(second.error, /^A split is being made for ana since \d\d:\d\d: try again when it ends\.$/);
  assert.equal((await first).ok, true);
  // An archive of that name that exists already.
  const e = pointed();
  const name = 'audit-' + e.log.l.slice(0, 8) + '-1-5';
  fs.mkdirSync(path.join(archiveDir(e.file), name), { recursive: true });
  assert.equal((await archiverOf(e.log).split(e.point.seq, HOST, '')).error, 'Not split: ' + path.join('audit-archive', name) + ' already exists.');
  assert.equal(entries(e.file).some((x) => x.action === 'audit.split'), false, 'no row for any refusal');
});

// ---------------------------------------------------------------- after a split, what the data folder's writer can do
test('after a split: the archive removed is ✕ until accepted with its confirmation, ◇ after; a file cut or removed, or archive.json changed, is ✕ "not what was split off"', async () => {
  const p = pointed();
  const r = await archiverOf(p.log).split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  const S = entries(p.file).find((e) => e.action === 'audit.split').seq;
  const moved = copy(dir);
  fs.rmSync(dir, { recursive: true });
  let c = await p.log.verify();
  assert.deepEqual([c.mark, c.findings.map((f) => [f.id, f.kind, f.mark, f.confirm])], ['broken', [['a' + S, 'archive', 'broken', true]]]);
  assert.equal(c.words, 'the archive of entries 1–5 (' + r.archive + ') is not where the split put it: moved off this laptop, or removed');
  const refusedWithout = await p.log.accept({ digest: c.digest, ids: ['a' + S], confirm: [] }, HOST, '');
  assert.match(refusedWithout.error, /^confirm it first: /);
  const acc = await p.log.accept({ digest: c.digest, ids: ['a' + S], confirm: ['a' + S] }, HOST, '');
  assert.equal(acc.ok, true);
  assert.equal(entries(p.file).pop().target, 'a' + S);
  c = await p.log.verify();
  assert.deepEqual([c.mark, c.archives[0].mark], ['linked', 'linked']);
  assert.match(c.words, /^Linked — entries 6–\d+, keyed here, are intact; the archive of entries 1–5 \(.+\) is not where the split put it: moved off this laptop, or removed, accepted on the AGMessage laptop on \d+ \w{3}$/);
  // Changed in place of a move: a file cut short, a file removed, archive.json changed.
  for (const [what, change, want] of [
    ['a file cut', (d) => { const f = path.join(d, 'log', fs.readdirSync(path.join(d, 'log'))[0]); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, -7)); }, /is not what was split off: log\/audit-.*\.jsonl is 7 bytes shorter$/],
    ['a file removed', (d) => { fs.rmSync(path.join(d, 'log', fs.readdirSync(path.join(d, 'log'))[0])); }, /is not what was split off: log\/audit-.*\.jsonl is missing$/],
    ['archive.json changed', (d) => { const f = path.join(d, 'archive.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"name": "AGMessage laptop"', '"name": "someone else"')); }, /is not what was split off: archive\.json is not what its SHA256SUMS says$/],
    ['SHA256SUMS changed', (d) => { fs.appendFileSync(path.join(d, 'SHA256SUMS'), '0'.repeat(64) + '  log/audit-2026-01-01T00-00-00-000Z.jsonl\n'); }, /is not what was split off: its SHA256SUMS is not the one the split pinned$/],
  ]) {
    const q = pointed();
    const qr = await archiverOf(q.log).split(q.point.seq, HOST, '');
    change(path.join(archiveDir(q.file), qr.archive));
    const qc = await q.log.verify();
    assert.equal(qc.mark, 'broken', what);
    assert.match(qc.words, want, what);
    assert.deepEqual(qc.findings.map((f) => f.kind), ['archive'], what);
  }
  // A byte changed in place keeps every size: the routine check (two small reads and a size per file) does not see it;
  // the archive's own Check, and every export, hash each file in full and do.
  const z = pointed();
  const zr = await archiverOf(z.log).split(z.point.seq, HOST, '');
  const zdir = path.join(archiveDir(z.file), zr.archive);
  flip(path.join(zdir, 'log', fs.readdirSync(path.join(zdir, 'log'))[0]), 30);
  const zc = await archiverOf(z.log).checkArchive(zr.archive);
  assert.deepEqual([zc.ok, zc.mark], [false, 'broken']);
  assert.match(zc.why, /^log\/audit-.*\.jsonl is not what was signed: its SHA-256 differs from SHA256SUMS$/);
  const zx = await exported(z.log);
  const zm = JSON.parse(fs.readFileSync(path.join(zx.dir, 'manifest.json')));
  assert.equal(zm.check.mark, 'broken');
  assert.match(zm.check.words, /is not what was split off: log\/audit-.*\.jsonl is not what its SHA256SUMS says$/);
  assert.equal((await verify([zx.dir, '--fingerprint', FP])).code, 2, 'the bundle carries it as it is, and the laptop\'s verdict names it');
  // The removed archive put back where the split put it: found again, and read as it was.
  fs.cpSync(moved, dir, { recursive: true });
  assert.equal((await p.log.verify()).archives[0].finding, undefined);
});

test('after a split: the archived files moved back are walked from entry 1, the archive saying its files are missing; live files removed before a later point no split names are ✕, with a plain split added too', async () => {
  const p = pointed();
  const r = await archiverOf(p.log).split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  for (const f of fs.readdirSync(path.join(dir, 'log'))) fs.renameSync(path.join(dir, 'log', f), path.join(path.dirname(p.file), f));
  const c = await p.log.verify();
  assert.deepEqual([c.from, c.mark], [1, 'broken'], 'the walk from entry 1 is whole; only the archive is found');
  assert.match(c.words, /^the archive of entries 1–5 is not what was split off: log\/audit-.*\.jsonl is missing$/);
  // Two points; the live files from the first to the second removed by hand: no split names the second.
  const q = pointed({ before: 3, after: 2 });
  assert.equal((await archiverOf(q.log).split(q.point.seq, HOST, '')).ok, true);
  const q2 = q.log.point(HOST, 'later', 'the next event', '');
  writeOn(q.log, 2);
  q.log.flush();
  for (const f of rotated(q.file)) fs.rmSync(path.join(path.dirname(q.file), f));
  assert.equal(firstOf(q.file).seq, q2.seq);
  const qc = await auditLog(q.file).verify();
  assert.deepEqual([qc.mark, qc.brokenAt, qc.why], ['broken', 1, 'entries 1 to ' + (q2.seq - 1) + ' are missing: no split names entry ' + q2.seq]);
  // A plain audit.split naming that point, written on as 0.5.1 would and closed by the boundary the next start writes
  // (`audit.unkeyed`): the span is whole, and its split is a claim, so still no split names entry Q.
  const last = entries(q.file).pop();
  const forged = { seq: last.seq + 1, at: last.at + 1, actor: { ...HOST }, action: 'audit.split', target: q2.seq + ';' + '0'.repeat(64), words: 'split here', ip: '', prev: last.h };
  forged.h = audit.hashOf(forged);
  fs.appendFileSync(q.file, JSON.stringify(forged) + '\n');
  const reopened = auditLog(q.file);
  reopened.open();
  reopened.flush();
  assert.deepEqual(entries(q.file).slice(-2).map((e) => [e.action, !!e.k]), [['audit.split', false], ['audit.unkeyed', true]], 'the span is closed');
  const plainSplit = await reopened.verify();
  assert.deepEqual([plainSplit.mark, plainSplit.brokenAt, plainSplit.why], ['broken', 1, 'entries 1 to ' + (q2.seq - 1) + ' are missing: no split names entry ' + q2.seq]);
  // So is one under a made-up key id, MACed under a made-up key and closed by the next start's `audit.rekey`: a keyed split
  // counts only under the key of the point it names.
  const r2 = pointed({ before: 3, after: 2 });
  assert.equal((await archiverOf(r2.log).split(r2.point.seq, HOST, '')).ok, true);
  const p2 = r2.log.point(HOST, 'later', 'the next event', '');
  r2.log.flush();
  for (const f of rotated(r2.file)) fs.rmSync(path.join(path.dirname(r2.file), f));
  const madeUp = h.auditKeys(Buffer.alloc(32, 7))();
  const tail = entries(r2.file).pop();
  const k2 = audit.kidOf(madeUp.entry);
  const onTail = (prev, seq, action, target) => { const e = { seq, at: tail.at + seq, actor: { ...HOST }, action, target, words: 'written under a made-up key', ip: '', prev, l: tail.l, k: k2 }; e.h = audit.macOf(e, madeUp.entry); return e; };
  const rekey = onTail(tail.h, tail.seq + 1, 'audit.rekey', r2.log.kid + ':1');
  const keyed = onTail(rekey.h, tail.seq + 2, 'audit.split', p2.seq + ';' + '0'.repeat(64));
  fs.appendFileSync(r2.file, JSON.stringify(rekey) + '\n' + JSON.stringify(keyed) + '\n');
  const rekeyed = auditLog(r2.file);
  rekeyed.open();
  rekeyed.flush();
  assert.equal(entries(r2.file).pop().action, 'audit.rekey', 'the span is closed');
  const madeUpSplit = await rekeyed.verify();
  assert.deepEqual([madeUpSplit.mark, madeUpSplit.brokenAt, madeUpSplit.why], ['broken', 1, 'entries 1 to ' + (p2.seq - 1) + ' are missing: no split names entry ' + p2.seq]);
});

// ---------------------------------------------------------------- a stop part way
test('a stop part way: a rename refused for the second of three files is recorded and waits; the check reads △ "not finished", never ✕; the next start finishes it', async () => {
  const file = fresh();
  const log = writeOn(auditLog(file), 2);
  for (let i = 0; i < 2; i++) { log.size = 21 * 1024 * 1024; writeOn(log, 2); }
  const point = log.point(HOST, 'three files', EVENT, '');
  writeOn(log, 1);
  log.flush();
  const three = rotated(file);
  assert.equal(three.length, 3);
  let renames = 0;
  const r = await failing('rename', 'EBUSY', (from) => typeof from === 'string' && /audit-\d{4}-.*\.jsonl$/.test(from) && ++renames === 2, () => archiverOf(log).split(point.seq, HOST, ''), { promises: true });
  assert.deepEqual([r.ok, r.status, r.moved, r.waiting, r.waits], [true, 202, 1, 2, true]);
  assert.match(r.words, /^The split is recorded \(entry \d+\), and 2 files wait to move \(EBUSY\): it is finished at the next start, or by Finish the split on Admin → Health\.$/);
  const partial = path.join(archiveDir(file), '.' + 'audit-' + log.l.slice(0, 8) + '-1-6.partial');
  assert.deepEqual(fs.readdirSync(path.join(partial, 'log')), [three[0]]);
  const c = await log.verify();
  assert.deepEqual([c.mark, c.from], ['unvouched', 1], 'walked as one chain: the folder\'s file first, then the live ones');
  assert.match(c.words, /the split at entry 7 is not finished: 2 files still to move \(EBUSY\)/);
  assert.ok(log.conditions().some((x) => x.kind === 'split'));
  // An export meanwhile is refused, and writes nothing.
  const s = http.createServer((req, res) => { res.status = (x) => { res.statusCode = x; return res; }; res.json = (o) => res.end(JSON.stringify(o)); new Exporter({ audit: log, signingKey: () => keyOf(), verifyDir: VERIFY_DIR, version: 't', node: NODE }).run(res, ANA, ''); });
  await new Promise((resolve) => { s.listen(0, '127.0.0.1', resolve); });
  const ex = await fetch('http://127.0.0.1:' + s.address().port + '/', { method: 'POST' });
  s.close();
  assert.deepEqual([ex.status, (await ex.json()).error], [409, 'not exported: the split at entry 7 is not finished: finish it first (Admin → Health)']);
  // The next start: the check after open, then the finish.
  const again = auditLog(file);
  await again.verify();
  const ar = archiverOf(again);
  const done = await ar.finish({ t: 'system', id: '', name: '' }, '', { atStart: true });
  assert.deepEqual([done.ok, done.finished], [true, 1]);
  assert.equal(fs.existsSync(partial), false);
  assert.deepEqual(fs.readdirSync(path.join(archiveDir(file), 'audit-' + log.l.slice(0, 8) + '-1-6', 'log')).sort(), three);
  const fin = entries(file).find((e) => e.action === 'audit.split.finished');
  assert.equal(fin.words, 'the split at entry 7 was finished at this start: 2 files moved after a stop');
  const c2 = await again.verify();
  assert.deepEqual([c2.mark, c2.from, c2.archives.length], ['intact', 7, 1]);
});

test('a stop between the archive made aside and its split: no split pins the folder, which holds no log file; the next start removes it with `audit.split.fail`, nothing moved', async () => {
  const p = pointed();
  const aside = path.join(archiveDir(p.file), '.audit-' + p.log.l.slice(0, 8) + '-1-5.partial');
  fs.mkdirSync(path.join(aside, 'log'), { recursive: true });
  fs.writeFileSync(path.join(aside, 'archive.json'), JSON.stringify({ kind: 'agmessage audit archive', v: 1, point: { seq: p.point.seq } }));
  fs.writeFileSync(path.join(aside, 'SHA256SUMS'), '0'.repeat(64) + '  archive.json\n');
  const live = rotated(p.file);
  const again = auditLog(p.file);
  assert.equal((await again.verify()).mark, 'intact', 'a folder no split pins is not part of the chain');
  const r = await archiverOf(again).finish({ t: 'system', id: '', name: '' }, '', { atStart: true });
  assert.deepEqual([r.ok, r.finished], [true, 0]);
  assert.equal(fs.existsSync(aside), false);
  assert.deepEqual(rotated(p.file), live, 'nothing moved');
  const fail = entries(p.file).pop();
  assert.deepEqual([fail.action, fail.words], ['audit.split.fail', 'a split at entry ' + p.point.seq + ' did not finish before a stop; nothing was moved']);
  // A folder that holds a log file no split pins is left as it is.
  const kept = path.join(archiveDir(p.file), '.audit-' + p.log.l.slice(0, 8) + '-1-3.partial');
  fs.mkdirSync(path.join(kept, 'log'), { recursive: true });
  fs.writeFileSync(path.join(kept, 'log', 'audit-2020-01-01T00-00-00-000Z.jsonl'), 'x\n');
  const r2 = await archiverOf(again).finish(HOST, '', { atStart: true });
  assert.equal(fs.existsSync(kept), true);
  assert.equal(r2.words, 'A split\'s folder (.audit-' + p.log.l.slice(0, 8) + '-1-3.partial) is left as it is: it holds files no split in the log pins.');
  assert.ok(again.attention().some((x) => x.kind === 'split' && x.mark === 'unvouched' && x.words === 'a split\'s folder (.audit-' + p.log.l.slice(0, 8) + '-1-3.partial) is left as it is: it holds files no split in the log pins'), 'health says so');
});

test('a stop part way: a pinned folder that no file reached yet, with the live log broken at the next start, is left as it is and said; nothing is removed, no `audit.split.fail`', async () => {
  const p = pointed({ after: 3 });
  const r = await failing('rename', 'EBUSY', (from) => typeof from === 'string' && /audit-\d{4}-.*\.jsonl$/.test(from), () => archiverOf(p.log).split(p.point.seq, HOST, ''), { promises: true });
  assert.deepEqual([r.ok, r.status, r.moved, r.waiting], [true, 202, 0, 1]);
  const name = 'audit-' + p.log.l.slice(0, 8) + '-1-5';
  const aside = path.join(archiveDir(p.file), '.' + name + '.partial');
  assert.deepEqual(fs.readdirSync(path.join(aside, 'log')), [], 'pinned, and no file moved yet');
  p.log.flush();
  // An entry after the split changed while AGMessage was stopped: the check at the next start breaks there.
  const ls = lines(p.file);
  const i = ls.findIndex((l) => l.includes('"after 3"'));
  assert.ok(i > 0 && JSON.parse(ls[i]).seq > p.point.seq);
  ls[i] = ls[i].replace('after 3', 'after X');
  fs.writeFileSync(p.file, ls.join('\n') + '\n');
  const before = lines(p.file).length;
  const again = auditLog(p.file);
  const c = await again.verify();
  assert.equal(c.mark, 'broken');
  const f = await archiverOf(again).finish({ t: 'system', id: '', name: '' }, '', { atStart: true });
  assert.deepEqual([f.ok, f.finished, f.left], [true, 0, 1]);
  assert.equal(f.words, 'A split\'s folder (.' + name + '.partial) is left as it is: the check did not reach the end of the log, so whether a split pins it is not known.');
  assert.deepEqual(fs.readdirSync(aside).sort(), ['SHA256SUMS', 'SHA256SUMS.sig', 'archive.json', 'log', 'signing-key.pem'], 'its signed files kept');
  assert.equal(lines(p.file).length, before, 'no row: nothing was decided');
  assert.ok(again.attention().some((x) => x.kind === 'split' && /is left as it is: the check did not reach the end of the log/.test(x.words)), 'health says so');
  // Finish the split, outside a start, keeps the same rule.
  const g = await archiverOf(again).finish(HOST, '');
  assert.deepEqual([g.finished, fs.existsSync(aside)], [0, true]);
});

test('a stop part way: every file moved and the folder\'s rename refused reads "its folder is not renamed yet"; the split\'s entry refused by the disk keeps the folder, and the split waits, never ✕', async () => {
  // The folder's own rename refused: every file is in it.
  const p = pointed();
  const r = await failing('rename', 'EBUSY', (from) => typeof from === 'string' && /\.partial$/.test(from), () => archiverOf(p.log).split(p.point.seq, HOST, ''), { promises: true });
  assert.deepEqual([r.ok, r.status, r.moved, r.waiting, r.waits], [true, 202, 1, 0, true]);
  assert.match(r.words, /^The split is recorded \(entry \d+\), and every file is moved, and its folder is not renamed yet \(EBUSY\): it is finished at the next start, or by Finish the split on Admin → Health\.$/);
  const c = await p.log.verify();
  assert.equal(c.mark, 'unvouched');
  assert.match(c.words, /the split at entry 6 is not finished: every file is moved, and its folder is not renamed yet \(EBUSY\)/);
  const done = await archiverOf(p.log).split(p.point.seq, HOST, '');
  assert.deepEqual([done.ok, done.finished], [true, 1], 'Finish the split: the point of the split not finished');
  assert.deepEqual([(await p.log.verify()).mark, p.log.from], ['intact', 6]);

  // Entries waiting for the disk before a split: refused, nothing made.
  const w = pointed();
  await failing('writeSync', 'ENOSPC', () => true, () => writeOn(w.log, 1, () => 'while the disk was full'));
  assert.equal(w.log.unwritten, 1);
  const refused = await archiverOf(w.log).split(w.point.seq, HOST, '');
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 503, 'Not split: 1 entry waits for the disk (ENOSPC): split once the log has written it.']);
  assert.equal(fs.existsSync(archiveDir(w.file)), false, 'nothing made');
  assert.equal((await archiverOf(w.log).points()).points[0].why, 'Not split: 1 entry waits for the disk (ENOSPC): split once the log has written it.');
  w.log.flush();

  // The split's own entry refused: it is chained and cannot be withdrawn, so the folder made aside is kept for it.
  const q = pointed();
  const ar = archiverOf(q.log);
  const real = q.log.write.bind(q.log);
  let split;
  try {
    // The disk refuses that one append: the split's entry, which then waits in memory, chained.
    q.log.write = (actor, action, ...rest) => {
      if (action !== 'audit.split') return real(actor, action, ...rest);
      const host = fs.writeSync;
      fs.writeSync = () => { throw Object.assign(new Error('ENOSPC: stubbed, writeSync'), { code: 'ENOSPC' }); };
      try { return real(actor, action, ...rest); } finally { fs.writeSync = host; }
    };
    split = await ar.split(q.point.seq, HOST, '');
  } finally { q.log.write = real; }
  const name = 'audit-' + q.log.l.slice(0, 8) + '-1-5';
  assert.deepEqual([split.ok, split.status, split.waiting, split.waits, split.moved, split.archive], [false, 503, 1, true, 0, name]);
  assert.equal(split.error, 'The split waits: the log would not take its entry yet (ENOSPC), and nothing has moved. The entry is written ahead of the next one; the split is then finished by Finish the split on Admin → Health, or at the next start.');
  const aside = path.join(archiveDir(q.file), '.' + name + '.partial');
  assert.ok(fs.existsSync(path.join(aside, 'SHA256SUMS')), 'the folder made aside is kept');
  assert.equal(q.log.unwritten, 1);
  assert.equal((await ar.split(q.point.seq, HOST, '')).error, 'Not split: 1 entry waits for the disk (ENOSPC): split once the log has written it.');
  // The disk takes entries again: the split's entry lands ahead of the next one, pinning a split not finished, never an
  // archive missing.
  writeOn(q.log, 1, () => 'the disk is back');
  q.log.flush();
  assert.deepEqual(entries(q.file).slice(-2).map((e) => e.action), ['audit.split', 'display.take']);
  const waiting = await q.log.verify();
  assert.deepEqual([waiting.mark, waiting.findings.filter((x) => x.kind === 'archive')], ['unvouched', []]);
  assert.match(waiting.words, /the split at entry 6 is not finished: 1 file still to move/);
  const fin = await ar.split(q.point.seq, HOST, '');
  assert.deepEqual([fin.ok, fin.finished], [true, 1]);
  const after = await q.log.verify();
  assert.deepEqual([after.mark, after.from, after.archives.map((a) => a.name)], ['intact', 6, [name]]);
  assert.equal(entries(q.file).pop().action, 'audit.split.finished');
});

// ---------------------------------------------------------------- two splits
test('two splits: two archives tile the log, the second naming the first\'s pin; the check names both; the first removed is found through the second; a split made late at the first point, then at the second', async () => {
  const file = fresh();
  const log = writeOn(auditLog(file), 3);
  const p1 = log.point(HOST, 'one', EVENT, '');
  writeOn(log, 2);
  log.flush();
  const ar = archiverOf(log);
  const r1 = await ar.split(p1.seq, HOST, '');
  const p2 = log.point(HOST, 'two', 'the event “Autumn Forum” was archived', '');
  writeOn(log, 2);
  log.flush();
  const r2 = await ar.split(p2.seq, HOST, '');
  assert.deepEqual([r1.entries, r2.entries], [{ from: 1, to: 3 }, { from: p1.seq, to: p2.seq - 1 }], 'they tile entry 1 to the second point');
  const a2 = JSON.parse(fs.readFileSync(path.join(archiveDir(file), r2.archive, 'archive.json')));
  const s1 = entries(path.join(archiveDir(file), r2.archive, ...a2.files[0].path.split('/'))).find((e) => e.action === 'audit.split');
  assert.deepEqual(a2.previous, { name: r1.archive, digest: sha(fs.readFileSync(path.join(archiveDir(file), r1.archive, 'SHA256SUMS'))), split: s1.seq });
  assert.deepEqual([a2.start, JSON.parse(fs.readFileSync(path.join(archiveDir(file), r1.archive, 'archive.json'))).point], [{ seq: p1.seq, prev: p1.prev }, { seq: p1.seq, h: p1.h }]);
  const c = await log.verify();
  assert.deepEqual([c.mark, c.from, c.archives.map((x) => [x.name, x.from, x.to])], ['intact', p2.seq, [[r1.archive, 1, 3], [r2.archive, p1.seq, p2.seq - 1]]]);
  assert.match(c.words, /in 2 archives, intact$/);
  // The older archive checked alone: its point is the first entry of the archive after it.
  const older = await ar.checkArchive(r1.archive);
  assert.deepEqual([older.mark, older.archive.to], ['intact', 3]);
  assert.ok(!/is not on this laptop/.test(older.words), older.words);
  // An export carries both, oldest first, and the verifier walks from entry 1 across them.
  const x = await exported(log, { archiver: ar });
  const m = JSON.parse(fs.readFileSync(path.join(x.dir, 'manifest.json')));
  assert.deepEqual(m.archives.map((a) => [a.name, a.present]), [[r1.archive, true], [r2.archive, true]]);
  const v = await verify([x.dir, '--fingerprint', FP]);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /^✓ whole: entries 1–\d+ \(entries 1–\d+ from 2 archives\) in 3 files, /m);
  fs.rmSync(path.join(archiveDir(file), r1.archive), { recursive: true });
  const gone = await log.verify();
  assert.deepEqual([gone.mark, gone.findings.map((f) => f.id)], ['broken', ['a' + s1.seq]], 'found through the second\'s previous');
  // A split at the first point made after the second was written, then at the second: both named.
  const f2 = fresh();
  const l2 = writeOn(auditLog(f2), 3);
  const q1 = l2.point(HOST, 'one', EVENT, '');
  writeOn(l2, 2);
  const q2 = l2.point(HOST, 'two', EVENT, '');
  writeOn(l2, 1);
  l2.flush();
  const b = archiverOf(l2);
  assert.equal((await b.split(q1.seq, HOST, '')).ok, true);
  assert.equal((await b.split(q2.seq, HOST, '')).ok, true);
  const both = await l2.verify();
  assert.deepEqual([both.mark, both.from, both.archives.length], ['intact', q2.seq, 2]);
});

test('the archive alone, out of reach of the live log (the archive that named it accepted as gone): ◇ at best, and its signer held to this laptop\'s key', async () => {
  const file = fresh();
  const log = writeOn(auditLog(file), 3);
  const p1 = log.point(HOST, 'one', EVENT, '');
  writeOn(log, 2);
  log.flush();
  const ar = archiverOf(log);
  const r1 = await ar.split(p1.seq, HOST, '');
  const p2 = log.point(HOST, 'two', 'the event “Autumn Forum” was archived', '');
  writeOn(log, 2);
  log.flush();
  const r2 = await ar.split(p2.seq, HOST, '');
  assert.equal((await ar.checkArchive(r1.archive)).archive.pinned, true, 'reached through the second archive\'s previous');
  fs.rmSync(path.join(archiveDir(file), r2.archive), { recursive: true });
  const c = await log.verify();
  const id = c.findings[0].id;
  assert.equal((await log.accept({ digest: c.digest, ids: [id], confirm: [id] }, HOST, '')).ok, true);
  await log.verify();
  assert.deepEqual(log.unreached, [r1.archive]);
  const alone = await ar.checkArchive(r1.archive);
  assert.deepEqual([alone.ok, alone.mark, alone.archive.pinned], [false, 'linked', false]);
  assert.match(alone.words, /^Linked — entries 1–3 in the archive audit-[0-9a-f]{8}-1-3, split off on \d+ \w{3}: signed by this laptop's key, every file what its SHA256SUMS says; no split the live log reaches pins it, so it is not shown to be what was split off; 3 entries keyed here checked; its archive point \(entry 4\) is not on this laptop$/);
  // Signed again by a stranger's key, with no pin to hold it to: under this laptop's key id only this laptop's key signs.
  resign(path.join(archiveDir(file), r1.archive), crypto.generateKeyPairSync('ed25519'));
  const stranger = await ar.checkArchive(r1.archive);
  assert.deepEqual([stranger.ok, stranger.mark], [false, 'broken']);
  assert.match(stranger.why, /carries this laptop's key id and is signed by key .+, not this laptop's key: it is not what this laptop split off$/);
});

// ---------------------------------------------------------------- the archive alone
test('the archive alone: Check on the laptop reads ✓ with its MACs checked; the verifier exits 0, 3 on a changed byte or another key, 4 without a key; the page agrees', async () => {
  const p = pointed();
  const r = await archiverOf(p.log).split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  const own = await archiverOf(p.log).checkArchive(r.archive);
  assert.deepEqual([own.ok, own.mark, own.entries, own.archive.name, own.archive.from, own.archive.to], [true, 'intact', 5, r.archive, 1, 5]);
  assert.match(own.words, /^Intact — entries 1–5 in the archive audit-[0-9a-f]{8}-1-5, split off on \d+ \w{3}: signed by this laptop's key, every file what its SHA256SUMS says; 5 entries keyed here checked$/);
  assert.deepEqual(Object.keys(own).slice(-1), ['archive']);
  assert.equal((await archiverOf(p.log).checkArchive('../x')).status, 400);
  const ok = await verify([dir, '--fingerprint', FP, '--list']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^The laptop's own check, run when it split this archive off \(made .+, by AGMessage laptop, AGMessage 0\.6\.0\):$/m);
  assert.match(ok.out, /^ {2}✓ Intact — entries 1–5, keyed on this machine$/m);
  assert.match(ok.out, /^3 {2}\S+ {5}sam {2}display\.take {2}D1 {2}message 3$/m);
  const none = await verify([dir]);
  assert.equal(none.code, 4, none.out);
  assert.match(none.out, /Anyone can make such an archive with a key of their own\. Give --fingerprint \(exit 4\)\.$/m);
  const changed = copy(dir);
  flip(path.join(changed, 'log', fs.readdirSync(path.join(changed, 'log'))[0]), 20);
  const three = await verify([changed, '--fingerprint', FP]);
  assert.equal(three.code, 3, three.out);
  assert.match(three.out, /^Nothing in this archive is vouched for \(exit 3\)\.$/m);
  const otherFp = keyOf(OTHER_KEY).fingerprint;
  const another = await verify([dir, '--fingerprint', otherFp]);
  assert.equal(another.code, 3);
  assert.match(another.out, /not the key you expected/);
  assert.deepEqual([(await onPage(dir, { fp: FP })).code, (await onPage(dir)).code, (await onPage(changed, { fp: FP })).code], [0, 4, 3]);
  assert.equal((await onPage(dir, { fp: FP })).text, '✓ Signed by the key you expected and whole; the laptop said ✓ when it split this archive off.');
  // The README's three commands work inside it, unchanged.
  if (process.platform !== 'win32') {
    const sh = (cmd) => require('child_process').execFileSync('/bin/sh', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    assert.equal(sh('openssl pkey -pubin -in signing-key.pem -outform DER | sha256sum').split(' ')[0], FP);
    assert.match(sh('openssl pkeyutl -verify -pubin -inkey signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig'), /Signature Verified Successfully/);
    assert.match(sh('sha256sum -c SHA256SUMS'), /archive\.json: OK/);
  }
  // A folder of the archive's that is not one: the rules refuse its paths before anything else is read.
  for (const bad of ['../x', 'manifest.json', 'log/audit.jsonl', 'archive/x']) assert.notEqual(rules.pathProblem(bad, 'archive'), '', bad);
  assert.equal(rules.pathProblem('log/audit-2026-10-20T09-12-44-120Z.jsonl', 'archive'), '');
  // An entry's words changed in place, its MAC kept, and the archive re-signed with this laptop's own key to match: whole
  // and signed to the verifier, which holds no key; the laptop's MAC check finds the entry.
  const m = pointed();
  const mr = await archiverOf(m.log).split(m.point.seq, HOST, '');
  const mdir = path.join(archiveDir(m.file), mr.archive);
  resign(mdir, keyOf(), (d) => editArchived(d, 3, 'message 3', 'massage 3'));
  assert.equal((await verifier.check(mdir, { fingerprint: FP })).code, 0, 'the verifier, holding no key, cannot see it');
  const macs = await archiverOf(m.log).checkArchive(mr.archive);
  assert.deepEqual([macs.ok, macs.mark, macs.why], [false, 'broken', 'entry 3 was changed after it was written']);
  // Two Checks of one archive asked together share one walk.
  const ar = archiverOf(p.log);
  const [x1, x2] = [ar.checkArchive(r.archive), ar.checkArchive(r.archive)];
  assert.equal(x1, x2);
  assert.equal((await x1).mark, 'intact');
});

// ---------------------------------------------------------------- the export across a split
test('export across a split: the bundle carries the archive byte for byte and in its SHA256SUMS; the manifest lists it; the verifier walks from entry 1 across it; compare with an export from before the split', async () => {
  const p = pointed();
  const ar = archiverOf(p.log);
  const earlier = await exported(p.log, { archiver: ar });
  const r = await ar.split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  const x = await exported(p.log, { archiver: ar });
  const inBundle = path.join(x.dir, 'archive', r.archive);
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile())) {
    assert.ok(fs.readFileSync(path.join(inBundle, f)).equals(fs.readFileSync(path.join(dir, f))), f + ', byte for byte');
  }
  const sums = rules.parseSums(fs.readFileSync(path.join(x.dir, 'SHA256SUMS'), 'utf8')).list.map((s) => s.path);
  for (const f of ['archive.json', 'signing-key.pem', 'SHA256SUMS', 'SHA256SUMS.sig']) assert.ok(sums.includes('archive/' + r.archive + '/' + f), f);
  const m = JSON.parse(fs.readFileSync(path.join(x.dir, 'manifest.json')));
  const S = entries(p.file).find((e) => e.action === 'audit.split').seq;
  assert.deepEqual([m.entries.from, m.archives], [1, [{ name: r.archive, entries: { from: 1, to: 5 }, split: S, digest: sha(fs.readFileSync(path.join(dir, 'SHA256SUMS'))), present: true }]]);
  assert.deepEqual(Object.keys(m).slice(-1), ['archives'], 'at the end');
  assert.equal(rules.manifestProblem(m), '');
  const row = entries(p.file).filter((e) => e.action === 'audit.export').pop();
  assert.equal(row.target, '1-' + m.entries.to + ';' + FP.slice(0, 16));
  assert.match(row.words, /^export started, for checking on another computer: entries 1–\d+ \(1–5 from 1 archive\), the whole log, this entry its last; /);
  const ok = await verify([x.dir, '--fingerprint', FP, '--list']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^✓ the archive audit-[0-9a-f]{8}-1-5 \(entries 1–5\) is signed by the same key, and every file of it is what its SHA256SUMS says$/m);
  assert.ok(ok.out.includes('\n✓ whole: entries 1–' + m.entries.to + ' (entries 1–5 from 1 archive) in 2 files, '), ok.out);
  assert.match(ok.out, /^1 {2}\S+ {5}sam {2}display\.take {2}D1 {2}message 1$/m, 'entry 1 is listed, from the archive');
  assert.equal((await onPage(x.dir, { fp: FP })).code, 0);
  const same = await verify([x.dir, '--fingerprint', FP, '--earlier', earlier.dir]);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /^✓ the same: entries 1–\d+ of the earlier export \(made .+\) are in this one, byte for byte$/m);
  // A byte changed inside archive/ after the export: 3.
  const bad = copy(x.dir);
  flip(path.join(bad, 'archive', r.archive, 'archive.json'), 40);
  assert.equal((await verify([bad, '--fingerprint', FP])).code, 3);
  // The bundle's paths: archive/../x, an archive name off the pattern, and a link in an archive's log/: 3, nothing opened outside.
  for (const p2 of ['archive/../x', 'archive/audit-xyz-1-5/archive.json', 'archive/' + r.archive + '/notes.txt']) {
    const d = copy(x.dir);
    fs.appendFileSync(path.join(d, 'SHA256SUMS'), '0'.repeat(64) + '  ' + p2 + '\n');
    const v = await verifier.check(d, { fingerprint: FP });
    assert.equal(v.code, 3, p2);
    assert.match(v.why, /^SHA256SUMS names /, p2 + ': ' + v.why);
  }
  if (process.platform !== 'win32') {
    const d = copy(x.dir);
    const logDir = path.join(d, 'archive', r.archive, 'log');
    const f = fs.readdirSync(logDir)[0];
    const outside = tmp('agm-outside-');
    fs.renameSync(path.join(logDir, f), path.join(outside, f));
    fs.symlinkSync(path.join(outside, f), path.join(logDir, f));
    const v = await verifier.check(d, { fingerprint: FP });
    assert.deepEqual([v.code, v.why], [3, 'archive/' + r.archive + '/log/' + f + ' is not a plain file (a link, or a folder)']);
  }
});

test('export across a split: an archive signed by another key is named, not failed; one accepted as gone is listed with its pin, the bundle beginning after it (exit 1)', async () => {
  // The split signed by another signing key (the machine key changed after it), the export by the fixture's.
  const p = pointed();
  const r = await archiverOf(p.log, { machine: OTHER_KEY }).split(p.point.seq, HOST, '');
  const x = await exported(p.log);
  const v = await verify([x.dir, '--fingerprint', FP]);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /^△ the archive audit-[0-9a-f]{8}-1-5 \(entries 1–5\) is signed by key \S{4} \S{4} \S{4} \S{4} … \(its own claim\): the machine key changed after the split$/m);
  assert.ok(v.out.includes('△ the archive ' + r.archive + ' '), v.out);
  // Accepted as gone: listed not present, with its pin; the bundle begins at the point; the verifier says so, exit 1.
  const q = pointed();
  const before = await exported(q.log);
  const qr = await archiverOf(q.log).split(q.point.seq, HOST, '');
  const S = entries(q.file).find((e) => e.action === 'audit.split').seq;
  fs.rmSync(path.join(archiveDir(q.file), qr.archive), { recursive: true });
  const c = await q.log.verify();
  const acc = await q.log.accept({ digest: c.digest, ids: ['a' + S], confirm: ['a' + S] }, HOST, '');
  const gone = await exported(q.log);
  const m = JSON.parse(fs.readFileSync(path.join(gone.dir, 'manifest.json')));
  assert.deepEqual([m.entries.from, m.archives.map((a) => [a.name, a.present, a.split])], [q.point.seq, [[qr.archive, false, S]]]);
  assert.equal(fs.existsSync(path.join(gone.dir, 'archive')), false);
  const one = await verify([gone.dir, '--fingerprint', FP]);
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, /^△ entries 1–5 are not in this bundle: archive audit-[0-9a-f]{8}-1-5, no longer on the laptop \(accepted at entry \d+ on \d+ \w{3}\); its pin is /m);
  assert.ok(one.out.includes('archive ' + qr.archive + ', no longer on the laptop (accepted at entry ' + acc.entry + ' on '), one.out);
  // Compared with an export made before the split: the entries the archive held are named, not failed.
  const cmp = await verify([gone.dir, '--fingerprint', FP, '--earlier', before.dir]);
  assert.equal(cmp.code, 1, cmp.out);
  assert.ok(cmp.out.includes('△ entries 1–5 are not in the later export: their archive was accepted as gone (entry ' + acc.entry + ')'), cmp.out);
  assert.match(cmp.out, /^✓ the same: entries 6–\d+ of the earlier export \(made .+\) are in this one, byte for byte$/m);
  // An archive's folder is no export to compare: refused, either way round.
  assert.equal((await verify([before.dir, '--fingerprint', FP, '--earlier', path.join(archiveDir(p.file), r.archive)])).code, 3);
});

test('export across a split: a live log broken after its split\'s entry still names its archives; the bundle carries them, and the verifier answers 2 where the laptop said it broke', async () => {
  const p = pointed({ after: 2 });
  assert.equal((await archiverOf(p.log).split(p.point.seq, HOST, '')).ok, true);
  writeOn(p.log, 3, (i) => 'later ' + i);
  p.log.flush();
  // Entry 11 (line 6 of the live file, after the split's entry 9) made not a whole line: the walk breaks there.
  const ls = lines(p.file);
  assert.equal(JSON.parse(ls[5]).seq, 11);
  ls[5] = ls[5].slice(0, -1);
  fs.writeFileSync(p.file, ls.join('\n') + '\n');
  const c = await p.log.verify();
  assert.deepEqual([c.mark, c.brokenAt, c.from, c.archives.map((a) => a.mark)], ['broken', 6, p.point.seq, ['intact']], 'the archive is named though the walk broke');
  const x = await exported(p.log);
  const m = JSON.parse(fs.readFileSync(path.join(x.dir, 'manifest.json')));
  assert.deepEqual([m.check.mark, m.entries.from, m.archives.map((a) => a.present)], ['broken', 1, [true]]);
  const v = await verify([x.dir, '--fingerprint', FP]);
  assert.equal(v.code, 2, v.out);
  assert.match(v.out, /^✕ the entries break where the laptop's own check said they do: line 6 of log\/audit\.jsonl is not a whole entry$/m);
});

test('one at a time: an export asked while a split is made waits for it and carries the archive; the split\'s slot names who; an archive not there is said', async () => {
  const p = pointed();
  const ar = archiverOf(p.log);
  const splitting = ar.split(p.point.seq, ANA, '');
  assert.equal(ar.busy().by, 'ana');
  const x = await exported(p.log, { archiver: ar });
  const r = await splitting;
  assert.equal(r.ok, true);
  assert.equal(ar.busy(), null);
  const m = JSON.parse(fs.readFileSync(path.join(x.dir, 'manifest.json')));
  assert.deepEqual(m.archives.map((a) => [a.name, a.present]), [[r.archive, true]], 'the export began once the split had ended');
  const nothing = await ar.checkArchive('audit-' + p.log.l.slice(0, 8) + '-1-2');
  assert.deepEqual([nothing.ok, nothing.mark, nothing.why], [false, 'broken', 'the archive audit-' + p.log.l.slice(0, 8) + '-1-2 is not on this laptop']);
  fs.mkdirSync(path.join(archiveDir(p.file), 'audit-' + p.log.l.slice(0, 8) + '-1-3'));
  assert.match((await ar.checkArchive('audit-' + p.log.l.slice(0, 8) + '-1-3')).why, /^SHA256SUMS is not in the folder/);
  assert.equal((await ar.finish(HOST, '')).words, 'No split waits to be finished.');
});

// ---------------------------------------------------------------- rollback
test('rollback: plain entries written on in the live log after a split (0.5.1 again) read △, ◇ once accepted; the archive is untouched and still named', async () => {
  const p = pointed();
  const r = await archiverOf(p.log).split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  const before = fs.readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? sha(fs.readFileSync(path.join(dir, f))) : '']);
  const last = entries(p.file).pop();
  let prev = last.h;
  const out = [];
  for (let i = 1; i <= 2; i++) {
    const e = { seq: last.seq + i, at: last.at + i, actor: { ...SAM }, action: 'login', target: 'sam', words: 'written by 0.5.1 ' + i, ip: '', prev };
    e.h = audit.hashOf(e);
    prev = e.h;
    out.push(JSON.stringify(e));
  }
  fs.appendFileSync(p.file, out.join('\n') + '\n');
  const back = auditLog(p.file);
  const c = await back.verify();
  assert.deepEqual([c.mark, c.findings.map((f) => f.kind), c.from, c.archives.map((a) => a.name)], ['unvouched', ['unkeyed'], p.point.seq, [r.archive]]);
  await acceptAll(back);
  assert.equal((await back.verify()).mark, 'linked');
  const after = fs.readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? sha(fs.readFileSync(path.join(dir, f))) : '']);
  assert.deepEqual(after, before, 'the archive untouched');
});

// ---------------------------------------------------------------- the rules
test('the rules: a chain begins after entry 1 only at an archive point naming a run of its own key; a split\'s target and a point\'s; archive.json\'s shape', () => {
  const kid = 'ab'.repeat(8);
  const point = { seq: 7, action: 'audit.archive', target: 'x;' + kid + ':3', k: kid, prev: 'c'.repeat(64) };
  assert.deepEqual(rules.beginsAt(point), { kind: kid, first: 3 });
  assert.equal(rules.beginsAt({ ...point, target: 'x;' + 'cd'.repeat(8) + ':3' }), null, 'a run of another key');
  assert.equal(rules.beginsAt({ ...point, k: undefined }), null, 'a plain point');
  assert.equal(rules.beginsAt({ ...point, action: 'audit.split' }), null);
  assert.deepEqual(rules.pointRun('2026-10-27T14-02-00-000Z;' + kid + ':?'), { name: '2026-10-27T14-02-00-000Z', run: { kind: kid, first: '?' } });
  assert.deepEqual(rules.splitOf('2004;' + 'e'.repeat(64)), { point: 2004, digest: 'e'.repeat(64) });
  assert.equal(rules.splitOf('2004;x'), null);
  const chain = new rules.Chain(kid);
  assert.equal(chain.next({ ...point, l: 'l' }), 'entries 1 to 6 are missing before entry 7', 'only where the chain may begin at a point');
  assert.deepEqual([rules.archiveRange('audit-0123abcd-1-2003'), rules.archiveRange('audit-0123abcd-9-3'), rules.archiveRange('audit-x-1-2')], [{ l8: '0123abcd', from: 1, to: 2003 }, null, null]);
  assert.equal(rules.archiveProblem({ kind: 'agmessage audit archive', v: 1 }), 'archive.json has no time it was made');
  assert.equal(rules.archiveProblem(null), 'archive.json is not an object');
  assert.match(rules.manifestProblem({ kind: 'agmessage audit export', v: 1, made: 1, by: { t: '', id: '', name: '' }, node: { id: '', name: '', version: '', build: '' }, log: 'a'.repeat(32), kid, signingKey: { alg: 'Ed25519', fingerprint: 'f'.repeat(64) }, entries: { from: 1, to: 2 }, head: { seq: 2, h: 'f'.repeat(64) }, check: { mark: 'intact', words: '', findings: [] }, files: [{ path: 'log/audit.jsonl', bytes: 1, first: 1, last: 2 }], archives: [{ name: 'nope' }] }), /lists an archive it does not describe/);
});

// ---------------------------------------------------------------- no secret
test('no secret: no key, seed or MAC key of the "no secret" row appears in any file of an archive, in hex or base64', async () => {
  const p = pointed();
  const r = await archiverOf(p.log).split(p.point.seq, HOST, '');
  const dir = path.join(archiveDir(p.file), r.archive);
  const k = h.auditKeys()();
  const seed = secretbox.deriveFrom(FIXTURE_KEY, SIGN);
  const der = keyOf().privateKey.export({ format: 'der', type: 'pkcs8' });
  const secrets = [FIXTURE_KEY, k.entry, k.head, seed, der];
  const all = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('\n');
  for (const s of secrets) {
    for (const form of [s.toString('hex'), s.toString('base64'), s.toString('base64url')]) assert.ok(!all.includes(form), 'a secret, ' + form.slice(0, 6) + '…');
  }
});

// ---------------------------------------------------------------- end to end: the routes, the rights, the readers
/** A server whose log (under the fixture key, in its key folder) holds `n` entries with archive points at `points`. */
async function serverWithPoints(t, n, points, { counted = false } = {}) {
  const dataDir = tmp('agm-e2e-');
  const keyDir = dataDir + '-keys';
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'machine.key'), FIXTURE_KEY.toString('base64'));
  keyedLogWithPoints(n, { file: path.join(dataDir, 'audit.jsonl'), records: path.join(keyDir, 'audit'), points });
  // `counted`: the server's audit work counted (test/audit-preload.js), read through `srv.meter`.
  const meter = counted ? h.auditMeter(dataDir) : null;
  const srv = await h.startServer({ AGM_DATA_DIR: dataDir, ...(meter ? meter.env : {}) });
  t.after(async () => { await h.stopServer(srv.child); if (meter) meter.remove(); });
  if (meter) srv.meter = meter;
  return srv;
}

test('end to end: only the admin splits (the token, an admin account); never a manager, one granted settings.manage, Staff, a code guest or the tunnel; health, /api/audit and the window name the archive', async (t) => {
  let srv = await serverWithPoints(t, 12, [9]);
  const admin = (await h.setupAdmin(srv.base)).cookie;
  const mk = async (username, role, password, grant = []) => {
    const made = await h.api(srv.base, 'POST', '/api/users', { username, name: username, role, grant, password }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const r = await h.api(srv.base, 'POST', '/api/auth/login', { username, password });
    assert.equal(r.status, 200, username);
    return r.cookie;
  };
  const manager = await mk('mia', 'manager', 'running order on the wall');
  const keeper = await mk('kim', 'manager', 'the second follow spot', ['settings.manage']);
  const staff = await mk('sid', 'staff', 'clipboard and coffee');
  const NOT = 'Only an admin may split the audit log.';
  for (const [who, cookie, headers] of [['a manager', manager], ['a manager granted settings.manage', keeper], ['Staff', staff], ['a code guest', ''], ['the tunnel', admin, { 'cf-connecting-ip': '203.0.113.5' }]]) {
    const r = await h.api(srv.base, 'POST', '/api/audit/split', { seq: 9 }, { cookie, headers });
    assert.deepEqual([r.status, r.body.error], [403, NOT], who);
    assert.equal((await h.api(srv.base, 'GET', '/api/audit/split', undefined, { cookie, headers })).status, 403, who);
  }
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: keeper })).body.admin, false, 'the admin page admits the keeper; the split does not');
  // The token at the laptop lists the points; an admin account splits.
  const token = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const listed = await h.api(srv.base, 'GET', '/api/audit/split', undefined, { cookie: token });
  assert.deepEqual(listed.body.points.map((p) => [p.seq, p.event, p.from, p.to, p.why]), [[9, 'Rehearsal 9', 1, 8, undefined]]);
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: token })).body.admin, true);
  const r = await h.api(srv.base, 'POST', '/api/audit/split', { seq: 9 }, { cookie: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.words, /^✓ Split: entries 1–8 are in the archive audit-c0ffee00-1-8 \(1 file, signed\)\. The check starts at entry 9\.$/);
  const health = (await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body.saves.stores.audit;
  assert.deepEqual([health.from, health.archives], [9, 1]);
  assert.deepEqual(Object.keys(health).slice(-4), ['signKey', 'from', 'archives', 'lastExport']);
  const list = (await h.api(srv.base, 'GET', '/api/audit', undefined, { cookie: admin })).body;
  assert.deepEqual([list.archives.map((a) => [a.name, a.from, a.to, a.mark]), list.unreached], [[['audit-c0ffee00-1-8', 1, 8, 'intact']], []]);
  assert.deepEqual(Object.keys(list).slice(-3), ['key', 'archives', 'unreached']);
  const row = list.entries.find((e) => e.action === 'audit.split');
  assert.deepEqual([row.actor.name, row.target.split(';')[0], row.mark], ['ana', '9', 'intact']);
  const one = await h.api(srv.base, 'GET', '/api/audit/verify?archive=audit-c0ffee00-1-8', undefined, { cookie: admin });
  assert.deepEqual([one.body.ok, one.body.mark, one.body.archive.name], [true, 'intact', 'audit-c0ffee00-1-8']);
  assert.equal((await h.api(srv.base, 'GET', '/api/audit/verify?archive=audit-c0ffee00-1-8', undefined, { cookie: staff })).status, 403, 'audit.read');
  // After a restart, the black window names where the check begins.
  srv = await h.restartServer(srv);
  t.after(async () => { await h.stopServer(srv.child); });
  await h.until(() => /Audit log: {3}keyed \(key [0-9a-f]{16}\) · from entry 9, 1 archive · Admin → Health/.test(srv.out()), 8000, 'the from line');
});

// A split, and an archive's own Check, in a real server, counted as work by test/audit-preload.js, never timed: how long
// a turn of the loop takes is the machine's (a busy one stretches it), how much a turn does is the code's. A page asking
// meanwhile is read and answered at each turn. The split's check walks at most 1,000 lines between two turns
// (lib/audit.js's SLICE), and the split takes each file's SHA-256 whole, in the turn its read ends: never more than one
// file's bytes between two turns (a file is at most the rotation's 20 MB and the entry that passed it). An archive's own
// Check walks its entries with the verifier and then MAC-checks them, each at most 1,000 between two turns, and hashes
// each file whole as its read ends. Both read the log through fs.promises, one read at a time: one of the thread pool's
// four threads, the rest left to a sign-in's password check. And a sign-in is answered while the split holds its slot,
// waiting to read: it waits for nothing the split holds.
test('speed: a split of the 56,000-entry log at entry 50,000 walks at most 1,000 entries and hashes at most one file between two turns of the event loop, reads the log off the loop one read at a time, and a sign-in is answered while it holds its slot; the check after walks about 6,000 entries; the archive\'s own Check walks and MAC-checks at most 1,000 entries between two turns', async (t) => {
  const srv = await serverWithPoints(t, 56_000, [50_000], { counted: true });
  const admin = (await h.setupAdmin(srv.base)).cookie;
  await h.api(srv.base, 'POST', '/api/users', { username: 'bob', name: 'Bob', role: 'staff', password: 'clipboard and coffee' }, { cookie: admin });
  assert.equal((await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin })).status, 200, 'the check at start, or one after it, answered: no walk runs now');
  // The seed's two files: entries 1-49,999, the one the split moves, and the live one from the archive point on.
  const sizes = fs.readdirSync(srv.dataDir).filter((f) => /^audit[^/\\]*\.jsonl$/.test(f)).map((f) => fs.statSync(path.join(srv.dataDir, f)).size);
  const largest = Math.max(...sizes);
  assert.equal(sizes.length, 2, 'the seed is two files');
  const splitting = h.api(srv.base, 'POST', '/api/audit/split', { seq: 50_000 }, { cookie: admin, headers: { 'x-agm-test-hold': 'sign-in' } });
  await h.until(() => srv.meter.waiting() > 0, 20_000, 'the split waiting to read the log');
  const signIn = await h.api(srv.base, 'POST', '/api/auth/login', { username: 'bob', password: 'clipboard and coffee' });
  assert.equal(signIn.status, 200, 'a sign-in while the split holds its slot: ' + JSON.stringify(signIn.body));
  const r = await splitting;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = srv.meter.seen();
  const said = JSON.stringify(w);
  assert.equal(w.opened, 'sign-in', 'the sign-in was answered while the split waited to read the log: ' + said);
  assert.deepEqual([w.walks, w.atOnce], [2, 1], 'the split\'s own check, then the check after it, one at a time: ' + said);
  assert.ok(w.lines >= 56_000 + 6_000, 'the split\'s check walked the whole log, and the check after it the live log: ' + said);
  assert.ok(w.most.lines > 0 && w.most.lines <= 1000, 'at most 1,000 lines between two turns of the loop: ' + said);
  assert.ok(w.digested >= sizes.reduce((a, b) => a + b, 0), 'each file of the log was hashed, and counted: ' + said);
  assert.ok(w.most.digested > 0 && w.most.digested <= largest, 'at most one file of the log hashed between two turns of the loop (' + largest + ' bytes): ' + said);
  assert.ok(w.turns >= Math.ceil(w.lines / 1000), 'the loop turned at least once per 1,000 lines: ' + said);
  assert.deepEqual([w.syncReads, w.asyncReads > 0, w.reading], [0, true, 1], 'the log read off the event loop, one read at a time: ' + said);
  const c = (await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin })).body;
  assert.deepEqual([c.mark, c.from], ['intact', 50_000]);
  assert.ok(c.entries > 6000 && c.entries < 6100, 'the check walks the live log only: ' + c.entries);
  // The archive's own Check: its 49,999 entries walked by the verifier, then each MAC-checked.
  const own = await h.api(srv.base, 'GET', '/api/audit/verify?archive=' + r.body.archive, undefined, { cookie: admin, headers: { 'x-agm-test-hold': '1' } });
  assert.deepEqual([own.body.mark, own.body.entries, own.body.archive.pinned], ['intact', 49_999, true]);
  const a = srv.meter.seen();
  const aSaid = JSON.stringify(a);
  assert.deepEqual([a.walks, a.lines, a.macs], [0, 49_999, 49_999], 'each entry walked once by the verifier and MAC-checked once, and no check of the live log: ' + aSaid);
  assert.ok(a.most.lines > 0 && a.most.lines <= 1000, 'at most 1,000 entries walked between two turns of the loop: ' + aSaid);
  assert.ok(a.most.macs > 0 && a.most.macs <= 1000, 'at most 1,000 entries MAC-checked between two turns of the loop: ' + aSaid);
  assert.ok(a.digested >= largest, 'the archive\'s file was hashed, and counted: ' + aSaid);
  assert.ok(a.most.digested > 0 && a.most.digested <= largest, 'at most one file hashed between two turns of the loop: ' + aSaid);
  assert.ok(a.turns >= Math.ceil(a.lines / 1000) + Math.ceil(a.macs / 1000) - 1, 'the loop turned at least once per 1,000 entries of each: ' + aSaid);
  assert.deepEqual([a.syncReads, a.asyncReads > 0, a.reading], [0, true, 1], 'the archive read off the event loop, one read at a time: ' + aSaid);
});
