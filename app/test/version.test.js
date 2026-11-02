'use strict';
// The version scheme (lib/version.js, tools/stamp-build.js) and the changelog fence: every build says which one it is, a
// development build never reads as a release, "newer" is MAJOR.MINOR.BUILD, a release is published only above every one
// before it, and the newest changelog entry is the version package.json names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const v = require('../lib/version');

const ROOT = path.join(__dirname, '..', '..');

test('version: the three channels read apart, and in SemVer order', () => {
  assert.equal(v.compose('0.5.0', { channel: 'release', build: 17, commit: 'abc1234def' }), '0.5.0+17.abc1234');
  assert.equal(v.compose('0.5.0', { channel: 'dev', build: 17, commit: 'abc1234def' }), '0.5.0-dev.17+abc1234');
  assert.equal(v.compose('0.5.0', { channel: 'local', commit: 'abc1234def' }), '0.5.0-dev+abc1234');
  assert.equal(v.compose('0.5.0', { channel: 'local' }), '0.5.0-dev', 'outside a checkout: no commit, still -dev');
  assert.ok(v.BUILD.full.startsWith(v.BUILD.version + '-dev') || v.BUILD.full.startsWith(v.BUILD.version + '+'), v.BUILD.full);
  assert.equal(v.BUILD.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8')).version);
});

test('version: a stamp for another version, a bad build or commit, an install version not its own, or an unknown channel is not a stamp', () => {
  const good = { version: '0.5.0', build: 3, installVersion: '0.5.3', commit: 'a'.repeat(40), channel: 'dev' };
  assert.deepEqual(v.readStamp(good, '0.5.0'), { build: 3, installVersion: '0.5.3', commit: 'a'.repeat(40), channel: 'dev', builtAt: '' });
  assert.equal(v.readStamp(good, '0.6.0'), null, 'a stamp left from another version');
  for (const bad of [{ build: 0 }, { build: 70000 }, { build: 1.5 }, { commit: 'zzzzzzz' }, { channel: 'beta' }, { channel: 'local' }, { installVersion: '0.5.4' }, { installVersion: '0.5.0.3' }, { installVersion: undefined }, { installVersion: '' }]) {
    assert.equal(v.readStamp({ ...good, ...bad }, '0.5.0'), null, JSON.stringify(bad));
  }
  assert.equal(v.readStamp(null, '0.5.0'), null);
  assert.equal(v.BUILD.installVersion, v.BUILD.channel === 'local' ? '' : v.installVersionOf(v.BUILD.version, v.BUILD.build), 'this build\'s own');
});

// The seven builds of the plan's reading of the three orders (Part 6, U.6.1), in MAJOR.MINOR.BUILD's order, oldest first:
// a release of 0.5.1, development builds and releases of 0.6.0, a development build of 0.6.1, a 0.6.0 built after it, and
// 0.6.1's release.
const SEVEN = ['0.5.1+12.aaaaaaa', '0.6.0-dev.20+bbbbbbb', '0.6.0+29.ccccccc', '0.6.0-dev.30+ddddddd', '0.6.1-dev.31+eeeeeee', '0.6.0+32.fffffff', '0.6.1+33.1234567'];
/** SemVer 2.0 precedence of two composed builds (its build metadata ignored; a pre-release below its release). */
function semverOrder(a, b) {
  const [x, y] = [a, b].map((s) => { const p = v.parseBuild(s); return { n: p.version.split('.').map(Number), pre: p.channel === 'release' ? null : p.build }; });
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return Math.sign(x.n[i] - y.n[i]);
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  return Math.sign(x.pre - y.pre);
}
/** MAJOR.MINOR.PATCH.BUILD, the four-part order. */
function fourPart(a, b) {
  const [x, y] = [a, b].map((s) => { const p = v.parseBuild(s); return [...p.version.split('.').map(Number), p.build]; });
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}

test('newer: the 21 pairs of seven builds ordered by MAJOR.MINOR.BUILD; SemVer disagrees on 3 of them and the four-part order on 2', () => {
  const pairs = [];
  for (let i = 0; i < SEVEN.length; i++) for (let j = i + 1; j < SEVEN.length; j++) pairs.push([SEVEN[i], SEVEN[j]]);
  assert.equal(pairs.length, 21);
  for (const [a, b] of pairs) {
    assert.equal(v.compareBuilds(b, a), 1, b + ' is newer than ' + a);
    assert.equal(v.compareBuilds(a, b), -1, a + ' is older than ' + b);
  }
  for (const b of SEVEN) assert.equal(v.compareBuilds(b, b), 0);
  const apart = (x, y) => pairs.filter(([a, b]) => x(b, a) !== y(b, a)).map((p) => p.join(' / '));
  assert.deepEqual(apart(semverOrder, v.compareBuilds), ['0.6.0+29.ccccccc / 0.6.0-dev.30+ddddddd', '0.6.0+29.ccccccc / 0.6.0+32.fffffff', '0.6.1-dev.31+eeeeeee / 0.6.0+32.fffffff']);
  assert.deepEqual(apart(semverOrder, fourPart), ['0.6.0+29.ccccccc / 0.6.0-dev.30+ddddddd', '0.6.0+29.ccccccc / 0.6.0+32.fffffff']);
  assert.deepEqual(apart(fourPart, v.compareBuilds), ['0.6.1-dev.31+eeeeeee / 0.6.0+32.fffffff'], 'an older PATCH built after a newer PATCH\'s development build');
  // The install version is MAJOR.MINOR.BUILD; a local build has none and is ordered against nothing.
  assert.deepEqual(SEVEN.map((b) => v.parseBuild(b).installVersion), ['0.5.12', '0.6.20', '0.6.29', '0.6.30', '0.6.31', '0.6.32', '0.6.33']);
  assert.deepEqual([v.installVersionOf('1.2.3', 17), v.installVersionOf('1.2.3', 0), v.installVersionOf('1.2.3', 65536), v.installVersionOf('x', 1)], ['1.2.17', '', '', '']);
  // An MSI's ProductVersion, 255.255.65535: past it there is no install version, and no order.
  assert.deepEqual(v.INSTALL_MAX, { major: 255, minor: 255, build: 65535 });
  assert.deepEqual([v.installVersionOf('255.255.9', 65535), v.installVersionOf('256.0.0', 1), v.installVersionOf('0.256.0', 1)], ['255.255.65535', '', '']);
  assert.equal(v.compareBuilds('0.256.0+5.abcdef1', '0.6.0+5.abcdef1'), null);
  assert.equal(v.readStamp({ version: '0.256.0', build: 3, installVersion: '', commit: 'a'.repeat(40), channel: 'dev' }, '0.256.0'), null, 'a numbered build without an install version is no stamp');
  for (const local of ['0.6.0-dev+abc1234', '0.6.0-dev']) {
    assert.deepEqual(v.parseBuild(local), { version: '0.6.0', channel: 'local', build: 0, installVersion: '', commit: local.includes('+') ? 'abc1234' : '' });
    assert.equal(v.compareBuilds(local, SEVEN[0]), null);
    assert.equal(v.compareBuilds(SEVEN[0], local), null);
  }
  // A build read back is the build compose wrote, in each channel; anything else is no build.
  for (const [channel, build, commit] of [['release', 32, 'abcdef1234'], ['release', 32, ''], ['dev', 31, 'abcdef1234'], ['dev', 31, ''], ['local', 0, 'abcdef1234']]) {
    const full = v.compose('0.6.0', { channel, build, commit });
    assert.deepEqual(v.parseBuild(full), { version: '0.6.0', channel, build, installVersion: v.installVersionOf('0.6.0', build), commit: commit.slice(0, 7) }, full);
  }
  for (const bad of ['0.6.0', '0.6.0+0', '0.6.0+70000', '0.6.0-dev.0', '0.6.0-beta.1', '0.6.0+32.abc1234.x', '0.6.0+32.', '0.6.0-dev+ABC1234', '06.0.0+1', 'x', null, 7, '0.6.0+1'.padEnd(81, '0')]) {
    assert.equal(v.parseBuild(bad), null, String(bad));
    assert.equal(v.compareBuilds(bad, SEVEN[0]), null);
  }
});

test('the release order: a release only above every one before it, so 0.6.0 built after 0.6.1 is never released though its build is newer', () => {
  assert.equal(v.compareBuilds('0.6.0+32.fffffff', '0.6.1+31.eeeeeee'), 1, 'MAJOR.MINOR.BUILD alone would take it');
  assert.match(v.releaseRefusal('0.6.0', ['v0.6.1']), /^v0\.6\.0 is not above the last release, v0\.6\.1: .*nothing is released$/);
  assert.match(v.releaseRefusal('0.6.1', ['v0.5.0', 'v0.6.1', 'v0.6.0']), /not above the last release, v0\.6\.1/, 'the same version again');
  assert.match(v.releaseRefusal('0.6.2', ['v0.5.0', 'v0.10.0']), /not above the last release, v0\.10\.0/, 'by number, never by text');
  assert.equal(v.releaseRefusal('0.6.2', ['v0.5.0', 'v0.6.1', 'v0.6.0']), '');
  assert.equal(v.releaseRefusal('0.6.0', []), '', 'the first release');
  assert.match(v.releaseRefusal('0.6.2', ['v0.6.1', 'nightly']), /the published release "nightly" names no version/, 'a tag it cannot read refuses, never passed over');
  assert.match(v.releaseRefusal('0.6', ['v0.5.0']), /is not MAJOR\.MINOR\.PATCH/);
  // Every other version tagged, released or not: two tags pushed close together, 0.6.1 first and then 0.6.0 (a higher
  // build number), are never both released, whichever run publishes first.
  assert.match(v.releaseRefusal('0.6.0', [], ['v0.5.0', 'v0.6.1', 'v0.6.0']), /^v0\.6\.0 is not above the tag v0\.6\.1, which the repository holds: .*nothing is released$/);
  assert.equal(v.releaseRefusal('0.6.1', ['v0.6.0'], ['v0.5.0', 'v0.6.0', 'v0.6.1']), '', 'its own tag left out');
  assert.equal(v.releaseRefusal('0.6.1', [], ['v0.6.1']), '', 'the first tag');
  assert.match(v.releaseRefusal('0.6.1', [], ['v0.6.0', 'vnext']), /the tag "vnext" names no version .*delete it if it names no release.*nothing is released$/);
  assert.match(v.releaseRefusal('0.6.0', ['v0.6.1'], ['v0.7.0']), /not above the last release, v0\.6\.1/, 'the releases are read first');
  assert.deepEqual([v.compareVersions('0.10.0', '0.9.9'), v.compareVersions('1.0.0', '1.0.0'), v.compareVersions('0.6.0', '0.6.1')], [1, 0, -1]);
});

test('stamp-build: numbers a CI build, names a release only for its own tag, refuses what is outside the scheme', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-stamp-'));
  fs.mkdirSync(path.join(tree, 'app', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'stamp-build.js'), path.join(tree, 'tools', 'stamp-build.js'));
  fs.copyFileSync(path.join(ROOT, 'app', 'lib', 'version.js'), path.join(tree, 'app', 'lib', 'version.js'));
  fs.writeFileSync(path.join(tree, 'app', 'package.json'), JSON.stringify({ version: '1.2.3', agmessage: { runBase: 100 } }));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' };
  const run = (...args) => spawnSync(process.execPath, [path.join(tree, 'tools', 'stamp-build.js'), ...args], { encoding: 'utf8', env });
  const stamp = () => JSON.parse(fs.readFileSync(path.join(tree, 'app', 'build.json'), 'utf8'));

  let r = run('--run', '117', '--commit', 'ABCDEF1234567', '--ref', 'refs/heads/main');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual({ ...stamp(), builtAt: '' }, { version: '1.2.3', build: 17, installVersion: '1.2.17', commit: 'abcdef1234567', channel: 'dev', builtAt: '' });
  assert.match(r.stdout, /1\.2\.3-dev\.17\+abcdef1/);
  assert.match(run('--print').stdout, /^1\.2\.3-dev\.17\+abcdef1/, 'the stamped tree reads as that build');

  r = run('--run', '118', '--commit', 'abcdef1', '--ref', 'refs/tags/v1.2.3');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stamp().channel, 'release');

  fs.rmSync(path.join(tree, 'app', 'build.json'));
  for (const [args, words] of [
    [['--run', '118', '--commit', 'abcdef1', '--ref', 'refs/tags/v1.2.4'], /does not name this version/],
    [['--run', '100', '--commit', 'abcdef1'], /not past agmessage\.runBase/],
    [['--run', '70000', '--commit', 'abcdef1'], /past 65535/],
    [['--run', 'x', '--commit', 'abcdef1'], /not a run number/],
    [['--run', '101', '--commit', 'nothex'], /not 7 to 64 hex/],
  ]) {
    r = run(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, words);
    assert.ok(!fs.existsSync(path.join(tree, 'app', 'build.json')), 'nothing written: ' + args.join(' '));
  }
  assert.equal(run('--check-tag', 'v1.2.3').status, 0);
  assert.match(run('--check-tag', 'v1.2.4').stderr, /does not name this version/);
  // The release order: the tags already released, as the release job lists them (a line each), or none for the first.
  for (const [released, ok] of [['v1.2.2\nv1.1.9\nv0.9.0', true], ['', true], ['v1.2.4', false], ['v1.2.3', false], ['v1.10.0 v1.2.2', false], ['v1.2.2\nlatest', false]]) {
    r = run('--check-tag', 'v1.2.3', '--released', released);
    assert.equal(r.status === 0, ok, JSON.stringify(released) + ': ' + r.stdout + r.stderr);
    if (ok) assert.match(r.stdout, /above every release published/);
    else assert.match(r.stderr, /^stamp-build: .*nothing is released/);
  }
  assert.match(run('--check-tag', 'v1.2.4', '--released', '').stderr, /does not name this version/, 'the tag is checked first');
  // And every other version tag the repository holds, its own left out, as the release job lists them.
  for (const [tags, ok] of [['v1.2.3\nv1.2.2', true], ['', true], ['v1.2.3\nv1.2.4', false], ['v1.3.0', false], ['v1.2.2 vnext', false]]) {
    r = run('--check-tag', 'v1.2.3', '--released', 'v1.2.2', '--tags', tags);
    assert.equal(r.status === 0, ok, JSON.stringify(tags) + ': ' + r.stdout + r.stderr);
    if (ok) assert.match(r.stdout, /above every release published, above every other version tagged$/m);
    else assert.match(r.stderr, /^stamp-build: .*nothing is released/);
  }
  // A version whose MAJOR or MINOR an installer's version cannot carry is never stamped.
  fs.writeFileSync(path.join(tree, 'app', 'package.json'), JSON.stringify({ version: '1.256.0', agmessage: { runBase: 100 } }));
  r = run('--run', '101', '--commit', 'abcdef1');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the version 1\.256\.0 has a MAJOR or MINOR past 255, .*nothing was stamped/);
  assert.ok(!fs.existsSync(path.join(tree, 'app', 'build.json')));
});

test('the release job asks the release order itself, one release job at a time, before it attests or publishes anything', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = (n) => '\n' + ' '.repeat(n);
  const release = ci.slice(ci.indexOf(job(2) + 'release:\n'));
  assert.ok(release.length > 20 && !/\n {2}[a-z-]+:\n/.test(release.slice(12)), 'the release job is the workflow\'s last');
  assert.ok(release.includes(job(4) + 'concurrency:' + job(6) + 'group: release-$' + '{{ github.repository }}' + job(6) + 'cancel-in-progress: false\n'), 'one release job at a time, none cancelled');
  const check = release.indexOf('node tools/stamp-build.js --check-tag "$' + '{GITHUB_REF_NAME}" --released "$released" --tags "$tags"');
  const lists = ['gh release list --repo "$GITHUB_REPOSITORY" --limit 1000 --exclude-drafts', 'gh api --paginate "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/v"'].map((l) => release.indexOf(l));
  assert.ok(check > 0 && lists.every((i) => i > 0 && i < check), 'the releases and the tags listed, then the check');
  for (const later of ['actions/attest-build-provenance', 'gh release create']) assert.ok(release.indexOf(later) > check, later + ' only after the check');
  assert.ok(ci.indexOf('--released "$released" --tags "$tags"') < ci.indexOf(job(2) + 'release:\n'), 'the analyze job asks it first too');
});

test('changelog: the newest entry is the version package.json names, every header in the house shape', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const headers = text.split(/\r?\n/).filter((l) => l.startsWith('## '));   // a Windows checkout has CRLF
  assert.ok(headers.length >= 1);
  for (const h of headers) assert.match(h, /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2} — \S.+$/, h);
  assert.equal(/^## (\d+\.\d+\.\d+)/.exec(headers[0])[1], v.BUILD.version, 'the newest entry names the version being built');
  const versions = headers.map((h) => /^## (\d+\.\d+\.\d+)/.exec(h)[1]);
  assert.equal(new Set(versions).size, versions.length, 'one entry per version');
  const order = versions.map((x) => x.split('.').map(Number));
  for (let i = 1; i < order.length; i++) {
    const [a, b] = [order[i - 1], order[i]];
    assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))), 'newest first: ' + versions[i - 1] + ' before ' + versions[i]);
  }
});
