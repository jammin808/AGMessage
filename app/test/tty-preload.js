'use strict';
// Preloaded into a watchdog under test (NODE_OPTIONS=--require): its output is a console window, where a person sits, as
// the portable folder's black window is, though the test reads it through a pipe. Only `process.stdout.isTTY` is set;
// nothing else of the process is changed.
process.stdout.isTTY = true;
