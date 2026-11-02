'use strict';
// What the audit log's work does on the event loop, counted as work, never timed: how long a turn takes is the machine's
// (a busy one stretches it), how much a turn does is the code's. Preloaded into a server under test (NODE_OPTIONS=--require,
// AGM_TEST_AUDIT naming the file it writes), or run in this process through `meter()`.
//
// The work is a walk (AuditLog#_verify), an export (Exporter#run), a split (Archiver#split) and an archive's own Check
// (Archiver#checkArchive). While any of it runs, what it does is counted, and the next turn of the loop closes the count
// (a setImmediate, asked for by the first thing counted after a turn: the meter adds no turns of its own); `most` holds
// the most of each between two turns:
//   lines     entries walked (Runs#next of the rules: the check's walk, and the verifier's walk of an archive)
//   macs      entries MAC-checked one at a time (AuditLog#macHolds: an archive's own Check)
//   digested  bytes of the chain's files (audit*.jsonl) hashed on the loop, SHA-256 (Hash#update) and CRC-32 (zlib.crc32),
//             from a buffer one of those files was read into
// Beside them: {walks, atOnce (walks running at once, at most), turns (that closed a count; the one in progress included),
// syncReads and asyncReads (reads of the chain's files while the work runs: readFileSync, openSync to read, or readSync
// on a descriptor open on one; fs.promises.readFile, or a read through a handle fs.promises.open gave; an append is no
// read), reading (those reads in flight at once, at most: each holds one of the thread pool's threads), deflating (raw
// deflate work in flight at once, at most, a chunk handed to zlib until it is deflated: each holds another)}.
//
// In a server, a request under /api/audit/ carrying `x-agm-test-hold` starts the counts afresh, the work already running
// included, and the work's reads of the chain wait:
//   n (a number)  until n such requests have come, so n clicks reach the server while one walk runs, however the machine
//                 schedules them (1 holds nothing);
//   sign-in       until a sign-in (POST /api/auth/login) is answered while one of those reads waits, so the sign-in is
//                 answered while the work holds whatever it holds (its slot, its entry, the files it opened).
// The file says too how many such requests came (`held`), how many reads waited (`waiting`), and what let them go
// (`opened`: 'all came', 'sign-in', or 'timer' after 20 s, so a hold never met ends and its test says so). It is written
// as a read starts to wait, and as each request carrying the header is answered, before its last byte is sent: never
// after a test has heard that answer, so the test reads it whole.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { AuditLog } = require('../lib/audit');
const { Exporter } = require('../lib/auditexport');
const { Archiver } = require('../lib/auditarchive');
const rules = require('../verify/auditrules');

const KINDS = ['lines', 'macs', 'digested'];
const fresh = () => ({ walks: 0, atOnce: 0, lines: 0, macs: 0, digested: 0, turns: 0, most: { lines: 0, macs: 0, digested: 0 }, syncReads: 0, asyncReads: 0, reading: 0, deflating: 0 });
const ofChain = (p) => /^audit[^/\\]*\.jsonl$/.test(path.basename(String(p)));
// Opened to read: 'r', 'rs', 'r+' or none; or by number, read-only or read-write.
const toRead = (flags) => (typeof flags === 'number' ? (flags & 3) !== fs.constants.O_WRONLY : flags === undefined || flags === null || /^r/.test(String(flags)));
// A buffer that owns its memory whole: only such a buffer is marked as a file's, never the pool small buffers share.
const whole = (b) => ArrayBuffer.isView(b) && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength;

/**
 * Count the work from now. `wait()`, asked before each read of the chain while the work runs, may answer a promise the
 * read waits for. Answers {seen() (the counts as they stand), reset() (count afresh), restore() (every function put back)}.
 */
function install({ wait = () => null } = {}) {
  let seen = fresh();
  let busy = 0;           // pieces of work running
  let walking = 0;
  let inFlight = 0;
  let deflates = 0;
  let asked = false;      // a turn is asked for: something was counted since the last one
  const since = { lines: 0, macs: 0, digested: 0 };
  const ofLog = new WeakSet();   // the memory a chain's file was read into
  const chainHandles = new WeakSet();
  const chainFds = new Set();    // descriptors open on the chain's files, while they are open
  const undo = [];
  const patch = (host, name, make) => {
    const own = Object.prototype.hasOwnProperty.call(host, name);
    const real = host[name];
    host[name] = make(real);
    undo.push(() => { if (own) host[name] = real; else delete host[name]; });
  };
  const turn = () => {
    asked = false;
    for (const k of KINDS) { seen.most[k] = Math.max(seen.most[k], since[k]); since[k] = 0; }
    seen.turns++;
  };
  const add = (kind, n) => {
    if (!busy) return;
    since[kind] += n;
    seen[kind] += n;
    if (!asked) { asked = true; setImmediate(turn); }
  };
  const mark = (b) => { if (whole(b)) ofLog.add(b.buffer); return b; };
  const digested = (data) => { if (ArrayBuffer.isView(data) && ofLog.has(data.buffer)) add('digested', data.byteLength); };

  /** `name` of `Cls` as a piece of work: counted from its call until the promise it answers settles. */
  const work = (Cls, name, { walk = false } = {}) => patch(Cls.prototype, name, (real) => function (...args) {
    busy++;
    if (walk) { walking++; seen.walks++; seen.atOnce = Math.max(seen.atOnce, walking); }
    const done = () => { busy--; if (walk) walking--; };
    let p;
    try { p = real.apply(this, args); } catch (e) { done(); throw e; }
    Promise.resolve(p).then(done, done);   // attached first: the work has ended before its callers hear it
    return p;
  });
  work(AuditLog, '_verify', { walk: true });
  work(Exporter, 'run');
  work(Archiver, 'split');
  work(Archiver, 'checkArchive');

  patch(rules.Runs.prototype, 'next', (real) => function (e) { add('lines', 1); return real.call(this, e); });
  patch(AuditLog.prototype, 'macHolds', (real) => function (e) { add('macs', 1); return real.call(this, e); });
  patch(Object.getPrototypeOf(crypto.createHash('sha256')), 'update', (real) => function (data, ...rest) { digested(data); return real.call(this, data, ...rest); });
  patch(zlib, 'crc32', (real) => function (data, ...rest) { digested(data); return real.call(this, data, ...rest); });
  // A stream's chunks, and its end (_flush hands its last one here too), each until zlib has deflated it.
  patch(zlib.DeflateRaw.prototype, '_transform', (real) => function (chunk, encoding, cb) {
    if (!busy) return real.call(this, chunk, encoding, cb);
    seen.deflating = Math.max(seen.deflating, ++deflates);
    return real.call(this, chunk, encoding, (...a) => { deflates--; cb(...a); });
  });

  /** A read of the chain while the work runs: counted, held while a hold waits, and in flight until it ends. */
  const reading = async (read) => {
    seen.asyncReads++;
    const held = wait();
    if (held) await held;
    seen.reading = Math.max(seen.reading, ++inFlight);
    try { return await read(); } finally { inFlight--; }
  };
  patch(fs, 'readFileSync', (real) => function (p, ...rest) {
    if (!busy || !ofChain(p)) return real.call(this, p, ...rest);
    seen.syncReads++;
    return mark(real.call(this, p, ...rest));
  });
  patch(fs, 'openSync', (real) => function (p, flags, ...rest) {
    const fd = real.call(this, p, flags, ...rest);
    if (ofChain(p) && toRead(flags)) { chainFds.add(fd); if (busy) seen.syncReads++; }
    return fd;
  });
  patch(fs, 'readSync', (real) => function (fd, buf, ...rest) {
    if (busy && chainFds.has(fd)) { seen.syncReads++; mark(buf); }
    return real.call(this, fd, buf, ...rest);
  });
  patch(fs, 'closeSync', (real) => function (fd, ...rest) { chainFds.delete(fd); return real.call(this, fd, ...rest); });
  patch(fs.promises, 'readFile', (real) => async function (p, ...rest) {
    if (!busy || !ofChain(p)) return real.call(this, p, ...rest);
    return mark(await reading(() => real.call(this, p, ...rest)));
  });
  let handleRead = false;
  patch(fs.promises, 'open', (real) => async function (p, ...rest) {
    const fh = await real.call(this, p, ...rest);
    if (ofChain(p)) { chainHandles.add(fh); chainFds.add(fh.fd); }
    if (!handleRead) {
      // Every handle shares one prototype: its read is counted where the handle is one of the chain's.
      handleRead = true;
      const proto = Object.getPrototypeOf(fh);
      patch(proto, 'read', (read) => async function (buf, ...more) {
        if (!busy || !chainHandles.has(this)) return read.call(this, buf, ...more);
        mark(buf);
        const r = await reading(() => read.call(this, buf, ...more));
        if (r && r.buffer) mark(r.buffer);
        return r;
      });
      patch(proto, 'close', (close) => function (...more) { if (chainHandles.has(this)) chainFds.delete(this.fd); return close.apply(this, more); });
    }
    return fh;
  });

  return {
    seen() {
      const most = {};
      for (const k of KINDS) most[k] = Math.max(seen.most[k], since[k]);
      return { ...seen, most, turns: seen.turns + (asked ? 1 : 0) };
    },
    reset() { seen = fresh(); for (const k of KINDS) since[k] = 0; },
    restore() { while (undo.length) undo.pop()(); },
  };
}

/** In this process: count from now; `stop()` puts every function back and answers the counts. */
function meter() {
  const m = install();
  return { seen: m.seen, stop: () => { m.restore(); return m.seen(); } };
}

const file = process.env.AGM_TEST_AUDIT;
if (file) {
  let hold = null;   // {want: n or 'sign-in', came, opened, all: a promise kept when it opens, open(why)}
  let waiting = 0;
  const write = () => fs.writeFileSync(file, JSON.stringify({ ...m.seen(), held: hold ? hold.came : 0, waiting, opened: hold ? hold.opened : '' }));
  const m = install({
    wait: () => {
      if (!hold || hold.opened) return null;
      waiting++;
      write();
      return hold.all;
    },
  });
  const opening = (want) => {
    let open = null;
    const h = { want, came: 0, opened: '', all: new Promise((resolve) => { open = resolve; }) };
    h.open = (why) => { if (!h.opened) { h.opened = why; open(); } };
    setTimeout(() => h.open('timer'), 20_000).unref();
    return h;
  };

  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (ev, req, res) {
    if (ev === 'request') {
      const url = String(req.url);
      const asked = url.startsWith('/api/audit/') ? req.headers['x-agm-test-hold'] : undefined;
      const n = Number(asked);
      if (asked === 'sign-in' || (Number.isSafeInteger(n) && n > 0)) {
        const want = asked === 'sign-in' ? asked : n;
        if (!hold || hold.opened || hold.want !== want) { hold = opening(want); waiting = 0; m.reset(); }
        hold.came++;
        if (typeof want === 'number' && hold.came >= want) hold.open('all came');
        const end = res.end;
        res.end = function (...args) { write(); return end.apply(this, args); };
      }
      if (req.method === 'POST' && url.startsWith('/api/auth/login')) {
        const h = hold;
        res.once('finish', () => { if (h && h.want === 'sign-in' && !h.opened && waiting > 0) h.open('sign-in'); });
      }
    }
    return emit.apply(this, arguments);
  };
}

module.exports = { meter };
