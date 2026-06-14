import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import config from './config.js';
import { DESIRED_STATE, VISIBILITY } from './protocol.js';

function emptyTrackingFile() {
  return { version: 1, workhorses: {}, instances: {} };
}

export function readTracking() {
  if (!existsSync(config.TRACKING_FILE)) return emptyTrackingFile();
  try {
    return JSON.parse(readFileSync(config.TRACKING_FILE, 'utf-8'));
  } catch {
    return emptyTrackingFile();
  }
}

export function writeTracking(data) {
  const tmp = config.TRACKING_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    renameSync(tmp, config.TRACKING_FILE);
  } catch {
    try { unlinkSync(config.TRACKING_FILE); } catch {}
    renameSync(tmp, config.TRACKING_FILE);
  }
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
    heldBySubcontroller: false,
    watermark: { position: 0, timestamp: null },
    lastReportTime: null,
    lastReportContent: null,
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
