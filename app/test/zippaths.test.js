'use strict';
// Every path the portable zip makes once a person extracts it (tools/zip-paths.js): laid as Explorer's Extract All lays
// it, under a Downloads folder and the folder named after the zip, a file held under 260 characters and a folder under
// 248; and the package job runs the check on the zip it built, before anything else is done with it.
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

test('the paths: under the base, the folder Extract All names after the zip, then each member\'s own folders, with Windows\' separators', () => {
  assert.equal(Z.BASE, 'C:\\Users\\' + 'x'.repeat(20) + '\\Downloads', 'a browser\'s Downloads folder under the longest profile folder a local account makes');
  assert.equal(Z.ACCOUNT.length, 20);
  assert.deepEqual([Z.MAX_FILE, Z.MAX_FOLDER], [259, 247], 'MAX_PATH and CreateDirectory\'s 248, each less its null');
  assert.equal(Z.stemOf('/x/dist/AGMessage-Portable-Windows-0.6.0.zip'), 'AGMessage-Portable-Windows-0.6.0');
  assert.equal(Z.stemOf('AGMessage-Portable-Windows-0.6.0 (1).ZIP'), 'AGMessage-Portable-Windows-0.6.0 (1)', 'a browser\'s second copy keeps its own name');
  assert.equal(Z.windowsFolder('D:/Shows/2026/'), 'D:\\Shows\\2026');
  const p = Z.extractedPaths([entry('Bundle/app/'), entry('Bundle/app/server.js'), entry('Bundle/node/node.exe'), entry('Bundle/app/data/rooms/.keep')], { base: 'D:\\Shows', stem: 'Bundle' });
  assert.deepEqual(p.files.map((f) => f.path), ['D:\\Shows\\Bundle\\Bundle\\app\\data\\rooms\\.keep', 'D:\\Shows\\Bundle\\Bundle\\app\\server.js', 'D:\\Shows\\Bundle\\Bundle\\node\\node.exe'], 'the longest first, two of a length by name; the bundle\'s own folder inside the one Extract All makes');
  assert.deepEqual(p.files.map((f) => f.length), p.files.map((f) => f.path.length));
  assert.deepEqual(p.folders.map((f) => f.path).sort(), ['D:\\Shows\\Bundle', 'D:\\Shows\\Bundle\\Bundle', 'D:\\Shows\\Bundle\\Bundle\\app', 'D:\\Shows\\Bundle\\Bundle\\app\\data', 'D:\\Shows\\Bundle\\Bundle\\app\\data\\rooms', 'D:\\Shows\\Bundle\\Bundle\\node'], 'every folder a member lies in or names, once');
  assert.equal(p.files.length, 3, 'a folder\'s own member is no file');
  // Counted as Windows counts: UTF-16 code units.
  assert.equal(Z.extractedPaths([entry('B/\u00e9\u{1F3AC}.txt')], { base: 'C:', stem: 'B' }).files[0].length, 'C:\\B\\B\\'.length + 1 + 2 + 4);
  assert.throws(() => Z.extractedPaths([entry('B/../x')], { base: 'C:', stem: 'B' }), /outside its folder/, 'a member that would leave the folder is refused, never measured');
  assert.throws(() => Z.extractedPaths([entry('B/x')], { base: 'C:' }), /the zip's own name is needed/);
});

test('the limits: a file\'s path of 259 characters passes and 260 fails; a folder\'s of 247 passes and 248 fails', () => {
  const base = 'C:\\b';
  const stem = 'S';
  const head = base + '\\' + stem + '\\' + stem + '\\';   // C:\b\S\S\  (10)
  const fileOf = (n) => stem + '/' + 'f'.repeat(n - head.length);
  assert.equal(Z.extractedPaths([entry(fileOf(259))], { base, stem }).files[0].length, 259);
  const at = Z.check([entry(fileOf(259))], { base, stem });
  assert.deepEqual([at.over, at.longestFile.length, at.files], [[], 259, 1]);
  const past = Z.check([entry(fileOf(260)), entry(fileOf(259))], { base, stem });
  assert.deepEqual(past.over.map((o) => [o.kind, o.length, o.limit]), [['file', 260, 259]], 'only the one past its limit');
  // A folder of 247, then of 248: a file inside each stays short of 259, so only the folder can fail.
  const folderOf = (n) => stem + '/' + 'd'.repeat(n - head.length) + '/';
  const inFolder = (n) => folderOf(n) + 'a';
  const ok = Z.check([entry(folderOf(247)), entry(inFolder(247))], { base, stem });
  assert.deepEqual([ok.over, ok.longestFolder.length, ok.longestFile.length], [[], 247, 249]);
  const deep = Z.check([entry(inFolder(248))], { base, stem });
  assert.deepEqual(deep.over.map((o) => [o.kind, o.length, o.limit]), [['folder', 248, 247]], 'a folder named only by the file inside it is measured too');
  assert.match(Z.lengthWords('file', at.longestFile, Z.MAX_FILE), /^the longest file is 259 characters of 259 \(0 to spare\): C:\\b\\S\\S\\f+$/);
  assert.match(Z.lengthWords('file', past.over[0], Z.MAX_FILE), /260 characters of 259 \(1 too many\)/);
  assert.equal(Z.lengthWords('file', null, Z.MAX_FILE), 'no file');
});

test('the command: a bundle zip read from its central directory, said with its longest paths; exit 1 naming each too long, 2 for a zip it cannot read, 64 for a word it does not know', async () => {
  const dir = tmp('agm-zippaths-');
  try {
    const stem = 'AGMessage-Portable-Windows-0.6.0-dev.9_abc1234';
    const LONG = 'app/public/vendor/a-file-name-long-enough-to-be-the-one.min.js';
    const zip = path.join(dir, stem + '.zip');
    await zipFile(zip, [[stem + '/app/server.js', 'one'], [stem + '/node/node.exe', 'two'], [stem + '/app/data/rooms/.keep', null], [stem + '/' + LONG, 'three']]);
    const fine = run(zip);
    assert.equal(fine.status, 0, fine.stderr);
    const extracted = Z.BASE + '\\' + stem + '\\' + stem;
    const longest = '\\' + LONG.replace(/\//g, '\\');
    assert.ok(fine.stdout.includes('4 members of ' + stem + '.zip, extracted under ' + Z.BASE + '\\' + stem + '\\ (4 files, 8 folders)'), fine.stdout);
    assert.ok(fine.stdout.includes('the longest file is ' + (extracted + longest).length + ' characters of 259 (' + (259 - (extracted + longest).length) + ' to spare): ' + extracted + longest + '\n'), fine.stdout);
    assert.ok(fine.stdout.includes('the longest folder is ' + (extracted + '\\app\\public\\vendor').length + ' characters of 247'), fine.stdout);
    assert.equal(fine.stderr, '');
    // The same zip from a base deep enough that its longest file reaches 260: refused, that path named.
    const room = 260 - ('C:\\' + '\\' + stem + '\\' + stem + longest).length;
    const deep = 'C:\\' + 'd'.repeat(room);
    const over = run(zip, '--base', deep);
    assert.equal(over.status, 1, over.stdout + over.stderr);
    assert.match(over.stderr, /^zip-paths: 1 path too long for Extract All \(a file holds 259 characters at most, a folder 247\):\n {2}file, 260 characters: C:\\d+\\AGMessage-Portable-Windows-0\.6\.0-dev\.9_abc1234\\AGMessage-Portable-Windows-0\.6\.0-dev\.9_abc1234\\app\\public\\vendor\\a-file-name-long-enough-to-be-the-one\.min\.js\n$/);
    assert.match(over.stdout, /the longest file is 260 characters of 259 \(1 too many\)/);
    // Deeper still, its folders too, the longest first, as many as the check finds in the zip's own directory.
    const deeper = run(zip, '--base', deep + 'd'.repeat(40));
    assert.equal(deeper.status, 1);
    const expected = Z.check(T.zipEntries(zip), { base: deep + 'd'.repeat(40), stem }).over;
    assert.deepEqual(expected.map((o) => [o.kind, o.length]), [['file', 300], ['folder', 255], ['folder', 252], ['folder', 248]], 'the file, then the folders past theirs: vendor, rooms, public');
    assert.ok(deeper.stderr.startsWith('zip-paths: ' + expected.length + ' paths too long'), deeper.stderr);
    const named = deeper.stderr.split('\n').slice(1, -1);
    assert.deepEqual(named, expected.map((o) => '  ' + o.kind + ', ' + o.length + ' characters: ' + o.path));
    assert.equal(named[0], '  file, 300 characters: ' + deep + 'd'.repeat(40) + '\\' + stem + '\\' + stem + longest, 'the longest first');
    // Past 20, the rest are counted.
    const many = path.join(dir, 'many.zip');
    await zipFile(many, Array.from({ length: 25 }, (_, i) => ['many/' + 'f'.repeat(200) + i, null]));
    const lots = run(many, '--base', 'C:\\' + 'b'.repeat(60));   // each file 275 characters or more
    assert.equal(lots.status, 1);
    assert.equal((lots.stderr.match(/^ {2}file, /gm) || []).length, 20);
    assert.match(lots.stderr, /\n {2}and 5 more\n$/);
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CI: the package job checks the zip it built, before it starts or uploads it, and fails on any exit but 0', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  package:\n'), ci.indexOf('\n  readings:\n'));
  assert.ok(job.length > 100, 'the package job');
  const steps = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').split('\n      - ').slice(1);   // each step without the comments above the next
  const at = (needle) => steps.findIndex((s) => s.includes(needle));
  const build = at('./tools/build-portable.ps1');
  const check = at('node tools/zip-paths.js');
  assert.ok(build >= 0 && check === build + 1, 'the check is the step after the build');
  assert.ok(at('Expand-Archive') > check, 'before the bundle is extracted and started');
  assert.ok(at('actions/upload-artifact') > check, 'before the zip is uploaded');
  const step = steps[check];
  assert.match(step, /shell: pwsh/);
  assert.match(step, /\$zip = @\(Get-ChildItem dist -Filter 'AGMessage-Portable-Windows-\*\.zip'\)\n\s+if \(\$zip\.Count -ne 1\) \{ throw/, 'the one bundle zip, by the name the build gives it');
  assert.match(step, /node tools\/zip-paths\.js \$zip\[0\]\.FullName\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw /, 'run on the zip, with the default base, and a non-zero exit fails the step');
  assert.doesNotMatch(step, /--base|continue-on-error/, 'the default base, never one shorter; never let through');
  // The bundle is one folder named as the zip is (tools/build-portable.ps1), which is why the name is counted twice.
  const ps = read('tools/build-portable.ps1');
  assert.match(ps, /\$name = "AGMessage-Portable-Windows-\$label"/);
  assert.match(ps, /\$stage = Join-Path \$root "dist\\\$name"/);
  assert.match(ps, /\$zip = Join-Path \$root "dist\\\$name\.zip"/);
  assert.match(ps, /Compress-Archive -Path \$stage -DestinationPath \$zip/, 'the staged folder itself zipped, so it is the zip\'s one folder');
});
