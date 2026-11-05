// The first script of every page with people (a screen's page loads none). It sets the saved theme before the page paints
// (kept out of the HTML so the CSP can forbid inline script), and it holds the page floor: Safari 14.1 (iOS and iPadOS
// 14.5) and Chrome 84, read by a probe that arrived in those versions (WeakRef, with the flex gap the layout needs), never
// by the user agent. Below the floor the page says so in one line and shows nothing else: `data-floor="old"` hides the
// rest (styles.css), every page script stops before it opens a socket or asks the server anything, and no form is sent.
// This file keeps to ES5 (its own lint block), so a browser below the floor still parses it and shows the words.
(function () {
  'use strict';
  var root = document.documentElement;
  var WORDS = 'This browser is too old for AGMessage. Update this device (iPadOS or iOS 14.5, or Chrome 84, or later), or use another.';
  // A theme never chosen is light, but on the hall page (`data-page="app"`, its markup's) last drawn in the Board's simple
  // view, which starts in Dark: so a device last used there paints dark before its first frame. Every other page reads
  // an unset theme as light, whatever view the hall page last drew. Storage that cannot be read is no theme chosen.
  try {
    var theme = localStorage.getItem('agm.theme');
    if (theme !== 'light' && theme !== 'dark') theme = root.getAttribute('data-page') === 'app' && localStorage.getItem('agm.lastView') === 'simple' ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pending', '1');
  } catch (e) { /* storage blocked: the page keeps its light theme, and the simple view turns dark at its join */ }
  if (typeof window.WeakRef === 'function') return;
  root.setAttribute('data-floor', 'old');
  // No form on the page is ever sent below the floor, whether or not the stylesheet that hides it arrived: a form whose
  // script stopped would otherwise go to the page's own address, its fields (a password among them) in the URL. Heard
  // at the window before anything else, so neither the browser nor a page's own handler acts on it.
  window.addEventListener('submit', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
  function say() {
    var line = document.createElement('p');
    line.className = 'agm-floor';
    line.appendChild(document.createTextNode(WORDS));
    document.body.insertBefore(line, document.body.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', say);
  else say();
})();
