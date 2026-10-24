#!/usr/bin/env node
'use strict';
/**
 * Stamps a CI build (app/build.json) and checks a release tag against the version. One scheme: app/lib/version.js.
 *
 *   node tools/stamp-build.js --run <github.run_number> --commit <github.sha> [--ref <github.ref>]
 *       writes app/build.json; the channel is "release" for the ref refs/tags/v<version>, "dev" for anything else
 *   node tools/stamp-build.js --check-tag <tag>
 *       fails unless the tag is v<package.json version>: a release is never built from a tag that names another version
 *   node tools/stamp-build.js --print
 *       prints the version this tree reads as (local builds included)
 *
 * The build number is the run number less package.json's agmessage.runBase, 1 to 65535 (a Windows file version's part);
 * outside that range nothing is written and the step fails with words. Raise the version's MAJOR or MINOR and set runBase
 * to the last run's number to start the count again at 1.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const { compose, SEMVER, COMMIT, BUILD } = require(path.join(APP, 'lib', 'version.js'));

function fail(words) { console.error('stamp-build: ' + words); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? String(process.argv[i + 1] || '') : null; }

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
if (!SEMVER.test(version)) fail('package.json version "' + version + '" is not MAJOR.MINOR.PATCH');

if (process.argv.includes('--print')) { console.log(BUILD.full); process.exit(0); }

const tag = arg('--check-tag');
if (tag !== null) {
  if (tag !== 'v' + version) fail('the tag "' + tag + '" does not name this version (v' + version + ', app/package.json); nothing is released');
  console.log('stamp-build: tag ' + tag + ' matches the version');
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
if (build > 65535) fail('build ' + build + ' is past 65535; raise MAJOR or MINOR and set agmessage.runBase to the last run (app/package.json)');
const channel = ref === 'refs/tags/v' + version ? 'release' : 'dev';
if (/^refs\/tags\//.test(ref) && channel !== 'release') fail('the tag ' + ref.slice(10) + ' does not name this version (v' + version + ')');

const stamp = { version, build, commit, channel, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(APP, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
const full = compose(version, stamp);
console.log('stamp-build: ' + full + ' (' + channel + ')');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### AGMessage ' + full + '\n\n' + channel + ' build ' + build + ' of ' + commit.slice(0, 7) + '\n\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'full=' + full + '\nchannel=' + channel + '\nbuild=' + build + '\n');
