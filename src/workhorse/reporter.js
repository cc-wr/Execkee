import { statSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'fs';
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

// `claude --resume <id>` is scoped to the project derived from the cwd, so a
// managed session MUST be launched/forked from its original working directory.
// That directory is recorded in the session transcript's `cwd` field; read it
// from the first events (bounded prefix, transcripts can be large).
export function getSessionCwd(sessionId) {
  const path = getSessionJsonlPath(sessionId);
  if (!path) return null;
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const bytes = readSync(fd, buf, 0, 65536, 0);
    closeSync(fd);
    for (const line of buf.toString('utf-8', 0, bytes).split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
      } catch {}
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

export async function runForkReport(sessionId, cwd) {
  try {
    const options = {};
    // Resume is project-scoped: fork from the session's own working directory.
    const dir = cwd || getSessionCwd(sessionId);
    if (dir && existsSync(dir)) options.cwd = dir;
    const output = await claudeRun([
      '-p',
      '--resume', sessionId,
      '--fork-session',
      '--no-session-persistence',
      '--output-format', 'json',
      REPORT_PROMPT,
    ], options);

    let report;
    try {
      const parsed = JSON.parse(output);
      const events = Array.isArray(parsed) ? parsed : [parsed];
      const resultEvent = events.findLast(e => e.type === 'result');
      const resultText = resultEvent?.result || '';
      let jsonText = resultText.trim();
      const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) jsonText = fence[1].trim();
      try {
        report = JSON.parse(jsonText);
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
