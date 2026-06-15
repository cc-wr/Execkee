import { homedir, platform } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
// Data dir is overridable so a workhorse can keep its OWN local mirror separate
// from the controller's master — both on a real 2nd machine (its own ~/.execkee)
// and for same-box simulation/co-located workhorse (EXECKEE_DATA_DIR=...).
const DATA_DIR = process.env.EXECKEE_DATA_DIR || join(HOME, '.execkee');
const SHARED_STORE_DIR = join(DATA_DIR, 'shared-store');
const LIFE_TASKS_DIR = join(DATA_DIR, 'life-tasks');

for (const dir of [DATA_DIR, SHARED_STORE_DIR, LIFE_TASKS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export default Object.freeze({
  HOME,
  CLAUDE_DIR,
  DATA_DIR,
  SHARED_STORE_DIR,
  LIFE_TASKS_DIR,
  PLATFORM: platform(),

  TRACKING_FILE: join(DATA_DIR, 'tracking.json'),
  STATE_FILE: join(DATA_DIR, 'state.json'),

  CYCLE_REPORT_FILE: join(SHARED_STORE_DIR, 'cycle-report.json'),
  SENTENCE_QUEUE_FILE: join(SHARED_STORE_DIR, 'sentence-queue.json'),
  DAILY_TASKS_FILE: join(SHARED_STORE_DIR, 'daily-tasks.json'),
  RESOLUTIONS_FILE: join(SHARED_STORE_DIR, 'resolutions.json'),
  DASHBOARD_DATA_FILE: join(SHARED_STORE_DIR, 'dashboard-data.json'),
  LIFE_TASKS_FILE: join(LIFE_TASKS_DIR, 'tasks.json'),
  TRACKING_FILE: join(LIFE_TASKS_DIR, 'TRACKING.md'),
  // Manifest of extra files the cycle synthesis reads as context (a life-tasks
  // .docx, notes, etc.) — { sources: [{ path, label }] }.
  CONTEXT_SOURCES_FILE: join(LIFE_TASKS_DIR, 'context-sources.json'),
  ISSUES_FILE: join(DATA_DIR, 'issues.json'),

  WS_PORT: 7700,
  HTTP_PORT: 7701,

  CYCLE_INTERVAL_MS: 30 * 60 * 1000,
  CRASH_RETRY_MAX: 5,
  CRASH_RETRY_BASE_MS: 2000,
  // Report fork tries the session's own model first; if that fails (e.g. the
  // session's model is unavailable), it falls back to these in order. Haiku is
  // first: it is fast and summarizes fine; sonnet can time out on large sessions.
  REPORT_FALLBACK_MODELS: ['haiku', 'sonnet'],
  REPORT_TIMEOUT_MS: 180_000,
  HEARTBEAT_INTERVAL_MS: Number(process.env.EXECKEE_HEARTBEAT_MS) || 30_000,
  RECONNECT_INTERVAL_MS: 5000,

  WINDOW_TITLE_PREFIX: 'Execkee',
});
