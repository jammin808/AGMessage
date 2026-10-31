'use strict';
// The portable folder's two .bat files: read as text on every platform (what cmd will run, in the order it runs it), and
// run by cmd on Windows (the test-windows job), each in a throwaway folder.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const START = path.join(REPO, 'start-agmessage.bat');
const CLEAN = path.join(REPO, 'make-shareable-copy.bat');
const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = ON_WINDOWS ? false : 'cmd.exe runs .bat files on Windows only: the test-windows job runs this';

/** The lines cmd runs: REM lines dropped, each line kept with its number so an order can be read. */
const commands = (text) => text.split('\r\n').map((line, n) => ({ line, n })).filter(({ line }) => !/^\s*REM\b/i.test(line));
const firstLine = (lines, re) => { const hit = lines.find(({ line }) => re.test(line)); return hit ? hit.n : -1; };

function readsAsCmdReadsIt(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('latin1');
  assert.ok(!/(^|[^\r])\n/.test(text), path.basename(file) + ': CRLF line endings throughout (cmd misreads a label on an LF-only line)');
  assert.ok(text.endsWith('\r\n'), path.basename(file) + ': ends with a line ending');
  assert.ok(bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)), path.basename(file) + ': ASCII only (cmd reads it in the console\'s code page)');
  return text;
}

test('start-agmessage.bat: the install record, then the preflight, before anything is started; code 0 and code 3 say different things', () => {
  const text = readsAsCmdReadsIt(START);
  const lines = commands(text);
  assert.ok(!/enabledelayedexpansion/i.test(text), 'no delayed expansion: it drops a "!" from the folder\'s own name');

  // The install record, read by reg.exe's absolute path, before the preflight's words.
  const reg = firstLine(lines, /"%SystemRoot%\\System32\\reg\.exe" query HKLM\\SOFTWARE\\AGMessage \/v Version \/reg:64 /);
  assert.ok(reg >= 0, 'the install record is read through %SystemRoot%\\System32\\reg.exe, in the 64-bit view whatever cmd runs it');
  for (const { line } of lines) assert.ok(!/(^|[^\\\w])reg(\.exe)?(\s|"|$)/i.test(line), 'no bare reg: ' + line);
  assert.ok(firstLine(lines, /is installed on this PC and starts with Windows/) > reg, 'the installed line is said from what the record holds');
  const preflight = lines.filter(({ line }) => /^\s*if (not defined MISSING )?if not exist|^\s*if not exist/i.test(line));
  assert.deepEqual(preflight.map(({ line }) => (line.match(/%~dp0([^"]+)"/) || [])[1]), ['node\\node.exe', 'app\\supervise.js', 'app\\server.js', 'app\\node_modules\\']);
  const run = firstLine(lines, /^:run\s*$/);
  for (const { n } of preflight) assert.ok(reg < n && n < run, 'the preflight comes after the record and before :run');
  assert.ok(firstLine(lines, /is missing %MISSING%/) > reg, 'the record is read before any of the preflight\'s words');

  // Nothing is opened by the .bat: the server opens the browser once it serves (AGM_OPEN), on the first run only.
  for (const { line } of lines) {
    assert.ok(!/(^|[&(|]\s*)start\b/i.test(line), 'no start command: ' + line);
    assert.ok(!/\bstart\b.*http/i.test(line), 'no timed opener: ' + line);
  }
  const open = firstLine(lines, /^set AGM_OPEN=1\s*$/);
  const cleared = firstLine(lines, /^set AGM_OPEN=\s*$/);
  assert.ok(open >= 0 && open < run && run < cleared && cleared < firstLine(lines, /^goto run\s*$/), 'AGM_OPEN asked before :run, and cleared after the first run');

  // The codes the .bat reads are AGMessage's alone, and each says its own words.
  const label = (code) => { const key = `if "%CODE%"=="${code}" goto `; const at = text.indexOf(key); return at < 0 ? '' : text.slice(at + key.length).split('\r\n')[0].trim(); };
  const block = (name) => { const at = text.indexOf('\r\n:' + name + '\r\n'); return at < 0 ? '' : text.slice(at, text.indexOf('exit /b', at) + 10); };
  assert.ok(label(0) && label(3) && label(0) !== label(3), 'code 0 and code 3 go to different labels');
  assert.match(block(label(0)), /Server stopped\. Press any key to close this window\.[\s\S]*exit \/b 0/);
  assert.match(block(label(3)), /AGMessage did not start - the reason is above\. Press any key to close this window\.[\s\S]*exit \/b 3/);
  assert.ok(!/Server stopped/.test(block(label(3))), 'code 3 is not "Server stopped"');
  assert.match(block('missing'), /exit \/b 2/, 'a copy missing its files ends with a code of its own');
  assert.match(block('missing'), /\r\nif defined INSTALLED echo {3}To use the installed AGMessage: Start -\^> AGMessage -\^> Open AGMessage\.\r\n[\s\S]*exit \/b 2/,
    'on a PC where AGMessage is installed, the preflight\'s words end by pointing to it, before the window ends');

  // Every program it runs is named by its absolute path: cmd looks for a bare name in this folder first.
  for (const { line } of lines) assert.ok(!/(^|[^\\\w])timeout(\.exe)?\s/i.test(line), 'no bare timeout: ' + line);
  assert.match(text, /"%SystemRoot%\\System32\\timeout\.exe" \/t 2/);
});

test('make-shareable-copy.bat: a new folder each time, never one that exists, checked before "Done"', () => {
  const text = readsAsCmdReadsIt(CLEAN);
  const lines = commands(text);
  assert.ok(!/clean"|clean\r\n/.test(text), 'never the one fixed folder of 0.5.1');
  assert.match(text, /set "NAME=AGMessage-Portable-Windows-clean-%STAMP%"/, 'named with the time');
  const named = firstLine(lines, /^if not exist "%DEST%" goto named\s*$/);
  const copy = firstLine(lines, /^"%SystemRoot%\\System32\\robocopy\.exe" /);
  const check = firstLine(lines, /^for %%d in \(data uploads\) do for \/f "delims=" %%f in \('dir \/s \/b \/a-d "%DEST%\\app\\%%d"/);
  const done = firstLine(lines, /echo\s+Done\./);
  assert.ok(named >= 0 && named < copy && copy < check && check < done, 'an existing folder is passed over before the copy; the copy is checked before "Done"');
  assert.ok(!/\/(MIR|PURGE)\b/i.test(text), 'nothing is deleted from a folder it did not make');
  assert.match(text, /:dirty\r\nrmdir \/s \/q "%DEST%"\r\n/, 'a copy that holds data is deleted');
  for (const { line } of lines) assert.ok(!/(^|[^\\\w])(robocopy|powershell)(\.exe)?\s/i.test(line), 'every program by its absolute path: ' + line);
});

// ---------------------------------------------------------------- run by cmd (Windows)
/** Runs a .bat by cmd, as a double-click does but with no keyboard (stdin is NUL, so each pause returns at once). */
function runBat(dir, name, env = {}) {
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return new Promise((resolve) => {
    const c = spawn(cmd, ['/d', '/c', name], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => c.kill(), 60000);
    c.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}
const throwaway = (under, prefix) => { fs.mkdirSync(under, { recursive: true }); return fs.mkdtempSync(path.join(under, prefix)); };

test('start-agmessage.bat on Windows: a copy missing node\\node.exe says so, and exits 2 opening nothing', { skip: WINDOWS_ONLY }, async (t) => {
  // Not under %TEMP%: the repository's ignored artifacts folder.
  const dir = throwaway(path.join(REPO, 'artifacts'), 'startbat-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(START, path.join(dir, 'start-agmessage.bat'));
  const r = await runBat(dir, 'start-agmessage.bat');
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('This copy is missing node\\node.exe.'), r.out);
  assert.ok(!/started from inside the zip|is installed on this PC|Server stopped|did not start/.test(r.out), 'the runner has no install record, and nothing ran:\n' + r.out);
  assert.ok(r.out.toLowerCase().includes(('from ' + dir).toLowerCase()), 'the banner names the folder it starts from:\n' + r.out);
});

test('start-agmessage.bat on Windows: started from a folder under %TEMP% (inside the zip), it says Extract All', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = throwaway(os.tmpdir(), 'agm-zip-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(START, path.join(dir, 'start-agmessage.bat'));
  const r = await runBat(dir, 'start-agmessage.bat');
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('AGMessage was started from inside the zip.'), r.out);
  assert.ok(r.out.includes('choose Extract All'), r.out);
  assert.ok(!/This copy is missing/.test(r.out), r.out);
});

test('start-agmessage.bat on Windows: the watchdog asked to open the browser on its first run only; 0 and 3 end the window in their own words', { skip: WINDOWS_ONLY }, async (t) => {
  const dir = throwaway(path.join(REPO, 'artifacts'), 'startbat-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(START, path.join(dir, 'start-agmessage.bat'));
  fs.mkdirSync(path.join(dir, 'node'));
  fs.copyFileSync(process.execPath, path.join(dir, 'node', 'node.exe'));
  fs.mkdirSync(path.join(dir, 'app', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'server.js'), '');
  // A watchdog that writes what it was given, then ends with the code AGM_FAKE_CODES lists for its run (then 0).
  fs.writeFileSync(path.join(dir, 'app', 'supervise.js'), `'use strict';
const fs = require('fs');
const path = require('path');
const runs = path.join(__dirname, 'runs.jsonl');
const n = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(runs, JSON.stringify({ open: process.env.AGM_OPEN || null, port: process.env.PORT || null }) + '\\n');
process.exit(Number(String(process.env.AGM_FAKE_CODES || '').split(',')[n] || 0));
`);
  const runs = () => { const f = path.join(dir, 'app', 'runs.jsonl'); const r = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; fs.rmSync(f, { force: true }); return r; };

  const stopped = await runBat(dir, 'start-agmessage.bat', { AGM_FAKE_CODES: '0', PORT: '45123' });
  assert.equal(stopped.code, 0, stopped.out);
  assert.deepEqual(runs(), [{ open: '1', port: '45123' }], 'the watchdog is asked to open the browser (AGM_OPEN=1), on the port given');
  assert.ok(stopped.out.includes('Server stopped. Press any key to close this window.'), stopped.out);
  assert.ok(!/did not start|is installed on this PC|is missing/.test(stopped.out), stopped.out);

  const notStarted = await runBat(dir, 'start-agmessage.bat', { AGM_FAKE_CODES: '3', PORT: undefined });
  assert.equal(notStarted.code, 3, notStarted.out);
  assert.deepEqual(runs(), [{ open: '1', port: '3023' }], 'code 3 is not run again; PORT defaults to 3023');
  assert.ok(notStarted.out.includes('AGMessage did not start - the reason is above. Press any key to close this window.'), notStarted.out);
  assert.ok(!/Server stopped/.test(notStarted.out), notStarted.out);

  const restarted = await runBat(dir, 'start-agmessage.bat', { AGM_FAKE_CODES: '70,0', PORT: '45123' });
  assert.equal(restarted.code, 0, restarted.out);
  assert.deepEqual(runs(), [{ open: '1', port: '45123' }, { open: null, port: '45123' }], 'a run after the .bat\'s own restart opens nothing');
  assert.ok(restarted.out.includes('stopped unexpectedly (code 70)'), restarted.out);
});

test('make-shareable-copy.bat on Windows: each copy a new folder holding no data, an earlier copy untouched', { skip: WINDOWS_ONLY }, async (t) => {
  const root = throwaway(os.tmpdir(), 'agm-share-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'AGMessage');
  const put = (rel, text) => { const f = path.join(bundle, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  fs.mkdirSync(bundle);
  fs.copyFileSync(CLEAN, path.join(bundle, 'make-shareable-copy.bat'));
  put('app/server.js', '// the program');
  put('node/node.exe', 'a stand-in');
  put('app/data/rooms/ABCDEF.json', '{"messages":[]}');
  put('app/data/secret.key', 'f'.repeat(64));
  put('app/uploads/minutes.pdf', '%PDF-1.7');
  put('app/uploads/.gitkeep', '');
  const copies = () => fs.readdirSync(root).filter((f) => f.startsWith('AGMessage-Portable-Windows-clean')).sort();
  const has = (copy, rel) => fs.existsSync(path.join(root, copy, rel));

  const first = await runBat(bundle, 'make-shareable-copy.bat');
  assert.equal(first.code, 0, first.out);
  assert.equal(copies().length, 1, first.out);
  const [one] = copies();
  assert.match(one, /^AGMessage-Portable-Windows-clean-\d{8}-\d{4}$/, 'named with the time');
  assert.ok(has(one, 'app/server.js') && has(one, 'node/node.exe') && has(one, 'app/uploads/.gitkeep') && has(one, 'app/data/rooms'), 'the program is copied');
  for (const rel of ['app/data/rooms/ABCDEF.json', 'app/data/secret.key', 'app/uploads/minutes.pdf']) assert.ok(!has(one, rel), rel + ' is not copied');
  assert.ok(first.out.includes('Done.'), first.out);

  fs.writeFileSync(path.join(root, one, 'app', 'data', 'planted.json'), '{"accounts":[]}');   // the first copy, started once to test it
  const second = await runBat(bundle, 'make-shareable-copy.bat');
  assert.equal(second.code, 0, second.out);
  const two = copies().find((f) => f !== one);
  assert.equal(copies().length, 2, 'a new folder, never the earlier one:\n' + second.out);
  assert.ok(/^AGMessage-Portable-Windows-clean-\d{8}-\d{4}$/.test(two) || /^AGMessage-Portable-Windows-clean-\d{8}-\d{4}-\d{1,2}$/.test(two), two);
  assert.ok(!has(two, 'app/data/planted.json'), 'the new copy holds nothing of the earlier one');
  assert.equal(fs.readFileSync(path.join(root, one, 'app', 'data', 'planted.json'), 'utf8'), '{"accounts":[]}', 'and the earlier copy is untouched');
  assert.ok(fs.existsSync(path.join(bundle, 'app', 'data', 'secret.key')), 'the bundle\'s own data stays where it is');
});
