# Execkee — Status

_Last updated: 2026-06-15._

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
  - ✅ **Session discovery + adoption routing across machines** (this session): `sessions` is aggregated from every connected workhorse and **grouped by host**; `manage` auto-routes to the workhorse that owns the session (or `--on <workhorse-id>`); `create` takes `--on` to target a machine.
  - ✅ Controller is **brain-only by default** (workers on remote machines); set `EXECKEE_LOCAL_WORKHORSE=1` / `-WithLocalWorkhorse` for a co-located workhorse (single-machine). Stale `wh-local` records are purged from tracking on brain-only startup.
  - ✅ Bootstrap installs a real **git clone** (committable) and installs Git for Windows portably if missing; on re-run it **auto-`git pull --ff-only`**.
  - ⏳ Pending: boot-persistence (survive reboot/logout), `.claude` settings sync, dead-workhorse heartbeat detection, primary resume-on-restart.
  - ⏭️ Deferred: heterogeneous OS (Linux/macOS workhorses).

## Operating quick-reference

- **Controller (cscoo):** `irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1 | iex` then `\.\execkee-controller.ps1` (brain-only by default; add `-WithLocalWorkhorse` only for single-machine). Leave the window open.
- **Workhorse (this machine):** `\.\execkee-workhorse.ps1 -ControllerAddress 100.79.227.109:7700 -Name "Workhorse-2"` from the dev repo.
- **Talk to the primary** (on the controller) in natural language, or use the CLI there:
  - `node src/cli.js sessions [--all]` — adoptable sessions per workhorse
  - `node src/cli.js manage <session-id> [name] [--on <wh>]` — adopt (auto-routes to the session's workhorse)
  - `node src/cli.js create "<name>" [path] [--on <wh>]` — new instance on a chosen machine
  - `node src/cli.js status` — workhorses + instances
- **Update a deployed machine:** `git pull` in its `Execkee` folder + restart (or re-run the bootstrap, which now auto-pulls). Source is otherwise frozen at clone time.

## Known issues / future work

- **KI-1 — created instances don't capture a sessionId (crash-loop now fixed).** A `create`d instance records no `sessionId`. Previously, relaunching it ran `claude --resume undefined`, which built a malformed `ArgumentList` and **crash-looped** (seen in `log10` on `wh-local`). **Fixed:** a session-less instance now relaunches as a *fresh* window (`launchInstance` falls back to `createNewInstance`), and the launch helper drops empty argv tokens. **Still deferred:** capturing the new window's session id so a created instance can be *resumed with its context* and so `hide`/`foreground` track a real window.
- **KI-2 — cross-machine adoption: id-resolution fixed; full path still to confirm.** A truncated session id (the primary adopting `de9066ff` instead of the full id) caused "Session not found on disk" even for a listed session. Adoption now resolves a unique prefix to the full id (`resolveSessionId`). A complete cross-machine adoption (launch + first report on a remote workhorse) still needs a live end-to-end run, and is gated by KI-1.
- **KI-5 — closing the server doesn't close the primary surface (deferred).** Ctrl+C on the controller window triggers a shutdown that taskkills the primary, but killing only the server process (which the supervisor then restarts) leaves the primary open. Deferred — the server is slated to become a Windows service, which reshapes lifecycle/teardown anyway.
- **KI-3 — no boot persistence.** Controller and workhorse live only while their window/process runs; surviving reboot/logout (service or scheduled task) is pending.
- **KI-4 — resilience hardening pending.** Dead-workhorse heartbeat detection and primary resume-on-restart are not yet implemented.

## Verified this session

- Multi-machine session discovery: loopback (server + workhorse, isolated data dir) — `sessions` returned 66 real sessions grouped by workhorse via the `LIST_SESSIONS` round-trip.
- Workhorse↔controller link over Tailscale: connected + registered + received SYNC.
- Bootstrap on a fresh Restricted machine (cscoo): Node/Claude/Git present, login gate, `git clone`, `npm ci` (after the execution-policy fix) — controller came up.
