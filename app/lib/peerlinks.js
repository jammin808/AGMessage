'use strict';
/**
 * Links to Patterns and PlayMap (Show Bus 1.2): read what they are doing, and drive them — within their own rules.
 *
 *  - Read: each linked node's context (GET /api/context, §6) every 5 s with its token in a header — X-Patterns-Token for
 *    Patterns, X-PlayMap-Token for PlayMap — never in a URL. Its light, headline, items, recent lines and the verbs it
 *    lists (`commands`, each with its risk) are shown on the halls board and the admin page, and go to the AI's brief.
 *    Live while answers come, stale after 12 s without one; a refused token says so.
 *  - Drive: only a verb the node itself lists in its context (fail closed: anything else is refused before it is sent),
 *    rated as the node rates the line: its listed risk, raised by the words the node says raise it (riskWhen, highFor —
 *    from the context, or PlayMap's GET /api/verbs), and for a line that carries a line (BIND … TO <line>) at least the
 *    carried line's risk. A low- or review-risk line may be sent now (POST /api/cmd, one line → the node's receipt: the
 *    request id rides as X-Request-Id for PlayMap, as Patterns' "@id " prefix for Patterns); a high-risk one is only
 *    ever proposed to the show desk (Show Bus §11), where a person approves it and the node collects it with its own
 *    key. Either way the node's own checks still apply. A verb's secret words (a pairing token) are never written down.
 *  - TLS: when the node's hello announces a certificate, the address is https:// or the node is pinned, the certificate
 *    is fetched and checked against the pin for that node before anything — the token above all — is sent (lib/tls.js
 *    PinStore). A changed one is refused until the admin accepts the one presented (acceptCertificate).
 */
const crypto = require('crypto');
const tlsmod = require('./tls');

const STALE_MS = 12_000;
const POLL_MS = 5_000;
const KINDS = new Set(['patterns', 'playmap']);
const RISKS = new Set(['low', 'review', 'high']);
const HEADER = { patterns: 'X-Patterns-Token', playmap: 'X-PlayMap-Token' };

/** The literal words a verb template starts with ("VIDEO END <seconds>" → ["VIDEO", "END"]) (pure). */
function verbWords(template) {
  const out = [];
  for (const w of String(template || '').trim().split(/\s+/)) {
    if (!w || /^[<[{(]/.test(w) || /[|]/.test(w)) break;
    out.push(w.toLowerCase());
  }
  return out;
}

// A node's own word-level rules it publishes nowhere yet, by kind and verb: PlayMap rates ASSISTANT SET enabled / provider
// high (VerbCatalog HighFor) but lists neither its context nor GET /api/verbs with it. Joined to what the node lists.
const UNLISTED_HIGH_FOR = { playmap: { 'assistant set': ['ENABLED', 'PROVIDER'] } };
const RANK = { low: 0, review: 1, high: 2 };
const higher = (a, b) => (RANK[b] > RANK[a] ? b : a);
const MAX_CARRIED = 4;   // lines carrying lines carrying lines…: past this depth the line is high (PlayMap's MaxEmbedding)
// Carried lines a line's rating reads, at every depth together, before the line counts as high (PlayMap's
// MaxCarriedReadings): a line of bindings carrying bindings is never read on and on.
const MAX_READINGS = 256;
const SECRET_SLOTS = new Set(['token', 'key', 'secret', 'password', 'pass']);

/** A template whose line carries another line: a slot named "…line>" (BIND ADD … TO <target line>), or the node says so. */
const carriesLine = (entry) => entry.embedsLine === true || /<[^<>]*\bline>/i.test(entry.verb);
/** The line is exactly one of the template's forms that has no slot ("BIND LEARN OFF"): it carries nothing. */
const isFixedForm = (template, words) => String(template).split(/\s+\|\s+/).some((f) => {
  const fw = f.trim().split(/\s+/);
  return fw.length === words.length && fw.every((w, i) => !/[<[{|]/.test(w) && w.toLowerCase() === words[i]);
});
/**
 * Where each line a carrying line could be read to carry starts (PlayMap's CarriedReadings): after every TO for a
 * "TO <…line>" row (an input's own words may hold one — the riskiest reading counts), else after an optional "FROM <x>".
 */
function carriedStarts(template, words, n) {
  if (!/\bTO\s+<[^<>]*\bline>/i.test(template)) return [words[n] === 'from' ? n + 2 : n];
  const out = [];
  for (let i = n; i < words.length; i++) if (words[i] === 'to') out.push(i + 1);
  return out;
}
/** The "target" strings (in any case, at any depth) of a JSON argument — the lines it carries — or null when it is not JSON. */
function jsonTargets(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  const out = [];
  const walk = (v, d) => {
    if (d > 8 || out.length > 32 || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) { if (/^target$/i.test(k) && typeof x === 'string') out.push(x); else walk(x, d + 1); }
  };
  walk(j, 0);
  return out;
}
const firstOf = (a, b) => (a < 0 ? b : b < 0 ? a : Math.min(a, b));

/**
 * The node's own entry for a line, rated as the node rates that line, or null — a line no listed verb starts is never
 * sent (pure). The risk starts at the row's, is raised (never lowered: fail closed) by a riskWhen rule its words match
 * (the word at argument `arg`, or anywhere after the verb for -1) and to high by a highFor first argument, and a line
 * that carries a line takes at least the carried line's risk — high when that is JSON, quoted, unlisted or too deep.
 * `secretFrom` is the word its secret starts at — its own verb's, or that of a line it carries (a binding to LINK
 * PATTERNS <host> <token>; a JSON argument holding one is kept back whole) — and `secrets` the words that are secret.
 */
function matchCommand(commands, line, depth = 0, budget = { left: MAX_READINGS }) {
  const raw = String(line || '').trim().split(/\s+/).filter(Boolean);
  const words = raw.map((w) => w.toLowerCase());
  let best = null;
  for (const c of Array.isArray(commands) ? commands : []) {
    const v = verbWords(c && c.verb);
    if (!v.length || v.length > words.length) continue;
    if (v.every((w, i) => words[i] === w) && (!best || v.length > best.n)) best = { n: v.length, entry: c };
  }
  if (!best) return null;
  const { n, entry } = best;
  let risk = RISKS.has(entry.risk) ? entry.risk : 'high';
  for (const r of Array.isArray(entry.riskWhen) ? entry.riskWhen : []) {
    const want = String(r.word).toLowerCase();
    if (r.arg >= 0 ? words[n + r.arg] === want : words.slice(n).includes(want)) risk = higher(risk, r.risk);
  }
  if (Array.isArray(entry.highFor) && n < words.length && entry.highFor.some((h) => String(h).toLowerCase() === words[n])) risk = 'high';
  const own = secretFrom(entry.verb);
  let secret = own >= 0 && raw.length > own ? own : -1;
  const inner = [];   // secret words a JSON argument's carried lines hold
  const carried = (text) => (--budget.left < 0 || depth >= MAX_CARRIED ? null : matchCommand(commands, text, depth + 1, budget));
  if (carriesLine(entry) && !isFixedForm(entry.verb, words)) {
    const json = raw.findIndex((w, i) => i >= n && w.startsWith('{'));
    if (json >= 0) {
      risk = 'high';
      const targets = jsonTargets(raw.slice(json).join(' '));
      // A JSON argument no reader can read may hold anything: it is kept back if it names a verb that carries a secret.
      const holds = targets ? targets.some((t) => { const m = carried(t); if (m && m.secretFrom >= 0) inner.push(...m.secrets); return m && m.secretFrom >= 0; })
        : (Array.isArray(commands) ? commands : []).some((c) => secretFrom(c && c.verb) >= 0 && verbWords(c.verb).length && raw.slice(json).join(' ').toLowerCase().includes(verbWords(c.verb).join(' ')));
      if (holds) secret = firstOf(secret, json);
    } else {
      for (const at of carriedStarts(String(entry.verb), words, n)) {
        const tail = raw.slice(at);
        if (!tail.length) continue;
        // A quoted carried line is read as the node may read it, without its quotes, for its secret; its risk is high.
        const quoted = tail.some((w) => w.includes('"'));
        const m = carried(tail.map((w) => w.replace(/"/g, '') || '""').join(' '));
        risk = quoted || !m ? 'high' : higher(risk, m.risk);
        if (m && m.secretFrom >= 0) secret = firstOf(secret, at + m.secretFrom);
      }
    }
  }
  return {
    verb: String(entry.verb).slice(0, 120), risk, words: String(entry.words || '').slice(0, 200),
    secretFrom: secret, secrets: (secret >= 0 ? raw.slice(secret).concat(inner) : inner).flatMap((w) => (w.includes('"') ? [w, w.replace(/"/g, '')] : [w])),
  };
}

/**
 * The word a verb's secret starts at (PlayMap's SecretFrom), from its template's first form: the first slot named token,
 * key, secret, password or pass ("<key|action>" is not one), stepping back over optional slots just before it — the
 * secret's place is unknown when they are left out. -1 when it carries none (pure).
 */
function secretFrom(template) {
  const w = String(template || '').split(/\s+\|\s+/)[0].trim().split(/\s+/);
  let at = w.findIndex((x) => { const m = /^\[?<([a-z]+)>\]?$/i.exec(x); return !!m && SECRET_SLOTS.has(m[1].toLowerCase()); });
  if (at < 0) return -1;
  while (at > 0 && /^\[.*\]$/.test(w[at - 1])) at--;
  return at;
}
/** The line as it may be written down (an audit row): its words from `from` on as "…" (pure). */
function redactLine(line, from) {
  const w = String(line || '').trim().split(/\s+/);
  return from >= 0 && w.length > from ? w.slice(0, from).concat('…').join(' ') : String(line || '').trim();
}
/** Any of the secret words in what a node answered, as "…" (pure). */
function redactWords(text, secrets) {
  let t = String(text || '');
  for (const sw of secrets || []) if (sw) t = t.split(sw).join('…');
  return t;
}

/** A command row's own risk rules, cleaned and bounded (pure): riskWhen [{arg, word, risk}], highFor [words], embedsLine. */
function readRules(c) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    riskWhen: (Array.isArray(c.riskWhen) ? c.riskWhen : []).slice(0, 8)
      .filter((r) => r && Number.isInteger(r.arg) && r.arg >= -1 && r.arg < 32 && typeof r.word === 'string' && r.word && RISKS.has(r.risk))
      .map((r) => ({ arg: r.arg, word: str(r.word, 32), risk: r.risk })),
    highFor: (Array.isArray(c.highFor) ? c.highFor : []).slice(0, 16).filter((h) => typeof h === 'string' && h).map((h) => h.slice(0, 32)),
    embedsLine: c.embedsLine === true,
  };
}
/** PlayMap's vocabulary (GET /api/verbs): each row's own risk rules by its syntax, the key its context lists it by (pure). */
function readVerbRules(j) {
  const rules = new Map();
  for (const v of (Array.isArray(j) ? j : []).slice(0, 1000)) if (v && typeof v.syntax === 'string') rules.set(v.syntax.slice(0, 120), readRules(v));
  return rules;
}
/** The listed commands with the node's rules for each: its context's own and its vocabulary's together (pure). */
const withRules = (commands, rules) => (commands || []).map((c) => {
  const r = rules && rules.get(c.verb);
  if (!r) return c;
  return { ...c, riskWhen: (c.riskWhen || []).concat(r.riskWhen), highFor: (c.highFor || []).concat(r.highFor), embedsLine: c.embedsLine === true || r.embedsLine };
});

/** A node's context, cleaned and bounded (pure). Null when it is not one. */
function readContext(j) {
  if (!j || typeof j !== 'object' || j.v !== 1 || !j.node) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const light = ['grey', 'green', 'amber', 'red'].includes(j.light) ? j.light : 'grey';
  return {
    light, headline: str(j.headline, 200),
    items: (Array.isArray(j.items) ? j.items : []).slice(0, 40).map((i) => ({ id: str(i && i.id, 60), kind: str(i && i.kind, 24), label: str(i && i.label, 80), light: ['grey', 'green', 'amber', 'red'].includes(i && i.light) ? i.light : 'grey', state: str(i && i.state, 120) })),
    recent: (Array.isArray(j.recent) ? j.recent : []).slice(-20).map((r) => ({ at: Number(r && r.at) || 0, text: str(r && r.text, 160) })),
    commands: (Array.isArray(j.commands) ? j.commands : []).slice(0, 256).filter((c) => c && typeof c.verb === 'string').map((c) => ({ verb: str(c.verb, 120), risk: RISKS.has(c.risk) ? c.risk : 'high', words: str(c.words, 200), ...readRules(c) })),
  };
}

/**
 * A node's answer to a command, as a receipt (pure): Show Bus receipts (PlayMap's {type:"receipt", stage, effect, error}),
 * Patterns' {ok, msg} — its wire's OK / ERR words, with HTTP 200 even for ERR — or the wire's OK / ERR lines.
 */
function readReceipt(status, body, text, id) {
  if (body && typeof body === 'object' && typeof body.msg === 'string' && body.type !== 'receipt' && typeof body.stage !== 'string') {
    return readReceipt(status, null, body.msg, typeof body.id === 'string' ? body.id : id);
  }
  if (body && typeof body === 'object') {
    if (status >= 400 || body.ok === false) return { ok: false, stage: 'refused', error: String(body.error || body.words || ('said ' + status)).slice(0, 200) };
    return { ok: true, id: typeof body.id === 'string' ? body.id : id, stage: body.stage === 'applied' ? 'applied' : 'accepted', effect: String(body.effect || body.words || '').slice(0, 200) };
  }
  const t = String(text || '').trim();
  const first = t.split(/\s/, 1)[0].toUpperCase();
  if (status < 400 && first === 'OK') return { ok: true, id, stage: 'applied', effect: wordsAfter(t).slice(0, 200) };
  return { ok: false, stage: 'refused', error: ((first === 'ERR' || first === 'ERROR' ? wordsAfter(t) : t) || 'said ' + status).slice(0, 200) };
}
/** "OK @a1 Clip ends in 10 s" → "Clip ends in 10 s": the words after the verdict and its request id (no pattern). */
function wordsAfter(line) {
  let rest = line.slice(line.split(/\s/, 1)[0].length).trimStart();
  if (rest.startsWith('@')) { const sp = rest.search(/\s/); rest = sp < 0 ? '' : rest.slice(sp).trimStart(); }
  return rest;
}

class PeerLink {
  /**
   * @param {object} o
   * @param {{t:string,id:string,name:string}} o.node
   * @param {string} o.base http(s)://host:port
   * @param {string} o.token
   * @param {object} o.pins a tls.PinStore
   * @param {()=>void} o.onPins the pins changed
   * @param {(id:string)=>object|null} o.findPeer the discovery table, by node id
   * @param {()=>void} o.onChange the light, headline or status changed
   */
  constructor({ node, base, token, hall = '', pins, onPins, findPeer, onChange }) {
    if (!KINDS.has(node.t)) throw new Error('a link is to Patterns or PlayMap');
    this.node = node; this.base = base; this.token = token; this.hall = hall;
    this.pins = pins; this.onPins = onPins || (() => {}); this.findPeer = findPeer || (() => null); this.onChange = onChange || (() => {});
    this.status = 'connecting'; this.problem = ''; this.context = null; this.okAt = 0; this.endpoint = null;
    this.tlsState = null;   // {fp, nodeKey, changed} while a certificate is refused
    this.rules = null;      // PlayMap's own risk rules per verb (GET /api/verbs), read once per connection
    // Whether a line can be rated yet: PlayMap's rules read (or known absent: an older build serves none). Until then
    // nothing is sent now — a line its rules raise to high must never go out as its row's lower risk.
    this.rulesKnown = node.t !== 'playmap';
    this.busy = false;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
    this.poll();
  }

  _set(status, problem = '') {
    if (status === this.status && problem === this.problem) return;
    this.status = status; this.problem = problem;
    this.onChange();
  }

  /**
   * TLS is wanted when the address is https://, the hello announces a certificate, or the node is pinned: the hello is
   * unauthenticated (anyone can send one without tls, and none is heard right after a restart), so once pinned a node is
   * never talked to in plain HTTP again (Show Bus §10: the pin, not the hello, is the trust).
   */
  _wantsTls(peer = this.findPeer(this.node.id)) {
    return new URL(this.base).protocol === 'https:' || !!(peer && peer.tls) || !!this.pins.pins['node:' + this.node.id];
  }

  /** Where and how to reach the node: plain, or pinned TLS. Null when it may not be talked to. */
  async _resolve() {
    const u = new URL(this.base);
    const peer = this.findPeer(this.node.id);
    if (!this._wantsTls(peer)) return { base: this.base, tls: null };
    // The https port: the address's own when it is https://, else the one the hello names, else the address's (a node that
    // serves both on one port); a node with another HTTPS port is unreachable — nothing sent — until its hello is heard.
    const port = (u.protocol === 'https:' && Number(u.port)) || (peer && peer.ports && peer.ports.https) || Number(u.port) || 443;
    const nodeKey = 'node:' + this.node.id;
    const cert = await tlsmod.probeCertificate(u.hostname, port);
    const verdict = this.pins.check(nodeKey, cert.fp, (peer && peer.tls) || '');
    // What the admin is shown, and accepts: the certificate presented now, never one fetched again at accept time.
    this.tlsState = verdict.ok ? null : { fp: cert.fp, nodeKey, changed: !!verdict.changed };
    if (!verdict.ok) { this._set('refused', verdict.reason); return null; }
    return { base: 'https://' + u.hostname + ':' + port, tls: tlsmod.pinnedTlsOptions(cert.pem, cert.fp), fp: cert.fp, nodeKey };
  }

  /** The admin accepts a changed certificate: pin the one that was refused, then read the node again. False when none was. */
  acceptCertificate() {
    const s = this.tlsState;
    if (!s || !s.changed) return false;
    this.pins.accept(s.nodeKey, s.fp);
    this.onPins();
    this.tlsState = null; this.endpoint = null;
    this._set('connecting');
    this.poll();
    return true;
  }

  _headers(extra = {}) { return { [HEADER[this.node.t]]: this.token, ...extra }; }

  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // A link that resolved plain moves to TLS as soon as TLS is wanted, without waiting for an error.
      if (!this.endpoint || (!this.endpoint.tls && this._wantsTls())) this.endpoint = await this._resolve();
      if (!this.endpoint) return;
      const res = await tlsmod.request(this.endpoint.base + '/api/context', { headers: this._headers(), timeoutMs: 3000, tls: this.endpoint.tls });
      if (res.status === 401 || res.status === 403) { this._set('refused', 'the node refused the token — link it again with its current one'); return; }
      const ctx = readContext(res.body);
      if (!ctx) { this._set('error', 'no context in its answer (' + res.status + ')'); return; }
      if (this.endpoint.tls && this.pins.confirm(this.endpoint.nodeKey, this.endpoint.fp)) this.onPins();
      if (this.node.t === 'playmap' && this.endpoint.rules === undefined) this.endpoint.rules = await this._readRules();
      const changed = !this.context || this.context.light !== ctx.light || this.context.headline !== ctx.headline;
      this.context = ctx; this.okAt = Date.now();
      if (this.endpoint.rules !== undefined) { this.rules = this.endpoint.rules; this.rulesKnown = true; }   // else: asked again at the next poll
      if (changed) this.onChange();
      this._set('live');
    } catch (e) {
      const certRefused = !!(this.endpoint && this.endpoint.tls) && /CERT|SIGNATURE/.test(String((e && e.code) || '') + ' ' + String((e && e.message) || ''));
      this.endpoint = null;
      if (Date.now() - this.okAt > STALE_MS) this._set(this.okAt ? 'stale' : 'unreachable', e && e.message ? String(e.message).slice(0, 80) : '');
      // The node no longer serves the pinned certificate: say so now (its certificate probed against the pin), not after
      // the stale wait — the admin sees which certificate it presents and may accept it.
      if (certRefused) {
        try { this.endpoint = await this._resolve(); } catch { /* unreachable: the next poll says so */ }
      }
    } finally { this.busy = false; }
  }

  /**
   * PlayMap's own risk rules per verb (its vocabulary); null when it serves none (404: an older build — the listed risks
   * stand); undefined when it could not be read now (unreachable, busy, an odd answer), so the next poll asks again.
   */
  async _readRules() {
    try {
      const res = await tlsmod.request(this.endpoint.base + '/api/verbs', { headers: this._headers(), timeoutMs: 3000, tls: this.endpoint.tls });
      if (res.status === 200 && Array.isArray(res.body)) return readVerbRules(res.body);
      return res.status === 404 ? null : undefined;
    } catch { return undefined; }
  }

  /** The verbs it lists, each with the node's rules for rating a line: what a command is matched against. */
  commandTable() {
    const known = UNLISTED_HIGH_FOR[this.node.t] || {};
    return this.context ? withRules(this.context.commands, this.rules).map((c) => {
      const extra = known[verbWords(c.verb).join(' ')];
      return extra ? { ...c, highFor: (c.highFor || []).concat(extra) } : c;
    }) : [];
  }

  /** Send one line now. The caller checked it is a listed, non-high verb. Returns the node's receipt. */
  async send(line) {
    if (this.status !== 'live' || !this.endpoint) return { ok: false, stage: 'not sent', error: 'The link to ' + this.node.name + ' is ' + this.status + ' — not sent (nothing is queued).' };
    const id = 'agm' + crypto.randomBytes(5).toString('hex');
    // Patterns reads the request id only as the line's "@id " prefix (Show Bus §3 on its wire); PlayMap takes the header.
    const body = this.node.t === 'patterns' ? '@' + id + ' ' + line : line;
    try {
      const res = await tlsmod.request(this.endpoint.base + '/api/cmd', { method: 'POST', headers: this._headers({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Request-Id': id }), body, timeoutMs: 4000, tls: this.endpoint.tls });
      return readReceipt(res.status, res.body, res.text, id);
    } catch (e) {
      return { ok: false, stage: 'not sent', error: 'unreachable: ' + (e && e.message ? String(e.message).slice(0, 80) : '') };
    }
  }

  /** What a page may know about the link: never its token. */
  view() {
    const c = this.context;
    return {
      id: this.node.id, t: this.node.t, name: this.node.name, hall: this.hall, status: this.status, problem: this.problem,
      certificateChanged: !!(this.tlsState && this.tlsState.changed), certificate: this.tlsState ? this.tlsState.fp : '',
      light: this.status === 'live' && c ? c.light : this.status === 'refused' ? 'red' : 'amber',
      headline: c ? c.headline : '', items: c ? c.items : [], recent: c ? c.recent : [], commands: c ? c.commands.map((x) => ({ verb: x.verb, risk: x.risk, words: x.words })) : [],
      age: this.okAt ? Math.round((Date.now() - this.okAt) / 1000) : null,
    };
  }

  stop() { this.stopped = true; clearInterval(this.timer); }
}

module.exports = { PeerLink, verbWords, matchCommand, readContext, readReceipt, readVerbRules, withRules, secretFrom, redactLine, redactWords, KINDS };
