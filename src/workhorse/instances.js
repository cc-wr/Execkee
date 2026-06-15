import { readTracking, writeTracking, createInstanceRecord, addInstance, updateInstance, getInstancesForWorkhorse } from '../common/tracking.js';
import { DESIRED_STATE, VISIBILITY } from '../common/protocol.js';
import { hasSessionChanged, runForkReport, getSessionPosition, getSessionJsonlPath, getSessionCwd } from './reporter.js';
import * as adapter from './adapter-win.js';
import config from '../common/config.js';

export class InstanceManager {
  constructor({ workhorseId, onEvent }) {
    this.workhorseId = workhorseId;
    this.onEvent = onEvent || (() => {});
    this.monitors = new Map();
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
    return { success: true, instance: record };
  }

  manageExisting({ id, name, sessionId, projectPath, baseline, alreadyOpen }) {
    // §4.6b step 1: verify the session exists on disk BEFORE adopting anything.
    if (!getSessionJsonlPath(sessionId)) {
      return { success: false, error: 'Session not found on disk' };
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
    const launched = adapter.launchInstance(id, sessionId, effectivePath);
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
    if (!hasSessionChanged(inst.sessionId, inst.watermark)) {
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
    return instances.map(inst => ({
      id: inst.id,
      name: inst.name,
      sessionId: inst.sessionId,
      desiredState: inst.desiredState,
      visibility: inst.visibility,
      heldBySubcontroller: inst.heldBySubcontroller,
      processAlive: adapter.isProcessAlive(inst.pid),
      lastActivityTime: inst.lastActivityTime,
    }));
  }

  _launchAndMonitor(inst) {
    console.log(`[instances] Launching instance ${inst.id} (session: ${inst.sessionId})`);
    const launched = adapter.launchInstance(inst.id, inst.sessionId, inst.projectPath);
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
