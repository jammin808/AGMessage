'use strict';
/**
 * Saved keys (the Stagewatch key, the Anthropic key) are encrypted at rest: AES-256-GCM with a random machine key kept
 * OUTSIDE the app folder (%LOCALAPPDATA%\AGMessage\machine.key, or ~/.agmessage on other systems), so a copied or
 * zipped AGMessage folder — data/ included — carries no usable key. It is not a defence against someone who already
 * controls this Windows account; it is a defence against the folder travelling.
 *
 * Stored form: "enc1:" + base64(iv(12) | tag(16) | ciphertext).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'enc1:';

function keyDir() {
  if (process.env.AGM_KEY_DIR) return process.env.AGM_KEY_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'AGMessage');
  return path.join(os.homedir(), '.agmessage');
}

let cached = null;
function machineKey() {
  if (cached) return cached;
  const dir = keyDir();
  const file = path.join(dir, 'machine.key');
  try {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length === 32) return (cached = k);
  } catch { /* make one */ }
  fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  return (cached = k);
}

function seal(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** The plain key, or '' when it isn't sealed or was sealed on another machine. */
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

/** For tests: forget the cached key (after pointing AGM_KEY_DIR elsewhere). */
function _reset() { cached = null; }

module.exports = { seal, open, isSealed, keyDir, _reset };
