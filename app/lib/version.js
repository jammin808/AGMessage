'use strict';
/**
 * AGMessage's version: one scheme, one source of truth.
 *
 *   package.json "version"   the product version, SemVer MAJOR.MINOR.PATCH, written there and nowhere else
 *   build.json               the stamp CI writes beside it (tools/stamp-build.js): the build number (the CI run number less
 *                            package.json's agmessage.runBase), the install version (MAJOR.MINOR.BUILD), the commit, and
 *                            the channel
 *
 * The three channels and how each reads (SemVer 2.0, so any reader orders them right):
 *   release   a build of the tag v<version>               0.5.0+17.abc1234
 *   dev       a CI build of any other commit               0.5.0-dev.17+abc1234
 *   local     no stamp: a checkout or a hand-copied folder  0.5.0-dev+abc1234 (the commit read from .git, without the git
 *                                                           program), 0.5.0-dev outside a checkout
 * A dev or local build never reads as the release it leads to; a release names the build and commit it was made from.
 * A stamp that does not parse, or names another version, is ignored and the build reads as local: a wrong stamp never
 * passes for a release.
 *
 * "Newer" is one rule across the show network, PlayMap's: MAJOR.MINOR.BUILD, the install version a stamp carries
 * (`installVersion`: MAJOR and MINOR up to 255 and BUILD up to 65535, as an MSI's ProductVersion carries them; a Windows
 * file version takes 65535 in each). A local build has none, and is ordered against nothing. Among releases this order
 * and SemVer's agree, because a release is published only when its SemVer is above every release before it and every
 * other version tagged (`releaseRefusal`, the release job's check): a 0.6.0 built after 0.6.1 is newer by its build
 * number, and never released; and since build numbers are given in the order tags are pushed, a release published later
 * than another always carries the higher build. Development builds of one MAJOR.MINOR order by their build number alone,
 * whichever PATCH they name.
 */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const SEMVER = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const CHANNELS = ['release', 'dev'];

/** The informational version for a stamp (pure). */
function compose(version, { build = 0, commit = '', channel = 'local' } = {}) {
  const short = COMMIT.test(commit) ? commit.slice(0, 7) : '';
  if (channel === 'release') return version + '+' + build + (short ? '.' + short : '');
  if (channel === 'dev') return version + '-dev.' + build + (short ? '+' + short : '');
  return version + '-dev' + (short ? '+' + short : '');
}

/** The most each part of an install version may be: an MSI's ProductVersion, 255.255.65535. */
const INSTALL_MAX = Object.freeze({ major: 255, minor: 255, build: 65535 });
/**
 * MAJOR.MINOR.BUILD for a version and its build number: the install version; '' for a local build, which has none, and
 * for a version or build past what an installer's version carries (INSTALL_MAX) (pure).
 */
function installVersionOf(version, build) {
  const m = SEMVER.exec(String(version));
  if (!m || Number(m[1]) > INSTALL_MAX.major || Number(m[2]) > INSTALL_MAX.minor) return '';
  return Number.isInteger(build) && build >= 1 && build <= INSTALL_MAX.build ? m[1] + '.' + m[2] + '.' + build : '';
}

/** A stamp off disk, or null when it is not one for this version, or its install version is not its own (pure). */
function readStamp(json, version) {
  if (!json || typeof json !== 'object') return null;
  if (json.version !== version || !CHANNELS.includes(json.channel)) return null;
  if (!Number.isInteger(json.build) || json.build < 1 || json.build > 65535) return null;
  if (!json.installVersion || json.installVersion !== installVersionOf(version, json.build)) return null;
  if (!COMMIT.test(String(json.commit || ''))) return null;
  return { build: json.build, installVersion: json.installVersion, commit: json.commit, channel: json.channel, builtAt: typeof json.builtAt === 'string' ? json.builtAt.slice(0, 40) : '' };
}

/** A build number as a composed build carries it, and the short commit beside it. */
const NUMBER = /^[1-9]\d{0,4}$/;
const SHORT = /^[0-9a-f]{7}$/;
/**
 * A composed build read back: {version, channel, build, installVersion, commit}, `build` 0 and `installVersion` '' for a
 * local one; null when it is not a build as `compose` writes one (release `0.6.0+32.abc1234`, dev
 * `0.6.0-dev.31+abc1234`, local `0.6.0-dev+abc1234`, each commit optional) (pure).
 */
function parseBuild(full) {
  if (typeof full !== 'string' || full.length > 80) return null;
  const plus = full.indexOf('+');
  const head = plus < 0 ? full : full.slice(0, plus);
  const tail = plus < 0 ? null : full.slice(plus + 1);
  const dash = head.indexOf('-');
  const version = dash < 0 ? head : head.slice(0, dash);
  const pre = dash < 0 ? null : head.slice(dash + 1);
  if (!SEMVER.test(version)) return null;
  let channel = 'local', build = 0, commit;
  if (pre === null) {
    const [b, c, ...more] = tail === null ? [] : tail.split('.');
    if (more.length || !NUMBER.test(b || '') || (c !== undefined && !SHORT.test(c))) return null;
    channel = 'release'; build = Number(b); commit = c || '';
  } else {
    if (pre.startsWith('dev.') && NUMBER.test(pre.slice(4))) { channel = 'dev'; build = Number(pre.slice(4)); } else if (pre !== 'dev') return null;
    if (tail !== null && !SHORT.test(tail)) return null;
    commit = tail || '';
  }
  if (build > 65535) return null;
  return { version, channel, build, installVersion: installVersionOf(version, build), commit };
}

/**
 * Which of two composed builds is newer, by MAJOR.MINOR.BUILD: 1 when `a` is, -1 when `b` is, 0 for the same install
 * version; null when either is a local build (no build number) or not a build (pure).
 */
function compareBuilds(a, b) {
  const x = parseBuild(a), y = parseBuild(b);
  if (!x || !y || !x.installVersion || !y.installVersion) return null;
  const p = x.installVersion.split('.').map(Number), q = y.installVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] > q[i] ? 1 : -1;
  return 0;
}

/** SemVer precedence of two MAJOR.MINOR.PATCH versions: 1, -1 or 0 (pure). */
function compareVersions(a, b) {
  const p = String(a).split('.').map(Number), q = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] > q[i] ? 1 : -1;
  return 0;
}

/** The highest version among tags (`v` and MAJOR.MINOR.PATCH): {last}, or {bad} naming the first tag that is not one. */
function highest(tags) {
  let last = '';
  for (const tag of tags) {
    const v = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
    if (!SEMVER.test(v)) return { bad: String(tag) };
    if (!last || compareVersions(v, last) > 0) last = v;
  }
  return { last };
}

/**
 * The release order: why a release of `version` is refused, or '' when its SemVer is above every release already
 * published (`released`, their tags) and every other version tag the repository holds (`tags`, its own `v<version>` left
 * out), published or not: a tag pushed is given its build number then, so an older version tagged after a newer one
 * would carry the higher build. A tag that names no version is refused by its name, never passed over: the order cannot
 * be told past it (pure).
 */
function releaseRefusal(version, released, tags = []) {
  if (!SEMVER.test(String(version))) return 'the version "' + version + '" is not MAJOR.MINOR.PATCH';
  const done = highest(released);
  if (done.bad !== undefined) return 'the published release "' + done.bad + '" names no version (v and MAJOR.MINOR.PATCH), so the release order cannot be told; nothing is released';
  if (done.last && compareVersions(version, done.last) <= 0) return 'v' + version + ' is not above the last release, v' + done.last + ': a release\'s version is always above every one before it (raise app/package.json\'s version); nothing is released';
  const pushed = highest(tags.filter((t) => t !== 'v' + version));
  if (pushed.bad !== undefined) return 'the tag "' + pushed.bad + '" names no version (v and MAJOR.MINOR.PATCH), so the release order cannot be told (delete it if it names no release); nothing is released';
  if (pushed.last && compareVersions(version, pushed.last) <= 0) return 'v' + version + ' is not above the tag v' + pushed.last + ', which the repository holds: a release is published only above every version tagged, released yet or not, so a later one always carries the higher build (delete that tag if it names no release); nothing is released';
  return '';
}

/** The commit a checkout is on, read from its .git without the git program; '' when there is none. */
function checkoutCommit(start = APP_DIR) {
  try {
    let dir = start;
    for (let i = 0; i < 4; i++) {
      const git = path.join(dir, '.git');
      if (fs.existsSync(git)) {
        const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
        if (COMMIT.test(head)) return head;
        const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head);
        if (!ref) return '';
        const loose = path.join(git, ...ref[1].split('/'));
        if (fs.existsSync(loose)) { const c = fs.readFileSync(loose, 'utf8').trim(); return COMMIT.test(c) ? c : ''; }
        const packed = path.join(git, 'packed-refs');
        if (!fs.existsSync(packed)) return '';
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(' ');
          if (name === ref[1] && COMMIT.test(sha)) return sha;
        }
        return '';
      }
      dir = path.dirname(dir);
    }
  } catch { /* no checkout: a local build without a commit */ }
  return '';
}

function load() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const version = String(pkg.version || '');
  if (!SEMVER.test(version)) throw new Error('package.json version "' + version + '" is not MAJOR.MINOR.PATCH');
  let stamp = null;
  try { stamp = readStamp(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'build.json'), 'utf8')), version); } catch { /* not stamped */ }
  const info = stamp || { build: 0, installVersion: '', commit: checkoutCommit(), channel: 'local', builtAt: '' };
  return Object.freeze({ version, ...info, full: compose(version, info) });
}

const BUILD = load();

module.exports = { BUILD, compose, readStamp, checkoutCommit, installVersionOf, parseBuild, compareBuilds, compareVersions, releaseRefusal, INSTALL_MAX, SEMVER, COMMIT };
