'use strict';
/**
 * Accounts and sessions: individual logins beside the meeting codes.
 *
 * Passwords
 *   - scrypt (node:crypto, no dependency) at N=2^15, r=8, p=3: one of OWASP's equivalent settings for scrypt, 32 MiB and
 *     about a quarter of a second per hash on a show laptop. Stored as "scrypt$15$8$3$<salt>$<hash>", so the cost can be
 *     raised later: a login with an older setting is rehashed. Hashing runs on libuv's pool, two at a time at most, so a
 *     burst of logins never stalls the meetings. A sign-in through the tunnel uses one of the two at most, so the other is
 *     kept for the venue network; each side waits in a short queue of its own, a sign-in past it is told "busy" at once,
 *     and one whose request has gone is dropped unhashed.
 *   - An unknown username costs the same work as a known one, so timing does not say which names exist.
 *   - Policy (NIST SP 800-63B): 10 to 128 characters, no composition rules, refused when common, when it is the
 *     username or the person's name, or one character repeated.
 *
 * Sessions
 *   - A random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS); only its SHA-256 is stored, so
 *     the sessions file cannot be replayed. Idle for 14 hours or 7 days old: signed out (a page kept open is in use: the
 *     server touches the session of every open socket). A password change, a disabled account or an admin's "sign out
 *     everywhere" ends them all (the account's epoch moves). An account keeps its 20 newest; past 5000 in all, the
 *     account with the most gives up its oldest, so one account signing in again and again never signs anyone else out.
 *   - Saved through one write lane (tmp → fsync → rename), so a watchdog restart keeps everyone signed in. The host
 *     laptop's admin-token sign-ins are kept the same way (TokenSessions), tied to the token they were made with.
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
const MAX_PER_ACCOUNT = 20;
const TOKEN_SESSION_MS = 86400_000;   // the agm_admin cookie's Max-Age
const NO_MATCH = 'That username and password don\'t match.';

const makeId = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 12);
const tempChunk = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 4);

// ---------------------------------------------------------------- hashing: two slots, two lanes

// Two hashes run at once. The venue lane (the laptop and the venue network) may use both slots, the tunnel lane one, so
// a flood of guesses through the tunnel never holds a sign-in on the venue network behind it, and a free slot goes to the
// venue first. A check tied to a request (it carries the request's `signal`) waits in its lane's short queue: past it
// it is refused at once (code BUSY), and when its request goes it leaves the queue unhashed (code ABANDONED). Hashing
// a new password (no signal) always waits its turn.
const SLOTS = 2;
const LANES = Object.freeze({ venue: { slots: 2, queue: 16 }, tunnel: { slots: 1, queue: 8 } });
let running = 0;
const runningIn = { venue: 0, tunnel: 0 };
const waiting = { venue: [], tunnel: [] };
const hashRefusal = (code) => Object.assign(new Error(code === 'BUSY' ? 'sign-in is busy' : 'the request went before its turn'), { code });
const canStart = (lane) => running < SLOTS && runningIn[lane] < LANES[lane].slots;

function startHash(job) {
  if (job.signal) job.signal.removeEventListener('abort', job.onAbort);
  running++; runningIn[job.lane]++;
  crypto.scrypt(job.password, job.salt, job.params.keylen, { N: 2 ** job.params.logN, r: job.params.r, p: job.params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
    running--; runningIn[job.lane]--;
    nextHash();
    if (err) job.reject(err); else job.resolve(key);
  });
}
function nextHash() {
  for (const lane of ['venue', 'tunnel']) {
    while (waiting[lane].length && canStart(lane)) startHash(waiting[lane].shift());
  }
}

function scrypt(password, salt, params, { lane = 'venue', signal } = {}) {
  const l = Object.prototype.hasOwnProperty.call(LANES, lane) ? lane : 'venue';
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(hashRefusal('ABANDONED')); return; }
    const job = { password: String(password).normalize('NFKC'), salt, params, lane: l, signal, resolve, reject, onAbort: null };
    if (canStart(l)) { startHash(job); return; }
    if (signal && waiting[l].length >= LANES[l].queue) { reject(hashRefusal('BUSY')); return; }
    if (signal) {
      job.onAbort = () => { const i = waiting[l].indexOf(job); if (i >= 0) waiting[l].splice(i, 1); reject(hashRefusal('ABANDONED')); };
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    waiting[l].push(job);
  });
}

async function hashPassword(password, params = SCRYPT, opts = {}) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, params, opts);
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

/**
 * {ok, rehash}: whether the password matches, and whether its stored cost is older than today's. `opts` ({lane,
 * signal}) place the check in a lane; it rejects with code BUSY or ABANDONED when it is never hashed.
 */
async function verifyPassword(password, stored, opts = {}) {
  const h = parseHash(stored) || parseHash(await dummyHash());
  const key = await scrypt(password, h.salt, h, opts);
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
    this.pending = new Set();   // usernames whose account is being made (its hash in flight)
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

  /**
   * Make an account. Returns {account, password?} (the one-time password when none was given), or {error} ({error,
   * exists} for a first admin when there are accounts already). The name is reserved before its hash is made, so two
   * requests at once never make two accounts of one name, nor two first admins.
   */
  async create({ username, name, role = 'staff', halls = [], allHalls, grant = [], revoke = [], password }, actorId = '', { firstAdmin = false } = {}) {
    const u = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(u)) return { error: 'A username is 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.' };
    if (firstAdmin && (this.users.size > 0 || this.pending.size > 0)) return { error: 'Accounts are set up already — sign in.', exists: true };
    if (this.byUsername(u) || this.pending.has(u)) return { error: 'That username is taken.' };
    if (!rbac.isRole(role)) return { error: 'Unknown role.' };
    const display = cleanText(name, 40) || u;
    const temp = !password;
    const pw = password || temporaryPassword();
    const problem = temp ? null : passwordProblem(pw, { username: u, name: display });
    if (problem) return { error: problem };
    this.pending.add(u);
    let hash;
    try { hash = await hashPassword(pw); } finally { this.pending.delete(u); }
    const now = Date.now();
    const a = {
      id: 'a' + makeId(), username: u, name: display, role, halls: cleanHalls(halls),
      ...(typeof allHalls === 'boolean' ? { allHalls } : {}),
      grant: (grant || []).filter(rbac.isCap), revoke: (revoke || []).filter(rbac.isCap),
      disabled: false, mustChange: temp, pw: hash, pwSetAt: now, epoch: 1,
      createdAt: now, createdBy: String(actorId || ''), lastLoginAt: 0,
    };
    this.users.set(a.id, a);
    this.save();
    return { account: a, password: temp ? pw : undefined };
  }

  /**
   * Set fields an admin may change (checked by the caller with rbac.mayChange). Returns the names of the fields that
   * now hold something else: a field sent as it already is is no change (no reconnect, no audit row).
   */
  update(id, change) {
    const a = this.get(id);
    if (!a) return null;
    const changed = [];
    if (typeof change.name === 'string') { const n = cleanText(change.name, 40); if (n && n !== a.name) { a.name = n; changed.push('name'); } }
    if (rbac.isRole(change.role) && change.role !== a.role) { a.role = change.role; changed.push('role'); }
    if (Array.isArray(change.halls)) { const h = cleanHalls(change.halls); if (!sameSet(h, a.halls)) { a.halls = h; changed.push('halls'); } }
    if ('allHalls' in change) {
      const next = typeof change.allHalls === 'boolean' ? change.allHalls : undefined;
      if (next !== (typeof a.allHalls === 'boolean' ? a.allHalls : undefined)) { if (next === undefined) delete a.allHalls; else a.allHalls = next; changed.push('allHalls'); }
    }
    if (Array.isArray(change.grant)) { const g = [...new Set(change.grant.filter(rbac.isCap))]; if (!sameSet(g, a.grant)) { a.grant = g; changed.push('grant'); } }
    if (Array.isArray(change.revoke)) { const r = [...new Set(change.revoke.filter(rbac.isCap))]; if (!sameSet(r, a.revoke)) { a.revoke = r; changed.push('revoke'); } }
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

  /**
   * Check a username and password: {account}, or {error, reason} — the same work and the same words for an unknown
   * name, a wrong password and a turned-off account, so the answer never says which names exist or that a password was
   * right; `reason` (unknown, wrong, disabled) is for the audit log only. {busy} or {abandoned} when the check was never
   * hashed (`opts`: {lane, signal}, see scrypt). A sign-in is stamped by the caller once a session is made.
   */
  async authenticate(username, password, opts = {}) {
    const a = this.byUsername(username);
    let r;
    try { r = await verifyPassword(String(password || '').slice(0, MAX_PW), a ? a.pw : '', opts); }
    catch (e) {
      if (e && e.code === 'BUSY') return { busy: true };
      if (e && e.code === 'ABANDONED') return { abandoned: true };
      throw e;
    }
    if (!a) return { error: NO_MATCH, reason: 'unknown' };
    if (!r.ok) return { error: NO_MATCH, reason: 'wrong' };
    if (a.disabled) return { error: NO_MATCH, reason: 'disabled' };
    if (r.rehash) { a.pw = await hashPassword(password, SCRYPT, { lane: opts.lane }); this.save(); }
    return { account: a };
  }

  /** A sign-in happened: the Accounts page shows when. */
  signedIn(a) { a.lastLoginAt = Date.now(); this.save(); }
}

const HALL_CODE = /^[A-Z0-9]{4,12}$/;
function cleanHalls(list) { return Array.from(new Set((Array.isArray(list) ? list : []).map((c) => String(c).toUpperCase()).filter((c) => HALL_CODE.test(c)))).slice(0, 200); }
/** The same members, in any order (a missing list is an empty one). */
function sameSet(x, y) {
  const a = [...new Set(x || [])].sort(), b = [...new Set(y || [])].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------- sessions

class Sessions {
  constructor(file, accounts) {
    this.accounts = accounts;
    this.lane = new WriteLane(file, { delayMs: 500, keepBak: true, mode: 0o600 });
    this.map = new Map();   // sha256(token) -> {h, uid, epoch, created, seen, ip, ua}
    const data = readJsonWithBak(file);
    const now = Date.now();
    for (const s of data && Array.isArray(data.sessions) ? data.sessions : []) {
      if (s && /^[0-9a-f]{64}$/.test(s.h || '') && typeof s.uid === 'string' && now - s.created < MAX_AGE_MS && now - s.seen < IDLE_MS) this.map.set(s.h, s);
    }
  }

  save() { this.lane.save(() => JSON.stringify({ v: 1, sessions: Array.from(this.map.values()) })); }
  flush() { this.lane.flushSync(); }

  /** Whether a session still lets its holder in: its account there and on, its epoch current, not too old, not idle. */
  live(s, now = Date.now()) {
    const a = this.accounts.get(s.uid);
    return !!a && !a.disabled && (a.epoch || 1) === s.epoch && now - s.created < MAX_AGE_MS && now - s.seen < IDLE_MS;
  }

  /**
   * A new session for an account: the token goes in the cookie, only its hash is kept. An account keeps its
   * MAX_PER_ACCOUNT newest sessions; past MAX_SESSIONS in all, ended sessions go first, then the oldest of the account
   * with the most — one account signing in again and again never ends another's.
   */
  create(account, { ip = '', ua = '' } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const h = sha256(token);
    const now = Date.now();
    this.map.set(h, { h, uid: account.id, epoch: account.epoch || 1, created: now, seen: now, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 120) });
    const mine = Array.from(this.map.values()).filter((s) => s.uid === account.id && s.h !== h).sort((a, b) => a.seen - b.seen);
    for (const s of mine.slice(0, Math.max(0, mine.length - (MAX_PER_ACCOUNT - 1)))) this.map.delete(s.h);
    if (this.map.size > MAX_SESSIONS) this.prune(now);
    while (this.map.size > MAX_SESSIONS) {
      const per = new Map();
      for (const s of this.map.values()) if (s.h !== h) { const list = per.get(s.uid) || []; list.push(s); per.set(s.uid, list); }
      const most = Array.from(per.values()).sort((x, y) => y.length - x.length)[0];
      this.map.delete(most.sort((a, b) => a.seen - b.seen)[0].h);
    }
    this.save();
    return token;
  }

  /** The signed-in account for a token, or null (expired, idle, revoked, or the account gone or turned off). */
  resolve(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 64) return null;
    return this.touch(sha256(token), now);
  }

  /** A session in use, by its stored hash (a request, or an open socket): {account, session}, or null once it has ended. */
  touch(h, now = Date.now()) {
    const s = this.map.get(h);
    if (!s) return null;
    if (!this.live(s, now)) { this.map.delete(h); this.save(); return null; }
    if (now - s.seen > TOUCH_MS) { s.seen = now; this.save(); }
    return { account: this.accounts.get(s.uid), session: s };
  }

  /**
   * The server's once-a-minute look at its open sockets: each session in `open` (hashes of open sockets) is in use, so
   * it is touched; then every ended session is dropped. Returns the hashes in `open` that have ended, whose sockets close.
   */
  sweep(open, now = Date.now()) {
    const ended = new Set();
    for (const h of open) if (!this.touch(h, now)) ended.add(h);
    this.prune(now);
    return ended;
  }

  /** Drop every session that has ended. */
  prune(now = Date.now()) {
    let n = 0;
    for (const [h, s] of this.map) if (!this.live(s, now)) { this.map.delete(h); n++; }
    if (n) this.save();
    return n;
  }

  destroy(token) { if (typeof token === 'string' && this.map.delete(sha256(token))) this.save(); }

  /** The live sessions of one account (for "signed in on" lists): no hashes. */
  of(uid, now = Date.now()) {
    return Array.from(this.map.values()).filter((s) => s.uid === uid && this.live(s, now)).map((s) => ({ created: s.created, seen: s.seen, ip: s.ip, ua: s.ua }));
  }
}

/**
 * The host laptop's admin-token sign-ins (the agm_admin cookie). Like account sessions only a hash of each is kept, on
 * disk through one write lane, so a watchdog restart keeps the dashboard signed in. Each file is tied to the token it
 * was made under (`tag`, a keyed hash of the token, never the token): the next start of AGMessage prints a new token
 * and every earlier sign-in ends. One lasts a day, as its cookie does.
 */
class TokenSessions {
  constructor(file, tag) {
    this.tag = String(tag);
    this.lane = new WriteLane(file, { delayMs: 100, keepBak: true, mode: 0o600 });
    this.map = new Map();   // sha256(sid) -> {h, created}
    const data = readJsonWithBak(file);
    const now = Date.now();
    if (data && data.k === this.tag && Array.isArray(data.sessions)) {
      for (const s of data.sessions) if (s && /^[0-9a-f]{64}$/.test(s.h || '') && Number.isFinite(s.created) && now - s.created < TOKEN_SESSION_MS) this.map.set(s.h, { h: s.h, created: s.created });
    }
  }

  save() { this.lane.save(() => JSON.stringify({ v: 1, k: this.tag, sessions: Array.from(this.map.values()) })); }
  flush() { this.lane.flushSync(); }

  /** A new sign-in: its id goes in the cookie, only its hash is kept. */
  create() {
    const sid = crypto.randomBytes(24).toString('hex');
    const h = sha256(sid);
    this.map.set(h, { h, created: Date.now() });
    this.save();
    return sid;
  }

  /** Whether a cookie's id is a sign-in that still holds. */
  has(sid, now = Date.now()) {
    if (typeof sid !== 'string' || !sid || sid.length > 64) return false;
    const s = this.map.get(sha256(sid));
    if (!s) return false;
    if (now - s.created >= TOKEN_SESSION_MS) { this.map.delete(s.h); this.save(); return false; }
    return true;
  }

  destroy(sid) { if (typeof sid === 'string' && this.map.delete(sha256(sid))) this.save(); }
}

module.exports = {
  Accounts, Sessions, TokenSessions, hashPassword, verifyPassword, parseHash, passwordProblem, temporaryPassword, sha256,
  SCRYPT, USERNAME, MIN_PW, IDLE_MS, MAX_AGE_MS, TOUCH_MS, MAX_SESSIONS, MAX_PER_ACCOUNT, TOKEN_SESSION_MS, NO_MATCH, LANES,
};
