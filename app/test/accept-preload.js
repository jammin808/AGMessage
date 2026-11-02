'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): the message {t: 'test:acceptError'} over its IPC channel
// makes each port it listens on meet the error Node gives when it cannot take a connection. That is net.Server's own
// path (its onconnection emits 'error' with the accept's code, EMFILE when the process is out of file handles), raised
// here because a test cannot run a server out of handles on every platform. With `close: true` the port stops listening
// first, as a listener whose handle has gone. Nothing else of the server is changed.
const net = require('net');

const ports = [];
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenAndKeep(...args) {
  // A port is a number, or an object that names one; a path (the data folder's hold) is not a port.
  const first = args[0];
  if (typeof first === 'number' || (first && typeof first === 'object' && 'port' in first)) ports.push(this);
  return listen.apply(this, args);
};

process.on('message', (m) => {
  if (!m || m.t !== 'test:acceptError') return;
  for (const port of ports) {
    if (m.close) port.close();
    port.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', errno: -24, syscall: 'accept' }));
  }
});
