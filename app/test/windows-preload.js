'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): "This laptop" asks Windows as it does on Windows. The plan
// made for Windows (lib/laptop.js windowsPlan, with SystemRoot C:\Windows) is written to the file AGM_TEST_WINDOWS_PLAN
// names, one JSON line per read, and the powershell.exe it names is stood in for by a node child, in that plan's
// environment and the two test names it reads, that writes its pid to that file's name and .pids, then prints what the
// file AGM_TEST_WINDOWS_ANSWER holds, or never answers when it is 'hang'; a file whose last line is HANG is printed up to
// that line, and then the child says no more, as a read that runs out of time part way. Its time, its end and its
// answer's reading are the server's own.
const fs = require('fs');
const laptop = require('../lib/laptop');

const record = process.env.AGM_TEST_WINDOWS_PLAN;
if (record) {
  const plan = laptop.windowsPlan;
  // The stand-in writes its pid beside the plans, so a test can say it ended.
  const answer = "require('fs').appendFileSync(process.env.AGM_TEST_WINDOWS_PLAN + '.pids', process.pid + '\\n'); const a = process.env.AGM_TEST_WINDOWS_ANSWER;"
    + " if (a === 'hang') setInterval(() => {}, 1000); else { const t = require('fs').readFileSync(a, 'utf8'); const at = t.indexOf('\\nHANG');"
    + " if (at >= 0) { process.stdout.write(t.slice(0, at + 1)); setInterval(() => {}, 1000); } else process.stdout.write(t); }";
  laptop.windowsPlan = (env, o) => {
    const p = plan({ ...env, SystemRoot: 'C:\\Windows' }, { ...o, platform: 'win32' });
    fs.appendFileSync(record, JSON.stringify(p) + '\n');
    // The plan's environment, which names no NODE_OPTIONS (the stand-in is a plain node, not another server under test),
    // and the two names the stand-in reads, the test's own.
    const childEnv = { ...p.options.env, AGM_TEST_WINDOWS_PLAN: record, AGM_TEST_WINDOWS_ANSWER: process.env.AGM_TEST_WINDOWS_ANSWER || '' };
    return { run: true, file: process.execPath, args: ['-e', answer], options: { windowsHide: true, env: childEnv } };
  };
}
