'use strict';
// The Show Bus, 0.5: lines in Stagewatch's own grammar for every destination (held to a port of its parser — the
// oracle that shows 0.4's proposal line was refused), PlayMap heard on the bus, and Patterns and PlayMap linked: read,
// shown on the board, driven only by the verbs they list, high risk only through the show desk, their tokens sealed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sl = require('../lib/stagelines');
const pl = require('../lib/peerlinks');
const nodes = require('../lib/nodes');
const { startServer, stopServer, api, connect, emit, until, fakeStagewatch, fakeNode } = require('./helpers');

const PATTERNS_TOKEN = 'K7QM-3XWD-P9RA';   // secret-scan: fixture — a fake pairing token for the fake Patterns
const PLAYMAP_TOKEN = 'pm-fake-pairing-token';   // secret-scan: fixture

test('stagelines: every destination is a line Stagewatch takes, and says what it does', () => {
  const cases = [
    ['speaker', 'message', { text: 'Wrap up in "two" minutes', urgency: 'warn', flash: 'off', ack: true }],
    ['moderator', 'signal', { kind: 'message', target: 'moderator', text: 'Wrap up in \'two\' minutes', ack: true }],
    ['backstage', 'signal', { kind: 'message', target: 'backstage' }],
    ['interpreter', 'signal', { kind: 'message', target: 'interpreter' }],
    ['dept:Lighting', 'signal', { kind: 'message', target: 'Lighting' }],
    ['operator', 'note', { text: 'Wrap up in \'two\' minutes' }],
  ];
  for (const [dest, verb, want] of cases) {
    const { line, error } = sl.lineFor(dest, 'Wrap up in "two"\nminutes', 'warn');
    assert.equal(error, undefined, dest);
    const p = sl.parse(line);
    assert.equal(p.error, undefined, dest + ': ' + line + ' → ' + p.error);
    assert.equal(p.verb, verb, dest);
    for (const [k, v] of Object.entries(want)) if (k !== 'text' || dest !== 'speaker') assert.equal(p[k], v, dest + ' ' + k);
  }
  assert.equal(sl.parse(sl.lineFor('speaker', 'x', 'warn').line).text, 'x');
  assert.equal(sl.lineFor('speaker', 'Wrap up', 'crit').line, 'message "Wrap up" crit off ack');
  assert.match(sl.parse('message "Capex" warn ack').error, /flash must be off\|slow\|fast/, '0.4 proposed this line, and Stagewatch refused it');
  assert.equal(sl.lineFor('speaker', '   ').error, 'Nothing to send.');
  assert.equal(sl.lineFor('stage-left', 'x').error, 'Unknown destination.');
  assert.equal(sl.parse(sl.lineFor('moderator', 'y'.repeat(400)).line).text.length, 200, 'a signal body is cut where Stagewatch cuts it');
  assert.deepEqual(sl.departmentsOf({ items: [{ kind: 'department', label: 'Sound' }, { kind: 'timer', label: 'Keynote' }, { kind: 'department', label: 'Sound' }] }), ['Sound']);
  assert.deepEqual(sl.destinations(['Sound']).map((d) => d.id), ['speaker', 'moderator', 'backstage', 'interpreter', 'dept:Sound', 'operator']);
});

test('peerlinks: only listed verbs, the longest match, high when unknown; contexts and receipts read tolerantly', () => {
  const commands = [{ verb: 'VIDEO END <seconds>', risk: 'review' }, { verb: 'VIDEO <clip>', risk: 'low' }, { verb: 'BLACKOUT on|off', risk: 'high' }, { verb: 'EYE FOCUS <screen>', risk: 'wizard' }];
  assert.deepEqual(pl.verbWords('VIDEO END <seconds>'), ['video', 'end']);
  assert.equal(pl.matchCommand(commands, 'video end 10').verb, 'VIDEO END <seconds>', 'the longest listed verb wins');
  assert.equal(pl.matchCommand(commands, 'VIDEO intro').risk, 'low');
  assert.equal(pl.matchCommand(commands, 'BLACKOUT on').risk, 'high');
  assert.equal(pl.matchCommand(commands, 'EYE FOCUS 2').risk, 'high', 'an unknown risk is high');
  assert.equal(pl.matchCommand(commands, 'SHUTDOWN now'), null, 'an unlisted verb is never sent');
  assert.equal(pl.matchCommand(commands, ''), null);
  const ctx = pl.readContext({ v: 1, node: {}, light: 'purple', headline: 'x'.repeat(500), commands: Array.from({ length: 300 }, (_, i) => ({ verb: 'V' + i, risk: 'low' })) });
  assert.equal(ctx.light, 'grey');
  assert.equal(ctx.headline.length, 200);
  assert.equal(ctx.commands.length, 256);
  assert.equal(pl.readContext({ v: 2 }), null);
  assert.deepEqual(pl.readReceipt(200, null, 'OK @agm1 VIDEO END 10 done', 'agm1'), { ok: true, id: 'agm1', stage: 'applied', effect: 'VIDEO END 10 done' });
  assert.deepEqual(pl.readReceipt(200, null, 'ERR @agm1 the air is locked', 'agm1'), { ok: false, stage: 'refused', error: 'the air is locked' });
  assert.equal(pl.readReceipt(200, { ok: true, stage: 'applied', effect: 'ran' }, '', 'x').effect, 'ran');
  assert.equal(pl.readReceipt(409, { ok: false, error: 'no' }, '', 'x').error, 'no');
});

test('hello: PlayMap is heard (it was dropped before 0.5); its build is read; AGMessage says it has displays and help', () => {
  const h = nodes.parseHello({ t: 'playmap', v: 1, proto: 1, id: 'a1b2c3d4', name: 'Stage left', ports: { http: 9940, wire: 9941 }, caps: ['video'], build: '0.2.0+17.abc1234' }, '10.0.0.7');
  assert.equal(h.t, 'playmap');
  assert.equal(h.build, '0.2.0+17.abc1234');
  assert.equal(nodes.parseHello({ t: 'playmap', v: 1, id: 'x', build: '<script>' }, '1.2.3.4').build, '', 'a build outside SemVer\'s alphabet is dropped, the hello kept');
  const d = new nodes.Discovery({ id: 'ab12cd34', port: 3023, name: 'AGMessage', build: '0.5.0+1.abc1234', announce: false });
  const hello = d.hello();
  assert.ok(hello.caps.includes('displays') && hello.caps.includes('help'));
  assert.ok(hello.caps.length <= 16 && hello.caps.every((c) => c.length <= 24), 'within Stagewatch\'s strict reader');
  assert.equal(hello.build, '0.5.0+1.abc1234');
});

test('show bus end to end: destinations through the desk; Patterns and PlayMap linked, read and driven', async (t) => {
  const sw = await fakeStagewatch({ name: 'Hall 1 timer', departments: ['Lighting', 'Sound'] });
  const pat = await fakeNode({ t: 'patterns', token: PATTERNS_TOKEN, commands: [{ verb: 'VIDEO END <seconds>', risk: 'review', words: 'end the clip' }, { verb: 'BLACKOUT on|off', risk: 'high', words: 'black every screen' }] });
  const pm = await fakeNode({ t: 'playmap', name: 'Stage left', token: PLAYMAP_TOKEN, light: 'amber', headline: 'Projector 2 warming', commands: [{ verb: 'PLAYLIST GO <name>', risk: 'low' }] });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); await sw.close(); await pat.close(); await pm.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 1' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall], password: 'mixing desk on stage left' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sol', name: 'Sol Senior', role: 'senior', password: 'radio check one two' }, { cookie: admin });
  const sam = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' })).cookie;
  const sol = (await api(base, 'POST', '/api/auth/login', { username: 'sol', password: 'radio check one two' })).cookie;
  const ctl = await connect(base, admin); sockets.push(ctl);
  assert.ok((await emit(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall1_node_key_00001' /* secret-scan: fixture */ })).ok);
  await until(() => sw.connected, 6000, 'Stagewatch linked');

  await t.test('send to Stagewatch: its departments are offered; each destination reaches the desk as a line it takes', async () => {
    const crew = await connect(base, sam); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
    let targets;
    await until(async () => { targets = await emit(crew, 'stage:targets', {}); return targets.canPropose && targets.targets.some((x) => x.id === 'dept:Sound'); }, 8000, 'the desk and the departments');
    assert.equal(targets.title, 'Hall 1 timer');
    for (const dest of ['moderator', 'dept:Lighting', 'operator', 'speaker']) {
      const r = await emit(crew, 'stage:propose', { text: 'Mic 3 is live', destination: dest, urgency: 'warn' });
      assert.ok(r.ok, dest + ': ' + JSON.stringify(r));
    }
    const lines = Array.from(sw.proposals.values()).map((p) => p.line);
    assert.deepEqual(lines, ['signal message moderator "Mic 3 is live"', 'signal message "Lighting" "Mic 3 is live"', 'note "Mic 3 is live"', 'message "Mic 3 is live" warn off ack']);
    for (const l of lines) assert.equal(sl.parse(l).error, undefined, l);
    assert.ok(Array.from(sw.proposals.values()).every((p) => p.risk === 'review' && p.target.t === 'main'));
  });

  await t.test('linking is the admin\'s; the token rides in the node\'s own header, sealed at rest, never audited', async () => {
    const tech = await connect(base, sam); sockets.push(tech);
    assert.equal((await emit(tech, 'nodes:link', { id: 'patterns01', t: 'patterns', url: pat.url, token: PATTERNS_TOKEN })).ok, false);
    assert.ok((await emit(ctl, 'nodes:link', { id: 'patterns01', t: 'patterns', url: pat.url, name: 'Patterns FOH', token: PATTERNS_TOKEN, hall })).ok);
    assert.ok((await emit(ctl, 'nodes:link', { id: 'playmap01', t: 'playmap', url: pm.url, name: 'Stage left', token: PLAYMAP_TOKEN })).ok);
    await until(() => pat.requests.some((r) => r.url === '/api/context') && pm.requests.some((r) => r.url === '/api/context'), 8000, 'both read');
    assert.equal(pat.requests.find((r) => r.url === '/api/context').headers['x-patterns-token'], PATTERNS_TOKEN);
    assert.equal(pm.requests.find((r) => r.url === '/api/context').headers['x-playmap-token'], PLAYMAP_TOKEN);
    assert.ok(!pat.requests.some((r) => r.url.includes(PATTERNS_TOKEN)), 'never in a URL');
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const settingsFile = fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8');
    assert.ok(!settingsFile.includes(PATTERNS_TOKEN) && !settingsFile.includes(PLAYMAP_TOKEN), 'sealed at rest');
    const audit = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes(PATTERNS_TOKEN) && audit.includes('(token sealed)'));
  });

  await t.test('the board shows each node on its hall (or for those who drive every hall), with its light and headline', async () => {
    const pmView = await connect(base, sol); sockets.push(pmView);
    let b;
    await until(async () => { b = (await emit(pmView, 'board:watch', {})).board; return b.nodes.length === 2 && b.nodes.every((n) => n.status === 'live'); }, 8000, 'both live on the board');
    const row = b.halls.find((h) => h.code === hall);
    assert.deepEqual(row.nodes.map((n) => [n.name, n.light, n.headline]), [['Patterns FOH', 'green', 'Programme: VT1 · 3 screens green']]);
    assert.equal(b.nodes.find((n) => n.name === 'Stage left').light, 'amber');
    const tech = await connect(base, sam); sockets.push(tech);
    assert.equal((await emit(tech, 'nodes:list', {})).ok, false, 'a tech does not drive other show systems by default');
    const ctx = await api(base, 'GET', '/api/context', undefined, { cookie: admin });
    assert.equal(ctx.status, 200);
  });

  await t.test('driving: a listed verb now with a receipt; an unlisted one never sent; high risk only to the desk', async () => {
    const senior = await connect(base, sol); sockets.push(senior);
    const list = await emit(senior, 'nodes:list', {});
    assert.ok(list.ok && list.desk);
    assert.deepEqual(list.linked.find((n) => n.id === 'patterns01').commands.map((c) => c.verb), ['VIDEO END <seconds>', 'BLACKOUT on|off']);
    const r = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'VIDEO END 10', mode: 'send' });
    assert.deepEqual([r.ok, r.stage, r.risk], [true, 'applied', 'review']);
    assert.match(r.effect, /VIDEO END 10 done/);
    const cmd = pat.requests.find((x) => x.url === '/api/cmd');
    assert.equal(cmd.body, 'VIDEO END 10');
    assert.equal(cmd.headers['x-patterns-token'], PATTERNS_TOKEN);
    assert.match(cmd.headers['x-request-id'], /^agm[0-9a-f]{10}$/);
    const sentBefore = pat.requests.filter((x) => x.url === '/api/cmd').length;
    const no = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'SHUTDOWN now', mode: 'send' });
    assert.equal(no.ok, false);
    assert.match(no.error, /does not list that command/);
    const high = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'BLACKOUT on', mode: 'send' });
    assert.equal(high.ok, false);
    assert.match(high.error, /high risk/);
    assert.equal(pat.requests.filter((x) => x.url === '/api/cmd').length, sentBefore, 'neither reached Patterns');
    const prop = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'BLACKOUT on', mode: 'propose' });
    assert.ok(prop.ok, JSON.stringify(prop));
    const p = sw.proposals.get(prop.proposal.id);
    assert.deepEqual([p.line, p.risk, p.target.t, p.target.id], ['BLACKOUT on', 'high', 'patterns', 'patterns01']);
    const playmap = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'PLAYLIST GO show', mode: 'send' });
    assert.deepEqual([playmap.ok, playmap.effect], [true, 'ran PLAYLIST GO show']);
    const a = await api(base, 'GET', '/api/audit?limit=100', undefined, { cookie: admin });
    assert.ok(a.body.entries.some((e) => e.action === 'node.command' && /VIDEO END 10 → applied/.test(e.words)));
    assert.ok(a.body.entries.some((e) => e.action === 'node.propose' && /BLACKOUT on → proposed/.test(e.words)));
  });

  await t.test('a wrong token is said plainly; unlinking forgets it', async () => {
    assert.ok((await emit(ctl, 'nodes:link', { id: 'playmap01', token: 'wrong-token-here' })).ok);
    await until(async () => (await emit(ctl, 'nodes:list', {})).linked.find((n) => n.id === 'playmap01').status === 'refused', 8000, 'refused');
    const v = (await emit(ctl, 'nodes:list', {})).linked.find((n) => n.id === 'playmap01');
    assert.match(v.problem, /refused the token/);
    assert.equal(v.light, 'red');
    assert.ok((await emit(ctl, 'nodes:unlink', { id: 'playmap01' })).ok);
    assert.equal((await emit(ctl, 'nodes:list', {})).linked.some((n) => n.id === 'playmap01'), false);
  });
});
