import { statSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { claudeRun } from '../common/exec-async.js';
import config from '../common/config.js';

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

// Parse a `--output-format json` fork output into {ok, resultText, errorReason}.
// `claude` can fail two ways: a non-zero exit (the output arrives on err.stdout),
// or exit 0 with a result event carrying is_error:true (e.g. model unavailable).
function parseForkResult(output) {
  try {
    const parsed = JSON.parse(output);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const res = events.findLast(e => e && e.type === 'result');
    if (!res) return { ok: false, errorReason: 'no result event in output' };
    if (res.is_error) {
      return { ok: false, errorReason: String(res.result || res.error || 'is_error').slice(0, 300) };
    }
    return { ok: true, resultText: res.result || '' };
  } catch {
    return { ok: false, errorReason: 'unparseable fork output' };
  }
}

function buildReport(resultText) {
  let jsonText = String(resultText || '').trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  try { return JSON.parse(jsonText); }
  catch { return { summary: String(resultText || '').substring(0, 2000), raw: true }; }
}

async function oneFork(sessionId, options, model) {
  const args = ['-p'];
  if (model) args.push('--model', model);
  args.push('--resume', sessionId, '--fork-session', '--no-session-persistence', '--output-format', 'json', REPORT_PROMPT);
  try {
    return parseForkResult(await claudeRun(args, options));
  } catch (err) {
    // Non-zero exit: the JSON (with the real reason) usually arrives on stdout.
    const parsed = err.stdout ? parseForkResult(err.stdout) : null;
    return { ok: false, errorReason: (parsed && parsed.errorReason) || err.message };
  }
}

export async function runForkReport(sessionId, cwd) {
  const options = { timeout: config.REPORT_TIMEOUT_MS };
  // Resume is project-scoped: fork from the session's own working directory.
  const dir = cwd || getSessionCwd(sessionId);
  if (dir && existsSync(dir)) options.cwd = dir;

  // Try the session's own model first (fidelity), then fall back to available
  // models in order. null = inherit the session's model (no --model flag).
  const models = [null, ...(config.REPORT_FALLBACK_MODELS || [])];
  const attempts = [];

  for (const model of models) {
    const label = model || 'session-default';
    const r = await oneFork(sessionId, options, model);
    attempts.push({ model: label, ok: r.ok, error: r.ok ? null : r.errorReason });
    if (r.ok) {
      return {
        success: true,
        report: buildReport(r.resultText),
        modelUsed: label,
        attempts,
        watermark: { position: getSessionPosition(sessionId), timestamp: new Date().toISOString() },
      };
    }
    console.error(`[reporter] fork for ${sessionId} failed on model '${label}': ${r.errorReason}`);
  }

  const summary = attempts.map(a => `${a.model}: ${a.error}`).join(' | ');
  return {
    success: false,
    error: `report failed on all models — ${summary}`,
    attempts,
    report: null,
    watermark: null,
  };
}
