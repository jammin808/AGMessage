'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): what the audit log's check does on the event loop, counted
// as work, never timed, so a busy machine changes none of it. A walk is one AuditLog#_verify, and it reads one line per
// call of the rules' wholeEntry. While a walk runs, a setImmediate comes round once per turn of the loop, and the lines
// read since the turn before are counted there. As each walk ends, the file AGM_TEST_AUDIT names is written with what
// was counted: {walks, atOnce (walks running at once, at most), lines, turns, most (lines read between two turns, at
// most), syncReads and asyncReads (reads of the chain's files, audit*.jsonl, while a walk runs; an append is no read),
// held}.
// A request for /api/audit/verify carrying `x-agm-test-hold: n` opens a hold for n such requests (the count starts again
// from it): a walk's read of the chain waits until all n have come, so n clicks reach the server while that one walk
// runs, however the machine schedules them. A hold left short lets go after 20 s, its `held` saying how many came.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { AuditLog } = require('../lib/audit');
const rules = require('../verify/auditrules');

const file = process.env.AGM_TEST_AUDIT;
if (file) {
  const fresh = () => ({ walks: 0, atOnce: 0, lines: 0, turns: 0, most: 0, syncReads: 0, asyncReads: 0, held: 0 });
  let seen = fresh();
  let running = 0;
  let since = 0;          // lines read since the last turn
  let turning = false;
  let hold = null;        // {want, came, all: a promise kept when all have come, open()}
  const ofChain = (p) => /^audit[^/\\]*\.jsonl$/.test(path.basename(String(p)));
  // Opened to read: 'r', 'rs', 'r+' or none; or by number, read-only or read-write.
  const reading = (flags) => (typeof flags === 'number' ? (flags & 3) !== fs.constants.O_WRONLY : flags === undefined || flags === null || /^r/.test(String(flags)));

  const turn = () => {
    seen.most = Math.max(seen.most, since);
    since = 0;
    seen.turns++;
    if (running) setImmediate(turn);
    else turning = false;
  };
  const walk = AuditLog.prototype._verify;
  AuditLog.prototype._verify = function (...args) {
    running++;
    seen.walks++;
    seen.atOnce = Math.max(seen.atOnce, running);
    if (!turning) { turning = true; since = 0; setImmediate(turn); }
    const ended = () => { running--; fs.writeFileSync(file, JSON.stringify(seen)); };
    const p = walk.apply(this, args);
    p.then(ended, ended);   // before the walk's callers hear it: the file is written before any click is answered
    return p;
  };
  const whole = rules.wholeEntry;
  rules.wholeEntry = function (text) {
    if (running) { since++; seen.lines++; }
    return whole(text);
  };

  const readSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (running && ofChain(p)) seen.syncReads++;
    return readSync.call(this, p, ...rest);
  };
  const openSync = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    if (running && ofChain(p) && reading(flags)) seen.syncReads++;
    return openSync.call(this, p, flags, ...rest);
  };
  const read = fs.promises.readFile;
  fs.promises.readFile = async function (p, ...rest) {
    if (running && ofChain(p)) {
      seen.asyncReads++;
      if (hold && hold.came < hold.want) await hold.all;
    }
    return read.call(this, p, ...rest);
  };

  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (ev, req) {
    const want = ev === 'request' && String(req.url).startsWith('/api/audit/verify') ? Number(req.headers['x-agm-test-hold']) : 0;
    if (Number.isSafeInteger(want) && want > 0) {
      if (!hold || hold.came >= hold.want) {
        let open = null;
        hold = { want, came: 0, all: new Promise((resolve) => { open = resolve; }) };
        hold.open = open;
        seen = fresh();
        setTimeout(open, 20_000).unref();
      }
      hold.came++;
      seen.held = hold.came;
      if (hold.came >= hold.want) hold.open();
    }
    return emit.apply(this, arguments);
  };
}
