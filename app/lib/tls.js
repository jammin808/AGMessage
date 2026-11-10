'use strict';
/**
 * Encrypted connections (Show Bus 1.2 §10), with no new dependency.
 *
 *  - The certificate: Node can make keys and signatures but not X.509 certificates, so this file writes the few DER
 *    structures a self-signed server certificate needs (ECDSA P-256 / SHA-256, SANs, key usage) and signs them with
 *    node:crypto. Node's own X509Certificate parses and verifies the result (tested), so a mistake here can't pass
 *    quietly. The alternative — PowerShell's New-SelfSignedCertificate — drops the key into the Windows certificate
 *    store as a side effect, takes seconds and needs Windows; this works everywhere and is instant.
 *  - Kept beside the machine key, outside the app folder (%LOCALAPPDATA%\AGMessage\tls.json), private key sealed by
 *    lib/secretbox.js: a copied AGMessage folder carries no certificate, so a copy on another laptop makes its own. Made
 *    only where there is none: a file that cannot be read, or whose key does not open, turns HTTPS off and is kept.
 *  - Validity: 825 days, not the five years the contract suggests — Apple devices refuse TLS server certificates
 *    valid for longer, even ones the user has chosen to trust, and an iPad on the board's table is the usual browser
 *    here. It is renewed automatically 30 days before it ends (a new fingerprint: pinned peers see CERTIFICATE CHANGED
 *    and the admin accepts it once).
 *  - One port: a connection whose first byte is a TLS handshake (0x16) is TLS; anything else is plain HTTP. Same
 *    Express app, same Socket.io, same port — links and bookmarks keep working.
 *  - App-to-app: pinned, not trusted by name (PinStore — pure). A client fetches the server's certificate, compares its
 *    fingerprint with the pin (or the hello's, before there is one) and only then sends anything, trusting exactly
 *    that certificate for the request.
 */
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { publishOnce, readText, writeFileAtomic } = require('./resilience');

// ---------------------------------------------------------------- DER, the bits a certificate needs

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const ctx = (n, body) => tlv(0xa0 + n, body);                    // [n] EXPLICIT, constructed
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { b.unshift(0x80 | (x & 0x7f)); x = Math.floor(x / 128); }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(p(y % 100) + body)) : tlv(0x18, Buffer.from(p(y, 4) + body));
}
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));
const isIPv4 = (s) => net.isIPv4(s);

/**
 * A self-signed server certificate (pure apart from the random key and serial).
 * @returns {{certDer: Buffer, keyPem: string}}
 */
function makeCertificate({ name, hosts = [], ips = [], days = 825, now = new Date() }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));                                 // ecdsa-with-SHA256
  const cn = String(name || 'AGMessage').slice(0, 64);
  const dn = seq(set(seq(oid('2.5.4.3'), utf8(cn))));
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const from = new Date(now.getTime() - 60 * 60 * 1000);                          // an hour of slack for skewed clocks
  const to = new Date(now.getTime() + days * 86400 * 1000);
  const names = [];
  for (const h of new Set(hosts.filter(Boolean).map((x) => String(x).toLowerCase().slice(0, 253)))) if (!isIPv4(h)) names.push(tlv(0x82, Buffer.from(h, 'ascii')));
  for (const ip of new Set(ips.filter(isIPv4))) names.push(tlv(0x87, ipBytes(ip)));
  const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
  const extensions = ctx(3, seq(
    ext('2.5.29.19', true, seq()),                                                 // basicConstraints: not a CA
    ext('2.5.29.15', true, bits(Buffer.from([0x80]))),                             // keyUsage: digitalSignature
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),                        // extKeyUsage: serverAuth
    ext('2.5.29.17', false, seq(...names)),                                        // subjectAltName
  ));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), sigAlg, dn, seq(time(from), time(to)), dn, spki, extensions);
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  return { certDer: seq(tbs, sigAlg, bits(sig)), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** "sha256:<64 hex>" — the certificate's identity on the show network. */
const fingerprint = (der) => 'sha256:' + crypto.createHash('sha256').update(der).digest('hex');
const toPem = (der) => '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
const FP_RE = /^sha256:[0-9a-f]{64}$/;
/** A fingerprint as typed (colons, upper case, with or without "sha256:") → canonical, or '' when it isn't one. */
function cleanFingerprint(s) {
  const hex = String(s || '').trim().toLowerCase().replace(/^sha256:/, '').replace(/[:\s]/g, '');
  return /^[0-9a-f]{64}$/.test(hex) ? 'sha256:' + hex : '';
}
// The fewest characters of a fingerprint that confirm a certificate: 16 hex characters, 64 bits. A fingerprint is public
// (every hello carries it), so its start must be too long to match with a certificate made for the purpose.
const TYPED_MIN = 16;
/** The start of a fingerprint as a person typed it from a node's own screen: TYPED_MIN to 64 hex characters, else '' (pure). */
function typedFingerprint(s) {
  const hex = String(s || '').trim().toLowerCase().replace(/^sha256:/, '').replace(/[:\s]/g, '');
  return hex.length >= TYPED_MIN && /^[0-9a-f]{1,64}$/.test(hex) ? hex : '';
}
/** Whether what a person typed (at least TYPED_MIN hex characters) is the start of this certificate's fingerprint (pure). */
function fingerprintStarts(fp, typed) {
  const t = typedFingerprint(typed);
  const full = cleanFingerprint(fp);
  return !!t && !!full && full.slice('sha256:'.length).startsWith(t);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}

const RENEW_MS = 30 * 86400 * 1000;   // a certificate is renewed when it has this long or less to run

/**
 * The addresses a network gave this laptop: `addresses` (lanAddresses()'s) without the link-local ones (169.254/16),
 * which an adapter gives itself while no network has answered it, as at a start before the Wi-Fi joins (pure).
 */
function networkAddresses(addresses) {
  return (Array.isArray(addresses) ? addresses : []).filter((a) => typeof a === 'string' && !/^169\.254\./.test(a));
}

/**
 * Whether a certificate due for renewal at start (`found.state` 'renew', its key opening) is left as it is: while no
 * network has given this laptop an address (`addresses`, lanAddresses()'s, by networkAddresses), one made now would name
 * none of the addresses devices reach it by, for every day it runs. The one it has serves on meanwhile (pure).
 */
function renewalWaits(found, addresses) {
  return !!found && found.state === 'renew' && networkAddresses(addresses).length === 0;
}

/**
 * This install's certificate as `<dir>/tls.json` holds it, read and never written: {state, file, cert?, code?, words?}.
 *  - 'ok': its certificate, whose private key opens with this machine's key and is the certificate's, with more than 30
 *    days to run;
 *  - 'renew': the same, with 30 days or fewer (or past its end): renewed over the old one, whose key opened;
 *  - 'absent': no file (ENOENT, and only that): one is made;
 *  - 'unusable': any other read error, a file that holds no certificate AGMessage wrote, or a private key that does not
 *    open or is not the certificate's. HTTPS is off, and the file is left as it is: never a new certificate over it.
 */
function readCertificate({ dir, open, now = new Date() }) {
  const file = path.join(dir, 'tls.json');
  const r = readText(file);
  if (r.code === 'ENOENT') return { state: 'absent', file };
  if (r.code) return { state: 'unusable', file, code: r.code, words: file + ' could not be read (' + r.code + ')' };
  let sealed, der, x;
  try {
    const j = JSON.parse(r.text);
    sealed = j.keySealed;
    der = Buffer.from(j.certDer, 'base64');
    x = new crypto.X509Certificate(der);
  } catch { return { state: 'unusable', file, code: 'EBADCERT', words: file + ' holds no certificate AGMessage wrote' }; }
  const keyPem = open(sealed);
  if (!keyPem) return { state: 'unusable', file, code: 'ESEALED', words: 'the private key in ' + file + ' does not open with this laptop\'s machine key' };
  let mine = false;
  try { mine = x.checkPrivateKey(crypto.createPrivateKey(keyPem)); } catch { /* not a private key: it is not the certificate's */ }
  if (!mine) return { state: 'unusable', file, code: 'EBADCERT', words: 'the private key in ' + file + ' is not its certificate\'s' };
  const cert = { der, certPem: toPem(der), keyPem, fp: fingerprint(der), validTo: x.validTo, created: false };
  return { state: new Date(x.validTo).getTime() - now.getTime() > RENEW_MS ? 'ok' : 'renew', file, cert };
}

/** A certificate made now for this install, its private key sealed (`seal` throws when this run has no machine key). */
function freshCertificate({ name, seal, now }) {
  const { certDer, keyPem } = makeCertificate({ name, hosts: [os.hostname(), 'localhost'], ips: ['127.0.0.1', ...lanAddresses()], now });
  const text = JSON.stringify({ v: 1, certDer: certDer.toString('base64'), keySealed: seal(keyPem), created: now.toISOString() });
  const x = new crypto.X509Certificate(certDer);
  return { text, cert: { der: certDer, certPem: toPem(certDer), keyPem, fp: fingerprint(certDer), validTo: x.validTo, created: true } };
}

/**
 * This install's certificate: read; made when there is none (published whole, never over a file another start made at
 * the same moment: that one is taken); renewed 30 days before it ends, or when asked (`renew`), over the old one only
 * because its key opened. A file that could not be read, holds no certificate, or whose key does not open throws with
 * the words of why, and is left as it is.
 * @param {{dir:string, name:string, seal:(s:string)=>string, open:(s:string)=>string, now?:Date, renew?:boolean}} o
 */
function loadOrCreate({ dir, name, seal, open, now = new Date(), renew = false }) {
  const found = readCertificate({ dir, open, now });
  if (found.state === 'unusable') throw Object.assign(new Error(found.words), { code: found.code });
  if (found.state === 'ok' && !renew) return found.cert;
  const made = freshCertificate({ name, seal, now });
  if (found.state !== 'absent') {
    writeFileAtomic(found.file, made.text, { mode: 0o600 });
    return made.cert;
  }
  if (publishOnce(found.file, made.text, { mode: 0o600 })) return made.cert;
  const other = readCertificate({ dir, open, now });
  if (other.cert) return other.cert;
  throw Object.assign(new Error(other.words || found.file + ' was made by another start and is gone again'), { code: other.code || 'ENOENT' });
}

/**
 * One listening port for HTTP and HTTPS: the first byte decides. Both end up in the same http.Server (and so the same
 * Express app and Socket.io); an HTTPS request's socket is a TLSSocket (req.socket.encrypted). `keys` ({certPem, keyPem})
 * may be null, and given later with `front.setCert`.
 */
function dualPortServer(httpServer, keys) {
  const tlsServer = tls.createServer({ ...(keys ? { cert: keys.certPem, key: keys.keyPem } : {}), minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }, (s) => httpServer.emit('connection', s));
  tlsServer.on('tlsClientError', () => { /* a browser that refused the certificate: nothing to log */ });
  // Started without a certificate (one is made once the server holds its folder), a TLS handshake is ended until it has one.
  let hasCert = !!keys;
  const front = net.createServer((socket) => {
    socket.setTimeout(15_000, () => socket.destroy());                             // a connection that never speaks
    socket.on('error', () => { /* reset by peer */ });
    socket.once('data', (buf) => {
      socket.setTimeout(0);
      if (buf[0] === 0x16 && !hasCert) { socket.destroy(); return; }
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? tlsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  front.setCert = ({ certPem: c, keyPem: k }) => { tlsServer.setSecureContext({ cert: c, key: k, minVersion: 'TLSv1.2' }); hasCert = true; };
  return front;
}

// ---------------------------------------------------------------- pins (pure)

/**
 * Trust on first use, by node: the fingerprint a peer presents is checked against its pin, or — before there is one —
 * against what its hello (or the operator) said. A pin is set after the first authenticated success (confirm), or when
 * a person vouches for the certificate presented (accept); a link decides which of the two it may use.
 */
class PinStore {
  /** @param {Object<string,string>} pins node key -> fingerprint (persisted by the caller) */
  constructor(pins = {}) { this.pins = { ...pins }; }

  /** May we talk to this peer? {ok, reason?, changed?} — call before sending anything. */
  check(nodeKey, presented, expected = '') {
    const fp = cleanFingerprint(presented);
    if (!fp) return { ok: false, reason: 'no certificate fingerprint' };
    const pinned = this.pins[nodeKey];
    if (pinned) return pinned === fp ? { ok: true } : { ok: false, changed: true, reason: 'CERTIFICATE CHANGED — the peer now presents ' + fp.slice(0, 23) + '…; the admin must accept it' };
    const exp = cleanFingerprint(expected);
    if (exp && exp !== fp) return { ok: false, reason: 'the certificate does not match the fingerprint it announced (' + exp.slice(0, 23) + '…)' };
    return { ok: true, firstUse: true };
  }

  /** The first authenticated success: pin what was presented (never replaces an existing pin). True when it pinned. */
  confirm(nodeKey, presented) {
    const fp = cleanFingerprint(presented);
    if (!fp || this.pins[nodeKey]) return false;
    this.pins[nodeKey] = fp;
    return true;
  }

  /** The admin accepts a changed certificate. */
  accept(nodeKey, presented) {
    const fp = cleanFingerprint(presented);
    if (!fp) return false;
    this.pins[nodeKey] = fp;
    return true;
  }

  forget(nodeKey) { delete this.pins[nodeKey]; }
  toJSON() { return { ...this.pins }; }
}

// ---------------------------------------------------------------- a pinned client

/** The certificate a TLS server presents (nothing else is sent). */
function probeCertificate(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    // The probe reads the certificate to compare it with the pin; it sends nothing, so an unverified certificate is all it can be.
    // eslint-disable-next-line no-restricted-syntax -- the pin is the trust, checked by the caller before any request
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const c = s.getPeerX509Certificate ? s.getPeerX509Certificate() : null;
      s.destroy();
      if (!c) return reject(new Error('no certificate'));
      resolve({ der: c.raw, pem: toPem(c.raw), fp: fingerprint(c.raw) });
    });
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error('timed out')); });
    s.on('error', reject);
  });
}

/** TLS options that trust exactly this certificate, whatever host name the URL used. */
function pinnedTlsOptions(certPem, fp) {
  return {
    ca: certPem,
    checkServerIdentity: (_host, cert) => (cert && fingerprint(cert.raw) === fp ? undefined : new Error('CERTIFICATE CHANGED')),
  };
}

/**
 * fetch-like request over http or (pinned) https. Resolves {status, body, text, headers, retryAfter} (body parsed as JSON
 * when it is JSON; retryAfter the whole seconds of a Retry-After header, else null).
 * @param {string} url
 * `signal` (an AbortSignal) cuts it: one cut before its connection is made, or its TLS handshake done, writes nothing.
 * @param {{method?:string, headers?:object, body?:string, timeoutMs?:number, tls?:object, signal?:AbortSignal}} o
 */
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 4000, tls: tlsOpts, signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      ...(u.protocol === 'https:' ? { ...(tlsOpts || {}), agent: false } : {}),
      ...(signal ? { signal } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 1024 * 1024) req.destroy(new Error('reply too large')); else chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        const after = String(res.headers['retry-after'] || '');
        resolve({ status: res.statusCode, body: parsed, text, headers: res.headers, retryAfter: /^\d{1,5}$/.test(after) ? Number(after) : null });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Require HTTPS (pure): plain HTTP is refused unless it comes from this machine (the host laptop, and the Cloudflare
 * tunnel, which connects locally). A browser asking for a page is sent to the same address over HTTPS.
 * @returns {{allow:true}|{redirect:string}|{refuse:string}}
 */
function httpsGate({ required, on, encrypted, loopback, method = 'GET', path = '/', host = '' }) {
  if (!required || !on || encrypted || loopback) return { allow: true };
  const h = String(host || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && !path.startsWith('/socket.io') && h) return { redirect: 'https://' + h + path };
  return { refuse: 'This AGMessage requires HTTPS — use https:// (see /tls to trust its certificate).' };
}

module.exports = { httpsGate, makeCertificate, fingerprint, cleanFingerprint, typedFingerprint, fingerprintStarts, TYPED_MIN, toPem, readCertificate, loadOrCreate, renewalWaits, networkAddresses, dualPortServer, PinStore, probeCertificate, pinnedTlsOptions, request, FP_RE, lanAddresses };
