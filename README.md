# Execkee

A controller-and-workhorse system that manages permanent Claude Code instances,
runs a 30-minute life-tracking loop, and surfaces the single most pressing issue
on a live dashboard you answer in natural language. See
[`claude-life-manager-architecture.md`](./claude-life-manager-architecture.md) for
the full design (and Codicil A for the Phase-0 implementation decisions).

This is the **Phase 0** build: controller and one workhorse co-located on a single
Windows machine.

## Install on a fresh machine (one line)

No prior setup needed — this installs Node.js, Claude Code, and Execkee (no admin,
no winget), then starts the controller. In **PowerShell**:

```powershell
irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1 | iex
```

You'll complete a one-time Claude Code browser login when prompted. To add a
workhorse on a second machine, point it at the controller's LAN address (shown in
the controller window on startup):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1))) -Mode workhorse -ControllerAddress <controller-ip>:7700
```

If you already have the repo and the prerequisites below, skip to **Start the
controller**.

## Prerequisites

- **Node.js** (18+) on `PATH`
- The **`claude`** CLI on `PATH` (used for the primary surface and for report forks)

## Start the controller (one command)

```powershell
.\execkee-controller.ps1
```

On first run it installs dependencies, then starts and **keeps alive**:

- the **server** — WebSocket hub + HTTP dashboard + the 30-minute cycle,
- a **co-located workhorse** subcontroller,
- the **primary** Claude Code window (in the life-tasks folder) — your control surface.

The dashboard opens at **http://localhost:7701**. Leave this window open; press
**Ctrl+C** to stop the whole system.

## Add a workhorse (machine 2+)

**Windows** — on the other machine, with Execkee checked out:

```powershell
.\execkee-workhorse.ps1 -ControllerAddress <controller-host>:7700 -Name "Work-Laptop"
```

**macOS** — one-line install (portable Node + Claude Code, no admin), then it
self-registers and starts:

```bash
curl -fsSL https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.sh \
  | bash -s -- --controller <controller-host>:7700 --name "Mac-Workhorse"
```

Day-2 starts are just `./execkee-workhorse.sh --controller <host>:7700`. To start it
at login, `./scripts/install-startup.sh --controller <host>:7700` installs a per-user
LaunchAgent (`--uninstall` removes it).

> **macOS one-time permission:** the workhorse drives Terminal.app via AppleScript to
> open/hide/show instance windows. The first time it does so, macOS asks *"… wants to
> control Terminal.app"* — **click OK once, at the Mac's screen** (a headless/login-time
> first run fails silently until approved). Run `./execkee-workhorse.sh` manually once and
> approve it before relying on login-startup.

It self-registers upward; the controller needs no configuration. The controller and
primary surface run on Windows; a macOS machine joins as a **workhorse**.

## Driving it

**Talk to the primary window** in natural language — it translates to the system:

- "pull up the claude code about the billing migration"
- "hide the current one"
- "manage the conversation about the tax filing"
- "the auth thing is handled, I merged the fix" (the primary resolves it only if
  your message actually resolves the displayed issue)

**Or use the CLI directly** (any terminal in the repo):

```powershell
node src/cli.js status                      # workhorses + instances
node src/cli.js sessions                    # sessions you can adopt
node src/cli.js manage <session-id> "Name"  # adopt (full baseline report by default; --from-now / --open)
node src/cli.js create "Name" [path]        # new managed instance
node src/cli.js foreground <instance-id>    # pull up
node src/cli.js hide <instance-id>          # background
node src/cli.js close <instance-id>         # close permanently
node src/cli.js sentence                    # current dashboard sentence
node src/cli.js resolve <issue-id> "msg"    # resolve a dashboard issue
node src/cli.js issue add "<text>"          # log an improvement/bug to the backlog
node src/cli.js issue                       # list open backlog items
node src/cli.js logs                         # list log files (sizes + mtimes)
node src/cli.js logs controller --tail 100   # tail a log (controller/workhorse/supervisor/primary-chat)
```

**Logs.** Each long-running process tees its full output to a rotating file under
`~/.execkee/logs/` (`controller.log` = server/hub/dashboard/cycle, `workhorse.log`,
`supervisor.log`), and the primary's conversation is tailed to `primary-chat.log`.
Check them with `node src/cli.js logs …` (or read the files directly) when something
misbehaves. Disable with `EXECKEE_LOG=off`; rotation cap is `EXECKEE_LOG_MAX_BYTES`.

Adopting a session produces a **full baseline report by default** and **auto-runs a
cycle** so the report appears at once (no manual refresh). Use `--from-now` to adopt
deltas-only.

**The improvement backlog.** As you use Execkee, tell the primary about rough edges
("log this for later: …") — it records them to `~/.execkee/issues.json`. Review them
later with `node src/cli.js issue` and address them in code.

**Inside any managed instance window**, typing `hide` backgrounds it and typing
`close` closes it (intentional close, not a crash). The window's X button is
disabled so it can never accidentally kill an instance.

## A guided walkthrough of the full loop

1. Start the controller (above). Talk to the primary or use the CLI.
2. Add a task — tell the primary "add: file the quarterly taxes, due yesterday,
   high priority" (it writes the life-tasks store).
3. Adopt a real session: `node src/cli.js sessions` then
   `node src/cli.js manage <id> "Some Work"` (baseline report + auto-cycle happen automatically).
4. Watch the dashboard show a conversational sentence for the top issue.
   (To force a cycle manually any time: `Invoke-WebRequest -Uri http://localhost:7701/api/run-cycle -Method POST -Body '{}' -ContentType 'application/json'`.)
5. Resolve it (via the primary, or `node src/cli.js resolve <issue-id> "done"`) and
   watch the dashboard promote the next sentence live.

## Reset for a clean test

```powershell
.\scripts\reset.ps1
```

Stops Execkee processes and clears the tracking file + shared store. Your
life-tasks and on-disk Claude sessions are left intact.

## Layout

```
execkee-controller.ps1    one-command controller launcher (Windows)
execkee-workhorse.ps1     one-command workhorse launcher (Windows, machine 2+)
execkee-workhorse.sh      one-command workhorse launcher (macOS, machine 2+)
bootstrap.ps1 / .sh       fresh-machine installers (Windows / macOS workhorse)
src/supervisor.js         keeps server + subcontroller + primary alive
src/server/               WebSocket hub, dashboard (HTTP + SSE), cycle wiring
src/workhorse/            subcontroller, report fork, instances, and the OS adapters:
  adapter.js                platform dispatcher (win32 -> adapter-win, darwin -> adapter-mac)
  adapter-win.js            Windows window/process control (PowerShell + Win32)
  adapter-mac.js            macOS window/process control (Terminal.app via AppleScript)
  probe.js / probe-win.js / probe-mac.js   "probe report" — drive the live window
                            for a report when its transcript is stale (on by
                            default; opt out with EXECKEE_PROBE_REPORTS=0)
src/cowork.js             the 30-minute cycle (synthesis -> sentences)
src/instance-hook.js      in-instance hide/close hook (injected per session)
src/cli.js                operator CLI
dashboard/index.html      the live dashboard
scripts/reset.ps1         clean-slate helper (Windows)
scripts/install-startup.* login-startup installer (Windows .ps1 / macOS .sh LaunchAgent)
```

Ports: WebSocket **7700**, dashboard **7701**. Data: `~/.execkee`.
