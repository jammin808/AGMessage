'use strict';
/**
 * The accounts' HTTP side: signing in and out, the first admin, changing a password, managing accounts, the audit log,
 * its signed export, and its split into a signed archive at an archive point.
 *
 * Every state change is a JSON POST/PATCH/DELETE from the same origin (the Origin header, when a browser sends one, must
 * name this host — a page elsewhere cannot drive it) carrying the SameSite=Strict session cookie. Each answer is
 * {ok:true, …} or {ok:false, error} with words a person can act on. Every change that matters is written to the audit
 * log with who, from where, and what — never a password or a token.
 *
 * Through the Cloudflare tunnel (a request that came in over loopback with Cloudflare's headers) an account with admin
 * rights (users.manage, settings.manage, audit.export) may not sign in, nor use those rights on a session it has, unless
 * the admin turned on "Admin sign-in through the tunnel"; everyone else may. A refused sign-in gets the same answer as a wrong
 * password, so it never tells a stranger that a password was right.
 *
 * The accounts are opened by lib/keyedstore.js (`stores`): while they are held aside, or could not be opened at this
 * start, every account sign-in is refused at once with why, and no first admin is made. The token at the laptop reads the
 * copy held aside and adopts its accounts, or starts with none (Admin → Accounts held aside).
 */
const { Accounts, passwordProblem, temporaryPassword, isView, NO_MATCH } = require('./accounts');
const rbac = require('./rbac');
const guard = require('./guard');
const views = require('./views');

const COOKIE = 'agm_s';
const TUNNEL_ADMIN = 'Accounts with admin rights work on the venue network, not through the tunnel (an admin can allow it in Settings).';
const BUSY = 'Sign-in is busy — try again in a moment.';
const UNKNOWN_NAME = '(unknown username)';
const FAIL_WORDS = { unknown: 'no such username', wrong: 'wrong password', disabled: 'the account is turned off' };

function mountAccounts(app, o) {
  const { accounts, sessions, stores, audit, settings, isEncrypted, isLoopback, onAccountChanged, onSessionEnded, hallNames, roomNames } = o;
  const ipBuckets = new guard.Buckets(0.5, 5, 5000);
  // Wrong passwords for a username count where they come from: a device on the venue network by its address, the whole
  // tunnel as one place (anyone on the internet is there). A stranger's guesses hold that username only where the
  // stranger is, and never on the AGMessage laptop; twenty from one address hold that address. A signed-in person's
  // own password change counts on its session alone.
  const userLock = new guard.Lockout(5, 15 * 60_000);
  const ipLock = new guard.Lockout(20, 15 * 60_000);
  const pwLock = new guard.Lockout(5, 15 * 60_000);

  const throughTunnel = (req) => { const h = req.headers || {}; return !!(h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h.forwarded); };
  /** Admin rights through the tunnel while the admin has not allowed them: judged on every request, not only at sign-in. */
  const adminBlocked = (req, a) => throughTunnel(req) && !settings.remoteAdmin && rbac.holdsAdminOnly(a);
  // The browser's own scheme: our TLS, or Cloudflare saying the visitor used HTTPS — believed only over loopback, which
  // is how cloudflared reaches us, so a device on the venue network cannot claim it.
  const browserHttps = (req) => {
    if (isEncrypted(req)) return true;
    if (!isLoopback(req) || !throughTunnel(req)) return false;
    const h = req.headers || {};
    return /"scheme"\s*:\s*"https"/.test(String(h['cf-visitor'] || '')) || String(h['x-forwarded-proto'] || '').toLowerCase() === 'https';
  };
  const cookie = (req, token, maxAge) => COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (browserHttps(req) ? '; Secure' : '');
  /** Where a request's password check waits (the tunnel's lane or the venue's); it leaves the queue when the request goes. */
  function hashOpts(req, res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    return { lane: throughTunnel(req) ? 'tunnel' : 'venue', signal: ac.signal };
  }

  /** The signed-in account for a request: {account, session, token} or null. */
  function who(req) {
    const token = guard.readCookie(req.headers.cookie, COOKIE);
    const r = token ? sessions.resolve(token) : null;
    return r ? { ...r, token } : null;
  }
  const actorOf = (w) => (w ? { t: 'account', id: w.account.id, name: w.account.username } : { t: 'system', id: '', name: '' });

  // A browser's state change must come from this origin. (Non-browser clients send no Origin; the cookie is
  // SameSite=Strict, so a cross-site page cannot carry it anyway.)
  function sameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = ''; }   // an Origin that is not a URL names no host: refused below
      if (!host || host !== req.headers.host) return res.status(403).json({ ok: false, error: 'This request came from another site.' });
    }
    next();
  }
  app.use('/api', sameOrigin);

  /** Routes for a signed-in account; `cap` (optional) is checked too. An account with a one-time password may only change it. */
  const signedIn = (cap) => (req, res, next) => {
    const w = who(req);
    if (!w) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    if (w.account.mustChange) return res.status(403).json({ ok: false, error: 'Choose your own password first.', mustChange: true });
    if (cap && !rbac.can(w.account, cap)) return res.status(403).json({ ok: false, error: 'Your account may not do that.' });
    if (cap && rbac.ADMIN_ONLY.has(cap) && adminBlocked(req, w.account)) return res.status(403).json({ ok: false, error: TUNNEL_ADMIN });
    req.agm = w;
    next();
  };

  // ---------------------------------------------------------------- signing in

  app.post('/api/auth/login', async (req, res) => {
    const ip = guard.clientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase().slice(0, 40);
    const password = String((req.body && req.body.password) || '');
    const host = guard.isHostMachine(req);
    const where = username + '|' + (throughTunnel(req) ? 'tunnel' : ip);
    if (!ipBuckets.take(ip) || ipLock.locked(ip) || (!host && userLock.locked(where))) return res.status(429).json({ ok: false, error: 'Too many attempts — wait a few minutes and try again.' });
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Type your username and password.' });
    // Accounts held aside, or not opened at this start: refused at once, no hash run, and the typed name never written.
    const closed = stores.signInRefusal();
    if (closed) {
      audit.write({ t: 'account', id: '', name: UNKNOWN_NAME }, 'login.refused', UNKNOWN_NAME, 'accounts are not open: ' + (stores.heldFacts() || {}).state, ip);
      return res.status(503).json({ ok: false, error: closed, held: true });
    }
    // Every refusal says the same: an unknown name, a wrong password, a turned-off account, and admin rights through the
    // tunnel (with the right password) are told apart only in the audit log.
    const noMatch = NO_MATCH + (throughTunnel(req) && !settings.remoteAdmin ? ' Accounts with admin rights sign in on the venue network, not through the tunnel.' : '');
    const failed = () => { if (!host) userLock.fail(where); ipLock.fail(ip); };
    const opts = hashOpts(req, res);
    const r = await accounts.authenticate(username, password, opts);
    if (r.abandoned) return undefined;   // the request went before its turn: nobody is waiting for the answer
    if (r.busy) return res.status(429).json({ ok: false, error: BUSY, busy: true });
    if (r.error) {
      failed();
      // An account that waits for the token at the first start is no account until it is opened: refused as an unknown
      // name is, its own name never in the row.
      if (r.reason === 'unknown' && stores.waits(username)) {
        audit.write({ t: 'account', id: '', name: UNKNOWN_NAME }, 'login.refused', UNKNOWN_NAME, 'waiting for the token at the laptop', ip);
        return res.status(401).json({ ok: false, error: noMatch });
      }
      // A name that is no account may be a password typed into the wrong box: it is never written down.
      const known = accounts.byUsername(username);
      audit.write(known ? actorOf({ account: known }) : { t: 'account', id: '', name: UNKNOWN_NAME }, 'login.fail', known ? known.username : UNKNOWN_NAME, FAIL_WORDS[r.reason] || 'refused', ip);
      return res.status(401).json({ ok: false, error: noMatch });
    }
    const a = r.account;
    if (adminBlocked(req, a)) {
      failed();
      audit.write(actorOf({ account: a }), 'login.refused', a.username, 'admin rights through the tunnel', ip);
      return res.status(401).json({ ok: false, error: noMatch });
    }
    // Only now, let in: a password stored at an older cost is stored again at today's.
    if (r.rehash) await accounts.upgrade(a, password, opts);
    userLock.ok(where); ipLock.ok(ip);
    const token = sessions.create(a, { ip, ua: req.headers['user-agent'] });
    accounts.signedIn(a);
    res.setHeader('Set-Cookie', cookie(req, token, 7 * 86400));
    audit.write(actorOf({ account: a }), 'login', a.username, a.mustChange ? 'signed in with a one-time password' : 'signed in', ip);
    res.json({ ok: true, account: Accounts.view(a), mustChange: !!a.mustChange });
  });

  app.post('/api/auth/logout', (req, res) => {
    const w = who(req);
    if (w) {
      sessions.destroy(w.token);
      onSessionEnded(w.session.h);   // the pages this session has open are told and closed, not left with its rights
      audit.write(actorOf(w), 'logout', w.account.username, 'signed out', guard.clientIp(req));
    }
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  });

  // `held`, last: why account sign-ins wait (accounts held aside, waiting at the first start, or not opened at this start),
  // or null, as the sign-in page says it (lib/keyedstore.js pageFacts); while it is set no first admin is made (`setup`
  // false).
  const heldForPages = () => stores.pageFacts();
  app.get('/api/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const w = who(req);
    if (!w) return res.json({ ok: true, account: null, setup: accounts.size === 0 && !stores.setupRefusal(), held: heldForPages() });
    res.json({ ok: true, account: Accounts.view(w.account), roles: roleList(), caps: rbac.CAPS, held: heldForPages() });
  });

  app.post('/api/auth/password', async (req, res) => {
    const w = who(req);
    if (!w) return res.status(401).json({ ok: false, error: 'Sign in first.' });
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');
    if (pwLock.locked(w.session.h)) return res.status(429).json({ ok: false, error: 'Too many attempts — wait a few minutes and try again.' });
    const check = await accounts.authenticate(w.account.username, current, hashOpts(req, res));
    if (check.abandoned) return undefined;
    if (check.busy) return res.status(429).json({ ok: false, error: BUSY, busy: true });
    if (check.error) {
      pwLock.fail(w.session.h);
      audit.write(actorOf(w), 'password.fail', w.account.username, 'wrong current password', guard.clientIp(req));
      return res.status(401).json({ ok: false, error: 'Your current password is not right.' });
    }
    pwLock.ok(w.session.h);
    if (next === current) return res.status(400).json({ ok: false, error: 'Choose a password you have not used here.' });
    const problem = passwordProblem(next, { username: w.account.username, name: w.account.name });
    if (problem) return res.status(400).json({ ok: false, error: problem });
    await accounts.setPassword(w.account.id, next, { mustChange: false });
    onAccountChanged(w.account.id, 'password');
    const token = sessions.create(w.account, { ip: guard.clientIp(req), ua: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', cookie(req, token, 7 * 86400));
    audit.write(actorOf(w), 'password.change', w.account.username, 'changed their password; other sessions signed out', guard.clientIp(req));
    res.json({ ok: true });
  });

  // The first admin: only while there are no accounts, only on this laptop, and only with its token: typed into the form,
  // or, when none is typed, the token's sign-in made by this run (a sign-in read back from its file is a record anyone who
  // could write the data folder could add). A token typed is always judged, a sign-in beside it or not. Loopback alone
  // never makes one: a second Windows account on the laptop reaches it too.
  app.post('/api/setup', async (req, res) => {
    if (accounts.size > 0) return res.status(409).json({ ok: false, error: 'Accounts are set up already — sign in.' });
    const held = stores.setupRefusal();
    if (held) return res.status(409).json({ ok: false, error: held, held: true });
    if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'The first admin account is made on the AGMessage laptop itself, with its token.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const typed = typeof b.token === 'string' && b.token.trim() !== '';
    const bySignIn = !typed && o.tokenHere(req);
    if (!bySignIn) {
      const no = o.typedToken(req, b.token, 'setup');
      if (no) return res.status(no.status).json({ ok: false, error: no.error });
    }
    const problem = passwordProblem(b.password, { username: b.username, name: b.name });
    if (problem) return res.status(400).json({ ok: false, error: problem });
    const r = await accounts.create({ username: b.username, name: b.name, role: 'admin', password: b.password }, 'setup', { firstAdmin: true });
    if (r.exists || r.held) return res.status(409).json({ ok: false, error: r.error });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const token = sessions.create(r.account, { ip: guard.clientIp(req), ua: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', cookie(req, token, 7 * 86400));
    audit.write({ t: 'admin', id: 'host', name: 'AGMessage laptop' }, 'setup', r.account.username, 'the first admin account was made, ' + (bySignIn ? 'by the token\'s sign-in' : 'with the token typed') + ' at the laptop', guard.clientIp(req));
    res.json({ ok: true, account: Accounts.view(r.account) });
  });

  // ---------------------------------------------------------------- managing accounts (users.manage)

  const roleList = () => Object.entries(rbac.ROLES).map(([id, r]) => ({ id, label: r.label, allHalls: r.allHalls, caps: r.caps, words: r.words }));

  // The side rooms an account may be given, by key, each with its name and its hall's (keys only, never a guest code).
  const sideRooms = () => new Map(roomNames().map((r) => [r.key, r]));
  /**
   * Why the lists and the chat view a change sets may not be taken, or '': its halls, side rooms and On stage halls are
   * each a list of names (a value that is not a name is refused, never made into one), and an entry it adds that the
   * account does not hold already names a side room that is here (`rooms`) or a hall that is here (`board`), so a key
   * typed wrong is said, never kept to open a room made later, and an On stage hall it adds is one the account as changed
   * would sit On stage in (it reaches the hall and may post there); an entry already on the account passes, so a Save that
   * sends its lists back as they are changes nothing. Its halls keep 0.5.1's rule: a hall's key is taken as given. The
   * chat view is '' (by the seat), 'simple' or 'full'; the clock or countdown is one lib/views.js cleanClock makes over
   * the account's, and what it may do On stage one cleanOnStage makes.
   */
  function listsRefusal(change, target) {
    for (const [field, what] of [['halls', 'halls'], ['board', 'On stage halls'], ['rooms', 'rooms']]) {
      if (!(field in change)) continue;
      const list = change[field];
      if (!Array.isArray(list) || !list.every((k) => typeof k === 'string')) return 'An account\'s ' + what + ' are a list of their keys.';
    }
    const held = (field) => new Set((target && Array.isArray(target[field]) ? target[field] : []));
    const added = (field) => (Array.isArray(change[field]) ? change[field].map((k) => k.toUpperCase()).filter((k) => !held(field).has(k)) : []);
    const named = hallNames();
    const halls = new Set(named.map((h) => h.code));
    for (const k of added('board')) if (!halls.has(k)) return 'No such hall: ' + guard.cleanText(k, 40) + '.';
    // An On stage seat given is one the account takes: it reaches the hall and may post there (rbac.unseatedOnStage, as
    // the join seats it), so a page never says "On stage" of an account that would sit there as an observer.
    const unseated = rbac.unseatedOnStage(target, change);
    if (unseated) {
      const h = named.find((x) => x.code === unseated.hall);
      const hall = (h && h.name) || unseated.hall;
      return unseated.why === 'hall' ? 'On stage in ' + hall + ' needs ' + hall + ' too: give its Main room with the seat.' : 'Reads only in ' + hall + ': On stage needs Send messages.';
    }
    const rooms = sideRooms();
    for (const k of added('rooms')) {
      if (!rooms.has(k)) return halls.has(k) ? k + ' is a hall: its Main room comes with the hall.' : 'No such room: ' + guard.cleanText(k, 40) + '.';
    }
    if ('view' in change && !isView(change.view)) return 'A chat view is By seat (\'\'), Simple (\'simple\') or Full (\'full\').';
    if ('clock' in change) { const c = views.cleanClock(change.clock, views.clockOf(target && target.clock)); if (c.error) return c.error; }
    if ('onStage' in change) { const o = views.cleanOnStage(change.onStage, views.onStageOf(target && target.onStage)); if (o.error) return o.error; }
    return '';
  }

  app.get('/api/users', signedIn('users.manage'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // `locked`: why this viewer may not change that person (empty when they may); `giveable`: the rights and halls this
    // viewer may hand out — the page offers what the server allows. A hall's code is a guest's way in, so a viewer who
    // does not reach every hall is told only the halls it reaches: on the list, and on each person's row and its On stage
    // halls (`otherHalls` counts the rest). A row it may edit holds no other hall (rbac.exceeds would lock it), so a save
    // drops none. Side rooms likewise, by `giveableRooms`: the admin is told every room (`rooms`, each by key with its name
    // and its hall's), anyone else the rooms it is given itself, on the list and on each row (`otherRooms` counts the rest).
    const activeAdmins = accounts.activeAdmins();
    const giveable = rbac.giveable(req.agm.account);
    const giveableRooms = rbac.giveableRooms(req.agm.account);
    const reaches = (code) => giveable.allHalls || giveable.halls.includes(code);
    const holds = (key) => giveableRooms.all || giveableRooms.rooms.includes(key);
    const users = accounts.list().map((u) => {
      const row = { ...u, sessions: sessions.of(u.id).length, locked: rbac.mayChange(req.agm.account, u, {}, { activeAdmins }) || '' };
      if (giveable.admin) return row;
      const rooms = u.rights.rooms.filter(holds);
      const told = { ...row, rights: { ...u.rights, rooms }, rooms: u.rooms.filter(holds), otherRooms: u.rights.rooms.length - rooms.length };
      if (giveable.allHalls) return told;
      const halls = u.rights.halls.filter(reaches);
      return {
        ...told, halls: u.halls.filter(reaches), board: u.board.filter(reaches), rights: { ...told.rights, halls, board: u.rights.board.filter(reaches) },
        otherHalls: u.rights.halls.length - halls.length,
      };
    });
    const rooms = roomNames().filter((r) => holds(r.key)).map((r) => ({ key: r.key, name: r.name, hall: reaches(r.hall) ? r.hall : '', hallName: r.hallName }));
    // `capGroups`: the rights in the page's three groups (rbac.CAP_GROUPS), each by its rights' names. `leftOut`, last: to an
    // account whose role is admin, the accounts an adoption left out and keeps aside, in words ('' when none).
    const held = stores.heldFacts();
    const leftOut = req.agm.account.role === 'admin' && held && held.state === 'left' ? held.words : '';
    res.json({ ok: true, users, roles: roleList(), caps: rbac.CAPS, halls: hallNames().filter((h) => reaches(h.code)), giveable, rooms, giveableRooms, capGroups: rbac.CAP_GROUPS, leftOut });
  });

  app.post('/api/users', signedIn('users.manage'), async (req, res) => {
    const b = req.body || {};
    const change = pick(b, ['role', 'grant', 'revoke', 'halls', 'allHalls', 'rooms', 'board', 'view']);
    const refusal = rbac.mayChange(req.agm.account, null, change, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    const wrong = listsRefusal(change, null);
    if (wrong) return res.status(400).json({ ok: false, error: wrong });
    if (b.password) { const p = passwordProblem(b.password, { username: b.username, name: b.name }); if (p) return res.status(400).json({ ok: false, error: p }); }
    const r = await accounts.create({ username: b.username, name: b.name, role: b.role, halls: b.halls, allHalls: b.allHalls, rooms: b.rooms, board: b.board, view: b.view, grant: b.grant, revoke: b.revoke, password: b.password || undefined }, req.agm.account.id);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const named = sideRooms();
    const more = ['rooms', 'board', 'view'].filter((f) => f in r.account).map((f) => '; ' + f + ' → ' + describe(f, r.account, named)).join('');
    audit.write(actorOf(req.agm), 'user.create', r.account.username, 'role ' + r.account.role + hallWords(r.account) + more, guard.clientIp(req));
    res.json({ ok: true, user: Accounts.view(r.account), password: r.password });
  });

  app.patch('/api/users/:id', signedIn('users.manage'), (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: 'No such account.' });
    const change = pick(req.body || {}, ['name', 'role', 'grant', 'revoke', 'halls', 'allHalls', 'disabled', 'rooms', 'board', 'view', 'clock', 'onStage']);
    const refusal = rbac.mayChange(req.agm.account, target, change, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    // What an account may do On stage is the admin's alone to choose (an account whose role is admin; plan 7-§17.6): a
    // manager who may change everything else of the account is refused it, whatever it names.
    if ('onStage' in change && req.agm.account.role !== 'admin') return res.status(403).json({ ok: false, error: views.ON_STAGE_ADMIN });
    const wasOnStage = views.onStageOf(target.onStage);
    // The clock or countdown's lock is the admin's alone (an account whose role is admin): whoever manages the account may
    // choose for it, and a change that names the lock as it stands changes no lock.
    const wasClock = views.clockOf(target.clock);
    if ('clock' in change && locksClock(change.clock, wasClock) && req.agm.account.role !== 'admin') return res.status(403).json({ ok: false, error: views.CLOCK_ADMIN });
    const wrong = listsRefusal(change, target);
    if (wrong) return res.status(400).json({ ok: false, error: wrong });
    const changed = accounts.update(target.id, change);
    if (changed.length) {
      // A change of the chat view, the clock or what it may do On stage alone is said to the account's pages, which stay
      // open (none is a right); any other change ends them, so their next connection is judged by the account as it is now.
      onAccountChanged(target.id, changed.join(','));
      const named = sideRooms();
      const said = (f) => (f === 'clock' ? clockChangeWords(target.clock, wasClock) : f === 'onStage' ? views.onStageSaid(target.onStage, wasOnStage) : describe(f, target, named));
      audit.write(actorOf(req.agm), 'user.update', target.username, changed.map((f) => f + ' → ' + said(f)).join('; '), guard.clientIp(req));
    }
    res.json({ ok: true, user: Accounts.view(target), changed });
  });

  app.post('/api/users/:id/password', signedIn('users.manage'), async (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: 'No such account.' });
    const refusal = rbac.mayChange(req.agm.account, target, {}, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    if (target.role === 'admin' && req.agm.account.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin may reset an admin\'s password.' });
    const password = temporaryPassword();
    await accounts.setPassword(target.id, password, { mustChange: true });
    userLock.forget((k) => k.startsWith(target.username + '|'));   // the new one-time password works at once
    onAccountChanged(target.id, 'password');
    audit.write(actorOf(req.agm), 'user.reset', target.username, 'one-time password issued; signed out everywhere', guard.clientIp(req));
    res.json({ ok: true, password });
  });

  app.post('/api/users/:id/signout', signedIn('users.manage'), (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: 'No such account.' });
    const refusal = rbac.mayChange(req.agm.account, target, {}, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    accounts.signOutEverywhere(target.id);
    onAccountChanged(target.id, 'signout');
    audit.write(actorOf(req.agm), 'user.signout', target.username, 'signed out everywhere', guard.clientIp(req));
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', signedIn('users.manage'), (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: 'No such account.' });
    const refusal = rbac.mayChange(req.agm.account, target, { disabled: true }, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    accounts.remove(target.id);
    onAccountChanged(target.id, 'removed');
    audit.write(actorOf(req.agm), 'user.remove', target.username, 'account removed', guard.clientIp(req));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- accounts held aside (the token at the laptop)
  // The copy held aside, and adopting its accounts (lib/keyedstore.js judges, lib/accounts.js takes them). Only the person
  // at the AGMessage laptop who has its token: the panel is read by the token's sign-in made by this run, and an adoption
  // takes the token typed (judged first, as the first admin account's is), since it vouches for data this machine cannot
  // check. No account adopts: none can sign in while accounts are held aside, and whoever wrote the folder could have
  // written one. The one-time passwords go in the answer alone, once, over loopback.
  const HELD_HERE = 'Open the accounts held aside at the AGMessage laptop itself, signed in with its token.';
  app.get('/api/accounts/held', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!guard.isHostMachine(req) || !o.tokenHere(req)) return res.status(403).json({ ok: false, error: HELD_HERE });
    const r = stores.heldView(Array.from(accounts.users.values()), (a) => Accounts.view(a));
    const { status, ...answer } = r;
    return res.status(status || 200).json(answer);
  });
  const isList = (v) => (Array.isArray(v) ? v : []);
  const idOf = (v) => (typeof v === 'string' ? v.slice(0, 48) : '');
  let adopting = false;
  app.post('/api/accounts/adopt', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'Adopt accounts at the AGMessage laptop itself, with its token.' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const no = o.typedToken(req, b.token, 'adoption');
    if (no) return res.status(no.status).json({ ok: false, error: no.error });
    if (adopting) return res.status(409).json({ ok: false, error: 'An adoption is being made now: wait for it, then read the copy again.' });
    const ask = {
      digest: typeof b.digest === 'string' ? b.digest.slice(0, 64) : '',
      adopt: isList(b.adopt).slice(0, 5000).filter((x) => x && typeof x === 'object').map((x) => ({ id: idOf(x.id), reset: x.reset === true })),
      confirm: isList(b.confirm).slice(0, 5000).map(idOf), keep: isList(b.keep).slice(0, 5000).map(idOf),
    };
    const open = Array.from(accounts.users.values());
    const j = stores.judgeAdoption(ask, open);
    if (j.status) return res.status(j.status).json({ ok: false, error: j.error });
    adopting = true;
    try {
      const made = await accounts.prepareAdoption(j.rows);
      // Only the accounts taken are adopted: one whose id or username an account made meanwhile (during the hashes) holds
      // is not, is said, and stays in the copy for Adopt more….
      const taken = accounts.take(made.accounts);
      const tookIds = new Set(taken.map((a) => a.id));
      const passwords = made.passwords.filter((p) => taken.some((a) => a.username === p.username));
      const notTaken = made.accounts.filter((a) => !tookIds.has(a.id)).map((a) => a.username);
      const all = Array.from(accounts.users.values());
      const after = stores.adopted(all, { leaveRest: j.fresh });
      // Saved twice and flushed before the answer: the record, written as the first write lands, then says the hold ended.
      accounts.save({ twice: true });
      accounts.flush();
      sessions.restoreKept();
      const ip = guard.clientIp(req);
      const names = taken.map((a) => a.username);
      if (j.fresh) {
        audit.write(o.hostActor, 'accounts.fresh', 'accounts', (open.length ? 'left the rest out' : 'started with no accounts') + '; ' + (after.why ? after.why + ', and its accounts were left out' : after.left + ' kept aside in ' + after.file), ip);
      } else {
        const reset = passwords.map((p) => p.username);
        const some = reset.length > 5 ? reset.slice(0, 5).join(', ') + ' and ' + (reset.length - 5) + ' more' : reset.join(', ');
        audit.write(o.hostActor, 'accounts.adopted', 'accounts', 'adopted ' + names.length + (reset.length ? ' (one-time passwords: ' + some + ')' : '') + '; ' + after.left + ' left out' + (notTaken.length ? '; not adopted, an account of its name made meanwhile: ' + notTaken.slice(0, 5).join(', ') : ''), ip);
      }
      // `held`, last: what is held aside now, as /api/admin/me tells the admin (stores.heldFacts), so the page draws the
      // one-time passwords and the panel's new state from this one answer, and no read after it holds them back.
      return res.json({ ok: true, adopted: names, passwords, left: after.left, notTaken, held: stores.heldFacts() });
    } finally { adopting = false; }
  });

  // ---------------------------------------------------------------- the audit log (audit.read)

  // Each row carries its mark at the end: ✓ checked under this key, ◇ or △ inside a span (by that span's state now),
  // ✕ a row that failed its check or a line that is not a whole entry.
  // `key`, at the end: the log's key id and the signing key's fingerprint, which an export is checked against; both ''
  // in a run with no machine key, whose key id names a key made for that run alone. Then `archives`, every archive the
  // newest whole check named (H.10.4), and `unreached`, this log's archive folders that chain does not reach.
  app.get('/api/audit', signedIn('audit.read'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entries = audit.latest(Number(req.query.limit) || 200);
    res.json({ ok: true, entries, key: { kid: audit.keyless ? '' : audit.kid, fingerprint: o.signKey() }, archives: audit.archives.map((a) => ({ ...a })), unreached: audit.unreached.slice() });
  });
  // The check reads every file of the chain off the event loop, in slices; clicks while one runs share it. The laptop's
  // token at the laptop checks too (Admin → Health, before its Accept). `ok` is the check's: true only for ✓. With
  // `?archive=<name>`, that archive is checked alone (H.10.3): its signature, its files, its entries and their MACs, and
  // what pins it (the split's pin, this laptop's signing key); Checks of one archive asked together share one walk.
  const auditReader = (req, res, next) => (guard.isHostMachine(req) && o.isTokenAdmin(req) ? next() : signedIn('audit.read')(req, res, next));
  app.get('/api/audit/verify', auditReader, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.archive === undefined) return res.json(await audit.verify());
    const r = await o.archiver.checkArchive(typeof req.query.archive === 'string' ? req.query.archive.slice(0, 40) : '');
    const { status, ...answer } = r;
    return res.status(status || 200).json(answer);
  });

  // ---------------------------------------------------------------- the split (the admin, H.10.2)
  /**
   * "The admin" over HTTP (H.10.2, the Board addendum's §17.6): whom the admin page admits (`isAdminReq`, its tunnel rule
   * included), and then the laptop's token or an account whose role is admin. A manager an admin granted settings.manage
   * passes the admin page, and is refused here.
   */
  const theAdminReq = (req) => {
    if (!o.isAdminReq(req)) return false;
    if (o.isTokenAdmin(req)) return true;
    const w = who(req);
    return !!(w && w.account.role === 'admin');
  };
  const NOT_ADMIN = 'Only an admin may split the audit log.';
  /** Who the split's rows name: the laptop's token, or the admin's account. */
  const adminActor = (req) => (o.isTokenAdmin(req) ? o.hostActor : actorOf(who(req)));
  // The archive points a split may be made at, newest first, each with what it would move or why not; a split not finished.
  app.get('/api/audit/split', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!theAdminReq(req)) return res.status(403).json({ ok: false, error: NOT_ADMIN });
    return res.json(await o.archiver.points());
  });
  // Split at the archive point `seq` (a POST from this origin, as the export): at a split not finished, finish it.
  app.post('/api/audit/split', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!theAdminReq(req)) return res.status(403).json({ ok: false, error: NOT_ADMIN });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await o.archiver.split(Number.isSafeInteger(b.seq) ? b.seq : 0, adminActor(req), guard.clientIp(req));
    const { status, ...answer } = r;
    return res.status(status || 200).json(answer);
  });

  // ---------------------------------------------------------------- the signed export (audit.export, with audit.read)
  // Who may export (H.9.1): the laptop's token at the laptop, signed in by this run (a sign-in read back from the file
  // after a restart never counts), or an account holding audit.export (admin-only: kept off the tunnel unless admins may
  // sign in there) and audit.read, since an export reads every entry. From another device only over HTTPS: the bundle
  // holds the names and addresses of the whole log. Never a code guest, a screen, a node or the context token.
  const httpsWords = (req) => {
    if (!o.httpsOn()) return 'Export at the AGMessage laptop: HTTPS is off on this AGMessage, and from another device an export goes only over HTTPS.';
    const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 80);
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    const where = throughTunnel(req) ? 'https://' + name : 'https://' + name + ':' + o.port;
    return 'Export over HTTPS: open ' + where + ' (trust this AGMessage\'s certificate once: /tls).';
  };
  const exporter = (req, res, next) => {
    if (guard.isHostMachine(req) && o.isTokenAdmin(req)) {
      if (!o.tokenHere(req)) return res.status(403).json({ ok: false, error: 'Sign in again with the token (Admin login): a sign-in from before the restart cannot export.' });
      req.agmExport = o.hostActor;
      return next();
    }
    return signedIn('audit.export')(req, res, () => {
      if (!rbac.can(req.agm.account, 'audit.read')) return res.status(403).json({ ok: false, error: 'An export reads every entry: your account needs audit.read as well as audit.export.' });
      if (!guard.isHostMachine(req) && !browserHttps(req)) return res.status(403).json({ ok: false, error: httpsWords(req) });
      req.agmExport = actorOf(req.agm);
      return next();
    });
  };
  app.post('/api/audit/export', exporter, (req, res) => o.exporter.run(res, req.agmExport, guard.clientIp(req)));

  return { who, signedIn, actorOf, throughTunnel, adminBlocked, theAdminReq, COOKIE };
}

function pick(o, keys) { const out = {}; for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k]; return out; }
function hallWords(a) { const e = rbac.effective(a); return e.allHalls ? ', every hall' : ', halls ' + (Array.from(e.halls).join(' ') || 'none'); }
/**
 * An account's side rooms as a row names them: each by its name, its hall's name and its key ("Legal (Hall 2)
 * LGQ4MZP8"), a key no room has any more by the key alone. A side room's key is an address, never a guest code.
 */
function roomWords(a, named) {
  const list = (Array.isArray(a.rooms) ? a.rooms : []).map((k) => {
    const r = named.get(k);
    return r ? (r.name || 'a room with no name') + ' (' + (r.hallName || 'a hall with no name') + ') ' + k : k;
  });
  return list.join(', ') || 'none';
}
const VIEW_WORDS = { '': 'by seat', simple: 'simple', full: 'full' };
/** Whether a change of the clock (`asked`, as sent) moves its lock from where `was` holds it: a boolean that is not it. */
const locksClock = (asked, was) => (asked === null ? was.locked : !!asked && typeof asked === 'object' && typeof asked.locked === 'boolean' && asked.locked !== was.locked);
/** An account's clock as an audit row says its change: the choice, and the lock where it holds or was just taken off. */
function clockChangeWords(now, was) {
  const lock = views.lockWords(now, was);
  return views.clockWords(now) + (lock ? ' (' + lock + ')' : '');
}
/** What a field of an account holds now, in an audit row's words: never a password, a token or a guest code. */
function describe(field, a, named = new Map()) {
  switch (field) {
    case 'role': return a.role;
    case 'halls': case 'allHalls': return hallWords(a).slice(2);
    case 'grant': return (a.grant || []).join(' ') || 'none';
    case 'revoke': return (a.revoke || []).join(' ') || 'none';
    case 'disabled': return a.disabled ? 'turned off' : 'turned on';
    case 'name': return a.name;
    case 'rooms': return roomWords(a, named);
    case 'board': return (Array.isArray(a.board) && a.board.length ? 'On stage in ' + a.board.join(' ') : 'none');
    case 'view': return VIEW_WORDS[isView(a.view) ? a.view : ''];
    default: return 'changed';
  }
}

module.exports = { mountAccounts, COOKIE };
