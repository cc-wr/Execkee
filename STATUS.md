# Execkee — Status

_Last updated: 2026-06-16._

A controller-and-workhorse system that manages permanent Claude Code instances,
runs a 30-minute life-tracking cycle, and surfaces the single most pressing issue
on a live dashboard answered in natural language via a primary Claude Code surface.
See [`claude-life-manager-architecture.md`](./claude-life-manager-architecture.md)
for the full design and its codicils.

## Current deployment

| Role | Machine | Location | Address | Notes |
|------|---------|----------|---------|-------|
| **Controller** | `cscoo` | `C:\Users\cscoo\Execkee` | Tailscale **100.79.227.109:7700** | Runs server (hub + dashboard `:7701` + 30-min cycle) + the primary Claude window. **Brain-only** (no co-located workhorse). |
| **Workhorse** | dev machine (`ccooley`) | `C:\Users\ccooley\Downloads\Execkee` | Tailscale `100.66.17.19` | `wh-ccooleypersonal` / "Workhorse-2". Runs/reports managed instances on this machine. |

- The two connect over **Tailscale** on port **7700** (verified reachable + registered). The LAN firewall rule for 7700 was **not** opened on the controller — use the Tailscale IPs, not the LAN IPs.
- Repo: **github.com/cc-wr/Execkee**, branch `master`, committed as `cc-wr`.

## Phase status

- **Phase 0 (single machine):** complete — create/adopt/hide/foreground/close, fork-reports with model fallback, 30-min cycle → dashboard sentence, in-instance hide/close hook.
- **Phase 1 (multi-machine):**
  - ✅ Workhorse decoupled from shared filesystem — instance **state** syncs over the socket (`SYNC` / `STATE_UPDATE`, master tracking on the controller).
  - ✅ **Session discovery + adoption routing across machines**: `sessions` is aggregated from every connected workhorse and **grouped by host**; `manage` auto-routes to the workhorse that owns the session (or `--on <workhorse-id>`); `create` takes `--on` to target a machine.
  - ✅ **Un-adopt / release**: `unmanage <id>` stops managing an instance (leaves its window running) and removes it from master tracking; the primary understands "release / un-adopt".
  - ✅ Controller is **brain-only by default** (workers on remote machines); set `EXECKEE_LOCAL_WORKHORSE=1` / `-WithLocalWorkhorse` for a co-located workhorse (single-machine). Stale `wh-local` records are purged from tracking on brain-only startup.
  - ✅ Bootstrap installs a real **git clone** (committable) and installs Git for Windows portably if missing; on re-run it **auto-`git pull --ff-only`**.
  - ✅ **Resilience — dead-workhorse detection**: the hub drops a connection silent for ~3 heartbeat intervals (~90s), not only on a clean socket close.
  - ✅ **Boot-persistence (logon)**: `scripts/install-startup.ps1` registers a no-admin Startup-folder launcher so the controller/workhorse starts at logon.
  - ✅ **Primary resume-on-restart** (KI-4): the supervisor captures the primary's session id from the life-tasks project dir and `--resume`s it on restart, falling back to a fresh launch on any miss (`launchPrimaryWindow`).
  - ✅ **Created-instance session capture** (KI-1): a session-less created instance now polls for the new transcript it writes, matches it by cwd, and adopts its session id locally; the controller folds it into master tracking first-write-wins — so crash-recovery / restart resume *with* context instead of starting fresh.
  - ✅ **Bidirectional settings sync** (`settings-sync.js`): the controller is the canonical store + rebroadcaster over the existing WS hub; each node watches its own `~/.claude` and reports genuine local edits; last-write-wins by mtime; loop-guarded by content hash. Synced files are an **explicit allowlist** — `settings.json` and the global `CLAUDE.md` only — so credentials/state (`.credentials.json`, `.claude.json`, `sessions/`, `history.jsonl`, …) cannot leak by construction. Off-switch: `EXECKEE_SETTINGS_SYNC=0`.
  - ⏳ Remaining: **before-logon service** (vs the logon-startup above); **make all sessions remote-control** = enable Claude Code's native remote-control through its interface (research pending); **resume reverts to stale state** (KI-6, below).
  - ⏭️ Deferred: heterogeneous OS (Linux/macOS workhorses).

## Operating quick-reference

- **Controller (cscoo):** `irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1 | iex` then `\.\execkee-controller.ps1` (brain-only by default; add `-WithLocalWorkhorse` only for single-machine). Leave the window open.
- **Workhorse (this machine):** `\.\execkee-workhorse.ps1 -ControllerAddress 100.79.227.109:7700 -Name "Workhorse-2"` from the dev repo.
- **Talk to the primary** (on the controller) in natural language, or use the CLI there:
  - `node src/cli.js sessions [--all]` — adoptable sessions per workhorse
  - `node src/cli.js manage <session-id> [name] [--on <wh>]` — adopt (auto-routes to the session's workhorse)
  - `node src/cli.js create "<name>" [path] [--on <wh>]` — new instance on a chosen machine
  - `node src/cli.js unmanage <id>` — release / un-adopt (stop managing; leaves the window running)
  - `node src/cli.js status` — workhorses + instances
- **Auto-start at logon:** `\.\scripts\install-startup.ps1` on the controller (add `-Mode workhorse -ControllerAddress <ip>:7700 -Name "..."` on a workhorse machine); `-Uninstall` removes it.
- **Update a deployed machine:** `git pull` in its `Execkee` folder + restart (or re-run the bootstrap, which now auto-pulls). Source is otherwise frozen at clone time.

## Known issues / future work

- **KI-1 — created-instance session capture (RESOLVED 2026-06-16).** A `create`d instance starts with no `sessionId`; on recovery it relaunched *fresh*, losing all conversation history accumulated since creation (the confirmed root cause of "recovery loses history" for created instances — seen live as the `inst-dtest` record with `sessionId: null`). **Fixed (commit `69e95f1`):** `createInstance` snapshots known session ids before launch, then `_captureCreatedSession` polls (fire-and-forget, ~24 s) for the new transcript, identifies it by cwd match, and stores its id locally via `updateInstance`; the next `STATE_UPDATE` carries it to the controller, which folds it first-write-wins (`hub.js`). The earlier crash-loop guard (session-less → fresh window via `createNewInstance`; helper drops empty argv tokens) remains as the safety net for instances whose capture misses.
- **KI-2 — cross-machine adoption: id-resolution fixed; full path still to confirm.** A truncated session id (the primary adopting `de9066ff` instead of the full id) caused "Session not found on disk" even for a listed session. Adoption now resolves a unique prefix to the full id (`resolveSessionId`). A complete cross-machine adoption (launch + first report on a remote workhorse) still needs a live end-to-end run, and is gated by KI-1.
- **KI-5 — closing the server doesn't close the primary surface (deferred).** Ctrl+C on the controller window triggers a shutdown that taskkills the primary, but killing only the server process (which the supervisor then restarts) leaves the primary open. Deferred — the server is slated to become a Windows service, which reshapes lifecycle/teardown anyway.
- **KI-3 — boot persistence: logon-startup added; before-logon pending.** `scripts/install-startup.ps1` auto-starts Execkee at logon (no admin). A before-logon Windows **service / scheduled task** (runs without an interactive session) is still pending.
- **KI-6 — resume reverted to stale conversation state (FIX IMPLEMENTED 2026-06-16; needs live verification).** Reported: the brain resuming the **primary surface** keeps coming back to the same old state; **workhorse** instances had the identical problem. **Corrected diagnosis** (via Claude Code docs): `claude --resume <id>` *continues* the same id in both interactive and headless mode — it does NOT auto-fork. So staleness = the *stored* id isn't the *live* one: (1) the primary's `resumablePrimarySession()` returned null (capture miss / cwd-gate / missing file) → **fresh seeded relaunch every restart**; (2) the hub folded `sessionId` first-write-wins → a live-id change was ignored and a stale id re-synced. **Fix:** (a) the in-instance hook (`instance-hook.js`) captures the exact live `session_id` on every prompt and updates the stored id on change (unit-verified); (b) the hub now accepts any non-empty `sessionId` change; (c) the supervisor refreshes `primary-session.json` to the newest life-tasks session on a 15 s timer and `resumablePrimarySession()` falls back to it instead of a fresh seed. Couldn't reproduce locally (the 9 live workhorse instances all had stored==live; the primary runs on the controller). Still needs a live restart test on the new code.

- **KI-4 — resilience: dead-detection + primary-resume both shipped.** The hub drops silent/dead workhorse connections via heartbeat (~90s). **Primary resume-on-restart** is implemented (commit `a55c633`): `launchPrimaryWindow` captures the primary's session id from the life-tasks project dir and `--resume`s it across restarts, falling back to a fresh seeded launch on any miss.

## Bug review — "session finding" + "recovery loses history" (2026-06-16)

A rigorous review of two reported bugs. Method: empirical (live process/transcript
inspection + a headless and an interactive `--resume` test), no destructive changes.

**Bug A — "can't find sessions where the tokens aren't loaded."** Not a filtering
bug. `listLocalSessions` enumerates *every* `.jsonl` one level under each
`~/.claude/projects/<slug>` with no size/content/"token" filter; subagent
transcripts (nested under `subagents/`) are correctly excluded. The real cause is
**topology/connectivity**: `hub.listSessions()` fans out only to *connected*
workhorses, so (a) a session on the brain-only controller's own machine is never
enumerated (no local workhorse to ask), and (b) a workhorse that is momentarily
disconnected (heartbeat reconnect) yields an empty list. The CLI already prints
"No workhorses connected" / per-host "(could not list: …)". *Recommended follow-up
(not yet done):* also surface the controller-local sessions, and a per-host count.

**Bug B — "recovery loses history since initial adopt."** Two distinct paths:
  - **Created instances (root cause, FIXED):** a created instance had no `sessionId`,
    so crash/restart recovery relaunched it as a *fresh* session — total history loss.
    Confirmed live (`inst-dtest`, `sessionId: null`). Fixed by KI-1 (`69e95f1`).
  - **Adopted instances (recovery is correct):** `_launchAndMonitor` relaunches with
    the stored `sessionId`, the session's own cwd (`projectPath` = `getSessionCwd`),
    and the stored `skipPermissions`. `claude --resume <id>` (no `--fork-session`)
    **continues** the same session — verified headless (recalled a planted codeword;
    same session id, no fork) and the 9 live managed instances all resume valid ids.
    An interactive `--resume` launch created **no** fork file either (forking is
    governed by `--fork-session`, which we never pass).
  - **Secondary (not history loss):** instances adopted *without* `--full-permissions`
    relaunch without `--dangerously-skip-permissions` (all but one live instance had
    `skipPermissions: null`) and will block at permission prompts on recovery — which
    can *look* like "recovery isn't working." Per-instance choice at adopt time;
    *recommended follow-up:* pre-trust an adopted instance's folder on the workhorse
    (as the primary already does) so a recovered window isn't stuck behind a trust
    prompt.

## Verified this session

- Multi-machine session discovery: loopback (server + workhorse, isolated data dir) — `sessions` returned 66 real sessions grouped by workhorse via the `LIST_SESSIONS` round-trip.
- Workhorse↔controller link over Tailscale: connected + registered + received SYNC.
- Bootstrap on a fresh Restricted machine (cscoo): Node/Claude/Git present, login gate, `git clone`, `npm ci` (after the execution-policy fix) — controller came up.
- Un-adopt: loopback adopt (`--open`) → `unmanage` → instance removed from master and stayed removed across state-updates.
- Heartbeat dead-detection: a deliberately silent client was dropped by the hub after ~3 intervals.
- `resolveSessionId('de9066ff')` → full id (short-id adoption); session-less launch no longer crash-loops (regenerated helper parses clean).
- Boot-startup installer: parses clean; `-Uninstall` runs with no side effects.
- **2026-06-16:** Resolved a stash-pop conflict in `instances.js` (KI-1) — `node --check` clean across all core source files, no leftover conflict markers. `listLocalSessions` enumerates all 44 real sessions in the repo project (no filtering bug). Headless `claude --resume <id>` recalled a planted codeword and produced no fork; an interactive `--resume` produced no fork file. Live: 9 managed instances resuming valid session ids; `inst-dtest` confirmed as the session-less (history-losing) created instance KI-1 addresses.
