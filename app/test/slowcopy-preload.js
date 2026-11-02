'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): a copy the disk is slow to take, as a show laptop's
// antivirus makes one. Each file and folder fs.cpSync takes waits AGM_TEST_SLOW_COPY_MS before it is copied, the loop held
// as a long copy holds it; the copy itself is the system's. Nothing else of the server is changed.
const fs = require('fs');

const ms = Number(process.env.AGM_TEST_SLOW_COPY_MS) || 0;
const held = new Int32Array(new SharedArrayBuffer(4));
const cpSync = fs.cpSync;
fs.cpSync = function cpSlowly(from, to, options = {}) {
  const filter = options.filter || (() => true);
  return cpSync.call(this, from, to, { ...options, filter: (...args) => { Atomics.wait(held, 0, 0, ms); return filter(...args); } });
};
