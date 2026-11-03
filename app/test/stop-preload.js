'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): the order in which it saves, written to the file
// AGM_TEST_SAVES names as the process exits, one step a line: `audit` (the audit log's flush), `lane <file>` (a write
// lane's flush, the audit head's inside the audit's own), `compact <code>` (a hall's snapshot asked for), `rename <file>`
// (a file put in place: a lane's, a snapshot's, the stop's record) and `stop`, where the server was asked to stop over
// IPC. Each step is recorded, then done as it would have been: nothing the server does is changed. A process killed
// writes nothing.
const fs = require('fs');
const path = require('path');

const file = process.env.AGM_TEST_SAVES;
if (file) {
  const steps = [];
  const resilience = require('../lib/resilience');
  const { RoomStore } = require('../lib/store');
  const { AuditLog } = require('../lib/audit');
  const record = (proto, name, step) => {
    const was = proto[name];
    proto[name] = function recorded(...args) { steps.push(step(this, args)); return was.apply(this, args); };
  };
  record(AuditLog.prototype, 'flush', () => 'audit');
  record(resilience.WriteLane.prototype, 'flushSync', (lane) => 'lane ' + path.basename(lane.file));
  record(RoomStore.prototype, 'compact', (store, [code]) => 'compact ' + code);
  const renameSync = fs.renameSync;
  fs.renameSync = function recordedRename(from, to) { steps.push('rename ' + path.basename(String(to))); return renameSync.call(this, from, to); };
  // Heard before the server's own listener, which this preload's comes ahead of: the mark falls before the stop's steps.
  process.on('message', (m) => { if (m && m.t === 'stop') steps.push('stop'); });
  const writeFileSync = fs.writeFileSync;
  process.on('exit', () => { writeFileSync(file, steps.join('\n') + '\n'); });
}
