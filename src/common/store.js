import { readFileSync, writeFileSync, existsSync } from 'fs';
import config from './config.js';

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
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
