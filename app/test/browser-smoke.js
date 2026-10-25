'use strict';
/**
 * Browser smoke test: a real server (throwaway data folder) and headless Microsoft Edge driven over the DevTools
 * protocol. Loads the research and board views and the admin dashboard, checks each joins and renders with no script
 * error or CSP violation, renders a PDF through pdf.js, and saves screenshots.
 *
 *   npm run smoke            (screenshots in ../artifacts/smoke; set AGM_SMOKE_OUT to change)
 * Exit code 0 when everything passed. Needs Edge, Chrome or Chromium (set AGM_BROWSER to its path if it's elsewhere).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.AGM_SMOKE_OUT || path.join(ROOT, '..', 'artifacts', 'smoke');
const TOKEN = 'smokeadmintoken1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    async tab(url) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r));
      let id = 0; const pending = new Map(); const problems = [];
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || m.params.entry.text)) problems.push('log: ' + m.params.entry.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      });
      const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
      await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
      await send('Page.navigate', { url });
      return {
        problems,
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-smoke-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startServer(port, dataDir);
  const edge = await launchEdge();
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
    await users.eval(`document.getElementById('newUserBtn').click()`);
    await users.until(`document.getElementById('userDialog').open`);
    await users.shot(path.join(OUT, 'accounts.png'));
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

    // Rights inside a hall: the admin's room list offers no role select for an account; a Viewer's halls board opens a
    // help request's hall read only, and an old link that says research opens again as the server seats it — with no
    // composer, pin, reaction or answer offered. A help request offers no forward.
    await admin.eval(`watchRoom('${code}')`);
    report(!!(await admin.until(`Array.from(document.querySelectorAll('#usersTbody tr')).some((tr) => tr.textContent.includes('Ana Admin') && !tr.querySelector('.role-select') && tr.querySelector('.role-fixed')) && !!document.querySelector('#usersTbody .role-select')`)), 'the admin\'s room list: an account\'s role is its rights (no select), a code guest\'s has one');
    await admin.shot(path.join(OUT, 'admin-room.png'));
    await research.eval(`Promise.all([new Promise((r) => socket.emit('message', { type: 'help', category: 'Sound', text: 'radio mic 3 dead' }, r)), new Promise((r) => socket.emit('message', { type: 'action', text: 'Ready for Q&A?', options: ['Yes', 'No'] }, r))])`);
    report(!!(await research.until(`(() => { const h = document.querySelector('.msg[data-type="help"] .fwd-btn'); const t = Array.from(document.querySelectorAll('.msg[data-type="text"] .fwd-btn')); return h && h.hidden && t.length && t.every((b) => !b.hidden); })()`)), 'a help request offers no forward; a message does');
    const made2 = await signin.eval(`fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic', name: 'Vic Viewer', role: 'viewer', halls: ['${code}'], password: 'only looking at screens' }) }).then((r) => r.status)`);
    const vicIn = await signin.eval(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic', password: 'only looking at screens' }) }).then((r) => r.status)`);
    const viewerBoard = await edge.tab(`${base}/halls.html`);
    const helpHref = await viewerBoard.until(`(() => { const a = document.querySelector('#helpStrip:not([hidden]) .help-item a'); return a ? a.getAttribute('href') : ''; })()`);
    report(made2 === 200 && vicIn === 200 && /role=observer/.test(helpHref || ''), `a Viewer's help strip opens the hall read only (${helpHref})`);
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

    for (const [name, tab] of [['research', research], ['board', board], ['admin', admin], ['sign-in and halls', signin], ['accounts', users], ['hall as an account', hallView], ['display', screen], ['a Viewer\'s halls board', viewerBoard], ['a Viewer\'s hall', viewerHall]]) {
      report(tab.problems.length === 0, `${name}: no script errors or CSP violations${tab.problems.length ? ' — ' + tab.problems.slice(0, 3).join(' | ') : ''}`);
      tab.close();
    }
  } catch (e) {
    report(false, 'smoke run: ' + e.message);
  } finally {
    edge.close();
    server.kill();
    setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } }, 1000);
  }
  console.log(failures === 0 ? `ALL OK (screenshots in ${OUT})` : `${failures} FAILED`);
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
})();
