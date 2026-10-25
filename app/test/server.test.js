'use strict';
// End-to-end tests: a real server in a child process on a free port with a throwaway data folder.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'testadmintoken01';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGM_DATA_DIR: dataDir, AGM_KEY_DIR: dataDir + '-keys', ADMIN_TOKEN: TOKEN, AGM_NODES: '0', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  if (child.channel) child.channel.unref();
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (out.includes('is running')) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not start:\n' + out);
}
const { stopServer: stop } = require('./helpers');   // asked over IPC, so it saves first on Windows too

const emit = (s, ev, arg) => new Promise((resolve) => s.emit(ev, arg, resolve));
const connect = (base, cookie) => new Promise((resolve, reject) => {
  const s = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : {} });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});

test('AGMessage server: security, resume, persistence', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child = await startServer(dataDir, port);
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stop(child); });

  await t.test('pages carry a strict CSP and no inline script', async () => {
    const r = await fetch(base + '/app.html');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const html = await r.text();
    assert.ok(!/<script>(?!<)/.test(html.replace(/<script src=[^>]+><\/script>/g, '')), 'no inline <script>');
    const mjs = await fetch(base + '/vendor/pdf.min.mjs');
    assert.match(mjs.headers.get('content-type') || '', /javascript/);
  });

  // admin login from this machine, then a room
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const roomRes = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'AGM 2026' }) });
  const { code } = await roomRes.json();
  assert.match(code, /^[A-Z0-9]{6}$/);

  await t.test('admin login refuses requests that came through the tunnel', async () => {
    const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(r.status, 403);
  });

  const board = await connect(base); sockets.push(board);
  const research = await connect(base); sockets.push(research);
  const jb = await emit(board, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: 'u-forged-client-id' });
  const jr = await emit(research, 'join', { roomCode: code, name: 'Ana', role: 'research' });

  await t.test('identities are issued by the server; a client-made id is replaced', () => {
    assert.ok(jb.ok && jr.ok);
    assert.ok(jb.identity && jb.identity.includes('.'));
    assert.notEqual(jb.uid, 'u-forged-client-id');
    assert.ok(jb.uploadToken && jr.uploadToken);
  });

  await t.test('names are unique per meeting (case-insensitive)', async () => {
    const other = await connect(base); sockets.push(other);
    const r = await emit(other, 'join', { roomCode: code, name: 'chair', role: 'board' });
    assert.equal(r.ok, false);
  });

  let seqAfterHello;
  await t.test('messages carry a sequence number and reach the room', async () => {
    const got = new Promise((r) => board.once('message', r));
    const ack = await emit(research, 'message', { type: 'text', text: 'Capex is on slide 14' });
    const m = await got;
    assert.ok(ack.ok && Number.isInteger(m.seq) && m.seq === ack.seq);
    seqAfterHello = m.seq;
  });

  await t.test('only the author can delete', async () => {
    const mine = await emit(research, 'message', { type: 'text', text: 'delete me' });
    const r = await emit(board, 'delete', { messageId: mine.id });
    assert.equal(r.ok, false);
    assert.equal((await emit(research, 'delete', { messageId: mine.id })).ok, true);
  });

  await t.test('file messages must point at a real upload', async () => {
    // eslint-disable-next-line no-script-url -- a hostile input this test proves is refused
    for (const url of ['javascript:alert(1)', 'https://evil.example/x.pdf', '/uploads/../server.js', '/uploads/1-abc-x.pdf']) {
      const r = await emit(research, 'message', { type: 'file', url, filename: 'x.pdf' });
      assert.equal(r.ok, false, url);
    }
  });

  await t.test('uploads: token required, content checked, served safely', async () => {
    const form = (name, bytes, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); return f; };
    const noToken = await fetch(base + '/api/upload', { method: 'POST', body: form('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), 'image/png') });
    assert.equal(noToken.status, 403);
    const h = { 'X-AGM-Upload': jr.uploadToken };
    const html = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.html', '<script>alert(1)</script>', 'text/html') });
    assert.equal(html.status, 400, 'html refused');
    const fakePdf = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.pdf', '<script>alert(1)</script>', 'application/pdf') });
    assert.equal(fakePdf.status, 400, 'a pdf that is not a pdf');
    const svgTxt = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('x.txt', '<svg onload=alert(1)>', 'text/plain') });
    assert.equal(svgTxt.status, 400, 'markup in a text file');
    const png = await fetch(base + '/api/upload', { method: 'POST', headers: h, body: form('chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), 'image/png') });
    assert.equal(png.status, 200);
    const up = await png.json();
    const served = await fetch(base + up.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    const sent = await emit(research, 'message', { type: 'file', url: up.url, filename: 'chart.png', mime: 'text/html' });
    assert.ok(sent.ok);
    const traversal = await fetch(base + '/uploads/..%2Fserver.js');
    assert.equal(traversal.status, 404);
  });

  await t.test('a reconnecting client gets just what it missed', async () => {
    const late = await connect(base); sockets.push(late);
    const first = await emit(late, 'join', { roomCode: code, name: 'Obs', role: 'observer' });
    assert.ok(Array.isArray(first.history));
    late.close();
    await emit(research, 'message', { type: 'text', text: 'while you were away' });
    const again = await connect(base); sockets.push(again);
    const back = await emit(again, 'join', { roomCode: code, name: 'Obs', role: 'observer', uid: first.identity, since: first.seq });
    assert.ok(Array.isArray(back.ops), 'delta, not history');
    assert.ok(back.ops.some((op) => op.o === 'add' && op.m.text === 'while you were away'));
    assert.ok(!back.history);
  });

  await t.test('observers read but do not post', async () => {
    const o = await connect(base); sockets.push(o);
    await emit(o, 'join', { roomCode: code, name: 'Watcher', role: 'observer' });
    assert.equal((await emit(o, 'message', { type: 'text', text: 'hi' })).ok, false);
  });

  await t.test('locked rooms need an invite for board and research', async () => {
    const adminSock = await connect(base, cookie); sockets.push(adminSock);
    const lock = await emit(adminSock, 'admin:lockRoles', { roomCode: code, on: true });
    assert.ok(lock.ok && lock.invites.board.includes('invite='));
    const a = await connect(base); sockets.push(a);
    const noInvite = await emit(a, 'join', { roomCode: code, name: 'Gate', role: 'board' });
    assert.equal(noInvite.role, 'observer');
    const b = await connect(base); sockets.push(b);
    const inv = new URL(base + lock.invites.board).searchParams.get('invite');
    const withInvite = await emit(b, 'join', { roomCode: code, name: 'Director 2', role: 'board', invite: inv });
    assert.equal(withInvite.role, 'board');
    const wrongRole = await connect(base); sockets.push(wrongRole);
    const misuse = await emit(wrongRole, 'join', { roomCode: code, name: 'Sneaky', role: 'research', invite: inv });
    assert.equal(misuse.role, 'observer', 'a board invite is not a research invite');
    await emit(adminSock, 'admin:lockRoles', { roomCode: code, on: false });
  });

  await t.test('the admin page closing the hall it is watching gets its answer and stays connected; the hall\'s people are sent home', async () => {
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const ask = (s, ev) => new Promise((resolve) => { s.emit(ev, resolve); });
    const page = await connect(base, cookie); sockets.push(page);
    const other = await connect(base, cookie); sockets.push(other);   // a second admin tab on the same hall
    const made = await emit(page, 'admin:createRoom', { name: 'Close me' });
    assert.ok((await emit(page, 'admin:watchRoom', { roomCode: made.code })).ok);
    assert.ok((await emit(other, 'admin:watchRoom', { roomCode: made.code })).ok);
    const member = await connect(base); sockets.push(member);
    assert.ok((await emit(member, 'join', { roomCode: made.code, name: 'Last one', role: 'board' })).ok);
    const kicked = [];
    page.on('kicked', (k) => kicked.push(k));
    other.on('kicked', (k) => kicked.push(k));
    const memberKicked = new Promise((resolve) => { member.once('kicked', resolve); });
    const memberGone = new Promise((resolve) => { member.once('disconnect', resolve); });
    const otherTold = new Promise((resolve) => { other.once('roomClosed', resolve); });
    const answer = await Promise.race([emit(page, 'admin:deleteRoom', { roomCode: made.code, purgeFiles: false }), wait(3000).then(() => 'no answer')]);
    assert.deepEqual({ answer, connected: page.connected }, { answer: { ok: true, purged: 0 }, connected: true });
    assert.deepEqual(await otherTold, { code: made.code }, 'the other admin tab is told, not cut off');
    assert.equal((await memberKicked).reason, 'This meeting was closed by the admin.');
    assert.equal(await memberGone, 'io server disconnect');
    const rooms = await ask(page, 'admin:listRooms');
    assert.ok(rooms.ok && !rooms.rooms.some((r) => r.code === made.code));
    assert.ok((await ask(other, 'admin:listRooms')).ok && other.connected);
    assert.deepEqual(kicked, [], 'no admin page was sent home');
  });

  await t.test('AI and stage refuse politely when not configured', async () => {
    const d = await emit(research, 'ai:draft', { question: 'What was capex?' });
    assert.equal(d.ok, false);
    assert.match(d.error, /API key/);
    assert.equal((await emit(board, 'ai:draft', {})).ok, false, 'board cannot draft');
    const s = await emit(research, 'stage:send', { text: 'Hello' });
    assert.equal(s.ok, false);
  });

  await t.test('flooding is rate limited', async () => {
    let refused = 0;
    const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => emit(research, 'message', { type: 'text', text: 'spam ' + i })));
    for (const a of acks) if (!a.ok) refused++;
    assert.ok(refused > 10, 'refused ' + refused);
  });

  await t.test('guessing room codes locks out', async () => {
    let last;
    for (let i = 0; i < 14; i++) last = await fetch(base + '/api/rooms/ZZZZZ' + (i % 10));
    assert.equal(last.status, 429);
  });

  const ctl = await connect(base, cookie); sockets.push(ctl);
  await t.test('Show Bus context: token or admin only, counts and prompt questions — no messages, names or room names', async () => {
    assert.equal((await fetch(base + '/api/context')).status, 401);
    assert.equal((await fetch(base + '/api/context', { headers: { authorization: 'Bearer agn_wrong' } })).status, 401);
    await new Promise((r) => setTimeout(r, 1500));   // the flood test above emptied this person's rate limit
    const posted = await emit(research, 'message', { type: 'action', text: 'Refer to slide 14?', options: ['Yes', 'No'] });
    assert.ok(posted.ok, 'prompt posted: ' + JSON.stringify(posted));
    const settings = await emit(ctl, 'admin:settings', null);
    assert.match(settings.contextToken, /^agn_/);
    assert.match(settings.nodeId, /^[0-9a-f]{8}$/);
    const r = await fetch(base + '/api/context', { headers: { authorization: 'Bearer ' + settings.contextToken } });
    assert.equal(r.status, 200);
    const ctx = await r.json();
    assert.equal(ctx.v, 1);
    assert.equal(ctx.node.t, 'messenger');
    assert.equal(ctx.node.id, settings.nodeId);
    assert.ok(['green', 'amber', 'red', 'grey'].includes(ctx.light));
    assert.ok(ctx.items.some((i) => i.kind === 'prompt' && /Refer to slide 14/.test(i.state)), 'open prompt questions are listed');
    const text = JSON.stringify(ctx);
    for (const secret of ['Capex is on slide 14', 'Chair', 'Ana', 'AGM 2026', code]) assert.ok(!text.includes(secret), 'context leaks ' + secret);
    const viaCookie = await fetch(base + '/api/context', { headers: { cookie } });
    assert.equal(viaCookie.status, 200);
  });

  await t.test('health: up/down for anyone, the detail only for the admin or this laptop', async () => {
    const local = await (await fetch(base + '/api/health')).json();
    assert.ok(local.ok && 'restarts' in local && 'loopMs' in local, 'detail on the host');
    const remote = await (await fetch(base + '/api/health', { headers: { 'cf-connecting-ip': '203.0.113.9' } })).json();
    assert.deepEqual(Object.keys(remote).sort(), ['build', 'ok', 'uptime', 'version']);
    assert.ok(remote.build.startsWith(remote.version + '-dev') || remote.build.startsWith(remote.version + '+'), 'the build names its version and channel: ' + remote.build);
  });

  await t.test('saved keys are sealed at rest, never in clear', async () => {
    await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:1', stagewatchKey: 'swk_secretvalue123', aiKey: 'sk-ant-secret' });
    await new Promise((r) => setTimeout(r, 400));   // the write lane coalesces for 100 ms
    const onDisk = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    assert.ok(!onDisk.includes('swk_secretvalue123') && !onDisk.includes('sk-ant-secret'), 'no clear keys on disk');
    assert.match(onDisk, /enc1:/);
    const s2 = await emit(ctl, 'admin:settings', null);
    assert.equal(s2.stagewatchKeySet, true);
    await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '', aiKey: '' });
  });

  await t.test('send to stage: the receipt, then the speaker\'s acknowledgement, show on the message that was sent', async () => {
    const http = require('http');
    const { WebSocketServer } = require('ws');
    let ws = null;
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/message/')) return res.end(JSON.stringify({ type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', refs: { messageId: 77 } }));
      res.end('{"ok":true}');
    });
    const wss = new WebSocketServer({ server: fake, path: '/ws' });
    wss.on('connection', (c) => { ws = c; c.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })); });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    try {
      await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:' + fake.address().port, stagewatchKey: 'swk_node' });
      for (let i = 0; i < 60; i++) { if (ws) break; await new Promise((r) => setTimeout(r, 50)); }
      assert.ok(ws, 'AGMessage linked to the fake Stagewatch');
      await new Promise((r) => setTimeout(r, 300));
      const acks = [];
      board.on('stageAck', (a) => acks.push(a));
      const sent = await emit(research, 'stage:send', { text: 'Capex was 4.2m' });
      assert.deepEqual([sent.ok, sent.stage, sent.messageId], [true, 'applied', 77]);
      ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '04:59', title: 'Keynote', messageId: 77, messageAck: 'done', messageAckBy: 'Sam' }));
      for (let i = 0; i < 60 && !acks.some((a) => a.stage.ack === 'done'); i++) await new Promise((r) => setTimeout(r, 50));
      const done = acks.find((a) => a.stage.ack === 'done');
      assert.ok(done, 'acknowledgement reached the room: ' + JSON.stringify(acks));
      assert.deepEqual([done.stage.by, done.stage.receipt, done.stage.ref], ['Sam', 'applied', 77]);
    } finally {
      board.removeAllListeners('stageAck');
      await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '' });
      wss.close(); fake.close();
    }
  });

  await t.test('HTTPS on the same port: pages, Socket.io, /tls and the certificate; the fingerprint in health and settings', async () => {
    const tlsmod = require('../lib/tls');
    const probe = await tlsmod.probeCertificate('127.0.0.1', port);
    const pinned = tlsmod.pinnedTlsOptions(probe.pem, probe.fp);
    const page = await tlsmod.request(`https://127.0.0.1:${port}/app.html`, { tls: pinned });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/i);
    const cer = await fetch(base + '/tls.cer');
    assert.equal(cer.headers.get('content-type'), 'application/pkix-cert');
    assert.equal(tlsmod.fingerprint(Buffer.from(await cer.arrayBuffer())), probe.fp, '/tls.cer is the certificate served');
    const info = await (await fetch(base + '/tls')).text();
    assert.ok(info.includes(probe.fp.slice(7, 9).toUpperCase() + ':'), 'the /tls page shows the fingerprint');
    const s = await emit(ctl, 'admin:settings', null);
    assert.deepEqual([s.tls.on, s.tls.fingerprint], [true, probe.fp]);
    // Socket.io over TLS, trusting exactly this certificate.
    const sec = io(`https://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, ca: probe.pem });
    await new Promise((resolve, reject) => { sec.once('connect', resolve); sec.once('connect_error', reject); });
    sec.close();
    // Require HTTPS never locks this laptop out (loopback), and only takes effect with a certificate.
    const on = await emit(ctl, 'admin:settings', { requireHttps: true });
    assert.equal(on.tls.requireHttps, true);
    assert.equal((await fetch(base + '/app.html')).status, 200, 'plain HTTP still works from this machine');
    await emit(ctl, 'admin:settings', { requireHttps: false });
  });

  await t.test('show desk: a proposal\'s state follows on the message; an approved notice for AGMessage runs once and reports', async () => {
    const http = require('http');
    const { WebSocketServer } = require('ws');
    let state = 'pending';
    const seen = { proposals: [], results: [] };
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/proposals' && req.method === 'POST') { seen.proposals.push(JSON.parse(body)); return res.end(JSON.stringify({ id: 'p17', state: 'pending' })); }
        // As Stagewatch's SharedProposal.ToJson: result and words one string, ok at the top level (null until it ran).
        if (u.pathname === '/api/proposals/p17') { const words = state === 'done' ? 'Message on the speaker screen' : ''; return res.end(JSON.stringify({ id: 'p17', state, decidedBy: 'SM', result: words, ok: state === 'done' ? true : null, words })); }
        if (u.pathname === '/api/proposals' && u.searchParams.get('target'))
          return res.end(JSON.stringify(seen.results.length ? [] : [{ id: 'p9', state: 'approved', line: 'notice "Break in 5 minutes"', decidedBy: 'SM', target: { t: 'messenger', id: u.searchParams.get('target') } }]));
        if (u.pathname === '/api/proposals') return res.end('[]');
        if (u.pathname === '/api/proposals/p9/result') { seen.results.push(JSON.parse(body)); return res.end('{"ok":true}'); }
        res.end('{"ok":true}');
      });
    });
    const wss = new WebSocketServer({ server: fake, path: '/ws' });
    wss.on('connection', (c) => c.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })));
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const updates = [];
    const notices = [];
    research.on('proposalUpdate', (u) => updates.push(u));
    board.on('system', (m) => { if (/From the show desk/.test(m.text)) notices.push(m.text); });
    try {
      await emit(ctl, 'admin:settings', { stagewatchUrl: '127.0.0.1:' + fake.address().port, stagewatchKey: 'swk_node' });
      // The desk is found on the next tick (within ~3 s); proposals are refused until then.
      let r;
      for (let i = 0; i < 40; i++) { r = await emit(research, 'stage:propose', { text: 'Capex was "4.2m"', urgency: 'warn' }); if (r.ok) break; await new Promise((x) => setTimeout(x, 200)); }
      assert.ok(r.ok, 'proposed: ' + JSON.stringify(r));
      assert.deepEqual([r.proposal.id, r.proposal.state], ['p17', 'pending']);
      const sent = seen.proposals[0];
      assert.equal(sent.target.t, 'main');
      // Stagewatch's grammar: a quote inside can't end the text, and the flash ("off") comes before "ack" — an "ack" in the
      // flash's place is refused by Stagewatch ("flash must be off|slow|fast"), the defect 0.4 shipped.
      assert.equal(sent.line, 'message "Capex was \'4.2m\'" warn off ack');
      assert.deepEqual(require('../lib/stagelines').parse(sent.line), { verb: 'message', text: 'Capex was \'4.2m\'', urgency: 'warn', flash: 'off', ack: true });
      assert.equal(sent.from.t, 'messenger');
      state = 'done';
      for (let i = 0; i < 100 && !updates.some((u) => u.proposal.state === 'done'); i++) await new Promise((x) => setTimeout(x, 100));
      const done = updates.find((u) => u.proposal.state === 'done');
      assert.ok(done, 'the state reached the research view: ' + JSON.stringify(updates));
      assert.deepEqual([done.proposal.by, done.proposal.ok, done.proposal.words], ['SM', true, 'Message on the speaker screen']);
      for (let i = 0; i < 100 && !seen.results.length; i++) await new Promise((x) => setTimeout(x, 100));
      assert.deepEqual(seen.results[0], { ok: true, words: 'shown in 1 meeting' });
      assert.ok(notices.some((n) => /approved by SM\): Break in 5 minutes/.test(n)), 'the notice is in the meeting: ' + JSON.stringify(notices));
      const ctx = await (await fetch(base + '/api/context', { headers: { cookie } })).json();
      assert.ok(ctx.commands.some((c) => c.verb === 'notice <text>' && c.risk === 'review'), 'its context says what may be proposed to it');
    } finally {
      research.removeAllListeners('proposalUpdate');
      board.removeAllListeners('system');
      await emit(ctl, 'admin:settings', { stagewatchUrl: '', stagewatchKey: '' });
      wss.close(); fake.close();
    }
  });

  await t.test('history survives a restart (log replay)', async () => {
    sockets.forEach((s) => s.close());
    await stop(child);
    child = await startServer(dataDir, port);
    const s = await connect(base); sockets.push(s);
    const j = await emit(s, 'join', { roomCode: code, name: 'Chair', role: 'board', uid: jb.identity });
    assert.ok(j.ok);
    assert.equal(j.uid, jb.uid, 'same person after restart');
    assert.ok(j.history.some((m) => m.text === 'Capex is on slide 14'));
    assert.ok(j.history.some((m) => m.text === 'while you were away'));
    assert.ok(!j.history.some((m) => m.text === 'delete me'));
    assert.ok(j.seq > seqAfterHello);
  });
});
