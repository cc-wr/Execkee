# Security Policy

Execkee is a personal, single-operator rig — not a hosted service, not a multi-user product. It runs entirely on machines you own and control. This document states its trust model honestly and tells you how to report a vulnerability.

## Trust model

Execkee is **invasive by design**, and that is the most important security fact about it. It is not a sandboxed tool that touches a narrow slice of your system; it drives live Claude Code sessions and reads and writes parts of your `~/.claude` configuration. Run it only on machines you own, with conversations you are willing to have it read.

Specifically, Execkee:

- **Injects a session hook into every managed instance.** Managed windows launch with `claude --settings <file>` registering `SessionStart` and `UserPromptSubmit` hooks that run `src/instance-hook.js`. The hook fires on launch/resume/compact and on every prompt you submit in that window, and it reads your prompt text to intercept the control words `hide` and `close`. The hook is session-scoped (written under `~/.execkee`, passed via `--settings`); it does **not** edit your global `~/.claude/settings.json`.

- **Runs the primary window with `--dangerously-skip-permissions`.** The primary control surface launches with permission prompts disabled, every time, with no opt-out flag, and is meant to act unattended. Adopted/created instances get normal permission prompts unless you explicitly pass `--full-permissions` / `--yolo`. The blast radius of skip-permissions is: the primary always, plus any instance you opt in.

- **Drives your live Claude windows (the "probe").** When an instance's on-disk transcript is stale, the cycle generates status by driving the live window — Win32 console automation on Windows, AppleScript against Terminal.app on macOS. **This appends a real (benign) turn to your actual conversation**: the probe injects a short status-report prompt instructing the model to change no files, then reads it back. It is guarded to inject only when the window looks idle and falls back to the transcript fork on anything unexpected. On by default; opt out with `EXECKEE_PROBE_REPORTS=0`.

- **Reads your conversations.** The 30-minute cycle forks each managed instance's transcript (`claude -p --resume <id> --fork-session`) to synthesize a status report. This is local, but it means Execkee loads the full content of the sessions it manages into a model context.

- **Reads and writes parts of `~/.claude` for settings sync.** With more than one machine connected, Execkee keeps two files in sync across nodes (last-write-wins by mtime, content-hash loop-guarded, with a `.execkee-bak` backup before each overwrite): `~/.claude/settings.json` and your **global** `~/.claude/CLAUDE.md`. Sync is an explicit allowlist of exactly those two basenames directly under `~/.claude` — no globbing, no recursion, no directories (`src/common/settings-sync.js`). By construction it cannot touch `.credentials.json`, `.claude.json`, `sessions/`, `projects/`, `history.jsonl`, or `cache/`. On by default; opt out with `EXECKEE_SETTINGS_SYNC=0`.

- **Enables Claude Code's native Remote Control by default.** Managed instances and the primary launch with `--remote-control`, routing through Anthropic's Remote Control bridge when a remote client attaches — the same path Claude Code itself uses. On by default; opt out with `EXECKEE_REMOTE_CONTROL=0`.

## Everything stays on your own machines

There is no Execkee server, no telemetry, and no third party in the data path. Execkee does not phone home. The only network traffic it originates is the controller↔workhorse WebSocket on your own network; beyond that, whatever the `claude` CLI itself does is between you and Anthropic, exactly as it would be without Execkee. All of Execkee's own state — tracking, the shared store, the life-tasks folder, logs, generated hook-settings and launcher files — lives under `~/.execkee` and never in the repo.

**The controller↔workhorse link (port 7700) is unauthenticated.** It relies on running over a private network — a LAN behind a firewall, or Tailscale. Instance ids and window/PID handles arriving over that link are input-validated before reaching any shell or AppleScript, but the channel itself is trusted. **Do not expose port 7700 to the public internet.** Treat anyone who can reach 7700 as able to drive your fleet.

## No secrets in the repository

Execkee stores no credentials, tokens, or API keys in this repository, and it does not require any to be added. Authentication to Claude is handled entirely by the `claude` CLI's own login (a claude.ai OAuth session or whatever you have configured), which lives in your `~/.claude` — never in Execkee's source or its synced files. Please do not commit secrets, transcripts, or `~/.claude` / `~/.execkee` contents when contributing; keep local credentials out of any issue reports or logs you attach.

## Supported versions

Execkee is developed on the `master` branch of [github.com/cc-wr/Execkee](https://github.com/cc-wr/Execkee). Security fixes land on `master`; there is no separate maintenance branch. Run a current checkout.

## Reporting a vulnerability

If you find a security issue, please report it:

- **Preferred (private):** Use GitHub's private vulnerability reporting at [github.com/cc-wr/Execkee/security/advisories/new](https://github.com/cc-wr/Execkee/security/advisories/new). This keeps the report confidential until a fix is available.
- **Alternative:** Open a GitHub issue at [github.com/cc-wr/Execkee/issues](https://github.com/cc-wr/Execkee/issues). For anything you believe is sensitive, prefer the private advisory channel above rather than a public issue.

Please include what you observed, how to reproduce it, and the impact you see. As a single-operator personal project there is no SLA, but reports are taken seriously and acknowledged as promptly as is practical. There is no bug-bounty program.

## Scope

In scope: the Execkee code in this repository — the supervisor, server, workhorse adapters and probes, the instance hook, settings sync, and the controller↔workhorse protocol. Out of scope: vulnerabilities in the `claude` CLI, Node.js, Tailscale, or your operating system — report those to their respective maintainers. Misuse of the documented invasive behaviors above (skip-permissions, the probe, settings sync) is expected operation, not a vulnerability; the opt-out environment variables are provided for operators who want them off.

## License

MIT © 2026 cc-wr.
