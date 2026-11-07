#!/usr/bin/env node
'use strict';
/**
 * A release's provenance (the 0.6.0 plan's Part 6, unit U16): what the release job attests, verifies and reads back once
 * it has published, as commands its steps run; test/provenance.test.js holds them and the job to them.
 *
 *   node tools/provenance.js subjects [--dir <folder>]
 *       every file the release attests, one path a line: each of SUBJECTS matched among the files of <folder> (dist by
 *       default), by its name. Exit 0; 1 naming each subject no file matches, since a release without its zip, its
 *       installer or its payload's sums would attest less than it ships; 2 when the folder cannot be read; 64 for a
 *       word it does not know
 *   node tools/provenance.js immutable --release <answer.json> --repo <owner/name> --tag <vX.Y.Z>
 *       GitHub's answer for the release (GET /repos/{owner}/{repo}/releases/tags/{tag}, its REST API's shape) read for
 *       `immutable`: exit 0 with the words when the release is that tag, published and immutable; 1 with words that say
 *       what it is instead, and when immutable releases are off, what that costs and who turns them on; 2 when the
 *       answer cannot be read; 64 for a word it does not know
 *
 * Immutable releases are a setting of the repository, its owner's alone (Settings, the Releases section, Enable release
 * immutability), and apply to releases published after it is on. Nothing here changes a setting: the release is read as
 * GitHub publishes it, and a release that is not immutable is said, never taken for one. An installed AGMessage upgrades
 * with no administrator only to an immutable release (app/machine.js releaseJudged), whose assets cannot be modified or
 * deleted and whose tag cannot be moved, so its published digest stands in for a signature (answer 36: unsigned).
 *
 * Invariants: it starts no program; it requires Node's own modules; it writes nothing.
 */
const fs = require('fs');
const path = require('path');

/**
 * What the release attests, each a name pattern of the release's files ('*' any run of characters but a separator): the
 * zips (the portable folder's and the audit log's verifier), the installer, and SHA256SUMS.payload, through which the
 * attestation reaches every file the installer lays down. The release job's attest step names these, in this order.
 */
const SUBJECTS = Object.freeze([
  Object.freeze({ glob: '*.zip', what: 'the portable zip and the audit log\'s verifier' }),
  Object.freeze({ glob: 'AGMessage-Setup-*-unsigned.exe', what: 'the installer' }),
  Object.freeze({ glob: 'SHA256SUMS.payload', what: 'the SHA-256 of every file the installer lays down' }),
]);
/** The workflow the attestations are signed by: this repository's CI, whose release job attests. */
const SIGNER_WORKFLOW = '.github/workflows/ci.yml';

/** Whether a file's name matches a subject's pattern (pure): the whole name, '*' standing for any run of characters but '/' or '\'. */
function matches(glob, name) {
  const parts = String(glob).split('*');
  if (parts.length === 1) return name === glob;
  if (/[\\/]/.test(name) || !name.startsWith(parts[0]) || !name.endsWith(parts[parts.length - 1])) return false;
  let at = parts[0].length;
  const end = name.length - parts[parts.length - 1].length;
  for (const mid of parts.slice(1, -1)) {
    const i = name.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return at <= end;
}

/** The subjects among a folder's file names (pure): {files, missing}, `files` sorted by name, `missing` the subjects no name matches. */
function subjectsAmong(names) {
  const files = [...new Set(names)].filter((n) => SUBJECTS.some((s) => matches(s.glob, n))).sort();
  const missing = SUBJECTS.filter((s) => !files.some((n) => matches(s.glob, n)));
  return { files, missing };
}

/**
 * GitHub's answer for a release judged for immutability (pure): {ok, state, words}. `state` is 'immutable' (that tag,
 * published, `immutable: true`); 'mutable' (published, `immutable: false`: immutable releases were off when it was
 * published); 'unknown' (no `immutable` in the answer); 'draft'; or 'other' (not a release, or another tag's).
 */
function immutableJudged(rel, { repo, tag }) {
  const it = String(tag) + ' of ' + String(repo);
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return { ok: false, state: 'other', words: 'GitHub\'s answer for ' + it + ' is not a release, so whether it is immutable cannot be told: it is not taken for immutable.' };
  if (rel.tag_name !== tag) return { ok: false, state: 'other', words: 'GitHub answered for ' + String(rel.tag_name).slice(0, 40) + ', not ' + it + ': it is not taken for immutable.' };
  if (rel.draft === true) return { ok: false, state: 'draft', words: it + ' is still a draft: a draft is not immutable, and no installed AGMessage takes one.' };
  if (rel.immutable === true) return { ok: true, state: 'immutable', words: it + ' is published and immutable: its assets cannot be modified or deleted, and its tag cannot be moved, so the digest GitHub gives each asset stands for it, and an installed AGMessage may upgrade to it with no administrator.' };
  const cost = ', so its assets could still be replaced or deleted and its tag moved, and an AGMessage installed on a PC refuses it as a checked upgrade (Upgrade AGMessage… takes only an immutable release; an administrator can still run its installer).';
  const who = ' Immutable releases are the repository\'s setting, its owner\'s to turn on: Settings, the Releases section, Enable release immutability. A release published once it is on is immutable; this one stays as it was published.';
  if (rel.immutable === false) return { ok: false, state: 'mutable', words: it + ' is published, and it is not immutable: immutable releases are off for ' + String(repo) + cost + who };
  return { ok: false, state: 'unknown', words: 'GitHub\'s answer for ' + it + ' names no `immutable`: whether its assets can still be replaced cannot be told, so it is not taken for immutable' + cost + who };
}

/** The command line read: {verb, flags} or {problem}. */
function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const known = { subjects: ['--dir'], immutable: ['--release', '--repo', '--tag'] };
  if (!Object.hasOwn(known, verb || '')) return { problem: 'provenance: subjects [--dir <folder>] | immutable --release <answer.json> --repo <owner/name> --tag <vX.Y.Z>' };
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!known[verb].includes(a)) return { problem: '"' + a.slice(0, 40) + '" is not a word provenance ' + verb + ' takes' };
    if (Object.hasOwn(flags, a)) return { problem: a + ' is given twice' };
    if (i + 1 >= rest.length) return { problem: a + ' needs its value' };
    flags[a] = rest[++i];
  }
  return { verb, flags };
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.problem) { console.error(a.problem); return 64; }
  if (a.verb === 'subjects') {
    const dir = a.flags['--dir'] || 'dist';
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch (e) { console.error('provenance: ' + dir + ' could not be read (' + (e.code || e.message) + ')'); return 2; }
    const { files, missing } = subjectsAmong(names);
    if (missing.length) { console.error('provenance: ' + dir + ' holds no ' + missing.map((s) => s.glob + ' (' + s.what + ')').join(', ') + ': the release would attest less than it ships; nothing is attested'); return 1; }
    for (const f of files) console.log(path.join(dir, f));
    return 0;
  }
  if (!a.flags['--release'] || !a.flags['--repo'] || !a.flags['--tag']) { console.error('provenance: immutable needs --release, --repo and --tag'); return 64; }
  let rel;
  try { rel = JSON.parse(fs.readFileSync(a.flags['--release'], 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.error('provenance: GitHub\'s answer for ' + a.flags['--tag'] + ' could not be read (' + e.message + '): it is not taken for immutable'); return 2; }
  const judged = immutableJudged(rel, { repo: a.flags['--repo'], tag: a.flags['--tag'] });
  (judged.ok ? console.log : console.error)('provenance: ' + judged.words);
  return judged.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SUBJECTS, SIGNER_WORKFLOW, matches, subjectsAmong, immutableJudged, parseArgs, main };
