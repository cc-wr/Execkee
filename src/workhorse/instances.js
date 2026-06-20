import { readTracking, writeTracking, createInstanceRecord, addInstance, updateInstance, getInstancesForWorkhorse } from '../common/tracking.js';
import { DESIRED_STATE, VISIBILITY, maxDesiredState } from '../common/protocol.js';
import { existsSync, statSync } from 'fs';
import { hasSessionChanged, runForkReport, getSessionPosition, getSessionJsonlPath, getSessionCwd, resolveSessionId, listLocalSessions, newestSessionInSlugOf } from './reporter.js';
import * as adapter from './adapter.js';
import * as probe from './probe.js';
import config from '../common/config.js';

export class InstanceManager {
  constructor({ workhorseId, onEvent }) {
    this.workhorseId = workhorseId;
    this.onEvent = onEvent || (() => {});
    this.monitors = new Map();
  }

  // Apply the controller's authoritative roster (MSG.SYNC) into the local mirror,
  // then (re)start. Controller-owned fields come from the sync; workhorse-owned
  // runtime fields (pid/windowHandle/watermark/reports) are preserved on existing
  // records. desiredState only advances toward terminal. Then startAll launches/
  // monitors — stale pids are handled there (dead → relaunch, alive → just monitor).
  applySync(records) {
    const tracking = readTracking();
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
    writeTracking(tracking);
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

    const tracking = readTracking();
    addInstance(tracking, record);
    writeTracking(tracking);
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
        const tracking = readTracking();
        const inst = tracking.instances[instanceId];
        if (inst && !inst.sessionId) {
          updateInstance(tracking, instanceId, { sessionId: found });
          writeTracking(tracking);
          console.log(`[instances] captured session ${found} for created instance ${instanceId}`);
        }
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
      const tracking = readTracking();
      addInstance(tracking, record);
      writeTracking(tracking);
      return { success: true, instance: record };
    }

    // Common case (not currently open): resume it, verify the launch, and only
    // THEN persist — adoption is atomic, no partial/orphan record on failure.
    const launched = adapter.launchInstance(id, sessionId, effectivePath, { skipPermissions });
    if (!launched.pid) {
      return { success: false, error: 'Launch failed — session not adopted' };
    }
    record.pid = launched.pid;
    record.windowHandle = launched.windowHandle;

    const tracking = readTracking();
    addInstance(tracking, record);
    writeTracking(tracking);
    this._applyVisibility(record.windowHandle, record.visibility);
    this._startMonitor(id);
    return { success: true, instance: record };
  }

  foreground(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (inst.heldBySubcontroller) return { success: false, error: 'Instance held for report — retry shortly' };

    if (inst.externallyHeld || !inst.windowHandle) {
      return { success: false, error: 'No managed window to foreground (externally held or not launched)' };
    }
    const shown = adapter.showWindow(inst.windowHandle);
    if (shown) {
      updateInstance(tracking, instanceId, { visibility: VISIBILITY.FOREGROUND });
      writeTracking(tracking);
      return { success: true };
    }
    return { success: false, error: 'Window could not be shown (it may have exited)' };
  }

  hide(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };

    const hidden = adapter.hideWindow(inst.windowHandle);
    if (hidden) {
      updateInstance(tracking, instanceId, { visibility: VISIBILITY.HIDDEN });
      writeTracking(tracking);
    }
    return { success: hidden };
  }

  async report(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (inst.visibility === VISIBILITY.FOREGROUND) {
      return { success: false, error: 'Instance is foregrounded — skip' };
    }
    // Probe-report path (opt-in, EXECKEE_PROBE_REPORTS=1): generate the report by
    // driving the live window rather than the on-disk transcript (which is stale
    // for Remote-Control-bridged sessions). Returns a result to send back; returns
    // null only on a hard probe failure, in which case we fall through to the fork.
    if (config.PROBE_REPORTS_ENABLED && probe.probeSupported && inst.pid && adapter.isProcessAlive(inst.pid)) {
      const pr = await this._probeReportPath(instanceId, inst);
      if (pr) return pr;
    }
    // Resolve the LIVE transcript. Best signal: the exact path the instance's own hook
    // recorded on its last prompt (inst.transcriptPath) — handles a session that
    // continued/forked into a new id or moved to a different dir, with no re-adopt.
    // Fall back to newest-in-slug (excluding other instances' sessions), then the
    // stored id. Reset the watermark on a switch so the new session reports in full.
    let livePath = inst.transcriptPath && existsSync(inst.transcriptPath) ? inst.transcriptPath : null;
    if (!livePath) {
      const claimed = new Set(
        Object.values(tracking.instances).filter(i => i.id !== instanceId && i.sessionId).map(i => i.sessionId)
      );
      const liveSid = newestSessionInSlugOf(inst.sessionId, claimed);
      if (liveSid && liveSid !== inst.sessionId) {
        console.log(`[instances] ${instanceId}: live session moved ${inst.sessionId.slice(0, 8)} -> ${liveSid.slice(0, 8)}; tracking it`);
        updateInstance(tracking, instanceId, { sessionId: liveSid, watermark: null });
        writeTracking(tracking);
        inst.sessionId = liveSid;
        inst.watermark = null;
      }
      livePath = getSessionJsonlPath(inst.sessionId);
    }
    const curSize = livePath && existsSync(livePath) ? statSync(livePath).size : 0;
    if (curSize <= ((inst.watermark && inst.watermark.position) || 0)) {
      return { success: false, error: 'No changes since last report — skip', skipped: true };
    }

    updateInstance(tracking, instanceId, { heldBySubcontroller: true });
    writeTracking(tracking);

    const result = await runForkReport(inst.sessionId, inst.projectPath);

    const fresh = readTracking();
    if (result.success) {
      if (result.modelUsed && result.modelUsed !== 'session-default') {
        console.log(`[instances] ${instanceId} report used fallback model '${result.modelUsed}'`);
      }
      updateInstance(fresh, instanceId, {
        heldBySubcontroller: false,
        lastReportTime: new Date().toISOString(),
        lastReportContent: result.report,
        watermark: result.watermark,
        reportFailureCount: 0,
        lastReportError: null,
      });
    } else {
      // Don't advance the watermark (so it retries), but make the persistent
      // failure loud — count it, record the reason, and flag it upward.
      const count = (inst.reportFailureCount || 0) + 1;
      console.error(`[instances] REPORT FAILED for ${instanceId} (${inst.name}), attempt ${count}: ${result.error}`);
      updateInstance(fresh, instanceId, {
        heldBySubcontroller: false,
        reportFailureCount: count,
        lastReportError: result.error,
      });
      this.onEvent({ type: 'report-failed', instanceId, error: result.error, count, attempts: result.attempts });
    }
    writeTracking(fresh);

    return result;
  }

  // Opt-in probe report (see probe.js). Holds the instance for the subcontroller
  // (so the primary can't foreground it mid-probe), drives the live window, and on
  // success stores the report + the staleness marker. Returns the result to send,
  // or null on a hard failure so report() falls through to the fork path.
  async _probeReportPath(instanceId, inst) {
    const t = readTracking();
    updateInstance(t, instanceId, { heldBySubcontroller: true });
    writeTracking(t);

    let result;
    try {
      result = await probe.probeReport(inst, { lastMarker: inst.probeMarker });
    } catch (err) {
      result = { success: false, error: err.message };
    }

    const fresh = readTracking();
    if (result.success) {
      updateInstance(fresh, instanceId, {
        heldBySubcontroller: false,
        lastReportTime: new Date().toISOString(),
        lastReportContent: result.report,
        probeMarker: result.marker,
        reportFailureCount: 0,
        lastReportError: null,
      });
      writeTracking(fresh);
      console.log(`[instances] ${instanceId} (${inst.name}) probe report ok`);
      return { success: true, report: result.report };
    }
    updateInstance(fresh, instanceId, { heldBySubcontroller: false });
    writeTracking(fresh);

    if (result.unchanged) return { success: false, error: 'No changes since last probe — skip', skipped: true };
    if (result.skipped) return { success: false, error: `Probe skipped (${result.reason})`, skipped: true };
    // result.fallback (or any other non-skip failure): the live-window probe did
    // not behave as expected — revert to the on-disk fork report this cycle.
    console.warn(`[instances] ${instanceId} probe -> fork fallback (${result.error})`);
    return null; // report() falls through to the fork path
  }

  close(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };

    updateInstance(tracking, instanceId, { desiredState: DESIRED_STATE.CLOSING });
    writeTracking(tracking);

    this._stopMonitor(instanceId);
    adapter.killInstance(inst.pid);

    const fresh = readTracking();
    updateInstance(fresh, instanceId, { desiredState: DESIRED_STATE.CLOSED });
    writeTracking(fresh);

    return { success: true };
  }

  unmanage(instanceId) {
    const tracking = readTracking();
    this._stopMonitor(instanceId);
    delete tracking.instances[instanceId];
    writeTracking(tracking);
    return { success: true };
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
      processAlive: adapter.isProcessAlive(inst.pid),
      lastActivityTime: inst.lastActivityTime,
    }));
  }

  _launchAndMonitor(inst) {
    console.log(`[instances] Launching instance ${inst.id} (session: ${inst.sessionId})`);
    const launched = adapter.launchInstance(inst.id, inst.sessionId, inst.projectPath, { skipPermissions: inst.skipPermissions });
    const tracking = readTracking();
    updateInstance(tracking, inst.id, {
      pid: launched.pid,
      windowHandle: launched.windowHandle,
      crashCount: inst.crashCount || 0,
    });
    writeTracking(tracking);
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
      const tracking = readTracking();
      const inst = tracking.instances[instanceId];
      if (!inst) {
        this._stopMonitor(instanceId);
        return;
      }

      // In-instance close (§4.6a): the hook set desiredState=closing locally
      // before exit. Finalize it here — kill the window if still up, mark
      // closed, and stop. A bare exit is never a close; only this transition is.
      if (inst.desiredState === DESIRED_STATE.CLOSING) {
        if (adapter.isProcessAlive(inst.pid)) {
          adapter.killInstance(inst.pid);
        }
        updateInstance(tracking, instanceId, { desiredState: DESIRED_STATE.CLOSED });
        writeTracking(tracking);
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
        inst.crashCount = (inst.crashCount || 0) + 1;

        if (inst.crashCount > config.CRASH_RETRY_MAX) {
          console.log(`[instances] Instance ${instanceId} exceeded crash limit — marking failed`);
          updateInstance(tracking, instanceId, { desiredState: DESIRED_STATE.FAILED });
          writeTracking(tracking);
          this._stopMonitor(instanceId);
          this.onEvent({ type: 'crash-failed', instanceId, crashCount: inst.crashCount });
          return;
        }

        updateInstance(tracking, instanceId, { crashCount: inst.crashCount });
        writeTracking(tracking);

        // Stop monitoring during the relaunch so we don't double-fire while the
        // new window is still coming up (launch polls up to ~12s for its handle).
        this._stopMonitor(instanceId);
        const delay = config.CRASH_RETRY_BASE_MS * Math.pow(2, inst.crashCount - 1);
        setTimeout(() => {
          this._launchAndMonitor(inst);
          this.onEvent({ type: 'crash-recovery', instanceId, crashCount: inst.crashCount });
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
