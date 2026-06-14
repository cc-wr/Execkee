# Execkee

A controller-and-workhorse system that manages permanent Claude Code instances,
runs a 30-minute life-tracking loop, and surfaces the single most pressing issue
on a live dashboard you answer in natural language. See
[`claude-life-manager-architecture.md`](./claude-life-manager-architecture.md) for
the full design (and Codicil A for the Phase-0 implementation decisions).

This is the **Phase 0** build: controller and one workhorse co-located on a single
Windows machine.

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

On the other machine, with Execkee checked out:

```powershell
.\execkee-workhorse.ps1 -ControllerAddress <controller-host>:7700 -Name "Work-Laptop"
```

It self-registers upward; the controller needs no configuration. (Real
cross-machine behavior is Phase 1 — see §9 / Codicil A.10.)

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
node src/cli.js manage <session-id> "Name"  # adopt a session (--baseline / --open)
node src/cli.js create "Name" [path]        # new managed instance
node src/cli.js foreground <instance-id>    # pull up
node src/cli.js hide <instance-id>          # background
node src/cli.js close <instance-id>         # close permanently
node src/cli.js sentence                    # current dashboard sentence
node src/cli.js resolve <issue-id> "msg"    # resolve a dashboard issue
```

**Inside any managed instance window**, typing `hide` backgrounds it and typing
`close` closes it (intentional close, not a crash). The window's X button is
disabled so it can never accidentally kill an instance.

## A guided walkthrough of the full loop

1. Start the controller (above). Talk to the primary or use the CLI.
2. Add a task — tell the primary "add: file the quarterly taxes, due yesterday,
   high priority" (it writes the life-tasks store).
3. Adopt a real session: `node src/cli.js sessions` then
   `node src/cli.js manage <id> "Some Work" --baseline`.
4. Force a cycle now instead of waiting 30 min:
   `Invoke-WebRequest -Uri http://localhost:7701/api/run-cycle -Method POST -Body '{}' -ContentType 'application/json'`
5. Watch the dashboard show a conversational sentence for the top issue.
6. Resolve it (via the primary, or `node src/cli.js resolve <issue-id> "done">`) and
   watch the dashboard promote the next sentence live.

## Reset for a clean test

```powershell
.\scripts\reset.ps1
```

Stops Execkee processes and clears the tracking file + shared store. Your
life-tasks and on-disk Claude sessions are left intact.

## Layout

```
execkee-controller.ps1   one-command controller launcher
execkee-workhorse.ps1     one-command workhorse launcher (machine 2+)
src/supervisor.js         keeps server + subcontroller + primary alive
src/server/               WebSocket hub, dashboard (HTTP + SSE), cycle wiring
src/workhorse/            subcontroller, Windows adapter, report fork, instances
src/cowork.js             the 30-minute cycle (synthesis -> sentences)
src/instance-hook.js      in-instance hide/close hook (injected per session)
src/cli.js                operator CLI
dashboard/index.html      the live dashboard
scripts/reset.ps1         clean-slate helper
```

Ports: WebSocket **7700**, dashboard **7701**. Data: `~/.execkee`.
