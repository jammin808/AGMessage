// Pages come back by themselves (AGM.reconnect). Every page that opens a socket opens it with OPTIONS and attaches it
// here, so it comes back without a reload after:
//
//   a refusal  the server refused the connection and said when to try again (`retryMs`: never before its bucket holds
//              the next token, spread so one network's pages do not come back together; 30 to 40 s for a place through
//              the tunnel). The page tries then, never sooner, and says so meanwhile: in the server's own words when the
//              refusal says what it refused (`why`: the rate, one network's share of the tunnel, the tunnel full), which
//              name the wait, else "Busy — trying again in 3 s.". A refusal that says `retry: false` (HTTPS is
//              required here) is not tried again: its words are given instead.
//   a drop     Socket.IO tries again from 0.5 s, doubling to 2 s at most, each ±50 % (OPTIONS).
//   a sleep, or a change of network
//              a page that is not connected when it is shown again (visibilitychange) or when the browser is back online
//              starts afresh at once: Socket.IO's own connect() does nothing while it waits out its backoff, so the
//              socket is closed and opened again. A refusal's wait is kept even then: the server's pace holds.
//
// While a page is not back (connected, and joined where the page joins) it says so: after DOWN_MS its strip, after DOT_MS
// the dot's words; both go once it is back. A page the server sent away, or that closed its own socket, is not brought
// back and says nothing of reconnecting. It touches no DOM but the strip it is given; the screen page (/d/) gives none,
// so it retries in silence.
(function () {
  'use strict';
  const OPTIONS = Object.freeze({ reconnectionDelay: 500, reconnectionDelayMax: 2000, randomizationFactor: 0.5 });
  const DOWN_MS = 2000;
  const DOT_MS = 5000;
  // A refusal's wait as the page keeps it: the server's, from 1 s to 5 minutes; 3 s when it names none.
  const RETRY_MS = 3000;
  const RETRY_MIN_MS = 1000;
  const RETRY_MAX_MS = 300000;
  const WORDS = Object.freeze({
    busy: (seconds) => 'Busy — trying again in ' + seconds + ' s.',
    down: 'Reconnecting… what you write waits here until we\'re back.',
    dot: 'Offline · reconnecting',
    refused: 'AGMessage refused this connection.',
    connected: 'Connected',
    connecting: 'Connecting',
    offline: 'Offline',
  });
  // The reasons a socket goes that Socket.IO does not come back from: the server sent it away, or the page closed it.
  const STOPPED = ['io server disconnect', 'io client disconnect'];

  /** The wait a refusal names, as the page keeps it (whole ms). */
  function retryIn(err) {
    const d = err && err.data;
    const ms = d && typeof d.retryMs === 'number' && Number.isFinite(d.retryMs) ? d.retryMs : RETRY_MS;
    return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(ms)));
  }
  /** A refusal for good, in the server's words (as text, 300 characters at most). */
  const refusalWords = (err) => (err && typeof err.message === 'string' && err.message ? err.message : WORDS.refused).slice(0, 300);
  /** What a refusal to wait out refused, and its words (as text, 300 characters at most), when it says; else nothing. */
  function saidWhy(err) {
    const d = err && err.data;
    if (!d || typeof d.why !== 'string' || !d.why || typeof err.message !== 'string' || !err.message) return { why: '', told: '' };
    return { why: d.why.slice(0, 40), told: err.message.slice(0, 300) };
  }
  /**
   * The dot's name for a screen reader (and its title), from what is true of a state: back, connected and waiting for
   * the join's answer, not brought back (sent away, closed, refused for good), or not connected and trying again.
   */
  const dotName = (st) => (st.back ? WORDS.connected : st.connected ? WORDS.connecting : st.stopped ? WORDS.offline : WORDS.dot);

  /**
   * Reconnects on `env`: `now()` (a monotonic count in ms), `setTimeout`, `clearTimeout`, and `onWake(fn)`, which calls fn
   * each time the page is shown again or the browser is back online.
   */
  function create(env) {
    return {
      /**
       * Bring `socket` back by itself. `opts`: `join` (the page is back only once it calls joined(), at its join's answer),
       * `down` (its strip says "Reconnecting…" after DOWN_MS), `strip` (an element the words are drawn in: its
       * textContent and hidden), `onChange(state)` (each change: back, connected, busy (the seconds said), refused, down,
       * dot, stopped, the strip's words, and why a refusal being waited out was made, when it said). Returns {joined(),
       * state()}.
       */
      attach(socket, opts) {
        const o = opts || {};
        const st = { back: false, busy: 0, refused: '', down: false, dot: false, stopped: false, why: '', told: '' };
        let downTimer = null;
        let dotTimer = null;
        let busyTimer = null;
        let busyUntil = 0;
        const words = () => st.refused || (st.busy ? st.told || WORDS.busy(st.busy) : '') || (st.down && o.down ? WORDS.down : '');
        const state = () => ({ back: st.back, connected: socket.connected === true, busy: st.busy, refused: st.refused, down: st.down, dot: st.dot, stopped: st.stopped, words: words(), why: st.why });
        function tell() {
          const v = state();
          if (o.strip) { o.strip.textContent = v.words; o.strip.hidden = !v.words; }
          if (typeof o.onChange === 'function') o.onChange(v);
        }
        // Not back since now: the strip and the dot's words wait their time, counted from the first moment, not each try.
        function arm() {
          if (st.stopped) return;
          if (!st.down && !downTimer) downTimer = env.setTimeout(() => { downTimer = null; st.down = true; tell(); }, DOWN_MS);
          if (!st.dot && !dotTimer) dotTimer = env.setTimeout(() => { dotTimer = null; st.dot = true; tell(); }, DOT_MS);
        }
        function disarm() {
          env.clearTimeout(downTimer);
          env.clearTimeout(dotTimer);
          downTimer = null;
          dotTimer = null;
        }
        function unbusy() {
          env.clearTimeout(busyTimer);
          busyTimer = null;
          Object.assign(st, { busy: 0, why: '', told: '' });
        }
        function back() {
          disarm();
          unbusy();
          Object.assign(st, { back: true, refused: '', down: false, dot: false, stopped: false });
          tell();
        }

        socket.on('connect', () => {
          // Connected: what was said stays until the page is back (a joining page: at its join's answer), but nothing
          // more is said meanwhile.
          disarm();
          unbusy();
          st.refused = '';
          st.stopped = false;
          if (o.join) tell();
          else back();
        });
        socket.on('disconnect', (reason) => {
          st.back = false;
          if (STOPPED.includes(reason)) {
            disarm();
            Object.assign(st, { stopped: true, down: false, dot: false });
          } else arm();
          tell();
        });
        socket.on('connect_error', (err) => {
          st.back = false;
          if (socket.active) {
            // A connection that failed (the server down, the network gone): Socket.IO tries again by itself.
            unbusy();
            arm();
            tell();
            return;
          }
          unbusy();
          if (err && err.data && err.data.retry === false) {
            disarm();
            Object.assign(st, { stopped: true, refused: refusalWords(err), down: false, dot: false });
            tell();
            return;
          }
          // Refused by the server: tried again at the wait it named, which the words say in whole seconds, rounded up (the
          // server's own words, when it says what it refused, name the same wait).
          const ms = retryIn(err);
          st.busy = Math.ceil(ms / 1000);
          Object.assign(st, saidWhy(err));
          busyUntil = env.now() + ms;
          busyTimer = env.setTimeout(() => { busyTimer = null; socket.connect(); }, ms);
          arm();
          tell();
        });
        env.onWake(() => {
          if (st.stopped || socket.connected) return;
          if (busyTimer && env.now() < busyUntil) return;
          unbusy();
          socket.disconnect();
          socket.connect();
          tell();
        });
        if (!socket.connected) arm();
        return {
          /** The page's join was answered: it is back, and says so. */
          joined() { if (socket.connected) back(); },
          state,
        };
      },
    };
  }

  const page = create({
    now: () => window.performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t),
    onWake(fn) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fn(); });
      window.addEventListener('online', fn);
    },
  });
  const reconnect = { OPTIONS, WORDS, DOWN_MS, DOT_MS, retryIn, dotName, create, attach: page.attach };
  Object.assign(window.AGM = window.AGM || {}, { reconnect });
})();
