import { claudeRun } from './common/exec-async.js';
import { readTracking, writeTracking, updateInstance } from './common/tracking.js';
import {
  readDashboardData, writeDashboardData,
  readSentenceQueue, writeSentenceQueue,
  readCycleReport, writeCycleReport,
  readDailyTasks, writeDailyTasks,
  readLifeTasks,
  readResolutions, writeResolutions,
} from './common/store.js';
import { DESIRED_STATE, VISIBILITY, CMD } from './common/protocol.js';
import config from './common/config.js';

export async function runCoworkCycle(hub) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  console.log(`[cowork] === Cycle start: ${now.toISOString()} ===`);

  // Step 0: Establish current date/time
  const cycleTime = now.toISOString();

  // Step 1: Read life-tasks and generate/update daily task list
  const lifeTasks = readLifeTasks();
  const dailyTasks = generateDailyTasks(lifeTasks, today);
  writeDailyTasks(dailyTasks);

  // Step 2: Collect reports from recently-active hidden instances
  const tracking = readTracking();
  const instanceReports = [];
  const instances = Object.values(tracking.instances);

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

  // Step 3: Reconcile resolutions
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
    dailyTasks: dailyTasks.tasks,
    presumedTasks: cycleReport.presumedTasks || [],
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

function generateDailyTasks(lifeTasks, today) {
  const tasks = (lifeTasks.tasks || []).map(task => {
    let status = 'pending';
    if (task.completedAt) {
      status = 'complete';
    } else if (task.due && task.due < today) {
      status = 'overdue';
    } else if (task.due === today) {
      status = 'due-today';
    }

    return {
      id: task.id,
      text: task.text,
      due: task.due || null,
      priority: task.priority || 'normal',
      status,
      complete: !!task.completedAt,
      inProgress: !!task.inProgress && !task.completedAt,
    };
  });

  tasks.sort((a, b) => {
    const statusOrder = { overdue: 0, 'due-today': 1, pending: 2, complete: 3 };
    const prioOrder = { high: 0, normal: 1, low: 2 };
    const sd = (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2);
    if (sd !== 0) return sd;
    return (prioOrder[a.priority] || 1) - (prioOrder[b.priority] || 1);
  });

  return { date: today, tasks };
}

// Cheap, fork-free dashboard refresh for task edits: re-read tasks.json and update
// ONLY the dashboard's task list (donut + dailyTasks). No Claude synthesis, so a
// task change shows immediately instead of waiting for the next 30-min cycle.
export function refreshDashboardTasks() {
  const today = new Date().toISOString().split('T')[0];
  const dailyTasks = generateDailyTasks(readLifeTasks(), today);
  writeDailyTasks(dailyTasks);
  const data = readDashboardData();
  data.dailyTasks = dailyTasks.tasks;
  data.updatedBy = 'task-refresh';
  writeDashboardData(data);
  return dailyTasks.tasks.length;
}

async function authorCycleReport({ cycleTime, today, dailyTasks, instanceReports, resolutions, previousQueue, tracking }) {
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

function buildCyclePrompt({ cycleTime, today, overdueTasks, dueTodayTasks, incompleteTasks, instanceReports, failedInstances, recentResolutions }) {
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

  return [
    'You are the life-management cycle reporter. Synthesize the data below into a cycle report.',
    'Prioritize by urgency. Highest first: anything explicitly URGENT or with an imminent/missed-but-recoverable deadline (this INCLUDES "needs attention" items from instance reports, not just tasks), then overdue tasks, then due-today, then blocked work, then failed instances, then everything else.',
    'Instance-report action items are first-class: a report whose summary sounds "done" can still carry an urgent embedded deadline in its NEEDS ATTENTION list — surface that, do not bury it. Each pressing report item should get its own sentence.',
    'Also extract "presumed tasks": concrete action items implied by the instance ' +
    'reports (their NEEDS ATTENTION / BLOCKED / IN PROGRESS items) that are NOT already ' +
    'represented in the user\'s task list above. These are things the user likely needs ' +
    'to do, surfaced from their managed conversations, that they have not yet written ' +
    'down as tasks. One entry per discrete action; do not duplicate an existing task; ' +
    'keep the text short and actionable; include a due date only if the report states one.',
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
