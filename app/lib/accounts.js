'use strict';
/**
 * Accounts and sessions: individual logins beside the guest codes.
 *
 * Passwords
 *   - scrypt (node:crypto, no dependency) at N=2^15, r=8, p=3: one of OWASP's equivalent settings for scrypt, 32 MiB and
 *     about a quarter of a second per hash on a show laptop. Stored as "scrypt$15$8$3$<salt>$<hash>", so the cost can be
 *     raised later: a login with an older setting is rehashed. Hashing runs on libuv's pool, two at a time at most, so a
 *     burst of logins never stalls the halls. A sign-in through the tunnel uses one of the two at most, so the other is
 *     kept for the venue network; each side waits in a short queue of its own, a sign-in past it is told "busy" at once,
 *     and one whose request has gone is dropped unhashed.
 *   - An unknown username costs the same work as a known one, so timing does not say which names exist.
 *   - Policy (NIST SP 800-63B): 10 to 128 characters, no composition rules, refused when common, when it is the
 *     username or the person's name, or one character repeated.
 *
 * Sessions
 *   - A random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS); only its keyed hash is stored
 *     (lib/keyedstore.js: an HMAC under a key derived from the machine key), so the sessions file can neither be replayed
 *     nor written into. Idle for 14 hours or 7 days old: signed out (a page kept open is in use: the server touches the
 *     session of every open socket). A password change, a disabled account or an admin's "sign out everywhere" ends them
 *     all (the account's epoch moves). An account keeps its 20 newest; past 5000 in all, the account with the most gives
 *     up its oldest, so one account signing in again and again never signs anyone else out. A sign-in stamped more than
 *     5 minutes ahead of now is dropped at load.
 *   - Saved through one write lane (tmp → fsync → rename), so a watchdog restart keeps everyone signed in. The host
 *     laptop's admin-token sign-ins are kept the same way (TokenSessions), tied to the token they were made with.
 *
 * The keyed stores
 *   - Each of the three is given its part of lib/keyedstore.js (`keyed`) and refuses to start without it: nothing of
 *     them is read or written but through it. Their maps stay empty until its open() fills them (`fill`), and a save is
 *     written only while it says the store may be (never before open(), in a run without the machine key, a store that
 *     could not be read, accounts held aside, or the sign-ins while the accounts are not open).
 *   - A save that takes a right away or ends a sign-in (an account made, changed, its password set, signed out
 *     everywhere, removed or adopted; a sign-out) is written twice, its record at once (`save({twice: true})`).
 */
const crypto = require('crypto');
const { WriteLane } = require('./resilience');
const { customAlphabet } = require('./ids');
const { cleanText } = require('./guard');
const rbac = require('./rbac');
const views = require('./views');
const { AHEAD_MS } = require('./keyedstore');

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
  const done = (err, key) => {
    running--; runningIn[job.lane]--;
    nextHash();
    if (err) job.reject(err); else job.resolve(key);
  };
  // scrypt refuses some settings a stored hash may name (a cost past the memory cap) by throwing before it starts: that
  // check fails, and its slot is given back — never held for good, nor thrown out of another hash's callback.
  try { crypto.scrypt(job.password, job.salt, job.params.keylen, { N: 2 ** job.params.logN, r: job.params.r, p: job.params.p, maxmem: 256 * 1024 * 1024 }, done); }
  catch (e) { done(e); }
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

// A well-formed hash of nothing anyone knows: an unknown username is verified against it, so it costs the same. It is
// made once: every check that needs it before it exists waits for that one hash (a promise, not a value), so a burst of
// unknown names never queues a hash of its own per guess — unbounded, on the venue's lane, ahead of the crew.
let dummy = null;
function dummyHash() {
  if (!dummy) dummy = hashPassword(crypto.randomBytes(18).toString('base64url')).catch((e) => { dummy = null; throw e; });
  return dummy;
}

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

/** The part of lib/keyedstore.js a store is given: without it the store refuses to start (fail closed). */
function keyedOf(keyed, what) {
  if (!keyed || typeof keyed.seal !== 'function' || typeof keyed.attach !== 'function' || typeof keyed.laneOptions !== 'function') {
    throw new Error(what + ' need their keyed store (lib/keyedstore.js): they are never read or written without it');
  }
  return keyed;
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** Whether a record is an account the store takes, read by type: an id, a username and a role it knows. */
const validAccount = (u) => !!u && typeof u === 'object' && typeof u.id === 'string' && USERNAME.test(u.username || '') && rbac.isRole(u.role);

// ---------------------------------------------------------------- the accounts

class Accounts {
  /**
   * @param {string} file data/accounts.json
   * @param {object} o `keyed`: its part of lib/keyedstore.js
   */
  constructor(file, { keyed } = {}) {
    this.keyed = keyedOf(keyed, 'the accounts');
    this.file = file;
    this.lane = new WriteLane(file, { delayMs: 50, keepBak: true, mode: 0o600, ...keyed.laneOptions() });
    this.users = new Map();
    this.pending = new Set();   // usernames whose account is being made (its hash in flight)
    keyed.attach(this);
  }

  /** Whether a record is an account this store takes (validAccount). */
  validUser(u) { return validAccount(u); }
  /**
   * What an account could reach, judged as if turned on: whether it can manage AGMessage (rbac.holdsAdminOnly) and
   * whether it reaches past its halls (a right outside rbac.HALL_SCOPED: halls.manage, audit.read, or those above).
   */
  reachOf(u) {
    const caps = rbac.effective({ ...u, disabled: false }).caps;
    return { admin: rbac.holdsAdminOnly(u), past: [...caps].some((c) => !rbac.HALL_SCOPED.has(c)) };
  }
  /** The accounts lib/keyedstore.js opened: each read by type. Saves nothing. */
  fill(list) {
    this.users = new Map();
    for (const u of Array.isArray(list) ? list : []) if (this.validUser(u)) this.users.set(u.id, u);
  }
  /**
   * The accounts held now become those of `data` (the file's shape, `{users}`; none for anything else), each read by
   * type: an archive's opened against its pin (an archived event continued, or a copy of an event's), or none (a fresh
   * event). Saves nothing: a caller that changed them saves.
   */
  replace(data) { this.fill(data && Array.isArray(data.users) ? data.users : []); }

  /** Ask for a save, written once lib/keyedstore.js says it may be; `twice` for one that takes a right away. */
  save({ twice = false } = {}) {
    if (!this.keyed.writable()) return;
    if (twice) this.keyed.twice();
    this.lane.save(() => this.keyed.seal({ users: Array.from(this.users.values()) }, 1));
  }
  flush() { this.lane.flushSync(); }

  get size() { return this.users.size; }
  get(id) { return typeof id === 'string' ? this.users.get(id) || null : null; }
  byUsername(username) {
    const u = String(username || '').trim().toLowerCase();
    for (const a of this.users.values()) if (a.username === u) return a;
    return null;
  }
  activeAdmins() { let n = 0; for (const a of this.users.values()) if (a.role === 'admin' && !a.disabled) n++; return n; }

  /**
   * What a page may know about an account: never its hash. Its side rooms (`rooms`), its On stage halls (`board`), its
   * chat view (`view`: '' by its seat, 'simple' or 'full'), the clock or countdown the admin chose for it (`clock`:
   * {show, locked}) and what the admin lets it do On stage (`onStage`: {screens, people, clears}, lib/views.js) last, each
   * as stored: none (every switch off) when never set.
   */
  static view(a) {
    if (!a) return null;
    return {
      id: a.id, username: a.username, name: a.name, role: a.role, halls: a.halls || [], allHalls: typeof a.allHalls === 'boolean' ? a.allHalls : null,
      grant: a.grant || [], revoke: a.revoke || [], disabled: !!a.disabled, mustChange: !!a.mustChange,
      createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || 0, pwSetAt: a.pwSetAt || 0, rights: rbac.rightsView(a),
      rooms: Array.isArray(a.rooms) ? a.rooms : [], board: Array.isArray(a.board) ? a.board : [], view: isView(a.view) ? a.view : '',
      clock: views.clockOf(a.clock), onStage: views.onStageOf(a.onStage),
    };
  }
  list() { return Array.from(this.users.values()).map(Accounts.view).sort((x, y) => x.username.localeCompare(y.username)); }

  /**
   * Make an account. Returns {account, password?} (the one-time password when none was given), or {error} ({error,
   * exists} for a first admin when there are accounts already). The name is reserved before its hash is made, so two
   * requests at once never make two accounts of one name, nor two first admins. Its side rooms, On stage halls and chat
   * view are stored only when given (an account made without them is stored as 0.5.1 stored one).
   */
  async create({ username, name, role = 'staff', halls = [], allHalls, rooms = [], board = [], view = '', grant = [], revoke = [], password }, actorId = '', { firstAdmin = false } = {}) {
    const u = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(u)) return { error: 'A username is 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.' };
    if (firstAdmin && (this.users.size > 0 || this.pending.size > 0)) return { error: 'Accounts are set up already — sign in.', exists: true };
    // Never beside accounts held aside, nor where the accounts could not be opened this run: a first admin is made only
    // where none is kept.
    if (firstAdmin && (this.keyed.holding() || !this.keyed.writable())) return { error: 'Adopt the accounts held aside, or start with none, first (Admin → Accounts held aside).', held: true };
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
    const sideRooms = cleanKeys(rooms), onStage = cleanKeys(board);
    const a = {
      id: 'a' + makeId(), username: u, name: display, role, halls: cleanHalls(halls),
      ...(typeof allHalls === 'boolean' ? { allHalls } : {}),
      ...(sideRooms.length ? { rooms: sideRooms } : {}), ...(onStage.length ? { board: onStage } : {}), ...(isView(view) && view ? { view } : {}),
      grant: (grant || []).filter(rbac.isCap), revoke: (revoke || []).filter(rbac.isCap),
      disabled: false, mustChange: temp, pw: hash, pwSetAt: now, epoch: 1,
      createdAt: now, createdBy: String(actorId || ''), lastLoginAt: 0,
    };
    this.users.set(a.id, a);
    this.save({ twice: true });
    return { account: a, password: temp ? pw : undefined };
  }

  /**
   * Set fields an admin may change (checked by the caller with rbac.mayChange). Returns the names of the fields that
   * now hold something else: a field sent as it already is is no change (no reconnect, no audit row). Side rooms and On
   * stage halls are lists of keys, compared as sets; the chat view is '' (by the seat), 'simple' or 'full', and any other
   * value changes nothing (the caller refuses it with words); the clock or countdown, and what it may do On stage, are what
   * their change makes over the one kept (lib/views.js cleanClock, cleanOnStage), and one refused changes nothing (the
   * caller refuses it with words).
   */
  update(id, change) {
    const a = this.get(id);
    if (!a) return null;
    const changed = [];
    if (typeof change.name === 'string') { const n = cleanText(change.name, 40); if (n && n !== a.name) { a.name = n; changed.push('name'); } }
    if (rbac.isRole(change.role) && change.role !== a.role) { a.role = change.role; changed.push('role'); }
    if (Array.isArray(change.halls)) { const h = cleanHalls(change.halls); if (!sameSet(h, a.halls)) { a.halls = h; changed.push('halls'); } }
    if (Array.isArray(change.rooms)) { const r = cleanKeys(change.rooms); if (!sameSet(r, a.rooms)) { a.rooms = r; changed.push('rooms'); } }
    if (Array.isArray(change.board)) { const b = cleanKeys(change.board); if (!sameSet(b, a.board)) { a.board = b; changed.push('board'); } }
    if (isView(change.view) && change.view !== (isView(a.view) ? a.view : '')) {
      if (change.view) a.view = change.view; else delete a.view;
      changed.push('view');
    }
    if ('clock' in change) {
      const next = views.cleanClock(change.clock, views.clockOf(a.clock));
      if (!next.error && !views.sameClock(next, a.clock)) {
        if (views.noClock(next)) delete a.clock; else a.clock = next;
        changed.push('clock');
      }
    }
    if ('onStage' in change) {
      const next = views.cleanOnStage(change.onStage, views.onStageOf(a.onStage));
      if (!next.error && !views.sameOnStage(next, a.onStage)) {
        if (views.noOnStage(next)) delete a.onStage; else a.onStage = next;
        changed.push('onStage');
      }
    }
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
    if (changed.length) this.save({ twice: true });
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
    this.save({ twice: true });
    return true;
  }

  /** End every session of an account (its epoch moves). */
  signOutEverywhere(id) { const a = this.get(id); if (!a) return false; a.epoch = (a.epoch || 1) + 1; this.save({ twice: true }); return true; }

  remove(id) { const ok = this.users.delete(id); if (ok) this.save({ twice: true }); return ok; }

  /**
   * Accounts adopted from a copy held aside (lib/keyedstore.js judged which): each as the copy holds it, or with a
   * one-time password (`reset`), which also asks it to choose its own and ends its sign-ins (its epoch moves), as an
   * admin's reset does. Their hashes made first, then all of them taken in one turn: {accounts, passwords}, the
   * one-time passwords for the page to show once. Saved by the caller, once the hold is lifted.
   */
  async prepareAdoption(rows) {
    const out = [];
    const passwords = [];
    for (const { account, reset } of rows) {
      const a = { ...account };
      if (reset) {
        const pw = temporaryPassword();
        a.pw = await hashPassword(pw);
        a.mustChange = true;
        a.pwSetAt = Date.now();
        a.epoch = (Number.isSafeInteger(a.epoch) && a.epoch > 0 ? a.epoch : 1) + 1;
        passwords.push({ username: a.username, password: pw });
      }
      out.push(a);
    }
    return { accounts: out, passwords };
  }
  /**
   * Accounts prepared for an adoption, taken into the live map: each whose id and username no open account holds. The
   * accounts taken, in order.
   */
  take(list) {
    const taken = [];
    for (const a of list) if (this.validUser(a) && !this.users.has(a.id) && !this.byUsername(a.username)) { this.users.set(a.id, a); taken.push(a); }
    return taken;
  }

  /**
   * Keys of halls and rooms that are gone, taken out of every account that names one: its halls and its On stage halls
   * (`halls`, `board`) and its side rooms (`rooms`). A key no room has reaches nothing, so this changes no right that
   * acts (no page is ended, no account's row is written). Saved through the lane once; returns the ids of the accounts it
   * changed, so a removal that prunes in steps counts each account once.
   */
  prune({ halls = [], rooms = [] } = {}) {
    const fields = [['halls', new Set(halls)], ['board', new Set(halls)], ['rooms', new Set(rooms)]];
    const changed = [];
    for (const a of this.users.values()) {
      let touched = false;
      for (const [field, gone] of fields) {
        if (!Array.isArray(a[field]) || !a[field].some((k) => gone.has(k))) continue;
        a[field] = a[field].filter((k) => !gone.has(k));
        touched = true;
      }
      if (touched) changed.push(a.id);
    }
    if (changed.length) this.save();
    return changed;
  }

  /**
   * Whether an account names `code` among its halls, its On stage halls or its rooms: a new hall or room is made under
   * none of those, so a key an account still holds (one a page saved back after its hall closed, one a room that comes
   * back at the next start keeps) is never opened to it by another hall made later.
   */
  names(code) {
    for (const a of this.users.values()) for (const f of ['halls', 'board', 'rooms']) if (Array.isArray(a[f]) && a[f].includes(code)) return true;
    return false;
  }

  /**
   * Check a username and password: {account, rehash}, or {error, reason} — the same work and the same words for an
   * unknown name, a wrong password and a turned-off account, so the answer never says which names exist or that a
   * password was right; `reason` (unknown, wrong, disabled) is for the audit log only. {busy} or {abandoned} when the
   * check was never hashed (`opts`: {lane, signal}, see scrypt). It changes nothing: a sign-in is stamped (signedIn)
   * and a password stored at an older cost stored again (`rehash`: upgrade) by the caller once it lets the sign-in in,
   * so a sign-in it refuses with the right password costs what a wrong one costs.
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
    return { account: a, rehash: r.rehash };
  }

  /**
   * A sign-in that was let in, with its password stored at an older cost: stored again at today's — the password as it
   * was checked (cut to MAX_PW), and never over one changed while this hash was made.
   */
  async upgrade(a, password, { lane } = {}) {
    const before = a.pw;
    const pw = await hashPassword(String(password || '').slice(0, MAX_PW), SCRYPT, { lane });
    if (a.pw !== before) return;
    a.pw = pw;
    this.save();
  }

  /** A sign-in happened: the Accounts page shows when. */
  signedIn(a) { a.lastLoginAt = Date.now(); this.save(); }
}

const HALL_CODE = /^[A-Z0-9]{4,12}$/;
/**
 * A list of keys as an account keeps it: a hall's (its halls, its On stage halls) or a side room's, each read by type (a
 * name only, never a value made into one), upper case, once, 200 at most; anything else is dropped.
 */
function cleanKeys(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter((c) => typeof c === 'string').map((c) => c.toUpperCase()).filter((c) => HALL_CODE.test(c)))).slice(0, 200);
}
const cleanHalls = cleanKeys;
/** An account's chat view: '' (by its seat: the simple view On stage, the full view elsewhere), 'simple' or 'full'. */
const VIEWS = Object.freeze(['', 'simple', 'full']);
const isView = (v) => typeof v === 'string' && VIEWS.includes(v);
/** The same members, in any order (a missing list is an empty one). */
function sameSet(x, y) {
  const a = [...new Set(x || [])].sort(), b = [...new Set(y || [])].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------- sessions

/** A sign-in's stamp as a start takes it: a time, never more than lib/keyedstore.js AHEAD_MS past now. */
const stampOk = (t, now) => finite(t) && t <= now + AHEAD_MS;

class Sessions {
  /**
   * @param {string} file data/sessions.json
   * @param {Accounts} accounts
   * @param {object} o `keyed`: its part of lib/keyedstore.js
   */
  constructor(file, accounts, { keyed } = {}) {
    this.keyed = keyedOf(keyed, 'the sessions');
    this.accounts = accounts;
    this.lane = new WriteLane(file, { delayMs: 500, keepBak: true, mode: 0o600, ...keyed.laneOptions() });
    this.map = new Map();   // keyed hash of the token -> {h, uid, epoch, created, seen, ip, ua}
    this.kept = [];         // a file's sign-ins that checked, kept while their accounts are not open (restoreKept)
    keyed.attach(this);
  }

  /** A cookie token's keyed hash: the one way a session is looked up. */
  hashOf(token) { return this.keyed.hash('session', token); }

  /**
   * The sign-ins lib/keyedstore.js opened, each read by type: a hash, an account, and stamps neither too old nor ahead of
   * now. `kept`: their accounts are not open, so they are kept apart (nothing resolves, touches or sweeps them) until
   * restoreKept. Returns how many it took.
   */
  fill(list, { kept = false } = {}) {
    const now = Date.now();
    this.map = new Map();
    this.kept = [];
    const good = (Array.isArray(list) ? list : []).filter((s) => s && /^[0-9a-f]{64}$/.test(s.h || '') && typeof s.uid === 'string' && stampOk(s.created, now) && stampOk(s.seen, now) && now - s.created < MAX_AGE_MS && now - s.seen < IDLE_MS);
    if (kept) this.kept = good; else for (const s of good) this.map.set(s.h, s);
    return good.length;
  }
  /** The sign-ins kept while their accounts were not open, put back and pruned against the accounts as they are now. */
  restoreKept() {
    const kept = this.kept;
    this.kept = [];
    for (const s of kept) this.map.set(s.h, s);
    if (!this.prune()) this.save();
  }

  save({ twice = false } = {}) {
    if (!this.keyed.writable()) return;
    if (twice) this.keyed.twice();
    this.lane.save(() => this.keyed.seal({ sessions: Array.from(this.map.values()) }));
  }
  flush() { this.lane.flushSync(); }
  /** Every session ended (a new event): none lets its holder in again, and the file is written so. */
  clear() { this.map.clear(); this.kept = []; this.save({ twice: true }); }

  /** Whether a session still lets its holder in: its account there and on, its epoch current, not too old, not idle. */
  live(s, now = Date.now()) {
    const a = this.accounts.get(s.uid);
    return !!a && !a.disabled && (a.epoch || 1) === s.epoch && now - s.created < MAX_AGE_MS && now - s.seen < IDLE_MS;
  }

  /**
   * A new session for an account: the token goes in the cookie, only its keyed hash is kept. An account keeps its
   * MAX_PER_ACCOUNT newest sessions; past MAX_SESSIONS in all, ended sessions go first, then the oldest of the account
   * with the most — one account signing in again and again never ends another's.
   */
  create(account, { ip = '', ua = '' } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const h = this.hashOf(token);
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
    return this.touch(this.hashOf(token), now);
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

  destroy(token) { if (typeof token === 'string' && this.map.delete(this.hashOf(token))) this.save({ twice: true }); }

  /** The live sessions of one account (for "signed in on" lists): no hashes. */
  of(uid, now = Date.now()) {
    return Array.from(this.map.values()).filter((s) => s.uid === uid && this.live(s, now)).map((s) => ({ created: s.created, seen: s.seen, ip: s.ip, ua: s.ua }));
  }
}

/**
 * The host laptop's admin-token sign-ins (the agm_admin cookie). Like account sessions only a keyed hash of each is kept,
 * on disk through one write lane, so a watchdog restart keeps the dashboard signed in. Each file is tied to the token it
 * was made under (`k`, the token's keyed tag from lib/keyedstore.js, never the token): the next start of AGMessage
 * prints a new token and every earlier sign-in ends. One lasts a day, as its cookie does.
 */
class TokenSessions {
  /**
   * @param {string} file data/admin-sessions.json
   * @param {object} o `keyed`: its part of lib/keyedstore.js; `token`: the laptop's admin token, whose tag names the file
   */
  constructor(file, { keyed, token } = {}) {
    this.keyed = keyedOf(keyed, 'the token\'s sign-ins');
    this.token = String(token || '');
    this.lane = new WriteLane(file, { delayMs: 100, keepBak: true, mode: 0o600, ...keyed.laneOptions() });
    this.map = new Map();   // keyed hash of the cookie's id -> {h, created}
    // The sign-ins this run made, by their hash: one read from the file never counts as made here, whoever wrote it.
    this.minted = new Set();
    keyed.attach(this);
  }

  /** A cookie id's keyed hash. */
  hashOf(sid) { return this.keyed.hash('token sign-in', sid); }
  /** The tag of the token this run runs under. */
  get tag() { return this.keyed.tag(this.token); }

  /**
   * The sign-ins lib/keyedstore.js opened: only a file made under this token (`k`, its tag) keeps any, each read by type,
   * younger than a day and stamped no more than AHEAD_MS ahead of now. A file of another token ends silently.
   */
  fill(list, { k } = {}) {
    const now = Date.now();
    this.map = new Map();
    const tag = this.tag;
    if (typeof k !== 'string' || k.length !== tag.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(tag))) return 0;
    for (const s of Array.isArray(list) ? list : []) {
      if (s && /^[0-9a-f]{64}$/.test(s.h || '') && stampOk(s.created, now) && now - s.created < TOKEN_SESSION_MS) this.map.set(s.h, { h: s.h, created: s.created });
    }
    return this.map.size;
  }

  save({ twice = false } = {}) {
    if (!this.keyed.writable()) return;
    if (twice) this.keyed.twice();
    this.lane.save(() => this.keyed.seal({ k: this.tag, sessions: Array.from(this.map.values()) }));
  }
  flush() { this.lane.flushSync(); }
  /** Every sign-in ended (a new event), those this run made too, and the file written so. */
  clear() { this.map.clear(); this.minted.clear(); this.save({ twice: true }); }

  /** A new sign-in: its id goes in the cookie, only its keyed hash is kept. Those whose day is over go as it comes. */
  create(now = Date.now()) {
    for (const [k, s] of this.map) if (now - s.created >= TOKEN_SESSION_MS) this.map.delete(k);
    const sid = crypto.randomBytes(24).toString('hex');
    const h = this.hashOf(sid);
    this.map.set(h, { h, created: now });
    this.minted.add(h);
    this.save();
    return sid;
  }

  /** Whether a cookie's id is a sign-in that still holds and that this run made (not one read back at start). */
  mintedHere(sid, now = Date.now()) { return this.has(sid, now) && this.minted.has(this.hashOf(sid)); }

  /** Whether a cookie's id is a sign-in that still holds. */
  has(sid, now = Date.now()) {
    if (typeof sid !== 'string' || !sid || sid.length > 64) return false;
    const s = this.map.get(this.hashOf(sid));
    if (!s) return false;
    if (now - s.created >= TOKEN_SESSION_MS) { this.map.delete(s.h); this.save(); return false; }
    return true;
  }

  destroy(sid) { if (typeof sid === 'string' && this.map.delete(this.hashOf(sid))) { this.minted.delete(this.hashOf(sid)); this.save({ twice: true }); } }
}

module.exports = {
  Accounts, Sessions, TokenSessions, validAccount, hashPassword, verifyPassword, parseHash, passwordProblem, temporaryPassword, sha256, cleanKeys, VIEWS, isView,
  SCRYPT, USERNAME, MIN_PW, IDLE_MS, MAX_AGE_MS, TOUCH_MS, MAX_SESSIONS, MAX_PER_ACCOUNT, TOKEN_SESSION_MS, NO_MATCH, LANES,
};
