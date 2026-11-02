'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): this laptop's network adapters are the ones the test names.
// AGM_TEST_LAN is a comma-separated list of IPv4 addresses ('' for none: a laptop the network has given no address yet,
// as at a start before the Wi-Fi joins), each on an adapter of its own, beside the loopback, which is always there.
// AGM_TEST_LAN_FILE names a file that holds such a list instead, read at each look, so a test can give the laptop an
// address while it serves; a file that says `throw` is an adapter list the system refuses (ENOMEM), as os's own does.
const fs = require('fs');
const os = require('os');

const lan = process.env.AGM_TEST_LAN;
const file = process.env.AGM_TEST_LAN_FILE;
if (typeof lan === 'string' || file) {
  const loopback = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' };
  os.networkInterfaces = () => {
    const list = file ? fs.readFileSync(file, 'utf8').trim() : lan;
    if (list === 'throw') throw Object.assign(new Error('uv_interface_addresses returned Unknown system error 12'), { code: 'ENOMEM' });
    const out = { lo: [loopback] };
    list.split(',').filter(Boolean).forEach((address, i) => {
      out['eth' + i] = [{ address, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:0' + i, internal: false, cidr: address + '/24' }];
    });
    return out;
  };
}
