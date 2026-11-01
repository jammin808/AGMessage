#!/usr/bin/env node
'use strict';
/**
 * Adds the browser libraries vendored in app/public/vendor to the CycloneDX SBOM npm writes, which lists npm's packages
 * only, so the release's bill of materials names every library the bundle ships.
 *
 *   node tools/vendor-sbom.js <sbom.cdx.json> [--tree <folder>]
 *       rewrites that file with the vendored libraries added; exit 0, or 1 with the reason and the file as it was.
 *       --tree names the folder that ships (the portable bundle, extracted): its files are the ones read and hashed.
 *
 * Each vendored file is one component: its package and version, its licence and copyright, the file's own SHA-256, the
 * package it came from (with that package's own digest) and the path inside it. The libraries bundled inside the file are
 * its own components. The application's entry in `dependencies` gains each vendored file. Each advisory VENDOR.json
 * assesses is a vulnerability of the library it names, with its analysis: exploitable where it applies, not affected
 * (its code not reachable) where it does not, and why.
 *
 * Invariants:
 *   - The list is this checkout's app/public/vendor/VENDOR.json. A hash is read from the file that ships and must be the
 *     one the list records: a file whose bytes differ, a file the list does not name, or a listed file that is missing
 *     stops it before anything is written.
 *   - What ships carries the list it was checked against and every notice the list names: the tree's VENDOR.json and
 *     THIRD-PARTY-NOTICES.md are this checkout's, byte for byte, and so is each licence folder an entry names, file by
 *     file; one missing, empty or different stops it.
 *   - Only a CycloneDX document is rewritten, and the vendored components and vulnerabilities are the manifest's alone:
 *     what an earlier run added is replaced, never doubled, so a second run leaves the same file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join('app', 'public', 'vendor');
const MANIFEST = 'VENDOR.json';
const NOTICES = 'THIRD-PARTY-NOTICES.md';
const REF = 'vendor:';
// npm's severities in CycloneDX's words (npm's moderate is its medium).
const SEVERITY = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'info' };

function fail(words) { console.error('vendor-sbom: ' + words); process.exit(1); }

/** CycloneDX's licence choice: one SPDX id, or an expression ("MIT AND Zlib", "MIT OR GPL-3.0-or-later"). */
function licences(spdx) {
  return /\s(AND|OR|WITH)\s/.test(spdx) ? [{ expression: spdx }] : [{ license: { id: spdx } }];
}

/** npm's integrity (sha512-<base64>) as CycloneDX's hash: hex. */
function integrityHash(integrity) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity || ''));
  return m ? [{ alg: 'SHA-512', content: Buffer.from(m[1], 'base64').toString('hex') }] : [];
}

function property(name, value) { return { name: 'agmessage:vendor:' + name, value: String(value) }; }

/** A library bundled inside a vendored file, as a component of that file's. */
function bundled(file, b) {
  const c = { 'bom-ref': REF + file + '/' + b.package + (b.version ? '@' + b.version : ''), type: 'library', name: b.package };
  if (b.version) c.version = b.version;
  c.scope = 'required';
  if (b.purl) c.purl = b.purl;
  c.licenses = licences(b.licence);
  if (b.copyright) c.copyright = b.copyright;
  const props = [];
  if (b.via) props.push(property('via', b.via));
  if (b.versionFrom) props.push(property('versionFrom', b.versionFrom));
  if (b.taken) props.push(property('taken', b.taken));
  if (!b.version && b.unversioned) props.push(property('unversioned', b.unversioned));
  if (props.length) c.properties = props;
  return c;
}

/** One vendored file as a component, its bytes' SHA-256 the one read from disk. */
function component(file, e, sha256) {
  const c = { 'bom-ref': REF + file, type: 'library', name: e.package, version: e.version, scope: 'required' };
  if (e.purl) c.purl = e.purl;
  c.description = 'app/public/vendor/' + file + ' (' + e.build + ' build), ' + e.source.path + ' of ' + e.package + ' ' + e.version;
  c.hashes = [{ alg: 'SHA-256', content: sha256 }];
  c.licenses = licences(e.licence);
  if (e.copyright) c.copyright = e.copyright;
  c.externalReferences = [{ type: 'distribution', url: e.source.url, hashes: integrityHash(e.source.integrity) }];
  c.properties = [property('file', 'app/public/vendor/' + file), property('build', e.build), property('runs', e.runs), property('path', e.source.path)];
  if (e.bundles && e.bundles.length) c.components = e.bundles.map((b) => bundled(file, b));
  return c;
}

/** What VENDOR.json assesses, as CycloneDX vulnerabilities of the components `refOf` names. */
function vulnerabilities(manifest, refOf) {
  const out = [];
  for (const [file, e] of Object.entries(manifest.files)) {
    for (const c of [e, ...(e.bundles || [])]) {
      for (const a of c.advisories || []) {
        const verdict = manifest.assessments && manifest.assessments[a.assessed];
        if (!verdict || typeof verdict.applies !== 'boolean' || typeof verdict.why !== 'string') fail(file + ': ' + c.package + "'s " + a.id + ' names the assessment "' + a.assessed + '", which VENDOR.json does not hold');
        const ref = refOf(file, c === e ? null : c);
        const analysis = verdict.applies
          ? { state: 'exploitable', detail: verdict.why + (verdict.mitigation ? ' ' + verdict.mitigation : '') }
          : { state: 'not_affected', justification: 'code_not_reachable', detail: verdict.why };
        out.push({ 'bom-ref': ref + '#' + a.id, id: a.id, source: { name: 'GitHub Advisory Database', url: 'https://github.com/advisories/' + a.id }, ratings: [{ severity: SEVERITY[a.severity] || 'unknown' }], analysis, affects: [{ ref }] });
      }
    }
  }
  return out;
}

/** The bytes of every file in a folder, by name (a folder that is missing holds none). */
function folderBytes(dir) {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return new Map(); }   // missing: the caller says which
  return new Map(names.map((n) => [n, fs.readFileSync(path.join(dir, n))]));
}

/** What ships beside the files: the list itself, the notices, and each licence folder an entry names, as this checkout has them. */
function checkNotices(manifest, tree) {
  const same = (rel) => {
    let mine, theirs;
    try { mine = fs.readFileSync(path.join(ROOT, rel)); } catch { fail(rel + ' is not in this checkout'); }
    try { theirs = fs.readFileSync(path.join(tree, rel)); } catch { fail(rel + ' is not in ' + tree); }
    if (!mine.length || !mine.equals(theirs)) fail(rel + ' in ' + tree + ' is not this checkout\'s');
  };
  same(path.join(VENDOR_DIR, MANIFEST));
  same(NOTICES);
  const folders = new Set();
  for (const e of Object.values(manifest.files)) for (const c of [e, ...(e.bundles || [])]) folders.add(c.notice);
  for (const notice of [...folders].sort()) {
    if (typeof notice !== 'string' || !/^licenses\/[a-z0-9.-]+$/.test(notice)) fail('an entry names "' + notice + '" as its notice, which is not a folder under licenses/');
    const mine = folderBytes(path.join(ROOT, notice));
    const theirs = folderBytes(path.join(tree, notice));
    if (!mine.size || [...mine.values()].some((b) => !b.length)) fail(notice + ' holds no licence text in this checkout');
    if ([...mine.keys()].join('/') !== [...theirs.keys()].join('/') || [...mine].some(([n, b]) => !b.equals(theirs.get(n)))) fail(notice + ' in ' + tree + ' is not this checkout\'s');
  }
}

/** The manifest, held to the folder that ships: every file listed, each listed file there, each with the bytes it records. */
function readVendored(tree) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, VENDOR_DIR, MANIFEST), 'utf8')); } catch (e) { fail('app/public/vendor/' + MANIFEST + ' could not be read: ' + e.message); }
  const listed = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : fail(MANIFEST + ' has no "files"');
  const VENDOR = path.join(tree, VENDOR_DIR);
  let present;
  try { present = fs.readdirSync(VENDOR).filter((f) => f !== MANIFEST).sort(); } catch (e) { fail(VENDOR + ' could not be read: ' + e.message); }
  for (const f of present) if (!Object.hasOwn(listed, f)) fail('app/public/vendor/' + f + ' is not in ' + MANIFEST + ': nothing ships that is not listed');
  const out = [];
  for (const [file, e] of Object.entries(listed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!present.includes(file)) fail(MANIFEST + ' lists ' + file + ', which is not in app/public/vendor');
    for (const k of ['package', 'version', 'build', 'runs', 'licence', 'sha256']) if (typeof e[k] !== 'string' || !e[k]) fail(file + ': its entry has no ' + k);
    if (!e.source || typeof e.source.url !== 'string' || typeof e.source.path !== 'string') fail(file + ': its entry has no source');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, file))).digest('hex');
    if (sha256 !== e.sha256) fail('app/public/vendor/' + file + ' is not the file ' + MANIFEST + ' records (SHA-256 ' + sha256 + ', listed ' + e.sha256 + ')');
    out.push(component(file, e, sha256));
  }
  checkNotices(manifest, tree);
  const refOf = (file, b) => (b ? out.find((c) => c['bom-ref'] === REF + file).components.find((x) => x.name === b.package && (x.version || null) === b.version)['bom-ref'] : REF + file);
  return { components: out, vulnerabilities: vulnerabilities(manifest, refOf) };
}

const args = process.argv.slice(2);
const at = args.indexOf('--tree');
const tree = at === -1 ? ROOT : args[at + 1];
if (at !== -1) args.splice(at, 2);
if (!tree) fail('--tree names the folder that ships: node tools/vendor-sbom.js <sbom.cdx.json> --tree <folder>');
const target = args[0];
if (!target || args.length !== 1) fail('name the SBOM to add to: node tools/vendor-sbom.js <sbom.cdx.json> [--tree <folder>]');
let bom;
try {
  const text = fs.readFileSync(target, 'utf8');
  bom = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);   // PowerShell's Out-File may begin it with a BOM
} catch (e) { fail(target + ' could not be read as JSON: ' + e.message); }
if (!bom || bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) fail(target + ' is not a CycloneDX SBOM with a components list');

const { components: vendored, vulnerabilities: vulns } = readVendored(path.resolve(tree));
const ours = (ref) => typeof ref === 'string' && ref.startsWith(REF);
bom.components = bom.components.filter((c) => !ours(c['bom-ref'])).concat(vendored);
const theirs = Array.isArray(bom.vulnerabilities) ? bom.vulnerabilities.filter((v) => !ours(v['bom-ref'])) : [];
if (theirs.length || vulns.length) bom.vulnerabilities = theirs.concat(vulns);
else delete bom.vulnerabilities;
if (!Array.isArray(bom.dependencies)) bom.dependencies = [];
bom.dependencies = bom.dependencies.filter((d) => !ours(d.ref));
const app = bom.metadata && bom.metadata.component && bom.metadata.component['bom-ref'];
if (app) {
  let entry = bom.dependencies.find((d) => d.ref === app);
  if (!entry) { entry = { ref: app, dependsOn: [] }; bom.dependencies.unshift(entry); }
  entry.dependsOn = (entry.dependsOn || []).filter((r) => !ours(r)).concat(vendored.map((c) => c['bom-ref']));
}
fs.writeFileSync(target, JSON.stringify(bom, null, 2) + '\n');
console.log('vendor-sbom: ' + vendored.length + ' vendored files added to ' + path.basename(target) + ', with ' + new Set(vendored.flatMap((c) => (c.components || []).map((b) => b.name + '@' + (b.version || '')))).size + ' libraries bundled in them and ' + vulns.length + ' advisories assessed');
