'use strict';
/**
 * This PC's own requests to its AGMessage at loopback: the machine asks how busy the server is, stops it, and tells it to
 * read the machine's events, each request carrying a proof of the laptop's token, never the token. Both halves are here:
 * the server's (its nonces and its judge of a request) and the machine's (the hello it checks before it sends anything,
 * then its request).
 *
 *   GET  /api/machine/hello?c=<challenge>
 *                             answers a fresh nonce, the build, and the server's proof that it holds the token:
 *                             HMAC-SHA256 under the token over HELLO_SAYS + nonce, and the machine's own challenge on a
 *                             line of its own (`serverProof`), so a hello another program read earlier proves nothing to
 *                             the machine that asks now
 *   GET  /api/machine/busy    the busy line (lib/busy.js)
 *   POST /api/machine/stop    {reason, by, force}: the stop, which saves; a busy server only with a typed reason (`force`)
 *   POST /api/machine/events  no body: the machine's events are to be read
 *     Each of the last three carries the nonce (NONCE_HEADER) and the machine's proof (PROOF_HEADER): HMAC-SHA256 under
 *     the token over ASK_SAYS, the nonce, the method, the path and the body's SHA-256, a line each (`askProof`). The two
 *     proofs begin with different words, so neither can stand for the other.
 *
 * The server answers only on this PC (guard.isHostMachine), never a browser's request (`fromBrowser`: the machine sends
 * no Origin and no Sec-Fetch-* header, which a browser sends to loopback, so a page open on this PC can neither flood the
 * nonces nor ask anything), only while its token is long enough that a hello is no oracle for guessing it (`weakToken`:
 * a hello is an HMAC under the token over words its asker knows, so a short token could be tried offline outside the
 * lockout), only for a nonce it issued within NONCE_MS and not yet used, and only for a proof that compares in constant
 * time (`judge`); a wrong proof counts toward the token's lockout. The machine asks for a hello and checks the server's
 * proof before it sends anything else (`ask`): a program that took the port during a restart is asked nothing, learns
 * nothing, and stops nothing. The token never crosses the socket. A nonce the server let go before it was used (more
 * hellos than it holds came between) is asked for again once (`again`).
 *
 * A server that does not answer within ANSWER_MS reads as busy (`busy`): a stop is then refused without a typed reason.
 * The time is the whole answer's, from the request to its last byte, never the gap between two bytes, so a program that
 * answers a byte at a time is silent at ANSWER_MS too.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const busyLine = require('./busy');
const { cleanText } = require('./guard');

const HELLO_SAYS = 'agmessage machine server\n';
const ASK_SAYS = 'agmessage machine\n';
/** How long a nonce is good for, from its hello: one request, within this. */
const NONCE_MS = 30_000;
/** The most nonces held at once, the oldest let go first: a hello is unauthenticated, and a flood of them holds no more. */
const NONCES_MAX = 256;
/** How long the machine waits for each whole answer: a server that has not answered all of it by then reads as busy. */
const ANSWER_MS = 5000;
/**
 * The shortest token the machine's requests are answered for: the watchdog's is 16 hex characters (64 random bits); one
 * a person chose (ADMIN_TOKEN) shorter than this is refused here, with why.
 */
const TOKEN_MIN = 16;
/** The most of an answer the machine reads, and the most of a request's body the server takes. */
const ANSWER_MAX = 64 * 1024;
const BODY_MAX = 4096;
const NONCE_HEADER = 'x-agm-nonce';
const PROOF_HEADER = 'x-agm-proof';
/** A nonce's shape, and a challenge's: 16 random bytes in hex. */
const NONCE = /^[0-9a-f]{32}$/;
const PROOF = /^[0-9a-f]{64}$/;
/** Why the machine stops its server: the act it was asked for, and its words. Any other word is refused. */
const STOP_WORDS = Object.freeze({ stop: 'a stop', upgrade: 'an upgrade', back: 'a go back to the build before' });
const STOP_REASONS = Object.freeze(Object.keys(STOP_WORDS));
const PATHS = Object.freeze({ hello: '/api/machine/hello', busy: '/api/machine/busy', stop: '/api/machine/stop', events: '/api/machine/events' });

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const mac = (token, text) => crypto.createHmac('sha256', String(token)).update(text).digest('hex');
/** The token as the server holds it (lower case) from where the machine read it (a file, its line's end trimmed). */
const tokenOf = (token) => String(token).toLowerCase().trim();
/** Why this server's token is too short for the machine's requests ('' when it is not): words for whoever asked. */
const weakToken = (token) => (typeof token === 'string' && token.length >= TOKEN_MIN ? ''
  : 'This AGMessage\'s admin token is shorter than ' + TOKEN_MIN + ' characters, so this PC\'s machine is not answered: a program on this PC could test guesses at it from a hello. Start it without ADMIN_TOKEN, or with one of ' + TOKEN_MIN + ' or more random letters and digits.');
/** Whether a request's headers are a browser's: an Origin or a Sec-Fetch-* header, neither of which the machine sends. */
const fromBrowser = (headers) => !!headers && ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].some((k) => headers[k] !== undefined);
/** The server's proof that it holds `token`, over its own nonce and the machine's challenge. */
const serverProof = (token, nonce, challenge) => mac(token, HELLO_SAYS + nonce + '\n' + challenge);
/** The machine's proof of `token` for one request: its nonce, method, path (as sent, query included) and body. */
const askProof = (token, { nonce, method, path, body }) => mac(token, ASK_SAYS + nonce + '\n' + method + '\n' + path + '\n' + sha256(body || Buffer.alloc(0)));
/** Two proofs alike, compared in constant time; anything not of a proof's shape is never alike. */
function sameProof(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !PROOF.test(a) || !PROOF.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * The nonces a server issued, each good for one request within `ttlMs` of its hello; at most `max` held, the oldest let
 * go first (the clock passed in).
 */
class Nonces {
  constructor({ ttlMs = NONCE_MS, max = NONCES_MAX } = {}) { this.ttlMs = ttlMs; this.max = max; this.issued = new Map(); }
  issue(now) {
    for (const [n, t] of this.issued) { if (now - t < this.ttlMs && this.issued.size < this.max) break; this.issued.delete(n); }
    const nonce = crypto.randomBytes(16).toString('hex');
    this.issued.set(nonce, now);
    return nonce;
  }
  /** Whether `nonce` was issued within the time and not yet used: it is used now, whatever the answer. */
  take(nonce, now) {
    const t = this.issued.get(nonce);
    if (t === undefined) return false;
    this.issued.delete(nonce);
    return now - t < this.ttlMs;
  }
}

/**
 * The server's judge of a request that claims the machine's proof: {ok: true}, or {status, error, wrong, again}. A
 * request with no nonce or no proof is refused; a nonce not issued, used, or older than its time is refused before the
 * proof is read, `again` (a fresh hello answers it); a proof that does not match is `wrong`, which the token's lockout
 * counts. The nonce is used by any request that names it, so each nonce stands for one guess at most.
 */
function judge({ token, nonces, nonce, proof, method, path, body, now }) {
  if (typeof nonce !== 'string' || !nonce || typeof proof !== 'string' || !proof) {
    return { status: 401, error: 'No proof of this PC\'s token: ask ' + PATHS.hello + ' first.', wrong: false, again: false };
  }
  if (!NONCE.test(nonce) || !nonces.take(nonce, now)) {
    return { status: 401, error: 'That nonce is not one this server issued in the last ' + NONCE_MS / 1000 + ' s, or it was used: ask ' + PATHS.hello + ' again.', wrong: false, again: true };
  }
  if (!sameProof(proof, askProof(token, { nonce, method, path, body }))) return { status: 401, error: 'That is not a proof of this PC\'s token.', wrong: true, again: false };
  return { ok: true };
}

/**
 * The stop's body as the server reads it (its bytes, the proof already checked over them): {reason, by, force}, or
 * {error}. Whole JSON, an object of these three keys at most: `reason` one of STOP_REASONS, `by` who asked (words,
 * required), `force` the reason a person typed to stop a busy server (words, '' when none). An unknown key or word is
 * refused, never defaulted.
 */
function readStop(bytes) {
  let b;
  try { b = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : ''); } catch { b = null; /* not JSON: refused below */ }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'The stop is JSON: {reason, by, force}.' };
  const extra = Object.keys(b).find((k) => !['reason', 'by', 'force'].includes(k));
  if (extra !== undefined) return { error: 'The stop takes reason, by and force; "' + cleanText(extra, 40) + '" is not one of them.' };
  if (!STOP_REASONS.includes(b.reason)) return { error: 'The stop\'s reason is one of ' + STOP_REASONS.join(', ') + '.' };
  const by = typeof b.by === 'string' ? cleanText(b.by, 80) : '';
  if (!by) return { error: 'The stop names who asked it (by).' };
  if (b.force !== undefined && typeof b.force !== 'string') return { error: 'force is the reason a person typed, in words.' };
  return { reason: b.reason, by, force: cleanText(b.force || '', 200) };
}

// ---------------------------------------------------------------- the machine's half

/**
 * One request to 127.0.0.1:`port`: {status, json} (json null when the answer is not JSON), or {error}: 'silent' when the
 * whole answer had not come within `timeoutMs` of asking (however it came: nothing, or a byte at a time), else the
 * connection's code (ECONNREFUSED: nothing listens).
 */
function request({ port, method = 'GET', path, headers = {}, body = Buffer.alloc(0), timeoutMs = ANSWER_MS }) {
  return new Promise((resolve) => {
    let done = false;
    let deadline = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(deadline); resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { ...headers, 'content-length': body.length } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > ANSWER_MAX) { req.destroy(new Error('an answer larger than ' + ANSWER_MAX + ' bytes')); return; } chunks.push(c); });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; /* not JSON: its status still says what it answered */ }
        finish({ status: res.statusCode, json });
      });
      res.on('error', (e) => finish({ error: e.code || e.message }));
    });
    deadline = setTimeout(() => { finish({ error: 'silent' }); req.destroy(); }, timeoutMs);
    req.on('error', (e) => finish({ error: e.code || e.message }));
    req.end(body);
  });
}

/** Why the machine asked nothing more, in words, from a hello or request that failed. */
function failWords(why, port, timeoutMs) {
  if (why === 'silent') return 'AGMessage on port ' + port + ' did not answer within ' + timeoutMs / 1000 + ' s';
  if (why === 'ECONNREFUSED') return 'nothing answers on port ' + port;
  if (why === 'unproven') return 'the program on port ' + port + ' did not prove it holds this PC\'s AGMessage token, so nothing was asked of it';
  return 'port ' + port + ' could not be reached (' + String(why).slice(0, 40) + ')';
}

/**
 * The hello, checked: {ok: true, nonce, build} only when the answer carries a nonce of its shape and the server's proof
 * under `token` (as the server holds it, `tokenOf`) over it and the challenge made for this hello; else {ok: false, why
 * ('silent', 'unproven', a connection's code), words}. Nothing but the hello's GET is sent, and it carries nothing but
 * that challenge. What a program that does not prove itself answers is never read for words.
 */
async function hello({ port, token, timeoutMs = ANSWER_MS }) {
  const challenge = crypto.randomBytes(16).toString('hex');
  const r = await request({ port, path: PATHS.hello + '?c=' + challenge, timeoutMs });
  if (r.error) return { ok: false, why: r.error, words: failWords(r.error, port, timeoutMs) };
  const j = r.json;
  if (r.status !== 200 || !j || typeof j.nonce !== 'string' || !NONCE.test(j.nonce) || !sameProof(j.proof, serverProof(tokenOf(token), j.nonce, challenge))) {
    return { ok: false, why: 'unproven', words: failWords('unproven', port, timeoutMs) };
  }
  return { ok: true, nonce: j.nonce, build: typeof j.build === 'string' ? j.build.slice(0, 80) : '' };
}

/**
 * One request with the machine's proof, sent only after the hello proved the server holds `token`: {ok: true, status,
 * json, build}, or the hello's {ok: false, why, words} (nothing else sent), or {ok: false, why, words} for a request
 * that got no answer. A proven server's answer that its nonce was let go before it was used (`again`) is asked once more
 * from a fresh hello, never twice: a wrong proof is never asked again.
 */
async function ask({ port, token, method, path, body, timeoutMs = ANSWER_MS }) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  let answer = null;
  for (let tries = 0; tries < 2; tries++) {
    const h = await hello({ port, token, timeoutMs });
    if (!h.ok) return h;
    const headers = { [NONCE_HEADER]: h.nonce, [PROOF_HEADER]: askProof(tokenOf(token), { nonce: h.nonce, method, path, body: bytes }) };
    if (bytes.length) headers['content-type'] = 'application/json';
    const r = await request({ port, method, path, headers, body: bytes, timeoutMs });
    if (r.error) return { ok: false, why: r.error, words: failWords(r.error, port, timeoutMs) };
    answer = { ok: true, status: r.status, json: r.json, build: h.build };
    if (!(r.status === 401 && r.json && r.json.again === true)) break;
  }
  return answer;
}

/**
 * How busy the server on `port` is: {answered, running, busy, line, words}. The line it answered is read by type
 * (lib/busy.js read), and busy is judged from that line here, never taken from its word. Nothing listening is not busy
 * (`running` false); a server silent within the time, one that did not prove it holds the token, or an answer that is no
 * line reads as busy, with why.
 */
async function busy({ port, token, timeoutMs = ANSWER_MS }) {
  const r = await ask({ port, token, method: 'GET', path: PATHS.busy, timeoutMs });
  if (!r.ok && r.why === 'ECONNREFUSED') return { answered: false, running: false, busy: false, line: null, words: r.words };
  if (!r.ok) return { answered: false, running: true, busy: true, line: null, words: r.words + ': read as busy' };
  const line = r.status === 200 && r.json ? busyLine.read(JSON.stringify(r.json.line)) : null;
  if (!line) return { answered: false, running: true, busy: true, line: null, words: 'AGMessage on port ' + port + ' answered no busy line (' + r.status + '): read as busy' };
  return { answered: true, running: true, busy: busyLine.isBusy(line), line, words: busyLine.words(line) };
}

/**
 * The stop, asked of the server on `port`: {ok, status, json} as `ask` gives it. `reason` one of STOP_REASONS; `by` who
 * asked; `force` the reason a person typed to stop a busy server ('' when none).
 */
function stop({ port, token, reason, by, force = '', timeoutMs = ANSWER_MS }) {
  return ask({ port, token, method: 'POST', path: PATHS.stop, body: { reason, by, force }, timeoutMs });
}

/** The machine's events, to be read: the nudge, with nothing in it. */
function nudge({ port, token, timeoutMs = ANSWER_MS }) {
  return ask({ port, token, method: 'POST', path: PATHS.events, timeoutMs });
}

/**
 * What answers on a local socket (the data folder's pipe): {connected, text}, `text` its first line, at most 1 KB, read
 * within `ms` of asking, all of it ('' when it says no whole line in that time, or ends without one; what came by then
 * is kept, and a holder that answers a byte at a time is let go at `ms`).
 */
function askPipe(where, { ms = 1000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let connected = false;
    let text = '';
    let done = false;
    let deadline = null;
    const s = connect(where);
    const finish = () => { if (!done) { done = true; clearTimeout(deadline); s.destroy(); resolve({ connected, text: text.split('\n')[0].slice(0, 1024) }); } };
    deadline = setTimeout(finish, ms);
    s.on('connect', () => { connected = true; });
    s.on('data', (c) => { text += c.toString('utf8'); if (text.includes('\n') || text.length > 1024) finish(); });
    s.on('end', finish);
    s.on('close', finish);
    s.on('error', finish);
  });
}

module.exports = {
  HELLO_SAYS, ASK_SAYS, NONCE_MS, NONCES_MAX, ANSWER_MS, TOKEN_MIN, BODY_MAX, NONCE_HEADER, PROOF_HEADER, NONCE, STOP_REASONS, STOP_WORDS, PATHS,
  serverProof, askProof, sameProof, tokenOf, weakToken, fromBrowser, Nonces, judge, readStop, request, hello, ask, busy, stop, nudge, askPipe,
};
