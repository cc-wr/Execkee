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
import { portInUse } from './common/net.js';
import { writePrimaryInfo, clearPrimaryInfo } from './common/primary.js';
import { atomicWriteJson } from './common/safe-fs.js';
import { hostname } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './common/config.js';
import { initProcessLog, tailPrimaryChat } from './common/logger.js';
import { readTracking, writeTracking } from './common/tracking.js';
import { listLocalSessions, getSessionCwd, getSessionJsonlPath } from './workhorse/reporter.js';

initProcessLog('supervisor'); // tee supervisor output to ~/.execkee/logs/supervisor.log

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const PRIMARY_SETTINGS = join(config.DATA_DIR, 'primary-settings.json');
const PRIMARY_SESSION_FILE = join(config.DATA_DIR, 'primary-session.json');
const PRIMARY_SEED = 'Give me a brief status of Execkee right now (managed instances and the top dashboard sentence), then stand by for my instructions.';
const BRIEF_VERSION = 22;
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

// --- Supervise a child process (node server / subcontroller / gateway) with backoff ---

function superviseProc(name, command, args, extraEnv) {
  const rec = { name, proc: null };
  nodeChildren.push(rec);
  let backoff = 1000;
  let startedAt = 0;

  function start() {
    if (shuttingDown) return;
    startedAt = Date.now();
    log(name, `starting`);
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const proc = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env });
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

function superviseNode(name, args, extraEnv) {
  superviseProc(name, 'node', args, extraEnv);
}

// --- Local LLM gateway (agentgateway) ---
// One per machine, supervised like the node children. Routes deepseek-* models to
// DeepSeek (keyed) and everything else to Anthropic with NO stored key — the empty
// provider params make the gateway forward the caller's own OAuth bearer, so Claude
// subscription auth keeps working through it (machine-verified 2026-09-02, F1 tests).
// Nothing routes through it by default: the primary is direct unless
// EXECKEE_GATEWAY_PRIMARY=1, and workhorse instances only once flipped. It still runs
// on every machine so a flip has something to attach to.

const GATEWAY_EXE = join(config.GATEWAY_DIR, process.platform === 'win32' ? 'agentgateway.exe' : 'agentgateway');
const GATEWAY_CFG = join(config.GATEWAY_DIR, 'config.yaml');

function defaultGatewayConfig() {
  return [
    '# Execkee LLM gateway config (agentgateway). Written once by the supervisor;',
    '# edit freely — never overwritten. deepseek-* -> DeepSeek (DEEPSEEK_API_KEY from',
    '# the environment); everything else -> Anthropic with NO key, which forwards the',
    "# caller's own OAuth credentials (Claude subscription auth passes through).",
    'llm:',
    `  port: ${config.GATEWAY_PORT}`,
    '  models:',
    '  - name: "deepseek-v4-flash"',
    '    provider: deepseek',
    '    params:',
    '      apiKey: "$DEEPSEEK_API_KEY"',
    '  - name: "deepseek-v4-pro"',
    '    provider: deepseek',
    '    params:',
    '      apiKey: "$DEEPSEEK_API_KEY"',
    '  - name: "*"',
    '    provider: anthropic',
    '    params: {}',
    '',
  ].join('\n');
}

// Environment that puts the gateway's non-Anthropic model into a session's /model
// picker. ANTHROPIC_CUSTOM_MODEL_OPTION *adds* a row; it does not shadow or replace
// any built-in alias, so opus/haiku/fable behave exactly as they do without it.
function gatewayModelEnv() {
  if (!config.GATEWAY_CUSTOM_MODEL) return {};
  return {
    ANTHROPIC_CUSTOM_MODEL_OPTION: config.GATEWAY_CUSTOM_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: config.GATEWAY_CUSTOM_MODEL_NAME,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Served by the local Execkee gateway',
  };
}

// Whether the gateway is actually REACHABLE — refreshed by a periodic probe. Not
// "is the binary installed": a primary pointed at a gateway that is down has every
// request fail, so routing decisions must key off a live socket, never off the file.
let gatewayUp = false;

async function refreshGatewayUp() {
  gatewayUp = config.GATEWAY_ENABLED && await portInUse(config.GATEWAY_PORT);
  return gatewayUp;
}

// Wait (briefly) for the gateway to accept connections — used once before the first
// primary launch so a cold start still gets a routed primary instead of a direct one.
async function waitForGateway(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await refreshGatewayUp()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Supervise the machine's ONE gateway. Unlike superviseProc this checks the port
// before every (re)start: the controller and a co-resident workhorse both call this,
// and only one of them may own the process — the other shares it. That also settles
// the startup race (both probe an empty port, both spawn, one loses the bind): the
// loser's exit lands back in tick(), now sees the winner listening, and waits instead
// of crash-looping. If the owner later dies, whoever is polling takes over.
function superviseGateway() {
  if (!config.GATEWAY_ENABLED) { log('gateway', 'disabled (EXECKEE_GATEWAY=0)'); return; }
  if (!existsSync(config.GATEWAY_DIR)) mkdirSync(config.GATEWAY_DIR, { recursive: true });
  if (!existsSync(GATEWAY_EXE)) {
    log('gateway', `not installed — put the agentgateway binary at ${GATEWAY_EXE} ` +
      '(github.com/agentgateway/agentgateway releases; verify the .sha256). ' +
      'Until then the primary and flipped instances run direct to Anthropic.');
    return;
  }
  if (!existsSync(GATEWAY_CFG)) {
    writeFileSync(GATEWAY_CFG, defaultGatewayConfig(), 'utf-8');
    log('gateway', `wrote default config: ${GATEWAY_CFG}`);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    log('gateway', 'DEEPSEEK_API_KEY is not set — deepseek models will fail through the gateway (claude models unaffected)');
  }

  const rec = { name: 'gateway', proc: null };
  nodeChildren.push(rec);
  let backoff = 1000;
  let startedAt = 0;
  let announcedShared = false;
  let drainingSince = 0;
  let holdsLock = false;

  // Is any agentgateway port on this machine taken? `data` answers "is a gateway
  // serving requests"; `any` answers "may a new one bind". They differ while a
  // gateway drains: it closes the data port first but holds the admin, stats and
  // readiness ports for up to its 5s drain deadline. Probing the data port alone
  // there reads free and the replacement dies on the readiness bind (os error 10048).
  async function gatewayPorts() {
    const [data, admin, stats, ready] = await Promise.all([
      portInUse(config.GATEWAY_PORT),
      portInUse(config.GATEWAY_ADMIN_PORT),
      portInUse(config.GATEWAY_STATS_PORT),
      portInUse(config.GATEWAY_READY_PORT),
    ]);
    return { data, any: data || admin || stats || ready };
  }

  async function tick() {
    if (shuttingDown) return;
    const { data, any } = await gatewayPorts();
    if (data) {
      // Someone already serves this port on this machine — share it, don't spawn a
      // second one. (Our own child also lands here; harmless, it just re-polls.)
      if (!announcedShared && !rec.proc) {
        log('gateway', `already running on ${config.GATEWAY_URL} (another Execkee process on this machine owns it) — sharing it`);
        announcedShared = true;
      }
      drainingSince = 0;
      gatewayUp = true;
      setTimeout(tick, 15_000);
      return;
    }
    if (any) {
      // Admin ports held, data port gone: a gateway is on its way out. Poll fast and
      // take the slot the moment it lets go. If it never does (a hung process holding
      // the ports), stop busy-polling and fall back to the slow cadence.
      if (!drainingSince) {
        drainingSince = Date.now();
        log('gateway', 'a previous gateway still holds its admin ports — waiting for it to exit');
      }
      gatewayUp = false;
      setTimeout(tick, Date.now() - drainingSince > 30_000 ? 15_000 : 1000);
      return;
    }
    announcedShared = false;
    drainingSince = 0;
    // Port probes cannot settle a SIMULTANEOUS start: the controller and a co-resident
    // workhorse both read empty ports in the same millisecond, both spawn, and one dies
    // on bind. That is survivable (the loser shares) but it writes an alarming
    // "os error 10048" to the log every time. An exclusive-create lock makes the race
    // decidable without the crash: only the winner spawns, the loser waits.
    if (!acquireGatewayLock()) {
      setTimeout(tick, 1000);
      return;
    }
    start();
  }

  // Exclusive-create (O_EXCL) is atomic, so exactly one racer wins. A lock left by a
  // process that died is reclaimed — otherwise a crash would disable the gateway until
  // someone deleted the file by hand.
  function acquireGatewayLock() {
    if (holdsLock) return true;
    const f = config.GATEWAY_LOCK_FILE;
    try {
      const fd = openSync(f, 'wx');
      try { writeFileSync(fd, String(process.pid), 'utf-8'); } finally { closeSync(fd); }
      holdsLock = true;
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return true; // can't lock (odd FS) — don't block the gateway
      let owner = 0;
      try { owner = parseInt(readFileSync(f, 'utf-8').trim(), 10) || 0; } catch {}
      if (owner && owner !== process.pid && pidAlive(owner)) return false;
      try { unlinkSync(f); } catch {}
      return false; // re-probe next tick; the reclaimed lock is taken then
    }
  }

  function releaseGatewayLock() {
    if (!holdsLock) return;
    holdsLock = false;
    try { unlinkSync(config.GATEWAY_LOCK_FILE); } catch {}
  }

  function start() {
    if (shuttingDown) return;
    startedAt = Date.now();
    // agentgateway v1.5.0 has no bind-address config: its ports listen on ALL
    // interfaces. Loopback never traverses the Windows Firewall, so an inbound block
    // rule keeps localhost working while shutting out the LAN — the supervisor cannot
    // add it (needs elevation); it only reminds until one exists.
    log('gateway', `starting on ${config.GATEWAY_URL} — ensure an inbound firewall block for TCP ${config.GATEWAY_PORT} (see README, "Gateway")`);
    const proc = spawn(GATEWAY_EXE, ['-f', GATEWAY_CFG], { cwd: ROOT, stdio: 'inherit' });
    rec.proc = proc;
    proc.on('exit', (code) => {
      rec.proc = null;
      gatewayUp = false;
      releaseGatewayLock();
      if (shuttingDown) return;
      if (Date.now() - startedAt > 300_000) backoff = 1000; // stable ≥5 min → reset
      log('gateway', `exited (code ${code}); re-checking in ${backoff}ms`);
      setTimeout(tick, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    proc.on('error', (err) => log('gateway', `spawn error: ${err.message}`));
  }

  tick();
  setInterval(refreshGatewayUp, 30_000).unref?.();
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
    // ~/.claude.json is Claude Code's own config for EVERY project, not ours. A plain
    // write that a power loss catches would zero it; go through the flushed atomic path.
    atomicWriteJson(claudeJson, obj);
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
  // Losing this file costs the primary its conversation: the next start seeds a fresh
  // one instead of resuming. Written every time the live session moves, so it is
  // exposed to a power loss often.
  try { atomicWriteJson(PRIMARY_SESSION_FILE, { sessionId, updatedAt: new Date().toISOString() }); } catch {}
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
    writePrimaryInfo({ pid: primaryPid, sessionId: s, cwd: config.LIFE_TASKS_DIR });
    log('primary', `tracked live primary session ${s.slice(0, 8)}`);
  }
}

// J2: the primary's window, as Windows sees it. Nothing recorded this before, so when
// the window went missing on 2026-11-13 there was no way to tell a hidden window from a
// collapsed or an off-screen one.
//
// The handle is captured ONCE, shortly after launch while the window is still visible,
// and then reused. Re-resolving it per check does NOT work: a hidden window reports
// Process.MainWindowHandle = 0 (measured), so a self-resolving check goes blind at
// exactly the moment the fault appears. A handle stays valid for the window's lifetime.
// It is also published in primary.json, which is what lets the workhorse refuse to hide
// this particular window.
let primaryHwnd = null;
let lastWindowState = '';

const WIN32_MEMBERS = [
  '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);',
  '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
].join(' ');

function runPs(script, timeout = 10_000) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf-8', windowsHide: true, timeout }).trim();
}

function capturePrimaryHwnd() {
  if (!primaryPid) return;
  try {
    const out = runPs(`$p = Get-Process -Id ${primaryPid} -ErrorAction SilentlyContinue
if (-not $p) { Write-Output '0'; exit }
$p.Refresh()
Write-Output ([int64]$p.MainWindowHandle)`);
    const h = parseInt(out, 10) || 0;
    if (h) {
      primaryHwnd = h;
      writePrimaryInfo({ pid: primaryPid, sessionId: readPrimarySessionId(), cwd: config.LIFE_TASKS_DIR, hwnd: h });
      log('primary', `window handle ${h} captured`);
    } else {
      log('primary', 'no window handle for the primary yet (hidden windows report 0)');
    }
  } catch (err) { log('primary', `window handle capture failed: ${err.message}`); }
  checkPrimaryWindow();
}

// Report the window's state, and repair the one state the operator cannot recover from
// by hand: collapsed (too small to use). A window that is not visible is logged and
// left alone: the user sends windows to the tray (RBTray), which reads as not visible,
// and re-showing it every 15 s would undo that choice. Execkee itself cannot hide this
// window (adapter hideWindow refuses the primary's handle). A minimized window is also
// a user choice. Logs only on change.
function checkPrimaryWindow() {
  if (!primaryHwnd) return;
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace EK -Name Win -MemberDefinition '${WIN32_MEMBERS}' | Out-Null
$h = [IntPtr][int64]${primaryHwnd}
if (-not [EK.Win]::IsWindow($h)) { Write-Output 'window-gone'; exit }
$vis = [EK.Win]::IsWindowVisible($h)
$ico = [EK.Win]::IsIconic($h)
$r = New-Object EK.Win+RECT
[void][EK.Win]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$t = $r.Bottom - $r.Top
$fixed = ''
if ($vis -and -not $ico -and ($w -lt 500 -or $t -lt 400)) {
  $sw = [EK.Win]::GetSystemMetrics(0)
  $sh = [EK.Win]::GetSystemMetrics(1)
  $nw = [Math]::Min(1200, $sw)
  $nh = [Math]::Min(800, $sh)
  [void][EK.Win]::MoveWindow($h, [int](($sw - $nw) / 2), [int](($sh - $nh) / 2), $nw, $nh, $true)
  $fixed += 'RESIZED '
  $w = $nw
  $t = $nh
}
Write-Output (("visible=" + $vis + " minimized=" + $ico + " size=" + $w + "x" + $t + " " + $fixed).Trim())`;
  try {
    const out = runPs(script);
    if (out && out !== lastWindowState) {
      lastWindowState = out;
      log('primary', `window: ${out}`);
    }
  } catch (err) { log('primary', `window check failed: ${err.message}`); }
}

function launchClaude(cwd, argLine, extraEnv) {
  // Pass the whole arg line as ONE PowerShell string with each value double-quoted,
  // so a multi-word seed reaches claude intact (an -ArgumentList @(...) array splits).
  const psArgLine = argLine.replace(/'/g, "''");
  const psCmd = `$p = Start-Process claude -WorkingDirectory '${cwd}' -ArgumentList '${psArgLine}' -PassThru; Write-Output $p.Id`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf-8', windowsHide: true, timeout: 15_000,
      // Start-Process children inherit this powershell's environment, so extraEnv
      // (e.g. ANTHROPIC_BASE_URL for gateway routing) reaches the claude window.
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
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

  // The primary runs DIRECT to Anthropic unless EXECKEE_GATEWAY_PRIMARY=1 opts it in
  // (see config). Even opted in it must see a gateway actually LISTENING — installed
  // is not enough, since a primary pointed at a dead gateway fails every request.
  const viaGateway = config.GATEWAY_ENABLED && config.GATEWAY_PRIMARY && gatewayUp;
  const env = viaGateway ? { ANTHROPIC_BASE_URL: config.GATEWAY_URL, ...gatewayModelEnv() } : null;
  const gwTag = viaGateway ? ' [gateway]' : '';

  // Resume the prior primary conversation across restarts when we have a valid one.
  const resumeId = resumablePrimarySession();
  if (resumeId) {
    const pid = launchClaude(cwd, `--dangerously-skip-permissions --resume ${resumeId} --settings "${settings}"${rc}`, env);
    if (pid) {
      // Publish it BEFORE anything can adopt it: the workhorse matches `findsession`
      // on a session id anywhere in a command line, and ours carries `--resume <id>`.
      writePrimaryInfo({ pid, sessionId: resumeId, cwd });
      log('primary', `launched (resumed ${resumeId.slice(0, 8)})${rc ? ' [remote-control]' : ''}${gwTag} pid=${pid}`);
      return pid;
    }
    log('primary', 'resume launch produced no pid — falling back to a fresh primary');
  }

  // Fresh launch: snapshot sessions first so we can capture the new one, then seed.
  const before = new Set(listLocalSessions().map(s => s.sessionId));
  const pid = launchClaude(cwd, `--dangerously-skip-permissions --settings "${settings}" "${PRIMARY_SEED}"`, env);
  if (pid) schedulePrimaryCapture(before);
  // A fresh primary has no session id yet; refreshPrimarySession() fills it in once
  // the transcript appears. The pid alone already protects the window.
  writePrimaryInfo({ pid, sessionId: null, cwd });
  log('primary', `launched fresh pid=${pid}`);
  return pid;
}

let primaryRelaunches = [];
async function startPrimary() {
  ensureLifeTasksScaffold();
  ensurePrimaryFolderTrusted();
  // Only wait on the gateway when the primary is actually opted in to it — a direct
  // primary must not be delayed by a component it does not use.
  if (config.GATEWAY_PRIMARY && config.GATEWAY_ENABLED && existsSync(GATEWAY_EXE) && !(await waitForGateway(20_000))) {
    log('primary', 'gateway not reachable — launching the primary direct to Anthropic (no deepseek models this session)');
  }
  primaryPid = launchPrimaryWindow();
  log('primary', `launched pid=${primaryPid} in ${config.LIFE_TASKS_DIR}`);
  setTimeout(capturePrimaryHwnd, 8000); // MainWindowHandle lags the spawn
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
    primaryHwnd = null; // the old handle died with the old window
    lastWindowState = '';
    setTimeout(capturePrimaryHwnd, 8000);
  }, 5000);
  // KI-6: continuously track the live primary session so resume-on-restart never
  // reverts to a stale snapshot (or a fresh seed). Also tail the primary's
  // conversation into ~/.execkee/logs/primary-chat.log so its chats are easy to
  // review when a bug is raised.
  const primaryChatState = { id: null, pos: 0 };
  primarySessionTimer = setInterval(() => {
    if (shuttingDown) return;
    refreshPrimarySession();
    try {
      const sid = newestLifeTasksSession();
      if (sid) tailPrimaryChat(sid, getSessionJsonlPath(sid), primaryChatState);
    } catch (err) { log('primary', `chat-log tail error: ${err.message}`); }
    checkPrimaryWindow();
  }, 15_000);
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

**Heads-up when CHANGING the permission mode of an already-running instance** (e.g.
re-adopting it with \`--full-permissions\` when it's currently managed without): there
is no in-place permission change — it requires the window to exit and relaunch via
\`--resume\`, which reloads the on-disk transcript and can **drop recent turns the live
window held in memory but hadn't flushed**. Before doing a full-perms re-adopt of an
active instance, warn the user that recent unsaved conversation may be lost, and let
them confirm (iss-5).

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

## Window visibility is the user's business

Execkee records an instance as \`foreground\` or \`hidden\`. That record says what
Execkee last did. It does not say what is on screen now: the user moves windows to the
system tray (RBTray), minimizes them, and covers them, and a window in the tray reads
as not visible to Windows.

- Do **not** audit window visibility on your own initiative (no window enumeration,
  no \`IsWindowVisible\` checks) after a command that succeeded.
- Do **not** re-show a window, and do **not** ask about one, because it is recorded
  \`foreground\` but is not visible. Assume the user put it away.
- Check or show a window only when the user asks about **that** window ("pull up X",
  "where is X"), or when \`foreground\` itself reports a failure.

## Sensitive mode (privacy screen for the browser dashboard)

The dashboard can hide **potentially sensitive items** — health/medical scheduling,
therapy topics, and anything naming a person — so the screen is safe for others to
glance at. An LLM codes each item; coded-sensitive items are **removed entirely**
from the browser dashboard while the mode is on. Your own CLI output (\`plan\`,
\`dashboard\`, task edits) is **unaffected** — this blanks the screen, not your data.

- "hide sensitive" / "privacy mode" / "someone's looking at my screen" →
  \`sensitive hide\` (act directly; it may take a moment while items are coded — that
  is expected, tell the user it's done when the command returns)
- "show sensitive" / "back to normal" → \`sensitive show\`
- "is sensitive mode on?" → \`sensitive status\`
- Misclassifications: \`sensitive mark "<exact item text>"\` forces an item hidden;
  \`sensitive unmark "<exact item text>"\` forces it visible. Both are permanent
  overrides — use them when the user says "that one shouldn't be hidden" (or the
  reverse). Get the exact text from \`plan\` or \`dashboard\`.

New/uncoded items **fail closed**: they stay off the dashboard until coded (seconds,
automatic). If the user asks where a just-added task went while sensitive mode is on,
that's why — it appears once coded (or immediately if innocuous, via \`refresh-tasks\`).

## Model routing: the gateway and \`flip\`

A local LLM gateway runs on each Execkee machine. Through it, one Claude Code
window has BOTH the Anthropic models (fable/opus/haiku — still billed to the
user's Claude subscription; the gateway holds no Anthropic key) AND the DeepSeek
models (\`deepseek-v4-flash\`, \`deepseek-v4-pro\`, billed to the user's DeepSeek key).

- **You (the primary) run DIRECT to Anthropic, not through the gateway.** You are
  the control surface, so you stay on the plainest path — the gateway being down or
  restarting can never affect you. The deepseek models are therefore NOT in your own
  \`/model\` picker; that is deliberate, not a fault. (An operator can opt you in with
  EXECKEE_GATEWAY_PRIMARY=1, but the default is direct.)
- **Workhorse instances run DIRECT by default.** When the user says "flip X",
  "put X on the gateway", "give X deepseek", or "take X off the gateway", run
  \`flip <instance-id>\` — it toggles the mode.
- **Flip = quit + relaunch** (\`--resume\`), the same mechanism as a permission-mode
  change: recent turns the live window held in memory but hadn't flushed can be
  lost. **Warn the user and let them confirm before flipping an active instance**
  (same rule as iss-5). The mode persists across crash-recovery relaunches.

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
- \`regenerate-guesses\` — force a fresh tracked-file task guess now (don't wait for the daily rollover). Run this whenever the user asks to **re-guess / regenerate / re-do the guessed tasks** (e.g. after they update a tracked doc). Takes a moment (it re-reads the tracked files and re-asks the model); it replaces today's tentative guesses, leaving confirmed/approved tasks untouched.
- \`defer "<topic>" [--until YYYY-MM-DD]\` — put a topic on hold; the cycle then suppresses its related **instance-surfaced (presumed) tasks** and sentences (until the date, if given)
- \`undefer <id|topic>\` — lift a deferral (related items return next cycle)
- \`deferrals\` — list active deferrals
- \`long-term add "<text>"\` / \`long-term\` / \`long-term rm <id|text>\` / \`long-term promote <id|text> [--due YYYY-MM-DD]\` — the long-term pool (see "The long-term list" above)
- \`schedule-guess "<text>" --on YYYY-MM-DD [--until YYYY-MM-DD] [--horizon]\` — surface a task as a tentative **guess** starting on a date (then it flows through approve/reject); \`--horizon\` puts it in the "Tracked · no instance" panel instead of today's tentatives
- \`unschedule-guess <id|text>\` / \`scheduled-guesses\` — remove / list scheduled guesses
- \`manage <session-id> [name] [--on <workhorse-id>] [--from-now] [--open] [--full-permissions]\` — adopt; auto-routes to the session's own workhorse (\`--on\` forces one). Baseline by default. \`--full-permissions\` runs it unattended (skips approval prompts).
- \`create "<name>" [path] [--on <workhorse-id>]\` — new managed instance (on a chosen machine)
- \`foreground <id>\` / \`hide <id>\` / \`close <id>\` — pull up / background / close (shuts the window; the session stays re-adoptable)
- \`unmanage <id>\` — release / un-adopt (stop managing; leaves the window running)
- \`flip <id>\` — quit + relaunch an instance, toggling gateway routing (see "Model routing" above; confirm with the user first — unflushed turns can drop)
- \`resolve <issue-id> <message>\` — mark a dashboard issue resolved (space-delimited, no quotes)
- \`issue add <text>\` — log a backlog item
- \`sensitive hide\` / \`sensitive show\` / \`sensitive status\` — hide/show/query sensitive items on the browser dashboard (see "Sensitive mode" above)
- \`sensitive mark "<text>"\` / \`sensitive unmark "<text>"\` — permanently force an item hidden / visible

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
\`{ "tasks": [ { "id", "text", "due", "priority", "completedAt", "inProgress", "startDate" } ] }\`.
Set \`completedAt\` when done; set \`inProgress: true\` when the user starts working
on a task (the dashboard donut shows completed / in-progress / not-done).

**Schedule an approved task for later** with \`startDate\` (YYYY-MM-DD): the task stays
**hidden** from the plan until that date, then appears as a normal **confirmed** task —
no approval needed (it's already on the list, just dated forward). Use this when the
user says "add X as a real task, but not until <date>" / "put X on my list starting
<when>" / "I'll deal with X next month". (Different from \`schedule-guess\`, which
surfaces a *tentative guess* to approve; \`startDate\` queues an *already-approved* task.)
\`due\` is the deadline; \`startDate\` is when it first shows.

**After EVERY task-store edit, immediately run \`refresh-tasks\`** so the dashboard
reflects it at once — never make the user wait for the 30-minute cycle. (It just
re-reads the tasks and updates the dashboard; no synthesis, instant.)

When you mark a task done, set \`completedAt\` to an ISO date or timestamp (e.g.
\`2026-06-16\` or \`2026-06-16T14:00:00Z\`) — the daily plan archives items completed
before today, so a non-date value would wrongly hide a just-finished task.

## The long-term list (a SEPARATE pool)

A second, standing list for things with **no deadline and no start date** — "someday"
work the user wants recorded but not scheduled. It is a different store from the task
list above (\`long-term.json\`, not \`tasks.json\`), shows in its own **Approved · long
term** dashboard panel, and takes NO part in the daily plan, the donut, or the daily
rollover. It simply sits there until the user removes or promotes an item.

**Never edit this file by hand — use the command.** Unlike the task store, this pool is
reached only through \`long-term\`:

- "add X to my long-term list" / "someday I want to X" / "park X for later" →
  \`long-term add "X"\`
- "what's on my long-term list" → \`long-term\`
- "drop X from long term" → \`long-term rm <id|text>\`
- "I'm ready to start X" / "move X onto my actual list" →
  \`long-term promote <id|text>\`, adding \`--due YYYY-MM-DD\` only if the user gave a
  date. Promote moves it: it leaves the long-term pool and becomes a normal task.

Items have no due date, no priority and no completion state — do not try to set any.
To finish one, promote it and then complete it as a normal task.

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
  same item — the thing the user finished is often one an instance flagged;
- **check the tracked source docs.** Every time ANY task is marked complete —
  whether it began as a tentative guess or a confirmed task — look at TRACKING.md and
  the files in \`${config.CONTEXT_SOURCES_FILE}\` (e.g. a life-tasks **.docx**). If the
  completed item appears in one, **update that doc** so the source of truth reflects
  it's done and won't keep re-surfacing it. If a doc can't be edited directly, record
  the completion in TRACKING.md so the next cycle's guess accounts for it.

## Deferring a topic (where deferrals go)

When the user puts a topic **on hold** — "push the launch to Friday", "not now",
"don't bug me about the visa", "drop Y", "later" — record it with the structured
command, NOT just a prose note:

\`\`\`
node "${CLI}" defer "<short topic>" [--until YYYY-MM-DD]
\`\`\`

This is the **enforced** deferral store: the cycle suppresses that topic's related
**guessed tasks AND instance-surfaced (presumed) tasks** and sentences from the
dashboard (until the date, if you give one). Relatedness is judged by an **LLM**, by
meaning — so it catches paraphrases, not just exact words. This works for a guessed
task too: if the user says "defer that guessed task about X" / "stop guessing X",
\`defer "X"\` and it'll be matched out of the guesses. A prose line in TRACKING.md alone
is only *interpreted* and can slip through — so **always run \`defer\` for an actual
hold**, and also jot the context in TRACKING.md if useful. To bring a topic back:
\`undefer <id|topic>\` (\`deferrals\` lists what's active).

## Scheduling a future guess

When the user wants a task to show up **later** — "next week, have <X> as a guessed
task", "remind me to consider <X> on <date>", "schedule <X> as a guess for <when>" —
work out the concrete date (YYYY-MM-DD; e.g. "next week" = +7 days from today) and run:

\`\`\`
node "${CLI}" schedule-guess "<X>" --on <date> [--until <date>]
\`\`\`

On/after that date it surfaces as a **tentative guess** in the plan; you then present
it and the user approves (\`approve-task\`) or rejects (\`reject-task\`) it like any guess —
which also clears the schedule. Add \`--horizon\` to put it in the "Tracked · no instance"
panel instead of today's tentatives. \`scheduled-guesses\` lists what's pending;
\`unschedule-guess <id|text>\` cancels one before it fires.

## Keep a tracking log (TRACKING.md)

Maintain \`${join(config.LIFE_TASKS_DIR, 'TRACKING.md')}\` as durable memory for
everything the user tells you about the **sentence** and **instance tasks** that is
NOT a direct task edit and not a hold — so nothing is lost between cycles: **new
information** ("the deadline moved", "they replied") and **status / decisions**
("waiting on Bob", "dropping Y"). Append, newest at the bottom, each entry dated.
**Before** resolving a sentence or surfacing a presumed task, check TRACKING.md and
the active \`deferrals\`, so you never re-raise something the user already set aside.

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
  superviseGateway();
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
  // The gateway runs on workhorse machines too: a FLIPPED instance's claude window
  // connects to 127.0.0.1, so routing must be local to the machine that owns it.
  superviseGateway();
  log('workhorse', `connecting to ${serverUrl} as ${workhorseId}`);
  superviseNode('workhorse', ['src/workhorse/index.js', serverUrl, workhorseId, workhorseName]);
}

// Terminate a process and everything under it.
//
// `taskkill /T /F` walks the tree itself, but it aborts the WHOLE call the moment one
// descendant refuses ("The operation attempted is not supported." — a job object or an
// integrity boundary), leaving the root and its siblings alive. So enumerate the tree
// and kill it leaf-first, tolerating a failure on any single process. taskkill's own
// error text is swallowed: a partial kill is reported once, by us, with a count.
function killTree(pid) {
  let pids = [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$ids=@(${Number(pid)}); $i=0; while ($i -lt $ids.Count) { ` +
      `$c = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($ids[$i])" | ` +
      `Select-Object -ExpandProperty ProcessId; if ($c) { $ids += $c }; $i++ }; $ids -join ','`],
      { windowsHide: true, timeout: 5000, encoding: 'utf-8' });
    pids = out.trim().split(',').map(Number).filter(Boolean);
  } catch { /* enumeration failed — fall back to the root alone */ }
  if (!pids.length) pids = [Number(pid)];
  let failed = 0;
  for (const p of pids.reverse()) { // leaf-first: a parent dying first reparents its children
    try { execFileSync('taskkill', ['/PID', String(p), '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); }
    catch { failed++; }
  }
  return { total: pids.length, failed };
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
  clearPrimaryInfo();
  if (primaryPid) {
    const r = killTree(primaryPid);
    if (r.failed) {
      log('main', `primary ${primaryPid}: stopped ${r.total - r.failed}/${r.total} processes; ` +
        `${r.failed} refused termination and are now orphaned (kill them by hand if ports stay held)`);
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
