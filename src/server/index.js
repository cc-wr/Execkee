import config from '../common/config.js';
import { Hub } from './hub.js';
import { DashboardServer } from './dashboard.js';

console.log('[server] Starting Execkee controller server...');
console.log(`[server] Data directory: ${config.DATA_DIR}`);

const dashboard = new DashboardServer({
  port: config.HTTP_PORT,
  hub: null,
});

const hub = new Hub({
  port: config.WS_PORT,
  onDashboardUpdate: () => dashboard.pushUpdate(),
});

dashboard.hub = hub;

hub.start();
dashboard.start();

let cycleTimer = null;

async function runCycle() {
  console.log(`[server] Running 30-minute cycle at ${new Date().toISOString()}`);
  try {
    const { runCoworkCycle } = await import('../cowork.js');
    await runCoworkCycle(hub);
    dashboard.pushUpdate();
  } catch (err) {
    console.error('[server] Cycle error:', err.message);
  }
}

function startCycleTimer() {
  setTimeout(() => {
    runCycle();
    cycleTimer = setInterval(runCycle, config.CYCLE_INTERVAL_MS);
  }, 2000);
  console.log(`[server] Cycle timer started (every ${config.CYCLE_INTERVAL_MS / 60000} minutes, first in 2s)`);
}

startCycleTimer();

function shutdown() {
  console.log('[server] Shutting down...');
  if (cycleTimer) clearInterval(cycleTimer);
  hub.stop();
  dashboard.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[server] Controller ready.');
console.log(`[server] Dashboard: http://localhost:${config.HTTP_PORT}`);
console.log(`[server] WebSocket: ws://localhost:${config.WS_PORT}`);
