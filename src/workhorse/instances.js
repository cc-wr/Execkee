import { readTracking, mutateTracking, createInstanceRecord, addInstance, updateInstance, getInstancesForWorkhorse } from '../common/tracking.js';
import { DESIRED_STATE, VISIBILITY, maxDesiredState } from '../common/protocol.js';
import { existsSync, statSync } from 'fs';
import { hasSessionChanged, runForkReport, getSessionPosition, getSessionJsonlPath, getSessionCwd, resolveSessionId, listLocalSessions, newestSessionInSlugOf } from './reporter.js';
import * as adapter from './adapter.js';
import * as probe from './probe.js';
import { portInUse } from '../common/net.js';
import config from '../common/config.js';
import { isPrimaryPid, isPrimarySession } from '../common/primary.js';

// Every mutation of the local tracking store goes through mutateTracking (a
// cross-process-locked read-modify-write), because the per-instance hooks run in
// SEPARATE processes and mutate the SAME tracking.json concurrently; an unlocked
// stale-read + late-write on either side drops a concurrently-added/updated instance
// (the lost-update that wiped instance management). The lock is held only around the
// short synchronous callback — adapter calls (launch/show/hide/kill) and `await`s stay
// OUTSIDE it, so a slow PowerShell/AppleScript op never blocks another writer. A
// callback returning false means "no change" and skips the write.

export class InstanceManager {
  constructor({ workhorseId, onEvent }) {
    this.workhorseId = workhorseId;
    this.onEvent = onEvent || (() => {});
    this.monitors = new Map();
    this._probing = new Set(); // instances with a probe in flight (one at a time)
  }

  // Apply the controller's authoritative roster (MSG.SYNC) into the local mirror,
  // then (re)start. Controller-owned fields come from the sync; workhorse-owned
  // runtime fields (pid/windowHandle/watermark/reports) are preserved on existing
  // records. desiredState only advances toward terminal. Then startAll launches/
  // monitors — stale pids are handled there (dead → relaunch, alive → just monitor).
  applySync(records) {
    mutateTracking(tracking => {
      for (const r of (records || [])) {
        if (!r.id) continue;
        const cur = tracking.instances[r.id];
        if (!cur) {
          tracking.instances[r.id] = { ...r };
        } else {
          if (r.name) cur.name = r.name;
          if (r.sessionId) cur.sessionId = r.sessionId;
          if (r.workhorseId) cur.workhorseId = r.workhorseId;
          if (r.projectPath) cur.projectPath = r.projectPath;
          cur.desiredState = maxDesiredState(cur.desiredState, r.desiredState);
        }
      }
    });
    this.startAll();
  }

  startAll() {
    const tracking = readTracking();
    const instances = getInstancesForWorkhorse(tracking, this.workhorseId);

    for (const inst of instances) {
      // Externally-held instances (adopted while open in the user's own GUI)
      // have no pid/handle we own — don't try to launch or supervise them.
      if (inst.desiredState === DESIRED_STATE.ALIVE && !inst.externallyHeld) {
        if (!adapter.isProcessAlive(inst.pid)) {
          this._launchAndMonitor(inst);
        } else {
          this._startMonitor(inst.id);
        }
      }
    }
  }

  createInstance({ id, name, sessionId, projectPath }) {
    // KI-1: a freshly-created (session-less) instance writes a NEW transcript on
    // disk once it starts. Snapshot the existing session ids BEFORE launch so we
    // can later identify the new one and adopt it as this instance's sessionId —
    // making crash-recovery resume WITH context instead of starting fresh.
    const knownSessionIds = sessionId ? null : new Set(listLocalSessions().map(s => s.sessionId));

    // Atomic: launch first, and only persist the record once we have a live pid.
    const launched = sessionId
      ? adapter.launchInstance(id, sessionId, projectPath)
      : adapter.createNewInstance(id, projectPath);
    if (!launched.pid) {
      return { success: false, error: 'Launch failed — instance not created' };
    }

    const record = createInstanceRecord({
      id,
      workhorseId: this.workhorseId,
      name,
      projectPath,
      sessionId,
      visibility: VISIBILITY.HIDDEN,
    });
    record.pid = launched.pid;
    record.windowHandle = launched.windowHandle;

    mutateTracking(tracking => addInstance(tracking, record));
    this._applyVisibility(record.windowHandle, record.visibility);
    this._startMonitor(id);
    // Fire-and-forget: don't block the CREATE ack on the capture poll.
    if (knownSessionIds) this._captureCreatedSession(id, projectPath, knownSessionIds);
    return { success: true, instance: record };
  }

  // KI-1: poll for the transcript a just-created instance writes, and adopt its
  // session id once it appears. The new session is the one that (a) wasn't on
  // disk before launch and (b) runs from this instance's projectPath. Stored
  // locally so workhorse-side relaunch resumes with context; the next state
  // update then carries it to the controller (folded first-write-wins).
  _captureCreatedSession(instanceId, projectPath, knownSessionIds) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(projectPath);
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // ~24s at 2s intervals — the window-handle poll alone can take ~12s
    const tick = () => {
      attempts++;
      let found = null;
      for (const s of listLocalSessions()) { // newest-first
        if (knownSessionIds.has(s.sessionId)) continue;
        const cwd = getSessionCwd(s.sessionId);
        if (cwd && norm(cwd) === target) { found = s.sessionId; break; }
      }
      if (found) {
        mutateTracking(tracking => {
          const inst = tracking.instances[instanceId];
          if (!inst || inst.sessionId) return false;
          updateInstance(tracking, instanceId, { sessionId: found });
          console.log(`[instances] captured session ${found} for created instance ${instanceId}`);
        });
        return;
      }
      if (attempts < MAX_ATTEMPTS) {
        setTimeout(tick, 2000);
      } else {
        console.warn(`[instances] could not capture a session id for created instance ${instanceId} (will start fresh on relaunch)`);
      }
    };
    setTimeout(tick, 2000);
  }

  manageExisting({ id, name, sessionId, projectPath, baseline, alreadyOpen, skipPermissions }) {
    // §4.6b step 1: resolve a partial/short id to the full session id and verify
    // it exists on disk BEFORE adopting (the full id is what `claude --resume`
    // and the report fork require).
    const resolvedId = resolveSessionId(sessionId);
    if (!resolvedId) {
      return { success: false, error: `Session not found on disk (or ambiguous prefix): ${sessionId}` };
    }
    sessionId = resolvedId;

    // The controller's primary is not an instance. Adopting it attaches a record to the
    // operator's own console and then applies the adopted-hidden default to it.
    if (isPrimarySession(sessionId)) {
      return { success: false, error: "That is the controller's own primary session — it cannot be managed as an instance" };
    }

    // `claude --resume` is project-scoped: the instance MUST run from the
    // session's own working directory, not wherever the manage command was
    // issued. Derive it from the transcript; fall back to the supplied path.
    const effectivePath = getSessionCwd(sessionId) || projectPath;

    // §4.6b: watermark defaults to "now" (current position) so pre-existing
    // history isn't reported as fresh; --baseline opts into a from-start report.
    const position = baseline ? 0 : getSessionPosition(sessionId);
    const record = createInstanceRecord({
      id,
      workhorseId: this.workhorseId,
      name,
      projectPath: effectivePath,
      sessionId,
      visibility: VISIBILITY.HIDDEN,
    });
    record.watermark = { position, timestamp: new Date().toISOString() };
    // Persisted so crash-recovery / restart relaunch with the same permission mode.
    record.skipPermissions = !!skipPermissions;

    // §4.6b secondary: the session is already open in a GUI the user holds.
    // Adopt the record as foreground (so it's never reported on until hidden)
    // and do NOT launch a duplicate window or supervise it. Locating/attaching
    // the user's pre-existing window is deferred to Phase 1.
    if (alreadyOpen) {
      record.visibility = VISIBILITY.FOREGROUND;
      record.pid = null;
      record.windowHandle = null;
      record.externallyHeld = true;
      mutateTracking(tracking => addInstance(tracking, record));
      return { success: true, instance: record };
    }

    // #1: if a claude window is ALREADY resuming this session (an orphan from a run we
    // lost track of), REUSE it rather than launch a duplicate — re-adopting after a
    // tracking loss attaches to the live window instead of piling up windows. Its handle
    // is null when the window is hidden (monitorable by pid; hide/show works again after
    // a relaunch). Falls back to a normal launch when nothing is already running it.
    // `findsession` matches a session id ANYWHERE in a command line, and the primary's
    // own line carries `--resume <id>`. A match on the primary's pid must be discarded,
    // or the record takes the primary's pid and window handle as its own.
    const found = adapter.findSessionWindow(sessionId);
    const existing = found && isPrimaryPid(found.pid) ? null : found;
    if (found && !existing) {
      console.warn(`[instances] ignored a window match on the controller's primary (pid=${found.pid}) for session ${sessionId.slice(0, 8)}`);
    }
    let reused = false;
    if (existing && adapter.isProcessAlive(existing.pid)) {
      record.pid = existing.pid;
      record.windowHandle = existing.windowHandle;
      reused = true;
      console.log(`[instances] re-attached ${id} to a running window pid=${existing.pid} (session ${sessionId.slice(0, 8)})`);
    } else {
      // Not currently running: resume it, verify the launch, and only THEN persist —
      // adoption is atomic, no partial/orphan record on failure.
      const launched = adapter.launchInstance(id, sessionId, effectivePath, { skipPermissions });
      if (!launched.pid) {
        return { success: false, error: 'Launch failed — session not adopted' };
      }
      record.pid = launched.pid;
      record.windowHandle = launched.windowHandle;
    }

    mutateTracking(tracking => addInstance(tracking, record));
    this._applyVisibility(record.windowHandle, record.visibility);
    this._startMonitor(id);
    return { success: true, instance: record, reused };
  }

  foreground(instanceId) {
    const inst = readTracking().instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (inst.heldBySubcontroller) return { success: false, error: 'Instance held for report — retry shortly' };

    if (inst.externallyHeld || !inst.windowHandle) {
      return { success: false, error: 'No managed window to foreground (externally held or not launched)' };
    }
    const shown = adapter.showWindow(inst.windowHandle); // adapter call outside the lock
    if (!shown) return { success: false, error: 'Window could not be shown (it may have exited)' };
    mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { visibility: VISIBILITY.FOREGROUND }); });
    return { success: true };
  }

  hide(instanceId) {
    const inst = readTracking().instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (isPrimaryPid(inst.pid)) {
      return { success: false, error: "That record points at the controller's primary window — refusing to hide it" };
    }

    const hidden = adapter.hideWindow(inst.windowHandle); // adapter call outside the lock
    if (hidden) {
      mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { visibility: VISIBILITY.HIDDEN }); });
    }
    return { success: hidden };
  }

  async report(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (isPrimaryPid(inst.pid)) {
      // Probing injects a prompt into the window. The primary is the operator's own
      // console; it must never be typed into by the fleet it supervises.
      return { success: false, error: "That record points at the controller's primary — not probing it", skipped: true };
    }
    if (inst.visibility === VISIBILITY.FOREGROUND) {
      return { success: false, error: 'Instance is foregrounded — skip', skipped: true };
    }
    // KI-6: advance the stored sessionId to the LIVE session BEFORE choosing probe vs
    // fork. BOTH paths must do this — otherwise the Windows probe path (which returns
    // early below) leaves the stored id stale and resume-on-restart reverts the
    // conversation. macOS uses the fork path, which always ran this, so it never had
    // the bug — the platform asymmetry behind "resume reverts on Windows, not macOS".
    // Best signal: the exact path the instance's own hook recorded (inst.transcriptPath)
    // — handles a continued/forked id or a moved cwd, no re-adopt. Else newest-in-slug
    // (excluding other instances'), then the stored id. Reset the watermark on a switch.
    let livePath = inst.transcriptPath && existsSync(inst.transcriptPath) ? inst.transcriptPath : null;
    if (!livePath) {
      const claimed = new Set(
        Object.values(tracking.instances).filter(i => i.id !== instanceId && i.sessionId).map(i => i.sessionId)
      );
      const liveSid = newestSessionInSlugOf(inst.sessionId, claimed);
      if (liveSid && liveSid !== inst.sessionId) {
        console.log(`[instances] ${instanceId}: live session moved ${inst.sessionId.slice(0, 8)} -> ${liveSid.slice(0, 8)}; tracking it`);
        mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { sessionId: liveSid, watermark: null }); });
        inst.sessionId = liveSid;
        inst.watermark = null;
      }
      livePath = getSessionJsonlPath(inst.sessionId);
    }

    // Probe-report path (Windows; on by default; EXECKEE_PROBE_REPORTS=0 to disable):
    // drive the live window rather than the on-disk transcript (stale for Remote-
    // Control-bridged sessions). Foregrounded instances are excluded above. Returns a
    // result to send back, or null on a hard probe failure → fall through to the fork.
    if (config.PROBE_REPORTS_ENABLED && probe.probeSupported && inst.pid && adapter.isProcessAlive(inst.pid)) {
      // A probe-disabled instance refused the live-probe (see _probeReportPath). Skip
      // injecting and use the fork — but re-test once the rolling refusal window has
      // expired, so a false positive (or a since-changed conversation) self-heals.
      if (inst.probeDisabled) {
        // Two causes share this one flag (refusal, and never reaching stable idle), so
        // the re-test window runs from whichever tally was touched last. Keyed on the
        // refusal anchor alone, a settle-failure disable had no anchor to expire.
        const since = Math.max(
          inst.probeRefusedSince ? Date.parse(inst.probeRefusedSince) : 0,
          inst.probeIdleFailSince ? Date.parse(inst.probeIdleFailSince) : 0,
        );
        if (since && (Date.now() - since) > config.PROBE_REFUSE_WINDOW_MS) {
          console.log(`[instances] ${instanceId} (${inst.name}) probe-disable window expired — re-enabling live-probe`);
          mutateTracking(t => {
            if (!t.instances[instanceId]) return false;
            updateInstance(t, instanceId, {
              probeDisabled: false,
              probeRefusedCount: 0,
              probeRefusedSince: null,
              probeIdleFailCount: 0,
              probeIdleFailSince: null,
            });
          });
          inst.probeDisabled = false;
        }
      }
      if (!inst.probeDisabled) {
        const pr = await this._probeReportPath(instanceId, inst);
        if (pr) return pr;
      }
    }

    // Fork path (live transcript already resolved above).
    const curSize = livePath && existsSync(livePath) ? statSync(livePath).size : 0;
    if (curSize <= ((inst.watermark && inst.watermark.position) || 0)) {
      return { success: false, error: 'No changes since last report — skip', skipped: true };
    }

    mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { heldBySubcontroller: true }); });

    const result = await runForkReport(inst.sessionId, inst.projectPath);

    if (result.success) {
      if (result.modelUsed && result.modelUsed !== 'session-default') {
        console.log(`[instances] ${instanceId} report used fallback model '${result.modelUsed}'`);
      }
      mutateTracking(t => {
        if (!t.instances[instanceId]) return false;
        updateInstance(t, instanceId, {
          heldBySubcontroller: false,
          lastReportTime: new Date().toISOString(),
          lastReportContent: result.report,
          watermark: result.watermark,
          reportFailureCount: 0,
          lastReportError: null,
        });
      });
    } else {
      // Don't advance the watermark (so it retries), but make the persistent
      // failure loud — count it, record the reason, and flag it upward.
      let count = 1;
      mutateTracking(t => {
        const i = t.instances[instanceId];
        if (!i) return false;
        count = (i.reportFailureCount || 0) + 1;
        updateInstance(t, instanceId, {
          heldBySubcontroller: false,
          reportFailureCount: count,
          lastReportError: result.error,
        });
      });
      console.error(`[instances] REPORT FAILED for ${instanceId} (${inst.name}), attempt ${count}: ${result.error}`);
      this.onEvent({ type: 'report-failed', instanceId, error: result.error, count, attempts: result.attempts });
    }

    return result;
  }

  // Opt-in probe report (see probe.js). Holds the instance for the subcontroller
  // (so the primary can't foreground it mid-probe), drives the live window, and on
  // success stores the report + the staleness marker. Returns the result to send,
  // or null on a hard failure so report() falls through to the fork path.
  async _probeReportPath(instanceId, inst) {
    // One probe per instance at a time. Without this, overlapping report triggers
    // each settle-and-inject before the model has responded to the first, splicing
    // several probe prompts into the window at once (the "first probe succeeded but
    // it still sent three" bug). A probe arriving while one is in flight just skips —
    // the in-flight one will produce the report.
    if (this._probing.has(instanceId)) {
      return { success: false, error: 'Probe already in flight — skip', skipped: true };
    }
    this._probing.add(instanceId);
    try {
      mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { heldBySubcontroller: true }); });

      let result;
      try {
        result = await probe.probeReport(inst, { lastMarker: inst.probeMarker });
      } catch (err) {
        result = { success: false, error: err.message };
      }

      if (result.success) {
        mutateTracking(t => {
          if (!t.instances[instanceId]) return false;
          updateInstance(t, instanceId, {
            heldBySubcontroller: false,
            lastReportTime: new Date().toISOString(),
            lastReportContent: result.report,
            probeMarker: result.marker,
            reportFailureCount: 0,
            lastReportError: null,
            // B3: a successful probe clears any in-window refusal tally, so intermittent
            // refusals don't accumulate toward a disable across unrelated good probes.
            probeRefusedCount: 0,
            probeRefusedSince: null,
            probeIdleFailCount: 0,
            probeIdleFailSince: null,
          });
        });
        console.log(`[instances] ${instanceId} (${inst.name}) probe report ok`);
        return { success: true, report: result.report };
      }
      mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { heldBySubcontroller: false }); });

      if (result.refused) {
        // The instance declined the probe. Tally it within a rolling window (anchored on
        // the first refusal); after PROBE_REFUSE_LIMIT in-window refusals, disable the
        // live-probe so we stop re-injecting (report() then uses the fork until the
        // window expires and re-tests). Fall through to the fork report this cycle.
        let count = 1, disabled = false;
        mutateTracking(t => {
          const i = t.instances[instanceId];
          if (!i) return false;
          const since = i.probeRefusedSince ? Date.parse(i.probeRefusedSince) : 0;
          const fresh = !since || (Date.now() - since) > config.PROBE_REFUSE_WINDOW_MS;
          count = fresh ? 1 : (i.probeRefusedCount || 0) + 1;
          disabled = count >= config.PROBE_REFUSE_LIMIT;
          updateInstance(t, instanceId, {
            probeRefusedCount: count,
            probeRefusedSince: fresh ? new Date().toISOString() : i.probeRefusedSince,
            probeDisabled: disabled,
          });
        });
        console.warn(`[instances] ${instanceId} (${inst.name}) refused the probe (${count}/${config.PROBE_REFUSE_LIMIT})${disabled ? ' — disabling live-probe; using fork reports' : ''}`);
        return null; // report() falls through to the fork path
      }
      if (result.noStableIdle) {
        // H2: the settle loop costs PROBE_SETTLE_SAMPLES * PROBE_IDLE_SETTLE_MS (18s by
        // default) and this failure has historically repeated every cycle for weeks on
        // the same instances — 5152 times in the log. Tally it the way refusals are
        // tallied and stop paying for it, but keep the weekly re-test so a transient
        // cause self-heals. Report quality is unaffected: these instances were already
        // being served by the fork.
        let count = 1, disabled = false;
        mutateTracking(t => {
          const i = t.instances[instanceId];
          if (!i) return false;
          const since = i.probeIdleFailSince ? Date.parse(i.probeIdleFailSince) : 0;
          const fresh = !since || (Date.now() - since) > config.PROBE_REFUSE_WINDOW_MS;
          count = fresh ? 1 : (i.probeIdleFailCount || 0) + 1;
          disabled = count >= config.PROBE_REFUSE_LIMIT;
          // Keep a disable the REFUSAL tally still justifies; otherwise this cause owns
          // the flag. Inheriting it unconditionally made it permanent: a restarted
          // tally would re-disable on its first strike.
          const rSince = i.probeRefusedSince ? Date.parse(i.probeRefusedSince) : 0;
          const refusalStillHolds = !!rSince
            && (Date.now() - rSince) <= config.PROBE_REFUSE_WINDOW_MS
            && (i.probeRefusedCount || 0) >= config.PROBE_REFUSE_LIMIT;
          updateInstance(t, instanceId, {
            probeIdleFailCount: count,
            probeIdleFailSince: fresh ? new Date().toISOString() : i.probeIdleFailSince,
            probeDisabled: disabled || refusalStillHolds,
          });
        });
        console.warn(`[instances] ${instanceId} (${inst.name}) ${result.error} (${count}/${config.PROBE_REFUSE_LIMIT})` +
          (disabled ? ' — disabling live-probe; using fork reports' : '') +
          ` — frame dumped to logs/probe-frames/${instanceId}.txt`);
        return null; // fork path
      }
      if (result.unchanged) return { success: false, error: 'No changes since last probe — skip', skipped: true };
      if (result.skipped) return { success: false, error: `Probe skipped (${result.reason})`, skipped: true };
      // result.fallback (or any other non-skip failure): the live-window probe did
      // not behave as expected — revert to the on-disk fork report this cycle.
      console.warn(`[instances] ${instanceId} probe -> fork fallback (${result.error})`);
      return null; // report() falls through to the fork path
    } finally {
      this._probing.delete(instanceId);
    }
  }

  close(instanceId) {
    const inst = readTracking().instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };

    mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { desiredState: DESIRED_STATE.CLOSING }); });

    this._stopMonitor(instanceId);
    adapter.killInstance(inst.pid); // adapter call outside the lock

    mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { desiredState: DESIRED_STATE.CLOSED }); });

    return { success: true };
  }

  unmanage(instanceId) {
    this._stopMonitor(instanceId);
    mutateTracking(t => { delete t.instances[instanceId]; });
    return { success: true };
  }

  // Toggle an instance between direct-to-Anthropic and gateway-routed. There is no
  // in-place way to change a live window's base URL, so this is a quit-and-relaunch
  // via --resume (same mechanism, and same caveat, as a permission-mode change:
  // recent turns the window held in memory but hadn't flushed can be lost — the
  // primary warns the user before invoking this, per the operator brief). The mode
  // persists on the record, so crash-recovery relaunches keep it.
  async flip(instanceId) {
    const inst = readTracking().instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (inst.externallyHeld) return { success: false, error: 'Instance is externally held (open in the user\'s own GUI) — cannot quit/relaunch it' };
    const target = !inst.gatewayMode;
    if (target && !config.GATEWAY_ENABLED) return { success: false, error: 'Gateway is disabled on this workhorse (EXECKEE_GATEWAY=0)' };
    // Never flip ONTO a gateway that isn't listening — the relaunched window would
    // send every request to a dead proxy. (Flipping OFF is always safe.)
    if (target && !(await portInUse(config.GATEWAY_PORT))) {
      return { success: false, error: `Gateway is not running on this machine (${config.GATEWAY_URL}) — start the workhorse supervisor or install the binary; instance left unchanged` };
    }

    // KI-6: advance to the LIVE session id before relaunching, or --resume reverts
    // the conversation to a stale transcript (same rule as report()).
    let liveSid = inst.sessionId;
    const claimed = new Set(
      Object.values(readTracking().instances).filter(i => i.id !== instanceId && i.sessionId).map(i => i.sessionId)
    );
    const newest = newestSessionInSlugOf(inst.sessionId, claimed);
    if (newest && newest !== inst.sessionId) {
      console.log(`[instances] ${instanceId}: flip tracking live session ${inst.sessionId.slice(0, 8)} -> ${newest.slice(0, 8)}`);
      liveSid = newest;
    }

    this._stopMonitor(instanceId);
    if (adapter.isProcessAlive(inst.pid)) {
      adapter.killInstance(inst.pid);
      // Wait for the old process to actually exit before resuming its session —
      // relaunching while it still holds the window/session races the transcript.
      for (let i = 0; i < 20 && adapter.isProcessAlive(inst.pid); i++) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (adapter.isProcessAlive(inst.pid)) {
        this._startMonitor(instanceId); // leave it as it was
        return { success: false, error: 'Old window did not exit — flip aborted, instance unchanged' };
      }
    }

    mutateTracking(t => {
      if (!t.instances[instanceId]) return false;
      updateInstance(t, instanceId, { gatewayMode: target, sessionId: liveSid, watermark: liveSid !== inst.sessionId ? null : inst.watermark, pid: null, windowHandle: null });
    });
    this._launchAndMonitor(readTracking().instances[instanceId]);

    const after = readTracking().instances[instanceId];
    if (!after || !after.pid) {
      return { success: false, error: 'Relaunch produced no pid — check the workhorse log', gateway: target };
    }
    console.log(`[instances] ${instanceId} (${inst.name}) flipped ${target ? 'onto' : 'off'} the gateway (pid=${after.pid})`);
    return { success: true, gateway: target };
  }

  getLocalState() {
    const tracking = readTracking();
    const instances = getInstancesForWorkhorse(tracking, this.workhorseId);
    // Full workhorse-owned field set, so the controller can fold this into its
    // master tracking (§2.2/§2.3). Controller-owned fields (id/name/sessionId/
    // workhorseId/createdAt) are echoed but the controller trusts its own.
    return instances.map(inst => ({
      id: inst.id,
      name: inst.name,
      sessionId: inst.sessionId,
      workhorseId: inst.workhorseId,
      projectPath: inst.projectPath,
      desiredState: inst.desiredState,
      visibility: inst.visibility,
      externallyHeld: inst.externallyHeld,
      pid: inst.pid,
      windowHandle: inst.windowHandle,
      crashCount: inst.crashCount,
      heldBySubcontroller: inst.heldBySubcontroller,
      watermark: inst.watermark,
      lastReportTime: inst.lastReportTime,
      lastReportContent: inst.lastReportContent,
      reportFailureCount: inst.reportFailureCount,
      lastReportError: inst.lastReportError,
      skipPermissions: inst.skipPermissions,
      gatewayMode: !!inst.gatewayMode,
      processAlive: adapter.isProcessAlive(inst.pid),
      lastActivityTime: inst.lastActivityTime,
    }));
  }

  _launchAndMonitor(inst) {
    console.log(`[instances] Launching instance ${inst.id} (session: ${inst.sessionId})`);
    const launched = adapter.launchInstance(inst.id, inst.sessionId, inst.projectPath, { skipPermissions: inst.skipPermissions, gateway: inst.gatewayMode }); // adapter call outside the lock
    mutateTracking(t => {
      if (!t.instances[inst.id]) return false;
      updateInstance(t, inst.id, {
        pid: launched.pid,
        windowHandle: launched.windowHandle,
        crashCount: inst.crashCount || 0,
      });
    });
    // Restore the instance's prior visibility (§4.6a): a recovered crash should
    // come back the way it was, not forced visible.
    this._applyVisibility(launched.windowHandle, inst.visibility);
    this._startMonitor(inst.id);
  }

  // Make the physical window match the tracked visibility. Managed/created
  // instances default to hidden (§4.6b: adopted hidden, available to the
  // subcontroller); crash-recovery passes the prior visibility.
  _applyVisibility(windowHandle, visibility) {
    if (!windowHandle) return;
    if (visibility === VISIBILITY.FOREGROUND) {
      adapter.showWindow(windowHandle);
    } else {
      adapter.hideWindow(windowHandle);
    }
  }

  _startMonitor(instanceId) {
    if (this.monitors.has(instanceId)) return;

    const interval = setInterval(() => {
      const inst = readTracking().instances[instanceId];
      if (!inst) {
        this._stopMonitor(instanceId);
        return;
      }

      // In-instance close (§4.6a): the hook set desiredState=closing locally
      // before exit. Finalize it here — kill the window if still up, mark
      // closed, and stop. A bare exit is never a close; only this transition is.
      if (inst.desiredState === DESIRED_STATE.CLOSING) {
        if (adapter.isProcessAlive(inst.pid)) {
          adapter.killInstance(inst.pid); // adapter call outside the lock
        }
        mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { desiredState: DESIRED_STATE.CLOSED }); });
        this._stopMonitor(instanceId);
        this.onEvent({ type: 'closed', instanceId });
        return;
      }

      if (inst.desiredState !== DESIRED_STATE.ALIVE) {
        this._stopMonitor(instanceId);
        return;
      }

      // Single-signal liveness: claude.exe owns its own window, so a dead PID
      // means a genuinely dead session (no zombie window to confuse us).
      if (!adapter.isProcessAlive(inst.pid)) {
        console.log(`[instances] Instance ${instanceId} (pid=${inst.pid}) died — crash recovery`);
        const newCount = (inst.crashCount || 0) + 1;

        if (newCount > config.CRASH_RETRY_MAX) {
          console.log(`[instances] Instance ${instanceId} exceeded crash limit — marking failed`);
          mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { desiredState: DESIRED_STATE.FAILED, crashCount: newCount }); });
          this._stopMonitor(instanceId);
          this.onEvent({ type: 'crash-failed', instanceId, crashCount: newCount });
          return;
        }

        mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { crashCount: newCount }); });

        // Stop monitoring during the relaunch so we don't double-fire while the
        // new window is still coming up (launch polls up to ~12s for its handle).
        this._stopMonitor(instanceId);
        inst.crashCount = newCount; // carry the bumped count into the relaunch
        const delay = config.CRASH_RETRY_BASE_MS * Math.pow(2, newCount - 1);
        setTimeout(() => {
          this._launchAndMonitor(inst);
          this.onEvent({ type: 'crash-recovery', instanceId, crashCount: newCount });
        }, delay);
      }
    }, 5000);

    this.monitors.set(instanceId, interval);
  }

  _stopMonitor(instanceId) {
    const interval = this.monitors.get(instanceId);
    if (interval) {
      clearInterval(interval);
      this.monitors.delete(instanceId);
    }
  }

  stopAll() {
    for (const [id, interval] of this.monitors) {
      clearInterval(interval);
    }
    this.monitors.clear();
  }
}
