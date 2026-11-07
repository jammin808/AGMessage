#!/usr/bin/env node
'use strict';
/**
 * What the installer is compiled from (installer/build-installer.ps1, installer/AGMessage.iss): the defines, read from a
 * portable stage (tools/build-portable.ps1's dist\AGMessage, or the zip extracted) by app/lib/version.js's rules from its
 * app\package.json and app\build.json; and which of the stage's files the installer leaves out (the portable folder's two
 * .bat files, which the installed node has no use for: it has no window and no clean copy).
 *
 *   node tools/installer-defines.js <stage>
 *       prints {SemVer, Build, InstallVersion, FileVersion, Full, Label, LeftOut} as one line of JSON, exit 0; a local build
 *       (no stamp, or a stamp that is not this version's) or a stage without what the installer runs is refused with
 *       words on stderr, exit 1: its installer would have no install version, so it could not be upgraded in order
 */
const fs = require('fs');
const path = require('path');
const { compose, readStamp, SEMVER } = require(path.join(__dirname, '..', 'app', 'lib', 'version.js'));

/** The stage's files the installer leaves out: the portable folder's own. */
const LEFT_OUT = Object.freeze(['start-agmessage.bat', 'make-shareable-copy.bat']);
/** What the installer runs or names from the stage (its checks, the server task, the Start menu, the notices). */
const NEEDED = Object.freeze([
  'node/node.exe', 'bin/cloudflared.exe', 'app/machine.js', 'app/launch.js', 'app/supervise.js', 'app/server.js', 'app/package.json',
  'app/build.json', 'README.txt', 'THIRD-PARTY-NOTICES.md', 'licenses/nodejs/LICENSE', 'licenses/cloudflared/LICENSE',
]);

/**
 * The defines for a stage's package.json and build.json texts (pure): {SemVer, Build, InstallVersion, FileVersion, Full,
 * Label, LeftOut}, or a thrown Error with words. Label is the zip's (a release's version; a CI build's full build with its
 * + written _), so the installer's name says which build it is as the zip's does.
 */
function definesOf(pkgText, buildText) {
  const pkg = JSON.parse(pkgText);
  const version = String(pkg.version || '');
  if (!SEMVER.test(version)) throw new Error('the stage\'s app\\package.json version "' + version + '" is not MAJOR.MINOR.PATCH');
  let json;
  try { json = buildText === null ? null : JSON.parse(buildText); } catch { json = null; /* not a stamp: refused below */ }
  const stamp = readStamp(json, version);
  if (!stamp || !stamp.installVersion) throw new Error('an installer is made from a numbered build only (tools/stamp-build.js in CI): this stage is a local build of ' + version + ', which has no install version, so it could not be upgraded in order');
  const full = compose(version, stamp);
  return {
    SemVer: version,
    Build: String(stamp.build),
    InstallVersion: stamp.installVersion,
    FileVersion: version + '.' + stamp.build,
    Full: full,
    Label: stamp.channel === 'release' ? version : full.replace(/\+/g, '_'),
    LeftOut: [...LEFT_OUT],
  };
}

/** The defines of the stage at `dir`, with what it lacks of NEEDED refused. */
function stageDefines(dir) {
  const missing = NEEDED.filter((f) => !fs.existsSync(path.join(dir, ...f.split('/'))));
  if (missing.length) throw new Error(dir + ' is not a whole portable stage: it lacks ' + missing.join(', '));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, ...f.split('/')), 'utf8'); } catch { return null; /* not there: said by definesOf */ } };
  return definesOf(read('app/package.json'), read('app/build.json'));
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('installer-defines takes one folder: the portable stage');
    process.stdout.write(JSON.stringify(stageDefines(process.argv[2])) + '\n');
  } catch (e) {
    process.stderr.write('installer-defines: ' + e.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { definesOf, stageDefines, LEFT_OUT, NEEDED };
