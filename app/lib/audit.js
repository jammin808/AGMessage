'use strict';
/**
 * The audit log: who did what, when, from where — sign-ins, rights, halls, displays, sends to Stagewatch, commands to
 * other show systems, settings. Append-only (data/audit.jsonl, one JSON line per entry) and hash-chained, as a medical
 * device's audit trail is: each entry carries the SHA-256 of the one before it and of itself, so an edited, removed or
 * reordered line breaks the chain at that line, and `verify()` says where.
 *
 * Written synchronously and flushed: an action that changed what a room could see is on disk before it is acknowledged.
 * Never a secret: passwords, tokens, keys and display URLs are not fields an entry can carry (the caller passes words
 * and ids, and `entry()` keeps only the listed fields, each cut short). At 20 MB the file is rotated and the chain goes on
 * into the next one.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROTATE_BYTES = 20 * 1024 * 1024;
const GENESIS = '0'.repeat(64);

const canonical = (e) => JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, words: e.words, ip: e.ip, prev: e.prev });
const hashOf = (e) => crypto.createHash('sha256').update(canonical(e)).digest('hex');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v === undefined || v === null ? '' : String(v).slice(0, n));

class AuditLog {
  constructor(file) {
    this.file = file;
    this.seq = 0;
    this.last = GENESIS;
    this.recent = [];   // the last 500 entries, newest last, for the admin page
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-500)) { try { this.recent.push(JSON.parse(line)); } catch { /* a torn last line: verify() reports it */ } }
      const tail = this.recent[this.recent.length - 1];
      if (tail && Number.isInteger(tail.seq) && /^[0-9a-f]{64}$/.test(tail.h || '')) { this.seq = tail.seq; this.last = tail.h; }
    } catch { /* no log yet: the chain starts at the genesis hash */ }
  }

  /**
   * Record one action. `actor` {t:'account'|'admin'|'code'|'display'|'node'|'system', id, name}; `target` what it acted
   * on (an id, a username, a hall code); `words` what happened, in plain words, never a secret.
   */
  write(actor, action, target = '', words = '', ip = '') {
    const e = {
      seq: this.seq + 1, at: Date.now(),
      actor: { t: str(actor && actor.t, 12) || 'system', id: str(actor && actor.id, 40), name: str(actor && actor.name, 60) },
      action: str(action, 40), target: str(target, 80), words: str(words, 300), ip: str(ip, 64), prev: this.last,
    };
    e.h = hashOf(e);
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > ROTATE_BYTES) {
        fs.renameSync(this.file, this.file.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
      }
      const fd = fs.openSync(this.file, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(e) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (err) {
      console.error('  [audit] could not write: ' + err.message);
    }
    this.seq = e.seq; this.last = e.h;
    this.recent.push(e);
    if (this.recent.length > 500) this.recent.shift();
    return e;
  }

  /** The newest `limit` entries, newest first. */
  latest(limit = 200) { return this.recent.slice(-Math.max(1, Math.min(500, limit))).reverse(); }

  /** Check the whole chain in this file: {ok, entries, brokenAt?, why?}. */
  verify() {
    let lines;
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return { ok: true, entries: 0 }; }
    let prev = null;
    for (let i = 0; i < lines.length; i++) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { return { ok: false, entries: i, brokenAt: i + 1, why: 'line ' + (i + 1) + ' is not a whole entry' }; }
      if (prev !== null && e.prev !== prev.h) return { ok: false, entries: i, brokenAt: i + 1, why: 'entry ' + e.seq + ' does not follow the one before it' };
      if (prev !== null && e.seq !== prev.seq + 1) return { ok: false, entries: i, brokenAt: i + 1, why: 'an entry is missing before ' + e.seq };
      if (hashOf(e) !== e.h) return { ok: false, entries: i, brokenAt: i + 1, why: 'entry ' + e.seq + ' was changed after it was written' };
      prev = e;
    }
    return { ok: true, entries: lines.length };
  }
}

module.exports = { AuditLog, hashOf, GENESIS };
