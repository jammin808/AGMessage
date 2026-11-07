'use strict';
/**
 * The machine's events, turned into audit rows by the server, the audit log's one writer. Only the machine's own commands
 * (machine.js, as SYSTEM or elevated) append to machine\events.jsonl; the installed server's task may read that one file
 * (AGM_MACHINE_EVENTS names it) and nothing else of machine\. Each event is one line {seq, at, kind, by, for, rights,
 * words}: `kind` one of KINDS, `by` and `for` Windows accounts ({sid, name}), `rights` the rights it names, `words` what was
 * done, never a token, a password or a path in a profile.
 *
 * The server reads the file after the hold and whenever the machine nudges it (POST /api/machine/events), and writes one
 * row per event it has not written, in `seq` order: the file, not the nudge, is the authority. The last seq written is kept
 * in settings, and each row names its seq at its words' end, so a restart that came before the settings were saved finds
 * it in the log's newest rows: a restart never writes an event twice or skips one. A row's words are bounded so that its
 * end (the rights, when the act was done, and the seq) is never cut. A row names both accounts by SID (the actor's id,
 * the target), since names are localised and can be renamed, and by name in its words. A line that is not an event is
 * passed over and said, never written; a read waits for the one before it. Read through fs.promises, so the loop is never
 * held.
 */
const fsp = require('node:fs/promises');
const { cleanText } = require('./guard');
const { whenUtc } = require('../verify/auditrules');

/**
 * The rows a machine event becomes (6-U.7): one action each, its kind's own. `machine.refused` is a request a control task
 * read whole and refused for want of the right (an account asking beyond its rights, or giving from one that is not the
 * laptop's admin); a request that is not one leaves no event.
 */
const KINDS = Object.freeze([
  'machine.admin', 'machine.grant', 'machine.revoke', 'machine.handover', 'machine.start', 'machine.stop',
  'machine.upgrade', 'machine.upgrade.refused', 'machine.import', 'machine.refused',
]);
/** The audit log's bound on a row's words (lib/audit.js WORDS_MAX, held equal by test/control.test.js). */
const WORDS_MAX = 300;
/** The rights an event may name (U.5.1). */
const RIGHTS = Object.freeze(['token', 'start', 'stop', 'upgrade']);
const KEYS = Object.freeze(['seq', 'at', 'kind', 'by', 'for', 'rights', 'words']);
const SID = /^S-1-[0-9-]{1,140}$/;
/** The most of the file a read takes: past it, its newest part (the events are a few hundred bytes each). */
const FILE_MAX = 4 * 1024 * 1024;
/** How a row names its event, at its words' end. */
const SEQ_SAID = / · machine event (\d{1,15})$/;

/** An account as an event names it, read by type: {sid, name}, or null. */
function accountOf(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.sid !== 'string' || typeof a.name !== 'string') return null;
  if (a.sid && !SID.test(a.sid)) return null;
  return { sid: a.sid, name: cleanText(a.name, 120) };
}
/**
 * One line of the file as its event, read by type (pure): exactly KEYS, `seq` a whole number from 1, `at` a time, `kind`
 * one of KINDS, `by` and `for` accounts, `rights` RIGHTS each once, `words` words; else null. Unknown words are refused,
 * never defaulted.
 */
function eventOf(line) {
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const keys = Object.keys(e);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  if (!Number.isSafeInteger(e.seq) || e.seq < 1 || !Number.isSafeInteger(e.at) || e.at < 0) return null;
  if (!KINDS.includes(e.kind) || typeof e.words !== 'string') return null;
  const by = accountOf(e.by);
  const forAccount = accountOf(e.for);
  if (!by || !forAccount) return null;
  if (!Array.isArray(e.rights) || !e.rights.every((r) => RIGHTS.includes(r)) || new Set(e.rights).size !== e.rights.length) return null;
  return { seq: e.seq, at: e.at, kind: e.kind, by, for: forAccount, rights: [...e.rights], words: cleanText(e.words, 300) };
}
/**
 * The audit row an event becomes (pure): actor the Windows account that asked ({t: 'windows', id: its SID, name}), the
 * action its kind, the target the SID of the account it was for (its name where it has none), and its words, then the
 * rights it named, when it was done (the event's own time, which a stop's row, written at the next start, needs) and its
 * seq. `scrub` takes a secret out of the words a person could have typed (the names, the words) before the words are
 * bounded, so the end is never cut: the event's words give way, with an ellipsis, never its seq.
 */
function rowOf(ev, scrub = (t) => t) {
  const named = (a) => scrub(a.name) || a.sid || 'an account not named';
  const rights = ev.rights.length && ev.kind !== 'machine.admin' ? ' [' + ev.rights.join(', ') + ']' : '';
  const tail = rights + ' · done ' + whenUtc(ev.at) + ' · machine event ' + ev.seq;
  const body = scrub(ev.words) || ev.kind;
  const room = WORDS_MAX - tail.length;
  return {
    actor: { t: 'windows', id: ev.by.sid, name: named(ev.by) },
    action: ev.kind,
    target: ev.for.sid || named(ev.for),
    words: (body.length > room ? body.slice(0, room - 1) + '…' : body) + tail,
  };
}
/** The seq a row names, when it is a machine event's row (pure); 0 otherwise. */
function seqOfRow(e) {
  if (!e || typeof e.action !== 'string' || !KINDS.includes(e.action) || typeof e.words !== 'string') return 0;
  const m = SEQ_SAID.exec(e.words);
  return m ? Number(m[1]) : 0;
}
/**
 * What a read writes (pure): the file's events above `last`, each once (the first line of a seq), in seq order, and how
 * many lines were not events. A torn last line (no newline yet) waits for the next read.
 */
function planOf(text, last) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] !== '') lines.pop();   // a line still being written, or no line at all
  const seen = new Map();
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = eventOf(line);
    if (!ev) { skipped++; continue; }
    if (ev.seq > last && !seen.has(ev.seq)) seen.set(ev.seq, ev);
  }
  return { events: [...seen.values()].sort((a, b) => a.seq - b.seq), skipped };
}

/** The file's text, its newest FILE_MAX bytes from a line's start when it is larger: '' when it is not there. */
async function readTail(file) {
  let h;
  try { h = await fsp.open(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  try {
    const { size } = await h.stat();
    const from = Math.max(0, size - FILE_MAX);
    const buf = Buffer.alloc(size - from);
    let n = 0;
    while (n < buf.length) { const { bytesRead } = await h.read(buf, n, buf.length - n, from + n); if (!bytesRead) break; n += bytesRead; }
    const text = buf.subarray(0, n).toString('utf8');
    return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await h.close(); }
}

/**
 * The server's reader of the machine's events. `file` the events file; `write(row)` an audit row written; `lastSeq()` the
 * last seq written (the settings' and the newest rows'); `saveSeq(seq)` keeps it; `blocked()` why nothing may be written
 * now ('' when it may: the settings must be readable, since they keep the seq); `log(line)` the console; `scrub(text)`
 * the words a row may carry with every secret taken out (rowOf's).
 */
class MachineEvents {
  constructor({ file, write, lastSeq, saveSeq, blocked = () => '', log = () => {}, read = readTail, scrub = (t) => t }) {
    Object.assign(this, { file, write, lastSeq, saveSeq, blocked, log, readFile: read, scrub });
    this.chain = Promise.resolve();
    this.written = 0;
    this.lastError = '';
    this.skippedSaid = 0;
  }
  /** Read the file and write each event not yet written: {read, written, skipped, words}. One read at a time, in order. */
  read() {
    const next = this.chain.then(() => this._read());
    this.chain = next.catch(() => {});
    return next;
  }
  async _read() {
    const why = this.blocked();
    if (why) return { read: 0, written: 0, skipped: 0, words: 'Not read: ' + why };
    let text;
    try { text = await this.readFile(this.file); } catch (e) {
      this.lastError = e.code || e.message;
      this.log('  Machine events: ' + this.file + ' could not be read (' + this.lastError + '); they are read again at the next nudge or start.');
      return { read: 0, written: 0, skipped: 0, words: 'Not read: ' + this.file + ' could not be read (' + this.lastError + ').' };
    }
    this.lastError = '';
    const last = this.lastSeq();
    const { events, skipped } = planOf(text, last);
    let top = last;
    for (const ev of events) {
      this.write(rowOf(ev, this.scrub));
      top = ev.seq;
      this.written++;
    }
    if (top > last) this.saveSeq(top);
    if (skipped !== this.skippedSaid && skipped) this.log('  Machine events: ' + skipped + ' line' + (skipped === 1 ? '' : 's') + ' of ' + this.file + ' ' + (skipped === 1 ? 'is' : 'are') + ' not a machine event and ' + (skipped === 1 ? 'was' : 'were') + ' not written.');
    this.skippedSaid = skipped;
    return { read: events.length, written: events.length, skipped, words: events.length ? 'Read: ' + events.length + ' machine event' + (events.length === 1 ? '' : 's') + ' written to the audit log.' : 'Read: nothing new.' };
  }
}

module.exports = { MachineEvents, eventOf, rowOf, seqOfRow, planOf, readTail, KINDS, RIGHTS, FILE_MAX, WORDS_MAX };
