#!/usr/bin/env node
'use strict';
/**
 * The Windows evidence lane's measuring run (the 0.6.0 plan's Part 6, unit U7), on the CI's windows-2025 runner, elevated:
 * the readings that need Defender after tools/defender-on.ps1 has turned its real-time monitoring back on, the rest after
 * tools/defender-off.ps1 has put it back as the image left it. It writes what it measured; the verdicts are
 * tools/readings.js's.
 *
 *   node tools/readings-take.js take --zip <bundle.zip> --out <raw.json> [--defender <defender.json>]
 *                                    [--previous <the newest release's zip>] [--work C:\agm-readings] [--port 3124]
 *                                    [--repo <owner/name> --tag <vX.Y.Z>] [--installer <AGMessage-Setup-…-unsigned.exe>]
 *                                    [--deadline-min <n>] [--only <R11,R6>] [--skip <R11,R6>] [--add]
 *     --defender names tools/defender-on.ps1's record: a take given it keeps that record and reads Defender again at its
 *     end. Only a take that adds to an earlier record (--add) may be given none (the lane's takes after
 *     tools/defender-off.ps1): it keeps the record's `defender` and `defenderEnd` as the take before wrote them and asks
 *     Windows nothing of Defender. Each take is written in `takes` with whether it was given that record (`defender`), and
 *     each reading begun in `times` with the take that took it (`take`, its index in `takes`), so the judge holds a
 *     reading that needs Defender to it only when its take was given that record.
 *       R2   the bundle's payload laid over the one before it (the newest release's, when its zip is given; this build's
 *            own when not, said so), round by round: each file inflated to a name of its own beside it, then renamed
 *            over the earlier one
 *       R10  node.exe extracted from the bundle into %TEMP% and run once, round by round, with its exit code
 *       R1   the gap an upgrade makes, at an empty hall and at 20 halls × 10,000 messages: the bundle's watchdog
 *            serving, a page seated, the stop at loopback with the proof of a token made for the reading, the next start
 *            at once, and the page back at the hall page's own pace, round by round
 *       R5   Windows' verdict on node.exe's and cloudflared.exe's signatures (Get-AuthenticodeSignature), and on the
 *            installer's when --installer names the one the installer job built (unsigned: recorded)
 *       R8   the access lists of C:\ and %ProgramData% (icacls /save: SIDs, never localised names), and U12's server
 *            task's and U17's control task's definitions as app/machine.js writes them, each registered under the lane's
 *            folder and never run: its descriptor (who may read it) and its XML (no secret), read back through Task
 *            Scheduler's own object
 *       R4   a stand-in for U12's server task at \AGMessage\Server: LocalService, its own SID (Unrestricted), only
 *            SeChangeNotifyPrivilege, the task's settings; its action is this file's probe-server, which reads the token
 *            and the profile, hears UDP 9928, starts the bundle's watchdog under the installed channel (AGM_RUNS=task, the
 *            folders) and a quick tunnel as the server starts one; a firewall rule by program, protocol and port
 *       R7   while that server serves: its folder pipe's access list, as libuv made it under the task's token, and
 *            whether a client reaches it through SMB at this machine's own names
 *       R12  two stand-in tasks with the server task's settings (RestartOnFailure 3 × 1 min), each with a folder of its
 *            own: one whose action exits 1, measured and removed, then one whose action exits 0
 *       R11  U17's control task as app/machine.js registers it for one standard account made for the reading, its action
 *            the bundle's machine.js control: that account runs it (schtasks /run, from a task that runs as it), 10
 *            rounds, each answered as SYSTEM for its SID (the runner has no install record, so each request is refused
 *            for its rights, and nothing is started or stopped); a second standard account tries it 10 rounds and is
 *            refused. Both accounts, their tasks and their profiles are removed at the end
 *       R6   U14's export as a standard account made for the reading (a task with its logon, as Inno's ExecAsOriginalUser
 *            runs it) of a stand-in portable folder into its own import folder, which the bundle's machine.js import
 *            --step stage made with its grants; the bundle's machine.js import --step take reading and verifying it
 *            elevated; and an elevated read of that account's %LOCALAPPDATA%\AGMessage. The plan's two readings under
 *            over-the-shoulder elevation need a desktop no runner has: they are the show laptop's, and the record says so
 *       R13  a task with a control task's principal and settings (SYSTEM) reading GitHub's release answer for the newest
 *            published tag; then, with no network, a copy of the bundle's node.exe that an outbound rule of the
 *            firewall blocks, run by the same kind of task, asking the bundle's own machine.js for that release as a
 *            checked upgrade asks, and the words it gives (U18's offline words); the rule and the task removed
 *     Each reading is taken on its own: one that fails is written with why, and the rest are taken. The take bounds
 *     itself, so its step never needs the runner to cancel it: each reading has a bound of its own (BOUNDS), and begins
 *     only while that bound fits in what is left of the lane's deadline (--deadline-min, DEADLINE_MIN when none is named),
 *     else it is written "not taken: the lane's deadline"; at its bound every wait of it ends and no program of it starts
 *     (`within`), and one not ended a minute later is written cut, its rounds so far kept. The record is written before
 *     the first reading, as each begins (`running`), after each round a long reading reports, and as each ends; what the
 *     lane made that outlives a reading (`held`: tasks, firewall rules, standard accounts, watchdogs) is removed at its
 *     end, and at a Ctrl+C, Ctrl+Break or SIGTERM the record is written at once and its tasks and rules removed before it
 *     exits 2; it exits once its record is written, whatever handle is still open. --only and --skip name the readings
 *     a take takes or leaves to another (a skipped one written as left to it, unless the record it adds to holds it
 *     already: what an earlier take wrote of it is kept), and --add adds to the record an earlier take of the same job
 *     wrote at --out: CI takes the readings that need Defender (R2, R9, R10) first, with it on, then the rest with it put
 *     back as the image left it, then the readings as standard accounts (R11, R6) in a step of their own, after the rest
 *     are kept as an artifact.
 *     It is CI's alone: it refuses a machine that is not a GitHub-hosted runner, a work folder it did not make, and a
 *     \AGMessage\Server task it did not make, before anything is made or removed. Exit 0 once the record is written, 2
 *     when it cannot be, 64 for a word it does not know, a run off Windows or a machine it refuses.
 *   node readings-take.js probe-server <dir> | probe-exit <dir> | probe-release <dir> | probe-offline <dir> | probe-run <dir> | probe-export <dir>
 *       what a stand-in task runs, from the copy the lane makes of this file: what a probe runs requires Node's own
 *       modules only (R1's step alone, run from the checkout, asks its server through app/lib/machinewire.js)
 *
 * Invariants: every program is run by its absolute path, never a bare name, with an argument array and no shell; no
 * secret is written to the record (the admin token the stand-in server makes is taken out of any output kept, by value
 * and by its shape; a quick tunnel's address is not kept); every stand-in task and the firewall rule are removed at the
 * end, whatever failed; nothing is made or removed on a machine the lane refuses; no reading's wait outlasts its bound.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const zlib = require('node:zlib');

const R2_ROUNDS = 3;
const R10_ROUNDS = 5;
/** The order the readings are taken in: those taken before any standard account is made first, then R11 and R6, which log on as accounts the lane makes. */
const ORDER = Object.freeze(['R2', 'R10', 'R5', 'R1', 'R8', 'R4', 'R7', 'R12', 'R9', 'R3′', 'R13', 'R11', 'R6']);
/**
 * Each reading's own bound, in minutes: no wait of it outlasts the bound and no program of it starts past it, and it
 * begins only while the bound fits in what is left of the lane's deadline. Each is set above what the reading takes on a
 * healthy windows-2025 runner (the readings but R11 and R6 took under 30 minutes together in run 101; R12's waits are a
 * fixed 150 s and 90 s), and R11's and R6's, never yet taken whole, above the sum of their rounds' usual waits, so a slow
 * runner is cut by a reading's bound, with what it took kept, never by the step's limit. R2, R10 and R9, which need
 * Defender, are taken one after another in a take of their own while it is on, with a deadline of 6 minutes (R2 142 s,
 * R10 15 s and R9 3 s in run 109, the payload laid in about 20 s between R2 and the other two). Each begins only while
 * its bound fits in what is left of that deadline: at run 109's times all three begin with about a minute to spare, and
 * an R2 past about 3.4 minutes leaves R9 not taken this run, one past about 3.7 minutes R10 too. The take ends itself
 * within its step's limit whatever they met, so Defender is put back as the image left it after that take; at run 109's
 * times about 3.5 minutes after it came on (not measured with this order), and past ten minutes when R2 or the take is
 * slow.
 */
const BOUNDS = Object.freeze({ R2: 5, R10: 2, R5: 2, R1: 10, R8: 4, R4: 6, R7: 1, R12: 6, R9: 2, 'R3′': 8, R13: 5, R11: 12, R6: 10 });
/** The lane's deadline, in minutes from the take's start, when the command names none (--deadline-min). */
const DEADLINE_MIN = 38;
/**
 * What a take needs after its deadline to end by itself, in minutes: a cut reading's minute to settle, the cleanup's two,
 * Defender read again (by a take given its record) and the record written. A take step's limit is its deadline and this at
 * least (test/readings.test.js).
 */
const STOP_MIN = 6;
/** How long a reading at its bound has to end (its own finally blocks: its tasks removed) before it is written cut and the lane goes on. */
const SETTLE_MS = 60_000;
const SERVER_TASK = '\\AGMessage\\Server';
/** The stand-in server task's description: how the lane tells a task it made from the installed node's. */
const STAND_IN = 'AGMessage readings: a stand-in for the server task';
/** R8's task: U12's server task's definition, registered under the lane's own folder only to be read back. */
const DEFINITION_TASK = '\\AGMessage-Readings\\Definition';
const CONTROL_DEFINITION_TASK = '\\AGMessage-Readings\\ControlDefinition';
const RESTART_TASKS = { nonZero: '\\AGMessage-Readings\\RestartNonZero', zero: '\\AGMessage-Readings\\RestartZero' };
const RELEASE_TASK = '\\AGMessage-Readings\\Release';
/** R13's offline half: its task, and the outbound rule that takes the network from its own copy of node.exe. */
const OFFLINE_TASK = '\\AGMessage-Readings\\Offline';
const OFFLINE_RULE = 'AGMessage-readings-R13-offline';
/** R11's tasks: the control task (machine.js's own definition, under the lane's folder) and one task as each account. */
const R11_TASKS = { as: '\\AGMessage-Readings\\R11-As-' };
/** R11's two standard accounts, made for the reading and removed after it: one the control task is for, one it is not. */
const R11_USERS = Object.freeze({ own: 'agmr11own', other: 'agmr11other' });
const R11_ROUNDS = 10;
/** R6's standard account, made for the reading and removed after it: the one whose export the elevated import reads. */
const R6_USER = 'agmr6export';
const R6_TASK = '\\AGMessage-Readings\\R6-Export';
/** The file the lane writes in its work folder first: a folder without it is not the lane's to remove. */
const WORK_MARK = '.agm-readings-work';
const RULE = 'AGMessage-readings-R4';
const LOCAL_SERVICE = 'S-1-5-19';
const SYSTEM = 'S-1-5-18';
/** The quick tunnel's address in cloudflared's output (server.js reads it the same way). */
const TRYCF = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DRIVE_PATH = /^[A-Za-z]:\\/;

const now = () => performance.now();
/**
 * The bound of the reading being taken ({end}, by `now()`), kept with that reading's own calls: a reading cut at its
 * bound keeps its spent bound in every call it still makes, and the next reading has its own. None outside a reading
 * (the probes, the installer's life cycle's hands), where nothing is shortened.
 */
const bounded = new AsyncLocalStorage();
/** What is left of the current reading's bound, in ms: Infinity outside a reading. */
const left = () => { const b = bounded.getStore(); return b ? b.end - now() : Infinity; };
/** `ms`, shortened to what is left of the current reading's bound: 0 once it is reached. */
const within = (ms) => Math.max(0, Math.floor(Math.min(ms, left())));
/** A wait of `ms` that ends at the current reading's bound. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, within(ms)); });
/** A wait of `ms` no reading's bound shortens: the lane's own, while it ends and removes what it made. */
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** A time for the record's words: minutes from one, seconds below it. */
const span = (ms) => (ms >= 60_000 ? Math.round(ms / 6000) / 10 + ' min' : Math.round(ms / 100) / 10 + ' s');

/**
 * What the lane made that outlives a reading unless it is removed: the tasks it registered (Task Scheduler runs them
 * outside the step's process tree, where the runner's own cancel never reaches), its firewall rules, the standard accounts
 * (each named here before PowerShell is asked to make it, so one made before a failure is still removed), and the
 * watchdogs a reading started. Each is put here before it is made and taken out once it is removed or has ended;
 * `release` removes what is left.
 */
const held = { tasks: new Set(), rules: new Set(), accounts: new Set(), pids: new Set() };

// ---------------------------------------------------------------- the bundle, read as a zip (APPNOTE 4.3)

const SIG = { eocd: 0x06054b50, z64loc: 0x07064b50, z64eocd: 0x06064b50, cd: 0x02014b50, local: 0x04034b50 };

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  if (got !== len) throw new Error('the zip ends before its records do');
  return b;
}

/** A zip's members from its central directory, Zip64 included: {name ('/' between folders), dir, method, crc, compressed, size, offset}. */
function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xFFFF);
    const tail = readAt(fd, size - tailLen, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG.eocd) { at = i; break; }
    if (at < 0) throw new Error(path.basename(file) + ' is not a zip (no end of its central directory)');
    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      if (at < 20 || tail.readUInt32LE(at - 20) !== SIG.z64loc) throw new Error('a Zip64 zip without its locator');
      const rec = readAt(fd, Number(tail.readBigUInt64LE(at - 20 + 8)), 56);
      if (rec.readUInt32LE(0) !== SIG.z64eocd) throw new Error('a Zip64 zip without its end record');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.cd) throw new Error('the central directory is broken at member ' + i);
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const e = {
        name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressed: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      };
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          for (const k of ['size', 'compressed', 'offset']) {
            if (e[k] === 0xFFFFFFFF && q + 8 <= x + 4 + len) { e[k] = Number(extra.readBigUInt64LE(q)); q += 8; }
          }
        }
        x += 4 + len;
      }
      e.dir = e.name.endsWith('/');
      entries.push(e);
      p += 46 + nameLen + extraLen + cd.readUInt16LE(p + 32);
    }
    return entries;
  } finally { fs.closeSync(fd); }
}

/** A member's path below the folder it is laid in, refused when it would leave it (absolute, a drive, `..`). */
function memberParts(name) {
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || /^[A-Za-z]:/.test(parts[0]) || name.startsWith('/') || parts.some((s) => s === '..' || s === '.')) {
    throw new Error('a member named outside its folder: ' + JSON.stringify(name));
  }
  return parts;
}

/** A member's bytes, inflated and checked against its size and CRC-32. */
function memberBytes(fd, e) {
  const head = readAt(fd, e.offset, 30);
  if (head.readUInt32LE(0) !== SIG.local) throw new Error(e.name + ': no local header where the directory says');
  const data = readAt(fd, e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), e.compressed);
  let out;
  if (e.method === 0) out = data;
  else if (e.method === 8) out = zlib.inflateRawSync(data);
  else throw new Error(e.name + ': compression method ' + e.method + ' is not one a bundle uses');
  if (out.length !== e.size || zlib.crc32(out) !== e.crc) throw new Error(e.name + ': its bytes do not check (size or CRC-32)');
  return out;
}

/** One file written whole: to a name of its own beside it, then renamed over whatever was there. */
function layFile(target, data) {
  const tmp = target + '.agm-lay';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

/** The one folder every member of a bundle lies in (AGMessage from 0.6.0; 0.5's was named as its zip is), or a refusal. */
function topFolder(entries) {
  const tops = new Set(entries.map((e) => memberParts(e.name)[0]));
  if (tops.size !== 1 || entries.some((e) => !e.dir && memberParts(e.name).length < 2)) throw new Error('the bundle is not one folder (' + tops.size + ' at its top)');
  return [...tops][0];
}

/**
 * The release a bundle's zip is, read from the zip's own name: AGMessage-Portable-0.6.0.zip from 0.6.0,
 * AGMessage-Portable-Windows-0.5.1.zip before it (a browser's " (1)" after it read alike); '' for any other name (pure).
 */
function releaseOf(zipFile) {
  const name = String(zipFile).split(/[\\/]/).pop().replace(/ \(\d+\)\.zip$/i, '.zip');
  const m = /^AGMessage-Portable-(?:Windows-)?(\d+\.\d+\.\d+)\.zip$/i.exec(name);
  return m ? m[1] : '';
}

/**
 * Every member of `zipFile` laid into `dest`, over what is there: {files, bytes, ms}. `strip: 1` lays what is inside the
 * bundle's one folder, so two builds, whose folders are named apart, are laid over each other.
 */
function layOut(zipFile, dest, entries = zipEntries(zipFile), { strip = 0 } = {}) {
  if (strip) topFolder(entries);
  const fd = fs.openSync(zipFile, 'r');
  let files = 0;
  let bytes = 0;
  const t0 = now();
  try {
    for (const e of entries) {
      const parts = memberParts(e.name).slice(strip);
      if (!parts.length) continue;   // the bundle's folder itself
      const target = path.join(dest, ...parts);
      if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = memberBytes(fd, e);
      layFile(target, data);
      files++;
      bytes += data.length;
    }
  } finally { fs.closeSync(fd); }
  return { files, bytes, ms: now() - t0 };
}

/** The one member whose path ends with `suffix` (as `/node/node.exe`), extracted to `destFile`: {ms, bytes}. */
function extractOne(zipFile, suffix, destFile, entries = zipEntries(zipFile)) {
  const found = entries.filter((e) => !e.dir && ('/' + e.name).endsWith(suffix));
  if (found.length !== 1) throw new Error('expected one member ending ' + suffix + ', found ' + found.length);
  const fd = fs.openSync(zipFile, 'r');
  const t0 = now();
  try {
    const data = memberBytes(fd, found[0]);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    layFile(destFile, data);
    return { ms: now() - t0, bytes: data.length };
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- what the stand-in tasks are

const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** One command-line argument as Windows reads it (CommandLineToArgvW), for a task's <Arguments>. */
function winArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * A task's definition (Task Scheduler's schema 1.3), started on demand only: its principal (`sid`; with `sidType` and
 * `privileges` for a service account, as U12's server task: its own SID, only the privileges it names), the server task's
 * settings (no time limit, both battery settings false, a new instance ignored while one runs, RestartOnFailure 3 × 1 min
 * and a start that was missed made when it can, when `restart`: app/machine.js serverTaskXml's, held to it by
 * test/readings.test.js), and one action. Written as UTF-16 with its mark, as schtasks reads it.
 */
function taskXml({ description, sid, sidType = '', privileges = [], restart = false, instances = 'IgnoreNew', limit = 'PT0S', logon = '', command, args = [], cwd }) {
  const principal = [
    '      <UserId>' + xmlText(sid) + '</UserId>',
    ...(logon ? ['      <LogonType>' + xmlText(logon) + '</LogonType>'] : []),
    '      <RunLevel>' + (sid === SYSTEM ? 'HighestAvailable' : 'LeastPrivilege') + '</RunLevel>',
    ...(sidType ? ['      <ProcessTokenSidType>' + xmlText(sidType) + '</ProcessTokenSidType>'] : []),
    ...(privileges.length ? ['      <RequiredPrivileges>', ...privileges.map((p) => '        <Privilege>' + xmlText(p) + '</Privilege>'), '      </RequiredPrivileges>'] : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>' + xmlText(description) + '</Description>',
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    ...principal,
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>' + xmlText(instances) + '</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>' + xmlText(limit) + '</ExecutionTimeLimit>',
    ...(restart ? ['    <RestartOnFailure>', '      <Interval>PT1M</Interval>', '      <Count>3</Count>', '    </RestartOnFailure>', '    <StartWhenAvailable>true</StartWhenAvailable>'] : []),
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + xmlText(command) + '</Command>',
    '      <Arguments>' + xmlText(args.map(winArg).join(' ')) + '</Arguments>',
    '      <WorkingDirectory>' + xmlText(cwd) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}
const utf16 = (text) => Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);

/** U12's server task's principal (app/machine.js serverTaskXml's): LocalService under its own SID, SeChangeNotifyPrivilege only. */
const SERVER_PRINCIPAL = { sid: LOCAL_SERVICE, sidType: 'Unrestricted', privileges: ['SeChangeNotifyPrivilege'] };
/** U17's control task's principal and settings (app/machine.js controlTaskXml's): SYSTEM, a request queued, 10 minutes at most. */
const CONTROL_PRINCIPAL = { sid: SYSTEM, instances: 'Queue', limit: 'PT10M' };

// ---------------------------------------------------------------- what the probes read (testable anywhere)

/** Every file under `dir`, to `depth` folders and at most `max`: relative path -> "size:mtime". */
function snapshot(dir, { depth = 6, max = 20000 } = {}) {
  const seen = new Map();
  const walk = (rel, level) => {
    if (level > depth || seen.size >= max) return;
    let list;
    try { list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; /* a folder this account may not read: not in the snapshot */ }
    for (const d of list) {
      if (seen.size >= max) return;
      const r = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) walk(r, level + 1);
      else {
        try { const s = fs.statSync(path.join(dir, r)); seen.set(r, s.size + ':' + Math.round(s.mtimeMs)); } catch { seen.set(r, 'unread'); }
      }
    }
  };
  walk('', 0);
  return seen;
}
/** What changed between two snapshots: {added, changed} (each at most 50 names), {removed} as a count. */
function snapshotDiff(before, after) {
  const added = [];
  const changed = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  let removed = 0;
  for (const k of before.keys()) if (!after.has(k)) removed++;
  return { added: added.slice(0, 50), addedCount: added.length, changed: changed.slice(0, 50), changedCount: changed.length, removed };
}

/** Whether this process hears a hello it broadcasts on UDP `port`: {bound, sent, heard, error}. */
function udpHeard({ port = 9928, to = '255.255.255.255', ms = 3000 } = {}) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    const out = { port, to, bound: false, sent: false, heard: false, error: '' };
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let timer = null;
    const done = () => { clearTimeout(timer); try { s.close(); } catch { /* closed already */ } resolve(out); };
    s.on('error', (e) => { out.error = e.code || e.message; done(); });
    s.on('message', (m) => { if (m.toString('utf8').includes(id)) { out.heard = true; done(); } });
    s.bind(port, () => {
      out.bound = true;
      try { s.setBroadcast(true); } catch (e) { out.error = e.code || e.message; }
      s.send(Buffer.from(JSON.stringify({ t: 'readings', id })), port, to, (e) => { if (e) out.error = e.code || e.message; else out.sent = true; });
      timer = setTimeout(done, ms);
    });
  });
}

/** One GET of `url` within `ms` (the current reading's bound at most): {status, headers, body} (at most `max` bytes), or {error}. */
function get(url, { ms = 15000, max = 4 * 1024 * 1024, headers = {} } = {}) {
  return new Promise((resolve) => {
    const room = within(ms);
    if (room <= 0) { resolve({ error: 'not asked: the reading\'s own bound was reached' }); return; }
    ms = room;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) { resolve({ error: 'not an http or https address' }); return; }
    const req = lib.get(u, { headers, timeout: ms }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > max) { req.destroy(new Error('an answer larger than ' + max + ' bytes')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within ' + ms + ' ms')));
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

/** The build health's JSON names, or '' for an answer that is not it. */
function buildOf(body) {
  try { return String(JSON.parse(body).build || ''); } catch { return ''; /* not health's JSON: no build to name */ }
}

/** `/api/health` at loopback until it answers or `ms` passes (or the current reading's bound): {ok, ms, build}. */
async function waitHealth(port, { ms = 30000, every = 250 } = {}) {
  const t0 = now();
  while (now() - t0 < ms && left() > 0) {
    const r = await get('http://127.0.0.1:' + port + '/api/health', { ms: 2000 });
    if (r.status === 200) {
      return { ok: true, ms: Math.round(now() - t0), build: buildOf(r.body) };
    }
    await sleep(every);
  }
  return { ok: false, ms: Math.round(now() - t0), build: '' };
}

/** A quick tunnel started as the server starts one (`file`, `args`), until it names its address or `ms` passes; then ended. */
function quickTunnel(file, args, { ms = 45000 } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const out = { returned: false, ms: 0, error: '' };
    let child;
    try { child = childProcess.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { resolve({ ...out, error: e.code || e.message }); return; }
    let buf = '';
    let timer = null;
    let finished = false;
    const finish = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      out.ms = Math.round(now() - t0);
      if (why) out.error = why;
      // A child that never started (no such file) has no pid and sends no 'exit'.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { child.once('exit', () => resolve(out)); child.kill(); } else resolve(out);
    };
    const sniff = (c) => { buf = (buf + c.toString('utf8')).slice(-32768); if (TRYCF.test(buf)) { out.returned = true; finish(''); } };
    child.stdout.on('data', sniff);
    child.stderr.on('data', sniff);
    child.on('error', (e) => finish(e.code || e.message));
    child.on('exit', (code) => { if (!finished) finish('ended with ' + code + ' before it named an address'); });
    timer = setTimeout(() => finish('no address within ' + ms / 1000 + ' s'), ms);
  });
}

/** GitHub's release answer, read as U18 reads it: {status, ms, immutable, assets [{name, digest}], rateRemaining, failure}. */
async function readRelease(url, { ms = 20000 } = {}) {
  const t0 = now();
  const r = await get(url, { ms, headers: { 'User-Agent': 'AGMessage-readings', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  const out = { status: r.status || 0, ms: Math.round(now() - t0), immutable: null, assets: [], rateRemaining: null, failure: r.error || '' };
  const left = r.headers && r.headers['x-ratelimit-remaining'];
  if (left !== undefined && /^\d+$/.test(String(left))) out.rateRemaining = Number(left);
  if (r.status === 200) {
    try {
      const body = JSON.parse(r.body);
      out.immutable = typeof body.immutable === 'boolean' ? body.immutable : null;
      out.assets = (Array.isArray(body.assets) ? body.assets : []).slice(0, 64).map((a) => ({ name: String(a && a.name || ''), digest: String(a && a.digest || '') }));
    } catch (e) { out.failure = 'the answer is not JSON (' + e.message + ')'; }
  }
  return out;
}

/** The access list `icacls <path> /save` wrote (UTF-16): the first line that is SDDL, never a line that names the path. */
function sddlOfSave(bytes) {
  const text = Buffer.from(bytes).toString('utf16le').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(O:|G:|D:)/.test(l)) || '';
}

/** A client's connection to a pipe, made by a child Node of its own so a slow SMB answer never holds the lane. */
const PIPE_REACH = String.raw`const s = require('node:net').connect(process.argv[1]); const say = (o) => { process.stdout.write(JSON.stringify(o)); s.destroy(); process.exit(0); }; s.on('connect', () => say({ connected: true, error: '' })); s.on('error', (e) => say({ connected: false, error: String(e.code || e.message) }));`;
/** Whether a client reaches `pipePath` within `ms` (the current reading's bound at most): {connected, error}. */
function pipeReach(pipePath, { ms = 15000 } = {}) {
  const room = within(ms);
  if (room < Math.min(ms, 1000)) return { connected: false, error: 'not tried: the reading\'s own bound was reached' };
  ms = room;
  const r = childProcess.spawnSync(process.execPath, ['-e', PIPE_REACH, pipePath], { encoding: 'utf8', windowsHide: true, timeout: ms });
  if (r.error) return { connected: false, error: r.error.code === 'ETIMEDOUT' ? 'no answer within ' + ms / 1000 + ' s' : String(r.error.code || r.error.message) };
  try {
    const o = JSON.parse(String(r.stdout || ''));
    return { connected: o.connected === true, error: String(o.error || '').slice(0, 120) };
  } catch { return { connected: false, error: 'no answer (the client ended with ' + r.status + ')' }; /* the child said nothing readable */ }
}

/** The admin token's shape (16 hex characters, `server.js`): a run of hex that long is taken out wherever it is. */
const TOKEN_SHAPE = /[0-9a-f]{16,}/gi;
/** The admin token the stand-in server wrote in its token folder, or '' when there is none to read. */
function tokenIn(tokenDir) {
  try { return fs.readFileSync(path.join(tokenDir, 'admin-token'), 'utf8').trim(); } catch { return ''; /* none written, or not readable: the shape still takes it out */ }
}
/**
 * The last of a process's output, at most `max` characters, as whole lines from the front: a line cut by the bound is
 * dropped, so no part of a value is kept without the rest of it (pure).
 */
function keepTail(tail, chunk, max = 8192) {
  const all = tail + chunk;
  if (all.length <= max) return all;
  const at = all.indexOf('\n', all.length - max - 1);
  return at < 0 ? '' : all.slice(at + 1);
}
/** `text` with the token taken out by value, then anything of its shape: what the record may keep of a server's words. */
function withoutSecrets(text, token) {
  const t = String(text || '');
  return (token ? t.split(token).join('[token]') : t).replace(TOKEN_SHAPE, '[hex]');
}

/**
 * schtasks' warning that a task is registered but may not start, its principal holding no batch logon (pure): that line,
 * or ''. Task Scheduler answers SCHED_S_BATCH_LOGON_PROBLEM (0x4131C), a success: schtasks ends with 0 and warns.
 */
function batchWarning(text) {
  const m = /^.*(?:may fail to start|Batch logon privilege).*$/im.exec(String(text || ''));
  return m ? m[0].trim() : '';
}
/** Windows' reasons a task did not log on or start, by HRESULT, as startWhy names them. */
const START_REFUSED = Object.freeze({
  [0x80070569]: 'its account holds no "Log on as a batch job" (ERROR_LOGON_TYPE_NOT_GRANTED)',
  [0x80070564]: 'its account was not granted the logon type (ERROR_LOGON_NOT_GRANTED)',
  [0x8007052E]: 'its account\'s user name or password is incorrect',
  [0x8007052F]: 'an account restriction refused its logon',
  [0x80070532]: 'its account\'s password has expired',
  [0x80070533]: 'its account is disabled',
  [0x80070773]: 'its account must change its password',
  [0x80070520]: 'no logon session could be made for its account (no stored credentials)',
  [0x8004130F]: 'Windows keeps no password for it (SCHED_E_ACCOUNT_INFORMATION_NOT_SET)',
  [0x80070005]: 'access was denied',
  [0x80070002]: 'a file it names was not found',
  [0x8007010B]: 'its folder is not a valid one',
});
/** An event's result code as an unsigned HRESULT (pure): a Win32 code under 0x10000 as HRESULT_FROM_WIN32, else as given; null when none. */
function hresultOf(values) {
  const last = [...(Array.isArray(values) ? values : [])].reverse().map((v) => String(v).trim()).find((v) => /^-?\d{1,10}$|^0x[0-9a-f]{1,8}$/i.test(v));
  if (last === undefined) return null;
  const n = Number(last) >>> 0;
  return n > 0 && n < 0x10000 ? (0x80070000 | n) >>> 0 : n;
}
/**
 * Why a task started or not, from Task Scheduler's own events for it (taskEvents' answer, the newest first) (pure):
 * {started, code, words, ids}. Started when it made its process or began its action (129, 200); else the newest refusal
 * (101, a start that failed; 104, a logon that failed; 103 and 203, an action that did not start, which follow the
 * instance's own start, 100), its code named; else started when an instance began (100) and nothing refused it; else the
 * launch ignored while an instance ran (322), or not made for want of a logged-on user (332); else what the log says it
 * saw, or that it holds nothing (a log turned on too late, or never).
 */
function startWhy(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && Number.isSafeInteger(e.id));
  const ids = list.map((e) => e.id);
  if (ids.some((id) => id === 129 || id === 200)) return { started: true, code: null, words: 'Task Scheduler started it', ids };
  const refused = list.find((e) => [101, 104, 103, 203].includes(e.id));
  if (refused) {
    const code = hresultOf(refused.values);
    const hex = code === null ? 'no code' : '0x' + code.toString(16).toUpperCase().padStart(8, '0');
    const what = refused.id === 104 ? 'logged its account on' : refused.id === 101 ? 'started it' : 'started its action';
    return { started: false, code, words: 'Task Scheduler never ' + what + ' (event ' + refused.id + ', ' + hex + '): ' + (code !== null && Object.hasOwn(START_REFUSED, code) ? START_REFUSED[code] : 'Windows\' code ' + hex), ids };
  }
  if (ids.includes(100)) return { started: true, code: null, words: 'Task Scheduler started it', ids };
  if (ids.includes(322)) return { started: false, code: null, words: 'Task Scheduler ignored the run: an instance of it was already running (event 322)', ids };
  if (ids.includes(332)) return { started: false, code: null, words: 'Task Scheduler did not start it: its account was not logged on (event 332)', ids };
  if (!list.length) return { started: false, code: null, words: 'Task Scheduler\'s log holds no event for it', ids };
  return { started: false, code: null, words: 'Task Scheduler logged ' + [...new Set(ids)].join(', ') + ' for it, and never started it' + (ids.includes(110) ? ' (it was asked to run: event 110)' : ''), ids };
}

// ---------------------------------------------------------------- the probes, as a stand-in task runs them

function writeJson(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function system32() {
  const root = String(process.env.SystemRoot || '');
  if (!DRIVE_PATH.test(root)) throw new Error('SystemRoot does not name the Windows folder');
  return path.win32.join(root, 'System32');
}
/**
 * A program run by its absolute path, from its own folder, within `ms`: {code, out, err}. Inside a reading, `ms` is
 * shortened to what is left of its bound, and with under a second left nothing is started (code null, said); `always`
 * is the lane's own act of removing what it made, which keeps its own `ms` whatever the reading's bound.
 */
function run(file, args, { ms = 60000, env, cwd = path.dirname(file), input, always = false } = {}) {
  const room = always ? ms : within(ms);
  if (room < Math.min(ms, 1000)) return { code: null, out: '', err: 'not started: the reading\'s own bound was reached' };
  const r = childProcess.spawnSync(file, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: room, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') + (r.error ? String(r.error.code || r.error.message) : '') };
}

/** probe-exit: one start recorded, then the exit code its folder names (1 unless `code` says otherwise). */
function probeExit(dir) {
  fs.appendFileSync(path.join(dir, 'starts.log'), new Date().toISOString() + '\n');
  let named = '';
  try { named = fs.readFileSync(path.join(dir, 'code'), 'utf8').trim(); } catch { /* no code named: a failure, as a crash would be */ }
  return /^\d{1,3}$/.test(named) ? Number(named) : 1;
}

/**
 * probe-run: R11's, as a task running as one standard account runs it: schtasks.exe /Run of the control task its plan
 * names, by its absolute path, and its exit code and words written to ran.json (no secret: schtasks says only whether it ran).
 */
function probeRun(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  const r = run(path.win32.join(system32(), 'schtasks.exe'), ['/Run', '/TN', String(plan.task)], { ms: 30000 });
  writeJson(path.join(dir, 'ran.json'), { code: r.code, err: (r.err || r.out || '').trim().slice(0, 300), user: os.userInfo().username, at: Date.now() });
  return 0;
}

/**
 * probe-export: R6's, as a task running as one standard account runs it, as Inno's ExecAsOriginalUser runs launch.js for
 * the account that started Setup: a file made in that account's own %LOCALAPPDATA%\AGMessage (which the lane, elevated,
 * then reads), and the bundle's launch.js export of the plan's portable folder into that account's import folder, by
 * their absolute paths. Its exit code, its words' tail and where its profile is written to ran.json (no secret: the
 * export writes none).
 */
function probeExport(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  const local = String(process.env.LOCALAPPDATA || '');
  let made;
  try {
    if (!DRIVE_PATH.test(local)) throw new Error('no LOCALAPPDATA named from its drive');
    fs.mkdirSync(path.join(local, 'AGMessage'), { recursive: true });
    fs.writeFileSync(path.join(local, 'AGMessage', 'r6-probe.txt'), 'R6\n');
    made = 'made';
  } catch (e) { made = String((e && (e.code || e.message)) || 'not made').slice(0, 120); }
  const r = run(process.execPath, [String(plan.launch), 'export', '--source', String(plan.source), '--machine', String(plan.machine), '--sys', system32()], { ms: 120000 });
  writeJson(path.join(dir, 'ran.json'), { code: r.code, out: (r.out + r.err).trim().slice(-600), local, made, user: os.userInfo().username, at: Date.now() });
  return 0;
}

/** probe-release: GitHub's answer for the plan's address, as SYSTEM reads it. */
async function probeRelease(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  writeJson(path.join(dir, 'answer.json'), { ...(await readRelease(plan.url)), user: os.userInfo().username });
  return 0;
}

/**
 * probe-offline: the release asked as the bundle's own machine.js asks it for a checked upgrade (githubGet, then the words
 * githubWords gives a person), with this copy of node.exe kept off the network by the lane's outbound rule: what it met and
 * the words it shows. The lane leaves the bundle's machine.js beside this file's copy.
 */
async function probeOffline(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  const m = require(path.join(__dirname, 'machine.js'));
  const t0 = now();
  const r = await m.githubGet('/repos/' + plan.repo + '/releases/tags/' + plan.tag);
  const said = m.githubWords(r.error ? r : { status: r.status, headers: r.headers }, { repo: plan.repo, asked: 'release ' + plan.tag });
  writeJson(path.join(dir, 'offline.json'), { ms: Math.round(now() - t0), error: String(r.error || ''), status: r.status || 0, why: said.why, words: r.error ? said.words : '', user: os.userInfo().username });
  return 0;
}

/**
 * probe-server: under the task's token, what the account is and holds, its profile before and after, UDP 9928, the
 * bundle's watchdog started in the installed channel and asked for health, and a quick tunnel; then, once the lane has
 * read the folder pipe ("done"), the watchdog ended. Each stage is written to facts.json as it is reached.
 */
async function probeServer(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  const facts = { stage: 'started', pid: process.pid };
  const save = () => writeJson(path.join(dir, 'facts.json'), facts);
  save();
  const sys = system32();
  facts.env = {};
  for (const k of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'USERNAME']) facts.env[k] = process.env[k] || '';
  facts.homedir = os.homedir();
  const whoami = (what) => run(path.win32.join(sys, 'whoami.exe'), [what, '/fo', 'csv'], { ms: 15000 }).out.slice(0, 64 * 1024);
  facts.whoami = { user: whoami('/user'), priv: whoami('/priv'), groups: whoami('/groups') };
  const before = snapshot(facts.homedir);
  facts.udp = await udpHeard();
  save();
  const supervise = String(plan.supervise);
  const env = { ...process.env, AGM_RUNS: 'task', AGM_DATA_DIR: plan.folders.data, AGM_UPLOAD_DIR: plan.folders.uploads, AGM_KEY_DIR: plan.folders.keys, AGM_TOKEN_DIR: plan.folders.token, PORT: String(plan.port) };
  delete env.AGM_OPEN;
  let tail = '';
  const watchdog = childProcess.spawn(process.execPath, [supervise], { cwd: path.dirname(path.dirname(supervise)), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keep = (c) => { tail = keepTail(tail, c.toString('utf8')); };
  watchdog.stdout.on('data', keep);
  watchdog.stderr.on('data', keep);
  let ended = null;
  watchdog.on('exit', (code) => { ended = code; });
  facts.served = await waitHealth(plan.port);
  if (facts.served.ok) {
    facts.tunnel = await quickTunnel(String(plan.cloudflared), ['tunnel', '--url', 'http://localhost:' + plan.port, '--no-autoupdate', '--logfile', path.join(plan.folders.data, 'cloudflared.log')]);
  } else {
    facts.served.words = withoutSecrets(tail, tokenIn(plan.folders.token)).slice(-2000) + (ended !== null ? ' (the watchdog ended with ' + ended + ')' : '');
  }
  facts.profile = snapshotDiff(before, snapshot(facts.homedir));
  facts.stage = 'serving';
  save();
  const t0 = now();
  while (!fs.existsSync(path.join(dir, 'done')) && now() - t0 < 120000) await sleep(250);
  if (watchdog.exitCode === null && watchdog.signalCode === null) {
    const gone = new Promise((resolve) => { watchdog.once('exit', resolve); });
    watchdog.kill();
    await Promise.race([gone, sleep(10000)]);
  }
  facts.stage = 'ended';
  save();
  return 0;
}

// ---------------------------------------------------------------- the lane

/** A reading taken on its own: its record, or {error} when it failed, so every other reading is still taken. */
async function guarded(fn) {
  try { return await fn(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 500) }; }
}

/** `test()` again every `every` ms until it gives a value, `ms` has passed or the current reading's bound is reached: that value, or null. */
async function until(test, ms, every = 500) {
  const t0 = now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (now() - t0 >= ms || left() <= 0) return null;
    await sleep(every);
  }
}

/**
 * The LSA's account rights, for PowerShell's Add-Type (Windows PowerShell 5.1 compiles C# 5 with .NET Framework's own
 * compiler): AgmLsa.Grant(sid, right), Revoke(sid, right) (false when the account held no right), Of(sid) (the rights an
 * account holds directly) and Holders(right) (the SIDs that hold it directly). Each call opens the local policy with
 * POLICY_VIEW_LOCAL_INFORMATION | POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES (0x811) and closes it; a failure throws
 * Win32Exception with Windows' own words. It is given in AGM_LSA, never written into a script or onto a command line.
 */
const LSA_SOURCE = [
  'using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Security.Principal;',
  'public static class AgmLsa {',
  '[StructLayout(LayoutKind.Sequential)] private struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }',
  '[StructLayout(LayoutKind.Sequential)] private struct LsaAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }',
  '[DllImport("advapi32.dll")] private static extern uint LsaOpenPolicy(IntPtr system, ref LsaAttributes attributes, uint access, out IntPtr policy);',
  '[DllImport("advapi32.dll")] private static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);',
  '[DllImport("advapi32.dll")] private static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, LsaString[] rights, uint count);',
  '[DllImport("advapi32.dll")] private static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);',
  '[DllImport("advapi32.dll")] private static extern uint LsaEnumerateAccountsWithUserRight(IntPtr policy, LsaString[] right, out IntPtr buffer, out uint count);',
  '[DllImport("advapi32.dll")] private static extern uint LsaFreeMemory(IntPtr buffer);',
  '[DllImport("advapi32.dll")] private static extern uint LsaClose(IntPtr policy);',
  '[DllImport("advapi32.dll")] private static extern int LsaNtStatusToWinError(uint status);',
  'private const uint NotFound = 0xC0000034; private const uint NoMore = 0x8000001A;',
  'private static void Check(uint status) { if (status != 0) { throw new Win32Exception(LsaNtStatusToWinError(status)); } }',
  'private static IntPtr Open() { LsaAttributes a = new LsaAttributes(); a.Length = Marshal.SizeOf(typeof(LsaAttributes)); IntPtr h; Check(LsaOpenPolicy(IntPtr.Zero, ref a, 0x811, out h)); return h; }',
  'private static byte[] Sid(string sid) { SecurityIdentifier s = new SecurityIdentifier(sid); byte[] b = new byte[s.BinaryLength]; s.GetBinaryForm(b, 0); return b; }',
  'private static LsaString[] Right(string right, IntPtr text) { LsaString[] r = new LsaString[1]; r[0].Buffer = text; r[0].Length = (ushort)(right.Length * 2); r[0].MaximumLength = (ushort)(right.Length * 2 + 2); return r; }',
  'public static void Grant(string sid, string right) { IntPtr text = Marshal.StringToHGlobalUni(right); IntPtr h = IntPtr.Zero; try { h = Open(); Check(LsaAddAccountRights(h, Sid(sid), Right(right, text), 1)); } finally { if (h != IntPtr.Zero) { LsaClose(h); } Marshal.FreeHGlobal(text); } }',
  'public static bool Revoke(string sid, string right) { IntPtr text = Marshal.StringToHGlobalUni(right); IntPtr h = IntPtr.Zero; try { h = Open(); uint s = LsaRemoveAccountRights(h, Sid(sid), false, Right(right, text), 1); if (s == NotFound) { return false; } Check(s); return true; } finally { if (h != IntPtr.Zero) { LsaClose(h); } Marshal.FreeHGlobal(text); } }',
  'public static string[] Of(string sid) { IntPtr h = IntPtr.Zero; IntPtr buf = IntPtr.Zero; try { h = Open(); uint n; uint s = LsaEnumerateAccountRights(h, Sid(sid), out buf, out n); if (s == NotFound) { return new string[0]; } Check(s); string[] o = new string[n]; int size = Marshal.SizeOf(typeof(LsaString)); for (int i = 0; i < o.Length; i++) { LsaString x = (LsaString)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(LsaString)); o[i] = Marshal.PtrToStringUni(x.Buffer, x.Length / 2); } return o; } finally { if (buf != IntPtr.Zero) { LsaFreeMemory(buf); } if (h != IntPtr.Zero) { LsaClose(h); } } }',
  'public static string[] Holders(string right) { IntPtr text = Marshal.StringToHGlobalUni(right); IntPtr h = IntPtr.Zero; IntPtr buf = IntPtr.Zero; try { h = Open(); uint n; uint s = LsaEnumerateAccountsWithUserRight(h, Right(right, text), out buf, out n); if (s == NoMore || s == NotFound) { return new string[0]; } Check(s); string[] o = new string[n]; for (int i = 0; i < o.Length; i++) { o[i] = new SecurityIdentifier(Marshal.ReadIntPtr(buf, i * IntPtr.Size)).Value; } return o; } finally { if (buf != IntPtr.Zero) { LsaFreeMemory(buf); } if (h != IntPtr.Zero) { LsaClose(h); } Marshal.FreeHGlobal(text); } }',
  '}',
].join(' ');

/**
 * What PowerShell is asked, each a fixed script that answers one line of JSON; what it reads is named in its environment
 * (AGM_READ_PATHS, AGM_READ_PIPES, separated by `|`), never written into the script.
 *   signatures  Windows' verdict on each file's Authenticode signature, and its signer
 *   pipes       each named pipe's security descriptor, as SDDL (owner, group and access list), read from a client's
 *               handle to it (GetSecurityInfo on the handle, as a kernel object), else through .NET by its name, else the
 *               reasons both gave; each read opens the pipe's client end, so it takes one of its server's instances
 *   users       R11's two standard accounts made (AGM_R11_USERS, comma-separated, one password in AGM_R11_PASSWORD, never
 *               written anywhere), each a member of Users, with its SID and whether it is an administrator (it must not be);
 *               R6's and the installer's life cycle's account too. Windows refuses a description over 48 characters and a
 *               name over 20, so every account these scripts are given is held under both (test/readings.test.js)
 *               Each is given "Log on as a batch job" (SeBatchLogonRight), which a task that runs as an account by its
 *               password needs before Task Scheduler can log it on, and which Windows Server gives Administrators,
 *               Backup Operators and Performance Log Users alone: through the LSA (LSA_SOURCE, compiled by Add-Type from
 *               AGM_LSA, never written into the script), read back (`batch`), with why when it was not (`batchWhy`), the
 *               holders of "Deny log on as a batch job" among the account and its groups (`deny`), and whether the
 *               account is enabled and needs no new password (`enabled`, `mustChange`). A grant that fails refuses
 *               nothing here: the row says so, and the reading or test that needs the account says why it cannot run.
 *               The account stays a standard one: a logon right is no privilege in its token.
 *   usersGone   those accounts' batch logon taken back, then the accounts removed, and the profiles a logon made for them
 *   taskHistory Task Scheduler's own log (Microsoft-Windows-TaskScheduler/Operational) turned on when it is off, so a task
 *               that does not start leaves why: {was, on}
 *   taskEvents  that log's events for one task (AGM_TASK_NAME) since a time (AGM_SINCE, ISO 8601), and the events that
 *               name a task only by its GUID (104, 311) in that time: each {id, at, values}, at most 50 (startWhy reads them)
 *   defender    Defender's real-time monitoring, its scanning on access, its mode, and the paths it excludes
 */
const SCRIPTS = {
  signatures: String.raw`$ErrorActionPreference = 'Stop'; $out = @(); foreach ($p in ($env:AGM_READ_PATHS -split '\|')) { $s = Get-AuthenticodeSignature -LiteralPath $p; $out += @{ path = $p; status = [string]$s.Status; message = [string]$s.StatusMessage; signer = $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }); timestamped = [bool]$s.TimeStamperCertificate } }; ConvertTo-Json -InputObject $out -Depth 4 -Compress`,
  pipes: String.raw`$ErrorActionPreference = 'Stop'; $out = @(); foreach ($n in ($env:AGM_READ_PIPES -split '\|')) { $why = @(); $sddl = ''; $c = $null; try { $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $n, [System.IO.Pipes.PipeDirection]::In); $c.Connect(5000); $sddl = [string]$c.GetAccessControl().GetSecurityDescriptorSddlForm('All') } catch { $why += [string]$_.Exception.Message } finally { if ($c) { $c.Dispose() } }; if (-not $sddl) { try { $sddl = [string][System.IO.Directory]::GetAccessControl('\\.\pipe\' + $n).GetSecurityDescriptorSddlForm('All') } catch { $why += [string]$_.Exception.Message } }; if ($sddl) { $out += @{ name = $n; sddl = $sddl } } else { $out += @{ name = $n; error = ($why -join '; ') } } }; ConvertTo-Json -InputObject $out -Depth 4 -Compress`,
  definition: String.raw`$ErrorActionPreference = 'Stop'; $s = New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t = $s.GetFolder($env:AGM_TASK_FOLDER).GetTask($env:AGM_TASK_NAME); ConvertTo-Json -InputObject @{ sddl = [string]$t.GetSecurityDescriptor(4); xml = [string]$t.Xml } -Compress`,
  users: String.raw`$ErrorActionPreference = 'Stop'; $lsa = ''; try { Add-Type -TypeDefinition $env:AGM_LSA } catch { $lsa = [string]$_.Exception.Message }; $p = ConvertTo-SecureString $env:AGM_R11_PASSWORD -AsPlainText -Force; $g = Get-LocalGroup -SID 'S-1-5-32-545'; $out = @(); foreach ($n in ($env:AGM_R11_USERS -split ',')) { $old = Get-LocalUser -Name $n -ErrorAction SilentlyContinue; if ($old) { if (-not $lsa) { try { [void][AgmLsa]::Revoke([string]$old.SID.Value, 'SeBatchLogonRight') } catch { } }; Remove-LocalUser -Name $n }; $u = New-LocalUser -Name $n -Password $p -PasswordNeverExpires -AccountNeverExpires -Description 'AGMessage test account: removed after its use'; try { Add-LocalGroupMember -Group $g -Member $u } catch { }; $sid = [string]$u.SID.Value; $batch = $false; $why = $lsa; $deny = @(); if (-not $lsa) { try { [AgmLsa]::Grant($sid, 'SeBatchLogonRight'); $batch = [bool](@([AgmLsa]::Of($sid)) -contains 'SeBatchLogonRight'); if (-not $batch) { $why = 'the right was granted, and not read back' } } catch { $why = [string]$_.Exception.Message }; try { $deny = @(@([AgmLsa]::Holders('SeDenyBatchLogonRight')) | Where-Object { @($sid, 'S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-113', 'S-1-5-3') -contains $_ }) } catch { $why = ($why + ' (deny not read: ' + [string]$_.Exception.Message + ')').Trim() } }; $v = Get-LocalUser -SID $u.SID; $out += @{ name = $n; sid = $sid; admin = [bool](@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { [string]$_.SID.Value -eq $sid }).Count); batch = $batch; batchWhy = $why; deny = @($deny); enabled = [bool]$v.Enabled; mustChange = ($null -eq $v.PasswordLastSet) } }; ConvertTo-Json -InputObject @($out) -Compress`,
  usersGone: String.raw`$ErrorActionPreference = 'Continue'; $lsa = $true; try { Add-Type -TypeDefinition $env:AGM_LSA -ErrorAction Stop } catch { $lsa = $false }; $sids = @(); $revoked = 0; foreach ($n in ($env:AGM_R11_USERS -split ',')) { $u = Get-LocalUser -Name $n -ErrorAction SilentlyContinue; if ($u) { $sids += [string]$u.SID.Value; if ($lsa) { try { if ([AgmLsa]::Revoke([string]$u.SID.Value, 'SeBatchLogonRight')) { $revoked++ } } catch { } }; Remove-LocalUser -Name $n } }; foreach ($p in @(Get-CimInstance -ClassName Win32_UserProfile)) { if ($sids -contains [string]$p.SID) { Remove-CimInstance -InputObject $p -ErrorAction SilentlyContinue } }; ConvertTo-Json -InputObject @{ removed = $sids.Count; revoked = $revoked } -Compress`,
  taskHistory: String.raw`$ErrorActionPreference = 'Stop'; $l = Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational'; $was = [bool]$l.IsEnabled; if (-not $was) { $l.IsEnabled = $true; $l.SaveChanges() }; ConvertTo-Json -InputObject @{ was = $was; on = [bool](Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational').IsEnabled } -Compress`,
  taskEvents: String.raw`$ErrorActionPreference = 'Stop'; $since = [datetime]::Parse($env:AGM_SINCE, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind); $name = [string]$env:AGM_TASK_NAME; $out = @(); foreach ($e in @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; Id = 100,101,102,103,104,110,111,129,200,201,203,311,322,332; StartTime = $since } -ErrorAction SilentlyContinue)) { $values = @($e.Properties | ForEach-Object { [string]$_.Value }); if (($values -contains $name) -or $e.Id -eq 104 -or $e.Id -eq 311) { $out += @{ id = [int]$e.Id; at = $e.TimeCreated.ToUniversalTime().ToString('o'); values = $values } }; if ($out.Count -ge 50) { break } }; ConvertTo-Json -InputObject @($out) -Depth 4 -Compress`,
  defender: String.raw`$ErrorActionPreference = 'Stop'; $s = Get-MpComputerStatus; $p = Get-MpPreference; ConvertTo-Json -InputObject @{ realtime = [bool]$s.RealTimeProtectionEnabled; onAccess = [bool]$s.OnAccessProtectionEnabled; antivirus = [bool]$s.AntivirusEnabled; service = [bool]$s.AMServiceEnabled; mode = [string]$s.AMRunningMode; exclusions = @($p.ExclusionPath | Where-Object { $_ }); processes = @($p.ExclusionProcess | Where-Object { $_ }); extensions = @($p.ExclusionExtension | Where-Object { $_ }) } -Compress`,
};

/**
 * The lane's hands on Windows, each program by its absolute path in `sys`: schtasks, PowerShell, a task registered and
 * removed, a firewall rule added and deleted. What is registered or added is `held` until it is removed; a removal is
 * the lane's own act (`always`), made whatever is left of a reading's bound.
 */
function lane(work, sys) {
  const exe = (name) => path.win32.join(sys, name);
  const schtasks = (args, { ms = 60000, always = false } = {}) => run(exe('schtasks.exe'), args, { ms, always });
  const ps = (script, extra = {}, { ms = 60000, always = false } = {}) => {
    const r = run(path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { ms, always, env: { ...process.env, PSModulePath: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules'), AGM_LSA: LSA_SOURCE, ...extra } });
    if (r.code !== 0) throw new Error('powershell.exe ended with ' + r.code + ': ' + r.err.trim().slice(0, 300));
    return JSON.parse(r.out.trim());
  };
  // A task that runs as an account with its password (R11's) is registered with them (/RU, /RP): the password goes to
  // schtasks alone, on a runner thrown away after the job, and into no file or record. Its answer is '' or schtasks'
  // warning that the task is registered but may not start, its principal holding no batch logon (SCHED_S_BATCH_LOGON_PROBLEM,
  // 0x4131C, which ends with 0 and is never the task's refusal).
  const register = (name, xml, { user = '', password = '' } = {}) => {
    const file = path.join(work, name.replace(/\W+/g, '-') + '.xml');
    fs.writeFileSync(file, utf16(xml));
    held.tasks.add(name);
    const r = schtasks(['/Create', '/TN', name, '/XML', file, ...(user ? ['/RU', user, '/RP', password] : []), '/F']);
    if (r.code !== 0) throw new Error('schtasks could not register ' + name + ': ' + withoutSecrets((r.err || r.out).trim(), password).slice(0, 300));
    return batchWarning(r.out + '\n' + r.err) ? 'registered, but Windows warned that it may not start: its account holds no batch logon (' + withoutSecrets(batchWarning(r.out + '\n' + r.err), password).slice(0, 200) + ')' : '';
  };
  /** Task Scheduler's own log turned on, when it is off, so a task that does not start leaves why: {was, on}, or {error}. */
  const history = () => { try { return ps(SCRIPTS.taskHistory, {}, { always: true }); } catch (e) { return { error: e.message.slice(0, 200) }; } };
  /** Why the task `name` started or not since `since` (an ISO time), from Task Scheduler's log: startWhy's answer. */
  const whyNot = (name, since) => {
    let events;
    try { events = ps(SCRIPTS.taskEvents, { AGM_TASK_NAME: name, AGM_SINCE: since }, { always: true, ms: 30_000 }); } catch (e) { return { started: false, code: null, words: 'Task Scheduler\'s log was not read (' + e.message.slice(0, 160) + ')' }; }
    return startWhy(Array.isArray(events) ? events : events ? [events] : []);
  };
  const lastResult = (name) => {
    const r = schtasks(['/Query', '/TN', name, '/FO', 'LIST', '/V']);
    const m = /^Last Result:\s*(-?\d+)/m.exec(r.out);
    return m ? Number(m[1]) : null;
  };
  // A task or a rule stays held until Windows says it is gone (deleted, or never there), so what could not be removed is
  // tried again at the lane's end.
  const remove = (name, ms = 15000) => {
    schtasks(['/End', '/TN', name], { ms, always: true });
    const d = schtasks(['/Delete', '/TN', name, '/F'], { ms, always: true });
    if (d.code === 0 || /cannot find/i.test(d.err + d.out)) held.tasks.delete(name);
  };
  /** A task's definition as schtasks shows it: {code, out}, code non-zero when there is no such task. */
  const query = (name) => schtasks(['/Query', '/TN', name, '/XML']);
  /** A firewall rule added by its name and netsh's words for it: {code, out, err}. */
  const ruleAdd = (name, words) => { held.rules.add(name); return run(exe('netsh.exe'), ['advfirewall', 'firewall', 'add', 'rule', 'name=' + name, ...words]); };
  const ruleDelete = (name, ms = 15000) => {
    const r = run(exe('netsh.exe'), ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + name], { ms, always: true });
    if (r.code === 0 || /no rules match/i.test(r.err + r.out)) held.rules.delete(name);
    return r;
  };
  return { exe, schtasks, ps, register, history, whyNot, lastResult, remove, query, ruleAdd, ruleDelete };
}

/**
 * Why the lane refuses this machine, before it makes or removes anything; '' when it may run here. It is CI's alone: it
 * registers tasks as SYSTEM and LocalService, adds a firewall rule and grants LocalService its folder, so it runs only on a
 * GitHub-hosted runner (thrown away after the job; `RUNNER_ENVIRONMENT`, which GitHub sets), never over a work folder it
 * did not make (its mark, WORK_MARK, is the first thing it writes there), and never over a \AGMessage\Server task it did
 * not make (the installed node's: `serverTask`, schtasks' answer for it, read as text with any UTF-16 NULs dropped).
 */
function placeRefusal({ env = process.env, work, serverTask }) {
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    return 'take registers tasks as SYSTEM and LocalService, adds a firewall rule and grants LocalService its work folder: it is CI\'s, on a GitHub-hosted runner thrown away after the job, and this machine is not one (RUNNER_ENVIRONMENT ' + JSON.stringify(String(env.RUNNER_ENVIRONMENT || '')) + '). Lab 3 is the show laptop\'s, taken on it, not with this';
  }
  let there = true;
  try { fs.lstatSync(work); } catch { there = false; /* no folder there: the lane makes its own */ }
  if (there && !fs.existsSync(path.join(work, WORK_MARK))) return work + ' is there and was not made by the lane (no ' + WORK_MARK + ' in it): it is not the lane\'s to remove';
  if (serverTask && serverTask.code === 0 && !String(serverTask.out || '').replace(/\0/g, '').includes(STAND_IN)) {
    return SERVER_TASK + ' is a task the lane did not make (the installed node\'s): the lane would replace and remove it';
  }
  return '';
}

/**
 * R12: RestartOnFailure as the server task sets it (3 × 1 min), asked twice, each time of a task and a folder of its own,
 * so a restart the first queued can never be counted for the second: a task whose action exits 1 is run and watched for a
 * second start, then removed (a restart it still has queued dies with it, and would land in its own folder anyway); then a
 * task whose action exits 0 is run and watched for `zeroMs`. {tasks, nonZero, zero}, each {starts, waitedMs, lastResult};
 * the first phase reported (`progress`) once it is measured.
 */
async function takeR12(L, { node, self, dir, cwd }, { nonZeroMs = 150000, zeroMs = 90000, every = 1000, progress = () => {} } = {}) {
  const phase = async (name, code, waitMs) => {
    const own = path.join(dir, code === 0 ? 'zero' : 'non-zero');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'code'), String(code));
    const starts = () => { try { return fs.readFileSync(path.join(own, 'starts.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; /* not started yet */ } };
    try {
      L.register(name, taskXml({ description: 'AGMessage readings: the server task\'s settings, an action that exits ' + code, ...SERVER_PRINCIPAL, restart: true, command: node, args: [self, 'probe-exit', own], cwd }));
      const t0 = now();
      const ran = L.schtasks(['/Run', '/TN', name]);
      if (ran.code !== 0) throw new Error('schtasks could not run the stand-in: ' + (ran.err || ran.out).trim().slice(0, 300));
      await until(() => starts() >= 2, waitMs, every);
      return { starts: starts(), waitedMs: Math.round(now() - t0), lastResult: L.lastResult(name) };
    } finally { L.remove(name); }
  };
  const nonZero = await phase(RESTART_TASKS.nonZero, 1, nonZeroMs);
  progress({ tasks: [RESTART_TASKS.nonZero, RESTART_TASKS.zero], nonZero });
  const zero = await phase(RESTART_TASKS.zero, 0, zeroMs);
  return { tasks: [RESTART_TASKS.nonZero, RESTART_TASKS.zero], nonZero, zero };
}

// ---------------------------------------------------------------- R1: the gap, as an upgrade makes it

/** R1's folders: an empty hall, and the largest real hall the plan names, 20 halls of 10,000 messages. */
const R1_SIZES = [{ name: 'empty', halls: 1, messages: 0 }, { name: 'large', halls: 20, messages: 10000 }];
const R1_ROUNDS = 3;
/** The hall page's reconnection pace (public/reconnect.js OPTIONS): from 0.5 s, doubling to 2 s at most, each ±50 %. */
const PAGE_PACE = { delayMs: 500, maxMs: 2000, jitter: 0.5 };
/** How long before the reading its seeded messages were written: past the busy line's 10 minutes (app/lib/busy.js). */
const R1_QUIET_MS = 11 * 60_000;

/**
 * A data folder seeded with `halls` halls of `messages` messages each, every hall's snapshot written whole as the store
 * writes one (data/rooms/<CODE>.json), its log empty: the halls' codes, in order. The newest message is written at `at`,
 * by default 11 minutes ago, before the busy line's window, so the folder is a large hall between shows and the stop
 * the reading asks is the upgrade's own, needing no reason typed.
 */
function seedHalls(dataDir, { halls, messages, at = Date.now() - R1_QUIET_MS }) {
  const rooms = path.join(dataDir, 'rooms');
  fs.mkdirSync(rooms, { recursive: true });
  const codes = [];
  for (let h = 1; h <= halls; h++) {
    const code = 'GAP' + String(h).padStart(3, '0');
    const list = [];
    for (let i = 1; i <= messages; i++) list.push({ id: 'g' + h + 'm' + i, type: 'text', text: 'Seeded message ' + i + ' of ' + messages + ' in hall ' + h + ', as long as a line typed backstage', at: at - (messages - i) * 1000, seq: i, from: { uid: 'useed' + h, name: 'Seed', role: 'research' } });
    fs.writeFileSync(path.join(rooms, code + '.json'), JSON.stringify({ code, name: 'Gap ' + h, createdAt: at, seq: messages, settings: {}, messages: list, savedAt: at, gone: [] }));
    codes.push(code);
  }
  return codes;
}

/**
 * A page as the hall page connects: Socket.IO 4 over its WebSocket transport (Engine.IO 4), naming `build` as a page
 * names the build that served it. Resolves {emit(event, arg, ms) → the server's answer, or null when none came within
 * `ms` (10 s) or the socket closed; closed; close()} once the server took it, or null when it did not within `ms`
 * (refused, nothing listening, or silent). Every wait ends by the current reading's bound.
 */
function pageSocket(port, { build, ms = 10000 }) {
  return new Promise((resolve) => {
    const room = within(ms);
    if (room <= 0) { resolve(null); return; }
    let ws;
    try { ws = new WebSocket('ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket'); } catch { resolve(null); return; }
    const acks = new Map();
    let next = 0;
    let ended;
    const closed = new Promise((r) => { ended = r; });
    const timer = setTimeout(() => { resolve(null); ws.close(); }, room);
    const page = {
      emit: (event, arg, waitMs = 10000) => new Promise((r) => {
        const id = next++;
        const late = setTimeout(() => { acks.delete(id); r(null); }, within(waitMs));
        acks.set(id, (v) => { clearTimeout(late); r(v); });
        ws.send('42' + id + JSON.stringify([event, arg]));
      }),
      closed,
      close: () => ws.close(),
    };
    ws.addEventListener('message', (e) => {
      const t = String(e.data);
      if (t === '2') ws.send('3');                                           // the server's ping, answered
      else if (t[0] === '0') ws.send('40' + JSON.stringify({ build }));       // open: into the namespace, naming the build
      else if (t.startsWith('40')) { clearTimeout(timer); resolve(page); }   // taken
      else if (t.startsWith('44')) { clearTimeout(timer); resolve(null); ws.close(); }   // refused
      else {
        const m = /^43(\d+)(\[[\s\S]*)$/.exec(t);
        const answer = m && acks.get(Number(m[1]));
        if (!answer) return;
        acks.delete(Number(m[1]));
        try { answer(JSON.parse(m[2])[0]); } catch { answer(null); /* an answer that is not JSON: none */ }
      }
    });
    ws.addEventListener('error', () => { /* the close that follows says it */ });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve(null);
      for (const answer of acks.values()) answer(null);
      acks.clear();
      ended();
    });
  });
}

/** The page's next wait before it tries again, at its pace: `tries` made so far (crypto's chance for the ±50 %). */
function paceMs(tries, pace = PAGE_PACE) {
  const base = Math.min(pace.delayMs * 2 ** tries, pace.maxMs);
  const deviation = Math.floor((crypto.randomInt(1000) / 1000) * pace.jitter * base);
  return Math.min(crypto.randomInt(2) ? base + deviation : base - deviation, pace.maxMs);
}

/**
 * A process and every process it started, ended outright: on Windows by taskkill /T /F by its absolute path (a watchdog's
 * forked server outlives its parent's end there), elsewhere, where the lane's watchdogs are the tests', by SIGTERM.
 */
function endTree(pid, ms = 15000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') run(path.win32.join(system32(), 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { ms, always: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* it has ended already */ } }
}

/** The bundle's watchdog, started as a person's window starts it, `held` until it ends: {child, exited (its code), tail()}. */
function startWatchdog(node, supervise, env) {
  const child = childProcess.spawn(node, [supervise], { cwd: path.dirname(path.dirname(supervise)), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (child.pid) held.pids.add(child.pid);
  let tail = '';
  const keep = (c) => { tail = keepTail(tail, c.toString('utf8')); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise((resolve) => { child.once('exit', (code) => { held.pids.delete(child.pid); resolve(code); }); child.once('error', () => resolve(null)); });
  return { child, exited, tail: () => tail };
}
/**
 * A watchdog ended: stopped at loopback with the proof, or its tree ended outright when that is not answered within
 * 10 s; one still running 5 s later stays `held`, for the lane's end. Its waits are the lane's own, so a reading at its
 * bound still ends what it started.
 */
async function endWatchdog(w, wire, port, token) {
  if (!w || w.child.exitCode !== null || w.child.signalCode !== null) return;
  await wire.stop({ port, token, reason: 'stop', by: 'the readings lane', force: 'the reading ended' });
  if ((await Promise.race([w.exited.then(() => true), pause(10000).then(() => false)]))) return;
  if (process.platform === 'win32') endTree(w.child.pid);
  else w.child.kill();
  await Promise.race([w.exited, pause(5000)]);
}

/**
 * One gap: a page seated in the hall `code`, the stop at loopback with the proof (reason "stop": the backup an upgrade's
 * stop makes for the way back is R9's, timed on its own beside R2, so this gap is the stop and the start alone), the watchdog's end,
 * the next watchdog started at once, as an upgrade's start is, and the page back at its own pace: rejoined, with what it
 * missed (`since`). Times from the stop's request: {stopMs (the watchdog gone), code (the watchdog's exit code), healthMs
 * (health answers), pageBackMs (the rejoin answered), tries, saved (data/last-stop.json says so)}, or {error}; and the
 * watchdog now running.
 */
async function gapRound({ node, supervise, env, port, token, wire, code, dataDir, startMs }, w) {
  const hello = await wire.hello({ port, token });
  if (!hello.ok) return { result: { error: 'the server did not prove it holds the token: ' + hello.words }, watchdog: w };
  const page = await pageSocket(port, { build: hello.build });
  if (!page) return { result: { error: 'the page did not connect' }, watchdog: w };
  const first = await page.emit('join', { roomCode: code, name: 'Gap reader', role: 'observer' });
  if (!first || !first.ok) { page.close(); return { result: { error: 'the page was not seated (' + String(first && first.error || 'no answer').slice(0, 120) + ')' }, watchdog: w }; }
  const t0 = now();
  const asked = await wire.stop({ port, token, reason: 'stop', by: 'the readings lane' });
  if (!asked.ok || asked.status !== 200) { page.close(); return { result: { error: 'the stop was not taken: ' + (asked.words || JSON.stringify(asked.json || {}).slice(0, 200)) }, watchdog: w }; }
  const ended = await Promise.race([w.exited, sleep(15000).then(() => undefined)]);
  const stopMs = Math.round(now() - t0);
  if (ended === undefined) { page.close(); return { result: { error: 'the watchdog had not ended 15 s after the stop', stopMs }, watchdog: w }; }
  let saved;
  try { saved = readJson(path.join(dataDir, 'last-stop.json')).saved === true; } catch { saved = false; /* no record: the stop did not save */ }
  const next = startWatchdog(node, supervise, env);
  const t1 = now();
  const health = waitHealth(port, { ms: startMs, every: 50 }).then((h) => ({ ...h, fromStopMs: Math.round(now() - t0), fromStartMs: Math.round(now() - t1) }));
  // The old server's socket closes as it ends; a close that never comes is waited for 15 s, never for ever.
  await Promise.race([page.closed, sleep(15000)]);
  page.close();
  let tries = 0;
  let back = null;
  while (!back && now() - t0 < startMs && left() > 0) {
    await sleep(paceMs(tries));
    tries++;
    const again = await pageSocket(port, { build: hello.build, ms: 5000 });
    if (!again) continue;
    const answer = await again.emit('join', { roomCode: code, name: 'Gap reader', role: 'observer', uid: first.identity, since: first.seq });
    if (answer && answer.ok) back = Math.round(now() - t0);
    again.close();
  }
  const h = await health;
  return { result: { stopMs, code: ended, saved, healthMs: h.ok ? h.fromStopMs : null, startHealthMs: h.ok ? h.fromStartMs : null, pageBackMs: back, tries, ...(back === null ? { error: 'the page was not back within ' + startMs / 1000 + ' s' } : {}) }, watchdog: next };
}

/**
 * R1: the gap an upgrade makes, at each of `sizes` (a folder seeded per size), with the bundle's own server and watchdog
 * (under `app`) on `port`, asked as the machine asks (app/lib/machinewire.js of this checkout, the commit the bundle was
 * built from): a start that settles the folder (not measured), then `rounds` gaps, each a page seated, the stop at
 * loopback with the proof of a token made for this reading (never kept), and the next start. Run only from the checkout,
 * never from the copy the stand-in tasks run. {port, sizes: [{name, halls, messages, firstMs, rounds: [gapRound's result]}]},
 * reported (`progress`) after each round; no round or size is begun once the reading's bound is reached.
 */
async function takeR1({ node, app, work, port }, { sizes = R1_SIZES, rounds = R1_ROUNDS, startMs = 60000, progress = () => {} } = {}) {
  const wire = require('../app/lib/machinewire.js');
  const supervise = path.join(app, 'supervise.js');
  const token = crypto.randomBytes(8).toString('hex');
  const out = { port, sizes: [] };
  for (const size of sizes) {
    if (left() <= 0) break;
    const dir = path.join(work, 'r1', size.name);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const dataDir = path.join(dir, 'data');
    const code = seedHalls(dataDir, size)[0];
    const env = { ...process.env, AGM_DATA_DIR: dataDir, AGM_UPLOAD_DIR: path.join(dir, 'uploads'), AGM_KEY_DIR: path.join(dir, 'keys'), PORT: String(port), ADMIN_TOKEN: token };
    for (const k of ['AGM_OPEN', 'AGM_RUNS', 'AGM_TOKEN_DIR', 'AGM_CHILD']) delete env[k];
    const rec = { name: size.name, halls: size.halls, messages: size.messages, firstMs: null, rounds: [] };
    out.sizes.push(rec);
    let w = startWatchdog(node, supervise, env);
    try {
      const first = await waitHealth(port, { ms: startMs });
      if (!first.ok) { rec.error = 'the bundle did not serve: ' + withoutSecrets(w.tail(), token).slice(-600); continue; }
      rec.firstMs = first.ms;
      for (let i = 0; i < rounds && left() > 0; i++) {
        const r = await gapRound({ node, supervise, env, port, token, wire, code, dataDir, startMs }, w);
        w = r.watchdog;
        rec.rounds.push(r.result);
        progress(out);
        if (r.result.error) { rec.rounds[rec.rounds.length - 1].words = withoutSecrets(w.tail(), token).slice(-600); break; }
      }
    } finally { await endWatchdog(w, wire, port, token); }
  }
  return out;
}

/** The folders a server task's action (launch.js serve) is given, made under `work`. */
function serveFolders(work, name) {
  const folders = {};
  for (const k of ['data', 'uploads', 'keys', 'logs', 'token']) { folders[k] = path.join(work, name, k); fs.mkdirSync(folders[k], { recursive: true }); }
  return folders;
}

/**
 * R9 (U12 landed): the upgrade backup's time, at an empty hall and at 20 × 10,000. The bundle's own watchdog serves a
 * seeded folder (as R1), the stop at loopback with the proof carries reason "upgrade" (the seeded messages are from
 * before the busy window, so no reason is typed), the server saves and backs the folder up for the way back
 * (app/lib/upgradebackup.js), and last-stop.json names it: its time (`backupMs`) and bytes copied. {sizes: [{name,
 * backupMs, bytes, data, saved}]}.
 */
async function takeR9({ node, app, work, port }, { sizes = R1_SIZES, startMs = 60000 } = {}) {
  const wire = require('../app/lib/machinewire.js');
  const supervise = path.join(app, 'supervise.js');
  const token = crypto.randomBytes(8).toString('hex');
  const out = { sizes: [] };
  for (const size of sizes) {
    if (left() <= 0) break;
    const dir = path.join(work, 'r9', size.name);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const dataDir = path.join(dir, 'data');
    seedHalls(dataDir, size);
    const env = { ...process.env, AGM_DATA_DIR: dataDir, AGM_UPLOAD_DIR: path.join(dir, 'uploads'), AGM_KEY_DIR: path.join(dir, 'keys'), PORT: String(port), ADMIN_TOKEN: token };
    for (const k of ['AGM_OPEN', 'AGM_RUNS', 'AGM_TOKEN_DIR', 'AGM_CHILD']) delete env[k];
    const rec = { name: size.name, halls: size.halls, messages: size.messages };
    out.sizes.push(rec);
    const w = startWatchdog(node, supervise, env);
    try {
      const first = await waitHealth(port, { ms: startMs });
      if (!first.ok) { rec.error = 'the bundle did not serve: ' + withoutSecrets(w.tail(), token).slice(-400); continue; }
      const stopped = await wire.stop({ port, token, reason: 'upgrade', by: 'the readings lane' });
      if (!stopped.ok || stopped.status !== 200) { rec.error = 'the stop was not taken: ' + (stopped.words || JSON.stringify(stopped.json || {}).slice(0, 200)); continue; }
      await Promise.race([w.exited, sleep(20000)]);
      try {
        const lastStop = readJson(path.join(dataDir, 'last-stop.json'));
        rec.saved = lastStop.saved === true;
        rec.backup = typeof lastStop.backup === 'string' ? lastStop.backup : '';
        rec.backupMs = Number.isFinite(lastStop.backupMs) ? lastStop.backupMs : null;
        if (rec.backup) { try { rec.meta = readJson(path.join(dataDir, ...rec.backup.split('/'), 'backup.json')); } catch { /* the folder names it */ } }
      } catch (e) { rec.error = 'no last-stop record: ' + e.message; }
    } finally { await endWatchdog(w, wire, port, token); }
  }
  // Beside R2, which reads these two by name (tools/readings.js judgeR2): the backup's time at each size.
  out.emptyMs = (out.sizes.find((s) => s.name === 'empty') || {}).backupMs;
  out.largeMs = (out.sizes.find((s) => s.name === 'large') || {}).backupMs;
  return out;
}

/**
 * R3′ (U12 landed): the server task's stop and its end. U12's own server task's definition (app/machine.js
 * serverTaskXml), under the lane's name and with the lane's folders, runs launch.js serve (AGM_RUNS=task); `rounds` times
 * it is run, serves, and is stopped at loopback with the proof of a token its own server made; each round records whether the task ended with 0, stayed stopped, and
 * last-stop.json says it saved. {rounds: [{saved, lastResult, state}], savedCount}. The give-up and configuration refusal
 * ending the task with 0 are launch.js serve's exit mapping, held on Linux (test/machine.test.js); here the task's own
 * stop-saves are counted, 10 of 10 the mark. Reported (`progress`) after each round; no round begun once the reading's
 * bound is reached.
 */
async function takeR3prime(L, { node, app, work, port }, { rounds = 10, startMs = 60000, progress = () => {} } = {}) {
  const wire = require('../app/lib/machinewire.js');
  const launch = path.join(app, 'launch.js');
  const folders = serveFolders(work, 'r3');
  const seedCode = seedHalls(folders.data, { halls: 1, messages: 50 })[0];
  const task = '\\AGMessage-Readings\\Serve';
  // U12's own definition (app/machine.js), its folders the lane's: run on demand here, its boot trigger never fired.
  L.register(task, require('../app/machine.js').serverTaskXml({ uri: task, node, launch, ...folders, events: path.join(work, 'r3', 'events.jsonl'), port }));
  const out = { task, rounds: [], savedCount: 0 };
  try {
    for (let i = 0; i < rounds && left() > 0; i++) {
      if (i) progress(out);
      fs.rmSync(path.join(folders.data, 'last-stop.json'), { force: true });
      const ran = L.schtasks(['/Run', '/TN', task]);
      if (ran.code !== 0) { out.rounds.push({ error: 'schtasks could not run it: ' + (ran.err || ran.out).trim().slice(0, 160) }); continue; }
      const served = await waitHealth(port, { ms: startMs });
      if (!served.ok) { out.rounds.push({ error: 'did not serve' }); L.schtasks(['/End', '/TN', task]); continue; }
      const token = tokenIn(folders.token);
      const stopped = token ? await wire.stop({ port, token, reason: 'stop', by: 'the readings lane' }) : null;
      await until(() => L.lastResult(task) !== null && !(/Running/i.test(L.schtasks(['/Query', '/TN', task, '/FO', 'LIST']).out)), 20000);
      const q = L.schtasks(['/Query', '/TN', task, '/FO', 'LIST', '/V']).out;
      let saved = false;
      try { saved = readJson(path.join(folders.data, 'last-stop.json')).saved === true; } catch { saved = false; }
      const lastResult = Number((/^Last Result:\s*(-?\d+)/m.exec(q) || [])[1]);
      const state = (((/^Status:\s*(.+)$/m.exec(q) || [])[1] || '').trim()).slice(0, 40);
      if (saved && lastResult === 0) out.savedCount++;
      out.rounds.push({ saved, lastResult: Number.isFinite(lastResult) ? lastResult : null, state, stopOk: !!(stopped && stopped.ok && stopped.status === 200) });
      if (seedCode && !saved) out.rounds[out.rounds.length - 1].code = seedCode;
    }
  } finally { L.remove(task); }
  return out;
}

/**
 * R11: U17's control task as app/machine.js registers it, for one standard account made for the reading; its action the
 * bundle's machine.js control --for that account, over a machine folder of the lane's own (`root`). The runner has no
 * install record, so every request the control task reads is refused for its rights and nothing is started or stopped
 * (a machine that has one is refused before anything is made). Each round: a request with a fresh id left in that
 * account's inbox, the task that runs as the account run, its schtasks /run's exit code read (probe-run), and the
 * control task's answer to that id waited for in its outbox (`ranAs`, `for`). The second account's rounds run its own task,
 * whose schtasks /run must be refused, and no answer must come. {sid, controlTask, own, other} (each round {code, err,
 * answered, ranAs, for}), reported (`progress`) after each round; the accounts, their tasks and profiles removed whatever
 * happened, each account named as held before PowerShell is asked to make it.
 */
async function takeR11(L, { node, script, self, work, sys }, { rounds = R11_ROUNDS, answerMs = 30000, quietMs = 5000, progress = () => {} } = {}) {
  // The control task acts only on what the install record lets it: on a machine with one, R11 would act on that install.
  if (run(L.exe('reg.exe'), ['query', 'HKLM\\SOFTWARE\\AGMessage', '/reg:64']).code === 0) {
    return { skipped: 'this machine has an AGMessage install record: R11\'s control task would act on it' };
  }
  const machine = require('../app/machine.js');
  const dir = path.join(work, 'r11');
  const root = path.join(dir, 'root');
  // Letters of each kind and digits, from node:crypto, for the runner's password rules; never written anywhere.
  const password = 'Aa1!' + crypto.randomBytes(18).toString('base64url');
  const names = [R11_USERS.own, R11_USERS.other];
  let controlName = '';
  for (const n of names) held.accounts.add(n);
  try {
    const users = L.ps(SCRIPTS.users, { AGM_R11_USERS: names.join(','), AGM_R11_PASSWORD: password });
    const list = (Array.isArray(users) ? users : [users]).filter((u) => u && /^S-1-[0-9-]+$/.test(String(u.sid)));
    if (list.length !== 2) return { skipped: 'the two standard accounts were not made (' + list.length + ' of 2)' };
    if (list.some((u) => u.admin === true)) return { skipped: 'an account made for the reading is an administrator, so it measures nothing of a standard account' };
    const own = list.find((u) => u.name === R11_USERS.own);
    const other = list.find((u) => u.name === R11_USERS.other);
    // Task Scheduler's own log on, so a task as an account that does not start leaves why; each account's batch logon as
    // read back, kept beside the rounds.
    const history = L.history();
    for (const box of ['inbox', 'outbox']) fs.mkdirSync(path.join(root, 'machine', box, own.sid), { recursive: true });
    fs.mkdirSync(path.join(root, 'machine', 'work'), { recursive: true });
    controlName = '\\AGMessage-Readings\\Control-' + own.sid;
    L.register(controlName, machine.controlTaskXml({ sid: own.sid, node, script, machine: root, sys, uri: controlName }));
    const out = { sid: own.sid, controlTask: controlName, own: [], other: [], accounts: list.map(logonOf), history };
    for (const [who, u] of [['own', own], ['other', other]]) {
      const probe = path.join(dir, who);
      fs.mkdirSync(probe, { recursive: true });
      const granted = run(L.exe('icacls.exe'), [probe, '/grant', '*' + u.sid + ':(OI)(CI)M']);
      if (granted.code !== 0) throw new Error('the ' + who + ' account was not granted its folder: ' + (granted.err || granted.out).trim().slice(0, 200));
      writeJson(path.join(probe, 'plan.json'), { task: controlName });
      const asName = R11_TASKS.as + who;
      // Its action is one schtasks /run of 30 s at most: Task Scheduler ends it at 10 minutes, whatever the lane does.
      const warned = L.register(asName, taskXml({ description: 'AGMessage readings R11: schtasks /run of a control task, as ' + u.name, sid: u.sid, logon: 'Password', limit: 'PT10M', command: node, args: [self, 'probe-run', probe], cwd: path.dirname(self) }), { user: u.name, password });
      if (warned) out[who + 'Registered'] = warned;
      try {
        for (let i = 0; i < rounds && left() > 0; i++) {
          const id = crypto.randomBytes(12).toString('hex');
          const inbox = path.join(root, 'machine', 'inbox', own.sid, 'request.json');
          const answerFile = path.join(root, 'machine', 'outbox', own.sid, 'answer.json');
          fs.rmSync(path.join(probe, 'ran.json'), { force: true });
          fs.writeFileSync(inbox, JSON.stringify({ id, verb: 'start' }));
          const since = new Date(Date.now() - 2000).toISOString();
          const started = L.schtasks(['/Run', '/TN', asName]);
          if (started.code !== 0) { out[who].push({ code: null, err: 'its task did not run: ' + (started.err || started.out).trim().slice(0, 200), answered: false }); fs.rmSync(inbox, { force: true }); break; }
          const ran = await until(() => { try { return readJson(path.join(probe, 'ran.json')); } catch { return null; /* not written yet */ } }, answerMs);
          // A task as the account that never ran its probe says why once: the rounds after it would wait the same.
          if (!ran) { out[who].push({ code: null, err: 'the task as ' + u.name + ' wrote nothing within ' + answerMs / 1000 + ' s (last result ' + L.lastResult(asName) + '): ' + L.whyNot(asName, since).words, answered: false }); fs.rmSync(inbox, { force: true }); break; }
          const answerOf = () => { try { const a = readJson(answerFile); return a && a.id === id ? a : null; } catch { return null; /* not written yet */ } };
          const answer = await until(answerOf, who === 'own' ? answerMs : quietMs);
          out[who].push({ code: ran.code, err: ran.code === 0 ? '' : ran.err, answered: !!answer, ranAs: answer ? String(answer.ranAs || '') : '', for: answer ? String(answer.for || '') : '', words: answer ? String(answer.words || '').slice(0, 200) : '' });
          fs.rmSync(inbox, { force: true });
          progress(out);
        }
      } finally { L.remove(asName); }
    }
    return out;
  } finally {
    // Its control task goes whatever a round threw, before the accounts it names; the accounts go whether or not
    // PowerShell said it made them (one made before it failed is removed too).
    if (controlName) await guarded(() => L.remove(controlName));
    await accountsGone(L, names);
  }
}

/**
 * A standard account's logon as SCRIPTS.users read it back (pure): {name, batch, batchWhy, deny, enabled, mustChange}, its
 * password never among them. `batch` true only when the right was read back; `deny` the SIDs of it and its groups that hold
 * "Deny log on as a batch job".
 */
function logonOf(u) {
  return {
    name: String(u && u.name || ''),
    batch: !!u && u.batch === true,
    batchWhy: String(u && u.batchWhy || '').slice(0, 200),
    deny: (u && Array.isArray(u.deny) ? u.deny : u && u.deny ? [u.deny] : []).map(String).filter((x) => /^S-1-[0-9-]+$/.test(x)),
    enabled: !!u && u.enabled === true,
    mustChange: !!u && u.mustChange === true,
  };
}

/** Standard accounts the lane named, removed with the profiles a logon made for them, and no longer held once that is said. */
async function accountsGone(L, names) {
  const r = await guarded(() => L.ps(SCRIPTS.usersGone, { AGM_R11_USERS: names.join(',') }, { always: true }));
  if (!r.error) for (const n of names) held.accounts.delete(n);
  return r;
}

/**
 * R6 (U14 landed): what a runner can take of over-the-shoulder elevation. The plan's two readings of the account that
 * started Setup need a desktop where one account starts the installer and an administrator approves its elevation with
 * their own credentials (UAC's prompt), which no runner has: they stay the show laptop's, and the record says so. What the
 * lane takes: one standard account made for the reading; its import folder made by the bundle's machine.js import --step
 * stage, elevated, with that account's own grants, over a machine folder of the lane's own; that account's export (the
 * bundle's launch.js export, run by a task with its logon, as Inno's ExecAsOriginalUser runs it) of a stand-in portable
 * folder last run by this build into that folder; the bundle's machine.js import --step take reading that bundle elevated
 * and verifying it; and this lane, elevated, reading the file the account's probe made in its %LOCALAPPDATA%\AGMessage.
 * {sid, stage, export, take, profileRead}, reported (`progress`) after each step; the account, its task and its
 * profile removed whatever happened, the account named as held before PowerShell is asked to make it.
 */
async function takeR6(L, { node, root, self, work, sys }, { exportMs = 150000, progress = () => {} } = {}) {
  const dir = path.join(work, 'r6');
  const machineRoot = path.join(dir, 'ProgramData', 'AGMessage');
  const source = path.join(dir, 'portable', 'AGMessage');
  const password = 'Aa1!' + crypto.randomBytes(18).toString('base64url');
  held.accounts.add(R6_USER);
  try {
    const users = L.ps(SCRIPTS.users, { AGM_R11_USERS: R6_USER, AGM_R11_PASSWORD: password });
    const u = (Array.isArray(users) ? users : [users]).find((x) => x && x.name === R6_USER && /^S-1-[0-9-]+$/.test(String(x.sid)));
    if (!u) return { skipped: 'the standard account was not made' };
    if (u.admin === true) return { skipped: 'the account made for the reading is an administrator, so it measures nothing of a standard account' };
    const history = L.history();
    // The machine folder's own children and machine\'s, as prepare makes them (their grants are the import's to set).
    for (const sub of ['data', 'uploads', 'keys', 'logs', 'token', path.join('machine', 'inbox'), path.join('machine', 'outbox'), path.join('machine', 'work')]) fs.mkdirSync(path.join(machineRoot, sub), { recursive: true });
    // A stand-in portable folder last run by this build in the format it writes (its facts reader names both), with nothing
    // sealed in it.
    fs.mkdirSync(path.join(source, 'app', 'data'), { recursive: true });
    const blank = path.join(dir, 'blank');
    fs.mkdirSync(blank, { recursive: true });
    const built = run(node, [path.join(root, 'app', 'lib', 'importfacts.js'), '--data', blank, '--keys', blank], { ms: 60000 });
    const facts = (() => { try { return JSON.parse(built.out.trim().split(/\r?\n/).pop()).facts; } catch { return {}; } })();
    const build = typeof facts.build === 'string' ? facts.build : '';
    const current = facts.format && Number.isSafeInteger(facts.format.current) ? facts.format.current : 0;
    if (!build || !current) return { skipped: 'the bundle\'s build and format were not read (' + (built.err || built.out).trim().slice(0, 200) + ')' };
    writeJson(path.join(source, 'app', 'data', 'format.json'), { format: current, build, at: Date.now() });
    fs.writeFileSync(path.join(source, 'start-agmessage.bat'), '@echo off\r\n');
    const probe = path.join(dir, 'probe');
    fs.mkdirSync(probe, { recursive: true });
    for (const f of [probe, path.join(dir, 'portable')]) {
      const granted = run(L.exe('icacls.exe'), [f, '/grant', '*' + u.sid + ':(OI)(CI)M']);
      if (granted.code !== 0) throw new Error('the account was not granted ' + f + ': ' + (granted.err || granted.out).trim().slice(0, 200));
    }
    const out = { sid: u.sid, account: logonOf(u), history };
    const step = (name, args) => {
      const said = path.join(dir, name + '.json');
      const r = run(node, [path.join(root, 'app', 'machine.js'), 'import', '--step', name, '--for', u.sid, '--machine', machineRoot, ...args, '--out', said], { ms: 300000 });
      let rec;
      try { rec = readJson(said); } catch { rec = {}; /* no record: its exit code says what it did */ }
      return { code: r.code, words: String(rec.words || (r.err || r.out).trim()).slice(0, 400), verified: rec.verified === true };
    };
    out.stage = step('stage', ['--sys', sys]);
    progress(out);
    if (out.stage.code !== 0) return out;
    writeJson(path.join(probe, 'plan.json'), { launch: path.join(root, 'app', 'launch.js'), source, machine: machineRoot });
    const warned = L.register(R6_TASK, taskXml({ description: 'AGMessage readings R6: launch.js export, as ' + u.name, sid: u.sid, logon: 'Password', limit: 'PT10M', command: node, args: [self, 'probe-export', probe], cwd: path.dirname(self) }), { user: u.name, password });
    if (warned) out.registered = warned;
    try {
      const since = new Date(Date.now() - 2000).toISOString();
      const started = L.schtasks(['/Run', '/TN', R6_TASK]);
      if (started.code !== 0) { out.export = { code: null, err: 'its task did not run: ' + (started.err || started.out).trim().slice(0, 200) }; return out; }
      const ran = await until(() => { try { return readJson(path.join(probe, 'ran.json')); } catch { return null; /* not written yet */ } }, exportMs);
      if (!ran) { out.export = { code: null, err: 'the task as ' + u.name + ' wrote nothing within ' + exportMs / 1000 + ' s (last result ' + L.lastResult(R6_TASK) + '): ' + L.whyNot(R6_TASK, since).words }; return out; }
      let said = {};
      try { said = readJson(path.join(machineRoot, 'machine', 'inbox', u.sid, 'import', 'export.json')); } catch (e) { said = { words: 'its answer was not read elevated (' + (e.code || e.message) + ')' }; }
      out.export = { code: ran.code, words: String(said.words || ran.out || '').slice(0, 400), user: String(ran.user || ''), made: String(ran.made || '') };
      progress(out);
      out.take = step('take', ['--app', root, '--source', source, '--sys', sys]);
      try { fs.readFileSync(path.join(String(ran.local), 'AGMessage', 'r6-probe.txt')); out.profileRead = { ok: true }; } catch (e) { out.profileRead = { ok: false, code: String((e && e.code) || 'EIO') }; }
      return out;
    } finally { L.remove(R6_TASK); }
  } finally {
    await accountsGone(L, [R6_USER]);
  }
}

/**
 * The readings of `plan` ([id, fn(progress)], in order) taken one after another into `raw.readings`, each on its own and
 * within its own bound (`boundsMs[id]`) and the lane's deadline (`deadlineMs` from `began`), so the take ends by itself:
 *   - one `skip` names is written with its words, and not taken; one the record already holds (written by an earlier take
 *     this one adds to) is kept as it is;
 *   - one begins only while its bound fits in what is left of the deadline, else it is written "not taken: the lane's
 *     deadline" with the time left and the time it needs, so a reading begun is never cut by the step's limit;
 *   - as it begins its record says so (`running`) and is written, and each round it reports (`progress`) is written beside
 *     that, so a lane lost in it still says where it stopped and what it had taken;
 *   - at its bound every wait of it ends and no program of it starts (`within`, by its own bound in `bounded`, which the
 *     next reading does not share); one not ended `settleMs` after its bound is written cut, its rounds so far kept, and
 *     the lane goes on; one that ends past its bound is written cut too, what it took kept and never judged;
 *   - its record is written as it ends, its begin, its seconds and the take that took it (`take`, this take's index in
 *     `raw.takes`, when given) kept in `raw.times` and said on the console.
 * A record that cannot be written is said, and the readings go on. Resolves once each reading of the plan is written.
 */
async function takeAll(plan, { raw, save, say = (line) => console.log(line), began = now(), deadlineMs, boundsMs, skip = new Map(), settleMs = SETTLE_MS, take = null }) {
  if (!raw.readings || typeof raw.readings !== 'object') raw.readings = {};
  if (!raw.times || typeof raw.times !== 'object') raw.times = {};
  const at = () => Math.round((now() - began) / 1000);
  const write = (when) => { try { save(); } catch (e) { say('readings-take: the record could not be written ' + when + ' (' + e.message + ')'); } };
  for (const [id, fn] of plan) {
    const boundMs = boundsMs[id];
    const leftMs = deadlineMs - (now() - began);
    let rec = null;
    if (skip.has(id) && Object.hasOwn(raw.readings, id)) {
      say('readings-take: ' + id + ' left to another take, and kept as the record it adds to holds it');
      continue;
    }
    if (skip.has(id)) rec = { skipped: skip.get(id) };
    else if (!(boundMs > 0)) rec = { error: 'it has no bound of its own (BOUNDS)' };
    else if (boundMs > leftMs) rec = { skipped: 'not taken: the lane\'s deadline (' + span(Math.max(0, leftMs)) + ' left of its ' + span(deadlineMs) + ', and its own bound is ' + span(boundMs) + ')' };
    if (rec) {
      raw.readings[id] = rec;
      write('after ' + id);
      say('readings-take: ' + id + ' ' + endWords(rec) + ' at ' + at() + ' s');
      continue;
    }
    const running = 'begun at ' + at() + ' s, its own bound ' + span(boundMs);
    raw.readings[id] = { running };
    raw.times[id] = { begunS: at(), ...(Number.isInteger(take) ? { take } : {}) };
    write('as ' + id + ' began');
    say('readings-take: ' + id + ' ' + running);
    const end = now() + boundMs;
    let open = true;
    let sofar = {};
    const progress = (partial) => {
      if (!open || !partial || typeof partial !== 'object') return;
      sofar = partial;
      raw.readings[id] = { ...partial, running };
      write('in ' + id);
    };
    const LATE = Symbol('late');
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), boundMs + settleMs); });
    const r = await Promise.race([bounded.run({ end }, () => guarded(() => fn(progress))), late]);
    clearTimeout(timer);
    open = false;
    if (r === LATE) rec = { ...sofar, cut: 'its own bound of ' + span(boundMs) + ': it had not ended ' + span(settleMs) + ' after it' };
    else if (now() >= end) rec = { ...(r && typeof r === 'object' ? r : {}), cut: 'its own bound of ' + span(boundMs) + ', reached before it ended: what it took by then is kept, never judged' };
    else rec = r;
    raw.readings[id] = rec;
    raw.times[id].s = at() - raw.times[id].begunS;
    write('after ' + id);
    say('readings-take: ' + id + ' ' + endWords(rec) + ' at ' + at() + ' s');
  }
}
/** What became of a reading, for the console's line. */
const endWords = (r) => (r && r.cut ? 'cut at ' + r.cut : r && r.error ? 'failed: ' + r.error : r && r.skipped ? 'not run: ' + r.skipped : 'taken');

/**
 * What the lane still holds (`held`), removed: each watchdog's process tree ended, each task ended and deleted, each
 * firewall rule deleted and, with `accounts`, the standard accounts and their profiles removed; each act within `actMs`,
 * and none begun once `ms` has passed since the first. {removed, left}, by name, for the record.
 */
function release(L, { ms = 120_000, actMs = 15_000, accounts = true } = {}) {
  const t0 = now();
  const time = () => now() - t0 < ms;
  const removed = [];
  for (const pid of [...held.pids]) {
    if (!time()) break;
    endTree(pid, actMs);
    held.pids.delete(pid);
    removed.push('process ' + pid);
  }
  for (const name of [...held.tasks]) {
    if (!time()) break;
    L.remove(name, actMs);
    if (!held.tasks.has(name)) removed.push(name);
  }
  for (const name of [...held.rules]) {
    if (!time()) break;
    L.ruleDelete(name, actMs);
    if (!held.rules.has(name)) removed.push('rule ' + name);
  }
  if (accounts && held.accounts.size && time()) {
    const names = [...held.accounts];
    try {
      L.ps(SCRIPTS.usersGone, { AGM_R11_USERS: names.join(',') }, { always: true, ms: Math.max(actMs, Math.min(60_000, ms - (now() - t0))) });
      for (const n of names) { held.accounts.delete(n); removed.push('account ' + n); }
    } catch { /* still held, and said in `left` */ }
  }
  const stillHeld = [...[...held.pids].map((p) => 'process ' + p), ...held.tasks, ...[...held.rules].map((r) => 'rule ' + r), ...[...held.accounts].map((a) => 'account ' + a)];
  return { removed, left: stillHeld };
}

/**
 * A take stopped by a signal (the runner's Ctrl+C, then its Ctrl+Break, at a step's limit; a SIGTERM): the record written
 * at once, not whole and saying what stopped it; then each watchdog, task and rule it holds ended and removed, each act
 * within 2.5 s and all within 6 s, inside the 7.5 s the runner waits before its Ctrl+Break (the accounts are left to the
 * runner, which is thrown away), the record written again with what was removed; then `exit(2)`.
 */
function stopOn(signal, { raw, save, L, began, exit = (code) => process.exit(code), say = (line) => console.error(line) }) {
  raw.complete = false;
  raw.stopped = signal + ' at ' + Math.round((now() - began) / 1000) + ' s';
  const step = Array.isArray(raw.takes) ? raw.takes[raw.takes.length - 1] : null;
  if (step && typeof step === 'object') step.stopped = raw.stopped;
  const write = () => { try { save(); } catch (e) { say('readings-take: the record could not be written at the stop (' + e.message + ')'); } };
  write();
  raw.cleanup = release(L, { ms: 6000, actMs: 2500, accounts: false });
  write();
  say('readings-take: stopped by ' + raw.stopped + '; the record is written, not whole' + (raw.cleanup.left.length ? '; still there: ' + raw.cleanup.left.join(', ') : ''));
  exit(2);
}

/** A record the lane begins: the runner, and nothing measured yet. */
function newRecord(env) {
  return {
    v: 1,
    at: new Date().toISOString(),
    complete: false,
    runner: { os: os.type() + ' ' + os.release(), image: [env.ImageOS, env.ImageVersion].filter(Boolean).join(' ') || 'unknown', arch: os.arch(), cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
    build: null,
    defender: null,
    defenderEnd: null,
    readings: {},
  };
}

/**
 * The record an earlier take of the same job wrote at `file`, to add to (--add): {raw} when it is the lane's; {} when there
 * is none, and a new record is begun; {refused} when a file is there that is not the lane's, which is never written over.
 */
function recordAt(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    return { refused: file + ' could not be read (' + (e.code || e.message) + '), so it is not added to or written over' };
  }
  let r;
  try { r = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { r = null; /* not JSON: not the lane's */ }
  if (!r || typeof r !== 'object' || r.v !== 1 || !r.readings || typeof r.readings !== 'object') return { refused: file + ' is not the lane\'s record, so it is not added to or written over' };
  return { raw: r };
}

/**
 * The record a take writes into: the one an earlier take wrote (`was.raw`, --add) or a new one, not whole until this take
 * ends, with this take's entry added to `takes` ({at, deadlineMin, only, skip, defender, ended}; one lost part way has no
 * `ended`), `defender` saying whether it was given tools/defender-on.ps1's record (--defender). With
 * that record, `defender` is it (null, said, when it cannot be read); without it (a take added after
 * tools/defender-off.ps1), the record's `defender` and `defenderEnd` stay as the take before wrote them. {raw, step}.
 */
function beginRecord(was, o, env, { say = (line) => console.error(line) } = {}) {
  const raw = was.raw || newRecord(env);
  raw.complete = false;
  delete raw.stopped;
  const step = { at: new Date().toISOString(), deadlineMin: o.deadlineMin || DEADLINE_MIN, only: o.only || [], skip: o.skip || [], defender: !!o.defender, ended: '' };
  raw.takes = [...(Array.isArray(raw.takes) ? raw.takes : []), step];
  if (step.defender) {
    try { raw.defender = readJson(o.defender); } catch (e) { raw.defender = null; say('readings-take: no Defender record (' + e.message + ')'); }
  }
  return { raw, step };
}

/**
 * A take's end in its record: a take given Defender's record reads it again (`defenderEnd`), so the judge knows whether it
 * was still on when the readings taken with it ended; a take given none asks Windows nothing of Defender and leaves
 * `defenderEnd` as the take before wrote it. Then the take's end, and the record whole.
 */
async function endRecord(raw, step, L) {
  if (step.defender) raw.defenderEnd = await guarded(() => L.ps(SCRIPTS.defender));
  step.ended = new Date().toISOString();
  raw.complete = true;
}

async function take(o) {
  if (process.platform !== 'win32') { console.error('readings-take: the readings are Windows\'; nothing was taken'); return 64; }
  const began = now();
  const work = path.resolve(o.work);
  const env = o.env || process.env;
  // The machine is asked first, and the bundle read, before anything is made or removed: a run refused, or handed
  // something else, touches nothing.
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') { console.error('readings-take: ' + placeRefusal({ env, work }) + '; nothing was taken'); return 64; }
  const sys = system32();
  let entries;
  try { entries = zipEntries(o.zip); topFolder(entries); } catch (e) { console.error('readings-take: ' + e.message + '; nothing was taken'); return 2; }
  const L = lane(work, sys);
  const refused = placeRefusal({ env, work, serverTask: L.query(SERVER_TASK) });
  if (refused) { console.error('readings-take: ' + refused + '; nothing was taken'); return 64; }
  const out = path.resolve(o.out);
  const was = o.add ? recordAt(out) : {};
  if (was.refused) { console.error('readings-take: ' + was.refused + '; nothing was taken'); return 2; }
  // Each take that wrote this record, with its deadline, what it took or left and whether it was given Defender's record.
  const { raw, step } = beginRecord(was, o, env);
  const deadlineMin = step.deadlineMin;
  const save = () => { fs.mkdirSync(path.dirname(out), { recursive: true }); writeJson(out, raw); };
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.mkdirSync(path.join(work, 'lane'), { recursive: true });
  fs.writeFileSync(path.join(work, WORK_MARK), 'The Windows readings lane\'s work folder: removed and made again by each run of tools/readings-take.js.\n');
  // The record is there before the first reading begins, so a lane cut short in it still has Defender's record judged.
  try { save(); } catch (e) { console.error('readings-take: the record could not be written before the readings (' + e.message + ')'); }
  // A signal (the runner's cancel at a step's limit) writes the record and removes what the lane holds before it exits.
  let stopping = false;
  const onSignal = (signal) => { if (stopping) return; stopping = true; stopOn(signal, { raw, save, L, began }); };
  const signals = ['SIGINT', 'SIGBREAK', 'SIGTERM'];
  for (const s of signals) process.on(s, onSignal);
  try {
    // The stand-in tasks run as LocalService: it may read the payload and this file, and write its own folders.
    const granted = run(L.exe('icacls.exe'), [work, '/grant', '*' + LOCAL_SERVICE + ':(OI)(CI)M']);
    if (granted.code !== 0) console.error('readings-take: LocalService was not granted the work folder: ' + granted.out + granted.err);
    const self = path.join(work, 'lane', 'readings-take.js');
    fs.copyFileSync(__filename, self);
    // Every reading but R2 reads this build's payload, laid once into a folder of its own, after R2.
    const root = path.join(work, 'payload', 'AGMessage');
    const node = path.join(root, 'node', 'node.exe');
    let laid = false;
    const needsPayload = () => { if (!laid) throw new Error('the payload was not laid'); };
    let pipes = null;
    const readings = {
      R2: () => {
        const dest = path.join(work, 'r2', 'AGMessage');
        const first = layOut(o.zip, dest, entries, { strip: 1 });
        let previous = null;
        let overWhy = '';
        if (o.previous) {
          try { previous = { entries: zipEntries(o.previous) }; topFolder(previous.entries); } catch (e) { previous = null; overWhy = 'its zip could not be read: ' + e.message; }
        } else overWhy = 'none was given';
        const over = previous ? releaseOf(o.previous) : '';
        const rounds = [];
        for (let i = 0; i < R2_ROUNDS && left() > 0; i++) {
          if (previous) {
            // The previous payload laid whole into an empty folder first (not measured), then this build over it.
            fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            layOut(o.previous, dest, previous.entries, { strip: 1 });
          }
          rounds.push(Math.round(layOut(o.zip, dest, entries, { strip: 1 }).ms));
        }
        fs.rmSync(path.join(work, 'r2'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return { files: first.files, bytes: first.bytes, emptyMs: Math.round(first.ms), rounds, over: previous ? (over ? 'v' + over : path.basename(o.previous)) : '', overWhy, how: 'each file inflated to a name of its own beside it, then renamed over the one before' };
      },
      R10: () => {
        const rounds = [];
        for (let i = 0; i < R10_ROUNDS && left() > 0; i++) {
          const dest = path.join(os.tmpdir(), 'agm-r10-' + crypto.randomBytes(6).toString('hex'), 'node.exe');
          const x = extractOne(o.zip, '/node/node.exe', dest, entries);
          const t1 = now();
          const r = run(dest, ['-e', '0'], { ms: 120000 });
          const runMs = now() - t1;
          rounds.push({ extractMs: Math.round(x.ms), runMs: Math.round(runMs), totalMs: Math.round(x.ms + runMs), code: r.code, ...(r.code === 0 ? {} : { err: r.err.trim().slice(0, 200) }) });
          fs.rmSync(path.dirname(dest), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
        return { rounds, where: os.tmpdir() };
      },
      R5: () => {
        needsPayload();
        const paths = [node, path.join(root, 'bin', 'cloudflared.exe'), ...(o.installer ? [o.installer] : [])];
        const answer = L.ps(SCRIPTS.signatures, { AGM_READ_PATHS: paths.join('|') });
        const files = Array.isArray(answer) ? answer : [answer];
        return { files: files.filter((f) => !(o.installer && f && f.path === o.installer)), installer: installerSignature(files, o.installer) };
      },
      R1: (progress) => {
        needsPayload();
        return takeR1({ node, app: path.join(root, 'app'), work, port: o.port }, { progress });
      },
      R8: () => {
        const places = {};
        for (const where of ['C:\\', env.ProgramData || 'C:\\ProgramData']) {
          const file = path.join(work, 'acl-' + crypto.randomBytes(4).toString('hex') + '.txt');
          const saved = run(L.exe('icacls.exe'), [where, '/save', file]);
          const shown = run(L.exe('icacls.exe'), [where]);
          let sddl = '';
          try { sddl = sddlOfSave(fs.readFileSync(file)); } catch { /* not saved: the error below says why */ }
          places[where] = sddl ? { sddl, icacls: shown.out.slice(0, 8192) } : { error: 'icacls /save ended with ' + saved.code + ': ' + (saved.err || saved.out).trim().slice(0, 300) };
        }
        // U12's server task's definition as app/machine.js writes it (registered here and never run, then removed): its
        // descriptor, which says who may read it, and its XML, which holds no secret.
        let serverTask;
        const name = DEFINITION_TASK;
        try {
          const f = path.join(work, 'r8');
          L.register(name, require('../app/machine.js').serverTaskXml({ uri: name, node, launch: path.join(root, 'app', 'launch.js'), data: path.join(f, 'data'), uploads: path.join(f, 'uploads'), keys: path.join(f, 'keys'), logs: path.join(f, 'logs'), token: path.join(f, 'token'), events: path.join(f, 'events.jsonl'), port: o.port }));
          const back = L.ps(SCRIPTS.definition, { AGM_TASK_FOLDER: path.win32.dirname(name), AGM_TASK_NAME: path.win32.basename(name) });
          serverTask = { sddl: String(back.sddl || ''), bytes: String(back.xml || '').length, secret: /ADMIN_TOKEN|ANTHROPIC|password|[0-9a-f]{32}/i.test(String(back.xml || '')) };
        } catch (e) { serverTask = { error: e.message.slice(0, 300) }; } finally { L.remove(name); }
        // U17's control task's definition as app/machine.js writes it, for this lane's own account (a real SID; the
        // descriptor is what is judged): registered here and never run, then removed.
        let controlTask;
        const ctl = CONTROL_DEFINITION_TASK;
        try {
          const me = /"(S-1-[0-9-]+)"/.exec(run(L.exe('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).out);
          if (!me) throw new Error('this account\'s SID was not read');
          L.register(ctl, require('../app/machine.js').controlTaskXml({ uri: ctl, sid: me[1], node, script: path.join(root, 'app', 'machine.js'), machine: path.join(work, 'r8', 'machine'), sys }));
          const back = L.ps(SCRIPTS.definition, { AGM_TASK_FOLDER: path.win32.dirname(ctl), AGM_TASK_NAME: path.win32.basename(ctl) });
          controlTask = { sid: me[1], sddl: String(back.sddl || ''), bytes: String(back.xml || '').length, secret: /ADMIN_TOKEN|ANTHROPIC|password|[0-9a-f]{32}/i.test(String(back.xml || '')) };
        } catch (e) { controlTask = { error: e.message.slice(0, 300) }; } finally { L.remove(ctl); }
        return { places, serverTask, controlTask };
      },
      R4: async () => {
        needsPayload();
        const r4dir = path.join(work, 'r4');
        try {
          const folders = {};
          for (const k of ['data', 'uploads', 'keys', 'token']) { folders[k] = path.join(work, 'task', k); fs.mkdirSync(folders[k], { recursive: true }); }
          fs.mkdirSync(r4dir, { recursive: true });
          writeJson(path.join(r4dir, 'plan.json'), { supervise: path.join(root, 'app', 'supervise.js'), cloudflared: path.join(root, 'bin', 'cloudflared.exe'), port: o.port, folders });
          L.register(SERVER_TASK, taskXml({ description: STAND_IN, ...SERVER_PRINCIPAL, restart: true, command: node, args: [self, 'probe-server', r4dir], cwd: path.dirname(self) }));
          const showsid = L.schtasks(['/ShowSid', '/TN', SERVER_TASK]).out.trim();
          const added = L.ruleAdd(RULE, ['dir=in', 'action=allow', 'program=' + node, 'protocol=TCP', 'localport=' + o.port, 'remoteip=localsubnet', 'profile=private,domain', 'enable=yes']);
          const readback = run(L.exe('netsh.exe'), ['advfirewall', 'firewall', 'show', 'rule', 'name=' + RULE, 'verbose']).out;
          const ran = L.schtasks(['/Run', '/TN', SERVER_TASK]);
          if (ran.code !== 0) throw new Error('schtasks could not run the stand-in: ' + (ran.err || ran.out).trim().slice(0, 300));
          const factsFile = path.join(r4dir, 'facts.json');
          const factsNow = () => { try { return readJson(factsFile); } catch { return null; /* not written yet */ } };
          if (!(await until(factsNow, 30000))) throw new Error('the stand-in task did not start its probe within 30 s (last result ' + L.lastResult(SERVER_TASK) + ')');
          const facts = await until(() => { const f = factsNow(); return f && f.stage !== 'started' ? f : null; }, 180000);
          if (!facts) throw new Error('the probe did not reach the server within 180 s');
          if (facts.served && facts.served.ok) {
            pipes = await guarded(() => {
              const names = fs.readdirSync('\\\\.\\pipe\\').filter((n) => /^agmessage-[0-9a-f]{16}$/.test(n));
              if (!names.length) return { pipes: [] };
              const read = L.ps(SCRIPTS.pipes, { AGM_READ_PIPES: names.join('|') });
              // A client through SMB at this machine's own names: a network logon, as a remote client's would be.
              const remote = ['localhost', os.hostname()].map((via) => ({ via, ...pipeReach('\\\\' + via + '\\pipe\\' + names[0]) }));
              return { pipes: Array.isArray(read) ? read : [read], remote };
            });
          }
          fs.writeFileSync(path.join(r4dir, 'done'), '');
          await until(() => { const f = factsNow(); return f && f.stage === 'ended'; }, 20000);
          const { stage: _stage, pid: _pid, ...kept } = factsNow() || facts;
          return { task: SERVER_TASK, principal: SERVER_PRINCIPAL, showsid, ...kept, rule: { made: added.code === 0, readback: readback.slice(0, 4096) } };
        } finally {
          // The probe is told it may end (it may still be serving when the reading was cut), then its task and the rule go.
          try { fs.writeFileSync(path.join(r4dir, 'done'), ''); } catch { /* no folder: the probe never began */ }
          L.remove(SERVER_TASK);
          L.ruleDelete(RULE);
        }
      },
      R7: () => pipes || { skipped: 'the stand-in server did not serve (R4 says why), so no pipe of its own was there to read' },
      R12: (progress) => {
        needsPayload();
        return takeR12(L, { node, self, dir: path.join(work, 'r12'), cwd: path.dirname(self) }, { progress });
      },
      // R9 and R3′ (U12 landed): the upgrade backup's time, and the server task's stop-saves. Both drive the bundle's own
      // server and watchdog (no installer), through app/lib/machinewire.js of this checkout.
      R9: () => {
        needsPayload();
        return takeR9({ node, app: path.join(root, 'app'), work, port: o.port });
      },
      'R3′': (progress) => {
        needsPayload();
        return takeR3prime(L, { node, app: path.join(root, 'app'), work, port: o.port }, { progress });
      },
      R13: async () => {
        needsPayload();
        if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '') || !/^v\d+\.\d+\.\d+$/.test(o.tag || '')) return { skipped: 'no published release was named to read (' + (o.tag || 'none') + ')' };
        try {
          const dir = path.join(work, 'r13');
          fs.mkdirSync(dir, { recursive: true });
          writeJson(path.join(dir, 'plan.json'), { url: 'https://api.github.com/repos/' + o.repo + '/releases/tags/' + o.tag });
          L.register(RELEASE_TASK, taskXml({ description: 'AGMessage readings: GitHub\'s release answer, read as SYSTEM', ...CONTROL_PRINCIPAL, command: node, args: [self, 'probe-release', dir], cwd: path.dirname(self) }));
          const ran = L.schtasks(['/Run', '/TN', RELEASE_TASK]);
          if (ran.code !== 0) throw new Error('schtasks could not run the stand-in: ' + (ran.err || ran.out).trim().slice(0, 300));
          const answer = await until(() => { try { return readJson(path.join(dir, 'answer.json')); } catch { return null; /* not written yet */ } }, 60000);
          if (!answer) throw new Error('the SYSTEM task wrote no answer within 60 s (last result ' + L.lastResult(RELEASE_TASK) + ')');
          // With no network: the bundle's machine.js asked by a copy of its node.exe that an outbound rule blocks.
          const offline = await guarded(async () => {
            const cut = path.join(dir, 'offline');
            fs.mkdirSync(cut, { recursive: true });
            const blocked = path.join(cut, 'node.exe');
            fs.copyFileSync(node, blocked);
            fs.copyFileSync(path.join(root, 'app', 'machine.js'), path.join(path.dirname(self), 'machine.js'));
            writeJson(path.join(dir, 'plan.json'), { url: 'https://api.github.com/repos/' + o.repo + '/releases/tags/' + o.tag, repo: o.repo, tag: o.tag });
            const rule = L.ruleAdd(OFFLINE_RULE, ['dir=out', 'action=block', 'program=' + blocked, 'enable=yes']);
            if (rule.code !== 0) return { error: 'the outbound rule could not be made: ' + (rule.err || rule.out).trim().slice(0, 200) };
            L.register(OFFLINE_TASK, taskXml({ description: 'AGMessage readings: a checked upgrade\'s release check with no network, as SYSTEM', ...CONTROL_PRINCIPAL, command: blocked, args: [self, 'probe-offline', dir], cwd: path.dirname(self) }));
            const go = L.schtasks(['/Run', '/TN', OFFLINE_TASK]);
            if (go.code !== 0) return { error: 'schtasks could not run the offline stand-in: ' + (go.err || go.out).trim().slice(0, 200) };
            const said = await until(() => { try { return readJson(path.join(dir, 'offline.json')); } catch { return null; /* not written yet */ } }, 90000);
            return said || { error: 'the offline task wrote no answer within 90 s (last result ' + L.lastResult(OFFLINE_TASK) + ')' };
          });
          return { tag: o.tag, ...answer, offline };
        } finally {
          L.remove(RELEASE_TASK);
          L.remove(OFFLINE_TASK);
          L.ruleDelete(OFFLINE_RULE);
        }
      },
      R11: (progress) => {
        needsPayload();
        return takeR11(L, { node, script: path.join(root, 'app', 'machine.js'), self, work, sys }, { progress });
      },
      R6: (progress) => {
        needsPayload();
        return takeR6(L, { node, root, self, work, sys }, { progress });
      },
    };
    const wanted = (id) => !o.only || !o.only.length || o.only.includes(id);
    const plan = (ids) => ids.filter(wanted).map((id) => [id, readings[id]]);
    const opts = {
      raw,
      save,
      began,
      deadlineMs: deadlineMin * 60_000,
      boundsMs: Object.fromEntries(Object.entries(BOUNDS).map(([id, min]) => [id, min * 60_000])),
      skip: new Map((o.skip || []).map((id) => [id, 'not taken here: left to a take of its own (--skip), which had not taken it when this record was written'])),
      take: raw.takes.length - 1,
    };
    await takeAll(plan(['R2']), opts);
    try {
      layOut(o.zip, root, entries, { strip: 1 });
      laid = true;
    } catch (e) { console.error('readings-take: the payload was not laid (' + e.message + ')'); }
    try { raw.build = readJson(path.join(root, 'app', 'build.json')); } catch { raw.build = null; /* a bundle without its stamp: the readings name no build */ }
    await takeAll(plan(ORDER.filter((id) => id !== 'R2')), opts);
  } finally {
    // Whatever a reading left (a task its own finally could not remove, an account made before a failure, a watchdog that
    // outlived its end) is removed here, within two minutes, before Defender is read again (a take given its record).
    raw.cleanup = release(L);
  }
  await endRecord(raw, step, L);
  for (const s of signals) process.removeListener(s, onSignal);
  try { save(); } catch (e) { console.error('readings-take: the record could not be written (' + e.message + ')'); return 2; }
  console.log('readings-take: written to ' + o.out + ' in ' + Math.round((now() - began) / 1000) + ' s');
  return 0;
}

/**
 * R5's record of the installer (pure): Windows' verdict on its signature, read beside the programs', with its file's name;
 * {why} when no installer was given (its job built none for this run) or Windows gave no verdict on it.
 */
function installerSignature(files, installer) {
  if (!installer) return { why: 'its job built none for this run' };
  const f = (files || []).find((x) => x && x.path === installer);
  if (!f || !f.status) return { why: 'Windows gave no verdict on ' + path.win32.basename(installer) };
  return { status: String(f.status), name: path.win32.basename(installer), signer: String(f.signer || '') };
}

/** The command line read as {verb, flags, rest}; a flag this does not know refused (--add alone takes no value). */
function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const known = ['--zip', '--previous', '--defender', '--out', '--work', '--port', '--repo', '--tag', '--installer', '--deadline-min', '--only', '--skip'];
  const alone = ['--add'];
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (alone.includes(rest[i])) flags[rest[i].slice(2)] = true;
    else if (rest[i].startsWith('--')) {
      if (!known.includes(rest[i]) || i + 1 >= rest.length) return { error: 'readings-take: ' + rest[i] + ' is not a word it knows, or has no value' };
      flags[rest[i].slice(2)] = rest[++i];
    } else positional.push(rest[i]);
  }
  return { verb, flags, positional };
}

/** A list of readings (--only, --skip) read as their ids, each one the lane takes; null for a word it does not know. */
function readingsOf(value) {
  if (value === undefined) return [];
  const ids = String(value).split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length && ids.every((id) => ORDER.includes(id)) ? ids : null;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.error) { console.error(a.error); return 64; }
  if (a.verb === 'probe-exit' && a.positional.length === 1) return probeExit(a.positional[0]);
  if (a.verb === 'probe-release' && a.positional.length === 1) return probeRelease(a.positional[0]);
  if (a.verb === 'probe-offline' && a.positional.length === 1) return probeOffline(a.positional[0]);
  if (a.verb === 'probe-run' && a.positional.length === 1) return probeRun(a.positional[0]);
  if (a.verb === 'probe-export' && a.positional.length === 1) return probeExport(a.positional[0]);
  if (a.verb === 'probe-server' && a.positional.length === 1) return probeServer(a.positional[0]);
  // --defender may be left out only by a take that adds to an earlier record (--add): the lane's takes after tools/defender-off.ps1.
  if (a.verb === 'take' && !a.positional.length && a.flags.zip && a.flags.out && (a.flags.defender || a.flags.add === true)) {
    const port = Number(a.flags.port || 3124);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('readings-take: --port is a port from 1024 to 65535'); return 64; }
    const deadlineMin = Number(a.flags['deadline-min'] || DEADLINE_MIN);
    if (!Number.isInteger(deadlineMin) || deadlineMin < 1 || deadlineMin > 240) { console.error('readings-take: --deadline-min is a whole number of minutes from 1 to 240'); return 64; }
    const only = readingsOf(a.flags.only);
    const skip = readingsOf(a.flags.skip);
    if (!only || !skip) { console.error('readings-take: --only and --skip name readings the lane takes, separated by commas (' + ORDER.join(',') + ')'); return 64; }
    return take({ zip: a.flags.zip, previous: a.flags.previous || '', defender: a.flags.defender || '', out: a.flags.out, work: a.flags.work || 'C:\\agm-readings', port, repo: a.flags.repo || '', tag: a.flags.tag || '', installer: a.flags.installer || '', deadlineMin, only, skip, add: a.flags.add === true });
  }
  console.error('readings-take: take --zip <bundle.zip> --out <raw.json> --defender <defender.json> (left out only with --add, after Defender was turned back off) [--previous <zip>] [--work <folder>] [--port <n>] [--repo <owner/name> --tag <vX.Y.Z>] [--installer <exe>] [--deadline-min <n>] [--only <ids>] [--skip <ids>] [--add] | probe-server <dir> | probe-exit <dir> | probe-release <dir> | probe-offline <dir> | probe-run <dir> | probe-export <dir>');
  return 64;
}

/**
 * How the command ends once `main` has answered `code`: a take exits as soon as its record is written and the console's
 * last lines are flushed, so no handle still open (a watchdog that outlived its end, a socket) keeps its step alive; a
 * probe, which a task runs, ends as its loop empties, as its task's own end expects.
 */
function finish(verb, code, { exit = (c) => process.exit(c) } = {}) {
  process.exitCode = code;
  if (verb !== 'take') return;
  const end = () => exit(code);
  process.stdout.write('', () => process.stderr.write('', end));
  setTimeout(end, 3000).unref();
}

if (require.main === module) {
  const verb = process.argv[2];
  main(process.argv.slice(2)).then((code) => finish(verb, code), (e) => { console.error('readings-take: ' + ((e && e.stack) || e)); finish(verb, 2); });
}

module.exports = {
  zipEntries, memberParts, topFolder, releaseOf, layOut, extractOne, taskXml, winArg, utf16, SERVER_PRINCIPAL, CONTROL_PRINCIPAL, SCRIPTS, LSA_SOURCE, lane, system32, takeR11, probeRun, takeR6, probeExport, R6_USER, R6_TASK,
  batchWarning, START_REFUSED, hresultOf, startWhy, logonOf,
  snapshot, snapshotDiff, udpHeard, waitHealth, quickTunnel, readRelease, probeOffline, probeExit, parseArgs, main, TRYCF, installerSignature,
  sddlOfSave, pipeReach, keepTail, tokenIn, withoutSecrets, placeRefusal, takeR12, take,
  seedHalls, pageSocket, paceMs, takeR1, takeR9, takeR3prime, serveFolders, R1_SIZES, R1_QUIET_MS, PAGE_PACE,
  SERVER_TASK, STAND_IN, DEFINITION_TASK, CONTROL_DEFINITION_TASK, RESTART_TASKS, R11_TASKS, R11_USERS, R11_ROUNDS, WORK_MARK,
  ORDER, BOUNDS, DEADLINE_MIN, STOP_MIN, SETTLE_MS, takeAll, release, stopOn, recordAt, beginRecord, endRecord, readingsOf, finish, held, within, left, until, run, endWatchdog,
};
