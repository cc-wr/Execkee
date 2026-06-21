import config from './config.js';
import { readJsonSafe, atomicWriteJson, snapshotBackup } from './safe-fs.js';

// Atomic write + corruption-preserving read (see safe-fs.js). Previously writeJson was
// a bare non-atomic writeFileSync and readJson silently returned the fallback on a
// parse error — together they could replace a corrupt-but-recoverable store with the
// empty default and persist it (total data loss).
function readJson(path, fallback) {
  return readJsonSafe(path, fallback, path);
}

function writeJson(path, data) {
  atomicWriteJson(path, data);
}

// --- Dashboard Data ---

export function readDashboardData() {
  return readJson(config.DASHBOARD_DATA_FILE, {
    version: 1,
    updatedAt: null,
    updatedBy: null,
    sentence: null,
    standby: true,
    dailyTasks: [],
    presumedTasks: [],
    instanceStatus: [],
    flaggedEvents: [],
    cycleTime: null,
  });
}

export function writeDashboardData(data) {
  data.updatedAt = new Date().toISOString();
  writeJson(config.DASHBOARD_DATA_FILE, data);
}

// --- Sentence Queue ---

export function readSentenceQueue() {
  return readJson(config.SENTENCE_QUEUE_FILE, {
    major: null,
    secondaries: [],
  });
}

export function writeSentenceQueue(queue) {
  writeJson(config.SENTENCE_QUEUE_FILE, queue);
}

// --- Cycle Report ---

export function readCycleReport() {
  return readJson(config.CYCLE_REPORT_FILE, {
    timestamp: null,
    summary: '',
    instanceReports: [],
    sentences: [],
    rawThinking: '',
  });
}

export function writeCycleReport(report) {
  report.timestamp = new Date().toISOString();
  writeJson(config.CYCLE_REPORT_FILE, report);
}

// --- Daily Tasks ---

export function readDailyTasks() {
  return readJson(config.DAILY_TASKS_FILE, {
    date: null,
    tasks: [],
  });
}

export function writeDailyTasks(data) {
  writeJson(config.DAILY_TASKS_FILE, data);
}

// --- Daily plan (today's working list: confirmed backlog + tentative guesses) ---

export function readDailyPlan() {
  return readJson(config.DAILY_PLAN_FILE, { date: null, items: [] });
}

export function writeDailyPlan(data) {
  writeJson(config.DAILY_PLAN_FILE, data);
}

export function readDailyPlanArchive() {
  return readJson(config.DAILY_PLAN_ARCHIVE_FILE, { days: [] });
}

export function writeDailyPlanArchive(data) {
  writeJson(config.DAILY_PLAN_ARCHIVE_FILE, data);
}

// --- Deferrals (topics the user has put on hold; the cycle suppresses related items) ---

export function readDeferrals() {
  return readJson(config.DEFERRALS_FILE, { deferrals: [] });
}

export function writeDeferrals(data) {
  writeJson(config.DEFERRALS_FILE, data);
}

// --- Scheduled guesses (tasks the user wants surfaced as a guess on/after a date) ---

export function readScheduledGuesses() {
  return readJson(config.SCHEDULED_GUESSES_FILE, { items: [] });
}

export function writeScheduledGuesses(data) {
  writeJson(config.SCHEDULED_GUESSES_FILE, data);
}

// --- Resolutions ---

export function readResolutions() {
  return readJson(config.RESOLUTIONS_FILE, { log: [] });
}

export function writeResolutions(data) {
  writeJson(config.RESOLUTIONS_FILE, data);
}

export function logResolution(issueId, message) {
  const data = readResolutions();
  data.log.push({
    issueId,
    message,
    resolvedAt: new Date().toISOString(),
  });
  writeResolutions(data);
}

// --- Life Tasks ---

export function readLifeTasks() {
  return readJson(config.LIFE_TASKS_FILE, { tasks: [] });
}

export function writeLifeTasks(data) {
  // The only programmatic writer (cowork.js promoteToBacklog) ADDS tasks — it never
  // empties the store. So a write that would drop a non-empty store to zero is almost
  // certainly a spurious empty read; refuse it loudly rather than persist the loss.
  // The primary edits tasks.json directly (not through here), so a legitimate "clear
  // all" doesn't hit this path; override with EXECKEE_ALLOW_EMPTY_TASKS=1 if needed.
  const incoming = data && Array.isArray(data.tasks) ? data.tasks.length : 0;
  if (incoming === 0 && process.env.EXECKEE_ALLOW_EMPTY_TASKS !== '1') {
    const cur = readJsonSafe(config.LIFE_TASKS_FILE, { tasks: [] }, config.LIFE_TASKS_FILE);
    if ((cur.tasks || []).length > 0) {
      console.error(`[store] REFUSED to overwrite ${cur.tasks.length} life-task(s) with an empty store (likely a corrupt/empty read). Set EXECKEE_ALLOW_EMPTY_TASKS=1 to force.`);
      return;
    }
  }
  snapshotBackup(config.LIFE_TASKS_FILE);
  writeJson(config.LIFE_TASKS_FILE, data);
}

// --- Issue backlog (dev feedback the primary captures for later code work) ---

export function readIssues() {
  return readJson(config.ISSUES_FILE, { issues: [] });
}

export function writeIssues(data) {
  writeJson(config.ISSUES_FILE, data);
}

export function addIssue(text, area) {
  const data = readIssues();
  const id = `iss-${(data.issues.length + 1)}-${Date.now().toString(36)}`;
  data.issues.push({
    id,
    text,
    area: area || null,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
  writeIssues(data);
  return id;
}

// --- Server State ---

export function readState() {
  return readJson(config.STATE_FILE, {
    updatedAt: null,
    workhorses: {},
  });
}

export function writeState(data) {
  data.updatedAt = new Date().toISOString();
  writeJson(config.STATE_FILE, data);
}
