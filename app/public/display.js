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

  let pdfjs = null;
  async function renderFile(c) {
    show('file');
    const img = $('fileImg'), canvas = $('fileCanvas');
    const seq = state.seq;
    if (!c.pdf) {
      canvas.hidden = true;
      img.onload = () => { img.hidden = false; if (seq === state.seq) report(true); };
      img.onerror = () => { img.hidden = true; if (seq === state.seq) report(false, 'the image did not load'); };
      img.src = c.url;
      return;
    }
    img.hidden = true;
    try {
      if (!pdfjs) { pdfjs = await import('/vendor/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'; }
      const doc = await pdfjs.getDocument({ url: c.url, withCredentials: false, isEvalSupported: false, enableXfa: false }).promise;
      const page = await doc.getPage(Math.min(c.page || 1, doc.numPages));
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(window.innerWidth / base.width, window.innerHeight / base.height) * (window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / (window.devicePixelRatio || 1)) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (seq !== state.seq) return;
      canvas.hidden = false;
      report(true, (c.page || 1) > doc.numPages ? 'the PDF has ' + doc.numPages + ' pages: showing the last' : '');
    } catch (e) {
      if (seq === state.seq) report(false, 'the PDF did not render: ' + String(e && e.message || e).slice(0, 80));
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
  }

  function tickClock() {
    const now = new Date(Date.now() + offset);
    $('clockTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    $('clockDate').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  setInterval(() => { if (document.body.dataset.kind === 'clock') tickClock(); }, 250);

  // ---------------------------------------------------------------- the link
  let linkUp = false;
  let lostTimer = null;
  const socket = io({ transports: ['websocket', 'polling'], auth: { display: token } });
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
