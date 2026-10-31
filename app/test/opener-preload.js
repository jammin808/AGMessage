'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): the browser opener plans as it does on Windows, and what it
// would start (explorer.exe and its arguments) is written to the file AGM_TEST_OPENED names, one JSON line per start,
// instead of being run. Each line also says whether the server answered on its port at that moment, so a test reads when
// the opener ran and with what. Every other spawn is the real one.
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const startup = require('../lib/startup');

const file = process.env.AGM_TEST_OPENED;
if (file) {
  const plan = startup.openerPlan;
  startup.openerPlan = (env, facts) => plan(env, { ...facts, platform: 'win32' });
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (!/explorer\.exe$/i.test(String(command))) return spawn(command, args, options);
    const probe = net.connect(Number(process.env.PORT), '127.0.0.1');
    const note = (serving) => { probe.destroy(); fs.appendFileSync(file, JSON.stringify({ command, args, options, serving }) + '\n'); };
    probe.once('connect', () => note(true));
    probe.once('error', () => note(false));
    const child = new EventEmitter();
    child.unref = () => { child.unrefd = true; };
    return child;
  };
}
