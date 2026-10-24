'use strict';
/**
 * Links to Patterns and PlayMap (Show Bus 1.2): read what they are doing, and drive them — within their own rules.
 *
 *  - Read: each linked node's context (GET /api/context, §6) every 5 s with its token in a header — X-Patterns-Token for
 *    Patterns, X-PlayMap-Token for PlayMap — never in a URL. Its light, headline, items, recent lines and the verbs it
 *    lists (`commands`, each with its risk) are shown on the halls board and the admin page, and go to the AI's brief.
 *    Live while answers come, stale after 12 s without one; a refused token says so.
 *  - Drive: only a verb the node itself lists in its context (fail closed: anything else is refused before it is sent).
 *    A low- or review-risk verb may be sent now (POST /api/cmd, one line, X-Request-Id → the node's receipt); a
 *    high-risk one is only ever proposed to the show desk (Show Bus §11), where a person approves it and the node
 *    collects it with its own key. Either way the node's own checks still apply.
 *  - TLS: when the node's hello announces a certificate (or the address is https://), the certificate is fetched and
 *    checked against the pin for that node before anything — the token above all — is sent (lib/tls.js PinStore).
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

/** The node's own entry for a line, or null — a line no listed verb starts is never sent (pure). */
function matchCommand(commands, line) {
  const words = String(line || '').trim().split(/\s+/).map((w) => w.toLowerCase());
  let best = null;
  for (const c of Array.isArray(commands) ? commands : []) {
    const v = verbWords(c && c.verb);
    if (!v.length || v.length > words.length) continue;
    if (v.every((w, i) => words[i] === w) && (!best || v.length > best.n)) best = { n: v.length, entry: c };
  }
  if (!best) return null;
  return { verb: String(best.entry.verb).slice(0, 120), risk: RISKS.has(best.entry.risk) ? best.entry.risk : 'high', words: String(best.entry.words || '').slice(0, 200) };
}

/** A node's context, cleaned and bounded (pure). Null when it is not one. */
function readContext(j) {
  if (!j || typeof j !== 'object' || j.v !== 1 || !j.node) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const light = ['grey', 'green', 'amber', 'red'].includes(j.light) ? j.light : 'grey';
  return {
    light, headline: str(j.headline, 200),
    items: (Array.isArray(j.items) ? j.items : []).slice(0, 40).map((i) => ({ id: str(i && i.id, 60), kind: str(i && i.kind, 24), label: str(i && i.label, 80), light: ['grey', 'green', 'amber', 'red'].includes(i && i.light) ? i.light : 'grey', state: str(i && i.state, 120) })),
    recent: (Array.isArray(j.recent) ? j.recent : []).slice(-20).map((r) => ({ at: Number(r && r.at) || 0, text: str(r && r.text, 160) })),
    commands: (Array.isArray(j.commands) ? j.commands : []).slice(0, 256).filter((c) => c && typeof c.verb === 'string').map((c) => ({ verb: str(c.verb, 120), risk: RISKS.has(c.risk) ? c.risk : 'high', words: str(c.words, 200) })),
  };
}

/** A node's answer to a command, as a receipt (pure): JSON receipts, or the wire's OK / ERR lines. */
function readReceipt(status, body, text, id) {
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

  /** Where and how to reach the node: plain, or pinned TLS. Null when it may not be talked to. */
  async _resolve() {
    const u = new URL(this.base);
    const peer = this.findPeer(this.node.id);
    const wantTls = u.protocol === 'https:' || !!(peer && peer.tls);
    if (!wantTls) return { base: this.base, tls: null };
    const port = Number(u.port) || (peer && peer.ports && peer.ports.https) || 443;
    const nodeKey = 'node:' + this.node.id;
    const cert = await tlsmod.probeCertificate(u.hostname, port);
    const verdict = this.pins.check(nodeKey, cert.fp, (peer && peer.tls) || '');
    if (!verdict.ok) { this._set('refused', verdict.reason); return null; }
    return { base: 'https://' + u.hostname + ':' + port, tls: tlsmod.pinnedTlsOptions(cert.pem, cert.fp), fp: cert.fp, nodeKey };
  }

  _headers(extra = {}) { return { [HEADER[this.node.t]]: this.token, ...extra }; }

  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!this.endpoint) this.endpoint = await this._resolve();
      if (!this.endpoint) return;
      const res = await tlsmod.request(this.endpoint.base + '/api/context', { headers: this._headers(), timeoutMs: 3000, tls: this.endpoint.tls });
      if (res.status === 401 || res.status === 403) { this._set('refused', 'the node refused the token — link it again with its current one'); return; }
      const ctx = readContext(res.body);
      if (!ctx) { this._set('error', 'no context in its answer (' + res.status + ')'); return; }
      if (this.endpoint.tls && this.pins.confirm(this.endpoint.nodeKey, this.endpoint.fp)) this.onPins();
      const changed = !this.context || this.context.light !== ctx.light || this.context.headline !== ctx.headline;
      this.context = ctx; this.okAt = Date.now();
      if (changed) this.onChange();
      this._set('live');
    } catch (e) {
      this.endpoint = null;
      if (Date.now() - this.okAt > STALE_MS) this._set(this.okAt ? 'stale' : 'unreachable', e && e.message ? String(e.message).slice(0, 80) : '');
    } finally { this.busy = false; }
  }

  /** Send one line now. The caller checked it is a listed, non-high verb. Returns the node's receipt. */
  async send(line) {
    if (this.status !== 'live' || !this.endpoint) return { ok: false, stage: 'not sent', error: 'The link to ' + this.node.name + ' is ' + this.status + ' — not sent (nothing is queued).' };
    const id = 'agm' + crypto.randomBytes(5).toString('hex');
    try {
      const res = await tlsmod.request(this.endpoint.base + '/api/cmd', { method: 'POST', headers: this._headers({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Request-Id': id }), body: line, timeoutMs: 4000, tls: this.endpoint.tls });
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
      light: this.status === 'live' && c ? c.light : this.status === 'refused' ? 'red' : 'amber',
      headline: c ? c.headline : '', items: c ? c.items : [], recent: c ? c.recent : [], commands: c ? c.commands : [],
      age: this.okAt ? Math.round((Date.now() - this.okAt) / 1000) : null,
    };
  }

  stop() { this.stopped = true; clearInterval(this.timer); }
}

module.exports = { PeerLink, verbWords, matchCommand, readContext, readReceipt, KINDS };
