// Join page: create/join a room, persist name+role in localStorage for convenience.

const form = document.getElementById('joinForm');
const nameInput = document.getElementById('name');
const codeInput = document.getElementById('code');
const errorEl = document.getElementById('error');

// Remember last used values
nameInput.value = localStorage.getItem('agm.name') || '';
const savedRole = localStorage.getItem('agm.role');
if (savedRole) {
  const r = document.querySelector(`input[name="role"][value="${savedRole}"]`);
  if (r) r.checked = true;
}

// Prefill code from URL (?code=XXXXXX) for shared join links
const params = new URLSearchParams(location.search);
if (params.get('code')) codeInput.value = params.get('code').toUpperCase();
// Invite links (?code=…&role=board&invite=…) from the admin: pick that role and carry the invite through.
const invite = params.get('invite') || '';
if (invite && params.get('role')) {
  const r = document.querySelector(`input[name="role"][value="${params.get('role').replace(/[^a-z]/g, '')}"]`);
  if (r) r.checked = true;
}

// Uppercase as user types
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// Room creation is admin-only — see /admin

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const name = nameInput.value.trim();
  const role = document.querySelector('input[name="role"]:checked')?.value || 'observer';
  const code = codeInput.value.trim().toUpperCase();
  if (!name) return showError('Please enter your name.');
  if (!code || code.length !== 6) return showError('Meeting code must be 6 characters.');

  // Check room exists
  try {
    const res = await fetch(`/api/rooms/${code}`);
    const data = await res.json();
    if (!data.exists) {
      return showError(res.status === 429 ? 'Too many attempts — wait a minute.' : 'No meeting with that code. Ask the organiser for the code.');
    }
    if (data.locked && role !== 'observer' && !invite) {
      return showError('This meeting uses invite links for the board and research team. Use the link you were sent, or join as an observer.');
    }
  } catch (e) {
    return showError('Network error.');
  }

  localStorage.setItem('agm.name', name);
  localStorage.setItem('agm.role', role);

  const qs = new URLSearchParams({ code, name, role });
  if (invite) qs.set('invite', invite);
  location.href = `/app.html?${qs.toString()}`;
});

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function hideError() {
  errorEl.hidden = true;
}

// ---------------- Theme toggle (light/dark) ----------------
const themeBtn = document.getElementById('themeBtn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  if (themeBtn) {
    themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
    themeBtn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
}
applyTheme(localStorage.getItem('agm.theme') || 'light');
themeBtn?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('agm.theme', next);
  applyTheme(next);
});
