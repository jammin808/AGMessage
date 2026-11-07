#!/usr/bin/env node
'use strict';
/**
 * The installer's life cycle in CI (the 0.6.0 plan's Part 6, unit U16): what its job makes and checks around the
 * life cycle's tests (installer/test/*.test.js), each a command its steps run on windows-2025 and each held on Linux by
 * test/lifecycle.test.js.
 *
 *   node tools/lifecycle.js stage --from <stage> --to <folder> --as previous|broken
 *       a copy of a portable stage (the zip the package job built, extracted) laid at <folder>, which must not be there,
 *       its app\build.json stamped as another build of the same files: `previous`, the build an installer of this one
 *       upgrades (one build lower; at build 1, the highest build of the line below, its app\package.json naming that
 *       line's version); `broken`, the next build, whose server ends at once with code 1 (app\server.js is BROKEN_SERVER),
 *       so its start never proves itself and its installer goes back to the build before it. Prints the build it stamped
 *       ({full, installVersion}) as one line of JSON; exit 0, 2 when the stage cannot be read or written, 64 for a word it
 *       does not know
 *   node tools/lifecycle.js order --build <full> [--last <tag> --notes <file>]
 *       the release order: this build's install version (MAJOR.MINOR.BUILD) must be above the newest release's, read from
 *       the build its notes name on their first line ("Build <full>.", as the release job writes them), or an installed
 *       AGMessage of that release would refuse this build's installer. No release named: none yet, and nothing to order
 *       against. Exit 0 with the words, 1 refused with the words (a release whose notes name no build of its tag is
 *       refused, never passed over), 64 for a word it does not know
 *   node tools/lifecycle.js count --tap <file> [--summary <file>] <test file>...
 *       the executed count against the declared count: every test the files declare (a `test('…'` at a line's start) ran
 *       and passed, by its name, and nothing was skipped, left to do or cancelled; a file that skips, marks a test to do,
 *       runs only some, or nests a test or a suite is refused as it is read. Exit 0 with the counts, 1 refused, 2 when a
 *       file cannot be read, 64 for a word it does not know
 *
 * Invariants: it starts no program; it requires Node's own modules and app/lib/version.js; stage writes only inside the
 * folder it makes.
 */
const fs = require('fs');
const path = require('path');
const { compose, readStamp, parseBuild, compareBuilds, installVersionOf, INSTALL_MAX, SEMVER } = require(path.join(__dirname, '..', 'app', 'lib', 'version.js'));

/**
 * The broken build's server: it ends with code 1 before it holds anything, every time the watchdog starts it, so the
 * start never proves itself. The life cycle lays it in for the watchdog's give-up too.
 */
const BROKEN_SERVER = "'use strict';\n// The installer's life cycle's build that does not start (tools/lifecycle.js stage --as broken): its server ends at once\n// with code 1, before it holds a folder or a port, every time the watchdog starts it.\nprocess.exit(1);\n";

/** The build that comes before `version` and `build` by MAJOR.MINOR.BUILD (pure): one build lower, or at build 1 the line below's highest; null when none does. */
function previousOf(version, build) {
  const m = SEMVER.exec(String(version));
  if (!m || !Number.isInteger(build) || build < 1) return null;
  if (build > 1) return { version, build: build - 1 };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (minor > 0) return { version: major + '.' + (minor - 1) + '.0', build: INSTALL_MAX.build };
  if (major > 0) return { version: (major - 1) + '.' + INSTALL_MAX.minor + '.0', build: INSTALL_MAX.build };
  return null;
}
/** The build that comes after (pure): one build higher; null past what an installer's version carries. */
function nextOf(version, build) {
  if (!SEMVER.test(String(version)) || !Number.isInteger(build) || build < 1 || build >= INSTALL_MAX.build) return null;
  return { version, build: build + 1 };
}

/** A stamp for another build of the same files (pure): the commit, channel and repository kept, the build and install version its own. */
function stampAs(stamp, { version, build }, at = new Date().toISOString()) {
  return { ...stamp, version, build, installVersion: installVersionOf(version, build), builtAt: at };
}

/**
 * The stamp a stage's texts hold (pure): {version, stamp} from its app\package.json and app\build.json, or a thrown
 * Error with words. A local build has none, and makes no installer.
 */
function stageStamp(pkgText, buildText) {
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch { throw new Error('the stage\'s app\\package.json is not JSON'); }
  const version = String((pkg && pkg.version) || '');
  if (!SEMVER.test(version)) throw new Error('the stage\'s app\\package.json version "' + version.slice(0, 40) + '" is not MAJOR.MINOR.PATCH');
  let json;
  try { json = JSON.parse(buildText); } catch { json = null; /* not a stamp: refused below */ }
  const read = readStamp(json, version);
  if (!read || !read.installVersion) throw new Error('the stage is a local build of ' + version + ' (no stamp of its own in app\\build.json): it has no install version, so no build comes before or after it');
  return { version, pkg, stamp: json };
}

/** stage: the copy laid and stamped; {full, installVersion}, or a thrown Error with words. */
function stage({ from, to, as }) {
  if (as !== 'previous' && as !== 'broken') throw Object.assign(new Error('--as is "' + String(as).slice(0, 40) + '": previous or broken'), { usage: true });
  const src = path.resolve(from);
  const dest = path.resolve(to);
  const read = (rel) => fs.readFileSync(path.join(src, 'app', rel), 'utf8');
  const { version, pkg, stamp } = stageStamp(read('package.json'), read('build.json'));
  const asked = as === 'previous' ? previousOf(version, stamp.build) : nextOf(version, stamp.build);
  if (!asked) throw new Error(as === 'previous' ? 'no build comes before ' + version + ' build ' + stamp.build + ' by MAJOR.MINOR.BUILD' : 'no build comes after ' + version + ' build ' + stamp.build + ': raise MAJOR or MINOR (app/package.json)');
  let there = true;
  try { fs.lstatSync(dest); } catch { there = false; /* not there: it is made below */ }
  if (there) throw new Error(dest + ' is there already: a stage is laid only into a folder it makes');
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  const next = stampAs(stamp, asked);
  if (asked.version !== version) fs.writeFileSync(path.join(dest, 'app', 'package.json'), JSON.stringify({ ...pkg, version: asked.version }, null, 2) + '\n');
  fs.writeFileSync(path.join(dest, 'app', 'build.json'), JSON.stringify(next, null, 2) + '\n');
  if (as === 'broken') fs.writeFileSync(path.join(dest, 'app', 'server.js'), BROKEN_SERVER);
  return { full: compose(asked.version, next), installVersion: next.installVersion };
}

/** The build a release's notes name on their first line, as the release job writes them ("Build <full>. …") (pure): '' when they name none. */
function notesBuild(notes) {
  const first = String(notes || '').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const m = /^Build (\S+?)\.(?:\s|$)/.exec(first);
  return m ? m[1] : '';
}

/**
 * The release order (pure): '' when `full`'s install version is above the newest release's, else the words of why not.
 * `last` is that release's tag and the build its notes name ('' for no release yet). A release's build must be a release
 * build of the version its tag names.
 */
function orderRefusal(full, { tag = '', build = '' } = {}) {
  const me = parseBuild(String(full || ''));
  if (!me || !me.installVersion) return 'this build, "' + String(full).slice(0, 80) + '", has no install version (a local build, or not a build): no installer is made of it, so it has no place in the release order';
  if (!tag) return '';
  const want = /^v(\d+\.\d+\.\d+)$/.exec(String(tag));
  const last = parseBuild(String(build || ''));
  if (!want || !last || last.channel !== 'release' || last.version !== want[1]) {
    return 'the newest release, ' + String(tag).slice(0, 40) + ', names no release build of its own version on its notes\' first line ("Build <version>+<build>.<commit>."), so this build cannot be ordered against it: nothing is passed over unread';
  }
  if (compareBuilds(full, build) === 1) return '';
  return 'this build, ' + full + ' (install version ' + me.installVersion + '), is not above the newest release, ' + tag + ' (' + build + ', install version ' + last.installVersion + '), by MAJOR.MINOR.BUILD: an AGMessage installed from that release would refuse this build\'s installer as older or the same. Raise MAJOR or MINOR, or set agmessage.runBase (app/package.json) so the build numbers go on above that release\'s';
}

/** What a TAP name or a test's literal holds, its escapes read back (pure). */
const unescapeLiteral = (s) => s.replace(/\\(.)/g, '$1');
/** A test file's own refusals: what would let a declared test not run, or run without being counted at the top (pure). */
const NOT_COUNTED = [
  [/^\s*test\.(?:skip|todo|only)\b/m, 'a test skipped, left to do or run alone (test.skip, test.todo, test.only)'],
  [/\b(?:skip|todo|only)\s*:/, 'a test given skip, todo or only'],
  [/\bt\.(?:skip|todo)\s*\(/, 'a test that skips itself or marks itself to do (t.skip, t.todo)'],
  [/\bt\.test\s*\(/, 'a test nested in another (t.test): only a file\'s own tests are counted'],
  [/^\s*(?:describe|it|suite)\s*\(/m, 'a suite (describe, it, suite): only a file\'s own tests are counted'],
];

/**
 * The tests a file declares (pure): {names, refused}. A test is a `test('…'` at a line's start, its name the string
 * literal there; `refused` says what of the file would leave one uncounted.
 */
function declaredIn(text) {
  const src = String(text);
  const names = [...src.matchAll(/^test\(\s*'((?:[^'\\\n]|\\.)*)'/gm)].map((m) => unescapeLiteral(m[1]));
  const bare = (src.match(/^test\(/gm) || []).length;
  const refused = NOT_COUNTED.filter(([re]) => re.test(src)).map(([, words]) => words);
  if (bare !== names.length) refused.push((bare - names.length) + ' test(s) whose name is not a string literal, which cannot be matched to what ran');
  return { names, refused };
}

/** A TAP report read (pure): its summary's counts and the names of its top-level tests that passed and failed. */
function tapOf(text) {
  const counts = {};
  for (const m of String(text).matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) counts[m[1]] = Number(m[2]);
  const passed = [];
  const failed = [];
  for (const m of String(text).matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) {
    // A directive (" # SKIP", " # TODO") ends the name: a name's own "#" is written "\#".
    const at = m[2].search(/ # (?:SKIP|TODO)\b/);
    (m[1] === 'ok' ? passed : failed).push(unescapeLiteral((at < 0 ? m[2] : m[2].slice(0, at)).trimEnd()));
  }
  return { counts, passed, failed };
}

/**
 * The executed count against the declared (pure): {ok, words}. Every declared name ran and passed once, nothing ran that
 * was not declared, and the summary says as many tests as declared, all passed, none failed, skipped, left to do or
 * cancelled.
 */
function countJudged(declared, tap) {
  const names = declared.flatMap((d) => d.names);
  const refused = declared.flatMap((d) => d.refused.map((w) => d.file + ': ' + w));
  const c = tap.counts;
  const n = names.length;
  const counts = (c.pass ?? '?') + ' of ' + n + ' declared tests passed' + ' (' + ['tests', 'fail', 'skipped', 'todo', 'cancelled'].map((k) => k + ' ' + (c[k] ?? '?')).join(', ') + ')';
  const missing = names.filter((x) => tap.passed.filter((p) => p === x).length !== 1);
  const extra = tap.passed.filter((p) => !names.includes(p));
  const problems = [...refused];
  if (!n) problems.push('no test is declared');
  if (c.tests !== n || c.pass !== n || c.fail !== 0 || c.skipped !== 0 || c.todo !== 0 || c.cancelled !== 0) problems.push('the summary is not every declared test run and passed: ' + counts);
  if (missing.length) problems.push('not run and passed once: ' + missing.slice(0, 5).join(' | ') + (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : ''));
  if (extra.length) problems.push('ran and not declared: ' + extra.slice(0, 5).join(' | '));
  if (tap.failed.length) problems.push('failed: ' + tap.failed.slice(0, 5).join(' | ') + (tap.failed.length > 5 ? ' and ' + (tap.failed.length - 5) + ' more' : ''));
  if (problems.length) return { ok: false, words: 'The life cycle did not all run: ' + problems.join('; ') + '.' };
  return { ok: true, words: 'The life cycle: ' + n + ' of ' + n + ' declared tests ran and passed (' + declared.map((d) => d.file + ' ' + d.names.length).join(', ') + '); none failed, skipped, left to do or cancelled.' };
}

/** The command line read: {verb, flags, files} or {problem}. */
function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const known = { stage: ['--from', '--to', '--as'], order: ['--build', '--last', '--notes'], count: ['--tap', '--summary'] };
  if (!Object.hasOwn(known, verb || '')) return { problem: 'lifecycle: stage --from <stage> --to <folder> --as previous|broken | order --build <full> [--last <tag> --notes <file>] | count --tap <file> [--summary <file>] <test file>...' };
  const flags = {};
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { if (verb !== 'count') return { problem: '"' + a.slice(0, 80) + '" is not a word lifecycle ' + verb + ' takes' }; files.push(a); continue; }
    if (!known[verb].includes(a)) return { problem: a.slice(0, 40) + ' is not an option of lifecycle ' + verb };
    if (Object.hasOwn(flags, a)) return { problem: a + ' is given twice' };
    if (i + 1 >= rest.length) return { problem: a + ' needs its value' };
    flags[a] = rest[++i];
  }
  return { verb, flags, files };
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.problem) { console.error(a.problem); return 64; }
  if (a.verb === 'stage') {
    if (!a.flags['--from'] || !a.flags['--to'] || !a.flags['--as']) { console.error('lifecycle: stage needs --from, --to and --as'); return 64; }
    try { console.log(JSON.stringify(stage({ from: a.flags['--from'], to: a.flags['--to'], as: a.flags['--as'] }))); return 0; } catch (e) {
      console.error('lifecycle: ' + e.message + '; nothing was stamped');
      return e.usage ? 64 : 2;
    }
  }
  if (a.verb === 'order') {
    if (!a.flags['--build'] || (a.flags['--last'] !== undefined) !== (a.flags['--notes'] !== undefined)) { console.error('lifecycle: order needs --build, and --last with --notes or neither'); return 64; }
    let build = '';
    if (a.flags['--last']) {
      try { build = notesBuild(fs.readFileSync(a.flags['--notes'], 'utf8')); } catch (e) { console.error('lifecycle: the newest release\'s notes could not be read (' + e.message + '): the release order cannot be told'); return 1; }
    }
    const why = orderRefusal(a.flags['--build'], { tag: a.flags['--last'] || '', build });
    if (why) { console.error('lifecycle: ' + why + '.'); return 1; }
    console.log('lifecycle: ' + a.flags['--build'] + ' is above ' + (a.flags['--last'] ? 'the newest release, ' + a.flags['--last'] + ' (' + build + ')' : 'every release (none is published yet)') + ' by MAJOR.MINOR.BUILD.');
    return 0;
  }
  if (!a.flags['--tap'] || !a.files.length) { console.error('lifecycle: count needs --tap <file> and the test files'); return 64; }
  let declared;
  let tap;
  try {
    declared = a.files.map((file) => ({ file: path.basename(file), ...declaredIn(fs.readFileSync(file, 'utf8')) }));
    tap = tapOf(fs.readFileSync(a.flags['--tap'], 'utf8'));
  } catch (e) { console.error('lifecycle: ' + e.message); return 2; }
  const judged = countJudged(declared, tap);
  (judged.ok ? console.log : console.error)(judged.words);
  if (a.flags['--summary']) {
    try { fs.appendFileSync(a.flags['--summary'], '### The installer\'s life cycle\n\n' + (judged.ok ? '' : '**Refused.** ') + judged.words + '\n\n'); } catch (e) { console.error('lifecycle: the summary could not be written (' + e.message + ')'); }
  }
  return judged.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { BROKEN_SERVER, previousOf, nextOf, stampAs, stageStamp, stage, notesBuild, orderRefusal, declaredIn, tapOf, countJudged, parseArgs, main };
