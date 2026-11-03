'use strict';
// Every path the portable zip makes once a person extracts it (tools/zip-paths.js): laid as Explorer's Extract All lays
// it, under a Downloads folder, the folder named after the zip and the bundle's one folder, AGMessage, and again as the
// clean copy make-shareable-copy.bat makes beside that folder; a file held under 260 characters and a folder under 248.
// The package job runs the check on the zip it built, before anything else is done with it, and the zip is
// AGMessage-Portable-<version>.zip holding the one folder AGMessage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const zipmod = require('../lib/zip');

const ROOT = path.join(__dirname, '..', '..');
const ZIP_PATHS_JS = path.join(ROOT, 'tools', 'zip-paths.js');
const Z = require(ZIP_PATHS_JS);
const T = require(path.join(ROOT, 'tools', 'readings-take.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (...a) => spawnSync(process.execPath, [ZIP_PATHS_JS, ...a], { encoding: 'utf8' });
const win = (p) => p.replace(/\//g, '\\');

/** A zip written by the audit export's writer, into a file: [name, data or null for an empty file]. */
async function zipFile(file, members) {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const z = new zipmod.ZipStream(out);
  for (const [name, data] of members) await z.add(name, data === null ? [] : [Buffer.from(data)]);
  await z.end();
  out.end();
  fs.writeFileSync(file, Buffer.concat(chunks));
}

const entry = (name) => ({ name, dir: name.endsWith('/') });

test('the paths: under the base, the folder Extract All names after the zip, then each member\'s own folders, with Windows\' separators; and a clean copy beside the bundle\'s folder', () => {
  assert.equal(Z.BASE, 'C:\\Users\\' + 'x'.repeat(20) + '\\Downloads', 'a browser\'s Downloads folder in the profile folder of the longest user name Windows takes');
  assert.equal(Z.ACCOUNT.length, 20);
  assert.deepEqual([Z.MAX_FILE, Z.MAX_FOLDER], [259, 247], 'MAX_PATH and CreateDirectory\'s 248, each less its null');
  assert.equal(Z.stemOf('/x/dist/AGMessage-Portable-0.6.0.zip'), 'AGMessage-Portable-0.6.0');
  assert.equal(Z.stemOf('C:\\x\\dist\\AGMessage-Portable-0.6.0-dev.9_abc1234.zip'), 'AGMessage-Portable-0.6.0-dev.9_abc1234', 'a Windows path, read on any system');
  assert.equal(Z.stemOf('AGMessage-Portable-0.6.0 (1).ZIP'), 'AGMessage-Portable-0.6.0 (1)', 'a browser\'s second copy keeps its own name');
  assert.equal(Z.windowsFolder('D:/Shows/2026/'), 'D:\\Shows\\2026');
  const members = [entry('AGMessage/app/'), entry('AGMessage/app/server.js'), entry('AGMessage/node/node.exe'), entry('AGMessage/app/data/rooms/.keep')];
  const p = Z.extractedPaths(members, { base: 'D:\\Shows', stem: 'Z', copy: null });
  assert.deepEqual(p.files.map((f) => f.path), ['D:\\Shows\\Z\\AGMessage\\app\\data\\rooms\\.keep', 'D:\\Shows\\Z\\AGMessage\\app\\server.js', 'D:\\Shows\\Z\\AGMessage\\node\\node.exe'], 'the longest first, two of a length by name; the bundle\'s folder inside the one Extract All makes');
  assert.deepEqual(p.files.map((f) => f.length), p.files.map((f) => f.path.length));
  assert.deepEqual(p.folders.map((f) => f.path).sort(), ['D:\\Shows\\Z', 'D:\\Shows\\Z\\AGMessage', 'D:\\Shows\\Z\\AGMessage\\app', 'D:\\Shows\\Z\\AGMessage\\app\\data', 'D:\\Shows\\Z\\AGMessage\\app\\data\\rooms', 'D:\\Shows\\Z\\AGMessage\\node'], 'every folder a member lies in or names, once');
  assert.equal(p.files.length, 3, 'a folder\'s own member is no file');
  // The clean copy, by default: what the bundle's folder holds, again in a folder of the copy's name beside it.
  const both = Z.extractedPaths(members, { base: 'D:\\Shows', stem: 'Z' });
  assert.deepEqual(both.files.map((f) => f.path).sort(), [...p.files.map((f) => f.path), 'D:\\Shows\\Z\\' + Z.COPY + '\\app\\data\\rooms\\.keep', 'D:\\Shows\\Z\\' + Z.COPY + '\\app\\server.js', 'D:\\Shows\\Z\\' + Z.COPY + '\\node\\node.exe'].sort());
  assert.ok(both.folders.some((f) => f.path === 'D:\\Shows\\Z\\' + Z.COPY + '\\app\\data\\rooms'));
  assert.equal(Z.extractedPaths([entry('AGMessage/a'), entry('top.txt')], { base: 'C:', stem: 'Z', copy: 'K' }).files.map((f) => f.path).sort().join(' '), 'C:\\Z\\AGMessage\\a C:\\Z\\K\\a C:\\Z\\top.txt', 'a file at the zip\'s top is outside the folder the copy copies');
  // Counted as Windows counts: UTF-16 code units.
  assert.equal(Z.extractedPaths([entry('B/\u00e9\u{1F3AC}.txt')], { base: 'C:', stem: 'B', copy: null }).files[0].length, 'C:\\B\\B\\'.length + 1 + 2 + 4);
  assert.throws(() => Z.extractedPaths([entry('B/../x')], { base: 'C:', stem: 'B' }), /outside its folder/, 'a member that would leave the folder is refused, never measured');
  assert.throws(() => Z.extractedPaths([entry('B/x')], { base: 'C:' }), /the zip's own name is needed/);
});

test('the clean copy\'s name is the longest make-shareable-copy.bat gives one, beside the bundle\'s folder', () => {
  const bat = read('make-shareable-copy.bat');
  const name = /\nset "NAME=([^"%]+)-%STAMP%"\n/.exec(bat);
  assert.ok(name, 'the copy is named with the time');
  assert.match(bat, /-Command "Get-Date -Format yyyyMMdd-HHmm"/, 'the time: 13 characters');
  assert.match(bat, /\nif %N% gtr 99 goto taken\nset "DEST=%PARENT%\\%NAME%-%N%"\n/, 'numbered up to -99');
  assert.match(bat, /\nfor %%P in \("%~dp0\.\."\) do set "PARENT=%%~fP"\n/, 'made in the folder that holds the bundle\'s folder');
  assert.match(bat, /\nset "DEST=%PARENT%\\%NAME%"\n/);
  assert.match(bat, /if not defined STAMP set "STAMP=undated"/, 'undated is shorter than a time');
  const longest = name[1] + '-' + 'yyyyMMdd-HHmm' + '-99';
  assert.equal(Z.COPY.length, longest.length, 'the check lays the copy under a name as long as the longest the .bat makes');
  assert.ok(Z.COPY.startsWith(name[1] + '-'), Z.COPY);
  assert.equal(name[1], 'AGMessage-Portable-clean', 'named as the zip is, without Windows');
  assert.ok('undated'.length < 'yyyyMMdd-HHmm'.length);
});

test('the limits: a file\'s path of 259 characters passes and 260 fails; a folder\'s of 247 passes and 248 fails', () => {
  const base = 'C:\\b';
  const stem = 'S';
  const opts = { base, stem, copy: null };
  const head = base + '\\' + stem + '\\' + stem + '\\';   // C:\b\S\S\  (10)
  const fileOf = (n) => stem + '/' + 'f'.repeat(n - head.length);
  assert.equal(Z.extractedPaths([entry(fileOf(259))], opts).files[0].length, 259);
  const at = Z.check([entry(fileOf(259))], opts);
  assert.deepEqual([at.over, at.longestFile.length, at.files], [[], 259, 1]);
  const past = Z.check([entry(fileOf(260)), entry(fileOf(259))], opts);
  assert.deepEqual(past.over.map((o) => [o.kind, o.length, o.limit]), [['file', 260, 259]], 'only the one past its limit');
  // A folder of 247, then of 248: a file inside each stays short of 259, so only the folder can fail.
  const folderOf = (n) => stem + '/' + 'd'.repeat(n - head.length) + '/';
  const inFolder = (n) => folderOf(n) + 'a';
  const ok = Z.check([entry(folderOf(247)), entry(inFolder(247))], opts);
  assert.deepEqual([ok.over, ok.longestFolder.length, ok.longestFile.length], [[], 247, 249]);
  const deep = Z.check([entry(inFolder(248))], opts);
  assert.deepEqual(deep.over.map((o) => [o.kind, o.length, o.limit]), [['folder', 248, 247]], 'a folder named only by the file inside it is measured too');
  assert.match(Z.lengthWords('file', at.longestFile, Z.MAX_FILE), /^the longest file is 259 characters of 259 \(0 to spare\): C:\\b\\S\\S\\f+$/);
  assert.match(Z.lengthWords('file', past.over[0], Z.MAX_FILE), /260 characters of 259 \(1 too many\)/);
  assert.equal(Z.lengthWords('file', null, Z.MAX_FILE), 'no file');
  // The clean copy's paths are held to the same limits: a file the bundle's folder holds at 259 is longer in the copy.
  const copied = Z.check([entry(fileOf(259))], { base, stem, copy: 'S' + 'c'.repeat(5) });
  assert.deepEqual(copied.over.map((o) => [o.kind, o.length]), [['file', 264]], 'the copy\'s, 5 characters longer');
});

test('the command: a bundle zip read from its central directory, said with its longest paths; exit 1 naming each too long, 2 for a zip it cannot read, 64 for a word it does not know', async () => {
  const dir = tmp('agm-zippaths-');
  try {
    const stem = 'AGMessage-Portable-0.6.0-dev.9_abc1234';
    const LONG = 'app/public/vendor/a-file-name-long-enough-to-be-the-one.min.js';
    const zip = path.join(dir, stem + '.zip');
    await zipFile(zip, [['AGMessage/app/server.js', 'one'], ['AGMessage/node/node.exe', 'two'], ['AGMessage/app/data/rooms/.keep', null], ['AGMessage/' + LONG, 'three']]);
    const fine = run(zip);
    assert.equal(fine.status, 0, fine.stderr);
    const extracted = Z.BASE + '\\' + stem;
    const longest = extracted + '\\' + Z.COPY + '\\' + win(LONG);   // the clean copy's name is longer than AGMessage
    assert.ok(fine.stdout.startsWith('zip-paths: 4 members of ' + stem + '.zip, extracted under ' + extracted + '\\, and a clean copy beside the bundle\'s folder as ' + Z.COPY + ' (8 files, 15 folders)\n'), fine.stdout);
    assert.ok(fine.stdout.includes('  the longest file is ' + longest.length + ' characters of 259 (' + (259 - longest.length) + ' to spare): ' + longest + '\n'), fine.stdout);
    assert.ok(fine.stdout.includes('  the longest folder is ' + (extracted + '\\' + Z.COPY + '\\app\\public\\vendor').length + ' characters of 247'), fine.stdout);
    assert.equal(fine.stderr, '');
    // The same zip from a base deep enough that its longest file reaches 260: refused, that path named.
    const room = 260 - ('C:\\' + '\\' + stem + '\\' + Z.COPY + '\\' + win(LONG)).length;
    const deep = 'C:\\' + 'd'.repeat(room);
    const over = run(zip, '--base', deep);
    assert.equal(over.status, 1, over.stdout + over.stderr);
    assert.equal(over.stderr, 'zip-paths: 1 path too long for Extract All (a file holds 259 characters at most, a folder 247):\n  file, 260 characters: ' + deep + '\\' + stem + '\\' + Z.COPY + '\\' + win(LONG) + '\n');
    assert.match(over.stdout, /the longest file is 260 characters of 259 \(1 too many\)/);
    // Deeper still, the bundle's own paths and the folders too, the longest first, as many as the check finds in the
    // zip's own directory.
    const deeper = run(zip, '--base', deep + 'd'.repeat(40));
    assert.equal(deeper.status, 1);
    const expected = Z.check(T.zipEntries(zip), { base: deep + 'd'.repeat(40), stem }).over;
    assert.deepEqual(expected.map((o) => [o.kind, o.length]), [['file', 300], ['file', 268], ['folder', 255], ['folder', 252], ['folder', 248]], 'the copy\'s file, the bundle\'s, then the copy\'s folders past theirs: vendor, rooms, public');
    assert.ok(deeper.stderr.startsWith('zip-paths: ' + expected.length + ' paths too long'), deeper.stderr);
    const named = deeper.stderr.split('\n').slice(1, -1);
    assert.deepEqual(named, expected.map((o) => '  ' + o.kind + ', ' + o.length + ' characters: ' + o.path));
    assert.equal(named[1], '  file, 268 characters: ' + deep + 'd'.repeat(40) + '\\' + stem + '\\AGMessage\\' + win(LONG), 'the bundle\'s own path');
    // Past 20, the rest are counted.
    const many = path.join(dir, 'many.zip');
    await zipFile(many, Array.from({ length: 25 }, (_, i) => ['many/' + 'f'.repeat(200) + i, null]));
    const lots = run(many, '--base', 'C:\\' + 'b'.repeat(60));   // each file 271 characters or more, its copy's 312
    assert.equal(lots.status, 1);
    assert.equal((lots.stderr.match(/^ {2}file, /gm) || []).length, 20);
    assert.match(lots.stderr, /\n {2}and 30 more\n$/, 'the bundle\'s 25 and the copy\'s 25');
    // A member that would leave its folder, a file that is no zip, and none at all: exit 2, nothing measured.
    const bad = path.join(dir, 'bad.zip');
    await zipFile(bad, [['bad/../../x.js', '1']]);
    const outside = run(bad);
    assert.deepEqual([outside.status, outside.stdout], [2, '']);
    assert.match(outside.stderr, /outside its folder/);
    fs.writeFileSync(path.join(dir, 'not.zip'), 'not a zip at all');
    const notZip = run(path.join(dir, 'not.zip'));
    assert.equal(notZip.status, 2);
    assert.match(notZip.stderr, /could not be read \(not\.zip is not a zip/);
    assert.equal(run(path.join(dir, 'none.zip')).status, 2);
    for (const words of [[], [zip, zip], ['--base'], [zip, '--base'], ['--what', zip]]) assert.equal(run(...words).status, 64, JSON.stringify(words));
    // --base takes an absolute folder only, a drive's or a share's: a relative one, or the next word, would measure short.
    for (const base of ['--what', 'Downloads', '.', 'C:x', '\\\\server', '']) {
      const r = run('--base', base, zip);
      assert.deepEqual([r.status, r.stdout], [64, ''], JSON.stringify(base));
      if (base) assert.match(r.stderr, /--base names an absolute folder/);
    }
    for (const base of ['D:\\Shows', 'D:/Shows', '\\\\server\\share\\Shows']) assert.equal(run(zip, '--base', base).status, 0, base);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bundle: AGMessage-Portable-<version>.zip holding one folder, AGMessage; CI checks its paths after the build, before it starts or uploads it, and starts it from that folder', () => {
  const ps = read('tools/build-portable.ps1');
  assert.match(ps, /\n\$name = "AGMessage-Portable-\$label"\n/, 'the zip named by its build, without Windows');
  assert.match(ps, /\n\$stage = Join-Path \$root 'dist\\AGMessage'\n/, 'the folder staged as AGMessage, whatever the build');
  assert.match(ps, /\n\$zip = Join-Path \$root "dist\\\$name\.zip"\n/);
  assert.match(ps, /\nCompress-Archive -Path \$stage -DestinationPath \$zip\n/, 'the staged folder itself zipped, so it is the zip\'s one folder');
  const ci = read('.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /AGMessage-Portable-Windows/, 'one pattern, which 0.5\'s releases match too');
  const job = ci.slice(ci.indexOf('\n  package:\n'), ci.indexOf('\n  readings:\n'));
  assert.ok(job.length > 100, 'the package job');
  const steps = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').split('\n      - ').slice(1);   // each step without the comments above the next
  const at = (needle) => steps.findIndex((s) => s.includes(needle));
  const build = at('./tools/build-portable.ps1');
  const check = at('node tools/zip-paths.js');
  assert.ok(build >= 0 && check === build + 1, 'the check is the step after the build');
  assert.ok(at('Expand-Archive') > check, 'before the bundle is extracted and started');
  assert.ok(at('actions/upload-artifact') > check, 'before the zip is uploaded');
  // The step whole, line for line: no condition, no way past the exit, the default base (never one shorter).
  assert.equal(steps[check], [
    'name: Every path in the zip, extracted from a Downloads folder, under 260 characters (tools/zip-paths.js)',
    '        shell: pwsh',
    '        run: |',
    '          $zip = @(Get-ChildItem dist -Filter \'AGMessage-Portable-*.zip\')',
    '          if ($zip.Count -ne 1) { throw "expected one bundle zip in dist, found $($zip.Count)" }',
    '          node tools/zip-paths.js $zip[0].FullName',
    '          if ($LASTEXITCODE -ne 0) { throw "a path in the bundle is too long once extracted from a Downloads folder (tools/zip-paths.js, exit $LASTEXITCODE)" }',
  ].join('\n'));
  // The start step takes the one folder AGMessage, and nothing else at the zip's top; the SBOM reads that folder.
  const start = steps[at('Expand-Archive')];
  assert.match(start, /\$top = @\(Get-ChildItem \$dest -Force\)\n\s+if \(\$top\.Count -ne 1 -or \$top\[0\]\.Name -cne 'AGMessage' -or -not \$top\[0\]\.PSIsContainer\) \{ throw /);
  assert.match(start, /\$root = \$top\[0\]\.FullName\n/);
  assert.match(steps[at('vendor-sbom.js')], /\$shipped = Join-Path \$env:RUNNER_TEMP 'bundle-start\\AGMessage'\n/);
  assert.match(ci, /run start-agmessage\.bat from the AGMessage folder it extracts/, 'the release\'s notes');
});
