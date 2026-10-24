'use strict';
// What a client sends can refuse its own request but never stop the event: every socket event the server listens to
// (read from server.js, so a new handler is held to this too) is sent every argument shape a client can — null, a
// number, a string, a list, an empty object, an object of nulls — from a socket that never signed in, from a crew
// account in its hall, from the admin, and display:shown from a screen. The server stays up and answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { startServer, stopServer, api, connect, emit } = require('./helpers');

const EVENTS = [...new Set([...fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').matchAll(/socket\.on\('([^']+)'/g)].map((m) => m[1]))]
  .filter((e) => e !== 'disconnect');
// Not sent from the admin socket: they start cloudflared or make a new certificate — real work, not an argument check.
const ADMIN_SKIP = new Set(['admin:tunnelStart', 'admin:tunnelStop', 'admin:renewCertificate']);
const NULLS = { roomCode: null, code: null, id: null, messageId: null, text: null, content: null, seq: null, targetRoom: null, socketId: null, line: null, state: null, hall: null };
const SHAPES = [null, 7, 'x', true, [], {}, NULLS, { code: {}, id: [], roomCode: 5, messageId: {}, content: 'x', text: {} }];

// Each send: with an answer callback (the server may answer it) or without; either way at most 400 ms is waited.
const send = (s, ev, arg) => new Promise((resolve) => { s.timeout(400).emit(ev, arg, (err, r) => resolve(err ? 'silence' : r)); });

test('every socket event survives every argument shape, from every kind of socket', { timeout: 180_000 }, async (t) => {
  const srv = await startServer();
  const { base } = srv;
  const sockets = [];
  t.after(async () => { sockets.forEach((s) => s.close()); await stopServer(srv.child); });
  assert.ok(EVENTS.length > 50, 'the events were read from server.js: ' + EVENTS.length);

  const admin = (await api(base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
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
  const health = await api(base, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(!/\[error\]/.test(srv.out()), 'nothing reached the uncaught-exception path:\n' + srv.out().split('\n').filter((l) => /\[error\]/.test(l)).slice(0, 5).join('\n'));
});
