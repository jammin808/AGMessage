'use strict';
/**
 * Downloads (plan 4-§4.6.6): a download is the server's own act, by a ticket a socket is given for a seat that may
 * download (lib/pages.js mayDownload), never a GET. The page posts the ticket in a form (`POST /uploads/:name/download`,
 * server.js), and only then is the file sent, as an attachment under the message's name with its stored type.
 *
 * Invariants:
 *   - A ticket is 18 random bytes, kept here in memory only (a restart voids every one), and is good for one use within
 *     TTL_MS, at the address the socket that asked had, for the one file it was issued for: taken out at its first use,
 *     whether that use is answered with the file or not.
 *   - Bounded: at most LIVE tickets live, the oldest going first; and at most PER_PAGE live for one socket and PER_PERSON
 *     for one person, read before the bound in all, so one page never pushes another person's tickets out.
 *   - A take's tickets (issued for a take shown with Download ticked) are voided when the take is withdrawn.
 *   - The name a file saves under is the message's, its stem cleaned of what Windows refuses in a name, its extension
 *     always the stored file's own: "Agenda.cmd" for a `.txt` saves as "Agenda.txt".
 *
 * Pure but for its clock and the CSPRNG (node:crypto): it reaches no disk and no socket.
 */
const crypto = require('crypto');

/** The most tickets live at once, for one socket, and for one person; and how long one lives. */
const LIVE = 1000;
const PER_PAGE = 4;
const PER_PERSON = 8;
const TTL_MS = 60_000;

/** What a page that asks for a ticket past its bounds is told. */
const BUSY = 'Finish the downloads already started first.';

class Tickets {
  constructor({ now = () => Date.now(), live = LIVE, perPage = PER_PAGE, perPerson = PER_PERSON, ttl = TTL_MS } = {}) {
    this.now = now;
    this.live = live;
    this.perPage = perPage;
    this.perPerson = perPerson;
    this.ttl = ttl;
    this.book = new Map();   // ticket -> {name, filename, ext, transferOnly, uid, address, sid, hall, seq, until}
  }
  /** The tickets past their time, let go. */
  prune(at = this.now()) {
    for (const [t, r] of this.book) if (r.until <= at) this.book.delete(t);
  }
  /** How many tickets are live now. */
  get size() { this.prune(); return this.book.size; }
  /**
   * A ticket for `rec` ({name: the stored upload's name, filename, ext, transferOnly, uid, address, sid, hall, seq?}):
   * {ticket}, or {error} past a page's or a person's bound. Past LIVE in all, the oldest goes.
   */
  issue(rec) {
    const at = this.now();
    this.prune(at);
    let page = 0;
    let person = 0;
    for (const r of this.book.values()) {
      if (r.sid === rec.sid) page++;
      if (r.uid === rec.uid) person++;
    }
    if (page >= this.perPage || person >= this.perPerson) return { error: BUSY };
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.book.set(ticket, { ...rec, seq: Number.isInteger(rec.seq) ? rec.seq : 0, until: at + this.ttl });
    while (this.book.size > this.live) this.book.delete(this.book.keys().next().value);
    return { ticket };
  }
  /**
   * The ticket `ticket`, taken out (one use): its record when it names the upload `name`, was issued at `address` and is
   * within its time; null otherwise (an unknown, spent, expired one, or one for another file or address), which is spent
   * all the same.
   */
  take(ticket, { name, address }) {
    if (typeof ticket !== 'string' || !this.book.has(ticket)) return null;
    const r = this.book.get(ticket);
    this.book.delete(ticket);
    return r.until > this.now() && r.name === name && r.address === address ? r : null;
  }
  /** Every ticket issued for the take numbered `seq` of `hall`, voided (a withdrawn take). Returns how many went. */
  voidTake(hall, seq) {
    let n = 0;
    for (const [t, r] of this.book) if (r.seq && r.seq === seq && r.hall === hall) { this.book.delete(t); n++; }
    return n;
  }
}

/** What Windows refuses in a file's name, and the control characters. */
const RESERVED = /[\\/:*?"<>|\p{Cc}]/gu;
/**
 * The name a file saves under, as `{stem, ext}`: the message's name, its own trailing extension dropped (whatever it is:
 * the stored file's is put back), what Windows refuses removed and trailing dots and spaces trimmed; "file" when nothing
 * is left. `ext` is the stored file's own.
 */
function savedName(filename, ext) {
  let stem = String(filename || '').replace(RESERVED, '');
  stem = stem.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[. ]+$/, '').trim();
  return { stem: stem || 'file', ext: String(ext || '').toLowerCase() };
}
/** RFC 5987's encoding of a value: UTF-8, percent-encoded, with every character outside its attr-char set escaped. */
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/**
 * The Content-Disposition of a download (RFC 6266): `attachment`, an ASCII fallback (anything else, and `%`, as `_`) and
 * the true name as `filename*` (UTF-8, RFC 5987), each `<stem>.<ext>` with the stored file's extension.
 */
function attachment(filename, ext) {
  const { stem, ext: e } = savedName(filename, ext);
  const ascii = stem.replace(/[^\x20-\x7e]|%/g, '_');
  const dot = e ? '.' + e : '';
  return 'attachment; filename="' + ascii + dot + '"; filename*=UTF-8\'\'' + rfc5987(stem + dot);
}

module.exports = { LIVE, PER_PAGE, PER_PERSON, TTL_MS, BUSY, Tickets, savedName, attachment };
