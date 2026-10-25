// A display: shows what its hall's operators put on it, and says what it showed. It holds no rights but its link; it
// sends nothing but "shown" reports. Options in the URL: ?idle=blank (no faint name on an empty holding screen),
// ?status=hide (no link dot in the corner).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const token = (location.pathname.split('/')[2] || '').trim();
  if (params.get('status') === 'hide') document.body.classList.add('hide-status');

  let state = null;        // the server's display:state
  let stage = null;        // the hall's Stagewatch frame
  let offset = 0;          // server clock − this screen's clock, ms
  let renderedSeq = 0;

  const report = (ok, words) => { if (state) socket.emit('display:shown', { seq: state.seq, ok, words: words || '' }); };
  const show = (kind) => { document.body.dataset.kind = kind; };
  function notice(text) { const n = $('notice'); n.textContent = text || ''; n.hidden = !text; }

  // ---------------------------------------------------------------- fitting words to the screen
  /** The largest font size (in px) at which `el` fits `maxW` × `maxH`, found by halving. */
  function fit(el, maxW, maxH, lo = 16, hi = 600) {
    for (let i = 0; i < 14 && hi - lo > 1; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = mid + 'px';
      if (el.scrollWidth <= maxW && el.scrollHeight <= maxH) lo = mid; else hi = mid;
    }
    el.style.fontSize = lo + 'px';
  }
  const MARK = { info: '●', warn: '▲', urgent: '■' };

  // ---------------------------------------------------------------- what to show
  function render() {
    if (!state) return;
    const c = state.content || { kind: 'black' };
    renderedSeq = state.seq;
    document.body.dataset.tone = c.tone || 'info';
    switch (c.kind) {
      case 'holding': return renderHolding(c.image || state.holding);
      case 'message': return renderMessage(c);
      case 'file': return renderFile(c);
      case 'countdown': show('countdown'); renderCountdown(); return report(true);
      case 'clock': show('clock'); tickClock(); return report(true);
      default: show('black'); return report(true);
    }
  }

  function renderHolding(image) {
    show('holding');
    const img = $('holdingImg');
    $('idleName').textContent = image || params.get('idle') === 'blank' ? '' : (state.name + (state.hallName ? ' · ' + state.hallName : ''));
    if (!image) { img.hidden = true; img.removeAttribute('src'); return report(true); }
    const seq = state.seq;
    img.onload = () => { img.hidden = false; if (seq === state.seq) report(true); };
    img.onerror = () => { img.hidden = true; if (seq === state.seq) report(false, 'the holding image did not load'); };
    if (img.getAttribute('src') === image && img.complete && img.naturalWidth) { img.hidden = false; report(true); } else img.src = image;
  }

  function renderMessage(c) {
    show('message');
    const p = $('messageText');
    p.textContent = '';
    const mark = document.createElement('span');
    mark.className = 'tone-mark';
    mark.textContent = MARK[c.tone] || MARK.info;
    p.appendChild(mark);
    p.appendChild(document.createTextNode(c.text));
    $('toneMark').textContent = '';
    $('messageSub').textContent = c.sub || '';
    fit(p, window.innerWidth * 0.88, window.innerHeight * (c.sub ? 0.62 : 0.74));
    report(true);
  }

  // A file. Every file render is numbered and only the newest may touch the screen, so a file taken earlier that loads
  // late never paints over, or appears beside, the one taken after it. A PDF page is drawn off screen and copied in at
  // once: the slide on air is never cleared to be redrawn, and a state that changes nothing about the page or the
  // screen's size (a rename, a reconnect, a new holding image) leaves it alone. One pdf.js worker serves the page's life
  // and one document is open at a time: stepping through a deck reuses it, another PDF closes it.
  let pdfjs = null, pdfWorker = null, pdfOpen = null;   // pdfOpen: {url, task}
  let fileGen = 0, drawnKey = '', drawnWords = '';
  function loadPdfjs() {
    pdfjs = pdfjs || import('/vendor/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      pdfWorker = new lib.PDFWorker();
      return lib;
    }, (e) => { pdfjs = null; throw e; });
    return pdfjs;
  }
  function openPdf(lib, url) {
    if (!pdfOpen || pdfOpen.url !== url) {
      const old = pdfOpen;
      pdfOpen = { url, task: lib.getDocument({ url, worker: pdfWorker, withCredentials: false, isEvalSupported: false, enableXfa: false }) };
      if (old) closePdf(old.task);
    }
    return pdfOpen;
  }
  // Frees a document in the shared worker (the worker stays): once it has finished loading, since one closed mid-load
  // fails inside the worker when its data arrives, or after 30 s whatever it is doing.
  function closePdf(task) {
    let closed = false;
    const close = () => { if (!closed) { closed = true; task.destroy(); } };
    task.promise.then(close, close);
    setTimeout(close, 30000);
  }
  async function renderFile(c) {
    show('file');
    const img = $('fileImg'), canvas = $('fileCanvas');
    const seq = state.seq, gen = ++fileGen;
    const current = () => gen === fileGen && !!state && seq === state.seq;
    if (!c.pdf) {
      canvas.hidden = true; drawnKey = '';
      img.onload = () => { if (!current()) return; img.hidden = false; report(true); };
      img.onerror = () => { if (!current()) return; img.hidden = true; report(false, 'the image did not load'); };
      img.src = c.url;
      return;
    }
    img.onload = img.onerror = null; img.hidden = true; img.removeAttribute('src');
    const dpr = window.devicePixelRatio || 1;
    const key = c.url + '#' + (c.page || 1) + '@' + window.innerWidth + 'x' + window.innerHeight + 'x' + dpr;
    if (key === drawnKey && !canvas.hidden) { report(true, drawnWords); return; }
    let open = null, loaded = false;
    try {
      const lib = await loadPdfjs();
      if (!current()) return;
      open = openPdf(lib, c.url);
      const doc = await open.task.promise;
      loaded = true;
      if (!current()) return;
      const page = await doc.getPage(Math.min(c.page || 1, doc.numPages));
      if (!current()) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(window.innerWidth / base.width, window.innerHeight / base.height) * dpr });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
      await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      if (!current()) return;
      canvas.width = off.width; canvas.height = off.height;
      canvas.style.width = Math.floor(vp.width / dpr) + 'px';
      canvas.getContext('2d').drawImage(off, 0, 0);
      canvas.hidden = false;
      drawnKey = key;
      drawnWords = (c.page || 1) > doc.numPages ? 'the PDF has ' + doc.numPages + ' pages: showing the last' : '';
      report(true, drawnWords);
    } catch (e) {
      // A document that did not load, or did not render for the take on screen, is opened afresh next time.
      if (open && pdfOpen === open && (!loaded || current())) { pdfOpen = null; closePdf(open.task); }
      if (!current()) return;   // a newer take closed this document or took the screen: nothing to say about this one
      canvas.hidden = true; drawnKey = '';
      report(false, 'the PDF did not render: ' + String(e && e.message || e).slice(0, 80));
    }
  }

  // The countdown is Stagewatch's own frame: its words, its colour. With the link lost it never shows a confident stale
  // time: the digits dim to --:-- until frames come back (Show Bus: silence is never "fine").
  function renderCountdown() {
    const box = $('countdown');
    const live = !!(stage && stage.status === 'connected' && !stage.stale && linkUp);
    box.classList.toggle('stale', !live);
    $('cdTime').textContent = live && stage.text ? stage.text : '--:--';
    $('cdTime').style.color = live && stage.color ? stage.color : '';
    $('cdTitle').textContent = stage && stage.title ? stage.title : (stage && stage.status !== 'off' ? '' : 'No stage timer linked');
    $('cdNext').textContent = live && stage.next ? 'Next: ' + stage.next : '';
    const c = (state && state.content) || {};
    const text = c.text || (live && stage.message) || '';
    const tone = c.text ? (c.tone || 'info') : 'info';
    document.body.dataset.strip = tone;
    $('cdStrip').hidden = !text;
    $('cdMark').textContent = text ? MARK[tone] : '';
    $('cdText').textContent = text;
    fitStrip(text);
  }
  // The strip never covers the time it sits under: its words shrink from the stylesheet's size until the strip fits the
  // room below the time and what's next (an upright tablet on the lectern, a long message from Stagewatch). Fitted
  // again only when the words or the room change, not on every frame of the countdown.
  let stripKey = '';
  function fitStrip(text) {
    const strip = $('cdStrip');
    if (!text) { stripKey = ''; return; }
    const next = $('cdNext');
    const above = Math.max($('cdTime').getBoundingClientRect().bottom, next.textContent ? next.getBoundingClientRect().bottom : 0);
    const room = Math.max(window.innerHeight * 0.14, window.innerHeight - above);
    const key = text + '|' + window.innerWidth + 'x' + window.innerHeight + '|' + Math.round(above);
    if (key === stripKey) return;
    stripKey = key;
    strip.style.fontSize = '';
    if (strip.scrollHeight <= room && strip.scrollWidth <= window.innerWidth) return;
    fit(strip, window.innerWidth, room, 12, window.innerHeight * 0.06);
  }

  // The time of day by AGMessage's clock (offset) and in AGMessage's time zone (the screen's computer may be set to
  // another); a browser that does not know that zone shows its own rather than no clock.
  let clockFmt = null;
  function clockFormats(tz) {
    const t = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const d = { weekday: 'long', day: 'numeric', month: 'long' };
    if (tz) {
      try { return [new Intl.DateTimeFormat([], { ...t, timeZone: tz }), new Intl.DateTimeFormat([], { ...d, timeZone: tz })]; } catch { /* a zone this browser does not know: its own, below */ }
    }
    return [new Intl.DateTimeFormat([], t), new Intl.DateTimeFormat([], d)];
  }
  function tickClock() {
    const now = new Date(Date.now() + offset);
    if (!clockFmt) clockFmt = clockFormats(state && state.tz);
    $('clockTime').textContent = clockFmt[0].format(now);
    $('clockDate').textContent = clockFmt[1].format(now);
  }
  setInterval(() => { if (document.body.dataset.kind === 'clock') tickClock(); }, 250);

  // ---------------------------------------------------------------- the link
  let linkUp = false;
  let lostTimer = null;
  // This page's own key on the link: after a blip its new connection is the same screen, not a second one.
  const screenKey = window.crypto && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('') : '';
  const socket = io({ transports: ['websocket', 'polling'], auth: { display: token, screen: screenKey } });
  socket.on('connect', () => {
    linkUp = true;
    clearTimeout(lostTimer);
    $('linkDot').dataset.state = 'ok';
    notice('');
  });
  socket.on('disconnect', () => {
    clearTimeout(lostTimer);
    // A blip is not news; six seconds of silence is (the Show Bus' stale mark).
    lostTimer = setTimeout(() => { linkUp = false; $('linkDot').dataset.state = 'lost'; if (document.body.dataset.kind === 'countdown') renderCountdown(); }, 6000);
  });
  socket.on('display:state', (s) => {
    state = s;
    stage = s.stage;
    offset = Number.isFinite(s.now) ? s.now - Date.now() : 0;
    clockFmt = clockFormats(s.tz);
    document.title = s.name + ' — AGMessage screen';
    render();
  });
  socket.on('display:stage', (st) => { stage = st; if (document.body.dataset.kind === 'countdown') renderCountdown(); });
  socket.on('display:identify', ({ name, hall, seconds } = {}) => {
    $('idName').textContent = name || '';
    $('idHall').textContent = hall || '';
    $('identify').hidden = false;
    clearTimeout(socket.idTimer);
    socket.idTimer = setTimeout(() => { $('identify').hidden = true; }, (seconds || 6) * 1000);
  });
  socket.on('display:unknown', ({ words } = {}) => { state = null; show('black'); notice(words || 'This screen link is not in use.'); });
  socket.on('connect_error', (e) => { if (/HTTPS/.test(String(e && e.message))) notice(e.message); });

  // ---------------------------------------------------------------- a screen left on all day
  window.addEventListener('resize', () => { if (state && renderedSeq) render(); });
  let wake = null;
  async function keepAwake() { try { if (navigator.wakeLock && document.visibilityState === 'visible' && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* not over HTTPS, or refused: the screen's own power settings decide */ } }
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();
  let idle = null;
  const awake = () => { document.body.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => document.body.classList.add('idle'), 2500); };
  document.addEventListener('mousemove', awake);
  awake();
  document.addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notice('This is not a screen link. Ask the hall\'s operator for it.');
})();
