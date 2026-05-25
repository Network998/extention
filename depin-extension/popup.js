const SERVER = 'https://depin-production-69c1.up.railway.app';

let isRunning  = false;
let uptimeStart= null;
let uptimeInt  = null;
let logLines   = [];

// ─── Screen nav ───────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

document.querySelectorAll('.back-btn[data-to]').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.to)));
document.querySelectorAll('.link-btn[data-to]').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.to)));
document.getElementById('btnGoRegister').addEventListener('click', () => showScreen('register'));
document.getElementById('btnGoLogin').addEventListener('click', () => showScreen('login'));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(2) + ' MB';
}
function fmtUptime(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h > 0) return `${h}h ${m%60}m`;
  if (m > 0) return `${m}m ${s%60}s`;
  return `${s}s`;
}
function addLog(msg, cls='') {
  const now = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  logLines.unshift({msg,cls,now});
  if (logLines.length > 6) logLines.pop();
  const el = document.getElementById('d-log');
  if (el) el.innerHTML = logLines.map(l=>`<div class="log-line ${l.cls}">[${l.now}] ${l.msg}</div>`).join('');
}

async function apiPost(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('Server error — coba lagi'); }
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Timeout — coba lagi');
    throw e;
  }
}

function setBtn(id, loading, label) {
  const b = document.getElementById(id);
  if (!b) return;
  b.disabled = loading;
  b.innerHTML = loading ? '<span class="spinner"></span>' : label;
}

// ─── REGISTER (langsung masuk, tanpa OTP) ────────────────────────────────────
document.getElementById('btnRegister').addEventListener('click', async () => {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-pass').value;
  const pass2 = document.getElementById('reg-pass2').value;

  if (!name || !email || !pass) return showError('reg-error', 'Semua field wajib diisi');
  if (pass !== pass2)           return showError('reg-error', 'Password tidak cocok');
  if (pass.length < 6)          return showError('reg-error', 'Password minimal 6 karakter');

  setBtn('btnRegister', true, 'Daftar Sekarang');
  try {
    const r = await apiPost('/api/auth/register', { name, email, password: pass });
    if (r.success) {
      await chrome.storage.local.set({ isLoggedIn: true, userEmail: r.email, userName: r.name });
      populateDashboard(r.name, r.email);
      showScreen('dashboard');
    } else {
      showError('reg-error', r.error || 'Gagal daftar');
    }
  } catch(e) { showError('reg-error', e.message); }
  setBtn('btnRegister', false, 'Daftar Sekarang');
});

// ─── LOGIN (langsung masuk, tanpa OTP) ───────────────────────────────────────
document.getElementById('btnLogin').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;

  if (!email || !pass) return showError('login-error', 'Email dan password wajib diisi');

  setBtn('btnLogin', true, 'Login');
  try {
    const r = await apiPost('/api/auth/login', { email, password: pass });
    if (r.success) {
      await chrome.storage.local.set({ isLoggedIn: true, userEmail: r.email, userName: r.name });
      populateDashboard(r.name, r.email);
      showScreen('dashboard');
    } else {
      showError('login-error', r.error || 'Login gagal');
    }
  } catch(e) { showError('login-error', e.message); }
  setBtn('btnLogin', false, 'Login');
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function populateDashboard(name, email) {
  document.getElementById('d-avatar').textContent = name.slice(0,2).toUpperCase();
  document.getElementById('d-name').textContent   = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById('d-email').textContent  = email;
}

document.getElementById('d-toggle').addEventListener('click', () => toggleNode(!isRunning));

document.getElementById('d-logout').addEventListener('click', async () => {
  if (!confirm('Keluar dari Infly Network?')) return;
  chrome.runtime.sendMessage({ action: 'stop' });
  await chrome.storage.local.clear();
  isRunning = false;
  clearInterval(uptimeInt);
  logLines = [];
  showScreen('welcome');
});

function toggleNode(start) {
  isRunning = start;
  chrome.storage.local.set({ wasRunning: start });
  chrome.runtime.sendMessage({ action: start ? 'start' : 'stop' });

  const pill  = document.getElementById('d-pill');
  const label = document.getElementById('d-pill-label');
  const btn   = document.getElementById('d-toggle');

  if (start) {
    pill.className = 'status-pill'; label.textContent = 'Online';
    btn.className  = 'btn-toggle stop'; btn.textContent = '⏹ Stop Node';
    uptimeStart = Date.now();
    clearInterval(uptimeInt);
    uptimeInt = setInterval(pollDash, 1500);
    addLog('Node dimulai', 'yellow');
    setTimeout(() => addLog('Terhubung ke Infly Network ✓', ''), 1200);
  } else {
    pill.className = 'status-pill off'; label.textContent = 'Offline';
    btn.className  = 'btn-toggle start'; btn.textContent = '▶ Start Node';
    clearInterval(uptimeInt);
    document.getElementById('d-uptime').textContent = '—';
    addLog('Node dihentikan', 'dim');
  }
}

function pollDash() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, res => {
    if (!res) return;
    document.getElementById('d-pts').textContent = res.points || 0;
    document.getElementById('d-bw').textContent  = fmtBytes(res.bytesSent || 0);
    if (res.nodeId) document.getElementById('d-nodeid').textContent = res.nodeId.slice(0,12)+'...';
    if (uptimeStart) document.getElementById('d-uptime').textContent = fmtUptime(Date.now()-uptimeStart);
    chrome.storage.local.get(['status'], d => {
      document.getElementById('d-nodestatus').textContent = d.status==='busy' ? 'Busy' : 'Idle';
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['isLoggedIn','userEmail','userName','wasRunning'], data => {
  if (data.isLoggedIn && data.userEmail) {
    populateDashboard(data.userName || data.userEmail, data.userEmail);
    showScreen('dashboard');
    if (data.wasRunning) toggleNode(true);
  } else {
    showScreen('welcome');
  }
});
