const ORCHESTRATOR_URL = 'wss://depin-production-69c1.up.railway.app';

let ws           = null;
let nodeId       = null;
let isRunning    = false;
let points       = 0;
let bytesSent    = 0;
let totalUptime  = 0;
let sessionStart = null;
let reconnectTimer = null;
let activeTasks  = 0;

const MAX_PARALLEL_TASKS = 5;

// ─── URL Safety Check — sama persis dengan validasi di server ─────────────────
function isUrlSafe(urlStr) {
  try {
    const url = new URL(urlStr);
    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const host = url.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return false;

    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [, a, b, c] = ipv4.map(Number);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
      if (a === 0 || a === 127) return false;
      if (a === 100 && b >= 64 && b <= 127) return false;
    }

    const BLOCKED = ['169.254.169.254', 'metadata.google.internal', 'metadata.goog'];
    if (BLOCKED.includes(host)) return false;

    return true;
  } catch {
    return false;
  }
}

// ─── Connect ke Orchestrator ──────────────────────────────────────────────────
async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const data = await chrome.storage.local.get(['userEmail', 'jwtToken']);

  // Harus ada token untuk bisa connect
  if (!data.jwtToken) {
    console.warn('[Infly] Tidak ada JWT token — user belum login');
    updateBadge('OFF', '#ef4444');
    return;
  }

  ws = new WebSocket(ORCHESTRATOR_URL);

  ws.onopen = () => {
    clearTimeout(reconnectTimer);
    sessionStart = Date.now();
    // Kirim JWT token saat register — server akan verifikasi
    ws.send(JSON.stringify({
      type:  'register',
      token: data.jwtToken,
    }));
    updateBadge('ON', '#22c55e');
  };

  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }

    switch(msg.type) {
      case 'connected':
        nodeId = msg.nodeId;
        await chrome.storage.local.set({ nodeId, status: 'connected' });
        break;

      case 'registered':
        points      = msg.totalPoints || 0;
        totalUptime = msg.totalUptime || 0;
        await chrome.storage.local.set({ status: 'idle', points, totalUptime });
        console.log(`[Infly] Registered: ${msg.email} | pts: ${points}`);
        break;

      case 'uptime_reward':
        points      = msg.totalPoints || points;
        totalUptime = msg.uptime      || totalUptime;
        await chrome.storage.local.set({ points, totalUptime });
        console.log(`[Infly] Uptime reward: +${msg.points}pts | total: ${points}`);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        break;

      case 'error':
        // Server tolak koneksi (token invalid, user tidak ada, dll)
        console.error('[Infly] Server error:', msg.error);
        if (msg.error?.includes('Token') || msg.error?.includes('User')) {
          // Token kadaluarsa — minta user login ulang
          isRunning = false;
          await chrome.storage.local.set({ wasRunning: false, jwtToken: null, status: 'auth_error' });
          updateBadge('ERR', '#ef4444');
        }
        break;

      case 'task':
        if (activeTasks >= MAX_PARALLEL_TASKS) {
          ws.send(JSON.stringify({ type: 'task_error', taskId: msg.taskId, error: 'Node busy: max parallel tasks reached' }));
          return;
        }
        // Validasi URL sebelum fetch — double-check di sisi client
        if (!isUrlSafe(msg.url)) {
          ws.send(JSON.stringify({ type: 'task_error', taskId: msg.taskId, error: 'URL tidak aman — ditolak oleh node' }));
          console.warn('[Infly] URL tidak aman ditolak:', msg.url);
          return;
        }
        handleTask(msg);
        break;
    }
  };

  ws.onclose = () => {
    updateBadge('OFF', '#ef4444');
    if (isRunning) reconnectTimer = setTimeout(connect, 5000);
  };

  ws.onerror = (err) => console.error('[Infly] WS Error:', err);
}

// ─── Handle Task ──────────────────────────────────────────────────────────────
async function handleTask(task) {
  const { taskId, url, method = 'GET', headers = {} } = task;
  activeTasks++;

  if (activeTasks >= MAX_PARALLEL_TASKS)
    await chrome.storage.local.set({ status: 'busy' });

  // Filter header yang masuk — hanya izinkan header aman
  const SAFE_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'referer'];
  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SAFE_HEADERS.includes(k.toLowerCase()) && typeof v === 'string')
      safeHeaders[k] = v.slice(0, 512);
  }

  console.log(`[Infly] Task [${activeTasks}/${MAX_PARALLEL_TASKS}]: ${method} ${url}`);

  try {
    const response = await fetch(url, {
      method: ['GET','POST','HEAD'].includes(method) ? method : 'GET',
      headers: safeHeaders,
      signal: AbortSignal.timeout(15000),
    });
    const text  = await response.text();
    const bytes = new TextEncoder().encode(text).length;

    bytesSent += bytes;
    const earned = Math.ceil(bytes / 1024);
    points      += earned;

    await chrome.storage.local.set({ points, bytesSent });

    ws.send(JSON.stringify({
      type:   'task_result',
      taskId,
      url,
      status: response.status,
      data:   text.slice(0, 5000),
      bytes,
    }));

    console.log(`[Infly] Task done: ${bytes}B | +${earned}pts`);
  } catch(err) {
    ws.send(JSON.stringify({ type: 'task_error', taskId, error: err.message }));
    console.error('[Infly] Task error:', err.message);
  }

  activeTasks--;
  if (activeTasks === 0)
    await chrome.storage.local.set({ status: 'idle' });
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    isRunning = true;
    chrome.storage.local.set({ wasRunning: true });
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    isRunning = false;
    chrome.storage.local.set({ wasRunning: false });
    if (ws) ws.close();
    updateBadge('', '#6b7280');
    sendResponse({ ok: true });
  } else if (msg.action === 'getStatus') {
    const sessionUptime = sessionStart ? Date.now() - sessionStart : 0;
    sendResponse({
      nodeId,
      isRunning,
      points,
      bytesSent,
      activeTasks,
      totalUptime: totalUptime + sessionUptime,
      connected: ws?.readyState === WebSocket.OPEN,
    });
  } else if (msg.action === 'tokenUpdated') {
    // Dipanggil popup.js setelah login/register berhasil
    if (isRunning && ws) ws.close(); // reconnect dengan token baru
    if (isRunning) connect();
    sendResponse({ ok: true });
  }
  return true;
});

// ─── Auto-start ───────────────────────────────────────────────────────────────
chrome.storage.local.get(['wasRunning', 'points', 'totalUptime', 'jwtToken'], (data) => {
  points      = data.points      || 0;
  totalUptime = data.totalUptime || 0;
  // Hanya auto-start kalau ada token
  if (data.wasRunning && data.jwtToken) {
    isRunning = true;
    connect();
  }
});
