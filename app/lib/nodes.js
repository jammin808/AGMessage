'use strict';
/**
 * AGMessage as a node of the show network.
 *
 *  - Discovery (listen only, never impersonate): Stagewatch hellos on UDP 9928 ({"t":"main",...}) and Patterns
 *    beacons on UDP 9700 ({"patterns":1,"machine":...}). AGMessage announces itself on 9928 as {"t":"messenger"}
 *    — Stagewatch ignores kinds it doesn't know, so this is safe and future-ready. It never sends on 9700: a
 *    Patterns standby twin must never mistake it for a main machine.
 *  - Stagewatch link: a WebSocket to ws://<stagewatch>/ws for the live timer (latest-wins frames, a heartbeat at
 *    least every 2 s; silence = stale, never "fine"), and "send to stage" over HTTP with a control API key.
 *    Reconnects with backoff; nothing is queued while offline.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

const SW_PORT = 9928;
const PATTERNS_PORT = 9700;
const STALE_MS = 6000;

class Discovery {
  constructor({ port, name, onChange }) {
    this.port = port; this.name = name; this.onChange = onChange || (() => {});
    this.id = 'ag' + crypto.randomBytes(5).toString('hex');
    this.peers = new Map();   // key -> {kind, name, machine, address, web, wire, http, seen}
    this.sockets = [];
    this.timer = null;
  }

  start() {
    this._listen(SW_PORT, (msg, rinfo) => {
      if (!msg || msg.v !== 1 || msg.t !== 'main' || typeof msg.id !== 'string') return;
      this._seen('sw:' + msg.id, { kind: 'stagewatch', name: String(msg.name || '').slice(0, 60), machine: String(msg.machine || '').slice(0, 60), address: rinfo.address, web: Number(msg.web) || 0, caps: Array.isArray(msg.caps) ? msg.caps.slice(0, 20).map(String) : [] });
    });
    this._listen(PATTERNS_PORT, (msg, rinfo) => {
      if (!msg || !(msg.patterns >= 1) || typeof msg.machine !== 'string' || !msg.machine) return;
      this._seen('pt:' + (msg.instance || msg.machine), { kind: 'patterns', name: msg.machine.slice(0, 60), machine: msg.machine.slice(0, 60), address: rinfo.address, wire: Number(msg.wire) || 0, http: Number(msg.http) || 0, role: String(msg.kind || 'desk').slice(0, 20), live: !!msg.live, program: String(msg.program || '').slice(0, 80) });
    });
    // Announce on Stagewatch's port every 2 s (no meeting data, no secrets).
    const hello = () => {
      const out = Buffer.from(JSON.stringify({ t: 'messenger', v: 1, id: this.id, name: this.name, machine: os.hostname().slice(0, 40), web: this.port, caps: ['messages', 'action-prompts', 'documents', 'ai'], proto: 1 }));
      const s = this.sockets.find((x) => x.port === SW_PORT);
      if (s) s.sock.send(out, SW_PORT, '255.255.255.255', () => {});
      for (const [k, p] of this.peers) if (Date.now() - p.seen > 15_000) { this.peers.delete(k); this.onChange(); }
    };
    this.timer = setInterval(hello, 2000);
    this.timer.unref();
    hello();
  }

  _listen(port, handle) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { console.warn('  [nodes] UDP ' + port + ': ' + e.message); try { sock.close(); } catch { /* ignore */ } });
    sock.on('message', (buf, rinfo) => {
      if (buf.length > 4096) return;
      let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }   // a stray packet must never throw
      if (msg && msg.id === this.id) return;
      try { handle(msg, rinfo); } catch { /* ignore */ }
    });
    sock.bind(port, () => { try { sock.setBroadcast(true); } catch { /* ignore */ } });
    this.sockets.push({ port, sock });
  }

  _seen(key, info) {
    const was = this.peers.get(key);
    this.peers.set(key, { ...info, seen: Date.now() });
    if (!was || was.address !== info.address || was.name !== info.name || was.program !== info.program) this.onChange();
  }

  list() { return Array.from(this.peers.values()).map((p) => ({ ...p, age: Math.round((Date.now() - p.seen) / 1000) })); }

  stop() { clearInterval(this.timer); for (const s of this.sockets) { try { s.sock.close(); } catch { /* ignore */ } } }
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
  return {
    text: str(frame.speakerText !== undefined && frame.mode === 'countdown' ? frame.speakerText : frame.text, 20),
    title: str(frame.title), next: str(frame.next), color: /^#[0-9A-Fa-f]{6}$/.test(frame.color || '') ? frame.color : '#FFFFFF',
    phase: str(frame.phase, 20), state: str(frame.state, 20), mode: str(frame.mode, 20),
    seconds: Number.isFinite(frame.seconds) ? frame.seconds : null,
    message: str(frame.message, 500), messageAck: str(frame.messageAck, 20), messageAckBy: str(frame.messageAckBy, 60),
    room: str(frame.room, 60),
  };
}

class StagewatchLink {
  constructor({ onState, onStatus }) {
    this.onState = onState || (() => {}); this.onStatus = onStatus || (() => {});
    this.base = ''; this.key = '';
    this.ws = null; this.delay = 500; this.lastHeard = 0; this.view = null; this.status = 'off'; this.lastKey = '';
    this.timer = setInterval(() => this._watch(), 1000);
    this.timer.unref();   // never keeps a process alive on its own
  }

  configure(base, key) {
    const b = normaliseBase(base);
    const k = typeof key === 'string' ? key.trim() : '';
    if (b === this.base && k === this.key) return;
    this.base = b; this.key = k;
    this._close();
    this.delay = 500;
    if (this.base) this._open(); else this._set('off', null);
  }

  _set(status, view) {
    const key = status + '|' + JSON.stringify(view);
    if (key === this.lastKey) return;   // latest-wins, only on change
    this.lastKey = key;
    this.status = status; this.view = view;
    this.onStatus(status);
    this.onState(view, status);
  }

  _open() {
    if (typeof WebSocket !== 'function') { this._set('this Node has no WebSocket client', null); return; }
    const url = this.base.replace(/^http/, 'ws') + '/ws?cid=agmessage&page=' + encodeURIComponent('/agmessage') + (this.key ? '&pin=' + encodeURIComponent(this.key) : '');
    let ws;
    try { ws = new WebSocket(url); } catch { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.delay = 500; this.lastHeard = Date.now(); this._set('connected', this.view); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (msg.type === 'beat') { if (msg.live !== false) this.lastHeard = Date.now(); return; }
      this.lastHeard = Date.now();
      if (msg.type === 'state') this._set('connected', stageView(msg));
      else if (msg.type === 'auth' && msg.ok === false) this._set('Stagewatch refused: ' + String(msg.error || 'viewing code or key').slice(0, 80), null);
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this._retry(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  _retry() {
    if (!this.base) return;
    if (this.status === 'connected' || this.status === 'connecting') this._set('reconnecting', this.view ? { ...this.view, stale: true } : null);
    setTimeout(() => { if (!this.ws && this.base) this._open(); }, this.delay).unref();
    this.delay = Math.min(5000, this.delay * 2);
  }

  _watch() {
    if (!this.ws || this.status !== 'connected') return;
    if (Date.now() - this.lastHeard > STALE_MS) {
      this._set('stale', this.view ? { ...this.view, stale: true } : null);   // silence is never "fine"
      try { this.ws.close(); } catch { /* onclose reconnects */ }
    }
  }

  _close() { if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch { /* ignore */ } } }

  /** Put a message on the speaker's confidence monitor (needs a control key). */
  async sendToStage(text, { urgency = 'info', ack = true } = {}) {
    if (!this.base) return { ok: false, error: 'Link Stagewatch first (Admin → Show network).' };
    if (!this.key) return { ok: false, error: 'Stagewatch needs a control API key for this (Stagewatch → Settings → Remote → API keys).' };
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) return { ok: false, error: 'Nothing to send.' };
    const u = ['info', 'warn', 'crit'].includes(urgency) ? urgency : 'info';
    const path = '/api/message/' + [t, u, 'off'].concat(ack ? ['ack'] : []).map(encodeURIComponent).join('/');
    try {
      const res = await fetch(this.base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + this.key }, signal: AbortSignal.timeout(4000) });
      if (res.ok) return { ok: true };
      let err = 'Stagewatch said ' + res.status;
      try { const j = await res.json(); if (j && j.error) err = 'Stagewatch: ' + String(j.error).slice(0, 120); } catch { /* ignore */ }
      return { ok: false, error: err };
    } catch (e) {
      return { ok: false, error: 'Stagewatch unreachable: ' + (e && e.message ? e.message.slice(0, 80) : '') };
    }
  }

  stop() { clearInterval(this.timer); this.base = ''; this._close(); }
}

module.exports = { Discovery, StagewatchLink, normaliseBase, stageView };
