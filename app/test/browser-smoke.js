'use strict';
/**
 * Browser smoke test: a real server (throwaway data folder) and headless Microsoft Edge driven over the DevTools
 * protocol. Loads the research and board views and the admin dashboard, checks each joins and renders with no script
 * error or CSP violation, renders a PDF through pdf.js, drives a hall's screens (files taken over a slow network, a deck
 * stepped through, the countdown's strip on an upright tablet, the clock in another time zone, the Screens console),
 * and saves screenshots.
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
const { fakeStagewatch, fakeNode } = require('./helpers');

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

/** One headless Edge with a CDP session per tab. */
async function launchEdge() {
  const exe = browserPath();
  if (!exe) throw new Error('no Edge, Chrome or Chromium found (set AGM_BROWSER to one)');
  const port = await freePort();
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-edge-'));
  // A container running as root has no user namespace for Chromium's sandbox; everywhere else the sandbox stays on.
  const sandbox = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', ...sandbox, '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); } }
  return {
    proc, port, prof,
    /** A tab on `url`: `init` runs before the page's own scripts, `metrics` {width, height} is its viewport, `timezone` its zone. */
    async tab(url, { init, metrics, timezone } = {}) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r));
      let id = 0; const pending = new Map(); const problems = []; const listeners = new Map(); const expected = [];
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method && listeners.has(m.method)) listeners.get(m.method)(m.params);
        if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || m.params.entry.text) && !expected.some((r) => r.test(m.params.entry.url || ''))) problems.push('log: ' + m.params.entry.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      });
      const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
      await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
      if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init });
      if (metrics) await send('Emulation.setDeviceMetricsOverride', { width: metrics.width, height: metrics.height, deviceScaleFactor: 1, mobile: false });
      if (timezone) await send('Emulation.setTimezoneOverride', { timezoneId: timezone });
      await send('Page.navigate', { url });
      return {
        problems, send,
        /** A resource this tab is made to fail on purpose: its load error is not a problem. */
        expectFailure: (re) => { expected.push(re); },
        /** The viewport, as a screen of that size would have it. */
        resize: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
        /** Hold every request whose URL matches `pattern` for `ms`, then let it through (a slow venue network) or fail it. */
        async hold(pattern, ms, fail = false) {
          listeners.set('Fetch.requestPaused', (p) => { setTimeout(() => { send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: p.requestId, ...(fail ? { errorReason: 'ConnectionReset' } : {}) }); }, ms); });
          await send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
        },
        release: () => send('Fetch.disable'),
        eval: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value,
        async until(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await this.eval(expr); if (v) return v; await sleep(250); } return null; },
        async shot(file) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(s.result.data, 'base64')); },
        close: () => ws.close(),
      };
    },
    close() { try { proc.kill(); } catch { /* ignore */ } setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ } }, 1500); },
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

    // Board: joins, sees the message and the document on stage.
    const board = await edge.tab(`${base}/app.html?code=${code}&name=Chair&role=board`);
    report(!!(await board.until('typeof joined !== "undefined" && joined && allMessages.some(m => m.text === "Capex is on slide 14")')), 'board view joins and sees the research message');
    await sleep(800);
    await research.shot(path.join(OUT, 'research.png'));
    await board.shot(path.join(OUT, 'board.png'));

    // Admin dashboard: logs in on this machine and lists the room.
    const admin = await edge.tab(`${base}/admin.html`);
    await admin.until('document.readyState === "complete"');
    await admin.eval(`fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '${TOKEN}' }) }).then(() => location.reload())`);
    report(!!(await admin.until(`!document.getElementById('dashboard').hidden && document.body.textContent.includes('${code}') && document.getElementById('aiModel').textContent.includes('claude')`)), 'admin dashboard lists the room and its AI / show-network panels');
    await admin.shot(path.join(OUT, 'admin.png'));

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
    report(!!(await users.until(`document.getElementById('chainState').dataset.ok === '1' && /^✓ Intact — \\d+ entries$/.test(document.getElementById('chainState').textContent) && !document.getElementById('verifyBtn').disabled`)), 'Check the log reads the whole chain and says it is intact');
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
    const proj = await edge.tab(`${base}${projMade.display.path}`, { init: SCREEN_PROBE, metrics: { width: 1280, height: 720 } });
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

    // A page away while its hall loses its Stagewatch: back (it resumes from what it missed), the messages it had drawn
    // offer 🖥 no more.
    const sendsBefore = await research.eval(`[...document.querySelectorAll('.msg[data-type="text"] .stage-btn')].filter((b) => !b.hidden).length`);
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

    for (const [name, tab] of [['research', research], ['board', board], ['admin', admin], ['sign-in and halls', signin], ['accounts', users], ['hall as an account', hallView], ['hall as a Staff account', staffHall], ['display', screen], ['projector display', proj], ['foyer display (no zones)', foyer], ['a Viewer\'s halls board', viewerBoard], ['a Viewer\'s hall', viewerHall]]) {
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
    setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } }, 1000);
  }
  console.log(failures === 0 ? `ALL OK (screenshots in ${OUT})` : `${failures} FAILED`);
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})();
