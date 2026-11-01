'use strict';
/**
 * The audit log exported, signed, to check on another computer (H.9). One zip, made as it streams and kept by nobody:
 * every file of the chain byte for byte up to and including the export's own entry, a manifest that carries the laptop's
 * own check of those bytes, SHA256SUMS over every file, its Ed25519 signature by this machine's signing key (derived from
 * the machine key when it signs, dropped after), the public key, a README, and the verifier (Node, and one page).
 *
 * Invariants:
 *   - Its own entry first. `audit.export` is written and on disk before any file is listed, so the bundle holds it and
 *     its range ends there; then `audit.export.sent` once the last byte was handed to the system, or `audit.export.fail`
 *     with why. Every export that starts ends in one of the two.
 *   - What is sent is what was checked. The files are listed once and opened; nothing after reads a path. The check runs
 *     through those handles and gives each file's length and SHA-256; each is taken again as it streams, and a file that
 *     differs ends the export, which is then never a whole zip.
 *   - One at a time: a second export while one runs is refused with who holds it and since when. Refusals before the
 *     row (no machine key, no verifier to ship, one running) write nothing.
 *   - No synchronous file call, no temporary file, no copy kept. The handles are closed whatever happens.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ZipStream, fits } = require('./zip');
const verifier = require('../verify/verify-audit');

const CHUNK = 64 * 1024;
const SLICE = 1024 * 1024;   // bytes digested between turns of the event loop
const MAX_OPEN_TRIES = 3;
const LINE_SEQ = /^\{"seq":([1-9][0-9]{0,15}),/;

const turn = () => new Promise((resolve) => { setImmediate(resolve); });
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (at) => { const d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const grouped = (fp) => fp.match(/.{4}/g).join(' ');
const range = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);
/** "3.1 MB", "12 KB". */
const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
/** The bundle's name: agmessage-audit-<node id>-<yyyymmdd-hhmm>, by the laptop's clock. */
const bundleName = (nodeId, at) => { const d = new Date(at); return 'agmessage-audit-' + nodeId + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); };

/** The SHA-256 of a buffer's first `length` bytes, a slice at a time, so a 20 MB file never holds the loop for long. */
async function digest(buf, length) {
  const h = crypto.createHash('sha256');
  for (let at = 0; at < length; at += SLICE) {
    h.update(buf.subarray(at, Math.min(length, at + SLICE)));
    if (at + SLICE < length) await turn();
  }
  return h.digest('hex');
}
/** The seq of the first and the last whole line in a buffer's first `length` bytes (0 when none). */
function seqRange(buf, length) {
  const lineAt = (start, end) => { const m = LINE_SEQ.exec(buf.toString('utf8', start, Math.min(end, start + 40))); return m ? Number(m[1]) : 0; };
  if (!length) return { first: 0, last: 0 };
  const firstEnd = buf.indexOf(10);
  const lastStart = length > 1 ? buf.lastIndexOf(10, length - 2) + 1 : 0;
  return { first: lineAt(0, firstEnd < 0 ? length : firstEnd), last: lineAt(lastStart, length) };
}
/** Where `line` (a whole line, its line end included) starts in `buf` at the start of a line, or -1. */
function lineAt(buf, line) {
  for (let at = buf.indexOf(line); at >= 0; at = buf.indexOf(line, at + 1)) if (at === 0 || buf[at - 1] === 10) return at;
  return -1;
}
/** A file's whole content through its handle, from byte 0 (never from the handle's position). */
async function readAll(fh) {
  const { size: n } = await fh.stat();
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === n ? buf : buf.subarray(0, got);
}

/** The README a bundle carries: how to check it, and what it proves and does not (H.9.6), in those words. */
function readme(version) {
  return [
    'AGMessage audit export',
    '======================',
    '',
    'This folder is the whole audit log of one AGMessage laptop, as it stood when it was exported, signed with that',
    'laptop\'s signing key. It holds names, addresses and what each person did; older entries can also hold the first words',
    'of messages shown on screens and the names of files shown there. Give it only to whoever checks it.',
    '',
    'How to check it',
    '---------------',
    '1. Compare the signing key with YOUR OWN record of the laptop\'s key: the show\'s paperwork, or Admin -> Health read in',
    '   person at the laptop. Never take the key from this folder. A mismatch ends the check: nothing here is vouched for.',
    '2. Check it with the verifier from the AGMessage release that manifest.json names (agmessage-audit-verifier-<version>.zip',
    '   from the release page, its digest checked against that release\'s SHA256SUMS), not with the copy in verify/, which',
    '   came from the laptop under check:',
    '     node verify-audit.js <this folder> --fingerprint <the 64 characters of your record>',
    '   or open verify.html in Chrome, Edge (137 or newer), Firefox (129) or Safari (17), type the key and choose this folder.',
    '   Exit 0: signed by that key and whole, and the laptop said intact. 1: the same, and the laptop said linked or not',
    '   vouched for: read its findings. 2: the same, and the laptop said broken (or every file is what was signed and the',
    '   entries break where the laptop\'s own check said they do). 3: something failed, or another key: nothing here is',
    '   vouched for. 4: no key was given to compare with.',
    '   To compare with an earlier export you kept off the laptop: --earlier <its folder>.',
    '   Check it before browsing this folder: a file the export does not list ends the check (exit 3), and some desktops',
    '   add their own (macOS Finder writes .DS_Store). Remove such a file, or extract the zip again.',
    '3. Or by hand, in this folder (OpenSSL 3; on Windows, certutil -hashfile <file> SHA256 gives the digests):',
    '     openssl pkey -pubin -in signing-key.pem -outform DER | sha256sum        # 1. compare with YOUR record of the key',
    '     openssl pkeyutl -verify -pubin -inkey signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig',
    '     sha256sum -c SHA256SUMS',
    '',
    'What it proves, once the key matches your record and the signature and the files check',
    '--------------------------------------------------------------------------------------',
    '- Every file in log/ is byte for byte what this laptop\'s AGMessage exported when the manifest says, and nothing was',
    '  added, removed or changed since (the signature over SHA256SUMS, and the digests).',
    '- The laptop\'s own keyed check, run for this export through its own entry, said what manifest.json\'s "check" says,',
    '  with those findings (the manifest is a signed file).',
    '- Each line is a whole entry, the entries run without a gap, each links to the one before, the plain-hash entries\'',
    '  hashes hold, and keys change only at named boundaries (the verifier checks this with no key).',
    '- Who exported, and when by the laptop\'s clock (the last entry, and the manifest).',
    '- With an earlier export kept elsewhere: the entries it held were not rewritten since, even by the key\'s holder.',
    '',
    'What it cannot prove',
    '--------------------',
    '- That each keyed entry\'s MAC is right: the key never leaves the laptop; this rests on the laptop\'s signed verdict.',
    '- Anything about someone who can change AGMessage\'s code or start script on the laptop, controls its Windows account,',
    '  or holds a copy of its machine key: they can write entries that check and sign an export of them. The signature',
    '  proves "this key", not "this person", nor that the words are true.',
    '- When an entry was really written: the times are the laptop\'s clock.',
    '- That the log is complete after the export, or that nothing was removed while AGMessage was stopped: only the',
    '  laptop\'s records see that, and they are reported in its verdict.',
    '- That the key is this laptop\'s: only your own record of it shows that.',
    '- That entries keyed elsewhere, or the plain-hash entries, are genuine: they are linked, not checked; the verdict',
    '  names who accepted them and when.',
    '',
    'Made by AGMessage ' + version + '.',
    '',
  ].join('\n');
}

class Exporter {
  /**
   * @param o `audit`: the AuditLog; `signingKey()`: this machine's {privateKey, publicKey, fingerprint}, derived when
   *   called (throws when this run has none); `node()`: {id, name, version, build}; `verifyDir`: the folder of the
   *   verifier's files (app/verify); `version`: the page's words.
   */
  constructor({ audit, signingKey, node, verifyDir, version }) {
    this.audit = audit;
    this.signingKey = signingKey;
    this.node = node;
    this.verifyDir = verifyDir;
    this.version = version;
    this.slot = null;      // the export running now: {by, since}
    this.handles = [];     // its open files, closed whatever happens
    this.kit = null;       // the verifier's files, read once: [[path, Buffer]]
  }

  /** The export running now, or null: who it is for, and since when. */
  busy() { return this.slot ? { ...this.slot } : null; }

  /** The verifier's three files as the bundle carries them; throws, naming the file, when this copy has no verifier. */
  async _kit() {
    if (this.kit) return this.kit;
    const own = (name) => fs.promises.readFile(path.join(this.verifyDir, name)).catch((e) => { throw new Error('this copy has no verifier to ship (' + path.join('app', 'verify', name) + ': ' + (e.code || e.message) + ')'); });
    const page = verifier.assemblePage({ html: (await own('page.html')).toString('utf8'), css: (await own('page.css')).toString('utf8'), rules: (await own('auditrules.js')).toString('utf8'), js: (await own('page.js')).toString('utf8'), version: this.version });
    this.kit = [['verify/verify-audit.js', await own('verify-audit.js')], ['verify/auditrules.js', await own('auditrules.js')], ['verify/verify.html', Buffer.from(page, 'utf8')]];
    return this.kit;
  }

  async _closeAll() {
    const all = this.handles.splice(0);
    await Promise.all(all.map((h) => h.fh.close().catch(() => null)));   // a handle that will not close is gone with its file
  }

  /**
   * The chain's files up to the one that holds the export's own entry (`rowText`, its whole line), listed once and
   * opened; listed and opened again while a rotation moved them meanwhile (at most three tries). `since` is the rotation
   * count just after that entry was written: a listing taken with no rotation since holds it in its last file; after
   * one, it is in the newest file that holds it as a whole line, and the files after that hold only later entries.
   */
  async _open(rowText, since) {
    for (let tries = 1; ; tries++) {
      const before = this.audit.rotations;
      let moved = false;
      for (const p of this.audit.files()) {
        try { this.handles.push({ name: path.basename(p), fh: await fs.promises.open(p, 'r') }); } catch (e) {
          // A file renamed between the listing and its open is a rotation's: list again. Anything else is an error.
          if (this.audit.rotations === before) throw new Error(path.basename(p) + ' could not be opened (' + (e.code || e.message) + ')', { cause: e });
          moved = true;
          break;
        }
      }
      if (!moved && this.audit.rotations === before) {
        if (before !== since) await this._cutAt(rowText);
        return;
      }
      await this._closeAll();
      if (tries >= MAX_OPEN_TRIES) throw new Error('the log rotated while the export started: try again');
    }
  }

  /** Keep the files up to the newest that holds `rowText` as a whole line, closing those after it; throws when none does. */
  async _cutAt(rowText) {
    for (let i = this.handles.length - 1; i >= 0; i--) {
      if (lineAt(await readAll(this.handles[i].fh), rowText) < 0) continue;
      const after = this.handles.splice(i + 1);
      await Promise.all(after.map((h) => h.fh.close().catch(() => null)));   // a handle that will not close is gone with its file
      return;
    }
    throw new Error('its own entry is in none of the log\'s files');
  }

  /**
   * Make the export and stream it to `res` (an Express response): `actor` is who exports ({t, id, name}), `ip` from where.
   * The caller has decided they may. Resolves once the response is answered, sent whole, or ended part way.
   */
  async run(res, actor, ip) {
    res.setHeader('Cache-Control', 'no-store');
    const audit = this.audit;
    audit.open();   // the boundary a first write would add comes first, so the row's range is the log's as it stands
    if (audit.keyless) return res.status(503).json({ ok: false, error: 'not exported: this run has no machine key (' + audit.keyless.code + '), so an export cannot be signed' });
    if (this.slot) return res.status(409).json({ ok: false, error: 'an export is being made for ' + this.slot.by + ' since ' + hhmm(this.slot.since) + ': try again when it ends' });
    this.slot = { by: actor.name || actor.t, since: Date.now() };
    let row = null;
    let ended = false;
    /** The export's end, said once: `audit.export.sent` or `audit.export.fail`, then the handles closed and the slot freed. */
    const end = async (sent, words) => {
      if (ended) return;
      ended = true;
      if (row) audit.write(actor, sent ? 'audit.export.sent' : 'audit.export.fail', '1-' + row.seq, words, ip);
      // The handles are taken off the list now, so the slot is free with the row: the next export opens its own.
      const closing = this._closeAll();
      this.slot = null;
      await closing;
    };
    try {
      let kit;
      let key;
      try {
        kit = await this._kit();
        key = this.signingKey();
      } catch (e) {
        await end(false, '');
        return res.status(503).json({ ok: false, error: 'not exported: ' + e.message });
      }
      // 2. Its own entry, on disk before anything else.
      const fp = key.fingerprint;
      const to = audit.seq + 1;
      const what = range(1, to);
      row = audit.write(actor, 'audit.export', '1-' + to + ';' + fp.slice(0, 16), 'export started, for checking on another computer: ' + what + ', the whole log, this entry its last; signed with key ' + grouped(fp.slice(0, 16)), ip);
      const since = audit.rotations;   // a rotation the write made is before the entry: the entry is in the file after it
      if (audit.onDisk.seq < row.seq) {
        await end(false, 'the export of ' + what + ' was not made: the log would not take its own entry (' + (audit.lastCode || 'EIO') + ')');
        return res.status(503).json({ ok: false, error: 'not exported: the log would not take the export\'s own entry (' + (audit.lastCode || 'EIO') + ')' });
      }
      const fail = async (status, why) => {
        await end(false, 'the export of ' + what + ' was not made: ' + why);
        if (!res.headersSent && !res.destroyed) res.status(status).json({ ok: false, error: 'not exported: ' + why });
      };
      // 3. The files, listed once and opened, up to the one that holds the export's own entry; 4. the check through
      // them, each file's length and digest with it.
      const rowText = Buffer.from(JSON.stringify(row) + '\n');
      try { await this._open(rowText, since); } catch (e) { return fail(409, e.message); }
      const files = [];
      const load = async (i) => {
        const h = this.handles[i];
        const buf = await readAll(h.fh);
        let length = buf.length;
        if (i === this.handles.length - 1) {
          const at = lineAt(buf, rowText);
          if (at < 0) throw new Error('its own entry is not in ' + h.name);
          length = at + rowText.length;
        }
        files[i] = { path: 'log/' + h.name, bytes: length, sha256: await digest(buf, length), ...seqRange(buf, length) };
        return buf.subarray(0, length);
      };
      const handles = this.handles;
      async function* source() { for (let i = 0; i < handles.length; i++) yield { name: handles[i].name, buf: await load(i) }; }
      let check;
      try {
        check = await audit.checkThrough(source(), { seq: row.seq, h: row.h });
        // A check that broke early read only some files: the rest are taken now, for their lengths and digests.
        for (let i = 0; i < handles.length; i++) if (!files[i]) await load(i);
      } catch (e) { return fail(500, 'the log could not be read (' + (e.code || e.message) + ')'); }
      const total = files.reduce((n, f) => n + f.bytes, 0) + kit.reduce((n, [, b]) => n + b.length, 0);
      if (!fits(total, files.length + kit.length + 5)) return fail(413, 'the log is over 4 GB, and an export writes no Zip64');

      // 5. The headers say the verdict before the body.
      const name = bundleName(this.node().id, row.at);
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '.zip"');
      res.setHeader('X-AGM-Export', 'entries=1-' + row.seq + '; mark=' + check.mark + '; key=' + fp.slice(0, 16));
      res.on('close', () => { if (!res.writableFinished) end(false, 'the export of ' + what + ' was not sent whole: the browser went away'); });
      const zip = new ZipStream(res, { at: row.at });
      try {
        // 6. Each file from its handle, its digest taken again as it passes.
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const h = crypto.createHash('sha256');
          const chunks = f.bytes ? this.handles[i].fh.createReadStream({ start: 0, end: f.bytes - 1, autoClose: false, highWaterMark: CHUNK }) : [];
          await zip.add(name + '/' + f.path, chunks, { onChunk: (c) => h.update(c) });
          if (h.digest('hex') !== f.sha256) throw new Error('a file changed while it was exported (' + f.path + ')');
        }
        // 7. The manifest, SHA256SUMS and its signature, the public key, the README and the verifier.
        const node = this.node();
        const answer = { mark: check.mark, words: check.words, findings: check.findings, head: check.head };
        if (check.why) Object.assign(answer, { brokenAt: check.brokenAt, file: check.file, why: check.why });
        const manifest = {
          kind: 'agmessage audit export', v: 1, made: row.at, by: { ...row.actor },
          node: { id: node.id, name: node.name, version: node.version, build: node.build },
          log: row.l, kid: row.k, signingKey: { alg: 'Ed25519', fingerprint: fp },
          entries: { from: 1, to: row.seq }, head: { seq: row.seq, h: row.h }, check: answer,
          files: files.map((f) => ({ path: f.path, bytes: f.bytes, first: f.first, last: f.last })),
        };
        const rest = [
          ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
          ['signing-key.pem', Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' }))],
          ['README.txt', Buffer.from(readme(this.version))],
          ...kit,
        ];
        const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
        const sums = Buffer.from([...files.map((f) => f.sha256 + '  ' + f.path), ...rest.map(([p, b]) => sha(b) + '  ' + p)].join('\n') + '\n');
        // The private key was derived for this export and goes with it: nothing keeps it.
        const sig = crypto.sign(null, sums, key.privateKey);
        const [mf, pem, rd, ...verify] = rest;
        for (const [p, b] of [mf, ['SHA256SUMS', sums], ['SHA256SUMS.sig', sig], pem, rd, ...verify]) await zip.add(name + '/' + p, [b]);
        const z = await zip.end();
        // 8. Sent: the last byte handed to the system (not that the browser saved it), and the zip's digest in the log.
        await new Promise((resolve) => {
          res.once('finish', resolve);
          res.once('close', resolve);
          res.end();
        });
        if (res.writableFinished) await end(true, 'export sent whole: ' + what + ', ' + size(z.bytes) + '; the zip\'s SHA-256 is ' + z.sha256);
      } catch (e) {
        // 9. Part way: the download is cut short (no end record), and the log says why.
        res.destroy();
        await end(false, 'the export of ' + what + ' was not sent whole: ' + (e.gone ? 'the browser went away' : e.message));
      }
      return undefined;
    } finally {
      if (!ended && !res.headersSent) await end(false, 'the export of entries 1–' + (row ? row.seq : '?') + ' was not made');
    }
  }
}

module.exports = { Exporter, bundleName, readme };
