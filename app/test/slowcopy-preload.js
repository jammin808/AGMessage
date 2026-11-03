'use strict';
// Preloaded into a watchdog and its server under test (NODE_OPTIONS=--require): a copy the disk is slow to take, as a
// show laptop's antivirus makes one. In the server, each file and folder fs.cpSync takes waits AGM_TEST_SLOW_COPY_MS
// before it is copied, the loop held as a long copy holds it; the copy itself is the system's. With AGM_TEST_SLOW_COPY_LOG,
// that file gets a line as each one is taken, once the copy's own filter has run for it: `took beat` when the server told
// its watchdog it lives meanwhile (a beat sent on its channel), else `took none`; and the watchdog's line `heard` for each
// beat it hears from its server. Nothing else of either is changed: the beats are counted on their way, never sent, held
// or dropped here.
const fs = require('fs');

const ms = Number(process.env.AGM_TEST_SLOW_COPY_MS) || 0;
const log = process.env.AGM_TEST_SLOW_COPY_LOG || '';

if (process.env.AGM_SUPERVISED === '1') {
  const held = new Int32Array(new SharedArrayBuffer(4));
  let beats = 0;   // beats this server has sent its watchdog
  if (typeof process.send === 'function') {
    const send = process.send;
    process.send = function counted(m, ...rest) {
      if (m && m.t === 'beat') beats++;
      return send.call(this, m, ...rest);
    };
  }
  const cpSync = fs.cpSync;
  fs.cpSync = function cpSlowly(from, to, options = {}) {
    const filter = options.filter || (() => true);
    return cpSync.call(this, from, to, {
      ...options,
      filter: (...args) => {
        Atomics.wait(held, 0, 0, ms);
        const before = beats;
        const take = filter(...args);
        if (log) fs.appendFileSync(log, (beats > before ? 'took beat' : 'took none') + '\n');
        return take;
      },
    });
  };
} else if (log) {
  // The watchdog hears its server's messages as the ChildProcess's 'message' events.
  const { ChildProcess } = require('child_process');
  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function heard(name, m, ...rest) {
    if (name === 'message' && m && m.t === 'beat') fs.appendFileSync(log, 'heard\n');
    return emit.call(this, name, m, ...rest);
  };
}
