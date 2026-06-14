# Claude Code Life Manager — Architecture

> A controller-and-workhorse-pool system where a lightweight controller orchestrates permanent Claude Code instances across one or more workhorse machines (any of Windows, Linux, or macOS), drives a 30-minute life-tracking loop, and surfaces issues on a dashboard you can respond to in natural language.

---

## 1. Goals

- **One brain for life management.** A primary Claude Code instance on the controller manages your tasks, the dashboard, and every Claude Code instance across the workhorse pool.
- **Permanent instances.** No Claude Code instance is ever closed. "Closing" means backgrounding/hiding; the conversation survives.
- **Hands-free life tracking.** A scheduled task runs every 30 minutes, pulls reports from any recently-active instance, updates a daily task list, and refreshes an HTML dashboard.
- **A single point of attention.** The dashboard shows one sentence for the most pressing issue. You reply by typing into the primary Claude Code; the issue is marked resolved on the next cycle.
- **Natural-language control of remote work.** "Pull up the claude code about XYZ" or "hide current claude code" are spoken to the primary, which routes them through the server to the relevant workhorse's subcontroller.

---

## 1a. Load-bearing principles

These are stated separately because the whole design leans on them.

- **Permanence makes non-pollution non-negotiable.** Because no instance is ever closed, every conversation is a long-lived life-tracking asset. A report must therefore never be written into the working conversation. This is *why* reporting uses a discarded **session fork** rather than injecting into the live session — the working session is never touched, so there is nothing to clean up.
- **Visibility is the lock.** An instance in the **foreground is held by the workhorse user**; an instance in the **background is available to the subcontroller**. These are the same axis, not two: the subcontroller only ever reports on hidden instances, and while it holds a hidden instance for a report, the user cannot pull it up (the pull-up is refused). This is *why* foregrounding and reporting can never collide.
- **Reports feed the daily plan.** Data flows in one direction: instance reports → life tracking → daily task lists → dashboard. The reports are not just logged; they are an *input* to what the next day's tasks become.
- **The system is time-aware.** Every scheduled cycle is evaluated *as of* the real current date/time. The day-of governs which daily list is active and when it rolls over; due/overdue/upcoming status and all time-relative phrasing depend on it. Time is an input to prioritization, not an afterthought.

---

## 2. Machine layout: one controller, a pool of workhorses

The system is **one controller and N workhorses**. There is nothing special about any single workhorse; "Machine 2" is just the first one. Workhorses are a **heterogeneous pool** — each may run Windows, Linux, or macOS — and the controller treats them uniformly through a per-workhorse adapter (§2a).

### The Controller (lightweight, your primary surface)
- **Primary Claude Code instance** — what you talk to directly. It runs in (and actively maintains) the **life-tasks project folder** — adding, updating, and completing tasks there as you talk to it. It owns the dashboard and is the command surface for every workhorse (it issues intents to the server, §the link).
- **Persistent server process** — the always-on hub. Holds the socket connections from all workhorse subcontrollers, pushes commands down, receives state/reports up, and writes them to a known file location.
- **Scheduled Claude Cowork task** — runs every 30 min. Generates the daily task list, reads its input locations (the server's file location for instance reports/state **and the life-tasks project folder the primary maintains**), authors the cycle report, and updates the dashboard. Does not touch workhorses directly.
- **Source of truth** for: the life-tasks project folder (§4.8), daily task lists, the HTML dashboard, dashboard-issue resolution state, and the master copy of the instance tracking file (which spans *all* workhorses).

Every instance is globally addressed as `(workhorse_id, instance_id)` so the server can route any command to the right subcontroller.

### A Workhorse (any OS, where real work happens)
- **N permanent Claude Code instances**, one per project/topic, each inside an application wrapper.
- **A persistent subcontroller process** — maintains the socket up to the server, owns this machine's adapter, and drives its local instances on command.
- **A local mirror** of the tracking records for *its own* instances.
- **A startup script** that brings its instances back up on boot, resuming conversations as needed, and (re)starts the subcontroller.

### The link: persistent server ↔ subcontroller (not SSH-per-command)

Control does **not** happen via one-off SSH commands. Instead:

- A **persistent server process runs on the controller.** It is the single hub for all workhorse communication.
- Each workhorse runs a **persistent subcontroller process** that opens and maintains a **network socket connection up to the server**. The subcontroller is the only thing on a workhorse that talks to the controller; it owns that machine's adapter (§2a) and its local instances.
- **Upward:** the subcontroller reports instance state, activity, and captured reports to the server. The server **writes these to a known file location** on the controller's filesystem.
- **Downward:** the server **pushes commands** to subcontrollers over the same connection — create / delete / hide / foreground an instance, request a report, etc.
- The **scheduled Cowork task does not talk to workhorses directly.** It reads the file location the server writes, and issues high-level intents to the server. This decouples the 30-minute cadence from live network I/O.

**Adding a workhorse is a one-sided operation.** You only touch the *new machine*: run a setup script and give it the **controller's address**. The subcontroller then **registers itself upward** — connects, subscribes, and begins reporting its instances. The controller needs no prior knowledge of the machine; registration is self-service from the workhorse side.

- On registration the server records the new workhorse, and its instances appear in the tracking file and the server's state file automatically.
- Both the **primary** and the **scheduled task** become aware of it through the server/state file — no reconfiguration of the controller.
- Removing/replacing a workhorse is the same in reverse: it drops its connection; the server marks it offline.

**The primary's server interfaces.** For natural-language control (§4.11) to work across a self-registering pool, the primary needs two concrete capabilities against the server:

1. **Query (read):** ask the server for the *current* set of workhorses and instances and their states — so "pull up the claude code about XYZ" can be resolved against whatever is registered right now, including workhorses added after the system started.
2. **Dispatch (write):** tell the server to send a command to a specific subscribed subcontroller (foreground / hide / create / delete / request-report on `(workhorse_id, instance_id)`).

The server is the single point that knows the live membership; the primary and scheduled task always go through it rather than holding their own connection list.

> **Direction note:** this intentionally revises the earlier "workhorse never reaches back" rule. The subcontroller *does* initiate the connection upward to the server. The server remains the authority on *what happens*; the socket is just the transport. A persistent connection (vs. SSH per action) avoids per-command auth/connection overhead, lets the server detect a dead workhorse immediately, and gives a single place to serialize commands.

---

## 2a. The workhorse adapter contract (OS-abstraction layer)

To keep the pool heterogeneous, every workhorse exposes the **same contract**; only the implementation differs by OS. The controller speaks the contract and never encodes OS-specific behavior.

The contract each adapter must provide:

- **list** — report this workhorse's instances and their state (foreground/hidden, session id, last-activity time).
- **foreground / hide** — bring an instance forward or background it (never terminate).
- **take / release** — mark a hidden instance as *held by the subcontroller* for a report, or release it back to *hidden, free*. (Foreground is the user's hold; there is no separate user lock — see §4.2.)
- **report** — produce a report from the instance's session **without polluting it**, via a headless session fork (see §4.3). No keystrokes, no window focus.
- **resume / start** — (re)create an interactive GUI instance and resume its conversation if needed.

Implementations:

- **Linux / macOS** — tmux-based; the mature open-source tooling (see §6a) implements most of this directly.
- **Windows** — native is viable now that reporting is programmatic: a host process per interactive GUI instance for hide/foreground/start/resume, and the **report** verb is just a headless `claude` invocation (no UI automation). The contract is identical across OSes; only process/visibility management is per-OS.


---

## 3. Core design decisions (locked)

| Decision | Choice | Why it matters |
|---|---|---|
| Report extraction | **Headless session fork.** Reports are generated by `claude -p --resume <session_id> --fork-session` (optionally `--no-session-persistence`) — a branch that produces the report and is discarded. The working session is never written to | **No pollution by construction**, so **no rewind needed.** Programmatic conversation rewind does not exist (UI-only, and buggy even there); fork is the only reliable, non-polluting, scriptable path. No keystrokes, no window focus, no UI automation |
| Interactive vs. reporting | Instances are **real interactive GUI** sessions you work in; **reporting is programmatic** against the same session id via fork | You keep the GUI you actually use; automation never has to puppet it |
| Contention (visibility = lock) | **Foreground = the user holds the instance; hidden = available to the subcontroller.** The subcontroller reports only on hidden instances, and while it holds one for a report, a pull-up is refused | Visibility *is* the arbitration: foregrounding and subcontroller-reporting are mutually exclusive by construction; no separate mutex needed |
| Instance lifecycle | **Never close, only hide** (background). X button backgrounds, never kills | Conversations are permanent assets |
| Tracking authority | **The controller owns** the tracking file spanning all workhorses; each workhorse holds a local mirror of its own records | Single source of truth for startup + orchestration |
| OS heterogeneity | Workhorses are a **pool of any-OS machines** behind a uniform **adapter contract** (§2a) | Add Linux/macOS/Windows workhorses without changing controller logic |
| Transport | **Persistent server (controller) ↔ subcontroller (workhorse) over a socket**, not SSH-per-command | Low overhead, instant dead-workhorse detection, single point to serialize commands; subcontroller initiates the upward connection |
| First implementation target | **Native Windows workhorse** (custom host-process-per-instance; reporting is headless, no UI automation), not WSL | This is what gets built first; other adapters follow the same contract |
| Onboarding conversations | **Migrate-in by adoption:** an existing unmanaged session id is wrapped + given a tracking record in place; no data moves. Reversible (unmanage leaves the session intact) | Bring pre-existing/ad-hoc conversations under management without recreating or risking them |
| Workhorse onboarding | **Self-registering from the workhorse side:** run a script with the controller's address; the subcontroller subscribes upward. Controller needs no prior config | Add/replace workhorses by touching only the new machine; primary + task learn of it via the server |
| Settings sync | **Controller-authoritative** push of user-wide `.claude`, with a **machine-local exclusion list** | One predictable config source; never push credentials/paths onto workhorses |
| Dashboard | **Fixed schema/template**; only data changes each cycle. **Live auto-refresh:** an open browser updates immediately on any write (SSE/WebSocket push), not just on the 30-min cycle | Stable to glance at; a resolution you type into the primary shows on the dashboard in near-real time |
| Crash vs. close | **Unintended exits auto-resume; closing is intentional-only** — via the primary ("close that instance") or inside the instance ("close") | Permanence means a crash must self-heal, but a real close must be deliberate and explicit, never accidental |

---

## 4. Key components

### 4.1 The application wrapper (one per instance)

**There is one wrapper per Claude Code instance** — it wraps that single instance and is its control surface. (The wrapper's *implementation* is per-OS, supplied by each workhorse's adapter, but the wrapper itself is instantiated once per instance.) Each wrapper sits *behind the adapter contract* (§2a), so this behavior is identical across OSes; only the adapter's implementation differs.

- **Visibility gate (the lock).** Visibility *is* the lock. **Foreground = held by the workhorse user; hidden = available to the subcontroller.** The subcontroller only reports on hidden instances.
- **Hide behavior — three pathways, one effect.** All three *background* the instance (never terminate), set visibility to `hidden`, and thereby **release the user's hold**, making it eligible for reporting on the next cycle:
  1. Typed into the **primary on the controller** ("hide current claude code") → server → subcontroller → adapter → background.
  2. Typed **`hide` directly inside the instance** on its workhorse → handled locally by the wrapper.
  3. The wrapper window's **X button** → backgrounds instead of closing.
- **Foreground = take the hold.** Foregrounding an instance (pulling it up) marks it the user's; it is removed from the subcontroller's reportable set until hidden again.
- **Reporting is out-of-band.** Reports are produced by a **headless session fork** (§4.3), not by driving the GUI. The wrapper does not inject keystrokes or rewind; the subcontroller runs a separate `claude` process against the session id. (Whether this can run while the GUI is open, or requires a brief close/resume, is the one Phase-0 spike question — §9.)

> **Per-OS note:** the wrapper manages the interactive GUI process (start, resume, hide, foreground). On Linux/macOS this is tmux-based and covered by existing tooling (§6a); on native Windows it is a host-process-per-instance. Reporting is the same headless `claude` call on every OS. **The first implementation target is native Windows** (see §6b).

### 4.2 The lock = visibility state

There is no separate mutex; **visibility is the lock.** Each instance is in one of:

- **Foreground (held by user).** The workhorse user is using it. The subcontroller will not report on it.
- **Hidden.** Available. The subcontroller may report on it (fork-based, §4.3).
- **Hidden, held by subcontroller** *(only in the close/resume fallback).* If the spike finds forking can't run against a live GUI, the subcontroller must briefly close the GUI to report; during that window the instance is *held* and a pull-up is **refused** (retry shortly). In the pure-fork case this state does not occur — the GUI is never taken, so reporting is invisible to it.

Transitions:

- **User foregrounds (pull-up):** allowed unless the instance is currently held (fallback case only); otherwise the instance is the user's until hidden.
- **User hides:** releases the hold → *hidden* → eligible for the next reporting cycle (subject to the change-gate, §4.4).
- **Subcontroller reports on a hidden instance:** forks the session, reads the report, discards the branch. In the fallback case, it instead takes → closes GUI → reports → resumes GUI → releases.

The single subcontroller serializes its own reports, so two never overlap on one instance.

### 4.3 The report routine (headless fork)

Runs only on **hidden** instances, in strict order:

1. **Eligibility gate.** The instance must be **hidden** (not foregrounded) **and** its conversation must have changed since the last report (watermark check, §4.4). Foregrounded → skip (the user has it). Unchanged → skip (the existing report stays current). No fork is run in either case.
2. **Fork and report.** Run `claude -p --resume <session_id> --fork-session` (preferably with `--no-session-persistence` so the branch is throwaway) with the prompt "produce a report of recent activity." This branches into a new session id; **the working session is never written to.**
3. **Read the result** from the headless output (text or `--output-format json`).
4. **Discard the branch.** With `--no-session-persistence` there is nothing to delete; otherwise remove the forked session file.
5. **Advance the watermark** to the conversation position the report covered.
6. Hand the report to the life-tracking pipeline.

**Fallback (only if the spike shows forking can't run against a live GUI):** before step 2, **close** the instance's GUI process (its session persists on disk, written on every event); after step 4, **resume** the GUI (`claude --resume <session_id>`) if it needs to be live, or leave it closed-but-resumable until the user pulls it up. During this window the instance is *held* and pull-up is refused.

**Defensive requirements:**

- **No pollution to verify.** Because the fork never touches the working session, there is no rewind to confirm and no residue to detect — the class of failure the old rewind routine guarded against cannot occur.
- **Handle a failed report gracefully.** A headless run can fail (e.g. `error_during_execution` / null result under load). On failure: do **not** advance the watermark (so it retries next cycle), flag it as a life-tracking event, and continue with other instances. Never assume success.
- **Serialize forks per workhorse.** The single subcontroller runs one report at a time, keeping well clear of the high-concurrency failure mode and avoiding contention.
- **Capture freshness.** Since session state is written on every event, a fork reflects activity up to that instant; if the spike shows forking a *mid-stream* GUI turn can catch a partial turn, fall back to close/resume for that instance.

### 4.4 "Recently active" detection — never re-report an unchanged conversation

**Hard rule:** the subcontroller reports on an instance *only* if it is **hidden** (not held by the user) **and** its conversation has changed since its last report. A foregrounded instance is never reported on — the user has it. An unchanged hidden instance is **skipped entirely** — no fork, no report. A report is never regenerated for a conversation that hasn't moved.

- Each instance has a **last-report watermark** in the tracking file, recording the conversation position (e.g. last-turn marker / session-file position, not just a wall-clock time) covered by its previous report.
- Before doing anything, compare the conversation's current position to the watermark. **Equal → skip.** Only a genuine advance past the watermark qualifies the instance for the report routine.
- Advance the watermark only after a **successful** report. (A failed headless run does not advance it — see §4.3.)
- **Why it's a rule, not just an optimization:** every report fork costs tokens/time and Agent-SDK credit. Skipping unchanged instances avoids needless cost; the previous report simply remains current.

### 4.5 The tracking file

- **Owner:** the controller (records span all workhorses). **Mirror:** each workhorse holds its own records locally (read by its startup script and wrappers).
- **One record per instance**, carrying at minimum: id, `workhorse_id`, friendly name/topic, project folder path, **desired lifecycle state** (`alive` / `closing` / `closed` / `failed`), **visibility state** (`foreground` = user-held / `hidden`), session id (for resume), last-report watermark, and a **held-by-subcontroller flag** (fallback only — true while the GUI is briefly closed for a report).
- The controller reads and writes it; the server pushes relevant records down to each subcontroller, whose startup script consumes them to recreate everything.

### 4.6 The startup script (per workhorse)

- Runs on boot. Reads the tracking file.
- For each instance: recreate its host process and wrapper, **resume the conversation only if needed** (an instance already live does not get re-resumed; one that is down is resumed from its stored session id), and restore its hidden/foreground state.
- The controller remains the authority: it can rewrite the tracking file and re-trigger startup so the set of instances and their states always reflect the controller's view.

### 4.6a Instance lifecycle: crash recovery vs. intentional close

Because instances are meant to be permanent, the subcontroller must distinguish an **unintended exit** (crash, killed process, host window died) from an **intentional close**. It does this with a **desired-state** field per instance in the tracking record — one of `alive` (whether foreground or hidden) or `closing`/`closed`.

- **Supervision.** The subcontroller watches each instance's host process. If a process exits while its desired state is `alive`, that is a crash → the subcontroller **automatically resumes it** from its stored session id, restoring its prior hidden/foreground state, and reports the crash-and-recovery upward (it is a life-tracking event worth surfacing).
- **Resume loop, bounded.** Auto-resume retries with backoff. If an instance keeps dying (crash-loops), the subcontroller stops retrying after a threshold, marks it `failed`, and raises a visible flag rather than thrashing forever.
- **Intentional close — two paths only.** An instance is only *truly* closed when a close is explicitly requested:
  1. Via the **primary** ("close that instance") → server → subcontroller sets desired state to `closing`, shuts the instance down cleanly, then `closed` and removes it from the active set.
  2. Typed **`close` inside the instance itself** → the wrapper sets desired state to `closing` locally before exiting, so its own death is recognized as wanted, not a crash.
- **The critical invariant.** A bare process exit is **never** a close. Only a desired-state transition to `closing` makes an exit intentional. This prevents a crash from being mistaken for a close (which would silently lose a conversation) and prevents a close from being mistaken for a crash (which would resurrect something you meant to end).
- **Distinct from hide.** Hiding only backgrounds a *still-alive* instance; it never changes desired state away from `alive`. Hide and close are different axes: hidden/foreground is visibility, alive/closing is existence.
- **Reporting is independent of the GUI process.** Because reports run as a separate headless fork (§4.3), a GUI crash mid-report doesn't corrupt anything — the fork is its own process against a branch; it simply fails or completes harmlessly, and the working session is untouched regardless. There is no dirty state to recover. (In the close/resume fallback, a crash during the report window is just a normal crash → auto-resume from the session id.)

### 4.6b Migrating an unmanaged conversation into management

You will already have Claude Code conversations that predate the system, or that you started ad hoc. Bringing one under management is **adoption, not relocation**: the conversation already persists on disk as a session id; management is just a tracking record plus a wrapper laid on top. **No conversation data moves or changes.**

The common case: the conversation **exists on disk but isn't currently open**, on a machine that **already runs a subcontroller**.

- **Trigger.** You tell the **primary**: "manage this conversation" (identifying it by session id, name, or project — the primary resolves it). The primary issues a *manage* intent to the server, which routes it to the subcontroller on the machine where that session lives.
- **What the subcontroller does:**
  1. **Verify** the session id exists on disk (under `.claude/projects`) and is resumable.
  2. **Create a tracking record** for it (§4.5): assign an instance id, set `workhorse_id`, capture a friendly name/topic, record the session id, set desired state `alive` and visibility `hidden`, and initialize the last-report watermark to the **current** conversation position (so migration itself doesn't trigger a spurious "everything changed" first report — see note below).
  3. **Bring it under the wrapper** — register it in the active set so startup/resume, hide/foreground, supervision, and reporting all apply to it henceforth.
  4. The instance now appears in the tracking file and the server state, so the primary and the Cowork task see it like any other.
- **Watermark choice at adoption.** Initialize the watermark to "now" so the *pre-existing* history isn't reported as fresh activity on the first cycle. (If you instead *want* a one-time baseline report of the whole conversation, set the watermark to the conversation's start — make this an explicit option on the manage command, defaulting to "now.")
- **Already-open case (secondary).** If the conversation happens to be open in an unmanaged GUI at migration time, treat it like any foregrounded instance: adopt the record but don't report until it's hidden (the user has it). The session id is the same whether or not a GUI is currently attached.
- **Reverse — unmanage.** The inverse is available for symmetry: "stop managing this" removes the tracking record and detaches the wrapper but **never deletes the session** — the conversation reverts to a plain unmanaged session id on disk, fully intact.

### 4.7 The shared life-tracking data store (filesystem)

A directory on the controller's filesystem is the meeting point between the **Cowork task** (writer, every 30 min) and the **primary Claude Code** (reader always; writer on resolution). It holds:

- **The cycle report** — the Cowork task's own authored synthesis of everything it reviewed this cycle (see §4.9a), including the prioritized **sentence list**.
- **Collected data + the task's "thought process"** — the raw reports and the reasoning behind how the Cowork task ranked issues. The primary reads this so that, when you resolve the displayed issue, it knows *what the next most important issue is* without re-deriving it.
- **The prepared sentence queue** — the current major sentence plus **pre-staged secondary sentences**, drawn from the cycle report. The Cowork task always computes not just the top issue but the next ones in priority, so a resolution can promote the runner-up instantly.
- **Daily task list + completeness state.**
- **Issue resolution log** keyed by stable issue id.

This store is *why* the primary can update the dashboard on its own (see 4.9).

### 4.8 The life-tasks project folder (the living to-do store)

Your existing large life to-do list is imported into a **life-tasks project folder** — the folder the primary runs in and continuously maintains. This is not a one-off import: it is the **living store** of your tasks.

- **Import:** bringing the existing list in is an explicit one-time ingestion; thereafter the folder is the durable home for tasks.
- **The primary writes to it.** As you talk to the primary ("done with the taxes," "add: renew passport," "the billing thing now blocks the launch"), it **updates this folder directly** — that is how task state changes.
- **The scheduled task reads from it.** The folder is one of the **input locations the Cowork task checks** when authoring the cycle report and regenerating the daily list (§4.9). So your edits via the primary flow into the next cycle's report, sentences, and daily plan automatically.
- **One loop, two roles.** The primary mutates tasks in real time; the Cowork task reads them every 30 min to synthesize. Neither owns the other — the folder is the shared substrate between them.
- **Day rollover.** Because each cycle checks the current date (§4.9 step 0), the task generates a fresh daily list when the day turns over and re-evaluates due/overdue status against the new date — carrying unfinished items forward as appropriate.

### 4.9 The 30-minute scheduled task (controller, Cowork)

Each cycle:

0. **Establish the current date and time.** Every cycle begins by reading the actual current date/time (and timezone). This is not incidental — it determines which day's task list is active, whether the day has rolled over (triggering a fresh daily list), which tasks/issues are now due, overdue, or upcoming, and how time-relative language in the cycle report and sentences is phrased ("due today," "overdue since Tuesday," "in 2 hours"). All downstream steps are evaluated *as of* this timestamp.
1. Read the **life-tasks project folder** (§4.8) for the current task state the primary has been maintaining; generate / update the **daily task list** for the current day from it, informed by the latest instance reports.
2. Read the server file location for fresh state; for each **recently-active** instance, instruct the server to run the **report routine** and collect the results it writes back.
3. Feed reports into **life tracking**, writing collected data and the ranking thought process into the shared store (4.7).
4. **Author the cycle report** (§4.9a): a synthesis of everything reviewed, ending in a prioritized **list of conversational sentences** (possibly empty) for the high-priority issues. Prioritization is **time-aware** — overdue and imminently-due items weigh more heavily than distant ones.
5. Derive the **sentence queue** from that report — major sentence + secondaries in priority order.
6. Rebuild the **dashboard data** (today's tasks with completeness, plus the **one-sentence** top issue) and signal the push channel so any open browser refreshes immediately (§4.10).
7. Reconcile any **issue resolutions** the primary logged since last cycle (mark resolved, drop from display, promote the next sentence).

### 4.9a The cycle report

Each cycle, the scheduled task does not just dump data — it **writes a report of its own** summarizing everything it reviewed (instance reports, task progress, what changed). The report **concludes with a prioritized list of sentences** — one per high-priority issue, **possibly empty** if nothing is pressing.

- **Purpose for the primary.** The primary **reads this report every time** it needs to act, for two reasons: (1) to stay **competent and in-sync** with the task's findings — it reasons from the same synthesis, not stale or partial data; and (2) so it always has a **next sentence ready** to promote the moment the current one is resolved.
- **The sentences are the queue.** The report's sentence list *is* the source of the dashboard's major sentence and its pre-staged secondaries. An empty list means there is nothing pressing → the dashboard shows **"Stand by."**
- **Tone: conversational.** The sentences are written in a natural, conversational voice — how a thoughtful person would flag the issue to you, not a terse status code or a clinical alert.

### 4.10 The dashboard + one-sentence loop

- HTML dashboard: daily tasks with completeness indicators.
- A **single prominent sentence** for the most serious current issue.
- Each issue has a **stable id**. You respond by typing into the **primary Claude Code** ("the auth thing is handled, I merged the fix").

**Two writers, one display.** The major sentence can be updated by either the Cowork task (each cycle) or the primary (immediately) — coordinated through the shared store (4.7):

- **Resolution only.** The primary updates the dashboard itself **only if your message actually resolves the issue.** If you are just discussing it, asking about it, or thinking out loud, the primary **leaves the sentence as-is.** Judging resolved-vs-discussion is the primary's responsibility.
- **What replaces a resolved sentence:**
  - If there is **another major point of attention**, the primary promotes the **next pre-staged secondary sentence** from the queue.
  - If there is **nothing else pressing**, the sentence becomes **"Stand by."**
- The primary can do this on its own *because* it reads the Cowork task's **cycle report** (§4.9a) — the same synthesis and sentence list the task produced; it does not need to re-run the analysis.
- **Conversational tone.** Whether written by the task or promoted by the primary, the displayed sentence reads conversationally.
- On the next cycle, the Cowork task sees the logged resolution and reconciles — confirming the promotion or recomputing if new data has arrived.

**Schematized, stable layout.** The dashboard has a **fixed schema/template**: its structure (sections, slots, ordering) does not change cycle to cycle — only the *data* bound into it does. The Cowork task populates a defined data shape (today's tasks + completeness, the major sentence, the secondary-sentence queue, any flagged failures from §4.3) and the template renders it. This prevents the dashboard from being redesigned every 30 minutes, keeps it visually stable to glance at, and makes the two-writer coordination tractable (both writers target named slots, not free-form HTML).

**Live auto-refresh (required).** When *either* writer updates the dashboard — the Cowork task on its cycle, or the **primary the instant you resolve a sentence** — an already-open browser must **refresh immediately**, with no manual reload. A plain static HTML file the writers overwrite will *not* do this (the browser won't know it changed), so the dashboard is served by a tiny local process that pushes updates to the page:

- The dashboard is **data-driven**: the template fetches the current data (the fixed schema from the shared store) and renders the slots. Writers change the *data*, never hand-edit served HTML.
- A **push channel** notifies the open page the instant data changes — Server-Sent Events (simplest for one-way server→page), a WebSocket, or, as a low-tech fallback, short-interval polling of a version/etag. SSE is the recommended default.
- **Both write paths trigger it.** The primary's immediate resolution update and the Cowork task's cycle update both write to the shared store and signal the push channel, so the page reflects a resolution in roughly real time — not on the next 30-minute cycle.
- This co-locates naturally with the controller's **persistent server process** (§the link), which is already always-on; the dashboard server can be the same process or a sibling.

### 4.11 Natural-language remote control

Spoken to the primary Claude Code on the controller:

- **"Pull up the claude code about XYZ"** → primary resolves XYZ → instance id via the tracking file → server pushes a foreground command to the owning subcontroller. **Foregrounding takes the user's hold; it is refused if the subcontroller is mid-report on that instance** (retry shortly — reports are brief).
- **"Hide current claude code"** → server pushes a hide command to the subcontroller → background the relevant instance, update tracking state to `hidden`.
- The same `hide` works *locally* when typed inside an instance on its workhorse (handled by the wrapper).
- **"Close that instance"** → server pushes a close command → subcontroller sets desired state to `closing`, shuts it down cleanly, marks `closed` (§4.6a). This is one of only two ways an instance is truly closed.
- **"Manage this conversation"** → server routes a *manage* intent to the subcontroller on the machine where that session lives → it adopts the existing session id into a tracking record + wrapper (§4.6b). No data moves. ("Stop managing this" does the reverse, leaving the session intact on disk.)
- The same **`close` works *locally*** when typed inside the instance — the wrapper sets desired state to `closing` before exiting so its death is recognized as intentional, not a crash.

### 4.12 Global `.claude` settings sync

A built-in mechanism keeps the user-wide `.claude` directory consistent across the controller and all workhorses.

- **Authority: controller is the source of truth.** Shared config is edited on the controller and **pushed down** to every workhorse via the server/subcontroller channel. One place to change settings; predictable propagation. (Two-way last-write-wins was rejected — it silently clobbers concurrently-edited keys and makes "what is my config" unanswerable.)
- **Machine-local exclusion list.** Some `.claude` content must **never** sync: credentials/auth tokens, OS-specific paths, and per-machine local state. These are excluded so the controller's secrets and paths are not pushed onto workhorses (which would break them). The exclusion list is itself part of the design, not an afterthought.
- **Propagation:** on change (or on a workhorse reconnecting), the server sends the current shared config; the subcontroller applies it to the local `.claude`, leaving excluded paths untouched.
- **Scope:** this is for *global/user-wide* settings. Per-project `.claude` config travels with each project folder and is out of scope for this sync.

---

## 5. End-to-end flows

### A. The 30-minute heartbeat
Cowork wakes → updates daily list → reads server file / issues intents to the server → server drives each subcontroller → per **hidden, changed** instance: fork the session headlessly → read report → discard branch (foregrounded instances are skipped — the user has them) → life tracking ingests → **Cowork authors the cycle report (ending in a conversational, possibly-empty sentence list)** → dashboard + one-sentence rebuilt → resolutions reconciled.

### B. You answer the dashboard
Dashboard shows one sentence → you type into the primary → primary (working from the latest **cycle report**, §4.9a) judges whether you **resolved** it or are merely **discussing**. If discussing, nothing changes. If resolved: it logs the resolution and immediately updates the display — promoting the next conversational sentence from the report's list, or showing **"Stand by"** if the list is empty. Next heartbeat, the Cowork task reconciles.

### C. You summon an instance
You: "pull up the claude code about the billing migration" → primary looks up the topic in the tracking file → server pushes a foreground command to that instance's subcontroller → if the instance is hidden and free, it foregrounds and becomes yours; if the subcontroller is mid-report, the pull-up is **refused** and you retry a moment later.

### D. Boot / recovery
A workhorse powers on → its startup script reads its tracking records → for every instance whose desired state is `alive`, recreate its wrapper, resume the conversation, restore hidden/foreground state. Instances marked `closed` are not recreated. (No dirty/rewind recovery exists — reporting never mutates a session.)

### E. Instance crashes mid-life
An instance's host process exits while desired state is `alive` → subcontroller detects the exit → resumes it from its session id, restores prior visibility → reports the crash-and-recovery up to the server (surfaced as a flagged event). If it crash-loops past the retry threshold → marked `failed`, flagged, no further auto-resume.

### F. You close an instance
"Close that instance" (primary) **or** `close` (inside the instance) → desired state set to `closing` *before* shutdown → clean exit → marked `closed`, removed from the active set, not auto-resumed.

### G. You add a new workhorse
On the new machine: run the setup script with the **controller's address** → its subcontroller connects and **registers/subscribes** → the server records it and its instances appear in the tracking + state files → the primary (via query) and the scheduled task automatically see the new workhorse and its instances, with no controller-side configuration.

### H. You migrate an unmanaged conversation in
You: "manage the conversation about the tax filing" → primary resolves the session id → server routes a *manage* intent to the subcontroller where that session lives → it verifies the session is resumable, creates a tracking record (desired `alive`, hidden, watermark = now), and wraps it → the conversation now appears as a managed instance, with no data moved (§4.6b).

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Report pollutes the working conversation | Reporting uses a discarded **session fork** (`--fork-session`); the working session is never written to, so there is nothing to clean up |
| User and subcontroller want the same instance at once | Visibility *is* the lock: foreground = user's, hidden = subcontroller-eligible. In the pure-fork path the GUI is never taken; in the close/resume fallback a pull-up mid-report is refused and retried |
| Headless report run fails (e.g. error/null under load) | Don't advance the watermark (retries next cycle), flag the event, continue with other instances; subcontroller serializes forks to stay clear of the concurrency failure mode |
| Resume fails on startup | Tracking file stores session ids; startup verifies each resume and flags failures rather than silently dropping an instance |
| Windows lacks tmux | Native host-process-per-instance for GUI management; reporting is headless `claude`, so no UI automation is needed |
| Fork against a *live* GUI session is unreliable / catches a partial turn | Phase-0 spike question (§9); if it fails, fall back to close → report → resume for that instance |
| Stale dashboard issue after you've resolved it | Stable issue ids + resolution reconciliation each cycle |
| Two writers (primary + Cowork) update the sentence at once | Shared store is the single coordination point; Cowork reconciles against the primary's logged resolutions each cycle |
| Primary mistakes discussion for resolution (or vice versa) | Resolved-only rule is explicit; when unsure, primary leaves the sentence untouched (discussion is the safe default) |
| Workhorse subcontroller dies or connection drops | Persistent socket lets the server detect death immediately; subcontroller reconnects and re-syncs state + settings on reconnect |
| Settings sync pushes credentials/paths onto a workhorse and breaks it | Controller-authoritative push with an explicit machine-local **exclusion list**; per-project config never travels through this sync |
| Dashboard restructures itself every cycle | Fixed schema/template; cycles bind data into named slots, never regenerate layout |
| Open browser shows stale dashboard after an update | Served by a local process with an SSE/WebSocket push channel; both the primary's resolution update and the Cowork cycle trigger an immediate refresh |
| Crash mistaken for a close → conversation silently lost | A bare exit is never a close; only a desired-state transition to `closing` is intentional, so unintended exits auto-resume (§4.6a) |
| Close mistaken for a crash → instance you ended gets resurrected | Both close paths set desired state to `closing` *before* exit, so the subcontroller recognizes the death as wanted |
| Crash-looping instance thrashes the resume loop | Bounded retries with backoff; after threshold, mark `failed` and raise a visible flag instead of retrying forever |
| Needlessly reporting an unchanged conversation | Hard change-gate (§4.4): unchanged hidden conversations are skipped — no fork, no report |

---

## 6a. Prior art: reuse vs. build

The behavior in this document is fixed as designed. Open source is used **only as implementation leverage underneath** — to avoid rewriting commodity mechanism — never to alter the specified behavior. Each component is classified below.

**Hard gate:** most mature tools are **tmux-based** and run on macOS/Linux (or Windows only via WSL). On *native* Windows, a Windows workhorse cannot use them. Decision to settle (per Windows workhorse): **run its instances under WSL** (unlocks the ecosystem below) **or** accept that the wrapper layer is fully custom. This single choice determines how much can be reused.

| Component | Reuse? | Source / approach | Notes |
|---|---|---|---|
| Instance tracking + status table | **Reuse mechanism** | `claude-dashboard` (seunggabi) session-detection + state model | Borrow its model for the tracking file; our schema and Machine-1 authority stay as designed.Native on Linux/macOS workhorses; via WSL on Windows ones. |
| Persistence + hide/resume + startup restore | **Reuse mechanism** | `claunch` / tmux popup-session pattern | Provides detach/reattach + conversation restore after restart. Our conditional-resume and tracking-file-driven startup logic wrap it.Native on Linux/macOS workhorses; via WSL on Windows ones. |
| "Pull up / switch to" an instance | **Reuse mechanism** | `claude-tmux` session switching | Backs the natural-language summon; the NL parsing + server-routed command remain ours.Native on Linux/macOS workhorses; via WSL on Windows ones. |
| Fleet orchestration from one controller | **Evaluate, likely partial** | Claude Code **Agent Teams** (v2.1.32+) or the FastMCP/iTerm2 orchestrator | Agent Teams has *known limitations around session resumption, coordination, and shutdown* — and assumes cooperative teammates, not a human-vs-master lockout. Use for inspiration; do not let it dictate behavior. |
| **Report extraction** | **Reuse the platform feature** | `claude -p --resume --fork-session` (+ `--no-session-persistence`) | First-class headless fork; produces a report on a throwaway branch, original untouched. No custom inject/rewind code. |
| .jsonl parsing — *as a mechanism only* | **Reuse mechanism** | parsers in `claude-dashboard` etc. | Used for one narrow job: **"recently active" watermark** detection (comparing session position to the last report). |
| Per-instance arbitration (visibility = lock) | **Build** | — | No existing tool arbitrates an autonomous controller against a human on the same instance. Mostly trivial now: fork doesn't take the GUI, so contention only exists in the close/resume fallback. |
| 30-min cross-machine heartbeat (server/subcontroller) | **Build** | — | All existing tools are single-machine and human-triggered. Ours. |
| Dual-writer dashboard + one-sentence loop | **Build** | — | Resolved-only rule, secondary-sentence queue, "Stand by." Ours. |
| Life-tracking pipeline + daily task generation | **Build** | — | No off-the-shelf equivalent; this is the point of the system. Ours. |

**Net:** the bottom of the stack (persistence, hide/resume, tracking, switching, .jsonl watermark parsing) is commodity and reusable **on Linux/macOS workhorses, and on Windows workhorses if they run WSL**. Reporting is now a **first-class platform feature** (headless fork) rather than custom automation. The top of the stack (visibility arbitration, heartbeat, dual-writer dashboard, life tracking) is built to spec.

---

## 6b. Native Windows workhorse — first implementation target

The first workhorse is **native Windows** (not WSL). The big simplification from programmatic reporting: **the adapter no longer needs UI automation.** It only manages GUI processes (start/resume/hide/foreground) and shells out to headless `claude` for reports. Practical shape:

- **Host process per instance.** Each interactive Claude Code instance runs in its own persistent host process/window (e.g. a Windows Terminal or conhost window) launched and tracked by the subcontroller. "Hide" = move the window out of view / minimize-to-tray; never terminate.
- **Reporting is a headless child process — no UIA.** To report, the subcontroller runs `claude -p --resume <session_id> --fork-session --no-session-persistence "…"` and reads stdout (optionally `--output-format json`). No keystrokes, no focus, no window driving. This removes the entire riskiest layer of the earlier design.
- **Visibility.** A foregrounded window is the user's; a hidden one is eligible for reporting. Because the fork doesn't touch the GUI, there's normally no "held" state to enforce. The held-flag (a Windows named mutex or lock file) is needed **only** in the close/resume fallback, to refuse a foreground while the GUI is briefly closed for a report.
- **Subcontroller** is a long-running Windows service/process: on first run it takes the **controller address** and **registers/subscribes** upward; thereafter it maintains the socket to the server, manages GUI processes, runs report forks, applies pushed `.claude` settings (minus the exclusion list), and runs the startup/resume script.
- **Watermark via .jsonl.** Read the instance's session `.jsonl` (under `.claude/projects`) to detect whether the conversation advanced since the last report. OS-agnostic and reusable.
- **Things to prototype first, in order:** (1) **the spike** — can `claude -p --resume --fork-session` run against a session whose GUI is still open, producing a clean complete report? (2) if not, the close → report → resume fallback and its held-flag; (3) hide/foreground window management; (4) the socket subcontroller; (5) startup/resume.

The single hardest unknown is now just the spike question in (1). It is far lower-risk than the old UIA-rewind problem — worst case is a close/resume dance, not a fundamentally unreliable automation layer.

---

## 7. Open questions to resolve next

0. **Fork against a live GUI session — clean and complete?** The single biggest unknown: does `claude -p --resume <id> --fork-session` run correctly while that session's interactive GUI is still open, producing a complete report branch without disturbing the live session? If yes → reporting is fully invisible to the GUI. If no → close/resume fallback. Prove this first (§9).
1. **Watermark source** — read appended turns from the session `.jsonl` to detect change (preferred per §6b); confirm the format/position signal is stable.
2. **Deterministic "hidden" state** — how the Windows adapter confirms a window is actually backgrounded, not just sent a command.
3. **Socket protocol** — message shapes for the server↔subcontroller channel: **registration/subscription** (a new subcontroller announcing itself with the controller address), state-up, commands-down, settings push; plus the **primary's query (read membership/instances) and dispatch (command a subcontroller) calls** against the server; reconnection; and how the server detects a dead workhorse.
4. **Foreground-refusal handling (fallback only)** — if the close/resume fallback is needed, how a refused pull-up surfaces to the user (silent retry, brief message).
5. **`.claude` exclusion list** — the exact paths/keys that must never sync (credentials, OS paths, per-machine state).
6. **Agent SDK credit budget** — reporting forks draw from the separate Agent SDK credit (from June 15, 2026); size the per-cycle cost (N changed instances × every 30 min).
7. **Daily task generation** — how the life-tasks project folder (§4.8) seeds each day's list, and how completeness is measured.

---

## 8. Build order

0. **Fork spike (native Windows).** Before anything else, prove `claude -p --resume <id> --fork-session --no-session-persistence` produces a clean, complete report — first against a *closed* session, then against a session whose GUI is still *open*. This decides whether reporting is invisible (pure fork) or needs close/resume. Lowest-effort, highest-leverage de-risk.
1. **Tracking file schema** — everything depends on it; must carry `workhorse_id`, OS info, session id, desired-state, visibility, watermark (and a fallback-only held flag).
2. **Application wrapper — GUI process management** — start / resume / hide / foreground of the interactive instance on native Windows. No UI automation.
3. **Subcontroller + server socket** — the persistent transport; **self-registration** (workhorse-side setup script + controller address), state up, commands down, settings push, plus the primary's query/dispatch calls.
4. **Startup script** — consumes 1–3 to bring a workhorse up, resume conversations, and start the subcontroller.
5. **Report routine (headless fork)** — fork → read → discard; depends only on the spike (0) and watermark detection. (Close/resume fallback only if the spike requires it.)
6. **`.claude` settings sync** — controller-authoritative push with exclusion list.
7. **Dashboard (fixed schema) + 30-minute Cowork task** — orchestrates the whole loop through the server.

---

## 9. Phase 0: single-machine test (controller and workhorse on one box)

Before any real cross-machine setup, run **both roles on the same machine** — the controller (primary, server, scheduled task) and one workhorse (subcontroller, instances) co-located. This exercises the entire control loop while removing networking and machine-to-machine concerns, so failures are about *logic*, not infrastructure.

**Why this works with little special-casing.** The design already accommodates it:

- The subcontroller connects to a **controller address** — and `localhost` (or `127.0.0.1`) is a valid address. Self-registration (§the link) runs unchanged: the setup script just points at the local server.
- Visibility-as-lock, the report routine, hide/foreground, crash recovery, the tracking file, and the dashboard are all **machine-agnostic** — they behave identically whether the subcontroller is local or remote.

**What collapses (and is deliberately trivial in this phase):**

- **Transport.** The socket runs over loopback. Real network failures, latency, and dead-workhorse detection are deferred — but the *protocol* is still exercised end to end.
- **`.claude` settings sync.** Controller and workhorse share one filesystem and one `.claude` dir, so there is effectively nothing to push. Either skip the sync here, or point both at the same dir and confirm the exclusion-list logic is a no-op. Real sync is validated only when a second machine joins.
- **`workhorse_id`.** There is exactly one, but it is still present in every record — so the schema and addressing path (`(workhorse_id, instance_id)`) are tested as-is, ready for N>1.

**What this phase fully validates (the important part):**

- **Headless fork reporting:** fork a hidden instance's session, get a clean complete report, confirm the working session is untouched — and test it both against a closed GUI and (the spike) a still-open one.
- The visibility model and the two-condition report rule (hidden + changed); the change-gate (no report on unchanged conversations).
- GUI process management: start, resume, hide, foreground.
- Self-registration, the primary's query/dispatch calls, and the server's state file.
- Crash recovery and intentional-close paths (and that a crash during a report fork harms nothing).
- The full 30-minute loop: cycle report authoring, the conversational sentence queue, the dual-writer dashboard, and resolution reconciliation.

**What it does *not* validate (revisit when a second machine joins):** true network behavior (latency, partitions, reconnection), real dead-workhorse detection, genuine `.claude` propagation across distinct filesystems, and heterogeneous-OS adapters.

**Exit criteria to leave Phase 0:** an instance can be created, used, hidden, **reported on via headless fork (working session verified untouched)**, foregrounded, crashed-and-auto-resumed, and intentionally closed — and a full 30-minute cycle produces a correct dashboard with a conversational sentence you can resolve via the primary. Only then introduce a genuinely separate workhorse.

---

## Codicil A — Phase-0 Implementation Decisions (recorded 2026-06-14)

*This codicil records decisions and empirical findings from the first Phase-0 build. It amends the sections noted; it does not revise the body above. Where a finding resolves an Open Question (§7), that is stated.*

**A.1 Implementation stack.** Node.js. File-based shared store under `~/.execkee` (tracking, shared-store, life-tasks). Transport is a WebSocket server↔subcontroller channel; the dashboard is served over HTTP with Server-Sent Events for push. No external dependencies beyond `ws`.

**A.2 Fork spike — PASSED; close/resume fallback not needed (resolves §7 Q0).** `claude -p --resume <id> --fork-session --no-session-persistence --output-format json` was run against a real session whose GUI was open; it produced a complete report and left the working session **byte-identical**. The pure-fork path of §4.3 is therefore the only path; the close/resume fallback (§4.2, §4.3, §9) is confirmed unnecessary on native Windows and is not implemented.

**A.3 Native-Windows window management (amends §4.1, §6b; resolves §7 Q2).** The interactive instance is launched as `claude.exe` **directly** via `Start-Process -PassThru` — *not* wrapped in `cmd`. The launched PID is the durable, window-owning process (no "trampoline"; `conhost` is its child). Its `MainWindowHandle` is non-zero **only while visible** and reads 0 once hidden, so the handle is **cached at launch** and reused; liveness is checked by PID, hide/show by the cached handle, kill by `taskkill /T`. There is no separate "held" state in the pure-fork path.

**A.4 The application wrapper is realized via a session-scoped hook (amends §4.1, §4.6a, §2a).** In-instance typed `hide`/`close` are implemented with a `UserPromptSubmit` hook injected per-instance through `claude --settings <file>` plus an `EXECKEE_INSTANCE_ID` environment variable. The user's global `~/.claude` is never modified. Typing `hide` backgrounds the instance and blocks the prompt; typing `close` sets `desiredState=closing` locally before exit (preserving the §4.6a invariant that a bare exit is never a close), and the subcontroller finalizes the kill.

**A.5 X-button — accepted deviation (amends §4.1, §6b).** Actively "backgrounding on X" cannot be done for a console window from outside its process; it would require hosting the instance in a custom GUI terminal. Decision: the window's `SC_CLOSE` menu item is **removed at launch** so the X can never *kill* the instance (the load-bearing permanence invariant holds). Backgrounding is via typed `hide` or the primary. True X-to-hide is deferred to a future GUI-host wrapper.

**A.6 Resolution loop (amends §4.10).** `/api/resolve` mutates the dashboard only when the caller (the primary) asserts an explicit `resolved: true` — the resolved-vs-discussion judgment stays with the primary; the server applies no keyword heuristic. On resolution it promotes the next pre-staged secondary sentence (or "Stand by."), writes the shared store, and pushes SSE. Both writer paths (cycle and resolution) push live.

**A.7 Adoption is atomic (amends §4.6b).** `manage` verifies the session exists on disk before adopting and persists the tracking record only after a verified-live launch — no orphan records on failure. The watermark defaults to "now"; `--baseline` opts into a from-start report; `--open` adopts an already-open session as foreground (un-launched, un-supervised) per the secondary case.

**A.8 On-demand cycle.** A `POST /api/run-cycle` trigger supplements the 30-minute timer (a "refresh now" affordance; also the deterministic hook used for validation).

**A.9 Output-format convention.** `claude -p --output-format json` returns a JSON **array of event objects**; the model's answer is the `result` field of the final `type:"result"` event. Both the report fork and the cycle synthesis parse it this way.

**A.10 Phase-0 validation.** The full loop was exercised end-to-end: create / hide / fork-report (working session untouched) / foreground / crash-and-auto-resume / intentional close (primary and in-instance) / a cycle that synthesizes a report + tasks into time-aware sentences / resolve via the primary with live SSE promotion. Deferred to Phase 1 (consistent with §9): cross-filesystem `.claude` sync, per-workhorse tracking mirror, real network/dead-workhorse behavior, heterogeneous-OS adapters.

---

## Codicil B — Usability streamlining (recorded 2026-06-14)

*Refinements from operating the primary surface in practice. Amends the sections noted.*

**B.1 Adoption defaults to a full baseline report (reverses §4.6b/§A.7).** Originally adoption defaulted the watermark to "now" with `--baseline` opt-in. In practice, the point of adopting a conversation is to account for all of it, so adoption now defaults to a **full baseline report** (watermark = 0); `--from-now` is the opt-out for deltas-only. The §4.6b rationale (avoid a "spurious 'everything changed' first report") doesn't apply to a newly adopted instance — that history was never accounted for, so the first report is the baseline, not spurious.

**B.2 Adoption auto-runs a cycle.** `manage` triggers a cycle immediately on success (server-side, fire-and-forget), so the baseline report is produced at once rather than waiting for the 30-minute timer or a manual `POST /api/run-cycle`. If the instance is adopted-and-foregrounded, the report correctly waits until it is hidden (visibility = lock, §4.2).

**B.3 The improvement backlog.** A persistent backlog (`~/.execkee/issues.json`, via `cli.js issue add|list|done`) lets the user dictate Execkee shortcomings/ideas to the primary in natural language; the primary logs them for a later developer-side code pass. This is the intended channel for the long tail of usability fixes — talk to the primary, accumulate the list, address it in code later.

**B.4 The primary acts directly (amends §A.4 brief).** For Execkee operations *and* edits to the life-tasks task store (mark done, add, resolve), the primary acts immediately and confirms in one line — no propose-and-wait, no step narration, no command echoes. This is a deliberate, scoped override of the controller's global "propose before editing" rule, because that ceremony proved too heavy for a natural-language control surface. Destructive actions (close/unmanage) still confirm first.

**B.5 The operator brief is system-managed and versioned.** The life-tasks `CLAUDE.md` carries a version marker (`execkee-brief vN`) and is regenerated when the version changes, so brief improvements propagate on controller restart. (The `/execkee` command file remains write-once.)
