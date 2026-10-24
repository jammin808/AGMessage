'use strict';
/**
 * Accounts and sessions: individual logins beside the meeting codes.
 *
 * Passwords
 *   - scrypt (node:crypto, no dependency) at N=2^15, r=8, p=3: one of OWASP's equivalent settings for scrypt, 32 MiB and
 *     about a quarter of a second per hash on a show laptop. Stored as "scrypt$15$8$3$<salt>$<hash>", so the cost can be
 *     raised later: a login with an older setting is rehashed. Hashing runs on libuv's pool, two at a time at most, so a
 *     burst of logins never stalls the meetings.
 *   - An unknown username costs the same work as a known one, so timing does not say which names exist.
 *   - Policy (NIST SP 800-63B): 10 to 128 characters, no composition rules, refused when common, when it is the
 *     username or the person's name, or one character repeated.
 *
 * Sessions
 *   - A random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS); only its SHA-256 is stored, so
 *     the sessions file cannot be replayed. Idle for 14 hours or 7 days old: signed out. A password change, a disabled
 *     account or an admin's "sign out everywhere" ends them all (the account's epoch moves).
 *   - Saved through one write lane (tmp → fsync → rename), so a watchdog restart keeps everyone signed in.
 */
const crypto = require('crypto');
const { WriteLane, readJsonWithBak } = require('./resilience');
const { customAlphabet } = require('./ids');
const { cleanText } = require('./guard');
const rbac = require('./rbac');

const SCRYPT = Object.freeze({ logN: 15, r: 8, p: 3, keylen: 32 });
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const MIN_PW = 10;
const MAX_PW = 128;
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd123', '1234567890', '12345678910', '0123456789', 'qwertyuiop',
  'qwertyuiop1', 'iloveyou12', 'letmein123', 'welcome123', 'admin12345', 'administrator', 'changeme123', 'trustno1234', 'football123',
  'agmessage', 'agmessage1', 'conference', 'stagewatch', 'patterns123', 'birmingham', 'showcaller', 'production']);
const IDLE_MS = 14 * 3600_000;
const MAX_AGE_MS = 7 * 86400_000;
const TOUCH_MS = 60_000;
const MAX_SESSIONS = 5000;

const makeId = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 12);
const tempChunk = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 4);

// ---------------------------------------------------------------- hashing, two at a time

let running = 0;
const waiting = [];
function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running++;
      crypto.scrypt(String(password).normalize('NFKC'), salt, params.keylen, { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
        running--;
        if (waiting.length) waiting.shift()();
        if (err) reject(err); else resolve(key);
      });
    };
    if (running < 2) go(); else waiting.push(go);
  });
}

async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, params);
  return ['scrypt', params.logN, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parseHash(stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return null;
  const [logN, r, pp] = p.slice(1, 4).map(Number);
  if (![logN, r, pp].every(Number.isInteger) || logN < 10 || logN > 20 || r < 1 || r > 32 || pp < 1 || pp > 16) return null;
  const salt = Buffer.from(p[4], 'base64url'), key = Buffer.from(p[5], 'base64url');
  if (salt.length < 16 || key.length < 16) return null;
  return { logN, r, p: pp, keylen: key.length, salt, key };
}

// A well-formed hash of nothing anyone knows: an unknown username is verified against it, so it costs the same.
let dummy = null;
async function dummyHash() { if (!dummy) dummy = await hashPassword(crypto.randomBytes(18).toString('base64url')); return dummy; }

/** {ok, rehash}: whether the password matches, and whether its stored cost is older than today's. */
async function verifyPassword(password, stored) {
  const h = parseHash(stored) || parseHash(await dummyHash());
  const key = await scrypt(password, h.salt, h);
  const ok = !!parseHash(stored) && key.length === h.key.length && crypto.timingSafeEqual(key, h.key);
  return { ok, rehash: ok && (h.logN < SCRYPT.logN || h.r !== SCRYPT.r || h.p < SCRYPT.p) };
}

/** null when the password may be used, else why not (in words a person can act on). */
function passwordProblem(password, { username = '', name = '' } = {}) {
  const pw = String(password || '');
  if (pw.length < MIN_PW) return 'Use at least ' + MIN_PW + ' characters — a few words together works well.';
  if (pw.length > MAX_PW) return 'Use at most ' + MAX_PW + ' characters.';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9]/g, ''))) return 'That password is too common — choose another.';
  if (/^(.)\1+$/.test(pw)) return 'That password is one character repeated — choose another.';
  if (username && low.includes(String(username).toLowerCase())) return 'The password may not contain the username.';
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (n.length >= 4 && low.replace(/\s+/g, '').includes(n)) return 'The password may not contain your name.';
  return null;
}

/** A one-time password an admin reads out: three groups of four, no look-alike characters (about 59 bits). */
const temporaryPassword = () => [tempChunk(), tempChunk(), tempChunk()].join('-');

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------------------------------------------------------------- the accounts

class Accounts {
  /**
   * @param {string} file data/accounts.json
   */
  constructor(file) {
    this.file = file;
    this.lane = new WriteLane(file, { delayMs: 50, keepBak: true, mode: 0o600 });
    const data = readJsonWithBak(file);
    this.users = new Map();
    for (const u of data && Array.isArray(data.users) ? data.users : []) {
      if (u && typeof u.id === 'string' && USERNAME.test(u.username || '') && rbac.isRole(u.role)) this.users.set(u.id, u);
    }
  }

  save() { this.lane.save(() => JSON.stringify({ v: 1, users: Array.from(this.users.values()) }, null, 1)); }
  flush() { this.lane.flushSync(); }

  get size() { return this.users.size; }
  get(id) { return typeof id === 'string' ? this.users.get(id) || null : null; }
  byUsername(username) {
    const u = String(username || '').trim().toLowerCase();
    for (const a of this.users.values()) if (a.username === u) return a;
    return null;
  }
  activeAdmins() { let n = 0; for (const a of this.users.values()) if (a.role === 'admin' && !a.disabled) n++; return n; }

  /** What a page may know about an account: never its hash. */
  static view(a) {
    if (!a) return null;
    return {
      id: a.id, username: a.username, name: a.name, role: a.role, halls: a.halls || [], allHalls: typeof a.allHalls === 'boolean' ? a.allHalls : null,
      grant: a.grant || [], revoke: a.revoke || [], disabled: !!a.disabled, mustChange: !!a.mustChange,
      createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || 0, pwSetAt: a.pwSetAt || 0, rights: rbac.rightsView(a),
    };
  }
  list() { return Array.from(this.users.values()).map(Accounts.view).sort((x, y) => x.username.localeCompare(y.username)); }

  /** Make an account. Returns {account, password?} (the one-time password when none was given), or {error}. */
  async create({ username, name, role = 'staff', halls = [], allHalls, grant = [], revoke = [], password }, actorId = '') {
    const u = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(u)) return { error: 'A username is 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.' };
    if (this.byUsername(u)) return { error: 'That username is taken.' };
    if (!rbac.isRole(role)) return { error: 'Unknown role.' };
    const display = cleanText(name, 40) || u;
    const temp = !password;
    const pw = password || temporaryPassword();
    const problem = temp ? null : passwordProblem(pw, { username: u, name: display });
    if (problem) return { error: problem };
    const now = Date.now();
    const a = {
      id: 'a' + makeId(), username: u, name: display, role, halls: cleanHalls(halls),
      ...(typeof allHalls === 'boolean' ? { allHalls } : {}),
      grant: (grant || []).filter(rbac.isCap), revoke: (revoke || []).filter(rbac.isCap),
      disabled: false, mustChange: temp, pw: await hashPassword(pw), pwSetAt: now, epoch: 1,
      createdAt: now, createdBy: String(actorId || ''), lastLoginAt: 0,
    };
    this.users.set(a.id, a);
    this.save();
    return { account: a, password: temp ? pw : undefined };
  }

  /** Set fields an admin may change (checked by the caller with rbac.mayChange). Returns the changed field names. */
  update(id, change) {
    const a = this.get(id);
    if (!a) return null;
    const changed = [];
    if (typeof change.name === 'string') { const n = cleanText(change.name, 40); if (n && n !== a.name) { a.name = n; changed.push('name'); } }
    if (rbac.isRole(change.role) && change.role !== a.role) { a.role = change.role; changed.push('role'); }
    if (Array.isArray(change.halls)) { a.halls = cleanHalls(change.halls); changed.push('halls'); }
    if ('allHalls' in change) { if (typeof change.allHalls === 'boolean') a.allHalls = change.allHalls; else delete a.allHalls; changed.push('allHalls'); }
    if (Array.isArray(change.grant)) { a.grant = change.grant.filter(rbac.isCap); changed.push('grant'); }
    if (Array.isArray(change.revoke)) { a.revoke = change.revoke.filter(rbac.isCap); changed.push('revoke'); }
    if (typeof change.disabled === 'boolean' && change.disabled !== !!a.disabled) {
      a.disabled = change.disabled; changed.push('disabled');
      if (a.disabled) a.epoch = (a.epoch || 1) + 1;   // a disabled account is signed out everywhere at once
    }
    if (changed.length) this.save();
    return changed;
  }

  /** Set a password (already checked); `mustChange` for one an admin set. Every session ends: the caller signs the person in again. */
  async setPassword(id, password, { mustChange = false } = {}) {
    const a = this.get(id);
    if (!a) return false;
    a.pw = await hashPassword(password);
    a.pwSetAt = Date.now();
    a.mustChange = !!mustChange;
    a.epoch = (a.epoch || 1) + 1;
    this.save();
    return true;
  }

  /** End every session of an account (its epoch moves). */
  signOutEverywhere(id) { const a = this.get(id); if (!a) return false; a.epoch = (a.epoch || 1) + 1; this.save(); return true; }

  remove(id) { const ok = this.users.delete(id); if (ok) this.save(); return ok; }

  /** Check a username and password. {account} or {error}; the same work and the same words for an unknown name. */
  async authenticate(username, password) {
    const a = this.byUsername(username);
    const r = await verifyPassword(String(password || '').slice(0, MAX_PW), a ? a.pw : '');
    if (!a || !r.ok) return { error: 'That username and password don\'t match.' };
    if (a.disabled) return { error: 'This account is turned off — ask an admin.' };
    if (r.rehash) { a.pw = await hashPassword(password); this.save(); }
    a.lastLoginAt = Date.now();
    this.save();
    return { account: a };
  }
}

const HALL_CODE = /^[A-Z0-9]{4,12}$/;
function cleanHalls(list) { return Array.from(new Set((Array.isArray(list) ? list : []).map((c) => String(c).toUpperCase()).filter((c) => HALL_CODE.test(c)))).slice(0, 200); }

// ---------------------------------------------------------------- sessions

class Sessions {
  constructor(file, accounts) {
    this.accounts = accounts;
    this.lane = new WriteLane(file, { delayMs: 500, keepBak: true, mode: 0o600 });
    this.map = new Map();   // sha256(token) -> {uid, epoch, created, seen, ip, ua}
    const data = readJsonWithBak(file);
    const now = Date.now();
    for (const s of data && Array.isArray(data.sessions) ? data.sessions : []) {
      if (s && /^[0-9a-f]{64}$/.test(s.h || '') && typeof s.uid === 'string' && now - s.created < MAX_AGE_MS && now - s.seen < IDLE_MS) this.map.set(s.h, s);
    }
  }

  save() { this.lane.save(() => JSON.stringify({ v: 1, sessions: Array.from(this.map.values()) })); }
  flush() { this.lane.flushSync(); }

  /** A new session for an account: the token goes in the cookie, only its hash is kept. */
  create(account, { ip = '', ua = '' } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(sha256(token), { h: sha256(token), uid: account.id, epoch: account.epoch || 1, created: now, seen: now, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 120) });
    if (this.map.size > MAX_SESSIONS) {
      const oldest = Array.from(this.map.values()).sort((a, b) => a.seen - b.seen).slice(0, this.map.size - MAX_SESSIONS);
      for (const s of oldest) this.map.delete(s.h);
    }
    this.save();
    return token;
  }

  /** The signed-in account for a token, or null (expired, idle, revoked, or the account gone or turned off). */
  resolve(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 64) return null;
    const h = sha256(token);
    const s = this.map.get(h);
    if (!s) return null;
    const a = this.accounts.get(s.uid);
    if (!a || a.disabled || (a.epoch || 1) !== s.epoch || now - s.created >= MAX_AGE_MS || now - s.seen >= IDLE_MS) {
      this.map.delete(h); this.save();
      return null;
    }
    if (now - s.seen > TOUCH_MS) { s.seen = now; this.save(); }
    return { account: a, session: s };
  }

  destroy(token) { if (typeof token === 'string' && this.map.delete(sha256(token))) this.save(); }

  /** Sessions of one account (for "signed in on" lists): no hashes. */
  of(uid) { return Array.from(this.map.values()).filter((s) => s.uid === uid).map((s) => ({ created: s.created, seen: s.seen, ip: s.ip, ua: s.ua })); }
}

module.exports = {
  Accounts, Sessions, hashPassword, verifyPassword, parseHash, passwordProblem, temporaryPassword,
  SCRYPT, USERNAME, MIN_PW, IDLE_MS, MAX_AGE_MS,
};
