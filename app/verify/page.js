// The browser verifier (verify.html, H.9.5): the Node verifier's checks, in a page opened from disk that loads nothing
// and sends nothing (its meta Content-Security-Policy allows only its own two inline scripts and its style). The folder
// is chosen or dropped; the expected key is typed from the auditor's own record. The steps, in order: the folder (only
// the bundle's fixed paths), the key, the signature over SHA256SUMS (WebCrypto Ed25519), every file against it, the
// entries (whole lines, links, the legacy hashes, the runs, the last entry the export's own); then the laptop's own
// verdict, and the entries to read. Nothing of the entries is drawn before those steps pass, and only ever as text.
// The five states are the Node verifier's exit codes: 0 ✓, 1 ◇ or △, 2 ✕, 3 nothing vouched for, 4 not compared.
(function () {
  'use strict';
  const R = globalThis.AGMAuditRules;
  const $ = (id) => document.getElementById(id);
  const dec = new TextDecoder('utf-8');
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const sha = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
  const grouped = (fp) => String(fp).match(/.{1,4}/g).join(' ');
  const shortKey = (fp) => grouped(String(fp).slice(0, 16)) + ' …';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const whenUtc = (at) => { const d = new Date(at); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC on ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const dayUtc = (at) => { const d = new Date(at); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  const range = (a, b) => (a === b ? 'entry ' + a : 'entries ' + a + '–' + b);
  const MARK = { intact: '✓', linked: '◇', unvouched: '△', broken: '✕' };
  const PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]{40,200})\n-----END PUBLIC KEY-----\n?$/;
  const PAGE = 500;

  class Refused extends Error {}
  const refuse = (why) => { throw new Refused(why); };
  const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  /** The last line of a file that ends with a line end, without it ('' when it is over 64 KB). */
  const lastLine = (buf) => {
    if (!buf.length) return '';
    const start = buf.lastIndexOf(10, buf.length - 2) + 1;
    return buf.length - 1 - start > R.MAX_LINE ? '' : dec.decode(buf.subarray(start, buf.length - 1));
  };

  /**
   * Check a bundle given as a Map of its relative paths to File objects: the Node verifier's check, step for step.
   * Resolves {code, why?, said, m?, fp?, entries?, spans?, accepts?, texts?}.
   */
  async function check(files, { fingerprint = '', keep = false, against = null } = {}) {
    const said = [];
    let m = null;
    let fp = '';
    let walked = null;    // where the entries' walk stopped (set only inside step 4): {file index, line}
    let tailOwn = false;  // the bundle's last line is the export's own entry (step 3)
    try {
      const listed = new Map();
      const read = async (rel) => { const f = files.get(rel); if (!f) refuse(rel + ' is not in the folder'); return bytesOf(f); };
      // 0. The folder: SHA256SUMS's paths and the manifest's, each of the set, before anything else is read.
      const sumsBytes = await read('SHA256SUMS');
      const sums = R.parseSums(dec.decode(sumsBytes));
      if (sums.why) refuse(sums.why);
      for (const s of sums.list) listed.set(s.path, s.digest);
      if (!listed.has('manifest.json') || !listed.has('signing-key.pem')) refuse('SHA256SUMS does not list manifest.json and signing-key.pem');
      try { m = JSON.parse(dec.decode(await read('manifest.json'))); } catch (e) { if (e instanceof Refused) throw e; refuse('manifest.json is not JSON'); }
      const shape = R.manifestProblem(m);
      if (shape) refuse(shape);
      for (const f of m.files) { const why = R.pathProblem(f.path); if (why) refuse('manifest.json names ' + why); }
      const logs = m.files.map((f) => f.path);
      if (new Set(logs).size !== logs.length) refuse('manifest.json lists a log file twice');
      for (const p of logs) if (!listed.has(p)) refuse('SHA256SUMS does not list ' + p + ', which manifest.json names');
      for (const p of listed.keys()) if (R.isLogPath(p) && !logs.includes(p)) refuse('SHA256SUMS lists ' + p + ', which manifest.json does not name');
      const extra = Array.from(files.keys()).filter((p) => !listed.has(p) && p !== 'SHA256SUMS' && p !== 'SHA256SUMS.sig');
      if (extra.length) refuse(extra.slice(0, 20).map((p) => p + ' is not part of the export').join('; ') + ' (not read)');

      // 1. The key.
      const pem = PEM.exec(dec.decode(await read('signing-key.pem')));
      if (!pem) refuse('signing-key.pem is not a public key in PEM');
      const der = fromBase64(pem[1].replace(/\n/g, ''));
      let key;
      try { key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, true, ['verify']); } catch { refuse('signing-key.pem is not an Ed25519 public key (or this browser cannot check one: Chrome or Edge 137, Firefox 129, Safari 17 or newer)'); }
      if (!same(new Uint8Array(await crypto.subtle.exportKey('spki', key)), der)) refuse('signing-key.pem is not an Ed25519 public key');
      fp = await sha(der);
      if (fp !== m.signingKey.fingerprint) refuse('manifest.json names key ' + shortKey(m.signingKey.fingerprint) + ', and signing-key.pem is key ' + shortKey(fp));
      if (fingerprint && fp !== fingerprint) refuse('signed by key ' + shortKey(fp) + ', not the key you expected (' + shortKey(fingerprint) + ')');

      // 2. The signature over SHA256SUMS's exact bytes.
      const sig = await read('SHA256SUMS.sig');
      if (sig.length !== 64 || !(await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, sumsBytes))) refuse('the signature over SHA256SUMS does not check against signing-key.pem');
      said.push('✓ signed by key ' + grouped(fp) + (fingerprint ? ', the key you expected' : ''));

      // 3. Every listed file against its digest, the log's included, before any entry is read. Each log file is also the
      // size the manifest gives and ends with a whole line; the last one's last line is kept, to be the export's own entry.
      const described = new Map(m.files.map((f) => [f.path, f]));
      const lastPath = m.files[m.files.length - 1].path;
      let tail = null;
      for (const [p, digest] of listed) {
        const buf = await read(p);
        if ((await sha(buf)) !== digest) refuse(p + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
        const f = described.get(p);
        if (f && buf.length !== f.bytes) refuse(p + ' is ' + buf.length + ' bytes; manifest.json says ' + f.bytes);
        if (f && buf.length && buf[buf.length - 1] !== 10) refuse('the last line of ' + p + ' is not whole');
        if (p === lastPath) tail = R.wholeEntry(lastLine(buf));
      }
      const target = m.entries.from + '-' + m.entries.to + ';' + m.signingKey.fingerprint.slice(0, 16);
      /** The export's own entry: the last of the bundle, the head and the range manifest.json names. */
      const own = (e) => !!e && e.action === 'audit.export' && e.k === m.kid && e.l === m.log && e.seq === m.entries.to && e.seq === m.head.seq && e.h === m.head.h && e.target === target;
      tailOwn = own(tail);

      // 4. The entries, file by file in chain order, each file read again against its digest.
      const chain = new R.Chain(m.kid);
      const entries = [];
      const texts = keep ? new Map() : null;
      let last = null;
      for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        const buf = await read(f.path);
        if ((await sha(buf)) !== listed.get(f.path)) refuse(f.path + ' is not what was signed: its SHA-256 differs from SHA256SUMS');
        let start = 0;
        let line = 0;
        let first = 0;
        let lastHere = 0;
        while (start < buf.length) {
          const nl = buf.indexOf(10, start);
          line++;
          walked = { file: i, line };
          if (nl - start > R.MAX_LINE) refuse('line ' + line + ' of ' + f.path + ' is over 64 KB');
          const text = dec.decode(buf.subarray(start, nl));
          start = nl + 1;
          const e = R.wholeEntry(text);
          if (!e) refuse('line ' + line + ' of ' + f.path + ' is not a whole entry');
          if (!e.k && (await sha(enc.encode(R.canonical(e)))) !== e.h) refuse('entry ' + e.seq + ' (line ' + line + ' of ' + f.path + ') was changed after it was written');
          const why = chain.next(e);
          if (why) refuse(why + ' (line ' + line + ' of ' + f.path + ')');
          walked = null;
          lastHere = e.seq;
          if (against && against.texts.has(e.seq) && against.texts.get(e.seq) !== text) {
            refuse('entry ' + e.seq + ' is not the same in the two exports: the log was written again between ' + dayUtc(against.made) + ' and ' + dayUtc(m.made));
          }
          if (!first) first = e.seq;
          last = e;
          entries.push(e);
          if (texts) texts.set(e.seq, text);
        }
        if (first !== f.first || lastHere !== f.last) refuse(f.path + ' holds ' + range(first, lastHere) + '; manifest.json says ' + range(f.first, f.last));
      }
      const open = chain.end();
      if (open) refuse(open);
      if (!own(last)) refuse('the last entry is not the export\'s own (audit.export, ' + target + ', the head manifest.json names)');
      if (m.entries.from !== 1 || m.files[0].first !== 1) refuse('the entries do not begin at entry 1');
      if (against) {
        if (against.log !== m.log) refuse('the two exports are of different logs');
        const beyond = Array.from(against.texts.keys()).filter((s) => s > last.seq);
        if (beyond.length) refuse(range(beyond[0], beyond[beyond.length - 1]) + ' of the earlier export are not in this one');
        said.push('✓ the same: ' + range(1, against.texts.size) + ' of the earlier export (made ' + whenUtc(against.made) + ') are in this one, byte for byte');
        if (against.fp !== fp) said.push('△ signed by another key than the earlier export: the laptop\'s machine key changed between them, or they come from two laptops');
      }
      said.push('✓ whole: ' + range(m.entries.from, m.entries.to) + ' in ' + m.files.length + ' file' + (m.files.length === 1 ? '' : 's') + ', every line whole and linked to the one before, the plain hashes holding, the key changing only at a named boundary, and the last entry the export\'s own');
      for (const s of chain.spans) {
        const a = chain.accepts.get('s' + s.from + '-' + s.to);
        const what = s.runs.map((r) => (r.kind === 'plain' ? range(r.from, r.to) + ' with plain hashes' : range(r.from, r.to) + ' under key id ' + r.kind.slice(0, 4) + '… (their own claim)')).join(', ');
        said.push((a ? '◇ ' : '△ ') + what + ': ' + (a ? 'accepted on the AGMessage laptop by entry ' + a.seq + ' (' + dayUtc(a.at) + ')' : 'not accepted on the laptop'));
      }
      return { code: fingerprint ? R.codeFor(m.check.mark) : 4, said, m, fp, entries, spans: chain.spans, accepts: chain.accepts, texts };
    } catch (e) {
      if (!(e instanceof Refused)) return { code: 3, why: 'the check could not finish: ' + (e && e.message ? e.message : String(e)), said, m, fp };
      // The entries break at or after the line the laptop's own check named. `walked` is set only inside step 4's walk,
      // so steps 0-3 passed: the key, the signature and every file's digest. With the last entry the export's own, the
      // bundle is what was exported, and the log was broken then (2). Anywhere else, the bundle disagrees with itself (3).
      if (walked && m.check.mark === 'broken' && (!fingerprint || fp === fingerprint) && tailOwn && m.entries.from === 1 && m.files[0].first === 1) {
        const at = m.files.findIndex((f) => f.path === 'log/' + m.check.file);
        if (at >= 0 && Number.isSafeInteger(m.check.brokenAt) && (at < walked.file || (at === walked.file && m.check.brokenAt <= walked.line))) {
          said.push('✓ every file is what was signed: each matches its SHA-256 in SHA256SUMS, and the last entry is the export\'s own');
          said.push('✕ the entries break where the laptop\'s own check said they do: ' + e.message);
          return { code: fingerprint ? 2 : 4, said, m, fp, broken: e.message };
        }
      }
      return { code: 3, why: e.message, said, m, fp };
    }
  }

  // ---------------------------------------------------------------- the folder, chosen or dropped
  /** A chosen folder's files by their path inside it (its own name taken off). */
  function fromInput(input) {
    const out = new Map();
    for (const f of input.files) {
      const parts = (f.webkitRelativePath || f.name).split('/');
      out.set(parts.length > 1 ? parts.slice(1).join('/') : parts[0], f);
    }
    return out;
  }
  /** A dropped folder's files by their path inside it. */
  async function fromDrop(entry) {
    const out = new Map();
    const walk = async (dir, rel, depth) => {
      const reader = dir.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => { reader.readEntries(resolve, reject); });
        if (!batch.length) return;
        for (const x of batch) {
          const p = rel ? rel + '/' + x.name : x.name;
          if (x.isDirectory && depth < 4) await walk(x, p, depth + 1);
          else if (x.isFile) out.set(p, await new Promise((resolve, reject) => { x.file(resolve, reject); }));
          if (out.size > 2000) return;
        }
      }
    };
    await walk(entry, '', 0);
    return out;
  }

  // ---------------------------------------------------------------- what the page says
  let bundle = null;    // the chosen export: Map path -> File
  let earlier = null;   // an earlier export to compare with
  let shown = null;     // the last answer: its entries, for the pages of the table
  let page = 0;
  let run = 0;          // the newest check: an older one that ends after it says nothing

  const STATE = {
    0: '✓ Signed by the key you expected and whole; the laptop said ✓.',
    1: 'Signed by the key you expected and whole; the laptop said ◇ or △: read its findings below.',
    2: '✕ Signed by the key you expected and whole; the laptop said ✕: the log was broken when it was exported.',
    broken: '✕ Signed by the key you expected, and every file is what was exported; the entries break where the laptop\'s own check said they do: the log was broken when it was exported.',
    3: '✕ Nothing in the bundle is vouched for: ',
    4: 'Whole and signed consistently, but not compared with a record of the laptop\'s key: not shown to be the laptop\'s. Type the key from your own record.',
    brokenUncompared: 'Every file signed consistently, its entries breaking where its own check says they do, but not compared with a record of the laptop\'s key: not shown to be the laptop\'s. Type the key from your own record.',
  };

  function list(ul, lines) {
    ul.textContent = '';
    for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
  }

  function draw(r) {
    $('state').dataset.code = String(r.code);
    $('state').textContent = r.code === 3 ? STATE[3] + r.why : r.broken ? (r.code === 2 ? STATE.broken : STATE.brokenUncompared) : STATE[r.code];
    list($('said'), r.said);
    const passed = r.code !== 3 && r.entries;
    $('verdict').hidden = !r.m || r.code === 3;
    if (!$('verdict').hidden) {
      $('verdictHead').textContent = (r.code === 4 ? 'The bundle\'s own claim (not shown to be the laptop\'s)' : 'The laptop\'s own check') + ', run for this export through its own entry: made ' + whenUtc(r.m.made) + ', by ' + (r.m.by.name || r.m.by.t) + ', AGMessage ' + r.m.node.version;
      $('verdictWords').textContent = (MARK[r.m.check.mark] || '✕') + ' ' + r.m.check.words;
      list($('findings'), r.m.check.findings.filter((f) => f && typeof f.words === 'string').map((f) => (MARK[f.mark] || '✕') + ' ' + f.words));
    }
    shown = passed ? r : null;
    page = 0;
    drawRows();
  }

  function drawRows() {
    $('entriesBox').hidden = !shown;
    const tb = $('rows');
    tb.textContent = '';
    if (!shown) return;
    const all = shown.entries;
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    $('pageNo').textContent = 'Page ' + (page + 1) + ' of ' + pages + ' (' + all.length + ' entries, newest first)';
    $('prev').disabled = page === 0;
    $('next').disabled = page >= pages - 1;
    const markOf = (seq) => {
      const s = shown.spans.find((x) => seq >= x.from && seq <= x.to);
      return s ? (shown.accepts.has('s' + s.from + '-' + s.to) ? '◇' : '△') : '';
    };
    const end = all.length - page * PAGE;
    for (let i = end - 1; i >= Math.max(0, end - PAGE); i--) {
      const e = all[i];
      const tr = document.createElement('tr');
      for (const v of [String(e.seq), new Date(e.at).toISOString(), markOf(e.seq), e.actor.name || e.actor.t, e.action, e.target, e.words]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
  }

  async function recheck() {
    const mine = ++run;
    if (!bundle) return;
    const typed = $('fp').value.replace(/[\s:]/g, '').toLowerCase();
    if (typed && !/^[0-9a-f]{64}$/.test(typed)) {
      $('state').dataset.code = '';
      $('state').textContent = 'The signing key is 64 characters, 0-9 and a-f (spaces are fine): ' + typed.length + ' typed.';
      return;
    }
    $('state').dataset.code = '';
    $('state').textContent = 'Checking…';
    let fingerprint = typed;
    let against = null;
    const lead = [];
    if (earlier) {
      const before = await check(earlier, { keep: true });
      if (mine !== run) return;
      // Both must pass steps 0-4: an earlier export whose entries break holds no entries to compare with.
      if (before.code === 3 || !before.texts) { draw({ code: 3, why: 'the earlier export does not check: ' + (before.code === 3 ? before.why : 'its entries break where its laptop\'s own check said they do (' + before.broken + '), so they cannot be compared'), said: [] }); return; }
      if (!fingerprint) { fingerprint = before.fp; lead.push('The key you expect is taken from the earlier export (' + grouped(before.fp) + '): it must be one you kept off the laptop.'); }
      against = { texts: before.texts, log: before.m.log, made: before.m.made, fp: before.fp };
    }
    const r = await check(bundle, { fingerprint, against });
    if (mine !== run) return;
    r.said = lead.concat(r.said);
    draw(r);
  }

  $('folder').addEventListener('change', () => { bundle = fromInput($('folder')); recheck(); });
  $('earlier').addEventListener('change', () => { earlier = $('earlier').files.length ? fromInput($('earlier')) : null; recheck(); });
  $('fp').addEventListener('input', () => { recheck(); });
  $('prev').addEventListener('click', () => { page--; drawRows(); });
  $('next').addEventListener('click', () => { page++; drawRows(); });
  document.addEventListener('dragover', (ev) => { ev.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', () => { document.body.classList.remove('dropping'); });
  document.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    document.body.classList.remove('dropping');
    const item = ev.dataTransfer && ev.dataTransfer.items && ev.dataTransfer.items[0];
    const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (!entry || !entry.isDirectory) { $('state').dataset.code = ''; $('state').textContent = 'Drop the extracted folder itself (Extract All first), not a file or the zip.'; return; }
    bundle = await fromDrop(entry);
    recheck();
  });
})();
