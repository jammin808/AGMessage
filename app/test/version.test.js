'use strict';
// The version scheme (lib/version.js, tools/stamp-build.js) and the changelog fence: every build says which one it is, a
// development build never reads as a release, and the newest changelog entry is the version package.json names.
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

test('version: a stamp for another version, a bad build or commit, or an unknown channel is not a stamp', () => {
  const good = { version: '0.5.0', build: 3, commit: 'a'.repeat(40), channel: 'dev' };
  assert.ok(v.readStamp(good, '0.5.0'));
  assert.equal(v.readStamp(good, '0.6.0'), null, 'a stamp left from another version');
  for (const bad of [{ build: 0 }, { build: 70000 }, { build: 1.5 }, { commit: 'zzzzzzz' }, { channel: 'beta' }, { channel: 'local' }]) {
    assert.equal(v.readStamp({ ...good, ...bad }, '0.5.0'), null, JSON.stringify(bad));
  }
  assert.equal(v.readStamp(null, '0.5.0'), null);
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
  assert.deepEqual({ ...stamp(), builtAt: '' }, { version: '1.2.3', build: 17, commit: 'abcdef1234567', channel: 'dev', builtAt: '' });
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
});

test('changelog: the newest entry is the version package.json names, every header in the house shape', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const headers = text.split('\n').filter((l) => l.startsWith('## '));
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
