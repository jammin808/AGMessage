'use strict';
/**
 * The accounts' HTTP side: signing in and out, the first admin, changing a password, managing accounts, the audit log.
 *
 * Every state change is a JSON POST/PATCH/DELETE from the same origin (the Origin header, when a browser sends one, must
 * name this host — a page elsewhere cannot drive it) carrying the SameSite=Strict session cookie. Each answer is
 * {ok:true, …} or {ok:false, error} with words a person can act on. Every change that matters is written to the audit
 * log with who, from where, and what — never a password or a token.
 *
 * Through the Cloudflare tunnel (a request that came in over loopback with Cloudflare's headers) an account with admin
 * rights (users.manage, settings.manage) may not sign in, nor use those rights on a session it has, unless the admin
 * turned on "Admin sign-in through the tunnel"; everyone else may. A refused sign-in gets the same answer as a wrong
 * password, so it never tells a stranger that a password was right.
 */
const { Accounts, passwordProblem, temporaryPassword, NO_MATCH } = require('./accounts');
const rbac = require('./rbac');
const guard = require('./guard');

const COOKIE = 'agm_s';
const TUNNEL_ADMIN = 'Accounts with admin rights work on the venue network, not through the tunnel (an admin can allow it in Settings).';
const BUSY = 'Sign-in is busy — try again in a moment.';
const UNKNOWN_NAME = '(unknown username)';
const FAIL_WORDS = { unknown: 'no such username', wrong: 'wrong password', disabled: 'the account is turned off' };

function mountAccounts(app, o) {
  const { accounts, sessions, audit, settings, isEncrypted, isLoopback, onAccountChanged, onSessionEnded, hallNames } = o;
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

  app.get('/api/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const w = who(req);
    if (!w) return res.json({ ok: true, account: null, setup: accounts.size === 0 });
    res.json({ ok: true, account: Accounts.view(w.account), roles: roleList(), caps: rbac.CAPS });
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

  // The first admin: only while there are no accounts, and only from this laptop (or the host's admin token).
  app.post('/api/setup', async (req, res) => {
    if (accounts.size > 0) return res.status(409).json({ ok: false, error: 'Accounts are set up already — sign in.' });
    if (!(guard.isHostMachine(req) || o.isTokenAdmin(req))) return res.status(403).json({ ok: false, error: 'The first admin account is made on the AGMessage laptop itself.' });
    const b = req.body || {};
    const problem = passwordProblem(b.password, { username: b.username, name: b.name });
    if (problem) return res.status(400).json({ ok: false, error: problem });
    const r = await accounts.create({ username: b.username, name: b.name, role: 'admin', password: b.password }, 'setup', { firstAdmin: true });
    if (r.exists) return res.status(409).json({ ok: false, error: r.error });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    const token = sessions.create(r.account, { ip: guard.clientIp(req), ua: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', cookie(req, token, 7 * 86400));
    audit.write({ t: 'admin', id: 'host', name: 'AGMessage laptop' }, 'setup', r.account.username, 'the first admin account was made', guard.clientIp(req));
    res.json({ ok: true, account: Accounts.view(r.account) });
  });

  // ---------------------------------------------------------------- managing accounts (users.manage)

  const roleList = () => Object.entries(rbac.ROLES).map(([id, r]) => ({ id, label: r.label, allHalls: r.allHalls, caps: r.caps, words: r.words }));

  app.get('/api/users', signedIn('users.manage'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // `locked`: why this viewer may not change that person (empty when they may); `giveable`: the rights and halls this
    // viewer may hand out — the page offers what the server allows.
    const activeAdmins = accounts.activeAdmins();
    const users = accounts.list().map((u) => ({ ...u, sessions: sessions.of(u.id).length, locked: rbac.mayChange(req.agm.account, u, {}, { activeAdmins }) || '' }));
    res.json({ ok: true, users, roles: roleList(), caps: rbac.CAPS, halls: hallNames(), giveable: rbac.giveable(req.agm.account) });
  });

  app.post('/api/users', signedIn('users.manage'), async (req, res) => {
    const b = req.body || {};
    const change = pick(b, ['role', 'grant', 'revoke', 'halls', 'allHalls']);
    const refusal = rbac.mayChange(req.agm.account, null, change, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    if (b.password) { const p = passwordProblem(b.password, { username: b.username, name: b.name }); if (p) return res.status(400).json({ ok: false, error: p }); }
    const r = await accounts.create({ username: b.username, name: b.name, role: b.role, halls: b.halls, allHalls: b.allHalls, grant: b.grant, revoke: b.revoke, password: b.password || undefined }, req.agm.account.id);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    audit.write(actorOf(req.agm), 'user.create', r.account.username, 'role ' + r.account.role + hallWords(r.account), guard.clientIp(req));
    res.json({ ok: true, user: Accounts.view(r.account), password: r.password });
  });

  app.patch('/api/users/:id', signedIn('users.manage'), (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: 'No such account.' });
    const change = pick(req.body || {}, ['name', 'role', 'grant', 'revoke', 'halls', 'allHalls', 'disabled']);
    const refusal = rbac.mayChange(req.agm.account, target, change, { activeAdmins: accounts.activeAdmins() });
    if (refusal) return res.status(403).json({ ok: false, error: refusal });
    const changed = accounts.update(target.id, change);
    if (changed.length) {
      onAccountChanged(target.id, changed.join(','));
      audit.write(actorOf(req.agm), 'user.update', target.username, changed.map((f) => f + ' → ' + describe(f, target)).join('; '), guard.clientIp(req));
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

  // ---------------------------------------------------------------- the audit log (audit.read)

  app.get('/api/audit', signedIn('audit.read'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, entries: audit.latest(Number(req.query.limit) || 200) });
  });
  // The check reads every file of the chain off the event loop, in slices; clicks while one runs share it.
  app.get('/api/audit/verify', signedIn('audit.read'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await audit.verify()) });
  });

  return { who, signedIn, actorOf, throughTunnel, adminBlocked, COOKIE };
}

function pick(o, keys) { const out = {}; for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k]; return out; }
function hallWords(a) { const e = rbac.effective(a); return e.allHalls ? ', every hall' : ', halls ' + (Array.from(e.halls).join(' ') || 'none'); }
function describe(field, a) {
  switch (field) {
    case 'role': return a.role;
    case 'halls': case 'allHalls': return hallWords(a).slice(2);
    case 'grant': return (a.grant || []).join(' ') || 'none';
    case 'revoke': return (a.revoke || []).join(' ') || 'none';
    case 'disabled': return a.disabled ? 'turned off' : 'turned on';
    case 'name': return a.name;
    default: return 'changed';
  }
}

module.exports = { mountAccounts, COOKIE };
