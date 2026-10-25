'use strict';
// The show network under load and over time: a hello flood on UDP 9928 stays bounded (the peers table, what the admin
// page is pushed, the context every Stagewatch is posted); a Patterns certificate that changes is accepted only by the
// admin; and the show desk's ids — which a Stagewatch numbers from p1 again when it restarts — never carry over to
// another Stagewatch or another proposal. Its own file: UDP 9928 is a fixed port, and these wait on real clocks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nodes = require('../lib/nodes');
const { startServer, stopServer, api, connect, emit, answer, until, fakeStagewatch } = require('./helpers');

const PATTERNS_TOKEN = 'K7QM-3XWD-P9RA';   // secret-scan: fixture — a fake pairing token for the fake Patterns

test('C03: a flood of hellos with fresh ids neither grows the peers table without bound nor pushes it once per hello', async () => {
  let changes = 0;
  const d = new nodes.Discovery({ id: 'self0001', port: 1, name: 'x', announce: false, onChange: () => { changes++; } });
  d.start();
  try {
    const hello = (o, address) => d.sock.emit('message', Buffer.from(JSON.stringify({ v: 1, ...o })), { address });
    hello({ t: 'main', id: 'real01', name: 'Stagewatch' }, '10.0.0.5');
    for (let i = 0; i < 5000; i++) hello({ t: 'patterns', id: 'f' + i }, '10.0.0.66');
    for (let i = 0; i < 5000; i++) hello({ t: 'patterns', id: 'g' + i }, '10.1.' + (i >> 8) + '.' + (i & 255));
    hello({ t: 'main', id: 'real01', name: 'Stagewatch' }, '10.0.0.5');   // a peer already heard keeps refreshing
    assert.ok(d.peers.size <= nodes.MAX_PEERS, 'bounded: ' + d.peers.size);
    assert.ok(Array.from(d.peers.values()).filter((p) => p.address === '10.0.0.66').length <= nodes.MAX_PER_ADDRESS, 'a few ids per address');
    assert.ok(d.peers.has('real01'), 'the real peer heard first stays');
    assert.ok(d.dropped >= 10000 - nodes.MAX_PEERS, 'the rest are counted, not kept');
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    assert.ok(changes <= 2, 'the change is told at most twice a second, not per hello: ' + changes);
    const { buildContext } = require('../lib/context');
    const ctx = buildContext({ node: { id: 'a', name: 'b' }, rooms: [], peers: d.list(), recent: [] });
    assert.ok(ctx.peers.length <= 32, 'the context carries a bounded list of peers: ' + ctx.peers.length);
    assert.equal(ctx.peers[0].id, 'real01', 'live peers first, in the order they were heard');
  } finally { d.stop(); }
});

test('C03 end to end: a hello flood on UDP 9928 reaches the admin page and Stagewatch bounded and coalesced', async (t) => {
  const sw = await fakeStagewatch({ name: 'Flood timer' });
  const srv = await startServer({ AGM_NODES: '1' });
  const sockets = [];
  const udp = require('dgram').createSocket('udp4');
  t.after(async () => { udp.close(); sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  await emit(ctl, 'admin:settings', { stagewatchUrl: sw.url, stagewatchKey: 'swk_flood_node_key_00001' /* secret-scan: fixture */ });
  await until(() => sw.connected, 6000, 'Stagewatch linked');
  let pushes = 0, biggest = 0;
  ctl.on('nodes', (list) => { pushes++; biggest = Math.max(biggest, list.length); });
  const send = (o) => new Promise((resolve) => { udp.send(Buffer.from(JSON.stringify({ v: 1, ...o })), nodes.BUS_PORT, '127.0.0.1', () => resolve()); });
  for (let i = 0; i < 3000; i++) await send({ t: 'patterns', id: 'flood' + i });
  await new Promise((resolve) => { setTimeout(resolve, 2000); });
  const peers = (await emit(ctl, 'admin:settings', null)).peers;
  assert.ok(peers.length >= 1 && peers.length <= nodes.MAX_PER_ADDRESS, 'one address holds a few ids: ' + peers.length);
  assert.ok(pushes <= 10, 'the table is pushed a few times, not per hello: ' + pushes);
  assert.ok(biggest <= nodes.MAX_PER_ADDRESS);
  await until(() => sw.requests.some((r) => r.url === '/api/peers/context' && JSON.parse(r.body).peers.length > 0), 8000, 'the context names the peers');
  const posted = sw.requests.filter((r) => r.url === '/api/peers/context').map((r) => JSON.parse(r.body));
  assert.ok(posted.every((c) => c.peers.length <= 32), 'the context posted to Stagewatch stays bounded');
});

test('C20: a Patterns certificate that changes is refused until the admin types the start of the new one; unlinking forgets the pin', async (t) => {
  const https = require('https');
  const tlsmod = require('../lib/tls');
  const make = () => tlsmod.makeCertificate({ name: 'Patterns', hosts: ['localhost'], ips: ['127.0.0.1'] });
  let cert = make();
  const node = https.createServer({ cert: tlsmod.toPem(cert.certDer), key: cert.keyPem }, (req, res) => {
    if (req.headers['x-patterns-token'] !== PATTERNS_TOKEN) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ v: 1, node: { t: 'patterns', id: 'patx', name: 'Patterns TLS' }, light: 'green', headline: 'Programme', commands: [] }));
  });
  await new Promise((resolve) => { node.listen(0, '127.0.0.1', resolve); });
  const url = 'https://127.0.0.1:' + node.address().port;
  const renew = () => { cert = make(); node.setSecureContext({ cert: tlsmod.toPem(cert.certDer), key: cert.keyPem }); return tlsmod.fingerprint(cert.certDer); };
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); node.closeAllConnections(); await new Promise((resolve) => { node.close(resolve); }); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  await api(srv.base, 'POST', '/api/users', { username: 'sol', name: 'Sol Senior', role: 'senior', password: 'radio check one two' }, { cookie: admin });
  const sol = await connect(srv.base, (await api(srv.base, 'POST', '/api/auth/login', { username: 'sol', password: 'radio check one two' })).cookie); sockets.push(sol);
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  const view = async () => (await emit(ctl, 'nodes:list', {})).linked.find((n) => n.id === 'patx');
  const pinOnDisk = () => (JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8')).tlsPins || {})['node:patx'];

  assert.ok((await emit(ctl, 'nodes:link', { id: 'patx', t: 'patterns', url, name: 'Patterns TLS', token: PATTERNS_TOKEN })).ok);
  await until(async () => (await view()).status === 'live' && pinOnDisk() === tlsmod.fingerprint(cert.certDer), 8000, 'live and pinned');
  const fpB = renew();
  await until(async () => (await view()).status === 'refused', 15000, 'refused');
  const v = await view();
  assert.match(v.problem, /CERTIFICATE CHANGED/);
  assert.deepEqual([v.certificateWaits, v.certificateChanged, JSON.stringify(v).includes(fpB.slice(7, 23))], [true, true, false], 'the page is told a certificate waits, never which: its start is typed from the node\'s own screen');
  const typed = fpB.slice(7, 19).toUpperCase().match(/../g).join(':');   // as it reads on the node's screen
  assert.equal((await answer(sol, 'nodes:acceptCertificate', { id: 'patx', fingerprint: typed })).ok, false, 'accepting is the admin\'s');
  for (const fingerprint of [undefined, '', fpB.slice(7, 14), fpB.slice(8, 20)]) {
    const r = await answer(ctl, 'nodes:acceptCertificate', { id: 'patx', fingerprint });
    assert.equal(r.ok, false, String(fingerprint));
    assert.match(r.error, /not the first characters of the certificate Patterns TLS presents — type at least 8/, String(fingerprint));
  }
  assert.equal((await view()).status, 'refused', 'still refused');
  assert.deepEqual(await answer(ctl, 'nodes:acceptCertificate', { id: 'patx', fingerprint: typed }), { ok: true });
  await until(async () => (await view()).status === 'live', 8000, 'live again');
  await until(() => pinOnDisk() === fpB, 3000, 'the new certificate pinned');
  assert.deepEqual(await answer(ctl, 'nodes:acceptCertificate', { id: 'patx', fingerprint: typed }), { ok: false, error: 'No certificate of Patterns TLS waits to be confirmed.' }, 'nothing left to accept');
  assert.deepEqual(await answer(ctl, 'nodes:acceptCertificate', { id: 'nobody', fingerprint: typed }), { ok: false, error: 'Not linked.' });
  const audit = await api(srv.base, 'GET', '/api/audit?limit=50', undefined, { cookie: admin });
  assert.ok(audit.body.entries.some((e) => e.action === 'node.certificate' && e.target === 'patx' && /^accepted a changed patterns certificate of “Patterns TLS” \(the start of its fingerprint typed\)$/.test(e.words)));

  renew();
  assert.ok((await emit(ctl, 'nodes:unlink', { id: 'patx' })).ok);
  await until(() => pinOnDisk() === undefined, 3000, 'unlinking forgets the pin');
  assert.ok((await emit(ctl, 'nodes:link', { id: 'patx', t: 'patterns', url, name: 'Patterns TLS', token: PATTERNS_TOKEN })).ok);
  await until(async () => (await view()).status === 'live', 8000, 'linked again with the node\'s new certificate');
  await until(() => pinOnDisk() === tlsmod.fingerprint(cert.certDer), 3000, 'pinned to the new one');
});

test('C18: the show desk\'s ids are its own — after a Stagewatch restart or a hall moved to another one, nothing is skipped and nothing crosses', async (t) => {
  const sw1 = await fakeStagewatch({ name: 'Desk one', messageId: 4, failResults: 1 });
  const sw2 = await fakeStagewatch({ name: 'Desk two', messageId: 4 });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw1.close(); await sw2.close(); });
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const ctl = await connect(base, admin); sockets.push(ctl);
  assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw1.url, stagewatchKey: 'swk_desk_one_node_key_01' /* secret-scan: fixture */ })).ok);
  const crew = await connect(base); sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: hall, name: 'Alex', role: 'research' })).ok);
  const notices = [];
  const updates = [];
  const acks = [];
  crew.on('system', (m) => { if (/From the show desk/.test(m.text)) notices.push(m.text); });
  crew.on('proposalUpdate', (u) => updates.push(u.proposal));
  crew.on('stageAck', (a) => acks.push(a.stage));
  await until(() => sw1.requests.some((r) => r.url.includes('?target=')), 8000, 'AGMessage collects from the desk');
  const nodeId = new URL(sw1.requests.find((r) => r.url.includes('?target=')).url, 'http://x').searchParams.get('target');
  const forUs = (line) => ({ line, state: 'approved', decidedBy: 'SM', from: { t: 'main', id: 'swdesk', name: 'Desk one' }, target: { t: 'messenger', id: nodeId, name: 'AGMessage' } });

  await t.test('(d) a result the desk did not take is posted again, though the desk never lists that proposal again', async () => {
    const id = sw1.add(forUs('notice Break in five minutes'));
    await until(() => sw1.proposals.get(id).state === 'done', 15000, 'reported at the second try');
    assert.equal(notices.filter((n) => /Break in five minutes/.test(n)).length, 1, 'run once');
  });

  await t.test('(a) after Stagewatch restarts and numbers from p1 again, a new approved notice is still run and reported', async () => {
    sw1.restart();
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const id = sw1.add(forUs('notice Doors open'));
    assert.equal(id, 'p1');
    await until(() => notices.some((n) => /Doors open/.test(n)) && sw1.proposals.get(id).state === 'done', 15000, 'the new p1 run and reported');
  });

  let ours, sent;
  await t.test('(b, c) a hall moved to another Stagewatch: our proposal and our send take nothing from the new one\'s same numbers', async () => {
    ours = await emit(crew, 'stage:propose', { text: 'Wrap up please', destination: 'speaker' });
    assert.ok(ours.ok, JSON.stringify(ours));
    sent = await emit(crew, 'stage:send', { text: 'Two minutes' });
    assert.deepEqual([sent.ok, sent.messageId], [true, 4]);
    sw2.add({ id: ours.proposal.id, line: 'message "Something else" info off ack', state: 'approved', decidedBy: 'Someone at the new desk', from: { t: 'agent', id: 'slides1', name: 'Slides' }, target: { t: 'main' } });
    assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw2.url, stagewatchKey: 'swk_desk_two_node_key_02' /* secret-scan: fixture */ })).ok);
    await until(() => sw2.connected, 6000, 'moved');
    sw2.frame({ messageId: 4, messageAck: 'done', messageAckBy: 'Other speaker' });
    await until(() => updates.some((p) => p.id === ours.proposal.id && p.state === 'lost'), 15000, 'our proposal is lost, not someone else\'s decision');
    assert.ok(!updates.some((p) => p.by === 'Someone at the new desk'), JSON.stringify(updates));
    assert.match(updates.find((p) => p.state === 'lost').words, /no longer has this request/);
    assert.ok(!acks.some((a) => a.by === 'Other speaker'), 'another Stagewatch\'s message 4 acknowledges nothing of ours');
    const room = (await emit(ctl, 'admin:watchRoom', { roomCode: hall })).messages;
    assert.equal(room.find((m) => m.stage && m.stage.ref === 4).stage.ack, 'lost', 'no longer followed, and the record says so');
  });

  await t.test('(c) the same Stagewatch restarts (its frames\' seq goes back): a send to it before is not acknowledged by its new message of that number', async () => {
    sw2.frame({ messageId: 0, messageAck: '', messageAckBy: '', seq: 10 });
    const again = await emit(crew, 'stage:send', { text: 'One minute' });
    assert.deepEqual([again.ok, again.messageId], [true, 4]);
    sw2.frame({ seq: 3, messageId: 4, messageAck: 'done', messageAckBy: 'After a restart' });
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    assert.ok(!acks.some((a) => a.by === 'After a restart'));
    const third = await emit(crew, 'stage:send', { text: 'Thirty seconds' });
    assert.equal(third.ok, true);
    sw2.frame({ seq: 4, messageId: 4, messageAck: 'done', messageAckBy: 'Speaker B' });
    await until(() => acks.some((a) => a.by === 'Speaker B' && a.ack === 'done'), 4000, 'a send to the Stagewatch as it is now is followed');
  });
});

test('C18: a Stagewatch\'s numbers never cross a link made again, a restart or a number handed out twice; a line is followed as the desk keeps it', async (t) => {
  const sw1 = await fakeStagewatch({ name: 'Desk one', messageId: 4 });
  const sw2 = await fakeStagewatch({ name: 'Desk two', messageId: 4 });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw1.close(); await sw2.close(); });
  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const configure = async (sw, key) => assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw ? sw.url : '', stagewatchKey: key })).ok);
  await configure(sw1, 'swk_desk_one_node_key_01' /* secret-scan: fixture */);
  const crew = await connect(base); sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: hall, name: 'Alex', role: 'research' })).ok);
  const acks = [];
  const stages = [];
  crew.on('stageAck', (a) => acks.push(a.stage));
  crew.on('stage', (s) => stages.push(s));
  const roomMessages = async () => (await emit(ctl, 'admin:watchRoom', { roomCode: hall })).messages;
  await until(() => sw1.connected, 6000, 'hall linked');

  await t.test('a hall\'s Stagewatch removed, then another set: a send to the first is not acknowledged by the second\'s message of that number', async () => {
    const sent = await emit(crew, 'stage:send', { text: 'Two minutes' });
    assert.deepEqual([sent.ok, sent.messageId], [true, 4]);
    await configure(null);
    await configure(sw2, 'swk_desk_two_node_key_02' /* secret-scan: fixture */);
    await until(() => sw2.connected, 6000, 'linked again, to another Stagewatch');
    sw2.frame({ messageId: 4, messageAck: 'done', messageAckBy: 'Other speaker' });
    await until(() => stages.some((s) => s.messageAckBy === 'Other speaker'), 4000, 'the frame reached the hall');
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.ok(!acks.some((a) => a.by === 'Other speaker'), JSON.stringify(acks));
    assert.equal((await roomMessages()).find((m) => m.stage && m.stage.ref === 4 && /Two minutes/.test(m.text || '')).stage.ack, 'lost', 'no longer followed, and the record says so');
  });

  await t.test('a result the desk did not take before it restarted is never posted to its new proposal of the same number', async () => {
    await until(() => sw2.requests.some((r) => r.url.includes('?target=')), 8000, 'AGMessage collects from the desk');
    const nodeId = new URL(sw2.requests.find((r) => r.url.includes('?target=')).url, 'http://x').searchParams.get('target');
    const forUs = (line) => ({ line, state: 'approved', decidedBy: 'SM', from: { t: 'main', id: 'swdesk', name: 'Desk two' }, target: { t: 'messenger', id: nodeId, name: 'AGMessage' } });
    sw2.frame({ seq: 10, messageId: 0, messageAck: '', messageAckBy: '', text: '05:00' });
    sw2.failResults = 1000;   // the desk is busy: every result post fails until it restarts
    const first = sw2.add(forUs('bogus line for AGMessage'));
    await until(() => sw2.requests.some((r) => r.method === 'POST' && r.url === '/api/proposals/' + first + '/result'), 8000, 'run, its result not taken');
    // Stagewatch restarts: its queue is gone, it numbers from p1 again and its frames' seq starts again (heard before its
    // desk is asked, as a restarted Stagewatch's first frame always is: the link is down until it comes).
    sw2.restart();
    sw2.frame({ seq: 2, text: '04:00' });
    await until(() => stages.some((s) => s.text === '04:00'), 4000, 'the restarted Stagewatch\'s frame');
    const second = sw2.add(forUs('notice Doors open'));
    assert.equal(second, first, 'the same number, another proposal');
    await until(() => sw2.proposals.get(second).claimed, 8000, 'the new one collected (its result not taken yet either)');
    sw2.failResults = 0;
    await until(() => sw2.proposals.get(second).state !== 'approved', 12000, 'the new proposal reported');
    const p = sw2.proposals.get(second);
    assert.deepEqual([p.state, p.words], ['done', 'shown in 1 meeting'], 'its own result, not the one its number had before');
  });

  await t.test('a number the desk hands out twice (it restarted): the proposal followed under it before ends lost, never the new one\'s', async () => {
    sw2.restart();
    const before = await emit(crew, 'stage:propose', { text: 'Wrap up please', destination: 'speaker' });
    assert.ok(before.ok, JSON.stringify(before));
    sw2.restart();
    const after = await emit(crew, 'stage:propose', { text: 'Lights down', destination: 'speaker' });
    assert.deepEqual([after.ok, after.proposal.id], [true, before.proposal.id]);
    sw2.approve(after.proposal.id, 'Show caller');
    await until(async () => (await roomMessages()).some((m) => m.proposal && /Lights down/.test(m.text || '') && m.proposal.state === 'approved'), 12000, 'the new one approved');
    const old = (await roomMessages()).find((m) => m.proposal && /Wrap up please/.test(m.text || ''));
    assert.deepEqual([old.proposal.state, old.proposal.by], ['lost', ''], JSON.stringify(old.proposal));
  });

  await t.test('a line with a control character is the line the desk keeps: followed, not lost', async () => {
    const r = await emit(crew, 'stage:propose', { text: 'Mic\u0007 3 is\u0085live', destination: 'speaker' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(sw2.proposals.get(r.proposal.id).line, r.proposal.line, 'proposed exactly as the desk keeps it');
    sw2.approve(r.proposal.id, 'Show caller');
    await until(async () => (await roomMessages()).some((m) => m.proposal && m.proposal.id === r.proposal.id && m.proposal.at === r.proposal.at && m.proposal.state === 'approved'), 12000, 'approved');
  });
});

test('C22: until PlayMap\'s own risk rules are read, a line reaches the show desk as high — a busy /api/verbs is asked again', async (t) => {
  const { fakeNode } = require('./helpers');
  const PLAYMAP_TOKEN = 'pm-fake-pairing-token';   // secret-scan: fixture
  const decode = 'DECODE POLICY AUTO|DIRECT|GPU-COPY|COPY-BACK|SOFTWARE [FORCE]';
  const pm = await fakeNode({
    t: 'playmap', name: 'Stage right', token: PLAYMAP_TOKEN, commands: [{ verb: decode, risk: 'review' }], failVerbs: 1,
    verbs: [{ name: 'DECODE POLICY', syntax: decode, risk: 'review', riskWhen: [{ arg: -1, word: 'FORCE', risk: 'high' }] }],
  });
  const sw = await fakeStagewatch({ name: 'Hall desk' });
  const srv = await startServer();
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await pm.close(); await sw.close(); });
  const admin = (await api(srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  const ctl = await connect(srv.base, admin); sockets.push(ctl);
  assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall1_node_key_00009' /* secret-scan: fixture */ })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'playmap01', t: 'playmap', url: pm.url, name: 'Stage right', token: PLAYMAP_TOKEN, hall })).ok);
  await until(async () => { const n = (await emit(ctl, 'nodes:list', {})).linked.find((x) => x.id === 'playmap01') || {}; return n.status === 'live' && n.desk; }, 8000, 'live, with its hall\'s desk');
  const verbsAsked = () => pm.requests.filter((x) => x.url === '/api/verbs').length;
  assert.equal(verbsAsked(), 1, 'its vocabulary asked for once, and it was busy');
  const propose = (line) => emit(ctl, 'nodes:command', { id: 'playmap01', line, mode: 'propose' });
  const early = await propose('DECODE POLICY DIRECT');
  assert.deepEqual([early.ok, early.risk], [true, 'high'], JSON.stringify(early));
  assert.equal(sw.proposals.get(early.proposal.id).risk, 'high', 'the desk is never told a lower risk than PlayMap\'s own');
  await until(() => verbsAsked() >= 2, 8000, 'asked again at the next poll');
  await until(async () => (await propose('DECODE POLICY DIRECT')).risk === 'review', 4000, 'its rules read');
  assert.equal((await propose('DECODE POLICY DIRECT FORCE')).risk, 'high', 'rated high by its rules');
  assert.ok(!pm.requests.some((x) => x.url === '/api/cmd'), 'nothing was ever sent to PlayMap');
});
