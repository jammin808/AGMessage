'use strict';
/**
 * AGMessage as a node of the show network (Show Bus 1.1 — docs/SHOWBUS.md).
 *
 *  - Discovery: one channel, the hello on UDP 9928. AGMessage says {"t":"messenger"} every 2 s and listens to every
 *    kind (Stagewatch "main", Slides "agent", "patterns", "playmap", other messengers). A peer is live while hellos come,
 *    stale after 6 s, gone after 12 s. The hello says what a node is, never what the meeting is doing. Anyone can send
 *    one, so the table is bounded (MAX_PEERS, MAX_PER_ADDRESS) and its change is told at most every CHANGE_MS.
 *  - Stagewatch link: a WebSocket for the live timer (key in the Authorization header on the upgrade — never in the
 *    URL), a ping every 2 s that also measures the clock offset, stale after 6 s of silence and redialled after 12 s
 *    (backoff 0.5 → 5 s with jitter). "Send to stage" carries a request id and reads Stagewatch's receipt (accepted /
 *    applied, and the message id the speaker's acknowledgement will carry). Nothing is queued while the link is down:
 *    a send fails at once and says so.
 *  - Context: AGMessage fetches Stagewatch's /api/context (for the AI's brief and the admin page) and posts its own
 *    to Stagewatch (/api/peers/context) — counts and action-prompt titles only, never message text.
 *  - 1.2 §10: when Stagewatch's hello carries "tls", the URL is https://, a fingerprint is typed or the certificate is
 *    pinned, the link is https/wss. Before anything is sent — the key above all — the certificate is fetched and checked
 *    against the pins for that node and that address (trust on first authenticated use; a change is refused as
 *    CERTIFICATE CHANGED until the admin accepts it). Each request then trusts exactly that certificate.
 *  - 1.2 §11: Stagewatch as the show desk (cap "approvals"): proposals go there, their state is read back, and approved
 *    proposals aimed at AGMessage are collected and their results reported.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const { ClockSampler, Ring } = require('./resilience');
const tlsmod = require('./tls');
const { departmentsOf } = require('./stagelines');
const { holdMs } = require('./deskresults');

const BUS_PORT = 9928;
const BEAT_MS = 2000;
const STALE_MS = 6000;
const GONE_MS = 12000;
// The peers table is fed by unauthenticated UDP: a flood of fresh ids must not grow it, nor what it is pushed to.
const MAX_PEERS = 256;          // a venue's show network is tens of nodes
const MAX_PER_ADDRESS = 8;      // one machine runs a few nodes (Stagewatch, its Slides agents, Patterns, PlayMap…)
const CHANGE_MS = 500;          // the table's change is told at most this often, latest wins
// Stagewatch locks an address out for the rest of a minute after 5 wrong keys or PINs from it (WebServer.cs Authorize):
// a key it refused is tried again only after that minute, so a wrong key never locks out this machine's other links.
const REFUSED_RETRY_MS = 61_000;
// The desk is asked whether it is one once a minute (when no hello says so), and again 5 s after an answer that said nothing.
const DESK_CHECK_MS = 60_000;
const DESK_RECHECK_MS = 5000;
// Stagewatch counts wrong keys per asking address, 5 in a minute locking it out, whichever link of this machine they
// came from. Every key a link of this process had refused at a Stagewatch (host:port) is remembered for that minute: a
// first refusal when it comes; a refused key asked again from when it dials (so two links due at once cannot both see
// room) and, refused again, from then (so its slot covers both its wrong attempts, the later one included).
// A refused link asks again only while that Stagewatch has room for its two attempts (the upgrade, then the read or the
// viewing-code check): at most one other there in the last minute, so never more than four wrong a minute.
const LOCKOUT_MS = 60_000;
const refusalsAt = new Map();   // host:port -> when links of this process were refused there, the last minute only
function recentRefusals(host, now, windowMs) {
  const kept = (refusalsAt.get(host) || []).filter((t) => now - t < windowMs);
  if (kept.length) refusalsAt.set(host, kept); else refusalsAt.delete(host);
  return kept;
}
/** How long a refused link must still wait before it may ask `host` again (0: now). */
function lockoutRoomIn(host, windowMs = LOCKOUT_MS, now = Date.now()) {
  const kept = recentRefusals(host, now, windowMs);
  return kept.length <= 1 ? 0 : kept[kept.length - 2] + windowMs - now + 1;
}
function noteRefusal(host, windowMs = LOCKOUT_MS, now = Date.now()) { refusalsAt.set(host, recentRefusals(host, now, windowMs).concat(now)); return now; }
/** A refused key asked again was refused again: its slot runs from now. */
function moveRefusal(host, from, now = Date.now()) {
  const list = refusalsAt.get(host) || [];
  const i = list.indexOf(from);
  if (i >= 0) list.splice(i, 1);   // gone already when the asking outlasted the minute: recorded anew either way
  list.push(now);
  refusalsAt.set(host, list);
}
/** Stagewatch's words for a refusal, as a status may show them: plain text, short, and never a key. */
const refusalWords = (w) => (typeof w === 'string' ? w : '').replace(/\p{Cc}/gu, ' ').replace(/swk_\S*/g, 'swk_…').replace(/\s+/g, ' ').trim().slice(0, 120);
// Every kind on the bus: Stagewatch (main), its Slides agents, Patterns, PlayMap (Show Bus 1.3 proposal) and other messengers.
const KINDS = new Set(['main', 'agent', 'patterns', 'playmap', 'messenger']);
// What this node is on the bus: its hello's t, and the t its Stagewatch links announce on /ws.
const KIND = 'messenger';
// A Show Bus id as Stagewatch keeps one for a /ws link (Screens.ValidId: 6-32 letters, digits, '-' or '_') and for a context's
// node.id (PeerContexts.Parse: letters, digits, '-' or '_'); AGMessage's own is 8 hex characters (server.js).
const NODE_ID = /^[A-Za-z0-9_-]{6,32}$/;
const isNodeId = (id) => typeof id === 'string' && NODE_ID.test(id);
const CAPS = ['messages', 'action-prompts', 'documents', 'ai', 'context', 'receipts', 'proposals', 'displays', 'help'];
// A Stagewatch as one link sees it at one time: unique across every link of this process, so a link made again for a
// hall (its Stagewatch removed, then another set) never shares a number with the one it replaced.
let generations = 0;

/** A hello off the wire, cleaned; null when it isn't one (pure, tested). */
function parseHello(msg, address) {
  if (!msg || typeof msg !== 'object' || msg.v !== 1 || !KINDS.has(msg.t) || typeof msg.id !== 'string' || !msg.id) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const ports = {};
  const src = msg.ports && typeof msg.ports === 'object' ? msg.ports : {};
  for (const k of ['http', 'https', 'ws', 'wire', 'osc']) { const p = Number(src[k]); if (Number.isInteger(p) && p > 0 && p < 65536) ports[k] = p; }
  // Older Stagewatch / AGMessage hellos named the web port "web".
  if (!ports.http && Number.isInteger(Number(msg.web)) && Number(msg.web) > 0) ports.http = Number(msg.web);
  return {
    t: msg.t, id: str(msg.id, 40), name: str(msg.name, 60), host: str(msg.host || msg.machine, 60), address: str(address, 60),
    ports, caps: Array.isArray(msg.caps) ? msg.caps.slice(0, 20).map((c) => String(c).slice(0, 24)) : [],
    proto: Number.isInteger(msg.proto) ? msg.proto : 0,
    clock: Number.isFinite(msg.clock) ? msg.clock : null,
    tls: tlsmod.cleanFingerprint(msg.tls),   // "" when the node announces no certificate
    // The build a peer runs (SemVer, e.g. PlayMap's "0.2.0+17.abc1234"); any other value is dropped, the hello kept.
    build: typeof msg.build === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(msg.build) ? msg.build : '',
  };
}

/** live / stale / gone from the time a peer was last heard (pure). */
function peerStatus(ageMs) { return ageMs < STALE_MS ? 'live' : ageMs < GONE_MS ? 'stale' : 'gone'; }

class Discovery {
  /**
   * @param {object} o
   * @param {string} o.id stable per install (persisted by the caller)
   * @param {number} o.port the HTTP port people and nodes connect to
   * @param {boolean} [o.announce] false when bound to loopback only (Show Bus §2)
   */
  constructor({ id, port, name, announce = true, onChange, tls = '', build = '' }) {
    this.id = id; this.port = port; this.name = name; this.announce = announce; this.onChange = onChange || (() => {});
    this.build = build;   // the build this node runs (lib/version.js), so a peer tells builds apart before it connects
    this.tls = tls;   // this node's certificate fingerprint (same port serves HTTPS)
    this.peers = new Map();   // id -> hello + seen
    this.dropped = 0;         // hellos with a new id refused because the table, or that address's share of it, is full
    this.sock = null;
    this.timer = null;
    this._changeTimer = null;
  }

  /** The table changed: tell onChange once within CHANGE_MS, reading the table as it is then (latest wins, no backlog). */
  _changed() {
    if (this._changeTimer) return;
    this._changeTimer = setTimeout(() => { this._changeTimer = null; this.onChange(); }, CHANGE_MS);
    this._changeTimer.unref();
  }

  hello() {
    const h = { t: KIND, v: 1, proto: 1, id: this.id, name: this.name, host: os.hostname().slice(0, 40), ports: { http: this.port }, caps: CAPS, clock: Date.now() };
    if (this.tls) { h.ports.https = this.port; h.tls = this.tls; }
    if (this.build) h.build = this.build;
    return h;
  }

  start() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => { console.warn('  [nodes] UDP ' + BUS_PORT + ': ' + e.message); try { sock.close(); } catch { /* ignore */ } });
    sock.on('message', (buf, rinfo) => {
      if (buf.length > 4096) return;
      let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }   // a stray packet must never throw
      const h = parseHello(msg, rinfo.address);
      if (!h || h.id === this.id) return;
      const was = this.peers.get(h.id);
      // A new id takes a place only while the table and its address's share have room; ids already heard keep
      // refreshing, so a flood of fresh ids never pushes the real peers out.
      if (!was && (this.peers.size >= MAX_PEERS || this._idsAt(h.address) >= MAX_PER_ADDRESS)) { this.dropped++; return; }
      this.peers.set(h.id, { ...h, seen: Date.now() });
      if (!was || was.address !== h.address || was.name !== h.name || peerStatus(Date.now() - was.seen) !== 'live') this._changed();
    });
    sock.bind(BUS_PORT, () => { try { sock.setBroadcast(true); } catch { /* ignore */ } });
    const tick = () => {
      if (this.announce) {
        const out = Buffer.from(JSON.stringify(this.hello()));
        for (const to of ['255.255.255.255', '127.0.0.1']) sock.send(out, BUS_PORT, to, () => {});
      }
      let changed = false;
      for (const [k, p] of this.peers) {
        const st = peerStatus(Date.now() - p.seen);
        if (st === 'gone') { this.peers.delete(k); changed = true; } else if (st !== p.lastStatus) { p.lastStatus = st; changed = true; }
      }
      if (changed) this._changed();
    };
    this.timer = setInterval(tick, BEAT_MS);
    this.timer.unref();
    tick();
  }

  _idsAt(address) { let n = 0; for (const p of this.peers.values()) if (p.address === address) n++; return n; }

  /** The live peer of kind t serving at host:port (http or https), or null. */
  find(t, host, port) {
    for (const p of this.peers.values()) {
      if (p.t !== t || peerStatus(Date.now() - p.seen) === 'gone') continue;
      const hostOk = p.address === host || (p.host && p.host.toLowerCase() === String(host).toLowerCase());
      if (hostOk && (p.ports.http === port || p.ports.https === port)) return p;
    }
    return null;
  }

  list() {
    const now = Date.now();
    return Array.from(this.peers.values()).map((p) => ({
      t: p.t, id: p.id, name: p.name, host: p.host, address: p.address, ports: p.ports, caps: p.caps, proto: p.proto, tls: p.tls || '', build: p.build || '',
      status: peerStatus(now - p.seen), age: Math.round((now - p.seen) / 1000),
    }));
  }

  stop() { clearInterval(this.timer); clearTimeout(this._changeTimer); this._changeTimer = null; if (this.sock) { try { this.sock.close(); } catch { /* ignore */ } } }
}

/** "http://10.0.0.5:9924" from what the operator typed ("10.0.0.5", "10.0.0.5:9924", a full URL). */
function normaliseBase(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
    if (!u.port && u.protocol === 'http:') u.port = '9924';
    return u.protocol + '//' + u.host;
  } catch { return ''; }
}

/** The bits of a Stagewatch frame the board and research team need (pure, tested). */
function stageView(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (Number.isFinite(v) ? v : null);
  const po = frame.playout && typeof frame.playout === 'object' ? frame.playout : null;
  const sig = Array.isArray(frame.signals) ? frame.signals : [];
  const open = sig.filter((g) => g && (g.state === 'sent' || g.state === 'seen'));
  return {
    text: str(frame.speakerText !== undefined && frame.mode === 'countdown' ? frame.speakerText : frame.text, 20),
    title: str(frame.title), next: str(frame.next), color: /^#[0-9A-Fa-f]{6}$/.test(frame.color || '') ? frame.color : '#FFFFFF',
    phase: str(frame.phase, 20), state: str(frame.state, 20), mode: str(frame.mode, 20),
    seconds: num(frame.seconds),
    message: str(frame.message, 500), messageId: Number.isInteger(frame.messageId) ? frame.messageId : 0,
    messageAck: str(frame.messageAck, 20), messageAckBy: str(frame.messageAckBy, 60),
    playout: po ? { title: str(po.title, 80), remaining: num(po.remaining), running: po.running === true } : null,
    cues: { open: open.length, waiting: open.filter((g) => g.state === 'sent').length, unanswered: open.filter((g) => g.escalated === true).length },
    room: str(frame.room, 60),
    seq: Number.isInteger(frame.seq) ? frame.seq : null,
  };
}

/**
 * A proposal as the desk reports it (Show Bus §11, Stagewatch's SharedProposal.ToJson), cleaned (pure). Tolerant: the desk
 * may add fields. `created` and `from` tell one proposal from another of the same id: a desk numbers from p1 again after
 * it restarts. The outcome is read as Stagewatch states it, at the top level: `ok` true when done, false when failed or
 * undelivered, null until it ran; `words` the target's (or the desk's) words. A settled state stands only beside that
 * boolean; a state not listed here, or a settled one whose ok is missing, not a boolean or says otherwise, is `unknown`
 * (ok null) — never done, never pending. A submit's receipt ({ok:true,id,state:"pending"}) carries the request's ok,
 * never an outcome: a proposal that has not run has none.
 */
const PROPOSAL_STATES = new Set(['pending', 'approved', 'rejected', 'done', 'failed', 'undelivered']);
const PROPOSAL_OUTCOME = new Map([['done', true], ['failed', false], ['undelivered', false]]);
function readProposal(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.id !== 'string' || !j.id) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const said = PROPOSAL_STATES.has(j.state) ? j.state : '';
  const state = !said || (PROPOSAL_OUTCOME.has(said) && j.ok !== PROPOSAL_OUTCOME.get(said)) ? 'unknown' : said;
  return {
    id: str(j.id, 40), state, ok: PROPOSAL_OUTCOME.has(state) ? PROPOSAL_OUTCOME.get(state) : null,
    line: str(j.line, 600), reason: str(j.reason, 300), risk: str(j.risk, 10), decidedBy: str(j.decidedBy || j.by, 60),
    words: str(typeof j.words === 'string' ? j.words : j.result, 300),
    target: j.target && typeof j.target === 'object' ? { t: str(j.target.t, 16), id: str(j.target.id, 40) } : null,
    created: Number.isFinite(j.created) ? j.created : 0,
    from: j.from && typeof j.from === 'object' ? { t: str(j.from.t, 16), id: str(j.from.id, 40) } : null,
  };
}
/** Where a link points, as a short tag (never the address itself): what a send or proposal records of its Stagewatch. */
const addressTag = (base) => (base ? crypto.createHash('sha256').update(String(base)).digest('hex').slice(0, 12) : '');
/** The desk's list replies: an array, or {proposals:[…]} (pure). */
const readProposalList = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.proposals) ? j.proposals : []).map(readProposal).filter(Boolean);

/** Stagewatch's receipt for a request (Show Bus §3), from whatever it answered (pure). */
function readReceipt(status, body, requestId) {
  const j = body && typeof body === 'object' ? body : {};
  if (status >= 400 || j.ok === false) return { ok: false, stage: 'refused', error: 'Stagewatch: ' + String(j.error || ('said ' + status)).slice(0, 160) };
  const refs = j.refs && typeof j.refs === 'object' ? j.refs : {};
  return {
    ok: true, id: typeof j.id === 'string' ? j.id : requestId,
    // An older Stagewatch answers {"ok":true} only: it took the command, it didn't say it ran.
    stage: j.stage === 'applied' ? 'applied' : 'accepted',
    effect: typeof j.effect === 'string' ? j.effect.slice(0, 200) : '',
    messageId: Number.isInteger(refs.messageId) ? refs.messageId : 0,
  };
}

/**
 * The /ws address a Stagewatch link dials: this node by its own Show Bus id — node and cid the same id, t its kind — so
 * Stagewatch tells one AGMessage from another, and a name it gives one sticks to that one. The key is never in it (Show
 * Bus §7: the Authorization header). Each key once: Stagewatch reads the query as a dictionary, the last value winning.
 */
function wsUrl(base, nodeId) {
  if (!isNodeId(nodeId)) throw new TypeError('a Stagewatch link dials only as a node with a Show Bus id');
  return base.replace(/^http/, 'ws') + '/ws?' + new URLSearchParams({ node: nodeId, t: KIND, cid: nodeId, page: '/agmessage' }).toString();
}

const requestId = () => 'ag' + crypto.randomBytes(6).toString('hex');
// ±20 % from the CSPRNG, so links that dropped together do not redial together.
const jitter = (ms) => Math.round(ms * (0.8 + crypto.randomInt(0, 401) / 1000));

class StagewatchLink {
  /**
   * @param {object} o
   * @param {(t:string,host:string,port:number)=>object|null} [o.findPeer] the discovery table (hello: id, tls, ports)
   * @param {object} [o.pins] a tls.PinStore
   * @param {()=>void} [o.onPins] the pins changed (persist them)
   */
  constructor({ nodeId, onState, onStatus, onContext, onKey, findPeer, pins, onPins, refusedRetryMs = REFUSED_RETRY_MS, lockoutMs = LOCKOUT_MS } = {}) {
    // Every link of this node dials as this node: no link without the id its hello, context and desk use.
    if (!isNodeId(nodeId)) throw new TypeError('a Stagewatch link needs this node\'s Show Bus id');
    this.nodeId = nodeId;
    this.onState = onState || (() => {}); this.onStatus = onStatus || (() => {}); this.onContext = onContext || (() => {});
    this.findPeer = findPeer || (() => null);
    this.pins = pins || new tlsmod.PinStore();
    this.onPins = onPins || (() => {});
    this.onKey = onKey || (() => {});
    this.refusedRetryMs = refusedRetryMs;
    this.lockoutMs = lockoutMs;
    this.recheckAt = 0;               // when this link's slot for asking a refused key again was taken (0: none)
    this.keyEpoch = 0;                // a new key, address or certificate: its verdicts are news again (the audit)
    this.base = ''; this.key = ''; this.fingerprint = '';
    // Whether Stagewatch accepted the key: 'none' (no key: the link only views), 'checking', 'accepted' (its auth message
    // said ok, or an authenticated request succeeded), 'refused' (with its words). Only an accepted key makes the link
    // connected and confirms a first-use pin; each socket earns its own verdict.
    this.keyState = 'none'; this.keyWords = ''; this.keyVia = ''; this.keyNode = ''; this.keyAt = 0;
    this._probing = null;
    this.refusals = 0;                // counts refusals: an open that was resolving when one came never dials
    this.acceptances = 0;             // counts acceptances: a 401 to a request made before the latest one refuses nothing
    this.heldView = null;             // the newest frame while a refused key is checked again, shown once it is accepted
    this.redial = null;               // the one pending redial: the latest reason to wait sets when it fires
    // Until when Stagewatch asked this key to wait (a 429, or a 503 with Retry-After): its budget is per key and every
    // route spends it, so the desk and the context loops leave the whole link alone till then.
    this.waitUntil = 0;
    this.endpoint = null;             // {base, tls: options|null, fp, nodeKey} once resolved
    this.tlsState = { on: false, fp: '', pinned: false, problem: '' };
    this.desk = false;                // Stagewatch answers /api/proposals (Show Bus §11)
    this.deskCheckedAt = 0;
    // Which Stagewatch, as it is now: a new one each time the link is made, pointed elsewhere or its frames' seq goes back
    // (it restarted, Show Bus §4) — its message and proposal numbers start again, so nothing followed before carries over.
    this.generation = ++generations;
    this.lastSeq = null;
    this.ws = null; this.delay = 500; this.lastHeard = 0; this.view = null; this.status = 'off'; this.lastKey = '';
    this.clock = new ClockSampler(8);
    this.rtt = new Ring(60);          // send-to-stage request → receipt, ms
    this.context = null;              // Stagewatch's /api/context, when it serves one
    this.contextAt = 0;
    // Every department its context has named since it was linked: Stagewatch lists one only while it has a live cue,
    // so a department messaged a moment ago (or whose GO aged out) stays a destination.
    this.departments = [];
    this.timer = setInterval(() => this._watch(), 1000);
    this.timer.unref();   // never keeps a process alive on its own
  }

  configure(base, key, fingerprint = '') {
    const b = normaliseBase(base);
    const k = typeof key === 'string' ? key.trim() : '';
    const f = tlsmod.cleanFingerprint(fingerprint);
    if (b === this.base && k === this.key && f === this.fingerprint) return;
    if (b !== this.base) { this.generation = ++generations; this.lastSeq = null; }
    this.base = b; this.key = k; this.fingerprint = f;
    this._close(); this._cancelRedial();
    this.delay = 500;
    this.clock.reset();
    this.context = null; this.departments = [];
    this.endpoint = null;
    this.desk = false; this.deskCheckedAt = 0;
    this.tlsState = { on: false, fp: '', pinned: false, problem: '' };
    this._resetKey();
    this.waitUntil = 0;
    this.keyEpoch++;
    // Nothing of the last key or address is shown while the new one is checked: no "connected", no old timer.
    this._set(this.base ? 'connecting' : 'off', null);
    if (this.base) this._open();
  }

  _resetKey() { this.keyState = this.key ? 'checking' : 'none'; this.keyWords = ''; this.keyVia = ''; this.keyNode = ''; this.keyAt = 0; this.heldView = null; }
  /** The status of a socket whose frames are fresh: connected only with an accepted key. */
  _liveStatus() { return this.keyState === 'accepted' ? 'connected' : this.keyState === 'none' ? 'viewing' : 'checking key'; }
  /** The key's verdict as every reader shows it (never the key). */
  keyFacts() { return { state: this.keyState, words: this.keyWords, via: this.keyVia, node: this.keyNode, at: this.keyAt }; }

  /** Stagewatch accepted the key: the link is connected, and a certificate used for the first time is pinned. */
  _accept(via, node) {
    if (!this.key || this.keyState === 'accepted') return;   // no key, nothing authenticated: a keyless link never pins
    this.acceptances++;
    this.keyState = 'accepted'; this.keyVia = via; this.keyNode = typeof node === 'string' ? refusalWords(node).slice(0, 40) : ''; this.keyWords = ''; this.keyAt = Date.now();
    this.delay = 500;
    this._confirmPin();
    this._set(this.status === 'stale' ? 'stale' : 'connected', this.view || this.heldView);
    this.heldView = null;
    this.onKey(this.keyFacts(), this.keyEpoch);
    if (via === 'auth') this.fetchContext();
  }

  /** Stagewatch refused the key (or a keyless link's view): nothing more is read or sent; tried again after the lockout minute. */
  _refuse(words) {
    const was = this.keyState;
    const w = refusalWords(words) || 'the key or the viewing code';
    const changed = this.keyState !== 'refused' || this.keyWords !== w;
    this.keyState = 'refused'; this.keyWords = w; this.keyVia = ''; this.keyNode = ''; this.keyAt = Date.now();
    this.refusals++; this.heldView = null;
    this._close(); this._probing = null;
    // What a refused key read is not shown or quoted, and the desk is asked again after the next acceptance.
    this.context = null; this.desk = false; this.deskCheckedAt = 0;
    this._set((this.key ? 'key refused: ' : 'refused: ') + w, null);
    if (changed) this.onKey(this.keyFacts(), this.keyEpoch);
    if (this.base && was !== 'refused') noteRefusal(this.host, this.lockoutMs);
    else if (this.base && this.recheckAt) moveRefusal(this.host, this.recheckAt);   // its slot, taken as it dialled, runs from now
    this.recheckAt = 0;
    this._retry(this.refusedRetryMs);
  }

  /** Stagewatch 2.16 says nothing on the socket: one authenticated read (its context) is the key's verdict. */
  _probe(ws) {
    if (this._probing === ws || !this.key || this.keyState === 'accepted') return;
    this._probing = ws;
    const again = (ms) => setTimeout(() => { if (this.ws === ws && this.keyState !== 'accepted') this._probe(ws); }, ms).unref();
    // The one request that goes before the verdict, and the verdict's own: a read with no side effect.
    this._call('/api/context', { timeoutMs: 3000, verdict: true }).then((res) => {
      if (this._probing === ws) this._probing = null;
      if (this.ws !== ws) return;   // that socket is gone: its answer decides nothing
      const j = res.body;
      if (res.status === 200 && j && j.v === 1 && j.node) { this._takeContext(j); this._accept('request'); return; }
      if (res.status === 401 || res.status === 403) { this._refuse(j && j.error); return; }
      // Not a verdict (404 in Stagewatch's first second, 429, 5xx): still checking, asked again while this socket lives.
      // A refused key being asked again keeps its refusal's words until the answer is one.
      if (this.keyState === 'checking') this.keyWords = 'Stagewatch answered ' + res.status;
      again(this.held ? this.waitUntil - Date.now() : jitter(this.delay));
    }, (e) => {
      if (this._probing === ws) this._probing = null;
      if (this.ws !== ws) return;
      if (this.keyState === 'checking') this.keyWords = 'Stagewatch did not answer: ' + (e && e.message ? e.message.slice(0, 60) : '');
      again(jitter(this.delay));
    });
  }

  /**
   * Where and how to talk to Stagewatch: plain http, or https with a pinned certificate (Show Bus 1.2 §10). Null when
   * it may not be talked to (a changed or mismatched certificate) — then nothing at all is sent.
   */
  async _resolve() {
    const u = new URL(this.base);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const peer = this.findPeer('main', u.hostname, port);
    // The certificate is pinned under the node's id (from its hello) and under the link's own address: the hello is
    // unauthenticated and absent right after a restart, so once pinned at this address the link is never plain again, and
    // a hello naming another id cannot swap in a pin of its own (Show Bus §10: the pin, not the hello, is the trust).
    const urlKey = 'url:' + u.hostname + ':' + port;
    const keys = Array.from(new Set([peer ? 'node:' + peer.id : urlKey, urlKey]));
    const wantTls = u.protocol === 'https:' || !!(peer && peer.tls) || !!this.fingerprint || keys.some((k) => this.pins.pins[k]);
    if (!wantTls) { this.tlsState = { on: false, fp: '', pinned: false, problem: '' }; return { base: this.base, tls: null }; }
    const tport = peer && peer.ports && peer.ports.https ? peer.ports.https : port;
    const nodeKey = keys[0];
    let cert;
    try { cert = await tlsmod.probeCertificate(u.hostname, tport); } catch (e) {
      this.tlsState = { on: true, fp: '', pinned: !!this.pins.pins[nodeKey], problem: 'no TLS answer: ' + (e && e.message ? e.message : '') };
      return undefined;   // unreachable: retry like any connection failure
    }
    const expected = this.fingerprint || (peer && peer.tls) || '';
    const verdict = keys.map((k) => this.pins.check(k, cert.fp, expected)).find((v) => !v.ok) || { ok: true };
    this.tlsState = { on: true, fp: cert.fp, pinned: !!this.pins.pins[nodeKey], problem: verdict.ok ? '' : verdict.reason, changed: !!verdict.changed, nodeKey, keys };
    if (!verdict.ok) return null;
    return { base: 'https://' + u.hostname + ':' + tport, tls: tlsmod.pinnedTlsOptions(cert.pem, cert.fp), fp: cert.fp, nodeKey, keys };
  }

  /** Stagewatch accepting the key over TLS pins the certificate (trust on first authenticated use), under every key the link checks. */
  _confirmPin() {
    const e = this.endpoint;
    if (!e || !e.tls) return;
    let pinned = false;
    for (const k of e.keys || [e.nodeKey]) if (this.pins.confirm(k, e.fp)) pinned = true;
    if (pinned) { this.tlsState.pinned = true; this.onPins(); }
  }

  /** The admin accepts a changed certificate: pin what is presented now, then reconnect. */
  acceptCertificate() {
    const s = this.tlsState;
    if (!s.nodeKey || !s.fp || !s.problem) return false;   // only a certificate the link refused is accepted
    for (const k of s.keys || [s.nodeKey]) this.pins.accept(k, s.fp);
    this.onPins();
    this.tlsState.problem = ''; this.tlsState.changed = false;
    this._close(); this.endpoint = null; this.delay = 500;
    // A key Stagewatch refused stays refused, and its hold stands: the accepted certificate is used when it asks again.
    if (this.keyState === 'refused') { this._set('key refused: ' + this.keyWords, null); return true; }
    this._cancelRedial();
    this._resetKey();
    this.keyEpoch++;
    this._set('connecting', null);
    if (this.base) this._open();
    return true;
  }

  /**
   * The admin removed this Stagewatch: forget its certificate's pins — its address's, and its node's (the node pins
   * holding the same certificate) — so the address linked again trusts what it serves then.
   */
  forgetPins() {
    if (!this.base) return;
    const u = new URL(this.base);
    const keys = new Set(['url:' + u.hostname + ':' + (Number(u.port) || (u.protocol === 'https:' ? 443 : 80))].concat(this.tlsState.keys || []));
    const fps = new Set([this.tlsState.fp].concat(Array.from(keys, (k) => this.pins.pins[k])).filter(Boolean));
    for (const [k, fp] of Object.entries(this.pins.pins)) if (k.startsWith('node:') && fps.has(fp)) keys.add(k);
    let gone = false;
    for (const k of keys) if (this.pins.pins[k]) { this.pins.forget(k); gone = true; }
    if (gone) this.onPins();
  }

  /** One HTTP call to Stagewatch on the resolved endpoint (pinned when TLS). */
  async _call(path, { method = 'GET', headers = {}, body, timeoutMs = 4000, verdict = false } = {}) {
    if (!this.endpoint) throw new Error('not connected');
    // The key goes nowhere Stagewatch has not accepted it, but in the one read that asks it (the verdict's own).
    if (this.keyState !== 'accepted' && !verdict) throw new Error('not sent: Stagewatch has not accepted this AGMessage\'s key');
    const accepted = this.keyState === 'accepted' ? this.acceptances : -1;
    const res = await tlsmod.request(this.endpoint.base + path, { method, headers: this._headers(headers), body, timeoutMs, tls: this.endpoint.tls });
    if (res.status === 429 || (res.status === 503 && res.retryAfter !== null)) this.waitUntil = Math.max(this.waitUntil, Date.now() + holdMs(res.retryAfter));
    // 401 is Stagewatch refusing the key itself (unknown, revoked, the PIN, or this address locked out): never a link.
    // Only for the key the request carried, accepted then and still: a request from before a new key decides nothing.
    if (res.status === 401 && this.keyState === 'accepted' && this.acceptances === accepted) this._refuse(res.body && res.body.error);
    return res;
  }

  get linked() { return this.status === 'connected'; }
  /** The Stagewatch this link points at, as host:port ('' when none): what its lockout counts by. */
  get host() { return this.base ? new URL(this.base).host : ''; }
  /** Stagewatch asked this key to wait (Retry-After), and the time is not up. */
  get held() { return Date.now() < this.waitUntil; }
  /** The address this link points at, as a tag (lib/nodes.js addressTag). */
  get tag() { return addressTag(this.base); }

  _set(status, view) {
    const key = status + '|' + JSON.stringify(view);
    if (key === this.lastKey) return;   // latest-wins, only on change
    this.lastKey = key;
    this.status = status; this.view = view;
    this.onStatus(status);
    this.onState(view, status);
  }

  _headers(extra = {}) { return this.key ? { Authorization: 'Bearer ' + this.key, ...extra } : { ...extra }; }

  _open() {
    if (this.status === 'off') this._set('connecting', this.view);
    const base = this.base;
    const refusals = this.refusals;
    this._opening = true;
    this._resolve().then((ep) => {
      this._opening = false;
      // Pointed elsewhere, already open, or the key refused while this resolved (its hold's redial opens again).
      if (this.base !== base || this.ws || this.refusals !== refusals) return;
      if (ep === null) { this._set(this.tlsState.problem || 'certificate refused', null); this._retry(10_000); return; }
      if (ep === undefined) { this._retry(); return; }
      this.endpoint = ep;
      this._dial(ep);
    }, () => { this._opening = false; this._retry(); });
  }

  _dial(ep) {
    const url = wsUrl(ep.base, this.nodeId);
    let ws;
    // The key rides in the Authorization header, never in the URL (Show Bus §7); over TLS only to the pinned certificate.
    try { ws = new WebSocket(url, { headers: this._headers(), handshakeTimeout: 5000, ...(ep.tls || {}) }); } catch { this._retry(); return; }
    this.ws = ws;
    // A new socket earns its own verdict: an acceptance never carries over from the last one; a refusal stands until one.
    if (this.keyState === 'accepted') this._resetKey();
    let first = true;
    ws.onopen = () => {
      this.lastHeard = Date.now();
      if (this.keyState === 'none') this.delay = 500;
      if (this.keyState !== 'refused') this._set(this._liveStatus(), this.view);
      this._ping();
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (this.ws !== ws || !msg || typeof msg !== 'object') return;
      // Stagewatch 2.18 says first whether it accepted the key; only ok === true accepts, anything else is no verdict.
      if (msg.type === 'auth') {
        if (msg.ok === true) { first = false; this._accept('auth', msg.node); } else if (msg.ok === false) { first = false; this._refuse(msg.words ?? msg.error); }
        return;
      }
      // A Stagewatch whose first frame (or beat) came without a word on the key (2.16): one authenticated read is the verdict.
      // A keyless link Stagewatch sends frames to again (its viewing code lifted) is viewing again.
      if (first && (msg.type === 'state' || msg.type === 'beat')) {
        first = false;
        if (this.key) this._probe(ws);
        else if (this.keyState === 'refused') { this._resetKey(); this.delay = 500; this.onKey(this.keyFacts(), this.keyEpoch); }
      }
      if (msg.type === 'beat') { if (msg.live !== false) this.lastHeard = Date.now(); return; }
      this.lastHeard = Date.now();
      if (msg.type === 'state') {
        if (Number.isInteger(msg.seq)) { if (this.lastSeq !== null && msg.seq < this.lastSeq) this.generation = ++generations; this.lastSeq = msg.seq; }
        if (this.keyState === 'refused') this.heldView = stageView(msg);   // not shown before the key is accepted again
        else this._set(this._liveStatus(), stageView(msg));
      }
      else if (msg.type === 'pong') this.clock.add(Number(msg.t), Number(msg.t2), Number(msg.t3), Date.now());
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this._retry(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  _ping() {
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ cmd: 'ping', t: Date.now() })); } catch { /* close follows */ } }
  }

  _retry(after) {
    if (!this.base) return;
    const held = this.keyState === 'refused';   // a refused key waits out Stagewatch's lockout minute, never less
    const refused = held || (this.tlsState.problem && (this.tlsState.changed || /match/.test(this.tlsState.problem)));
    if (!refused && this.status !== 'reconnecting') this._set('reconnecting', this.view ? { ...this.view, stale: true } : null);
    this._schedule(held ? this.refusedRetryMs + crypto.randomInt(0, Math.floor(this.refusedRetryMs / 5) + 1) : jitter(after || this.delay));
    if (!after && !held) this.delay = Math.min(5000, this.delay * 2);
  }

  /** The one pending redial. A refused key's waits, besides, for room under Stagewatch's lockout at that address. */
  _schedule(ms) {
    const base = this.base;
    this._cancelRedial();
    this.redial = setTimeout(() => {
      this.redial = null;
      if (this.ws || this._opening || this.base !== base) return;
      if (this.keyState === 'refused') {
        const room = lockoutRoomIn(this.host, this.lockoutMs);
        if (room > 0) { this._schedule(room); return; }
        this.recheckAt = noteRefusal(this.host, this.lockoutMs);   // its slot, taken before it dials
      }
      this._open();
    }, ms);
    this.redial.unref();
  }

  _cancelRedial() { if (this.redial) { clearTimeout(this.redial); this.redial = null; } }

  _watch() {
    if (!this.ws || this.ws.readyState !== 1) return;   // open sockets only: onopen set lastHeard
    const quiet = Date.now() - this.lastHeard;
    this._ping();
    // A silent peer answers no close frame (ws would wait 30 s for one): drop the socket now, so onclose redials at 12 s.
    if (quiet > GONE_MS) { try { this.ws.terminate(); } catch { /* onclose redials */ } return; }
    if (!['connected', 'stale', 'checking key', 'viewing'].includes(this.status)) return;   // a refusal's words stay up
    if (quiet > STALE_MS) this._set('stale', this.view ? { ...this.view, stale: true } : null);   // silence is never "fine"
    else if (this.status === 'stale') this._set(this._liveStatus(), this.view ? { ...this.view, stale: false } : null);
  }

  /** Let go of the socket (reconfigured, a certificate accepted, stopped): its late frames no longer reach this link. */
  _close() { if (this.ws) { const w = this.ws; this.ws = null; w.onmessage = null; w.onopen = null; try { w.close(); } catch { /* ignore */ } } }

  /** Clock offset to Stagewatch ({offsetMs, rttMs, apart}) or null before the first pong with times. */
  clockInfo() { return this.clock.best(); }

  /** Put a message on the speaker's confidence monitor. Returns Stagewatch's receipt, or why it wasn't sent. */
  async sendToStage(text, { urgency = 'info', ack = true } = {}) {
    if (!this.base) return { ok: false, stage: 'not sent', error: 'Link Stagewatch first (Admin → Show network).' };
    if (!this.key) return { ok: false, stage: 'not sent', error: 'Stagewatch needs a node key for this (Stagewatch → Settings → Remote → API keys, scope "node").' };
    const held = this.keyHeld();
    if (held) return { ok: false, stage: 'not sent', error: held };
    if (this.status !== 'connected') return { ok: false, stage: 'not sent', error: 'The Stagewatch link is ' + this.status + ' — not sent (nothing is queued; send again when it is connected).' };
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) return { ok: false, stage: 'not sent', error: 'Nothing to send.' };
    const u = ['info', 'warn', 'crit'].includes(urgency) ? urgency : 'info';
    const path = '/api/message/' + [t, u, 'off'].concat(ack ? ['ack'] : []).map(encodeURIComponent).join('/');
    const id = requestId();
    const t0 = Date.now();
    try {
      const res = await this._call(path, { method: 'POST', headers: { 'X-Request-Id': id } });
      this.rtt.push(Date.now() - t0);
      return readReceipt(res.status, res.body, id);
    } catch (e) {
      return { ok: false, stage: 'not sent', error: 'Stagewatch unreachable: ' + (e && e.message ? e.message.slice(0, 80) : '') };
    }
  }

  /** Why nothing authenticated may go to Stagewatch while its verdict on the key is not "accepted" ('' when it may). */
  keyHeld(what = 'sent') {
    if (this.keyState === 'refused') return 'Stagewatch refused this AGMessage\'s key (' + this.keyWords + ') — not ' + what + '. Enter a node key Stagewatch lists (Stagewatch → Settings → Remote → API keys).';
    if (this.keyState === 'checking') return 'Stagewatch has not accepted this AGMessage\'s key yet — not ' + what + ' (nothing is queued).';
    return '';
  }

  /** Stagewatch's context (Show Bus §6), for the AI's brief and the admin page. Quietly null when not served. */
  async fetchContext() {
    if (!this.base || !this.key || !this.endpoint || this.keyState !== 'accepted') return null;
    const acceptance = this.acceptances;
    try {
      const res = await this._call('/api/context', { timeoutMs: 3000 });
      if (res.status !== 200) return null;
      const j = res.body;
      if (!j || j.v !== 1 || !j.node) return null;
      if (this.keyState !== 'accepted' || this.acceptances !== acceptance) return null;   // refused meanwhile: not shown
      this._takeContext(j);
      return j;
    } catch { return null; }
  }

  _takeContext(j) {
    this.context = j; this.contextAt = Date.now();
    this.departments = Array.from(new Set(this.departments.concat(departmentsOf(j)))).slice(0, 20);
    this.onContext(j);
  }

  /** Post AGMessage's own context to Stagewatch (needs a node-scope key). */
  async pushContext(ctx) {
    if (!this.linked || !this.key) return false;
    try {
      const res = await this._call('/api/peers/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ctx), timeoutMs: 3000 });
      return res.status >= 200 && res.status < 300;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- the show desk (Show Bus 1.2 §11)

  /** Does Stagewatch keep the shared approval queue? (Its hello's caps, else asked every DESK_CHECK_MS.) */
  async checkDesk(fromId = 'x') {
    if (!this.linked || !this.key || !this.endpoint) { this.desk = false; return false; }
    const u = new URL(this.base);
    const peer = this.findPeer('main', u.hostname, Number(u.port) || 80);
    if (peer && Array.isArray(peer.caps) && peer.caps.includes('approvals')) { this.desk = true; this.deskCheckedAt = Date.now(); return true; }
    // Only a verdict changes it: 200 is a desk, 404 or 405 none. No answer, a busy desk, the key's spent minute or a
    // refused key say nothing of it: the desk stays as it was and is asked again in seconds (after any Retry-After),
    // so a 429 never hides a desk, and what it approves meanwhile is still collected inside Stagewatch's minute.
    let res = null;
    const acceptance = this.acceptances;
    try { res = await this._call('/api/proposals?from=' + encodeURIComponent(fromId), { timeoutMs: 3000 }); } catch { /* no answer: asked again soon */ }
    if (this.keyState !== 'accepted' || this.acceptances !== acceptance) return this.desk;   // refused meanwhile: says nothing
    if (res && [200, 404, 405].includes(res.status)) { this.desk = res.status === 200; this.deskCheckedAt = Date.now(); }
    else this.deskCheckedAt = Date.now() - (res && res.status === 403 ? 0 : DESK_CHECK_MS - DESK_RECHECK_MS);
    return this.desk;
  }

  /** Send a proposal to the desk. {ok, proposal?, error?} */
  async propose(body) {
    if (this.keyHeld('proposed')) return { ok: false, error: this.keyHeld('proposed') };
    if (!this.linked || !this.endpoint) return { ok: false, error: 'The Stagewatch link is ' + this.status + ' — not proposed.' };
    if (!this.desk) return { ok: false, error: 'This Stagewatch keeps no approval queue (Show Bus 1.2) — send it directly instead.' };
    try {
      const res = await this._call('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status >= 400) return { ok: false, error: 'Stagewatch: ' + String((res.body && res.body.error) || ('said ' + res.status)).slice(0, 160) };
      const p = readProposal(res.body);
      return p ? { ok: true, proposal: p } : { ok: false, error: 'Stagewatch answered without a proposal id' };
    } catch (e) { return { ok: false, error: 'Stagewatch unreachable: ' + (e && e.message ? e.message.slice(0, 80) : '') }; }
  }

  /** One proposal's state; {gone:true} when the desk has no such proposal (404); null when it could not be asked. */
  async proposal(id) {
    const a = await this.proposalAnswer(id);
    return a.status === 200 ? a.proposal : a.status === 404 ? { gone: true } : null;
  }

  /** One proposal as the desk answered: {status (0 when not reached), retryAfter, proposal (null unless 200)}. */
  async proposalAnswer(id) {
    try {
      const res = await this._call('/api/proposals/' + encodeURIComponent(id), { timeoutMs: 3000 });
      return { status: res.status, retryAfter: res.retryAfter, proposal: res.status === 200 ? readProposal(res.body) : null };
    } catch { return { status: 0, retryAfter: null, proposal: null }; }
  }

  /** Approved proposals aimed at this node (it runs them and reports). [] when there are none or the desk is away. */
  async approvedFor(nodeId) {
    if (!this.desk || !this.linked) return [];
    try {
      const res = await this._call('/api/proposals?target=' + encodeURIComponent(nodeId) + '&state=approved', { timeoutMs: 3000 });
      // Only what the desk says is approved for this node is run: Stagewatch's collect lists nothing else.
      return res.status === 200 ? readProposalList(res.body).filter((p) => p.state === 'approved' && p.target && p.target.id === nodeId) : [];
    } catch { return []; }
  }

  /**
   * Report what running an approved proposal did: {status (0 when not reached), retryAfter, error (the desk's words)},
   * for lib/deskresults.js postVerdict to read.
   */
  async reportResult(id, ok, words) {
    try {
      const res = await this._call('/api/proposals/' + encodeURIComponent(id) + '/result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: !!ok, words: String(words || '').slice(0, 300) }), timeoutMs: 3000,
      });
      return { status: res.status, retryAfter: res.retryAfter, error: res.body && typeof res.body.error === 'string' ? res.body.error.slice(0, 160) : '' };
    } catch (e) { return { status: 0, retryAfter: null, error: e && e.message ? e.message.slice(0, 80) : '' }; }
  }

  stop() { clearInterval(this.timer); this._cancelRedial(); this.base = ''; this._close(); }
}

module.exports = { REFUSED_RETRY_MS, DESK_CHECK_MS, LOCKOUT_MS, refusalWords, Discovery, StagewatchLink, wsUrl, normaliseBase, stageView, parseHello, peerStatus, readReceipt, readProposal, readProposalList, addressTag, BUS_PORT, STALE_MS, GONE_MS, MAX_PEERS, MAX_PER_ADDRESS };
