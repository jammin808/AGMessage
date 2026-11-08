'use strict';
/**
 * What an import compares (the 0.6.0 plan's Part 6, unit U14): the facts of one data folder and its key folder, read with
 * the server's own readers and never written. launch.js export reads the portable folder's (as the Windows account that
 * runs it, whose profile holds its keys), and machine.js import the installed node's once its copy is laid; each runs this
 * as a process of its own, since those two require Node's built-ins only:
 *
 *   node lib/importfacts.js --data <folder> --keys <folder>
 *       one line of JSON on its output, {v: 1, facts} (or {v: 1, error}); exit 0 once answered, 2 when the folder could
 *       not be read, 64 for an argument it does not know
 *
 * The facts: `build`, the build this code is; `format`, the data folder's marker ({state, format, build, at, current}:
 * `current` the format this build writes); `moved`, an import's mark on it ('none', 'moved' or 'unread': lib/dataformat.js
 * movedOf); `held`, whether a copy runs on it (one of its folder pipes answers), and `busy`, what that copy's busy line says
 * in words (lib/busy.js: counts only; '' when it said none); `halls`, `rooms` (side rooms), `messages`, `accounts`,
 * `screens`; `secret`, the server secret's state as a start reads it ('read', 'absent' or 'unusable'); `key` ({state, kid,
 * code?}), the key folder's machine key and the audit log's key id under it; `sealed` ({total, open, shut}), every value the
 * stores keep sealed and the certificate's private key, opened with that key, those that do not named by their store and
 * field; `cert` ({state, fp, code?}: its state as a start reads it, 'ok', 'renew', 'absent' or 'unusable'); `chain`, the audit log
 * as it lies ({done, mark, words, entries, from, archives, kid, newestKid}); `stores`, each keyed store's state as the
 * folder's first start would find it ({accounts, sessions, adminSessions}: lib/keyedstore.js judgeFolder).
 *
 * Invariants:
 *   - Nothing is written, held or made: the rooms load with no compaction, each store is read through its own reader, the
 *     audit chain is walked as it lies (AuditLog.checkAsItLies), the certificate is read (tls.readCertificate), and the
 *     machine key is read from the folder named, never made; a sealed value is opened with that key alone.
 *   - A sealed value is a store's field named for one (`…Sealed`), never a value read for its shape, so words a person
 *     typed are never taken for one.
 *   - No secret is in an answer: counts, states, the certificate's fingerprint (public: every hello carries it) and a key
 *     id (never a prefix of the key). Its own reads go through fs.promises.
 */
const fsp = require('fs/promises');
const path = require('path');
const { RoomStore } = require('./store');
const { validAccount } = require('./accounts');
const keyedstore = require('./keyedstore');
const { Displays } = require('./displays');
const { AuditLog, LABELS, kidOf } = require('./audit');
const secretbox = require('./secretbox');
const tlsmod = require('./tls');
const guard = require('./guard');
const dataformat = require('./dataformat');
const resilience = require('./resilience');
const machinewire = require('./machinewire');
const busy = require('./busy');
const { BUILD } = require('./version');

/** The stores that keep sealed values, each read through the reader every store has (a torn file's .bak). */
const SEALING = Object.freeze(['settings.json', 'displays.json', 'pages.json']);
/** A field a store keeps sealed: its name says so (aiKeySealed, keySealed, tokenSealed, urlSealed). */
const SEALED_FIELD = /Sealed$/;

/** The machine key of `keyDir`, read and never made: {state: 'key', key}, {state: 'absent'} or {state: 'unusable', code}. */
async function keyIn(keyDir) {
  let buf;
  try { buf = await fsp.readFile(path.join(keyDir, 'machine.key')); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'absent' } : { state: 'unusable', code: e.code || 'EIO' };
  }
  const key = secretbox.keyFrom(buf);
  return key ? { state: 'key', key } : { state: 'unusable', code: 'EBADKEY' };
}

/** Every value the data folder's stores keep sealed, as [where: its store and field, the sealed value]. */
function sealedIn(dataDir) {
  const out = [];
  const walk = (v, store) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, store); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (SEALED_FIELD.test(k) && typeof x === 'string') { if (x) out.push([store + ' ' + k, x]); } else walk(x, store);
    }
  };
  for (const store of SEALING) {
    const { data } = resilience.readJsonWhole(path.join(dataDir, store));
    if (data) walk(data, store);
  }
  return out;
}

/** The certificate of `keyDir` (tls.json): its state as a start reads it, its fingerprint, and its sealed private key. */
async function certIn(keyDir, open) {
  let text;
  try { text = await fsp.readFile(path.join(keyDir, 'tls.json'), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'absent', fp: '', sealed: '' } : { state: 'unusable', fp: '', sealed: '', code: e.code || 'EIO' };
  }
  let fp;
  let sealed;
  try {
    const j = JSON.parse(text);
    fp = tlsmod.fingerprint(Buffer.from(String(j.certDer), 'base64'));
    sealed = typeof j.keySealed === 'string' ? j.keySealed : '';
  } catch { return { state: 'unusable', fp: '', sealed: '', code: 'EBADCERT' }; }
  const found = tlsmod.readCertificate({ dir: keyDir, open });
  return { state: found.state, fp, sealed, ...(found.code ? { code: found.code } : {}) };
}

/** The halls, side rooms and their messages, the accounts and the screens, each read through its own store, nothing written. */
function countsOf(dataDir) {
  const store = new RoomStore(path.join(dataDir, 'rooms'), { make: false });
  store.loadAll(null, { compact: false });
  // Every room, Main or side, and the messages each holds: what an import must carry alike.
  const all = store.allRooms();
  let messages = 0;
  for (const room of all) messages += room.messages.length;
  // The accounts counted as their store takes them, read and never opened: whether they would open is `stores`'s.
  const { data } = resilience.readJsonWhole(path.join(dataDir, 'accounts.json'));
  const accounts = new Set((data && Array.isArray(data.users) ? data.users : []).filter(validAccount).map((u) => u.id)).size;
  const screens = new Displays(path.join(dataDir, 'displays.json'), { seal: () => '', open: () => '' });
  // The store's lane is closed unused: this reader writes nothing.
  screens.lane.close();
  return { halls: store.rooms.size, rooms: all.length - store.rooms.size, messages, accounts, screens: screens.list.size };
}

/** The audit log as it lies, under the key read (none: every keyed entry reads as another key's). */
async function chainOf(dataDir, keyDir, k) {
  const log = new AuditLog(path.join(dataDir, 'audit.jsonl'), {
    keys: () => {
      if (k.state !== 'key') throw Object.assign(new Error('no machine key in ' + keyDir), { code: k.code || 'ENOENT' });
      return { entry: secretbox.deriveFrom(k.key, LABELS.entry), head: secretbox.deriveFrom(k.key, LABELS.head) };
    },
    records: path.join(keyDir, 'audit'),
    version: BUILD.version,
  });
  try {
    const r = await log.checkAsItLies();
    return { done: r.done, mark: r.mark, words: r.words, entries: r.entries, from: r.from, archives: (r.archives || []).length, kid: r.kid, newestKid: r.newestKid };
  } finally { log.headLane.close(); }
}

/**
 * Whether a copy runs on the data folder: any of the places it would hold it by answers (lib/resilience.js folderPipes),
 * and what its busy line says there, in words. The line chooses words and nothing else: anyone who took a pipe's name
 * first could answer it.
 */
async function heldOf(dataDir) {
  for (const where of resilience.folderPipes(dataDir)) {
    const r = await machinewire.askPipe(where);
    if (!r.connected) continue;
    const l = busy.read(r.text);
    return { held: true, busy: l ? (busy.isBusy(l) ? 'busy: ' : 'idle: ') + busy.words(l) : '' };
  }
  return { held: false, busy: '' };
}

/**
 * What the installed node's first start would decide of its stores (lib/keyedstore.js), read with the key folder's keys and
 * its records, nothing written: each store's state, `keyless` without a machine key.
 */
function storesOf(dataDir, keyDir, k) {
  if (k.state !== 'key') return { accounts: 'keyless', sessions: 'keyless', adminSessions: 'keyless' };
  const K = keyedstore.keysFrom((label) => secretbox.deriveFrom(k.key, label))();
  return keyedstore.judgeFolder({ dataDir, records: path.join(keyDir, 'stores'), K, kid: kidOf(secretbox.deriveFrom(k.key, LABELS.entry)) });
}

/** The facts of one data folder and its key folder, as the head of this file names them. */
async function factsOf({ dataDir, keyDir }) {
  const k = await keyIn(keyDir);
  const open = (s) => (k.state === 'key' ? secretbox.openWith(k.key, s) : '');
  const sealed = sealedIn(dataDir);
  const cert = await certIn(keyDir, open);
  if (cert.sealed) sealed.push(['tls.json keySealed', cert.sealed]);
  const shut = sealed.filter(([, v]) => !open(v)).map(([where]) => where);
  const format = dataformat.read(dataDir);
  const runs = await heldOf(dataDir);
  return {
    build: BUILD.full,
    format: { state: format.state, format: format.format || 0, build: format.build || '', at: format.at || null, current: dataformat.FORMAT },
    moved: dataformat.movedOf(dataDir).state,
    held: runs.held,
    busy: runs.busy,
    ...countsOf(dataDir),
    secret: guard.readSecret(dataDir).state,
    key: { state: k.state, kid: k.state === 'key' ? kidOf(secretbox.deriveFrom(k.key, LABELS.entry)) : '', ...(k.code ? { code: k.code } : {}) },
    sealed: { total: sealed.length, open: sealed.length - shut.length, shut: [...new Set(shut)] },
    cert: { state: cert.state, fp: cert.fp, ...(cert.code ? { code: cert.code } : {}) },
    chain: await chainOf(dataDir, keyDir, k),
    stores: storesOf(dataDir, keyDir, k),
  };
}

/** The command line: --data and --keys, each once, each a full path; {dataDir, keyDir} or {problem}. */
function argsOf(argv) {
  const got = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (name !== '--data' && name !== '--keys') return { problem: '"' + String(name).slice(0, 40) + '" is not an argument lib/importfacts.js knows.' };
    if (name in got) return { problem: name + ' is given twice.' };
    if (i + 1 >= argv.length || !path.isAbsolute(argv[i + 1])) return { problem: name + ' needs its folder, as a full path.' };
    got[name] = argv[i + 1];
  }
  if (!got['--data'] || !got['--keys']) return { problem: 'lib/importfacts.js needs --data <folder> and --keys <folder>.' };
  return { dataDir: got['--data'], keyDir: got['--keys'] };
}

/** Answers one line of JSON through `out`: the exit code (0 answered, 2 the folder could not be read, 64 usage). */
async function main(argv, out = (line) => process.stdout.write(line + '\n')) {
  const a = argsOf(argv);
  if (a.problem) { out(JSON.stringify({ v: 1, error: a.problem })); return 64; }
  try {
    out(JSON.stringify({ v: 1, facts: await factsOf(a) }));
    return 0;
  } catch (e) {
    out(JSON.stringify({ v: 1, error: 'the folder could not be read (' + String((e && (e.code || e.message)) || e).slice(0, 200) + ')' }));
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { factsOf, sealedIn, keyIn, countsOf, argsOf, main, SEALING };
