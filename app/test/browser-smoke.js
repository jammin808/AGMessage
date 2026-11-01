'use strict';
/**
 * Browser smoke test: a real server (throwaway data folder) and headless Microsoft Edge driven over the DevTools
 * protocol. Loads the research and board views and the admin dashboard, checks each joins and renders with no script
 * error or CSP violation, renders a PDF through pdf.js and a Word file through mammoth on the Board's panel in a browser
 * without Promise.withResolvers in the page or in pdf.js's worker (as an older iPad), drives a hall's screens (files
 * taken over a slow network, a deck stepped through on such a browser, the countdown's strip on an upright tablet, the
 * clock in another time zone, the Screens console), and saves screenshots.
 *
 *   npm run smoke            (screenshots in ../artifacts/smoke; set AGM_SMOKE_OUT to change)
 * Exit code 0 when everything passed. Needs Edge, Chrome or Chromium (set AGM_BROWSER to its path if it's elsewhere).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { fakeStagewatch, fakeNode, chainOf, unzipTo, keyedLogWithPoints, FIXTURE_KEY, connect, emit } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.AGM_SMOKE_OUT || path.join(ROOT, '..', 'artifacts', 'smoke');
const TOKEN = 'smokeadmintoken1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A value written into code a page evaluates: JSON, with the characters that could end a string or a script escaped.
const CODE_ESCAPES = { '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const codeLiteral = (v) => JSON.stringify(v).replace(/[<>\b\f\n\r\t\0\u2028\u2029]/g, (c) => CODE_ESCAPES[c]);
// The server's own time zone for the smoke: a screen in another zone must still show this one's time of day.
const SERVER_TZ = 'Europe/London';
const KEY = 'swk_smoke_node_key_00001';   // secret-scan: fixture — a fake node key for the fake Stagewatch
let failures = 0;
const report = (ok, what) => { console.log((ok ? 'OK   ' : 'FAIL ') + what); if (!ok) failures++; };

/** A Chromium the smoke can drive over DevTools: AGM_BROWSER, then Edge (Windows), then Chrome or Chromium (Linux, macOS). */
function browserPath() {
  const c = [process.env.AGM_BROWSER, process.env.AGM_EDGE, process.env.STAGEWATCH_EDGE,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '', TZ: SERVER_TZ },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.channel) child.channel.unref();
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('is running'); i++) await sleep(100);
  if (!out.includes('is running')) throw new Error('server did not start:\n' + out);
  return child;
}

/** Stop a server as the watchdog does (asked over IPC, so it saves first), and wait until it has gone. */
const stopServer = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  child.once('exit', resolve);
  try { child.send({ t: 'stop' }); } catch { child.kill(); }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
});

// A DevTools call that has had no answer by then is a failure with its name, never a run that hangs.
const CDP_MS = 60_000;
/**
 * One DevTools connection: send(method, params, sessionId) answers the reply, or {error} when none came within CDP_MS.
 * A sessionId addresses a target attached to this one (a page's worker), whose events carry it too.
 */
async function devtools(url, onEvent = () => {}) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('no DevTools connection at ' + url))); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method) onEvent(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((r) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); r({ error: { message: method + ' had no answer in ' + CDP_MS / 1000 + ' s' } }); }, CDP_MS);
    pending.set(i, (m) => { clearTimeout(timer); r(m); });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });
  return { ws, send };
}

/** One headless Edge; each tab a window of its own, with a DevTools session. */
async function launchEdge() {
  const exe = browserPath();
  if (!exe) throw new Error('no Edge, Chrome or Chromium found (set AGM_BROWSER to one)');
  const port = await freePort();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-edge-'));
  // A container running as root has no user namespace for Chromium's sandbox; everywhere else the sandbox stays on.
  const sandbox = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
  // Each tab stands for a device of its own (a laptop, a phone, a stage screen) whose page is in front. A page in a hidden
  // tab is frozen by the browser (Edge's sleeping tabs, Chromium's freezing): its screenshot stalls, and Blink fails its
  // WebSockets with "Page entered Back-Forward Cache." on any freeze. So every page has a window of its own (tab(), below)
  // and is visible, which is never frozen; these switches keep the timers and priority of a page that is not focused.
  const awake = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', ...awake, ...sandbox, '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
  if (!version) throw new Error('the browser opened no DevTools port');
  const browserHeard = [];
  const browser = await devtools(version.webSocketDebuggerUrl, (m) => { for (const f of browserHeard) f(m); });
  return {
    proc, port, prof,
    /** The browser's own DevTools session (downloads), and what it hears. */
    browserSend: (method, params) => browser.send(method, params),
    onBrowser: (fn) => { browserHeard.push(fn); },
    /**
     * A tab on `url`: `init` runs before the page's own scripts, `workerInit` before each worker's (the worker held at
     * its start until it has run; `workers` lists each worker still running, with what `workerInit` answered there),
     * `metrics` {width, height} is its viewport, `timezone` its zone.
     */
    async tab(url, { init, workerInit, metrics, timezone } = {}) {
      // A window of its own, so its page is always the one in front (never a hidden tab behind another).
      const made = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1400, height: 900 });
      if (!made.result) throw new Error('no new window: ' + (made.error ? made.error.message : 'no answer'));
      const problems = []; const listeners = new Map(); const expected = []; const logs = []; const workers = [];
      const { ws, send: call } = await devtools(`ws://127.0.0.1:${port}/devtools/page/${made.result.targetId}`, (m) => {
        if (m.method === 'Target.attachedToTarget') { startAttached(m.params); return; }
        if (m.method === 'Target.detachedFromTarget') { const i = workers.findIndex((w) => w.sessionId === m.params.sessionId); if (i >= 0) workers.splice(i, 1); return; }
        if (m.sessionId) return;   // a worker's own events: what the smoke reads there, it asks for
        if (listeners.has(m.method)) listeners.get(m.method)(m.params);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'log') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
        if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || m.params.entry.text) && !expected.some((r) => r.test(m.params.entry.url || ''))) problems.push('log: ' + m.params.entry.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      });
      const send = async (method, params, sessionId) => {
        const m = await call(method, params, sessionId);
        if (m.error && / had no answer in /.test(m.error.message)) problems.push('DevTools: ' + m.error.message);
        return m;
      };
      // A worker attached while held at its start: `workerInit` runs in it first, then it starts. Whatever happens, it
      // is let go, so a worker is never left waiting.
      async function startAttached({ sessionId, targetInfo }) {
        try {
          if (targetInfo.type === 'worker') {
            const r = await send('Runtime.evaluate', { expression: workerInit, returnByValue: true }, sessionId);
            workers.push({ sessionId, url: targetInfo.url, start: r.result?.result?.value ?? null });
          }
        } finally {
          await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        }
      }
      await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
      if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init });
      if (workerInit) await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      if (metrics) await send('Emulation.setDeviceMetricsOverride', { width: metrics.width, height: metrics.height, deviceScaleFactor: 1, mobile: false });
      if (timezone) await send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      await send('Page.navigate', { url });
      return {
        /** `logs`: what the tab's frames wrote with console.log, in order. */
        problems, send, logs, workers,
        /** An expression's value in one of `workers`. */
        workerEval: async (sessionId, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value,
        /** A resource this tab is made to fail on purpose: its load error is not a problem. */
        expectFailure: (re) => { expected.push(re); },
        /** The viewport, as a screen of that size would have it. */
        resize: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
        /** Hear one DevTools event of this tab (one listener per event). */
        on: (method, fn) => { listeners.set(method, fn); },
        /** Choose a folder in a file input (`webkitdirectory`), as a person picking it does. */
        async chooseFolder(selector, dir) {
          const doc = await send('DOM.getDocument');
          const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
          return send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [dir] });
        },
        /** Hold every request whose URL matches `pattern` for `ms`, then let it through (a slow venue network) or fail it. */
        async hold(pattern, ms, fail = false) {
          listeners.set('Fetch.requestPaused', (p) => { setTimeout(() => { send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: p.requestId, ...(fail ? { errorReason: 'ConnectionReset' } : {}) }); }, ms); });
          await send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
        },
        release: () => send('Fetch.disable'),
        eval: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value,
        async until(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await this.eval(expr); if (v) return v; await sleep(250); } return null; },
        async shot(file) {
          await send('Page.bringToFront');
          const s = await send('Page.captureScreenshot', { format: 'png' });
          if (s.result) fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
          else report(false, 'screenshot ' + path.basename(file) + ': ' + (s.error ? s.error.message : 'no answer'));
        },
        close: () => ws.close(),
      };
    },
    close() { try { browser.ws.close(); proc.kill(); } catch { /* ignore */ } setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ } }, 1500); },
  };
}

/** A one-page PDF with a line of text (pdf.js rebuilds the cross-reference table if offsets are off). */
function tinyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const text = 'BT /F1 18 Tf 24 72 Td (Capex 2025: 4.2m) Tj ET';
  objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * A Word file of two paragraphs, the first a bold run, each part stored (not deflated) in its zip: what mammoth needs
 * and no more ([Content_Types].xml, the package's relationships, the document).
 */
function tinyDocx() {
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Board pack</w:t></w:r></w:p><w:p><w:r><w:t>Item 4: the capex review</w:t></w:r></w:p></w:body></w:document>',
  };
  const local = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text, 'utf8'); const n = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, n, data); central.push(dir, n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** A PDF whose pages are each one colour (an rgb string, "0 0 1" for blue) filling the page, with a line of text. */
function colourPdf(pages) {
  const objs = [];
  const add = (o) => { objs.push(o); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids = pages.map((p) => {
    const body = `${p.rgb} rg 0 0 ${p.w} ${p.h} re f 0 0 0 rg BT /F1 40 Tf 60 ${Math.round(p.h / 2)} Td (${p.text}) Tj ET`;
    const c = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  });
  add(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PNG of one colour ([r, g, b]). */
function colourPng(w, h, rgb) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, (_, i) => rgb[i % 3]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// A screen page's counters, set before its own scripts: pdf.js workers started and ended, and how often the visible file
// canvas was resized (which clears it) and was still blank on the next frame.
const SCREEN_PROBE = `(() => {
  window.__workers = { made: 0, ended: 0 };
  const W = window.Worker;
  const end = W.prototype.terminate;
  W.prototype.terminate = function () { window.__workers.ended++; return end.call(this); };
  window.Worker = class extends W { constructor(...a) { super(...a); window.__workers.made++; } };
  window.__canvas = { resized: 0, blank: 0 };
  const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    configurable: true,
    get() { return width.get.call(this); },
    set(v) {
      width.set.call(this, v);
      if (this.id !== 'fileCanvas') return;
      window.__canvas.resized++;
      const cv = this;
      requestAnimationFrame(() => { if (cv.hidden || !cv.width) return; const p = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 2, 1, 1).data; if (p[3] === 0) window.__canvas.blank++; });
    },
  });
})();`;
// A browser older than Safari and iPadOS 17.4 (or Chrome 119, Firefox 121) has no Promise.withResolvers, which pdf.js
// calls in its page module and in its worker: it is taken away before the page's own scripts run and before each
// worker's, as such a device has it, and what each began with is kept (and answered, for a worker's record).
const NO_RESOLVERS = `(() => { delete Promise.withResolvers; globalThis.__resolversAtStart = typeof Promise.withResolvers; return globalThis.__resolversAtStart; })();`;
/**
 * pdf.js's worker on a tab opened with NO_RESOLVERS as its workerInit: each one running, what it began with and has now,
 * and whether pdf.js fell back to running the worker's code in the page itself (its "fake worker"), which would not be
 * the worker file at work.
 */
async function pdfWorkers(tab) {
  const live = tab.workers.filter((w) => /\/vendor\/pdf\.worker\.min\.mjs$/.test(w.url));
  const now = [];
  for (const w of live) now.push(await tab.workerEval(w.sessionId, '[typeof Promise.withResolvers, typeof globalThis.pdfjsWorker].join(" ")'));
  const inPage = await tab.eval('typeof globalThis.pdfjsWorker');
  return { count: live.length, start: live.map((w) => w.start), now, inPage,
    ok: live.length > 0 && live.every((w) => w.start === 'undefined') && now.every((x) => x === 'function object') && inPage === 'undefined' };
}
// What the file layer shows: which of the image and the canvas are visible, the canvas's size and its top-centre colour.
const FILE_SEEN = `(() => { const c = document.getElementById('fileCanvas'); const p = c.width ? c.getContext('2d').getImageData(c.width >> 1, 4, 1, 1).data : [0, 0, 0, 0];
  return { kind: document.body.dataset.kind, img: !document.getElementById('fileImg').hidden, canvas: !c.hidden, w: c.width, h: c.height, rgb: [p[0], p[1], p[2]] }; })()`;
// An old TV browser: it knows no time zone but its own, and throws on any other (as some do on a zone they lack).
const NO_ZONES = `(() => { const D = Intl.DateTimeFormat;
  const F = function (locales, o) { if (o && o.timeZone) throw new RangeError('Invalid time zone specified: ' + o.timeZone); return new D(locales, o); };
  F.prototype = D.prototype; F.supportedLocalesOf = D.supportedLocalesOf; Intl.DateTimeFormat = F; })();`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startServer(port, dataDir);
  const edge = await launchEdge();
  let sw = null;
  let patterns = null;
  let server2 = null;
  let dataDir2 = null;
  let server3 = null;
  let dataDir3 = null;
  try {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { code } = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Smoke AGM' }) })).json();

    // Research: joins, gets an upload token, shares a PDF, pdf.js renders it under the CSP.
    const research = await edge.tab(`${base}/app.html?code=${code}&name=Ana&role=research`);
    report(!!(await research.until('typeof joined !== "undefined" && joined && !!UPLOAD_TOKEN')), 'research view joins (identity, upload token)');
    const pdfB64 = tinyPdf().toString('base64');
    const pages = await research.eval(`(async () => {
      const bytes = Uint8Array.from(atob('${pdfB64}'), c => c.charCodeAt(0));
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'application/pdf' }), 'capex.pdf');
      const up = await (await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } })).json();
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ url: up.url, isEvalSupported: false }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
      await new Promise((r) => socket.emit('message', { type: 'file', url: up.url, filename: 'capex.pdf', mime: 'application/pdf' }, r));
      return doc.numPages + '|' + text;
    })()`);
    report(typeof pages === 'string' && pages.startsWith('1|') && pages.includes('Capex'), `pdf.js renders an uploaded PDF and reads its text (${pages})`);
    await research.eval(`new Promise((r) => socket.emit('message', { type: 'text', text: 'Capex is on slide 14' }, r))`);
    await research.eval(`(() => { window.__seenFrames = []; socket.on('seen', (f) => window.__seenFrames.push(f)); })()`);

    // Board: joins, sees the message and the document on stage, on a browser with no Promise.withResolvers.
    const board = await edge.tab(`${base}/app.html?code=${code}&name=Chair&role=board`, { init: NO_RESOLVERS, workerInit: NO_RESOLVERS });
    report(!!(await board.until('typeof joined !== "undefined" && joined && allMessages.some(m => m.text === "Capex is on slide 14")')), 'board view joins and sees the research message');
    // Someone else's receipt (a page in another browser: these tabs share one identity) reaches the sender's page in
    // the hall's batch of the receipts that moved, and is drawn under the message.
    const reader = await connect(base);
    const readerIn = await emit(reader, 'join', { roomCode: code, name: 'Sam', role: 'observer' });
    reader.emit('seen', { seq: readerIn.seq });
    const seenDrawn = await research.until(`(() => {
      const node = messagesById.get(allMessages.find((m) => m.text === 'Capex is on slide 14').id);
      const line = node && node.querySelector('.seen-line');
      if (!line || line.textContent !== '✓ Seen by Sam') return null;
      const frames = window.__seenFrames;
      return { batches: frames.length > 0 && frames.every((f) => Object.keys(f).join() === 'seen' && Array.isArray(f.seen)), sam: frames.some((f) => f.seen.some((e) => e.name === 'Sam' && e.role === 'observer')), frames: frames.length };
    })()`);
    reader.close();
    report(!!seenDrawn && seenDrawn.batches && seenDrawn.sam, `the sender's message reads "✓ Seen by Sam", from the hall's batched seen frames (${JSON.stringify(seenDrawn)})`);
    // The panel draws the PDF through pdf.js's legacy build, which defines what the browser lacks; then a Word file.
    const boardPdf = await board.until(`(() => {
      if (!window.__openedPdf) { window.__openedPdf = 1; openDocInPanel(allMessages.find((m) => m.filename === 'capex.pdf')); }
      const err = document.querySelector('#docDisplay .error');
      if (err) return { error: err.textContent };
      const c = document.querySelector('#docDisplay canvas.pdf-page');
      if (!c || c.classList.contains('pdf-page-pending')) return null;
      const p = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return { atStart: window.__resolversAtStart, now: typeof Promise.withResolvers, w: c.width, alpha: p[3] };
    })()`);
    const boardWorker = await pdfWorkers(board);
    report(!!boardPdf && !boardPdf.error && boardPdf.atStart === 'undefined' && boardPdf.now === 'function' && boardPdf.w > 0 && boardPdf.alpha === 255 && boardWorker.ok,
      `the Board's panel draws a PDF on a browser with no Promise.withResolvers in the page or in pdf.js's worker (as an iPad before 17.4), which the legacy build's module and its worker each define (${JSON.stringify({ ...boardPdf, worker: boardWorker })})`);
    const docxB64 = tinyDocx().toString('base64');
    await research.eval(`(async () => {
      const bytes = Uint8Array.from(atob('${docxB64}'), c => c.charCodeAt(0));
      const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type: mime }), 'board-pack.docx');
      const up = await (await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } })).json();
      await new Promise((r) => socket.emit('message', { type: 'file', url: up.url, filename: 'board-pack.docx', mime }, r));
    })()`);
    const boardDocx = await board.until(`(() => {
      const m = allMessages.find((x) => x.filename === 'board-pack.docx');
      if (!m) return null;
      if (window.__openedDocx !== m.id) { window.__openedDocx = m.id; openDocInPanel(m); }
      const h = document.querySelector('#docDisplay .doc-html');
      if (!h) return null;
      if (h.querySelector('.error')) return { error: h.textContent };
      const b = h.querySelector('strong');
      return b ? { strong: b.textContent, text: h.textContent } : null;
    })()`);
    report(!!boardDocx && boardDocx.strong === 'Board pack' && boardDocx.text.includes('Item 4: the capex review'),
      `a Word file draws on the Board's panel through mammoth 1.13.0, its bold kept (${JSON.stringify(boardDocx)})`);
    await sleep(800);
    await research.shot(path.join(OUT, 'research.png'));
    await board.shot(path.join(OUT, 'board.png'));

    // Admin dashboard: logs in on this machine and lists the room.
    const admin = await edge.tab(`${base}/admin.html`);
    await admin.until('document.readyState === "complete"');
    await admin.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
    report(!!(await admin.until(`!document.getElementById('dashboard').hidden && document.body.textContent.includes('${code}') && document.getElementById('aiModel').textContent.includes('claude')`)), 'admin dashboard lists the room and its AI / show-network panels');
    // Health reads the loop's true delay and how busy it is (from its first 5 s window), and today's peaks: the hall made
    // and the sign-in's audit row are already in them.
    const healthLine = await admin.until(`(() => { const t = document.getElementById('healthLine').textContent; return /loop delay p95 [\\d.]+ ms \\(max [\\d.]+\\) · busy \\d+ %/.test(t) && /today's peaks: loop delay [\\d.]+ ms, busy \\d+ %, largest hall \\d+ messages/.test(t) && /audit write p99 [\\d.]+ ms/.test(t) && t; })()`, 20000);
    report(!!healthLine, 'the admin\'s health line reads the loop delay, how busy it is and today\'s peaks' + (healthLine ? '' : ': ' + await admin.eval(`document.getElementById('healthLine').textContent`)));
    const auditLine = await admin.until(`(() => { const l = document.getElementById('auditLine'); return l.dataset.mark === 'intact' && /^Audit log: ✓ keyed \\(key [0-9a-f]{16}\\) · nothing to accept$/.test(l.textContent) && document.getElementById('auditAcceptRow').hidden && document.getElementById('auditWhere').hidden && l.textContent; })()`);
    report(!!auditLine, `Health's audit line names the key and that nothing waits to be accepted (${auditLine})`);
    // The signed export, from Health, by the token at the laptop: the signing key in full, no export yet, the dialog's
    // words, the zip the browser saves (its bytes the zip the log names), and its link let go 40 s after, not at once.
    const signKey = (await (await fetch(base + '/api/health', { headers: { cookie } })).json()).saves.stores.audit.signKey;
    const grouped = (fp) => String(fp).match(/.{4}/g).join(' ');
    const keyShown = await admin.until(`(() => { const k = document.getElementById('auditSignKey'); return !k.hidden && !document.getElementById('auditExportRow').hidden && document.getElementById('signKeyText').textContent + '|' + document.getElementById('auditLastExport').textContent; })()`);
    report(keyShown === grouped(signKey) + '|No export in the log\'s newest file: export at the end of each show day.', `Health shows the signing key in full, no export yet, and Export… to the token (${keyShown})`);
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-dl-'));
    const downloads = new Map();
    edge.onBrowser((m) => {
      if (m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { name: m.params.suggestedFilename, state: '' });
      if (m.method === 'Browser.downloadProgress' && downloads.has(m.params.guid)) downloads.get(m.params.guid).state = m.params.state;
    });
    await edge.browserSend('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
    await admin.eval(`(() => { window.__revoked = 0; window.__timers = []; const r = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = (u) => { window.__revoked++; r(u); }; const st = window.setTimeout.bind(window); window.setTimeout = (fn, ms, ...a) => { window.__timers.push(ms); return st(fn, ms, ...a); }; })()`);
    const openExport = async () => {
      await admin.eval(`document.getElementById('auditExportBtn').click()`);
      return admin.until(`(() => { const d = document.getElementById('exportDialog'); return d && d.open && !document.getElementById('exportGo').hidden && !document.getElementById('exportGo').disabled && document.getElementById('exportWords').textContent; })()`);
    };
    const exportWords = await openExport();
    report(exportWords === 'Export the audit log to check on another computer. It holds every entry, the archived ones too — names, addresses and what each did. Older entries can also hold the first words of messages shown on screens and the names of files shown there, including files later marked confidential. Give it only to whoever checks it. It is signed with this AGMessage\'s key ' + grouped(signKey.slice(0, 16)) + ' …: whoever checks it needs that key from you or the show\'s paperwork, not from the file.', `the export dialog says what it holds and whose key signs it (${(exportWords || '').slice(0, 80)}…)`);
    await admin.eval(`document.getElementById('exportGo').click()`);
    const exportDone = await admin.until(`(() => { const s = document.getElementById('exportState'); return /^✓ Exported/.test(s.textContent) && s.dataset.mark + '|' + s.textContent; })()`, 20000);
    let savedExport = null;
    for (const end = Date.now() + 15000; Date.now() < end && !savedExport; await sleep(100)) savedExport = [...downloads].find(([, d]) => d.state === 'completed');
    const savedBytes = savedExport ? fs.readFileSync(path.join(dlDir, savedExport[0])) : Buffer.alloc(0);
    const sentRow = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'audit.export.sent').pop();
    const savedSha = crypto.createHash('sha256').update(savedBytes).digest('hex');
    report(!!savedExport && !!sentRow && savedSha === sentRow.words.slice(-64) && /^agmessage-audit-[0-9a-f]{8}-\d{8}-\d{4}\.zip$/.test(savedExport[1].name), `the browser saved the export whole: its bytes are the zip the log names (${savedExport ? savedExport[1].name : 'no download'}, ${savedSha.slice(0, 12)}…)`);
    report(/^intact\|✓ Exported entries 1–\d+, signed with [0-9a-f ]{19} …: it arrived whole \(\d+ KB\) and was handed to your browser to save — check your downloads\. The log read ✓ Intact when it was made\. It is saved on this laptop: move it off, then delete it here\.$/.test(exportDone || '') && exportDone.includes(grouped(signKey.slice(0, 16)) + ' …'), `the dialog says it arrived whole and where it is (${exportDone})`);
    const revoke = await admin.eval(`JSON.stringify({ revoked: window.__revoked, timers: window.__timers.filter((ms) => ms === 40000).length })`);
    report(revoke === '{"revoked":0,"timers":1}', `the saved file's link is let go 40 s after the click, not at once (${revoke})`);
    const lastExport = await admin.until(`(() => { const t = document.getElementById('auditLastExport').textContent; return /^Last export: entries 1–\\d+, sent whole at \\d\\d:\\d\\d on \\d+ \\w{3} \\(AGMessage laptop\\)\\. Export at the end of each show day\\.$/.test(t) && t; })()`, 15000);
    report(!!lastExport, `Health names the last export (${lastExport})`);
    await admin.shot(path.join(OUT, 'audit-export.png'));
    await admin.eval(`document.getElementById('exportDialog').close()`);
    // "Not exported": a refusal (the server's 409, its words said), and a stream cut short (no end record: nothing saved).
    const savedBefore = downloads.size;
    let fake = 'refuse';
    let held = null;   // the export's answer held back while Cancel is pressed
    admin.on('Fetch.requestPaused', async (p) => {
      if (fake === 'hold') { held = p.requestId; return; }
      if (fake === 'refuse') {
        await admin.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 409, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ ok: false, error: 'an export is being made for Ana since 14:02: try again when it ends' })).toString('base64') });
        return;
      }
      const b = await admin.send('Fetch.getResponseBody', { requestId: p.requestId });
      const full = Buffer.from(b.result.body, b.result.base64Encoded ? 'base64' : 'utf8');
      const headers = (p.responseHeaders || []).filter((x) => !/^(content-length|transfer-encoding)$/i.test(x.name));
      await admin.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body: full.subarray(0, full.length - 40).toString('base64') });
    });
    admin.expectFailure(/\/api\/audit\/export$/);   // the refusal's 409 and the cut stream are this step's own
    await admin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/audit/export', requestStage: 'Request' }] });
    await openExport();
    await admin.eval(`document.getElementById('exportGo').click()`);
    const refusedWords = await admin.until(`(() => { const s = document.getElementById('exportState'); return /^✕/.test(s.textContent) && s.textContent; })()`);
    report(refusedWords === '✕ Not exported: an export is being made for Ana since 14:02: try again when it ends', `a refused export says "Not exported" with the server's words (${refusedWords})`);
    await admin.eval(`document.getElementById('exportDialog').close()`);
    fake = 'cut';
    await admin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/audit/export', requestStage: 'Response' }] });
    await openExport();
    await admin.eval(`document.getElementById('exportGo').click()`);
    const cutWords = await admin.until(`(() => { const s = document.getElementById('exportState'); return /^✕/.test(s.textContent) && s.textContent; })()`, 15000);
    await sleep(500);
    report(cutWords === '✕ Not exported: the export stopped before it was whole (it ended without its last part). Do not use a file it left.' && downloads.size === savedBefore, `a stream without its end record is said as cut short, and nothing is saved (${cutWords}; ${downloads.size - savedBefore} saved)`);
    await admin.eval(`document.getElementById('exportDialog').close()`);
    // Cancel while the export is made: the dialog closes, the request is aborted, and nothing is handed to the browser.
    fake = 'hold';
    held = null;
    await openExport();
    await admin.eval(`document.getElementById('exportGo').click()`);
    const isHeld = () => held !== null;   // set by the paused-request handler above
    for (let i = 0; i < 200 && !isHeld(); i++) await sleep(50);
    await admin.eval(`document.getElementById('exportCancel').click()`);
    const cancelled = await admin.until(`(() => { const s = document.getElementById('exportState'); return !document.getElementById('exportDialog').open && /^✕/.test(s.textContent) && s.textContent; })()`);
    if (held) await admin.send('Fetch.continueRequest', { requestId: held });   // too late: the page let it go
    await sleep(500);
    report(!!held && cancelled === '✕ Not exported: cancelled before it was whole. Nothing was handed to your browser to save.' && downloads.size === savedBefore, `Cancel while the export is made stops it, and nothing is saved (${cancelled}; ${downloads.size - savedBefore} saved)`);
    await admin.send('Fetch.disable');
    await admin.eval(`document.getElementById('exportDialog').close()`);
    // The browser verifier, opened from disk: "not compared" until the key is typed, then ✓; the entries drawn; nothing
    // asked of the network; one byte changed reads "nothing in the bundle is vouched for".
    const bundleDir = savedExport ? unzipTo(savedBytes, fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-bundle-'))) : os.tmpdir();
    const checker = await edge.tab(pathToFileURL(path.join(bundleDir, 'verify', 'verify.html')).href);
    await checker.until('document.readyState === "complete"');
    const asked = [];
    checker.on('Network.requestWillBeSent', (p) => asked.push(p.request.url));
    await checker.send('Network.enable');
    await checker.chooseFolder('#folder', bundleDir);
    const notCompared = await checker.until(`document.getElementById('state').dataset.code === '4' && document.getElementById('state').textContent`);
    await checker.eval(`(() => { const i = document.getElementById('fp'); i.value = ${JSON.stringify(grouped(signKey))}; i.dispatchEvent(new Event('input')); })()`);
    const pageOk = await checker.until(`document.getElementById('state').dataset.code === '0' && document.getElementById('state').textContent`, 20000);
    const seeded = await checker.eval(`[...document.querySelectorAll('#rows tr')].some((tr) => tr.textContent.includes('signed in with the host laptop\\'s admin token'))`);
    report(/not compared with a record of the laptop's key/.test(notCompared || '') && pageOk === '✓ Signed by the key you expected and whole; the laptop said ✓.' && seeded === true, `the browser verifier reads "not compared" without the key and ✓ with it, and draws the entries (${pageOk})`);
    await checker.shot(path.join(OUT, 'audit-verifier.png'));
    const changedDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-changed-')), path.basename(bundleDir));
    fs.cpSync(bundleDir, changedDir, { recursive: true });
    const logBytes = fs.readFileSync(path.join(changedDir, 'log', 'audit.jsonl'));
    logBytes[20] ^= 1;
    fs.writeFileSync(path.join(changedDir, 'log', 'audit.jsonl'), logBytes);
    await checker.chooseFolder('#folder', changedDir);
    const pageBad = await checker.until(`document.getElementById('state').dataset.code === '3' && document.getElementById('state').textContent`, 20000);
    report(pageBad === '✕ Nothing in the bundle is vouched for: log/audit.jsonl is not what was signed: its SHA-256 differs from SHA256SUMS' && !(await checker.eval(`document.getElementById('entriesBox').hidden === false`)), `one byte changed: the page vouches for nothing and draws no entry (${pageBad})`);
    report(asked.length === 0, `the browser verifier asked the network for nothing (${asked.length} requests${asked.length ? ': ' + asked.slice(0, 2).join(', ') : ''})`);
    await admin.shot(path.join(OUT, 'admin.png'));

    // The admin's support view (the person's page, framed in the admin page) resyncs when the admin page that frames it
    // asks, and only then: a frame inside the view (a real post from it), or a message with another origin (as the browser
    // delivers one; the view's frame-ancestors keep a real other-origin parent out), does not reach the resync.
    await admin.eval(`openUserView('${code}', 'Chair', 'board')`);
    const viewUp = await admin.until(`(() => { const d = document.getElementById('userViewFrame').contentDocument; return !!d && !!d.body && d.body.classList.contains('is-admin-view') && !!d.getElementById('connDot') && d.getElementById('connDot').classList.contains('ok'); })()`);
    await admin.eval(`(() => { const w = document.getElementById('userViewFrame').contentWindow; w.AGM_DEBUG_SYNC = true; const c = w.document.createElement('iframe'); c.title = 'a frame inside the view'; w.document.body.appendChild(c); })()`);
    const frames = [];
    const walk = (n, parent) => { frames.push({ id: n.frame.id, url: n.frame.url, parent }); (n.childFrames || []).forEach((c) => walk(c, n.frame.id)); };
    walk((await admin.send('Page.getFrameTree')).result.frameTree, null);
    const viewFrame = frames.find((f) => /[?&]adminView=1/.test(f.url));
    const childFrame = viewFrame && frames.find((f) => f.parent === viewFrame.id);
    const resyncs = () => admin.logs.filter((l) => l === '[sync] manual resync requested').length;
    const world = childFrame ? await admin.send('Page.createIsolatedWorld', { frameId: childFrame.id, worldName: 'smoke-child' }) : {};
    const posted = world.result ? await admin.send('Runtime.evaluate', { contextId: world.result.executionContextId, expression: `parent.postMessage({ type: 'agm:resync' }, '*'); 'posted'`, returnByValue: true }) : {};
    await sleep(600);
    const fromChild = resyncs();
    await admin.eval(`(() => { const w = document.getElementById('userViewFrame').contentWindow; w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'agm:resync' }, origin: 'http://localhost:${port}', source: window })); })()`);
    await sleep(300);
    const fromElsewhere = resyncs();
    await admin.eval(`document.getElementById('userViewResync').click()`);
    const resyncEnd = Date.now() + 3000;
    while (Date.now() < resyncEnd && resyncs() < 1) await sleep(50);
    const fromAdmin = resyncs();
    report(!!viewUp && posted.result?.result?.value === 'posted' && fromChild === 0 && fromElsewhere === 0 && fromAdmin === 1, `the support view resyncs for the admin page's Resync and for nothing else (a frame inside it: ${fromChild}, another origin: ${fromElsewhere}, the admin page: ${fromAdmin})`);
    await sleep(1500);   // Resync's reload of the view lands before it is closed
    // What Chair's own page sends when asked (the theme, the text size, the split) passes the relay's readers and reaches
    // the view: a shape the readers refuse would stop the mirroring without a word.
    const afterResync = admin.logs.slice(admin.logs.indexOf('[sync] manual resync requested'));
    const mirrored = ['theme', 'zoom', 'split'].filter((k) => afterResync.some((l) => l.startsWith(`[sync] recv ${k} `)));
    report(mirrored.length === 3, `Chair's own page's theme, text size and split reach the support view after Resync (${mirrored.join(', ')})`);
    await admin.eval(`document.getElementById('userViewClose').click()`);

    // Accounts: the first admin is made on the sign-in page; the halls board and the accounts page render under the CSP.
    const signin = await edge.tab(`${base}/`);
    report(!!(await signin.until(`!document.getElementById('setupPane').hidden`)), 'sign-in page offers the first admin when there are no accounts');
    await signin.eval(`(() => { document.getElementById('setupName').value = 'Ana Admin'; document.getElementById('setupUser').value = 'ana'; document.getElementById('setupPass').value = 'the green room kettle'; document.getElementById('setupPane').requestSubmit(); })()`);
    report(!!(await signin.until(`location.pathname === '/halls.html' && document.querySelectorAll('.hall-row').length >= 1 && document.getElementById('linkState').dataset.ok === '1'`)), 'the first admin lands on the halls board, live, with the hall listed');
    await sleep(600);
    await signin.shot(path.join(OUT, 'halls.png'));
    const users = await edge.tab(`${base}/users.html`);
    report(!!(await users.until(`document.querySelectorAll('#userRows tr').length === 1`)), 'the accounts page lists the admin');
    await users.eval(`document.getElementById('tabAudit').click()`);
    await users.eval(`document.getElementById('verifyBtn').click()`);
    report(!!(await users.until(`document.getElementById('chainState').dataset.mark === 'intact' && /^✓ Intact — \\d+ entries, all keyed on this machine$/.test(document.getElementById('chainState').textContent) && !document.getElementById('verifyBtn').disabled`)), 'Check the log reads the whole chain and says it is intact: ✓');
    const usersKey = await users.until(`!document.getElementById('exportBtn').hidden && document.getElementById('auditKey').textContent`);
    report(usersKey === 'Keyed with key ' + /^[0-9a-f]{16}/.exec(auditLine.split('key ')[1])[0] + '. Exports are signed with the key ' + grouped(signKey) + ': whoever checks one compares it with their own record of this key (the show\'s paperwork), never with the export.', `the audit log offers Export… to an admin and names the signing key (${usersKey})`);
    const rowMarks = await users.eval(`[...document.querySelectorAll('#auditList .audit-row')].map((li) => li.querySelector('.audit-mark').dataset.mark + ':' + li.querySelector('.audit-mark [aria-hidden]').textContent)`);
    report(Array.isArray(rowMarks) && rowMarks.length > 0 && rowMarks.every((m) => m === 'intact:✓'), `each row of the audit log draws its mark with its shape (${(rowMarks || []).slice(0, 3).join(', ')}…)`);
    await users.eval(`document.getElementById('tabPeople').click()`);
    await users.eval(`document.getElementById('newUserBtn').click()`);
    await users.until(`document.getElementById('userDialog').open`);
    await users.shot(path.join(OUT, 'accounts.png'));
    // An editor opened and saved untouched changes nothing, even for an account that still holds a hall removed since.
    await users.eval(`(async () => { document.getElementById('userDialog').close(); await AGM.api('POST', '/api/users', { username: 'kim', name: 'Kim Tech', role: 'tech', halls: ['${code}', 'GONE01'], password: 'mixing desk on stage left' }); location.reload(); })()`);
    await users.until(`document.querySelectorAll('#userRows tr').length === 2`);
    await users.eval(`[...document.querySelectorAll('#userRows tr')].find((tr) => tr.textContent.includes('kim')).querySelector('button').click()`);
    await users.until(`document.getElementById('userDialog').open`);
    await users.eval(`document.getElementById('userSave').click()`);
    report(!!(await users.until(`(document.getElementById('agmToast') || {}).textContent === 'Saved — nothing changed.'`)) && !!(await users.eval(`AGM.api('GET', '/api/users').then((r) => r.users.find((u) => u.username === 'kim').halls.includes('GONE01'))`)), 'an untouched Save on the accounts page is no change, a removed hall\'s code included');
    // One's own row: the name is one's own; role, halls, rights, Turn off and Remove are shown and not offered, and a Save
    // sends what the server takes from oneself (the name alone).
    await users.until(`!document.getElementById('userDialog').open`);
    await users.eval(`(() => { document.getElementById('agmToast').textContent = ''; [...document.querySelectorAll('#userRows tr')].find((tr) => tr.querySelector('td .muted').textContent.split(' ')[0] === 'ana').querySelector('button').click(); })()`);
    await users.until(`document.getElementById('userDialog').open`);
    const selfForm = await users.eval(`JSON.stringify({ name: !document.getElementById('uName').disabled, role: document.getElementById('uRole').disabled, every: document.getElementById('uAll').disabled, halls: [...document.querySelectorAll('#uHalls input')].every((c) => c.disabled), rights: [...document.querySelectorAll('#uCaps input')].every((c) => c.disabled), off: document.getElementById('disableBtn').hidden, remove: document.getElementById('removeBtn').hidden })`);
    await users.eval(`document.getElementById('userSave').click()`);
    const selfSaved = await users.until(`(document.getElementById('agmToast') || {}).textContent === 'Saved — nothing changed.' && !document.getElementById('userDialog').open`, 5000);
    report(selfForm === JSON.stringify({ name: true, role: true, every: true, halls: true, rights: true, off: true, remove: true }) && !!selfSaved, `one's own row: a Save is taken; role, halls, rights, Turn off and Remove are not offered (${selfForm}${selfSaved ? '' : '; ' + (await users.eval(`document.getElementById('userError').textContent`))})`);
    const hallView = await edge.tab(`${base}/app.html?code=${code}&as=account&role=research`);
    report(!!(await hallView.until(`typeof joined !== "undefined" && joined && document.getElementById('whoami').textContent.startsWith('Ana Admin')`)), 'an account opens its hall with its own name');

    // Screens: the account adds one from the hall's Screens console; its link opens a display page that shows a message
    // (fitted to the screen) and the countdown, and confirms each — the console then reads ✓ on screen.
    report(!!(await hallView.until(`!document.getElementById('screensBtn').hidden`)), 'the hall view offers Screens to an account that may drive them');
    const made = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Lectern monitor' }, r))`);
    const screen = await edge.tab(`${base}${made.display.path}`);
    report(!!(await screen.until(`document.body.dataset.kind === 'holding' && document.getElementById('idleName').textContent.includes('Lectern monitor')`)), 'a display link opens a holding screen named for the crew');
    await hallView.eval(`new Promise((r) => socket.emit('display:take', { id: '${made.display.id}', content: { kind: 'message', text: 'Five minutes — please wrap up', tone: 'warn' } }, r))`);
    report(!!(await screen.until(`document.body.dataset.kind === 'message' && document.getElementById('messageText').textContent.includes('please wrap up') && parseFloat(document.getElementById('messageText').style.fontSize) > 40`)), 'the screen shows the message, fitted large');
    await sleep(400);
    await screen.shot(path.join(OUT, 'screen-message.png'));
    report(!!(await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays[0].state === 'shown')))`)), 'the console reads ✓ on screen once the screen confirmed it');
    await hallView.eval(`document.getElementById('screensBtn').click()`);
    await hallView.until(`document.getElementById('screensDialog').open && document.querySelectorAll('.screen-item').length === 1`);
    await sleep(300);
    await hallView.shot(path.join(OUT, 'screens-console.png'));
    await hallView.eval(`new Promise((r) => socket.emit('display:take', { id: '${made.display.id}', content: { kind: 'countdown', text: 'Q&A is next', tone: 'info' } }, r))`);
    report(!!(await screen.until(`document.body.dataset.kind === 'countdown' && document.getElementById('cdTime').textContent === '--:--' && !document.getElementById('cdStrip').hidden`)), 'with no Stagewatch, the countdown never shows a confident time; the strip carries the message');
    await sleep(300);
    await screen.shot(path.join(OUT, 'screen-countdown.png'));

    // The countdown's strip never covers the time it sits under: on an upright tablet, a 4:3 screen and a wide one; with
    // the operator's words, and with a long message from Stagewatch.
    const takeOn = (id, content) => hallView.eval(`new Promise((r) => socket.emit('display:take', { ids: [${codeLiteral(id)}], content: ${codeLiteral(content)} }, r))`);
    const STRIP = `(() => { const s = document.getElementById('cdStrip'); const t = document.getElementById('cdTime').getBoundingClientRect(); const n = document.getElementById('cdNext');
      return { hidden: s.hidden, top: Math.round(s.getBoundingClientRect().top), above: Math.round(Math.max(t.bottom, n.textContent ? n.getBoundingClientRect().bottom : 0)), text: document.getElementById('cdText').textContent }; })()`;
    const words156 = 'Please wrap up now: the next speaker is waiting in the wings, the panel starts at half past and the coffee break is cut to ten minutes today. Thank you all.';
    await takeOn(made.display.id, { kind: 'countdown', text: words156, tone: 'warn' });
    await screen.until(`document.getElementById('cdText').textContent.startsWith('Please wrap up now')`);
    for (const [w, h] of [[768, 1024], [810, 1080], [1024, 768], [1920, 1080]]) {
      await screen.resize(w, h);
      await sleep(400);
      const m = await screen.eval(STRIP);
      report(!m.hidden && m.top >= m.above, `${w}x${h}: the countdown's strip (${words156.length} characters) sits below the time (strip top ${m.top}, time bottom ${m.above})`);
      if (w === 768) await screen.shot(path.join(OUT, 'screen-strip-tablet.png'));
    }
    sw = await fakeStagewatch({ name: 'Smoke timer' });
    await hallView.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: '${sw.url}', stagewatchKey: '${KEY}' }, r))`);
    await takeOn(made.display.id, { kind: 'countdown' });
    await screen.until(`document.getElementById('cdTime').textContent === '05:00'`);
    const speaker = ('The panel has asked for five more minutes on this topic, so please hold your closing slide until the moderator gives the sign. ').repeat(5).slice(0, 500);
    sw.frame({ message: speaker });
    await screen.until(`document.getElementById('cdText').textContent.length === ${speaker.length}`);
    await sleep(400);
    const sm = await screen.eval(STRIP);
    report(!sm.hidden && sm.text === speaker && sm.top >= sm.above, `1920x1080: Stagewatch's ${speaker.length}-character message in the strip sits below the time (strip top ${sm.top}, time bottom ${sm.above})`);
    await screen.send('Emulation.clearDeviceMetricsOverride');

    // A key Stagewatch stops listing is refused at the link's next authenticated read: the screen's countdown dims to
    // --:--, the halls board marks the hall ✕ in Stagewatch's words, its Set up says so, and the hall offers 🖥 no more.
    sw.key = 'swk_smoke_revoked_key_0002';   // secret-scan: fixture — the operator revoked AGMessage's key
    const dimmed = await screen.until(`document.getElementById('cdTime').textContent === '--:--'`, 10000);
    const marked = await signin.until(`(() => { const r = document.querySelector('.hall-row[data-code="${code}"]'); return !!r && r.dataset.state === 'refused' && r.querySelector('.hall-state').textContent.includes('✕ Stagewatch refused the key'); })()`, 8000);
    const noSend = await research.until(`!CAN_STAGE`, 5000);
    await signin.eval(`document.querySelector('.hall-setup[data-code="${code}"]').click()`);
    const said = await signin.until(`document.getElementById('setupDialog').open && document.getElementById('setupStatus').textContent`, 5000);
    await signin.shot(path.join(OUT, 'halls-key-refused.png'));
    await signin.eval(`document.getElementById('setupDialog').close()`);
    report(!!dimmed && !!marked && !!noSend && /^Its own link: key refused: unknown or revoked API key/.test(said || ''), `a revoked key: the screen shows --:--, the board ✕, 🖥 is withdrawn, Set up says "${said}"`);
    // Listed again and entered again, it is linked at once (left alone, the link asks again after Stagewatch's lockout minute).
    sw.key = null;
    await hallView.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: '' }, r))`);
    await hallView.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: '${sw.url}', stagewatchKey: '${KEY}' }, r))`);
    report(!!(await screen.until(`document.getElementById('cdTime').textContent === '05:00'`, 8000)) && !!(await research.until(`CAN_STAGE`, 5000)), 'the key entered again: the countdown and 🖥 are back');

    // The clock shows AGMessage's time of day, though the screen's computer is set to another zone; a browser that knows
    // no zone but its own still shows a clock.
    await screen.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
    await takeOn(made.display.id, { kind: 'clock' });
    await screen.until(`document.body.dataset.kind === 'clock' && /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(document.getElementById('clockTime').textContent)`);
    const [zone, clock] = await screen.eval(`[Intl.DateTimeFormat().resolvedOptions().timeZone, document.getElementById('clockTime').textContent]`);
    const hourThere = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: SERVER_TZ, hour: '2-digit', hourCycle: 'h23' }).format(t));
    report(zone === 'America/New_York' && [hourThere(Date.now() - 3000), hourThere(Date.now())].includes(Number(clock.slice(0, 2)) % 24), `a screen set to ${zone} shows the server's time of day in ${SERVER_TZ} (${clock})`);
    const foyerMade = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Foyer TV' }, r))`);
    const foyer = await edge.tab(`${base}${foyerMade.display.path}`, { init: NO_ZONES });
    await foyer.until(`document.body.dataset.kind === 'holding'`);
    await takeOn(foyerMade.display.id, { kind: 'clock' });
    report(!!(await foyer.until(`document.body.dataset.kind === 'clock' && /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(document.getElementById('clockTime').textContent)`, 5000)), 'a browser that does not know the server\'s zone still shows a clock (its own zone)');

    // Files over a slow network: a deck taken first, still loading when the agenda is taken, never paints over the agenda
    // (nor does a slow image appear beside it). Then a deck stepped through: one pdf.js worker, the slide never blanked to
    // redraw, a rename leaving it alone; and a page past the end is said beside ✓.
    const upload = (name, mime, buf) => hallView.eval(`(async () => {
      const bytes = Uint8Array.from(atob('${buf.toString('base64')}'), (c) => c.charCodeAt(0));
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type: '${mime}' }), '${name}');
      const up = await (await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } })).json();
      await new Promise((r) => socket.emit('message', { type: 'file', url: up.url, filename: '${name}', mime: '${mime}' }, r));
      return up.url;
    })()`);
    const deck = await upload('deck.pdf', 'application/pdf', colourPdf(Array.from({ length: 6 }, (_, i) => ({ w: 800, h: 450, rgb: '0 0 1', text: 'Deck ' + (i + 1) }))));
    const agenda = await upload('agenda.pdf', 'application/pdf', colourPdf([1, 2].map((n) => ({ w: 450, h: 800, rgb: '0 1 0', text: 'Agenda ' + n }))));
    const photo = await upload('photo.png', 'image/png', colourPng(64, 36, [255, 0, 0]));
    const sponsor = await upload('sponsor.png', 'image/png', colourPng(64, 36, [0, 0, 255]));
    const projMade = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Projector' }, r))`);
    const projId = projMade.display.id;
    const proj = await edge.tab(`${base}${projMade.display.path}`, { init: NO_RESOLVERS + SCREEN_PROBE, workerInit: NO_RESOLVERS, metrics: { width: 1280, height: 720 } });
    await proj.until(`document.body.dataset.kind === 'holding'`);
    const projStatus = () => hallView.eval(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.find((d) => d.id === '${projId}'))))`);
    const shownAt = async (seq, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const s = await projStatus(); if (s && s.state === 'shown' && s.seq === seq) return s; await sleep(200); } return null; };

    await proj.hold('*deck.pdf*', 2500);
    await takeOn(projId, { kind: 'file', url: deck, name: 'deck.pdf', page: 2 });
    await sleep(300);
    const agendaTake = await takeOn(projId, { kind: 'file', url: agenda, name: 'agenda.pdf', page: 1 });
    const agendaShown = await shownAt(agendaTake.seq);
    await sleep(4000);   // the deck's request is let through and its render (if any) finishes
    let seen = await proj.eval(FILE_SEEN);
    let st = await projStatus();
    report(!!agendaShown && st.state === 'shown' && st.seq === agendaTake.seq && seen.canvas && !seen.img && seen.h > seen.w && seen.rgb[1] > 200 && seen.rgb[2] < 50,
      `a slow deck taken first never paints over the agenda taken after it (console ${st.mark} ${st.words}, seq ${st.seq}; canvas ${seen.w}x${seen.h} rgb ${seen.rgb})`);
    await proj.shot(path.join(OUT, 'screen-pdf.png'));
    await proj.release();
    await proj.hold('*photo.png*', 2500);
    await takeOn(projId, { kind: 'file', url: photo, name: 'photo.png' });
    await sleep(300);
    const backTake = await takeOn(projId, { kind: 'file', url: agenda, name: 'agenda.pdf', page: 1 });
    await shownAt(backTake.seq);
    await sleep(4000);
    seen = await proj.eval(FILE_SEEN);
    report(seen.canvas && !seen.img && seen.rgb[1] > 200, `a slow image taken first does not appear beside the PDF taken after it (image ${seen.img ? 'visible' : 'hidden'}, canvas ${seen.canvas ? 'visible' : 'hidden'})`);
    await proj.release();

    let stepped = true;
    for (let p = 1; p <= 6; p++) { const t = await takeOn(projId, { kind: 'file', url: deck, name: 'deck.pdf', page: p }); stepped = stepped && !!(await shownAt(t.seq)); await sleep(150); }
    const atSix = await proj.eval(`({ ...window.__canvas })`);
    for (const n of ['Projector A', 'Projector']) { await hallView.eval(`new Promise((r) => socket.emit('display:update', { id: '${projId}', name: '${n}' }, r))`); await sleep(600); }
    const probe = await proj.eval(`({ workers: window.__workers.made - window.__workers.ended, ...window.__canvas })`);
    seen = await proj.eval(FILE_SEEN);
    st = await projStatus();
    report(stepped && probe.workers <= 1, `a screen stepping through a deck keeps one pdf.js worker (${probe.workers} running)`);
    const projResolvers = await proj.eval(`[window.__resolversAtStart, typeof Promise.withResolvers]`);
    const projWorker = await pdfWorkers(proj);
    report(stepped && projResolvers[0] === 'undefined' && projResolvers[1] === 'function' && projWorker.ok,
      `a screen with no Promise.withResolvers in the page or in pdf.js's worker (as an iPad before 17.4) draws every page of the deck through pdf.js's legacy build, which defines it in each (page began ${projResolvers[0]}, now ${projResolvers[1]}; worker ${JSON.stringify(projWorker)})`);
    report(probe.blank === 0 && probe.resized === atSix.resized && st.state === 'shown' && seen.canvas && seen.w > seen.h && seen.rgb[2] > 200,
      `the slide on air is never blanked to be redrawn, and a rename leaves it alone (${probe.blank} blank frames; ${probe.resized - atSix.resized} redraws on rename; console ${st.mark} ${st.words})`);
    // A canvas whose GPU context the browser lost comes back blank: the slide is drawn again, and a rename after it is
    // not answered "shown" from what the canvas held before.
    await proj.eval(`(() => { const c = document.getElementById('fileCanvas'); c.dispatchEvent(new Event('contextlost'));
      c.getContext('2d').clearRect(0, 0, c.width, c.height); c.dispatchEvent(new Event('contextrestored')); })()`);
    const BLUE_AGAIN = `(() => { const c = document.getElementById('fileCanvas'); const p = c.getContext('2d').getImageData(c.width >> 1, 4, 1, 1).data; return !c.hidden && p[2] > 200; })()`;
    const restored = !!(await proj.until(BLUE_AGAIN, 5000));
    await proj.eval(`(() => { const c = document.getElementById('fileCanvas'); c.dispatchEvent(new Event('contextlost')); c.getContext('2d').clearRect(0, 0, c.width, c.height); })()`);
    await hallView.eval(`new Promise((r) => socket.emit('display:update', { id: '${projId}', name: 'Projector B' }, r))`);
    const afterLoss = !!(await proj.until(BLUE_AGAIN, 5000));
    await hallView.eval(`new Promise((r) => socket.emit('display:update', { id: '${projId}', name: 'Projector' }, r))`);
    report(restored && afterLoss, `a slide whose canvas lost its GPU context is drawn again, never taken as still on screen (on restore: ${restored ? 'drawn' : 'blank'}; on a rename while lost: ${afterLoss ? 'drawn' : 'blank'})`);
    const pastEnd = await takeOn(projId, { kind: 'file', url: agenda, name: 'agenda.pdf', page: 7 });
    const pastSt = await shownAt(pastEnd.seq);
    report(!!pastSt && /^on screen: the PDF has 2 pages: showing the last$/.test(pastSt.words), `a page past the end: the screen's note reaches the console beside ✓ (${pastSt && pastSt.mark} ${pastSt && pastSt.words} — ${pastSt && pastSt.showing})`);
    // A PDF whose download fails while a newer take is on screen loads afresh when it is taken again; one that fails on
    // screen leaves black under the △, never the page before it.
    const late = await upload('late.pdf', 'application/pdf', colourPdf([{ w: 800, h: 450, rgb: '1 0 0', text: 'Late' }]));
    proj.expectFailure(/late\.pdf$|missing\.pdf$/);
    await proj.hold('*late.pdf*', 1200, true);
    await takeOn(projId, { kind: 'file', url: late, name: 'late.pdf', page: 1 });
    await sleep(300);
    await takeOn(projId, { kind: 'black' });
    await sleep(2000);
    await proj.release();
    const lateAgain = await takeOn(projId, { kind: 'file', url: late, name: 'late.pdf', page: 1 });
    const lateSt = await shownAt(lateAgain.seq, 8000);
    seen = await proj.eval(FILE_SEEN);
    report(!!lateSt && seen.canvas && seen.rgb[0] > 200, `a PDF whose download failed under a newer take shows when taken again (console ${lateSt ? lateSt.mark + ' ' + lateSt.words : 'not ✓'})`);
    const missing = await takeOn(projId, { kind: 'file', url: '/uploads/1777424589360-onmqm0a3ew2r-missing.pdf', name: 'missing.pdf', page: 1 });
    const missEnd = Date.now() + 8000;
    while (Date.now() < missEnd && (st = await projStatus()).state !== 'error') await sleep(200);
    seen = await proj.eval(FILE_SEEN);
    report(st.state === 'error' && st.seq === missing.seq && !seen.canvas && !seen.img, `a PDF that does not render says △ and leaves black, not the page before it (${st.mark} ${st.words}; canvas ${seen.canvas ? 'visible' : 'hidden'})`);

    // The Screens console: a page typed for one PDF is not carried to the next one offered; a take on every ticked screen
    // is one request, and a screen it could not reach is named; a holding image picked but not saved survives refreshes.
    await hallView.until(`document.getElementById('screensDialog').open || (document.getElementById('screensBtn').click(), false)`);
    const pageField = await hallView.eval(`(() => { const f = (n) => allMessages.find((m) => m.filename === n); Screens.offer(f('deck.pdf')); document.getElementById('pendingPage').value = '7'; Screens.offer(f('agenda.pdf')); return document.getElementById('pendingPage').value; })()`);
    report(pageField === '1', `a page typed for one PDF does not carry over to the next one offered (the field reads ${pageField})`);
    await hallView.eval(`document.getElementById('pendingCancel').click()`);
    const spare = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Spare' }, r))`);
    await hallView.until(`[...document.querySelectorAll('.screen-item strong')].some((e) => e.textContent === 'Spare')`);
    await hallView.eval(`(() => { window.__takes = 0; const emit = socket.emit; socket.emit = function (ev, ...a) { if (ev === 'display:take') window.__takes++; return emit.call(this, ev, ...a); };
      const all = document.getElementById('screensAll'); if (all.checked) all.click(); all.click(); })()`);
    // Spare is removed just before the take reaches the server: the console still lists it, the server refuses it.
    await hallView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = '';
      socket.emit('display:remove', { id: '${spare.display.id}' }); document.querySelector('.screens-bar [data-take="black"]').click(); })()`);
    const allBlack = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.length >= 3 && x.displays.every((d) => d.content.kind === 'black'))))`, 5000);
    const toast = await hallView.until(`(document.getElementById('agmToast') || {}).textContent`, 3000);
    const takes = await hallView.eval(`window.__takes`);
    report(!!allBlack && takes === 1 && /^Sent to 3 of 4 screens/.test(toast) && /Spare/.test(toast), `"All" then Black: one request reaches every screen, the one it could not is named (${takes} request; "${toast}")`);
    await hallView.until(`document.getElementById('holdingPick').options.length >= 3`);
    await hallView.eval(`(() => { const p = document.getElementById('holdingPick'); p.value = '${sponsor}'; p.dispatchEvent(new Event('change')); })()`);
    // A marker in the list: the console's next refresh (another hand's take, here) empties it.
    await hallView.eval(`(() => { const m = document.createElement('li'); m.id = 'refreshMarker'; document.getElementById('screenList').appendChild(m); })()`);
    await takeOn(made.display.id, { kind: 'clock' });
    await hallView.until(`!document.getElementById('refreshMarker') && [...document.querySelectorAll('.screen-showing')].some((e) => e.textContent === 'the clock')`);
    const keptOnRefresh = await hallView.eval(`document.getElementById('holdingPick').value`);
    await hallView.eval(`document.getElementById('screensAll').click()`);
    const keptOnTick = await hallView.eval(`document.getElementById('holdingPick').value`);
    await hallView.eval(`document.getElementById('holdingSave').click()`);
    const saved = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.holding)))`, 5000);
    report(keptOnRefresh === sponsor && keptOnTick === sponsor && saved === sponsor, `a holding image picked but not yet saved survives the console's refreshes, and "Use it" saves it (${[keptOnRefresh, keptOnTick, saved].map((u) => (u || 'none').split('-').pop()).join(' / ')})`);
    // A pick left unsaved when the dialog closes is gone when it opens again, however it opens (here from ⧉ on a file).
    const reopened = await hallView.eval(`(async () => { const p = document.getElementById('holdingPick'); p.value = ''; p.dispatchEvent(new Event('change'));
      document.getElementById('screensClose').click(); await new Promise((r) => setTimeout(r, 100));
      Screens.offer(allMessages.find((m) => m.filename === 'agenda.pdf'));
      const v = document.getElementById('holdingPick').value; document.getElementById('pendingCancel').click(); return v; })()`);
    report(reopened === sponsor, `a holding pick left unsaved when the dialog closed does not come back when ⧉ opens it again (it reads ${(reopened || 'none').split('-').pop()})`);
    await sleep(300);
    await hallView.shot(path.join(OUT, 'screens-console-after.png'));


    // Rights inside a hall: the admin's room list offers no role select for an account; a Viewer's halls board opens a
    // help request's hall read only, and an old link that says research opens again as the server seats it — with no
    // composer, pin, reaction or answer offered. A help request offers no forward.
    await admin.eval(`watchRoom('${code}')`);
    report(!!(await admin.until(`Array.from(document.querySelectorAll('#usersTbody tr')).some((tr) => tr.textContent.includes('Ana Admin') && !tr.querySelector('.role-select') && tr.querySelector('.role-fixed')) && !!document.querySelector('#usersTbody .role-select')`)), 'the admin\'s room list: an account\'s role is its rights (no select), a code guest\'s has one');
    await admin.shot(path.join(OUT, 'admin-room.png'));
    await research.eval(`Promise.all([new Promise((r) => socket.emit('message', { type: 'help', category: 'Sound', text: 'radio mic 3 dead' }, r)), new Promise((r) => socket.emit('message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] }, r))])`);
    report(!!(await research.until(`(() => { const h = document.querySelector('.msg[data-type="help"] .fwd-btn'); const t = Array.from(document.querySelectorAll('.msg[data-type="text"] .fwd-btn')); return h && h.hidden && t.length && t.every((b) => !b.hidden); })()`)), 'a help request offers no forward; a message does');
    // A page opened before its hall had a Stagewatch offers 🖥 once it has one (the server's answer, asked again when the
    // link's state changes).
    report(!!(await research.until(`CAN_STAGE && [...document.querySelectorAll('.msg[data-type="text"] .stage-btn')].some((b) => !b.hidden)`)), 'a page opened before its hall had a Stagewatch offers 🖥 once it has one');
    const made2 = await signin.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic', name: 'Vic Viewer', role: 'viewer', halls: ['${code}'], password: 'only looking at screens' }) }).then((r) => r.status)`);
    const madeSid = await signin.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sid', name: 'Sid Staff', role: 'staff', halls: ['${code}'], password: 'cable ties and gaffer' }) }).then((r) => r.status)`);
    // A Patterns linked for the hall: its chip is on the hall's row for everyone who sees the hall; Show network, which
    // opens what that account may drive, only for those who may drive it (the admin here, not the Viewer).
    patterns = await fakeNode({ name: 'Smoke Patterns' });
    await hallView.eval(`new Promise((r) => socket.emit('nodes:link', { id: 'smokepat', t: 'patterns', url: '${patterns.url}', token: 'node-token', hall: ROOM, name: 'Smoke Patterns' }, r))`);
    report(!!(await signin.until(`!document.getElementById('networkBtn').hidden && document.body.textContent.includes('Smoke Patterns')`)), 'the admin\'s halls board offers Show network once a Patterns is linked');
    // AG-1: AGMessage holds only a node's pairing token, so the Show network dialog only proposes to the show desk.
    await signin.eval(`document.getElementById('networkBtn').click()`);
    const netButtons = await signin.until(`(() => { const c = document.querySelector('#networkDialog[open] #networkList .node-card'); return c ? JSON.stringify([...c.querySelectorAll('button')].map((x) => x.textContent)) : ''; })()`);
    await signin.eval(`document.getElementById('networkDialog').close()`);
    report(netButtons === JSON.stringify(['Propose']), `Show network only proposes a node's verbs to the show desk — nothing drives it directly (${netButtons})`);
    // The admin page signed this browser in with the host's admin token: from here its pages are judged by the accounts
    // they sign in with alone (the pages already open keep their connections).
    await signin.send('Network.deleteCookies', { name: 'agm_admin', url: base + '/' });
    const vicIn = await signin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic', password: 'only looking at screens' }) }).then((r) => r.status)`);
    const viewerBoard = await edge.tab(`${base}/halls.html`);
    const helpHref = await viewerBoard.until(`(() => { const a = document.querySelector('#helpStrip:not([hidden]) .help-item a'); return a ? a.getAttribute('href') : ''; })()`);
    report(made2 === 200 && vicIn === 200 && /role=observer/.test(helpHref || ''), `a Viewer's help strip opens the hall read only (${helpHref})`);
    const viewerNet = await viewerBoard.until(`Array.from(document.querySelectorAll('.node-chip')).some((c) => c.textContent.includes('Smoke Patterns')) && JSON.stringify({ chip: true, button: !document.getElementById('networkBtn').hidden })`);
    report(viewerNet === JSON.stringify({ chip: true, button: false }), `a Viewer sees the hall's Patterns on its row and is not offered Show network (${viewerNet})`);
    const viewerHall = await edge.tab(`${base}/app.html?code=${code}&as=account&role=research`);
    report(!!(await viewerHall.until(`location.search.includes('role=observer') && typeof joined !== 'undefined' && joined && allMessages.some((m) => m.type === 'action')`)), 'an old link that says research opens again as the Viewer is seated: observer');
    const shown = await viewerHall.eval(`(() => {
      const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]');
      return JSON.stringify({
        composer: visible(document.getElementById('researchCompose')) || visible(document.getElementById('directorCompose')),
        stage: visible(document.getElementById('stageToggleBtn')),
        pin: Array.from(document.querySelectorAll('.msg .pin-btn')).some(visible),
        react: Array.from(document.querySelectorAll('.msg .react-btn')).some(visible),
        answer: Array.from(document.querySelectorAll('.action-btn')).some((b) => !b.disabled),
        replyText: !!document.querySelector('.reply-text-btn'),
      });
    })()`);
    report(shown === JSON.stringify({ composer: false, stage: false, pin: false, react: false, answer: false, replyText: false }), `the Viewer is offered nothing the server refuses (${shown})`);
    await viewerHall.shot(path.join(OUT, 'hall-viewer.png'));
    // A stage send the server no longer follows (its Stagewatch restarted, or the hall moved) reads so, never "waiting".
    const lostLine = await research.eval(`stageLineText({ ack: 'lost', receipt: 'applied' })`);
    report(/^✕ No longer followed/.test(lostLine || ''), `a stage send no longer followed says so (${lostLine})`);

    // A Staff account (messages and files, no Stagewatch) is seated backstage: while the hall's Stagewatch keeps a show
    // desk and its frames move, it is offered neither 📝 nor 🖥 — the server would refuse both.
    const sidIn = await signin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sid', password: 'cable ties and gaffer' }) }).then((r) => r.status)`);
    const staffHall = await edge.tab(`${base}/app.html?code=${code}&as=account&role=research`);
    const staffIn = await staffHall.until(`typeof joined !== 'undefined' && joined && document.getElementById('whoami').textContent.startsWith('Sid Staff') && !document.getElementById('stageChip').hidden`);
    sw.frame({ text: '04:58', seconds: 298 });
    await staffHall.until(`document.getElementById('stageTime').textContent === '04:58'`);
    await sleep(500);
    const staffShown = await staffHall.eval(`JSON.stringify({ who: document.getElementById('whoami').textContent, role: document.body.dataset.role, texts: allMessages.some((m) => m.type === 'text'), propose: CAN_PROPOSE, send: CAN_STAGE, buttons: [...document.querySelectorAll('.msg .propose-btn, .msg .stage-btn')].filter((b) => !b.hidden).length })`);
    report(madeSid === 200 && sidIn === 200 && !!staffIn && staffShown === JSON.stringify({ who: 'Sid Staff · Staff', role: 'research', texts: true, propose: false, send: false, buttons: 0 }), `a Staff account is offered neither 📝 nor 🖥 while the hall's Stagewatch keeps a desk and its frames move (${madeSid} ${sidIn} ${staffShown})`);

    // A change is drawn the same way by a page that hears it live and by one that reads it among the changes it missed,
    // both from the hall page's one op table: here the show desk's answer to a proposal, on a message whose record the
    // page no longer holds (its line drawn on the message), and on the proposal's own line. The board's page is live
    // when the desk answers; the research page is away, and resumes.
    const proposed = JSON.parse(await research.eval(`(async () => {
      const sent = await new Promise((r) => socket.emit('message', { type: 'text', text: 'Two minutes left, please' }, r));
      const p = await new Promise((r) => socket.emit('stage:propose', { text: 'Two minutes left, please', destination: 'speaker', messageId: sent.id }, r));
      return JSON.stringify({ id: sent.id, ok: !!p.ok, pid: (p.proposal && p.proposal.id) || '', error: p.error || '' });
    })()`));
    const PROPOSAL_LINE = `(() => { const s = allMessages.find((m) => m.type === 'system' && m.proposal && m.proposal.id === ${codeLiteral(proposed.pid)}); return s ? messagesById.get(s.id) : null; })()`;
    const pending = `(() => { const m = findMessage(${codeLiteral(proposed.id)}); return !!m && !!m.proposal && m.proposal.state === 'pending' && !!messagesById.get(m.id) && !!${PROPOSAL_LINE}; })()`;
    const bothPending = !!(await research.until(pending, 8000)) && !!(await board.until(pending, 8000));
    // Each page lets go of the message's record and keeps the message drawn.
    const forget = `(() => { const i = allMessages.findIndex((m) => m.id === ${codeLiteral(proposed.id)}); if (i >= 0) allMessages.splice(i, 1); return !findMessage(${codeLiteral(proposed.id)}) && messagesById.has(${codeLiteral(proposed.id)}); })()`;
    const forgot = (await research.eval(forget)) && (await board.eval(forget));
    await signin.send('Network.deleteCookies', { name: 'agm_s', url: base + '/' });   // a guest's own device holds no sign-in
    await research.eval(`socket.disconnect()`);
    const atDesk = sw.proposals.get(proposed.pid);
    if (atDesk) Object.assign(atDesk, { state: 'rejected', decided: Date.now(), decidedBy: 'Smoke desk' });
    // Read once both lines have left "waiting": a page that draws the answer on one of them only never reads as drawn.
    const DRAWN = `(() => { const line = (n) => { const l = n && n.querySelector('.proposal-line'); return l && l.dataset.state !== 'pending' ? l.dataset.state + ' ' + l.textContent : ''; };
      const on = line(messagesById.get(${codeLiteral(proposed.id)})), own = line(${PROPOSAL_LINE}); return on && own ? JSON.stringify({ on, own }) : ''; })()`;
    const live = await board.until(DRAWN, 12000);
    await research.eval(`socket.connect()`);
    const resumed = await research.until(`socket.connected && ${DRAWN}`, 12000);
    // One listener for each row of the table: the generated ones, and no hand-written one beside them.
    const listeners = await board.eval(`JSON.stringify(Object.keys(UPD_EVENTS).map((f) => socket.listeners(UPD_EVENTS[f][0]).length))`);
    report(proposed.ok && bothPending && forgot && !!atDesk && live === JSON.stringify({ on: 'rejected ✗ Not approved by Smoke desk', own: 'rejected ✗ Not approved by Smoke desk' }) && resumed === live && listeners === '[1,1,1,1,1,1]',
      `a live page and a resumed one draw the desk's answer the same way, on a message whose record is gone and on the proposal's line (${JSON.stringify(proposed)}; ${bothPending} ${forgot}; live ${live}; resumed ${resumed}; listeners ${listeners})`);
    for (const p of [research, board]) await p.eval(`removeMessageLocal(${codeLiteral(proposed.id)})`);

    // A page away while its hall loses its Stagewatch: back (it resumes from what it missed), the messages it had drawn
    // offer 🖥 no more.
    const sendsBefore = await research.eval(`[...document.querySelectorAll('.msg[data-type="text"] .stage-btn')].filter((b) => !b.hidden).length`);
    // The research page stands for a guest's own device, which holds no account's sign-in: the accounts signed in on this
    // browser since it joined leave the cookie jar before it connects again (a signed-in browser is refused a code join).
    // The pages already open keep their connections.
    await signin.send('Network.deleteCookies', { name: 'agm_s', url: base + '/' });
    await research.eval(`socket.disconnect()`);
    const removed = await hallView.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: '' }, (x) => r(!!(x && x.ok))))`);
    await research.eval(`socket.connect()`);
    const back = await research.until(`socket.connected && joined && !CAN_STAGE && JSON.stringify({ shown: [...document.querySelectorAll('.msg[data-type="text"] .stage-btn')].filter((b) => !b.hidden).length })`, 8000);
    report(sendsBefore > 0 && removed && back === JSON.stringify({ shown: 0 }), `a page back from a drop while its hall lost its Stagewatch offers 🖥 no more (${sendsBefore} before; ${removed}; ${back})`);

    // Signing in follows ?next= only to AGMessage's own pages: a script URL or another site lands on the halls board, and
    // one of our pages keeps the query it asked for.
    const landings = [];
    // eslint-disable-next-line no-script-url -- the check is that a script URL in ?next= is never followed
    const scriptUrl = 'javascript:alert(document.domain)';
    for (const next of [scriptUrl, '//evil.example/x', '/app.html?code=' + code + '&as=account&role=observer']) {
      await signin.send('Network.deleteCookies', { name: 'agm_s', url: base + '/' });
      const entry = await edge.tab(`${base}/?next=${encodeURIComponent(next)}`);
      await entry.until(`typeof document.getElementById('signInPane') === 'object' && !document.getElementById('signInPane').hidden`);
      await entry.eval(`(() => { document.getElementById('username').value = 'ana'; document.getElementById('password').value = 'the green room kettle'; document.getElementById('signInPane').requestSubmit(); })()`);
      landings.push((await entry.until(`location.pathname !== '/' && location.pathname + '|' + (new URLSearchParams(location.search).get('code') || '')`, 8000)) || 'stayed on the sign-in page');   // the hall page sets the role the server gives
      landings.push(entry.problems.length ? 'script errors: ' + entry.problems.slice(0, 2).join(' | ') : 'clean');
      entry.close();
    }
    report(JSON.stringify(landings) === JSON.stringify(['/halls.html|', 'clean', '/halls.html|', 'clean', '/app.html|' + code, 'clean']), `signing in follows ?next= only to AGMessage's own pages (${landings.join(', ')})`);

    // A signed-in browser (Ana, from the last sign-in) enters by its account: a code link offers its halls or Sign out,
    // not the code; a guest's hall link (an invite's) is refused by the server in the same words, seats nobody and lands
    // on its code link, the code and the invite kept; signed out, the code link joins as a guest.
    const codeLink = await edge.tab(`${base}/?code=${code}`);
    const offered = await codeLink.until(`(() => { const p = document.getElementById('signedInPane'); return !p.hidden && document.getElementById('joinForm').hidden && document.getElementById('tabCode').classList.contains('active') && document.activeElement === document.getElementById('openHalls') && JSON.stringify({ text: document.getElementById('signedInText').textContent, halls: document.getElementById('openHalls').getAttribute('href') }); })()`);
    report(offered === JSON.stringify({ text: 'You are signed in as Ana Admin: open your halls, or sign out to join with a code.', halls: '/halls.html' }), `a code link in a signed-in browser offers its halls or Sign out, not the code (${offered})`);
    const asGuest = await edge.tab(`${base}/app.html?code=${code}&name=Imposter&role=research&invite=smoke-invite`);
    const refusedWith = await asGuest.until(`(() => { const t = document.getElementById('agmToast'); return !!t && t.classList.contains('bad') && !joined && t.textContent; })()`);
    const imposter = await admin.eval(`new Promise((r) => socket.emit('admin:listRooms', (x) => r(x.rooms.find((h) => h.code === '${code}').users.some((u) => u.name === 'Imposter'))))`);
    const landed = await asGuest.until(`location.pathname === '/' && !document.getElementById('signedInPane').hidden && document.getElementById('joinForm').hidden && location.search`, 8000);
    report(refusedWith === 'You are signed in as Ana Admin: open the room from your halls, or sign out to join with a code.' && imposter === false && landed === `?code=${code}&role=research&invite=smoke-invite`, `a guest's hall link in a signed-in browser is refused in the server's words, seats nobody and lands on its code link, which offers the halls or Sign out ("${refusedWith}"; seated: ${imposter}; ${landed})`);
    await codeLink.eval(`document.getElementById('signOutBtn').click()`);
    const codeAgain = await codeLink.until(`(() => { const f = document.getElementById('joinForm'); return !!f && !f.hidden && document.getElementById('signedInPane').hidden && document.getElementById('code').value; })()`, 8000);
    await codeLink.eval(`(() => { document.getElementById('name').value = 'Walk-in'; document.querySelector('input[name="role"][value="observer"]').checked = true; document.getElementById('joinForm').requestSubmit(); })()`);
    const walkedIn = await codeLink.until(`location.pathname === '/app.html' && typeof joined !== 'undefined' && joined && document.body.dataset.role`, 8000);
    report(codeAgain === code && walkedIn === 'observer', `signed out, the same code link joins as a guest (${codeAgain}, ${walkedIn})`);
    // A one-time password not yet changed is a signed-in browser too (the server refuses its code join): a code link opened
    // with one asks for the new password, alone, before anything else.
    const postJson = (route, body) => signin.eval(`fetch('${route}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.json())`);
    const anaAgain = await postJson('/api/auth/login', { username: 'ana', password: 'the green room kettle' });
    const otto = await postJson('/api/users', { username: 'otto', name: 'Otto Once', role: 'staff', halls: [code] });
    await postJson('/api/auth/logout', {});
    const ottoIn = await postJson('/api/auth/login', { username: 'otto', password: otto.password || '' });
    const otpLink = await edge.tab(`${base}/?code=${code}`);
    const otpShown = await otpLink.until(`(() => { const shown = [...document.querySelectorAll('.entry-pane')].filter((p) => !p.hidden).map((p) => p.id); return document.querySelector('.entry-tabs').hidden && document.getElementById('changeUser').value === 'otto' && JSON.stringify(shown); })()`);
    await postJson('/api/auth/logout', {});
    report(anaAgain.ok === true && ottoIn.mustChange === true && otpShown === JSON.stringify(['changePane']), `a code link opened with a one-time password not yet changed asks for the new password, alone (${anaAgain.ok} ${ottoIn.mustChange} ${otpShown})`);

    // The audit log's four marks and Accept, on a second AGMessage whose log came from 0.5.1 (△) and lost its newest entry
    // while it was stopped (✕): an admin account is told where to accept; the token at the laptop accepts, a ✕ only with
    // its own confirmation, and the log reads △, then ◇.
    dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-audit-'));
    fs.writeFileSync(path.join(dataDir2, 'audit.jsonl'), chainOf(5));
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    server2 = await startServer(port2, dataDir2);
    await fetch(base2 + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', name: 'Ana Admin', password: 'the green room kettle' }) });
    await stopServer(server2);
    const kept2 = fs.readFileSync(path.join(dataDir2, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(path.join(dataDir2, 'audit.jsonl'), kept2.slice(0, -1).join('\n') + '\n');
    server2 = await startServer(port2, dataDir2);
    const audit2 = await edge.tab(`${base2}/`);
    await audit2.until('document.readyState === "complete"');
    await audit2.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }).then(() => { location.href = '/users.html#audit'; })`);
    const check2 = async () => {
      await audit2.until(`location.pathname === '/users.html' && !document.getElementById('auditPane').hidden && !document.getElementById('verifyBtn').disabled`);
      await audit2.eval(`(() => { document.getElementById('chainState').dataset.mark = ''; document.getElementById('verifyBtn').click(); })()`);
      return audit2.until(`(() => { const c = document.getElementById('chainState'); return c.dataset.mark && !document.getElementById('verifyBtn').disabled && c.dataset.mark + '|' + c.textContent; })()`);
    };
    const cut2 = await check2();
    report(/^broken\|✕ entry 7 is missing: this machine recorded entry 7; the log ended at entry 6/.test(cut2 || ''), `a log cut while it was stopped reads ✕, with what is missing (${cut2})`);
    const rows2 = await audit2.eval(`[...document.querySelectorAll('#auditList .audit-row')].map((li) => li.querySelector('.audit-mark [aria-hidden]').textContent).join('')`);
    report(rows2 === '✓✓✓△△△△△', `the rows read ✓ under this key (the sign-in, the cut, the boundary) and △ for the 0.5.1 entries (${rows2})`);
    const admin2 = await edge.tab(`${base2}/admin.html`);
    const where2 = await admin2.until(`(() => { const w = document.getElementById('auditWhere'); return !document.getElementById('dashboard').hidden && !w.hidden && document.getElementById('auditAcceptRow').hidden && document.getElementById('auditLine').dataset.mark === 'broken' && w.textContent; })()`, 20000);
    report(where2 === 'Accept this on the AGMessage laptop: sign in there with its token (Admin login in the black window).', `an admin account is told where to accept, and offered no Accept button (${where2})`);
    await admin2.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
    const button2 = await admin2.until(`!document.getElementById('dashboard').hidden && !document.getElementById('auditAcceptRow').hidden && document.getElementById('auditWhere').hidden`, 20000);
    await admin2.eval(`document.getElementById('auditAcceptBtn').click()`);
    const ticks = await admin2.until(`(() => { const boxes = [...document.querySelectorAll('#acceptList input[data-id]')]; return document.getElementById('acceptDialog').open && boxes.length === 2 && boxes.map((b) => b.dataset.id + '=' + b.checked).join(' '); })()`);
    report(!!button2 && ticks === 's1-5=true e7=false', `the token at the laptop is offered Accept, and in its dialog a △ starts ticked and a ✕ unticked (${ticks})`);
    await admin2.shot(path.join(OUT, 'audit-accept.png'));
    // The cut alone, confirmed: △ is what is left.
    await admin2.eval(`(() => { const [plain, cut] = document.querySelectorAll('#acceptList input[data-id]'); plain.checked = false; plain.dispatchEvent(new Event('change')); cut.checked = true; cut.dispatchEvent(new Event('change')); document.querySelector('#acceptList input[data-confirm]').checked = true; document.getElementById('acceptToken').value = '${TOKEN}'; document.getElementById('acceptForm').requestSubmit(); })()`);
    await admin2.until(`!document.getElementById('acceptDialog').open`);
    const left2 = await check2();
    report(/^unvouched\|△ Not vouched for — entries 1–5 have plain hashes, as AGMessage 0\.5\.1 and earlier wrote them/.test(left2 || ''), `the cut accepted with its confirmation, the 0.5.1 entries read △ (${(left2 || '').slice(0, 120)})`);
    await admin2.until(`!document.getElementById('auditAcceptRow').hidden`);
    await admin2.eval(`document.getElementById('auditAcceptBtn').click()`);
    await admin2.until(`document.getElementById('acceptDialog').open && document.querySelectorAll('#acceptList input[data-id]:checked').length === 1`);
    await admin2.eval(`(() => { document.getElementById('acceptToken').value = '${TOKEN}'; document.getElementById('acceptForm').requestSubmit(); })()`);
    await admin2.until(`!document.getElementById('acceptDialog').open`);
    const linked2 = await check2();
    report(/^linked\|◇ Linked — entries 1–5 have plain hashes \(as AGMessage 0\.5\.1 and earlier wrote them\), accepted on the AGMessage laptop on /.test(linked2 || ''), `accepted at the laptop, the log reads ◇, never ✓ (${(linked2 || '').slice(0, 120)})`);
    await audit2.shot(path.join(OUT, 'audit-marks.png'));
    // An entry changed while it was stopped: the check at start finds it, and Health reads ✕ with its line and offers
    // nothing to accept. Health's page is taken off the server while it is stopped, as nobody's would be, so a reconnect
    // that lands while it is down is not read as the page's error.
    await admin2.send('Page.navigate', { url: 'about:blank' });
    await admin2.until(`location.href === 'about:blank'`);
    await stopServer(server2);
    const kept3 = fs.readFileSync(path.join(dataDir2, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean);
    kept3[1] = kept3[1].replace('Lectern screen 2', 'Lectern screen 9');
    fs.writeFileSync(path.join(dataDir2, 'audit.jsonl'), kept3.join('\n') + '\n');
    server2 = await startServer(port2, dataDir2);
    await admin2.send('Page.navigate', { url: `${base2}/admin.html` });
    const broken2 = await admin2.until(`(() => { const l = document.getElementById('auditLine'); const f = document.querySelector('#auditFindings li'); return !document.getElementById('dashboard').hidden && l.dataset.mark === 'broken' && f && f.dataset.mark === 'broken' && document.getElementById('auditAcceptRow').hidden && document.getElementById('auditWhere').hidden && l.textContent + ' | ' + f.textContent; })()`, 20000);
    report(/^Audit log: ✕ keyed \(key [0-9a-f]{16}\) · 1 to see to \| ✕ Broken at line 2 of audit\.jsonl: entry 2 was changed after it was written$/.test(broken2 || ''), `a line changed while it was stopped reads ✕ on Health, with nothing to accept (${broken2})`);
    // A project manager reads the audit log (audit.read) and is offered no Export (audit.export is the admin's).
    await audit2.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }).then(() => fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia', name: 'Mia Manager', role: 'manager', password: 'running order on the wall' }) })).then(() => fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia', password: 'running order on the wall' }) })).then(() => { location.href = '/users.html'; })`);
    const miaAudit = await audit2.until(`location.pathname === '/users.html' && /Mia Manager/.test(document.getElementById('who').textContent) && !document.getElementById('auditPane').hidden && document.querySelectorAll('#auditList .audit-row').length > 0 && String(document.getElementById('exportBtn').hidden)`, 20000);
    report(miaAudit === 'true', `a project manager reads the audit log and is offered no Export (Export hidden: ${miaAudit})`);

    // The audit log carried across events, on a third AGMessage whose log holds an event's archive point at entry 9: the
    // token at the laptop splits it from Health (the point listed, the word typed), Health then names where the check
    // begins, and Accounts → Audit log draws the archive with its mark and checks it on its own.
    dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-split-'));
    fs.mkdirSync(dataDir3 + '-keys', { recursive: true });
    fs.writeFileSync(path.join(dataDir3 + '-keys', 'machine.key'), FIXTURE_KEY.toString('base64'));   // the tests' fixed machine key: the seeded log is this copy's own
    keyedLogWithPoints(12, { file: path.join(dataDir3, 'audit.jsonl'), records: path.join(dataDir3 + '-keys', 'audit'), points: [9] });
    const port3 = await freePort();
    const base3 = `http://127.0.0.1:${port3}`;
    server3 = await startServer(port3, dataDir3);
    await fetch(base3 + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', name: 'Ana Admin', password: 'the green room kettle' }) });
    const admin3 = await edge.tab(`${base3}/admin.html`);
    await admin3.until('document.readyState === "complete"');
    await admin3.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
    await admin3.until(`!document.getElementById('dashboard').hidden && !document.getElementById('auditSplitRow').hidden`, 20000);
    await admin3.eval(`document.getElementById('auditSplitBtn').click()`);
    const pointRow = await admin3.until(`(() => { const r = document.querySelector('#splitList input[type=radio]'); return document.getElementById('splitDialog').open && r && !r.disabled && r.value + '|' + document.querySelector('#splitList li').textContent; })()`);
    report(/^9\|Entry 9 · “Rehearsal 9”, archived \d\d:\d\d on \d+ \w{3}: entries 1–8 move into a signed archive$/.test(pointRow || ''), `Health lists the archive point a split may be made at (${pointRow})`);
    await admin3.eval(`(() => { const r = document.querySelector('#splitList input[type=radio]'); r.checked = true; r.dispatchEvent(new Event('change')); document.getElementById('splitForm').requestSubmit(); })()`);
    const noWord = await admin3.until(`document.getElementById('splitState').dataset.mark === 'broken' && document.getElementById('splitState').textContent`);
    await admin3.eval(`(() => { document.getElementById('splitWord').value = 'split'; document.getElementById('splitForm').requestSubmit(); })()`);
    const splitSaid = await admin3.until(`(() => { const s = document.getElementById('splitState'); return s.dataset.mark === 'intact' && s.textContent; })()`, 20000);
    report(noWord === 'Type the word split to split there.' && splitSaid === '✓ Split: entries 1–8 are in the archive audit-c0ffee00-1-8 (1 file, signed). The check starts at entry 9.', `the split waits for the typed word, then moves entries 1–8 into a signed archive (${splitSaid})`);
    await admin3.shot(path.join(OUT, 'audit-split.png'));
    await admin3.eval(`document.getElementById('splitDialog').close()`);
    const fromLine = await admin3.until(`(() => { const t = document.getElementById('auditLine').textContent; return / · from entry 9, 1 archive · /.test(t) && t; })()`, 20000);
    report(/^Audit log: ✓ keyed \(key [0-9a-f]{16}\) · from entry 9, 1 archive · nothing to accept$/.test(fromLine || ''), `Health names where the check begins after the split (${fromLine})`);
    const users3 = await edge.tab(`${base3}/`);
    await users3.until('document.readyState === "complete"');
    await users3.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }).then(() => { location.href = '/users.html#audit'; })`);
    const archiveLine = await users3.until(`(() => { const li = document.querySelector('#auditArchives .audit-archive'); return location.pathname === '/users.html' && li && !document.getElementById('auditArchives').hidden && li.dataset.mark + '|' + li.querySelector('.audit-mark').textContent + '|' + li.querySelector('.archive-words').textContent; })()`, 20000);
    report(/^intact\|✓\|Entries 1–8: archive audit-c0ffee00-1-8, split off on \d+ \w{3}$/.test(archiveLine || ''), `Accounts → Audit log draws the archive with its mark (${archiveLine})`);
    await users3.eval(`document.querySelector('#auditArchives .audit-archive button').click()`);
    const archiveCheck = await users3.until(`(() => { const s = document.querySelector('#auditArchives .archive-check'); return s && s.dataset.mark && s.dataset.mark + '|' + s.textContent; })()`, 20000);
    report(/^intact\|✓ Intact — entries 1–8 in the archive audit-c0ffee00-1-8, split off on \d+ \w{3}: signed by this laptop's key, every file what its SHA256SUMS says; 8 entries keyed here checked$/.test(archiveCheck || ''), `the archive is checked on its own (${archiveCheck})`);
    await users3.shot(path.join(OUT, 'audit-archive.png'));

    const tabs = [['research', research], ['board', board], ['admin', admin], ['sign-in and halls', signin], ['accounts', users], ['hall as an account', hallView], ['hall as a Staff account', staffHall], ['display', screen], ['projector display', proj], ['foyer display (no zones)', foyer], ['a Viewer\'s halls board', viewerBoard], ['a Viewer\'s hall', viewerHall], ['a code link, signed in then out', codeLink], ['a guest\'s hall link, signed in', asGuest], ['a code link with a one-time password', otpLink], ['the audit log of a 0.5.1 log, cut', audit2], ['Accept on Health', admin2], ['the browser verifier, from disk', checker], ['Split on Health', admin3], ['the archive under the audit log', users3]];
    // The smoke's own premise: every page it drove is visible, as on a device of its own (a hidden page is frozen).
    const hidden = [];
    for (const [name, tab] of tabs) if ((await tab.eval('document.visibilityState')) !== 'visible') hidden.push(name);
    report(hidden.length === 0, `every page the smoke drives is visible, in a window of its own${hidden.length ? ' — not: ' + hidden.join(', ') : ''}`);
    for (const [name, tab] of tabs) {
      report(tab.problems.length === 0, `${name}: no script errors or CSP violations${tab.problems.length ? ' — ' + tab.problems.slice(0, 3).join(' | ') : ''}`);
      tab.close();
    }
  } catch (e) {
    report(false, 'smoke run: ' + e.message);
  } finally {
    if (sw) await sw.close();
    if (patterns) await patterns.close();
    edge.close();
    try { server.send({ t: 'stop' }); } catch { server.kill(); }   // as the watchdog stops it: saved first
    if (server2) await stopServer(server2);
    if (server3) await stopServer(server3);
    setTimeout(() => { for (const d of [dataDir, dataDir2, dataDir3]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } }, 1000);
  }
  console.log(failures === 0 ? `ALL OK (screenshots in ${OUT})` : `${failures} FAILED`);
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})();
