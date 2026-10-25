'use strict';
/**
 * Security helpers: server-signed identities, token-bucket rate limits, lockouts for guessing,
 * strict page headers, the upload allow-list (checked by content, not just by name), and signed
 * role invites. Pure where possible so they are unit tested (test/guard.test.js).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- the server secret (kept beside the data so identities survive restarts) ----------
function loadSecret(dataDir) {
  const p = path.join(dataDir, 'secret.key');
  try {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return Buffer.from(s, 'hex');
  } catch { /* create below */ }
  const s = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, s.toString('hex'), { mode: 0o600 });
  return s;
}

function mac(secret, text, len = 24) {
  return crypto.createHmac('sha256', secret).update(text).digest('base64url').slice(0, len);
}

/**
 * Text a person typed, made safe to show anywhere: control characters (C0, DEL, C1) and the bidirectional overrides and
 * isolates that let a name or file name read differently from what it is (Trojan Source) are dropped, then it is trimmed
 * and cut to `max` characters.
 */
const UNSAFE_TEXT = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
function cleanText(s, max = 200) {
  return str(s).replace(UNSAFE_TEXT, '').trim().slice(0, max);
}

/**
 * A value a client sent, as a string: a string as it is, a finite number in digits, anything else (an object, a list,
 * null, true) the empty string. String() is never called on client JSON: an object whose toString is not a function
 * makes it throw.
 */
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** The value of one cookie, or null. A parser, not a pattern built from the name. */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
  }
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- identity: "<id>.<mac>" issued by the server; a client can't pick someone else's ----------
function newIdentity(secret) {
  const id = 'u' + crypto.randomBytes(9).toString('base64url');
  return id + '.' + mac(secret, 'uid:' + id);
}
/** The id inside a valid signed identity, else null. */
function checkIdentity(secret, token) {
  if (typeof token !== 'string' || token.length > 80) return null;
  const dot = token.indexOf('.');
  if (dot < 2) return null;
  const id = token.slice(0, dot);
  if (!/^u[A-Za-z0-9_-]{8,20}$/.test(id)) return null;
  return safeEqual(token.slice(dot + 1), mac(secret, 'uid:' + id)) ? id : null;
}

// ---------- role invites: a link that lets its holder join a locked room as board / research ----------
function makeInvite(secret, room, role) {
  return role[0] + '.' + mac(secret, 'invite:' + room + ':' + role, 16);
}
function checkInvite(secret, room, role, token) {
  return typeof token === 'string' && token.length < 40 && safeEqual(token, makeInvite(secret, room, role));
}

// ---------- token bucket: `rate` per second, bursts of `burst` ----------
class Bucket {
  constructor(rate, burst, now = Date.now()) { this.rate = rate; this.burst = burst; this.tokens = burst; this.at = now; }
  /** The tokens it holds at `now`, taking none. */
  level(now = Date.now()) { return Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate); }
  take(n = 1, now = Date.now()) {
    this.tokens = this.level(now);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * A token bucket per key (an address), `cap` keys at most. Past that the fullest buckets go first — a full bucket is the
 * same as a new one — so a flood of new keys never hands back the allowance of a key that has used its own.
 */
class Buckets {
  constructor(rate, burst, cap = 5000) { this.rate = rate; this.burst = burst; this.cap = cap; this.map = new Map(); }
  take(key, now = Date.now()) {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.cap) this.trim(now);
      b = new Bucket(this.rate, this.burst, now);
      this.map.set(key, b);
    }
    return b.take(1, now);
  }
  trim(now) {
    const fullest = Array.from(this.map).sort((x, y) => y[1].level(now) - x[1].level(now));
    for (const [k] of fullest.slice(0, this.map.size - Math.floor(this.cap * 0.9))) this.map.delete(k);
  }
}

/**
 * Per-key failure counting: `max` failures in `windowMs` locks the key out until `windowMs` after the first of them.
 * At most `cap` keys are kept; past that, ended windows go first and then the keys with the fewest failures, so a flood
 * of new keys never lifts a lock that is holding.
 */
class Lockout {
  constructor(max = 8, windowMs = 60_000, cap = 10_000) { this.max = max; this.windowMs = windowMs; this.cap = cap; this.map = new Map(); }
  locked(key, now = Date.now()) {
    const e = this.map.get(key);
    return !!e && e.n >= this.max && now - e.t < this.windowMs;
  }
  fail(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e || now - e.t > this.windowMs) this.map.set(key, { n: 1, t: now });
    else e.n++;
    if (this.map.size > this.cap) this.trim(now);
  }
  ok(key) { this.map.delete(key); }
  /** Forget every key `pick` chooses (an admin's new one-time password ends the wait for that name). */
  forget(pick) { for (const k of this.map.keys()) if (pick(k)) this.map.delete(k); }
  trim(now) {
    const keep = Math.floor(this.cap * 0.9);
    for (const [k, e] of this.map) if (now - e.t > this.windowMs) this.map.delete(k);
    if (this.map.size <= keep) return;
    const fewest = Array.from(this.map).sort((x, y) => x[1].n - y[1].n);
    for (const [k] of fewest.slice(0, this.map.size - keep)) this.map.delete(k);
  }
}

/** The caller's address, honouring Cloudflare's header only when the request came through the local tunnel. */
function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || (req.conn && req.conn.remoteAddress) || '';
  const local = raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
  const cf = req.headers && req.headers['cf-connecting-ip'];
  return local && typeof cf === 'string' && cf.length < 64 ? 'cf:' + cf : raw;
}

/**
 * The Host header names this machine's loopback — localhost, 127.0.0.1 or [::1], any port. A page served under another
 * name that resolves to 127.0.0.1 (DNS rebinding) sends its own name here, and its Origin matches it, so loopback
 * alone does not say the request was typed on this laptop.
 */
function loopbackHost(host) {
  const h = String(host || '').toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  const port = h.slice(name.length);
  if (port && !/^:\d{1,5}$/.test(port)) return false;
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

/** True only for a request typed on this laptop: from loopback, to a loopback name, and no proxy/tunnel headers. */
function isHostMachine(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  if (!(raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1')) return false;
  const h = req.headers || {};
  if (!loopbackHost(h.host)) return false;
  return !h['x-forwarded-for'] && !h['cf-connecting-ip'] && !h['cf-ray'] && !h['forwarded'] && !h['x-real-ip'];
}

// ---------- page headers ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function pageHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

// ---------- uploads: an allow-list, checked against the file's first bytes ----------
const UPLOAD_TYPES = {
  pdf:  { mime: 'application/pdf', inline: true, magic: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  png:  { mime: 'image/png', inline: true, magic: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg:  { mime: 'image/jpeg', inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif:  { mime: 'image/gif', inline: true, magic: (b) => b.slice(0, 4).toString('latin1') === 'GIF8' },
  webp: { mime: 'image/webp', inline: true, magic: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, magic: isZip },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, magic: isZip },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', inline: false, magic: isZip },
  xls:  { mime: 'application/vnd.ms-excel', inline: false, magic: (b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  csv:  { mime: 'text/csv; charset=utf-8', inline: true, magic: isText },
  txt:  { mime: 'text/plain; charset=utf-8', inline: true, magic: isText },
  md:   { mime: 'text/plain; charset=utf-8', inline: true, magic: isText },
};
function isZip(b) { return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }
function isText(b) {
  const s = b.slice(0, 4096).toString('utf8');
  return !s.includes('\u0000') && !/<\s*(script|html|svg|iframe|object|embed)\b/i.test(s);
}
function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
/** The upload's type if its name and its first bytes agree, else null. */
function uploadType(filename, head) {
  const ext = extOf(filename);
  const t = UPLOAD_TYPES[ext];
  return t && head && head.length >= 4 && t.magic(head) ? { ext, ...t } : null;
}
const UPLOAD_NAME = /^[0-9]{10,16}-[a-z0-9]{12}-[A-Za-z0-9._-]{1,60}$/;
/** A file message's URL must point at one of our uploads. */
function validUploadUrl(url) {
  return typeof url === 'string' && url.startsWith('/uploads/') && UPLOAD_NAME.test(url.slice(9)) && !url.includes('..');
}

module.exports = {
  loadSecret, mac, safeEqual, cleanText, readCookie, newIdentity, checkIdentity, makeInvite, checkInvite,
  Bucket, Buckets, Lockout, clientIp, isHostMachine, loopbackHost, pageHeaders, CSP, str,
  UPLOAD_TYPES, uploadType, validUploadUrl, extOf,
};
