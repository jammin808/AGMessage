#!/usr/bin/env node
'use strict';
/**
 * The Windows evidence lane's measuring run (the 0.6.0 plan's Part 6, unit U7), on the CI's windows-2025 runner, elevated,
 * after tools/defender-on.ps1 has turned Defender's real-time monitoring back on. It writes what it measured; the verdicts
 * are tools/readings.js's.
 *
 *   node tools/readings-take.js take --zip <bundle.zip> --defender <defender.json> --out <raw.json>
 *                                    [--previous <the newest release's zip>] [--work C:\agm-readings] [--port 3124]
 *                                    [--repo <owner/name> --tag <vX.Y.Z>]
 *       R2   the bundle's payload laid over the one before it (the newest release's, when its zip is given; this build's
 *            own when not, said so), round by round: each file inflated to a name of its own beside it, then renamed
 *            over the earlier one
 *       R10  node.exe extracted from the bundle into %TEMP% and run once, round by round, with its exit code
 *       R5   Windows' verdict on node.exe's and cloudflared.exe's signatures (Get-AuthenticodeSignature)
 *       R8   the access lists of C:\ and %ProgramData% (icacls /save: SIDs, never localised names)
 *       R4   a stand-in for U12's server task at \AGMessage\Server: LocalService, its own SID (Unrestricted), only
 *            SeChangeNotifyPrivilege, the task's settings; its action is this file's probe-server, which reads the token
 *            and the profile, hears UDP 9928, starts the bundle's watchdog under the installed channel (AGM_RUNS=task, the
 *            folders) and a quick tunnel as the server starts one; a firewall rule by program, protocol and port
 *       R7   while that server serves: its folder pipe's access list, as libuv made it under the task's token, and
 *            whether a client reaches it through SMB at this machine's own names
 *       R12  two stand-in tasks with the server task's settings (RestartOnFailure 3 × 1 min), each with a folder of its
 *            own: one whose action exits 1, measured and removed, then one whose action exits 0
 *       R13  a stand-in control task as SYSTEM reading GitHub's release answer for the newest published tag
 *     Each reading is taken on its own: one that fails is written with why, and the rest are taken. The record is
 *     written before the first reading and after each, and marked whole at the end, so a lane cut short still says what
 *     it took; a reading not begun within the lane's own bound (BUDGET_MS) is written as not run, so the job never
 *     reaches its timeout.
 *     It is CI's alone: it refuses a machine that is not a GitHub-hosted runner, a work folder it did not make, and a
 *     \AGMessage\Server task it did not make, before anything is made or removed. Exit 0 once the record is written, 2
 *     when it cannot be, 64 for a word it does not know, a run off Windows or a machine it refuses.
 *   node readings-take.js probe-server <dir> | probe-exit <dir> | probe-release <dir>
 *       what a stand-in task runs, from the copy the lane makes of this file (it requires Node's own modules only)
 *
 * Invariants: every program is run by its absolute path, never a bare name, with an argument array and no shell; no
 * secret is written to the record (the admin token the stand-in server makes is taken out of any output kept, by value
 * and by its shape; a quick tunnel's address is not kept); every stand-in task and the firewall rule are removed at the
 * end, whatever failed; nothing is made or removed on a machine the lane refuses.
 */
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
/** The lane's own bound: a reading not begun within it is not run, so every reading's own waits end inside the step's. */
const BUDGET_MS = 20 * 60 * 1000;
const SERVER_TASK = '\\AGMessage\\Server';
/** The stand-in server task's description: how the lane tells a task it made from the installed node's. */
const STAND_IN = 'AGMessage readings: a stand-in for the server task';
const RESTART_TASKS = { nonZero: '\\AGMessage-Readings\\RestartNonZero', zero: '\\AGMessage-Readings\\RestartZero' };
const RELEASE_TASK = '\\AGMessage-Readings\\Release';
/** The file the lane writes in its work folder first: a folder without it is not the lane's to remove. */
const WORK_MARK = '.agm-readings-work';
const RULE = 'AGMessage-readings-R4';
const LOCAL_SERVICE = 'S-1-5-19';
const SYSTEM = 'S-1-5-18';
/** The quick tunnel's address in cloudflared's output (server.js reads it the same way). */
const TRYCF = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DRIVE_PATH = /^[A-Za-z]:\\/;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const now = () => performance.now();

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

/** The one folder every member of a bundle lies in (its name carries the build), or a refusal. */
function topFolder(entries) {
  const tops = new Set(entries.map((e) => memberParts(e.name)[0]));
  if (tops.size !== 1 || entries.some((e) => !e.dir && memberParts(e.name).length < 2)) throw new Error('the bundle is not one folder (' + tops.size + ' at its top)');
  return [...tops][0];
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
 * when `restart`), and one action. Written as UTF-16 with its mark, as schtasks reads it.
 */
function taskXml({ description, sid, sidType = '', privileges = [], restart = false, command, args = [], cwd }) {
  const principal = [
    '      <UserId>' + xmlText(sid) + '</UserId>',
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
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    ...(restart ? ['    <RestartOnFailure>', '      <Interval>PT1M</Interval>', '      <Count>3</Count>', '    </RestartOnFailure>'] : []),
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

/** U12's server task, as this build can stand in for it: LocalService under its own SID, SeChangeNotifyPrivilege only. */
const SERVER_PRINCIPAL = { sid: LOCAL_SERVICE, sidType: 'Unrestricted', privileges: ['SeChangeNotifyPrivilege'] };

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

/** One GET of `url` within `ms`: {status, headers, body} (at most `max` bytes), or {error}. */
function get(url, { ms = 15000, max = 4 * 1024 * 1024, headers = {} } = {}) {
  return new Promise((resolve) => {
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

/** `/api/health` at loopback until it answers or `ms` passes: {ok, ms, build}. */
async function waitHealth(port, { ms = 30000, every = 250 } = {}) {
  const t0 = now();
  while (now() - t0 < ms) {
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
/** Whether a client reaches `pipePath` within `ms`: {connected, error}. */
function pipeReach(pipePath, { ms = 15000 } = {}) {
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
/** A program run by its absolute path, from its own folder, within `ms`: {code, out, err}. */
function run(file, args, { ms = 60000, env, cwd = path.dirname(file), input } = {}) {
  const r = childProcess.spawnSync(file, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: ms, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') + (r.error ? String(r.error.code || r.error.message) : '') };
}

/** probe-exit: one start recorded, then the exit code its folder names (1 unless `code` says otherwise). */
function probeExit(dir) {
  fs.appendFileSync(path.join(dir, 'starts.log'), new Date().toISOString() + '\n');
  let named = '';
  try { named = fs.readFileSync(path.join(dir, 'code'), 'utf8').trim(); } catch { /* no code named: a failure, as a crash would be */ }
  return /^\d{1,3}$/.test(named) ? Number(named) : 1;
}

/** probe-release: GitHub's answer for the plan's address, as SYSTEM reads it. */
async function probeRelease(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  writeJson(path.join(dir, 'answer.json'), { ...(await readRelease(plan.url)), user: os.userInfo().username });
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

async function until(test, ms, every = 500) {
  const t0 = now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (now() - t0 >= ms) return null;
    await sleep(every);
  }
}

/**
 * What PowerShell is asked, each a fixed script that answers one line of JSON; what it reads is named in its environment
 * (AGM_READ_PATHS, AGM_READ_PIPES, separated by `|`), never written into the script.
 *   signatures  Windows' verdict on each file's Authenticode signature, and its signer
 *   pipes       each named pipe's security descriptor, as SDDL (owner, group and access list), read through .NET, else
 *               through Get-Acl, else the reasons both gave
 *   defender    Defender's real-time monitoring, its scanning on access, its mode, and the paths it excludes
 */
const SCRIPTS = {
  signatures: String.raw`$ErrorActionPreference = 'Stop'; $out = @(); foreach ($p in ($env:AGM_READ_PATHS -split '\|')) { $s = Get-AuthenticodeSignature -LiteralPath $p; $out += @{ path = $p; status = [string]$s.Status; message = [string]$s.StatusMessage; signer = $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }); timestamped = [bool]$s.TimeStamperCertificate } }; ConvertTo-Json -InputObject $out -Depth 4 -Compress`,
  pipes: String.raw`$ErrorActionPreference = 'Stop'; $out = @(); foreach ($n in ($env:AGM_READ_PIPES -split '\|')) { $p = '\\.\pipe\' + $n; try { $out += @{ name = $n; sddl = [System.IO.Directory]::GetAccessControl($p).GetSecurityDescriptorSddlForm('All') } } catch { $first = [string]$_.Exception.Message; try { $out += @{ name = $n; sddl = [string](Get-Acl -LiteralPath $p).Sddl } } catch { $out += @{ name = $n; error = ($first + '; ' + [string]$_.Exception.Message) } } } }; ConvertTo-Json -InputObject $out -Depth 4 -Compress`,
  defender: String.raw`$ErrorActionPreference = 'Stop'; $s = Get-MpComputerStatus; $p = Get-MpPreference; ConvertTo-Json -InputObject @{ realtime = [bool]$s.RealTimeProtectionEnabled; onAccess = [bool]$s.OnAccessProtectionEnabled; antivirus = [bool]$s.AntivirusEnabled; service = [bool]$s.AMServiceEnabled; mode = [string]$s.AMRunningMode; exclusions = @($p.ExclusionPath | Where-Object { $_ }) } -Compress`,
};

/** The lane's hands on Windows, each program by its absolute path in `sys`: schtasks, PowerShell, a task registered and removed. */
function lane(work, sys) {
  const exe = (name) => path.win32.join(sys, name);
  const schtasks = (args, ms) => run(exe('schtasks.exe'), args, { ms });
  const ps = (script, extra = {}) => {
    const r = run(path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { ms: 60000, env: { ...process.env, PSModulePath: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules'), ...extra } });
    if (r.code !== 0) throw new Error('powershell.exe ended with ' + r.code + ': ' + r.err.trim().slice(0, 300));
    return JSON.parse(r.out.trim());
  };
  const register = (name, xml) => {
    const file = path.join(work, name.replace(/\W+/g, '-') + '.xml');
    fs.writeFileSync(file, utf16(xml));
    const r = schtasks(['/Create', '/TN', name, '/XML', file, '/F']);
    if (r.code !== 0) throw new Error('schtasks could not register ' + name + ': ' + (r.err || r.out).trim().slice(0, 300));
  };
  const lastResult = (name) => {
    const r = schtasks(['/Query', '/TN', name, '/FO', 'LIST', '/V']);
    const m = /^Last Result:\s*(-?\d+)/m.exec(r.out);
    return m ? Number(m[1]) : null;
  };
  const remove = (name) => { schtasks(['/End', '/TN', name]); schtasks(['/Delete', '/TN', name, '/F']); };
  /** A task's definition as schtasks shows it: {code, out}, code non-zero when there is no such task. */
  const query = (name) => schtasks(['/Query', '/TN', name, '/XML']);
  return { exe, schtasks, ps, register, lastResult, remove, query };
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
 * task whose action exits 0 is run and watched for `zeroMs`. {tasks, nonZero, zero}, each {starts, waitedMs, lastResult}.
 */
async function takeR12(L, { node, self, dir, cwd }, { nonZeroMs = 150000, zeroMs = 90000, every = 1000 } = {}) {
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
  const zero = await phase(RESTART_TASKS.zero, 0, zeroMs);
  return { tasks: [RESTART_TASKS.nonZero, RESTART_TASKS.zero], nonZero, zero };
}

async function take(o) {
  if (process.platform !== 'win32') { console.error('readings-take: the readings are Windows\'; nothing was taken'); return 64; }
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
  const t0 = now();
  const raw = {
    v: 1,
    at: new Date().toISOString(),
    complete: false,
    runner: { os: os.type() + ' ' + os.release(), image: [env.ImageOS, env.ImageVersion].filter(Boolean).join(' ') || 'unknown', arch: os.arch(), cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
    build: null,
    defender: null,
    defenderEnd: null,
    readings: {},
  };
  try { raw.defender = readJson(o.defender); } catch (e) { raw.defender = null; console.error('readings-take: no Defender record (' + e.message + ')'); }
  const out = path.resolve(o.out);
  const save = () => { fs.mkdirSync(path.dirname(out), { recursive: true }); writeJson(out, raw); };
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.mkdirSync(path.join(work, 'lane'), { recursive: true });
  fs.writeFileSync(path.join(work, WORK_MARK), 'The Windows readings lane\'s work folder: removed and made again by each run of tools/readings-take.js.\n');
  // The record is there before the first reading begins, so a lane cut short in it still has Defender's record judged.
  try { save(); } catch (e) { console.error('readings-take: the record could not be written before the readings (' + e.message + ')'); }
  // The stand-in tasks run as LocalService: it may read the payload and this file, and write its own folders.
  const granted = run(L.exe('icacls.exe'), [work, '/grant', '*' + LOCAL_SERVICE + ':(OI)(CI)M']);
  if (granted.code !== 0) console.error('readings-take: LocalService was not granted the work folder: ' + granted.out + granted.err);
  const self = path.join(work, 'lane', 'readings-take.js');
  fs.copyFileSync(__filename, self);
  // Every reading but R2 reads this build's payload, laid once into a folder of its own.
  const root = path.join(work, 'payload', 'AGMessage');
  const node = path.join(root, 'node', 'node.exe');
  let laid = false;
  /** One reading, on its own and within the lane's bound; the record written after it, so a lane cut short says what it took. */
  const reading = async (id, fn) => {
    const r = now() - t0 > BUDGET_MS ? { skipped: 'the lane\'s own bound of ' + BUDGET_MS / 60000 + ' min was reached before it began' } : await guarded(fn);
    raw.readings[id] = r;
    console.log('readings-take: ' + id + ' ' + (r && r.error ? 'failed: ' + r.error : r && r.skipped ? 'not run: ' + r.skipped : 'taken'));
    try { save(); } catch (e) { console.error('readings-take: the record could not be written after ' + id + ' (' + e.message + ')'); }
  };
  const needsPayload = () => { if (!laid) throw new Error('the payload was not laid'); };

  await reading('R2', () => {
    const dest = path.join(work, 'r2', 'AGMessage');
    const first = layOut(o.zip, dest, entries, { strip: 1 });
    let previous = null;
    let overWhy = '';
    if (o.previous) {
      try { previous = { entries: zipEntries(o.previous) }; previous.top = topFolder(previous.entries); } catch (e) { previous = null; overWhy = 'its zip could not be read: ' + e.message; }
    } else overWhy = 'none was given';
    const over = previous ? (/^AGMessage-Portable-Windows-(\d+\.\d+\.\d+)\b/.exec(previous.top) || [])[1] : '';
    const rounds = [];
    for (let i = 0; i < R2_ROUNDS; i++) {
      if (previous) {
        // The previous payload laid whole into an empty folder first (not measured), then this build over it.
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        layOut(o.previous, dest, previous.entries, { strip: 1 });
      }
      rounds.push(Math.round(layOut(o.zip, dest, entries, { strip: 1 }).ms));
    }
    fs.rmSync(path.join(work, 'r2'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { files: first.files, bytes: first.bytes, emptyMs: Math.round(first.ms), rounds, over: previous ? (over ? 'v' + over : previous.top) : '', overWhy, how: 'each file inflated to a name of its own beside it, then renamed over the one before' };
  });
  try {
    layOut(o.zip, root, entries, { strip: 1 });
    laid = true;
  } catch (e) { console.error('readings-take: the payload was not laid (' + e.message + ')'); }
  try { raw.build = readJson(path.join(root, 'app', 'build.json')); } catch { raw.build = null; /* a bundle without its stamp: the readings name no build */ }

  await reading('R10', () => {
    const rounds = [];
    for (let i = 0; i < R10_ROUNDS; i++) {
      const dest = path.join(os.tmpdir(), 'agm-r10-' + crypto.randomBytes(6).toString('hex'), 'node.exe');
      const x = extractOne(o.zip, '/node/node.exe', dest, entries);
      const t1 = now();
      const r = run(dest, ['-e', '0'], { ms: 120000 });
      const runMs = now() - t1;
      rounds.push({ extractMs: Math.round(x.ms), runMs: Math.round(runMs), totalMs: Math.round(x.ms + runMs), code: r.code, ...(r.code === 0 ? {} : { err: r.err.trim().slice(0, 200) }) });
      fs.rmSync(path.dirname(dest), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    return { rounds, where: os.tmpdir() };
  });

  await reading('R5', () => {
    needsPayload();
    const files = L.ps(SCRIPTS.signatures, { AGM_READ_PATHS: [node, path.join(root, 'bin', 'cloudflared.exe')].join('|') });
    return { files: Array.isArray(files) ? files : [files], installer: null };
  });

  await reading('R8', () => {
    const places = {};
    for (const where of ['C:\\', env.ProgramData || 'C:\\ProgramData']) {
      const file = path.join(work, 'acl-' + crypto.randomBytes(4).toString('hex') + '.txt');
      const saved = run(L.exe('icacls.exe'), [where, '/save', file]);
      const shown = run(L.exe('icacls.exe'), [where]);
      let sddl = '';
      try { sddl = sddlOfSave(fs.readFileSync(file)); } catch { /* not saved: the error below says why */ }
      places[where] = sddl ? { sddl, icacls: shown.out.slice(0, 8192) } : { error: 'icacls /save ended with ' + saved.code + ': ' + (saved.err || saved.out).trim().slice(0, 300) };
    }
    return { places };
  });

  const r4dir = path.join(work, 'r4');
  try {
    let pipes = null;
    await reading('R4', async () => {
      needsPayload();
      const folders = {};
      for (const k of ['data', 'uploads', 'keys', 'token']) { folders[k] = path.join(work, 'task', k); fs.mkdirSync(folders[k], { recursive: true }); }
      fs.mkdirSync(r4dir, { recursive: true });
      writeJson(path.join(r4dir, 'plan.json'), { supervise: path.join(root, 'app', 'supervise.js'), cloudflared: path.join(root, 'bin', 'cloudflared.exe'), port: o.port, folders });
      L.register(SERVER_TASK, taskXml({ description: STAND_IN, ...SERVER_PRINCIPAL, restart: true, command: node, args: [self, 'probe-server', r4dir], cwd: path.dirname(self) }));
      const showsid = L.schtasks(['/ShowSid', '/TN', SERVER_TASK]).out.trim();
      const added = run(L.exe('netsh.exe'), ['advfirewall', 'firewall', 'add', 'rule', 'name=' + RULE, 'dir=in', 'action=allow', 'program=' + node, 'protocol=TCP', 'localport=' + o.port, 'remoteip=localsubnet', 'profile=private,domain', 'enable=yes']);
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
    });
    await reading('R7', () => pipes || { skipped: 'the stand-in server did not serve (R4 says why), so no pipe of its own was there to read' });
  } finally {
    L.remove(SERVER_TASK);
    run(L.exe('netsh.exe'), ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + RULE]);
  }

  await reading('R12', () => {
    needsPayload();
    return takeR12(L, { node, self, dir: path.join(work, 'r12'), cwd: path.dirname(self) });
  });

  try {
    await reading('R13', async () => {
      needsPayload();
      if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '') || !/^v\d+\.\d+\.\d+$/.test(o.tag || '')) return { skipped: 'no published release was named to read (' + (o.tag || 'none') + ')' };
      const dir = path.join(work, 'r13');
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, 'plan.json'), { url: 'https://api.github.com/repos/' + o.repo + '/releases/tags/' + o.tag });
      L.register(RELEASE_TASK, taskXml({ description: 'AGMessage readings: GitHub\'s release answer, read as SYSTEM', sid: SYSTEM, command: node, args: [self, 'probe-release', dir], cwd: path.dirname(self) }));
      const ran = L.schtasks(['/Run', '/TN', RELEASE_TASK]);
      if (ran.code !== 0) throw new Error('schtasks could not run the stand-in: ' + (ran.err || ran.out).trim().slice(0, 300));
      const answer = await until(() => { try { return readJson(path.join(dir, 'answer.json')); } catch { return null; /* not written yet */ } }, 60000);
      if (!answer) throw new Error('the SYSTEM task wrote no answer within 60 s (last result ' + L.lastResult(RELEASE_TASK) + ')');
      return { tag: o.tag, ...answer };
    });
  } finally { L.remove(RELEASE_TASK); }

  raw.defenderEnd = await guarded(() => L.ps(SCRIPTS.defender));
  raw.complete = true;
  try { save(); } catch (e) { console.error('readings-take: the record could not be written (' + e.message + ')'); return 2; }
  console.log('readings-take: written to ' + o.out + ' in ' + Math.round((now() - t0) / 1000) + ' s');
  return 0;
}

/** The command line read as {verb, flags, rest}; a flag this does not know refused. */
function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const known = ['--zip', '--previous', '--defender', '--out', '--work', '--port', '--repo', '--tag'];
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      if (!known.includes(rest[i]) || i + 1 >= rest.length) return { error: 'readings-take: ' + rest[i] + ' is not a word it knows, or has no value' };
      flags[rest[i].slice(2)] = rest[++i];
    } else positional.push(rest[i]);
  }
  return { verb, flags, positional };
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.error) { console.error(a.error); return 64; }
  if (a.verb === 'probe-exit' && a.positional.length === 1) return probeExit(a.positional[0]);
  if (a.verb === 'probe-release' && a.positional.length === 1) return probeRelease(a.positional[0]);
  if (a.verb === 'probe-server' && a.positional.length === 1) return probeServer(a.positional[0]);
  if (a.verb === 'take' && !a.positional.length && a.flags.zip && a.flags.defender && a.flags.out) {
    const port = Number(a.flags.port || 3124);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('readings-take: --port is a port from 1024 to 65535'); return 64; }
    return take({ zip: a.flags.zip, previous: a.flags.previous || '', defender: a.flags.defender, out: a.flags.out, work: a.flags.work || 'C:\\agm-readings', port, repo: a.flags.repo || '', tag: a.flags.tag || '' });
  }
  console.error('readings-take: take --zip <bundle.zip> --defender <defender.json> --out <raw.json> [--previous <zip>] [--work <folder>] [--port <n>] [--repo <owner/name> --tag <vX.Y.Z>] | probe-server <dir> | probe-exit <dir> | probe-release <dir>');
  return 64;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error('readings-take: ' + ((e && e.stack) || e)); process.exitCode = 2; });
}

module.exports = {
  zipEntries, memberParts, topFolder, layOut, extractOne, taskXml, winArg, utf16, SERVER_PRINCIPAL, SCRIPTS, lane, system32,
  snapshot, snapshotDiff, udpHeard, waitHealth, quickTunnel, readRelease, probeExit, parseArgs, main, TRYCF,
  sddlOfSave, pipeReach, keepTail, tokenIn, withoutSecrets, placeRefusal, takeR12, take,
  SERVER_TASK, STAND_IN, RESTART_TASKS, WORK_MARK, BUDGET_MS,
};
