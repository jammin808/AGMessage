// Shared by the account pages (sign-in, halls, accounts): escaping, JSON calls, toasts, the theme. One global, AGM.
// Every value shown as HTML goes through AGM.esc (the lint fence agm/no-unescaped-html holds the pages to it).
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** A JSON call to this server: {ok, …} or {ok:false, error}; never throws. */
  async function api(method, url, body) {
    try {
      const r = await fetch(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let j;
      try { j = await r.json(); } catch { j = null; }   // not JSON: the status words below
      if (j && typeof j === 'object') return { status: r.status, ...j };
      return { ok: false, status: r.status, error: r.status === 429 ? 'Too many attempts — wait a few minutes.' : 'The server answered ' + r.status + '.' };
    } catch {
      return { ok: false, status: 0, error: 'Can\'t reach AGMessage — check the network.' };
    }
  }

  /** A toast that never blocks: the words, and whether it is a problem. */
  function toast(text, bad) {
    let box = document.getElementById('agmToast');
    if (!box) { box = document.createElement('div'); box.id = 'agmToast'; box.className = 'agm-toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    box.textContent = text;
    box.classList.toggle('bad', !!bad);
    box.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => box.classList.remove('show'), bad ? 6000 : 3500);
  }

  function theme() {
    const btn = document.getElementById('themeBtn');
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      if (btn) { btn.textContent = t === 'dark' ? '☀️' : '🌙'; btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
    };
    let saved = 'light';
    try { saved = localStorage.getItem('agm.theme') || 'light'; } catch { /* storage blocked: light */ }
    apply(saved);
    if (btn) btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('agm.theme', next); } catch { /* storage blocked: this page only */ }
      apply(next);
    });
  }

  /** "2 min ago" for a time in ms. */
  function ago(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(at).toLocaleDateString();
  }

  /** mm:ss or h:mm:ss for seconds, with a sign for overtime. */
  function clock(sec) {
    if (!Number.isFinite(sec)) return '--:--';
    const neg = sec < 0;
    let s = Math.abs(Math.round(sec));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const body = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
    return (neg ? '+' : '') + body;
  }

  window.AGM = { esc, api, toast, theme, ago, clock };
})();
