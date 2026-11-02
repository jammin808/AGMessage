'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): the power request asks Windows as it does on Windows. The
// plan made for Windows (lib/power.js plan, with SystemRoot C:\Windows) is written to the file AGM_TEST_POWER_LOG names,
// one JSON line per start, and the powershell.exe it names is stood in for by a node child, in that plan's environment and
// the two test names it reads, that writes a line when it starts (its pid) and when its input closes, says what
// AGM_TEST_POWER_ANSWER names as the script says it (held, refused, failed, or nothing at all: silent) and, as the script
// does, ends once it has refused or failed, and otherwise waits on its standard input until that closes. Its start, its
// end and its answer's reading are the server's own.
const power = require('../lib/power');

const log = process.env.AGM_TEST_POWER_LOG;
if (log) {
  const plan = power.plan;
  const said = {
    held: '{"v":1}\n{"held":true}\n',
    refused: '{"v":1}\n{"refused":"PowerShell runs in ConstrainedLanguage mode on this PC, which refuses Add-Type"}\n',
    failed: '{"v":1}\n{"failed":"SetThreadExecutionState returned 0"}\n',
    silent: '',
  };
  const standIn = "const fs = require('fs'); const log = process.env.AGM_TEST_POWER_LOG; const a = process.env.AGM_TEST_POWER_ANSWER;"
    + " const line = (ev) => fs.appendFileSync(log, JSON.stringify({ ev, pid: process.pid }) + '\\n');"
    + " line('started'); process.stdout.write(JSON.parse(process.env.AGM_TEST_POWER_SAID)[a] || '');"
    + " if (a === 'refused' || a === 'failed') process.exit(0);"
    + " process.stdin.on('data', () => {}); process.stdin.on('end', () => { line('input closed'); process.exit(0); });";
  power.plan = (env, o) => {
    const p = plan({ ...env, SystemRoot: 'C:\\Windows' }, { ...o, platform: 'win32' });
    require('fs').appendFileSync(log, JSON.stringify({ ev: 'plan', plan: p }) + '\n');
    const answer = process.env.AGM_TEST_POWER_ANSWER || 'held';
    // The plan's environment, which names no NODE_OPTIONS (the stand-in is a plain node, not another server under test),
    // and the names the stand-in reads, the test's own.
    const childEnv = { ...p.options.env, AGM_TEST_POWER_LOG: log, AGM_TEST_POWER_ANSWER: answer, AGM_TEST_POWER_SAID: JSON.stringify(said) };
    return { run: true, file: process.execPath, args: ['-e', standIn], options: { windowsHide: true, env: childEnv } };
  };
}
