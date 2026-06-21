import config from './config.js';
import { DESIRED_STATE, VISIBILITY } from './protocol.js';
import { readJsonSafe, atomicWriteJson, snapshotBackup, acquireLock, releaseLock } from './safe-fs.js';

function emptyTrackingFile() {
  return { version: 1, workhorses: {}, instances: {} };
}

export function readTracking() {
  // Corruption-preserving read (safe-fs): a corrupt tracking file is moved aside, not
  // silently reported as empty — so a later write can't persist the empty default over
  // it. Previously a parse error was masked as { instances:{} }, which is one way the
  // whole instance set could vanish.
  return readJsonSafe(config.TRACKING_FILE, emptyTrackingFile(), config.TRACKING_FILE);
}

export function writeTracking(data) {
  // Atomic write that RETRIES the rename instead of unlinking the target on failure.
  // The old fallback unlinked the file first, opening a window with no file; on Windows
  // the rename fails often (the workhorse, the state loop, and the per-instance hooks
  // all hold tracking.json at once), so that window was hit routinely and a concurrent
  // reader could see "missing" -> empty -> persist the wipe. See safe-fs.js.
  //
  // Defense in depth: if this write would drop a populated instance set to empty, back
  // the file up and log loudly first. The write still proceeds (removing the last
  // instance is legitimate), but it is now recoverable and visible.
  const inInst = data && data.instances ? Object.keys(data.instances).length : 0;
  if (inInst === 0) {
    const cur = readJsonSafe(config.TRACKING_FILE, null, config.TRACKING_FILE);
    const curInst = cur && cur.instances ? Object.keys(cur.instances).length : 0;
    if (curInst > 0) {
      snapshotBackup(config.TRACKING_FILE);
      console.error(`[tracking] writing tracking with 0 instances over ${curInst} existing — backed up first (instance-loss guard). Investigate if unexpected.`);
    }
  }
  atomicWriteJson(config.TRACKING_FILE, data);
}

export function createInstanceRecord({ id, workhorseId, name, projectPath, sessionId, visibility }) {
  const now = new Date().toISOString();
  return {
    id,
    workhorseId,
    name: name || 'Unnamed',
    projectPath: projectPath || null,
    sessionId,
    desiredState: DESIRED_STATE.ALIVE,
    visibility: visibility || VISIBILITY.HIDDEN,
    pid: null,
    windowHandle: null,
    heldBySubcontroller: false,
    externallyHeld: false,
    watermark: { position: 0, timestamp: null },
    lastReportTime: null,
    lastReportContent: null,
    reportFailureCount: 0,
    lastReportError: null,
    lastActivityTime: now,
    createdAt: now,
    crashCount: 0,
  };
}

export function registerWorkhorse(tracking, { id, name, os }) {
  tracking.workhorses[id] = {
    id,
    name: name || id,
    os: os || 'unknown',
    registeredAt: new Date().toISOString(),
  };
  return tracking;
}

export function addInstance(tracking, record) {
  tracking.instances[record.id] = record;
  return tracking;
}

export function updateInstance(tracking, instanceId, updates) {
  if (tracking.instances[instanceId]) {
    Object.assign(tracking.instances[instanceId], updates);
  }
  return tracking;
}

export function removeInstance(tracking, instanceId) {
  delete tracking.instances[instanceId];
  return tracking;
}

export function getInstancesForWorkhorse(tracking, workhorseId) {
  return Object.values(tracking.instances).filter(i => i.workhorseId === workhorseId);
}

// Serialized read-modify-write of the tracking store. Acquire a cross-process lock,
// read fresh, apply `fn(tracking)` (a SHORT synchronous mutation — no awaits, no
// adapter/PowerShell calls), then write. `fn` may return false to signal "no change"
// and skip the write. This is the cross-process race fix: the workhorse and the
// per-instance hooks all mutate the SAME tracking.json, and without serialization a
// stale read + late write drops a concurrently-added/updated instance. Use this for
// every workhorse-side mutation; keep slow work outside the callback.
export function mutateTracking(fn) {
  const lock = acquireLock(config.TRACKING_FILE);
  try {
    const tracking = readTracking();
    const r = fn(tracking);
    if (r === false) return tracking;
    writeTracking(tracking);
    return tracking;
  } finally {
    releaseLock(lock);
  }
}
