'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): the server runs as the CI build AGM_TEST_STAMP names (the
// JSON tools/stamp-build.js writes), read where it reads app/build.json, so a test can run a numbered build without a
// file in the tree that every other test would read too. Nothing else of the server is changed.
const fs = require('fs');
const path = require('path');

const stampFile = path.join(__dirname, '..', 'build.json');
const stamp = process.env.AGM_TEST_STAMP || '';
const readFileSync = fs.readFileSync;
fs.readFileSync = function readStamp(file, ...rest) {
  if (stamp && typeof file === 'string' && path.resolve(file) === stampFile) return stamp;
  return readFileSync.call(this, file, ...rest);
};
