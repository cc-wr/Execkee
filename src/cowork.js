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
    if (inst.visibility === VISIBILITY.FOREGROUND) {
      console.log(`[cowork] Skip ${inst.id}: foregrounded`);
      continue;
    }

    if (hub) {
      console.log(`[cowork] Requesting report for ${inst.id}...`);
      const result = await hub.sendCommand(inst.workhorseId, CMD.REPORT, {
        instanceId: inst.id,
      });

      if (result?.success) {
        instanceReports.push({
          instanceId: inst.id,
          name: inst.name,
          report: result.report,
          timestamp: cycleTime,
        });
      } else if (result?.skipped) {
        console.log(`[cowork] Skip ${inst.id}: unchanged`);
      } else {
        console.log(`[cowork] Report failed for ${inst.id}: ${result?.error}`);
      }
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
    instanceStatus: instances
      .filter(i => i.desiredState === DESIRED_STATE.ALIVE)
      .map(i => ({
        id: i.id,
        name: i.name,
        workhorse: i.workhorseId,
        visibility: i.visibility,
        lastActivity: i.lastActivityTime,
        lastReport: i.lastReportTime,
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
      return buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances });
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
      rawThinking: parsed.thinking || '',
    };
  } catch (err) {
    console.error('[cowork] Claude synthesis failed:', err.message);
    return buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances });
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
    sections.push(`INSTANCE REPORTS:\n${instanceReports.map(r => `[${r.name}] ${JSON.stringify(r.report?.summary || r.report)}`).join('\n')}`);
  }
  if (failedInstances.length > 0) {
    sections.push(`FAILED INSTANCES:\n${failedInstances.map(i => `- ${i.name} (${i.id}): crash-looped`).join('\n')}`);
  }
  if (recentResolutions.length > 0) {
    sections.push(`RECENTLY RESOLVED:\n${recentResolutions.map(r => `- ${r.issueId}: ${r.message}`).join('\n')}`);
  }

  return [
    'You are the life-management cycle reporter. Synthesize the data below into a cycle report.',
    'Prioritize by urgency: overdue > due-today > blocked > failed-instances > other.',
    'Output JSON:',
    '{',
    '  "summary": "one-paragraph synthesis",',
    '  "thinking": "your reasoning about priorities",',
    '  "sentences": [',
    '    {"id": "unique-id", "text": "conversational sentence about the issue", "priority": 1},',
    '    ...',
    '  ]',
    '}',
    'Sentences should be conversational — how a thoughtful person would flag the issue.',
    'If nothing is pressing, return an empty sentences array.',
    '',
    '--- DATA ---',
    sections.join('\n\n'),
  ].join('\n');
}

function buildFallbackReport({ cycleTime, instanceReports, overdueTasks, dueTodayTasks, failedInstances }) {
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

  return {
    timestamp: cycleTime,
    summary: 'Fallback report (Claude synthesis unavailable).',
    instanceReports,
    sentences,
    rawThinking: '',
  };
}

function collectFlaggedEvents(tracking) {
  return Object.values(tracking.instances)
    .filter(i => i.desiredState === DESIRED_STATE.FAILED)
    .map(i => ({
      type: 'instance-failed',
      instanceId: i.id,
      name: i.name,
      crashCount: i.crashCount,
    }));
}
