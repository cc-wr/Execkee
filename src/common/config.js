import { homedir, platform } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
// Data dir is overridable so a workhorse can keep its OWN local mirror separate
// from the controller's master — both on a real 2nd machine (its own ~/.execkee)
// and for same-box simulation/co-located workhorse (EXECKEE_DATA_DIR=...).
const DATA_DIR = process.env.EXECKEE_DATA_DIR || join(HOME, '.execkee');
const SHARED_STORE_DIR = join(DATA_DIR, 'shared-store');
const LIFE_TASKS_DIR = join(DATA_DIR, 'life-tasks');

for (const dir of [DATA_DIR, SHARED_STORE_DIR, LIFE_TASKS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export default Object.freeze({
  HOME,
  CLAUDE_DIR,
  DATA_DIR,
  SHARED_STORE_DIR,
  LIFE_TASKS_DIR,
  PLATFORM: platform(),

  TRACKING_FILE: join(DATA_DIR, 'tracking.json'),  // JSON instance/workhorse master store (tracking.js)
  STATE_FILE: join(DATA_DIR, 'state.json'),

  CYCLE_REPORT_FILE: join(SHARED_STORE_DIR, 'cycle-report.json'),
  SENTENCE_QUEUE_FILE: join(SHARED_STORE_DIR, 'sentence-queue.json'),
  DAILY_TASKS_FILE: join(SHARED_STORE_DIR, 'daily-tasks.json'),
  // Today's plan: confirmed backlog items + tentative LLM guesses (reset daily).
  DAILY_PLAN_FILE: join(SHARED_STORE_DIR, 'daily-plan.json'),
  DAILY_PLAN_ARCHIVE_FILE: join(SHARED_STORE_DIR, 'daily-plan-archive.json'),
  // Structured deferrals the cycle filters presumed tasks against (deterministic).
  DEFERRALS_FILE: join(SHARED_STORE_DIR, 'deferrals.json'),
  // User-scheduled guessed tasks that surface as tentative on/after a start date.
  SCHEDULED_GUESSES_FILE: join(SHARED_STORE_DIR, 'scheduled-guesses.json'),
  RESOLUTIONS_FILE: join(SHARED_STORE_DIR, 'resolutions.json'),
  DASHBOARD_DATA_FILE: join(SHARED_STORE_DIR, 'dashboard-data.json'),
  SENSITIVITY_FILE: join(SHARED_STORE_DIR, 'sensitivity.json'), // LLM sensitivity codings + manual overrides
  SENSITIVE_FLAG_FILE: join(SHARED_STORE_DIR, 'sensitive-flag.json'), // hide-sensitive toggle (own file: state.json is hub-rebuilt, sensitivity.json is RMW'd across model calls)
  LIFE_TASKS_FILE: join(LIFE_TASKS_DIR, 'tasks.json'),
  TRACKING_LOG_FILE: join(LIFE_TASKS_DIR, 'TRACKING.md'),  // primary's markdown log (context-sources.js) — NOT the JSON store
  // Manifest of extra files the cycle synthesis reads as context (a life-tasks
  // .docx, notes, etc.) — { sources: [{ path, label }] }.
  CONTEXT_SOURCES_FILE: join(LIFE_TASKS_DIR, 'context-sources.json'),
  ISSUES_FILE: join(DATA_DIR, 'issues.json'),

  WS_PORT: 7700,
  HTTP_PORT: 7701,

  CYCLE_INTERVAL_MS: 30 * 60 * 1000,
  CRASH_RETRY_MAX: 5,
  CRASH_RETRY_BASE_MS: 2000,
  // Report fork tries the session's own model first; if that fails (e.g. the
  // session's model is unavailable), it falls back to these in order. Haiku is
  // first: it is fast and summarizes fine; sonnet can time out on large sessions.
  REPORT_FALLBACK_MODELS: ['haiku', 'sonnet'],
  REPORT_TIMEOUT_MS: 180_000,
  HEARTBEAT_INTERVAL_MS: Number(process.env.EXECKEE_HEARTBEAT_MS) || 30_000,
  RECONNECT_INTERVAL_MS: 5000,

  // Bidirectional Claude-settings sync (settings-sync.js). On by default; set
  // EXECKEE_SETTINGS_SYNC=0 to disable. Canonical store lives on the controller.
  SETTINGS_SYNC_ENABLED: process.env.EXECKEE_SETTINGS_SYNC !== '0',
  SETTINGS_SYNC_POLL_MS: Number(process.env.EXECKEE_SETTINGS_POLL_MS) || 3000,
  SETTINGS_SYNC_FILE: join(SHARED_STORE_DIR, 'settings-sync.json'),

  // Launch managed instances + the primary with Claude Code's native Remote Control
  // (drive the window from claude.ai/code or the mobile app). ON by default; set
  // EXECKEE_REMOTE_CONTROL=0 to disable. It degrades gracefully — an RC-ineligible
  // machine still launches the window normally — so no fallback is needed. Requires
  // claude.ai OAuth login (not API key) + Pro/Max plan.
  REMOTE_CONTROL_ENABLED: process.env.EXECKEE_REMOTE_CONTROL !== '0',

  // "Probe report": generate status reports by driving the LIVE instance window
  // (read its console frame, inject a short report prompt, read the reply) instead
  // of forking its on-disk transcript — which is stale when a session is driven via
  // Remote Control. ON by default; set EXECKEE_PROBE_REPORTS=0 to disable. It appends
  // a probe turn to the user's real conversation, but only when idle (never mid-
  // inference / at a permission prompt / unchanged) and falls back to the fork report
  // whenever the live window doesn't behave as expected. See probe.js.
  PROBE_REPORTS_ENABLED: process.env.EXECKEE_PROBE_REPORTS !== '0',
  PROBE_IDLE_SETTLE_MS: Number(process.env.EXECKEE_PROBE_SETTLE_MS) || 1500,
  PROBE_SETTLE_SAMPLES: Number(process.env.EXECKEE_PROBE_SETTLE_SAMPLES) || 12,
  PROBE_POLL_MS: Number(process.env.EXECKEE_PROBE_POLL_MS) || 3000,
  PROBE_TIMEOUT_MS: Number(process.env.EXECKEE_PROBE_TIMEOUT_MS) || 300_000,
  // After injecting, the model must start responding (go busy or emit a marker)
  // within this window or the probe is judged "not accepted" (TUI not behaving as
  // expected, e.g. the prompt never submitted) and falls back to the fork report.
  PROBE_ACCEPT_MS: Number(process.env.EXECKEE_PROBE_ACCEPT_MS) || 60_000,
  // Unchanged-guard: a session counts as unchanged (skip re-probing) while the last
  // probe's marker is still within this many chars of the frame's tail. Short chrome
  // (input box, status bar, "Baked for Ns" footer) keeps it there; a real new turn
  // pushes it out. Chrome-agnostic — no need to enumerate TUI footer strings.
  PROBE_UNCHANGED_TAIL_CHARS: Number(process.env.EXECKEE_PROBE_TAIL_CHARS) || 1200,
  // Some instances treat the injected probe as a prompt-injection attempt and decline
  // it (reply in plain text, no markers — see example.txt). After this many CONFIRMED
  // refusals the live-probe is disabled for that instance and reports fall back to the
  // fork, so we stop re-injecting into a conversation that keeps refusing. The count is
  // a rolling window anchored on the first refusal: it expires (and the probe is
  // re-tested) after PROBE_REFUSE_WINDOW_MS, so a false positive self-heals ~weekly.
  // Sensitivity classification (sensitivity.js): how long the batched classifier call
  // may take before we give up and fail closed (treat the batch as sensitive).
  SENSITIVITY_TIMEOUT_MS: Number(process.env.EXECKEE_SENSITIVITY_TIMEOUT_MS) || 120_000,
  PROBE_REFUSE_LIMIT: Number(process.env.EXECKEE_PROBE_REFUSE_LIMIT) || 3,
  PROBE_REFUSE_WINDOW_MS: Number(process.env.EXECKEE_PROBE_REFUSE_WINDOW_MS) || 7 * 24 * 60 * 60 * 1000,

  // Local LLM gateway (agentgateway). Routes model names to providers so one Claude
  // Code session can use both Anthropic models (via the user's OWN subscription OAuth —
  // the gateway holds no Anthropic key; empty provider params = auth passthrough) and
  // DeepSeek models (keyed via DEEPSEEK_API_KEY). Machine-verified 2026-09-02 (F1).
  // The supervisor runs one gateway per machine; the PRIMARY always routes through it,
  // workhorse instances do NOT by default — `flip <id>` toggles one (quit + relaunch).
  // A non-Anthropic model the gateway also serves. Gateway-routed sessions get it as a
  // /model picker entry via ANTHROPIC_CUSTOM_MODEL_OPTION, which ADDS an entry without
  // replacing the built-in aliases — fable/opus/haiku keep working exactly as before.
  // (Claude Code's own gateway discovery can't be used here: it is skipped entirely
  // unless ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, and setting either would
  // replace the subscription OAuth credential this whole design exists to preserve.
  // Verified 2026-09-02: with OAuth, Claude Code never requests GET /v1/models.)
  // The [1m] suffix declares the model's 1M context window to Claude Code, which
  // otherwise assumes 200k for a model outside its catalog and auto-compacts a
  // gateway-routed session five times earlier than it needs to. The suffix is
  // client-side only — Claude Code strips it before the wire, so the gateway still
  // matches the plain `deepseek-v4-flash` route (verified 2026-09-02: the literal
  // suffixed id instead falls through the wildcard to Anthropic and 401s).
  GATEWAY_CUSTOM_MODEL: process.env.EXECKEE_GATEWAY_CUSTOM_MODEL || 'deepseek-v4-flash[1m]',
  GATEWAY_CUSTOM_MODEL_NAME: process.env.EXECKEE_GATEWAY_CUSTOM_MODEL_NAME || 'DeepSeek v4 Flash',
  // The PRIMARY (controller) session runs DIRECT to Anthropic by default — it is the
  // control surface, so it stays on the plainest possible path and is never affected
  // by the gateway being down, mid-restart, or lagging a Claude Code beta. Set
  // EXECKEE_GATEWAY_PRIMARY=1 to route it through the gateway (gaining the deepseek
  // models in its own /model picker). Workhorse instances are unaffected either way:
  // they are direct by default and opt in per instance via `flip`.
  GATEWAY_PRIMARY: process.env.EXECKEE_GATEWAY_PRIMARY === '1',
  GATEWAY_ENABLED: process.env.EXECKEE_GATEWAY !== '0',
  GATEWAY_PORT: Number(process.env.EXECKEE_GATEWAY_PORT) || 4000,
  GATEWAY_URL: `http://127.0.0.1:${Number(process.env.EXECKEE_GATEWAY_PORT) || 4000}`,
  GATEWAY_DIR: join(DATA_DIR, 'agentgateway'),

  WINDOW_TITLE_PREFIX: 'Execkee',
});
