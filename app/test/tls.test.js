'use strict';
// Show Bus 1.2: encrypted connections (§10) and the shared approval queue (§11) — the pure parts, then the Stagewatch
// link against a fake Stagewatch desk that speaks HTTPS and WSS.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { WebSocketServer } = require('ws');
const tlsmod = require('../lib/tls');
const nodes = require('../lib/nodes');

const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('certificate: a self-signed P-256 server certificate Node parses, verifies and serves', () => {
  const { certDer, keyPem } = tlsmod.makeCertificate({ name: 'AGMessage LAPTOP', hosts: ['laptop', 'localhost'], ips: ['127.0.0.1', '10.0.0.5'] });
  const x = new crypto.X509Certificate(certDer);
  assert.equal(x.subject, 'CN=AGMessage LAPTOP');
  assert.ok(x.verify(x.publicKey), 'self-signed signature verifies');
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(keyPem)), 'the key matches');
  assert.equal(x.ca, false);
  assert.match(x.subjectAltName, /DNS:laptop.*DNS:localhost.*IP Address:127\.0\.0\.1.*IP Address:10\.0\.0\.5/);
  assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'server authentication');
  const days = (new Date(x.validTo) - Date.now()) / 86400000;
  assert.ok(days > 820 && days < 830, 'about 825 days (Apple devices refuse longer): ' + days);
  assert.match(tlsmod.fingerprint(certDer), tlsmod.FP_RE);
});

test('certificate: made once, kept sealed outside the app folder, reused, renewed on request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-tls-'));
  const seal = (s) => 'sealed:' + Buffer.from(s).toString('base64');
  const open = (s) => (String(s).startsWith('sealed:') ? Buffer.from(s.slice(7), 'base64').toString() : '');
  const a = tlsmod.loadOrCreate({ dir, name: 'A', seal, open });
  const b = tlsmod.loadOrCreate({ dir, name: 'A', seal, open });
  assert.ok(a.created && !b.created && a.fp === b.fp, 'the same certificate on the next start');
  assert.ok(!fs.readFileSync(path.join(dir, 'tls.json'), 'utf8').includes('PRIVATE KEY'), 'the private key is never stored in clear');
  const c = tlsmod.loadOrCreate({ dir, name: 'A', seal, open, renew: true });
  assert.ok(c.created && c.fp !== a.fp, 'renew makes a new one');
  const d = tlsmod.loadOrCreate({ dir, name: 'A', seal, open, now: new Date(Date.now() + 800 * 86400000) });
  assert.ok(d.created && d.fp !== c.fp, 'renewed automatically when it is about to end');
});

test('pins: trust on first authenticated use; a change is refused until accepted', () => {
  const fpA = 'sha256:' + 'a'.repeat(64);
  const fpB = 'SHA256:' + 'B'.repeat(64).match(/../g).join(':');   // as a person might type it
  const pins = new tlsmod.PinStore();
  assert.deepEqual(pins.check('node:sw1', fpA), { ok: true, firstUse: true });
  assert.equal(pins.check('node:sw1', fpA, fpB).ok, false, 'must match what its hello (or the admin) announced');
  assert.ok(pins.confirm('node:sw1', fpA));
  assert.ok(!pins.confirm('node:sw1', tlsmod.cleanFingerprint(fpB)), 'a pin is never silently replaced');
  const changed = pins.check('node:sw1', fpB);
  assert.ok(!changed.ok && changed.changed && /CERTIFICATE CHANGED/.test(changed.reason));
  pins.accept('node:sw1', fpB);
  assert.ok(pins.check('node:sw1', fpB).ok, 'the admin accepted the new one');
  assert.equal(tlsmod.cleanFingerprint('not a fingerprint'), '');
  assert.equal(new tlsmod.PinStore(JSON.parse(JSON.stringify(pins))).pins['node:sw1'], 'sha256:' + 'b'.repeat(64), 'pins persist as JSON');
});

test('AG-1: the start of a fingerprint a person types — at least 8 hex characters, any case, with colons or "sha256:"', () => {
  const fp = 'sha256:' + '0123456789abcdef'.repeat(4);
  assert.equal(tlsmod.typedFingerprint('SHA256:01:23:45:67'), '01234567');
  assert.equal(tlsmod.typedFingerprint(fp), fp.slice(7), 'the whole of it');
  for (const s of ['', '0123456', 'not hex!', 'g1234567', fp + '00', null, undefined]) assert.equal(tlsmod.typedFingerprint(s), '', String(s));
  assert.ok(tlsmod.fingerprintStarts(fp, '01 23 45 67 89'));
  assert.ok(tlsmod.fingerprintStarts(fp, fp.toUpperCase()));
  for (const typed of ['1234567', '12345678', '0123456', 'fedcba98', '']) assert.ok(!tlsmod.fingerprintStarts(fp, typed), typed + ': not its start, or too short');
  assert.ok(!tlsmod.fingerprintStarts('not a fingerprint', '01234567'));
});

test('Require HTTPS: plain HTTP only from this machine; pages redirect, the API is refused', () => {
  const g = (o) => tlsmod.httpsGate({ required: true, on: true, encrypted: false, loopback: false, host: '10.0.0.5:3023', ...o });
  assert.deepEqual(g({ path: '/app.html' }), { redirect: 'https://10.0.0.5:3023/app.html' });
  assert.ok(g({ path: '/api/context' }).refuse);
  assert.ok(g({ path: '/x', method: 'POST' }).refuse);
  assert.ok(g({ loopback: true }).allow, 'the host laptop and the Cloudflare tunnel (local) keep plain HTTP');
  assert.ok(g({ encrypted: true }).allow);
  assert.ok(g({ required: false }).allow);
  assert.ok(g({ on: false }).allow, 'never locks people out when HTTPS is off');
  assert.ok(g({ host: 'evil"<x>', path: '/' }).redirect === 'https://evilx/', 'the host header is cleaned');
});

test('show bus: hellos carry the certificate; proposals read tolerantly', () => {
  const fp = 'sha256:' + 'c'.repeat(64);
  const h = nodes.parseHello({ t: 'main', v: 1, id: 'sw1', name: 'Hall A', ports: { http: 9924, https: 9924 }, caps: ['approvals'], tls: fp }, '10.0.0.9');
  assert.equal(h.tls, fp);
  assert.equal(h.ports.https, 9924);
  assert.equal(nodes.parseHello({ t: 'main', v: 1, id: 'sw1', tls: 'junk' }, 'x').tls, '');
  const d = new nodes.Discovery({ id: 'ag1', port: 3023, name: 'AGMessage', tls: fp });
  assert.deepEqual([d.hello().tls, d.hello().ports.https], [fp, 3023]);
  assert.ok(d.hello().caps.includes('proposals'));
  const p = nodes.readProposal({ id: 'p1', state: 'done', decidedBy: 'SM', result: { ok: true, words: 'Message on the speaker screen' } });
  assert.deepEqual([p.state, p.decidedBy, p.ok, p.words], ['done', 'SM', true, 'Message on the speaker screen']);
  assert.equal(nodes.readProposal({ id: 'p2', state: 'nonsense' }).state, 'pending');
  assert.equal(nodes.readProposal({ state: 'done' }), null);
  assert.equal(nodes.readProposalList({ proposals: [{ id: 'a' }, null, { id: 'b' }] }).length, 2);
  assert.equal(nodes.readProposalList([{ id: 'a' }]).length, 1);
});

// ---------------------------------------------------------------- a fake Stagewatch desk over HTTPS / WSS

function fakeDesk({ cert }) {
  const seen = { auth: [], proposals: [], results: [], plain: 0 };
  let state = 'pending';
  const handler = (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.auth.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      const u = new URL(req.url, 'https://x');
      if (u.pathname === '/api/context') return res.end(JSON.stringify({ v: 1, node: { t: 'main', id: 'sw1', name: 'Hall A' }, light: 'green', headline: 'Keynote', peers: [] }));
      if (u.pathname === '/api/proposals' && req.method === 'POST') { seen.proposals.push(JSON.parse(body)); return res.end(JSON.stringify({ id: 'p17', state: 'pending' })); }
      if (u.pathname === '/api/proposals/p17') return res.end(JSON.stringify({ id: 'p17', state, decidedBy: 'SM', result: state === 'done' ? { ok: true, words: 'Message on the speaker screen' } : null }));
      if (u.pathname === '/api/proposals' && u.searchParams.get('target')) return res.end(JSON.stringify({ proposals: [{ id: 'p9', state: 'approved', line: 'notice "Break in 5 minutes"', decidedBy: 'SM' }] }));
      if (u.pathname === '/api/proposals') return res.end('[]');
      if (u.pathname === '/api/proposals/p9/result') { seen.results.push(JSON.parse(body)); return res.end('{"ok":true}'); }
      res.end(JSON.stringify({ type: 'receipt', id: req.headers['x-request-id'], ok: true, stage: 'applied', refs: { messageId: 5 } }));
    });
  };
  const srv = https.createServer({ cert: tlsmod.toPem(cert.certDer), key: cert.keyPem }, handler);
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 })));
  return { srv, wss, seen, setState: (s) => { state = s; } };
}

test('Stagewatch link over TLS: pinned before the key is sent, proposals to the desk, a changed certificate refused', async () => {
  const certA = tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const fpA = tlsmod.fingerprint(certA.certDer);
  let desk = fakeDesk({ cert: certA });
  await new Promise((r) => desk.srv.listen(0, '127.0.0.1', r));
  const port = desk.srv.address().port;
  const pins = new tlsmod.PinStore();
  let pinSaves = 0;
  // Its hello says it serves TLS with certificate A (as Stagewatch 2.16 announces).
  const hello = { t: 'main', id: 'sw1', address: '127.0.0.1', ports: { http: port, https: port }, caps: ['approvals'], tls: fpA };
  const link = new nodes.StagewatchLink({ findPeer: (t, h, p) => (t === 'main' && h === '127.0.0.1' && p === port ? hello : null), pins, onPins: () => { pinSaves++; } });
  try {
    link.configure('127.0.0.1:' + port, 'swk_node');
    assert.ok(await until(() => link.linked), 'linked over wss');
    assert.ok(link.tlsState.on && link.tlsState.fp === fpA);
    assert.ok(await until(() => pins.pins['node:sw1'] === fpA), 'pinned on first authenticated use');
    assert.ok(pinSaves >= 1);
    const rc = await link.sendToStage('Two minutes');
    assert.deepEqual([rc.ok, rc.messageId], [true, 5], 'a stage message over https');
    assert.ok(desk.seen.auth.every((a) => a === 'Bearer swk_node'));

    // The desk (Show Bus §11).
    assert.ok(await link.checkDesk('ag1'), 'Stagewatch keeps the approval queue (its hello says so)');
    const pr = await link.propose({ from: { t: 'messenger', id: 'ag1' }, target: { t: 'main' }, line: 'message "Two minutes" warn ack', reason: 'test', risk: 'review' });
    assert.deepEqual([pr.ok, pr.proposal.id, pr.proposal.state], [true, 'p17', 'pending']);
    desk.setState('done');
    const after = await link.proposal('p17');
    assert.deepEqual([after.state, after.words, after.decidedBy], ['done', 'Message on the speaker screen', 'SM']);
    const todo = await link.approvedFor('ag1');
    assert.equal(todo[0].line, 'notice "Break in 5 minutes"');
    assert.ok(await link.reportResult('p9', true, 'shown in 1 meeting'));
    assert.deepEqual(desk.seen.results[0], { ok: true, words: 'shown in 1 meeting' });

    // Stagewatch comes back with a different certificate: refused before anything — the key above all — is sent.
    for (const c of desk.wss.clients) c.terminate();   // Stagewatch goes away (as a restart would)
    desk.wss.close(); desk.srv.close();
    const certB = tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });
    desk = fakeDesk({ cert: certB });
    await new Promise((r) => desk.srv.listen(port, '127.0.0.1', r));
    hello.tls = tlsmod.fingerprint(certB.certDer);   // even its hello agrees: the pin decides
    assert.ok(await until(() => link.tlsState.changed, 8000), 'CERTIFICATE CHANGED: ' + JSON.stringify(link.tlsState));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(desk.seen.auth.length, 0, 'not one request reached the new certificate');
    assert.ok(!link.linked);
    assert.ok(link.acceptCertificate(), 'the admin accepts it');
    assert.ok(await until(() => link.linked, 5000), 'linked again');
    assert.equal(pins.pins['node:sw1'], tlsmod.fingerprint(certB.certDer));
  } finally { link.stop(); desk.wss.close(); desk.srv.close(); }
});

test('Stagewatch link: a typed fingerprint guards the very first connection', async () => {
  const cert = tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const desk = fakeDesk({ cert });
  await new Promise((r) => desk.srv.listen(0, '127.0.0.1', r));
  const link = new nodes.StagewatchLink({ pins: new tlsmod.PinStore() });
  try {
    link.configure('https://127.0.0.1:' + desk.srv.address().port, 'swk_node', 'sha256:' + '0'.repeat(64));
    assert.ok(await until(() => !!link.tlsState.problem, 4000));
    assert.match(link.tlsState.problem, /does not match/);
    assert.equal(desk.seen.auth.length, 0, 'nothing sent to a certificate that is not the one typed');
    link.configure('https://127.0.0.1:' + desk.srv.address().port, 'swk_node', tlsmod.fingerprint(cert.certDer));
    assert.ok(await until(() => link.linked, 4000), 'the right fingerprint links');
  } finally { link.stop(); desk.wss.close(); desk.srv.close(); }
});

test('one port: HTTP and HTTPS side by side, Socket.io-sized upgrades included', async () => {
  const c = tlsmod.makeCertificate({ name: 't', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const app = http.createServer((req, res) => res.end(JSON.stringify({ enc: !!req.socket.encrypted })));
  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (ws) => ws.send('hi'));
  const front = tlsmod.dualPortServer(app, { certPem: tlsmod.toPem(c.certDer), keyPem: c.keyPem });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const port = front.address().port;
  try {
    const plain = await tlsmod.request('http://127.0.0.1:' + port + '/');
    const probe = await tlsmod.probeCertificate('127.0.0.1', port);
    const enc = await tlsmod.request('https://127.0.0.1:' + port + '/', { tls: tlsmod.pinnedTlsOptions(probe.pem, probe.fp) });
    assert.deepEqual([plain.body.enc, enc.body.enc, probe.fp], [false, true, tlsmod.fingerprint(c.certDer)]);
    const WebSocket = require('ws');
    const got = await new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://127.0.0.1:' + port + '/', tlsmod.pinnedTlsOptions(probe.pem, probe.fp));
      ws.on('message', (m) => { resolve(String(m)); ws.close(); });
      ws.on('error', reject);
    });
    assert.equal(got, 'hi', 'wss on the same port');
  } finally { wss.close(); front.close(); }
});

// ---------------------------------------------------------------- a pinned node is never talked to in plain HTTP

/** A node serving HTTP and HTTPS on one port (as Stagewatch, Patterns and PlayMap do), recording how each request came. */
async function dualNode({ cert, context }) {
  const seen = [];
  const app = http.createServer((req, res) => {
    seen.push({ url: req.url, encrypted: !!req.socket.encrypted, token: req.headers['x-playmap-token'] || '', auth: req.headers.authorization || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(context));
  });
  const wss = new WebSocketServer({ server: app, path: '/ws' });
  wss.on('connection', (ws, req) => {
    seen.push({ url: req.url, encrypted: !!req.socket.encrypted, auth: req.headers.authorization || '', upgrade: true });
    ws.send(JSON.stringify({ type: 'state', mode: 'countdown', text: '05:00', title: 'Keynote', messageId: 0 }));
  });
  const front = tlsmod.dualPortServer(app, { certPem: tlsmod.toPem(cert.certDer), keyPem: cert.keyPem });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  return { port: front.address().port, seen, close: () => { wss.close(); front.close(); } };
}

test('C17: a PlayMap pinned over TLS is never polled in plain HTTP after a restart or while its hello is not heard', async () => {
  const peerlinks = require('../lib/peerlinks');
  const cert = tlsmod.makeCertificate({ name: 'PlayMap', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const fp = tlsmod.fingerprint(cert.certDer);
  const node = await dualNode({ cert, context: { v: 1, node: { t: 'playmap', id: 'pm1', name: 'Stage left' }, light: 'green', headline: 'Playing', commands: [] } });
  const token = 'pm-secret-token';   // secret-scan: fixture
  // Linked over http:// (before the node turned TLS on); pinned since. AGMessage restarts: the hello is not heard yet.
  const pins = new tlsmod.PinStore({ 'node:pm1': fp });
  let hello = null;
  const link = new peerlinks.PeerLink({ node: { t: 'playmap', id: 'pm1', name: 'Stage left' }, base: 'http://127.0.0.1:' + node.port, token, pins, findPeer: () => hello });
  try {
    assert.ok(await until(() => link.status === 'live', 4000), 'live: ' + link.status + ' ' + link.problem);
    hello = { t: 'playmap', id: 'pm1', tls: fp, ports: { https: node.port } };
    await link.poll();
    hello = { t: 'playmap', id: 'pm1', tls: '', ports: { http: node.port } };   // a hello without tls (spoofed, or an old build)
    await link.poll();
    assert.ok(node.seen.length >= 3, 'polled: ' + node.seen.length);
    assert.ok(node.seen.every((r) => r.encrypted), 'every request with the token went over TLS: ' + JSON.stringify(node.seen.map((r) => r.encrypted)));
    assert.ok(link.endpoint && link.endpoint.tls, 'the link stays on pinned TLS');
    assert.equal(pins.pins['node:pm1'], fp, 'the pin is unchanged');
  } finally { link.stop(); node.close(); }

  // Never pinned, no tls heard: plain; its hello then announces a certificate: the next poll moves to TLS, no error needed.
  const node2 = await dualNode({ cert, context: { v: 1, node: { t: 'playmap', id: 'pm2', name: 'Stage right' }, light: 'green', headline: 'Playing', commands: [] } });
  let hello2 = null;
  const link2 = new peerlinks.PeerLink({ node: { t: 'playmap', id: 'pm2', name: 'Stage right' }, base: 'http://127.0.0.1:' + node2.port, token, pins: new tlsmod.PinStore(), findPeer: () => hello2 });
  try {
    assert.ok(await until(() => link2.status === 'live', 4000));
    assert.equal(node2.seen.at(-1).encrypted, false, 'nothing said TLS yet');
    hello2 = { t: 'playmap', id: 'pm2', tls: fp, ports: { https: node2.port } };
    await link2.poll();
    assert.equal(node2.seen.at(-1).encrypted, true, 'upgraded at the next poll');
  } finally { link2.stop(); node2.close(); }
});

test('C17: a Stagewatch pinned once opens no plain WebSocket with its key while its hello is not heard', async () => {
  const cert = tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const fp = tlsmod.fingerprint(cert.certDer);
  const sw = await dualNode({ cert, context: { v: 1, node: { t: 'main', id: 'sw1', name: 'Hall A' }, light: 'green', headline: 'Keynote', peers: [] } });
  const pins = new tlsmod.PinStore();
  const hello = { t: 'main', id: 'sw1', address: '127.0.0.1', ports: { http: sw.port, https: sw.port }, tls: fp };
  const first = new nodes.StagewatchLink({ findPeer: (t, h, p) => (t === 'main' && p === sw.port ? hello : null), pins });
  try {
    first.configure('127.0.0.1:' + sw.port, 'swk_secretnodekey');   // secret-scan: fixture
    assert.ok(await until(() => first.linked && !!pins.pins['node:sw1'], 4000), 'linked over wss and pinned');
  } finally { first.stop(); }
  sw.seen.length = 0;
  // AGMessage restarts (or the hello stops): the link's own address keeps its pin, so TLS is never dropped.
  const again = new nodes.StagewatchLink({ findPeer: () => null, pins });
  try {
    again.configure('127.0.0.1:' + sw.port, 'swk_secretnodekey');   // secret-scan: fixture
    assert.ok(await until(() => again.linked, 4000), 'linked again: ' + again.status);
    assert.ok(sw.seen.some((r) => r.upgrade), 'it dialled');
    assert.ok(sw.seen.filter((r) => r.auth).every((r) => r.encrypted), 'the key never went in clear: ' + JSON.stringify(sw.seen));
    assert.ok(again.tlsState.on && again.tlsState.fp === fp);
    again.forgetPins();   // the admin removes this Stagewatch: linked again, it trusts what it serves then
    assert.deepEqual(Object.keys(pins.pins), []);
  } finally { again.stop(); sw.close(); }
});
