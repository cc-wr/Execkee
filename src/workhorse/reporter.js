import { statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { claudeRun } from '../common/exec-async.js';

const REPORT_PROMPT = [
  'You are producing a status report for this Claude Code conversation.',
  'Summarize:',
  '1. What work has been done recently (since last report or start of conversation)',
  '2. Current state: what is in progress, what is blocked, what is complete',
  '3. Any issues, decisions needed, or things that need attention',
  '',
  'Be concise but complete. Focus on substance. Output valid JSON:',
  '{',
  '  "summary": "one-paragraph overview",',
  '  "recentWork": ["item1", "item2"],',
  '  "inProgress": ["item1"],',
  '  "blocked": ["item1"],',
  '  "completed": ["item1"],',
  '  "needsAttention": ["item1"],',
  '  "topic": "short name for what this conversation is about"',
  '}',
].join('\n');

export function getSessionJsonlPath(sessionId) {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;

  try {
    for (const projectSlug of readdirSync(projectsDir)) {
      const sessionFile = join(projectsDir, projectSlug, `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) return sessionFile;
    }
  } catch {}
  return null;
}

export function getSessionPosition(sessionId) {
  const path = getSessionJsonlPath(sessionId);
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function hasSessionChanged(sessionId, watermark) {
  const currentPosition = getSessionPosition(sessionId);
  return currentPosition > (watermark?.position || 0);
}

export async function runForkReport(sessionId) {
  try {
    const output = await claudeRun([
      '-p',
      '--resume', sessionId,
      '--fork-session',
      '--no-session-persistence',
      '--output-format', 'json',
      REPORT_PROMPT,
    ]);

    let report;
    try {
      const parsed = JSON.parse(output);
      const events = Array.isArray(parsed) ? parsed : [parsed];
      const resultEvent = events.findLast(e => e.type === 'result');
      const resultText = resultEvent?.result || '';
      try {
        report = JSON.parse(resultText);
      } catch {
        report = { summary: resultText.substring(0, 2000), raw: true };
      }
    } catch {
      report = { summary: output.substring(0, 2000), raw: true };
    }

    const newPosition = getSessionPosition(sessionId);

    return {
      success: true,
      report,
      watermark: { position: newPosition, timestamp: new Date().toISOString() },
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      report: null,
      watermark: null,
    };
  }
}
