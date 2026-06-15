#!/usr/bin/env node

// Execkee supervisor — keeps the long-running pieces alive (B1: supervised
// while this process runs; boot-install is a Phase-1 hardening).
//
//   controller mode: server (hub + dashboard + cycle) + a co-located
//                    subcontroller (Phase 0) + the primary Claude Code window
//                    in the life-tasks folder. Restarts any that exit.
//   workhorse mode:  just the subcontroller, pointed at a controller address.
//
// Usage:
//   node src/supervisor.js controller
//   node src/supervisor.js workhorse ws://<host>:7700 <workhorseId> <name>

import { spawn, execFileSync } from 'child_process';
import { hostname } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './common/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const PRIMARY_SETTINGS = join(config.DATA_DIR, 'primary-settings.json');
const PRIMARY_SEED = 'Give me a brief status of Execkee right now (managed instances and the top dashboard sentence), then stand by for my instructions.';
const BRIEF_VERSION = 4;
const BRIEF_MARKER = `execkee-brief v${BRIEF_VERSION}`;

const mode = process.argv[2] || 'controller';
const serverUrl = process.argv[3] || `ws://localhost:${config.WS_PORT}`;
const workhorseId = process.argv[4] || `wh-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
const workhorseName = process.argv[5] || hostname();

let shuttingDown = false;
const nodeChildren = [];
let primaryPid = null;
let primaryInterval = null;

function log(tag, msg) {
  console.log(`[supervisor:${tag}] ${msg}`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- Supervise a Node child (server / subcontroller) with backoff ---

function superviseNode(name, args, extraEnv) {
  const rec = { name, proc: null };
  nodeChildren.push(rec);
  let backoff = 1000;
  let startedAt = 0;

  function start() {
    if (shuttingDown) return;
    startedAt = Date.now();
    log(name, `starting`);
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const proc = spawn('node', args, { cwd: ROOT, stdio: 'inherit', env });
    rec.proc = proc;
    proc.on('exit', (code) => {
      if (shuttingDown) return;
      if (Date.now() - startedAt > 300_000) backoff = 1000; // stable ≥5 min → reset
      log(name, `exited (code ${code}); restarting in ${backoff}ms`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    proc.on('error', (err) => log(name, `spawn error: ${err.message}`));
  }
  start();
}

// --- The primary Claude Code surface (a visible window in life-tasks) ---

// Pre-grant the primary file access to the relevant dirs + the node CLI, and
// auto-accept edits, so the user is never prompted to approve. (Bash beyond
// node still prompts — deliberate.) Created once; never clobbers user edits.
let primarySettingsWritten = false;
function ensurePrimarySettings() {
  if (!primarySettingsWritten && !existsSync(PRIMARY_SETTINGS)) {
    const settings = {
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(node:*)'],
        additionalDirectories: [config.DATA_DIR, ROOT],
      },
    };
    writeFileSync(PRIMARY_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');
  }
  primarySettingsWritten = true;
  return PRIMARY_SETTINGS;
}

// Pre-accept Claude Code's "Do you trust the files in this folder?" gate for the
// primary's working dir, so the auto-launched window never prompts. Trust lives in
// ~/.claude.json under projects["<abs path, forward slashes>"].hasTrustDialogAccepted.
function ensurePrimaryFolderTrusted() {
  const claudeJson = join(config.HOME, '.claude.json');
  const key = config.LIFE_TASKS_DIR.replace(/\\/g, '/');
  let obj = {};
  if (existsSync(claudeJson)) {
    try { obj = JSON.parse(readFileSync(claudeJson, 'utf-8')); }
    catch { log('primary', 'could not parse ~/.claude.json; skipping pre-trust (primary may prompt once)'); return; }
  }
  if (!obj.projects) obj.projects = {};
  if (!obj.projects[key]) obj.projects[key] = {};
  if (obj.projects[key].hasTrustDialogAccepted === true) return; // already trusted; no write
  obj.projects[key].hasTrustDialogAccepted = true;
  try {
    writeFileSync(claudeJson, JSON.stringify(obj, null, 2), 'utf-8');
    log('primary', `pre-trusted folder for primary: ${key}`);
  } catch (err) {
    log('primary', `could not pre-trust folder (${err.message}); the primary may prompt once`);
  }
}

function launchPrimaryWindow() {
  const cwd = config.LIFE_TASKS_DIR;
  const settings = ensurePrimarySettings();
  // Pass the whole arg line as ONE PowerShell string with each value
  // double-quoted, so the multi-word seed prompt reaches claude intact
  // (an -ArgumentList @(...) array splits space-containing elements).
  const argLine = `--settings "${settings}" "${PRIMARY_SEED}"`;
  const psArgLine = argLine.replace(/'/g, "''");
  const psCmd = `$p = Start-Process claude -WorkingDirectory '${cwd}' -ArgumentList '${psArgLine}' -PassThru; Write-Output $p.Id`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf-8', windowsHide: true, timeout: 15_000,
    }).trim();
    return parseInt(out, 10) || null;
  } catch (err) {
    log('primary', `launch failed: ${err.message}`);
    return null;
  }
}

let primaryRelaunches = [];
function startPrimary() {
  ensureLifeTasksScaffold();
  ensurePrimaryFolderTrusted();
  primaryPid = launchPrimaryWindow();
  log('primary', `launched pid=${primaryPid} in ${config.LIFE_TASKS_DIR}`);
  primaryInterval = setInterval(() => {
    if (shuttingDown) return;
    if (pidAlive(primaryPid)) return;
    // Storm-breaker: if the primary keeps dying immediately (e.g. claude is
    // broken), stop relaunching rather than respawning windows forever.
    const now = Date.now();
    primaryRelaunches = primaryRelaunches.filter(t => now - t < 60_000);
    if (primaryRelaunches.length >= 5) {
      log('primary', 'primary exited 5+ times in 60s — stopping relaunch; fix the cause and restart the supervisor');
      clearInterval(primaryInterval);
      primaryInterval = null;
      return;
    }
    primaryRelaunches.push(now);
    log('primary', 'primary surface exited — relaunching');
    primaryPid = launchPrimaryWindow();
  }, 5000);
}

function openDashboard() {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Start-Process 'http://localhost:${config.HTTP_PORT}'`], {
      windowsHide: true, timeout: 10_000,
    });
  } catch { /* non-fatal */ }
}

// --- Life-tasks scaffolding: teach the primary how to operate Execkee ---
// The CLAUDE.md operator brief is system-managed and rewritten when its version
// marker changes (so improvements propagate); the /execkee command is write-once.

function ensureLifeTasksScaffold() {
  const dir = config.LIFE_TASKS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const claudeMd = join(dir, 'CLAUDE.md');
  let needsBrief = true;
  if (existsSync(claudeMd)) {
    try { needsBrief = !readFileSync(claudeMd, 'utf-8').includes(BRIEF_MARKER); } catch {}
  }
  if (needsBrief) {
    writeFileSync(claudeMd, primaryOperatorBrief(), 'utf-8');
    log('primary', `wrote operator brief (v${BRIEF_VERSION}): ${claudeMd}`);
  }

  const cmdDir = join(dir, '.claude', 'commands');
  if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
  const execkeeCmd = join(cmdDir, 'execkee.md');
  if (!existsSync(execkeeCmd)) {
    writeFileSync(execkeeCmd, execkeeCommand(), 'utf-8');
    log('primary', `wrote /execkee command: ${execkeeCmd}`);
  }
}

function primaryOperatorBrief() {
  return `<!-- ${BRIEF_MARKER} — system-managed by Execkee; the controller regenerates this file. Don't put your own notes here. -->
# You are the Execkee primary

You are the **primary control surface** of Execkee — a life-management system that
orchestrates permanent Claude Code instances, runs a 30-minute life-tracking cycle,
and surfaces the single most pressing issue on an HTML dashboard. The user talks to
**you** in natural language; you turn intent into action and keep their tasks current.

## How you work (read this first)

**Just do it, then confirm in one line.** Act immediately on the user's request —
do not propose-and-wait, do not narrate "let me read/verify…" step by step, and
do not show raw \`node …\` commands. The CLI is an implementation detail.

- **Act directly** on: status, pull up / hide / adopt instances, resolve a
  dashboard issue, and **edits to the task store** (mark a task done, add one,
  change due/priority). Do the action, give a brief confirmation.
- **Confirm first** only for the genuinely destructive: closing or unmanaging an
  instance, or anything that could lose a conversation.
- This **overrides** any global "propose before editing / wait for go" habit —
  scoped to Execkee operations and the life-tasks task store. Keep replies short.

## Capturing issues for later

When the user flags an Execkee shortcoming, annoyance, or improvement idea that is
**not an immediate action** ("this is clunky", "log this for later", "we should
make X do Y"), record it to the backlog and confirm in one line:

\`\`\`
node "${CLI}" issue add "<the issue, stated clearly>"
\`\`\`

These accumulate for a later code pass (the developer reviews \`issue\` / \`issue all\`).
Distinguish: an actionable now-request → do it; a system-improvement note → log it.
When unsure which, ask one short question.

## Adopting a session (no choices needed)

\`manage\` adopts with a **full baseline report by default** (the whole conversation
is read on the first cycle) and **auto-runs a cycle** so the report appears at once.
Just adopt — don't ask about baseline. Use \`--from-now\` only if the user explicitly
wants deltas-only.

## Commands (internal — never shown to the user)

\`node "${CLI}" <command>\`:
- \`status\` / \`instances\` — workhorses + instances
- \`sessions\` — adoptable sessions, grouped by workhorse (which machine each lives on)
- \`sentence\` / \`dashboard\` — current dashboard sentence / raw data
- \`manage <session-id> [name] [--on <workhorse-id>] [--from-now] [--open]\` — adopt; auto-routes to the session's own workhorse (\`--on\` forces one). Baseline by default.
- \`create "<name>" [path] [--on <workhorse-id>]\` — new managed instance (on a chosen machine)
- \`foreground <id>\` / \`hide <id>\` / \`close <id>\` — pull up / background / close
- \`resolve <issue-id> <message>\` — mark a dashboard issue resolved (space-delimited, no quotes)
- \`issue add <text>\` — log a backlog item

Natural language maps the obvious way: "pull up the X" → \`foreground\`; "hide it" →
\`hide\`; "manage the conversation about Y" → \`sessions\` then \`manage\`.

## The resolution rule

When the user reacts to the dashboard sentence, judge whether their message **actually
resolves** it. Only then \`resolve <issue-id> <message>\` — invoking resolve IS your
judgment; the message is just the explanation. Discussion/questions → leave it
untouched. Read \`${join(config.SHARED_STORE_DIR, 'cycle-report.json')}\` for the
current findings and issue ids.

## The life-tasks list

This folder is the living task store. On "done with the taxes" / "add: renew
passport" / "the billing thing now blocks the launch" / "I'm working on the
launch checklist", edit \`${config.LIFE_TASKS_FILE}\` directly. Task JSON:
\`{ "tasks": [ { "id", "text", "due", "priority", "completedAt", "inProgress" } ] }\`.
Set \`completedAt\` when done; set \`inProgress: true\` when the user starts working
on a task (the dashboard donut shows completed / in-progress / not-done).
The cycle reads this to regenerate the daily list and sentences.
`;
}

function execkeeCommand() {
  return `Show the current Execkee state and stand ready to act on it.

Run \`node "${CLI}" status\` and \`node "${CLI}" sentence\`, summarize the current
dashboard sentence and the managed instances for me, then wait for my instruction.
Remember: only call \`resolve\` when my message actually resolves the displayed issue.
`;
}

// --- Wiring ---

function startController() {
  log('controller', `root: ${ROOT}`);
  superviseNode('server', ['src/server/index.js']);
  // The co-located workhorse is optional: set EXECKEE_NO_LOCAL_WORKHORSE=1 to run
  // the controller brain-only, with workers living on remote machines.
  const noLocalWh = ['1', 'true', 'yes'].includes(String(process.env.EXECKEE_NO_LOCAL_WORKHORSE || '').toLowerCase());
  if (noLocalWh) {
    log('controller', 'co-located workhorse disabled (EXECKEE_NO_LOCAL_WORKHORSE) — workers run on remote machines only');
  } else {
    setTimeout(() => {
      // D1: the co-located workhorse gets its OWN data dir (a local mirror), so
      // loopback behaves exactly like a remote machine — no shared-file aliasing
      // with the controller's master tracking.
      superviseNode('workhorse', ['src/workhorse/index.js', `ws://localhost:${config.WS_PORT}`, 'wh-local', hostname()],
        { EXECKEE_DATA_DIR: join(config.DATA_DIR, 'wh-local') });
    }, 2500);
  }
  setTimeout(() => {
    startPrimary();
    openDashboard();
  }, 5000);
  log('controller', `dashboard will open at http://localhost:${config.HTTP_PORT}`);
}

function startWorkhorse() {
  log('workhorse', `connecting to ${serverUrl} as ${workhorseId}`);
  superviseNode('workhorse', ['src/workhorse/index.js', serverUrl, workhorseId, workhorseName]);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('main', 'shutting down — stopping supervised processes');
  if (primaryInterval) clearInterval(primaryInterval);
  for (const rec of nodeChildren) {
    if (rec.proc && !rec.proc.killed) {
      try { rec.proc.kill(); } catch {}
    }
  }
  if (primaryPid) {
    try {
      execFileSync('taskkill', ['/PID', String(primaryPid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch (err) {
      log('main', `taskkill of primary ${primaryPid} failed: ${err.message}`);
    }
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Fail fast if the install is incomplete, rather than crash-looping children.
for (const rel of [['src', 'server', 'index.js'], ['src', 'workhorse', 'index.js']]) {
  const p = join(ROOT, ...rel);
  if (!existsSync(p)) {
    console.error(`[supervisor] missing required file: ${p} — is the install intact?`);
    process.exit(1);
  }
}

if (mode === 'controller') {
  startController();
} else if (mode === 'workhorse') {
  startWorkhorse();
} else {
  console.error(`Unknown mode: ${mode}. Use 'controller' or 'workhorse'.`);
  process.exit(1);
}

log('main', `Execkee supervisor running in ${mode} mode. Press Ctrl+C to stop.`);
