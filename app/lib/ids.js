'use strict';
/**
 * Random identifiers from the operating system's CSPRNG (node:crypto), each character drawn uniformly from its
 * alphabet: no modulo bias, no Math.random, no dependency.
 */
const crypto = require('crypto');

/** A function that returns `size` characters drawn uniformly from `alphabet`. */
function customAlphabet(alphabet, size) {
  if (typeof alphabet !== 'string' || alphabet.length < 2 || alphabet.length > 256) throw new RangeError('an alphabet of 2 to 256 characters');
  return () => {
    let out = '';
    for (let i = 0; i < size; i++) out += alphabet[crypto.randomInt(alphabet.length)];
    return out;
  };
}

/** A URL-safe token of `bytes` random bytes (base64url, no padding). */
const token = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { customAlphabet, token };
