'use strict';
// Preloaded into a process under test (NODE_OPTIONS=--require), the watchdog and its server alike: every module the process
// asks for once this file has run is written to the file AGM_TEST_RESOLVES names, one JSON line each: who asked (`from`,
// its URL), what (`asked`) and where Node resolved it (`url`), or that it resolved nowhere (`nowhere`, the error's code):
// Node's walk went from the asking file's folder up through every folder above it to the drive's root, and on through its
// global folders (NODE_PATH among them), and found nothing, so a module planted in any of them would have been loaded.
// Each process's first line is its own start: the script it runs and ws's two switches (WS_NO_BUFFER_UTIL,
// WS_NO_UTF_8_VALIDATE) as its parent started it with them. The hook only reads Node's resolution, never changes it
// (module.registerHooks: in the process's own thread and synchronous, so require() and import go through it alike).
const fs = require('node:fs');
const { registerHooks } = require('node:module');

const file = process.env.AGM_TEST_RESOLVES;
if (file) {
  const note = (row) => fs.appendFileSync(file, JSON.stringify({ pid: process.pid, ...row }) + '\n');
  note({ start: process.argv[1] || '', ws: [process.env.WS_NO_BUFFER_UTIL || '', process.env.WS_NO_UTF_8_VALIDATE || ''] });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let resolved;
      try { resolved = nextResolve(specifier, context); } catch (e) {
        note({ from: context.parentURL || '', asked: specifier, nowhere: (e && e.code) || 'unknown' });
        throw e;
      }
      note({ from: context.parentURL || '', asked: specifier, url: resolved.url });
      return resolved;
    },
  });
}
