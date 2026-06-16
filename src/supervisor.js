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
import { readTracking, writeTracking } from './common/tracking.js';
import { listLocalSessions, getSessionCwd, getSessionJsonlPath } from './workhorse/reporter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const PRIMARY_SETTINGS = join(config.DATA_DIR, 'primary-settings.json');
const PRIMARY_SESSION_FILE = join(config.DATA_DIR, 'primary-session.json');
const PRIMARY_SEED = 'Give me a brief status of Execkee right now (managed instances and the top dashboard sentence), then stand by for my instructions.';
const BRIEF_VERSION = 10;
const BRIEF_MARKER = `execkee-brief v${BRIEF_VERSION}`;

const mode = process.argv[2] || 'controller';
const serverUrl = process.argv[3] || `ws://localhost:${config.WS_PORT}`;
const workhorseId = process.argv[4] || `wh-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
const workhorseName = process.argv[5] || hostname();

let shuttingDown = false;
const nodeChildren = [];
let primaryPid = null;
let primaryInterval = null;
let primarySessionTimer = null;

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

// The primary is the user's trusted, autonomous control surface: it's launched with
// --dangerously-skip-permissions (see launchPrimaryWindow) so it never prompts to
// approve the node CLI commands / edits it runs on their behalf — a single allow rule
// couldn't cover the compound `node … && … | …` forms it builds, which kept prompting.
// Built-in guards for rm -rf / and ~ still prompt. These settings additionally
// pre-grant data-dir access. Created once; never clobbers user edits.
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

function readPrimarySessionId() {
  try {
    if (!existsSync(PRIMARY_SESSION_FILE)) return null;
    const o = JSON.parse(readFileSync(PRIMARY_SESSION_FILE, 'utf-8'));
    return (o && o.sessionId) || null;
  } catch { return null; }
}

function writePrimarySessionId(sessionId) {
  try { writeFileSync(PRIMARY_SESSION_FILE, JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2), 'utf-8'); } catch {}
}

const _normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

// Newest session whose cwd is the life-tasks dir — i.e. the primary's own live
// conversation. The cycle fork runs in the repo root and report forks don't persist
// (--no-session-persistence), so the life-tasks slug holds ONLY primary sessions;
// newest = the live one.
function newestLifeTasksSession() {
  try {
    for (const s of listLocalSessions()) { // newest-first
      if (_normPath(getSessionCwd(s.sessionId)) === _normPath(config.LIFE_TASKS_DIR)) return s.sessionId;
    }
  } catch {}
  return null;
}

// A resumable primary = a stored session whose transcript still exists AND whose cwd
// is the life-tasks dir (so we never --resume an unrelated session). KI-6: if the
// stored id is missing/invalid, fall back to the newest life-tasks session rather
// than starting a fresh seeded primary (which loses the conversation every restart).
function resumablePrimarySession() {
  const id = readPrimarySessionId();
  if (id && getSessionJsonlPath(id)) {
    const cwd = getSessionCwd(id);
    if (!cwd || _normPath(cwd) === _normPath(config.LIFE_TASKS_DIR)) return id;
  }
  return newestLifeTasksSession();
}

// KI-6: keep PRIMARY_SESSION_FILE pointing at the live conversation so a restart
// resumes the latest, not a stale snapshot. Cheap; runs on a timer.
function refreshPrimarySession() {
  const s = newestLifeTasksSession();
  if (s && s !== readPrimarySessionId()) {
    writePrimarySessionId(s);
    log('primary', `tracked live primary session ${s.slice(0, 8)}`);
  }
}

function launchClaude(cwd, argLine) {
  // Pass the whole arg line as ONE PowerShell string with each value double-quoted,
  // so a multi-word seed reaches claude intact (an -ArgumentList @(...) array splits).
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

// Shortly after a FRESH launch, record the primary's new session (the one created in
// the life-tasks dir) so a later restart can --resume it. Best-effort.
function schedulePrimaryCapture(beforeIds) {
  setTimeout(() => {
    try {
      for (const s of listLocalSessions()) {
        if (beforeIds.has(s.sessionId)) continue;
        if (_normPath(getSessionCwd(s.sessionId)) === _normPath(config.LIFE_TASKS_DIR)) {
          writePrimarySessionId(s.sessionId);
          log('primary', `captured primary session ${s.sessionId.slice(0, 8)} for resume-on-restart`);
          return;
        }
      }
    } catch {}
  }, 12_000);
}

function launchPrimaryWindow() {
  const cwd = config.LIFE_TASKS_DIR;
  const settings = ensurePrimarySettings();
  // Optional native Remote Control (EXECKEE_REMOTE_CONTROL=1). Added only to the
  // resume path (no positional prompt there); the rare fresh-seed launch keeps its
  // prompt clean — `--remote-control <text>` would otherwise treat the seed as the
  // RC session name. The primary relaunches via resume, so RC activates right after.
  const rc = config.REMOTE_CONTROL_ENABLED ? ' --remote-control' : '';

  // Resume the prior primary conversation across restarts when we have a valid one.
  const resumeId = resumablePrimarySession();
  if (resumeId) {
    const pid = launchClaude(cwd, `--dangerously-skip-permissions --resume ${resumeId} --settings "${settings}"${rc}`);
    if (pid) { log('primary', `launched (resumed ${resumeId.slice(0, 8)})${rc ? ' [remote-control]' : ''} pid=${pid}`); return pid; }
    log('primary', 'resume launch produced no pid — falling back to a fresh primary');
  }

  // Fresh launch: snapshot sessions first so we can capture the new one, then seed.
  const before = new Set(listLocalSessions().map(s => s.sessionId));
  const pid = launchClaude(cwd, `--dangerously-skip-permissions --settings "${settings}" "${PRIMARY_SEED}"`);
  if (pid) schedulePrimaryCapture(before);
  log('primary', `launched fresh pid=${pid}`);
  return pid;
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
  // KI-6: continuously track the live primary session so resume-on-restart never
  // reverts to a stale snapshot (or a fresh seed).
  primarySessionTimer = setInterval(() => { if (!shuttingDown) refreshPrimarySession(); }, 15_000);
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

  // Write-once normally; but self-heal a TRACKING.md that the old duplicate
  // TRACKING_FILE key clobbered with tracking JSON (a real markdown log never
  // starts with '{'). Never clobber a genuine log the primary maintains.
  const trackingMd = join(dir, 'TRACKING.md');
  let writeTrackingMd = !existsSync(trackingMd);
  if (!writeTrackingMd) {
    try { writeTrackingMd = readFileSync(trackingMd, 'utf-8').trimStart().startsWith('{'); } catch {}
  }
  if (writeTrackingMd) {
    writeFileSync(trackingMd, trackingLogScaffold(), 'utf-8');
    log('primary', `wrote tracking log scaffold: ${trackingMd}`);
  }

  // Write-once: manifest of extra files the cycle reads as context.
  if (!existsSync(config.CONTEXT_SOURCES_FILE)) {
    writeFileSync(config.CONTEXT_SOURCES_FILE, contextSourcesScaffold(), 'utf-8');
    log('primary', `wrote context-sources scaffold: ${config.CONTEXT_SOURCES_FILE}`);
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

- **Act directly** on: status, pull up / hide / adopt / release instances, resolve a
  dashboard issue, **force a cycle** ("refresh the dashboard" / "run a cycle now" →
  \`run-cycle\`), and **edits to the task store** (mark a task done, add one, change
  due/priority). Do the action, give a brief confirmation.
- **Confirm first** only for the genuinely destructive: **closing** an instance (it
  shuts a live window) or anything that could lose a conversation. Releasing /
  un-adopting is safe — it leaves the window running.
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

**Full permissions.** If the user says "adopt with full permissions" / "give it full
permissions" / "let it run unattended", append \`--full-permissions\` — the adopted
instance then runs with approval prompts disabled, and the mode is durable across
relaunch (crash-recovery / restart keep it).

## Releasing vs closing an instance

Two different "stop" actions — choose by what the user means:
- **Release / un-adopt** ("release X", "stop managing X", "un-adopt X", "let it go"):
  \`unmanage <id>\` — Execkee stops managing/monitoring it but **leaves the Claude
  window running**. The session stays on disk and can be re-adopted later.
- **Close** ("close X", "shut it down"): \`close <id>\` — **shuts the window** and ends
  the managed instance. Reassure the user the conversation isn't lost: the underlying
  session is **preserved on disk and can be re-adopted (resumed) later** via \`manage\`.
  (An instance you *created* fresh, with no captured session, can't be resumed once
  closed.) Confirm before closing, since it shuts a live window.

## Commands (internal — never shown to the user)

\`node "${CLI}" <command>\`:
- \`status\` / \`instances\` — workhorses + instances
- \`sessions\` — adoptable sessions, grouped by workhorse (which machine each lives on)
- \`sentence\` / \`dashboard\` — current dashboard sentence / raw data
- \`run-cycle\` — force a cycle now (re-reads instances + tasks, regenerates the dashboard)
- \`refresh-tasks\` — instantly refresh the dashboard's task list after a task edit (cheap; no cycle)
- \`plan\` — today's plan with ids (confirmed items + tentative guesses)
- \`approve-task <id>\` / \`approve-task --all\` — approve a tentative guessed task (promotes it into the backlog)
- \`reject-task <id>\` — drop a tentative guessed task
- \`manage <session-id> [name] [--on <workhorse-id>] [--from-now] [--open] [--full-permissions]\` — adopt; auto-routes to the session's own workhorse (\`--on\` forces one). Baseline by default. \`--full-permissions\` runs it unattended (skips approval prompts).
- \`create "<name>" [path] [--on <workhorse-id>]\` — new managed instance (on a chosen machine)
- \`foreground <id>\` / \`hide <id>\` / \`close <id>\` — pull up / background / close (shuts the window; the session stays re-adoptable)
- \`unmanage <id>\` — release / un-adopt (stop managing; leaves the window running)
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

**After EVERY task-store edit, immediately run \`refresh-tasks\`** so the dashboard
reflects it at once — never make the user wait for the 30-minute cycle. (It just
re-reads the tasks and updates the dashboard; no synthesis, instant.)

When you mark a task done, set \`completedAt\` to an ISO date or timestamp (e.g.
\`2026-06-16\` or \`2026-06-16T14:00:00Z\`) — the daily plan archives items completed
before today, so a non-date value would wrongly hide a just-finished task.

## Today's plan + tentative guesses (your approval gate)

Each day the plan **resets**: completed items archive, incomplete confirmed ones
carry forward, and Execkee makes a fresh **guess at today's tasks from the tracked
files** (TRACKING.md + the context-sources). Those guesses are **tentative** — they
are LLM proposals, NOT yet the user's real tasks, and show on the dashboard marked
"tentative". **They only become real when the user approves them through you.**

- Run \`plan\` to see today's items with ids and which are tentative.
- When the user reviews them, surface the tentative ones and ask. On a yes:
  \`approve-task <id>\` (or \`approve-task --all\`) — this promotes the guess into the
  backlog so it persists and carries forward. On a no/irrelevant: \`reject-task <id>\`.
- **Never approve on your own** — approval is the user's call; you only relay it.
  Until approved, treat a tentative task as a suggestion, not an obligation.

The dashboard also has a **"Tracked · no instance"** panel: plan tasks with no
managed instance behind them (matched by name). If the user wants one worked, that's
a cue to \`create\` or \`manage\` an instance for it.

**A "done" rarely lives in one place — reconcile across all three.** When the user
says a task is complete (or gives a status change), don't treat the task list, the
dashboard **sentence**, and the **instance / presumed tasks** as separate silos.
After updating the task store and running \`refresh-tasks\`:
- read the current sentence / \`${join(config.SHARED_STORE_DIR, 'cycle-report.json')}\`
  and judge whether this completion **resolves the displayed issue** — if so, \`resolve\` it;
- scan the **presumed tasks** (action items surfaced from managed instances) for the
  same item — the thing the user finished is often one an instance flagged.

## Keep a tracking log (TRACKING.md)

Maintain \`${join(config.LIFE_TASKS_DIR, 'TRACKING.md')}\` as durable memory for
everything the user tells you about the **sentence** and **instance tasks** that is
NOT a direct task edit — so nothing is lost between cycles: **deferrals** ("push X to
Friday", "not now"), **new information** ("the deadline moved", "they replied"), and
**status / decisions** ("waiting on Bob", "dropping Y"). Append, newest at the bottom,
each entry dated. **Before** resolving a sentence or surfacing a presumed task, check
TRACKING.md first, so you never re-raise or contradict something the user already
deferred or decided.

**Extra context files.** The cycle also reads any files listed in
\`${config.CONTEXT_SOURCES_FILE}\` (e.g. a Word doc of life tasks). When the user says
"also track / watch / read my <file>", add \`{ "path": "<full path>", "label": "<name>" }\`
to that JSON (supported: .md/.txt/.json/.csv and .docx on Windows), then run \`run-cycle\`
so it's picked up.
`;
}

function execkeeCommand() {
  return `Show the current Execkee state and stand ready to act on it.

Run \`node "${CLI}" status\` and \`node "${CLI}" sentence\`, summarize the current
dashboard sentence and the managed instances for me, then wait for my instruction.
Remember: only call \`resolve\` when my message actually resolves the displayed issue.
`;
}

function trackingLogScaffold() {
  return `# Execkee — Tracking Log

You (the primary) maintain this file. Append everything the user tells you about the
dashboard **sentence** and **instance tasks** that isn't a direct task-store edit, so
nothing is lost between cycles: deferrals, new information, and status / decisions,
plus context the user gives while reacting to the current sentence.

Append-only, newest at the bottom, each entry dated (YYYY-MM-DD). Check here before
resolving a sentence or surfacing a presumed task, so you don't re-raise or contradict
something the user already deferred or decided.

---
`;
}

function contextSourcesScaffold() {
  return JSON.stringify({
    _comment: 'Extra files the 30-minute cycle reads as context, in addition to tasks.json and TRACKING.md. Add { "path": "C:/full/path/file.docx", "label": "short name" } entries. Supported: .md .txt .json .csv .log and .docx (Windows). Paths are on THIS controller machine.',
    sources: [],
  }, null, 2) + '\n';
}

// --- Wiring ---

// Brain-only mode: drop any stale co-located workhorse (and its instances) from
// the master tracking so a previously-run wh-local doesn't linger in status.
function purgeLocalWorkhorse() {
  try {
    const tracking = readTracking();
    let changed = false;
    if (tracking.workhorses && tracking.workhorses['wh-local']) { delete tracking.workhorses['wh-local']; changed = true; }
    for (const [iid, inst] of Object.entries(tracking.instances || {})) {
      if (inst && inst.workhorseId === 'wh-local') { delete tracking.instances[iid]; changed = true; }
    }
    if (changed) { writeTracking(tracking); log('controller', 'purged stale co-located workhorse (wh-local) and its instances from tracking'); }
  } catch (err) {
    log('controller', `could not purge wh-local: ${err.message}`);
  }
}

function startController() {
  log('controller', `root: ${ROOT}`);
  // Brain-only by default: workers live on remote workhorse machines. Set
  // EXECKEE_LOCAL_WORKHORSE=1 (or run with -WithLocalWorkhorse) to also run a
  // co-located workhorse — the single-machine case.
  const localWh = ['1', 'true', 'yes'].includes(String(process.env.EXECKEE_LOCAL_WORKHORSE || '').toLowerCase());
  if (!localWh) {
    log('controller', 'brain-only: no co-located workhorse (set EXECKEE_LOCAL_WORKHORSE=1 to enable one)');
    purgeLocalWorkhorse();
  }
  superviseNode('server', ['src/server/index.js']);
  if (localWh) {
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
  if (primarySessionTimer) clearInterval(primarySessionTimer);
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
