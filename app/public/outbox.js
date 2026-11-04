// The outbox (AGM.outbox): every write a page makes goes through it, in the mode of what the person does, so a send is
// never lost to a dropped connection and never made twice.
//
//   hold   what a person wrote or answered: a message of any kind, a forward, an answer to a prompt, an answer to a help
//          request. Each send gets a client id (`cid`). It is held while the page is not connected and joined, sent
//          after the join's answer, one at a time in the order written, and sent again with the same cid after a drop
//          until the server answers it; the server answers a repeat with what the first send became, so it lands once.
//          It has no time limit, and carries `heldMs`: of the time since it was written, this page's own count of what
//          it spent not connected and joined (a reload included; at most 24 h), so a send that only queued behind
//          another or behind the rate is not marked as written offline. Held sends are kept in the tab's sessionStorage
//          under the hall and the person, so a reload keeps them, and one the page already has (drawn in the history)
//          is not sent again; another person's are dropped, never sent as them, and `clear()` (sent out of the hall)
//          drops them all. A file's bytes are held in memory only: one not yet uploaded is "choose the file again"
//          after a reload, and one uploaded goes with its cid; it is uploaded once more when the server no longer has
//          it or its upload token was renewed.
//   now    what a person does to something: pin, react, delete, a screen's take, the stage, the admin's acts. Refused at
//          once while the page is not connected and joined, so a click is never sent late; an answer not back in 5 s is
//          "No answer", and the server's own answer, when it comes after that, is given too, once, marked `late`; after
//          a drop it is sent again with its cid only where the server answers a repeat (REPEATS), and otherwise the
//          person is told to check.
//   self   what a person does on their own page: the page acts at once; its report is queued, the newest per key, and
//          sent once the page is connected and joined.
//   local  nothing on the wire.
//
// It touches no DOM: what it holds is drawn by the page, told of each change through `onChange`.
(function () {
  'use strict';
  const HELD_MAX_MS = 86400000;
  const ACK_MS = 5000;
  const BUSY_MS = 1000;
  const PREFIX = 'agm.outbox|';
  const WORDS = {
    offline: 'Not connected — AGMessage is reconnecting.',
    noAnswer: 'No answer — check the connection.',
    dropped: 'The connection dropped before AGMessage answered — check it was done before trying again.',
    refused: 'Not sent.',
    left: 'Not sent: this page has left the hall.',
    lost: 'Not sent — choose the file again',
  };
  // The `now` verbs the server answers a repeat of with what the first one did: a pin carries its state, a reaction with
  // `on` sets one, a second delete answers `already`, a room made is answered with that room by its cid, a send withdrawn
  // already answers `already`. Any other is never sent twice.
  const REPEATS = new Set(['pin', 'react', 'delete', 'room:create', 'room:withdraw']);
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** 16 random bytes as base64url, 22 characters, from getRandomValues: randomUUID exists only in a secure context. */
  function makeCid(crypto) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    let out = '';
    for (let i = 0; i < 15; i += 3) {
      const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
    }
    return out + B64URL[b[15] >> 2] + B64URL[(b[15] & 3) << 4];
  }

  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const FINAL = new Set(['done', 'gone', 'dropped']);

  /**
   * An outbox. `env`: `crypto` (getRandomValues), `storage()` (sessionStorage, or a throw where it is blocked), `now()`
   * (a monotonic count in ms), `wall()` (the clock, for the time a reload took), `setTimeout`, `clearTimeout`.
   */
  function create(env) {
    let socket = null;
    let onChange = () => {};
    let joined = false;
    let closed = false;
    let key = '';                 // PREFIX + scope + '|' + who, once the page has joined
    const restored = new Set();   // the keys already read back from storage on this page
    const queue = [];             // held sends, in the order written
    let inflight = null;          // the one held send waiting for its answer
    let pumpTimer = null;
    const nows = new Set();       // `now` acts waiting for their answer
    const selves = new Map();     // `self` reports not yet sent, the newest per key
    // The time this page has spent not connected and joined: the spells before, and the one it is in (since `offSince`,
    // null while it is connected and joined). A page starts not joined; its count starts the first time it is read, as
    // nothing before that is anyone's wait. A held send's wait is what of it fell after the send was written.
    let offBefore = 0;
    let offSince;
    const begun = () => { if (offSince === undefined) offSince = env.now(); };

    const isReady = () => joined && !closed && !!socket && socket.connected;
    const offNow = () => { begun(); return offBefore + (offSince === null ? 0 : env.now() - offSince); };
    const goneOff = () => { begun(); if (offSince === null) offSince = env.now(); };
    const backOn = () => { begun(); if (offSince !== null) { offBefore += env.now() - offSince; offSince = null; } };
    const waited = (item) => Math.max(0, Math.min(HELD_MAX_MS, Math.floor(item.base + offNow() - item.off0)));
    // A page that faults while it draws a send is said in its console, and the outbox carries on with the next.
    const tell = (item) => { try { onChange(item); } catch (e) { env.setTimeout(() => { throw e; }, 0); } };

    /** One emit, with what is defined: a verb that takes no arguments is sent none. */
    function emit(verb, wire, ack) {
      const out = wire.slice();
      if (ack) out.push(ack);
      socket.emit(verb, ...out);
    }

    function store() { return env.storage(); }
    /** The held sends, as a reload reads them back: a file without its bytes, which a reload cannot keep. */
    function save() {
      if (!key) return;
      const kept = queue.filter((i) => !FINAL.has(i.state)).map((i) => ({
        cid: i.cid, verb: i.verb, args: i.args, tag: i.tag, state: i.state === 'refused' || i.state === 'lost' ? i.state : 'waiting',
        words: i.words, file: !!i.file || !!i.hadFile, waited: waited(i), savedAt: env.wall(),
      }));
      try {
        if (kept.length) store().setItem(key, JSON.stringify(kept));
        else store().removeItem(key);
      } catch { /* storage blocked or full: what is held lives for this page only */ }
    }

    function restore(scope, who, has) {
      const mine = PREFIX + scope + '|' + who;
      let saved;
      try {
        const s = store();
        // Held as someone else in this hall: dropped, never sent as this person.
        const others = [];
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k !== mine && k.indexOf(PREFIX + scope + '|') === 0) others.push(k); }
        for (const k of others) s.removeItem(k);
        const raw = s.getItem(mine);
        saved = raw ? JSON.parse(raw) : [];
      } catch { saved = []; }   // storage blocked, or what it held is not ours to read: nothing comes back
      if (!Array.isArray(saved)) return;
      for (const r of saved) {
        if (!r || typeof r.cid !== 'string' || typeof r.verb !== 'string' || !isPlain(r.args) || queue.some((i) => i.cid === r.cid)) continue;
        // The page has the message it became (its history, drawn before the join's answer): it landed, and is done.
        if (landedThere(has, r.cid)) continue;
        const gap = Math.max(0, Math.min(HELD_MAX_MS, env.wall() - (Number(r.savedAt) || 0)));
        // A file's bytes do not outlive the page: one never uploaded cannot be sent, one uploaded goes by its link.
        const lost = !!r.file && !(typeof r.args.url === 'string' && r.args.url);
        const item = {
          cid: r.cid, verb: r.verb, args: r.args, tag: isPlain(r.tag) ? r.tag : {}, off0: offNow(), base: Math.max(0, Number(r.waited) || 0) + gap,
          state: lost ? 'lost' : r.state === 'refused' ? 'refused' : r.state === 'lost' ? 'lost' : 'waiting',
          words: lost || r.state === 'lost' ? WORDS.lost : r.state === 'refused' && typeof r.words === 'string' ? r.words : '',
          restored: true, hadFile: !!r.file, attempt: 0,
        };
        queue.push(item);
        tell(item);
      }
    }

    /** Whether the page says it has the message a send became; a page that faults while it answers has not. */
    function landedThere(has, cid) {
      if (typeof has !== 'function') return false;
      try { return has(cid) === true; } catch (e) { env.setTimeout(() => { throw e; }, 0); return false; }
    }

    function settle(item, state, words, result) {
      item.state = state;
      item.words = words || '';
      item.result = result || null;
      if (inflight === item) inflight = null;
      if (FINAL.has(state)) { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); }
      save();
      tell(item);
      pump();
    }

    function later(ms) {
      if (pumpTimer) return;
      pumpTimer = env.setTimeout(() => { pumpTimer = null; pump(); }, ms);
    }

    /** Send the oldest waiting send, one at a time, while the page is connected and joined. */
    function pump() {
      if (!isReady() || inflight || pumpTimer) return;
      const item = queue.find((i) => i.state === 'waiting');
      if (!item) return;
      inflight = item;
      item.state = 'sending';
      item.attempt++;
      tell(item);
      if (item.file && !item.args.url) { upload(item); return; }
      send(item);
    }

    function send(item) {
      const wire = [Object.assign({}, item.args, { cid: item.cid, heldMs: waited(item) })];
      emit(item.verb, wire, (res) => answered(item, res));
    }

    function upload(item) {
      const attempt = item.attempt;
      if (typeof item.upload !== 'function') { settle(item, 'refused', WORDS.lost); return; }
      Promise.resolve().then(() => item.upload(item.file)).then((r) => r, () => ({ network: true })).then((r) => {
        if (item.attempt !== attempt || item.state !== 'sending') return;
        if (r && typeof r.url === 'string' && r.url) {
          item.args = Object.assign({}, item.args, { url: r.url }, typeof r.mime === 'string' ? { mime: r.mime } : {});
          save();   // its link from now on, so a reload sends it by that link rather than asking for the file again
          if (isReady()) { send(item); return; }
          item.state = 'waiting'; inflight = null; tell(item); return;
        }
        // An upload refused for its token, which a join renews, goes once more; one that never reached AGMessage waits.
        if (r && (r.network || (r.status === 403 && !item.retoken))) {
          if (!r.network) item.retoken = true;
          item.state = 'waiting'; inflight = null; tell(item); later(BUSY_MS * 2); return;
        }
        settle(item, 'refused', (r && r.error) || WORDS.refused);
      });
    }

    /** The server's answer to a held send. Every attempt carries the same cid, so whichever answer comes first decides. */
    function answered(item, res) {
      if (FINAL.has(item.state) || item.state === 'refused' || item.state === 'lost') return;
      if (!isPlain(res)) { settle(item, 'refused', WORDS.refused); return; }
      if (res.ok) { settle(item, res.gone ? 'gone' : 'done', res.gone ? 'That message was removed.' : '', res); return; }
      if (res.busy) {
        // The rate's refusal, not the send's: held, and sent again shortly.
        item.state = 'waiting';
        if (inflight === item) inflight = null;
        tell(item);
        later(BUSY_MS);
        return;
      }
      if (res.reupload && item.file && !item.reuploaded) {
        item.reuploaded = true;
        item.args = Object.assign({}, item.args, { url: '' });
        item.state = 'waiting';
        if (inflight === item) inflight = null;
        tell(item);
        pump();
        return;
      }
      // The server no longer has the upload, and this page no longer has the file (a reload): the person chooses it again.
      if (res.reupload && !item.file && item.hadFile) { settle(item, 'lost', WORDS.lost, res); return; }
      settle(item, 'refused', typeof res.error === 'string' && res.error ? res.error : WORDS.refused, res);
    }

    function dropped() {
      joined = false;
      goneOff();
      if (inflight) {
        const item = inflight;
        inflight = null;
        if (item.state === 'sending') { item.state = 'waiting'; tell(item); }
      }
      save();   // the wait so far, kept as the spell off began: a reload during it counts from here
      for (const n of Array.from(nows)) n.dropped();
    }

    function flushSelves() {
      if (!isReady()) return;
      for (const [k, r] of Array.from(selves)) { selves.delete(k); emit(r.verb, r.wire); }
    }

    return {
      WORDS,
      cid: () => makeCid(env.crypto),

      /** The page's socket, and how it draws what is held. */
      attach(s, opts) {
        socket = s;
        if (opts && typeof opts.onChange === 'function') onChange = opts.onChange;
        socket.on('disconnect', dropped);
      },

      /**
       * The page is connected and joined (the join's answer, after it has drawn what it missed): this person's held
       * sends in this hall come back from storage, another person's are dropped, and what is held is sent.
       */
      ready(where) {
        if (closed || !where) return;
        // `where.has(cid)`: whether the page has drawn the message a send of this person's became, so a send that landed
        // before a reload is matched to it, never sent or offered again.
        const k = PREFIX + where.scope + '|' + where.who;
        if (key && key !== k) {
          // Someone else on this page now: what was held as the other is never sent as this one.
          for (const i of queue.splice(0)) { i.state = 'dropped'; tell(i); }
          inflight = null;
        }
        key = k;
        if (!restored.has(k)) { restored.add(k); restore(where.scope, where.who, where.has); }
        joined = true;
        backOn();
        save();
        pump();
        for (const n of Array.from(nows)) n.again();
        flushSelves();
      },

      /** Hold a send until the server answers it. `opts`: `tag` (the page's, kept with it), `file` and `upload(file)`. */
      hold(verb, args, opts) {
        const o = opts || {};
        const item = {
          cid: makeCid(env.crypto), verb, args: Object.assign({}, args), tag: isPlain(o.tag) ? o.tag : {}, off0: offNow(), base: 0,
          state: 'waiting', words: '', attempt: 0, file: o.file || null, upload: o.upload || null,
        };
        if (closed) { item.state = 'refused'; item.words = WORDS.left; tell(item); return item; }
        queue.push(item);
        save();
        tell(item);
        pump();
        return item;
      },

      /**
       * An act on something, answered in `done(res)`: refused at once while not connected, "No answer" after 5 s. An act
       * that waits on another machine may answer later than that: its answer is then given too, once, with `late: true`,
       * so what it did is said, never left at "No answer".
       */
      now(verb, args, done) {
        const answer = typeof done === 'function' ? done : () => {};
        if (!isReady()) { answer({ ok: false, error: WORDS.offline, offline: true }); return; }
        const cid = makeCid(env.crypto);
        const wire = args === undefined ? [] : [isPlain(args) ? Object.assign({}, args, { cid }) : args];
        const repeats = verb === 'react' ? isPlain(args) && typeof args.on === 'boolean' : REPEATS.has(verb);
        let timer = null;
        let waiting = false;
        let told = false;   // the server's own answer has been given
        const n = {
          /** The outbox's words (`res` from here) or the server's answer (`real`): the first is given, then a late real one. */
          finish(res, real) {
            if (nows.has(n)) {
              nows.delete(n);
              env.clearTimeout(timer);
              if (real) told = true;
              answer(res);
              return;
            }
            if (real && !told && !closed && isPlain(res)) { told = true; answer(Object.assign({}, res, { late: true })); }
          },
          go() {
            waiting = false;
            env.clearTimeout(timer);
            timer = env.setTimeout(() => n.finish({ ok: false, error: WORDS.noAnswer }, false), ACK_MS);
            emit(verb, wire, (res) => n.finish(isPlain(res) ? res : { ok: false, error: WORDS.noAnswer }, isPlain(res)));
          },
          // A drop while it is out: the server may or may not have it. Sent again, with its cid, only where a repeat is
          // answered, and within its own 5 s; otherwise the person is told to check.
          dropped() {
            if (!repeats) { n.finish({ ok: false, error: WORDS.dropped }, false); return; }
            waiting = true;
          },
          again() { if (waiting && isReady()) n.go(); },
        };
        nows.add(n);
        n.go();
      },

      /** A report of what the person did on their own page: the newest per key is sent once connected and joined. */
      self(verb, args, k) {
        selves.set(verb + '|' + (k === undefined ? '' : k), { verb, wire: args === undefined ? [] : [args] });
        flushSelves();
      },

      /** An act with nothing on the wire. */
      local(fn) { if (typeof fn === 'function') fn(); },

      /** The page has the message a send became (the broadcast, the changes it missed, the history): it is done. */
      landed(cid) {
        const item = queue.find((i) => i.cid === cid);
        if (item && !FINAL.has(item.state)) settle(item, 'done', '', { ok: true });
      },

      /** Send a refused send again, with its cid. */
      retry(cid) {
        const item = queue.find((i) => i.cid === cid);
        if (!item || item.state !== 'refused') return;
        item.state = 'waiting';
        item.words = '';
        save();
        tell(item);
        pump();
      },

      /** Let go of a held send (Edit, Remove): it is not sent. */
      drop(cid) {
        const item = queue.find((i) => i.cid === cid);
        if (item) settle(item, 'dropped', '');
      },

      /** Sent out of the hall: nothing held is sent, now or after, and this tab keeps none of it. */
      clear() {
        closed = true;
        joined = false;
        goneOff();
        if (pumpTimer) { env.clearTimeout(pumpTimer); pumpTimer = null; }
        inflight = null;
        for (const i of queue.splice(0)) { i.state = 'dropped'; tell(i); }
        for (const n of Array.from(nows)) n.finish({ ok: false, error: WORDS.left }, false);
        selves.clear();
        try { if (key) store().removeItem(key); } catch { /* storage blocked: it held nothing */ }
      },

      /** The held sends, oldest first (each as the page was told of it). */
      items: () => queue.slice(),
      /** How many acts (`now`) are out and not yet answered: each until its answer, its "No answer" or its drop's words. */
      acting: () => nows.size,
      /** Whether a `now` act would be sent at once. */
      get online() { return isReady(); },
    };
  }

  const outbox = create({
    crypto: window.crypto,
    storage: () => window.sessionStorage,
    now: () => window.performance.now(),
    wall: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t),
  });
  outbox.create = create;
  Object.assign(window.AGM = window.AGM || {}, { outbox });
})();
