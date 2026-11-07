'use strict';
// A release's provenance (the 0.6.0 plan's Part 6, unit U16): what the release job attests (the zips, the installer and
// SHA256SUMS.payload, tools/provenance.js SUBJECTS), its own check of each attestation with gh attestation verify before
// it publishes, and its read of the published release for `immutable`, which an installed AGMessage's checked upgrade
// takes as a signature's stand-in (app/machine.js releaseJudged). Immutable releases are the repository's own setting, its
// owner's to turn on: nothing here changes one, and a release published while it is off is said plainly, never taken
// for immutable.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const P = require('../../tools/provenance.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RELEASE = () => JSON.parse(h.readSource('app/test/fixtures/github-release.json'));
const REPO = 'jammin808/AGMessage';
const runTool = (args) => childProcess.spawnSync(process.execPath, [path.join(h.REPO, 'tools', 'provenance.js'), ...args], { encoding: 'utf8', timeout: 60000 });

/** A job of ci.yml, its lines from its name to the next job's. */
function job(ci, name) {
  const start = ci.indexOf('\n  ' + name + ':\n');
  assert.ok(start > 0, name + ' is a job');
  const rest = ci.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

test('the subjects: the zips, the installer and SHA256SUMS.payload, matched by their names among the release\'s files; a subject that matches none refuses, so nothing ships unattested', () => {
  assert.deepEqual(P.SUBJECTS.map((s) => s.glob), ['*.zip', 'AGMessage-Setup-*-unsigned.exe', 'SHA256SUMS.payload']);
  assert.ok(P.matches('AGMessage-Setup-*-unsigned.exe', 'AGMessage-Setup-0.6.1-unsigned.exe'));
  assert.ok(P.matches('AGMessage-Setup-*-unsigned.exe', 'AGMessage-Setup-0.6.0-dev.41_abcdef1-unsigned.exe'));
  assert.ok(!P.matches('AGMessage-Setup-*-unsigned.exe', 'AGMessage-Setup-0.6.1-signed.exe'));
  assert.ok(!P.matches('*.zip', 'sub/AGMessage-Portable-0.6.1.zip'), 'a name, never a path');
  assert.ok(!P.matches('SHA256SUMS.payload', 'SHA256SUMS'));
  assert.ok(P.matches('a*b*c', 'abc') && P.matches('a*b*c', 'aXbYc') && !P.matches('a*b*c', 'acb'));
  // The release's own files: all but the SBOM and SHA256SUMS are attested (SHA256SUMS lists the SBOM's digest, and itself
  // only names what the attested files are).
  const names = RELEASE().assets.map((a) => a.name).concat('agmessage-audit-verifier-0.6.1.zip');
  assert.deepEqual(P.subjectsAmong(names), { files: ['AGMessage-Portable-0.6.1.zip', 'AGMessage-Setup-0.6.1-unsigned.exe', 'SHA256SUMS.payload', 'agmessage-audit-verifier-0.6.1.zip'], missing: [] });
  assert.deepEqual(P.subjectsAmong(['AGMessage-Portable-0.6.1.zip', 'SHA256SUMS']).missing.map((s) => s.what), ['the installer', 'the SHA-256 of every file the installer lays down']);
  // Its command, over a folder as the release job's dist holds it.
  const dir = tmp('agm-prov-');
  for (const n of ['AGMessage-Portable-0.6.1.zip', 'agmessage-audit-verifier-0.6.1.zip', 'AGMessage-Setup-0.6.1-unsigned.exe', 'SHA256SUMS.payload', 'agmessage-sbom.cdx.json', 'SHA256SUMS']) fs.writeFileSync(path.join(dir, n), n);
  fs.mkdirSync(path.join(dir, 'a-folder.zip'));
  const r = runTool(['subjects', '--dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => path.basename(l)), ['AGMessage-Portable-0.6.1.zip', 'AGMessage-Setup-0.6.1-unsigned.exe', 'SHA256SUMS.payload', 'agmessage-audit-verifier-0.6.1.zip'], 'files alone, by their names');
  fs.rmSync(path.join(dir, 'AGMessage-Setup-0.6.1-unsigned.exe'));
  const missing = runTool(['subjects', '--dir', dir]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /holds no AGMessage-Setup-\*-unsigned\.exe \(the installer\): the release would attest less than it ships; nothing is attested/);
  assert.equal(runTool(['subjects', '--dir', path.join(dir, 'none')]).status, 2);
  assert.equal(runTool(['subjects', '--folder', dir]).status, 64);
  assert.equal(runTool(['sign']).status, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('immutable: GitHub\'s answer for the release read for itself, its tag, published and immutable; a release published while immutable releases are off is said plainly, with what it costs and who turns them on, never taken for immutable', () => {
  const tag = 'v0.6.1';
  const judged = (change) => { const rel = RELEASE(); change(rel); return P.immutableJudged(rel, { repo: REPO, tag }); };
  const yes = judged(() => {});
  assert.deepEqual([yes.ok, yes.state], [true, 'immutable']);
  assert.match(yes.words, /^v0\.6\.1 of jammin808\/AGMessage is published and immutable: its assets cannot be modified or deleted, and its tag cannot be moved/);
  const off = judged((r) => { r.immutable = false; });
  assert.deepEqual([off.ok, off.state], [false, 'mutable']);
  assert.match(off.words, /^v0\.6\.1 of jammin808\/AGMessage is published, and it is not immutable: immutable releases are off for jammin808\/AGMessage, so its assets could still be replaced or deleted and its tag moved, and an AGMessage installed on a PC refuses it as a checked upgrade/);
  assert.match(off.words, /Immutable releases are the repository's setting, its owner's to turn on: Settings, the Releases section, Enable release immutability\. A release published once it is on is immutable; this one stays as it was published\.$/);
  assert.deepEqual([judged((r) => { delete r.immutable; }).state, judged((r) => { r.immutable = 'true'; }).state], ['unknown', 'unknown'], 'no field, or one that is no boolean, is not immutable');
  assert.match(judged((r) => { delete r.immutable; }).words, /names no `immutable`: whether its assets can still be replaced cannot be told, so it is not taken for immutable/);
  assert.equal(judged((r) => { r.draft = true; }).state, 'draft');
  assert.equal(judged((r) => { r.tag_name = 'v0.6.0'; }).state, 'other');
  assert.equal(P.immutableJudged([], { repo: REPO, tag }).state, 'other');
  assert.equal(P.immutableJudged(null, { repo: REPO, tag }).ok, false);
  // The same answer as an installed AGMessage's checked upgrade judges it: the release job passes no release the upgrade
  // would refuse for its immutability, and fails each one it would.
  const asked = { repo: REPO, semver: '0.6.1', name: 'AGMessage-Setup-0.6.1-unsigned.exe' };
  for (const change of [() => {}, (r) => { r.immutable = false; }, (r) => { delete r.immutable; }]) {
    const rel = RELEASE();
    change(rel);
    const upgrade = machine.releaseJudged(rel, asked);
    assert.equal(P.immutableJudged(rel, { repo: REPO, tag }).ok, upgrade.why !== 'immutable' && !!upgrade.asset, JSON.stringify(upgrade.why || 'taken'));
  }
  // Its command: exit 0 immutable, 1 said, 2 unread, 64 asked wrongly.
  const dir = tmp('agm-imm-');
  const file = path.join(dir, 'release.json');
  fs.writeFileSync(file, JSON.stringify(RELEASE()));
  const ok = runTool(['immutable', '--release', file, '--repo', REPO, '--tag', tag]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^provenance: v0\.6\.1 of jammin808\/AGMessage is published and immutable/);
  fs.writeFileSync(file, JSON.stringify({ ...RELEASE(), immutable: false }));
  const no = runTool(['immutable', '--release', file, '--repo', REPO, '--tag', tag]);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /^provenance: v0\.6\.1 of jammin808\/AGMessage is published, and it is not immutable/);
  fs.writeFileSync(file, 'not json');
  assert.equal(runTool(['immutable', '--release', file, '--repo', REPO, '--tag', tag]).status, 2);
  assert.equal(runTool(['immutable', '--release', file, '--repo', REPO]).status, 64);
  assert.equal(runTool(['immutable', '--release', file, '--repo', REPO, '--tag', tag, '--tag', tag]).status, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the release job: the subjects listed, then attested as tools/provenance.js names them, each verified with gh attestation verify before anything is published, and the published release read back for its immutability, failing the job when it is not', () => {
  const ci = h.readSource('.github/workflows/ci.yml');
  const release = job(ci, 'release');
  assert.match(release, /\n {6}id-token: write\n {6}attestations: write\n/, 'it may attest');
  // The job that attests runs only actions pinned by their commit, as the life cycle's and the lane's do, and keeps no
  // credential of its checkout's.
  const uses = [...release.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
  assert.ok(uses.length >= 6, uses.length + ' actions');
  for (const [, ref, comment] of uses) assert.match(ref + comment, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, ref + ' is pinned by its commit');
  assert.ok(uses.some(([, ref]) => ref.startsWith('actions/attest-build-provenance@')), 'the attestation\'s action among them');
  assert.match(release, /- uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}persist-credentials: false\n/);
  const sparse = release.slice(release.indexOf('sparse-checkout: |'), release.indexOf('sparse-checkout-cone-mode'));
  assert.ok(sparse.split('\n').some((l) => l.trim() === 'tools/provenance.js'), 'its tool is checked out');
  const listed = release.indexOf('node tools/provenance.js subjects --dir dist\n');
  const attest = release.indexOf('uses: actions/attest-build-provenance@');
  const verify = release.indexOf('name: Verify the release\'s own attestations (gh attestation verify)');
  const publish = release.indexOf('gh release create');
  const immutable = release.indexOf('name: The release is immutable (tools/provenance.js immutable)');
  assert.ok(release.indexOf('--check-tag') < listed && listed < attest && attest < verify && verify < publish && publish < immutable, 'the order, then the subjects, the attestation, its check, the release, its read back');
  const after = release.slice(release.indexOf('subject-path: |\n', attest) + 'subject-path: |\n'.length).split('\n');
  const named = after.slice(0, after.findIndex((l) => !l.startsWith(' '.repeat(12)))).map((l) => l.trim());
  assert.deepEqual(named, P.SUBJECTS.map((s) => 'dist/' + s.glob), 'the subjects tools/provenance.js names, one a line, in its order');
  // Each subject is a file the release publishes.
  const files = /--generate-notes (.*)\n/.exec(release)[1].split(' ');
  for (const s of P.SUBJECTS) assert.ok(files.includes('dist/' + s.glob), s.glob + ' is published');
  // The attestation covers the installer: the plan's item, the release job's.
  assert.ok(named.includes('dist/AGMessage-Setup-*-unsigned.exe') && named.includes('dist/SHA256SUMS.payload'));
  const check = release.slice(verify, publish);
  assert.match(check, /node tools\/provenance\.js subjects --dir dist > "\$RUNNER_TEMP\/subjects\.txt"\n/);
  assert.match(check, /gh attestation verify "\$f" --repo "\$GITHUB_REPOSITORY" --signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/ci\.yml" \\\n\s+--source-ref "\$GITHUB_REF" --source-digest "\$GITHUB_SHA" --deny-self-hosted-runners \\\n\s+\|\| \{ echo "::error::\$f does not verify against this release's attestation"; exit 1; \}\n\s+done < "\$RUNNER_TEMP\/subjects\.txt"/);
  assert.match(release.slice(release.indexOf('name: Publish the release'), publish), /check a download with gh attestation verify <file> -R \$GITHUB_REPOSITORY\./, 'the notes give the command to check a download');
  assert.equal(P.SIGNER_WORKFLOW, '.github/workflows/ci.yml');
  assert.ok(fs.existsSync(path.join(h.REPO, P.SIGNER_WORKFLOW)), 'the workflow named is this one');
  const back = release.slice(immutable);
  assert.match(back, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$GITHUB_REF_NAME" > "\$RUNNER_TEMP\/release\.json"\n/);
  assert.match(back, /if node tools\/provenance\.js immutable --release "\$RUNNER_TEMP\/release\.json" --repo "\$GITHUB_REPOSITORY" --tag "\$GITHUB_REF_NAME" 2> "\$RUNNER_TEMP\/immutable\.txt"; then/);
  assert.match(back, /echo "::error::\$words"\n[^\n]*\n\s+exit 1\n/, 'said plainly, and the job fails');
  // Nothing of its provenance may fail and let the release pass (the readings' download alone may: they never hold it).
  assert.ok(!/continue-on-error/.test(release.slice(listed, release.indexOf('# The lane\'s readings, when it wrote them'))), 'the subjects, the attestation and its check');
  assert.ok(!/continue-on-error/.test(back), 'the read back');
  // Nothing in CI changes a repository setting: immutable releases are the owner's to turn on.
  assert.ok(!/immutable-releases|--method (?:PUT|PATCH|POST)|-X (?:PUT|PATCH|POST)/.test(ci), 'no call that changes a setting');
});
