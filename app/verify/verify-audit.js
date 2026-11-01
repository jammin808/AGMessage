'use strict';
/**
 * The audit log's verifier, for another computer (H.9.5): it checks the folder an AGMessage audit export unpacks to, or
 * an archive's folder alone (H.10.3), with Node and nothing else (no package, no network), on the Node an AGMessage bundle
 * carries or any Node from 22.
 *
 *   node verify-audit.js <the extracted folder, or an archive's> --fingerprint <64 hex> [--earlier <an earlier export>] [--list]
 *
 * In this order: the folder (only the bundle's fixed paths), the key (its fingerprint against the one you expect), the
 * signature over SHA256SUMS, every file against SHA256SUMS, each archive the bundle carries (its own signature, files and
 * archive.json, its pin, the archive before it), the entries as one chain from entry 1 across the archives into log/
 * (whole lines, links, the legacy hashes, the runs, and the last entry the export's own), then the laptop's own verdict,
 * and with --list the entries to read. An archive's folder alone is checked the same way, against its own verdict at the
 * split.
 *
 * Exit codes: 0 signed by the expected key and whole, and the laptop said ✓ · 1 the same, and the laptop said ◇ or △ ·
 * 2 the same, and the laptop said ✕ · 3 a step failed, or the key is not the one expected: nothing in the bundle is
 * vouched for · 4 whole and signed consistently, but no expected fingerprint was given, so not shown to be the laptop's.
 * Code 2 is also the answer when every file is what was signed and the entries break at or after the line the laptop's
 * own signed check named (as an archive's failure the laptop's verdict names is, H.10.7): the bundle is what was
 * exported, and the log was broken then. Any other failure, or a break the verdict does not name, is code 3.
 * An archive alone answers 0 or 1 by its verdict at the split (✓ or ◇), 3 on any failure or another key, 4 with none.
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
 *   - No synchronous file call. The rules that need no key, and the folder check itself, are ./auditrules.js: the
 *     laptop's own rules, and the page's check, so the three cannot drift.
 *
 * It also assembles the browser verifier, verify.html (assemblePage): page.html with page.css, auditrules.js and page.js
 * put inline under a meta Content-Security-Policy that carries their SHA-256. A pure function: one release, one page.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rules = require('./auditrules');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const { grouped, whenUtc, dayUtc } = rules;

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

const PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]{40,200})\n-----END PUBLIC KEY-----\n?$/;
/** The DER a public-key PEM holds, exactly as written, or null. */
function pemDer(text) {
  const m = PEM.exec(text);
  return m ? Buffer.from(m[1].replace(/\n/g, ''), 'base64') : null;
}

const { Refused } = rules;
const refuse = (why) => { throw new Refused(why); };

/**
 * Check the folder of an export, or an archive's folder alone. `fingerprint`: the 64 hex the auditor expects (none: code 4
 * at best); `list`: keep the entries for reading; `against`: an earlier export's {texts, log, made, fp} to compare with;
 * `keep`: keep each entry's line by seq (for a later compare). Resolves {code, kind, why?, said: [lines], m?, fp?,
 * entries?, texts?, provenance?}. The checks are the rules file's (`verifyFolder`), the page's too; this hands it the
 * folder as Node reads it.
 */
async function check(dir, { fingerprint = '', list = false, against = null, keep = false, fsp = fs.promises, self = __dirname } = {}) {
  let root = '';
  try { root = await fsp.realpath(dir); } catch (e) { return { code: 3, kind: 'export', why: 'the folder ' + dir + ' cannot be read (' + (e.code || e.message) + ')', said: [], m: null, fp: '' }; }
  const io = {
    /** A path of the folder's set, read once its lstat says it is a plain file inside the folder. */
    async read(rel) {
      const full = path.join(root, ...rel.split('/'));
      let st;
      try { st = await fsp.lstat(full); } catch (e) { refuse(rel + ' is not in the folder (' + (e.code || e.message) + ')'); }
      if (st.isSymbolicLink() || !st.isFile()) refuse(rel + ' is not a plain file (a link, or a folder)');
      const real = await fsp.realpath(full);
      if (!real.startsWith(root + path.sep)) refuse(rel + ' resolves outside the folder');
      return fsp.readFile(real);
    },
    unlisted: (isListed) => unlisted(root, isListed, fsp),
    sha256: async (b) => sha256(b),
    // A turn of the event loop, so a server that runs this check beside a show (an archive's Check) keeps answering.
    turn: () => new Promise((resolve) => { setImmediate(resolve); }),
    async publicKey(der, file) {
      let pub;
      try { pub = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { refuse(file + ' is not a public key'); }
      if (pub.asymmetricKeyType !== 'ed25519' || !pub.export({ format: 'der', type: 'spki' }).equals(der)) refuse(file + ' is not an Ed25519 public key');
      return pub;
    },
    verify: async (key, sig, data) => crypto.verify(null, data, key, sig),
    text: (b) => Buffer.from(b.buffer, b.byteOffset, b.length).toString('utf8'),
    bytes: (t) => Buffer.from(t, 'utf8'),
    base64: (t) => Buffer.from(t, 'base64'),
  };
  const r = await rules.verifyFolder(io, { fingerprint, list, keep, against });
  if (r.code !== 3) r.provenance = await provenance(root, r.bundled, self, fsp);
  return r;
}

/** Files present under the folder that SHA256SUMS does not list (beside it and its signature): named, never read. */
async function unlisted(root, isListed, fsp) {
  const out = [];
  const walk = async (rel, depth) => {
    const names = await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
    for (const d of names) {
      const p = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (!isListed(p)) out.push(p);
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

/** Line ends as a browser reads them: an HTML parser turns CR LF and a lone CR into LF before a CSP hash is taken. */
const lf = (t) => String(t).replace(/\r\n?/g, '\n');

/**
 * verify.html from page.html, page.css, auditrules.js and page.js (strings) and the version it names: each put inline in
 * its one place, the meta Content-Security-Policy carrying their SHA-256, so the page loads nothing and sends nothing.
 * Every part is read with LF line ends first, so the hashes are of the text the browser checks, whatever the checkout
 * wrote (a Windows one writes CR LF), and one release makes the same page on every platform.
 */
function assemblePage({ html: rawHtml, css: rawCss, rules: rawRules, js: rawJs, version }) {
  const [html, css, rulesText, js] = [rawHtml, rawCss, rawRules, rawJs].map(lf);
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
    if (before.code === 3 || !before.texts || before.kind === 'archive') {
      print('✕ The earlier export does not check: ' + safe(before.code === 3 ? before.why : before.kind === 'archive' ? 'it is an archive\'s folder, not an export' : 'its entries break where its laptop\'s own check said they do (' + before.broken + '), so they cannot be compared'));
      print('Nothing was compared (exit 3).');
      return 3;
    }
    if (!expected) { expected = before.fp; lead.push('The key you expect is taken from the earlier export ' + safe(a.earlier) + ' (' + grouped(before.fp) + '): it must be one you kept off the laptop.'); }
    against = { texts: before.texts, log: before.m.log, made: before.m.made, fp: before.fp };
  }
  const r = await check(a.dir, { fingerprint: expected, list: a.list, against });
  const archive = r.kind === 'archive';
  const what = archive ? 'archive' : 'bundle';
  for (const l of lead) print(l);
  if (against && archive) {
    print('✕ ' + safe(a.dir) + ' is an archive\'s folder: the compare takes two exports. Check the archive alone, or inside an export that holds it.');
    return 3;
  }
  if (against && r.fp && r.fp !== against.fp) print('△ signed by another key than the earlier export: the laptop\'s machine key changed between them, or they come from two laptops');
  for (const l of r.provenance || []) print('△ ' + safe(l));
  if (r.code === 3) {
    for (const l of r.said) print(safe(l));
    print('✕ ' + safe(r.why));
    print('Nothing in this ' + what + ' is vouched for (exit 3).');
    return 3;
  }
  for (const l of r.said) print(safe(l));
  const m = r.m;
  const own = r.code === 4 ? 'The ' + what + '\'s own claim (not compared with a record of the laptop\'s key, so not shown to be the laptop\'s)' : 'The laptop\'s own check';
  print(own + (archive ? ', run when it split this archive off (made ' : ', run for this export through its own entry (made ') + whenUtc(m.made) + ', by ' + safe(m.by.name || m.by.t) + ', AGMessage ' + safe(m.node.version) + '):');
  print('  ' + (MARK[m.check.mark] || '✕') + ' ' + safe(m.check.words));
  for (const f of m.check.findings) {
    if (f && typeof f.words === 'string') print('    ' + (archive ? '◇ ' : (MARK[f.mark] || '✕') + ' ') + safe(f.words) + (archive ? ' (accepted by entry ' + f.accept.seq + ' on ' + dayUtc(f.accept.at) + ')' : ''));
  }
  if (r.entries) {
    const markOf = (seq) => {
      const s = r.spans.find((x) => seq >= x.from && seq <= x.to);
      const id = s ? 's' + s.from + '-' + s.to : '';
      return s ? (r.accepts.has(id) || (archive && m.check.findings.some((f) => f.id === id)) ? '◇' : '△') : ' ';
    };
    for (const e of r.entries) print([e.seq, new Date(e.at).toISOString(), markOf(e.seq), safe(e.actor.name || e.actor.t), safe(e.action), safe(e.target), safe(e.words)].join('  '));
  }
  print('Not checked here: the keyed entries\' own MACs. The laptop\'s key never leaves it; the laptop\'s check above vouches for them.');
  const said = archive ? ' when it split this archive off' : '';
  if (r.code === 4) print((r.broken ? 'Every file signed consistently by key ' + grouped(r.fp) + ', its entries breaking where its own check says they do' : 'Whole and signed consistently by key ' + grouped(r.fp)) + ', but not compared with a record of the laptop\'s key: not shown to be the laptop\'s. Anyone can make such a' + (archive ? 'n archive' : ' bundle') + ' with a key of their own. Give --fingerprint (exit 4).');
  else if (r.broken) print('Signed by the key you expected, and every file is what was exported; the entries break where the laptop\'s own check said they do: the log was broken when it was exported (exit 2).');
  else print({ 0: 'Signed by the key you expected and whole; the laptop said ✓' + said + ' (exit 0).', 1: 'Signed by the key you expected and whole; the laptop said ' + MARK[m.check.mark] + said + ': read its findings (exit 1).', 2: 'Signed by the key you expected and whole; the laptop said ✕: the log was broken when it was exported (exit 2).' }[r.code]);
  return r.code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stdout.write('✕ the verifier failed: ' + safe(e && e.message ? e.message : e) + '\n'); process.exitCode = 3; });
}

module.exports = { check, main, assemblePage, pageFrom, ownFiles, safe, pemDer };
