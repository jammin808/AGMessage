'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): Date.now runs ahead by the milliseconds written in the file
// AGM_TEST_CLOCK names, read again whenever that file changes, so a test moves the wall clock hours on without waiting.
// Each offset taken is written back to <file>.ack, so the test knows the server runs on it.
const fs = require('fs');

const file = process.env.AGM_TEST_CLOCK;
if (file) {
  const realNow = Date.now;
  let offset = 0;
  const read = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }   // mid-write: the next change is read
    const v = Number(text);
    if (!Number.isFinite(v)) return;
    offset = v;
    fs.writeFileSync(file + '.ack', String(v));
  };
  read();
  fs.watchFile(file, { interval: 20 }, read).unref();
  Date.now = () => realNow() + offset;
}
