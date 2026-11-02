'use strict';
// The audit log exported, signed, and checked on another computer (lib/auditexport.js, lib/zip.js, verify/verify-audit.js;
// the browser verifier is driven by the smoke): the zip as it streams, the bundle and its signature, the verifier's five
// exit codes and its path rules, the compare of two exports, one export at a time, rotations and a browser that goes,
// and who may export. Each is asserted by its fields: the bundle's bytes, the manifest, the rows the log holds, the codes.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const vm = require('vm');
const zipmod = require('../lib/zip');
const { Exporter, bundleName } = require('../lib/auditexport');
const verifier = require('../verify/verify-audit');
const rules = require('../verify/auditrules');
const rbac = require('../lib/rbac');
const secretbox = require('../lib/secretbox');
const audit = require('../lib/audit');
const h = require('./helpers');

const { auditLog, keyedChainOf, chainOf, FIXTURE_KEY, OTHER_KEY, readZip, unzipTo, ROOT } = h;
const VERIFY = path.join(ROOT, 'verify', 'verify-audit.js');
const VERIFY_DIR = path.join(ROOT, 'verify');
const SIGN = 'agmessage audit sign v1';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const keyOf = (machine = FIXTURE_KEY) => secretbox.signingKeyFrom(secretbox.deriveFrom(machine, SIGN));
const FP = keyOf().fingerprint;
const ANA = Object.freeze({ t: 'account', id: 'a9', name: 'ana' });
const SAM = Object.freeze({ t: 'account', id: 'a1', name: 'sam' });
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const entries = (file) => lines(file).map((l) => JSON.parse(l));
const fresh = () => path.join(tmp('agm-exp-'), 'audit.jsonl');
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const NOT_WINDOWS = process.platform === 'win32' ? 'the Windows job checks a bundle with Expand-Archive and the release\'s verifier (ci.yml, package)' : false;

/** A keyed log written by this machine (the fixture key): `n` entries, flushed. */
function written(n, file = fresh(), words = (i) => 'message ' + i) {
  const log = auditLog(file);
  for (let i = 1; i <= n; i++) log.write(SAM, 'display.take', 'D1', words(i), '10.0.0.9');
  log.flush();
  return log;
}

/** An exporter over `log` behind a plain HTTP server, as http-accounts mounts it: every POST is an export for Ana. */
async function exportServer(log, { machine = FIXTURE_KEY, verifyDir = VERIFY_DIR } = {}) {
  const exporter = new Exporter({
    audit: log, signingKey: () => keyOf(machine), verifyDir, version: 'test',
    node: () => ({ id: 'a1b2c3d4', name: 'AGMessage test', version: '0.6.0', build: '0.6.0-test' }),
  });
  const runs = [];
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    runs.push(exporter.run(res, ANA, '10.0.0.9'));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    exporter, base: 'http://127.0.0.1:' + server.address().port,
    settled: () => Promise.all(runs),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
/** POST an export and read all of it: {status, headers, body, json}. */
async function fetchExport(base) {
  const r = await fetch(base + '/', { method: 'POST' });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body, json: (r.headers.get('content-type') || '').includes('json') ? JSON.parse(body.toString()) : null };
}
/** An export of `log`, unpacked: {dir (the bundle's folder), zip, headers}. */
async function exported(log, o) {
  const s = await exportServer(log, o);
  try {
    const r = await fetchExport(s.base);
    await s.settled();
    assert.equal(r.status, 200, r.json ? r.json.error : 'a zip');
    return { dir: unzipTo(r.body, tmp('agm-bundle-')), zip: r.body, headers: r.headers };
  } finally { await s.close(); }
}
/** The verifier run as an auditor runs it, a process of its own: {code, out}. */
function verify(args, script = VERIFY) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}
/** A copy of a bundle's folder, to change. */
const copy = (dir) => { const to = path.join(tmp('agm-copy-'), path.basename(dir)); fs.cpSync(dir, to, { recursive: true }); return to; };
/** One byte of a file changed in place. */
const flip = (file, at = 10) => { const b = fs.readFileSync(file); b[at] ^= 1; fs.writeFileSync(file, b); };
/** One hex digit of a file changed in place to another hex digit, so its line keeps its shape and only what it says differs. */
const flipHex = (file, at) => {
  const b = fs.readFileSync(file);
  assert.match(String.fromCharCode(b[at]), /^[0-9a-f]$/, 'a hex digit to change');
  b[at] = b[at] === 0x30 ? 0x31 : 0x30;
  fs.writeFileSync(file, b);
};
/**
 * A bundle signed again by another key, as anyone could make one: its export row's key, the manifest's sizes and
 * fingerprint, the public key, SHA256SUMS and the signature all rewritten. Returns the new key's fingerprint.
 */
function resign(dir, { privateKey, publicKey }) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const fp = sha(publicKey.export({ type: 'spki', format: 'der' }));
  const lastFile = path.join(dir, ...m.files[m.files.length - 1].path.split('/'));
  const ls = lines(lastFile);
  const row = JSON.parse(ls[ls.length - 1]);
  row.target = row.target.replace(/;[0-9a-f]{16}$/, ';' + fp.slice(0, 16));
  ls[ls.length - 1] = JSON.stringify(row);
  fs.writeFileSync(lastFile, ls.join('\n') + '\n');
  for (const f of m.files) f.bytes = fs.statSync(path.join(dir, ...f.path.split('/'))).size;
  m.signingKey.fingerprint = fp;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'signing-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const listed = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.slice(66));
  const sums = listed.map((p) => sha(fs.readFileSync(path.join(dir, ...p.split('/')))) + '  ' + p).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sig'), crypto.sign(null, Buffer.from(sums), privateKey));
  return fp;
}

// ---------------------------------------------------------------- the zip
test('zip: each member deflated as it streams, its CRC-32 and sizes after it; the zip\'s length and digest are what went out; a destination that goes ends it', async () => {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const z = new zipmod.ZipStream(out, { at: Date.UTC(2026, 9, 26, 18, 40) });
  const big = crypto.randomBytes(300_000);
  await z.add('b/one.txt', [Buffer.from('hello\n')]);
  await z.add('b/big.bin', (async function* () { for (let i = 0; i < big.length; i += 65536) yield big.subarray(i, i + 65536); })());
  await z.add('b/empty', []);
  const end = await z.end();
  out.end();
  const buf = Buffer.concat(chunks);
  assert.deepEqual([end.bytes, end.sha256], [buf.length, sha(buf)]);
  const members = readZip(buf);
  assert.deepEqual(members.map((m) => m.name), ['b/one.txt', 'b/big.bin', 'b/empty']);
  assert.equal(members[0].data.toString(), 'hello\n');
  assert.ok(members[1].data.equals(big), 'the big member byte for byte');
  assert.equal(members[2].data.length, 0);
  assert.equal(buf.readUInt16LE(6) & 0x08, 0x08, 'general purpose bit 3: the CRC and sizes follow the data');
  await assert.rejects(z.add('c', []), /the zip has ended/);
  // A destination that stops reading and then goes: the zip waits for room, then ends with `gone`.
  const stuck = new PassThrough({ highWaterMark: 1024 });
  const z2 = new zipmod.ZipStream(stuck);
  const adding = z2.add('x.bin', [crypto.randomBytes(200_000)]);
  await wait(50);
  stuck.destroy();
  await assert.rejects(adding, (e) => e.gone === true && /the browser went away/.test(e.message));
  const gone = new PassThrough();
  gone.destroy();
  await assert.rejects(new zipmod.ZipStream(gone).add('y', [Buffer.from('y')]), (e) => e.gone === true);
  // A source that fails ends the member with its own error.
  const z3 = new zipmod.ZipStream(new PassThrough().resume());
  await assert.rejects(z3.add('z', (async function* () { yield Buffer.from('a'); throw new Error('the disk said EIO'); })()), /the disk said EIO/);
  // What fits without Zip64.
  assert.deepEqual([zipmod.fits(50 * 1048576, 12), zipmod.fits(0xFFFFFFFF, 1), zipmod.fits(1024, 70_000)], [true, false, false]);
});

// ---------------------------------------------------------------- the right
test('rights: audit.export is admin-only, held by the admin role and not the manager preset; only an admin grants it, and its holder is changed only by an admin', () => {
  assert.ok(rbac.isCap('audit.export') && rbac.ADMIN_ONLY.has('audit.export'));
  assert.equal(rbac.CAPS['audit.export'], 'Export the whole audit log, signed, to check on another computer (an account with it signs in through the tunnel only when admins may)');
  const admin = { id: 'x1', role: 'admin' };
  const manager = { id: 'm1', role: 'manager' };
  assert.deepEqual([rbac.can(admin, 'audit.export'), rbac.can(manager, 'audit.export'), rbac.can(manager, 'audit.read')], [true, false, true]);
  const keeper = { id: 'm2', role: 'manager', grant: ['users.manage'] };
  assert.equal(rbac.mayChange(keeper, null, { role: 'staff', grant: ['audit.export'] }), 'Only an admin may grant audit.export.');
  assert.equal(rbac.mayChange(admin, null, { role: 'staff', grant: ['audit.export'] }), null);
  const holder = { id: 'e1', role: 'staff', grant: ['audit.export'] };
  assert.equal(rbac.holdsAdminOnly(holder), true, 'kept off the tunnel unless admins may sign in there');
  assert.equal(rbac.mayChange(keeper, holder, {}), 'Only an admin may change an account that manages accounts or settings, or exports the audit log.');
  assert.ok(!rbac.giveable(keeper).caps.includes('audit.export'));
});

// ---------------------------------------------------------------- the bundle
test('the bundle: every log line byte for byte, SHA256SUMS over every member, signed by the fixture key, the export\'s own entry last, the laptop\'s check in the manifest, then `audit.export.sent` with the zip\'s SHA-256', async () => {
  const file = fresh();
  const log = written(6, file);
  const before = await log.verify();
  const kept = [...fs.readdirSync(path.dirname(file)).sort(), '|', ...fs.readdirSync(h.recordsOf(file)).sort()];
  const s = await exportServer(log);
  let r;
  try { r = await fetchExport(s.base); await s.settled(); } finally { await s.close(); }
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const row = entries(file).find((e) => e.action === 'audit.export');
  const name = bundleName('a1b2c3d4', row.at);
  assert.match(name, /^agmessage-audit-a1b2c3d4-\d{8}-\d{4}$/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="' + name + '.zip"');
  assert.equal(r.headers.get('x-agm-export'), 'entries=1-7; mark=intact; key=' + FP.slice(0, 16));
  const members = new Map(readZip(r.body).map((m) => [m.name.slice(name.length + 1), m.data]));
  assert.deepEqual([...members.keys()], ['log/audit.jsonl', 'manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig', 'signing-key.pem', 'README.txt', 'verify/verify-audit.js', 'verify/auditrules.js', 'verify/verify.html']);
  // The log: byte for byte up to and including its own entry, which is the 7th, "started", signed with the fixture key.
  const all = fs.readFileSync(file);
  const rowLine = Buffer.from(JSON.stringify(row) + '\n');
  const upTo = all.subarray(0, all.indexOf(rowLine) + rowLine.length);
  assert.ok(members.get('log/audit.jsonl').equals(upTo), 'the log, byte for byte, up to its own entry');
  const last = JSON.parse(members.get('log/audit.jsonl').toString().trim().split('\n').pop());
  assert.deepEqual([last.seq, last.action, last.target, last.actor], [7, 'audit.export', '1-7;' + FP.slice(0, 16), { ...ANA }]);
  assert.equal(last.words, 'export started, for checking on another computer: entries 1–7, the whole log, this entry its last; signed with key ' + FP.slice(0, 16).match(/.{4}/g).join(' '));
  // SHA256SUMS lists every member but itself and its signature, and each digest holds; the signature is the fixture key's.
  const sums = members.get('SHA256SUMS');
  const listed = rules.parseSums(sums.toString()).list;
  assert.deepEqual(listed.map((x) => x.path), [...members.keys()].filter((p) => !p.startsWith('SHA256SUMS')));
  for (const x of listed) assert.equal(sha(members.get(x.path)), x.digest, x.path);
  assert.equal(members.get('SHA256SUMS.sig').length, 64);
  assert.ok(crypto.verify(null, sums, keyOf().publicKey, members.get('SHA256SUMS.sig')), 'signed by the fixture key');
  const der = verifier.pemDer(members.get('signing-key.pem').toString());
  assert.equal(sha(der), FP);
  // The manifest: what the bundle is, the head its own entry, the laptop's check through that entry.
  const m = JSON.parse(members.get('manifest.json'));
  assert.equal(members.get('manifest.json').toString(), JSON.stringify(m, null, 2) + '\n');
  assert.deepEqual({ ...m, check: undefined }, {
    kind: 'agmessage audit export', v: 1, made: row.at, by: { ...ANA },
    node: { id: 'a1b2c3d4', name: 'AGMessage test', version: '0.6.0', build: '0.6.0-test' }, log: row.l, kid: row.k,
    signingKey: { alg: 'Ed25519', fingerprint: FP }, entries: { from: 1, to: 7 }, head: { seq: 7, h: row.h }, check: undefined,
    files: [{ path: 'log/audit.jsonl', bytes: upTo.length, first: 1, last: 7 }],
  });
  assert.equal(rules.manifestProblem(m), '');
  assert.deepEqual([m.check.mark, m.check.findings], [before.mark, before.findings]);
  assert.equal(m.check.words, before.words.replace('6 entries', '7 entries'), 'a check run at that moment, through the export\'s own entry');
  // Then the row that says it was sent whole, with the zip's own digest; Health reads it.
  const sent = entries(file).pop();
  assert.deepEqual([sent.action, sent.target, sent.actor], ['audit.export.sent', '1-7', { ...ANA }]);
  assert.match(sent.words, /^export sent whole: entries 1–7, \d+ KB; the zip's SHA-256 is [0-9a-f]{64}$/);
  assert.equal(sent.words.slice(-64), sha(r.body));
  assert.deepEqual({ ...log.facts().lastExport, at: 0 }, { at: 0, by: 'ana', from: 1, to: 7 });
  // No copy: the data folder and the records folder hold the same files as before, the log's own lines aside.
  assert.deepEqual([...fs.readdirSync(path.dirname(file)).sort(), '|', ...fs.readdirSync(h.recordsOf(file)).sort()], kept);
  assert.equal(s.exporter.busy(), null, 'the slot is free');
  assert.ok(s.exporter.handles.length === 0, 'no handle left open');
  // The README says how to check, and what it proves and does not.
  const readme = members.get('README.txt').toString();
  for (const want of ['openssl pkey -pubin -in signing-key.pem -outform DER | sha256sum        # 1. compare with YOUR record of the key', 'openssl pkeyutl -verify -pubin -inkey signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig', 'sha256sum -c SHA256SUMS', 'What it cannot prove', 'That each keyed entry\'s MAC is right']) assert.ok(readme.includes(want), want);
  // The verifier it carries is this release's.
  assert.ok(members.get('verify/verify-audit.js').equals(fs.readFileSync(VERIFY)));
  assert.ok(members.get('verify/auditrules.js').equals(fs.readFileSync(path.join(VERIFY_DIR, 'auditrules.js'))));
  assert.equal(members.get('verify/verify.html').toString(), await verifier.pageFrom(VERIFY_DIR, 'test'));
});

test('determinism: a fixed seed signs a fixed SHA256SUMS to fixed bytes; verify.html is one page for one release, its meta CSP the hashes of its inline script and style', async () => {
  const sums = Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  log/audit.jsonl\n');
  assert.equal(crypto.sign(null, sums, keyOf().privateKey).toString('hex'), 'efda9e8bda5819c8ae1c4facc85b8a8d5bf4d633ce13244bffaf320d7de41fb399401b4f31a9a9e68f0917f52661b1d3504b4e50fd077e8f7b717752e14ee803');
  assert.equal(FP, 'a0d322dc9f43d14c250cfd41ea402185d101c98d0a0a11edc1cfa135d542865e');
  const page = await verifier.pageFrom(VERIFY_DIR, '0.6.0 (build 7)');
  assert.equal(await verifier.pageFrom(VERIFY_DIR, '0.6.0 (build 7)'), page, 'the same bytes for the same release');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)[1];
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((x) => x[1]);
  const b64 = (t) => "'sha256-" + crypto.createHash('sha256').update(t, 'utf8').digest('base64') + "'";
  assert.equal(scripts.length, 2);
  assert.equal(csp, "default-src 'none'; script-src " + scripts.map(b64).join(' ') + '; style-src ' + b64(styles[0]) + "; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'");
  const lf = (t) => t.replace(/\r\n?/g, '\n');   // a Windows checkout writes CR LF; the page carries LF
  assert.equal(scripts[0], lf(fs.readFileSync(path.join(VERIFY_DIR, 'auditrules.js'), 'utf8')));
  assert.equal(scripts[1], lf(fs.readFileSync(path.join(VERIFY_DIR, 'page.js'), 'utf8')));
  assert.ok(!page.includes('\r'), 'no CR in the page: a browser reads CR LF as LF before it checks a hash');
  // Parts written with CR LF, or a lone CR, make the same page, hashed over what the browser reads.
  const parts = { html: '__CSP__\n__VERSION__\n<style>__STYLE__</style><script>__RULES__</script><script>__PAGE__</script>', css: 'a {\n}\n', rules: 'x = 1;\ny = 2;\n', js: 'z = 3;\n', version: 'v' };
  const crlf = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, k === 'version' ? v : v.replace(/\n/g, '\r\n')]));
  const lone = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, k === 'version' ? v : v.replace(/\n/g, '\r')]));
  assert.equal(verifier.assemblePage(crlf), verifier.assemblePage(parts));
  assert.equal(verifier.assemblePage(lone), verifier.assemblePage(parts));
  assert.ok(page.includes('This verifier is from AGMessage 0.6.0 (build 7).'));
  assert.ok(page.includes('AGMessage &lt;x&gt;') === false && (await verifier.pageFrom(VERIFY_DIR, '<x>')).includes('AGMessage &lt;x&gt;'), 'the version is escaped');
  assert.throws(() => verifier.assemblePage({ html: '__CSP__ __VERSION__ __STYLE__ __RULES__ __PAGE__', css: '', rules: '', js: 'x = "</script>"', version: 'v' }), /cannot be put inline/);
  assert.throws(() => verifier.assemblePage({ html: '__CSP__', css: '', rules: '', js: '', version: 'v' }), /must hold each/);
});

test('the formats: unzip -tq, and README.txt\'s three commands word for word (OpenSSL and sha256sum)', { skip: NOT_WINDOWS }, async () => {
  const log = written(3);
  const { dir, zip } = await exported(log);
  const zipFile = path.join(tmp('agm-zip-'), 'export.zip');
  fs.writeFileSync(zipFile, zip);
  const run = (cmd, args, cwd) => new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const t = await run('unzip', ['-tq', zipFile]);
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /No errors detected/);
  const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').split('\n').map((l) => l.trim());
  const commands = readme.filter((l) => /^(openssl pkey |openssl pkeyutl |sha256sum -c )/.test(l));
  assert.equal(commands.length, 3);
  const [key, sig, sums] = await Promise.all(commands.map((c) => run('sh', ['-c', c], dir)));
  assert.deepEqual([key.code, key.out], [0, FP + '  -\n'], 'the key\'s fingerprint, to compare with your record');
  assert.deepEqual([sig.code, sig.out.trim()], [0, 'Signature Verified Successfully']);
  assert.equal(sums.code, 0, sums.out);
  assert.equal(sums.out.split('\n').filter((l) => / OK$/.test(l)).length, 7);
  flip(path.join(dir, 'SHA256SUMS'), 3);
  assert.notEqual((await run('sh', ['-c', commands[1]], dir)).code, 0, 'one byte changed: the signature fails');
});

// ---------------------------------------------------------------- the verifier
test('the verifier: exit 0 on a fresh keyed log, 1 on a 0.5.1 seed not accepted, 2 when the laptop said ✕, 4 with no key to compare with; --list prints the entries, escaped', async () => {
  const fine = await exported(written(4, fresh(), (i) => (i === 2 ? 'Lectern \u001b[31mRED\u001b[0m' : 'message ' + i)));
  const ok = await verify([fine.dir, '--fingerprint', FP, '--list']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^✓ signed by key a0d3 22dc 9f43 d14c .*, the key you expected$/m);
  assert.match(ok.out, /^✓ whole: entries 1–5 in 1 file/m);
  assert.match(ok.out, /^ {2}✓ Intact — 5 entries, all keyed on this machine$/m);
  assert.match(ok.out, /^Not checked here: the keyed entries' own MACs\./m);
  assert.match(ok.out, /^Signed by the key you expected and whole; the laptop said ✓ \(exit 0\)\.$/m);
  assert.match(ok.out, /^3 {2}\S+ {5}sam {2}display\.take {2}D1 {2}message 3$/m, 'one seeded entry\'s words, listed');
  assert.ok(ok.out.includes('Lectern \\u001b[31mRED\\u001b[0m') && !ok.out.includes('\u001b'), 'a control character is printed escaped, never acted on');
  // The fingerprint may be typed in groups, or with colons.
  assert.equal((await verify([fine.dir, '--fingerprint', FP.match(/.{4}/g).join(' ')])).code, 0);
  const none = await verify([fine.dir]);
  assert.equal(none.code, 4, none.out);
  assert.match(none.out, /^The bundle's own claim \(not compared with a record of the laptop's key, so not shown to be the laptop's\)/m);
  assert.match(none.out, /not compared with a record of the laptop's key: not shown to be the laptop's\. Anyone can make such a bundle with a key of their own\. Give --fingerprint \(exit 4\)\.$/m);

  // A 0.5.1 log at its first keyed start, never accepted: △, exit 1, its span named as not accepted.
  const seedFile = fresh();
  fs.writeFileSync(seedFile, chainOf(5));
  const seed = await exported(auditLog(seedFile));
  const one = await verify([seed.dir, '--fingerprint', FP]);
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, /^△ entries 1–5 with plain hashes: not accepted on the laptop$/m);
  assert.match(one.out, /^ {2}△ Not vouched for — entries 1–5 have plain hashes, as AGMessage 0\.5\.1 and earlier wrote them/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(seed.dir, 'manifest.json'))).check.findings[0].id, 's1-5');
  // Accepted, then exported again: ◇, still exit 1, and the span names its accept.
  const acceptedLog = auditLog(seedFile);
  await h.acceptAll(acceptedLog);
  const accepted = await exported(acceptedLog);
  const linked = await verify([accepted.dir, '--fingerprint', FP]);
  assert.equal(linked.code, 1, linked.out);
  assert.match(linked.out, /^◇ entries 1–5 with plain hashes: accepted on the AGMessage laptop by entry \d+ /m);
  assert.match(linked.out, /^ {2}◇ Linked — /m);

  // An entry changed before the export: the laptop's check said ✕, the bundle agrees with itself, exit 2.
  const editedFile = fresh();
  const edited = written(5, editedFile);
  const ls = lines(editedFile);
  ls[2] = ls[2].replace('message 3', 'message X');
  fs.writeFileSync(editedFile, ls.join('\n') + '\n');
  const broken = await exported(edited);
  assert.match(broken.headers.get('x-agm-export'), /; mark=broken; /);
  const two = await verify([broken.dir, '--fingerprint', FP]);
  assert.equal(two.code, 2, two.out);
  assert.match(two.out, /^ {2}✕ Broken at line 3 of audit\.jsonl: entry 3 was changed after it was written$/m);
  // A plain entry changed before the export: the verifier finds it too, where the laptop did, and still says 2.
  const plainFile = fresh();
  fs.writeFileSync(plainFile, chainOf(4).replace('Lectern screen 2', 'Lectern screen 9'));
  const plainBroken = await exported(auditLog(plainFile));
  const twoToo = await verify([plainBroken.dir, '--fingerprint', FP]);
  assert.equal(twoToo.code, 2, twoToo.out);
  assert.match(twoToo.out, /^✕ the entries break where the laptop's own check said they do: entry 2 \(line 2 of log\/audit\.jsonl\) was changed after it was written$/m);
});

test('the verifier: exit 3 for any byte changed after the export, a file gone or added, another key\'s signature, or a bundle re-signed whole by another key; 4 for that bundle with no key given', async () => {
  const { dir } = await exported(written(3));
  const three = async (change, want) => {
    const d = copy(dir);
    change(d);
    const r = await verify([d, '--fingerprint', FP]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, want);
    assert.match(r.out, /^Nothing in this bundle is vouched for \(exit 3\)\.$/m);
    return r;
  };
  await three((d) => flip(path.join(d, 'log', 'audit.jsonl'), 40), /^✕ log\/audit\.jsonl is not what was signed: its SHA-256 differs from SHA256SUMS$/m);
  await three((d) => flipHex(path.join(d, 'SHA256SUMS'), 5), /^✕ the signature over SHA256SUMS does not check against signing-key\.pem$/m);
  await three((d) => { const f = path.join(d, 'manifest.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"name": "ana"', '"name": "eve"')); }, /^✕ manifest\.json is not what was signed/m);
  await three((d) => flip(path.join(d, 'SHA256SUMS.sig'), 7), /^✕ the signature over SHA256SUMS does not check/m);
  await three((d) => fs.rmSync(path.join(d, 'README.txt')), /^✕ README\.txt is not in the folder \(ENOENT\)$/m);
  await three((d) => fs.writeFileSync(path.join(d, 'log', 'notes.txt'), 'not read'), /^✕ log\/notes\.txt is not part of the export \(not read\)$/m);
  // Another key's public key and signature put in: the manifest names the laptop's key, so it does not hold.
  const other = crypto.generateKeyPairSync('ed25519');
  await three((d) => {
    fs.writeFileSync(path.join(d, 'signing-key.pem'), other.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(d, 'SHA256SUMS.sig'), crypto.sign(null, fs.readFileSync(path.join(d, 'SHA256SUMS')), other.privateKey));
  }, /^✕ manifest\.json names key a0d3 22dc 9f43 d14c …, and signing-key\.pem is key /m);
  // Re-signed whole by another key: it agrees with itself (4 without a key), and is refused against the laptop's (3).
  const whole = copy(dir);
  const theirs = resign(whole, other);
  const four = await verify([whole]);
  assert.equal(four.code, 4, four.out);
  assert.ok(four.out.includes('Whole and signed consistently by key ' + theirs.match(/.{4}/g).join(' ')), four.out);
  const refused = await verify([whole, '--fingerprint', FP]);
  assert.equal(refused.code, 3, refused.out);
  assert.match(refused.out, /^✕ signed by key \S{4} \S{4} \S{4} \S{4} …, not the key you expected \(a0d3 22dc 9f43 d14c …\)$/m);
  // A line over 64 KB, in a bundle otherwise whole and signed: it fails there.
  const long = copy(dir);
  const logFile = path.join(long, 'log', 'audit.jsonl');
  const ls = lines(logFile);
  const e = JSON.parse(ls[0]);
  e.words = 'x'.repeat(70_000);
  ls[0] = JSON.stringify(e);
  fs.writeFileSync(logFile, ls.join('\n') + '\n');
  const longFp = resign(long, other);
  const tooLong = await verify([long, '--fingerprint', longFp]);
  assert.equal(tooLong.code, 3, tooLong.out);
  assert.match(tooLong.out, /^✕ line 1 of log\/audit\.jsonl is over 64 KB$/m);
  // The usage, and a fingerprint that is not one.
  assert.equal((await verify([dir, '--fingerprint', 'abc'])).code, 3);
  assert.equal((await verify([])).code, 3);
});

test('the verifier\'s paths: a SHA256SUMS naming ../x, /etc/passwd, C:\\x or \\\\host\\share\\f ends the check before anything else is opened; a folder linked out of the bundle is refused', async () => {
  const { dir } = await exported(written(2));
  for (const bad of ['../x', '/etc/passwd', 'C:\\x', '\\\\host\\share\\f', 'log/../../x', 'verify/evil.js']) {
    const d = copy(dir);
    fs.appendFileSync(path.join(d, 'SHA256SUMS'), '0'.repeat(64) + '  ' + bad + '\n');
    const seen = [];
    const record = (name) => async (p, ...rest) => { seen.push(path.resolve(String(p))); return fs.promises[name](p, ...rest); };
    const fsp = { ...fs.promises, realpath: record('realpath'), lstat: record('lstat'), readFile: record('readFile'), readdir: record('readdir'), open: record('open'), stat: record('stat') };
    const r = await verifier.check(d, { fingerprint: FP, fsp });
    assert.equal(r.code, 3, bad);
    assert.match(r.why, /^SHA256SUMS names (a path|not a file an export holds)/, bad + ': ' + r.why);
    // The native real path, as fs.promises.realpath gives it: on Windows it spells a short (8.3) folder name out.
    const real = fs.realpathSync.native(d);
    assert.deepEqual(seen.filter((p) => p !== path.resolve(d) && p !== real), [path.join(real, 'SHA256SUMS'), path.join(real, 'SHA256SUMS'), path.join(real, 'SHA256SUMS')], bad + ': only SHA256SUMS was looked at (its lstat, its real path, its bytes)');
    assert.equal((await verify([d, '--fingerprint', FP])).code, 3, bad);
  }
  // The log's folder a link (a junction on Windows) to a copy outside: a link is no part of an export, and is not followed.
  const d = copy(dir);
  const outside = tmp('agm-outside-');
  fs.cpSync(path.join(d, 'log'), path.join(outside, 'log'), { recursive: true });
  fs.rmSync(path.join(d, 'log'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'log'), path.join(d, 'log'), 'junction');
  const linked = await verifier.check(d, { fingerprint: FP });
  assert.deepEqual([linked.code, linked.why], [3, 'log is not part of the export (not read)']);
  assert.equal((await verify([d, '--fingerprint', FP])).code, 3);
  // A log file that is a link (a file link needs an administrator on Windows, so there the folder's link above stands for it).
  if (process.platform !== 'win32') {
    const f = copy(dir);
    fs.renameSync(path.join(f, 'log', 'audit.jsonl'), path.join(outside, 'moved.jsonl'));
    fs.symlinkSync(path.join(outside, 'moved.jsonl'), path.join(f, 'log', 'audit.jsonl'));
    const fileLink = await verifier.check(f, { fingerprint: FP });
    assert.deepEqual([fileLink.code, fileLink.why], [3, 'log/audit.jsonl is not a plain file (a link, or a folder)']);
  }
  // The rules themselves.
  for (const p of ['log/audit.jsonl', 'log/audit-2026-10-20T09-12-44-120Z.jsonl', 'manifest.json', 'verify/verify.html']) assert.equal(rules.pathProblem(p), '', p);
  for (const p of ['', 'log/audit.jsonl\u0000', 'log/audit-x.jsonl', 'LOG/audit.jsonl', 'archive/x']) assert.notEqual(rules.pathProblem(p), '', JSON.stringify(p));
  assert.deepEqual([rules.parseSums('').why, rules.parseSums('x\n').why, rules.parseSums('0'.repeat(64) + '  SHA256SUMS\n').why, rules.parseSums(('0'.repeat(64) + '  README.txt\n').repeat(2)).why],
    ['SHA256SUMS does not end with a line end', 'line 1 of SHA256SUMS is not "<sha256>  <path>"', 'SHA256SUMS lists SHA256SUMS', 'SHA256SUMS lists README.txt twice']);
});

test('the verifier says where it came from: run from the bundle, it says so; run from a release\'s copy, a bundled verify file that differs is named', async () => {
  const { dir } = await exported(written(2));
  const fromBundle = await verify([dir, '--fingerprint', FP], path.join(dir, 'verify', 'verify-audit.js'));
  assert.equal(fromBundle.code, 0, fromBundle.out);
  assert.match(fromBundle.out, /^△ this verifier came from the bundle it is checking: check it again with the release's verifier/m);
  const release = tmp('agm-release-');
  fs.copyFileSync(VERIFY, path.join(release, 'verify-audit.js'));
  fs.writeFileSync(path.join(release, 'auditrules.js'), fs.readFileSync(path.join(VERIFY_DIR, 'auditrules.js'), 'utf8') + '// another release\n');
  fs.writeFileSync(path.join(release, 'verify.html'), await verifier.pageFrom(VERIFY_DIR, 'test'));
  const fromRelease = await verify([dir, '--fingerprint', FP], path.join(release, 'verify-audit.js'));
  assert.equal(fromRelease.code, 0, fromRelease.out);
  assert.match(fromRelease.out, /^△ the bundle's verify\/auditrules\.js is not this verifier's auditrules\.js: do not run the bundle's copy$/m);
  assert.ok(!/verify\.html is not|verify-audit\.js is not/.test(fromRelease.out), 'the files that are the same are not named');
  const same = await verify([dir, '--fingerprint', FP]);
  assert.ok(!/this verifier came from|is not this verifier's/.test(same.out), same.out);
});

test('compare: two exports of one log are the same for the earlier\'s entries; one rewritten and re-MACed by a key holder is named; another key is named; --earlier stands in for --fingerprint and says so', async () => {
  const file = fresh();
  keyedChainOf(4, { file });
  const log = auditLog(file);
  const first = await exported(log);
  log.write(SAM, 'login', 'sam', 'signed in', '10.0.0.9');
  log.flush();
  const second = await exported(log);
  const same = await verify([second.dir, '--fingerprint', FP, '--earlier', first.dir]);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /^✓ the same: entries 1–5 of the earlier export \(made .+\) are in this one, byte for byte$/m);
  const stand = await verify([second.dir, '--earlier', first.dir]);
  assert.equal(stand.code, 0, stand.out);
  assert.ok(stand.out.includes('The key you expect is taken from the earlier export ' + first.dir + ' (' + FP.match(/.{4}/g).join(' ') + '): it must be one you kept off the laptop.'), stand.out);
  // A key holder writes the log again (entry 3's words, every entry after it re-MACed, the records too) and exports it.
  const again = fresh();
  keyedChainOf(4, { file: again, words: (i) => (i === 3 ? 'written again' : h.SEED_WORDS(i)) });
  const rewritten = await exported(auditLog(again));
  assert.equal((await verify([rewritten.dir, '--fingerprint', FP])).code, 0, 'on its own it checks: the key holder signs what they wrote');
  const named = await verify([rewritten.dir, '--fingerprint', FP, '--earlier', first.dir]);
  assert.equal(named.code, 3, named.out);
  assert.match(named.out, /^✕ entry 3 is not the same in the two exports: the log was written again between \d+ \w{3} and \d+ \w{3}$/m);
  // Another laptop's key: named, and the earlier standing in for the key refuses the later.
  const otherFile = fresh();
  const otherLog = auditLog(otherFile, { key: OTHER_KEY });
  otherLog.write(SAM, 'login', 'sam', 'signed in', '10.0.0.9');
  const otherExport = await exported(otherLog, { machine: OTHER_KEY });
  const otherKey = await verify([otherExport.dir, '--earlier', first.dir]);
  assert.equal(otherKey.code, 3, otherKey.out);
  assert.match(otherKey.out, /^△ signed by another key than the earlier export: the laptop's machine key changed between them, or they come from two laptops$/m);
  assert.match(otherKey.out, /not the key you expected/);
  // An earlier export that does not check is said, and nothing is compared.
  const bad = copy(first.dir);
  flip(path.join(bad, 'manifest.json'), 20);
  const refused = await verify([second.dir, '--fingerprint', FP, '--earlier', bad]);
  assert.equal(refused.code, 3);
  assert.match(refused.out, /^✕ The earlier export does not check: /m);
});

/**
 * The browser verifier's own script (verify/page.js), run against a stand-in document: the key typed, an earlier export
 * and then the folder chosen, as a person does it. Resolves what the page shows: {code, text, said, entries}.
 */
async function onPage(dir, { fp = '', earlier = null } = {}) {
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
  vm.runInNewContext(fs.readFileSync(path.join(VERIFY_DIR, 'page.js'), 'utf8'), { document, AGMAuditRules: rules, crypto: globalThis.crypto, TextDecoder, TextEncoder, atob }, { filename: 'verify-page.js' });
  const chosen = (d) => fs.readdirSync(d, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(d, f)).isFile()).map((rel) => ({
    name: path.basename(rel), webkitRelativePath: path.basename(d) + '/' + rel.split(path.sep).join('/'),
    arrayBuffer: async () => { const b = fs.readFileSync(path.join(d, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  }));
  const fire = (id, ev) => { for (const f of $(id).on[ev] || []) f(); };
  $('fp').value = fp;
  if (earlier) { $('earlier').files = chosen(earlier); fire('earlier', 'change'); }
  $('folder').files = chosen(dir);
  fire('folder', 'change');
  await h.until(() => /^[0-4]$/.test($('state').dataset.code || ''), 20000, 'the page\'s answer');
  return { code: Number($('state').dataset.code), text: $('state').textContent, said: $('said').kids.map((k) => k.textContent), entries: $('entriesBox').hidden ? 0 : $('rows').kids.length };
}

/** A log whose 0.5.1 file, set aside before this run, has entry 2 changed: the laptop's own check says ✕ there. */
function brokenInRotated() {
  const file = fresh();
  fs.writeFileSync(path.join(path.dirname(file), 'audit-2026-01-01T00-00-00-000Z.jsonl'), chainOf(4).replace('Lectern screen 2', 'Lectern screen 9'));
  const log = auditLog(file);
  log.write(SAM, 'login', 'sam', 'signed in', '10.0.0.9');
  log.flush();
  return log;
}

test('the verifier: a laptop that said ✕ is code 2 only while every file is what was signed and its last entry the export\'s own; a later file changed or removed after the export is 3; an earlier export whose entries break holds none to compare (Node, and the page)', async () => {
  const log = brokenInRotated();
  const { dir } = await exported(log);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  assert.deepEqual([m.check.mark, m.check.file, m.check.brokenAt, m.files.map((f) => f.path)], ['broken', 'audit-2026-01-01T00-00-00-000Z.jsonl', 2, ['log/audit-2026-01-01T00-00-00-000Z.jsonl', 'log/audit.jsonl']]);
  const two = await verify([dir, '--fingerprint', FP, '--list']);
  assert.equal(two.code, 2, two.out);
  assert.match(two.out, /^✓ every file is what was signed: each matches its SHA-256 in SHA256SUMS, and the last entry is the export's own$/m);
  assert.match(two.out, /^✕ the entries break where the laptop's own check said they do: entry 2 \(line 2 of log\/audit-2026-01-01T00-00-00-000Z\.jsonl\) was changed after it was written$/m);
  assert.match(two.out, /^Signed by the key you expected, and every file is what was exported; the entries break where the laptop's own check said they do: the log was broken when it was exported \(exit 2\)\.$/m);
  assert.ok(!/signed in {2}/.test(two.out) && !/^\d+ {2}\S+ {2}/m.test(two.out), 'no entry is listed as content when the walk broke');
  const four = await verify([dir]);
  assert.equal(four.code, 4, four.out);
  assert.match(four.out, /^Every file signed consistently by key [0-9a-f ]{79}, its entries breaking where its own check says they do, but not compared with a record of the laptop's key/m);
  assert.match((await onPage(dir)).text, /^Every file signed consistently, its entries breaking where its own check says they do, but not compared/);
  const page = await onPage(dir, { fp: FP });
  assert.deepEqual([page.code, page.entries], [2, 0]);
  assert.equal(page.text, '✕ Signed by the key you expected, and every file is what was exported; the entries break where the laptop\'s own check said they do: the log was broken when it was exported.');

  // After the export: the live file, which the laptop's verdict never named, changed or removed; or the export's own
  // entry taken off its end with every digest made again. None is what the laptop exported: 3, in Node and on the page.
  const replaced = copy(dir);
  fs.writeFileSync(path.join(replaced, 'log', 'audit.jsonl'), 'anything at all\n');
  const removed = copy(dir);
  fs.rmSync(path.join(removed, 'log', 'audit.jsonl'));
  for (const [d, want] of [[replaced, /^✕ log\/audit\.jsonl is not what was signed: its SHA-256 differs from SHA256SUMS$/m], [removed, /^✕ log\/audit\.jsonl is not in the folder \(ENOENT\)$/m]]) {
    const r = await verify([d, '--fingerprint', FP]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, want);
    assert.match(r.out, /^Nothing in this bundle is vouched for \(exit 3\)\.$/m);
    assert.equal((await verify([d])).code, 3, 'and without a key to compare with');
    const p = await onPage(d, { fp: FP });
    assert.equal(p.code, 3, p.text);
    assert.match(p.text, /^✕ Nothing in the bundle is vouched for: log\/audit\.jsonl is (not what was signed|not in the folder)/);
  }
  const other = crypto.generateKeyPairSync('ed25519');
  const cut = copy(dir);
  const live = path.join(cut, 'log', 'audit.jsonl');
  fs.writeFileSync(live, lines(live).slice(0, -1).join('\n') + '\n');
  const cutFp = resign(cut, other);
  const cutR = await verify([cut, '--fingerprint', cutFp]);
  assert.equal(cutR.code, 3, cutR.out);
  assert.match(cutR.out, /^✕ entry 2 \(line 2 of log\/audit-2026-01-01T00-00-00-000Z\.jsonl\) was changed after it was written$/m);
  assert.equal((await onPage(cut, { fp: cutFp })).code, 3);

  // An earlier export whose entries break holds none to compare with: said, never a crash.
  log.write(SAM, 'login', 'sam', 'signed in again', '10.0.0.9');
  log.flush();
  const later = await exported(log);
  const against = await verify([later.dir, '--fingerprint', FP, '--earlier', dir]);
  assert.equal(against.code, 3, against.out);
  assert.match(against.out, /^✕ The earlier export does not check: its entries break where its laptop's own check said they do \(entry 2 \(line 2 of log\/audit-2026-01-01T00-00-00-000Z\.jsonl\) was changed after it was written\), so they cannot be compared$/m);
  assert.ok(!/the verifier failed|Cannot read/.test(against.out), against.out);
  const pageAgainst = await onPage(later.dir, { fp: FP, earlier: dir });
  assert.equal(pageAgainst.code, 3);
  assert.match(pageAgainst.text, /^✕ Nothing in the bundle is vouched for: the earlier export does not check: its entries break where its laptop's own check said they do \(entry 2 /);
  // The page agrees with the Node verifier on a whole bundle: ✓ with the key, "not compared" without it, entries drawn.
  const fine = await exported(written(3));
  const ok = await onPage(fine.dir, { fp: FP });
  assert.deepEqual([ok.code, ok.text, ok.entries], [0, '✓ Signed by the key you expected and whole; the laptop said ✓.', 4]);
  assert.equal((await onPage(fine.dir)).code, 4);
});

// ---------------------------------------------------------------- one at a time, rotations, failures
/** Lines no deflate makes smaller, so a stream waits on a client that does not read. */
const noise = () => crypto.randomBytes(140).toString('hex');
/** The most entries of `noise` a keyed chain may hold and stay under `bytes` (each line's length is known from its seq's digits). */
function entriesUnder(bytes) {
  const probe = fresh();
  keyedChainOf(1, { file: probe, words: noise });
  const base = fs.statSync(probe).size;   // a line whose seq has one digit
  let total = 0;
  let n = 0;
  while (total + base + String(n + 1).length - 1 <= bytes) { n++; total += base + String(n).length - 1; }
  return n;
}
/** An export whose client takes the headers and then reads nothing until asked: {status, headers, read(), destroy()}. */
function slowClient(base) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/', { method: 'POST' }, (res) => {
      res.pause();
      const chunks = [];
      resolve({
        status: res.statusCode, headers: res.headers,
        read: () => new Promise((done) => {
          res.on('data', (c) => chunks.push(c));
          res.on('error', () => { /* a cut stream: 'close' says it was not whole */ });
          res.on('close', () => done({ whole: res.complete, body: Buffer.concat(chunks) }));
          res.resume();
        }),
        destroy: () => req.destroy(),
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

test('one at a time: a second export while one streams is refused with who and since when; a browser that goes leaves `audit.export.fail`, a free slot and no handle open', async () => {
  const file = fresh();
  keyedChainOf(30_000, { file, words: noise });
  const log = auditLog(file);
  const s = await exportServer(log);
  // Each file the export opens is let go 200 ms after it is asked to close, as when a read its stream has in flight ends
  // late on a busy thread pool: whichever path ends the export (here the browser's close), the run resolves only once
  // every handle is closed.
  const realOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const fh = await realOpen.apply(fs.promises, args);
    const close = fh.close;
    fh.close = async () => { await wait(200); return close(); };
    return fh;
  };
  try {
    const a = await slowClient(s.base);
    assert.equal(a.status, 200);
    const opened = s.exporter.handles.map((x) => x.fh);
    assert.equal(opened.length, 1);
    const b = await fetchExport(s.base);
    assert.equal(b.status, 409);
    assert.match(b.json.error, /^an export is being made for ana since \d\d:\d\d: try again when it ends$/);
    assert.equal(s.exporter.busy().by, 'ana');
    a.destroy();
    await s.settled();
    const last = entries(file).pop();
    assert.deepEqual([last.action, last.target, last.words], ['audit.export.fail', '1-30001', 'the export of entries 1–30001 was not sent whole: the browser went away']);
    assert.deepEqual([s.exporter.busy(), s.exporter.handles.length, opened.every((fh) => fh.fd === -1)], [null, 0, true], 'the slot free and every handle closed');
    // The next export goes through.
    const c = await fetchExport(s.base);
    await s.settled();
    assert.equal(c.status, 200);
    assert.equal(entries(file).pop().action, 'audit.export.sent');
  } finally { fs.promises.open = realOpen; await s.close(); }
});

test('rotation: an export whose own entry rotates the file holds that entry; writes that rotate the file while it streams leave a whole bundle whose digests hold', async () => {
  // Over 20 MB: the export's own entry is the first line of a new audit.jsonl.
  const over = fresh();
  keyedChainOf(34_500, { file: over, words: noise });
  assert.ok(fs.statSync(over).size > 20 * 1024 * 1024);
  const overLog = auditLog(over);
  const rotated = await exported(overLog);
  const m = JSON.parse(fs.readFileSync(path.join(rotated.dir, 'manifest.json')));
  assert.equal(m.files.length, 2);
  assert.match(m.files[0].path, /^log\/audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
  assert.deepEqual([m.files[0].first, m.files[0].last, m.files[1].path, m.files[1].first, m.files[1].last], [1, 34_500, 'log/audit.jsonl', 34_501, 34_501]);
  assert.equal(JSON.parse(lines(path.join(rotated.dir, 'log', 'audit.jsonl'))[0]).action, 'audit.export');
  assert.equal((await verify([rotated.dir, '--fingerprint', FP])).code, 0);

  // Just under 20 MB: entries written while the export streams rotate the file it has open; the bundle is what was checked.
  const under = fresh();
  keyedChainOf(entriesUnder(20 * 1024 * 1024 - 3000), { file: under, words: noise });
  assert.ok(fs.statSync(under).size > 20 * 1024 * 1024 - 4000);
  const log = auditLog(under);
  const s = await exportServer(log);
  try {
    const a = await slowClient(s.base);
    const rotations = log.rotations;
    for (let i = 0; i < 20; i++) log.write(SAM, 'login', 'sam', noise(), '10.0.0.9');
    assert.equal(log.rotations, rotations + 1, 'the file the export holds open was renamed aside');
    const got = await a.read();
    await s.settled();
    assert.equal(got.whole, true);
    const dir = unzipTo(got.body, tmp('agm-bundle-'));
    const v = await verify([dir, '--fingerprint', FP]);
    assert.equal(v.code, 0, v.out);
    const mm = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    assert.deepEqual(mm.files.map((f) => f.path), ['log/audit.jsonl'], 'each file keeps the name it had when it was opened');
    assert.equal(entries(under).pop().action, 'audit.export.sent');
  } finally { await s.close(); }
});

test('rotation between the listing and the opens: the files are listed and opened again, the bundle ends at the file the export\'s own entry was rotated into, and it is whole; rotating at every try refuses after three', async () => {
  const file = fresh();
  const log = written(3, file);
  const realOpen = fs.promises.open;
  let opens = 0;
  // The first open of the export: another request writes meanwhile, and that write rotates the file (it was full).
  fs.promises.open = async (p, ...rest) => {
    if (!opens++) { log.size = 64 * 1024 * 1024; log.write(SAM, 'login', 'kim', 'signed in meanwhile', '10.0.0.8'); }
    return realOpen.call(fs.promises, p, ...rest);
  };
  let got;
  try { got = await exported(log); } finally { fs.promises.open = realOpen; }
  assert.equal(log.rotations, 1);
  const m = JSON.parse(fs.readFileSync(path.join(got.dir, 'manifest.json')));
  const rotatedName = path.basename(log.rotated()[0]);
  assert.deepEqual(m.files.map((f) => [f.path, f.first, f.last]), [['log/' + rotatedName, 1, 4]], 'the file the entry was rotated into, and none after it');
  assert.ok(!fs.existsSync(path.join(got.dir, 'log', 'audit.jsonl')), 'the new file holds only later entries: not the export\'s');
  assert.equal(JSON.parse(lines(path.join(got.dir, 'log', rotatedName)).pop()).action, 'audit.export');
  assert.deepEqual([m.check.mark, m.entries, m.head.seq], ['intact', { from: 1, to: 4 }, 4]);
  const v = await verify([got.dir, '--fingerprint', FP]);
  assert.equal(v.code, 0, v.out);
  assert.deepEqual(entries(file).map((e) => [e.seq, e.action]), [[5, 'login'], [6, 'audit.export.sent']]);

  // A rotation at every try: refused after the third, its end written, nothing left open.
  const busyFile = fresh();
  const busy = written(2, busyFile);
  const s = await exportServer(busy);
  fs.promises.open = async (p, ...rest) => {
    await wait(2);   // each rotated name carries its millisecond
    busy.size = 64 * 1024 * 1024;
    busy.write(SAM, 'login', 'kim', 'signed in meanwhile', '10.0.0.8');
    return realOpen.call(fs.promises, p, ...rest);
  };
  try {
    const r = await fetchExport(s.base);
    await s.settled();
    assert.deepEqual([r.status, r.json.error], [409, 'not exported: the log rotated while the export started: try again']);
  } finally { fs.promises.open = realOpen; await s.close(); }
  assert.deepEqual([entries(busyFile).pop().action, s.exporter.busy(), s.exporter.handles.length], ['audit.export.fail', null, 0]);
});

test('a rotated file changed between the check and the stream ends the export with its words, and the browser never gets a whole zip', async () => {
  const file = fresh();
  keyedChainOf(34_500, { file, words: noise });
  const log = auditLog(file);
  log.write(SAM, 'login', 'sam', 'signed in', '10.0.0.9');   // rotates: the 20 MB file is set aside
  log.flush();
  const older = log.rotated()[0];
  assert.ok(older);
  const s = await exportServer(log);
  try {
    const a = await slowClient(s.base);
    const fd = fs.openSync(older, 'r+');
    const size = fs.fstatSync(fd).size;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 100);
    b[0] ^= 1;
    fs.writeSync(fd, b, 0, 1, size - 100);
    fs.closeSync(fd);
    const got = await a.read();
    await s.settled();
    assert.equal(got.whole, false, 'the download is cut short');
    assert.notEqual(got.body.subarray(-22).readUInt32LE(0), 0x06054b50, 'no end record');
    const last = entries(file).pop();
    assert.deepEqual([last.action, last.words], ['audit.export.fail', 'the export of entries 1–34502 was not sent whole: a file changed while it was exported (log/' + path.basename(older) + ')']);
    assert.deepEqual([s.exporter.busy(), s.exporter.handles.length], [null, 0]);
  } finally { await s.close(); }
});

test('refused before its row: a run with no machine key (503), a copy with no verifier to ship (503); a row the disk will not take says so, and its end follows it', async () => {
  const keylessFile = fresh();
  const keyless = new audit.AuditLog(keylessFile, { keys: () => { throw Object.assign(new Error('the machine key could not be read (EBUSY)'), { code: 'EBUSY' }); }, records: h.recordsOf(keylessFile) });
  const k = await exportServer(keyless);
  try {
    const r = await fetchExport(k.base);
    assert.deepEqual([r.status, r.json.error], [503, 'not exported: this run has no machine key (EBUSY), so an export cannot be signed']);
    assert.deepEqual(entries(keylessFile).map((e) => e.action), ['audit.keyless'], 'no row');
  } finally { await k.close(); }
  const bareFile = fresh();
  const bare = written(2, bareFile);
  const n = await exportServer(bare, { verifyDir: tmp('agm-noverify-') });
  try {
    const r = await fetchExport(n.base);
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'not exported: this copy has no verifier to ship (' + path.join('app', 'verify', 'page.html') + ': ENOENT)');
    assert.equal(entries(bareFile).length, 2, 'no row');
    assert.equal(n.exporter.busy(), null);
  } finally { await n.close(); }
  // The disk refuses the row: nothing is listed or sent, and the row's end is written after it once the disk takes them.
  const fullFile = fresh();
  const full = written(2, fullFile);
  const f = await exportServer(full);
  const real = fs.openSync;
  try {
    fs.openSync = (p, ...rest) => { if (path.resolve(String(p)) === path.resolve(fullFile)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return real.call(fs, p, ...rest); };
    const r = await fetchExport(f.base);
    assert.deepEqual([r.status, r.json.error], [503, 'not exported: the log would not take the export\'s own entry (ENOSPC)']);
  } finally { fs.openSync = real; await f.close(); }
  assert.ok(full.flush());
  assert.deepEqual(entries(fullFile).slice(2).map((e) => [e.action, e.words]), [
    ['audit.export', 'export started, for checking on another computer: entries 1–3, the whole log, this entry its last; signed with key ' + FP.slice(0, 16).match(/.{4}/g).join(' ')],
    ['audit.export.fail', 'the export of entries 1–3 was not made: the log would not take its own entry (ENOSPC)'],
  ]);
});

test('Last export: the newest `audit.export.sent` this machine wrote, read again at the next start; a changed one is not, nor one not on disk yet; none says so', async () => {
  const file = fresh();
  const log = written(2, file);
  assert.equal(log.facts().lastExport, null);
  await exported(log);
  const sent = entries(file).pop();
  assert.deepEqual(log.facts().lastExport, { at: sent.at, by: 'ana', from: 1, to: 3 });
  log.flush();
  const again = auditLog(file);
  again.open();
  assert.deepEqual(again.facts().lastExport, { at: sent.at, by: 'ana', from: 1, to: 3 }, 'the scan at open');
  // The same row with its range changed (its MAC no longer holds) is not an export.
  const ls = lines(file);
  ls[ls.length - 1] = ls[ls.length - 1].replace('"target":"1-3"', '"target":"1-9"');
  fs.writeFileSync(file, ls.join('\n') + '\n');
  const changed = auditLog(file);
  changed.open();
  assert.equal(changed.facts().lastExport, null);
  // An export sent whole is "Last export" once its row is on disk, never before: a row the disk refuses is not one yet.
  const realOpenSync = fs.openSync;
  let row;
  try {
    fs.openSync = (p, ...rest) => { if (path.resolve(String(p)) === path.resolve(file)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return realOpenSync.call(fs, p, ...rest); };
    row = changed.write(ANA, 'audit.export.sent', '1-5', 'export sent whole: entries 1–5, 2 KB; the zip\'s SHA-256 is ' + '0'.repeat(64), '10.0.0.9');
    assert.ok(changed.onDisk.seq < row.seq);
    assert.equal(changed.facts().lastExport, null, 'not on disk: not an export the log holds');
  } finally { fs.openSync = realOpenSync; }
  assert.ok(changed.flush());
  assert.deepEqual(changed.facts().lastExport, { at: row.at, by: 'ana', from: 1, to: 5 }, 'on disk now');
});

// ---------------------------------------------------------------- who may export, end to end
/** A request as another device on the venue network makes it: its Host names the laptop's address, not loopback. */
function asDevice(base, method, url, { cookie = '', headers = {}, ca = null } = {}) {
  const u = new URL(base + url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, ca, headers: { host: '10.1.2.3:' + u.port, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString()); } catch { /* a zip */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const tunnel = { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'x', 'cf-visitor': '{"scheme":"https"}' };
/** Every file under a folder, with its size, as names a test compares. */
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => String(f)).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
/**
 * A folder's files, listed at a moment no store is saving into it: the atomic writer's `<file>.<pid>.tmp` is there only
 * while a save is under way (a sign-in's sessions, say), and is never a file the folder keeps.
 */
async function settled(dir) {
  let seen = null;
  await h.until(() => { const l = listing(dir); if (l.some((f) => /\.\d+\.tmp$/.test(f))) return false; seen = l; return true; }, 5000, 'a moment no store saves into ' + dir);
  return seen;
}

test('end to end: who may export — the token at the laptop and an admin at the laptop or over HTTPS; never a manager, an account without audit.read, a code guest, plain HTTP from another device, the token off the laptop or from before a restart, nor the right through the tunnel', async (t) => {
  const dataDir = tmp('agm-e2e-');
  let srv = await h.startServer({ AGM_DATA_DIR: dataDir, AGM_TLS: '1' });
  t.after(async () => { await h.stopServer(srv.child); });
  const { base } = srv;
  const tok = (await h.api(base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const ana = (await h.api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const make = async (username, role, grant = []) => {
    const r = await h.api(base, 'POST', '/api/users', { username, name: username, role, grant, password: 'a long pass phrase here' }, { cookie: ana });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (await h.api(base, 'POST', '/api/auth/login', { username, password: 'a long pass phrase here' })).cookie;
  };
  const mia = await make('mia', 'manager');
  const sid = await make('sid', 'staff', ['audit.export']);
  const pia = await make('pia', 'manager', ['audit.export']);
  const health = async () => (await h.api(base, 'GET', '/api/health', undefined, { cookie: tok })).body.saves.stores.audit;
  const fp = (await health()).signKey;
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, secretbox.signingKeyFrom(secretbox.deriveFrom(h.serverKey(dataDir), SIGN)).fingerprint, 'health names the machine\'s signing key');
  assert.ok(srv.out().includes('  Signing key: ' + fp.match(/.{4}/g).join(' ') + '\n'), 'the black window prints it in full');
  assert.deepEqual((await h.api(base, 'GET', '/api/audit', undefined, { cookie: ana })).body.key, { kid: (await health()).kid, fingerprint: fp });
  assert.equal((await health()).lastExport, null);
  const refused = async (cookie, status, words, o = {}) => {
    const r = o.device ? await asDevice(base, 'POST', '/api/audit/export', { cookie, headers: o.headers || {} }) : await h.api(base, 'POST', '/api/audit/export', {}, { cookie, headers: o.headers || {} });
    assert.equal(r.status, status, JSON.stringify(r.body || r.json));
    assert.equal((r.body && !Buffer.isBuffer(r.body) ? r.body : r.json).error, words);
  };
  const rows = () => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const exportsBefore = rows().filter((e) => e.action.startsWith('audit.export')).length;
  await refused(mia, 403, 'Your account may not do that.');
  await refused(sid, 403, 'An export reads every entry: your account needs audit.read as well as audit.export.');
  await refused('', 401, 'Sign in first.');
  await refused(ana, 403, 'Export over HTTPS: open https://10.1.2.3:' + srv.port + ' (trust this AGMessage\'s certificate once: /tls).', { device: true });
  await refused(tok, 401, 'Sign in first.', { device: true });
  // Through the tunnel while admins may not sign in there: the right is refused, and so is the account's sign-in.
  await refused(pia, 403, 'Accounts with admin rights work on the venue network, not through the tunnel (an admin can allow it in Settings).', { headers: tunnel });
  const viaTunnel = await h.api(base, 'POST', '/api/auth/login', { username: 'pia', password: 'a long pass phrase here' }, { headers: tunnel });
  assert.equal(viaTunnel.status, 401);
  assert.deepEqual(rows().filter((e) => e.action === 'login.refused').map((e) => [e.target, e.words]), [['pia', 'admin rights through the tunnel']]);
  assert.equal(rows().filter((e) => e.action.startsWith('audit.export')).length, exportsBefore, 'no refusal writes an export row');

  // Allowed: the token at the laptop, an admin at the laptop, an admin from another device over HTTPS, and a manager given
  // the right. One export at a time: each next one waits for the last one's end in the log, which frees its slot.
  const sentRows = () => rows().filter((e) => e.action === 'audit.export.sent').length;
  const ended = async (n) => { await h.until(() => sentRows() >= n, 5000, 'export ' + n + '\'s own end in the log'); };
  const keyDir = dataDir + '-keys';
  const before = [await settled(dataDir), await settled(keyDir)];
  const viaToken = await h.api(base, 'POST', '/api/audit/export', {}, { cookie: tok });
  await ended(1);
  assert.equal(viaToken.status, 200);
  assert.match(viaToken.headers.get('x-agm-export'), /^entries=1-\d+; mark=intact; key=[0-9a-f]{16}$/);
  assert.ok(viaToken.headers.get('x-agm-export').endsWith('key=' + fp.slice(0, 16)));
  const tokenRow = rows().filter((e) => e.action === 'audit.export').pop();
  assert.deepEqual(tokenRow.actor, { t: 'admin', id: 'host', name: 'AGMessage laptop' });
  // No copy is kept: the same files in the data folder and the key folder, the log's own lines aside.
  assert.deepEqual([await settled(dataDir), await settled(keyDir)], before);
  const viaAdmin = await h.api(base, 'POST', '/api/audit/export', {}, { cookie: ana });
  assert.equal(viaAdmin.status, 200);
  await ended(2);
  const cer = Buffer.from(await (await fetch(base + '/tls.cer')).arrayBuffer());
  const ca = '-----BEGIN CERTIFICATE-----\n' + cer.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  const overHttps = await asDevice(base.replace('http:', 'https:'), 'POST', '/api/audit/export', { cookie: ana, ca });
  assert.equal(overHttps.status, 200, overHttps.body.toString().slice(0, 200));
  assert.equal(readZip(overHttps.body).filter((m) => m.name.endsWith('/SHA256SUMS.sig')).length, 1);
  await ended(3);
  assert.equal((await h.api(base, 'POST', '/api/audit/export', {}, { cookie: pia })).status, 200);
  await ended(4);
  const done = rows().filter((e) => e.action === 'audit.export.sent');
  assert.deepEqual(done.map((e) => e.actor.name), ['AGMessage laptop', 'ana', 'ana', 'pia']);
  const newest = done[done.length - 1];
  assert.deepEqual((await health()).lastExport, { at: newest.at, by: 'pia', from: 1, to: Number(newest.target.split('-')[1]) });

  // After a restart: Last export is read again from the log, and the token's sign-in from before it may not export.
  srv = await h.restartServer(srv, { AGM_TLS: '1' });
  assert.deepEqual((await h.api(srv.base, 'GET', '/api/health', undefined, { cookie: tok })).body.saves.stores.audit.lastExport, { at: newest.at, by: 'pia', from: 1, to: Number(newest.target.split('-')[1]) });
  const me = (await h.api(srv.base, 'GET', '/api/admin/me', undefined, { cookie: tok })).body;
  assert.deepEqual([me.ok, me.token], [true, false], 'the sign-in survived the restart, but was not made by this run');
  const stale = await h.api(srv.base, 'POST', '/api/audit/export', {}, { cookie: tok });
  assert.deepEqual([stale.status, stale.body.error], [403, 'Sign in again with the token (Admin login): a sign-in from before the restart cannot export.']);
  const again = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  assert.equal((await h.api(srv.base, 'POST', '/api/audit/export', {}, { cookie: again })).status, 200);
});

test('speed: an export of the 56,000-entry log while a page asks and a person signs in: neither waits more than 300 ms for it', async (t) => {
  const dataDir = tmp('agm-e2e-');
  const keyDir = dataDir + '-keys';
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'machine.key'), FIXTURE_KEY.toString('base64'));
  keyedChainOf(56_000, { file: path.join(dataDir, 'audit.jsonl'), records: path.join(keyDir, 'audit') });
  const srv = await h.startServer({ AGM_DATA_DIR: dataDir });
  t.after(async () => { await h.stopServer(srv.child); });
  const admin = (await h.api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  await h.api(srv.base, 'POST', '/api/users', { username: 'bob', name: 'Bob', role: 'staff', password: 'clipboard and coffee' }, { cookie: admin });
  const signIn = async () => { const t0 = performance.now(); const r = await h.api(srv.base, 'POST', '/api/auth/login', { username: 'bob', password: 'clipboard and coffee' }); assert.equal(r.status, 200); return performance.now() - t0; };
  const alone = Math.min(await signIn(), await signIn());
  let worst = 0;
  const state = { running: true };
  const probe = (async () => {
    while (state.running) {
      const t0 = performance.now();
      await h.api(srv.base, 'GET', '/api/auth/me');
      worst = Math.max(worst, performance.now() - t0);
    }
  })();
  const exporting = (async () => { const r = await fetch(srv.base + '/api/audit/export', { method: 'POST', headers: { cookie: admin } }); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; })();
  await wait(150);
  const during = await signIn();
  const r = await exporting;
  state.running = false;
  await probe;
  assert.equal(r.status, 200);
  assert.ok(readZip(r.body).some((m) => m.name.endsWith('/log/audit.jsonl')), 'the whole log was exported');
  assert.ok(worst < 300, 'a page asking meanwhile waited at most ' + Math.round(worst) + ' ms');
  assert.ok(during - alone < 300, 'a sign-in meanwhile took ' + Math.round(during) + ' ms, ' + Math.round(alone) + ' ms alone');
});

test('the screen rows\' voice: a message\'s words and a file\'s name taken to a screen are in no row this version writes, and in no member of an export made after; with HTTPS off, another device is sent to the laptop', async (t) => {
  const srv = await h.startServer();
  t.after(async () => { await h.stopServer(srv.child); });
  const tok = (await h.api(srv.base, 'POST', '/api/admin/login', { token: h.TOKEN })).cookie;
  const ana = (await h.api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const device = await asDevice(srv.base, 'POST', '/api/audit/export', { cookie: ana });
  assert.deepEqual([device.status, device.json.error], [403, 'Export at the AGMessage laptop: HTTPS is off on this AGMessage, and from another device an export goes only over HTTPS.']);
  const code = (await h.api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: tok })).body.code;
  const socket = await h.connect(srv.base, tok);
  const words = 'Quarterly figures restated sevenfold';
  const fileName = 'board-pack-confidential-v9.pdf';
  try {
    const d = (await h.emit(socket, 'display:create', { code, name: 'Lectern' })).display;
    assert.ok((await h.emit(socket, 'display:take', { id: d.id, content: { kind: 'message', text: words } })).ok);
    assert.ok((await h.emit(socket, 'display:take', { id: d.id, content: { kind: 'file', url: '/uploads/1700000000000-abcdefghijkl-' + fileName, name: fileName, page: 3 } })).ok);
  } finally { socket.close(); }
  const r = await fetch(srv.base + '/api/audit/export', { method: 'POST', headers: { cookie: tok } });
  assert.equal(r.status, 200);
  const zip = Buffer.from(await r.arrayBuffer());
  const takes = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'display.take');
  assert.deepEqual(takes.map((e) => e.words), ['Lectern → a message (36 characters)', 'Lectern → a PDF at p. 3'], 'each take is in the log, in its audit voice');
  for (const m of readZip(zip)) {
    for (const secret of [words, 'sevenfold', fileName]) assert.ok(!m.data.includes(secret), secret + ' is not in ' + m.name);
  }
  assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').includes('sevenfold'));
});
