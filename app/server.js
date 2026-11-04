/**
 * AGMessage — inter-team messaging for AGMs and board meetings: the Board on stage, the backstage team behind it.
 *
 * One Node.js process:
 *   - Serves the web client (join page, chat app, admin) from /public with a strict CSP
 *   - Real-time chat over Socket.io. Every change is an operation with a per-room sequence number:
 *     appended to an on-disk log, broadcast with its seq, and replayable — a client that drops off
 *     for a moment resumes with just what it missed (see lib/store.js)
 *   - Uploads: allow-listed types, checked by content, only from people in a room, served so a
 *     file can never run script in the app
 *   - Identities are issued and signed by the server; roles can be locked to invite links
 *   - Claude drafts (research replies, minutes, action-prompt options) — always a draft for a person
 *   - A node of the show network: live Stagewatch timer for the board, "send to stage" to the
 *     confidence monitor, discovery of Stagewatch and Patterns (see lib/nodes.js)
 *
 * Seats (their role words): "board" (On stage), "research" (Backstage), "observer" (Observer, read-only).
 * Listens on 0.0.0.0 for the venue network; remote access via the built-in Cloudflare tunnel.
 */
'use strict';

// The server loads only what it ships. ws asks for its optional native helpers (bufferutil, utf-8-validate) unless these
// say not to, and a require that app\node_modules cannot answer walks every folder above app\ up to the drive's root,
// where a module any account may plant (C:\node_modules) would be loaded into AGMessage. Set before the first require,
// so a server started without its watchdog (which sets them for its child too) never asks.
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { customAlphabet } = require('./lib/ids');

const { RoomStore } = require('./lib/store');
const guard = require('./lib/guard');
const ai = require('./lib/ai');
const nodes = require('./lib/nodes');
const resilience = require('./lib/resilience');
const secretbox = require('./lib/secretbox');
const { buildContext, hallBrief } = require('./lib/context');
const tlsmod = require('./lib/tls');
const { Accounts, Sessions, TokenSessions } = require('./lib/accounts');
const { AuditLog, keysFrom, wordsWithList } = require('./lib/audit');
const { Exporter } = require('./lib/auditexport');
const { Archiver } = require('./lib/auditarchive');
const rbac = require('./lib/rbac');
const { mountAccounts } = require('./lib/http-accounts');
const board = require('./lib/board');
const stagelines = require('./lib/stagelines');
const peerlinks = require('./lib/peerlinks');
const deskresults = require('./lib/deskresults');
const ops = require('./lib/ops');
const { gateOf, contexts, WORDS: GATE_WORDS } = require('./lib/gate');
const roomVerbs = require('./lib/handlers/rooms');
const takeVerbs = require('./lib/handlers/takes');
const { Latest, sendEach } = require('./lib/latest');
const { Displays, cleanContent, describe: describeContent } = require('./lib/displays');
const { Pages } = require('./lib/pages');
const readings = require('./lib/peaks');
const startup = require('./lib/startup');
const laptop = require('./lib/laptop');
const power = require('./lib/power');
const dataformat = require('./lib/dataformat');
const laststop = require('./lib/laststop');
const tunnelend = require('./lib/tunnelend');
const busy = require('./lib/busy');
const machinewire = require('./lib/machinewire');
const { monitorEventLoopDelay } = require('perf_hooks');

const { BUILD, parseBuild, compareBuilds } = require('./lib/version');
const VERSION = BUILD.version;
// The channel this copy runs in (AGM_RUNS: the portable folder, or the installed node's task) and, for the task, its three
// folders: checked before anything is read or written. One that cannot be used stops the start with code 3 and its words.
/** This copy cannot start, found before it holds or has written anything: its words on the console, and code 3. */
function cannotStartYet(words) {
  console.error('\n  AGMessage cannot start: ' + words + '\n');
  process.exit(resilience.EXIT.CONFIG);
}
const CHANNEL = startup.channelOf(process.env, { programDir: path.dirname(__dirname) });
if (CHANNEL.problem) cannotStartYet(CHANNEL.problem);
const RUNS = CHANNEL.runs;
// The machine key is read now and made, when there is none, only once this copy holds its data folder (`firstWrites`).
secretbox.deferMaking();
const PORT = parseInt(process.env.PORT || '3023', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPLOAD_DIR = process.env.AGM_UPLOAD_DIR || path.join(__dirname, 'uploads');
const envNumber = (name, dflt) => { const v = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : dflt; };
// Files pause while the disk has less than this free, so the room logs, the audit log and the saves always have room.
const UPLOAD_MIN_FREE = envNumber('AGM_UPLOAD_MIN_FREE', 1024 ** 3);
// A file uploaded but not posted within this long is removed (the page posts it when its sender presses Send).
const UPLOAD_ORPHAN_MS = envNumber('AGM_UPLOAD_ORPHAN_MS', 60 * 60_000);
// The tunnel's places: at most this many sockets through it at once, half of them at most from one network. The cause is
// Cloudflare's 200 in-flight requests per Quick Tunnel, past which it answers 429 and AGMessage never hears of it: on the
// cautious reading that an open page holds one for as long as it lives (not measured: reading 0's tunnel row says), 150
// keeps 50 for page loads, files and uploads (docs/DESIGN.md, "The internet link"). A tunnel socket that within
// TUNNEL_JOIN_MS has neither joined a room nor carries an account, the admin's token or a screen's token gives its place
// back.
const TUNNEL_MAX = envNumber('AGM_TUNNEL_MAX', 150);
const TUNNEL_JOIN_MS = envNumber('AGM_TUNNEL_JOIN_MS', 20_000);
// How long Cloudflare has to give the tunnel's address after cloudflared starts.
const TUNNEL_URL_MS = envNumber('AGM_TUNNEL_URL_MS', 30_000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.AGM_DATA_DIR || path.join(__dirname, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
// The data folder's format (lib/dataformat.js), read before anything else of it: a folder a build of a higher format
// wrote, or whose marker cannot be read, stops the start with code 3 and its words, in either channel, nothing written.
// It is read again once this copy holds the folder (`firstWrites`), and what that start found and did is health's
// `format` and "This laptop"'s.
const formatRefused = dataformat.refusal(dataformat.read(DATA_DIR), { dataDir: DATA_DIR, build: BUILD.full });
if (formatRefused) cannotStartYet(formatRefused);
let formatNow = null;
// Nothing is written until this copy holds its data folder and its port (`holdDataFolder`, at the end of this file): every
// store is read now, and the folders, the keys, the certificate, the server secret and the saves asked meanwhile are made
// then (`firstWrites`). A copy refused at the folder or the port has written nothing, in the data folder or the key folder.
let serving = false;   // this copy holds its data folder and its port: from then on it writes

// The server secret: read now, made once the folder is held when there is no file. One that cannot be read is never
// replaced: this run signs with a secret of its own (the installed node stops instead), and the file is left as it is.
const secretFound = guard.readSecret(DATA_DIR);
const SECRET = secretFound.secret;

// The laptop's admin token: login only from the host laptop (never through the tunnel). A server its watchdog runs
// (AGM_SUPERVISED) is handed the watchdog's, the same for every restart, and never says it: the watchdog does, where a
// person sits (`sayToken`). A server run alone makes its own and prints it in its banner.
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || crypto.randomBytes(8).toString('hex')).toLowerCase();
const SUPERVISED = !!process.env.AGM_SUPERVISED;
// The watchdog reads this server's output line by line (supervise.js), and so is told where the Token line goes.
const TEED = process.env.AGM_TEED === '1';

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
// A side room's key: an address, never a credential (no lookup or join takes one from a guest), 8 characters of the same
// alphabet, so it passes the store's CODE_RE and is never the 6 a guest types.
const makeRoomKey = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);
const makeMessageId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
const ROLES = ['board', 'research', 'observer'];
// The seats in the lines the server writes into a hall, in the words every page shows for them.
const SEAT = Object.freeze({ board: 'On stage', research: 'Backstage', observer: 'Observer' });
const JOINED = Object.freeze({ board: 'joined On stage', research: 'joined Backstage', observer: 'joined as an observer' });
// A side room has no stage: its backstage seat is a Member's, and no seat there is On stage.
const SEAT_SIDE = Object.freeze({ research: 'Member', observer: 'Observer' });
const JOINED_SIDE = Object.freeze({ research: 'joined as a Member', observer: 'joined as an observer' });
/** A seat in a room's words: a Main room's (On stage, Backstage, Observer), or a side room's (Member, Observer). */
const seatWords = (room, role) => (store.isMain(room) ? SEAT[role] : SEAT_SIDE[role]) || SEAT[role];
const joinedWords = (room, role) => (store.isMain(room) ? JOINED[role] : JOINED_SIDE[role]) || JOINED[role];
const ON_STAGE_IN_MAIN = 'On stage seats are in the hall\'s Main room.';
// What may be forwarded into another hall: messages that stand on their own there (allow-list; a new type is refused).
const FORWARDABLE = new Set(['text', 'file', 'action']);
// What one person's pages keep in step (their own devices, and the admin's support view of them): each key a page
// applies, with the reader that takes its value by type and returns the value relayed, or undefined to relay nothing.
const USER_STATE = {
  theme: (v) => (v === 'light' || v === 'dark' ? v : undefined),
  zoom: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  stageCollapsed: (v) => (typeof v === 'boolean' ? v : undefined),
  split: (v) => (v && typeof v === 'object' && typeof v.pct === 'number' && v.pct >= 0 && v.pct <= 100 && typeof v.vertical === 'boolean' ? { pct: v.pct, vertical: v.vertical } : undefined),
  doc: (v) => (v === null ? null : v && typeof v === 'object' && typeof v.messageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.messageId) ? { messageId: v.messageId } : undefined),
};
/** A page's `userState:push`, as it is relayed: `{key, value}` rebuilt from a known key and a value of its type, or null. */
function userStateOf(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string' || !Object.hasOwn(USER_STATE, payload.key)) return null;
  const value = USER_STATE[payload.key](payload.value);
  return value === undefined ? null : { key: payload.key, value };
}

// ---------------------------------------------------------------- settings (AI key, Stagewatch link)
// Saved through one write lane (tmp -> fsync -> rename, a .bak of the last whole file); keys sealed at rest
// (lib/secretbox.js) so a copied folder carries none.
const settingsLane = new resilience.WriteLane(SETTINGS_PATH, { delayMs: 100, keepBak: true, mode: 0o600 });
/**
 * The settings as read: {data, unread, words, fix}. Only ENOENT says the file is not there. A settings.json that cannot be
 * read (EBUSY, EACCES) is `unread`, whatever its .bak holds: the .bak is a save behind, and a token or link saved since is
 * only in the file. Its .bak is read only for a file that is not there or does not parse, under the same rule. Unread
 * settings hold the sealed keys and links this run cannot see: nothing is saved over them, a setting changed is refused
 * with `words`, and no context token answers (one made now would be saved over the real one). `fix` is what a person does.
 */
function loadSettings() {
  const r = resilience.readJsonWhole(SETTINGS_PATH);
  const [file, bak] = r.codes;
  const again = 'Start AGMessage again once nothing else holds it (an antivirus or a backup may).';
  if (file && file !== 'ENOENT') return { data: {}, unread: file, words: SETTINGS_PATH + ' could not be read (' + file + ')', fix: again };
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) return { data: r.data, unread: '', words: '', fix: '' };
  if (bak && bak !== 'ENOENT') return { data: {}, unread: bak, words: SETTINGS_PATH + ' is ' + (file ? 'missing' : 'not whole') + ', and its .bak could not be read (' + bak + ')', fix: again };
  // Not there, and its .bak not there or holding nothing AGMessage wrote: there is nothing to write over, so a start begins anew.
  if (file === 'ENOENT') return { data: {}, unread: '', words: '', fix: '' };
  return { data: {}, unread: 'not JSON', words: SETTINGS_PATH + ' holds no settings AGMessage can read, nor does its .bak', fix: 'Put back a copy of it, or move it aside and start AGMessage again to begin with new settings (its links and keys set again).' };
}
const settingsRead = loadSettings();
const settings = settingsRead.data;
let settingsDue = false;   // a save asked before this copy held its folder: made once it does
function saveSettings() {
  if (settingsRead.unread) return;
  if (!serving) { settingsDue = true; return; }
  settingsLane.save(() => JSON.stringify(settings, null, 2));
}
/**
 * One-time migration from 0.2: keys stored in clear become sealed ones, in a run that has its machine key (a run without
 * one leaves them as they are for the next). Asked when the settings are read, and again once a key missing then is made.
 * True when it sealed one.
 */
function migrateClearKeys() {
  let sealed = false;
  for (const [plain, kept] of [['aiKey', 'aiKeySealed'], ['stagewatchKey', 'stagewatchKeySealed']]) {
    if (typeof settings[plain] === 'string' && secretbox.hasKey()) {
      if (settings[plain]) settings[kept] = secretbox.seal(settings[plain]);
      delete settings[plain];
      sealed = true;
    }
  }
  if (sealed) saveSettings();
  return sealed;
}
migrateClearKeys();
// This install's id on the show network (Show Bus §2): stable, so a renamed AGMessage is still the same node.
if (!/^[0-9a-f]{8}$/.test(settings.nodeId || '')) { settings.nodeId = crypto.randomBytes(4).toString('hex'); saveSettings(); }
const aiKey = () => process.env.ANTHROPIC_API_KEY || secretbox.open(settings.aiKeySealed) || '';
const stagewatchKey = () => secretbox.open(settings.stagewatchKeySealed) || '';
// A read-only token other nodes use for GET /api/context (shown on the admin page), made only when none is saved. A run
// without its machine key keeps a new one in memory for this run, and leaves the sealed one for the next.
let contextTokenThisRun = '';
/**
 * Why no context token answers this run, in words, or '': a saved token that does not open with this machine's key is
 * kept, never replaced by a new one (the admin's New token makes one), and so are unread settings. Context reads with a
 * token are refused with these words meanwhile.
 */
function contextTokenProblem() {
  if (settingsRead.unread) return 'This AGMessage could not read its settings (' + settingsRead.unread + '), so no context token answers this run. ' + settingsRead.fix;
  const stored = settings.contextTokenSealed;
  if (typeof stored !== 'string' || !stored || !secretbox.hasKey() || secretbox.open(stored)) return '';
  return 'This AGMessage\'s context token does not open with its laptop\'s machine key, so no context token answers. Its admin makes a new one: New token, on the admin page.';
}
function contextToken() {
  if (contextTokenProblem()) return '';
  const t = secretbox.open(settings.contextTokenSealed);
  if (t) return t;
  const fresh = contextTokenThisRun || 'agn_' + crypto.randomBytes(18).toString('base64url');
  if (!secretbox.hasKey()) return (contextTokenThisRun = fresh);
  settings.contextTokenSealed = secretbox.seal(fresh);
  saveSettings();
  return fresh;
}
/** Why a setting changed now cannot be saved: the settings could not be read, and nothing is saved over them. '' when it can. */
const settingsUnsaved = () => (settingsRead.unread ? 'Not saved: ' + settingsRead.words + ', so this run saves no setting over it. ' + settingsRead.fix : '');
/** Why a key or token typed now cannot be saved: this run has no machine key to seal it with. '' when it can. */
const unsealable = () => { const p = secretbox.keyProblem(); return p ? 'Not saved: this run has no machine key (' + p.code + '), so nothing can be sealed. ' + p.words.charAt(0).toUpperCase() + p.words.slice(1) + '.' : ''; };

// ---------------------------------------------------------------- accounts, sessions, the audit log
// Individual logins beside the guest codes (lib/accounts.js, lib/rbac.js); every action that matters is in the
// audit log, chained with a key derived from this machine's key (lib/audit.js), its records kept beside that key, outside
// the data folder. The host laptop's admin token stays as the way in before any account exists.
const accounts = new Accounts(path.join(DATA_DIR, 'accounts.json'));
const sessions = new Sessions(path.join(DATA_DIR, 'sessions.json'), accounts);
// The admin token's sign-ins survive a watchdog restart (the supervisor hands every restart the same token) and end
// when AGMessage starts again with a new one: they are kept under a keyed hash of the token.
const tokenSessions = new TokenSessions(path.join(DATA_DIR, 'admin-sessions.json'), guard.mac(SECRET, 'admin-token:' + ADMIN_TOKEN, 43));
const audit = new AuditLog(path.join(DATA_DIR, 'audit.jsonl'), { keys: keysFrom(secretbox.derive), records: path.join(secretbox.keyDir(), 'audit'), version: VERSION });
const HOST_ACTOR = Object.freeze({ t: 'admin', id: 'host', name: 'AGMessage laptop' });
// What AGMessage does of itself, with no person's act: a start by another build, the internet link turned on again or ended.
const SYSTEM_ACTOR = Object.freeze({ t: 'system', id: '', name: '' });
// The fingerprint of the key this machine signs its exports with (lib/secretbox.js), '' in a run without the machine key.
// Only the fingerprint is kept: the key itself is derived again when an export signs, and dropped after. Read once the
// machine key is there (`firstWrites`), which a first start makes only after it holds its folder.
let AUDIT_SIGN_KEY = '';
// The signed export (lib/auditexport.js): one at a time, made as it streams, its verifier taken from app/verify.
const auditNode = () => ({ id: settings.nodeId, name: 'AGMessage ' + os.hostname(), version: VERSION, build: BUILD.full });
const auditExporter = new Exporter({ audit, signingKey: () => secretbox.signingKey(), verifyDir: path.join(__dirname, 'verify'), version: BUILD.full, node: auditNode });
// The split at an archive point (lib/auditarchive.js): never beside an export, and an export waits for it.
const auditArchiver = new Archiver({ audit, signingKey: () => secretbox.signingKey(), node: auditNode, exporter: auditExporter });
auditExporter.archiver = auditArchiver;
/** A count in an audit row's words: "1 file", "4 files". */
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
const displays = new Displays(path.join(DATA_DIR, 'displays.json'), { seal: secretbox.seal, open: secretbox.open });
// What people's pages are shown over their chat, their answers and guests' chat views (lib/pages.js): read now, written
// through its lane only once this copy holds its data folder (`firstWrites` calls `hold`).
const pages = new Pages(path.join(DATA_DIR, 'pages.json'));
// The results of approved show-desk proposals this AGMessage ran that Stagewatch has not taken yet (lib/deskresults.js):
// read now, written only by the desk loop, which runs once this copy holds the data folder and its port. In memory too:
// the tries (attempts, posts), when the next is due, the last answer, and the link's generation it was collected under
// (0 after a restart, so its first try reads the proposal back); `fresh` until its first post.
const DESK_RESULTS_PATH = path.join(DATA_DIR, 'desk-results.json');
const deskLane = new resilience.WriteLane(DESK_RESULTS_PATH, { delayMs: 100, keepBak: true, mode: 0o600 });
const deskResults = deskresults.readRecords(resilience.readJsonWithBak(DESK_RESULTS_PATH), settings.nodeId)
  .map((r) => ({ ...r, attempts: 0, posts: 0, nextAt: 0, lastStatus: 0, gen: 0, fresh: false }));
let deskLastAnswer = { status: null, at: null };   // the desk's last answer to a result post (health)
// The peaks a show day reaches (lib/peaks.js), the last 14 days, read back at start. Saved at the end of each 5 s window in
// which one rose (the health tick), through the lane's usual tenth of a second, latest wins, and at once by a stop or a
// crash the server catches: a hang the watchdog ends, or a power cut, loses at most the window it fell in. Written only
// once this copy holds its data folder (`serving`), as the desk loop's saves are.
const PEAKS_PATH = path.join(DATA_DIR, 'peaks.json');
const peaksLane = new resilience.WriteLane(PEAKS_PATH, { delayMs: 100, keepBak: true });
const peaks = new readings.Peaks().load(resilience.readJsonWithBak(PEAKS_PATH));
/** Ask the lane to save the peaks when one rose since the last save; true when it was asked. */
function savePeaks() {
  if (!serving || !peaks.dirty) return false;
  peaks.dirty = false;
  peaksLane.save(() => JSON.stringify(peaks.toJSON()));
  return true;
}
/**
 * Every store saved through a write lane, by the name health and the console give it. Every lane made in any file is
 * here, once, so a stop or a crash flushes them all: health's `saves.built` counts the lanes made and `saves.named` the
 * distinct lanes here, and a test holds both to this list.
 */
const saveLanes = () => [['settings', settingsLane], ['accounts', accounts.lane], ['sessions', sessions.lane], ['adminSessions', tokenSessions.lane], ['screens', displays.lane], ['pages', pages.lane], ['deskResults', deskLane], ['peaks', peaksLane], ['auditHead', audit.headLane]];
/**
 * Write the audit entries still waiting and the head that covers them first, then every lane, now (shutdown, a crash);
 * what still cannot be written is named on the console, and returned in words ([] when everything was written). The
 * audit's last appends are timed as they reach the disk, so the peaks are asked for after it.
 */
function flushLanes() {
  const unwritten = [];
  if (!audit.flush()) { console.error('  [audit] ' + audit.unwritten + ' entries could not be written: ' + audit.lastError); unwritten.push('the audit log'); }
  savePeaks();
  for (const [name, lane] of saveLanes()) if (!lane.flushSync()) { console.error('  [save] ' + name + ' could not be written: ' + lane.lastError); unwritten.push(name); }
  return unwritten;
}
/**
 * Everything this copy holds, saved in the stop's order (a stop, a crash): the audit log and the lanes first, small and
 * the ones a show cannot do without, then the snapshot of each hall that changed since its last one, and of no other, so
 * a stop at the largest hall's size still ends inside the watchdog's wait, then the peaks once more when those snapshots
 * raised the day's longest (`onCompact`, after the peaks' lane was written). Returns {unsaved, halls}: what could not be
 * saved, in words (a count of halls, never a code; [] when everything was), and how many halls were written.
 */
function saveAll() {
  const unsaved = flushLanes();
  const halls = store.compactDirty();
  // The halls any of whose rooms is left unwritten: a side room counts as its hall.
  const left = new Set(store.dirtyCodes().map((key) => store.room(key).hall)).size;
  if (left) unsaved.push(plural(left, 'hall'));
  if (savePeaks() && !peaksLane.flushSync() && !unsaved.includes('peaks')) {
    console.error('  [save] peaks could not be written: ' + peaksLane.lastError);
    unsaved.push('peaks');
  }
  return { unsaved, halls };
}

// ---------------------------------------------------------------- encrypted connections (Show Bus 1.2 §10)
// One certificate per install, kept beside the machine key (outside the app folder), private key sealed. The same port
// serves HTTP and HTTPS (lib/tls.js). AGM_TLS=0 turns HTTPS off (tests of the plain path, or a machine that can't).
// Read now; one there is none of is made, and one near its end renewed, once this copy holds its folder (`firstWrites`).
// One that cannot be read, or whose key does not open, turns HTTPS off this run and is left as it is.
let cert = null;
let tlsOff = '';   // why HTTPS is off this run, in words ('' while it is on, and when AGM_TLS=0 turned it off)
let tlsRenewWaited = false;   // a certificate due for renewal was not renewed at this start, which had no network address
const tlsFound = process.env.AGM_TLS === '0' ? null : tlsmod.readCertificate({ dir: secretbox.keyDir(), open: secretbox.open });
if (tlsFound && tlsFound.cert) cert = tlsFound.cert;
if (tlsFound && tlsFound.state === 'unusable') {
  const key = secretbox.keyState();
  tlsOff = (key.state === 'unusable' ? 'this run has no machine key (' + key.code + '), so ' + tlsFound.file + ' cannot be opened' : tlsFound.words) + '. It is left as it is';
}
const pins = new tlsmod.PinStore(settings.tlsPins && typeof settings.tlsPins === 'object' ? settings.tlsPins : {});
const isLoopback = (req) => { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; };
const isEncrypted = (req) => !!(req.socket && req.socket.encrypted);
/**
 * Why the certificate serves on unrenewed this run, in words true now, or '' when it does not: a start with no network
 * address leaves one due for renewal as it is, and New certificate (admin:renewCertificate) renews it once the laptop has
 * an address, as a start that has one does.
 */
function renewalWords() {
  if (!tlsRenewWaited || !cert) return '';
  return tlsmod.networkAddresses(lanNow()).length
    ? 'due for renewal, and not renewed at this start, which had no network address: New certificate renews it now'
    : 'due for renewal, and not renewed at this start, which has no network address yet: New certificate renews it once this laptop has one, as does a start that has one';
}
/** This laptop's LAN addresses now, or none while the system will not list its adapters: an answer that names them is drawn all the same. */
function lanNow() { try { return tlsmod.lanAddresses(); } catch { return []; } }
/** Why HTTPS is off this run, in words, or '' while it is on: what the banner's HTTPS line says, for the admin page too. */
function httpsOff() {
  if (cert) return '';
  if (process.env.AGM_TLS === '0') return 'AGM_TLS=0 turned it off for this run';
  return tlsOff || 'this run has no certificate';
}
const tlsFacts = () => ({
  on: !!cert, fingerprint: cert ? cert.fp : '', validTo: cert ? cert.validTo : '', requireHttps: !!settings.requireHttps,
  link: stageLink.tlsState, desk: stageLink.desk, deskRefusal: stageLink.deskRefusal,
  off: httpsOff(), renewal: renewalWords(),
});

// ---------------------------------------------------------------- health: crashes, the loop, latency
const RESTARTS = parseInt(process.env.AGM_RESTARTS || '0', 10) || 0;
const CRASH_PATH = path.join(DATA_DIR, 'last-crash.json');
const lastCrash = resilience.readJsonWithBak(CRASH_PATH);
// How the watchdog ended before this start, as it recorded it (supervise.js `record`: a give-up, or the installed node's
// start refused as configured, `refused`); marked seen by `firstWrites`.
const watchdogBefore = resilience.readJsonWithBak(path.join(DATA_DIR, 'watchdog.json'));
// How the copy before this one stopped (lib/laststop.js `take`: its record read and moved aside by `firstWrites`, once
// this copy holds the folder, and read against what the load found, `judge`; until then none), the snapshots this start
// wrote (the dirty halls', and no other), and the halls this start said AGMessage restarted in (each, after a stop that
// did not save; none after one that did).
let stopBefore = { ...laststop.readRecord('', 'ENOENT'), left: '' };
let bootSnapshots = 0;
let restartSaid = 0;
// The sampler's timer fires every LOOP_RESOLUTION_MS, so an idle loop reads that much delay: it is taken off each window.
const LOOP_RESOLUTION_MS = 10;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();
const loopRing = new resilience.Ring(120);       // the loop's true delay (its p99 less the resolution) per 5 s, the last 10 minutes
const eluRing = new resilience.Ring(120, 3);     // how busy the loop was (its utilisation, 0 to 1) per 5 s, the last 10 minutes
let eluMark = performance.eventLoopUtilization();
const joinBurst = new readings.Burst();          // the most people seated in one hall in any 5 s (a doors-open storm)
const tunnelPlaces = new guard.Places(TUNNEL_MAX);   // the sockets through the tunnel, by network (the connection's gate)
const refusals = new readings.Refusals();        // today's refusals by lane, and the tunnel's log line
const bootAt = Date.now();
refusals.carry(peaks.refusedOn(bootAt), bootAt);   // the tunnel's, today's so far: a restart mid-show keeps them
// State frames, latest wins (lib/latest.js): each says its subject changed, and is sent with the newest state, once per
// window at most; a lone change goes at once. Built before anything can mark them; each flush reads the state it sends
// when it runs, and skips a hall that has gone. A frame only reads the state, so one that faults while it is built is
// refused and counted as a handler's throw is (`frameRefused`), and the rest of its batch still goes. Health's `latest`
// reads what each saved (changes marked, frames sent).
const frames = {
  // Every halls board watcher, with the halls it may see (one key: the board is rebuilt for every watcher). A hall's
  // people, screens and Stagewatch mark it, which are what make a hall live: the power request follows it then.
  board: new Latest({ name: 'board', delayMs: 300, flush: () => { sendBoards(); keepAwake(); } }),
  // A hall's screens console re-reads its list (keyed by the hall): a take on 50 screens is one re-read per console.
  screens: new Latest({ name: 'screens', delayMs: 150, flush: (halls) => eachRoom('screens', halls, (r) => io.to(r.code).emit('displays:changed', { code: r.code })) }),
  // A room's people list (keyed by the room, a hall's Main room or a side room): a join storm is one list per window, not
  // one per join to every page.
  people: new Latest({ name: 'people', delayMs: 100, flush: (rooms) => eachRoom('people', rooms, (r) => sendPeople(r)) }),
  // A room's seen receipts (keyed by the room, with the people whose receipt moved): one frame per room per second.
  seen: new Latest({
    name: 'seen', delayMs: 1000,
    merge: (a, b) => { for (const uid of b) a.add(uid); return a; },
    flush: (rooms) => eachRoom('seen', rooms, (r, uids) => sendSeen(r, uids)),
  }),
  // A hall's rooms, for the switcher and the header on each page in any of them (keyed by the hall): a room made,
  // renamed or removed, or the hall renamed.
  rooms: new Latest({ name: 'rooms', delayMs: 300, flush: (halls) => eachRoom('rooms', halls, (h) => sendHallRooms(h)) }),
  // The rooms a room's pages may send into changed (keyed by the room): a list set, a room it sends into renamed or its
  // hall renamed. Each page is told to ask again (room:sendTargets), and told nothing of any list.
  sends: new Latest({ name: 'sends', delayMs: 300, flush: (rooms) => eachRoom('sends', rooms, (r) => io.to(r.code).emit('sendsChanged')) }),
};
/**
 * Each room of a frame's batch that is still here (a hall's key names its Main room), given to `send` with its value;
 * one that faults holds back no other.
 */
function eachRoom(frame, rooms, send) {
  sendEach(rooms, ([code, value]) => { const r = store.room(code); if (r) send(r, value); }, (e) => frameRefused(frame, e));
}
/**
 * Sockets open now: per lane, the most from one address (on the venue) or one network (through the tunnel), and those
 * through the tunnel, the sockets its places count (counts only: health names no address).
 */
function socketFacts() {
  const c = readings.countSockets(Array.from(io.sockets.sockets.values(), (s) => s.data));
  return { maxSocketsPerAddress: c.maxPerAddress, tunnelSockets: c.tunnel };
}
/**
 * The tunnel's places now, today's refusals (counts only: `networks` is how many networks hold a place, never which), and
 * the end the internet link is kept on until (`until`, ms since the epoch; null when none is kept): a start before it
 * turns the link on again.
 */
function tunnelFacts(now = Date.now()) {
  const refused = refusals.view(now);
  return { tunnel: { places: tunnelPlaces.taken, max: tunnelPlaces.max, share: tunnelPlaces.share, networks: tunnelPlaces.networks, refused: refused.tunnel, until: keptUntil(now) }, refused: { venue: refused.venue } };
}
/** The hall with the most messages: how many, and its snapshot's size (kept by each compaction, so no file is read). */
function largestHall() {
  let big = null;
  for (const r of store.rooms.values()) if (!big || r.messages.length > big.messages.length) big = r;
  return { messages: big ? big.messages.length : 0, kb: big && big.snapKb !== null ? big.snapKb : 0 };
}
setInterval(() => {
  const loopMs = readings.loopDelayMs(loopDelay, LOOP_RESOLUTION_MS);
  loopDelay.reset();
  const mark = performance.eventLoopUtilization();
  const elu = performance.eventLoopUtilization(mark, eluMark).utilization;
  eluMark = mark;
  loopRing.push(loopMs);
  eluRing.push(elu);
  const sockets = socketFacts();
  const hall = largestHall();
  const now = Date.now();
  peaks.note({
    loopMs, elu, socketsPerAddress: sockets.maxSocketsPerAddress, tunnelSockets: sockets.tunnelSockets,
    hallMessages: hall.messages, hallKb: hall.kb, joinBurst: joinBurst.take(performance.now()),
  }, now);
  savePeaks();   // this window's rises, the tunnel's refusals, and the snapshots and audit appends timed in it
  keepAwake();   // read again each window, whatever marked the board
  tunnelAtItsEnd(now);   // the tunnel's end read against the wall clock each window, so a sleep or a clock moved never outlives it, and its words kept true
  const refusedLine = refusals.logLine(now);   // one line a minute at most while the tunnel refuses
  if (refusedLine) console.log('  ' + refusedLine);
}, 5000).unref();
let rejections = 0;
let handlerFaults = 0;   // socket events refused because their handler threw (guardHandlers), and state frames that could not be built
/** A throw refused, never the process: counted in health's `handlerFaults` and logged, the first 20 and then every 100th. */
function noteFault(where, what, e) {
  handlerFaults++;
  if (handlerFaults <= 20 || handlerFaults % 100 === 0) console.error('  [' + where + '] ' + what + ' refused (' + handlerFaults + '): ' + (e && e.message ? e.message : e));
}
/** A state frame that faulted while it was built: it read the state and changed none, so it is refused and counted. */
function frameRefused(frame, e) { noteFault('frame', frame, e); }
/**
 * Health's facts about the audit log, in the order its readers take them (H.11): the log's own, the signing key's
 * fingerprint, then where the newest whole check began (1, or the archive point after the newest split), how many
 * archives it named, and the newest export sent whole.
 */
function auditFacts() {
  const { from, archives, lastExport, ...facts } = audit.facts();
  return { error: audit.lastError, unwritten: audit.unwritten, ...facts, signKey: AUDIT_SIGN_KEY, from, archives, lastExport };
}
function healthFacts() {
  return {
    restarts: RESTARTS,
    lastCrash: lastCrash ? { at: lastCrash.at, message: String(lastCrash.message || '').slice(0, 200) } : null,
    watchdog: watchdogBefore ? { at: watchdogBefore.at, reason: String(watchdogBefore.reason || '').slice(0, 700), refused: watchdogBefore.refused === true } : null,
    rejections,
    handlerFaults,
    loopMs: loopRing.stats(),
    stageRttMs: stageLink.rtt.stats(),
    stage: stageLink.status,
    stageKey: stageLink.keyFacts(),
    clock: stageLink.clockInfo(),
    // Show-desk results Stagewatch has not taken yet: how many, since when, its last answer and when the next try is due.
    desk: deskFacts(),
    tls: tlsFacts(),
    saves: {
      writes: settingsLane.writes, coalesced: settingsLane.coalesced, error: settingsLane.lastError,
      stores: {
        ...Object.fromEntries(saveLanes().map(([name, l]) => [name, { writes: l.writes, error: l.lastError, failures: l.failures }])),
        // The snapshots written this run, and at its start: only the halls that changed are written at a start and a stop.
        rooms: { error: store.lastError, unsaved: store.unsaved().length, snapshots: store.snapshots, atStart: bootSnapshots },
        audit: auditFacts(),
      },
      // Every write lane this process made, in any file, then the distinct lanes `saveLanes()` names: the two are equal,
      // and each lane has one name, or a lane is never flushed at a stop or a crash.
      built: resilience.WriteLane.built,
      named: new Set(saveLanes().map(([, l]) => l).filter((l) => l instanceof resilience.WriteLane)).size,
    },
    elu: eluRing.stats(),
    rssMb: Math.round(process.memoryUsage.rss() / 1048576),
    ...socketFacts(),
    largestHall: largestHall(),
    latest: Object.fromEntries(Object.values(frames).map((l) => [l.name, l.stats()])),
    // Per show day, the last 14, oldest first: each reading's highest (docs/DESIGN.md, "Measured on the show laptop").
    peaks: peaks.view(),
    showDay: readings.dayOf(Date.now()),   // the show day this laptop is in now: its record in `peaks` is today's
    // The tunnel's places and today's refusals through it, and the venue's: counts only, never an address.
    ...tunnelFacts(),
    // Connections the port could not take once it listened (EMFILE and the like): how many, and the last one's code.
    acceptErrors: { ...acceptErrors },
    // The data folder's format, and what this start found of it: the build that wrote it before (and whether that one is
    // newer), the copy kept when it moved from a lower format.
    format: formatFacts(),
    // The sleeps the watchdog recorded, beside the show day's peaks (each day's count and longest are in `peaks`): whether
    // a watchdog runs this server, and the newest kept whole, oldest first, each {from, to, parts}.
    sleeps: { watched: SUPERVISED, list: peaks.sleeps() },
    // The power request a live show holds (lib/power.js): its state, how many halls are live, and why it is not held.
    power: powerRequest.view(),
    // How the copy before this start stopped (data/last-stop.json, lib/laststop.js): whether it saved, and when not, why
    // (no record, one not read, or what that stop could not save), and the halls this start said AGMessage restarted in.
    lastStop: stopFacts(),
  };
}
/**
 * Health's `lastStop`: the record of the stop before this start, read by type and against the folder, the halls told
 * AGMessage restarted, and why the record is still where the next start reads it ('' when it was moved aside).
 */
function stopFacts() {
  const { state, saved, at, build, unsaved, code, left } = stopBefore;
  return { state, saved, at, build, unsaved, code, said: restartSaid, left };
}
/** Health's `format`: the folder's format now, and what this start found of it (null until it holds the folder). */
function formatFacts() {
  if (!formatNow) return null;
  const { format, was, before, newer, backup } = formatNow;
  return { format, was, before, newer, backup };
}
/** The data folder's row as "This laptop" draws it (lib/laptop.js), for the banner's line: its words and mark. */
function formatWords() { return laptop.formatRow({ ...formatFacts(), build: BUILD.full, dir: DATA_DIR }); }

// ---------------------------------------------------------------- "This laptop" (lib/laptop.js)
// What this AGMessage knows of the laptop it serves from, read each time it is asked, and what Windows says of it: read by
// one powershell.exe once this copy serves and again at the admin page's Refresh, one read at a time, each within its time.
// Only the admin page's answers carry it: never the context, the hello or the AI's brief.
const LAPTOP_MS = envNumber('AGM_LAPTOP_MS', laptop.WINDOWS_MS);
// The watchdog's line for the server's run before this start, handed over by it (supervise.js): its words, no secret.
const BEFORE = guard.cleanText(process.env.AGM_BEFORE || '', 800);
/**
 * "Before this start", in words: the watchdog's line for the run it restarted, or else how a watchdog ended before this
 * start, as it recorded it (a start refused as configured, a give-up), with when; '' when neither.
 */
function beforeWords() {
  if (RESTARTS && BEFORE) return BEFORE;
  if (!watchdogBefore || typeof watchdogBefore !== 'object') return '';
  const at = Number.isFinite(watchdogBefore.at) ? ' at ' + new Date(watchdogBefore.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const reason = guard.cleanText(String(watchdogBefore.reason || ''), 700) || 'no reason recorded';
  return (watchdogBefore.refused === true ? 'the start' + at + ' was refused: ' : 'the watchdog gave up' + at + ': ') + reason;
}
const laptopRead = { at: 0, reading: false, windows: laptop.windowsFacts(null), child: null };
/** Windows read again, unless a read is under way; once it is done the admin pages are told the facts (laptop:facts). */
function readLaptop() {
  if (laptopRead.reading) return;
  const plan = laptop.windowsPlan(process.env, { node: process.execPath });
  if (!plan.run) { laptopRead.windows = laptop.windowsFacts({ text: '', why: plan.why }); laptopRead.at = Date.now(); return; }
  laptopRead.reading = true;
  // readWindows never rejects, and its answer is read by type: the read ends, whatever it found.
  laptop.readWindows(plan, { timeoutMs: LAPTOP_MS, started: (child) => { laptopRead.child = child; } })
    .then((answer) => { laptopRead.windows = laptop.windowsFacts(answer); laptopRead.at = Date.now(); })
    .finally(() => {
      laptopRead.reading = false;
      laptopRead.child = null;
      const facts = laptopAnswer();
      for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.emit('laptop:facts', facts);
    });
}
/**
 * "This laptop" for an answer: its facts, or, should reading them throw (an adapter's list the system refused, a sealed
 * value that would not open), one row that says so, so the rest of the admin page's answer is drawn all the same.
 */
function laptopAnswer() {
  try { return laptopFacts(); } catch (e) {
    const why = guard.cleanText(String((e && (e.code || e.message)) || 'unknown error'), 120);
    return { at: laptopRead.at || null, reading: laptopRead.reading, addresses: [], port: PORT, facts: [{ id: 'unread', label: 'This laptop', words: 'unknown (its facts could not be read: ' + why + ')', mark: 'warn', from: 'this server' }] };
  }
}
/**
 * "This laptop" as the admin page draws it: when Windows was last read (`at`), whether a read is under way, the LAN
 * addresses and the port, and its rows (lib/laptop.js facts), each with where it was read. Sealed values are counted,
 * never named; screens and Stagewatch links counted by their state.
 */
function laptopFacts() {
  const addresses = tlsmod.lanAddresses();
  const sealed = sealedValues();
  const key = secretbox.keyState();
  let shown = 0, offline = 0;
  for (const d of displays.list.values()) { const st = Displays.status(d).state; if (st === 'shown') shown++; else if (st === 'offline') offline++; }
  let linked = 0, connected = 0;
  for (const l of allLinks()) if (l.base) { linked++; if (l.status === 'connected') connected++; }
  const without = [secretFound.words ? secretFound.words + ': this run signs guests and invite links with a secret of its own' : '', settingsRead.unread ? settingsRead.words + ': nothing is saved over it this run' : ''].filter(Boolean);
  const link = tunnelStatus();
  return {
    at: laptopRead.at || null, reading: laptopRead.reading, addresses, port: PORT,
    facts: laptop.facts({
      build: BUILD.full, runs: RUNS, addresses, port: PORT, node: process.execPath,
      https: { on: !!cert, fingerprint: cert ? cert.fp : '', validTo: cert ? cert.validTo : '', off: httpsOff(), renewal: renewalWords(), file: path.join(secretbox.keyDir(), 'tls.json') },
      sealed: { total: sealed.length, open: key.state === 'key' ? sealed.filter(([, v]) => !!secretbox.open(v)).length : 0, keyWords: key.state === 'key' ? '' : key.state === 'absent' ? 'this laptop has no machine key' : 'this run has no machine key (' + key.code + ')' },
      screens: { total: displays.list.size, shown, offline },
      pages: pagesFacts(),
      stagewatch: { total: linked, connected },
      tunnel: { running: !!tunnelProc, url: tunnelUrl || '', error: tunnelError || '', until: link.untilWords, again: link.againWords, notKept: link.notKept },
      sleeps: { watched: SUPERVISED, list: peaks.sleeps(), today: peaks.sleptOn(Date.now()) },
      power: powerRequest.view(),
      stop: serving ? { ...stopFacts(), fresh: !!formatNow && !formatNow.was, file: path.join(DATA_DIR, laststop.FILE) } : null,
      before: beforeWords(), without, format: formatNow ? { ...formatFacts(), build: BUILD.full, dir: DATA_DIR } : null,
    }, laptopRead.windows),
  };
}

// ---------------------------------------------------------------- a live show keeps the laptop awake (lib/power.js)
// One powershell.exe child holds a power request while a hall is live, started once this copy serves; it ends when no hall
// is, and with the server. Read again whenever the halls board is marked (a page seated or gone, a screen's take or
// report, a Stagewatch frame) and every 5 s window.
const powerRequest = new power.PowerRequest({ planOf: () => power.plan(process.env), say: (words) => console.log('  [power] ' + words) });
/**
 * Each hall now, as the power request reads it (lib/power.js isLive): its open pages seated in any of its rooms, idle or
 * not (a Board reading quietly is a live show, and so is a meeting in a side room alone; the admin's support view takes
 * no seat), its screens on which a browser confirmed a
 * take other than holding (one of a screen's browsers that could not show it takes nothing from one that did), and
 * whether its countdown counts, as its Stagewatch says now (a link connected, its frame not gone quiet): running, or
 * past zero and counting on into overtime. A Stagewatch several halls follow (the default) is one countdown: it makes
 * one hall live, never each, so "This laptop" counts the halls truly.
 */
function hallsNow() {
  const takes = new Map();
  for (const d of displays.list.values()) {
    if (!d.content || d.content.kind === 'holding') continue;
    if (Array.from(d.live.reports.values()).some((x) => x.seq === d.seq && x.ok)) takes.set(d.hall, (takes.get(d.hall) || 0) + 1);
  }
  const halls = [];
  const following = [];   // the halls that follow the default Stagewatch
  for (const r of store.rooms.values()) {
    let open = 0;
    for (const x of store.roomsOf(r.code)) for (const sid of x.users.keys()) if (io.sockets.sockets.has(sid)) open++;
    const own = hallLinks.get(r.code);
    const h = { pages: open, takes: takes.get(r.code) || 0, running: own ? counting(own) : false };
    if (!own) following.push(h);
    halls.push(h);
  }
  // The default's countdown makes live the first hall that follows it, unless one of them is live already.
  if (following.length && counting(stageLink) && !following.some(power.isLive)) following[0].running = true;
  return halls;
}
/** The power request follows the halls, once this copy serves and until it stops. */
function keepAwake() { if (serving && !shuttingDown) powerRequest.want(hallsNow()); }
/**
 * Whether a Stagewatch's countdown counts now, as it says (a link connected, its frame not gone quiet): running, or past
 * zero and counting on into overtime.
 */
function counting(link) {
  const v = link.view;
  if (!link.base || !v || v.stale || (link.status !== 'connected' && link.status !== 'viewing')) return false;
  return v.state === 'running' || (v.state === 'expired' && Number.isFinite(v.seconds) && v.seconds < 0);
}

// ---------------------------------------------------------------- the busy line (lib/busy.js)
// What is live, in counts, read before this copy is stopped: by the machine at loopback (GET /api/machine/busy, and the
// stop, which a busy server takes only with a typed reason) and on the data folder's pipe, where a second copy started on
// the same folder reads it for its words. A page is a person's in a hall (busy.pageKey: the hall's code and the uid its
// join gave it), active when it sent a verb of busy.INPUT from its seat (heard in guardHandlers, before its handler
// runs, refused or not) or when its message is one the hall holds from the window, which a restart keeps; a screen's
// take changed when it was given one (`takenAt`, kept in displays.json).
const activity = new busy.Activity();
/** The page a socket is seated as, or '' for one in no seat (the admin's own page and its support view, a screen). */
const seatedPage = (socket) => (socket.data && socket.data.seat && socket.data.userRoom ? busy.pageKey(socket.data.userRoom, socket.data.uid) : '');
/**
 * The busy line now: the pages active in the window (input from a seat, or a message the halls hold from it), the
 * screens whose take changed in it, the help requests raised in it, the countdowns running, the seats and screens open
 * and quiet, and every socket.
 */
function busyNow(now = Date.now()) {
  const since = now - busy.WINDOW_MS;
  let takes = 0, screens = 0;
  for (const d of displays.list.values()) {
    if (Number.isFinite(d.takenAt) && d.takenAt > since) takes++;
    if (Displays.screens(d) > 0) screens++;
  }
  const active = new Set(activity.keys(now));
  let help = 0;
  // A message any room holds from the window, a side room's too: its page is keyed by the room it is in (busy.pageKey).
  for (const r of store.allRooms()) {
    const said = busy.fromMessages(r.code, r.messages, since);
    for (const k of said.pages) active.add(k);
    help += said.help;
  }
  const countdowns = allLinks().filter(counting).length;
  let seats = 0;
  for (const s of io.sockets.sockets.values()) { const page = seatedPage(s); if (page && !active.has(page)) seats++; }
  return busy.line({ active: active.size, takes, help, countdowns, seats, screens, sockets: io.sockets.sockets.size });
}

// Role-level events for the show network's context: never names, never content. Each keeps the Stagewatch link of the
// halls it happened in (none: the whole node's), so a link's own context carries only its halls' events; the tag never
// leaves the server (buildContext keeps at and text).
const recentEvents = [];
function noteEvent(text, link) { recentEvents.push({ at: Date.now(), text, link: link ? link.id : '' }); if (recentEvents.length > 40) recentEvents.shift(); }

// ---------------------------------------------------------------- rooms
// Loaded without writing, its folder not made: until this copy holds the data folder and its port (`holdDataFolder`, at the
// end of this file), another copy may be appending to these same files.
// A room's reference (store.byRef): 'r' and 16 characters of a MAC of its key under the server's secret, made once per
// room, the same at every start. It never passes CODE_RE (17 characters, mixed case), so no join or lookup by code takes
// one, and it names nothing a client could open: a page is told it of a room it may send into, or that sent to it.
const store = new RoomStore(ROOMS_DIR, { make: false, refOf: (key) => 'r' + guard.mac(SECRET, 'room-ref:' + key, 16) });
// Timed where they run; saved with the window they fall in (the health tick), or at once by a stop or a crash.
store.onCompact = (ms, messages) => { peaks.compacted(ms, messages, Date.now()); };
audit.onPut = (ms) => { peaks.auditPut(ms, Date.now()); };
// A rooms folder that is there but cannot be read (a file in its place, a folder this account may not list) stops the start
// with its words, in either channel: a copy that served without its halls would make new ones over them.
let restored = 0;
try {
  // A message moved to today's words is a change no op made: its room is marked, so the start writes it once.
  restored = store.loadAll((room) => {
    for (const m of room.messages) {
      if (m.from && m.from.role === 'director') { m.from.role = 'board'; store.markDirty(room); }   // legacy role name
      // A forward names its hall, never its code (an earlier build kept it).
      if (m.forwardedFrom && Object.hasOwn(m.forwardedFrom, 'roomCode')) { delete m.forwardedFrom.roomCode; store.markDirty(room); }
    }
  }, { compact: false });
} catch (e) {
  cannotStartYet('the rooms folder ' + ROOMS_DIR + ' cannot be read (' + (e.code || e.message) + '). Choose a data folder this Windows account can read and write (AGM_DATA_DIR), or fix that one\'s permissions.');
}
if (restored) console.log('  Restored', restored, 'room(s) from', ROOMS_DIR);

/**
 * Commit an op and send each of its events to the hall, as the op table names them (lib/ops.js), carrying its seq. An op
 * the table cannot send is refused before it is committed, in one line that names its kind and fields, never a value,
 * and apply() answers null: it never throws for it, the Stagewatch followers outside the guarded handlers included. A
 * caller reads that null: a request is answered OP_REFUSED, and nothing that follows the change (a file removed, a row
 * written, a send followed) is done for a change that was not made.
 */
const apply = ops.applier({
  commit: (room, op) => store.commit(room, op),
  send: (room, opEvent, payload) => io.to(room.code).emit(opEvent, payload),
  changed: () => boardDirty(),
  refused: (why) => console.error('  [ops] refused, nothing saved or sent: ' + why),
});
/** A request's answer when apply() refused its change: nothing was saved or sent (the server's log says why). */
const OP_REFUSED = Object.freeze({ ok: false, error: 'That change could not be made: nothing was saved.' });
/** A system line in the hall, or null when the op table refused it. */
function systemMessage(room, text) {
  const op = apply(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text, at: Date.now() } });
  return op ? op.m : null;
}

/**
 * Who is in a room: one row per person (an account open on two devices is one person), the first of their sockets. The
 * admin's links (`links`) are hall codes, a guest's way into those halls: only the admin's pages are given them.
 */
function roomUserSummary(room, { links = false } = {}) {
  const seen = new Set();
  return Array.from(room.users.entries()).filter(([, u]) => !seen.has(u.uid) && seen.add(u.uid)).map(([sid, u]) => ({
    socketId: sid, uid: u.uid, name: u.name, role: u.role,
    ...(links ? { linkedRooms: u.linkedRooms instanceof Set ? Array.from(u.linkedRooms) : [] } : {}),
    account: !!u.acct,
  }));
}
/** Who is in the room changed: its people list goes to every page in it once per 100 ms at most (`frames.people`). */
function emitUsers(room) { frames.people.mark(room.code); }
/**
 * The room's people to every page in it: one broadcast without the links (framed once, however many are in the hall,
 * since frames are not deflated), and the admin's pages, a few, each the list with them (their chips and Unlink).
 */
function sendPeople(room) {
  const admins = Array.from(io.sockets.adapter.rooms.get(room.code) || []).filter((sid) => { const s = io.sockets.sockets.get(sid); return !!(s && s.data.isAdmin); });
  io.to(room.code).except(admins).emit('users', roomUserSummary(room));
  if (!admins.length) return;
  const full = roomUserSummary(room, { links: true });
  for (const sid of admins) io.sockets.sockets.get(sid).emit('users', full);
}
/** Every seat one person has in a room ([socketId, seat] pairs): the room list shows the person once, so what the admin
 *  does to that row (role, link, logout) is done to each of their pages there. */
const seatsOf = (room, uid) => Array.from(room.users).filter(([, u]) => u.uid === uid);

// Rooms each person (by server identity) is in — forwarding only between rooms they're actually in.
const userRooms = new Map();
const trackJoin = (uid, code) => { if (!userRooms.has(uid)) userRooms.set(uid, new Set()); userRooms.get(uid).add(code); };
const trackLeave = (uid, code) => { const s = userRooms.get(uid); if (s) { s.delete(code); if (!s.size) userRooms.delete(uid); } };

// Venue Wi-Fi drops people for a second: announce "left" only if they don't come straight back.
const pendingLeaves = new Map();   // room|uid -> {timer, name, role, guest, moved} (role null: the server sent them away, no seat held)
const LEAVE_GRACE_MS = envNumber('AGM_LEAVE_GRACE_MS', 8000);
/**
 * Whether a join into `room` by the person `uid` named `name` is a move between rooms of its hall: that person left
 * another of its rooms within the grace (the switcher, a page that opens another of them, as the page it leaves goes), so
 * neither room says a line, and each such leave is marked `moved` and said nowhere when its grace ends. A page still
 * open in another room is no move: a second device or tab in this room is said here as it joins, and its leave there as
 * it leaves. A guest page moves the same way, by the codes it holds.
 */
function movedWithinHall(room, uid, name) {
  let found = false;
  for (const other of store.roomsOf(room.hall)) {
    if (other === room) continue;
    const p = pendingLeaves.get(other.code + '|' + uid);
    if (p && p.name === name) { p.moved = true; found = true; }
  }
  return found;
}
// The watchdog's restart drops every page at once and starts with nobody seated: a locked room's code-guest seats (board
// and research) are saved with the room (settings.seats: uid -> {name, role}, in its op log like a message: what every
// page in the hall already reads in its people list), and for the boot's first seconds a page that comes back takes its
// saved seat as from a drop. A seat not taken up by then is gone.
const BOOT_AT = Date.now();
const BOOT_SEAT_MS = Math.max(1000, Number(process.env.AGM_BOOT_SEAT_MS) || 30_000);
const savedSeat = (room, uid) => (room.settings.seats && Object.hasOwn(room.settings.seats, uid) ? room.settings.seats[uid] : null);
/** Whether this person (identity and name) holds a seat with this role in the room: on a page of theirs still there, or
 *  on one that dropped within the grace (Wi-Fi, the reload after the admin changed their role) and was not sent away by
 *  the server, or saved before the restart this process booted from. A locked room's invite is for people who join
 *  later; someone already seated keeps the seat. */
function holdsSeat(room, uid, name, role) {
  for (const [sid, u] of room.users) if (u.uid === uid && u.name === name && u.role === role && io.sockets.sockets.has(sid)) return true;
  const p = pendingLeaves.get(room.code + '|' + uid);
  if (p) return p.name === name && p.role === role;
  const s = Date.now() - BOOT_AT < BOOT_SEAT_MS ? savedSeat(room, uid) : null;
  return !!s && s.name === name && s.role === role;
}
/** The code-guest seats (board, research) a room holds now: on a page still there, in a drop's grace, or saved before the
 *  restart and not yet taken up while the boot's first seconds last. One seat per person, a page's before a drop's. The
 *  laptop's token admin's own page holds none: it is admitted to every room whatever its code or lock (`join`). */
function seatsNow(room) {
  const seats = {};
  const here = new Set();
  for (const [sid, u] of room.users) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    here.add(u.uid);
    if (!u.acct && !s.data.isAdmin && u.role !== 'observer' && !seats[u.uid]) seats[u.uid] = { name: u.name, role: u.role };
  }
  const prefix = room.code + '|';
  for (const [k, p] of pendingLeaves) {
    const uid = k.slice(prefix.length);
    if (k.startsWith(prefix) && p.guest && p.role && p.role !== 'observer' && !here.has(uid)) seats[uid] = { name: p.name, role: p.role };
  }
  if (Date.now() - BOOT_AT < BOOT_SEAT_MS) {
    for (const uid of Object.keys(room.settings.seats || {})) {
      const s = savedSeat(room, uid);
      if (s && !here.has(uid) && !pendingLeaves.has(prefix + uid)) seats[uid] = { name: s.name, role: s.role };
    }
  }
  return seats;
}
/** Whether a room's saved seats are these: the same people, each with the same name and role, in whatever order. */
function seatsSaved(room, seats) {
  const keys = Object.keys(seats);
  return keys.length === Object.keys(room.settings.seats || {}).length && keys.every((uid) => { const s = savedSeat(room, uid); return !!s && s.name === seats[uid].name && s.role === seats[uid].role; });
}
/** A locked room's saved seats follow the seats it holds: one numbered change, only when they differ. */
function syncSeats(room) {
  if (!store.hasRoom(room.code) || !room.settings.lockRoles) return;
  const next = seatsNow(room);
  if (!seatsSaved(room, next)) apply(room, { o: 'meta', settings: { seats: next } });
}
// The boot's first seconds are over: a seat saved before the restart that nobody took up goes, as after a drop's grace.
setTimeout(() => { for (const room of store.allRooms()) if (Object.keys(room.settings.seats || {}).length) syncSeats(room); }, BOOT_SEAT_MS + 100).unref();

// Upload tokens, issued at join: an upload must come from someone in a room. The rate is the connection's and the
// network's (`guard.limitKey`: an address on the venue, a /64 for an IPv6 phone through the tunnel), not the token's, so
// joining again, opening more sockets or taking the next address refills nothing. The network buckets are never reset:
// past 5,000 the fullest go first, so a flood of new addresses hands no drained one its burst back.
const uploadTokens = new Map();    // token -> {room, uid, sid, bucket (the connection's), key (its network), may(), seat(), revoked}
// A token whose socket no longer holds hall.files, or that a move of its seat ended (`revoked`), is refused at its next
// use in the words of the seat its page holds then, and goes; a revoked one never uploads again, whatever seat follows.
const UPLOAD_REFUSED = Object.freeze({ board: 'On stage seats send messages, not files.', observer: 'Observers can read but not post.' });
const uploadBuckets = new guard.Buckets(0.5, 8, 5000);
// Files uploaded in this run and not yet past their wait: one nobody posted by then is removed. Each is kept with the room
// its upload token was issued for and the person it was issued to (its provenance, read by `fileRefusal`): a file message
// names an upload made for its room by the person who posts it, or one a message of that room already holds. The record is
// this run's alone, so an upload not yet posted when the server stops is uploaded again after the restart.
const freshUploads = new Map();    // file name -> {at, room (its key), uid}

/**
 * What the admin is told when a room's files could not all be removed (lib/store.js `remove`'s `kept`: another program
 * held one, an antivirus or a backup): how many rooms' files stay, and, when `what` (the hall, the room) loads again at
 * the next start for it, that its uploads are kept for it.
 */
function keptWords(gone, what) {
  return 'Another program (an antivirus or a backup) held the files of ' + plural(gone.kept.length, 'room') + ', which stay in the data folder'
    + (gone.again ? ': ' + what + ' opens again at the next start unless they are removed first, and its uploads are kept for it.' : ', unused.');
}
const uploadNamesOf = (urls) => new Set(urls.filter((u) => guard.validUploadUrl(u)).map((u) => u.slice(9)));
/** Every upload a file message of any room of any hall points at, by its name. */
function uploadsInRooms() {
  const urls = [];
  for (const r of store.allRooms()) for (const m of r.messages) if (m.type === 'file') urls.push(m.url);
  return uploadNamesOf(urls);
}
/** Every upload a screen shows or a hall holds as its holding image, by its name. */
function uploadsOnScreens() {
  const urls = [];
  for (const d of displays.list.values()) if (d.content) urls.push(d.content.url, d.content.image);
  for (const code of Object.keys(displays.halls)) urls.push(displays.hallHolding(code));
  return uploadNamesOf(urls);
}
/** Every upload something still points at: a message in any room of any hall, what a screen shows, a hall's holding image. */
function uploadsInUse() {
  const used = uploadsInRooms();
  for (const f of uploadsOnScreens()) used.add(f);
  return used;
}
/** Remove those of `names` nothing points at any more (a reset, a deletion, a hall removed). Resolves to how many went. */
async function removeUnused(names) {
  const used = uploadsInUse();
  let n = 0;
  for (const f of new Set(names)) {
    if (used.has(f) || !guard.validUploadUrl('/uploads/' + f)) continue;
    freshUploads.delete(f);
    try { await fs.promises.unlink(path.join(UPLOAD_DIR, f)); n++; } catch { /* already gone */ }
  }
  return n;
}
const fileNamesOf = (messages) => messages.filter((m) => m && m.type === 'file' && guard.validUploadUrl(m.url)).map((m) => m.url.slice(9));
setInterval(() => {
  const due = Array.from(freshUploads).filter(([, up]) => Date.now() - up.at >= UPLOAD_ORPHAN_MS).map(([f]) => f);
  for (const f of due) freshUploads.delete(f);
  if (due.length) removeUnused(due).catch(() => { /* the next sweep tries the rest */ });
}, Math.max(100, Math.min(60_000, UPLOAD_ORPHAN_MS))).unref();

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.set('trust proxy', false);
app.use(guard.pageHeaders);
// Require HTTPS (admin setting): plain HTTP only from this machine (which is also how the Cloudflare tunnel connects).
// A browser asking for a page is sent to the same address over HTTPS; anything else is refused and told why.
app.use((req, res, next) => {
  const g = tlsmod.httpsGate({ required: !!settings.requireHttps, on: !!cert, encrypted: isEncrypted(req), loopback: isLoopback(req), method: req.method, path: req.originalUrl, host: req.headers.host });
  if (g.allow) return next();
  if (g.redirect) return res.redirect(308, g.redirect);
  res.status(403).json({ ok: false, error: g.refuse });
});
// The certificate, for people to trust it once on each screen (Show Bus §10): public — a fingerprint is not a secret.
app.get('/tls.cer', (_req, res) => {
  if (!cert) return res.status(404).json({ ok: false, error: 'HTTPS is off on this AGMessage.' });
  res.setHeader('Content-Type', 'application/pkix-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="agmessage.cer"');
  res.end(cert.der);
});
app.get('/tls', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const fp = cert ? cert.fp.slice(7).match(/../g).join(':').toUpperCase() : '';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGMessage — secure connection</title><link rel="stylesheet" href="/styles.css"></head><body class="tls-page"><main class="tls">
<h1>Secure connection</h1>
${cert ? `<p>This AGMessage encrypts its pages with its own certificate. Browsers warn about it until you trust it once on each device. Before you do, check that the fingerprint below matches the one on the AGMessage laptop (Admin → Show network).</p>
<p class="fp"><strong>SHA-256 fingerprint</strong><br><code>${esc(fp)}</code></p>
<p><a class="btn" href="/tls.cer" download>Download the certificate</a> · valid until ${esc(cert.validTo)}</p>
<h2>Trust it</h2><ul>
<li><strong>Windows:</strong> open the downloaded file → Install Certificate → Local Machine → "Place all certificates in the following store" → Trusted Root Certification Authorities.</li>
<li><strong>macOS:</strong> open it in Keychain Access (System keychain) → double-click it → Trust → "When using this certificate: Always Trust".</li>
<li><strong>iPhone / iPad:</strong> open the download → Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn it on.</li>
<li><strong>Android:</strong> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate → choose the file.</li>
</ul>
<p>Then open this AGMessage with <code>https://</code> instead of <code>http://</code> — the same address and port.</p>
<p class="meta">Connected now over ${isEncrypted(req) ? 'HTTPS ✓' : 'plain HTTP'}.${settings.requireHttps ? ' This AGMessage requires HTTPS from other devices.' : ''}</p>`
    : '<p>HTTPS is turned off on this AGMessage.</p>'}
</main></body></html>`);
});
// ---------------------------------------------------------------- this PC's machine, at loopback (lib/machinewire.js)
// The machine's requests: answered only on this PC (guard.isHostMachine), never a browser's (an Origin or Sec-Fetch-*
// header, which the machine never sends: a page open on this PC asks nothing here and cannot flood the nonces), and only
// while the token is 16 characters or more (a hello is an HMAC under the token over words its asker knows, which a
// short token would let anyone on this PC test guesses against, outside the lockout). Each but the hello only with a
// nonce this copy issued within its time and not yet used, and the machine's proof of the token over it, the method, the
// path and the body, compared in constant time (machinewire.judge). A wrong proof counts toward the token's lockout as a
// wrong token does, and is written as one. The body is read as bytes, at most BODY_MAX, so the proof is checked over what
// came before any of it is parsed. The hello answers the server's own proof first, so the machine sends nothing to a
// program that took this port without the token.
const machineNonces = new machinewire.Nonces();
const machineBody = express.raw({ type: () => true, limit: machinewire.BODY_MAX });
const OFF_HOST = 'Only this PC\'s own requests, at loopback, are answered here.';
const FROM_BROWSER = 'A browser\'s request is never this PC\'s machine\'s: nothing is answered here to a page.';
/** Why a request to /api/machine/* is not answered at all ('' when it may be judged): off this PC, a browser's, a short token. */
function machineClosed(req) {
  if (!guard.isHostMachine(req)) return OFF_HOST;
  if (machinewire.fromBrowser(req.headers)) return FROM_BROWSER;
  return machinewire.weakToken(ADMIN_TOKEN);
}
app.get(machinewire.PATHS.hello, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const closed = machineClosed(req);
  if (closed) return res.status(403).json({ ok: false, error: closed });
  const challenge = typeof req.query.c === 'string' ? req.query.c : '';
  if (!machinewire.NONCE.test(challenge)) return res.status(400).json({ ok: false, error: 'The hello carries the machine\'s challenge (c), 32 hex characters.' });
  const nonce = machineNonces.issue(Date.now());
  res.json({ ok: true, nonce, build: BUILD.full, proof: machinewire.serverProof(ADMIN_TOKEN, nonce, challenge) });
});
/** The machine's request judged: true when it may go on; else it is answered with why, and a wrong proof is counted. */
function machineAsked(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const closed = machineClosed(req);
  if (closed) { res.status(403).json({ ok: false, error: closed }); return false; }
  if (adminLockout.locked('host')) { res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' }); return false; }
  const v = machinewire.judge({
    token: ADMIN_TOKEN, nonces: machineNonces, nonce: req.get(machinewire.NONCE_HEADER), proof: req.get(machinewire.PROOF_HEADER),
    method: req.method, path: req.originalUrl, body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), now: Date.now(),
  });
  if (!v.ok) {
    if (v.wrong) {
      adminLockout.fail('host');
      audit.write(HOST_ACTOR, 'login.token.fail', 'host', 'a wrong proof of the admin token (at ' + req.path + ')', guard.clientIp(req));
    }
    res.status(v.status).json({ ok: false, error: v.error, ...(v.again ? { again: true } : {}) });
    return false;
  }
  adminLockout.ok('host');
  return true;
}
// How live this copy is (lib/busy.js), and in words.
app.get(machinewire.PATHS.busy, machineBody, (req, res) => {
  if (!machineAsked(req, res)) return;
  const line = busyNow();
  res.json({ ok: true, busy: busy.isBusy(line), line, words: busy.words(line) });
});
// The stop: saved as every stop is (`shutdown`, which runs to its end in one go), with code 0, once its answer has gone. A
// busy copy stops only when a person typed a reason (`force`), and that is written (`server.stop.forced`: who asked, why,
// what was live, the words typed); a copy that is not busy needs none. A stop asked while one is under way (another
// stop at loopback, or Ctrl+C's) is answered with what is being done, `already`, and neither says nor writes anything.
let machineStopping = null;
app.post(machinewire.PATHS.stop, machineBody, (req, res) => {
  if (!machineAsked(req, res)) return;
  const ask = machinewire.readStop(req.body);
  if (ask.error) return res.status(400).json({ ok: false, error: ask.error });
  if (machineStopping || shuttingDown) return res.json({ ...(machineStopping || { ok: true, stopping: true, forced: false, line: busyNow() }), already: true });
  const line = busyNow();
  const forced = busy.isBusy(line);
  if (forced && !ask.force) return res.status(409).json({ ok: false, busy: true, line, error: 'Not stopped: AGMessage is busy (' + busy.words(line) + '). Type a reason to stop it anyway.' });
  const why = machinewire.STOP_WORDS[ask.reason];
  if (forced) audit.write(HOST_ACTOR, 'server.stop.forced', ask.by, 'stopped while busy (' + busy.words(line) + ') for ' + why + ': ' + ask.force, guard.clientIp(req));
  console.log('\n  Stopping for ' + why + ', asked at loopback by ' + ask.by + (forced ? ' while busy (' + busy.words(line) + '), with a reason typed' : '') + '.');
  let gone = false;
  const go = () => { if (!gone) { gone = true; shutdown(resilience.EXIT.STOP); } };
  res.once('finish', go);
  res.once('close', go);
  machineStopping = { ok: true, stopping: true, forced, line };
  res.json(machineStopping);
});
// The machine's events are to be read: the nudge carries nothing. This copy keeps none to read, and says so.
app.post(machinewire.PATHS.events, machineBody, (req, res) => {
  if (!machineAsked(req, res)) return;
  if (Buffer.isBuffer(req.body) && req.body.length) return res.status(400).json({ ok: false, error: 'The nudge carries nothing.' });
  res.json({ ok: true, read: 0, words: 'Heard. This AGMessage keeps no machine events to read.' });
});

app.use(express.json({ limit: '256kb' }));
const web = mountAccounts(app, {
  accounts, sessions, audit, settings, isEncrypted, isLoopback,
  isTokenAdmin: (req) => isValidAdminCookie(req),
  // The token typed at the laptop (the first admin account): judged as the token sign-in judges it, the typed token first.
  typedToken: (req, typed, where) => typedTokenProblem(req, typed, where),
  // The export: the token's sign-in made by this run, who the token is in the log, the signing key, and HTTPS's state.
  tokenHere: (req) => tokenSessions.mintedHere(readCookie(req, 'agm_admin')), hostActor: HOST_ACTOR,
  exporter: auditExporter, signKey: () => AUDIT_SIGN_KEY, httpsOn: () => !!cert, port: PORT,
  // The split: its archiver, and the admin page's gate, which "the admin" narrows (theAdminReq).
  archiver: auditArchiver, isAdminReq: (req) => isAdminReq(req),
  hallNames: () => Array.from(store.rooms.values()).map((r) => ({ code: r.code, name: r.name || '' })),
  roomNames: () => sideRoomNames(),
  onAccountChanged: (id, what) => accountChanged(id, what),
  onSessionEnded: (h) => endSockets((s) => s.data.sessionHash === h, 'signout', SIGNED_OUT),
});
/** The admin dashboard: the host laptop's token, or an account with admin rights (not through the tunnel unless allowed). */
function isAdminReq(req) {
  if (isValidAdminCookie(req)) return true;
  const w = web.who(req);
  return !!(w && !w.account.mustChange && rbac.can(w.account, 'settings.manage') && !web.adminBlocked(req, w.account));
}
app.get('/admin', (_req, res) => res.redirect('/admin.html'));
// The build that serves the pages, as a script each page with a socket loads before its own: the page names it as it
// connects (AGM.reconnect.auth) and holds it against the build each answer carries.
const BUILD_JS = 'window.AGM = window.AGM || {};\nwindow.AGM.build = ' + JSON.stringify(BUILD.full) + ';\n';
// The pages, their scripts and their styles are checked with this server at every load (no-cache, their ETag: a 304 when
// unchanged), never taken from a browser's cache unasked: a page that reloads for a new build gets that build's, whole.
const CHECKED = (res) => res.setHeader('Cache-Control', 'no-cache');
app.get('/build.js', (_req, res) => { CHECKED(res); res.type('application/javascript').send(BUILD_JS); });
app.use(express.static(PUBLIC_DIR, { index: 'index.html', cacheControl: false, setHeaders: CHECKED }));

// Uploads: only allow-listed names, served so they can't run script (sandbox CSP, nosniff, attachment for office files).
app.get('/uploads/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!guard.validUploadUrl('/uploads/' + name)) return res.status(404).end();
  const t = guard.UPLOAD_TYPES[guard.extOf(name)];
  if (!t) return res.status(404).end();
  res.setHeader('Content-Type', t.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', (t.inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/^[0-9]+-[a-z0-9]+-/, '') + '"');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(UPLOAD_DIR, name), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ----- admin auth
const readCookie = (req, name) => guard.readCookie(req.headers.cookie, name);
const isValidAdminCookie = (req) => tokenSessions.has(readCookie(req, 'agm_admin'));
const adminLockout = new guard.Lockout(5, 60_000);
/**
 * The laptop's token typed at the laptop to make the first admin account: null when it is the token, else {status, error}.
 * The typed token is judged first, so the right one is taken even while wrong ones hold the token's lockout: someone
 * else at the laptop typing five wrong tokens a minute never keeps its person out (the token's 64 random bits make the
 * lock nothing against guessing). A wrong one counts toward the lockout and is written as `login.token.fail`, naming where
 * it was typed, unless the lock already holds, when it is refused and not written again: a flood writes five rows a
 * minute at most. A request that typed none guessed nothing, and is told to type it.
 */
function typedTokenProblem(req, typed, where) {
  const t = typeof typed === 'string' ? typed.toLowerCase().trim() : '';
  if (t && guard.safeEqual(t, ADMIN_TOKEN)) { adminLockout.ok('host'); return null; }
  if (!t) return { status: 401, error: 'Type the token from the AGMessage window (installed: Start → AGMessage → Show the admin token).' };
  if (adminLockout.locked('host')) return { status: 429, error: 'Too many wrong tokens — wait a minute.' };
  adminLockout.fail('host');
  audit.write(HOST_ACTOR, 'login.token.fail', 'host', 'a wrong admin token (at ' + where + ')', guard.clientIp(req));
  return { status: 401, error: 'That is not the token in the AGMessage window.' };
}

app.post('/api/admin/login', (req, res) => {
  if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'Admin login is only allowed on the host laptop.' });
  if (adminLockout.locked('host')) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const t = String((req.body && req.body.token) || '').toLowerCase().trim();
  if (!t || !guard.safeEqual(t, ADMIN_TOKEN)) { adminLockout.fail('host'); audit.write(HOST_ACTOR, 'login.token.fail', 'host', 'a wrong admin token', guard.clientIp(req)); return res.status(401).json({ ok: false, error: 'Invalid admin token.' }); }
  adminLockout.ok('host');
  const sid = tokenSessions.create();
  audit.write(HOST_ACTOR, 'login.token', 'host', 'signed in with the host laptop\'s admin token', guard.clientIp(req));
  res.setHeader('Set-Cookie', 'agm_admin=' + sid + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400' + (isEncrypted(req) ? '; Secure' : ''));
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const sid = readCookie(req, 'agm_admin');
  if (tokenSessions.has(sid)) {
    tokenSessions.destroy(sid);
    endSockets((s) => s.data.adminSid === sid, 'signout', SIGNED_OUT);   // every admin page this sign-in has open, too
    audit.write(HOST_ACTOR, 'logout.token', 'host', 'signed out the host laptop\'s admin token', guard.clientIp(req));
  }
  res.setHeader('Set-Cookie', 'agm_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
// `token`: this request is the laptop's token, signed in by this run (a sign-in read back from the file never counts).
// `admin`: this request is "the admin" (the token, or an account whose role is admin), who may split the log.
// `manageUsers`, at the end: this request's account may manage accounts (mayManageUsers), so the admin page offers a room's
// Members… only where its saves are taken.
app.get('/api/admin/me', (req, res) => res.json({ ok: isAdminReq(req), local: guard.isHostMachine(req), accounts: accounts.size, token: guard.isHostMachine(req) && tokenSessions.mintedHere(readCookie(req, 'agm_admin')), admin: web.theAdminReq(req), manageUsers: mayManageUsers(req) }));
/**
 * Whether a request's account may manage accounts, as the Accounts routes judge it (signedIn('users.manage')): signed in,
 * its own password chosen, holding users.manage, and not an admin right kept off the tunnel. The laptop's token is no
 * account: it manages none.
 */
function mayManageUsers(req) {
  const w = web.who(req);
  return !!(w && !w.account.mustChange && rbac.can(w.account, 'users.manage') && !web.adminBlocked(req, w.account));
}

// Accept what the audit log found (lib/audit.js accept): the laptop's token, typed into the dialog at the laptop, and never
// a sign-in, which is a record in the data folder anyone who can write it could add. A wrong token counts toward the
// token sign-in's own lockout and is written down.
app.post('/api/audit/accept', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard.isHostMachine(req)) return res.status(403).json({ ok: false, error: 'Accept on the AGMessage laptop itself, with its token.' });
  if (adminLockout.locked('host')) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const t = typeof b.token === 'string' ? b.token.toLowerCase().trim() : '';
  if (!t || !guard.safeEqual(t, ADMIN_TOKEN)) {
    adminLockout.fail('host');
    audit.write(HOST_ACTOR, 'login.token.fail', 'host', 'a wrong admin token (at Accept)', guard.clientIp(req));
    return res.status(401).json({ ok: false, error: 'That is not the token in the AGMessage window.' });
  }
  adminLockout.ok('host');
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 40).map((x) => x.slice(0, 24)) : []);
  const r = await audit.accept({ digest: typeof b.digest === 'string' ? b.digest.slice(0, 32) : '', ids: list(b.ids), confirm: list(b.confirm) }, HOST_ACTOR, guard.clientIp(req));
  const { status, ...answer } = r;
  return res.status(status || 200).json(answer);
});

// A display's page: the same page for every token, valid or not (the socket decides), so the URL itself says nothing.
// No caching, no referrer (pageHeaders), no indexing: the token is a capability.
app.get('/d/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PUBLIC_DIR, 'display.html'));
});

app.get('/api/admin/transcript/:code', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).send('Forbidden');
  const room = store.room(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).send('Room not found');
  // Read by the laptop's token first, as a socket is: the token's reads are the laptop's, an account's its own.
  const w = isValidAdminCookie(req) ? null : web.who(req);
  readAsAdmin(w ? web.actorOf(w) : HOST_ACTOR, w ? w.account : null, room, (n) => 'transcript of ' + n, guard.clientIp(req));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', 'inline; filename="transcript-' + room.code + '.html"');
  res.send(renderTranscriptHtml(room));
});

// Health: anyone may ask whether it is up; the detail is for the admin (or the host laptop).
app.get('/api/health', (req, res) => {
  const base = { ok: true, version: VERSION, build: BUILD.full, uptime: Math.round(process.uptime()) };
  if (!(isAdminReq(req) || guard.isHostMachine(req))) return res.json(base);
  // `rooms` counts the halls (their Main rooms); `sideRooms`, the rooms beside them.
  res.json({ ...base, rooms: store.rooms.size, clients: io.engine.clientsCount, ...healthFacts(), sideRooms: store.allRooms().length - store.rooms.size });
});

// Context (Show Bus §6): what another node's AI, or Patterns' Eye, needs to understand this one. Read-only token or admin.
function bearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
// Wrong context tokens: 10 a minute per network (`guard.limitKey`), so a phone's next address is still under the same lock.
const contextLock = new guard.Lockout(10, 60_000);
app.get('/api/context', (req, res) => {
  const network = guard.limitKey(guard.clientIp(req));
  if (contextLock.locked(network)) return res.status(429).json({ ok: false, error: 'Too many wrong tokens — wait a minute.' });
  const t = bearer(req);
  // A saved token this run cannot open is kept, never replaced: a token read is refused with why, and counts as no guess.
  const why = t && !isAdminReq(req) ? contextTokenProblem() : '';
  if (why) return res.status(503).json({ ok: false, error: why });
  const allowed = isAdminReq(req) || (t && guard.safeEqual(t, contextToken()));
  if (!allowed) { if (t) contextLock.fail(network); return res.status(401).json({ ok: false, error: 'A context token is needed (AGMessage admin → Show network).' }); }
  res.setHeader('Cache-Control', 'no-store');
  res.json(currentContext());
});

// Room lookups: rate limited and locked out after guessing, per network (`guard.limitKey`). The buckets are never reset:
// past 5,000 networks the fullest go first, so a flood of new addresses hands no drained one its burst back.
const lookupLock = new guard.Lockout(12, 60_000);
const lookupBuckets = new guard.Buckets(2, 10, 5000);
function lookupAllowed(key) {
  if (lookupLock.locked(key)) return false;
  return lookupBuckets.take(key);
}

app.post('/api/rooms', (req, res) => {
  const w = web.who(req);
  if (!(isAdminReq(req) || (w && !w.account.mustChange && rbac.can(w.account, 'halls.manage')))) return res.status(403).json({ ok: false, error: 'Only admin can create rooms.' });
  const room = newRoom(req.body && typeof req.body.name === 'string' ? req.body.name : '');
  audit.write(w ? web.actorOf(w) : HOST_ACTOR, 'hall.create', room.code, room.name || '(no name)', guard.clientIp(req));
  res.json({ code: room.code, name: room.name });
});
// A guest's code looked up: the room it opens now (a live code, switched on), named with its hall and whether it is the
// hall's Main room, so the join page offers that room's seats. A code that is switched off, an earlier code of a room, a
// key and a code no room has are one answer, and each counts against the lookup's lock: none can be told from another.
app.get('/api/rooms/:code', (req, res) => {
  const key = guard.limitKey(guard.clientIp(req));
  if (!lookupAllowed(key)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  const code = String(req.params.code || '').toUpperCase();
  const room = RoomStore.validCode(code) ? store.byCode(code) : null;
  if (!room || !store.codeOn(room)) {
    lookupLock.fail(key);
    return res.json({ code, exists: false, name: '', locked: false });
  }
  const hall = store.get(room.hall);
  res.json({ code, exists: true, name: room.name || '', locked: !!room.settings.lockRoles, hallName: (hall && hall.name) || '', main: store.isMain(room) });
});

// The halls a signed-in account may see, for its account area (live detail follows on the socket).
app.get('/api/halls', web.signedIn(), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = req.agm.account;
  // Posting and sharing files are asked in each hall's Main room (rbac.canIn); its screens and its Stagewatch are the hall's.
  // Each row's guest code only for an account that may know it (codeFor), with whether it admits guests now, the seat it
  // joins its Main room with, and the hall's side rooms it may enter (sideRoomsFor). The side rooms it may enter in a hall
  // it does not see are listed apart (`rooms`), each by its hall's name, never the hall's key: that is its Main room's
  // address, and its guest code until New code.
  const who = { isAdmin: isAdminReq(req), account: a };
  const halls = [], rooms = [];
  // Whether the board is where this account answers help it may not answer from a room: a side room of a hall it sees,
  // not given it, whose requests come to the hall's crew it is (rbac.answersHelp in the Main room; helpFor), so the halls
  // page is a reason to stay and never one it is taken past straight into its one room.
  let answersOnBoard = false;
  for (const r of store.rooms.values()) {
    if (!rbac.seesHall(a, r.code)) { rooms.push(...sideRoomsApart(who, r)); continue; }
    if (rbac.answersHelp(a, store.scopeOf(r)) && store.roomsOf(r.code).some((x) => !store.isMain(x) && !rbac.seesRoom(a, store.scopeOf(x)))) answersOnBoard = true;
    halls.push({
      code: r.code, name: r.name || '', people: board.peopleIn(r), messages: r.messages.length, locked: !!r.settings.lockRoles,
      can: { post: rbac.canIn(a, 'hall.post', store.scopeOf(r)), files: rbac.canIn(a, 'hall.files', store.scopeOf(r)), displays: rbac.can(a, 'display.control', r.code), stage: rbac.can(a, 'stage.send', r.code) },
      guestCode: codeFor(who, r), codeOn: store.codeOn(r), seat: seatIn(who, r), rooms: sideRoomsFor(who, r),
    });
  }
  halls.sort((x, y) => (x.name || x.code).localeCompare(y.name || y.code));
  rooms.sort((x, y) => x.hallName.localeCompare(y.hallName) || x.name.localeCompare(y.name));
  res.json({ ok: true, halls, account: Accounts.view(a), canManageHalls: rbac.can(a, 'halls.manage'), canManageUsers: mayManageUsers(req), canAudit: rbac.can(a, 'audit.read'), isAdmin: isAdminReq(req), rooms, answersOnBoard });
});

// A hall's name is shown on every page, screen and board, and written in the audit log: it is cleaned as every typed
// name is (no control, bidi override or isolate character), from the admin page's socket and the HTTP route alike.
function newRoom(name) {
  let code;
  do { code = makeRoomCode(); } while (keyHeld(code));
  return store.create(code, guard.cleanText(name, 80));
}
/**
 * A side room of the hall `hall` (its key), named `name` (cleaned by the caller), under a key no room has, with a guest
 * code of its own (`newGuestCode`): its first snapshot written at once, its guest code off (lib/store.js createIn). Null
 * when the hall holds SIDE_MAX rooms beside its Main room already, or is no hall.
 */
function newSideRoom(hall, name) {
  let key;
  do { key = makeRoomKey(); } while (keyHeld(key));
  const made = store.createIn(hall, key, name, { guestCode: newGuestCode() });
  if (made) frames.rooms.mark(made.hall);
  return made;
}
/**
 * A guest code no room holds: 6 characters, never a room's key, a live code or an earlier one (store.codeHeld), nor a key
 * something still names (keyHeld). A side room's, as it is made; any room's, at New code.
 */
function newGuestCode() {
  let code;
  do { code = makeRoomCode(); } while (keyHeld(code));
  return code;
}
/**
 * Whether a new hall or room, or a new guest code, may not take `key`: a room has it, side rooms included; it is a room's
 * guest code, live or earlier (a hall's key is its code until New code, so the two are never shared); or something still
 * names it that would open the new one to whoever held the one before — an account's halls, On stage halls or rooms (one
 * a page saved back after its hall closed, one a room that comes back at the next start keeps), a node linked for a hall,
 * a list of the rooms that may send into a room (as the room listed or as a room on it).
 */
function keyHeld(key) {
  return store.codeHeld(key) || accounts.names(key) || Object.values(settings.peerLinks || {}).some((l) => !!l && l.hall === key) || sendsName(key);
}

// ---------------------------------------------------------------- which rooms may send into a room (plan 1-§4.1)
// `settings.roomSends = {<TARGET key>: [<SOURCE key>, …]}`: for each room, the rooms whose people may send into it, by
// key, never by guest code. A room with no list, and a folder with none at all, sends nothing in (fail closed): the
// field is written only once the admin sets a list, and goes again with the last one. A list read from the file that is
// not one of strings is read as none. `setRoomSends` is its one writer (the rooms module's `room:update {sendFrom}`, and
// a room's removal through `forgetRoomSends`); `sendersOf` its one reader.
const ROOM_SENDS_MAX = 50;
/** A plain object: neither null nor a list. */
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** The keys on `key`'s list as saved: strings, each once, in the order set; none for a room with no list. */
function sendersOf(key) {
  const all = settings.roomSends;
  const list = isRecord(all) && typeof key === 'string' && Object.hasOwn(all, key) ? all[key] : null;
  return Array.isArray(list) ? [...new Set(list.filter((k) => typeof k === 'string' && k.length > 0))] : [];
}
/**
 * The rooms `room`'s people may send into (plan 1-§4.2): each room here, Main or side, of any hall, whose list names it,
 * Main rooms first; none for a room no list names. What `room:sendTargets` lists (by reference, never a key), what
 * `room:send` is allowed into, and the join's `sends`.
 */
function sendsInto(room) {
  return store.allRooms().filter((t) => t !== room && sendersOf(t.code).includes(room.code));
}
/** Whether a list still names `key`, as the room it lists or a room on it (one whose room comes back at the next start). */
function sendsName(key) {
  if (!isRecord(settings.roomSends)) return false;
  return Object.hasOwn(settings.roomSends, key) || Object.keys(settings.roomSends).some((t) => sendersOf(t).includes(key));
}
/**
 * The lists set together and saved once: `next` is {<TARGET key>: [<SOURCE key>, …]}, an empty list taking that room's
 * away. '' when they are set (or `next` names none), else why not, in words, with nothing changed: a list that is not
 * one of keys, one longer than ROOM_SENDS_MAX once its repeats are gone (a list is never cut to fit), or settings this
 * run could not read, which nothing is saved over. Which keys are rooms is the caller's to judge, with its own words.
 */
function setRoomSends(next) {
  if (!isRecord(next)) return 'The lists are given by room.';
  const lists = [];
  for (const [target, list] of Object.entries(next)) {
    if (!target || !Array.isArray(list) || list.some((k) => typeof k !== 'string' || !k)) return 'A list names rooms by their keys.';
    const once = [...new Set(list)];
    if (once.length > ROOM_SENDS_MAX) return 'At most ' + ROOM_SENDS_MAX + ' rooms may send into one room.';
    lists.push([target, once]);
  }
  if (!lists.length) return '';
  if (settingsUnsaved()) return settingsUnsaved();
  const all = isRecord(settings.roomSends) ? { ...settings.roomSends } : {};
  // The rooms whose people now send into more rooms, or fewer: each list's keys taken away or put on.
  const moved = new Set();
  for (const [target, once] of lists) {
    const was = sendersOf(target);
    for (const k of was) if (!once.includes(k)) moved.add(k);
    for (const k of once) if (!was.includes(k)) moved.add(k);
    if (once.length) all[target] = once; else delete all[target];
  }
  if (Object.keys(all).length) settings.roomSends = all; else delete settings.roomSends;
  saveSettings();
  // Each page in such a room asks again where it may send (room:sendTargets): told that, and nothing of any list.
  for (const k of moved) frames.sends.mark(k);
  return '';
}
/**
 * The rooms of `keys`, gone, taken off every list, as a room listed and as a room on a list (plan 1-§1.6), in one save;
 * a list that names none of them is left as it is, and nothing is written when none does. What could not be saved is
 * said on the console: the room is gone either way, and a key no room has sends nothing.
 */
function forgetRoomSends(keys) {
  if (!keys.length || !isRecord(settings.roomSends)) return;
  const gone = new Set(keys);
  const next = {};
  for (const target of Object.keys(settings.roomSends)) {
    const now = sendersOf(target);
    if (gone.has(target)) next[target] = [];
    else if (now.some((k) => gone.has(k))) next[target] = now.filter((k) => !gone.has(k));
  }
  const why = setRoomSends(next);
  if (why) console.error('  [save] the rooms that may send into a room were not updated for a room removed: ' + why);
}
/**
 * The guest code of `room` as `who` may be told it, or '' (plan 1-§2.3: the chips, /api/halls, the halls board, the join's
 * answer, the admin's lists). `who`: `isAdmin` (the laptop's token, or an account that manages settings), `account`,
 * `onStage` (the page asking sits On stage: a Board tablet is handed no code, the admin's included) and `joinedWith` (the
 * code a guest's page typed). The admin is told every room's; an account by its rights there (rbac.mayKnowCode); a guest
 * only the code it joined with while that code is still the room's (a code renewed since is not handed to it).
 */
function codeFor(who, room) {
  const code = store.guestCodeOf(room);
  if (!code || who.onStage) return '';
  if (who.isAdmin) return code;
  if (who.account) return rbac.mayKnowCode(who.account, store.scopeOf(room)) ? code : '';
  return who.joinedWith === code ? code : '';
}
/** One told no code: no admin, no account, typed none. */
const TOLD_NONE = Object.freeze({ isAdmin: false, account: null, onStage: false, joinedWith: '' });
/**
 * The seat `who` ({isAdmin, account}) joins `room` with by its account, the join's own rule wherever a room is listed for
 * it: its rights' in that room (rbac.roomRoleFor: On stage in a hall's Main room its On stage halls name, backstage where
 * it may post, else an observer), and backstage for the admin wherever its account's own rights would seat it an
 * observer, since the admin may post wherever it sits (`allowed`).
 */
function seatIn(who, room) {
  const seat = rbac.roomRoleFor(who.account, store.scopeOf(room));
  return seat === 'observer' && who.isAdmin ? 'research' : seat;
}
/**
 * What a page in `room` is told of its hall: `hall`, the hall's key, for `who` ({isAdmin, account}) who sees the hall or
 * is the admin, else '' (a side room's account that does not see its hall, a code guest: the key is the Main room's
 * address, and its guest code until New code); `hallName`; and `rooms`, the hall's rooms this page may move between
 * (switcherFor), for an account's own page (`page`) alone. The join's answer and the switcher's frame (`frames.rooms`).
 */
function hallFacts(who, room, { page }) {
  const hall = store.get(room.hall);
  if (!hall) return { hall: '', hallName: '', rooms: [] };
  const sees = !!who.isAdmin || (!!who.account && rbac.seesHall(who.account, hall.code));
  return { hall: sees ? hall.code : '', hallName: hall.name || '', rooms: page ? switcherFor(who, hall) : [] };
}
/**
 * The rooms of `hall` an account's page may move between, as the join admits them (the admin every one; an account its
 * hall's Main room by its halls, a side room only where it is given: rbac.seesRoom), the Main room first, each by its key
 * (an address, never a guest code), its name (a Main room's is its hall's), whether it is the Main room, and the seat the
 * account would join with there (seatIn), so its way in opens seated as the join will seat it.
 */
function switcherFor(who, hall) {
  if (!who.account) return [];
  return store.roomsOf(hall.code).filter((r) => who.isAdmin || rbac.seesRoom(who.account, store.scopeOf(r)))
    .map((r) => ({ key: r.code, name: r.name || '', main: store.isMain(r), seat: seatIn(who, r) }));
}
/**
 * The side rooms of `hall` that `who` may enter, as the join admits it: the admin every one, an account the rooms it is
 * given (rbac.seesRoom), never by its halls. Each as /api/halls and the halls board list it: its key (an address, never a
 * guest code), its name, how many people are in, its guest code only for one who may know it (codeFor) with whether it
 * admits guests, and the seat `who` would join with there.
 */
function sideRoomsFor(who, hall) {
  return store.roomsOf(hall.code).filter((r) => !store.isMain(r) && (who.isAdmin || (!!who.account && rbac.seesRoom(who.account, store.scopeOf(r)))))
    .map((r) => ({ key: r.code, name: r.name || '', people: board.peopleIn(r), guestCode: codeFor(who, r), codeOn: store.codeOn(r), seat: seatIn(who, r) }));
}
/**
 * The side rooms of a hall `who` does not see that it may enter, listed apart from the halls: each as sideRoomsFor lists
 * it, with its hall's name after its own (or "A hall with no name"), never the hall's key, which is its Main room's
 * address and its guest code until New code.
 */
function sideRoomsApart(who, hall) {
  return sideRoomsFor(who, hall).map(({ key, name, ...rest }) => ({ key, name, hallName: hall.name || 'A hall with no name', ...rest }));
}
/** Every side room an account may be given, by its key, its name, its hall's key and its hall's name (the Accounts page's). */
function sideRoomNames() {
  const out = [];
  for (const hall of store.rooms.values()) {
    for (const r of store.roomsOf(hall.code)) if (!store.isMain(r)) out.push({ key: r.code, name: r.name || '', hall: hall.code, hallName: hall.name || '' });
  }
  return out;
}
/**
 * Who a page's socket is when it is told a room's guest code (codeFor): the admin, its account, whether it sits On stage,
 * and the code a guest's page typed (a page signed in with an account typed none: it names its room by its key). A socket
 * in no room (the halls board, the admin page) sits nowhere. The admin's support view is told what the person's own page
 * is told (plan R8: it draws exactly the person's doors), read from that person's page in the room, by its name; with no
 * page of theirs there, nothing.
 */
function askerOf(s) {
  const d = s.data || {};
  if (d.adminView) {
    const r = store.room(d.userRoom);
    for (const [sid, u] of r ? r.users : []) {
      const p = u.name === d.userName ? io.sockets.sockets.get(sid) : null;
      if (p && !p.data.adminView) return askerOf(p);
    }
    return TOLD_NONE;
  }
  return { isAdmin: !!d.isAdmin, account: d.account || null, onStage: d.seat === 'board', joinedWith: d.account ? '' : d.joinedAs || '' };
}
/**
 * A room's guest pages now, connected, by their sockets: a code guest's page. An account's page is none, nor is the
 * laptop's token admin's own (it has no account, joins by a code like a guest, and is a member of every room).
 */
function guestSocketsOf(room) {
  const out = [];
  for (const [sid, u] of room.users) {
    const s = u.acct ? null : io.sockets.sockets.get(sid);
    if (s && !s.data.isAdmin) out.push([sid, s]);
  }
  return out;
}
/** How many guest pages are in a room now (guestSocketsOf). */
function guestPagesOf(room) { return guestSocketsOf(room).length; }
/**
 * A room's guest code switched off with its guests sent out, in one meta op: `settings` and no saved seat (every seat a
 * guest held goes, saved ones included; the pages that stay, an account's and the token admin's, hold none: seatsNow).
 * Then each guest page is taken out of the room before it is told why (`kicked`) and closed, so no close writes a seat op
 * of its own, and a page in a drop's grace comes back to no seat: only a code that admits seats it again. Answers how
 * many pages were sent out, or null when the op was refused (nothing changed, nobody sent out).
 */
function sendGuestsOut(room, settings, reason) {
  const out = guestSocketsOf(room);
  if (!apply(room, { o: 'meta', settings: { ...settings, seats: {} } })) return null;
  for (const [sid] of out) room.users.delete(sid);
  const prefix = room.code + '|';
  for (const [k, p] of pendingLeaves) if (k.startsWith(prefix) && p.guest) p.role = null;
  for (const [, s] of out) {
    s.emit('kicked', { reason });
    s.disconnect(true);
  }
  return out.length;
}
/**
 * A room's guest code changed (switched on or off, renewed): each page in it, and each admin page watching it, is told the
 * code as that page may know it (codeFor: '' to one that may not, so a renewed code reaches nobody it is not for) and
 * whether it admits guests now, the newest only (`guestCode`); the halls board is drawn again.
 */
function codeChanged(room) {
  const codeOn = store.codeOn(room);
  for (const sid of io.sockets.adapter.rooms.get(room.code) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('guestCode', { guestCode: codeFor(askerOf(s), room), codeOn });
  }
  boardDirty();
}
/**
 * Why a room of `hall` may not be called `name`: another room of the hall has that name in any case, its Main room's
 * (the hall's) included, so a hall's rooms are told apart by name wherever they are listed or picked. `except` is the
 * room renamed. '' when it may. Made, renamed by the rooms module, and renamed by the hall's Set up, alike.
 */
function roomNameRefused(hall, name, except) {
  const low = name.toLowerCase();
  if (!store.roomsOf(hall.code).some((r) => r !== except && (r.name || '').toLowerCase() === low)) return '';
  return (hall.name || 'This hall') + ' has a room named ' + name + ' already.';
}
/**
 * A room's new name, said to its pages as one numbered change (a meta op) and to the halls board. A hall is its Main
 * room: a Main room's name is its hall's, so its screens are told it too. Null when the op table refused it: nothing was
 * saved or sent.
 */
function renameRoom(room, name) {
  const op = apply(room, { o: 'meta', name });
  if (op && store.isMain(room)) for (const d of displays.ofHall(room.code)) io.to('display:' + d.id).emit('display:state', displayState(d));
  if (op) frames.rooms.mark(room.hall);
  // The rooms that send into it name it by its name and its hall's: a Main room's name is its hall's, so the rooms that
  // send into any room of its hall are told to ask again too.
  if (op) for (const r of store.isMain(room) ? store.roomsOf(room.hall) : [room]) for (const k of sendersOf(r.code)) frames.sends.mark(k);
  return op;
}
/** A room as a row and the AI name it: a side room by its name and its hall's ("Legal (Hall 2)"), a hall by its name. */
function roomInHall(room) {
  const hall = store.get(room.hall);
  const hallName = (hall && hall.name) || 'a hall with no name';
  return store.isMain(room) ? hallName : (room.name || 'a room with no name') + ' (' + hallName + ')';
}
/**
 * The admin's read of a side room it is not given, one `room.read` row: a page entered (a join that names no last
 * change it holds, so never a resume), a watch begun, a transcript, a person's view opened, the AI asked for its minutes
 * (its messages handed over, whatever the AI answers). A room the reader's account lists among its own is read as a
 * member reads it and writes none, and the laptop's token lists none; a hall's Main room is its crew's, as before, and
 * writes none either. `words(name)` says what was done, the room named by `roomInHall`, never what was read.
 */
function readAsAdmin(actor, account, room, words, ip) {
  if (!room || store.isMain(room)) return;
  if (account && rbac.effective(account).rooms.has(room.code)) return;
  audit.write(actor, 'room.read', room.code, words(roomInHall(room)), ip);
}

// ----- uploads (only from people in a room; content must match the name)
const upload = multer({
  storage: multer.diskStorage({
    // A function, not the folder's name: given a name, multer makes the folder as it is built, before this copy holds its
    // data folder. `firstWrites` makes it.
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60) || 'file';
      cb(null, `${Date.now()}-${makeMessageId()}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (req, file, cb) => cb(null, !!guard.UPLOAD_TYPES[guard.extOf(file.originalname)]),
});

let statfsWarned = false;
app.post('/api/upload', async (req, res, next) => {
  const given = String(req.headers['x-agm-upload'] || '');
  const t = uploadTokens.get(given);
  if (!t) return res.status(403).json({ error: 'Join a room to share files.' });
  if (t.revoked || !t.may()) {
    uploadTokens.delete(given);
    return res.status(403).json({ error: UPLOAD_REFUSED[t.seat()] || (t.revoked ? 'Join a room to share files.' : 'Your account may not share files here.') });
  }
  if (!t.bucket.take() || !uploadBuckets.take(t.key)) return res.status(429).json({ error: 'Slow down — one file at a time.' });
  // Before anything is written: a disk short of space keeps it for the messages, the logs and the saves.
  try {
    const st = await fs.promises.statfs(UPLOAD_DIR);
    if (st.bavail * st.bsize < UPLOAD_MIN_FREE) return res.status(507).json({ error: 'The AGMessage laptop is short of disk space, so files are paused. Messages still work.' });
  } catch (e) {
    if (!statfsWarned) { statfsWarned = true; console.warn('  [uploads] free space cannot be read (' + e.code + '): files are not paused when the disk fills'); }
  }
  req.agmUploader = t;
  next();
}, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 25 MB.' : 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'That file type isn\'t supported. PDF, images, Word, Excel, PowerPoint, CSV and text work.' });
    // The stored file, by the name multer gave it (ours, from a cleaned name), held inside the uploads folder.
    const uploadsRoot = path.resolve(UPLOAD_DIR);
    const stored = path.resolve(uploadsRoot, req.file.filename);
    if (!stored.startsWith(uploadsRoot + path.sep)) return res.status(400).json({ error: 'Upload failed.' });
    let head = Buffer.alloc(0);
    try {
      const fd = fs.openSync(stored, 'r');
      head = Buffer.alloc(4096);
      const n = fs.readSync(fd, head, 0, 4096, 0);
      fs.closeSync(fd);
      head = head.subarray(0, n);
    } catch { /* checked below */ }
    const type = guard.uploadType(req.file.originalname, head);
    if (!type) {
      try { fs.unlinkSync(stored); } catch { /* ignore */ }
      return res.status(400).json({ error: 'That file\'s contents don\'t match its type, so it wasn\'t shared.' });
    }
    freshUploads.set(req.file.filename, { at: Date.now(), room: req.agmUploader.room, uid: req.agmUploader.uid });
    res.json({ url: `/uploads/${req.file.filename}`, filename: String(req.file.originalname).slice(0, 120), mime: type.mime.split(';')[0], size: req.file.size });
  });
});

// Errors end in one short JSON line, never a stack trace: a malformed body is the caller's (400), anything else is ours
// (500, logged). Express 5 forwards a rejected async handler here too.
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('  [http] ' + (err && err.stack ? err.stack : err));
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: status === 500 ? 'Server error.' : status === 413 ? 'That request is too large.' : 'Bad request.' });
});

// ---------------------------------------------------------------- Socket.io
const server = http.createServer(app);
// The listening socket: one port, HTTP and HTTPS (the first byte decides) — or plain HTTP only when HTTPS is off. A
// certificate made or renewed once the folder is held is given to it then; until it has one, a TLS handshake is ended.
const front = tlsFound && tlsFound.state !== 'unusable' ? tlsmod.dualPortServer(server, cert ? { certPem: cert.certPem, keyPem: cert.keyPem } : null) : server;
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024,
  pingInterval: 10_000,   // notice a dead phone in seconds, not a minute
  pingTimeout: 8_000,
  // No per-message deflate: a broadcast is framed once and that frame written to every socket, where deflate compressed
  // it again for each. HTTP long-polling keeps engine.io's HTTP compression.
  perMessageDeflate: false,
});

// Connections, per network (`guard.limitKey`: an address on the venue, a /64 for an IPv6 phone through the tunnel): 3 a
// second, bursts of 30, in buckets never reset (past 5,000 networks the fullest go first). Through the tunnel each socket
// then takes one of its places (`tunnelPlaces`), one network half of them at most; a venue socket takes none and is never
// refused for the tunnel. Every refusal says what it refused, to the page (`why`, and its words, which name the wait),
// in health and in the log, and when to try again, `retryMs`, which the page does by itself (public/reconnect.js): the
// rate's never before the bucket holds its next token, never under 1 s, and spread over 2 s more, so the pages behind
// one network do not all come back in the same instant; a place's in 30 to 40 s. A refusal that waiting cannot lift
// says `retry: false`, and the page gives its words instead.
const connBuckets = new guard.Buckets(3, 30, 5000);
const refusal = (words, data) => Object.assign(new Error(words), { data });
const inSeconds = (ms) => Math.ceil(ms / 1000) + ' s.';
const CONNECT_REFUSED = {
  rate: (lane, ms) => (lane === 'tunnel' ? 'Busy — many phones are connecting from your network. Trying again in ' : 'Busy — trying again in ') + inSeconds(ms),
  share: (_lane, ms) => 'Many phones from your network are already connected through the internet (' + tunnelPlaces.share + '). Trying again in ' + inSeconds(ms),
  full: (_lane, ms) => 'AGMessage\'s internet link is full (' + tunnelPlaces.max + ' phones). Trying again in ' + inSeconds(ms) + ' On the venue\'s Wi-Fi there is room.',
};
/** A refusal counted where health and the log read it; one through the tunnel is the day's `peaks.tunnelRefused` too, by kind. */
function noteRefused(lane, why, now = Date.now()) {
  if (refusals.note(lane, why, now) && lane === 'tunnel') peaks.tunnelRefused(why, now);
}

// ---------------------------------------------------------------- pages on another build
// Each page names the build that served it as it connects (its handshake's `build`: /build.js, AGM.reconnect.auth), and
// every answer a page reads its server's build from carries this one (a hall's join, the halls board's watch, the admin
// page's settings, a screen's state): a page on another build reloads itself at a quiet moment it names
// (public/reconnect.js). A page's build is its own word: no right hangs on it, and it is read only to list the pages on
// another build ("This laptop") and to reach 0.5.1's pages, which name none.
/** The build a page named as it connected: null when it named none (0.5.1's pages and screens); '' when it named something that is not a build. */
function announcedBuild(auth) {
  const b = auth && typeof auth === 'object' ? auth.build : undefined;
  if (b === undefined) return null;
  return typeof b === 'string' && parseBuild(b) ? b : '';
}
/**
 * What a 0.5.1 page is told so it loads this build's scripts: its hall page, its halls board and its admin page each
 * reload on account:changed. A 0.5.1 screen has no such path: it keeps working on its own protocol, listed as a 0.5 screen.
 */
const UPDATED = Object.freeze({ what: 'build', words: 'AGMessage was updated — reloading.' });
// 0.5.1 served its pages, scripts and styles fresh for 5 minutes (maxAge), and a browser's reload asks the server again
// only for the page itself: a 0.5.1 page told sooner could reload into this build's page with 0.5.1's scripts taken from
// its cache again, and name no build again. Every answer 0.5.1 gave came before this process started, so OLD_CACHE_MS
// after it none can be fresh in any browser: a 0.5.1 page is told only from then on (each open then at once, each later
// one as it connects), once a socket, and its reload loads this build whole, so it is never told again.
const OLD_CACHE_MS = Math.max(1000, Number(process.env.AGM_OLD_CACHE_MS) || 5 * 60_000);
const OLD_CACHE_AT = BOOT_AT + OLD_CACHE_MS;
let oldCacheOver = false;
/** A screen's socket (its link in the handshake), known or not: it has no reload path to be told of. */
const screenSocket = (s) => !!(s.data.display || (s.handshake.auth && s.handshake.auth.display));
/** Tell a 0.5.1 page (no build named; not a screen) to reload, once: true when told now. */
function tellOld(socket) {
  if (socket.data.build !== null || socket.data.toldOld || screenSocket(socket)) return false;
  socket.data.toldOld = true;
  socket.emit('account:changed', UPDATED);
  return true;
}
setTimeout(() => {
  oldCacheOver = true;
  for (const s of io.sockets.sockets.values()) tellOld(s);
}, OLD_CACHE_MS).unref();
/** The Pages row's facts: every open page on another build, and while 0.5.1's files may still be fresh, when they are not. */
const pagesFacts = () => ({ list: pagesElsewhere(), oldAt: oldCacheOver ? '' : tunnelend.clockOf(OLD_CACHE_AT) });
const PAGE_KINDS = ['screen', 'hall', 'halls', 'admin', 'page'];
/**
 * Every open page that is not on this build, as "This laptop" lists it (lib/laptop.js pagesRow): what it is (a screen, a
 * hall page, a halls board, the admin page, or a page that has not yet said which), where (its screen, its hall) and who
 * (a hall page's person, a board's or admin page's account), and the build it named (null: none, a 0.5 page).
 */
function pagesElsewhere() {
  const out = [];
  for (const s of io.sockets.sockets.values()) {
    const d = s.data || {};
    if (d.build === BUILD.full) continue;
    const kind = d.display ? 'screen' : d.userRoom ? 'hall' : boardSockets.has(s) ? 'halls' : d.adminPage ? 'admin' : 'page';
    const screen = d.display ? displays.get(d.display) : null;
    // A screen's hall, or the room a hall page is in: a side room by its hall's name and its own ("Hall 2 › Legal").
    const at = screen ? store.get(screen.hall) : store.room(d.userRoom || '');
    const place = !at ? '' : store.isMain(at) ? at.name || '' : ((store.get(at.hall) || {}).name || '') + ' › ' + (at.name || '');
    const who = kind === 'hall' ? d.userName || '' : d.account ? d.account.name || d.account.username : d.adminSid ? 'the laptop\'s token' : '';
    const build = typeof d.build === 'string' ? d.build : null;
    out.push({ kind, build, newer: build ? compareBuilds(build, BUILD.full) : null, where: screen ? screen.name || '' : '', hall: place, who: String(who || '') });
  }
  return out.sort((a, b) => PAGE_KINDS.indexOf(a.kind) - PAGE_KINDS.indexOf(b.kind));
}

io.use((socket, next) => {
  const ip = guard.clientIp({ socket: socket.conn, headers: socket.handshake.headers, conn: socket.conn });
  const key = guard.limitKey(ip);
  const lane = guard.laneOf(ip);
  Object.assign(socket.data, { ip, key, lane, build: announcedBuild(socket.handshake.auth) });
  socket.data.viaTunnel = web.throughTunnel({ headers: socket.handshake.headers });
  if (settings.requireHttps && cert && !(socket.request && (isEncrypted(socket.request) || isLoopback(socket.request))))
    return next(refusal('This AGMessage requires HTTPS — open it with https:// (see /tls).', { retry: false }));
  const now = Date.now();
  if (!connBuckets.take(key, now)) {
    const ms = Math.max(connBuckets.waitMs(key, 1, now), 1000) + crypto.randomInt(0, 2000);
    noteRefused(lane, 'rate', now);
    return next(refusal(CONNECT_REFUSED.rate(lane, ms), { retryMs: ms, why: 'rate' }));
  }
  // A connection already gone is never seated, so it takes no place.
  if (lane !== 'tunnel' || socket.conn.readyState !== 'open') return next();
  const why = tunnelPlaces.take(key);
  if (why) {
    const ms = 30_000 + crypto.randomInt(0, 10_000);
    noteRefused(lane, why, now);
    return next(refusal(CONNECT_REFUSED[why](lane, ms), { retryMs: ms, why }));
  }
  // The place is given back once, when the socket goes: its disconnect, or its connection's close for a socket closed
  // before it was seated (which has no disconnect).
  let held = true;
  const giveBack = () => { if (held) { held = false; tunnelPlaces.drop(key); } };
  socket.once('disconnect', giveBack);
  socket.conn.once('close', giveBack);
  return next();
});

// Wrong codes at join: 10 a minute per network. Through the tunnel one network is often many phones (a carrier's shared
// address), so its words say it is the network's, not the phone's.
const joinLock = new guard.Lockout(10, 60_000);
let aiRunning = 0;
const AI_MAX_CONCURRENT = 3;

/**
 * Every event a socket sends reaches its handler through here, so what a client sends can refuse that one request
 * but never end the process for everyone. A null argument arrives as undefined (a handler's `= {}` default then
 * applies), and a handler that throws or rejects is answered with a refusal, logged and counted (admin health),
 * instead of reaching the uncaught-exception path and the watchdog. `socket.off` still finds a guarded listener.
 */
function guardHandlers(socket) {
  const on = socket.on.bind(socket);
  socket.on = (event, fn) => {
    const guarded = (...args) => {
      const clean = args.map((a) => (a === null ? undefined : a));
      const ack = typeof clean[clean.length - 1] === 'function' ? clean[clean.length - 1] : null;
      const refuse = (e) => {
        noteFault('socket', String(event).slice(0, 40), e);
        if (ack) { try { ack({ ok: false, error: 'That request could not be handled.' }); } catch { /* the client has gone */ } }
      };
      // Input on a seated page makes this copy busy for the window (lib/busy.js), whatever its handler answers.
      if (busy.INPUT.has(event)) { const page = seatedPage(socket); if (page) activity.note(page, Date.now()); }
      try {
        const r = fn(...clean);
        if (r && typeof r.then === 'function') r.then(undefined, refuse);
        return r;
      } catch (e) { refuse(e); return undefined; }
    };
    guarded.listener = fn.listener || fn;
    return on(event, guarded);
  };
  return socket;
}

io.on('connection', (socket) => {
  guardHandlers(socket);
  // A display's browser: it may only receive what its own display shows and say what it showed — nothing else is
  // listened to on this socket (fail closed).
  const displayToken = socket.handshake.auth && typeof socket.handshake.auth.display === 'string' ? socket.handshake.auth.display : '';
  if (displayToken) { serveDisplay(socket, displayToken); return; }
  // A 0.5.1 page connecting once none of 0.5.1's files can still be fresh in its browser: told to reload now.
  if (oldCacheOver) tellOld(socket);
  let room = null;
  let me = null;   // {uid, name, role}
  // Who this is: the host's admin token, a signed-in account (both from the handshake's cookies), or nobody yet — a
  // guest code at 'join'. Rights are read once here, with the session they came from: a change to the account
  // (accountChanged), the session ending (sign-out, expiry: endSockets, sweepSessions) or admin through the tunnel turned
  // off ends this socket, and the next connection is judged afresh.
  const hs = { headers: socket.handshake.headers, socket: socket.request && socket.request.socket };
  const adminSid = guard.readCookie(hs.headers.cookie, 'agm_admin') || '';
  const tokenAdmin = tokenSessions.has(adminSid);
  const acct = web.who(hs);
  socket.data.account = acct && !acct.account.mustChange ? acct.account : null;
  socket.data.accountId = socket.data.account ? socket.data.account.id : '';
  socket.data.sessionHash = socket.data.account ? acct.session.h : '';
  socket.data.adminSid = tokenAdmin ? adminSid : '';
  socket.data.isAdmin = tokenAdmin || !!(socket.data.account && rbac.can(socket.data.account, 'settings.manage') && !web.adminBlocked(hs, socket.data.account));
  socket.data.actor = tokenAdmin ? HOST_ACTOR : socket.data.account ? { t: 'account', id: socket.data.account.id, name: socket.data.account.username } : null;
  // The account this browser is signed in as (a one-time password not yet changed included), for the words of a code
  // join it is refused; empty for the host token's admin, who has no account.
  const signedInAs = acct && !tokenAdmin ? (acct.account.name || acct.account.username) : '';
  // A place through the tunnel is for a page in a room: a socket that carries no account and not the admin's token (a
  // screen's returned above) and has not joined a room within TUNNEL_JOIN_MS is let go, and counted. A hall page joins as
  // it connects; one that never does is a probe or a stuck page, and a page that connects again is counted afresh.
  let joinWait = null;
  if (socket.data.lane === 'tunnel' && !tokenAdmin && !socket.data.account) {
    joinWait = setTimeout(() => {
      joinWait = null;
      if (room || !socket.connected) return;
      noteRefused('tunnel', 'idle');
      socket.disconnect(true);
    }, TUNNEL_JOIN_MS);
    joinWait.unref();
  }
  const writes = new guard.Bucket(5, 15);      // messages, reactions, pins…
  const chatter = new guard.Bucket(10, 20);    // seen, ui sync, a screen identified, help answered
  const aiBucket = new guard.Bucket(0.2, 4);   // one AI request per 5 s, bursts of 4
  const uploadBucket = new guard.Bucket(0.5, 4);   // files from this connection, whichever hall or token
  let uploadToken = null;
  const ok = (ack) => (typeof ack === 'function' ? ack : () => {});
  // `busy` says the refusal is the rate's, not the request's: the outbox keeps a held send and sends it again shortly. Its
  // words are the gate's bucket step's (lib/gate.js), so a verb here and a verb in a handler module say one thing.
  const limited = (ack) => { ok(ack)({ ok: false, error: GATE_WORDS.slow, busy: true }); };
  // The socket's seat: set at join, changed by admin:setRole, never by the page. The admin's support view is unseated
  // (adminView), so it is never On stage. A seat is keyed on the socket: the same person keeps their rights on a page
  // where they sit backstage, and is limited only on the page where they sit On stage.
  const onStage = () => !!me && socket.data.seat === 'board' && !socket.data.adminView;
  // What this connection's rights allow in a room, by that room's own scope and never by a seat: the admin (the laptop's
  // token, or an account that manages settings) every right; an account by its rights in that room (rbac.canIn: a hall's
  // Main room by its halls, a side room by its own rooms or the admin role); a code guest none (its rights are its seat's,
  // `allowed`, in the room it sits in). It reads no seat, so it answers for another room: what a verb may do in the room
  // it sits in is asked of `allowed` (the gate's `may`), which reads the seat's limit first.
  const canIn = (cap, r) => !!r && (!!socket.data.isAdmin || (!!socket.data.account && rbac.canIn(socket.data.account, cap, store.scopeOf(r))));
  // The kind of room a code guest's seat is read by (rbac.guestCaps): a hall's Main room, or a side room.
  const kindOf = (r) => (store.isMain(r) ? 'main' : 'side');
  // What this person may do in the room they are in: an account by its rights in that room, a code guest by the role
  // they joined with and the kind of room (rbac.guestCaps), the admin everything. The seat's limit comes first
  // (rbac.SEAT_LIMITS): On stage holds only messages, for the admin seated there too.
  const allowed = (cap) => {
    if (onStage() && !rbac.seatAllows('board', cap)) return false;
    if (socket.data.isAdmin) return true;
    if (!me || !room) return false;
    if (me.acct) return canIn(cap, room);
    return rbac.guestCaps(me.role, kindOf(room)).includes(cap);
  };
  // Who an audit row names for what this socket does: the admin token, the account, or a code guest by the name they joined with.
  const actor = () => socket.data.actor || (me ? { t: 'code', id: me.uid, name: me.name } : HOST_ACTOR);
  // The one gate (lib/gate.js): seated in a room that is still here, then a token of the verb's bucket, then the admin,
  // then the verb's rights, each step read only once the one before it passed, each refused in its words. `need`,
  // `mayPost` and `admin` below are its steps alone, so the verbs written here answer in the gate's words, and a verb in a
  // handler module (lib/handlers/) passes it whole, first (conn.gate).
  const gate = gateOf({ joined: () => !!room && !!me, here: () => store.hasRoom(room.code), isAdmin: () => !!socket.data.isAdmin, allowed, onStage });

  socket.on('join', (args, ack) => {
    ack = ok(ack);
    const { roomCode, name, role, adminView, uid, since, invite } = args || {};
    const network = socket.data.key;   // the lock counts per network (guard.limitKey)
    if (joinLock.locked(network)) {
      if (socket.data.lane !== 'tunnel') return ack({ ok: false, error: 'Too many attempts — wait a minute.' });
      noteRefused('tunnel', 'wrongCode');
      return ack({ ok: false, error: 'Too many wrong codes from your network — wait a minute.' });
    }
    const code = guard.str(roomCode).toUpperCase().trim();
    const acct = (args && args.as === 'account') ? socket.data.account : null;
    if (args && args.as === 'account' && !acct) return ack({ ok: false, error: 'Sign in first.', signIn: true });
    const isAdminView = !!adminView && socket.data.isAdmin;
    // A signed-in browser is its account in every hall: a code would seat it as a guest with the code's rights, beside
    // or above its own. Not code guessing, so the lock is not spent. The admin's support view and the host token's
    // admin (no account) are not code joins.
    if (!acct && !isAdminView && signedInAs) return ack({ ok: false, error: 'You are signed in as ' + signedInAs + ': open the room from your halls, or sign out to join with a code.', signedIn: true });
    // The role is one the page offers, or none (the page's default, observer); 'director' is its old name. Anything
    // else is refused, never seated as something it did not ask for. An account's role is its rights', not its word.
    let cleanRole = role === undefined || role === null ? 'observer' : role === 'director' ? 'board' : role;
    if (!acct && !ROLES.includes(cleanRole)) return ack({ ok: false, error: 'Choose On stage, Backstage or Observer.' });
    const cleanName = acct ? acct.name : guard.cleanText(name, 40);
    if (!code || !cleanName) return ack({ ok: false, error: 'Missing room code or name' });
    // An account and the admin's support view name a room by its key, a hall's Main room or a side room. A guest names it
    // by its guest code: the room's live code, or an earlier one of it (`retired`); a key is an address, never a code a
    // guest types (a hall's key is its code only until New code).
    // The laptop's token admin has no account, so its own page joins as a guest does; it is a member of every room (plan
    // 1-§0.3): a code admits it whether it is on or off, live or earlier, a key does too, and its misses spend no lock.
    const tokenPage = !acct && !isAdminView && !!socket.data.isAdmin;
    const valid = RoomStore.validCode(code);
    const live = valid && !acct && !isAdminView ? store.byCode(code) : null;
    const earlier = valid && !acct && !isAdminView && !live ? store.byRetired(code) : null;
    const r = !valid ? null : acct || isAdminView ? store.room(code) : live || earlier || (tokenPage ? store.room(code) : null);
    if (!r) { if (!tokenPage) joinLock.fail(network); return ack({ ok: false, error: 'Room not found' }); }

    // The same page joining again on its own socket (it saw a gap in the room's numbers and is catching up) is still
    // seated: it keeps its role and the admin's links, nobody is told it joined, and a lock ticked since does not unseat it.
    const seated = (who) => !isAdminView && room === r && !!me && r.users.get(socket.id) === me && me.uid === who && me.name === cleanName;

    // Identity: an account is itself on every device; anyone else gets one issued (and signed) by the server.
    let id, identity = null;
    let note = '';
    if (acct) {
      // The admin first; then the account's rights in that room (rbac.seesRoom): a hall's Main room by its halls, a side
      // room only by its own rooms or the admin role, never by its halls, every hall's included. Not code guessing, so
      // the lock is not spent.
      if (!(socket.data.isAdmin || rbac.seesRoom(acct, store.scopeOf(r)))) return ack({ ok: false, error: 'Your account has no access to this ' + (store.isMain(r) ? 'hall' : 'room') + ' — ask an admin.' });
      id = acct.id;
      // The seat is its rights' in that room (rbac.roomRoleFor). The admin may post wherever it sits (`allowed`), so its
      // seat says so: backstage where its account's own rights would seat it an observer (a side room it is not given, a
      // hall its halls do not list, a hall where they only read), On stage where its On stage halls seat it (seatIn).
      cleanRole = seatIn({ isAdmin: !!socket.data.isAdmin, account: acct }, r);
    } else {
      id = guard.checkIdentity(SECRET, uid);
      if (!id) { identity = guard.newIdentity(SECRET); id = guard.checkIdentity(SECRET, identity); }
      // The code admits: the room's live code while it is switched on. A code switched off or an earlier one admits only a
      // person who holds a seat there (a drop's grace, a restart's first seconds), so "Turn off" keeps who is in and New
      // code keeps whoever reconnects. Anyone else is told what a wrong code is told; an earlier code spends no lock, so
      // a hall full of phones coming back on the old code behind one address is not locked out.
      // The admin's support view (the laptop's token has no account) names the room by its key, and seats nobody; the token
      // admin's own page is admitted (tokenPage).
      if (!isAdminView && !tokenPage && !((live && store.codeOn(r)) || seated(id) || holdsSeat(r, id, cleanName, cleanRole))) {
        if (!earlier) joinLock.fail(network);
        return ack({ ok: false, error: 'Room not found' });
      }
      // A side room has no stage: its seats are a Member's (backstage) and an observer's. Not code guessing: no lock.
      if (!isAdminView && !store.isMain(r) && cleanRole === 'board') return ack({ ok: false, error: ON_STAGE_IN_MAIN });
      // Seated already: the role stays. Otherwise, in a locked room, board and research seats need the admin's invite link
      // (made with the room's guest code, so a renewed code voids it) or a seat this person already holds there.
      if (seated(id)) cleanRole = me.role;
      else if (r.settings.lockRoles && cleanRole !== 'observer' && !socket.data.isAdmin && !guard.checkInvite(SECRET, store.guestCodeOf(r), cleanRole, invite) && !holdsSeat(r, id, cleanName, cleanRole)) {
        cleanRole = 'observer';
        note = 'This room needs an invite link for that seat — you joined as an observer.';
      }
      // A code guest cannot take the name of someone with an account: staff are who they say they are.
      if (!isAdminView && accounts.list().some((a) => a.name.toLowerCase() === cleanName.toLowerCase())) {
        joinLock.fail(network);
        return ack({ ok: false, error: 'That name belongs to an AGMessage account: sign in, or pick another name.' });
      }
    }

    if (!isAdminView) {
      for (const u of r.users.values()) {
        if (u.name.toLowerCase() === cleanName.toLowerCase() && u.uid !== id && !acct) {
          return ack({ ok: false, error: 'That name is already in use in this room. Please pick a different display name.' });
        }
      }
    }
    joinLock.ok(network);

    const stillSeated = seated(id);
    if (joinWait) { clearTimeout(joinWait); joinWait = null; }   // in a room: its place through the tunnel is kept
    // A page seated in a room that joins another room of its hall on its own socket, as the same person (its identity and
    // its name), moves: said in neither room. Anyone else it now names is a person of their own, said as they join.
    const moved = !!room && room !== r && room.hall === r.hall && !!me && me.uid === id && me.name === cleanName && !socket.data.adminView && !isAdminView;
    if (room && room !== r) leaveRoom(true, false, moved);
    if (!stillSeated) me = { uid: id, name: cleanName, role: cleanRole, joinedAt: Date.now(), ...(acct ? { acct: acct.username } : {}) };
    room = r;
    socket.data.adminView = isAdminView;
    socket.data.seat = isAdminView ? '' : me.role;
    socket.data.userName = cleanName;
    socket.data.uid = id;
    // The room by its key, whatever the page named it by: its pages, seats and people are the room's.
    socket.data.userRoom = r.code;
    // What the page named its room by: an account's page and the support view its key, a guest's the guest code it typed.
    // A verb that names its own room so is read as the room it sits in (help:respond), and a guest is told that code alone.
    socket.data.joinedAs = code;
    socket.join(r.code);

    // A page back after the restart this process booted from names the last change it holds, and this hall has it: the
    // restart line already says what happened, so it is not announced again. Presence words only: no right reads it.
    let returning = stillSeated || (Date.now() - BOOT_AT < BOOT_SEAT_MS && Number.isInteger(since) && since >= 0 && since <= r.seq);
    if (!isAdminView) {
      const k = r.code + '|' + id;
      if (pendingLeaves.has(k)) { clearTimeout(pendingLeaves.get(k).timer); pendingLeaves.delete(k); returning = true; }
      // A move between rooms of the hall (on this socket, or from a page that left another of its rooms within the
      // grace): announced in neither.
      if (moved || movedWithinHall(r, id, cleanName)) returning = true;
      // The same person on another device or tab stays in (and this one is not announced again); only a socket that
      // has already gone is cleared.
      for (const [sid, u] of r.users) {
        if (u.uid !== id || sid === socket.id) continue;
        if (io.sockets.sockets.has(sid)) returning = true;
        else r.users.delete(sid);
      }
      r.users.set(socket.id, me);
      trackJoin(id, r.code);
      joinBurst.add(r.code, performance.now());
    }

    if (uploadToken) uploadTokens.delete(uploadToken);
    uploadToken = null;
    if (allowed('hall.files')) {
      uploadToken = crypto.randomBytes(18).toString('base64url');
      // Checked again at use, and ended by admin:setRole's move to a seat that shares no file (found by `sid`).
      uploadTokens.set(uploadToken, { room: r.code, uid: id, sid: socket.id, bucket: uploadBucket, key: socket.data.key, may: () => allowed('hall.files'), seat: () => socket.data.seat, revoked: false });
    }

    // The admin entering a side room it is not given reads it: one row for a page's first join, never for a resume (a
    // join that names the last change it holds) or a page catching up on its own socket.
    if ((acct || isAdminView) && !stillSeated && !Number.isInteger(since)) {
      readAsAdmin(actor(), socket.data.account, r, (n) => (isAdminView ? 'opened ' + cleanName + '\'s view of ' + n : 'entered ' + n + ' as the admin'), socket.data.ip);
    }
    // Resume: just what they missed, when we still have it; otherwise the whole history. Each as a page is sent it
    // (lib/ops.js forPage): a stage send's and a proposal's record without the link it went to, which names the hall's key.
    const missed = Number.isInteger(since) ? store.opsSince(r, since) : null;
    // Every room of a hall follows its hall's Stagewatch: its countdown, and its sends and proposals by this seat's rights
    // there (a side room's guest holds none; an account its stage.send in the hall), as the frames sent to it do.
    const sw = linkFor(r.hall);
    ack({
      ok: true, roomCode: code, roomName: r.name || '', role: cleanRole, name: cleanName, adminView: isAdminView,
      identity, uid: id, note, uploadToken, seq: r.seq,
      ...(missed ? { ops: missed.map(ops.opForPage) } : { history: r.messages.map(ops.forPage) }),
      users: roomUserSummary(r, { links: socket.data.isAdmin }),
      ai: !!aiKey(), stage: stagePayload(sw),
      canSendToStage: !!(sw.base && sw.key && sw.keyState !== 'refused') && allowed('stage.send'),
      canPropose: !!(sw.desk && sw.key && !sw.deskRefusal) && allowed('stage.send'),
      account: acct ? { username: acct.username, name: acct.name, role: acct.role, roleLabel: rbac.ROLES[acct.role].label } : null,
      seen: seenFor(r),
      // Whether a message here could be sent to another hall (the forward picker would list one): a fact the page's
      // ↗ Send to reads, false On stage, where nothing leaves the room. The support view is unseated: it has none.
      forwardable: !isAdminView && forwardTargets(null).rooms.length > 0,
      // Whether this is the hall's Main room: a side room's seats are a Member's and an observer's, said so on its page.
      main: store.isMain(r),
      // The room's guest code for its code chip, only for one who may know it ('' else: codeFor; the support view the
      // person's), whether it admits guests now, and whether this page may switch it and renew it: the admin's own page,
      // not On stage, that names the room by its key (room:update's own checks); never the support view, which acts on
      // nothing (R8).
      guestCode: codeFor(askerOf(socket), r), codeOn: store.codeOn(r), setsCode: !!socket.data.isAdmin && !isAdminView && !onStage() && code === r.code,
      // The build serving now: a page on another build reloads itself at a quiet moment (public/reconnect.js).
      build: BUILD.full,
      // The room's hall, as its header names it ("Hall 2 › Legal"; a Main room by the hall's name): its key only for one
      // who sees the hall or is the admin (an account given a side room alone is told its name), and the rooms of it this
      // page may move between, its switcher's (switcherFor: an account's page; none for a code page or the support view).
      ...hallFacts(askerOf(socket), r, { page: !!acct && !isAdminView }),
      // Whether a message here could be sent into another room by its list (room:sendTargets would list one): the page
      // offers To: and the rooms of ↗ Send to only then. False On stage, where nothing leaves the room, for a seat that
      // may not post, and for the support view, which is unseated.
      sends: !isAdminView && !onStage() && allowed('hall.post') && sendsInto(r).length > 0,
      // Whether this is the admin's own page (never its support view): the admin takes back any send this room made
      // (room:withdraw), wherever it does not sit On stage, where its seat's limit holds it as anyone's.
      admin: !!socket.data.isAdmin && !isAdminView,
    });

    if (!isAdminView) {
      if (!acct) syncSeats(r);
      if (!returning) systemMessage(r, `${cleanName} ${joinedWords(r, cleanRole)}`);
      emitUsers(r);
      boardDirty();
    } else {
      io.in(r.code).fetchSockets().then((peers) => {
        for (const p of peers) if (p.id !== socket.id && p.data.userName === cleanName && !p.data.adminView) p.emit('userState:request');
      }).catch(() => {});
    }
  });

  // Seated in a room that is still here ("Not joined", "Room gone"): the gate's first step alone. A verb written here takes
  // its bucket after it, in its own line.
  const need = (ack) => gate(ack, { bucket: null });
  // Posting, answering a prompt, pinning and reacting change what everyone in the hall sees: they need hall.post.
  // Someone who may only read (an observer, a Viewer account) is refused, and nothing reaches the hall: the gate's right
  // alone, read wherever the verb reads it.
  const mayPost = (ack) => gate(ack, { joined: false, bucket: null, may: 'hall.post' });
  // A question (an action prompt) is asked of the Board by the backstage team: an On stage seat answers, never asks.
  const mayAsk = () => allowed('hall.post') && !onStage();
  // Screens, a hall's set-up and the show network are driven from a backstage page: On stage, each is refused first,
  // in one sentence, whatever its own check would say.
  const backstage = (ack) => {
    if (!onStage()) return true;
    ok(ack)({ ok: false, error: 'Do that from a backstage page.' });
    return false;
  };
  // What a seat On stage writes stays in its room's feed (owner answer B2): a forward of anything is refused.
  const STAYS_HERE = 'Messages from On stage stay in this room.';
  // The two rules of the room a forward comes from, in the words the forward and its picker both answer with.
  const FILES_BACKSTAGE = 'Files are moved by the backstage team.';
  const ASKS_BACKSTAGE = 'Questions for the Board come from the backstage team.';
  // A message another room sent here stays while this room holds it: its author removes no message here by `delete`, but
  // takes it back from the room it came from (room:withdraw, on that room's copy), and the admin removes it here.
  const SENT_STAYS = 'A message sent from another room stays here: its sender withdraws it from that room, or the admin removes it.';

  // A send is said once: a repeat of a send (its client id, from the same person) is answered with what the first one
  // became, before any limit or right is read, since it asks for nothing new — never refused for what succeeded.
  socket.on('message', (payload, ack) => {
    if (!need(ack)) return;
    const sent = readSend(payload, { held: true });
    if (sent.error) return ok(ack)({ ok: false, error: sent.error });
    const was = sent.cid ? store.sentAs(room, me.uid, sent.cid) : null;
    if (was) return ok(ack)(was.gone ? { ok: true, id: was.id, seq: was.seq, gone: true } : { ok: true, id: was.id, seq: was.seq });
    if (!writes.take()) return limited(ack);
    if (!mayPost(ack)) return;
    if (payload && payload.type === 'file' && !allowed('hall.files')) return ok(ack)({ ok: false, error: onStage() ? 'On stage seats send messages, not files.' : 'Your account may not share files here.' });
    if (payload && payload.type === 'action' && !mayAsk()) return ok(ack)({ ok: false, error: ASKS_BACKSTAGE });
    const built = messageOf(me, payload, room, sent);
    if (built.refused) return ok(ack)({ ok: false, ...built.refused });
    const msg = built.msg;
    if (payload.replyTo && typeof payload.replyTo === 'string') {
      const parent = room.byId.get(payload.replyTo);
      if (parent) {
        msg.replyTo = {
          id: parent.id, name: (parent.from && parent.from.name) || 'system',
          snippet: parent.text ? parent.text.slice(0, 120) : parent.filename ? '📄 ' + parent.filename : '',
        };
      }
    }
    if (!apply(room, { o: 'add', m: msg })) return ok(ack)(OP_REFUSED);
    ok(ack)({ ok: true, id: msg.id, seq: msg.seq });
  });

  socket.on('actionResponse', ({ messageId, optionIndex, note } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    if (!mayPost(ack)) return;
    const msg = room.byId.get(messageId);
    if (!msg || msg.type !== 'action') return ok(ack)({ ok: false, error: 'Action prompt not found' });
    const responses = (msg.responses || []).filter((r) => (r.uid ? r.uid !== me.uid : r.name !== me.name));
    const idx = Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < (msg.options || []).length ? optionIndex : -1;
    responses.push({ uid: me.uid, name: me.name, role: me.role, optionIndex: idx, note: typeof note === 'string' ? note.slice(0, 200) : '', at: Date.now() });
    if (!apply(room, { o: 'upd', id: msg.id, f: { responses } })) return ok(ack)(OP_REFUSED);
    ok(ack)({ ok: true });
  });

  socket.on('pin', ({ messageId, pinned } = {}, ack) => {
    if (!need(ack)) return;
    if (!writes.take()) return limited(ack);
    if (!mayPost(ack)) return;
    if (!room.byId.has(messageId)) return ok(ack)({ ok: false, error: 'Message not found' });
    if (!apply(room, { o: 'upd', id: messageId, f: { pinned: !!pinned } })) return ok(ack)(OP_REFUSED);
    ok(ack)({ ok: true });
  });

  socket.on('delete', ({ messageId } = {}, ack) => {
    if (!need(ack)) return;
    const msg = room.byId.get(messageId);
    // Its author asking again for a message already removed is told it is done, never refused for what succeeded.
    const tomb = msg ? null : store.removed(room, messageId);
    if (tomb && tomb.uid === me.uid) return ok(ack)({ ok: true, already: true });
    if (!msg) return ok(ack)({ ok: false, error: 'Message not found' });
    if (msg.type === 'system') return ok(ack)({ ok: false, error: 'Cannot delete system message' });
    // A message another room sent here is not its author's to delete from this room (plan 1-§4.3): the copy kept where it
    // came from says "delivered", which stays true while this room holds it. Its sender withdraws it from there; only the
    // admin removes it here.
    if (msg.sentFrom) return ok(ack)({ ok: false, error: SENT_STAYS });
    if (!msg.from || !msg.from.uid || msg.from.uid !== me.uid) return ok(ack)({ ok: false, error: 'Only the author can delete this message' });
    if (!apply(room, { o: 'del', id: messageId })) return ok(ack)(OP_REFUSED);
    removeUnused(fileNamesOf([msg])).catch(() => { /* a file left behind is only space */ });
    ok(ack)({ ok: true });
  });

  // `on` sets the person's reaction (true) or takes it away (false), so a repeat changes nothing and is answered
  // `already`; without it the reaction is toggled, as a page cached across the upgrade expects.
  socket.on('react', ({ messageId, emoji, on } = {}, ack) => {
    if (!need(ack)) return;
    if (!mayPost(ack)) return;
    const msg = room.byId.get(messageId);
    if (!msg) return ok(ack)({ ok: false, error: 'Message not found' });
    if (typeof emoji !== 'string' || !emoji.length || emoji.length > 8 || /[<>&"'\s]/.test(emoji)) return ok(ack)({ ok: false, error: 'Bad emoji' });
    if (on !== undefined && on !== null && typeof on !== 'boolean') return ok(ack)({ ok: false, error: 'Say whether to add the reaction or take it away.' });
    const reactions = (msg.reactions || []).slice();
    const i = reactions.findIndex((r) => r.uid === me.uid && r.emoji === emoji);
    const want = typeof on === 'boolean' ? on : i < 0;
    if (want === i >= 0) return ok(ack)({ ok: true, already: true });
    if (!writes.take()) return limited(ack);
    if (i >= 0) reactions.splice(i, 1);
    else { if (reactions.length >= 200) return ok(ack)({ ok: false, error: 'Too many reactions' }); reactions.push({ uid: me.uid, name: me.name, emoji, at: Date.now() }); }
    if (!apply(room, { o: 'upd', id: messageId, f: { reactions } })) return ok(ack)(OP_REFUSED);
    ok(ack)({ ok: true });
  });

  // Seen receipts: the board knows research saw it, research knows the board read the answer. Each person's newest is
  // kept, and the hall hears the receipts that moved in one frame per second at most (`frames.seen`).
  socket.on('seen', ({ seq } = {}) => {
    if (!room || !me || socket.data.adminView || !chatter.take()) return;
    if (!Number.isInteger(seq) || seq < 0 || seq > room.seq) return;
    room.seen = room.seen || new Map();
    const prev = room.seen.get(me.uid);
    if (prev && prev.seq >= seq) return;
    room.seen.set(me.uid, { uid: me.uid, name: me.name, role: me.role, seq });
    frames.seen.mark(room.code, new Set([me.uid]));
  });

  // Forwarding posts in another room, so the person's rights there decide, never the room the message comes from: an
  // account goes by its rights in that room (a side room's only by its own rooms or the admin role) and by the seat it
  // would sit there (rbac.roomRoleFor), whose limit it is held to; a code guest by their own seat there (a locked hall's
  // observer seat included), the seat with the most rights when they hold more than one (backstage, then On stage, then
  // observer, so the answer never depends on which page joined first), by the kind of room it is, or, with no seat
  // there, by the admin's link (LINKED_CAPS).
  const SEAT_RANK = { research: 0, board: 1, observer: 2 };
  const rightsIn = (r) => {
    if (socket.data.isAdmin) return { role: me.role, may: () => true };
    if (me.acct) {
      const role = rbac.roomRoleFor(socket.data.account, store.scopeOf(r));
      return { role, may: (cap) => canIn(cap, r) && rbac.seatAllows(role, cap) };
    }
    const seats = Array.from(r.users.values()).filter((u) => u.uid === me.uid);
    const seat = seats.reduce((best, u) => (!best || SEAT_RANK[u.role] < SEAT_RANK[best.role] ? u : best), null);
    const linked = me.linkedRooms instanceof Set && me.linkedRooms.has(r.code);
    const caps = seat ? rbac.guestCaps(seat.role, kindOf(r)) : linked ? rbac.LINKED_CAPS : [];
    return { role: seat ? seat.role : me.role, may: (cap) => caps.includes(cap) };
  };
  /**
   * The other halls the forward of `src` (a message of this room; null: a text) would be taken in, by the forward's own
   * rules: a file needs hall.files there too and moves only from a seat that may share files here; a question never goes
   * where this person sits On stage; On stage, nothing leaves this room. `why`: the rule of this room that emptied the
   * list, in the forward's own words.
   */
  const forwardTargets = (src) => {
    if (onStage()) return { rooms: [] };
    if (src && src.type === 'file' && !allowed('hall.files')) return { rooms: [], why: FILES_BACKSTAGE };
    const needs = src && src.type === 'file' ? ['hall.post', 'hall.files'] : ['hall.post'];
    const linked = me.linkedRooms instanceof Set ? Array.from(me.linkedRooms) : [];
    let askedOnStage = false;
    const rooms = Array.from(new Set([...(userRooms.get(me.uid) || []), ...linked])).filter((c) => {
      if (c === room.code || !store.hasRoom(c)) return false;
      const there = rightsIn(store.room(c));
      if (src && src.type === 'action' && there.role === 'board') { askedOnStage = true; return false; }
      return needs.every((cap) => there.may(cap));
    });
    return !rooms.length && askedOnStage ? { rooms, why: ASKS_BACKSTAGE } : { rooms };
  };
  // The page's ↗ Send to ▸: the halls the forward of this message (`messageId`; none: a text) would be taken in. A list
  // emptied by a rule of this room says which (`why`), so the page names the rule instead of asking for a hall the person
  // already has open.
  socket.on('myRooms', (q, ack) => {
    if (typeof q === 'function') [ack, q] = [q, {}];
    if (!me) return ok(ack)({ ok: false, error: 'Not joined' });
    const src = q && typeof q === 'object' ? room.byId.get(guard.str(q.messageId)) : null;
    const t = forwardTargets(src);
    // Each room also by its reference, so the picker draws a room its list lets this room send into once, sent there.
    ok(ack)({ ok: true, rooms: t.rooms.map((c) => store.room(c)).map((r) => ({ code: r.code, name: r.name || '', ref: store.roomRef(r) })), ...(t.why ? { why: t.why } : {}) });
  });

  socket.on('forward', (args, ack) => {
    if (!need(ack)) return;
    const { messageId, targetRoom } = args && typeof args === 'object' ? args : {};
    const sent = readSend(args);
    if (sent.error) return ok(ack)({ ok: false, error: sent.error });
    const dst = store.room(guard.str(targetRoom).toUpperCase());
    // The copy carries the send's client id in the hall it went to: a repeat is answered with it and posts nothing. Only
    // this person's own forward into that hall answers so, so it tells nothing of a code they did not already send to.
    const was = dst && sent.cid ? store.sentAs(dst, me.uid, sent.cid) : null;
    if (was) return ok(ack)(was.gone ? { ok: true, id: was.id, gone: true } : { ok: true, id: was.id });
    // On stage, nothing leaves this room, text included, and neither the halls this person is in nor an admin's link is
    // the admin's per-person choice that would let it: refused before the message is read or the rate taken, in the same
    // words whatever hall the code names. Only a repeat of this person's own earlier forward is answered first (above),
    // with what it did, since a send that succeeded is never refused.
    if (onStage()) return ok(ack)({ ok: false, error: STAYS_HERE });
    // A code is a guest's way in: whether one names a hall is told no faster than the rate lets a send through.
    if (!writes.take()) return limited(ack);
    if (!dst) return ok(ack)({ ok: false, error: 'Target room not found' });
    const mine = userRooms.get(me.uid) || new Set();
    const linked = me.linkedRooms instanceof Set ? me.linkedRooms : new Set();
    if (!mine.has(dst.code) && !linked.has(dst.code)) return ok(ack)({ ok: false, error: 'You must be in the target room too (or ask admin to link you)' });
    const src = room.byId.get(messageId);
    // Only what stands on its own in another hall; a help request is tracked and answered in its own hall.
    if (!src || !FORWARDABLE.has(src.type)) return ok(ack)({ ok: false, error: src && src.type === 'help' ? 'A help request belongs to its hall — ask in the other hall instead.' : 'Cannot forward this message' });
    // A file moves only from a seat that may share files where it is: a seat that may only read here takes none of this
    // hall's files into one where it sits backstage.
    if (src.type === 'file' && !allowed('hall.files')) return ok(ack)({ ok: false, error: FILES_BACKSTAGE });
    const there = rightsIn(dst);
    if (!there.may('hall.post')) return ok(ack)({ ok: false, error: 'You may read that hall but not post in it.' });
    if (src.type === 'file' && !there.may('hall.files')) return ok(ack)({ ok: false, error: 'You may not share files in that hall.' });
    // A forwarded question is a new one by the forwarder, so it is asked only where they sit backstage.
    if (src.type === 'action' && there.role === 'board') return ok(ack)({ ok: false, error: ASKS_BACKSTAGE });
    const fwd = {
      id: makeMessageId(), type: src.type, at: Date.now(), from: { uid: me.uid, name: me.name, role: there.role, ...(me.acct ? { acct: true } : {}) },
      pinned: false, priority: !!src.priority, ...(sent.cid ? { cid: sent.cid } : {}),
      // The hall it came from by its name, never its code: a code lets a guest in, and this hall's people may not open that one.
      forwardedFrom: { roomName: room.name || '', originalAuthor: (src.from && src.from.name) || 'unknown', originalAt: src.at },
    };
    if (src.type === 'text') fwd.text = src.text;
    else if (src.type === 'file') Object.assign(fwd, { url: src.url, filename: src.filename, mime: src.mime, caption: src.caption || '' });
    else if (src.type === 'action') Object.assign(fwd, { text: src.text, options: src.options, responses: [] });
    if (!apply(dst, { o: 'add', m: fwd })) return ok(ack)(OP_REFUSED);
    ok(ack)({ ok: true, id: fwd.id });
  });

  // UI sync between a person and the admin's support view of them (same name, one side admin) or their own devices.
  const syncPeer = (p) => p.id !== socket.id && (p.data.uid === me.uid || ((p.data.adminView || socket.data.adminView) && p.data.userName === me.name));
  socket.on('userState:requestPeers', async () => {
    if (!room || !me || !chatter.take()) return;
    try { for (const p of await io.in(room.code).fetchSockets()) if (syncPeer(p)) p.emit('userState:request'); } catch { /* ignore */ }
  });
  // Only what a page applies is relayed, each value read by its type and rebuilt, so nothing else a client adds rides
  // along to another page; an unknown key or a value of the wrong type reaches nobody.
  socket.on('userState:push', async (payload) => {
    if (!room || !me || !chatter.take()) return;
    const state = userStateOf(payload);
    if (!state) return;
    try { for (const p of await io.in(room.code).fetchSockets()) if (syncPeer(p)) p.emit('userState:push', state); } catch { /* ignore */ }
  });

  // ----- AI (the backstage team and the admin): drafts only
  async function runAi(ack, fn) {
    ack = ok(ack);
    if (!aiKey()) return ack({ ok: false, error: 'AI is off — the admin can add an Anthropic API key in the dashboard.' });
    if (!aiBucket.take()) return ack({ ok: false, error: 'One AI request at a time — try again in a few seconds.' });
    if (aiRunning >= AI_MAX_CONCURRENT) return ack({ ok: false, error: 'The AI is busy with other requests — try again shortly.' });
    aiRunning++;
    const ctl = new AbortController();
    const onGone = () => ctl.abort();
    socket.once('disconnect', onGone);
    try { const r = await fn(ctl.signal); ack(r.error ? { ok: false, error: r.error } : { ok: true, ...r }); }
    catch (e) { ack({ ok: false, error: 'AI request failed.' }); }
    finally { aiRunning--; socket.off('disconnect', onGone); }
  }
  const canDraft = () => me && !onStage() && (me.role === 'research' || socket.data.isAdmin);
  // What a draft is told of where it is asked: the show facts of the room's hall (its Stagewatch and nodes, in every room
  // of it), and, in a side room, which room it is, since nobody on stage reads it (lib/ai.js whereLine). The thread is
  // this room's alone.
  const draftFacts = () => ({ messages: room.messages, show: briefFor(room.hall), where: { main: store.isMain(room), room: room.name || '' } });

  socket.on('ai:draft', (args = {}, ack) => {
    if (!need(ack)) return;
    if (!canDraft()) return ok(ack)({ ok: false, error: 'Drafting is for the backstage team.' });
    const docText = typeof args.docText === 'string' ? args.docText.slice(0, 60_000) : '';
    runAi(ack, (signal) => ai.draftReply(aiKey(), {
      ...draftFacts(),
      question: typeof args.question === 'string' ? args.question.slice(0, 2000) : '',
      instruction: typeof args.instruction === 'string' ? args.instruction.slice(0, 500) : '',
      docName: typeof args.docName === 'string' ? args.docName.slice(0, 120) : '', docText,
    }, signal));
  });

  socket.on('ai:options', (args = {}, ack) => {
    if (!need(ack)) return;
    if (!canDraft()) return ok(ack)({ ok: false, error: 'For the backstage team.' });
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 1000) : '';
    if (!prompt) return ok(ack)({ ok: false, error: 'Type the question first.' });
    runAi(ack, (signal) => ai.suggestOptions(aiKey(), { prompt, ...draftFacts() }, signal));
  });

  // ----- Stagewatch: put an answer on the speaker's confidence monitor (research or admin)
  socket.on('stage:send', async (args = {}, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    if (!allowed('stage.send')) return ack({ ok: false, error: 'The speaker\'s screen is for the backstage team.' });
    if (!writes.take()) return limited(ack);
    let text = typeof args.text === 'string' ? args.text : '';
    const source = typeof args.messageId === 'string' ? room.byId.get(args.messageId) : null;
    if (!text && source) text = source.text || '';
    // The room and the person who sent are read before Stagewatch answers: this socket may join another room meanwhile,
    // and the send's line, its row and the acknowledgement it follows stay with the room it was sent from. Every room of
    // a hall sends to its hall's Stagewatch.
    const from = room, who = actor(), sender = me.name;
    const link = linkFor(from.hall);
    const r = await link.sendToStage(text, { urgency: args.urgency, ack: args.ack !== false });
    if (r.ok) {
      // What reached the speaker's screen: the line's words as sendToStage built them (cut on a code point, braces as
      // parentheses). The row says how many characters, never the words.
      const said = stagelines.words(text, stagelines.MESSAGE_MAX);
      audit.write(who, 'stagewatch.send', from.code, 'a line (' + plural(Array.from(said).length, 'character') + ') on the speaker\'s screen, sent now', socket.data.ip);
      // A room closed while Stagewatch answered keeps nothing of the send: no line is written into a room that is no
      // longer kept (its files are gone), nor into another room made since under the same key.
      if (store.room(from.code) === from) {
        // The receipt, and later the speaker's acknowledgement, live on the record of the send (and on the source
        // message). …with the link it went to, that Stagewatch's address tag and the seq of its frames then, so a restart
        // keeps following it only where it went, and only while that Stagewatch has not restarted since.
        const stage = { ref: r.messageId || 0, receipt: r.stage, ack: r.messageId ? 'sent' : '', by: '', at: Date.now(), link: link.id, sw: link.tag, seq: link.lastSeq ?? 0 };
        // Followed on the records that took it: a line or a source the op table refused carries no receipt to follow.
        const sys = apply(from, { o: 'add', m: { id: makeMessageId(), type: 'system', text: `${sender} sent to the speaker's screen: “${stagelines.cut(said, 120)}”`, at: Date.now(), stage } });
        const onSource = !!source && !!apply(from, { o: 'upd', id: source.id, f: { stage } });
        const held = (sys ? [sys.m.id] : []).concat(onSource ? [source.id] : []);
        if (r.messageId && held.length) trackStageSend(link, r.messageId, from.code, held, { at: stage.at, seq: stage.seq });
      }
      noteEvent('research sent a message to the speaker\'s screen (' + r.stage + ')', link);
    }
    ack(r);
  });

  // ----- Where a message can go in this hall's Stagewatch: the speaker's screen (sent now, or proposed), role screens,
  // its departments (from its context), the operator alone (proposed).
  socket.on('stage:targets', (_args, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    const link = linkFor(room.hall);
    ack({
      ok: true, linked: link.linked, key: link.keyState, cert: !!(link.tlsState && link.tlsState.problem), title: (link.context && link.context.node && link.context.node.name) || '',
      canSend: !!(link.base && link.key && link.keyState !== 'refused') && allowed('stage.send'), canPropose: !!(link.desk && link.key && !link.deskRefusal) && allowed('stage.send'),
      targets: stagelines.destinations(link.departments),
    });
  });

  // ----- Show desk (Show Bus 1.2 §11): propose a stage message instead of sending it; the show caller approves
  socket.on('stage:propose', async (args = {}, ack) => {
    ack = ok(ack);
    if (!need(ack)) return;
    if (!allowed('stage.send')) return ack({ ok: false, error: 'Proposing to the stage is for the backstage team.' });
    if (!writes.take()) return limited(ack);
    let text = typeof args.text === 'string' ? args.text : '';
    const source = typeof args.messageId === 'string' ? room.byId.get(args.messageId) : null;
    if (!text && source) text = source.text || '';
    // Where in Stagewatch it goes (lib/stagelines.js): the speaker's screen, a role screen, a department this hall's
    // Stagewatch has named, or the operator alone — only a destination it offers, and only a line its parser takes.
    const link = linkFor(room.hall);
    const dest = typeof args.destination === 'string' && args.destination ? args.destination : 'speaker';
    if (!stagelines.destinations(link.departments).some((d) => d.id === dest)) return ack({ ok: false, error: 'This hall\'s Stagewatch offers no such destination.' });
    const built = stagelines.lineFor(dest, text, args.urgency);
    if (built.error) return ack({ ok: false, error: built.error });
    const parsed = stagelines.parse(built.line);
    if (parsed.error) return ack({ ok: false, error: 'Not a line Stagewatch takes: ' + parsed.error });
    // The room and the person who asked are read before the desk answers: this socket may join another room meanwhile,
    // and the proposal, its row and its system line stay with the room it was made from.
    const from = room, who = actor(), asker = me.name;
    const r = await link.propose({
      from: { t: 'messenger', id: settings.nodeId, name: 'AGMessage' },
      target: { t: 'main' },
      line: built.line,
      reason: 'AGMessage (' + (me.acct ? 'crew' : 'backstage') + ') asks for this on ' + built.words + (source && source.aiDraft ? ' — an AI draft a person chose' : '') + '.',
      risk: 'review',
    });
    if (!r.ok) return ack(r);
    // One row for each proposal the desk took: who asked, for where, and how long (in characters, an emoji one) — never
    // the words themselves.
    audit.write(who, 'stagewatch.propose', from.code, 'asked the operator: a message (' + plural(Array.from(parsed.text).length, 'character') + ') for ' + built.words + ' — proposal ' + r.proposal.id, socket.data.ip);
    // The desk's id is its own (it numbers from p1 again after a restart): the line and the Stagewatch's address tag
    // travel with it, so a proposal of the same number that is not this one is never taken for it.
    const proposal = { id: r.proposal.id, link: link.id, state: r.proposal.state, ok: null, words: '', to: built.words, at: Date.now(), sw: link.tag, line: built.line };
    // A room closed while the desk answered keeps nothing of the proposal, as for a send above.
    if (store.room(from.code) === from) {
      // Followed on the records that took it, as for a send above.
      const sys = apply(from, { o: 'add', m: { id: makeMessageId(), type: 'system', text: `${asker} asked Stagewatch's operator to put this on ${built.words}: “${stagelines.cut(parsed.text, 120)}” — waiting for the show desk`, at: Date.now(), proposal } });
      const onSource = !!source && !!apply(from, { o: 'upd', id: source.id, f: { proposal } });
      const held = (sys ? [sys.m.id] : []).concat(onSource ? [source.id] : []);
      if (held.length) trackProposal(link.id, proposal.id, from.code, held, proposal.state, proposal);
    }
    noteEvent('research proposed a stage message to the show desk', link);
    // The page that asked is told the proposal as every page of its room is (lib/ops.js unlinked).
    ack({ ok: true, proposal: ops.unlinked(proposal) });
  });

  // ----- Displays: a hall's screens. Seeing and changing what they show is display.control; making, renaming, moving,
  // replacing the link and removing is display.manage. Both are an account's (or the admin's) rights in that hall.
  const canDisplays = (cap, code) => !onStage() && (socket.data.isAdmin || !!(socket.data.account && rbac.can(socket.data.account, cap, code)));
  socket.on('display:list', ({ code } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !canDisplays('display.control', c)) return ack({ ok: false, error: 'Your account may not drive this hall\'s screens.' });
    const manage = canDisplays('display.manage', c);
    const holding = displays.hallHolding(c);
    ack({ ok: true, code: c, manage, holding, displays: displays.ofHall(c).map((d) => ({ ...Displays.status(d, holding), ...(manage ? { path: displays.path(d) } : {}) })) });
  });
  // A take: one content on the ticked screens (`ids`, or one `id`) in one request, so "All" reaches every screen of a
  // hall (up to 50) at one write's cost. Each screen is checked, taken and audited on its own; the answer says, screen by
  // screen, which took it (`results`) and, for one screen, its seq and status as well.
  socket.on('display:take', ({ id, ids, content } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const wanted = ids === undefined ? [guard.str(id)] : Array.isArray(ids) ? [...new Set(ids.map(guard.str))] : [];
    if (!wanted.length || wanted.length > 50) return ack({ ok: false, error: 'Tick between 1 and 50 screens.' });
    if (!writes.take()) return limited(ack);
    const c = cleanContent(content);
    if (c.error) return ack({ ok: false, error: c.error });
    const who = actor();
    const halls = new Set();
    const results = wanted.map((sid) => {
      const d = displays.get(sid);
      if (!d || !canDisplays('display.control', d.hall)) return { id: sid, ok: false, error: 'No such screen, or not yours to change.' };
      displays.take(d.id, c, who.name);
      io.to('display:' + d.id).emit('display:state', displayState(d));
      const holding = displays.hallHolding(d.hall);
      // In the audit voice: which screen and what kind of thing, never a message's words or a file's name.
      audit.write(who, 'display.take', d.id, d.name + ' → ' + describeContent(c, holding, { audit: true }), socket.data.ip);
      halls.add(d.hall);
      return { id: d.id, ok: true, seq: d.seq, status: Displays.status(d, holding) };
    });
    for (const h of halls) displaysChanged(h);
    const refused = results.filter((r) => !r.ok).length;
    const one = results.length === 1 ? results[0] : null;
    ack({
      ok: !refused, results,
      ...(one && one.ok ? { seq: one.seq, status: one.status } : {}),
      ...(refused ? { error: one ? one.error : 'Not sent to ' + refused + ' of ' + results.length + ' screens: no such screen, or not yours to change.' } : {}),
    });
  });
  socket.on('display:identify', ({ id } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.control', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    if (!chatter.take()) return limited(ack);
    io.to('display:' + d.id).emit('display:identify', { name: d.name, hall: (store.get(d.hall) || {}).name || '', seconds: 6 });   // its name, never its code
    ack({ ok: true, screens: Displays.screens(d) });
  });
  socket.on('display:create', ({ code, name } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !canDisplays('display.manage', c)) return ack({ ok: false, error: 'Your account may not add screens to this hall.' });
    if (displays.ofHall(c).length >= 50) return ack({ ok: false, error: 'A hall has at most 50 screens.' });
    // A screen's link is kept sealed so it can be copied again: a run without its machine key refuses it, with why.
    if (unsealable()) return ack({ ok: false, error: unsealable() });
    const r = displays.create(c, name, actor().name);
    audit.write(actor(), 'display.create', r.display.id, r.display.name + ' in ' + c, socket.data.ip);
    displaysChanged(c);
    ack({ ok: true, display: { ...Displays.status(r.display, displays.hallHolding(c)), path: r.path } });
  });
  socket.on('display:update', ({ id, name, hall } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const d = displays.get(guard.str(id));
    const to = typeof hall === 'string' && hall ? hall.toUpperCase() : '';
    if (!d || !canDisplays('display.manage', d.hall) || (to && (!store.has(to) || !canDisplays('display.manage', to)))) return ack({ ok: false, error: 'No such screen or hall, or not yours to change.' });
    const from = d.hall;
    displays.update(d.id, { name, hall: to || undefined });
    audit.write(actor(), 'display.update', d.id, 'name ' + d.name + (to && to !== from ? ', moved ' + from + ' → ' + to : ''), socket.data.ip);
    io.to('display:' + d.id).emit('display:state', displayState(d));
    displaysChanged(from); if (to && to !== from) displaysChanged(to);
    ack({ ok: true });
  });
  socket.on('display:rotate', ({ id } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.manage', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    if (unsealable()) return ack({ ok: false, error: unsealable() });   // the old link keeps working: nothing was replaced
    const p = displays.rotate(d.id);
    revokeDisplaySockets(d.id, 'This screen\'s link was replaced. Open the new link to show it again.');
    audit.write(actor(), 'display.rotate', d.id, d.name + ': new link, the old one stopped', socket.data.ip);
    displaysChanged(d.hall);
    ack({ ok: true, path: p });
  });
  socket.on('display:remove', ({ id } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const d = displays.get(guard.str(id));
    if (!d || !canDisplays('display.manage', d.hall)) return ack({ ok: false, error: 'No such screen, or not yours to change.' });
    revokeDisplaySockets(d.id, 'This screen was removed from AGMessage.');
    displays.remove(d.id);
    audit.write(actor(), 'display.remove', d.id, d.name + ' removed', socket.data.ip);
    displaysChanged(d.hall);
    ack({ ok: true });
  });
  socket.on('display:hallHolding', ({ code, image } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const c = guard.str(code).toUpperCase();
    if (!store.has(c) || !(canDisplays('display.manage', c) || canManageHall())) return ack({ ok: false, error: 'Your account may not set this hall\'s holding image.' });
    const h = cleanContent({ kind: 'holding', image });
    if (h.error) return ack({ ok: false, error: h.error });
    displays.setHallHolding(c, h.image || '');
    for (const d of displays.ofHall(c)) io.to('display:' + d.id).emit('display:state', displayState(d));
    audit.write(actor(), 'hall.holding', c, h.image ? 'holding image set' : 'holding image cleared', socket.data.ip);
    displaysChanged(c);
    ack({ ok: true });
  });

  // ----- Patterns and PlayMap: what they are doing, and the verbs they list — proposed to the show desk, never driven
  // directly (AGMessage holds only their pairing token, full control of them). Linking a node (its token) is the admin's.
  socket.on('nodes:list', (_args, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const any = socket.data.isAdmin || (socket.data.account && rbac.can(socket.data.account, 'nodes.control'));
    if (!any) return ack({ ok: false, error: 'Your account may not drive other show systems.' });
    // Each node with whether its own hall's Stagewatch (its own, else the default) keeps a show desk: Propose is offered
    // only where a proposal can go. The halls named are those this socket may see (a hall code is a guest's credential).
    const linked = Array.from(peerLinks.values()).filter((l) => mayDriveNode(socket, l)).map((l) => ({ ...l.view(), desk: deskFor(l).desk }));
    const heard = socket.data.isAdmin && discovery ? forPages(discovery.list()).filter((p) => peerlinks.KINDS.has(p.t) && !peerLinks.has(p.id)) : [];
    const halls = Array.from(store.rooms.values()).filter((r) => socket.data.isAdmin || (socket.data.account && rbac.seesHall(socket.data.account, r.code))).map((r) => ({ code: r.code, name: r.name || '' }));
    ack({ ok: true, linked, heard, admin: !!socket.data.isAdmin, halls, desk: linked.some((l) => l.desk) });
  });
  socket.on('nodes:link', ({ id, token, hall, url, name, fingerprint, t: typedKind } = {}, ack) => {
    ack = ok(ack);
    if (!socket.data.isAdmin) return ack({ ok: false, error: 'Linking another show system is the admin\'s.' });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(guard.str(id))) return ack({ ok: false, error: 'A node id is the one its hello announces.' });
    if (settingsUnsaved()) return ack({ ok: false, error: settingsUnsaved() });
    if (typeof token === 'string' && token.trim() && unsealable()) return ack({ ok: false, error: unsealable() });
    const peer = discovery ? discovery.peers.get(guard.str(id)) : null;
    const cfg = settings.peerLinks && settings.peerLinks[guard.str(id)];
    // Heard on the bus, linked before, or typed (a venue network that blocks broadcast): its kind and its address.
    const t = (peer && peer.t) || (cfg && cfg.t) || (typeof url === 'string' && url.trim() ? typedKind : '');
    if (!t || !peerlinks.KINDS.has(t)) return ack({ ok: false, error: 'Choose a Patterns or PlayMap that AGMessage hears on the network, or type its kind and address.' });
    // A node on this laptop is heard from its LAN address too (its broadcast hello): it is linked by 127.0.0.1, so its token
    // stays on this machine.
    const base = typeof url === 'string' && url.trim() ? nodes.normaliseBase(url) : peer ? peerlinks.baseFor(peer, tlsmod.lanAddresses()) : cfg.url;
    if (!base) return ack({ ok: false, error: 'That is not an address.' });
    const h = typeof hall === 'string' && hall ? hall.toUpperCase() : '';
    if (h && !store.has(h)) return ack({ ok: false, error: 'No such hall.' });
    // The start of its certificate's fingerprint, typed from the node's own screen: what lets its token go to it over TLS
    // on another machine (lib/peerlinks.js). Public, so kept unsealed, as hex.
    const typedFp = tlsmod.typedFingerprint(guard.str(fingerprint));
    if (guard.str(fingerprint).trim() && !typedFp) return ack({ ok: false, error: 'Type at least ' + tlsmod.TYPED_MIN + ' characters of its certificate\'s fingerprint (0–9, a–f), as the node shows it on its own screen.' });
    const sealed = typeof token === 'string' && token.trim() ? secretbox.seal(token.trim().slice(0, 200)) : (cfg && cfg.tokenSealed) || '';
    const next = { t, name: guard.cleanText(name || (peer && peer.name) || (cfg && cfg.name) || t, 60), url: base, tokenSealed: sealed, hall: h, fpTyped: typedFp || (cfg && cfg.fpTyped) || '' };
    settings.peerLinks = { ...(settings.peerLinks || {}), [guard.str(id)]: next };
    saveSettings();
    startPeerLink(guard.str(id), next);
    audit.write(socket.data.actor || HOST_ACTOR, 'node.link', guard.str(id), t + ' “' + next.name + '” at ' + base + (h ? ' for ' + h : '') + (typeof token === 'string' && token.trim() ? ' (token sealed)' : '') + (typedFp ? ' (' + typedFp.length + ' characters of its certificate\'s fingerprint typed)' : ''), socket.data.ip);
    boardDirty(); nodesChanged();
    ack({ ok: true });
  });
  socket.on('nodes:unlink', ({ id } = {}, ack) => {
    ack = ok(ack);
    if (!socket.data.isAdmin) return ack({ ok: false, error: 'Unlinking another show system is the admin\'s.' });
    if (!settings.peerLinks || !settings.peerLinks[guard.str(id)]) return ack({ ok: false, error: 'Not linked.' });
    const was = settings.peerLinks[guard.str(id)];
    const rest = { ...settings.peerLinks };
    delete rest[guard.str(id)];
    settings.peerLinks = rest;
    // Its certificate's pin goes with it: linking it again trusts the certificate it serves then (a renewed or new one).
    pins.forget(peerlinks.pinKey(guard.str(id)));
    settings.tlsPins = pins.toJSON();
    saveSettings();
    startPeerLink(guard.str(id), null);
    audit.write(socket.data.actor || HOST_ACTOR, 'node.unlink', guard.str(id), was.t + ' “' + was.name + '” unlinked; its token and certificate pin forgotten', socket.data.ip);
    boardDirty(); nodesChanged();
    ack({ ok: true });
  });
  // A node's certificate that waits (changed, or never confirmed) is confirmed by typing the start of its fingerprint.
  socket.on('nodes:acceptCertificate', ({ id, fingerprint } = {}, ack) => {
    ack = ok(ack);
    if (!socket.data.isAdmin) return ack({ ok: false, error: 'Accepting a node\'s certificate is the admin\'s.' });
    const link = peerLinks.get(guard.str(id));
    if (!link) return ack({ ok: false, error: 'Not linked.' });
    const r = link.acceptCertificate(guard.str(fingerprint));
    if (!r.ok) return ack(r);
    audit.write(socket.data.actor || HOST_ACTOR, 'node.certificate', link.node.id, (r.changed ? 'accepted a changed ' : 'confirmed the ') + link.node.t + ' certificate of “' + link.node.name + '” (the start of its fingerprint typed)', socket.data.ip);
    boardDirty(); nodesChanged();
    ack({ ok: true });
  });
  socket.on('nodes:command', async ({ id, line, mode } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    const link = peerLinks.get(guard.str(id));
    if (!link || !mayDriveNode(socket, link)) return ack({ ok: false, error: 'No such link, or not yours to drive.' });
    if (!writes.take()) return limited(ack);
    // Never driven directly: the only credential held is the node's pairing token (PeerLink.send says so). Fail closed.
    if (mode !== 'propose') return ack(mode === 'send' ? link.send() : { ok: false, error: 'Unknown mode — a line is proposed to the show desk.' });
    const text = guard.cleanText(line, 400);
    // Rated as the node rates this line (its rules and any line it carries), not only by the verb it starts with.
    const match = link.context ? peerlinks.matchCommand(link.commandTable(), text) : null;
    if (!text || !match) return ack({ ok: false, error: link.node.name + ' does not list that command — only the verbs it lists can be proposed.' });
    const who = socket.data.actor || (me ? { t: 'code', id: me.uid, name: me.name } : HOST_ACTOR);
    // A verb's secret words (a pairing token, a key — its own, or a carried line's) are never written down: a line with them
    // is refused before it is proposed or recorded, and the refusal shows the line up to them.
    const shown = peerlinks.redactLine(text, match.secretFrom);
    // Until PlayMap's own rules are read, a line is high: the desk is never told a lower risk than the node's.
    const risk = link.rulesKnown ? match.risk : 'high';
    // A proposal keeps its line in the desk's queue and journal: a line with a secret is never proposed.
    if (match.secrets.length) return ack({ ok: false, error: '“' + shown + '” carries a secret: set it on ' + link.node.name + ' itself — a proposal would keep it in the show desk\'s queue.' });
    // The show desk of the node's own hall, or none: a hall's proposals never go to another hall's show caller.
    const { link: desk, desk: hasDesk } = deskFor(link);
    if (!desk) return ack({ ok: false, error: link.node.name + ' was linked for a hall that has been closed: link it again for a hall, or for every hall (Admin → Show network) — not proposed.' });
    if (!hasDesk) {
      const where = link.hall ? ((store.get(link.hall) || {}).name || link.hall) + '\'s Stagewatch' : 'The default Stagewatch';
      const held = desk.base && desk.key ? desk.keyHeld('proposed') : '';
      const refused = desk.deskRefusal ? ' refuses this AGMessage at its show desk (' + desk.deskRefusal + ')' : '';
      return ack({ ok: false, error: held ? where + ': ' + held : where + (refused || (desk.linked ? ' keeps no show desk' : desk.base ? ' is ' + desk.status : ' is not linked')) + ' — not proposed.' });
    }
    const r = await desk.propose({
      from: { t: 'messenger', id: settings.nodeId, name: 'AGMessage' },
      target: { t: link.node.t, id: link.node.id, name: link.node.name },
      line: text, reason: 'Asked from AGMessage by ' + who.name + (link.hall ? ' (' + ((store.get(link.hall) || {}).name || link.hall) + ')' : '') + '.', risk,
    });
    audit.write(who, 'node.propose', link.node.id, link.node.name + ': ' + shown + ' → ' + (r.ok ? 'proposed (' + r.proposal.id + ')' : 'refused: ' + r.error), socket.data.ip);
    ack(r.ok ? { ok: true, proposal: r.proposal, risk } : r);
  });

  // ----- The halls board: an account's every hall at a glance (or the admin's), pushed latest-wins on change.
  socket.on('board:watch', (_args, ack) => {
    ack = ok(ack);
    if (!(socket.data.account || socket.data.isAdmin)) return ack({ ok: false, error: 'Sign in first.' });
    boardSockets.add(socket);
    ack({ ok: true, board: boardFor(socket), build: BUILD.full });
  });

  // ----- Help requests: someone says they are on the way, then that it is resolved. From the room, or from the board.
  // A request lives in its room, a hall's Main room or a side room. Help requests are answered by the backstage team
  // (owner answer B1): an On stage page marks its own request resolved and nothing else, whatever room its code names,
  // before any right is read; an account answers as the crew of the request's room, or of its hall's Main room (the
  // hall's crew answer a side room's request without reading the room), only where it does not sit On stage there
  // (rbac.answersHelp, by each room's scope), from any page, its own request's Resolved excepted. An account refused
  // only because it sits On stage where it would answer (a Board account, from its halls board) is told so in the On
  // stage words.
  socket.on('help:respond', ({ code, messageId, state } = {}, ack) => {
    ack = ok(ack);
    if (!chatter.take()) return limited(ack);
    // The hall page names its own room as it joined it (a guest by the code it typed, which is not the room's key once the
    // code is renewed); the halls board names a request's room by its key, Main or side.
    const named = guard.str(code).toUpperCase();
    const r = store.room(!named || (room && named === socket.data.joinedAs) ? (room ? room.code : '') : named);
    const m = r && r.byId.get(messageId);
    if (!m || m.type !== 'help') return ack({ ok: false, error: 'That help request is gone.' });
    const resolvesOwn = (uid) => state === 'resolved' && !!uid && !!m.from && m.from.uid === uid;
    if (onStage() && !resolvesOwn(me.uid)) return ack({ ok: false, error: 'Help requests are answered by the backstage team.' });
    const acct = socket.data.account;
    const inRoom = room && room.code === r.code && allowed('hall.post');
    const crewOf = [store.scopeOf(r), store.scopeOf(store.get(r.hall))];
    const byAccount = !!acct && (crewOf.some((scope) => rbac.answersHelp(acct, scope)) || (canIn('hall.post', r) && resolvesOwn(acct.id)));
    if (!(inRoom || byAccount || socket.data.isAdmin)) {
      const seatedOnStage = !!acct && crewOf.some((scope) => rbac.canIn(acct, 'hall.post', scope) && rbac.roomRoleFor(acct, scope) === 'board');
      return ack({ ok: false, error: seatedOnStage ? 'Help requests are answered by the backstage team.' : 'Only people in that hall can answer its help requests.' });
    }
    if (state !== 'coming' && state !== 'resolved') return ack({ ok: false, error: 'Say "on my way" or "resolved".' });
    const by = (me && room && room.code === r.code) ? me.name : socket.data.account ? socket.data.account.name : 'Admin';
    // The same person saying the same again (a repeat of a held answer) is told it is done, never refused for it.
    if (m.help && m.help.state === state && m.help.by === by) return ack({ ok: true, already: true });
    if (m.help && m.help.state === 'resolved') return ack({ ok: false, error: 'Already resolved' + (m.help.by ? ' by ' + m.help.by : '') + '.' });
    if (!apply(r, { o: 'upd', id: m.id, f: { help: { state, by, at: Date.now() } } })) return ack(OP_REFUSED);
    noteEvent('a help request was ' + (state === 'coming' ? 'answered' : 'resolved'), linkFor(r.hall));
    ack({ ok: true });
  });

  // ----- A hall's own settings: its name and its own Stagewatch (halls.manage).
  const canManageHall = () => !onStage() && (socket.data.isAdmin || (socket.data.account && rbac.can(socket.data.account, 'halls.manage')));
  // A room's guest code as this page may be told it, by the one rule every list reads (codeFor of its asker), or ''.
  const codeTold = (r) => codeFor(askerOf(socket), r);
  socket.on('hall:settings', ({ code } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    const r = store.get(guard.str(code).toUpperCase());
    if (!r) return ack({ ok: false, error: 'No such hall.' });
    const sw = hallStagewatch(r.code) || {};
    const own = hallLinks.get(r.code);
    ack({
      ok: true, code: r.code, name: r.name || '',
      stagewatch: { url: sw.url || '', keySet: !!secretbox.open(sw.keySealed), fp: sw.fp || '', status: own ? own.status : null, tls: own ? own.tlsState : null, key: own ? own.keyFacts() : null, deskRefusal: own ? own.deskRefusal : '' },
      defaultStagewatch: settings.stagewatchUrl || '',
      stagewatches: discovery ? discovery.list().filter((p) => p.t === 'main') : [],
    });
  });
  socket.on('hall:configure', ({ code, name, stagewatchUrl, stagewatchKey, stagewatchFingerprint } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    if (!writes.take()) return limited(ack);
    const r = store.get(guard.str(code).toUpperCase());
    if (!r) return ack({ ok: false, error: 'No such hall.' });
    // The page sends the name and the address together: a save refused for its address applies nothing, the name neither.
    const url = typeof stagewatchUrl === 'string' && stagewatchUrl.trim() ? nodes.normaliseBase(stagewatchUrl) : '';
    if (typeof stagewatchUrl === 'string' && stagewatchUrl.trim() && !url) return ack({ ok: false, error: 'That is not a Stagewatch address: type its IP or name, with the port if it is not 9924.' });
    if (url && typeof stagewatchKey === 'string' && stagewatchKey.trim() && unsealable()) return ack({ ok: false, error: unsealable() });
    const prev = hallStagewatch(r.code) || {};
    const next = url ? {
      url,
      keySealed: typeof stagewatchKey === 'string' && stagewatchKey.trim() ? secretbox.seal(stagewatchKey.trim().slice(0, 80)) : (url === prev.url ? prev.keySealed || '' : ''),
      fp: typeof stagewatchFingerprint === 'string' ? tlsmod.cleanFingerprint(stagewatchFingerprint) : (url === prev.url ? prev.fp || '' : ''),
    } : null;
    // The page sends the address on every save: only a real change is saved, applied and recorded. Without a new key,
    // next.keySealed is prev's, so the plain compare holds; a newly typed key is sealed again and counts.
    const same = typeof stagewatchUrl !== 'string' || (next ? prev.url === next.url && (prev.keySealed || '') === next.keySealed && (prev.fp || '') === next.fp : !prev.url);
    // Settings that could not be read are never saved over: a change of the hall's Stagewatch is refused, its name with it.
    if (!same && settingsUnsaved()) return ack({ ok: false, error: settingsUnsaved() });
    // A name another room of the hall has is refused before anything is applied, the address with it.
    const n = typeof name === 'string' ? guard.cleanText(name, 80) : '';
    const taken = n && n !== r.name ? roomNameRefused(r, n, r) : '';
    if (taken) return ack({ ok: false, error: taken });
    const changed = [];
    if (n && n !== r.name && renameRoom(r, n)) changed.push('name → ' + n);
    if (!same) {
      if (!next && hallLinks.has(r.code)) forgetStagewatchPins(hallLinks.get(r.code));
      settings.hallStagewatch = { ...(settings.hallStagewatch || {}) };
      if (next) settings.hallStagewatch[r.code] = next; else delete settings.hallStagewatch[r.code];
      saveSettings();
      configureHallLink(r);
      hallStageChanged(r.code);
      changed.push(url ? 'Stagewatch → ' + url + (typeof stagewatchKey === 'string' && stagewatchKey.trim() ? ' (new key, sealed)' : (next.fp !== (prev.fp || '') && url === prev.url ? ' (fingerprint)' : '')) : 'Stagewatch → the default');
    }
    if (changed.length) audit.write(socket.data.actor || HOST_ACTOR, 'hall.update', r.code, changed.join('; '), socket.data.ip);
    boardDirty();
    ack({ ok: true, changed });
  });
  socket.on('hall:acceptCertificate', ({ code } = {}, ack) => {
    ack = ok(ack);
    if (!backstage(ack)) return;
    if (!canManageHall()) return ack({ ok: false, error: 'Your account may not set halls up.' });
    const link = hallLinks.get(guard.str(code).toUpperCase());
    if (!link || !link.acceptCertificate()) return ack({ ok: false, error: 'No changed certificate to accept.' });
    audit.write(socket.data.actor || HOST_ACTOR, 'hall.certificate', guard.str(code), 'accepted a changed Stagewatch certificate', socket.data.ip);
    ack({ ok: true });
  });

  // ----- ADMIN — only with a valid admin cookie
  // The admin: the gate's admin step alone, from no room and with no bucket, as every admin verb written here asks it.
  const admin = (ack) => gate(ack, { joined: false, bucket: null, admin: true });
  // Each room control that changes something is one audit row, written before it is acknowledged, and one that changes
  // nothing writes none: which room (by its code) and what changed, in words that name people and halls — never a
  // message's text, a file's name or a token.
  const auditRoom = (action, code, words) => audit.write(socket.data.actor || HOST_ACTOR, action, code, words, socket.data.ip);
  // The other room of a link is named by its name alone ("another hall" when it has none, as a forwarded message names
  // it): a hall's key is the code its guests join with, and a row's words carry no guest code.
  const hallWords = (code) => { const h = store.room(code); return (h && h.name) || 'another hall'; };

  socket.on('admin:listRooms', (ack) => {
    if (!admin(ack)) return;
    socket.data.adminPage = true;
    // Each hall's row as before, and its side rooms beside it, in the order they were made, each by its key; each with its
    // guest code (the admin is told every one), whether it admits guests and the guest pages in it now, and a hall whose
    // code is still its key (`codeIsKey`: never renewed, so anyone its address reaches reads its code) said so.
    const row = (r) => ({ name: r.name || '', createdAt: r.createdAt, users: roomUserSummary(r, { links: true }), messageCount: r.messages.length, locked: !!r.settings.lockRoles, guestCode: store.guestCodeOf(r), codeOn: store.codeOn(r), guests: guestPagesOf(r) });
    ok(ack)({ ok: true, rooms: Array.from(store.rooms.values()).map((r) => ({ code: r.code, ...row(r), side: store.roomsOf(r.code).slice(1).map((x) => ({ key: x.code, ...row(x) })), codeIsKey: store.guestCodeOf(r) === r.code })) });
  });
  socket.on('admin:watchRoom', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    // A watch begun reads the room (one row for a side room the admin is not given); the room watched already, none.
    if (socket.data.watching !== roomCode) readAsAdmin(socket.data.actor || HOST_ACTOR, socket.data.account, r, (n) => 'watched ' + n, socket.data.ip);
    if (socket.data.watching && socket.data.watching !== roomCode) socket.leave(socket.data.watching);
    socket.join(roomCode);
    socket.data.watching = roomCode;
    ok(ack)({ ok: true, code: roomCode, name: r.name || '', messages: r.messages, users: roomUserSummary(r, { links: true }), locked: !!r.settings.lockRoles, guestCode: store.guestCodeOf(r), codeOn: store.codeOn(r), main: store.isMain(r) });
  });
  socket.on('admin:createRoom', (arg, ack) => {
    if (typeof arg === 'function') { ack = arg; arg = {}; }
    if (!admin(ack)) return;
    const r = newRoom(arg && typeof arg.name === 'string' ? arg.name : '');
    auditRoom('hall.create', r.code, r.name || '(no name)');
    ok(ack)({ ok: true, code: r.code, name: r.name });
  });
  socket.on('admin:resetRoom', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    const files = fileNamesOf(r.messages);
    if (!apply(r, { o: 'reset' })) return ok(ack)(OP_REFUSED);
    systemMessage(r, '— Messages cleared by the admin —');
    // Its documents leave the disk too, unless another hall or a screen still shows them. The row counts the files that
    // left, so it is written once their removal has run, before the answer: a stop while they are being removed keeps
    // the reset and loses its row — the price of a count that says what happened rather than what was meant to.
    const done = (n) => {
      auditRoom('room.reset', r.code, 'messages and documents cleared, ' + plural(n, 'file') + ' removed');
      ok(ack)({ ok: true, removed: n });
    };
    removeUnused(files).then(done, () => done(0));
  });
  socket.on('admin:deleteRoom', async ({ roomCode, purgeFiles } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    // A hall goes with every room it holds, so no side room is ever left without its hall; a side room goes alone.
    const main = store.isMain(r);
    const rooms = main ? store.roomsOf(r.code) : [r];
    const files = fileNamesOf(rooms.flatMap((x) => x.messages));
    // The admin pages watching a room that goes (this one among them) leave it first: they are told, not cut off, so
    // this page gets its answer and a second admin tab stays live. Everyone else in it is sent home.
    for (const x of rooms) {
      for (const id of Array.from(io.sockets.adapter.rooms.get(x.code) || [])) {
        const w = io.sockets.sockets.get(id);
        if (!w || w.data.watching !== x.code) continue;
        w.leave(x.code);
        w.data.watching = null;
        if (w !== socket) w.emit('roomClosed', { code: x.code });
      }
      io.to(x.code).emit('kicked', { reason: main ? 'This hall was closed by the admin.' : 'This room was closed by the admin.' });
      io.in(x.code).disconnectSockets(true);
    }
    // What could not be removed is said (another program held a room's files): a room that opens again at the next start
    // keeps its uploads, and its row and its answer say so.
    const said = (gone) => {
      const purge = !!purgeFiles && !gone.again;
      const kept = gone.kept.length ? ', the files of ' + plural(gone.kept.length, 'room') + ' held by another program and kept' + (gone.again ? ': it opens again at the next start' : '') : '';
      return { purge, row: (purge ? ', files removed' : '') + kept, answer: gone.kept.length ? { kept: gone.kept.length, keptWords: keptWords(gone, main ? 'the hall' : 'the room') } : {} };
    };
    // The accounts that were given a room that goes, or the hall that goes (its halls, its On stage halls), are given it
    // no more: a key no room has reaches nothing, so no page of theirs is ended and no account's row is written. A room
    // whose files another program held comes back at the next start (`back`), and its accounts keep it, so it comes back
    // with its members. Each row counts the accounts it changed. Each room that goes is taken off every list of the rooms
    // that may send into a room, as the room listed and as a room on a list, unless it comes back (forgetRoomSends).
    const updated = (n) => (n ? ', ' + plural(n, 'account') + ' updated' : '');
    const by = socket.data.actor || HOST_ACTOR;
    if (!main) {
      // The room alone: its hall's Stagewatch, screens and links stay the hall's; its hall's pages' switchers lose it.
      const removed = store.remove(r.code);
      frames.rooms.mark(r.hall);
      const gone = said(removed);
      const pruned = removed.back.includes(r.code) ? [] : accounts.prune({ rooms: [r.code] });
      if (!removed.back.includes(r.code)) forgetRoomSends([r.code]);
      audit.write(by, 'room.remove', r.code, (r.name || '(no name)') + ' (' + hallWords(r.hall) + ')' + gone.row + updated(pruned.length), socket.data.ip);
      const purged = gone.purge ? await removeUnused(files) : 0;
      return ok(ack)({ ok: true, purged, ...gone.answer });
    }
    const removed = store.removeHall(r.code);
    const gone = said(removed);
    const sides = rooms.slice(1);
    // Each side room went first, and is written first, one row each by its key, as one removed alone is; then the hall.
    const hallName = r.name || '(no name)';
    const touched = new Set();
    for (const x of sides) {
      const comes = removed.back.includes(x.code);
      const pruned = comes ? [] : accounts.prune({ rooms: [x.code] });
      for (const id of pruned) touched.add(id);
      audit.write(by, 'room.remove', x.code, (x.name || '(no name)') + ' (' + hallName + '), with its hall' + (comes ? ': it opens again at the next start' : '') + updated(pruned.length), socket.data.ip);
    }
    if (!removed.back.includes(r.code)) for (const id of accounts.prune({ halls: [r.code] })) touched.add(id);
    forgetRoomSends(rooms.map((x) => x.code).filter((k) => !removed.back.includes(k)));
    if (hallStagewatch(r.code)) { delete settings.hallStagewatch[r.code]; saveSettings(); }
    for (const d of displays.ofHall(r.code)) revokeDisplaySockets(d.id, 'This screen\'s hall was closed.');
    displays.removeHall(r.code);
    // What its people's pages were shown goes too, unless the hall comes back at the next start.
    if (!removed.back.includes(r.code)) pages.forgetHall(r.code);
    // Its own Stagewatch's address goes with it, and so do that Stagewatch's pins: read while the link still has its
    // address, and kept when another link follows the same one.
    if (hallLinks.has(r.code)) forgetStagewatchPins(hallLinks.get(r.code));
    configureHallLink({ code: r.code });   // its own Stagewatch link, if it had one, stops
    boardDirty();
    // What went, then its rooms by name and key, so the rows written about each can be read against it: as many as the
    // row holds, the rest counted (each has its own room.remove row above). The accounts counted once each.
    const head = hallName + (sides.length ? ' with ' + plural(sides.length, 'other room') : '') + gone.row + updated(touched.size);
    audit.write(by, 'hall.remove', r.code, wordsWithList(head, sides.map((x) => (x.name || 'no name') + ' · ' + x.code)), socket.data.ip);
    const purged = gone.purge ? await removeUnused(files) : 0;
    ok(ack)({ ok: true, purged, ...gone.answer });
  });
  socket.on('admin:deleteMessage', ({ roomCode, messageId } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r || !r.byId.has(messageId)) return ok(ack)({ ok: false, error: 'Message not found' });
    const m = r.byId.get(messageId);
    const files = fileNamesOf([m]);
    if (!apply(r, { o: 'del', id: messageId })) return ok(ack)(OP_REFUSED);
    // Whose it was and its kind, never its text or a file's name.
    auditRoom('message.remove', r.code, m.type === 'system' ? 'a system line' : 'a message by ' + ((m.from && m.from.name) || 'someone') + ' (' + m.type + ')');
    removeUnused(files).then(() => ok(ack)({ ok: true }), () => ok(ack)({ ok: true }));
  });
  socket.on('admin:setRole', ({ roomCode, socketId, role } = {}, ack) => {
    if (!admin(ack)) return;
    if (!ROLES.includes(role)) return ok(ack)({ ok: false, error: 'Invalid role' });
    const r = store.room(roomCode);
    const target = r && r.users.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not in room' });
    if (role === 'board' && !store.isMain(r)) return ok(ack)({ ok: false, error: ON_STAGE_IN_MAIN });
    // An account's role in a hall follows its rights, which are set on the Accounts page: a role set here would change
    // nothing the server checks, and would be undone at the page's next join.
    if (target.acct) return ok(ack)({ ok: false, error: target.name + ' signs in with an account: change their rights on the Accounts page.' });
    const prev = target.role;
    const seats = seatsOf(r, target.uid);
    const from = Array.from(new Set(seats.map(([, seat]) => seat.role))).filter((x) => x !== role);   // the roles this changes
    // Each page's seat moves in this tick, with what it allows, without waiting for the page to reload: an upload token
    // of a page whose new seat shares no file ends now (its page's join after the reload takes a new one where it may).
    for (const [sid, seat] of seats) {
      seat.role = role;
      const s = io.sockets.sockets.get(sid);
      if (s) { s.data.seat = role; s.emit('roleChanged', { role }); }
    }
    const moved = new Set(seats.map(([sid]) => sid));
    for (const t of uploadTokens.values()) if (moved.has(t.sid) && !t.may()) t.revoked = true;
    emitUsers(r);
    syncSeats(r);
    systemMessage(r, `The admin moved ${target.name} from ${seatWords(r, prev)} to ${seatWords(r, role)}.`);
    if (from.length) auditRoom('seat.role', r.code, target.name + ': ' + from.join(', ') + ' → ' + role);
    ok(ack)({ ok: true });
  });
  socket.on('admin:lockRoles', ({ roomCode, on } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    // Locked, the seats taken now are kept (saved, so a restart keeps them too); unlocked, there is nothing to keep.
    const seats = on ? seatsNow(r) : {};
    // A change is the lock switched, or a lock that keeps other seats than it kept (compared as syncSeats compares them,
    // so seats saved in another order are no change); an unlock is a change only for a locked room.
    const changed = on ? !r.settings.lockRoles || !seatsSaved(r, seats) : !!r.settings.lockRoles;
    if (!apply(r, { o: 'meta', settings: { lockRoles: !!on, seats } })) return ok(ack)(OP_REFUSED);
    if (changed) auditRoom('room.lock', r.code, on ? 'roles locked (' + plural(Object.keys(seats).length, 'seat') + ' kept)' : 'roles unlocked');
    ok(ack)({ ok: true, locked: !!on, invites: on ? invitesFor(r) : null, codeOn: store.codeOn(r) });
  });
  socket.on('admin:invites', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    // A room's invite links, made with its guest code (a side room's a Member's alone), and whether that code admits now:
    // a link to a code switched off admits nobody new until it is on.
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    ok(ack)({ ok: true, invites: invitesFor(r), codeOn: store.codeOn(r) });
  });
  socket.on('admin:linkRoom', ({ socketId, targetRoom } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    const code = guard.str(targetRoom).toUpperCase();
    const dst = store.room(code);
    if (!target || !dst) return ok(ack)({ ok: false, error: 'User or room not found' });
    const r = store.room(target.data.userRoom);
    const u = r && r.users.get(socketId);
    if (!u) return ok(ack)({ ok: false, error: 'User not in room' });
    // A link lets a code guest forward into a room; an account forwards by its own rights there (rbac.canIn: a side room
    // only by its own rooms or the admin role), so a link would give it nothing it may not already do.
    if (u.acct && !rbac.canIn(target.data.account, 'hall.post', store.scopeOf(dst))) {
      return ok(ack)({ ok: false, error: u.name + ' signs in with an account that may not post in that ' + (store.isMain(dst) ? 'hall: give the account that hall on the Accounts page.' : 'room: a side room is only for the accounts it is given to.') });
    }
    let added = false;
    for (const [sid, seat] of seatsOf(r, u.uid)) {
      seat.linkedRooms = seat.linkedRooms || new Set();
      if (!seat.linkedRooms.has(code)) added = true;
      seat.linkedRooms.add(code);
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('linkedRoomsChanged', { added: code });
    }
    if (added) auditRoom('room.link', r.code, u.name + ' may forward into ' + hallWords(code));
    ok(ack)({ ok: true, linked: Array.from(u.linkedRooms) });
  });
  socket.on('admin:unlinkRoom', ({ socketId, targetRoom } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not connected' });
    const code = guard.str(targetRoom).toUpperCase();
    const r = store.room(target.data.userRoom);
    const u = r && r.users.get(socketId);
    if (!u || !u.linkedRooms) return ok(ack)({ ok: true });
    let removed = false;
    for (const [sid, seat] of seatsOf(r, u.uid)) {
      if (!seat.linkedRooms || !seat.linkedRooms.delete(code)) continue;
      removed = true;
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('linkedRoomsChanged', { removed: code });
    }
    // Only a link that was there is recorded, so the row names a hall the admin once linked, never a code merely typed.
    if (removed) auditRoom('room.unlink', r.code, u.name + ' may no longer forward into ' + hallWords(code));
    ok(ack)({ ok: true, linked: Array.from(u.linkedRooms) });
  });
  socket.on('admin:kick', ({ socketId } = {}, ack) => {
    if (!admin(ack)) return;
    const target = io.sockets.sockets.get(socketId);
    if (!target) return ok(ack)({ ok: false, error: 'User not connected' });
    // The person leaves the room: every page they have open there, not only the one the room list names.
    const r = store.room(target.data.userRoom);
    const u = r && r.users.get(socketId);
    const theirs = u ? seatsOf(r, u.uid).map(([sid]) => io.sockets.sockets.get(sid)).filter(Boolean) : [target];
    // The page sent out says who sent it out, and of where: the room as its page names it (Main by its hall's name).
    const reason = 'An admin sent you out' + (r ? ' of ' + (r.name || 'this hall') : '') + '.';
    for (const p of theirs) {
      p.emit('kicked', { reason });
      p.disconnect(true);
    }
    if (r) syncSeats(r);   // logged out: the seat goes now, not after a restart
    auditRoom('seat.kick', r ? r.code : '', (u ? u.name : target.data.userName || 'a page in no hall') + ' sent out (' + plural(theirs.length, 'page') + ' closed)');
    ok(ack)({ ok: true });
  });
  socket.on('admin:summary', ({ roomCode } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    if (!r) return ok(ack)({ ok: false, error: 'Room not found' });
    // A side room's minutes name it with its hall ("Legal (Hall 2)"); its messages handed to the AI are a read of it,
    // written as asked, since the AI's answer is not known yet.
    runAi(ack, (signal) => {
      readAsAdmin(socket.data.actor || HOST_ACTOR, socket.data.account, r, (n) => 'minutes of ' + n + ' asked of the AI', socket.data.ip);
      return ai.summarise(aiKey(), { messages: r.messages, roomName: store.isMain(r) ? r.name : roomInHall(r) }, signal);
    });
  });
  socket.on('admin:postSummary', ({ roomCode, text } = {}, ack) => {
    if (!admin(ack)) return;
    const r = store.room(roomCode);
    const t = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!r || !t) return ok(ack)({ ok: false, error: 'Nothing to post' });
    const m = { id: makeMessageId(), at: Date.now(), type: 'text', text: t, pinned: true, priority: false, from: { uid: 'minutes', name: 'Minutes', role: 'observer', ai: true } };
    if (!apply(r, { o: 'add', m })) return ok(ack)(OP_REFUSED);
    auditRoom('minutes.post', r.code, 'minutes posted (pinned)');
    ok(ack)({ ok: true });
  });
  socket.on('admin:settings', (patch, ack) => {
    if (typeof patch === 'function') { ack = patch; patch = null; }
    if (!admin(ack)) return;
    socket.data.adminPage = true;
    // A change while the settings could not be read is refused, as is a key typed while this run has no machine key, with
    // the reason, before anything is taken: nothing would be saved, and the answer never says it was.
    if (patch && typeof patch === 'object' && Object.keys(patch).length && settingsUnsaved()) return ok(ack)({ ok: false, error: settingsUnsaved() });
    if (patch && typeof patch === 'object' && (typeof patch.aiKey === 'string' || typeof patch.stagewatchKey === 'string') && unsealable()) return ok(ack)({ ok: false, error: unsealable() });
    if (patch && typeof patch === 'object') {
      // Each setting is taken only in its own type; the audit row names exactly what was taken (a secret as sealed).
      const taken = [];
      if (typeof patch.aiKey === 'string') { settings.aiKeySealed = secretbox.seal(patch.aiKey.trim().slice(0, 200)); taken.push('aiKey (sealed)'); }
      if (typeof patch.stagewatchUrl === 'string') {
        const was = settings.stagewatchUrl || '';
        settings.stagewatchUrl = nodes.normaliseBase(patch.stagewatchUrl);
        if (was && !settings.stagewatchUrl) forgetStagewatchPins(stageLink);
        taken.push('stagewatchUrl → ' + settings.stagewatchUrl.slice(0, 60));
      }
      if (typeof patch.stagewatchKey === 'string') { settings.stagewatchKeySealed = secretbox.seal(patch.stagewatchKey.trim().slice(0, 80)); taken.push('stagewatchKey (sealed)'); }
      if (typeof patch.stagewatchFingerprint === 'string') { settings.stagewatchFingerprint = tlsmod.cleanFingerprint(patch.stagewatchFingerprint); taken.push('stagewatchFingerprint → ' + settings.stagewatchFingerprint.slice(0, 60)); }
      if (typeof patch.requireHttps === 'boolean') { settings.requireHttps = patch.requireHttps && !!cert; taken.push('requireHttps → ' + settings.requireHttps); }
      if (typeof patch.remoteAdmin === 'boolean') {
        const was = !!settings.remoteAdmin;
        settings.remoteAdmin = patch.remoteAdmin;
        taken.push('remoteAdmin → ' + settings.remoteAdmin);
        // Turned off: an account that is admin through the tunnel stops being one now, not at its next connection.
        if (was && !settings.remoteAdmin) endSockets((s) => !!(s.data.viaTunnel && s.data.account && s.data.isAdmin), 'remoteAdmin', 'Admin rights through the tunnel were turned off — reconnecting with the rights this connection has.');
      }
      // A new context token: the old one stops answering now. A run without its machine key replaces the one it keeps in
      // memory, the token in use this run, and leaves the sealed one, which it cannot read, for the next.
      if (patch.newContextToken === true && secretbox.hasKey()) { delete settings.contextTokenSealed; taken.push('newContextToken (sealed)'); }
      else if (patch.newContextToken === true) { contextTokenThisRun = ''; taken.push('newContextToken (this run only: no machine key to seal it)'); }
      if (taken.length) audit.write(socket.data.actor, 'settings', taken.map((t) => t.split(' ')[0]).join(','), 'changed ' + taken.join(', '), socket.data.ip);
      saveSettings();
      stageLink.configure(settings.stagewatchUrl, stagewatchKey(), settings.stagewatchFingerprint || '');
    }
    ok(ack)({
      ok: true,
      aiKeySet: !!aiKey(), aiFromEnv: !!process.env.ANTHROPIC_API_KEY, model: ai.MODEL,
      stagewatchUrl: settings.stagewatchUrl || '', stagewatchKeySet: !!stagewatchKey(),
      stage: stageLink.status, peers: discovery ? forPages(discovery.list()) : [],
      nodeId: settings.nodeId, contextToken: contextToken(), contextTokenWhy: contextTokenProblem(), health: healthFacts(),
      stageContext: stageLink.context ? { headline: stageLink.context.headline, light: stageLink.context.light, peers: stageLink.context.peers || [] } : null,
      tls: tlsFacts(), stagewatchFingerprint: settings.stagewatchFingerprint || '',
      remoteAdmin: !!settings.remoteAdmin, accounts: accounts.size, build: BUILD.full,
      // Where devices reach this laptop, as the banner's LAN lines say it, and "This laptop".
      addresses: lanNow(), port: PORT, laptop: laptopAnswer(),
    });
  });

  // ----- Cloudflare tunnel control
  socket.on('admin:acceptCertificate', (ack) => {
    if (!admin(ack)) return;
    const was = stageLink.tlsState;
    if (!stageLink.acceptCertificate()) return ok(ack)({ ok: false, error: 'No certificate to accept.' });
    noteEvent('the admin accepted a changed Stagewatch certificate', stageLink);
    // A trust decision a person made: who, from where, and which certificate (its public fingerprint, cut).
    audit.write(socket.data.actor || HOST_ACTOR, 'stagewatch.certificate', 'default', 'accepted a changed Stagewatch certificate (' + String(was.fp || '').slice(0, 23) + '…)', socket.data.ip);
    ok(ack)({ ok: true, fingerprint: was.fp });
  });
  socket.on('admin:renewCertificate', (ack) => {
    if (!admin(ack)) return;
    if (!cert) return ok(ack)({ ok: false, error: 'HTTPS is off on this AGMessage.' });
    try {
      cert = tlsmod.loadOrCreate({ dir: secretbox.keyDir(), name: 'AGMessage ' + os.hostname(), seal: secretbox.seal, open: secretbox.open, renew: true });
      front.setCert({ certPem: cert.certPem, keyPem: cert.keyPem });
      if (discovery) discovery.tls = cert.fp;
      tlsRenewWaited = false;
      noteEvent('the admin renewed this AGMessage\'s certificate');
      ok(ack)({ ok: true, tls: tlsFacts() });
    } catch (e) { ok(ack)({ ok: false, error: e.message }); }
  });
  // "This laptop": its facts now, and Windows read again (one read at a time), whose facts come on laptop:facts. Asked
  // with the answer alone, or with a payload first, which it reads nothing of.
  socket.on('admin:laptop', (first, second) => {
    const ack = typeof first === 'function' ? first : second;
    if (!admin(ack)) return;
    readLaptop();
    ok(ack)({ ok: true, laptop: laptopAnswer() });
  });
  // Turn on: until the end the link keeps (one a start that could not turn it on again, or a cloudflared that ended of its
  // own, left inside its time), else the end of the show day (`tunnelend.defaultEnd`: the next 06:00 an hour or more
  // away), kept in the settings, so a start before then turns it on again; Tunnel until… moves the end, Turn off forgets
  // it. One already on keeps its end. With settings that could not be read it still turns on, its end held for this run
  // only and the answer saying so (`notKept`): the one act that keeps a setting it cannot save, since what it does is the
  // link itself, which never waited on the settings. A copy without its own cloudflared is refused with why before any
  // end is kept or forgotten.
  socket.on('admin:tunnelStart', (ack) => {
    if (!admin(ack)) return;
    if (tunnelProc) return ok(ack)({ ...startTunnel(), ...tunnelEndFacts(), notKept: tunnelNotKept() });
    const missing = noCloudflared();
    if (missing) return ok(ack)(tunnelRefused(missing));
    const now = Date.now();
    const kept = tunnelend.keptEnd(settings.tunnelUntil, now);
    const until = kept.on ? kept.until : tunnelend.defaultEnd(now, readings.dayEnds);
    keepTunnelEnd(until);
    const r = startTunnel(null, { actor: socket.data.actor || HOST_ACTOR, ip: socket.data.ip });
    if (!r.ok) { keepTunnelEnd(null); return ok(ack)(r); }   // nothing turned on, so no end to keep
    ok(ack)({ ...r, ...tunnelEndFacts(now), notKept: tunnelNotKept() });
  });
  socket.on('admin:tunnelStop', (ack) => {
    if (!admin(ack)) return;
    const was = tunnelProc ? 'the internet link turned off' : keptUntil() !== null ? 'the internet link kept off (cloudflared had ended; a start before its end would have turned it on again)' : '';
    stopTunnel();
    if (was) audit.write(socket.data.actor || HOST_ACTOR, 'tunnel.off', 'tunnel', was, socket.data.ip);
    ok(ack)({ ok: true });
  });
  // Tunnel until…: the running tunnel's end moved to the next HH:MM by this laptop's clock (a time already past today is
  // tomorrow's; the end it has, when it is that time of day, stays) and kept. The payload is read by type first, so one
  // that names no time of day is refused with words whether or not the tunnel runs; with settings that could not be read
  // it is refused with why, as every setting is. Asked again with the same time, it answers the same end (and audits only
  // a move).
  socket.on('admin:tunnelUntil', (first, second) => {
    const ack = typeof first === 'function' ? first : second;
    if (!admin(ack)) return;
    const asked = first && typeof first === 'object' ? guard.str(first.until).slice(0, 10) : '';
    const now = Date.now();
    const until = tunnelend.endAt(asked, now, keptUntil(now));
    if (until === null) return ok(ack)({ ok: false, error: 'Give the end as a time of day, HH:MM by this laptop\'s clock (for example 23:30).' });
    if (!tunnelProc) return ok(ack)({ ok: false, error: 'The internet link is off: turn it on first.' });
    if (settingsUnsaved()) return ok(ack)({ ok: false, error: settingsUnsaved() });
    if (keptUntil() !== until) {
      keepTunnelEnd(until);
      audit.write(socket.data.actor || HOST_ACTOR, 'tunnel.until', 'tunnel', 'the internet link\'s end moved to ' + tunnelend.clockWords(until, now), socket.data.ip);
      broadcastTunnelStatus();
    }
    ok(ack)({ ok: true, ...tunnelEndFacts(now) });
  });
  // Answered at once with the newest check; a check of the link starts too when the link is up and the newest check is
  // over a minute old (or there is none), and its result comes on `tunnel:status`.
  socket.on('admin:tunnelStatus', (ack) => {
    if (!admin(ack)) return;
    if (tunnelUrl && tunnelUp && !tunnelChecking && (!tunnelCheck || Date.now() - tunnelCheck.at > TUNNEL_CHECK_EVERY_MS)) startCheck();
    ok(ack)({ ok: true, ...tunnelStatus() });
  });

  // What a handler module (lib/handlers/) is given of this connection, frozen: its room and its person read when asked
  // (so no verb holds a room its page has left), its answers, its two buckets, its rights' questions, the guest code it
  // may be told of a room (`codeTold`) and the one gate. The modules' verbs register after every verb above, on every
  // page's socket but a screen's (a screen's returned at the top): the hall page's, the admin page's and the halls
  // board's. The rooms module is given the server's context, the takes module the takes context, which holds nothing
  // that makes a room's op or sends to a room (`ctx`, at the end of this file).
  const conn = Object.freeze({ socket, room: () => room, me: () => me, ok, limited, writes, chatter, need, mayPost, allowed, onStage, canIn, admin, actor, canManageHall, codeTold, gate });
  roomVerbs.register(socket, conn, ctx);
  takeVerbs.register(socket, conn, takesCtx);

  /**
   * This page leaves its room: at once (`now`), or after the grace, so a page that drops and comes straight back is never
   * said to have gone. "left" is not said for a move to another room of the hall (`moved`, a join on this socket; or a
   * join there within the grace, movedWithinHall).
   */
  function leaveRoom(now, holdSeat = false, moved = false) {
    if (!room || !me || socket.data.adminView) return;
    const r = room, u = me;
    r.users.delete(socket.id);
    emitUsers(r);
    boardDirty();
    const still = Array.from(r.users.values()).some((x) => x.uid === u.uid);
    if (!still) {
      trackLeave(u.uid, r.code);
      const k = r.code + '|' + u.uid;
      const announce = () => {
        const p = pendingLeaves.get(k);
        pendingLeaves.delete(k);
        if (!store.hasRoom(r.code) || Array.from(r.users.values()).some((x) => x.uid === u.uid)) return;
        syncSeats(r);
        if (moved || (p && p.moved)) return;
        systemMessage(r, `${u.name} left`);
      };
      if (now) announce();
      else {
        if (pendingLeaves.has(k)) clearTimeout(pendingLeaves.get(k).timer);
        pendingLeaves.set(k, { timer: setTimeout(announce, LEAVE_GRACE_MS), name: u.name, role: holdSeat ? u.role : null, guest: !u.acct && !socket.data.isAdmin, moved: false });
      }
    }
    if (store.hasRoom(r.code)) syncSeats(r);
  }

  socket.on('disconnect', (reason) => {
    if (joinWait) { clearTimeout(joinWait); joinWait = null; }
    boardSockets.delete(socket);
    if (uploadToken) uploadTokens.delete(uploadToken);
    // A page that dropped keeps its seat for the grace; one the server sent away (a logout, a closed hall) does not.
    leaveRoom(false, reason !== 'server namespace disconnect');
  });
});

function seenFor(room) { return room.seen ? Array.from(room.seen.values()) : []; }
/**
 * Each page in a room of `hall` (its Main room), told its hall as its join was (hallFacts): its name, its key where the
 * page may know it, and the rooms its switcher moves between. Computed per page, so a side room's account that does not
 * see its hall is never handed its key; the admin's pages watching a room are not hall pages and are told nothing.
 */
function sendHallRooms(hall) {
  for (const r of store.roomsOf(hall.code)) {
    for (const sid of io.sockets.adapter.rooms.get(r.code) || []) {
      const s = io.sockets.sockets.get(sid);
      if (!s || s.data.userRoom !== r.code) continue;
      s.emit('rooms:changed', hallFacts(askerOf(s), r, { page: !!s.data.account && !s.data.adminView }));
    }
  }
}
/** One frame to the hall with the newest receipt of each person in `uids`: `{seen: [{uid, name, role, seq}…]}`. */
function sendSeen(room, uids) {
  const seen = room.seen ? Array.from(uids, (uid) => room.seen.get(uid)).filter(Boolean) : [];
  if (seen.length) io.to(room.code).emit('seen', { seen });
}

/** What a hall's AI is told of the show network: its Stagewatch, and the nodes of that hall and of every hall in their own words (lib/context.js hallBrief). */
function briefFor(code) {
  const link = linkFor(code);
  return hallBrief(code, { status: link.status, key: link.keyState, keyWords: link.keyWords, view: link.view, context: link.context }, Array.from(peerLinks.values()).map((l) => l.view()), discovery ? discovery.list() : []);
}

// ---------------------------------------------------------------- displays
// AGMessage's own time zone (an IANA name, on Windows too): a screen's clock shows the time of day here, whatever zone
// the screen's own computer was set to.
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
/**
 * Everything a display's page needs: what to show (numbered), the hall's holding image and countdown, the server's time
 * and zone. A screen link only shows: its connection is never told its hall's code, which would let its browser in.
 */
function displayState(d) {
  return {
    id: d.id, name: d.name, hallName: (store.get(d.hall) || {}).name || '', seq: d.seq, content: d.content,
    holding: displays.hallHolding(d.hall), stage: stagePayload(linkFor(d.hall)), now: Date.now(), tz: TIME_ZONE,
    build: BUILD.full,
  };
}
// A screen page's own key (display.js makes one per page load): its reconnections are the same screen.
const SCREEN_KEY = /^[0-9a-f]{32}$/;
/** A display's browser connects with its token: it is told what to show, and it says what it showed. */
function serveDisplay(socket, token) {
  const d = displays.byToken(token);
  if (!d) { socket.emit('display:unknown', { words: 'This screen link is not (or no longer) in use. Ask for the current link.' }); setTimeout(() => socket.disconnect(true), 100); return; }
  socket.data.display = d.id;
  socket.join('display:' + d.id);
  const asked = guard.str(socket.handshake.auth.screen);
  const key = SCREEN_KEY.test(asked) ? asked : socket.id;
  displays.joined(d, key, socket.id);
  const reports = new guard.Bucket(4, 10);
  socket.emit('display:state', displayState(d));
  displaysChanged(d.hall);
  socket.on('display:shown', ({ seq, ok, words } = {}) => {
    const cur = displays.get(d.id);
    if (!cur || !reports.take()) return;
    if (displays.shown(cur, key, seq, ok, words, socket.id)) displaysChanged(cur.hall);
  });
  socket.on('disconnect', () => {
    const cur = displays.get(d.id);
    if (!cur) return;
    displays.left(cur, key, socket.id);
    displaysChanged(cur.hall);
  });
}
function revokeDisplaySockets(id, words) {
  for (const s of io.sockets.sockets.values()) if (s.data && s.data.display === id) { s.emit('display:unknown', { words }); setTimeout(() => s.disconnect(true), 100); }
}
/**
 * A hall's screens changed: the board redraws, and its operators are told once per 150 ms at most, however many takes,
 * reports and connections came in that time (`frames.screens`; they re-read the list after the event, so the newest
 * state is what they read — a take on 50 screens is one re-read per console, not a hundred).
 */
function displaysChanged(code) {
  boardDirty();
  frames.screens.mark(code);
}
/** A Stagewatch's frame moved: the displays of every hall that follows it get the frame. */
function stageChanged(link) {
  const payload = stagePayload(link);
  for (const r of roomsUsing(link)) for (const d of displays.ofHall(r.code)) if (Displays.screens(d)) io.to('display:' + d.id).emit('display:stage', payload);
}
const displaysOf = (code) => displays.ofHall(code).map((d) => { const st = Displays.status(d, displays.hallHolding(code)); return { id: st.id, name: st.name, state: st.state, mark: st.mark, words: st.words + ' — ' + st.showing }; });

// ---------------------------------------------------------------- the halls board
// Each watcher gets the halls it may see, recomputed when anything on them changes and sent at most every 300 ms
// (`frames.board`: a slow phone gets the newest board, never a backlog). A hall's row is built once per send for every
// watcher (`shared`); what differs per watcher — which halls, which links, which help requests and whether it may answer
// them — is added on top.
const boardSockets = new Set();
function boardDirty() { frames.board.mark('board'); }
function hallParts(r, shared) {
  let p = shared.get(r.code);
  if (!p) { p = { row: board.hallRow(r, { stage: stagePayload(linkFor(r.code)), displays: displaysOf(r.code) }) }; shared.set(r.code, p); }
  return p;
}
function boardFor(socket, shared = new Map()) {
  const a = socket.data.account;
  const who = askerOf(socket);
  const sees = (code) => socket.data.isAdmin || (a && rbac.seesHall(a, code));
  const rooms = Array.from(store.rooms.values()).filter((r) => sees(r.code));
  const nodeChip = (l) => { const v = l.view(); return { id: v.id, t: v.t, name: v.name, hall: v.hall, status: v.status, light: v.light, headline: v.headline }; };
  const links = Array.from(peerLinks.values()).filter((l) => (l.hall ? sees(l.hall) : mayDriveNode(socket, l)));
  return {
    nodes: links.map(nodeChip),
    canDrive: Array.from(peerLinks.values()).some((l) => mayDriveNode(socket, l)),   // what nodes:list would list: Show network
    // Each hall's guest code only for a watcher who may know it (codeFor; a board's socket sits in no room), with whether it
    // admits guests now: a chip that follows Code off and New code as they happen. Then the hall's side rooms this watcher
    // may enter (sideRoomsFor), chosen per watcher beside the row every watcher shares.
    halls: rooms.map((r) => ({ ...hallParts(r, shared).row, nodes: links.filter((l) => l.hall === r.code).map(nodeChip), guestCode: codeFor(who, r), codeOn: store.codeOn(r), rooms: sideRoomsFor(who, r) })),
    help: helpFor(socket),
    // The side rooms it may enter in a hall it does not see, each by its hall's name and never the hall's key (its Main
    // room's address, and its guest code until New code).
    yourRooms: Array.from(store.rooms.values()).filter((r) => !sees(r.code)).flatMap((r) => sideRoomsApart(who, r)),
  };
}
/**
 * The open help requests a watcher's board shows, each hall's rooms together, Main first. A request lives in its room: in
 * full to a watcher who may read that room (a hall's Main room by its halls, a side room by its own rooms, or the admin),
 * who may open it (`canOpen`); a side room's to the hall's crew who may not read it (who may answer its Main room's,
 * rbac.answersHelp, never On stage there) without its words, `text` '', to answer from here; to nobody else. Each
 * names its room (`code`, its key; `roomName`, '' for Main) and its hall by name (`hallName`); the hall's key (`hall`:
 * its Main room's address, and its guest code until New code) only to a watcher who sees the hall, so one that reads a
 * side room alone is told its hall's name, or that it has none, never its key. Each is offered as help:respond's
 * account branch answers, by the request's room or its hall's Main room (`canRespond`). A room's open requests are read
 * once per change (board.openHelp), whoever watches.
 */
function helpFor(socket) {
  const a = socket.data.account;
  const admin = !!socket.data.isAdmin;
  const answers = (scope) => admin || (!!a && rbac.answersHelp(a, scope));
  const items = [];
  for (const hall of store.rooms.values()) {
    const mainScope = store.scopeOf(hall);
    const seesHall = admin || (!!a && rbac.seesHall(a, hall.code));
    const where = seesHall ? { hall: hall.code, hallName: hall.name || hall.code } : { hallName: hall.name || 'A hall with no name' };
    for (const r of store.roomsOf(hall.code)) {
      const open = board.openHelp(r);
      if (!open.length) continue;
      const scope = store.isMain(r) ? mainScope : store.scopeOf(r);
      const reads = admin || (!!a && rbac.seesRoom(a, scope));
      if (!reads && !(scope !== mainScope && answers(mainScope))) continue;
      const canRespond = answers(scope) || answers(mainScope);
      for (const h of open) {
        items.push({ ...h, text: reads ? h.text : '', ...where, roomName: scope === mainScope ? '' : r.name || r.code, canOpen: reads, canRespond });
      }
    }
  }
  return items;
}
/** Every watcher's board, each hall's row built once for all of them; a board that faults holds back no other watcher's. */
function sendBoards() {
  const shared = new Map();
  sendEach(boardSockets, (s) => s.emit('board', boardFor(s, shared)), (e) => frameRefused('board', e));
}

/** Every open socket `match` picks is told why (the pages reload on it) and closed: its next connection is judged afresh. */
function endSockets(match, what, words) {
  for (const [, s] of io.sockets.sockets) {
    if (s.data && match(s)) {
      s.emit('account:changed', { what, words });
      setTimeout(() => s.disconnect(true), 50);
    }
  }
}
const SIGNED_OUT = 'Signed out — sign in again to carry on.';

/**
 * An account changed (role, rights, halls, rooms, On stage halls, password, turned off, removed): every socket it has
 * open is told and closed, so its next connection is judged by the rights it has now — never by the ones it had. Its chat
 * view alone is no right: each of its pages in a room is told the view it draws now (`view`), and none is closed.
 */
function accountChanged(id, what) {
  if (what === 'view') return viewChanged(id);
  return endSockets((s) => s.data.accountId === id, what, 'Your account was changed by an admin — reconnecting with your current rights.');
}
/**
 * The chat view a page draws (plan 1-§6, "How it is chosen"): the person's own, an account's `view`, when one is chosen;
 * else the simple view for a seat On stage (a hall's Main room's alone), else the full view. A view is no right: no
 * check reads it.
 */
function drawnView(account, s) {
  if (account && (account.view === 'simple' || account.view === 'full')) return account.view;
  return s.data.seat === 'board' && !s.data.adminView ? 'simple' : 'full';
}
/** An account's chat view changed: each of its pages seated in a room is told the view to draw, live; nothing is closed. */
function viewChanged(id) {
  const account = accounts.get(id);
  for (const [, s] of io.sockets.sockets) {
    if (s.data && s.data.accountId === id && s.data.userRoom && !s.data.adminView) s.emit('view', { view: drawnView(account, s) });
  }
}

/**
 * Once a minute: a session with a page open on it is in use, so it is touched (a page open all day is not idle), and a
 * socket whose session has ended meanwhile — 7 days old, given up for a newer one, the admin token's day over — is
 * closed. Ending a session by hand (sign-out) closes its sockets at once.
 */
const SESSION_SWEEP_MS = Math.max(50, Number(process.env.AGM_SESSION_SWEEP_MS) || 60_000);
function sweepSessions() {
  const open = new Set();
  for (const [, s] of io.sockets.sockets) if (s.data && s.data.sessionHash) open.add(s.data.sessionHash);
  const ended = sessions.sweep(open);
  endSockets((s) => (!!s.data.sessionHash && ended.has(s.data.sessionHash)) || (!!s.data.adminSid && !tokenSessions.has(s.data.adminSid)), 'expired', SIGNED_OUT);
}
setInterval(sweepSessions, SESSION_SWEEP_MS).unref();

/**
 * A room's invite links, made with its guest code (a renewed code voids the links made with the one before): On stage and
 * backstage in a hall's Main room, a Member's in a side room, which has no stage. None for a room with no code.
 */
function invitesFor(room) {
  const code = store.guestCodeOf(room);
  const out = {};
  if (!code) return out;
  for (const role of store.isMain(room) ? ['board', 'research'] : ['research']) out[role] = `/?code=${code}&role=${role}&invite=${guard.makeInvite(SECRET, code, role)}`;
  return out;
}

/** A page's client id for a send: 1-40 characters of the base64url alphabet. It names nothing and grants nothing. */
const CID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HELD_MAX_MS = 86_400_000;
/**
 * What a send says of itself, read by type: its client id (`cid`) and, where it is kept (`held`), how long the page held
 * it before sending (`heldMs`, the page's own count, at most 24 h), as `held` in whole seconds when it is one or more.
 * Absent or null, each is none (a page cached across the upgrade sends neither); any other shape is refused with words.
 */
function readSend(payload, { held = false } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  if (p.cid !== undefined && p.cid !== null) {
    if (typeof p.cid !== 'string' || !CID_RE.test(guard.str(p.cid))) return { error: 'That message\'s id could not be read.' };
    out.cid = p.cid;
  }
  if (held && p.heldMs !== undefined && p.heldMs !== null) {
    if (!Number.isInteger(p.heldMs) || p.heldMs < 0 || p.heldMs > HELD_MAX_MS) return { error: 'That message\'s wait could not be read.' };
    if (p.heldMs >= 1000) out.held = Math.floor(p.heldMs / 1000);
  }
  return out;
}

// A file message's refusals, as the answer's fields beside `ok: false`. `reupload` has the page that still holds the
// file upload it again for its room and send it under the same client id, by itself.
const FILE_REFUSED = Object.freeze({
  otherRoom: Object.freeze({ error: 'That file belongs to another room — send it from there.' }),
  otherPerson: Object.freeze({ error: 'Only the person who uploaded that file can post it.' }),
  onScreen: Object.freeze({ error: 'That file is on a screen, not in a room: choose the file again.', reupload: true }),
  expired: Object.freeze({ error: 'That upload has expired: choose the file again.', reupload: true }),
});
/**
 * Why `user` may not post the upload `url` in `room` (a file message's provenance), as a refusal of `FILE_REFUSED`, or
 * null when they may: a file is posted in the room its upload was made for, by the person it was made by
 * (`freshUploads`, this run's record), or again in a room a message of which already holds it. Any other file crosses
 * rooms only by `forward`, between rooms the person is in and by its own checks. Refused: another room's upload or a
 * file another room holds (`otherRoom`, "send it from there"), another person's upload not yet posted (`otherPerson`),
 * a file only a screen or a hall's holding image holds (`onScreen`), or an upload this run holds no record of, made
 * before a restart (`expired`); the last two with `reupload`.
 */
function fileRefusal(user, url, room) {
  if (room.messages.some((m) => m.type === 'file' && m.url === url)) return null;
  const name = url.slice(9);
  const fresh = freshUploads.get(name);
  if (fresh && fresh.room === room.code) return fresh.uid === user.uid ? null : FILE_REFUSED.otherPerson;
  if (fresh || uploadsInRooms().has(name)) return FILE_REFUSED.otherRoom;
  return uploadsOnScreens().has(name) ? FILE_REFUSED.onScreen : FILE_REFUSED.expired;
}

/** An upload on this laptop's disk, by its link: its size in bytes, or -1 when it is not there (or no upload's link). */
function uploadOnDisk(url) {
  if (!guard.validUploadUrl(url)) return -1;
  const st = fs.statSync(path.join(UPLOAD_DIR, url.slice(9)), { throwIfNoEntry: false });
  return st && st.isFile() ? st.size : -1;
}
/**
 * The message `user` posts in `room` from a page's `payload` (`message`'s, and a new one sent into another room,
 * `room:send`), with its send's client id and wait (`sent`: readSend's): `{msg, size}` (a file's size in bytes, else -1),
 * or `{refused}`, the answer's fields beside `ok: false`. An upload that is no longer here (a send held past the wait an
 * unposted upload is kept for) is uploaded again by the page that holds the file and sent with the same client id
 * (`reupload`); a file goes only into the room it was uploaded for (its provenance, `fileRefusal`): another room's is
 * refused with where it is, and one no room holds and this run has no record of (a screen's alone, or one made before a
 * restart) is uploaded again, as one that is no longer here. Nothing is posted here: the caller posts what it is given.
 */
function messageOf(user, payload, room, sent) {
  const upload = payload && payload.type === 'file' && guard.validUploadUrl(payload.url) ? payload.url : '';
  const size = upload ? uploadOnDisk(upload) : -1;
  if (upload && size < 0) return { refused: { error: 'That file is no longer on the AGMessage laptop: choose it again.', reupload: true } };
  const refused = upload ? fileRefusal(user, upload, room) : null;
  if (refused) return { refused };
  const msg = buildMessage(user, payload, { ...sent, room });
  return msg ? { msg, size } : { refused: { error: 'Invalid message' } };
}

/**
 * The message `user` posts in `room` from a page's `payload`, carrying its send's client id and wait (`cid`, `held`:
 * readSend's); null when the payload is no message, and for a file whose provenance does not let it into `room`
 * (`fileRefusal`, which a caller that answers with the reason asks first). Only a message or null comes back, so no
 * caller can post a refusal, or spread one into a message of its own.
 */
function buildMessage(user, payload, { room, cid, held } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const base = {
    id: makeMessageId(), at: Date.now(), from: { uid: user.uid, name: user.name, role: user.role, ...(user.acct ? { acct: true } : {}) }, pinned: false, priority: !!payload.priority,
    ...(cid ? { cid } : {}), ...(held ? { held } : {}),
  };
  if (payload.type === 'text') {
    const text = guard.str(payload.text).trim();
    return text ? { ...base, type: 'text', text: text.slice(0, 4000), ...(payload.aiDraft ? { aiDraft: true } : {}) } : null;
  }
  if (payload.type === 'file') {
    if (!guard.validUploadUrl(payload.url) || !room) return null;
    const t = guard.UPLOAD_TYPES[guard.extOf(payload.url)];
    if (!t) return null;   // the message handler has checked that the upload is here
    if (fileRefusal(user, payload.url, room)) return null;
    return {
      ...base, type: 'file', url: payload.url,
      filename: guard.cleanText(payload.filename, 120) || 'file',
      mime: t.mime.split(';')[0],
      caption: guard.str(payload.caption).slice(0, 500),
    };
  }
  if (payload.type === 'help') return board.helpMessage(base, payload, guard.cleanText);
  if (payload.type === 'action') {
    const text = guard.str(payload.text).trim();
    let options = Array.isArray(payload.options) ? payload.options.map((o) => guard.str(o).trim().slice(0, 40)).filter(Boolean).slice(0, 6) : [];
    if (!options.length) options = ['Yes', 'No'];
    return text ? { ...base, type: 'action', text: text.slice(0, 1000), options, responses: [] } : null;
  }
  return null;
}

function renderTranscriptHtml(room) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ts) => new Date(ts).toLocaleString();
  const rows = [];
  for (const m of room.messages) {
    if (m.type === 'system') { rows.push('<div class="sys">— ' + esc(m.text) + ' (' + esc(fmt(m.at)) + ')</div>'); continue; }
    const who = m.from ? esc(m.from.name) + ' <span class="role">' + esc(m.from.role) + '</span>' : '—';
    let content = '';
    if (m.type === 'text') content = '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>';
    else if (m.type === 'file') content = '<p>📄 <em>' + esc(m.filename) + '</em>' + (m.caption ? ' — ' + esc(m.caption) : '') + '</p>';
    else if (m.type === 'help') content = '<p><strong>Help — ' + esc(m.category) + ':</strong> ' + esc(m.text || '') + '</p>' +
      (m.help ? '<p class="responses">' + esc(m.help.state === 'open' ? 'open' : (m.help.state === 'coming' ? 'on the way' : 'resolved') + (m.help.by ? ' — ' + m.help.by : '') + (m.help.at ? ', ' + fmt(m.help.at) : '')) + '</p>' : '');
    else if (m.type === 'action') {
      content = '<p><strong>Action prompt:</strong> ' + esc(m.text) + '</p>';
      if (Array.isArray(m.options) && m.options.length) content += '<ul>' + m.options.map((o) => '<li>' + esc(o) + '</li>').join('') + '</ul>';
      if (Array.isArray(m.responses) && m.responses.length) {
        content += '<p class="responses"><strong>Responses:</strong> ' + m.responses.map((r) => esc(r.name) + ' → ' +
          (r.optionIndex >= 0 && m.options && m.options[r.optionIndex] !== undefined ? esc(m.options[r.optionIndex]) : '"' + esc(r.note || '') + '"')).join('; ') + '</p>';
      }
    }
    let extras = '';
    if (m.replyTo) extras += '<div class="rt">↩ replying to ' + esc(m.replyTo.name) + ': <em>' + esc(m.replyTo.withdrawn ? '⊘ withdrawn' : m.replyTo.snippet) + '</em></div>';
    if (Array.isArray(m.reactions) && m.reactions.length) {
      const counts = {};
      for (const r of m.reactions) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      extras += '<div class="rx">' + Object.entries(counts).map(([e, n]) => esc(e) + ' ' + n).join(' &nbsp; ') + '</div>';
    }
    if (m.priority) extras += '<span class="prio">🔥 HIGH</span>';
    if (m.pinned) extras += '<span class="pin">📌 pinned</span>';
    if (m.aiDraft) extras += '<span class="pin">✨ drafted with AI, sent by a person</span>';
    if (m.held) extras += '<span class="pin">◷ written ' + esc(fmt(m.at - m.held * 1000)) + ', sent ' + esc(fmt(m.at)) + ' (offline)</span>';
    if (m.forwardedFrom) extras += '<div class="fwd">↗ Forwarded from ' + esc(m.forwardedFrom.roomName || 'another hall') + '</div>';
    if (m.sentFrom) extras += '<div class="fwd">↘ From ' + esc(ops.placeOf(m.sentFrom)) + (m.sentFrom.originalAuthor ? ' · originally by ' + esc(m.sentFrom.originalAuthor) : '') + '</div>';
    if (m.sentTo) extras += '<div class="fwd">' + (m.sentTo.withdrawn ? '⊘ Withdrawn from ' + esc(ops.placeOf(m.sentTo)) + ' after ' + esc(ops.lasted(m.sentTo.withdrawn - m.at)) : '↗ Sent to ' + esc(ops.placeOf(m.sentTo))) + ' — a copy kept here</div>';
    const cls = ['msg', 'type-' + m.type, m.priority ? 'priority' : ''].filter(Boolean).join(' ');
    rows.push('<article class="' + cls + '"><header><strong>' + who + '</strong><time>' + esc(fmt(m.at)) + '</time></header>' + extras + '<div class="body">' + content + '</div></article>');
  }
  // A side room is named with its hall ("Legal (Hall 2)"), and by its key: an address, never a code a guest types.
  const main = store.isMain(room);
  const named = main ? room.name : roomInHall(room);
  const title = named ? named + ' — transcript' : 'AGMessage transcript';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
    'body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#15202b}' +
    'h1{margin:.2rem 0}.meta{color:#6b7280;margin:.25rem 0 1.6rem}' +
    '.msg{border:1px solid #e2e6ec;border-radius:8px;padding:.55rem .8rem;margin:.4rem 0;background:#fff;break-inside:avoid}' +
    '.msg.priority{border-color:#dc2626;background:#fff5f5}.msg.type-action{border-color:#fbcf8a;background:#fffaf0}' +
    '.msg header{display:flex;gap:.6rem;align-items:baseline;font-size:.85rem;color:#6b7280;margin-bottom:.15rem}' +
    '.msg header time{margin-left:auto;font-variant-numeric:tabular-nums}' +
    '.msg .role{font-size:.7rem;padding:.05rem .35rem;background:#eef2fb;color:#1c3f9e;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}' +
    '.msg .body p{margin:.2rem 0}.msg .body em{font-style:italic;color:#374151}.msg ul{margin:.2rem 0 .2rem 1.2rem}' +
    '.responses{font-size:.85rem;color:#065f46}.rt{font-size:.85rem;font-style:italic;color:#6b7280;border-left:3px solid #2b57d1;padding-left:.5rem;margin-bottom:.25rem}' +
    '.rx{font-size:.9rem;color:#374151;margin-top:.15rem}.prio{display:inline-block;background:#dc2626;color:#fff;padding:0 .35rem;border-radius:999px;font-size:.7rem;font-weight:700;margin-right:.3rem}' +
    '.pin{font-size:.8rem;color:#7a4d00;margin-right:.3rem}.fwd{font-size:.85rem;color:#6b7280;font-style:italic}' +
    '.sys{color:#6b7280;font-style:italic;text-align:center;margin:.25rem 0;font-size:.85rem}@media print{body{max-width:100%}.msg{break-inside:avoid;border-color:#aaa}}' +
    '</style></head><body><h1>' + esc(named || 'AGMessage transcript') + '</h1>' +
    '<p class="meta">' + (main ? 'Code' : 'Room key') + ' <strong>' + esc(room.code) + '</strong> · Started ' + esc(fmt(room.createdAt)) + ' · ' + room.messages.length + ' entries · Generated ' + esc(fmt(Date.now())) + '</p>' +
    rows.join('\n') + '<p class="meta" style="margin-top:2rem">— end of transcript —</p></body></html>';
}

// ---------------------------------------------------------------- show network (Show Bus 1.1)
// One Stagewatch per hall at a venue with several: each hall may link its own (hall settings), and the default one
// (Admin → Show network) serves every hall without one. Each is a StagewatchLink of its own, with its own liveness,
// clock, pin and desk; a hall's countdown, sends and proposals go to its link and nowhere else.
const hallLinks = new Map();   // hall code -> StagewatchLink
// How often a desk is asked whether it is one (a test's AGM_DESK_CHECK_MS; Stagewatch's minute otherwise).
const DESK_CHECK_MS = parseInt(process.env.AGM_DESK_CHECK_MS || '', 10) > 0 ? parseInt(process.env.AGM_DESK_CHECK_MS, 10) : nodes.DESK_CHECK_MS;
function makeLink(id) {
  const link = new nodes.StagewatchLink({
    nodeId: settings.nodeId,
    deskCheckMs: DESK_CHECK_MS,
    onState: (view) => onStageState(link, view),
    onStatus: (status) => noteEvent('Stagewatch link' + (id === 'default' ? '' : ' of a hall') + ' ' + (/^CERTIFICATE CHANGED/.test(status) ? 'refused: CERTIFICATE CHANGED' : status), link),
    // Stagewatch's verdict on the key, once per change: never the key, and Stagewatch's words already cut and redacted. A
    // redial accepted again is no change; a new key, address or certificate (its epoch) makes its verdict news again.
    onKey: (k, epoch) => {
      const seen = epoch + '|' + k.state + '|' + k.words;
      if ((k.state !== 'accepted' && k.state !== 'refused') || seen === link.keyAudited) return;
      link.keyAudited = seen;
      const words = k.state === 'accepted'
        ? 'Stagewatch accepted the key (' + (k.via === 'auth' ? 'its auth message' : 'an authenticated read') + ')' + (link.tlsState.on && link.tlsState.pinned ? ', certificate pinned' : '')
        : 'Stagewatch refused the ' + (link.key ? 'key' : 'view') + ': ' + k.words;
      whenServing(() => audit.write({ t: 'system' }, 'stagewatch.key', id === 'default' ? 'default' : id, words));
    },
    findPeer: (t, host, port) => (discovery ? discovery.find(t, host, port) : null),
    pins,
    onPins: () => { settings.tlsPins = pins.toJSON(); saveSettings(); },
  });
  link.id = id;
  return link;
}
const stageLink = makeLink('default');
/** The Stagewatch a hall follows: its own, else the default. */
const linkFor = (code) => hallLinks.get(code) || stageLink;
const allLinks = () => [stageLink, ...hallLinks.values()];
const roomsUsing = (link) => Array.from(store.rooms.values()).filter((r) => linkFor(r.code) === link);
/** What a page shows of a link: the frame (or nothing yet), its state and whether it keeps a show desk. */
function stagePayload(link) {
  if (!link.base) return null;
  // `cert`: the link refuses Stagewatch's certificate (changed, or not the one announced) until an admin accepts it.
  const facts = { status: link.status, desk: link.desk, key: link.keyState, cert: !!(link.tlsState && link.tlsState.problem) };
  return link.view ? { ...link.view, ...facts } : facts;
}
/** A Stagewatch the admin removed: its pins go, unless another link still follows that address (its pin guards that one too). */
function forgetStagewatchPins(link) {
  if (link.base && !allLinks().some((l) => l !== link && l.base === link.base)) link.forgetPins();
}
/** A hall now follows another Stagewatch (or none): its rooms and its screens are told at once, never left on the old frame. */
function hallStageChanged(code) {
  const payload = stagePayload(linkFor(code));
  for (const r of store.roomsOf(code)) io.to(r.code).emit('stage', payload || { status: 'off', desk: false });
  for (const d of displays.ofHall(code)) if (Displays.screens(d)) io.to('display:' + d.id).emit('display:stage', payload);
}
function onStageState(link, view) {
  const payload = stagePayload(link) || { status: 'off', desk: false };
  // Every room of each hall that follows it.
  for (const hall of roomsUsing(link)) for (const r of store.roomsOf(hall.code)) io.to(r.code).emit('stage', payload);
  followStageAck(link, view);
  stageChanged(link);
  boardDirty();
}
/**
 * A hall's own Stagewatch, from the server's settings (settings.json → hallStagewatch[code], key sealed at rest) — never
 * from the room's own settings, whose changes travel to every client in the room's log. None: the default.
 */
const hallStagewatch = (code) => (settings.hallStagewatch && typeof settings.hallStagewatch === 'object' ? settings.hallStagewatch[code] : null) || null;
function configureHallLink(room) {
  const sw = hallStagewatch(room.code);
  const url = sw && typeof sw.url === 'string' ? nodes.normaliseBase(sw.url) : '';
  let link = hallLinks.get(room.code);
  if (!url) {
    if (link) { link.stop(); hallLinks.delete(room.code); }
    return null;
  }
  if (!link) { link = makeLink('hall:' + room.code); hallLinks.set(room.code, link); }
  link.configure(url, secretbox.open(sw.keySealed) || '', sw.fp || '');
  return link;
}
let discovery = null;
if (process.env.AGM_NODES !== '0') {
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  discovery = new nodes.Discovery({ id: settings.nodeId, port: PORT, name: 'AGMessage', build: BUILD.full, announce: !loopbackOnly, tls: cert ? cert.fp : '', onChange: () => {
    // Read once, and volatile: a slow or sleeping admin page gets the newest table, never a backlog (its 5 s refresh reads it again).
    const list = forPages(discovery.list());
    for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.volatile.emit('nodes', list);
  } });
  try { discovery.start(); } catch (e) { console.warn('  [nodes] discovery off:', e.message); }
}
stageLink.configure(settings.stagewatchUrl || '', stagewatchKey(), settings.stagewatchFingerprint || '');
for (const room of store.rooms.values()) configureHallLink(room);

// ---------------------------------------------------------------- Patterns and PlayMap (lib/peerlinks.js)
// Linked by the admin (the node's own token, sealed in settings.json → peerLinks; the start of its certificate's
// fingerprint as typed, fpTyped), each read every 5 s; the verbs it lists are proposed to the show desk. A link may
// belong to a hall, so the hall's board row and its crew see it.
const peerLinks = new Map();   // node id -> PeerLink
/**
 * The nodes heard on the network, as pages are told them: a Patterns' or PlayMap's announced certificate only as there or
 * not — never its fingerprint, which anyone can announce; the characters that confirm one are read from the node's screen.
 */
function forPages(list) { return list.map((p) => (peerlinks.KINDS.has(p.t) ? { ...p, tls: !!p.tls } : p)); }
function startPeerLink(id, cfg) {
  const old = peerLinks.get(id);
  if (old) old.stop();
  if (!cfg) { peerLinks.delete(id); return null; }
  const link = new peerlinks.PeerLink({
    node: { t: cfg.t, id, name: cfg.name || cfg.t }, base: cfg.url, token: secretbox.open(cfg.tokenSealed) || '', confirmFp: tlsmod.typedFingerprint(cfg.fpTyped), hall: cfg.hall || '',
    pins, onPins: () => { settings.tlsPins = pins.toJSON(); saveSettings(); },
    findPeer: (nid) => (discovery ? discovery.peers.get(nid) || null : null),
    onChange: () => { boardDirty(); nodesChanged(); },
  });
  peerLinks.set(id, link);
  return link;
}
for (const [id, cfg] of Object.entries(settings.peerLinks && typeof settings.peerLinks === 'object' ? settings.peerLinks : {})) {
  if (cfg && peerlinks.KINDS.has(cfg.t) && typeof cfg.url === 'string') startPeerLink(id, cfg);
}
/** Someone watching the show network (the board, the admin page) should read it again. */
function nodesChanged() { for (const s of io.sockets.sockets.values()) if (s.data && (s.data.isAdmin || boardSockets.has(s))) s.emit('nodes:changed', {}); }
/**
 * May this socket drive a linked node? nodes.control in the node's hall; for a node linked for every hall (no hall),
 * nodes.control in every hall — one hall's rights never move what every hall sees.
 */
const mayDriveNode = (socket, link) => socket.data.isAdmin || !!(socket.data.account && rbac.can(socket.data.account, 'nodes.control', link.hall || undefined) && (link.hall || rbac.effective(socket.data.account).allHalls));
/**
 * The Stagewatch a node's proposals go to — its hall's (its own, else the default; the default for a node of every hall)
 * — and whether it keeps a desk now. A node linked for a hall that has been closed goes to none (`link: null`): a hall's
 * proposals never reach another hall's show caller, the default's included, so a link the admin has not moved fails
 * closed until it is linked again for a hall or for every hall.
 */
const deskFor = (node) => {
  if (node.hall && !store.has(node.hall)) return { link: null, desk: false };
  const l = linkFor(node.hall || '');
  return { link: l, desk: !!(l.linked && l.desk && !l.deskRefusal) };
};

// Stage sends waiting for the speaker: "<link>:<Stagewatch message id>" -> the AGMessage messages that show its state.
// A Stagewatch numbers its own messages, from 1 again when it restarts: two halls' Stagewatches can both send message 12,
// and so can one Stagewatch before and after a restart, or a link pointed elsewhere — each send is followed only while
// its link is still on the Stagewatch it went to (the link's generation), and one still waiting when it can no longer be
// followed reads "lost" on its record, never "sent" waiting for an acknowledgement that cannot come. A send followed again
// after AGMessage's own restart has no generation (0) until the link's first frame shows that Stagewatch has not
// restarted since: its seq is not below the seq of the send.
const stageSends = new Map();
function trackStageSend(link, ref, code, ids, { ack = 'sent', by = '', at = 0, seq = 0, gen = link.generation } = {}) {
  stageSends.set(link.id + ':' + ref, { link: link.id, code, ids, ack, by, at, seq, gen });
  if (stageSends.size > 200) stageSends.delete(stageSends.keys().next().value);
}
/** A send whose Stagewatch is no longer the one it went to: no longer followed, and a record still waiting ("sent") says
 *  so. One the speaker saw or acknowledged keeps what they did. */
function loseStageSend(key, t) {
  stageSends.delete(key);
  const room = store.room(t.code);
  if (!room) return;
  for (const id of t.ids) {
    const m = room.byId.get(id);
    if (m && m.stage && m.stage.ack === 'sent') apply(room, { o: 'upd', id, f: { stage: { ...m.stage, ack: 'lost' } } });
  }
}
/** The live frame says who acknowledged which message: show it on the message that was sent. */
function followStageAck(link, view) {
  if (!view) return;
  for (const [key, t] of Array.from(stageSends)) {
    if (t.link !== link.id) continue;
    if (!t.gen) {
      if (view.seq !== null && view.seq < t.seq) loseStageSend(key, t);   // restarted since the send
      else t.gen = link.generation;
    } else if (t.gen !== link.generation) loseStageSend(key, t);   // restarted, or the link now points elsewhere
  }
  const key = view.messageId ? link.id + ':' + view.messageId : '';
  if (!key || !stageSends.has(key)) return;
  const t = stageSends.get(key);
  const ack = view.messageAck || 'sent';
  if (ack === t.ack && (view.messageAckBy || '') === t.by) return;
  t.ack = ack; t.by = view.messageAckBy || '';
  const room = store.room(t.code);
  if (!room) return;
  for (const id of t.ids) {
    const m = room.byId.get(id);
    if (m && m.stage) apply(room, { o: 'upd', id, f: { stage: { ...m.stage, ack, by: t.by } } });
  }
  if (ack === 'seen' || ack === 'done') noteEvent('the speaker ' + (ack === 'done' ? 'acknowledged' : 'saw') + ' a stage message', link);
}

// After a restart, keep following the sends the speaker has not acknowledged yet, from every room of every hall: the
// send's link, its Stagewatch's address tag and the seq of its frames then live on the message (a send saved without
// them went to its hall's link). One whose hall now follows another Stagewatch is left: its acknowledgement can only
// come from the one it went to. This runs before any frame can arrive, and writes nothing (the data folder is not held
// yet).
for (const room of store.allRooms()) {
  for (const m of room.messages) {
    const st = m.stage;
    if (!st || !st.ref || !st.ack || st.ack === 'done' || st.ack === 'lost') continue;
    const link = st.link ? allLinks().find((l) => l.id === st.link) : linkFor(room.hall);
    if (!link || (st.sw && st.sw !== link.tag)) continue;
    const t = stageSends.get(link.id + ':' + st.ref);
    if (t && t.code === room.code && t.at === (st.at || 0)) t.ids.push(m.id);   // the send's record and its source message
    else trackStageSend(link, st.ref, room.code, [m.id], { ack: st.ack, by: st.by || '', at: st.at || 0, seq: Number.isInteger(st.seq) ? st.seq : 0, gen: 0 });
  }
}

// ---------------------------------------------------------------- the show desk (Show Bus 1.2 §11)
// Proposals this AGMessage made, followed until they end: desk id -> the messages that show their state. "lost": the
// desk no longer has it (it restarted, or the hall moved to another Stagewatch) — never another proposal's decision.
const FINAL = new Set(['rejected', 'done', 'failed', 'undelivered', 'lost']);
// Keyed "<link>:<desk id>": each Stagewatch numbers its own proposals; `sw`, `line` and the link's generation (the
// Stagewatch as it was then) say which one of that number is ours.
const proposals = new Map();
function trackProposal(linkId, id, code, ids, state, { sw = '', line = '' } = {}) {
  if (FINAL.has(state)) return;
  const key = linkId + ':' + id;
  // The desk handed out a number it had handed out before (it restarted): the proposal followed under it is gone.
  const was = proposals.get(key);
  if (was && !ids.some((x) => was.ids.includes(x))) loseProposal(key, was, 'it restarted');
  const link = allLinks().find((l) => l.id === linkId);
  proposals.set(key, { link: linkId, id, code, ids, state, sw, line, created: 0, gen: link ? link.generation : 0 });
  if (proposals.size > 200) proposals.delete(proposals.keys().next().value);
}
// After a restart, keep following the ones still open, from every room of every hall (their state, and the link they
// went to, live on the messages).
for (const room of store.allRooms()) {
  for (const m of room.messages) if (m.proposal && m.proposal.id && !FINAL.has(m.proposal.state)) {
    const linkId = m.proposal.link || 'default';
    const t = proposals.get(linkId + ':' + m.proposal.id);
    if (t) t.ids.push(m.id); else trackProposal(linkId, m.proposal.id, room.code, [m.id], m.proposal.state, m.proposal);
  }
}
/** Why the desk's proposal of this number is not the one we made, or '' when it is (pure on its facts). */
function notOurs(t, p, link) {
  if (t.sw && t.sw !== link.tag) return 'the hall moved to another Stagewatch';
  if (p.gone || (t.gen && t.gen !== link.generation)) return 'it restarted';
  if ((p.from && p.from.id && p.from.id !== settings.nodeId) || (t.line && p.line && p.line !== t.line) || (t.created && p.created && p.created !== t.created)) return 'it restarted';
  return '';
}
function loseProposal(key, t, why) {
  proposals.delete(key);
  showProposalState(t, { state: 'lost', words: 'Stagewatch no longer has this request (' + why + ') — ask again if it is still wanted', decidedBy: '' });
}
function showProposalState(t, p) {
  const room = store.room(t.code);
  if (!room) return;
  for (const id of t.ids) {
    const m = room.byId.get(id);
    if (m && m.proposal) apply(room, { o: 'upd', id, f: { proposal: { ...m.proposal, state: p.state, ok: typeof p.ok === 'boolean' ? p.ok : null, words: p.words || '', by: p.decidedBy || '' } } });
  }
}
// Approved proposals aimed at this AGMessage, already run, so none is run twice (Stagewatch's claim is the first guard).
// Keyed by the desk's address tag, its id, when it was made and its line: a restarted desk's new p1 is a new proposal.
const ranKeys = new Map();   // key -> true, oldest first, at most 500
const ranKey = (sw, p) => sw + ':' + p.id + ':' + (p.created || 0) + ':' + p.line;
function rememberRun(key) { ranKeys.set(key, true); if (ranKeys.size > 500) ranKeys.delete(ranKeys.keys().next().value); }
for (const r of deskResults) rememberRun(ranKey(r.sw, r));   // a result read back off the disk is reported, never run again
const DESK_AUTH_WAIT_MS = parseInt(process.env.AGM_DESK_AUTH_WAIT_MS || '', 10) > 0 ? parseInt(process.env.AGM_DESK_AUTH_WAIT_MS, 10) : 60_000;
const saveDeskResults = () => deskLane.save(() => JSON.stringify({ v: 1, results: deskResults.map(deskresults.persisted) }, null, 1));
/**
 * The link a waiting result is told through: its hall's Stagewatch (or the default the hall fell back on), while that
 * is still the Stagewatch it came from; null when nobody is left to tell (the hall closed, or it follows another one now).
 */
function deskLinkOf(r) {
  let link = stageLink;
  if (r.link !== 'default') { const code = r.link.slice(5); if (!store.get(code)) return null; link = linkFor(code); }
  return link.tag && link.tag !== r.sw ? null : link;
}
/**
 * The show-desk results waiting, as health shows them: how many, since when, the desk's last answer to a result post
 * (status 0: none came) and when, and when the next try is due — only over results whose Stagewatch is linked with a
 * desk now (null: none will be tried until one is).
 */
function deskFacts() {
  const tried = deskResults.filter((r) => { const l = deskLinkOf(r); return l && l.linked && l.desk; });
  const now = Date.now();
  const nextAt = tried.length ? Math.max(now, Math.min(...tried.map((r) => Math.max(r.nextAt, deskLinkOf(r).waitUntil)))) : null;
  return {
    waiting: deskResults.length,
    oldestAt: deskResults.length ? Math.min(...deskResults.map((r) => r.ran)) : null,
    lastStatus: deskLastAnswer.status, lastAt: deskLastAnswer.at,
    nextAt, nextInMs: nextAt === null ? null : nextAt - now,   // the page reads the wait, not this laptop's clock
  };
}
/** A result is no longer waiting: said once at role level (no notice text, no ids), and the file follows. */
function endResult(r, how) {
  const i = deskResults.indexOf(r);
  if (i < 0) return;
  deskResults.splice(i, 1);
  saveDeskResults();
  if (how !== 'taken') noteEvent('a show-desk result could not be reported: ' + how, { id: r.link });
  else if (r.posts > 1) noteEvent('a show-desk result was taken after ' + r.posts + ' tries', { id: r.link });
}
/** When the next try of a result that could not be told is due, after this answer. */
const waitAfter = (answer, attempt) => deskresults.postVerdict(answer, attempt, { authWaitMs: DESK_AUTH_WAIT_MS }).waitMs || deskresults.postVerdict({ status: 0 }, attempt).waitMs;
/**
 * One try at telling the desk a result. Its first post goes in the tick that collected it, through that link; every later
 * one, one after a restart and one through a link made since first reads the desk's proposal back and posts only while
 * it is still the one that ran and waits. True when the result needs nothing more (taken, or refused or gone for good).
 */
async function tellResult(r, link) {
  const gen = link.generation;
  if (!r.fresh || r.gen !== gen) {
    const a = await link.proposalAnswer(r.id);
    if (link.generation !== gen || link.tag !== r.sw) return false;   // pointed elsewhere meanwhile: the next tick decides
    const seen = a.status === 200 ? deskresults.readBack(r, a.proposal, { sameStagewatch: r.gen === link.generation }) : a.status === 404 ? 'gone' : 'wait';
    if (seen === 'taken' || seen === 'gone') { endResult(r, seen); return true; }
    if (seen === 'wait') { r.attempts++; r.lastStatus = a.status; r.nextAt = Date.now() + waitAfter(a.status === 200 ? { status: 0 } : a, r.attempts); return false; }
  }
  r.fresh = false;
  const res = await link.reportResult(r.id, r.ok, r.words);
  r.attempts++; r.posts++; r.lastStatus = res.status;
  deskLastAnswer = { status: res.status, at: Date.now() };
  const v = deskresults.postVerdict(res, r.attempts, { authWaitMs: DESK_AUTH_WAIT_MS });
  if (v.final) { endResult(r, v.final); return true; }
  r.nextAt = Date.now() + v.waitMs;
  return false;
}

/**
 * What AGMessage does when the show desk approves a proposal aimed at it. One verb: "notice <text>" — a notice shown
 * to everyone in every open meeting (e.g. "Break in 5 minutes"), in every room of each (a Legal-only lawyer hears the
 * break too). Its own checks apply: length, and nothing to post into when no meeting is open. A meeting is a hall, as
 * the context counts them (Stagewatch's word): it is answered "shown in N meetings" by the halls with a room that took
 * the line. Returns {ok, words}.
 */
function runApproved(p) {
  const m = /^notice\s+(.+)$/i.exec(guard.str(p.line).trim());
  if (!m) return { ok: false, words: 'AGMessage only takes "notice <text>" — not "' + guard.str(p.line).slice(0, 60) + '"' };
  const text = m[1].replace(/^"(.*)"$/, '$1').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return { ok: false, words: 'an empty notice' };
  const rooms = store.allRooms();
  if (!rooms.length) return { ok: false, words: 'no meeting is open to show it in' };
  // The meetings it was shown in are the halls of the lines the op table took, never the meetings it was meant for.
  const took = rooms.filter((room) => systemMessage(room, '📣 From the show desk' + (p.decidedBy ? ' (approved by ' + p.decidedBy + ')' : '') + ': ' + text));
  const shown = new Set(took.map((room) => room.hall)).size;
  if (!shown) return { ok: false, words: 'the notice could not be saved in any meeting' };
  noteEvent('the show desk posted a notice to the meetings');
  return { ok: true, words: 'shown in ' + shown + ' meeting' + (shown === 1 ? '' : 's') };
}

// Every linked Stagewatch that keeps a desk, one after another (one request at a time to each): what it approved for this
// AGMessage — run once, whichever desk it came from, and reported until it is taken — then our proposals' states. A link
// Stagewatch asked to wait (Retry-After) is left alone till then. Nothing runs before this copy holds its data folder.
let deskBusy = false;
setInterval(async () => {
  if (deskBusy || !serving) return;
  deskBusy = true;
  try {
    for (const r of Array.from(deskResults)) if (!deskLinkOf(r)) endResult(r, 'nobody to tell');
    // A hall moved to another Stagewatch, or back on the default (its own link gone): what it proposed at the one it
    // left can no longer be followed — whether or not the one it follows now is up or keeps a desk.
    const byId = new Map(allLinks().map((l) => [l.id, l]));
    for (const [key, t] of Array.from(proposals)) {
      const l = byId.get(t.link);
      if (!l || (t.sw && t.sw !== l.tag)) loseProposal(key, t, 'the hall moved to another Stagewatch');
    }
    for (const link of allLinks()) {
      // Stagewatch asked this key to wait, or no longer takes it: nothing more goes to it this tick, whatever was next.
      const stop = () => !link.linked || link.held;
      if (stop()) continue;
      if (Date.now() - link.deskCheckedAt > link.deskCheckMs) {
        const was = link.desk;
        await link.checkDesk(settings.nodeId);
        if (was !== link.desk) onStageState(link, link.view);
      }
      if (!link.desk || stop()) continue;
      // Collected first, inside Stagewatch's minute for collecting: run once, on disk, then each first post at once. What
      // a collect hands over belongs to the Stagewatch it was asked of, even if the link was pointed elsewhere meanwhile.
      const fresh = [];
      const tag = link.tag, gen = link.generation, refusalWas = link.deskRefusal;
      const approved = await link.approvedFor(settings.nodeId);
      if (link.deskRefusal !== refusalWas) {
        noteEvent(link.deskRefusal ? 'Stagewatch\'s show desk refuses to hand AGMessage what it approves: ' + link.deskRefusal : 'Stagewatch\'s show desk hands AGMessage what it approves again', link);
        onStageState(link, link.view);
      }
      for (const p of approved) {
        const key = ranKey(tag, p);
        if (ranKeys.has(key)) continue;
        rememberRun(key);
        const r = { sw: tag, link: link.id, id: p.id, created: p.created || 0, line: p.line, target: settings.nodeId, ...runApproved(p), ran: Date.now(), attempts: 0, posts: 0, nextAt: 0, lastStatus: 0, gen, fresh: true };
        deskResults.push(r); fresh.push(r);
        if (deskResults.length > deskresults.MAX_WAITING) endResult(deskResults[0], 'too many waiting');
      }
      // On disk before any is reported, once for all collected: a restart from here still reports them. (A disk that
      // will not take it leaves them in memory, still reported, and the lane's own retry names the failure in health.)
      if (fresh.length) { saveDeskResults(); deskLane.flushSync(); }
      // Then the results due, the new ones first and the rest oldest first: the first that must wait stops the rest. A new
      // one this tick did not reach is no longer new: its turn comes with the rest, its proposal read back first.
      const due = fresh.concat(deskResults.filter((r) => !fresh.includes(r) && r.nextAt <= Date.now())).filter((r) => deskLinkOf(r) === link);
      try {
        for (const r of due) {
          if (stop()) break;
          if (!deskResults.includes(r)) continue;   // pushed out by the cap meanwhile
          if (!(await tellResult(r, link))) break;
        }
      } finally { for (const r of fresh) r.fresh = false; }
      // Our proposals at this desk, all in one read of what this node proposed: one request a tick however many wait for
      // the show caller, so following them never spends the key's minute. One the desk no longer lists is gone.
      const mine = Array.from(proposals).filter(([, t]) => t.link === link.id);
      const listed = mine.length && !stop() ? await link.proposalsFrom(settings.nodeId) : null;
      for (const [key, t] of listed ? mine : []) {
        const p = listed.get(t.id) || { gone: true };
        const why = notOurs(t, p, link);
        if (why) { loseProposal(key, t, why); continue; }
        if (!t.created && p.created) t.created = p.created;
        if (p.state !== t.state) { t.state = p.state; showProposalState(t, p); }
        if (FINAL.has(p.state)) proposals.delete(key);
      }
    }
  } catch { /* the next tick tries again */ } finally { deskBusy = false; }
}, 3000).unref();

/**
 * This node's context (Show Bus §6): facts, counts and prompt titles — no message text, no names. For a Stagewatch link,
 * only the halls that follow it (their meetings, prompts and help, and that link itself): a hall's board questions never
 * reach another hall's Stagewatch, its crew or its AI. Without one, the whole node (GET /api/context).
 */
function currentContext(link) {
  const rooms = link ? roomsUsing(link) : Array.from(store.rooms.values());
  const codes = new Set(rooms.map((r) => r.code));
  const own = link || stageLink;
  return buildContext({
    node: { id: settings.nodeId, name: 'AGMessage' },
    rooms,
    stage: { status: own.status, key: own.keyState, keyWords: own.keyWords, view: own.view, clock: own.clockInfo(), context: own.context },
    halls: link ? [] : Array.from(hallLinks.values()).map((l) => ({ status: l.status, key: l.keyState, keyWords: l.keyWords, view: l.view, clock: l.clockInfo(), context: l.context })),
    help: rooms.reduce((n, r) => n + board.openHelp(r).length, 0),
    peerContexts: Object.fromEntries(Array.from(peerLinks.values()).filter((l) => l.status === 'live' && l.context && (!link || !l.hall || codes.has(l.hall))).map((l) => [l.node.id, { light: l.context.light, headline: l.context.headline }])),
    peers: discovery ? discovery.list() : [],
    aiOn: !!aiKey(), tunnel: !!tunnelProc, recent: link ? recentEvents.filter((e) => !e.link || e.link === link.id) : recentEvents,
  });
}
// Post each linked Stagewatch its own context: on change, and at least every 5 s. Refresh Stagewatch's own every 5 s.
setInterval(() => {
  for (const link of allLinks()) {
    if (!link.linked || link.held) continue;
    const ctx = currentContext(link);
    const sig = JSON.stringify({ ...ctx, at: 0 });
    if (sig !== link.lastPushed || Date.now() - (link.lastPushAt || 0) >= 5000) {
      link.lastPushed = sig; link.lastPushAt = Date.now();
      link.pushContext(ctx).catch(() => {});
    }
    if (Date.now() - link.contextAt >= 5000) link.fetchContext().catch(() => {});
  }
}, 1000).unref();

// ---------------------------------------------------------------- Cloudflare tunnel (admin-only)
let tunnelProc = null, tunnelUrl = null, tunnelError = null;
let tunnelUp = false;          // the address is taken as reachable: cloudflared said its connection is registered, or the wait for it ran out
let tunnelCheck = null;        // the newest check of the link: {at, ok, p50Ms, maxMs, words}
let tunnelChecking = false;    // one check at a time
let tunnelAgain = null;        // when a start turned the running tunnel on again, inside its kept end: its address is new
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// Cloudflare's banner gives the address before it is reachable ("it may take some time to be reachable"); this line is
// cloudflared's own word that a connection to Cloudflare stands. A cloudflared that words it otherwise is checked once
// TUNNEL_URL_MS has passed with the address known, so the check never rests on that wording alone.
const TUNNEL_UP_RE = /Registered tunnel connection/;
// The link's check: its own address's /api/health, this many times, one at a time, each with this deadline; asked again
// by an admin page only this long after the newest check.
const TUNNEL_CHECK_TRIES = 5;
const TUNNEL_CHECK_DEADLINE_MS = 5000;
const TUNNEL_CHECK_EVERY_MS = 60_000;

/**
 * What an admin page is told of the tunnel: whether a check of the link is under way, and the newest one's facts; the end
 * it is kept on until (`until`, null when none is kept), with its words and its time of day by this laptop's clock
 * (`untilWords`, `untilClock`: a page shows these, never its own clock's, since Tunnel until… is read by this laptop's);
 * when a start turned it on again, so its address is new (`again`, `againWords`); and why a restart would not turn it on
 * again (`notKept`, '' when it would).
 */
function tunnelStatus(now = Date.now()) {
  const until = keptUntil(now);
  const again = tunnelProc ? tunnelAgain : null;
  return {
    running: !!tunnelProc, url: tunnelUrl, error: tunnelError, checking: tunnelChecking, check: tunnelCheck,
    until, untilWords: until === null ? '' : tunnelend.clockWords(until, now), untilClock: until === null ? '' : tunnelend.clockOf(until),
    again, againWords: again === null ? '' : tunnelend.clockWords(again, now), notKept: tunnelNotKept(),
  };
}
/**
 * The end the internet link is kept on until (ms since the epoch), or null: `tunnelUntil` in the settings, as a start reads
 * it (inside its time or past it; never one no act could set). Turn on keeps one, Tunnel until… moves it; it is forgotten
 * by Turn off, by the end coming, by a start past it and by a Turn on whose cloudflared ended before it gave an address.
 * A stop or a crash of AGMessage keeps it, and so do a cloudflared that ends of its own once it gave its address and one
 * a start could not turn on again: a start before the end turns the link on again, and Turn on keeps that end.
 */
const keptUntil = (now = Date.now()) => tunnelend.keptEnd(settings.tunnelUntil, now).until;
/** The kept end and its words by this laptop's clock, as Turn on and Tunnel until… answer them. */
const tunnelEndFacts = (now = Date.now()) => { const until = keptUntil(now); return { until, untilWords: until === null ? '' : tunnelend.clockWords(until, now) }; };
/** Why a restart would not turn the link on again, in words: an end is held, but the settings could not be read, so it is saved nowhere. */
const tunnelNotKept = () => (keptUntil() !== null ? settingsUnsaved() : '');
/** The tunnel's end kept (a time) or forgotten (null) in the settings; a run whose settings could not be read holds it in memory only. */
function keepTunnelEnd(until) {
  if (until === null) {
    if (!Object.hasOwn(settings, 'tunnelUntil')) return;
    delete settings.tunnelUntil;
  } else settings.tunnelUntil = until;
  saveSettings();
}
let tunnelStartRead = false;   // the start has read the kept end: until then, the health tick leaves it to the start
/**
 * A start reads the tunnel's kept end: inside it the tunnel is turned on again, and once cloudflared gives the address
 * the admin page, "This laptop" and the console say it is new (a quick tunnel's always is); past it, or one that does not
 * read as an end any act could set, it is forgotten and the tunnel stays off. A link a person turned on while the
 * banner was said is theirs, with the end Turn on kept, and nothing is said of it here.
 */
function tunnelAtStart(now) {
  tunnelStartRead = true;
  if (tunnelProc) return;
  const kept = tunnelend.keptEnd(settings.tunnelUntil, now);
  if (kept.why === 'none') return;
  if (!kept.on) {
    keepTunnelEnd(null);
    console.log('  [tunnel] ' + (kept.why === 'past' ? 'its end, ' + tunnelend.clockWords(kept.until, now) + ', came while AGMessage was not running' : 'its kept end is not one AGMessage sets') + ': the internet link stays off');
    return;
  }
  const started = startTunnel(now);
  if (!started.ok) tunnelNotAgain(now, started.error);
}
/** Words that end as a sentence does. */
const sentence = (w) => (/[.!?]$/.test(w) ? w : w + '.');
/** A start's cloudflared gave its address: the link is on again, and its address is new, said where the admin reads. */
function tunnelOnAgain(now = Date.now()) {
  const until = keptUntil(now);
  const end = until === null ? '' : ' until ' + tunnelend.clockWords(until, now);
  console.log('  [tunnel] on again' + end + ': a quick tunnel\'s address is new at each start, so remote people need the new one (the admin page gives it)');
  noteEvent('the internet link was turned on again as AGMessage started, with a new address');
  audit.write(SYSTEM_ACTOR, 'tunnel.again', 'tunnel', 'the internet link turned on again as AGMessage started,' + end + ', with a new address');
}
/**
 * A start could not turn the link on again (`cause`: cloudflared could not start, or ended before it gave an address,
 * as at a boot before the network is up): said on the card (the error), "This laptop" and the console, and its end kept,
 * so Turn on, or a start before the end, tries again.
 */
function tunnelNotAgain(at, cause) {
  const now = Date.now();
  const until = keptUntil(now);
  tunnelError = 'Not turned on again as AGMessage started at ' + tunnelend.clockWords(at, now) + ': ' + sentence(cause);
  console.log('  [tunnel] not turned on again: ' + sentence(cause) + (until === null ? '' : ' It was to stay on until ' + tunnelend.clockWords(until, now) + ': Turn on on the admin page, or a start of AGMessage before then, tries again.'));
  noteEvent('the internet link was not turned on again as AGMessage started');
}
/**
 * Read each health window against the wall clock: once the kept end has come the tunnel is turned off (or, when cloudflared
 * had ended, the end forgotten) and stays off; before it, the status goes again to the admin pages when its words by this
 * laptop's clock have changed ("tomorrow" become "today" at midnight).
 */
function tunnelAtItsEnd(now) {
  if (!tunnelStartRead) return;
  const until = keptUntil(now);
  if (until !== null && now >= until) {
    const on = !!tunnelProc;
    console.log('  [tunnel] its end, ' + tunnelend.clockWords(until, now) + ', has come: the internet link ' + (on ? 'is off' : 'stays off'));
    if (on) {
      noteEvent('the internet link ended at its end time');
      audit.write(SYSTEM_ACTOR, 'tunnel.ended', 'tunnel', 'the internet link turned off at its end, ' + tunnelend.clockWords(until, now));
    }
    stopTunnel();
    return;
  }
  if ((until !== null || tunnelAgain !== null) && tunnelWords(tunnelStatus(now)) !== tunnelWordsSaid) broadcastTunnelStatus();
}
let tunnelWordsSaid = '';   // the words by this laptop's clock the admin pages were last given
const tunnelWords = (st) => st.untilWords + '|' + st.againWords;
function broadcastTunnelStatus() {
  const payload = tunnelStatus();
  tunnelWordsSaid = tunnelWords(payload);
  for (const [, s] of io.sockets.sockets) if (s.data && s.data.isAdmin) s.emit('tunnel:status', payload);
}
/** One try of the link: the ms its answer took, or null when none came within the deadline or it was not this copy's. */
async function linkTry(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(TUNNEL_CHECK_DEADLINE_MS), headers: { 'cache-control': 'no-store' } });
    const body = await r.json();
    return r.ok && body && body.ok === true && body.build === BUILD.full ? performance.now() - t0 : null;
  } catch { return null; }   // no answer, a cut one or not JSON: a try the link did not answer
}
/**
 * The internet link, checked from this laptop: its own address's `/api/health` asked TUNNEL_CHECK_TRIES times, one at a
 * time, out to Cloudflare and back through cloudflared, each try with a deadline of its own (`AbortSignal.timeout`, so
 * the server starts no timer). It measures the laptop's side of the link, never a phone's (reading 7's walk is that).
 * A check is of one tunnel (its cloudflared and its address): one whose tunnel went or was started again meanwhile finds
 * nothing. Every check's end goes to every admin page on `tunnel:status`, with what it found when it found something, so
 * no page is left on "Checking…"; and a tunnel that came up while another's check ran, whose own check was turned away
 * then, is checked as that one ends.
 */
async function checkTunnel() {
  const proc = tunnelProc;
  const url = tunnelUrl;
  if (!proc || !url || tunnelChecking) return false;
  const same = () => tunnelProc === proc && tunnelUrl === url;
  tunnelChecking = true;
  broadcastTunnelStatus();
  const tries = [];
  try {
    for (let i = 0; i < TUNNEL_CHECK_TRIES; i++) {
      tries.push(await linkTry(url));
      if (!same()) break;   // the tunnel went or another came: the rest would ask a link that is not this one
    }
  } finally { tunnelChecking = false; }
  const found = same();
  if (found) tunnelCheck = readings.linkCheck(tries, Date.now());
  broadcastTunnelStatus();
  if (!found && tunnelUrl && tunnelUp && !tunnelCheck) startCheck();
  return found;
}
const startCheck = () => { checkTunnel().catch((e) => console.error('  [tunnel] the link\'s check failed: ' + (e && e.message))); };
/** This copy's own cloudflared, by its absolute path (lib/startup.js cloudflaredFile): bin beside app, never a bare name. */
const CLOUDFLARED = startup.cloudflaredFile({ programDir: path.dirname(__dirname) });
/** Why the link has no cloudflared, with the way to put it back that fits how this copy runs (lib/startup.js noCloudflaredWords). */
const NO_CLOUDFLARED = startup.noCloudflaredWords({ runs: RUNS });
/**
 * Why this copy's own cloudflared cannot be run now, in words, or '' when it is there: looked for as each start of the link
 * is asked, so one taken away since (an antivirus may remove it) is said before anything is run or kept, never looked for
 * elsewhere.
 */
function noCloudflared() {
  if (!CLOUDFLARED) return NO_CLOUDFLARED;
  try {
    const st = fs.statSync(CLOUDFLARED, { throwIfNoEntry: false });
    return st && st.isFile() ? '' : NO_CLOUDFLARED;
  } catch (e) { return 'Could not start cloudflared: ' + (e.code || e.message); }   // a folder in the way, or no right to read it
}
/** A start of the link refused before anything ran (`words`, why): said on the admin page's card and "This laptop", the link off. */
function tunnelRefused(words) {
  tunnelError = words; tunnelUrl = null; tunnelUp = false; tunnelCheck = null; tunnelAgain = null;
  broadcastTunnelStatus();
  return { ok: false, error: words };
}
/**
 * cloudflared started for this laptop's port; `again`, when a start turns the tunnel on again inside its kept end, else
 * `by` ({actor, ip}), the person who turned it on. Its end is the caller's: Turn on keeps one first, a start reads the one
 * kept. The audit log's row is written once cloudflared gives the address, when the link is open: one that ends before
 * then opened nothing.
 */
function startTunnel(again = null, by = null) {
  if (tunnelProc) return { ok: true, running: true, url: tunnelUrl };
  const missing = noCloudflared();
  if (missing) return tunnelRefused(missing);
  tunnelError = null; tunnelUrl = null; tunnelUp = false; tunnelCheck = null; tunnelAgain = again;
  // In AGMessage's own data folder (one server per folder), not a guessable name in the shared temp folder; this start's
  // own, read by its own poll, both let go wherever its cloudflared ends (release, below).
  const logfile = path.join(DATA_DIR, 'cloudflared.log');
  let proc;
  try {
    try { fs.unlinkSync(logfile); } catch { /* none left from an earlier run */ }
    proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--logfile', logfile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    return tunnelRefused(e && e.code === 'ENOENT' ? NO_CLOUDFLARED : 'Could not start cloudflared: ' + e.message);
  }
  tunnelProc = proc;
  let buf = '';
  // Read until the address is known and reachable: the link is checked once both are, the address first.
  const sniff = (chunk) => {
    if (tunnelProc !== proc) return;
    buf = (buf + chunk.toString()).slice(-32768);
    if (!tunnelUrl) {
      const m = buf.match(TRYCF_RE);
      if (m) {
        tunnelUrl = m[0];
        console.log('  [tunnel] ' + tunnelUrl);
        if (tunnelAgain !== null) tunnelOnAgain();
        else if (by) { const until = keptUntil(); audit.write(by.actor, 'tunnel.on', 'tunnel', 'the internet link turned on' + (until === null ? '' : ', until ' + tunnelend.clockWords(until, Date.now())), by.ip); }
        broadcastTunnelStatus();
      }
    }
    if (tunnelUrl && !tunnelUp && TUNNEL_UP_RE.test(buf)) { tunnelUp = true; startCheck(); }
  };
  if (proc.stdout) proc.stdout.on('data', sniff);
  if (proc.stderr) proc.stderr.on('data', sniff);
  let logFileSize = 0;
  let logPoll = setInterval(() => {
    if (tunnelUrl && tunnelUp) return;
    // One open handle, then its own size: what is read is the file that was opened (no check-then-open race).
    let fd = null;
    try {
      fd = fs.openSync(logfile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > logFileSize) {
        const b = Buffer.alloc(Math.min(size - logFileSize, 1 << 20));
        const n = fs.readSync(fd, b, 0, b.length, logFileSize);
        logFileSize += n;
        sniff(b.subarray(0, n));
      }
    } catch { /* not written yet: cloudflared makes it as it starts */ } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
  }, 500);
  // Cloudflare's time to give the address; given it, and cloudflared's registered line not read by then, the link is
  // taken as up and checked (which also ends the reading of its log).
  setTimeout(() => {
    if (tunnelProc !== proc) return;
    if (!tunnelUrl) {
      tunnelError = 'Cloudflare did not return a URL within ' + plural(Math.round(TUNNEL_URL_MS / 1000), 'second') + '. Check the laptop has internet access.';
      broadcastTunnelStatus();
    } else if (!tunnelUp) { tunnelUp = true; startCheck(); }
  }, TUNNEL_URL_MS);
  /**
   * This cloudflared gone (`cause`: why, in words, when it was not asked to go). Before it gave an address, a start's is a
   * link not turned on again, its end kept for Turn on or the next start; Turn on's kept nothing, since nothing was on.
   * Once it gave one, its end is kept: it was on, and a start before the end turns it on again.
   */
  const gone = (cause) => {
    const hadAddress = !!tunnelUrl;
    const again = tunnelAgain;
    tunnelProc = null; tunnelUrl = null; tunnelUp = false; tunnelAgain = null;
    if (!hadAddress && again !== null) tunnelNotAgain(again, cause);
    else if (!hadAddress) keepTunnelEnd(null);
    else {
      const until = keptUntil();
      if (until !== null) console.log('  [tunnel] cloudflared ended: ' + sentence(cause) + ' It was to stay on until ' + tunnelend.clockWords(until, Date.now()) + ': Turn on on the admin page, or a start of AGMessage before then, turns it on again.');
    }
    broadcastTunnelStatus();
  };
  /**
   * This start's log poll stopped and its log file removed, once: at its cloudflared's exit, and at an error, since one
   * that could not be run (its file gone between the look and the run) says 'error' and never 'exit'.
   */
  const release = () => {
    if (!logPoll) return;
    clearInterval(logPoll); logPoll = null;
    try { fs.unlinkSync(logfile); } catch { /* never made, or already gone */ }
  };
  proc.on('error', (err) => {
    release();
    tunnelError = err && err.code === 'ENOENT' ? NO_CLOUDFLARED : 'cloudflared error: ' + (err && err.message);
    if (tunnelProc === proc) gone(tunnelError);
    else broadcastTunnelStatus();
  });
  proc.on('exit', (code, signal) => {
    release();
    if (tunnelProc === proc) {
      if (code !== 0 && code !== null && !tunnelError) tunnelError = 'cloudflared exited (code ' + code + (signal ? ', signal ' + signal : '') + ').';
      gone(tunnelError || 'cloudflared ended (' + (signal ? 'signal ' + signal : 'code ' + code) + ').');
    }
  });
  broadcastTunnelStatus();
  return { ok: true, running: true, url: null };
}
/**
 * Turn off, and the end come: the end forgotten at once (so a stop of AGMessage before cloudflared has ended does not turn
 * it on again) and cloudflared asked to end, which, asked, says nothing of a link not turned on again.
 */
function stopTunnel() {
  keepTunnelEnd(null);
  tunnelAgain = null;
  if (!tunnelProc) { tunnelUrl = null; tunnelError = null; broadcastTunnelStatus(); return; }
  try { tunnelProc.kill('SIGTERM'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- lifecycle
let shuttingDown = false;
/**
 * A stop: the audit log, the lanes and the halls that changed saved (`saveAll`), then its record written last
 * (data/last-stop.json, lib/laststop.js), saying it saved only when all of them were: the next start writes "AGMessage
 * restarted" in each hall only after a stop that did not. Then gone. Before this copy holds its folder there is nothing
 * of its own to save, and it writes nothing.
 */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnelProc) { try { tunnelProc.kill('SIGTERM'); } catch { /* ignore */ } }
  if (laptopRead.child) { try { laptopRead.child.kill('SIGKILL'); } catch { /* it has ended */ } }   // a read of Windows ends with the server
  powerRequest.end();   // and so does the power request
  if (serving) {
    console.log('\n  Saving…');
    const { unsaved, halls } = saveAll();
    let rec = null;
    try { rec = laststop.record(DATA_DIR, { at: Date.now(), build: BUILD.full, unsaved }); } catch (e) {
      console.error('  [save] ' + laststop.FILE + ' could not be written (' + (e.code || e.message) + '): the next start says AGMessage restarted in each hall');
    }
    if (rec && rec.saved) console.log('  Saved: the audit log, every store and ' + (halls ? plural(halls, 'hall') + ' that changed' : 'no hall, none having changed') + '.');
    else if (unsaved.length) console.error('  Not saved: ' + unsaved.join(', ') + '. The next start says AGMessage restarted in each hall.');
  }
  leaveShowNetwork();
  releaseDataFolder();
  process.exit(code);
}
/** What waits for this copy to hold its folder before it is written (a row a link's first answer asks for); now once it does. */
const untilServing = [];
function whenServing(fn) { if (serving) fn(); else untilServing.push(fn); }
/**
 * This copy cannot run as configured: its words on the console and the code the watchdog reads (3, which it never
 * restarts; 75 when the installed node's port or folder is held, which it tries again). Called before anything is
 * written, or when a first write fails; the show network is left and the folder let go.
 */
function cannotStart(words, code = resilience.EXIT.CONFIG) {
  console.error('\n  AGMessage cannot start: ' + words + '\n');
  try { leaveShowNetwork(); } catch { /* this copy ends either way: nothing of the network may keep it from stopping */ }
  releaseDataFolder();
  process.exit(code);
}
/** Every Stagewatch, hall and peer link stopped, and discovery with them: this copy says nothing more on the show network. */
function leaveShowNetwork() {
  for (const link of allLinks()) link.stop();
  for (const link of peerLinks.values()) link.stop();
  if (discovery) discovery.stop();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));   // the console window closed (Windows allows about 10 s) or the terminal went away
// A stop asked over IPC (the watchdog, a test) saves exactly as a signal does: on Windows a signal sent to a child is not
// delivered, the process just ends, and nothing would be saved. A watchdog gone (its channel closed) leaves no server.
// A sleep the watchdog recorded (supervise.js) is kept with the show day's peaks, read by type, and saved with its window.
if (typeof process.send === 'function') {
  process.on('message', (m) => {
    if (m && m.t === 'stop') shutdown(0);
    else if (m && m.t === 'slept') peaks.slept(m, Date.now());
  });
  process.on('disconnect', () => shutdown(0));
}
// An uncaught error leaves Node in an unknown state, so it doesn't carry on: save the rooms, record the crash
// (shown on the admin page after the restart) and exit for the watchdog (supervise.js) to restart within ~2 s.
// A rejected promise nobody handled is logged and counted (admin health): the request it belonged to failed,
// the meeting carries on.
process.on('uncaughtException', (e) => {
  console.error('  [error]', e && e.stack ? e.stack : e);
  // Before this copy holds its folder another copy may own those files, and nothing of this one's is there to save.
  if (!serving) { releaseDataFolder(); process.exit(resilience.EXIT.CRASH); }
  try { powerRequest.end(); } catch { /* its input closes as this process ends, which ends it too */ }
  // cloudflared ends with this copy, its end kept: the restart turns the tunnel on again rather than leave this one beside it.
  if (tunnelProc) { try { tunnelProc.kill('SIGTERM'); } catch { /* it has ended */ } }
  // Saved in the stop's order, but with no record of a stop: a crash is not one, so the restart says AGMessage restarted.
  try { saveAll(); } catch { /* best effort: what could not be written has said so on the console */ }
  try {
    resilience.writeFileAtomic(CRASH_PATH, JSON.stringify({ at: Date.now(), message: String(e && e.message ? e.message : e).slice(0, 500), stack: String(e && e.stack ? e.stack : '').slice(0, 4000) }));
    fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), new Date().toISOString() + ' ' + String(e && e.stack ? e.stack : e) + '\n');
  } catch { /* the console has it */ }
  releaseDataFolder();
  process.exit(resilience.EXIT.CRASH);
});
process.on('unhandledRejection', (e) => { rejections++; console.error('  [error] unhandled rejection:', e && e.message ? e.message : e); });

// The watchdog's heartbeat: sent from the event loop, so a hung loop stops it (that silence is what restarts us), and
// from the one long piece of work a start does in one go, the data folder's copy before it moves to a new format.
// A send's failure (the watchdog gone, its pipe broken) comes to the callback: without one it would be an 'error' event on
// the process, unhandled, and end it before 'disconnect' lets it save.
function beat() { if (typeof process.send === 'function' && process.connected) process.send({ t: 'beat' }, () => { /* the watchdog gone: 'disconnect' stops us */ }); }
if (typeof process.send === 'function') setInterval(beat, 1000).unref();

// A port already in use is named by who holds it: its health, read once at loopback with no token, chooses the words (an
// AGMessage, the one installed on this PC, or another program), and nothing else. Either way this copy stops without
// serving, whatever the read or its words do: code 3, which the watchdog does not restart, in the portable folder, where a
// person reads the words; 75 for the installed node, which the watchdog tries again on its ladder, never counted as a
// crash, so whatever holds the port during a restart cannot keep the node down. A copy that will never serve first leaves
// the show network: its links and discovery, started before the port was known, say nothing during the read.
//
// Once it listens, an error on the port is one Node met taking a connection (EMFILE: out of file handles, ENFILE,
// ENOMEM): that connection is lost, the port still listens, and the copy keeps serving, the error counted in health and
// said. Should the port stop listening, the copy stops as a crash does: saved, with a code the watchdog restarts.
let listening = false;
const acceptErrors = { count: 0, last: '' };   // errors on the port after it listened (health's `acceptErrors`)
front.on('error', (e) => {
  if (listening) {
    acceptErrors.count++;
    acceptErrors.last = String(e && e.code ? e.code : 'EIO').slice(0, 20);
    if (acceptErrors.count <= 20 || acceptErrors.count % 100 === 0) console.error('  [port] a connection could not be taken (' + acceptErrors.last + ', ' + acceptErrors.count + ' so far): ' + (front.listening ? 'still serving' : 'the port stopped listening, so AGMessage saves and stops for its watchdog to start it again'));
    if (!front.listening) shutdown(resilience.EXIT.CRASH);
    return;
  }
  const held = e.code === 'EADDRINUSE';
  const stop = () => { releaseDataFolder(); process.exit(held && RUNS === 'task' ? resilience.EXIT.HELD : resilience.EXIT.CONFIG); };
  try { leaveShowNetwork(); } catch { /* this copy ends either way: nothing of the network may keep it from stopping */ }
  if (!held) { console.error('\n  AGMessage cannot start: port ' + PORT + ' cannot be used (' + (e.code || e.message) + ').\n'); stop(); return; }
  startup.readPortHolder(PORT).catch(() => null)
    .then((holder) => { console.error('\n  ' + startup.portHolderWords(holder, { port: PORT, runs: RUNS }) + '\n'); })
    .finally(stop);
});

// ---------------------------------------------------------------- one server per data folder
// Two copies on one folder would each number the same rooms' ops, chain the same audit log and save the same accounts.
// The folder is held by a local socket named after it — a named pipe on Windows, gone with the process; a Unix socket
// elsewhere, a leftover of a killed process known by nobody answering it — and a second copy that finds it held stops
// before it has written anything: code 3, which the watchdog does not restart, in the portable folder; 75 for the
// installed node, which tries again, so whatever takes the pipe's name during a restart cannot keep the node down.
// It is held under two names when they differ: 0.5.1's (the folder's path as given), so a 0.5.1 copy and this one refuse
// each other, and the folder's own (resilience.placeId, its real path), so two paths to one folder are one folder. A
// folder not made yet (this copy makes it once it holds it) is held by its path as given.
//
// Once this copy serves, each hold answers whoever connects with the busy line (lib/busy.js), one line of counts, and
// ends the connection: a read, never a command. A second copy refused at the folder reads it for its words. Anyone may
// connect to a pipe, and whatever took its name first answers in its place, so what is read there chooses words and
// nothing else.
const folderHolds = [];
function holdDataFolder(then) {
  const legacy = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(DATA_DIR).toLowerCase() : path.resolve(DATA_DIR)).digest('hex').slice(0, 16);
  const own = resilience.placeId(DATA_DIR, undefined, { absentOk: true });
  const ids = own === legacy ? [legacy] : [legacy, own];
  // The copy that holds the folder, as its busy line says (`text`, read from its pipe), in words: busy with what, idle
  // with what is open, or nothing when it said no line (0.5.1, which answers none, or a copy still starting).
  const refuse = (text) => {
    const l = busy.read(text);
    const says = l ? ' It says it is ' + (busy.isBusy(l) ? 'busy: ' : 'idle: ') + busy.words(l) + '.' : '';
    console.error('\n  AGMessage is already running on this data folder (' + DATA_DIR + ').' + says + ' ' + (RUNS === 'task' ? 'AGMessage tries again once it is free.' : 'Use that window, or give this copy a folder of its own.') + '\n');
    process.exit(RUNS === 'task' ? resilience.EXIT.HELD : resilience.EXIT.CONFIG);
  };
  const holdOne = (i) => {
    if (i >= ids.length) { then(); return; }
    const where = process.platform === 'win32' ? '\\\\.\\pipe\\agmessage-' + ids[i] : path.join(os.tmpdir(), 'agmessage-' + ids[i] + '.sock');
    let done = false;
    const next = () => { if (!done) { done = true; holdOne(i + 1); } };
    const unchecked = (e) => { console.warn('  [folder] could not hold the data folder (' + (e.code || e.message) + '): a second copy on it is not refused'); next(); };
    const hold = net.createServer((c) => {
      c.on('error', () => { /* a second copy that asked and went: nothing to answer */ });
      let said = '';
      try { if (serving) said = JSON.stringify(busyNow()) + '\n'; } catch { said = ''; /* no line this time: the connection still ends */ }
      c.end(said);
    });
    hold.unref();
    hold.once('error', (e) => {
      if (e.code !== 'EADDRINUSE') return unchecked(e);
      // Held: on Windows a pipe's name is held only while its copy runs; elsewhere a socket file nobody answers is a killed
      // copy's leftover, taken over. Either way what the holder answers is read once, for the words.
      machinewire.askPipe(where).then(({ connected, text }) => {
        if (connected || process.platform === 'win32') { refuse(text); return; }
        hold.once('error', unchecked);
        fs.unlink(where, () => { hold.listen(where, () => { folderHolds.push(hold); keepHolding(hold); next(); }); });
      });
    });
    hold.listen(where, () => { folderHolds.push(hold); keepHolding(hold); next(); });
  };
  holdOne(0);
}
/**
 * A hold that listens is kept for the life of the copy: an error on it afterwards (a connection it could not take) is said
 * and the hold kept, since it is there to be found held, never to answer.
 */
function keepHolding(hold) {
  hold.removeAllListeners('error');
  hold.on('error', (e) => { console.warn('  [folder] the hold on the data folder met ' + ((e && e.code) || 'an error') + ': still held'); });
}
/**
 * The black window's lines for what the audit log needs of the person at this laptop that `said` has not said yet, each
 * said once: the first keyed start's question about the older entries, or one line for each other finding or condition.
 */
function auditAttentionLines(said) {
  const lines = [];
  for (const a of audit.facts().attention) {
    const key = a.id || a.kind + ':' + a.words;
    if (said.has(key)) continue;
    said.add(key);
    if (a.kind === 'plain' && a.first) {
      lines.push('  Audit log:   ' + a.words.replace(/, and nothing vouches for them until they are accepted$/, '') + '; anyone who');
      lines.push('               could write this folder could have rewritten them. If this log has been in your hands,');
      lines.push('               accept them: http://localhost:' + PORT + '/admin → Health → Accept, and type the token above.');
      lines.push('               Until then the log reads △. Nothing waits for this.');
    } else lines.push('  Audit log:   ' + (a.mark === 'broken' ? '✕ ' : '△ ') + a.words);
  }
  return lines;
}
/**
 * The audit log's lines under the token that answers them: its key id, the signing key in full (the crew copies it into
 * the show's paperwork and compares it at each start), the key folder when AGM_KEY_DIR chose it, then what open() found.
 */
function auditBanner(said) {
  const lines = ['  Audit log:   ' + (audit.keyless ? 'not keyed this run (' + audit.keyless.code + ')' : 'keyed (key ' + audit.kid + ')') + ' · Admin → Health'];
  lines.push('  Signing key: ' + (AUDIT_SIGN_KEY ? AUDIT_SIGN_KEY.match(/.{4}/g).join(' ') : 'none this run (no machine key): an export cannot be signed'));
  if (process.env.AGM_KEY_DIR) lines.push('  Key folder:  ' + secretbox.keyDir() + ' (set by AGM_KEY_DIR, not the default)');
  return [...lines, ...auditAttentionLines(said)];
}
/**
 * The banner's URL line and its Token line. A server run alone prints both. A server its watchdog runs never says the
 * token: it writes the URL line, and the place the Token line goes (lib/startup.js TOKEN_HERE) for a watchdog that reads
 * this output line by line (AGM_TEED), then asks the watchdog over IPC, which says the Token line where a person sits
 * (tokenLine) once it has both, and answers once it is written, so the line keeps its place in the banner. With no answer
 * within TOKEN_SAY_MS (no watchdog on the channel, or one that does not answer) the banner says so and goes on. The wait
 * keeps no process alive: a server that is stopping goes without it.
 */
const TOKEN_SAY_MS = 2000;
function sayToken(urlLine) {
  if (!SUPERVISED) {
    console.log(urlLine);
    console.log('    Token: ' + ADMIN_TOKEN);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer = null;
    const finish = (words) => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      process.removeListener('message', heard);
      if (words) console.log(words);
      resolve();
    };
    const unsaid = '    Token: not shown here: the watchdog that keeps it did not answer.';
    const heard = (m) => { if (m && m.t === 'token-said') finish(''); };
    timer = setTimeout(() => finish(unsaid), TOKEN_SAY_MS);
    timer.unref();
    // With no channel to a watchdog nothing would read the place the line goes: the URL line alone, and the words.
    const watched = typeof process.send === 'function' && process.connected;
    if (watched) process.on('message', heard);
    process.stdout.write(urlLine + '\n' + (watched && TEED ? startup.TOKEN_HERE + '\n' : ''), () => {
      if (!watched || !process.connected) { finish(unsaid); return; }
      process.send({ t: 'token' }, (e) => { if (e) finish(unsaid); });
    });
  });
}
/** Let go of the data folder (a clean stop): the next start finds it free at once. */
function releaseDataFolder() { for (const hold of folderHolds.splice(0)) { try { hold.close(); } catch { /* the process is ending: the OS frees it */ } } }

/**
 * Every sealed value this copy keeps in its data folder, as [what it is, the sealed value]: the words name the kind, never
 * the value or whose it is.
 */
function sealedValues() {
  const out = [];
  const add = (what, v) => { if (typeof v === 'string' && v) out.push([what, v]); };
  const each = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
  add('the AI key', settings.aiKeySealed);
  add('the Stagewatch key', settings.stagewatchKeySealed);
  add('the context token', settings.contextTokenSealed);
  for (const sw of each(settings.hallStagewatch)) add('a hall\'s Stagewatch key', sw && sw.keySealed);
  for (const link of each(settings.peerLinks)) add('a Patterns or PlayMap link\'s token', link && link.tokenSealed);
  for (const d of displays.list.values()) add('a screen\'s link', d.tokenSealed);
  return out;
}
/**
 * Why the installed node may not start with the keys it reads, in words, or '': a machine key, server secret or
 * certificate that cannot be read, a machine key missing while values sealed with one are here (or while a file that may
 * hold them could not be read, so none can be ruled out), or a sealed value that does not open. Read before it holds its
 * folder, so nothing is made over them. A portable copy goes on without what it cannot read (its keyless run, its own
 * secret, HTTPS off, context reads refused), and says so.
 */
function taskKeysProblem() {
  const key = secretbox.keyState();
  if (key.state === 'unusable') return key.words;
  if (secretFound.state === 'unusable') return secretFound.words;
  if (tlsFound && tlsFound.state === 'unusable') return tlsFound.words;
  const sealed = sealedValues();
  const kinds = (list) => [...new Set(list.map(([what]) => what))].join(', ');
  if (key.state === 'absent' && sealed.length) {
    return 'the machine key is not in ' + secretbox.keyDir() + ', and ' + plural(sealed.length, 'value') + ' in ' + DATA_DIR + (sealed.length === 1 ? ' was' : ' were') + ' sealed with one (' + kinds(sealed) + ')';
  }
  // A new machine key is made only where nothing sealed with the old one can be: a file that holds sealed values and
  // could not be read leaves that unknown.
  const unread = [[SETTINGS_PATH, settingsRead.unread], [path.join(DATA_DIR, 'displays.json'), displays.unread]].filter(([, code]) => code);
  if (key.state === 'absent' && unread.length) {
    return 'the machine key is not in ' + secretbox.keyDir() + ', and ' + unread.map(([file, code]) => file + ' (' + code + ')').join(' and ') + ' could not be read, so whether values were sealed with one cannot be told. Start it again once ' + (unread.length === 1 ? 'that file' : 'those files') + ' can be read';
  }
  const shut = key.state === 'key' ? sealed.filter(([, v]) => !secretbox.open(v)) : [];
  if (shut.length) return plural(shut.length, 'sealed value') + ' in ' + DATA_DIR + (shut.length === 1 ? ' does' : ' do') + ' not open with the machine key in ' + secretbox.keyDir() + ' (' + kinds(shut) + ')';
  return '';
}

/**
 * What a start writes, only once this copy holds its data folder and its port: its folders; the machine key, the
 * certificate and the server secret where there are none (never over one that is there, or that could not be read); the
 * saves asked meanwhile (the settings', and people's pages', whose store writes from then on); the watchdog's give-up
 * marked as seen. A data or uploads folder that cannot be made stops the start (code 3), in either channel; for the
 * installed node, so does a machine key, certificate or server secret that cannot be made, since it never runs without
 * them.
 */
function firstWrites() {
  for (const [dir, what, name] of [[ROOMS_DIR, 'data', 'AGM_DATA_DIR'], [UPLOAD_DIR, 'uploads', 'AGM_UPLOAD_DIR']]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      cannotStart('the ' + what + ' folder ' + dir + ' cannot be made (' + (e.code || e.message) + '). Choose a folder this Windows account can write to (' + name + '), or fix that one\'s permissions.');
    }
  }
  // The folder's format before anything else is written in it, its marker read again now that this copy holds it: a lower
  // one copied whole into backups/ first (the watchdog's beat sent while it runs, the disk's reserve kept), then moved and
  // marked; a marker refused, or a copy, step or marker that cannot be done, stops the start with the folder as it was.
  try { formatNow = dataformat.settle(DATA_DIR, { build: BUILD.full, reserve: UPLOAD_MIN_FREE, beat }); } catch (e) { cannotStart(e.words || String(e && e.message)); }
  secretbox.allowMaking();
  if (!secretbox.hasKey() && RUNS === 'task') cannotStart(secretbox.keyProblem().words + '. The installed node does not run without its machine key.');
  AUDIT_SIGN_KEY = (() => { try { return secretbox.signingKey().fingerprint; } catch { return ''; } })();
  // Keys kept in clear by 0.2, sealed now that a key missing at the read has been made: the link takes its key again.
  if (migrateClearKeys()) stageLink.configure(settings.stagewatchUrl || '', stagewatchKey(), settings.stagewatchFingerprint || '');
  // A certificate due for renewal is renewed only at a start where this laptop has a network address: one made before the
  // network gives one would name none of the addresses devices reach it by. The one it has serves on until a person asks
  // for a new one (New certificate), or a start that has an address renews it; never renewed behind a person's back, since
  // every device that trusted the old one would be asked again at its next connection.
  if (tlsmod.renewalWaits(tlsFound, tlsmod.lanAddresses())) {
    tlsRenewWaited = true;
    console.warn('  [tls] the certificate, which ends ' + cert.validTo + ', is due for renewal and not renewed at this start, which has no network address: it serves on; New certificate on the admin page renews it once this laptop has one, as does a start that has one');
  } else if (tlsFound && (tlsFound.state === 'absent' || tlsFound.state === 'renew')) {
    try {
      cert = tlsmod.loadOrCreate({ dir: secretbox.keyDir(), name: 'AGMessage ' + os.hostname(), seal: secretbox.seal, open: secretbox.open });
      front.setCert({ certPem: cert.certPem, keyPem: cert.keyPem });
      if (discovery) discovery.tls = cert.fp;
    } catch (e) {
      // None at all: the installed node does not run without one. One whose renewal failed still serves, its key having
      // opened, until a later start renews it.
      if (tlsFound.state === 'absent' && RUNS === 'task') cannotStart('no certificate can be made in ' + secretbox.keyDir() + ' (' + (e.code || e.message) + '). The installed node does not run without it.');
      if (tlsFound.state === 'absent') tlsOff = 'no certificate can be made (' + e.message + ')';
      else console.warn('  [tls] the certificate, which ends ' + cert.validTo + ', could not be renewed (' + (e.code || e.message) + '): it serves on, and the next start tries again');
    }
  }
  if (secretFound.state === 'absent') {
    let why = '';
    try { if (!guard.makeSecret(secretFound)) why = 'one appeared there while this copy started, and it is left as it is'; } catch (e) { why = 'it could not be written (' + (e.code || e.message) + ')'; }
    if (why && RUNS === 'task') cannotStart('the server secret ' + secretFound.file + ' was not made: ' + why + '. The installed node does not run without it.');
    if (why) secretFound.words = secretFound.file + ' was not made: ' + why;
  }
  if (settingsDue) saveSettings();
  pages.hold();
  if (watchdogBefore) { try { fs.renameSync(path.join(DATA_DIR, 'watchdog.json'), path.join(DATA_DIR, 'watchdog.seen.json')); } catch { /* shown once anyway */ } }
  // How the copy before this one stopped, its record moved aside now, so a crash or a kill of this one is never read as
  // a stop that saved; and the temporary files a stop cut short left (a process no longer running), removed.
  stopBefore = laststop.judge(laststop.take(DATA_DIR), store.found);
  if (stopBefore.state === 'stale') console.error('  [save] ' + laststop.FILE + ' says the stop before saved, but ' + stopBefore.code + ': each hall says AGMessage restarted');
  if (stopBefore.left) console.error('  [save] ' + laststop.FILE + ' could not be moved aside or removed (' + stopBefore.left + '): the next start reads it as taken by this one' + (stopBefore.left.includes(laststop.SEEN) ? ' only once a hall has changed' : ''));
  const swept = laststop.sweep([DATA_DIR, ROOMS_DIR]);
  if (swept.removed.length) console.log('  Removed ' + plural(swept.removed.length, 'temporary file') + ' a stop cut short left in ' + DATA_DIR);
  for (const [name, why] of swept.failed) console.error('  [save] ' + name + ', left by a stop cut short, could not be removed (' + why + ')');
}

// The server's contexts for the handler modules (lib/gate.js `contexts`), built once, last, after every part they name
// exists, and before this copy holds its port, so the first connection reads them whole: the stores and their named
// effects, `settings` to read (a handler module never writes it: test/modules.test.js (j)), a message made from what a page
// sent (`readSend`, `messageOf`, its file on disk `uploadOnDisk`, a new id `makeMessageId`), the rooms that may send into
// a room (`sendersOf`, read, and `sendsInto`, the rooms a room may send into; `setRoomSends`, its one writer, the rooms
// module's alone), the Stagewatch a hall follows
// and its frame, and `io` for the rooms module. The takes module's holds no io, apply or systemMessage: it reaches a page
// by its socket's id alone (`sendTo`, over io's open sockets, read by the gate's module and never handed in), never a
// room's op or a room's broadcast.
const { ctx, takesCtx } = contexts({
  store, apply, systemMessage, readSend, messageOf, uploadOnDisk, makeMessageId, removeUnused, fileNamesOf, audit, accounts, boardDirty, newSideRoom, renameRoom, roomNameRefused, newGuestCode, guestPagesOf, sendGuestsOut, codeChanged, settings, sendersOf, sendsInto, setRoomSends, linkFor, stagePayload, io,
});

// The installed node reads its keys before it holds its folder, and stops with their words when it may not run on them.
if (RUNS === 'task') {
  const why = taskKeysProblem();
  if (why) cannotStart(why + '. Nothing was changed: the installed node does not run without its keys, and never makes new ones over them.');
}

holdDataFolder(() => front.listen(PORT, HOST, () => {
  // This copy holds the folder and the port: now it writes. Its folders, keys and secret are made where there are none,
  // each dirty room's snapshot is written (a replayed log folded in, a torn last line cut before anything is appended
  // after it), and no other; after a stop that did not save (a crash, a kill, Windows ending it, a power cut, or no record
  // of one) every room of each hall says AGMessage restarted; the audit log is opened (and given what waited for it), and
  // the show desk's loop may run (and save what it reports), as may the peaks' saves (from the next 5 s window).
  listening = true;
  serving = true;
  firstWrites();
  bootSnapshots = store.compactDirty();
  if (!stopBefore.saved) {
    for (const room of store.allRooms()) {
      store.commit(room, { o: 'add', m: { id: makeMessageId(), type: 'system', text: '— AGMessage restarted · ' + plural(room.messages.length, 'message') + ' kept —', at: Date.now() } });
      if (store.isMain(room)) restartSaid++;   // every room says it; health counts the halls
    }
  }
  audit.open();
  const upgraded = dataformat.rowWords(formatNow, BUILD.full);
  if (upgraded) audit.write(SYSTEM_ACTOR, 'server.upgraded', BUILD.full, upgraded);
  for (const fn of untilServing.splice(0)) fn();
  readLaptop();
  // The whole log is checked once, beside the show, so health, the rows' marks and the black window read what the log
  // holds from the start: findings an earlier start left open, and a chain broken at a line, included. Then a split a stop
  // left part way is finished (or its leftovers, which no split pins, removed), which checks the log again. What it says
  // waits for the banner to be whole, so no line of it falls inside the banner's Admin login block.
  const checkedAtStart = audit.verify()
    .then(() => auditArchiver.finish({ t: 'system', id: '', name: '' }, '', { atStart: true }))
    .then((r) => () => { if (r && r.ok && r.words && !/^No split/.test(r.words)) console.log('  Audit log:   ' + r.words); },
      (e) => () => { console.error('  [audit] the check at start did not finish: ' + (e && e.message ? e.message : e)); });
  const addresses = tlsmod.lanAddresses();
  console.log('\n  AGMessage ' + BUILD.full + ' is running');
  console.log('  ---------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const a of addresses) console.log(`  LAN:     http://${a}:${PORT}` + (cert ? `   (or https://${a}:${PORT})` : ''));
  if (cert) console.log('  HTTPS:   on, same port — certificate ' + cert.fp.slice(0, 23) + '…  (trust it once per device: /tls)' + (settings.requireHttps ? ' · required from other devices' : ''));
  if (tlsOff) console.log('  HTTPS:   off — ' + tlsOff);
  // What this run goes without, kept as it is and never made again over it: each said once, here.
  if (secretFound.words) console.log('  Secret:  ' + secretFound.words + '. This run signs guests and invite links with a secret of its own, so those made before do not hold until it is read again.');
  if (settingsRead.unread) console.log('  Settings: ' + settingsRead.words + '. Nothing is saved over it this run, which goes without its links and keys, and refuses a setting changed. ' + settingsRead.fix);
  else if (contextTokenProblem()) console.log('  Context: ' + contextTokenProblem());
  // The data folder's line, when there is something to say: a move from a lower format, or a newer build before this one.
  if (formatNow.backup || formatNow.newer === true) console.log('  Data folder: ' + formatWords().words);
  console.log('');
  console.log('  ============================================');
  console.log('  Admin login (only from this host laptop):');
  const said = new Set();
  const bannerSaid = sayToken('    URL:   http://localhost:' + PORT + '/admin').then(() => {
    console.log('  ============================================');
    for (const line of auditBanner(said)) console.log(line);
    console.log('  AI drafts:   ' + (aiKey() ? 'on (' + ai.MODEL + ')' : 'off — add a key in Admin → AI (messaging and the show network work without it)'));
    if (RESTARTS) console.log('  Restarted by the watchdog (' + RESTARTS + 'x)' + (lastCrash ? ' — last crash: ' + String(lastCrash.message || '').slice(0, 120) : ''));
    console.log('  Stagewatch:  ' + (settings.stagewatchUrl || 'not linked (Admin → Show network)'));
    console.log('  Saved rooms: ' + ROOMS_DIR);
    console.log('  Uploads:     ' + UPLOAD_DIR + '\n');
  });
  // The tunnel's kept end, read once the banner is whole, so no line of it falls inside the banner.
  bannerSaid.then(() => tunnelAtStart(Date.now()));
  // What the check at start found that the banner has not said is said once it answers and the banner is whole. Only
  // then, with this copy serving, may the browser open: the page it opens is this copy's (lib/startup.js), and a log that
  // needs the person at this laptop opens it on the admin page, where Health asks it.
  Promise.all([checkedAtStart, bannerSaid]).then(([sayChecked]) => {
    sayChecked();
    // After a split the check begins at its archive point and names each archive (H.11's banner line, said once known).
    if (audit.from > 1) console.log('  Audit log:   keyed (key ' + audit.kid + ') · from entry ' + audit.from + ', ' + audit.archives.length + ' archive' + (audit.archives.length === 1 ? '' : 's') + ' · Admin → Health');
    const more = auditAttentionLines(said);
    if (more.length) console.log(more.join('\n') + '\n');
    startup.openBrowser(startup.openerPlan(process.env, { restarts: RESTARTS, port: PORT, platform: process.platform, path: audit.attention().length ? '/admin' : '' }), spawn, (line) => console.log(line));
  });
}));

module.exports = { app, server, io, store, buildMessage };
