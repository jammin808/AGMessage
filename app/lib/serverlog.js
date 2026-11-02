'use strict';
/**
 * What the console says, kept on disk: the watchdog's server's output and the watchdog's own lines, each line written to
 * `<data>/logs/server.log` as it comes, with its time, so the installed node, which has no window, keeps what a window
 * would have shown. Only the watchdog's process writes it, never the server, and never on a request.
 *
 *  - Bounded: once a line would take the file past `maxBytes` (2 MB) it becomes `server.1.log`, replacing the one before,
 *    and a new `server.log` begins, so the folder holds at most two files of it, about 4 MB. A show day's console is a few
 *    hundred lines; a port held for days is tried 2,880 times a day at the ladder's last step. Measured per try: 447
 *    bytes with every line kept and the watchdog's own line at each (about 1.3 MB a day), 139 bytes now that the watchdog
 *    keeps no blank line and says its line for a held try only where watchdog.log takes it (supervise.js): about 390 KB
 *    a day, so the two files hold some ten days of a held port.
 *  - A line longer than LINE_MAX is cut there and goes on as the next line, so no line holds the log's memory or its bound.
 *  - Never the admin token: each secret named (`secrets`) is searched for in every line by value, and written as
 *    [the admin token]; a stream read in lines (`Lines`) takes the secrets out before it cuts a line, so none is ever
 *    written in two halves. The watchdog's Token line never reaches it at all.
 *  - A log that cannot be written (a full disk, a folder another program holds) never stops the watchdog or holds a line
 *    back from the console: `onFail` says it once, each line after is tried again, and the first that lands says how many
 *    were not written.
 */
const fs = require('fs');
const path = require('path');

const LOG_MAX = 2 * 1024 * 1024;
const LINE_MAX = 16 * 1024;
const HIDDEN = '[the admin token]';

/**
 * `text` with every secret in `secrets` (strings of 8 or more characters) written as [the admin token], as it was given,
 * in lower case and in upper case (the server takes the token in lower case) (pure).
 */
function redact(text, secrets) {
  let out = String(text);
  for (const s of secretsOf(secrets)) {
    for (const form of new Set([s, s.toLowerCase(), s.toUpperCase()])) out = out.split(form).join(HIDDEN);
  }
  return out;
}

/** The secrets `redact` takes out: strings of 8 or more characters. */
const secretsOf = (secrets) => (Array.isArray(secrets) ? secrets : []).filter((s) => typeof s === 'string' && s.length >= 8);

/**
 * A stream's chunks as whole lines, the secrets (`secrets`, as `redact` takes them) written as [the admin token]:
 * `push(chunk)` gives `each` every line it completes (without its newline, a '\r' before it kept), `end()` the last one,
 * if it had no newline. A line longer than `max` goes as several, each at most `max`. The secrets are taken out of a whole
 * line before it is cut, and a line still coming is cut only where no secret can start before the cut and end after it
 * (the longest secret's length less one held back), so no piece holds part of one.
 */
class Lines {
  constructor(each, { max = LINE_MAX, secrets = [] } = {}) {
    this.each = each;
    this.max = max;
    this.secrets = secretsOf(secrets);
    this.carry = this.secrets.reduce((n, s) => Math.max(n, s.length - 1), 0);
    this.rest = '';
  }
  push(chunk) {
    let text = this.rest + String(chunk);
    let at;
    while ((at = text.indexOf('\n')) >= 0) {
      this.give(text.slice(0, at));
      text = text.slice(at + 1);
    }
    if (text.length >= this.max + this.carry) {
      text = redact(text, this.secrets);
      while (text.length >= this.max + this.carry) { this.each(text.slice(0, this.max)); text = text.slice(this.max); }
    }
    this.rest = text;
  }
  /** A whole line, its secrets taken out, as pieces of at most `max`. */
  give(line) {
    let l = redact(line, this.secrets);
    while (l.length > this.max) { this.each(l.slice(0, this.max)); l = l.slice(this.max); }
    this.each(l);
  }
  end() { if (this.rest) { const last = this.rest; this.rest = ''; this.give(last); } }
}

class ServerLog {
  /**
   * @param {string} file the log, `<data>/logs/server.log`; its folder is made at the first line
   * @param {{maxBytes?: number, secrets?: string[], onFail?: (words: string) => void, now?: () => Date}} o
   */
  constructor(file, { maxBytes = LOG_MAX, secrets = [], onFail = null, now = () => new Date() } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.secrets = secrets;
    this.onFail = onFail;
    this.now = now;
    this.size = null;      // the file's size as this writer knows it; read once, at its first line
    this.failed = '';      // the code of the failure now, '' while lines land
    this.lost = 0;         // lines not written since it began
    this.written = 0;      // lines written by this writer
  }

  /** One line of the console (no newline), with its time. Never throws. */
  line(text) {
    const data = this.now().toISOString() + ' ' + redact(text, this.secrets) + '\n';
    try {
      this.write(data);
      this.written++;
      if (this.failed) {
        const lost = this.lost;
        this.failed = '';
        this.lost = 0;
        this.write(this.now().toISOString() + ' [log] ' + lost + ' line' + (lost === 1 ? ' was' : 's were') + ' not written here before this one: the console had them\n');
      }
    } catch (e) {
      this.size = null;   // read again once it can be written
      this.lost++;
      const code = (e && e.code) || 'EIO';
      if (this.failed !== code) {
        this.failed = code;
        if (this.onFail) this.onFail(this.file + ' could not be written (' + code + '): the console keeps its lines, and each is tried here again');
      }
    }
  }

  write(data) {
    const bytes = Buffer.byteLength(data);
    if (this.size === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { this.size = fs.statSync(this.file).size; } catch (e) { if (e && e.code === 'ENOENT') this.size = 0; else throw e; }
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      fs.renameSync(this.file, this.file.replace(/\.log$/, '') + '.1.log');
      this.size = 0;
    }
    fs.appendFileSync(this.file, data, { mode: 0o600 });
    this.size += bytes;
  }
}

module.exports = { ServerLog, Lines, redact, LOG_MAX, LINE_MAX, HIDDEN };
