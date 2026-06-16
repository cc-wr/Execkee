import config from '../common/config.js';
import { Hub } from './hub.js';
import { DashboardServer } from './dashboard.js';
import { snapshotLocal, applyIncoming, readSynced, startWatch } from '../common/settings-sync.js';

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

// Allow an on-demand cycle (POST /api/run-cycle) in addition to the timer.
dashboard.onRunCycle = runCycle;

// Cheap, fork-free refresh of the dashboard's task list from tasks.json
// (POST /api/refresh-tasks) — the primary runs this after any task edit so the
// change shows immediately rather than waiting for the next cycle.
dashboard.onRefreshTasks = async () => {
  const { refreshDashboardTasks } = await import('../cowork.js');
  refreshDashboardTasks();
  dashboard.pushUpdate();
};

// Approve / reject a tentative (LLM-guessed) task. Approval promotes it into the
// backlog (tasks.json) so it persists; both refresh the dashboard.
dashboard.onApproveTask = async ({ id, all }) => {
  const { approveTask, approveAllTentative } = await import('../cowork.js');
  const result = all ? approveAllTentative() : approveTask(id);
  dashboard.pushUpdate();
  return result;
};
dashboard.onRejectTask = async (id) => {
  const { rejectTask } = await import('../cowork.js');
  const result = rejectTask(id);
  dashboard.pushUpdate();
  return result;
};

// Force a fresh tracked-file task guess now (doesn't wait for the daily rollover).
dashboard.onRegenerateGuesses = async () => {
  const { regenerateGuesses } = await import('../cowork.js');
  const result = await regenerateGuesses();
  dashboard.pushUpdate();
  return result;
};

function startCycleTimer() {
  setTimeout(() => {
    runCycle();
    cycleTimer = setInterval(runCycle, config.CYCLE_INTERVAL_MS);
  }, 2000);
  console.log(`[server] Cycle timer started (every ${config.CYCLE_INTERVAL_MS / 60000} minutes, first in 2s)`);
}

startCycleTimer();

// ---- Settings sync (controller side) -------------------------------------
// The controller is both the canonical store/rebroadcaster (in the hub) AND a
// participating node (its own ~/.claude). When a workhorse's change is accepted,
// apply it to the controller's own machine; watch the controller's own edits and
// feed them into the same chokepoint.
let stopSettingsWatch = () => {};
function startSettingsSync() {
  if (!config.SETTINGS_SYNC_ENABLED) { console.log('[server] Settings sync disabled'); return; }
  hub.onSettingsAccepted = ({ name, content }) => applyIncoming({ name, content });

  // Startup reconcile: pull canonical down where it's newer, then push local up
  // where it's newer (ingest no-ops when content already matches).
  for (const [name, rec] of Object.entries(hub.canonicalSettings)) {
    const local = readSynced(name);
    if (!local || rec.mtime > local.mtime) applyIncoming({ name, content: rec.content });
  }
  for (const f of snapshotLocal()) {
    hub.ingestSettings({ ...f, origin: 'controller-local' });
  }

  stopSettingsWatch = startWatch((f) => hub.ingestSettings({ ...f, origin: 'controller-local' }));
  console.log('[server] Settings sync active');
}

startSettingsSync();

function shutdown() {
  console.log('[server] Shutting down...');
  if (cycleTimer) clearInterval(cycleTimer);
  stopSettingsWatch();
  hub.stop();
  dashboard.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[server] Controller ready.');
console.log(`[server] Dashboard: http://localhost:${config.HTTP_PORT}`);
console.log(`[server] WebSocket: ws://localhost:${config.WS_PORT}`);
