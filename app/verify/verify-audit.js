'use strict';
/**
 * The audit log's verifier, for another computer (H.9.5): it checks the folder an AGMessage audit export unpacks to, with
 * Node and nothing else (no package, no network), on the Node an AGMessage bundle carries or any Node from 22.
 *
 *   node verify-audit.js <the extracted folder> --fingerprint <64 hex> [--earlier <an earlier export's folder>] [--list]
 *
 * In this order: the folder (only the bundle's fixed paths), the key (its fingerprint against the one you expect), the
 * signature over SHA256SUMS, every file against SHA256SUMS, the entries (whole lines, links, the legacy hashes, the runs,
 * and the last entry the export's own), then the laptop's own verdict, and with --list the entries to read.
 *
 * Exit codes: 0 signed by the expected key and whole, and the laptop said ✓ · 1 the same, and the laptop said ◇ or △ ·
 * 2 the same, and the laptop said ✕ · 3 a step failed, or the key is not the one expected: nothing in the bundle is
 * vouched for · 4 whole and signed consistently, but no expected fingerprint was given, so not shown to be the laptop's.
 * Code 2 is also the answer when every file is what was signed and the entries break at or after the line the laptop's
 * own signed check named (as an archive's failure the laptop's verdict names is, H.10.7): the bundle is what was
 * exported, and the log was broken then. Any other failure, or a break the verdict does not name, is code 3.
 *
 * Invariants:
 *   - The bundle is what is under check. Every path in SHA256SUMS and manifest.files is held to the bundle's path set
 *     before anything else is opened; each file read is lstat'ed first (a plain file, not a link, inside the folder once
 *     resolved); a file present but not listed is named and never read; a line over 64 KB fails.
 *   - The expected key is the auditor's (--fingerprint, or an earlier export kept off the laptop), never the bundle's.
 *   - Every listed file, the log's included, matches its signed digest before any entry is walked, so no answer but 3
 *     is given for a bundle changed, cut or added to since the export, whatever its entries say.
 *   - Nothing of the entries is printed as content before the steps that vouch for them pass, and a bundle's words are
 *     printed with C0, C1 and bidi control characters escaped, so a crafted bundle cannot paint a ✓ in the terminal.
 *   - No synchronous file call. The rules that need no key are ./auditrules.js, the laptop's own.
 *
 * It also assembles the browser verifier, verify.html (assemblePage): page.html with page.css, auditrules.js and page.js
 * put inline under a meta Content-Security-Policy that carries their SHA-256. A pure function: one release, one page.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rules = require('./auditrules');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const grouped = (fp) => String(fp).match(/.{1,4}/g).join(' ');
const shortKey = (fp) => grouped(String(fp).slice(0, 16)) + ' …';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
/** "18:40 UTC on 26 Oct 2026": the laptop's clock, read in UTC wherever this runs. */
const whenUtc = (at) => { const d = new Date(at); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC on ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
const dayUtc = (at) => { const d = new Date(at); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
const range = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);

/** A bundle's words for a terminal: C0, C1 and bidi control characters shown as \u escapes, never acted on. */
function safe(text) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    out += control ? '\\u' + c.toString(16).padStart(4, '0') : ch;
  }
  return out;
}

/** The last line of a file that ends with a line end, without it ('' when it is over 64 KB). */
function lastLine(buf) {
  if (!buf.length) return '';
  const start = buf.lastIndexOf(10, buf.length - 2) + 1;
  return buf.length - 1 - start > rules.MAX_LINE ? '' : buf.toString('utf8', start, buf.length - 1);
}

const PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]{40,200})\n-----END PUBLIC KEY-----\n?$/;
/** The DER a public-key PEM holds, exactly as written, or null. */
function pemDer(text) {
  const m = PEM.exec(text);
  return m ? Buffer.from(m[1].replace(/\n/g, ''), 'base64') : null;
}

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

/**
 * Check the folder of an export. `fingerprint`: the 64 hex the auditor expects (none: code 4 at best); `list`: keep the
 * entries for reading; `against`: an earlier export's {texts, log, made, fp} to compare with; `keep`: keep each entry's
 * line by seq (for a later compare). Resolves {code, why?, said: [lines], m?, fp?, entries?, texts?}.
 */
async function check(dir, { fingerprint = '', list = false, against = null, keep = false, fsp = fs.promises, self = __dirname } = {}) {
  const said = [];
  let m = null;
  let fp = '';
  let walked = null;   // where the entries' walk stopped, for a laptop that said ✕ there: {file index, line}
  let tailOwn = false; // the bundle's last line is the export's own entry (step 3)
  let root = '';
  const bundled = {};  // the bundle's verify/ files, digest-checked (step 3), for where this verifier came from
  try {
    try { root = await fsp.realpath(dir); } catch (e) { refuse('the folder ' + dir + ' cannot be read (' + (e.code || e.message) + ')'); }
    const listed = new Map();   // path -> digest
    /** A path of the bundle's set, read once its lstat says it is a plain file inside the folder. */
    const read = async (rel) => {
      const full = path.join(root, ...rel.split('/'));
      let st;
      try { st = await fsp.lstat(full); } catch (e) { refuse(rel + ' is not in the folder (' + (e.code || e.message) + ')'); }
      if (st.isSymbolicLink() || !st.isFile()) refuse(rel + ' is not a plain file (a link, or a folder)');
      const real = await fsp.realpath(full);
      if (!real.startsWith(root + path.sep)) refuse(rel + ' resolves outside the folder');
      return fsp.readFile(real);
    };

    // 0. The folder: SHA256SUMS's paths, then the manifest's, each of the set, before anything else is opened.
    const sumsBuf = await read('SHA256SUMS');
    const sums = rules.parseSums(sumsBuf.toString('utf8'));
    if (sums.why) refuse(sums.why);
    for (const s of sums.list) listed.set(s.path, s.digest);
    if (!listed.has('manifest.json') || !listed.has('signing-key.pem')) refuse('SHA256SUMS does not list manifest.json and signing-key.pem');
    try { m = JSON.parse((await read('manifest.json')).toString('utf8')); } catch (e) { if (e instanceof Refused) throw e; refuse('manifest.json is not JSON'); }
    const shape = rules.manifestProblem(m);
    if (shape) refuse(shape);
    for (const f of m.files) { const why = rules.pathProblem(f.path); if (why) refuse('manifest.json names ' + why); }
    const logs = m.files.map((f) => f.path);
    if (new Set(logs).size !== logs.length) refuse('manifest.json lists a log file twice');
    for (const p of logs) if (!listed.has(p)) refuse('SHA256SUMS does not list ' + p + ', which manifest.json names');
    for (const p of listed.keys()) if (rules.isLogPath(p) && !logs.includes(p)) refuse('SHA256SUMS lists ' + p + ', which manifest.json does not name');
    const extra = await unlisted(root, listed, fsp);
    if (extra.length) refuse(extra.map((p) => p + ' is not part of the export').join('; ') + ' (not read)');

    // 1. The key: the signing key's fingerprint is the manifest's, and the one expected.
    const der = pemDer((await read('signing-key.pem')).toString('latin1'));
    if (!der) refuse('signing-key.pem is not a public key in PEM');
    let pub;
    try { pub = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { refuse('signing-key.pem is not a public key'); }
    if (pub.asymmetricKeyType !== 'ed25519' || !pub.export({ format: 'der', type: 'spki' }).equals(der)) refuse('signing-key.pem is not an Ed25519 public key');
    fp = sha256(der);
    if (fp !== m.signingKey.fingerprint) refuse('manifest.json names key ' + shortKey(m.signingKey.fingerprint) + ', and signing-key.pem is key ' + shortKey(fp));
    if (fingerprint && fp !== fingerprint) refuse('signed by key ' + shortKey(fp) + ', not the key you expected (' + shortKey(fingerprint) + ')');

    // 2. The signature, over SHA256SUMS's exact bytes.
    const sig = await read('SHA256SUMS.sig');
    if (sig.length !== 64 || !crypto.verify(null, sumsBuf, pub, sig)) refuse('the signature over SHA256SUMS does not check against signing-key.pem');
    said.push('✓ signed by key ' + grouped(fp) + (fingerprint ? ', the key you expected' : ''));

    // 3. Every listed file against its digest, the log's included, before any entry is read. Each log file is also the
    // size the manifest gives and ends with a whole line; the last one's last line is kept, to be the export's own entry.
    const described = new Map(m.files.map((f) => [f.path, f]));
    const lastPath = m.files[m.files.length - 1].path;
    let tail = null;
    for (const [p, digest] of listed) {
      const buf = await read(p);
      if (sha256(buf) !== digest) refuse(p + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
      const f = described.get(p);
      if (f && buf.length !== f.bytes) refuse(p + ' is ' + buf.length + ' bytes; manifest.json says ' + f.bytes);
      if (f && buf.length && buf[buf.length - 1] !== 10) refuse('the last line of ' + p + ' is not whole');
      if (p === lastPath) tail = rules.wholeEntry(lastLine(buf));
      if (p.startsWith('verify/')) bundled[p] = buf;
    }
    const target = m.entries.from + '-' + m.entries.to + ';' + m.signingKey.fingerprint.slice(0, 16);
    /** The export's own entry: the last of the bundle, the head and the range manifest.json names. */
    const own = (e) => !!e && e.action === 'audit.export' && e.k === m.kid && e.l === m.log && e.seq === m.entries.to && e.seq === m.head.seq && e.h === m.head.h && e.target === target;
    tailOwn = own(tail);

    // 4. The entries, file by file in chain order: each file read again against its digest, then whole lines, links,
    // legacy hashes and runs.
    const chain = new rules.Chain(m.kid);
    const entries = list ? [] : null;
    const texts = keep ? new Map() : null;
    let last = null;
    for (let i = 0; i < m.files.length; i++) {
      const f = m.files[i];
      const buf = await read(f.path);
      if (sha256(buf) !== listed.get(f.path)) refuse(f.path + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
      let start = 0;
      let line = 0;
      let first = 0;
      let lastHere = 0;
      while (start < buf.length) {
        const nl = buf.indexOf(10, start);
        line++;
        // A break in the chain's own rules here may be the one the laptop's check named (code 2, below).
        walked = { file: i, line };
        if (nl - start > rules.MAX_LINE) refuse('line ' + line + ' of ' + f.path + ' is over 64 KB');
        const text = buf.toString('utf8', start, nl);
        start = nl + 1;
        const e = rules.wholeEntry(text);
        if (!e) refuse('line ' + line + ' of ' + f.path + ' is not a whole entry');
        if (!e.k && sha256(rules.canonical(e)) !== e.h) refuse('entry ' + e.seq + ' (line ' + line + ' of ' + f.path + ') was changed after it was written');
        const why = chain.next(e);
        if (why) refuse(why + ' (line ' + line + ' of ' + f.path + ')');
        walked = null;
        lastHere = e.seq;
        if (against && against.texts.has(e.seq) && against.texts.get(e.seq) !== text) {
          refuse('entry ' + e.seq + ' is not the same in the two exports: the log was written again between ' + dayUtc(against.made) + ' and ' + dayUtc(m.made));
        }
        if (!first) first = e.seq;
        last = e;
        if (entries) entries.push(e);
        if (texts) texts.set(e.seq, text);
      }
      if (first !== f.first || lastHere !== f.last) refuse(f.path + ' holds ' + range(first, lastHere) + '; manifest.json says ' + range(f.first, f.last));
    }
    const open = chain.end();
    if (open) refuse(open);
    if (!own(last)) refuse('the last entry is not the export\'s own (audit.export, ' + target + ', the head manifest.json names)');
    if (m.entries.from !== 1 || m.files[0].first !== 1) refuse('the entries do not begin at entry 1');
    if (against) {
      if (against.log !== m.log) refuse('the two exports are of different logs (' + against.log.slice(0, 8) + '…, ' + m.log.slice(0, 8) + '…)');
      const beyond = Array.from(against.texts.keys()).filter((s) => s > last.seq);
      if (beyond.length) refuse(range(beyond[0], beyond[beyond.length - 1]) + ' of the earlier export are not in this one');
      said.push('✓ the same: ' + range(1, against.texts.size) + ' of the earlier export (made ' + whenUtc(against.made) + ') are in this one, byte for byte');
    }
    said.push('✓ whole: ' + range(m.entries.from, m.entries.to) + ' in ' + m.files.length + ' file' + (m.files.length === 1 ? '' : 's') + ', every line whole and linked to the one before, the plain hashes holding, the key changing only at a named boundary, and the last entry the export\'s own');
    for (const s of chain.spans) {
      const id = 's' + s.from + '-' + s.to;
      const a = chain.accepts.get(id);
      const what = s.runs.map((r) => (r.kind === 'plain' ? range(r.from, r.to) + ' with plain hashes' : range(r.from, r.to) + ' under key id ' + r.kind.slice(0, 4) + '… (their own claim)')).join(', ');
      said.push((a ? '◇ ' : '△ ') + what + ': ' + (a ? 'accepted on the AGMessage laptop by entry ' + a.seq + ' (' + dayUtc(a.at) + ')' : 'not accepted on the laptop'));
    }
    const out = { code: fingerprint ? rules.codeFor(m.check.mark) : 4, said, m, fp, spans: chain.spans, accepts: chain.accepts };
    if (entries) out.entries = entries;
    if (texts) out.texts = texts;
    out.provenance = await provenance(root, bundled, self, fsp);
    return out;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    // The entries break at or after the line the laptop's own check named. `walked` is set only inside step 4's walk, so
    // steps 0-3 passed: the key, the signature and every file's digest. With the last entry the export's own, the bundle
    // is what was exported, and the log was broken then (code 2). Anywhere else, the bundle disagrees with itself (3).
    if (walked && m.check.mark === 'broken' && (!fingerprint || fp === fingerprint) && tailOwn && m.entries.from === 1 && m.files[0].first === 1) {
      const at = m.files.findIndex((f) => f.path === 'log/' + m.check.file);
      if (at >= 0 && Number.isSafeInteger(m.check.brokenAt) && (at < walked.file || (at === walked.file && m.check.brokenAt <= walked.line))) {
        said.push('✓ every file is what was signed: each matches its SHA-256 in SHA256SUMS, and the last entry is the export\'s own');
        said.push('✕ the entries break where the laptop\'s own check said they do: ' + e.message);
        return { code: fingerprint ? 2 : 4, said, m, fp, broken: e.message, provenance: await provenance(root, bundled, self, fsp) };
      }
    }
    return { code: 3, why: e.message, said, m, fp };
  }
}

/** Files present under the folder that SHA256SUMS does not list (beside it and its signature): named, never read. */
async function unlisted(root, listed, fsp) {
  const out = [];
  const walk = async (rel, depth) => {
    const names = await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
    for (const d of names) {
      const p = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (!listed.has(p) && p !== 'SHA256SUMS' && p !== 'SHA256SUMS.sig') out.push(p);
      if (out.length > 20) return;
    }
  };
  await walk('', 0);
  return out;
}

/**
 * Where this verifier came from, in words: from the bundle under check (then it says so), or beside a release's files,
 * whose verify/ files the bundle's are compared with, any that differs named.
 */
async function provenance(root, bundled, self, fsp) {
  let here;
  try { here = await fsp.realpath(self); } catch { here = path.resolve(self); }
  if (here === path.join(root, 'verify')) return ['this verifier came from the bundle it is checking: check it again with the release\'s verifier (agmessage-audit-verifier-<version>.zip, its digest in the release\'s SHA256SUMS)'];
  const mine = await ownFiles(here, fsp);
  const out = [];
  for (const [p, buf] of Object.entries(bundled)) {
    const name = p.slice('verify/'.length);
    if (mine[name] && !mine[name].equals(buf)) out.push('the bundle\'s ' + p + ' is not this verifier\'s ' + name + ': do not run the bundle\'s copy');
  }
  return out;
}

/** This verifier's own files, by the names a bundle gives them: verify.html as it stands beside it, or as its page files make it. */
async function ownFiles(dir, fsp = fs.promises) {
  const out = {};
  const take = async (name) => { try { return await fsp.readFile(path.join(dir, name)); } catch { return null; } };
  for (const name of ['verify-audit.js', 'auditrules.js', 'verify.html']) { const b = await take(name); if (b) out[name] = b; }
  return out;
}

// ---------------------------------------------------------------- the browser verifier's one file
const PLACE = /__(CSP|VERSION|STYLE|RULES|PAGE)__/g;
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cspHash = (text) => "'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'";

/**
 * verify.html from page.html, page.css, auditrules.js and page.js (strings) and the version it names: each put inline in
 * its one place, the meta Content-Security-Policy carrying their SHA-256, so the page loads nothing and sends nothing.
 */
function assemblePage({ html, css, rules: rulesText, js, version }) {
  const found = String(html).match(PLACE) || [];
  if (found.length !== 5 || new Set(found).size !== 5) throw new Error('page.html must hold each of __CSP__, __VERSION__, __STYLE__, __RULES__ and __PAGE__ once');
  for (const [name, text] of [['auditrules.js', rulesText], ['page.js', js]]) if (/<\/script|<!--|<script/i.test(text)) throw new Error(name + ' cannot be put inline: it holds "</script", "<script" or "<!--"');
  if (/<\/style/i.test(css)) throw new Error('page.css cannot be put inline: it holds "</style"');
  const csp = "default-src 'none'; script-src " + cspHash(rulesText) + ' ' + cspHash(js) + '; style-src ' + cspHash(css) + "; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'";
  const parts = { CSP: csp, VERSION: escapeHtml(version), STYLE: css, RULES: rulesText, PAGE: js };
  return String(html).replace(PLACE, (_m, k) => parts[k]);
}

/** verify.html as the page files in `dir` make it, for `version`. */
async function pageFrom(dir, version, fsp = fs.promises) {
  const t = (name) => fsp.readFile(path.join(dir, name), 'utf8');
  return assemblePage({ html: await t('page.html'), css: await t('page.css'), rules: await t('auditrules.js'), js: await t('page.js'), version });
}

// ---------------------------------------------------------------- the command line
function parse(argv) {
  const a = { dir: '', fingerprint: '', earlier: '', list: false, writePage: '', version: '' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--fingerprint') a.fingerprint = String(argv[++i] || '').replace(/[\s:]/g, '').toLowerCase();
    else if (x === '--earlier') a.earlier = String(argv[++i] || '');
    else if (x === '--list') a.list = true;
    else if (x === '--write-page') a.writePage = String(argv[++i] || '');
    else if (x === '--version') a.version = String(argv[++i] || '');
    else if (!a.dir && !x.startsWith('--')) a.dir = x;
    else return { error: 'unknown argument: ' + x };
  }
  if (a.fingerprint && !/^[0-9a-f]{64}$/.test(a.fingerprint)) return { error: '--fingerprint takes the 64 hex characters of the laptop\'s signing key' };
  return a;
}

const USAGE = 'node verify-audit.js <the extracted folder> --fingerprint <the laptop\'s signing key, 64 hex> [--earlier <an earlier export\'s folder>] [--list]';
const MARK = { intact: '✓', linked: '◇', unvouched: '△', broken: '✕' };

/** Run as a command: prints what it found and resolves the exit code. */
async function main(argv, print = (line) => { process.stdout.write(line + '\n'); }) {
  const a = parse(argv);
  if (a.error) { print(a.error); print(USAGE); return 3; }
  if (a.writePage) {
    await fs.promises.writeFile(a.writePage, await pageFrom(__dirname, a.version || 'unknown'));
    print('wrote ' + a.writePage);
    return 0;
  }
  if (!a.dir) { print(USAGE); return 3; }
  let expected = a.fingerprint;
  let against = null;
  const lead = [];
  if (a.earlier) {
    const before = await check(a.earlier, { fingerprint: '', keep: true });
    // Both must pass steps 0-4: an earlier export whose entries break (where its laptop said, or anywhere) holds no
    // entries to compare with.
    if (before.code === 3 || !before.texts) {
      print('✕ The earlier export does not check: ' + safe(before.code === 3 ? before.why : 'its entries break where its laptop\'s own check said they do (' + before.broken + '), so they cannot be compared'));
      print('Nothing was compared (exit 3).');
      return 3;
    }
    if (!expected) { expected = before.fp; lead.push('The key you expect is taken from the earlier export ' + safe(a.earlier) + ' (' + grouped(before.fp) + '): it must be one you kept off the laptop.'); }
    against = { texts: before.texts, log: before.m.log, made: before.m.made, fp: before.fp };
  }
  const r = await check(a.dir, { fingerprint: expected, list: a.list, against });
  for (const l of lead) print(l);
  if (against && r.fp && r.fp !== against.fp) print('△ signed by another key than the earlier export: the laptop\'s machine key changed between them, or they come from two laptops');
  for (const l of r.provenance || []) print('△ ' + safe(l));
  if (r.code === 3) {
    for (const l of r.said) print(safe(l));
    print('✕ ' + safe(r.why));
    print('Nothing in this bundle is vouched for (exit 3).');
    return 3;
  }
  for (const l of r.said) print(safe(l));
  const m = r.m;
  const own = r.code === 4 ? 'The bundle\'s own claim (not compared with a record of the laptop\'s key, so not shown to be the laptop\'s)' : 'The laptop\'s own check';
  print(own + ', run for this export through its own entry (made ' + whenUtc(m.made) + ', by ' + safe(m.by.name || m.by.t) + ', AGMessage ' + safe(m.node.version) + '):');
  print('  ' + (MARK[m.check.mark] || '✕') + ' ' + safe(m.check.words));
  for (const f of m.check.findings) if (f && typeof f.words === 'string') print('    ' + (MARK[f.mark] || '✕') + ' ' + safe(f.words));
  if (r.entries) {
    const markOf = (seq) => {
      const s = r.spans.find((x) => seq >= x.from && seq <= x.to);
      return s ? (r.accepts.has('s' + s.from + '-' + s.to) ? '◇' : '△') : ' ';
    };
    for (const e of r.entries) print([e.seq, new Date(e.at).toISOString(), markOf(e.seq), safe(e.actor.name || e.actor.t), safe(e.action), safe(e.target), safe(e.words)].join('  '));
  }
  print('Not checked here: the keyed entries\' own MACs. The laptop\'s key never leaves it; the laptop\'s check above vouches for them.');
  if (r.code === 4) print((r.broken ? 'Every file signed consistently by key ' + grouped(r.fp) + ', its entries breaking where its own check says they do' : 'Whole and signed consistently by key ' + grouped(r.fp)) + ', but not compared with a record of the laptop\'s key: not shown to be the laptop\'s. Anyone can make such a bundle with a key of their own. Give --fingerprint (exit 4).');
  else if (r.broken) print('Signed by the key you expected, and every file is what was exported; the entries break where the laptop\'s own check said they do: the log was broken when it was exported (exit 2).');
  else print({ 0: 'Signed by the key you expected and whole; the laptop said ✓ (exit 0).', 1: 'Signed by the key you expected and whole; the laptop said ' + MARK[m.check.mark] + ': read its findings (exit 1).', 2: 'Signed by the key you expected and whole; the laptop said ✕: the log was broken when it was exported (exit 2).' }[r.code]);
  return r.code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stdout.write('✕ the verifier failed: ' + safe(e && e.message ? e.message : e) + '\n'); process.exitCode = 3; });
}

module.exports = { check, main, assemblePage, pageFrom, ownFiles, safe, pemDer };
