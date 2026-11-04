// What a person's page is shown over its chat (a take), drawn: Stagewatch's countdown, AGMessage's clock, a holding slide,
// black and a web page. The hall page (app.js) loads this module with import() at its first take, hands it a box and plain
// values (Stagewatch's frame, AGMessage's clock offset and zone, the hall's name and holding picture, who put the take up,
// whether the page is connected) and reads back what it drew; the page alone says so to the server (page:report), so what
// was drawn is said in one place, from the drawing. Nothing here holds a socket, and every node is built with the DOM and
// textContent.
//
//   render(box, content, ctx) → Promise<{state, words}>   the take drawn into box: 'shown' (a web page: 'opened'), or
//                                                          'failed' and why
//   card(content, ctx)        → element                   the take as a card in the side bar: its icon, its name, and its
//                                                          live words (the countdown's time, the clock's)
//   tick(root, ctx)                                        the live parts under root drawn again (the clock, Stagewatch)
//   webAddress(url)           → {url, host} | {error}      a web page's address as a frame may be given it
//   framePage(url)            → {frame, url, host} | {error}  the one frame a page makes, for a web page (a take, a Preview)

/** Each kind's card: its icon (no status mark: each mark has one meaning, common.js AGM.MARKS) and its name. */
const KINDS = Object.freeze({
  stage: Object.freeze({ icon: '⏱', name: 'Stagewatch' }),
  clock: Object.freeze({ icon: '🕐', name: 'Clock' }),
  holding: Object.freeze({ icon: '🖼', name: 'Holding' }),
  blank: Object.freeze({ icon: '🌑', name: 'Blank' }),
  web: Object.freeze({ icon: '🌍', name: 'Web page' }),
});
/**
 * How long a web page has to load before its take says it did not (`failed`). A frame the site refuses (its
 * X-Frame-Options or frame-ancestors) still fires `load`, and nothing inside it can be read, so `load` is all that is
 * known: the page opened.
 */
const WEB_WAIT_MS = 15000;
const WEB_MAX = 2048;

const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** A kind's icon and name, or none for a kind this page does not draw. */
const kindOf = (content) => (content && Object.prototype.hasOwnProperty.call(KINDS, content.kind) ? KINDS[content.kind] : null);

/**
 * Whether Stagewatch's time is live: the link connected (or viewing its public frame), its frame fresh, and this page
 * connected. Otherwise the time reads --:--, never a confident stale time (the screen page's rule, display.js).
 */
const liveStage = (ctx) => {
  const v = ctx && ctx.stage;
  return !!(v && (v.status === 'connected' || v.status === 'viewing') && !v.stale && ctx.connected !== false);
};

// The clock by AGMessage's clock (the server's `now` against this device's, `offset`) and in AGMessage's time zone; a
// browser that does not know that zone shows its own rather than no clock.
const formats = new Map();
function clockFormats(tz) {
  const key = tz || '';
  if (formats.has(key)) return formats.get(key);
  const t = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const d = { weekday: 'long', day: 'numeric', month: 'long' };
  let f = null;
  if (tz) {
    try { f = [new Intl.DateTimeFormat([], { ...t, timeZone: tz }), new Intl.DateTimeFormat([], { ...d, timeZone: tz })]; } catch { /* a zone this browser does not know: its own, below */ }
  }
  if (!f) f = [new Intl.DateTimeFormat([], t), new Intl.DateTimeFormat([], d)];
  formats.set(key, f);
  return f;
}
const nowOf = (ctx) => new Date(Date.now() + ((ctx && Number.isFinite(ctx.offset)) ? ctx.offset : 0));

/** Stagewatch's frame drawn into its parts (a take's, or a card's time alone). */
function drawStage(root, ctx) {
  const v = (ctx && ctx.stage) || null;
  const live = liveStage(ctx);
  const time = root.querySelector('.take-time');
  if (time) time.textContent = live && v.text ? v.text : '--:--';
  root.classList.toggle('stale', !live);
  const title = root.querySelector('.take-title');
  if (title) title.textContent = v && v.title ? v.title : v ? '' : 'No stage timer linked';
  const next = root.querySelector('.take-next');
  if (next) next.textContent = live && v.next ? 'Next: ' + v.next : '';
  const message = root.querySelector('.take-message');
  if (message) { message.textContent = live && v.message ? v.message : ''; message.hidden = !message.textContent; }
}
/** The clock drawn into its parts. */
function drawClock(root, ctx) {
  const f = clockFormats(ctx && ctx.tz);
  const now = nowOf(ctx);
  const time = root.querySelector('.take-time');
  if (time) time.textContent = f[0].format(now);
  const date = root.querySelector('.take-date');
  if (date) date.textContent = f[1].format(now);
}

/**
 * A web page's address as a frame may be given it, checked again in the page (the server's rules, lib/pages.js webUrl):
 * a string of at most WEB_MAX characters that parses, https alone, no user name or password, and not this page's own
 * origin nor this device by a loopback name. {url, host}, or {error} in words.
 */
export function webAddress(v) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw || raw.length > WEB_MAX) return { error: raw ? 'That address is longer than ' + WEB_MAX + ' characters.' : 'A web page is shown by its https address, as a browser shows it.' };
  let u;
  try { u = new URL(raw); } catch { return { error: 'A web page is shown by its https address, as a browser shows it.' }; }
  if (u.protocol !== 'https:' || !u.hostname) return { error: 'A web page is shown by its https address, as a browser shows it.' };
  if (u.username || u.password) return { error: 'An address with a user name or a password is not shown: show the page without them.' };
  const h = u.hostname;
  // A name's trailing dot (`localhost.`) names the same machine: the URL parser keeps it on a name.
  const b = h.replace(/\.+$/, '');
  const loop = b === 'localhost' || b.endsWith('.localhost') || /^(?:127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b) || b === '[::1]' || b === '[::]' || /^\[::ffff:/.test(b);
  if (u.origin === location.origin || loop) return { error: 'That address is AGMessage itself: show a page of another site.' };
  return { url: u.href, host: h };
}

/**
 * The one frame a page makes (a web page shown to a person, or previewed by the one who shows it): scripts but no forms,
 * popups, top navigation, modal dialogs or downloads (sandbox: owner question 6), no referrer (the hall page's address
 * carries its code and its invite), no feature the page itself may use (`allow`), no cookies of the site's own where
 * the browser offers that (`credentialless`), and a title naming its host. {frame, url, host}, or {error} for an address
 * webAddress refuses.
 */
export function framePage(url) {
  const w = webAddress(url);
  if (w.error) return w;
  const frame = document.createElement('iframe');
  frame.className = 'take-web-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  if ('credentialless' in frame) frame.credentialless = true;
  frame.title = 'Web page from ' + w.host;
  frame.src = w.url;
  return { frame, url: w.url, host: w.host };
}

/**
 * A web page drawn into `box`: a strip in AGMessage's own words (who chose it, its host, and not to type a password), and
 * the page framed under it. 'opened' once the frame loads, or 'failed' when it has not in WEB_WAIT_MS or its address is
 * refused; the frame is left in place either way, so a page that loads late is still seen.
 */
function drawWeb(box, content, ctx) {
  const by = (ctx && ctx.by) || 'someone';
  const made = framePage(content && content.url);
  const w = make('div', 'take-web');
  const note = make('p', 'take-web-note', 'A web page chosen by ' + by + ' (' + (made.host || (content && content.host) || 'no address') + '). Don\'t type passwords here.');
  w.append(note);
  box.append(w);
  if (made.error) return Promise.resolve({ state: 'failed', words: made.error });
  return new Promise((resolve) => {
    let done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => end({ state: 'failed', words: 'the page did not load' }), WEB_WAIT_MS);
    made.frame.addEventListener('load', () => end({ state: 'opened', words: '' }), { once: true });
    w.append(made.frame);
  });
}

/** The live parts under `root` drawn again: each clock and each Stagewatch time, a take's and a card's alike. */
export function tick(root, ctx) {
  if (!root) return;
  for (const n of root.querySelectorAll('[data-live="clock"]')) drawClock(n, ctx);
  for (const n of root.querySelectorAll('[data-live="stage"]')) drawStage(n, ctx);
}

/**
 * The take drawn into `box` (emptied first): what it drew, 'shown', or 'failed' with words. A holding picture that does
 * not load leaves black, never the picture before it.
 */
export function render(box, content, ctx) {
  box.textContent = '';
  const kind = content && content.kind;
  box.dataset.kind = kind || '';
  switch (kind) {
    case 'stage': {
      const s = make('div', 'take-stage');
      s.dataset.live = 'stage';
      s.append(make('div', 'take-time', '--:--'), make('div', 'take-title'), make('div', 'take-next'));
      const message = make('p', 'take-message');
      message.hidden = true;
      s.append(message);
      box.append(s);
      drawStage(s, ctx);
      return Promise.resolve({ state: 'shown', words: '' });
    }
    case 'clock': {
      const c = make('div', 'take-clock');
      c.dataset.live = 'clock';
      const time = make('time', 'take-time');
      c.append(time, make('div', 'take-date'));
      box.append(c);
      drawClock(c, ctx);
      return Promise.resolve({ state: 'shown', words: '' });
    }
    case 'holding': {
      const image = typeof content.image === 'string' && content.image ? content.image : (ctx && typeof ctx.holding === 'string' ? ctx.holding : '');
      if (!image) {
        // No picture of its own and none of the hall's: the AGMessage mark, enlarged, and the hall's name, on black.
        const h = make('div', 'take-holding');
        const mark = make('span', 'brand-mark take-mark', 'AG');
        mark.setAttribute('aria-hidden', 'true');
        h.append(mark, make('div', 'take-hall', (ctx && ctx.hallName) || 'AGMessage'));
        box.append(h);
        return Promise.resolve({ state: 'shown', words: '' });
      }
      // Only a picture AGMessage keeps (/uploads/<name>), as the server allows: anything else draws black and says so.
      if (!/^\/uploads\/[\w.-]+$/.test(image)) return Promise.resolve({ state: 'failed', words: 'the image is not one of this hall\'s' });
      return new Promise((resolve) => {
        const img = make('img', 'take-image');
        img.alt = 'A holding slide';
        img.draggable = false;
        img.addEventListener('load', () => resolve({ state: 'shown', words: '' }), { once: true });
        img.addEventListener('error', () => { img.remove(); resolve({ state: 'failed', words: 'the image did not load' }); }, { once: true });
        img.src = image;
        box.append(img);
      });
    }
    case 'blank':
      return Promise.resolve({ state: 'shown', words: '' });
    case 'web':
      return drawWeb(box, content, ctx);
    default:
      return Promise.resolve({ state: 'failed', words: 'this page cannot show that' });
  }
}

/** The take as a card in the side bar: its icon and name, and what is live in it (the countdown's time, the clock's). */
export function card(content, ctx) {
  const k = kindOf(content) || { icon: '📺', name: 'Shown to you' };
  const c = make('div', 'take-card-what');
  const icon = make('span', 'take-card-icon', k.icon);
  icon.setAttribute('aria-hidden', 'true');
  // A web page's card names its host ("🌍 vote.example.com"), never its address.
  const name = content && content.kind === 'web' && typeof content.host === 'string' && content.host ? content.host : k.name;
  c.append(icon, make('strong', 'take-card-name', name));
  if (content && content.kind === 'stage') {
    const live = make('span', 'take-card-live');
    live.dataset.live = 'stage';
    live.append(make('span', 'take-time', '--:--'));
    c.append(live);
    drawStage(live, ctx);
  } else if (content && content.kind === 'clock') {
    const live = make('span', 'take-card-live');
    live.dataset.live = 'clock';
    live.append(make('time', 'take-time'));
    c.append(live);
    drawClock(live, ctx);
  }
  return c;
}
