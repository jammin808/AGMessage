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
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { fakeStagewatch, fakeNode, chainOf, unzipTo, keyedLogWithPoints, FIXTURE_KEY, connect, emit } = require('./helpers');
const { io: ioClient } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.AGM_SMOKE_OUT || path.join(ROOT, '..', 'artifacts', 'smoke');
const TOKEN = 'smokeadmintoken1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A value written into code a page evaluates: JSON, with the characters that could end a string or a script escaped.
const CODE_ESCAPES = { '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0', '\u2028': '\\u2028', '\u2029': '\\u2029' };
// The words a message held before it was sent carries: "written 14:02 · sent 14:03 (offline)", in the browser's format.
const HELD_WORDS = /^written ([0-9]{1,2}:[0-9]{2}[ APM]{0,3}) · sent ([0-9]{1,2}:[0-9]{2}[ APM]{0,3}) \(offline\)$/;
const codeLiteral = (v) => JSON.stringify(v).replace(/[<>\b\f\n\r\t\0\u2028\u2029]/g, (c) => CODE_ESCAPES[c]);
// The word check (one word per thing: hall, room, code, seat, the Board, screens): what a page says in its own words —
// every text it draws or keeps ready to draw (hidden panes, closed dialogs, the rows and buttons its script builds, its
// templates), its title, and each title, placeholder, label, alt and button value — read for "session", "meeting",
// "director" and "research" (the Backstage seat's old word, and "research team"). Never what people wrote or named, or
// what happened, or what another show system said, which stay as written: a message's words and its sender, the feeds'
// own lines (an old "Session restored" among them), a document on stage and its name, the people's names in a list or a
// row, help requests' words, the audit log's rows, halls' and rooms' names, and Stagewatch's context and the show network.
// A message's body is its sender's: only the buttons and the line the page adds to it are read. `doc` is the page read
// (a frame's document for the admin's support view).
const CHROME_OLD_WORDS = (doc = 'document') => `((doc) => {
  const OLD = /\\b(?:sessions?|meetings?|directors?|research)\\b/i;
  const SKIP = ['script', 'style', '#feed .sys', '#adminFeed .sys', '#docDisplay > :not(.empty-state)', '.hall-last', '.rx-pill',
    '#helpList .help-what', '#auditList .audit-words', '.admin-msg-body > p', '#swContext', '#networkList', '#stageTitle'].join(', ');
  const NAMES = ['.msg .from', '.admin-msg-head > strong', '#whoami', '#who', '#usersTbody td:first-child', '.lc-name', '.lc-code',
    '#userRows td:first-child', '#userRows td:nth-child(3)', '#auditList .audit-actor', '#auditList .audit-action', '#helpList .help-where',
    '#helpList .help-who', '.hall-name', '.room-name', '#watchedRoomName', '#docTitle', '#docCaption', '#docPinnedList .name'].join(', ');
  const NAMED_LINE = '#peopleList li';   // a person's line: the seat's tag is the page's, the name beside it the person's
  const BODY = '.msg .body';
  const BODY_CHROME = 'button:not(.action-btn), .held-line, .action-responses > small';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const pageSays = (el) => { const b = el.closest(BODY); if (!b) return true; const c = el.closest(BODY_CHROME); return !!c && b.contains(c); };
  const found = [];
  const read = (root) => {
    const walk = doc.createTreeWalker(root, 1 | 4, { acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? 2 : 1) });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === 3) {
        const p = n.parentElement;
        if (p && (p.closest(NAMES) || p.matches(NAMED_LINE) || !pageSays(p))) continue;
        if (OLD.test(n.data)) found.push(n.data.trim());
        continue;
      }
      if (pageSays(n)) {
        for (const a of ATTRS) { const v = n.getAttribute(a); if (v && OLD.test(v)) found.push(a + '=' + v); }
        if (n.matches('input[type="button"], input[type="submit"], input[type="reset"]') && OLD.test(n.value)) found.push('value=' + n.value);
      }
      if (n.localName === 'template') read(n.content);
    }
  };
  if (OLD.test(doc.title)) found.push('title=' + doc.title);
  read(doc.body);
  return found;
})(${doc})`;
// A hall page out of its hall (sent out, or its join refused): the words in place of the hall, the way back, the socket,
// and what it still offers of the hall (its header's buttons, a chip that is a door, an open dialog, an ask): nothing.
const OUT_OF_HALL = `(() => { const box = document.getElementById('outOfHall'); const back = document.getElementById('outBack');
  const doors = [...document.querySelectorAll('.app-meta [role=button], .app-meta [aria-haspopup]')].filter((n) => n.getClientRects().length > 0).map((n) => n.id);
  const offered = [...new Set(['helpBtn', 'screensBtn', 'peopleBtn', 'stageToggleBtn'].filter((id) => !document.getElementById(id).hidden).concat(doors, [...document.querySelectorAll('dialog[open], .agm-ask')].map((d) => d.id)))];
  return !box.hidden && JSON.stringify({ words: document.getElementById('outWords').textContent, back: back.textContent, to: back.getAttribute('href'),
    hall: document.querySelector('.main-row').hidden, offered, focused: document.activeElement === back, connected: socket.connected }); })()`;
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

async function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '', TZ: SERVER_TZ, ...env },
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
     * `metrics` {width, height} is its viewport (`phone: true` makes it a phone's: a mobile viewport at 2× with a touch
     * screen), `timezone` its zone, `headers` HTTP headers every request it makes carries (its WebSocket's included).
     */
    async tab(url, { init, workerInit, metrics, timezone, headers } = {}) {
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
        // No page opens a native alert, confirm or prompt (it pauses the page, which drops its socket): one is a problem,
        // dismissed so the run goes on.
        if (m.method === 'Page.javascriptDialogOpening') { problems.push('a native ' + m.params.type + ': ' + m.params.message); call('Page.handleJavaScriptDialog', { accept: false }); }
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
      if (metrics) await send('Emulation.setDeviceMetricsOverride', { width: metrics.width, height: metrics.height, deviceScaleFactor: metrics.phone ? 2 : 1, mobile: !!metrics.phone });
      if (metrics && metrics.phone) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      if (timezone) await send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      if (headers) { await send('Network.enable'); await send('Network.setExtraHTTPHeaders', { headers }); }
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
// The page floor's legs (docs/DEVICES.md). FLOOR: a browser at or above the floor (Safari 14.1, Chrome 84) without what
// came after it — showModal(), the popover API, the Wake Lock, requestIdleCallback, a form's requestSubmit() — as Safari
// before 15.4 is. NO_DIALOG, beside it: no <dialog> at all (its close(), open and returnValue gone) and no submit event's
// submitter, which came with it. BELOW: a browser below the floor, without WeakRef, which came with it; every way a page
// asks the server or opens a socket is counted in `__asked`, from before the page's own scripts run.
const FLOOR = `(() => { delete HTMLDialogElement.prototype.showModal; delete HTMLElement.prototype.showPopover; delete Navigator.prototype.wakeLock; delete window.requestIdleCallback; delete window.cancelIdleCallback; delete HTMLFormElement.prototype.requestSubmit; })();`;
const NO_DIALOG = `(() => { for (const k of ['close', 'open', 'returnValue', 'show']) delete HTMLDialogElement.prototype[k]; delete SubmitEvent.prototype.submitter; })();`;
const BELOW = `(() => { delete window.WeakRef; const asked = window.__asked = [];
  const f = window.fetch; window.fetch = function (u) { asked.push('fetch ' + String(u && u.url || u)); return f.apply(this, arguments); };
  const o = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { asked.push('xhr ' + u); return o.apply(this, arguments); };
  const W = window.WebSocket; window.WebSocket = function (u, p) { asked.push('ws ' + u); return new W(u, p); };
  const b = navigator.sendBeacon; navigator.sendBeacon = function (u) { asked.push('beacon ' + u); return b.apply(this, arguments); }; })();`;
const FLOOR_WORDS = 'This browser is too old for AGMessage. Update this device (iPadOS or iOS 14.5, or Chrome 84, or later), or use another.';
/** A dialog opened through AGM.openDialog's own: open, fixed in view above its backdrop, the focus in it (its id), the rest of the page hidden from a screen reader. */
const FALLBACK_OPEN = (id) => `(() => { const d = document.getElementById('${id}'); const b = d.previousElementSibling; const r = d.getBoundingClientRect();
  return d.hasAttribute('open') && JSON.stringify({ fixed: getComputedStyle(d).position === 'fixed', inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    backdrop: !!b && b.className === 'agm-backdrop' && document.elementFromPoint(4, 4) === b, focused: d.contains(document.activeElement) ? document.activeElement.id : '',
    rest: [...document.body.children].filter((e) => e !== d).every((e) => e.getAttribute('aria-hidden') === 'true') && !d.hasAttribute('aria-hidden') }); })()`;
/** The same dialog closed: no backdrop left, nothing of the page left hidden, and where the focus went back to. */
const FALLBACK_CLOSED = (id) => `(() => { const d = document.getElementById('${id}');
  return !d.hasAttribute('open') && JSON.stringify({ backdrops: document.querySelectorAll('.agm-backdrop').length, hidden: [...document.body.children].filter((e) => e.hasAttribute('aria-hidden')).length, focused: document.activeElement.id }); })()`;
const FALLBACK_SHOWN = JSON.stringify({ fixed: true, inView: true, backdrop: true, focused: '', rest: true });
const shownWith = (focused) => FALLBACK_SHOWN.replace('"focused":""', '"focused":' + JSON.stringify(focused));
const closedTo = (focused) => JSON.stringify({ backdrops: 0, hidden: 0, focused });
/**
 * A dialog opened through AGM.openDialog's own, closed and opened again in one task (`close`, then `reopen`, statements
 * run in the page), as a quick hand can between two frames: <dialog>'s own close() and a form's method="dialog" send
 * their close event in a later task, so here it comes after the new opening, every time. Close events from before the
 * step have come first (a frame passes before it). Answers {shut: FALLBACK_CLOSED's just after the close, heard: whether
 * the late close event came, open: FALLBACK_OPEN's once it has, backdrops: how many are on the page then}.
 */
const RACED = (id, close, reopen) => `(async () => { const d = document.getElementById('${id}');
  await new Promise((r) => { requestAnimationFrame(() => r()); });
  ${close}
  const shut = ${FALLBACK_CLOSED(id)};
  const late = new Promise((r) => { d.addEventListener('close', () => r(true), { once: true }); setTimeout(() => r(false), 3000); });
  ${reopen}
  const heard = await late;
  return JSON.stringify({ shut, heard, open: ${FALLBACK_OPEN(id)}, backdrops: document.querySelectorAll('.agm-backdrop').length }); })()`;
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
// A phone, as the hall page must fit it: 390 × 844 CSS pixels, at 2×, with a touch screen.
const PHONE = { width: 390, height: 844, phone: true };
// What a page draws, read from its computed styles: a colour's contrast with what is under it (the backgrounds it sits
// on, blended down to the page), as WCAG counts it, and how faded it is (its opacity times each parent's).
const INK = `(() => {
  const rgba = (s) => { const p = (s.match(/[\\d.]+/g) || []).map(Number); const k = s.startsWith('color(') ? 255 : 1; return { r: (p[0] || 0) * k, g: (p[1] || 0) * k, b: (p[2] || 0) * k, a: p.length > 3 ? p[3] : 1 }; };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const under = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; } } return layers.reverse().reduce((u, t) => over(t, u), { r: 255, g: 255, b: 255, a: 1 }); };
  const lum = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const opacity = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  window.__ink = (el) => { const bg = under(el); return { ratio: ratio(over(rgba(getComputedStyle(el).color), bg), bg), opacity: opacity(el), bgLum: lum(bg) }; };
  window.__edge = (el) => { const bg = under(el.parentElement); return ratio(over(rgba(getComputedStyle(el).borderTopColor), bg), bg); };
})();`;
// The hall page on a phone, read: whether it fits the screen (no sideways scroll, nothing zoomed out); its message icon
// buttons (and their size), presence lines and On stage tags, at their lowest contrast and opacity; Help at rest, its
// fill, words and edge; Send; the header's controls under a finger; and the composer's 🔥 Priority, unpressed and pressed (its
// transition held, so each state is read as drawn, then put back as it was).
const PHONE_READ = `(() => {
  const de = document.documentElement;
  const vis = (e) => e.getClientRects().length > 0;
  const low = (xs) => ({ n: xs.length, ratio: xs.length ? Math.min(...xs.map((x) => x.ratio)) : 0, opacity: xs.length ? Math.min(...xs.map((x) => x.opacity)) : 0, bgLum: xs.length ? [Math.min(...xs.map((x) => x.bgLum)), Math.max(...xs.map((x) => x.bgLum))] : [],
    size: xs.length ? Math.min(...xs.map((x) => x.size === undefined ? Infinity : x.size)) : 0 });
  const icons = low([...document.querySelectorAll('#feed .msg header .msg-act, #feed .msg header .obj-more')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { ...__ink(b), size: Math.min(r.width, r.height) }; }));
  const presence = low([...document.querySelectorAll('#feed .sys.presence')].filter(vis).map((p) => __ink(p)));
  const tags = low([...document.querySelectorAll('#feed .role-tag[data-role="board"]')].filter(vis).map((t) => __ink(t)));
  const fault = document.createElement('i'); fault.style.color = 'var(--c-fault)'; document.body.appendChild(fault);
  const red = getComputedStyle(fault).color; fault.remove();
  const help = document.getElementById('helpBtn');
  const send = [...document.querySelectorAll('.send-btn')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, label: b.getAttribute('aria-label'), word: getComputedStyle(b.querySelector('.send-word')).display, mark: getComputedStyle(b.querySelector('.send-icon')).display }; });
  const header = [...document.querySelectorAll('.app-meta .btn')].filter(vis).map((b) => b.getBoundingClientRect().height);
  const doors = [...document.querySelectorAll('.app-meta [role=button], #feed .msg header button.from, .compose .compose-more')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { door: b.id || b.className, size: Math.round(Math.min(r.width, r.height) * 10) / 10 }; });
  const pri = [...document.querySelectorAll('.compose .priority-btn')].find(vis);
  let priority = null;
  if (pri) {
    pri.style.transition = 'none';
    const state = () => ({ red: getComputedStyle(pri).backgroundColor === red, ratio: +__ink(pri).ratio.toFixed(2), pressed: pri.getAttribute('aria-pressed') });
    const off = state(); pri.click(); const on = state(); pri.click(); const back = state();
    pri.style.transition = '';
    priority = { off, on, back };
  }
  return { fits: de.scrollWidth <= de.clientWidth && de.clientWidth === 390 && innerWidth === 390, width: de.scrollWidth + '/' + de.clientWidth + '/' + innerWidth,
    icons, presence, tags, help: vis(help) ? { red: [getComputedStyle(help).backgroundColor, getComputedStyle(help).color, getComputedStyle(help).borderTopColor].includes(red), ratio: __ink(help).ratio,
      edge: parseFloat(getComputedStyle(help).borderTopWidth) >= 1 ? __edge(help) : 0, state: help.dataset.state || '' } : null,
    send, coarse: matchMedia('(pointer: coarse)').matches, header: header.length ? Math.min(...header) : 0, doors, full: F.view !== 'simple', priority };
})()`;
// Every dialog of the hall page opened in turn (Help through its button where the seat has it): each of its buttons,
// brought into view inside the dialog, lies on the phone's screen and is what a tap at its centre reaches.
const DIALOGS_REACHED = `(async () => {
  const out = [];
  for (const d of document.querySelectorAll('dialog.agm-dialog')) {
    const help = d.id === 'helpDialog' && !document.getElementById('helpBtn').hidden;
    if (help) document.getElementById('helpBtn').click(); else d.showModal();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const buttons = [...d.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
    const missed = [];
    for (const b of buttons) {
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const q = b.getBoundingClientRect();
      const on = q.left >= 0 && q.top >= 0 && q.right <= 390 && q.bottom <= 844 && b.contains(document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2));
      if (!on) missed.push((b.textContent.trim() || b.id).slice(0, 24));
    }
    out.push({ id: d.id, via: help ? 'Help' : 'showModal', buttons: buttons.length, missed });
    d.close();
  }
  return out;
})()`;
/** A message on a page: drawn plain (no fill, nothing animated, the background of an older message), and whether the one New divider sits above it. */
const NEW_MARK = (text) => `(() => {
  const m = allMessages.find((x) => x.text === ${codeLiteral(text)}); const n = m && messagesById.get(m.id);
  if (!n) return null;
  const older = [...feed.querySelectorAll(':scope > .msg[data-type="text"]')].find((x) => x !== n && !x.classList.contains('mine') && !x.classList.contains('priority'));
  const dividers = [...feed.querySelectorAll('.new-divider')];
  return { divider: dividers.length === 1 && dividers[0].nextElementSibling === n, dividers: dividers.length, plain: !n.classList.contains('flash') && n.getAnimations({ subtree: true }).length === 0 && getComputedStyle(n).backgroundColor === getComputedStyle(older).backgroundColor };
})()`;
// ---------------------------------------------------------------- an object's doors (catalog.js, menus.js)
/** A key on a tab, as a keyboard sends it: its down, its character (for one that has one) and its up. */
const KEY_CODES = { F10: 121, Escape: 27, Enter: 13, Delete: 46, ArrowDown: 40, ArrowUp: 38, Tab: 9, p: 80, d: 68, e: 69, f: 70 };
async function press(tab, key, { shift = false } = {}) {
  const vk = KEY_CODES[key];
  const k = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  await tab.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  if (key.length === 1) await tab.send('Input.dispatchKeyEvent', { type: 'char', ...k, text: key });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}
/** Enter as a keyboard sends it: its down with its character (which presses a focused button), and its up. */
async function pressEnter(tab) {
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r', unmodifiedText: '\r' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}
/** A right-click at a point of a tab, as a mouse makes it. */
async function rightClick(tab, at) {
  for (const type of ['mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
}
/** A click at a point of a tab, as a mouse makes it: its press (pointerdown first) and its release. */
async function leftClick(tab, at) {
  for (const type of ['mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}
/** The middle of an element of a tab (an expression), scrolled into view first. */
const middleOf = (tab, el) => tab.eval(`(() => { const n = ${el}; n.scrollIntoView({ block: 'nearest' }); const q = n.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
/** The ids of the open menu, as drawn: each row's act, a fold's entries in its place; '' while none is open. */
const MENU_IDS = `(() => { const m = document.querySelector('.agm-menu:not(.agm-sub)'); return m ? JSON.stringify([...m.querySelectorAll(':scope > .agm-mi')].flatMap((b) => b.dataset.children ? b.dataset.children.split(' ') : b.dataset.action ? [b.dataset.action] : [])) : ''; })()`;
const NO_MENU = `!document.querySelector('.agm-menu')`;
/**
 * An object's doors on a page, each opened and read: right-click (at its name), its ⋯, and Shift+F10 on the focused
 * object each open the ids of the catalogue's shown set for it; the ⋯ clicked again closes its menu, the focus on it;
 * the key's menu has the focus on its first enabled item, and Escape gives the focus back; each inline act is in the
 * menu under its own name. `sel` is an expression for the object's element, `obj` one for the catalogue's object.
 */
async function doorsOf(tab, kind, sel, obj, { facts = 'F', bar = '.msg-acts > .msg-act, .file-acts > .msg-act, .screen-acts > .msg-act', focus = sel, hit = '.from, .name, .screen-line strong' } = {}) {
  const out = { want: await tab.eval(`JSON.stringify(AGM.catalog.ids(${codeLiteral(kind)}, ${facts}, ${obj}))`) };
  const at = await tab.eval(`(() => { const n = ${sel}; n.scrollIntoView({ block: 'center' }); const h = n.querySelector(${codeLiteral(hit)}) || n; const q = h.getBoundingClientRect(); return { x: Math.round(q.left + Math.min(6, q.width / 2)), y: Math.round(q.top + q.height / 2) }; })()`);
  out.hit = await tab.eval(`(() => { const h = document.elementFromPoint(${at.x}, ${at.y}); return h ? h.tagName + '.' + h.className + ' in ' + (${sel}).contains(h) : 'nothing'; })()`);
  await rightClick(tab, at);
  out.right = await tab.until(MENU_IDS, 3000);
  await press(tab, 'Escape');
  out.rightClosed = !!(await tab.until(NO_MENU, 3000));
  // The ⋯ clicked as a mouse clicks it opens the menu, and clicked again closes it, the focus on it.
  const dotsAt = await middleOf(tab, `${sel}.querySelector('.obj-more')`);
  await leftClick(tab, dotsAt);
  out.dots = await tab.until(MENU_IDS, 3000);
  out.inline = await tab.eval(`(async () => {
    const n = ${sel}; const menu = document.querySelector('.agm-menu:not(.agm-sub)'); const rows = [];
    for (const b of n.querySelectorAll(${codeLiteral(bar)})) {
      const id = b.dataset.action;
      let row = menu.querySelector(':scope > .agm-mi[data-action="' + id + '"]');
      const fold = row ? null : [...menu.querySelectorAll(':scope > .agm-mi[data-children]')].find((r) => r.dataset.children.split(' ').includes(id));
      if (fold) { if (fold.getAttribute('aria-expanded') !== 'true') fold.click(); await new Promise((r) => setTimeout(r, 50)); row = document.querySelector('.agm-sub .agm-mi[data-action="' + id + '"]'); }
      rows.push([id, b.getAttribute('aria-label') === (row && row.getAttribute('aria-label'))]);
    }
    return JSON.stringify(rows);
  })()`);
  // A submenu the inline check opened (the focus in it) closes first with Escape, which leaves the menu open.
  if (await tab.eval(`!!document.querySelector('.agm-sub')`)) { await press(tab, 'Escape'); await tab.until(`!document.querySelector('.agm-sub')`, 2000); }
  out.dotsStill = await tab.eval(`!!document.querySelector('.agm-menu:not(.agm-sub)')`);
  // Where the ⋯ is now (the page may have moved under the open menu), and what a click there meets.
  const dotsNow = await tab.eval(`(() => { const q = ${sel}.querySelector('.obj-more').getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
  out.dotsHit = await tab.eval(`(() => { const h = document.elementFromPoint(${dotsNow.x}, ${dotsNow.y}); return h ? h.tagName + '.' + h.className : 'nothing'; })()`);
  await leftClick(tab, dotsNow);
  out.dotsBack = !!(await tab.until(`${NO_MENU} && document.activeElement === ${sel}.querySelector('.obj-more')`, 3000));
  await tab.eval(`${focus}.focus()`);
  await press(tab, 'F10', { shift: true });
  out.key = await tab.until(MENU_IDS, 3000);
  out.keyFirst = await tab.eval(`(() => { const first = [...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].find((b) => b.getAttribute('aria-disabled') !== 'true'); return !!first && document.activeElement === first; })()`);
  await press(tab, 'Escape');
  out.keyBack = !!(await tab.until(`${NO_MENU} && document.activeElement === ${focus}`, 3000));
  return out;
}
/** The doors of the objects on the pages that list them (the admin page, the halls board, the Accounts page): their facts and objects from AGM.page, their bars `.obj-bar`. */
const PAGE_DOORS_HALLS = { facts: 'AGM.page.facts()', bar: '.obj-bar > [data-action]' };
/**
 * The bars of a page that lists objects, read as drawn (INK first): how many acts and ⋯ are shown, whether the pointer is
 * coarse, their smallest side, the lowest ink of the icon-only ones and of the ones with words on what they sit on, and
 * the lowest opacity among them (null where there are none of a sort).
 */
const BARS_READ = `(() => { const vis = (b) => b.getClientRects().length > 0;
  const read = [...document.querySelectorAll('.obj-bar > [data-action], .obj-bar > .obj-more')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); const k = __ink(b); return { size: Math.min(r.width, r.height), ratio: k.ratio, opacity: k.opacity, words: !!b.querySelector('.act-words') }; });
  const low = (xs, f) => (xs.length ? Math.round(Math.min(...xs.map(f)) * 100) / 100 : null);
  return JSON.stringify({ n: read.length, coarse: matchMedia('(pointer: coarse)').matches, size: low(read, (x) => x.size), icons: low(read.filter((x) => !x.words), (x) => x.ratio), words: low(read.filter((x) => x.words), (x) => x.ratio), opacity: low(read, (x) => x.opacity) }); })()`;
/** A page's bars, and the menu of the object `sel` opened by its ⋯, in both themes; the page's theme put back after. */
async function barsInThemes(tab, sel) {
  await tab.eval(INK);
  const was = await tab.eval(`document.documentElement.dataset.theme || ''`);
  const out = {};
  for (const theme of ['light', 'dark']) {
    await tab.eval(`document.documentElement.dataset.theme = ${codeLiteral(theme)}`);
    await sleep(200);   // the buttons' colour transitions end
    const bars = JSON.parse(await tab.eval(BARS_READ));
    await tab.eval(`(${sel}).querySelector('.obj-more').click()`);
    await tab.until(`!!document.querySelector('.agm-menu .agm-mi .mi-label')`, 3000);
    const menu = await tab.eval(`(() => { const m = document.querySelector('.agm-menu'); return m ? +__ink(m.querySelector('.agm-mi .mi-label')).ratio.toFixed(2) : 0; })()`);
    await press(tab, 'Escape');
    await tab.until(NO_MENU, 3000);
    out[theme] = { ...bars, menu };
  }
  await tab.eval(`(() => { const t = ${codeLiteral(was)}; if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; })()`);
  return out;
}
/** A page's bars read well: shown, 24 px or more (44 px under a finger), icons 3:1, words 4.5:1, none faded, its menu's words 4.5:1. */
const barsOk = (t) => t.n > 0 && t.size >= (t.coarse ? 44 : 24) && (t.icons === null || t.icons >= 3) && (t.words === null || t.words >= 4.5) && t.opacity === 1 && (t.menu === undefined || t.menu >= 4.5);
/** A page that lists objects on a phone (390 × 844, a touch screen), its bars read once `ready` holds. */
async function barsUnderAFinger(edge, url, ready) {
  const ph = await edge.tab(url, { metrics: PHONE });
  const shown = await ph.until(ready, 15000);
  await ph.eval(INK);
  const read = shown ? JSON.parse(await ph.eval(BARS_READ)) : { n: 0 };
  read.problems = ph.problems.slice(0, 3);
  ph.close();
  return read;
}
/**
 * The doors of an object that is its own door (a chip, a sender's name): a right-click on it, a click on it (and a click
 * again, which closes its menu with the focus on it), and Shift+F10 on it focused each open the catalogue's set for it;
 * the key's menu has the focus on its first enabled item, and Escape gives it back. `size` is its smaller side, a target
 * of 24 px or more (44 px under a finger: the phone pass reads the same doors there).
 */
async function selfDoors(tab, kind, sel, obj) {
  const out = { want: await tab.eval(`JSON.stringify(AGM.catalog.ids(${codeLiteral(kind)}, F, ${obj}))`) };
  out.size = await tab.eval(`(() => { const q = (${sel}).getBoundingClientRect(); return Math.round(Math.min(q.width, q.height) * 10) / 10; })()`);
  await rightClick(tab, await middleOf(tab, sel));
  out.right = await tab.until(MENU_IDS, 3000);
  await press(tab, 'Escape');
  out.rightClosed = !!(await tab.until(NO_MENU, 3000));
  await leftClick(tab, await middleOf(tab, sel));
  out.click = await tab.until(MENU_IDS, 3000);
  await leftClick(tab, await tab.eval(`(() => { const q = (${sel}).getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`));
  out.clickBack = !!(await tab.until(`${NO_MENU} && document.activeElement === (${sel})`, 3000));
  await tab.eval(`(${sel}).focus()`);
  await press(tab, 'F10', { shift: true });
  out.key = await tab.until(MENU_IDS, 3000);
  out.keyFirst = await tab.eval(`(() => { const first = [...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].find((b) => b.getAttribute('aria-disabled') !== 'true'); return !!first && document.activeElement === first; })()`);
  await press(tab, 'Escape');
  out.keyBack = !!(await tab.until(`${NO_MENU} && document.activeElement === (${sel})`, 3000));
  return out;
}
const selfInStep = (d) => !!d.want && d.want !== '[]' && d.size >= 24 && d.right === d.want && d.click === d.want && d.key === d.want && d.rightClosed && d.clickBack && d.keyFirst && d.keyBack;
/** Whether an object's doors are in step: every door the catalogue's set, focus where it belongs, the bar in the menu. */
const doorsInStep = (d) => !!d.want && d.want !== '[]' && d.right === d.want && d.dots === d.want && d.key === d.want && d.rightClosed && d.dotsStill && d.dotsBack && d.keyFirst && d.keyBack &&
  JSON.parse(d.inline).every(([, same]) => same);

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
  let server4 = null;
  let dataDir4 = null;
  let server5 = null;
  let dataDir5 = null;
  let link5 = null;
  try {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { code } = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Smoke AGM' }) })).json();

    // Research: joins, gets an upload token, shares a PDF, pdf.js renders it under the CSP.
    const research = await edge.tab(`${base}/app.html?code=${code}&name=Ana&role=research`);
    report(!!(await research.until('typeof joined !== "undefined" && joined && !!UPLOAD_TOKEN')), 'research view joins (identity, upload token)');
    // "What moved" is said once per browser: this first page says it (read below, with the menus), and the pages this
    // browser opens after it are drawn as a person who has read it sees them.
    await research.eval(`localStorage.setItem('agm.moved', '0.6.0')`);
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
    // The word check reads what is hidden, what is in an attribute and a button the page put in a message, and nothing
    // people wrote or named, nor the history: a page given an old word in a closed dialog, in a title, in a message's own
    // button, in the feed's line of what happened, in a message's words and its sender's name, and in a person's name in
    // the people list is found to say the first three, and none of the rest.
    const planted = await research.eval(`(() => {
      const hid = document.createElement('p'); hid.textContent = 'Reset session';
      const tip = document.createElement('span'); tip.title = 'Meeting code';
      const line = document.createElement('div'); line.className = 'sys'; line.textContent = '— Session restored (3 messages preserved) —';
      const msg = document.getElementById('msgTpl').content.firstElementChild.cloneNode(true);
      msg.querySelector('.from').textContent = 'Session Sam';
      const words = document.createElement('p'); words.textContent = 'the directors meet at three';
      const own = document.createElement('button'); own.className = 'btn ghost small answer-words-btn'; own.textContent = 'Reply to the directors';
      msg.querySelector('.body').append(words, own);
      const person = document.createElement('li'); const tag = document.createElement('span'); tag.className = 'role-tag'; tag.textContent = 'Backstage';
      person.append(tag, ' Meeting Mo');
      document.getElementById('helpDialog').append(hid, tip); document.getElementById('feed').append(line, msg); document.getElementById('peopleList').append(person);
      try { return JSON.stringify(${CHROME_OLD_WORDS()}.sort()); } finally { [hid, tip, line, msg, person].forEach((n) => n.remove()); }
    })()`);
    report(planted === JSON.stringify(['Reply to the directors', 'Reset session', 'title=Meeting code']),
      `the word check finds an old word in a closed dialog, a title and a message's own button, and none in the history, a message's words, its sender or a person's name (${planted})`);
    const oldWords = {};   // each page read → what its chrome still says in an old word (none, when it passes)
    const readOldWords = async (page, tab, doc) => { oldWords[page] = await tab.eval(CHROME_OLD_WORDS(doc)); };
    await readOldWords('the hall page, Backstage', research);
    await readOldWords('the hall page, On stage', board);
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

    // The outbox, in a hall of its own (a listener seated there hears each message the hall gets): a send while the
    // socket is down lands once after the reconnect, and its composer empties only after the ok; a refusal keeps the text
    // and says the server's words with Retry; a reload with a held send lands it once; a help request held for a minute
    // reads "written … · sent …" (and on the halls board, below); sent out of the hall, nothing held is sent, even back
    // in the same tab.
    const obHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Outbox hall' }) })).json()).code;
    const listener = await connect(base);
    const heard = [];
    listener.on('message', (m) => heard.push(m));
    await emit(listener, 'join', { roomCode: obHall, name: 'Lou', role: 'observer' });
    const landedOnce = (text) => heard.filter((m) => m.text === text).length;
    const ob = await edge.tab(`${base}/app.html?code=${obHall}&name=Ola&role=research`);
    await ob.until('typeof joined !== "undefined" && joined && socket.connected');
    const HELD_KEYS = `Object.keys(sessionStorage).filter((k) => k.startsWith('agm.outbox|'))`;
    // The two times in the browser's own format (14:02, or 2:02 PM), a minute apart.
    await ob.eval(`socket.disconnect()`);
    await ob.eval(`(() => { textInput.value = 'Held while the Wi-Fi was down'; textPane.requestSubmit(); })()`);
    const whileDown = await ob.eval(`JSON.stringify({ kept: textInput.value, held: textInput.readOnly, echo: (document.querySelector('.msg.echo .echo-state') || {}).textContent || '', items: AGM.outbox.items().map((i) => i.state), stored: ${HELD_KEYS}.length })`);
    await sleep(600);
    const notYet = landedOnce('Held while the Wi-Fi was down');
    await ob.eval(`socket.connect()`);
    const backUp = await ob.until(`socket.connected && !document.querySelector('.msg.echo') && textInput.value === '' && !textInput.readOnly && allMessages.filter((m) => m.text === 'Held while the Wi-Fi was down').length === 1 && ${HELD_KEYS}.length === 0`);
    await sleep(400);
    report(whileDown === JSON.stringify({ kept: 'Held while the Wi-Fi was down', held: true, echo: '◷ Waiting — it goes when the connection is back', items: ['waiting'], stored: 1 }) && notYet === 0 && !!backUp && landedOnce('Held while the Wi-Fi was down') === 1,
      `a send while the socket is down is held (its composer keeps it, ◷ Waiting) and lands once after the reconnect, the composer emptied only then (${whileDown}; before ${notYet}; heard ${landedOnce('Held while the Wi-Fi was down')})`);

    // A refusal (the server's words, here answered in the page for the one send): the text stays, Retry sends it.
    await ob.eval(`(() => { const real = socket.emit; socket.emit = function (ev, ...a) { if (ev !== 'message') return real.call(this, ev, ...a); socket.emit = real; const ack = a[a.length - 1]; setTimeout(() => ack({ ok: false, error: 'Observers can read but not post.' }), 0); return socket; };
      textInput.value = 'Refused, then sent'; textPane.requestSubmit(); })()`);
    const refusedEcho = await ob.until(`(() => { const e = document.querySelector('.msg.echo[data-state="refused"]'); return e && JSON.stringify({ words: e.querySelector('.echo-state').textContent, text: e.querySelector('.echo-text').textContent, buttons: [...e.querySelectorAll('.echo-acts button')].map((b) => b.textContent), kept: textInput.value, held: textInput.readOnly }); })()`);
    await ob.eval(`document.querySelector('.msg.echo[data-state="refused"] .echo-acts button').click()`);
    const retried = await ob.until(`!document.querySelector('.msg.echo') && textInput.value === '' && allMessages.filter((m) => m.text === 'Refused, then sent').length === 1`);
    await sleep(300);
    report(refusedEcho === JSON.stringify({ words: '△ Not sent: Observers can read but not post.', text: 'Refused, then sent', buttons: ['Retry', 'Edit'], kept: 'Refused, then sent', held: false }) && !!retried && landedOnce('Refused, then sent') === 1,
      `a refused send keeps its text and says the server's words with Retry and Edit; Retry sends it, once (${refusedEcho}; heard ${landedOnce('Refused, then sent')})`);

    // A help request refused: Edit brings its words back to the help dialog, its heading focused and no category chosen,
    // and one tap on a category sends it, once, with that category; the chip's Cancel request then takes it away.
    await ob.eval(`(() => { const real = socket.emit; socket.emit = function (ev, ...a) { if (ev !== 'message') return real.call(this, ev, ...a); socket.emit = real; const ack = a[a.length - 1]; setTimeout(() => ack({ ok: false, error: 'Too many help requests at once.' }), 0); return socket; };
      document.getElementById('helpBtn').click(); document.getElementById('helpText').value = 'Refused help, then sent'; document.querySelector('#helpCats button[data-cat="Vision"]').click(); })()`);
    const refusedHelp = await ob.until(`(() => { const e = document.querySelector('.msg.echo[data-type="help"][data-state="refused"]'); return e && JSON.stringify({ words: e.querySelector('.echo-state').textContent, buttons: [...e.querySelectorAll('.echo-acts button')].map((b) => b.textContent), chip: document.getElementById('helpBtn').textContent }); })()`);
    await ob.eval(`[...document.querySelectorAll('.msg.echo[data-type="help"][data-state="refused"] .echo-acts button')].find((b) => b.textContent === 'Edit').click()`);
    const editedHelp = await ob.until(`document.getElementById('helpDialog').open && JSON.stringify({ words: document.getElementById('helpText').value, focused: document.activeElement.id,
      chosen: document.querySelectorAll('#helpCats [aria-pressed="true"], #helpCats .chosen, #helpCats :checked').length, echo: !!document.querySelector('.msg.echo'), held: AGM.outbox.items().length })`);
    await ob.eval(`document.querySelector('#helpCats button[data-cat="Lighting"]').click()`);
    const editSent = await ob.until(`!document.getElementById('helpDialog').open && !document.querySelector('.msg.echo') && allMessages.filter((m) => m.type === 'help' && m.text === 'Refused help, then sent').length === 1 && document.getElementById('helpBtn').dataset.state === 'open'`);
    await sleep(300);
    const heardEdited = heard.filter((m) => m.type === 'help' && m.text === 'Refused help, then sent').map((m) => m.category);
    await ob.eval(`document.getElementById('helpBtn').click()`);
    await ob.until(`!!document.querySelector('#helpBtn + .agm-ask')`);
    await ob.eval(`[...document.querySelectorAll('#helpBtn + .agm-ask button')].find((b) => b.textContent === 'Cancel request').click()`);
    const editCancelled = await ob.until(`!document.querySelector('#helpBtn + .agm-ask') && !allMessages.some((m) => m.type === 'help') && document.getElementById('helpBtn').textContent === 'Help'`);
    report(refusedHelp === JSON.stringify({ words: '△ Not sent: Too many help requests at once.', buttons: ['Retry', 'Edit'], chip: 'Help' }) &&
      editedHelp === JSON.stringify({ words: 'Refused help, then sent', focused: 'helpTitle', chosen: 0, echo: false, held: 0 }) && !!editSent && JSON.stringify(heardEdited) === '["Lighting"]' && !!editCancelled,
      `a refused help request: Help stays Help while it is not sent; Edit brings its words back to the dialog, heading focused and no category chosen, and one tap sends it, once, as that category; Cancel request on the chip then takes it away (${refusedHelp}; ${editedHelp}; heard ${JSON.stringify(heardEdited)})`);

    // A reload with a send held: it comes back from the tab and lands once.
    await ob.eval(`socket.disconnect()`);
    await ob.eval(`(() => { textInput.value = 'Held across a reload'; textPane.requestSubmit(); })()`);
    const storedForReload = await ob.eval(`${HELD_KEYS}.map((k) => JSON.parse(sessionStorage.getItem(k)).map((i) => i.args.text).join()).join()`);
    await ob.eval(`location.reload()`);
    await sleep(500);
    const afterReload = await ob.until(`typeof joined !== 'undefined' && joined && allMessages.filter((m) => m.text === 'Held across a reload').length === 1 && !document.querySelector('.msg.echo') && ${HELD_KEYS}.length === 0`);
    await sleep(500);
    report(storedForReload === 'Held across a reload' && !!afterReload && landedOnce('Held across a reload') === 1, `a reload with a send held: it comes back from the tab and lands once (stored "${storedForReload}"; heard ${landedOnce('Held across a reload')})`);

    // A help request written offline and sent a minute later reads as written then: on the item, for every reader.
    await ob.eval(`(() => { const real = performance.now.bind(performance); window.__shift = 0; performance.now = () => real() + window.__shift; })()`);
    await ob.eval(`socket.disconnect()`);
    await ob.eval(`(() => { document.getElementById('helpBtn').click(); document.getElementById('helpText').value = 'mic 4 crackles';
      document.querySelector('#helpCats button[data-cat="Sound"]').click(); window.__shift = 61000; })()`);
    const helpWaiting = await ob.eval(`JSON.stringify({ closed: !document.getElementById('helpDialog').open, echo: (document.querySelector('.msg.echo[data-type="help"] .echo-text') || {}).textContent || '' })`);
    await ob.eval(`socket.connect()`);
    const heldLine = await ob.until(`(() => { const m = allMessages.find((x) => x.type === 'help' && x.text === 'mic 4 crackles'); const n = m && messagesById.get(m.id); const l = n && n.querySelector('.held-line'); return l && m.held >= 61 && m.held < 70 && l.textContent; })()`);
    const lou = heard.find((m) => m.text === 'mic 4 crackles');
    report(helpWaiting === JSON.stringify({ closed: true, echo: 'Help — Sound: mic 4 crackles' }) && HELD_WORDS.test(heldLine || '') && HELD_WORDS.exec(heldLine)[1] !== HELD_WORDS.exec(heldLine)[2] && !!lou && lou.held >= 61,
      `a help request held for a minute reads "written … · sent … (offline)" on its item, and every reader has its wait (${helpWaiting}; "${heldLine}"; ${lou ? lou.held : 'unheard'} s)`);

    // Sent out of the hall with a send out and unanswered: nothing held is sent, and back in this tab nothing comes back.
    await ob.eval(`(() => { const real = socket.emit; socket.emit = function (ev, ...a) { if (ev !== 'message') return real.call(this, ev, ...a); socket.emit = real; return socket; };
      textInput.value = 'Never sent: sent out first'; textPane.requestSubmit(); })()`);
    const outThen = await ob.eval(`${HELD_KEYS}.length + '|' + AGM.outbox.items().map((i) => i.state).join()`);
    // Sent out while asking about help: Ola's request is open, so Help is its chip, and a tap on it opens its ask.
    await ob.eval(`document.getElementById('helpBtn').click()`);
    const askingThen = await ob.eval(`JSON.stringify({ ask: !!document.querySelector('#helpBtn + .agm-ask'), chip: document.getElementById('helpBtn').textContent })`);
    const obAdmin = await connect(base, cookie);
    const kicked = await emit(obAdmin, 'admin:kick', { socketId: await ob.eval('socket.id') });
    obAdmin.close();
    const sentOut = await ob.until(OUT_OF_HALL, 2000);
    await ob.shot(path.join(OUT, 'sent-out.png'));
    await sleep(3000);   // longer than the page ever waited before leaving by itself: it waits for the person
    const stayedOut = await ob.eval(`location.pathname + '|' + !document.getElementById('outOfHall').hidden`);
    await ob.eval(`document.getElementById('outBack').click()`);
    const leftHall = await ob.until(`location.pathname === '/'`, 8000);
    const keptAfterKick = await ob.eval(`${HELD_KEYS}.length`);
    await ob.send('Page.navigate', { url: `${base}/app.html?code=${obHall}&name=Ola&role=research` });
    await ob.until('typeof joined !== "undefined" && joined && socket.connected');
    await sleep(1500);
    const sentAfter = await ob.eval(`allMessages.filter((m) => m.text === 'Never sent: sent out first').length`);
    report(outThen === '1|sending' && kicked && kicked.ok && !!leftHall && keptAfterKick === 0 && sentAfter === 0 && landedOnce('Never sent: sent out first') === 0,
      `sent out of the hall with a send held, nothing is sent and the tab keeps none of it, even back in the hall (${outThen}; kept ${keptAfterKick}; sent ${sentAfter})`);
    report(askingThen === JSON.stringify({ ask: true, chip: '■ Help asked' }) && sentOut === JSON.stringify({ words: 'An admin sent you out of Outbox hall.', back: 'Back to sign-in', to: '/', hall: true, offered: [], focused: true, connected: false }) && stayedOut === '/app.html|true',
      `the page sent out says who sent it out and of where, in the server's words in place of the hall and the Help chip's ask open on it, with Back to sign-in, and does not leave by itself (${askingThen}; ${sentOut}; after 3 s: ${stayedOut})`);
    listener.close();
    ob.close();
    await sleep(800);
    await research.shot(path.join(OUT, 'research.png'));
    await board.shot(path.join(OUT, 'board.png'));

    // The hall page fits a phone (390 × 844, a touch screen), for each seat: as wide as the screen and no wider, every
    // button of every dialog on the screen where a tap reaches it, Send a 44 px button named by its label, the header's
    // controls 44 px under a finger. In both themes: the icon buttons at 3:1 or more and the presence lines at 4.5:1,
    // neither faded by opacity; the On stage tag light in light mode; Help at rest neutral and outlined, no red in its
    // fill, words or edge, its words at 4.5:1 or more and its edge at 3:1 or more. A new message is marked, never
    // flashed: on a page nobody touches the New divider stays above the first new message (read again 30 s later,
    // below); scrolled up by 10 messages with a wheel, a new one leaves the view where it was and "↓ 1 new" says so.
    const phoneHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Phone hall' }) })).json()).code;
    const pat = await connect(base);
    const ben = await connect(base);
    await emit(pat, 'join', { roomCode: phoneHall, name: 'Pat', role: 'research' });
    await emit(ben, 'join', { roomCode: phoneHall, name: 'Ben', role: 'board' });
    // Sent at the pace a socket may write (its burst spent, a "busy" answer is tried again a moment later).
    const post = async (s, args) => { for (let i = 0; i < 60; i++) { const r = await emit(s, 'message', args); if (r && r.ok) return r; await sleep(250); } return null; };
    await post(ben, { type: 'text', text: 'From the stage: is slide 14 the one?' });
    for (let i = 1; i <= 30; i++) await post(pat, { type: 'text', text: 'Backstage note ' + i + (i % 6 === 0 ? ': Aktiengesellschaftsrechtsänderungsgesetzbestimmungen' : '') });
    await post(pat, { type: 'action', text: 'Refer them to slide 14?', options: ['Yes', 'No', 'Defer'] });
    await post(pat, { type: 'text', text: 'Mic 2 is off', priority: true });
    const phones = {};
    for (const [seat, name] of [['board', 'Bea'], ['research', 'Rob'], ['observer', 'Oli']]) {
      phones[seat] = await edge.tab(`${base}/app.html?code=${phoneHall}&name=${name}&role=${seat}`, { init: INK, metrics: PHONE });
      await phones[seat].until(`typeof joined !== "undefined" && joined && allMessages.some((m) => m.priority)`);
    }
    for (const [seat, tab] of Object.entries(phones)) await readOldWords('the hall page on a phone, ' + { board: 'On stage', research: 'Backstage', observer: 'Observer' }[seat], tab);
    const hallDeck = JSON.parse(await phones.board.eval(`JSON.stringify({ chip: document.getElementById('roomChip').title, people: document.querySelector('#peoplePanel h3').textContent,
      placeholder: document.getElementById('directorInput').placeholder, label: document.getElementById('directorInput').getAttribute('aria-label') })`));
    const backDeck = JSON.parse(await phones.research.eval(`JSON.stringify({ ask: document.querySelector('#actionPane .field > span').textContent,
      files: document.querySelector('#filePane .dropzone .hint').textContent, panel: document.querySelector('#docDisplay .empty-state .hint').textContent })`));
    report(JSON.stringify(hallDeck) === JSON.stringify({ chip: 'Phone hall', people: 'In this room', placeholder: 'Message everyone here…', label: 'Message everyone here…' })
      && JSON.stringify(backDeck) === JSON.stringify({ ask: 'Question for the Board', files: 'Max 25 MB. Files show on the Board\'s On stage panel.', panel: 'When the backstage team shares a file, it appears here automatically.' }),
      `the hall page says room, the Board and the backstage team: the code's title names the room, "In this room", "Message everyone here…", "Question for the Board" (${JSON.stringify({ hallDeck, backDeck })})`);
    // Nobody touches Oli's page from here to the end of the smoke: no tap, no key, no wheel.
    await post(pat, { type: 'text', text: 'First new' });
    const firstNew = Date.now();
    const untouched = await phones.observer.until(NEW_MARK('First new'));
    const boardFirst = await phones.board.until(NEW_MARK('First new'));
    report(!!untouched && untouched.divider && untouched.plain && !!boardFirst && boardFirst.divider && boardFirst.plain,
      `a new message is marked by the New divider above it, and drawn as every other message: no fill, nothing animated (${JSON.stringify({ untouched, boardFirst })})`);
    for (const [seat, tab] of Object.entries(phones)) {
      const seen = {};
      for (const theme of ['light', 'dark']) {
        await tab.eval(`applyTheme(${codeLiteral(theme)})`);
        // Read once the theme's colours have settled: a button's background eases over 0.12 s.
        await tab.until(`document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running')`, 3000);
        seen[theme] = await tab.eval(PHONE_READ);
      }
      await tab.shot(path.join(OUT, `phone-${seat}-dark.png`));
      await tab.eval(`applyTheme('light')`);
      await tab.until(`document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running')`, 3000);
      await tab.shot(path.join(OUT, `phone-${seat}.png`));
      const dialogs = await tab.eval(DIALOGS_REACHED);
      const { light, dark } = seen;
      const writes = seat !== 'observer';
      const sendOk = writes ? light.send.length === 1 && light.send[0].w >= 44 && light.send[0].h >= 44 && light.send[0].label === 'Send to Phone hall' && light.send[0].word === 'none' && light.send[0].mark !== 'none' : light.send.length === 0;
      // The doors that are not buttons by look (the code chip, a sender's name, the composer's ⋯): 44 px under a finger too;
      // a seat that writes has the code chip at least, and in the full view the composer's ⋯.
      const doorsOk = light.doors.every((d) => d.size >= 44) && (!writes || light.doors.some((d) => d.door === 'roomChip') && (!light.full || light.doors.some((d) => /compose-more/.test(d.door))));
      report(light.fits && dark.fits && Array.isArray(dialogs) && dialogs.length === 3 && dialogs.every((d) => d.buttons > 0 && d.missed.length === 0) && (dialogs[0].via === 'Help') === writes &&
        sendOk && light.coarse && light.header >= 44 && doorsOk,
        `the hall page fits a 390 px phone as ${seat}: no wider than the screen (${light.width}), every dialog's buttons on the screen and reached by a tap, Send a 44 px button named for where it sends, the header's controls and the doors (the code chip, a sender's name, the composer's ⋯) 44 px under a finger (${JSON.stringify({ dialogs, send: light.send, header: light.header, doors: light.doors })})`);
      // 🔥 Priority pressed is filled with the fault red and says it is pressed; unpressed it is neither; each click turns it.
      const priorityOk = (t) => (writes ? !!t.priority && !t.priority.off.red && t.priority.off.pressed !== 'true' && t.priority.on.red && t.priority.on.pressed === 'true' && t.priority.on.ratio >= 4.5 &&
        !t.priority.back.red && t.priority.back.pressed === 'false' : t.priority === null);
      const inkOk = (t, dark) => t.icons.n > 0 && t.icons.ratio >= 3 && t.icons.opacity === 1 && t.icons.size >= (t.coarse ? 44 : 24) && t.presence.n > 0 && t.presence.ratio >= 4.5 && t.presence.opacity === 1 &&
        t.tags.n > 0 && t.tags.ratio >= 4.5 && (dark ? t.tags.bgLum[1] < 0.2 : t.tags.bgLum[0] > 0.6) && (writes ? !!t.help && t.help.state === '' && !t.help.red && t.help.ratio >= 4.5 && t.help.edge >= 3 : t.help === null) && priorityOk(t);
      const short = (t) => ({ icons: [t.icons.n, +t.icons.ratio.toFixed(2), t.icons.opacity, +t.icons.size.toFixed(1)], presence: [t.presence.n, +t.presence.ratio.toFixed(2), t.presence.opacity], tag: [+t.tags.ratio.toFixed(2), t.tags.bgLum.map((x) => +x.toFixed(2))], help: t.help && [t.help.red, +t.help.ratio.toFixed(2), +t.help.edge.toFixed(2)], priority: t.priority });
      report(inkOk(light, false) && inkOk(dark, true),
        `${seat} on a phone, in both themes: a message's acts and its ⋯ 44 px under a finger at 3:1 or more and presence lines 4.5:1 or more, none faded; the On stage tag light in light mode and dark in dark; Help at rest neutral and outlined, no red in its fill, words or edge, its words at 4.5:1 or more and its edge at 3:1 or more; 🔥 Priority on the fault red, pressed, only while pressed (${JSON.stringify({ light: short(light), dark: short(dark) })})`);
      if (seat === 'research') {
        // AI drafts are off on this server (no key): ✨ is there, not usable, and says why; pressed, it says why where a
        // finger can read it, and asks the server for nothing.
        const ai = await tab.eval(`(async () => {
          const b = document.getElementById('aiDraftBtn'); const sent = []; const emit = socket.emit;
          socket.emit = function (ev, ...rest) { sent.push(ev); return emit.call(this, ev, ...rest); };
          const was = { shown: b.getClientRects().length > 0, disabled: b.getAttribute('aria-disabled'), title: b.title };
          b.click(); await new Promise((r) => setTimeout(r, 300)); socket.emit = emit;
          const h = document.getElementById('aiHint');
          return { ...was, hint: h && !h.hidden && h.getClientRects().length > 0 ? h.textContent : '', ratio: h ? +__ink(h).ratio.toFixed(2) : 0, sent: sent.filter((e) => e.startsWith('ai:')) };
        })()`);
        report(!!ai && ai.shown && ai.disabled === 'true' && /Anthropic key/.test(ai.title) && ai.hint === ai.title && ai.ratio >= 4.5 && ai.sent.length === 0,
          `with AI drafts off, backstage on a phone sees ✨ Draft answer marked not usable with the reason as its title; pressed, the reason shows under the composer at 4.5:1 or more and nothing is asked of the server (${JSON.stringify(ai)})`);
      }
    }
    // Bea scrolls up by 10 messages with a wheel (a scroll of her own): a new message leaves what she reads where it was,
    // "↓ 1 new" says it came, and the divider moves above it (she touched the page since it was placed); a second keeps
    // the divider and counts 2; "↓ 2 new" takes her to the end, and the next message is followed there.
    const bea = phones.board;
    const tenUp = await bea.eval(`(() => { const n = [...feed.querySelectorAll(':scope > .msg')].slice(-10); const f = feed.getBoundingClientRect();
      return { dy: n.reduce((a, x) => a + x.getBoundingClientRect().height, 0) + 10 * parseFloat(getComputedStyle(feed).rowGap), x: f.left + f.width / 2, y: f.top + f.height / 2 }; })()`);
    await bea.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: tenUp.x, y: tenUp.y, deltaX: 0, deltaY: -tenUp.dy });
    const VIEW = `(() => { const f = feed.getBoundingClientRect(); const m = window.__read || (window.__read = [...feed.querySelectorAll(':scope > .msg')].find((x) => x.getBoundingClientRect().top >= f.top));
      return { top: Math.round(m.getBoundingClientRect().top * 10) / 10, end: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 2, below: newBelow.hidden ? '' : newBelow.textContent, tall: newBelow.getBoundingClientRect().height }; })()`;
    const scrolled = await bea.until(`!place.atEnd && ${VIEW}`);
    await post(pat, { type: 'text', text: 'While scrolled up' });
    const upOne = await bea.until(`(() => { const v = ${VIEW}; return v.below ? { ...v, mark: ${NEW_MARK('While scrolled up')} } : null; })()`);
    await post(pat, { type: 'text', text: 'Still scrolled up' });
    const upTwo = await bea.until(`(() => { const v = ${VIEW}; return v.below === '↓ 2 new' ? { ...v, mark: ${NEW_MARK('While scrolled up')} } : null; })()`);
    await bea.eval(`newBelow.click()`);
    const atEnd = await bea.until(`(() => { const v = ${VIEW}; return v.end && !v.below && v; })()`);
    await post(pat, { type: 'text', text: 'At the end' });
    const followed = await bea.until(`allMessages.some((m) => m.text === 'At the end') && (() => { const v = ${VIEW}; return v.end && !v.below && v; })()`);
    report(!!scrolled && !scrolled.end && !scrolled.below && !!upOne && upOne.top === scrolled.top && !upOne.end && upOne.below === '↓ 1 new' && upOne.tall >= 44 && upOne.mark.divider && upOne.mark.plain &&
      !!upTwo && upTwo.top === scrolled.top && upTwo.mark.divider && !!atEnd && !!followed,
      `scrolled up by 10 messages, a new message does not move the view and "↓ 1 new" appears, 44 px tall, the divider above it; a second reads "↓ 2 new"; the button goes to the end, where the next is followed (${JSON.stringify({ scrolled, upOne, upTwo: upTwo && upTwo.below, atEnd: !!atEnd, followed: !!followed })})`);
    // The divider above the view: messages followed at the end carry it up out of Bea's sight; she scrolls up a little
    // with the wheel, the divider still above what she reads, and the next message moves it down to itself. What she
    // reads stays where it was, as a browser without scroll anchoring draws it (Safari before 27: overflow-anchor none)
    // and as one with it does, where the page's own correction must come to nothing.
    const DIVIDER_ABOVE = `(() => { const d = place.divider; const f = feed.getBoundingClientRect(); const m = [...feed.querySelectorAll(':scope > .msg')].slice(-3);
      const h = m.reduce((a, x) => a + x.getBoundingClientRect().height, 0) / m.length; return !!d && d.isConnected && f.top - d.getBoundingClientRect().bottom > 2 * h ? h : 0; })()`;
    const STILL = async (expr) => { let last = null; for (let i = 0; i < 40; i++) { const v = await bea.eval(expr); if (last && JSON.stringify(v) === JSON.stringify(last)) return v; last = v; await sleep(150); } return null; };
    const legs = {};
    for (const anchoring of ['none', 'auto']) {
      await bea.eval(`feed.style.overflowAnchor = ${codeLiteral(anchoring)}; scrollToBottom(); window.__read = null; true`);
      let h = 0;
      for (let i = 1; i <= 15 && !h; i++) {
        const text = `Followed (anchoring ${anchoring}) ${i}`;
        await post(pat, { type: 'text', text });
        await bea.until(`allMessages.some((m) => m.text === ${codeLiteral(text)}) && (() => { const v = ${VIEW}; return v.end && !v.below; })()`);
        h = await bea.eval(DIVIDER_ABOVE);
      }
      const fd = await bea.eval(`(() => { const f = feed.getBoundingClientRect(); return { x: f.left + f.width / 2, y: f.top + f.height / 2 }; })()`);
      await bea.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: fd.x, y: fd.y, deltaX: 0, deltaY: -Math.round(h) });
      await bea.until('!place.atEnd');
      await bea.eval('window.__read = null; true');
      const before = await STILL(`(() => { const v = ${VIEW}; return { ...v, dividerAbove: place.divider.getBoundingClientRect().bottom < feed.getBoundingClientRect().top }; })()`);
      const text = `Moved the divider (anchoring ${anchoring})`;
      await post(pat, { type: 'text', text });
      await bea.until(`allMessages.some((m) => m.text === ${codeLiteral(text)})`);
      const after = await STILL(`(() => { const v = ${VIEW}; return { ...v, mark: ${NEW_MARK(text)} }; })()`);
      legs[anchoring] = { h: Math.round(h), before, after };
    }
    await bea.eval(`feed.style.overflowAnchor = ''; true`);
    report(Object.values(legs).every(({ h, before, after }) => h > 0 && !!before && before.dividerAbove && !before.end && !before.below && !!after && Math.abs(after.top - before.top) <= 1 &&
      after.below === '↓ 1 new' && !!after.mark && after.mark.divider && after.mark.plain),
      `with the divider above the view, a new message moves it down to itself and what the reader sees stays where it was, with scroll anchoring and without it (as Safari before 27) (${JSON.stringify(legs)})`);
    // Help in two taps, on a phone (Bea, On stage), each a tap at the control's centre: Help opens the dialog with its
    // heading focused and no category chosen; Enter in the words sends nothing and moves to the categories; Sound sends
    // at once. The button is then the request's chip: "■ Help asked", "▶ Pat is on the way" after Pat's On my way
    // (another page's); a tap asks in place, Keep it open focused; Cancel request deletes it. "Something else" arrives as
    // 'Other'; Escape keeps it open; It's sorted resolves it as Bea's, and "✓ Resolved" goes 30 s later (read at the end).
    const tapAt = async (tab, selector) => {
      const at = await tab.eval(`(() => { const e = document.querySelector(${codeLiteral(selector)}); if (!e || !e.getClientRects().length) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return e.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`);
      if (!at) return false;
      await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
      await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return true;
    };
    const key = async (tab, k, code, text) => {
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(text ? { text, unmodifiedText: text } : {}) });
      await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    };
    const waitFor = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true; return fn(); };
    const patHeard = [];
    for (const ev of ['message', 'messageDeleted', 'helpUpdate']) pat.on(ev, (x) => patHeard.push([ev, x]));
    const heardHelp = () => patHeard.filter(([ev, x]) => ev === 'message' && x.type === 'help');
    // What Bea's page itself sends for a help request, read on its socket before the server reads it (the server keeps
    // any category it does not know as 'Other', so only the page's own payload shows the word the page chose).
    await bea.eval(`(() => { window.__sentHelp = []; const real = socket.emit; socket.emit = function (ev, ...a) {
      if (ev === 'message' && a[0] && a[0].type === 'help') window.__sentHelp.push({ category: a[0].category, text: a[0].text }); return real.call(this, ev, ...a); }; })()`);
    const sentHelp = () => bea.eval(`JSON.stringify(window.__sentHelp)`);
    const fault = await bea.eval(`(() => { const i = document.createElement('i'); i.style.color = 'var(--c-fault)'; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; })()`);
    // The chip as drawn: read once its colours have settled (a button's background eases over 0.12 s).
    const SETTLED = `!document.getElementById('helpBtn').getAnimations().length`;
    const CHIP = `(() => { const b = document.getElementById('helpBtn'); return { words: b.textContent, state: b.dataset.state || '', red: getComputedStyle(b).backgroundColor === ${codeLiteral(fault)}, said: document.getElementById('helpStatus').textContent }; })()`;
    const opened = await tapAt(bea, '#helpBtn') && await bea.until(`document.getElementById('helpDialog').open && document.activeElement && document.activeElement.id === 'helpTitle'`, 3000);
    const dialogAt = await bea.eval(`JSON.stringify({ focused: document.activeElement.id, cats: [...document.querySelectorAll('#helpCats button')].map((b) => b.textContent),
      chosen: document.querySelectorAll('#helpCats [aria-pressed="true"], #helpCats .chosen, #helpCats :checked').length, hint: document.getElementById('helpText').enterKeyHint })`);
    await bea.eval(`document.getElementById('helpText').focus()`);
    await bea.send('Input.insertText', { text: 'Lectern mic 4 is dead' });
    await key(bea, 'Enter', 13, '\r');
    await sleep(600);
    const afterEnter = await bea.eval(`JSON.stringify({ open: document.getElementById('helpDialog').open, focused: document.activeElement && document.activeElement.dataset.cat, words: document.getElementById('helpText').value })`);
    const sentByEnter = heardHelp().length;
    const tappedSound = await tapAt(bea, '#helpCats button[data-cat="Sound"]');
    await waitFor(() => heardHelp().length === 1, 5000);
    const helpAsked = heardHelp()[0] ? heardHelp()[0][1] : null;
    const sentFirst = await sentHelp();
    const askedChip = await bea.until(`(() => { const c = ${CHIP}; return c.state === 'open' && !document.getElementById('helpDialog').open && ${SETTLED} && JSON.stringify(c); })()`, 5000);
    report(!!opened && dialogAt === JSON.stringify({ focused: 'helpTitle', cats: ['Sound', 'Vision', 'Lighting', 'Stage', 'Presenter', 'IT / network', 'Something else'], chosen: 0, hint: 'done' }) &&
      afterEnter === JSON.stringify({ open: true, focused: 'Sound', words: 'Lectern mic 4 is dead' }) && sentByEnter === 0 && tappedSound && !!helpAsked && helpAsked.category === 'Sound' && helpAsked.text === 'Lectern mic 4 is dead' &&
      sentFirst === JSON.stringify([{ category: 'Sound', text: 'Lectern mic 4 is dead' }]) && askedChip === JSON.stringify({ words: '■ Help asked', state: 'open', red: true, said: 'Your help request: Help asked' }),
      `help in two taps on a phone: Help opens the dialog with its heading focused and no category chosen; Enter in the words sends nothing and moves to the categories; a tap on Sound sends Sound at once, once, and Help reads "■ Help asked" on the fault red (${dialogAt}; ${afterEnter}; sent by Enter ${sentByEnter}; the page sent ${sentFirst}; ${askedChip})`);
    const coming = await emit(pat, 'help:respond', { messageId: helpAsked && helpAsked.id, state: 'coming' });
    const comingChip = await bea.until(`(() => { const c = ${CHIP}; return c.state === 'coming' && ${SETTLED} && JSON.stringify(c); })()`, 5000);
    const askOpen = await tapAt(bea, '#helpBtn') && await bea.until(`!!document.querySelector('#helpBtn + .agm-ask')`, 3000);
    const askRead = await bea.eval(`(() => { const a = document.querySelector('#helpBtn + .agm-ask'); const vis = (b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) && r.height >= 44; };
      const words = a.querySelectorAll('.agm-ask-words');
      return JSON.stringify({ role: a.getAttribute('role'), modal: a.getAttribute('aria-modal'), title: document.getElementById(a.getAttribute('aria-labelledby')).textContent, words: words[0].textContent, then: words[1].textContent,
        described: (a.getAttribute('aria-describedby') || '').split(' ').map((id) => (document.getElementById(id) || {}).className).join(), inHeader: a.previousElementSibling === document.getElementById('helpBtn'),
        buttons: [...a.querySelectorAll('button')].map((b) => b.textContent), reached: [...a.querySelectorAll('button')].every(vis), focused: document.activeElement.textContent, expanded: document.getElementById('helpBtn').getAttribute('aria-expanded') }); })()`);
    const cancelTapped = await bea.eval(`(() => { const b = [...document.querySelectorAll('#helpBtn + .agm-ask button')].find((x) => x.textContent === 'Cancel request'); b.id = '__cancel'; return true; })()`) && await tapAt(bea, '#__cancel');
    await waitFor(() => patHeard.some(([ev, x]) => ev === 'messageDeleted' && helpAsked && x.messageId === helpAsked.id), 5000);
    const cancelChip = await bea.until(`(() => { const c = ${CHIP}; return c.state === '' && !document.querySelector('#helpBtn + .agm-ask') && !allMessages.some((m) => m.type === 'help') && ${SETTLED} && JSON.stringify(c); })()`, 5000);
    report(!!coming && coming.ok && comingChip === JSON.stringify({ words: '▶ Pat is on the way', state: 'coming', red: false, said: 'Your help request: Pat is on the way' }) && askOpen &&
      askRead === JSON.stringify({ role: 'dialog', modal: 'false', title: 'Your help request', words: 'Sound: Lectern mic 4 is dead · ▶ Pat is on the way',
        then: 'It\'s sorted marks it resolved for everyone. Cancel request takes it away from everyone. Neither can be undone.', described: 'agm-ask-words,agm-ask-words', inHeader: true, buttons: ['It\'s sorted', 'Cancel request', 'Keep it open'], reached: true, focused: 'Keep it open', expanded: 'true' }) &&
      cancelTapped && patHeard.some(([ev, x]) => ev === 'messageDeleted' && x.messageId === helpAsked.id) && cancelChip === JSON.stringify({ words: 'Help', state: '', red: false, said: '' }),
      `the asker sees what happened: "▶ Pat is on the way" after Pat's On my way; a tap on the chip asks in place, right after the chip, naming the request and what each answer does for everyone (It's sorted, Cancel request, Keep it open, the last focused, every one on the screen and 44 px), and Cancel request deletes the request for the hall and puts Help back (${comingChip}; ${askRead}; ${cancelChip})`);
    // Something else, with no words: the page sends 'Other'. Then Escape keeps it open, so does Tab out of the ask (to the
    // header's next control), and It's sorted resolves it as Bea's.
    await tapAt(bea, '#helpBtn');
    await bea.until(`document.getElementById('helpDialog').open`, 3000);
    await tapAt(bea, '#helpCats button[data-cat="Other"]');
    await waitFor(() => heardHelp().length === 2, 5000);
    const other = heardHelp()[1] ? heardHelp()[1][1] : null;
    const sentBoth = await sentHelp();
    await bea.until(`(${CHIP}).state === 'open'`, 5000);
    await tapAt(bea, '#helpBtn');
    await bea.until(`!!document.querySelector('#helpBtn + .agm-ask')`, 3000);
    await key(bea, 'Escape', 27);
    const escaped = await bea.eval(`JSON.stringify({ ask: !!document.querySelector('#helpBtn + .agm-ask'), focused: document.activeElement.id, state: document.getElementById('helpBtn').dataset.state || '' })`);
    await tapAt(bea, '#helpBtn');
    const tabFrom = await bea.until(`!!document.querySelector('#helpBtn + .agm-ask') && document.activeElement.textContent`, 3000);
    await key(bea, 'Tab', 9);
    const tabbedOut = await bea.eval(`(() => { const help = document.getElementById('helpBtn'); const all = [...document.querySelectorAll('.app-meta button, .app-meta a[href]')].filter((x) => x.getClientRects().length);
      const next = all[all.indexOf(help) + 1]; return JSON.stringify({ ask: !!document.querySelector('#helpBtn + .agm-ask'), next: !!next && document.activeElement === next, state: help.dataset.state || '' }); })()`);
    await tapAt(bea, '#helpBtn');
    await bea.until(`!!document.querySelector('#helpBtn + .agm-ask')`, 3000);
    await bea.eval(`[...document.querySelectorAll('#helpBtn + .agm-ask button')].find((x) => x.textContent === "It's sorted").id = '__sorted'`);
    await tapAt(bea, '#__sorted');
    await waitFor(() => patHeard.some(([ev, x]) => ev === 'helpUpdate' && other && x.messageId === other.id && x.help.state === 'resolved'), 5000);
    const sortedBy = (patHeard.find(([ev, x]) => ev === 'helpUpdate' && other && x.messageId === other.id && x.help.state === 'resolved') || [])[1];
    const resolvedChip = await bea.until(`(() => { const c = ${CHIP}; return c.state === 'resolved' && ${SETTLED} && JSON.stringify(c); })()`, 5000);
    const helpResolvedAt = Date.now();
    report(sentBoth === JSON.stringify([{ category: 'Sound', text: 'Lectern mic 4 is dead' }, { category: 'Other', text: '' }]) && !!other && other.category === 'Other' && other.text === '' &&
      escaped === JSON.stringify({ ask: false, focused: 'helpBtn', state: 'open' }) && tabFrom === 'Keep it open' && tabbedOut === JSON.stringify({ ask: false, next: true, state: 'open' }) && heardHelp().length === 2 &&
      !!sortedBy && sortedBy.help.by === 'Bea' && resolvedChip === JSON.stringify({ words: '✓ Resolved', state: 'resolved', red: false, said: 'Your help request: Resolved' }),
      `"Something else" is sent by the page as 'Other' and arrives so; Escape closes the chip's ask and keeps the request open, and so does Tab from Keep it open, to the header's next control; It's sorted resolves it as Bea's, and Help reads "✓ Resolved" (the page sent ${sentBoth}; ${escaped}; ${tabbedOut}; ${resolvedChip})`);

    // A page back from a drop draws what it missed in one pass: Rob's page is away while 25 messages are sent, and on its
    // return draws all 25 with the feed's layout read a few times in all (where the reader was, once; the end, once; the
    // page's own scroll as the connection's strip goes) and the feed moved to the end once after them, never once per
    // message (a phone back on the Wi-Fi in a busy hall would stall on each).
    const rob = phones.research;
    await rob.eval(`(() => {
      scrollToBottom();
      const n = window.__layout = { reads: 0, toEnd: 0 };
      const sh = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      Object.defineProperty(feed, 'scrollHeight', { configurable: true, get() { n.reads++; return sh.get.call(this); } });
      const cs = window.__cs = window.getComputedStyle;
      window.getComputedStyle = function (el, ...rest) { if (el === feed) n.reads++; return cs.call(this, el, ...rest); };
      const stb = window.__stb = window.scrollToBottom;
      window.scrollToBottom = function () { n.toEnd++; return stb.apply(this, arguments); };
      socket.disconnect();
      return true;
    })()`);
    for (let i = 1; i <= 25; i++) await post(pat, { type: 'text', text: 'Missed ' + i });
    await rob.eval(`window.__layout.reads = 0; window.__layout.toEnd = 0; socket.connect(); true`);
    const caughtUp = await rob.until(`allMessages.some((m) => m.text === 'Missed 25') && (() => { const n = { ...window.__layout }; const v = ${VIEW};
      return { drawn: allMessages.filter((m) => /^Missed \\d+$/.test(m.text || '')).length, ...n, end: v.end }; })()`);
    await rob.eval(`delete feed.scrollHeight; window.getComputedStyle = window.__cs; window.scrollToBottom = window.__stb; true`);
    report(!!caughtUp && caughtUp.drawn === 25 && caughtUp.reads <= 4 && caughtUp.toEnd === 1 && caughtUp.end,
      `a page back from a drop draws the 25 messages it missed with the feed's layout read a few times in all and the feed moved to the end once (${JSON.stringify(caughtUp)})`);
    pat.close();
    ben.close();

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
      // Only an answer is cut: a request paused before its answer, or one whose body cannot be read, goes on as it is (and
      // the step's own check then says the stream was not cut).
      const b = p.responseStatusCode === undefined ? null : await admin.send('Fetch.getResponseBody', { requestId: p.requestId });
      if (!b || !b.result) { await admin.send('Fetch.continueRequest', { requestId: p.requestId }); return; }
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
    await readOldWords('the admin\'s support view of an On stage page', admin, `document.getElementById('userViewFrame').contentDocument`);
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
    await readOldWords('the sign-in and join page', signin);
    // A code no room has: the join form's words, from the lookup's answer (given here, so no miss is counted against this
    // address's code lock, which later legs join through).
    const joinDeck = await signin.eval(`(async () => {
      const real = AGM.api;
      AGM.api = async (method, url, ...rest) => (url.startsWith('/api/rooms/') ? { status: 200, exists: false } : real(method, url, ...rest));
      try {
        document.getElementById('name').value = 'Wes'; document.getElementById('code').value = 'ZZZ234';
        document.getElementById('joinForm').requestSubmit();
        for (let i = 0; i < 40 && !document.getElementById('error').textContent; i++) await new Promise((r) => { setTimeout(r, 25); });
        return JSON.stringify({ hint: document.getElementById('codeHint').textContent, refused: document.getElementById('error').textContent });
      } finally { AGM.api = real; document.getElementById('name').value = ''; document.getElementById('code').value = ''; }
    })()`);
    report(joinDeck === JSON.stringify({ hint: 'The 6-character code for your room.', refused: 'No room has that code. Check it with whoever gave it to you.' }), `the join form asks for the code of a room, and says so when no room has it (${joinDeck})`);
    // The first admin is made with the laptop's token: a wrong one is refused in place, the token field chosen again,
    // and nothing is made, though this browser holds the token's sign-in (the admin tab's), since a token typed is always
    // judged; the right one makes it.
    signin.expectFailure(/\/api\/setup$/);   // the wrong token's 401 is this step's own
    const wrongToken = await signin.eval(`(async () => {
      document.getElementById('setupToken').value = 'not the token'; document.getElementById('setupName').value = 'Ana Admin'; document.getElementById('setupUser').value = 'ana'; document.getElementById('setupPass').value = 'the green room kettle';
      document.getElementById('setupPane').requestSubmit();
      for (let i = 0; i < 80 && document.getElementById('setupError').hidden; i++) await new Promise((r) => { setTimeout(r, 25); });
      return JSON.stringify({ error: document.getElementById('setupError').textContent, focused: document.activeElement && document.activeElement.id, setup: (await AGM.api('GET', '/api/auth/me')).setup, at: location.pathname });
    })()`);
    report(wrongToken === JSON.stringify({ error: 'That is not the token in the AGMessage window.', focused: 'setupToken', setup: true, at: '/' }), `the first admin is not made with a wrong token: the pane says so and chooses the token again (${wrongToken})`);
    await signin.eval(`(() => { document.getElementById('setupToken').value = '${TOKEN}'; document.getElementById('setupPane').requestSubmit(); })()`);
    report(!!(await signin.until(`location.pathname === '/halls.html' && document.querySelectorAll('.hall-row').length >= 1 && document.getElementById('linkState').dataset.ok === '1'`)), 'the first admin lands on the halls board, live, with the hall listed');
    const boardHeld = await signin.until(`(() => { const li = [...document.querySelectorAll('#helpList .help-item')].find((x) => x.textContent.includes('mic 4 crackles')); return li && li.querySelector('.help-who').textContent; })()`);
    report(HELD_WORDS.test(String(boardHeld || '').split(' · ').slice(-2).join(' · ')), `a help request held for a minute reads "written … · sent …" on the halls board too (${boardHeld})`);
    // Beside the outbox's hall and its one request, a hall with two: each count agrees with its number. That hall goes
    // again once the board is read.
    const twoAsks = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Two asks' }) })).json()).code;
    const asker = await connect(base);
    const askerIn = await emit(asker, 'join', { roomCode: twoAsks, name: 'Hana', role: 'research' });
    const twoSent = [];
    for (const text of ['mic 7 is dead', 'no water at the lectern']) twoSent.push((await emit(asker, 'message', { type: 'help', category: 'Sound', text })).ok);
    const COUNTS = `[document.querySelector('.hall-row[data-code="${obHall}"] .help-count'), document.querySelector('.hall-row[data-code="${twoAsks}"] .help-count')].map((c) => c && c.textContent)`;
    const helpCounts = (await signin.until(`(() => { const [one, two] = ${COUNTS}; return one && /^■ 2 /.test(two || '') && JSON.stringify([one, two]); })()`)) || (await signin.eval(`JSON.stringify(${COUNTS})`));
    report(askerIn.ok && twoSent.join() === 'true,true' && helpCounts === JSON.stringify(['■ 1 needs help', '■ 2 need help']), `the halls board counts help in words that agree: "1 needs help", "2 need help" (${helpCounts})`);
    await readOldWords('the halls board', signin);
    asker.close();
    const closer = await connect(base, cookie);
    const twoGone = await emit(closer, 'admin:deleteRoom', { roomCode: twoAsks, purgeFiles: false });
    closer.close();
    report(!!(twoGone && twoGone.ok && (await signin.until(`!document.querySelector('.hall-row[data-code="${twoAsks}"]')`))), 'the hall made for the count goes again');
    // The halls board acts from the catalogue (kinds hall, help): a hall's row opens its menu by a right-click on its
    // name (its one link, whose menu is AGMessage's), its ⋯ and Shift+F10 alike; a help request's answers are its bar.
    const HALL_ROW = `document.querySelector('.hall-row[data-code="${obHall}"]')`;
    const HELP_ITEM = `[...document.querySelectorAll('#helpList > li[data-key]')].find((li) => li.textContent.includes('mic 4 crackles'))`;
    const boardDoors = {
      hall: await doorsOf(signin, 'hall', HALL_ROW, `AGM.page.object('hall', '${obHall}')`, { ...PAGE_DOORS_HALLS, hit: '.hall-name' }),
      help: await doorsOf(signin, 'help', HELP_ITEM, `AGM.page.object('help', (${HELP_ITEM}).dataset.key)`, { ...PAGE_DOORS_HALLS, hit: '.help-what' }),
    };
    for (const [what, d] of Object.entries(boardDoors)) report(doorsInStep(d), `the halls board's ${what}: right-click = ⋯ = Shift+F10 = the catalogue's set, the bar in it (${d.want}; ${d.right} / ${d.dots} / ${d.key}; ${d.inline}; hit ${d.hit})`);
    report(boardDoors.hall.want === JSON.stringify(['hall.open', 'hall.tab', 'hall.copy', 'hall.code', 'hall.setup']) && boardDoors.help.want === JSON.stringify(['help.respond', 'help.resolve', 'help.open']),
      `a hall's row offers Open, Open in a new tab, Copy link, Copy guest code and Set up…, and a help request its two answers and its hall (${boardDoors.hall.want}; ${boardDoors.help.want})`);
    // The hall's name is the row's one link: its ::after covers the row, so the row's other parts are the link's to a
    // pointer; a middle click on the name opens the hall in a tab of its own.
    const oneLink = await signin.eval(`(() => { const r = ${HALL_ROW}; const at = (sel) => { const q = r.querySelector(sel).getBoundingClientRect(); const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return h ? (h.closest('a') === r.querySelector('a.hall-open') ? 'link' : h.closest('.obj-more') ? 'more' : h.tagName) : 'nothing'; };
      return JSON.stringify({ links: r.querySelectorAll('a[href]').length, clock: at('.hall-clock'), last: at('.hall-last'), more: at('.obj-more'), href: r.querySelector('a.hall-open').getAttribute('href') }); })()`);
    const tabsBefore = new Set(((await edge.browserSend('Target.getTargets')).result || { targetInfos: [] }).targetInfos.map((x) => x.targetId));
    const nameAt = await middleOf(signin, `${HALL_ROW}.querySelector('.hall-name')`);
    for (const type of ['mousePressed', 'mouseReleased']) await signin.send('Input.dispatchMouseEvent', { type, x: nameAt.x, y: nameAt.y, button: 'middle', buttons: type === 'mousePressed' ? 4 : 0, clickCount: 1 });
    let tabOpened = null;
    for (let i = 0; i < 40 && !tabOpened; i++) {
      tabOpened = (((await edge.browserSend('Target.getTargets')).result || { targetInfos: [] }).targetInfos).find((x) => x.type === 'page' && !tabsBefore.has(x.targetId)) || null;
      if (!tabOpened) await sleep(100);
    }
    if (tabOpened) await edge.browserSend('Target.closeTarget', { targetId: tabOpened.targetId });
    const stayed = await signin.eval(`location.pathname`);
    report(JSON.stringify(JSON.parse(oneLink).links) === '1' && JSON.parse(oneLink).clock === 'link' && JSON.parse(oneLink).last === 'link' && JSON.parse(oneLink).more === 'more' && !!tabOpened && stayed === '/halls.html',
      `a hall's name is its row's one link, covering the row but its ⋯, and a middle click on it opens a tab of its own (${oneLink}; opened ${tabOpened ? tabOpened.url : 'nothing'})`);
    // A board frame while a hall's menu is open (a new message in that hall) draws the row again in place: the menu stays
    // open on the same ⋯, with the same items in the same order.
    await signin.eval(`(${HALL_ROW}).querySelector('.obj-more').click()`);
    const openIds = await signin.until(MENU_IDS, 3000);
    const poster = await connect(base);
    await emit(poster, 'join', { roomCode: obHall, name: 'Rex', role: 'research' });
    await emit(poster, 'message', { type: 'text', text: 'Frame while a menu is open' });
    const framed = await signin.until(`(${HALL_ROW}).querySelector('.hall-last').textContent.includes('Frame while a menu is open') && ${MENU_IDS}`, 5000);
    const stillOn = await signin.eval(`(${HALL_ROW}).querySelector('.obj-more').getAttribute('aria-expanded')`);
    await press(signin, 'Escape');
    poster.close();
    report(!!openIds && framed === openIds && stillOn === 'true', `a hall's menu stays open, its items in order, while a board frame redraws its row (${openIds} → ${framed}; ⋯ expanded ${stillOn})`);
    const skipBoard = await signin.eval(`(async () => { const s = document.querySelector('.skip-link'); s.focus(); const shown = s.getBoundingClientRect().top >= 0; s.click(); await new Promise((r) => setTimeout(r, 50)); return JSON.stringify({ words: s.textContent, shown, to: document.activeElement.id }); })()`);
    report(skipBoard === JSON.stringify({ words: 'Skip to the halls', shown: true, to: 'boardTitle' }), `the halls board's skip link takes the focus to the halls (${skipBoard})`);
    // The rows are one tab stop: ↓ moves to the next hall, and Enter on a focused hall would open it (its key).
    const roving = await signin.eval(`(() => { const rows = [...document.querySelectorAll('#hallList > li[data-key]')]; return JSON.stringify({ stops: rows.filter((r) => r.tabIndex === 0).length, inner: rows.slice(1).every((r) => [...r.querySelectorAll('a, button')].every((c) => c.tabIndex === -1)), keys: rows[0].getAttribute('aria-keyshortcuts') }); })()`);
    await signin.eval(`document.querySelector('#hallList > li[data-key]').focus()`);
    await press(signin, 'ArrowDown');
    const moved = await signin.eval(`document.activeElement === document.querySelectorAll('#hallList > li[data-key]')[1] && document.activeElement.tabIndex === 0`);
    report(roving === JSON.stringify({ stops: 1, inner: true, keys: 'Enter' }) && moved === true, `the halls are one tab stop, ↓ moves to the next, Enter opens the focused one (${roving}; moved ${moved})`);
    await sleep(600);
    await signin.shot(path.join(OUT, 'halls.png'));
    const users = await edge.tab(`${base}/users.html`);
    report(!!(await users.until(`document.querySelectorAll('#userRows tr').length === 1`)), 'the accounts page lists the admin');
    await readOldWords('the Accounts page', users);
    const rightsWords = await users.eval(`(async () => { const r = await AGM.api('GET', '/api/users'); return JSON.stringify([r.caps['display.control'], r.roles.find((x) => x.id === 'tech').words]); })()`);
    report(rightsWords === JSON.stringify(['Change what a hall\'s screens show', 'Their halls: messages, files, screens, Stagewatch']), `the Accounts page's rights and roles say "screens" (${rightsWords})`);
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
    // The Accounts page acts from the catalogue (kinds account, audit): an account's row and an entry of the audit log
    // open the same menu by right-click, ⋯ and Shift+F10; an account's Edit is its bar.
    const KIM_ROW = `[...document.querySelectorAll('#userRows > tr[data-key]')].find((tr) => tr.textContent.includes('kim'))`;
    const accountDoors = await doorsOf(users, 'account', KIM_ROW, `AGM.page.object('account', (${KIM_ROW}).dataset.key)`, { ...PAGE_DOORS_HALLS, hit: 'td strong' });
    report(doorsInStep(accountDoors) && accountDoors.want === JSON.stringify(['account.edit', 'account.password', 'account.signout', 'account.disable', 'account.remove']),
      `an account's row: right-click = ⋯ = Shift+F10 = Edit…, New one-time password…, Sign out everywhere…, Turn off…, Remove…, Edit in its bar (${accountDoors.want}; ${accountDoors.right} / ${accountDoors.dots} / ${accountDoors.key}; ${accountDoors.inline})`);
    // Remove…, asked in place inside the page and answered "Keep it": the account stays.
    await users.eval(`(${KIM_ROW}).querySelector('.obj-more').click()`);
    await users.until(`!!document.querySelector('.agm-menu [data-action="account.remove"]')`, 3000);
    await users.eval(`document.querySelector('.agm-menu [data-action="account.remove"]').click()`);
    const accountRemoveAsk = await users.until(`(() => { const a = document.querySelector('.agm-ask'); return a && a.querySelector('.agm-ask-title').textContent + ' | ' + a.querySelector('[data-answer=yes]').textContent + ' | ' + a.querySelector('[data-answer=no]').textContent; })()`, 3000);
    await users.eval(`document.querySelector('.agm-ask [data-answer=no]').click()`);
    const kimStays = await users.until(`!document.querySelector('.agm-ask') && !!(${KIM_ROW})`, 3000);
    report(accountRemoveAsk === 'Remove Kim Tech\'s account? | Remove | Keep it' && !!kimStays, `Remove… asks in place, named for the account, and "Keep it" keeps it (${accountRemoveAsk})`);
    const skipUsers = await users.eval(`(async () => { const s = document.querySelector('.skip-link'); s.focus(); const shown = s.getBoundingClientRect().top >= 0; s.click(); await new Promise((r) => setTimeout(r, 50)); return JSON.stringify({ words: s.textContent, shown, to: document.activeElement.id }); })()`);
    report(skipUsers === JSON.stringify({ words: 'Skip to the accounts', shown: true, to: 'peopleHead' }), `the Accounts page's skip link takes the focus to the accounts (${skipUsers})`);
    // An entry of the audit log: its doors; Only this actor keeps the list to that actor's entries, said above it, and
    // Show all brings the rest back.
    await users.eval(`document.getElementById('tabAudit').click()`);
    await users.until(`document.querySelectorAll('#auditList > li[data-key] .obj-more').length > 2`);
    const ROW = `document.querySelector('#auditList > li[data-key]:not([hidden])')`;
    const auditDoors = await doorsOf(users, 'audit', ROW, `AGM.page.object('audit', (${ROW}).dataset.key)`, { ...PAGE_DOORS_HALLS, hit: 'time' });
    report(doorsInStep(auditDoors) && JSON.parse(auditDoors.want).includes('audit.copy') && JSON.parse(auditDoors.want).includes('audit.export'),
      `an entry of the audit log: right-click = ⋯ = Shift+F10 = the catalogue's set (${auditDoors.want}; ${auditDoors.right} / ${auditDoors.dots} / ${auditDoors.key})`);
    const actorOf = await users.eval(`(${ROW}).querySelector('.audit-actor').textContent`);
    await users.eval(`(${ROW}).querySelector('.obj-more').click()`);
    await users.until(`!!document.querySelector('.agm-menu [data-action="audit.actor"]')`, 3000);
    await users.eval(`document.querySelector('.agm-menu [data-action="audit.actor"]').click()`);
    const kept = await users.until(`(() => { const rows = [...document.querySelectorAll('#auditList > li[data-key]')]; const shown = rows.filter((r) => !r.hidden); return !document.getElementById('auditFilter').hidden && shown.length > 0 && JSON.stringify({ words: document.getElementById('auditFilterWords').textContent, all: shown.every((r) => r.querySelector('.audit-actor').textContent === ${codeLiteral(actorOf)}), hidden: rows.length - shown.length, menuAll: AGM.catalog.ids('audit', AGM.page.facts(), AGM.page.object('audit', shown[0].dataset.key)).includes('audit.all') }); })()`, 3000);
    await users.eval(`document.getElementById('auditShowAll').click()`);
    const allBack = await users.until(`document.getElementById('auditFilter').hidden && [...document.querySelectorAll('#auditList > li[data-key]')].every((r) => !r.hidden)`, 3000);
    const keptOk = kept && JSON.parse(kept);
    report(!!keptOk && keptOk.all && keptOk.hidden > 0 && keptOk.menuAll && keptOk.words.startsWith('Only entries by ' + actorOf + ' · ') && /· \d+ of \d+ shown$/.test(keptOk.words) && !!allBack,
      `Only this actor keeps the log to ${actorOf}'s entries and says so; Show all brings the rest back (${kept})`);
    await users.eval(`document.getElementById('tabPeople').click()`);
    // The halls board and the Accounts page in both themes: every bar's acts and ⋯ 24 px or more with a mouse, their icons
    // 3:1 or more and their words 4.5:1 or more on what they sit on, none faded, an open menu's words 4.5:1 or more; and on
    // a phone, under a finger, the same acts and ⋯ 44 px or more.
    await users.until(`!!(${KIM_ROW}) && !!(${KIM_ROW}).querySelector('.obj-more')`);
    const boardInk = await barsInThemes(signin, HALL_ROW);
    const usersInk = await barsInThemes(users, KIM_ROW);
    report(barsOk(boardInk.light) && barsOk(boardInk.dark) && barsOk(usersInk.light) && barsOk(usersInk.dark),
      `the halls board and the Accounts page read in both themes: bars 24 px or more, icons 3:1, words 4.5:1, none faded, menus 4.5:1 (${JSON.stringify({ halls: boardInk, accounts: usersInk })})`);
    const fingers = {
      halls: await barsUnderAFinger(edge, base + '/halls.html', `document.querySelectorAll('#hallList .obj-bar > .obj-more').length > 0`),
      accounts: await barsUnderAFinger(edge, base + '/users.html', `document.querySelectorAll('#userRows .obj-bar > .obj-more').length > 0`),
    };
    report(Object.values(fingers).every((t) => t.coarse && barsOk(t) && t.problems.length === 0), `on a phone, under a finger, the halls board's and the Accounts page's acts and ⋯ are 44 px or more (${JSON.stringify(fingers)})`);
    // The page floor (docs/DEVICES.md). At it, without showModal(), the popover API, the Wake Lock and requestIdleCallback
    // (as Safari before 15.4 is): the halls board's New hall opens through AGM.openDialog's own, fixed in view above its
    // backdrop with the focus in it and the rest of the page hidden from a screen reader; Escape closes it and gives the
    // focus back to New hall; opened again, Enter in its name makes the hall (Save is the form's default button, never
    // Cancel) and it closes the same way. AGM.idle runs on its timer, and AGM.awake says why the screen may sleep. No
    // script error.
    const floor = await edge.tab(`${base}/halls.html`, { init: FLOOR });
    await floor.until(`document.querySelectorAll('.hall-row').length > 0 && document.getElementById('linkState').dataset.ok === '1' && !document.getElementById('newHallBtn').hidden`);
    const floorHas = await floor.eval(`JSON.stringify({ floor: document.documentElement.dataset.floor || '', showModal: typeof HTMLDialogElement.prototype.showModal, popover: typeof HTMLElement.prototype.showPopover, wakeLock: 'wakeLock' in navigator, idle: typeof window.requestIdleCallback, requestSubmit: typeof HTMLFormElement.prototype.requestSubmit })`);
    const openNewHall = `(() => { const b = document.getElementById('newHallBtn'); b.focus(); b.click(); })()`;
    await floor.eval(openNewHall);
    const floorOpened = await floor.until(FALLBACK_OPEN('hallDialog'), 3000);
    await key(floor, 'Escape', 27);
    const floorEscaped = await floor.until(FALLBACK_CLOSED('hallDialog'), 3000);
    await floor.eval(openNewHall);
    const floorAgain = await floor.until(FALLBACK_OPEN('hallDialog'), 3000);
    await floor.eval(`(() => { const i = document.getElementById('hallName'); i.value = 'Floor hall'; i.focus(); })()`);
    await key(floor, 'Enter', 13, '\r');
    const floorMade = await floor.until(`[...document.querySelectorAll('.hall-row')].some((r) => r.textContent.includes('Floor hall')) && ${FALLBACK_CLOSED('hallDialog')}`, 5000);
    report(floorHas === JSON.stringify({ floor: '', showModal: 'undefined', popover: 'undefined', wakeLock: false, idle: 'undefined', requestSubmit: 'undefined' }) && floorOpened === shownWith('hallName') && floorEscaped === closedTo('newHallBtn') && floorAgain === shownWith('hallName') && floorMade === closedTo('newHallBtn'),
      `at the floor, without showModal(): New hall opens through AGM.openDialog's own (${floorOpened}), Escape closes it with the focus back (${floorEscaped}), and Enter in its name makes the hall and closes it (${floorMade})`);
    // Escape and New hall again in one task: the close event Escape's close() sends comes after the new opening, and ends
    // nothing — the dialog stays open above its one backdrop with the focus in it — so Enter in its name makes the hall
    // and gives the focus back to New hall.
    const quick = JSON.parse(await floor.eval(RACED('hallDialog', `const b = document.getElementById('newHallBtn'); b.focus(); b.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));`, 'b.focus(); b.click();')) || 'null');
    await floor.eval(`(() => { const i = document.getElementById('hallName'); i.value = 'Quick hall'; i.focus(); })()`);
    await key(floor, 'Enter', 13, '\r');
    const quickMade = await floor.until(`[...document.querySelectorAll('.hall-row')].some((r) => r.textContent.includes('Quick hall')) && ${FALLBACK_CLOSED('hallDialog')}`, 5000);
    report(!!quick && quick.shut === closedTo('newHallBtn') && quick.heard === true && quick.open === shownWith('hallName') && quick.backdrops === 1 && quickMade === closedTo('newHallBtn'),
      `at the floor, New hall opened again before the browser's close event comes: the late event ends nothing (${JSON.stringify(quick)}), and Enter makes the hall with the focus back on New hall (${quickMade})`);
    const floorIdle = await floor.eval(`new Promise((r) => { const t0 = performance.now(); AGM.idle((d) => r(JSON.stringify({ slice: d.timeRemaining() <= 8, soon: performance.now() - t0 < 1000 }))); })`);
    const floorAwake = await floor.eval(`new Promise((r) => { AGM.awake((s) => r(JSON.stringify(s))); })`);
    report(floorIdle === JSON.stringify({ slice: true, soon: true }) && floorAwake === JSON.stringify({ held: false, why: 'settings', words: 'This device may sleep: set its screen to stay on in its own settings (Auto-Lock or Screen timeout).' }),
      `at the floor, AGM.idle runs on its timer within its 8 ms slice (${floorIdle}) and AGM.awake says why the screen may sleep (${floorAwake})`);
    report(floor.problems.length === 0, `the halls board at the floor: no script errors or CSP violations${floor.problems.length ? ' — ' + floor.problems.slice(0, 3).join(' | ') : ''}`);
    // The hall page at the floor, in the hall just made: Return in the composer sends without requestSubmit() (Safari
    // 16), the message taken by the server once, and no script error on the way.
    const floorHall = await floor.eval(`([...document.querySelectorAll('.hall-row')].find((r) => r.textContent.includes('Floor hall')) || {}).dataset.code`);
    const floorPad = await edge.tab(`${base}/app.html?code=${floorHall}&name=Floorpad&role=research`, { init: FLOOR });
    const padJoined = await floorPad.until(`typeof joined !== "undefined" && joined && typeof HTMLFormElement.prototype.requestSubmit === 'undefined'`);
    await floorPad.eval(`(() => { textInput.value = 'Sent at the floor by Return'; textInput.focus(); })()`);
    await key(floorPad, 'Enter', 13, '\r');
    const padSent = await floorPad.until(`!document.querySelector('.msg.echo') && textInput.value === '' && allMessages.filter((m) => m.text === 'Sent at the floor by Return').length === 1`, 5000);
    report(!!padJoined && !!padSent && floorPad.problems.length === 0,
      `the hall page at the floor: Return in the composer sends without requestSubmit(), taken once, and no script error${floorPad.problems.length ? ' — ' + floorPad.problems.slice(0, 3).join(' | ') : ''}`);
    // Help at the floor: opened through AGM.openDialog's own (no showModal()), the heading focused; a category sends it and
    // closes it, the focus back on Help, which is then the request's chip; its ask opens in place (no popover API).
    const openHelp = `(() => { const b = document.getElementById('helpBtn'); b.focus(); b.click(); })()`;
    await floorPad.eval(openHelp);
    const padHelp = await floorPad.until(FALLBACK_OPEN('helpDialog'), 3000);
    // Its Close and Help tapped again in one task (a tap moves no focus, as on an iPad): Close is the form's own
    // method="dialog", which the browser closes, its close event after the new opening. That opening ends as the new one
    // begins — one backdrop, the heading focused, the late event ending nothing — and the focus left in the closed dialog
    // is no opener: the category's close below gives it back to Help.
    const padRaced = JSON.parse(await floorPad.eval(RACED('helpDialog', `document.querySelector('#helpForm button[value="cancel"]').click();`, `document.getElementById('helpBtn').click();`)) || 'null');
    await floorPad.eval(`document.querySelector('#helpCats button[data-cat="Sound"]').click()`);
    const padHelpClosed = await floorPad.until(`${FALLBACK_CLOSED('helpDialog')}`, 3000);
    await floorPad.until(`document.getElementById('helpBtn').dataset.state === 'open'`, 5000);
    await floorPad.eval(openHelp);
    const padAsk = await floorPad.until(`(() => { const a = document.querySelector('#helpBtn + .agm-ask'); return a && JSON.stringify({ focused: document.activeElement.textContent, fixed: getComputedStyle(a).position === 'fixed' }); })()`, 3000);
    await key(floorPad, 'Escape', 27);
    const padAskGone = await floorPad.until(`!document.querySelector('.agm-ask') && document.activeElement.id === 'helpBtn' && 'kept'`, 3000);
    report(!!padRaced && !!padRaced.shut && padRaced.heard === true && padRaced.open === shownWith('helpTitle') && padRaced.backdrops === 1,
      `the hall page at the floor: Help's Close (the browser's own) and Help again in one task: the closed opening ends as the new one begins, and the late close event ends nothing (${JSON.stringify(padRaced)})`);
    report(padHelp === shownWith('helpTitle') && padHelpClosed === closedTo('helpBtn') && padAsk === JSON.stringify({ focused: 'Keep it open', fixed: true }) && padAskGone === 'kept' && floorPad.problems.length === 0,
      `the hall page at the floor: Help opens through AGM.openDialog's own (${padHelp}), a category sends it and closes it (${padHelpClosed}), and the chip's ask opens in place, Keep it open focused, Escape keeping the request (${padAsk}; ${padAskGone})`);
    floorPad.close();
    // With no <dialog> at all beside it (below Safari 15.4): the Accounts page's Add a person opens the same way, its Cancel
    // closes it without leaving the page and saves nothing; Escape closes it; Enter in a field submits through Save, the
    // dialog's own submit carrying it as its submitter (a form of method "dialog" would otherwise be sent to the page's
    // address); the audit log's Export… opens and its Cancel closes it.
    const noDialog = await edge.tab(`${base}/users.html`, { init: FLOOR + NO_DIALOG });
    await noDialog.until(`document.querySelectorAll('#userRows tr').length >= 1`);
    const noDialogHas = await noDialog.eval(`(() => { window.__stayed = 1; return JSON.stringify({ close: typeof HTMLDialogElement.prototype.close, submitter: 'submitter' in SubmitEvent.prototype, rows: document.querySelectorAll('#userRows tr').length }); })()`);
    const openAdd = `(() => { const b = document.getElementById('newUserBtn'); b.focus(); b.click(); })()`;
    await noDialog.eval(openAdd);
    const addOpened = await noDialog.until(FALLBACK_OPEN('userDialog'), 3000);
    const addOwn = await noDialog.eval(`(() => { const d = document.getElementById('userDialog'); return JSON.stringify({ open: d.open, close: Object.prototype.hasOwnProperty.call(d, 'close') }); })()`);
    await noDialog.eval(`(() => { document.getElementById('uName').value = 'Floor Fay'; document.getElementById('uUser').value = 'fay'; document.querySelector('#userForm button[value="cancel"]').click(); })()`);
    const addCancelled = await noDialog.until(FALLBACK_CLOSED('userDialog'), 3000);
    const addStayed = await noDialog.eval(`JSON.stringify({ stayed: window.__stayed === 1 && location.search === '', returned: document.getElementById('userDialog').returnValue, open: document.getElementById('userDialog').open })`);
    await noDialog.eval(openAdd);
    await noDialog.until(FALLBACK_OPEN('userDialog'), 3000);
    await key(noDialog, 'Escape', 27);
    const addEscaped = await noDialog.until(FALLBACK_CLOSED('userDialog'), 3000);
    // Enter in a field submits through the form's default button, Save (Cancel is a plain button), and the submit event
    // carries it as its submitter, which this browser does not give: heard on the dialog and stopped there, so nothing is
    // saved; Cancel then closes it.
    await noDialog.eval(openAdd);
    await noDialog.until(FALLBACK_OPEN('userDialog'), 3000);
    await noDialog.eval(`(() => { const d = document.getElementById('userDialog'); window.__submitter = '';
      d.addEventListener('submit', (e) => { window.__submitter = e.submitter ? e.submitter.value : 'none'; e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
      document.getElementById('uName').value = 'Floor Fay'; document.getElementById('uUser').value = 'fay'; document.getElementById('uName').focus(); })()`);
    await key(noDialog, 'Enter', 13, '\r');
    const enterSubmitter = await noDialog.until(`window.__submitter`, 3000);
    await noDialog.eval(`document.querySelector('#userForm button[value="cancel"]').click()`);
    const enterClosed = await noDialog.until(FALLBACK_CLOSED('userDialog'), 3000);
    await noDialog.eval(`document.getElementById('tabAudit').click()`);
    await noDialog.until(`!document.getElementById('exportBtn').hidden`);
    await noDialog.eval(`(() => { const b = document.getElementById('exportBtn'); b.focus(); b.click(); })()`);
    const exportOpened = await noDialog.until(`document.getElementById('exportDialog') && ${FALLBACK_OPEN('exportDialog')}`, 3000);
    await noDialog.eval(`document.getElementById('exportCancel').click()`);
    const exportClosed = await noDialog.until(FALLBACK_CLOSED('exportDialog'), 3000);
    const noneMade = await noDialog.eval(`AGM.api('GET', '/api/users').then((r) => !r.users.some((u) => u.username === 'fay'))`);
    report(noDialogHas === JSON.stringify({ close: 'undefined', submitter: false, rows: JSON.parse(noDialogHas).rows }) && addOpened === shownWith('uName') && addOwn === JSON.stringify({ open: true, close: true })
      && addCancelled === closedTo('newUserBtn') && addStayed === JSON.stringify({ stayed: true, returned: 'cancel', open: false }) && noneMade === true && addEscaped === closedTo('newUserBtn')
      && enterSubmitter === 'save' && enterClosed === closedTo('newUserBtn')
      && exportOpened === shownWith('exportCancel') && exportClosed === closedTo('exportBtn'),
      `with no <dialog> at all: Add a person opens (${addOpened}), its Cancel closes it on the page and saves nothing (${addStayed}), Escape closes it (${addEscaped}), Enter in a field submits through Save with its submitter (${enterSubmitter}; ${enterClosed}), and Export… opens and closes (${exportOpened}; ${exportClosed})`);
    report(noDialog.problems.length === 0, `the Accounts page with no <dialog>: no script errors or CSP violations${noDialog.problems.length ? ' — ' + noDialog.problems.slice(0, 3).join(' | ') : ''}`);
    // Below the floor (no WeakRef: before Safari 14.1 and Chrome 84), every page with people says so in one line and shows
    // nothing else, and none asks the server anything or opens a socket: nothing is fetched, health's clients does not
    // move, and the hall never hears of the guest. The sign-in form, sent by its script's own way, goes nowhere: no
    // password ever rides in the page's address, whether or not the stylesheet hid the form. The
    // hall page ends its own script there on purpose (a classic script's top level has no return): its one exception says
    // so; every other page is quiet.
    const clientsNow = async () => (await (await fetch(base + '/api/health', { headers: { cookie } })).json()).clients;
    const clientsBefore = await clientsNow();
    const below = {};
    for (const [name, url] of [['the sign-in page', '/'], ['the halls board', '/halls.html'], ['the Accounts page', '/users.html'], ['the admin page', '/admin.html'], ['the hall page', `/app.html?code=${code}&name=Oldpad&role=research`]]) {
      below[name] = await edge.tab(base + url, { init: BELOW });
    }
    const BELOW_READ = `(() => { const shown = [...document.body.children].filter((e) => getComputedStyle(e).display !== 'none'); return document.readyState === 'complete' && document.documentElement.dataset.floor === 'old' && shown.length > 0 && JSON.stringify(shown.map((e) => e.className + ': ' + e.textContent)); })()`;
    const belowRead = {};
    for (const [name, tab] of Object.entries(below)) belowRead[name] = await tab.until(BELOW_READ);
    await below['the sign-in page'].eval(`(() => { document.getElementById('username').value = 'ana'; document.getElementById('password').value = 'never-in-a-url'; document.getElementById('signInPane').requestSubmit(); })()`);
    await sleep(1500);
    const clientsAfter = await clientsNow();
    const heardOld = await research.eval(`document.getElementById('peopleList').textContent.includes('Oldpad')`);
    const belowAsked = {};
    for (const [name, tab] of Object.entries(below)) belowAsked[name] = await tab.eval(`JSON.stringify(window.__asked)`);
    const signInStayed = await below['the sign-in page'].eval(`JSON.stringify({ search: location.search, floor: document.documentElement.dataset.floor })`);
    report(Object.values(belowRead).every((r) => r === JSON.stringify(['agm-floor: ' + FLOOR_WORDS])) && Object.values(belowAsked).every((a) => a === '[]') && clientsAfter === clientsBefore && heardOld === false
      && signInStayed === JSON.stringify({ search: '', floor: 'old' }),
      `below the floor every page with people shows the floor's words and nothing else, asks nothing and opens no socket, and its sign-in form goes nowhere (asked ${JSON.stringify(belowAsked)}; clients ${clientsBefore} → ${clientsAfter}; sign-in ${signInStayed}; ${JSON.stringify(belowRead)})`);
    const belowProblems = Object.entries(below).map(([name, tab]) => [name, tab.problems]);
    report(belowProblems.every(([name, p]) => (name === 'the hall page' ? p.length === 1 && /below AGMessage's page floor/.test(p[0]) : p.length === 0)),
      `below the floor: the hall page's script ends on its one exception, and no other page has a script error${belowProblems.some(([, p]) => p.length) ? ' — ' + JSON.stringify(belowProblems.filter(([, p]) => p.length)) : ''}`);
    for (const tab of Object.values(below)) tab.close();
    const floorCloser = await connect(base, cookie);
    report(!!floorHall && !!(await emit(floorCloser, 'admin:deleteRoom', { roomCode: floorHall, purgeFiles: false })).ok, 'the hall made at the floor goes again');
    floorCloser.close();
    floor.close();
    noDialog.close();
    const hallView = await edge.tab(`${base}/app.html?code=${code}&as=account&role=research`);
    report(!!(await hallView.until(`typeof joined !== "undefined" && joined && document.getElementById('whoami').textContent.startsWith('Ana Admin')`)), 'an account opens its hall with its own name');
    await readOldWords('the hall page opened by an account, Backstage', hallView);

    // Screens: the account adds one from the hall's Screens console; its link opens a display page that shows a message
    // (fitted to the screen) and the countdown, and confirms each — the console then reads ✓ on screen.
    report(!!(await hallView.until(`!document.getElementById('screensBtn').hidden`)), 'the hall view offers Screens to an account that may drive them');
    const made = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Lectern monitor' }, r))`);
    const screen = await edge.tab(`${base}${made.display.path}`);
    report(!!(await screen.until(`document.body.dataset.kind === 'holding' && document.getElementById('idleName').textContent.includes('Lectern monitor')`)), 'a display link opens a holding screen named for the crew');
    await readOldWords('a screen', screen);
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
    // Set up… is on the hall row's ⋯ (the catalogue's hall.setup).
    await signin.eval(`document.querySelector('.hall-row[data-code="${code}"] .obj-more').click()`);
    await signin.until(`!!document.querySelector('.agm-menu [data-action="hall.setup"]')`, 3000);
    await signin.eval(`document.querySelector('.agm-menu [data-action="hall.setup"]').click()`);
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

    // ---------------- One catalogue, every door: a message's, a file's and a screen's acts (catalog.js, menus.js) ----------------
    // On each page, for each object: right-click, ⋯ and Shift+F10 open the catalogue's shown set for it and nothing else;
    // the key's menu takes the focus to its first enabled item and Escape gives it back; the object's own bar is in its
    // menu under the same names. The pages here are a backstage guest (research), the Board (board) and an account with
    // the hall's screens and its Stagewatch (hallView).
    await hallView.eval(`document.getElementById('screensDialog').open && document.getElementById('screensClose').click()`);
    const postFrom = (tab, args) => tab.eval(`new Promise((r) => socket.emit('message', ${codeLiteral(args)}, (x) => r(x.id)))`);
    const doorMsgs = {
      adminText: await postFrom(hallView, { type: 'text', text: 'Doors: the account\'s note' }),
      adminAsk: await postFrom(hallView, { type: 'action', text: 'Doors: ready for the vote?', options: ['Yes', 'No'] }),
      adminHelp: await postFrom(hallView, { type: 'help', category: 'Vision', text: 'Doors: screen 3 is blue' }),
      chairText: await postFrom(board, { type: 'text', text: 'Doors: from the stage' }),
      ownText: await postFrom(research, { type: 'text', text: 'Doors: a backstage note' }),
    };
    const capexId = await research.eval(`allMessages.find((m) => m.filename === 'capex.pdf').id`);
    const drawnAll = `${codeLiteral(Object.values(doorMsgs))}.every((id) => messagesById.has(id))`;
    await Promise.all([research.until(drawnAll), board.until(drawnAll), hallView.until(drawnAll)]);
    // The account's page reads its doors once its hall's Stagewatch is up, as the sets below expect.
    await hallView.until(`F.stageWhy === '' && F.canPropose && F.canSendToStage`, 8000);
    const msgDoors = async (tab, id) => doorsOf(tab, 'msg', `messagesById.get(${codeLiteral(id)})`, `findMessage(${codeLiteral(id)})`, { hit: 'time' });
    const doorRuns = {};
    for (const [name, id] of [...Object.entries(doorMsgs), ['capex', capexId]]) doorRuns['research ' + name] = await msgDoors(research, id);
    for (const name of ['chairText', 'adminAsk']) doorRuns['account ' + name] = await msgDoors(hallView, doorMsgs[name]);
    doorRuns['account capex'] = await msgDoors(hallView, capexId);
    doorRuns['board adminAsk'] = await msgDoors(board, doorMsgs.adminAsk);
    const outOfStep = Object.entries(doorRuns).filter(([, d]) => !doorsInStep(d));
    report(outOfStep.length === 0, `a message's right-click, ⋯ and Shift+F10 open the catalogue's set for it, the key's menu focused on its first enabled item and Escape giving the focus back, and its bar is in its menu under the same names: ${Object.keys(doorRuns).length} messages on three seats${outOfStep.length ? ' — not: ' + JSON.stringify(outOfStep) : ''}`);
    const fineTargets = await research.eval(`Math.min(...[...document.querySelectorAll('#feed .msg-act, #feed .obj-more')].filter((b) => b.getClientRects().length > 0).map((b) => { const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }))`);
    report(fineTargets >= 24, `with a mouse, a message's acts and its ⋯ are 24 px or more (the smallest ${fineTargets} px)`);
    report(JSON.parse(doorRuns['account chairText'].key).includes('msg.speaker') && JSON.parse(doorRuns['account capex'].key).includes('msg.screens') && JSON.parse(doorRuns['board adminAsk'].key).includes('msg.answer') && !JSON.parse(doorRuns['board adminAsk'].key).includes('msg.speaker'),
      `the sets are the seat's: the account's has Ask the operator and Show on screens, the Board's an answer (${doorRuns['account chairText'].key}; ${doorRuns['account capex'].key}; ${doorRuns['board adminAsk'].key})`);

    // Nothing moves under an open menu (menus.js keep()). The hall's seen receipts land when they land, so a frame can land
    // while a message's menu is open and draw "✓ Seen by" into the account's messages above it. Drawn here through the
    // page's own path: the receipts taken back to before the doors' messages, the menu opened, then the receipts given again
    // under it, taken and given once more: the ⋯ stays where it was, out from under its menu, and pressing it closes the
    // menu with the focus on it. In a window too short for the menu's rows above or below its ⋯, the menu takes the side
    // with more room and scrolls, never over its ⋯ (menus.js spot()), and pressing the ⋯ closes it the same.
    const askSel = `messagesById.get(${codeLiteral(doorMsgs.adminAsk)})`;
    const askDots = `${askSel}.querySelector('.obj-more')`;
    const aboveAsk = `messagesById.get(${codeLiteral(doorMsgs.adminText)})`;
    const DOTS_READ = `(() => { const q = ${askDots}.getBoundingClientRect(); const c = { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
      const m = document.querySelector('.agm-menu:not(.agm-sub)'); const r = m && m.getBoundingClientRect();
      return JSON.stringify({ at: Math.round(q.top), c, hit: document.elementFromPoint(c.x, c.y) === ${askDots}, menu: r ? [Math.round(r.top), Math.round(r.bottom)] : null,
        over: !!r && r.top < q.bottom && q.top < r.bottom && r.left < q.right && q.left < r.right, scrolls: !!m && m.scrollHeight > m.clientHeight, inside: !!r && r.top >= 8 && r.bottom <= innerHeight - 8,
        line: !!${aboveAsk}.querySelector('.seen-line') }); })()`;
    const openAsk = async () => { await hallView.eval(`${askSel}.scrollIntoView({ block: 'center' })`); await leftClick(hallView, await middleOf(hallView, askDots)); return hallView.until(MENU_IDS, 3000); };
    const closeOnDots = async (read) => { await leftClick(hallView, read.c); return !!(await hallView.until(`${NO_MENU} && document.activeElement === ${askDots}`, 3000)); };
    await hallView.until(`!!${aboveAsk}.querySelector('.seen-line')`, 8000);
    const receipts = await hallView.eval('JSON.stringify([...seenBy.values()])');
    const firstDoor = await hallView.eval(`findMessage(${codeLiteral(doorMsgs.adminText)}).seq`);
    const TAKE = `const all = [...seenBy.values()]; seenBy.clear(); all.forEach((s) => noteSeen(Object.assign({}, s, { seq: Math.min(s.seq, ${firstDoor} - 1) }))); refreshSeenLines();`;
    const GIVE = `JSON.parse(${codeLiteral(receipts)}).forEach(noteSeen); refreshSeenLines();`;
    const settled = async (act) => JSON.parse(await hallView.eval(`(async () => { ${act} await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return ${DOTS_READ}; })()`));
    await settled(TAKE);
    const seenOpen = await openAsk();
    const seenBefore = JSON.parse(await hallView.eval(DOTS_READ));
    const seenSteps = [await settled(GIVE), await settled(TAKE), await settled(GIVE)];
    const seenClosed = await closeOnDots(seenSteps[2]);
    report(!!seenOpen && !seenBefore.line && seenSteps.map((r) => r.line).join() === 'true,false,true' && seenSteps.every((r) => r.at === seenBefore.at && r.hit && !r.over) && seenClosed,
      `a message's ⋯ stays where it was while seen lines are drawn into the message above it under its open menu, out from under the menu, and pressing it closes the menu with the focus on it (⋯ at ${seenBefore.at} px, then ${seenSteps.map((r) => r.at + (r.line ? ' with the line' : ' without')).join(', ')}; menu ${JSON.stringify(seenSteps[0].menu)}; reached ${seenSteps.map((r) => r.hit).join('/')}; closed ${seenClosed})`);
    await hallView.eval('AGM.menu.close()');   // the short window's check opens its own menu, from none
    const vw = await hallView.eval('innerWidth');
    await hallView.resize(vw, 420);
    const shortOpen = await openAsk();
    const shortRead = JSON.parse(await hallView.eval(DOTS_READ));
    const shortClosed = await closeOnDots(shortRead);
    await hallView.send('Emulation.clearDeviceMetricsOverride');
    report(!!shortOpen && !shortRead.over && shortRead.hit && shortRead.scrolls && shortRead.inside && shortClosed,
      `in a window 420 px high a message's ⋯ menu that fits neither under nor above its ⋯ scrolls on the side with more room, never over the ⋯, and pressing the ⋯ closes it (⋯ at ${shortRead.at} px, menu ${JSON.stringify(shortRead.menu)}, scrolls ${shortRead.scrolls}; reached ${shortRead.hit}; closed ${shortClosed})`);

    // A pinned message is drawn afresh in the pinned strip, so every act of it works there as in the feed: a question's
    // 📝 (its bar), a message's 🖥 Send now and ⧉ Show on screens… (its ⋯), a help request's On my way, a question's answer.
    for (const name of ['adminText', 'adminAsk', 'adminHelp']) await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs[name])}, pinned: true }, r))`);
    const pinnedCopy = (name) => `document.querySelector('#pinnedList .msg[data-id="' + ${codeLiteral(doorMsgs[name])} + '"]')`;
    await hallView.until(`${pinnedCopy('adminText')} && ${pinnedCopy('adminAsk')} && ${pinnedCopy('adminHelp')}`);
    await hallView.eval(`${pinnedCopy('adminAsk')}.querySelector('.msg-acts [data-action="msg.speaker"]').click()`);
    const proposeOpened = await hallView.until(`document.getElementById('swDialog').open && document.getElementById('swText').value === 'Doors: ready for the vote?'`, 5000);
    await hallView.eval(`document.getElementById('swDialog').close()`);
    await hallView.eval(`(() => { window.__sent = []; const emit = socket.emit; socket.emit = function (ev, ...a) { window.__sent.push(ev); return emit.call(this, ev, ...a); }; const t = document.getElementById('agmToast'); if (t) t.textContent = ''; })()`);
    await hallView.eval(`${pinnedCopy('adminText')}.querySelector('.obj-more').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-fold="speaker"]')`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="speaker"]').click()`);
    await hallView.until(`!!document.querySelector('.agm-sub .agm-mi[data-action="msg.sendNow"]')`);
    await hallView.eval(`document.querySelector('.agm-sub .agm-mi[data-action="msg.sendNow"]').click()`);
    const sentNow = await hallView.until(`window.__sent.includes('stage:send') && (document.getElementById('agmToast') || {}).textContent`, 8000);
    await hallView.eval(`${pinnedCopy('adminText')}.querySelector('.obj-more').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="msg.screens"]')`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="msg.screens"]').click()`);
    const screensOpened = await hallView.until(`document.getElementById('screensDialog').open && document.getElementById('screenMsgText').value === 'Doors: the account\\'s note'`, 5000);
    await hallView.eval(`document.getElementById('screensClose').click()`);
    await hallView.eval(`${pinnedCopy('adminHelp')}.querySelector('[data-action="msg.helpRespond"]').click()`);
    await hallView.eval(`${pinnedCopy('adminAsk')}.querySelector('.action-btn[data-value="0"]').click()`);
    const pinnedActed = await hallView.until(`(() => { const h = findMessage(${codeLiteral(doorMsgs.adminHelp)}); const q = findMessage(${codeLiteral(doorMsgs.adminAsk)});
      return h && h.help && h.help.state === 'coming' && q && (q.responses || []).some((r) => r.uid === MY_UID && r.optionIndex === 0) && JSON.stringify({ help: h.help.state, answered: q.options[0] }); })()`, 8000);
    report(!!proposeOpened && /^(On the speaker's screen|Stagewatch took it)/.test(sentNow || '') && !!screensOpened && !!pinnedActed,
      `in the pinned strip a question's 📝 opens the Stagewatch dialog, a message's 🖥 Send now sends and its ⧉ opens Screens with its words, a help request's On my way and a question's answer are taken (${JSON.stringify({ proposeOpened: !!proposeOpened, sentNow, screensOpened: !!screensOpened, pinnedActed })})`);
    // A pinned copy is drawn again in place: a reaction from another page keeps the focus on it, and a menu opened from
    // it with Shift+F10 gives the focus back to it on Escape, though a reaction redrew it meanwhile.
    const textNow = `findMessage(${codeLiteral(doorMsgs.adminText)})`;
    const reactOnText = (emoji, on) => board.eval(`new Promise((r) => socket.emit('react', { messageId: ${codeLiteral(doorMsgs.adminText)}, emoji: ${codeLiteral(emoji)}, on: ${on} }, r))`);
    await hallView.eval(`(() => { window.__copy = ${pinnedCopy('adminText')}; window.__copy.focus(); })()`);
    await reactOnText('🎉', true);
    const copyKept = await hallView.until(`(${textNow}.reactions || []).some((r) => r.emoji === '🎉') && window.__copy.querySelector('.reactions').textContent.includes('🎉') && document.activeElement === window.__copy && window.__copy.isConnected && 'kept'`, 5000);
    await press(hallView, 'F10', { shift: true });
    const copyMenu = await hallView.until(MENU_IDS, 3000);
    await reactOnText('🎉', false);
    await hallView.until(`!(${textNow}.reactions || []).some((r) => r.emoji === '🎉')`, 5000);
    await press(hallView, 'Escape');
    const copyBack = await hallView.until(`${NO_MENU} && document.activeElement === window.__copy && window.__copy.isConnected && 'back'`, 3000);
    report(copyKept === 'kept' && !!copyMenu && copyBack === 'back',
      `a pinned copy keeps the focus while another page's reaction redraws it, and its menu gives the focus back to it on Escape (${JSON.stringify({ copyKept, copyMenu: !!copyMenu, copyBack })})`);
    for (const name of ['adminText', 'adminAsk', 'adminHelp']) await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs[name])}, pinned: false }, r))`);

    // Not connected: an act on something is drawn disabled, says why when chosen, and sends nothing. (The account's page:
    // it joins again as its account, where a guest's page in this browser would now carry the admin's sign-in.)
    await hallView.eval(`socket.disconnect()`);
    await hallView.until(`!F.connected`);
    await hallView.eval(`(() => { window.__sent = []; const t = document.getElementById('agmToast'); if (t) t.textContent = ''; })()`);
    await hallView.eval(`messagesById.get(${codeLiteral(doorMsgs.chairText)}).querySelector('.obj-more').click()`);
    const pinRow = await hallView.until(`(() => { const r = document.querySelector('.agm-menu .agm-mi[data-action="msg.pin"]'); return r && JSON.stringify({ disabled: r.getAttribute('aria-disabled'), why: r.querySelector('.mi-why').textContent, focusable: r.tabIndex === -1 && !r.disabled }); })()`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="msg.pin"]').click()`);
    const saidWhy = await hallView.until(`(document.getElementById('agmToast') || {}).textContent`);
    const sentOffline = await hallView.eval(`JSON.stringify(window.__sent)`);
    await press(hallView, 'Escape');
    await hallView.eval(`socket.connect()`);
    await hallView.until(`socket.connected && joined && F.connected`, 8000);
    report(pinRow === JSON.stringify({ disabled: 'true', why: 'Not connected — AGMessage is reconnecting.', focusable: true }) && saidWhy === 'Not connected — AGMessage is reconnecting.' && sentOffline === '[]',
      `not connected, Pin is shown disabled and focusable with its reason, says it when chosen, and sends nothing (${pinRow}; "${saidWhy}"; sent ${sentOffline})`);

    // An open menu keeps its items and their order while its message changes under it: pinned elsewhere, its Pin reads Unpin
    // in place, and nothing moves.
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more').click()`);
    const idsBefore = await research.until(MENU_IDS);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs.ownText)}, pinned: true }, r))`);
    await board.eval(`new Promise((r) => socket.emit('react', { messageId: ${codeLiteral(doorMsgs.ownText)}, emoji: '👀', on: true }, r))`);
    const relabelled = await research.until(`(() => { const r = document.querySelector('.agm-menu .agm-mi[data-action="msg.pin"]'); return r && r.getAttribute('aria-label') === 'Unpin' && findMessage(${codeLiteral(doorMsgs.ownText)}).reactions.length > 0 && 'Unpin'; })()`, 5000);
    const idsAfter = await research.eval(MENU_IDS);
    await research.eval(`AGM.menu.close()`);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs.ownText)}, pinned: false }, r))`);
    report(!!relabelled && idsBefore === idsAfter && !!idsBefore, `an open menu keeps its items and their order as its message is pinned and reacted to elsewhere; Pin reads Unpin in place (${idsBefore} → ${idsAfter})`);

    // A single key on the focused message: P pins it, with Undo in the toast for 10 s; Undo unpins it.
    await research.until(`!findMessage(${codeLiteral(doorMsgs.ownText)}).pinned`);
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).focus()`);
    await press(research, 'p');
    const keyPinned = await research.until(`findMessage(${codeLiteral(doorMsgs.ownText)}).pinned && (document.getElementById('agmToast') || {}).textContent`, 5000);
    await research.eval(`document.querySelector('#agmToast .toast-undo').click()`);
    const undone = await research.until(`!findMessage(${codeLiteral(doorMsgs.ownText)}).pinned && 'unpinned'`, 5000);
    report(keyPinned === 'Pinned. · Undo' && undone === 'unpinned', `P on a focused message pins it and the toast's Undo unpins it ("${keyPinned}", then ${undone})`);

    // ---------------- Every act's path on a message, from a page that may send elsewhere ----------------
    // The admin lets the backstage page forward into a second hall: the page is told, and asks which halls it may send to.
    const hallTwo = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Doors two' }) })).json()).code;
    const ctlDoors = await connect(base, cookie);
    const researchSid = await research.eval('socket.id');
    const linkedTwo = await emit(ctlDoors, 'admin:linkRoom', { socketId: researchSid, targetRoom: hallTwo });
    const forwardable = await research.until('F.forwardable', 5000);
    // Send to ▸, as the page draws it: never on a help request, which belongs to its hall; on words and on a file.
    const menuOf = async (id) => {
      await research.eval(`messagesById.get(${codeLiteral(id)}).querySelector('.obj-more').click()`);
      const got = await research.until(MENU_IDS, 3000);
      await research.eval('AGM.menu.close()');
      return JSON.parse(got || '[]');
    };
    const sendOffered = JSON.stringify({ help: (await menuOf(doorMsgs.adminHelp)).includes('msg.send'), text: (await menuOf(doorMsgs.ownText)).includes('msg.send'), file: (await menuOf(capexId)).includes('msg.send') });
    report(!!linkedTwo.ok && !!forwardable && sendOffered === JSON.stringify({ help: false, text: true, file: true }),
      `once the admin lets the page forward elsewhere it offers ↗ Send to on words and a file, never on a help request (${JSON.stringify({ linked: linkedTwo.ok, forwardable: !!forwardable })}; ${sendOffered})`);

    // F on a focused message: Send to ▸ opens saying "Looking…" until the server answers, then the halls (the browser's
    // identity sits in others too), the first focused; ↓ to the second hall and Enter send it there.
    await research.eval(`(() => { const emit0 = socket.emit; window.__emit0 = emit0; window.__emits = [];
      socket.emit = function (ev, args, cb) { window.__emits.push([ev, args && args.targetRoom, typeof cb]);
        if (ev === 'forward' && typeof cb === 'function') return emit0.call(this, ev, args, (r) => { window.__emits.push(['answer', JSON.stringify(r)]); cb(r); });
        if (ev === 'myRooms' && args && args.messageId) return emit0.call(this, ev, args, (r) => setTimeout(() => cb(r), 600)); return emit0.apply(this, arguments); }; })()`);
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).focus()`);
    await press(research, 'f');
    const looking = await research.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi'); return !!r && r.textContent.includes('Looking…') && 'Looking…'; })()`, 3000);
    const roomRow = await research.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi[data-value]'); return r && document.activeElement === r && r.dataset.value; })()`, 5000);
    const rooms = JSON.parse(await research.eval(`JSON.stringify([...document.querySelectorAll('.agm-sub .agm-mi[data-value]')].map((r) => r.dataset.value))`) || '[]');
    for (let i = 0; i < rooms.indexOf(hallTwo); i++) await press(research, 'ArrowDown');
    const chosenRoom = await research.eval(`document.activeElement.dataset.value`);
    await pressEnter(research);
    let inTwo = null;
    let seenTwo = [];
    for (let i = 0; i < 40 && !inTwo; i++) {
      const w = await emit(ctlDoors, 'admin:watchRoom', { roomCode: hallTwo });
      seenTwo = w && w.ok ? w.messages.map((m) => m.type + ':' + (m.text || '')) : [JSON.stringify(w)];
      inTwo = ((w && w.messages) || []).find((m) => m.text === 'Doors: a backstage note') || null;
      if (!inTwo) await sleep(250);
    }
    const forwardSaw = inTwo ? '' : await research.eval(`JSON.stringify({ emits: window.__emits, toast: (document.getElementById('agmToast') || {}).textContent, menu: !!document.querySelector('.agm-menu'), focus: document.activeElement && (document.activeElement.className + '|' + (document.activeElement.dataset.value || '')), F: F.forwardable })`);
    await research.eval('socket.emit = window.__emit0');
    report(looking === 'Looking…' && roomRow === rooms[0] && rooms.includes(hallTwo) && chosenRoom === hallTwo && !!inTwo,
      `F opens Send to ▸, "Looking…" until the server answers, then the halls, the first focused; ↓ and Enter forward the message to the hall chosen (${JSON.stringify({ looking, rooms: rooms.length, chosen: chosenRoom === hallTwo, forwarded: !!inTwo })}${inTwo ? '' : '; ' + forwardSaw + '; ' + JSON.stringify(seenTwo)})`);

    // E on a focused message: React ▸ opens with the focus on its first reaction; a reaction of this person's made
    // elsewhere checks its row in place; Enter reacts.
    const ownNow = `findMessage(${codeLiteral(doorMsgs.ownText)})`;
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).focus()`);
    await press(research, 'e');
    const reactFirst = await research.until(`(() => { const r = document.activeElement; return !!r && !!r.closest('.agm-sub') && r.getAttribute('role') === 'menuitemcheckbox' && r.dataset.value; })()`, 3000);
    await research.eval(`new Promise((r) => socket.emit('react', { messageId: ${codeLiteral(doorMsgs.ownText)}, emoji: '🎉', on: true }, r))`);
    const checkedInPlace = await research.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi[data-value="🎉"]'); return !!r && r.getAttribute('aria-checked') === 'true' && document.activeElement.dataset.value === ${codeLiteral(reactFirst || '')} && 'checked'; })()`, 4000);
    await pressEnter(research);
    const reactedByKey = await research.until(`(${ownNow}.reactions || []).some((r) => r.uid === MY_UID && r.emoji === ${codeLiteral(reactFirst || '👍')}) && ${NO_MENU} && 'reacted'`, 5000);
    report(reactFirst === '👍' && checkedInPlace === 'checked' && reactedByKey === 'reacted', `E opens React ▸ on its first reaction, a reaction made elsewhere checks its row in place, and Enter reacts (${JSON.stringify({ reactFirst, checkedInPlace, reactedByKey })})`);

    // D and Enter on a focused file: its download (held here, so nothing is saved), and its Look in the panel.
    await research.eval(`(() => { window.__dl = ''; document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[download]'); if (a) { window.__dl = a.getAttribute('href'); e.preventDefault(); } }, true); dismissDoc(); })()`);
    await research.eval(`messagesById.get(${codeLiteral(capexId)}).focus()`);
    await press(research, 'd');
    const downloadedByKey = await research.until('window.__dl', 3000);
    await research.eval(`messagesById.get(${codeLiteral(capexId)}).focus()`);
    await pressEnter(research);
    const lookedByKey = await research.until(`currentDocMsgId === ${codeLiteral(capexId)} && 'open'`, 3000);
    report(/^\/uploads\/.*capex\.pdf$/.test(downloadedByKey || '') && lookedByKey === 'open', `D on a focused file downloads it and Enter opens it in the panel (${JSON.stringify({ downloadedByKey, lookedByKey })})`);

    // Answer in words… is a field in place: focused, held to 200 characters, Enter sends the answer.
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.adminAsk)}).querySelector('.answer-words-btn').click()`);
    const wordsField = await research.until(`(() => { const i = document.querySelector('.agm-ask input[name="note"]'); return !!i && document.activeElement === i && i.maxLength; })()`, 3000);
    await research.eval(`document.querySelector('.agm-ask input[name="note"]').value = 'After the break'`);
    await press(research, 'Enter');
    const answeredInWords = await research.until(`(findMessage(${codeLiteral(doorMsgs.adminAsk)}).responses || []).some((r) => r.uid === MY_UID && r.optionIndex === -1 && r.note === 'After the break') && !document.querySelector('.agm-ask') && 'answered'`, 5000);
    report(wordsField === 200 && answeredInWords === 'answered', `Answer in words… is a field in place of 200 characters, and Enter sends the answer (${JSON.stringify({ wordsField, answeredInWords })})`);

    // Delete or Backspace on a focused message of one's own asks in place, the safe answer focused; Escape gives the focus
    // back to the message; Delete again and its yes delete it, the focus going on to the next message, never the page.
    const doomed = await postFrom(research, { type: 'text', text: 'Doors: to be deleted' });
    await research.until(`messagesById.has(${codeLiteral(doomed)})`);
    const askOnKey = async () => {
      await research.eval(`messagesById.get(${codeLiteral(doomed)}).focus()`);
      await press(research, 'Delete');
      return research.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, focused: document.activeElement.dataset.answer || '' }); })()`, 3000);
    };
    const deleteAsk = await askOnKey();
    await press(research, 'Escape');
    const deleteKept = await research.until(`!document.querySelector('.agm-ask') && document.activeElement === messagesById.get(${codeLiteral(doomed)}) && 'kept'`, 3000);
    await askOnKey();
    await research.eval(`document.querySelector('.agm-ask [data-answer="yes"]').click()`);
    const deletedOn = await research.until(`!messagesById.has(${codeLiteral(doomed)}) && document.activeElement !== document.body && document.activeElement.matches('.msg[data-id]') && 'next'`, 5000);
    report(deleteAsk === JSON.stringify({ title: 'Delete your message?', focused: 'no' }) && deleteKept === 'kept' && deletedOn === 'next',
      `Delete on a focused message asks in place with "no" focused, Escape gives the focus back to the message, and yes deletes it with the focus on the next one (${JSON.stringify({ deleteAsk, deleteKept, deletedOn })})`);

    // An ask opened from a ⋯ menu is answered "no" by a press on that ⋯ again, as by any press outside it: the ask goes,
    // the message stays, and only the ⋯'s own menu is open (never an ask left open beneath it).
    const keptDots = `messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more')`;
    await leftClick(research, await middleOf(research, keptDots));
    await research.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="msg.delete"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu .agm-mi[data-action="msg.delete"]').click()`);
    const dotsAsk = await research.until(`(() => { const a = document.querySelector('.agm-ask'); return a && !document.querySelector('.agm-menu') && a.querySelector('.agm-ask-title').textContent; })()`, 3000);
    await leftClick(research, await middleOf(research, keptDots));
    const dotsAgain = await research.until(`!document.querySelector('.agm-ask') && !!document.querySelector('.agm-menu:not(.agm-sub)') && messagesById.has(${codeLiteral(doorMsgs.ownText)}) && 'no'`, 3000);
    await press(research, 'Escape');
    await research.until(NO_MENU, 3000);
    report(dotsAsk === 'Delete your message?' && dotsAgain === 'no', `The ⋯ pressed again under the Delete… it opened answers the ask "no": the ask goes, the message stays, and only the ⋯'s menu opens (${JSON.stringify({ dotsAsk, dotsAgain })})`);

    // Copy text over plain http (no clipboard API there): the browser's own copy, else a field to copy from; either way
    // the focus comes back where it was, never to the page.
    await research.eval(`(() => { window.__secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext'); Object.defineProperty(window, 'isSecureContext', { get: () => false, configurable: true }); const t = document.getElementById('agmToast'); if (t) t.textContent = ''; })()`);
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more').click()`);
    await research.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="msg.copy"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu .agm-mi[data-action="msg.copy"]').click()`);
    const dots = `messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more')`;
    const copied = await research.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; const a = document.querySelector('.agm-ask');
      if (t === 'Copied.') return document.activeElement === ${dots} && 'copied';
      return a && a.querySelector('.agm-ask-title').textContent === 'Copy it from here' && a.contains(document.activeElement) && 'field'; })()`, 3000);
    if (copied === 'field') await press(research, 'Escape');
    const copyFocus = await research.until(`!document.querySelector('.agm-ask') && document.activeElement === ${dots} && 'back'`, 3000);
    await research.eval(`(() => { if (window.__secure) Object.defineProperty(window, 'isSecureContext', window.__secure); else delete window.isSecureContext; })()`);
    report(!!copied && copyFocus === 'back', `Copy text where the page has no clipboard API copies with the browser's own copy or offers a field, and the focus comes back to the ⋯ (${JSON.stringify({ copied, copyFocus })})`);

    // The link taken back: the page is told and asks again, and its Send to ▸ lists that hall no more (the person's own
    // other halls, where the browser's identity sits, stay).
    const unlinked = await emit(ctlDoors, 'admin:unlinkRoom', { socketId: researchSid, targetRoom: hallTwo });
    const notOffered = await research.until(`new Promise((r) => socket.emit('myRooms', {}, (x) => r(!x.rooms.some((c) => c.code === ${codeLiteral(hallTwo)}) && F.forwardable === x.rooms.length > 0 && JSON.stringify(x.rooms.map((c) => c.name)))))`, 5000);
    report(!!unlinked.ok && !!notOffered, `the admin's link taken back, the page's Send to ▸ lists that hall no more, and its forwardable fact follows (${JSON.stringify({ unlinked: unlinked.ok, notOffered })})`);

    // A file: an entry of the panel's pinned list and the file open in the panel, each with its doors (once the toast
    // the steps above left has gone from over the panel).
    await research.until(`!document.querySelector('.agm-toast.show')`, 15000);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(capexId)}, pinned: true }, r))`);
    const fileEntry = `[...document.querySelectorAll('#docPinnedList .file-entry')].find((li) => li.dataset.fileId === ${codeLiteral(capexId)})`;
    await research.until(`!!${fileEntry}`);
    const fileDoors = { list: await doorsOf(research, 'file', fileEntry, `fileObject(${codeLiteral(capexId)}, 'list')`) };
    await research.eval(`openDocInPanel(findMessage(${codeLiteral(capexId)}))`);
    await research.until(`!document.getElementById('docActions').hidden && !!document.querySelector('#docActs .obj-more')`);
    fileDoors.preview = await doorsOf(research, 'file', `document.getElementById('docActions')`, `fileObject(${codeLiteral(capexId)}, 'preview')`);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(capexId)}, pinned: false }, r))`);
    report(doorsInStep(fileDoors.list) && doorsInStep(fileDoors.preview), `a file's doors, in the panel's pinned list and open in the panel, are in step (${JSON.stringify(doorsInStep(fileDoors.list) && doorsInStep(fileDoors.preview) ? { list: fileDoors.list.want, preview: fileDoors.preview.want } : fileDoors)})`);

    // A screen, inside the Screens dialog: its menu and its asks open in the dialog, Escape closes them and the dialog stays;
    // Rename… is a field in place and Remove… asks in place, never a native dialog.
    const doorScreen = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Doors spare' }, (x) => r(x.display.id)))`);
    await hallView.eval(`document.getElementById('screensBtn').click()`);
    const screenRow = `[...document.querySelectorAll('#screenList .screen-item')].find((li) => li.dataset.screenId === ${codeLiteral(doorScreen)})`;
    await hallView.until(`document.getElementById('screensDialog').open && !!${screenRow}`);
    const screenDoors = await doorsOf(hallView, 'screen', screenRow, `Screens.of(${codeLiteral(doorScreen)})`);
    await hallView.eval(`${screenRow}.querySelector('.obj-more').click()`);
    const inDialog = await hallView.until(`(() => { const m = document.querySelector('.agm-menu'); return m && m.closest('dialog') === document.getElementById('screensDialog'); })()`);
    await press(hallView, 'Escape');
    const menuGoneDialogStays = await hallView.until(`${NO_MENU} && document.getElementById('screensDialog').open`);
    const openRename = async () => {
      await hallView.eval(`${screenRow}.querySelector('.obj-more').click()`);
      await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="screen.rename"]')`);
      await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="screen.rename"]').click()`);
      return hallView.until(`(() => { const a = document.querySelector('.agm-ask'); return a && a.closest('dialog') === document.getElementById('screensDialog') && document.activeElement === a.querySelector('input') && a.querySelector('input').value; })()`);
    };
    const renameField = await openRename();
    await press(hallView, 'Escape');
    const askGoneDialogStays = await hallView.until(`!document.querySelector('.agm-ask') && document.getElementById('screensDialog').open`);
    await openRename();
    await hallView.eval(`document.querySelector('.agm-ask input').value = 'Doors renamed'`);
    await press(hallView, 'Enter');
    const renamed = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.some((d) => d.id === ${codeLiteral(doorScreen)} && d.name === 'Doors renamed'))))`, 5000);
    await hallView.until(`(${screenRow}).querySelector('strong').textContent === 'Doors renamed'`);
    // New link… asks in place; its yes gives the screen a new link, which is copied (or offered in a field to copy).
    const pathBefore = await hallView.eval(`Screens.of(${codeLiteral(doorScreen)}).path`);
    await hallView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; })()`);
    await hallView.eval(`${screenRow}.querySelector('.obj-more').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="screen.rotate"]')`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="screen.rotate"]').click()`);
    const rotateAsk = await hallView.until(`(() => { const a = document.querySelector('.agm-ask'); return a && a.closest('dialog') === document.getElementById('screensDialog') && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, focused: document.activeElement.dataset.answer, yes: a.querySelector('[data-answer="yes"]').textContent }); })()`);
    await hallView.eval(`document.querySelector('.agm-ask [data-answer="yes"]').click()`);
    const rotated = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.some((d) => d.id === ${codeLiteral(doorScreen)} && !!d.path && d.path !== ${codeLiteral(pathBefore)}))))`, 5000);
    const rotateSaid = await hallView.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; const a = document.querySelector('.agm-ask');
      return /^New link copied/.test(t) ? 'copied' : a && a.querySelector('.agm-ask-title').textContent === 'Copy it from here' && a.querySelector('input').value.endsWith(Screens.of(${codeLiteral(doorScreen)}).path) && 'field'; })()`, 5000);
    if (rotateSaid === 'field') await press(hallView, 'Escape');
    report(rotateAsk === JSON.stringify({ title: 'Give Doors renamed a new link?', focused: 'no', yes: 'New link' }) && !!rotated && !!rotateSaid && !!(await hallView.until(`!document.querySelector('.agm-ask') && document.getElementById('screensDialog').open`, 3000)),
      `New link… asks in place in the Screens dialog with the safe answer focused, and its yes gives the screen a new link to copy (${JSON.stringify({ rotateAsk, rotated: !!rotated, rotateSaid })})`);
    // An ask about a screen removed elsewhere meanwhile closes, and says so.
    const goneScreen = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Doors gone' }, (x) => r(x.display.id)))`);
    const goneRow = `[...document.querySelectorAll('#screenList .screen-item')].find((li) => li.dataset.screenId === ${codeLiteral(goneScreen)})`;
    await hallView.until(`!!${goneRow}`);
    await hallView.eval(`${goneRow}.querySelector('.obj-more').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="screen.rename"]')`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="screen.rename"]').click()`);
    await hallView.until(`!!document.querySelector('.agm-ask input')`);
    await hallView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; })()`);
    const goneElsewhere = await emit(ctlDoors, 'display:remove', { id: goneScreen });
    const askWent = await hallView.until(`!document.querySelector('.agm-ask') && (document.getElementById('agmToast') || {}).textContent === 'That screen is gone.' && document.getElementById('screensDialog').open && 'gone'`, 5000);
    ctlDoors.close();
    report(!!goneElsewhere.ok && askWent === 'gone', `an ask about a screen removed elsewhere closes, saying "That screen is gone.", and the dialog stays (${JSON.stringify({ removed: goneElsewhere.ok, askWent })})`);
    await hallView.eval(`${screenRow}.querySelector('.obj-more').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-action="screen.remove"]')`);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-action="screen.remove"]').click()`);
    const removeAsk = await hallView.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, focused: document.activeElement.dataset.answer, yes: a.querySelector('[data-answer="yes"]').textContent }); })()`);
    await hallView.eval(`document.querySelector('.agm-ask [data-answer="yes"]').click()`);
    const removedScreen = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(!x.displays.some((d) => d.id === ${codeLiteral(doorScreen)}))))`, 5000);
    const dialogStillOpen = await hallView.eval(`document.getElementById('screensDialog').open`);
    await hallView.eval(`document.getElementById('screensClose').click()`);
    report(doorsInStep(screenDoors) && !!inDialog && !!menuGoneDialogStays && renameField === 'Doors spare' && !!askGoneDialogStays && !!renamed && removeAsk === JSON.stringify({ title: 'Remove Doors renamed?', focused: 'no', yes: 'Remove' }) && !!removedScreen && dialogStillOpen,
      `a screen's doors are in step inside the Screens dialog; its menu and asks open in the dialog and Escape closes them, not it; Rename… is a field, Remove… asks in place with the safe answer focused (${JSON.stringify({ want: screenDoors.want, renameField, removeAsk })})`);

    // The admin's support view draws the person's menus, every item disabled with whose view it is, and sends nothing.
    const supportView = await edge.tab(`${base}/app.html?code=${code}&name=Chair&role=board&adminView=1`);
    await supportView.until(`typeof joined !== 'undefined' && joined && messagesById.has(${codeLiteral(doorMsgs.adminText)})`);
    await supportView.eval(`(() => { window.__sent = []; const emit = socket.emit; socket.emit = function (ev, ...a) { window.__sent.push(ev); return emit.call(this, ev, ...a); }; })()`);
    await supportView.eval(`messagesById.get(${codeLiteral(doorMsgs.adminText)}).querySelector('.obj-more').click()`);
    const supportMenu = await supportView.until(`(() => { const rows = [...document.querySelectorAll('.agm-menu .agm-mi')]; return rows.length && JSON.stringify({ n: rows.length, disabled: rows.every((r) => r.getAttribute('aria-disabled') === 'true'), why: [...new Set(rows.map((r) => r.querySelector('.mi-why').textContent))] }); })()`);
    await supportView.eval(`document.querySelector('.agm-menu .agm-mi').click()`);
    const supportSaid = await supportView.until(`(document.getElementById('agmToast') || {}).textContent`);
    const supportInline = await supportView.eval(`[...messagesById.get(${codeLiteral(doorMsgs.adminText)}).querySelectorAll('.msg-act')].every((b) => b.getAttribute('aria-disabled') === 'true')`);
    // Its Help: the person's dialog, drawn; a category says whose view it is and sends nothing.
    await supportView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; openHelpDialog(''); })()`);
    await supportView.until(`document.getElementById('helpDialog').open`, 3000);
    await supportView.eval(`document.querySelector('#helpCats .help-cat').click()`);
    const supportHelp = await supportView.until(`!document.getElementById('helpDialog').open && (document.getElementById('agmToast') || {}).textContent`, 3000);
    const banner = await supportView.eval(`document.querySelector('.admin-view-banner').textContent`);
    const supportSent = await supportView.eval(`JSON.stringify(window.__sent.filter((ev) => !['seen', 'userState:requestPeers', 'userState:push', 'stage:targets', 'myRooms'].includes(ev)))`);
    const supportProblems = supportView.problems.slice();
    supportView.close();
    report(!!supportMenu && JSON.parse(supportMenu).disabled && JSON.stringify(JSON.parse(supportMenu).why) === JSON.stringify(['This is Chair\'s view — act from your own page.']) && supportSaid === 'This is Chair\'s view — act from your own page.' && supportInline &&
      supportHelp === 'This is Chair\'s view — act from your own page.' && banner === 'Admin support view — what Chair sees. Nothing here acts: act from your own page.' && supportSent === '[]' && supportProblems.length === 0,
      `the support view draws the person's menu with every item disabled, saying whose view it is, and its Help's categories say so too; it sends nothing, and its banner says nothing acts (${supportMenu}; "${supportSaid}"; "${supportHelp}"; "${banner}"; sent ${supportSent}${supportProblems.length ? '; ' + supportProblems.join(' | ') : ''})`);

    // ---------------- The rest of the hall page (unit 3c): the composer, a person, the chips, the lists, the skip link ----------------
    // Kim is someone else (a socket of her own: the smoke's pages share this browser's one identity), backstage, with a
    // message of her own.
    const kim = await connect(base);
    await emit(kim, 'join', { roomCode: code, name: 'Kim', role: 'research' });
    const kimSaid = await emit(kim, 'message', { type: 'text', text: 'Doors: from Kim' });
    await research.until(`messagesById.has(${codeLiteral(kimSaid.id)}) && people.some((u) => u.name === 'Kim')`);
    // The one toast: a role=status region, and only one on the page, though a pin's Undo, a forward's "Forwarded to …"
    // and a refusal's words were all said on it above (the forward's had a toast of its own, with no role).
    const toasts = await research.eval(`JSON.stringify([...document.querySelectorAll('.agm-toast')].map((t) => [t.id, t.getAttribute('role')]))`);
    report(toasts === JSON.stringify([['agmToast', 'status']]), `the hall page has one toast, a role=status region a screen reader hears, for every act's words (${toasts})`);

    // A sender's name is the door to that person's menu (@ Mention), by a click, a right-click and Shift+F10; Mention puts
    // "@Kim " in the message box and the focus there. One's own name is words.
    const kimName = `messagesById.get(${codeLiteral(kimSaid.id)}).querySelector('.from')`;
    await research.eval(`(() => { selectTab('text'); textInput.value = ''; })()`);
    const nameDoors = await selfDoors(research, 'person', kimName, `senderOf(${kimName})`);
    await research.eval(`${kimName}.click()`);
    await research.until(`!!document.querySelector('.agm-menu [data-action="person.mention"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="person.mention"]').click()`);
    const mentioned = await research.until(`textInput.value === '@Kim ' && document.activeElement === textInput && 'mentioned'`, 3000);
    const ownName = await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.from').tagName`);
    await research.eval(`textInput.value = ''`);
    report(selfInStep(nameDoors) && nameDoors.want === '["person.mention"]' && mentioned === 'mentioned' && ownName === 'SPAN',
      `a sender's name opens that person's menu by a click, a right-click and Shift+F10 alike, Mention puts "@Kim " in the message box, and one's own name is words (${JSON.stringify({ want: nameDoors.want, mentioned, ownName })}${selfInStep(nameDoors) ? '' : '; ' + JSON.stringify(nameDoors)})`);

    // The People panel: a row each, its ⋯, right-click and Shift+F10 in step; one Tab stop for the list.
    await research.eval(`document.getElementById('peoplePanel').hidden = false`);
    const kimRow = `[...document.querySelectorAll('#peopleList li[data-key]')].find((li) => li.querySelector('.name').textContent === 'Kim')`;
    await research.until(`!!${kimRow} && !!${kimRow}.querySelector('.obj-more')`, 3000);
    const rowDoors = await doorsOf(research, 'person', kimRow, `personNow(${kimRow}.dataset.key)`, { hit: '.name', bar: '.person-acts > .msg-act' });
    const peopleStops = await research.eval(`document.querySelectorAll('#peopleList li[tabindex="0"]').length`);
    await research.eval(`document.getElementById('peoplePanel').hidden = true`);
    report(doorsInStep(rowDoors) && rowDoors.want === '["person.mention"]' && peopleStops === 1, `a person's row in the People panel: its ⋯, right-click and Shift+F10 open the catalogue's set, and the list is one Tab stop (${JSON.stringify({ want: rowDoors.want, peopleStops })}${doorsInStep(rowDoors) ? '' : '; ' + JSON.stringify(rowDoors)})`);

    // The composer: Send is its act on the row, named for where it sends; its ⋯, a right-click and Shift+F10 on Send open
    // the same list (✨ Draft a reply, Send, 🔥 Priority, Attach a file…); 🔥 is a checked toggle there; the text field
    // keeps the browser's own menu.
    const composeDoors = await doorsOf(research, 'compose', 'textPane', `composeObject('text')`, { hit: '.send-btn', bar: '.send-btn', focus: `textPane.querySelector('.send-btn')` });
    await research.eval(`textPriBtn.click()`);
    await research.eval(`textPane.querySelector('.compose-more').click()`);
    const priorityItem = await research.until(`(() => { const r = document.querySelector('.agm-menu [data-action="compose.priority"]'); return r && JSON.stringify([r.getAttribute('role'), r.getAttribute('aria-checked')]); })()`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="compose.priority"]').click()`);
    const priorityOff = await research.until(`textPriBtn.getAttribute('aria-pressed') === 'false' && ${NO_MENU} && 'off'`, 3000);
    const fieldMenu = await research.eval(`(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 2 }); textInput.dispatchEvent(e); return JSON.stringify({ prevented: e.defaultPrevented, menu: !!document.querySelector('.agm-menu') }); })()`);
    const sendName = await research.eval(`textPane.querySelector('.send-btn').getAttribute('aria-label')`);
    report(doorsInStep(composeDoors) && JSON.parse(composeDoors.want).join() === 'compose.draft,compose.send,compose.priority,compose.attach' && sendName === 'Send to Smoke AGM' &&
      priorityItem === JSON.stringify(['menuitemcheckbox', 'true']) && priorityOff === 'off' && fieldMenu === JSON.stringify({ prevented: false, menu: false }),
      `the composer: Send ("${sendName}") and its ⋯, right-click and Shift+F10 on it open one list; 🔥 Priority is a checked toggle in it, which unpresses 🔥; the text field keeps the browser's own menu (${JSON.stringify({ want: composeDoors.want, priorityItem, fieldMenu })}${doorsInStep(composeDoors) ? '' : '; ' + JSON.stringify(composeDoors)})`);

    // The roving feed: one Tab stop, the newest message; ↑ in the empty message box goes to it, ↑ again to the one before,
    // whose Shift+F10 opens its catalogue's set; Escape closes the menu with the focus back on the message, and Escape
    // again goes back to the message box.
    const feedStops = await research.eval(`JSON.stringify([...feed.querySelectorAll('.msg[tabindex="0"]')].map((n) => n.dataset.id))`);
    const newest = await research.eval(`(() => { const all = [...feed.querySelectorAll('.msg[data-key]')].filter((n) => !n.matches('[data-type="action"][data-pinned="1"]')); return JSON.stringify([all[all.length - 1].dataset.id, all[all.length - 2].dataset.id]); })()`);
    await research.eval(`textInput.focus()`);
    await press(research, 'ArrowUp');
    const upOnce = await research.until(`document.activeElement.matches('.msg[data-key]') && document.activeElement.dataset.id`, 3000);
    await press(research, 'ArrowUp');
    const upTwice = await research.until(`document.activeElement.matches('.msg[data-key]') && document.activeElement.dataset.id !== ${codeLiteral(JSON.parse(newest)[0])} && document.activeElement.dataset.id`, 3000);
    await press(research, 'F10', { shift: true });
    const rovingMenu = await research.until(MENU_IDS, 3000);
    const rovingWant = await research.eval(`JSON.stringify(AGM.catalog.ids('msg', F, findMessage(${codeLiteral(upTwice || '')})))`);
    await press(research, 'Escape');
    const rovingBack = await research.until(`${NO_MENU} && document.activeElement.dataset.id === ${codeLiteral(upTwice || '')} && document.querySelectorAll('#feed .msg[tabindex="0"]').length === 1 && 'back'`, 3000);
    await press(research, 'Escape');
    const toComposer = await research.until(`document.activeElement === textInput && 'composer'`, 3000);
    report(JSON.parse(feedStops).length === 1 && JSON.parse(feedStops)[0] === JSON.parse(newest)[0] && upOnce === JSON.parse(newest)[0] && upTwice === JSON.parse(newest)[1] && rovingMenu === rovingWant && rovingBack === 'back' && toComposer === 'composer',
      `the feed is one Tab stop, its newest message; ↑ from the empty message box goes to it and ↑ again to the one before, whose Shift+F10 opens its set; Escape closes the menu, then goes back to the message box (${JSON.stringify({ feedStops, upOnce, upTwice, rovingMenu, rovingBack, toComposer })})`);

    // The header's chips, each its own door: the stage chip (the account's: the speaker's screen and the countdown on its
    // screens) and the code chip (copy the guest code or the join link).
    await hallView.until(`!document.getElementById('stageChip').hidden && document.getElementById('stageChip').getAttribute('role') === 'button'`, 8000);
    const stageDoors = await selfDoors(hallView, 'chip', `document.getElementById('stageChip')`, 'stageNow');
    await hallView.eval(`document.getElementById('stageChip').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu [data-action="chip.speaker"]')`, 3000);
    await hallView.eval(`document.querySelector('.agm-menu [data-action="chip.speaker"]').click()`);
    const lineBox = await hallView.until(`document.getElementById('swDialog').open && JSON.stringify({ text: document.getElementById('swText').value, dest: document.getElementById('swDest').options.length > 0 })`, 5000);
    await hallView.eval(`document.getElementById('swDialog').close()`);
    // Every screen ticked in Screens (the steps above left one ticked that is gone), then the countdown from the chip.
    await hallView.eval(`(() => { document.getElementById('screensBtn').click(); const all = document.getElementById('screensAll'); if (!all.checked) all.click(); document.getElementById('screensClose').click(); })()`);
    await hallView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('stageChip').click(); })()`);
    await hallView.until(`!!document.querySelector('.agm-menu [data-action="chip.screens"]')`, 3000);
    await hallView.eval(`document.querySelector('.agm-menu [data-action="chip.screens"]').click()`);
    const countdownSaid = await hallView.until(`(document.getElementById('agmToast') || {}).textContent`, 5000);
    const countdownOn = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.length > 0 && x.displays.every((d) => d.content && d.content.kind === 'countdown') && x.displays.length)))`, 5000);
    report(selfInStep(stageDoors) && stageDoors.want === '["chip.speaker","chip.screens"]' && lineBox === JSON.stringify({ text: '', dest: true }) && /^Sent to \d+ screens? — each shows ✓/.test(countdownSaid || '') && !!countdownOn,
      `the stage chip opens its menu by a click, a right-click and Shift+F10 alike; Speaker's screen… opens the line box empty, and Show the countdown on screens puts it on the hall's ${countdownOn} screens (${JSON.stringify({ want: stageDoors.want, lineBox, countdownSaid })}${selfInStep(stageDoors) ? '' : '; ' + JSON.stringify(stageDoors)})`);
    const codeDoors = await selfDoors(research, 'code', `document.getElementById('roomChip')`, 'codeObject()');
    await research.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('roomChip').click(); })()`);
    await research.until(`!!document.querySelector('.agm-menu [data-action="code.copy"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="code.copy"]').click()`);
    const joinLink = await research.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; const a = document.querySelector('.agm-ask');
      if (/^Copied the join link/.test(t)) return 'copied'; return a && a.querySelector('input').value === location.origin + '/?code=' + ROOM && 'field'; })()`, 3000);
    if (joinLink === 'field') await press(research, 'Escape');
    report(selfInStep(codeDoors) && codeDoors.want === '["code.code","code.copy"]' && !!joinLink, `the code chip opens its menu by a click, a right-click and Shift+F10 alike, and Copy join link copies the join page's link with the code (${JSON.stringify({ want: codeDoors.want, joinLink })}${selfInStep(codeDoors) ? '' : '; ' + JSON.stringify(codeDoors)})`);

    // The skip link: the first Tab of a fresh page; Enter takes the focus to the message box, or, for an observer (who
    // has none), to the newest message. An observer reads a question's options as words, with no button.
    const skipTo = async (tab) => {
      await press(tab, 'Tab');
      const first = await tab.until(`document.activeElement && document.activeElement.id === 'skipLink' && JSON.stringify({ words: document.activeElement.textContent, shown: document.activeElement.getBoundingClientRect().top >= 0 })`, 3000);
      await pressEnter(tab);
      const to = await tab.until(`document.activeElement && document.activeElement !== document.getElementById('skipLink') && (document.activeElement.id || document.activeElement.className)`, 3000);
      return { first, to };
    };
    const fresh = await edge.tab(`${base}/app.html?code=${code}&name=Ana&role=research`);
    await fresh.until(`typeof joined !== 'undefined' && joined && messagesById.size > 0`);
    const freshSkip = await skipTo(fresh);
    fresh.close();
    const obi = await edge.tab(`${base}/app.html?code=${code}&name=Obi&role=observer`);
    await obi.until(`typeof joined !== 'undefined' && joined && messagesById.has(${codeLiteral(doorMsgs.adminAsk)})`);
    const obiSkip = await skipTo(obi);
    const obiNewest = await obi.eval(`(() => { const all = [...feed.querySelectorAll('.msg[data-key]')]; return document.activeElement === all[all.length - 1]; })()`);
    const obiAsk = await obi.eval(`(() => { const n = messagesById.get(${codeLiteral(doorMsgs.adminAsk)}); return JSON.stringify({ words: (n.querySelector('.action-options') || {}).textContent || '', buttons: n.querySelectorAll('.action-buttons button, .action-btn').length, tally: !!n.querySelector('.action-responses') }); })()`);
    const obiProblems = obi.problems.slice();
    obi.close();
    report(freshSkip.first === JSON.stringify({ words: 'Skip to message box', shown: true }) && freshSkip.to === 'textInput' && obiSkip.first === JSON.stringify({ words: 'Skip to messages', shown: true }) && /\bmsg\b/.test(obiSkip.to || '') && obiNewest &&
      obiAsk === JSON.stringify({ words: 'Options: Yes · No', buttons: 0, tally: true }) && obiProblems.length === 0,
      `the first Tab is the skip link: "Skip to message box" takes the focus to it; an observer's "Skip to messages" to the newest message; an observer reads a question's options as words with its tally, no button (${JSON.stringify({ freshSkip, obiSkip, obiAsk })}${obiProblems.length ? '; ' + obiProblems.join(' | ') : ''})`);
    kim.close();

    // Both themes: a menu's words read at 4.5:1 or more, its reason too, on its own surface.
    await research.eval(INK);
    const menuInk = {};
    for (const theme of ['light', 'dark']) {
      await research.eval(`applyTheme(${codeLiteral(theme)})`);
      await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more').click()`);
      await research.until(`!!document.querySelector('.agm-menu .agm-mi')`);
      menuInk[theme] = await research.eval(`(() => { const m = document.querySelector('.agm-menu'); const l = m.querySelector('.agm-mi .mi-label'); const k = m.querySelector('.agm-mi .mi-key');
        return { label: +__ink(l).ratio.toFixed(2), key: k ? +__ink(k).ratio.toFixed(2) : 0, bg: getComputedStyle(m).backgroundColor }; })()`);
      await research.shot(path.join(OUT, `menu-${theme}.png`));
      await research.eval(`AGM.menu.close()`);
    }
    await research.eval(`applyTheme('light')`);
    report(menuInk.light.label >= 4.5 && menuInk.dark.label >= 4.5 && menuInk.light.key >= 4.5 && menuInk.dark.key >= 4.5 && menuInk.light.bg !== menuInk.dark.bg,
      `a menu reads in both themes: its words and keys at 4.5:1 or more on its own surface (${JSON.stringify(menuInk)})`);

    // What moved is said once, on the first open, until the person says Got it.
    const movedSaid = await research.eval(`(() => { const l = document.getElementById('movedLine'); return !l.hidden && l.querySelector('span').textContent; })()`);
    await research.eval(`localStorage.removeItem('agm.moved'); document.getElementById('movedOk').click()`);
    const movedKept = await research.eval(`document.getElementById('movedLine').hidden && localStorage.getItem('agm.moved')`);
    report(movedSaid === 'Delete, Ask the operator and Show on screens are now in ⋯ — or right-click, or Shift+F10.' && movedKept === '0.6.0', `the What moved line says where the acts went, and goes for good with Got it ("${movedSaid}"; ${movedKept})`);

    // The doors' messages go again (by their authors), so the hall reads as it did for what follows.
    for (const name of ['adminText', 'adminAsk', 'adminHelp']) await hallView.eval(`new Promise((r) => socket.emit('delete', { messageId: ${codeLiteral(doorMsgs[name])} }, r))`);
    for (const name of ['chairText', 'ownText']) await research.eval(`new Promise((r) => socket.emit('delete', { messageId: ${codeLiteral(doorMsgs[name])} }, r))`);
    await research.until(`!${codeLiteral(Object.values(doorMsgs))}.some((id) => messagesById.has(id))`);


    // Rights inside a hall: the admin's room list offers no role select for an account; a Viewer's halls board opens a
    // help request's hall read only, and an old link that says research opens again as the server seats it — with no
    // composer, pin, reaction or answer offered. A help request offers no forward.
    await admin.eval(`watchRoom('${code}')`);
    report(!!(await admin.until(`Array.from(document.querySelectorAll('#usersTbody tr')).some((tr) => tr.textContent.includes('Ana Admin') && !tr.querySelector('.role-select') && tr.querySelector('.role-fixed')) && !!document.querySelector('#usersTbody .role-select')`)), 'the admin\'s room list: an account\'s role is its rights (no select), a code guest\'s has one');
    // The admin page in the copy deck's words, watching a hall; then every page read says no old word in its chrome.
    const adminDeck = JSON.parse(await admin.eval(`JSON.stringify({
      tagline: document.querySelector('#loginPanel .tagline').textContent, newHall: document.getElementById('newSessionBtn').textContent,
      halls: document.querySelector('.admin-sidebar h3').textContent, none: document.getElementById('noRooms').textContent,
      code: document.querySelector('#roomHeader span.muted').textContent, clear: AGM.catalog.entry('adminRoom', 'adminRoom.clear').label,
      close: AGM.catalog.entry('adminRoom', 'adminRoom.remove').label, closing: AGM.catalog.entry('adminRoom', 'adminRoom.remove').confirm(ADMIN_F, roomObject('${code}')).title.slice(0, 11),
      people: document.querySelector('#usersSection h3').textContent, forward: document.querySelectorAll('.admin-users th')[2].textContent,
      local: document.querySelector('#tunnelOffState p').textContent.trim().split('\\n')[0], empty: [...document.querySelectorAll('#adminEmpty p')].map((p) => p.textContent) })`));
    report(JSON.stringify(adminDeck) === JSON.stringify({
      tagline: 'Halls, rooms and people, for the admin.', newHall: 'New hall', halls: 'Halls', none: 'No halls yet. Choose New hall to make one.', code: 'Code',
      clear: 'Clear messages…', close: 'Close hall…', closing: 'Close hall ', people: 'People in this room', forward: 'May forward to',
      local: 'AGMessage is reachable only on the venue\'s network now.',
      empty: ['Choose a hall on the left, or New hall.', 'Each room has a 6-character guest code: share it with the people who join without an account.'],
    }), `the admin page says hall, room and code: New hall, Halls, Code, Clear messages…, Close hall…, People in this room, May forward to (${JSON.stringify(adminDeck)})`);
    // A seat has one name on the admin page too: the people's seats, an account's, the live feed's tags and the lock.
    const adminSeats = await admin.until(`(() => {
      const tags = [...new Set([...document.querySelectorAll('#adminFeed .role-tag')].map((t) => t.textContent))].sort();
      const select = document.querySelector('#usersTbody .role-select');
      return tags.length > 0 && select && JSON.stringify({ choices: [...select.options].map((o) => o.value + '=' + o.textContent), account: document.querySelector('#usersTbody .role-fixed').textContent,
        tags: tags.every((t) => ['On stage', 'Backstage', 'Observer'].includes(t)) ? 'seats' : tags,
        lock: document.querySelector('#invitesPanel label').textContent.trim(), lockTitle: AGM.catalog.entry('adminRoom', 'adminRoom.invites').label });
    })()`);
    report(adminSeats === JSON.stringify({ choices: ['board=On stage', 'research=Backstage', 'observer=Observer'], account: 'Backstage', tags: 'seats',
      lock: 'On stage and Backstage seats need an invite link (anyone else joins as an observer)', lockTitle: 'Roles & invites' }),
      `the admin page names each seat as every page does: On stage, Backstage, Observer (${adminSeats})`);
    // The show desk's line, drawn as the admin page draws it when Stagewatch keeps a desk: its next reading of the settings
    // is answered as though one did.
    const deskSays = await admin.eval(`new Promise((done) => {
      const real = socket.emit;
      socket.emit = function (ev, patch, ack) {
        if (ev !== 'admin:settings' || typeof ack !== 'function') return real.apply(this, arguments);
        socket.emit = real;
        return real.call(this, ev, patch, (s) => { if (s && s.tls) Object.assign(s.tls, { desk: true, deskRefusal: '' }); ack(s); done(document.getElementById('deskLine').textContent); });
      };
    })`);
    report(deskSays === 'Show desk: Stagewatch keeps the shared approval queue — the backstage team can propose stage messages (📝), and approved "notice" proposals for this AGMessage are shown in every room.',
      `the show desk's line says the backstage team and every room (${deskSays})`);
    // The word check on a row and a feed the admin page's script builds: a button in a person's row is read, the person's
    // name, the feed's line of what happened and a message's words and sender are not.
    const adminPlanted = await admin.eval(`(() => {
      const tr = document.createElement('tr'); const name = document.createElement('td'); const who = document.createElement('strong'); who.textContent = 'Session Sid'; name.append(who);
      const acts = document.createElement('td'); const end = document.createElement('button'); end.className = 'btn ghost small'; end.textContent = 'End session'; acts.append(end);
      tr.append(name, document.createElement('td'), document.createElement('td'), acts);
      const line = document.createElement('div'); line.className = 'admin-msg sys'; line.textContent = '— Session reset by admin: messages and documents cleared —';
      const msg = document.createElement('div'); msg.className = 'admin-msg';
      const head = document.createElement('div'); head.className = 'admin-msg-head'; const from = document.createElement('strong'); from.textContent = 'Director Dee'; head.append(from);
      const body = document.createElement('div'); body.className = 'admin-msg-body'; const said = document.createElement('p'); said.textContent = 'the meeting starts at three'; body.append(said);
      msg.append(head, body);
      document.getElementById('usersTbody').append(tr); document.getElementById('adminFeed').append(line, msg);
      try { return JSON.stringify(${CHROME_OLD_WORDS()}); } finally { [tr, line, msg].forEach((n) => n.remove()); }
    })()`);
    report(adminPlanted === JSON.stringify(['End session']), `the word check reads a button in a row the admin page builds, and no name, history or message there (${adminPlanted})`);
    await readOldWords('the admin page, watching a hall', admin);
    await admin.shot(path.join(OUT, 'admin-room.png'));
    // The admin page acts from the catalogue (kinds adminRoom, person, adminMsg, tunnel): a hall in the list, the watched
    // hall's header, a person's row, a message of the live feed and the internet link's card each open the same menu by
    // right-click, ⋯ and Shift+F10, the focus where it belongs, each inline act in the menu under its own name.
    const PAGE_DOORS = PAGE_DOORS_HALLS;
    await admin.eval(`(() => { window.__otherHall = [...document.querySelectorAll('#roomList > li[data-key]')].find((li) => li.dataset.key !== '${code}'); window.__guestRow = [...document.querySelectorAll('#usersTbody > tr[data-key]')].find((tr) => tr.querySelector('.role-select')); window.__feedMsg = [...document.querySelectorAll('#adminFeed > .admin-msg[data-key]')].find((d) => d.querySelector('.admin-msg-body p')); return !!(window.__otherHall && window.__guestRow && window.__feedMsg); })()`);
    const adminDoors = {
      hall: await doorsOf(admin, 'adminRoom', 'window.__otherHall', `AGM.page.object('adminRoom', window.__otherHall.dataset.key)`, { ...PAGE_DOORS, hit: '.room-pick' }),
      header: await doorsOf(admin, 'adminRoom', `document.getElementById('roomHeader')`, `AGM.page.object('adminRoom', '${code}')`, { ...PAGE_DOORS, hit: '.room-code-big', focus: `document.querySelector('#roomActs .obj-more')` }),
      person: await doorsOf(admin, 'person', 'window.__guestRow', `AGM.page.object('person', window.__guestRow.dataset.key)`, { ...PAGE_DOORS, hit: 'td strong' }),
      message: await doorsOf(admin, 'adminMsg', 'window.__feedMsg', `AGM.page.object('adminMsg', window.__feedMsg.dataset.key)`, { ...PAGE_DOORS, hit: '.admin-msg-head strong' }),
      tunnel: await doorsOf(admin, 'tunnel', `document.getElementById('tunnelSection')`, `AGM.page.object('tunnel')`, { ...PAGE_DOORS, hit: 'h3', focus: `document.querySelector('#tunnelActs .obj-more')` }),
      laptop: await doorsOf(admin, 'laptop', `document.getElementById('laptopSection')`, `AGM.page.object('laptop')`, { ...PAGE_DOORS, hit: 'h3', focus: `document.querySelector('#laptopActs .obj-more')` }),
    };
    for (const [what, d] of Object.entries(adminDoors)) report(doorsInStep(d), `the admin page's ${what}: right-click = ⋯ = Shift+F10 = the catalogue's set, the bar in it (${d.want}; ${d.right} / ${d.dots} / ${d.key}; ${d.inline}; hit ${d.hit})`);
    // "This laptop": every fact with its words and where it was read, in the server's order; Windows' facts read on
    // Windows and unknown with why elsewhere; Refresh reads Windows again and says when.
    const LAPTOP_ROWS = ['build', 'format', 'addresses', 'https', 'sealed', 'screens', 'stagewatch', 'tunnel', 'network', 'firewall', 'sleep', 'lid', 'task', 'admin'];
    const laptopRows = await admin.until(`(() => {
      const rows = [...document.querySelectorAll('#laptopFacts > li[data-fact]')];
      if (!rows.length) return false;
      return JSON.stringify({ ids: rows.map((r) => r.dataset.fact), said: rows.every((r) => r.querySelector('strong').textContent.endsWith(': ') && r.querySelector('.lf-words').textContent.length > 0 && /^ · read from \\S/.test(r.querySelector('.lf-from').textContent)),
        marks: rows.every((r) => (r.querySelector('.lf-mark').textContent === '') === (r.dataset.state === '')), elsewhere: ${process.platform === 'win32'} || rows.filter((r) => ['network', 'sleep', 'lid', 'task', 'admin'].includes(r.dataset.fact)).every((r) => r.querySelector('.lf-words').textContent === 'unknown (AGMessage is not running on Windows)'),
        folder: rows.filter((r) => r.dataset.fact === 'format').map((r) => r.querySelector('.lf-words').textContent).join('') });
    })()`, 8000);
    const laptopRead = JSON.parse(laptopRows || '{}');
    await admin.eval(`(() => { document.getElementById('laptopRead').textContent = ''; document.querySelector('#laptopActs [data-action="laptop.refresh"]').click(); })()`);
    const refreshed = await admin.until(`(() => { const t = document.getElementById('laptopRead').textContent; return /^Read at \\d\\d:\\d\\d on \\d+ \\w+\\. Refresh reads it again\\.$/.test(t) && t; })()`, 15000);
    await admin.eval(`document.getElementById('laptopSection').scrollIntoView({ block: 'start' })`);
    await admin.shot(path.join(OUT, 'admin-laptop.png'));
    report(LAPTOP_ROWS.every((id) => (laptopRead.ids || []).includes(id)) && laptopRead.said && laptopRead.marks && laptopRead.elsewhere && /^format 2 · /.test(laptopRead.folder || '') && !!refreshed,
      `the admin page's "This laptop" says each fact, its mark beside its shape, and where it was read, and Refresh reads Windows again (${laptopRows}; "${refreshed}")`);
    report(JSON.parse(adminDoors.hall.want).includes('adminRoom.watch') && !JSON.parse(adminDoors.header.want).includes('adminRoom.watch') && JSON.parse(adminDoors.person.want).includes('person.seat') && JSON.parse(adminDoors.message.want).includes('adminMsg.delete'),
      `the admin page's menus: Watch for a hall not watched and none in the watched one's header, a code guest's Seat, a message's Delete for everyone (${adminDoors.hall.want}; ${adminDoors.header.want})`);
    // Asks in place, never a native dialog: Delete for everyone…, Close hall… (its files' tick) and Log out…, each named
    // for its object and answered "no" (Escape, or its safe button), so nothing changes.
    const askOn = async (sel, id) => {
      await admin.eval(`(${sel}).querySelector('.obj-more').click()`);
      await admin.until(`!!document.querySelector('.agm-menu [data-action="${id}"]')`, 3000);
      await admin.eval(`document.querySelector('.agm-menu [data-action="${id}"]').click()`);
      return admin.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, words: (a.querySelector('.agm-ask-words') || {}).textContent || '', ticks: [...a.querySelectorAll('input[type=checkbox]')].map((c) => c.checked), yes: a.querySelector('[data-answer=yes]').textContent, no: a.querySelector('[data-answer=no]').textContent, focus: document.activeElement === a.querySelector('[data-answer=no]') }); })()`, 3000);
    };
    const feedBefore = await admin.eval(`currentRoom.messages.length`);
    const delAsk = JSON.parse(await askOn('window.__feedMsg', 'adminMsg.delete'));
    await press(admin, 'Escape');
    const delNo = await admin.until(`!document.querySelector('.agm-ask') && document.activeElement === window.__feedMsg.querySelector('.obj-more') && currentRoom.messages.length === ${feedBefore}`, 3000);
    const closeAsk = JSON.parse(await askOn(`document.getElementById('roomHeader')`, 'adminRoom.remove'));
    await admin.eval(`document.querySelector('.agm-ask [data-answer=no]').click()`);
    const closeNo = await admin.until(`!document.querySelector('.agm-ask') && !document.getElementById('roomHeader').hidden && !!roomObject('${code}')`, 3000);
    const kickAsk = JSON.parse(await askOn('window.__guestRow', 'person.kick'));
    await press(admin, 'Escape');
    const kickNo = await admin.until(`!document.querySelector('.agm-ask') && window.__guestRow.isConnected`, 3000);
    report(delAsk.title === 'Delete this message for everyone in Smoke AGM?' && delAsk.yes === 'Delete for everyone' && delAsk.no === 'Keep it' && delAsk.focus && !!delNo
      && closeAsk.title === 'Close hall Smoke AGM?' && JSON.stringify(closeAsk.ticks) === '[true]' && closeAsk.yes === 'Close and delete' && !!closeNo
      && /^Log .+ out of Smoke AGM\?$/.test(kickAsk.title) && / can join again with the code\.$/.test(kickAsk.words) && !!kickNo,
      `the admin page asks in place, named for the object, the safe answer focused, and "no" changes nothing: ${delAsk.title} / ${closeAsk.title} (${closeAsk.ticks}) / ${kickAsk.title} ${kickAsk.words}`);
    // Let them forward into ▸: every other hall, ticked where the guest may forward now; a tick lets them (a chip in the
    // row), and the chip's × takes it back. The picker of 0.5.1 is gone: this is the person's menu.
    await admin.eval(`window.__guestRow.querySelector('.obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="person.forward"]')`, 3000);
    await admin.eval(`document.querySelector('.agm-menu [data-action="person.forward"]').click()`);
    const halls = await admin.until(`(() => { const rows = [...document.querySelectorAll('.agm-sub .agm-mi[data-value]')]; return rows.length > 0 && JSON.stringify(rows.map((r) => [r.dataset.value, r.getAttribute('role'), r.getAttribute('aria-checked')])); })()`, 5000);
    const firstHall = halls ? JSON.parse(halls)[0][0] : '';
    await admin.eval(`document.querySelector('.agm-sub .agm-mi[data-value="${firstHall}"]').click()`);
    const chip = await admin.until(`(() => { const b = window.__guestRow.querySelector('.unlink-room[data-room="${firstHall}"]'); return !!b && b.getAttribute('aria-label'); })()`, 5000);
    // Linked, the guest's menu offers No longer forward into ▸ with that hall, and the hall reads ticked under Let them
    // forward into ▸; unticked there, it is taken back (No longer forward into's own act).
    await admin.eval(`window.__guestRow.querySelector('.obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="person.forward"]')`, 3000);
    const unforward = await admin.eval(`!!document.querySelector('.agm-menu [data-action="person.unforward"]')`);
    await admin.eval(`document.querySelector('.agm-menu [data-action="person.forward"]').click()`);
    const ticked = await admin.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi[data-value="${firstHall}"]'); return !!r && r.getAttribute('aria-checked') === 'true'; })()`, 5000);
    await admin.eval(`document.querySelector('.agm-sub .agm-mi[data-value="${firstHall}"]').click()`);
    const untickedGone = await admin.until(`!window.__guestRow.querySelector('.unlink-room[data-room="${firstHall}"]')`, 5000);
    // Ticked again, and the chip's × takes it back as well.
    await admin.eval(`window.__guestRow.querySelector('.obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="person.forward"]')`, 3000);
    await admin.eval(`document.querySelector('.agm-menu [data-action="person.forward"]').click()`);
    await admin.until(`!!document.querySelector('.agm-sub .agm-mi[data-value="${firstHall}"]')`, 5000);
    await admin.eval(`document.querySelector('.agm-sub .agm-mi[data-value="${firstHall}"]').click()`);
    await admin.until(`!!window.__guestRow.querySelector('.unlink-room[data-room="${firstHall}"]')`, 5000);
    await admin.eval(`window.__guestRow.querySelector('.unlink-room[data-room="${firstHall}"]').click()`);
    const chipGone = await admin.until(`!window.__guestRow.querySelector('.unlink-room[data-room="${firstHall}"]')`, 5000);
    report(!!halls && JSON.parse(halls).every(([hallCode, role, checked]) => hallCode !== code && role === 'menuitemcheckbox' && checked === 'false') && /^Stop .+ forwarding into .+$/.test(chip || '') && unforward && !!ticked && !!untickedGone && !!chipGone,
      `Let them forward into ▸ lists every other hall as a tick; ticked, the guest may forward there (its chip: "${chip}") and No longer forward into ▸ is offered; unticking it, or the chip's ×, takes it back (${halls}; ${JSON.stringify({ unforward, ticked: !!ticked, unticked: !!untickedGone })})`);
    // The header: the theme and Logout are ordinary buttons in its row, and nothing covers Logout at 1440, 1024 or 390 px.
    const covered = [];
    for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
      await admin.resize(w, h);
      await sleep(250);
      covered.push(await admin.eval(`(() => { window.scrollTo(0, 0); return ['logoutBtn', 'themeBtn', 'newSessionBtn'].map((id) => { const b = document.getElementById(id); const q = b.getBoundingClientRect(); const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return id + (q.width > 0 && hit && b.contains(hit) ? '' : ' covered by ' + (hit ? hit.id || hit.className : 'nothing')); }).join(', ') + ' @' + innerWidth + (document.documentElement.scrollWidth > innerWidth ? ' (wider than the screen)' : ''); })()`));
    }
    await admin.resize(1400, 900);
    report(covered.every((c) => !/covered|wider/.test(c)) && covered.length === 3, `the admin's Logout, theme and New hall are never covered (${covered.join('; ')})`);
    // The skip link: the page's first focusable control, and it takes the focus to the halls.
    const skipAdmin = await admin.eval(`(async () => { const s = document.querySelector('.skip-link'); const first = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')].find((n) => !n.disabled && n.getClientRects().length);
      s.focus(); const shown = s.getBoundingClientRect().top >= 0; s.click(); await new Promise((r) => setTimeout(r, 50)); return JSON.stringify({ first: first === s, words: s.textContent, shown, to: document.activeElement.id }); })()`);
    report(skipAdmin === JSON.stringify({ first: true, words: 'Skip to the halls', shown: true, to: 'hallsHere' }), `the admin page's first Tab is "Skip to the halls", shown when focused, and it moves the focus there (${skipAdmin})`);
    // The admin page in both themes, and under a finger on a phone, as the other pages are.
    const adminInk = await barsInThemes(admin, 'window.__guestRow');
    const adminFinger = await barsUnderAFinger(edge, base + '/admin.html', `document.querySelectorAll('#roomList .obj-bar > .obj-more').length > 0`);
    report(barsOk(adminInk.light) && barsOk(adminInk.dark) && adminFinger.coarse && barsOk(adminFinger) && adminFinger.problems.length === 0,
      `the admin page reads in both themes (bars 24 px or more, icons 3:1, words 4.5:1, none faded, menus 4.5:1) and its acts and ⋯ are 44 px under a finger (${JSON.stringify({ ...adminInk, finger: adminFinger })})`);
    // A disabled act sends nothing: Check again on the internet link while it is off is shown, says why on its button, in
    // its menu and when chosen there or on the button, and the page emits nothing for it (its emits counted).
    const CHECK_ACT = `document.querySelector('#tunnelActs [data-action="tunnel.check"]')`;
    await admin.eval(`(() => { window.__acts = []; const e0 = socket.emit; window.__emitWas = e0; socket.emit = function (ev, ...a) { window.__acts.push(ev); return e0.call(this, ev, ...a); }; })()`);
    const checkBtn = await admin.eval(`(() => { const b = ${CHECK_ACT}; return b ? JSON.stringify({ disabled: b.getAttribute('aria-disabled'), title: b.title }) : ''; })()`);
    await admin.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; (${CHECK_ACT}).click(); })()`);
    const checkSaid = await admin.until(`(document.getElementById('agmToast') || {}).textContent`, 3000);
    await admin.eval(`document.querySelector('#tunnelActs .obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="tunnel.check"]')`, 3000);
    const checkItem = await admin.eval(`(() => { const m = document.querySelector('.agm-menu [data-action="tunnel.check"]'); return JSON.stringify({ disabled: m.getAttribute('aria-disabled'), why: m.querySelector('.mi-why').textContent }); })()`);
    await admin.eval(`(() => { document.getElementById('agmToast').textContent = ''; document.querySelector('.agm-menu [data-action="tunnel.check"]').click(); })()`);
    const checkItemSaid = await admin.until(`(document.getElementById('agmToast') || {}).textContent`, 3000);
    await sleep(500);
    if (await admin.eval(`!!document.querySelector('.agm-menu')`)) await press(admin, 'Escape');
    const checkSent = await admin.eval(`(() => { socket.emit = window.__emitWas; return JSON.stringify(window.__acts.filter((ev) => ev !== 'admin:settings')); })()`);
    const offWords = 'The internet link is off.';
    report(checkBtn === JSON.stringify({ disabled: 'true', title: offWords }) && checkSaid === offWords && checkItem === JSON.stringify({ disabled: 'true', why: offWords }) && checkItemSaid === offWords && checkSent === '[]',
      `a disabled act says why on its button, in its menu and when chosen, and sends nothing: Check again on an internet link that is off (${checkBtn}; ${checkItem}; said "${checkSaid}" and "${checkItemSaid}"; sent ${checkSent})`);
    await research.eval(`Promise.all([new Promise((r) => socket.emit('message', { type: 'help', category: 'Sound', text: 'radio mic 3 dead' }, r)), new Promise((r) => socket.emit('message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] }, r))])`);
    // On stage, what is written stays in the room: no message offers ↗, a text, a file or a question, and nothing that
    // is not hidden is drawn for it; the Board's composer has no file or question door.
    const boardForward = await board.until(`(() => {
      const kinds = new Set(Array.from(document.querySelectorAll('.msg[data-type]')).map((n) => n.dataset.type));
      if (!['text', 'file', 'action'].every((k) => kinds.has(k))) return null;
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]');
      return JSON.stringify({ forward: allMessages.filter((m) => AGM.catalog.ids('msg', F, m).includes('msg.send')).length + Array.from(document.querySelectorAll('.msg [data-action="msg.send"]')).filter(shown).length,
        composer: Array.from(document.querySelectorAll('#directorCompose button, #directorCompose input')).filter(shown).map((b) => b.id || (b.classList.contains('send-btn') ? 'send' : b.classList.contains('compose-more') ? 'more' : b.outerHTML)) });
    })()`);
    report(boardForward === JSON.stringify({ forward: 0, composer: ['directorInput', 'dirPriorityBtn', 'send', 'more'] }), `an On stage page offers no forward on any message, and its composer holds the words, 🔥, Send and its ⋯ (${boardForward})`);
    // Help requests are answered by the backstage team: an On stage page draws no On my way or Resolved on someone else's
    // request and only Resolved on its own, which it marks; a backstage page draws both on the Board's. Someone else is
    // Cy, on a socket of her own: the smoke's pages share this browser's one identity, so each is the same person.
    const cy = await connect(base);
    await emit(cy, 'join', { roomCode: code, name: 'Cy', role: 'research' });
    await emit(cy, 'message', { type: 'help', category: 'Vision', text: 'screen 2 is dark' });
    await board.eval(`new Promise((r) => socket.emit('message', { type: 'help', category: 'Presenter', text: 'water at the lectern' }, r))`);
    const HELP_DOORS = (text) => `(() => { const m = allMessages.find((x) => x.type === 'help' && x.text === ${codeLiteral(text)}); const n = m && messagesById.get(m.id);
      return n ? JSON.stringify([...n.querySelectorAll('.help-actions button')].filter((b) => getComputedStyle(b).display !== 'none' && !b.closest('[hidden]')).map((b) => b.textContent)) : null; })()`;
    const helpDoors = JSON.stringify({ others: await board.until(HELP_DOORS('screen 2 is dark')), own: await board.until(HELP_DOORS('water at the lectern')), backstage: await research.until(HELP_DOORS('water at the lectern')) });
    await board.eval(`(() => { const m = allMessages.find((x) => x.type === 'help' && x.text === 'water at the lectern'); [...messagesById.get(m.id).querySelectorAll('.help-actions button')].find((b) => b.textContent === 'Resolved').click(); })()`);
    const ownResolved = await research.until(`(() => { const m = allMessages.find((x) => x.type === 'help' && x.text === 'water at the lectern'); return m && m.help.state === 'resolved' && JSON.stringify([m.help.state, m.help.by, ${HELP_DOORS('water at the lectern')}]); })()`);
    report(helpDoors === JSON.stringify({ others: '[]', own: '["Resolved"]', backstage: '["On my way","Resolved"]' }) && ownResolved === JSON.stringify(['resolved', 'Chair', '[]']),
      `an On stage page answers only its own help request: no On my way or Resolved on another's, Resolved alone on its own, which it marks (${helpDoors}; ${ownResolved})`);
    cy.close();
    // A page opened before its hall had a Stagewatch offers 🖥 once it has one (the server's answer, asked again when the
    // link's state changes).
    const STAGE_ACTS = `[...document.querySelectorAll('#feed .msg[data-type="text"] .msg-acts [data-action="msg.speaker"], #feed .msg[data-type="text"] .msg-acts [data-action="msg.sendNow"]')].filter((b) => b.getClientRects().length > 0).length`;
    report(!!(await research.until(`CAN_STAGE && allMessages.some((m) => m.type === 'text' && AGM.catalog.ids('msg', F, m).includes('msg.sendNow')) && ${STAGE_ACTS} > 0`)), 'a page opened before its hall had a Stagewatch offers 🖥 once it has one');
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
    // On the admin page, the linked Patterns is a link of the catalogue's (its doors in step), set up through one form of
    // three fields asked in place — its pairing token (a password field, nothing kept by the browser), the hall from a pick
    // list, its certificate's fingerprint — held open 30 s while the page's socket stays connected (a native prompt would
    // pause the page, and the server drops a page silent for 18 s), then saved.
    const NODE_ROW = `document.querySelector('#nodeLinks > li[data-key="node:smokepat"]')`;
    await admin.until(`!!(${NODE_ROW}) && !!(${NODE_ROW}).querySelector('.obj-more')`, 15000);
    const linkDoors = await doorsOf(admin, 'link', NODE_ROW, `AGM.page.object('link', 'node:smokepat')`, { ...PAGE_DOORS_HALLS, hit: '.link-words' });
    report(doorsInStep(linkDoors) && JSON.parse(linkDoors.want).includes('link.setup') && JSON.parse(linkDoors.want).includes('link.unlink'),
      `a linked Patterns on the admin page: right-click = ⋯ = Shift+F10 = the catalogue's set, its bar in it (${linkDoors.want}; ${linkDoors.right} / ${linkDoors.dots} / ${linkDoors.key}; ${linkDoors.inline})`);
    const sock0 = await admin.eval(`(() => { window.__drops = 0; socket.on('disconnect', () => { window.__drops++; }); return socket.id; })()`);
    await admin.eval(`(${NODE_ROW}).querySelector('.obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="link.setup"]')`, 3000);
    await admin.eval(`document.querySelector('.agm-menu [data-action="link.setup"]').click()`);
    const linkForm = await admin.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent,
      fields: [...a.querySelectorAll('input, select')].map((i) => i.name + ':' + (i.tagName === 'SELECT' ? 'select' : i.type) + (i.tagName === 'INPUT' ? ':' + i.autocomplete : '')),
      hall: a.querySelector('select').value, halls: a.querySelector('select').options.length, focus: document.activeElement === a.querySelector('input[name="token"]') }); })()`, 3000);
    await sleep(30_000);
    const linkHeld = await admin.eval(`JSON.stringify({ open: !!document.querySelector('.agm-ask'), same: socket.id === ${codeLiteral(sock0)}, connected: socket.connected, drops: window.__drops })`);
    await admin.eval(`(() => { const a = document.querySelector('.agm-ask'); a.querySelector('input[name="token"]').value = 'node-token'; a.querySelector('[data-answer="yes"]').click(); })()`);
    const linkSaved = await admin.until(`(document.getElementById('agmToast') || {}).textContent === 'Smoke Patterns is set up.' && !document.querySelector('.agm-ask')`, 10000);
    const lf = linkForm && JSON.parse(linkForm);
    report(!!lf && lf.title === 'Set up Smoke Patterns' && JSON.stringify(lf.fields) === JSON.stringify(['token:password:off', 'hall:select', 'fingerprint:text:off']) && lf.hall === code && lf.halls >= 2 && lf.focus
      && linkHeld === JSON.stringify({ open: true, same: true, connected: true, drops: 0 }) && !!linkSaved,
      `a node is set up through one form of three fields, held open 30 s with the page's socket connected throughout, then saved (${linkForm}; ${linkHeld})`);
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
        acts: [...new Set(allMessages.filter((m) => m.type !== 'system').flatMap((m) => AGM.catalog.ids('msg', F, m)))].sort(),
        bars: Array.from(document.querySelectorAll('.msg .msg-act')).filter(visible).length,
        answer: Array.from(document.querySelectorAll('.action-btn')).some((b) => !b.disabled),
        answerWords: !!document.querySelector('.answer-words-btn'),
        reactions: Array.from(document.querySelectorAll('.rx-pill')).some((b) => !b.disabled),
        files: document.querySelectorAll('.msg[data-type="file"]').length,
      });
    })()`);
    report(shown === JSON.stringify({ composer: false, stage: false, acts: ['msg.copy'], bars: 0, answer: false, answerWords: false, reactions: false, files: shown && JSON.parse(shown).files }) && JSON.parse(shown).files > 0,
      `the Viewer is offered nothing the server refuses: Copy text alone, no pin, reaction, answer, Send to, Look or Download on any message, a file's included (${shown})`);
    report(await viewerHall.eval(`document.getElementById('movedLine').hidden`), 'a page opened in this browser after What moved\'s Got it does not say it again');
    await readOldWords('the hall page opened by a Viewer account, Observer', viewerHall);
    const pagesRead = Object.keys(oldWords);
    report(pagesRead.length === 13 && pagesRead.every((p) => Array.isArray(oldWords[p]) && oldWords[p].length === 0),
      `no "session", "meeting", "director" or "research" in any page's chrome (${pagesRead.length} pages: ${pagesRead.map((p) => p + ': ' + (Array.isArray(oldWords[p]) ? (oldWords[p].length ? oldWords[p].join(' | ') : 'none') : 'not read')).join('; ')})`);
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
    const staffShown = await staffHall.eval(`JSON.stringify({ who: document.getElementById('whoami').textContent, role: document.body.dataset.role, texts: allMessages.some((m) => m.type === 'text'), propose: CAN_PROPOSE, send: CAN_STAGE, buttons: ${STAGE_ACTS} + allMessages.filter((m) => AGM.catalog.ids('msg', F, m).some((id) => id === 'msg.speaker' || id === 'msg.sendNow')).length })`);
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
    const sendsBefore = await research.eval(STAGE_ACTS);
    // The research page stands for a guest's own device, which holds no account's sign-in: the accounts signed in on this
    // browser since it joined leave the cookie jar before it connects again (a signed-in browser is refused a code join).
    // The pages already open keep their connections.
    await signin.send('Network.deleteCookies', { name: 'agm_s', url: base + '/' });
    await research.eval(`socket.disconnect()`);
    const removed = await hallView.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: '' }, (x) => r(!!(x && x.ok))))`);
    await research.eval(`socket.connect()`);
    const back = await research.until(`socket.connected && joined && !CAN_STAGE && JSON.stringify({ shown: ${STAGE_ACTS} })`, 8000);
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
    const refusedWith = await asGuest.until(`!joined && ${OUT_OF_HALL}`);
    const imposter = await admin.eval(`new Promise((r) => socket.emit('admin:listRooms', (x) => r(x.rooms.find((h) => h.code === '${code}').users.some((u) => u.name === 'Imposter'))))`);
    await sleep(3000);
    const stayedRefused = await asGuest.eval(`location.pathname + '|' + !document.getElementById('outOfHall').hidden`);
    await asGuest.eval(`document.getElementById('outBack').click()`);
    const landed = await asGuest.until(`location.pathname === '/' && !document.getElementById('signedInPane').hidden && document.getElementById('joinForm').hidden && location.search`, 8000);
    report(refusedWith === JSON.stringify({ words: 'You are signed in as Ana Admin: open the room from your halls, or sign out to join with a code.', back: 'Back to sign-in', to: `/?code=${code}&role=research&invite=smoke-invite`, hall: true, offered: [], focused: true, connected: false })
      && stayedRefused === '/app.html|true' && imposter === false && landed === `?code=${code}&role=research&invite=smoke-invite`,
      `a guest's hall link in a signed-in browser is refused in the server's words in place, seats nobody, stays until Back to sign-in, and lands on its code link, which offers the halls or Sign out (${refusedWith}; after 3 s: ${stayedRefused}; seated: ${imposter}; ${landed})`);
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
    await fetch(base2 + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' }) });
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
    report(/^broken\|✕ entry 8 is missing: this machine recorded entry 8; the log ended at entry 7/.test(cut2 || ''), `a log cut while it was stopped reads ✕, with what is missing (${cut2})`);
    const rows2 = await audit2.eval(`[...document.querySelectorAll('#auditList .audit-row')].map((li) => li.querySelector('.audit-mark [aria-hidden]').textContent).join('')`);
    // The folder 0.5.1 left (format 1, no marker) was copied and marked at its first start under this build: one
    // server.upgraded row, keyed, and none at the start after it.
    const upgraded2 = await audit2.eval(`[...document.querySelectorAll('#auditList .audit-row .audit-action')].filter((a) => a.textContent.startsWith('server.upgraded')).length`);
    report(rows2 === '✓✓✓✓△△△△△' && upgraded2 === 1, `the rows read ✓ under this key (the sign-in, the cut, the boundary, the folder's upgrade, once: ${upgraded2}) and △ for the 0.5.1 entries (${rows2})`);
    const admin2 = await edge.tab(`${base2}/admin.html`);
    const where2 = await admin2.until(`(() => { const w = document.getElementById('auditWhere'); return !document.getElementById('dashboard').hidden && !w.hidden && document.getElementById('auditAcceptRow').hidden && document.getElementById('auditLine').dataset.mark === 'broken' && w.textContent; })()`, 20000);
    report(where2 === 'Accept this on the AGMessage laptop: sign in there with its token (Admin login in the AGMessage window; installed: Start → AGMessage → Show the admin token).', `an admin account is told where to accept, and offered no Accept button (${where2})`);
    await admin2.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
    const button2 = await admin2.until(`!document.getElementById('dashboard').hidden && !document.getElementById('auditAcceptRow').hidden && document.getElementById('auditWhere').hidden`, 20000);
    await admin2.eval(`document.getElementById('auditAcceptBtn').click()`);
    const ticks = await admin2.until(`(() => { const boxes = [...document.querySelectorAll('#acceptList input[data-id]')]; return document.getElementById('acceptDialog').open && boxes.length === 2 && boxes.map((b) => b.dataset.id + '=' + b.checked).join(' '); })()`);
    report(!!button2 && ticks === 's1-5=true e8=false', `the token at the laptop is offered Accept, and in its dialog a △ starts ticked and a ✕ unticked (${ticks})`);
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
    await audit2.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }).then(() => fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia', name: 'Mia Manager', role: 'manager', grant: ['users.manage'], password: 'running order on the wall' }) })).then(() => fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia', password: 'running order on the wall' }) })).then(() => { location.href = '/users.html?as=mia#audit'; })`);
    const miaAudit = await audit2.until(`location.pathname === '/users.html' && /Mia Manager/.test(document.getElementById('who').textContent) && !document.getElementById('auditPane').hidden && document.querySelectorAll('#auditList .audit-row').length > 0 && String(document.getElementById('exportBtn').hidden)`, 20000);
    report(miaAudit === 'true', `a project manager reads the audit log and is offered no Export (Export hidden: ${miaAudit})`);
    // A row this manager may not change (an admin's): its Edit is shown, disabled, and says why on its button, in its menu
    // (a second line a touch screen reads) and in the toast when it is chosen; nothing opens.
    await audit2.eval(`document.getElementById('tabPeople').click()`);
    const ANA_ROW = `[...document.querySelectorAll('#userRows > tr[data-key]')].find((tr) => tr.querySelector('td .muted').textContent.split(' ')[0] === 'ana')`;
    await audit2.until(`!!(${ANA_ROW}) && !!(${ANA_ROW}).querySelector('[data-action="account.edit"]')`);
    const lockedWhy = await audit2.eval(`AGM.api('GET', '/api/users').then((r) => r.users.find((u) => u.username === 'ana').locked)`);
    await audit2.eval(`(() => { window.__asked = []; const f0 = window.fetch; window.fetch = function (u, ...a) { window.__asked.push(String(u)); return f0.call(this, u, ...a); }; })()`);
    const lockedBtn = await audit2.eval(`(() => { const b = (${ANA_ROW}).querySelector('[data-action="account.edit"]'); return JSON.stringify({ disabled: b.getAttribute('aria-disabled'), title: b.title, focusable: b.tabIndex >= -1 && !b.disabled }); })()`);
    await audit2.eval(`(${ANA_ROW}).querySelector('[data-action="account.edit"]').click()`);
    const lockedToast = await audit2.until(`(document.getElementById('agmToast') || {}).textContent || ''`, 3000);
    await audit2.eval(`(${ANA_ROW}).querySelector('.obj-more').click()`);
    const lockedMenu = await audit2.until(`(() => { const m = document.querySelector('.agm-menu [data-action="account.edit"]'); return m && JSON.stringify({ ids: [...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].map((b) => b.dataset.action), why: m.querySelector('.mi-why').textContent, shown: !m.querySelector('.mi-why').hidden, disabled: m.getAttribute('aria-disabled') }); })()`, 3000);
    await audit2.eval(`(() => { document.getElementById('agmToast').textContent = ''; document.querySelector('.agm-menu [data-action="account.edit"]').click(); })()`);
    const lockedItemSaid = await audit2.until(`(document.getElementById('agmToast') || {}).textContent || ''`, 3000);
    if (await audit2.eval(`!!document.querySelector('.agm-menu')`)) await press(audit2, 'Escape');
    const noEditor = await audit2.eval(`!document.getElementById('userDialog').open`);
    const lockedAsked = await audit2.eval(`JSON.stringify(window.__asked)`);
    report(typeof lockedWhy === 'string' && lockedWhy.length > 0 && lockedBtn === JSON.stringify({ disabled: 'true', title: lockedWhy, focusable: true }) && lockedToast === lockedWhy
      && lockedMenu === JSON.stringify({ ids: ['account.edit'], why: lockedWhy, shown: true, disabled: 'true' }) && lockedItemSaid === lockedWhy && noEditor === true && lockedAsked === '[]',
      `a locked account row's Edit says why — on its button, in its menu and when chosen in either — opens nothing and asks the server nothing ("${lockedWhy}"; ${lockedMenu}; asked ${lockedAsked})`);

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
    await fetch(base3 + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' }) });
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

    // Pages come back by themselves, on a fourth AGMessage of their own (its connections drained, then stopped and
    // started again): a page refused at connect says the wait and comes back without a reload; a drop says
    // "Reconnecting…" after 2 s and the dot's words after 5 s, both gone at the join's answer; a page shown again while
    // its backoff waits comes back at once; and the restart announces nobody.
    {
      dataDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-back-'));
      const port4 = await freePort();
      const base4 = `http://127.0.0.1:${port4}`;
      server4 = await startServer(port4, dataDir4);
      const login4 = await fetch(base4 + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
      const hall4 = (await (await fetch(base4 + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: login4.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ name: 'Back hall' }) })).json()).code;
      const rae = await edge.tab(`${base4}/app.html?code=${hall4}&name=Rae&role=research`);
      await rae.until('typeof connection !== "undefined" && connection.state().back');
      const CONN = `JSON.stringify({ strip: document.getElementById('connStrip').hidden ? '' : document.getElementById('connStrip').textContent, dot: (document.getElementById('connDot').classList.contains('ok') ? '● ' : '○ ') + document.getElementById('connDot').getAttribute('aria-label'), words: document.getElementById('connWords').hidden ? '' : document.getElementById('connWords').textContent })`;
      // Refused: this address's connections (3 a second, bursts of 30) drained from here until the server refuses one,
      // and then until it takes one asked after that refusal was seen: that one took the token that had just come, so the
      // bucket is empty and its next token a third of a second away. The drain stops there, and the page connects again
      // at once (its backoff set to nothing; a refusal's wait is the server's), well inside that third of a second, so
      // the server refuses it whatever the drain's pace on this machine; and by the wait it is told, tokens have come.
      await rae.eval(`(() => { socket.io.reconnectionDelay(0); socket.io.reconnectionDelayMax(0); })()`);
      const drains = [];
      let drained = false;   // the server has refused one of the drain's connections
      const draining = { on: true };
      let tokenTaken;
      const taken = new Promise((resolve) => { tokenTaken = resolve; });
      const drain = (async () => {
        while (draining.on) {
          const askedAfterRefusal = drained;
          const d = ioClient(base4, { transports: ['websocket'], forceNew: true, reconnection: false });
          d.once('connect_error', (e) => { if (e && e.data && e.data.why === 'rate') drained = true; });
          d.once('connect', () => { if (askedAfterRefusal) tokenTaken(true); });
          drains.push(d);
          await sleep(20);
        }
      })();
      const atBoundary = await Promise.race([taken, sleep(10000).then(() => false)]);
      draining.on = false;
      await rae.eval(`(() => { window.__sameLoad = 1; socket.io.engine.close(); })()`);
      await drain;
      const busy = await rae.until(`(() => { const s = document.getElementById('connStrip'); return !s.hidden && /^Busy — trying again in [1-4] s\\.$/.test(s.textContent) && s.textContent; })()`, 10000);
      const busyBack = await rae.until(`connection.state().back && window.__sameLoad === 1 && ${CONN}`, 15000);
      drains.forEach((d) => d.close());
      report(atBoundary && !!busy && busyBack === JSON.stringify({ strip: '', dot: '● Connected', words: '' }), `a page refused at connect says "${busy}" and comes back by itself at that wait, without a reload (${busyBack}${atBoundary ? '' : '; the drain never saw this address\'s bucket empty'})`);
      // Dropped: the server stops. The page's backoff is made long, so only being shown again can bring it back soon.
      await rae.eval(`(() => { socket.io.reconnectionDelay(30000); socket.io.reconnectionDelayMax(30000); socket.once('disconnect', () => { window.__downAt = performance.now(); }); })()`);
      await stopServer(server4);
      server4 = null;
      await rae.until('!socket.connected && window.__downAt > 0', 5000);
      const twoS = await rae.until(`performance.now() - window.__downAt > 2300 && ${CONN}`, 5000);
      const fiveS = await rae.until(`performance.now() - window.__downAt > 5300 && ${CONN}`, 8000);
      server4 = await startServer(port4, dataDir4);
      await sleep(500);
      const stillWaiting = await rae.eval(`!socket.connected`);
      await rae.eval(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); })()`);
      const hiddenStays = await rae.eval(`!socket.connected`);
      await rae.eval(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); window.__shownAt = performance.now(); document.dispatchEvent(new Event('visibilitychange')); })()`);
      const shownBack = await rae.until(`connection.state().back && JSON.stringify({ ms: Math.round(performance.now() - window.__shownAt), conn: ${CONN} })`, 10000);
      const down = JSON.stringify({ strip: 'Reconnecting… what you write waits here until we\'re back.', dot: '○ Offline · reconnecting', words: '' });
      const downDot = JSON.stringify({ strip: 'Reconnecting… what you write waits here until we\'re back.', dot: '○ Offline · reconnecting', words: 'Offline · reconnecting' });
      report(twoS === down && fiveS === downDot, `a drop says "Reconnecting…" after 2 s and the dot's words after 5 s (${twoS}; ${fiveS})`);
      const shown = shownBack ? JSON.parse(shownBack) : null;
      report(stillWaiting && hiddenStays && !!shown && shown.ms < 3000 && shown.conn === JSON.stringify({ strip: '', dot: '● Connected', words: '' }),
        `a page shown again while its backoff waits (15 s or more) comes back at once, and the join's answer clears the strip and the dot's words (${shownBack})`);
      const announced = await rae.eval(`JSON.stringify(allMessages.filter((m) => m.type === 'system' && / joined /.test(m.text)).map((m) => m.text).concat(allMessages.filter((m) => m.type === 'system' && /^— AGMessage restarted · \\d+ messages? kept —$/.test(m.text)).length))`);
      report(announced === JSON.stringify(['Rae joined Backstage', 1]), `the restart announces nobody: the page is announced once, at its first join, and the restart's own line says what happened (${announced})`);
      await rae.shot(path.join(OUT, 'back-by-itself.png'));
      const backProblems = rae.problems.filter((p) => !/WebSocket connection to|ERR_CONNECTION_REFUSED|net::ERR_/.test(p));
      report(backProblems.length === 0, `a page that came back: no script errors or CSP violations, the stopped server's refused connections aside${backProblems.length ? ' — ' + backProblems.slice(0, 3).join(' | ') : ''}`);
      rae.close();
    }

    // Remote phones through the tunnel, on a fifth AGMessage of its own with two places through it: a hall page that
    // comes as cloudflared brings it (Cloudflare's headers on every request, its WebSocket's included) finds both taken,
    // says the server's words in its strip, and comes back by itself once a place frees, at the wait the server named
    // (30 to 40 s), without a reload. Then its admin page's tunnel card: the places and today's refusals, and the tunnel
    // turned on, its cloudflared and the link stood in for (test/tunnel-preload.js, and a local server that hands each
    // request on as cloudflared does), its link checked from the laptop and Check again held for the minute.
    {
      dataDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-tunnel-'));
      const port5 = await freePort();
      const base5 = `http://127.0.0.1:${port5}`;
      const cloudflare = (ip) => ({ 'cf-connecting-ip': ip, 'cf-ray': 'smoke-' + ip.replace(/[^0-9a-f]/g, '') });
      const linkAsked = [];
      link5 = http.createServer((req, res) => {
        linkAsked.push(req.url);
        fetch(base5 + req.url, { headers: cloudflare('203.0.113.200') }).then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
          .catch(() => { res.writeHead(502); res.end(); });
      });
      await new Promise((resolve) => { link5.listen(0, '127.0.0.1', resolve); });
      const preload = '--require "' + path.join(__dirname, 'tunnel-preload.js').split(path.sep).join('/') + '"';
      server5 = await startServer(port5, dataDir5, {
        AGM_TUNNEL_MAX: '2', AGM_TUNNEL_JOIN_MS: '600000',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_TUNNEL: 'http://127.0.0.1:' + link5.address().port,
      });
      const login5 = await fetch(base5 + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
      const hall5 = (await (await fetch(base5 + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: login5.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ name: 'Remote hall' }) })).json()).code;
      const taken = [];
      for (const ip of ['203.0.113.11', '203.0.113.12']) {
        taken.push(await new Promise((resolve, reject) => {
          const s = ioClient(base5, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cloudflare(ip) });
          s.once('connect', () => resolve(s));
          s.once('connect_error', reject);
        }));
      }
      const tia = await edge.tab(`${base5}/app.html?code=${hall5}&name=Tia&role=research`, { headers: cloudflare('2001:db8:77:1::5') });
      const STRIP = `JSON.stringify({ strip: document.getElementById('connStrip').hidden ? '' : document.getElementById('connStrip').textContent, dot: (document.getElementById('connDot').classList.contains('ok') ? '● ' : '○ ') + document.getElementById('connDot').getAttribute('aria-label') })`;
      const full = await tia.until(`(() => { const s = document.getElementById('connStrip'); return !s.hidden && connection.state().why === 'full' && s.textContent; })()`, 15000);
      const fullAt = Date.now();
      const fullWords = /^AGMessage's internet link is full \(2 phones\)\. Trying again in (3\d|40) s\. On the venue's Wi-Fi there is room\.$/.test(full || '');
      const counted = await (await fetch(base5 + '/api/health')).json();
      await tia.shot(path.join(OUT, 'tunnel-full.png'));   // the refusal's words in the strip
      taken[0].close();   // a place frees
      const back = await tia.until(`connection.state().back && ${STRIP}`, 45000);
      const waited = Date.now() - fullAt;
      const seated = await tia.eval(`JSON.stringify({ hall: ROOM, joined: allMessages.some((m) => m.type === 'system' && m.text === 'Tia joined Backstage') })`);
      const after = await (await fetch(base5 + '/api/health')).json();
      report(fullWords && counted.tunnel.refused.full >= 1 && back === JSON.stringify({ strip: '', dot: '● Connected' }) && waited >= 20000 && seated === JSON.stringify({ hall: hall5, joined: true }) && after.tunnel.places === 2,
        `a hall page through the tunnel, its places taken, says "${full}" and comes back by itself once one frees, ${Math.round(waited / 1000)} s later, without a reload (${back}; ${seated}; refused ${counted.tunnel.refused.full}, then ${after.tunnel.places} of ${after.tunnel.max} places)`);
      report(tia.problems.length === 0, `a page refused through the tunnel: no script errors or CSP violations${tia.problems.length ? ' — ' + tia.problems.slice(0, 3).join(' | ') : ''}`);

      const card = await edge.tab(`${base5}/admin.html`);
      await card.until('document.readyState === "complete"');
      await card.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
      const places = await card.until(`(() => { const t = document.getElementById('tunnelPlaces').textContent; return /^Internet link: 2 of 2 places · 2 networks · refused today: \\d+ full$/.test(t) && t; })()`, 15000);
      const CHECK_BTN = `document.querySelector('#tunnelActs [data-action="tunnel.check"]')`;
      const offWhy = await card.until(`!document.getElementById('dashboard').hidden && !!${CHECK_BTN} && (${CHECK_BTN}.getAttribute('aria-disabled') === 'true') + ' ' + document.getElementById('tunnelCheckWhy').textContent`);
      await card.eval(`document.getElementById('tunnelToggle').click()`);
      const checked = await card.until(`(() => { const line = document.getElementById('tunnelCheckLine').textContent; const why = document.getElementById('tunnelCheckWhy').textContent;
        return /^Checked \\d{1,2}:\\d\\d(\\s?[AP]M)? · round trip \\d+ ms \\(max \\d+ ms\\)$/.test(line) && /^Checked \\d+ s ago\\.$/.test(why) && ${CHECK_BTN}.getAttribute('aria-disabled') === 'true' && document.getElementById('tunnelToggle').checked && document.getElementById('tunnelToggleLabel').textContent === 'On'
          && /^https:\\/\\/agm-test-link-\\d+\\.trycloudflare\\.com$/.test(document.getElementById('tunnelUrl').textContent) && line + ' | ' + why; })()`, 20000);
      report(!!places && offWhy === 'true The internet link is off.' && !!checked && linkAsked.length === 5,
        `the admin page's tunnel card reads "${places}" ("${offWhy}"), and with the tunnel turned on its link is checked from the laptop: "${checked}" (${linkAsked.length} tries)`);
      await card.eval(`document.getElementById('tunnelLink').scrollIntoView({ block: 'center' })`);
      await card.shot(path.join(OUT, 'tunnel-card.png'));
      report(card.problems.length === 0, `the admin page's tunnel card: no script errors or CSP violations${card.problems.length ? ' — ' + card.problems.slice(0, 3).join(' | ') : ''}`);
      card.close();
      tia.close();
      taken.forEach((s) => s.close());
    }

    // Oli's page, untouched since "First new" arrived 30 s or more ago and every message since: its New divider is
    // still above "First new", the one divider, with no fill on it.
    await sleep(Math.max(0, firstNew + 30_000 - Date.now()));
    const stillNew = await phones.observer.eval(NEW_MARK('First new'));
    const since = await phones.observer.eval(`allMessages.slice(allMessages.findIndex((m) => m.text === 'First new') + 1).filter((m) => m.type !== 'system').length`);
    report(Date.now() - firstNew >= 30_000 && !!stillNew && stillNew.divider && stillNew.plain && since >= 5,
      `an untouched page keeps its New divider above the first new message after ${Math.round((Date.now() - firstNew) / 1000)} s and ${since} messages more, and nothing fades (${JSON.stringify(stillNew)})`);

    // Bea's "✓ Resolved", 30 s after It's sorted: Help again, neutral.
    await sleep(Math.max(0, helpResolvedAt + 30_500 - Date.now()));
    const restedChip = await bea.eval(CHIP);
    report(Date.now() - helpResolvedAt >= 30_000 && JSON.stringify(restedChip) === JSON.stringify({ words: 'Help', state: '', red: false, said: '' }),
      `"✓ Resolved" goes after 30 s: ${Math.round((Date.now() - helpResolvedAt) / 1000)} s after It's sorted, Help reads Help again (${JSON.stringify(restedChip)})`);

    const tabs = [['research', research], ['board', board], ['admin', admin], ['sign-in and halls', signin], ['accounts', users], ['hall as an account', hallView], ['hall as a Staff account', staffHall], ['display', screen], ['projector display', proj], ['foyer display (no zones)', foyer], ['a Viewer\'s halls board', viewerBoard], ['a Viewer\'s hall', viewerHall], ['a code link, signed in then out', codeLink], ['a guest\'s hall link, signed in', asGuest], ['a code link with a one-time password', otpLink], ['the audit log of a 0.5.1 log, cut', audit2], ['Accept on Health', admin2], ['the browser verifier, from disk', checker], ['Split on Health', admin3], ['the archive under the audit log', users3], ['a phone as On stage', phones.board], ['a phone backstage', phones.research], ['a phone as an observer', phones.observer]];
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
    if (server4) await stopServer(server4);
    if (server5) await stopServer(server5);
    if (link5) link5.close();
    setTimeout(() => { for (const d of [dataDir, dataDir2, dataDir3, dataDir4, dataDir5]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } }, 1000);
  }
  console.log(failures === 0 ? `ALL OK (screenshots in ${OUT})` : `${failures} FAILED`);
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})();
