'use strict';
// The audit chain keyed with a key derived from the machine key (lib/audit.js, verify/auditrules.js, lib/secretbox.js):
// the keyed entry and what a whole line is, the keys, a 0.5.1 log at its first keyed start, the records outside the data
// folder, a moved log and the log written last, another machine's key, a run with no key, Accept, a rollback, the data
// folder's lock, and no secret anywhere. Every answer is asserted by its fields: the mark, the findings, the entries.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const audit = require('../lib/audit');
const rules = require('../verify/auditrules');
const secretbox = require('../lib/secretbox');
const { placeId } = require('../lib/resilience');
const { BUILD } = require('../lib/version');
const h = require('./helpers');

const { auditLog, recordsOf, chainOf, keyedChainOf, acceptAll, brief, FIXTURE_KEY, OTHER_KEY, HOST } = h;
const fresh = (t) => path.join(h.tmpDir(t, 'agm-audit-'), 'audit.jsonl');
const SAM = { t: 'account', id: 'a1', name: 'sam' };
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const entries = (file) => lines(file).map((l) => JSON.parse(l));
const put = (file, list) => fs.writeFileSync(file, list.join('\n') + '\n');
const ids = (r) => r.findings.map((f) => f.id);
const kinds = (r) => r.findings.map((f) => f.kind);
const actionsOf = (file) => entries(file).map((e) => e.action);
const headOf = (file, records = recordsOf(file)) => {
  const l = entries(file).filter((e) => e.l).pop().l;
  return JSON.parse(fs.readFileSync(path.join(records, 'head-' + l + '.json'), 'utf8'));
};
/** A keyed log of `n` entries written by this machine, flushed: its file, its log and its lines. */
function written(t, n, file = fresh(t), key = FIXTURE_KEY) {
  const log = auditLog(file, { key });
  for (let i = 1; i <= n; i++) log.write(SAM, 'display.take', 'D1', 'message ' + i, '10.0.0.9');
  log.flush();
  return { file, log, lines: lines(file) };
}
/** `n` entries appended with plain hashes after the log's newest, as AGMessage 0.5.1 writes on a keyed log. */
function plainAfter(file, n) {
  const last = entries(file).pop();
  let prev = last.h;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = { seq: last.seq + i, at: last.at + i, actor: { ...SAM }, action: 'login', target: 'sam', words: 'written by 0.5.1 ' + i, ip: '', prev };
    e.h = audit.hashOf(e);
    prev = e.h;
    out.push(JSON.stringify(e));
  }
  fs.appendFileSync(file, out.join('\n') + '\n');
}
/** The fs call `name` throws `code` while `when(args)` holds, for the length of `fn`. */
async function failing(name, code, when, fn) {
  const real = fs[name];
  fs[name] = (...args) => {
    if (when(...args)) throw Object.assign(new Error(code + ': stubbed, ' + name), { code });
    return real.apply(fs, args);
  };
  try { return await fn(); } finally { fs[name] = real; }
}
const at = (file) => (p) => typeof p === 'string' && path.resolve(p) === path.resolve(file);
/** Put AGM_KEY_DIR back as it was: unset stays unset (assigning undefined would set the word). */
const restoreKeyDir = (was) => { if (was === undefined) delete process.env.AGM_KEY_DIR; else process.env.AGM_KEY_DIR = was; };

// ---------------------------------------------------------------- the keyed chain
test('keyed chain: each entry carries the log id, the key id and an HMAC under Ke; edits, a 0.5.1 forgery and relabels are found', async (t) => {
  const a = written(t, 6);
  const ke = h.auditKeys()().entry;
  const es = entries(a.file);
  for (const e of es) {
    assert.deepEqual(Object.keys(e), rules.KEYED_KEYS, 'written in this order');
    assert.match(e.l, /^[0-9a-f]{32}$/);
    assert.equal(e.k, audit.kidOf(ke));
    assert.equal(e.h, audit.macOf(e, ke), 'h is the HMAC of canonical2 under Ke');
    assert.notEqual(e.h, audit.hashOf(e), 'never a plain hash');
  }
  assert.equal(new Set(es.map((e) => e.l)).size, 1, 'one log, one id');
  assert.deepEqual(brief(await a.log.verify()), { ok: true, mark: 'intact', entries: 6 });

  const variant = async (change) => { const b = written(t, 6); put(b.file, change(b.lines)); return { b, r: await auditLog(b.file).verify() }; };
  let { r } = await variant((l) => l.map((x, i) => (i === 2 ? x.replace('message 3', 'message X') : x)));
  assert.deepEqual([r.ok, r.mark, r.brokenAt], [false, 'broken', 3]);
  assert.match(r.why, /entry 3 was changed after it was written/);
  ({ r } = await variant((l) => l.filter((_, i) => i !== 3)));
  assert.match(r.why, /entry 4 is missing before entry 5/);
  ({ r } = await variant((l) => { const s = l.slice(); [s[1], s[2]] = [s[2], s[1]]; return s; }));
  assert.equal(r.mark, 'broken');

  // The 0.5.1 forgery: entries 3 to 6 written again with plain SHA-256 hashes, linked as 0.5.1 links them. Without the key
  // that is all a writer can do, and it is found: the head's entry 6 is not the log's, and 3 to 6 are a span.
  ({ r } = await variant((l) => {
    let prev = JSON.parse(l[1]).h;
    return l.map((x, i) => {
      if (i < 2) return x;
      const { l: _l, k: _k, h: _h, ...e } = JSON.parse(x);
      e.prev = prev;
      e.h = audit.hashOf(e);
      prev = e.h;
      return JSON.stringify(e);
    });
  }));
  assert.equal(r.mark, 'broken', JSON.stringify(r).slice(0, 300));
  assert.ok(kinds(r).includes('fork') && kinds(r).includes('unkeyed'), JSON.stringify(kinds(r)));

  // Not whole: a repeated key, an extra field, reordered actor keys, an upper-case key id.
  for (const [what, edit] of [
    ['a repeated key', (x) => x.replace('{"seq":3,', '{"seq":3,"seq":3,')],
    ['an extra field', (x) => x.replace(',"h":"', ',"x":1,"h":"')],
    ['reordered actor keys', (x) => x.replace('"actor":{"t":"account","id":"a1","name":"sam"}', '"actor":{"id":"a1","t":"account","name":"sam"}')],
    ['an upper-case key id', (x) => x.replace(/"k":"([0-9a-f]{16})"/, (_, k) => '"k":"' + k.toUpperCase() + '"')],
  ]) {
    ({ r } = await variant((l) => l.map((x, i) => (i === 2 ? edit(x) : x))));
    assert.deepEqual([r.mark, r.brokenAt, r.why], ['broken', 3, 'line 3 is not a whole entry'], what);
  }
  // A middle line relabelled with a made-up key id and new words, its h kept: no boundary names the run before it.
  ({ r } = await variant((l) => l.map((x, i) => (i === 2 ? x.replace(/"k":"[0-9a-f]{16}"/, '"k":"deadbeefdeadbeef"').replace('message 3', 'nothing happened') : x))));
  assert.deepEqual([r.mark, r.brokenAt], ['broken', 3]);
  assert.match(r.why, /entry 3 changes the key without a boundary/);
  // The newest entries relabelled, their h kept.
  ({ r } = await variant((l) => l.map((x, i) => (i >= 4 ? x.replace(/"k":"[0-9a-f]{16}"/, '"k":"deadbeefdeadbeef"') : x))));
  assert.deepEqual([r.mark, r.brokenAt], ['broken', 5]);

  // A recent row edited while stopped, its h kept, reads ✕ in the list before any check.
  const c = written(t, 4);
  put(c.file, c.lines.map((x, i) => (i === 1 ? x.replace('message 2', 'message Z') : x)));
  const rows = auditLog(c.file).latest(10);
  assert.deepEqual(rows.filter((e) => e.seq <= 4).map((e) => [e.seq, e.mark]), [[4, 'intact'], [3, 'intact'], [2, 'broken'], [1, 'intact']]);
  // A line that is not whole is said as one, never drawn as an entry.
  put(c.file, [...c.lines.slice(0, 3), '{"seq":4,"at":"not a time"}']);
  const bad = auditLog(c.file).latest(10).find((e) => e.line === 4);
  assert.deepEqual(bad, { line: 4, file: 'audit.jsonl', mark: 'broken', words: 'line 4 of audit.jsonl is not a whole entry' });
});

test('keyed chain: the entry this machine recorded last, under a made-up key id with its hash kept, is a changed entry: ✕ at every check, never a span, never accepted', async (t) => {
  const made = 'deadbeefdeadbeef';
  /** Entry i (0-based) as a keyed line under `k`, the fields in their written order. */
  const line = (e, k) => JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, words: e.words, ip: e.ip, prev: e.prev, l: e.l, k, h: e.h });
  const refused = async (log) => {
    const c = await log.verify();
    const x = await log.accept({ digest: c.digest, ids: ids(c), confirm: ids(c) }, HOST, '');
    assert.deepEqual([x.ok, x.status], [false, 409], JSON.stringify(x));
    assert.match(x.error, /a broken entry is never accepted/);
  };
  // The newest two relabelled, their h kept; the first of them dressed as a boundary naming this machine's run.
  const a = written(t, 6);
  const own = entries(a.file)[0].k;
  put(a.file, entries(a.file).map((e, i) => {
    if (i < 4) return a.lines[i];
    if (i === 4) return line({ ...e, action: 'audit.rekey', target: own + ':1', words: 'nothing happened' }, made);
    return line({ ...e, words: 'nothing happened either' }, made);
  }));
  const b = auditLog(a.file);
  let r = await b.verify();
  assert.deepEqual([r.ok, r.mark, r.brokenAt, r.findings], [false, 'broken', 6, []], JSON.stringify(r).slice(0, 300));
  assert.equal(r.why, 'entry 6 was changed after it was written: it carries the hash this machine recorded for its entry 6, under key id dead… (their own claim), not this machine\'s key');
  assert.ok(!actionsOf(a.file).slice(6).includes('audit.rekey'), 'no boundary vouches for the run the changed entry stands in');
  assert.deepEqual(b.attention().map((f) => [f.kind, f.mark, f.id]), [['broken', 'broken', undefined]], 'health reads ✕, with nothing to accept');
  await refused(b);
  // A restart after this machine wrote on: still ✕, at the first entry of its own after the changed run.
  b.write(SAM, 'login', 'sam', 'after the change');
  b.flush();
  const c = auditLog(a.file);
  r = await c.verify();
  assert.deepEqual([r.mark, r.findings], ['broken', []]);
  assert.equal(r.why, 'entry 7 changes the key without a boundary that names the run before it (deadbeefdeadbeef:5)');
  await refused(c);

  // The newest entries cut, and the log padded up to the head's seq with entries under a made-up key, the last with the
  // head's h: the same changed entry, never a cut a person may accept.
  const p = written(t, 6);
  const es = entries(p.file);
  const pad5 = { ...es[4], action: 'audit.rekey', target: own + ':1', words: 'padding' };
  pad5.h = crypto.createHmac('sha256', 'a key nobody has').update(rules.canonical2({ ...pad5, k: made })).digest('hex');
  const pad6 = { ...es[5], prev: pad5.h, words: 'padding too' };
  put(p.file, [...p.lines.slice(0, 4), line(pad5, made), line(pad6, made)]);
  r = await auditLog(p.file).verify();
  assert.deepEqual([r.mark, r.brokenAt, r.findings], ['broken', 6, []]);
  assert.match(r.why, /^entry 6 was changed after it was written: it carries the hash this machine recorded for its entry 6/);
  await refused(auditLog(p.file));
});

test('the check: a chain broken at a line is what health and the console read until a whole check replaces it', async (t) => {
  const a = written(t, 6);
  put(a.file, a.lines.map((x, i) => (i === 1 ? x.replace('message 2', 'message X') : x)));
  const b = auditLog(a.file);
  b.open();
  assert.deepEqual(b.attention(), [], 'open() reads only the tail: nothing yet');
  const r = await b.verify();   // as the server checks at start
  assert.equal(r.why, 'entry 2 was changed after it was written');
  assert.deepEqual(b.facts().attention, [{ kind: 'broken', mark: 'broken', words: 'Broken at line 2 of audit.jsonl: entry 2 was changed after it was written' }]);
  // Put back as it was: the next whole check replaces the verdict.
  put(a.file, [...a.lines, ...lines(a.file).slice(6)]);
  assert.equal((await b.verify()).mark, 'intact');
  assert.deepEqual(b.facts().attention, []);
});

test('the records: a start that writes no entry writes no record, so an empty start and stop reads ✓ next time and a 0.5.1 log copied in after it is still asked about', async (t) => {
  const file = fresh(t);
  const records = recordsOf(file);
  const empty = auditLog(file);
  empty.open();
  empty.flush();
  assert.ok(!fs.existsSync(records) || fs.readdirSync(records).length === 0, 'no record of a log with no entry');
  const again = auditLog(file);
  again.open();
  assert.deepEqual(again.attention(), []);
  assert.deepEqual(brief(await again.verify()), { ok: true, mark: 'intact', entries: 0 });
  again.flush();
  // A trial start, then 0.5.1's data copied in: the first start's question, as if the trial never ran.
  fs.writeFileSync(file, chainOf(5));
  const seeded = auditLog(file);
  const s = await seeded.verify();
  assert.deepEqual([entries(file)[5].action, entries(file)[5].target], ['audit.keyed', 'plain:1;first']);
  assert.deepEqual(s.findings.map((f) => [f.id, f.kind, f.first]), [['s1-5', 'plain', true]]);

  // A 0.5.1 log whose boundary the disk would not take: nothing names the new log id, so nothing is recorded, and the
  // next start finds the same log and asks the same question.
  const p = fresh(t);
  fs.writeFileSync(p, chainOf(3));
  await failing('openSync', 'ENOSPC', at(p), () => { const log = auditLog(p); log.open(); log.flush(); });
  assert.ok(!fs.existsSync(recordsOf(p)) || fs.readdirSync(recordsOf(p)).length === 0, 'nothing recorded while no entry carries the log\'s id');
  const back = auditLog(p);
  const br = await back.verify();
  assert.deepEqual(br.findings.map((f) => [f.id, f.kind, f.first]), [['s1-3', 'plain', true]]);
  back.flush();
  assert.ok(fs.readdirSync(recordsOf(p)).some((f) => f.startsWith('head-')), 'once an entry carries it, the records are written');
});

test('the log refuses to start without its keys and its records folder, and makes nothing', (t) => {
  const dir = path.join(h.tmpDir(t, 'agm-refuse-'), 'data');
  const file = path.join(dir, 'audit.jsonl');
  const records = path.join(h.tmpDir(t, 'agm-refuse-'), 'audit');
  for (const o of [undefined, {}, { keys: h.auditKeys() }, { records }, { keys: 'a key', records }, { keys: h.auditKeys(), records: '' }]) {
    assert.throws(() => new audit.AuditLog(file, o), /the audit log needs its keys and its records folder/, JSON.stringify(o && Object.keys(o)));
  }
  assert.ok(!fs.existsSync(dir), 'no data folder made');
  assert.ok(!fs.existsSync(records), 'no records folder made');
});

test('the rules that need no key: the runs a boundary names, and the two canonical forms that never meet', () => {
  const runs = new rules.Runs();
  const e = (seq, k, action = 'x', target = '') => ({ seq, k, action, target });
  assert.equal(runs.next(e(1, '')), '');
  assert.equal(runs.next(e(2, '')), '');
  assert.match(runs.next(e(3, 'aaaaaaaaaaaaaaaa', 'audit.keyed', 'plain:2')), /without a boundary that names the run before it \(plain:1\)/, 'a boundary that names another run');
  assert.equal(new rules.Runs().next(e(1, '')) + (() => { const r = new rules.Runs(); r.next(e(1, '')); return r.next(e(2, 'aaaaaaaaaaaaaaaa', 'audit.keyed', 'plain:1;first')); })(), '');
  const r2 = new rules.Runs(); r2.next(e(1, 'aaaaaaaaaaaaaaaa')); r2.next(e(2, ''));
  assert.match(r2.next(e(3, 'aaaaaaaaaaaaaaaa', 'audit.keyed', 'plain:2')), /without a boundary/, '`audit.keyed` ends only plain entries from entry 1');
  assert.equal(r2.next(e(3, 'aaaaaaaaaaaaaaaa', 'audit.unkeyed', 'plain:2')), '', '`audit.unkeyed` ends plain entries after keyed ones');
  assert.match(r2.next(e(4, 'bbbbbbbbbbbbbbbb', 'audit.unkeyed', 'aaaaaaaaaaaaaaaa:3')), /without a boundary/, '`audit.unkeyed` never ends a keyed run');
  assert.equal(r2.next(e(4, 'bbbbbbbbbbbbbbbb', 'audit.rekey', 'aaaaaaaaaaaaaaaa:3')), '');
  assert.deepEqual(rules.parseRef('3fa2c1d0e9b8a7f6:812;first'), { kind: '3fa2c1d0e9b8a7f6', first: 812 });
  assert.equal(rules.parseRef('plain:0'), null);
  const x = { seq: 1, at: 2, actor: { t: 'a', id: 'b', name: 'c' }, action: 'd', target: 'e', words: 'f', ip: 'g', prev: rules.GENESIS, l: 'a'.repeat(32), k: 'b'.repeat(16) };
  assert.notEqual(rules.canonical(x), rules.canonical2(x));
  assert.equal(rules.wholeEntry('[1]'), null);
  assert.equal(rules.wholeEntry(null), null);
});

// ---------------------------------------------------------------- the keys
test('keys: two machine keys give two key ids and two fingerprints; one key folder, one fingerprint; labels are allow-listed', (t) => {
  const was = process.env.AGM_KEY_DIR;
  try {
    const facts = [h.tmpDir(t, 'agm-key-'), h.tmpDir(t, 'agm-key-')].map((d) => {
      process.env.AGM_KEY_DIR = d;
      secretbox._reset();
      const ke = secretbox.derive(audit.LABELS.entry);
      return { d, ke, kh: secretbox.derive(audit.LABELS.head), seed: secretbox.derive('agmessage audit sign v1'), kid: audit.kidOf(ke), fp: secretbox.signingKey().fingerprint };
    });
    assert.notEqual(facts[0].kid, facts[1].kid);
    assert.notEqual(facts[0].fp, facts[1].fp);
    for (const f of facts) {
      assert.match(f.kid, /^[0-9a-f]{16}$/);
      assert.ok(!f.ke.toString('hex').startsWith(f.kid), 'the key id is not a prefix of the key');
      assert.ok(!f.ke.equals(f.kh) && !f.ke.equals(f.seed) && !f.kh.equals(f.seed), 'Ke, Kh and the signing seed differ');
      assert.match(f.fp, /^[0-9a-f]{64}$/);
    }
    process.env.AGM_KEY_DIR = facts[0].d;
    secretbox._reset();
    const sk = secretbox.signingKey();
    assert.equal(sk.fingerprint, facts[0].fp, 'one key folder, one fingerprint, across restarts');
    assert.equal(crypto.createHash('sha256').update(sk.publicKey.export({ format: 'der', type: 'spki' })).digest('hex'), sk.fingerprint, 'the SHA-256 of the SPKI DER');
    const sig = crypto.sign(null, Buffer.from('SHA256SUMS'), sk.privateKey);
    assert.ok(crypto.verify(null, Buffer.from('SHA256SUMS'), sk.publicKey, sig), 'pure Ed25519');
    assert.ok(secretbox.signingKeyFrom(Buffer.alloc(32, 1)).spki.equals(secretbox.signingKeyFrom(Buffer.alloc(32, 1)).spki), 'one seed, one key');
    assert.throws(() => secretbox.derive('agmessage something else'), /no key is derived/);
    assert.throws(() => secretbox.deriveFrom(FIXTURE_KEY, ''), /no key is derived/);
    assert.equal(fs.readdirSync(facts[0].d).join(), 'machine.key', 'nothing but the key itself: no signing key file');
  } finally { restoreKeyDir(was); secretbox._reset(); }
});

test('no key: a link the key folder refuses, a key that cannot be read and a short key each make a keyless run and leave the file as it is', async (t) => {
  const was = process.env.AGM_KEY_DIR;
  try {
    // A key folder that cannot hold a hard link (FAT, exFAT): no key is published, and the words name the code and the folder.
    const d = h.tmpDir(t, 'agm-key-');
    process.env.AGM_KEY_DIR = d;
    secretbox._reset();
    await failing('linkSync', 'EPERM', () => true, () => {
      assert.equal(secretbox.hasKey(), false);
      assert.deepEqual(secretbox.keyProblem(), { code: 'EPERM', words: 'the key folder ' + d + ' cannot publish the machine key (EPERM): it needs an NTFS drive' });
      assert.throws(() => secretbox.seal('swk_x'), (e) => e.code === 'EPERM' && e.noKey === true);
      assert.throws(() => secretbox.derive(audit.LABELS.entry), (e) => e.code === 'EPERM');
    });
    assert.deepEqual(fs.readdirSync(d), [], 'no key and no temporary file left');
    // EBUSY and EACCES: the key is never read, never replaced.
    for (const code of ['EBUSY', 'EACCES']) {
      const k = h.tmpDir(t, 'agm-key-');
      const keyFile = path.join(k, 'machine.key');
      fs.writeFileSync(keyFile, FIXTURE_KEY.toString('base64'));
      const before = fs.readFileSync(keyFile);
      process.env.AGM_KEY_DIR = k;
      secretbox._reset();
      await failing('readFileSync', code, at(keyFile), () => {
        assert.equal(secretbox.hasKey(), false);
        assert.equal(secretbox.keyProblem().code, code);
        assert.equal(secretbox.open('enc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '');   // secret-scan: fixture — zeros in a sealed value's shape, sealed by no key
      });
      assert.deepEqual(fs.readFileSync(keyFile), before, code + ': its bytes are unchanged');
      assert.deepEqual(fs.readdirSync(k), ['machine.key']);
    }
    // A key that is not 32 bytes is not replaced.
    const s = h.tmpDir(t, 'agm-key-');
    fs.writeFileSync(path.join(s, 'machine.key'), 'c2hvcnQ=');
    process.env.AGM_KEY_DIR = s;
    secretbox._reset();
    assert.equal(secretbox.hasKey(), false);
    assert.equal(secretbox.keyProblem().code, 'EBADKEY');
    assert.equal(fs.readFileSync(path.join(s, 'machine.key'), 'utf8'), 'c2hvcnQ=');
  } finally { restoreKeyDir(was); secretbox._reset(); }
});

test('no key: two first starts at once keep one machine key', async (t) => {
  const d = h.tmpDir(t, 'agm-key-');
  const script = 'const b = require(' + JSON.stringify(path.join(__dirname, '..', 'lib', 'secretbox.js')) + '); process.stdout.write(b.derive("agmessage audit entry v1").toString("hex"));';
  const one = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { env: { ...process.env, AGM_KEY_DIR: d }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (x) => { out += x; });
    c.on('exit', () => resolve(out));
  });
  const keys = await Promise.all([one(), one(), one(), one()]);
  assert.equal(new Set(keys).size, 1, 'every start derives from one key: ' + keys.join(' '));
  assert.match(keys[0], /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readdirSync(d), ['machine.key'], 'one key, no temporary file left');
  // A start that made its own key meets one published meanwhile: it reads that one.
  const e = h.tmpDir(t, 'agm-key-');
  const was = process.env.AGM_KEY_DIR;
  try {
    process.env.AGM_KEY_DIR = e;
    secretbox._reset();
    const realLink = fs.linkSync;
    fs.linkSync = (from, to) => { fs.writeFileSync(to, OTHER_KEY.toString('base64')); return realLink(from, to); };
    let derived;
    try { derived = secretbox.derive(audit.LABELS.entry); } finally { fs.linkSync = realLink; }
    assert.ok(derived.equals(secretbox.deriveFrom(OTHER_KEY, audit.LABELS.entry)), 'the key another start published');
    assert.equal(fs.readFileSync(path.join(e, 'machine.key'), 'utf8'), OTHER_KEY.toString('base64'));
  } finally { restoreKeyDir(was); secretbox._reset(); }
});

// ---------------------------------------------------------------- a 0.5.1 log at its first keyed start
test('legacy then keyed: the first keyed start writes `audit.keyed …;first`, reads △ with one plain finding, and ◇ once accepted', async (t) => {
  const file = fresh(t);
  fs.writeFileSync(file, chainOf(5));
  const log = auditLog(file);
  const r = await log.verify();
  const first = entries(file)[5];
  assert.deepEqual([first.action, first.target, first.k.length], ['audit.keyed', 'plain:1;first', 16]);
  assert.ok(first.words.includes('from this first start of AGMessage ' + BUILD.version + ' on this laptop'), first.words);
  assert.ok(first.words.includes('as AGMessage 0.5.1 and earlier wrote them'), first.words);
  assert.ok(!/came|from AGMessage 0\.5|by AGMessage 0\.5/.test(first.words), 'no word states where the entries came from: ' + first.words);
  assert.deepEqual(brief(r), { ok: false, mark: 'unvouched', entries: 6 });
  assert.deepEqual(r.findings.map((f) => ({ id: f.id, kind: f.kind, first: f.first, mark: f.mark })), [{ id: 's1-5', kind: 'plain', first: true, mark: 'unvouched' }]);
  assert.equal(r.error, r.words, 'an answer that is not ✓ carries its words as the error a 0.5.1 page shows');
  assert.deepEqual(log.attention().map((f) => [f.id, f.kind, f.first]), [['s1-5', 'plain', true]]);
  assert.deepEqual(log.latest(10).map((e) => e.mark), ['intact', 'unvouched', 'unvouched', 'unvouched', 'unvouched', 'unvouched']);
  assert.equal((await acceptAll(log)).head, 'saved');
  const after = await log.verify();
  assert.deepEqual(brief(after), { ok: false, mark: 'linked', entries: 7 });
  assert.deepEqual(after.findings, []);
  assert.match(after.words, /^Linked — entries 1–5 have plain hashes \(as AGMessage 0\.5\.1 and earlier wrote them\), accepted on the AGMessage laptop on /);
  assert.deepEqual(log.latest(10).map((e) => e.mark).slice(-5), ['linked', 'linked', 'linked', 'linked', 'linked']);
  assert.deepEqual(log.attention(), []);

  // A plain log arriving where this machine has keyed a log before: "no record", and the same △.
  const other = path.join(path.dirname(file), 'second.jsonl');
  fs.writeFileSync(other, chainOf(5));
  const second = auditLog(other, { records: recordsOf(file) });
  const s = await second.verify();
  assert.equal(entries(other)[5].target, 'plain:1');
  assert.match(entries(other)[5].words, /entries 1–5 have plain hashes and came to this laptop with no record of them/);
  assert.deepEqual([s.mark, s.findings[0].id, s.findings[0].first], ['unvouched', 's1-5', false]);
});

test('legacy then keyed: plain entries after keyed ones open to `audit.unkeyed`, past 500 lines too; a torn 0.5.1 log orders its cut, the boundary, the repair', async (t) => {
  const a = written(t, 3);
  plainAfter(a.file, 600);
  const reopened = auditLog(a.file);
  const r = await reopened.verify();
  const last = entries(a.file).pop();
  assert.deepEqual([last.seq, last.action, last.target], [604, 'audit.unkeyed', 'plain:4']);
  assert.deepEqual(r.findings.map((f) => [f.id, f.kind, f.mark]), [['s4-603', 'unkeyed', 'unvouched']]);
  assert.match(r.findings[0].words, /^entries 4–603 have plain hashes after entry 3: written by an AGMessage that does not key its log/);

  const file = fresh(t);
  fs.writeFileSync(file, chainOf(5) + '{"seq":6,"at":17');
  const log = auditLog(file);
  log.write(SAM, 'login', 'sam', 'signed in');
  assert.deepEqual(actionsOf(file).slice(5), ['audit.keyed', 'audit.repair', 'login'], 'the fragment cut first, then the boundary, then the repair');
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => /^audit-torn-.+\.bin$/.test(f)).length, 1);
});

// ---------------------------------------------------------------- the records outside the data folder
test('the head: a cut while stopped is ✕ until accepted, also after more writes and a restart; a NUL tail over whole entries is found as missing', async (t) => {
  const a = written(t, 6);
  put(a.file, a.lines.slice(0, 4));
  const b = auditLog(a.file);
  let r = await b.verify();
  const cut = entries(a.file)[4];
  assert.deepEqual([cut.action, cut.target], ['audit.cut', 'cut']);
  assert.equal(cut.words, 'entries 5 to 6 are missing: this machine recorded entry 6; the log ended at entry 4');
  assert.deepEqual(r.findings.map((f) => [f.id, f.kind, f.mark, f.confirm]), [['e5', 'cut', 'broken', true]]);
  assert.equal(r.mark, 'broken');
  b.write(SAM, 'login', 'sam', 'after the cut');
  b.flush();
  const c = auditLog(a.file);
  c.write(SAM, 'login', 'sam', 'after a restart');
  r = await c.verify();
  assert.deepEqual([r.mark, ids(r)], ['broken', ['e5']], 'still ✕');
  await acceptAll(c);
  assert.equal((await c.verify()).mark, 'linked');

  // NTFS after a power cut: the newest whole entries' bytes are NULs. Kept aside, cut, and found as missing.
  const n = written(t, 6);
  const text = fs.readFileSync(n.file);
  const keep = Buffer.byteLength(n.lines.slice(0, 4).join('\n') + '\n');
  fs.writeFileSync(n.file, Buffer.concat([text.subarray(0, keep), Buffer.alloc(text.length - keep)]));
  const m = auditLog(n.file);
  const mr = await m.verify();
  assert.deepEqual(entries(n.file).slice(4).map((e) => [e.action, e.target]), [['audit.cut', 'cut'], ['audit.repair', '']]);
  assert.deepEqual(ids(mr), ['e5']);
  const aside = fs.readdirSync(path.dirname(n.file)).find((f) => /^audit-torn-.+\.bin$/.test(f));
  assert.ok(fs.readFileSync(path.join(path.dirname(n.file), aside)).every((x) => x === 0), 'the NULs kept aside');
});

test('the head: a fork, the whole log removed (but not moved), a changed head, a missing head, a head that cannot be read', async (t) => {
  // A fork: the head's entry 6 is not the log's entry 6.
  const a = written(t, 4);
  const snapshot = fs.readFileSync(a.file);
  a.log.write(SAM, 'login', 'sam', 'five'); a.log.write(SAM, 'login', 'sam', 'six'); a.log.flush();
  fs.writeFileSync(a.file, snapshot);
  const elsewhere = auditLog(a.file, { records: h.tmpDir(t, 'agm-rec-') });
  for (const w of ['5′', '6′', '7′']) elsewhere.write(SAM, 'login', 'sam', w);
  elsewhere.flush();
  let r = await auditLog(a.file).verify();
  assert.ok(r.findings.some((f) => f.kind === 'fork' && f.words === 'the log forked: this machine\'s entry 6 is not the log\'s entry 6'), JSON.stringify(r.findings));

  // The whole log removed: ✕ "this folder held another log". Moved: not a finding.
  const g = written(t, 3);
  fs.unlinkSync(g.file);
  r = await auditLog(g.file).verify();
  assert.deepEqual(kinds(r), ['another']);
  assert.match(r.findings[0].words, /^this folder held another log \(3 entries, the newest at \d\d:\d\d on \d+ \w{3}\); it is not here$/);
  const m = written(t, 3);
  const to = path.join(h.tmpDir(t, 'agm-moved-'), 'audit.jsonl');
  fs.copyFileSync(m.file, to); fs.unlinkSync(m.file);
  const moved = auditLog(to, { records: recordsOf(m.file) });
  r = await moved.verify();
  assert.deepEqual(brief(r), { ok: true, mark: 'intact', entries: 4 });
  assert.deepEqual([entries(to)[3].action, entries(to)[3].words], ['audit.moved', 'this log was last written at ' + path.dirname(m.file)]);

  // A changed head: kept aside, ✕.
  const c = written(t, 3);
  const headFile = path.join(recordsOf(c.file), 'head-' + entries(c.file)[0].l + '.json');
  const changed = fs.readFileSync(headFile, 'utf8').replace(/"seq":3/, '"seq":2');
  fs.writeFileSync(headFile, changed);
  r = await auditLog(c.file).verify();
  assert.deepEqual(kinds(r), ['changed']);
  const asideName = fs.readdirSync(recordsOf(c.file)).find((f) => /^head-.+\.changed-.+\.json$/.test(f));
  assert.equal(fs.readFileSync(path.join(recordsOf(c.file), asideName), 'utf8'), changed, 'kept aside byte for byte');
  assert.match(r.findings[0].words, /^the head record outside the data folder was changed: kept aside as head-/);

  // Entries under this key and no head (ENOENT): ✕ "no record".
  const d = written(t, 3);
  fs.unlinkSync(path.join(recordsOf(d.file), 'head-' + entries(d.file)[0].l + '.json'));
  r = await auditLog(d.file).verify();
  assert.deepEqual([r.mark, kinds(r)], ['broken', ['nohead']]);
  assert.equal(r.findings[0].words, 'this machine keyed this log and has no record of it: the head record outside the data folder is missing');

  // A head that cannot be read (EBUSY): △, nothing compared, and the head is never written over this run.
  const e = written(t, 3);
  const eHead = path.join(recordsOf(e.file), 'head-' + entries(e.file)[0].l + '.json');
  const bytes = fs.readFileSync(eHead);
  const latestFile = path.join(recordsOf(e.file), 'latest.json');
  await failing('readFileSync', 'EBUSY', at(eHead), async () => {
    const busy = auditLog(e.file);
    busy.open();
    const latestAtOpen = fs.readFileSync(latestFile);
    busy.write(SAM, 'login', 'sam', 'while a backup tool holds the head');
    busy.flush();
    assert.deepEqual(fs.readFileSync(latestFile), latestAtOpen, 'the head lane stays off for the run after open()\'s records');
    r = await busy.verify();
    assert.equal(r.mark, 'unvouched');
    assert.deepEqual(kinds(r), ['unread']);
    assert.match(r.head.error, /the head record could not be read \(EBUSY\)/);
    assert.ok(busy.attention().some((x) => x.kind === 'head'), 'health names it');
  });
  assert.deepEqual(fs.readFileSync(eHead), bytes, 'the head file is byte for byte unchanged after that run');
});

test('the records: keyed.json or the keyless marker that cannot be read is △, said, and never written over', async (t) => {
  // keyed.json held by a backup tool: a finding of its own, and the file as it was.
  const a = written(t, 2);
  const keyedFile = path.join(recordsOf(a.file), 'keyed.json');
  const keyedBytes = fs.readFileSync(keyedFile);
  const plain = path.join(path.dirname(a.file), 'second.jsonl');
  fs.writeFileSync(plain, chainOf(3));
  let r;
  await failing('readFileSync', 'EBUSY', at(keyedFile), async () => {
    const log = auditLog(plain, { records: recordsOf(a.file) });
    r = await log.verify();
    log.flush();
  });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.mark]), [['plain', 'unvouched'], ['unread', 'unvouched']]);
  assert.match(r.findings[1].words, /^the record that this machine has keyed a log before could not be read \(EBUSY\)/);
  assert.deepEqual(fs.readFileSync(keyedFile), keyedBytes, 'keyed.json as it was');

  // The keyless marker held: a keyed run says so; a keyless run does not write over it.
  const b = written(t, 2);
  const marker = path.join(recordsOf(b.file), 'keyless-' + entries(b.file)[0].l + '.json');
  fs.writeFileSync(marker, JSON.stringify({ v: 1, log: entries(b.file)[0].l, runs: [] }));
  const markerBytes = fs.readFileSync(marker);
  await failing('readFileSync', 'EACCES', at(marker), async () => {
    r = await auditLog(b.file).verify();
    const keyless = new audit.AuditLog(b.file, { keys: () => { throw Object.assign(new Error('the machine key could not be read (EBUSY)'), { code: 'EBUSY' }); }, records: recordsOf(b.file) });
    keyless.write(SAM, 'login', 'sam', 'without the key');
    keyless.flush();
  });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.mark]), [['unread', 'unvouched']]);
  assert.match(r.findings[0].words, /^the record of the runs this machine made without its key could not be read \(EACCES\)/);
  assert.deepEqual(fs.readFileSync(marker), markerBytes, 'the marker as it was');
});

test('the head: findings whose entries are not on disk are held, 16 and one `more`; a stop leaves the head at the last entry; a failed fsync never reaches it', async (t) => {
  const a = written(t, 2);
  const head = () => headOf(a.file);
  // The disk refuses every append: 17 findings wait, and the head carries 16 of them and a `more`.
  await failing('openSync', 'ENOSPC', at(a.file), async () => {
    for (let i = 1; i <= 17; i++) a.log._finding('cut', 'finding ' + i);
    a.log.headLane.flushSync();
    const held = head().held;
    assert.equal(held.length, 17);
    assert.deepEqual(held[16], { kind: 'more', n: 1 });
    assert.deepEqual(held.slice(0, 2).map((x) => [x.id, x.kind]), [['e3', 'cut'], ['e4', 'cut']]);
    const r = await a.log.verify();
    assert.equal(r.mark, 'broken');
    assert.equal(r.findings.filter((f) => f.held).length, 17);
    assert.ok(r.findings.some((f) => f.id === 'more' && f.mark === 'broken'));
    const refused = await a.log.accept({ digest: r.digest, ids: ['e3'], confirm: ['e3'] }, HOST, '');
    assert.deepEqual([refused.ok, refused.status], [false, 409]);
    assert.match(refused.error, /not on disk yet/);
  });
  a.log.write(SAM, 'login', 'sam', 'the disk is back');
  a.log.flush();
  assert.deepEqual(head().held, [], 'every finding on disk now');
  assert.deepEqual([head().seq, head().h], [20, entries(a.file).pop().h], 'the stop\'s flush leaves the head at the last entry');
  assert.equal((await a.log.verify()).findings.filter((f) => f.held).length, 0);

  // An fsync that fails: the entry is written, never in the head, until an fsync returns.
  const b = written(t, 2);
  let once = true;
  await failing('fsyncSync', 'EIO', () => (once ? !(once = false) : false), () => { b.log.write(SAM, 'login', 'sam', 'not durable yet'); });
  b.log.headLane.flushSync();
  assert.equal(headOf(b.file).seq, 2, 'the head never claims an entry a power cut can take');
  b.log.flush();
  assert.equal(headOf(b.file).seq, 3);
});

test('the head: findings it held when the process ended, their entries never on disk, are found again at the next start', async (t) => {
  const a = written(t, 2);
  await failing('openSync', 'ENOSPC', at(a.file), () => {
    for (let i = 1; i <= 17; i++) a.log._finding('fork', 'finding ' + i);
    a.log.headLane.flushSync();
  });
  // The process ends here: what the disk would not take goes with it, and the head still holds it.
  const b = auditLog(a.file);
  const r = await b.verify();
  const again = entries(a.file).slice(2);
  assert.deepEqual(again.map((e) => [e.action, e.target]), [...Array(16).fill(['audit.cut', 'fork']), ['audit.head', 'lost']]);
  assert.equal(again[0].words, 'finding 1 (found at an earlier start; its entry never reached the disk)');
  assert.equal(again[16].words, '1 more finding of an earlier start never reached the disk');
  assert.deepEqual([r.mark, r.findings.length, r.findings.every((f) => f.confirm && !f.held)], ['broken', 17, true]);
});

test('the head: a lane that cannot save it is △ with its error; a head saved or a rotation during a check does not change its answer', async (t) => {
  const a = written(t, 2);
  const headFile = path.join(recordsOf(a.file), 'head-' + entries(a.file)[0].l + '.json');
  fs.rmSync(headFile);
  fs.mkdirSync(headFile); fs.writeFileSync(path.join(headFile, 'x'), 'x');   // the rename over it fails, as a held file does
  a.log.write(SAM, 'login', 'sam', 'the head cannot be saved');
  a.log.headLane.flushSync();
  const r = await a.log.verify();
  assert.equal(r.mark, 'unvouched');
  assert.match(r.head.error, /^entries after 2 are not vouched for: the head record could not be saved \(/);
  fs.rmSync(headFile, { recursive: true });
  a.log.headLane.flushSync();
  assert.equal((await a.log.verify()).mark, 'intact', 'and back to ✓ once it lands');

  const file = fresh(t);
  keyedChainOf(56_000, { file });   // over 20 MB: the next entry rotates the file
  const log = auditLog(file);
  log.open();
  const check = log.verify();
  await new Promise((resolve) => { setImmediate(resolve); });
  log.write(SAM, 'login', 'sam', 'rotates the file under the check');
  log.flush();
  const answer = await check;
  assert.equal(log.rotations, 1);
  assert.deepEqual([answer.ok, answer.mark], [true, 'intact'], JSON.stringify(answer).slice(0, 300));
  assert.ok(answer.entries >= 56_000);
});

// ---------------------------------------------------------------- a moved log, and the log written last
test('moved, and the last log: an upgrade\'s copy is ✓, a cut meanwhile is found, a stripped or another log where the last one is gone is ✕', async (t) => {
  const records = recordsOf(fresh(t));
  const open = (file) => auditLog(file, { records });
  // Each log here keeps one records folder: one machine.
  const at1 = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  const one = auditLog(at1, { records });
  for (let i = 0; i < 4; i++) one.write(SAM, 'login', 'sam', 'one ' + i);
  one.flush();
  // The copy an upgrade makes, at a new path, with a cut made meanwhile.
  const at2 = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  put(at2, lines(at1).slice(0, 3));
  const r = await open(at2).verify();
  assert.deepEqual(actionsOf(at2).slice(3), ['audit.cut', 'audit.moved']);
  assert.deepEqual(kinds(r), ['cut']);

  // Stripped to plain hashes and put at a new path, the last log's folder gone: ✕ "is not there".
  const s = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  const solo = auditLog(s, { records });
  for (let i = 0; i < 3; i++) solo.write(SAM, 'login', 'sam', 'solo ' + i);
  solo.flush();
  let prev = rules.GENESIS;
  const stripped = entries(s).map(({ l: _l, k: _k, h: _h, ...e }) => { e.prev = prev; e.h = audit.hashOf(e); prev = e.h; return JSON.stringify(e); });
  fs.rmSync(path.dirname(s), { recursive: true });
  const s2 = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  put(s2, stripped);
  const sr = await open(s2).verify();
  assert.ok(sr.findings.some((f) => f.kind === 'last' && f.words.startsWith('the log this machine wrote last (3 entries, at ' + path.dirname(s) + ', ')), JSON.stringify(sr.findings));
  assert.equal(sr.mark, 'broken');

  // Another genuine log of this machine at a new path: ✕ while the last log's folder is gone, nothing while it is there.
  const x = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  const y = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  for (const [f, w] of [[x, 'x'], [y, 'y']]) { const l = auditLog(f, { records }); l.write(SAM, 'login', 'sam', w); l.flush(); }
  // y was written last. x, moved to a new path while y is still where it was: only the move.
  const x2 = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  fs.copyFileSync(x, x2);
  const kept = await open(x2).verify();
  assert.deepEqual([kept.mark, kinds(kept)], ['intact', []], 'the last log is still there: not a finding');
  // Now x2 was written last; y written again elsewhere, x2's folder gone.
  const y2 = path.join(h.tmpDir(t, 'agm-at-'), 'audit.jsonl');
  fs.copyFileSync(y, y2);
  fs.rmSync(path.dirname(x2), { recursive: true });
  const gone = await open(y2).verify();
  assert.deepEqual(kinds(gone), ['last']);
});

// ---------------------------------------------------------------- another machine's key
test('another machine: a log keyed under A and opened under B is a span B accepts; back on A, a fork and B\'s span are accepted together', async (t) => {
  const file = fresh(t);
  const recA = recordsOf(file);
  const recB = h.tmpDir(t, 'agm-rec-b-');
  const a = auditLog(file, { records: recA });
  for (let i = 0; i < 4; i++) a.write(SAM, 'login', 'sam', 'A ' + i);
  a.flush();
  const copy = path.join(h.tmpDir(t, 'agm-b-'), 'audit.jsonl');
  fs.copyFileSync(file, copy);
  for (const w of ['A 5', 'A 6', 'A 7']) a.write(SAM, 'login', 'sam', w);
  a.flush();
  // B opens the copy: a rekey under B, its span △, B's entries checked under B's key.
  const b = auditLog(copy, { key: OTHER_KEY, records: recB });
  b.write(SAM, 'login', 'sam', 'B 6');
  b.write(SAM, 'login', 'sam', 'B 7');
  b.write(SAM, 'login', 'sam', 'B 8');
  b.flush();
  const rb = await b.verify();
  const rekey = entries(copy)[4];
  assert.deepEqual([rekey.action, rekey.target, rekey.k], ['audit.rekey', audit.kidOf(h.auditKeys()().entry) + ':1', audit.kidOf(h.auditKeys(OTHER_KEY)().entry)]);
  assert.deepEqual(rb.findings.map((f) => [f.id, f.kind]), [['s1-4', 'other']]);
  assert.match(rb.findings[0].words, /^entries 1–4 carry key id [0-9a-f]{4}… \(their own claim\), a key this machine does not hold/);
  assert.equal(rb.mark, 'unvouched');
  await acceptAll(b);
  assert.equal((await b.verify()).mark, 'linked');
  b.flush();
  // B's copy brought back over A's: A's entry 7 is not the log's (a fork), and B's run is a span. Accepted together: ◇.
  fs.copyFileSync(copy, file);
  const back = auditLog(file, { records: recA });
  const ra = await back.verify();
  assert.deepEqual(kinds(ra).sort(), ['fork', 'other']);
  assert.equal(ra.mark, 'broken');
  const took = await acceptAll(back);
  assert.equal(took.ok, true, JSON.stringify(took));
  assert.deepEqual(entries(file).pop().target.split(',').sort(), ids(ra).sort(), 'the accept names both');
  assert.equal((await back.verify()).mark, 'linked');
});

test('another machine: a run appended after the head under a made-up key, opened by a made-up `audit.keyless`, is their own claim; a genuine keyless run reads as one', async (t) => {
  const a = written(t, 4);
  const last = entries(a.file).pop();
  const made = 'deadbeefdeadbeef';
  let prev = last.h;
  const forged = [];
  for (let i = 1; i <= 3; i++) {
    const e = { seq: last.seq + i, at: last.at + i, actor: { t: 'system', id: '', name: '' }, action: i === 1 ? 'audit.keyless' : 'login', target: i === 1 ? last.k + ':1' : 'sam', words: i === 1 ? 'this run has no machine key (EBUSY): its entries are linked' : 'forged ' + i, ip: '', prev, l: last.l, k: made };
    e.h = crypto.createHmac('sha256', 'a key nobody has').update(rules.canonical2(e)).digest('hex');
    prev = e.h;
    forged.push(JSON.stringify(e));
  }
  fs.appendFileSync(a.file, forged.join('\n') + '\n');
  const r = await auditLog(a.file).verify();
  assert.deepEqual(r.findings.map((f) => [f.id, f.kind, f.mark]), [['s5-7', 'other', 'unvouched']]);
  assert.match(r.findings[0].words, /^entries 5–7 carry key id dead… \(their own claim\)/);
  assert.ok(!/no machine key/.test(r.words), 'never "this machine had no machine key"');
  assert.notEqual(r.mark, 'linked');

  // A genuine keyless run: the machine key could not be read (EBUSY), so the run had a key of its own and marked it.
  const was = process.env.AGM_KEY_DIR;
  const keyDir = h.tmpDir(t, 'agm-key-');
  fs.writeFileSync(path.join(keyDir, 'machine.key'), FIXTURE_KEY.toString('base64'));
  const file = fresh(t);
  const records = path.join(keyDir, 'audit');
  const real = () => new audit.AuditLog(file, { keys: audit.keysFrom(secretbox.derive), records });
  try {
    process.env.AGM_KEY_DIR = keyDir;
    secretbox._reset();
    const k = real();
    k.write(SAM, 'login', 'sam', 'keyed'); k.flush();
    secretbox._reset();
    await failing('readFileSync', 'EBUSY', at(path.join(keyDir, 'machine.key')), () => {
      const keyless = real();
      keyless.write(SAM, 'login', 'sam', 'while the key could not be read');
      keyless.flush();
      assert.deepEqual(keyless.attention().map((x) => x.kind), ['keyless']);
      assert.match(keyless.attention()[0].words, /^this run has no machine key \(EBUSY\)/);
    });
    const marker = JSON.parse(fs.readFileSync(path.join(records, 'keyless-' + entries(file)[0].l + '.json'), 'utf8'));
    assert.deepEqual(marker.runs.map((x) => [x.from, x.code]), [[2, 'EBUSY']]);
    assert.deepEqual(actionsOf(file), ['login', 'audit.keyless', 'login']);
    secretbox._reset();
    const back = real();
    const r2 = await back.verify();
    assert.equal(entries(file)[3].action, 'audit.rekey');
    assert.deepEqual(r2.findings.map((f) => [f.id, f.kind]), [['s2-3', 'keyless']]);
    assert.match(r2.findings[0].words, /^entries 2–3 were written here while this machine had no machine key \(EBUSY, \d\d:\d\d on \d+ \w{3}\): linked, and not checkable$/);
  } finally { restoreKeyDir(was); secretbox._reset(); }
});

test('a span with no boundary after it is ✕: entries added behind the running server\'s back', async (t) => {
  const a = written(t, 3);
  plainAfter(a.file, 2);   // while this log is open: no start has seen them
  const r = await a.log.verify();
  assert.deepEqual([r.ok, r.mark], [false, 'broken']);
  assert.equal(r.why, 'entries 4–5 follow entry 3 with no boundary under this key after it: added behind the running server\'s back');
  assert.deepEqual(await acceptAll(a.log).catch((e) => e.message), { ok: false, status: 409, error: 'not accepted: the log is broken at line 6 of audit.jsonl (' + r.why + '), and a broken entry is never accepted' });
});

// ---------------------------------------------------------------- Accept, in the log
test('accept: by the ids ticked under the digest shown; a ✕ only with its confirmation; the span alone leaves a cut open; never a broken entry', async (t) => {
  const file = fresh(t);
  fs.writeFileSync(file, chainOf(5));
  const log = auditLog(file);
  for (let i = 0; i < 3; i++) log.write(SAM, 'login', 'sam', 'keyed ' + i);
  log.flush();
  put(file, lines(file).slice(0, -2));
  const b = auditLog(file);
  const r = await b.verify();
  assert.deepEqual(r.findings.map((f) => [f.id, f.kind, f.mark]), [['s1-5', 'plain', 'unvouched'], ['e8', 'cut', 'broken']]);
  const refuse = async (args, status, words) => { const x = await b.accept(args, HOST, ''); assert.deepEqual([x.ok, x.status], [false, status], JSON.stringify(x)); assert.match(x.error, words); };
  await refuse({ digest: 'f'.repeat(16), ids: ['s1-5'] }, 409, /the log changed since your check: check again/);
  await refuse({ digest: r.digest, ids: [] }, 400, /tick what to accept/);
  await refuse({ digest: r.digest, ids: ['s1-4'] }, 400, /not an open finding/);
  await refuse({ digest: r.digest, ids: ['e8'] }, 400, /confirm it first/);
  const span = await b.accept({ digest: r.digest, ids: ['s1-5'] }, HOST, '127.0.0.1');
  assert.deepEqual([span.ok, span.head], [true, 'saved']);
  const accept = entries(file).pop();
  assert.deepEqual([accept.action, accept.target, accept.actor.name], ['audit.accept', 's1-5', 'AGMessage laptop']);
  assert.match(accept.words, /^accepted on the AGMessage laptop: entries 1–5 have plain hashes/);
  const left = await b.verify();
  assert.deepEqual([left.mark, ids(left)], ['broken', ['e8']], 'the cut is still open');
  const cut = await b.accept({ digest: left.digest, ids: ['e8'], confirm: ['e8'] }, HOST, '');
  assert.equal(cut.ok, true);
  assert.equal((await b.verify()).mark, 'linked');

  // A changed entry is never accepted: the check is broken, and nothing is written.
  const c = written(t, 3);
  plainAfter(c.file, 2);
  const cr = await auditLog(c.file).verify();
  put(c.file, lines(c.file).map((x, i) => (i === 1 ? x.replace('message 2', 'message Q') : x)));
  const changed = auditLog(c.file);
  const before = lines(c.file).length;
  const x = await changed.accept({ digest: cr.digest, ids: ['s4-5'] }, HOST, '');
  assert.deepEqual([x.ok, x.status], [false, 409]);
  assert.match(x.error, /a broken entry is never accepted/);
  assert.equal(lines(c.file).length, before);
});

test('accept: while the disk refuses the entry, "not accepted yet" and the head unchanged; it takes effect once the entry is on disk', async (t) => {
  const file = fresh(t);
  fs.writeFileSync(file, chainOf(3));
  const log = auditLog(file);
  const r = await log.verify();
  log.flush();
  const headFile = path.join(recordsOf(file), 'head-' + entries(file)[3].l + '.json');
  const before = fs.readFileSync(headFile);
  await failing('openSync', 'ENOSPC', at(file), async () => {
    const x = await log.accept({ digest: r.digest, ids: ['s1-3'] }, HOST, '');
    assert.deepEqual([x.ok, x.head], [true, 'waiting']);
    assert.match(x.words, /^not accepted yet: the disk would not take the entry \(ENOSPC: stubbed, openSync\); it takes effect when it does$/);
    log.headLane.flushSync();
    assert.deepEqual(fs.readFileSync(headFile), before, 'the head unchanged');
    assert.deepEqual(log.attention().map((f) => f.id), ['s1-3'], 'still open');
  });
  log.flush();
  assert.equal((await log.verify()).mark, 'linked');
  assert.deepEqual(log.attention(), []);
});

// ---------------------------------------------------------------- a rollback
test('rollback: entries written on with plain hashes after keyed ones (0.5.1 again) read △, ◇ once accepted, and an edit before them is still found', async (t) => {
  const a = written(t, 4);
  plainAfter(a.file, 3);
  const log = auditLog(a.file);
  const r = await log.verify();
  assert.deepEqual([r.mark, r.findings.map((f) => [f.id, f.kind])], ['unvouched', [['s5-7', 'unkeyed']]]);
  await acceptAll(log);
  assert.equal((await log.verify()).mark, 'linked');
  log.flush();
  put(a.file, lines(a.file).map((x, i) => (i === 1 ? x.replace('message 2', 'message 9') : x)));
  const edited = await auditLog(a.file).verify();
  assert.deepEqual([edited.mark, edited.brokenAt], ['broken', 2]);
});

// ---------------------------------------------------------------- the data folder's lock
test('the lock: a copy refuses a folder held under 0.5.1\'s name for it, and under its own name by another path to it; a log\'s record has one id from its first start', async (t) => {
  const real = h.tmpDir(t, 'agm-lock-');
  const link = real + '-link';
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(link, { force: true }));   // the link itself, never what it points to
  const pipe = (id) => (process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + id : path.join(os.tmpdir(), 'agmessage-' + id + '.sock'));
  const legacy = (dir) => crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)).digest('hex').slice(0, 16);
  // A copy refused at its second name has gone (process.exit) still holding its first: that socket stays on the disk.
  if (process.platform !== 'win32') t.after(() => fs.rmSync(pipe(legacy(link)), { force: true }));
  const hold = (where) => new Promise((resolve) => { const s = net.createServer((c) => c.end()); s.listen(where, () => resolve(s)); });
  const second = (dataDir) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(h.ROOT, 'server.js')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: real + '-keys', ADMIN_TOKEN: h.TOKEN, AGM_NODES: '0', AGM_TLS: '0', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const stop = setTimeout(() => c.kill('SIGKILL'), 8000);
    c.on('exit', (code) => { clearTimeout(stop); resolve({ code, out }); });
  });
  assert.notEqual(legacy(link), placeId(link), 'two names for one folder reached by a link');
  assert.equal(placeId(link), placeId(real), 'one folder, one id, however its path is spelled');
  // 0.5.1 holds the folder by the path it was given: this copy, given the same path, is refused.
  let s = await hold(pipe(legacy(link)));
  let r = await second(link);
  s.close();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /already running on this data folder/);
  // This version holds it by its real path too: a copy given another path to it is refused.
  s = await hold(pipe(placeId(real)));
  r = await second(link);
  s.close();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /already running on this data folder/);
  assert.ok(!fs.existsSync(path.join(real, 'audit.jsonl')), 'nothing written by a copy that was refused');

  // A folder whose real path cannot be read is taken by its path as given, and that is said once.
  const nowhere = path.join(real, 'not-made-yet');
  const said = [];
  const warn = console.warn;
  console.warn = (line) => said.push(line);
  let fallback;
  try { fallback = placeId(nowhere); } finally { console.warn = warn; }
  assert.equal(fallback, legacy(nowhere), 'its path as given, as 0.5.1 named it');
  assert.equal(said.length, 1);
  assert.match(said[0], /is taken by its path as given: its real path could not be read \(ENOENT\)/);

  // The folder record's id at a first start, with no log file yet, is the id at the next start.
  const file = fresh(t);
  const id = placeId(path.dirname(file), 'audit.jsonl');
  const first = auditLog(file);
  first.write(SAM, 'login', 'sam', 'first');
  first.flush();
  auditLog(file).write(SAM, 'login', 'sam', 'second');
  assert.deepEqual(fs.readdirSync(recordsOf(file)).filter((f) => f.startsWith('folder-')), ['folder-' + id + '.json']);
});

// ---------------------------------------------------------------- end to end
test('end to end: the first start asks in the black window and in health, the token at the laptop accepts, and nothing else does', async (t) => {
  const dataDir = h.tmpDir(t, 'agm-e2e-');
  fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), chainOf(5));
  let srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  t.after(async () => { await h.stopServer(srv.child); });
  const out = srv.out();
  assert.match(out, /Audit log: {3}keyed \(key [0-9a-f]{16}\) · Admin → Health/);
  assert.match(out, /Key folder: {2}.+-keys \(set by AGM_KEY_DIR, not the default\)/);
  assert.match(out, /Audit log: {3}entries 1–5 have plain hashes, as AGMessage 0\.5\.1 and earlier wrote them; anyone who\n {15}could write this folder could have rewritten them\. If this log has been in your hands,\n {15}accept them: http:\/\/localhost:\d+\/admin → Health → Accept, and type the token above\.\n {15}Until then the log reads △\. Nothing waits for this\./);
  const health = (await h.api(srv.base, 'GET', '/api/health')).body;
  assert.deepEqual(health.saves.stores.audit.attention.map((f) => [f.id, f.kind, f.mark, f.first]), [['s1-5', 'plain', 'unvouched', true]]);
  assert.match(health.saves.stores.audit.kid, /^[0-9a-f]{16}$/);
  assert.equal(health.saves.stores.auditHead.error, null, 'the head\'s lane is in health');

  const admin = (await h.api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  // A page cached from 0.5.1 reads only `ok`: never ✓ for △.
  const v = (await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin })).body;
  assert.deepEqual([v.ok, v.mark, v.error === v.words], [false, 'unvouched', true]);
  const rows = (await h.api(srv.base, 'GET', '/api/audit?limit=20', undefined, { cookie: admin })).body.entries;
  assert.deepEqual(rows.filter((e) => e.seq <= 6).map((e) => [e.seq, e.mark]), [[6, 'intact'], [5, 'unvouched'], [4, 'unvouched'], [3, 'unvouched'], [2, 'unvouched'], [1, 'unvouched']]);
  const accept = (body, o) => h.api(srv.base, 'POST', '/api/audit/accept', body, o);
  const fails = async () => (await h.api(srv.base, 'GET', '/api/audit?limit=50', undefined, { cookie: admin })).body.entries.filter((e) => e.action === 'login.token.fail');

  // An admin account, without the token: refused, and counted as a wrong token.
  let x = await accept({ digest: v.digest, ids: ['s1-5'] }, { cookie: admin });
  assert.equal(x.status, 401);
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: admin })).body.token, false);
  // A wrong token: refused, written down, and counted toward the token's lockout.
  x = await accept({ token: 'not-the-token', digest: v.digest, ids: ['s1-5'] });
  assert.equal(x.status, 401);
  const wrong = await fails();
  assert.equal(wrong.length, 2);
  assert.equal(wrong[0].words, 'a wrong admin token (at Accept)');
  // From off the host (through the tunnel): refused before anything is read.
  x = await accept({ token: h.TOKEN, digest: v.digest, ids: ['s1-5'] }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(x.status, 403);

  // The token sign-in made by this run, at the laptop: /api/admin/me says so, it may check, and with the typed token it accepts.
  const tok = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: tok })).body.token, true);
  const seen = (await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: tok })).body;
  assert.equal(seen.mark, 'unvouched', 'the token at the laptop may check');
  x = await accept({ token: h.TOKEN, digest: 'f'.repeat(16), ids: ['s1-5'] }, { cookie: tok });
  assert.deepEqual([x.status, x.body.error], [409, 'the log changed since your check: check again']);
  const now = (await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: tok })).body;
  x = await accept({ token: h.TOKEN, digest: now.digest, ids: ['s1-5'] }, { cookie: tok });
  assert.deepEqual([x.status, x.body.ok, x.body.head], [200, true, 'saved']);
  assert.equal((await h.api(srv.base, 'GET', '/api/audit/verify', undefined, { cookie: admin })).body.mark, 'linked');
  assert.deepEqual((await h.api(srv.base, 'GET', '/api/health')).body.saves.stores.audit.attention, []);

  // A token sign-in written into admin-sessions.json, loaded by a restart under the same token: no Accept without the
  // typed token, and never "made here".
  await h.stopServer(srv.child);
  const sid = crypto.randomBytes(24).toString('hex');
  const file = path.join(dataDir, 'admin-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  sessions.sessions.push({ h: crypto.createHash('sha256').update(sid).digest('hex'), created: Date.now() });
  fs.writeFileSync(file, JSON.stringify(sessions));
  srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  const planted = 'agm_admin=' + sid;
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: planted })).body.ok, true, 'the planted sign-in holds the dashboard (unit K closes that)');
  assert.equal((await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: planted })).body.token, false, 'but it was not made by this run');
  x = await accept({ digest: now.digest, ids: ['s1-5'] }, { cookie: planted });
  assert.equal(x.status, 401, 'and without the typed token there is no Accept');
  // Wrong tokens at Accept count toward the token sign-in's own lockout: the fifth locks both, the right token included.
  for (let i = 0; i < 4; i++) assert.equal((await accept({ token: 'wrong ' + i, digest: now.digest, ids: ['s1-5'] })).status, 401);
  x = await accept({ token: h.TOKEN, digest: now.digest, ids: ['s1-5'] });
  assert.deepEqual([x.status, x.body.error], [429, 'Too many wrong tokens — wait a minute.']);
  assert.equal((await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).status, 429, 'the token sign-in waits too');
});

test('end to end: a run with no machine key still starts and signs in, opens with `audit.keyless`, marks the run and says so; nothing is sealed', async (t) => {
  const dataDir = h.tmpDir(t, 'agm-e2e-');
  const keyDir = dataDir + '-keys';
  fs.mkdirSync(path.join(keyDir, 'machine.key'), { recursive: true });   // a key that cannot be read (EISDIR)
  const srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  t.after(async () => { await h.stopServer(srv.child); });
  assert.match(srv.out(), /Audit log: {3}not keyed this run \(EISDIR\)/);
  assert.match(srv.out(), /Audit log: {3}△ this run has no machine key \(EISDIR\)/);
  assert.match(srv.out(), /^ {2}Signing key: none this run \(no machine key\): an export cannot be signed$/m);
  const tok = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  assert.ok(tok, 'the token signs in');
  // No export can be signed: refused with the reason, and no row written.
  const exp = await h.api(srv.base, 'POST', '/api/audit/export', {}, { cookie: tok });
  assert.deepEqual([exp.status, exp.body.error], [503, 'not exported: this run has no machine key (EISDIR), so an export cannot be signed']);
  const es = entries(path.join(dataDir, 'audit.jsonl'));
  assert.deepEqual(es.map((e) => e.action), ['audit.keyless', 'login.token']);
  const marker = fs.readdirSync(path.join(keyDir, 'audit')).filter((f) => f.startsWith('keyless-'));
  assert.deepEqual(marker, ['keyless-' + es[0].l + '.json']);
  const auditFacts = (await h.api(srv.base, 'GET', '/api/health')).body.saves.stores.audit;
  assert.deepEqual([auditFacts.signKey, auditFacts.lastExport], ['', null]);
  // The audit list names no key: this run's key id is of a key made for it alone, which nothing after it can check.
  const admin = (await h.api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const list = await h.api(srv.base, 'GET', '/api/audit', undefined, { cookie: admin });
  assert.deepEqual([list.status, list.body.key], [200, { kid: '', fingerprint: '' }]);
  const attention = auditFacts.attention;
  assert.deepEqual(attention.map((f) => [f.kind, f.mark]), [['keyless', 'unvouched']]);
  assert.match(attention[0].words, /the machine key at .+ could not be read \(EISDIR\)/);
  const socket = await h.connect(srv.base, tok);
  try {
    const s = await h.emit(socket, 'admin:settings', { aiKey: 'a key typed now' });
    assert.equal(s.ok, false);
    assert.match(s.error, /^Not saved: this run has no machine key \(EISDIR\), so nothing can be sealed\./);
    const plain = await h.emit(socket, 'admin:settings');
    assert.match(plain.contextToken, /^agn_/, 'a context token for this run, kept in memory');
    // New token: the one in use this run is replaced, and the row says it lasts this run only.
    const renewed = await h.emit(socket, 'admin:settings', { newContextToken: true });
    assert.equal(renewed.ok, true);
    assert.match(renewed.contextToken, /^agn_/);
    assert.notEqual(renewed.contextToken, plain.contextToken, 'the old one stops answering now');
    assert.equal((await h.api(srv.base, 'GET', '/api/context', undefined, { headers: { authorization: 'Bearer ' + plain.contextToken } })).status, 401);
    assert.equal((await h.api(srv.base, 'GET', '/api/context', undefined, { headers: { authorization: 'Bearer ' + renewed.contextToken } })).status, 200);
    const row = entries(path.join(dataDir, 'audit.jsonl')).filter((e) => e.action === 'settings').pop();
    assert.equal(row.words, 'changed newContextToken (this run only: no machine key to seal it)');
    // A screen's link is kept sealed: refused, with why, and nothing made.
    const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: tok })).body.code;
    const screen = await h.emit(socket, 'display:create', { code, name: 'Lectern' });
    assert.equal(screen.ok, false);
    assert.match(screen.error, /^Not saved: this run has no machine key \(EISDIR\), so nothing can be sealed\./);
    assert.ok(!fs.existsSync(path.join(dataDir, 'displays.json')) || !/Lectern/.test(fs.readFileSync(path.join(dataDir, 'displays.json'), 'utf8')), 'no screen made');
  } finally { socket.close(); }
  assert.ok(fs.statSync(path.join(keyDir, 'machine.key')).isDirectory(), 'nothing was made in its place');
  assert.deepEqual(fs.readdirSync(path.join(keyDir, 'machine.key')), []);
  assert.ok(!/contextTokenSealed|aiKeySealed/.test(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')), 'nothing sealed');
});

test('end to end: a later start says again what is still open, and a line changed while it was stopped, in the black window and in health', async (t) => {
  const dataDir = h.tmpDir(t, 'agm-e2e-');
  const file = path.join(dataDir, 'audit.jsonl');
  fs.writeFileSync(file, chainOf(3));
  let srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  t.after(async () => { await h.stopServer(srv.child); });
  const question = /Audit log: {3}entries 1–3 have plain hashes, as AGMessage 0\.5\.1 and earlier wrote them; anyone who\n {15}could write this folder could have rewritten them\./;
  assert.match(srv.out(), question);
  // Not accepted: the next start writes nothing new, and its check at start asks again, once.
  srv = await h.restartServer(srv);
  await h.until(() => question.test(srv.out()), 6000, 'the question again');
  const health = async () => (await h.api(srv.base, 'GET', '/api/health')).body.saves.stores.audit.attention;
  assert.deepEqual((await health()).map((f) => [f.id, f.first]), [['s1-3', true]]);
  assert.equal(srv.out().split('accept them: http://localhost:').length - 1, 1, 'said once');

  // A 0.5.1 entry changed while it was stopped: ✕ in the window and in health, with the line, and nothing to accept.
  await h.stopServer(srv.child);
  put(file, lines(file).map((x, i) => (i === 1 ? x.replace('Lectern screen 2', 'Lectern screen 9') : x)));
  srv = await h.startServer({ AGM_DATA_DIR: dataDir, PORT: String(srv.port) });
  await h.until(() => /Audit log: {3}✕ Broken at line 2 of audit\.jsonl: entry 2 was changed after it was written/.test(srv.out()), 6000, 'the broken line in the window');
  assert.deepEqual((await health()).map((f) => [f.id, f.kind, f.mark]), [[undefined, 'broken', 'broken']]);
});

test('end to end: no secret in any audit file, record, health, the rows, /api/admin/me, a check, an export\'s header or any member of it, in hex or base64', async (t) => {
  const srv = await h.startServer();
  t.after(async () => { await h.stopServer(srv.child); });
  const base = srv.base;
  const tok = (await h.api(base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const setup = await h.api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' });
  const admin = setup.cookie;
  const code = (await h.api(base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const socket = await h.connect(base, tok);
  let screen;
  let invites;
  let context;
  try {
    screen = (await h.emit(socket, 'display:create', { code, name: 'Lectern' })).display.path.slice(3);
    await h.emit(socket, 'admin:lockRoles', { roomCode: code, on: true });
    invites = (await h.emit(socket, 'admin:invites', { roomCode: code })).invites;
    context = (await h.emit(socket, 'admin:settings')).contextToken;
  } finally { socket.close(); }
  const machine = h.serverKey(srv.dataDir);
  const k = h.auditKeys(machine)();
  const seed = secretbox.deriveFrom(machine, 'agmessage audit sign v1');
  const der = secretbox.signingKeyFrom(seed).privateKey.export({ format: 'der', type: 'pkcs8' });
  const invite = Object.values(invites).map((u) => new URL(u, base).searchParams.get('invite')).filter(Boolean);
  assert.ok(invite.length >= 1 && screen && context, 'the secrets were made');
  const secrets = { Ke: k.entry, Kh: k.head, machine, seed, der, token: Buffer.from(h.TOKEN), context: Buffer.from(context), screen: Buffer.from(screen),
    secret: fs.readFileSync(path.join(srv.dataDir, 'secret.key')), session: Buffer.from(admin.split('=')[1]), signin: Buffer.from(tok.split('=')[1]), invite: Buffer.from(invite[0]) };
  const forms = (b) => [b.toString('hex'), b.toString('base64'), b.toString('base64url'), b.toString('utf8')].filter((x) => x.length >= 12);
  const texts = [];
  for (const f of fs.readdirSync(srv.dataDir).filter((x) => /^audit/.test(x))) texts.push(['data/' + f, fs.readFileSync(path.join(srv.dataDir, f), 'utf8')]);
  const records = path.join(srv.dataDir + '-keys', 'audit');
  for (const f of fs.readdirSync(records)) texts.push(['records/' + f, fs.readFileSync(path.join(records, f), 'utf8')]);
  for (const [what, url, cookie] of [['health', '/api/health', tok], ['rows', '/api/audit?limit=500', admin], ['me', '/api/admin/me', tok], ['check', '/api/audit/verify', admin]]) {
    texts.push([what, JSON.stringify((await h.api(base, 'GET', url, undefined, { cookie })).body)]);
  }
  // An export, by the token and by the admin account: its header and every member, uncompressed.
  const sent = () => entries(path.join(srv.dataDir, 'audit.jsonl')).filter((e) => e.action === 'audit.export.sent').length;
  for (const cookie of [tok, admin]) {
    const before = sent();
    const r = await fetch(base + '/api/audit/export', { method: 'POST', headers: { cookie } });
    assert.equal(r.status, 200);
    texts.push(['X-AGM-Export', r.headers.get('x-agm-export')]);
    for (const m of h.readZip(Buffer.from(await r.arrayBuffer()))) texts.push(['export ' + m.name, m.data.toString('latin1'), m.data]);
    await h.until(() => sent() > before, 5000, 'the export\'s own end in the log, which frees its slot');
  }
  assert.ok(texts.some(([w]) => w.startsWith('records/head-')), 'the records were read');
  assert.ok(texts.some(([w]) => w.endsWith('/SHA256SUMS.sig')), 'the exports were read');
  for (const [name, value] of Object.entries(secrets)) {
    for (const form of forms(value)) for (const [where, text] of texts) assert.ok(!text.includes(form), name + ' is not in ' + where);
    // The raw bytes too (a member such as the signature is binary).
    for (const [where, , bytes] of texts) if (bytes && value.length >= 12) assert.ok(!bytes.includes(value), name + ' is not in ' + where + ' as bytes');
  }
});
