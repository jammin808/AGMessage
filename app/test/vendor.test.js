'use strict';
// The browser libraries vendored in app/public/vendor: every file is listed in VENDOR.json with its own SHA-256, build,
// licence and notice, and nothing listed is missing; each licence's text and copyright ship in licenses/ and
// THIRD-PARTY-NOTICES.md, which the portable build carries; nothing ships that no page loads; pdf.js is 4.10.38's legacy
// build, which runs where Promise.withResolvers is missing, and names its floor, which every paper that names it quotes
// whole; mammoth is 1.13.0's file; pdf.js 3.11.174's worker is gone; a bundled library's version that its file does not
// name is the one its code shows; every advisory against a listed version is assessed, and the audit fails on a high or
// critical one that is not (tools/vendor-audit.js); and the release's SBOM gains every vendored file, read from the
// folder that ships, with its notices and its advisories' analysis (tools/vendor-sbom.js).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const audit = require('../../tools/vendor-audit.js');
const { readSource } = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'app', 'public', 'vendor');
const manifest = JSON.parse(readSource(path.join(VENDOR, 'VENDOR.json')));
const entries = Object.entries(manifest.files);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (rel) => readSource(path.join(ROOT, rel));

// The published files, by the SHA-256 of their bytes in each package (read from the registry's tarballs, whose
// integrity npm checks): what the folder must hold, and what it must no longer hold.
const PUBLISHED = {
  'mammoth 1.13.0 mammoth.browser.min.js': '92914a3708cfdf1e62cb553d1856a7fedab21da83d8ee82845de2f897b368cab',
  'mammoth 1.11.0 mammoth.browser.min.js': '62773d3b21c7130342148e78abf7b97dbd3103463d3ffc5a68601a2a007e1cf1',
  'pdfjs-dist 4.10.38 legacy/build/pdf.min.mjs': '44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72',
  'pdfjs-dist 4.10.38 legacy/build/pdf.worker.min.mjs': 'bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d',
  'pdfjs-dist 4.10.38 build/pdf.min.mjs': '27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c',
  'pdfjs-dist 4.10.38 build/pdf.worker.min.mjs': '1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36',
  'pdfjs-dist 3.11.174 build/pdf.worker.min.js': 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
};

// The licences a vendored library may carry, and the words that say a licence text is that licence's (`has`) and not
// another's (`not`: a BSD-3-Clause text holds every BSD-2-Clause clause and one more). An expression with OR names the
// one AGMessage takes (`taken`); one with AND needs every part's text.
const BSD_BINARY = /Redistributions in binary form must reproduce the above copyright notice/;
const BSD_ENDORSE = /Neither the name of/;
const LICENCES = {
  'Apache-2.0': { has: [/Apache License,? Version 2\.0/] },
  MIT: { has: [/Permission is hereby granted, free of charge, to any person obtaining a copy/] },
  'BSD-2-Clause': { has: [BSD_BINARY], not: [BSD_ENDORSE] },
  'BSD-3-Clause': { has: [BSD_BINARY, BSD_ENDORSE] },
  Zlib: { has: [/This notice may not be removed or altered from any source distribution/] },
};
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
const ALLOWED = ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'MIT AND Zlib', 'MIT OR GPL-3.0-or-later'];
const flat = (s) => s.replace(/^[ \t]*(?:\*|#)[ \t]?/gm, '').replace(/[*`]/g, '').replace(/\s+/g, ' ');
const noticeText = (notice) => fs.readdirSync(path.join(ROOT, notice)).map((f) => readSource(path.join(ROOT, notice, f))).join('\n');
const everyComponent = () => entries.flatMap(([file, e]) => [{ file, c: e, bundled: false }, ...e.bundles.map((b) => ({ file, c: b, bundled: true }))]);

test('vendor: every file in the folder is in VENDOR.json with its own SHA-256, build, licence and notice, and every file listed is there', () => {
  const present = fs.readdirSync(VENDOR).filter((f) => f !== 'VENDOR.json').sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), present, 'the folder and the list name the same files');
  for (const [file, e] of entries) {
    assert.equal(sha256(fs.readFileSync(path.join(VENDOR, file))), e.sha256, file + ': its bytes are the ones listed');
    for (const k of ['package', 'version', 'build', 'licence', 'copyright', 'notice']) assert.ok(typeof e[k] === 'string' && e[k].trim(), file + ' has its ' + k);
    assert.ok(['page', 'worker'].includes(e.runs), file + ' says where it runs');
    assert.match(e.source.url, /^https:\/\/(registry\.npmjs\.org|cdn\.sheetjs\.com)\//, file + ': its package came from its publisher');
    assert.match(e.source.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, file + ': its package\'s digest');
    assert.match(e.source.path, /^package\//, file + ': where in its package it was taken from');
    assert.ok(Array.isArray(e.bundles), file + ' lists what it bundles, if anything');
  }
  for (const { file, c, bundled } of everyComponent()) {
    const who = file + (bundled ? ' bundles ' + c.package : '');
    assert.ok(typeof c.package === 'string' && c.package, who + ': a package');
    assert.ok((typeof c.version === 'string' && c.version) || (c.version === null && typeof c.unversioned === 'string' && c.unversioned.trim()), who + ': a version, or why it has none');
    assert.ok(ALLOWED.includes(c.licence), who + ': ' + c.licence + ' is a licence a vendored library may carry');
    if (/ OR /.test(c.licence)) assert.ok(c.licence.split(' OR ').includes(c.taken) && ALLOWED.includes(c.taken), who + ': names the licence it is taken under');
    assert.match(c.notice, /^licenses\/[a-z0-9.-]+$/, who + ': its notice is a folder under licenses/');
    assert.ok(typeof c.copyright === 'string' && c.copyright.trim(), who + ': the copyright its licence asks to keep');
    if (c.purl !== undefined) assert.equal(c.purl, 'pkg:npm/' + c.package.replace(/^@/, '%40') + '@' + c.version, who + ': its package URL is its npm package');
    if (c.via) assert.ok(typeof c.versionFrom === 'string' && c.versionFrom.trim(), who + ': comes inside ' + c.via + '\'s own bundle, which names no version, so it says where its version was read');
    if (c.advisories !== undefined) {
      assert.ok(Array.isArray(c.advisories) && c.advisories.length, who + ': its advisories are a list');
      for (const a of c.advisories) {
        assert.match(a.id, /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/, who + ': an advisory by its GHSA id');
        assert.ok(SEVERITIES.includes(a.severity), who + ' ' + a.id + ': its severity, as the registry gives it');
        assert.ok(Object.hasOwn(manifest.assessments, a.assessed), who + ' ' + a.id + ': its assessment is in VENDOR.json');
      }
      assert.equal(new Set(c.advisories.map((a) => a.id)).size, c.advisories.length, who + ': each advisory once');
    }
  }
  const used = new Set(everyComponent().flatMap(({ c }) => (c.advisories || []).map((a) => a.assessed)));
  for (const [key, v] of Object.entries(manifest.assessments)) {
    assert.ok(used.has(key), key + ': an assessment some advisory names');
    assert.equal(typeof v.applies, 'boolean', key + ': says whether it applies here');
    assert.ok(typeof v.why === 'string' && v.why.length > 40, key + ': says why');
    if (v.applies) assert.ok(typeof v.mitigation === 'string' && v.mitigation.trim(), key + ': applies, so it says what bounds it');
  }
  for (const [file, e] of entries) {
    if (e.source.url.startsWith('https://registry.npmjs.org/')) assert.ok(e.purl, file + ': an npm package has its package URL');
    else assert.equal(e.purl, undefined, file + ' came from its own publisher, not npm: no npm package URL');
  }
});

test('vendor: each licence folder holds the licence its entry names and the copyright it asks to keep, and none is unclaimed', () => {
  const claimed = new Set();
  for (const { file, c, bundled } of everyComponent()) {
    const who = file + (bundled ? ' bundles ' + c.package : '');
    claimed.add(c.notice);
    const files = fs.readdirSync(path.join(ROOT, c.notice));
    assert.ok(files.length && files.every((f) => fs.statSync(path.join(ROOT, c.notice, f)).size > 0), who + ': ' + c.notice + ' holds its licence');
    const text = flat(noticeText(c.notice));
    const parts = / OR /.test(c.licence) ? [c.taken] : c.licence.split(' AND ');
    for (const id of parts) {
      for (const re of LICENCES[id].has) assert.match(text, re, who + ': ' + c.notice + ' holds the text of ' + id);
      for (const re of LICENCES[id].not || []) assert.doesNotMatch(text, re, who + ': ' + c.notice + ' holds ' + id + ', not a licence with more clauses');
    }
    // An Apache-2.0 work keeps its copyright where it was put: in the file itself, which ships unchanged.
    const own = c.licence === 'Apache-2.0' && !bundled ? flat(readSource(path.join(VENDOR, file)).slice(0, 4096)) : '';
    assert.ok(text.includes(flat(c.copyright)) || own.includes(flat(c.copyright)), who + ': "' + c.copyright + '" is kept');
  }
  const folders = fs.readdirSync(path.join(ROOT, 'licenses')).map((f) => 'licenses/' + f);
  assert.deepEqual(folders.filter((f) => !claimed.has(f)), [], 'every licence folder is some vendored library\'s');
});

test('vendor: THIRD-PARTY-NOTICES.md lists each file with its packages, versions, licences, copyrights and licence folders, as VENDOR.json does', () => {
  const text = read('THIRD-PARTY-NOTICES.md');
  const sections = new Map();
  let at = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^### `([^`]+)`/.exec(line);
    if (h) { at = h[1]; sections.set(at, []); continue; }
    if (/^#{1,2} /.test(line)) { at = null; continue; }
    if (at && /^\| (?!Package \||---)/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((x) => x.trim());
      sections.get(at).push({ package: cells[0].split(' (bundled')[0], version: cells[1] === '—' ? null : cells[1], licence: cells[2], copyright: cells[3], notice: cells[4].replace(/^`|\/`$/g, '') });
    }
  }
  assert.deepEqual([...sections.keys()].sort(), Object.keys(manifest.files).sort(), 'a section for every vendored file, and only for them');
  for (const [file, e] of entries) {
    const want = [e, ...e.bundles].map((c) => ({ package: c.package, version: c.version, licence: c.licence, copyright: c.copyright, notice: c.notice }));
    assert.deepEqual(sections.get(file), want, file + ': its table is its entry');
    for (const b of e.bundles) if (b.via) assert.ok(text.includes('| ' + b.package + ' (bundled in ' + b.via + ') |'), file + ': ' + b.package + ' is said to come inside ' + b.via);
  }
  for (const [file, e] of entries.filter(([, x]) => x.floor)) {
    const floor = 'Chrome ' + e.floor.chrome + ', Firefox ' + e.floor.firefox + ' and Safari ' + e.floor.safari;
    assert.ok(text.includes(floor) && text.includes(e.floor.from), file + ': the notices quote its floor, and where it was read');
  }
  for (const { file, c } of everyComponent()) {
    for (const a of c.advisories || []) assert.ok(text.includes(a.id), file + ': the notices name ' + c.package + '\'s advisory ' + a.id);
  }
  assert.match(read('SECURITY.md'), /tools\/vendor-audit\.js/, 'SECURITY.md says how the vendored libraries\' advisories are audited');
});

test('vendor: every paper that says which browsers draw a PDF quotes the legacy build\'s floor', () => {
  const { floor } = manifest.files['pdf.min.mjs'];
  // The device matrix, docs/DEVICES.md, quotes it too once it is written.
  const papers = ['THIRD-PARTY-NOTICES.md', 'README.txt', 'docs/DISPLAYS.md', ...(fs.existsSync(path.join(ROOT, 'docs', 'DEVICES.md')) ? ['docs/DEVICES.md'] : [])];
  for (const paper of papers) {
    const text = read(paper).replace(/\s+/g, ' ');
    assert.ok(text.includes('Safari ' + floor.safari) && text.includes('Chrome ' + floor.chrome), paper + ': quotes Safari ' + floor.safari + ' and Chrome ' + floor.chrome);
  }
  assert.ok(read('README.md').includes('iPadOS ' + floor.safari), 'README.md: PDFs on iPads from iPadOS ' + floor.safari);
});

test('vendor: nothing ships that no page loads, and every page loads only what is listed', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'app', 'public')).filter((f) => /\.(js|mjs|html)$/.test(f));
  const loaded = new Set();
  for (const f of pages) for (const m of read('app/public/' + f).matchAll(/\/vendor\/([A-Za-z0-9._-]+)/g)) loaded.add(m[1]);
  assert.deepEqual([...loaded].filter((f) => !Object.hasOwn(manifest.files, f)), [], 'a page loads only a listed file');
  assert.deepEqual(Object.keys(manifest.files).filter((f) => !loaded.has(f)).sort(), [], 'every listed file is loaded by a page (a file nothing loads is not shipped)');
  for (const [file, e] of entries) {
    const by = pages.filter((f) => read('app/public/' + f).includes('/vendor/' + file));
    if (e.runs === 'worker') assert.ok(by.length && by.every((f) => read('app/public/' + f).includes("workerSrc = '/vendor/" + file + "'")), file + ' is loaded as pdf.js\'s worker, and only so');
  }
});

test('vendor: the stale and fragile go — no pdf.js 3.11.174 worker, mammoth 1.13.0, pdf.js 4.10.38\'s legacy build with its floor', () => {
  const hashes = fs.readdirSync(VENDOR).filter((f) => f !== 'VENDOR.json').map((f) => sha256(fs.readFileSync(path.join(VENDOR, f))));
  assert.ok(!fs.existsSync(path.join(VENDOR, 'pdf.worker.min.js')), 'pdf.js 3.11.174\'s worker is gone');
  for (const gone of ['mammoth 1.11.0 mammoth.browser.min.js', 'pdfjs-dist 4.10.38 build/pdf.min.mjs', 'pdfjs-dist 4.10.38 build/pdf.worker.min.mjs', 'pdfjs-dist 3.11.174 build/pdf.worker.min.js']) {
    assert.ok(!hashes.includes(PUBLISHED[gone]), gone + ' is no longer shipped');
  }
  const mammoth = manifest.files['mammoth.browser.min.js'];
  assert.equal(mammoth.version, '1.13.0');
  // jszip's own bundle names no versions. pako's utils.assign tested hasOwnProperty on the object itself up to 1.0.5;
  // 1.0.6 and later call a helper (_has), which no minifier turns back into a method call on the source.
  const pako = mammoth.bundles.find((b) => b.package === 'pako');
  const mammothText = fs.readFileSync(path.join(VENDOR, 'mammoth.browser.min.js'), 'latin1');
  assert.equal(pako.version, '1.0.5');
  assert.match(mammothText, /must be non-object"\);for\(var (\w+) in (\w+)\)\2\.hasOwnProperty\(\1\)&&/, 'the pako in mammoth\'s jszip is 1.0.5: its assign is that release\'s');
  assert.equal(mammoth.sha256, PUBLISHED['mammoth 1.13.0 mammoth.browser.min.js'], 'mammoth\'s file is 1.13.0\'s');
  for (const [file, published] of [['pdf.min.mjs', 'pdfjs-dist 4.10.38 legacy/build/pdf.min.mjs'], ['pdf.worker.min.mjs', 'pdfjs-dist 4.10.38 legacy/build/pdf.worker.min.mjs']]) {
    const e = manifest.files[file];
    assert.deepEqual([e.package, e.version, e.build, e.source.path], ['pdfjs-dist', '4.10.38', 'legacy', 'package/legacy/build/' + file]);
    assert.equal(e.sha256, PUBLISHED[published], file + ' is the legacy build\'s file');
    assert.deepEqual(e.floor, { chrome: '103', firefox: 'ESR', safari: '16.4', from: 'https://github.com/mozilla/pdf.js/blob/v4.10.38/gulpfile.mjs#L81-L90' }, file + ': the floor its build was compiled for');
  }
});

test('vendor: pdf.js defines Promise.withResolvers where the runtime has none, and reads a PDF there', () => {
  // As on Safari and iPadOS before 17.4: the global is taken away before pdf.js's main module loads and again before its
  // worker does, so each must define it itself; then a one-page PDF is opened through that worker. The modern build
  // calls it unguarded, and opens nothing there.
  const probe = `
    const { pathToFileURL } = require('node:url');
    (async () => {
      const [main, worker] = process.argv.slice(1);
      delete Promise.withResolvers;
      const pdfjs = await import(pathToFileURL(main).href);
      const afterMain = typeof Promise.withResolvers;
      delete Promise.withResolvers;
      await import(pathToFileURL(worker).href);
      const afterWorker = typeof Promise.withResolvers;
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
      const stream = 'BT /F1 18 Tf 20 60 Td (Older iPads) Tj ET';
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length ' + stream.length + ' >>\\nstream\\n' + stream + '\\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      let pdf = '%PDF-1.4\\n'; const at = [];
      objs.forEach((o, i) => { at.push(pdf.length); pdf += (i + 1) + ' 0 obj\\n' + o + '\\nendobj\\n'; });
      const xref = pdf.length;
      pdf += 'xref\\n0 ' + (objs.length + 1) + '\\n0000000000 65535 f \\n' + at.map((o) => String(o).padStart(10, '0') + ' 00000 n \\n').join('');
      pdf += 'trailer\\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF\\n';
      let read = null;
      try {
        const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(pdf, 'latin1')), isEvalSupported: false, verbosity: 0 }).promise;
        read = { pages: doc.numPages, text: (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(' ') };
        await doc.destroy();
      } catch (e) { read = { error: String(e && e.message) }; }
      process.stdout.write('\\nVENDOR-PROBE ' + JSON.stringify({ version: pdfjs.version, afterMain, afterWorker, read }) + '\\n');
    })();`;
  const r = spawnSync(process.execPath, ['-e', probe, path.join(VENDOR, 'pdf.min.mjs'), path.join(VENDOR, 'pdf.worker.min.mjs')], { encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('VENDOR-PROBE '));
  assert.ok(line, 'the probe ran: ' + r.stderr);
  const seen = JSON.parse(line.slice('VENDOR-PROBE '.length));
  assert.deepEqual(seen, { version: '4.10.38', afterMain: 'function', afterWorker: 'function', read: { pages: 1, text: 'Older iPads' } });
});

test('vendor: the portable folder carries the notices, and CI adds the vendored files to the SBOM before SHA256SUMS', () => {
  const build = read('tools/build-portable.ps1');
  assert.match(build, /^Copy-Item app\\public "\$stage\\app\\public" -Recurse\r?$/m, 'VENDOR.json goes with the vendored files');
  assert.match(build, /^Copy-Item THIRD-PARTY-NOTICES\.md \$stage\r?$/m, 'the notices at the folder\'s top');
  assert.match(build, /^Copy-Item licenses "\$stage\\licenses" -Recurse\r?$/m, 'the licence texts beside them');
  const ci = read('.github/workflows/ci.yml');
  const npmSbom = ci.indexOf('npm sbom --sbom-format cyclonedx');
  const ours = ci.indexOf('node tools/vendor-sbom.js dist/agmessage-sbom.cdx.json --tree $shipped');
  const sums = ci.indexOf('Set-Content -Path dist/SHA256SUMS');
  const start = ci.indexOf('- name: Start the bundle');
  assert.ok(start > 0 && npmSbom > start && ours > npmSbom && sums > ours, 'the bundle extracted, then npm\'s SBOM, then the vendored files read from it, then the sums over both');
  assert.match(ci.slice(npmSbom, ours), /\$shipped = Join-Path \$env:RUNNER_TEMP 'bundle-start\\AGMessage'\n/, 'the folder read is the bundle the zip extracts to: its one folder, AGMessage');
  assert.match(ci.slice(ours, sums), /if \(\$LASTEXITCODE -ne 0\) \{ throw /, 'a refusal stops the job');
});

test('vendor-audit: the registry is asked about every library at its listed version, each version on its own', () => {
  assert.equal(audit.ENDPOINT, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', 'the endpoint npm audit asks');
  const asked = audit.rounds(manifest);
  const versioned = [...new Set(everyComponent().filter(({ c }) => c.version).map(({ c }) => c.package + '@' + c.version))].sort();
  assert.deepEqual(asked.flatMap((b) => Object.entries(b).map(([n, [v]]) => n + '@' + v)).sort(), versioned, 'each library with a version, once');
  assert.ok(asked.every((b) => Object.values(b).every((v) => v.length === 1)), 'one version a package a round');
  assert.ok(!asked.some((b) => Object.hasOwn(b, 'OpenJPEG')), 'a library with no version recorded is not asked about');
  const two = { files: { 'a.js': { package: 'x', version: '1.0.0', bundles: [{ package: 'y', version: '2.0.0' }] }, 'b.js': { package: 'x', version: '1.1.0', bundles: [{ package: 'y', version: '2.0.0' }] } } };
  assert.deepEqual(audit.rounds(two), [{ x: ['1.0.0'], y: ['2.0.0'] }, { x: ['1.1.0'] }], 'a package at two versions is asked about in two rounds');
  const paths = everyComponent().flatMap(({ c }) => (c.advisories || []).map((a) => c.package + ' ' + a.id));
  assert.equal(paths.length, 17, 'the advisories against the listed versions, as the registry gave them on 2026-11-01');
  const pkg = JSON.parse(read('app/package.json'));
  assert.match(pkg.scripts.audit, /&& node \.\.\/tools\/vendor-audit\.js$/, 'npm run audit asks about the vendored libraries too');
  const sec = read('.github/workflows/security.yml');
  assert.match(sec, /run: node \.\.\/tools\/vendor-audit\.js/, 'the Security workflow\'s audit job does');
});

test('vendor-audit: a high or critical advisory not assessed, assessed at another severity, or with no assessment fails; no answer fails; a moderate one is named', () => {
  // The registry's answer of 2026-11-01 for the listed versions: every one is assessed.
  const today = {
    '@xmldom/xmldom': ['GHSA-6gmq-8vp8-gcm6 moderate', 'GHSA-wh4c-j3r5-mjhp high', 'GHSA-2v35-w6hq-6mfw high', 'GHSA-f6ww-3ggp-fr8h high', 'GHSA-x6wf-f3px-wcqx high',
      'GHSA-j759-j44w-7fr8 high', 'GHSA-w2rr-34g9-rvrj high', 'GHSA-4w3w-2rp5-g8jm high', 'GHSA-c7q8-3ch8-vqpv high', 'GHSA-27p8-2357-5qqv high', 'GHSA-6h8r-xr42-gp59 moderate',
      'GHSA-8344-3jmq-59r6 high', 'GHSA-x4fp-j954-r2f4 high', 'GHSA-965w-775f-mr7g high', 'GHSA-93r5-fhx6-vmg9 high'],
    jszip: ['GHSA-36fh-84j7-cv5h moderate'],
    underscore: ['GHSA-qpx9-hpmf-5gmw high'],
  };
  const answer = (map) => Object.fromEntries(Object.entries(map).map(([n, list]) => [n, list.map((x) => ({ url: 'https://github.com/advisories/' + x.split(' ')[0], severity: x.split(' ')[1], title: 't' }))]));
  const asked = audit.rounds(manifest);
  let r = audit.assess(manifest, asked, [answer(today)]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.notes.filter((n) => / — assessed: /.test(n)).length, 17);
  assert.ok(r.notes.some((n) => /^pdf\.worker\.min\.mjs bundles OpenJPEG: not asked about, since no version is recorded/.test(n)), 'the library not asked about is named');
  r = audit.assess(manifest, asked, [answer({ ...today, 'core-js': ['GHSA-2222-3333-4444 critical', 'GHSA-5555-6666-7777 moderate'] })]);
  assert.deepEqual(r.failures.map((f) => f.replace(/ \(critical.*$/, '')), ['pdf.min.mjs bundles core-js: core-js 3.39.0: GHSA-2222-3333-4444', 'pdf.worker.min.mjs bundles core-js: core-js 3.39.0: GHSA-2222-3333-4444'], 'a critical one not assessed fails, in each file that bundles it');
  assert.equal(r.notes.filter((n) => /GHSA-5555-6666-7777 \(moderate, t\) — not assessed in VENDOR\.json$/.test(n)).length, 2, 'a moderate one not assessed is named, and does not fail');
  r = audit.assess(manifest, asked, [answer({ ...today, jszip: ['GHSA-36fh-84j7-cv5h high'] })]);
  assert.deepEqual(r.failures, ['mammoth.browser.min.js bundles jszip: jszip 3.7.1: GHSA-36fh-84j7-cv5h (high, t) — assessed at moderate; assess it again'], 'a severity raised since it was assessed fails');
  r = audit.assess(manifest, asked, [{ ...answer(today), 'pdfjs-dist': [{ severity: 'high', title: 'no id', url: 'https://example.invalid/1' }] }]);
  assert.equal(r.failures.length, 2, 'an advisory with no GHSA id cannot be assessed: it fails, for each file of that package');
  const noKey = JSON.parse(JSON.stringify(manifest));
  delete noKey.assessments['underscore-recursion'];
  r = audit.assess(noKey, asked, [answer(today)]);
  assert.deepEqual(r.failures, ['mammoth.browser.min.js bundles underscore: underscore 1.13.1: GHSA-qpx9-hpmf-5gmw (high, t) — its assessment "underscore-recursion" is not in VENDOR.json']);
  assert.deepEqual(audit.assess(manifest, asked, [null]).failures, ['the registry gave no answer to round 1'], 'no answer fails closed');
  assert.deepEqual(audit.assess(manifest, asked, [{ underscore: 'busy' }]).failures, ['underscore: the registry\'s answer is not a list of advisories']);
  assert.deepEqual(audit.assess(manifest, asked, [{ ...answer(today), 'left-pad': [{ severity: 'critical', url: 'https://github.com/advisories/GHSA-2222-3333-4444' }] }]).failures, [], 'a package not asked about is not ours');
});

/**
 * A throwaway checkout with tools/vendor-sbom.js, a vendor folder of `files`, its manifest, the notices and their licence
 * folders; `run(sbomFile, ...args)`, and `ship()`, a copy of what would ship (the bundle, extracted) to name with --tree.
 */
function sbomTree(files, edit = (m) => m) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-vendor-'));
  fs.mkdirSync(path.join(tree, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'vendor-sbom.js'), path.join(tree, 'tools', 'vendor-sbom.js'));
  const vendor = path.join(tree, 'app', 'public', 'vendor');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(tree, 'THIRD-PARTY-NOTICES.md'), '# Third-party notices\n');
  for (const [folder, text] of [['x', 'MIT'], ['pako', 'MIT and zlib'], ['openjpeg', 'BSD-2-Clause']]) {
    fs.mkdirSync(path.join(tree, 'licenses', folder), { recursive: true });
    fs.writeFileSync(path.join(tree, 'licenses', folder, 'LICENSE'), text + '\n');
  }
  const listed = {};
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(vendor, name), bytes);
    listed[name] = {
      package: 'lib-' + name.split('.')[0], version: '2.0.0', purl: 'pkg:npm/lib-' + name.split('.')[0] + '@2.0.0', build: 'legacy', runs: 'page',
      licence: 'MIT', copyright: 'Copyright (c) 2026 Someone', notice: 'licenses/x',
      source: { url: 'https://registry.npmjs.org/x/-/x-2.0.0.tgz', integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'), path: 'package/' + name },
      sha256: sha256(Buffer.from(bytes)),
      bundles: [{ package: 'pako', version: '1.0.5', purl: 'pkg:npm/pako@1.0.5', via: 'jszip', versionFrom: 'its lockfile', licence: 'MIT AND Zlib', copyright: 'c', notice: 'licenses/pako',
        advisories: [{ id: 'GHSA-2222-3333-4444', severity: 'high', assessed: 'parse' }, { id: 'GHSA-5555-6666-7777', severity: 'moderate', assessed: 'unreached' }] },
      { package: 'OpenJPEG', version: null, unversioned: 'none recorded', licence: 'BSD-2-Clause', copyright: 'c', notice: 'licenses/openjpeg' }],
    };
  }
  const assessments = { parse: { applies: true, why: 'It parses what a person sends.', mitigation: 'A deadline ends it.' }, unreached: { applies: false, why: 'Nothing calls it.' } };
  fs.writeFileSync(path.join(vendor, 'VENDOR.json'), JSON.stringify(edit({ files: listed, assessments })));
  const run = (sbom, ...args) => spawnSync(process.execPath, [path.join(tree, 'tools', 'vendor-sbom.js'), ...(sbom ? [sbom] : []), ...args], { encoding: 'utf8' });
  const ship = () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-vendor-ship-'));
    for (const part of [path.join('app', 'public'), 'licenses', 'THIRD-PARTY-NOTICES.md']) fs.cpSync(path.join(tree, part), path.join(out, part), { recursive: true });
    return out;
  };
  return { tree, vendor, run, ship };
}
const npmSbom = () => ({
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { 'bom-ref': 'agmessage@0.6.0', name: 'app' } },
  components: [{ 'bom-ref': 'express@5.3.0', type: 'library', name: 'express', version: '5.3.0' }],
  dependencies: [{ ref: 'agmessage@0.6.0', dependsOn: ['express@5.3.0'] }, { ref: 'express@5.3.0', dependsOn: [] }],
});

test('vendor-sbom: each vendored file joins the SBOM with its own hash, licence, source, bundled libraries and their advisories\' analysis, once', () => {
  const { tree, run } = sbomTree({ 'a.min.js': 'export const a = 1;\n', 'b.min.mjs': 'export const b = 2;\n' });
  const file = path.join(tree, 'sbom.cdx.json');
  fs.writeFileSync(file, '﻿' + JSON.stringify(npmSbom()));   // as PowerShell's Out-File may write it
  let r = run(file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 vendored files added to sbom\.cdx\.json, with 2 libraries bundled in them and 4 advisories assessed/);
  const bom = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(bom.components.map((c) => c['bom-ref']), ['express@5.3.0', 'vendor:a.min.js', 'vendor:b.min.mjs'], 'npm\'s components kept, the vendored ones after');
  const a = bom.components[1];
  assert.deepEqual([a.name, a.version, a.purl, a.scope], ['lib-a', '2.0.0', 'pkg:npm/lib-a@2.0.0', 'required']);
  assert.deepEqual(a.hashes, [{ alg: 'SHA-256', content: sha256(Buffer.from('export const a = 1;\n')) }], 'the file\'s own SHA-256');
  assert.deepEqual(a.licenses, [{ license: { id: 'MIT' } }]);
  assert.equal(a.copyright, 'Copyright (c) 2026 Someone');
  assert.deepEqual(a.externalReferences, [{ type: 'distribution', url: 'https://registry.npmjs.org/x/-/x-2.0.0.tgz', hashes: [{ alg: 'SHA-512', content: crypto.createHash('sha512').update('export const a = 1;\n').digest('hex') }] }]);
  assert.deepEqual(a.properties, [{ name: 'agmessage:vendor:file', value: 'app/public/vendor/a.min.js' }, { name: 'agmessage:vendor:build', value: 'legacy' },
    { name: 'agmessage:vendor:runs', value: 'page' }, { name: 'agmessage:vendor:path', value: 'package/a.min.js' }]);
  assert.deepEqual(a.components, [
    { 'bom-ref': 'vendor:a.min.js/pako@1.0.5', type: 'library', name: 'pako', version: '1.0.5', scope: 'required', purl: 'pkg:npm/pako@1.0.5', licenses: [{ expression: 'MIT AND Zlib' }], copyright: 'c',
      properties: [{ name: 'agmessage:vendor:via', value: 'jszip' }, { name: 'agmessage:vendor:versionFrom', value: 'its lockfile' }] },
    { 'bom-ref': 'vendor:a.min.js/OpenJPEG', type: 'library', name: 'OpenJPEG', scope: 'required', licenses: [{ license: { id: 'BSD-2-Clause' } }], copyright: 'c', properties: [{ name: 'agmessage:vendor:unversioned', value: 'none recorded' }] },
  ], 'the libraries bundled inside it, as its own components; one with no version says why');
  assert.deepEqual(bom.vulnerabilities.slice(0, 2), [
    { 'bom-ref': 'vendor:a.min.js/pako@1.0.5#GHSA-2222-3333-4444', id: 'GHSA-2222-3333-4444', source: { name: 'GitHub Advisory Database', url: 'https://github.com/advisories/GHSA-2222-3333-4444' },
      ratings: [{ severity: 'high' }], analysis: { state: 'exploitable', detail: 'It parses what a person sends. A deadline ends it.' }, affects: [{ ref: 'vendor:a.min.js/pako@1.0.5' }] },
    { 'bom-ref': 'vendor:a.min.js/pako@1.0.5#GHSA-5555-6666-7777', id: 'GHSA-5555-6666-7777', source: { name: 'GitHub Advisory Database', url: 'https://github.com/advisories/GHSA-5555-6666-7777' },
      ratings: [{ severity: 'medium' }], analysis: { state: 'not_affected', justification: 'code_not_reachable', detail: 'Nothing calls it.' }, affects: [{ ref: 'vendor:a.min.js/pako@1.0.5' }] },
  ], 'each advisory assessed is a vulnerability of the library in that file, with its analysis (npm\'s moderate is CycloneDX\'s medium)');
  assert.deepEqual(bom.vulnerabilities.map((v) => v.affects[0].ref), ['vendor:a.min.js/pako@1.0.5', 'vendor:a.min.js/pako@1.0.5', 'vendor:b.min.mjs/pako@1.0.5', 'vendor:b.min.mjs/pako@1.0.5']);
  assert.deepEqual(bom.dependencies[0], { ref: 'agmessage@0.6.0', dependsOn: ['express@5.3.0', 'vendor:a.min.js', 'vendor:b.min.mjs'] }, 'the application depends on each vendored file');
  const once = fs.readFileSync(file, 'utf8');
  r = run(file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), once, 'a second run leaves the same SBOM: nothing doubled');
});

test('vendor-sbom: --tree reads the folder that ships, which must carry the files, the list and every notice as listed', () => {
  const t = sbomTree({ 'a.min.js': 'export const a = 1;\n' });
  const sbomIn = () => { const f = path.join(t.tree, 'sbom.cdx.json'); fs.writeFileSync(f, JSON.stringify(npmSbom())); return f; };
  let file = sbomIn();
  let r = t.run(file, '--tree', t.ship());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).components[1].hashes[0].content, sha256(Buffer.from('export const a = 1;\n')), 'hashed from what ships');
  const cases = [
    ['a shipped file whose bytes changed', (d) => fs.writeFileSync(path.join(d, 'app', 'public', 'vendor', 'a.min.js'), 'export const a = 1;\r\n'), /app\/public\/vendor\/a\.min\.js is not the file VENDOR\.json records/],
    ['a stray file in what ships', (d) => fs.writeFileSync(path.join(d, 'app', 'public', 'vendor', 'old.min.js'), 'x'), /old\.min\.js is not in VENDOR\.json/],
    ['no notices', (d) => fs.rmSync(path.join(d, 'THIRD-PARTY-NOTICES.md')), /THIRD-PARTY-NOTICES\.md is not in /],
    ['notices that are not this checkout\'s', (d) => fs.appendFileSync(path.join(d, 'THIRD-PARTY-NOTICES.md'), 'more'), /THIRD-PARTY-NOTICES\.md in .* is not this checkout's/],
    ['a licence folder missing', (d) => fs.rmSync(path.join(d, 'licenses', 'pako'), { recursive: true }), /licenses\/pako in .* is not this checkout's/],
    ['a licence text changed', (d) => fs.writeFileSync(path.join(d, 'licenses', 'openjpeg', 'LICENSE'), 'BSD-2-Clause\r\n'), /licenses\/openjpeg in .* is not this checkout's/],
    ['a list that is not this checkout\'s', (d) => fs.writeFileSync(path.join(d, 'app', 'public', 'vendor', 'VENDOR.json'), '{}'), /VENDOR\.json in .* is not this checkout's/],
  ];
  for (const [what, spoil, words] of cases) {
    const shipped = t.ship();
    file = sbomIn();
    const before = fs.readFileSync(file, 'utf8');
    spoil(shipped);
    r = t.run(file, '--tree', shipped);
    assert.equal(r.status, 1, what);
    assert.match(r.stderr, words, what);
    assert.equal(fs.readFileSync(file, 'utf8'), before, what + ': the SBOM is as it was');
  }
  r = t.run(sbomIn(), '--tree');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--tree names the folder that ships/);
});

test('vendor-sbom: a file that is not the one listed, one not listed, one missing, a notice or assessment missing, or a document that is not an SBOM is refused, and nothing is written', () => {
  const sbomIn = (tree) => { const f = path.join(tree, 'sbom.cdx.json'); fs.writeFileSync(f, JSON.stringify(npmSbom())); return f; };
  const manifestEdit = (t, fn) => { const f = path.join(t.vendor, 'VENDOR.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); fn(m); fs.writeFileSync(f, JSON.stringify(m)); };
  const cases = [
    ['a file whose bytes changed', (t) => fs.writeFileSync(path.join(t.vendor, 'a.min.js'), 'export const a = 3;\n'), /a\.min\.js is not the file VENDOR\.json records \(SHA-256 [0-9a-f]{64}, listed [0-9a-f]{64}\)/],
    ['a stray file', (t) => fs.writeFileSync(path.join(t.vendor, 'pdf.worker.min.js'), 'old'), /pdf\.worker\.min\.js is not in VENDOR\.json: nothing ships that is not listed/],
    ['a listed file gone', (t) => fs.rmSync(path.join(t.vendor, 'a.min.js')), /VENDOR\.json lists a\.min\.js, which is not in app\/public\/vendor/],
    ['an entry with no licence', (t) => manifestEdit(t, (m) => { delete m.files['a.min.js'].licence; }), /a\.min\.js: its entry has no licence/],
    ['a manifest that does not parse', (t) => fs.writeFileSync(path.join(t.vendor, 'VENDOR.json'), '{'), /VENDOR\.json could not be read/],
    ['a licence folder with no text', (t) => fs.rmSync(path.join(t.tree, 'licenses', 'x'), { recursive: true }), /licenses\/x holds no licence text in this checkout/],
    ['a notice that is not a licence folder', (t) => manifestEdit(t, (m) => { m.files['a.min.js'].notice = '../secrets'; }), /names "\.\.\/secrets" as its notice, which is not a folder under licenses\//],
    ['an advisory whose assessment is missing', (t) => manifestEdit(t, (m) => { delete m.assessments.parse; }), /pako's GHSA-2222-3333-4444 names the assessment "parse", which VENDOR\.json does not hold/],
  ];
  for (const [what, spoil, words] of cases) {
    const t = sbomTree({ 'a.min.js': 'export const a = 1;\n' });
    const file = sbomIn(t.tree);
    const before = fs.readFileSync(file, 'utf8');
    spoil(t);
    const r = t.run(file);
    assert.equal(r.status, 1, what);
    assert.match(r.stderr, words, what);
    assert.equal(fs.readFileSync(file, 'utf8'), before, what + ': the SBOM is as it was');
  }
  const t = sbomTree({ 'a.min.js': 'x' });
  const notSbom = path.join(t.tree, 'other.json');
  fs.writeFileSync(notSbom, JSON.stringify({ bomFormat: 'SPDX', components: [] }));
  let r = t.run(notSbom);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a CycloneDX SBOM with a components list/);
  assert.deepEqual(JSON.parse(fs.readFileSync(notSbom, 'utf8')), { bomFormat: 'SPDX', components: [] });
  r = t.run(null);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /name the SBOM to add to/);
  r = t.run(path.join(t.tree, 'missing.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be read as JSON/);
});

test('vendor-sbom: on this tree, the SBOM gains every vendored file with the hash, the bundled libraries and the advisories VENDOR.json lists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-vendor-sbom-'));
  const file = path.join(dir, 'agmessage-sbom.cdx.json');
  fs.writeFileSync(file, JSON.stringify(npmSbom()));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'vendor-sbom.js'), file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 vendored files added to agmessage-sbom\.cdx\.json, with 21 libraries bundled in them and 17 advisories assessed/);
  const bom = JSON.parse(fs.readFileSync(file, 'utf8'));
  const vendored = bom.components.filter((c) => c['bom-ref'].startsWith('vendor:'));
  assert.deepEqual(vendored.map((c) => [c['bom-ref'].slice(7), c.name, c.version, c.hashes[0].content]),
    entries.map(([f, e]) => [f, e.package, e.version, e.sha256]).sort(([a], [b]) => (a < b ? -1 : 1)));
  for (const c of vendored) {
    const e = manifest.files[c['bom-ref'].slice(7)];
    assert.deepEqual(c.components.map((b) => [b.name, b.version || null]), e.bundles.map((b) => [b.package, b.version]), c['bom-ref'] + ': its bundled libraries');
  }
  const applies = (id) => manifest.assessments[everyComponent().flatMap(({ c }) => c.advisories || []).find((a) => a.id === id).assessed].applies;
  assert.deepEqual(bom.vulnerabilities.map((v) => [v.id, v.affects[0].ref.replace(/^vendor:[^/]+\//, ''), v.analysis.state]).sort(),
    everyComponent().flatMap(({ c }) => (c.advisories || []).map((a) => [a.id, c.package + '@' + c.version, applies(a.id) ? 'exploitable' : 'not_affected'])).sort(), 'each advisory, on its library, with its analysis');
});
