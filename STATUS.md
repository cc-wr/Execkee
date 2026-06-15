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
  - ✅ Controller can run **brain-only** (`EXECKEE_NO_LOCAL_WORKHORSE` / `execkee-controller.ps1 -NoLocalWorkhorse`).
  - ✅ Bootstrap installs a real **git clone** (committable) and installs Git for Windows portably if missing; on re-run it **auto-`git pull --ff-only`**.
  - ⏳ Pending: boot-persistence (survive reboot/logout), `.claude` settings sync, dead-workhorse heartbeat detection, primary resume-on-restart.
  - ⏭️ Deferred: heterogeneous OS (Linux/macOS workhorses).

## Operating quick-reference

- **Controller (cscoo), brain-only:** `irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1 | iex` then run `\.\execkee-controller.ps1 -NoLocalWorkhorse` (or bootstrap via the scriptblock form with `-NoLocalWorkhorse`). Leave the window open.
- **Workhorse (this machine):** `\.\execkee-workhorse.ps1 -ControllerAddress 100.79.227.109:7700 -Name "Workhorse-2"` from the dev repo.
- **Talk to the primary** (on the controller) in natural language, or use the CLI there:
  - `node src/cli.js sessions [--all]` — adoptable sessions per workhorse
  - `node src/cli.js manage <session-id> [name] [--on <wh>]` — adopt (auto-routes to the session's workhorse)
  - `node src/cli.js create "<name>" [path] [--on <wh>]` — new instance on a chosen machine
  - `node src/cli.js status` — workhorses + instances
- **Update a deployed machine:** `git pull` in its `Execkee` folder + restart (or re-run the bootstrap, which now auto-pulls). Source is otherwise frozen at clone time.

## Known issues / future work

- **KI-1 — managed-instance launch is broken (from `log8`).** On a workhorse, `create` (and adoption that must launch a window) records an instance but **never launches a real Claude window**: `Session: undefined`, and `hide`/`foreground` fail with "externally held or not launched". Created instances also never capture a `sessionId`, so they can't crash-recover. The `create → launch → capture sessionId` path needs a real fix. Removing the co-located workhorse sidesteps this on the controller, but it still affects remote workhorses. **Future.**
- **KI-2 — `manage` routing not yet runtime-tested cross-machine.** The auto-route / `--on` logic is built on the verified `/api/sessions` aggregation and syntax-checked, but a real cross-machine adoption hasn't been exercised end-to-end yet.
- **KI-3 — no boot persistence.** Controller and workhorse live only while their window/process runs; surviving reboot/logout (service or scheduled task) is pending.
- **KI-4 — resilience hardening pending.** Dead-workhorse heartbeat detection and primary resume-on-restart are not yet implemented.

## Verified this session

- Multi-machine session discovery: loopback (server + workhorse, isolated data dir) — `sessions` returned 66 real sessions grouped by workhorse via the `LIST_SESSIONS` round-trip.
- Workhorse↔controller link over Tailscale: connected + registered + received SYNC.
- Bootstrap on a fresh Restricted machine (cscoo): Node/Claude/Git present, login gate, `git clone`, `npm ci` (after the execution-policy fix) — controller came up.
