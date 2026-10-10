// Set the saved theme before the page paints (kept out of the HTML so the CSP can forbid inline script).
(function () { try { var t = localStorage.getItem('agm.theme') || 'light'; document.documentElement.dataset.theme = t; document.documentElement.dataset.themePending = '1'; } catch (e) {} })();
