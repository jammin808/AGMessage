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
//
// Back on another build (AGM.reconnect.build): a page names the build that served it as it connects (auth()), and one
// whose server's answers carry another reloads itself at a quiet moment of its kind (QUIET), once per build in a tab.
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

  // ---------------------------------------------------------------- a page on another build
  // The build that served the page (/build.js: AGM.build) is named as it connects (auth()), and each answer that carries
  // the server's build (a hall's join, the halls board's watch, the admin page's settings, a screen's state) is heard: a
  // page on another build reloads itself, its scripts and styles checked with the server as they load (no-cache), at the
  // first quiet moment its kind names (QUIET), and the admin page when its admin agrees. A quiet moment is one at which
  // the page is connected to its server, so a reload never lands on a server it cannot reach. Once per build in a tab
  // by itself: a page that reloaded for a build and still is not on it (a script that did not load) stays as it is and
  // says so, and so does a page that cannot keep that it reloaded (its storage blocked), so no page ever reloads again
  // and again; a reload a person asks for is theirs, and goes. A page that does not know its own build compares nothing.
  const CHECK_MS = 2000;
  const IDLE_MS = 5000;
  const RELOADED = 'agm.reloadedFor';
  const UPDATED = Object.freeze({ stays: 'AGMessage now runs another build — reload this page when you can.' });
  /**
   * The quiet moments, by page, from what the page says of itself now (pure). A hall page: connected and in its hall
   * (`online`), nothing written and not sent (`held`: the outbox holds a send or waits on an act's answer; `draft`: a
   * composer holds words or a file), no dialog, menu or ask open, no document open on its stage, not sent out of its
   * hall, and not touched for IDLE_MS (or not shown at all). The halls board: connected and watching (`online`), no
   * answer held and no act waiting, no dialog, menu or ask, and not touched for IDLE_MS (or not shown). A screen (told
   * in an answer, so connected): between takes, a take it has not drawn (`seq` against `drawn`, its last; none drawn yet).
   */
  const QUIET = Object.freeze({
    hall: (f) => !!f.online && !f.out && !f.held && !f.draft && !f.dialog && !f.document && (f.hidden || f.idleMs >= IDLE_MS),
    halls: (f) => !!f.online && !f.held && !f.dialog && (f.hidden || f.idleMs >= IDLE_MS),
    screen: (f) => !f.drawn || f.seq !== f.drawn,
  });

  /**
   * A page's builds on `env`: `mine()` (the page's own build, '' when it does not know it), `storage()` (sessionStorage,
   * or a throw where it is blocked), `reload()`, `now()`, `hidden()`, `onTouch(fn)` (fn at each key, pointer or wheel),
   * `setTimeout`, `clearTimeout`. Returns {heard(build), when(isQuiet, {stays}), reload(asked), state()}.
   */
  function builds(env) {
    let server = '';
    let isQuiet = null;
    let onStays = null;
    let timer = null;
    let gone = false;
    let stays = false;
    let touched = 0;   // when the page was last touched: counted from when it names its quiet moment
    const mine = () => { const m = env.mine(); return typeof m === 'string' ? m : ''; };
    const stale = () => !!mine() && !!server && server !== mine();
    /** Whether this tab reloaded for the server's build already (and so did not come back on it). */
    const tried = () => { try { return !!server && env.storage().getItem(RELOADED) === server; } catch { return false; } };
    const state = () => ({ mine: mine(), server, stale: stale(), reloading: gone, stays, tried: stale() && tried() });
    /** The page stays on its build, and says so once (the page's `stays`). */
    function stay() {
      stays = true;
      env.clearTimeout(timer);
      timer = null;
      if (onStays) onStays(UPDATED.stays);
      return false;
    }
    /**
     * Reload for the server's build. By itself (`asked` false), once in this tab: never where it did already for that
     * build, or cannot keep that it did. Asked by a person (`asked`), whenever the page is on another build: a reload a
     * person asks for cannot come back to itself unasked, so neither guard holds it.
     */
    function reload(asked) {
      if (gone || !stale() || (stays && !asked)) return false;
      try {
        const s = env.storage();
        if (s.getItem(RELOADED) === server && !asked) return stay();
        s.setItem(RELOADED, server);
      } catch {
        if (!asked) return stay();   // storage blocked: a reload it could not count might come back to this, again and again
      }
      gone = true;
      env.clearTimeout(timer);
      timer = null;
      env.reload();
      return true;
    }
    function check() {
      timer = null;
      if (gone || stays || !stale() || !isQuiet) return;
      if (isQuiet({ idleMs: env.now() - touched, hidden: env.hidden() }) && reload(false)) return;
      if (!gone && !stays) timer = env.setTimeout(check, CHECK_MS);
    }
    return {
      /**
       * The server's build, from an answer: whether this page is on another (an answer without one changes nothing). A page
       * that waits for a quiet moment is checked now and every CHECK_MS until it is one.
       */
      heard(build) {
        if (typeof build !== 'string' || !build || build.length > 80) return stale();
        // A build it has not heard before: a page that stayed on its build for the one before may reload for this one.
        if (build !== server) { server = build; stays = false; }
        if (!stale()) { env.clearTimeout(timer); timer = null; } else if (!timer) check();
        return stale();
      },
      /**
       * The page's quiet moment: `isQuiet({idleMs, hidden})` true when it is one; `opts.stays(words)` told once if the page
       * must stay on its build. A page that names none reloads only by reload(), its person's or its own.
       */
      when(fn, opts) {
        if (typeof fn !== 'function' || isQuiet) return;
        isQuiet = fn;
        if (opts && typeof opts.stays === 'function') onStays = opts.stays;
        touched = env.now();
        env.onTouch(() => { touched = env.now(); });
        if (stale() && !timer) check();
      },
      reload,
      state,
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
  const ownBuild = () => (window.AGM && typeof window.AGM.build === 'string' ? window.AGM.build : '');
  const build = builds({
    mine: ownBuild,
    storage: () => window.sessionStorage,
    reload: () => window.location.reload(),
    now: () => window.performance.now(),
    hidden: () => document.visibilityState === 'hidden',
    onTouch(fn) { for (const ev of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(ev, fn, { capture: true, passive: true }); },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t),
  });
  /** A socket's `auth`: what the page gives (a screen its link), and the build that served it. */
  const auth = (extra) => Object.assign({}, extra, { build: ownBuild() });
  const reconnect = { OPTIONS, WORDS, DOWN_MS, DOT_MS, CHECK_MS, IDLE_MS, RELOADED, UPDATED, QUIET, retryIn, dotName, create, builds, auth, build, attach: page.attach };
  Object.assign(window.AGM = window.AGM || {}, { reconnect });
})();
