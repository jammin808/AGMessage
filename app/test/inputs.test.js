'use strict';
// What a client sends can refuse its own request but never stop the event: every socket event the server listens to
// (read from every handler file, `handlerFiles()`, so a new handler is held to this too) is sent every argument shape
// a client can — null, a number, a string, a list, an empty object, an object of nulls — from a socket that never
// signed in, from a crew account in its hall, from the admin, and display:shown from a screen. The server stays up and
// answers.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { io } = require('socket.io-client');
const { ROOT, startServer, stopServer, api, connect, emit, handlerFiles, TOKEN, readSource } = require('./helpers');

const EVENTS = [...new Set(handlerFiles().flatMap((f) => [...readSource(path.join(ROOT, f)).matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1])))]
  .filter((e) => e !== 'disconnect');
// Not sent from the admin socket: they start cloudflared or make a new certificate — real work, not an argument check.
const ADMIN_SKIP = new Set(['admin:tunnelStart', 'admin:tunnelStop', 'admin:renewCertificate']);
const NULLS = { roomCode: null, code: null, id: null, messageId: null, text: null, content: null, seq: null, targetRoom: null, socketId: null, line: null, state: null, hall: null, cid: null, on: null, heldMs: null, until: null, codeOn: null, newCode: null, keepGuests: null, sendFrom: null, sendBack: null, to: null, replyTo: null, uid: null, kind: null, url: null, again: null, ifSeq: null };
// An object whose toString is not a function: String() throws on it, so a handler must never call String() on input.
const U = { toString: 1 };
const UNCONVERTIBLE = { roomCode: U, code: U, id: U, messageId: U, name: U, text: U, caption: U, options: [U], content: { kind: 'message', text: U }, seq: U, targetRoom: U, line: U, state: U, hall: U, words: U, destination: U, urgency: U, image: U, token: U, url: U, cid: U, heldMs: U, until: U, sendFrom: [U], sendBack: [U], to: U, replyTo: U, uid: U, kind: U, again: U, ifSeq: U };
const SHAPES = [null, 7, 'x', true, [], {}, NULLS, { code: {}, id: [], roomCode: 5, messageId: {}, content: 'x', text: {} }, UNCONVERTIBLE];

// Each send: with an answer callback (the server may answer it) or without; either way at most 400 ms is waited.
const send = (s, ev, arg) => new Promise((resolve) => { s.timeout(400).emit(ev, arg, (err, r) => resolve(err ? 'silence' : r)); });

test('every socket event survives every argument shape, from every kind of socket', { timeout: 180_000 }, async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  assert.ok(EVENTS.length > 50, 'the events were read from the handler files: ' + EVENTS.length);

  const admin = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  await api(base, 'POST', '/api/users', { username: 'sam', name: 'Sam Tech', role: 'tech', halls: [hall], password: 'mixing desk on stage left' }, { cookie: admin });
  const sam = (await api(base, 'POST', '/api/auth/login', { username: 'sam', password: 'mixing desk on stage left' })).cookie;

  const anon = await connect(base); sockets.push(anon);
  const crew = await connect(base, sam); sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: hall, as: 'account' })).ok);
  const ctl = await connect(base, admin); sockets.push(ctl);
  const made = await emit(ctl, 'display:create', { code: hall, name: 'Lectern monitor' });
  const scr = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: made.display.path.slice(3) } });
  sockets.push(scr);
  await new Promise((resolve, reject) => { scr.once('connect', resolve); scr.once('connect_error', reject); });

  const answered = await send(anon, 'help:respond', null);
  assert.equal(answered && answered.ok, false, 'a null argument is answered with a refusal, not the end of the server: ' + JSON.stringify(answered));

  for (const [who, s, events] of [['no sign-in', anon, EVENTS], ['crew', crew, EVENTS], ['admin', ctl, EVENTS.filter((e) => !ADMIN_SKIP.has(e))], ['screen', scr, ['display:shown']]]) {
    for (const shape of SHAPES) {
      await Promise.all(events.map((ev) => send(s, ev, shape)));
      for (const ev of events.slice(0, 3)) s.emit(ev, shape);   // no answer callback at all
      assert.equal(srv.child.exitCode, null, 'the server is still running after ' + who + ' sent ' + JSON.stringify(shape));
    }
  }
  const health = await api(base, 'GET', '/api/health', undefined, { cookie: admin });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  t.diagnostic('requests the handler guard refused: ' + health.body.handlerFaults);
  assert.ok(!/\[error\]/.test(srv.out()), 'nothing reached the uncaught-exception path:\n' + srv.out().split('\n').filter((l) => /\[error\]/.test(l)).slice(0, 5).join('\n'));
});

test('client values are read by their type: a value String() cannot convert reaches no String() call', { timeout: 120_000 }, async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  const admin = (await api(base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const ctl = await connect(base, admin); sockets.push(ctl);
  const made = await emit(ctl, 'display:create', { code: hall, name: 'Lectern monitor' });
  const anon = await connect(base); sockets.push(anon);
  const guest = await connect(base); sockets.push(guest);
  assert.ok((await emit(guest, 'join', { roomCode: hall, name: 'Rita', role: 'research' })).ok);
  // A message of the guest's own, so a reaction's `on` is read: an unknown message is refused before it.
  const posted = await emit(guest, 'message', { type: 'text', text: 'react to me' });
  assert.ok(posted.ok, JSON.stringify(posted));
  // A room the hall may send into, so a send into it reads what it would send: its reference, as the guest is told it.
  const legal = (await emit(ctl, 'room:create', { hall, name: 'Legal' })).key;
  assert.ok((await emit(ctl, 'room:update', { code: legal, sendFrom: [hall] })).ok);
  const ref = (await emit(guest, 'room:sendTargets', {})).targets[0].ref;
  const cases = [
    [anon, 'join', { roomCode: U }], [anon, 'join', { roomCode: hall, name: U, role: 'research' }],
    [anon, 'display:list', { code: U }], [anon, 'display:take', { id: U }], [anon, 'help:respond', { code: U }],
    [guest, 'message', { type: 'text', text: U }], [guest, 'message', { type: 'file', url: U, caption: U }],
    [guest, 'message', { type: 'action', text: 'Go?', options: [U, 'Yes'] }], [guest, 'forward', { messageId: U, targetRoom: U }],
    [guest, 'message', { type: 'text', text: 'x', cid: U }], [guest, 'message', { type: 'text', text: 'x', heldMs: U }],
    [guest, 'react', { messageId: posted.id, emoji: '👍', on: U }], [guest, 'forward', { messageId: U, targetRoom: U, cid: U }],
    [ctl, 'display:take', { id: made.display.id, content: { kind: 'message', text: U } }], [ctl, 'display:create', { code: hall, name: U }],
    [ctl, 'admin:settings', { requireHttps: U, remoteAdmin: U, stagewatchUrl: U }], [ctl, 'nodes:link', { id: U, token: U }],
    [ctl, 'admin:tunnelUntil', { until: U }],
    [ctl, 'room:create', { hall: U, name: U }], [ctl, 'room:create', { hall, name: U }], [ctl, 'room:update', { code: U, name: U }], [ctl, 'room:settings', { code: U }],
    [ctl, 'room:update', { code: U, codeOn: U }], [ctl, 'room:update', { code: hall, codeOn: U }], [ctl, 'room:update', { code: hall, newCode: U }],
    [ctl, 'room:update', { code: hall, codeOn: false, keepGuests: U }],
    [ctl, 'room:update', { code: U, sendFrom: [U] }], [ctl, 'room:update', { code: hall, sendFrom: [U] }], [ctl, 'room:update', { code: hall, sendFrom: U }],
    [ctl, 'room:update', { code: hall, sendFrom: [], sendBack: [U] }],
    [guest, 'room:send', { to: U, type: 'text', text: U }], [guest, 'room:send', { to: U, messageId: U }], [guest, 'room:send', { to: ref, messageId: U }],
    [guest, 'room:send', { to: ref, type: 'text', text: U, replyTo: U }], [guest, 'room:send', { to: ref, type: 'file', url: U, caption: U }],
    [guest, 'room:send', { to: ref, type: U }], [guest, 'room:send', { to: ref, type: 'text', text: 'x', cid: U }], [guest, 'room:sendTargets', U],
    [guest, 'room:withdraw', { messageId: U }], [guest, 'room:withdraw', { messageId: U, cid: U }], [ctl, 'room:withdraw', { messageId: U }],
    // A take on people's pages, from the admin page so its content is read, and a page's report on one, each field by type.
    [ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: U } }], [ctl, 'page:push', { code: hall, to: 'board', content: { kind: U } }],
    [ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'holding', image: U } }], [ctl, 'page:push', { code: hall, to: 'board', content: U }],
    [ctl, 'page:push', { code: hall, to: { uid: U }, content: { kind: 'clock' } }], [ctl, 'page:push', { code: hall, to: U, content: { kind: 'clock' } }],
    [ctl, 'page:push', { code: U, to: 'board', content: { kind: 'clock' } }], [ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' }, cid: U }],
    [ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' }, ifSeq: U }],
    [ctl, 'page:status', { code: U }], [guest, 'page:report', { seq: U, state: U, words: U }], [guest, 'page:report', { seq: 1, state: 'shown', words: U, again: U }],
  ];
  // What each is answered: the field it could not read named, and nothing shown, numbered or reported.
  const KINDS = 'Choose what to show: back to chat, Stagewatch, the clock, holding or blank.';
  const TARGETS = 'Show the Board (to: \'board\') or one person (to: {uid}).';
  const pageWords = (ev, arg) => {
    if (ev === 'page:report') return arg.state === U ? 'A report is one of: shown, hidden, opened, failed, dismissed, minimised.' : 'That is not what this page is shown now.';
    if (arg.code === U) return 'No such hall.';
    if (arg.cid === U) return 'That act\'s id could not be read.';
    if (arg.ifSeq === U) return 'That act\'s take could not be read.';
    return arg.to === 'board' ? KINDS : TARGETS;
  };
  // A room's code acts read by type: each a refusal in its own words, and nothing switched or renewed.
  const CODE_WORDS = {
    codeOn: 'Say whether the code is on (true) or off (false).',
    newCode: 'Ask for a new code with newCode: true.',
    keepGuests: 'Whether the guests stay is said as the code is switched off: true or false.',
    sendFrom: 'Say which rooms may send here: a list of their keys (an empty list for none).',
    sendBack: 'Say which of them this room sends back into: a list of their keys.',
  };
  for (const [s, ev, arg] of cases) {
    const r = await send(s, ev, arg);
    assert.notEqual(r, 'silence', ev + ' ' + JSON.stringify(arg) + ' is answered');
    if (ev === 'react') assert.deepEqual(r, { ok: false, error: 'Say whether to add the reaction or take it away.' }, 'a reaction\'s `on` that is no boolean is read, and refused');
    if (ev === 'admin:tunnelUntil') assert.deepEqual(r, { ok: false, error: 'Give the end as a time of day, HH:MM by this laptop\'s clock (for example 23:30).' }, 'an end that is no string is read, and refused');
    // A room's hall, key and name that are no strings are read as none, and refused for it: no room is made or named.
    // A send into another room names its room, its message and its words by type: each refused for what it lacks.
    if (ev === 'room:sendTargets') assert.deepEqual(r, { ok: true, targets: [{ ref, name: 'Legal', hallName: 'Hall 3' }] }, 'a read takes no argument');
    if (ev.startsWith('page:')) {
      assert.deepEqual(r, { ok: false, error: pageWords(ev, arg) }, ev + ' ' + JSON.stringify(arg));
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    // A send taken back names its message by type: one that is no string is no message (the admin's page sits in no room).
    if (ev === 'room:withdraw') {
      assert.deepEqual(r, { ok: false, error: s === ctl ? 'Not joined' : 'Message not found' }, ev + ' ' + JSON.stringify(arg));
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (ev === 'room:send') {
      const words = arg.cid ? 'That message\'s id could not be read.' : arg.to !== ref ? (arg.type ? 'That room is gone.' : 'Message not found') : arg.messageId ? 'Message not found'
        : arg.type === U ? 'Only a message or a file is sent into another room.' : 'Invalid message';
      assert.deepEqual(r, { ok: false, error: words }, ev + ' ' + JSON.stringify(arg));
      continue;
    }
    const coded = ['keepGuests', 'newCode', 'codeOn', 'sendBack', 'sendFrom'].find((k) => k in arg && (k !== 'sendBack' || Array.isArray(arg.sendFrom) && arg.sendFrom.length === 0));
    if (ev === 'room:sendTargets') { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    if (ev.startsWith('room:') && coded) assert.deepEqual(r, { ok: false, error: arg.code === hall ? CODE_WORDS[coded] : 'No such room.' }, ev + ' ' + JSON.stringify(arg));
    else if (ev.startsWith('room:')) assert.deepEqual(r, { ok: false, error: arg.hall === hall ? 'Name the room (for example Legal).' : ev === 'room:create' ? 'No such hall.' : 'No such room.' }, ev + ' ' + JSON.stringify(arg));
    await new Promise((resolve) => setTimeout(resolve, 250));   // under every per-socket rate limit
  }
  const health = await api(base, 'GET', '/api/health', undefined, { cookie: admin });
  assert.equal(health.body.handlerFaults, 0, 'every handler read its input by type; the guard had nothing to catch');
  const audit = await api(base, 'GET', '/api/audit?limit=50', undefined, { cookie: admin });
  assert.ok(!audit.body.entries.some((e) => e.action === 'settings'), 'settings in the wrong type are not taken, and so not audited');
  assert.ok(!audit.body.entries.some((e) => e.action === 'room.code'), 'a code act in the wrong type switches nothing, and so is not audited');
  assert.deepEqual(audit.body.entries.filter((e) => e.action === 'room.sendFrom').map((e) => e.target), [legal], 'a list in the wrong type sets nothing, and so is not audited: the one row is Legal\'s, set above');
  assert.ok(!audit.body.entries.some((e) => e.action === 'room.send'), 'a send in the wrong type sends nothing, and so is not audited');
  assert.ok(!audit.body.entries.some((e) => e.action === 'room.withdraw'), 'a withdrawal in the wrong type takes nothing back, and so is not audited');
  assert.ok(!audit.body.entries.some((e) => e.action === 'page.push'), 'a take in the wrong type shows nothing, and so is not audited');
  assert.equal((await send(ctl, 'page:status', { code: hall })).board.seq, 0, 'and nothing was numbered');
  assert.deepEqual((await send(ctl, 'room:settings', { code: hall })).sendFrom, [], 'and no room may send into the hall');
});
