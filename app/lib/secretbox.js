'use strict';
/**
 * This machine's key, and what it keys. Saved keys (the Stagewatch key, the Anthropic key) are encrypted at rest:
 * AES-256-GCM with a random machine key kept OUTSIDE the app folder (%LOCALAPPDATA%\AGMessage\machine.key, or
 * ~/.agmessage on other systems), so a copied or zipped AGMessage folder — data/ included — carries no usable key. It is
 * not a defence against someone who already controls this Windows account; it is a defence against the folder travelling.
 * The audit log's keys are derived from it (`derive`, `signingKey`): never stored, the same for as long as the machine key
 * is.
 *
 * The machine key is never replaced. A missing file is made once and published whole (a whole temporary file hard-linked
 * into place, which fails when another start made one first: that one is read instead). Any other read error, a file
 * that is not a key, or a key folder that cannot publish one makes this run keyless: nothing is sealed, `open()` returns
 * '', `derive()` throws, and the file is left as it is.
 *
 * Stored form: "enc1:" + base64(iv(12) | tag(16) | ciphertext).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./resilience');

const PREFIX = 'enc1:';
// The labels a key may be derived for, each for one use: any other label throws.
const SIGN = 'agmessage audit sign v1';
const LABELS = new Set(['agmessage audit entry v1', 'agmessage audit head v1', SIGN]);
// The PKCS#8 wrapping of a 32-byte Ed25519 seed (RFC 8410 §7): the same 16 bytes generateKeyPairSync('ed25519') exports.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyDir() {
  if (process.env.AGM_KEY_DIR) return process.env.AGM_KEY_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'AGMessage');
  return path.join(os.homedir(), '.agmessage');
}

let cached = null;    // the machine key, once read or made
let problem = null;   // why this run has none: {code, words}
const derived = new Map();

const noKey = (p) => Object.assign(new Error(p.words), { code: p.code, noKey: true });
/** The key a file holds (base64 of 32 bytes), or null. */
const keyOf = (buf) => { const k = Buffer.from(buf.toString('utf8').trim(), 'base64'); return k.length === 32 ? k : null; };
const readKey = (file) => fs.readFileSync(file);

function machineKey() {
  if (cached) return cached;
  if (problem) throw noKey(problem);
  const dir = keyDir();
  const file = path.join(dir, 'machine.key');
  const fail = (code, words) => { problem = { code, words }; throw noKey(problem); };
  const take = (buf) => keyOf(buf) || fail('EBADKEY', 'the machine key at ' + file + ' is not a key (it is left as it is)');
  try { return (cached = take(readKey(file))); } catch (e) {
    if (e.noKey) throw e;
    if (e.code !== 'ENOENT') fail(e.code || 'EIO', 'the machine key at ' + file + ' could not be read (' + (e.code || e.message) + ')');
  }
  // None yet: made whole in a temporary file, then published by a link that refuses to replace a key another start made.
  const fresh = file + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.new';
  const k = crypto.randomBytes(32);
  try {
    writeFileAtomic(fresh, k.toString('base64'), { mode: 0o600 });
  } catch (e) { fail(e.code || 'EIO', 'the key folder ' + dir + ' could not take a new machine key (' + (e.code || e.message) + ')'); }
  try {
    fs.linkSync(fresh, file);
    cached = k;
  } catch (e) {
    if (e.code !== 'EEXIST') fail(e.code || 'EIO', 'the key folder ' + dir + ' cannot publish the machine key (' + (e.code || e.message) + '): it needs an NTFS drive');
  } finally {
    try { fs.unlinkSync(fresh); } catch { /* the temporary file is gone already; the key is published or this run is keyless */ }
  }
  if (cached) return cached;
  // Another start published one first: that key is this machine's.
  try { return (cached = take(readKey(file))); } catch (e) {
    if (e.noKey) throw e;
    return fail(e.code || 'EIO', 'the machine key at ' + file + ' could not be read (' + (e.code || e.message) + ')');
  }
}

/** Whether this run has its machine key; the first call reads (or makes) it. */
function hasKey() { try { machineKey(); return true; } catch { return false; } }
/** Why this run has no machine key, as {code, words}, or null when it has one. */
function keyProblem() { return hasKey() ? null : { ...problem }; }

function seal(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** The plain key, or '' when it isn't sealed, was sealed on another machine, or this run has no machine key. */
function open(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return '';
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', machineKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

const isSealed = (s) => typeof s === 'string' && s.startsWith(PREFIX);

/** A 32-byte key for one allow-listed use, from a given machine key (HKDF-SHA256, no salt, the label as its info). */
function deriveFrom(key, label) {
  if (!LABELS.has(label)) throw new Error('no key is derived for "' + String(label).slice(0, 40) + '"');
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), label, 32));
}
/**
 * A 32-byte key for one allow-listed use, from this machine's key. Throws when this run has none. The log's keys are
 * kept for the run; the signing seed never is: it is derived each time something is signed.
 */
function derive(label) {
  if (label === SIGN) return deriveFrom(machineKey(), label);
  if (!derived.has(label)) derived.set(label, deriveFrom(machineKey(), label));
  return Buffer.from(derived.get(label));
}

/**
 * The Ed25519 key that signs what this machine exports, from a 32-byte seed: {privateKey, publicKey, spki, fingerprint},
 * the fingerprint the SHA-256 of the public key's SPKI DER in lower-case hex. The same seed gives the same key.
 */
function signingKeyFrom(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey, spki, fingerprint: crypto.createHash('sha256').update(spki).digest('hex') };
}
/** This machine's signing key, derived now and kept by nobody. Throws when this run has no machine key. */
function signingKey() { return signingKeyFrom(deriveFrom(machineKey(), SIGN)); }

/** For tests: forget the machine key, why there was none and every key derived from it (after pointing AGM_KEY_DIR elsewhere). */
function _reset() { cached = null; problem = null; derived.clear(); }

module.exports = { seal, open, isSealed, keyDir, hasKey, keyProblem, derive, deriveFrom, signingKey, signingKeyFrom, _reset };
