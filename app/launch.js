'use strict';
/**
 * The installed node's commands for the person at the PC: each item of the Start menu's AGMessage folder runs
 * `node.exe app\launch.js <verb>` in a console of its own, as the person who chose it, and never asks for an elevation.
 * It requires Node's own modules only, runs nothing but by its absolute path, and reads no machine path from its
 * environment: the installer passes each folder it needs as an argument.
 *
 *   token --machine <folder> [--sys <folder>]
 *                              Show the admin token: the installed node's token, read from <folder>\token\admin-token
 *                              (<folder> is the node's machine folder, %ProgramData%\AGMessage), which its watchdog
 *                              writes each time its server serves. Only this PC's AGMessage admin, and the accounts it
 *                              gave `token`, may read it; anyone else is told whom to ask, by the name the install record
 *                              keeps (HKLM\SOFTWARE\AGMessage, AdminName), read with reg.exe from the System32 folder
 *                              `--sys` names (the installer's {sys}); without it, the words name no one.
 *
 * A verb it does not know is refused, never defaulted. Exit codes: 0 done; 2 not done, with the words of why; 64 a verb or
 * an argument it does not know, or one missing. In a console window it waits for Enter before it ends, so the window that
 * the Start menu opened stays until the person has read it.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DONE = 0;
const NOT_DONE = 2;
const USAGE = 64;
/** The token the installed node's watchdog writes: 16 hex characters, its 64 random bits. */
const TOKEN_SHAPE = /^[0-9a-f]{16}$/;
/** A Windows folder named from its drive: the System32 folder is never taken relative to wherever this runs. */
const DRIVE_PATH = /^[A-Za-z]:\\/;

/** A name as words: control characters taken out, cut short. */
const said = (v, max = 120) => String(v).replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, max);

/**
 * This PC's AGMessage admin as the install record names it ('DOMAIN\name'), or '' when it cannot be read: not Windows, no
 * System32 folder named from its drive (`sys`, the installer's {sys}), no record, or reg.exe not answering within 5 s.
 * reg.exe runs by its absolute path in that folder, from that folder, in the record's 64-bit view.
 */
function adminName({ sys = '', platform = process.platform, run = childProcess.execFileSync } = {}) {
  if (platform !== 'win32' || !DRIVE_PATH.test(sys)) return '';
  try {
    const out = run(path.win32.join(sys, 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage', '/v', 'AdminName', '/reg:64'],
      { cwd: sys, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /^\s*AdminName\s+REG_SZ\s+(.+)$/m.exec(String(out));
    return m ? said(m[1]) : '';
  } catch {
    return '';   // no record, or reg.exe refused: the words name no one
  }
}

/**
 * Show the admin token: {code, text}. The token file under `machine` is read once (`read`, fs.readFileSync unless a test
 * stands in for it); what it holds is printed only when it is a token the watchdog wrote. A read this account may not make
 * names whom to ask (`admin`, called only then, with `sys`); a file not there says AGMessage has not served yet; anything
 * else says what it met, never the file's bytes. The watchdog replaces the file whole each time its server serves, and
 * leaves it when it stops, so the token printed is the one the node last served with: the words say so.
 */
function showToken({ machine, sys = '', read = fs.readFileSync, admin = adminName }) {
  const file = path.join(machine, 'token', 'admin-token');
  let text;
  try { text = String(read(file, 'utf8')).trim(); } catch (e) {
    const code = (e && e.code) || 'EIO';
    if (code === 'EACCES' || code === 'EPERM') {
      const who = admin({ sys });
      return { code: NOT_DONE, text: 'This PC\'s AGMessage admin has not given you the token: ask ' + (who || 'them, or an administrator of this PC') + '.' };
    }
    if (code === 'ENOENT') return { code: NOT_DONE, text: 'AGMessage has no admin token on this PC yet: its server writes one each time it starts serving. Start AGMessage, then show the token again.' };
    return { code: NOT_DONE, text: 'The admin token could not be read (' + code + '): try again in a moment.' };
  }
  if (!TOKEN_SHAPE.test(text)) return { code: NOT_DONE, text: 'The token file (' + file + ') holds no token AGMessage wrote. Start AGMessage again: its server writes a new one.' };
  return { code: DONE, text: 'AGMessage\'s admin token on this PC:\n\n    ' + text + '\n\nType it at Admin login on this PC. It holds while AGMessage serves; each start makes a new one. If it is not taken, AGMessage has started again or is not serving: show the token again once it serves.' };
}

/** The command line, read: {verb, machine, sys} or {problem}. Only the words below are known, each once. */
function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb !== 'token') return { problem: 'launch.js knows one command: token --machine <folder> [--sys <folder>].' + (verb ? ' "' + said(verb, 40) + '" is not one of them.' : '') };
  const got = { '--machine': null, '--sys': null };
  for (let i = 0; i < rest.length; i++) {
    if (Object.hasOwn(got, rest[i]) && got[rest[i]] === null && i + 1 < rest.length) { got[rest[i]] = rest[i + 1]; i++; }
    else return { problem: 'launch.js token takes --machine <folder> and --sys <folder>, each once and each with its folder; "' + said(rest[i], 40) + '" does not fit.' };
  }
  const machine = got['--machine'] || '';
  const sys = got['--sys'];
  if (!machine || !path.isAbsolute(machine)) return { problem: 'launch.js token needs --machine <folder>, the installed node\'s folder as a full path (%ProgramData%\\AGMessage).' };
  if (sys !== null && !DRIVE_PATH.test(sys)) return { problem: 'launch.js token\'s --sys is the System32 folder named from its drive (C:\\Windows\\System32); "' + said(sys, 80) + '" is not one.' };
  return { verb, machine, sys: sys || '' };
}

/** Runs one command and says its words: the exit code. */
function main(argv, { out = (t) => process.stdout.write(t + '\n'), ...stand } = {}) {
  const a = parse(argv);
  if (a.problem) { out(a.problem); return USAGE; }
  const r = showToken({ machine: a.machine, sys: a.sys, ...stand });
  out(r.text);
  return r.code;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
  if (process.stdin.isTTY) {
    process.stdout.write('\nPress Enter to close this window.\n');
    process.stdin.once('data', () => process.stdin.pause());
  }
}

module.exports = { main, parse, showToken, adminName, DONE, NOT_DONE, USAGE };
