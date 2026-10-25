'use strict';
/**
 * AGMessage's version: one scheme, one source of truth.
 *
 *   package.json "version"   the product version, SemVer MAJOR.MINOR.PATCH, written there and nowhere else
 *   build.json               the stamp CI writes beside it (tools/stamp-build.js): the build number (the CI run number less
 *                            package.json's agmessage.runBase), the commit, and the channel
 *
 * The three channels and how each reads (SemVer 2.0, so any reader orders them right):
 *   release   a build of the tag v<version>               0.5.0+17.abc1234
 *   dev       a CI build of any other commit               0.5.0-dev.17+abc1234
 *   local     no stamp: a checkout or a hand-copied folder  0.5.0-dev+abc1234 (the commit read from .git, without the git
 *                                                           program), 0.5.0-dev outside a checkout
 * A dev or local build never reads as the release it leads to; a release names the build and commit it was made from.
 * A stamp that does not parse, or names another version, is ignored and the build reads as local: a wrong stamp never
 * passes for a release.
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

/** A stamp off disk, or null when it is not one for this version (pure). */
function readStamp(json, version) {
  if (!json || typeof json !== 'object') return null;
  if (json.version !== version || !CHANNELS.includes(json.channel)) return null;
  if (!Number.isInteger(json.build) || json.build < 1 || json.build > 65535) return null;
  if (!COMMIT.test(String(json.commit || ''))) return null;
  return { build: json.build, commit: json.commit, channel: json.channel, builtAt: typeof json.builtAt === 'string' ? json.builtAt.slice(0, 40) : '' };
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
  const info = stamp || { build: 0, commit: checkoutCommit(), channel: 'local', builtAt: '' };
  return Object.freeze({ version, ...info, full: compose(version, info) });
}

const BUILD = load();

module.exports = { BUILD, compose, readStamp, checkoutCommit, SEMVER, COMMIT };
