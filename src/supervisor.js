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

import { spawn, execSync } from 'child_process';
import { hostname } from 'os';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './common/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

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

function superviseNode(name, args) {
  const rec = { name, proc: null };
  nodeChildren.push(rec);
  let backoff = 1000;
  let startedAt = 0;

  function start() {
    if (shuttingDown) return;
    startedAt = Date.now();
    log(name, `starting`);
    const proc = spawn('node', args, { cwd: ROOT, stdio: 'inherit' });
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

function launchPrimaryWindow() {
  const cwd = config.LIFE_TASKS_DIR;
  const ps = `$p = Start-Process claude -WorkingDirectory '${cwd}' -PassThru; Write-Output $p.Id`;
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
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
    execSync(`powershell -NoProfile -Command "Start-Process 'http://localhost:${config.HTTP_PORT}'"`, {
      windowsHide: true, timeout: 10_000,
    });
  } catch { /* non-fatal */ }
}

// --- Life-tasks scaffolding: teach the primary how to operate Execkee ---
// Created only if absent — never overwrites the user's edits.

function ensureLifeTasksScaffold() {
  const dir = config.LIFE_TASKS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const claudeMd = join(dir, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, primaryOperatorBrief(), 'utf-8');
    log('primary', `wrote operator brief: ${claudeMd}`);
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
  return `# You are the Execkee primary

You are the **primary control surface** of Execkee — a life-management system that
orchestrates permanent Claude Code instances across a pool of workhorse machines,
runs a 30-minute life-tracking cycle, and surfaces the single most pressing issue
on an HTML dashboard. The user talks to **you** in natural language; you translate
their intent into Execkee commands and keep their task list current.

## How you act on the system

Run commands with the Execkee CLI (via the Bash tool):

\`\`\`
node "${CLI}" <command> [args]
\`\`\`

Commands:
- \`status\` — workhorses and instances and their states
- \`instances\` — detailed instance list
- \`sessions\` — Claude sessions available to adopt
- \`sentence\` — the current dashboard sentence
- \`dashboard\` — raw dashboard data
- \`manage <session-id> [name] [--path <project-path>] [--baseline] [--open]\` — adopt an existing session
- \`create "<name>" [project-path]\` — create a new managed instance
- \`foreground <instance-id>\` — pull an instance up (refused if mid-report)
- \`hide <instance-id>\` — background an instance
- \`close <instance-id>\` — close an instance permanently
- \`resolve <issue-id> <message>\` — mark a dashboard issue resolved (message is space-delimited; no quotes needed)

## manage vs. create

- \`manage\` **adopts an existing** Claude session (one created outside Execkee, already on disk).
- \`create\` **starts a new** managed instance from scratch.

## Natural-language mapping

- "pull up the claude code about X" → resolve X to an instance id via \`status\`/\`instances\`, then \`foreground <id>\`.
- "hide the current one" / "hide X" → \`hide <id>\`.
- "close that instance" → \`close <id>\`.
- "manage the conversation about Y" → find the session via \`sessions\`, then \`manage <session-id> [name]\`.
- "start tracking a new project Z" → \`create "Z" [project-path]\`.

## The resolution rule (important)

When the user responds to the dashboard sentence, **judge whether their message
actually resolves the issue.** Only then call \`resolve <issue-id> <message>\`.
**Invoking \`resolve\` IS your judgment that the issue is resolved** — the message is
only the human-readable explanation, not the judgment itself. If they are merely
discussing, asking, or thinking out loud, **do nothing** — leave the sentence as-is.
When unsure, do not resolve (discussion is the safe default).
Read the latest cycle report at \`${join(config.SHARED_STORE_DIR, 'cycle-report.json')}\`
to stay in sync with the task's findings and to know the issue ids.

## The life-tasks list

This folder is the living store of the user's tasks. When the user tells you about
task changes ("done with the taxes", "add: renew passport", "the billing thing now
blocks the launch"), update the task store at
\`${config.LIFE_TASKS_FILE}\` (JSON: \`{ "tasks": [ { "id", "text", "due", "priority", "completedAt" } ] }\`).
The 30-minute cycle reads this folder to regenerate the daily list and sentences.
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
  setTimeout(() => {
    superviseNode('workhorse', ['src/workhorse/index.js', `ws://localhost:${config.WS_PORT}`, 'wh-local', hostname()]);
  }, 2500);
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
      execSync(`taskkill /PID ${primaryPid} /T /F`, { windowsHide: true, timeout: 5000 });
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
