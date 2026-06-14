import { readTracking, writeTracking, createInstanceRecord, addInstance, updateInstance, getInstancesForWorkhorse } from '../common/tracking.js';
import { DESIRED_STATE, VISIBILITY } from '../common/protocol.js';
import { hasSessionChanged, runForkReport, getSessionPosition } from './reporter.js';
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
      if (inst.desiredState === DESIRED_STATE.ALIVE) {
        if (!adapter.isProcessAlive(inst.id)) {
          this._launchAndMonitor(inst);
        } else {
          this._startMonitor(inst.id);
        }
      }
    }
  }

  createInstance({ id, name, sessionId, projectPath }) {
    const tracking = readTracking();

    const record = createInstanceRecord({
      id,
      workhorseId: this.workhorseId,
      name,
      projectPath,
      sessionId,
      visibility: VISIBILITY.HIDDEN,
    });

    addInstance(tracking, record);
    writeTracking(tracking);

    if (sessionId) {
      adapter.launchInstance(id, sessionId, projectPath);
    } else {
      const result = adapter.createNewInstance(id, projectPath);
      record.sessionId = null;
    }

    this._startMonitor(id);
    return record;
  }

  manageExisting({ id, name, sessionId, projectPath }) {
    const tracking = readTracking();

    const position = getSessionPosition(sessionId);
    const record = createInstanceRecord({
      id,
      workhorseId: this.workhorseId,
      name,
      projectPath,
      sessionId,
      visibility: VISIBILITY.HIDDEN,
    });
    record.watermark = { position, timestamp: new Date().toISOString() };

    addInstance(tracking, record);
    writeTracking(tracking);
    this._startMonitor(id);
    return record;
  }

  foreground(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };
    if (inst.heldBySubcontroller) return { success: false, error: 'Instance held for report — retry shortly' };

    const shown = adapter.showWindow(instanceId);
    if (shown) {
      updateInstance(tracking, instanceId, { visibility: VISIBILITY.FOREGROUND });
      writeTracking(tracking);
    }
    return { success: shown };
  }

  hide(instanceId) {
    const tracking = readTracking();
    const inst = tracking.instances[instanceId];
    if (!inst) return { success: false, error: 'Instance not found' };

    const hidden = adapter.hideWindow(instanceId);
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

    const result = await runForkReport(inst.sessionId);

    const fresh = readTracking();
    if (result.success) {
      updateInstance(fresh, instanceId, {
        heldBySubcontroller: false,
        lastReportTime: new Date().toISOString(),
        lastReportContent: result.report,
        watermark: result.watermark,
      });
    } else {
      updateInstance(fresh, instanceId, { heldBySubcontroller: false });
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
    adapter.killInstance(instanceId);

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
      processAlive: adapter.isProcessAlive(inst.id),
      lastActivityTime: inst.lastActivityTime,
    }));
  }

  _launchAndMonitor(inst) {
    console.log(`[instances] Launching instance ${inst.id} (session: ${inst.sessionId})`);
    adapter.launchInstance(inst.id, inst.sessionId, inst.projectPath);
    this._startMonitor(inst.id);
  }

  _startMonitor(instanceId) {
    if (this.monitors.has(instanceId)) return;

    const interval = setInterval(() => {
      const tracking = readTracking();
      const inst = tracking.instances[instanceId];
      if (!inst || inst.desiredState !== DESIRED_STATE.ALIVE) {
        this._stopMonitor(instanceId);
        return;
      }

      if (!adapter.isProcessAlive(instanceId)) {
        console.log(`[instances] Instance ${instanceId} process died — crash recovery`);
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
