'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): files another program holds, as an antivirus or a backup
// holds one at start, or one this account may not read. Each file whose base name is in AGM_TEST_UNREADABLE ('|' between
// names) cannot be read: every fs.readFileSync of it throws AGM_TEST_UNREADABLE_CODE (EBUSY unless told; EACCES as a
// file this account may not read, which a test run as root cannot make with permissions). Each in AGM_TEST_UNWRITABLE
// cannot be replaced: a rename onto it throws EBUSY. The files themselves are never touched, so a test reads them after
// to tell they were never written over. Nothing else of the server is changed.
const fs = require('fs');
const path = require('path');

const names = (v) => new Set(String(v || '').split('|').filter(Boolean));
const unreadable = names(process.env.AGM_TEST_UNREADABLE);
const unwritable = names(process.env.AGM_TEST_UNWRITABLE);
const code = process.env.AGM_TEST_UNREADABLE_CODE || 'EBUSY';
const held = (set, file) => (typeof file === 'string' || Buffer.isBuffer(file)) && set.has(path.basename(String(file)));
const fail = (c, syscall, file) => Object.assign(new Error(c + ': held by another program, ' + syscall + ' \'' + file + '\''), { code: c, syscall, path: String(file) });

const readFileSync = fs.readFileSync;
fs.readFileSync = function readUnlessHeld(file, ...rest) {
  if (held(unreadable, file)) throw fail(code, 'open', file);
  return readFileSync.call(this, file, ...rest);
};
const renameSync = fs.renameSync;
fs.renameSync = function renameUnlessHeld(from, to) {
  if (held(unwritable, to)) throw fail('EBUSY', 'rename', to);
  return renameSync.call(this, from, to);
};
