# Execkee — Controller Setup (fresh Windows machine)

Step-by-step to stand up the **controller** on a machine that has nothing
installed. The controller runs the server (WebSocket hub + dashboard + the
30-minute cycle), a co-located workhorse, and the **primary** Claude Code
window you talk to. On one machine this *is* the whole system; workhorses on
other machines connect to it.

Target OS: **Windows 10/11**. No administrator rights are needed except the one
optional firewall step (§6). Commands are PowerShell unless noted.

---

## 1. Install Node.js (18+)

Execkee's server/supervisor run on Node.

```powershell
winget install OpenJS.NodeJS.LTS
```
(or download the LTS installer from https://nodejs.org)

**Close and reopen the terminal** so PATH updates, then verify:
```powershell
node --version    # must be v18 or higher
```

## 2. Install and authenticate Claude Code

The native installer (recommended) — in **PowerShell**:
```powershell
irm https://claude.ai/install.ps1 | iex
```
This installs `claude.exe` to `%USERPROFILE%\.local\bin\` and auto-updates.
(Alternatives: `winget install Anthropic.ClaudeCode`, or `npm install -g @anthropic-ai/claude-code`.)

**Close and reopen the terminal**, then verify and log in:
```powershell
claude --version
claude              # opens a browser to log in (Claude Pro/Max or Console); then exit with /exit
```
Credentials are saved to `%USERPROFILE%\.claude\.credentials.json` — you log in once.

## 3. Get the Execkee repo onto the machine

With Git:
```powershell
git clone https://github.com/cc-wr/Execkee.git Execkee
cd Execkee
```
Or copy the `Execkee` folder over (USB / network share) and `cd` into it.

## 4. Allow the launcher to run (once)

PowerShell may block local scripts. Either set the policy once:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
…or skip that and always start via the bypass form shown in §5.

## 5. Start the controller

From inside the `Execkee` folder:
```powershell
.\execkee-controller.ps1
```
…or, if you skipped §4:
```powershell
powershell -ExecutionPolicy Bypass -File .\execkee-controller.ps1
```

On first run it auto-runs `npm install`. Then it:
- starts the server (dashboard on **http://localhost:7701**, socket on **7700**),
- starts the co-located workhorse,
- opens the **primary** Claude Code window (your control surface),
- opens the dashboard in your browser.

**Leave this window open.** Press **Ctrl+C** in it to stop the whole system.

## 6. (Only if other machines will connect) open the firewall

The controller listens on TCP **7700** for workhorses. To allow remote
workhorses, run once **as Administrator**:
```powershell
New-NetFirewallRule -DisplayName "Execkee 7700" -Direction Inbound -Protocol TCP -LocalPort 7700 -Action Allow
```
Find the controller's LAN address for the workhorses to point at:
```powershell
ipconfig    # use the IPv4 Address, e.g. 192.168.1.50
```

## 7. Verify it's up

- Browser: **http://localhost:7701** shows the dashboard (day mode).
- The primary window greets you with the current status.
- `node src/cli.js status` lists the co-located workhorse as online.

You now talk to the **primary window** in plain language ("add a task…",
"adopt the conversation about X", "pull it up"). You don't need the CLI.

---

## Adding a workhorse (a second machine)

On the other machine, do **§1–§3** (Node, Claude Code, the repo), then:
```powershell
.\execkee-workhorse.ps1 -ControllerAddress <controller-LAN-ip>:7700 -Name "Machine-2"
```
It preflights `claude` + reachability, self-registers, and its instances show
up in the controller's dashboard and `status`. You only touch the new machine.

## Stopping / resetting

- **Stop:** Ctrl+C in the controller window.
- **Clean slate:** `.\scripts\reset.ps1` (clears local tracking/shared-store; leaves your Claude sessions and life-tasks intact).

## Gotchas

- **Reopen the terminal** after installing Node and Claude Code, or `node`/`claude` won't be found yet.
- The native `claude` install needs no Node; Node is for **Execkee itself**.
- **Git for Windows** is optional — only needed for the Bash tool *inside* instances; the system otherwise uses PowerShell.
- The system is **supervised-while-running** today: it lives only while the controller window is open. Surviving reboot/logout (a Windows service/scheduled task) is in progress (Phase 1).
