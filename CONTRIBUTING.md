# Contributing to Execkee

Execkee is a personal Claude Code "life manager": a controller that runs a server (WebSocket hub + dashboard + the 30-minute cycle) and a pool of workhorses that launch and babysit Claude Code instances. It's niche and a little held-together-with-tape. This doc is for people who want to hack on it anyway. Read it before you open a PR — it'll save us both time.

## Running it locally

You need **Node 18+** and an authenticated **Claude Code** install (`claude --version` should work, and you should have logged in once so `~/.claude/.credentials.json` exists). Claude Pro/Max via `claude.ai` OAuth is assumed — not an API key — because Remote Control needs it.

Then:

```bash
npm install          # only dependency is `ws`
npm run server       # WebSocket hub on :7700, dashboard on :7701
npm run workhorse    # co-located workhorse, connects to the local hub
```

Or, on Windows, just run `.\execkee-controller.ps1` (or `bootstrap.ps1`/`bootstrap.sh` on a fresh box), which starts the server, a co-located workhorse, the primary Claude window, and opens the dashboard. `CONTROLLER-SETUP.md` walks a clean machine through it step by step.

Talk to the system through the **primary** Claude window or `node src/cli.js` (`status`, `sessions`, `manage <session-id>`, `create`, etc. — run it with no args for the full list).

## The controller / workhorse split

This shapes nearly every change, so internalize it:

- **Controller** = the single source of truth. Runs the hub, the dashboard, the cycle, the shared store under `~/.execkee/shared-store`, and the settings-sync canonical copy. There is one.
- **Workhorse** = a machine that actually runs Claude Code instances. It owns its *own* `~/.claude/projects` (so adoptable sessions are per-workhorse), keeps a local mirror of state, and connects to the controller over the WebSocket on :7700. There can be many, including one co-located on the controller box.

When you add a feature, be clear about which side owns the state and which side just renders or relays it. The controller aggregates; the workhorse executes. Don't make the controller reach into a workhorse's filesystem directly — it goes through the connection.

## It couples to undocumented Claude Code internals — expect breakage

Execkee is built on top of things Claude Code does not promise to keep stable: the on-disk transcript format under `~/.claude/projects`, session/credential file locations, Remote Control behavior, and — most fragile of all — the **TUI-scraping probe**.

The probe (`src/workhorse/probe.js` + `probe-win.js`) generates status reports by driving the *live* instance window: it attaches to the instance's console (Windows `AttachConsole` + `ReadConsoleOutputCharacter`/`WriteConsoleInput`), reads the rendered frame, injects a short report prompt when the window is idle, and scrapes the reply back out. It recognizes "busy", "ready", "at a permission prompt", and "user is composing" purely by **regex against the rendered TUI text** ("esc to interrupt", "shift+tab", `> `, box-drawing glyphs, the "Baked for Ns" footer, …).

This *will* break when Claude Code changes its TUI, footer strings, or console rendering. When it does:

- Symptoms are things like: the probe never settles, re-fires on an unchanged session every cycle, injects into the wrong state, or scrapes garbage into the summary.
- The probe is **opt-in-able-out**: it's on by default but degrades to the fork-from-transcript report whenever the live window doesn't behave as expected, and you can hard-disable with `EXECKEE_PROBE_REPORTS=0`.
- Fixes usually live in the heuristic functions (`isBusy`, `looksReady`, `isInteractivePrompt`, `userComposing`, `CHROME_RE`) and the marker extraction. Keep the **safety invariants**: never inject mid-inference, never inject into a permission/trust prompt, never inject while the user is typing, and err toward "skip" on ambiguity. A wrong guess here can answer a real dialog or splice text into the user's keystrokes.
- macOS probe support is a stub (`probe-mac.js` reports unsupported and falls back). Windows is the validated path.

If a Claude Code update breaks something, that's expected — file an issue noting the CC version, don't assume the code was wrong.

## No secrets

Do not commit credentials, tokens, OAuth state, API keys, session transcripts, or anything from `~/.claude` or `~/.execkee`. Those directories live outside the repo on purpose and must stay there. No secrets in code, comments, commit messages, test fixtures, screenshots, or logs (logs under `~/.execkee/logs` can contain conversation text — never paste them into an issue without scrubbing). There is no `.env` convention here; runtime config is environment variables (see `src/common/config.js`) and the user's own Claude login. If a PR adds a secret, it gets rejected.

## Coding style

- **Node ESM**, `"type": "module"`. Use `import`/`export`, not `require`.
- **No build step, no transpile, no bundler.** What you write is what runs. Don't add TypeScript, a compiler, or a framework. Keep the dependency list tiny — `ws` is currently the only runtime dependency, and we'd like to keep it that way.
- Plain `node src/...` is how everything starts; the `npm` scripts in `package.json` are thin wrappers. New entry points should follow that pattern.
- Match the surrounding code: small modules, comments that explain *why* (especially around the probe and the cycle, where the reasoning is non-obvious), no clever metaprogramming.
- No vertical-alignment padding, no reformatting churn unrelated to your change. Keep diffs about the change.
- It's cross-platform-ish (Windows is primary, macOS partial). Don't hardcode Windows-only assumptions outside the `*-win` files, and don't break the macOS fallback paths.

## Filing issues and PRs

- **Bugs / ideas:** open a GitHub issue. For probe/TUI breakage, include your **Claude Code version**, OS, and the relevant tail of `node src/cli.js logs workhorse` (scrubbed of conversation content and secrets). There's also an in-tool backlog — `node src/cli.js issue add "<text>"` — handy for noting things while you're using it.
- **PRs:** keep them small and focused on one thing. Say what you changed and, for anything touching the probe, the cycle, or the controller/workhorse protocol, *why* and how you tested it (this codebase is sparse on automated tests, so describe your manual verification). Don't bundle unrelated reformatting. Note any new environment variable or behavior change to the defaults.
- Known limitations and rough edges are tracked in `STATUS.md` ("Known issues") — check there before reporting; it's probably already on the list.

This is a small tool maintained in spare time. Pragmatic, working contributions are very welcome; please don't be offended if a change is declined for adding surface area we don't want to maintain.
