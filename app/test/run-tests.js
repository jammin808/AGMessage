'use strict';
/**
 * Runs node with the arguments given (the test runner, the coverage run or the browser smoke) inside a temporary folder of
 * its own: TMPDIR, TEMP and TMP point into it, so every throwaway data folder, upload folder and key folder a test makes
 * lands there, and the whole folder is removed when the run ends, passed or failed. A run leaves nothing behind in the
 * system's temporary folder, however many servers its tests started.
 *
 *   node test/run-tests.js --test "test/*.test.js"
 *   node test/run-tests.js test/browser-smoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-run-'));
const clean = () => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {
    process.stderr.write('run-tests: could not remove ' + root + ': ' + e.message + '\n');
  }
};

const child = spawn(process.execPath, process.argv.slice(2), {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
  stdio: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); });
child.on('exit', (code, signal) => {
  clean();
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
child.on('error', (e) => {
  process.stderr.write('run-tests: ' + e.message + '\n');
  clean();
  process.exit(1);
});
