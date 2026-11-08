'use strict';
/**
 * The keyed stores (the 0.6.0 plan's 3-K, unit K; tested in test/keyedstore.test.js and test/keyedsignins.test.js): the
 * accounts (accounts.json), their sign-ins (sessions.json) and the laptop's token sign-ins (admin-sessions.json), each
 * kept in the data folder in a file keyed whole with a key derived from the machine key, which lives outside it, and a
 * record of every save beside that key that tells the newest save from an older one, another folder's or a planted one.
 *
 *   a file          its JSON as the store saves it, the save's fields first ({v: 2, store, set, gen, kid, at, …}) and
 *                   its MAC last: the file ends with exactly ,"m":"<64 hex>"} in place of the body's last }, the MAC an
 *                   HMAC-SHA256 under the store's own key of its label, a line break and every byte before ,"m". One MAC
 *                   for the whole file, never one per record: only the file as one save pins its records to each other
 *   a sign-in       kept by its keyed hash, HMAC-SHA256(Kn, kind + '\n' + its secret), `kind` 'session' or 'token sign-in'
 *   the records     <keyDir>/stores/: set-<set>.json (each store's newest save, the one before it and the floor below
 *                   which a save that took a right away makes an older one; each account's keyed digest; the archive
 *                   pins and the archive under way; the copy of the accounts held aside), latest.json (the set this
 *                   machine saved last, and where), folder-<id>.json (the set this data folder holds) and keyed.json
 *                   (this machine has keyed a folder), each with an HMAC under Kr
 *   open()          the decision, store by store, from what the files and the records say (3-K.5's table, its first row
 *                   that matches), then the stores filled, the accounts held aside where they must be, and the writes:
 *                   the stores first (the accounts before the sign-in files), the records only once every one landed
 *   the hold        a copy of the accounts that are not opened (accounts.held-<time>.json, byte for byte what was read),
 *                   kept until the token at the laptop adopts them or leaves them out
 *   the claim       an event archive under way (`archiving`) and the accounts file each archive took (`archived`), by
 *                   the save it held and the set that save was made in, so a folder that moved still opens its archives
 *
 * Invariants:
 *   - Only ENOENT means a file or a record is absent. A store that cannot be read is `unread`: nothing of it loads and its
 *     lane writes nothing this run; a record that cannot be read makes every store `unread` and is never written over.
 *   - Nothing is written before open(), nor in a run without the machine key (`keyless`): each file is left byte for byte.
 *   - A sign-in or an account read from a file that fails its check is never trusted on its own: a sign-in file that fails
 *     ends its sign-ins, an accounts file that fails is held aside whole.
 *   - The `.bak` of a keyed store is only a file that checks (its MAC, its store and this folder's set): one that fails is
 *     kept aside as <name>.changed-<time>.json and said, and AGMessage's own save is written over it.
 *   - A save that takes a right away or ends a sign-in is written twice, and its record at once, so the save before it put
 *     back reads `older`, never one save behind.
 *   - No key, password, token, sign-in id or hash reaches a word, a row or a record: only a file's digest and key ids.
 *
 * What it cannot defend (docs/ACCOUNTS.md, SECURITY.md): whoever holds the machine key (this Windows account; installed,
 * the server task's account, SYSTEM and Administrators) derives every key here and writes files and records that check;
 * in the portable layout whoever can write the AGMessage folder can change the code; a whole machine put back is its own
 * newest save; one save put back undoes a sign-in's stamp, a rehash, a touch or a new sign-in, and is said. It keys
 * integrity, never secrecy: the stores still hold names, usernames, scrypt hashes, addresses and browsers.
 *
 * It requires Node's crypto and lib/resilience.js alone, never lib/secretbox.js: its keys are given. Every read is
 * resilience.readText and every write a WriteLane or writeFileAtomic, so it makes no synchronous call of its own.
 */
const crypto = require('crypto');
const path = require('path');
const { readText, writeFileAtomic, WriteLane, placeId } = require('./resilience');

/** The five keys' labels (lib/secretbox.js derive's allow-list), by the use each keys. */
const LABELS = Object.freeze({
  id: 'agmessage sign-in id v1',
  accounts: 'agmessage accounts file v1',
  sessions: 'agmessage sessions file v1',
  adminSessions: 'agmessage token sign-ins file v1',
  record: 'agmessage stores record v1',
});
const STORES = Object.freeze(['accounts', 'sessions', 'adminSessions']);
const FILES = Object.freeze({ accounts: 'accounts.json', sessions: 'sessions.json', adminSessions: 'admin-sessions.json' });
/** A sign-in stamped more than this far past now is dropped at load: a clock stepped back never keeps one alive. */
const AHEAD_MS = 5 * 60_000;
/** How long a store's record may lag its save: latest wins, then written. */
const RECORD_MS = 200;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TAIL = /,"m":"[0-9a-f]{64}"\}$/;
const TAIL_LEN = 72;
const HELD_FILE = /^accounts\.held-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;
/** The states an accounts file is held aside in, until the token at the laptop adopts them or leaves them out. */
const ASIDE = Object.freeze(['changed', 'older', 'other', 'elsewhere', 'plain']);
/** The states in which a store's file is loaded as it was found. */
const LOADED = Object.freeze(['ok', 'behind', 'unrecorded', 'move']);
/** Each state's mark: △ a store that loads or waits for a start, ✕ one held aside, ended or missing. */
const MARK = Object.freeze({ keyless: '△', unread: '△', behind: '△', unrecorded: '△', first: '△', changed: '✕', older: '✕', other: '✕', elsewhere: '✕', plain: '✕', missing: '✕', ended: '✕' });
/** The fields of each record, in the order their MAC covers them. */
const RECORD_FIELDS = Object.freeze({
  set: ['v', 'set', 'path', 'kid', 'accounts', 'sessions', 'adminSessions', 'archived', 'archiving', 'held', 'at'],
  latest: ['v', 'set', 'path', 'at'],
  folder: ['v', 'folder', 'path', 'set', 'at'],
  keyed: ['v', 'since'],
});

const hmacHex = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** Two lower-case hex strings of one length compared in constant time. */
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length > 0 && /^[0-9a-f]+$/.test(a) && /^[0-9a-f]+$/.test(b) && a.length % 2 === 0 && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const short = (hex) => String(hex).slice(0, 4) + '…';
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
function parseJson(text) { try { return JSON.parse(text); } catch { return undefined; /* not JSON: its caller says so */ } }

// ---------------------------------------------------------------- the file's seal

/**
 * A store's file: `head` (the save's fields) then `fields` (the store's own), as one JSON.stringify, `indent` its own
 * (accounts.json keeps one space), the MAC put in place of its last }. {text, m}.
 */
function sealText(key, label, head, fields, indent) {
  const body = JSON.stringify({ ...head, ...fields }, null, indent);
  const prefix = body.slice(0, -1);
  const m = hmacHex(key, label + '\n' + prefix);
  return { text: prefix + ',"m":"' + m + '"}', m };
}
/** The MAC a file's text ends with, when it is the one `key` makes of every byte before it; else ''. */
function checkText(key, label, text) {
  if (typeof text !== 'string' || text.length <= TAIL_LEN || !TAIL.test(text)) return '';
  const m = text.slice(-TAIL_LEN + 6, -2);
  return sameHex(m, hmacHex(key, label + '\n' + text.slice(0, -TAIL_LEN))) ? m : '';
}
/** A record's MAC: under Kr, of its label, its kind and its fields in their order. */
const recordMac = (Kr, kind, rec) => hmacHex(Kr, LABELS.record + '\n' + kind + '\n' + JSON.stringify(Object.fromEntries(RECORD_FIELDS[kind].map((f) => [f, rec[f] === undefined ? null : rec[f]]))));
/** A record's text: its fields in order, then its MAC. */
const recordText = (Kr, kind, rec) => JSON.stringify({ ...Object.fromEntries(RECORD_FIELDS[kind].map((f) => [f, rec[f] === undefined ? null : rec[f]])), mac: recordMac(Kr, kind, rec) });

/** The fields of an account its keyed digest covers: what it is, what it may do, and how it signs in. */
const DIGESTED = Object.freeze(['id', 'username', 'role', 'grant', 'revoke', 'halls', 'allHalls', 'disabled', 'mustChange', 'pw', 'epoch']);
/** An account's security digest as the set record keeps it: 32 hex characters of an HMAC under Kr. */
const digestOf = (Kr, a) => hmacHex(Kr, 'agmessage account v1\n' + JSON.stringify(DIGESTED.map((f) => (a[f] === undefined ? null : a[f])))).slice(0, 32);

/** An entry of the set record read by type. */
function cleanEntry(e, accounts) {
  const o = isRecord(e) ? e : {};
  const out = { gen: whole(o.gen), d: HEX32.test(o.d || '') ? o.d : '', prev: HEX32.test(o.prev || '') ? o.prev : '', floor: whole(o.floor) };
  if (accounts) {
    out.n = whole(o.n);
    const who = {};
    if (isRecord(o.who)) for (const [id, dg] of Object.entries(o.who)) if (typeof id === 'string' && id.length <= 40 && HEX32.test(dg || '')) who[id] = dg;
    out.who = who;
  }
  return out;
}
/**
 * The pins of the event archives (`archived`), read by type: {<time>: {set, gen, d, n}}, the accounts file each archive
 * took by the set it was saved in (a pin made before the folder moved names the set it moved from), its save and how
 * many accounts it held.
 */
function cleanPins(p) {
  const out = {};
  if (isRecord(p)) for (const [t, v] of Object.entries(p)) if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(t) && isRecord(v)) out[t] = { set: HEX32.test(v.set || '') ? v.set : '', gen: whole(v.gen), d: HEX32.test(v.d || '') ? v.d : '', n: whole(v.n) };
  return out;
}
/** An archive under way, as the claim keeps it, or null. */
function cleanClaim(c) {
  if (!isRecord(c) || typeof c.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(c.time)) return null;
  return { time: c.time, kind: typeof c.kind === 'string' ? c.kind.slice(0, 20) : '', next: typeof c.next === 'string' ? c.next.slice(0, 40) : '', accounts: cleanPins({ [c.time]: c.accounts })[c.time] || { set: '', gen: 0, d: '', n: 0 } };
}
/** The copy held aside, as the set record keeps it, or null. */
function cleanHeld(h) {
  if (!isRecord(h) || typeof h.file !== 'string' || !HELD_FILE.test(h.file) || !HEX64.test(h.d || '')) return null;
  return { file: h.file, d: h.d, at: whole(h.at), why: [...ASIDE, 'first'].includes(h.why) ? h.why : 'changed', left: Number.isSafeInteger(h.left) && h.left >= 0 ? h.left : null };
}

// ---------------------------------------------------------------- reading a folder (nothing written)

/** A record outside the data folder: {state: 'absent' | 'unread' | 'changed' | 'ok', rec, name, code}. Only ENOENT is absent. */
function readRecord(records, name, kind, Kr) {
  const file = path.join(records, name);
  const r = readText(file);
  if (r.code === 'ENOENT') return { state: 'absent', name };
  if (r.code) return { state: 'unread', code: r.code, name };
  let rec = parseJson(r.text);
  let text = r.text;
  // A record torn by a cut write is read through its .bak, under the same check.
  if (rec === undefined) {
    const b = readText(file + '.bak');
    const rb = b.code ? undefined : parseJson(b.text);
    if (rb !== undefined) { rec = rb; text = b.text; }
  }
  if (isRecord(rec) && Kr && sameHex(rec.mac, recordMac(Kr, kind, rec))) return { state: 'ok', rec, name, text };
  return { state: 'changed', name, text };
}

/**
 * A store's file as a start reads it: the file, or its .bak when the file is absent or not JSON (the read rule), and
 * whether a keyed one (v 2) is in the folder as the file or its .bak (`keyedHere`).
 */
function readStore(dataDir, name) {
  const file = path.join(dataDir, FILES[name]);
  const r = readText(file);
  const b = readText(file + '.bak');
  const own = r.code ? undefined : parseJson(r.text);
  const bak = b.code ? undefined : parseJson(b.text);
  const keyedHere = (isRecord(own) && own.v === 2) || (isRecord(bak) && bak.v === 2);
  if (r.code && r.code !== 'ENOENT') return { state: 'unread', code: r.code, file: FILES[name], keyedHere };
  if (own !== undefined) return { state: 'read', text: r.text, own: r.text, data: own, from: 'file', keyedHere };
  if (b.code && b.code !== 'ENOENT') return { state: 'unread', code: b.code, file: FILES[name] + '.bak', keyedHere };
  if (bak !== undefined) return { state: 'read', text: b.text, own: r.code ? null : r.text, data: bak, from: 'bak', fileWas: r.code === 'ENOENT' ? 'missing' : 'torn', keyedHere };
  if (r.code === 'ENOENT') return { state: 'absent', keyedHere };
  return { state: 'read', text: r.text, own: r.text, data: undefined, from: 'file', torn: true, keyedHere };
}

/** What a store's text is: plain (0.5.1's v 1), torn, or keyed, and whether it checks under this machine's key. */
function classify(name, f, K, kid) {
  if (f.state !== 'read') return f;
  if (f.torn || !isRecord(f.data)) return { ...f, kind: 'torn' };
  const d = f.data;
  if (d.v === 1) return { ...f, kind: 'plain' };
  const fileKid = typeof d.kid === 'string' && HEX16.test(d.kid) ? d.kid : '';
  const set = typeof d.set === 'string' && HEX32.test(d.set) ? d.set : '';
  const gen = Number.isSafeInteger(d.gen) && d.gen > 0 ? d.gen : 0;
  const m = K ? checkText(K[name], LABELS[name], f.text) : '';
  const sealed = !!m && d.v === 2 && d.store === name && fileKid === kid && !!set && gen > 0;
  return { ...f, kind: 'keyed', fileKid, set, gen, d: m ? m.slice(0, 32) : '', sealed };
}

/** The account records of an accounts file's data that its store would take (`valid`), in the file's order. */
const usersIn = (data, valid) => (isRecord(data) && Array.isArray(data.users) ? data.users.filter((u) => valid(u)) : []);
/** The ids and usernames a list of accounts holds more than once. */
function repeatsIn(users) {
  const ids = new Map();
  const names = new Map();
  for (const u of users) { ids.set(u.id, (ids.get(u.id) || 0) + 1); names.set(u.username, (names.get(u.username) || 0) + 1); }
  return { ids: new Set([...ids].filter(([, n]) => n > 1).map(([k]) => k)), names: new Set([...names].filter(([, n]) => n > 1).map(([k]) => k)) };
}
const repeated = (u, r) => r.ids.has(u.id) || r.names.has(u.username);

/**
 * Everything a start reads to decide (nothing written): the folder's records, the set records its files and its folder
 * record name, and its three stores. `K` the five keys, `kid` this machine's key id.
 */
function readFolder({ dataDir, records, K, kid }) {
  const here = path.resolve(dataDir);
  const folderId = placeId(dataDir, undefined, { absentOk: true });
  const Kr = K ? K.record : null;
  const rec = {
    folder: readRecord(records, 'folder-' + folderId + '.json', 'folder', Kr),
    keyed: readRecord(records, 'keyed.json', 'keyed', Kr),
    latest: readRecord(records, 'latest.json', 'latest', Kr),
  };
  const files = {};
  for (const name of STORES) files[name] = classify(name, readStore(dataDir, name), K, kid);
  const named = new Set();
  if (rec.folder.state === 'ok' && HEX32.test(rec.folder.rec.set || '')) named.add(rec.folder.rec.set);
  if (rec.latest.state === 'ok' && HEX32.test(rec.latest.rec.set || '')) named.add(rec.latest.rec.set);
  for (const f of Object.values(files)) if (f.kind === 'keyed' && HEX32.test(f.set || '')) named.add(f.set);
  for (const name of STORES) { const s = files[name].data && files[name].data.set; if (typeof s === 'string' && HEX32.test(s)) named.add(s); }
  const sets = new Map();
  for (const s of named) sets.set(s, readRecord(records, 'set-' + s + '.json', 'set', Kr));
  return { here, folderId, records, kid, rec, sets, files, dataKeyed: Object.values(files).some((f) => f.keyedHere) };
}

// ---------------------------------------------------------------- the decision

/** The rule of saves: a file's save against its record's entry. */
function ruleOf(f, e) {
  if (f.gen > e.gen || (f.gen === e.gen && f.d === e.d)) return 'ok';
  if (f.gen === e.gen - 1 && f.d === e.prev && f.gen >= e.floor) return 'behind';
  return 'older';
}

/**
 * Each store's state, from what the folder holds and the records say (3-K.5's table, its first row that matches):
 * {state, set, gen, d, via, from, words} per store, and the record that made every store `unread` when one did.
 */
function decide(raw, { made = false } = {}) {
  const { rec, sets, files, here } = raw;
  const unreadRecord = [rec.folder, rec.keyed, rec.latest, ...sets.values()].find((r) => r.state === 'unread');
  const F = rec.folder;
  const L = rec.latest;
  const setOf = (s) => (s && sets.has(s) ? sets.get(s) : { state: 'absent' });
  const laptopKeyed = [rec.folder, rec.keyed, rec.latest, ...sets.values()].some((r) => r.state !== 'absent');
  const out = {};
  for (const name of STORES) {
    const f = files[name];
    const mk = (state, extra = {}) => ({ state, from: f.from || '', fileWas: f.fileWas || '', gen: f.gen || 0, d: f.d || '', set: f.set || '', fileKid: f.fileKid || '', ...extra });
    if (unreadRecord) { out[name] = mk('unread', { via: 'record', code: unreadRecord.code, name: unreadRecord.name }); continue; }
    if (f.state === 'unread') { out[name] = mk('unread', { via: 'file', code: f.code, name: f.file }); continue; }
    if (f.state === 'absent') { out[name] = mk('absent'); continue; }
    if (f.kind === 'torn') { out[name] = mk('changed', { via: 'torn' }); continue; }
    if (f.kind === 'plain') { out[name] = mk(laptopKeyed || raw.dataKeyed ? 'plain' : 'first'); continue; }
    if (f.fileKid !== raw.kid) {
      const S = setOf(f.set);
      out[name] = F.state !== 'absent' || S.state !== 'absent' ? mk('changed', { via: made ? 'made' : 'relabelled' }) : mk('elsewhere');
      continue;
    }
    if (!f.sealed) { out[name] = mk('changed', { via: 'mac' }); continue; }
    if (F.state === 'ok' && F.rec.set !== f.set) { out[name] = mk('other', { via: 'folder', folderSet: F.rec.set }); continue; }
    const S = setOf(f.set);
    if (S.state === 'absent') { out[name] = mk('unrecorded'); continue; }
    if (S.state !== 'ok') { out[name] = mk('unrecorded', { via: 'record', name: S.name }); continue; }
    const e = cleanEntry(S.rec[name], name === 'accounts');
    if ((F.state === 'ok' && F.rec.set === f.set) || samePath(S.rec.path, here)) { out[name] = mk(ruleOf(f, e), { entry: e }); continue; }
    // This path is not the one the set was saved at: a move from the set this laptop saved last, else another folder's.
    if (L.state === 'ok' && L.rec.set === f.set) {
      const r = ruleOf(f, e);
      out[name] = r === 'older' ? mk('older', { entry: e }) : mk('move', { entry: e, movedFrom: String(S.rec.path || '') });
      continue;
    }
    out[name] = mk('other', { via: 'latest', savedAt: String(S.rec.path || ''), lastRan: L.state === 'ok' ? String(L.rec.path || '') : '' });
  }
  return { stores: out, unreadRecord: unreadRecord || null, laptopKeyed };
}

/** A store's file as a person names it. */
const fileName = (name) => FILES[name];

/**
 * The words of a store's state (the console's; health's and the rows' carry the same), with what was kept aside: the
 * copy held (`held`) or the file kept aside (`aside`). '' for a state that needs none.
 */
function wordsOf(name, s, { held = '', aside = '', count = 0, recorded = null } = {}) {
  const file = fileName(name);
  const signIns = name !== 'accounts';
  const waits = signIns ? 'new sign-ins are kept in memory this run only' : 'account sign-ins wait for a start that can read it';
  const bak = s.from === 'bak' ? file + ' was ' + (s.fileWas === 'torn' ? 'not whole' : 'missing') + '; its .bak was loaded. ' : '';
  const kept = signIns ? (aside ? ' (kept aside as ' + aside + ')' : '') + '; its sign-ins have ended' : held ? ' (kept aside as ' + held + ')' : '';
  const theirs = signIns ? 'these sign-ins were' : 'these accounts were';
  switch (s.state) {
    case 'keyless': return 'this run has no machine key (' + s.code + '): account sign-ins wait for a start that has it';
    case 'unread': return s.via === 'record'
      ? 'the record of this folder\'s saves could not be read (' + s.code + ', ' + s.name + '): account sign-ins wait for a start that can read it; nothing was written over it'
      : file + ' could not be read (' + s.code + '): ' + waits + '; nothing was written over it';
    case 'changed':
      if (s.via === 'made') return 'the machine key was made new at this start; ' + theirs + ' saved under the key it replaced (' + short(s.fileKid || '????') + ', their own claim)' + kept;
      if (s.via === 'relabelled') return file + ' names another machine key (' + short(s.fileKid || '????') + ', its own claim), but this laptop recorded this folder\'s saves: changed after AGMessage saved it' + kept;
      if (s.via === 'torn') return file + ' is not whole, and its .bak could not be loaded: changed after AGMessage saved it' + kept;
      if (s.via === 'repeat') return file + ' holds one account twice, which AGMessage never saves: changed after AGMessage saved it' + kept;
      return file + ' was changed after AGMessage saved it' + kept;
    case 'elsewhere': return bak + file + ' was saved under another machine key (' + short(s.fileKid || '????') + ', its own claim): another computer or Windows account, or anyone who could write the folder. This laptop cannot check ' + (signIns ? 'it' : 'them') + kept;
    case 'other': return s.via === 'folder'
      ? bak + file + ' belongs to another folder\'s saves (set ' + short(s.set) + '; this folder holds ' + short(s.folderSet) + ')' + kept
      : bak + (signIns ? 'these sign-ins are' : 'these accounts are') + ' the saves of ' + (s.savedAt || 'another folder') + '; the folder this laptop ran last is ' + (s.lastRan || 'not recorded') + kept;
    case 'behind': return bak + file + ' is one save behind (save ' + s.gen + '; this laptop recorded ' + s.entry.gen + '): the last save did not reach the disk, or the save before it was put back';
    case 'older': return bak + file + ' is an older save (' + s.gen + '; this laptop recorded ' + s.entry.gen + '), put back from a copy' + kept;
    case 'unrecorded': return bak + (s.via === 'record'
      ? 'the record of this folder\'s saves (' + s.name + ') was changed after AGMessage saved it: an older save cannot be told from the newest this time'
      : 'no record of this folder\'s saves outside the data folder: an older save cannot be told from the newest this time');
    case 'plain': return file + ' has no key: written by AGMessage 0.5.1 or earlier (a rollback, or a copy of an older folder), or by anyone who could write the folder' + kept;
    case 'missing': return signIns ? file + ' is missing: its sign-ins have ended'
      : 'accounts.json is missing: this folder held ' + plural(recorded ? recorded.n : 0, 'account') + ' at save ' + (recorded ? recorded.gen : 0) + '. Put it back and start again, or make the first admin account with the token';
    case 'ended': return plural(count, 'sign-in') + ' ended';
    case 'move': return bak;
    case 'first': return '';
    default: return bak;
  }
}

/** What a sign-in file's row says of why its sign-ins ended. */
function endedWhy(state, via) {
  if (state === 'first' || state === 'plain') return 'from AGMessage 0.5.1';
  if (state === 'elsewhere' || (state === 'changed' && (via === 'relabelled' || via === 'made'))) return 'saved under another machine key';
  if (state === 'other') return 'another folder\'s saves';
  if (state === 'older') return 'an older save';
  if (state === 'missing') return 'the file is missing';
  return 'changed after AGMessage saved them';
}

// ---------------------------------------------------------------- the stores' parts

/** One store's part: its lane's options, its seal, whether it may write, and its keyed hashes. */
class Part {
  constructor(ks, name) {
    this.ks = ks; this.name = name; this.store = null;
    this.landed = { gen: 0, d: '' };   // the newest save of this store that is on disk, or the record's after a `behind` load
    this.disk = null;                  // the save its file on disk holds, {set, gen, d} (what an archive's pin names), or null
    this.pending = null;               // the save the lane is writing: {gen, d, text, floor, n, who}
    this.floorWanted = false;          // the next save takes a right away or ends a sign-in: written twice, recorded at once
    this.lastText = null;              // what is on disk as this run read or wrote it
  }

  /** The store this part keeps (lib/accounts.js): its `fill` is called at open(), its `save` for a second write. */
  attach(store) { this.store = store; }
  /** The options its WriteLane is made with: the file's own check for its .bak, and what a landed write tells. */
  laneOptions() {
    return { worthKeeping: (old) => this.ks._checks(this.name, old), onUnkept: (old) => this.ks._unkept(this.name, old), onWritten: () => this.ks._written(this.name) };
  }
  /** Whether a save of this store may be written now. */
  writable() { return this.ks._writable(this.name); }
  /** The next save takes a right away or ends a sign-in. */
  twice() { this.floorWanted = true; }
  /** The file a save writes: the save's fields, then the store's, then its MAC. */
  seal(fields, indent) { return this.ks._seal(this.name, fields, indent); }
  /** A sign-in's keyed hash. */
  hash(kind, secret) { return this.ks.idHash(kind, secret); }
  /** The token's tag. */
  tag(token) { return this.ks.tag(token); }
  /** Whether its accounts hold one aside (a first admin is then never made). */
  holding() { return !!this.ks.hold; }
}

// ---------------------------------------------------------------- the keyed stores

class KeyedStores {
  /**
   * @param {object} o `keys`: () => {id, accounts, sessions, adminSessions, record} (each a 32-byte key; throws when this
   *   run has no machine key, as lib/secretbox.js derive does); `kid`: this machine key's id (a string, or a function the
   *   audit log answers once it is open); `made`: () => whether this run made the machine key; `records`: the folder
   *   beside the key (<keyDir>/stores); `dataDir`; `archive(time)`: {exists, begun, unread} of an event archive by its name;
   *   `say(line)` and `row(action, target, words)`: a console line, an audit row; `now`.
   */
  constructor({ keys, kid, made = () => false, records, dataDir, archive = () => ({ exists: false, begun: false }), say = () => {}, row = () => {}, now = Date.now } = {}) {
    if (typeof keys !== 'function' || typeof records !== 'string' || !records || typeof dataDir !== 'string' || !dataDir) throw new Error('the keyed stores need their keys, their records folder and the data folder');
    this.keysOf = keys; this.kidOf = typeof kid === 'function' ? kid : () => kid; this.made = made;
    this.records = records; this.dataDir = dataDir; this.here = path.resolve(dataDir);
    this.archive = archive; this.say = say; this.row = row; this.now = now;
    this.K = null; this.kid = '';
    this.runKey = crypto.randomBytes(32);   // a keyless run's sign-in hashes: this run's alone, never written
    this.opened = false;
    this.keyless = null;      // {code, words} when this run has no machine key
    this.parts = Object.fromEntries(STORES.map((n) => [n, new Part(this, n)]));
    this.state = Object.fromEntries(STORES.map((n) => [n, { state: 'closed', words: '', kept: 0, ended: 0 }]));
    this.set = '';
    this.entries = Object.fromEntries(STORES.map((n) => [n, cleanEntry(null, n === 'accounts')]));
    this.archived = {}; this.archiving = null;
    this.hold = null;         // the accounts held aside: {why, file, d, at, left, text, users, waiting, words, mode, copyCode}
    this.recordState = { state: 'ok', words: '' };
    this.recordsOff = '';     // why no record is written this run ('' when they are)
    this.folderDue = true; this.keyedDue = false; this.latestOn = { set: '', path: '' };
    this.lines = []; this.changed = 0; this.digests = new Map();
    this.sessionsKept = false;   // the sign-ins of a file that checked, kept and not loaded while the accounts are not open
    // The stores open() saves at once (each that changed as it opened): no record is written until every one has landed,
    // so a record never names a save that is not on disk. At the first start the sign-in files wait for the accounts'
    // keyed save too (`firstWait`): a keyed sign-in file beside a plain accounts.json would make the next start read it as
    // stripped back to plain.
    this.pendingOpen = new Set(); this.firstWait = false; this.inOpen = false;
    this.nextMissing = '';       // the words of an archive's accounts file found missing, said once the next event begins
    this.claimUnread = '';       // the words of an archive under way whose record could not be read at this start
    this.head = new WriteLane(path.join(records, 'set-pending.json'), { delayMs: RECORD_MS, keepBak: true, mode: 0o600, onWritten: () => this._headWritten() });
  }

  part(name) { return this.parts[name]; }

  /** A sign-in's keyed hash, 64 hex characters: under Kn, or in a keyless run this run's own key. */
  idHash(kind, secret) { return hmacHex(this.K ? this.K.id : this.runKey, kind + '\n' + String(secret)); }
  /** The token's tag: under Kt, so the file gives no offline test of a guessed token. */
  tag(token) { return hmacHex(this.K ? this.K.adminSessions : this.runKey, 'admin token\n' + String(token)); }

  /** Whether the accounts are open: loaded and none held aside that keeps every sign-in out. */
  accountsOpen() {
    const s = this.state.accounts.state;
    return this.opened && !['keyless', 'unread', 'closed'].includes(s) && !(this.hold && this.hold.blocking);
  }

  _writable(name) {
    if (!this.opened || this.keyless || !this.K) return false;
    const s = this.state[name].state;
    if (s === 'unread' || s === 'keyless' || s === 'closed') return false;
    if (name === 'accounts') return !(this.hold && this.hold.blocking);
    if (this.firstWait) return false;
    if (name === 'sessions') return this.accountsOpen() && !this.sessionsKept;
    return true;
  }

  /** The text of a save, its gen the newest landed one's plus one. */
  _seal(name, fields, indent) {
    const p = this.parts[name];
    const gen = p.landed.gen + 1;
    const { text, m } = sealText(this.K[name], LABELS[name], { v: 2, store: name, set: this.set, gen, kid: this.kid, at: this.now() }, fields, indent);
    const extra = name === 'accounts' ? this._whoOf(fields.users || []) : {};
    p.pending = { gen, d: m.slice(0, 32), text, floor: p.floorWanted, ...extra };
    return text;
  }
  /** The accounts' digests and their count, each digest made once per account as it stands. */
  _whoOf(users) {
    const who = {};
    const seen = new Map();
    for (const a of users) {
      const key = JSON.stringify(DIGESTED.map((f) => (a[f] === undefined ? null : a[f])));
      let dg = this.digests.get(key);
      if (!dg) { dg = digestOf(this.K.record, a); this.digests.set(key, dg); }
      seen.set(key, dg);
      if (typeof a.id === 'string') who[a.id] = dg;
    }
    this.digests = seen;
    return { n: users.length, who };
  }

  /** The .bak's check: a file of this store, under this key and this folder's set. */
  _checks(name, old) {
    if (!this.K || !checkText(this.K[name], LABELS[name], old)) return false;
    const d = parseJson(old);
    return isRecord(d) && d.v === 2 && d.store === name && d.set === this.set && d.kid === this.kid;
  }
  /**
   * A file on disk that failed the check when a save came to keep it: kept aside and said, unless it is what this run
   * read at open() or wrote itself (already said, or held aside), which is only not kept as the .bak.
   */
  _unkept(name, old) {
    const p = this.parts[name];
    if (p.lastText !== null && old === p.lastText) return;
    const aside = this._keepAside(name, old, 'changed');
    this.changed++;
    const words = fileName(name) + ' was changed while AGMessage ran: kept aside as ' + (aside || 'nothing (it could not be written)') + '; AGMessage\'s own save is written over it';
    this.say('  Accounts:    ✕ ' + words);
    this.row('stores.changed', fileName(name), words);
  }
  /** A store's file kept aside as <name>.<kind>-<time>.json; its name, or '' when it could not be written. */
  _keepAside(name, text, kind) {
    const aside = FILES[name].replace(/\.json$/, '') + '.' + kind + '-' + stamp(this.now()) + '.json';
    try { writeFileAtomic(path.join(this.dataDir, aside), text, { mode: 0o600 }); return aside; } catch (e) {
      this.say('  [accounts] ' + aside + ' could not be kept aside (' + (e.code || e.message) + ')');
      return '';
    }
  }

  /**
   * A store's write landed: its record follows, at once for a save that took a right away, then the same save again. The
   * last of open()'s saves to land writes the records; the accounts' at the first start lets the sign-in files be saved.
   */
  _written(name) {
    const p = this.parts[name];
    const w = p.pending;
    p.pending = null;
    if (!w) return;
    const e = this.entries[name];
    const floor = w.floor ? w.gen : e.floor;
    this.entries[name] = { gen: w.gen, d: w.d, prev: p.landed.d, floor, ...(name === 'accounts' ? { n: w.n, who: w.who } : {}) };
    p.landed = { gen: w.gen, d: w.d };
    p.disk = { set: this.set, gen: w.gen, d: w.d };
    p.lastText = w.text;
    // A store that had none, or whose file was missing, holds this save now; accounts once they hold one.
    if (['none', 'missing'].includes(this.state[name].state) && !(name === 'accounts' && p.store && p.store.size === 0)) this.state[name] = { ...this.state[name], state: 'ok', words: '' };
    const opening = this.pendingOpen.delete(name);
    if (name === 'accounts' && this.firstWait) {
      this.firstWait = false;
      // Outside open()'s own turn the sign-in files that waited are saved now, keyed beside the keyed accounts.
      if (!this.inOpen) for (const n of this.pendingOpen) if (this.parts[n].store) { this.parts[n].twice(); this.parts[n].store.save(); }
    }
    if (w.floor) {
      p.floorWanted = false;
      this.recordNow();
      if (p.store) p.store.save();
    } else if (opening && !this.pendingOpen.size) this.recordNow();
    else this._recordSoon();
  }

  /** Why the records outside the data folder wait: open()'s saves that have not landed yet ('' when none). */
  recordsWait() {
    if (!this.pendingOpen.size) return '';
    const names = [...this.pendingOpen];
    const error = names.map((n) => (this.parts[n].store ? this.parts[n].store.lane.lastError : '')).find(Boolean);
    return 'the record of this folder\'s saves waits until ' + names.map(fileName).join(' and ') + (names.length === 1 ? ' is' : ' are') + ' saved keyed' + (error ? ' (' + error + ')' : '') + ': nothing is recorded until then';
  }

  _recordSoon() {
    if (this.recordsOff || !this.K || !this.set || this.pendingOpen.size) return;
    this._folderFirst();
    this.head.save(() => recordText(this.K.record, 'set', this._setRecord()));
  }
  /** The set record written now, in this turn: a save that took a right away, an adoption, an archive's step. */
  recordNow() {
    if (this.recordsOff || !this.K || !this.set || this.pendingOpen.size) return false;
    this._recordSoon();
    return this.head.flushSync();
  }
  _setRecord() {
    return {
      v: 1, set: this.set, path: this.here, kid: this.kid,
      accounts: this.entries.accounts, sessions: this.entries.sessions, adminSessions: this.entries.adminSessions,
      archived: this.archived, archiving: this.archiving,
      held: this.hold ? { file: this.hold.file, d: this.hold.d, at: this.hold.at, why: this.hold.why, left: this.hold.left } : null,
      at: this.now(),
    };
  }
  /** The folder record and keyed.json, once each, before the set record they lead to. */
  _folderFirst() {
    const at = this.now();
    if (this.folderDue) {
      try {
        writeFileAtomic(path.join(this.records, 'folder-' + this.folderId + '.json'), recordText(this.K.record, 'folder', { v: 1, folder: this.folderId, path: this.here, set: this.set, at }), { mode: 0o600 });
        this.folderDue = false;
      } catch (e) { this.say('  [accounts] the record of this folder could not be written in ' + this.records + ' (' + (e.code || e.message) + '): the next save tries again'); }
    }
    if (this.keyedDue) {
      try {
        writeFileAtomic(path.join(this.records, 'keyed.json'), recordText(this.K.record, 'keyed', { v: 1, since: at }), { mode: 0o600 });
        this.keyedDue = false;
      } catch (e) { this.say('  [accounts] keyed.json could not be written in ' + this.records + ' (' + (e.code || e.message) + ')'); }
    }
  }
  /** The set record landed: latest.json names this set and path, written when it names another. */
  _headWritten() {
    if (this.latestOn.set === this.set && samePath(this.latestOn.path, this.here)) return;
    try {
      writeFileAtomic(path.join(this.records, 'latest.json'), recordText(this.K.record, 'latest', { v: 1, set: this.set, path: this.here, at: this.now() }), { mode: 0o600 });
      this.latestOn = { set: this.set, path: this.here };
    } catch (e) { this.say('  [accounts] latest.json could not be written in ' + this.records + ' (' + (e.code || e.message) + '): the next record tries again'); }
  }

  /** A record that failed its check, copied aside before it is written anew; its name. */
  _recordAside(r) {
    const aside = r.name.replace(/\.json$/, '') + '.changed-' + stamp(this.now()) + '.json';
    try { writeFileAtomic(path.join(this.records, aside), r.text || '', { mode: 0o600 }); } catch (e) { this.say('  [accounts] ' + r.name + ' could not be kept aside (' + (e.code || e.message) + ')'); return ''; }
    return aside;
  }

  /**
   * Read before open(), and write nothing: the archive under way this folder's record names, so a start finishes only the
   * archive it claims. {state: 'keyless' | 'unread' | 'none' | 'claim', claim, words}.
   */
  peekClaim() {
    let K;
    try { K = this.keysOf(); } catch (e) { return { state: 'keyless', claim: null, words: 'this run has no machine key (' + (e.code || 'EIO') + ')' }; }
    const F = readRecord(this.records, 'folder-' + placeId(this.dataDir, undefined, { absentOk: true }) + '.json', 'folder', K.record);
    if (F.state === 'unread') return { state: 'unread', claim: null, words: 'the record of this folder\'s saves could not be read (' + F.code + ', ' + F.name + ')' };
    if (F.state !== 'ok' || !HEX32.test(F.rec.set || '')) return { state: 'none', claim: null, words: '' };
    const S = readRecord(this.records, 'set-' + F.rec.set + '.json', 'set', K.record);
    if (S.state === 'unread') return { state: 'unread', claim: null, words: 'the record of this folder\'s saves could not be read (' + S.code + ', ' + S.name + ')' };
    const claim = S.state === 'ok' ? cleanClaim(S.rec.archiving) : null;
    return claim ? { state: 'claim', claim, words: '' } : { state: 'none', claim: null, words: '' };
  }

  // -------------------------------------------------------------- open()

  /**
   * Open the stores, once, after the folder is held and the audit log is open, before anything is served: the decision
   * per store, the stores filled, the hold, then the writes (the stores first, the records after them). Answers report().
   */
  open() {
    if (this.opened) return this.report();
    this.opened = true;
    try { this.K = this.keysOf(); } catch (e) {
      this.keyless = { code: e.code || 'EIO', words: e.message };
      for (const n of STORES) this.state[n] = { state: 'keyless', words: wordsOf(n, { state: 'keyless', code: this.keyless.code }), kept: 0, ended: 0 };
      this.recordsOff = 'keyless';
      this.lines.push('  Accounts:    △ ' + this.state.accounts.words + '. Guests, screens and the token go on.');
      for (const n of STORES) if (this.parts[n].store) this.parts[n].store.fill([], { state: 'keyless' });
      return this.report();
    }
    this.kid = String(this.kidOf() || '');
    this.folderId = placeId(this.dataDir, undefined, { absentOk: true });
    const raw = readFolder({ dataDir: this.dataDir, records: this.records, K: this.K, kid: this.kid });
    const dec = decide(raw, { made: !!this.made() });
    if (dec.unreadRecord) return this._unread(dec);
    this._records(raw);
    // The set the folder holds from here on, and the record it goes on from.
    const s = dec.stores;
    const F = raw.rec.folder;
    const setRec = (x) => (x && raw.sets.get(x) && raw.sets.get(x).state === 'ok' ? raw.sets.get(x).rec : null);
    let base = null;
    let lastSavedAt = '';
    if (F.state === 'ok') { this.set = F.rec.set; base = setRec(this.set); } else {
      const moved = STORES.map((n) => s[n]).find((x) => x.state === 'move');
      const kept = STORES.map((n) => s[n]).find((x) => LOADED.includes(x.state) && x.set);
      if (moved) { this.set = crypto.randomBytes(16).toString('hex'); base = setRec(moved.set); lastSavedAt = moved.movedFrom || 'another folder'; } else if (kept) { this.set = kept.set; base = setRec(kept.set); } else this.set = crypto.randomBytes(16).toString('hex');
    }
    this.head.file = path.join(this.records, 'set-' + this.set + '.json');
    if (base) {
      for (const n of STORES) this.entries[n] = cleanEntry(base[n], n === 'accounts');
      this.archived = cleanPins(base.archived);
      this.archiving = cleanClaim(base.archiving);
    }
    for (const n of STORES) {
      const x = s[n];
      if (!LOADED.includes(x.state) || x.state === 'behind') continue;
      const e = this.entries[n];
      if (x.gen > e.gen) this.entries[n] = { ...e, gen: x.gen, d: x.d, prev: x.gen === e.gen + 1 ? e.d : '' };
    }
    for (const n of STORES) this.parts[n].landed = { gen: this.entries[n].gen, d: this.entries[n].d };
    // What each file on disk holds, as an archive's pin names it: the save as read (one save behind included).
    for (const n of STORES) if (LOADED.includes(s[n].state)) this.parts[n].disk = { set: s[n].set, gen: s[n].gen, d: s[n].d };
    this.folderDue = !(F.state === 'ok' && F.rec.set === this.set && samePath(F.rec.path, this.here));
    this.keyedDue = raw.rec.keyed.state !== 'ok';
    if (raw.rec.latest.state === 'ok') this.latestOn = { set: raw.rec.latest.rec.set, path: raw.rec.latest.rec.path };
    this._claimAtStart();
    // An event archive under way: its step 7 makes the next event's stores at this start, so nothing of the folder's live
    // stores is loaded (they were moved into the archive, or are the next event's part written).
    if (this.archiving) {
      for (const n of STORES) {
        const f = raw.files[n];
        this.parts[n].lastText = typeof f.own === 'string' ? f.own : null;
        this.state[n] = { state: 'archiving', words: n === 'accounts' ? this.claimUnread : '', kept: 0, ended: 0, count: 0 };
        if (this.parts[n].store) this.parts[n].store.fill([], { state: 'archiving' });
      }
      if (this.claimUnread) this.lines.push('  Accounts:    △ ' + this.claimUnread);
      this.recordNow();
      return this.report();
    }
    const prevHeld = base ? cleanHeld(base.held) : null;
    const writes = new Set();
    this._openAccounts(s.accounts, raw, prevHeld, base, writes);
    for (const n of ['sessions', 'adminSessions']) this._openSignIns(n, s[n], raw, writes);
    if (lastSavedAt) {
      for (const n of STORES) if (LOADED.includes(s[n].state) && this._writable(n)) writes.add(n);
      this.lines.push('  Accounts:    this folder was last saved at ' + lastSavedAt + '; its accounts and sign-ins go on here');
    }
    // The writes: each store that changed at open(), twice, under the folder's set, the accounts first; then the records,
    // only once every one of them has landed (here, or when its lane lands it later). At the first start the sign-in files
    // are saved only after the accounts' keyed save has landed.
    this.pendingOpen = new Set(STORES.filter((n) => writes.has(n) && this.parts[n].store && this._writable(n)));
    this.firstWait = this.state.accounts.state === 'first' && this.pendingOpen.has('accounts');
    this.inOpen = true;
    try {
      for (const n of STORES) {
        if (!this.pendingOpen.has(n) || (n !== 'accounts' && this.firstWait)) continue;
        this.parts[n].twice();
        this.parts[n].store.save();
        this.parts[n].store.lane.flushSync();
      }
    } finally { this.inOpen = false; }
    if (this.pendingOpen.size) this.lines.push('  Accounts:    △ ' + this.recordsWait());
    // A folder with nothing in its stores yet is recorded at its first save, never before: an empty start keys nothing.
    else if (writes.size || this.hold || STORES.some((n) => !['none', 'closed'].includes(this.state[n].state))) this.recordNow();
    return this.report();
  }

  /** A record outside the data folder could not be read: no store opens, and nothing is written this run. */
  _unread(dec) {
    this.recordsOff = 'unread';
    const r = dec.unreadRecord;
    this.recordState = { state: 'unread', words: r.name + ' could not be read (' + r.code + '): the stores were not opened this start' };
    for (const n of STORES) this.state[n] = { state: 'unread', words: wordsOf(n, dec.stores[n]), kept: 0, ended: 0 };
    for (const n of STORES) if (this.parts[n].store) this.parts[n].store.fill([], { state: 'unread' });
    this.lines.push('  Accounts:    △ ' + this.state.accounts.words);
    this.row('stores.record', r.name, 'could not be read (' + r.code + '): the stores were not opened this start');
    return this.report();
  }

  /** The records that failed their check: kept aside, said, and written anew. */
  _records(raw) {
    for (const r of [raw.rec.folder, raw.rec.keyed, raw.rec.latest, ...raw.sets.values()]) {
      if (r.state !== 'changed') continue;
      const aside = this._recordAside(r);
      const words = 'changed: kept aside as ' + (aside || 'nothing (it could not be written)');
      this.recordState = { state: 'changed', words: r.name + ' was ' + words };
      this.lines.push('  Accounts:    ✕ the record ' + r.name + ' was changed after AGMessage saved it (kept aside as ' + (aside || 'nothing') + '): it vouches for nothing');
      this.row('stores.record', r.name, words);
    }
  }

  /**
   * The archive the folder's record claims, at a start: cleared where it never began (no archive of its time at all), or
   * once its next event began. One whose record cannot be read is kept, claim and pin, for a start that can read it.
   */
  _claimAtStart() {
    const c = this.archiving;
    if (!c) return;
    const a = this.archive(c.time) || {};
    if (a.unread) {
      this.claimUnread = 'the event archive under way (' + c.time + ') could not be read (' + a.unread + '): its claim is kept for a start that can read it, and account sign-ins wait until then';
      return;
    }
    if (!a.exists) { this.archiving = null; delete this.archived[c.time]; return; }
    if (a.begun) this.archiving = null;
  }

  _openAccounts(x, raw, prevHeld, base, writes) {
    const part = this.parts.accounts;
    const store = part.store;
    const valid = store ? (u) => store.validUser(u) : () => true;
    const f = raw.files.accounts;
    let st = x.state;
    let users = [];
    if (LOADED.includes(st) || st === 'first') users = usersIn(f.data, valid);
    // A keyed file that checks and holds one account twice: AGMessage never saves one, so the file was changed.
    if (LOADED.includes(st) && (() => { const r = repeatsIn(users); return r.ids.size || r.names.size; })()) { st = 'changed'; x = { ...x, state: 'changed', via: 'repeat' }; }
    if (st === 'absent') {
      const recorded = base ? cleanEntry(base.accounts, true) : null;
      if (recorded && recorded.gen > 0) st = 'missing';
      else st = 'none';
      x = { ...x, state: st };
      const words = st === 'missing' ? wordsOf('accounts', x, { recorded }) : '';
      this.state.accounts = { state: st, words, kept: 0, ended: 0, count: 0 };
      if (store) store.fill([], { state: st });
      if (words) this.lines.push('  Accounts:    ✕ ' + words);
      return;
    }
    if (st === 'unread') {
      this.state.accounts = { state: 'unread', words: wordsOf('accounts', x), kept: 0, ended: 0, count: 0 };
      if (store) store.fill([], { state: 'unread' });
      this.lines.push('  Accounts:    △ ' + this.state.accounts.words);
      return;
    }
    part.lastText = typeof f.own === 'string' ? f.own : null;
    if (ASIDE.includes(st)) {
      const all = usersIn(f.data, valid);
      this._holdAside(st, x, f.text, all, prevHeld);
      this.state.accounts = { state: this.hold.why, words: this.hold.words, kept: 0, ended: 0, count: 0 };
      if (store) store.fill([], { state: this.hold.why });
      this.lines.push(...this._heldLines());
      this.row('accounts.held', 'accounts', this.hold.words);
      return;
    }
    if (st === 'first') {
      const r = repeatsIn(users);
      const reach = store && typeof store.reachOf === 'function' ? (u) => store.reachOf(u) : () => ({ admin: false, past: false });
      const waits = users.filter((u) => repeated(u, r) || reach(u).admin || reach(u).past);
      const open = users.filter((u) => !waits.includes(u));
      // The copy is kept only where some wait: one nothing refers to is never written.
      this.hold = waits.length ? this._newHold('first', f.text, users, waits, null) : null;
      if (store) store.fill(open, { state: 'first' });
      const names = waits.map((u) => u.username);
      this.state.accounts = { state: 'first', words: plural(users.length, 'account') + ' from AGMessage 0.5.1 keyed to this laptop' + (waits.length ? '; ' + waits.length + ' wait for the token' : ''), kept: open.length, ended: 0, count: open.length };
      writes.add('accounts');
      this._firstLines(users.length, names);
      this.row('accounts.keyed', 'accounts', listWords(plural(users.length, 'account') + ' from AGMessage 0.5.1 keyed as accounts.json held them' + (names.length ? '; waiting for the token' : ''), names));
      if (waits.length) this.row('accounts.held', 'accounts', listWords(plural(waits.length, 'account') + ' that can manage AGMessage or reach past their halls wait for the token (copy kept as ' + this.hold.file + ')', names));
      return;
    }
    // Loaded as found: ok, behind, unrecorded or a move.
    if (store) store.fill(users, { state: st });
    const words = wordsOf('accounts', x);
    this.state.accounts = { state: st, words, kept: users.length, ended: 0, count: users.length };
    if (words) this.lines.push('  Accounts:    ' + (MARK[st] ? MARK[st] + ' ' : '') + words);
    if (st === 'behind') this.row('accounts.behind', 'accounts', (x.from === 'bak' ? 'accounts.json was missing; its .bak was loaded: ' : '') + 'one save behind (' + x.gen + ' of ' + x.entry.gen + ')');
    if (x.from === 'bak') writes.add('accounts');
    // A hold an earlier start began goes on: the accounts that wait at the first start, or those left out of an adoption.
    if (prevHeld && (prevHeld.left === null ? prevHeld.why === 'first' : prevHeld.left > 0)) this._holdAgain(prevHeld, users);
  }

  /** The accounts held aside whole: the copy kept as read (the same copy while its bytes are the same). */
  _holdAside(state, x, text, all, prevHeld) {
    const d = sha256(text);
    const reuse = prevHeld && prevHeld.d === d && prevHeld.left === null && prevHeld.why !== 'first';
    const why = reuse ? prevHeld.why : state;
    this.hold = reuse ? { ...prevHeld, text, users: all, waiting: all.slice(), mode: 'aside', copyCode: '' } : this._newHold(state, text, all, all.slice(), null);
    this.hold.blocking = true;
    this.hold.why = why;
    this.hold.words = reuse && why !== state ? wordsOf('accounts', { ...x, state: why }, { held: this.hold.file }) : wordsOf('accounts', x, { held: this.hold.file });
    this.hold.recorded = this.entries.accounts;
  }
  /** A new copy held aside, written in the data folder byte for byte as it was read. */
  _newHold(why, text, users, waiting, left) {
    const at = this.now();
    const file = 'accounts.held-' + stamp(at) + '.json';
    let copyCode = '';
    try { writeFileAtomic(path.join(this.dataDir, file), text, { mode: 0o600 }); } catch (e) {
      copyCode = e.code || 'EIO';
      this.say('  [accounts] the copy held aside (' + file + ') could not be written (' + copyCode + '): this run holds it, and a later run cannot adopt from it');
    }
    return { why, file, d: sha256(text), at, left, text, users, waiting, mode: why === 'first' ? 'first' : 'aside', copyCode, blocking: false, words: '' };
  }
  /**
   * A hold an earlier start began, read again from its copy: its accounts offered only while the copy is byte for byte
   * what was held. A copy changed since, or one that cannot be read, offers none: the hold stays, said (the console,
   * health and a row), until the token at the laptop leaves its accounts out (Leave these out…, Leave the rest out…).
   */
  _holdAgain(prev, open) {
    const r = readText(path.join(this.dataDir, prev.file));
    const ok = !r.code && sha256(r.text) === prev.d;
    const store = this.parts.accounts.store;
    const valid = store ? (u) => store.validUser(u) : () => true;
    const users = ok ? usersIn(parseJson(r.text), valid) : [];
    const openIds = new Set(open.map((u) => u.id));
    const waiting = users.filter((u) => !openIds.has(u.id));
    const unusable = ok ? '' : 'the copy held aside (' + prev.file + ') ' + (r.code ? 'could not be read (' + r.code + ')' : 'was changed since it was held') + ': no account can be adopted from it';
    this.hold = { ...prev, text: ok ? r.text : null, users, waiting, mode: prev.left === null ? 'first' : 'left', copyCode: ok ? '' : r.code || 'changed', blocking: false, words: '', unusable };
    if (!ok) {
      this.lines.push('  Accounts:    ✕ ' + unusable + '. The token at the laptop may leave them out (Admin → Accounts held aside)');
      // A copy changed after AGMessage kept it is a store's file changed: its row. One that cannot be read is said alone.
      if (!r.code) this.row('stores.changed', prev.file, unusable);
    } else if (waiting.length) this.lines.push('  Accounts:    ' + plural(waiting.length, 'account') + ' kept aside in ' + prev.file + ': the token at the laptop may adopt them (Admin → Accounts held aside)');
    if (!waiting.length && ok) this.hold = null;
  }

  _openSignIns(n, x, raw, writes) {
    const part = this.parts[n];
    const store = part.store;
    const f = raw.files[n];
    if (typeof f.own === 'string') part.lastText = f.own;
    let st = x.state;
    if (st === 'unread') {
      this.state[n] = { state: 'unread', words: wordsOf(n, x), kept: 0, ended: 0 };
      if (store) store.fill([], { state: 'unread' });
      this.lines.push('  Accounts:    △ ' + this.state[n].words);
      return;
    }
    if (st === 'absent') {
      const recorded = this.entries[n];
      st = recorded.gen > 0 ? 'missing' : 'none';
      const words = st === 'missing' ? wordsOf(n, { state: 'missing' }) : '';
      this.state[n] = { state: st, words, kept: 0, ended: 0 };
      if (store) store.fill([], { state: st });
      if (words) this.lines.push('  Accounts:    ✕ ' + words);
      return;
    }
    if (LOADED.includes(st)) {
      const list = isRecord(f.data) && Array.isArray(f.data.sessions) ? f.data.sessions : [];
      const words = wordsOf(n, x);
      const kept = store ? store.fill(list, { state: st, k: isRecord(f.data) ? f.data.k : undefined, kept: n === 'sessions' && !this.accountsOpen() }) : list.length;
      if (n === 'sessions' && !this.accountsOpen()) this.sessionsKept = true;
      this.state[n] = { state: st, words, kept: typeof kept === 'number' ? kept : list.length, ended: 0 };
      if (words) this.lines.push('  Accounts:    ' + (MARK[st] ? MARK[st] + ' ' : '') + words);
      if (x.from === 'bak') writes.add(n);
      return;
    }
    // Every other state ends the file's sign-ins: it is kept aside (a changed file), and saved again empty, keyed.
    const list = isRecord(f.data) && Array.isArray(f.data.sessions) ? f.data.sessions : [];
    const count = list.length;
    const plainFirst = st === 'first' || st === 'plain';
    const aside = plainFirst ? '' : this._keepAside(n, f.text || '', 'changed');
    const why = endedWhy(st, x.via);
    const words = plural(count, 'sign-in') + ' ended: ' + why + (aside ? ' (kept aside as ' + aside + ')' : '');
    this.state[n] = { state: 'ended', words, kept: 0, ended: count, found: st };
    if (store) store.fill([], { state: 'ended' });
    writes.add(n);
    if (count || !plainFirst) {
      this.lines.push('  Accounts:    ✕ ' + fileName(n) + ': ' + words);
      this.row('signins.ended', n, words);
    }
  }

  _firstLines(total, waiting) {
    const lines = ['  Accounts:    ' + plural(total, 'account') + ' from AGMessage 0.5.1 ' + (total === 1 ? 'is' : 'are') + ' keyed to this laptop from here on, as accounts.json held them.'];
    if (waiting.length) {
      lines.push('               ' + waiting.length + ' that can manage AGMessage or reach past their halls wait for you: ' + listWords('', waiting).replace(/^: /, '') + '.');
      lines.push('               Open them at Admin → Accounts held aside, with the token above.');
    }
    lines.push('               Sign-ins from 0.5.1 have ended: each person signs in once more.');
    this.lines.push(...lines);
  }
  _heldLines() {
    const h = this.hold;
    return [
      '  Accounts:    ✕ held aside: ' + plural(h.users.length, 'account') + ' in this folder: ' + h.words + '.',
      '               Nobody signs in with them until they are adopted: Admin → Accounts held aside, with the token',
      '               above. Sign-ins saved with them have ended.',
    ];
  }

  // -------------------------------------------------------------- after open()

  /** Health's `signins`: each store's state, the record's, the set and the saves. No secret, no hash. */
  report() {
    const a = this.state.accounts;
    const hold = this.hold;
    const entry = (n) => ({ state: this.state[n].state, kept: this.state[n].kept, ended: this.state[n].ended, words: this.state[n].words });
    return {
      accounts: { state: a.state, count: this.parts.accounts.store ? this.parts.accounts.store.size : a.count || 0, held: hold ? hold.waiting.length : 0, words: hold && hold.unusable ? hold.unusable : hold && hold.mode === 'left' ? leftWords(hold) : a.words },
      sessions: entry('sessions'), adminSessions: entry('adminSessions'),
      record: this.pendingOpen.size && !this.recordsOff ? { state: 'waiting', words: this.recordsWait() }
        : { state: this.recordsOff ? this.recordsOff : this.head.lastError ? 'failing' : this.recordState.state, words: this.head.lastError ? 'the record of this folder\'s saves could not be written (' + this.head.lastError + '): it lags its stores until it can' : this.recordState.words },
      set: this.set ? short(this.set) : '', gens: Object.fromEntries(STORES.map((n) => [n, this.parts[n].landed.gen])),
      changed: this.changed,
    };
  }

  /** The console's lines of open(), each said once, after the token block and the audit's question. */
  bannerLines() { return this.lines.splice(0); }

  /**
   * What the admin page is told of a hold (the admin's, by the admin page's gate): null when accounts are open and none
   * is held; else {state, waiting, words}, `left` too while some are kept aside after an adoption, and the words of a
   * copy no account can be adopted from (`unusable`).
   */
  heldFacts() {
    const a = this.state.accounts.state;
    if (a === 'keyless' || a === 'unread') return { state: a, waiting: 0, words: a === 'keyless' ? KEYLESS_WORDS : UNREAD_WORDS };
    const h = this.hold;
    if (!h) return null;
    const unusable = h.unusable ? { unusable: true } : {};
    if (h.mode === 'first') return { state: 'first', waiting: h.waiting.length, words: h.unusable || FIRST_WORDS, ...unusable };
    if (h.mode === 'left') return { state: 'left', waiting: h.waiting.length, words: h.unusable || leftWords(h), left: h.left, ...unusable };
    return { state: h.why, waiting: h.waiting.length, words: HELD_WORDS };
  }
  /**
   * What the sign-in page and any page that is not the admin's are told (/api/auth/me, /api/admin/me to anyone else):
   * {state, waiting, words} while account sign-ins wait, or null. Nothing of those left out of an adoption, nor of a copy
   * held aside but how the sign-in page says it.
   */
  pageFacts() {
    const f = this.heldFacts();
    if (!f || f.state === 'left') return null;
    return { state: f.state, waiting: f.waiting, words: f.state === 'first' ? FIRST_WORDS : f.words };
  }
  /** Why an account may not sign in now, in the page's words, or '' when it may (a hold that keeps them all out). */
  signInRefusal() {
    const f = this.heldFacts();
    return f && (f.state === 'keyless' || f.state === 'unread' || ASIDE.includes(f.state)) ? f.words : '';
  }
  /** Whether a username is an account that waits for the token at the first start (refused as an unknown name is). */
  waits(username) { return !!this.hold && this.hold.mode === 'first' && this.hold.waiting.some((u) => u.username === username); }
  /** Why the first admin account may not be made now, or '' when it may. */
  setupRefusal() {
    const f = this.heldFacts();
    if (!f) return '';
    if (f.state === 'keyless' || f.state === 'unread') return 'Accounts could not be read on this start: start AGMessage again.';
    return 'Adopt the accounts held aside, or start with none, first (Admin → Accounts held aside).';
  }

  /**
   * The copy held aside as the panel draws it: each record with its mark (as this laptop last saved it, changed since,
   * new to this laptop; repeated), what it may do, and the ticks it starts with; at the first start the accounts keyed as
   * found too, as open. Never a hash. {ok, …} or {ok: false, status, error}.
   */
  heldView(open, view = (a) => ({ id: a.id, username: a.username })) {
    const h = this.hold;
    if (!h) return { ok: false, status: 404, error: 'No accounts are held aside.' };
    // A copy no account can be adopted from (changed since it was held, or unreadable) lists none, says why, and offers
    // only to leave its accounts out (`unusable`), which ends the hold.
    const rows = h.text ? this._rows(open) : [];
    return {
      ok: true, state: h.mode === 'aside' ? h.why : h.mode, words: h.unusable || (h.mode === 'aside' ? h.words : h.mode === 'first' ? FIRST_WORDS : leftWords(h)),
      file: h.file, digest: h.d, at: h.at, mode: h.mode, cannotCheck: h.why === 'elsewhere', unusable: !h.text,
      accounts: rows.filter((r) => !r.opened).map(({ account, opened, ...r }) => ({ ...r, ...view(account) })),
      open: h.mode === 'first' ? open.map((a) => a.username).sort() : [],
    };
  }
  /** The copy's waiting records, each by its key in the panel (its id, or <id>#<n> where the id is in the copy twice). */
  _rows(open) {
    const h = this.hold;
    const store = this.parts.accounts.store;
    const reach = store && typeof store.reachOf === 'function' ? (u) => store.reachOf(u) : () => ({ admin: false, past: false });
    const rep = repeatsIn(h.users);
    const who = this.whoSaved();
    const openIds = new Set(open.map((a) => a.id));
    const counts = new Map();
    return h.users.map((u) => {
      const n = (counts.get(u.id) || 0) + 1;
      counts.set(u.id, n);
      const ref = rep.ids.has(u.id) ? u.id + '#' + n : u.id;
      const saved = who && who[u.id];
      const mark = saved ? (saved === digestOf(this.K.record, u) ? 'saved' : 'changed') : 'new';
      const r = reach(u);
      const isRepeated = repeated(u, rep) || open.some((a) => a.username === u.username && a.id !== u.id);
      const reset = mark === 'saved' || h.why === 'first' ? false : r.admin || (h.why === 'elsewhere' ? r.past : h.why !== 'elsewhere');
      return { ref, account: u, mark, repeated: isRepeated, admin: r.admin, past: r.past, adopt: !isRepeated && (mark === 'saved' || !r.admin), confirm: r.admin && mark !== 'saved', reset, opened: openIds.has(u.id) && !rep.ids.has(u.id) };
    });
  }
  /** The digests of the set record this path's folder record names (`who`), or null. */
  whoSaved() { return this.hold && this.hold.recorded ? this.hold.recorded.who : this.entries.accounts.who || null; }

  /**
   * An adoption asked ({digest, adopt: [{id, reset}], confirm, keep}), judged against the copy held: {rows: [{account,
   * reset}], fresh} to adopt, or {status, error}. `open` the accounts open now.
   */
  judgeAdoption(ask, open) {
    const h = this.hold;
    if (!h) return { status: 404, error: 'No accounts are held aside.' };
    if (!h.text && ask.adopt.length) return { status: 409, error: 'The copy held aside (' + h.file + ') ' + (h.copyCode === 'changed' ? 'was changed since it was held' : 'could not be read (' + h.copyCode + ')') + ': no account can be adopted from it. Leave its accounts out, or put the copy back and start AGMessage again.' };
    if (!sameHex(ask.digest, h.d)) return { status: 409, error: 'The copy held aside changed since you read it: read it again.' };
    if (!h.text) return { rows: [], fresh: true };
    const rows = this._rows(open).filter((r) => !r.opened);
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    const picked = [];
    const seen = new Set();
    for (const a of ask.adopt) {
      const r = byRef.get(a.id);
      if (!r || seen.has(a.id)) return { status: 400, error: 'That account is not in the copy held aside, or is named twice.' };
      seen.add(a.id);
      if (r.confirm && !ask.confirm.includes(a.id)) return { status: 400, error: r.account.username + ' can manage AGMessage: confirm it to adopt it.' };
      if (r.reset && a.reset !== true && !ask.keep.includes(a.id)) return { status: 400, error: r.account.username + '\'s password in this copy is the copy\'s own claim: confirm that it keeps it, or give it a one-time password.' };
      picked.push({ account: r.account, reset: a.reset === true, ref: a.id });
    }
    const ids = new Map();
    const names = new Map();
    for (const a of [...open, ...picked.map((p) => p.account)]) { ids.set(a.id, (ids.get(a.id) || 0) + 1); names.set(a.username, (names.get(a.username) || 0) + 1); }
    const twice = [...new Set([...[...ids].filter(([, n]) => n > 1).map(([k]) => k), ...[...names].filter(([, n]) => n > 1).map(([k]) => k)])];
    if (twice.length) return { status: 400, error: 'Each account opens once: ' + twice.slice(0, 5).join(', ') + ' would be open twice. Leave out all but one.' };
    return { rows: picked, fresh: !picked.length };
  }

  /**
   * An adoption taken into the live accounts (`open` the accounts open now): how many the copy holds that are not open.
   * The hold ends when none is left or with `leaveRest`; while some are, the panel offers Adopt more…. Writes nothing:
   * the accounts' save that follows (twice) writes the record once its first write lands, so the record never says the
   * hold ended before the adopted accounts are on disk. {left, file, why}: `why` the words of a copy no account could be
   * adopted from.
   */
  adopted(open, { leaveRest = false } = {}) {
    const h = this.hold;
    if (!h) return { left: 0, file: '', why: '' };
    const openIds = new Set(open.map((a) => a.id));
    const waiting = h.users.filter((u) => !openIds.has(u.id));
    const left = waiting.length;
    this.state.accounts = { state: 'ok', words: '', kept: open.length, ended: 0, count: open.length };
    if (leaveRest || !left || !h.text) this.hold = null; else this.hold = { ...h, left, waiting, mode: 'left', blocking: false };
    this.sessionsKept = false;
    return { left, file: h.file, why: h.unusable || '' };
  }

  // -------------------------------------------------------------- the event archive's claim and pins (3-K.9)

  /** Why Archive this event… waits, or '': the stores not opened this run, or accounts held aside. */
  archiveRefusal() {
    if (this.keyless || ['unread', 'keyless'].includes(this.state.accounts.state) || this.recordsOff) return 'Archive this event… waits until the accounts are open: this start could not open them.';
    if (this.hold && this.hold.mode !== 'left') return 'Archive this event… waits until the accounts are open (Admin → Accounts held aside).';
    if (this.pendingOpen.size) return 'Archive this event… waits: ' + this.recordsWait() + '.';
    return '';
  }
  /**
   * The claim, before an archive's step 3: the archive under way and the accounts file it takes, pinned, written in this
   * turn. '' when it is on disk, else the lane's error (the archive is refused, nothing having moved).
   */
  claim({ time, kind, next }) {
    // The pin names the save the accounts file on disk holds, by its set: the file the archive takes.
    const part = this.parts.accounts;
    const disk = part.disk || { set: this.set, gen: 0, d: '' };
    const pin = { set: disk.set, gen: disk.gen, d: disk.d, n: part.store ? part.store.size : 0 };
    this.archived = { ...this.archived, [time]: pin };
    this.archiving = { time, kind: String(kind), next: String(next || ''), accounts: pin };
    if (this.recordNow()) return '';
    this.archiving = null;
    delete this.archived[time];
    return this.head.lastError || 'the record of this folder\'s saves could not be written';
  }
  /** The claim cleared, once step 7's saves landed: written at once. */
  clearClaim() { this.archiving = null; this.recordNow(); }
  /** The archive the record claims as under way, or null. */
  underWay() { return this.archiving ? { ...this.archiving } : null; }
  /** The accounts file an archive took, by its name: {set, gen, d, n}, or null. */
  pinOf(time) { return this.archived[time] ? { ...this.archived[time] } : null; }

  /**
   * An archive's accounts file opened against its pin (a continue's, or a copy's): the accounts, or the file held aside as
   * a start holds one ({users} or {held: words}; {users: [], missing: true} when there is none). `file` its path; `time`
   * the archive whose pin it is checked against. A file that cannot be read throws (its words in `words`): nothing is
   * opened or written over it, and the step is tried again.
   *   - the file the archive took (its pin: its set, its save and that save's MAC) opens;
   *   - so does the live accounts.json of a continue already under way (the claim names it) that holds a save of this
   *     folder's set made after the claim, the newest the record names or one save behind it: what the continue's own
   *     step 7 saved, in this run or the one a stop cut short;
   *   - anything else is held aside: an older save of the pin's set, another set's, changed, plain.
   */
  openArchived(file, time) {
    const store = this.parts.accounts.store;
    const valid = store ? (u) => store.validUser(u) : () => true;
    const live = samePath(path.resolve(file), path.join(this.here, FILES.accounts));
    const pin = this.pinOf(time);
    this.nextMissing = '';
    const r = readText(file);
    if (r.code === 'ENOENT') {
      if (live) this.parts.accounts.lastText = null;
      // The archive's accounts went (its contents deleted, or taken out of the folder): said once the next event begins.
      if (pin && pin.gen > 0) this.nextMissing = 'accounts.json of the archive ' + time + ' is missing (its contents were deleted, or it was taken out): it held ' + plural(pin.n, 'account') + ' at save ' + pin.gen + '. Nobody signs in by account until the first admin account is made with the token';
      return { users: [], missing: true };
    }
    if (r.code) {
      const words = path.basename(file) + ' of the archive ' + time + ' could not be read (' + r.code + '): nothing was opened or written over it';
      throw Object.assign(new Error(words), { code: r.code, words });
    }
    const f = classify('accounts', { state: 'read', text: r.text, data: parseJson(r.text), from: 'file' }, this.K, this.kid);
    const pinSet = pin ? pin.set : '';
    let { state, via } = this._archivedState(f, pin, live, time);
    const users = usersIn(f.data, valid);
    if (state === 'ok') { const rep = repeatsIn(users); if (rep.ids.size || rep.names.size) { state = 'changed'; via = 'repeat'; } }
    // What is on disk as this run read it: a save over it is no change made while AGMessage ran.
    if (live) { this.parts.accounts.lastText = r.text; if (state === 'ok') this.parts.accounts.disk = { set: f.set, gen: f.gen, d: f.d }; }
    if (state === 'ok') return { users };
    const x = { state, via, gen: f.gen || 0, d: f.d || '', set: f.set || '', fileKid: f.fileKid || '', folderSet: pinSet || this.set, entry: { gen: pin ? pin.gen : 0 } };
    this._holdAside(state, x, r.text, users, this.hold && this.hold.mode === 'aside' ? this.hold : null);
    this.state.accounts = { state: this.hold.why, words: this.hold.words, kept: 0, ended: 0, count: 0 };
    this.say('  Accounts:    ✕ ' + this.hold.words);
    this.row('accounts.held', 'accounts', this.hold.words);
    return { held: this.hold.words };
  }
  /** An archive's accounts file judged against its pin (openArchived's rules): {state, via}. */
  _archivedState(f, pin, live, time) {
    const c = this.archiving;
    if (f.kind === 'plain') return { state: 'plain', via: '' };
    if (f.kind !== 'keyed') return { state: 'changed', via: 'torn' };
    if (f.fileKid !== this.kid) return { state: 'changed', via: 'relabelled' };
    if (!f.sealed) return { state: 'changed', via: '' };
    if (pin && f.set === pin.set && f.gen === pin.gen && f.d === pin.d) return { state: 'ok', via: '' };
    if (live && c && c.kind === 'continue' && c.next === time && f.set === this.set && f.gen > c.accounts.gen && ['ok', 'behind'].includes(ruleOf(f, this.entries.accounts))) return { state: 'ok', via: 'continued' };
    if (!pin) return { state: 'changed', via: '' };
    if (f.set !== pin.set) return { state: 'other', via: 'folder' };
    return { state: f.gen < pin.gen ? 'older' : 'changed', via: '' };
  }
  /**
   * The accounts are those of the next event, saved at once: the hold of the event before is not the next one's. An
   * archive's accounts file found missing is said now (the console, health), and stays so until an account is made.
   */
  nextEvent() {
    if (this.hold && this.hold.mode !== 'aside') this.hold = null;
    const missing = this.nextMissing;
    this.nextMissing = '';
    if (!this.hold) this.state.accounts = { state: missing ? 'missing' : 'ok', words: missing, kept: 0, ended: 0, count: 0 };
    if (missing && !this.hold) this.say('  Accounts:    ✕ ' + missing);
    this.sessionsKept = false;
  }
}

/** A list in a row's words, past 60 characters "and N more". */
function listWords(head, names) {
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const next = (out ? out + ', ' : '') + names[i];
    if (next.length > 60) return head + ': ' + out + ' and ' + (names.length - i) + ' more';
    out = next;
  }
  return out ? head + ': ' + out : head;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 accounts were left out on 31 Oct and are kept aside: the token at the laptop may adopt them". */
function leftWords(h) {
  const d = new Date(h.at || 0);
  return plural(h.waiting.length, 'account') + (h.waiting.length === 1 ? ' was' : ' were') + ' left out on ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' and ' + (h.waiting.length === 1 ? 'is' : 'are') + ' kept aside: the token at the laptop may adopt them';
}
const HELD_WORDS = 'Accounts are not open on this AGMessage yet. The admin at the AGMessage laptop opens them with its token.';
const FIRST_WORDS = 'Some accounts wait for the admin at the AGMessage laptop.';
const UNREAD_WORDS = 'Accounts could not be read on this start of AGMessage: account sign-ins wait for a start that can read them. Guests join with their codes meanwhile.';
const KEYLESS_WORDS = 'This run of AGMessage has no machine key: account sign-ins wait for a start that has it. Guests join with their codes meanwhile.';

/** The five keys from a `derive(label)` (lib/secretbox.js derive, or a fixed key's in tests), throwing as it throws. */
const keysFrom = (derive) => () => ({ id: derive(LABELS.id), accounts: derive(LABELS.accounts), sessions: derive(LABELS.sessions), adminSessions: derive(LABELS.adminSessions), record: derive(LABELS.record) });

/**
 * What a start would decide for a data folder and its key folder's records (nothing written): each store's state, by
 * the keys given. lib/importfacts.js reads the installed node's copy so before its first start.
 */
function judgeFolder({ dataDir, records, K, kid, made = false }) {
  const raw = readFolder({ dataDir, records, K, kid });
  const dec = decide(raw, { made });
  const states = {};
  for (const n of STORES) {
    const x = dec.stores[n];
    states[n] = x.state === 'absent' ? 'none' : n !== 'accounts' && !LOADED.includes(x.state) && x.state !== 'unread' ? 'ended' : x.state;
  }
  return states;
}

module.exports = { KeyedStores, judgeFolder, keysFrom, sealText, checkText, recordText, recordMac, digestOf, readFolder, decide, LABELS, STORES, FILES, AHEAD_MS, ASIDE, LOADED, HELD_WORDS, FIRST_WORDS, UNREAD_WORDS, KEYLESS_WORDS };
