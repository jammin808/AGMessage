// The browser verifier (verify.html, H.9.5): the Node verifier's checks, in a page opened from disk that loads nothing
// and sends nothing (its meta Content-Security-Policy allows only its own two inline scripts and its style). The folder
// (an export's, or an archive's alone) is chosen or dropped; the expected key is typed from the auditor's own record. The
// steps, in order, are the rules file's own: the folder (only its fixed paths), the key, the signature over SHA256SUMS
// (WebCrypto Ed25519), every file against it, each archive the bundle carries, the entries as one chain (whole lines,
// links, the legacy hashes, the runs, the last entry the export's own); then the laptop's own verdict, and the entries to
// read. Nothing of the entries is drawn before those steps pass, and only ever as text. The five states are the Node
// verifier's exit codes: 0 ✓, 1 ◇ or △, 2 ✕, 3 nothing vouched for, 4 not compared.
(function () {
  'use strict';
  const R = globalThis.AGMAuditRules;
  const $ = (id) => document.getElementById(id);
  const dec = new TextDecoder('utf-8');
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const sha = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
  const { grouped, whenUtc, dayUtc } = R;
  const MARK = { intact: '✓', linked: '◇', unvouched: '△', broken: '✕' };
  const PAGE = 500;

  const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const refuse = (why) => { throw new R.Refused(why); };

  /**
   * Check a folder given as a Map of its relative paths to File objects: an export, or an archive's folder alone. The
   * checks are the rules file's own (`verifyFolder`), the Node verifier's too; this hands it the folder as the page reads
   * it, and WebCrypto. Resolves {code, kind, why?, said, m?, fp?, entries?, spans?, accepts?, texts?}.
   */
  async function check(files, { fingerprint = '', keep = false, against = null } = {}) {
    const io = {
      read: async (rel) => { const f = files.get(rel); if (!f) refuse(rel + ' is not in the folder'); return bytesOf(f); },
      unlisted: async (isListed) => Array.from(files.keys()).filter((p) => !isListed(p)),
      sha256: sha,
      async publicKey(der, file) {
        let key;
        try { key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, true, ['verify']); } catch { refuse(file + ' is not an Ed25519 public key (or this browser cannot check one: Chrome or Edge 137, Firefox 129, Safari 17 or newer)'); }
        if (!same(new Uint8Array(await crypto.subtle.exportKey('spki', key)), der)) refuse(file + ' is not an Ed25519 public key');
        return key;
      },
      verify: (key, sig, data) => crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data),
      text: (b) => dec.decode(b),
      bytes: (t) => enc.encode(t),
      base64: fromBase64,
    };
    try {
      return await R.verifyFolder(io, { fingerprint, list: true, keep, against });
    } catch (e) {
      return { code: 3, kind: 'export', why: 'the check could not finish: ' + (e && e.message ? e.message : String(e)), said: [], m: null, fp: '' };
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
    archive0: '✓ Signed by the key you expected and whole; the laptop said ✓ when it split this archive off.',
    archive1: 'Signed by the key you expected and whole; the laptop said ◇ when it split this archive off: read its findings below.',
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
    const archive = r.kind === 'archive';
    $('state').textContent = r.code === 3 ? STATE[3] + r.why : r.broken ? (r.code === 2 ? STATE.broken : STATE.brokenUncompared) : (archive && STATE['archive' + r.code]) || STATE[r.code];
    list($('said'), r.said);
    const passed = r.code !== 3 && r.entries;
    $('verdict').hidden = !r.m || r.code === 3;
    if (!$('verdict').hidden) {
      $('verdictHead').textContent = (r.code === 4 ? 'The ' + (archive ? 'archive' : 'bundle') + '\'s own claim (not shown to be the laptop\'s)' : 'The laptop\'s own check') + (archive ? ', run when it split this archive off: made ' : ', run for this export through its own entry: made ') + whenUtc(r.m.made) + ', by ' + (r.m.by.name || r.m.by.t) + ', AGMessage ' + r.m.node.version;
      $('verdictWords').textContent = (MARK[r.m.check.mark] || '✕') + ' ' + r.m.check.words;
      // An archive's findings are each closed, and name the accept that closed it (which may lie after its point).
      list($('findings'), r.m.check.findings.filter((f) => f && typeof f.words === 'string').map((f) => (archive ? '◇ ' + f.words + ' (accepted by entry ' + f.accept.seq + ' on ' + dayUtc(f.accept.at) + ')' : (MARK[f.mark] || '✕') + ' ' + f.words)));
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
    const closed = shown.kind === 'archive' ? shown.m.check.findings.map((f) => f.id) : [];
    const markOf = (seq) => {
      const s = shown.spans.find((x) => seq >= x.from && seq <= x.to);
      const id = s ? 's' + s.from + '-' + s.to : '';
      return s ? (shown.accepts.has(id) || closed.includes(id) ? '◇' : '△') : '';
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
      if (before.code === 3 || !before.texts || before.kind === 'archive') { draw({ code: 3, why: 'the earlier export does not check: ' + (before.code === 3 ? before.why : before.kind === 'archive' ? 'it is an archive\'s folder, not an export' : 'its entries break where its laptop\'s own check said they do (' + before.broken + '), so they cannot be compared'), said: [] }); return; }
      if (!fingerprint) { fingerprint = before.fp; lead.push('The key you expect is taken from the earlier export (' + grouped(before.fp) + '): it must be one you kept off the laptop.'); }
      against = { texts: before.texts, log: before.m.log, made: before.m.made, fp: before.fp };
    }
    const r = await check(bundle, { fingerprint, against });
    if (mine !== run) return;
    if (against && r.kind === 'archive') { draw({ code: 3, why: 'the folder is an archive\'s: the compare takes two exports. Check the archive alone, or inside an export that holds it.', said: [] }); return; }
    if (against && r.code !== 3 && against.fp !== r.fp) r.said.push('△ signed by another key than the earlier export: the laptop\'s machine key changed between them, or they come from two laptops');
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
