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
const { hallBrief } = require('../lib/context');
const { startServer, stopServer, api, connect, emit, answer, wait, until, fakeStagewatch, fakeNode } = require('./helpers');

const PATTERNS_TOKEN = 'K7QM-3XWD-P9RA';   // secret-scan: fixture — a fake pairing token for the fake Patterns
const PLAYMAP_TOKEN = 'pm-fake-pairing-token';   // secret-scan: fixture

/** A fake Anthropic Messages endpoint: every request body kept in `bodies`, each answered with a draft and options. */
async function fakeModel() {
  const http = require('http');
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ draft: 'ok', gaps: [], confidence: 'low', options: ['Yes', 'No'] }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  return { url: 'http://127.0.0.1:' + srv.address().port, bodies, close: () => new Promise((resolve) => { srv.close(resolve); }) };
}

test('the AI\'s brief of a hall: the nodes of that hall and of every hall, linked or heard — never another hall\'s', () => {
  const node = (id, name, hall) => ({ id, t: 'patterns', name, hall, status: 'live', light: 'amber', headline: name + ' headline', items: [{ label: 'Screen 2', state: 'no signal', light: 'red' }] });
  const links = [node('pa', 'Hall A Patterns', 'HALLAA'), node('pb', 'Hall B Patterns', 'HALLBB'), node('v', 'Main wall', '')];
  const heard = [{ id: 'pb', t: 'patterns', name: 'Hall B Patterns', status: 'live' }, { id: 'pa', t: 'patterns', name: 'Hall A Patterns', status: 'live' }, { id: 'sw2', t: 'main', name: 'Foyer timer', status: 'live' }];
  const a = hallBrief('HALLAA', { status: 'off' }, links, heard);
  assert.match(a, /^Patterns "Hall A Patterns" \(linked, live\): Hall A Patterns headline \[amber\]\n {2}Screen 2: no signal \[red\]$/m);
  assert.match(a, /^Patterns "Main wall" \(linked, live\)/m, 'a node of every hall is in every hall\'s brief');
  assert.match(a, /^Heard on the network: main "Foyer timer" \(live\)$/m);
  assert.doesNotMatch(a, /Hall B/, 'another hall\'s node is in it neither as linked nor as heard');
  assert.doesNotMatch(a, /Heard on the network: patterns "Hall A Patterns"/, 'a linked node is not heard twice');
  const b = hallBrief('HALLBB', { status: 'off' }, links, heard);
  assert.ok(b.includes('Hall B Patterns headline') && b.includes('Main wall') && !b.includes('Hall A'), b);
});

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

test('peerlinks: only listed verbs, the longest match, high when unknown; contexts read tolerantly', () => {
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
  // AG-1: this machine, where a token never crosses the network: 127.0.0.0/8, ::1 and localhost — never a name that only looks local.
  for (const h of ['127.0.0.1', '127.200.1.1', '[::1]', '::1', 'localhost', 'LOCALHOST', '[::ffff:7f00:1]', new URL('http://[::ffff:127.0.0.1]:1/').hostname]) assert.ok(pl.isLoopback(h), h);
  for (const h of ['192.168.1.20', '10.0.0.1', '[::ffff:a00:1]', 'patterns.local', '0.0.0.0', '', '[fe80::1]', '127.0.0.1.nip.io', 'localhost.example']) assert.ok(!pl.isLoopback(h), h);
  // A node heard from one of this machine's own addresses (its broadcast hello) is linked by 127.0.0.1; another stays where it is.
  assert.equal(pl.baseFor({ address: '192.0.2.2', tls: '', ports: { http: 9696 } }, ['192.0.2.2']), 'http://127.0.0.1:9696');
  assert.equal(pl.baseFor({ address: '192.0.2.9', tls: '', ports: { http: 9696 } }, ['192.0.2.2']), 'http://192.0.2.9:9696');
  assert.equal(pl.baseFor({ address: '192.0.2.9', tls: 'sha256:' + 'a'.repeat(64), ports: { http: 9696, https: 9697 } }, []), 'https://192.0.2.9:9697');
});

test('AG-1: a node\'s token goes only to this machine, or over TLS to a certificate pinned or confirmed by a person; send() refuses with words', async () => {
  const tlsmod = require('../lib/tls');
  const token = 'pat-operator-token-x';   // secret-scan: fixture
  const sent = [];     // every request a link made: where, and whether it carried the token, over TLS or not
  const probed = [];   // every certificate read (a TLS handshake, nothing sent)
  let presented = 'sha256:' + '0123456789abcdef'.repeat(4);
  const real = { request: tlsmod.request, probeCertificate: tlsmod.probeCertificate };
  tlsmod.request = async (url, o) => {
    sent.push({ url, token: (o.headers || {})['X-Patterns-Token'] === token, tls: !!o.tls });
    return { status: 200, body: { v: 1, node: { t: 'patterns', id: 'p1', name: 'Patterns FOH' }, light: 'green', headline: 'Programme', commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }] }, text: '' };
  };
  tlsmod.probeCertificate = async (host, port) => { probed.push(host + ':' + port); return { pem: 'pem', fp: presented }; };
  const links = [];
  const make = (base, extra = {}) => {
    const l = new pl.PeerLink({ node: { t: 'patterns', id: 'p1', name: 'Patterns FOH' }, base, token, pins: new tlsmod.PinStore(), ...extra });
    links.push(l);
    return l;
  };
  const settled = (l, status) => until(() => l.status === status && !l.busy, 3000, l.base + ' ' + status);
  // No 8 characters of a certificate's fingerprint (half of what confirms it) anywhere a page could read them.
  const tellsNone = (l, ...fps) => {
    const seen = JSON.stringify(l.view());
    for (const fp of fps) for (let i = 7; i + 8 <= fp.length; i++) assert.ok(!seen.includes(fp.slice(i, i + 8)), 'the page is told ' + fp.slice(i, i + 8) + ': ' + seen);
  };
  try {
    // Another machine in plain HTTP: refused with words, red, and nothing sent — not even a certificate asked for.
    const plain = make('http://192.0.2.10:9696');
    await settled(plain, 'refused');
    assert.match(plain.problem, /offers no encrypted connection, and its token — full control of it — is never sent in the clear to another machine/);
    assert.equal(plain.view().light, 'red');
    await plain.poll();
    assert.deepEqual([sent.length, probed.length], [0, 0], 'the token never leaves on a plain connection to another machine');

    // This machine in plain HTTP: the token goes, and never crosses the network.
    for (const base of ['http://127.0.0.1:9696', 'http://[::1]:9696', 'http://localhost:9696', 'http://127.4.5.6:9696']) await settled(make(base), 'live');
    assert.ok(sent.length >= 4 && sent.every((r) => r.token && !r.tls && /^http:\/\/(127\.|\[::1\]|localhost)/.test(r.url)), JSON.stringify(sent));
    sent.length = 0;

    // Another machine over TLS, its certificate never confirmed: refused; only its certificate is read.
    const far = make('https://192.0.2.10:9443');
    await settled(far, 'refused');
    assert.match(far.problem, /not confirmed yet — type the first 16 or more characters of the fingerprint Patterns FOH shows on its own screen/);
    assert.deepEqual([far.view().certificateWaits, far.view().certificateChanged], [true, false]);
    tellsNone(far, presented);
    assert.ok(probed.includes('192.0.2.10:9443'));
    assert.equal(sent.length, 0);
    // A person confirms it: too few characters, or not its start, are refused; its start, typed any way, pins it.
    for (const typed of ['', presented.slice(7, 15), presented.slice(7, 22), 'b2b2b2b2b2b2b2b2', presented.slice(8, 24)]) assert.match(far.acceptCertificate(typed).error, /not the first characters .* type at least 16/, typed + ': too short, or not its start');
    assert.equal(sent.length, 0);
    assert.deepEqual(far.acceptCertificate('SHA256:01:23:45:67:89:AB:CD:EF'), { ok: true, changed: false });
    await settled(far, 'live');
    assert.equal(far.pins.pins[pl.pinKey('p1')], presented, 'pinned');
    assert.ok(sent.length > 0 && sent.every((r) => r.token && r.tls && r.url.startsWith('https://192.0.2.10:9443/')), JSON.stringify(sent));
    // Its certificate changes: refused again until a person types the start of the new one.
    presented = 'sha256:' + 'fedcba9876543210'.repeat(4);
    sent.length = 0;
    far.endpoint = null;
    await far.poll();
    assert.deepEqual([far.status, far.view().certificateChanged], ['refused', true]);
    assert.match(far.problem, /CERTIFICATE CHANGED/);
    tellsNone(far, presented, 'sha256:' + '0123456789abcdef'.repeat(4));
    assert.equal(sent.length, 0);
    assert.equal(far.acceptCertificate('0123456789abcdef').ok, false, 'the old certificate\'s start confirms nothing');
    assert.deepEqual(far.acceptCertificate('fedcba9876543210'), { ok: true, changed: true });
    await settled(far, 'live');

    // Typed when linked: confirmed at once, pinned; typed wrong: refused, and nothing sent to it.
    const typed = make('https://192.0.2.11:9443', { confirmFp: 'fedcba9876543210' });
    await settled(typed, 'live');
    assert.equal(typed.pins.pins[pl.pinKey('p1')], presented);
    const wrong = make('https://192.0.2.12:9443', { confirmFp: 'deadbeefdeadbeef' });
    await settled(wrong, 'refused');
    assert.match(wrong.problem, /does not start with the characters typed for it/);
    tellsNone(wrong, presented);
    assert.equal(sent.filter((r) => r.url.includes('192.0.2.12')).length, 0);
    assert.equal(wrong.pins.pins[pl.pinKey('p1')], undefined, 'nothing pinned');

    // A hello announcing TLS for a node on another machine (anyone can send one): its certificate is still refused until
    // a person types its start — the hello's word for it, matching or not, is no confirmation, and is never shown.
    const heard = make('http://192.0.2.14:9696', { findPeer: () => ({ id: 'p1', tls: presented, ports: { https: 9443 } }) });
    await settled(heard, 'refused');
    assert.match(heard.problem, /not confirmed yet/);
    tellsNone(heard, presented);
    assert.equal(sent.filter((r) => r.url.includes('192.0.2.14')).length, 0, 'the token never reaches it');
    assert.equal(heard.pins.pins[pl.pinKey('p1')], undefined, 'nothing pinned');
    assert.ok(heard.acceptCertificate(presented.slice(7, 23)).ok);
    await settled(heard, 'live');
    assert.ok(sent.some((r) => r.url.startsWith('https://192.0.2.14:9443/') && r.token && r.tls), 'its token goes over TLS once a person confirmed it');
    const announced = 'sha256:' + '89abcdef01234567'.repeat(4);
    const spoofed = make('http://192.0.2.15:9696', { findPeer: () => ({ id: 'p1', tls: announced, ports: { https: 9443 } }) });
    await settled(spoofed, 'refused');
    assert.match(spoofed.problem, /its certificate is not the one its hello announces — another machine may be answering as it; to confirm the one it presents, type the first 16 or more characters/);
    tellsNone(spoofed, presented, announced);
    assert.equal(sent.filter((r) => r.url.includes('192.0.2.15')).length, 0);
    assert.equal(spoofed.acceptCertificate(announced.slice(7, 23)).ok, false, 'the hello\'s fingerprint confirms nothing');

    // A pin the Stagewatch link made on first use, under an id from an unauthenticated hello ("node:<id>"), is no person's
    // confirmation: a node announcing that id on another machine is still refused until someone types its start.
    const shared = new tlsmod.PinStore({ ['node:p1']: presented });
    const borrowed = make('https://192.0.2.13:9443', { pins: shared });
    await settled(borrowed, 'refused');
    assert.match(borrowed.problem, /not confirmed yet/);
    assert.equal(sent.filter((r) => r.url.includes('192.0.2.13')).length, 0, 'the token never reaches it');
    assert.deepEqual(shared.pins, { 'node:p1': presented }, 'and the Stagewatch link\'s pin is left as it was');

    // send() is off: refused with words, and nothing is sent.
    const before = sent.length;
    const r = typed.send('VIDEO END 10');
    assert.deepEqual([r.ok, r.stage], [false, 'not sent']);
    assert.equal(r.error, 'Not sent: AGMessage holds only Patterns FOH\'s pairing token, which is full control of it, so it never drives Patterns FOH directly — propose the line to the show desk, where a person approves it and Patterns FOH collects it with its own key.');
    assert.equal(sent.length, before);
    assert.ok(!sent.some((x) => x.url.endsWith('/api/cmd')), 'no line is ever posted to a node');
  } finally {
    links.forEach((l) => l.stop());
    Object.assign(tlsmod, real);
  }
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

test('peerlinks: a line is rated as the node rates it; a verb\'s secret never written down (C22, C44)', () => {
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
  assert.ok(json[2].includes('tok'), 'the carried line\'s own secret words: the line is never proposed');
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

// Stagewatch's proposal JSON (SharedProposal.ToJson, src/Timer.Core/Approvals.cs:20-32) as System.Text.Json writes it:
// declared order, nulls kept, result and words the same string, ok at the top level.
const swProposal = (state, { result = '', target = { t: 'main', id: 'sw01', name: '' } } = {}) => ({
  id: 'p3', from: { t: 'messenger', id: 'a1b2c3d4', name: 'AGMessage' }, target,
  line: 'message "Two minutes" warn off ack', reason: 'asks', risk: 'review', state,
  created: 1761390000000, decided: state === 'pending' ? null : 1761390005000, decidedBy: state === 'pending' ? '' : 'operator', result,
  ok: state === 'done' ? true : state === 'failed' || state === 'undelivered' ? false : null, words: result,
});
const outcomeOf = (j) => { const p = nodes.readProposal(JSON.parse(JSON.stringify(j))); return p && { state: p.state, ok: p.ok, words: p.words }; };

test('a proposal\'s outcome as Stagewatch states it: ok and words at the top level, result a string', () => {
  assert.deepStrictEqual(outcomeOf(swProposal('done', { result: 'message shown' })), { state: 'done', ok: true, words: 'message shown' });
  assert.deepStrictEqual(outcomeOf(swProposal('failed', { result: 'not a valid Stagewatch command: unknown verb' })), { state: 'failed', ok: false, words: 'not a valid Stagewatch command: unknown verb' });
  assert.deepStrictEqual(outcomeOf(swProposal('undelivered', { result: "Patterns FOH didn't collect it", target: { t: 'patterns', id: '9f8e7d6c', name: 'Patterns FOH' } })),
    { state: 'undelivered', ok: false, words: "Patterns FOH didn't collect it" });
  for (const s of ['pending', 'approved', 'rejected']) assert.deepStrictEqual(outcomeOf(swProposal(s)), { state: s, ok: null, words: '' }, s);
  // The submit receipt's ok is the request's (Stagewatch MainViewModel.Desk.cs:32), never the outcome of one that has not run.
  assert.deepStrictEqual(outcomeOf({ ok: true, id: 'p3', state: 'pending', risk: 'review' }), { state: 'pending', ok: null, words: '' });
  assert.deepStrictEqual(nodes.readProposalList({ proposals: [swProposal('approved')] }).map((p) => [p.state, p.ok]), [['approved', null]]);
});

test('a proposal\'s outcome fails closed: a non-boolean or contradicting ok, a nested result, an unknown state', () => {
  const done = swProposal('done', { result: 'x' });
  for (const ok of ['true', 1, null, undefined, false, {}]) assert.deepStrictEqual(outcomeOf({ ...done, ok }), { state: 'unknown', ok: null, words: 'x' }, String(ok));
  assert.deepStrictEqual(outcomeOf({ ...swProposal('failed', { result: 'no' }), ok: true }), { state: 'unknown', ok: null, words: 'no' });
  // Never Stagewatch's shape: a result object is not read, whatever it says.
  assert.deepStrictEqual(outcomeOf({ id: 'p1', state: 'failed', result: { ok: 'no' } }), { state: 'unknown', ok: null, words: '' });
  assert.deepStrictEqual(outcomeOf({ id: 'p1', state: 'done', result: {} }), { state: 'unknown', ok: null, words: '' });
  assert.deepStrictEqual(outcomeOf({ ...swProposal('approved'), state: 'expired' }), { state: 'unknown', ok: null, words: '' });
  assert.equal(nodes.readProposal({ state: 'done', ok: true }), null, 'no id: not a proposal (nor a /ws auth message)');
  assert.equal(nodes.readProposal([{ id: 'p1' }]), null, 'a list is not a proposal');
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

  await t.test('a proposal\'s outcome as Stagewatch states it reaches the message: done and failed with their words; anything else is unknown', async () => {
    const crew = await connect(base, sam); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
    const ask = async (text) => { const r = await emit(crew, 'stage:propose', { text, destination: 'speaker', urgency: 'info' }); assert.ok(r.ok, JSON.stringify(r)); return r.proposal.id; };
    const done = await ask('Outcome done'), failed = await ask('Outcome failed'), odd = await ask('Outcome odd');
    for (const id of [done, failed, odd]) sw.approve(id, 'operator');
    sw.finish(done, true, 'message shown on the speaker screen');
    sw.finish(failed, false, 'not a valid Stagewatch command: flash must be off|slow|fast');
    sw.finish(odd, true, 'shown');
    sw.proposals.get(odd).served = { ok: 'true' };   // not Stagewatch's: a string where it puts a boolean
    const outcome = async (text) => { const m = (await emit(ctl, 'admin:watchRoom', { roomCode: hall })).messages.find((x) => x.type === 'system' && x.proposal && x.text.includes(text)); return m && { state: m.proposal.state, ok: m.proposal.ok, words: m.proposal.words, by: m.proposal.by }; };
    await until(async () => ['done', 'failed'].includes((await outcome('Outcome failed') || {}).state) && (await outcome('Outcome done') || {}).state === 'done' && (await outcome('Outcome odd') || {}).state !== 'approved', 12000, 'settled');
    assert.deepStrictEqual(await outcome('Outcome done'), { state: 'done', ok: true, words: 'message shown on the speaker screen', by: 'operator' });
    assert.deepStrictEqual(await outcome('Outcome failed'), { state: 'failed', ok: false, words: 'not a valid Stagewatch command: flash must be off|slow|fast', by: 'operator' });
    assert.deepStrictEqual(await outcome('Outcome odd'), { state: 'unknown', ok: null, words: 'shown', by: 'operator' });
    // Unknown is not an end: asked again, the desk's next answer in Stagewatch's own shape settles it.
    delete sw.proposals.get(odd).served;
    await until(async () => (await outcome('Outcome odd') || {}).state === 'done', 12000, 'asked again and settled');
    assert.deepStrictEqual(await outcome('Outcome odd'), { state: 'done', ok: true, words: 'shown', by: 'operator' });
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

  await t.test('only what the desk says is approved for this AGMessage is run: a listed proposal in a state it cannot read, or for another node, is not', async () => {
    const seen = [];
    const crew = await connect(base, sam); sockets.push(crew);
    assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
    crew.on('system', (m) => { if (/From the show desk/.test(m.text)) seen.push(m.text); });
    const nodeId = new URL(sw.requests.find((r) => r.url.includes('?target=')).url, 'http://x').searchParams.get('target');
    const odd = sw.add({ line: 'notice Not for running', state: 'approved', decidedBy: 'operator', from: { t: 'main', id: 'swdesk', name: 'Desk' }, target: { t: 'messenger', id: nodeId, name: 'AGMessage' } });
    sw.proposals.get(odd).served = { state: 'expired' };
    const elsewhere = sw.add({ line: 'notice For another node', state: 'approved', decidedBy: 'operator', from: { t: 'main', id: 'swdesk', name: 'Desk' }, target: { t: 'messenger', id: nodeId, name: 'AGMessage' } });
    sw.proposals.get(elsewhere).served = { target: { t: 'messenger', id: 'ffffffff', name: 'Another AGMessage' } };   // listed, yet another node's
    const fine = sw.add({ line: 'notice Fine to run', state: 'approved', decidedBy: 'operator', from: { t: 'main', id: 'swdesk', name: 'Desk' }, target: { t: 'messenger', id: nodeId, name: 'AGMessage' } });
    await until(() => sw.proposals.get(fine).state === 'done' && seen.some((x) => /Fine to run/.test(x)), 12000, 'the approved one run, shown and reported');
    assert.deepStrictEqual([seen.some((x) => /Fine to run/.test(x)), seen.some((x) => /Not for running/.test(x)), seen.some((x) => /For another node/.test(x))], [true, false, false]);
    assert.ok(!sw.requests.some((r) => r.url === '/api/proposals/' + odd + '/result' || r.url === '/api/proposals/' + elsewhere + '/result'), 'nothing reported for them');
    sw.proposals.delete(odd); sw.proposals.delete(elsewhere); sw.proposals.delete(fine);
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

  await t.test('AG-1: a Patterns on another machine that offers no TLS is refused with words, and never sent its token', async () => {
    // Reached by this machine's own network address (not loopback): as a Patterns on another laptop would be.
    const lan = require('../lib/tls').lanAddresses()[0];
    assert.ok(lan, 'this test needs a network address that is not loopback (every CI runner and show laptop has one)');
    const far = await fakeNode({ t: 'patterns', name: 'Patterns far', token: PATTERNS_TOKEN, host: '0.0.0.0', commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }] });
    try {
      // That address reaches the fake: "nothing reached it" below is about the gate, not a road that goes nowhere.
      assert.equal((await fetch('http://' + lan + ':' + far.port + '/reach')).status, 401, 'it answers there (without its token, as it should)');
      assert.deepEqual(far.requests.map((r) => r.url), ['/reach']);
      far.requests.length = 0;
      assert.ok((await emit(ctl, 'nodes:link', { id: 'farpat', t: 'patterns', url: lan + ':' + far.port, name: 'Patterns far', token: PATTERNS_TOKEN })).ok);
      let v;
      await until(async () => { v = (await emit(ctl, 'nodes:list', {})).linked.find((n) => n.id === 'farpat'); return v && v.status === 'refused'; }, 8000, 'refused');
      assert.match(v.problem, /offers no encrypted connection, and its token — full control of it — is never sent in the clear to another machine: turn HTTPS on in Patterns far/);
      assert.equal(v.light, 'red');
      await wait(300);
      assert.deepEqual(far.requests, [], 'nothing reached it — its token least of all');
      // A fingerprint is typed as at least 16 of its hex characters, or the link is refused with words.
      for (const fingerprint of ['abcdef01', 'abcdef0123456789'.slice(0, 15), 'not-hex-at-all-at-all', 'sha256:xyz123456789abcd']) {
        const r = await emit(ctl, 'nodes:link', { id: 'farpat', fingerprint });
        assert.deepEqual([r.ok, r.error], [false, 'Type at least 16 characters of its certificate\'s fingerprint (0–9, a–f), as the node shows it on its own screen.'], fingerprint);
      }
      assert.ok((await emit(ctl, 'nodes:link', { id: 'farpat', fingerprint: 'AB:CD:EF:01:23:45:67:89' })).ok, 'kept as hex; it offers no TLS, so still refused');
      await wait(300);
      assert.deepEqual(far.requests, []);
      const audit = fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8');
      assert.ok(audit.includes('(16 characters of its certificate\'s fingerprint typed)'));
    } finally {
      await emit(ctl, 'nodes:unlink', { id: 'farpat' });   // whatever failed above: never left linked for the next subtest
      await far.close();
    }
    assert.equal((await emit(ctl, 'nodes:list', {})).linked.some((n) => n.id === 'farpat'), false);
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

  await t.test('AG-1: no line is ever sent to a node directly — refused with words; a listed verb is proposed with the node\'s risk', async () => {
    const senior = await connect(base, sol); sockets.push(senior);
    const list = await emit(senior, 'nodes:list', {});
    assert.ok(list.ok && list.desk);
    assert.deepEqual(list.linked.find((n) => n.id === 'patterns01').commands.map((c) => c.verb), ['VIDEO END <seconds>', 'BLACKOUT on|off']);
    const sent = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'VIDEO END 10', mode: 'send' });
    assert.deepEqual([sent.ok, sent.stage], [false, 'not sent']);
    assert.match(sent.error, /^Not sent: AGMessage holds only Patterns FOH's pairing token, which is full control of it, so it never drives Patterns FOH directly — propose the line to the show desk/);
    for (const mode of [undefined, 'now', 'SEND', 'constructor', 3]) {
      const r = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'VIDEO END 10', mode });
      assert.equal(r.ok, false, String(mode));
      assert.match(r.error, /Unknown mode/, String(mode));
    }
    const no = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'SHUTDOWN now', mode: 'propose' });
    assert.equal(no.ok, false);
    assert.match(no.error, /does not list that command/);
    const review = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'VIDEO END 10', mode: 'propose' });
    assert.deepEqual([review.ok, review.risk], [true, 'review'], JSON.stringify(review));
    const prop = await emit(senior, 'nodes:command', { id: 'patterns01', line: 'BLACKOUT on', mode: 'propose' });
    assert.ok(prop.ok, JSON.stringify(prop));
    const p = sw.proposals.get(prop.proposal.id);
    assert.deepEqual([p.line, p.risk, p.target.t, p.target.id], ['BLACKOUT on', 'high', 'patterns', 'patterns01']);
    assert.equal(sw.proposals.get(review.proposal.id).risk, 'review', 'the desk is told the node\'s own risk');
    assert.ok([pat, pm].every((n) => n.requests.every((x) => x.method === 'GET' && x.url !== '/api/cmd')), 'neither node was ever driven');
    const a = await api(base, 'GET', '/api/audit?limit=100', undefined, { cookie: admin });
    assert.ok(a.body.entries.some((e) => e.action === 'node.propose' && /VIDEO END 10 → proposed/.test(e.words)));
    assert.ok(a.body.entries.some((e) => e.action === 'node.propose' && /BLACKOUT on → proposed/.test(e.words)));
    assert.ok(!a.body.entries.some((e) => e.action === 'node.command'), 'nothing was sent, so nothing is recorded as sent');
  });

  await t.test('C22: a PlayMap line its own catalogue rates high reaches the show desk rated high', async () => {
    const senior = await connect(base, sol); sockets.push(senior);
    assert.ok((await emit(ctl, 'nodes:link', { id: 'playmap01', hall })).ok, 'PlayMap moves to Hall 1, whose Stagewatch keeps the desk');
    await until(async () => { const n = (await emit(senior, 'nodes:list', {})).linked.find((x) => x.id === 'playmap01'); return n.status === 'live' && n.commands.length === 6 && n.desk; }, 8000, 'PlayMap\'s verbs');
    assert.ok(pm.requests.some((x) => x.url === '/api/verbs' && x.headers['x-playmap-token'] === PLAYMAP_TOKEN), 'its vocabulary read with its token');
    for (const line of ['BIND ADD MIDI APC40 NOTE 1 53 TO BLACKOUT OFF', 'BIND LEARN BLACKOUT ON', 'DECODE POLICY DIRECT FORCE', 'BIND ADD {"input":"OSC /x","target":"BLACKOUT ON"}']) {
      const r = await emit(senior, 'nodes:command', { id: 'playmap01', line, mode: 'propose' });
      assert.deepEqual([r.ok, r.risk], [true, 'high'], line + ': ' + JSON.stringify(r));
      assert.equal(sw.proposals.get(r.proposal.id).risk, 'high', line + ': the desk is told it is high');
    }
    const ok = await emit(senior, 'nodes:command', { id: 'playmap01', line: 'DECODE POLICY DIRECT', mode: 'propose' });
    assert.deepEqual([ok.ok, ok.risk], [true, 'review']);
    assert.equal((await emit(senior, 'nodes:command', { id: 'playmap01', line: 'DECODE POLICY DIRECT', mode: 'send' })).stage, 'not sent');
    assert.ok(!pm.requests.some((x) => x.url === '/api/cmd'), 'none reached PlayMap, sent or proposed');
  });

  await t.test('C44: a line carrying a secret is neither sent nor proposed, and its secret is written down nowhere', async () => {
    const secret = 'K7QM-3XWD-P9RB';   // secret-scan: fixture — a fake Patterns pairing token inside a PlayMap verb
    const senior = await connect(base, sol); sockets.push(senior);
    const before = sw.proposals.size;
    for (const [line, shown] of [['LINK PATTERNS 10.0.0.5:9696 ' + secret, 'LINK PATTERNS 10.0.0.5:9696 …'], ['BIND ADD OSC /fader/9 TO LINK PATTERNS 10.0.0.5:9696 ' + secret, 'BIND ADD OSC /fader/9 TO LINK PATTERNS 10.0.0.5:9696 …'],
      ['BIND ADD {"input":"OSC /a","target":"LINK PATTERNS 10.0.0.5 ' + secret + '"}', 'BIND ADD …']]) {
      const prop = await emit(senior, 'nodes:command', { id: 'playmap01', line, mode: 'propose' });
      assert.deepEqual([prop.ok, prop.error], [false, '“' + shown + '” carries a secret: set it on Stage left itself — a proposal would keep it in the show desk\'s queue.'], line);
      assert.equal((await emit(senior, 'nodes:command', { id: 'playmap01', line, mode: 'send' })).stage, 'not sent', line);
    }
    assert.equal(sw.proposals.size, before, 'never put in the desk\'s queue');
    assert.ok(!pm.requests.some((x) => JSON.stringify(x).includes(secret)), 'never reached PlayMap');
    const a = await api(base, 'GET', '/api/audit?limit=200', undefined, { cookie: admin });
    assert.ok(!JSON.stringify(a.body).includes(secret), 'not in the audit log');
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

test('show network rights: a one-hall driver sees only its halls and nodes, a node proposes only to its own hall\'s desk, and a hall\'s facts reach only its own readers', async (t) => {
  const swA = await fakeStagewatch({ name: 'Hall A timer', desk: false });
  const swB = await fakeStagewatch({ name: 'Hall B timer', desk: true });
  const swA2 = await fakeStagewatch({ name: 'Hall A desk', desk: true });
  const venue = await fakeNode({ t: 'playmap', name: 'Main wall', token: PLAYMAP_TOKEN, commands: [{ verb: 'PLAYLIST GO <name>', risk: 'low' }] });
  const nodeA = await fakeNode({ t: 'patterns', name: 'Hall A Patterns', token: PATTERNS_TOKEN, commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }, { verb: 'BLACKOUT on|off', risk: 'high' }] });
  const nodeB = await fakeNode({ t: 'patterns', name: 'Hall B Patterns', token: PATTERNS_TOKEN, commands: [{ verb: 'VIDEO END <seconds>', risk: 'review' }] });
  const model = await fakeModel();
  const srv = await startServer({ ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: model.url });
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); for (const x of [swA, swB, swA2, venue, nodeA, nodeB, model]) await x.close(); });

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hallA = (await api(base, 'POST', '/api/rooms', { name: 'Hall A' }, { cookie: admin })).body.code;
  const hallB = (await api(base, 'POST', '/api/rooms', { name: 'Hall B' }, { cookie: admin })).body.code;
  const hallC = (await api(base, 'POST', '/api/rooms', { name: 'Hall C (board only)' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'tom', name: 'Tom Tech', role: 'tech', halls: [hallA], grant: ['nodes.control'], password: 'gaffer tape on the riser' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sid', name: 'Sid Senior', role: 'senior', allHalls: false, halls: [hallA], password: 'cable run under stage' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'sol', name: 'Sol Senior', role: 'senior', password: 'radio check one two' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'tim', name: 'Tim Tech', role: 'tech', halls: [hallA], password: 'patch bay on the left' }, { cookie: admin });
  await api(base, 'POST', '/api/users', { username: 'val', name: 'Val Viewer', role: 'viewer', halls: [hallA], password: 'a quiet seat at the back' }, { cookie: admin });
  const login = async (username, password) => (await api(base, 'POST', '/api/auth/login', { username, password })).cookie;
  const tomC = await login('tom', 'gaffer tape on the riser');
  const sidC = await login('sid', 'cable run under stage');
  const solC = await login('sol', 'radio check one two');
  const timC = await login('tim', 'patch bay on the left');
  const valC = await login('val', 'a quiet seat at the back');
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
    for (const [id, line] of [['venue01', 'PLAYLIST GO walkout'], ['h2pat', 'VIDEO END 10']]) {
      for (const mode of ['propose', 'send']) assert.deepEqual(await emit(sid, 'nodes:command', { id, line, mode }), { ok: false, error: 'No such link, or not yours to drive.' }, id + ' ' + mode);
    }
    assert.ok(venue.requests.every((x) => x.url !== '/api/cmd'), 'nothing reached the venue-wide node');
    const sol = await connect(base, solC); sockets.push(sol);
    assert.deepEqual((await emit(sol, 'nodes:list', {})).linked.map((n) => n.id).sort(), ['h1pat', 'h2pat', 'venue01'], 'a senior with every hall still drives them all');
    // Past the rights: the venue-wide node's line goes to the default Stagewatch's desk, and there is none here.
    assert.deepEqual(await emit(sol, 'nodes:command', { id: 'venue01', line: 'PLAYLIST GO walkout', mode: 'propose' }), { ok: false, error: 'The default Stagewatch is not linked — not proposed.' });
  });

  await t.test('the board offers Show network exactly to those it lets in; a hall\'s crew still sees its node\'s chip', async () => {
    for (const [who, cookie, drives] of [['a tech', timC, false], ['a viewer', valC, false], ['a tech given nodes.control', tomC, true], ['a one-hall senior', sidC, true], ['a senior of every hall', solC, true]]) {
      const s = await connect(base, cookie); sockets.push(s);
      const b = (await emit(s, 'board:watch', {})).board;
      const list = await emit(s, 'nodes:list', {});
      assert.deepEqual(b.halls.find((h) => h.code === hallA).nodes.map((n) => n.id), ['h1pat'], who + ': hall A\'s row keeps its node');
      assert.deepEqual([b.canDrive, !!(list.ok && list.linked.length)], [drives, drives], who + ': the button is offered exactly when the dialog it opens lists a node');
    }
  });

  await t.test('a hall\'s AI brief names its own hall\'s nodes and those of every hall, never another hall\'s', async () => {
    for (const [code, own, other] of [[hallA, 'Hall A Patterns', 'Hall B Patterns'], [hallB, 'Hall B Patterns', 'Hall A Patterns']]) {
      const g = await connect(base); sockets.push(g);
      assert.ok((await emit(g, 'join', { roomCode: code, name: 'Gus', role: 'research' })).ok);
      model.bodies.length = 0;
      const draft = await emit(g, 'ai:draft', { question: 'What do the show systems say?' });
      const options = await emit(g, 'ai:options', { prompt: 'Are the screens ready?' });
      assert.ok(draft.ok && options.ok, JSON.stringify([draft, options]));
      assert.equal(model.bodies.length, 2);
      for (const body of model.bodies) {
        assert.ok(body.includes(own) && body.includes('Main wall'), code + ': its own node and the one of every hall');
        assert.ok(!body.includes(other), code + ': never ' + other);
      }
    }
  });

  await t.test('each hall\'s Stagewatch is posted its own hall\'s recent events, never another hall\'s; the node\'s context keeps all', async () => {
    const bea = await connect(base); sockets.push(bea);
    assert.ok((await emit(bea, 'join', { roomCode: hallB, name: 'Bea', role: 'research' })).ok);
    const help = await emit(bea, 'message', { type: 'help', category: 'Sound', text: 'mic 3 down' });
    assert.ok(help.ok);
    assert.ok((await emit(bea, 'help:respond', { messageId: help.id, state: 'resolved' })).ok);
    assert.ok((await emit(bea, 'stage:send', { text: 'Wrap up' })).ok);
    const posted = (sw) => sw.requests.filter((r) => r.url === '/api/peers/context').map((r) => JSON.parse(r.body));
    const hallEvents = (ctx) => ctx.recent.map((r) => r.text).filter((x) => /help request|stage screen|stage message/.test(x));
    const want = ['a help request was resolved', 'research sent a message to the stage screen (applied)'];
    await until(() => posted(swB).length && JSON.stringify(hallEvents(posted(swB).at(-1))) === JSON.stringify(want), 8000, 'hall B\'s Stagewatch posted its hall\'s events');
    await wait(1300);   // one more push round for every link
    assert.ok(posted(swA).length > 0, 'hall A\'s Stagewatch is posted its context');
    assert.deepEqual(posted(swA).flatMap(hallEvents), [], 'hall A had no help request and sent nothing to its stage: none of hall B\'s reach it');
    const whole = (await api(base, 'GET', '/api/context', undefined, { cookie: admin })).body;
    assert.deepEqual(hallEvents(whole), want, 'the node\'s own context keeps every hall\'s');
    assert.ok(!JSON.stringify(whole.recent).includes('hall:'), 'the link an event belongs to is never published');
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

