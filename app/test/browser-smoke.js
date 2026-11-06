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
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { fakeStagewatch, fakeNode, chainOf, unzipTo, keyedLogWithPoints, FIXTURE_KEY, connect, emit, freePort, readSource, officeZip, wordParts, wordPicture, deckParts, deckShape, deckPicture, deckSlide, workbookParts, inviteOf, pngOf, sheetParts } = require('./helpers');
const { io: ioClient } = require('socket.io-client');
const ops = require('../lib/ops');

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
  const offered = [...new Set(['helpBtn', 'headerMore'].filter((id) => !document.getElementById(id).hidden).concat(doors, [...document.querySelectorAll('dialog[open], .agm-ask')].map((d) => d.id)))];
  return !box.hidden && JSON.stringify({ words: document.getElementById('outWords').textContent, back: back.textContent, to: back.getAttribute('href'),
    hall: document.querySelector('.main-row').hidden, offered, focused: document.activeElement === back, connected: socket.connected }); })()`;
// The server's own time zone for the smoke: a screen in another zone must still show this one's time of day.
const SERVER_TZ = 'Europe/London';
const KEY = 'swk_smoke_node_key_00001';   // secret-scan: fixture — a fake node key for the fake Stagewatch
let failures = 0;
const report = (ok, what) => { console.log((ok ? 'OK   ' : 'FAIL ') + what); if (!ok) failures++; };

/**
 * A Chromium the smoke can drive over DevTools: AGM_BROWSER, then Edge (Windows), then Chrome or Chromium (Linux, macOS),
 * each by its full path: a bare name or a relative one (an install folder's variable unset) is never run.
 */
function browserPath() {
  const c = [process.env.AGM_BROWSER, process.env.AGM_EDGE, process.env.STAGEWATCH_EDGE,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((p) => p && path.isAbsolute(p));
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

// The runtime half of the fence on a hall's snapshot (test/snapshot-preload.js), beside any preload a server is given:
// what it finds is appended to `<data folder>-snapshots.txt` as each server ends, and reported once all have stopped.
const SNAPSHOT_PRELOAD = '--require "' + path.join(__dirname, 'snapshot-preload.js').split(path.sep).join('/') + '"';
async function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '', TZ: SERVER_TZ, ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS || process.env.NODE_OPTIONS, SNAPSHOT_PRELOAD].filter(Boolean).join(' '), AGM_TEST_SNAPSHOTS: dataDir + '-snapshots.txt',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.channel) child.channel.unref();
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // As long as the tests' own start waits (test/helpers.js, 15 s). Missed, it says how long it waited, whether the server
  // had ended and how, and what it said, and ends it, so a start that never came leaves nothing running.
  const began = Date.now();
  for (let i = 0; i < 150 && !out.includes('is running') && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (!out.includes('is running')) {
    const ended = child.exitCode !== null || child.signalCode !== null ? 'it ended (' + (child.signalCode || 'code ' + child.exitCode) + ')' : 'it was still running, and is ended';
    child.kill();
    throw new Error('server did not start within ' + (Date.now() - began) + ' ms: ' + ended + '; it said:\n' + (out || '(nothing)'));
  }
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-edge-'));
  // A container running as root has no user namespace for Chromium's sandbox; everywhere else the sandbox stays on.
  const sandbox = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
  // Each tab stands for a device of its own (a laptop, a phone, a stage screen) whose page is in front. A page in a hidden
  // tab is frozen by the browser (Edge's sleeping tabs, Chromium's freezing): its screenshot stalls, and Blink fails its
  // WebSockets with "Page entered Back-Forward Cache." on any freeze. So every page has a window of its own (tab(), below)
  // and is visible, which is never frozen; these switches keep the timers and priority of a page that is not focused.
  const awake = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', ...awake, ...sandbox, '--remote-debugging-port=0', '--user-data-dir=' + prof, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  // The browser takes a port of its own and names it in its profile's DevToolsActivePort once it listens, so no port
  // chosen here can be taken by another program first; a cold start on a busy runner has 30 s.
  let version = null;
  let port = 0;
  for (let i = 0; i < 120 && !version; i++) {
    try {
      port = Number((await fs.promises.readFile(path.join(prof, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch { await sleep(250); }
  }
  if (!version) throw new Error('the browser opened no DevTools port in 30 s');
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
     * screen), `timezone` its zone, `headers` HTTP headers every request it makes carries (its WebSocket's included),
     * `alone` a browser of its own (no cookie, sign-in or stored identity of the other tabs': another device).
     */
    async tab(url, { init, workerInit, metrics, timezone, headers, alone } = {}) {
      const own = alone ? (await browser.send('Target.createBrowserContext', {})).result : null;
      if (alone && !own) throw new Error('no browser of its own for ' + url);
      // A window of its own, so its page is always the one in front (never a hidden tab behind another).
      const made = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1400, height: 900, ...(own ? { browserContextId: own.browserContextId } : {}) });
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
        /** `logs`: what the tab's frames wrote with console.log, in order. `context`: its browser's own (`alone`), else ''. */
        problems, send, logs, workers, context: own ? own.browserContextId : '',
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
        close: () => { ws.close(); if (own) browser.send('Target.disposeBrowserContext', { browserContextId: own.browserContextId }); },
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
  // The screen's PDF deadline (display.js PDF_DEADLINE, 20 s) runs here at 1.5 s, so a stuck PDF is failed within the
  // smoke's wait: only that timer, known by its 20 s and what it does; every other timer keeps its own length.
  const later = window.setTimeout;
  window.setTimeout = function (fn, ms, ...rest) { return later.call(this, fn, ms === 20000 && typeof fn === 'function' && String(fn).includes('expired') ? 1500 : ms, ...rest); };
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
// A document page's counters, set before its own scripts: each worker it starts, by its address, and each object URL it
// makes and revokes (a document's pictures are drawn through the page's own, revoked with the document).
const DOC_PROBE = `(() => {
  const workers = window.__docWorkers = [];
  const W = window.Worker;
  window.Worker = class extends W { constructor(u, o) { super(u, o); workers.push(String(u)); } };
  const urls = window.__urls = { made: [], revoked: [] };
  const make = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (b) { const u = make.call(URL, b); urls.made.push(u); return u; };
  URL.revokeObjectURL = function (u) { urls.revoked.push(u); return revoke.call(URL, u); };
})();`;
/** A fixture's bytes (test/fixtures, README there): read as bytes, never as text. */
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
/** An Excel 97-2003 workbook of `rows` (a compound file, never zipped), written by the vendored SheetJS. */
function xlsOf(rows) {
  const vm = require('vm');
  const ctx = vm.createContext({ TextDecoder, TextEncoder });
  vm.runInContext('globalThis.self = globalThis;' + readSource(path.join(__dirname, '..', 'public', 'vendor', 'xlsx.full.min.js')), ctx);
  const book = ctx.XLSX.utils.book_new();
  ctx.XLSX.utils.book_append_sheet(book, ctx.XLSX.utils.aoa_to_sheet(rows), 'Budget');
  return Buffer.from(ctx.XLSX.write(book, { type: 'array', bookType: 'biff8' }));
}
/** Where a JPEG 2000 fixture's yellow rectangle is drawn on its page, as a share of the page's width and height. */
const JPX_YELLOW = { x: 236 / 612, y: 162 / 792 };
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
  const doors = [...document.querySelectorAll('.app-meta [role=button], #headerMore, #feed .msg header button.from, .compose .compose-more')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { door: b.id || b.className, size: Math.round(Math.min(r.width, r.height) * 10) / 10 }; });
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
/** The hall page's console, opened as a person opens it: the header's ⋯, then Screens & pages…. False where it is not offered. */
const OPEN_SCREENS = `(() => { document.getElementById('headerMore').click(); const b = document.querySelector('.agm-menu [data-action="header.screens"]'); if (b) b.click(); else AGM.menu.close(); return !!b; })()`;
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
      // A fold on the bar (📌 Pin ▸) is the menu's fold row, under the same name.
      if (b.dataset.fold) { const f = menu.querySelector(':scope > .agm-mi[data-fold="' + b.dataset.fold + '"]'); rows.push(['fold:' + b.dataset.fold, !!f && b.getAttribute('aria-label') === f.getAttribute('aria-label')]); continue; }
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
/**
 * The doors of an object that is a link of its own (a room: a click opens it, so it has no ⋯): a right-click on it and
 * Shift+F10 on it focused each open the catalogue's set for it, never its row's; the key's menu has the focus on its first
 * enabled item, and Escape gives it back. `facts` is the page's facts, as `doorsOf` reads them.
 */
async function ownLinkDoors(tab, kind, sel, obj, { facts = 'F' } = {}) {
  const out = { want: await tab.eval(`JSON.stringify(AGM.catalog.ids(${codeLiteral(kind)}, ${facts}, ${obj}))`) };
  out.size = await tab.eval(`(() => { const q = (${sel}).getBoundingClientRect(); return Math.round(Math.min(q.width, q.height) * 10) / 10; })()`);
  await rightClick(tab, await middleOf(tab, sel));
  out.right = await tab.until(MENU_IDS, 3000);
  await press(tab, 'Escape');
  out.rightClosed = !!(await tab.until(NO_MENU, 3000));
  await tab.eval(`(${sel}).focus()`);
  await press(tab, 'F10', { shift: true });
  out.key = await tab.until(MENU_IDS, 3000);
  out.keyFirst = await tab.eval(`(() => { const first = [...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].find((b) => b.getAttribute('aria-disabled') !== 'true'); return !!first && document.activeElement === first; })()`);
  await press(tab, 'Escape');
  out.keyBack = !!(await tab.until(`${NO_MENU} && document.activeElement === (${sel})`, 3000));
  return out;
}
const linkInStep = (d) => !!d.want && d.want !== '[]' && d.size >= 24 && d.right === d.want && d.key === d.want && d.rightClosed && d.keyFirst && d.keyBack;
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
      const pdfjs = await (await import('/docview.mjs')).loadPdfJs();
      const doc = await pdfjs.getDocument({ url: up.url, isEvalSupported: false }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
      await new Promise((r) => socket.emit('message', { type: 'file', url: up.url, filename: 'capex.pdf', mime: 'application/pdf' }, r));
      return doc.numPages + '|' + text;
    })()`);
    report(typeof pages === 'string' && pages.startsWith('1|') && pages.includes('Capex'), `pdf.js renders an uploaded PDF and reads its text (${pages})`);
    await research.eval(`new Promise((r) => socket.emit('message', { type: 'text', text: 'Capex is on slide 14' }, r))`);
    await research.eval(`(() => { window.__seenFrames = []; socket.on('seen', (f) => window.__seenFrames.push(f)); })()`);

    // Board: joins, sees the message and the document on stage, on a browser with no Promise.withResolvers.
    const board = await edge.tab(`${base}/app.html?code=${code}&name=Chair&role=board&invite=${inviteOf(dataDir, code)}`, { init: NO_RESOLVERS, workerInit: NO_RESOLVERS });
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
      const h = document.querySelector('#docDisplay .dv .doc-html');
      if (!h) return document.querySelector('#docDisplay .error') ? { error: document.querySelector('#docDisplay .error').textContent } : null;
      const ps = [...h.querySelectorAll('p')].map((p) => p.textContent);
      return ps.length >= 2 ? { ps, strong: h.querySelectorAll('strong, b').length } : null;
    })()`);
    report(!!boardDocx && JSON.stringify(boardDocx.ps) === JSON.stringify(['Board pack', 'Item 4: the capex review']) && boardDocx.strong === 0,
      `a Word file draws on the Board's panel through mammoth 1.13.0 in the document worker, its text as blocks and its inline styling dropped (${JSON.stringify(boardDocx)})`);

    // The readers (docview.mjs over docmodel.mjs and the document worker), in a hall of their own (named to sort after the
    // Outbox hall, whose row the halls board's steps take as its first), on a backstage page and
    // a Board page: each type drawn by its reader, hidden parts on the backstage seat only and marked, Word's pages, the
    // page box, find and the kept place, one pdf.js worker for the page's life, a stuck PDF's deadline, the AI's text on the
    // backstage seat only, a document's pictures through the page's own object URLs, and HTML parsed inert.
    const docTabs = [];
    {
      const docsHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Readers hall' }) })).json()).code;
      const docsR = await edge.tab(`${base}/app.html?code=${docsHall}&name=Rea&role=research`, { init: DOC_PROBE });
      report(!!(await docsR.until('typeof joined !== "undefined" && joined && !!UPLOAD_TOKEN')), 'a backstage page joins the hall of documents');
      const docsB = await edge.tab(`${base}/app.html?code=${docsHall}&name=Bo&role=board&invite=${inviteOf(dataDir, docsHall)}`, { init: DOC_PROBE });
      report(!!(await docsB.until('typeof joined !== "undefined" && joined')), 'a Board page joins it');
      docTabs.push(['documents, backstage', docsR], ['documents, On stage', docsB]);
      docsR.expectFailure(/\/api\/upload$/);   // a paced upload's 429, waited out below, is this step's own
      // Uploads are paced (a burst of 4, then one every 2 s): a refusal to slow down is waited out and sent again.
      const docUp = (name, mime, buf) => docsR.eval(`(async () => {
        const bytes = Uint8Array.from(atob('${buf.toString('base64')}'), (c) => c.charCodeAt(0));
        let up = {};
        for (let i = 0; i < 6; i++) {
          const fd = new FormData(); fd.append('file', new Blob([bytes], { type: '${mime}' }), '${name}');
          const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: { 'X-AGM-Upload': UPLOAD_TOKEN } });
          up = await r.json();
          if (r.status !== 429) break;
          await new Promise((res) => setTimeout(res, 2500));
        }
        if (!up.url) return JSON.stringify(up);
        await new Promise((r) => socket.emit('message', { type: 'file', url: up.url, filename: '${name}', mime: '${mime}' }, r));
        return up.url;
      })()`);
      // A page's way to open a file in its panel and wait for the drawing (the hall's own file messages open themselves too;
      // the newest drawing is the one that stands).
      const OPEN_DOC = `window.__openDoc = async (name) => {
        const end = Date.now() + 30000;
        let m = null;
        while (Date.now() < end && !(m = allMessages.find((x) => x.filename === name))) await new Promise((r) => setTimeout(r, 50));
        if (!m) return { state: 'no message ' + name };
        openDocInPanel(m);
        const n = docDrawing;
        while (Date.now() < end && !(docDrawing === n && docView && docDisplay.querySelector('.dv'))) await new Promise((r) => setTimeout(r, 30));
        if (docDrawing !== n || !docView) return { state: 'not opened' };
        const drawn = await docView.ready;
        return { ...drawn, words: drawn.words || '' };
      };`;
      await docsR.eval(OPEN_DOC);
      await docsB.eval(OPEN_DOC);
      const W_P = (t, extra = '') => '<w:p>' + extra + '<w:r><w:t>' + t + '</w:t></w:r></w:p>';
      const RENDERED = '<w:r><w:lastRenderedPageBreak/></w:r>';
      const wordRendered = officeZip(wordParts({ body: W_P('Minutes of the board') + '<w:p>' + RENDERED + '<w:r><w:t>Item two</w:t></w:r></w:p>' + '<w:p><w:r><w:t>The chart</w:t></w:r>' + wordPicture('rId10', 'Capex chart') + '</w:p>' + '<w:p>' + RENDERED + '<w:r><w:t>Item three</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>SECRETRUN</w:t></w:r></w:p>', pages: 3, media: { 'chart.png': colourPng(48, 24, [0, 160, 0]) } }));
      const wordExplicit = officeZip(wordParts({ body: W_P('First') + '<w:p><w:r><w:br w:type="page"/><w:t>Second</w:t></w:r></w:p>' }));
      const deckFile = officeZip(deckParts([
        { xml: deckSlide(deckShape('Q3 results', { ph: 'title' }) + deckShape(['Revenue up', 'Costs flat'], { ph: 'body' }) + deckShape('HIDDENSHAPE', { hidden: true }) + deckPicture('rId1')), rels: [['rId1', 'image', '../media/chart.png']] },
        { xml: deckSlide(deckShape('HIDDENSLIDE', { ph: 'title' }), '0') },
      ], { 'chart.png': colourPng(48, 24, [0, 0, 160]) }));
      const uploadsOk = [];
      for (const [name, mime, buf] of [
        ['budget.csv', 'text/csv', Buffer.from('Item,Cost\r\nPlant,"4,5"\r\nStaff,2\r\n')],
        ['photo.png', 'image/png', colourPng(64, 36, [255, 0, 0])],
        ['notes.md', 'text/markdown', Buffer.from('# Notes\n\nVisible <!-- SECRETCOMMENT --> words\n\n<span hidden>SECRETSPAN</span> shown\n')],
        ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', officeZip(workbookParts())],
        ['old-budget.xls', 'application/vnd.ms-excel', xlsOf([['Item', 'Cost'], ['Plant', 4]])],
        ['results.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', deckFile],
        ['minutes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', wordRendered],
        ['draft.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', wordExplicit],
        ['pack-tagged.pdf', 'application/pdf', fixture('board-pack-tagged.pdf')],
        ['pack-untagged.pdf', 'application/pdf', fixture('board-pack-untagged.pdf')],
        ['picture-jpx.pdf', 'application/pdf', fixture('jpeg2000.pdf')],
        ['stuck.pdf', 'application/pdf', fixture('board-pack-untagged.pdf')],
      ]) uploadsOk.push([name, /^\/uploads\//.test(await docUp(name, mime, buf))]);
      report(uploadsOk.every(([, ok]) => ok), `the documents are uploaded (${JSON.stringify(uploadsOk)})`);
      const urlOf = (name) => docsR.eval(`allMessages.find((m) => m.filename === '${name}').url`);
      const opened = (tab, name) => tab.eval(`window.__openDoc('${name}')`);
      const DRAWN = `(() => { const d = document.getElementById('docDisplay'); return { text: d.textContent, notice: (d.querySelector('.dv-notice:not([hidden])') || {}).textContent || '' }; })()`;

      // CSV is a grid, a quoted comma one cell's.
      const csvOpen = await opened(docsR, 'budget.csv');
      const csvGrid = await docsR.eval(`[...document.querySelectorAll('#docDisplay table.dv-grid tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))`);
      report(csvOpen.state === 'shown' && JSON.stringify(csvGrid) === JSON.stringify([['Item', 'Cost'], ['Plant', '4,5'], ['Staff', '2']]), `a CSV is drawn as a grid (${JSON.stringify({ csvOpen, csvGrid })})`);

      // Markdown: its comment and its hidden raw HTML are not drawn.
      const mdOpen = await opened(docsR, 'notes.md');
      const md = await docsR.eval(DRAWN);
      report(mdOpen.state === 'shown' && /Notes/.test(md.text) && /Visible\s+words/.test(md.text) && /shown/.test(md.text) && !/SECRETCOMMENT|SECRETSPAN/.test(md.text), `a Markdown file is drawn without its comment or its hidden raw HTML (${JSON.stringify({ mdOpen, text: md.text.slice(0, 200) })})`);

      // A picture: drawn from its bytes through the page's own object URL, with the zoom.
      const imgOpen = await opened(docsR, 'photo.png');
      const imgSeen = await docsR.eval(`(() => { const i = document.querySelector('#docDisplay img.dv-img'); return i && { own: i.src.startsWith('blob:') && window.__urls.made.includes(i.src), w: i.naturalWidth, zoom: [...document.querySelectorAll('#docDisplay .dv-zoom button')].map((b) => b.textContent) }; })()`);
      await docsR.eval(`document.querySelector('#docDisplay .dv-zoom button:last-child').click()`);
      const zoomed = await docsR.eval(`document.querySelector('#docDisplay img.dv-img').getBoundingClientRect().width`);
      report(imgOpen.state === 'shown' && !!imgSeen && imgSeen.own && imgSeen.w === 64 && JSON.stringify(imgSeen.zoom) === JSON.stringify(['−', 'Fit width', 'Fit page', '+']) && zoomed > 64,
        `a picture is drawn from its bytes through the page's own object URL, with − Fit width Fit page + (${JSON.stringify({ imgOpen, imgSeen, zoomed })})`);

      // An Excel file reads in the document worker: on the backstage seat its hidden row, column and sheets drawn marked, a
      // formula with no saved value said so, and the AI's text without them; on the Board's, none of them, and how many.
      const xlsxR = await opened(docsR, 'budget.xlsx');
      const xlsxRSeen = await docsR.until(`docForAi.text && JSON.stringify({ workers: window.__docWorkers.filter((u) => /docworker\\.js$/.test(u)).length, hiddenRow: !!document.querySelector('#docDisplay tr.dv-hidden'), hiddenCol: [...document.querySelectorAll('#docDisplay th.dv-hidden')].map((t) => t.textContent), noValue: [...document.querySelectorAll('#docDisplay td.dv-novalue')].map((t) => t.textContent), tabs: [...document.querySelectorAll('#docDisplay .sheet-tab')].map((t) => t.textContent), ai: docForAi.text })`);
      const xr = JSON.parse(xlsxRSeen || 'null');
      report(xlsxR.state === 'shown' && !!xr && xr.workers >= 1 && xr.hiddenRow && JSON.stringify(xr.hiddenCol) === JSON.stringify(['B hidden']) && JSON.stringify(xr.noValue) === JSON.stringify(['formula — no saved value'])
        && JSON.stringify(xr.tabs) === JSON.stringify(['Budget', 'Salaries (hidden)', 'Old (hidden)']) && /Item/.test(xr.ai) && !/SECRET|VERYHIDDEN|JUSTHIDDEN/.test(xr.ai),
      `an Excel file reads through the document worker: on the backstage seat its hidden parts drawn marked, a formula with no saved value said, the AI's text without them (${JSON.stringify({ xlsxR, xr })})`);
      const xlsxB = await opened(docsB, 'budget.xlsx');
      const xb = await docsB.eval(`(() => { const d = document.getElementById('docDisplay'); return { text: d.textContent, notice: (d.querySelector('.dv-notice') || {}).textContent, rows: d.querySelectorAll('tbody tr').length, ai: docForAi.text }; })()`);
      report(xlsxB.state === 'shown' && !/SECRET|VERYHIDDEN|JUSTHIDDEN|Salaries|hidden\)/.test(xb.text.replace(xb.notice, '')) && xb.notice === '2 hidden sheets not shown 1 hidden row and 1 hidden column not shown' && xb.rows === 2 && xb.ai === '',
        `on the Board's seat the same file draws no hidden sheet, row or column, says how many, and fills no AI text (${JSON.stringify({ xlsxB, xb })})`);

      // An Excel 97-2003 file (a compound file, never zipped) reads in the same worker under the same policy.
      const xlsR = await opened(docsR, 'old-budget.xls');
      const xlsGrid = await docsR.eval(`[...document.querySelectorAll('#docDisplay table.dv-grid tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))`);
      report(xlsR.state === 'shown' && JSON.stringify(xlsGrid) === JSON.stringify([['Item', 'Cost'], ['Plant', '4']]), `an Excel 97-2003 file reads through the document worker (${JSON.stringify({ xlsR, xlsGrid })})`);

      // PowerPoint: an outline, its hidden shape never read; its hidden slide drawn marked backstage, absent on the Board.
      const pptR = await opened(docsR, 'results.pptx');
      const pr = await docsR.eval(`(() => ({ slides: [...document.querySelectorAll('#docDisplay .dv-slide')].map((s) => s.querySelector('.dv-slidemark').textContent), text: document.getElementById('docDisplay').textContent, img: document.querySelectorAll('#docDisplay img.dv-pic').length }))()`);
      const pptB = await opened(docsB, 'results.pptx');
      const pb = await docsB.eval(DRAWN);
      report(pptR.state === 'shown' && JSON.stringify(pr.slides) === JSON.stringify(['Slide 1', 'Slide 2 — hidden slide']) && /Q3 results/.test(pr.text) && /Revenue up/.test(pr.text) && !/HIDDENSHAPE|PRESENTERNOTE/.test(pr.text) && pr.img === 1
        && pptB.state === 'shown' && !/HIDDENSLIDE|HIDDENSHAPE/.test(pb.text) && pb.notice === '1 hidden slide not shown',
      `a PowerPoint file shows its outline, its hidden shape never read, its hidden slide marked backstage and not on the Board (${JSON.stringify({ pptR, pr, pptB, pb })})`);

      // Word: converted in the worker, its pages from its own breaks ("p. 1 of 3"; "≈ p. 1 of ≈ 2" from explicit breaks
      // alone), the hidden run nowhere, its picture through an object URL the page made and revoked with the document.
      const docxR = await opened(docsR, 'minutes.docx');
      const dr = JSON.parse(await docsR.until(`docForAi.text && JSON.stringify({ words: docView.placeWords(), text: document.getElementById('docDisplay').textContent, ai: docForAi.text,
        pics: [...document.querySelectorAll('#docDisplay img')].map((i) => i.src), made: window.__urls.made.slice(), blobs: [...document.querySelectorAll('#docDisplay [src^="blob:"]')].map((n) => n.getAttribute('src')) })`) || 'null');
      await docsR.eval(`docView.goto({ page: 3 })`);
      const third = await docsR.until(`docView.placeWords() === 'p. 3 of 3' && docView.placeWords()`, 5000);
      await docsR.eval(`dismissDoc()`);
      const revoked = await docsR.eval(`window.__urls.revoked.slice()`);
      report(docxR.state === 'shown' && !!dr && dr.words === 'p. 1 of 3' && third === 'p. 3 of 3' && !/SECRETRUN/.test(dr.text) && !/SECRETRUN/.test(dr.ai) && /— p\. 2 —/.test(dr.ai) && /— p\. 3 —/.test(dr.ai)
        && dr.pics.length === 1 && dr.pics[0].startsWith('blob:') && dr.made.includes(dr.pics[0]) && dr.blobs.every((b) => dr.made.includes(b)) && revoked.includes(dr.pics[0]),
      `a Word file converts in the worker: its page box reads "p. 1 of 3" from Word's rendered breaks and goes to p. 3, the hidden run is not drawn nor in the AI's text (marked by page), and its picture is the page's own object URL, revoked with the document (${JSON.stringify({ docxR, dr: dr && { ...dr, text: dr.text.slice(0, 80) }, third, revokedPic: dr && revoked.includes(dr.pics[0]) })})`);
      const draftR = await opened(docsR, 'draft.docx');
      const draftWords = await docsR.eval(`docView.placeWords()`);
      report(draftR.state === 'shown' && draftWords === '≈ p. 1 of ≈ 2', `a Word file with only explicit page breaks reads "≈ p. 1 of ≈ 2" (${JSON.stringify({ draftR, draftWords })})`);

      // PDFs: one pdf.js worker serves several documents and each one closed is destroyed; the AI's text on the backstage
      // seat only; the page box keeps its page across a resize; find moves to a match on a page not yet drawn; a JPEG 2000
      // picture draws.
      const PAGE_DRAWN = (n) => `(() => { const c = document.querySelector('#docDisplay .dv-page[data-page="${n}"] canvas'); return !!c && !c.classList.contains('pdf-page-pending'); })()`;
      const pdfOpens = [];
      for (const name of ['pack-tagged.pdf', 'pack-untagged.pdf', 'pack-tagged.pdf']) pdfOpens.push((await opened(docsR, name)).state);
      const pdfAi = await docsR.until(`/Quorum|quorum/.test(docForAi.text) && docForAi.text.slice(0, 30)`);
      const pdfOne = await docsR.eval(`(async () => (await import('/docview.mjs')).pdfState())()`);
      const pdfWorkers = await docsR.eval(`window.__docWorkers.filter((u) => /pdf\\.worker\\.min\\.mjs/.test(u)).length`);
      report(pdfOpens.every((x) => x === 'shown') && pdfOne.workers === 1 && pdfOne.open === 1 && pdfWorkers === 1 && /^\[page 1\]/.test(pdfAi || ''),
        `one pdf.js worker serves several PDFs, each one closed destroyed, and the AI's text is the PDF's, by page (${JSON.stringify({ pdfOpens, pdfOne, pdfWorkers, pdfAi })})`);
      const pdfB = await opened(docsB, 'pack-tagged.pdf');
      await sleep(600);
      const pdfBAi = await docsB.eval(`docForAi.text`);
      report(pdfB.state === 'shown' && pdfBAi === '', `the Board's seat draws the PDF and reads no AI text from it (${JSON.stringify({ pdfB, pdfBAi })})`);
      await docsR.eval(`docView.goto({ page: 4 })`);
      const atFour = await docsR.until(`docView.place().page === 4 && docView.placeWords()`, 5000);
      await docsR.resize(1100, 820);
      await sleep(900);
      const keptPlace = await docsR.until(`docView.place().page === 4 && ${PAGE_DRAWN(4)} && docView.placeWords()`, 8000);
      await docsR.resize(1400, 900);
      await sleep(600);
      report(atFour === 'p. 4 of 6' && keptPlace === 'p. 4 of 6', `the page box keeps its page across a resize (${JSON.stringify({ atFour, keptPlace })})`);
      // And across a collapse: folded away the view is left as it was, its place standing, and opened again it goes back.
      await docsR.eval(`docView.goto({ page: 4 })`);
      await docsR.until(`docView.place().page === 4`, 5000);
      await docsR.eval(`setStageCollapsed(true)`);
      await sleep(600);
      const folded = await docsR.eval(`({ page: docView.place().page, shown: document.getElementById('docDisplay').getBoundingClientRect().width > 0 })`);
      await docsR.eval(`setStageCollapsed(false)`);
      await sleep(900);
      const unfolded = await docsR.until(`docView.place().page === 4 && ${PAGE_DRAWN(4)} && docView.placeWords()`, 8000);
      report(folded.page === 4 && !folded.shown && unfolded === 'p. 4 of 6', `the page box keeps its page across a collapse of the panel and its opening again (${JSON.stringify({ folded, unfolded })})`);
      // Opened afresh, at its first page: page 5 is not drawn until find goes there.
      await opened(docsR, 'pack-untagged.pdf');
      await docsR.until(`docView.place().page === 1 && ${PAGE_DRAWN(1)}`, 8000);
      const fiveBefore = await docsR.eval(PAGE_DRAWN(5));
      const found = await docsR.eval(`docView.find('quorum')`);
      const fiveAfter = await docsR.until(`docView.place().page === 5 && ${PAGE_DRAWN(5)} && document.querySelector('#docDisplay .dv-found').textContent`, 8000);
      report(fiveBefore === false && !!found && found.page === 5 && !!fiveAfter, `find moves to a match on a page not yet drawn, and draws it (${JSON.stringify({ fiveBefore, found, fiveAfter })})`);
      const JPX_PIXEL = (sel) => `(() => { const c = document.querySelector('${sel}'); if (!c || !c.width || c.classList.contains('pdf-page-pending')) return null;
        const p = c.getContext('2d').getImageData(Math.floor(c.width * ${JPX_YELLOW.x}), Math.floor(c.height * ${JPX_YELLOW.y}), 1, 1).data; return [p[0], p[1], p[2]]; })()`;
      const jpxOpen = await opened(docsR, 'picture-jpx.pdf');
      const jpxPanel = await docsR.until(`(() => { const p = ${JPX_PIXEL('#docDisplay .dv-page[data-page="1"] canvas')}; return p && p[0] > 200 && p[1] > 150 && p[2] < 110 ? p : null; })()`, 10000);
      report(jpxOpen.state === 'shown' && !!jpxPanel, `a JPEG 2000 picture in a PDF draws on the panel: pdf.js's worker may run WebAssembly (${JSON.stringify({ jpxOpen, jpxPanel })})`);

      // A stuck PDF: its first page not drawn by its deadline, it is failed with words, the shared worker is destroyed with
      // it, and the next PDF makes a new one and draws.
      const stuckUrl = await urlOf('stuck.pdf');
      docsR.expectFailure(/stuck\.pdf$/);
      await docsR.hold('*stuck.pdf*', 6000);
      const stuck = await docsR.eval(`(async () => {
        const mod = await import('/docview.mjs');
        const before = mod.pdfState().workers;
        const box = document.createElement('div');
        document.body.appendChild(box);
        const v = mod.open(box, { url: '${stuckUrl}' }, { seat: 'research', name: 'stuck.pdf', deadline: 1500 });
        const r = await v.ready;
        v.destroy(); box.remove();
        return { r, before, after: mod.pdfState() };
      })()`);
      await docsR.release();
      const afterStuck = await opened(docsR, 'pack-untagged.pdf');
      const newWorker = await docsR.eval(`(async () => (await import('/docview.mjs')).pdfState())()`);
      report(stuck.r.state === 'failed' && stuck.r.words === 'the file took too long to read' && stuck.after.workers === stuck.before && afterStuck.state === 'shown' && newWorker.workers === stuck.before + 1,
        `a PDF whose first page is not drawn by its deadline fails with its words and takes the shared worker with it; the next PDF makes a new one and draws (${JSON.stringify({ stuck, afterStuck, newWorker })})`);

      // HTML is parsed inert: nothing in it runs, loads or applies, and what comes back is plain data. The HTML carries
      // one inline handler of its own; a browser may still try it from the template's content, and the page's policy refuses
      // it: that one refusal, in the probe's own window, is the probe's and not the page's, so it is said here and taken off
      // this tab's problems; any other stays one.
      const beforeInert = docsR.problems.length;
      const inert = await docsR.eval(`(async () => {
        const tried = [];
        const heard = (e) => tried.push(e.effectiveDirective + ' ' + e.blockedURI);
        document.addEventListener('securitypolicyviolation', heard);
        const m = await import('/docmodel.mjs');
        const r = m.parseInert('<meta http-equiv="refresh" content="0;url=/halls.html"><style>body{display:none}</style><script>window.__ran=1</script><p>Shown <span hidden>SECRETA</span><span style="display:none">SECRETB</span><b style="visibility:hidden">SECRETC</b></p><template>SECRETD</template><noscript>SECRETE</noscript><img src="/x.png" onerror="window.__ran=2">');
        await new Promise((res) => setTimeout(res, 300));
        document.removeEventListener('securitypolicyviolation', heard);
        return { blocks: structuredClone(r.blocks), ran: window.__ran || 0, metas: document.querySelectorAll('meta[http-equiv]').length, shown: getComputedStyle(document.body).display !== 'none', path: location.pathname, tried };
      })()`);
      const probesOwn = (x) => /^log: Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''/.test(x);
      const refusedAt = docsR.problems.findIndex((x, i) => i >= beforeInert && probesOwn(x));
      inert.refused = refusedAt >= 0 ? docsR.problems.splice(refusedAt, 1).length : 0;
      report(JSON.stringify(inert.blocks) === JSON.stringify([{ kind: 'p', text: 'Shown', at: { block: 1 } }]) && inert.ran === 0 && inert.metas === 0 && inert.shown && inert.path === '/app.html'
        && inert.tried.every((t) => /^script-src(-attr)? inline$/.test(t)),
        `parseInert reads HTML through an inert template into plain data: no script ran (its one handler tried by this browser ${inert.refused} time(s), refused by the page's policy), no refresh or style reached the page, hidden text left out (${JSON.stringify(inert)})`);
    }

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
    await emit(ben, 'join', { roomCode: phoneHall, name: 'Ben', role: 'board', invite: inviteOf(dataDir, phoneHall) });
    // Sent at the pace a socket may write (its burst spent, a "busy" answer is tried again a moment later).
    const post = async (s, args) => { for (let i = 0; i < 60; i++) { const r = await emit(s, 'message', args); if (r && r.ok) return r; await sleep(250); } return null; };
    await post(ben, { type: 'text', text: 'From the stage: is slide 14 the one?' });
    for (let i = 1; i <= 30; i++) await post(pat, { type: 'text', text: 'Backstage note ' + i + (i % 6 === 0 ? ': Aktiengesellschaftsrechtsänderungsgesetzbestimmungen' : '') });
    await post(pat, { type: 'action', text: 'Refer them to slide 14?', options: ['Yes', 'No', 'Defer'] });
    await post(pat, { type: 'text', text: 'Mic 2 is off', priority: true });
    const phones = {};
    for (const [seat, name] of [['board', 'Bea'], ['research', 'Rob'], ['observer', 'Oli']]) {
      phones[seat] = await edge.tab(`${base}/app.html?code=${phoneHall}&name=${name}&role=${seat}${seat === 'board' ? '&invite=' + inviteOf(dataDir, phoneHall) : ''}`, { init: INK, metrics: PHONE });
      await phones[seat].until(`typeof joined !== "undefined" && joined && allMessages.some((m) => m.priority)`);
    }
    // Bea's page draws the simple view by her seat; this pass reads the full view On stage, which the admin's Chat view
    // gives her (moved on purpose: the Board's chat view has its own pass, below). Told live, with no reload.
    const phoneAdmin = await connect(base, cookie);
    const beaSid = (await emit(phoneAdmin, 'admin:watchRoom', { roomCode: phoneHall })).users.find((u) => u.name === 'Bea').socketId;
    const beaFull = await emit(phoneAdmin, 'admin:setView', { roomCode: phoneHall, socketId: beaSid, view: 'full' });
    const beaFullNow = await phones.board.until(`document.body.dataset.view === 'full' && F.view === 'full' && 'full'`);
    report(!!beaFull && beaFull.ok && beaFullNow === 'full', `the admin's Chat view gives an On stage page the full view, live (${JSON.stringify(beaFull)})`);
    phoneAdmin.close();
    for (const [seat, tab] of Object.entries(phones)) await readOldWords('the hall page on a phone, ' + { board: 'On stage', research: 'Backstage', observer: 'Observer' }[seat], tab);
    const hallDeck = JSON.parse(await phones.board.eval(`JSON.stringify({ chip: document.querySelector('.app-title strong').textContent, people: document.querySelector('#peoplePanel h3').textContent,
      placeholder: document.getElementById('directorInput').placeholder, label: document.getElementById('directorInput').getAttribute('aria-label') })`));
    // Backstage: the message goes to the Board, a file is attached with 📎 (no File tab), and the panel is the Preview.
    const backDeck = JSON.parse(await phones.research.eval(`JSON.stringify({ ask: document.querySelector('#actionPane .field > span').textContent,
      askBtn: document.querySelector('#actionPane .send-icon').textContent + ' ' + document.querySelector('#actionPane .send-word').textContent, placeholder: document.getElementById('textInput').placeholder, attach: document.getElementById('attachBtn').getAttribute('aria-label'), fileTab: !!document.querySelector('.compose-tabs .tab[data-tab="file"]'),
      panelTitle: document.getElementById('docPanelTitle').textContent, panel: document.querySelector('#docDisplay .empty-state .hint').textContent })`));
    report(JSON.stringify(hallDeck) === JSON.stringify({ chip: 'Phone hall', people: 'In this room', placeholder: 'Message everyone here…', label: 'Message everyone here…' })
      && JSON.stringify(backDeck) === JSON.stringify({ ask: 'Question for the Board', askBtn: '❓ Ask the Board', placeholder: 'Type a message to the Board…', attach: 'Attach a file…', fileTab: false, panelTitle: '👁 Preview — the Board does not see this',
        panel: 'Attach a file (📎) or open one with Preview to page through it, then show the Board a picture of a page or the document.' }),
      `the hall page says room, the Board and the backstage team: the header names the room, "In this room", "Message everyone here…", "Question for the Board" asked with "❓ Ask the Board", "Type a message to the Board…", 📎 in the message row and the panel the Preview (${JSON.stringify({ hallDeck, backDeck })})`);
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
      // The doors that are not buttons by look (the header's ⋯, a sender's name, the composer's ⋯): 44 px under a finger
      // too; every seat has the header's ⋯, and a seat that writes in the full view the composer's ⋯.
      const chipOk = light.doors.some((d) => d.door === 'headerMore');
      const doorsOk = light.doors.every((d) => d.size >= 44) && chipOk && (!writes || !light.full || light.doors.some((d) => /compose-more/.test(d.door)));
      report(light.fits && dark.fits && Array.isArray(dialogs) && dialogs.length === 4 && dialogs.every((d) => d.buttons > 0 && d.missed.length === 0) && (dialogs[0].via === 'Help') === writes &&
        sendOk && light.coarse && light.header >= 44 && doorsOk,
        `the hall page fits a 390 px phone as ${seat}: no wider than the screen (${light.width}), every dialog's buttons on the screen and reached by a tap, Send a 44 px button named for where it sends, the header's controls and the doors (the header's ⋯, a sender's name, the composer's ⋯) 44 px under a finger (${JSON.stringify({ dialogs, send: light.send, header: light.header, doors: light.doors })})`);
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
    // The join page asks for the code first: once six characters are still (half a second, or Enter, or leaving the field)
    // it names the room the code opens and offers that room's seats only — a hall's Main room Backstage and Observer (On
    // stage only from an On stage invite link), a side room Member and Observer — with none chosen on a first visit; a code
    // no room has is said at the field; and each value is looked up once, a corrected sixth character once more. The
    // lookups are answered here (a stand-in for /api/rooms/), so no miss counts against this address's code lock, which
    // later legs join through.
    await signin.eval(`(() => { try { localStorage.removeItem('agm.role'); } catch { /* none kept */ } })()`);
    const codeFirst = await signin.eval(`(async () => {
      const real = AGM.api;
      const asked = [];
      const rooms = { K7P2QX: { exists: true, name: 'Hall 2', hallName: 'Hall 2', main: true, locked: false }, LGL234: { exists: true, name: 'Legal', hallName: 'Hall 2', main: false, locked: false } };
      AGM.api = async (method, url, ...rest) => {
        if (!url.startsWith('/api/rooms/')) return real(method, url, ...rest);
        const c = url.slice('/api/rooms/'.length);
        asked.push(c);
        return { status: 200, code: c, ...(rooms[c] || { exists: false, name: '', locked: false }) };
      };
      const tick = (ms) => new Promise((r) => { setTimeout(r, ms); });
      const code = document.getElementById('code');
      const type = (v) => { code.value = v; code.dispatchEvent(new Event('input', { bubbles: true })); };
      const shown = (id) => (document.getElementById(id).hidden ? '' : document.getElementById(id).textContent);
      const state = () => ({ line: shown('roomLine'), miss: shown('codeError'), hint: shown('seatHint'), chosen: (document.querySelector('input[name="role"]:checked') || {}).value || '',
        seats: document.getElementById('seatSet').hidden ? [] : [...document.querySelectorAll('#seatSet .role-option')].filter((o) => !o.hidden).map((o) => o.querySelector('strong').textContent) });
      try {
        type('K7P2Q'); await tick(700); const five = state();
        type('K7P2QY'); await tick(150); const typing = { ...state(), asked: asked.length };
        await tick(650); const wrong = state();
        type('K7P2QX'); await tick(800); const main = state();
        code.dispatchEvent(new Event('change', { bubbles: true })); await tick(100);
        type('LGL234'); code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(150); const side = state();
        return JSON.stringify({ hint: document.getElementById('codeHint').textContent, attrs: [code.autocomplete, code.getAttribute('enterkeyhint'), getComputedStyle(code).fontSize], five, typing, wrong, main, side, asked });
      } finally { AGM.api = real; code.value = ''; document.getElementById('seatSet').hidden = true; }
    })()`);
    const none = { line: '', miss: '', hint: '', chosen: '', seats: [] };
    report(codeFirst === JSON.stringify({
      hint: 'A room\'s 6-character code.', attrs: ['off', 'go', '16px'], five: none, typing: { ...none, asked: 0 },
      wrong: { ...none, miss: 'No hall or room has that code. Check it with whoever gave it to you.' },
      main: { line: 'Hall 2', miss: '', hint: 'On stage seats come with an invite link from the backstage team.', chosen: '', seats: ['Backstage', 'Observer'] },
      side: { line: 'Legal · Hall 2', miss: '', hint: '', chosen: '', seats: ['Member', 'Observer'] },
      asked: ['K7P2QY', 'K7P2QX', 'LGL234'],
    }), `the join page asks for the code first and looks it up once it is still, once per value: it names the room, offers that room's seats only (no On stage without an invite link), none chosen on a first visit, and says a wrong code at the field (${codeFirst})`);
    // From an On stage invite link, On stage is offered and chosen; a remembered On stage seat, with no link, falls back to
    // Observer with the words that say how On stage seats are given. Both look up a real hall's code (no miss).
    const seatsOn = (tab) => tab.until(`(() => { const s = document.getElementById('seatSet'); return !s.hidden && JSON.stringify({ line: document.getElementById('roomLine').textContent, seats: [...s.querySelectorAll('.role-option')].filter((o) => !o.hidden).map((o) => o.querySelector('strong').textContent), chosen: (document.querySelector('input[name="role"]:checked') || {}).value || '', hint: document.getElementById('seatHint').hidden ? '' : document.getElementById('seatHint').textContent }); })()`, 8000);
    const invitedTab = await edge.tab(`${base}/?code=${code}&role=board&invite=smoke-invite`);
    const invited = await seatsOn(invitedTab);
    invitedTab.close();
    await signin.eval(`(() => { try { localStorage.setItem('agm.role', 'board'); } catch { /* none kept */ } })()`);
    const rememberedTab = await edge.tab(`${base}/?code=${code}`);
    const remembered = await seatsOn(rememberedTab);
    rememberedTab.close();
    await signin.eval(`(() => { try { localStorage.removeItem('agm.role'); } catch { /* none kept */ } })()`);
    report(invited === JSON.stringify({ line: 'Smoke AGM', seats: ['On stage', 'Backstage', 'Observer'], chosen: 'board', hint: '' })
      && remembered === JSON.stringify({ line: 'Smoke AGM', seats: ['Backstage', 'Observer'], chosen: 'observer', hint: 'On stage seats come with an invite link from the backstage team.' }),
    `On stage is offered from an On stage invite link alone, and a remembered On stage seat falls back to Observer, said (${invited}; ${remembered})`);
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
    // A help request in a hall's side room is on the board by its hall and its room ("Side asks › Legal"), counted on the
    // hall's row, its way in the room's own (Open its room), and its doors as a Main room's. That hall goes again once read.
    const helpHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Side asks' }) })).json()).code;
    const helpAsker = await connect(base, cookie);
    const helpRoom = await emit(helpAsker, 'room:create', { hall: helpHall, name: 'Legal' });
    // The laptop's token admin's own page, which has no account, joins any room by its key.
    const helpRoomIn = helpRoom && helpRoom.ok ? await emit(helpAsker, 'join', { roomCode: helpRoom.key, name: 'Ana', role: 'research' }) : null;
    const helpInRoom = helpRoomIn && helpRoomIn.ok ? await emit(helpAsker, 'message', { type: 'help', category: 'Vision', text: 'the Legal screen is dark' }) : null;
    const ROOM_HELP = `[...document.querySelectorAll('#helpList > li[data-key]')].find((li) => li.textContent.includes('the Legal screen is dark'))`;
    const roomHelpSeen = (await signin.until(`(() => { const li = ${ROOM_HELP}; const c = document.querySelector('.hall-row[data-code="${helpHall}"] .help-count'); return li && c && JSON.stringify({ where: li.querySelector('.help-where').textContent, count: c.textContent, open: li.querySelector('.help-open').textContent, hidden: li.querySelector('.help-open').hidden, code: new URL(li.querySelector('.help-open').href).searchParams.get('code') }); })()`)) || 'not drawn';
    const roomHelpDoors = roomHelpSeen === 'not drawn' ? { want: 'not drawn' } : await doorsOf(signin, 'help', ROOM_HELP, `AGM.page.object('help', (${ROOM_HELP}).dataset.key)`, { ...PAGE_DOORS_HALLS, hit: '.help-what' });
    report(!!(helpInRoom && helpInRoom.ok) && roomHelpSeen === JSON.stringify({ where: 'Side asks › Legal', count: '■ 1 needs help', open: 'Open its room', hidden: false, code: helpRoom.key }) && doorsInStep(roomHelpDoors) && roomHelpDoors.want === JSON.stringify(['help.respond', 'help.resolve', 'help.open']),
      `a side room's help request reads "Side asks › Legal" on the board, counted on its hall's row, opened by Open its room, its doors in step (${roomHelpSeen}; ${roomHelpDoors.want}; made ${JSON.stringify(helpRoom)}, joined ${JSON.stringify(helpRoomIn && { ok: helpRoomIn.ok, error: helpRoomIn.error })}, asked ${JSON.stringify(helpInRoom)})`);
    helpAsker.close();
    const helpCloser = await connect(base, cookie);
    const helpHallGone = await emit(helpCloser, 'admin:deleteRoom', { roomCode: helpHall, purgeFiles: false });
    helpCloser.close();
    report(!!(helpHallGone && helpHallGone.ok && (await signin.until(`!document.querySelector('.hall-row[data-code="${helpHall}"]') && !(${ROOM_HELP})`))), 'the hall made for the side room\'s request goes again, its request with it');
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
    // A hall's Set up holds its rooms (kind adminRoom, as the admin page's list): the Main room and each room beside it,
    // each with its code and its ⋯; + Add room is the Main room's New room in this hall…, and what is done there is done
    // at once. Here the admin, who manages accounts and sets halls up: the Main room offers a room made in it, Board
    // members… and its code; a room beside it its members, its code, Rename… and Remove room…. A room made there is a
    // room button on the hall's row of the board, a real link into the room with the seat the server gives.
    const SETUP_ROW = (key) => `document.querySelector('#setupRooms > li[data-key="${key}"]')`;
    await signin.eval(`document.querySelector('.hall-row[data-code="${code}"] .obj-more').click()`);
    await signin.until(`!!document.querySelector('.agm-menu [data-action="hall.setup"]')`, 3000);
    await signin.eval(`document.querySelector('.agm-menu [data-action="hall.setup"]').click()`);
    const setupMain = await signin.until(`document.getElementById('setupDialog').open && (() => { const li = ${SETUP_ROW(code)}; return li && JSON.stringify({ name: li.querySelector('.setup-room-name').textContent, code: li.querySelector('.setup-room-code').textContent.split(' · ')[0], add: !document.getElementById('setupAddRoom').hidden, words: document.getElementById('setupRoomsWords').textContent.includes('Its members are chosen on the Accounts page, or with Members… on its ⋯') }); })()`, 5000);
    const mainSetupDoors = await doorsOf(signin, 'adminRoom', SETUP_ROW(code), `AGM.page.object('adminRoom', '${code}')`, { ...PAGE_DOORS_HALLS, hit: '.setup-room-name' });
    await signin.eval(`document.getElementById('setupAddRoom').click()`);
    const addAsk = await signin.until(`(() => { const a = document.querySelector('.agm-ask'); const i = a && a.querySelector('input[name="name"]'); return !!i && document.activeElement === i && a.querySelector('.agm-ask-title').textContent; })()`, 3000);
    await signin.eval(`(() => { document.querySelector('.agm-ask input[name="name"]').value = 'Press'; document.querySelector('.agm-ask [data-answer=yes]').click(); })()`);
    const pressKey = await signin.until(`(() => { const li = [...document.querySelectorAll('#setupRooms > li[data-key]')].find((x) => x.querySelector('.setup-room-name').textContent === 'Press'); return li && li.dataset.key; })()`, 5000);
    const pressMade = await signin.eval(`JSON.stringify({ toast: (document.getElementById('agmToast') || {}).textContent, code: /^code [A-Z2-9]{6} \\(off\\)$/.test(${SETUP_ROW(pressKey)}.querySelector('.setup-room-code').textContent), order: [...document.querySelectorAll('#setupRooms > li[data-key]')].map((li) => li.dataset.key) })`);
    const pressDoors = await doorsOf(signin, 'adminRoom', SETUP_ROW(pressKey), `AGM.page.object('adminRoom', '${pressKey}')`, { ...PAGE_DOORS_HALLS, hit: '.setup-room-name' });
    // Turn the code on asks nothing, and the row says the code with no "(off)".
    await signin.eval(`${SETUP_ROW(pressKey)}.querySelector('.obj-more').click()`);
    await signin.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.codeToggle"]')`, 3000);
    await signin.eval(`document.querySelector('.agm-menu [data-action="adminRoom.codeToggle"]').click()`);
    const pressOn = await signin.until(`(() => { const t = ${SETUP_ROW(pressKey)}.querySelector('.setup-room-code').textContent; return /^code [A-Z2-9]{6}$/.test(t) && (document.getElementById('agmToast') || {}).textContent; })()`, 5000);
    // May send in… (the admin's), over Set up: every hall's rooms by hall, Press itself listed and never offered, a ↔
    // offered only beside a tick. The Main room ticked with its ↔ and saved: one save, said, and each room's row in Set up
    // says which rooms may send into it. Opened again, the Main room is drawn both ways; unticked, its ↔ stays as it is
    // and offered, since Press sends into it now (what is drawn is what a save keeps), and Cancel saves nothing.
    const SENDS_ROW = (key) => `document.querySelector('#sendsList li.sends-row[data-key="${key}"]')`;
    await signin.eval(`${SETUP_ROW(pressKey)}.querySelector('.obj-more').click()`);
    await signin.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.sendFrom"]')`, 3000);
    await signin.eval(`document.querySelector('.agm-menu [data-action="adminRoom.sendFrom"]').click()`);
    const pickerSeen = await signin.until(`(() => { const d = document.getElementById('sendsDialog'); const me = ${SENDS_ROW(pressKey)}; const main = ${SENDS_ROW(code)}; return !!d && d.open && !!me && !!main && JSON.stringify({ title: document.getElementById('sendsTitle').textContent, halls: document.querySelectorAll('#sendsList legend').length > 0, me: [me.querySelector('input.sends-on').disabled, !!me.querySelector('input.sends-back')], main: [main.querySelector('input.sends-on + span').textContent, main.querySelector('input.sends-on').checked, main.querySelector('input.sends-back').disabled] }); })()`, 5000);
    await signin.eval(`${SENDS_ROW(code)}.querySelector('input.sends-on').click()`);
    const backOffered = await signin.eval(`!${SENDS_ROW(code)}.querySelector('input.sends-back').disabled`);
    await signin.shot(path.join(OUT, 'may-send-in.png'));
    await signin.eval(`(() => { ${SENDS_ROW(code)}.querySelector('input.sends-back').click(); document.getElementById('sendsSave').click(); })()`);
    const sendsSaid = await signin.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; const p = ${SETUP_ROW(pressKey)}.querySelector('.setup-room-sends').textContent; const m = ${SETUP_ROW(code)}.querySelector('.setup-room-sends').textContent; return !document.getElementById('sendsDialog').open && /^Saved/.test(t) && !!p && !!m && JSON.stringify({ t, p, m }); })()`, 5000);
    await signin.eval(`${SETUP_ROW(pressKey)}.querySelector('.obj-more').click()`);
    await signin.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.sendFrom"]')`, 3000);
    await signin.eval(`document.querySelector('.agm-menu [data-action="adminRoom.sendFrom"]').click()`);
    const BOTH = (key) => `(() => { const r = ${SENDS_ROW(key)}; const b = r.querySelector('input.sends-back'); return JSON.stringify({ on: r.querySelector('input.sends-on').checked, back: b.checked, offered: !b.disabled }); })()`;
    const drawnAgain = await signin.until(`document.getElementById('sendsDialog').open && !!${SENDS_ROW(code)} && ${BOTH(code)}`, 5000);
    await signin.eval(`${SENDS_ROW(code)}.querySelector('input.sends-on').click()`);
    const untickedKeeps = await signin.eval(BOTH(code));
    await signin.eval(`document.querySelector('#sendsDialog button[value="cancel"]').click()`);
    const sendsCancelled = await signin.until(`!document.getElementById('sendsDialog').open && ${SETUP_ROW(code)}.querySelector('.setup-room-sends').textContent`, 3000);
    report(pickerSeen === JSON.stringify({ title: 'Who may send into Smoke AGM › Press', halls: true, me: [true, false], main: ['Main room', false, true] }) && backOffered === true
      && sendsSaid === JSON.stringify({ t: 'Saved: 1 room may send into Smoke AGM › Press. It now sends into Smoke AGM.', p: 'May send in: Main · Smoke AGM', m: 'May send in: Press · Smoke AGM' })
      && drawnAgain === JSON.stringify({ on: true, back: true, offered: true }) && untickedKeeps === JSON.stringify({ on: false, back: true, offered: true }) && sendsCancelled === 'May send in: Press · Smoke AGM',
      `May send in… lists every hall's rooms, the room itself not offered and a ↔ only beside a tick; the Main room ticked with ↔ is one save, said, and each row says who may send into it; opened again it is drawn both ways, and unticked its ↔ stays, offered (${pickerSeen}; ↔ offered ${backOffered}; ${sendsSaid}; ${drawnAgain}; ${untickedKeeps}; "${sendsCancelled}")`);
    await signin.eval(`${SETUP_ROW(pressKey)}.scrollIntoView({ block: 'center' })`);
    await signin.shot(path.join(OUT, 'setup-rooms.png'));
    await signin.eval(`document.getElementById('setupDialog').close()`);
    const pressButton = await signin.until(`(() => { const a = document.querySelector('.hall-row[data-code="${code}"] .hall-rooms a.room-btn[data-key="${pressKey}"]'); const o = AGM.page.object('hall', '${code}'); return a && JSON.stringify({ words: a.textContent, href: a.getAttribute('href'), rooms: AGM.catalog.ids('hall', AGM.page.facts(), o).includes('hall.rooms'), open: AGM.catalog.entry('hall', 'hall.open').label(AGM.page.facts(), o), above: document.elementFromPoint(a.getBoundingClientRect().left + 4, a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2) === a }); })()`, 5000);
    await signin.shot(path.join(OUT, 'halls-rooms.png'));
    const setupSeen = setupMain && JSON.parse(setupMain);
    report(!!setupSeen && setupSeen.name === 'Main room' && setupSeen.code === 'code ' + code && setupSeen.add && setupSeen.words && doorsInStep(mainSetupDoors) && mainSetupDoors.want === JSON.stringify(['adminRoom.create', 'adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode']),
      `Set up lists the hall's rooms, the Main room first with its code; its doors are New room in this hall…, Board members…, May send in… and its code (${setupMain}; ${mainSetupDoors.want}; ${mainSetupDoors.right} / ${mainSetupDoors.dots} / ${mainSetupDoors.key})`);
    report(addAsk === 'New room in Smoke AGM' && /^[A-Z2-9]{8}$/.test(pressKey || '') && pressMade === JSON.stringify({ toast: 'Made Press in Smoke AGM: its guest code is off.', code: true, order: [code, pressKey] })
      && doorsInStep(pressDoors) && pressDoors.want === JSON.stringify(['adminRoom.members', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.remove']) && pressOn === 'The guest code of Smoke AGM › Press is on.',
      `+ Add room makes a room in Set up, listed after the Main room with its code off; its doors are Members…, May send in…, its code, Rename… and Remove room…, and Turn the code on switches it (${addAsk}; ${pressMade}; ${pressDoors.want}; "${pressOn}")`);
    // A room button is the room's own link, inside its hall's row: right-click and Shift+F10 on it open the room's menu
    // (kind room), never its row's; for the admin, who sets halls up and is told every code: Open, Open in a new tab, Copy
    // link, Copy guest code and Set up….
    const PRESS_BUTTON = `document.querySelector('.hall-row[data-code="${code}"] .hall-rooms a.room-btn[data-key="${pressKey}"]')`;
    const roomButtonDoors = await ownLinkDoors(signin, 'room', PRESS_BUTTON, `AGM.page.object('room', '${pressKey}')`, { facts: 'AGM.page.facts()' });
    report(pressButton === JSON.stringify({ words: 'Press', href: `/app.html?code=${pressKey}&as=account&role=research`, rooms: true, open: 'Open Main', above: true })
      && linkInStep(roomButtonDoors) && roomButtonDoors.want === JSON.stringify(['room.open', 'room.tab', 'room.copy', 'room.code', 'room.setup']),
      `the room is a room button on its hall's row, a link above the row's own whose right-click and Shift+F10 open the room's own menu, and the row's ⋯ offers Open Main and Rooms ▸ (${pressButton}; ${roomButtonDoors.want}; ${roomButtonDoors.right} / ${roomButtonDoors.key})`);
    const users = await edge.tab(`${base}/users.html`);
    report(!!(await users.until(`document.querySelectorAll('#userRows tr').length === 1`)), 'the accounts page lists the admin');
    await readOldWords('the Accounts page', users);
    const rightsWords = await users.eval(`(async () => { const r = await AGM.api('GET', '/api/users'); return JSON.stringify([r.caps['display.control'], r.roles.find((x) => x.id === 'tech').words]); })()`);
    report(rightsWords === JSON.stringify(['Change what a hall\'s screens and people\'s pages show', 'Their halls: messages, files, screens, the Board\'s pages, Stagewatch']), `the Accounts page's rights and roles say "screens" (${rightsWords})`);
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
    // Halls and rooms: each hall's Main room with its On stage seat beside it and its side rooms set in under it; the chat
    // view beside the role; the rights in three groups; the footer in sight as the form scrolls. Kim given Press, On stage
    // in the hall and the simple view: the server keeps each, the row says so, and an untouched Save of all of it is still
    // no change. On stage is a seat in the hall: a hall unticked takes it with it, and ticking it ticks the hall again.
    const KIM_TR = `[...document.querySelectorAll('#userRows > tr[data-key]')].find((tr) => tr.textContent.includes('kim'))`;
    const TREE = `document.querySelector('#uHalls .tree-hall[data-hall="${code}"]')`;
    await users.until(`!document.getElementById('userDialog').open`);
    await users.eval(`(${KIM_TR}).querySelector('button').click()`);
    await users.until(`document.getElementById('userDialog').open && !!${TREE}`);
    const tree = await users.eval(`(() => { const b = ${TREE}; return JSON.stringify({
      hall: b.querySelector('input.t-hall').closest('label').textContent.trim(), board: b.querySelector('input.t-board').closest('label').textContent.trim(),
      rooms: [...b.querySelectorAll('.tree-rooms input.t-room')].map((c) => c.closest('label').textContent.trim() + ':' + c.checked),
      every: document.getElementById('uAll').closest('label').textContent.trim(), views: [...document.getElementById('uView').options].map((o) => o.textContent), view: document.getElementById('uView').value,
      groups: [...document.querySelectorAll('#uCaps .cap-group')].map((g) => g.querySelector('h3').textContent + ':' + g.querySelectorAll('input').length),
      foot: getComputedStyle(document.querySelector('#userDialog .dialog-foot')).position }); })()`);
    await users.eval(`(() => { const b = ${TREE}; b.querySelector('input.t-room[value="${pressKey}"]').click(); b.querySelector('input.t-board').click(); document.getElementById('uView').value = 'simple';
      const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('userSave').click(); })()`);
    const kimGiven = await users.until(`(document.getElementById('agmToast') || {}).textContent === 'Saved — their open pages reconnect with the new rights.' && !document.getElementById('userDialog').open`, 5000);
    const kimNow = await users.eval(`AGM.api('GET', '/api/users').then((r) => { const k = r.users.find((u) => u.username === 'kim'); return JSON.stringify({ rooms: k.rooms, board: k.board, view: k.view }); })`);
    const kimCell = await users.until(`(() => { const tr = ${KIM_TR}; return tr && tr.children[2].textContent.includes('Press') && tr.children[2].textContent; })()`, 5000);
    await users.eval(`(${KIM_TR}).querySelector('button').click()`);
    await users.until(`document.getElementById('userDialog').open && !!${TREE}`);
    const kimShown = await users.eval(`(() => { const b = ${TREE}; return JSON.stringify([b.querySelector('input.t-room[value="${pressKey}"]').checked, b.querySelector('input.t-board').checked, document.getElementById('uView').value]); })()`);
    const linkedTicks = await users.eval(`(() => { const b = ${TREE}; const h = b.querySelector('input.t-hall'); const st = b.querySelector('input.t-board'); h.click(); const off = [h.checked, st.checked]; st.click(); return JSON.stringify([off, [h.checked, st.checked]]); })()`);
    await users.eval(`(() => { document.getElementById('agmToast').textContent = ''; document.getElementById('userSave').click(); })()`);
    const kimUntouched = await users.until(`(document.getElementById('agmToast') || {}).textContent === 'Saved — nothing changed.' && !document.getElementById('userDialog').open`, 5000);
    report(tree === JSON.stringify({ hall: `Smoke AGM — Main room and hall rights (${code})`, board: 'On stage (Board member)', rooms: ['Press:false'], every: 'Every hall\'s Main room, including new ones (not their other rooms)',
      views: ['By seat', 'Simple', 'Full'], view: '', groups: ['In the room:3', 'Show:6', 'Run AGMessage:5'], foot: 'sticky' }),
      `the Accounts page's editor: each hall's Main room with On stage beside it and its rooms under it, Chat view, the rights in three groups, the footer in sight (${tree})`);
    report(!!kimGiven && kimNow === JSON.stringify({ rooms: [pressKey], board: [code], view: 'simple' }) && kimCell === 'GONE01 (Main); Smoke AGM (Main, Press) · On stage' && kimShown === JSON.stringify([true, true, 'simple'])
      && linkedTicks === JSON.stringify([[false, false], [true, true]]) && !!kimUntouched,
      `a room, an On stage seat and a chat view are given on the Accounts page, said on the row, and an untouched Save of them changes nothing; On stage goes and comes with its hall (${kimNow}; "${kimCell}"; ${kimShown}; ${linkedTicks})`);
    // Clock or countdown and Lock it on their devices beside Chat view: their choice first, Lock disabled with why until a
    // choice is made; the countdown chosen and locked, saved with the pages told and none closed, kept, and shown again;
    // "Applies in the simple view." while Chat view is Full.
    const CLOCK_FIELDS = `JSON.stringify({ shown: !document.getElementById('uClockRow').hidden, options: [...document.getElementById('uClock').options].map((o) => o.textContent), show: document.getElementById('uClock').value,
      locked: document.getElementById('uClockLock').checked, disabled: document.getElementById('uClockLock').disabled, why: document.getElementById('uClockLockWhy').textContent, words: document.getElementById('uClockWords').textContent })`;
    await users.eval(`(${KIM_TR}).querySelector('button').click()`);
    await users.until(`document.getElementById('userDialog').open && !!${TREE}`);
    const clockFirst = JSON.parse(await users.eval(CLOCK_FIELDS));
    await users.eval(`(() => { const c = document.getElementById('uClock'); c.value = 'stage'; c.dispatchEvent(new Event('change')); const l = document.getElementById('uClockLock'); l.click(); const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('userSave').click(); return true; })()`);
    const clockSaved = await users.until(`(document.getElementById('agmToast') || {}).textContent === 'Saved — their open pages draw it now.' && !document.getElementById('userDialog').open && 'saved'`, 5000);
    const clockKept = await users.eval(`AGM.api('GET', '/api/users').then((r) => JSON.stringify(r.users.find((u) => u.username === 'kim').clock))`);
    await users.eval(`(${KIM_TR}).querySelector('button').click()`);
    await users.until(`document.getElementById('userDialog').open && !!${TREE}`);
    await users.eval(`(() => { const v = document.getElementById('uView'); v.value = 'full'; v.dispatchEvent(new Event('change')); return true; })()`);
    const clockAgain = JSON.parse(await users.eval(CLOCK_FIELDS));
    await users.eval(`document.getElementById('userDialog').close('cancel')`);
    const clockCleared = await users.eval(`AGM.api('PATCH', '/api/users/' + (${KIM_TR}).dataset.key, { clock: null }).then((r) => JSON.stringify(r.user && r.user.clock))`);
    report(clockFirst.shown && JSON.stringify(clockFirst.options) === JSON.stringify(['Their choice (the clock at first)', 'Time of day', 'Stagewatch countdown', 'Off']) && clockFirst.show === '' && clockFirst.disabled && clockFirst.why === 'Choose one to lock it.'
      && clockSaved === 'saved' && clockKept === JSON.stringify({ show: 'stage', locked: true }) && clockAgain.show === 'stage' && clockAgain.locked && !clockAgain.disabled && clockAgain.words === 'Applies in the simple view.'
      && clockCleared === JSON.stringify({ show: null, locked: false }),
      `the Accounts page's Clock or countdown beside Chat view: their choice first and Lock disabled with why; the countdown chosen and locked, saved (pages told, none closed) and kept (${clockKept}); shown again, "Applies in the simple view." with Chat view Full (${JSON.stringify({ clockFirst, clockAgain })})`);
    // On stage is a seat the account takes: while the rights ticked hold no Send messages (a Viewer) a seat is not offered,
    // with the server's words; a role that posts is offered it; unticking every hall ticks the hall of each seat ticked.
    await users.until(`!document.getElementById('userDialog').open`);
    await users.eval(`document.getElementById('newUserBtn').click()`);
    await users.until(`document.getElementById('userDialog').open && !!${TREE}`);
    const seatOffer = await users.eval(`(() => { const b = ${TREE}; const st = b.querySelector('input.t-board'); const h = b.querySelector('input.t-hall');
      const role = document.getElementById('uRole'); const all = document.getElementById('uAll'); const words = document.getElementById('uBoardWords');
      const pick = (v) => { role.value = v; role.dispatchEvent(new Event('change', { bubbles: true })); };
      const every = (on) => { all.checked = on; all.dispatchEvent(new Event('change', { bubbles: true })); };
      pick('viewer'); const viewer = [st.disabled, words.hidden, words.textContent];
      pick('staff'); const staff = [st.disabled, words.hidden];
      every(true); h.checked = false; st.click(); const before = [h.checked, st.checked];
      every(false);
      return JSON.stringify({ viewer, staff, hall: [before, h.checked] }); })()`);
    await users.eval(`document.getElementById('userDialog').close('cancel')`);
    report(seatOffer === JSON.stringify({ viewer: [true, false, 'Reads only: On stage needs Send messages.'], staff: [false, true], hall: [[false, true], true] }),
      `the Accounts page offers an On stage seat only while the rights ticked send messages, with the server's words, and unticking every hall ticks the hall of a seat ticked (${seatOffer})`);
    // Lou is given Press alone, in a hall Lou does not see: Lou's board lists it under Your rooms (below).
    const louMade = await users.eval(`AGM.api('POST', '/api/users', { username: 'lou', name: 'Lou Legal', role: 'staff', halls: [], rooms: ['${pressKey}'], password: 'press desk by the door' }).then((r) => r.status)`);
    await users.eval(`location.reload()`);
    await users.until(`document.querySelectorAll('#userRows > tr[data-key]').length >= 3 && !!(${KIM_TR})`);
    // The Accounts page acts from the catalogue (kinds account, audit): an account's row and an entry of the audit log
    // open the same menu by right-click, ⋯ and Shift+F10; an account's Edit is its bar.
    const KIM_ROW = `[...document.querySelectorAll('#userRows > tr[data-key]')].find((tr) => tr.textContent.includes('kim'))`;
    const accountDoors = await doorsOf(users, 'account', KIM_ROW, `AGM.page.object('account', (${KIM_ROW}).dataset.key)`, { ...PAGE_DOORS_HALLS, hit: 'td strong' });
    report(doorsInStep(accountDoors) && accountDoors.want === JSON.stringify(['account.edit', 'account.password', 'account.signout', 'account.clock', 'account.clockLock', 'account.disable', 'account.remove']),
      `an account's row: right-click = ⋯ = Shift+F10 = Edit…, New one-time password…, Sign out everywhere…, Clock or countdown ▸, Lock it on their devices, Turn off…, Remove…, Edit in its bar (${accountDoors.want}; ${accountDoors.right} / ${accountDoors.dots} / ${accountDoors.key}; ${accountDoors.inline})`);
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
    // A first open is bounded (unit 32): a hall of a long day opens with its newest 200 messages, the newest 60 drawn at
    // once and the rest above them through AGM.idle; Show earlier draws the ones before above, the reader's place kept; a
    // change to a message the page does not hold changes nothing drawn and is in it once it comes; a reply whose quoted
    // message is earlier says "Earlier — Show it", which reads back to it and goes to it, and one whose quoted message has
    // gone says nothing of the kind; a read that fails keeps its own words; Show it pressed while Show earlier reads still
    // goes to its message. At the floor (no requestIdleCallback), AGM.idle's timer draws the rest; a message pinned after
    // the page opened, earlier than what it holds, comes to its pinned strip; a removal heard takes a quote's Show it away.
    const longDay = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Long day' }) })).json()).code;
    // Sixteen people backstage, fifteen messages each (a burst each socket's bucket takes at once), each connection asked
    // again after a second while the address's connections are spent by the pages open.
    const seedSocket = async () => {
      for (let i = 0; i < 20; i++) {
        try { return await connect(base); } catch { await sleep(1000); /* the address's connections spent: asked again */ }
      }
      throw new Error('no connection for the long day');
    };
    const seeders = [];
    const sayLong = async (s, payload) => { const r = await emit(s, 'message', payload); if (!r || !r.ok) throw new Error('not said: ' + JSON.stringify(r)); return r.id; };
    for (let w = 0; w < 16; w++) {
      const s = await seedSocket();
      seeders.push(s);
      const j = await emit(s, 'join', { roomCode: longDay, name: 'Crew ' + w, role: 'research' });
      if (!j || !j.ok) throw new Error('the long day refused a join: ' + JSON.stringify(j));
    }
    const firstWord = await sayLong(seeders[0], { type: 'text', text: 'The first word of the day' });
    const reactLater = await sayLong(seeders[0], { type: 'text', text: 'React to this one later' });
    const takenBack = await sayLong(seeders[0], { type: 'text', text: 'This one is taken back' });
    await Promise.all(seeders.map((s, w) => Promise.all(Array.from({ length: w === 0 ? 12 : 15 }, (_, i) => sayLong(s, { type: 'text', text: 'Note ' + w + '.' + i })))));
    await sleep(1200);
    const toDoomed = await sayLong(seeders[1], { type: 'text', text: 'Answering the one taken back', replyTo: takenBack });
    const taken = await emit(seeders[0], 'delete', { messageId: takenBack });
    if (!taken || !taken.ok) throw new Error('the long day kept a message its author removed: ' + JSON.stringify(taken));
    const answer = await sayLong(seeders[1], { type: 'text', text: 'Answering the first word', replyTo: firstWord });
    // A page whose idle callbacks are held until the smoke lets them run: what a first open draws before the page is idle.
    const HOLD_IDLE = `(() => { window.__idleHeld = []; window.requestIdleCallback = (fn) => { window.__idleHeld.push(fn); return window.__idleHeld.length; }; window.cancelIdleCallback = () => {}; })();`;
    const longTab = await edge.tab(`${base}/app.html?code=${longDay}&name=Lena&role=research`, { init: HOLD_IDLE });
    // The window is the first 200 held (what comes live, the page's own joined line among it, is held after them).
    const openedFirst = await longTab.until(`typeof joined !== 'undefined' && joined && allMessages.length >= 200 && JSON.stringify({ held: allMessages.length, window: allMessages.slice(0, 200).filter((m) => messagesById.has(m.id)).length, drawn: messagesById.size, waiting: undrawn.size, newest: messagesById.has(${codeLiteral(answer)}), atEnd: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40, asked: window.__idleHeld.length, gap: !!document.querySelector('.feed-earlier') })`);
    // What a reaction to a message the page does not hold changes: nothing drawn (its change heard, by its number).
    const beforeReact = await longTab.eval(`(() => { window.__feedWas = feed.innerHTML; window.__seqWas = lastSeq; return lastSeq; })()`);
    await emit(seeders[2], 'react', { messageId: reactLater, emoji: '👍', on: true });
    const unheld = await longTab.until(`lastSeq > window.__seqWas && JSON.stringify({ same: feed.innerHTML === window.__feedWas, held: allMessages.some((m) => m.id === ${codeLiteral(reactLater)}) })`, 5000);
    // The page idle: each chunk it was asked for run, as many as it asks for, each within its 8 ms.
    const RUN_IDLE = `(() => { let n = 0; while (window.__idleHeld.length && n < 200) { for (const fn of window.__idleHeld.splice(0)) { n++; fn({ didTimeout: false, timeRemaining: () => 50 }); } } return n; })()`;
    const chunks = await longTab.eval(RUN_IDLE);
    const ORDERED = `(() => { const at = new Map(allMessages.map((m, i) => [m.id, i])); const seen = [...feed.querySelectorAll(':scope > [data-id]')].map((n) => at.get(n.dataset.id)); return seen.every((x, i) => typeof x === 'number' && (i === 0 || x > seen[i - 1])); })()`;
    const longDrawn = await longTab.until(`undrawn.size === 0 && JSON.stringify({ drawn: messagesById.size, held: allMessages.length, ordered: ${ORDERED}, gap: (document.querySelector('.feed-earlier .msg-act') || {}).textContent || '', above: (document.querySelector('.feed-earlier') || {}).nextElementSibling === messagesById.get(allMessages[0].id), atEnd: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40 })`, 5000);
    const opened1 = openedFirst && JSON.parse(openedFirst);
    const drawn1 = longDrawn && JSON.parse(longDrawn);
    report(!!opened1 && opened1.held >= 200 && opened1.window === 60 && opened1.waiting === 140 && opened1.drawn === opened1.held - 140 && opened1.newest && opened1.atEnd && opened1.asked === 1 && !opened1.gap
      && !!drawn1 && drawn1.drawn === drawn1.held && drawn1.held >= 200 && drawn1.ordered && drawn1.gap === 'Show earlier' && drawn1.above && drawn1.atEnd && chunks >= 1,
      `a hall of a long day (its change ${beforeReact}) opens with its newest 200: the newest 60 drawn at once, the reader at the end (${openedFirst}), the rest above them in ${chunks} AGM.idle chunk(s), in the room's order, Show earlier above the oldest (${longDrawn})`);
    report(!!unheld && JSON.parse(unheld).same === true && JSON.parse(unheld).held === false, `a change to a message the page does not hold changes nothing drawn (${unheld})`);
    // Show earlier, read from the top: the earlier ones drawn above, what was read kept where it was on the screen, the
    // reaction made meanwhile on the message it was made to; nothing earlier is left, so Show earlier goes.
    await longTab.eval(`feed.scrollTop = 0`);
    await sleep(100);
    const topWas = await longTab.eval(`(() => { window.__topWas = allMessages[0].id; return messagesById.get(window.__topWas).getBoundingClientRect().top; })()`);
    await longTab.eval(`document.querySelector('.feed-earlier .msg-act').click()`);
    const earlier = await longTab.until(`${RUN_IDLE} >= 0 && undrawn.size === 0 && messagesById.has(${codeLiteral(reactLater)}) && JSON.stringify({ held: allMessages.length, drawn: messagesById.size, first: allMessages[0].text || '', ordered: ${ORDERED}, gap: !!document.querySelector('.feed-earlier'), kept: Math.round(messagesById.get(window.__topWas).getBoundingClientRect().top - ${Number(topWas) || 0}), reaction: messagesById.get(${codeLiteral(reactLater)}).querySelector('.reactions').textContent.includes('👍') })`, 8000);
    const read1 = earlier && JSON.parse(earlier);
    report(!!read1 && read1.held > 200 && read1.drawn === read1.held && read1.ordered && !read1.gap && Math.abs(read1.kept) <= 2 && read1.reaction && /joined|The first word/.test(read1.first) && longTab.problems.length === 0,
      `Show earlier draws the earlier messages above, what was read kept in place, and a message changed while it was not held comes with its change (${earlier})${longTab.problems.length ? ' — ' + longTab.problems.slice(0, 3).join(' | ') : ''}`);
    longTab.close();
    // A reply whose quoted message is earlier than those held: "Earlier — Show it", which reads back to it and goes to it.
    const quoteTab = await edge.tab(`${base}/app.html?code=${longDay}&name=Quinn&role=research`);
    const QUOTE = `messagesById.get(${codeLiteral(answer)}).querySelector('.reply-quote')`;
    const GONE_QUOTE = `messagesById.get(${codeLiteral(toDoomed)}).querySelector('.reply-quote')`;
    const quoteSays = await quoteTab.until(`typeof joined !== 'undefined' && joined && undrawn.size === 0 && messagesById.has(${codeLiteral(answer)}) && messagesById.has(${codeLiteral(toDoomed)}) && !allMessages.some((m) => m.id === ${codeLiteral(firstWord)}) && !!${QUOTE}.querySelector('.quote-earlier') && JSON.stringify({ words: ${QUOTE}.querySelector('.quote-earlier').textContent, ready: !${QUOTE}.querySelector('.quote-earlier .msg-act').hasAttribute('aria-disabled'), gone: !${GONE_QUOTE}.querySelector('.quote-earlier') && ${GONE_QUOTE}.title })`, 8000);
    // A read back the server refuses: its words stay, and the page does not say the message has gone.
    await quoteTab.eval(`(() => { window.__emit = socket.emit; socket.emit = function (ev, ...a) { if (ev !== 'history:before') return window.__emit.call(this, ev, ...a); const cb = a[a.length - 1]; setTimeout(() => cb({ ok: false, error: 'Refused for the smoke' }), 0); return this; }; ${QUOTE}.querySelector('.quote-earlier .msg-act').click(); })()`);
    await quoteTab.until(`(document.getElementById('agmToast') || {}).textContent === 'Refused for the smoke'`, 5000);
    await sleep(400);
    const failed = await quoteTab.eval(`(() => { socket.emit = window.__emit; return JSON.stringify({ toast: document.getElementById('agmToast').textContent, held: allMessages.some((m) => m.id === ${codeLiteral(firstWord)}), offered: !!${QUOTE}.querySelector('.quote-earlier .msg-act') }); })()`);
    // Show earlier, and Show it pressed while its read is under way: Show it follows that read, and goes to its message.
    await quoteTab.eval(`(() => { document.querySelector('.feed-earlier .msg-act').click(); ${QUOTE}.querySelector('.quote-earlier .msg-act').click(); })()`);
    const wentTo = await quoteTab.until(`messagesById.has(${codeLiteral(firstWord)}) && messagesById.get(${codeLiteral(firstWord)}).classList.contains('found') && JSON.stringify({ found: true, quote: !${QUOTE}.querySelector('.quote-earlier'), ordered: ${ORDERED} })`, 8000);
    report(quoteSays === JSON.stringify({ words: 'Earlier — Show it', ready: true, gone: 'The message it answers is no longer in this room' }) && !!wentTo && JSON.parse(wentTo).found && JSON.parse(wentTo).quote && JSON.parse(wentTo).ordered && quoteTab.problems.length === 0,
      `a reply whose quoted message is earlier says "Earlier — Show it", ready, and one whose message has gone says no such thing (${quoteSays}); Show it pressed while Show earlier reads follows that read and goes to its message (${wentTo})${quoteTab.problems.length ? ' — ' + quoteTab.problems.slice(0, 3).join(' | ') : ''}`);
    report(failed === JSON.stringify({ toast: 'Refused for the smoke', held: false, offered: true }), `a read back that fails keeps its own words, never "not in this room" (${failed})`);
    quoteTab.close();
    // At the floor, where requestIdleCallback is gone: AGM.idle's timer draws the rest.
    const floorLong = await edge.tab(`${base}/app.html?code=${longDay}&name=Flo&role=observer`, { init: FLOOR });
    const floorDrawn = await floorLong.until(`typeof joined !== 'undefined' && joined && typeof window.requestIdleCallback === 'undefined' && undrawn.size === 0 && JSON.stringify({ held: allMessages.length, drawn: messagesById.size, ordered: ${ORDERED}, gap: !!document.querySelector('.feed-earlier') })`, 8000);
    report(!!floorDrawn && JSON.parse(floorDrawn).held >= 200 && JSON.parse(floorDrawn).drawn === JSON.parse(floorDrawn).held && JSON.parse(floorDrawn).ordered && JSON.parse(floorDrawn).gap && floorLong.problems.length === 0,
      `at the floor, a long day's first open draws the rest through AGM.idle's timer (${floorDrawn})${floorLong.problems.length ? ' — ' + floorLong.problems.slice(0, 3).join(' | ') : ''}`);
    // Pinned by someone else after the page opened, earlier than what it holds: read by its id, in the pinned strip and in
    // the feed among the older ones, in the room's order.
    const pinnedEarly = await emit(seeders[2], 'pin', { messageId: reactLater, pinned: true });
    const pinCame = await floorLong.until(`!!document.querySelector('#pinnedList .msg[data-id=${JSON.stringify(reactLater)}]') && undrawn.size === 0 && JSON.stringify({ strip: !document.getElementById('pinnedStrip').hidden, feed: messagesById.has(${codeLiteral(reactLater)}), pinned: findMessage(${codeLiteral(reactLater)}).pinned, ordered: ${ORDERED}, gap: !!document.querySelector('.feed-earlier') })`, 8000);
    // A removal heard of a message the page does not hold: the quote of it no longer offers to read back to it.
    const offeredBefore = await floorLong.eval(`!!${QUOTE}.querySelector('.quote-earlier')`);
    const takenFirst = await emit(seeders[0], 'delete', { messageId: firstWord });
    const unoffered = await floorLong.until(`!${QUOTE}.querySelector('.quote-earlier') && ${QUOTE}.title`, 5000);
    report(!!pinnedEarly && pinnedEarly.ok && pinCame === JSON.stringify({ strip: true, feed: true, pinned: true, ordered: true, gap: true }) && offeredBefore === true && !!takenFirst && takenFirst.ok && unoffered === 'The message it answers is no longer in this room' && floorLong.problems.length === 0,
      `a message pinned after the page opened, earlier than what it holds, comes to its pinned strip and its place in the feed (${pinCame}); a removal heard takes a quote's Show it away (${offeredBefore} → ${unoffered})${floorLong.problems.length ? ' — ' + floorLong.problems.slice(0, 3).join(' | ') : ''}`);
    floorLong.close();
    seeders.forEach((s) => s.close());
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
    report(!!(await hallView.until(`AGM.catalog.ids('header', F, headerObject()).includes('header.screens')`)), 'the hall view offers Screens & pages… in its header\'s ⋯ to an account that may drive them');
    const made = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Lectern monitor' }, r))`);
    const screen = await edge.tab(`${base}${made.display.path}`);
    report(!!(await screen.until(`document.body.dataset.kind === 'holding' && document.getElementById('idleName').textContent.includes('Lectern monitor')`)), 'a display link opens a holding screen named for the crew');
    await readOldWords('a screen', screen);
    await hallView.eval(`new Promise((r) => socket.emit('display:take', { id: '${made.display.id}', content: { kind: 'message', text: 'Five minutes — please wrap up', tone: 'warn' } }, r))`);
    report(!!(await screen.until(`document.body.dataset.kind === 'message' && document.getElementById('messageText').textContent.includes('please wrap up') && parseFloat(document.getElementById('messageText').style.fontSize) > 40`)), 'the screen shows the message, fitted large');
    await sleep(400);
    await screen.shot(path.join(OUT, 'screen-message.png'));
    report(!!(await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays[0].state === 'shown')))`)), 'the console reads ✓ on screen once the screen confirmed it');
    await hallView.eval(OPEN_SCREENS);
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
    // A JPEG 2000 picture in a PDF draws on a screen too, with no error: pdf.js's worker there may run WebAssembly.
    const jpxUrl = await upload('picture-jpx.pdf', 'application/pdf', fixture('jpeg2000.pdf'));
    const jpxTake = await takeOn(projId, { kind: 'file', url: jpxUrl, name: 'picture-jpx.pdf', page: 1 });
    const jpxSt = await shownAt(jpxTake.seq);
    const jpxScreen = await proj.until(`(() => { const c = document.getElementById('fileCanvas'); if (c.hidden || !c.width) return null;
      const p = c.getContext('2d').getImageData(Math.floor(c.width * ${JPX_YELLOW.x}), Math.floor(c.height * ${JPX_YELLOW.y}), 1, 1).data; return p[0] > 200 && p[1] > 150 && p[2] < 110 ? [p[0], p[1], p[2]] : null; })()`, 8000);
    report(!!jpxSt && !!jpxScreen && proj.problems.length === 0, `a JPEG 2000 picture in a PDF draws on a screen, with no error (${JSON.stringify({ shown: jpxSt && jpxSt.words, jpxScreen, problems: proj.problems.slice(0, 2) })})`);
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
    // A PDF whose first page is not drawn by its deadline is failed with its words, and its loading and the screen's
    // pdf.js worker are ended with it; the next PDF makes a new worker and draws.
    const stuckPdf = await upload('stuck-screen.pdf', 'application/pdf', colourPdf([{ w: 800, h: 450, rgb: '0 1 0', text: 'Stuck' }]));
    const workersBefore = await proj.eval(`({ ...window.__workers })`);
    proj.expectFailure(/stuck-screen\.pdf$/);
    await proj.hold('*stuck-screen.pdf*', 5000);
    const stuckTake = await takeOn(projId, { kind: 'file', url: stuckPdf, name: 'stuck-screen.pdf', page: 1 });
    const stuckEnd = Date.now() + 8000;
    while (Date.now() < stuckEnd && !((st = await projStatus()).state === 'error' && st.seq === stuckTake.seq)) await sleep(200);
    const workersAfter = await proj.eval(`({ ...window.__workers })`);
    await proj.release();
    const afterStuckTake = await takeOn(projId, { kind: 'file', url: agenda, name: 'agenda.pdf', page: 1 });
    const afterStuckSt = await shownAt(afterStuckTake.seq, 10000);
    const workersLast = await proj.eval(`({ ...window.__workers })`);
    report(st.state === 'error' && st.seq === stuckTake.seq && /the file took too long to read/.test(st.words) && workersAfter.ended === workersBefore.ended + 1 && !!afterStuckSt && workersLast.made === workersBefore.made + 1,
      `a PDF not drawn by the screen's deadline fails with its words, its worker ended with it, and the next PDF draws through a new one (${JSON.stringify({ state: st.state, words: st.words, workersBefore, workersAfter, workersLast, next: afterStuckSt && afterStuckSt.mark })})`);

    // The Screens console: a page typed for one PDF is not carried to the next one offered; a take on every ticked screen
    // is one request, and a screen it could not reach is named; a holding image picked but not saved survives refreshes.
    await hallView.until(`document.getElementById('screensDialog').open || (${OPEN_SCREENS}, false)`);
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
    // 📌 Pin ▸ opened: For the room (an act on what everyone sees) disabled with why; For me (held) live, with ◷.
    await hallView.until(`!!document.querySelector('.agm-menu .agm-mi[data-fold="pin"]')`, 3000);
    await hallView.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').click()`);
    const pinRow = await hallView.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi[data-action="msg.pin"]'); const m = document.querySelector('.agm-sub .agm-mi[data-action="msg.pinMine"]');
      return r && m && JSON.stringify({ disabled: r.getAttribute('aria-disabled'), why: r.querySelector('.mi-why').textContent, focusable: r.tabIndex === -1 && !r.disabled, mine: [m.getAttribute('aria-disabled'), m.querySelector('.mi-why').textContent] }); })()`);
    await hallView.eval(`document.querySelector('.agm-sub .agm-mi[data-action="msg.pin"]').click()`);
    const saidWhy = await hallView.until(`(document.getElementById('agmToast') || {}).textContent`);
    const sentOffline = await hallView.eval(`JSON.stringify(window.__sent)`);
    await hallView.eval(`AGM.menu.close()`);
    await hallView.eval(`socket.connect()`);
    await hallView.until(`socket.connected && joined && F.connected`, 8000);
    report(pinRow === JSON.stringify({ disabled: 'true', why: 'Not connected — AGMessage is reconnecting.', focusable: true, mine: [null, '◷ sent when the connection is back'] }) && saidWhy === 'Not connected — AGMessage is reconnecting.' && sentOffline === '[]',
      `not connected, Pin for the room is shown disabled and focusable with its reason, says it when chosen, and sends nothing; Pin for me stays live with ◷ (${pinRow}; "${saidWhy}"; sent ${sentOffline})`);

    // An open menu keeps its items and their order while its message changes under it: pinned elsewhere, its Pin reads Unpin
    // in place, and nothing moves.
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).querySelector('.obj-more').click()`);
    const idsBefore = await research.until(MENU_IDS);
    await research.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').click()`);
    await research.until(`!!document.querySelector('.agm-sub .agm-mi[data-action="msg.pin"]')`, 3000);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs.ownText)}, pinned: true }, r))`);
    await board.eval(`new Promise((r) => socket.emit('react', { messageId: ${codeLiteral(doorMsgs.ownText)}, emoji: '👀', on: true }, r))`);
    const relabelled = await research.until(`(() => { const r = document.querySelector('.agm-sub .agm-mi[data-action="msg.pin"]'); return r && r.getAttribute('aria-checked') === 'true' && findMessage(${codeLiteral(doorMsgs.ownText)}).reactions.length > 0 && 'checked'; })()`, 5000);
    const idsAfter = await research.eval(MENU_IDS);
    await research.eval(`AGM.menu.close()`);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(doorMsgs.ownText)}, pinned: false }, r))`);
    report(!!relabelled && idsBefore === idsAfter && !!idsBefore, `an open menu keeps its items and their order as its message is pinned and reacted to elsewhere; For the room is checked in place (${idsBefore} → ${idsAfter})`);

    // A single key on the focused message: P opens 📌 Pin ▸ with For the room focused, Enter pins it for the room, with Undo
    // in the toast for 10 s; Undo unpins it.
    await research.until(`!findMessage(${codeLiteral(doorMsgs.ownText)}).pinned`);
    await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).focus()`);
    await press(research, 'p');
    const keyFold = await research.until(`(() => { const a = document.activeElement; return a && a.matches('.agm-sub .agm-mi') && JSON.stringify([a.dataset.action, a.getAttribute('role'), a.getAttribute('aria-checked')]); })()`, 3000);
    await pressEnter(research);
    const keyPinned = await research.until(`findMessage(${codeLiteral(doorMsgs.ownText)}).pinned && (document.getElementById('agmToast') || {}).textContent`, 5000);
    await research.eval(`document.querySelector('#agmToast .toast-undo').click()`);
    const undone = await research.until(`!findMessage(${codeLiteral(doorMsgs.ownText)}).pinned && 'unpinned'`, 5000);
    report(keyFold === JSON.stringify(['msg.pin', 'menuitemcheckbox', 'false']) && keyPinned === 'Pinned for the room. · Undo' && undone === 'unpinned',
      `P on a focused message opens 📌 Pin ▸ with For the room focused, Enter pins it for the room, and the toast's Undo unpins it (${keyFold}; "${keyPinned}", then ${undone})`);

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

    // D and Enter on a focused file: its download, the server's act by a ticket (file:download), posted in a form and
    // answered with the file as an attachment, which the browser saves whole under its name, the page saying it reached
    // this browser once the server sent it all; the page itself fetches nothing of it. Enter is its Preview in the panel.
    await research.eval(`dismissDoc()`);
    const capexUrl = await research.eval(`(allMessages.find((m) => m.id === ${codeLiteral(capexId)}) || {}).url || ''`);
    const dlBefore = new Set(downloads.keys());
    await research.eval(`(() => { window.__dlFetched = []; const f = window.__fetch0 = window.fetch; window.fetch = function (u, o) { window.__dlFetched.push([String(u), (o && o.cache) || '']); return f.apply(this, arguments); }; return true; })()`);
    await research.eval(`messagesById.get(${codeLiteral(capexId)}).focus()`);
    await press(research, 'd');
    let savedCapex = null;
    for (const end = Date.now() + 15000; Date.now() < end && !savedCapex; await sleep(100)) savedCapex = [...downloads].find(([g, d]) => !dlBefore.has(g) && d.state === 'completed');
    const capexBytes = Buffer.from(await (await fetch(base + capexUrl)).arrayBuffer());
    const reached = await research.until(`(() => { const t = document.getElementById('agmToast'); return !!t && t.textContent.includes('capex.pdf reached this browser') && 'reached'; })()`, 5000);
    const downloadedByKey = JSON.stringify({ name: savedCapex ? savedCapex[1].name : '', whole: !!savedCapex && fs.readFileSync(path.join(dlDir, savedCapex[0])).equals(capexBytes),
      fetched: JSON.parse(await research.eval(`(() => { window.fetch = window.__fetch0; return JSON.stringify(window.__dlFetched.filter((x) => x[0] === ${codeLiteral(capexUrl)}).map((x) => x[1])); })()`)), reached });
    await research.eval(`messagesById.get(${codeLiteral(capexId)}).focus()`);
    await pressEnter(research);
    const lookedByKey = await research.until(`currentDocMsgId === ${codeLiteral(capexId)} && 'open'`, 3000);
    report(downloadedByKey === JSON.stringify({ name: 'capex.pdf', whole: true, fetched: [], reached: 'reached' }) && lookedByKey === 'open', `D on a focused file downloads it by its ticket (saved whole under its name, the page fetching nothing of it, "reached this browser") and Enter opens it in the panel (${JSON.stringify({ downloadedByKey, lookedByKey })})`);

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
    const keptAt = await middleOf(research, keptDots);
    await leftClick(research, keptAt);
    const dotsAgain = await research.until(`!document.querySelector('.agm-ask') && !!document.querySelector('.agm-menu:not(.agm-sub)') && messagesById.has(${codeLiteral(doorMsgs.ownText)}) && 'no'`, 3000);
    await press(research, 'Escape');
    await research.until(NO_MENU, 3000);
    report(dotsAsk === 'Delete your message?' && dotsAgain === 'no', `The ⋯ pressed again under the Delete… it opened answers the ask "no": the ask goes, the message stays, and only the ⋯'s menu opens (${JSON.stringify({ dotsAsk, dotsAgain })})`);

    // A pointer at rest is no hover (menus.js): parked by a move of its own on a row of a message's menu, the menu shut,
    // then opened again under it by E, the React ▸ that E opened stays open past the hover's 200 ms with the focus in it,
    // though the page reports the pointer entering the row it lies on. Moved one row, onto Send to ▸, it hovers: Send
    // to's submenu takes React's place. The pointer then lies where it lay before.
    const TOP_ROWS = `JSON.stringify([...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].map((b) => { const q = b.getBoundingClientRect(); return { id: b.dataset.action || '', sub: b.hasAttribute('aria-haspopup'), x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; }))`;
    const REACT_OPEN = `!!document.activeElement && !!document.activeElement.closest('.agm-sub') && document.querySelector('.agm-menu:not(.agm-sub) [data-action="msg.react"]').getAttribute('aria-expanded') === 'true'`;
    const reactByKey = async () => {
      await research.eval(`messagesById.get(${codeLiteral(doorMsgs.ownText)}).focus()`);
      await press(research, 'e');
      return research.until(`(${REACT_OPEN}) && ${TOP_ROWS}`, 3000);
    };
    const restRows = JSON.parse((await reactByKey()) || '[]');
    await research.eval('AGM.menu.close()');
    await research.until(NO_MENU, 3000);
    const parkOn = restRows.find((r) => !r.sub) || { id: '-', x: 0, y: 0 };
    const hoverTo = restRows.find((r) => r.id === 'msg.send') || { x: 0, y: 0 };
    await research.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parkOn.x, y: parkOn.y });
    const reactAgain = !!(await reactByKey());
    const underRest = await research.eval(`(() => { const b = document.elementFromPoint(${parkOn.x}, ${parkOn.y}); const r = b && b.closest('.agm-menu:not(.agm-sub) > .agm-mi'); return r ? r.dataset.action || '' : ''; })()`);
    await sleep(600);
    const atRest = await research.eval(`(${REACT_OPEN}) && 'open'`);
    await research.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTo.x, y: hoverTo.y });
    const hovered = await research.until(`(() => { const top = document.querySelector('.agm-menu:not(.agm-sub)'); const ex = (id) => top && top.querySelector('[data-action="' + id + '"]').getAttribute('aria-expanded');
      return ex('msg.send') === 'true' && ex('msg.react') === 'false' && !!document.querySelector('.agm-sub') && 'send'; })()`, 3000);
    await research.eval('AGM.menu.close()');
    await research.until(NO_MENU, 3000);
    await research.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: keptAt.x, y: keptAt.y });
    report(restRows.length > 1 && reactAgain && underRest === parkOn.id && atRest === 'open' && hovered === 'send',
      `a pointer at rest is no hover: lying on a row of the menu E opened again, React ▸ stays open past 200 ms with the focus in it; moved onto Send to ▸, it hovers and that submenu opens (${JSON.stringify({ rows: restRows.map((r) => r.id + (r.sub ? ' ▸' : '')), parkOn: parkOn.id, reactAgain, underRest, atRest, hovered })})`);

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

    // A file pinned both ways (plan 7-§17.5): the panel's entry says so, and its door opens 📌 Unpin ▸ For the room · For me,
    // both checked; unchecking For me leaves the room's pin, and the entry's door is then Unpin for the room alone.
    await research.until(`!document.querySelector('.agm-toast.show')`, 15000);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(capexId)}, pinned: true }, r))`);
    const capexMine = await research.eval(`new Promise((r) => socket.emit('pin:mine', { messageId: ${codeLiteral(capexId)}, on: true }, (x) => r(JSON.stringify(x))))`);
    await research.until(`F.pins.includes(${codeLiteral(capexId)}) && !!${fileEntry} && !!${fileEntry}.querySelector('[data-fold="pin"]')`, 5000);
    const bothEntry = await research.eval(`(() => { const li = ${fileEntry}; return JSON.stringify([li.querySelector('.pin-kind').textContent, li.querySelector('[data-fold="pin"]').getAttribute('aria-label')]); })()`);
    await research.eval(`${fileEntry}.querySelector('[data-fold="pin"]').click()`);
    const bothChecks = await research.until(`(() => { const r = [...document.querySelectorAll('.agm-sub .agm-mi')].map((b) => [b.dataset.action, b.getAttribute('aria-checked')]); return r.length === 2 && JSON.stringify(r); })()`, 3000);
    await research.eval(`document.querySelector('.agm-sub .agm-mi[data-action="file.pinMine"]').click()`);
    const roomLeft = await research.until(`!F.pins.includes(${codeLiteral(capexId)}) && findMessage(${codeLiteral(capexId)}).pinned && (() => { const b = ${fileEntry}.querySelector('.file-acts .msg-act[data-action^="file.pin"]'); return b && JSON.stringify([${fileEntry}.querySelector('.pin-kind').textContent, b.dataset.action, b.getAttribute('aria-label')]); })()`, 5000);
    await hallView.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(capexId)}, pinned: false }, r))`);
    report(JSON.parse(capexMine).ok && bothEntry === JSON.stringify(['📌 For everyone · for you', 'Unpin']) && bothChecks === JSON.stringify([['file.pin', 'true'], ['file.pinMine', 'true']]) && roomLeft === JSON.stringify(['📌 For everyone', 'file.pin', 'Unpin for the room']),
      `a file pinned both ways reads so in the panel, its door opens 📌 Unpin ▸ with both checked, and unchecking For me leaves the room's pin and its own door (${bothEntry}; ${bothChecks}; ${roomLeft})`);

    // ---------------- Pins for the room or for me (plan 7-§17.5, unit 20c) ----------------
    {
      // A hall of its own: Pia backstage (the full view), Bo and Cal On stage (the simple view; Cal then the full view, by the
      // admin's Chat view), Oli an observer, each a person of their own (a browser of their own), and the admin's view of Bo.
      const pinHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Pins' }) })).json()).code;
      const pinUrl = (name, role) => `${base}/app.html?code=${pinHall}&name=${name}&role=${role}${role === 'board' ? '&invite=' + inviteOf(dataDir, pinHall) : ''}`;
      const pia = await edge.tab(pinUrl('Pia', 'research'), { alone: true });
      const bo = await edge.tab(pinUrl('Bo', 'board'), { alone: true });
      const cal = await edge.tab(pinUrl('Cal', 'board'), { alone: true });
      const oli = await edge.tab(pinUrl('Oli', 'observer'), { alone: true });
      const pinTabs = [pia, bo, cal, oli];
      await Promise.all(pinTabs.map((t) => t.until('typeof joined !== "undefined" && joined && F.connected', 15000)));
      const pinSay = (args) => pia.eval(`new Promise((r) => socket.emit('message', ${codeLiteral(args)}, (x) => r(x.id)))`);
      const pm = {
        t1: await pinSay({ type: 'text', text: 'Pins: the agenda is final' }),
        t2: await pinSay({ type: 'text', text: 'Pins: lunch is at one' }),
        q1: await pinSay({ type: 'action', text: 'Pins: adjourn at twelve?', options: ['Yes', 'No'] }),
        t3: await pinSay({ type: 'text', text: 'Pins: the room is booked until five' }),
        q2: await pinSay({ type: 'action', text: 'Pins: take the vote now?', options: ['Yes', 'No'] }),
        t4: await pinSay({ type: 'text', text: 'Pins: the last word' }),
      };
      const pinDrawn = `${codeLiteral(Object.values(pm))}.every((id) => messagesById.has(id))`;
      await Promise.all(pinTabs.map((t) => t.until(pinDrawn, 8000)));
      const nodeOf = (id) => `messagesById.get(${codeLiteral(id)})`;
      /** A message's line, as a page draws it: its pin's words ('' where it has none), and whether the feed shows it. */
      const lineOf = (id) => `(() => { const n = ${nodeOf(id)}; const m = n.querySelector(':scope > header .pinned-mark'); return JSON.stringify([m.hidden ? '' : m.textContent.replace(/\\s+/g, ' ').trim(), getComputedStyle(n).display !== 'none']); })()`;
      const PIN_BAR = `(() => { const b = document.getElementById('bvPins'); const l = document.getElementById('bvPinLine'); return b.hidden || !l ? '' : JSON.stringify([l.tagName, l.querySelector('.bv-pin-kind').textContent, l.querySelector('.bv-pin-words').textContent, l.querySelector('.bv-pin-count').textContent]); })()`;
      const toastNow = `(document.getElementById('agmToast') || {}).textContent || ''`;
      const clearToast = async (t) => { await t.eval(`(() => { const x = document.getElementById('agmToast'); if (x) x.textContent = ''; })()`); };
      // What each page sends: counted from here (a support view's doors send nothing).
      const COUNT_SENDS = `(() => { window.__sent = []; const e = socket.emit; socket.emit = function (ev, ...a) { window.__sent.push([ev, a[0] && typeof a[0] === 'object' ? a[0] : null]); return e.call(this, ev, ...a); }; })()`;
      for (const t of pinTabs) await t.eval(COUNT_SENDS);

      // A backstage page (the full view): ⋯ holds one 📌 Pin ▸, which opens with For the room focused and both unchecked; Enter
      // pins it for the room, the default: every page reads "📌 Pinned for everyone", the backstage strip "📌 For everyone"
      // and the Board's bar "📌 For everyone"; the toast's Undo takes it back.
      await pia.eval(`${nodeOf(pm.t1)}.querySelector('.obj-more').click()`);
      const foldRow = await pia.until(`(() => { const f = document.querySelector('.agm-menu .agm-mi[data-fold="pin"]'); return f && JSON.stringify([f.getAttribute('aria-label'), f.dataset.children, ![...document.querySelectorAll('.agm-menu:not(.agm-sub) > .agm-mi')].some((b) => /^msg\\.pin/.test(b.dataset.action || ''))]); })()`, 3000);
      await pia.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').focus()`);
      await press(pia, 'ArrowRight');
      const roomFirst = await pia.until(`(() => { const a = document.activeElement; const r = [...document.querySelectorAll('.agm-sub .agm-mi')].map((b) => [b.dataset.action, b.getAttribute('aria-label'), b.getAttribute('role'), b.getAttribute('aria-checked')]); return a && a.dataset.action === 'msg.pin' && JSON.stringify(r); })()`, 3000);
      await pressEnter(pia);
      const roomToast = await pia.until(`findMessage(${codeLiteral(pm.t1)}).pinned && ${toastNow}`, 5000);
      const roomLines = await Promise.all(pinTabs.map((t) => t.until(`findMessage(${codeLiteral(pm.t1)}).pinned && ${lineOf(pm.t1)}`, 5000)));
      const piaStrip = await pia.until(`(() => { const c = document.querySelector('#pinnedList .msg[data-id=${JSON.stringify(pm.t1)}]'); return c && c.querySelector('.pinned-mark').textContent.replace(/\\s+/g, ' ').trim(); })()`, 3000);
      const boBar = await bo.until(PIN_BAR, 3000);
      const sentRoom = await pia.eval(`JSON.stringify(window.__sent.filter(([ev]) => ev === 'pin' || ev === 'pin:mine').map(([ev, a]) => [ev, a.pinned === undefined ? a.on : a.pinned]))`);
      await pia.eval(`document.querySelector('#agmToast .toast-undo').click()`);
      const roomUndone = await Promise.all(pinTabs.map((t) => t.until(`!findMessage(${codeLiteral(pm.t1)}).pinned && ${lineOf(pm.t1)}`, 5000)));
      report(foldRow === JSON.stringify(['Pin', 'msg.pin msg.pinMine', true]) && roomFirst === JSON.stringify([['msg.pin', 'For the room', 'menuitemcheckbox', 'false'], ['msg.pinMine', 'For me', 'menuitemcheckbox', 'false']])
        && roomToast === 'Pinned for the room. · Undo' && roomLines.every((l) => l === JSON.stringify(['📌 Pinned for everyone', true])) && piaStrip === '📌 For everyone'
        && boBar === JSON.stringify(['BUTTON', '📌 For everyone', 'Pins: the agenda is final', '']) && sentRoom === JSON.stringify([['pin', true]]) && roomUndone.every((l) => l === JSON.stringify(['', true])),
      `a backstage page's ⋯ holds one 📌 Pin ▸, For the room first and focused, both unchecked; Enter pins for the room, which every page reads, the strip and the Board's bar too, and Undo takes it back (${foldRow}; ${roomFirst}; "${roomToast}"; ${roomLines.join(' ')}; ${piaStrip}; ${boBar}; ${sentRoom})`);

      // On a coarse pointer at 390 px, ⋯ → 📌 Pin ▸ drills in, in the same panel, with "‹ Back" first.
      const pip = await edge.tab(pinUrl('Pip', 'research'), { alone: true, metrics: PHONE });
      await pip.until(`typeof joined !== "undefined" && joined && F.connected && ${pinDrawn} && matchMedia('(pointer: coarse)').matches`, 15000);
      await pip.eval(`${nodeOf(pm.t1)}.querySelector('.obj-more').click()`);
      await pip.until(`!!document.querySelector('.agm-menu .agm-mi[data-fold="pin"]')`, 3000);
      await pip.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').click()`);
      const drilled = await pip.until(`(() => { const d = document.querySelector('.agm-menu.drill'); return d && JSON.stringify([...d.querySelectorAll('.agm-mi')].map((b) => b.getAttribute('aria-label'))); })()`, 3000);
      await pip.eval(`AGM.menu.close()`);
      const pipProblems = pip.problems.slice();
      pip.close();
      report(drilled === JSON.stringify(['‹ Back', 'For the room', 'For me']) && pipProblems.length === 0, `on a phone ⋯ → 📌 Pin ▸ drills in with "‹ Back" (${drilled})${pipProblems.length ? ' — ' + pipProblems.slice(0, 2).join(' | ') : ''}`);

      // For me: P opens the same submenu, and ↓ Enter pins it for Pia alone: her pages read "📌 Pinned for you" and "📌 For
      // you"; nobody else's line moves.
      await pia.until(`!document.querySelector('.agm-menu')`, 3000);
      await clearToast(pia);
      await pia.eval(`window.__sent = []; ${nodeOf(pm.t1)}.focus()`);
      await press(pia, 'p');
      await pia.until(`document.activeElement && document.activeElement.dataset.action === 'msg.pin'`, 3000);
      await press(pia, 'ArrowDown');
      await pressEnter(pia);
      const mineToast = await pia.until(`F.pins.includes(${codeLiteral(pm.t1)}) && ${toastNow}`, 5000);
      const mineLine = await pia.eval(lineOf(pm.t1));
      const mineStrip = await pia.until(`(() => { const c = document.querySelector('#pinnedList .msg[data-id=${JSON.stringify(pm.t1)}]'); return c && c.querySelector('.pinned-mark').textContent.replace(/\\s+/g, ' ').trim(); })()`, 3000);
      await sleep(300);
      const othersLines = await Promise.all([bo, cal, oli].map((t) => t.eval(lineOf(pm.t1))));
      const sentMine = await pia.eval(`JSON.stringify(window.__sent.filter(([ev]) => ev === 'pin' || ev === 'pin:mine').map(([ev, a]) => [ev, a.pinned === undefined ? a.on : a.pinned]))`);
      report(mineToast === 'Pinned for you. · Undo' && mineLine === JSON.stringify(['📌 Pinned for you', true]) && mineStrip === '📌 For you' && othersLines.every((l) => l === JSON.stringify(['', true])) && sentMine === JSON.stringify([['pin:mine', true]]),
        `P opens 📌 Pin ▸ and ↓ Enter pins for me: only Pia's page reads "📌 Pinned for you" and "📌 For you" (${mineToast}; ${mineLine}; ${mineStrip}; others ${othersLines.join(' ')}; ${sentMine})`);

      // Pinned both ways: the item reads 📌 Unpin ▸ with both checked; unchecking For me leaves the room's pin.
      await pia.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(pm.t1)}, pinned: true }, r))`);
      await pia.until(`findMessage(${codeLiteral(pm.t1)}).pinned`, 3000);
      await pia.eval(`${nodeOf(pm.t1)}.querySelector('.obj-more').click()`);
      await pia.until(`!!document.querySelector('.agm-menu .agm-mi[data-fold="pin"]')`, 3000);
      const unpinFold = await pia.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').getAttribute('aria-label')`);
      await pia.eval(`document.querySelector('.agm-menu .agm-mi[data-fold="pin"]').click()`);
      const bothChecked = await pia.until(`(() => { const r = [...document.querySelectorAll('.agm-sub .agm-mi')].map((b) => b.getAttribute('aria-checked')); return r.length === 2 && JSON.stringify(r); })()`, 3000);
      await pia.eval(`document.querySelector('.agm-sub .agm-mi[data-action="msg.pinMine"]').click()`);
      const leftRoom = await pia.until(`!F.pins.includes(${codeLiteral(pm.t1)}) && findMessage(${codeLiteral(pm.t1)}).pinned && ${lineOf(pm.t1)}`, 5000);
      report(unpinFold === 'Unpin' && bothChecked === JSON.stringify(['true', 'true']) && leftRoom === JSON.stringify(['📌 Pinned for everyone', true]),
        `pinned both ways the item reads 📌 Unpin ▸ with both checked, and unchecking For me leaves the room's pin (${unpinFold}; ${bothChecked}; ${leftRoom})`);

      // An observer: a flat 📌 Pin for me and no Pin ▸; P pins at once, with Undo; the room's pin in its strip has no door to
      // take it off, its own has.
      await oli.eval(`${nodeOf(pm.t2)}.querySelector('.obj-more').click()`);
      const oliMenu = await oli.until(`(() => { const m = document.querySelector('.agm-menu:not(.agm-sub)'); if (!m) return ''; const b = m.querySelector('.agm-mi[data-action="msg.pinMine"]'); return JSON.stringify([!!b && b.getAttribute('aria-label'), !!m.querySelector('[data-fold="pin"], [data-action="msg.pin"]')]); })()`, 3000);
      await press(oli, 'Escape');
      await oli.until(NO_MENU, 3000);
      await oli.eval(`${nodeOf(pm.t2)}.focus()`);
      await press(oli, 'p');
      const oliToast = await oli.until(`F.pins.includes(${codeLiteral(pm.t2)}) && ${toastNow}`, 5000);
      const oliStrip = await oli.until(`(() => { const room = document.querySelector('#pinnedList .msg[data-id=${JSON.stringify(pm.t1)}]'); const own = document.querySelector('#pinnedList .msg[data-id=${JSON.stringify(pm.t2)}]');
        return room && own && JSON.stringify([!!room.querySelector('.msg-acts [data-action^="msg.pin"], .msg-acts [data-fold]'), (own.querySelector('.msg-acts [data-action="msg.pinMine"]') || {}).ariaLabel || '']); })()`, 3000);
      await oli.eval(`document.querySelector('#agmToast .toast-undo').click()`);
      const oliUndone = await oli.until(`!F.pins.includes(${codeLiteral(pm.t2)}) && 'undone'`, 5000);
      report(oliMenu === JSON.stringify(['Pin for me', false]) && oliToast === 'Pinned for you. · Undo' && oliStrip === JSON.stringify([false, 'Unpin for me']) && oliUndone === 'undone',
        `an observer's menu holds a flat 📌 Pin for me and no Pin ▸; P pins at once with Undo; the room's pin in its strip has no door, its own one has (${oliMenu}; "${oliToast}"; ${oliStrip})`);

      // A Board page (the simple view): a tapped message's row has 📌 Pin for me, then Unpin for me; its line reads "📌 Pinned
      // for you"; the bar "📌 For you" with its words, after the room's "📌 For everyone", "1 of 2"; a tap on the bar's line
      // goes to the message, outlined, and the bar shows the next pin.
      // A tap on a message's words (a question's own words, never one of its answers).
      const tapOn = async (t, id) => { await leftClick(t, await middleOf(t, `(${nodeOf(id)}.querySelector('.body .action-text') || ${nodeOf(id)}.querySelector('.body p') || ${nodeOf(id)}.querySelector('.body'))`)); };
      await tapOn(bo, pm.t2);
      const boRow = await bo.until(`(() => { const b = ${nodeOf(pm.t2)}.querySelector('.msg-response [data-action="msg.pinMine"]'); return b && b.getAttribute('aria-label'); })()`, 3000);
      await bo.eval(`${nodeOf(pm.t2)}.querySelector('.msg-response [data-action="msg.pinMine"]').click()`);
      const boLine = await bo.until(`F.pins.includes(${codeLiteral(pm.t2)}) && ${lineOf(pm.t2)}`, 5000);
      await tapOn(bo, pm.t2);
      const boRowAfter = await bo.until(`(() => { const b = ${nodeOf(pm.t2)}.querySelector('.msg-response [data-action="msg.pinMine"]'); return b && b.getAttribute('aria-label') === 'Unpin for me' && 'Unpin for me'; })()`, 3000);
      await press(bo, 'Escape');
      const boBars = [await bo.until(`(() => { const r = ${PIN_BAR}; return r && JSON.parse(r)[3] === '1 of 2' && r; })()`, 3000)];
      const boBarNoUnpin = await bo.eval(`!document.querySelector('#bvPins [data-action="msg.pinMine"], #bvPins [data-action="msg.pin"]')`);
      await bo.eval(`${nodeOf(pm.t4)}.scrollIntoView()`);
      await bo.eval(`document.getElementById('bvPinLine').click()`);
      const wentTo = await bo.until(`${nodeOf(pm.t1)}.classList.contains('found') && (() => { const r = ${PIN_BAR}; return r && JSON.parse(r)[3] === '2 of 2' && r; })()`, 3000);
      boBars.push(wentTo);
      await bo.eval(`document.getElementById('bvPinLine').click()`);
      const wentToMine = await bo.until(`${nodeOf(pm.t2)}.classList.contains('found') && (() => { const r = ${PIN_BAR}; return r && JSON.parse(r)[3] === '1 of 2' && 'back to 1 of 2'; })()`, 3000);
      report(boRow === 'Pin for me' && boLine === JSON.stringify(['📌 Pinned for you', true]) && boRowAfter === 'Unpin for me' && boBarNoUnpin
        && boBars[0] === JSON.stringify(['BUTTON', '📌 For everyone', 'Pins: the agenda is final', '1 of 2']) && boBars[1] === JSON.stringify(['BUTTON', '📌 For you', 'Pins: lunch is at one', '2 of 2']) && !!wentToMine,
        `the Board's simple view: a tapped message's row has 📌 Pin for me, then Unpin for me; its line reads "📌 Pinned for you"; the bar reads the room's pin first, "1 of 2", with no Unpin, and a tap goes to each in turn (${boRow}; ${boLine}; ${boBars.join(' → ')}; ${wentToMine})`);
      await bo.eval(`new Promise((r) => socket.emit('pin:mine', { messageId: ${codeLiteral(pm.t2)}, on: false }, r))`);
      await pia.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(pm.t1)}, pinned: false }, r))`);
      await Promise.all(pinTabs.map((t) => t.until(`!findMessage(${codeLiteral(pm.t1)}).pinned`, 5000)));
      await bo.until(`document.getElementById('bvPins').hidden`, 3000);

      // Cal in the full view (the admin's Chat view): a flat 📌 Pin for me in the message menu; P pins at once.
      const pinAdmin = await connect(base, cookie);
      const calSid = await cal.eval('socket.id');
      const calFull = await emit(pinAdmin, 'admin:setView', { roomCode: pinHall, socketId: calSid, view: 'full' });
      await cal.until(`F.view === 'full'`, 5000);
      await cal.eval(`${nodeOf(pm.t3)}.querySelector('.obj-more').click()`);
      const calMenu = await cal.until(`(() => { const m = document.querySelector('.agm-menu:not(.agm-sub)'); return m ? JSON.stringify([!!m.querySelector('.agm-mi[data-action="msg.pinMine"]'), !!m.querySelector('[data-fold="pin"], [data-action="msg.pin"]')]) : ''; })()`, 3000);
      await press(cal, 'Escape');
      await cal.until(NO_MENU, 3000);
      await cal.eval(`${nodeOf(pm.t3)}.focus()`);
      await press(cal, 'p');
      const calPinned = await cal.until(`F.pins.includes(${codeLiteral(pm.t3)}) && ${lineOf(pm.t3)}`, 5000);
      await cal.eval(`new Promise((r) => socket.emit('pin:mine', { messageId: ${codeLiteral(pm.t3)}, on: false }, r))`);
      report(!!calFull.ok && calMenu === JSON.stringify([true, false]) && calPinned === JSON.stringify(['📌 Pinned for you', true]),
        `On stage in the full view: a flat 📌 Pin for me in the message menu and no Pin for the room; P pins at once (${calMenu}; ${calPinned})`);

      // A pinned question, in every view: pinned for the room it leaves every reader's feed (backstage, an observer, the
      // Board's simple view and its full view) and is drawn whole in each one's pinned place; from the Board's bar its answers
      // (48 px) and Answer in words… (asked in place, no prompt) answer it, and the bar then reads "You answered Yes · … ·
      // Change"; scrolled to the feed's top and end, the feed draws no copy.
      await pia.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(pm.q1)}, pinned: true }, r))`);
      const hidden = await Promise.all(pinTabs.map((t) => t.until(`findMessage(${codeLiteral(pm.q1)}).pinned && getComputedStyle(${nodeOf(pm.q1)}).display === 'none' && 'hidden'`, 5000)));
      const placed = await Promise.all(pinTabs.map((t) => t.until(`document.querySelectorAll('#pinnedList .msg[data-id=${JSON.stringify(pm.q1)}], #bvPinQ .msg[data-id=${JSON.stringify(pm.q1)}]').length === 1 && (document.querySelector('#bvPinQ .msg[data-id=${JSON.stringify(pm.q1)}]') ? 'bar' : 'strip')`, 5000)));
      const qBar = await bo.until(PIN_BAR, 3000);
      const answers = await bo.eval(`JSON.stringify([...document.querySelectorAll('#bvPinQ .action-btn')].map((b) => Math.round(b.getBoundingClientRect().height)))`);
      // The bar's height with the question, not answered yet and then answered, on a tablet (1180 × 820) and a phone (390 ×
      // 844), recorded against §17.4's estimate (about 105 px and 101 px), and each within 30% of its viewport.
      const BAR_SIZES = [[1180, 820, 105], [390, 844, 101]];
      const barHeights = async () => {
        const out = [];
        for (const [w, h] of BAR_SIZES) {
          await bo.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
          out.push(await bo.until(`(async () => { await new Promise((r) => setTimeout(r, 100)); return innerWidth === ${w} && Math.round(document.getElementById('bvPins').getBoundingClientRect().height); })()`, 3000));
        }
        await bo.send('Emulation.clearDeviceMetricsOverride', {});
        await bo.until(`innerWidth !== ${BAR_SIZES[1][0]}`, 3000);
        return out;
      };
      const unansweredHeights = await barHeights();
      await bo.eval(`document.querySelector('#bvPinQ .answer-words-btn').click()`);
      const asked = await bo.until(`(() => { const a = document.querySelector('.agm-ask'); return a && !!a.querySelector('input, textarea') && 'asked in place'; })()`, 3000);
      await press(bo, 'Escape');
      await bo.until(`!document.querySelector('.agm-ask')`, 3000);
      await bo.eval(`document.querySelector('#bvPinQ .action-btn[data-value="0"]').click()`);
      const answeredBar = await bo.until(`(() => { const l = document.querySelector('#bvPinQ .bv-answered'); return l && /^You answered Yes · \\d{1,2}:\\d\\d( [AP]M)? · Change$/.test(l.textContent) && l.textContent; })()`, 5000);
      const noCopy = await bo.eval(`(async () => { const f = document.getElementById('feed'); const seen = []; for (const top of [0, f.scrollHeight]) { f.scrollTop = top; await new Promise((r) => setTimeout(r, 100)); seen.push(f.querySelectorAll('.msg[data-id=${JSON.stringify(pm.q1)}]').length === 1 && getComputedStyle(${nodeOf(pm.q1)}).display === 'none'); } return seen.every(Boolean); })()`);
      const answeredHeights = await barHeights();
      const heightsOk = [unansweredHeights, answeredHeights].every((hs) => hs.every((x, i) => Number.isInteger(x) && x > 0 && x <= Math.ceil(BAR_SIZES[i][1] * 0.3)));
      const heightsSaid = BAR_SIZES.map(([w, h, est], i) => `${unansweredHeights[i]} px not answered and ${answeredHeights[i]} px answered at ${w} × ${h} (estimate ${est} px)`).join('; ');
      report(hidden.every((h) => h === 'hidden') && JSON.stringify(placed) === JSON.stringify(['strip', 'bar', 'strip', 'strip']) && qBar === JSON.stringify(['P', '📌 For everyone', 'Question', ''])
        && JSON.parse(answers).length === 2 && JSON.parse(answers).every((h) => h >= 44) && asked === 'asked in place' && !!answeredBar && noCopy && heightsOk && !bo.problems.some((x) => /native prompt/.test(x)),
      `a question pinned for the room leaves every reader's feed and is drawn whole in their pinned place (${placed.join(', ')}); from the Board's bar its answers (${answers} px) and Answer in words… (in place) answer it, and the bar reads "${answeredBar}"; the feed draws no copy at its top or end; the bar with the question, within 30% of the viewport: ${heightsSaid}`);

      // A question pinned for one Board member leaves only their feed: the other Board page and the backstage page draw it in
      // place, with its answers. With two pinned questions the bar reads "1 of 2", and a tap on its line shows the other;
      // each is answered there; its 📌 Unpin for me puts it back in the feed between the same neighbours, its answers kept.
      const before = await bo.eval(`JSON.stringify((() => { const n = ${nodeOf(pm.q2)}; return [n.previousElementSibling && n.previousElementSibling.dataset.id, n.nextElementSibling && n.nextElementSibling.dataset.id, findMessage(${codeLiteral(pm.q2)}).seq]; })())`);
      await tapOn(bo, pm.q2);
      await bo.until(`!!${nodeOf(pm.q2)}.querySelector('.msg-response [data-action="msg.pinMine"]')`, 3000);
      await bo.eval(`${nodeOf(pm.q2)}.querySelector('.msg-response [data-action="msg.pinMine"]').click()`);
      await bo.until(`F.pins.includes(${codeLiteral(pm.q2)}) && getComputedStyle(${nodeOf(pm.q2)}).display === 'none'`, 5000);
      await sleep(300);
      const elsewhere = await Promise.all([cal, pia].map((t) => t.eval(`getComputedStyle(${nodeOf(pm.q2)}).display !== 'none' && ${nodeOf(pm.q2)}.querySelectorAll('.action-btn').length === 2`)));
      const twoBar = await bo.until(`(() => { const r = ${PIN_BAR}; return r && JSON.parse(r)[3] === '1 of 2' && r; })()`, 3000);
      await bo.eval(`document.getElementById('bvPinLine').click()`);
      const secondQ = await bo.until(`(() => { const r = ${PIN_BAR}; const q = document.querySelector('#bvPinQ .msg[data-id=${JSON.stringify(pm.q2)}]'); return r && q && JSON.parse(r)[3] === '2 of 2' && JSON.stringify([JSON.parse(r)[1], (q.querySelector('.msg-response [data-action="msg.pinMine"]') || {}).ariaLabel || '', document.getElementById('bvPinLine').getAttribute('aria-label')]); })()`, 3000);
      await bo.eval(`document.querySelector('#bvPinQ .action-btn[data-value="1"]').click()`);
      await bo.until(`(findMessage(${codeLiteral(pm.q2)}).responses || []).some((r) => r.uid === MY_UID && r.optionIndex === 1)`, 5000);
      await bo.eval(`document.getElementById('bvPinLine').click()`);
      const backToFirst = await bo.until(`(() => { const r = ${PIN_BAR}; return r && JSON.parse(r)[3] === '1 of 2' && !!document.querySelector('#bvPinQ .msg[data-id=${JSON.stringify(pm.q1)}]') && 'first'; })()`, 3000);
      await bo.eval(`document.getElementById('bvPinLine').click()`);
      await bo.until(`!!document.querySelector('#bvPinQ .msg[data-id=${JSON.stringify(pm.q2)}] .msg-response [data-action="msg.pinMine"]')`, 3000);
      await bo.eval(`document.querySelector('#bvPinQ .msg[data-id=${JSON.stringify(pm.q2)}] .msg-response [data-action="msg.pinMine"]').click()`);
      const backInFeed = await bo.until(`!F.pins.includes(${codeLiteral(pm.q2)}) && getComputedStyle(${nodeOf(pm.q2)}).display !== 'none' && JSON.stringify((() => { const n = ${nodeOf(pm.q2)}; return [n.previousElementSibling && n.previousElementSibling.dataset.id, n.nextElementSibling && n.nextElementSibling.dataset.id, findMessage(${codeLiteral(pm.q2)}).seq]; })())`, 5000);
      const answersKept = await pia.until(`(() => { const q1 = findMessage(${codeLiteral(pm.q1)}); const q2 = findMessage(${codeLiteral(pm.q2)}); return [q1, q2].every((q) => (q.responses || []).some((r) => r.name === 'Bo')) && JSON.stringify([q1, q2].map((q) => q.responses.find((r) => r.name === 'Bo').optionIndex)); })()`, 5000);
      report(elsewhere.every(Boolean) && twoBar === JSON.stringify(['BUTTON', '📌 For everyone', 'Question', '1 of 2']) && secondQ === JSON.stringify(['📌 For you', 'Unpin for me', 'Pinned for you, 2 of 2: Question. Next pin']) && backToFirst === 'first'
        && backInFeed === before && answersKept === JSON.stringify([0, 1]),
      `a question pinned for one Board member leaves their feed alone; with two the bar reads "1 of 2", its line shows the other ("2 of 2", 📌 Unpin for me), each answered there; unpinned it is back between the same neighbours with its answers (${twoBar}; ${secondQ}; ${backInFeed}; ${answersKept})`);
      await pia.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(pm.q1)}, pinned: false }, r))`);
      const q1Back = await Promise.all(pinTabs.map((t) => t.until(`!findMessage(${codeLiteral(pm.q1)}).pinned && getComputedStyle(${nodeOf(pm.q1)}).display !== 'none' && 'back'`, 5000)));
      report(q1Back.every((x) => x === 'back'), `unpinned for the room, the question is back in every reader's feed (${q1Back.join(', ')})`);

      // The admin's view of Bo draws his pins, both kinds, and his pin doors disabled with the support view's words, sending
      // nothing.
      await bo.eval(`new Promise((r) => socket.emit('pin:mine', { messageId: ${codeLiteral(pm.q2)}, on: true }, r))`);
      await pia.eval(`new Promise((r) => socket.emit('pin', { messageId: ${codeLiteral(pm.t1)}, pinned: true }, r))`);
      const boUid = await bo.eval('MY_UID');
      const boView = await edge.tab(`${base}/app.html?code=${pinHall}&name=Bo&role=board&adminView=1&viewOf=${encodeURIComponent(boUid)}`);
      await boView.until(`typeof joined !== "undefined" && joined && F.view === 'simple' && F.pins.includes(${codeLiteral(pm.q2)}) && !!document.getElementById('bvPinLine') && !document.getElementById('bvPins').hidden`, 15000);
      await boView.eval(COUNT_SENDS);
      const viewBar = await boView.eval(PIN_BAR);
      await boView.eval(`document.getElementById('bvPinLine').click()`);
      const viewDoor = await boView.until(`(() => { const b = document.querySelector('#bvPinQ .msg-response [data-action="msg.pinMine"]'); return b && JSON.stringify([b.getAttribute('aria-disabled'), b.title]); })()`, 3000);
      await boView.eval(`document.querySelector('#bvPinQ .msg-response [data-action="msg.pinMine"]').click()`);
      await sleep(300);
      const viewSent = await boView.eval(`JSON.stringify(window.__sent.filter(([ev]) => ev === 'pin' || ev === 'pin:mine'))`);
      report(viewBar === JSON.stringify(['BUTTON', '📌 For everyone', 'Pins: the agenda is final', '1 of 2']) && viewDoor === JSON.stringify(['true', 'This is Bo\'s view — act from your own page.']) && viewSent === '[]',
        `the admin's view of Bo draws his pins, the room's first, and his pin doors disabled with whose view it is, sending nothing (${viewBar}; ${viewDoor}; ${viewSent})`);
      const pinProblems = [...pinTabs, boView].flatMap((t) => t.problems);
      report(pinProblems.length === 0, `the pins' pages ran clean${pinProblems.length ? ': ' + pinProblems.slice(0, 3).join(' | ') : ''}`);
      for (const t of [...pinTabs, boView]) t.close();
      pinAdmin.close();
    }

    // A screen, inside the Screens dialog: its menu and its asks open in the dialog, Escape closes them and the dialog stays;
    // Rename… is a field in place and Remove… asks in place, never a native dialog.
    const doorScreen = await hallView.eval(`new Promise((r) => socket.emit('display:create', { code: ROOM, name: 'Doors spare' }, (x) => r(x.display.id)))`);
    await hallView.eval(OPEN_SCREENS);
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
    // the same list (✨ Draft a reply, Send, To ▸ — Press's list names Smoke AGM, May send in… above —, 🔥 Priority,
    // Attach a file…); 🔥 is a checked toggle there; the text field keeps the browser's own menu.
    // (once a toast the steps above left has gone from over the composer, as a person waits for it)
    await research.until(`!document.querySelector('.agm-toast.show')`, 15000);
    const composeDoors = await doorsOf(research, 'compose', 'textPane', `composeObject('text')`, { hit: '.send-btn', bar: '.send-btn', focus: `textPane.querySelector('.send-btn')` });
    await research.eval(`textPriBtn.click()`);
    await research.eval(`textPane.querySelector('.compose-more').click()`);
    const priorityItem = await research.until(`(() => { const r = document.querySelector('.agm-menu [data-action="compose.priority"]'); return r && JSON.stringify([r.getAttribute('role'), r.getAttribute('aria-checked')]); })()`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="compose.priority"]').click()`);
    const priorityOff = await research.until(`textPriBtn.getAttribute('aria-pressed') === 'false' && ${NO_MENU} && 'off'`, 3000);
    const fieldMenu = await research.eval(`(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 2 }); textInput.dispatchEvent(e); return JSON.stringify({ prevented: e.defaultPrevented, menu: !!document.querySelector('.agm-menu') }); })()`);
    const sendName = await research.eval(`textPane.querySelector('.send-btn').getAttribute('aria-label')`);
    report(doorsInStep(composeDoors) && JSON.parse(composeDoors.want).join() === 'compose.draft,compose.send,compose.sendTo,compose.priority,compose.attach' && sendName === 'Send to Smoke AGM' &&
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

    // ---------------- Sent into another room, a copy kept here (unit 14) ----------------
    // Press's list names Smoke AGM and Smoke AGM's names Press (May send in… above, with its ↔). Pat, a Member of Press (its
    // guest code is on), reads there. To: ▸ Press: Send reads "Send to Press", and the line "↗ to Press — replies stay
    // there" stays above the field, at 390 px too, where Send is its mark. Sent, it lands in Press marked "↘ From Smoke
    // AGM", the copy here says "↗ Sent to Smoke AGM › Press — delivered", and To: is back on This room. Send to ▸ is one
    // list: Press once, sent by its list, then the halls this browser may forward into, each saying it is a forward; a file
    // sent on from here never opens itself on Press's panel. Pat's ↗ Send back answers under the question, here.
    const ctlSends = await connect(base, cookie);
    const pressCode = (await emit(ctlSends, 'room:settings', { code: pressKey })).guestCode;
    ctlSends.close();
    const pressTab = await edge.tab(`${base}/app.html?code=${pressCode}&name=Pat&role=research`);
    await pressTab.until('typeof joined !== "undefined" && joined && F.sends', 8000);
    await research.until('F.sends && F.targets.length === 1', 5000);
    const pressRef = await research.eval('F.targets[0].ref');
    await research.eval(`document.querySelector('.compose-tabs .tab[data-tab="text"]').click()`);
    const toShown = await research.eval(`JSON.stringify({ shown: !document.getElementById('composeTo').hidden, words: toBtn.textContent, line: toLine.hidden })`);
    await research.eval('toBtn.click()');
    const toValues = await research.until(`(() => { const rows = [...document.querySelectorAll('.agm-menu .agm-mi[data-action="compose.sendTo"]')]; return rows.length === 2 && JSON.stringify(rows.map((r) => [r.dataset.value || '', r.querySelector('.mi-label').textContent, r.getAttribute('aria-checked')])); })()`, 3000);
    await research.eval(`document.querySelector('.agm-menu .agm-mi[data-value="${pressRef}"]').click()`);
    const toSet = await research.until(`!toLine.hidden && JSON.stringify({ btn: toBtn.textContent, line: toLine.textContent, send: textPane.querySelector('.send-btn').getAttribute('aria-label'), word: textPane.querySelector('.send-word').textContent, edge: document.getElementById('researchCompose').classList.contains('to-other') })`, 3000);
    await research.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const onPhone = await research.eval(`(() => { const r = toLine.getBoundingClientRect(); const f = textInput.getBoundingClientRect(); return JSON.stringify({ line: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= f.top + 1, word: getComputedStyle(textPane.querySelector('.send-word')).display, wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth }); })()`);
    await research.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await research.eval(`(() => { textInput.value = 'Doors: is the press pack ready?'; textPane.querySelector('.send-btn').click(); })()`);
    const sentLanded = await pressTab.until(`(() => { const m = allMessages.find((x) => x.text === 'Doors: is the press pack ready?'); const n = m && messagesById.get(m.id); return n && JSON.stringify({ from: n.querySelector('.sent-meta').textContent, mark: !!m.sentFrom && m.sentFrom.ref.length === 17 }); })()`, 6000);
    const sentCopy = await research.until(`(() => { const m = allMessages.find((x) => x.text === 'Doors: is the press pack ready?'); const n = m && messagesById.get(m.id); return n && toLine.hidden && JSON.stringify({ to: n.querySelector('.sent-meta').textContent, btn: toBtn.textContent, edge: document.getElementById('researchCompose').classList.contains('to-other'), echo: !document.querySelector('#feed .echo') }); })()`, 6000);
    report(toShown === JSON.stringify({ shown: true, words: '↗ To: This room', line: true }) && toValues === JSON.stringify([['', 'This room', 'true'], [pressRef, 'Smoke AGM › Press', 'false']])
      && toSet === JSON.stringify({ btn: '↗ To: Smoke AGM › Press', line: '↗ to Press — replies stay there', send: 'Send to Press', word: 'Send to Press', edge: true })
      && onPhone === JSON.stringify({ line: true, word: 'none', wide: true })
      && sentLanded === JSON.stringify({ from: '↘ From Smoke AGM', mark: true }) && sentCopy === JSON.stringify({ to: '↗ Sent to Smoke AGM › Press — delivered', btn: '↗ To: This room', edge: false, echo: true }),
      `To: ▸ Press sends the next message there: Send reads "Send to Press" and its line stays above the field, at 390 px too; it lands in Press "↘ From Smoke AGM", the copy here reads "↗ Sent to … — delivered", and To: is back on This room (${toShown}; ${toValues}; ${toSet}; ${onPhone}; ${sentLanded}; ${sentCopy})`);
    // Send to ▸ on the PDF: Press once, by its list, first; then each hall this browser may forward into, said a forward.
    // Sent to Press, it does not open itself on Press's panel.
    await pressTab.eval('dismissDoc()');
    await research.eval(`messagesById.get(${codeLiteral(capexId)}).querySelector('.obj-more').click()`);
    await research.until(`!!document.querySelector('.agm-menu [data-action="msg.send"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="msg.send"]').click()`);
    const sendRows = await research.until(`(() => { const rows = [...document.querySelectorAll('.agm-sub .agm-mi[data-value]')]; return rows.length > 0 && JSON.stringify(rows.map((r) => [r.dataset.value === ${codeLiteral(pressRef)} ? 'press' : 'hall', r.querySelector('.mi-why').hidden ? '' : r.querySelector('.mi-why').textContent])); })()`, 5000);
    await research.eval(`document.querySelector('.agm-sub .agm-mi[data-value="${pressRef}"]').click()`);
    const fileThere = await pressTab.until(`(() => { const m = allMessages.find((x) => x.type === 'file' && !!x.sentFrom); return m && JSON.stringify({ name: m.filename, open: currentDocMsgId !== null }); })()`, 6000);
    const fileSaid = await research.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return /^Sent to /.test(t) && t; })()`, 5000);
    const rowsSeen = JSON.parse(sendRows || '[]');
    report(rowsSeen.length > 0 && JSON.stringify(rowsSeen[0]) === JSON.stringify(['press', '']) && rowsSeen.filter((r) => r[0] === 'press').length === 1 && rowsSeen.slice(1).every((r) => r[0] === 'hall' && r[1] === 'a forward — no withdraw')
      && fileThere === JSON.stringify({ name: 'capex.pdf', open: false }) && fileSaid === 'Sent to Smoke AGM › Press — a copy stays here.',
      `↗ Send to ▸ is one list: Press once, first, by its list, then each hall to forward into, said "a forward — no withdraw"; the PDF sent to Press does not open itself on its panel (${sendRows}; ${fileThere}; "${fileSaid}")`);
    // Pat's ↗ Send back on the question: Press's composer set to Smoke AGM for one send, replying; the answer lands here
    // under this room's copy of the question.
    const pressQ = await pressTab.eval(`allMessages.find((x) => x.text === 'Doors: is the press pack ready?').id`);
    await pressTab.eval(`messagesById.get(${codeLiteral(pressQ)}).querySelector('.obj-more').click()`);
    const backItem = await pressTab.until(`(() => { const r = document.querySelector('.agm-menu [data-action="msg.sendBack"]'); return r && r.querySelector('.mi-label').textContent; })()`, 3000);
    await pressTab.eval(`document.querySelector('.agm-menu [data-action="msg.sendBack"]').click()`);
    const backSet = await pressTab.until(`!toLine.hidden && !!document.getElementById('replyChip') && JSON.stringify({ line: toLine.textContent, focus: document.activeElement === textInput })`, 3000);
    await pressTab.eval(`(() => { textInput.value = 'Pack is on the desk.'; textPane.querySelector('.send-btn').click(); })()`);
    const answeredHere = await research.until(`(() => { const a = allMessages.find((x) => x.text === 'Pack is on the desk.'); const q = allMessages.find((x) => x.text === 'Doors: is the press pack ready?'); return a && q && JSON.stringify({ under: !!a.replyTo && a.replyTo.id === q.id, from: messagesById.get(a.id).querySelector('.sent-meta').textContent }); })()`, 6000);
    report(backItem === 'Send back to Smoke AGM' && backSet === JSON.stringify({ line: '↗ to Smoke AGM — replies stay there', focus: true }) && answeredHere === JSON.stringify({ under: true, from: '↘ From Smoke AGM › Press' }),
      `↗ Send back to Smoke AGM sets Press's composer there for one send, replying; the answer lands here under this room's copy of the question (${backItem}; ${backSet}; ${answeredHere})`);
    // ---------------- A mis-sent message withdrawn (unit 15) ----------------
    // Ana's copy of the question offers 🔙 Withdraw from Smoke AGM › Press…, which asks first, naming the room and how long it
    // has been there, the safe choice focused. Withdrawn, it goes from Press, whose line says who took it back, and Press's
    // copy of Pat's answer under it keeps no word of it ("↩ Ana: ⊘ withdrawn"); the copy here stays and reads "⊘ Withdrawn
    // from Smoke AGM › Press after …", offers Withdraw no more, and this page heard it under the next number, joining
    // nothing again; the admin page watching this room redraws the copy's line from "↗ Sent to … — delivered" alike. A
    // second ask is answered as done. The Chair's page, in this room too and off the network meanwhile, comes back by
    // resuming and draws the copy's mark from the change it missed (applyOp).
    const copyQ = await research.eval(`allMessages.find((x) => x.text === 'Doors: is the press pack ready?' && !!x.sentTo).id`);
    const adminW = await edge.tab(`${base}/admin.html`);
    await adminW.until(`!document.getElementById('dashboard').hidden && !!roomObject('${code}')`, 8000);
    await adminW.eval(`watchRoom('${code}')`);
    const ADMIN_COPY = `(() => { const d = document.querySelector('#adminFeed > .admin-msg[data-key="' + CSS.escape(${codeLiteral(copyQ)}) + '"] .sent-meta'); return d ? d.textContent : ''; })()`;
    const adminBefore = await adminW.until(ADMIN_COPY, 6000);
    await board.until(`!!findMessage(${codeLiteral(copyQ)})`, 5000);
    await board.eval(`(() => { window.__ops = []; const was = applyOp; applyOp = (op) => { window.__ops.push(op && op.o + ':' + Object.keys(op.f || {}).join()); return was(op); }; socket.disconnect(); return true; })()`);
    await research.eval(`(() => { window.__joins = 0; const was = socket.emit; window.__emit = was; socket.emit = function (ev, ...a) { if (ev === 'join') window.__joins++; return was.call(this, ev, ...a); }; return true; })()`);
    await research.eval(`messagesById.get(${codeLiteral(copyQ)}).querySelector('.obj-more').click()`);
    const withdrawItem = await research.until(`(() => { const r = document.querySelector('.agm-menu [data-action="msg.withdraw"]'); return r && r.querySelector('.mi-label').textContent; })()`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="msg.withdraw"]').click()`);
    const withdrawAsk = await research.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, words: [...a.querySelectorAll('.agm-ask-words')].map((w) => w.textContent).join(' '), yes: a.querySelector('[data-answer=yes]').textContent, no: a.querySelector('[data-answer=no]').textContent, focused: document.activeElement === a.querySelector('[data-answer=no]') }); })()`, 3000);
    await research.eval(`document.querySelector('.agm-ask [data-answer=yes]').click()`);
    const goneThere = await pressTab.until(`(() => !allMessages.some((x) => x.text === 'Doors: is the press pack ready?') && [...document.querySelectorAll('#feed .sys')].some((n) => n.textContent === 'Ana withdrew a message sent from Smoke AGM') && 'gone')()`, 6000);
    const withdrawnHere = await research.until(`(() => { const m = findMessage(${codeLiteral(copyQ)}); const n = m && messagesById.get(m.id); const line = n && n.querySelector('.sent-meta').textContent; const said = (document.getElementById('agmToast') || {}).textContent || ''; return line && /^⊘ /.test(line) && /withdr/i.test(said) && JSON.stringify({ line: line.replace(/after \\d+ (s|min)$/, 'after N'), offered: AGM.catalog.ids('msg', F, m).includes('msg.withdraw'), joins: window.__joins, said }); })()`, 6000);
    const adminAfter = await adminW.until(`/^⊘ /.test(${ADMIN_COPY}) && ${ADMIN_COPY}.replace(/after \\d+ (s|min)$/, 'after N')`, 6000);
    const quoteThere = await pressTab.until(`(() => { const a = allMessages.find((x) => x.text === 'Pack is on the desk.'); const q = a && a.replyTo && a.replyTo.withdrawn === true && messagesById.get(a.id).querySelector('.reply-quote'); return q && JSON.stringify({ quote: q.textContent, words: allMessages.some((x) => !!x.replyTo && /press pack/.test(x.replyTo.snippet || '')) }); })()`, 6000);
    const adminWProblems = adminW.problems.slice();
    await adminW.send('Page.navigate', { url: 'about:blank' });
    await adminW.close();
    const withdrawAgain = await research.eval(`new Promise((r) => window.__emit.call(socket, 'room:withdraw', { messageId: ${codeLiteral(copyQ)} }, (a) => r(JSON.stringify(a))))`);
    await research.eval('socket.emit = window.__emit; true');
    await board.eval('socket.connect(); true');
    const resumedMark = await board.until(`(() => { const m = findMessage(${codeLiteral(copyQ)}); const n = m && messagesById.get(m.id); const line = n && n.querySelector('.sent-meta').textContent; return socket.connected && line && /^⊘ /.test(line) && JSON.stringify({ line: line.replace(/after \\d+ (s|min)$/, 'after N'), applied: window.__ops.includes('upd:sentTo') }); })()`, 8000);
    const askSeen = JSON.parse(withdrawAsk || '{}');
    report(withdrawItem === 'Withdraw from Smoke AGM › Press…' && askSeen.title === 'Withdraw from Smoke AGM › Press?' && /^It goes from Smoke AGM › Press's chat now; people there may have read it \(it was there \d+ (s|min)\)\.$/.test(askSeen.words || '')
      && askSeen.yes === 'Withdraw' && askSeen.no === 'Keep it' && askSeen.focused === true && goneThere === 'gone'
      && withdrawnHere === JSON.stringify({ line: '⊘ Withdrawn from Smoke AGM › Press after N', offered: false, joins: 0, said: 'Withdrawn from Smoke AGM › Press.' })
      && withdrawAgain === JSON.stringify({ ok: true, already: true }) && resumedMark === JSON.stringify({ line: '⊘ Withdrawn from Smoke AGM › Press after N', applied: true })
      && quoteThere === JSON.stringify({ quote: '↩ Ana: ⊘ withdrawn', words: false })
      && adminBefore === '↗ Sent to Smoke AGM › Press — delivered' && adminAfter === '⊘ Withdrawn from Smoke AGM › Press after N' && adminWProblems.length === 0,
      `🔙 Withdraw from Press asks first, naming the room and how long it was there; it goes from Press with a line saying who, and the quote of it there says withdrawn with none of its words; the copy here reads "⊘ Withdrawn … after …" with no Withdraw left, heard in order with no rejoin, and the admin page watching this room redraws it; asked again it is done already, and a page back by resuming draws the mark from the change it missed (${withdrawItem}; ${withdrawAsk}; ${goneThere}; ${quoteThere}; ${withdrawnHere}; admin ${adminBefore} → ${adminAfter}${adminWProblems.length ? ' ' + adminWProblems.slice(0, 3).join(' | ') : ''}; ${withdrawAgain}; ${resumedMark})`);
    // Pat's page leaves Press (its socket closes as the page goes), so Press is listed with nobody in afterwards.
    await pressTab.send('Page.navigate', { url: 'about:blank' });
    await pressTab.close();

    // ---------------- People's pages: a take on the Board's and a person's pages, minimised, shown again; the console (unit 18) ----------------
    // In a hall of its own, so no take covers a page the other steps read: the admin account's page (the operator: its
    // Board chip and its console's People's pages), Bea On stage and Obi observing, each on a browser of its own (a device
    // of their own, as the Board's tablets are). The hall follows the smoke's Stagewatch, so every kind draws.
    const tkHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Takes hall' }) })).json()).code;
    const op = await edge.tab(`${base}/app.html?code=${tkHall}&as=account&role=research`);
    await op.until(`typeof joined !== 'undefined' && joined && F.canPush && !document.getElementById('boardChip').hidden`, 10000);
    await op.eval(`new Promise((r) => socket.emit('hall:configure', { code: ROOM, stagewatchUrl: ${codeLiteral(sw.url)}, stagewatchKey: ${codeLiteral(KEY)} }, r))`);
    const beaPad = await edge.tab(`${base}/app.html?code=${tkHall}&name=Bea&role=board&invite=${inviteOf(dataDir, tkHall)}`, { alone: true });
    const obiPad = await edge.tab(`${base}/app.html?code=${tkHall}&name=Obi&role=observer`, { alone: true });
    for (const t of [beaPad, obiPad]) await t.until(`typeof joined !== 'undefined' && joined`, 10000);
    // Joined with the On stage link, Bea's page takes the code and the invite out of its address (and the shared tablet's
    // history), keeps them for this tab alone, and a reload in that tab rejoins On stage.
    const ADDRESS = `JSON.stringify({ search: location.search, role: F.role, kept: (() => { try { return !!JSON.parse(sessionStorage.getItem('agm.join')).invite; } catch { return false; } })(), history: history.length })`;
    const beaAddress = JSON.parse(await beaPad.until(`(() => { const v = ${ADDRESS}; return !/code=/.test(location.search) && v; })()`, 5000) || 'null');
    await beaPad.eval(`window.__beforeReload = 1`);
    await beaPad.send('Page.reload');
    const beaReloaded = JSON.parse(await beaPad.until(`!window.__beforeReload && typeof joined !== 'undefined' && joined && ${ADDRESS}`, 10000) || 'null');
    report(!!beaAddress && beaAddress.search === '?name=Bea&role=board' && beaAddress.role === 'board' && beaAddress.kept && !!beaReloaded && beaReloaded.search === '?name=Bea&role=board' && beaReloaded.role === 'board',
      `after joining with the On stage link the address holds no code= or invite=, kept for this tab alone, and a reload in that tab rejoins On stage (${JSON.stringify({ beaAddress, beaReloaded })})`);
    // Bea's page draws the simple view by her seat; the take's and the card's doors below are the full view's, which the
    // admin's Chat view gives her live (moved on purpose: the simple view's take has its buttons alone, read with the web
    // page below, and its own pass, the Board's chat view's).
    const chatViewOf = (who, view) => op.eval(`new Promise((r) => socket.emit('admin:setView', { roomCode: ROOM, socketId: (people.find((u) => u.name === ${codeLiteral(who)}) || {}).socketId, view: ${codeLiteral(view)} }, (a) => r(JSON.stringify(a))))`);
    await op.until(`people.some((u) => u.name === 'Bea')`, 5000);
    const beaFullView = await chatViewOf('Bea', 'full');
    report(beaFullView === JSON.stringify({ ok: true, view: 'full' }) && !!(await beaPad.until(`document.body.dataset.view === 'full' && F.view === 'full'`, 5000)), `the admin's Chat view gives Bea's On stage page the full view, live (${beaFullView})`);
    const unsay = (t) => t.eval(`(() => { const x = document.getElementById('agmToast'); if (x) { x.textContent = ''; x.classList.remove('show'); } return true; })()`);
    // The Board chip: "Board · Chat" with one Board page and nothing shown; a click, a right-click and Shift+F10 open its
    // menu alike.
    const BOARD_CHIP = `(() => { const c = document.getElementById('boardChip'); const st = document.getElementById('boardState'); return c.hidden ? '' : (document.getElementById('boardWhat').textContent + (st.hidden ? '' : ' ' + st.textContent)).trim(); })()`;
    const chipAtStart = await op.until(`${BOARD_CHIP} === 'Board · Chat' && ${BOARD_CHIP}`, 8000);
    const chipDoors = await selfDoors(op, 'board', `document.getElementById('boardChip')`, 'Console.board()');
    const chipPick = async (id) => {
      await unsay(op);
      await op.eval(`document.getElementById('boardChip').click()`);
      await op.until(`!!document.querySelector('.agm-menu [data-action="${id}"]')`, 3000);
      const row = await op.eval(`(() => { const b = document.querySelector('.agm-menu [data-action="${id}"]'); return JSON.stringify({ label: b.querySelector('.mi-label').textContent, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'), why: b.querySelector('.mi-why').textContent }); })()`);
      await op.eval(`document.querySelector('.agm-menu [data-action="${id}"]').click()`);
      return JSON.parse(row);
    };
    // Show the clock from the chip: the toast names the audience, with Undo; Bea's page draws the clock over her chat, by
    // AGMessage's clock, and says so: the chip reads ✓ 1/1.
    const TAKE_LAYER = `(() => { const l = document.getElementById('pageLayer'); if (l.hidden) return ''; const b = document.getElementById('layerBox');
      return JSON.stringify({ kind: l.dataset.kind, time: (b.querySelector('.take-time') || {}).textContent || '', title: (b.querySelector('.take-title') || {}).textContent || '', hall: (b.querySelector('.take-hall') || {}).textContent || '',
        mark: !!b.querySelector('.take-mark'), what: document.getElementById('layerWhat').textContent, acts: [...document.querySelectorAll('#layerActs > [data-action]')].map((x) => x.dataset.action), bar: getComputedStyle(document.getElementById('layerBar')).visibility, focus: document.activeElement === l }); })()`;
    const layerOf = async (t, ok, ms = 8000) => JSON.parse((await t.until(`(() => { const v = ${TAKE_LAYER}; return v && (${ok})(JSON.parse(v)) && v; })()`, ms)) || 'null');
    const clockPick = await chipPick('board.clock');
    const TOAST_SAID = `(() => { const x = document.getElementById('agmToast'); return x && x.classList.contains('show') && x.textContent; })()`;
    const clockSaid = await op.until(TOAST_SAID, 5000);
    const beaClock = await layerOf(beaPad, `(v) => v.kind === 'clock' && /^\\d\\d:\\d\\d:\\d\\d$/.test(v.time)`);
    const chipClock = await op.until(`${BOARD_CHIP} === 'Board · 🕐 Clock ✓ 1/1' && ${BOARD_CHIP}`, 8000);
    await beaPad.shot(path.join(OUT, 'take-clock.png'));
    await op.shot(path.join(OUT, 'board-chip.png'));
    report(chipAtStart === 'Board · Chat' && selfInStep(chipDoors) && chipDoors.want === JSON.stringify(['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank', 'board.web', 'board.screens'])
      && clockPick.label === 'Show the clock' && clockPick.role === 'menuitemradio' && clockPick.checked === 'false' && clockSaid === 'The clock on 1 Board page. · Undo'
      && !!beaClock && beaClock.focus && JSON.stringify(beaClock.acts.filter((a) => a !== 'take.fullscreen')) === '["take.chat","take.minimise"]' && /^Shown to you: the clock · from Ana Admin/.test(beaClock.what || '') && chipClock === 'Board · 🕐 Clock ✓ 1/1',
      `the Board chip reads "Board · Chat", opens its menu by a click, a right-click and Shift+F10 alike; Show the clock is put on Bea's page at once ("${clockSaid}"), drawn over her chat by AGMessage's clock with Back to chat and Minimise, the focus on it, and the chip reads ✓ when her page says so (${JSON.stringify({ chipAtStart, want: chipDoors.want, clockPick, beaClock, chipClock })}${selfInStep(chipDoors) ? '' : '; ' + JSON.stringify(chipDoors)})`);

    // The console, Screens & pages: its People's pages list the Board first, then each person in the hall; each kind drawn
    // from the Board's row: holding (no picture: the AGMessage mark and the hall's name on black), blank (its bar only once
    // touched), Stagewatch (its countdown live, its kind not chosen twice).
    await op.eval(`document.getElementById('headerMore').click()`);
    await op.until(`!!document.querySelector('.agm-menu [data-action="header.screens"]')`, 3000);
    const consoleItem = await op.eval(`document.querySelector('.agm-menu [data-action="header.screens"] .mi-label').textContent`);
    await op.eval(`document.querySelector('.agm-menu [data-action="header.screens"]').click()`);
    await op.until(`document.getElementById('screensDialog').open && !document.getElementById('consoleTabs').hidden`, 5000);
    await op.eval(`document.getElementById('tabPeople').click()`);
    const PAGE_ROWS = `JSON.stringify([...document.querySelectorAll('#peoplePages > li[data-key]')].map((li) => [li.dataset.key === 'board' ? 'board' : li.querySelector('.page-who').textContent.replace(/ ·.*$/, ''), li.querySelector('.page-state').textContent, li.querySelector('.page-showing').textContent]))`;
    const consoleRows = JSON.parse(await op.until(`(() => { const r = JSON.parse(${PAGE_ROWS}); return r.length >= 3 && r.some((x) => x[0] === 'Obi') && JSON.stringify(r); })()`, 5000) || '[]');
    await op.shot(path.join(OUT, 'console-people.png'));
    const boardRow = (id) => op.eval(`(() => { const b = document.querySelector('#peoplePages li[data-key="board"] [data-action="${id}"]'); if (!b) return 'none'; if (b.getAttribute('aria-disabled') === 'true') return 'disabled: ' + b.title; b.click(); return 'pushed'; })()`);
    const holdingPushed = await boardRow('board.holding');
    const beaHolding = await layerOf(beaPad, `(v) => v.kind === 'holding' && v.mark && v.hall === 'Takes hall'`);
    const blankPushed = await boardRow('board.blank');
    const beaBlank = await layerOf(beaPad, `(v) => v.kind === 'blank' && v.bar === 'hidden'`);
    await leftClick(beaPad, { x: 700, y: 500 });
    const beaTouched = await layerOf(beaPad, `(v) => v.kind === 'blank' && v.bar === 'visible'`, 3000);
    const stagePushed = await boardRow('board.stage');
    const beaStage = await layerOf(beaPad, `(v) => v.kind === 'stage' && /\\d/.test(v.time)`, 12000);
    const stageAgain = await op.until(`(() => { const b = document.querySelector('#peoplePages li[data-key="board"] [data-action="board.stage"]'); return b && b.getAttribute('aria-disabled') === 'true' && b.title; })()`, 5000);
    report(consoleItem === 'Screens & pages…' && consoleRows.length >= 3 && consoleRows[0][0] === 'board' && consoleRows.some((r) => r[0] === 'Bea') && consoleRows.some((r) => r[0] === 'Obi')
      && holdingPushed === 'pushed' && !!beaHolding && blankPushed === 'pushed' && !!beaBlank && !!beaTouched && stagePushed === 'pushed' && !!beaStage && stageAgain === 'Already showing Stagewatch.',
      `Screens & pages… lists the Board first and each person in the hall; from the Board's row each kind draws on Bea's page: holding (the mark and the hall's name), blank (its bar once touched), Stagewatch (its countdown), not chosen twice (${JSON.stringify({ consoleItem, consoleRows, beaHolding, beaBlank, beaTouched, beaStage, stageAgain })})`);

    // Escape minimises (never Back to chat): the take is a card at the top of Bea's side bar, whose doors are in step, and
    // the console reads ▭; the card's Show again draws it over her chat again, and the console reads ✓. Her side bar keeps
    // the Board's size with the card in it (half the row): only an observer's is made for a card.
    const BEA_PANEL = `(() => { const p = document.getElementById('docPanel'); const row = p.parentElement.getBoundingClientRect().width; return p.classList.contains('collapsed') ? 'collapsed' : JSON.stringify({ basis: getComputedStyle(p).flexBasis, half: Math.abs(p.getBoundingClientRect().width - row / 2) <= 2 }); })()`;
    const beaPanelBefore = await beaPad.eval(BEA_PANEL);
    await beaPad.eval(`document.getElementById('pageLayer').focus()`);
    await press(beaPad, 'Escape');
    const TAKE_CARD = `(() => { const c = document.querySelector('#takeCards .take-card'); return c && !document.getElementById('takeCards').hidden ? JSON.stringify({ text: c.querySelector('.take-card-what').textContent, pushed: document.body.dataset.pushed || '', layer: !document.getElementById('pageLayer').hidden }) : ''; })()`;
    const beaCard = JSON.parse(await beaPad.until(TAKE_CARD, 5000) || 'null');
    const beaPanelCarded = await beaPad.eval(BEA_PANEL);
    const minimisedSaid = await beaPad.until(TOAST_SAID, 3000);
    const boardState = `(() => { const li = document.querySelector('#peoplePages li[data-key="board"]'); return li ? li.querySelector('.page-state').textContent : ''; })()`;
    const consoleMinimised = await op.until(`/^▭ Bea minimised it/.test(${boardState}) && ${boardState}`, 6000);
    const cardDoors = await doorsOf(beaPad, 'card', `document.querySelector('#takeCards .take-card')`, 'Takes.cardObject()', { bar: '.take-card-acts > .msg-act', hit: '.take-card-name' });
    await beaPad.eval(`document.querySelector('#takeCards [data-action="card.show"]').click()`);
    const beaAgain = await layerOf(beaPad, `(v) => v.kind === 'stage'`, 5000);
    const consoleAgain = await op.until(`/^✓ /.test(${boardState}) && ${boardState}`, 6000);
    const takeDoors = await doorsOf(beaPad, 'take', `document.getElementById('pageLayer')`, 'Takes.object()', { bar: '#layerActs > .msg-act', hit: '#layerWhat' });
    const beaPanelAgain = await beaPad.eval(BEA_PANEL);
    const panelKept = JSON.stringify({ basis: '50%', half: true });
    report(!!beaCard && /Stagewatch/.test(beaCard.text) && beaCard.pushed === '1' && !beaCard.layer && minimisedSaid === 'Minimised to 📺 On stage. · Undo' && !!consoleMinimised
      && doorsInStep(cardDoors) && cardDoors.want === '["card.show","card.remove"]' && !!beaAgain && !!consoleAgain && doorsInStep(takeDoors) && JSON.parse(takeDoors.want).slice(0, 2).join() === 'take.chat,take.minimise'
      && beaPanelCarded === panelKept && [beaPanelBefore, beaPanelAgain].every((x) => x === panelKept || x === 'collapsed'),
      `Escape minimises the take into a card in Bea's side bar ("${minimisedSaid}"; the console: ${consoleMinimised}), its doors in step, the side bar the Board's half of the row before, with the card and after; Show again draws it over her chat again (the console: ${consoleAgain}), and the layer's doors are in step (${JSON.stringify({ beaCard, card: cardDoors.want, take: takeDoors.want, panel: [beaPanelBefore, beaPanelCarded, beaPanelAgain] })}${doorsInStep(cardDoors) ? '' : '; ' + JSON.stringify(cardDoors)}${doorsInStep(takeDoors) ? '' : '; ' + JSON.stringify(takeDoors)})`);

    // Back to chat: the layer goes, no card is left, and the console reads ○ in her name; the toast's Show it again, within
    // 10 s, brings it back (the server takes Back to chat back), and the console reads ✓.
    await unsay(beaPad);
    await beaPad.eval(`document.querySelector('#layerActs [data-action="take.chat"]').click()`);
    const backSaid = await beaPad.until(`(() => { const x = document.getElementById('agmToast'); return x && x.classList.contains('show') && document.getElementById('pageLayer').hidden && document.getElementById('takeCards').hidden && x.textContent; })()`, 3000);
    const consoleBack = await op.until(`/^○ Bea went back to chat/.test(${boardState}) && ${boardState}`, 6000);
    await beaPad.eval(`document.querySelector('#agmToast .toast-undo').click()`);
    const beaShownAgain = await layerOf(beaPad, `(v) => v.kind === 'stage'`, 5000);
    const consoleShownAgain = await op.until(`/^✓ /.test(${boardState}) && ${boardState}`, 6000);
    report(backSaid === 'Back to chat. · Show it again' && !!consoleBack && !!beaShownAgain && !!consoleShownAgain,
      `Back to chat takes the take off Bea's page and leaves no card (the console: ${consoleBack}); "Show it again" within 10 s brings it back (the console: ${consoleShownAgain}) (${JSON.stringify({ backSaid })})`);

    // Undo pushes again: Show the clock from the Board's row, then the toast's Undo puts Stagewatch back as a take of its
    // own over it; before the Undo the chip offers ↶ Back to Stagewatch, after it none (a take made by it undoes nothing).
    const seqNow = () => op.eval(`Console.board().seq`);
    const seqBefore = await seqNow();
    await unsay(op);
    await boardRow('board.clock');
    await layerOf(beaPad, `(v) => v.kind === 'clock'`, 5000);
    await op.until(`Console.board().seq === ${seqBefore + 1}`, 5000);
    const tkBackOffered = await op.eval(`(() => { const i = AGM.catalog.items('board', F, Console.board()).find((x) => x.id === 'board.back'); return i ? i.label : ''; })()`);
    await op.until(`!!document.querySelector('#agmToast.show .toast-undo')`, 3000);
    await op.eval(`document.querySelector('#agmToast .toast-undo').click()`);
    const beaUndone = await layerOf(beaPad, `(v) => v.kind === 'stage'`, 5000);
    const afterUndo = await op.until(`Console.board().seq === ${seqBefore + 2} && Console.board().kind === 'stage' && JSON.stringify(AGM.catalog.ids('board', F, Console.board()))`, 6000);
    report(/^Back to Stagewatch \(undo your Clock, \d{1,2}:\d{2}/.test(tkBackOffered) && !!beaUndone && afterUndo === JSON.stringify(['board.chat', 'board.stage', 'board.clock', 'board.holding', 'board.blank', 'board.web', 'board.screens']),
      `the toast's Undo puts what was shown before back as a new take, and Bea's page draws it; ↶ Back to was offered over this page's own take ("${tkBackOffered}"), and none over the one the Undo made (${afterUndo})`);

    // While the take covers her page, a 🔥 message breaks through in its strip, and another is counted on its bar; Open
    // chat minimises the take and brings the 🔥 message into view.
    await op.eval(`new Promise((r) => socket.emit('message', { type: 'text', text: 'Doors in five' }, r))`);
    await op.eval(`new Promise((r) => socket.emit('message', { type: 'text', text: 'Wrap up now', priority: true }, r))`);
    const stripRead = await beaPad.until(`(() => { const s = document.getElementById('layerStrip'); return !s.hidden && JSON.stringify({ strip: s.textContent.replace(/\\s+/g, ' ').trim(), count: document.getElementById('layerNew').textContent, open: AGM.catalog.ids('take', F, Takes.object()).includes('take.openChat') }); })()`, 5000);
    await beaPad.eval(`document.getElementById('layerOpenChat').click()`);
    const openedChat = await beaPad.until(`(() => { const m = allMessages.find((x) => x.text === 'Wrap up now'); const n = m && messagesById.get(m.id); return document.getElementById('pageLayer').hidden && !!document.querySelector('#takeCards .take-card') && n && document.activeElement === n && 'opened'; })()`, 5000);
    report(stripRead === JSON.stringify({ strip: '🔥 Ana Admin: Wrap up now Open chat', count: '1 new', open: true }) && openedChat === 'opened',
      `a 🔥 message breaks through the take in its strip, another is counted on its bar, and Open chat minimises the take and brings the 🔥 message into view with the focus on it (${stripRead}; ${openedChat})`);

    // A draft keeps its words and its focus: Bea writing when a take arrives keeps the focus in her field while she writes
    // (at most 3 s), and the take then draws over it, her words still there and the focus still hers.
    await beaPad.eval(`(() => { const i = document.getElementById('directorInput'); i.focus(); i.value = 'Half a thought'; return true; })()`);
    await boardRow('board.blank');
    await sleep(1200);
    const whileWriting = await beaPad.eval(`JSON.stringify({ layer: !document.getElementById('pageLayer').hidden, focus: document.activeElement && document.activeElement.id })`);
    const draftKept = await beaPad.until(`(() => { const l = document.getElementById('pageLayer'); const i = document.getElementById('directorInput'); return !l.hidden && l.dataset.kind === 'blank' && JSON.stringify({ value: i.value, focus: document.activeElement === i }); })()`, 5000);
    report(whileWriting === JSON.stringify({ layer: false, focus: 'directorInput' }) && draftKept === JSON.stringify({ value: 'Half a thought', focus: true }),
      `a take never takes the focus from a field being written in: it waits (${whileWriting}), then draws over it, the words and the focus kept (${draftKept})`);

    // The observer's rail: an observer has no side bar, until a take shown to them is minimised. From the console, Obi's
    // row: Show them ▸ Clock; on Obi's page, Minimise puts it in a side bar of its own, with its card.
    const obiPanelBefore = await obiPad.eval(`document.getElementById('docPanel').getClientRects().length > 0`);
    const obiKey = await op.eval(`(() => { const li = [...document.querySelectorAll('#peoplePages > li[data-key]')].find((x) => /^Obi/.test(x.querySelector('.page-who').textContent)); return li ? li.dataset.key : ''; })()`);
    await op.eval(`document.querySelector('#peoplePages li[data-key="${obiKey}"] .obj-more').click()`);
    await op.until(`!!document.querySelector('.agm-menu [data-action="person.show"]')`, 3000);
    const obiMenu = await op.eval(MENU_IDS);
    await op.eval(`document.querySelector('.agm-menu [data-action="person.show"]').click()`);
    await op.until(`!!document.querySelector('.agm-sub [data-value="clock"]')`, 3000);
    await op.eval(`document.querySelector('.agm-sub [data-value="clock"]').click()`);
    const obiClock = await layerOf(obiPad, `(v) => v.kind === 'clock'`);
    await obiPad.eval(`document.querySelector('#layerActs [data-action="take.minimise"]').click()`);
    const obiRail = await obiPad.until(`(() => { const p = document.getElementById('docPanel'); return p.getClientRects().length > 0 && !!document.querySelector('#takeCards .take-card') && document.body.dataset.pushed === '1' && JSON.stringify({ card: document.querySelector('#takeCards .take-card .take-card-name').textContent, doc: getComputedStyle(document.getElementById('docDisplay')).display }); })()`, 5000);
    await obiPad.shot(path.join(OUT, 'take-card-observer.png'));
    report(obiPanelBefore === false && obiMenu === JSON.stringify(['person.show', 'person.web', 'person.doc', 'person.chat']) && !!obiClock && obiRail === JSON.stringify({ card: 'Clock', doc: 'none' }),
      `an observer has no side bar until a take shown to them is minimised: from the console's row, Show them ▸ Clock reaches Obi's page, and Minimise puts it in a side bar of its own with its card (${JSON.stringify({ obiPanelBefore, obiMenu, obiRail })})`);

    // ---------------- A web page on people's pages (unit 19): its own right, the one frame, opened or not loaded ----------------
    // Bea back to the view by her seat, the simple view, live: from the People panel of the admin's own page, her row's
    // Chat view ▸ (Full checked, as the admin's people list says it), By seat.
    const beaBySeat = JSON.parse(await op.eval(`(() => { const u = people.find((x) => x.name === 'Bea'); const p = u && personNow(u.uid); if (!p) return 'null';
      const shown = AGM.catalog.shown('person', F, p).some((e) => e.id === 'person.chatView');
      const sub = (AGM.catalog.submenu('person', 'person.chatView', F, p) || []).map((v) => v.label + (v.checked ? ' ✓' : ''));
      act('person', 'person.chatView', p, { value: '' }); return JSON.stringify({ shown, sub }); })()`) || 'null');
    const beaSimpleAgain = await beaPad.until(`document.body.dataset.view === 'simple' && F.view === 'simple' && 'simple'`, 5000);
    const beaRowSays = await op.until(`(() => { const u = people.find((x) => x.name === 'Bea'); return u && u.view === '' && 'by seat'; })()`, 5000);
    report(!!beaBySeat && beaBySeat.shown && JSON.stringify(beaBySeat.sub) === JSON.stringify(['By seat', 'Simple', 'Full ✓']) && beaSimpleAgain === 'simple' && beaRowSays === 'by seat',
      `the People panel's Chat view ▸ on the admin's own page (By seat · Simple · Full, Full checked) gives Bea's page back the view by her seat, the simple view, live, and her row says it (${JSON.stringify({ beaBySeat, beaRowSays })})`);
    // The browser answers the venue's web page itself (agm-web.invalid: a page of a few words) and never answers the stuck
    // one (agm-test.invalid) before the page's 15 s are up: what each frame then does is what a real site's would.
    const WEB_OK = 'https://agm-web.invalid/vote';
    const WEB_STUCK = 'https://agm-test.invalid/';
    for (const t of [op, beaPad, obiPad]) {
      t.on('Fetch.requestPaused', (p) => {
        if (p.request.url.startsWith('https://agm-web.invalid/')) t.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><title>Vote</title><p>Vote now</p>').toString('base64') });
        else setTimeout(() => { t.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'NameNotResolved' }); }, 18000);
      });
      await t.send('Fetch.enable', { patterns: [{ urlPattern: 'https://agm-web.invalid/*', requestStage: 'Request' }, { urlPattern: 'https://agm-test.invalid/*', requestStage: 'Request' }] });
      t.expectFailure(/agm-test\.invalid/);   // the stuck page's own load error, once it is let go
    }
    /** The ask Show a web page… opened: its title and answers read, its address typed, and one answer chosen. */
    const askWeb = async (url, answer) => {
      await op.until(`!!document.querySelector('.agm-ask input[name="url"]')`, 3000);
      return op.eval(`(() => { const box = document.querySelector('.agm-ask'); box.querySelector('input[name="url"]').value = ${codeLiteral(url)};
        const said = JSON.stringify({ title: box.querySelector('.agm-ask-title').textContent, answers: [...box.querySelectorAll('[data-answer]')].map((b) => b.dataset.answer + '=' + b.textContent) });
        box.querySelector('[data-answer="${answer}"]').click(); return said; })()`);
    };
    /** A frame as a page drew it: its attributes, where it points, how many frames the page holds, the strip's words. */
    const FRAME = (sel) => `(() => { const f = document.querySelector(${codeLiteral(sel)}); return f ? JSON.stringify({ sandbox: f.getAttribute('sandbox'), referrer: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow'),
      credentialless: f.credentialless === true, title: f.title, src: f.src, frames: document.querySelectorAll('iframe').length }) : ''; })()`;
    const FRAMED = (url, host) => ({ sandbox: 'allow-scripts allow-same-origin', referrer: 'no-referrer', allow: '', credentialless: true, title: 'Web page from ' + host, src: url, frames: 1 });
    // From the console's Board row: Show a web page… asks for the address; Preview frames it on the operator's own page
    // first, in the one frame; Show it there puts it on Bea's page, which reports ◇ opened once it loads (never ✓). It is
    // information over the show: the clock the Board shows stays under it, said so (◐ under a web page), and the chip reads
    // both, the show and what is over it.
    await boardRow('board.clock');
    await layerOf(beaPad, `(v) => v.kind === 'clock'`, 5000);
    await unsay(op);
    /** The console's Board row: what is over the show, in its words ('' for nothing). */
    const BOARD_OVER = `(() => { const li = document.querySelector('#peoplePages li[data-key="board"]'); const m = li && /· over it: (.*)$/.exec(li.querySelector('.page-showing').textContent); return m ? m[1] : ''; })()`;
    const CHIP_OVER = `(() => { const o = document.getElementById('boardOver'); return o.hidden ? '' : o.textContent.trim(); })()`;
    const webPushed = await boardRow('board.web');
    const webAsked = JSON.parse(await askWeb(WEB_OK, 'preview'));
    const previewFrame = JSON.parse(await op.until(`document.getElementById('webPreview').open && ${FRAME('#webPreviewBox iframe')}`, 5000) || 'null');
    const previewHost = await op.eval(`document.getElementById('webPreviewHost').textContent`);
    await op.shot(path.join(OUT, 'web-preview.png'));
    const beaBeforeShow = await beaPad.eval(`document.getElementById('pageLayer').dataset.kind || 'chat'`);
    await op.eval(`document.getElementById('webPreviewShow').click()`);
    const beaWeb = JSON.parse(await beaPad.until(`document.getElementById('pageLayer').dataset.kind === 'web' && ${FRAME('#layerBox iframe')}`, 8000) || 'null');
    const beaWebBar = await beaPad.eval(`JSON.stringify({ note: document.querySelector('#layerBox .take-web-note').textContent, acts: [...document.querySelectorAll('#layerActs > [data-action]')].map((x) => x.dataset.action).filter((a) => a !== 'take.fullscreen'), what: document.getElementById('layerWhat').textContent.replace(/ · \\d.*$/, '') })`);
    const webOpened = await op.until(`/\\(Opened/.test(${BOARD_OVER}) && ${BOARD_OVER}`, 10000);
    const chipWeb = await op.until(`${BOARD_CHIP} === 'Board · 🕐 Clock ◐ 0/1' && ${CHIP_OVER} === '· 🌍 Web page ◇ 1/1' && ${BOARD_CHIP} + ' ' + ${CHIP_OVER}`, 6000);
    const clockUnder = await op.until(`/^◐ Under a web page/.test(${boardState}) && ${boardState}`, 6000);
    const previewGone = await op.eval(`!document.getElementById('webPreview').open && !document.querySelector('#webPreviewBox iframe')`);
    await beaPad.shot(path.join(OUT, 'take-web.png'));
    report(webPushed === 'pushed' && JSON.stringify(webAsked) === JSON.stringify({ title: 'Show a web page on the Board\'s pages', answers: ['preview=Preview', 'show=Show it', 'no=Cancel'] })
      && JSON.stringify(previewFrame) === JSON.stringify(FRAMED(WEB_OK, 'agm-web.invalid')) && previewHost === 'agm-web.invalid' && beaBeforeShow !== 'web'
      && JSON.stringify(beaWeb) === JSON.stringify(FRAMED(WEB_OK, 'agm-web.invalid')) && previewGone
      && beaWebBar === JSON.stringify({ note: 'A web page chosen by Ana Admin (agm-web.invalid). Don\'t type passwords here.', acts: ['take.chat', 'take.minimise'], what: 'Shown to you: a web page · from Ana Admin' })
      && webOpened === 'a web page on agm-web.invalid (Opened · AGMessage can\'t see inside web pages)' && chipWeb === 'Board · 🕐 Clock ◐ 0/1 · 🌍 Web page ◇ 1/1' && clockUnder === '◐ Under a web page',
      `Show a web page… asks for its address; Preview frames it on the operator's page alone, and Show it there puts it on Bea's page in the one frame (sandboxed for scripts alone, no referrer, no feature, no cookies, its host in its title), with AGMessage's strip and, in her simple view, the layer's buttons alone; it reads ◇ opened once it loads, never ✓ (${JSON.stringify({ webAsked, previewFrame, beaWeb, beaWebBar, webOpened, chipWeb })})`);
    // In the full view, Open in a new tab is in the layer's ⋯ (and its right-click), never on its bar: from the console,
    // Obi's row, Show them a web page… puts it on his page.
    await unsay(op);
    await op.eval(`document.querySelector('#peoplePages li[data-key="${obiKey}"] .obj-more').click()`);
    await op.until(`!!document.querySelector('.agm-menu [data-action="person.web"]')`, 3000);
    await op.eval(`document.querySelector('.agm-menu [data-action="person.web"]').click()`);
    const obiAsked = JSON.parse(await askWeb(WEB_OK, 'show'));
    const obiWebBar = await obiPad.until(`document.getElementById('pageLayer').dataset.kind === 'web' && !!document.querySelector('#layerBox iframe') && JSON.stringify([...document.querySelectorAll('#layerActs > [data-action]')].map((x) => x.dataset.action).filter((a) => a !== 'take.fullscreen'))`, 8000);
    await obiPad.eval(`document.querySelector('#layerActs .obj-more').click()`);
    const obiWebMenu = await obiPad.until(`!!document.querySelector('.agm-menu [data-action="take.tab"]') && ${MENU_IDS}`, 3000);
    await obiPad.eval(`AGM.menu.close()`);
    report(obiAsked.title === 'Show a web page on Obi\'s pages' && obiWebBar === JSON.stringify(['take.chat', 'take.minimise']) && !!obiWebMenu && JSON.parse(obiWebMenu).filter((a) => a !== 'take.fullscreen').join() === 'take.chat,take.minimise,take.tab',
      `in the full view a web page's Open in a new tab is in the layer's ⋯, never on its bar: Show them a web page… from Obi's row (${JSON.stringify({ obiAsked, obiWebBar, obiWebMenu })})`);
    // One that never loads: on Bea's page at once as it loads, and △ once its 15 s are up, Back to chat and Open in a new
    // tab still there.
    await unsay(op);
    await boardRow('board.web');
    await askWeb(WEB_STUCK, 'show');
    const stuckUp = JSON.parse(await beaPad.until(`(() => { const f = document.querySelector('#layerBox iframe'); return f && f.src === ${codeLiteral(WEB_STUCK)} && ${FRAME('#layerBox iframe')}; })()`, 4000) || 'null');
    const stuckWaiting = await op.until(`/agm-test\\.invalid \\(Sending/.test(${BOARD_OVER}) && ${BOARD_OVER}`, 4000);
    const stuckFailed = await op.until(`/agm-test\\.invalid \\(Couldn/.test(${BOARD_OVER}) && ${BOARD_OVER}`, 25000);
    const stuckBar = await beaPad.eval(`JSON.stringify([...document.querySelectorAll('#layerActs > [data-action]')].map((x) => x.dataset.action).filter((a) => a !== 'take.fullscreen'))`);
    report(!!stuckUp && stuckUp.src === WEB_STUCK && /\(Sending/.test(stuckWaiting) && stuckFailed === 'a web page on agm-test.invalid (Couldn\'t show it: the page did not load)' && stuckBar === JSON.stringify(['take.chat', 'take.minimise']),
      `a web page that never loads is on Bea's page at once (${stuckWaiting}), and reads △ once its 15 s are up (${stuckFailed}), Back to chat still on its bar (${stuckBar})`);

    // ---------------- Information over the show (unit 24): Back to chat returns to the show under it, Earlier keeps what
    // was taken off (a Look), information over the operator's blank is held until a touch, and Take down hands back the
    // information alone ----------------
    await beaPad.eval(`document.querySelector('#layerActs [data-action="take.chat"]').click()`);
    const backToClock = await layerOf(beaPad, `(v) => v.kind === 'clock'`, 5000);
    const EARLIER_LIST = `JSON.stringify([...document.querySelectorAll('#takeEarlier .take-earlier-item')].map((li) => [li.querySelector('.take-card-name').textContent, [...li.querySelectorAll('[data-action]')].map((b) => b.dataset.action)]))`;
    const beaEarlier = JSON.parse(await beaPad.until(`(() => { const v = ${EARLIER_LIST}; return JSON.parse(v).length === 2 && v; })()`, 5000) || 'null');
    await beaPad.eval(`document.querySelector('#takeEarlier [data-action="past.look"]').click()`);
    const lookFrame = await beaPad.until(`document.getElementById('webPreview').open && JSON.stringify({ host: document.getElementById('webPreviewHost').textContent, show: !document.getElementById('webPreviewShow').hidden, frames: document.querySelectorAll('#webPreviewBox iframe').length })`, 5000);
    await beaPad.eval(`document.getElementById('webPreview').close()`);
    report(!!backToClock && JSON.stringify(beaEarlier) === JSON.stringify([['agm-test.invalid', ['past.look']], ['agm-web.invalid', ['past.look']]])
      && lookFrame === JSON.stringify({ host: 'agm-test.invalid', show: false, frames: 1 }),
      `Back to chat on the web page returns Bea's page to the clock under it, and her side bar's Earlier keeps what was taken off, the last first, each a Look that frames it on her page alone with nothing to show from there (${JSON.stringify({ beaEarlier, lookFrame })})`);
    // The operator's blank keeps the tablet dark: a web page put over it is held ("Held under blank"), and Bea's touch shows
    // "1 from backstage", which draws it over the blank; Take down from the chip hands the information back alone, the
    // blank under it again.
    await boardRow('board.blank');
    await layerOf(beaPad, `(v) => v.kind === 'blank'`, 5000);
    await unsay(op);
    await boardRow('board.web');
    await askWeb(WEB_OK, 'show');
    const heldSaid = await op.until(`/agm-web\\.invalid \\(Held under blank/.test(${BOARD_OVER}) && ${BOARD_OVER}`, 8000);
    const stillBlank = await beaPad.eval(`document.getElementById('pageLayer').dataset.kind`);
    await leftClick(beaPad, { x: 700, y: 500 });
    const heldBar = await beaPad.until(`(() => { const b = document.querySelector('#layerActs [data-action="take.held"]'); return b && /1 from backstage/.test(b.textContent) && document.getElementById('pageLayer').dataset.kind === 'blank' && 'held'; })()`, 3000);
    await beaPad.eval(`document.querySelector('#layerActs [data-action="take.held"]').click()`);
    const heldShown = await beaPad.until(`document.getElementById('pageLayer').dataset.kind === 'web' && !!document.querySelector('#layerBox iframe') && 'web'`, 5000);
    const heldOpened = await op.until(`/agm-web\\.invalid \\(Opened/.test(${BOARD_OVER}) && ${BOARD_OVER}`, 8000);
    const takeDownRow = await chipPick('board.takeDown');
    const downToBlank = await beaPad.until(`document.getElementById('pageLayer').dataset.kind === 'blank' && 'blank'`, 5000);
    const overGone = await op.until(`${CHIP_OVER} === '' && ${BOARD_OVER} === '' && ${BOARD_CHIP}`, 6000);
    report(heldSaid === 'a web page on agm-web.invalid (Held under blank)' && stillBlank === 'blank' && heldBar === 'held' && heldShown === 'web' && /\(Opened/.test(heldOpened || '')
      && takeDownRow.label === 'Take down' && downToBlank === 'blank' && /^Board · 🌑 Blank/.test(overGone || ''),
      `a web page over the operator's blank is held (${heldSaid}), Bea's touch shows "1 from backstage", which draws it over the blank; the chip's Take down hands the information back alone, her page back to the blank (${JSON.stringify({ stillBlank, heldBar, heldShown, takeDownRow, overGone })})`);

    // ---------------- A researcher's own right (canShow, unit 24): a Staff account granted stage.web, backstage in the takes
    // hall, has the Board chip and a reduced console (the Board and the people On stage alone). Over the operator's web
    // page its Take down is disabled with why, and its own web page goes to the Board's side bar beside the operator's:
    // drawn there in the one frame, the panel opened, its toast offering Take down (never Undo). Under the operator's page
    // on Bea's layer it is said to be under it; once she minimises that, it is opened in her side bar. Show over the chat
    // draws it over her chat; its own Take down takes it off there alone, the operator's left ----------------
    const WEB_NOTES = 'https://agm-web.invalid/notes';
    await chatViewOf('Bea', 'full');
    await beaPad.until(`document.body.dataset.view === 'full'`, 5000);
    await boardRow('board.chat');
    await beaPad.until(`document.getElementById('pageLayer').hidden && 'chat'`, 5000);
    await unsay(op);
    await boardRow('board.web');
    await askWeb(WEB_OK, 'show');
    await beaPad.until(`(() => { const f = document.querySelector('#layerBox iframe'); return f && f.src === ${codeLiteral(WEB_OK)} && 'web'; })()`, 8000);
    // Made by the admin account the operator's page is signed in as (the laptop's token makes no account).
    const sueMade = await op.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sue', name: 'Sue Staff', role: 'staff', halls: ['${tkHall}'], grant: ['stage.web'], password: 'notes on the lectern' }) }).then((r) => r.status)`);
    const sueTab = await edge.tab(`${base}/build.js`, { alone: true });
    await sueTab.until(`document.readyState === 'complete'`);
    const sueIn = await sueTab.eval(`(async () => { for (let i = 0; i < 5; i++) { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sue', password: 'notes on the lectern' }) }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; })()`);
    await sueTab.send('Page.navigate', { url: `${base}/app.html?code=${tkHall}&as=account&role=research` });
    const sueReady = await sueTab.until(`typeof joined !== 'undefined' && joined && F.canShow && !F.canPush && F.canWeb && !document.getElementById('boardChip').hidden && !!Console.board() && !!Console.board().info && 'ready'`, 10000);
    /** Sue's Board chip opened: each act's id, and the words of one that is disabled ('' for one that is not). */
    const sueChip = async () => {
      await sueTab.eval(`AGM.menu.close(); document.getElementById('boardChip').click()`);
      await sueTab.until(`!!document.querySelector('.agm-menu [data-action]')`, 3000);
      return JSON.parse(await sueTab.eval(`JSON.stringify([...document.querySelectorAll('.agm-menu [data-action]')].map((b) => [b.dataset.action, b.getAttribute('aria-disabled') === 'true' ? b.querySelector('.mi-why').textContent : '']))`));
    };
    const sueMenu = await sueChip();
    const sueRows = JSON.parse(await sueTab.eval(PAGE_ROWS)).map((r) => r[0]);
    await sueTab.eval(`document.querySelector('.agm-menu [data-action="board.web"]').click()`);
    await sueTab.until(`!!document.querySelector('.agm-ask input[name="url"]')`, 3000);
    await sueTab.eval(`(() => { const box = document.querySelector('.agm-ask'); box.querySelector('input[name="url"]').value = ${codeLiteral(WEB_NOTES)}; box.querySelector('[data-answer="show"]').click(); return true; })()`);
    const sueSaid = await sueTab.until(TOAST_SAID, 5000);
    const BESIDE_CARD = `(() => { const li = document.querySelector('#takeCards li.take-card-side[data-layer="beside"]'); const f = li && li.querySelector('.take-card-box iframe'); return f ? JSON.stringify({ sandbox: f.getAttribute('sandbox'), referrer: f.getAttribute('referrerpolicy'), allow: f.getAttribute('allow'),
      credentialless: f.credentialless === true, title: f.title, src: f.src, open: !document.getElementById('docPanel').classList.contains('collapsed'), rail: document.getElementById('docExpandRail').textContent,
      over: (document.querySelector('#layerBox iframe') || {}).src || '', acts: [...li.querySelectorAll('.take-card-acts [data-action]')].map((b) => b.dataset.action) }) : ''; })()`;
    const beaBeside = JSON.parse(await beaPad.until(BESIDE_CARD, 8000) || 'null');
    /** What Sue's console reads beside the operator's, and over the show: [mark, words]. */
    const SUE_READS = (re) => `(() => { const b = Console.board(); return b && b.beside && b.info && ${re}.test(b.beside.words) ? JSON.stringify({ beside: [b.beside.mark, b.beside.words, b.beside.arrive, b.beside.op], info: [b.info.mark, b.info.words, b.info.op] }) : ''; })()`;
    const sueUnder = JSON.parse(await sueTab.until(SUE_READS('/^Under/'), 10000) || 'null');
    await beaPad.shot(path.join(OUT, 'take-beside.png'));
    // Bea minimises the operator's page: hers is in view in the side bar now, and said opened there.
    await beaPad.eval(`document.querySelector('#layerActs [data-action="take.minimise"]').click()`);
    const sueOpened = JSON.parse(await sueTab.until(SUE_READS('/^Opened/'), 10000) || 'null');
    const sueChipWords = await sueTab.eval(`document.getElementById('boardOver').textContent.trim()`);
    await beaPad.shot(path.join(OUT, 'take-beside-open.png'));
    // Show over the chat: Bea's own choice draws it on her layer, the operator's still a card.
    await beaPad.eval(`document.querySelector('#takeCards li[data-layer="beside"] [data-action="card.show"]').click()`);
    const beaRaised = await beaPad.until(`(() => { const f = document.querySelector('#layerBox iframe'); return f && f.src === ${codeLiteral(WEB_NOTES)} && !document.querySelector('#takeCards li[data-layer="beside"]') && !!document.querySelector('#takeCards li[data-layer="info"]') && 'over the chat'; })()`, 5000);
    // Its own Take down, from Sue's chip, takes off what is beside the operator's alone: the operator's left.
    const sueDownMenu = await sueChip();
    await unsay(sueTab);
    await sueTab.eval(`document.querySelector('.agm-menu [data-action="board.takeDown"]').click()`);
    const sueDownSaid = await sueTab.until(TOAST_SAID, 5000);
    const beaBack = await beaPad.until(`document.getElementById('pageLayer').hidden && !document.querySelector('#takeCards li[data-layer="beside"]') && !!document.querySelector('#takeCards li[data-layer="info"]') && 'back'`, 8000);
    await sueTab.until(`!!Console.board() && !Console.board().beside && 'read'`, 5000);
    const sueAfter = await sueChip();
    await sueTab.eval(`AGM.menu.close()`);
    report(sueMade === 200 && sueIn === 200 && sueReady === 'ready'
      && JSON.stringify(sueMenu) === JSON.stringify([['board.web', ''], ['board.takeDown', 'The operator put this up — ask them.'], ['board.screens', ''], ['board.withdraw', 'Only who showed it, the operator or the admin can withdraw it.']]) && JSON.stringify(sueRows) === JSON.stringify(['board', 'Bea'])
      && sueSaid === 'The web page on 1 Board page — in their side bar, beside what the operator is showing. · Take down · Withdraw'
      && !!beaBeside && JSON.stringify(beaBeside) === JSON.stringify({ ...FRAMED(WEB_NOTES, 'agm-web.invalid'), frames: undefined, open: true, rail: '📺 On stage • 1', over: WEB_OK, acts: ['card.show', 'card.remove'] })
      && !!sueUnder && JSON.stringify(sueUnder) === JSON.stringify({ beside: ['◐', 'Under a web page', 'side', false], info: ['◇', 'Opened · AGMessage can\'t see inside web pages', true] })
      && !!sueOpened && JSON.stringify(sueOpened.beside) === JSON.stringify(['◇', 'Opened · AGMessage can\'t see inside web pages', 'side', false]) && /^▭ Bea minimised it/.test(sueOpened.info.slice(0, 2).join(' ')) && sueChipWords === '· 🌍 Web page ▭ 0/1'
      && beaRaised === 'over the chat' && JSON.stringify(sueDownMenu.find((x) => x[0] === 'board.takeDown')) === JSON.stringify(['board.takeDown', ''])
      && sueDownSaid === 'Taken down on 1 Board page.' && beaBack === 'back' && JSON.stringify(sueAfter.find((x) => x[0] === 'board.takeDown')) === JSON.stringify(['board.takeDown', 'The operator put this up — ask them.']),
      `a Staff account granted stage.web reads the Board and the people On stage alone; over the operator's web page its Take down and Withdraw are disabled with why, and its own web page goes beside it, in Bea's side bar in the one frame, the panel opened, its toast offering Take down and Withdraw; under the operator's page on her layer it reads ◐ under it, and ◇ opened in her side bar once she minimises that; Show over the chat draws it on her layer, and its Take down takes it off there alone, the operator's left (${JSON.stringify({ sueMade, sueIn, sueReady, sueMenu, sueRows, sueSaid, beaBeside, sueUnder, sueOpened, sueChipWords, beaRaised, sueDownMenu, sueDownSaid, beaBack, sueAfter })})`);
    await chipPick('board.takeDown');
    await beaPad.until(`!document.querySelector('#takeCards li[data-layer="info"]') && 'gone'`, 5000);

    // A locked hall's backstage guest shows web pages only while the admin lets the hall's guests (S4): the Roles & invites
    // panel's switch, off and disabled with its words while the roles are open; locked, turned on, Rex's Board chip offers
    // Show a web page… at once, without a reload.
    const rexPad = await edge.tab(`${base}/app.html?code=${tkHall}&name=Rex&role=research`, { alone: true });
    await rexPad.until(`typeof joined !== 'undefined' && joined`, 10000);
    const GUEST_WEB = `(() => { const row = document.getElementById('guestWebRow'); const box = document.getElementById('guestWeb'); return row.hidden || document.getElementById('invitesPanel').hidden ? '' : JSON.stringify({ label: box.parentElement.textContent.trim(), on: box.checked, disabled: box.disabled, words: document.getElementById('guestWebWords').textContent }); })()`;
    await admin.eval(`ADMIN_RUN['adminRoom.invites']({ code: '${tkHall}' })`);
    const switchOpen = JSON.parse(await admin.until(GUEST_WEB, 5000) || 'null');
    // An open hall's panel shows its On stage link (On stage seats come from it, in open halls too), with New On stage
    // link, which asks first and voids the link it replaces without changing the code.
    const INVITE_ROWS = `(() => { const rows = [...document.querySelectorAll('#inviteLinks .invite-row')]; return rows.length ? JSON.stringify({ roles: rows.map((r) => r.dataset.role), words: document.querySelector('#inviteLinks .hint').textContent, renew: rows[0].querySelector('.invite-new').textContent, link: rows[0].querySelector('code').textContent }) : ''; })()`;
    const openLinks = JSON.parse(await admin.until(INVITE_ROWS, 5000) || 'null');
    await admin.eval(`document.querySelector('#inviteLinks .invite-new').click()`);
    await admin.until(`!!document.querySelector('.agm-ask [data-answer=yes]')`, 3000);
    await admin.eval(`document.querySelector('.agm-ask [data-answer=yes]').click()`);
    const renewedLinks = JSON.parse(await admin.until(`(() => { const v = ${INVITE_ROWS}; return v && JSON.parse(v).link !== ${codeLiteral((openLinks && openLinks.link) || '')} && v; })()`, 5000) || 'null');
    const inviteRow = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'room.invite').pop();
    report(!!openLinks && JSON.stringify(openLinks.roles) === '["board"]' && openLinks.words === 'Open: anyone with the code joins Backstage or as an Observer; On stage needs this link.' && openLinks.renew === '🔄 New On stage link'
      && openLinks.link.includes('?code=' + tkHall + '&role=board&invite=') && !!renewedLinks && renewedLinks.link.includes('?code=' + tkHall + '&role=board&invite=') && !!inviteRow && inviteRow.words === 'a new On stage link (the old one no longer admits)',
      `the Roles & invites panel shows an open hall's On stage link, with its words; New On stage link asks, then replaces it under the same code, one row with no link (${JSON.stringify({ openLinks, renewedLinks: renewedLinks && renewedLinks.link })})`);
    await admin.eval(`document.getElementById('lockRoles').click()`);
    const switchLocked = JSON.parse(await admin.until(`(() => { const v = ${GUEST_WEB}; return v && !JSON.parse(v).disabled && v; })()`, 5000) || 'null');
    await rexPad.send('Page.reload');
    await rexPad.until(`typeof joined !== 'undefined' && joined && F.canPush && !document.getElementById('boardChip').hidden`, 10000);
    const rexBefore = await rexPad.eval(`window.rexStays = 1; JSON.stringify({ canWeb: F.canWeb, web: AGM.catalog.ids('board', F, Console.board()).includes('board.web') })`);
    await admin.eval(`document.getElementById('guestWeb').click()`);
    const switchOn = JSON.parse(await admin.until(`(() => { const v = ${GUEST_WEB}; return v && JSON.parse(v).on && v; })()`, 5000) || 'null');
    const rexAfter = await rexPad.until(`F.canWeb && AGM.catalog.ids('board', F, Console.board()).includes('board.web') && JSON.stringify({ canWeb: F.canWeb, web: true, samePage: window.rexStays === 1 })`, 5000);
    await admin.shot(path.join(OUT, 'guest-web-switch.png'));
    report(!!switchOpen && switchOpen.label === 'Backstage guests may show web pages on people\'s pages' && !switchOpen.on && switchOpen.disabled && switchOpen.words === 'Lock the roles first: in an open hall, code guests show nothing.'
      && !!switchLocked && !switchLocked.on && /^Off by default\./.test(switchLocked.words) && rexBefore === JSON.stringify({ canWeb: false, web: false })
      && !!switchOn && rexAfter === JSON.stringify({ canWeb: true, web: true, samePage: true }),
      `the Roles & invites panel's switch for the hall's backstage guests' web pages: off and disabled with its words while the roles are open, offered once locked; turned on, a backstage guest's Board chip offers Show a web page… without a reload, absent before (${JSON.stringify({ switchOpen, switchLocked, rexBefore, switchOn, rexAfter })})`);
    // Unlocking the hall turns it off: the switch says so at once, and Rex's chip loses Show a web page… without a reload.
    await admin.eval(`document.getElementById('lockRoles').click()`);
    const switchUnlocked = JSON.parse(await admin.until(`(() => { const v = ${GUEST_WEB}; return v && JSON.parse(v).disabled && v; })()`, 5000) || 'null');
    const rexUnlocked = await rexPad.until(`!F.canWeb && JSON.stringify({ canWeb: F.canWeb, web: AGM.catalog.ids('board', F, Console.board()).includes('board.web'), samePage: window.rexStays === 1 })`, 5000);
    report(!!switchUnlocked && !switchUnlocked.on && switchUnlocked.words === 'Lock the roles first: in an open hall, code guests show nothing.' && rexUnlocked === JSON.stringify({ canWeb: false, web: false, samePage: true }),
      `unlocking the hall turns its backstage guests' web pages off: the switch off and disabled again, and Rex's chip without Show a web page… (${JSON.stringify({ switchUnlocked, rexUnlocked })})`);
    await admin.eval(`document.getElementById('closeInvitesBtn').click()`);

    const takesProblems = [['op', op], ['bea', beaPad], ['obi', obiPad], ['rex', rexPad], ['sue', sueTab]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
    report(takesProblems.length === 0, `the takes hall's pages: no console error and no CSP violation${takesProblems.length ? ' — ' + takesProblems.slice(0, 4).join(' | ') : ''}`);
    await op.eval(`document.getElementById('screensDialog').close()`);
    for (const t of [beaPad, obiPad, rexPad, sueTab, op]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }

    // ---------------- A document and a picture on the stage (unit 25): drawn from memory, kept by no device ----------------
    // In a hall of its own: the admin as the operator, from a socket of its own, its files uploaded fresh (never
    // posted, so no page opens them itself); Bo On stage (the simple view, by her seat) and Oz observing (the full view),
    // each a device of its own whose fetches and object URLs are counted from before its own scripts.
    {
      const fsHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Files hall' }) })).json()).code;
      const fsOp = await connect(base, cookie);
      // An act asked again while the server says this address is busy (the smoke's many pages share one address).
      const asked = async (ev, args) => { let r = null; for (let i = 0; i < 40; i++) { r = await emit(fsOp, ev, args); if (!(r && r.busy)) return r; await sleep(Math.min(2000, (r && r.retryMs) || 500)); } return r; };
      const fsJoin = await asked('join', { roomCode: fsHall, name: 'Desk', role: 'research' });
      const fresh = async (name, type, bytes) => {
        for (let i = 0; i < 8; i++) {
          const fd = new FormData();
          fd.append('file', new Blob([bytes], { type }), name);
          const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': fsJoin.uploadToken }, body: fd });
          if (r.status !== 429) return (await r.json()).url;
          await sleep(2500);
        }
        return '';
      };
      const picUrl = await fresh('stage plan.png', 'image/png', pngOf(64, 48));
      const pdfUrl = await fresh('board pack.pdf', 'application/pdf', fixture('board-pack-tagged.pdf'));
      const FETCHES = `(() => { const f = window.fetch; window.__fetched = []; window.fetch = function (u, o) { window.__fetched.push([String(u && u.url ? u.url : u), (o && o.cache) || '']); return f.apply(this, arguments); }; })();`;
      const bo = await edge.tab(`${base}/app.html?code=${fsHall}&name=Bo&role=board&invite=${inviteOf(dataDir, fsHall)}`, { init: DOC_PROBE + FETCHES, alone: true });
      const oz = await edge.tab(`${base}/app.html?code=${fsHall}&name=Oz&role=observer`, { init: DOC_PROBE + FETCHES, alone: true });
      for (const t of [bo, oz]) await t.until(`typeof joined !== 'undefined' && joined`, 10000);
      // Ready before its first take: a Board page imports what draws one and the document reader 2 s after its join, with
      // import() and a timer, and no modulepreload; an observer's page waits for its first take.
      const IMPORTED = `JSON.stringify({ layer: performance.getEntriesByType('resource').some((e) => /\\/pagelayer\\.mjs$/.test(e.name)), reader: performance.getEntriesByType('resource').some((e) => /\\/docview\\.mjs$/.test(e.name)), preload: document.querySelectorAll('link[rel=modulepreload]').length })`;
      const boEarly = JSON.parse(await bo.eval(IMPORTED));
      const boReady = await bo.until(`(() => { const v = ${IMPORTED}; const x = JSON.parse(v); return x.layer && x.reader && v; })()`, 6000);
      const ozReady = JSON.parse(await oz.eval(IMPORTED));
      report(!!boReady && JSON.stringify(JSON.parse(boReady)) === JSON.stringify({ layer: true, reader: true, preload: 0 }) && !boEarly.layer && !ozReady.layer,
        `a Board page imports the take layer and the document reader 2 s after its join, with no modulepreload; an observer's page imports none before a take (${JSON.stringify({ boEarly, boReady, ozReady })})`);

      // A picture over the Board's chat: fetched no-store and drawn through an object URL, never draggable, no download link.
      const push = (to, content) => asked('page:push', { code: fsHall, to, content });
      const urlsNow = (t) => t.eval(`JSON.stringify({ made: window.__urls.made.length, revoked: window.__urls.revoked.length })`).then(JSON.parse);
      const boUrls0 = await urlsNow(bo);
      const picTake = await push('board', { kind: 'image', url: picUrl });
      const LAYER_FILE = `(() => { const l = document.getElementById('pageLayer'); const b = document.getElementById('layerBox'); const img = b.querySelector('img');
        return !l.hidden && l.dataset.kind && JSON.stringify({ kind: l.dataset.kind, img: !!img && img.complete && img.naturalWidth > 0, blob: !!img && img.src.startsWith('blob:'), drag: img ? img.getAttribute('draggable') : null,
          line: (b.querySelector('.take-file-line') || {}).textContent || '', download: document.querySelectorAll('a[download], [download]').length,
          fetched: window.__fetched.filter((x) => /\\/uploads\\//.test(x[0])).map((x) => x[1]) }); })()`;
      const boPic = JSON.parse(await bo.until(`(() => { const v = ${LAYER_FILE}; return v && JSON.parse(v).img && v; })()`, 8000) || 'null');
      const boPicStatus = await (async () => { for (let i = 0; i < 40; i++) { const st = await asked('page:status', { code: fsHall }); if (st && st.ok && st.board.info.mark === '✓') return st.board.info.words; await sleep(150); } return ''; })();
      report(picTake.ok && !!boPic && boPic.kind === 'image' && boPic.blob && boPic.drag === 'false' && boPic.line === 'stage plan.png' && boPic.download === 0 && boPic.fetched.length > 0 && boPic.fetched.every((c) => c === 'no-store') && boPicStatus === 'On the 1 Board page',
        `a picture shown to the Board is drawn on Bo's page from bytes fetched no-store through an object URL, never draggable, with its line and no download link, and reads ✓ once her page says so (${JSON.stringify({ joined: [fsJoin.ok, fsJoin.error || ''], picUrl, picTake: picTake.ok ? true : picTake, boPic, boPicStatus })})`);
      // A right-click and a Shift+right-click on it open no menu of the browser's: on Bo's simple view none at all.
      const MENU_HEARD = `(() => { window.__menus = []; window.addEventListener('contextmenu', (e) => { window.__menus.push([e.shiftKey, e.defaultPrevented]); }); return true; })()`;
      const clickOn = async (t, sel, shift) => {
        const at = await middleOf(t, `document.querySelector('${sel}')`);
        for (const type of ['mousePressed', 'mouseReleased']) await t.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1, modifiers: shift ? 8 : 0 });
        await sleep(150);
      };
      await bo.eval(MENU_HEARD);
      await clickOn(bo, '#layerBox img', false);
      await clickOn(bo, '#layerBox img', true);
      const boMenus = await bo.eval(`JSON.stringify({ heard: window.__menus, menu: !!document.querySelector('.agm-menu:not([hidden])') })`);
      // Printed, the stage is left out and says so.
      await bo.send('Emulation.setEmulatedMedia', { media: 'print' });
      const boPrint = await bo.eval(`JSON.stringify({ layer: getComputedStyle(document.getElementById('pageLayer')).display, note: getComputedStyle(document.getElementById('stagePrintNote')).display })`);
      await bo.send('Emulation.setEmulatedMedia', { media: '' });
      report(boMenus === JSON.stringify({ heard: [[false, true], [true, true]], menu: false }) && boPrint === JSON.stringify({ layer: 'none', note: 'block' }),
        `on Bo's picture a right-click and a Shift+right-click open no browser menu (her simple view has no menu), and printing leaves the stage out with its words (${boMenus}; ${boPrint})`);

      // The same on an observer's picture layer: AGMessage's menu for a right-click and a Shift+right-click alike, with no
      // save in it, never draggable, left out of print.
      const toOz = await push({ uid: 'u:' + (await oz.eval('pageFacts.uid')) }, { kind: 'image', url: picUrl });
      const ozPic = JSON.parse(await oz.until(`(() => { const v = ${LAYER_FILE}; return v && JSON.parse(v).img && v; })()`, 8000) || 'null');
      await oz.eval(MENU_HEARD);
      const ozMenu = async (shift) => {
        await clickOn(oz, '#layerBox img', shift);
        const items = await oz.until(`(() => { const m = document.querySelector('.agm-menu'); return m && m.querySelectorAll('[data-action]').length && JSON.stringify([...m.querySelectorAll('[data-action]')].map((x) => x.dataset.action)); })()`, 3000);
        await oz.eval(`AGM.menu.close()`);
        return JSON.parse(items || '[]');
      };
      const ozPlain = await ozMenu(false);
      const ozShift = await ozMenu(true);
      await oz.send('Emulation.setEmulatedMedia', { media: 'print' });
      const ozPrint = await oz.eval(`getComputedStyle(document.getElementById('pageLayer')).display`);
      await oz.send('Emulation.setEmulatedMedia', { media: '' });
      const ozHeard = await oz.eval(`JSON.stringify(window.__menus)`);
      report(toOz.ok && !!ozPic && ozPic.drag === 'false' && ozPic.fetched.every((c) => c === 'no-store') && ozPlain.length > 0 && ozPlain.every((a) => a.startsWith('take.')) && JSON.stringify(ozShift) === JSON.stringify(ozPlain)
        && ozHeard === JSON.stringify([[false, true], [true, true]]) && ozPrint === 'none',
        `on Oz's observer page the picture is drawn the same way; a right-click and a Shift+right-click open AGMessage's menu alike, the take's acts and no save, and printing leaves it out (${JSON.stringify({ ozPic, ozPlain, ozShift, ozHeard, ozPrint })})`);
      await oz.eval(`document.querySelector('#layerActs [data-action="take.chat"]').click()`);

      // Back to chat: every object URL made for the picture revoked; under Earlier it is a Look, drawn again on this page
      // alone with nothing said to the server, its URL revoked as the Look closes.
      await bo.eval(`document.querySelector('#layerActs [data-action="take.chat"]').click()`);
      await bo.until(`document.getElementById('pageLayer').hidden && 'chat'`, 5000);
      const boUrls1 = await bo.eval(`JSON.stringify(window.__urls.made.slice(${boUrls0.made}).every((u) => window.__urls.revoked.includes(u)) && window.__urls.made.length > ${boUrls0.made})`);
      await bo.eval(`(() => { window.__said = []; const e = socket.emit; socket.emit = function (ev, ...a) { window.__said.push(ev); return e.call(this, ev, ...a); }; return true; })()`);
      await bo.eval(`document.getElementById('tabShown') && !document.getElementById('bvTabs').hidden && document.getElementById('tabShown').click()`);
      await bo.until(`!!document.querySelector('#takeEarlier [data-action="past.look"]')`, 5000);
      const lookFrom = await urlsNow(bo);
      await bo.eval(`document.querySelector('#takeEarlier [data-action="past.look"]').click()`);
      const boLook = await bo.until(`document.getElementById('webPreview').open && (() => { const img = document.querySelector('#webPreviewBox img'); return img && img.complete && img.naturalWidth > 0 && JSON.stringify({ what: document.getElementById('webPreviewWhat').textContent, show: !document.getElementById('webPreviewShow').hidden, drag: img.getAttribute('draggable') }); })()`, 8000);
      await bo.eval(`document.getElementById('webPreview').close()`);
      // The dialog's close event comes as a task of its own after close(): the Look's URLs are read once it has had its turn.
      const LOOK_AFTER = `JSON.stringify({ revoked: window.__urls.made.slice(${lookFrom.made}).every((u) => window.__urls.revoked.includes(u)), said: window.__said.filter((e) => e === 'page:report').length })`;
      const lookAfter = (await bo.until(`(() => { const r = ${LOOK_AFTER}; return JSON.parse(r).revoked && r; })()`, 3000)) || await bo.eval(LOOK_AFTER);
      report(boUrls1 === 'true' && boLook === JSON.stringify({ what: 'Look', show: false, drag: 'false' }) && lookAfter === JSON.stringify({ revoked: true, said: 0 }),
        `Back to chat revokes every object URL made for the picture; under Earlier its Look draws it again on Bo's page alone, says nothing to the server, and revokes its own URL as it closes (${JSON.stringify({ boUrls1, boLook, lookAfter })})`);

      // A document at its place, in the simple view: its page box and zoom at 48 px, paged and zoomed; then withdrawn, its
      // reader gone and its pdf.js document destroyed.
      const docTake = await push('board', { kind: 'doc', url: pdfUrl, at: { page: 1 } });
      const DOC_LAYER = `(() => { const b = document.getElementById('layerBox'); const v = b.querySelector('.dv'); const n = b.querySelector('.dv-n'); const zoom = [...b.querySelectorAll('.dv-zoom .btn')];
        return v && n && b.querySelector('canvas:not(.pdf-page-pending)') && JSON.stringify({ kind: v.dataset.kind, page: n.value, of: (b.querySelector('.dv-of') || {}).textContent, small: Math.min(...[...b.querySelectorAll('.dv-bar .btn')].map((x) => Math.min(x.getBoundingClientRect().width, x.getBoundingClientRect().height))), zoom: zoom.length }); })()`;
      const boDoc = JSON.parse(await bo.until(DOC_LAYER, 20000) || 'null');
      const width0 = await bo.eval(`document.querySelector('#layerBox .dv-page').getBoundingClientRect().width`);
      await bo.eval(`document.querySelector('#layerBox .dv-zoom .btn[aria-label="Zoom in"]').click()`);
      const zoomed = await bo.until(`document.querySelector('#layerBox .dv-page').getBoundingClientRect().width > ${width0} && 'zoomed'`, 5000);
      await bo.eval(`document.querySelector('#layerBox .dv-next').click()`);
      const paged = await bo.until(`document.querySelector('#layerBox .dv-n').value === '2' && 'paged'`, 5000);
      const reader = () => bo.eval(`import('/docview.mjs').then((m) => JSON.stringify(m.pdfState()))`);
      const openBefore = JSON.parse(await reader());
      const withdrawn = await asked('page:withdraw', { code: fsHall, seq: docTake.seq });
      const boGone = await bo.until(`document.getElementById('pageLayer').hidden && !document.querySelector('.dv') && 'gone'`, 8000);
      const openAfter = JSON.parse(await bo.until(`import('/docview.mjs').then((m) => m.pdfState().open === 0 && JSON.stringify(m.pdfState()))`, 8000) || 'null');
      const boAll = await bo.eval(`JSON.stringify({ revoked: window.__urls.made.every((u) => window.__urls.revoked.includes(u)), earlier: [...document.querySelectorAll('#takeEarlier .take-earlier-item')].length })`);
      await bo.shot(path.join(OUT, 'take-document.png'));
      report(docTake.ok && !!boDoc && boDoc.kind === 'pdf' && boDoc.page === '1' && boDoc.small >= 48 && boDoc.zoom === 4 && zoomed === 'zoomed' && paged === 'paged'
        && openBefore.open === 1 && withdrawn.ok && boGone === 'gone' && !!openAfter && boAll === JSON.stringify({ revoked: true, earlier: 1 }),
        `a document at its place on Bo's simple view: its page box and zoom at 48 px, zoomed and paged on; withdrawn, its reader is gone, its pdf.js document destroyed, every object URL revoked, and it is not under Earlier (${JSON.stringify({ boDoc, zoomed, paged, openBefore, withdrawn, boGone, openAfter, boAll })})`);

      // A Word document opened at its paragraph (¶ 40, no page given): the view opens there, and its line names the place.
      const minutes = officeZip(wordParts({ body: Array.from({ length: 60 }, (_, i) => '<w:p><w:r><w:t>Paragraph ' + (i + 1) + '</w:t></w:r></w:p>').join('') }));
      const docxUrl = await fresh('minutes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', minutes);
      const paraTake = await push('board', { kind: 'doc', url: docxUrl, at: { block: 40 } });
      const atPara = await bo.until(`(() => {
        const box = document.querySelector('#layerBox .take-file-box'); const v = box && box.querySelector('.dv[data-kind="word"]');
        const p = v && [...v.querySelectorAll('.doc-html p')].find((x) => x.textContent === 'Paragraph 40');
        if (!p || !box.scrollTop) return '';
        const top = box.getBoundingClientRect().top, bottom = box.getBoundingClientRect().bottom, at = p.getBoundingClientRect().top;
        return JSON.stringify({ inView: at >= top && at < top + (bottom - top) / 2, line: (document.querySelector('#layerBox .take-file-line') || {}).textContent || '' });
      })()`, 20000);
      const paraDone = await asked('page:withdraw', { code: fsHall, seq: paraTake.seq });
      await bo.until(`document.getElementById('pageLayer').hidden && 'gone'`, 8000);
      report(paraTake.ok && atPara === JSON.stringify({ inView: true, line: 'minutes.docx · ¶ 40' }) && paraDone.ok,
        `a Word document shown at its paragraph opens on Bo's page at that paragraph, its line naming it (${JSON.stringify({ paraTake: paraTake.ok || paraTake, atPara })})`);

      // The page checks again: a take whose address is not an upload of ours draws nothing and fetches nothing.
      const before = await bo.eval(`window.__fetched.length`);
      await bo.eval(`socket.listeners('page:take').forEach((f) => f({ layer: 'info', seq: 99999, content: { kind: 'image', url: 'https://agm-files.invalid/stage.png' }, by: { name: 'Someone' }, at: Date.now(), hallName: '', holding: '', now: Date.now(), tz: '', answer: null, arrive: 'over' }))`);
      const refused = await bo.until(`!document.getElementById('pageLayer').hidden && document.getElementById('pageLayer').dataset.kind === 'image' && JSON.stringify({ img: !!document.querySelector('#layerBox img'), fetched: window.__fetched.slice(${before}).filter((x) => /agm-files/.test(x[0])).length })`, 5000);
      report(refused === JSON.stringify({ img: false, fetched: 0 }), `a take whose address is not one of the hall's uploads is refused by the page itself: nothing drawn, nothing fetched (${refused})`);
      const filesProblems = [['bo', bo], ['oz', oz]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(filesProblems.length === 0, `the files hall's pages: no console error and no CSP violation${filesProblems.length ? ' — ' + filesProblems.slice(0, 4).join(' | ') : ''}`);
      fsOp.close();
      for (const t of [bo, oz]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
    }

    // ---------------- A shared file is a download for the backstage team, by a ticket; nothing opens itself (unit 26) ----------------
    // In a hall of its own: the admin account's page backstage (the operator, who may download and show the Board), Cy On
    // stage (the simple view, by her seat) and Ox observing, Cy and Ox each a device of its own whose fetches and object
    // URLs are counted from before its own scripts. Cy's browser saves what it downloads where the smoke reads it.
    {
      const shHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Share hall' }) })).json()).code;
      const FETCHES = `(() => { const f = window.fetch; window.__fetched = []; window.fetch = function (u, o) { window.__fetched.push([String(u && u.url ? u.url : u), (o && o.cache) || '']); return f.apply(this, arguments); }; })();`;
      const desk = await edge.tab(`${base}/app.html?code=${shHall}&as=account&role=research`, { init: DOC_PROBE + FETCHES });
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush && F.download`, 10000);
      desk.expectFailure(/\/api\/upload$/);   // the uploads' rate (a burst of 4, then one every 2 s) turns a fifth file away: the outbox waits it out
      const cy = await edge.tab(`${base}/app.html?code=${shHall}&name=Cy&role=board&invite=${inviteOf(dataDir, shHall)}`, { init: DOC_PROBE + FETCHES, alone: true });
      const ox = await edge.tab(`${base}/app.html?code=${shHall}&name=Ox&role=observer`, { init: DOC_PROBE + FETCHES, alone: true });
      for (const t of [cy, ox]) await t.until(`typeof joined !== 'undefined' && joined`, 10000);
      await edge.browserSend('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true, browserContextId: cy.context });
      const PANEL = `JSON.stringify({ state: document.getElementById('docPanel').dataset.state, layer: !document.getElementById('pageLayer').hidden })`;
      const cyPanel0 = await cy.eval(PANEL);
      const uploadsAsked = () => desk.eval(`window.__fetched.filter((x) => /\\/api\\/upload$/.test(x[0])).length`);

      // A file dropped on the composer is attached and opens in the Preview from the copy on this device: nothing uploaded.
      const pdfB64 = fixture('board-pack-tagged.pdf').toString('base64');
      await desk.eval(`(() => { const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0)); window.__pack = new File([bytes], 'board pack.pdf', { type: 'application/pdf' });
        const dt = new DataTransfer(); dt.items.add(window.__pack); document.getElementById('researchCompose').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
      const previewed = JSON.parse(await desk.until(`(() => { const c = document.querySelector('#docDisplay canvas.pdf-page:not(.pdf-page-pending)'); return c && !document.getElementById('previewBar').hidden && JSON.stringify({ chip: document.getElementById('fileChip').textContent,
        send: document.querySelector('#textPane .send-word').textContent, title: document.getElementById('docPanelTitle').textContent, picture: document.getElementById('showPicture').textContent, document: document.getElementById('showDocument').textContent, tick: !document.getElementById('letDownload').disabled }); })()`, 20000) || 'null');
      const uploadsAfterPreview = await uploadsAsked();
      report(!!previewed && previewed.chip.startsWith('📎 board pack.pdf') && previewed.send === 'Share for download' && previewed.title === '👁 Preview — the Board does not see this' && previewed.picture === '📺 Picture of p. 1' && previewed.document === '📺 Document at p. 1' && previewed.tick && uploadsAfterPreview === 0,
        `a file dropped on the composer is attached (its chip; Send reads Share for download) and drawn in the Preview from the copy on this device, its bar offering a picture of p. 1 and the document at p. 1 side by side, with nothing uploaded (${JSON.stringify({ previewed, uploadsAfterPreview })})`);

      // Picture of p. 1: one click, a ✓ take of a new picture on Cy's page; then Document at p. 1 with Let them download it
      // ticked: one click, a ✓ take of the document, and ⬇ Download on Cy's card, which her browser saves whole.
      const boardMark = async () => { for (let i = 0; i < 60; i++) { await desk.eval(`Console.read()`); const m = await desk.eval(`(() => { const b = Console.board(); return b && b.info ? b.info.mark + '|' + b.info.kind : ''; })()`); if (m && m.startsWith('✓')) return m; await sleep(250); } return ''; };
      await desk.eval(`document.getElementById('showPicture').click()`);
      const cyPicture = await cy.until(`document.getElementById('pageLayer').dataset.kind === 'image' && !!document.querySelector('#layerBox img') && document.querySelector('#layerBox img').naturalWidth > 0 && (document.querySelector('#layerBox .take-file-line') || {}).textContent`, 20000);
      const pictureMark = await boardMark();
      const uploadsAfterPicture = await uploadsAsked();
      await desk.eval(`document.getElementById('letDownload').checked = true; document.getElementById('showDocument').click()`);
      const cyDocument = await cy.until(`document.getElementById('pageLayer').dataset.kind === 'doc' && !!document.querySelector('#layerBox canvas:not(.pdf-page-pending)') && 'doc'`, 20000);
      const documentMark = await boardMark();
      const cyLayerBar = await cy.until(`(() => { const a = [...document.querySelectorAll('#layerActs [data-action]')].map((b) => b.dataset.action); return a.includes('take.download') && JSON.stringify(a); })()`, 5000);
      report(!!cyPicture && pictureMark === '✓|image' && uploadsAfterPicture === 1 && cyDocument === 'doc' && documentMark === '✓|doc' && !!cyLayerBar,
        `Picture of p. 1 is one click to a ✓ take of a new picture on the Board's page, and Document at p. 1 one click to a ✓ take of the document, ⬇ Download on its layer's bar in the simple view (${JSON.stringify({ cyPicture, pictureMark, uploadsAfterPicture, cyDocument, documentMark, cyLayerBar })})`);
      // Minimised, it is a card in Shown to you, with 👁 Look and ⬇ Download (that item alone, ticked); the download is the
      // server's by the take's number, and her browser saves it whole under its name.
      await cy.eval(`document.querySelector('#layerActs [data-action="take.minimise"]').click()`);
      const cyCard = await cy.until(`(() => { const c = document.querySelector('#takeCards .take-card'); return c && JSON.stringify([...c.querySelectorAll('[data-action]')].map((b) => b.dataset.action)); })()`, 5000);
      const cyBefore = new Set(downloads.keys());
      await cy.eval(`document.querySelector('#takeCards [data-action="card.download"]').click()`);
      let cySaved = null;
      for (const end = Date.now() + 15000; Date.now() < end && !cySaved; await sleep(100)) cySaved = [...downloads].find(([g, d]) => !cyBefore.has(g) && d.state === 'completed');
      const cyReached = await cy.until(`(() => { const t = document.getElementById('agmToast'); return !!t && t.textContent.includes('reached this browser') && 'reached'; })()`, 5000);
      report(cyCard === JSON.stringify(['card.show', 'card.download']) && !!cySaved && cySaved[1].name === 'board pack.pdf' && fs.readFileSync(path.join(dlDir, cySaved[0])).equals(fixture('board-pack-tagged.pdf')) && cyReached === 'reached',
        `Download ticked on the document shows ⬇ on the Board's card beside Look, and it downloads: saved whole under its name, the page saying it reached this browser (${JSON.stringify({ cyCard, saved: cySaved ? cySaved[1].name : '', cyReached })})`);

      // Shared for download: a card in the feed and nothing on any Board page; On stage a Look and no Download; an
      // observer's card has no picture and no link; a zip reads "download only", with no Look, no Show and no screen.
      await desk.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('textInput').value = 'The plan, for download'; document.querySelector('#textPane .send-btn').click(); return true; })()`);
      const sharedSaid = await desk.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return t.startsWith('Shared in') && t; })()`, 15000);
      const shared = await desk.until(`(() => { const m = allMessages.find((x) => x.type === 'file' && x.caption === 'The plan, for download'); return m && messagesById.get(m.id) && JSON.stringify({ id: m.id, size: m.size, line: messagesById.get(m.id).querySelector('.file-link').textContent }); })()`, 15000);
      const sharedMsg = JSON.parse(shared || '{}');
      await desk.eval(`(async () => { const f = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0])], 'stage pack.zip', { type: 'application/zip' }); attachFile(f); document.getElementById('textInput').value = 'Load-in files'; document.querySelector('#textPane .send-btn').click(); return true; })()`);
      const zipLine = await desk.until(`(() => { const m = allMessages.find((x) => x.type === 'file' && x.transferOnly); return m && messagesById.get(m.id) && JSON.stringify({ id: m.id, line: messagesById.get(m.id).querySelector('.file-link').textContent }); })()`, 15000);
      const zipMsg = JSON.parse(zipLine || '{}');
      const zipMenu = JSON.parse(await desk.eval(`JSON.stringify(AGM.catalog.ids('msg', F, findMessage(${codeLiteral(zipMsg.id || '')})))`));
      // A picture shared for download too: its card draws it backstage, and an observer's card has none.
      await desk.eval(`(() => { attachFile(new File([Uint8Array.from(atob('${pngOf(64, 48).toString('base64')}'), (c) => c.charCodeAt(0))], 'stage plan.png', { type: 'image/png' })); document.getElementById('textInput').value = 'The stage plan'; document.querySelector('#textPane .send-btn').click(); return true; })()`);
      const planId = await desk.until(`(() => { const m = allMessages.find((x) => x.type === 'file' && x.caption === 'The stage plan'); const n = m && messagesById.get(m.id); const img = n && n.querySelector('.file img'); return img && img.src.startsWith('blob:') && img.naturalWidth > 0 && m.id; })()`, 15000);
      const cyCards = await cy.until(`(() => { const a = messagesById.get(${codeLiteral(sharedMsg.id || '')}); const z = messagesById.get(${codeLiteral(zipMsg.id || '')}); return a && z && JSON.stringify({
        pdf: [...a.querySelectorAll('[data-action]')].map((b) => b.dataset.action).filter((x) => x === 'msg.look' || x === 'msg.download'), zip: [...z.querySelectorAll('[data-action]')].map((b) => b.dataset.action).filter((x) => x === 'msg.look' || x === 'msg.download') }); })()`, 8000);
      const cyPanel1 = await cy.eval(`JSON.stringify({ state: document.getElementById('docPanel').dataset.state, layer: !document.getElementById('pageLayer').hidden })`);
      const oxCard = await ox.until(`(() => { const a = messagesById.get(${codeLiteral(planId || '')}); return a && JSON.stringify({ url: Object.prototype.hasOwnProperty.call(findMessage(${codeLiteral(planId || '')}), 'url'), img: a.querySelectorAll('img').length, links: document.querySelectorAll('[src*="/uploads/"], [href*="/uploads/"], [data-src*="/uploads/"]').length, acts: [...a.querySelectorAll('.file [data-action], .file[data-action]')].length }); })()`, 8000);
      report(!!sharedMsg.id && sharedMsg.size > 0 && !!planId && /^📎 board pack\.pdf · PDF · /.test(sharedMsg.line) && zipMsg.line === '📦 stage pack.zip · ZIP · 10 bytes · download only'
        && sharedSaid === 'Shared in Main — the backstage team can download it; the Board can open it.'
        && ['msg.stage', 'msg.look', 'msg.screens'].every((x) => !zipMenu.includes(x)) && zipMenu.includes('msg.download')
        && cyCards === JSON.stringify({ pdf: ['msg.look'], zip: [] }) && cyPanel1 === JSON.stringify({ state: JSON.parse(cyPanel0).state, layer: false })
        && oxCard === JSON.stringify({ url: false, img: 0, links: 0, acts: 0 }),
        `Share puts a file card in the feed ("📎 … · PDF · size"; a zip "📦 … · download only" with no Look, no Show and no screen), says "Shared in Main — the backstage team can download it; the Board can open it." and changes nothing on the Board's page; On stage a Look and no Download; an observer's card holds no link, no picture and no act (${JSON.stringify({ sharedSaid, sharedMsg, zipMsg, zipMenu, cyCards, cyPanel0, cyPanel1, oxCard })})`);

      // A Board seat's Look: the file opens in her own panel, read no-store, its object URLs revoked as the panel closes.
      await cy.eval(`(() => { window.__lookFrom = window.__urls.made.length; window.__fetchFrom = window.__fetched.length; act('msg', 'msg.look', findMessage(${codeLiteral(planId || '')}), {}); return true; })()`);
      await cy.until(`(() => { const i = document.querySelector('#docDisplay img.dv-img'); return !!i && i.naturalWidth > 0 && 'drawn'; })()`, 15000);
      await cy.eval(`dismissDoc()`);
      const cyLook = await cy.until(`(() => { const f = window.__fetched.slice(window.__fetchFrom).filter((x) => /\\/uploads\\//.test(x[0])); return JSON.stringify({ fetched: f.length > 0 && f.every((x) => x[1] === 'no-store'), revoked: window.__urls.made.slice(window.__lookFrom).every((u) => window.__urls.revoked.includes(u)) }); })()`, 5000);
      report(cyLook === JSON.stringify({ fetched: true, revoked: true }), `a Board seat's Look at a file shared for download is read no-store, and every object URL it made is revoked as the panel closes (${cyLook})`);

      // A file of before 0.6.0 (no size): drawn as a card all the same.
      const oldCard = await desk.eval(`(() => { const b = renderFileBody({ id: 'old1', type: 'file', url: ${codeLiteral('/uploads/1700000000000-abcdefghijkl-old.pdf')}, filename: 'old.pdf', mime: 'application/pdf', from: { uid: 'x', name: 'Old', role: 'research' }, at: Date.now() }); return b.querySelector('.file-link').textContent; })()`);
      report(oldCard === '📎 old.pdf · PDF', `a file message from before 0.6.0, with no size, draws as a card (${oldCard})`);

      // The feed's ⋯ → 📺 Show the Board ▸ The document… opens the short bar; Download ticked there shows ⬇ on the Board's
      // card. The People tab's Show them a document… opens the same bar.
      await desk.eval(`(() => { act('msg', 'msg.stage', findMessage(${codeLiteral(sharedMsg.id || '')}), { value: 'doc' }); return true; })()`);
      const shortBar = await desk.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, fields: [...a.querySelectorAll('input, select')].map((i) => i.name), yes: [...a.querySelectorAll('[data-answer]')].map((b) => b.textContent) }); })()`, 5000);
      await desk.eval(`(() => { const a = document.querySelector('.agm-ask'); a.querySelector('input[name="download"]').checked = true; a.querySelector('[data-answer="yes"]').click(); return true; })()`);
      const cyTicked = await cy.until(`document.getElementById('pageLayer').dataset.kind === 'doc' && 'doc'`, 15000);
      await cy.eval(`document.querySelector('#layerActs [data-action="take.minimise"]').click()`);
      const cyTickedCard = await cy.until(`!!document.querySelector('#takeCards [data-action="card.download"]') && 'download'`, 5000);
      const cyKey = await cy.eval(`'u:' + pageFacts.uid`);
      await desk.eval(`(() => { act('person', 'person.doc', { id: 'person:' + ${codeLiteral(cyKey)}, key: ${codeLiteral(cyKey)}, uid: ${codeLiteral(cyKey.slice(2))}, name: 'Cy', role: 'board', where: 'console' }, {}); return true; })()`);
      const peopleBar = await desk.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, fields: [...a.querySelectorAll('input, select')].map((i) => i.name) }); })()`, 5000);
      await desk.eval(`(() => { const a = document.querySelector('.agm-ask [data-answer="no"]'); if (a) a.click(); return true; })()`);
      report(shortBar === JSON.stringify({ title: 'Show the Board the document', fields: ['at', 'download', 'arrive'], yes: ['Cancel', 'Show the Board'] }) && cyTicked === 'doc' && cyTickedCard === 'download'
        && peopleBar === JSON.stringify({ title: 'Show Cy the document', fields: ['file', 'at', 'download', 'arrive'] }),
        `the feed's ⋯ → The document… opens the short bar (its page, Let them download it, where it arrives), and Download ticked there shows ⬇ on the Board's card; the People tab's Show them a document… opens the same bar with the file to choose (${JSON.stringify({ shortBar, cyTicked, cyTickedCard, peopleBar })})`);

      // A spreadsheet with a hidden sheet open in the Preview: Let them download it is disabled, with its words.
      await desk.eval(`(() => { window.__book = new File([Uint8Array.from(atob('${officeZip(workbookParts()).toString('base64')}'), (c) => c.charCodeAt(0))], 'budget.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); attachFile(window.__book); return true; })()`);
      const hiddenTick = await desk.until(`(() => { const t = document.getElementById('letDownload'); const w = document.getElementById('letDownloadWhy'); return !!document.querySelector('#docDisplay table.dv-grid') && !document.getElementById('previewBar').hidden && JSON.stringify({ disabled: t.disabled, why: w.hidden ? '' : w.textContent }); })()`, 15000);
      await desk.eval(`removePendingFile()`);
      report(hiddenTick === JSON.stringify({ disabled: true, why: 'This file has hidden parts: Download would hand them over. Share a copy without them for download instead.' }), `with a spreadsheet holding a hidden sheet open in the Preview, Let them download it is disabled with its words (${hiddenTick})`);

      // 🔒 Confidential beside 🔥 Priority while a file is attached: shared marked, every card reads "🔒 Confidential", the
      // Board's too; shown on the Board's pages, the ask before it goes names the room (the server's answer stood in for
      // once, as a Legal file's would be), and the Board's take says it on its line and its card; ＋ the speaker's screen
      // says what Stagewatch does with a confidential line.
      await desk.eval(`(() => { attachFile(new File(['Settle at two million.'], 'legal note.txt', { type: 'text/plain' })); return true; })()`);
      const lockBtn = await desk.until(`(() => { const b = document.getElementById('textConfidentialBtn'); return !b.hidden && JSON.stringify({ beside: b.previousElementSibling && b.previousElementSibling.id, text: b.textContent, pressed: b.getAttribute('aria-pressed') }); })()`, 5000);
      await desk.eval(`(() => { document.getElementById('textConfidentialBtn').click(); document.getElementById('textInput').value = 'The legal note'; document.querySelector('#textPane .send-btn').click(); return true; })()`);
      const secretShared = await desk.until(`(() => { const m = allMessages.find((x) => x.type === 'file' && x.caption === 'The legal note'); const n = m && messagesById.get(m.id); return n && m.confidential && JSON.stringify({ id: m.id, url: m.url, line: n.querySelector('.file-link').textContent, off: document.getElementById('textConfidentialBtn').getAttribute('aria-pressed') }); })()`, 15000);
      const secretMsg = JSON.parse(secretShared || '{}');
      const cySecret = await cy.until(`(() => { const n = messagesById.get(${codeLiteral(secretMsg.id || '')}); return n && n.querySelector('.file-link').textContent; })()`, 8000);
      await desk.eval(`(() => { const real = AGM.outbox.now; let once = true; AGM.outbox.now = (verb, args, done) => { if (once && verb === 'page:push') { once = false; done({ ok: false, error: 'This file is marked confidential: confirm to show it in the Main room. It will be in use there.', confirm: true, rooms: ['the Main room'] }); return; } return real(verb, args, done); };
        Console.showFile('board', { kind: 'snippet', unit: 'text', text: 'Settle at two million.', from: { url: ${codeLiteral(secretMsg.url || '')} } }); return true; })()`);
      const askedSecret = await desk.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, words: (a.querySelector('.agm-ask-words') || a).textContent }); })()`, 5000);
      await desk.eval(`(() => { document.querySelector('.agm-ask [data-answer="yes"]').click(); return true; })()`);
      const cySecretTake = await cy.until(`(() => { const l = document.querySelector('#pageLayer .take-quote-line'); return !document.getElementById('pageLayer').hidden && l && l.textContent; })()`, 15000);
      await cy.eval(`document.querySelector('#layerActs [data-action="take.minimise"]').click()`);
      const cySecretCard = await cy.until(`(() => { const c = [...document.querySelectorAll('#takeCards .take-card-what')].find((x) => x.querySelector('.take-card-secret')); return c && c.textContent; })()`, 5000);
      // ＋ on the ❝ Quote tab, ticked 🔒: the hall's frame says whether a confidential line may go (`secretLine`), stood in
      // for here (this hall's Stagewatch, over https; then one that is not), the page's facts put back after.
      await desk.eval(`(() => { window.__keptFacts = { canSendToStage: pageFacts.canSendToStage, canPropose: pageFacts.canPropose, stage: pageFacts.stage }; factsChanged({ canSendToStage: true, canPropose: false, stage: { status: 'connected', key: 'accepted', desk: false, secretLine: true } });
        selectTab('quote'); document.getElementById('quoteInput').value = 'Settle at two million.'; document.getElementById('quoteInput').dispatchEvent(new Event('input')); const t = document.getElementById('quoteSecret'); t.checked = true; t.dispatchEvent(new Event('change')); return true; })()`);
      const plusOf = `(() => { const r = document.getElementById('quoteLine'); if (r.hidden) return ''; const on = r.querySelector('[data-line-on]'); if (!on.disabled && !on.checked) { on.checked = true; on.dispatchEvent(new Event('change')); } const said = r.querySelector('[data-line-said]'); const why = r.querySelector('[data-line-why]'); return JSON.stringify({ disabled: on.disabled, said: said.hidden ? '' : said.textContent, why: why.hidden ? '' : why.textContent }); })()`;
      const secretPlus = await desk.until(`(() => { const p = ${plusOf}; return p && JSON.parse(p).said && p; })()`, 5000);
      await desk.eval(`(() => { factsChanged({ stage: { status: 'connected', key: 'accepted', desk: false, secretLine: 'This hall\\'s Stagewatch link is not encrypted: a confidential line is not sent.' } }); document.getElementById('quoteInput').dispatchEvent(new Event('input')); return true; })()`);
      const secretBarred = await desk.until(`(() => { const p = ${plusOf}; return p && JSON.parse(p).why && p; })()`, 5000);
      await desk.eval(`(() => { const t = document.getElementById('quoteSecret'); t.checked = false; document.getElementById('quoteInput').value = ''; document.getElementById('quoteInput').dispatchEvent(new Event('input')); factsChanged(window.__keptFacts); selectTab('text'); return true; })()`);
      report(lockBtn === JSON.stringify({ beside: 'textPriorityBtn', text: '🔒 Confidential', pressed: 'false' }) && /^📎 🔒 Confidential · legal note\.txt · Text/.test(secretMsg.line || '') && secretMsg.off === 'false'
        && /^📎 🔒 Confidential · legal note\.txt/.test(cySecret || '')
        && !!askedSecret && JSON.parse(askedSecret).title === '🔒 A confidential file' && JSON.parse(askedSecret).words.includes('Show it in the Main room? It will be in use there.')
        && /^🔒 Confidential · Typed by|^🔒 Confidential · Quoted by/.test(cySecretTake || '') && /^🔒/.test(cySecretCard || '')
        && /^🔒 Confidential — every output of this hall's Stagewatch shows it/.test((JSON.parse(secretPlus || '{}').said) || '')
        && secretBarred === JSON.stringify({ disabled: true, said: '', why: 'This hall\'s Stagewatch link is not encrypted: a confidential line is not sent.' }),
        `🔒 Confidential beside 🔥 while a file is attached, off after each share; a file shared marked reads "🔒 Confidential" on its card and the Board's; the ask before a confidential take names the room; the Board's take and card carry 🔒; ＋ says what Stagewatch does with a confidential line, or why it cannot go (${JSON.stringify({ lockBtn, secretMsg, cySecret, askedSecret, cySecretTake, cySecretCard, secretPlus, secretBarred })})`);

      const shareProblems = [['desk', desk], ['cy', cy], ['ox', ox]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(shareProblems.length === 0, `the share hall's pages: no console error and no CSP violation${shareProblems.length ? ' — ' + shareProblems.slice(0, 4).join(' | ') : ''}`);
      for (const t of [desk, cy, ox]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
    }

    // ---------------- The researcher shows a picked word, line, item, paragraph, cell, row or column, a picture or the document (unit 27) ----------------
    // In a hall of its own: the admin account's page backstage (the operator) with a file in its Preview, and Cy On stage on
    // a device of her own. A highlight made first is honoured: the bar offers the units that hold it, the smallest chosen,
    // and each reaches Cy's page as a quote drawn from data, ✓ on the console; a picture, what is in view and the document
    // go from the same bar and its menu, which a right-click on the pick opens.
    {
      const pkHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Pick hall' }) })).json()).code;
      const TOASTS = `(() => { window.__toasts = []; document.addEventListener('DOMContentLoaded', () => { new MutationObserver(() => { const t = document.getElementById('agmToast'); if (t && t.textContent) window.__toasts.push(t.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }); }); })();`;
      // The operator on a device of its own, signed in as Ana's account alone (no admin token in its browser), so the
      // laptop's admin pushing below is another pusher.
      const desk = await edge.tab(`${base}/`, { init: TOASTS, alone: true });
      await desk.until(`document.readyState === 'complete'`);
      const deskIn = await desk.eval(`(async () => { for (let i = 0; i < 5; i++) { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; })()`);
      if (deskIn !== 200) throw new Error('the pick hall\'s operator could not sign in: ' + deskIn);
      await desk.eval(`location.href = ${codeLiteral(`/app.html?code=${pkHall}&as=account&role=research`)}`);
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush`, 10000);
      desk.expectFailure(/\/api\/upload$/);   // the uploads' rate turns a fifth quick picture away: the bar waits it out
      const cy = await edge.tab(`${base}/app.html?code=${pkHall}&name=Cy&role=board&invite=${inviteOf(dataDir, pkHall)}`, { alone: true });
      await cy.until(`typeof joined !== 'undefined' && joined`, 10000);
      // A file attached on this device, drawn in the Preview from its own copy (nothing uploaded until it is shown).
      const attach = (bytes, name, type) => desk.eval(`(() => { attachFile(new File([Uint8Array.from(atob('${bytes.toString('base64')}'), (c) => c.charCodeAt(0))], ${codeLiteral(name)}, { type: ${codeLiteral(type)} })); return true; })()`);
      // The words `from` to `to` of the first text node holding `words` under `scope` selected, as a drag selects them.
      const select = (words, from, to, scope = '#docDisplay') => desk.eval(`(() => {
        const root = document.querySelector(${codeLiteral(scope)}); if (!root) return 'no scope';
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.nodeValue.indexOf(${codeLiteral(words)});
          if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i + ${from}); r.setEnd(n, i + ${to});
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'selected';
        }
        return 'not found';
      })()`);
      // The bar's chips once they hold `id` (each [its act, chosen]), read after the pick is.
      const chipsWith = async (id) => JSON.parse((await desk.until(`(() => { const b = document.getElementById('pickBar'); const c = [...document.querySelectorAll('#pickChips .pick-chip')]; return !b.hidden && c.some((x) => x.dataset.action === ${codeLiteral(id)}) && JSON.stringify(c.map((x) => [x.dataset.action, x.getAttribute('aria-checked') === 'true'])); })()`, 8000)) || '[]');
      const choose = (id) => desk.eval(`(() => { const c = document.querySelector('#pickChips [data-action="${id}"]'); if (!c) return false; c.click(); return true; })()`);
      const infoSeq = () => desk.eval(`(() => { const b = Console.board(); return b && b.info ? b.info.seq : 0; })()`);
      // The console's mark on the Board's information once a take newer than `before` is up: "✓|snippet" when every page said.
      const markAfter = async (before) => {
        for (let i = 0; i < 80; i++) {
          await desk.eval(`Console.read()`);
          const m = await desk.eval(`(() => { const b = Console.board(); return b && b.info ? b.info.mark + '|' + b.info.kind + '|' + b.info.seq : ''; })()`);
          if (m && Number(m.split('|')[2]) > before && m.startsWith('✓')) return m.split('|').slice(0, 2).join('|');
          await sleep(250);
        }
        return '';
      };
      const QUOTE_ON_CY = `(() => { const q = document.querySelector('#layerBox .take-quote:not([data-old])'); return !document.getElementById('pageLayer').hidden && q && JSON.stringify({ unit: q.dataset.unit,
        text: q.querySelector('.take-quote-body').innerText.replace(/\\n+/g, '\\n').trim(), line: q.querySelector('.take-quote-line').textContent, table: [...q.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        focus: (q.querySelector('.take-quote-focus') || {}).textContent || '', heads: q.querySelectorAll('.take-quote-head').length, px: parseFloat(getComputedStyle(q).fontSize) }); })()`;
      // Show (the bar's button, or `run`) and read what Cy's page draws and the console's mark.
      const shows = async (run) => {
        const before = await infoSeq();
        await cy.eval(`(() => { for (const q of document.querySelectorAll('#layerBox .take-quote')) q.dataset.old = '1'; return true; })()`);
        await desk.eval(run || `document.getElementById('pickShow').click()`);
        const mark = await markAfter(before);
        return { mark, drawn: JSON.parse((await cy.until(QUOTE_ON_CY, 10000)) || 'null') };
      };
      const showUnit = async (id) => { await choose(id); return shows(); };

      // A tagged PDF (LibreOffice Writer's export, its structure kept): its words picked on its pages' text layer.
      await attach(fixture('board-pack-tagged.pdf'), 'board pack.pdf', 'application/pdf');
      const layered = await desk.until(`document.querySelectorAll('#docDisplay .textLayer span[role="presentation"]').length > 0 && !document.getElementById('previewBar').hidden && 'drawn'`, 20000);
      await select('about agenda', 6, 12);
      const firstChips = await chipsWith('pick.word');
      const word = await showUnit('pick.word');
      const line = await showUnit('pick.line');
      const para = await showUnit('pick.paragraph');
      await desk.eval(`docView.goto({ page: 3 })`);
      const P3 = '#docDisplay .textLayer[data-page="3"]';
      await desk.until(`document.querySelectorAll('${P3} span[role="presentation"]').length > 3`, 10000);
      await select('Revenue up', 0, 7, P3);
      await chipsWith('pick.item');
      const item = await showUnit('pick.item');
      await desk.eval(`(() => { const s = [...document.querySelectorAll('${P3} span[role="presentation"]')].find((x) => x.textContent === '5'); const r = document.createRange(); r.selectNodeContents(s.firstChild); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
      const cellChips = await chipsWith('pick.cell');
      const cell = await showUnit('pick.cell');
      const row = await showUnit('pick.row');
      const column = await showUnit('pick.column');
      const quoted = { word, line, para, item, cell, row, column };
      report(!!layered && JSON.stringify(firstChips) === JSON.stringify([['pick.selection', false], ['pick.word', true], ['pick.line', false], ['pick.paragraph', false]])
        && cellChips.some(([id]) => id === 'pick.row') && cellChips.some(([id]) => id === 'pick.column')
        && Object.values(quoted).every((q) => q.mark === '✓|snippet' && !!q.drawn && q.drawn.line === 'Quoted by Ana Admin from their copy of board pack.pdf, p. ' + (q === word || q === line || q === para ? 1 : 3))
        && word.drawn.unit === 'word' && word.drawn.text === 'agenda' && line.drawn.text === 'This is page 1 of the board pack, about agenda.' && para.drawn.unit === 'paragraph'
        && item.drawn.unit === 'item' && item.drawn.text === 'Revenue up' && cell.drawn.unit === 'cell' && cell.drawn.focus === '5'
        && JSON.stringify(row.drawn.table) === JSON.stringify([['Plant', '4', '5']]) && JSON.stringify(column.drawn.table) === JSON.stringify([['Q2'], ['5'], ['2']]),
        `a tagged PDF: a highlight made first offers the units that hold it, the smallest chosen; a word, a line, a paragraph, an item, a cell, a row and a column each reach the Board's page as a quote, said as Ana's from her copy, ✓ on the console (${JSON.stringify({ firstChips, cellChips, quoted })})`);

      // The quote is drawn from data in the largest type that fits; on a phone a 25 × 10 table scrolls inside its card.
      const phone = await edge.tab(`${base}/app.html?code=${pkHall}&name=Pip&role=board&invite=${inviteOf(dataDir, pkHall)}`, { alone: true, metrics: PHONE });
      await phone.until(`typeof joined !== 'undefined' && joined`, 10000);
      const wide = Array.from({ length: 25 }, (_, r) => Array.from({ length: 10 }, (__, c) => (r === 0 ? 'Quarter ' + (c + 1) : String((r + 1) * (c + 7) * 1000))));
      const wideTake = await desk.eval(`new Promise((r) => socket.emit('page:push', { code: HALL_KEY, to: 'board', content: { kind: 'snippet', unit: 'range', table: { rows: ${JSON.stringify(wide)}, head: 1, side: 0, ref: 'A1:J25' } } }, r))`);
      // Read once the layer is shown and two frames have passed: a quote drawn while the layer was still hidden is fitted
      // again as its box gets its size (pagelayer.mjs drawQuote's ResizeObserver), never read before that.
      const phoneTable = await phone.until(`new Promise((done) => { const q = document.querySelector('#layerBox .take-quote[data-unit="range"]'); const s = q && q.querySelector('.take-quote-scroll');
        if (!q || !s || document.getElementById('pageLayer').hidden) { done(null); return; }
        requestAnimationFrame(() => requestAnimationFrame(() => done(JSON.stringify({ px: parseFloat(getComputedStyle(q).fontSize), scrolls: s.scrollWidth > s.clientWidth, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, num: document.querySelectorAll('#layerBox .take-quote-num').length })))); })`, 10000);
      const pt = JSON.parse(phoneTable || 'null');
      report(!!wideTake && wideTake.ok && !!pt && pt.px >= 20 && pt.scrolls && pt.page && pt.num === 240 && cell.drawn.px >= 28,
        `a 25 × 10 table on a phone: its type 20 px or more, it scrolls sideways inside its card and the page does not, its numbers set to the right; on a tablet a quote's type is 28 px or more (${JSON.stringify({ wideTake: wideTake && wideTake.ok, pt, tablet: cell.drawn.px })})`);
      phone.close();

      // A right-click on the pick opens exactly the bar's list as a menu, Copy first; a touch's long press keeps the
      // browser's selection (no menu of AGMessage's).
      await select('Costs flat', 0, 5, P3);
      const pickChips = await chipsWith('pick.item');
      const at = await desk.eval(`(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      await rightClick(desk, at);
      const pickMenu = JSON.parse((await desk.until(MENU_IDS, 3000)) || '[]');
      await press(desk, 'Escape');
      await desk.until(NO_MENU, 3000);
      const longPress = await desk.eval(`(() => { const t = document.elementFromPoint(${at.x}, ${at.y}); t.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: ${at.x}, clientY: ${at.y} }));
        const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${at.x}, clientY: ${at.y} }); t.dispatchEvent(e);
        return JSON.stringify({ kept: !e.defaultPrevented, menu: !!document.querySelector('.agm-menu'), selected: !getSelection().isCollapsed }); })()`);
      const wantMenu = ['pick.copy', ...pickChips.map(([id]) => id), 'pick.picture', 'pick.view', 'pick.document', 'pick.person'];
      report(JSON.stringify(pickMenu) === JSON.stringify(wantMenu) && longPress === JSON.stringify({ kept: true, menu: false, selected: true }),
        `a right-click on the pick opens exactly the bar's chips as a menu, Copy first, then the picture, what is in view, the document and a person; a touch's long press keeps the browser's selection (${JSON.stringify({ pickMenu, longPress })})`);

      // Picture of this page arrives as a picture, The document at this place as the document at that page (the pick's
      // menu's acts); What I see at 200 % sends the part of the page in view.
      const picture = await desk.eval(`(() => { act('pick', 'pick.picture', PickBar.object(), {}); return true; })()`) && await cy.until(`(() => { const i = document.querySelector('#pageLayer[data-kind="image"] #layerBox img'); return i && i.naturalWidth > 0 && JSON.stringify({ line: document.querySelector('#layerBox .take-file-line').textContent, ratio: +(i.naturalWidth / i.naturalHeight).toFixed(2) }); })()`, 20000);
      const documentAt = await desk.eval(`(() => { act('pick', 'pick.document', PickBar.object(), {}); return true; })()`) && await cy.until(`document.getElementById('pageLayer').dataset.kind === 'doc' && !!document.querySelector('#layerBox canvas:not(.pdf-page-pending)') && (document.querySelector('#layerBox .take-file-line') || {}).textContent`, 20000);
      for (let i = 0; i < 3; i++) await desk.eval(`document.querySelector('#docDisplay .dv-zoom [aria-label="Zoom in"]').click()`);
      await sleep(500);
      await cy.eval(`(() => { for (const i of document.querySelectorAll('#layerBox img')) i.dataset.old = '1'; return true; })()`);
      await desk.eval(`document.getElementById('showSeen').click()`);
      const seen = await cy.until(`(() => { const i = document.querySelector('#pageLayer[data-kind="image"] #layerBox img:not([data-old])'); return i && i.naturalWidth > 0 && JSON.stringify({ line: document.querySelector('#layerBox .take-file-line').textContent, ratio: +(i.naturalWidth / i.naturalHeight).toFixed(2) }); })()`, 20000);
      const pageRatio = JSON.parse(picture || '{}').ratio;
      const seenRatio = JSON.parse(seen || '{}').ratio;
      report(!!picture && /picture of their copy of board pack\.pdf, p\. 3$/.test(JSON.parse(picture).line) && documentAt === 'board pack.pdf · p. 3' && !!seen && /^Ana Admin's picture of their copy of board pack\.pdf, p\. \d$/.test(JSON.parse(seen).line) && Math.abs(seenRatio - pageRatio) > 0.2,
        `Picture of this page arrives as a picture of p. 3, The document at this place as the document at p. 3, and What I see at 200 % as a picture of the part of the page in view, not the page (${JSON.stringify({ picture, documentAt, seen })})`);

      // An untagged PDF offers no cell, and offers the region: its tables cannot be read as cells.
      await attach(fixture('board-pack-untagged.pdf'), 'plain pack.pdf', 'application/pdf');
      await desk.until(`document.querySelectorAll('#docDisplay .textLayer span[role="presentation"]').length > 0 && document.getElementById('docTitle').textContent === 'plain pack.pdf'`, 20000);
      await desk.eval(`docView.goto({ page: 3 })`);
      await desk.until(`document.querySelectorAll('${P3} span[role="presentation"]').length > 3`, 10000);
      await desk.eval(`(() => { const s = [...document.querySelectorAll('${P3} span[role="presentation"]')].find((x) => x.textContent.trim() === '5'); const r = document.createRange(); r.selectNodeContents(s.firstChild); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
      const untagged = JSON.parse((await desk.until(`(() => { const b = document.getElementById('pickBar'); const c = [...document.querySelectorAll('#pickChips .pick-chip')].map((x) => x.dataset.action); return !b.hidden && c.length && document.getElementById('docTitle').textContent === 'plain pack.pdf' && JSON.stringify({ chips: c, says: document.getElementById('pickSay').textContent, region: !document.getElementById('regionBtn').hidden }); })()`, 8000)) || 'null');
      report(!!untagged && !untagged.chips.includes('pick.cell') && untagged.says.startsWith('Tables in this PDF cannot be read as cells — send the region as a picture') && untagged.region,
        `an untagged PDF offers no cell, says its tables cannot be read as cells, and offers the region (${JSON.stringify(untagged)})`);

      // A region of a picture arrives as a new picture, without the original's metadata (its EXIF, its place).
      const exifJpeg = await desk.eval(`(async () => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#204080'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#f0c000'; g.fillRect(80, 50, 160, 100);
        const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
        const payload = new TextEncoder().encode('Exif\\0\\0GPSPLACEHERE-51.5007-0.1246');
        const seg = new Uint8Array(4 + payload.length); seg[0] = 0xff; seg[1] = 0xe1; seg[2] = (payload.length + 2) >> 8; seg[3] = (payload.length + 2) & 255; seg.set(payload, 4);
        const out = new Uint8Array(b.length + seg.length); out.set(b.subarray(0, 2)); out.set(seg, 2); out.set(b.subarray(2), 2 + seg.length);
        attachFile(new File([out], 'stage plan.jpg', { type: 'image/jpeg' })); return out.length;
      })()`);
      const imgBox = JSON.parse((await desk.until(`(() => { const i = document.querySelector('#docDisplay img.dv-img'); if (!i || !i.naturalWidth) return ''; const r = i.getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }); })()`, 15000)) || 'null');
      if (imgBox) {
        await desk.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(imgBox.x + imgBox.w * 0.25), y: Math.round(imgBox.y + imgBox.h * 0.25), button: 'left', buttons: 1, clickCount: 1 });
        await desk.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(imgBox.x + imgBox.w * 0.6), y: Math.round(imgBox.y + imgBox.h * 0.7), button: 'left', buttons: 1 });
        await desk.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(imgBox.x + imgBox.w * 0.6), y: Math.round(imgBox.y + imgBox.h * 0.7), button: 'left', buttons: 0, clickCount: 1 });
      }
      const regionSaid = await desk.until(`!document.getElementById('pickBar').hidden && document.getElementById('pickWords').textContent`, 5000);
      await cy.eval(`(() => { for (const i of document.querySelectorAll('#layerBox img')) i.dataset.old = '1'; return true; })()`);
      await desk.eval(`document.getElementById('pickShow').click()`);
      const regionOnCy = await cy.until(`(() => { const i = document.querySelector('#pageLayer[data-kind="image"] #layerBox img:not([data-old])'); return i && i.naturalWidth > 0 && JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight, line: document.querySelector('#layerBox .take-file-line').textContent }); })()`, 20000);
      const regionUrl = await cy.eval(`(() => { const t = Takes.over(); return t && t.content.kind === 'image' ? t.content.url : ''; })()`);
      const regionBytes = regionUrl ? await desk.eval(`fetch(${codeLiteral(regionUrl)}, { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => { const t = new TextDecoder('latin1').decode(b); return JSON.stringify({ exif: t.includes('Exif'), place: t.includes('GPSPLACEHERE'), size: b.byteLength }); })`) : '';
      const rg = JSON.parse(regionOnCy || 'null');
      report(exifJpeg > 0 && regionSaid === 'A region of the picture, as a picture' && !!rg && rg.w < 320 && rg.h < 200 && rg.line === 'Ana Admin\'s picture of part of their copy of stage plan.jpg' && JSON.parse(regionBytes || '{}').exif === false && JSON.parse(regionBytes || '{}').place === false,
        `a region of a picture arrives as a new picture of that part alone, without the original's EXIF or its place (${JSON.stringify({ regionSaid, rg, regionBytes })})`);

      // A spreadsheet: a column goes with its label cell, a cell with its row's and its column's labels.
      await attach(officeZip(sheetParts([['', 'Q1', 'Q2', 'Q3'], ['Revenue', '1', '2', '4.2'], ['Costs', '3', '4', '3.9']], 'Results')), 'q3.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await desk.until(`!!document.querySelector('#docDisplay table.dv-grid td[data-r="1"][data-c="3"]')`, 15000);
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay table.dv-grid th.dv-col[data-c="3"]')`));
      await chipsWith('pick.column');
      const sheetColumn = await shows();
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay table.dv-grid td[data-r="1"][data-c="3"]')`));
      await chipsWith('pick.cell');
      const cellWords = await desk.eval(`document.getElementById('pickWords').textContent`);
      const sheetCell = await shows();
      report(JSON.stringify(sheetColumn.drawn && sheetColumn.drawn.table) === JSON.stringify([['Q3'], ['4.2'], ['3.9']]) && sheetColumn.drawn.heads === 1 && sheetColumn.mark === '✓|snippet'
        && JSON.stringify(sheetCell.drawn && sheetCell.drawn.table) === JSON.stringify([['', 'Q3'], ['Revenue', '4.2']]) && sheetCell.drawn.focus === '4.2' && cellWords === 'D2 · Revenue (row 2) · Q3 (column D)'
        && sheetCell.drawn.line === 'Quoted by Ana Admin from their copy of q3.xlsx, \'Results\'!D2',
        `a spreadsheet's column arrives with its label cell, and a cell with its two labels, the bar saying them first (${JSON.stringify({ sheetColumn, sheetCell, cellWords })})`);

      // Hidden rows, columns and sheets are never picked: a hidden column's header, a hidden row's header and cell, and a
      // hidden sheet's cell pick nothing, and nothing of a hidden sheet is in view to send. A sheet's labels are its frozen
      // panes by default: the title row above its frozen header is no cell's label.
      await attach(officeZip(sheetParts([['Results for Q3'], ['', 'Q1', 'Q2', 'Q3'], ['Revenue', '1', 'HIDDENCOL', '4.2'], ['SECRETROW', '9', '9', '9'], ['Costs', '3', '4', '3.9']], 'Board',
        { frozen: { rows: 2, cols: 1 }, hiddenRows: [3], hiddenCols: [2], hiddenSheet: [['VERYSECRET', '1']] })), 'hidden parts.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await desk.until(`document.getElementById('docTitle').textContent === 'hidden parts.xlsx' && !!document.querySelector('#docDisplay table.dv-grid td[data-r="2"][data-c="3"]')`, 15000);
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay table.dv-grid td[data-r="2"][data-c="3"]')`));
      await chipsWith('pick.cell');
      const frozenWords = await desk.eval(`document.getElementById('pickWords').textContent`);
      const NO_PICK = JSON.stringify({ bar: true, pick: null });
      const tryHidden = async (el) => {
        await desk.eval(`docView.clearPick()`);
        await leftClick(desk, await middleOf(desk, el));
        await sleep(300);
        return desk.eval(`JSON.stringify({ bar: document.getElementById('pickBar').hidden, pick: docView.pick() })`);
      };
      const hiddenCol = await tryHidden(`document.querySelector('#docDisplay table.dv-grid th.dv-col.dv-hidden[data-c="2"]')`);
      const hiddenRow = await tryHidden(`document.querySelector('#docDisplay table.dv-grid tr.dv-hidden th.dv-row[data-r="3"]')`);
      const hiddenCell = await tryHidden(`document.querySelector('#docDisplay table.dv-grid tr.dv-hidden td[data-r="3"][data-c="1"]')`);
      await desk.eval(`document.querySelectorAll('#docDisplay .sheet-tab')[1].click()`);
      await desk.until(`!!document.querySelector('#docDisplay table.dv-grid.dv-hidden td[data-r="0"][data-c="0"]')`, 5000);
      const hiddenSheet = await tryHidden(`document.querySelector('#docDisplay table.dv-grid.dv-hidden td[data-r="0"][data-c="0"]')`);
      const hiddenSeen = await desk.eval(`JSON.stringify(docView.seen({}))`);
      report(frozenWords === 'D3 · Revenue (row 3) · Q3 (column D)' && [hiddenCol, hiddenRow, hiddenCell, hiddenSheet].every((x) => x === NO_PICK) && hiddenSeen === 'null',
        `a hidden column's header, a hidden row's header and cell, and a hidden sheet's cell pick nothing, and nothing of a hidden sheet is in view to send; a cell's labels are the sheet's frozen panes, never the title row above them (${JSON.stringify({ frozenWords, hiddenCol, hiddenRow, hiddenCell, hiddenSheet, hiddenSeen })})`);

      // A CSV's row; a Markdown file's item; a slide.
      await attach(Buffer.from('Item,Q1,Q2\nPlant,4,5\nStaff,2,2\n'), 'costs.csv', 'text/csv');
      await desk.until(`!!document.querySelector('#docDisplay table.dv-grid th.dv-row[data-r="1"]')`, 15000);
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay table.dv-grid th.dv-row[data-r="1"]')`));
      await chipsWith('pick.row');
      const csvRow = await shows();
      await attach(Buffer.from('# Plan\n\n- First item\n- Second item\n'), 'plan.md', 'text/markdown');
      await desk.until(`!!document.querySelector('#docDisplay .dv-li-text')`, 15000);
      await select('Second item', 0, 6);
      await chipsWith('pick.item');
      const mdItem = await showUnit('pick.item');
      await attach(officeZip(deckParts([{ xml: deckSlide(deckShape('Results', { ph: 'title' }) + deckShape(['Revenue up', 'Costs flat'], { ph: 'body', id: 3 })) }])), 'results.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      await desk.until(`!!document.querySelector('#docDisplay .dv-slide .dv-li-text')`, 15000);
      await select('Costs flat', 0, 5);
      await chipsWith('pick.slide');
      const slide = await showUnit('pick.slide');
      report(JSON.stringify(csvRow.drawn && csvRow.drawn.table) === JSON.stringify([['Item', 'Q1', 'Q2'], ['Plant', '4', '5']]) && csvRow.drawn.line === 'Quoted by Ana Admin from their copy of costs.csv, row 2'
        && !!mdItem.drawn && mdItem.drawn.unit === 'item' && mdItem.drawn.text === 'Second item' && mdItem.drawn.line === 'Quoted by Ana Admin from their copy of plan.md, line 4'
        && !!slide.drawn && slide.drawn.unit === 'slide' && slide.drawn.text === 'Results\nRevenue up\nCosts flat' && slide.drawn.line === 'Quoted by Ana Admin from their copy of results.pptx, slide 1'
        && [csvRow, mdItem, slide].every((x) => x.mark === '✓|snippet'),
        `a CSV's row (with its label row), a Markdown file's item and a slide (its title and items) each reach the Board's page, ✓ (${JSON.stringify({ csvRow, mdItem, slide })})`);

      // A quote handed back with Back to chat is under Earlier: its Look draws it again on Cy's page alone, from its data,
      // and says nothing to the server.
      await cy.eval(`document.querySelector('#layerActs [data-action="take.chat"]').click()`);
      await cy.until(`document.getElementById('pageLayer').hidden && 'chat'`, 5000);
      await cy.eval(`(() => { window.__said = []; window.__emitWas = socket.emit; const e = socket.emit; socket.emit = function (ev, ...a) { window.__said.push(ev); return e.call(this, ev, ...a); }; return true; })()`);
      await cy.eval(`document.getElementById('tabShown') && !document.getElementById('bvTabs').hidden && document.getElementById('tabShown').click()`);
      await cy.until(`!!document.querySelector('#takeEarlier [data-action="past.look"]')`, 5000);
      await cy.eval(`document.querySelector('#takeEarlier [data-action="past.look"]').click()`);
      const quoteLook = await cy.until(`document.getElementById('webPreview').open && (() => { const q = document.querySelector('#webPreviewBox .take-quote'); return q && JSON.stringify({ what: document.getElementById('webPreviewWhat').textContent, show: !document.getElementById('webPreviewShow').hidden, unit: q.dataset.unit, line: q.querySelector('.take-quote-line').textContent }); })()`, 8000);
      await cy.eval(`document.getElementById('webPreview').close()`);
      await sleep(300);
      const lookSaid = await cy.eval(`(() => { const n = window.__said.filter((e) => e === 'page:report').length; socket.emit = window.__emitWas; if (document.getElementById('tabChat') && !document.getElementById('bvTabs').hidden) document.getElementById('tabChat').click(); return n; })()`);
      report(quoteLook === JSON.stringify({ what: 'Look', show: false, unit: 'slide', line: 'Quoted by Ana Admin from their copy of results.pptx, slide 1' }) && lookSaid === 0,
        `a quote under Earlier: its Look draws it again on the Board member's page alone, from its data, and says nothing to the server (${JSON.stringify({ quoteLook, lookSaid })})`);

      // A picture in a slide, tapped, goes as a picture of its own, drawn again: nothing else of the deck goes.
      await attach(officeZip(deckParts([{ xml: deckSlide(deckShape('Chart', { ph: 'title' }) + deckPicture('rId2')), rels: [['rId2', 'image', '../media/chart.png']] }], { 'chart.png': pngOf(40, 30) })), 'chart deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      await desk.until(`document.getElementById('docTitle').textContent === 'chart deck.pptx' && (() => { const i = document.querySelector('#docDisplay .dv-slide img'); return !!i && i.naturalWidth > 0; })()`, 15000);
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay .dv-slide img')`));
      const insideSaid = await desk.until(`!document.getElementById('pickBar').hidden && document.getElementById('pickWords').textContent`, 5000);
      await cy.eval(`(() => { for (const i of document.querySelectorAll('#layerBox img')) i.dataset.old = '1'; return true; })()`);
      await desk.eval(`document.getElementById('pickShow').click()`);
      const insideOnCy = await cy.until(`(() => { const i = document.querySelector('#pageLayer[data-kind="image"] #layerBox img:not([data-old])'); return i && i.naturalWidth > 0 && JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight, line: document.querySelector('#layerBox .take-file-line').textContent }); })()`, 20000);
      report(insideSaid === 'A picture in slide 1, as a picture of its own' && insideOnCy === JSON.stringify({ w: 40, h: 30, line: 'Ana Admin\'s picture of their copy of chart deck.pptx, slide 1' }),
        `a picture in a slide, tapped, is offered as a picture of its own and reaches the Board's page drawn again, said as the researcher's picture of the deck at its slide (${JSON.stringify({ insideSaid, insideOnCy })})`);

      // A Word document: a paragraph says Word's own page ("p. 3", its rendered breaks) or a guess ("≈ p. 2", its explicit
      // ones); a table's cell; What I see sends the blocks in view.
      const W_P = (t) => '<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p>';
      const BROKE = '<w:r><w:lastRenderedPageBreak/></w:r>';
      const cellXml = (t) => '<w:tc><w:p><w:r><w:t>' + t + '</w:t></w:r></w:p></w:tc>';
      await attach(officeZip(wordParts({ body: W_P('One') + '<w:p>' + BROKE + '<w:r><w:t>Two</w:t></w:r></w:p>' + '<w:p>' + BROKE + '<w:r><w:t>Three is on the third page</w:t></w:r></w:p>'
        + '<w:tbl><w:tr>' + cellXml('Item') + cellXml('Cost') + '</w:tr><w:tr>' + cellXml('Plant') + cellXml('4') + '</w:tr></w:tbl>', pages: 3 })), 'minutes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      await desk.until(`!!document.querySelector('#docDisplay table.dv-table td[data-r="1"]') && [...document.querySelectorAll('#docDisplay p')].some((p) => p.textContent === 'Three is on the third page')`, 20000);
      await select('Three is on', 0, 5);
      await chipsWith('pick.paragraph');
      const wordPage = await showUnit('pick.paragraph');
      await leftClick(desk, await middleOf(desk, `document.querySelector('#docDisplay table.dv-table td[data-r="1"][data-c="1"]')`));
      await chipsWith('pick.cell');
      const wordCell = await shows();
      const wordSeen = await shows(`document.getElementById('showSeen').click()`);
      await attach(officeZip(wordParts({ body: W_P('First') + '<w:p><w:r><w:br w:type="page"/><w:t>Second on the next page</w:t></w:r></w:p>' })), 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      await desk.until(`[...document.querySelectorAll('#docDisplay p')].some((p) => p.textContent === 'Second on the next page')`, 20000);
      await select('Second on', 0, 6);
      await chipsWith('pick.paragraph');
      const wordGuess = await showUnit('pick.paragraph');
      report(!!wordPage.drawn && wordPage.drawn.line === 'Quoted by Ana Admin from their copy of minutes.docx, p. 3' && !!wordGuess.drawn && wordGuess.drawn.line === 'Quoted by Ana Admin from their copy of notes.docx, ≈ p. 2'
        && JSON.stringify(wordCell.drawn && wordCell.drawn.table) === JSON.stringify([['Item', 'Cost'], ['Plant', '4']]) && wordCell.drawn.focus === '4'
        && !!wordSeen.drawn && wordSeen.drawn.unit === 'view' && wordSeen.drawn.text.includes('Three is on the third page') && [wordPage, wordCell, wordSeen, wordGuess].every((x) => x.mark === '✓|snippet'),
        `a Word document's paragraph reads "p. 3" on the Board from Word's own breaks and "≈ p. 2" from explicit ones; a table's cell with its labels; What I see sends the blocks in view (${JSON.stringify({ wordPage, wordGuess, wordCell, wordSeen })})`);

      // The fresh-push warning: with another pusher's quote up under 15 s, the bar says whose the Board is reading.
      const other = await connect(base, cookie);
      // Asked again while the server says this address is busy (the smoke's many pages share one address).
      let theirs = null;
      for (let i = 0; i < 40; i++) {
        theirs = await emit(other, 'page:push', { code: pkHall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Revenue Q3: £4.2m' } });
        if (!(theirs && theirs.busy)) break;
        await sleep(Math.min(2000, (theirs && theirs.retryMs) || 500));
      }
      await desk.eval(`Console.read()`);
      const picked = await select('Second on', 0, 6);
      const freshSaid = await desk.until(`(() => { const t = document.getElementById('pickSay').textContent; return /reading .+'s quote \\(\\d+ s\\)/.test(t) && t; })()`, 8000);
      const barSaid = freshSaid ? '' : await desk.eval(`JSON.stringify({ say: document.getElementById('pickSay').textContent, info: (Console.board() || {}).info || null, now: Date.now() })`);
      other.close();
      report(!!theirs && theirs.ok && !!freshSaid && /^The Board is reading .+'s quote \(\d+ s\) — Replace · Show a person instead/.test(freshSaid),
        `another pusher's quote under 15 s old: the bar says whose the Board is reading, with Replace and Show a person instead, and refuses nothing (${freshSaid || JSON.stringify({ theirs: theirs && (theirs.ok || theirs.error), picked, barSaid })})`);

      // The bar's last choice between a picture and the document is kept across a reload: the one chosen last drawn first.
      await desk.eval(`(() => { localStorage.removeItem('agm.showAs'); return true; })()`);
      await attach(fixture('board-pack-tagged.pdf'), 'board pack.pdf', 'application/pdf');
      await desk.until(`!document.getElementById('previewBar').hidden && document.getElementById('docTitle').textContent === 'board pack.pdf'`, 20000);
      const firstBefore = await desk.eval(`document.getElementById('showPicture').classList.contains('primary') ? 'picture' : 'document'`);
      await desk.eval(`document.getElementById('showDocument').click()`);
      await cy.until(`document.getElementById('pageLayer').dataset.kind === 'doc'`, 15000);
      await desk.send('Page.reload');
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush`, 10000);
      await attach(fixture('board-pack-tagged.pdf'), 'board pack.pdf', 'application/pdf');
      const firstAfter = await desk.until(`!document.getElementById('previewBar').hidden && document.getElementById('docTitle').textContent === 'board pack.pdf' && JSON.stringify({ primary: document.getElementById('showDocument').classList.contains('primary'), first: document.querySelector('#previewBar .preview-doc').previousElementSibling === null })`, 20000);
      report(firstBefore === 'picture' && firstAfter === JSON.stringify({ primary: true, first: true }), `the bar's last choice between a picture and the document is kept across a reload, drawn first (${JSON.stringify({ firstBefore, firstAfter })})`);

      // A fifth quick page picture waits with "Sending in 2 s…" and arrives (the uploads' rate: a burst of 4, then one every 2 s).
      await sleep(8500);
      await desk.until(`!!docView && document.querySelectorAll('#docDisplay canvas.pdf-page:not(.pdf-page-pending)').length > 0`, 15000);
      // Which of the five the rate turns away is the order their uploads reach the server in: that one is shown last, once
      // it has waited, so the page it is of is read from the order the five were shown in.
      await desk.eval(`(() => { window.__toasts = []; window.__shownAs = []; const src = Show.sourceOf(previewing); for (let n = 1; n <= 5; n++) Show.picture(src, n, 'board', { view: docView }).then(() => window.__shownAs.push(n)); return true; })()`);
      const last = Number(await desk.until(`window.__shownAs.length === 5 && String(window.__shownAs[4])`, 40000));
      const fifth = last ? await cy.until(`(() => { const l = document.querySelector('#pageLayer[data-kind="image"] .take-file-line'); return l && l.textContent.endsWith(', p. ${last}') && l.textContent; })()`, 20000) : null;
      const waited = await desk.eval(`window.__toasts.some((t) => t === 'Sending in 2 s…')`);
      report(!!fifth && waited === true, `five quick page pictures: the one the uploads' rate turned away says "Sending in 2 s…" and arrives (${JSON.stringify({ fifth, waited, order: await desk.eval('JSON.stringify(window.__shownAs)') })})`);

      const pickProblems = [['desk', desk], ['cy', cy]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(pickProblems.length === 0, `the pick hall's pages: no console error and no CSP violation${pickProblems.length ? ' — ' + pickProblems.slice(0, 4).join(' | ') : ''}`);
      for (const t of [desk, cy]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
    }

    // ---------------- A pasted or typed quote, and a web page at a place (unit 28) ----------------
    // In a hall of its own: the admin account's page backstage (the operator, who may show web pages), Cy On stage on a
    // device of her own, and later Qia, a Staff account who may show quotes but not web pages. The ❝ Quote tab reads a paste
    // from the paste event's clipboard: tab-separated words become a table; HTML is read for its structure alone through
    // parseInert (nothing in it loads, a hidden part's words never arrive), and only where it agrees with the plain words;
    // typed words read "Typed by Ana Admin". A quote from a web page carries Open the source, at the quote's words, only
    // from a pusher who may show a web page; a web page with a text directive says its words beside the frame and keeps
    // them in Open in a new tab.
    {
      const qtHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Quote hall' }) })).json()).code;
      const signIn = async (t, username, password) => {
        await t.until(`document.readyState === 'complete'`);
        return t.eval(`(async () => { for (let i = 0; i < 5; i++) { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${codeLiteral(username)}, password: ${codeLiteral(password)} }) }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; })()`);
      };
      const desk = await edge.tab(`${base}/`, { alone: true });
      if (await signIn(desk, 'ana', 'the green room kettle') !== 200) throw new Error('the quote hall\'s operator could not sign in');
      // Every address the operator's page asks for, from here on: a pasted picture is never one of them.
      const asked = [];
      desk.on('Network.requestWillBeSent', (p) => asked.push(p.request.url));
      await desk.send('Network.enable');
      await desk.eval(`location.href = ${codeLiteral(`/app.html?code=${qtHall}&as=account&role=research`)}`);
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush && F.canWeb`, 10000);
      const cy = await edge.tab(`${base}/app.html?code=${qtHall}&name=Cy&role=board&invite=${inviteOf(dataDir, qtHall)}`, { alone: true });
      await cy.until(`typeof joined !== 'undefined' && joined`, 10000);
      // What Cy's page is told of each take, kept as it comes.
      await cy.eval(`(() => { window.__told = []; socket.on('page:take', (t) => window.__told.push(t)); return true; })()`);
      // The venue's web page answered by the browser itself (agm-web.invalid: a page of a few words).
      cy.on('Fetch.requestPaused', (p) => { cy.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><title>Report</title><p>Net revenue rose in Q3</p>').toString('base64') }); });
      await cy.send('Fetch.enable', { patterns: [{ urlPattern: 'https://agm-web.invalid/*', requestStage: 'Request' }] });

      // The tab, for a seat that may show the Board; a paste as the browser hands it to the box (its two flavours).
      const tabShown = await desk.until(`!document.getElementById('quoteTab').hidden && 'shown'`, 8000);
      await desk.eval(`document.getElementById('quoteTab').click()`);
      const paste = (t, plain, html) => t.eval(`(() => { const box = document.getElementById('quoteInput'); box.focus(); box.select(); const dt = new DataTransfer(); ${html ? `dt.setData('text/html', ${codeLiteral(html)});` : ''} dt.setData('text/plain', ${codeLiteral(plain)});
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
      const typed = (t, words) => t.eval(`(() => { const box = document.getElementById('quoteInput'); box.value = ${codeLiteral(words)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const said = (t, start) => t.until(`(() => { const s = document.getElementById('quoteSay').textContent; return s.startsWith(${codeLiteral(start)}) && !document.getElementById('quoteShow').disabled && !!document.querySelector('#quotePreview .take-quote') && s; })()`, 8000);
      const QUOTE_ON_CY = `(() => { const q = document.querySelector('#layerBox .take-quote:not([data-old])'); if (document.getElementById('pageLayer').hidden || !q) return ''; const a = q.querySelector('.take-quote-open');
        return JSON.stringify({ unit: q.dataset.unit, text: q.querySelector('.take-quote-body').innerText.replace(/\\n+/g, '\\n').trim(), line: q.querySelector('.take-quote-line').textContent,
          table: [...q.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent)), heads: q.querySelectorAll('.take-quote-head').length, href: a ? a.href : '', target: a ? a.target : '', rel: a ? a.rel : '' }); })()`;
      /** Show from `t`'s tab, and what Cy's page draws of it. */
      const shows = async (t = desk) => {
        await cy.eval(`(() => { for (const q of document.querySelectorAll('#layerBox .take-quote')) q.dataset.old = '1'; return true; })()`);
        await t.eval(`document.getElementById('quoteShow').click()`);
        return JSON.parse((await cy.until(QUOTE_ON_CY, 10000)) || 'null');
      };

      // Tab-separated words (what Excel and Sheets put on the clipboard) become a table.
      await paste(desk, 'Item\tQ3\nRevenue\t4.2\nCosts\t3.9\n');
      const tsvSaid = await said(desk, 'A table');
      const tsv = await shows();
      const boxAfter = await desk.until(`document.getElementById('quoteInput').value === '' && 'emptied'`, 5000);
      report(tabShown === 'shown' && tsvSaid === 'A table, 3 rows × 2 columns. ' && !!tsv && tsv.unit === 'range' && JSON.stringify(tsv.table) === JSON.stringify([['Item', 'Q3'], ['Revenue', '4.2'], ['Costs', '3.9']]) && tsv.line === 'Typed by Ana Admin' && boxAfter === 'emptied',
        `the ❝ Quote tab: pasted tab-separated words become a table snippet on the Board's page, and the box is emptied once it went (${JSON.stringify({ tabShown, tsvSaid, tsv, boxAfter })})`);

      // HTML with a table: its rows and cells, its header row as labels; its picture fetches nothing, and a display:none
      // span's words never arrive.
      const IMG = 'https://agm-img.invalid/pasted.png';
      await paste(desk, 'Item\tQ3\nRevenue\t4.2', `<meta charset="utf-8"><table><tr><th>Item</th><th>Q3</th></tr><tr><td>Revenue<span style="display:none">SECRET-SALARY</span><img src="${IMG}"></td><td>4.2</td></tr></table>`);
      await said(desk, 'A table, 2 rows');
      const html = await shows();
      await sleep(500);
      const fetchedImg = asked.filter((u) => u.startsWith('https://agm-img.invalid/'));
      const toldHtml = await cy.eval(`JSON.stringify(window.__told)`);
      report(!!html && JSON.stringify(html.table) === JSON.stringify([['Item', 'Q3'], ['Revenue', '4.2']]) && html.heads === 2 && fetchedImg.length === 0 && !toldHtml.includes('SECRET-SALARY') && !JSON.stringify(html).includes('SECRET'),
        `pasted HTML with a table becomes its rows (its header row the labels); its <img> fetches nothing (the network log), and a display:none span's words are absent (${JSON.stringify({ html, fetchedImg })})`);

      // HTML whose words disagree with its plain flavour (a part hidden by a style sheet): the plain words alone.
      await paste(desk, 'One\nTwo', '<ul><li>One</li><li>Two</li><li class="gone">UNSEEN-ITEM</li></ul>');
      const disagreeSaid = await said(desk, 'Text');
      const disagree = await shows();
      report(disagreeSaid === 'Text, 7 characters. ' && !!disagree && disagree.unit === 'text' && disagree.text === 'One\nTwo' && !JSON.stringify(disagree).includes('UNSEEN'),
        `pasted HTML whose words disagree with its text/plain flavour falls back to the plain words (${JSON.stringify({ disagreeSaid, disagree })})`);

      // A table of 25 rows × 10 columns, within the stage's bounds yet longer than a glance on a tablet: said so, never refused.
      await paste(desk, Array.from({ length: 25 }, (_, r) => Array.from({ length: 10 }, (__, c) => (r === 0 ? 'Q' + (c + 1) : String((r + 1) * (c + 3)))).join('\t')).join('\n'));
      const longSaid = await desk.until(`(() => { const s = document.getElementById('quoteSay').textContent; return s.includes('Long for the stage') && !document.getElementById('quoteShow').disabled && s; })()`, 8000);
      // A file dragged over the box finds no place to land (neither here nor the composer's attach), and one dropped is said
      // and attaches nothing to a message.
      const dropped = await desk.eval(`(() => { const box = document.getElementById('quoteInput'); const dt = new DataTransfer(); dt.items.add(new File(['x'], 'stage plan.png', { type: 'image/png' }));
        const t = document.getElementById('agmToast'); if (t) t.textContent = '';
        const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }); box.dispatchEvent(over);
        const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }); box.dispatchEvent(drop);
        return JSON.stringify({ over: over.defaultPrevented, effect: dt.dropEffect, hover: document.getElementById('researchCompose').classList.contains('drop-hover'), drop: drop.defaultPrevented, attached: pendingFile !== null, chip: !document.getElementById('fileChip').hidden }); })()`);
      const dropSaid = await desk.until(`(document.getElementById('agmToast') || {}).textContent`, 3000);
      report(/^A table, 25 rows × 10 columns\. Long for the stage — the Board will scroll\.$/.test(longSaid || '') && dropped === JSON.stringify({ over: true, effect: 'none', hover: false, drop: true, attached: false, chip: false })
        && /^A file is not a quote/.test(dropSaid || ''),
        `the ❝ Quote tab says a quote longer than a glance on a tablet is "Long for the stage — the Board will scroll", and Show stays offered; a file dragged over its box has no place to land, and one dropped is said and attaches nothing (${JSON.stringify({ longSaid, dropped, dropSaid })})`);

      // Typed words, from nothing: "Typed by Ana Admin".
      await typed(desk, 'Revenue Q3: £4.2m');
      await said(desk, 'Text, 17');
      const typedQ = await shows();
      report(!!typedQ && typedQ.unit === 'text' && typedQ.text === 'Revenue Q3: £4.2m' && typedQ.line === 'Typed by Ana Admin' && typedQ.href === '',
        `typed words read "Typed by Ana Admin" on the Board's page (${JSON.stringify(typedQ)})`);

      // From a web page, by the operator (who may show web pages): Open the source, in a tab of the person's own, at the
      // quote's first and last words (the address has no fragment of its own).
      await typed(desk, 'Net revenue rose 8 percent in the third quarter');
      await desk.eval(`(() => { const s = document.getElementById('quoteFrom'); s.value = 'web'; s.dispatchEvent(new Event('change', { bubbles: true })); const w = document.getElementById('quoteWeb'); w.value = 'https://agm-web.invalid/results?token=0p3n'; w.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await said(desk, 'Text');
      const previewLink = await desk.eval(`(() => { const a = document.querySelector('#quotePreview .take-quote-open'); return a ? a.href : ''; })()`);
      const fromWeb = await shows();
      const SOURCE = 'https://agm-web.invalid/results?token=0p3n#:~:text=Net%20revenue%20rose%208,in%20the%20third%20quarter';
      const toldWeb = await cy.eval(`JSON.stringify((window.__told.filter((t) => t.content && t.content.kind === 'snippet').pop() || {}).content.from)`);
      report(!!fromWeb && fromWeb.line === 'Quoted by Ana Admin · agm-web.invalid · Open the source' && fromWeb.href === SOURCE && fromWeb.target === '_blank' && fromWeb.rel === 'noopener noreferrer' && previewLink === SOURCE
        && toldWeb === JSON.stringify({ host: 'agm-web.invalid', url: 'https://agm-web.invalid/results?token=0p3n' }),
        `a web quote from a pusher who holds stage.web: its card names the host and offers Open the source, a text directive from its first and last words, in a tab of the person's own (${JSON.stringify({ fromWeb, toldWeb, previewLink })})`);

      // Qia, Staff (stage.show, no stage.web): the same quote names the site alone, with no link, and her page says so;
      // nothing Cy's page is told carries its address.
      const qiaMade = await desk.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qia', name: 'Qia Staff', role: 'staff', halls: [${codeLiteral(qtHall)}], password: 'quotes from the web only' }) }).then((r) => r.status)`);
      const qia = await edge.tab(`${base}/build.js`, { alone: true });
      if (qiaMade !== 200 || await signIn(qia, 'qia', 'quotes from the web only') !== 200) throw new Error('Qia could not sign in: ' + qiaMade);
      await qia.send('Page.navigate', { url: `${base}/app.html?code=${qtHall}&as=account&role=research` });
      await qia.until(`typeof joined !== 'undefined' && joined && F.canShow && !F.canPush && !F.canWeb && !document.getElementById('quoteTab').hidden`, 10000);
      // The operator's quote taken down first: a seat that may only show sends to the side bar over the operator's.
      await desk.eval(`new Promise((r) => socket.emit('page:push', { code: HALL_KEY, to: 'board', content: { kind: 'chat', layer: 'info' } }, r))`);
      await cy.until(`document.getElementById('pageLayer').hidden && 'chat'`, 8000);
      await qia.eval(`document.getElementById('quoteTab').click()`);
      await typed(qia, 'Turnout was 64% this year');
      await qia.eval(`(() => { const s = document.getElementById('quoteFrom'); s.value = 'web'; s.dispatchEvent(new Event('change', { bubbles: true })); const w = document.getElementById('quoteWeb'); w.value = 'https://agm-web.invalid/turnout?token=n0r1ght'; w.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await qia.until(`(() => { Console.read(); const b = Console.board(); return !!b && !(b.info && b.info.op) && !b.opOn && 'free'; })()`, 8000);
      const qiaSaid = await said(qia, 'Text');
      const fromQia = await shows(qia);
      const toldAll = await cy.eval(`JSON.stringify(window.__told)`);
      report(!!fromQia && fromQia.line === 'Quoted by Qia Staff · agm-web.invalid' && fromQia.href === '' && !toldAll.includes('n0r1ght') && qiaSaid.includes('The Board is told the site\'s name, without a link: web pages on the stage need their own right.'),
        `a web quote from a pusher without stage.web: the card names the host with no link, and no take carries its address (${JSON.stringify({ fromQia, qiaSaid })})`);

      // Qia's quote is fresh: the operator's tab says the Board is reading it, with Replace, which shows the operator's.
      await desk.eval(`(() => { const s = document.getElementById('quoteFrom'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await typed(desk, 'The vote opens at noon');
      const freshSaid = await desk.until(`(() => { Console.read(); const s = document.getElementById('quoteSay'); return s.textContent.includes("reading Qia Staff's quote") && [...s.querySelectorAll('button')].some((b) => b.textContent === 'Replace') && s.textContent; })()`, 8000);
      await cy.eval(`(() => { for (const q of document.querySelectorAll('#layerBox .take-quote')) q.dataset.old = '1'; return true; })()`);
      await desk.eval(`[...document.querySelectorAll('#quoteSay button')].find((b) => b.textContent === 'Replace').click()`);
      const replaced = JSON.parse((await cy.until(QUOTE_ON_CY, 10000)) || 'null');
      report(/^Text, 22 characters\. The Board is reading Qia Staff's quote \(\d+ s\) — Replace · Show a person instead/.test(freshSaid || '') && !!replaced && replaced.text === 'The vote opens at noon' && replaced.line === 'Typed by Ana Admin',
        `over another pusher's fresh quote the ❝ Quote tab says who the Board is reading, with Replace (which shows it) and Show a person instead (${JSON.stringify({ freshSaid, replaced })})`);

      // Qia given web pages and not quotes (stage.web, without stage.show): she may show the Board a web page, so her page
      // shows on it, but no quote of hers would be taken: the ❝ Quote tab is not drawn for her, nor the Preview's bar.
      const qiaId = await desk.eval(`fetch('/api/users').then((r) => r.json()).then((j) => ((j.users || []).find((u) => u.username === 'qia') || {}).id || '')`);
      const qiaRights = await desk.eval(`fetch('/api/users/' + ${codeLiteral(qiaId)}, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revoke: ['stage.show'], grant: ['stage.web'] }) }).then((r) => r.status)`);
      await qia.send('Page.navigate', { url: `${base}/app.html?code=${qtHall}&as=account&role=research` });
      const webOnly = await qia.until(`typeof joined !== 'undefined' && joined && F.canShow && F.canWeb && !!Console.board() && Console.board().show === false && JSON.stringify({ tab: !document.getElementById('quoteTab').hidden, bar: !document.getElementById('previewBar').hidden })`, 10000);
      report(qiaRights === 200 && webOnly === JSON.stringify({ tab: false, bar: false }),
        `a seat that may show the Board web pages and not quotes is drawn no ❝ Quote tab and no Preview bar (${JSON.stringify({ qiaId: !!qiaId, qiaRights, webOnly })})`);

      // A web page at a place: its text directive's words over the frame ("Look for: ❝ …"), the frame and Open in a new tab
      // keeping the fragment (Cy's page given the full view, where Open in a new tab is in the layer's ⋯).
      const AT_PLACE = 'https://agm-web.invalid/report#:~:text=net%20revenue%20rose,in%20Q3';
      await desk.until(`people.some((u) => u.name === 'Cy' && u.socketId)`, 5000);
      const cyFull = await desk.eval(`new Promise((r) => socket.emit('admin:setView', { roomCode: ROOM, socketId: (people.find((u) => u.name === 'Cy') || {}).socketId, view: 'full' }, (a) => r(JSON.stringify(a))))`);
      const cyView = await cy.until(`document.body.dataset.view === 'full' && F.view === 'full' && 'full'`, 5000);
      await desk.eval(`new Promise((r) => socket.emit('page:push', { code: HALL_KEY, to: 'board', content: { kind: 'web', url: ${codeLiteral(AT_PLACE)} } }, r))`);
      const placed = await cy.until(`(() => { const l = document.querySelector('#layerBox .take-web-look'); const f = document.querySelector('#layerBox iframe'); return l && f && JSON.stringify({ look: l.textContent, src: f.src }); })()`, 10000);
      // Its menu once the page has drawn it (the frame loaded: the layer's object is the take drawn).
      await cy.until(`!!Takes.object() && 'drawn'`, 20000);
      const more = await cy.until(`(() => { const m = document.querySelector('#layerActs .obj-more'); if (!m) return ''; window.__opened = []; window.open = (u, n, o) => { window.__opened.push([u, n, o]); return null; }; m.click(); return 'opened'; })()`, 5000);
      const menuIds = await cy.until(`!!document.querySelector('.agm-menu [data-action="take.tab"]') && JSON.stringify([...document.querySelectorAll('.agm-menu [data-action]')].map((b) => b.dataset.action))`, 5000);
      if (menuIds) await cy.eval(`document.querySelector('.agm-menu [data-action="take.tab"]').click()`);
      const opened = await cy.until(`Array.isArray(window.__opened) && window.__opened.length > 0 && JSON.stringify(window.__opened[0])`, 5000);
      report(placed === JSON.stringify({ look: 'Look for: ❝ net revenue rose … in Q3', src: AT_PLACE }) && opened === JSON.stringify([AT_PLACE, '_blank', 'noopener,noreferrer']),
        `a web take with #:~:text= shows "Look for: ❝ …" over its frame and keeps the fragment in the frame and in Open in a new tab (${JSON.stringify({ placed, opened, cyFull, cyView, more, menuIds, toast: await cy.eval(`(document.getElementById('agmToast') || {}).textContent || ''`) })})`);

      const quoteProblems = [['desk', desk], ['cy', cy], ['qia', qia]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(quoteProblems.length === 0, `the quote hall's pages: no console error and no CSP violation${quoteProblems.length ? ' — ' + quoteProblems.slice(0, 4).join(' | ') : ''}`);
      for (const t of [desk, cy, qia]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
    }

    // ---------------- A push carries one line to the speaker's screen, through the operator or at once (unit 29) ----------------
    // In a hall of its own: the admin account's page backstage (the operator, who holds stage.send), and later Pia, a Staff
    // account who may show quotes but not send to the speaker's screen. ＋ the speaker's screen is in the ❝ Quote tab and the
    // Preview's bar only while the hall has a Stagewatch this seat can reach, off on every push until ticked; ticked, it
    // offers 📝 Ask the operator and 🖥 Send now, each disabled with its reason where its way is closed, preset to the way
    // chosen last on this device. The line is the push's own words: what the mock Stagewatch receives, and the room's line
    // names its length alone.
    {
      const slHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Lectern hall' }) })).json()).code;
      const slSw = await fakeStagewatch({ name: 'Lectern timer' });
      const noDesk = await fakeStagewatch({ name: 'Lectern timer', desk: false });
      const signIn = async (t, username, password) => {
        await t.until(`document.readyState === 'complete'`);
        return t.eval(`(async () => { for (let i = 0; i < 5; i++) { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${codeLiteral(username)}, password: ${codeLiteral(password)} }) }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; })()`);
      };
      const desk = await edge.tab(`${base}/`, { alone: true });
      if (await signIn(desk, 'ana', 'the green room kettle') !== 200) throw new Error('the lectern hall\'s operator could not sign in');
      await desk.eval(`(() => { try { localStorage.removeItem('agm.speakerWay'); } catch { /* a page without storage keeps no choice */ } location.href = ${codeLiteral(`/app.html?code=${slHall}&as=account&role=research`)}; return true; })()`);
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush && !document.getElementById('quoteTab').hidden`, 10000);
      await desk.eval(`document.getElementById('quoteTab').click()`);
      const typed = (words) => desk.eval(`(() => { const box = document.getElementById('quoteInput'); box.value = ${codeLiteral(words)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      // ＋ as it stands in a bar (`id`): shown, ticked, enabled, why not, its two ways, the way chosen, what a send now does, the line said.
      const plus = (id) => desk.eval(`(() => { const r = document.getElementById(${codeLiteral(id)}); const on = r.querySelector('[data-line-on]'); const ways = r.querySelector('[data-line-ways]');
        const way = (v) => { const i = r.querySelector('input[value="' + v + '"]'); const why = r.querySelector('[data-line-closed="' + v + '"]'); return { disabled: i.disabled, checked: i.checked, why: why.hidden ? '' : why.textContent }; };
        return JSON.stringify({ shown: !r.hidden && r.offsetParent !== null, ticked: on.checked, enabled: !on.disabled, why: r.querySelector('[data-line-why]').hidden ? '' : r.querySelector('[data-line-why]').textContent,
          ways: !ways.hidden, propose: way('propose'), send: way('send'), now: r.querySelector('[data-line-now]').hidden ? '' : r.querySelector('[data-line-now]').textContent,
          said: r.querySelector('[data-line-said]').hidden ? '' : r.querySelector('[data-line-said]').textContent }); })()`).then(JSON.parse);
      const tick = (id) => desk.eval(`(() => { const on = document.querySelector('#${id} [data-line-on]'); on.click(); return on.checked; })()`);
      const choose = (id, way) => desk.eval(`(() => { const i = document.querySelector('#${id} input[value="${way}"]'); i.click(); return i.checked; })()`);
      const roomLines = () => desk.eval(`JSON.stringify(allMessages.filter((m) => m.type === 'system').map((m) => m.text))`).then(JSON.parse);

      // No Stagewatch linked: ＋ is not drawn.
      await typed('Revenue Q3: £4.2m');
      await desk.until(`!document.getElementById('quoteShow').disabled && 'ready'`, 8000);
      const unlinked = await plus('quoteLine');
      // The hall's Stagewatch, its key accepted and its desk found: ＋ is drawn, off.
      await desk.eval(`new Promise((r) => socket.emit('hall:configure', { code: HALL_KEY, stagewatchUrl: ${codeLiteral(slSw.url)}, stagewatchKey: ${codeLiteral(KEY)} }, r))`);
      await desk.until(`F.canSendToStage && F.canPropose && !F.stageWhy && !document.getElementById('quoteLine').hidden && 'linked'`, 20000);
      const offFirst = await plus('quoteLine');
      await tick('quoteLine');
      const ticked = await plus('quoteLine');
      report(unlinked.shown === false && offFirst.shown && !offFirst.ticked && offFirst.enabled && !offFirst.ways
        && ticked.ways && !ticked.propose.disabled && !ticked.send.disabled && ticked.propose.checked && !ticked.send.checked
        && ticked.now === 'Replaces what the speaker\'s screen shows now, the operator\'s message included, and cancels its waiting acknowledgement.'
        && ticked.said === '“Revenue Q3: £4.2m” — 17 characters: 500 sent now, about 377 through the desk; it reads at a glance up to about 60.',
        `＋ the speaker's screen: not drawn without a Stagewatch; off by default; ticked, 📝 Ask the operator and 🖥 Send now, the first time Ask the operator, 🖥's words saying it replaces the operator's message, and the line with its count (${JSON.stringify({ unlinked, offFirst, ticked })})`);

      // 📝 Ask the operator: the desk is asked for the quote's own words; the room's line names its length; ＋ is off again.
      await desk.eval(`document.getElementById('quoteShow').click()`);
      const askedLine = await desk.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return t.includes('📝 waiting for the operator') && t; })()`, 10000);
      const proposed = [...slSw.proposals.values()].map((p) => p.line);
      const afterAsk = await plus('quoteLine');
      const askLines = await desk.until(`allMessages.some((m) => m.type === 'system' && m.text === 'Ana Admin asked the operator for a line (17 characters) on the speaker\\'s screen with a push — waiting for the show desk') && 'said'`, 8000);
      report(JSON.stringify(proposed) === JSON.stringify(['message "Revenue Q3: £4.2m" info off ack']) && !afterAsk.ticked && askLines === 'said' && !(await roomLines()).some((l) => l.includes('4.2m')),
        `📝 Ask the operator proposes message "Revenue Q3: £4.2m" info off ack to the desk; the room's line names its length, no quote; ＋ is off again after the push (${JSON.stringify({ askedLine, proposed, afterAsk: afterAsk.ticked })})`);

      // 🖥 Send now: Stagewatch is sent the line at once, and this device keeps the choice.
      await typed('Revenue Q3: £4.2m');
      await desk.until(`!document.getElementById('quoteShow').disabled && 'ready'`, 8000);
      await tick('quoteLine');
      await choose('quoteLine', 'send');
      const sendsBefore = slSw.requests.filter((r) => r.url.startsWith('/api/message/')).length;
      await desk.eval(`document.getElementById('quoteShow').click()`);
      const sentToast = await desk.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return t.includes('🖥 on the speaker\\'s screen') && t; })()`, 10000);
      const sentNow = slSw.requests.filter((r) => r.url.startsWith('/api/message/')).slice(sendsBefore).map((r) => decodeURIComponent(r.url.split('/')[3]));
      const kept = await desk.eval(`localStorage.getItem('agm.speakerWay')`);
      const sendLine = await desk.until(`allMessages.some((m) => m.type === 'system' && m.text === 'Ana Admin sent a line (17 characters) to the speaker\\'s screen with a push') && 'said'`, 8000);
      report(JSON.stringify(sentNow) === JSON.stringify(['Revenue Q3: £4.2m']) && kept === 'send' && sendLine === 'said',
        `🖥 Send now sends the line at once with the push, the room's line reads "… a line (17 characters) to the speaker's screen with a push", and the choice is kept on this device (${JSON.stringify({ sentToast, sentNow, kept })})`);

      // Preset to the last way on this device, after a reload.
      await desk.eval(`location.reload()`);
      await desk.until(`typeof joined !== 'undefined' && joined && F.canSendToStage && F.canPropose && !document.getElementById('quoteTab').hidden`, 15000);
      await desk.eval(`document.getElementById('quoteTab').click()`);
      await typed('Turnout was 64%');
      await desk.until(`!document.getElementById('quoteShow').disabled && 'ready'`, 8000);
      await tick('quoteLine');
      const preset = await plus('quoteLine');
      report(preset.send.checked && !preset.propose.checked, `＋ is preset to the way chosen last on this device (${JSON.stringify(preset)})`);
      await tick('quoteLine');

      // The Preview's bar: a document's line is the line typed above it, never its name; with none, ＋ is disabled with why.
      await desk.eval(`(() => { attachFile(new File([Uint8Array.from(atob('${fixture('board-pack-tagged.pdf').toString('base64')}'), (c) => c.charCodeAt(0))], 'board pack.pdf', { type: 'application/pdf' })); return true; })()`);
      await desk.until(`!document.getElementById('previewBar').hidden && document.getElementById('docTitle').textContent === 'board pack.pdf' && !document.getElementById('pickLine').hidden && 'open'`, 20000);
      const noNote = await plus('pickLine');
      await desk.eval(`(() => { const n = document.getElementById('pickNote'); n.value = 'Look at the second table'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await tick('pickLine');
      const noted = await plus('pickLine');
      const docSendsBefore = slSw.requests.filter((r) => r.url.startsWith('/api/message/')).length;
      await desk.eval(`document.getElementById('showDocument').click()`);
      await desk.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return t.startsWith('The document') && t.includes('🖥') && t; })()`, 20000);
      const docLine = slSw.requests.filter((r) => r.url.startsWith('/api/message/')).slice(docSendsBefore).map((r) => decodeURIComponent(r.url.split('/')[3]));
      report(noNote.shown && !noNote.enabled && noNote.why === 'Pick words in the file, or type a line above it, to put one on the speaker\'s screen.'
        && noted.enabled && noted.ticked && noted.said.startsWith('“Look at the second table” — 24 characters') && noted.said.endsWith('It goes with a picture or the document.') && !noted.said.includes('board pack')
        && JSON.stringify(docLine) === JSON.stringify(['Look at the second table']),
        `＋ is disabled for a document with no line above it, and its line is that line alone, never the file's name (${JSON.stringify({ noNote, noted: noted.said, docLine })})`);

      // Words picked as well: ＋ shows the picked words and the push they go with. The document and what is in view (a picture
      // of the part of the page in view) each carry the line above them, which ＋ did not show: no line goes, and their toast
      // says why. The pick's own Show sends exactly the line ＋ drew.
      const messagesNow = () => slSw.requests.filter((r) => r.url.startsWith('/api/message/'));
      const toastWith = (start, words) => desk.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; return t.startsWith(${codeLiteral(start)}) && t.includes(${codeLiteral(words)}) && t; })()`, 20000);
      await desk.until(`document.querySelectorAll('#docDisplay .textLayer span[role="presentation"]').length > 0 && 'drawn'`, 20000);
      const picked = await desk.eval(`(() => { const w = document.createTreeWalker(document.getElementById('docDisplay'), NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.nodeValue.indexOf('about agenda'); if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i + 6); r.setEnd(n, i + 12); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'selected'; }
        return 'not found'; })()`);
      await desk.until(`!document.getElementById('pickBar').hidden && !!PickBar.lineContent() && 'picked'`, 8000);
      await tick('pickLine');
      const withPick = await plus('pickLine');
      const NOT_SHOWN = 'No line went to the speaker\'s screen: this push\'s words are not the line ＋ showed';
      const beforeOthers = messagesNow().length;
      await desk.eval(`document.getElementById('showDocument').click()`);
      const docToast = await toastWith('The document', NOT_SHOWN);
      await tick('pickLine');
      await desk.eval(`document.getElementById('showSeen').click()`);
      const seenToast = await toastWith('The picture', NOT_SHOWN);
      const othersSent = messagesNow().length - beforeOthers;
      await tick('pickLine');
      const pickShown = await plus('pickLine');
      await desk.eval(`document.getElementById('pickShow').click()`);
      const pickToast = await toastWith('The quote', '🖥');
      const pickSent = messagesNow().slice(beforeOthers).map((r) => decodeURIComponent(r.url.split('/')[3]));
      const drawnLine = (/^“(.*)” — /.exec(pickShown.said) || [])[1];
      report(picked === 'selected' && withPick.said.startsWith('“agenda” — 6 characters') && withPick.said.endsWith('It goes with the picked words, by their 📺 Show.')
        && !!docToast && !!seenToast && othersSent === 0 && drawnLine === 'agenda' && JSON.stringify(pickSent) === JSON.stringify([drawnLine]),
        `with words picked, ＋ shows them and the push they go with; the document and what is in view send no line and say why; the pick's Show sends exactly the line drawn (${JSON.stringify({ withPick: withPick.said, docToast, seenToast, othersSent, pickToast, pickSent })})`);
      await desk.eval(`(() => { getSelection().removeAllRanges(); const n = document.getElementById('pickNote'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

      // ＋ ticked with its way chosen, and the link down by the time of the push: the take goes, and its toast says why no
      // line went, in the link's own words.
      const gone = await fakeStagewatch({ name: 'Lectern timer' });
      const goneUrl = gone.url;
      await gone.close();
      await desk.eval(`document.getElementById('quoteTab').click()`);
      await typed('Turnout was 64%');
      await desk.until(`!document.getElementById('quoteShow').disabled && 'ready'`, 8000);
      await tick('quoteLine');
      const wayBefore = await plus('quoteLine');
      await desk.eval(`new Promise((r) => socket.emit('hall:configure', { code: HALL_KEY, stagewatchUrl: ${codeLiteral(goneUrl)}, stagewatchKey: ${codeLiteral(KEY)} }, r))`);
      // The link's words: checking its key, then not connected (catalog.js stageWhy), each beginning "Stagewatch".
      const downWhy = await desk.until(`F.stageWhy`, 20000);
      await desk.eval(`document.getElementById('quoteShow').click()`);
      const downToast = await toastWith('The quote', 'No line went to the speaker\'s screen: Stagewatch ');
      report(wayBefore.ticked && wayBefore.send.checked && !!downWhy && !!downToast && !slSw.requests.slice(-1).some((r) => r.url.includes('Turnout')),
        `＋ ticked, its way closed by the time of the push: the take goes, and its toast says why no line went, in the link's words (${JSON.stringify({ downWhy, downToast })})`);

      // A Stagewatch without a show desk: 📝 Ask the operator is disabled with its reason, 🖥 Send now chosen.
      await desk.eval(`new Promise((r) => socket.emit('hall:configure', { code: HALL_KEY, stagewatchUrl: ${codeLiteral(noDesk.url)}, stagewatchKey: ${codeLiteral(KEY)} }, r))`);
      await desk.until(`F.canSendToStage && !F.canPropose && !F.stageWhy && 'linked'`, 20000);
      await desk.eval(`document.getElementById('quoteTab').click()`);
      await typed('Revenue Q3: £4.2m');
      await desk.until(`!document.getElementById('quoteShow').disabled && 'ready'`, 8000);
      await tick('quoteLine');
      const oneWay = await plus('quoteLine');
      report(oneWay.propose.disabled && oneWay.propose.why === 'The show desk is not connected.' && !oneWay.send.disabled && oneWay.send.checked,
        `a way that is closed is shown disabled with its reason: no show desk (${JSON.stringify(oneWay)})`);
      await tick('quoteLine');

      // Pia (Staff: stage.show without stage.send) is drawn the ❝ Quote tab and no ＋.
      const piaMade = await desk.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'pia', name: 'Pia Staff', role: 'staff', halls: [${codeLiteral(slHall)}], password: 'quotes without a lectern' }) }).then((r) => r.status)`);
      const pia = await edge.tab(`${base}/build.js`, { alone: true });
      if (piaMade !== 200 || await signIn(pia, 'pia', 'quotes without a lectern') !== 200) throw new Error('Pia could not sign in: ' + piaMade);
      await pia.send('Page.navigate', { url: `${base}/app.html?code=${slHall}&as=account&role=research` });
      await pia.until(`typeof joined !== 'undefined' && joined && F.canShow && !document.getElementById('quoteTab').hidden`, 10000);
      await pia.eval(`document.getElementById('quoteTab').click()`);
      await pia.eval(`(() => { const box = document.getElementById('quoteInput'); box.value = 'Capex rose 8%'; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const piaPlus = await pia.until(`!document.getElementById('quoteShow').disabled && JSON.stringify({ send: F.canSendToStage, propose: F.canPropose, shown: !document.getElementById('quoteLine').hidden })`, 8000);
      report(piaPlus === JSON.stringify({ send: false, propose: false, shown: false }), `＋ is absent for a seat without stage.send (${piaPlus})`);

      const lineProblems = [['desk', desk], ['pia', pia]].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(lineProblems.length === 0, `the lectern hall's pages: no console error and no CSP violation${lineProblems.length ? ' — ' + lineProblems.slice(0, 4).join(' | ') : ''}`);
      for (const t of [desk, pia]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
      await slSw.close();
      await noDesk.close();
    }

    // ---------------- The Board's devices (unit T): every stage feature on the device legs, and the floor leg ----------------
    // A hall of its own: the operator from a socket (its files uploaded fresh), the admin account's page backstage as the
    // pusher whose page makes a document's stand-in, and the Board on three device legs (a mobile viewport with touch, at
    // 1180 × 820, 820 × 1180 and 390 × 844), each a device of its own; then a Board page on the floor leg: a browser without
    // DecompressionStream, requestIdleCallback and Promise.withResolvers, as an iPad below the document floor.
    {
      const dvHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Devices hall' }) })).json()).code;
      const dvOp = await connect(base, cookie);
      // An act asked again while the server says this address is busy (the smoke's many pages share one address).
      const asked = async (ev, args) => { let r = null; for (let i = 0; i < 60; i++) { r = await emit(dvOp, ev, args); if (!(r && r.busy)) return r; await sleep(Math.min(2000, (r && r.retryMs) || 500)); } return r; };
      const dvJoin = await asked('join', { roomCode: dvHall, name: 'Desk', role: 'research', docs: true });
      const fresh = async (name, type, bytes) => {
        for (let i = 0; i < 8; i++) {
          const fd = new FormData();
          fd.append('file', new Blob([bytes], { type }), name);
          const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': dvJoin.uploadToken }, body: fd });
          if (r.status !== 429) return (await r.json()).url;
          await sleep(2500);
        }
        return '';
      };
      const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const pdfUrl = await fresh('board pack.pdf', 'application/pdf', fixture('board-pack-tagged.pdf'));
      // A Word file with a hidden run and a tracked deletion, neither of which a Board page draws.
      const docxUrl = await fresh('minutes.docx', DOCX_TYPE, officeZip(wordParts({ body: '<w:p><w:r><w:t>Item 4: approved</w:t></w:r><w:del w:id="1" w:author="Ana" w:date="2026-11-01T09:00:00Z"><w:r><w:delText> DELETEDRUN</w:delText></w:r></w:del></w:p>'
        + '<w:p><w:r><w:t>Item 5: deferred</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t> HIDDENRUN</w:t></w:r></w:p>'
        + '<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Motion</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Vote</w:t></w:r></w:p></w:tc></w:tr>'
        + '<w:tr><w:tc><w:p><w:r><w:t>Budget</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Carried</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>' })));
      const picUrl = await fresh('stage plan.png', 'image/png', pngOf(64, 48));
      // A workbook with a hidden column, row and sheets; a deck with a hidden shape and slide; a CSV; Markdown with a comment;
      // a PDF whose page is a JPEG 2000 picture.
      const xlsxUrl = await fresh('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', officeZip(workbookParts()));
      const pptxUrl = await fresh('results.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', officeZip(deckParts([
        { xml: deckSlide(deckShape('Q3 results', { ph: 'title' }) + deckShape(['Revenue up', 'Costs flat'], { ph: 'body' }) + deckShape('HIDDENSHAPE', { hidden: true })) },
        { xml: deckSlide(deckShape('HIDDENSLIDE', { ph: 'title' }), '0') }])));
      const csvUrl = await fresh('budget.csv', 'text/csv', Buffer.from('Item,Cost\r\nPlant,4\r\nStaff,2\r\n'));
      const mdUrl = await fresh('notes.md', 'text/markdown', Buffer.from('# Notes\n\nVisible <!-- SECRETCOMMENT --> words\n'));
      const jpxUrl = await fresh('picture-jpx.pdf', 'application/pdf', fixture('jpeg2000.pdf'));
      const push = (content, to = 'board') => asked('page:push', { code: dvHall, to, content });
      // The Board's information as the operator's console reads it, once it reads `mark` (its pages all said), or as it stands.
      const boardInfo = async (seq, mark = '✓') => {
        let info = null;
        for (let i = 0; i < 80; i++) { const st = await asked('page:status', { code: dvHall }); info = st && st.ok ? st.board.info : null; if (info && info.seq === seq && info.mark === mark) return info; await sleep(250); }
        return info;
      };
      // The venue's web page, answered by the browser itself (agm-web.invalid: a page of a few words).
      const WEB = 'https://agm-web.invalid/vote';
      // At a place: its text directive's words said over the frame ("Look for: ❝ …"), which never highlights them.
      const WEB_AT = WEB + '#:~:text=Vote%20now,today';
      const LOOK = 'Look for: ❝ Vote now … today';
      // A quote from it: Open the source at its words (one short line, found whole) where its pusher may show a web page.
      const WEB_QUOTE = 'Turnout was 64% this year';
      const SOURCE_AT = WEB + '?r=1#:~:text=Turnout%20was%2064%25%20this%20year';
      const answerWeb = async (t) => {
        t.on('Fetch.requestPaused', (p) => { t.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from('<!doctype html><title>Vote</title><p>Vote now</p>').toString('base64') }); });
        await t.send('Fetch.enable', { patterns: [{ urlPattern: 'https://agm-web.invalid/*', requestStage: 'Request' }] });
      };
      // The pusher: the admin account's page backstage (the operator), whose console reads where the Board's pages stand.
      const desk = await edge.tab(`${base}/app.html?code=${dvHall}&as=account&role=research`);
      await desk.until(`typeof joined !== 'undefined' && joined && F.canPush && F.docs`, 10000);
      desk.expectFailure(/\/api\/upload$/);   // the uploads' rate may turn a picture away: the page waits it out
      // The device legs: a Board page each, a mobile viewport with touch, opening documents (its probe at load).
      const LEGS = [[1180, 820], [820, 1180], [390, 844]];
      const legs = [];
      for (const [w, h] of LEGS) {
        const tab = await edge.tab(`${base}/app.html?code=${dvHall}&name=${encodeURIComponent('Leg ' + w)}&role=board&invite=${inviteOf(dataDir, dvHall)}`, { metrics: { width: w, height: h, phone: true }, alone: true });
        await answerWeb(tab);
        legs.push({ w, h, tab });
      }
      for (const l of legs) await l.tab.until(`typeof joined !== 'undefined' && joined`, 10000);
      const legFacts = await Promise.all(legs.map((l) => l.tab.eval(`JSON.stringify({ w: innerWidth, touch: navigator.maxTouchPoints > 0, coarse: matchMedia('(pointer: coarse)').matches, docs: F.docs, view: F.view })`).then(JSON.parse)));
      const st0 = await asked('page:status', { code: dvHall });
      report(legFacts.every((f, i) => f.w === LEGS[i][0] && f.touch && f.docs === true && f.view === 'simple') && st0.board.pages === 3 && !st0.board.nodocs,
        `the device legs: three Board pages at 1180 × 820, 820 × 1180 and 390 × 844, each a mobile viewport with touch, each opening documents by its probe (none counted without), in the simple view (${JSON.stringify({ legFacts, pages: st0.board.pages, nodocs: st0.board.nodocs || 0 })})`);

      // What a leg's layer draws now, as a person sees it: its kind, a quote's type and whether a table scrolls inside its
      // card, a picture drawn and never dragged out (a right-click or a long press's menu taken by the page), a document's
      // page and kind, a web page's frame; and whether the page itself scrolls sideways.
      const LEG_READ = `(() => { const l = document.getElementById('pageLayer'); const b = document.getElementById('layerBox'); if (l.hidden) return '';
        const q = b.querySelector('.take-quote'); const s = q && q.querySelector('.take-quote-scroll'); const img = b.querySelector('img'); const v = b.querySelector('.dv'); const f = b.querySelector('iframe');
        let menu = null; if (img) { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); img.dispatchEvent(e); menu = e.defaultPrevented; }
        return JSON.stringify({ kind: l.dataset.kind, px: q ? Math.round(parseFloat(getComputedStyle(q).fontSize)) : 0, scrolls: !!s && s.scrollWidth > s.clientWidth, unit: q ? q.dataset.unit : '',
          img: !!img && img.complete && img.naturalWidth > 0, drag: img ? img.getAttribute('draggable') : null, menu, doc: v ? v.dataset.kind : '', page: (b.querySelector('.dv-n') || {}).value || '',
          canvas: !!b.querySelector('canvas.pdf-page:not(.pdf-page-pending)'), words: (b.querySelector('.dv-body') || {}).textContent || '', frame: f ? f.getAttribute('src') : '',
          pageW: Math.round((b.querySelector('.dv-page') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width), found: (b.querySelector('.dv-found') || {}).textContent || '',
          look: (b.querySelector('.take-web-look') || {}).textContent || '', source: q ? (q.querySelector('.take-quote-line') || {}).textContent || '' : '',
          open: (() => { const a = q && q.querySelector('.take-quote-open'); return a ? [a.href, a.target, a.rel] : null; })(), th: [...b.querySelectorAll('.dv th')].map((x) => x.textContent).join('|'),
          jpx: (() => { const c = b.querySelector('.dv-page[data-page="1"] canvas'); if (!c || !c.width || c.classList.contains('pdf-page-pending')) return null; const p = c.getContext('2d').getImageData(Math.floor(c.width * ${JPX_YELLOW.x}), Math.floor(c.height * ${JPX_YELLOW.y}), 1, 1).data; return [p[0], p[1], p[2]]; })(),
          wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth }); })()`;
      const onLegs = async (ok, ms = 20000) => Promise.all(legs.map(async (l) => JSON.parse(await l.tab.until(`(() => { const r = ${LEG_READ}; return r && (${ok})(JSON.parse(r)) && r; })()`, ms) || await l.tab.eval(LEG_READ) || 'null')));
      const legRows = {};
      // A quote: its words in the largest type that fits, 28 px or more on a tablet and 20 px or more on a phone; ✓.
      const para = await push({ kind: 'snippet', unit: 'paragraph', text: 'The board approves the budget for 2027, with the changes tabled this morning.' });
      legRows.quote = await onLegs('(r) => r.kind === "snippet" && r.px > 0');
      const paraInfo = await boardInfo(para.seq);
      // A 25 × 10 table: at 390 px it scrolls sideways inside its card, its type 20 px or more, and the page does not scroll.
      const wideRows = Array.from({ length: 25 }, (_, r) => Array.from({ length: 10 }, (__, c) => (r === 0 ? 'Quarter ' + (c + 1) : String((r + 1) * (c + 7) * 1000))));
      const table = await push({ kind: 'snippet', unit: 'range', table: { rows: wideRows, head: 1, side: 0, ref: 'A1:J25' } });
      legRows.table = await onLegs('(r) => r.kind === "snippet" && r.unit === "range"');
      const tableInfo = await boardInfo(table.seq);
      // A picture: drawn, never draggable, its menu the page's.
      const pic = await push({ kind: 'image', url: picUrl });
      legRows.picture = await onLegs('(r) => r.kind === "image" && r.img');
      const picInfo = await boardInfo(pic.seq);
      // A PDF at its place, shown with Download ticked: its page box, zoomed in by a tap on +, paged on by a tap on Next; on
      // the phone, ⬇ Download saves the file whole and the page stays.
      const pdf = await push({ kind: 'doc', url: pdfUrl, at: { page: 1 }, download: true });
      legRows.pdf = await onLegs('(r) => r.kind === "doc" && r.doc === "pdf" && r.canvas && r.page === "1"');
      const pdfInfo = await boardInfo(pdf.seq);
      for (const l of legs) await l.tab.eval(`document.querySelector('#layerBox .dv-zoom .btn[aria-label="Zoom in"]').click()`);
      legRows.zoomed = await Promise.all(legs.map(async (l, i) => JSON.parse(await l.tab.until(`(() => { const r = JSON.parse(${LEG_READ} || 'null'); return r && r.pageW > ${legRows.pdf[i] ? legRows.pdf[i].pageW : 0} && JSON.stringify(r); })()`, 8000) || 'null')));
      for (const l of legs) await l.tab.eval(`document.querySelector('#layerBox .dv-next').click()`);
      legRows.paged = await onLegs('(r) => r.page === "2"', 8000);
      const phone = legs[2];
      await edge.browserSend('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true, browserContextId: phone.tab.context });
      const phoneBefore = new Set(downloads.keys());
      await phone.tab.until(`!!document.querySelector('#layerActs [data-action="take.download"]')`, 5000);
      await phone.tab.eval(`(() => { window.__stays = true; document.querySelector('#layerActs [data-action="take.download"]').click(); return true; })()`);
      let phoneSaved = null;
      for (const end = Date.now() + 15000; Date.now() < end && !phoneSaved; await sleep(100)) phoneSaved = [...downloads].find(([g, d]) => !phoneBefore.has(g) && d.state === 'completed');
      const phoneStays = await phone.tab.eval(`window.__stays === true && !document.getElementById('pageLayer').hidden`);
      // A Word document, drawn without its hidden run or its tracked deletion, and found in.
      const docx = await push({ kind: 'doc', url: docxUrl });
      legRows.docx = await onLegs('(r) => r.kind === "doc" && r.doc === "word" && r.words.includes("Item 4: approved")');
      const docxInfo = await boardInfo(docx.seq);
      for (const l of legs) await l.tab.eval(`(() => { const q = document.querySelector('#layerBox .dv-q'); q.value = 'deferred'; q.form.requestSubmit(); return true; })()`);
      legRows.found = await onLegs('(r) => r.found === "1 of 1"', 8000);
      // A workbook, a deck, a CSV and Markdown, each drawn without what is hidden in it; a JPEG 2000 page drawn.
      const xlsx = await push({ kind: 'doc', url: xlsxUrl });
      legRows.xlsx = await onLegs('(r) => r.kind === "doc" && r.doc === "book" && r.words.includes("Total")');
      const xlsxInfo = await boardInfo(xlsx.seq);
      const pptx = await push({ kind: 'doc', url: pptxUrl });
      legRows.pptx = await onLegs('(r) => r.kind === "doc" && r.doc === "deck" && r.words.includes("Revenue up")');
      const pptxInfo = await boardInfo(pptx.seq);
      const csv = await push({ kind: 'doc', url: csvUrl });
      legRows.csv = await onLegs('(r) => r.kind === "doc" && r.doc === "csv" && r.words.includes("Plant")');
      const csvInfo = await boardInfo(csv.seq);
      const md = await push({ kind: 'doc', url: mdUrl });
      legRows.md = await onLegs('(r) => r.kind === "doc" && r.doc === "md" && r.words.includes("Visible")');
      const mdInfo = await boardInfo(md.seq);
      const jpx = await push({ kind: 'doc', url: jpxUrl, at: { page: 1 } });
      legRows.jpx = await onLegs('(r) => r.kind === "doc" && r.doc === "pdf" && !!r.jpx && r.jpx[0] > 200 && r.jpx[1] > 150 && r.jpx[2] < 110');
      const jpxInfo = await boardInfo(jpx.seq);
      // A web page at a place: its frame, opened (◇: AGMessage cannot see inside it), its text directive's words over it.
      const web = await push({ kind: 'web', url: WEB_AT });
      legRows.web = await onLegs('(r) => r.kind === "web" && !!r.frame');
      const webInfo = await boardInfo(web.seq, '◇');
      for (const l of legs) await l.tab.shot(path.join(OUT, `board-devices-${l.w}x${l.h}.png`));
      const tablet = (r, i) => LEGS[i][0] >= 600;
      const legsOk = legRows.quote.every((r, i) => !!r && r.px >= (tablet(r, i) ? 28 : 20) && r.wide)
        && legRows.table.every((r, i) => !!r && r.px >= 20 && r.wide && (tablet(r, i) || r.scrolls))
        && legRows.picture.every((r) => !!r && r.drag === 'false' && r.menu === true && r.wide)
        && legRows.pdf.every((r) => !!r && r.wide) && legRows.zoomed.every((r) => !!r && r.wide) && legRows.paged.every((r) => !!r && r.page === '2')
        && !!phoneSaved && phoneSaved[1].name === 'board pack.pdf' && fs.readFileSync(path.join(dlDir, phoneSaved[0])).equals(fixture('board-pack-tagged.pdf')) && phoneStays === true
        && legRows.docx.every((r) => !!r && r.words.includes('Item 5: deferred') && !r.words.includes('HIDDENRUN') && !r.words.includes('DELETEDRUN') && r.th === 'Motion|Vote' && r.wide) && legRows.found.every((r) => !!r && r.found === '1 of 1')
        && legRows.xlsx.every((r) => !!r && r.words.includes('Cost') && !/SECRETCOL|SECRETROW|VERYHIDDEN|JUSTHIDDEN/.test(r.words) && r.wide)
        && legRows.pptx.every((r) => !!r && r.words.includes('Q3 results') && !/HIDDENSHAPE|HIDDENSLIDE/.test(r.words) && r.wide)
        && legRows.csv.every((r) => !!r && r.words.includes('Staff') && r.wide) && legRows.md.every((r) => !!r && r.words.includes('words') && !r.words.includes('SECRETCOMMENT') && r.wide)
        && legRows.jpx.every((r) => !!r && r.wide) && legRows.web.every((r) => !!r && r.frame === WEB_AT && r.look === LOOK && r.wide)
        && [paraInfo, tableInfo, picInfo, pdfInfo, docxInfo, xlsxInfo, pptxInfo, csvInfo, mdInfo, jpxInfo].every((i) => !!i && i.mark === '✓' && i.on === 3 && i.pages === 3) && !!webInfo && webInfo.mark === '◇';
      report(legsOk, `the stage on the device legs: a quote in 28 px or more on a tablet and 20 px or more on a phone; a 25 × 10 table scrolling inside its card at 390 px, the page never sideways; a picture never dragged out, its menu the page's; a PDF at its page, zoomed in by a tap and paged on by one, saved whole on the phone by ⬇ Download with the page staying; a Word document without its hidden run or tracked deletion, its header row drawn as headers, found in; a workbook, a deck, a CSV and Markdown without what is hidden in them; a JPEG 2000 page drawn; a web page's frame at its place, with "${LOOK}" over it; each ✓ on all 3 (the web page ◇) (${JSON.stringify({ legRows: Object.fromEntries(Object.entries(legRows).map(([k, v]) => [k, v.map((r) => r && { ...r, words: (r.words || '').slice(0, 60) })])), saved: phoneSaved ? phoneSaved[1].name : '', phoneStays, marks: [paraInfo, tableInfo, picInfo, pdfInfo, docxInfo, xlsxInfo, pptxInfo, csvInfo, mdInfo, jpxInfo, webInfo].map((i) => i && [i.mark, i.on, i.pages]) })})`);

      // Earlier and Look on every leg: the picture, under Earlier now, drawn again in a Look on that page alone.
      const looks = await Promise.all(legs.map(async (l) => {
        await l.tab.eval(`act('past', 'past.look', Takes.pastObject(${pic.seq}), {})`);
        const r = await l.tab.until(`document.getElementById('webPreview').open && (() => { const img = document.querySelector('#webPreviewBox img'); return img && img.complete && img.naturalWidth > 0 && JSON.stringify({ what: document.getElementById('webPreviewWhat').textContent, earlier: Takes.earlier() }); })()`, 8000);
        await l.tab.eval(`document.getElementById('webPreview').close()`);
        return JSON.parse(r || 'null');
      }));
      // A quote from a web page on every leg: from the operator, who may show a web page, its source line names the site and
      // offers Open the source at its words, in a tab of the person's own; from Dee, a Staff account of this hall who may show
      // quotes but not web pages, the site alone, with no link.
      const deeWords = 'a quote with no link to it';
      const deeMade = await desk.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dee', name: 'Dee Staff', role: 'staff', halls: [${codeLiteral(dvHall)}], password: ${codeLiteral(deeWords)} }) }).then((r) => r.status)`);
      let deeCookie = '';
      for (let i = 0; i < 8 && !deeCookie; i++) {
        const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dee', password: deeWords }) });
        if (r.status === 200) deeCookie = r.headers.get('set-cookie').split(';')[0]; else await sleep(2100);
      }
      if (deeMade !== 200 || !deeCookie) throw new Error('Dee could not sign in: ' + deeMade);
      const dee = await connect(base, deeCookie);
      const deeAsked = async (ev, args) => { let r = null; for (let i = 0; i < 60; i++) { r = await emit(dee, ev, args); if (!(r && r.busy)) return r; await sleep(Math.min(2000, (r && r.retryMs) || 500)); } return r; };
      const deeJoin = await deeAsked('join', { roomCode: dvHall, as: 'account' });
      const deeQuote = { kind: 'snippet', unit: 'text', text: WEB_QUOTE, from: { web: WEB + '?token=n0r1ght' } };
      const wq = await push({ kind: 'snippet', unit: 'text', text: WEB_QUOTE, from: { web: WEB + '?r=1' } });
      legRows.webQuote = await onLegs('(r) => r.kind === "snippet" && !!r.open');
      const wqInfo = await boardInfo(wq.seq);
      // The operator's taken down first: a seat that may only show never sends over the operator's information.
      await push({ kind: 'chat', layer: 'info' });
      const dq = await deeAsked('page:push', { code: dvHall, to: 'board', content: deeQuote });
      legRows.named = await onLegs('(r) => r.kind === "snippet" && r.source.startsWith("Quoted by Dee")');
      report(!!deeJoin && deeJoin.canShow === true && deeJoin.canWeb === false && legRows.webQuote.every((r) => !!r && JSON.stringify(r.open) === JSON.stringify([SOURCE_AT, '_blank', 'noopener noreferrer']) && r.source === 'Quoted by Desk · agm-web.invalid · Open the source' && r.wide)
        && !!wqInfo && wqInfo.mark === '✓' && !!dq && dq.ok === true && legRows.named.every((r) => !!r && r.open === null && r.source === 'Quoted by Dee Staff · agm-web.invalid' && r.wide),
        `on every leg a quote from a web page by a pusher who may show one names the site and offers Open the source at its words, in a tab of the person's own with no opener or referrer, ✓ on all 3; from a pusher who may not, the site alone with no link (${JSON.stringify({ webQuote: legRows.webQuote, named: legRows.named, mark: wqInfo && [wqInfo.mark, wqInfo.on], dq, deeJoin: deeJoin && { canShow: deeJoin.canShow, canWeb: deeJoin.canWeb } })})`);

      // Many takes in a row, then Back to chat: the page still draws, and nothing reloaded it.
      for (const l of legs) await l.tab.eval(`(() => { window.__still = true; return true; })()`);
      for (let i = 1; i <= 20; i++) await push({ kind: 'snippet', unit: 'text', text: 'Take ' + i + ' of 20' });
      await onLegs('(r) => r.kind === "snippet"', 10000);
      const last = await push({ kind: 'chat' });
      const many = await Promise.all(legs.map((l) => l.tab.until(`document.getElementById('pageLayer').hidden && window.__still === true && performance.getEntriesByType('navigation').length === 1 && 'kept'`, 10000)));
      report(looks.every((r) => !!r && r.what === 'Look' && r.earlier >= 1) && last.ok && many.every((x) => x === 'kept'),
        `on every leg a picture under Earlier is drawn again in a Look; 20 takes in a row and then Back to chat leave each page drawing, never reloaded (${JSON.stringify({ looks, many })})`);

      // ---- The floor leg: a Board page below the document floor (no DecompressionStream), with no requestIdleCallback and
      // no Promise.withResolvers, every request it makes logged.
      const BELOW_DOCS = `(() => { delete window.DecompressionStream; delete window.requestIdleCallback; delete window.cancelIdleCallback; delete Promise.withResolvers; })();`;
      // A document the pusher shows before that page joins: it is given no stand-in (no page then needed one).
      const deskShows = (args) => desk.eval(`(() => { Show.whole(${args}); return true; })()`);
      const deskRead = async (ok, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { await desk.eval(`Console.read()`); const v = await desk.eval(`(() => { const b = Console.board(); return JSON.stringify({ seq: b.info ? b.info.seq : 0, kind: b.info ? b.info.kind : '', mark: b.info ? b.info.mark : '', cannot: b.info ? b.info.cannot : 0, standin: b.info ? b.info.standin : 0, nodocs: b.nodocs, offer: AGM.catalog.ids('board', F, b).includes('board.picture') ? AGM.catalog.items('board', F, b).find((i) => i.id === 'board.picture').label : '', chip: document.getElementById('boardOver').textContent }); })()`); if (ok(JSON.parse(v))) return JSON.parse(v); } return JSON.parse(await desk.eval(`JSON.stringify({ chip: document.getElementById('boardOver').textContent })`)); };
      await deskRead((v) => v.seq === 0 || v.kind === '');
      await deskShows(`{ url: ${codeLiteral(pdfUrl)}, name: 'board pack.pdf' }, { page: 1 }, false, 'board'`);
      const early = await (async () => { let info = null; for (let i = 0; i < 80; i++) { const st = await asked('page:status', { code: dvHall }); info = st && st.ok ? st.board.info : null; if (info && info.kind === 'doc' && info.mark === '✓') return info; await sleep(250); } return info; })();
      // Opened blank, so every request its page makes is logged from its first: the log, then the page.
      const floor = await edge.tab('about:blank', { init: BELOW_DOCS, metrics: { width: 1180, height: 820, phone: true }, alone: true });
      const fetched = [];
      floor.on('Network.requestWillBeSent', (p) => fetched.push(p.request.url));
      await floor.send('Network.enable');
      await answerWeb(floor);
      await floor.send('Page.navigate', { url: `${base}/app.html?code=${dvHall}&name=Floor&role=board&invite=${inviteOf(dataDir, dvHall)}` });
      await floor.until(`typeof joined !== 'undefined' && joined`, 10000);
      await edge.browserSend('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true, browserContextId: floor.context });
      const floorFacts = await floor.eval(`JSON.stringify({ docs: F.docs, probe: typeof DecompressionStream, idle: typeof requestIdleCallback, resolvers: typeof Promise.withResolvers })`);
      const FLOOR_READ = `(() => { const l = document.getElementById('pageLayer'); const b = document.getElementById('layerBox'); if (l.hidden) return '';
        const img = b.querySelector('img'); const q = b.querySelector('.take-quote');
        let menu = null; if (img) { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); img.dispatchEvent(e); menu = e.defaultPrevented; }
        return JSON.stringify({ kind: l.dataset.kind, standin: (b.querySelector('.take-standin-words') || {}).textContent || '', device: (b.querySelector('.take-device') || {}).textContent || '',
          img: !!img && img.complete && img.naturalWidth > 0, drag: img ? img.getAttribute('draggable') : null, menu, quote: q ? (q.querySelector('.take-quote-body') || q).textContent : '', source: (b.querySelector('.take-quote-line') || {}).textContent || '',
          line: (b.querySelector('.take-file-line') || {}).textContent || '', pdf: !!b.querySelector('.dv[data-kind="pdf"]'), frame: !!b.querySelector('iframe'),
          look: (b.querySelector('.take-web-look') || {}).textContent || '', open: (() => { const a = q && q.querySelector('.take-quote-open'); return a ? [a.href, a.target, a.rel] : null; })() }); })()`;
      const floorShows = async (ok, ms = 15000) => JSON.parse(await floor.until(`(() => { const r = ${FLOOR_READ}; return r && (${ok})(JSON.parse(r)) && r; })()`, ms) || await floor.eval(FLOOR_READ) || 'null');
      // Joined after the push, with no stand-in: it says this device cannot open documents and fails; the console offers
      // Show them a picture of p. 1, which sends a picture to that page's person alone, drawn over the Board's document.
      const noStandin = await floorShows('(r) => r.kind === "doc" && !!r.device');
      const offered = await deskRead((v) => v.kind === 'doc' && v.cannot === 1 && !!v.offer);
      await desk.eval(`act('board', 'board.picture', Console.board(), {})`);
      const sent = await floorShows('(r) => r.kind === "image" && r.img', 20000);
      const legsKeep = await Promise.all(legs.map((l) => l.tab.eval(LEG_READ).then((r) => (r ? JSON.parse(r).kind : 'chat'))));
      report(floorFacts === JSON.stringify({ docs: false, probe: 'undefined', idle: 'undefined', resolvers: 'undefined' }) && !!early && early.mark === '✓'
        && !!noStandin && noStandin.device === 'This device cannot open documents — ask the backstage team to show you a picture.' && !noStandin.pdf
        && offered.mark === '△' && offered.nodocs === 1 && offered.offer === 'Show them a picture of p. 1' && !!sent && legsKeep.every((k) => k === 'doc'),
        `the floor leg: a page with no DecompressionStream joins without docs; a document shown before it joined (no stand-in) draws the words "This device cannot open documents — ask the backstage team to show you a picture." and fails, the console offering Show them a picture of p. 1, which reaches that page alone as a picture over the Board's document (${JSON.stringify({ floorFacts, noStandin, offered, sent, legsKeep })})`);

      // Shown now, with the page counted: the pusher's bar says so before it goes, and the document goes with a picture of its
      // place as its stand-in, which this page draws with its words, ✓ "as a picture"; ⬇ Download on it, ticked, downloads.
      const said = await desk.eval(`Show.olderWords('board', 'pdf', { page: 1 })`);
      await deskShows(`{ url: ${codeLiteral(pdfUrl)}, name: 'board pack.pdf' }, { page: 1 }, true, 'board'`);
      const withPicture = await floorShows('(r) => r.kind === "doc" && !!r.standin && r.img');
      const pictured = await deskRead((v) => v.kind === 'doc' && v.standin === 1 && v.mark === '✓');
      const floorBar = await floor.until(`(() => { const a = [...document.querySelectorAll('#layerActs [data-action]')].map((b) => b.dataset.action); return a.includes('take.download') && JSON.stringify(a); })()`, 5000);
      const before = new Set(downloads.keys());
      await floor.eval(`document.querySelector('#layerActs [data-action="take.download"]').click()`);
      let saved = null;
      for (const end = Date.now() + 15000; Date.now() < end && !saved; await sleep(100)) saved = [...downloads].find(([g, d]) => !before.has(g) && d.state === 'completed');
      report(said === '1 of 4 Board pages is an older device: it gets a picture of p. 1 in its place'
        && !!withPicture && withPicture.standin === 'As a picture of p. 1: this device cannot page through the document' && withPicture.line === 'board pack.pdf · p. 1' && !withPicture.pdf && withPicture.drag === 'false' && withPicture.menu === true
        && pictured.chip.includes('(1 as a picture)') && !!floorBar && !!saved && saved[1].name === 'board pack.pdf' && fs.readFileSync(path.join(dlDir, saved[0])).equals(fixture('board-pack-tagged.pdf')),
        `the floor leg: the pusher's bar says "1 of 4 Board pages is an older device: it gets a picture of p. 1 in its place"; the document goes with that picture as its stand-in, drawn with its words, never dragged out, its menu the page's, ✓ on the console "(1 as a picture)"; ⬇ Download on it, ticked, saves the file whole (${JSON.stringify({ said, withPicture, pictured, floorBar, saved: saved ? saved[1].name : '' })})`);

      // A Word document: its stand-in is what is at its place, as a quote, drawn with its words.
      await deskShows(`{ url: ${codeLiteral(docxUrl)}, name: 'minutes.docx' }, null, false, 'board'`);
      const wordStandin = await floorShows('(r) => r.kind === "doc" && !!r.standin && r.quote.includes("Item 4: approved")');
      const wordMark = await deskRead((v) => v.kind === 'doc' && v.standin === 1 && v.mark === '✓' && v.chip.includes('(1 as a quote)'));
      // A Look at the first document (no stand-in) under Earlier reads its words; quotes, pictures, web pages and Earlier draw.
      await floor.eval(`act('past', 'past.look', Takes.pastObject(${early ? early.seq : 0}), {})`);
      const look = await floor.until(`document.getElementById('webPreview').open && (() => { const p = document.querySelector('#webPreviewBox .take-device'); return p && p.textContent; })()`, 8000);
      await floor.eval(`document.getElementById('webPreview').close()`);
      // The dialog's close event comes as a task of its own after close(), and lets its box go: the next Look is opened once
      // it has had its turn, so it never empties that Look.
      await floor.until(`!document.getElementById('webPreview').open && document.getElementById('webPreviewBox').childElementCount === 0 && 'closed'`, 3000);
      // A Look at the document shown with its stand-in draws the stand-in.
      await floor.eval(`act('past', 'past.look', Takes.pastObject(${pictured.seq || 0}), {})`);
      const lookStandin = await floor.until(`document.getElementById('webPreview').open && (() => { const w = document.querySelector('#webPreviewBox .take-standin-words'); const img = document.querySelector('#webPreviewBox img'); return w && img && img.complete && img.naturalWidth > 0 && w.textContent; })()`, 8000);
      await floor.eval(`document.getElementById('webPreview').close()`);
      const q = await push({ kind: 'snippet', unit: 'paragraph', text: 'The floor leg reads a quote.' });
      const floorQuote = await floorShows('(r) => r.kind === "snippet"');
      const p2 = await push({ kind: 'image', url: picUrl });
      const floorPic = await floorShows('(r) => r.kind === "image" && r.img');
      const w2 = await push({ kind: 'web', url: WEB_AT });
      const floorWeb = await floorShows('(r) => r.kind === "web" && r.frame && !!r.look');
      // A quote from a web page: Open the source from the operator; the site alone from Dee, once nothing of the operator's is
      // up on any page of the Board's (the floor's person was shown a picture of their own).
      const wq2 = await push({ kind: 'snippet', unit: 'text', text: WEB_QUOTE, from: { web: WEB + '?r=1' } });
      const floorWebQuote = await floorShows('(r) => r.kind === "snippet" && !!r.open');
      await push({ kind: 'chat', layer: 'info' });
      const floorKey = ((await asked('page:status', { code: dvHall })).people.find((x) => x.name === 'Floor') || {}).uid;
      if (floorKey) await push({ kind: 'chat', layer: 'info' }, { uid: floorKey });
      const dq2 = await deeAsked('page:push', { code: dvHall, to: 'board', content: deeQuote });
      const floorNamed = await floorShows('(r) => r.kind === "snippet" && r.source.startsWith("Quoted by Dee")');
      const floorEarlier = await floor.eval(`Takes.earlier()`);
      const pdfFetched = fetched.filter((u) => /\/vendor\/pdf\.(worker\.)?min\.mjs/.test(u));
      await floor.shot(path.join(OUT, 'board-devices-floor.png'));
      report(!!wordStandin && wordStandin.standin === 'As a quote: this device cannot page through the document' && wordStandin.source === 'Quoted by Ana Admin · minutes.docx' && !/HIDDENRUN|DELETEDRUN/.test(wordStandin.quote) && wordMark.mark === '✓' && wordMark.chip.includes('(1 as a quote)')
        && look === 'This device cannot open documents — ask the backstage team to show you a picture.' && lookStandin === 'As a picture of p. 1: this device cannot page through the document'
        && q.ok && !!floorQuote && p2.ok && !!floorPic && floorPic.img && floorPic.drag === 'false' && floorPic.menu === true && w2.ok && !!floorWeb && floorWeb.frame && floorWeb.look === LOOK
        && wq2.ok && !!floorWebQuote && JSON.stringify(floorWebQuote.open) === JSON.stringify([SOURCE_AT, '_blank', 'noopener noreferrer']) && floorWebQuote.source === 'Quoted by Desk · agm-web.invalid · Open the source'
        && !!dq2 && dq2.ok === true && !!floorNamed && floorNamed.open === null && floorNamed.source === 'Quoted by Dee Staff · agm-web.invalid' && floorEarlier >= 3 && pdfFetched.length === 0 && floor.problems.length === 0,
        `the floor leg: a Word document's stand-in is what is at its place as a quote, without its hidden run or tracked deletion, with its words and the document named, ✓ "(1 as a quote)"; under Earlier a Look at a document with no stand-in reads the device's words, and one with a stand-in draws it; quotes, pictures (never dragged out, the page's menu), web pages at a place ("Look for"), a web quote's Open the source (and none from a pusher without the right) and Earlier draw; pdf.js is never fetched; no script error (${JSON.stringify({ wordStandin, wordMark: wordMark.mark, look, lookStandin, floorQuote: !!floorQuote, floorPic: !!floorPic, floorWeb, floorWebQuote, floorNamed, dq2, floorEarlier, pdfFetched, problems: floor.problems.slice(0, 3) })})`);

      // ---- A Board page that opens documents by its probe, yet cannot import pdf.js (its module refused on the way): it draws
      // the document as a page that cannot open documents does (here the stand-in made for the floor leg's page), opens none
      // for the rest of its session, and joins again without docs, counted; a reload in its tab keeps it so.
      const probe = await edge.tab('about:blank', { metrics: { width: 820, height: 1180, phone: true }, alone: true });
      probe.expectFailure(/\/vendor\/pdf\.min\.mjs$/);
      await probe.hold('*/vendor/pdf.min.mjs*', 0, true);
      await probe.send('Page.navigate', { url: `${base}/app.html?code=${dvHall}&name=Probe&role=board&invite=${inviteOf(dataDir, dvHall)}` });
      const probeJoined = await probe.until(`typeof joined !== 'undefined' && joined && F.docs === true && 'docs'`, 10000);
      await deskRead((v) => v.nodocs === 1);
      await deskShows(`{ url: ${codeLiteral(pdfUrl)}, name: 'board pack.pdf' }, { page: 1 }, false, 'board'`);
      const PROBE_READ = `(() => { const b = document.getElementById('layerBox'); const w = b.querySelector('.take-standin-words'); const img = b.querySelector('img');
        let kept = ''; try { kept = sessionStorage.getItem('agm.noDocs'); } catch { kept = 'blocked'; }
        return w && img && img.complete && img.naturalWidth > 0 && JSON.stringify({ words: w.textContent, docs: F.docs, kept, pdf: !!b.querySelector('.dv[data-kind="pdf"]') }); })()`;
      const probeShows = JSON.parse(await probe.until(PROBE_READ, 20000) || 'null');
      const probeMark = await deskRead((v) => v.kind === 'doc' && v.nodocs === 2 && v.standin === 2 && v.mark === '✓', 20000);
      await probe.send('Page.reload');
      const probeAgain = await probe.until(`typeof joined !== 'undefined' && joined && F.docs === false && 'kept'`, 10000);
      const probeCounted = (await asked('page:status', { code: dvHall })).board.nodocs;
      report(probeJoined === 'docs' && !!probeShows && probeShows.words === 'As a picture of p. 1: this device cannot page through the document' && probeShows.docs === false && probeShows.kept === '1' && !probeShows.pdf
        && probeMark.mark === '✓' && probeMark.nodocs === 2 && probeMark.standin === 2 && probeAgain === 'kept' && probeCounted === 2,
        `a Board page that passes the documents' probe but cannot import pdf.js draws the document's stand-in with its words, opens no document for the rest of its session (kept in its tab), and joins again without docs: counted, ✓ on the console with 2 as a picture, and still so after a reload (${JSON.stringify({ probeJoined, probeShows, probeMark, probeAgain, probeCounted })})`);

      const devProblems = [['desk', desk], ['probe', probe], ...legs.map((l) => ['leg ' + l.w, l.tab])].flatMap(([n, t]) => t.problems.map((p) => n + ': ' + p));
      report(devProblems.length === 0, `the devices hall's pages: no console error and no CSP violation${devProblems.length ? ' — ' + devProblems.slice(0, 4).join(' | ') : ''}`);
      dvOp.close();
      dee.close();
      for (const t of [desk, floor, probe, ...legs.map((l) => l.tab)]) { await t.send('Page.navigate', { url: 'about:blank' }); t.close(); }
    }

    // The header's countdown chip is its own door (the account's: the speaker's screen and the countdown on its screens).
    await hallView.until(`!document.getElementById('stageChip').hidden && document.getElementById('stageChip').getAttribute('role') === 'button'`, 8000);
    const stageDoors = await selfDoors(hallView, 'chip', `document.getElementById('stageChip')`, 'stageNow');
    await hallView.eval(`document.getElementById('stageChip').click()`);
    await hallView.until(`!!document.querySelector('.agm-menu [data-action="chip.speaker"]')`, 3000);
    await hallView.eval(`document.querySelector('.agm-menu [data-action="chip.speaker"]').click()`);
    const lineBox = await hallView.until(`document.getElementById('swDialog').open && JSON.stringify({ text: document.getElementById('swText').value, dest: document.getElementById('swDest').options.length > 0 })`, 5000);
    await hallView.eval(`document.getElementById('swDialog').close()`);
    // Every screen ticked in Screens (the steps above left one ticked that is gone), then the countdown from the chip.
    await hallView.eval(`(() => { ${OPEN_SCREENS}; const all = document.getElementById('screensAll'); if (!all.checked) all.click(); document.getElementById('screensClose').click(); })()`);
    await hallView.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('stageChip').click(); })()`);
    await hallView.until(`!!document.querySelector('.agm-menu [data-action="chip.screens"]')`, 3000);
    await hallView.eval(`document.querySelector('.agm-menu [data-action="chip.screens"]').click()`);
    const countdownSaid = await hallView.until(`(document.getElementById('agmToast') || {}).textContent`, 5000);
    const countdownOn = await hallView.until(`new Promise((r) => socket.emit('display:list', { code: ROOM }, (x) => r(x.displays.length > 0 && x.displays.every((d) => d.content && d.content.kind === 'countdown') && x.displays.length)))`, 5000);
    report(selfInStep(stageDoors) && stageDoors.want === '["chip.speaker","chip.screens"]' && lineBox === JSON.stringify({ text: '', dest: true }) && /^Sent to \d+ screens? — each shows ✓/.test(countdownSaid || '') && !!countdownOn,
      `the stage chip opens its menu by a click, a right-click and Shift+F10 alike; Speaker's screen… opens the line box empty, and Show the countdown on screens puts it on the hall's ${countdownOn} screens (${JSON.stringify({ want: stageDoors.want, lineBox, countdownSaid })}${selfInStep(stageDoors) ? '' : '; ' + JSON.stringify(stageDoors)})`);
    // The header's ⋯ is its own door: a click on it, a right-click on it and Shift+F10 on it focused open the catalogue's
    // set for the header, and so does a right-click on the room's name; Copy join link copies the join page's link with
    // the code.
    const HEADER_WANT = ['header.people', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.leave'];
    const headerDoors = await selfDoors(research, 'header', `document.getElementById('headerMore')`, 'headerObject()');
    await rightClick(research, await middleOf(research, `document.querySelector('.app-title strong')`));
    const byTitle = await research.until(MENU_IDS, 3000);
    await press(research, 'Escape');
    await research.until(NO_MENU, 3000);
    await research.eval(`(() => { const t = document.getElementById('agmToast'); if (t) t.textContent = ''; document.getElementById('headerMore').click(); })()`);
    await research.until(`!!document.querySelector('.agm-menu [data-action="header.copy"]')`, 3000);
    await research.eval(`document.querySelector('.agm-menu [data-action="header.copy"]').click()`);
    const joinLink = await research.until(`(() => { const t = (document.getElementById('agmToast') || {}).textContent || ''; const a = document.querySelector('.agm-ask');
      if (/^Copied the join link/.test(t)) return 'copied'; return a && a.querySelector('input').value === location.origin + '/?code=' + ROOM && 'field'; })()`, 3000);
    if (joinLink === 'field') await press(research, 'Escape');
    report(selfInStep(headerDoors) && headerDoors.want === JSON.stringify(HEADER_WANT) && byTitle === headerDoors.want && !!joinLink,
      `the header's ⋯ opens its menu by a click, a right-click and Shift+F10 alike, and so does a right-click on the room's name; Copy join link copies the join page's link with the code (${JSON.stringify({ want: headerDoors.want, byTitle, joinLink })}${selfInStep(headerDoors) ? '' : '; ' + JSON.stringify(headerDoors)})`);
    // The admin's own page: the header's ⋯ adds Screens & pages…, Turn the code off… and New code…. Turn off asks which way (the
    // guests in stay, or are sent out), its safe answer focused; chosen to keep them, every page's Copy guest code says
    // "(off)" as the server tells it, the guest's too; Turn the code on asks nothing and puts it back.
    const adminHeaderDoors = await selfDoors(hallView, 'header', `document.getElementById('headerMore')`, 'headerObject()');
    const headerAct = async (id) => {
      await hallView.eval(`document.getElementById('headerMore').click()`);
      await hallView.until(`!!document.querySelector('.agm-menu [data-action="${id}"]')`, 3000);
      const words = await hallView.eval(`document.querySelector('.agm-menu [data-action="${id}"] .mi-label').textContent`);
      await hallView.eval(`document.querySelector('.agm-menu [data-action="${id}"]').click()`);
      return words;
    };
    const CODE_SAID = `AGM.catalog.items('header', F, headerObject()).find((i) => i.id === 'header.code').label`;
    const toggleOffWords = await headerAct('header.codeToggle');
    const offAsk = await hallView.until(`(() => { const a = document.querySelector('.agm-ask'); return a && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, answers: [...a.querySelectorAll('[data-answer]')].map((b) => b.dataset.answer + ':' + b.textContent), focus: document.activeElement === a.querySelector('[data-answer=no]') }); })()`, 3000);
    await hallView.eval(`document.querySelector('.agm-ask [data-answer=keep]').click()`);
    const codesOff = [await hallView.until(`${CODE_SAID} === 'Copy guest code ' + ROOM + ' (off)' && ${CODE_SAID}`, 5000),
      await research.until(`${CODE_SAID} === 'Copy guest code ' + ROOM + ' (off)' && ${CODE_SAID}`, 5000)];
    const onWords = await headerAct('header.codeToggle');
    const codesOn = [await hallView.until(`${CODE_SAID} === 'Copy guest code ' + ROOM && 'on'`, 5000), await research.until(`${CODE_SAID} === 'Copy guest code ' + ROOM && 'on'`, 5000)];
    report(selfInStep(adminHeaderDoors) && adminHeaderDoors.want === JSON.stringify(['header.people', 'header.screens', 'header.size', 'header.theme', 'header.code', 'header.copy', 'header.codeToggle', 'header.newCode', 'header.leave'])
      && toggleOffWords === 'Turn the code off…' && onWords === 'Turn the code on'
      && offAsk === JSON.stringify({ title: 'Turn off the guest code of Smoke AGM?', answers: ['keep:Turn off', 'out:Turn off and send them out', 'no:Keep it on'], focus: true })
      && JSON.stringify(codesOff) === JSON.stringify(['Copy guest code ' + code + ' (off)', 'Copy guest code ' + code + ' (off)']) && JSON.stringify(codesOn) === '["on","on"]',
    `the admin's ⋯ adds Screens & pages…, Turn the code off… and New code…; off asks which way, keeps the guests and every page's Copy guest code says "(off)", and on asks nothing (${JSON.stringify({ want: adminHeaderDoors.want, toggleOffWords, offAsk, codesOff, onWords, codesOn })}${selfInStep(adminHeaderDoors) ? '' : '; ' + JSON.stringify(adminHeaderDoors)})`);

    // The header is one model at every width: row 1 the room's name, its status, Help and the ⋯, at most 6 controls at 1440
    // and 1024 px (and on a phone), on one line, each 44 px; row 2 the switcher, its rooms 44 px under a mouse too, only
    // with two rooms or more (the admin account's page, whose hall has side rooms; a guest's page has one room). The ⋯
    // holds People, Screens & pages…, Text size,
    // Dark theme, the guest code and the way out, and each acts: the panel, the text size, the theme. Every status in the
    // header is one chip: its mark the table's for its name, its colour that name's role.
    const HEADER_READ = `(() => { const vis = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
      const bar = document.querySelector('.app-bar'); const sw = document.getElementById('roomSwitcher');
      const controls = [...bar.querySelectorAll('button, a[href], [role=button], select, input')].filter(vis);
      const mid = (n) => { const q = n.getBoundingClientRect(); return q.top + q.height / 2; };
      const middles = controls.map(mid).concat(mid(bar.querySelector('.app-title strong')));
      return JSON.stringify({ width: innerWidth, controls: controls.map((n) => n.id || n.className).concat(vis(sw) ? ['roomSwitcher'] : []), oneRow: Math.max(...middles) - Math.min(...middles) < 12,
        below: !vis(sw) || sw.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom - 1, rooms: sw.querySelectorAll('a').length, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        small: controls.concat(vis(sw) ? [...sw.querySelectorAll('a')] : []).filter((n) => Math.min(n.getBoundingClientRect().width, n.getBoundingClientRect().height) < 44).map((n) => n.id || n.className) }); })()`;
    const headerAt = async (tab, width, phone) => {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: !!phone });
      await sleep(250);
      return JSON.parse(await tab.eval(HEADER_READ));
    };
    const headers = { admin: [await headerAt(hallView, 1440), await headerAt(hallView, 1024)], guest: [await headerAt(research, 1440), await headerAt(research, 1024), await headerAt(research, 390, true)] };
    await hallView.send('Emulation.clearDeviceMetricsOverride');
    await research.send('Emulation.clearDeviceMetricsOverride');
    await sleep(250);
    const headerOk = (h, rows) => h.controls.length <= 6 && h.oneRow && h.fits && h.small.length === 0 && h.below && (rows ? h.controls.includes('roomSwitcher') && h.rooms >= 2 : !h.controls.includes('roomSwitcher'))
      && h.controls.includes('headerMore') && !h.controls.some((c) => /zoom|theme|people|screens|roomChip|Leave/i.test(c));
    await hallView.eval(`document.getElementById('headerMore').click()`);
    const adminMenu = await hallView.until(`(() => { const m = document.querySelector('.agm-menu:not(.agm-sub)'); return m && JSON.stringify([...m.querySelectorAll(':scope > .agm-mi')].map((b) => b.querySelector('.mi-label').textContent.replace(/^(People · )\\d+$/, '$1N'))); })()`, 3000);
    await press(hallView, 'Escape');
    // People shows the panel; Text size ▸ Large sets the messages' size, Standard puts it back; Dark theme turns it dark and back.
    const headerPick = async (tab, id, value) => {
      await tab.eval(`document.getElementById('headerMore').click()`);
      await tab.until(`!!document.querySelector('.agm-menu [data-action="${id}"]')`, 3000);
      await tab.eval(`document.querySelector('.agm-menu [data-action="${id}"]').click()`);
      if (value !== undefined) {
        await tab.until(`!!document.querySelector('.agm-sub .agm-mi[data-value="${value}"]')`, 3000);
        await tab.eval(`document.querySelector('.agm-sub .agm-mi[data-value="${value}"]').click()`);
      }
      await tab.until(NO_MENU, 3000);
    };
    const headerWas = await research.eval(`JSON.stringify({ people: document.getElementById('peoplePanel').hidden, theme: document.documentElement.dataset.theme })`);
    await headerPick(research, 'header.people');
    await headerPick(research, 'header.size', 1.15);
    await headerPick(research, 'header.theme');
    const headerActed = await research.eval(`JSON.stringify({ people: !document.getElementById('peoplePanel').hidden, zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom-msg').trim(), theme: document.documentElement.dataset.theme,
      checked: AGM.catalog.items('header', F, headerObject()).filter((i) => i.checked).map((i) => i.id), size: AGM.catalog.submenu('header', 'header.size', F, headerObject()).filter((v) => v.checked).map((v) => v.label) })`);
    await headerPick(research, 'header.people');
    await headerPick(research, 'header.size', 1);
    await headerPick(research, 'header.theme');
    const headerBack = await research.eval(`JSON.stringify({ people: document.getElementById('peoplePanel').hidden, theme: document.documentElement.dataset.theme, zoom: currentZoom })`);
    // One status chip: each marked chip of the header has the table's mark for its name, and that name's colour role.
    const CHIPS_READ = `JSON.stringify([...document.querySelectorAll('.app-header .status-chip')].filter((c) => c.dataset.mark).map((c) => { const m = AGM.MARKS[c.dataset.mark];
      const probe = document.createElement('i'); probe.style.color = 'var(--c-' + m.role + ')'; c.appendChild(probe); const role = getComputedStyle(probe).color; probe.remove();
      const mark = c.querySelector(':scope > .chip-mark');
      return [c.id, c.dataset.mark, mark.textContent === m.mark + ' ' && c.dataset.tone === m.role && (c.classList.contains('help-btn') || getComputedStyle(mark).color === role)]; }))`;
    const headerChips = [JSON.parse(await hallView.eval(CHIPS_READ)), JSON.parse(await research.eval(CHIPS_READ))];
    report(headers.admin.every((h) => headerOk(h, true)) && headers.guest.every((h) => headerOk(h, false))
      && adminMenu === JSON.stringify(['People · N', 'Screens & pages…', 'Text size', 'Dark theme', 'Copy guest code ' + code, 'Copy join link', 'Turn the code off…', 'New code…', 'All halls'])
      && headerWas === JSON.stringify({ people: true, theme: 'light' }) && headerActed === JSON.stringify({ people: true, zoom: '1.15', theme: 'dark', checked: ['header.people', 'header.theme'], size: ['Large'] })
      && headerBack === JSON.stringify({ people: true, theme: 'light', zoom: 1 })
      && headerChips.every((list) => list.some(([id, mark]) => id === 'connChip' && mark === 'ok') && list.every(([, , same]) => same)),
      `the header is one model at every width: at most 6 controls on one row at 1440 and 1024 px and on a phone, each 44 px, the switcher on a row of its own only with two rooms; the ⋯ holds People, Screens & pages…, Text size, Dark theme, the guest code and the way out, and each acts; every status in it is one chip of the table's mark and colour (${JSON.stringify({ headers, adminMenu, headerWas, headerActed, headerBack, headerChips })})`);

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
    // A backstage guest's Chat view chosen in the admin page's row (its select is the row's Chat view ▸): the server keeps
    // it and says it back in the admin's people list, live; then By seat again (a backstage seat's view is the full view
    // either way, so its page draws what it drew).
    const viewRow = `[...document.querySelectorAll('#usersTbody tr[data-key]')].find((tr) => { const s = tr.querySelector('.role-select'); return s && s.value === 'research' && tr.querySelector('.view-select'); })`;
    const pickView = (v) => admin.eval(`(() => { const tr = ${viewRow}; if (!tr) return ''; const sel = tr.querySelector('.view-select'); sel.value = ${codeLiteral(v)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return tr.dataset.key; })()`);
    const keptView = (sid) => admin.eval(`new Promise((r) => socket.emit('admin:watchRoom', { roomCode: ${codeLiteral(code)} }, (a) => { const u = a && a.ok && a.users.find((x) => x.socketId === ${codeLiteral(sid)}); r(u ? u.view : null); }))`);
    const viewSid = await pickView('full');
    const viewHeads = await admin.eval(`[...document.querySelectorAll('.admin-users th')].map((t) => t.textContent).join(' · ')`);
    const viewFull = viewSid && await admin.until(`(() => { const tr = document.querySelector('#usersTbody tr[data-key=' + JSON.stringify(${codeLiteral(viewSid)}) + ']'); return tr && tr.querySelector('.view-select').value === 'full' && 'full'; })()`, 5000);
    const keptFull = viewSid ? await keptView(viewSid) : null;
    await pickView('');
    const viewSeat = viewSid && await admin.until(`(() => { const tr = document.querySelector('#usersTbody tr[data-key=' + JSON.stringify(${codeLiteral(viewSid)}) + ']'); return tr && tr.querySelector('.view-select').value === '' && 'by seat'; })()`, 5000);
    const keptSeat = viewSid ? await keptView(viewSid) : null;
    const viewWords = await admin.eval(`[...document.querySelector('#usersTbody .view-select').options].map((o) => o.textContent).join(' · ')`);
    report(!!viewSid && viewFull === 'full' && keptFull === 'full' && viewSeat === 'by seat' && keptSeat === '' && viewWords === 'By seat · Simple · Full',
      `the admin page's Chat view select (${viewWords}; the heads ${viewHeads}) sets a backstage guest's view, which the server keeps (${keptFull}), and By seat again (${JSON.stringify(keptSeat)})`);
    // The same guest's Clock or countdown in the row (its select is Clock or countdown ▸, its tick Lock it on their devices):
    // Lock disabled with why while the choice is theirs; the countdown chosen, then locked, each kept by the server and
    // said back in the row, live; then their choice again, unlocked.
    // The lock's reason is drawn under it and read with it (aria-describedby), and the tick is named for its person.
    const CLOCK_CELL = (sid) => `(() => { const tr = document.querySelector('#usersTbody tr[data-key=' + JSON.stringify(${codeLiteral(sid)}) + ']'); if (!tr) return null; const sel = tr.querySelector('.clock-select'), box = tr.querySelector('.clock-lock-box');
      const why = tr.querySelector('.clock-why'); const said = !why.hidden && why.getClientRects().length > 0 ? why.textContent : '';
      return JSON.stringify({ show: sel.value, locked: box.checked, disabled: box.disabled, why: said, describes: box.getAttribute('aria-describedby') === why.id && !!why.id, name: box.getAttribute('aria-label'), options: [...sel.options].map((o) => o.textContent) }); })()`;
    const keptClock = (sid) => admin.eval(`new Promise((r) => socket.emit('admin:watchRoom', { roomCode: ${codeLiteral(code)} }, (a) => { const u = a && a.ok && a.users.find((x) => x.socketId === ${codeLiteral(sid)}); r(u ? JSON.stringify(u.clock) : null); }))`);
    const clockBefore = viewSid ? JSON.parse(await admin.eval(CLOCK_CELL(viewSid)) || 'null') : null;
    await admin.eval(`(() => { const tr = document.querySelector('#usersTbody tr[data-key=' + JSON.stringify(${codeLiteral(viewSid || '')}) + ']'); const sel = tr.querySelector('.clock-select'); sel.value = 'stage'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const clockChosen = viewSid && await admin.until(`(() => { const c = ${CLOCK_CELL(viewSid)}; return c && JSON.parse(c).show === 'stage' && !JSON.parse(c).disabled && c; })()`, 5000);
    await admin.eval(`(() => { const tr = document.querySelector('#usersTbody tr[data-key=' + JSON.stringify(${codeLiteral(viewSid || '')}) + ']'); tr.querySelector('.clock-lock-box').click(); return true; })()`);
    const clockLocked = viewSid && await admin.until(`(() => { const c = ${CLOCK_CELL(viewSid)}; return c && JSON.parse(c).locked && c; })()`, 5000);
    const keptLocked = viewSid ? await keptClock(viewSid) : null;
    await admin.eval(`new Promise((r) => socket.emit('admin:setClock', { roomCode: ${codeLiteral(code)}, socketId: ${codeLiteral(viewSid || '')}, show: null, locked: false }, r))`);
    const clockBack = viewSid && await admin.until(`(() => { const c = ${CLOCK_CELL(viewSid)}; return c && JSON.parse(c).show === '' && !JSON.parse(c).locked && JSON.parse(c).disabled && c; })()`, 5000);
    report(!!clockBefore && clockBefore.show === '' && clockBefore.disabled && clockBefore.why === 'Choose one to lock it.' && clockBefore.describes && /^Lock it on their devices for \S/.test(clockBefore.name || '')
      && JSON.stringify(clockBefore.options) === JSON.stringify(['Their choice (the clock at first)', 'Time of day', 'Stagewatch countdown', 'Off'])
      && !!clockChosen && JSON.parse(clockChosen).why === '' && !!clockLocked && keptLocked === JSON.stringify({ show: 'stage', locked: true }) && !!clockBack,
      `the admin page's Clock or countdown cell: Their choice first, Lock named for the person and disabled with why drawn under it until a choice is made; the countdown chosen and locked, each kept by the server and said back in the row; their choice again, unlocked (${JSON.stringify({ clockBefore, clockChosen, clockLocked, keptLocked, clockBack })})`);
    // The admin page in the copy deck's words, watching a hall; then every page read says no old word in its chrome.
    const adminDeck = JSON.parse(await admin.eval(`JSON.stringify({
      tagline: document.querySelector('#loginPanel .tagline').textContent, newHall: document.getElementById('newSessionBtn').textContent,
      halls: document.querySelector('.admin-sidebar h3').textContent, none: document.getElementById('noRooms').textContent,
      code: document.querySelector('#roomHeader span.muted').textContent, clear: AGM.catalog.entry('adminRoom', 'adminRoom.clear').label,
      close: AGM.catalog.entry('adminRoom', 'adminRoom.remove').label(ADMIN_F, roomObject('${code}')), closing: AGM.catalog.entry('adminRoom', 'adminRoom.remove').confirm(ADMIN_F, roomObject('${code}')).title.slice(0, 11),
      people: document.querySelector('#usersSection h3').textContent, view: document.querySelectorAll('.admin-users th')[2].textContent, clock: document.querySelectorAll('.admin-users th')[3].textContent, forward: document.querySelectorAll('.admin-users th')[4].textContent,
      local: document.querySelector('#tunnelOffState p').textContent.trim().split('\\n')[0], empty: [...document.querySelectorAll('#adminEmpty p')].map((p) => p.textContent) })`));
    report(JSON.stringify(adminDeck) === JSON.stringify({
      tagline: 'Halls, rooms and people, for the admin.', newHall: 'New hall', halls: 'Halls', none: 'No halls yet. Choose New hall to make one.', code: 'Code',
      clear: 'Clear messages…', close: 'Close hall…', closing: 'Close hall ', people: 'People in this room', view: 'Chat view', clock: 'Clock or countdown', forward: 'May forward to',
      local: 'AGMessage is reachable only on the venue\'s network now.',
      empty: ['Choose a hall on the left, or New hall.', 'Each room has a 6-character guest code: share it with the people who join without an account.'],
    }), `the admin page says hall, room and code: New hall, Halls, Code, Clear messages…, Close hall…, People in this room, Chat view, May forward to (${JSON.stringify(adminDeck)})`);
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
    const LAPTOP_ROWS = ['build', 'format', 'addresses', 'https', 'sealed', 'screens', 'pages', 'stagewatch', 'tunnel', 'stop', 'network', 'firewall', 'sleep', 'lid', 'task', 'admin'];
    const laptopRows = await admin.until(`(() => {
      const rows = [...document.querySelectorAll('#laptopFacts > li[data-fact]')];
      if (!rows.length) return false;
      return JSON.stringify({ ids: rows.map((r) => r.dataset.fact), said: rows.every((r) => r.querySelector('strong').textContent.endsWith(': ') && r.querySelector('.lf-words').textContent.length > 0 && /^ · read from \\S/.test(r.querySelector('.lf-from').textContent)),
        marks: rows.every((r) => (r.querySelector('.lf-mark').textContent === '') === (r.dataset.state === '')), elsewhere: ${process.platform === 'win32'} || rows.filter((r) => ['network', 'sleep', 'lid', 'task', 'admin'].includes(r.dataset.fact)).every((r) => r.querySelector('.lf-words').textContent === 'unknown (AGMessage is not running on Windows)'),
        folder: rows.filter((r) => r.dataset.fact === 'format').map((r) => r.querySelector('.lf-words').textContent).join(''),
        pages: rows.filter((r) => r.dataset.fact === 'pages').map((r) => r.querySelector('.lf-words').textContent).join('') });
    })()`, 8000);
    const laptopRead = JSON.parse(laptopRows || '{}');
    await admin.eval(`(() => { document.getElementById('laptopRead').textContent = ''; document.querySelector('#laptopActs [data-action="laptop.refresh"]').click(); })()`);
    const refreshed = await admin.until(`(() => { const t = document.getElementById('laptopRead').textContent; return /^Read at \\d\\d:\\d\\d on \\d+ \\w+\\. Refresh reads it again\\.$/.test(t) && t; })()`, 15000);
    await admin.eval(`document.getElementById('laptopSection').scrollIntoView({ block: 'start' })`);
    await admin.shot(path.join(OUT, 'admin-laptop.png'));
    report(LAPTOP_ROWS.every((id) => (laptopRead.ids || []).includes(id)) && laptopRead.said && laptopRead.marks && laptopRead.elsewhere && /^format 2 · /.test(laptopRead.folder || '') && !!refreshed,
      `the admin page's "This laptop" says each fact, its mark beside its shape, and where it was read, and Refresh reads Windows again (${laptopRows}; "${refreshed}")`);
    // Every page and screen open in this browser names the build that serves it, so none is listed on another.
    report(laptopRead.pages === 'every open page and screen is on this build', `"This laptop"'s Pages: every page this browser opened, and each screen, named the build that serves it ("${laptopRead.pages}")`);
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
    // A hall's rooms on the admin page: New room in this hall… from the watched hall's ⋯, asked in place, and the room is
    // listed under its hall; its row opens the catalogue's set by right-click, ⋯ and Shift+F10 (no seats' lock and no room
    // made in a room); Rename… names it again; watched, its header names it with its hall and by its key (room:settings);
    // Remove room… takes it out of the list in place, the page and the hall as they were.
    await admin.eval(`document.querySelector('#roomActs .obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.create"]')`, 3000);
    await admin.eval(`document.querySelector('.agm-menu [data-action="adminRoom.create"]').click()`);
    const sideCreateAsk = await admin.until(`(() => { const a = document.querySelector('.agm-ask'); const i = a && a.querySelector('input[name="name"]'); return !!i && document.activeElement === i && a.querySelector('.agm-ask-title').textContent; })()`, 3000);
    await admin.eval(`(() => { document.querySelector('.agm-ask input[name="name"]').value = 'Legal'; document.querySelector('.agm-ask [data-answer=yes]').click(); })()`);
    // Under its hall: the hall's row is the nearest row above it that is not a side room (the hall's other rooms, Press
    // made in its Set up among them, sit between).
    const sideKey = await admin.until(`(() => { const li = [...document.querySelectorAll('#roomList > li.side[data-key]')].find((x) => x.querySelector('.room-name').textContent === 'Legal'); let h = li && li.previousElementSibling; while (h && h.classList.contains('side')) h = h.previousElementSibling; return !!li && !!h && h.dataset.key === '${code}' && li.dataset.key; })()`, 5000);
    await admin.eval(`window.__sideRow = document.querySelector('#roomList > li[data-key="${sideKey}"]')`);
    // Its row's name says its hall to a screen reader, which hears the list flat: "Legal, a room of Smoke AGM …".
    const sideRowName = await admin.eval(`window.__sideRow.querySelector('.room-pick').textContent`);
    const sideDoors = await doorsOf(admin, 'adminRoom', 'window.__sideRow', `AGM.page.object('adminRoom', '${sideKey}')`, { ...PAGE_DOORS, hit: '.room-pick' });
    report(sideCreateAsk === 'New room in Smoke AGM' && /^[A-Z2-9]{8}$/.test(sideKey || '') && /^Legal, a room of Smoke AGM0 people · 0 messages · code [A-Z2-9]{6} off$/.test(sideRowName || '') && doorsInStep(sideDoors) && sideDoors.want === JSON.stringify(['adminRoom.watch', 'adminRoom.transcript', 'adminRoom.minutes', 'adminRoom.invites', 'adminRoom.sendFrom', 'adminRoom.codeToggle', 'adminRoom.newCode', 'adminRoom.rename', 'adminRoom.clear', 'adminRoom.remove']) && JSON.parse(adminDoors.header.want).includes('adminRoom.create'),
      `New room in this hall… makes a room, listed under its hall and named with it, whose row opens the catalogue's set by right-click, ⋯ and Shift+F10 (${sideCreateAsk}; ${sideKey}; "${sideRowName}"; ${sideDoors.want}; ${sideDoors.right} / ${sideDoors.dots} / ${sideDoors.key}; ${sideDoors.inline})`);
    await admin.eval(`window.__sideRow.querySelector('.obj-more').click()`);
    await admin.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.rename"]')`, 3000);
    await admin.eval(`document.querySelector('.agm-menu [data-action="adminRoom.rename"]').click()`);
    const sideRenameFilled = await admin.until(`(() => { const i = document.querySelector('.agm-ask input[name="name"]'); return !!i && i.value; })()`, 3000);
    await admin.eval(`(() => { document.querySelector('.agm-ask input[name="name"]').value = 'Lawyers'; document.querySelector('.agm-ask [data-answer=yes]').click(); })()`);
    const roomRenamed = await admin.until(`window.__sideRow.isConnected && window.__sideRow.querySelector('.room-name').textContent === 'Lawyers' && (document.getElementById('agmToast') || {}).textContent`, 5000);
    await admin.eval(`window.__sideRow.querySelector('.room-pick').click()`);
    const sideWatched = await admin.until(`(() => { const n = document.getElementById('watchedRoomName').textContent; return currentRoom && currentRoom.code === '${sideKey}' && n === 'Smoke AGM › Lawyers' && JSON.stringify([n, document.getElementById('watchedKeyWord').textContent, document.getElementById('watchedRoomCode').textContent]); })()`, 5000);
    // Its guest code is the admin's: off at birth. New code… asks, and the row and the header name the new one; Turn the code
    // on asks nothing, and the header says guests join with it.
    const sideCodeBefore = await admin.eval(`roomObject('${sideKey}').guestCode`);
    const sideAct = async (id) => {
      await admin.eval(`window.__sideRow.querySelector('.obj-more').click()`);
      await admin.until(`!!document.querySelector('.agm-menu [data-action="${id}"]')`, 3000);
      await admin.eval(`document.querySelector('.agm-menu [data-action="${id}"]').click()`);
    };
    await sideAct('adminRoom.newCode');
    const newCodeAsk = await admin.until(`(() => { const a = document.querySelector('.agm-ask'); return a && a.querySelector('.agm-ask-title').textContent; })()`, 3000);
    await admin.eval(`document.querySelector('.agm-ask [data-answer=yes]').click()`);
    const renewedSide = await admin.until(`(() => { const o = roomObject('${sideKey}'); return !!o && o.guestCode !== '${sideCodeBefore}' && currentRoom.guestCode === o.guestCode && document.getElementById('watchedCodeNote').textContent === 'Guest code ' + o.guestCode + ': off. The admin and the accounts given this room go in.' && o.guestCode; })()`, 5000);
    await sideAct('adminRoom.codeToggle');
    const sideOn = await admin.until(`(() => { const o = roomObject('${sideKey}'); return !!o && o.on && document.getElementById('watchedCodeNote').textContent === 'Guest code ' + o.guestCode + ': guests join with it.' && window.__sideRow.querySelector('.room-pick').textContent; })()`, 5000);
    report(/^[A-Z2-9]{6}$/.test(sideCodeBefore || '') && newCodeAsk === 'New guest code for Smoke AGM › Lawyers?' && /^[A-Z2-9]{6}$/.test(renewedSide || '') && renewedSide !== sideCodeBefore && (sideOn || '').endsWith(' · code ' + renewedSide),
      `a side room's code: New code… asks and renews it, the row and the header say the new one, and Turn the code on switches it with no ask (${sideCodeBefore} → ${renewedSide}; ${newCodeAsk}; "${sideOn}")`);
    // May send in… on the admin page: Lawyers' picker, the hall's Main room ticked with its ↔ and saved; both lists hold
    // it, beside Press, which Set up let send into the Main room.
    await sideAct('adminRoom.sendFrom');
    const SIDE_SENDS = (key) => `document.querySelector('#sendsList li.sends-row[data-key="${key}"]')`;
    const adminPicker = await admin.until(`(() => { const d = document.getElementById('sendsDialog'); const me = ${SIDE_SENDS(sideKey)}; const main = ${SIDE_SENDS(code)}; return !!d && d.open && !!me && !!main && JSON.stringify({ title: document.getElementById('sendsTitle').textContent, me: me.querySelector('input.sends-on').disabled, main: main.querySelector('input.sends-on').checked }); })()`, 5000);
    await admin.eval(`(() => { const main = ${SIDE_SENDS(code)}; main.querySelector('input.sends-on').click(); main.querySelector('input.sends-back').click(); document.getElementById('sendsSave').click(); })()`);
    const adminSendsSaid = await admin.until(`!document.getElementById('sendsDialog').open && /^Saved/.test((document.getElementById('agmToast') || {}).textContent || '') && document.getElementById('agmToast').textContent`, 5000);
    const listsNow = (key) => `new Promise((r) => socket.emit('room:settings', { code: '${key}' }, (a) => r(JSON.stringify({ from: a.sendFrom.map((x) => x.key), back: a.sendBack }))))`;
    const sideLists = await admin.eval(listsNow(sideKey));
    const mainLists = await admin.eval(listsNow(code));
    report(adminPicker === JSON.stringify({ title: 'Who may send into Smoke AGM › Lawyers', me: true, main: false }) && adminSendsSaid === 'Saved: 1 room may send into Smoke AGM › Lawyers. It now sends into Smoke AGM.'
      && sideLists === JSON.stringify({ from: [code], back: [code] }) && mainLists === JSON.stringify({ from: [pressKey, sideKey], back: [pressKey, sideKey] }),
      `May send in… on the admin page: the hall's Main room ticked with ↔ sets both lists in one save (${adminPicker}; "${adminSendsSaid}"; ${sideLists}; ${mainLists})`);
    await admin.eval(`watchRoom('${code}')`);
    await admin.until(`currentRoom && currentRoom.code === '${code}' && document.getElementById('watchedKeyWord').textContent === 'Code'`, 5000);
    const residual = await admin.until(`document.getElementById('watchedCodeNote').textContent`, 3000);
    // Its row in the list is marked too, the whole words in its title.
    const residualRow = await admin.eval(`(() => { const p = document.querySelector('#roomList > li[data-key="${code}"] .room-pick'); return JSON.stringify([(p.querySelector('.code-is-key') || {}).textContent || '', p.title]); })()`);
    const RESIDUAL_WORDS = 'This hall\'s code is also its address: anyone with an account in it can read it. Choose New code to separate them.';
    report(residual === RESIDUAL_WORDS && residualRow === JSON.stringify(['code is its address', RESIDUAL_WORDS]),
      `a hall whose code is still its address says so where its code is shown, and its row in the list is marked (${residual}; ${residualRow})`);
    // The admin page's rollback line names what 0.5.1 would lose of the codes (plan 1-§1.8).
    const rollbackLine = await admin.eval(`document.getElementById('rollbackLine').textContent`);
    report(/^Do not go back to 0\.5\.1 during a show\./.test(rollbackLine) && rollbackLine.includes('a hall\'s code switched off admits guests again') && rollbackLine.includes('a hall\'s New code is lost'),
      `the admin page says what going back to 0.5.1 loses of the codes (${rollbackLine})`);
    const sideRemoveAsk = JSON.parse(await askOn('window.__sideRow', 'adminRoom.remove'));
    await admin.eval(`document.querySelector('.agm-ask [data-answer=yes]').click()`);
    const sideRemoved = await admin.until(`!document.querySelector('#roomList > li[data-key="${sideKey}"]') && currentRoom && currentRoom.code === '${code}' && !document.getElementById('roomHeader').hidden && (document.getElementById('agmToast') || {}).textContent`, 5000);
    const mainListsAfter = await admin.eval(listsNow(code));
    report(mainListsAfter === JSON.stringify({ from: [pressKey], back: [pressKey] }), `a room removed is taken off the list of the room it could send into (${mainListsAfter})`);
    report(sideRenameFilled === 'Legal' && roomRenamed === 'Renamed Lawyers.' && sideWatched === JSON.stringify(['Smoke AGM › Lawyers', 'Room key', sideKey]) && sideRemoveAsk.title === 'Remove room Smoke AGM › Lawyers?' && sideRemoveAsk.yes === 'Remove and delete' && sideRemoved === 'Removed Smoke AGM › Lawyers.',
      `Rename… fills in the room's name and names it again; watched, the room is named with its hall, by its key; Remove room… takes it out of the list in place (${sideRenameFilled}; "${roomRenamed}"; ${sideWatched}; ${sideRemoveAsk.title}; "${sideRemoved}")`);
    // Members… (an admin page opened by an account that manages accounts): Press's checklist names who holds it, one's own
    // account and Zed shown; Kim taken out and Zed put in, while Zed's account is removed elsewhere: one PATCH each, each
    // said ("1 saved · Zed Gone: No such account."), the dialog kept open with the list read again as the server holds it.
    // Board members… on the hall: those seated On stage there. Let them forward into ▸ lists every other room by its hall.
    const zedMade = await admin.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'zed', name: 'Zed Gone', role: 'staff', halls: [], password: 'gone before the save' }) }).then((r) => r.json()).then((b) => b.user && b.user.id)`);
    const adminM = await edge.tab(`${base}/admin.html`);
    const PRESS_ROW = `document.querySelector('#roomList > li[data-key="${pressKey}"]')`;
    const membersOffered = await adminM.until(`!!${PRESS_ROW} && ADMIN_F.manageUsers === true && JSON.stringify({ side: AGM.catalog.ids('adminRoom', ADMIN_F, roomObject('${pressKey}')).includes('adminRoom.members'), main: AGM.catalog.entry('adminRoom', 'adminRoom.members').label(ADMIN_F, roomObject('${code}')) })`, 8000);
    const openMembers = async (row) => {
      await adminM.eval(`${row}.querySelector('.obj-more').click()`);
      await adminM.until(`!!document.querySelector('.agm-menu [data-action="adminRoom.members"]')`, 3000);
      await adminM.eval(`document.querySelector('.agm-menu [data-action="adminRoom.members"]').click()`);
    };
    const MEMBER_ROWS = `[...document.querySelectorAll('#membersList > li[data-key]')].map((li) => ({ name: li.querySelector('strong').textContent, ticked: li.querySelector('input').checked, off: li.querySelector('input').disabled, why: (li.querySelector('.members-why') || {}).textContent || '' }))`;
    const memberOf = (name) => `${MEMBER_ROWS}.find((r) => r.name === '${name}')`;
    await openMembers(PRESS_ROW);
    const pressMembers = await adminM.until(`(() => { const d = document.getElementById('membersDialog'); return d && d.open && document.querySelectorAll('#membersList > li[data-key]').length >= 3 && JSON.stringify({ title: document.getElementById('membersTitle').textContent, ana: ${memberOf('Ana Admin')}, kim: ${memberOf('Kim Tech')}, lou: ${memberOf('Lou Legal')}, zed: ${memberOf('Zed Gone')} }); })()`, 5000);
    await adminM.shot(path.join(OUT, 'members.png'));
    await adminM.eval(`(() => { const box = (name) => [...document.querySelectorAll('#membersList > li[data-key]')].find((li) => li.querySelector('strong').textContent === name).querySelector('input'); box('Kim Tech').click(); box('Zed Gone').click(); })()`);
    const zedGone = await adminM.eval(`fetch('/api/users/${zedMade}', { method: 'DELETE' }).then((r) => r.status)`);
    adminM.expectFailure(/\/api\/users\/[^/]+$/);   // Zed's 404, removed before the Save, is this step's own
    await adminM.eval(`document.getElementById('membersSave').click()`);
    const membersSaid = await adminM.until(`(() => { const w = document.getElementById('membersSaid').textContent; return /saved/.test(w) && !${memberOf('Zed Gone')} && JSON.stringify({ said: w, open: document.getElementById('membersDialog').open, kim: ${memberOf('Kim Tech')}.ticked }); })()`, 8000);
    const kimAfter = await adminM.eval(`fetch('/api/users').then((r) => r.json()).then((b) => JSON.stringify(b.users.find((u) => u.username === 'kim').rooms))`);
    await adminM.eval(`document.querySelector('#membersDialog button[value="cancel"]').click()`);
    await adminM.until(`!document.getElementById('membersDialog').open`, 3000);
    await openMembers(`document.querySelector('#roomList > li[data-key="${code}"]')`);
    const boardMembers = await adminM.until(`(() => { const d = document.getElementById('membersDialog'); return d && d.open && document.querySelectorAll('#membersList > li[data-key]').length >= 3 && JSON.stringify({ title: document.getElementById('membersTitle').textContent, kim: ${memberOf('Kim Tech')}.ticked, lou: ${memberOf('Lou Legal')}.why, louAdds: [...document.querySelectorAll('#membersList > li[data-key]')].find((li) => li.querySelector('strong').textContent === 'Lou Legal').querySelector('.members-adds').textContent }); })()`, 5000);
    await adminM.eval(`document.querySelector('#membersDialog button[value="cancel"]').click()`);
    const forwardRooms = await adminM.eval(`JSON.stringify((() => { const c = forwardChoices(allRooms, '${code}', ['${pressKey}']); return { home: c.some((x) => x.value === '${code}'), press: c.find((x) => x.value === '${pressKey}'), seps: c.filter((x) => x.sep).length, halls: allRooms.length }; })())`);
    const fr = JSON.parse(forwardRooms);
    report(membersOffered === JSON.stringify({ side: true, main: 'Board members…' }) && pressMembers === JSON.stringify({ title: 'Members of Smoke AGM › Press', ana: { name: 'Ana Admin', ticked: false, off: true, why: 'Your own account: another admin changes it.' },
      kim: { name: 'Kim Tech', ticked: true, off: false, why: '' }, lou: { name: 'Lou Legal', ticked: true, off: false, why: '' }, zed: { name: 'Zed Gone', ticked: false, off: false, why: '' } }),
      `Members… on a room lists the accounts, who holds it ticked, one's own account not offered; Board members… on a hall (${membersOffered}; ${pressMembers})`);
    report(zedGone === 200 && membersSaid === JSON.stringify({ said: '1 saved · Zed Gone: No such account.', open: true, kim: false }) && kimAfter === '[]',
      `Members… saves one account at a time and says each, a refused one by name; the list is read again as the server holds it (${membersSaid}; Kim's rooms ${kimAfter})`);
    report(boardMembers === JSON.stringify({ title: 'Board members of Smoke AGM', kim: true, lou: '', louAdds: 'A tick gives Smoke AGM too.' }) && !fr.home && JSON.stringify(fr.press) === JSON.stringify({ value: pressKey, label: 'Smoke AGM › Press', role: 'menuitemcheckbox', checked: true }) && fr.seps === fr.halls - 1,
      `Board members… lists who sits On stage in the hall, and says a tick gives the hall too to an account that does not reach it; Let them forward into ▸ lists every other room by its hall (${boardMembers}; ${forwardRooms})`);
    await research.eval(`Promise.all([new Promise((r) => socket.emit('message', { type: 'help', category: 'Sound', text: 'radio mic 3 dead' }, r)), new Promise((r) => socket.emit('message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] }, r))])`);
    // On stage, what is written stays in the room: no message offers ↗, a text, a file or a question, and nothing that
    // is not hidden is drawn for it; the Board's composer has no file or question door, and 🔥 Priority comes first.
    const boardForward = await board.until(`(() => {
      const kinds = new Set(Array.from(document.querySelectorAll('.msg[data-type]')).map((n) => n.dataset.type));
      if (!['text', 'file', 'action'].every((k) => kinds.has(k))) return null;
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]');
      return JSON.stringify({ forward: allMessages.filter((m) => AGM.catalog.ids('msg', F, m).includes('msg.send')).length + Array.from(document.querySelectorAll('.msg [data-action="msg.send"]')).filter(shown).length,
        composer: Array.from(document.querySelectorAll('#directorCompose button, #directorCompose input')).filter(shown).map((b) => b.id || (b.classList.contains('send-btn') ? 'send' : b.classList.contains('compose-more') ? 'more' : b.outerHTML)) });
    })()`);
    report(boardForward === JSON.stringify({ forward: 0, composer: ['dirPriorityBtn', 'directorInput', 'send', 'more'] }), `an On stage page offers no forward on any message, and its composer holds 🔥 Priority, the words, Send and its ⋯ (${boardForward})`);
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
    // Vic reads one hall and has nothing else to do on the halls page: it takes the Viewer straight into the hall, seated
    // to read as the server seats it; the hall page's way back is the board that stays (?stay=1).
    const vicStraight = await edge.tab(`${base}/halls.html`);
    const HERE_OF = `{ code: new URLSearchParams(location.search).get('code'), role: new URLSearchParams(location.search).get('role'), back: [headerObject().away] }`;
    const HERE = `JSON.stringify(${HERE_OF})`;
    const vicLanded = await vicStraight.until(`location.pathname === '/app.html' && typeof joined !== 'undefined' && joined && ${HERE}`, 10000);
    report(vicLanded === JSON.stringify({ code, role: 'observer', back: ['/halls.html?stay=1'] }), `an account with one room and nothing else to do is taken straight into it, seated as the server seats it, its way back the board that stays (${vicLanded})`);
    const viewerBoard = await edge.tab(`${base}/halls.html?stay=1`);
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
        header: AGM.catalog.ids('header', F, headerObject()),
        acts: [...new Set(allMessages.filter((m) => m.type !== 'system').flatMap((m) => AGM.catalog.ids('msg', F, m)))].sort(),
        bars: Array.from(document.querySelectorAll('.msg .msg-act')).filter(visible).length,
        answer: Array.from(document.querySelectorAll('.action-btn')).some((b) => !b.disabled),
        answerWords: !!document.querySelector('.answer-words-btn'),
        reactions: Array.from(document.querySelectorAll('.rx-pill')).some((b) => !b.disabled),
        files: document.querySelectorAll('.msg[data-type="file"]').length,
      });
    })()`);
    report(shown === JSON.stringify({ composer: false, header: ['header.people', 'header.size', 'header.theme', 'header.leave'], acts: ['msg.copy', 'msg.pinMine'], bars: 0, answer: false, answerWords: false, reactions: false, files: shown && JSON.parse(shown).files }) && JSON.parse(shown).files > 0,
      `the Viewer is offered nothing the server refuses: Copy text and 📌 Pin for me alone (a pin for itself), no pin for the room, reaction, answer, Send to, Look or Download on any message, a file's included (${shown})`);
    report(await viewerHall.eval(`document.getElementById('movedLine').hidden`), 'a page opened in this browser after What moved\'s Got it does not say it again');
    await readOldWords('the hall page opened by a Viewer account, Observer', viewerHall);
    const pagesRead = Object.keys(oldWords);
    report(pagesRead.length === 13 && pagesRead.every((p) => Array.isArray(oldWords[p]) && oldWords[p].length === 0),
      `no "session", "meeting", "director" or "research" in any page's chrome (${pagesRead.length} pages: ${pagesRead.map((p) => p + ': ' + (Array.isArray(oldWords[p]) ? (oldWords[p].length ? oldWords[p].join(' | ') : 'none') : 'not read')).join('; ')})`);
    await viewerHall.shot(path.join(OUT, 'hall-viewer.png'));
    // A stage send the server no longer follows (its Stagewatch restarted, or the hall moved) reads so, never "waiting".
    const lostLine = await research.eval(`stageLineText({ ack: 'lost', receipt: 'applied' })`);
    report(/^✕ No longer followed/.test(lostLine || ''), `a stage send no longer followed says so (${lostLine})`);

    // Lou, given Press alone: no hall on the board, Press under Your rooms by its hall's name, a link into the room with
    // Lou's seat there, and the hall's key nowhere on the page.
    const louIn = await signin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lou', password: 'press desk by the door' }) }).then((r) => r.status)`);
    // Press is Lou's one room: the halls page goes straight into it. Its header names it by its hall's name and its own,
    // with no switcher (one room), and nothing on it names the hall's key; its way back, All halls, stays on the board.
    const louBoard = await edge.tab(`${base}/halls.html`);
    const louLanded = await louBoard.until(`location.pathname === '/app.html' && typeof joined !== 'undefined' && joined && JSON.stringify({ ...${HERE_OF}, title: document.querySelector('.app-title strong').textContent, tab: document.title, switcher: document.getElementById('roomSwitcher').hidden, key: document.documentElement.outerHTML.includes('${code}') })`, 10000);
    report(louLanded === JSON.stringify({ code: pressKey, role: 'research', back: ['/halls.html?stay=1'], title: 'Smoke AGM › Press', tab: 'AGMessage · Smoke AGM › Press', switcher: true, key: false }),
      `an account given one side room alone is taken straight into it, its header "Smoke AGM › Press", no switcher, and the hall's key nowhere on it (${louLanded})`);
    await louBoard.eval(`(() => { document.getElementById('headerMore').click(); document.querySelector('.agm-menu [data-action="header.leave"]').click(); })()`);
    // Lou's page in Press closed its socket as its tab left it (reconnect.js), so the server heard it go then: within 6 s
    // Press is listed with nobody in (a page the browser keeps with its socket open would be counted until its pings went
    // unanswered, some 18 s).
    const LOU_ROOM = `(() => { const li = document.querySelector('#yourRoomList > li[data-key]'); return !document.getElementById('yourRooms').hidden && li && JSON.stringify({ rows: document.querySelectorAll('.hall-row').length, words: li.querySelector('.your-room-open').textContent, hall: li.querySelector('.your-room-hall').textContent,
      href: li.querySelector('a').getAttribute('href'), empty: document.getElementById('emptyNote').hidden ? '' : document.getElementById('emptyNote').textContent, key: document.documentElement.outerHTML.includes('${code}') }); })()`;
    const louRooms = (await louBoard.until(`(() => { const v = ${LOU_ROOM}; return v && JSON.parse(v).words === 'Press' ? v : ''; })()`, 6000)) || await louBoard.eval(LOU_ROOM);
    await louBoard.shot(path.join(OUT, 'your-rooms.png'));
    const louStays = await louBoard.eval(`location.pathname + location.search`);
    report(louMade === 200 && louIn === 200 && louRooms === JSON.stringify({ rows: 0, words: 'Press', hall: 'Smoke AGM', href: `/app.html?code=${pressKey}&as=account&role=research`, empty: 'No hall of your own: your rooms are below.', key: false }) && louStays === '/halls.html?stay=1',
      `All halls stays on the board (?stay=1), where an account given a side room alone finds it under Your rooms, by its hall's name, never the hall's key (${louRooms}; ${louStays})`);
    // A room under Your rooms opens the room's menu by right-click and Shift+F10: Open, Open in a new tab, Copy link and
    // Copy guest code (Lou's rights in Press hold what its code gives), and no Set up: a hall Lou does not see.
    const louRoomDoors = await ownLinkDoors(louBoard, 'room', `document.querySelector('#yourRoomList > li[data-key="${pressKey}"] a')`, `AGM.page.object('room', '${pressKey}')`, { facts: 'AGM.page.facts()' });
    report(linkInStep(louRoomDoors) && louRoomDoors.want === JSON.stringify(['room.open', 'room.tab', 'room.copy', 'room.code']), `a room under Your rooms: right-click = Shift+F10 = Open, Open in a new tab, Copy link, Copy guest code, and no Set up (${louRoomDoors.want}; ${louRoomDoors.right} / ${louRoomDoors.key})`);

    // Kim, a Board account of Smoke AGM, is given Press again (Members… took it away above): two rooms, so the halls page
    // is the question and lists both. Her account reads the full view (Chat view: Full), whose header holds the switcher
    // the simple view leaves out: the
    // hall's link seated On stage, Press a room button seated backstage. The hall opens On stage at once (no second load
    // for its seat), named "Smoke AGM", its switcher Main · Press with Main marked. A tap on Press moves the title and the
    // mark before the page goes (read as it goes), keeps what Kim wrote and had not sent, and opens Press seated backstage;
    // back on Main, the words are in the composer again.
    // Every sign-in comes from this one address, whose allowance refills one every 2 s: one turned away waits its turn.
    const kimIn = await signin.eval(`(async () => {
      const send = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const signIn = async (username, password) => { for (let i = 0; i < 5; i++) { const r = await send('/api/auth/login', { username, password }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; };
      const ana = await signIn('ana', 'the green room kettle');
      const kim = (await (await fetch('/api/users')).json()).users.find((u) => u.username === 'kim');
      const given = await send('/api/users/' + kim.id, { rooms: ['${pressKey}'], view: 'full' }, 'PATCH');
      return ana === 200 && given.status === 200 ? signIn('kim', 'mixing desk on stage left') : 'ana ' + ana + ', given ' + given.status; })()`);
    const LOADS = `(() => { if (location.pathname !== '/app.html') return;
      try { sessionStorage.setItem('agm.smokeLoads', String(Number(sessionStorage.getItem('agm.smokeLoads') || 0) + 1)); } catch { /* none kept */ }
      addEventListener('pagehide', () => { try { const c = document.querySelector('#roomSwitcher [aria-current="page"] .room-seg-name'); sessionStorage.setItem('agm.smokeLeft', JSON.stringify({ title: document.querySelector('.app-title strong').textContent, tab: document.title, current: c ? c.textContent : '' })); } catch { /* none kept */ } }); })();`;
    const kimTab = await edge.tab(`${base}/halls.html`, { init: LOADS });
    const kimBoard = await kimTab.until(`location.pathname === '/halls.html' && document.getElementById('linkState').dataset.ok === '1' && (() => { const row = document.querySelector('.hall-row[data-code="${code}"]'); const a = row && row.querySelector('a.room-btn[data-key="${pressKey}"]');
      return !!a && JSON.stringify({ rows: document.querySelectorAll('.hall-row').length, hall: row.querySelector('a.hall-open').getAttribute('href'), press: a.getAttribute('href') }); })()`, 10000);
    report(kimIn === 200 && kimBoard === JSON.stringify({ rows: 1, hall: `/app.html?code=${code}&as=account&role=board`, press: `/app.html?code=${pressKey}&as=account&role=research` }),
      `an account with two rooms stays on the halls page, which lists both: its hall seated On stage, its side room backstage (${kimIn}; ${kimBoard})`);
    await kimTab.eval(`document.querySelector('.hall-row[data-code="${code}"] a.hall-open').click()`);
    const SWITCHER = `JSON.stringify({ code: new URLSearchParams(location.search).get('code'), role: new URLSearchParams(location.search).get('role'), loads: sessionStorage.getItem('agm.smokeLoads'), title: document.querySelector('.app-title strong').textContent, tab: document.title,
      shown: !document.getElementById('roomSwitcher').hidden, rooms: [...document.querySelectorAll('#roomSwitcher > a')].map((a) => a.querySelector('.room-seg-name').textContent + (a.getAttribute('aria-current') === 'page' ? '*' : '')) })`;
    const JOINED_HERE = (key) => `location.pathname === '/app.html' && new URLSearchParams(location.search).get('code') === '${key}' && typeof joined !== 'undefined' && joined`;
    const kimMain = await kimTab.until(`${JOINED_HERE(code)} && ${SWITCHER}`, 10000);
    report(kimMain === JSON.stringify({ code, role: 'board', loads: '1', title: 'Smoke AGM', tab: 'AGMessage · Smoke AGM', shown: true, rooms: ['Main*', 'Press'] }),
      `a Board account opens its hall On stage at once, its header the hall's name and its switcher Main · Press, Main marked (${kimMain})`);
    // What Main's people read of Kim, on a page that sits there (Ana's, backstage): whether she is listed, and the lines
    // said of her. Entering the hall is said once, in the room she entered it by.
    const KIM_IN_MAIN = `JSON.stringify({ listed: people.some((u) => u.name === 'Kim Tech'), lines: allMessages.filter((m) => m.type === 'system' && m.text.startsWith('Kim Tech ')).map((m) => m.text) })`;
    const KIM_LINES = `JSON.stringify(allMessages.filter((m) => m.type === 'system' && m.text.startsWith('Kim Tech ')).map((m) => m.text))`;
    const kimEntered = await research.until(`(() => { const v = ${KIM_IN_MAIN}; return JSON.parse(v).listed && JSON.parse(v).lines.length > 0 && v; })()`, 5000);
    report(kimEntered === JSON.stringify({ listed: true, lines: ['Kim Tech joined On stage'] }), `Main's people see Kim come in, said once in the room she entered the hall by (${kimEntered})`);
    const SEG = (key) => `document.querySelector('#roomSwitcher > a[data-key="${key}"]')`;
    const segDoors = await ownLinkDoors(kimTab, 'room', SEG(pressKey), `switcherObject('${pressKey}')`);
    const hereDoors = await ownLinkDoors(kimTab, 'room', SEG(code), `switcherObject('${code}')`);
    // Press holds messages Kim has never read in this browser: its dot is lit, and its menu offers Mark as read.
    const segNews = await kimTab.eval(`${SEG(pressKey)}.dataset.news`);
    report(linkInStep(segDoors) && segDoors.want === JSON.stringify(['room.open', 'room.tab', 'room.copy', 'room.markRead']) && ['news', 'priority'].includes(segNews) && linkInStep(hereDoors) && hereDoors.want === JSON.stringify(['room.tab', 'room.copy']),
      `the switcher's rooms: right-click = Shift+F10 = Open, Open in a new tab, Copy link, and Mark as read on Press, never read here; this room's, no Open and (On stage) no code (${segDoors.want} ${segDoors.right} / ${segDoors.key}; ${segNews}; ${hereDoors.want} ${hereDoors.right} / ${hereDoors.key})`);
    await kimTab.eval(`document.getElementById('directorInput').value = 'Half a thought'`);
    await leftClick(kimTab, await middleOf(kimTab, SEG(pressKey)));
    const kimPress = await kimTab.until(`${JOINED_HERE(pressKey)} && JSON.stringify({ left: JSON.parse(sessionStorage.getItem('agm.smokeLeft')), here: JSON.parse(${SWITCHER}) })`, 10000);
    report(kimPress === JSON.stringify({ left: { title: 'Smoke AGM › Press', tab: 'AGMessage · Smoke AGM › Press', current: 'Press' },
      here: { code: pressKey, role: 'research', loads: '2', title: 'Smoke AGM › Press', tab: 'AGMessage · Smoke AGM › Press', shown: true, rooms: ['Main', 'Press*'] } }),
      `a tap on the switcher moves the title and the mark before the page goes, and opens the room seated as the server seats it (${kimPress})`);
    // The page Kim left closed its socket as the tab left it, so Main's People lose her at once, well inside the 8 s
    // grace (a page the browser kept with its socket open would stay listed until its pings went unanswered, some 18 s);
    // and the move is said in neither room: no "left" in Main, no "joined" in Press.
    const kimGone = await research.until(`(() => { const v = ${KIM_IN_MAIN}; return !JSON.parse(v).listed && v; })()`, 4000);
    await sleep(1500);
    const pressSaid = await kimTab.eval(KIM_LINES);
    report(kimGone === JSON.stringify({ listed: false, lines: ['Kim Tech joined On stage'] }) && pressSaid === '[]',
      `a move by the switcher: the room left lists the person no longer at once, and neither room says a line (${kimGone}; Press: ${pressSaid})`);
    await leftClick(kimTab, await middleOf(kimTab, SEG(code)));
    const kimBack = await kimTab.until(`${JOINED_HERE(code)} && JSON.stringify({ draft: document.getElementById('directorInput').value, here: JSON.parse(${SWITCHER}) })`, 10000);
    report(kimBack === JSON.stringify({ draft: 'Half a thought', here: { code, role: 'board', loads: '3', title: 'Smoke AGM', tab: 'AGMessage · Smoke AGM', shown: true, rooms: ['Main*', 'Press'] } }),
      `back in Main by the switcher, what Kim wrote and had not sent is in the composer again (${kimBack})`);
    // Back in Main: listed there again, and still no line in it but her entering the hall.
    const kimReturned = await research.until(`(() => { const v = ${KIM_IN_MAIN}; return JSON.parse(v).listed && v; })()`, 4000);
    await sleep(1500);
    const kimMainSaid = await research.eval(KIM_LINES);
    report(kimReturned === JSON.stringify({ listed: true, lines: ['Kim Tech joined On stage'] }) && kimMainSaid === JSON.stringify(['Kim Tech joined On stage']),
      `back in Main by the switcher: listed again, and the move said in neither room (${kimReturned}; ${kimMainSaid})`);
    // ---------------- Unread dots on the switcher (unit 21) ----------------
    // Kim read Press as she was in it above, so back in Main its segment has no dot. A message there lights it within the
    // frame's window: the note's mark in its colour role, its words the room's name and "new messages" (its accessible
    // name, and its tooltip after the room's); a 🔥 there makes it 🔥, "priority". The room's menu offers Mark as read,
    // set apart after its ways in, which takes the dot off, and its toast's Undo puts it back; a visit takes it off too.
    const DOT = (key) => `(() => { const a = ${SEG(key)}; const d = a && a.querySelector('.room-dot'); return !!d && JSON.stringify({ dot: d.hidden ? '' : d.textContent, tone: d.dataset.tone || '', label: a.getAttribute('aria-label') || '', title: a.title, news: a.dataset.news }); })()`;
    const dotOf = (tab, key, want) => tab.until(`(() => { const v = ${DOT(key)}; return v && JSON.parse(v).news === ${codeLiteral(want)} ? v : ''; })()`, 6000).then((v) => v || tab.eval(DOT(key)));
    const dotBefore = await kimTab.eval(DOT(pressKey));
    const ctlDots = await connect(base, cookie);
    // The laptop's token admin writes there, its own page joining Press by its key with a name and a seat.
    const anaInPress = await emit(ctlDots, 'join', { roomCode: pressKey, name: 'Front desk', role: 'research' });
    const plainSaid = await emit(ctlDots, 'message', { type: 'text', text: 'The press pack is on the table' });
    const dotLit = await dotOf(kimTab, pressKey, 'news');
    const hotSaid = await emit(ctlDots, 'message', { type: 'text', text: 'Photographers to the front now', priority: true });
    const dotHot = await dotOf(kimTab, pressKey, 'priority');
    report(anaInPress.ok && plainSaid.ok && hotSaid.ok && dotBefore === JSON.stringify({ dot: '', tone: '', label: '', title: 'Smoke AGM › Press', news: '' })
      && dotLit === JSON.stringify({ dot: '●', tone: 'info', label: 'Press, new messages', title: 'Smoke AGM › Press · new messages', news: 'news' })
      && dotHot === JSON.stringify({ dot: '🔥', tone: '', label: 'Press, priority', title: 'Smoke AGM › Press · priority', news: 'priority' }),
      `a message in Press lights its dot on Kim's switcher in Main, its words its accessible name; a 🔥 there makes it 🔥, "priority" (${[anaInPress, plainSaid, hotSaid].map((r) => (r.ok ? 'ok' : r.error)).join(', ')}; ${dotBefore}; ${dotLit}; ${dotHot})`);
    const dotDoors = await ownLinkDoors(kimTab, 'room', SEG(pressKey), `switcherObject('${pressKey}')`);
    await rightClick(kimTab, await middleOf(kimTab, SEG(pressKey)));
    await kimTab.until(MENU_IDS, 3000);
    await kimTab.eval(`document.querySelector('.agm-menu [data-action="room.markRead"]').click()`);
    const dotRead = await dotOf(kimTab, pressKey, '');
    const readSaid = await kimTab.eval(`(document.getElementById('agmToast') || {}).textContent || ''`);
    await kimTab.eval(`document.querySelector('#agmToast .toast-undo').click()`);
    const dotUndone = await dotOf(kimTab, pressKey, 'priority');
    report(linkInStep(dotDoors) && dotDoors.want === JSON.stringify(['room.open', 'room.tab', 'room.copy', 'room.markRead']) && JSON.parse(dotRead).dot === '' && JSON.parse(dotRead).label === ''
      && readSaid === 'Marked Smoke AGM › Press as read. · Undo' && JSON.parse(dotUndone).dot === '🔥',
      `a room with a dot: right-click = Shift+F10 = Open, Open in a new tab, Copy link, Mark as read; Mark as read takes the dot off, and Undo puts it back (${dotDoors.want} ${dotDoors.right} / ${dotDoors.key}; ${dotRead}; ${readSaid}; ${dotUndone})`);
    // A visit reads the room: the dot is off as the switcher is tapped, and off on Main's switcher once Kim is back. No
    // other room is lit meanwhile: Main took no message.
    await leftClick(kimTab, await middleOf(kimTab, SEG(pressKey)));
    const pressRead = await kimTab.until(`${JOINED_HERE(pressKey)} && (() => { const v = ${DOT(code)}; return v && JSON.stringify({ main: JSON.parse(v).news, left: JSON.parse(sessionStorage.getItem('agm.smokeLeft')).current }); })()`, 10000);
    await sleep(1000);
    await leftClick(kimTab, await middleOf(kimTab, SEG(code)));
    const dotVisited = await kimTab.until(`${JOINED_HERE(code)} && ${DOT(pressKey)}`, 10000);
    report(pressRead === JSON.stringify({ main: '', left: 'Press' }) && JSON.parse(dotVisited).news === '' && JSON.parse(dotVisited).dot === '',
      `a visit to Press reads it: back in Main its dot is off, and Main, which took no message, has none in Press (${pressRead}; ${dotVisited})`);
    // Where this browser keeps nothing (its storage refuses every save: a full store, a private window that keeps none), a
    // page holds what is read itself, from what its join told it: Kim's page opened so has no dot on Press, whatever Press
    // holds, lights it for a message that comes while it is open, and its Mark as read says the dot is off on this page
    // alone. The page reads nothing this browser kept.
    const kimBlocked = await edge.tab(`${base}/app.html?code=${code}&as=account&role=board`,
      { init: `Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };` });
    const blockedFirst = await kimBlocked.until(`${JOINED_HERE(code)} && ${DOT(pressKey)}`, 10000);
    const blockedSaid = await emit(ctlDots, 'message', { type: 'text', text: 'Badges at the side door' });
    const blockedLit = await dotOf(kimBlocked, pressKey, 'news');
    await rightClick(kimBlocked, await middleOf(kimBlocked, SEG(pressKey)));
    await kimBlocked.until(MENU_IDS, 3000);
    await kimBlocked.eval(`document.querySelector('.agm-menu [data-action="room.markRead"]').click()`);
    const blockedRead = await dotOf(kimBlocked, pressKey, '');
    const blockedToast = await kimBlocked.eval(`(document.getElementById('agmToast') || {}).textContent || ''`);
    const blockedProblems = kimBlocked.problems.slice();
    await kimBlocked.send('Page.navigate', { url: 'about:blank' });
    kimBlocked.close();
    report(!!blockedFirst && JSON.parse(blockedFirst).news === '' && blockedSaid.ok && JSON.parse(blockedLit || '{}').news === 'news' && JSON.parse(blockedRead || '{}').dot === ''
      && blockedToast === 'Marked Smoke AGM › Press as read on this page alone: this browser keeps nothing (its storage is blocked). · Undo' && blockedProblems.length === 0,
      `with storage that keeps nothing, a page's dots are the news that came while it is open, and Mark as read says it holds for this page alone (${blockedFirst}; ${blockedSaid.ok ? 'ok' : blockedSaid.error}; ${blockedLit}; ${blockedRead}; ${blockedToast}${blockedProblems.length ? '; ' + blockedProblems.slice(0, 3).join(' | ') : ''})`);
    ctlDots.close();
    await kimTab.shot(path.join(OUT, 'hall-switcher.png'));
    // A Staff account (messages and files, no Stagewatch) is seated backstage: while the hall's Stagewatch keeps a show
    // desk and its frames move, it is offered neither 📝 nor 🖥 — the server would refuse both.
    const sidIn = await signin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sid', password: 'cable ties and gaffer' }) }).then((r) => r.status)`);
    // Sid reads one hall, and as its crew answers the help of Press, a room of it Sid is not given, from the halls page
    // alone: a reason to stay there, so Sid is not taken straight into the hall (the page goes live only once it stays).
    const sidBoard = await edge.tab(`${base}/halls.html`);
    const sidStays = await sidBoard.until(`location.pathname === '/halls.html' && document.getElementById('linkState').dataset.ok === '1' && JSON.stringify({ at: location.pathname + location.search, rows: document.querySelectorAll('.hall-row').length })`, 10000);
    report(sidStays === JSON.stringify({ at: '/halls.html', rows: 1 }), `an account with one room that answers help from the halls page alone (a side room of its hall it is not given) stays there (${sidStays})`);
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
    // One listener for each row of the table (lib/ops.js's, which the page's is held to): the generated ones, and no
    // hand-written one beside them.
    const listeners = await board.eval(`JSON.stringify(Object.keys(UPD_EVENTS).map((f) => socket.listeners(UPD_EVENTS[f][0]).length))`);
    report(proposed.ok && bothPending && forgot && !!atDesk && live === JSON.stringify({ on: 'rejected ✕ Not approved by Smoke desk', own: 'rejected ✕ Not approved by Smoke desk' }) && resumed === live && listeners === JSON.stringify(Object.keys(ops.UPD_EVENTS).map(() => 1)),
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
      report(announced === JSON.stringify(['Rae joined Backstage', 0]), `the restart announces nobody: the page is announced once, at its first join, and a stop that saved writes no restart line (${announced})`);
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
      const ENV5 = {
        AGM_TUNNEL_MAX: '2', AGM_TUNNEL_JOIN_MS: '600000',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), AGM_TEST_TUNNEL: 'http://127.0.0.1:' + link5.address().port,
      };
      server5 = await startServer(port5, dataDir5, ENV5);
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

      const card = await edge.tab(`${base5}/admin.html`, { timezone: 'America/New_York' });   // an admin page set to another zone than the laptop's
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

      // While it runs the card says its end, the end of the show day by the laptop's clock (the server's words, though this
      // page is set to another zone), and Tunnel until… (from the card's ⋯) asks for a time of day filled with that end, by
      // the laptop's clock: confirmed as filled, the end stays; given another time, it moves there. Then AGMessage stops and
      // starts again inside that end: the link is on again, at the same end, and the card says its address is new.
      const laptopHM = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: SERVER_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
      const wallMin = (t) => { const [h, m] = laptopHM(t).split(':').map(Number); return h * 60 + m; };
      /** A time about `hours` from now by the laptop's clock, on a wall minute no change of its clocks repeats, never `avoid`: {hm, at}. */
      const laptopTimeAbout = (hours, avoid) => {
        const now = Date.now();
        for (let h = hours; h < hours + 4; h++) {
          const at = new Date(now + h * 3600000).setSeconds(0, 0);
          if (at !== avoid && (wallMin(at) - wallMin(at - 3600000) + 1440) % 1440 === 60 && (wallMin(at + 3600000) - wallMin(at) + 1440) % 1440 === 60) return { hm: laptopHM(at), at };
        }
        return { hm: '', at: null };
      };
      const healthUntil = async () => (await (await fetch(base5 + '/api/health')).json()).tunnel.until;
      const firstEnd = await healthUntil();
      const endWords = await card.until(`(() => { const l = document.getElementById('tunnelUntilLine'); return !l.hidden && l.textContent; })()`, 5000);
      const firstUrl = await card.eval(`document.getElementById('tunnelUrl').textContent`);
      const askUntil = async () => {
        await card.eval(`document.querySelector('#tunnelActs .obj-more').click()`);
        await card.until(`!!document.querySelector('.agm-menu [data-action="tunnel.until"]')`, 3000);
        await card.eval(`document.querySelector('.agm-menu [data-action="tunnel.until"]').click()`);
        return card.until(`(() => { const a = document.querySelector('.agm-ask'); const i = a && a.querySelector('input[name="until"]');
          return !!i && JSON.stringify({ title: a.querySelector('.agm-ask-title').textContent, type: i.type, value: i.value, focused: document.activeElement === i }); })()`, 3000);
      };
      const untilAsk = await askUntil();
      await card.eval(`document.querySelector('.agm-ask [data-answer=yes]').click()`);
      const keptSaid = await card.until(`(() => { const t = document.getElementById('agmToast'); return !!t && t.classList.contains('show') && t.textContent.startsWith('The internet link stays on until') && t.textContent; })()`, 5000);
      const unchanged = await healthUntil();
      const two = laptopTimeAbout(2, firstEnd);
      await askUntil();
      await card.eval(`(() => { const i = document.querySelector('.agm-ask input[name="until"]'); i.value = ${JSON.stringify(two.hm)}; document.querySelector('.agm-ask [data-answer=yes]').click(); })()`);
      const movedEnd = await card.until(`(() => { const l = document.getElementById('tunnelUntilLine').textContent; return l.startsWith('On until ' + ${JSON.stringify(two.hm)} + ' ') && l; })()`, 5000);
      const endAt = two.at;
      const keptUntil = await healthUntil();
      report(laptopHM(firstEnd) === '06:00' && new RegExp('^On until 06:00 (today|tomorrow), then off and it stays off\\. If AGMessage starts again before then, the link is turned on again, with a new address\\.$').test(endWords || '')
        && untilAsk === JSON.stringify({ title: 'Keep the internet link on until…', type: 'time', value: '06:00', focused: true }) && unchanged === firstEnd && !!keptSaid
        && !!two.hm && !!movedEnd && keptUntil === endAt,
        `an admin page set to another zone says the link's end by the laptop's clock ("${endWords}"); Tunnel until… asks with that end (${untilAsk}), confirmed as filled keeps it ("${keptSaid}"; health: ${unchanged === firstEnd ? 'the same end' : unchanged}), and moves it to ${two.hm}: "${movedEnd}" (health: ${keptUntil === endAt ? 'that end' : keptUntil})`);
      await stopServer(server5);
      server5 = await startServer(port5, dataDir5, ENV5);
      const again = await card.until(`(() => { const a = document.getElementById('tunnelAgain'); const u = document.getElementById('tunnelUrl').textContent;
        return !a.hidden && /^https:\\/\\/agm-test-link-\\d+\\.trycloudflare\\.com$/.test(u) && u !== ${JSON.stringify(firstUrl)} && document.getElementById('tunnelUntilLine').textContent === ${JSON.stringify(movedEnd)}
          && document.getElementById('tunnelToggle').checked && a.textContent + ' | ' + u; })()`, 30000);
      const againHealth = (await (await fetch(base5 + '/api/health')).json()).tunnel.until;
      report(/^△ New address: AGMessage started again at .+ and turned the internet link on again\. Send this address to remote people; the one before no longer works\. \| https:/.test(again || '') && againHealth === endAt,
        `AGMessage started again inside the link's end: the link is on again until the same end, and the card says "${again}"`);
      await card.eval(`document.getElementById('tunnelSection').scrollIntoView({ block: 'start' })`);
      await card.shot(path.join(OUT, 'tunnel-again.png'));   // the new address, said
      const cardProblems = card.problems.filter((p) => !/WebSocket connection to|ERR_CONNECTION_REFUSED|net::ERR_/.test(p));
      report(cardProblems.length === 0, `the admin page's tunnel card: no script errors or CSP violations, the stopped server's refused connections aside${cardProblems.length ? ' — ' + cardProblems.slice(0, 3).join(' | ') : ''}`);
      card.close();
      tia.close();
      taken.forEach((s) => s.close());
    }

    // A page on another build reloads itself at a quiet moment (reconnect.js), each from what the server serves now: a
    // hall page and a halls board told another build hold while something is written and unsent, then reload untouched;
    // the admin page says so and reloads when its admin presses Reload this page; a screen keeps its take and reloads at
    // the next, which the page it loads draws. Each page names the build /build.js says, as health says it.
    {
      const serverBuild = (await (await fetch(base + '/api/health')).json()).build;
      const OTHER = '0.6.0-dev.99+abcdef1';
      const STATE = `JSON.stringify({ before: window.__before === 1, reloadedFor: sessionStorage.getItem('agm.reloadedFor'), ...AGM.reconnect.build.state() })`;
      // This browser signed in as Ana Admin again (the run signed it in and out as others since): her hall page, the
      // halls board and the admin page. The first admin page's socket makes and takes the screen.
      await admin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana', password: 'the green room kettle' }) }).then((r) => r.status)`);
      const hall = await edge.tab(`${base}/app.html?code=${code}&as=account&role=research`);
      const board = await edge.tab(`${base}/halls.html`);
      const adminB = await edge.tab(`${base}/admin.html`);
      const madeB = await admin.eval(`new Promise((r) => socket.emit('display:create', { code: '${code}', name: 'Side screen' }, r))`);
      const side = await edge.tab(`${base}${madeB.display.path}`);
      await hall.until('typeof joined !== "undefined" && joined');
      await board.until(`document.getElementById('linkState').dataset.ok === '1'`);
      await adminB.until(`!document.getElementById('dashboard').hidden && document.getElementById('buildLine').textContent.length > 0`);
      await side.until(`document.body.dataset.kind === 'holding'`);
      const named = await Promise.all([hall, board, adminB, side].map((t) => t.eval(`AGM.build === ${JSON.stringify(serverBuild)} && !AGM.reconnect.build.state().stale`)));
      // Told another build: the hall page holds while its composer has words; the board while an answer is held (an
      // open dialog, here); the admin page says so; the screen has heard nothing new until its next take.
      await hall.eval(`(() => { window.__before = 1; document.getElementById('textInput').value = 'not sent yet'; AGM.reconnect.build.heard(${JSON.stringify(OTHER)}); })()`);
      await board.eval(`(() => { window.__before = 1; AGM.openDialog(document.getElementById('passwordDialog')); AGM.reconnect.build.heard(${JSON.stringify(OTHER)}); })()`);
      await adminB.eval(`(() => { window.__before = 1; window.AGM.build = ${JSON.stringify(OTHER)}; })()`);
      await side.eval(`(() => { window.__before = 1; window.AGM.build = ${JSON.stringify(OTHER)}; })()`);
      const strip = await adminB.until(`!document.getElementById('buildStrip').hidden && document.getElementById('buildWords').textContent`, 8000);
      await sleep(8000);   // past the 5 s untouched and a check after it
      const held = await Promise.all([hall, board, adminB, side].map((t) => t.eval(STATE)));
      await hall.eval(`document.getElementById('textInput').value = ''`);
      await board.eval(`document.getElementById('passwordDialog').close()`);
      await adminB.eval(`document.getElementById('buildReload').click()`);
      await admin.eval(`new Promise((r) => socket.emit('display:take', { id: '${madeB.display.id}', content: { kind: 'message', text: 'Doors in five', tone: 'info' } }, r))`);
      const back = await Promise.all([hall, board, adminB].map((t) => t.until(`window.__before === undefined && typeof AGM !== 'undefined' && AGM.reconnect && AGM.reconnect.build.state().server === ${JSON.stringify(serverBuild)} && ${STATE}`, 20000)));
      const drawn = await side.until(`window.__before === undefined && document.body.dataset.kind === 'message' && document.getElementById('messageText').textContent.includes('Doors in five') && ${STATE}`, 20000);
      const confirmed = await admin.until(`new Promise((r) => socket.emit('display:list', { code: '${code}' }, (x) => r(!!x && Array.isArray(x.displays) && x.displays.some((d) => d.name === 'Side screen' && d.state === 'shown'))))`, 10000);
      const heldOk = held.map((h) => JSON.parse(h || '{}'));
      const backOk = back.map((b) => JSON.parse(b || '{}'));
      const drawnOk = JSON.parse(drawn || '{}');
      report(named.every((x) => x === true), `each page names the build that serves it (/build.js, ${serverBuild}) and is on it: hall page, halls board, admin page, screen (${JSON.stringify(named)})`);
      report(heldOk.every((h) => h.before && h.stale && !h.reloading) && strip === 'AGMessage now runs ' + serverBuild + ', and this page is still on ' + OTHER + '. Reload it when nothing you are typing here would be lost.',
        `told another build, nothing reloads while it is not quiet: the hall page with words in its composer, the board with a dialog open, the admin page until its admin agrees ("${strip}"), the screen until its next take (${held.join(' | ')})`);
      report(backOk.every((b) => !b.before && !b.stale && b.mine === serverBuild) && backOk[0].reloadedFor === OTHER && backOk[1].reloadedFor === OTHER && backOk[2].reloadedFor === serverBuild
        && !drawnOk.before && drawnOk.reloadedFor === serverBuild && drawnOk.mine === serverBuild && !!confirmed,
        `once quiet, each reloaded once onto the build that serves (the hall page and the board as their composer emptied and their dialog closed, the admin page at Reload this page) and the screen at its next take, which the page it loaded drew and confirmed (${back.join(' | ')} | ${drawn})`);
      for (const [name, t] of [['the hall page reloaded for a build', hall], ['the halls board reloaded for a build', board], ['the admin page reloaded for a build', adminB], ['the screen reloaded for a build', side]]) {
        const p = t.problems.filter((x) => !/WebSocket connection to|ERR_CONNECTION_REFUSED|net::ERR_ABORTED/.test(x));
        report(p.length === 0, `${name}: no script errors or CSP violations${p.length ? ' — ' + p.slice(0, 3).join(' | ') : ''}`);
        t.close();
      }
    }

    // ---------------- The Board's chat view (unit 20a): the simple view on the device legs, the layout leg and the floor leg ----------------
    // A hall of its own: Ana backstage (from here), three plain notes, a question and a 🔥 one; then a Board page per leg,
    // each a device of its own (`alone`: fresh storage, so nothing chosen), with touch and a mobile viewport at the stage
    // addendum's three sizes, both themes at 1180×820 and 390×844 and dark at 820×1180, and a Board account's page.
    {
      const bvHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Board hall' }) })).json()).code;
      const bvAdmin = await connect(base, cookie);
      const ana = await connect(base);
      const anaJoin = await emit(ana, 'join', { roomCode: bvHall, name: 'Ana Ribeiro', role: 'research' });
      const say = async (args) => { for (let i = 0; i < 60; i++) { const r = await emit(ana, 'message', args); if (r && r.ok) return r; await sleep(250); } return null; };
      for (const text of ['Slides 3 to 6 are loaded for the resolutions.', 'Could you confirm the proxy count before the vote?']) await say({ type: 'text', text });
      const asked = await say({ type: 'action', text: 'Ready to take questions from the floor?', options: ['Yes', 'No', 'In 5 min'] });
      await say({ type: 'text', text: 'Wrap up resolution 3 now, please.', priority: true });
      await say({ type: 'text', text: 'Tom has the roving mic.' });
      const ready = `typeof joined !== 'undefined' && joined && allMessages.some((m) => m.text === 'Tom has the roving mic.')`;
      // What a Board page draws, read as a person sees it: the view and theme; the header's controls; each response's
      // buttons; a question's; the composer's; what is never drawn there; the body's size; each response after its words;
      // a 44 px band through each control's centre hitting it; the placeholder in its field; no sideways scroll; the column
      // or the tabs; and the ink of the body, a name, a time, the cue words and a response at 4.5:1 or more.
      const BV_READ = `(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const msgs = [...feed.querySelectorAll(':scope > .msg[data-id]')];
        const byText = (t) => msgs.find((n) => (findMessage(n.dataset.id) || {}).text === t);
        const ctrls = (el) => (el ? [...el.querySelectorAll('button, input, a[href], select, textarea')].filter(vis) : []);
        const resp = (t) => { const n = byText(t); return n ? ctrls(n.querySelector(':scope > .msg-response')).map((b) => b.dataset.action + ':' + b.textContent.trim()) : null; };
        const q = byText('Ready to take questions from the floor?');
        const NEVER = ['compose.attach', 'compose.draft', 'msg.react', 'msg.send', 'compose.sendTo', 'msg.sendBack', 'msg.pin', 'msg.delete', 'msg.screens', 'msg.sendNow', 'msg.speaker', 'msg.helpRespond'];
        const never = NEVER.filter((a) => [...document.querySelectorAll('[data-action="' + a + '"]')].some(vis))
          .concat(['#researchCompose', '#composeTo', '#peoplePanel', '#roomSwitcher', '#aiDraftBtn', '.obj-more', '.msg .reactions', '.sys.presence'].filter((sel) => [...document.querySelectorAll(sel)].some(vis)));
        const field = document.getElementById('directorInput'); const cs = getComputedStyle(field);
        const ruler = document.createElement('span'); ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ');
        ruler.textContent = field.placeholder; document.body.appendChild(ruler);
        const room = field.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const fits = ruler.getBoundingClientRect().width <= room; ruler.textContent = 'Message everyone here…';
        const longFits = ruler.getBoundingClientRect().width <= room; ruler.remove();
        const banded = [...document.querySelectorAll('.app-meta button, .msg-response button, .action-btn, .answer-words-btn, #directorForm button, #directorForm input, .bv-tab, .bv-strip button, #bvSheet button')].filter(vis);
        const missed = banded.filter((b) => { const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const fr = feed.getBoundingClientRect();
          if (cy - 22 < 0 || cy + 22 > innerHeight || (feed.contains(b) && (cy - 22 < fr.top || cy + 22 > fr.bottom))) return false;
          return ![cy - 21, cy + 21].every((y) => { const e = document.elementFromPoint(cx, y); return !!e && (e === b || b.contains(e)); }); }).map((b) => b.dataset.action || b.id || b.textContent.trim());
        const hot = byText('Wrap up resolution 3 now, please.');
        const ink = [hot.querySelector('.body p'), hot.querySelector('.from'), hot.querySelector('time'), hot.querySelector('.priority-badge'), q && q.querySelector('.ask-word'), hot.querySelector('.msg-response .msg-act')].filter(Boolean).map((el) => +__ink(el).ratio.toFixed(2));
        return JSON.stringify({ view: document.body.dataset.view, theme: document.documentElement.dataset.theme,
          header: ctrls(document.querySelector('.app-meta')).map((b) => b.id), newest: resp('Tom has the roving mic.'), older: resp('Could you confirm the proxy count before the vote?'), hot: resp('Wrap up resolution 3 now, please.'),
          question: q ? ctrls(q).map((b) => b.dataset.action) : null, composer: ctrls(document.getElementById('directorCompose')).map((b) => b.id || b.dataset.action || b.className),
          never, body: parseFloat(getComputedStyle(byText('Tom has the roving mic.').querySelector('.body p')).fontSize) / (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom-msg')) || 1),
          order: msgs.every((n) => { const r = n.querySelector(':scope > .msg-response'); return !r || !r.childElementCount || !!(n.querySelector(':scope > .body').compareDocumentPosition(r) & 4); }),
          missed, placeholder: field.placeholder, label: field.getAttribute('aria-label'), fits, longFits, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          column: vis(document.getElementById('docPanel')) && !vis(document.getElementById('bvTabs')), tabs: vis(document.getElementById('bvTabs')), ink, feedHeight: Math.round(feed.getBoundingClientRect().height) }); })()`;
      const bvRead = async (tab) => JSON.parse(await tab.eval(BV_READ) || 'null');
      const LIGHT = `(() => { try { localStorage.setItem('agm.theme', 'light'); } catch { /* none */ } })();`;
      const bvLegs = {};
      const bvTabs = [];
      for (const [w, h, theme] of [[1180, 820, 'light'], [1180, 820, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [820, 1180, 'dark']]) {
        const tab = await edge.tab(`${base}/app.html?code=${bvHall}&name=${encodeURIComponent('Margaret ' + w + theme)}&role=board&invite=${inviteOf(dataDir, bvHall)}`, { init: INK + (theme === 'light' ? LIGHT : ''), metrics: { width: w, height: h, phone: true }, alone: true });
        bvTabs.push(tab);
        await tab.until(ready, 10000);
        await tab.until(`document.fonts.status === 'loaded'`, 5000);
        bvLegs[w + 'x' + h + ' ' + theme] = await bvRead(tab);
        await tab.shot(path.join(OUT, `board-chat-${w}x${h}-${theme}.png`));
      }
      const legOk = (r, w, h, theme) => !!r && r.view === 'simple' && r.theme === theme && JSON.stringify(r.header) === JSON.stringify(['helpBtn', 'headerMore'])
        && JSON.stringify(r.newest) === JSON.stringify(['msg.ack:👍Got all 3', 'msg.reply:↩Reply']) && JSON.stringify(r.older) === '[]'
        && JSON.stringify(r.hot) === JSON.stringify(['msg.ack:👍Got it', 'msg.reply:↩Reply']) && JSON.stringify(r.question) === JSON.stringify(['msg.answer', 'msg.answer', 'msg.answer', 'msg.answerWords'])
        && JSON.stringify(r.composer) === JSON.stringify(['dirPriorityBtn', 'directorInput', 'compose.send']) && r.never.length === 0
        && r.body === (Math.min(w, h) >= 600 ? 22 : 20) && r.order && r.missed.length === 0 && r.fits && r.label === 'Message everyone here…' && r.scroll && r.ink.length === 6 && r.ink.every((x) => x >= 4.5);
      // Nothing shown yet: at 1180 px wide Shown to you is its 36 px rail, which says what it is; at 390 px it is not drawn.
      const RAIL = `JSON.stringify({ width: Math.round(document.getElementById('docPanel').getBoundingClientRect().width), words: getComputedStyle(document.getElementById('docPanel'), '::before').content })`;
      const railWide = JSON.parse(await bvTabs[0].eval(RAIL));
      const railPhone = JSON.parse(await bvTabs[2].eval(RAIL));
      report(railWide.width === 36 && railWide.words === '"📺 Shown to you"' && railPhone.width === 0,
        `with nothing shown, Shown to you is its rail at 900 px wide or more (${JSON.stringify(railWide)}) and is not drawn on a phone (${JSON.stringify(railPhone)})`);
      // Down 5 s or more: "Offline · reconnecting" is the phone's second header row, under the name, Help and ⋯; on a
      // tablet it sits before Help on its one row. Back, the phone's header is one row again.
      const DOWN = (dot) => `(() => { drawConnection({ back: ${!dot}, connected: false, dot: ${dot}, stopped: false }); const w = document.getElementById('connWords'), h = document.getElementById('helpBtn'), m = document.getElementById('headerMore'), t = document.querySelector('.app-title');
        const wr = w.getBoundingClientRect(), hr = h.getBoundingClientRect(), mr = m.getBoundingClientRect(), tr = t.getBoundingClientRect();
        return JSON.stringify({ words: w.hidden ? '' : w.textContent, below: !w.hidden && wr.top >= Math.max(hr.bottom, tr.bottom) - 1, before: !w.hidden && wr.right <= hr.left + 1 && Math.abs((wr.top + wr.bottom) / 2 - (hr.top + hr.bottom) / 2) < hr.height / 2,
          oneRow: Math.abs(hr.top - mr.top) < 2 && Math.abs((tr.top + tr.bottom) / 2 - (hr.top + hr.bottom) / 2) < hr.height / 2, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth }); })()`;
      const downPhone = JSON.parse(await bvTabs[2].eval(DOWN(true)));
      const backPhone = JSON.parse(await bvTabs[2].eval(DOWN(false)));
      const downTablet = JSON.parse(await bvTabs[0].eval(DOWN(true)));
      await bvTabs[0].eval(DOWN(false));
      report(downPhone.words === 'Offline · reconnecting' && downPhone.below && downPhone.oneRow && downPhone.scroll && backPhone.words === '' && backPhone.oneRow
        && downTablet.words === 'Offline · reconnecting' && downTablet.before && !downTablet.below && downTablet.oneRow,
        `down 5 s, "Offline · reconnecting" is the phone's second header row (the name, Help and ⋯ on the first) and sits before Help on a tablet's one row (${JSON.stringify({ downPhone, backPhone, downTablet })})`);
      report(Object.entries(bvLegs).every(([k, r]) => { const [wh, theme] = k.split(' '); const [w, h] = wh.split('x').map(Number); return legOk(r, w, h, theme); }),
        `the Board's chat view on the device legs (1180×820 and 390×844 in both themes, 820×1180 in dark; touch, a mobile viewport): dark until chosen, the header Help and ⋯ alone, 👍 Got all 3 and ↩ Reply after the newest plain message's words and none on an older one, Got it and Reply on the 🔥 one, a question's three answers and Answer in words…, the composer 🔥 Priority, the field and Send, nothing of the backstage team's (no 📎 ✨ ❓ 😊 ↗ To: ↩ Send back 📌 🗑 ⧉ 🖥 📝, no ⋯ on a message, no reactions or presence lines), 22 px text on a tablet and 20 px on a phone, each response after its words, a 44 px band through each control hitting it, the placeholder whole in its field, no sideways scroll, and the body, a name, a time, the cue words and a response at 4.5:1 or more (${JSON.stringify(bvLegs)})`);
      // At 820×1180 a file shown to the Board (a document arriving in the side bar: a file shared in the chat opens nothing
      // of itself) brings the tabs, and no side column.
      const up = await (async () => { const f = new FormData(); f.append('file', new Blob([tinyPdf()], { type: 'application/pdf' }), 'proxies.pdf'); return (await fetch(base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': anaJoin.uploadToken }, body: f })).json(); })();
      const filed = await say({ type: 'file', url: up.url, filename: 'proxies.pdf', mime: 'application/pdf' });
      const upright = bvTabs[4];
      await upright.until(`allMessages.some((m) => m.type === 'file')`, 10000);
      const filedPlain = await upright.eval(`document.body.dataset.shown`);
      const sideDoc = await emit(bvAdmin, 'page:push', { code: bvHall, to: 'board', content: { kind: 'doc', url: up.url }, arrive: 'side' });
      const uprightShown = JSON.parse(await upright.until(`document.body.dataset.shown === '1' && JSON.stringify({ tabs: !document.getElementById('bvTabs').hidden && getComputedStyle(document.getElementById('bvTabs')).display !== 'none',
        pressed: [...document.querySelectorAll('#bvTabs button')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')), side: document.getElementById('docPanel').getClientRects().length > 0 })`, 10000) || 'null');
      await upright.eval(`document.getElementById('tabShown').click()`);
      const uprightTab = JSON.parse(await upright.until(`document.body.dataset.tab === 'shown' && JSON.stringify({ chat: document.getElementById('leftCol').getClientRects().length > 0, panel: document.getElementById('docPanel').getClientRects().length > 0, head: document.querySelector('.doc-panel-header strong').textContent })`, 5000) || 'null');
      await upright.eval(`document.getElementById('tabChat').click()`);
      // Withdrawn, it leaves every Board page: the steps below start from nothing shown.
      const sideGone = sideDoc && sideDoc.ok ? await emit(bvAdmin, 'page:withdraw', { code: bvHall, seq: sideDoc.seq }) : null;
      const uprightAfter = await upright.until(`document.body.dataset.shown === '0' && 'none'`, 5000);
      report(!!filed && filedPlain === '0' && !!sideGone && sideGone.ok && uprightAfter === 'none' && !!sideDoc && sideDoc.ok && sideDoc.arrive === 'side' && JSON.stringify(uprightShown) === JSON.stringify({ tabs: true, pressed: ['Chat:true', '📺 Shown to you · 1:false'], side: false }) && JSON.stringify(uprightTab) === JSON.stringify({ chat: false, panel: true, head: '📺 Shown to you' }),
        `at 820×1180 (a tablet upright) a file shared in the chat shows nothing, and what is shown is a tab, not a column: Chat and 📺 Shown to you · 1, two pressed buttons, the second showing the panel in the chat's place (${JSON.stringify({ filedPlain, sideDoc: sideDoc && (sideDoc.ok ? sideDoc.arrive : sideDoc.error), uprightShown, uprightTab })})`);

      // A Board account (a Tech given Board hall's On stage seat), on a device of its own at 1180×820: the same view. It is
      // made by the admin account (the laptop's token makes none), signed in as every sign-in from this address is, a
      // turn away waiting its turn.
      const signInAs = async (username, password) => { for (let i = 0; i < 6; i++) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }); if (r.status !== 429) return r; await sleep(2100); } return null; };
      let anaIn = await signInAs('ana', 'the green room kettle');
      if (!anaIn || anaIn.status !== 200) {
        await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' }) });
        anaIn = await signInAs('ana', 'the green room kettle');
      }
      const anaCookie = anaIn && anaIn.status === 200 ? anaIn.headers.get('set-cookie').split(';')[0] : '';
      const boardAcct = await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie: anaCookie }, body: JSON.stringify({ username: 'meg', name: 'Meg Board', role: 'tech', halls: [bvHall], board: [bvHall], password: 'lectern and water glass' }) });
      const megTab = await edge.tab(`${base}/build.js`, { metrics: { width: 1180, height: 820, phone: true }, init: INK, alone: true });
      await megTab.until(`document.readyState === 'complete'`);
      const megIn = await megTab.eval(`(async () => { for (let i = 0; i < 5; i++) { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'meg', password: 'lectern and water glass' }) }); if (r.status !== 429) return r.status; await new Promise((ok) => setTimeout(ok, 2100)); } return 429; })()`);
      await megTab.send('Page.navigate', { url: `${base}/app.html?code=${bvHall}&as=account&role=board` });
      await megTab.until(ready, 10000);
      const megRead = await bvRead(megTab);
      report(boardAcct.status === 200 && megIn === 200 && !!megRead && megRead.view === 'simple' && megRead.theme === 'dark' && JSON.stringify(megRead.header) === JSON.stringify(['helpBtn', 'headerMore'])
        && JSON.stringify(megRead.composer) === JSON.stringify(['dirPriorityBtn', 'directorInput', 'compose.send']) && megRead.never.length === 0 && megRead.missed.length === 0 && megRead.body === 22,
        `a Board account's page is the Board's chat view too: dark, Help and ⋯, the composer of three, nothing of the backstage team's (${JSON.stringify(megRead)})`);

      // The behaviour, on Margaret's tablet (1180×820, dark) with Rob's backstage page beside it.
      const meg = bvTabs[1];
      const rob = await edge.tab(`${base}/app.html?code=${bvHall}&name=Rob&role=research`, { alone: true });
      await rob.until(ready, 10000);
      // Only Tab, Enter and Escape act: R on a message begins no reply; a right-click opens no menu of AGMessage's.
      await meg.eval(`(() => { const n = [...feed.querySelectorAll('.msg[data-id]')].find((x) => (findMessage(x.dataset.id) || {}).text === 'Tom has the roving mic.'); n.focus(); return true; })()`);
      await press(meg, 'R');
      const noKey = await meg.eval(`!document.getElementById('replyChip') && !AGM.menu.isOpen()`);
      const bodyAt = await meg.eval(`(() => { const n = [...feed.querySelectorAll('.msg[data-id]')].find((x) => (findMessage(x.dataset.id) || {}).text === 'Tom has the roving mic.'); const r = n.querySelector('.body p').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
      await rightClick(meg, bodyAt);
      const noMenu = await meg.eval(`!AGM.menu.isOpen() && !document.querySelector('.agm-menu')`);
      // The second door: a tap on an older waiting message brings its own Got it (never Got all), Reply and 📌 Pin for me.
      await tapAt(meg, `#feed .msg[data-id="${(await meg.eval(`allMessages.find((m) => m.text === 'Slides 3 to 6 are loaded for the resolutions.').id`))}"] .body p`);
      const second = await meg.until(`(() => { const m = allMessages.find((x) => x.text === 'Slides 3 to 6 are loaded for the resolutions.'); const b = [...messagesById.get(m.id).querySelectorAll('.msg-response button')]; return b.length ? JSON.stringify(b.map((x) => x.textContent.trim())) : null; })()`, 5000);
      // Reply quotes it, the composer focused; Escape takes the reply back.
      await meg.eval(`[...messagesById.get(allMessages.find((m) => m.priority).id).querySelectorAll('.msg-response button')].find((b) => b.dataset.action === 'msg.reply').click()`);
      const replying = await meg.until(`(() => { const c = document.getElementById('replyChip'); return c && document.activeElement === document.getElementById('directorInput') && c.textContent; })()`, 3000);
      await press(meg, 'Escape');
      const unreplied = await meg.until(`!document.getElementById('replyChip') && 'gone'`, 3000);
      report(noKey && noMenu && second === JSON.stringify(['👍Got it', '↩Reply', '📌Pin for me']) && /Replying to Ana Ribeiro/.test(replying || '') && unreplied === 'gone',
        `the simple view acts on Tab, Enter and Escape alone (R begins nothing, a right-click opens no menu of AGMessage's); a tap on an older waiting message brings its own 👍 Got it, ↩ Reply and 📌 Pin for me; Reply quotes, Escape takes it back (${JSON.stringify({ noKey, noMenu, second, replying })})`);
      // Got all 4 on the newest plain message waiting (the file shown since): four 👍, one per waiting plain message, each
      // then "👍 You: got it"; backstage reads "👍 Margaret … got it".
      const gotLabel = await meg.eval(`(() => { const b = [...messagesById.get(allMessages.find((m) => m.type === 'file').id).querySelectorAll('.msg-response button')].find((x) => x.dataset.action === 'msg.ack'); const t = b.textContent.trim(); b.click(); return t; })()`);
      const gotAll = await meg.until(`(() => { const plain = allMessages.filter((m) => (m.type === 'text' || m.type === 'file') && !m.priority && m.from && m.from.role === 'research');
        const mine = plain.filter((m) => (m.reactions || []).some((r) => r.uid === MY_UID && r.emoji === '👍' && r.role === 'board'));
        return mine.length === 4 && plain.every((m) => messagesById.get(m.id).querySelector('.bv-said').textContent === '👍 You: got it') && JSON.stringify({ reacted: mine.length, buttons: plain.map((m) => messagesById.get(m.id).querySelectorAll('.msg-response button').length) }); })()`, 8000);
      const robSaw = await rob.until(`(() => { const m = allMessages.find((x) => x.text === 'Tom has the roving mic.'); const l = m && messagesById.get(m.id).querySelector('.got-line'); return l && /^👍 Margaret 1180dark got it$/.test(l.textContent) && l.textContent; })()`, 8000);
      report(gotLabel === '👍Got all 4' && !!gotAll && !!robSaw, `👍 Got all 4 answers each plain message waiting, one 👍 each, held together in the outbox, each then "👍 You: got it"; the backstage page reads "${robSaw}" (${gotLabel}; ${gotAll})`);
      // Answer in words: an ask in place with a field of 200 characters (no prompt()), the answer stored at most 200; then
      // "You answered: “…” · Change".
      await meg.eval(`messagesById.get('${asked.id}').querySelector('.answer-words-btn').click()`);
      const askField = await meg.until(`(() => { const a = document.querySelector('.agm-ask'); const i = a && a.querySelector('input'); return i && JSON.stringify({ max: i.maxLength, label: i.getAttribute('aria-label') || (i.labels && i.labels[0] && i.labels[0].textContent) || '' }); })()`, 3000);
      await meg.eval(`(() => { const i = document.querySelector('.agm-ask input'); i.value = 'Yes, after the vote on resolution 3. ' + 'x'.repeat(240); i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.agm-ask button')].find((b) => b.textContent === 'Send answer').click(); return true; })()`);
      const answered = await meg.until(`(() => { const m = findMessage('${asked.id}'); const r = (m.responses || []).find((x) => x.uid === MY_UID); const line = messagesById.get(m.id).querySelector('.bv-answered');
        return r && line && JSON.stringify({ note: r.note.length, line: /^You answered: “Yes, after the vote/.test(line.textContent) && /· Change$/.test(line.textContent), answers: messagesById.get(m.id).querySelectorAll('.action-btn').length }); })()`, 8000);
      report(!!askField && JSON.parse(askField).max === 200 && JSON.stringify(JSON.parse(answered || 'null')) === JSON.stringify({ note: 200, line: true, answers: 0 }) && !meg.problems.some((p) => /native/.test(p)),
        `Answer in words… opens one field in place, 200 characters (${askField}), never a prompt(); the answer is stored at 200 and the question then reads "You answered: “…” · Change", its answers gone (${answered})`);
      // Change brings the answers back, the first focused and the answer given said under them (no Change while choosing);
      // another's answer meanwhile leaves the answers and the focus where they are; a new answer replaces the person's own.
      await meg.eval(`messagesById.get('${asked.id}').querySelector('[data-action="msg.change"]').click()`);
      const changing = await meg.until(`(() => { const n = messagesById.get('${asked.id}'); const b = [...n.querySelectorAll('.action-btn')]; return b.length === 3 && document.activeElement === b[0]
        && JSON.stringify({ pressed: b.map((x) => x.getAttribute('aria-pressed')), line: (n.querySelector('.bv-answered') || {}).textContent || '' }); })()`, 3000);
      const othersAnswer = await emit(ana, 'actionResponse', { messageId: asked.id, optionIndex: 1 });
      await meg.until(`(findMessage('${asked.id}').responses || []).some((r) => r.name === 'Ana Ribeiro') && 'heard'`, 5000);
      const keptChoosing = await meg.eval(`(() => { const n = messagesById.get('${asked.id}'); const b = [...n.querySelectorAll('.action-btn')]; return JSON.stringify({ answers: b.length, focus: document.activeElement === b[0], changing: F.changing === '${asked.id}' }); })()`);
      await meg.eval(`messagesById.get('${asked.id}').querySelector('.action-btn[data-value="0"]').click()`);
      const changedTo = await meg.until(`(() => { const n = messagesById.get('${asked.id}'); const l = n.querySelector('.bv-answered'); const r = (findMessage('${asked.id}').responses || []).find((x) => x.uid === MY_UID);
        return l && r && r.optionIndex === 0 && /^You answered Yes · .+ · Change$/.test(l.textContent) && n.querySelectorAll('.action-btn').length === 0 && !F.changing && l.textContent; })()`, 5000);
      const choosing = JSON.parse(changing || 'null');
      report(!!choosing && JSON.stringify(choosing.pressed) === JSON.stringify(['false', 'false', 'false']) && /^You answered: “Yes, after the vote/.test(choosing.line) && !/Change$/.test(choosing.line)
        && !!othersAnswer && othersAnswer.ok && keptChoosing === JSON.stringify({ answers: 3, focus: true, changing: true }) && !!changedTo,
        `Change brings the answers back with the answer given under them, and another's answer meanwhile leaves them and the focus in place; a new answer then reads "${changedTo}" (${JSON.stringify({ changing, keptChoosing })})`);
      // 🔥 Priority: pressed, then a send carries priority and the toggle is off again; a refused send keeps its words and
      // says the server's.
      await meg.eval(`(() => { document.getElementById('dirPriorityBtn').click(); return true; })()`);
      const pressed = await meg.eval(`document.getElementById('dirPriorityBtn').getAttribute('aria-pressed')`);
      await meg.eval(`(() => { const i = document.getElementById('directorInput'); i.value = 'Five more minutes on resolution 3.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#directorForm .send-btn').click(); return true; })()`);
      const sentHot = await meg.until(`allMessages.some((m) => m.text === 'Five more minutes on resolution 3.' && m.priority === true && m.from.uid === MY_UID) && document.getElementById('dirPriorityBtn').getAttribute('aria-pressed') === 'false' && document.getElementById('directorInput').value === '' && 'sent'`, 8000);
      await meg.eval(`(() => { const e = socket.emit; socket.emit = function (ev, p, ...rest) { if (ev === 'message' && !window.__refusedOnce) { window.__refusedOnce = true; p = { ...p, heldMs: -1 }; } return e.call(this, ev, p, ...rest); };
        const i = document.getElementById('directorInput'); i.value = 'This one is refused.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#directorForm .send-btn').click(); return true; })()`);
      const refusedKept = await meg.until(`(() => { const echo = [...feed.querySelectorAll('.msg.echo')].find((n) => /This one is refused/.test(n.textContent)); return echo && /Not sent: That message's wait could not be read\\./.test(echo.textContent) && document.getElementById('directorInput').value === 'This one is refused.' && 'kept'; })()`, 8000);
      report(pressed === 'true' && sentHot === 'sent' && refusedKept === 'kept', `🔥 Priority is a pressed toggle, the message carries priority and the toggle is off after the send; a refused send keeps its words in the field and says the server's (${JSON.stringify({ pressed, sentHot, refusedKept })})`);
      // One's own message says what is true at the end of its line: You, then Sent (or Seen by Rob, whose page reads it),
      // then "Seen by … and N more" once more of backstage have read it (two more backstage seats here, and Ana).
      const OWN = `(() => { const m = allMessages.find((x) => x.text === 'Five more minutes on resolution 3.'); const n = m && messagesById.get(m.id); return n ? JSON.stringify([n.querySelector(':scope > header .from').textContent, n.querySelector(':scope > header .bv-said').textContent]) : null; })()`;
      const ownFirst = JSON.parse(await meg.until(OWN, 3000) || 'null');
      const ownSeq = await meg.eval(`allMessages.find((m) => m.text === 'Five more minutes on resolution 3.').seq`);
      const readers = [];
      for (const name of ['Ben Backstage', 'Cleo Backstage']) { const r = await connect(base); readers.push(r); await emit(r, 'join', { roomCode: bvHall, name, role: 'research' }); r.emit('seen', { seq: ownSeq }); }
      ana.emit('seen', { seq: ownSeq });
      const ownSeen = JSON.parse(await meg.until(`(() => { const r = ${OWN}; return r && /^Seen by .+ and [2-9] more$/.test(JSON.parse(r)[1]) && r; })()`, 8000) || 'null');
      report(!!ownFirst && ownFirst[0] === 'You' && /^(Sent|Seen by [^,]+)$/.test(ownFirst[1]) && !!ownSeen && ownSeen[0] === 'You',
        `one's own message reads "You", then "${ownFirst && ownFirst[1]}" at the end of its line, then "${ownSeen && ownSeen[1]}" once more of backstage have read it`);
      await meg.eval(`(() => { const echo = [...feed.querySelectorAll('.msg.echo')].find((n) => /This one is refused/.test(n.textContent)); const edit = echo && [...echo.querySelectorAll('button')].find((b) => b.textContent === 'Edit'); if (edit) edit.click(); document.getElementById('directorInput').value = ''; return true; })()`);
      // The 🔥 strip: only while its message is out of view. A run of notes pushes it up; scrolled to the top, it is in
      // view and the strip goes; at the end it is out of view and the strip holds it, "+1 more" with a second; its Got it
      // answers the one it shows.
      for (let i = 1; i <= 14; i++) await say({ type: 'text', text: 'Agenda note ' + i + ': the next speaker is on the second microphone, please keep the lectern clear.' });
      await say({ type: 'text', text: 'The livestream is running ten seconds late.', priority: true });
      for (let i = 15; i <= 26; i++) await say({ type: 'text', text: 'Agenda note ' + i + ': the speaker after next waits in the wings with the second microphone.' });
      const stripAtEnd = await meg.until(`(() => { const s = document.getElementById('bvStrip'); return !s.hidden && getComputedStyle(s).display !== 'none' && JSON.stringify({ text: document.getElementById('bvStripText').textContent, more: document.getElementById('bvStripMore').hidden ? '' : document.getElementById('bvStripMore').textContent, got: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()) }); })()`, 8000);
      await meg.eval(`(() => { const n = messagesById.get(allMessages.find((m) => m.text === 'The livestream is running ten seconds late.').id); n.scrollIntoView({ block: 'center' }); return true; })()`);
      const stripInView = await meg.until(`document.getElementById('bvStrip').hidden && 'gone'`, 5000);
      await meg.eval(`scrollToBottom(); true`);
      await meg.until(`!document.getElementById('bvStrip').hidden`, 5000);
      await meg.eval(`document.querySelector('#bvStrip button[data-action="msg.ack"]').click()`);
      const stripGot = await meg.until(`(() => { const m = allMessages.find((x) => x.text === 'The livestream is running ten seconds late.'); const next = document.getElementById('bvStrip').hidden ? '' : document.getElementById('bvStripText').textContent;
        return (m.reactions || []).some((r) => r.uid === MY_UID && r.emoji === '👍') && next === 'Wrap up resolution 3 now, please.' && JSON.stringify({ next }); })()`, 8000);
      report(!!stripAtEnd && JSON.parse(stripAtEnd).text === 'The livestream is running ten seconds late.' && JSON.parse(stripAtEnd).more === '+1 more' && JSON.stringify(JSON.parse(stripAtEnd).got) === JSON.stringify(['👍Got it']) && stripInView === 'gone' && JSON.parse(stripGot || 'null') && JSON.parse(stripGot).next === 'Wrap up resolution 3 now, please.',
        `the 🔥 strip holds the newest priority message only while it is out of view, with "+1 more" and its Got it alone; scrolled into view it goes; its Got it answers the one shown, and the strip moves to the next (${JSON.stringify({ stripAtEnd, stripInView, stripGot })})`);
      // ↓ n new, scrolled up: it names a question among them.
      await meg.eval(`(() => { feed.scrollTop = 0; feed.dispatchEvent(new Event('scroll')); return true; })()`);
      await meg.until('!place.atEnd', 3000);
      await say({ type: 'text', text: 'One more thing for the chair.' });
      await say({ type: 'action', text: 'Move the break to 15:30?', options: ['Yes', 'No'] });
      const newWords = await meg.until(`!newBelow.hidden && newBelow.textContent === '↓ 2 new · 1 question' && newBelow.textContent`, 5000);
      report(newWords === '↓ 2 new · 1 question', `scrolled up, "↓ n new" names a question among them (${newWords})`);
      await meg.eval(`scrollToBottom(); true`);
      // The Escape order: a take over an open reply minimises the take first, and the reply stays; then Escape takes the
      // reply back. While the take is up, a 🔥 message from backstage breaks through with Got it beside Open chat.
      await meg.eval(`[...messagesById.get(allMessages.find((m) => m.text === 'Wrap up resolution 3 now, please.').id).querySelectorAll('.msg-response button')].find((b) => b.dataset.action === 'msg.reply').click()`);
      await meg.until(`!!document.getElementById('replyChip')`, 3000);
      const blank = await emit(bvAdmin, 'page:push', { code: bvHall, to: 'board', content: { kind: 'clock' } });
      await meg.until(`!document.getElementById('pageLayer').hidden`, 8000);
      await say({ type: 'text', text: 'Mic 4 is live now.', priority: true });
      const layerGot = await meg.until(`(() => { const g = document.getElementById('layerGotIt'); return !document.getElementById('layerStrip').hidden && !g.hidden && JSON.stringify([g.textContent, document.getElementById('layerOpenChat').textContent]); })()`, 8000);
      await meg.eval(`document.getElementById('layerGotIt').click()`);
      const layerAcked = await meg.until(`(() => { const m = allMessages.find((x) => x.text === 'Mic 4 is live now.'); return (m.reactions || []).some((r) => r.uid === MY_UID && r.emoji === '👍') && document.getElementById('layerStrip').hidden && 'acked'; })()`, 8000);
      await meg.eval(`document.getElementById('pageLayer').focus(); true`);
      await meg.until(`document.activeElement === document.getElementById('pageLayer')`, 3000);
      await press(meg, 'Escape');
      const escTake = await meg.until(`document.getElementById('pageLayer').hidden && !!document.getElementById('replyChip') && 'minimised, reply kept'`, 5000);
      // Minimised, the take is a card in Shown to you with one act, 👁 Look.
      const cardActs = await meg.until(`(() => { const b = [...document.querySelectorAll('#takeCards .take-card button')].filter((x) => x.getClientRects().length); return b.length ? JSON.stringify(b.map((x) => x.textContent.trim())) : null; })()`, 3000);
      await meg.eval(`document.getElementById('directorInput').focus(); true`);
      await press(meg, 'Escape');
      const escReply = await meg.until(`!document.getElementById('replyChip') && 'reply gone'`, 5000);
      // The Board's pages back on their chat, so the pages that join below draw the chat.
      const chatAgain = await emit(bvAdmin, 'page:push', { code: bvHall, to: 'board', content: { kind: 'chat' } });
      report(!!chatAgain && chatAgain.ok && !!blank && blank.ok && layerGot === JSON.stringify(['👍 Got it', 'Open chat']) && layerAcked === 'acked' && escTake === 'minimised, reply kept' && escReply === 'reply gone' && cardActs === JSON.stringify(['👁Look']),
        `the take layer's 🔥 strip has 👍 Got it beside Open chat, and Got it answers it (react on); Escape minimises a take over an open reply first, then takes the reply back; the card it leaves in Shown to you has one act, 👁 Look (${JSON.stringify({ layerGot, layerAcked, escTake, escReply, cardActs })})`);
      // The ⋯ sheet: Text size, Theme, Leave the hall (no Full screen row where the device has no Fullscreen API: headless
      // Chromium's probe reads it); Leave asks in place and Stay keeps the page; the footer names the person and the seat.
      await meg.eval(`document.getElementById('headerMore').click()`);
      const sheet = await meg.until(`(() => { const s = document.getElementById('bvSheet'); return !s.hidden && JSON.stringify({ rows: [...s.querySelectorAll('.bv-sheet-row')].map((r) => [...r.children].map((c) => c.textContent.trim()).join(' ')), foot: document.getElementById('bvSheetFoot').textContent, focus: s.contains(document.activeElement), full: F.fullscreen, stage: F.stagewatch }); })()`, 3000);
      await meg.eval(`document.querySelector('#bvSheet [data-action="sheet.leave"]').click()`);
      const leaveAsk = await meg.until(`(() => { const a = document.querySelector('.agm-ask'); return a && a.textContent.replace(/\\s+/g, ' '); })()`, 3000);
      await meg.eval(`[...document.querySelectorAll('.agm-ask button')].find((b) => b.textContent === 'Stay').click()`);
      const stayed = await meg.until(`!document.querySelector('.agm-ask') && location.pathname === '/app.html' && joined && 'stayed'`, 3000);
      const awake = await meg.eval(`JSON.stringify(Simple.awakeState())`);
      const sheetRows = sheet ? JSON.parse(sheet) : null;
      report(!!sheetRows && JSON.stringify(sheetRows.rows) === JSON.stringify(['Text size Aa− 100% Aa+', 'Clock or countdown Time of day Countdown Off' + (sheetRows.stage ? '' : ' This hall has no Stagewatch linked.'), 'Theme Light Dark', ...(sheetRows.full ? ['Full screen'] : []), 'Leave the hall…']) && sheetRows.foot === 'Margaret 1180dark · On stage' && sheetRows.focus
        && /Leave Board hall\?\s*You'll stop getting messages from backstage\./.test(leaveAsk || '') && stayed === 'stayed' && awake !== 'null',
        `the ⋯ sheet holds Text size, Clock or countdown, Theme, Full screen where the device has it, and Leave the hall (asked in place: "${leaveAsk}"; Stay keeps the page), its footer the person and the seat, and the screen's wake lock was asked through AGM.awake (${JSON.stringify({ sheet, awake })})`);
      await press(meg, 'Escape');
      // Text size scales the whole chat: the words, the answers, Answer in words…, the response, and the strip; the header
      // stays as it is.
      const SIZES = `JSON.stringify(Object.fromEntries([['words', '#feed .msg[data-id] .body p'], ['answer', '#feed .action-btn'], ['inWords', '#feed .answer-words-btn'], ['response', '#feed .msg-response .msg-act'],
        ['strip', '.bv-strip-words'], ['stripKind', '.bv-strip-kind'], ['header', '.app-title strong']].map(([k, sel]) => { const el = document.querySelector(sel); return [k, el ? parseFloat(getComputedStyle(el).fontSize) : null]; })))`;
      const atOne = JSON.parse(await meg.eval(SIZES));
      await meg.eval(`setZoom(1.5); true`);
      const atMore = JSON.parse(await meg.eval(SIZES));
      await meg.eval(`setZoom(1); true`);
      const grew = Object.fromEntries(Object.keys(atOne).map((k) => [k, atOne[k] && atMore[k] ? +(atMore[k] / atOne[k]).toFixed(2) : null]));
      report(Object.entries(grew).every(([k, r]) => (k === 'header' ? r === 1 : r !== null && Math.abs(r - 1.5) <= 0.02)),
        `Text size at 150% scales the words, the answers, Answer in words…, the response and the 🔥 strip by 1.5, and leaves the header as it is (${JSON.stringify({ atOne, grew })})`);
      // Dark: a fresh device draws dark before the feed has a message; a device last used in the simple view paints dark
      // before its first frame (the theme theme-init.js sets, read as it sets it); Light chosen in the sheet sticks; on
      // that device the join page and the halls board, which read no view, paint light.
      // Each theme the page is given in order, marked "+feed" once a message is in the feed (the records in the order they
      // happened: the theme's, and the feed's own).
      const FIRST_THEME = `(() => { const seen = window.__themes = []; let fed = false; new MutationObserver((list) => { for (const m of list) {
        if (m.type === 'childList' && m.target.id === 'feed' && [...m.addedNodes].some((n) => n.classList && n.classList.contains('msg'))) fed = true;
        if (m.type === 'attributes' && m.target === document.documentElement) seen.push(m.target.getAttribute('data-theme') + (fed ? '+feed' : '')); } })
        .observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ['data-theme'] }); })();`;
      const fresh = await edge.tab(`${base}/app.html?code=${bvHall}&name=Nadia&role=board&invite=${inviteOf(dataDir, bvHall)}`, { init: FIRST_THEME, metrics: { width: 1180, height: 820, phone: true }, alone: true });
      const freshThemes = await fresh.until(`${ready} && JSON.stringify(window.__themes)`, 10000);
      await fresh.send('Page.navigate', { url: `${base}/app.html?code=${bvHall}&name=Nadia&role=board&invite=${inviteOf(dataDir, bvHall)}` });
      const lastThemes = await fresh.until(`${ready} && JSON.stringify(window.__themes)`, 10000);
      await fresh.eval(`(() => { document.getElementById('headerMore').click(); [...document.querySelectorAll('#bvSheet [data-action="sheet.theme"]')].find((b) => b.textContent === 'Light').click(); return true; })()`);
      await fresh.until(`document.documentElement.dataset.theme === 'light'`, 3000);
      await fresh.send('Page.navigate', { url: `${base}/app.html?code=${bvHall}&name=Nadia&role=board&invite=${inviteOf(dataDir, bvHall)}` });
      const stuck = await fresh.until(`${ready} && document.documentElement.dataset.theme`, 10000);
      await fresh.eval(`localStorage.removeItem('agm.theme'); true`);
      const otherPages = [];
      for (const pageUrl of [`${base}/?code=${bvHall}`, `${base}/halls.html`]) {
        await fresh.send('Page.navigate', { url: pageUrl });
        otherPages.push(await fresh.until(`document.readyState === 'complete' && JSON.stringify([localStorage.getItem('agm.lastView'), (window.__themes || [])[0] || document.documentElement.dataset.theme])`, 10000));
      }
      // A fresh device: light first (nothing chosen, no view drawn yet), then dark, with no message in the feed yet.
      const freshList = JSON.parse(freshThemes || '[]');
      const darkAt = freshList.indexOf('dark');
      report(freshList[0] === 'light' && darkAt > 0 && !freshList.slice(0, darkAt).some((t) => /\+feed$/.test(t))
        && JSON.parse(lastThemes || '[]')[0] === 'dark' && stuck === 'light' && otherPages.every((p) => p === JSON.stringify(['simple', 'light'])),
        `the simple view starts in Dark: a fresh device turns dark at its join, before the feed is drawn (${freshThemes}); one last used there paints dark first (${lastThemes}); Light chosen in the sheet sticks (${stuck}); the join page and the halls board there paint light (${JSON.stringify(otherPages)})`);
      // The admin's support view of Margaret: its theme never turns her page light (support: true), and her own Light
      // reaches it.
      const megUid = await meg.eval('MY_UID');
      const support = await edge.tab(`${base}/app.html?code=${bvHall}&name=${encodeURIComponent('Margaret 1180dark')}&role=board&adminView=1&viewOf=${megUid}`);
      await support.until(`typeof joined !== 'undefined' && joined && document.body.dataset.view === 'simple'`, 10000);
      await support.eval(`socket.emit('userState:push', { key: 'theme', value: 'light' }); true`);
      await sleep(1200);
      const megAfter = await meg.eval(`JSON.stringify([document.documentElement.dataset.theme, localStorage.getItem('agm.theme')])`);
      await meg.eval(`(() => { document.getElementById('headerMore').click(); [...document.querySelectorAll('#bvSheet [data-action="sheet.theme"]')].find((b) => b.textContent === 'Light').click(); document.getElementById('headerMore').click(); return true; })()`);
      const supportLight = await support.until(`document.documentElement.dataset.theme === 'light' && 'light'`, 5000);
      report(megAfter === JSON.stringify(['dark', null]) && supportLight === 'light', `the admin's support view toggled to Light leaves the Board page dark and its theme unchosen (${megAfter}); the Board page's own Light reaches the support view (${supportLight})`);
      // A backstage page the admin sets to Simple writes in the simple view's composer (🔥 Priority, the words, Send), its
      // Reply focusing that field; By seat again, it has its own tabs back.
      const robSid = (await emit(bvAdmin, 'admin:watchRoom', { roomCode: bvHall })).users.find((u) => u.name === 'Rob').socketId;
      const robSimple = await emit(bvAdmin, 'admin:setView', { roomCode: bvHall, socketId: robSid, view: 'simple' });
      const VIS = (sel) => `(document.querySelector('${sel}') || { getClientRects: () => [] }).getClientRects().length > 0`;
      const robComposer = await rob.until(`document.body.dataset.view === 'simple' && ${VIS('#directorCompose')} && !${VIS('#researchCompose')} && 'simple'`, 5000);
      await rob.eval(`(() => { const b = [...document.querySelectorAll('#feed .msg-response [data-action="msg.reply"]')].filter((x) => x.getClientRects().length); b[b.length - 1].click(); return true; })()`);
      const robReplying = await rob.until(`(() => { const f = document.getElementById('directorInput'); const c = document.getElementById('replyChip'); return document.activeElement === f && f.getClientRects().length > 0 && c && document.getElementById('directorCompose').contains(c) && 'replying'; })()`, 3000);
      await rob.eval(`(() => { const i = document.getElementById('directorInput'); i.value = 'Noted, from backstage.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#directorForm .send-btn').click(); return true; })()`);
      const robSent = await rob.until(`allMessages.some((m) => m.text === 'Noted, from backstage.' && m.from.uid === MY_UID && m.replyTo && m.replyTo.id) && 'sent'`, 8000);
      await emit(bvAdmin, 'admin:setView', { roomCode: bvHall, socketId: robSid, view: '' });
      const robFull = await rob.until(`document.body.dataset.view === 'full' && ${VIS('#researchCompose')} && !${VIS('#directorCompose')} && 'full'`, 5000);
      report(!!robSimple && robSimple.ok && robComposer === 'simple' && robReplying === 'replying' && robSent === 'sent' && robFull === 'full',
        `a backstage page the admin sets to Simple draws the simple view's composer, Reply focusing its field, and sends from it; By seat again, its own composer is back (${JSON.stringify({ robComposer, robReplying, robSent, robFull })})`);
      // Nobody backstage: with every backstage page gone for 10 s, one line over the composer, which goes when one comes back.
      rob.close();
      ana.close();
      for (const r of readers) r.close();
      const aloneAt = Date.now();
      const alone = await meg.until(`(() => { const l = document.getElementById('bvAlone'); return !l.hidden && l.textContent; })()`, 15000);
      const aloneAfter = Date.now() - aloneAt;
      const back = await connect(base);
      await emit(back, 'join', { roomCode: bvHall, name: 'Ana Ribeiro', role: 'research', uid: anaJoin.identity });
      const aloneGone = await meg.until(`document.getElementById('bvAlone').hidden && 'gone'`, 5000);
      back.close();
      report(alone === '○ Nobody backstage is online. Use Help if you need someone.' && aloneAfter >= 9000 && aloneGone === 'gone',
        `with nobody backstage in the room for 10 s, "${alone}" sits over the composer (after ${Math.round(aloneAfter / 1000)} s), and goes when someone backstage comes back`);
      // The device that went to the join page and the halls board signed out was refused who it is there (401): no fault.
      const quiet = (t) => t.problems.filter((x) => !(t === fresh && /status of 401 \(Unauthorized\)/.test(x)));
      for (const [name, t] of [...bvTabs.map((t, i) => ['the Board\'s chat view on device leg ' + (i + 1), t]), ['a Board account\'s chat view', megTab], ['a fresh Board device', fresh], ['the support view of a Board page', support]]) {
        const p = quiet(t);
        report(p.length === 0, `${name}: no script errors or CSP violations${p.length ? ' — ' + p.slice(0, 3).join(' | ') : ''}`);
        t.close();
      }

      // The layout leg: nine more sizes, each across one of the rules (owner answer 22), a Board guest at each, the file
      // opened on its panel (👁 Look): the column at 900 px wide or more and the tabs below; 22 px where the smaller side is
      // 600 px or more; no sideways scroll; a 44 px band through each control; the placeholder whole (the short words where
      // the long do not fit); the sheet's last row reached by its scroll, and Leave asked in place there.
      const layout = {};
      for (const [w, h] of [[640, 1024], [1024, 640], [768, 1024], [1024, 768], [375, 667], [393, 659], [360, 780], [734, 343], [863, 360]]) {
        const tab = await edge.tab(`${base}/app.html?code=${bvHall}&name=${encodeURIComponent('Board ' + w + 'x' + h)}&role=board&invite=${inviteOf(dataDir, bvHall)}`, { init: INK, metrics: { width: w, height: h, phone: true }, alone: true });
        await tab.until(`typeof joined !== 'undefined' && joined && allMessages.some((m) => m.type === 'file')`, 10000);
        await tab.eval(`(() => { const m = allMessages.find((x) => x.type === 'file'); act('msg', 'msg.look', m, {}); return true; })()`);
        await tab.until(`document.body.dataset.shown === '1'`, 5000);
        // The read waits until what it measures is drawn: a first open draws its newest 60 at once and the rest as the page
        // is idle, and the joins and leaves of the devices before this one add to the hall's lines.
        await tab.until(`[...feed.querySelectorAll(':scope > .msg[data-id]')].some((n) => (findMessage(n.dataset.id) || {}).text === 'Wrap up resolution 3 now, please.')`, 5000);
        const r = await bvRead(tab);
        await tab.eval(`document.getElementById('headerMore').click(); true`);
        const sheetEnd = await tab.until(`(() => { const s = document.getElementById('bvSheet'); if (s.hidden) return null; const leave = s.querySelector('[data-action="sheet.leave"]'); leave.scrollIntoView({ block: 'nearest' });
          const a = leave.getBoundingClientRect(), b = s.getBoundingClientRect(); return JSON.stringify({ inView: a.top >= 0 && a.bottom <= innerHeight && a.top >= b.top - 1 && a.bottom <= b.bottom + 1, tall: b.height <= innerHeight + 1 }); })()`, 3000);
        await tab.eval(`document.querySelector('#bvSheet [data-action="sheet.leave"]').click(); true`);
        const asks = await tab.until(`!!document.querySelector('.agm-ask') && 'asks'`, 3000);
        // A refresh of what the page shows (a message heard, a person come or gone) keeps the ask: the sheet it was asked
        // from is still open, so its object is not gone.
        const kept = asks ? await tab.eval(`(() => { refreshOpenMenu(); return !!document.querySelector('.agm-ask'); })()`) : null;
        await press(tab, 'Escape');
        layout[w + 'x' + h] = { ...r, sheetEnd: JSON.parse(sheetEnd || 'null'), asks, kept, problems: tab.problems.length };
        console.log(`the Board's chat view at ${w}×${h}: the feed is ${r && r.feedHeight} px tall (a record, not a pass mark)`);
        tab.close();
      }
      const layoutOk = (k, r) => { const [w, h] = k.split('x').map(Number);
        return !!r && r.view === 'simple' && r.column === (w >= 900) && r.tabs === (w < 900) && r.body === (Math.min(w, h) >= 600 ? 22 : 20) && r.scroll && r.missed.length === 0 && r.fits
          && r.placeholder === (r.longFits ? 'Message everyone here…' : 'Message everyone…') && r.label === 'Message everyone here…' && !!r.sheetEnd && r.sheetEnd.inView && r.sheetEnd.tall && r.asks === 'asks' && r.kept === true && r.problems === 0; };
      report(Object.entries(layout).every(([k, r]) => layoutOk(k, r)),
        `the layout leg at nine sizes: the Shown to you column at 900 px wide or more and the tabs below, 22 px where the smaller side is 600 px or more, no sideways scroll, a 44 px band through each control, the placeholder whole (the short words where the long do not fit the field, measured), the sheet within the screen with Leave reached and asked in place, the ask kept through a refresh of the page, no script error (${JSON.stringify(Object.fromEntries(Object.entries(layout).map(([k, r]) => [k, r && { column: r.column, tabs: r.tabs, body: r.body, scroll: r.scroll, missed: r.missed, placeholder: r.placeholder, fits: r.fits, sheetEnd: r.sheetEnd, asks: r.asks, kept: r.kept, problems: r.problems }])))})`);

      // The floor leg's chat-view steps: no Fullscreen API (both its forms gone) and no Wake Lock: no Full screen row in the
      // sheet and none on a take, and the sheet says why the device may sleep; not a secure context: the HTTPS words; a
      // lock the device refuses (NotAllowedError): the battery words.
      const NO_FULL = `(() => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; delete Document.prototype.fullscreenEnabled; delete Document.prototype.webkitFullscreenEnabled; })();`;
      const floorRuns = {};
      for (const [name, init] of [['settings', FLOOR + NO_FULL], ['https', NO_FULL + `Object.defineProperty(window, 'isSecureContext', { get: () => false });`], ['battery', NO_FULL + `WakeLock.prototype.request = function () { return Promise.reject(new DOMException('Low battery', 'NotAllowedError')); };`]]) {
        const tab = await edge.tab(`${base}/app.html?code=${bvHall}&name=${encodeURIComponent('Floor ' + name)}&role=board&invite=${inviteOf(dataDir, bvHall)}`, { init, metrics: { width: 1180, height: 820, phone: true }, alone: true });
        await tab.until(`typeof joined !== 'undefined' && joined`, 10000);
        await tab.until(`Simple.awakeState() !== null`, 5000);
        await tab.eval(`document.getElementById('headerMore').click(); true`);
        floorRuns[name] = await tab.until(`(() => { const s = document.getElementById('bvSheet'); if (s.hidden) return null; const w = s.querySelector('.bv-sheet-awake');
          return JSON.stringify({ full: !!s.querySelector('[data-action="sheet.fullscreen"]'), fact: F.fullscreen, words: w ? w.textContent : '' }); })()`, 3000);
        report(tab.problems.length === 0, `the floor leg's chat view (${name}): no script error${tab.problems.length ? ' — ' + tab.problems.slice(0, 3).join(' | ') : ''}`);
        tab.close();
      }
      const floorWant = {
        settings: JSON.stringify({ full: false, fact: false, words: 'This device may sleep: set its screen to stay on in its own settings (Auto-Lock or Screen timeout).' }),
        https: JSON.stringify({ full: false, fact: false, words: 'This device may sleep: open AGMessage over HTTPS.' }),
        battery: JSON.stringify({ full: false, fact: false, words: 'This device would not stay awake (its battery may be low): plug it in.' }),
      };
      report(Object.keys(floorWant).every((k) => floorRuns[k] === floorWant[k]), `the floor leg: no Fullscreen API, no Full screen row and no ⛶ (the fact is false); the sheet says why the device may sleep, by cause (${JSON.stringify(floorRuns)})`);
      bvAdmin.close();
    }

    // ---------------- The clock or countdown (unit 20b): chosen on the tablet and by the admin, who may lock it ----------------
    // A hall of its own, a fresh Board tablet (nothing chosen anywhere), the admin's socket (the laptop's token: "the
    // admin"), and a Stagewatch linked part way through, its frames sent by the test.
    {
      const ckHall = (await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Clock hall' }) })).json()).code;
      const ckAdmin = await connect(base, cookie);
      const kay = await edge.tab(`${base}/app.html?code=${ckHall}&name=Kay&role=board&invite=${inviteOf(dataDir, ckHall)}`, { metrics: { width: 1180, height: 820, phone: true }, alone: true });
      await kay.until(`typeof joined !== 'undefined' && joined && document.body.dataset.view === 'simple'`, 10000);
      // What a readout draws, read as a person sees it: shown or not, its mark, its digits (their element, role and words),
      // the line under them (its role, a sibling of the digits' line, never inside a live region), its edge's colour and the
      // digits' ink against the --c-ink token, and whether it reads stale.
      const RO = (id) => `(() => { const r = document.getElementById('${id}'); const t = r.querySelector('.bv-ro-time'); const s = r.querySelector('.bv-ro-strip'); const probe = document.createElement('span'); probe.style.color = 'var(--c-ink)'; r.appendChild(probe); const ink = getComputedStyle(probe).color; probe.remove();
        const line = r.querySelector('.bv-ro-line');
        return JSON.stringify({ shown: !r.hidden && r.getClientRects().length > 0 || (!!line && line.getClientRects().length > 0), mark: (r.querySelector('.bv-ro-icon') || {}).textContent || '', tag: t ? t.tagName : '', role: t ? t.getAttribute('role') : null, time: t ? t.textContent : '', datetime: t ? t.getAttribute('datetime') : null,
          line: s && !s.hidden ? s.textContent : '', lineRole: s ? s.getAttribute('role') : null, apart: !!s && !!line && s.parentNode === line.parentNode && !line.contains(s) && !(t && t.closest('[role="status"]')),
          edge: getComputedStyle(r).borderLeftColor, digits: t ? getComputedStyle(t).color : '', ink, stale: r.classList.contains('stale') }); })()`;
      const ro = async (tab, id = 'bvReadout') => JSON.parse(await tab.eval(RO(id)) || 'null');
      const sheetOpen = async (tab) => { await tab.eval(`(() => { if (document.getElementById('bvSheet').hidden) document.getElementById('headerMore').click(); return true; })()`); await tab.until(`!document.getElementById('bvSheet').hidden`, 3000); };
      const choose = async (tab, value) => { await sheetOpen(tab); await tab.eval(`document.querySelector('#bvSheet [data-action="sheet.clock"][data-value="${value}"]').click(); true`); };
      const CLOCK_ROW = `(() => { const r = [...document.querySelectorAll('#bvSheet .bv-sheet-row')].find((x) => x.dataset.action === 'sheet.clock'); return r ? JSON.stringify({ words: [...r.children].map((c) => c.textContent.trim()).join(' '), controls: [...r.querySelectorAll('button')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')) }) : null; })()`;
      // A fresh tablet, with nothing chosen: 🕐 HH:MM, a <time> with no role and no seconds (owner answer B3).
      const fresh = await ro(kay);
      // Off: no readout at all.
      await choose(kay, 'off');
      const off = await kay.until(`document.getElementById('bvReadout').hidden && localStorage.getItem('agm.clock') === 'off' && 'off'`, 3000);
      // Countdown with no Stagewatch linked: --:-- and why, the sheet saying so under the choice.
      await choose(kay, 'stage');
      const noLink = await kay.until(`!document.getElementById('bvReadout').hidden && document.querySelector('#bvReadout .bv-ro-time').textContent === '--:--' && ${RO('bvReadout')}`, 3000);
      const noLinkRow = await kay.eval(CLOCK_ROW);
      // Linked: Stagewatch's countdown in its words, the title and its line under the digits, its colour the edge.
      const ckSw = await fakeStagewatch({ name: 'Lectern timer' });
      const linked = await emit(ckAdmin, 'hall:configure', { code: ckHall, stagewatchUrl: ckSw.url, stagewatchKey: KEY });
      await kay.until(`pageFacts.stage && pageFacts.stage.status === 'connected'`, 10000);
      ckSw.frame({ text: '4:30', mode: 'countdown', phase: 'normal', title: 'Q&A', message: 'Wrap up in 2 minutes', color: '#16A34A' });
      await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left'`, 8000);
      const normal = await ro(kay);
      ckSw.frame({ text: '-0:30', phase: 'overtime', message: 'Please wrap up now' });
      await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '0:30 over'`, 8000);
      const over = await ro(kay);
      ckSw.frame({ text: '0:45', phase: 'wrapup', message: '' });
      await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === 'Wrap up · 0:45 left'`, 8000);
      const wrapup = await ro(kay);
      ckSw.frame({ text: '4:30', phase: 'normal', message: 'Wrap up in 2 minutes' });
      await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left'`, 8000);
      // The take layer's bar draws the same readout.
      const up = await emit(ckAdmin, 'page:push', { code: ckHall, to: 'board', content: { kind: 'clock' } });
      await kay.until(`!document.getElementById('pageLayer').hidden`, 8000);
      const bar = await ro(kay, 'layerReadout');
      await emit(ckAdmin, 'page:push', { code: ckHall, to: 'board', content: { kind: 'chat' } });
      await kay.until(`document.getElementById('pageLayer').hidden`, 8000);
      report(fresh && fresh.shown && fresh.mark === '🕐' && fresh.tag === 'TIME' && fresh.role === null && /^\d\d:\d\d$/.test(fresh.time) && fresh.datetime === fresh.time && fresh.line === ''
        && off === 'off' && !!noLink && JSON.parse(noLink).line === 'No Stagewatch linked' && JSON.parse(noLink).stale && /This hall has no Stagewatch linked\.$/.test(JSON.parse(noLinkRow || '{}').words || '')
        && !!linked && linked.ok && normal.mark === '⏱' && normal.time === '4:30 left' && normal.role === 'timer' && normal.tag === 'SPAN' && normal.line === 'Q&A · Wrap up in 2 minutes' && normal.lineRole === 'status' && normal.apart && !normal.stale
        && normal.edge === 'rgb(22, 163, 74)' && normal.digits === normal.ink
        && over.mark === '▲' && over.time === '0:30 over' && !/[-−]/.test(over.time) && over.line === 'Q&A · Please wrap up now'
        && wrapup.mark === '▲' && wrapup.time === 'Wrap up · 0:45 left' && wrapup.line === 'Q&A'
        && !!up && up.ok && bar && bar.shown && bar.time === '4:30 left' && bar.role === 'timer' && bar.line === 'Q&A · Wrap up in 2 minutes' && bar.lineRole === null,
        `the clock or countdown on a Board tablet: nothing chosen, 🕐 HH:MM in a <time> with no role and no seconds (B3); Off draws none; the countdown with no Stagewatch reads --:-- No Stagewatch linked and the sheet says so; linked, ⏱ "4:30 left" with its digits a timer and the title and Stagewatch's line a sibling status, Stagewatch's green its edge and the digits ink; ▲ "0:30 over" with no minus sign; ▲ "Wrap up · 0:45 left"; the take layer's bar draws the same (${JSON.stringify({ fresh, off, noLink, noLinkRow, normal, over, wrapup, bar })})`);

      // Locked by the admin while the sheet is open: the row is the admin's choice in words, with no control, and the
      // readout draws it whatever the device chose; unlocked, the choices are back with the device's checked, live.
      const kaySid = (await emit(ckAdmin, 'admin:watchRoom', { roomCode: ckHall })).users.find((u) => u.name === 'Kay').socketId;
      await sheetOpen(kay);
      const locked = await emit(ckAdmin, 'admin:setClock', { roomCode: ckHall, socketId: kaySid, show: 'time', locked: true });
      const lockedRow = await kay.until(`(() => { const r = ${CLOCK_ROW}; return r && !JSON.parse(r).controls.length && r; })()`, 5000);
      const lockedRo = await kay.until(`document.querySelector('#bvReadout .bv-ro-icon').textContent === '🕐' && ${RO('bvReadout')}`, 5000);
      const sheetStill = await kay.eval(`JSON.stringify({ open: !document.getElementById('bvSheet').hidden, rows: [...document.querySelectorAll('#bvSheet .bv-sheet-row')].map((r) => r.dataset.action || (r.querySelector('[data-action]') || { dataset: {} }).dataset.action || '') })`);
      const unlocked = await emit(ckAdmin, 'admin:setClock', { roomCode: ckHall, socketId: kaySid, locked: false });
      const unlockedRow = await kay.until(`(() => { const r = ${CLOCK_ROW}; return r && JSON.parse(r).controls.length === 3 && r; })()`, 5000);
      const unlockedRo = await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left' && 'countdown'`, 5000);
      await press(kay, 'Escape');
      report(!!locked && locked.ok && JSON.parse(lockedRow || '{}').words === 'Clock or countdown: Time of day Set by the admin for you.' && !!lockedRo && JSON.parse(lockedRo).tag === 'TIME'
        && JSON.parse(sheetStill).open && JSON.stringify(JSON.parse(sheetStill).rows.slice(0, 3)) === JSON.stringify(['sheet.size', 'sheet.clock', 'sheet.theme']) && JSON.parse(sheetStill).rows.at(-1) === 'sheet.leave' && !!unlocked && unlocked.ok && JSON.stringify(JSON.parse(unlockedRow || '{}').controls) === JSON.stringify(['Time of day:false', 'Countdown:true', 'Off:false']) && unlockedRo === 'countdown',
        `locked by the admin while the sheet is open, the row says "Clock or countdown: Time of day" and "Set by the admin for you." with no control, and the time of day is drawn over the device's countdown; unlocked, the three choices are back with the device's Countdown checked, and the countdown drawn, live (${JSON.stringify({ lockedRow, lockedRo, sheetStill, unlockedRow, unlockedRo })})`);

      // The admin's support view of Kay mirrors her device's choice, and follows it: Off on her tablet, none there.
      const kayUid = await kay.eval('MY_UID');
      const support = await edge.tab(`${base}/app.html?code=${ckHall}&name=Kay&role=board&adminView=1&viewOf=${kayUid}`);
      await support.until(`typeof joined !== 'undefined' && joined && document.body.dataset.view === 'simple'`, 10000);
      const mirrored = await support.until(`Clock.shown() === 'stage' && document.querySelector('#bvReadout .bv-ro-time') && document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left' && 'stage'`, 10000);
      await choose(kay, 'off');
      const followed = await support.until(`Clock.shown() === 'off' && document.getElementById('bvReadout').hidden && 'off'`, 5000);
      report(mirrored === 'stage' && followed === 'off' && support.problems.length === 0,
        `the admin's support view draws the device's choice as relayed (the countdown), and follows it to Off (${JSON.stringify({ mirrored, followed })})`);
      support.close();

      // At 600 px wide or less (a phone): the digits on the header's first row with the hall's name, Help and ⋯, Stagewatch's
      // colour their edge; the title and its line on a second row only while Stagewatch has a line; down 5 s or more, that
      // row is "Offline · reconnecting" alone. A link up with no time yet draws --:-- with the title, never "offline".
      const pip = await edge.tab(`${base}/app.html?code=${ckHall}&name=Pip&role=board&invite=${inviteOf(dataDir, ckHall)}`, { metrics: PHONE, alone: true });
      await pip.until(`typeof joined !== 'undefined' && joined && document.body.dataset.view === 'simple'`, 10000);
      await choose(pip, 'stage');
      await press(pip, 'Escape');
      await pip.until(`!!document.querySelector('#bvReadout .bv-ro-time') && document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left'`, 8000);
      const PHONE_ROWS = `(() => { const h = document.getElementById('helpBtn').getBoundingClientRect(), t = document.querySelector('.app-title').getBoundingClientRect(), line = document.querySelector('#bvReadout .bv-ro-line'), d = line.getBoundingClientRect();
        const s = document.querySelector('#bvReadout .bv-ro-strip'), w = document.getElementById('connWords'); const sr = s.getBoundingClientRect(), wr = w.getBoundingClientRect();
        const mid = (r) => (r.top + r.bottom) / 2; const row1 = (r) => r.height > 0 && Math.abs(mid(r) - mid(h)) < h.height / 2; const under = Math.max(h.bottom, t.bottom, d.bottom) - 1;
        return JSON.stringify({ digits: row1(d), name: row1(t), line: sr.height > 0 ? s.textContent : '', lineUnder: sr.height > 0 && sr.top >= under, words: wr.height > 0 ? w.textContent : '', wordsUnder: wr.height > 0 && wr.top >= under,
          edge: getComputedStyle(line).borderLeftColor, time: document.querySelector('#bvReadout .bv-ro-time').textContent, stale: document.getElementById('bvReadout').classList.contains('stale'), scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth }); })()`;
      const rows = async () => JSON.parse(await pip.eval(PHONE_ROWS) || 'null');
      const withLine = await rows();
      ckSw.frame({ title: '', message: '' });
      await pip.until(`document.querySelector('#bvReadout .bv-ro-strip').hidden`, 8000);
      const noLine = await rows();
      ckSw.frame({ title: 'Q&A', message: 'Wrap up in 2 minutes' });
      await pip.until(`!document.querySelector('#bvReadout .bv-ro-strip').hidden`, 8000);
      await pip.eval(`drawConnection({ back: false, connected: false, dot: true, stopped: false }); true`);
      const downRows = await rows();
      await pip.eval(`drawConnection({ back: true, connected: false, dot: false, stopped: false }); true`);
      const backRows = await rows();
      ckSw.frame({ text: '' });
      await pip.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '--:--'`, 8000);
      const noTime = await rows();
      ckSw.frame({ text: '4:30' });
      await pip.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '4:30 left'`, 8000);
      report(!!withLine && withLine.digits && withLine.name && withLine.line === 'Q&A · Wrap up in 2 minutes' && withLine.lineUnder && withLine.words === '' && withLine.edge === 'rgb(22, 163, 74)' && withLine.scroll
        && !!noLine && noLine.digits && noLine.name && noLine.line === '' && noLine.scroll
        && !!downRows && downRows.digits && downRows.words === 'Offline · reconnecting' && downRows.wordsUnder && downRows.line === '' && downRows.scroll
        && !!backRows && backRows.words === '' && backRows.line === 'Q&A · Wrap up in 2 minutes' && backRows.lineUnder
        && !!noTime && noTime.time === '--:--' && noTime.line === 'Q&A · Wrap up in 2 minutes' && !noTime.stale && pip.problems.length === 0,
        `on a phone the countdown's digits sit on the header's first row with the hall's name, Help and ⋯ (Stagewatch's green their edge), the title and its line on a second row only while there is one, and down 5 s that row is "Offline · reconnecting" alone; a link up with no time yet draws --:-- with the title, never "offline" (${JSON.stringify({ withLine, noLine, downRows, backRows, noTime })})`);
      pip.close();

      // The link down: --:-- "Stagewatch offline", never a confident stale time.
      await choose(kay, 'stage');
      await press(kay, 'Escape');
      await ckSw.close();
      const down = await kay.until(`document.querySelector('#bvReadout .bv-ro-time').textContent === '--:--' && ${RO('bvReadout')}`, 20000);
      report(!!down && JSON.parse(down).line === 'Stagewatch offline' && JSON.parse(down).stale && kay.problems.length === 0,
        `with the link down the countdown reads --:-- "Stagewatch offline", never a stale time; no script error on the tablet (${down}${kay.problems.length ? ' — ' + kay.problems.slice(0, 3).join(' | ') : ''})`);
      kay.close();
      ckAdmin.close();
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

    const tabs = [['research', research], ['board', board], ...docTabs, ['admin', admin], ['sign-in and halls', signin], ['accounts', users], ['hall as an account', hallView], ['hall as a Staff account', staffHall], ['display', screen], ['projector display', proj], ['foyer display (no zones)', foyer], ['a Viewer\'s halls board', viewerBoard], ['a Viewer taken straight into its hall', vicStraight], ['a Viewer\'s hall', viewerHall], ['a Board account\'s halls board, hall and switcher', kimTab], ['a Staff account\'s halls board, which it answers help from', sidBoard], ['the admin page with Members…', adminM], ['a halls board of rooms alone', louBoard], ['a code link, signed in then out', codeLink], ['a guest\'s hall link, signed in', asGuest], ['a code link with a one-time password', otpLink], ['the audit log of a 0.5.1 log, cut', audit2], ['Accept on Health', admin2], ['the browser verifier, from disk', checker], ['Split on Health', admin3], ['the archive under the audit log', users3], ['a phone as On stage', phones.board], ['a phone backstage', phones.research], ['a phone as an observer', phones.observer]];
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
    await stopServer(server);   // as the watchdog stops it: saved first
    if (server2) await stopServer(server2);
    if (server3) await stopServer(server3);
    if (server4) await stopServer(server4);
    if (server5) await stopServer(server5);
    if (link5) link5.close();
    const dirs = [dataDir, dataDir2, dataDir3, dataDir4, dataDir5].filter(Boolean);
    const beside = dirs.flatMap((d) => { try { return fs.readFileSync(d + '-snapshots.txt', 'utf8').split('\n').filter(Boolean); } catch { return []; /* the fence found nothing */ } });
    report(beside.length === 0, `every hall a start or a stop left unwritten holds what the store last wrote or loaded: nothing changed beside the store, which a stop would lose (${beside.join(', ') || 'none'})`);
    setTimeout(() => { for (const d of dirs) { for (const f of [d, d + '-snapshots.txt']) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } } } }, 1000);
  }
  console.log(failures === 0 ? `ALL OK (screenshots in ${OUT})` : `${failures} FAILED`);
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})();
