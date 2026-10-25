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
const { startServer, stopServer, api, connect, emit, answer, until, fakeStagewatch, fakeNode } = require('./helpers');

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

test('stagelines: every line means the same after the show desk keeps 400 characters; urgencies and departments as Stagewatch has them (C19, C36, C45)', () => {
  // C19: Stagewatch's desk keeps 400 characters of a line (ProposalDesk.MaxLine): no line may lose its urgency or its ack.
  const dests = ['speaker', 'moderator', 'backstage', 'interpreter', 'dept:' + 'L'.repeat(40), 'operator'];
  for (const dest of dests) {
    for (const u of ['info', 'warn', 'crit']) {
      for (const n of [1, 377, 378, 382, 386, 391, 450, 500]) {
        const b = sl.lineFor(dest, 'x'.repeat(n), u);
        if (b.error) continue;
        assert.ok(b.line.length <= 400, dest + ' ' + n + ': ' + b.line.length);
        assert.deepEqual(sl.parse(b.line.slice(0, 400).trim()), sl.parse(b.line), dest + ' ' + u + ' ' + n);
      }
    }
  }
  const at = sl.parse(sl.lineFor('speaker', 'x'.repeat(377), 'crit').line);
  assert.deepEqual([at.urgency, at.ack, at.text.length], ['crit', true, 377]);
  assert.match(sl.lineFor('speaker', 'x'.repeat(450), 'crit').error, /377/);
  // C36: only Stagewatch's urgencies, by their own keys — never what an object inherits.
  for (const u of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nonsense', 3]) assert.equal(sl.lineFor('speaker', 'x', u).error, 'Unknown urgency.', String(u));
  assert.match(sl.lineFor('speaker', 'x').line, / info off ack$/);
  assert.match(sl.lineFor('speaker', 'x', '').line, / info off ack$/);
  assert.match(sl.lineFor('speaker', 'x', 'urgent').line, / crit off ack$/);
  // C45: Stagewatch marks a department "cue" once its newest signal is a message; its role targets are not departments.
  assert.deepEqual(sl.departmentsOf({ items: [
    { id: 'cue:lighting', kind: 'cue', label: 'Lighting' }, { id: 'cue:sound', kind: 'department', label: 'Sound' },
    { id: 'cue:moderator', kind: 'cue', label: 'moderator' }, { id: 'cue:speaker', kind: 'cue', label: 'speaker' }, { id: 'cue:*', kind: 'cue', label: '*' },
    { id: 'timer', kind: 'timer', label: 'Keynote' }, { id: 'message', kind: 'cue', label: 'Speaker message' },
  ] }), ['Lighting', 'Sound']);
});

test('peerlinks: a line is rated as the node rates it; Patterns\' receipts read; a verb\'s secret never written down (C22, C43, C44)', () => {
  // C22: PlayMap's catalogue raises some lines above their row (riskWhen, highFor) and a line that carries a line takes its risk.
  const c = [
    { verb: 'BIND ADD <input words> TO <target line> | BIND ADD <json>', risk: 'review' },
    { verb: 'BIND LEARN [FROM <surface>|MIDI|OSC|ARTNET|SACN] <target line> | BIND LEARN OFF', risk: 'review' },
    { verb: 'BLACKOUT ON|OFF', risk: 'high' },
    { verb: 'SET <id> <field> <value>', risk: 'review' },
    { verb: 'DECODE POLICY AUTO|DIRECT|GPU-COPY|COPY-BACK|SOFTWARE [FORCE]', risk: 'review' },
    { verb: 'MEDIA OPTIMISE <media>…|ALL [TO hap|hap-alpha]', risk: 'review' },
    { verb: 'ASSISTANT SET enabled|provider|model|effort <value>', risk: 'review', highFor: ['ENABLED', 'PROVIDER'] },
  ];
  const table = pl.withRules(c, pl.readVerbRules([
    { name: 'DECODE POLICY', syntax: c[4].verb, risk: 'review', riskWhen: [{ arg: -1, word: 'FORCE', risk: 'high' }] },
    { name: 'MEDIA OPTIMISE', syntax: c[5].verb, risk: 'review', riskWhen: [{ arg: 0, word: 'CANCEL', risk: 'low' }] },
    { name: 'BOGUS', syntax: 'BOGUS', risk: 'low', riskWhen: 'not a list' },
  ]));
  const risk = (line) => (pl.matchCommand(table, line) || {}).risk;
  for (const line of ['BIND ADD MIDI APC40 NOTE 1 53 TO BLACKOUT OFF', 'BIND ADD {"input":"OSC /x","target":"BLACKOUT ON"}', 'BIND LEARN BLACKOUT ON',
    'BIND LEARN FROM MIDI BLACKOUT ON', 'BIND ADD OSC /a TO BIND ADD OSC /b TO BLACKOUT ON', 'BIND ADD OSC /a TO SHUTDOWN now', 'BIND ADD OSC /a TO "BLACKOUT ON"',
    'DECODE POLICY DIRECT FORCE', 'ASSISTANT SET enabled on', 'assistant set PROVIDER claude']) assert.equal(risk(line), 'high', line);
  for (const line of ['BIND ADD OSC /fader/1 TO SET sf1 opacity *', 'BIND LEARN OFF', 'BIND LEARN FROM OSC SET sf1 opacity *', 'DECODE POLICY DIRECT',
    'MEDIA OPTIMISE CANCEL', 'ASSISTANT SET model fast']) assert.equal(risk(line), 'review', line + ' (a node\'s lower rating is never taken: fail closed)');
  assert.equal(pl.matchCommand(c, 'DECODE POLICY DIRECT FORCE').risk, 'review', 'without the node\'s rules, its listed risk');
  // PlayMap's highFor for ASSISTANT SET, which it lists nowhere: known to the link, joined to what it lists.
  const link = Object.create(pl.PeerLink.prototype);
  Object.assign(link, { node: { t: 'playmap' }, context: { commands: [{ verb: 'ASSISTANT SET enabled|provider|model <value>', risk: 'review', words: '' }] }, rules: null });
  assert.equal(pl.matchCommand(link.commandTable(), 'ASSISTANT SET enabled on').risk, 'high');
  assert.equal(pl.matchCommand(link.commandTable(), 'ASSISTANT SET model fast').risk, 'review');
  const ctx = pl.readContext({ v: 1, node: {}, commands: [{ verb: 'X <y>', risk: 'review', riskWhen: [{ arg: 0, word: 'NOW', risk: 'high' }, { arg: 'x', word: 1, risk: 'odd' }], highFor: ['A', 7], embedsLine: 'yes' }] });
  assert.deepEqual(ctx.commands[0], { verb: 'X <y>', risk: 'review', words: '', riskWhen: [{ arg: 0, word: 'NOW', risk: 'high' }], highFor: ['A'], embedsLine: false }, 'a node\'s own rules, when it lists them, read and bounded');

  // C43: Patterns answers {"ok","msg"} (its wire's OK / ERR words) with HTTP 200 even for ERR; PlayMap's receipt carries msg too.
  assert.deepEqual(pl.readReceipt(200, { ok: false, msg: 'ERR the air is locked' }, '', 'agm1'), { ok: false, stage: 'refused', error: 'the air is locked' });
  assert.deepEqual(pl.readReceipt(200, { ok: true, msg: 'OK Eye on screen 2', id: 'agm1' }, '', 'agm1'), { ok: true, id: 'agm1', stage: 'applied', effect: 'Eye on screen 2' });
  assert.equal(pl.readReceipt(403, { ok: false, msg: 'ERR not paired' }, '', 'x').error, 'not paired');
  assert.deepEqual(pl.readReceipt(200, { type: 'receipt', id: 'a1', ok: true, stage: 'accepted', effect: 'queued', msg: 'OK @a1 {"stage":"accepted"}' }, '', 'a1'), { ok: true, id: 'a1', stage: 'accepted', effect: 'queued' });
  assert.equal(pl.readReceipt(409, { type: 'receipt', id: 'a1', ok: false, stage: 'refused', error: 'not paired', msg: 'ERR @a1 not paired' }, '', 'a1').error, 'not paired');

  // C44: where a verb's secret starts (PlayMap's SecretFrom), from its template; the line as it may be written down.
  assert.equal(pl.secretFrom('LINK PATTERNS <host[:port]>|OFF [<token>] | LINK PATTERNS FOLLOW-BLACKOUT ON|OFF'), 3);
  assert.equal(pl.secretFrom('LINK STAGEWATCH <host[:port]>|""|OFF [<key>]'), 3);
  assert.equal(pl.secretFrom('CREDENTIAL SET <ref> [<user>] <secret>'), 3, 'an optional slot before the secret is cut too');
  assert.equal(pl.secretFrom('AUTH <token>'), 1);
  assert.equal(pl.secretFrom('WEB KEY <key|action>'), -1, 'a keyboard key is no secret');
  assert.equal(pl.secretFrom('VIDEO END <seconds>'), -1);
  assert.equal(pl.redactLine('LINK PATTERNS 10.0.0.5:9696 K7QM-3XWD-P9RA', 3), 'LINK PATTERNS 10.0.0.5:9696 …');
  assert.equal(pl.redactLine('LINK PATTERNS OFF', 3), 'LINK PATTERNS OFF');
  assert.equal(pl.redactLine('VIDEO END 10', -1), 'VIDEO END 10');
  assert.equal(pl.redactWords('ran LINK PATTERNS 10.0.0.5:9696 K7QM-3XWD-P9RA', ['K7QM-3XWD-P9RA']), 'ran LINK PATTERNS 10.0.0.5:9696 …');
  assert.equal(pl.matchCommand([{ verb: 'LINK PATTERNS <host[:port]>|OFF [<token>]', risk: 'review' }], 'LINK PATTERNS 10.0.0.5 tok').secretFrom, 3);
  // …and a line that carries one: a binding to LINK PATTERNS <host> <token> keeps its token back too (PlayMap's
  // CarriedSecretAt), as a JSON argument holding one is kept back whole; a carried line with no secret words keeps all.
  const withLink = table.concat([{ verb: 'LINK PATTERNS <host[:port]>|OFF [<token>] | LINK PATTERNS FOLLOW-BLACKOUT ON|OFF', risk: 'review' }]);
  const cut = (line) => { const m = pl.matchCommand(withLink, line); return [m.risk, pl.redactLine(line, m.secretFrom), m.secrets]; };
  assert.deepEqual(cut('BIND ADD OSC /a TO LINK PATTERNS 10.0.0.5:9696 tok'), ['review', 'BIND ADD OSC /a TO LINK PATTERNS 10.0.0.5:9696 …', ['tok']]);
  assert.deepEqual(cut('BIND LEARN FROM MIDI LINK PATTERNS 10.0.0.5 tok'), ['review', 'BIND LEARN FROM MIDI LINK PATTERNS 10.0.0.5 …', ['tok']]);
  assert.deepEqual(cut('BIND ADD OSC /a TO "LINK PATTERNS 10.0.0.5 tok"').slice(0, 2), ['high', 'BIND ADD OSC /a TO "LINK PATTERNS 10.0.0.5 …']);
  assert.ok(cut('BIND ADD OSC /a TO "LINK PATTERNS 10.0.0.5 tok"')[2].includes('tok'), 'the secret as the node reads it, without its quote');
  const json = cut('BIND ADD {"input":"OSC /a","target":"LINK PATTERNS 10.0.0.5 tok"}');
  assert.deepEqual(json.slice(0, 2), ['high', 'BIND ADD …']);
  assert.ok(json[2].includes('tok'), 'the carried line\'s own secret words, for the receipt');
  assert.deepEqual(cut('BIND ADD {"input":"OSC /a","target":"LINK PATTERNS OFF"}').slice(0, 2), ['high', 'BIND ADD {"input":"OSC /a","target":"LINK PATTERNS OFF"}']);
  assert.deepEqual(cut('BIND ADD {not json LINK PATTERNS 10.0.0.5 tok').slice(0, 2), ['high', 'BIND ADD …'], 'JSON no reader can read: kept back when it names a verb with a secret');
  assert.deepEqual(cut('BIND ADD OSC /a TO LINK PATTERNS OFF'), ['review', 'BIND ADD OSC /a TO LINK PATTERNS OFF', []]);
  // Every TO's tail is read, the riskiest counts (an input's own words may hold one); a line of bindings is read a bounded number of times.
  assert.equal(risk('BIND ADD OSC /x TO SET a b TO BLACKOUT ON'), 'high');
  const deep = 'BIND ADD x TO '.repeat(28) + 'SET a b c';
  const started = process.hrtime.bigint();
  assert.equal(risk(deep), 'high', 'bindings carrying bindings past the depth PlayMap reads');
  assert.ok(process.hrtime.bigint() - started < 500_000_000n, 'read in bounded time');
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
  // PlayMap's own rows as its context lists them (syntax and base risk only), and its vocabulary's rules (GET /api/verbs).
  const decode = 'DECODE POLICY AUTO|DIRECT|GPU-COPY|COPY-BACK|SOFTWARE [FORCE]';
  const pm = await fakeNode({
    t: 'playmap', name: 'Stage left', token: PLAYMAP_TOKEN, light: 'amber', headline: 'Projector 2 warming',
    commands: [{ verb: 'BLACKOUT ON|OFF', risk: 'high' }, { verb: 'PLAYLIST GO <name>', risk: 'low' }, { verb: 'BIND ADD <input words> TO <target line> | BIND ADD <json>', risk: 'review' },
      { verb: 'BIND LEARN [FROM <surface>|MIDI|OSC|ARTNET|SACN] <target line> | BIND LEARN OFF', risk: 'review' }, { verb: decode, risk: 'review' },
      { verb: 'LINK PATTERNS <host[:port]>|OFF [<token>] | LINK PATTERNS FOLLOW-BLACKOUT ON|OFF', risk: 'review' }],
    verbs: [{ name: 'DECODE POLICY', syntax: decode, risk: 'review', riskWhen: [{ arg: -1, word: 'FORCE', risk: 'high' }] }],
  });
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

  await t.test('C36, C19: a destination Stagewatch does not offer, an unknown urgency or a line the desk would cut is refused before the desk', async () => {
    const crew = await connect(base, sam); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
    const before = sw.proposals.size;
    const dept = await answer(crew, 'stage:propose', { text: 'Hi', destination: 'dept:Catering' });
    assert.deepEqual([dept.ok, dept.error], [false, 'This hall\'s Stagewatch offers no such destination.']);
    for (const urgency of ['constructor', '__proto__', 'toString']) {
      const r = await answer(crew, 'stage:propose', { text: 'Hi', destination: 'speaker', urgency });
      assert.deepEqual([r.ok, r.error], [false, 'Unknown urgency.'], urgency);
    }
    const long = await answer(crew, 'stage:propose', { text: 'x'.repeat(450), destination: 'speaker', urgency: 'crit' });
    assert.equal(long.ok, false);
    assert.match(long.error, /at most 377 characters/);
    assert.equal(sw.proposals.size, before, 'nothing reached the desk');
    assert.ok(Array.from(sw.proposals.values()).every((p) => sl.parse(p.line).error === undefined && p.line.length <= 400));
  });

  await t.test('C45: a department stays a destination once Stagewatch\'s context stops naming it (messaged, or its GO aged out)', async () => {
    const crew = await connect(base, sam); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
    // Lighting's newest cue is now a message (kind "cue"); Sound's GO aged out of the context altogether.
    sw.items = [{ id: 'cue:lighting', kind: 'cue', label: 'Lighting', light: 'amber', state: 'message sent: Mic 3 is live' }];
    const reads = () => sw.requests.filter((r) => r.url === '/api/context').length;
    const n = reads();
    await until(() => reads() > n, 8000, 'the next context read');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    const targets = (await emit(crew, 'stage:targets', {})).targets.map((x) => x.id);
    assert.ok(targets.includes('dept:Lighting') && targets.includes('dept:Sound'), targets.join(','));
    assert.ok((await emit(crew, 'stage:propose', { text: 'Stand by', destination: 'dept:Sound' })).ok, 'and still proposed to');
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
    assert.match(cmd.body, /^@agm[0-9a-f]{10} VIDEO END 10$/, 'Patterns reads its request id from the line');
    assert.equal(cmd.headers['x-patterns-token'], PATTERNS_TOKEN);
    assert.match(r.id, /^agm[0-9a-f]{10}$/);
    assert.equal(cmd.body.split(' ')[0], '@' + r.id, 'the receipt is the one for this line');
    // C43: Patterns refuses with HTTP 200 and its words; the person and the audit read them, not "said 200".
    const locked = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'VIDEO END locked', mode: 'send' });
    assert.deepEqual([locked.ok, locked.stage, locked.error], [false, 'refused', 'the air is locked']);
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
    assert.ok(a.body.entries.some((e) => e.action === 'node.command' && /VIDEO END locked → refused: the air is locked$/.test(e.words)), 'the node\'s own words, not "said 200"');
    assert.ok(a.body.entries.some((e) => e.action === 'node.propose' && /BLACKOUT on → proposed/.test(e.words)));
  });

  await t.test('C22: a PlayMap line its own catalogue rates high is never sent now — only proposed, rated high', async () => {
    const senior = await connect(base, sol); sockets.push(senior);
    assert.ok((await emit(ctl, 'nodes:link', { id: 'playmap01', hall })).ok, 'PlayMap moves to Hall 1, whose Stagewatch keeps the desk');
    await until(async () => { const n = (await emit(senior, 'nodes:list', {})).linked.find((x) => x.id === 'playmap01'); return n.status === 'live' && n.commands.length === 6 && n.desk; }, 8000, 'PlayMap\'s verbs');
    assert.ok(pm.requests.some((x) => x.url === '/api/verbs' && x.headers['x-playmap-token'] === PLAYMAP_TOKEN), 'its vocabulary read with its token');
    const cmds = () => pm.requests.filter((x) => x.url === '/api/cmd').map((x) => x.body);
    const before = cmds().length;
    for (const line of ['BIND ADD MIDI APC40 NOTE 1 53 TO BLACKOUT OFF', 'BIND LEARN BLACKOUT ON', 'DECODE POLICY DIRECT FORCE', 'BIND ADD {"input":"OSC /x","target":"BLACKOUT ON"}']) {
      const r = await emit(senior, 'nodes:command', { id: 'playmap01', line, mode: 'send' });
      assert.equal(r.ok, false, line);
      assert.match(r.error, /high risk/, line);
    }
    assert.equal(cmds().length, before, 'none reached PlayMap');
    const ok = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'DECODE POLICY DIRECT', mode: 'send' });
    assert.deepEqual([ok.ok, ok.risk], [true, 'review']);
    const prop = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'BIND LEARN BLACKOUT ON', mode: 'propose' });
    assert.deepEqual([prop.ok, prop.risk], [true, 'high']);
    assert.equal(sw.proposals.get(prop.proposal.id).risk, 'high', 'the desk is told it is high');
  });

  await t.test('C44: a verb\'s secret reaches the node, and never the audit log or the show desk', async () => {
    const secret = 'K7QM-3XWD-P9RB';   // secret-scan: fixture — a fake Patterns pairing token inside a PlayMap verb
    const senior = await connect(base, sol); sockets.push(senior);
    const r = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'LINK PATTERNS 10.0.0.5:9696 ' + secret, mode: 'send' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(pm.requests.some((x) => x.url === '/api/cmd' && x.body === 'LINK PATTERNS 10.0.0.5:9696 ' + secret), 'the node gets the whole line');
    // A binding that carries it: the node gets it whole, the record keeps it back, the desk is never given it.
    const bindLine = 'BIND ADD OSC /fader/9 TO LINK PATTERNS 10.0.0.5:9696 ' + secret;
    const bound = await emit(senior, 'nodes:command', { id: 'playmap01', line: bindLine, mode: 'send' });
    assert.deepEqual([bound.ok, bound.risk], [true, 'review'], JSON.stringify(bound));
    assert.ok(pm.requests.some((x) => x.url === '/api/cmd' && x.body === bindLine));
    assert.match((await emit(senior, 'nodes:command', { id: 'playmap01', line: bindLine, mode: 'propose' })).error, /carries a secret/);
    const before = sw.proposals.size;
    const prop = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'LINK PATTERNS 10.0.0.5:9696 ' + secret, mode: 'propose' });
    assert.equal(prop.ok, false);
    assert.match(prop.error, /carries a secret/);
    assert.equal(sw.proposals.size, before, 'never put in the desk\'s queue');
    const a = await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin });
    assert.ok(a.body.entries.some((e) => e.action === 'node.command' && e.words.startsWith('Stage left: LINK PATTERNS 10.0.0.5:9696 … →')));
    assert.ok(a.body.entries.some((e) => e.action === 'node.command' && e.words.startsWith('Stage left: BIND ADD OSC /fader/9 TO LINK PATTERNS 10.0.0.5:9696 … →')));
    assert.ok(!JSON.stringify(a.body).includes(secret), 'not in the audit log, nor in the receipt\'s words it keeps');
    for (const f of fs.readdirSync(srv.dataDir).filter((x) => x.startsWith('audit'))) assert.ok(!fs.readFileSync(path.join(srv.dataDir, f), 'utf8').includes(secret), f);
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

test('show network rights: a one-hall driver sees only its halls and nodes, and a node proposes only to its own hall\'s desk', async (t) => {
  const swA = await fakeStagewatch({ name: 'Hall A timer', desk: false });
  const swB = await fakeStagewatch({ name: 'Hall B timer', desk: true });
  const swA2 = await fakeStagewatch({ name: 'Hall A desk', desk: true });
  const venue = await fakeNode({ t: 'playmap', name: 'Main wall', token: PLAYMAP_TOKEN, commands: [{ verb: 'PLAYLIST GO <name>', risk: 'low' }] });
  const nodeA = await fakeNode({ t: 'patterns', name: 'Hall A Patterns', token: PATTERNS_TOKEN, commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }, { verb: 'BLACKOUT on|off', risk: 'high' }] });
  const nodeB = await fakeNode({ t: 'patterns', name: 'Hall B Patterns', token: PATTERNS_TOKEN, commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }] });
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); for (const x of [swA, swB, swA2, venue, nodeA, nodeB]) await x.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  const hallC = (await api(base, 'POST', '/api/rooms', { name: 'Hall C (board only)' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'tom', name: 'Tom Tech', role: 'tech', halls: [hallA], grant: ['nodes.control'], password: 'gaffer tape on the riser' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sid', name: 'Sid Senior', role: 'senior', allHalls: false, halls: [hallA], password: 'cable run under stage' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sol', name: 'Sol Senior', role: 'senior', password: 'radio check one two' }, { cookie: admin });
  const login = async (username, password) => (await api(base, 'POST', '/api/auth/login', { username, password })).cookie;
  const tomC = await login('tom', 'gaffer tape on the riser');
  const sidC = await login('sid', 'cable run under stage');
  const solC = await login('sol', 'radio check one two');
  const ctl = await connect(base, admin); sockets.push(ctl);
  assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: swA.url, stagewatchKey: 'swk_hallA_node_key_00001' /* secret-scan: fixture */ })).ok);
  assert.ok((await emit(ctl, 'hall:configure', { code: hallB, stagewatchUrl: swB.url, stagewatchKey: 'swk_hallB_node_key_00002' /* secret-scan: fixture */ })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'venue01', t: 'playmap', url: venue.url, name: 'Main wall', token: PLAYMAP_TOKEN })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'h1pat', t: 'patterns', url: nodeA.url, name: 'Hall A Patterns', token: PATTERNS_TOKEN, hall: hallA })).ok);
  assert.ok((await emit(ctl, 'nodes:link', { id: 'h2pat', t: 'patterns', url: nodeB.url, name: 'Hall B Patterns', token: PATTERNS_TOKEN, hall: hallB })).ok);
  await until(async () => { const l = await emit(ctl, 'nodes:list', {}); return l.linked.length === 3 && l.linked.every((n) => n.status === 'live'); }, 10000, 'three nodes live');
  await until(() => swA.connected && swB.connected, 6000, 'both Stagewatches linked');

  await t.test('C05: nodes:list tells an account limited to hall A no code outside hall A', async () => {
    const tom = await connect(base, tomC); sockets.push(tom);
    assert.deepEqual((await api(base, 'GET', '/api/halls', undefined, { cookie: tomC })).body.halls.map((h) => h.code), [hallA]);
    const r = await emit(tom, 'nodes:list', {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.halls.map((h) => h.code), [hallA]);
    assert.ok(!JSON.stringify(r).includes(hallB) && !JSON.stringify(r).includes(hallC), 'no other hall\'s code anywhere in the answer');
    assert.deepEqual((await emit(ctl, 'nodes:list', {})).halls.map((h) => h.code).sort(), [hallA, hallB, hallC].sort(), 'the admin still sees every hall');
  });

  await t.test('C10: a one-hall senior tech neither sees nor drives a node linked for every hall', async () => {
    const sid = await connect(base, sidC); sockets.push(sid);
    const l = await emit(sid, 'nodes:list', {});
    assert.equal(l.ok, true);
    assert.deepEqual(l.linked.map((n) => n.id), ['h1pat']);
    const b = (await emit(sid, 'board:watch', {})).board;
    assert.deepEqual(b.nodes.map((n) => n.id), ['h1pat'], 'the board shows the one-hall senior its own hall\'s node only');
    const before = venue.requests.filter((x) => x.url === '/api/cmd').length;
    assert.equal((await emit(sid, 'nodes:command', { id: 'venue01', line: 'PLAYLIST GO walkout', mode: 'send' })).ok, false);
    assert.equal((await emit(sid, 'nodes:command', { id: 'h2pat', line: 'VIDEO END 10', mode: 'send' })).ok, false);
    assert.equal(venue.requests.filter((x) => x.url === '/api/cmd').length, before, 'nothing reached the venue-wide node');
    const sol = await connect(base, solC); sockets.push(sol);
    assert.deepEqual((await emit(sol, 'nodes:list', {})).linked.map((n) => n.id).sort(), ['h1pat', 'h2pat', 'venue01'], 'a senior with every hall still drives them all');
    assert.equal((await emit(sol, 'nodes:command', { id: 'venue01', line: 'PLAYLIST GO walkout', mode: 'send' })).ok, true);
  });

  await t.test('C15: a node\'s proposal goes to its own hall\'s desk or nowhere, never another hall\'s', async () => {
    const tom = await connect(base, tomC); sockets.push(tom);
    await until(async () => (await emit(ctl, 'nodes:list', {})).desk === true, 8000, 'hall B\'s desk is known');
    const list = await emit(tom, 'nodes:list', {});
    assert.equal(list.linked.find((n) => n.id === 'h1pat').desk, false, 'hall A\'s Stagewatch keeps no desk');
    const r = await emit(tom, 'nodes:command', { id: 'h1pat', line: 'BLACKOUT on', mode: 'propose' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /Hall A's Stagewatch keeps no show desk/);
    assert.equal(swB.proposals.size, 0, 'hall B\'s show caller is never asked for hall A\'s line');
    // Hall A moves to a Stagewatch that keeps a desk: the proposal lands there, and hall B's queue stays empty.
    assert.ok((await emit(ctl, 'hall:configure', { code: hallA, stagewatchUrl: swA2.url, stagewatchKey: 'swk_hallA_node_key_00003' /* secret-scan: fixture */ })).ok);
    await until(async () => (await emit(tom, 'nodes:list', {})).linked.find((n) => n.id === 'h1pat').desk === true, 8000, 'hall A\'s new desk');
    const ok = await emit(tom, 'nodes:command', { id: 'h1pat', line: 'BLACKOUT on', mode: 'propose' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(Array.from(swA2.proposals.values()).map((p) => [p.line, p.risk, p.target.id]), [['BLACKOUT on', 'high', 'h1pat']]);
    // Hall A's Stagewatch goes away: refused, and still nothing at hall B.
    await swA2.close();
    await until(async () => (await emit(tom, 'nodes:list', {})).linked.find((n) => n.id === 'h1pat').desk === false, 8000, 'hall A\'s link down');
    const down = await emit(tom, 'nodes:command', { id: 'h1pat', line: 'BLACKOUT on', mode: 'propose' });
    assert.equal(down.ok, false);
    assert.equal(swB.proposals.size, 0);
  });
});

