import { claudeRun } from './common/exec-async.js';
import { readTracking, writeTracking, updateInstance } from './common/tracking.js';
import {
  readDashboardData, writeDashboardData,
  readSentenceQueue, writeSentenceQueue,
  readCycleReport, writeCycleReport,
  readDailyTasks, writeDailyTasks,
  readLifeTasks, writeLifeTasks,
  readResolutions, writeResolutions,
  readDailyPlan, writeDailyPlan,
  readDailyPlanArchive, writeDailyPlanArchive,
  readDeferrals, writeDeferrals,
} from './common/store.js';
import { DESIRED_STATE, VISIBILITY, CMD } from './common/protocol.js';
import { readContextSources } from './common/context-sources.js';
import config from './common/config.js';

export async function runCoworkCycle(hub) {
  const now = new Date();
  const today = localDateStr(now);          // B3: roll over at LOCAL midnight
  console.log(`[cowork] === Cycle start: ${now.toISOString()} (day ${today}) ===`);

  const cycleTime = now.toISOString();

  // Step 1: Build today's plan. On a local-date rollover this archives yesterday's
  // completed items, carries forward incomplete confirmed ones, and re-guesses a
  // tentative task list from the tracked files (once per day).
  const tracking = readTracking();
  const instances = Object.values(tracking.instances);
  const lifeTasks = readLifeTasks();
  const contextSources = readContextSources();
  const plan = await buildDailyPlan({ today, lifeTasks, instances, contextBlock: contextSources });
  // Confirmed-only view drives the sentence synthesis + the legacy daily-tasks store.
  const dailyTasks = { date: plan.date, tasks: plan.items.filter(i => !i.tentative) };
  writeDailyTasks(dailyTasks);

  // Step 2: Collect reports from recently-active hidden instances
  const instanceReports = [];

  for (const inst of instances) {
    if (inst.desiredState !== DESIRED_STATE.ALIVE) continue;

    let report = null;
    if (inst.visibility === VISIBILITY.FOREGROUND) {
      // The user holds it — never fork (visibility = lock), but its last known
      // report (and its pending action items) is still current context.
      console.log(`[cowork] ${inst.id} foregrounded — using last report if any`);
      report = inst.lastReportContent || null;
    } else if (hub) {
      console.log(`[cowork] Requesting report for ${inst.id}...`);
      const result = await hub.sendCommand(inst.workhorseId, CMD.REPORT, { instanceId: inst.id });
      if (result?.success) {
        report = result.report;
      } else {
        // Unchanged (skipped) or a failed fork — fall back to the latest stored
        // report so pending items keep surfacing instead of disappearing.
        if (result?.skipped) console.log(`[cowork] ${inst.id} unchanged — using last report`);
        else console.log(`[cowork] Report failed for ${inst.id}: ${result?.error} — using last report`);
        report = inst.lastReportContent || null;
      }
    }

    if (report) {
      instanceReports.push({ instanceId: inst.id, name: inst.name, report, timestamp: cycleTime });
    }
  }

  // Step 3: Reconcile resolutions (extra context already read in Step 1)
  const resolutions = readResolutions();
  const previousQueue = readSentenceQueue();

  // Step 4 + 5: Author cycle report and derive sentence queue
  const cycleReport = await authorCycleReport({
    cycleTime,
    today,
    dailyTasks,
    instanceReports,
    resolutions,
    previousQueue,
    tracking,
    contextSources,
    deferrals: activeDeferrals(today),
  });
  writeCycleReport(cycleReport);

  const sentenceQueue = {
    major: cycleReport.sentences?.[0] || null,
    secondaries: (cycleReport.sentences || []).slice(1),
  };
  writeSentenceQueue(sentenceQueue);

  // Step 6: Rebuild dashboard data
  const dashboardData = {
    version: 1,
    updatedBy: 'cowork',
    sentence: sentenceQueue.major
      ? { id: sentenceQueue.major.id, text: sentenceQueue.major.text, priority: 1 }
      : null,
    standby: !sentenceQueue.major,
    dailyTasks: planTodayItems(plan.items),
    coverageTasks: planHorizonCoverage(plan.items),
    presumedTasks: await filterDeferredPresumed(cycleReport.presumedTasks || [], today),
    instanceStatus: instances
      .filter(i => i.desiredState === DESIRED_STATE.ALIVE)
      .map(i => ({
        id: i.id,
        name: i.name,
        workhorse: i.workhorseId,
        visibility: i.visibility,
        lastActivity: i.lastActivityTime,
        lastReport: i.lastReportTime,
        reportFailing: (i.reportFailureCount || 0) >= 2,
      })),
    flaggedEvents: collectFlaggedEvents(tracking),
    cycleTime,
  };
  writeDashboardData(dashboardData);

  // Step 7: Clear reconciled resolutions
  const freshResolutions = readResolutions();
  const reconciledIds = new Set(
    (cycleReport.sentences || []).map(s => s.id)
  );
  freshResolutions.log = freshResolutions.log.filter(
    r => reconciledIds.has(r.issueId)
  );
  writeResolutions(freshResolutions);

  console.log(`[cowork] === Cycle complete: ${new Date().toISOString()} ===`);
  console.log(`[cowork] Sentence: ${sentenceQueue.major?.text || 'Stand by.'}`);
}

// ---- Daily plan: today's working list (confirmed backlog + tentative guesses) ----

// Local calendar date (YYYY-MM-DD) so the daily reset rolls over at LOCAL midnight.
function localDateStr(d = new Date()) {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
}

function normText(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// A3: match a task to a managed instance BY NAME — exact substring, or all the
// significant words of the instance name appearing in the task text.
function matchInstance(text, instanceNames) {
  const t = normText(text);
  if (!t) return null;
  for (const name of instanceNames) {
    const n = normText(name);
    if (!n) continue;
    if (t.includes(n)) return name;
    const words = n.split(' ').filter(w => w.length > 3);
    if (words.length && words.every(w => t.includes(w))) return name;
  }
  return null;
}

function computeStatus(task, today) {
  if (task.completedAt) return 'complete';
  if (task.due && task.due < today) return 'overdue';
  if (task.due === today) return 'due-today';
  return 'pending';
}

function sortPlanItems(items) {
  const statusOrder = { overdue: 0, 'due-today': 1, pending: 2, complete: 3 };
  const prioOrder = { high: 0, normal: 1, low: 2 };
  return items.slice().sort((a, b) => {
    if (!!a.tentative !== !!b.tentative) return a.tentative ? 1 : -1; // tentative last
    const sd = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2);
    if (sd !== 0) return sd;
    return (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1);
  });
}

// Backlog (tasks.json) → today's confirmed plan items: every incomplete task, plus
// any completed TODAY (so the donut shows the day's progress; older completions drop
// off — the daily reset). Each tagged with its by-name instance match.
function backlogToPlanItems(lifeTasks, today, instanceNames) {
  return (lifeTasks.tasks || [])
    .filter(t => !t.completedAt || String(t.completedAt).slice(0, 10) === today)
    .map(t => ({
      id: t.id,
      text: t.text,
      due: t.due || null,
      priority: t.priority || 'normal',
      status: computeStatus(t, today),
      source: 'backlog',
      tentative: false,
      instance: matchInstance(t.text, instanceNames),
      complete: !!t.completedAt,
      inProgress: !!t.inProgress && !t.completedAt,
    }));
}

// On a date rollover, snapshot the prior day's completed items into the archive
// (kept in history per A2; tasks.json also retains completedAt).
function archiveCompleted(prevPlan) {
  if (!prevPlan || !prevPlan.date || !(prevPlan.items || []).length) return;
  const done = prevPlan.items.filter(i => i.complete);
  if (!done.length) return;
  const archive = readDailyPlanArchive();
  archive.days = archive.days || [];
  archive.days.push({ date: prevPlan.date, archivedAt: new Date().toISOString(), items: done });
  if (archive.days.length > 120) archive.days = archive.days.slice(-120);
  writeDailyPlanArchive(archive);
}

// LLM guess at today's tasks from the tracked files (TRACKING.md + context sources).
// Marked tentative; the user approves via the primary. Best-effort — a failure
// yields no guesses, never throws (it must not break the cycle).
async function guessTasksFromTrackedFiles({ contextBlock, today }) {
  if (!contextBlock || !contextBlock.trim()) return [];
  const prompt = [
    "Infer the user's tasks from their tracked files below — the FULL horizon you can",
    'support (everything the files imply still needs doing), not just today. These are',
    'GUESSES the user will review and approve — be concrete and conservative; propose only',
    'work the files actually support, and do NOT restate routine/standing notes.',
    'Set "today": true ONLY for tasks realistically achievable today (a small, sensible',
    "day's worth); set false for the rest of the horizon.",
    'Output ONLY valid JSON: {"tasks":[{"text":"...","due":null,"priority":"normal","today":false}]}',
    '(up to ~25 items, no commentary).',
    '',
    '=== TRACKED FILES ===',
    contextBlock,
  ].join('\n');
  try {
    const output = await claudeRun(['-p', '--output-format', 'json', prompt]);
    const parsed = parseSynthesis(output);
    const list = (parsed && parsed.tasks) || [];
    return list.map((t, i) => ({
      id: `guess-${today}-${i}`,
      text: String(t.text || '').trim(),
      due: t.due || null,
      priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
      status: 'pending',
      source: 'guess',
      tentative: true,
      today: !!t.today,
      instance: null,
      complete: false,
      inProgress: false,
    })).filter(t => t.text);
  } catch (err) {
    console.error('[cowork] tracked-file task guess failed:', err.message);
    return [];
  }
}

// Build today's plan. Re-guesses tentative tasks on a date rollover (once/day);
// otherwise preserves the existing guesses and their approval state.
async function buildDailyPlan({ today, lifeTasks, instances, contextBlock, forceGuess = false }) {
  const prev = readDailyPlan();
  const rollover = prev.date !== today;
  if (rollover) archiveCompleted(prev);
  const instanceNames = instances
    .filter(i => i.desiredState === DESIRED_STATE.ALIVE)
    .map(i => i.name).filter(Boolean);

  const backlogItems = backlogToPlanItems(lifeTasks, today, instanceNames);

  // Re-ask the model on a date rollover (once/day) or an explicit forced regen;
  // otherwise keep the day's existing guesses (and their approval state).
  let guesses;
  if (rollover || forceGuess) {
    guesses = await guessTasksFromTrackedFiles({ contextBlock, today });
  } else {
    guesses = (prev.items || []).filter(i => i.source === 'guess');
  }
  const backlogTexts = new Set(backlogItems.map(i => normText(i.text)));
  guesses = guesses
    .map(g => ({ ...g, instance: matchInstance(g.text, instanceNames) }))
    .filter(g => g.text && !backlogTexts.has(normText(g.text)));

  const plan = { date: today, items: sortPlanItems([...backlogItems, ...guesses]) };
  writeDailyPlan(plan);
  return plan;
}

// Fork-free rebuild (instant task refresh + approval mutations): refresh the backlog
// portion + statuses, preserve existing guesses (no re-guess), re-match instances.
function rebuildPlanSync(today, instances) {
  const lifeTasks = readLifeTasks();
  const instanceNames = instances
    .filter(i => i.desiredState === DESIRED_STATE.ALIVE)
    .map(i => i.name).filter(Boolean);
  const prev = readDailyPlan();
  const backlogItems = backlogToPlanItems(lifeTasks, today, instanceNames);
  let guesses = prev.date === today ? (prev.items || []).filter(i => i.source === 'guess') : [];
  const backlogTexts = new Set(backlogItems.map(i => normText(i.text)));
  guesses = guesses
    .map(g => ({ ...g, instance: matchInstance(g.text, instanceNames) }))
    .filter(g => g.text && !backlogTexts.has(normText(g.text)));
  const plan = { date: today, items: sortPlanItems([...backlogItems, ...guesses]) };
  writeDailyPlan(plan);
  return plan;
}

// "Your Tasks" = confirmed backlog + today's tentative slice (a day's worth).
// "Tracked · no instance" = the REST of the guessed horizon with no instance — the
// full inferred backlog beyond today. Disjoint by the `today` flag, so no repeats.
function planTodayItems(items) { return items.filter(i => i.source !== 'guess' || i.today); }
function planHorizonCoverage(items) { return items.filter(i => i.source === 'guess' && !i.today && !i.instance); }

function writePlanToDashboard(plan) {
  const data = readDashboardData();
  data.dailyTasks = planTodayItems(plan.items);
  data.coverageTasks = planHorizonCoverage(plan.items);
  data.updatedBy = 'task-refresh';
  writeDashboardData(data);
}

// B2: approving a tentative guess promotes it into the backlog (tasks.json) so it
// persists and carries forward — the primary-approval is the human gate that lets
// the (now-approved) item into the durable list.
function promoteToBacklog(items) {
  const life = readLifeTasks();
  life.tasks = life.tasks || [];
  const existing = new Set(life.tasks.map(t => normText(t.text)));
  let n = 0;
  for (const it of items) {
    if (existing.has(normText(it.text))) continue;
    life.tasks.push({ id: `t-${Date.now().toString(36)}-${n++}`, text: it.text, due: it.due || null, priority: it.priority || 'normal' });
    existing.add(normText(it.text));
  }
  writeLifeTasks(life);
}

export function approveTask(id) {
  const today = localDateStr();
  const plan = readDailyPlan();
  const item = (plan.items || []).find(i => i.id === id && i.tentative);
  if (!item) return { success: false, error: `No tentative task with id ${id}` };
  promoteToBacklog([item]);
  const p = rebuildPlanSync(today, Object.values(readTracking().instances));
  writePlanToDashboard(p);
  return { success: true, promoted: item.text };
}

export function approveAllTentative() {
  const today = localDateStr();
  const plan = readDailyPlan();
  const tentatives = (plan.items || []).filter(i => i.tentative);
  if (!tentatives.length) return { success: true, approved: 0 };
  promoteToBacklog(tentatives);
  const p = rebuildPlanSync(today, Object.values(readTracking().instances));
  writePlanToDashboard(p);
  return { success: true, approved: tentatives.length };
}

export function rejectTask(id) {
  const today = localDateStr();
  const plan = readDailyPlan();
  const before = (plan.items || []).length;
  plan.items = (plan.items || []).filter(i => !(i.id === id && i.tentative));
  if (plan.items.length === before) return { success: false, error: `No tentative task with id ${id}` };
  writeDailyPlan(plan);
  const p = rebuildPlanSync(today, Object.values(readTracking().instances));
  writePlanToDashboard(p);
  return { success: true };
}

// Cheap, fork-free dashboard refresh for task edits: rebuild today's plan from the
// current backlog (+ persisted guesses) and update the dashboard at once. No Claude
// synthesis, so a task change shows immediately instead of waiting for the cycle.
export function refreshDashboardTasks() {
  const today = localDateStr();
  const plan = rebuildPlanSync(today, Object.values(readTracking().instances));
  writePlanToDashboard(plan);
  return plan.items.length;
}

// ---- Deferrals: topics the user has put on hold; suppress related surfaced items ----

// Deferrals still in effect today (no end date, or an end date that hasn't passed).
function activeDeferrals(today) {
  const { deferrals } = readDeferrals();
  return (deferrals || []).filter(d => d && d.topic && (!d.until || d.until >= today));
}

// Does this text relate to a deferred topic? Substring, or all the topic's
// significant words appearing in the text (same by-name discipline as matchInstance).
function isDeferred(text, defs) {
  const t = normText(text);
  if (!t) return false;
  for (const d of defs) {
    const topic = normText(d.topic);
    if (!topic) continue;
    if (t.includes(topic)) return true;
    const words = topic.split(' ').filter(w => w.length > 3);
    if (words.length && words.every(w => t.includes(w))) return true;
  }
  return false;
}

// LLM relatedness check (rigorous): one batched fork judges, by MEANING, which
// candidate items relate to a deferred topic. Returns a Set of ids to suppress, or
// null to signal "fall back to the text match" (call failed / unparseable).
async function llmDeferralSuppress(items, defs) {
  const prompt = [
    'The user has DEFERRED these topics (put them on hold):',
    ...defs.map(d => `- ${d.topic}${d.until ? ` (until ${d.until})` : ''}`),
    '',
    'Candidate action items (id: text):',
    ...items.map(p => `- ${p.id}: ${p.text}`),
    '',
    'For EACH candidate, decide whether it is about / related to any deferred topic —',
    'the same subject, project, person, deliverable, or obligation the user put on hold.',
    'Judge by MEANING, not shared words (a paraphrase still counts; an unrelated item',
    'that happens to share a word does NOT). Output ONLY JSON: {"suppress":["id",...]}',
    'listing the ids to HIDE because they relate to a deferred topic. If none, {"suppress":[]}.',
  ].join('\n');
  try {
    const parsed = parseSynthesis(await claudeRun(['-p', '--output-format', 'json', prompt]));
    if (!parsed || !Array.isArray(parsed.suppress)) return null;
    return new Set(parsed.suppress.map(String));
  } catch (err) {
    console.error('[cowork] LLM deferral check failed:', err.message);
    return null;
  }
}

// Drop presumed tasks that relate to an active deferral. LLM-first (semantic), with
// the text match (isDeferred) only as a fallback when the model call is unavailable.
// Applied to BOTH the LLM and fallback presumed-task sets so deferred items leave the
// panel for sure.
async function filterDeferredPresumed(presumed, today) {
  const list = presumed || [];
  const defs = activeDeferrals(today);
  if (!defs.length || !list.length) return list;
  const suppress = await llmDeferralSuppress(list, defs);
  if (suppress) return list.filter(p => !suppress.has(String(p.id)));
  // Model unavailable/unparseable — best-effort text match so suppression still happens.
  return list.filter(p => !isDeferred(p.text, defs));
}

export async function addDeferral(topic, until) {
  topic = String(topic || '').trim();
  if (!topic) return { success: false, error: 'empty topic' };
  const data = readDeferrals();
  data.deferrals = data.deferrals || [];
  const id = `def-${Date.now().toString(36)}`;
  data.deferrals.push({ id, topic, until: until || null, createdAt: new Date().toISOString() });
  writeDeferrals(data);
  // Drop now-deferred presumed tasks from the dashboard immediately (don't wait a cycle).
  const today = localDateStr();
  const dash = readDashboardData();
  dash.presumedTasks = await filterDeferredPresumed(dash.presumedTasks, today);
  writeDashboardData(dash);
  return { success: true, id, topic, until: until || null };
}

export function removeDeferral(idOrTopic) {
  const key = normText(idOrTopic);
  const data = readDeferrals();
  const before = (data.deferrals || []).length;
  data.deferrals = (data.deferrals || []).filter(d => d.id !== idOrTopic && normText(d.topic) !== key);
  writeDeferrals(data);
  // Removed items reappear on the next cycle (we don't have them to restore now).
  return { success: data.deferrals.length < before };
}

export function listDeferrals() {
  return readDeferrals().deferrals || [];
}

// Force a fresh tentative-task guess from the tracked files NOW, without waiting for
// the daily (midnight) rollover. Runs the LLM guesser and replaces the day's guesses;
// does NOT archive (it's still the same day). Used by the `regenerate-guesses`
// command / when the user asks to re-guess.
export async function regenerateGuesses() {
  const today = localDateStr();
  const instances = Object.values(readTracking().instances);
  const lifeTasks = readLifeTasks();
  const contextBlock = readContextSources();
  const plan = await buildDailyPlan({ today, lifeTasks, instances, contextBlock, forceGuess: true });
  writePlanToDashboard(plan);
  return { success: true, guesses: plan.items.filter(i => i.source === 'guess').length };
}

async function authorCycleReport({ cycleTime, today, dailyTasks, instanceReports, resolutions, previousQueue, tracking, contextSources, deferrals }) {
  const overdueTasks = dailyTasks.tasks.filter(t => t.status === 'overdue');
  const dueTodayTasks = dailyTasks.tasks.filter(t => t.status === 'due-today');
  const incompleteTasks = dailyTasks.tasks.filter(t => !t.complete);
  const failedInstances = Object.values(tracking.instances).filter(i => i.desiredState === DESIRED_STATE.FAILED);

  const prompt = buildCyclePrompt({
    cycleTime,
    today,
    overdueTasks,
    dueTodayTasks,
    incompleteTasks,
    instanceReports,
    failedInstances,
    recentResolutions: resolutions.log.slice(-10),
    contextSources,
    deferrals,
  });

  try {
    const output = await claudeRun(['-p', '--output-format', 'json', prompt]);
    const parsed = parseSynthesis(output);

    // If the synthesis produced nothing usable, fall back to the deterministic
    // task-based report so an overdue/failed item still surfaces a sentence.
    if (!parsed || (!parsed.summary && !(parsed.sentences || []).length)) {
      console.error('[cowork] Synthesis empty/unparseable — using fallback report');
      return buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances, dailyTasks });
    }

    return {
      timestamp: cycleTime,
      summary: parsed.summary || '',
      instanceReports,
      sentences: (parsed.sentences || []).map((s, i) => ({
        id: s.id || `issue-${Date.now()}-${i}`,
        text: s.text,
        priority: s.priority || i + 1,
        source: 'cycle-report',
      })),
      presumedTasks: dedupePresumedTasks(
        (parsed.presumedTasks || []).map((t, i) => ({
          id: t.id || `presumed-${i}`,
          instance: t.instance || '',
          text: t.text,
          due: t.due || null,
          urgency: t.urgency || 'normal',
        })).filter(t => t.text),
        dailyTasks.tasks
      ),
      rawThinking: parsed.thinking || '',
    };
  } catch (err) {
    console.error('[cowork] Claude synthesis failed:', err.message);
    return buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances, dailyTasks });
  }
}

// `claude -p --output-format json` emits an array of event objects; the model's
// answer is the `result` field of the final `type:"result"` event. Extract it,
// then parse the answer as JSON (tolerating ```json fences / surrounding prose).
function parseSynthesis(output) {
  let resultText = output;
  try {
    const events = JSON.parse(output);
    const arr = Array.isArray(events) ? events : [events];
    const resultEvent = arr.findLast(e => e && e.type === 'result');
    if (resultEvent && typeof resultEvent.result === 'string') resultText = resultEvent.result;
  } catch {
    // not the events array — treat output as the raw answer text
  }
  if (!resultText) return null;
  let t = String(resultText).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const brace = t.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch {} }
  return null;
}

function buildCyclePrompt({ cycleTime, today, overdueTasks, dueTodayTasks, incompleteTasks, instanceReports, failedInstances, recentResolutions, contextSources, deferrals }) {
  const sections = [];

  sections.push(`Current time: ${cycleTime}. Today: ${today}.`);

  if (overdueTasks.length > 0) {
    sections.push(`OVERDUE TASKS:\n${overdueTasks.map(t => `- ${t.text} (due: ${t.due})`).join('\n')}`);
  }
  if (dueTodayTasks.length > 0) {
    sections.push(`DUE TODAY:\n${dueTodayTasks.map(t => `- ${t.text}`).join('\n')}`);
  }
  if (incompleteTasks.length > 0) {
    sections.push(`ALL INCOMPLETE (${incompleteTasks.length}):\n${incompleteTasks.slice(0, 20).map(t => `- ${t.text} (${t.priority}, ${t.status})`).join('\n')}`);
  }
  if (instanceReports.length > 0) {
    const fmt = (r) => {
      const rep = r.report || {};
      const lines = [`[${r.name}] topic: ${rep.topic || '(unknown)'}`];
      const list = (label, arr) => {
        if (Array.isArray(arr) && arr.length) lines.push(`  ${label}:\n${arr.map(x => `    - ${x}`).join('\n')}`);
      };
      // NEEDS ATTENTION / BLOCKED / IN PROGRESS are the real, often time-sensitive
      // action items — surface them, not just the (sometimes rosy) summary.
      list('NEEDS ATTENTION', rep.needsAttention);
      list('BLOCKED', rep.blocked);
      list('IN PROGRESS', rep.inProgress);
      if (rep.summary) lines.push(`  summary: ${rep.summary}`);
      if (!rep.topic && !rep.summary) lines.push(`  ${JSON.stringify(rep).slice(0, 1500)}`);
      return lines.join('\n');
    };
    sections.push(
      'INSTANCE REPORTS (work the user is doing in managed conversations; their ' +
      'NEEDS ATTENTION and BLOCKED items are real action items, frequently with ' +
      'deadlines — treat them as first-class issues, not background):\n' +
      instanceReports.map(fmt).join('\n\n')
    );
  }
  if (failedInstances.length > 0) {
    sections.push(`FAILED INSTANCES:\n${failedInstances.map(i => `- ${i.name} (${i.id}): crash-looped`).join('\n')}`);
  }
  if (recentResolutions.length > 0) {
    sections.push(`RECENTLY RESOLVED:\n${recentResolutions.map(r => `- ${r.issueId}: ${r.message}`).join('\n')}`);
  }
  if (Array.isArray(deferrals) && deferrals.length) {
    sections.push(
      'DEFERRED TOPICS (binding — the user has put these on hold; do NOT surface them ' +
      'or related items as sentences OR presumed tasks, until any stated date):\n' +
      deferrals.map(d => `- ${d.topic}${d.until ? ` (until ${d.until})` : ''}`).join('\n')
    );
  }
  if (contextSources && contextSources.trim()) {
    sections.push(`ADDITIONAL CONTEXT (the user's tracking log + configured source files):\n${contextSources}`);
  }

  return [
    'You are the life-management cycle reporter. Synthesize the data below into a cycle report.',
    'Prioritize by urgency. Highest first: anything explicitly URGENT or with an imminent/missed-but-recoverable deadline (this INCLUDES "needs attention" items from instance reports, not just tasks), then overdue tasks, then due-today, then blocked work, then failed instances, then everything else.',
    'Weigh the ADDITIONAL CONTEXT if present: the TRACKING LOG is binding — do NOT surface an issue the user has deferred (until any stated date) and reflect their decisions ("waiting on X", "dropped Y"); treat other configured sources (e.g. a life-tasks document) as real task/context input alongside the task list above.',
    'Instance-report action items are first-class: a report whose summary sounds "done" can still carry an urgent embedded deadline in its NEEDS ATTENTION list — surface that, do not bury it. Each pressing report item should get its own sentence.',
    'Also extract "presumed tasks": concrete action items implied by the instance ' +
    'reports (their NEEDS ATTENTION / BLOCKED / IN PROGRESS items) that are NOT already ' +
    'represented in the user\'s task list above. These are things the user likely needs ' +
    'to do, surfaced from their managed conversations, that they have not yet written ' +
    'down as tasks. One entry per discrete action; do not duplicate an existing task; ' +
    'keep the text short and actionable; include a due date only if the report states one. ' +
    'The TRACKING LOG is binding for presumed tasks too: if the user has deferred, dropped, ' +
    'or put a topic on hold (e.g. "push the launch to Friday", "not now", "waiting on X", ' +
    '"dropping Y"), OMIT presumed tasks related to that topic (until any stated date). ' +
    'Deferring a topic in TRACKING.md must make its related action items disappear from ' +
    'this list — do not re-surface them.',
    'Output JSON:',
    '{',
    '  "summary": "one-paragraph synthesis",',
    '  "thinking": "your reasoning about priorities",',
    '  "sentences": [',
    '    {"id": "unique-id", "text": "conversational sentence about the issue", "priority": 1}',
    '  ],',
    '  "presumedTasks": [',
    '    {"id": "short-id", "instance": "instance name", "text": "short action item", "due": "YYYY-MM-DD or null", "urgency": "high|normal|low"}',
    '  ]',
    '}',
    'Sentences should be conversational — how a thoughtful person would flag the issue.',
    'If nothing is pressing, return an empty sentences array. If no off-list action items, return an empty presumedTasks array.',
    '',
    '--- DATA ---',
    sections.join('\n\n'),
  ].join('\n');
}

function buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances, dailyTasks }) {
  const sentences = [];
  let priority = 1;

  for (const task of overdueTasks) {
    sentences.push({
      id: `overdue-${task.id}`,
      text: `"${task.text}" is overdue (was due ${task.due}).`,
      priority: priority++,
      source: 'fallback',
    });
  }

  for (const inst of failedInstances) {
    sentences.push({
      id: `failed-${inst.id}`,
      text: `The "${inst.name}" instance has crash-looped and needs attention.`,
      priority: priority++,
      source: 'fallback',
    });
  }

  for (const task of dueTodayTasks.slice(0, 3)) {
    sentences.push({
      id: `today-${task.id}`,
      text: `"${task.text}" is due today.`,
      priority: priority++,
      source: 'fallback',
    });
  }

  // Deterministic presumed tasks: every NEEDS ATTENTION / BLOCKED item from each
  // instance report, deduped against the task list (and each other).
  let presumedTasks = [];
  for (const r of instanceReports) {
    const rep = r.report || {};
    for (const x of [...(rep.needsAttention || []), ...(rep.blocked || [])]) {
      presumedTasks.push({ id: `presumed-${presumedTasks.length}`, instance: r.name, text: x, due: null, urgency: 'normal' });
    }
  }
  presumedTasks = dedupePresumedTasks(presumedTasks, dailyTasks && dailyTasks.tasks);

  return {
    timestamp: cycleTime,
    summary: 'Fallback report (Claude synthesis unavailable).',
    instanceReports,
    sentences,
    presumedTasks,
    rawThinking: '',
  };
}

// Drop presumed tasks that duplicate an existing task (or each other). Exact
// normalized match (trim + lowercase + collapse whitespace) — conservative, so
// it never hides a legitimately distinct item.
function dedupePresumedTasks(presumed, tasks) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const existing = new Set((tasks || []).map(t => norm(t.text)));
  const seen = new Set();
  return (presumed || []).filter(p => {
    const k = norm(p.text);
    if (!k || existing.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function collectFlaggedEvents(tracking) {
  const events = [];
  for (const i of Object.values(tracking.instances)) {
    if (i.desiredState === DESIRED_STATE.FAILED) {
      events.push({ type: 'instance-failed', instanceId: i.id, name: i.name, crashCount: i.crashCount });
    }
    // Surface a report that keeps failing (e.g. the session's model is gone)
    // rather than letting it retry invisibly forever.
    if ((i.reportFailureCount || 0) >= 2) {
      events.push({ type: 'report-failing', instanceId: i.id, name: i.name, crashCount: i.reportFailureCount, error: i.lastReportError });
    }
  }
  return events;
}
