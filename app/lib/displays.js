'use strict';
/**
 * Displays: browser windows an operator controls — a projector PC, a confidence monitor, a foyer TV, a screen in the
 * green room. Each has its own unguessable URL (/d/<token>, 256 bits): open it in any browser and it shows what the
 * hall's operators put on it — the holding image, a message, a file, the hall's countdown with a message strip under
 * it, a clock, or black.
 *
 * The URL is a capability (W3C "Good Practices for Capability URLs"): it can only show, never send; it is never logged
 * or put in the audit log (the display's short id is); pages are served with no-referrer; and it can be replaced at
 * once ("New link"), which disconnects every screen holding the old one. Only its SHA-256 is used for lookups; the token
 * itself is sealed at rest (lib/secretbox.js) so a manager can copy the link again.
 *
 * Attempts are not facts: a take is numbered (seq); the display renders it and says so ("shown" with the seq, or what
 * went wrong). Every browser holding the link (a projector and its backup, a manager's laptop after "Open") reports for
 * itself: the operator sees "on screen" only once every one of them confirmed the newest seq, "could not show it" as long
 * as any one of them could not, "sending" until then, and "offline" when no browser holds the link.
 */
const crypto = require('crypto');
const { WriteLane, readJsonWithBak } = require('./resilience');
const { customAlphabet } = require('./ids');
const guard = require('./guard');

const KINDS = ['holding', 'message', 'file', 'countdown', 'clock', 'black'];
const TONES = ['info', 'warn', 'urgent'];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const makeId = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 8);
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
// Runtime state, never saved: each browser on the link by its screen key -> its connection and what it last showed.
const freshLive = () => ({ reports: new Map() });

/**
 * A content an operator asked for, made safe — or {error}. (Pure.) An upload must be one of ours and of a type a
 * screen can show: an image, or a PDF page.
 */
function cleanContent(c) {
  if (!c || typeof c !== 'object' || !KINDS.includes(c.kind)) return { error: 'Choose what to show: holding, message, file, countdown, clock or black.' };
  switch (c.kind) {
    case 'holding': {
      if (c.image === undefined || c.image === null || c.image === '') return { kind: 'holding' };
      if (!guard.validUploadUrl(c.image) || !IMAGE_EXT.has(guard.extOf(c.image))) return { error: 'A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage.' };
      return { kind: 'holding', image: c.image };
    }
    case 'message': {
      const text = guard.cleanText(c.text, 300);
      if (!text) return { error: 'Type the message to show.' };
      return { kind: 'message', text, tone: TONES.includes(c.tone) ? c.tone : 'info', sub: guard.cleanText(c.sub, 120) };
    }
    case 'file': {
      const ext = guard.extOf(c.url);
      if (!guard.validUploadUrl(c.url) || !(IMAGE_EXT.has(ext) || ext === 'pdf')) return { error: 'A screen shows images and PDF pages: share one in the hall first.' };
      const page = Number.isInteger(c.page) && c.page >= 1 && c.page <= 9999 ? c.page : 1;
      return { kind: 'file', url: c.url, name: guard.cleanText(c.name, 120), page, pdf: ext === 'pdf' };
    }
    case 'countdown': return { kind: 'countdown', text: guard.cleanText(c.text, 160), tone: TONES.includes(c.tone) ? c.tone : 'info' };
    default: return { kind: c.kind };
  }
}

/**
 * What is on a screen, in a few words for the operator, the board and the audit log (pure). Holding with no image of its
 * own shows the hall's holding image (`hallHolding`) when the hall has one.
 */
function describe(c, hallHolding = '') {
  if (!c) return 'nothing yet';
  switch (c.kind) {
    case 'holding': return c.image || hallHolding ? 'holding image' : 'holding (black)';
    case 'message': return (c.tone === 'urgent' ? 'urgent message' : c.tone === 'warn' ? 'warning' : 'message') + ': “' + c.text.slice(0, 60) + '”';
    case 'file': return (c.pdf ? 'PDF page ' + c.page + ' of ' : 'image ') + (c.name || 'a file');
    case 'countdown': return 'the countdown' + (c.text ? ' with “' + c.text.slice(0, 40) + '”' : '');
    case 'clock': return 'the clock';
    case 'black': return 'black';
    default: return c.kind;
  }
}

class Displays {
  constructor(file, { seal, open }) {
    this.seal = seal; this.open = open;
    this.lane = new WriteLane(file, { delayMs: 100, keepBak: true, mode: 0o600 });
    const data = readJsonWithBak(file) || {};
    this.list = new Map();
    this.byHash = new Map();
    this.halls = data.halls && typeof data.halls === 'object' ? data.halls : {};   // CODE -> {holding}
    for (const d of Array.isArray(data.displays) ? data.displays : []) {
      if (!d || typeof d.id !== 'string' || !/^[0-9a-f]{64}$/.test(d.tokenHash || '')) continue;
      d.live = freshLive();
      this.list.set(d.id, d);
      this.byHash.set(d.tokenHash, d);
    }
  }

  save() {
    // `live` is runtime state (who has the link open, what it last showed): never saved.
    this.lane.save(() => JSON.stringify({ v: 1, halls: this.halls, displays: Array.from(this.list.values()).map(({ live, ...d }) => d) }, null, 1));
  }
  flush() { this.lane.flushSync(); }

  get(id) { return this.list.get(id) || null; }
  ofHall(code) { return Array.from(this.list.values()).filter((d) => d.hall === code).sort((a, b) => a.name.localeCompare(b.name)); }
  /** The display a URL token opens, or null — by hash, so the token is never compared character by character. */
  byToken(token) { return typeof token === 'string' && TOKEN.test(token) ? this.byHash.get(sha256(token)) || null : null; }
  /** The display's URL path (the token unsealed), for a manager to copy. */
  path(d) { const t = this.open(d.tokenSealed); return t ? '/d/' + t : ''; }

  create(hall, name, by = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const d = {
      id: 'd' + makeId(), hall, name: guard.cleanText(name, 60) || 'Screen', tokenHash: sha256(token), tokenSealed: this.seal(token),
      content: { kind: 'holding' }, seq: 1, createdAt: Date.now(), updatedAt: Date.now(), updatedBy: by,
      live: freshLive(),
    };
    this.list.set(d.id, d);
    this.byHash.set(d.tokenHash, d);
    this.save();
    return { display: d, path: '/d/' + token };
  }

  /** A new URL for a display: the old one stops working at once. Returns the new path. */
  rotate(id) {
    const d = this.get(id);
    if (!d) return '';
    this.byHash.delete(d.tokenHash);
    const token = crypto.randomBytes(32).toString('base64url');
    d.tokenHash = sha256(token); d.tokenSealed = this.seal(token);
    this.byHash.set(d.tokenHash, d);
    this.save();
    return '/d/' + token;
  }

  update(id, { name, hall } = {}) {
    const d = this.get(id);
    if (!d) return null;
    if (typeof name === 'string' && guard.cleanText(name, 60)) d.name = guard.cleanText(name, 60);
    if (typeof hall === 'string' && hall) d.hall = hall;
    this.save();
    return d;
  }

  /** Put a content on a display (already cleaned): the next seq, which the display confirms when it shows it. */
  take(id, content, by = '') {
    const d = this.get(id);
    if (!d) return null;
    d.content = content; d.seq += 1; d.updatedAt = Date.now(); d.updatedBy = by;
    this.save();
    return d;
  }

  /**
   * A browser opened the link. `key` is the screen (its page's own key, so a reconnect after a blip is the same screen
   * again, not a second one), `sid` its connection: the newest connection of a screen is the one that counts.
   */
  joined(d, key, sid = key) { d.live.reports.set(key, { sid, seq: 0, ok: true, words: '', seenAt: 0 }); }
  /** A connection closed: its screen leaves the link, unless the screen has come back on a newer connection. */
  left(d, key, sid = key) { const r = d.live.reports.get(key); if (r && r.sid === sid) d.live.reports.delete(key); }
  /** How many browsers hold the link. */
  static screens(d) { return d.live.reports.size; }

  /**
   * One browser says what it showed. Only its newest seq counts (an older report is a late echo), and only from the
   * screen's current connection.
   */
  shown(d, key, seq, ok, words, sid = key) {
    const r = d.live.reports.get(key);
    if (!r || r.sid !== sid || !Number.isInteger(seq) || seq < r.seq || seq > d.seq) return false;
    r.seq = seq; r.ok = ok !== false; r.words = guard.cleanText(words, 160); r.seenAt = Date.now();
    return true;
  }

  remove(id) {
    const d = this.get(id);
    if (!d) return false;
    this.list.delete(id); this.byHash.delete(d.tokenHash);
    this.save();
    return true;
  }

  removeHall(code) { let n = 0; for (const d of this.ofHall(code)) { this.remove(d.id); n++; } if (this.halls[code]) { delete this.halls[code]; this.save(); } return n; }

  hallHolding(code) { return (this.halls[code] && this.halls[code].holding) || ''; }
  setHallHolding(code, url) { this.halls[code] = { ...(this.halls[code] || {}), holding: url || '' }; if (!url) delete this.halls[code]; this.save(); }

  /**
   * A display as an operator sees it: its state in a word and a shape (never colour alone), and what is on it. With
   * several browsers on the link the words carry the count; a screen's note on a take it showed (a PDF page past the end)
   * follows "on screen". `hallHolding` is the hall's holding image, which Holding shows when it has none of its own.
   */
  static status(d, hallHolding = '') {
    const reports = Array.from(d.live.reports.values());
    const n = reports.length;
    const newest = reports.filter((r) => r.seq === d.seq);
    const failed = newest.filter((r) => !r.ok);
    const done = newest.length - failed.length;
    const of = (k) => ' on ' + k + ' of ' + n + ' screens';
    let state, mark, words;
    if (!n) { state = 'offline'; mark = '✕'; words = 'offline — no screen has this link open'; }
    else if (failed.length) { state = 'error'; mark = '△'; words = 'could not show it' + (n > 1 ? of(failed.length) : '') + ': ' + (failed[0].words || 'unknown'); }
    else if (done < n) { state = 'sending'; mark = '…'; words = 'sending' + (done ? ' —' + of(done) : ''); }
    else {
      const note = newest.map((r) => r.words).find(Boolean);
      state = 'shown'; mark = '✓'; words = (n > 1 ? 'on all ' + n + ' screens' : 'on screen') + (note ? ': ' + note : '');
    }
    return { id: d.id, name: d.name, hall: d.hall, state, mark, words, showing: describe(d.content, hallHolding), content: d.content, seq: d.seq, screens: n, updatedAt: d.updatedAt };
  }
}

module.exports = { Displays, cleanContent, describe, KINDS, TONES, TOKEN };
