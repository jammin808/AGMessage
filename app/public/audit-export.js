// The audit log's signed export, one dialog for every page that offers it (Accounts → Audit log, Admin → Health). It
// says what the export holds and whose key signs it, asks, then fetches POST /api/audit/export and saves it. "Arrived
// whole" is observed, not assumed: the body must end with the zip's end record before it is handed to the browser to
// save, and a stream that stops short is said as one, never saved. The verdict it names is the server's (X-AGM-Export).
// The saved file's link is let go 40 s after, since letting it go at once can cancel the save in some browsers.
// Cancel (or Escape, or anything that closes the dialog) while it is made stops it: the request is aborted, the server
// ends it as not sent whole, and nothing is handed to the browser to save.
// Text only: nothing from the server is put into markup.
(function () {
  'use strict';
  const SHAPE = { intact: '✓ Intact', linked: '◇ Linked', unvouched: '△ Not vouched for', broken: '✕ Broken' };
  const grouped = (fp) => String(fp || '').match(/.{1,4}/g) || [];
  const shortKey = (fp) => grouped(fp).slice(0, 4).join(' ') + ' …';
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const atLaptop = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let dlg = null;
  let making = null;   // the export being made now: its AbortController, aborted when the dialog closes
  let opened = 0;      // which opening of the dialog is showing: a run from an earlier one says nothing in it

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function build() {
    dlg = el('dialog', 'agm-dialog wide');
    dlg.id = 'exportDialog';
    dlg.setAttribute('aria-labelledby', 'exportTitle');
    const h = el('h2', '', 'Export the audit log');
    h.id = 'exportTitle';
    const words = el('p', 'export-words');
    words.id = 'exportWords';
    const state = el('p', 'export-state');
    state.id = 'exportState';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const row = el('div', 'row end');
    const cancel = el('button', 'btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.id = 'exportCancel';
    const go = el('button', 'btn primary', 'Export and download');
    go.type = 'button';
    go.id = 'exportGo';
    row.append(cancel, go);
    dlg.append(h, words, state, row);
    document.body.appendChild(dlg);
    cancel.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { if (making) making.abort(); });
  }

  const CANCELLED = '✕ Not exported: cancelled before it was whole. Nothing was handed to your browser to save.';

  /** Make the export and save it, unless `signal` aborts first; resolves the words said at its end. */
  async function run(say, signal) {
    let r;
    try {
      r = await fetch('/api/audit/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}', signal });
    } catch (e) {
      if (signal.aborted) return say('broken', CANCELLED);
      return say('broken', '✕ Not exported: the export stopped before it was whole (' + (e && e.message ? e.message : e) + '). Do not use a file it left.');
    }
    if (!r.ok || (r.headers.get('content-type') || '').indexOf('application/zip') !== 0) {
      let why = 'the server answered ' + r.status;
      try { const j = await r.json(); if (j && typeof j.error === 'string') why = j.error.replace(/^not exported: /i, ''); } catch { /* no JSON: its status says it */ }
      return say('broken', '✕ Not exported: ' + why);
    }
    const head = {};
    for (const part of String(r.headers.get('X-AGM-Export') || '').split(';')) { const [k, v] = part.trim().split('='); if (k && v) head[k] = v; }
    const disposition = /filename="([A-Za-z0-9._-]{1,120})"/.exec(r.headers.get('content-disposition') || '');
    const parts = [];
    let got = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        say('', 'Making the export… ' + size(got));
      }
    } catch (e) {
      if (signal.aborted) return say('broken', CANCELLED);
      return say('broken', '✕ Not exported: the export stopped before it was whole (' + (e && e.message ? e.message : e) + '). Do not use a file it left.');
    }
    if (signal.aborted) return say('broken', CANCELLED);
    const blob = new Blob(parts, { type: 'application/zip' });
    const tail = new Uint8Array(await blob.slice(-22).arrayBuffer());
    // A zip AGMessage writes ends with its end-of-central-directory record (no comment): 50 4b 05 06.
    if (blob.size < 22 || tail[0] !== 0x50 || tail[1] !== 0x4b || tail[2] !== 0x05 || tail[3] !== 0x06) {
      return say('broken', '✕ Not exported: the export stopped before it was whole (it ended without its last part). Do not use a file it left.');
    }
    if (signal.aborted) return say('broken', CANCELLED);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = disposition ? disposition[1] : 'agmessage-audit.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); }, 40000);
    const mark = SHAPE[head.mark] || '✕ Broken';
    return say(head.mark === 'intact' ? 'intact' : head.mark || 'broken', '✓ Exported ' + (head.entries ? 'entries ' + head.entries.replace('-', '–') : 'the log') + ', signed with ' + shortKey(head.key)
      + ': it arrived whole (' + size(blob.size) + ') and was handed to your browser to save — check your downloads. The log read ' + mark + ' when it was made'
      + (head.mark === 'intact' ? '.' : '; the export says so.') + (atLaptop() ? ' It is saved on this laptop: move it off, then delete it here.' : ''));
  }

  /**
   * Open the dialog. `fingerprint`: the signing key's, which the words name (its first 16 characters; the full key is
   * on Admin → Health and in the black window); `done(words)` is told how it ended.
   */
  function open({ fingerprint = '', done } = {}) {
    if (!dlg) build();
    const mine = ++opened;
    const go = document.getElementById('exportGo');
    const state = document.getElementById('exportState');
    document.getElementById('exportWords').textContent = 'Export the audit log to check on another computer. It holds every entry, the archived ones too — names, addresses and what each did. Older entries can also hold the first words of messages shown on screens and the names of files shown there, including files later marked confidential. Give it only to whoever checks it. It is signed with this AGMessage\'s key '
      + (fingerprint ? shortKey(fingerprint) : '(shown on Admin → Health)') + ': whoever checks it needs that key from you or the show\'s paperwork, not from the file.';
    state.textContent = '';
    state.dataset.mark = '';
    go.hidden = false;
    go.disabled = false;
    go.onclick = async () => {
      go.disabled = true;
      const ctl = new AbortController();
      making = ctl;
      let words;
      try {
        words = await run((mark, text) => { if (mine === opened) { state.dataset.mark = mark; state.textContent = text; } return text; }, ctl.signal);
      } finally { if (making === ctl) making = null; }
      if (mine === opened) go.hidden = true;
      if (typeof done === 'function') done(words);
    };
    AGM.openDialog(dlg);
  }

  window.AGMAuditExport = { open };
})();
