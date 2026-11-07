#!/usr/bin/env node
'use strict';
/**
 * Stamps a CI build (app/build.json) and checks a release tag against the version. One scheme: app/lib/version.js.
 *
 *   node tools/stamp-build.js --run <github.run_number> --commit <github.sha> [--ref <github.ref>]
 *       writes app/build.json ({version, build, installVersion, commit, channel, builtAt, repo}); the channel is "release"
 *       for the ref refs/tags/v<version>, "dev" for anything else; installVersion is MAJOR.MINOR.BUILD, the order "newer" is
 *       read by (app/lib/version.js); repo is the repository the build was made in (GITHUB_REPOSITORY, owner/name), which
 *       an installed node's checked upgrade asks GitHub for its releases (app/machine.js): a stamp made with none names
 *       none, and an installed node of it checks no installer
 *   node tools/stamp-build.js --check-tag <tag> [--released <tags>] [--tags <tags>]
 *       fails unless the tag is v<package.json version>: a release is never built from a tag that names another version;
 *       with --released (the tags of the releases already published, one per line or space; none for a first release),
 *       also unless that version is above every one of them by SemVer; with --tags (every v-tag the repository holds),
 *       also unless it is above every other one, released or not, so among releases SemVer and MAJOR.MINOR.BUILD agree
 *   node tools/stamp-build.js --print
 *       prints the version this tree reads as (local builds included)
 *
 * The build number is the run number less package.json's agmessage.runBase, 1 to 65535 (an MSI ProductVersion's BUILD),
 * and MAJOR and MINOR are at most 255 (its first two parts); outside those nothing is written and the step fails with
 * words. Raise the version's MAJOR or MINOR and set runBase to the last run's number to start the count again at 1.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const { compose, installVersionOf, releaseRefusal, INSTALL_MAX, SEMVER, COMMIT, REPO, BUILD } = require(path.join(APP, 'lib', 'version.js'));

function fail(words) { console.error('stamp-build: ' + words); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? String(process.argv[i + 1] || '') : null; }

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
if (!SEMVER.test(version)) fail('package.json version "' + version + '" is not MAJOR.MINOR.PATCH');

if (process.argv.includes('--print')) { console.log(BUILD.full); process.exit(0); }

const tag = arg('--check-tag');
if (tag !== null) {
  if (tag !== 'v' + version) fail('the tag "' + tag + '" does not name this version (v' + version + ', app/package.json); nothing is released');
  const released = arg('--released');
  const tags = arg('--tags');
  if (released !== null || tags !== null) {
    const list = (v) => (v || '').split(/\s+/).filter(Boolean);
    const refusal = releaseRefusal(version, list(released), list(tags));
    if (refusal) fail(refusal);
  }
  console.log('stamp-build: tag ' + tag + ' matches the version' + (released !== null ? ', above every release published' : '') + (tags !== null ? ', above every other version tagged' : ''));
  process.exit(0);
}

const run = arg('--run');
const commit = String(arg('--commit') || '').toLowerCase();
const ref = arg('--ref') || '';
if (!/^[1-9]\d{0,8}$/.test(String(run))) fail('--run "' + run + '" is not a run number (a whole number from 1)');
if (!COMMIT.test(commit)) fail('--commit "' + commit + '" is not 7 to 64 hex digits');
const runBase = pkg.agmessage && Number.isInteger(pkg.agmessage.runBase) ? pkg.agmessage.runBase : 0;
if (runBase < 0) fail('agmessage.runBase in app/package.json is not a whole number');
const build = Number(run) - runBase;
if (build < 1) fail('run ' + run + ' is not past agmessage.runBase ' + runBase + '; nothing was stamped');
if (build > INSTALL_MAX.build) fail('build ' + build + ' is past ' + INSTALL_MAX.build + '; raise MAJOR or MINOR and set agmessage.runBase to the last run (app/package.json)');
if (!installVersionOf(version, build)) fail('the version ' + version + ' has a MAJOR or MINOR past ' + INSTALL_MAX.major + ', which an installer\'s version (MAJOR.MINOR.BUILD, as an MSI\'s ProductVersion carries it) cannot carry; nothing was stamped');
const channel = ref === 'refs/tags/v' + version ? 'release' : 'dev';
if (/^refs\/tags\//.test(ref) && channel !== 'release') fail('the tag ' + ref.slice(10) + ' does not name this version (v' + version + ')');

const repo = String(process.env.GITHUB_REPOSITORY || '');
if (repo && !REPO.test(repo)) fail('GITHUB_REPOSITORY "' + repo.slice(0, 120) + '" is not a repository (owner/name); nothing was stamped');
const stamp = { version, build, installVersion: installVersionOf(version, build), commit, channel, builtAt: new Date().toISOString(), ...(repo ? { repo } : {}) };
fs.writeFileSync(path.join(APP, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
const full = compose(version, stamp);
console.log('stamp-build: ' + full + ' (' + channel + ')');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### AGMessage ' + full + '\n\n' + channel + ' build ' + build + ' of ' + commit.slice(0, 7) + '\n\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'full=' + full + '\nchannel=' + channel + '\nbuild=' + build + '\n');
