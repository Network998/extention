// ─── Config ───────────────────────────────────────────────────────────────────
// Ganti dengan URL server kamu setelah deploy
const ORCHESTRATOR_URL = 'wss://depin-production-69c1.up.railway.app';

// ─── State ────────────────────────────────────────────────────────────────────
let ws = null;
let nodeId = null;
let isRunning = false;
let points = 0;
let bytesSent = 0;
let reconnectTimer = null;

// ─── Connect ke Orchestrator ─────────────────────────────────────────────────
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log('[DePIN] Connecting to orchestrator...');
  ws = new WebSocket(ORCHESTRATOR_URL);

  ws.onopen = async () => {
    console.log('[DePIN] Connected!');
    clearTimeout(reconnectTimer);

    // Ambil wallet address dari storage
    const data = await chrome.storage.local.get(['walletAddress']);
    const wallet = data.walletAddress || 'anon-' + Math.random().toString(36).slice(2, 8);

    // Register node
    ws.send(JSON.stringify({ type: 'register', walletAddress: wallet }));
    updateBadge('ON', '#22c55e');
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {

      case 'connected':
        nodeId = msg.nodeId;
        await chrome.storage.local.set({ nodeId, status: 'connected' });
        break;

      case 'registered':
        console.log('[DePIN] Registered as', msg.wallet);
        await chrome.storage.local.set({ status: 'idle', wallet: msg.wallet });
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'task':
        await handleTask(msg);
        break;
    }
  };

  ws.onclose = () => {
    console.log('[DePIN] Disconnected. Reconnecting in 5s...');
    updateBadge('OFF', '#ef4444');
    if (isRunning) {
      reconnectTimer = setTimeout(connect, 5000);
    }
  };

  ws.onerror = (err) => {
    console.error('[DePIN] WS Error:', err);
  };
}

// ─── Handle Task dari Orchestrator ───────────────────────────────────────────
async function handleTask(task) {
  const { taskId, url, method = 'GET', headers = {} } = task;
  console.log(`[DePIN] Task received: ${method} ${url}`);

  await chrome.storage.local.set({ status: 'busy' });

  try {
    const response = await fetch(url, { method, headers });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).length;

    // Update local stats
    bytesSent += bytes;
    const earnedPoints = Math.ceil(bytes / 1024);
    points += earnedPoints;
    await chrome.storage.local.set({ points, bytesSent });

    ws.send(JSON.stringify({
      type: 'task_result',
      taskId,
      url,
      status: response.status,
      data: text.slice(0, 5000), // Kirim max 5KB data
      bytes,
    }));

    console.log(`[DePIN] Task done: ${bytes} bytes | +${earnedPoints} pts`);
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'task_error',
      taskId,
      error: err.message,
    }));
    console.error('[DePIN] Task error:', err);
  }

  await chrome.storage.local.set({ status: 'idle' });
}

// ─── Badge ────────────────────────────────────────────────────────────────────
function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Message dari Popup ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    isRunning = true;
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    isRunning = false;
    if (ws) ws.close();
    updateBadge('', '#6b7280');
    sendResponse({ ok: true });
  } else if (msg.action === 'getStatus') {
    sendResponse({
      nodeId,
      isRunning,
      points,
      bytesSent,
      connected: ws?.readyState === WebSocket.OPEN,
    });
  }
  return true;
});

// Auto-start jika sebelumnya aktif
chrome.storage.local.get(['wasRunning'], (data) => {
  if (data.wasRunning) {
    isRunning = true;
    connect();
  }
});
